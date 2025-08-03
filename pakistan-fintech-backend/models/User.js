const db = require('../config/database');
const bcrypt = require('bcryptjs');

class User {
  static async create(userData) {
    const { phoneNumber, cnic, password, firstName, lastName, email } = userData;
    
    const hashedPassword = await bcrypt.hash(password, parseInt(process.env.BCRYPT_ROUNDS));
    
    const query = `
      INSERT INTO users (phone_number, cnic, password_hash, first_name, last_name, email)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, phone_number, cnic, first_name, last_name, email, kyc_level, is_active, created_at
    `;
    
    const values = [phoneNumber, cnic, hashedPassword, firstName, lastName, email];
    const result = await db.query(query, values);
    
    return result.rows[0];
  }
  
  static async findByPhone(phoneNumber) {
    const query = 'SELECT * FROM users WHERE phone_number = $1 AND is_active = true';
    const result = await db.query(query, [phoneNumber]);
    return result.rows[0];
  }
  
  static async findById(id) {
    const query = 'SELECT * FROM users WHERE id = $1 AND is_active = true';
    const result = await db.query(query, [id]);
    return result.rows[0];
  }
  
  static async verifyPassword(password, passwordHash) {
    return bcrypt.compare(password, passwordHash);
  }
}

module.exports = User;
