const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const authMiddleware = require('../middleware/auth');
const jwt = require('jsonwebtoken');

// Admin authentication middleware
const adminAuth = async (req, res, next) => {
  try {
    // For now, check if user email is admin
    // In production, you'd have a separate admin table
    const adminEmails = ['admin@pakfintech.com', 'admin@example.com'];
    
    if (!req.user || !adminEmails.includes(req.user.email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  } catch (error) {
    res.status(403).json({ error: 'Admin access required' });
  }
};

// Admin login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // For testing: admin@pakfintech.com / admin123
    if (email === 'admin@pakfintech.com' && password === 'admin123') {
      const token = jwt.sign(
        { userId: 'admin', email, isAdmin: true },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
      );
      
      res.json({
        success: true,
        token,
        admin: { email, name: 'Admin' }
      });
    } else {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Dashboard statistics
router.get('/stats', authMiddleware, adminAuth, async (req, res) => {
  try {
    // Get overall statistics
    const stats = {};
    
    // Total users
    const usersResult = await pool.query(
      'SELECT COUNT(*) as total, COUNT(CASE WHEN created_at >= NOW() - INTERVAL \'24 hours\' THEN 1 END) as today FROM users'
    );
    stats.users = {
      total: parseInt(usersResult.rows[0].total),
      today: parseInt(usersResult.rows[0].today)
    };
    
    // Total balance in system
    const balanceResult = await pool.query(
      'SELECT SUM(balance) as total FROM accounts'
    );
    stats.totalBalance = parseFloat(balanceResult.rows[0].total || 0);
    
    // Transaction statistics
    const txResult = await pool.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN timestamp >= NOW() - INTERVAL '24 hours' THEN 1 END) as today,
        SUM(CASE WHEN entry_type = 'debit' THEN amount ELSE 0 END) as total_debits,
        SUM(CASE WHEN entry_type = 'credit' THEN amount ELSE 0 END) as total_credits
      FROM ledger_entries
    `);
    stats.transactions = {
      total: parseInt(txResult.rows[0].total),
      today: parseInt(txResult.rows[0].today),
      totalDebits: parseFloat(txResult.rows[0].total_debits || 0),
      totalCredits: parseFloat(txResult.rows[0].total_credits || 0)
    };
    
    // KYC statistics
    const kycResult = await pool.query(`
      SELECT 
        COUNT(CASE WHEN kyc_level = 0 THEN 1 END) as unverified,
        COUNT(CASE WHEN kyc_level = 1 THEN 1 END) as basic,
        COUNT(CASE WHEN kyc_level = 2 THEN 1 END) as enhanced,
        COUNT(CASE WHEN kyc_level = 3 THEN 1 END) as full
      FROM users
    `);
    stats.kyc = kycResult.rows[0];
    
    res.json(stats);
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// Get all users with pagination
router.get('/users', authMiddleware, adminAuth, async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '' } = req.query;
    const offset = (page - 1) * limit;
    
    let query = `
      SELECT 
        u.id, u.phone, u.name, u.email, u.cnic, 
        u.kyc_level, u.is_active, u.created_at,
        a.balance, a.account_number
      FROM users u
      LEFT JOIN accounts a ON u.id = a.user_id
    `;
    
    const params = [];
    if (search) {
      query += ` WHERE u.phone LIKE $1 OR u.name ILIKE $1 OR u.email ILIKE $1`;
      params.push(`%${search}%`);
    }
    
    query += ` ORDER BY u.created_at DESC LIMIT ${limit} OFFSET ${offset}`;
    
    const result = await pool.query(query, params);
    
    // Get total count
    let countQuery = 'SELECT COUNT(*) FROM users';
    if (search) {
      countQuery += ` WHERE phone LIKE $1 OR name ILIKE $1 OR email ILIKE $1`;
    }
    const countResult = await pool.query(countQuery, params);
    
    res.json({
      users: result.rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      totalPages: Math.ceil(countResult.rows[0].count / limit)
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get recent transactions
router.get('/transactions', authMiddleware, adminAuth, async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    
    const result = await pool.query(`
      SELECT 
        le.*, 
        a.account_number,
        u.name as user_name,
        u.phone as user_phone
      FROM ledger_entries le
      JOIN accounts a ON le.account_id = a.id
      JOIN users u ON a.user_id = u.id
      ORDER BY le.timestamp DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
    
    const countResult = await pool.query('SELECT COUNT(*) FROM ledger_entries');
    
    res.json({
      transactions: result.rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      totalPages: Math.ceil(countResult.rows[0].count / limit)
    });
  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// Toggle user active status
router.post('/users/:userId/toggle-status', authMiddleware, adminAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    
    const result = await pool.query(
      'UPDATE users SET is_active = NOT is_active WHERE id = $1 RETURNING is_active',
      [userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({ 
      success: true, 
      isActive: result.rows[0].is_active 
    });
  } catch (error) {
    console.error('Toggle user status error:', error);
    res.status(500).json({ error: 'Failed to update user status' });
  }
});

// Update user KYC level
router.post('/users/:userId/kyc', authMiddleware, adminAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const { kycLevel } = req.body;
    
    if (![0, 1, 2, 3].includes(kycLevel)) {
      return res.status(400).json({ error: 'Invalid KYC level' });
    }
    
    const result = await pool.query(
      'UPDATE users SET kyc_level = $1 WHERE id = $2 RETURNING kyc_level',
      [kycLevel, userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({ 
      success: true, 
      kycLevel: result.rows[0].kyc_level 
    });
  } catch (error) {
    console.error('Update KYC error:', error);
    res.status(500).json({ error: 'Failed to update KYC level' });
  }
});

// Get system health
router.get('/health', authMiddleware, adminAuth, async (req, res) => {
  try {
    // Check database connection
    await pool.query('SELECT 1');
    
    // Get system metrics
    const health = {
      status: 'healthy',
      database: 'connected',
      timestamp: new Date(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      environment: process.env.NODE_ENV
    };
    
    res.json(health);
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});

module.exports = router;
