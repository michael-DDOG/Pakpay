// backend/services/billPaymentService.js
const pool = require('../config/database');
const ledgerService = require('./ledgerService');
const { v4: uuidv4 } = require('uuid');

class BillPaymentService {
  constructor() {
    // Define supported billers
    this.billers = {
      // Electricity
      'KE': { name: 'K-Electric', type: 'electricity', active: true },
      'LESCO': { name: 'LESCO', type: 'electricity', active: true },
      'IESCO': { name: 'Islamabad Electric', type: 'electricity', active: true },
      
      // Gas
      'SSGC': { name: 'Sui Southern Gas', type: 'gas', active: true },
      'SNGPL': { name: 'Sui Northern Gas', type: 'gas', active: true },
      
      // Telecom
      'JAZZ': { name: 'Jazz', type: 'mobile', active: true },
      'ZONG': { name: 'Zong', type: 'mobile', active: true },
      'TELENOR': { name: 'Telenor', type: 'mobile', active: true },
      'UFONE': { name: 'Ufone', type: 'mobile', active: true },
      
      // Internet
      'PTCL': { name: 'PTCL', type: 'internet', active: true },
      'NAYATEL': { name: 'Nayatel', type: 'internet', active: true },
      'STORMFIBER': { name: 'StormFiber', type: 'internet', active: true }
    };
  }

  async getBillers(type = null) {
    if (type) {
      return Object.entries(this.billers)
        .filter(([code, biller]) => biller.type === type && biller.active)
        .map(([code, biller]) => ({ code, ...biller }));
    }
    
    return Object.entries(this.billers)
      .filter(([code, biller]) => biller.active)
      .map(([code, biller]) => ({ code, ...biller }));
  }

  async validateBill(billerCode, consumerNumber) {
    // Mock validation - in production, this would call the biller's API
    const biller = this.billers[billerCode];
    if (!biller) {
      throw new Error('Invalid biller');
    }

    // Mock bill data
    const mockBill = {
      consumerNumber,
      billerCode,
      billerName: biller.name,
      billMonth: new Date().toISOString().slice(0, 7),
      dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days from now
      amountDue: Math.floor(Math.random() * 5000) + 1000, // Random amount between 1000-6000
      lateFee: 0,
      status: 'unpaid'
    };

    return mockBill;
  }

  async payBill(userId, billerCode, consumerNumber, amount, billDetails = {}) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Validate biller
      const biller = this.billers[billerCode];
      if (!biller) {
        throw new Error('Invalid biller');
      }

      // Check user balance through ledger
      const balance = await ledgerService.getBalance(userId);
      if (balance.balance < amount) {
        throw new Error('Insufficient balance');
      }

      // Create bill payment record
      const paymentRef = `BILL-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      
      const paymentResult = await client.query(
        `INSERT INTO bill_payments 
         (id, user_id, biller_code, consumer_number, amount, payment_ref, status, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         RETURNING *`,
        [
          uuidv4(),
          userId,
          billerCode,
          consumerNumber,
          amount,
          paymentRef,
          'completed',
          JSON.stringify({
            billerName: biller.name,
            billMonth: billDetails.billMonth,
            ...billDetails
          })
        ]
      );

      // Record in ledger as a withdrawal
      await ledgerService.withdraw(userId, amount, {
        type: 'bill_payment',
        billerCode,
        billerName: biller.name,
        consumerNumber,
        paymentRef
      });

      await client.query('COMMIT');

      return {
        success: true,
        paymentRef,
        payment: paymentResult.rows[0]
      };

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async topupMobile(userId, mobileNumber, operator, amount) {
    // Validate operator
    if (!this.billers[operator] || this.billers[operator].type !== 'mobile') {
      throw new Error('Invalid mobile operator');
    }

    // Process as a bill payment
    return this.payBill(userId, operator, mobileNumber, amount, {
      type: 'mobile_topup',
      mobileNumber
    });
  }

  async getPaymentHistory(userId, limit = 10) {
    const result = await pool.query(
      `SELECT * FROM bill_payments 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT $2`,
      [userId, limit]
    );

    return result.rows;
  }
}

module.exports = new BillPaymentService();
