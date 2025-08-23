// routes/receipts.js
const express = require('express');
const router = express.Router();
const ReceiptService = require('../services/receiptService');
const authenticateToken = require('../middleware/auth');

// Generate PDF receipt
router.get('/pdf/:transactionRef', authenticateToken, async (req, res) => {
  try {
    const { transactionRef } = req.params;
    const userId = req.user.userId;
    
    const pdfBuffer = await ReceiptService.generateReceipt(transactionRef, userId);
    
    // Save download record
    await ReceiptService.saveReceiptRecord(userId, transactionRef, 'pdf');
    
    // Send PDF
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="receipt_${transactionRef}.pdf"`,
      'Content-Length': pdfBuffer.length
    });
    
    res.send(pdfBuffer);
    
  } catch (error) {
    console.error('Generate PDF error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to generate receipt'
    });
  }
});

// Generate HTML receipt (for in-app display)
router.get('/html/:transactionRef', authenticateToken, async (req, res) => {
  try {
    const { transactionRef } = req.params;
    const userId = req.user.userId;
    
    const receipt = await ReceiptService.generateReceiptImage(transactionRef, userId);
    
    res.json({
      success: true,
      html: receipt.html,
      transaction: receipt.transaction
    });
    
  } catch (error) {
    console.error('Generate HTML receipt error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to generate receipt'
    });
  }
});

module.exports = router;
