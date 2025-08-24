// services/nadraIntegrationService.js
const axios = require('axios');
const crypto = require('crypto');
const pool = require('../config/database');

class NADRAIntegrationService {
  constructor() {
    this.baseURL = process.env.NADRA_API_URL || 'https://api.nadra.gov.pk/v1';
    this.apiKey = process.env.NADRA_API_KEY;
    this.secretKey = process.env.NADRA_SECRET_KEY;
  }

  // Generate NADRA API signature
  generateSignature(data) {
    const hmac = crypto.createHmac('sha256', this.secretKey);
    hmac.update(JSON.stringify(data));
    return hmac.digest('hex');
  }

  // Verify CNIC with NADRA
  async verifyCNIC(cnicNumber, customerData) {
    try {
      const requestData = {
        cnic: cnicNumber,
        name: customerData.name,
        father_name: customerData.fatherName,
        date_of_birth: customerData.dateOfBirth,
        timestamp: Date.now(),
        request_id: `REQ${Date.now()}${Math.random().toString(36).substr(2, 9)}`
      };

      const signature = this.generateSignature(requestData);

      const response = await axios.post(
        `${this.baseURL}/cnic/verify`,
        requestData,
        {
          headers: {
            'X-API-Key': this.apiKey,
            'X-Signature': signature,
            'Content-Type': 'application/json'
          }
        }
      );

      // Log verification attempt
      await this.logVerificationAttempt(cnicNumber, response.data);

      // Check if CNIC is valid and not blacklisted
      if (response.data.status === 'VERIFIED') {
        // Additional checks
        const additionalChecks = await this.performAdditionalChecks(response.data);
        
        return {
          verified: true,
          data: response.data,
          riskFlags: additionalChecks.riskFlags,
          verificationId: response.data.verification_id
        };
      }

      return {
        verified: false,
        reason: response.data.reason || 'Verification failed',
        data: response.data
      };

    } catch (error) {
      console.error('NADRA verification error:', error);
      
      // For development/testing - Remove in production
      if (process.env.NODE_ENV === 'development') {
        return this.mockVerification(cnicNumber, customerData);
      }
      
      throw new Error('CNIC verification service unavailable');
    }
  }

  // Biometric verification (for Level 2 and above)
  async verifyBiometric(cnicNumber, biometricData) {
    try {
      const requestData = {
        cnic: cnicNumber,
        biometric_type: biometricData.type, // 'fingerprint' or 'face'
        biometric_data: biometricData.data, // Base64 encoded
        timestamp: Date.now()
      };

      const signature = this.generateSignature(requestData);

      const response = await axios.post(
        `${this.baseURL}/biometric/verify`,
        requestData,
        {
          headers: {
            'X-API-Key': this.apiKey,
            'X-Signature': signature
          }
        }
      );

      return {
        verified: response.data.match_score > 80, // 80% match threshold
        matchScore: response.data.match_score,
        verificationId: response.data.verification_id
      };

    } catch (error) {
      console.error('Biometric verification error:', error);
      throw new Error('Biometric verification failed');
    }
  }

  // Perform additional compliance checks
  async performAdditionalChecks(nadraData) {
    const riskFlags = [];

    // Check if person is deceased
    if (nadraData.deceased) {
      riskFlags.push({
        type: 'DECEASED',
        severity: 'CRITICAL',
        message: 'CNIC belongs to deceased person'
      });
    }

    // Check age (must be 18+)
    const age = this.calculateAge(nadraData.date_of_birth);
    if (age < 18) {
      riskFlags.push({
        type: 'UNDERAGE',
        severity: 'CRITICAL',
        message: 'Customer is under 18 years of age'
      });
    }

    // Check if CNIC is expired
    if (new Date(nadraData.expiry_date) < new Date()) {
      riskFlags.push({
        type: 'EXPIRED_CNIC',
        severity: 'HIGH',
        message: 'CNIC has expired'
      });
    }

    // Check address for high-risk areas
    const isHighRiskArea = await this.checkHighRiskArea(nadraData.permanent_address);
    if (isHighRiskArea) {
      riskFlags.push({
        type: 'HIGH_RISK_AREA',
        severity: 'MEDIUM',
        message: 'Customer from high-risk geographical area'
      });
    }

    return { riskFlags };
  }

  // Calculate age from date of birth
  calculateAge(dateOfBirth) {
    const today = new Date();
    const birthDate = new Date(dateOfBirth);
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }
    
    return age;
  }

  // Check if address is in high-risk area
  async checkHighRiskArea(address) {
    // Check against list of high-risk areas
    const highRiskAreas = [
      'FATA',
      'North Waziristan',
      'South Waziristan',
      // Add more areas as per SBP guidelines
    ];

    return highRiskAreas.some(area => 
      address.toLowerCase().includes(area.toLowerCase())
    );
  }

  // Log verification attempt for audit
  async logVerificationAttempt(cnic, result) {
    try {
      await pool.query(
        `INSERT INTO nadra_verification_logs (
          cnic_number, verification_result, verification_data, 
          created_at
        ) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
        [
          this.hashCNIC(cnic), // Store hashed CNIC for privacy
          result.status,
          JSON.stringify(result)
        ]
      );
    } catch (error) {
      console.error('Failed to log verification attempt:', error);
    }
  }

  // Hash CNIC for storage
  hashCNIC(cnic) {
    return crypto.createHash('sha256').update(cnic).digest('hex');
  }

  // Mock verification for development
  mockVerification(cnicNumber, customerData) {
    console.warn('Using mock NADRA verification - NOT FOR PRODUCTION');
    
    // Validate CNIC format
    const cnicRegex = /^[0-9]{5}-[0-9]{7}-[0-9]$/;
    if (!cnicRegex.test(cnicNumber)) {
      return {
        verified: false,
        reason: 'Invalid CNIC format'
      };
    }

    return {
      verified: true,
      data: {
        cnic: cnicNumber,
        name: customerData.name,
        father_name: customerData.fatherName || 'Test Father',
        date_of_birth: customerData.dateOfBirth || '1990-01-01',
        permanent_address: 'Test Address, Karachi',
        expiry_date: '2030-12-31',
        verification_id: `MOCK${Date.now()}`
      },
      riskFlags: []
    };
  }
}

module.exports = new NADRAIntegrationService();
