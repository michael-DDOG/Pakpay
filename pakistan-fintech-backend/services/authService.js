const User = require('../models/User');
const Wallet = require('../models/Wallet');
const nadraService = require('./nadraService');
const jwt = require('jsonwebtoken');
const db = require('../config/database');
const logger = require('../utils/logger');
const { getErrorMessage } = require('../utils/errorMessages');

class AuthService {
  async register(userData, language = 'en') {
    const client = await db.getClient();
   
    try {
      await client.query('BEGIN');
     
      const { phoneNumber, cnic, password, firstName, lastName, email } = userData;
     
      // Verify CNIC with NADRA
      const nadraVerification = await nadraService.verifyCNIC(cnic, phoneNumber);
     
      if (!nadraVerification.success) {
        throw new Error(getErrorMessage('cnicNotVerified', language));
      }
     
      // Create user with KYC level from NADRA
      const user = await User.create({
        ...userData,
        kycLevel: nadraVerification.data.kycLevel
      });
     
      // Update user record with NADRA data
      await client.query(
        `UPDATE users
         SET kyc_level = $1, nadra_verified = true, nadra_data = $2
         WHERE id = $3`,
        [nadraVerification.data.kycLevel, JSON.stringify(nadraVerification.data), user.id]
      );
     
      // Create wallet for user
      const wallet = await Wallet.create(user.id);
     
      // Generate JWT token
      const token = jwt.sign(
        {
          userId: user.id,
          phoneNumber: user.phone_number,
          kycLevel: nadraVerification.data.kycLevel
        },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRE }
      );
     
      await client.query('COMMIT');
     
      return {
        user: {
          ...user,
          kycLevel: nadraVerification.data.kycLevel,
          kycLimits: nadraVerification.data.limits
        },
        wallet,
        token
      };
     
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Registration error:', error);
      throw error;
    } finally {
      client.release();
    }
  }
 
  async login(phoneNumber, password, language = 'en') {
    try {
      // Find user
      const user = await User.findByPhone(phoneNumber);
      if (!user) {
        throw new Error(getErrorMessage('invalidCredentials', language));
      }
     
      // Verify password
      const isPasswordValid = await User.verifyPassword(password, user.password_hash);
      if (!isPasswordValid) {
        throw new Error(getErrorMessage('invalidCredentials', language));
      }
     
      // Check if account is locked
      if (!user.is_active) {
        throw new Error(getErrorMessage('accountLocked', language));
      }
     
      // Get wallet
      const wallet = await Wallet.findByUserId(user.id);
     
      // Generate JWT token
      const token = jwt.sign(
        {
          userId: user.id,
          phoneNumber: user.phone_number,
          kycLevel: user.kyc_level
        },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRE }
      );
     
      return {
        user: {
          id: user.id,
          phoneNumber: user.phone_number,
          firstName: user.first_name,
          lastName: user.last_name,
          kycLevel: user.kyc_level
        },
        wallet,
        token
      };
     
    } catch (error) {
      logger.error('Login error:', error);
      throw error;
    }
  }
}

module.exports = new AuthService();
