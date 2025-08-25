// backend/routes/qrcode.js
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const pool = require('../config/database');
const crypto = require('crypto');

// Generate QR code for receiving payment
router.post('/generate', authenticateToken, async (req, res) => {
  try {
    const { amount, description } = req.body;
    const userId = req.user.userId;

    // Generate unique QR code ID
    const qrCodeId = crypto.randomBytes(16).toString('hex');
    
    // Store QR code data in database
    const query = `
      INSERT INTO qr_codes (id, user_id, amount, description, status, created_at, expires_at)
      VALUES ($1, $2, $3, $4, 'active', NOW(), NOW() + INTERVAL '15 minutes')
      RETURNING *
    `;
    
    const result = await pool.query(query, [qrCodeId, userId, amount, description]);
    
    // Generate QR code data
    const qrData = {
      id: qrCodeId,
      recipientId: userId,
      amount: amount,
      description: description,
      timestamp: new Date().toISOString()
    };

    res.json({
      success: true,
      qrCode: qrData,
      qrString: JSON.stringify(qrData),
      expiresIn: 900 // 15 minutes in seconds
    });
  } catch (error) {
    console.error('Generate QR code error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate QR code'
    });
  }
});

// Process QR code payment
router.post('/pay', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { qrCodeId, amount } = req.body;
    const payerId = req.user.userId;

    await client.query('BEGIN');

    // Get QR code details
    const qrResult = await client.query(
      'SELECT * FROM qr_codes WHERE id = $1 AND status = $2',
      [qrCodeId, 'active']
    );

    if (qrResult.rows.length === 0) {
      throw new Error('Invalid or expired QR code');
    }

    const qrCode = qrResult.rows[0];
    
    // Check if QR code has expired
    if (new Date(qrCode.expires_at) < new Date()) {
      await client.query(
        'UPDATE qr_codes SET status = $1 WHERE id = $2',
        ['expired', qrCodeId]
      );
      throw new Error('QR code has expired');
    }

    // Check payer balance
    const balanceResult = await client.query(
      'SELECT balance FROM wallets WHERE user_id = $1',
      [payerId]
    );

    if (balanceResult.rows.length === 0 || balanceResult.rows[0].balance < amount) {
      throw new Error('Insufficient balance');
    }

    // Process the transfer
    const transactionRef = 'QR' + Date.now() + Math.random().toString(36).substr(2, 9);

    // Debit payer
    await client.query(
      'UPDATE wallets SET balance = balance - $1 WHERE user_id = $2',
      [amount, payerId]
    );

    // Credit recipient
    await client.query(
      'UPDATE wallets SET balance = balance + $1 WHERE user_id = $2',
      [amount, qrCode.user_id]
    );

    // Record transactions
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, description, transaction_ref, status)
       VALUES ($1, 'debit', $2, $3, $4, 'completed')`,
      [payerId, amount, `QR Payment to ${qrCode.user_id}`, transactionRef]
    );

    await client.query(
      `INSERT INTO transactions (user_id, type, amount, description, transaction_ref, status)
       VALUES ($1, 'credit', $2, $3, $4, 'completed')`,
      [qrCode.user_id, amount, `QR Payment from ${payerId}`, transactionRef]
    );

    // Update QR code status
    await client.query(
      'UPDATE qr_codes SET status = $1, used_at = NOW(), paid_by = $2 WHERE id = $3',
      ['used', payerId, qrCodeId]
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Payment successful',
      transactionRef: transactionRef
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('QR payment error:', error);
    res.status(400).json({
      success: false,
      message: error.message || 'Payment failed'
    });
  } finally {
    client.release();
  }
});

// Get QR code details
router.get('/:qrCodeId', authenticateToken, async (req, res) => {
  try {
    const { qrCodeId } = req.params;
    
    const result = await pool.query(
      `SELECT q.*, u.name as recipient_name, u.phone as recipient_phone 
       FROM qr_codes q
       JOIN users u ON q.user_id = u.id
       WHERE q.id = $1`,
      [qrCodeId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'QR code not found'
      });
    }

    res.json({
      success: true,
      qrCode: result.rows[0]
    });
  } catch (error) {
    console.error('Get QR code error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get QR code details'
    });
  }
});

module.exports = router;
