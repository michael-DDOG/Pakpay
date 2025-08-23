// services/qrCodeService.js
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/database');

class QRCodeService {
  // Generate QR code for receiving money
  static async generateReceiveQR(userId, amount = null, description = null) {
    try {
      // Get user details
      const userQuery = `
        SELECT id, name, phone, account_number 
        FROM users 
        WHERE id = $1
      `;
      const userResult = await pool.query(userQuery, [userId]);
      
      if (userResult.rows.length === 0) {
        throw new Error('User not found');
      }
      
      const user = userResult.rows[0];
      
      // Create QR payload
      const qrPayload = {
        type: 'PAKPAY_RECEIVE',
        version: '1.0',
        data: {
          receiverId: user.id,
          receiverPhone: user.phone,
          receiverName: user.name,
          accountNumber: user.account_number,
          amount: amount || null,
          description: description || '',
          qrId: uuidv4(),
          timestamp: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() // 5 minutes
        }
      };
      
      // Generate QR code as base64
      const qrCodeDataURL = await QRCode.toDataURL(JSON.stringify(qrPayload), {
        width: 300,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        },
        errorCorrectionLevel: 'M'
      });
      
      // Store QR code in database for validation
      await pool.query(
        `INSERT INTO qr_codes (
          user_id, qr_id, qr_type, amount, description, 
          payload, expires_at, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)`,
        [
          userId,
          qrPayload.data.qrId,
          'receive',
          amount,
          description,
          JSON.stringify(qrPayload),
          qrPayload.data.expiresAt
        ]
      );
      
      return {
        success: true,
        qrCode: qrCodeDataURL,
        qrId: qrPayload.data.qrId,
        expiresAt: qrPayload.data.expiresAt,
        payload: qrPayload
      };
      
    } catch (error) {
      console.error('Generate QR error:', error);
      throw error;
    }
  }

  // Generate merchant QR code (static)
  static async generateMerchantQR(userId, merchantName, location) {
    try {
      const userQuery = `
        SELECT id, phone, account_number, is_merchant 
        FROM users 
        WHERE id = $1
      `;
      const userResult = await pool.query(userQuery, [userId]);
      
      if (userResult.rows.length === 0) {
        throw new Error('User not found');
      }
      
      const merchant = userResult.rows[0];
      
      // Create merchant QR payload
      const qrPayload = {
        type: 'PAKPAY_MERCHANT',
        version: '1.0',
        data: {
          merchantId: merchant.id,
          merchantPhone: merchant.phone,
          merchantName: merchantName,
          location: location,
          accountNumber: merchant.account_number,
          qrId: `MERCHANT_${merchant.id}_${uuidv4()}`,
          timestamp: new Date().toISOString()
        }
      };
      
      // Generate QR code
      const qrCodeDataURL = await QRCode.toDataURL(JSON.stringify(qrPayload), {
        width: 400,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        },
        errorCorrectionLevel: 'H' // High error correction for printed QRs
      });
      
      // Store merchant QR
      await pool.query(
        `INSERT INTO merchant_qr_codes (
          user_id, qr_id, merchant_name, location, 
          payload, is_active, created_at
        ) VALUES ($1, $2, $3, $4, $5, true, CURRENT_TIMESTAMP)`,
        [
          userId,
          qrPayload.data.qrId,
          merchantName,
          location,
          JSON.stringify(qrPayload)
        ]
      );
      
      return {
        success: true,
        qrCode: qrCodeDataURL,
        qrId: qrPayload.data.qrId,
        merchantName,
        payload: qrPayload
      };
      
    } catch (error) {
      console.error('Generate merchant QR error:', error);
      throw error;
    }
  }

  // Process QR payment
  static async processQRPayment(senderId, qrData, amount = null) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Parse QR data
      const qrPayload = typeof qrData === 'string' ? JSON.parse(qrData) : qrData;
      
      // Validate QR type
      if (!qrPayload.type || !qrPayload.type.startsWith('PAKPAY_')) {
        throw new Error('Invalid QR code');
      }
      
      // Check if QR is expired (for dynamic QRs)
      if (qrPayload.data.expiresAt) {
        const expiryTime = new Date(qrPayload.data.expiresAt);
        if (expiryTime < new Date()) {
          throw new Error('QR code has expired');
        }
      }
      
      // Get receiver details
      let receiverId, receiverPhone, receiverName;
      
      if (qrPayload.type === 'PAKPAY_RECEIVE') {
        receiverId = qrPayload.data.receiverId;
        receiverPhone = qrPayload.data.receiverPhone;
        receiverName = qrPayload.data.receiverName;
        
        // Use QR specified amount if available
        if (qrPayload.data.amount && !amount) {
          amount = qrPayload.data.amount;
        }
      } else if (qrPayload.type === 'PAKPAY_MERCHANT') {
        receiverId = qrPayload.data.merchantId;
        receiverPhone = qrPayload.data.merchantPhone;
        receiverName = qrPayload.data.merchantName;
      }
      
      if (!amount || amount <= 0) {
        throw new Error('Invalid amount');
      }
      
      // Check if sending to self
      if (senderId === receiverId) {
        throw new Error('Cannot pay to yourself');
      }
      
      // Get sender balance
      const senderQuery = `
        SELECT a.balance, u.name, u.phone 
        FROM accounts a 
        JOIN users u ON u.id = a.user_id 
        WHERE a.user_id = $1
      `;
      const senderResult = await client.query(senderQuery, [senderId]);
      
      if (senderResult.rows.length === 0) {
        throw new Error('Sender account not found');
      }
      
      const senderBalance = parseFloat(senderResult.rows[0].balance);
      const senderName = senderResult.rows[0].name;
      const senderPhone = senderResult.rows[0].phone;
      
      if (senderBalance < amount) {
        throw new Error('Insufficient balance');
      }
      
      // Generate transaction reference
      const transactionRef = `QR${Date.now()}${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
      
      // Create ledger entries
      await client.query(
        `INSERT INTO ledger_entries (
          account_id, entry_type, amount, balance_after, 
          description, transaction_ref, metadata, created_at
        ) VALUES 
        ((SELECT id FROM accounts WHERE user_id = $1), 'debit', $2, $3, $4, $5, $6, CURRENT_TIMESTAMP),
        ((SELECT id FROM accounts WHERE user_id = $7), 'credit', $2, 
         (SELECT balance + $2 FROM accounts WHERE user_id = $7), $8, $5, $9, CURRENT_TIMESTAMP)`,
        [
          senderId,
          amount,
          senderBalance - amount,
          `QR Payment to ${receiverName}`,
          transactionRef,
          JSON.stringify({
            type: 'qr_payment',
            qr_type: qrPayload.type,
            qr_id: qrPayload.data.qrId,
            sender_phone: senderPhone,
            receiver_phone: receiverPhone
          }),
          receiverId,
          `QR Payment from ${senderName}`,
          JSON.stringify({
            type: 'qr_payment',
            qr_type: qrPayload.type,
            qr_id: qrPayload.data.qrId,
            sender_phone: senderPhone,
            receiver_phone: receiverPhone
          })
        ]
      );
      
      // Update account balances
      await client.query(
        'UPDATE accounts SET balance = balance - $1 WHERE user_id = $2',
        [amount, senderId]
      );
      
      await client.query(
        'UPDATE accounts SET balance = balance + $1 WHERE user_id = $2',
        [amount, receiverId]
      );
      
      // Mark QR as used (for single-use QRs)
      if (qrPayload.type === 'PAKPAY_RECEIVE') {
        await client.query(
          'UPDATE qr_codes SET is_used = true, used_at = CURRENT_TIMESTAMP WHERE qr_id = $1',
          [qrPayload.data.qrId]
        );
      }
      
      await client.query('COMMIT');
      
      return {
        success: true,
        transactionRef,
        amount,
        receiverName,
        receiverPhone,
        qrType: qrPayload.type
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('QR payment error:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  // Get QR payment history
  static async getQRPaymentHistory(userId, limit = 20) {
    try {
      const query = `
        SELECT 
          le.*,
          CASE 
            WHEN le.entry_type = 'credit' THEN 'received'
            ELSE 'sent'
          END as transaction_type
        FROM ledger_entries le
        WHERE le.account_id = (SELECT id FROM accounts WHERE user_id = $1)
          AND le.metadata->>'type' = 'qr_payment'
        ORDER BY le.created_at DESC
        LIMIT $2
      `;
      
      const result = await pool.query(query, [userId, limit]);
      return result.rows;
      
    } catch (error) {
      console.error('Get QR history error:', error);
      throw error;
    }
  }
}

module.exports = QRCodeService;
