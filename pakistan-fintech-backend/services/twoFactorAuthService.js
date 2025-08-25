// services/twoFactorAuthService.js
const pool = require('../config/database');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const crypto = require('crypto');
const SMSService = require('./smsService');
const EmailService = require('./emailService');
const redis = require('../config/redis');

class TwoFactorAuthService {
  constructor() {
    this.otpExpiry = 300; // 5 minutes in seconds
    this.maxAttempts = 3;
    this.highValueThreshold = 50000; // PKR threshold for 2FA
  }

  // Check if 2FA is required for transaction
  async isRequired(userId, transactionAmount, transactionType) {
    // Check transaction amount
    if (parseFloat(transactionAmount) >= this.highValueThreshold) {
      return {
        required: true,
        reason: 'high_value_transaction',
        threshold: this.highValueThreshold
      };
    }

    // Check user risk profile
    const riskProfile = await pool.query(
      'SELECT risk_category, enhanced_due_diligence FROM customer_risk_profiles WHERE user_id = $1',
      [userId]
    );

    if (riskProfile.rows[0]?.risk_category === 'HIGH' || 
        riskProfile.rows[0]?.enhanced_due_diligence) {
      return {
        required: true,
        reason: 'high_risk_profile'
      };
    }

    // Check for international transactions
    if (transactionType === 'international' || transactionType === 'remittance') {
      return {
        required: true,
        reason: 'international_transaction'
      };
    }

    // Check for suspicious patterns
    const recentFailures = await this.getRecentFailedAttempts(userId);
    if (recentFailures >= 2) {
      return {
        required: true,
        reason: 'suspicious_activity'
      };
    }

    // Check if user has 2FA enabled voluntarily
    const userSettings = await pool.query(
      'SELECT is_enabled FROM two_factor_auth WHERE user_id = $1',
      [userId]
    );

    if (userSettings.rows[0]?.is_enabled) {
      return {
        required: true,
        reason: 'user_preference'
      };
    }

    return {
      required: false
    };
  }

  // Generate and send OTP
  async generateOTP(userId, method = 'SMS', transactionRef = null) {
    try {
      // Generate 6-digit OTP
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      
      // Get user details
      const user = await pool.query(
        'SELECT phone, email, name FROM users WHERE id = $1',
        [userId]
      );

      if (user.rows.length === 0) {
        throw new Error('User not found');
      }

      const userData = user.rows[0];
      
      // Create OTP hash for storage
      const otpHash = crypto.createHash('sha256').update(otp).digest('hex');
      
      // Store OTP in Redis with expiry
      const otpKey = `otp:${userId}:${transactionRef || 'general'}`;
      await redis.setex(otpKey, this.otpExpiry, JSON.stringify({
        hash: otpHash,
        method,
        attempts: 0,
        generatedAt: new Date().toISOString()
      }));

      // Send OTP based on method
      let sent = false;
      switch (method) {
        case 'SMS':
          sent = await this.sendSMSOTP(userData.phone, otp, userData.name);
          break;
        case 'EMAIL':
          sent = await this.sendEmailOTP(userData.email, otp, userData.name);
          break;
        case 'VOICE':
          sent = await this.sendVoiceOTP(userData.phone, otp);
          break;
        default:
          throw new Error('Invalid OTP method');
      }

      // Log OTP generation
      await this.logOTPGeneration(userId, method, transactionRef);

      return {
        success: sent,
        method,
        expiresIn: this.otpExpiry,
        message: `OTP sent via ${method}`
      };

    } catch (error) {
      console.error('Generate OTP error:', error);
      throw error;
    }
  }

  // Send OTP via SMS
  async sendSMSOTP(phone, otp, name) {
    const message = `Dear ${name}, Your PakPay verification code is: ${otp}. Valid for 5 minutes. Never share this code with anyone.`;
    
    return await SMSService.send(phone, message);
  }

  // Send OTP via Email
  async sendEmailOTP(email, otp, name) {
    if (!email) {
      throw new Error('Email not available for user');
    }

    const subject = 'PakPay Security Code';
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #00A86B;">Security Verification</h2>
        <p>Dear ${name},</p>
        <p>Your verification code is:</p>
        <div style="background: #f0f0f0; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 5px;">
          ${otp}
        </div>
        <p>This code will expire in 5 minutes.</p>
        <p style="color: red;"><strong>Security Notice:</strong> Never share this code with anyone. PakPay staff will never ask for your OTP.</p>
        <hr>
        <p style="font-size: 12px; color: #666;">
          If you didn't request this code, please change your password immediately and contact support.
        </p>
      </div>
    `;

    return await EmailService.send(email, subject, html);
  }

  // Send OTP via Voice Call
  async sendVoiceOTP(phone, otp) {
    // Integrate with voice service provider
    // For now, fallback to SMS
    return await this.sendSMSOTP(phone, otp, 'User');
  }

  // Verify OTP
  async verifyOTP(userId, inputOTP, transactionRef = null) {
    try {
      const otpKey = `otp:${userId}:${transactionRef || 'general'}`;
      const storedData = await redis.get(otpKey);

      if (!storedData) {
        return {
          success: false,
          error: 'OTP expired or not found'
        };
      }

      const otpData = JSON.parse(storedData);

      // Check attempts
      if (otpData.attempts >= this.maxAttempts) {
        await redis.del(otpKey);
        await this.logFailedAttempt(userId, 'max_attempts_exceeded');
        
        return {
          success: false,
          error: 'Maximum attempts exceeded. Please request a new OTP.'
        };
      }

      // Verify OTP
      const inputHash = crypto.createHash('sha256').update(inputOTP).digest('hex');
      
      if (inputHash === otpData.hash) {
        // Success - delete OTP
        await redis.del(otpKey);
        await this.logSuccessfulVerification(userId, transactionRef);
        
        // Generate 2FA token for transaction
        const token = await this.generate2FAToken(userId, transactionRef);
        
        return {
          success: true,
          token,
          message: 'Verification successful'
        };
      } else {
        // Failed attempt
        otpData.attempts++;
        await redis.setex(otpKey, this.otpExpiry, JSON.stringify(otpData));
        await this.logFailedAttempt(userId, 'incorrect_otp');
        
        return {
          success: false,
          error: `Incorrect OTP. ${this.maxAttempts - otpData.attempts} attempts remaining.`
        };
      }

    } catch (error) {
      console.error('Verify OTP error:', error);
      throw error;
    }
  }

  // Setup TOTP (Time-based OTP) for advanced users
  async setupTOTP(userId) {
    try {
      // Generate secret
      const secret = speakeasy.generateSecret({
        name: `PakPay (${userId})`,
        issuer: 'PakPay',
        length: 32
      });

      // Store secret
      await pool.query(
        `INSERT INTO two_factor_auth (user_id, method, secret, is_enabled)
         VALUES ($1, 'TOTP', $2, false)
         ON CONFLICT (user_id) DO UPDATE
         SET method = 'TOTP', secret = $2, updated_at = CURRENT_TIMESTAMP`,
        [userId, secret.base32]
      );

      // Generate QR code
      const qrCodeUrl = await QRCode.toDataURL(secret.otpauth_url);

      return {
        success: true,
        secret: secret.base32,
        qrCode: qrCodeUrl,
        manualEntry: secret.ascii
      };

    } catch (error) {
      console.error('Setup TOTP error:', error);
      throw error;
    }
  }

  // Verify TOTP
  async verifyTOTP(userId, token) {
    try {
      const result = await pool.query(
        'SELECT secret FROM two_factor_auth WHERE user_id = $1 AND method = $2',
        [userId, 'TOTP']
      );

      if (result.rows.length === 0) {
        return { success: false, error: 'TOTP not setup' };
      }

      const verified = speakeasy.totp.verify({
        secret: result.rows[0].secret,
        encoding: 'base32',
        token,
        window: 2 // Allow 2 time steps for clock skew
      });

      if (verified) {
        await this.logSuccessfulVerification(userId, 'TOTP');
      } else {
        await this.logFailedAttempt(userId, 'incorrect_totp');
      }

      return { success: verified };

    } catch (error) {
      console.error('Verify TOTP error:', error);
      throw error;
    }
  }

  // Generate backup codes
  async generateBackupCodes(userId) {
    try {
      const codes = [];
      for (let i = 0; i < 10; i++) {
        codes.push(crypto.randomBytes(4).toString('hex').toUpperCase());
      }

      // Hash codes for storage
      const hashedCodes = codes.map(code => 
        crypto.createHash('sha256').update(code).digest('hex')
      );

      await pool.query(
        'UPDATE two_factor_auth SET backup_codes = $1 WHERE user_id = $2',
        [hashedCodes, userId]
      );

      return {
        success: true,
        codes,
        message: 'Store these codes safely. Each can be used only once.'
      };

    } catch (error) {
      console.error('Generate backup codes error:', error);
      throw error;
    }
  }

  // Generate 2FA token for transaction
  async generate2FAToken(userId, transactionRef) {
    const token = crypto.randomBytes(32).toString('hex');
    const tokenKey = `2fa_token:${token}`;
    
    // Store token with 15 minute expiry
    await redis.setex(tokenKey, 900, JSON.stringify({
      userId,
      transactionRef,
      verifiedAt: new Date().toISOString()
    }));

    return token;
  }

  // Validate 2FA token
  async validate2FAToken(token) {
    const tokenKey = `2fa_token:${token}`;
    const data = await redis.get(tokenKey);
    
    if (!data) {
      return { valid: false };
    }

    const tokenData = JSON.parse(data);
    
    // Delete token after use (one-time use)
    await redis.del(tokenKey);
    
    return {
      valid: true,
      userId: tokenData.userId,
      transactionRef: tokenData.transactionRef
    };
  }

  // Get recent failed attempts
  async getRecentFailedAttempts(userId) {
    const result = await pool.query(
      `SELECT COUNT(*) as count
       FROM security_logs
       WHERE user_id = $1
       AND event_type = '2FA_FAILED'
       AND created_at >= CURRENT_TIMESTAMP - INTERVAL '1 hour'`,
      [userId]
    );

    return parseInt(result.rows[0].count);
  }

  // Log OTP generation
  async logOTPGeneration(userId, method, transactionRef) {
    await pool.query(
      `INSERT INTO security_logs (event_type, user_id, event_data, severity)
       VALUES ('2FA_GENERATED', $1, $2, 'INFO')`,
      [userId, JSON.stringify({ method, transactionRef })]
    );
  }

  // Log successful verification
  async logSuccessfulVerification(userId, transactionRef) {
    await pool.query(
      `INSERT INTO security_logs (event_type, user_id, event_data, severity)
       VALUES ('2FA_SUCCESS', $1, $2, 'INFO')`,
      [userId, JSON.stringify({ transactionRef })]
    );

    // Update last used
    await pool.query(
      'UPDATE two_factor_auth SET last_used = CURRENT_TIMESTAMP WHERE user_id = $1',
      [userId]
    );
  }

  // Log failed attempt
  async logFailedAttempt(userId, reason) {
    await pool.query(
      `INSERT INTO security_logs (event_type, user_id, event_data, severity)
       VALUES ('2FA_FAILED', $1, $2, 'WARNING')`,
      [userId, JSON.stringify({ reason })]
    );
  }
}

module.exports = new TwoFactorAuthService();
