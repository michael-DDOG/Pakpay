CREATE DATABASE fintech_db;

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number VARCHAR(15) UNIQUE NOT NULL,
  cnic VARCHAR(15) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  email VARCHAR(255),
  kyc_level INTEGER DEFAULT 1,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  balance DECIMAL(15, 2) DEFAULT 0.00,
  currency VARCHAR(3) DEFAULT 'PKR',
  is_locked BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_number VARCHAR(50) UNIQUE NOT NULL,
  sender_wallet_id UUID REFERENCES wallets(id),
  receiver_wallet_id UUID REFERENCES wallets(id),
  amount DECIMAL(15, 2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'PKR',
  type VARCHAR(50) NOT NULL, -- 'transfer', 'deposit', 'withdrawal'
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'completed', 'failed', 'reversed'
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP
);

CREATE TABLE transaction_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID REFERENCES transactions(id),
  action VARCHAR(50) NOT NULL,
  details JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX idx_users_phone ON users(phone_number);
CREATE INDEX idx_users_cnic ON users(cnic);
CREATE INDEX idx_transactions_sender ON transactions(sender_wallet_id);
CREATE INDEX idx_transactions_receiver ON transactions(receiver_wallet_id);
CREATE INDEX idx_transactions_reference ON transactions(reference_number);
