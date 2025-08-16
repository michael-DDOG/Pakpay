// backend/routes/billRoutes.js
const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const billPaymentService = require('../services/billPaymentService');

// Get all billers
router.get('/billers', authMiddleware, async (req, res) => {
  try {
    const { type } = req.query;
    const billers = await billPaymentService.getBillers(type);
    res.json({ billers });
  } catch (error) {
    console.error('Get billers error:', error);
    res.status(500).json({ error: 'Failed to fetch billers' });
  }
});

// Validate bill
router.post('/validate', authMiddleware, async (req, res) => {
  try {
    const { billerCode, consumerNumber } = req.body;
    
    if (!billerCode || !consumerNumber) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const bill = await billPaymentService.validateBill(billerCode, consumerNumber);
    res.json({ bill });
  } catch (error) {
    console.error('Bill validation error:', error);
    res.status(500).json({ error: error.message || 'Failed to validate bill' });
  }
});

// Pay bill
router.post('/pay', authMiddleware, async (req, res) => {
  try {
    const { billerCode, consumerNumber, amount } = req.body;
    
    if (!billerCode || !consumerNumber || !amount) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await billPaymentService.payBill(
      req.user.id,
      billerCode,
      consumerNumber,
      parseFloat(amount)
    );

    res.json(result);
  } catch (error) {
    console.error('Bill payment error:', error);
    res.status(500).json({ error: error.message || 'Payment failed' });
  }
});

// Mobile top-up
router.post('/topup', authMiddleware, async (req, res) => {
  try {
    const { mobileNumber, operator, amount } = req.body;
    
    if (!mobileNumber || !operator || !amount) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await billPaymentService.topupMobile(
      req.user.id,
      mobileNumber,
      operator,
      parseFloat(amount)
    );

    res.json(result);
  } catch (error) {
    console.error('Mobile topup error:', error);
    res.status(500).json({ error: error.message || 'Topup failed' });
  }
});

// Get payment history
router.get('/history', authMiddleware, async (req, res) => {
  try {
    const history = await billPaymentService.getPaymentHistory(req.user.id);
    res.json({ payments: history });
  } catch (error) {
    console.error('Payment history error:', error);
    res.status(500).json({ error: 'Failed to fetch payment history' });
  }
});

module.exports = router;
