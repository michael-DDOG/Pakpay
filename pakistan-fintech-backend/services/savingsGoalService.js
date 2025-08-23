// services/savingsGoalService.js
const pool = require('../config/database');
const { v4: uuidv4 } = require('uuid');

class SavingsGoalService {
  // Create a savings goal
  static async createGoal(userId, data) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      const { name, targetAmount, targetDate, category, autoSave, autoSaveAmount, autoSaveFrequency } = data;
      
      // Generate goal ID
      const goalId = `GOAL${Date.now()}${uuidv4().substring(0, 8).toUpperCase()}`;
      
      // Create savings goal
      const insertQuery = `
        INSERT INTO savings_goals (
          goal_id, user_id, name, target_amount, current_amount,
          target_date, category, auto_save, auto_save_amount,
          auto_save_frequency, status, created_at
        ) VALUES ($1, $2, $3, $4, 0, $5, $6, $7, $8, $9, 'active', CURRENT_TIMESTAMP)
        RETURNING *
      `;
      
      const result = await client.query(insertQuery, [
        goalId,
        userId,
        name,
        targetAmount,
        targetDate,
        category || 'general',
        autoSave || false,
        autoSaveAmount,
        autoSaveFrequency
      ]);
      
      // Create a savings account for this goal
      await client.query(
        `INSERT INTO savings_accounts (goal_id, user_id, balance)
         VALUES ($1, $2, 0)`,
        [goalId, userId]
      );
      
      await client.query('COMMIT');
      
      return {
        success: true,
        goal: result.rows[0]
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Add money to savings goal
  static async addToGoal(userId, goalId, amount) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Check user balance
      const balanceQuery = 'SELECT balance FROM accounts WHERE user_id = $1';
      const balanceResult = await client.query(balanceQuery, [userId]);
      
      if (balanceResult.rows.length === 0) {
        throw new Error('Account not found');
      }
      
      const balance = parseFloat(balanceResult.rows[0].balance);
      
      if (balance < amount) {
        throw new Error('Insufficient balance');
      }
      
      // Get goal details
      const goalQuery = `
        SELECT * FROM savings_goals 
        WHERE goal_id = $1 AND user_id = $2 AND status = 'active'
      `;
      const goalResult = await client.query(goalQuery, [goalId, userId]);
      
      if (goalResult.rows.length === 0) {
        throw new Error('Savings goal not found');
      }
      
      const goal = goalResult.rows[0];
      const newAmount = parseFloat(goal.current_amount) + parseFloat(amount);
      
      // Generate transaction reference
      const transactionRef = `SAVE${Date.now()}${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
      
      // Create ledger entry for main account (debit)
      await client.query(
        `INSERT INTO ledger_entries (
          account_id, entry_type, amount, balance_after, 
          description, transaction_ref, metadata, created_at
        ) VALUES (
          (SELECT id FROM accounts WHERE user_id = $1), 
          'debit', $2, $3, $4, $5, $6, CURRENT_TIMESTAMP
        )`,
        [
          userId,
          amount,
          balance - amount,
          `Savings: ${goal.name}`,
          transactionRef,
          JSON.stringify({ type: 'savings_deposit', goal_id: goalId })
        ]
      );
      
      // Update main account balance
      await client.query(
        'UPDATE accounts SET balance = balance - $1 WHERE user_id = $2',
        [amount, userId]
      );
      
      // Update savings goal
      await client.query(
        `UPDATE savings_goals 
         SET current_amount = $1, 
             last_contribution = CURRENT_TIMESTAMP
         WHERE goal_id = $2`,
        [newAmount, goalId]
      );
      
      // Update savings account
      await client.query(
        'UPDATE savings_accounts SET balance = balance + $1 WHERE goal_id = $2',
        [amount, goalId]
      );
      
      // Record contribution
      await client.query(
        `INSERT INTO savings_contributions (
          goal_id, amount, transaction_ref, created_at
        ) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
        [goalId, amount, transactionRef]
      );
      
      // Check if goal is reached
      if (newAmount >= parseFloat(goal.target_amount)) {
        await client.query(
          `UPDATE savings_goals 
           SET status = 'completed', completed_at = CURRENT_TIMESTAMP
           WHERE goal_id = $1`,
          [goalId]
        );
      }
      
      await client.query('COMMIT');
      
      return {
        success: true,
        newAmount,
        goalReached: newAmount >= parseFloat(goal.target_amount),
        transactionRef
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Withdraw from savings goal
  static async withdrawFromGoal(userId, goalId, amount) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Get savings account balance
      const savingsQuery = `
        SELECT sa.balance, sg.name, sg.current_amount
        FROM savings_accounts sa
        JOIN savings_goals sg ON sg.goal_id = sa.goal_id
        WHERE sa.goal_id = $1 AND sa.user_id = $2
      `;
      const savingsResult = await client.query(savingsQuery, [goalId, userId]);
      
      if (savingsResult.rows.length === 0) {
        throw new Error('Savings goal not found');
      }
      
      const savings = savingsResult.rows[0];
      
      if (parseFloat(savings.balance) < amount) {
        throw new Error('Insufficient savings balance');
      }
      
      // Generate transaction reference
      const transactionRef = `WITHDRAW${Date.now()}${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
      
      // Create ledger entry for main account (credit)
      await client.query(
        `INSERT INTO ledger_entries (
          account_id, entry_type, amount, balance_after, 
          description, transaction_ref, metadata, created_at
        ) VALUES (
          (SELECT id FROM accounts WHERE user_id = $1), 
          'credit', $2, 
          (SELECT balance + $2 FROM accounts WHERE user_id = $1),
          $3, $4, $5, CURRENT_TIMESTAMP
        )`,
        [
          userId,
          amount,
          `Withdrawal from savings: ${savings.name}`,
          transactionRef,
          JSON.stringify({ type: 'savings_withdrawal', goal_id: goalId })
        ]
      );
      
      // Update main account balance
      await client.query(
        'UPDATE accounts SET balance = balance + $1 WHERE user_id = $2',
        [amount, userId]
      );
      
      // Update savings goal
      const newAmount = parseFloat(savings.current_amount) - amount;
      await client.query(
        'UPDATE savings_goals SET current_amount = $1 WHERE goal_id = $2',
        [newAmount, goalId]
      );
      
      // Update savings account
      await client.query(
        'UPDATE savings_accounts SET balance = balance - $1 WHERE goal_id = $2',
        [amount, goalId]
      );
      
      // Record withdrawal
      await client.query(
        `INSERT INTO savings_withdrawals (
          goal_id, amount, transaction_ref, created_at
        ) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
        [goalId, amount, transactionRef]
      );
      
      await client.query('COMMIT');
      
      return {
        success: true,
        newAmount,
        transactionRef
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Get user's savings goals
  static async getUserGoals(userId) {
    try {
      const query = `
        SELECT sg.*, 
               ROUND((sg.current_amount / sg.target_amount * 100)::numeric, 2) as progress_percentage,
               sa.balance as savings_balance
        FROM savings_goals sg
        LEFT JOIN savings_accounts sa ON sa.goal_id = sg.goal_id
        WHERE sg.user_id = $1
        ORDER BY sg.created_at DESC
      `;
      
      const result = await pool.query(query, [userId]);
      return result.rows;
      
    } catch (error) {
      console.error('Get user goals error:', error);
      throw error;
    }
  }

  // Get goal details with history
  static async getGoalDetails(userId, goalId) {
    const client = await pool.connect();
    try {
      // Get goal details
      const goalQuery = `
        SELECT sg.*, sa.balance as savings_balance
        FROM savings_goals sg
        LEFT JOIN savings_accounts sa ON sa.goal_id = sg.goal_id
        WHERE sg.goal_id = $1 AND sg.user_id = $2
      `;
      const goalResult = await client.query(goalQuery, [goalId, userId]);
      
      if (goalResult.rows.length === 0) {
        throw new Error('Goal not found');
      }
      
      // Get contribution history
      const contributionsQuery = `
        SELECT * FROM savings_contributions 
        WHERE goal_id = $1 
        ORDER BY created_at DESC 
        LIMIT 20
      `;
      const contributions = await client.query(contributionsQuery, [goalId]);
      
      // Get withdrawal history
      const withdrawalsQuery = `
        SELECT * FROM savings_withdrawals 
        WHERE goal_id = $1 
        ORDER BY created_at DESC 
        LIMIT 20
      `;
      const withdrawals = await client.query(withdrawalsQuery, [goalId]);
      
      return {
        goal: goalResult.rows[0],
        contributions: contributions.rows,
        withdrawals: withdrawals.rows
      };
      
    } finally {
      client.release();
    }
  }
}

module.exports = SavingsGoalService;
