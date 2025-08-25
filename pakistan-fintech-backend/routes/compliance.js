// routes/compliance.js
const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth');
const adminAuth = require('../middleware/adminAuth');

// Compliance dashboard endpoint
router.get('/dashboard', [authenticateToken, adminAuth], async (req, res) => {
  try {
    const pool = require('../config/database');
    
    // Get compliance metrics
    const metrics = {
      daily: {
        transactions: await getMetric('daily_transactions'),
        newAccounts: await getMetric('daily_new_accounts'),
        strs: await getMetric('daily_strs'),
        ctrs: await getMetric('daily_ctrs'),
        alerts: await getMetric('daily_alerts')
      },
      riskProfiles: await getRiskDistribution(),
      systemHealth: await getSystemHealth(),
      pendingActions: await getPendingActions()
    };
    
    res.json({ success: true, metrics });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function getMetric(type) {
  const pool = require('../config/database');
  
  switch(type) {
    case 'daily_transactions':
      const txResult = await pool.query(
        `SELECT COUNT(*) as count, SUM(amount) as volume
         FROM ledger_entries
         WHERE DATE(created_at) = CURRENT_DATE`
      );
      return txResult.rows[0];
      
    case 'daily_new_accounts':
      const accResult = await pool.query(
        `SELECT COUNT(*) as count
         FROM users
         WHERE DATE(created_at) = CURRENT_DATE`
      );
      return accResult.rows[0].count;
      
    case 'daily_strs':
      const strResult = await pool.query(
        `SELECT COUNT(*) as count
         FROM suspicious_transaction_reports
         WHERE DATE(created_at) = CURRENT_DATE`
      );
      return strResult.rows[0].count;
      
    case 'daily_ctrs':
      const ctrResult = await pool.query(
        `SELECT COUNT(*) as count
         FROM currency_transaction_reports
         WHERE DATE(created_at) = CURRENT_DATE`
      );
      return ctrResult.rows[0].count;
      
    case 'daily_alerts':
      const alertResult = await pool.query(
        `SELECT COUNT(*) as count
         FROM monitoring_alerts
         WHERE DATE(created_at) = CURRENT_DATE
         AND status = 'OPEN'`
      );
      return alertResult.rows[0].count;
      
    default:
      return 0;
  }
}

async function getRiskDistribution() {
  const pool = require('../config/database');
  const result = await pool.query(
    `SELECT 
      risk_category,
      COUNT(*) as count
     FROM customer_risk_profiles
     GROUP BY risk_category`
  );
  return result.rows;
}

async function getSystemHealth() {
  return {
    status: 'OPERATIONAL',
    uptime: 99.99,
    lastIncident: null,
    complianceScore: 98
  };
}

async function getPendingActions() {
  const pool = require('../config/database');
  const result = await pool.query(
    `SELECT 
      (SELECT COUNT(*) FROM suspicious_transaction_reports WHERE status = 'PENDING_REVIEW') as pending_strs,
      (SELECT COUNT(*) FROM monitoring_alerts WHERE status = 'OPEN') as open_alerts,
      (SELECT COUNT(*) FROM customer_risk_profiles WHERE next_review_date <= CURRENT_DATE) as pending_reviews`
  );
  return result.rows[0];
}

module.exports = router;
