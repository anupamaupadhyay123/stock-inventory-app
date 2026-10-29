require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

(async () => {
  const pw = process.argv[2];
  if (!pw || pw.length < 8) {
    console.log('Use: node reset-admin.js NewPassword123');
    process.exit(1);
  }
  const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'stock_inventory'
  });
  const hash = await bcrypt.hash(pw, 10);
  const [r] = await pool.query("UPDATE users SET password_hash=?, must_change=1, is_active=1 WHERE username='admin'", [hash]);
  console.log(r.affectedRows ? 'Admin password reset. Login and set a new password.' : 'admin user not found');
  process.exit(0);
})();