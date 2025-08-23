// services/scheduledTransferService.js
const pool = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');

class ScheduledTransferService {
  static scheduledJobs = new Map();

  // Initialize scheduled jobs on server start
  static async initializeScheduledJobs() {
    try {
      const query = `
        SELECT * FROM scheduled_transfers 
        WHERE status = 'active' 
        AND (next_run_date <= CURRENT_DATE + INTERVAL '1 day' OR recurring = true)
      `;
      
      const result = await pool.query(query);
      
      for (const transfer of result.rows) {
        this.scheduleJob(transfer);
      }
      
      console.log(`Initialized ${result.rows.length} scheduled transfers`);
    } catch (error) {
      console.error('Initialize scheduled jobs error:', error);
    }
  }

  // Create a scheduled transfer
  static async createScheduledTransfer(userId, data) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      const {
        recipientPhone,
        amount,
        description,
        scheduleDate,
        recurring,
        frequency, // daily, weekly, monthly
        endDate
      } = data;

      // Validate recipient
      const recipientQuery = 'SELECT id, name FROM users WHERE phone = $1';
      const recipientResult = await client.query(recipientQuery, [recipientPhone]);
      
      if (recipientResult.rows.length === 0) {
        throw new Error('Recipient not found');
      }
      
      const recipient = recipientResult.rows[0];
      
      // Generate schedule ID
      const scheduleId = `SCH${Date.now()}${uuidv4().substring(0, 8).toUpperCase()}`;
      
      // Create scheduled transfer
      const insertQuery = `
        INSERT INTO scheduled_transfers (
          schedule_id, sender_id, recipient_id, recipient_phone,
          amount, description, schedule_date, next_run_date,
          recurring, frequency, end_date, status, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, 'active', CURRENT_TIMESTAMP)
        RETURNING *
      `;
      
      const result = await client.query(insertQuery, [
        scheduleId,
        userId,
        recipient.id,
        recipientPhone,
        amount,
        description,
        scheduleDate,
        recurring,
        frequency,
        endDate
      ]);
      
      await client.query('COMMIT');
      
      // Schedule the job
      this.scheduleJob(result.rows[0]);
      
      return {
        success: true,
        schedule: result.rows[0]
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Schedule a job
  static scheduleJob(transfer) {
    const { schedule_id, frequency, next_run_date } = transfer;
    
    // Clear existing job if any
    if (this.scheduledJobs.has(schedule_id)) {
      this.scheduledJobs.get(schedule_id).stop();
    }
    
    let cronExpression;
    
    // Determine cron expression based on frequency
    if (!transfer.recurring) {
      // One-time transfer - schedule for specific date/time
      const runDate = new Date(next_run_date);
      cronExpression = `${runDate.getMinutes()} ${runDate.getHours()} ${runDate.getDate()} ${runDate.getMonth() + 1} *`;
    } else {
      switch (frequency) {
        case 'daily':
          cronExpression = '0 9 * * *'; // Every day at 9 AM
          break;
        case 'weekly':
          cronExpression = '0 9 * * 1'; // Every Monday at 9 AM
          break;
        case 'monthly':
          cronExpression = '0 9 1 * *'; // First day of month at 9 AM
          break;
        default:
          return;
      }
    }
    
    // Create cron job
    const job = cron.schedule(cronExpression, async () => {
      await this.executeScheduledTransfer(schedule_id);
    });
    
    this.scheduledJobs.set(schedule_id, job);
  }

  // Execute a scheduled transfer
  static async executeScheduledTransfer(scheduleId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Get transfer details
      const transferQuery = `
        SELECT st.*, 
               sender.name as sender_name,
               recipient.name as recipient_name
        FROM scheduled_transfers st
        JOIN users sender ON sender.id = st.sender_id
        JOIN users recipient ON recipient.id = st.recipient_id
        WHERE st.schedule_id = $1 AND st.status = 'active'
      `;
      
      const transferResult = await client.query(transferQuery, [scheduleId]);
      
      if (transferResult.rows.length === 0) {
        return;
      }
      
      const transfer = transferResult.rows[0];
      
      // Check sender balance
      const balanceQuery = 'SELECT balance FROM accounts WHERE user_id = $1';
      const balanceResult = await client.query(balanceQuery, [transfer.sender_id]);
      
      if (balanceResult.rows.length === 0) {
        throw new Error('Sender account not found');
      }
      
      const balance = parseFloat(balanceResult.rows[0].balance);
      const amount = parseFloat(transfer.amount);
      
      if (balance < amount) {
        // Record failed execution
        await client.query(
          `INSERT INTO scheduled_transfer_logs (
            schedule_id, execution_date, status, error_message
          ) VALUES ($1, CURRENT_TIMESTAMP, 'failed', 'Insufficient balance')`,
          [scheduleId]
        );
        
        await client.query('COMMIT');
        return;
      }
      
      // Generate transaction reference
      const transactionRef = `SCHTX${Date.now()}${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
      
      // Execute transfer (create ledger entries)
      await client.query(
        `INSERT INTO ledger_entries (
          account_id, entry_type, amount, balance_after, 
          description, transaction_ref, metadata, created_at
        ) VALUES 
        ((SELECT id FROM accounts WHERE user_id = $1), 'debit', $2, $3, $4, $5, $6, CURRENT_TIMESTAMP),
        ((SELECT id FROM accounts WHERE user_id = $7), 'credit', $2, 
         (SELECT balance + $2 FROM accounts WHERE user_id = $7), $8, $5, $9, CURRENT_TIMESTAMP)`,
        [
          transfer.sender_id,
          amount,
          balance - amount,
          `Scheduled transfer to ${transfer.recipient_name}`,
          transactionRef,
          JSON.stringify({ type: 'scheduled_transfer', schedule_id: scheduleId }),
          transfer.recipient_id,
          `Scheduled transfer from ${transfer.sender_name}`,
          JSON.stringify({ type: 'scheduled_transfer', schedule_id: scheduleId })
        ]
      );
      
      // Update account balances
      await client.query(
        'UPDATE accounts SET balance = balance - $1 WHERE user_id = $2',
        [amount, transfer.sender_id]
      );
      
      await client.query(
        'UPDATE accounts SET balance = balance + $1 WHERE user_id = $2',
        [amount, transfer.recipient_id]
      );
      
      // Record successful execution
      await client.query(
        `INSERT INTO scheduled_transfer_logs (
          schedule_id, execution_date, status, transaction_ref
        ) VALUES ($1, CURRENT_TIMESTAMP, 'success', $2)`,
        [scheduleId, transactionRef]
      );
      
      // Update next run date or mark as completed
      if (transfer.recurring) {
        let nextDate = new Date(transfer.next_run_date);
        
        switch (transfer.frequency) {
          case 'daily':
            nextDate.setDate(nextDate.getDate() + 1);
            break;
          case 'weekly':
            nextDate.setDate(nextDate.getDate() + 7);
            break;
          case 'monthly':
            nextDate.setMonth(nextDate.getMonth() + 1);
            break;
        }
        
        // Check if past end date
        if (transfer.end_date && nextDate > new Date(transfer.end_date)) {
          await client.query(
            'UPDATE scheduled_transfers SET status = $1 WHERE schedule_id = $2',
            ['completed', scheduleId]
          );
        } else {
          await client.query(
            'UPDATE scheduled_transfers SET next_run_date = $1 WHERE schedule_id = $2',
            [nextDate, scheduleId]
          );
        }
      } else {
        // One-time transfer, mark as completed
        await client.query(
          'UPDATE scheduled_transfers SET status = $1 WHERE schedule_id = $2',
          ['completed', scheduleId]
        );
      }
      
      await client.query('COMMIT');
      
      console.log(`Executed scheduled transfer ${scheduleId} successfully`);
      
    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`Failed to execute scheduled transfer ${scheduleId}:`, error);
      
      // Record error
      try {
        await pool.query(
          `INSERT INTO scheduled_transfer_logs (
            schedule_id, execution_date, status, error_message
          ) VALUES ($1, CURRENT_TIMESTAMP, 'failed', $2)`,
          [scheduleId, error.message]
        );
      } catch (logError) {
        console.error('Failed to log error:', logError);
      }
    } finally {
      client.release();
    }
  }

  // Get user's scheduled transfers
  static async getUserScheduledTransfers(userId) {
    try {
      const query = `
        SELECT st.*, 
               recipient.name as recipient_name,
               recipient.phone as recipient_phone
        FROM scheduled_transfers st
        JOIN users recipient ON recipient.id = st.recipient_id
        WHERE st.sender_id = $1
        ORDER BY st.created_at DESC
      `;
      
      const result = await pool.query(query, [userId]);
      return result.rows;
      
    } catch (error) {
      console.error('Get scheduled transfers error:', error);
      throw error;
    }
  }

  // Cancel a scheduled transfer
  static async cancelScheduledTransfer(scheduleId, userId) {
    try {
      const result = await pool.query(
        `UPDATE scheduled_transfers 
         SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP
         WHERE schedule_id = $1 AND sender_id = $2 AND status = 'active'
         RETURNING *`,
        [scheduleId, userId]
      );
      
      if (result.rows.length === 0) {
        throw new Error('Scheduled transfer not found or already processed');
      }
      
      // Stop the cron job
      if (this.scheduledJobs.has(scheduleId)) {
        this.scheduledJobs.get(scheduleId).stop();
        this.scheduledJobs.delete(scheduleId);
      }
      
      return {
        success: true,
        message: 'Scheduled transfer cancelled'
      };
      
    } catch (error) {
      console.error('Cancel scheduled transfer error:', error);
      throw error;
    }
  }
}

module.exports = ScheduledTransferService;
