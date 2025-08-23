// services/merchantService.js
const pool = require('../config/database');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');

class MerchantService {
  // Register as merchant
  static async registerMerchant(userId, merchantData) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      const {
        businessName,
        businessType,
        businessAddress,
        businessPhone,
        taxId,
        bankAccount
      } = merchantData;
      
      // Check if already a merchant
      const checkQuery = 'SELECT id FROM merchants WHERE user_id = $1';
      const checkResult = await client.query(checkQuery, [userId]);
      
      if (checkResult.rows.length > 0) {
        throw new Error('User is already registered as a merchant');
      }
      
      // Generate merchant ID
      const merchantId = `MERCH${Date.now()}${uuidv4().substring(0, 8).toUpperCase()}`;
      
      // Create merchant record
      const insertQuery = `
        INSERT INTO merchants (
          merchant_id, user_id, business_name, business_type,
          business_address, business_phone, tax_id, bank_account,
          status, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', CURRENT_TIMESTAMP)
        RETURNING *
      `;
      
      const result = await client.query(insertQuery, [
        merchantId,
        userId,
        businessName,
        businessType,
        businessAddress,
        businessPhone,
        taxId,
        bankAccount
      ]);
      
      // Update user as merchant
      await client.query(
        'UPDATE users SET is_merchant = true WHERE id = $1',
        [userId]
      );
      
      // Generate static QR code for merchant
      const qrPayload = {
        type: 'PAKPAY_MERCHANT',
        version: '1.0',
        data: {
          merchantId,
          businessName,
          merchantPhone: businessPhone
        }
      };
      
      const qrCode = await QRCode.toDataURL(JSON.stringify(qrPayload));
      
      // Save QR code
      await client.query(
        `INSERT INTO merchant_qr_codes (
          merchant_id, qr_data, is_primary, created_at
        ) VALUES ($1, $2, true, CURRENT_TIMESTAMP)`,
        [merchantId, qrCode]
      );
      
      await client.query('COMMIT');
      
      return {
        success: true,
        merchant: result.rows[0],
        qrCode
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Get merchant dashboard data
  static async getMerchantDashboard(userId) {
    const client = await pool.connect();
    try {
      // Get merchant info
      const merchantQuery = `
        SELECT * FROM merchants WHERE user_id = $1
      `;
      const merchantResult = await client.query(merchantQuery, [userId]);
      
      if (merchantResult.rows.length === 0) {
        throw new Error('Merchant not found');
      }
      
      const merchant = merchantResult.rows[0];
      
      // Get today's stats
      const todayStatsQuery = `
        SELECT 
          COUNT(*) as transaction_count,
          COALESCE(SUM(amount), 0) as total_amount,
          COALESCE(AVG(amount), 0) as average_amount
        FROM ledger_entries le
        JOIN accounts a ON a.id = le.account_id
        WHERE a.user_id = $1
          AND le.entry_type = 'credit'
          AND DATE(le.created_at) = CURRENT_DATE
      `;
      const todayStats = await client.query(todayStatsQuery, [userId]);
      
      // Get month stats
      const monthStatsQuery = `
        SELECT 
          COUNT(*) as transaction_count,
          COALESCE(SUM(amount), 0) as total_amount
        FROM ledger_entries le
        JOIN accounts a ON a.id = le.account_id
        WHERE a.user_id = $1
          AND le.entry_type = 'credit'
          AND DATE_TRUNC('month', le.created_at) = DATE_TRUNC('month', CURRENT_DATE)
      `;
      const monthStats = await client.query(monthStatsQuery, [userId]);
      
      // Get recent transactions
      const transactionsQuery = `
        SELECT 
          le.*,
          CASE 
            WHEN le.metadata->>'sender_name' IS NOT NULL 
            THEN le.metadata->>'sender_name'
            ELSE 'Customer'
          END as customer_name
        FROM ledger_entries le
        JOIN accounts a ON a.id = le.account_id
        WHERE a.user_id = $1
          AND le.entry_type = 'credit'
        ORDER BY le.created_at DESC
        LIMIT 10
      `;
      const transactions = await client.query(transactionsQuery, [userId]);
      
      // Get top customers
      const topCustomersQuery = `
        SELECT 
          metadata->>'sender_phone' as customer_phone,
          metadata->>'sender_name' as customer_name,
          COUNT(*) as transaction_count,
          SUM(amount) as total_amount
        FROM ledger_entries le
        JOIN accounts a ON a.id = le.account_id
        WHERE a.user_id = $1
          AND le.entry_type = 'credit'
          AND le.metadata->>'sender_phone' IS NOT NULL
        GROUP BY metadata->>'sender_phone', metadata->>'sender_name'
        ORDER BY total_amount DESC
        LIMIT 5
      `;
      const topCustomers = await client.query(topCustomersQuery, [userId]);
      
      return {
        merchant: merchant,
        todayStats: todayStats.rows[0],
        monthStats: monthStats.rows[0],
        recentTransactions: transactions.rows,
        topCustomers: topCustomers.rows
      };
      
    } finally {
      client.release();
    }
  }

  // Generate settlement report
  static async generateSettlement(merchantId, date) {
    const client = await pool.connect();
    try {
      // Get merchant user_id
      const merchantQuery = 'SELECT user_id FROM merchants WHERE merchant_id = $1';
      const merchantResult = await client.query(merchantQuery, [merchantId]);
      
      if (merchantResult.rows.length === 0) {
        throw new Error('Merchant not found');
      }
      
      const userId = merchantResult.rows[0].user_id;
      
      // Get all transactions for the date
      const transactionsQuery = `
        SELECT 
          le.*,
          CASE 
            WHEN le.metadata->>'sender_name' IS NOT NULL 
            THEN le.metadata->>'sender_name'
            ELSE 'Customer'
          END as customer_name,
          le.metadata->>'sender_phone' as customer_phone
        FROM ledger_entries le
        JOIN accounts a ON a.id = le.account_id
        WHERE a.user_id = $1
          AND le.entry_type = 'credit'
          AND DATE(le.created_at) = $2
        ORDER BY le.created_at
      `;
      
      const transactions = await client.query(transactionsQuery, [userId, date]);
      
      // Calculate totals
      const totalAmount = transactions.rows.reduce(
        (sum, tx) => sum + parseFloat(tx.amount), 
        0
      );
      
      // Generate settlement ID
      const settlementId = `SETTLE${Date.now()}${uuidv4().substring(0, 8).toUpperCase()}`;
      
      // Save settlement record
      await client.query(
        `INSERT INTO merchant_settlements (
          settlement_id, merchant_id, settlement_date,
          transaction_count, total_amount, status,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, 'pending', CURRENT_TIMESTAMP)`,
        [
          settlementId,
          merchantId,
          date,
          transactions.rows.length,
          totalAmount
        ]
      );
      
      return {
        settlementId,
        date,
        transactionCount: transactions.rows.length,
        totalAmount,
        transactions: transactions.rows,
        status: 'pending'
      };
      
    } finally {
      client.release();
    }
  }

  // Process refund
  static async processRefund(merchantId, transactionRef, amount, reason) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Get original transaction
      const txQuery = `
        SELECT le.*, a.user_id
        FROM ledger_entries le
        JOIN accounts a ON a.id = le.account_id
        WHERE le.transaction_ref = $1
          AND le.entry_type = 'credit'
      `;
      const txResult = await client.query(txQuery, [transactionRef]);
      
      if (txResult.rows.length === 0) {
        throw new Error('Transaction not found');
      }
      
      const originalTx = txResult.rows[0];
      const merchantUserId = originalTx.user_id;
      
      // Verify merchant owns this transaction
      const merchantQuery = `
        SELECT * FROM merchants 
        WHERE merchant_id = $1 AND user_id = $2
      `;
      const merchantResult = await client.query(merchantQuery, [merchantId, merchantUserId]);
      
      if (merchantResult.rows.length === 0) {
        throw new Error('Unauthorized');
      }
      
      // Get customer details from metadata
      const customerPhone = originalTx.metadata?.sender_phone;
      if (!customerPhone) {
        throw new Error('Cannot identify customer for refund');
      }
      
      // Get customer user_id
      const customerQuery = 'SELECT id FROM users WHERE phone = $1';
      const customerResult = await client.query(customerQuery, [customerPhone]);
      
      if (customerResult.rows.length === 0) {
        throw new Error('Customer not found');
      }
      
      const customerId = customerResult.rows[0].id;
      
      // Check merchant balance
      const balanceQuery = 'SELECT balance FROM accounts WHERE user_id = $1';
      const balanceResult = await client.query(balanceQuery, [merchantUserId]);
      const merchantBalance = parseFloat(balanceResult.rows[0].balance);
      
      if (merchantBalance < amount) {
        throw new Error('Insufficient balance for refund');
      }
      
      // Generate refund reference
      const refundRef = `REFUND${Date.now()}${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
      
      // Create refund ledger entries
      await client.query(
        `INSERT INTO ledger_entries (
          account_id, entry_type, amount, balance_after, 
          description, transaction_ref, metadata, created_at
        ) VALUES 
        ((SELECT id FROM accounts WHERE user_id = $1), 'debit', $2, $3, $4, $5, $6, CURRENT_TIMESTAMP),
        ((SELECT id FROM accounts WHERE user_id = $7), 'credit', $2, 
         (SELECT balance + $2 FROM accounts WHERE user_id = $7), $8, $5, $9, CURRENT_TIMESTAMP)`,
        [
          merchantUserId,
          amount,
          merchantBalance - amount,
          `Refund for transaction ${transactionRef}`,
          refundRef,
          JSON.stringify({ 
            type: 'refund', 
            original_transaction: transactionRef,
            reason 
          }),
          customerId,
          'Refund received',
          JSON.stringify({ 
            type: 'refund', 
            original_transaction: transactionRef,
            merchant_id: merchantId 
          })
        ]
      );
      
      // Update account balances
      await client.query(
        'UPDATE accounts SET balance = balance - $1 WHERE user_id = $2',
        [amount, merchantUserId]
      );
      
      await client.query(
        'UPDATE accounts SET balance = balance + $1 WHERE user_id = $2',
        [amount, customerId]
      );
      
      // Record refund
      await client.query(
        `INSERT INTO merchant_refunds (
          merchant_id, original_transaction_ref, refund_ref,
          amount, reason, status, created_at
        ) VALUES ($1, $2, $3, $4, $5, 'completed', CURRENT_TIMESTAMP)`,
        [merchantId, transactionRef, refundRef, amount, reason]
      );
      
      await client.query('COMMIT');
      
      return {
        success: true,
        refundRef,
        amount,
        message: 'Refund processed successfully'
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = MerchantService;
