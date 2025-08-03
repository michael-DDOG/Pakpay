const db = require('../config/database');
const { v4: uuidv4 } = require('uuid');

class Transaction {
  static generateReference() {
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 1000);
    return `TXN${timestamp}${random}`;
  }
  
  static async create(client, transactionData) {
    const { senderWalletId, receiverWalletId, amount, type, description } = transactionData;
    const referenceNumber = this.generateReference();
    
    const query = `
      INSERT INTO transactions (reference_number, sender_wallet_id, receiver_wallet_id, amount, type, description)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;
    
    const values = [referenceNumber, senderWalletId, receiverWalletId, amount, type, description];
    const result = await client.query(query, values);
    
    return result.rows[0];
  }
  
  static async updateStatus(client, transactionId, status) {
    const query = `
      UPDATE transactions 
      SET status = $2, completed_at = CASE WHEN $2 = 'completed' THEN CURRENT_TIMESTAMP ELSE NULL END
      WHERE id = $1
      RETURNING *
    `;
    
    const result = await client.query(query, [transactionId, status]);
    return result.rows[0];
  }
  
  static async getUserTransactions(userId, limit = 50, offset = 0) {
    const query = `
      SELECT t.*, 
        sw.user_id as sender_user_id,
        rw.user_id as receiver_user_id,
        su.first_name as sender_first_name,
        su.last_name as sender_last_name,
        ru.first_name as receiver_first_name,
        ru.last_name as receiver_last_name
      FROM transactions t
      LEFT JOIN wallets sw ON t.sender_wallet_id = sw.id
      LEFT JOIN wallets rw ON t.receiver_wallet_id = rw.id
      LEFT JOIN users su ON sw.user_id = su.id
      LEFT JOIN users ru ON rw.user_id = ru.id
      WHERE sw.user_id = $1 OR rw.user_id = $1
      ORDER BY t.created_at DESC
      LIMIT $2 OFFSET $3
    `;
    
    const result = await db.query(query, [userId, limit, offset]);
    return result.rows;
  }
  
  static async logTransaction(client, transactionId, action, details) {
    const query = `
      INSERT INTO transaction_logs (transaction_id, action, details)
      VALUES ($1, $2, $3)
    `;
    
    await client.query(query, [transactionId, action, details]);
  }
}

module.exports = Transaction;
