const express = require('express');
const authMiddleware = require('../middleware/auth');
const { validateRequest, schemas } = require('../middleware/validation');
const { encryptResponse, decryptRequest } = require('../middleware/encryption');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const { getErrorMessage } = require('../utils/errorMessages');
const db = require('../config/database');
const logger = require('../utils/logger');

const router = express.Router();

// Apply encryption middleware
router.use(decryptRequest);
router.use(encryptResponse);

// Domestic transfer (updated with encryption and Urdu messages)
router.post('/domestic', authMiddleware, validateRequest(schemas.transfer), async (req, res) => {
  const client = await db.getClient();
  const language = req.headers['accept-language'] || 'en';
 
  try {
    const { receiverPhone, amount, description } = req.body;
   
    // Check user's KYC level
    const userKYCLevel = req.user.kyc_level || 1;
    const kycLimits = {
      1: { daily: 50000, perTransaction: 25000 },
      2: { daily: 200000, perTransaction: 100000 },
      3: { daily: 1000000, perTransaction: 500000 }
    };
   
    const limits = kycLimits[userKYCLevel];
   
    // Validate amount against KYC limits
    if (amount > limits.perTransaction) {
      return res.status(400).json({
        error: getErrorMessage('dailyLimitExceeded', language),
        errorCode: 'EXCEEDS_TRANSACTION_LIMIT',
        limit: limits.perTransaction,
        kycLevel: userKYCLevel
      });
    }
   
    // Check daily limit (mock - in production, calculate from transactions table)
    const dailyTotal = 0; // TODO: Calculate actual daily total
    if (dailyTotal + amount > limits.daily) {
      return res.status(400).json({
        error: getErrorMessage('dailyLimitExceeded', language),
        errorCode: 'EXCEEDS_DAILY_LIMIT',
        dailyLimit: limits.daily,
        dailyUsed: dailyTotal
      });
    }
   
    // Validate minimum amount
    if (amount < process.env.MIN_TRANSFER_AMOUNT) {
      return res.status(400).json({
        error: getErrorMessage('invalidAmount', language),
        errorCode: 'BELOW_MINIMUM',
        minimum: process.env.MIN_TRANSFER_AMOUNT
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
      return res.status(403).json({
        error: getErrorMessage('accountLocked', language),
        errorCode: 'WALLET_LOCKED'
      });
    }
   
    // Check balance
    if (senderWallet.balance < amount) {
      return res.status(400).json({
        error: getErrorMessage('insufficientBalance', language),
        errorCode: 'INSUFFICIENT_BALANCE',
        currentBalance: senderWallet.balance,
        required: amount
      });
    }
   
    // Find receiver
    const receiver = await User.findByPhone(receiverPhone);
    if (!receiver) {
      return res.status(404).json({
        error: getErrorMessage('userNotFound', language),
        errorCode: 'RECEIVER_NOT_FOUND'
      });
    }
   
    // Prevent self-transfer
    if (receiver.id === req.user.id) {
      return res.status(400).json({
        error: language === 'ur' ? 'آپ خود کو رقم نہیں بھیج سکتے' : 'Cannot transfer to yourself',
        errorCode: 'SELF_TRANSFER'
      });
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
      message: language === 'ur' ? 'رقم کامیابی سے بھیجی گئی' : 'Transfer successful',
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
    res.status(500).json({
      error: getErrorMessage('transactionFailed', language),
      errorCode: 'TRANSFER_FAILED'
    });
  } finally {
    client.release();
  }
});

// Get transfer limits based on KYC
router.get('/limits', authMiddleware, async (req, res) => {
  const language = req.headers['accept-language'] || 'en';
 
  try {
    const userKYCLevel = req.user.kyc_level || 1;
    const kycLimits = {
      1: {
        daily: 50000,
        monthly: 200000,
        perTransaction: 25000,
        description: language === 'ur' ? 'بنیادی تصدیق' : 'Basic Verification'
      },
      2: {
        daily: 200000,
        monthly: 500000,
        perTransaction: 100000,
        description: language === 'ur' ? 'معیاری تصدیق' : 'Standard Verification'
      },
      3: {
        daily: 1000000,
        monthly: 10000000,
        perTransaction: 500000,
        description: language === 'ur' ? 'مکمل تصدیق' : 'Full Verification'
      }
    };
   
    const limits = kycLimits[userKYCLevel];
   
    // TODO: Calculate actual daily/monthly usage
    const dailyUsed = 0;
    const monthlyUsed = 0;
   
    res.json({
      limits: {
        ...limits,
        minimum: parseInt(process.env.MIN_TRANSFER_AMOUNT)
      },
      usage: {
        dailyUsed,
        dailyRemaining: limits.daily - dailyUsed,
        monthlyUsed,
        monthlyRemaining: limits.monthly - monthlyUsed
      },
      kycLevel: userKYCLevel,
      currency: 'PKR',
      upgradeMessage: userKYCLevel < 3 ?
        (language === 'ur' ? 'اپنی حد بڑھانے کے لیے KYC مکمل کریں' : 'Complete KYC to increase your limits') : null
    });
   
  } catch (error) {
    logger.error('Get limits error:', error);
    res.status(500).json({
      error: getErrorMessage('serviceUnavailable', language),
      errorCode: 'LIMITS_FETCH_FAILED'
    });
  }
});

module.exports = router;
