// backend/routes/merchants.js
const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth');
const pool = require('../config/database');
const crypto = require('crypto');

// Register as merchant
router.post('/register', authenticateToken, async (req, res) => {
  try {
    const { businessName, businessType, businessAddress, businessPhone } = req.body;
    const userId = req.user.userId;

    // Check if already a merchant
    const existing = await pool.query(
      'SELECT * FROM merchants WHERE user_id = $1',
      [userId]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Already registered as merchant'
      });
    }

    // Generate merchant ID
    const merchantId = 'MER' + Date.now() + crypto.randomBytes(4).toString('hex').toUpperCase();

    const result = await pool.query(
      `INSERT INTO merchants 
       (merchant_id, user_id, business_name, business_type, business_address, 
        business_phone, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW())
       RETURNING *`,
      [merchantId, userId, businessName, businessType, businessAddress, businessPhone]
    );

    res.json({
      success: true,
      merchant: result.rows[0],
      message: 'Merchant registration submitted for approval'
    });
  } catch (error) {
    console.error('Merchant registration error:', error);
    res.status(500).json({ success: false, error: 'Failed to register merchant' });
  }
});

// Get merchant dashboard
router.get('/dashboard', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Get merchant details
    const merchant = await pool.query(
      'SELECT * FROM merchants WHERE user_id = $1',
      [userId]
    );

    if (merchant.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Not registered as merchant'
      });
    }

    // Get today's stats
    const todayStats = await pool.query(
      `SELECT 
        COUNT(*) as transaction_count,
        COALESCE(SUM(amount), 0) as total_revenue
       FROM transactions
       WHERE recipient_id = $1 
       AND type = 'credit'
       AND DATE(created_at) = CURRENT_DATE`,
      [userId]
    );

    // Get monthly stats
    const monthlyStats = await pool.query(
      `SELECT 
        COUNT(*) as transaction_count,
        COALESCE(SUM(amount), 0) as total_revenue
       FROM transactions
       WHERE recipient_id = $1 
       AND type = 'credit'
       AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE)`,
      [userId]
    );

    res.json({
      success: true,
      merchant: merchant.rows[0],
      todayStats: todayStats.rows[0],
      monthlyStats: monthlyStats.rows[0]
    });
  } catch (error) {
    console.error('Get merchant dashboard error:', error);
    res.status(500).json({ success: false, error: 'Failed to get dashboard' });
  }
});

// Generate payment QR for merchant
router.post('/generate-qr', authenticateToken, async (req, res) => {
  try {
    const { amount, description } = req.body;
    const userId = req.user.userId;

    // Verify merchant
    const merchant = await pool.query(
      'SELECT * FROM merchants WHERE user_id = $1 AND status = $2',
      [userId, 'approved']
    );

    if (merchant.rows.length === 0) {
      return res.status(403).json({
        success: false,
        error: 'Not an approved merchant'
      });
    }

    // Generate QR code
    const qrId = 'MQR' + crypto.randomBytes(8).toString('hex').toUpperCase();
    
    const result = await pool.query(
      `INSERT INTO merchant_qr_codes 
       (qr_id, merchant_id, amount, description, status, expires_at, created_at)
       VALUES ($1, $2, $3, $4, 'active', NOW() + INTERVAL '24 hours', NOW())
       RETURNING *`,
      [qrId, merchant.rows[0].id, amount, description]
    );

    res.json({
      success: true,
      qrCode: result.rows[0],
      qrString: JSON.stringify({
        type: 'PAKPAY_MERCHANT',
        merchantId: merchant.rows[0].merchant_id,
        qrId,
        amount,
        businessName: merchant.rows[0].business_name
      })
    });
  } catch (error) {
    console.error('Generate merchant QR error:', error);
    res.status(500).json({ success: false, error: 'Failed to generate QR' });
  }
});

module.exports = router;
