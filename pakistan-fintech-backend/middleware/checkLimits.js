// middleware/checkLimits.js
const KYCLimitsService = require('../services/kycLimitsService');

const checkTransactionLimits = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const amount = parseFloat(req.body.amount);
    const transactionType = req.transactionType || 'transfer';
    
    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid amount'
      });
    }
    
    // Check limits
    const limitCheck = await KYCLimitsService.checkTransactionLimits(
      userId,
      amount,
      transactionType
    );
    
    if (!limitCheck.allowed) {
      return res.status(403).json({
        success: false,
        error: limitCheck.reason,
        limits: limitCheck.limits
      });
    }
    
    // Attach limit info to request for later use
    req.limitCheck = limitCheck;
    next();
    
  } catch (error) {
    console.error('Limit check error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check transaction limits'
    });
  }
};

module.exports = checkTransactionLimits;
