
require('dotenv').config();
const pool = require('../config/database');

async function addAccountNumber() {
  try {
    console.log('Adding account_number column to accounts table...');
    
    // Add account_number column if it doesn't exist
    await pool.query(`
      ALTER TABLE accounts 
      ADD COLUMN IF NOT EXISTS account_number VARCHAR(20) UNIQUE
    `);
    
    // Generate account numbers for existing accounts
    const accounts = await pool.query('SELECT id FROM accounts WHERE account_number IS NULL');
    
    for (const account of accounts.rows) {
      const accountNumber = 'ACC' + Date.now() + Math.floor(Math.random() * 1000);
      await pool.query(
        'UPDATE accounts SET account_number = $1 WHERE id = $2',
        [accountNumber, account.id]
      );
    }
    
    console.log('✅ Account numbers added successfully!');
  } catch (error) {
    console.error('Error:', error);
  }
  process.exit();
}

addAccountNumber();
