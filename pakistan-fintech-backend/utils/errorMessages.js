const errorMessages = {
  en: {
    insufficientBalance: 'Insufficient balance',
    invalidCredentials: 'Invalid credentials',
    userNotFound: 'User not found',
    transactionFailed: 'Transaction failed',
    invalidCNIC: 'Invalid CNIC format',
    cnicNotVerified: 'CNIC verification failed',
    kycRequired: 'KYC verification required',
    dailyLimitExceeded: 'Daily transaction limit exceeded',
    invalidAmount: 'Invalid amount',
    serviceUnavailable: 'Service temporarily unavailable',
    invalidPhone: 'Invalid phone number',
    otpExpired: 'OTP has expired',
    tooManyAttempts: 'Too many attempts. Please try again later',
    accountLocked: 'Account is locked. Please contact support',
    remittanceNotSupported: 'Remittance from this country is not supported'
  },
  ur: {
    insufficientBalance: 'ناکافی بیلنس',
    invalidCredentials: 'غلط اسناد',
    userNotFound: 'صارف نہیں ملا',
    transactionFailed: 'لین دین ناکام',
    invalidCNIC: 'غلط شناختی کارڈ فارمیٹ',
    cnicNotVerified: 'شناختی کارڈ کی تصدیق ناکام',
    kycRequired: 'KYC تصدیق درکار ہے',
    dailyLimitExceeded: 'یومیہ لین دین کی حد ختم',
    invalidAmount: 'غلط رقم',
    serviceUnavailable: 'سروس عارضی طور پر دستیاب نہیں',
    invalidPhone: 'غلط فون نمبر',
    otpExpired: 'OTP کی میعاد ختم',
    tooManyAttempts: 'بہت زیادہ کوششیں۔ براہ کرم بعد میں کوشش کریں',
    accountLocked: 'اکاؤنٹ بند ہے۔ سپورٹ سے رابطہ کریں',
    remittanceNotSupported: 'اس ملک سے ترسیلات زر کی سہولت دستیاب نہیں'
  }
};

const getErrorMessage = (key, language = 'en') => {
  return errorMessages[language][key] || errorMessages.en[key] || 'An error occurred';
};

module.exports = { getErrorMessage, errorMessages };
