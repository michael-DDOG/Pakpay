const crypto = require('crypto');

class EncryptionService {
  constructor() {
    // In production, use proper key management (AWS KMS, Azure Key Vault, etc.)
    this.algorithm = 'aes-256-cbc';
    this.key = Buffer.from(process.env.AES_SECRET_KEY || 'your-32-byte-aes-encryption-key', 'utf-8').slice(0, 32);
    this.iv = Buffer.from(process.env.AES_IV || 'your-16-byte-iv-', 'utf-8').slice(0, 16);
  }

  encrypt(data) {
    try {
      const cipher = crypto.createCipheriv(this.algorithm, this.key, this.iv);
      const encrypted = Buffer.concat([
        cipher.update(JSON.stringify(data), 'utf8'),
        cipher.final()
      ]);
     
      return {
        encrypted: encrypted.toString('base64'),
        iv: this.iv.toString('base64')
      };
    } catch (error) {
      throw new Error('Encryption failed');
    }
  }

  decrypt(encryptedData, iv) {
    try {
      const decipher = crypto.createDecipheriv(
        this.algorithm,
        this.key,
        Buffer.from(iv, 'base64')
      );
     
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(encryptedData, 'base64')),
        decipher.final()
      ]);
     
      return JSON.parse(decrypted.toString('utf8'));
    } catch (error) {
      throw new Error('Decryption failed');
    }
  }

  // Generate hash for sensitive data comparison
  hash(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
  }
}

module.exports = new EncryptionService();
