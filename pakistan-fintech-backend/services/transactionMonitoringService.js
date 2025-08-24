// services/transactionMonitoringService.js
const pool = require('../config/database');
const NotificationService = require('./notificationService');

class TransactionMonitoringService {
  constructor() {
    this.rules = this.loadMonitoringRules();
    this.patterns = this.loadSuspiciousPatterns();
  }

  // Load monitoring rules as per SBP guidelines
  loadMonitoringRules() {
    return {
      // Large transaction thresholds
      largeTransaction: {
        personal: 500000,     // 5 lakh PKR
        business: 2000000,    // 20 lakh PKR
        ctr_threshold: 2000000 // CTR required above this
      },
      
      // Velocity rules (transactions per time period)
      velocity: {
        hourly: { count: 10, amount: 200000 },
        daily: { count: 50, amount: 1000000 },
        weekly: { count: 200, amount: 5000000 }
      },
      
      // Structuring detection
      structuring: {
        threshold: 490000, // Just below 5 lakh
        timeWindow: 86400000, // 24 hours in ms
        minTransactions: 3
      },
      
      // Dormant account reactivation
      dormancy: {
        inactivePeriod: 90, // days
        suspiciousAmount: 100000
      }
    };
  }

  // Load suspicious patterns
  loadSuspiciousPatterns() {
    return [
      {
        name: 'RAPID_MOVEMENT',
        description: 'Funds moved rapidly through account',
        condition: 'deposit_withdrawal_same_day'
      },
      {
        name: 'ROUND_AMOUNTS',
        description: 'Multiple round amount transactions',
        condition: 'round_amounts_pattern'
      },
      {
        name: 'MIDNIGHT_TRANSACTIONS',
        description: 'Unusual late night activity',
        condition: 'transactions_between_midnight_and_4am'
      },
      {
        name: 'CROSS_BORDER_SPIKE',
        description: 'Sudden increase in cross-border transactions',
        condition: 'international_transaction_spike'
      }
    ];
  }

  // Main monitoring function
  async monitorTransaction(transaction) {
    const alerts = [];
    const userId = transaction.userId;
    
    try {
      // Get customer risk profile
      const riskProfile = await this.getCustomerRiskProfile(userId);
      
      // 1. Check transaction amount
      const amountAlert = await this.checkTransactionAmount(transaction, riskProfile);
      if (amountAlert) alerts.push(amountAlert);
      
      // 2. Check velocity
      const velocityAlert = await this.checkVelocity(userId, transaction);
      if (velocityAlert) alerts.push(velocityAlert);
      
      // 3. Check for structuring (smurfing)
      const structuringAlert = await this.detectStructuring(userId, transaction);
      if (structuringAlert) alerts.push(structuringAlert);
      
      // 4. Check suspicious patterns
      const patternAlerts = await this.detectSuspiciousPatterns(userId, transaction);
      alerts.push(...patternAlerts);
      
      // 5. Check dormant account reactivation
      const dormancyAlert = await this.checkDormantAccount(userId, transaction);
      if (dormancyAlert) alerts.push(dormancyAlert);
      
      // 6. Check sanctions hit
      const sanctionsAlert = await this.checkSanctionsRealTime(transaction);
      if (sanctionsAlert) alerts.push(sanctionsAlert);
      
      // 7. Check geographic risk
      const geoAlert = await this.checkGeographicRisk(transaction);
      if (geoAlert) alerts.push(geoAlert);
      
      // 8. Check PEP transactions
      const pepAlert = await this.checkPEPTransaction(userId, transaction);
      if (pepAlert) alerts.push(pepAlert);
      
      // Process alerts
      if (alerts.length > 0) {
        await this.processAlerts(transaction, alerts);
        
        // Determine if transaction should be blocked
        const shouldBlock = this.shouldBlockTransaction(alerts);
        if (shouldBlock) {
          await this.blockTransaction(transaction, alerts);
          return { blocked: true, alerts };
        }
      }
      
      // Save monitoring result
      await this.saveMonitoringResult(transaction, alerts);
      
      return { blocked: false, alerts };
      
    } catch (error) {
      console.error('Transaction monitoring error:', error);
      // Don't block transaction on monitoring error, but log it
      await this.logMonitoringError(transaction, error);
      return { blocked: false, alerts: [], error: true };
    }
  }

  // Check transaction amount against thresholds
  async checkTransactionAmount(transaction, riskProfile) {
    const amount = parseFloat(transaction.amount);
    const threshold = riskProfile.type === 'business' 
      ? this.rules.largeTransaction.business 
      : this.rules.largeTransaction.personal;
    
    if (amount >= this.rules.largeTransaction.ctr_threshold) {
      // Generate CTR (Currency Transaction Report)
      await this.generateCTR(transaction);
      
      return {
        type: 'CTR_REQUIRED',
        severity: 'HIGH',
        description: `Transaction exceeds CTR threshold (${this.rules.largeTransaction.ctr_threshold} PKR)`,
        amount: amount
      };
    }
    
    if (amount >= threshold) {
      return {
        type: 'LARGE_TRANSACTION',
        severity: 'MEDIUM',
        description: `Large transaction for ${riskProfile.type} account`,
        amount: amount,
        threshold: threshold
      };
    }
    
    return null;
  }

  // Check velocity (frequency) of transactions
  async checkVelocity(userId, transaction) {
    const now = new Date();
    const alerts = [];
    
    // Check hourly velocity
    const hourlyStats = await pool.query(
      `SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total
       FROM ledger_entries le
       JOIN accounts a ON a.id = le.account_id
       WHERE a.user_id = $1
       AND le.created_at >= $2`,
      [userId, new Date(now - 3600000)] // Last hour
    );
    
    if (hourlyStats.rows[0].count > this.rules.velocity.hourly.count ||
        hourlyStats.rows[0].total > this.rules.velocity.hourly.amount) {
      return {
        type: 'VELOCITY_HOURLY',
        severity: 'HIGH',
        description: 'Unusual transaction velocity in last hour',
        count: hourlyStats.rows[0].count,
        total: hourlyStats.rows[0].total
      };
    }
    
    // Check daily velocity
    const dailyStats = await pool.query(
      `SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total
       FROM ledger_entries le
       JOIN accounts a ON a.id = le.account_id
       WHERE a.user_id = $1
       AND le.created_at >= $2`,
      [userId, new Date(now - 86400000)] // Last 24 hours
    );
    
    if (dailyStats.rows[0].count > this.rules.velocity.daily.count ||
        dailyStats.rows[0].total > this.rules.velocity.daily.amount) {
      return {
        type: 'VELOCITY_DAILY',
        severity: 'MEDIUM',
        description: 'High transaction velocity in last 24 hours',
        count: dailyStats.rows[0].count,
        total: dailyStats.rows[0].total
      };
    }
    
    return null;
  }

  // Detect structuring (smurfing) attempts
  async detectStructuring(userId, transaction) {
    const amount = parseFloat(transaction.amount);
    
    // Check if amount is suspiciously close to threshold
    if (amount >= this.rules.structuring.threshold && 
        amount < this.rules.largeTransaction.personal) {
      
      // Check for multiple similar transactions
      const similarTxns = await pool.query(
        `SELECT COUNT(*) as count
         FROM ledger_entries le
         JOIN accounts a ON a.id = le.account_id
         WHERE a.user_id = $1
         AND le.amount BETWEEN $2 AND $3
         AND le.created_at >= $4`,
        [
          userId,
          this.rules.structuring.threshold,
          this.rules.largeTransaction.personal,
          new Date(Date.now() - this.rules.structuring.timeWindow)
        ]
      );
      
      if (similarTxns.rows[0].count >= this.rules.structuring.minTransactions) {
        return {
          type: 'STRUCTURING',
          severity: 'CRITICAL',
          description: 'Possible structuring detected - multiple transactions just below reporting threshold',
          transactionCount: similarTxns.rows[0].count
        };
      }
    }
    
    return null;
  }

  // Detect suspicious patterns
  async detectSuspiciousPatterns(userId, transaction) {
    const alerts = [];
    
    // Pattern 1: Rapid fund movement
    const rapidMovement = await pool.query(
      `SELECT 
        (SELECT COUNT(*) FROM ledger_entries WHERE entry_type = 'credit' 
         AND account_id = $1 AND DATE(created_at) = CURRENT_DATE) as deposits,
        (SELECT COUNT(*) FROM ledger_entries WHERE entry_type = 'debit' 
         AND account_id = $1 AND DATE(created_at) = CURRENT_DATE) as withdrawals`,
      [transaction.accountId]
    );
    
    if (rapidMovement.rows[0].deposits > 0 && rapidMovement.rows[0].withdrawals > 0) {
      const totalIn = rapidMovement.rows[0].deposits;
      const totalOut = rapidMovement.rows[0].withdrawals;
      
      if (totalIn > 2 && totalOut > 2) {
        alerts.push({
          type: 'RAPID_MOVEMENT',
          severity: 'HIGH',
          description: 'Rapid movement of funds through account',
          deposits: totalIn,
          withdrawals: totalOut
        });
      }
    }
    
    // Pattern 2: Round amounts
    if (transaction.amount % 10000 === 0 && transaction.amount >= 50000) {
      const roundAmountTxns = await pool.query(
        `SELECT COUNT(*) as count
         FROM ledger_entries le
         JOIN accounts a ON a.id = le.account_id
         WHERE a.user_id = $1
         AND MOD(le.amount::numeric, 10000) = 0
         AND le.amount >= 50000
         AND le.created_at >= CURRENT_DATE - INTERVAL '7 days'`,
        [userId]
      );
      
      if (roundAmountTxns.rows[0].count >= 3) {
        alerts.push({
          type: 'ROUND_AMOUNTS',
          severity: 'MEDIUM',
          description: 'Multiple round amount transactions detected',
          count: roundAmountTxns.rows[0].count
        });
      }
    }
    
    // Pattern 3: Unusual time transactions
    const hour = new Date(transaction.timestamp).getHours();
    if (hour >= 0 && hour <= 4) {
      alerts.push({
        type: 'UNUSUAL_TIME',
        severity: 'LOW',
        description: 'Transaction at unusual hour',
        hour: hour
      });
    }
    
    return alerts;
  }

  // Check dormant account reactivation
  async checkDormantAccount(userId, transaction) {
    const lastActivity = await pool.query(
      `SELECT MAX(created_at) as last_transaction
       FROM ledger_entries le
       JOIN accounts a ON a.id = le.account_id
       WHERE a.user_id = $1
       AND le.created_at < $2`,
      [userId, transaction.timestamp]
    );
    
    if (lastActivity.rows[0].last_transaction) {
      const daysSinceLastActivity = Math.floor(
        (new Date(transaction.timestamp) - new Date(lastActivity.rows[0].last_transaction)) 
        / (1000 * 60 * 60 * 24)
      );
      
      if (daysSinceLastActivity >= this.rules.dormancy.inactivePeriod &&
          parseFloat(transaction.amount) >= this.rules.dormancy.suspiciousAmount) {
        return {
          type: 'DORMANT_REACTIVATION',
          severity: 'HIGH',
          description: 'Large transaction on previously dormant account',
          daysInactive: daysSinceLastActivity,
          amount: transaction.amount
        };
      }
    }
    
    return null;
  }

  // Real-time sanctions check
  async checkSanctionsRealTime(transaction) {
    if (transaction.metadata?.receiver_name) {
      const sanctionsCheck = await pool.query(
        `SELECT * FROM sanctions_lists 
         WHERE LOWER(name) LIKE LOWER($1)
         LIMIT 1`,
        [`%${transaction.metadata.receiver_name}%`]
      );
      
      if (sanctionsCheck.rows.length > 0) {
        return {
          type: 'SANCTIONS_HIT',
          severity: 'CRITICAL',
          description: 'Transaction involves sanctioned entity',
          entity: sanctionsCheck.rows[0].name,
          list: sanctionsCheck.rows[0].list_type
        };
      }
    }
    
    return null;
  }

  // Check geographic risk
  async checkGeographicRisk(transaction) {
    const highRiskCountries = [
      'Iran', 'North Korea', 'Syria', 'Afghanistan',
      'Yemen', 'Somalia', 'Libya', 'Myanmar'
    ];
    
    if (transaction.metadata?.country) {
      if (highRiskCountries.includes(transaction.metadata.country)) {
        return {
          type: 'HIGH_RISK_GEOGRAPHY',
          severity: 'HIGH',
          description: 'Transaction involves high-risk jurisdiction',
          country: transaction.metadata.country
        };
      }
    }
    
    return null;
  }

  // Check PEP transactions
  async checkPEPTransaction(userId, transaction) {
    const pepCheck = await pool.query(
      `SELECT * FROM customer_risk_profiles
       WHERE user_id = $1 AND pep_status = true`,
      [userId]
    );
    
    if (pepCheck.rows.length > 0 && parseFloat(transaction.amount) >= 100000) {
      return {
        type: 'PEP_TRANSACTION',
        severity: 'MEDIUM',
        description: 'Large transaction by PEP',
        amount: transaction.amount
      };
    }
    
    return null;
  }

  // Get customer risk profile
  async getCustomerRiskProfile(userId) {
    const profile = await pool.query(
      `SELECT * FROM customer_risk_profiles WHERE user_id = $1`,
      [userId]
    );
    
    if (profile.rows.length === 0) {
      // Create default profile
      return { type: 'personal', riskLevel: 'LOW' };
    }
    
    return profile.rows[0];
  }

  // Process alerts
  async processAlerts(transaction, alerts) {
    const criticalAlerts = alerts.filter(a => a.severity === 'CRITICAL');
    const highAlerts = alerts.filter(a => a.severity === 'HIGH');
    
    // Generate STR if critical alerts
    if (criticalAlerts.length > 0) {
      await this.generateSTR(transaction, alerts);
    }
    
    // Notify compliance team for high severity
    if (highAlerts.length > 0) {
      await this.notifyComplianceTeam(transaction, alerts);
    }
    
    // Save all alerts
    for (const alert of alerts) {
      await this.saveAlert(transaction, alert);
    }
  }

  // Generate Suspicious Transaction Report (STR)
  async generateSTR(transaction, alerts) {
    const strId = `STR${Date.now()}`;
    
    const strData = {
      strId,
      transactionRef: transaction.transactionRef,
      userId: transaction.userId,
      amount: transaction.amount,
      alerts,
      generatedAt: new Date(),
      status: 'PENDING_REVIEW'
    };
    
    await pool.query(
      `INSERT INTO suspicious_transaction_reports (
        report_id, transaction_ref, user_id, amount,
        report_data, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)`,
      [
        strId,
        transaction.transactionRef,
        transaction.userId,
        transaction.amount,
        JSON.stringify(strData),
        'PENDING_REVIEW'
      ]
    );
    
    // Notify compliance officer immediately
    await NotificationService.sendNotification(
      process.env.COMPLIANCE_OFFICER_ID,
      'Critical Alert: STR Generated',
      `STR ${strId} requires immediate review`,
      { type: 'STR', strId }
    );
    
    return strId;
  }

  // Generate Currency Transaction Report (CTR)
  async generateCTR(transaction) {
    const ctrId = `CTR${Date.now()}`;
    
    await pool.query(
      `INSERT INTO currency_transaction_reports (
        report_id, transaction_ref, user_id, amount,
        report_data, created_at
      ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
      [
        ctrId,
        transaction.transactionRef,
        transaction.userId,
        transaction.amount,
        JSON.stringify({
          ctrId,
          transaction,
          generatedAt: new Date(),
          threshold: this.rules.largeTransaction.ctr_threshold
        })
      ]
    );
    
    return ctrId;
  }

  // Determine if transaction should be blocked
  shouldBlockTransaction(alerts) {
    // Block if any critical alert
    return alerts.some(alert => 
      alert.severity === 'CRITICAL' &&
      ['SANCTIONS_HIT', 'STRUCTURING', 'DECEASED'].includes(alert.type)
    );
  }

  // Block transaction
  async blockTransaction(transaction, alerts) {
    await pool.query(
      `INSERT INTO blocked_transactions (
        transaction_ref, user_id, amount, reason,
        alerts, blocked_at
      ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
      [
        transaction.transactionRef,
        transaction.userId,
        transaction.amount,
        'Suspicious activity detected',
        JSON.stringify(alerts)
      ]
    );
    
    // Notify user
    await NotificationService.sendNotification(
      transaction.userId,
      'Transaction Blocked',
      'Your transaction has been blocked for security review',
      { transactionRef: transaction.transactionRef }
    );
  }

  // Save monitoring result
  async saveMonitoringResult(transaction, alerts) {
    await pool.query(
      `INSERT INTO transaction_monitoring_logs (
        transaction_ref, user_id, monitoring_result,
        alerts_generated, created_at
      ) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`,
      [
        transaction.transactionRef,
        transaction.userId,
        JSON.stringify({ alerts, timestamp: new Date() }),
        alerts.length
      ]
    );
  }

  // Save individual alert
  async saveAlert(transaction, alert) {
    const alertId = `ALERT${Date.now()}${Math.random().toString(36).substr(2, 9)}`;
    
    await pool.query(
      `INSERT INTO monitoring_alerts (
        alert_id, transaction_ref, user_id, alert_type,
        severity, description, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, 'OPEN', CURRENT_TIMESTAMP)`,
      [
        alertId,
        transaction.transactionRef,
        transaction.userId,
        alert.type,
        alert.severity,
        alert.description
      ]
    );
    
    return alertId;
  }

  // Notify compliance team
  async notifyComplianceTeam(transaction, alerts) {
    // Get compliance team members
    const complianceTeam = await pool.query(
      `SELECT user_id FROM admin_users WHERE role = 'COMPLIANCE'`
    );
    
    for (const member of complianceTeam.rows) {
      await NotificationService.sendNotification(
        member.user_id,
        'Transaction Alert',
        `Transaction ${transaction.transactionRef} requires review`,
        { alerts, transactionRef: transaction.transactionRef }
      );
    }
  }

  // Log monitoring error
  async logMonitoringError(transaction, error) {
    await pool.query(
      `INSERT INTO monitoring_errors (
        transaction_ref, error_message, error_data, created_at
      ) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
      [
        transaction.transactionRef,
        error.message,
        JSON.stringify({ stack: error.stack, transaction })
      ]
    );
  }
}

module.exports = new TransactionMonitoringService();
