const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function updatePassword() {
  const phone = '03123456789';
  const newPassword = 'TempPassword123';
  const hash = await bcrypt.hash(newPassword, 10);
  
  await pool.query(
    'UPDATE users SET password_hash = $1 WHERE phone_number = $2',
    [hash, phone]
  );
  
  console.log(`Password updated for ${phone}`);
  console.log('New password: TempPassword123');
  process.exit(0);
}

updatePassword();
