'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const filepath = path.join(__dirname, '..', '.env');
if (fs.existsSync(filepath)) {
  console.log('Your .env already exists. Preserved; no secrets changed.');
  process.exit(0);
}
const password = crypto.randomBytes(20).toString('base64url');
const secret = crypto.randomBytes(32).toString('hex');
const key = crypto.randomBytes(32).toString('hex');
const contents = `PORT=3000\nPUBLIC_URL=http://localhost:3000\nADMIN_EMAIL=admin@example.com\nADMIN_PASSWORD=${password}\nAPP_SECRET=${secret}\nINVENTORY_ENCRYPTION_KEY=${key}\nUSDT_TRC20_ADDRESS=\nSMTP_HOST=\nSMTP_PORT=465\nSMTP_SECURE=true\nSMTP_USER=\nSMTP_PASS=\nMAIL_FROM="EZ-STORE <orders@yourdomain.com>"\n`;
fs.writeFileSync(filepath, contents, { mode: 0o600, flag: 'wx' });
console.log('\nCONFIGURATION CREATED - SAVE YOUR PASSWORD\n');
console.log('Admin URL: http://localhost:3000/admin');
console.log('Admin email: admin@example.com');
console.log('Admin password: ' + password);
console.log('\nKeep .env private. Configure USDT TRC20 receiving address + SMTP for real purchases.\n');
