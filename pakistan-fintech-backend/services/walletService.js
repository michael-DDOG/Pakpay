// Updated walletService.js with full compliance
const pool = require('../config/database');
const TransactionMonitoringService = require('./transactionMonitoringService');
const TwoFactorAuthService = require('./twoFactorAuthService');
const AuditTrailService = require('./auditTrailService');
const NotificationService = require('./notificationService');

class CompliantWalletService {
  // Transfer with full compliance checks
  async transfer(senderId, recipientPhone, amount, description, ipAddress, twoFAToken = null) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Step 1: Check if 2FA is required
      const twoFARequired = await TwoFactorAuthService.isRequired(
        senderId, 
        amount, 
        'transfer'
      );
      
      if (twoFARequired.required && !twoFAToken) {
        await client.query('ROLLBACK');
        return {
          success: false,
          requiresTwoFA: true,
          reason: twoFARequired.reason,
          message: 'Two-factor authentication required for this transaction'
        };
      }
      
      // Verify 2FA token if provided
      if (twoFAToken) {
        const tokenValid = await TwoFactorAuthService.validate2FAToken(twoFAToken);
        if (!tokenValid.valid) {
          await client.query('ROLLBACK');
          
          // Log failed 2FA attempt
          await AuditTrailService.logSecurityEvent(
            'TWO_FA_FAILED',
            senderId,
            { amount, recipient: recipientPhone },
            'HIGH',
            ipAddress
          );
          
          return {
            success: false,
            error: 'Invalid or expired authentication token'
          };
        }
      }
      
      // Step 2: Get sender account
      const senderAccount = await client.query(
        'SELECT * FROM accounts WHERE user_id = $1',
        [senderId]
      );
      
      if (senderAccount.rows.length === 0) {
        throw new Error('Sender account not found');
      }
      
      const senderBalance = parseFloat(senderAccount.rows[0].balance);
      
      // Step 3: Check balance
      if (senderBalance < amount) {
        await client.query('ROLLBACK');
        return {
          success: false,
          error: 'Insufficient balance'
        };
      }
      
      // Step 4: Check transaction limits
      const limitsCheck = await this.checkTransactionLimits(senderId, amount);
      if (!limitsCheck.allowed) {
        await client.query('ROLLBACK');
        
        // Log limit violation
        await AuditTrailService.logSecurityEvent(
          'LIMIT_EXCEEDED',
          senderId,
          { 
            amount, 
            limit: limitsCheck.limit,
            limitType: limitsCheck.limitType 
          },
          'MEDIUM',
          ipAddress
        );
        
        return {
          success: false,
          error: limitsCheck.message
        };
      }
      
      // Step 5: Get recipient
      const recipientResult = await client.query(
        'SELECT id, name FROM users WHERE phone = $1',
        [recipientPhone]
      );
      
      if (recipientResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return {
          success: false,
          error: 'Recipient not found'
        };
      }
      
      const recipientId = recipientResult.rows[0].id;
      const recipientName = recipientResult.rows[0].name;
      
      // Step 6: Create transaction reference
      const transactionRef = `TXN${Date.now()}${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
      
      // Step 7: Pre-transaction monitoring
      const transactionData = {
        transactionRef,
        userId: senderId,
        accountId: senderAccount.rows[0].id,
        amount,
        type: 'transfer',
        recipient: recipientPhone,
        timestamp: new Date(),
        metadata: {
          type: 'transfer',
          receiver_phone: recipientPhone,
          receiver_name: recipientName,
          description
        }
      };
      
      const monitoringResult = await TransactionMonitoringService.monitorTransaction(transactionData);
      
      if (monitoringResult.blocked) {
        await client.query('ROLLBACK');
        
        // Log blocked transaction
        await AuditTrailService.logSecurityEvent(
          'TRANSACTION_BLOCKED',
          senderId,
          { 
            amount,
            recipient: recipientPhone,
            alerts: monitoringResult.alerts 
          },
          'CRITICAL',
          ipAddress
        );
        
        return {
          success: false,
          error: 'Transaction blocked for security review',
          reference: transactionRef
        };
      }
      
      // Step 8: Get recipient account
      const recipientAccount = await client.query(
        'SELECT * FROM accounts WHERE user_id = $1',
        [recipientId]
      );
      
      // Step 9: Create ledger entries
      const senderEntry = await client.query(
        `INSERT INTO ledger_entries 
         (account_id, entry_type, amount, balance_after, description, 
          transaction_ref, metadata, created_at)
         VALUES ($1, 'debit', $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
         RETURNING *`,
        [
          senderAccount.rows[0].id,
          amount,
          senderBalance - amount,
          description || `Transfer to ${recipientName}`,
          transactionRef,
          JSON.stringify({
            type: 'transfer',
            receiver_phone: recipientPhone,
            receiver_name: recipientName,
            receiver_id: recipientId
          })
        ]
      );
      
      const recipientBalance = parseFloat(recipientAccount.rows[0].balance);
      
      const recipientEntry = await client.query(
        `INSERT INTO ledger_entries 
         (account_id, entry_type, amount, balance_after, description, 
          transaction_ref, metadata, created_at)
         VALUES ($1, 'credit', $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
         RETURNING *`,
        [
          recipientAccount.rows[0].id,
          amount,
          recipientBalance + amount,
          description || `Received from ${senderAccount.rows[0].account_number}`,
          transactionRef,
          JSON.stringify({
            type: 'transfer',
            sender_phone: senderAccount.rows[0].phone,
            sender_id: senderId
          })
        ]
      );
      
      // Step 10: Update account balances
      await client.query(
        'UPDATE accounts SET balance = balance - $1 WHERE id = $2',
        [amount, senderAccount.rows[0].id]
      );
      
      await client.query(
        'UPDATE accounts SET balance = balance + $1 WHERE id = $2',
        [amount, recipientAccount.rows[0].id]
      );
      
      // Step 11: Commit transaction
      await client.query('COMMIT');
      
      // Step 12: Post-transaction activities
      
      // Log to audit trail
      await AuditTrailService.logTransaction(
        {
          transactionRef,
          amount,
          type: 'transfer',
          recipient: recipientPhone
        },
        senderId,
        ipAddress
      );
      
      // Send notifications
      await NotificationService.sendTransactionNotification(
        senderId,
        'debit',
        amount,
        recipientName
      );
      
      await NotificationService.sendTransactionNotification(
        recipientId,
        'credit',
        amount,
        senderAccount.rows[0].name
      );
      
      // Check if CTR is required (transactions > 2M PKR)
      if (amount >= 2000000) {
        await this.generateCTR(transactionRef, senderId, amount);
      }
      
      return {
        success: true,
        transactionRef,
        amount,
        recipientName,
        newBalance: senderBalance - amount,
        timestamp: new Date()
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Transfer error:', error);
      
      // Log error
      await AuditTrailService.logSecurityEvent(
        'TRANSACTION_ERROR',
        senderId,
        { 
          error: error.message,
          amount,
          recipient: recipientPhone 
        },
        'HIGH',
        ipAddress
      );
      
      throw error;
    } finally {
      client.release();
    }
  }

  // Check transaction limits based on KYC level
  async checkTransactionLimits(userId, amount) {
    const user = await pool.query(
      'SELECT kyc_level FROM users WHERE id = $1',
      [userId]
    );
    
    if (user.rows.length === 0) {
      return { allowed: false, message: 'User not found' };
    }
    
    const kycLevel = user.rows[0].kyc_level;
    
    // Get limits from database
    const limits = await pool.query(
      'SELECT * FROM kyc_limits WHERE kyc_level = $1',
      [kycLevel]
    );
    
    if (limits.rows.length === 0) {
      return { allowed: false, message: 'Limits not configured' };
    }
    
    const limit = limits.rows[0];
    
    // Check per transaction limit
    if (amount > parseFloat(limit.per_transaction_limit)) {
      return {
        allowed: false,
        limit: limit.per_transaction_limit,
        limitType: 'per_transaction',
        message: `Transaction exceeds limit of PKR ${limit.per_transaction_limit}`
      };
    }
    
    // Check daily limit
    const dailyTotal = await this.getDailyTransactionTotal(userId);
    if (dailyTotal + amount > parseFloat(limit.daily_limit)) {
      return {
        allowed: false,
        limit: limit.daily_limit,
        limitType: 'daily',
        message: `Transaction exceeds daily limit of PKR ${limit.daily_limit}`
      };
    }
    
    // Check monthly limit
    const monthlyTotal = await this.getMonthlyTransactionTotal(userId);
    if (monthlyTotal + amount > parseFloat(limit.monthly_limit)) {
      return {
        allowed: false,
        limit: limit.monthly_limit,
        limitType: 'monthly',
        message: `Transaction exceeds monthly limit of PKR ${limit.monthly_limit}`
      };
    }
    
    return { allowed: true };
  }

  // Get daily transaction total
  async getDailyTransactionTotal(userId) {
    const result = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) as total
       FROM ledger_entries le
       JOIN accounts a ON a.id = le.account_id
       WHERE a.user_id = $1
       AND le.entry_type = 'debit'
       AND DATE(le.created_at) = CURRENT_DATE`,
      [userId]
    );
    
    return parseFloat(result.rows[0].total);
  }

  // Get monthly transaction total
  async getMonthlyTransactionTotal(userId) {
    const result = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) as total
       FROM ledger_entries le
       JOIN accounts a ON a.id = le.account_id
       WHERE a.user_id = $1
       AND le.entry_type = 'debit'
       AND DATE_TRUNC('month', le.created_at) = DATE_TRUNC('month', CURRENT_DATE)`,
      [userId]
    );
    
    return parseFloat(result.rows[0].total);
  }

  // Generate CTR for large transactions
  async generateCTR(transactionRef, userId, amount) {
    const RegulatoryReportingService = require('./regulatoryReportingService');
    
    const user = await pool.query(
      'SELECT name, cnic, phone FROM users WHERE id = $1',
      [userId]
    );
    
    return await RegulatoryReportingService.generateCTR({
      transaction_ref: transactionRef,
      user_id: userId,
      amount,
      name: user.rows[0].name,
      cnic: user.rows[0].cnic,
      phone: user.rows[0].phone,
      created_at: new Date()
    });
  }
}

module.exports = new CompliantWalletService();
