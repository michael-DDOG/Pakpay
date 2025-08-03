const db = require('../config/database');

class Wallet {
  static async create(userId) {
    const query = `
      INSERT INTO wallets (user_id)
      VALUES ($1)
      RETURNING id, user_id, balance, currency, is_locked, created_at
    `;
    
    const result = await db.query(query, [userId]);
    return result.rows[0];
  }
  
  static async findByUserId(userId) {
    const query = 'SELECT * FROM wallets WHERE user_id = $1';
    const result = await db.query(query, [userId]);
    return result.rows[0];
  }
  
  static async getBalance(walletId) {
    const query = 'SELECT balance, currency, is_locked FROM wallets WHERE id = $1';
    const result = await db.query(query, [walletId]);
    return result.rows[0];
  }
  
  static async updateBalance(client, walletId, amount, operation = 'add') {
    const query = operation === 'add' 
      ? 'UPDATE wallets SET balance = balance + $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND is_locked = false RETURNING balance'
      : 'UPDATE wallets SET balance = balance - $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND is_locked = false AND balance >= $2 RETURNING balance';
    
    const result = await client.query(query, [walletId, amount]);
    return result.rows[0];
  }
}

module.exports = Wallet;
