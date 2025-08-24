// services/sanctionsScreeningService.js
const axios = require('axios');
const pool = require('../config/database');

class SanctionsScreeningService {
  constructor() {
    this.screeningAPIs = {
      un: process.env.UN_SANCTIONS_API,
      fatf: process.env.FATF_API,
      nacta: process.env.NACTA_API,
      local_pep: process.env.LOCAL_PEP_API
    };
  }

  // Comprehensive screening
  async screenCustomer(customerData) {
    const screeningResults = {
      timestamp: new Date(),
      customer: {
        name: customerData.name,
        cnic: customerData.cnic,
        dateOfBirth: customerData.dateOfBirth
      },
      results: []
    };

    try {
      // 1. UN Sanctions List Check
      const unCheck = await this.checkUNSanctions(customerData);
      screeningResults.results.push({
        source: 'UN_SANCTIONS',
        matched: unCheck.matched,
        matchScore: unCheck.score,
        details: unCheck.details
      });

      // 2. FATF Grey/Black List Check
      const fatfCheck = await this.checkFATF(customerData);
      screeningResults.results.push({
        source: 'FATF',
        matched: fatfCheck.matched,
        details: fatfCheck.details
      });

      // 3. NACTA Proscribed Persons Check
      const nactaCheck = await this.checkNACTA(customerData);
      screeningResults.results.push({
        source: 'NACTA',
        matched: nactaCheck.matched,
        details: nactaCheck.details
      });

      // 4. PEP (Politically Exposed Persons) Check
      const pepCheck = await this.checkPEP(customerData);
      screeningResults.results.push({
        source: 'PEP',
        matched: pepCheck.matched,
        isPEP: pepCheck.isPEP,
        pepLevel: pepCheck.level,
        details: pepCheck.details
      });

      // 5. Adverse Media Check
      const adverseMediaCheck = await this.checkAdverseMedia(customerData);
      screeningResults.results.push({
        source: 'ADVERSE_MEDIA',
        matched: adverseMediaCheck.matched,
        details: adverseMediaCheck.details
      });

      // Calculate overall risk score
      const riskScore = this.calculateRiskScore(screeningResults.results);
      screeningResults.overallRisk = riskScore;

      // Save screening results
      await this.saveScreeningResults(customerData.cnic, screeningResults);

      // Determine if customer can be onboarded
      const decision = this.makeOnboardingDecision(screeningResults);

      return {
        cleared: decision.approved,
        riskScore: riskScore,
        requiresEnhancedDueDiligence: decision.requiresEDD,
        screeningId: screeningResults.screeningId,
        results: screeningResults
      };

    } catch (error) {
      console.error('Screening error:', error);
      throw new Error('Sanctions screening failed');
    }
  }

  // Check UN Sanctions List
  async checkUNSanctions(customerData) {
    try {
      // In production, integrate with actual UN API
      // For now, check against local database
      const query = `
        SELECT * FROM un_sanctions_list 
        WHERE LOWER(full_name) LIKE LOWER($1)
        OR alternate_names @> ARRAY[$2]
      `;
      
      const result = await pool.query(query, [
        `%${customerData.name}%`,
        customerData.name
      ]);

      if (result.rows.length > 0) {
        return {
          matched: true,
          score: this.calculateMatchScore(customerData.name, result.rows[0].full_name),
          details: result.rows[0]
        };
      }

      return { matched: false };

    } catch (error) {
      console.error('UN sanctions check error:', error);
      return { matched: false, error: true };
    }
  }

  // Check FATF Lists
  async checkFATF(customerData) {
    try {
      // Check if Pakistan is on grey list affects the customer
      // Check against FATF high-risk jurisdictions
      
      const highRiskCountries = [
        'North Korea', 'Iran', 'Myanmar'
      ];
      
      const greyListCountries = [
        'Pakistan', 'Turkey', 'Jordan', 'Mali', 'South Africa'
      ];

      // Check if customer has connections to high-risk jurisdictions
      const hasHighRiskConnection = false; // Implement actual check

      return {
        matched: hasHighRiskConnection,
        details: {
          highRiskJurisdiction: hasHighRiskConnection,
          greyListJurisdiction: true // Pakistan is on grey list
        }
      };

    } catch (error) {
      console.error('FATF check error:', error);
      return { matched: false, error: true };
    }
  }

  // Check NACTA Proscribed Persons
  async checkNACTA(customerData) {
    try {
      // Check against NACTA's 4th Schedule list
      const query = `
        SELECT * FROM nacta_proscribed_persons 
        WHERE cnic = $1 
        OR LOWER(name) LIKE LOWER($2)
      `;
      
      const result = await pool.query(query, [
        customerData.cnic,
        `%${customerData.name}%`
      ]);

      if (result.rows.length > 0) {
        return {
          matched: true,
          details: result.rows[0]
        };
      }

      return { matched: false };

    } catch (error) {
      console.error('NACTA check error:', error);
      return { matched: false, error: true };
    }
  }

  // Check PEP Status
  async checkPEP(customerData) {
    try {
      // Check against PEP database
      const query = `
        SELECT * FROM pep_list 
        WHERE cnic = $1 
        OR LOWER(name) LIKE LOWER($2)
      `;
      
      const result = await pool.query(query, [
        customerData.cnic,
        `%${customerData.name}%`
      ]);

      if (result.rows.length > 0) {
        const pep = result.rows[0];
        return {
          matched: true,
          isPEP: true,
          level: pep.pep_level, // 'HIGH', 'MEDIUM', 'LOW'
          details: pep
        };
      }

      // Check family members (for PEP by association)
      const familyCheck = await this.checkPEPFamily(customerData);
      if (familyCheck.isRelated) {
        return {
          matched: true,
          isPEP: false,
          isPEPRelated: true,
          level: 'MEDIUM',
          details: familyCheck
        };
      }

      return { matched: false, isPEP: false };

    } catch (error) {
      console.error('PEP check error:', error);
      return { matched: false, error: true };
    }
  }

  // Check for PEP family relations
  async checkPEPFamily(customerData) {
    // Check if customer is related to any PEP
    // This would check father's name, address, etc.
    return { isRelated: false };
  }

  // Check Adverse Media
  async checkAdverseMedia(customerData) {
    try {
      // In production, integrate with news API or adverse media service
      // Check for negative news about the customer
      
      const keywords = [
        'corruption', 'fraud', 'money laundering', 'terrorist',
        'criminal', 'investigation', 'arrested', 'convicted'
      ];

      // Mock check - replace with actual API
      return { matched: false };

    } catch (error) {
      console.error('Adverse media check error:', error);
      return { matched: false, error: true };
    }
  }

  // Calculate match score for name matching
  calculateMatchScore(name1, name2) {
    // Implement fuzzy matching algorithm
    const n1 = name1.toLowerCase().trim();
    const n2 = name2.toLowerCase().trim();
    
    if (n1 === n2) return 100;
    
    // Levenshtein distance or similar algorithm
    // For now, simple implementation
    const words1 = n1.split(' ');
    const words2 = n2.split(' ');
    
    let matches = 0;
    for (const word of words1) {
      if (words2.includes(word)) matches++;
    }
    
    return Math.round((matches / Math.max(words1.length, words2.length)) * 100);
  }

  // Calculate overall risk score
  calculateRiskScore(results) {
    let score = 0;
    
    for (const result of results) {
      if (result.matched) {
        switch (result.source) {
          case 'UN_SANCTIONS':
            score += 100; // Critical
            break;
          case 'NACTA':
            score += 100; // Critical
            break;
          case 'FATF':
            score += 50; // High
            break;
          case 'PEP':
            score += result.pepLevel === 'HIGH' ? 40 : 20;
            break;
          case 'ADVERSE_MEDIA':
            score += 30;
            break;
        }
      }
    }
    
    return Math.min(score, 100); // Cap at 100
  }

  // Make onboarding decision based on screening
  makeOnboardingDecision(screeningResults) {
    const score = screeningResults.overallRisk;
    
    if (score >= 80) {
      return {
        approved: false,
        reason: 'High risk - Manual review required',
        requiresEDD: true
      };
    } else if (score >= 50) {
      return {
        approved: true,
        requiresEDD: true, // Enhanced Due Diligence required
        restrictions: ['lower_limits', 'frequent_monitoring']
      };
    } else if (score >= 20) {
      return {
        approved: true,
        requiresEDD: false,
        restrictions: ['standard_monitoring']
      };
    } else {
      return {
        approved: true,
        requiresEDD: false,
        restrictions: []
      };
    }
  }

  // Save screening results for audit
  async saveScreeningResults(cnic, results) {
    try {
      const screeningId = `SCREEN${Date.now()}`;
      results.screeningId = screeningId;
      
      await pool.query(
        `INSERT INTO sanctions_screening_logs (
          screening_id, cnic_hash, screening_results, 
          risk_score, created_at
        ) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`,
        [
          screeningId,
          this.hashCNIC(cnic),
          JSON.stringify(results),
          results.overallRisk
        ]
      );
      
      return screeningId;
    } catch (error) {
      console.error('Failed to save screening results:', error);
    }
  }

  // Hash CNIC for privacy
  hashCNIC(cnic) {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(cnic).digest('hex');
  }
}

module.exports = new SanctionsScreeningService();
