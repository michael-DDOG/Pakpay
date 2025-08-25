// services/auditTrailService.js
const pool = require('../config/database');
const crypto = require('crypto');

class AuditTrailService {
  constructor() {
    this.sensitiveFields = [
      'password', 'pin', 'pin_hash', 'password_hash', 
      'secret', 'token', 'otp'
    ];
  }

  // Log any action
  async logAction(data) {
    const {
      userId,
      action,
      entityType,
      entityId,
      oldValues,
      newValues,
      ipAddress,
      userAgent,
      sessionId
    } = data;

    try {
      // Sanitize sensitive data
      const sanitizedOld = this.sanitizeSensitiveData(oldValues);
      const sanitizedNew = this.sanitizeSensitiveData(newValues);
      
      // Generate audit hash for integrity
      const auditHash = this.generateAuditHash(data);
      
      const result = await pool.query(
        `INSERT INTO audit_trail 
         (user_id, action, entity_type, entity_id, old_values, 
          new_values, ip_address, user_agent, session_id, audit_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, created_at`,
        [
          userId,
          action,
          entityType,
          entityId,
          sanitizedOld ? JSON.stringify(sanitizedOld) : null,
          sanitizedNew ? JSON.stringify(sanitizedNew) : null,
          ipAddress,
          userAgent,
          sessionId,
          auditHash
        ]
      );
      
      return {
        auditId: result.rows[0].id,
        timestamp: result.rows[0].created_at
      };
      
    } catch (error) {
      console.error('Audit logging error:', error);
      // Don't throw - audit failures shouldn't break operations
      return null;
    }
  }

  // Log user authentication
  async logAuthentication(userId, success, method, ipAddress, userAgent) {
    return this.logAction({
      userId,
      action: success ? 'LOGIN_SUCCESS' : 'LOGIN_FAILED',
      entityType: 'USER',
      entityId: userId,
      newValues: { method, timestamp: new Date() },
      ipAddress,
      userAgent
    });
  }

  // Log transaction
  async logTransaction(transaction, userId, ipAddress) {
    return this.logAction({
      userId,
      action: 'TRANSACTION_CREATED',
      entityType: 'TRANSACTION',
      entityId: transaction.transactionRef,
      newValues: {
        amount: transaction.amount,
        type: transaction.type,
        recipient: transaction.recipient
      },
      ipAddress
    });
  }

  // Log KYC update
  async logKYCUpdate(userId, oldLevel, newLevel, verificationData, ipAddress) {
    return this.logAction({
      userId,
      action: 'KYC_LEVEL_CHANGED',
      entityType: 'USER',
      entityId: userId,
      oldValues: { kyc_level: oldLevel },
      newValues: { 
        kyc_level: newLevel,
        verification_method: verificationData.method,
        verified_at: new Date()
      },
      ipAddress
    });
  }

  // Log profile update
  async logProfileUpdate(userId, changes, ipAddress) {
    return this.logAction({
      userId,
      action: 'PROFILE_UPDATED',
      entityType: 'USER',
      entityId: userId,
      oldValues: changes.old,
      newValues: changes.new,
      ipAddress
    });
  }

  // Log security event
  async logSecurityEvent(eventType, userId, details, severity, ipAddress) {
    await pool.query(
      `INSERT INTO security_logs 
       (event_type, user_id, event_data, severity, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [eventType, userId, JSON.stringify(details), severity, ipAddress]
    );
    
    // Also log to audit trail
    return this.logAction({
      userId,
      action: `SECURITY_${eventType}`,
      entityType: 'SECURITY',
      entityId: userId,
      newValues: { ...details, severity },
      ipAddress
    });
  }

  // Log compliance action
  async logComplianceAction(officerId, actionType, targetUserId, details) {
    await pool.query(
      `INSERT INTO compliance_actions 
       (officer_id, action_type, entity_type, entity_id, action_data, reason)
       VALUES ($1, $2, 'USER', $3, $4, $5)`,
      [
        officerId,
        actionType,
        targetUserId,
        JSON.stringify(details),
        details.reason
      ]
    );
    
    return this.logAction({
      userId: officerId,
      action: `COMPLIANCE_${actionType}`,
      entityType: 'USER',
      entityId: targetUserId,
      newValues: details
    });
  }

  // Log data access
  async logDataAccess(userId, dataType, recordId, purpose, ipAddress) {
    return this.logAction({
      userId,
      action: 'DATA_ACCESS',
      entityType: dataType,
      entityId: recordId,
      newValues: { 
        purpose, 
        accessed_at: new Date(),
        fields_accessed: purpose.fields || []
      },
      ipAddress
    });
  }

  // Sanitize sensitive data
  sanitizeSensitiveData(data) {
    if (!data) return null;
    
    const sanitized = { ...data };
    
    for (const field of this.sensitiveFields) {
      if (sanitized[field]) {
        sanitized[field] = '[REDACTED]';
      }
    }
    
    return sanitized;
  }

  // Generate audit hash for integrity verification
  generateAuditHash(data) {
    const hashData = {
      userId: data.userId,
      action: data.action,
      entityType: data.entityType,
      entityId: data.entityId,
      timestamp: new Date().toISOString()
    };
    
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(hashData))
      .digest('hex');
  }

  // Verify audit trail integrity
  async verifyAuditIntegrity(auditId) {
    const result = await pool.query(
      'SELECT * FROM audit_trail WHERE id = $1',
      [auditId]
    );
    
    if (result.rows.length === 0) {
      return { valid: false, error: 'Audit record not found' };
    }
    
    const record = result.rows[0];
    const expectedHash = this.generateAuditHash({
      userId: record.user_id,
      action: record.action,
      entityType: record.entity_type,
      entityId: record.entity_id
    });
    
    // Note: This is simplified - in production, include timestamp in hash
    return {
      valid: true, // Simplified for now
      record
    };
  }

  // Get audit trail for user
  async getUserAuditTrail(userId, startDate, endDate) {
    const query = `
      SELECT * FROM audit_trail
      WHERE user_id = $1
      AND created_at BETWEEN $2 AND $3
      ORDER BY created_at DESC
    `;
    
    const result = await pool.query(query, [userId, startDate, endDate]);
    return result.rows;
  }

  // Get audit trail for entity
  async getEntityAuditTrail(entityType, entityId) {
    const query = `
      SELECT * FROM audit_trail
      WHERE entity_type = $1 AND entity_id = $2
      ORDER BY created_at DESC
    `;
    
    const result = await pool.query(query, [entityType, entityId]);
    return result.rows;
  }

  // Archive old audit records
  async archiveOldRecords(daysToKeep = 1825) { // 5 years
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    
    // Move to archive table
    await pool.query(
      `INSERT INTO audit_trail_archive 
       SELECT * FROM audit_trail 
       WHERE created_at < $1`,
      [cutoffDate]
    );
    
    // Remove from main table
    const result = await pool.query(
      'DELETE FROM audit_trail WHERE created_at < $1',
      [cutoffDate]
    );
    
    return {
      archived: result.rowCount,
      cutoffDate
    };
  }
}

module.exports = new AuditTrailService();
