// services/kycLimitsService.js
const pool = require('../config/database');

class KYCLimitsService {
  // KYC limit configurations
  static KYC_LIMITS = {
    0: {
      daily: 0,
      monthly: 0,
      perTransaction: 0,
      name: 'Unverified'
    },
    1: {
      daily: 25000,
      monthly: 200000,
      perTransaction: 10000,
      name: 'Basic (Asaan Level 0)'
    },
    2: {
      daily: 100000,
      monthly: 1000000,
      perTransaction: 50000,
      name: 'Enhanced (Asaan Level 1)'
    },
    3: {
      daily: 500000,
      monthly: 5000000,
      perTransaction: 200000,
      name: 'Full KYC'
    }
  };

  // Check if transaction is within limits
  static async checkTransactionLimits(userId, amount, transactionType = 'transfer') {
    const client = await pool.connect();
    try {
      // Get user's current limits and usage
      const limitsQuery = `
        SELECT 
          ul.*,
          u.kyc_level,
          u.name,
          u.phone
        FROM user_limits ul
        JOIN users u ON u.id = ul.user_id
        WHERE ul.user_id = $1
      `;
      
      const limitsResult = await client.query(limitsQuery, [userId]);
      
      if (limitsResult.rows.length === 0) {
        // Initialize limits if not exists
        await this.initializeUserLimits(userId);
        const newLimits = await client.query(limitsQuery, [userId]);
        limitsResult.rows = newLimits.rows;
      }
      
      const userLimits = limitsResult.rows[0];
      
      // Reset daily limit if needed
      const now = new Date();
      const dailyReset = new Date(userLimits.daily_reset_at);
      if (now.getDate() !== dailyReset.getDate()) {
        await client.query(
          'UPDATE user_limits SET daily_spent = 0, daily_reset_at = CURRENT_TIMESTAMP WHERE user_id = $1',
          [userId]
        );
        userLimits.daily_spent = 0;
      }
      
      // Reset monthly limit if needed
      const monthlyReset = new Date(userLimits.monthly_reset_at);
      if (now.getMonth() !== monthlyReset.getMonth() || now.getFullYear() !== monthlyReset.getFullYear()) {
        await client.query(
          'UPDATE user_limits SET monthly_spent = 0, monthly_reset_at = CURRENT_TIMESTAMP WHERE user_id = $1',
          [userId]
        );
        userLimits.monthly_spent = 0;
      }
      
      // Check KYC Level 0
      if (userLimits.kyc_level === 0) {
        return {
          allowed: false,
          reason: 'KYC verification required. Please complete your KYC to start transacting.',
          limits: this.formatLimitsResponse(userLimits)
        };
      }
      
      // Check per transaction limit
      if (parseFloat(amount) > parseFloat(userLimits.per_transaction_limit)) {
        return {
          allowed: false,
          reason: `Transaction amount exceeds your per-transaction limit of PKR ${this.formatAmount(userLimits.per_transaction_limit)}`,
          limits: this.formatLimitsResponse(userLimits)
        };
      }
      
      // Check daily limit
      const newDailyTotal = parseFloat(userLimits.daily_spent) + parseFloat(amount);
      if (newDailyTotal > parseFloat(userLimits.daily_limit)) {
        const remainingDaily = parseFloat(userLimits.daily_limit) - parseFloat(userLimits.daily_spent);
        return {
          allowed: false,
          reason: `Transaction would exceed your daily limit. Remaining today: PKR ${this.formatAmount(remainingDaily)}`,
          limits: this.formatLimitsResponse(userLimits)
        };
      }
      
      // Check monthly limit
      const newMonthlyTotal = parseFloat(userLimits.monthly_spent) + parseFloat(amount);
      if (newMonthlyTotal > parseFloat(userLimits.monthly_limit)) {
        const remainingMonthly = parseFloat(userLimits.monthly_limit) - parseFloat(userLimits.monthly_spent);
        return {
          allowed: false,
          reason: `Transaction would exceed your monthly limit. Remaining this month: PKR ${this.formatAmount(remainingMonthly)}`,
          limits: this.formatLimitsResponse(userLimits)
        };
      }
      
      // All checks passed
      return {
        allowed: true,
        limits: this.formatLimitsResponse(userLimits),
        newDailyTotal,
        newMonthlyTotal
      };
      
    } finally {
      client.release();
    }
  }

  // Update spent amounts after successful transaction
  static async updateSpentAmounts(userId, amount, transactionRef, transactionType) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Update spent amounts
      await client.query(
        `UPDATE user_limits 
         SET daily_spent = daily_spent + $1,
             monthly_spent = monthly_spent + $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $2`,
        [amount, userId]
      );
      
      // Record transaction for limits tracking
      await client.query(
        `INSERT INTO limit_transactions (user_id, transaction_ref, amount, transaction_type, transaction_date)
         VALUES ($1, $2, $3, $4, CURRENT_DATE)`,
        [userId, transactionRef, amount, transactionType]
      );
      
      await client.query('COMMIT');
      return true;
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Get user's current limits and usage
  static async getUserLimits(userId) {
    const client = await pool.connect();
    try {
      const query = `
        SELECT 
          ul.*,
          u.kyc_level,
          u.name,
          u.phone,
          (ul.daily_limit - ul.daily_spent) as daily_remaining,
          (ul.monthly_limit - ul.monthly_spent) as monthly_remaining
        FROM user_limits ul
        JOIN users u ON u.id = ul.user_id
        WHERE ul.user_id = $1
      `;
      
      const result = await client.query(query, [userId]);
      
      if (result.rows.length === 0) {
        await this.initializeUserLimits(userId);
        const newResult = await client.query(query, [userId]);
        return this.formatLimitsResponse(newResult.rows[0]);
      }
      
      return this.formatLimitsResponse(result.rows[0]);
      
    } finally {
      client.release();
    }
  }

  // Initialize limits for a user
  static async initializeUserLimits(userId) {
    const client = await pool.connect();
    try {
      await client.query('SELECT initialize_user_limits($1)', [userId]);
      return true;
    } finally {
      client.release();
    }
  }

  // Upgrade user's KYC level
  static async upgradeKYCLevel(userId, newLevel) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Update user's KYC level
      await client.query(
        'UPDATE users SET kyc_level = $1 WHERE id = $2',
        [newLevel, userId]
      );
      
      // Update limits
      const limits = this.KYC_LIMITS[newLevel];
      await client.query(
        `UPDATE user_limits 
         SET kyc_level = $1,
             daily_limit = $2,
             monthly_limit = $3,
             per_transaction_limit = $4,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $5`,
        [newLevel, limits.daily, limits.monthly, limits.perTransaction, userId]
      );
      
      await client.query('COMMIT');
      return true;
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Helper: Format amount
  static formatAmount(amount) {
    return parseFloat(amount).toLocaleString('en-PK');
  }

  // Helper: Format limits response
  static formatLimitsResponse(limits) {
    return {
      kycLevel: limits.kyc_level,
      kycName: this.KYC_LIMITS[limits.kyc_level].name,
      limits: {
        daily: parseFloat(limits.daily_limit),
        monthly: parseFloat(limits.monthly_limit),
        perTransaction: parseFloat(limits.per_transaction_limit)
      },
      spent: {
        daily: parseFloat(limits.daily_spent || 0),
        monthly: parseFloat(limits.monthly_spent || 0)
      },
      remaining: {
        daily: parseFloat(limits.daily_limit) - parseFloat(limits.daily_spent || 0),
        monthly: parseFloat(limits.monthly_limit) - parseFloat(limits.monthly_spent || 0)
      },
      resetTimes: {
        daily: limits.daily_reset_at,
        monthly: limits.monthly_reset_at
      }
    };
  }
}

module.exports = KYCLimitsService;
