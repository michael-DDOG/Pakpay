// routes/requests.js
const express = require('express');
const router = express.Router();
const MoneyRequestService = require('../services/moneyRequestService');
const authenticateToken = require('../middleware/auth');
const checkTransactionLimits = require('../middleware/checkLimits');

// Create money request
router.post('/create', authenticateToken, async (req, res) => {
  try {
    const { requestFromPhone, amount, description } = req.body;
    const requesterId = req.user.userId;
    
    if (!requestFromPhone || !amount) {
      return res.status(400).json({
        success: false,
        error: 'Phone number and amount are required'
      });
    }
    
    if (amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Amount must be greater than 0'
      });
    }
    
    const result = await MoneyRequestService.createRequest(
      requesterId,
      requestFromPhone,
      amount,
      description
    );
    
    res.json(result);
  } catch (error) {
    console.error('Create request error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create money request'
    });
  }
});

// Get pending requests (requests TO the user)
router.get('/pending', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const requests = await MoneyRequestService.getPendingRequests(userId);
    
    res.json({
      success: true,
      requests
    });
  } catch (error) {
    console.error('Get pending requests error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch pending requests'
    });
  }
});

// Get sent requests (requests FROM the user)
router.get('/sent', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const requests = await MoneyRequestService.getSentRequests(userId);
    
    res.json({
      success: true,
      requests
    });
  } catch (error) {
    console.error('Get sent requests error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch sent requests'
    });
  }
});

// Approve request
router.post('/:requestId/approve', 
  authenticateToken, 
  async (req, res, next) => {
    // Get request details for limit checking
    try {
      const requestQuery = `
        SELECT amount 
        FROM money_requests 
        WHERE request_id = $1 
          AND requested_from_id = $2
          AND status = 'pending'
      `;
      const result = await pool.query(requestQuery, [req.params.requestId, req.user.userId]);
      
      if (result.rows.length > 0) {
        req.body.amount = result.rows[0].amount;
        req.transactionType = 'request_payment';
        next();
      } else {
        res.status(404).json({ success: false, error: 'Request not found' });
      }
    } catch (error) {
      res.status(500).json({ success: false, error: 'Failed to process request' });
    }
  },
  checkTransactionLimits,
  async (req, res) => {
    try {
      const { requestId } = req.params;
      const approverId = req.user.userId;
      
      const result = await MoneyRequestService.approveRequest(requestId, approverId);
      
      res.json(result);
    } catch (error) {
      console.error('Approve request error:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to approve request'
      });
    }
  }
);

// Decline request
router.post('/:requestId/decline', authenticateToken, async (req, res) => {
  try {
    const { requestId } = req.params;
    const { reason } = req.body;
    const declinerId = req.user.userId;
    
    const result = await MoneyRequestService.declineRequest(requestId, declinerId, reason);
    
    res.json(result);
  } catch (error) {
    console.error('Decline request error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to decline request'
    });
  }
});

// Cancel request
router.post('/:requestId/cancel', authenticateToken, async (req, res) => {
  try {
    const { requestId } = req.params;
    const requesterId = req.user.userId;
    
    const result = await MoneyRequestService.cancelRequest(requestId, requesterId);
    
    res.json(result);
  } catch (error) {
    console.error('Cancel request error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to cancel request'
    });
  }
});

// Send reminder
router.post('/:requestId/remind', authenticateToken, async (req, res) => {
  try {
    const { requestId } = req.params;
    const requesterId = req.user.userId;
    
    const result = await MoneyRequestService.sendReminder(requestId, requesterId);
    
    res.json(result);
  } catch (error) {
    console.error('Send reminder error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to send reminder'
    });
  }
});

module.exports = router;
