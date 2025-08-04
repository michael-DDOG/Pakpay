const express = require('express');
const authMiddleware = require('../middleware/auth');
const { validateRequest, schemas } = require('../middleware/validation');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const { getErrorMessage } = require('../utils/errorMessages');
const db = require('../config/database');
const logger = require('../utils/logger');

const router = express.Router();

// Domestic transfer
router.post('/domestic', authMiddleware, validateRequest(schemas.transfer), async (req, res) => {
  const client = await db.getClient();
  
  try {
    const { receiverPhone, amount, description } = req.body;
    
    // Validate amount limits
    if (amount < process.env.MIN_TRANSFER_AMOUNT) {
      return res.status(400).json({ 
        error: `Minimum transfer amount is PKR ${process.env.MIN_TRANSFER_AMOUNT}` 
      });
    }
    
    if (amount > process.env.TRANSACTION_LIMIT_SINGLE) {
      return res.status(400).json({ 
        error: `Maximum single transaction limit is PKR ${process.env.TRANSACTION_LIMIT_SINGLE}` 
      });
    }
    
    // Start transaction
    await client.query('BEGIN');
    
    // Get sender wallet
    const senderWallet = await Wallet.findByUserId(req.user.id);
    if (!senderWallet) {
      throw new Error('Sender wallet not found');
    }
    
    // Check if wallet is locked
    if (senderWallet.is_locked) {
      return res.status(403).json({ error: 'Your wallet is locked. Please contact support.' });
    }
    
    // Check balance
    if (senderWallet.balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    
    // Find receiver
    const receiver = await User.findByPhone(receiverPhone);
    if (!receiver) {
      return res.status(404).json({ error: 'Receiver not found' });
    }
    
    // Prevent self-transfer
    if (receiver.id === req.user.id) {
      return res.status(400).json({ error: 'Cannot transfer to yourself' });
    }
    
    // Get receiver wallet
    const receiverWallet = await Wallet.findByUserId(receiver.id);
    if (!receiverWallet) {
      throw new Error('Receiver wallet not found');
    }
    
    // Create transaction record
    const transaction = await Transaction.create(client, {
      senderWalletId: senderWallet.id,
      receiverWalletId: receiverWallet.id,
      amount,
      type: 'transfer',
      description: description || `Transfer to ${receiver.first_name} ${receiver.last_name}`
    });
    
    // Log transaction initiation
    await Transaction.logTransaction(client, transaction.id, 'initiated', {
      senderBalance: senderWallet.balance,
      receiverBalance: receiverWallet.balance
    });
    
    // Deduct from sender
    const newSenderBalance = await Wallet.updateBalance(client, senderWallet.id, amount, 'subtract');
    if (!newSenderBalance) {
      throw new Error('Failed to deduct from sender wallet');
    }
    
    // Add to receiver
    const newReceiverBalance = await Wallet.updateBalance(client, receiverWallet.id, amount, 'add');
    if (!newReceiverBalance) {
      throw new Error('Failed to add to receiver wallet');
    }
    
    // Update transaction status
    await Transaction.updateStatus(client, transaction.id, 'completed');
    
    // Log transaction completion
    await Transaction.logTransaction(client, transaction.id, 'completed', {
      senderNewBalance: newSenderBalance.balance,
      receiverNewBalance: newReceiverBalance.balance
    });
    
    // Commit transaction
    await client.query('COMMIT');
    
    res.json({
      message: 'Transfer successful',
      transaction: {
        referenceNumber: transaction.reference_number,
        amount: transaction.amount,
        currency: transaction.currency,
        receiver: `${receiver.first_name} ${receiver.last_name}`,
        receiverPhone: receiver.phone_number,
        description: transaction.description,
        status: 'completed',
        timestamp: transaction.created_at
      },
      newBalance: newSenderBalance.balance
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Transfer error:', error);
    res.status(500).json({ error: 'Transfer failed. Please try again.' });
  } finally {
    client.release();
  }
});

// Get transfer limits
router.get('/limits', authMiddleware, async (req, res) => {
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
