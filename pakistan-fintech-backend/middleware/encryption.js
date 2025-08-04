const encryptionService = require('../utils/encryption');
const logger = require('../utils/logger');

const encryptResponse = (req, res, next) => {
  // Store the original json method
  const originalJson = res.json;
 
  // Override the json method
  res.json = function(data) {
    try {
      // Only encrypt sensitive endpoints
      const sensitiveRoutes = [
        '/api/auth/login',
        '/api/auth/register',
        '/api/transfer',
        '/api/wallet/balance',
        '/api/remittance'
      ];
     
      const shouldEncrypt = sensitiveRoutes.some(route =>
        req.originalUrl.startsWith(route)
      );
     
      if (shouldEncrypt && process.env.NODE_ENV === 'production') {
        const encrypted = encryptionService.encrypt(data);
        return originalJson.call(this, {
          encrypted: true,
          data: encrypted.encrypted,
          iv: encrypted.iv
        });
      }
     
      // Call the original json method with unencrypted data
      return originalJson.call(this, data);
    } catch (error) {
      logger.error('Encryption error:', error);
      return originalJson.call(this, data);
    }
  };
 
  next();
};

const decryptRequest = (req, res, next) => {
  try {
    if (req.body && req.body.encrypted && req.body.data && req.body.iv) {
      const decrypted = encryptionService.decrypt(req.body.data, req.body.iv);
      req.body = decrypted;
    }
  } catch (error) {
    logger.error('Decryption error:', error);
    return res.status(400).json({
      error: 'Invalid encrypted data',
      message: 'Could not decrypt request'
    });
  }
 
  next();
};

module.exports = { encryptResponse, decryptRequest };
