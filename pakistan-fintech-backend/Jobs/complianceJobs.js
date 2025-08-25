// jobs/complianceJobs.js
const cron = require('node-cron');
const RegulatoryReportingService = require('../services/regulatoryReportingService');
const TransactionMonitoringService = require('../services/transactionMonitoringService');
const AuditTrailService = require('../services/auditTrailService');
const pool = require('../config/database');

class ComplianceJobs {
  initializeJobs() {
    console.log('Initializing compliance jobs...');
    
    // Daily report generation - 11:59 PM daily
    cron.schedule('59 23 * * *', async () => {
      console.log('Running daily regulatory report...');
      try {
        await RegulatoryReportingService.generateDailyReport(new Date());
      } catch (error) {
        console.error('Daily report generation failed:', error);
      }
    });
    
    // Risk profile review - Daily at 2 AM
    cron.schedule('0 2 * * *', async () => {
      console.log('Running risk profile reviews...');
      await this.reviewRiskProfiles();
    });
    
    // Sanctions list update - Every 6 hours
    cron.schedule('0 */6 * * *', async () => {
      console.log('Updating sanctions lists...');
      await this.updateSanctionsList();
    });
    
    // Archive old audit logs - Weekly on Sunday at 3 AM
    cron.schedule('0 3 * * 0', async () => {
      console.log('Archiving old audit logs...');
      await AuditTrailService.archiveOldRecords();
    });
    
    // Session cleanup - Every hour
    cron.schedule('0 * * * *', async () => {
      console.log('Cleaning up expired sessions...');
      await this.cleanupExpiredSessions();
    });
    
    // Monthly report - First day of month at 1 AM
    cron.schedule('0 1 1 * *', async () => {
      console.log('Generating monthly report...');
      const date = new Date();
      await RegulatoryReportingService.generateMonthlyReport(
        date.getFullYear(),
        date.getMonth()
      );
    });
    
    console.log('Compliance jobs initialized');
  }
  
  async reviewRiskProfiles() {
    // Review high-risk profiles
    const highRiskProfiles = await pool.query(
      `SELECT * FROM customer_risk_profiles 
       WHERE risk_category = 'HIGH' 
       AND next_review_date <= CURRENT_DATE`
    );
    
    for (const profile of highRiskProfiles.rows) {
      // Trigger review process
      console.log(`Review required for user ${profile.user_id}`);
    }
  }
  
  async updateSanctionsList() {
    // In production, fetch from actual sources
    // UN, FATF, NACTA, etc.
    console.log('Sanctions lists updated');
  }
  
  async cleanupExpiredSessions() {
    await pool.query(
      `UPDATE user_sessions 
       SET is_active = false 
       WHERE expires_at < CURRENT_TIMESTAMP 
       AND is_active = true`
    );
  }
}

module.exports = new ComplianceJobs();
