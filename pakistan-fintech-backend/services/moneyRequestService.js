// services/moneyRequestService.js
const pool = require('../config/database');
const { v4: uuidv4 } = require('uuid');

class MoneyRequestService {
  // Create a money request
  static async createRequest(requesterId, requestFromPhone, amount, description = '') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Get requester details
      const requesterQuery = `
        SELECT id, name, phone 
        FROM users 
        WHERE id = $1
      `;
      const requesterResult = await client.query(requesterQuery, [requesterId]);
      
      if (requesterResult.rows.length === 0) {
        throw new Error('Requester not found');
      }
      
      const requester = requesterResult.rows[0];
      
      // Get requested user details
      const requestedQuery = `
        SELECT id, name, phone 
        FROM users 
        WHERE phone = $1
      `;
      const requestedResult = await client.query(requestedQuery, [requestFromPhone]);
      
      if (requestedResult.rows.length === 0) {
        throw new Error('Requested user not found');
      }
      
      const requestedUser = requestedResult.rows[0];
      
      // Check if requesting from self
      if (requesterId === requestedUser.id) {
        throw new Error('Cannot request money from yourself');
      }
      
      // Generate request ID
      const requestId = `REQ${Date.now()}${uuidv4().substring(0, 8).toUpperCase()}`;
      
      // Create money request
      const insertQuery = `
        INSERT INTO money_requests (
          request_id, requester_id, requested_from_id, 
          amount, description, status, created_at, expires_at
        ) VALUES ($1, $2, $3, $4, $5, 'pending', CURRENT_TIMESTAMP, $6)
        RETURNING *
      `;
      
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
      
      const result = await client.query(insertQuery, [
        requestId,
        requesterId,
        requestedUser.id,
        amount,
        description || `Money request from ${requester.name}`,
        expiresAt
      ]);
      
      await client.query('COMMIT');
      
      return {
        success: true,
        request: {
          requestId,
          requesterName: requester.name,
          requesterPhone: requester.phone,
          requestedFromName: requestedUser.name,
          requestedFromPhone: requestedUser.phone,
          amount,
          description,
          status: 'pending',
          expiresAt
        }
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Create request error:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  // Get pending requests (requests TO the user)
  static async getPendingRequests(userId) {
    try {
      const query = `
        SELECT 
          mr.*,
          requester.name as requester_name,
          requester.phone as requester_phone,
          requested.name as requested_name,
          requested.phone as requested_phone
        FROM money_requests mr
        JOIN users requester ON requester.id = mr.requester_id
        JOIN users requested ON requested.id = mr.requested_from_id
        WHERE mr.requested_from_id = $1 
          AND mr.status = 'pending'
          AND mr.expires_at > CURRENT_TIMESTAMP
        ORDER BY mr.created_at DESC
      `;
      
      const result = await pool.query(query, [userId]);
      return result.rows;
      
    } catch (error) {
      console.error('Get pending requests error:', error);
      throw error;
    }
  }

  // Get sent requests (requests FROM the user)
  static async getSentRequests(userId) {
    try {
      const query = `
        SELECT 
          mr.*,
          requester.name as requester_name,
          requester.phone as requester_phone,
          requested.name as requested_name,
          requested.phone as requested_phone
        FROM money_requests mr
        JOIN users requester ON requester.id = mr.requester_id
        JOIN users requested ON requested.id = mr.requested_from_id
        WHERE mr.requester_id = $1
        ORDER BY mr.created_at DESC
        LIMIT 50
      `;
      
      const result = await pool.query(query, [userId]);
      return result.rows;
      
    } catch (error) {
      console.error('Get sent requests error:', error);
      throw error;
    }
  }

  // Approve money request
  static async approveRequest(requestId, approverId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Get request details
      const requestQuery = `
        SELECT mr.*, 
               requester.name as requester_name,
               requester.phone as requester_phone
        FROM money_requests mr
        JOIN users requester ON requester.id = mr.requester_id
        WHERE mr.request_id = $1 
          AND mr.requested_from_id = $2
          AND mr.status = 'pending'
          AND mr.expires_at > CURRENT_TIMESTAMP
      `;
      
      const requestResult = await client.query(requestQuery, [requestId, approverId]);
      
      if (requestResult.rows.length === 0) {
        throw new Error('Request not found or expired');
      }
      
      const request = requestResult.rows[0];
      const amount = parseFloat(request.amount);
      
      // Check approver balance
      const balanceQuery = `
        SELECT balance 
        FROM accounts 
        WHERE user_id = $1
      `;
      const balanceResult = await client.query(balanceQuery, [approverId]);
      
      if (balanceResult.rows.length === 0) {
        throw new Error('Account not found');
      }
      
      const balance = parseFloat(balanceResult.rows[0].balance);
      
      if (balance < amount) {
        throw new Error('Insufficient balance');
      }
      
      // Get approver details
      const approverQuery = `
        SELECT name, phone 
        FROM users 
        WHERE id = $1
      `;
      const approverResult = await client.query(approverQuery, [approverId]);
      const approver = approverResult.rows[0];
      
      // Generate transaction reference
      const transactionRef = `REQPAY${Date.now()}${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
      
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
          approverId,
          amount,
          balance - amount,
          `Request payment to ${request.requester_name}`,
          transactionRef,
          JSON.stringify({
            type: 'request_payment',
            request_id: requestId,
            sender_phone: approver.phone,
            receiver_phone: request.requester_phone
          }),
          request.requester_id,
          `Request payment from ${approver.name}`,
          JSON.stringify({
            type: 'request_payment',
            request_id: requestId,
            sender_phone: approver.phone,
            receiver_phone: request.requester_phone
          })
        ]
      );
      
      // Update account balances
      await client.query(
        'UPDATE accounts SET balance = balance - $1 WHERE user_id = $2',
        [amount, approverId]
      );
      
      await client.query(
        'UPDATE accounts SET balance = balance + $1 WHERE user_id = $2',
        [amount, request.requester_id]
      );
      
      // Update request status
      await client.query(
        `UPDATE money_requests 
         SET status = 'approved', 
             approved_at = CURRENT_TIMESTAMP,
             transaction_ref = $1
         WHERE request_id = $2`,
        [transactionRef, requestId]
      );
      
      await client.query('COMMIT');
      
      return {
        success: true,
        transactionRef,
        amount,
        requesterName: request.requester_name
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Approve request error:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  // Decline money request
  static async declineRequest(requestId, declinerId, reason = '') {
    try {
      const query = `
        UPDATE money_requests 
        SET status = 'declined', 
            declined_at = CURRENT_TIMESTAMP,
            decline_reason = $1
        WHERE request_id = $2 
          AND requested_from_id = $3
          AND status = 'pending'
        RETURNING *
      `;
      
      const result = await pool.query(query, [reason, requestId, declinerId]);
      
      if (result.rows.length === 0) {
        throw new Error('Request not found or already processed');
      }
      
      return {
        success: true,
        message: 'Request declined successfully'
      };
      
    } catch (error) {
      console.error('Decline request error:', error);
      throw error;
    }
  }

  // Cancel money request (by requester)
  static async cancelRequest(requestId, requesterId) {
    try {
      const query = `
        UPDATE money_requests 
        SET status = 'cancelled', 
            cancelled_at = CURRENT_TIMESTAMP
        WHERE request_id = $1 
          AND requester_id = $2
          AND status = 'pending'
        RETURNING *
      `;
      
      const result = await pool.query(query, [requestId, requesterId]);
      
      if (result.rows.length === 0) {
        throw new Error('Request not found or already processed');
      }
      
      return {
        success: true,
        message: 'Request cancelled successfully'
      };
      
    } catch (error) {
      console.error('Cancel request error:', error);
      throw error;
    }
  }

  // Send reminder for pending request
  static async sendReminder(requestId, requesterId) {
    try {
      const query = `
        UPDATE money_requests 
        SET last_reminder_at = CURRENT_TIMESTAMP,
            reminder_count = COALESCE(reminder_count, 0) + 1
        WHERE request_id = $1 
          AND requester_id = $2
          AND status = 'pending'
          AND expires_at > CURRENT_TIMESTAMP
        RETURNING *
      `;
      
      const result = await pool.query(query, [requestId, requesterId]);
      
      if (result.rows.length === 0) {
        throw new Error('Request not found or expired');
      }
      
      // Here you would send actual notification/SMS
      
      return {
        success: true,
        message: 'Reminder sent successfully'
      };
      
    } catch (error) {
      console.error('Send reminder error:', error);
      throw error;
    }
  }
}

module.exports = MoneyRequestService;
