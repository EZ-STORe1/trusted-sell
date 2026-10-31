'use strict';
/** EZ-STORE dependency-free server: Node.js >= 22.13, no npm install. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const tls = require('node:tls');
const { DatabaseSync } = require('node:sqlite');
const { PRODUCTS, byId, money } = require('./config/products.js');
const ROOT = __dirname;

function loadEnv(file) {
  if (!fs.existsSync(file)) return {};
  const output = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let val = match[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    output[match[1]] = val;
  }
  return output;
}
const env = { ...loadEnv(path.join(ROOT, '.env')), ...process.env };
const PORT = Number(env.PORT) || 3000;
const PUBLIC_URL = (env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ADMIN_EMAIL = (env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = env.ADMIN_PASSWORD || '';
const MAX_INVENTORY = 10000;
const SMTP_READY = Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.MAIL_FROM && (env.SMTP_SECURE !== 'false') && Number(env.SMTP_PORT || 465) === 465);
const USDT_ADDRESS = (env.USDT_TRC20_ADDRESS || '').trim();
const USDT_READY = /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(USDT_ADDRESS);
const CHECKOUT_READY = USDT_READY && SMTP_READY;
if (!ADMIN_EMAIL || ADMIN_PASSWORD.length < 12 || !/^[a-fA-F0-9]{64}$/.test(env.APP_SECRET || '') || !/^[a-fA-F0-9]{64}$/.test(env.INVENTORY_ENCRYPTION_KEY || '')) {
  console.error('Configuration missing. Run: node scripts/setup.js (creates .env)');
  process.exit(1);
}
const SECRET = Buffer.from(env.APP_SECRET, 'hex');
const KEY = Buffer.from(env.INVENTORY_ENCRYPTION_KEY, 'hex');
const now = () => new Date().toISOString();
const sha = input => crypto.createHash('sha256').update(input).digest('hex');
const fingerprint = (id, str) => crypto.createHmac('sha256', SECRET).update(id + '\0' + str).digest('hex');
const random = () => crypto.randomBytes(32).toString('base64url');
const eq = (a, b) => {
  const aa = Buffer.from(a, 'hex'); const bb = Buffer.from(b, 'hex');
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
};
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}
function decrypt(text) {
  const b = Buffer.from(text, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, b.subarray(0, 12));
  decipher.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([decipher.update(b.subarray(28)), decipher.final()]).toString('utf8');
}
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
const db = new DatabaseSync(path.join(ROOT, 'data', 'store.sqlite'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
db.exec(`
CREATE TABLE IF NOT EXISTS orders (
 id TEXT PRIMARY KEY, access_hash TEXT NOT NULL, product_id TEXT NOT NULL,
 email TEXT NOT NULL, quantity INTEGER NOT NULL, total_cents INTEGER NOT NULL,
 paypal_order_id TEXT UNIQUE, paypal_capture_id TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'pending',
 delivery_status TEXT NOT NULL DEFAULT 'pending', last_error TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inventory (
 id INTEGER PRIMARY KEY AUTOINCREMENT, product_id TEXT NOT NULL,
 encrypted_payload TEXT NOT NULL, fingerprint TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'available', order_id TEXT REFERENCES orders(id), created_at TEXT NOT NULL,
 UNIQUE(product_id,fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_stock ON inventory(product_id,status,id);
CREATE INDEX IF NOT EXISTS idx_orderstock ON inventory(order_id,status);
CREATE TABLE IF NOT EXISTS usdt_claims (
 order_id TEXT PRIMARY KEY REFERENCES orders(id), txid TEXT NOT NULL UNIQUE,
 created_at TEXT NOT NULL, verified_at TEXT
);
CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL);
`);
const stmt = sql => db.prepare(sql);
function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (err) { db.exec('ROLLBACK'); throw err; }
}
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const queryOrder = id => stmt('SELECT * FROM orders WHERE id=?').get(id);
function closePendingOrder(id, status) {
  return transaction(() => {
    const n = stmt("UPDATE orders SET status=?,updated_at=? WHERE id=? AND status='pending'").run(status, now(), id).changes;
    if (n) stmt("UPDATE inventory SET status='available',order_id=NULL WHERE order_id=? AND status='reserved'").run(id);
    return Boolean(n);
  });
}
function reserve(productId, email, quantity, accessToken) {
  return transaction(() => {
    const p = byId[productId];
    if (!p) throw new HttpError(404, 'المنتوج غير موجود');
    const rows = stmt("SELECT id FROM inventory WHERE product_id=? AND status='available' ORDER BY id LIMIT ?").all(productId, quantity);
    if (rows.length !== quantity) throw new HttpError(409, 'لم يتبق أي منتوج بالكمية المطلوبة');
    const id = crypto.randomUUID();
    stmt("INSERT INTO orders(id,access_hash,product_id,email,quantity,total_cents,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'pending',?,?)")
      .run(id, sha(accessToken), productId, email, quantity, p.priceCents * quantity, now(), now());
    for (const row of rows) stmt("UPDATE inventory SET status='reserved',order_id=? WHERE id=? AND status='available'").run(id, row.id);
    return queryOrder(id);
  });
}
function completeOrder(order, captureId) {
  return transaction(() => {
    const current = queryOrder(order.id);
    if (!current) return false;
    if (current.status === 'paid') return true;
    if (!['pending', 'capturing'].includes(current.status)) {
      stmt("UPDATE orders SET status='needs_review',last_error='Payment arrived after reservation ended',updated_at=? WHERE id=?").run(now(), order.id);
      return false;
    }
    const reserved = stmt("SELECT COUNT(*) n FROM inventory WHERE order_id=? AND status='reserved'").get(order.id).n;
    if (reserved !== current.quantity) {
      stmt("UPDATE orders SET status='needs_review',last_error='Reserved quantity mismatch',updated_at=? WHERE id=?").run(now(), order.id);
      return false;
    }
    stmt("UPDATE inventory SET status='sold' WHERE order_id=? AND status='reserved'").run(order.id);
    stmt("UPDATE orders SET status='paid',paypal_capture_id=?,updated_at=? WHERE id=?").run(captureId, now(), order.id);
    return true;
  });
}
function smtpMessage(from, to, subject, body) {
  const displayName = from.match(/^(.+?)\s*<([^<>@\s]+@[^<>@\s]+)>$/);
  const addr = displayName ? displayName[2] : from.trim();
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(addr) || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(to)) throw new Error('Bad mail address');
  const safeName = displayName ? displayName[1].replace(/[\r\n"]/g, '').trim() : 'EZ-STORE';
  const enc = str => `=?UTF-8?B?${Buffer.from(str, 'utf8').toString('base64')}?=`;
  const raw = [
    `From: ${enc(safeName)} <${addr}>`, `To: <${to}>`, `Subject: ${enc(subject)}`,
    `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomUUID()}@ez-store.local>`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64',
    '', Buffer.from(body, 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') || '', ''
  ].join('\r\n');
  return { addr, data: raw.replace(/^\./gm, '..') };
}
async function sendMail(to, subject, text) {
  if (!SMTP_READY) throw new Error('SMTP not configured or not TLS port 465');
  const host = env.SMTP_HOST;
  const { addr, data } = smtpMessage(env.MAIL_FROM, to, subject, text);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port: 465, servername: host, rejectUnauthorized: true });
    socket.setTimeout(25000);
    let buffer = ''; const replies = []; const waiters = [];
    let accumulated = [];
    let settled = false;
    const fail = err => {
      if (settled) return;
      settled = true; socket.destroy(); reject(err instanceof Error ? err : new Error(String(err)));
    };
    socket.on('error', fail);
    socket.on('timeout', () => fail(new Error('SMTP timeout')));
    socket.on('close', () => { if (!settled) fail(new Error('SMTP connection closed')); });
    socket.on('data', bytes => {
      buffer += bytes.toString('utf8');
      for (let idx; (idx = buffer.indexOf('\n')) !== -1;) {
        const line = buffer.slice(0, idx).replace(/\r$/, ''); buffer = buffer.slice(idx + 1);
        if (!/^\d{3}[ -]/.test(line)) continue;
        accumulated.push(line);
        if (line[3] === ' ') {
          const reply = { code: Number(line.slice(0, 3)), lines: accumulated.join('\n') };
          accumulated = [];
          const waiter = waiters.shift(); if (waiter) waiter(reply); else replies.push(reply);
        }
      }
    });
    const next = () => new Promise(r => { const cached = replies.shift(); if (cached) r(cached); else waiters.push(r); });
    const cmd = async (line, expect) => {
      socket.write(line + '\r\n'); const reply = await next();
      if (!expect.includes(reply.code)) throw new Error(`SMTP code ${reply.code}: ${reply.lines.slice(0, 180)}`);
      return reply;
    };
    const run = async () => {
      const hello = await next(); if (hello.code !== 220) throw new Error('SMTP server rejected connection');
      await cmd('EHLO ez-store.local', [250]);
      await cmd('AUTH LOGIN', [334]);
      await cmd(Buffer.from(env.SMTP_USER).toString('base64'), [334]);
      await cmd(Buffer.from(env.SMTP_PASS).toString('base64'), [235]);
      await cmd(`MAIL FROM:<${addr}>`, [250]);
      await cmd(`RCPT TO:<${to}>`, [250, 251]);
      await cmd('DATA', [354]);
      await cmd(data + '\r\n.', [250]);
      await cmd('QUIT', [221]);
      settled = true; socket.end(); resolve();
    };
    void run().catch(fail);
  });
}
async function deliver(id) {
  const order = queryOrder(id);
  if (!order || order.status !== 'paid') return;
  if (!stmt("UPDATE orders SET delivery_status='sending',updated_at=? WHERE id=? AND status='paid' AND delivery_status IN ('pending','failed')").run(now(), id).changes) return;
  try {
    const items = stmt("SELECT encrypted_payload FROM inventory WHERE order_id=? AND status='sold' ORDER BY id").all(id);
    if (items.length !== order.quantity) throw new Error('Quantity mismatch; manual review required');
    const lines = items.map((item, idx) => `${idx + 1}. ${decrypt(item.encrypted_payload)}`);
    const message = `Thank you for your order from EZ-STORE.\n\nOrder: ${id}\nProduct: ${byId[order.product_id].name}\nQuantity: ${order.quantity}\nTotal: $${money(order.total_cents)} USD\n\nYOUR ITEMS:\n${lines.join('\n')}\n\nKeep these details private.`;
    await sendMail(order.email, `EZ-STORE - your order ${id.slice(0, 8)}`, message);
    stmt("UPDATE orders SET delivery_status='sent',last_error=NULL,updated_at=? WHERE id=?").run(now(), id);
  } catch (err) {
    stmt("UPDATE orders SET delivery_status='failed',last_error=?,updated_at=? WHERE id=?").run(String(err.message).slice(0, 300), now(), id);
    console.error('Email failure:', id, err.message);
  }
}
const configOrigin = new URL(PUBLIC_URL).origin;
function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}
function respondText(res, code, text) { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(text); }
function parseCookies(header) {
  const obj = {};
  for (const part of (header || '').split(';')) { const eq = part.indexOf('='); if (eq > 0) obj[part.slice(0, eq).trim()] = part.slice(eq + 1).trim(); }
  return obj;
}
async function bodyJSON(req, maxBytes = 64000) {
  const type = req.headers['content-type'] || '';
  if (!type.startsWith('application/json')) throw new HttpError(415, 'Use application/json');
  let total = 0; const chunks = [];
  for await (const chunk of req) { total += chunk.length; if (total > maxBytes) throw new HttpError(413, 'Data too large'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON'); }
}
const limiter = new Map();
function limit(req, group, cap, durationMs) {
  const key = `${group}|${req.socket.remoteAddress || 'unknown'}`; const ts = Date.now();
  const bucket = limiter.get(key);
  if (!bucket || ts - bucket.first > durationMs) { limiter.set(key, { first: ts, n: 1 }); return; }
  bucket.n++;
  if (bucket.n > cap) throw new HttpError(429, 'Too many requests, try later');
}
setInterval(() => { const old = Date.now() - 3600000; for (const [k,v] of limiter) if (v.first < old) limiter.delete(k); }, 600000).unref();
function authenticate(req) {
  const token = parseCookies(req.headers.cookie).ez_admin;
  if (!token || token.length > 200) throw new HttpError(401, 'خصك تدخل للإدارة');
  const session = stmt('SELECT expires_at FROM admin_sessions WHERE token_hash=?').get(sha(token));
  if (!session || session.expires_at < now()) throw new HttpError(401, 'انتهات الجلسة');
  return token;
}
function authenticOrder(id, token) {
  const order = typeof id === 'string' ? queryOrder(id) : null;
  if (!order || typeof token !== 'string' || token.length > 128 || !eq(order.access_hash, sha(token))) throw new HttpError(404, 'الطلب غير موجود');
  return order;
}
const contentTypes = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon'
};
function staticFile(res, folder, relative) {
  if (relative.includes('\0') || relative.includes('\\') || relative.split('/').some(p => p === '..' || p.startsWith('.'))) throw new HttpError(404, 'Page not found');
  const target = path.resolve(folder, relative);
  if (!target.startsWith(path.resolve(folder) + path.sep)) throw new HttpError(404, 'Page not found');
  let st;
  try { st = fs.statSync(target); } catch { throw new HttpError(404, 'Page not found'); }
  const type = contentTypes[path.extname(target).toLowerCase()];
  if (!st.isFile() || !type) throw new HttpError(404, 'Page not found');
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': type.startsWith('text/html') ? 'no-store' : 'public, max-age=300' });
  fs.createReadStream(target).pipe(res);
}
function cleanup() {
  const threshold = new Date(Date.now() - 2 * 3600000).toISOString();
  const rows = stmt("SELECT id FROM orders WHERE status='pending' AND created_at < ? AND id NOT IN (SELECT order_id FROM usdt_claims) LIMIT 200").all(threshold);
  for (const row of rows) closePendingOrder(row.id, 'expired');
  stmt('DELETE FROM admin_sessions WHERE expires_at < ?').run(now());
}
cleanup(); setInterval(cleanup, 600000).unref();
async function handle(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'");
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const method = req.method;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const origin = req.headers.origin;
    if (origin && origin !== configOrigin) throw new HttpError(403, 'Origin denied');
  }
  if (method === 'GET' && pathname === '/api/health') return json(res, 200, { ok: true, checkoutConfigured: CHECKOUT_READY, usdtConfigured: USDT_READY });
  if (method === 'GET' && pathname === '/api/products') {
    const counts = Object.fromEntries(stmt("SELECT product_id,COUNT(*) n FROM inventory WHERE status='available' GROUP BY product_id").all().map(x => [x.product_id, x.n]));
    return json(res, 200, { products: PRODUCTS.map(p => ({ ...p, stock: counts[p.id] || 0 })), checkoutReady: CHECKOUT_READY, usdtReady: CHECKOUT_READY });
  }
  if (pathname === '/api/admin/login' && method === 'POST') {
    limit(req, 'login', 8, 15 * 60000);
    const body = await bodyJSON(req);
    const validEmail = typeof body.email === 'string' && body.email.trim().toLowerCase() === ADMIN_EMAIL;
    const candidate = typeof body.password === 'string' ? body.password.slice(0, 300) : '';
    const a = crypto.scryptSync(ADMIN_PASSWORD, SECRET, 64); const b = crypto.scryptSync(candidate, SECRET, 64);
    if (!validEmail || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'الإيميل أو كلمة السر غلط');
    const token = random();
    const expiry = new Date(Date.now() + 12 * 3600000).toISOString();
    stmt('INSERT INTO admin_sessions(token_hash,expires_at) VALUES(?,?)').run(sha(token), expiry);
    const secure = PUBLIC_URL.startsWith('https://') ? '; Secure' : '';
    return json(res, 200, { ok: true }, { 'Set-Cookie': `ez_admin=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secure}` });
  }
  if (pathname.startsWith('/api/admin/')) {
    const token = authenticate(req);
    if (pathname === '/api/admin/me' && method === 'GET') return json(res, 200, { email: ADMIN_EMAIL });
    if (pathname === '/api/admin/logout' && method === 'POST') {
      stmt('DELETE FROM admin_sessions WHERE token_hash=?').run(sha(token));
      return json(res, 200, { ok: true }, { 'Set-Cookie': 'ez_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
    }
    if (pathname === '/api/admin/summary' && method === 'GET') {
      const stock = stmt('SELECT product_id,status,COUNT(*) n FROM inventory GROUP BY product_id,status').all();
      const sales = stmt("SELECT COUNT(*) n,COALESCE(SUM(total_cents),0) cents FROM orders WHERE status='paid'").get();
      const orders = stmt('SELECT id,product_id,email,quantity,total_cents,status,delivery_status,created_at,last_error,(SELECT txid FROM usdt_claims WHERE order_id=orders.id) usdt_txid FROM orders ORDER BY created_at DESC LIMIT 100').all();
      const active = stmt("SELECT COUNT(*) n FROM inventory WHERE status <> 'sold'").get().n;
      return json(res, 200, { totalInventory: active, maxInventory: MAX_INVENTORY, stock, sales, orders, checkoutReady: CHECKOUT_READY, usdtReady: CHECKOUT_READY });
    }
    if (pathname === '/api/admin/inventory' && method === 'POST') {
      limit(req, 'stock', 30, 60000);
      const body = await bodyJSON(req, 12 * 1024 * 1024);
      if (!byId[body.productId] || typeof body.lines !== 'string') throw new HttpError(400, 'اختار منتوج صحيح ولسق الحسابات');
      const lines = body.lines.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
      if (!lines.length || lines.length > MAX_INVENTORY || lines.some(x => x.length > 1000)) throw new HttpError(400, 'بين 1 و 10000 حساب، كل واحد أقل من 1000 حرف');
      const output = transaction(() => {
        let added = 0; let duplicates = 0;
        let total = stmt("SELECT COUNT(*) n FROM inventory WHERE status <> 'sold'").get().n;
        const exists = stmt('SELECT 1 FROM inventory WHERE product_id=? AND fingerprint=?');
        const insert = stmt("INSERT INTO inventory(product_id,encrypted_payload,fingerprint,status,created_at) VALUES(?,?,?,'available',?)");
        for (const item of lines) {
          const fp = fingerprint(body.productId, item);
          if (exists.get(body.productId, fp)) { duplicates++; continue; }
          if (total >= MAX_INVENTORY) throw new HttpError(409, 'وصلتي 10000 حساب (المخزون غير المباع)');
          insert.run(body.productId, encrypt(item), fp, now());
          total++; added++;
        }
        return { added, duplicates, total };
      });
      return json(res, 200, output);
    }
    // Inventory details are owner-only. Never expose decrypted credentials via public APIs.
    if (pathname === '/api/admin/inventory/items' && method === 'GET') {
      const productId = url.searchParams.get('productId') || '';
      const page = Number(url.searchParams.get('page') || 1);
      if (!byId[productId] || !Number.isSafeInteger(page) || page < 1 || page > 100000) throw new HttpError(400, 'Invalid product or page');
      const count = stmt("SELECT COUNT(*) n FROM inventory WHERE product_id=?").get(productId).n;
      const rows = stmt("SELECT id,encrypted_payload,status,created_at FROM inventory WHERE product_id=? ORDER BY id DESC LIMIT 50 OFFSET ?").all(productId, (page - 1) * 50);
      res.setHeader('Cache-Control', 'no-store');
      return json(res, 200, { total: count, page, pageSize: 50, items: rows.map(row => ({ id: row.id, value: decrypt(row.encrypted_payload), status: row.status, createdAt: row.created_at })) });
    }
    const deleteItem = pathname.match(/^\/api\/admin\/inventory\/items\/(\d+)$/);
    if (deleteItem && method === 'DELETE') {
      const result = stmt("DELETE FROM inventory WHERE id=? AND status='available'").run(Number(deleteItem[1]));
      if (!result.changes) throw new HttpError(409, 'Only available, unsold, unreserved accounts can be deleted');
      return json(res, 200, { ok: true });
    }
    // Owner-only bulk deletion. Only unsold, unreserved stock can be removed.
    if (pathname === '/api/admin/inventory/bulk-delete' && method === 'POST') {
      limit(req, 'bulk-delete', 10, 60000);
      const body = await bodyJSON(req, 2048);
      const productId = body.productId;
      const quantity = body.quantity;
      if (!byId[productId] || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_INVENTORY)
        throw new HttpError(400, 'Invalid product or quantity');
      const deleted = transaction(() => {
        const ids = stmt("SELECT id FROM inventory WHERE product_id=? AND status='available' ORDER BY id DESC LIMIT ?").all(productId, quantity);
        if (ids.length !== quantity) throw new HttpError(409, 'Not enough available accounts');
        const remove = stmt("DELETE FROM inventory WHERE id=? AND status='available'");
        for (const row of ids) if (remove.run(row.id).changes !== 1) throw new HttpError(409, 'Inventory changed; retry');
        return ids.length;
      });
      return json(res, 200, { ok: true, deleted });
    }
    const verifyUSDT = pathname.match(/^\/api\/admin\/orders\/([0-9a-f-]+)\/confirm-usdt$/);
    if (verifyUSDT && method === 'POST') {
      const order = queryOrder(verifyUSDT[1]);
      const claim = stmt('SELECT * FROM usdt_claims WHERE order_id=?').get(verifyUSDT[1]);
      if (!order || !claim || order.status !== 'pending') throw new HttpError(409, 'USDT order not pending');
      // Manual approval: owner must independently verify TRC20 transaction,
      // correct recipient, USDT token contract, amount, confirmations, and uniqueness.
      if (!completeOrder(order, 'USDT:' + claim.txid)) throw new HttpError(409, 'Inventory reservation mismatch');
      stmt('UPDATE usdt_claims SET verified_at=? WHERE order_id=?').run(now(), order.id);
      void deliver(order.id);
      return json(res, 200, { status: 'paid', deliveryStatus: 'pending' });
    }
    const rejectUSDT = pathname.match(/^\/api\/admin\/orders\/([0-9a-f-]+)\/reject-usdt$/);
    if (rejectUSDT && method === 'POST') {
      const order = queryOrder(rejectUSDT[1]);
      if (!order || !stmt('SELECT 1 FROM usdt_claims WHERE order_id=?').get(order.id) || order.status !== 'pending') throw new HttpError(409, 'USDT claim not pending');
      closePendingOrder(order.id, 'rejected');
      return json(res, 200, { status: 'rejected' });
    }
    const resend = pathname.match(/^\/api\/admin\/orders\/([0-9a-f-]+)\/resend$/);
    if (resend && method === 'POST') {
      const order = queryOrder(resend[1]);
      if (!order || order.status !== 'paid' || order.delivery_status === 'sent' || order.delivery_status === 'sending') throw new HttpError(409, 'الإرسال ما ممكنش دابا');
      await deliver(order.id);
      const updated = queryOrder(order.id);
      return json(res, 200, { deliveryStatus: updated.delivery_status, error: updated.last_error });
    }
    throw new HttpError(404, 'API route not found');
  }
  if (pathname === '/api/checkout/usdt' && method === 'POST') {
    limit(req, 'usdt-checkout', 15, 60000);
    if (!USDT_READY || !SMTP_READY) throw new HttpError(503, 'USDT wallet and SMTP must be configured');
    const body = await bodyJSON(req);
    if (!byId[body.productId] || !Number.isSafeInteger(body.quantity) || body.quantity < 1 || body.quantity > MAX_INVENTORY)
      throw new HttpError(400, 'Invalid product or quantity');
    if (typeof body.email !== 'string' || body.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email))
      throw new HttpError(400, 'Invalid email');
    const access = random();
    const order = reserve(body.productId, body.email.trim().toLowerCase(), body.quantity, access);
    return json(res, 201, { orderId: order.id, access, address: USDT_ADDRESS, network: 'TRC20', amount: money(order.total_cents),
      note: 'Manual verification required. Never send on another network.' });
  }
  if (pathname === '/api/usdt/claim' && method === 'POST') {
    limit(req, 'usdt-claim', 12, 60000);
    const body = await bodyJSON(req);
    const order = authenticOrder(body.orderId, body.access);
    if (order.status !== 'pending' || order.paypal_order_id) throw new HttpError(409, 'Order is not awaiting USDT');
    const txid = typeof body.txid === 'string' ? body.txid.trim().toLowerCase() : '';
    if (!/^[a-f0-9]{64}$/.test(txid)) throw new HttpError(400, 'Enter a valid TRON transaction hash (64 hex characters)');
    if (stmt('SELECT 1 FROM usdt_claims WHERE order_id=?').get(order.id)) throw new HttpError(409, 'Claim already submitted');
    try { stmt('INSERT INTO usdt_claims(order_id,txid,created_at) VALUES(?,?,?)').run(order.id, txid, now()); }
    catch { throw new HttpError(409, 'Transaction hash already used'); }
    return json(res, 202, { status: 'awaiting_manual_verification' });
  }
  const orderMatch = pathname.match(/^\/api\/order\/([0-9a-f-]+)$/);
  if (orderMatch && method === 'GET') {
    const order = authenticOrder(orderMatch[1], url.searchParams.get('access'));
    return json(res, 200, { id: order.id, product: byId[order.product_id]?.name, quantity: order.quantity,
      totalCents: order.total_cents, status: order.status, deliveryStatus: order.delivery_status, usdtClaimed: Boolean(stmt('SELECT 1 FROM usdt_claims WHERE order_id=?').get(order.id)) });
  }
  if (pathname.startsWith('/api/')) throw new HttpError(404, 'API route not found');
  if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
  if (pathname === '/') return staticFile(res, path.join(ROOT, 'public'), 'index.html');
  if (pathname === '/admin') return staticFile(res, path.join(ROOT, 'admin'), 'admin.html');
  if (pathname.startsWith('/admin/')) return staticFile(res, path.join(ROOT, 'admin'), pathname.slice(7));
  return staticFile(res, path.join(ROOT, 'public'), decodeURIComponent(pathname.slice(1)));
}
const server = http.createServer((req, res) => {
  void handle(req, res).catch(err => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error('Server error:', err);
    if (!res.headersSent) json(res, status, { error: status === 500 ? 'خطأ داخلي فالسيرفر' : err.message });
    else res.destroy();
  });
});
server.listen(PORT, () => {
  console.log(`\nEZ-STORE READY: http://localhost:${PORT}`);
  console.log(`ADMIN:          http://localhost:${PORT}/admin`);
  console.log(`No npm install required (Node ${process.version}).`);
  console.log(`USDT TRC20 ${USDT_READY ? 'configured' : 'not configured'} | SMTP ${SMTP_READY ? 'configured' : 'not configured'}`);
});
