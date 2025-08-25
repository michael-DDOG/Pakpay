const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth');

router.get('/list', authenticateToken, async (req, res) => {
  res.json({ notifications: [] });
});

module.exports = router;
