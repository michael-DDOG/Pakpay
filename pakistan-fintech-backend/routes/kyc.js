const express = require('express');
const authMiddleware = require('../middleware/auth');
const nadraService = require('../services/nadraService');
const { getErrorMessage } = require('../utils/errorMessages');
const logger = require('../utils/logger');

const router = express.Router();

// Verify CNIC with NADRA
router.post('/verify-cnic', authMiddleware, async (req, res) => {
  try {
    const { cnic } = req.body;
    const { phone_number } = req.user;
   
    // Validate CNIC format
    const cnicRegex = /^[0-9]{5}-[0-9]{7}-[0-9]$/;
    if (!cnicRegex.test(cnic)) {
      return res.status(400).json({
        error: getErrorMessage('invalidCNIC', req.headers['accept-language']),
        errorCode: 'INVALID_CNIC_FORMAT'
      });
    }
   
    // Call NADRA service
    const verificationResult = await nadraService.verifyCNIC(cnic, phone_number);
   
    if (!verificationResult.success) {
      return res.status(400).json({
        error: getErrorMessage('cnicNotVerified', req.headers['accept-language']),
        errorCode: verificationResult.error,
        message: verificationResult.message
      });
    }
   
    // Update user's KYC status in database
    // TODO: Update user record with KYC level and CNIC details
   
    res.json({
      success: true,
      data: {
        verified: verificationResult.data.verified,
        kycLevel: verificationResult.data.kycLevel,
        name: verificationResult.data.name,
        limits: verificationResult.data.limits,
        message: 'CNIC verified successfully'
      }
    });
   
  } catch (error) {
    logger.error('CNIC verification error:', error);
    res.status(500).json({
      error: getErrorMessage('serviceUnavailable', req.headers['accept-language']),
      errorCode: 'VERIFICATION_FAILED'
    });
  }
});

// Get KYC status
router.get('/status', authMiddleware, async (req, res) => {
  try {
    // TODO: Fetch actual KYC status from database
    const kycStatus = {
      kycLevel: req.user.kyc_level || 1,
      verified: req.user.kyc_level > 0,
      limits: nadraService.getKYCLimits(req.user.kyc_level || 1),
      documentsRequired: req.user.kyc_level < 2 ? ['selfie', 'utility_bill'] : [],
      lastUpdated: new Date().toISOString()
    };
   
    res.json(kycStatus);
   
  } catch (error) {
    logger.error('Get KYC status error:', error);
    res.status(500).json({
      error: getErrorMessage('serviceUnavailable', req.headers['accept-language'])
    });
  }
});

module.exports = router;
