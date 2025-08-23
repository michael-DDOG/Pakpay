// services/splitBillService.js
const pool = require('../config/database');
const { v4: uuidv4 } = require('uuid');

class SplitBillService {
  // Create split bill
  static async createSplitBill(creatorId, billData) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      const {
        title,
        totalAmount,
        participants, // Array of { phone, amount, name }
        description,
        category
      } = billData;
      
      // Generate split ID
      const splitId = `SPLIT${Date.now()}${uuidv4().substring(0, 8).toUpperCase()}`;
      
      // Get creator details
      const creatorQuery = 'SELECT name, phone FROM users WHERE id = $1';
      const creatorResult = await client.query(creatorQuery, [creatorId]);
      const creator = creatorResult.rows[0];
      
      // Create split bill
      const billQuery = `
        INSERT INTO split_bills (
          split_id, creator_id, title, total_amount,
          description, category, status, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, 'active', CURRENT_TIMESTAMP)
        RETURNING *
      `;
      
      const billResult = await client.query(billQuery, [
        splitId,
        creatorId,
        title,
        totalAmount,
        description,
        category || 'general'
      ]);
      
      // Add participants
      for (const participant of participants) {
        // Get participant user ID if exists
        const userQuery = 'SELECT id, name FROM users WHERE phone = $1';
        const userResult = await client.query(userQuery, [participant.phone]);
        
        const participantUserId = userResult.rows.length > 0 ? userResult.rows[0].id : null;
        const participantName = userResult.rows.length > 0 
          ? userResult.rows[0].name 
          : participant.name;
        
        await client.query(
          `INSERT INTO split_participants (
            split_id, user_id, phone, name, amount_owed,
            status, created_at
          ) VALUES ($1, $2, $3, $4, $5, 'pending', CURRENT_TIMESTAMP)`,
          [
            splitId,
            participantUserId,
            participant.phone,
            participantName || participant.phone,
            participant.amount
          ]
        );
        
        // Send notification if user exists
        if (participantUserId) {
          // Would integrate with notification service
          console.log(`Notify user ${participantUserId} about split bill`);
        }
      }
      
      // Add creator as participant (paid)
      await client.query(
        `INSERT INTO split_participants (
          split_id, user_id, phone, name, amount_owed,
          status, paid_at, created_at
        ) VALUES ($1, $2, $3, $4, $5, 'paid', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          splitId,
          creatorId,
          creator.phone,
          creator.name,
          0 // Creator already paid
        ]
      );
      
      await client.query('COMMIT');
      
      return {
        success: true,
        splitBill: billResult.rows[0],
        splitId
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Pay split share
  static async payShare(splitId, payerId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Get participant details
      const participantQuery = `
        SELECT sp.*, sb.creator_id, sb.title
        FROM split_participants sp
        JOIN split_bills sb ON sb.split_id = sp.split_id
        WHERE sp.split_id = $1 AND sp.user_id = $2 AND sp.status = 'pending'
      `;
      
      const participantResult = await client.query(participantQuery, [splitId, payerId]);
      
      if (participantResult.rows.length === 0) {
        throw new Error('Split bill not found or already paid');
      }
      
      const participant = participantResult.rows[0];
      const amount = parseFloat(participant.amount_owed);
      const creatorId = participant.creator_id;
      
      // Check payer balance
      const balanceQuery = 'SELECT balance FROM accounts WHERE user_id = $1';
      const balanceResult = await client.query(balanceQuery, [payerId]);
      
      if (balanceResult.rows.length === 0) {
        throw new Error('Account not found');
      }
      
      const balance = parseFloat(balanceResult.rows[0].balance);
      
      if (balance < amount) {
        throw new Error('Insufficient balance');
      }
      
      // Get creator and payer names
      const namesQuery = `
        SELECT 
          (SELECT name FROM users WHERE id = $1) as payer_name,
          (SELECT name FROM users WHERE id = $2) as creator_name,
          (SELECT phone FROM users WHERE id = $1) as payer_phone,
          (SELECT phone FROM users WHERE id = $2) as creator_phone
      `;
      const namesResult = await client.query(namesQuery, [payerId, creatorId]);
      const names = namesResult.rows[0];
      
      // Generate transaction reference
      const transactionRef = `SPLITPAY${Date.now()}${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
      
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
          payerId,
          amount,
          balance - amount,
          `Split bill payment: ${participant.title}`,
          transactionRef,
          JSON.stringify({
            type: 'split_payment',
            split_id: splitId,
            sender_phone: names.payer_phone,
            receiver_phone: names.creator_phone
          }),
          creatorId,
          `Split bill collection: ${participant.title}`,
          JSON.stringify({
            type: 'split_collection',
            split_id: splitId,
            sender_phone: names.payer_phone,
            receiver_phone: names.creator_phone
          })
        ]
      );
      
      // Update account balances
      await client.query(
        'UPDATE accounts SET balance = balance - $1 WHERE user_id = $2',
        [amount, payerId]
      );
      
      await client.query(
        'UPDATE accounts SET balance = balance + $1 WHERE user_id = $2',
        [amount, creatorId]
      );
      
      // Update participant status
      await client.query(
        `UPDATE split_participants 
         SET status = 'paid', 
             paid_at = CURRENT_TIMESTAMP,
             transaction_ref = $1
         WHERE split_id = $2 AND user_id = $3`,
        [transactionRef, splitId, payerId]
      );
      
      // Check if all participants have paid
      const pendingQuery = `
        SELECT COUNT(*) as pending_count
        FROM split_participants
        WHERE split_id = $1 AND status = 'pending'
      `;
      const pendingResult = await client.query(pendingQuery, [splitId]);
      
      if (parseInt(pendingResult.rows[0].pending_count) === 0) {
        // All paid, mark split as settled
        await client.query(
          `UPDATE split_bills 
           SET status = 'settled', settled_at = CURRENT_TIMESTAMP
           WHERE split_id = $1`,
          [splitId]
        );
      }
      
      await client.query('COMMIT');
      
      return {
        success: true,
        transactionRef,
        message: 'Split bill payment successful'
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Get user's split bills
  static async getUserSplitBills(userId) {
    try {
      // Get bills created by user
      const createdQuery = `
        SELECT 
          sb.*,
          (
            SELECT COUNT(*) 
            FROM split_participants 
            WHERE split_id = sb.split_id AND status = 'paid'
          ) as paid_count,
          (
            SELECT COUNT(*) 
            FROM split_participants 
            WHERE split_id = sb.split_id
          ) as total_participants,
          (
            SELECT COALESCE(SUM(amount_owed), 0)
            FROM split_participants
            WHERE split_id = sb.split_id AND status = 'paid'
          ) as amount_collected
        FROM split_bills sb
        WHERE sb.creator_id = $1
        ORDER BY sb.created_at DESC
      `;
      
      // Get bills where user is participant
      const participantQuery = `
        SELECT 
          sb.*,
          sp.amount_owed,
          sp.status as my_status,
          sp.paid_at,
          u.name as creator_name,
          u.phone as creator_phone
        FROM split_bills sb
        JOIN split_participants sp ON sp.split_id = sb.split_id
        JOIN users u ON u.id = sb.creator_id
        WHERE sp.user_id = $1 AND sb.creator_id != $1
        ORDER BY sb.created_at DESC
      `;
      
      const [createdResult, participantResult] = await Promise.all([
        pool.query(createdQuery, [userId]),
        pool.query(participantQuery, [userId])
      ]);
      
      return {
        created: createdResult.rows,
        participating: participantResult.rows
      };
      
    } catch (error) {
      console.error('Get split bills error:', error);
      throw error;
    }
  }

  // Get split bill details
  static async getSplitBillDetails(splitId, userId) {
    const client = await pool.connect();
    try {
      // Get bill details
      const billQuery = `
        SELECT sb.*, u.name as creator_name, u.phone as creator_phone
        FROM split_bills sb
        JOIN users u ON u.id = sb.creator_id
        WHERE sb.split_id = $1
      `;
      const billResult = await client.query(billQuery, [splitId]);
      
      if (billResult.rows.length === 0) {
        throw new Error('Split bill not found');
      }
      
      // Get participants
      const participantsQuery = `
        SELECT * FROM split_participants
        WHERE split_id = $1
        ORDER BY status DESC, created_at
      `;
      const participantsResult = await client.query(participantsQuery, [splitId]);
      
      // Check user's role
      const bill = billResult.rows[0];
      const isCreator = bill.creator_id === userId;
      const participant = participantsResult.rows.find(p => p.user_id === userId);
      
      return {
        bill: billResult.rows[0],
        participants: participantsResult.rows,
        userRole: {
          isCreator,
          isParticipant: !!participant,
          hasPaid: participant?.status === 'paid',
          amountOwed: participant?.amount_owed || 0
        }
      };
      
    } finally {
      client.release();
    }
  }

  // Send reminder
  static async sendReminder(splitId, creatorId, participantPhone) {
    try {
      // Verify creator owns the split
      const verifyQuery = `
        SELECT title FROM split_bills 
        WHERE split_id = $1 AND creator_id = $2
      `;
      const verifyResult = await pool.query(verifyQuery, [splitId, creatorId]);
      
      if (verifyResult.rows.length === 0) {
        throw new Error('Unauthorized');
      }
      
      // Update reminder count
      await pool.query(
        `UPDATE split_participants 
         SET reminder_count = COALESCE(reminder_count, 0) + 1,
             last_reminder_at = CURRENT_TIMESTAMP
         WHERE split_id = $1 AND phone = $2 AND status = 'pending'`,
        [splitId, participantPhone]
      );
      
      // Would integrate with notification service
      console.log(`Reminder sent for split ${splitId} to ${participantPhone}`);
      
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

module.exports = SplitBillService;
