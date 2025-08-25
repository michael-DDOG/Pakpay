const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth');

router.get('/spending', authenticateToken, async (req, res) => {
  res.json({ message: 'Analytics coming soon!' });
});

module.exports = router;
