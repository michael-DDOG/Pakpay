// services/regulatoryReportingService.js
const pool = require('../config/database');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

class RegulatoryReportingService {
  constructor() {
    this.reportPath = process.env.REPORT_PATH || './reports';
    this.sbpApiUrl = process.env.SBP_API_URL;
    this.sbpApiKey = process.env.SBP_API_KEY;
  }

  // Generate daily report for SBP
  async generateDailyReport(date = new Date()) {
    console.log(`Generating daily report for ${date.toDateString()}`);
    
    try {
      const reportData = {
        reportId: `DAILY-${date.toISOString().split('T')[0]}-${Date.now()}`,
        reportDate: date,
        generatedAt: new Date(),
        sections: {}
      };

      // 1. Transaction Summary
      reportData.sections.transactionSummary = await this.getTransactionSummary(date);
      
      // 2. New Account Openings
      reportData.sections.newAccounts = await this.getNewAccounts(date);
      
      // 3. KYC Statistics
      reportData.sections.kycStats = await this.getKYCStatistics(date);
      
      // 4. Suspicious Activities
      reportData.sections.suspiciousActivities = await this.getSuspiciousActivities(date);
      
      // 5. Large Transactions (CTR)
      reportData.sections.largeTransactions = await this.getLargeTransactions(date);
      
      // 6. System Availability
      reportData.sections.systemAvailability = await this.getSystemAvailability(date);
      
      // 7. Customer Complaints
      reportData.sections.complaints = await this.getCustomerComplaints(date);
      
      // 8. Agent/Merchant Statistics
      reportData.sections.merchantStats = await this.getMerchantStatistics(date);
      
      // 9. Risk Metrics
      reportData.sections.riskMetrics = await this.getRiskMetrics(date);
      
      // 10. Compliance Actions
      reportData.sections.complianceActions = await this.getComplianceActions(date);

      // Generate report files
      const files = await this.generateReportFiles(reportData, 'daily');
      
      // Save to database
      await this.saveReport(reportData, 'DAILY', files);
      
      // Submit to SBP
      const submission = await this.submitToSBP(reportData, files);
      
      return {
        success: true,
        reportId: reportData.reportId,
        files,
        submission
      };

    } catch (error) {
      console.error('Daily report generation error:', error);
      throw error;
    }
  }

  // Get transaction summary
  async getTransactionSummary(date) {
    const startDate = new Date(date);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(date);
    endDate.setHours(23, 59, 59, 999);

    const query = `
      SELECT 
        COUNT(*) as total_transactions,
        COUNT(DISTINCT account_id) as unique_accounts,
        SUM(CASE WHEN entry_type = 'credit' THEN amount ELSE 0 END) as total_credits,
        SUM(CASE WHEN entry_type = 'debit' THEN amount ELSE 0 END) as total_debits,
        COUNT(CASE WHEN amount >= 50000 THEN 1 END) as high_value_count,
        AVG(amount) as average_amount,
        MAX(amount) as max_amount,
        MIN(amount) as min_amount
      FROM ledger_entries
      WHERE created_at BETWEEN $1 AND $2
    `;

    const result = await pool.query(query, [startDate, endDate]);
    
    // Transaction types breakdown
    const typeBreakdown = await pool.query(
      `SELECT 
        metadata->>'type' as transaction_type,
        COUNT(*) as count,
        SUM(amount) as total_amount
       FROM ledger_entries
       WHERE created_at BETWEEN $1 AND $2
       GROUP BY metadata->>'type'`,
      [startDate, endDate]
    );

    return {
      summary: result.rows[0],
      typeBreakdown: typeBreakdown.rows
    };
  }

  // Get new accounts
  async getNewAccounts(date) {
    const startDate = new Date(date);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(date);
    endDate.setHours(23, 59, 59, 999);

    const query = `
      SELECT 
        COUNT(*) as total_new_accounts,
        COUNT(CASE WHEN kyc_level = 0 THEN 1 END) as level_0,
        COUNT(CASE WHEN kyc_level = 1 THEN 1 END) as level_1,
        COUNT(CASE WHEN kyc_level = 2 THEN 1 END) as level_2,
        COUNT(CASE WHEN kyc_level = 3 THEN 1 END) as level_3
      FROM users
      WHERE created_at BETWEEN $1 AND $2
    `;

    const result = await pool.query(query, [startDate, endDate]);
    
    // Get detailed list
    const detailedList = await pool.query(
      `SELECT 
        id, name, phone, cnic, kyc_level, created_at
       FROM users
       WHERE created_at BETWEEN $1 AND $2
       ORDER BY created_at DESC`,
      [startDate, endDate]
    );

    return {
      summary: result.rows[0],
      accounts: detailedList.rows
    };
  }

  // Get KYC statistics
  async getKYCStatistics(date) {
    const query = `
      SELECT 
        COUNT(*) as total_users,
        COUNT(CASE WHEN kyc_level = 0 THEN 1 END) as unverified,
        COUNT(CASE WHEN kyc_level = 1 THEN 1 END) as basic,
        COUNT(CASE WHEN kyc_level = 2 THEN 1 END) as enhanced,
        COUNT(CASE WHEN kyc_level = 3 THEN 1 END) as full,
        COUNT(CASE WHEN is_active = false THEN 1 END) as inactive,
        COUNT(CASE WHEN locked_until > CURRENT_TIMESTAMP THEN 1 END) as locked
      FROM users
    `;

    const result = await pool.query(query);
    
    // Get verification statistics
    const verifications = await pool.query(
      `SELECT 
        COUNT(*) as total_verifications,
        COUNT(CASE WHEN verification_result = 'VERIFIED' THEN 1 END) as successful,
        COUNT(CASE WHEN verification_result = 'FAILED' THEN 1 END) as failed
       FROM nadra_verification_logs
       WHERE DATE(created_at) = DATE($1)`,
      [date]
    );

    return {
      userStats: result.rows[0],
      verificationStats: verifications.rows[0]
    };
  }

  // Get suspicious activities
  async getSuspiciousActivities(date) {
    const startDate = new Date(date);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(date);
    endDate.setHours(23, 59, 59, 999);

    // Get STRs
    const strs = await pool.query(
      `SELECT * FROM suspicious_transaction_reports
       WHERE created_at BETWEEN $1 AND $2
       ORDER BY created_at DESC`,
      [startDate, endDate]
    );

    // Get monitoring alerts
    const alerts = await pool.query(
      `SELECT 
        alert_type,
        severity,
        COUNT(*) as count
       FROM monitoring_alerts
       WHERE created_at BETWEEN $1 AND $2
       GROUP BY alert_type, severity
       ORDER BY severity DESC, count DESC`,
      [startDate, endDate]
    );

    // Get blocked transactions
    const blocked = await pool.query(
      `SELECT * FROM blocked_transactions
       WHERE blocked_at BETWEEN $1 AND $2`,
      [startDate, endDate]
    );

    return {
      strs: strs.rows,
      alerts: alerts.rows,
      blockedTransactions: blocked.rows,
      summary: {
        totalSTRs: strs.rows.length,
        totalAlerts: alerts.rows.reduce((sum, a) => sum + parseInt(a.count), 0),
        totalBlocked: blocked.rows.length
      }
    };
  }

  // Get large transactions (for CTR)
  async getLargeTransactions(date) {
    const threshold = 2000000; // 2 Million PKR
    const startDate = new Date(date);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(date);
    endDate.setHours(23, 59, 59, 999);

    const transactions = await pool.query(
      `SELECT 
        le.*,
        u.name,
        u.cnic,
        u.phone
       FROM ledger_entries le
       JOIN accounts a ON a.id = le.account_id
       JOIN users u ON u.id = a.user_id
       WHERE le.amount >= $1
       AND le.created_at BETWEEN $2 AND $3
       ORDER BY le.amount DESC`,
      [threshold, startDate, endDate]
    );

    // Generate CTRs
    for (const tx of transactions.rows) {
      await this.generateCTR(tx);
    }

    return {
      threshold,
      transactions: transactions.rows,
      count: transactions.rows.length,
      totalAmount: transactions.rows.reduce((sum, tx) => sum + parseFloat(tx.amount), 0)
    };
  }

  // Get system availability
  async getSystemAvailability(date) {
    // In production, this would check actual system logs
    // For now, mock data
    return {
      uptime: 99.99,
      totalDowntime: 0,
      incidents: [],
      apiResponseTime: {
        average: 150,
        p95: 300,
        p99: 500
      },
      transactionSuccessRate: 99.8
    };
  }

  // Get customer complaints
  async getCustomerComplaints(date) {
    const startDate = new Date(date);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(date);
    endDate.setHours(23, 59, 59, 999);

    const complaints = await pool.query(
      `SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN status = 'RESOLVED' THEN 1 END) as resolved,
        COUNT(CASE WHEN status = 'PENDING' THEN 1 END) as pending,
        AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/3600) as avg_resolution_hours
       FROM customer_complaints
       WHERE created_at BETWEEN $1 AND $2`,
      [startDate, endDate]
    );

    return complaints.rows[0];
  }

  // Get merchant statistics
  async getMerchantStatistics(date) {
    const startDate = new Date(date);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(date);
    endDate.setHours(23, 59, 59, 999);

    const stats = await pool.query(
      `SELECT 
        COUNT(DISTINCT m.merchant_id) as active_merchants,
        COUNT(le.*) as merchant_transactions,
        SUM(le.amount) as merchant_volume
       FROM merchants m
       JOIN users u ON u.id = m.user_id
       JOIN accounts a ON a.user_id = u.id
       JOIN ledger_entries le ON le.account_id = a.id
       WHERE le.created_at BETWEEN $1 AND $2
       AND le.entry_type = 'credit'`,
      [startDate, endDate]
    );

    return stats.rows[0];
  }

  // Get risk metrics
  async getRiskMetrics(date) {
    const metrics = await pool.query(
      `SELECT 
        risk_category,
        COUNT(*) as count
       FROM customer_risk_profiles
       GROUP BY risk_category`
    );

    const pepCount = await pool.query(
      `SELECT COUNT(*) as pep_count
       FROM customer_risk_profiles
       WHERE pep_status = true`
    );

    return {
      riskDistribution: metrics.rows,
      pepCustomers: pepCount.rows[0].pep_count
    };
  }

  // Get compliance actions
  async getComplianceActions(date) {
    const startDate = new Date(date);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(date);
    endDate.setHours(23, 59, 59, 999);

    const actions = await pool.query(
      `SELECT 
        action_type,
        COUNT(*) as count
       FROM compliance_actions
       WHERE created_at BETWEEN $1 AND $2
       GROUP BY action_type`,
      [startDate, endDate]
    );

    return actions.rows;
  }

  // Generate CTR (Currency Transaction Report)
  async generateCTR(transaction) {
    const ctrId = `CTR-${Date.now()}-${transaction.transaction_ref}`;
    
    const ctrData = {
      ctrId,
      transactionRef: transaction.transaction_ref,
      amount: transaction.amount,
      currency: 'PKR',
      customerName: transaction.name,
      customerCNIC: transaction.cnic,
      customerPhone: transaction.phone,
      transactionDate: transaction.created_at,
      transactionType: transaction.entry_type,
      reportingDate: new Date()
    };

    await pool.query(
      `INSERT INTO currency_transaction_reports 
       (report_id, transaction_ref, user_id, amount, report_data)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (report_id) DO NOTHING`,
      [
        ctrId,
        transaction.transaction_ref,
        transaction.user_id,
        transaction.amount,
        JSON.stringify(ctrData)
      ]
    );

    return ctrId;
  }

  // Generate report files (Excel and PDF)
  async generateReportFiles(reportData, reportType) {
    const files = {};
    
    // Generate Excel
    files.excel = await this.generateExcelReport(reportData, reportType);
    
    // Generate PDF
    files.pdf = await this.generatePDFReport(reportData, reportType);
    
    // Generate JSON (for API submission)
    files.json = await this.generateJSONReport(reportData, reportType);
    
    return files;
  }

  // Generate Excel report
  async generateExcelReport(reportData, reportType) {
    const workbook = new ExcelJS.Workbook();
    
    // Transaction Summary Sheet
    const summarySheet = workbook.addWorksheet('Transaction Summary');
    summarySheet.columns = [
      { header: 'Metric', key: 'metric', width: 30 },
      { header: 'Value', key: 'value', width: 20 }
    ];
    
    const summary = reportData.sections.transactionSummary.summary;
    summarySheet.addRows([
      { metric: 'Total Transactions', value: summary.total_transactions },
      { metric: 'Unique Accounts', value: summary.unique_accounts },
      { metric: 'Total Credits', value: summary.total_credits },
      { metric: 'Total Debits', value: summary.total_debits },
      { metric: 'Average Amount', value: summary.average_amount }
    ]);
    
    // New Accounts Sheet
    const accountsSheet = workbook.addWorksheet('New Accounts');
    accountsSheet.columns = [
      { header: 'ID', key: 'id', width: 10 },
      { header: 'Name', key: 'name', width: 30 },
      { header: 'Phone', key: 'phone', width: 15 },
      { header: 'CNIC', key: 'cnic', width: 20 },
      { header: 'KYC Level', key: 'kyc_level', width: 10 }
    ];
    accountsSheet.addRows(reportData.sections.newAccounts.accounts);
    
    // Suspicious Activities Sheet
    const suspiciousSheet = workbook.addWorksheet('Suspicious Activities');
    suspiciousSheet.columns = [
      { header: 'Type', key: 'alert_type', width: 20 },
      { header: 'Severity', key: 'severity', width: 15 },
      { header: 'Count', key: 'count', width: 10 }
    ];
    suspiciousSheet.addRows(reportData.sections.suspiciousActivities.alerts);
    
    // Save file
    const fileName = `${reportType}_${reportData.reportDate.toISOString().split('T')[0]}.xlsx`;
    const filePath = path.join(this.reportPath, fileName);
    await workbook.xlsx.writeFile(filePath);
    
    return { fileName, filePath };
  }

  // Generate PDF report
  async generatePDFReport(reportData, reportType) {
    const doc = new PDFDocument();
    const fileName = `${reportType}_${reportData.reportDate.toISOString().split('T')[0]}.pdf`;
    const filePath = path.join(this.reportPath, fileName);
    
    const stream = doc.pipe(fs.createWriteStream(filePath));
    
    // Header
    doc.fontSize(20).text('PakPay Regulatory Report', { align: 'center' });
    doc.fontSize(14).text(`Report Type: ${reportType.toUpperCase()}`, { align: 'center' });
    doc.fontSize(12).text(`Date: ${reportData.reportDate.toDateString()}`, { align: 'center' });
    doc.moveDown();
    
    // Transaction Summary
    doc.fontSize(16).text('Transaction Summary', { underline: true });
    const summary = reportData.sections.transactionSummary.summary;
    doc.fontSize(12)
       .text(`Total Transactions: ${summary.total_transactions}`)
       .text(`Total Volume: PKR ${summary.total_credits + summary.total_debits}`)
       .text(`Unique Accounts: ${summary.unique_accounts}`);
    doc.moveDown();
    
    // New Accounts
    doc.fontSize(16).text('New Account Registrations', { underline: true });
    const accounts = reportData.sections.newAccounts.summary;
    doc.fontSize(12)
       .text(`Total New Accounts: ${accounts.total_new_accounts}`)
       .text(`Level 1: ${accounts.level_1}`)
       .text(`Level 2: ${accounts.level_2}`)
       .text(`Level 3: ${accounts.level_3}`);
    doc.moveDown();
    
    // Suspicious Activities
    doc.fontSize(16).text('Suspicious Activities', { underline: true });
    const suspicious = reportData.sections.suspiciousActivities.summary;
    doc.fontSize(12)
       .text(`Total STRs: ${suspicious.totalSTRs}`)
       .text(`Total Alerts: ${suspicious.totalAlerts}`)
       .text(`Blocked Transactions: ${suspicious.totalBlocked}`);
    
    // Finalize PDF
    doc.end();
    
    await new Promise(resolve => stream.on('finish', resolve));
    
    return { fileName, filePath };
  }

  // Generate JSON report
  async generateJSONReport(reportData, reportType) {
    const fileName = `${reportType}_${reportData.reportDate.toISOString().split('T')[0]}.json`;
    const filePath = path.join(this.reportPath, fileName);
    
    await fs.writeFile(filePath, JSON.stringify(reportData, null, 2));
    
    return { fileName, filePath };
  }

  // Save report to database
  async saveReport(reportData, reportType, files) {
    await pool.query(
      `INSERT INTO regulatory_reports 
       (report_type, report_period_start, report_period_end, report_data, generated_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        reportType,
        reportData.reportDate,
        reportData.reportDate,
        JSON.stringify(reportData),
        1 // System generated
      ]
    );
  }

  // Submit report to SBP
  async submitToSBP(reportData, files) {
    try {
      // In production, this would actually submit to SBP API
      // For now, mock the submission
      
      const submissionId = `SBP-${Date.now()}`;
      
      // Log submission
      await pool.query(
        `UPDATE regulatory_reports 
         SET submitted_to_sbp = true,
             sbp_submission_date = CURRENT_TIMESTAMP,
             sbp_acknowledgment = $1
         WHERE report_id = $2`,
        [submissionId, reportData.reportId]
      );
      
      return {
        success: true,
        submissionId,
        submittedAt: new Date()
      };
      
    } catch (error) {
      console.error('SBP submission error:', error);
      throw error;
    }
  }

  // Generate monthly report
  async generateMonthlyReport(year, month) {
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0);
    
    const reportData = {
      reportId: `MONTHLY-${year}-${month.toString().padStart(2, '0')}-${Date.now()}`,
      reportPeriod: { start: startDate, end: endDate },
      generatedAt: new Date(),
      sections: {}
    };
    
    // Aggregate daily data for the month
    // Implementation similar to daily report but with monthly aggregation
    
    return reportData;
  }

  // Generate quarterly report
  async generateQuarterlyReport(year, quarter) {
    const quarters = {
      1: { start: 0, end: 2 },
      2: { start: 3, end: 5 },
      3: { start: 6, end: 8 },
      4: { start: 9, end: 11 }
    };
    
    const q = quarters[quarter];
    const startDate = new Date(year, q.start, 1);
    const endDate = new Date(year, q.end + 1, 0);
    
    // Generate quarterly report
    // Implementation details...
    
    return {};
  }
}

module.exports = new RegulatoryReportingService();
