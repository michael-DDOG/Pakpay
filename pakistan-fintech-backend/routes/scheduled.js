// backend/routes/scheduled.js
const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth');
const pool = require('../config/database');

// Schedule a future transfer
router.post('/transfer', authenticateToken, async (req, res) => {
  try {
    const { recipientPhone, amount, scheduledDate, description } = req.body;
    const userId = req.user.userId;

    if (!recipientPhone || !amount || !scheduledDate) {
      return res.status(400).json({
        success: false,
        error: 'Recipient, amount, and scheduled date are required'
      });
    }

    // Create scheduled transfer
    const result = await pool.query(
      `INSERT INTO scheduled_transfers 
       (user_id, recipient_phone, amount, scheduled_date, description, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', NOW())
       RETURNING *`,
      [userId, recipientPhone, amount, scheduledDate, description || '']
    );

    res.json({
      success: true,
      scheduledTransfer: result.rows[0]
    });
  } catch (error) {
    console.error('Schedule transfer error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to schedule transfer'
    });
  }
});

// Get scheduled transfers
router.get('/transfers', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    const result = await pool.query(
      `SELECT * FROM scheduled_transfers 
       WHERE user_id = $1 AND status = 'pending'
       ORDER BY scheduled_date ASC`,
      [userId]
    );

    res.json({
      success: true,
      scheduledTransfers: result.rows
    });
  } catch (error) {
    console.error('Get scheduled transfers error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get scheduled transfers'
    });
  }
});

// Cancel scheduled transfer
router.delete('/transfer/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const result = await pool.query(
      `UPDATE scheduled_transfers 
       SET status = 'cancelled', cancelled_at = NOW()
       WHERE id = $1 AND user_id = $2 AND status = 'pending'
       RETURNING *`,
      [id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Scheduled transfer not found or already processed'
      });
    }

    res.json({
      success: true,
      message: 'Scheduled transfer cancelled',
      transfer: result.rows[0]
    });
  } catch (error) {
    console.error('Cancel scheduled transfer error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to cancel scheduled transfer'
    });
  }
});

// Schedule recurring payment
router.post('/recurring', authenticateToken, async (req, res) => {
  try {
    const { 
      recipientPhone, 
      amount, 
      frequency, // 'daily', 'weekly', 'monthly'
      startDate,
      endDate,
      description 
    } = req.body;
    const userId = req.user.userId;

    if (!recipientPhone || !amount || !frequency || !startDate) {
      return res.status(400).json({
        success: false,
        error: 'All fields are required for recurring payment'
      });
    }

    const result = await pool.query(
      `INSERT INTO recurring_payments 
       (user_id, recipient_phone, amount, frequency, start_date, end_date, description, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', NOW())
       RETURNING *`,
      [userId, recipientPhone, amount, frequency, startDate, endDate, description || '']
    );

    res.json({
      success: true,
      recurringPayment: result.rows[0]
    });
  } catch (error) {
    console.error('Schedule recurring payment error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to schedule recurring payment'
    });
  }
});

// Get recurring payments
router.get('/recurring', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    const result = await pool.query(
      `SELECT * FROM recurring_payments 
       WHERE user_id = $1 AND status = 'active'
       ORDER BY created_at DESC`,
      [userId]
    );

    res.json({
      success: true,
      recurringPayments: result.rows
    });
  } catch (error) {
    console.error('Get recurring payments error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get recurring payments'
    });
  }
});

// Cancel recurring payment
router.delete('/recurring/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const result = await pool.query(
      `UPDATE recurring_payments 
       SET status = 'cancelled', cancelled_at = NOW()
       WHERE id = $1 AND user_id = $2 AND status = 'active'
       RETURNING *`,
      [id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Recurring payment not found'
      });
    }

    res.json({
      success: true,
      message: 'Recurring payment cancelled',
      payment: result.rows[0]
    });
  } catch (error) {
    console.error('Cancel recurring payment error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to cancel recurring payment'
    });
  }
});

module.exports = router;
