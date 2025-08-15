// backend/database/fresh-start.js
require('dotenv').config();
const db = require('../config/database');

async function freshStart() {
  try {
    console.log('🧹 Cleaning database for fresh start...\n');
    
    // Drop ALL existing tables
    console.log('Dropping old tables...');
    await db.query(`
      DROP TABLE IF EXISTS transaction_logs CASCADE;
      DROP TABLE IF EXISTS transactions CASCADE;
      DROP TABLE IF EXISTS wallets CASCADE;
      DROP TABLE IF EXISTS ledger_entries CASCADE;
      DROP TABLE IF EXISTS accounts CASCADE;
      DROP TABLE IF EXISTS users CASCADE;
    `);
    
    console.log('✅ Old tables removed\n');
    
    // Create fresh schema with ledger system
    console.log('Creating new schema with ledger system...\n');
    
    // 1. Users table (simplified)
    console.log('1️⃣ Creating users table...');
    await db.query(`
      CREATE TABLE users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        phone VARCHAR(20) UNIQUE NOT NULL,
        cnic VARCHAR(20) UNIQUE,
        name VARCHAR(255) NOT NULL,
        pin VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        kyc_level INTEGER DEFAULT 1,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // 2. Accounts table (ledger)
    console.log('2️⃣ Creating accounts table...');
    await db.query(`
      CREATE TABLE accounts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        account_type VARCHAR(20) DEFAULT 'customer_wallet',
        balance DECIMAL(19,4) DEFAULT 0,
        currency VARCHAR(3) DEFAULT 'PKR',
        status VARCHAR(10) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // 3. Transactions table (ledger-compatible)
    console.log('3️⃣ Creating transactions table...');
    await db.query(`
      CREATE TABLE transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        transaction_ref VARCHAR(50) UNIQUE NOT NULL,
        type VARCHAR(20) NOT NULL,
        from_account_id UUID REFERENCES accounts(id),
        to_account_id UUID REFERENCES accounts(id),
        amount DECIMAL(19,4) NOT NULL,
        currency VARCHAR(3) DEFAULT 'PKR',
        status VARCHAR(20) DEFAULT 'pending',
        metadata JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // 4. Ledger entries (double-entry bookkeeping)
    console.log('4️⃣ Creating ledger_entries table...');
    await db.query(`
      CREATE TABLE ledger_entries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        transaction_ref VARCHAR(50) NOT NULL,
        account_id UUID NOT NULL REFERENCES accounts(id),
        entry_type VARCHAR(10) NOT NULL CHECK (entry_type IN ('debit', 'credit')),
        amount DECIMAL(19,4) NOT NULL,
        balance_after DECIMAL(19,4) NOT NULL,
        currency VARCHAR(3) DEFAULT 'PKR',
        metadata JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // 5. Create all indexes
    console.log('5️⃣ Creating indexes...');
    await db.query(`
      CREATE INDEX idx_users_phone ON users(phone);
      CREATE INDEX idx_users_cnic ON users(cnic);
      CREATE INDEX idx_accounts_user_id ON accounts(user_id);
      CREATE INDEX idx_transactions_ref ON transactions(transaction_ref);
      CREATE INDEX idx_ledger_account ON ledger_entries(account_id, created_at);
    `);
    
    // 6. Create test users
    console.log('6️⃣ Creating test users...');
    const bcrypt = require('bcryptjs');
    const hashedPin = await bcrypt.hash('1234', 10);
    
    await db.query(`
      INSERT INTO users (phone, cnic, name, pin, email) VALUES 
      ('03001234567', '12345-1234567-1', 'Test User One', $1, 'test1@example.com'),
      ('03009876543', '12345-1234567-2', 'Test User Two', $1, 'test2@example.com')
    `, [hashedPin]);
    
    console.log('\n✅ Fresh database with ledger system ready!');
    console.log('\n📝 Test credentials:');
    console.log('   Phone: 03001234567 or 03009876543');
    console.log('   PIN: 1234');
    console.log('\n🎉 You now have a clean, modern ledger-based fintech database!');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
  process.exit();
}

// Confirm before wiping
console.log('⚠️  WARNING: This will DELETE all existing data!\n');
console.log('Press Ctrl+C to cancel, or wait 5 seconds to continue...\n');

setTimeout(() => {
  freshStart();
}, 5000);
