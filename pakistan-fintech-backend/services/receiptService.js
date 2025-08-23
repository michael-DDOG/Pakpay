// services/receiptService.js
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const pool = require('../config/database');
const fs = require('fs');
const path = require('path');

class ReceiptService {
  // Generate transaction receipt
  static async generateReceipt(transactionRef, userId) {
    try {
      // Get transaction details
      const query = `
        SELECT 
          le.*,
          u.name as user_name,
          u.phone as user_phone,
          u.email as user_email,
          acc.account_number
        FROM ledger_entries le
        JOIN accounts acc ON acc.id = le.account_id
        JOIN users u ON u.id = acc.user_id
        WHERE le.transaction_ref = $1 
          AND acc.user_id = $2
      `;
      
      const result = await pool.query(query, [transactionRef, userId]);
      
      if (result.rows.length === 0) {
        throw new Error('Transaction not found');
      }
      
      const transaction = result.rows[0];
      
      // Get other party details from metadata
      const metadata = transaction.metadata || {};
      const otherParty = metadata.receiver_name || metadata.sender_name || 'Unknown';
      const otherPhone = metadata.receiver_phone || metadata.sender_phone || '';
      
      // Generate PDF
      const receipt = await this.createPDF(transaction, otherParty, otherPhone);
      
      return receipt;
      
    } catch (error) {
      console.error('Generate receipt error:', error);
      throw error;
    }
  }

  // Create PDF document
  static async createPDF(transaction, otherParty, otherPhone) {
    return new Promise(async (resolve, reject) => {
      try {
        const doc = new PDFDocument({
          size: 'A4',
          margin: 50
        });
        
        // Store chunks
        const chunks = [];
        doc.on('data', chunk => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        
        // Header with logo placeholder
        doc.fontSize(24)
           .fillColor('#00A86B')
           .text('PakPay', 50, 50);
        
        doc.fontSize(10)
           .fillColor('#666')
           .text('Digital Payment Receipt', 50, 80);
        
        // Add a line
        doc.moveTo(50, 110)
           .lineTo(545, 110)
           .stroke('#E0E0E0');
        
        // Transaction Status
        const isDebit = transaction.entry_type === 'debit';
        const statusColor = isDebit ? '#DC3545' : '#28A745';
        const statusText = isDebit ? 'PAYMENT SENT' : 'PAYMENT RECEIVED';
        
        doc.fontSize(16)
           .fillColor(statusColor)
           .text(statusText, 50, 130, { align: 'center' });
        
        // Amount
        doc.fontSize(28)
           .fillColor('#333')
           .text(`PKR ${parseFloat(transaction.amount).toLocaleString()}`, 50, 160, { align: 'center' });
        
        // Transaction Details Box
        doc.rect(50, 210, 495, 200)
           .stroke('#E0E0E0');
        
        // Transaction details
        const details = [
          { label: 'Transaction ID', value: transaction.transaction_ref },
          { label: 'Date & Time', value: new Date(transaction.created_at).toLocaleString('en-PK') },
          { label: isDebit ? 'Sent To' : 'Received From', value: otherParty },
          { label: 'Phone Number', value: otherPhone },
          { label: 'Description', value: transaction.description },
          { label: 'Transaction Type', value: this.getTransactionType(transaction.metadata) },
          { label: 'Balance After', value: `PKR ${parseFloat(transaction.balance_after).toLocaleString()}` }
        ];
        
        let yPosition = 230;
        details.forEach(detail => {
          doc.fontSize(10)
             .fillColor('#666')
             .text(detail.label, 70, yPosition);
          
          doc.fontSize(11)
             .fillColor('#333')
             .text(detail.value, 200, yPosition);
          
          yPosition += 25;
        });
        
        // User Information
        doc.rect(50, 430, 495, 100)
           .stroke('#E0E0E0');
        
        doc.fontSize(12)
           .fillColor('#00A86B')
           .text('Account Information', 70, 450);
        
        doc.fontSize(10)
           .fillColor('#666')
           .text('Account Holder:', 70, 475);
        doc.fillColor('#333')
           .text(transaction.user_name, 200, 475);
        
        doc.fillColor('#666')
           .text('Phone Number:', 70, 495);
        doc.fillColor('#333')
           .text(transaction.user_phone, 200, 495);
        
        doc.fillColor('#666')
           .text('Account Number:', 70, 515);
        doc.fillColor('#333')
           .text(transaction.account_number, 200, 515);
        
        // QR Code for verification
        const qrData = {
          ref: transaction.transaction_ref,
          amount: transaction.amount,
          date: transaction.created_at
        };
        
        const qrCodeDataUrl = await QRCode.toDataURL(JSON.stringify(qrData), {
          width: 100
        });
        
        // Convert base64 to buffer
        const qrImageBuffer = Buffer.from(qrCodeDataUrl.split(',')[1], 'base64');
        
        doc.image(qrImageBuffer, 445, 430, { width: 80 });
        
        doc.fontSize(8)
           .fillColor('#666')
           .text('Scan to verify', 450, 515);
        
        // Footer
        doc.fontSize(8)
           .fillColor('#999')
           .text('This is a computer generated receipt and does not require signature.', 50, 550, { align: 'center' });
        
        doc.text('For support, contact: support@pakpay.pk | 0800-PAKPAY', 50, 565, { align: 'center' });
        
        // Security notice
        doc.rect(50, 590, 495, 40)
           .fillAndStroke('#FFF3CD', '#FFC107');
        
        doc.fillColor('#856404')
           .fontSize(9)
           .text('Security Notice: Never share your PIN or OTP with anyone. PakPay staff will never ask for your credentials.', 60, 605, { width: 475 });
        
        // Generate reference number at bottom
        doc.fontSize(7)
           .fillColor('#CCC')
           .text(`Reference: ${transaction.transaction_ref} | Generated: ${new Date().toISOString()}`, 50, 750, { align: 'center' });
        
        // Finalize PDF
        doc.end();
        
      } catch (error) {
        reject(error);
      }
    });
  }

  // Get transaction type label
  static getTransactionType(metadata) {
    if (!metadata || !metadata.type) return 'Transfer';
    
    const types = {
      'transfer': 'Money Transfer',
      'bill_payment': 'Bill Payment',
      'qr_payment': 'QR Payment',
      'request_payment': 'Request Payment',
      'scheduled_transfer': 'Scheduled Transfer',
      'savings_deposit': 'Savings Deposit',
      'savings_withdrawal': 'Savings Withdrawal',
      'remittance': 'International Remittance'
    };
    
    return types[metadata.type] || 'Transaction';
  }

  // Generate receipt image (alternative to PDF)
  static async generateReceiptImage(transactionRef, userId) {
    try {
      // Get transaction details (same as above)
      const query = `
        SELECT 
          le.*,
          u.name as user_name,
          u.phone as user_phone,
          acc.account_number
        FROM ledger_entries le
        JOIN accounts acc ON acc.id = le.account_id
        JOIN users u ON u.id = acc.user_id
        WHERE le.transaction_ref = $1 
          AND acc.user_id = $2
      `;
      
      const result = await pool.query(query, [transactionRef, userId]);
      
      if (result.rows.length === 0) {
        throw new Error('Transaction not found');
      }
      
      const transaction = result.rows[0];
      const metadata = transaction.metadata || {};
      const otherParty = metadata.receiver_name || metadata.sender_name || 'Unknown';
      
      // Create HTML template
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <style>
            body {
              font-family: Arial, sans-serif;
              margin: 0;
              padding: 20px;
              background: white;
              width: 400px;
            }
            .header {
              text-align: center;
              padding: 20px 0;
              border-bottom: 2px solid #00A86B;
            }
            .logo {
              color: #00A86B;
              font-size: 32px;
              font-weight: bold;
            }
            .status {
              margin: 20px 0;
              text-align: center;
              font-size: 18px;
              font-weight: bold;
              color: ${transaction.entry_type === 'debit' ? '#DC3545' : '#28A745'};
            }
            .amount {
              text-align: center;
              font-size: 36px;
              font-weight: bold;
              color: #333;
              margin: 20px 0;
            }
            .details {
              background: #f8f9fa;
              border-radius: 8px;
              padding: 20px;
              margin: 20px 0;
            }
            .detail-row {
              display: flex;
              justify-content: space-between;
              padding: 8px 0;
              border-bottom: 1px solid #e0e0e0;
            }
            .detail-row:last-child {
              border-bottom: none;
            }
            .label {
              color: #666;
              font-size: 14px;
            }
            .value {
              color: #333;
              font-size: 14px;
              font-weight: 500;
              text-align: right;
            }
            .footer {
              text-align: center;
              margin-top: 30px;
              padding-top: 20px;
              border-top: 1px solid #e0e0e0;
              color: #999;
              font-size: 12px;
            }
            .qr-container {
              text-align: center;
              margin: 20px 0;
            }
            .security-notice {
              background: #FFF3CD;
              border: 1px solid #FFC107;
              border-radius: 4px;
              padding: 10px;
              margin: 20px 0;
              color: #856404;
              font-size: 12px;
            }
          </style>
        </head>
        <body>
          <div class="header">
            <div class="logo">PakPay</div>
            <div style="color: #666; font-size: 12px; margin-top: 5px;">Digital Payment Receipt</div>
          </div>
          
          <div class="status">
            ${transaction.entry_type === 'debit' ? 'PAYMENT SENT' : 'PAYMENT RECEIVED'}
          </div>
          
          <div class="amount">
            PKR ${parseFloat(transaction.amount).toLocaleString()}
          </div>
          
          <div class="details">
            <div class="detail-row">
              <span class="label">Transaction ID</span>
              <span class="value">${transaction.transaction_ref}</span>
            </div>
            <div class="detail-row">
              <span class="label">Date & Time</span>
              <span class="value">${new Date(transaction.created_at).toLocaleString('en-PK')}</span>
            </div>
            <div class="detail-row">
              <span class="label">${transaction.entry_type === 'debit' ? 'Sent To' : 'Received From'}</span>
              <span class="value">${otherParty}</span>
            </div>
            <div class="detail-row">
              <span class="label">Description</span>
              <span class="value">${transaction.description}</span>
            </div>
            <div class="detail-row">
              <span class="label">Balance After</span>
              <span class="value">PKR ${parseFloat(transaction.balance_after).toLocaleString()}</span>
            </div>
          </div>
          
          <div class="security-notice">
            ⚠️ Never share your PIN or OTP with anyone
          </div>
          
          <div class="footer">
            <div>This is a computer generated receipt</div>
            <div style="margin-top: 5px;">support@pakpay.pk | 0800-PAKPAY</div>
            <div style="margin-top: 10px; font-size: 10px; color: #ccc;">
              ${transaction.transaction_ref}
            </div>
          </div>
        </body>
        </html>
      `;
      
      return {
        html,
        transaction
      };
      
    } catch (error) {
      console.error('Generate receipt image error:', error);
      throw error;
    }
  }

  // Save receipt record
  static async saveReceiptRecord(userId, transactionRef, type = 'pdf') {
    try {
      await pool.query(
        `INSERT INTO receipt_downloads (
          user_id, transaction_ref, receipt_type, downloaded_at
        ) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
        [userId, transactionRef, type]
      );
    } catch (error) {
      console.error('Save receipt record error:', error);
    }
  }
}

module.exports = ReceiptService;
