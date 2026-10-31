const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

module.exports = function (pool) {
  const SECRET = process.env.JWT_SECRET || 'stock-inventory-dev-secret';
  const router = express.Router();
  const ROLES = ['admin', 'user', 'viewer'];

  const wrap = fn => (req, res, next) => fn(req, res, next).catch(e => {
    console.error(e);
    res.status(500).json({ error: e.message });
  });
  const bad = (res, msg, code) => res.status(code || 400).json({ error: msg });
  const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
  const PW_MSG = 'Password must be at least 8 characters and contain letters and numbers';
  const strongEnough = p => typeof p === 'string' && p.length >= 8 && /[A-Za-z]/.test(p) && /[0-9]/.test(p);
  const cleanUser = v => String(v || '').trim().toLowerCase();

  function readCookie(req, name) {
    const parts = (req.headers.cookie || '').split(';');
    for (const p of parts) {
      const i = p.indexOf('=');
      if (i > -1 && p.slice(0, i).trim() === name) return decodeURIComponent(p.slice(i + 1).trim());
    }
    return null;
  }
  const setCookie = (res, token) => res.setHeader('Set-Cookie', 'token=' + encodeURIComponent(token) + '; HttpOnly; Path=/; SameSite=Strict; Max-Age=' + (8 * 3600));
  const clearCookie = res => res.setHeader('Set-Cookie', 'token=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0');

  // Identifies the logged-in user from the cookie
  const requireAuth = wrap(async (req, res, next) => {
    const t = readCookie(req, 'token');
    if (!t) return bad(res, 'Please login', 401);
    let data;
    try { data = jwt.verify(t, SECRET); } catch (e) { return bad(res, 'Session expired. Please login again', 401); }
    const [[u]] = await pool.query('SELECT id, username, full_name, role, is_active, must_change FROM users WHERE id=?', [data.id]);
    if (!u || !u.is_active) return bad(res, 'Please login', 401);
    req.user = u;
    next();
  });

  const requireAdmin = (req, res, next) => {
    if (req.user.must_change) return bad(res, 'Please set a new password first', 403);
    if (req.user.role !== 'admin') return bad(res, 'Admin only', 403);
    next();
  };

  // All stock /api routes pass through here
  // admin: everything | user: add and edit, no delete | viewer: view only
  const guard = [requireAuth, (req, res, next) => {
    if (req.user.must_change) return bad(res, 'Please set a new password first', 403);
    const role = req.user.role;
    if (role === 'admin') return next();
    if (req.method === 'GET') return next();
    if (role === 'user') {
      if (req.method === 'DELETE') return bad(res, 'You do not have permission to delete', 403);
      return next();
    }
    return bad(res, 'View only access: you cannot change data', 403);
  }];

  // ---------- Login ----------
  const fails = {};
  router.post('/login', wrap(async (req, res) => {
    const username = cleanUser(req.body.username);
    const password = String(req.body.password || '');
    if (!username || !password) return bad(res, 'Enter username and password');
    const f = fails[username];
    if (f && f.n >= 5 && Date.now() - f.t < 10 * 60 * 1000) return bad(res, 'Too many wrong attempts. Try again after 10 minutes', 429);
    const [[u]] = await pool.query('SELECT * FROM users WHERE username=?', [username]);
    const ok = u && u.is_active && await bcrypt.compare(password, u.password_hash);
    if (!ok) {
      fails[username] = { n: (f && Date.now() - f.t < 10 * 60 * 1000 ? f.n : 0) + 1, t: Date.now() };
      return bad(res, 'Wrong username or password', 401);
    }
    delete fails[username];
    setCookie(res, jwt.sign({ id: u.id }, SECRET, { expiresIn: '8h' }));
    res.json({ ok: true, must_change: !!u.must_change, role: u.role, name: u.full_name });
  }));

  router.post('/logout', (req, res) => { clearCookie(res); res.json({ ok: true }); });

  router.get('/me', requireAuth, (req, res) => {
    const u = req.user;
    res.json({ id: u.id, username: u.username, full_name: u.full_name, role: u.role, must_change: !!u.must_change });
  });

  // ---------- New password / Change password ----------
  router.post('/change-password', requireAuth, wrap(async (req, res) => {
    const np = req.body.new_password;
    if (!strongEnough(np)) return bad(res, PW_MSG);
    if (!req.user.must_change) {
      const [[u]] = await pool.query('SELECT password_hash FROM users WHERE id=?', [req.user.id]);
      if (!(await bcrypt.compare(String(req.body.current_password || ''), u.password_hash))) return bad(res, 'Current password is wrong');
    }
    await pool.query('UPDATE users SET password_hash=?, must_change=0 WHERE id=?', [await bcrypt.hash(np, 10), req.user.id]);
    res.json({ ok: true });
  }));

  // ---------- Forgot password ----------
  router.post('/forgot', wrap(async (req, res) => {
    const username = cleanUser(req.body.username);
    const [[u]] = await pool.query('SELECT id FROM users WHERE username=? AND is_active=1', [username]);
    if (u) {
      const [[p]] = await pool.query("SELECT id FROM reset_requests WHERE user_id=? AND status='pending'", [u.id]);
      if (!p) await pool.query('INSERT INTO reset_requests (user_id) VALUES (?)', [u.id]);
    }
    res.json({ ok: true, message: 'Request sent. Ask the admin (IT) for your reset code.' });
  }));

  // ---------- Reset password (code given by admin + new password) ----------
  router.post('/reset', wrap(async (req, res) => {
    const username = cleanUser(req.body.username);
    const code = String(req.body.code || '').trim();
    const np = req.body.new_password;
    const invalid = 'Invalid or expired code. Ask the admin for a new one.';
    if (!username || !code) return bad(res, 'Enter username and reset code');
    if (!strongEnough(np)) return bad(res, PW_MSG);
    const [[u]] = await pool.query('SELECT id FROM users WHERE username=? AND is_active=1', [username]);
    let r = null;
    if (u) {
      const [rows] = await pool.query("SELECT * FROM reset_requests WHERE user_id=? AND status='approved' AND expires_at > NOW() ORDER BY id DESC LIMIT 1", [u.id]);
      r = rows[0];
    }
    if (!r) return bad(res, invalid);
    if (sha(code) !== r.code_hash) {
      const attempts = r.attempts + 1;
      await pool.query('UPDATE reset_requests SET attempts=?, status=? WHERE id=?', [attempts, attempts >= 5 ? 'rejected' : 'approved', r.id]);
      return bad(res, invalid);
    }
    await pool.query('UPDATE users SET password_hash=?, must_change=0 WHERE id=?', [await bcrypt.hash(np, 10), u.id]);
    await pool.query("UPDATE reset_requests SET status='used' WHERE id=?", [r.id]);
    res.json({ ok: true });
  }));

  // ---------- Admin: users and reset requests ----------
  router.get('/users', requireAuth, requireAdmin, wrap(async (req, res) => {
    const [users] = await pool.query('SELECT id, username, full_name, email, role, is_active, created_at FROM users ORDER BY id');
    const [requests] = await pool.query(
      "SELECT r.id, r.status, r.created_at, r.expires_at, u.username, u.full_name FROM reset_requests r JOIN users u ON u.id=r.user_id WHERE r.status IN ('pending','approved') ORDER BY r.id DESC");
    res.json({ users, requests });
  }));

  router.post('/users', requireAuth, requireAdmin, wrap(async (req, res) => {
    const b = req.body;
    const username = cleanUser(b.username);
    const name = String(b.full_name || '').trim();
    const role = ROLES.includes(b.role) ? b.role : 'viewer';
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) return bad(res, 'Username: 3-30 characters (a-z, 0-9, . _ -)');
    if (!name) return bad(res, 'Enter full name');
    if (!strongEnough(b.password)) return bad(res, PW_MSG);
    const [[ex]] = await pool.query('SELECT id FROM users WHERE username=?', [username]);
    if (ex) return bad(res, 'Username already exists');
    await pool.query('INSERT INTO users (username, full_name, email, password_hash, role, must_change) VALUES (?,?,?,?,?,1)',
      [username, name, String(b.email || '').trim() || null, await bcrypt.hash(b.password, 10), role]);
    res.json({ ok: true });
  }));

  // Change the role of an existing user
  router.put('/users/:id/role', requireAuth, requireAdmin, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const role = String(req.body.role || '');
    if (id === req.user.id) return bad(res, 'You cannot change your own role');
    if (!ROLES.includes(role)) return bad(res, 'Invalid role');
    const [r] = await pool.query('UPDATE users SET role=? WHERE id=?', [role, id]);
    if (!r.affectedRows) return bad(res, 'User not found');
    res.json({ ok: true });
  }));

  router.put('/users/:id/active', requireAuth, requireAdmin, wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) return bad(res, 'You cannot deactivate your own account');
    await pool.query('UPDATE users SET is_active=? WHERE id=?', [req.body.active ? 1 : 0, id]);
    res.json({ ok: true });
  }));

  router.post('/requests/:id/approve', requireAuth, requireAdmin, wrap(async (req, res) => {
    const code = String(crypto.randomInt(100000, 1000000));
    const [r] = await pool.query(
      "UPDATE reset_requests SET status='approved', code_hash=?, expires_at=DATE_ADD(NOW(), INTERVAL 30 MINUTE), attempts=0 WHERE id=? AND status IN ('pending','approved')",
      [sha(code), req.params.id]);
    if (!r.affectedRows) return bad(res, 'Request not found');
    res.json({ ok: true, code });
  }));

  router.post('/requests/:id/reject', requireAuth, requireAdmin, wrap(async (req, res) => {
    await pool.query("UPDATE reset_requests SET status='rejected' WHERE id=?", [req.params.id]);
    res.json({ ok: true });
  }));

  // ---------- First admin (only when there are no users) ----------
  (async () => {
    try {
      const [[c]] = await pool.query('SELECT COUNT(*) AS n FROM users');
      if (c.n === 0) {
        await pool.query("INSERT INTO users (username, full_name, password_hash, role, must_change) VALUES ('admin','Administrator',?, 'admin', 1)",
          [await bcrypt.hash('Admin@123', 10)]);
        console.log('First admin created -> username: admin | password: Admin@123 (you will be asked to set a new password)');
      }
    } catch (e) { console.log('Users table not ready: ' + e.message); }
  })();

  return { router, guard };
};