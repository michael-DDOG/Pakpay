// services/notificationService.js
const pool = require('../config/database');
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');

// Initialize Firebase Admin (you'll need to set up Firebase)
// admin.initializeApp({
//   credential: admin.credential.cert(serviceAccount)
// });

class NotificationService {
  // Save device token
  static async saveDeviceToken(userId, token, platform = 'android') {
    try {
      const query = `
        INSERT INTO device_tokens (user_id, token, platform, is_active)
        VALUES ($1, $2, $3, true)
        ON CONFLICT (user_id, token) 
        DO UPDATE SET 
          is_active = true,
          updated_at = CURRENT_TIMESTAMP
      `;
      
      await pool.query(query, [userId, token, platform]);
      
      return { success: true };
    } catch (error) {
      console.error('Save device token error:', error);
      throw error;
    }
  }

  // Send push notification
  static async sendNotification(userId, title, body, data = {}) {
    try {
      // Get user's device tokens
      const tokenQuery = `
        SELECT token, platform 
        FROM device_tokens 
        WHERE user_id = $1 AND is_active = true
      `;
      const tokenResult = await pool.query(tokenQuery, [userId]);
      
      if (tokenResult.rows.length === 0) {
        console.log('No active device tokens for user:', userId);
        return;
      }
      
      const tokens = tokenResult.rows.map(row => row.token);
      
      // Create notification payload
      const message = {
        notification: {
          title,
          body
        },
        data: {
          ...data,
          timestamp: new Date().toISOString()
        },
        tokens
      };
      
      // Send via Firebase
      // const response = await admin.messaging().sendMulticast(message);
      
      // Save notification to database
      await this.saveNotificationHistory(userId, title, body, data);
      
      // For now, just log (replace with actual Firebase send)
      console.log('Notification sent:', { userId, title, body });
      
      return { success: true };
    } catch (error) {
      console.error('Send notification error:', error);
      throw error;
    }
  }

  // Save notification history
  static async saveNotificationHistory(userId, title, body, data) {
    try {
      const query = `
        INSERT INTO notification_history (
          notification_id, user_id, title, body, 
          data, status, created_at
        ) VALUES ($1, $2, $3, $4, $5, 'sent', CURRENT_TIMESTAMP)
      `;
      
      const notificationId = `NOTIF${Date.now()}${uuidv4().substring(0, 8).toUpperCase()}`;
      
      await pool.query(query, [
        notificationId,
        userId,
        title,
        body,
        JSON.stringify(data)
      ]);
      
      return { success: true };
    } catch (error) {
      console.error('Save notification history error:', error);
    }
  }

  // Send transaction notification
  static async sendTransactionNotification(userId, type, amount, otherParty) {
    const titles = {
      'credit': 'Money Received',
      'debit': 'Money Sent',
      'bill_payment': 'Bill Paid',
      'request_approved': 'Request Approved',
      'request_received': 'Money Request'
    };
    
    const bodies = {
      'credit': `You received PKR ${amount} from ${otherParty}`,
      'debit': `You sent PKR ${amount} to ${otherParty}`,
      'bill_payment': `Bill payment of PKR ${amount} successful`,
      'request_approved': `Your request for PKR ${amount} was approved`,
      'request_received': `${otherParty} requested PKR ${amount}`
    };
    
    return this.sendNotification(
      userId,
      titles[type] || 'Transaction Update',
      bodies[type] || `Transaction of PKR ${amount}`,
      { type, amount: amount.toString(), otherParty }
    );
  }

  // Send reminder notification
  static async sendReminderNotification(userId, type, message) {
    const titles = {
      'bill_due': '📅 Bill Payment Due',
      'goal_reminder': '🎯 Savings Goal Reminder',
      'request_pending': '💰 Pending Request',
      'scheduled_transfer': '📅 Scheduled Transfer'
    };
    
    return this.sendNotification(
      userId,
      titles[type] || 'Reminder',
      message,
      { type, reminderType: type }
    );
  }

  // Get user notifications
  static async getUserNotifications(userId, limit = 50) {
    try {
      const query = `
        SELECT * FROM notification_history
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2
      `;
      
      const result = await pool.query(query, [userId, limit]);
      return result.rows;
    } catch (error) {
      console.error('Get notifications error:', error);
      throw error;
    }
  }

  // Mark notification as read
  static async markAsRead(notificationId, userId) {
    try {
      const query = `
        UPDATE notification_history
        SET is_read = true, read_at = CURRENT_TIMESTAMP
        WHERE notification_id = $1 AND user_id = $2
      `;
      
      await pool.query(query, [notificationId, userId]);
      return { success: true };
    } catch (error) {
      console.error('Mark as read error:', error);
      throw error;
    }
  }

  // Get unread count
  static async getUnreadCount(userId) {
    try {
      const query = `
        SELECT COUNT(*) as unread_count
        FROM notification_history
        WHERE user_id = $1 AND is_read = false
      `;
      
      const result = await pool.query(query, [userId]);
      return parseInt(result.rows[0].unread_count);
    } catch (error) {
      console.error('Get unread count error:', error);
      return 0;
    }
  }

  // Update notification preferences
  static async updatePreferences(userId, preferences) {
    try {
      const query = `
        INSERT INTO notification_preferences (
          user_id, transactions, reminders, marketing, 
          security, minimum_amount
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (user_id) DO UPDATE SET
          transactions = $2,
          reminders = $3,
          marketing = $4,
          security = $5,
          minimum_amount = $6,
          updated_at = CURRENT_TIMESTAMP
      `;
      
      await pool.query(query, [
        userId,
        preferences.transactions !== false,
        preferences.reminders !== false,
        preferences.marketing !== false,
        preferences.security !== false,
        preferences.minimumAmount || 0
      ]);
      
      return { success: true };
    } catch (error) {
      console.error('Update preferences error:', error);
      throw error;
    }
  }
}

module.exports = NotificationService;
