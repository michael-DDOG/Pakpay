// backend/services/ledgerService.js
const { v4: uuidv4 } = require('uuid');
const knex = require('../config/database');

class LedgerService {
  /**
   * Generate SBP-compliant Transaction Reference Number
   * Format: PPYYMMDDHHMMSSXXXXXX
   * PP = Provider prefix (your PSO/EMI license number)
   * YYMMDDHHMMSS = Timestamp
   * XXXXXX = Random alphanumeric
   */
  generateTRN() {
    const now = new Date();
    const year = String(now.getFullYear()).slice(-2);
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    
    // Using 'PK' as prefix for now, will be replaced with actual PSO license number
    return `PK${year}${month}${day}${hours}${minutes}${seconds}${random}`;
  }

  /**
   * Create or get account for a user
   */
  async getOrCreateAccount(userId, accountType = 'customer_wallet') {
    let account = await knex('accounts')
      .where({ user_id: userId, account_type: accountType })
      .first();
    
    if (!account) {
      [account] = await knex('accounts')
        .insert({
          user_id: userId,
          account_type: accountType,
          balance: 0,
          currency: 'PKR'
        })
        .returning('*');
    }
    
    return account;
  }

  /**
   * Record a money transfer between two users
   */
  async recordTransfer(fromUserId, toUserId, amount, metadata = {}) {
    try {
      return await knex.transaction(async (trx) => {
        // Generate unique transaction reference
        const transactionRef = this.generateTRN();
        
        // Get accounts (create if don't exist)
        const fromAccount = await this.getOrCreateAccount(fromUserId);
        const toAccount = await this.getOrCreateAccount(toUserId);
        
        // Lock accounts to prevent race conditions (critical for concurrent transactions)
        const [lockedFromAccount] = await trx('accounts')
          .where('id', fromAccount.id)
          .forUpdate()
          .select('*');
        
        const [lockedToAccount] = await trx('accounts')
          .where('id', toAccount.id)
          .forUpdate()
          .select('*');
        
        // Check sufficient balance
        if (parseFloat(lockedFromAccount.balance) < amount) {
          throw new Error('Insufficient balance');
        }
        
        // Check account status
        if (lockedFromAccount.status !== 'active') {
          throw new Error('Source account is not active');
        }
        
        if (lockedToAccount.status !== 'active') {
          throw new Error('Destination account is not active');
        }
        
        // Calculate new balances
        const fromNewBalance = parseFloat(lockedFromAccount.balance) - amount;
        const toNewBalance = parseFloat(lockedToAccount.balance) + amount;
        
        // Create transaction record
        const [transaction] = await trx('transactions')
          .insert({
            transaction_ref: transactionRef,
            type: 'transfer',
            from_account_id: fromAccount.id,
            to_account_id: toAccount.id,
            amount: amount,
            currency: 'PKR',
            status: 'pending',
            metadata: {
              ...metadata,
              from_user_id: fromUserId,
              to_user_id: toUserId,
              timestamp_pst: new Date().toLocaleString('en-US', { timeZone: 'Asia/Karachi' })
            }
          })
          .returning('*');
        
        // Create ledger entries (immutable audit trail)
        // Debit entry (money going out)
        await trx('ledger_entries').insert({
          transaction_ref: transactionRef,
          account_id: fromAccount.id,
          entry_type: 'debit',
          amount: amount,
          balance_after: fromNewBalance,
          currency: 'PKR',
          metadata: {
            description: `Transfer to account ${toAccount.id}`,
            user_id: fromUserId,
            counterparty_user_id: toUserId
          }
        });
        
        // Credit entry (money coming in)
        await trx('ledger_entries').insert({
          transaction_ref: transactionRef,
          account_id: toAccount.id,
          entry_type: 'credit',
          amount: amount,
          balance_after: toNewBalance,
          currency: 'PKR',
          metadata: {
            description: `Transfer from account ${fromAccount.id}`,
            user_id: toUserId,
            counterparty_user_id: fromUserId
          }
        });
        
        // Update account balances
        await trx('accounts')
          .where('id', fromAccount.id)
          .update({ 
            balance: fromNewBalance,
            updated_at: knex.fn.now()
          });
        
        await trx('accounts')
          .where('id', toAccount.id)
          .update({ 
            balance: toNewBalance,
            updated_at: knex.fn.now()
          });
        
        // Mark transaction as completed
        await trx('transactions')
          .where('id', transaction.id)
          .update({ 
            status: 'completed',
            updated_at: knex.fn.now()
          });
        
        return {
          success: true,
          transactionRef,
          fromNewBalance,
          toNewBalance,
          timestamp: new Date()
        };
      });
    } catch (error) {
      console.error('Transfer failed:', error);
      throw error;
    }
  }

  /**
   * Get account balance
   */
  async getBalance(userId) {
    const account = await this.getOrCreateAccount(userId);
    return {
      balance: parseFloat(account.balance),
      currency: account.currency,
      status: account.status
    };
  }

  /**
   * Get transaction history for a user
   */
  async getTransactionHistory(userId, limit = 20, offset = 0) {
    const account = await this.getOrCreateAccount(userId);
    
    const entries = await knex('ledger_entries')
      .where('account_id', account.id)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset);
    
    return entries.map(entry => ({
      transactionRef: entry.transaction_ref,
      type: entry.entry_type,
      amount: parseFloat(entry.amount),
      balanceAfter: parseFloat(entry.balance_after),
      currency: entry.currency,
      timestamp: entry.created_at,
      description: entry.metadata?.description || ''
    }));
  }

  /**
   * Daily reconciliation report (for SBP compliance)
   * This is a simplified version - will be expanded later
   */
  async generateDailyReport(date = new Date()) {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);
    
    // Get all transactions for the day
    const transactions = await knex('transactions')
      .whereBetween('created_at', [startOfDay, endOfDay])
      .where('status', 'completed');
    
    // Get total debits and credits
    const totals = await knex('ledger_entries')
      .whereBetween('created_at', [startOfDay, endOfDay])
      .select(
        knex.raw('SUM(CASE WHEN entry_type = \'debit\' THEN amount ELSE 0 END) as total_debits'),
        knex.raw('SUM(CASE WHEN entry_type = \'credit\' THEN amount ELSE 0 END) as total_credits'),
        knex.raw('COUNT(*) as total_entries')
      )
      .first();
    
    // Check if books balance (they should!)
    const isBalanced = Math.abs(parseFloat(totals.total_debits) - parseFloat(totals.total_credits)) < 0.01;
    
    return {
      date: date.toISOString().split('T')[0],
      transactionCount: transactions.length,
      totalDebits: parseFloat(totals.total_debits || 0),
      totalCredits: parseFloat(totals.total_credits || 0),
      totalEntries: totals.total_entries,
      isBalanced,
      generatedAt: new Date(),
      reportFormat: 'SBP_DAILY_v1' // Version for future compatibility
    };
  }

  /**
   * Deposit money into account (for testing)
   * In production, this would be triggered by actual bank deposits
   */
  async deposit(userId, amount, metadata = {}) {
    return await knex.transaction(async (trx) => {
      const transactionRef = this.generateTRN();
      const account = await this.getOrCreateAccount(userId);
      
      // Lock account
      const [lockedAccount] = await trx('accounts')
        .where('id', account.id)
        .forUpdate()
        .select('*');
      
      const newBalance = parseFloat(lockedAccount.balance) + amount;
      
      // Create transaction record
      await trx('transactions').insert({
        transaction_ref: transactionRef,
        type: 'deposit',
        to_account_id: account.id,
        amount: amount,
        currency: 'PKR',
        status: 'completed',
        metadata: {
          ...metadata,
          source: 'manual_deposit' // In production: 'bank_transfer', '1link', etc.
        }
      });
      
      // Create ledger entry
      await trx('ledger_entries').insert({
        transaction_ref: transactionRef,
        account_id: account.id,
        entry_type: 'credit',
        amount: amount,
        balance_after: newBalance,
        currency: 'PKR',
        metadata: {
          description: 'Deposit to wallet',
          ...metadata
        }
      });
      
      // Update balance
      await trx('accounts')
        .where('id', account.id)
        .update({ 
          balance: newBalance,
          updated_at: knex.fn.now()
        });
      
      return {
        success: true,
        transactionRef,
        newBalance,
        timestamp: new Date()
      };
    });
  }
}

module.exports = new LedgerService();
