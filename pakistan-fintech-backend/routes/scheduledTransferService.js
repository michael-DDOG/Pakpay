// backend/services/scheduledTransferService.js
const cron = require('node-cron');
const pool = require('../config/database');
const logger = require('../utils/logger');

class ScheduledTransferService {
  constructor() {
    this.jobs = new Map();
  }

  // Initialize scheduled jobs
  async initializeScheduledJobs() {
    try {
      // Run every minute to check for scheduled transfers
      const transferJob = cron.schedule('* * * * *', async () => {
        await this.processScheduledTransfers();
      });

      // Run every hour to check for recurring payments
      const recurringJob = cron.schedule('0 * * * *', async () => {
        await this.processRecurringPayments();
      });

      this.jobs.set('transfers', transferJob);
      this.jobs.set('recurring', recurringJob);

      logger.info('Scheduled transfer jobs initialized');
    } catch (error) {
      logger.error('Failed to initialize scheduled jobs:', error);
      throw error;
    }
  }

  // Process scheduled transfers
  async processScheduledTransfers() {
    const client = await pool.connect();
    
    try {
      // Get pending transfers that are due
      const pendingTransfers = await client.query(
        `SELECT * FROM scheduled_transfers 
         WHERE status = 'pending' 
         AND scheduled_date <= NOW()
         ORDER BY scheduled_date ASC
         LIMIT 10`
      );

      for (const transfer of pendingTransfers.rows) {
        await this.executeTransfer(transfer);
      }
    } catch (error) {
      logger.error('Error processing scheduled transfers:', error);
    } finally {
      client.release();
    }
  }

  // Execute a single transfer
  async executeTransfer(transfer) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // Get sender account
      const senderAccount = await client.query(
        'SELECT * FROM accounts WHERE user_id = $1',
        [transfer.user_id]
      );

      if (senderAccount.rows[0].balance < transfer.amount) {
        throw new Error('Insufficient balance');
      }

      // Get recipient account
      const recipientAccount = await client.query(
        'SELECT * FROM accounts WHERE user_id = $1',
        [transfer.recipient_id]
      );

      // Create transaction reference
      const transactionRef = `SCH${Date.now()}${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

      // Debit sender
      await client.query(
        'UPDATE accounts SET balance = balance - $1 WHERE user_id = $2',
        [transfer.amount, transfer.user_id]
      );

      // Credit recipient
      await client.query(
        'UPDATE accounts SET balance = balance + $1 WHERE user_id = $2',
        [transfer.amount, transfer.recipient_id]
      );

      // Record in ledger
      await client.query(
        `INSERT INTO ledger_entries 
         (account_id, entry_type, amount, balance_after, description, transaction_ref, created_at)
         VALUES ($1, 'debit', $2, $3, $4, $5, NOW())`,
        [
          senderAccount.rows[0].id,
          transfer.amount,
          senderAccount.rows[0].balance - transfer.amount,
          transfer.description || 'Scheduled transfer',
          transactionRef
        ]
      );

      await client.query(
        `INSERT INTO ledger_entries 
         (account_id, entry_type, amount, balance_after, description, transaction_ref, created_at)
         VALUES ($1, 'credit', $2, $3, $4, $5, NOW())`,
        [
          recipientAccount.rows[0].id,
          transfer.amount,
          recipientAccount.rows[0].balance + transfer.amount,
          transfer.description || 'Scheduled transfer received',
          transactionRef
        ]
      );

      // Update scheduled transfer status
      await client.query(
        `UPDATE scheduled_transfers 
         SET status = 'completed', 
             transaction_ref = $1, 
             executed_at = NOW()
         WHERE id = $2`,
        [transactionRef, transfer.id]
      );

      await client.query('COMMIT');
      
      logger.info(`Scheduled transfer ${transfer.id} completed: ${transactionRef}`);
      
    } catch (error) {
      await client.query('ROLLBACK');
      
      // Mark transfer as failed
      await client.query(
        `UPDATE scheduled_transfers 
         SET status = 'failed', 
             error_message = $1
         WHERE id = $2`,
        [error.message, transfer.id]
      );
      
      logger.error(`Scheduled transfer ${transfer.id} failed:`, error);
    } finally {
      client.release();
    }
  }

  // Process recurring payments
  async processRecurringPayments() {
    const client = await pool.connect();
    
    try {
      // Get active recurring payments due today
      const duePayments = await client.query(
        `SELECT * FROM recurring_payments 
         WHERE status = 'active' 
         AND next_execution_date <= CURRENT_DATE
         AND (end_date IS NULL OR end_date >= CURRENT_DATE)
         LIMIT 10`
      );

      for (const payment of duePayments.rows) {
        await this.executeRecurringPayment(payment);
      }
    } catch (error) {
      logger.error('Error processing recurring payments:', error);
    } finally {
      client.release();
    }
  }

  // Execute recurring payment
  async executeRecurringPayment(payment) {
    try {
      // Create a scheduled transfer for today
      await pool.query(
        `INSERT INTO scheduled_transfers 
         (user_id, recipient_phone, amount, scheduled_date, description, status)
         VALUES ($1, $2, $3, NOW(), $4, 'pending')`,
        [
          payment.user_id,
          payment.recipient_phone,
          payment.amount,
          `Recurring: ${payment.description || 'Recurring payment'}`
        ]
      );

      // Calculate next execution date based on frequency
      let nextDate = new Date(payment.next_execution_date);
      switch (payment.frequency) {
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

      // Update next execution date
      await pool.query(
        `UPDATE recurring_payments 
         SET next_execution_date = $1,
             executions_count = executions_count + 1,
             last_executed_at = NOW()
         WHERE id = $2`,
        [nextDate, payment.id]
      );

      // Check if this was the last execution
      if (payment.end_date && nextDate > new Date(payment.end_date)) {
        await pool.query(
          `UPDATE recurring_payments 
           SET status = 'completed' 
           WHERE id = $1`,
          [payment.id]
        );
      }

      logger.info(`Recurring payment ${payment.id} scheduled for execution`);
      
    } catch (error) {
      logger.error(`Recurring payment ${payment.id} failed:`, error);
    }
  }

  // Stop all jobs
  async stopJobs() {
    for (const [name, job] of this.jobs) {
      job.stop();
      logger.info(`Stopped job: ${name}`);
    }
    this.jobs.clear();
  }
}

module.exports = new ScheduledTransferService();
