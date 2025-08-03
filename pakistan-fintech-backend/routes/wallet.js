const express = require('express');
const authMiddleware = require('../middleware/auth');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const logger = require('../utils/logger');

const router = express.Router();

// Get wallet balance
router.get('/balance', authMiddleware, async (req, res) => {
  try {
    const wallet = await Wallet.findByUserId(req.user.id);
    
    if (!wallet) {
      return res.status(404).json({ error: 'Wallet not found' });
    }
    
    res.json({
      walletId: wallet.id,
      balance: wallet.balance,
      currency: wallet.currency,
      isLocked: wallet.is_locked,
      lastUpdated: wallet.updated_at
    });
    
  } catch (error) {
    logger.error('Get balance error:', error);
    res.status(500).json({ error: 'Failed to retrieve balance' });
  }
});

// Get transaction history
router.get('/transactions', authMiddleware, async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    
    const transactions = await Transaction.getUserTransactions(
      req.user.id,
      parseInt(limit),
      parseInt(offset)
    );
    
    res.json({
      transactions: transactions.map(t => ({
        id: t.id,
        referenceNumber: t.reference_number,
        type: t.type,
        amount: t.amount,
        currency: t.currency,
        status: t.status,
        description: t.description,
        isSender: t.sender_user_id === req.user.id,
        counterparty: t.sender_user_id === req.user.id 
          ? `${t.receiver_first_name} ${t.receiver_last_name}`
          : `${t.sender_first_name} ${t.sender_last_name}`,
        createdAt: t.created_at,
        completedAt: t.completed_at
      })),
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
    
  } catch (error) {
    logger.error('Get transactions error:', error);
    res.status(500).json({ error: 'Failed to retrieve transactions' });
  }
});

module.exports = router;
