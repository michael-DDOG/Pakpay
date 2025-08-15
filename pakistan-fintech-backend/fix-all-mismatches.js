// backend/fix-all-mismatches.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');

console.log('🔧 PAKPAY BACKEND FIX SCRIPT\n');
console.log('This script will update all your models and routes to match the new database schema.\n');

// Fix 1: Update User.js model
const userModelFix = `const db = require('../config/database');
const bcrypt = require('bcryptjs');

class User {
  static async create(userData) {
    const { phone, cnic, pin, name, email } = userData;
    
    const hashedPin = await bcrypt.hash(pin, parseInt(process.env.BCRYPT_ROUNDS || 10));
    
    const query = \`
      INSERT INTO users (phone, cnic, pin, name, email)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, phone, cnic, name, email, kyc_level, is_active, created_at
    \`;
    
    const values = [phone, cnic, hashedPin, name, email];
    const result = await db.query(query, values);
    
    return result.rows[0];
  }
  
  static async findByPhone(phone) {
    const query = 'SELECT * FROM users WHERE phone = $1 AND is_active = true';
    const result = await db.query(query, [phone]);
    return result.rows[0];
  }
  
  static async findById(id) {
    const query = 'SELECT * FROM users WHERE id = $1 AND is_active = true';
    const result = await db.query(query, [id]);
    return result.rows[0];
  }
  
  static async verifyPassword(pin, hashedPin) {
    return bcrypt.compare(pin, hashedPin);
  }
}

module.exports = User;`;

// Fix 2: Update Wallet.js to use accounts table
const walletModelFix = `const db = require('../config/database');

class Wallet {
  static async create(userId) {
    const query = \`
      INSERT INTO accounts (user_id, account_type, balance, currency, status)
      VALUES ($1, 'customer_wallet', 0, 'PKR', 'active')
      RETURNING id, user_id, balance, currency, status, created_at
    \`;
    
    const result = await db.query(query, [userId]);
    return result.rows[0];
  }
  
  static async findByUserId(userId) {
    const query = 'SELECT * FROM accounts WHERE user_id = $1';
    const result = await db.query(query, [userId]);
    return result.rows[0];
  }
  
  static async getBalance(accountId) {
    const query = 'SELECT balance, currency, status FROM accounts WHERE id = $1';
    const result = await db.query(query, [accountId]);
    return result.rows[0];
  }
  
  static async updateBalance(client, accountId, amount, operation = 'add') {
    const query = operation === 'add' 
      ? 'UPDATE accounts SET balance = balance + $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = \\'active\\' RETURNING balance'
      : 'UPDATE accounts SET balance = balance - $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = \\'active\\' AND balance >= $2 RETURNING balance';
    
    const result = await client.query(query, [accountId, amount]);
    return result.rows[0];
  }
}

module.exports = Wallet;`;

// Fix 3: Update validation.js
const validationFix = `const Joi = require('joi');

const validateRequest = (schema) => {
  return (req, res, next) => {
    const { error } = schema.validate(req.body);
    
    if (error) {
      return res.status(400).json({
        error: 'Validation failed',
        details: error.details.map(d => d.message)
      });
    }
    
    next();
  };
};

// Pakistan phone number format
const phoneRegex = /^((\+92)|(0092)|(0))(3)([0-9]{9})$/;
// Pakistan CNIC format
const cnicRegex = /^[0-9]{5}-[0-9]{7}-[0-9]$/;

const schemas = {
  register: Joi.object({
    phone: Joi.string().pattern(phoneRegex).required(),
    cnic: Joi.string().pattern(cnicRegex).required(),
    pin: Joi.string().min(4).max(6).required(),
    name: Joi.string().min(2).max(200).required(),
    email: Joi.string().email().optional()
  }),
  
  login: Joi.object({
    phone: Joi.string().pattern(phoneRegex).required(),
    pin: Joi.string().required()
  }),
  
  transfer: Joi.object({
    recipientPhone: Joi.string().pattern(phoneRegex).required(),
    amount: Joi.number().positive().min(10).max(100000).required(),
    description: Joi.string().max(255).optional()
  })
};

module.exports = { validateRequest, schemas };`;

// Fix 4: Update auth.js routes
const authRoutesFix = `const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const { validateRequest, schemas } = require('../middleware/validation');
const db = require('../config/database');
const logger = require('../utils/logger');

const router = express.Router();

// Register new user
router.post('/register', validateRequest(schemas.register), async (req, res) => {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');
    
    // Check if user already exists
    const existingUser = await User.findByPhone(req.body.phone);
    if (existingUser) {
      return res.status(409).json({ error: 'User already exists with this phone number' });
    }
    
    // Create user
    const user = await User.create(req.body);
    
    // Create account (wallet) for user
    const wallet = await Wallet.create(user.id);
    
    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id, phone: user.phone },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE }
    );
    
    await client.query('COMMIT');
    
    res.status(201).json({
      message: 'User registered successfully',
      user: {
        id: user.id,
        phone: user.phone,
        name: user.name,
        kycLevel: user.kyc_level
      },
      wallet: {
        id: wallet.id,
        balance: wallet.balance,
        currency: wallet.currency
      },
      token
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  } finally {
    client.release();
  }
});

// Login
router.post('/login', validateRequest(schemas.login), async (req, res) => {
  try {
    const { phone, pin } = req.body;
    
    // Find user
    const user = await User.findByPhone(phone);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Verify PIN
    const isPinValid = await User.verifyPassword(pin, user.pin);
    if (!isPinValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Get wallet (account)
    const wallet = await Wallet.findByUserId(user.id);
    
    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id, phone: user.phone },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE || '7d' }
    );
    
    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        phone: user.phone,
        name: user.name,
        kycLevel: user.kyc_level
      },
      wallet: {
        id: wallet.id,
        balance: wallet.balance,
        currency: wallet.currency
      },
      token
    });
    
  } catch (error) {
    logger.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

module.exports = router;`;

// Write the fixes
try {
  console.log('📝 Writing fixes...\n');
  
  // Backup originals
  const backupDir = path.join(__dirname, 'backup');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir);
  }
  
  // Fix User model
  if (fs.existsSync('models/User.js')) {
    fs.copyFileSync('models/User.js', 'backup/User.js.bak');
    fs.writeFileSync('models/User.js', userModelFix);
    console.log('✅ Fixed models/User.js');
  }
  
  // Fix Wallet model
  if (fs.existsSync('models/Wallet.js')) {
    fs.copyFileSync('models/Wallet.js', 'backup/Wallet.js.bak');
    fs.writeFileSync('models/Wallet.js', walletModelFix);
    console.log('✅ Fixed models/Wallet.js');
  }
  
  // Fix validation
  if (fs.existsSync('middleware/validation.js')) {
    fs.copyFileSync('middleware/validation.js', 'backup/validation.js.bak');
    fs.writeFileSync('middleware/validation.js', validationFix);
    console.log('✅ Fixed middleware/validation.js');
  }
  
  // Fix auth routes
  if (fs.existsSync('routes/auth.js')) {
    fs.copyFileSync('routes/auth.js', 'backup/auth.js.bak');
    fs.writeFileSync('routes/auth.js', authRoutesFix);
    console.log('✅ Fixed routes/auth.js');
  }
  
  console.log('\n✅ All files fixed successfully!');
  console.log('📁 Backups saved in ./backup folder\n');
  console.log('Now you can test login with:');
  console.log('  Phone: 03001234567');
  console.log('  PIN: 1234\n');
  
} catch (error) {
  console.error('❌ Error:', error);
}
