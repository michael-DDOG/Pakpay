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
        error: 'All fields are required'
      });
    }

    // Verify recipient exists
    const recipientCheck = await pool.query(
      'SELECT id, name FROM users WHERE phone = $1',
      [recipientPhone]
    );

    if (recipientCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Recipient not found'
      });
    }

    const result = await pool.query(
      `INSERT INTO scheduled_transfers 
       (user_id, recipient_id, recipient_phone, amount, scheduled_date, description, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW())
       RETURNING *`,
      [userId, recipientCheck.rows[0].id, recipientPhone, amount, scheduledDate, description]
    );

    res.json({
      success: true,
      scheduledTransfer: result.rows[0],
      recipientName: recipientCheck.rows[0].name
    });
  } catch (error) {
    console.error('Schedule transfer error:', error);
    res.status(500).json({ success: false, error: 'Failed to schedule transfer' });
  }
});

// Get scheduled transfers
router.get('/transfers', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    const result = await pool.query(
      `SELECT st.*, u.name as recipient_name
       FROM scheduled_transfers st
       LEFT JOIN users u ON st.recipient_id = u.id
       WHERE st.user_id = $1 AND st.status = 'pending'
       ORDER BY st.scheduled_date ASC`,
      [userId]
    );

    res.json({
      success: true,
      scheduledTransfers: result.rows
    });
  } catch (error) {
    console.error('Get scheduled transfers error:', error);
    res.status(500).json({ success: false, error: 'Failed to get scheduled transfers' });
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
        error: 'Transfer not found or already processed'
      });
    }

    res.json({
      success: true,
      message: 'Scheduled transfer cancelled'
    });
  } catch (error) {
    console.error('Cancel scheduled transfer error:', error);
    res.status(500).json({ success: false, error: 'Failed to cancel transfer' });
  }
});

// Recurring payments
router.post('/recurring', authenticateToken, async (req, res) => {
  try {
    const { recipientPhone, amount, frequency, startDate, endDate, description } = req.body;
    const userId = req.user.userId;

    const result = await pool.query(
      `INSERT INTO recurring_payments 
       (user_id, recipient_phone, amount, frequency, start_date, end_date, 
        next_execution_date, description, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $5, $7, 'active', NOW())
       RETURNING *`,
      [userId, recipientPhone, amount, frequency, startDate, endDate, description]
    );

    res.json({
      success: true,
      recurringPayment: result.rows[0]
    });
  } catch (error) {
    console.error('Setup recurring payment error:', error);
    res.status(500).json({ success: false, error: 'Failed to setup recurring payment' });
  }
});

module.exports = router;
