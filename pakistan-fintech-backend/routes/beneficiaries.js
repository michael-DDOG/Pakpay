// routes/beneficiaries.js
const express = require('express');
const router = express.Router();
const BeneficiaryService = require('../services/beneficiaryService');
const authenticateToken = require('../middleware/auth');

// Get user's beneficiaries
router.get('/', authenticateToken, async (req, res) => {
  try {
    const beneficiaries = await BeneficiaryService.getUserBeneficiaries(req.user.userId);
    res.json({ success: true, beneficiaries });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get recent recipients
router.get('/recent', authenticateToken, async (req, res) => {
  try {
    const recipients = await BeneficiaryService.getRecentRecipients(req.user.userId);
    res.json({ success: true, recipients });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Add beneficiary
router.post('/add', authenticateToken, async (req, res) => {
  try {
    const result = await BeneficiaryService.addBeneficiary(req.user.userId, req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Toggle favorite
router.post('/:beneficiaryRef/favorite', authenticateToken, async (req, res) => {
  try {
    const result = await BeneficiaryService.toggleFavorite(
      req.user.userId,
      req.params.beneficiaryRef
    );
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update beneficiary
router.put('/:beneficiaryRef', authenticateToken, async (req, res) => {
  try {
    const result = await BeneficiaryService.updateBeneficiary(
      req.user.userId,
      req.params.beneficiaryRef,
      req.body
    );
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete beneficiary
router.delete('/:beneficiaryRef', authenticateToken, async (req, res) => {
  try {
    const result = await BeneficiaryService.deleteBeneficiary(
      req.user.userId,
      req.params.beneficiaryRef
    );
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
