// services/beneficiaryService.js
const pool = require('../config/database');
const { v4: uuidv4 } = require('uuid');

class BeneficiaryService {
  // Add beneficiary
  static async addBeneficiary(userId, beneficiaryData) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      const { phone, nickname, category } = beneficiaryData;
      
      // Check if beneficiary exists (user)
      const userQuery = 'SELECT id, name, phone FROM users WHERE phone = $1';
      const userResult = await client.query(userQuery, [phone]);
      
      if (userResult.rows.length === 0) {
        throw new Error('User not found with this phone number');
      }
      
      const beneficiary = userResult.rows[0];
      
      // Check if already saved
      const checkQuery = `
        SELECT id FROM saved_beneficiaries 
        WHERE user_id = $1 AND beneficiary_id = $2
      `;
      const checkResult = await client.query(checkQuery, [userId, beneficiary.id]);
      
      if (checkResult.rows.length > 0) {
        throw new Error('Beneficiary already saved');
      }
      
      // Generate beneficiary ID
      const beneficiaryId = `BEN${Date.now()}${uuidv4().substring(0, 8).toUpperCase()}`;
      
      // Save beneficiary
      const insertQuery = `
        INSERT INTO saved_beneficiaries (
          beneficiary_ref, user_id, beneficiary_id, 
          beneficiary_phone, beneficiary_name, nickname, 
          category, is_favorite, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, false, CURRENT_TIMESTAMP)
        RETURNING *
      `;
      
      const result = await client.query(insertQuery, [
        beneficiaryId,
        userId,
        beneficiary.id,
        beneficiary.phone,
        beneficiary.name,
        nickname || beneficiary.name,
        category || 'personal'
      ]);
      
      await client.query('COMMIT');
      
      return {
        success: true,
        beneficiary: result.rows[0]
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Get user's beneficiaries
  static async getUserBeneficiaries(userId) {
    try {
      const query = `
        SELECT 
          sb.*,
          u.name as current_name,
          u.phone as current_phone,
          (
            SELECT COUNT(*) 
            FROM ledger_entries le
            JOIN accounts a ON a.id = le.account_id
            WHERE a.user_id = $1
              AND le.metadata->>'receiver_phone' = sb.beneficiary_phone
              AND le.entry_type = 'debit'
          ) as transaction_count,
          (
            SELECT MAX(le.created_at)
            FROM ledger_entries le
            JOIN accounts a ON a.id = le.account_id
            WHERE a.user_id = $1
              AND le.metadata->>'receiver_phone' = sb.beneficiary_phone
              AND le.entry_type = 'debit'
          ) as last_transaction
        FROM saved_beneficiaries sb
        LEFT JOIN users u ON u.id = sb.beneficiary_id
        WHERE sb.user_id = $1 AND sb.is_active = true
        ORDER BY sb.is_favorite DESC, sb.created_at DESC
      `;
      
      const result = await pool.query(query, [userId]);
      return result.rows;
      
    } catch (error) {
      console.error('Get beneficiaries error:', error);
      throw error;
    }
  }

  // Toggle favorite
  static async toggleFavorite(userId, beneficiaryRef) {
    try {
      const query = `
        UPDATE saved_beneficiaries 
        SET is_favorite = NOT is_favorite
        WHERE user_id = $1 AND beneficiary_ref = $2
        RETURNING *
      `;
      
      const result = await pool.query(query, [userId, beneficiaryRef]);
      
      if (result.rows.length === 0) {
        throw new Error('Beneficiary not found');
      }
      
      return {
        success: true,
        isFavorite: result.rows[0].is_favorite
      };
      
    } catch (error) {
      console.error('Toggle favorite error:', error);
      throw error;
    }
  }

  // Update beneficiary
  static async updateBeneficiary(userId, beneficiaryRef, updates) {
    try {
      const { nickname, category } = updates;
      
      const query = `
        UPDATE saved_beneficiaries 
        SET nickname = COALESCE($1, nickname),
            category = COALESCE($2, category),
            updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $3 AND beneficiary_ref = $4
        RETURNING *
      `;
      
      const result = await pool.query(query, [
        nickname,
        category,
        userId,
        beneficiaryRef
      ]);
      
      if (result.rows.length === 0) {
        throw new Error('Beneficiary not found');
      }
      
      return {
        success: true,
        beneficiary: result.rows[0]
      };
      
    } catch (error) {
      console.error('Update beneficiary error:', error);
      throw error;
    }
  }

  // Delete beneficiary
  static async deleteBeneficiary(userId, beneficiaryRef) {
    try {
      // Soft delete
      const query = `
        UPDATE saved_beneficiaries 
        SET is_active = false,
            deleted_at = CURRENT_TIMESTAMP
        WHERE user_id = $1 AND beneficiary_ref = $2
        RETURNING *
      `;
      
      const result = await pool.query(query, [userId, beneficiaryRef]);
      
      if (result.rows.length === 0) {
        throw new Error('Beneficiary not found');
      }
      
      return {
        success: true,
        message: 'Beneficiary removed successfully'
      };
      
    } catch (error) {
      console.error('Delete beneficiary error:', error);
      throw error;
    }
  }

  // Get recent recipients (not yet saved)
  static async getRecentRecipients(userId, limit = 10) {
    try {
      const query = `
        SELECT DISTINCT ON (receiver_phone)
          le.metadata->>'receiver_phone' as phone,
          le.metadata->>'receiver_name' as name,
          MAX(le.created_at) as last_transaction,
          COUNT(*) as transaction_count
        FROM ledger_entries le
        JOIN accounts a ON a.id = le.account_id
        WHERE a.user_id = $1
          AND le.entry_type = 'debit'
          AND le.metadata->>'receiver_phone' IS NOT NULL
          AND le.metadata->>'receiver_phone' NOT IN (
            SELECT beneficiary_phone 
            FROM saved_beneficiaries 
            WHERE user_id = $1 AND is_active = true
          )
        GROUP BY le.metadata->>'receiver_phone', le.metadata->>'receiver_name'
        ORDER BY receiver_phone, MAX(le.created_at) DESC
        LIMIT $2
      `;
      
      const result = await pool.query(query, [userId, limit]);
      return result.rows;
      
    } catch (error) {
      console.error('Get recent recipients error:', error);
      throw error;
    }
  }

  // Quick send to beneficiary
  static async quickSend(userId, beneficiaryRef, amount) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Get beneficiary details
      const benQuery = `
        SELECT * FROM saved_beneficiaries 
        WHERE user_id = $1 AND beneficiary_ref = $2 AND is_active = true
      `;
      const benResult = await client.query(benQuery, [userId, beneficiaryRef]);
      
      if (benResult.rows.length === 0) {
        throw new Error('Beneficiary not found');
      }
      
      const beneficiary = benResult.rows[0];
      
      // This would integrate with your existing transfer service
      // For now, just return the beneficiary details for transfer
      
      await client.query('COMMIT');
      
      return {
        success: true,
        beneficiary: {
          phone: beneficiary.beneficiary_phone,
          name: beneficiary.nickname || beneficiary.beneficiary_name,
          id: beneficiary.beneficiary_id
        },
        amount
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = BeneficiaryService;
