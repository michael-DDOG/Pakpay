const express = require('express');
const authMiddleware = require('../middleware/auth');
const rapydService = require('../services/rapydService');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const { getErrorMessage } = require('../utils/errorMessages');
const db = require('../config/database');
const logger = require('../utils/logger');

const router = express.Router();

// Get supported corridors and rates
router.get('/corridors', authMiddleware, async (req, res) => {
  try {
    const corridors = [];

    for (const [country, details] of Object.entries(rapydService.supportedCorridors)) {
      const rateInfo = await rapydService.getExchangeRate(details.currency, 'PKR');
      corridors.push({
        country,
        currency: details.currency,
        exchangeRate: rateInfo.rate,
        processingTime: details.processingTime,
        available: true
      });
    }

    res.json({
      corridors,
      lastUpdated: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Get corridors error:', error);
    res.status(500).json({
      error: getErrorMessage('serviceUnavailable', req.headers['accept-language'])
    });
  }
});

// Get exchange rate
router.post('/exchange-rate', authMiddleware, async (req, res) => {
  try {
    const { fromCurrency, toCurrency = 'PKR', amount } = req.body;

    const rateInfo = await rapydService.getExchangeRate(fromCurrency, toCurrency);

    res.json({
      ...rateInfo,
      convertedAmount: amount ? (amount * rateInfo.rate).toFixed(2) : null,
      fees: {
        transferFee: 0,
        fxSpread: amount ? (amount * 0.005).toFixed(2) : null
      }
    });

  } catch (error) {
    logger.error('Get exchange rate error:', error);
    res.status(400).json({
      error: error.message || getErrorMessage('invalidRequest', req.headers['accept-language'])
    });
  }
});

// Create inbound remittance (renamed to /remittance for frontend consistency)
router.post('/remittance', authMiddleware, async (req, res) => {
  const client = await db.getClient();
  try {
    const {
      senderCountry,
      senderCurrency,
      senderAmount,
      purpose,
      sourceOfFunds,
      senderName,
      senderPhone
    } = req.body;

    // Validate user KYC level for international remittance
    if (req.user.kyc_level < 2) {
      return res.status(403).json({
        error: getErrorMessage('kycRequired', req.headers['accept-language']),
        errorCode: 'INSUFFICIENT_KYC',
        requiredLevel: 2,
        currentLevel: req.user.kyc_level
      });
    }

    // Get user's wallet
    const wallet = await Wallet.findByUserId(req.user.id);
    if (!wallet) {
      throw new Error('Wallet not found');
    }

    // Start transaction
    await client.query('BEGIN');

    // Create remittance via Rapyd
    const remittanceResult = await rapydService.createInboundRemittance({
      senderCountry,
      senderCurrency,
      senderAmount,
      receiverWalletId: wallet.id,
      receiverPhone: req.user.phone_number,
      receiverCNIC: req.user.cnic,
      purpose,
      sourceOfFunds
    });

    if (!remittanceResult.success) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: getErrorMessage(
          remittanceResult.error === 'CORRIDOR_NOT_SUPPORTED'
            ? 'remittanceNotSupported'
            : 'transactionFailed',
          req.headers['accept-language']
        ),
        errorCode: remittanceResult.error,
        message: remittanceResult.message
      });
    }

    const { transactionId, receivedAmount, exchangeRate } = remittanceResult.data;

    // Create transaction record
    const transaction = await Transaction.create(client, {
      senderWalletId: null, // External sender
      receiverWalletId: wallet.id,
      amount: receivedAmount,
      type: 'remittance_inbound',
      description: `Remittance from ${senderName || 'Sender'} (${senderCountry})`,
      metadata: {
        rapydTransactionId: transactionId,
        senderCountry,
        senderCurrency,
        senderAmount,
        exchangeRate,
        purpose
      }
    });

    // Credit wallet
    const newBalance = await Wallet.updateBalance(
      client,
      wallet.id,
      receivedAmount,
      'add'
    );

    if (!newBalance) {
      throw new Error('Failed to credit wallet');
    }

    // Update transaction status
    await Transaction.updateStatus(client, transaction.id, 'completed');

    // Log transaction
    await Transaction.logTransaction(client, transaction.id, 'remittance_received', {
      rapydTransactionId: transactionId,
      amount: receivedAmount,
      newBalance: newBalance.balance
    });

    // Commit transaction
    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Remittance received successfully',
      data: {
        transactionId: remittanceResult.data.transactionId,
        referenceNumber: transaction.reference_number,
        status: 'success',
        senderAmount: remittanceResult.data.senderAmount,
        senderCurrency: remittanceResult.data.senderCurrency,
        receivedAmount: remittanceResult.data.receivedAmount,
        receivedCurrency: 'PKR',
        exchangeRate: remittanceResult.data.exchangeRate,
        fees: remittanceResult.data.fees,
        expectedDelivery: remittanceResult.data.expectedDelivery,
        trackingUrl: remittanceResult.data.trackingUrl,
        newBalance: newBalance.balance
      }
    });

  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Remittance error:', error);
    res.status(500).json({
      error: getErrorMessage('transactionFailed', req.headers['accept-language']),
      errorCode: 'REMITTANCE_FAILED'
    });
  } finally {
    client.release();
  }
});

// Check remittance status
router.get('/status/:transactionId', authMiddleware, async (req, res) => {
  try {
    const { transactionId } = req.params;

    const status = await rapydService.checkRemittanceStatus(transactionId);

    res.json(status.data);

  } catch (error) {
    logger.error('Check remittance status error:', error);
    res.status(500).json({
      error: getErrorMessage('serviceUnavailable', req.headers['accept-language'])
    });
  }
});

module.exports = router;
