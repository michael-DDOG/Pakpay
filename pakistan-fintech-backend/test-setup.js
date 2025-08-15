// backend/test-setup.js
require('dotenv').config();
const db = require('./config/database');

async function testSetup() {
  try {
    console.log('Testing database setup...\n');
    
    // Test connection
    const connection = await db.query('SELECT NOW()');
    console.log('✅ Database connected:', connection.rows[0].now);
    
    // Check tables
    const tables = await db.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name
    `);
    console.log('\n✅ Tables found:');
    tables.rows.forEach(t => console.log(`   - ${t.table_name}`));
    
    // Check users
    const users = await db.query('SELECT phone, name FROM users');
    console.log('\n✅ Test users:');
    users.rows.forEach(u => console.log(`   - ${u.name}: ${u.phone}`));
    
    console.log('\n🎉 Everything looks good!');
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
  process.exit();
}

testSetup();
