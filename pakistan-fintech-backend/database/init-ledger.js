// backend/database/init-ledger.js
const pool = require('../config/database');

async function initLedgerTables() {
  try {
    // Create accounts table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        account_type VARCHAR(20) NOT NULL DEFAULT 'customer_wallet',
        balance DECIMAL(19,4) DEFAULT 0 NOT NULL,
        currency VARCHAR(3) DEFAULT 'PKR',
        status VARCHAR(10) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create index
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id);
    `);

    // Create ledger_entries table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ledger_entries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        transaction_ref VARCHAR(50) NOT NULL UNIQUE,
        account_id UUID NOT NULL,
        entry_type VARCHAR(10) NOT NULL,
        amount DECIMAL(19,4) NOT NULL,
        balance_after DECIMAL(19,4) NOT NULL,
        currency VARCHAR(3) DEFAULT 'PKR',
        metadata JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
      );
    `);

    // Create indexes
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_ledger_entries_account_id ON ledger_entries(account_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_ledger_entries_transaction_ref ON ledger_entries(transaction_ref);
    `);

    // Create transactions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        transaction_ref VARCHAR(50) NOT NULL UNIQUE,
        type VARCHAR(20) NOT NULL,
        from_account_id UUID,
        to_account_id UUID,
        amount DECIMAL(19,4) NOT NULL,
        currency VARCHAR(3) DEFAULT 'PKR',
        status VARCHAR(20) DEFAULT 'pending',
        metadata JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log('✅ Ledger tables created successfully');
  } catch (error) {
    console.error('Error creating ledger tables:', error);
    throw error;
  }
}

// Run if called directly
if (require.main === module) {
  initLedgerTables()
    .then(() => {
      console.log('Ledger initialization complete');
      process.exit(0);
    })
    .catch(err => {
      console.error('Failed to initialize ledger:', err);
      process.exit(1);
    });
}

module.exports = initLedgerTables;
