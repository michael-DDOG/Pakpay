// backend/routes/savings.js
const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth');
const pool = require('../config/database');

// Create savings goal
router.post('/goal', authenticateToken, async (req, res) => {
  try {
    const { name, targetAmount, targetDate, description } = req.body;
    const userId = req.user.userId;

    if (!name || !targetAmount || targetAmount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Name and valid target amount are required'
      });
    }

    const result = await pool.query(
      `INSERT INTO savings_goals 
       (user_id, name, target_amount, target_date, current_amount, description, status, created_at)
       VALUES ($1, $2, $3, $4, 0, $5, 'active', NOW())
       RETURNING *`,
      [userId, name, targetAmount, targetDate, description]
    );

    res.json({
      success: true,
      goal: result.rows[0],
      message: 'Savings goal created successfully'
    });
  } catch (error) {
    console.error('Create savings goal error:', error);
    res.status(500).json({ success: false, error: 'Failed to create savings goal' });
  }
});

// Get all savings goals
router.get('/goals', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    const result = await pool.query(
      `SELECT *, 
        ROUND((current_amount / target_amount * 100)::numeric, 2) as progress_percentage,
        (target_date - CURRENT_DATE) as days_remaining
       FROM savings_goals 
       WHERE user_id = $1 
       ORDER BY created_at DESC`,
      [userId]
    );

    res.json({
      success: true,
      goals: result.rows
    });
  } catch (error) {
    console.error('Get savings goals error:', error);
    res.status(500).json({ success: false, error: 'Failed to get savings goals' });
  }
});

// Add money to savings goal
router.post('/goal/:goalId/deposit', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { goalId } = req.params;
    const { amount } = req.body;
    const userId = req.user.userId;

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Valid amount is required'
      });
    }

    await client.query('BEGIN');

    // Check user balance
    const balanceResult = await client.query(
      'SELECT balance FROM accounts WHERE user_id = $1',
      [userId]
    );

    if (balanceResult.rows[0].balance < amount) {
      throw new Error('Insufficient balance');
    }

    // Check goal exists and belongs to user
    const goalResult = await client.query(
      'SELECT * FROM savings_goals WHERE id = $1 AND user_id = $2 AND status = $3',
      [goalId, userId, 'active']
    );

    if (goalResult.rows.length === 0) {
      throw new Error('Savings goal not found');
    }

    const goal = goalResult.rows[0];

    // Deduct from main wallet
    await client.query(
      'UPDATE accounts SET balance = balance - $1 WHERE user_id = $2',
      [amount, userId]
    );

    // Add to savings goal
    const newAmount = parseFloat(goal.current_amount) + parseFloat(amount);
    await client.query(
      'UPDATE savings_goals SET current_amount = $1, last_deposit_date = NOW() WHERE id = $2',
      [newAmount, goalId]
    );

    // Record transaction
    await client.query(
      `INSERT INTO savings_transactions 
       (goal_id, user_id, type, amount, balance_after, created_at)
       VALUES ($1, $2, 'deposit', $3, $4, NOW())`,
      [goalId, userId, amount, newAmount]
    );

    // Check if goal is completed
    if (newAmount >= goal.target_amount) {
      await client.query(
        'UPDATE savings_goals SET status = $1, completed_at = NOW() WHERE id = $2',
        ['completed', goalId]
      );
    }

    await client.query('COMMIT');

    res.json({
      success: true,
      message: `PKR ${amount} added to savings goal`,
      currentAmount: newAmount,
      targetAmount: goal.target_amount,
      completed: newAmount >= goal.target_amount
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Deposit to savings error:', error);
    res.status(400).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

// Withdraw from savings goal
router.post('/goal/:goalId/withdraw', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { goalId } = req.params;
    const { amount } = req.body;
    const userId = req.user.userId;

    await client.query('BEGIN');

    // Get goal
    const goalResult = await client.query(
      'SELECT * FROM savings_goals WHERE id = $1 AND user_id = $2',
      [goalId, userId]
    );

    if (goalResult.rows.length === 0) {
      throw new Error('Savings goal not found');
    }

    const goal = goalResult.rows[0];

    if (goal.current_amount < amount) {
      throw new Error('Insufficient savings balance');
    }

    // Deduct from savings
    const newAmount = parseFloat(goal.current_amount) - parseFloat(amount);
    await client.query(
      'UPDATE savings_goals SET current_amount = $1 WHERE id = $2',
      [newAmount, goalId]
    );

    // Add to main wallet
    await client.query(
      'UPDATE accounts SET balance = balance + $1 WHERE user_id = $2',
      [amount, userId]
    );

    // Record transaction
    await client.query(
      `INSERT INTO savings_transactions 
       (goal_id, user_id, type, amount, balance_after, created_at)
       VALUES ($1, $2, 'withdrawal', $3, $4, NOW())`,
      [goalId, userId, amount, newAmount]
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      message: `PKR ${amount} withdrawn from savings`,
      remainingAmount: newAmount
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Withdraw from savings error:', error);
    res.status(400).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

// Auto-save feature
router.post('/auto-save', authenticateToken, async (req, res) => {
  try {
    const { percentage, goalId } = req.body; // Save % of each incoming transaction
    const userId = req.user.userId;

    const result = await pool.query(
      `INSERT INTO auto_save_rules (user_id, goal_id, percentage, is_active, created_at)
       VALUES ($1, $2, $3, true, NOW())
       ON CONFLICT (user_id) DO UPDATE
       SET goal_id = $2, percentage = $3, updated_at = NOW()
       RETURNING *`,
      [userId, goalId, percentage]
    );

    res.json({
      success: true,
      autoSave: result.rows[0],
      message: `Auto-save ${percentage}% activated`
    });
  } catch (error) {
    console.error('Auto-save setup error:', error);
    res.status(500).json({ success: false, error: 'Failed to setup auto-save' });
  }
});

module.exports = router;
