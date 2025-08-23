// routes/splitbills.js
const express = require('express');
const router = express.Router();
const SplitBillService = require('../services/splitBillService');
const authenticateToken = require('../middleware/auth');

// Create split bill
router.post('/create', authenticateToken, async (req, res) => {
  try {
    const result = await SplitBillService.createSplitBill(req.user.userId, req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get user's split bills
router.get('/', authenticateToken, async (req, res) => {
  try {
    const bills = await SplitBillService.getUserSplitBills(req.user.userId);
    res.json({ success: true, ...bills });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get split bill details
router.get('/:splitId', authenticateToken, async (req, res) => {
  try {
    const details = await SplitBillService.getSplitBillDetails(
      req.params.splitId,
      req.user.userId
    );
    res.json({ success: true, ...details });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Pay share
router.post('/:splitId/pay', authenticateToken, async (req, res) => {
  try {
    const result = await SplitBillService.payShare(req.params.splitId, req.user.userId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Send reminder
router.post('/:splitId/remind', authenticateToken, async (req, res) => {
  try {
    const result = await SplitBillService.sendReminder(
      req.params.splitId,
      req.user.userId,
      req.body.participantPhone
    );
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
