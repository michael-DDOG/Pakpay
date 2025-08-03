const express = require('express');
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
    const existingUser = await User.findByPhone(req.body.phoneNumber);
    if (existingUser) {
      return res.status(409).json({ error: 'User already exists with this phone number' });
    }
    
    // Create user
    const user = await User.create(req.body);
    
    // Create wallet for user
    const wallet = await Wallet.create(user.id);
    
    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id, phoneNumber: user.phone_number },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE }
    );
    
    await client.query('COMMIT');
    
    res.status(201).json({
      message: 'User registered successfully',
      user: {
        id: user.id,
        phoneNumber: user.phone_number,
        firstName: user.first_name,
        lastName: user.last_name,
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
    const { phoneNumber, password } = req.body;
    
    // Find user
    const user = await User.findByPhone(phoneNumber);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Verify password
    const isPasswordValid = await User.verifyPassword(password, user.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Get wallet
    const wallet = await Wallet.findByUserId(user.id);
    
    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id, phoneNumber: user.phone_number },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE }
    );
    
    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        phoneNumber: user.phone_number,
        firstName: user.first_name,
        lastName: user.last_name,
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

module.exports = router;
