const express = require('express');
const router = express.Router();
let db = require('../db');
db = db.pool || db;
if (typeof db.promise === 'function') db = db.promise();
const { verifyToken } = require('../middleware/auth');

router.use(verifyToken);

const only = (...roles) => (req, res, next) =>
  roles.includes((req.user || {}).role) ? next() : res.status(403).json({ error: 'Access denied' });

const h = fn => (req, res) =>
  fn(req, res).catch(e => {
    console.error('stock error:', e);
    if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'This code already exists' });
    res.status(500).json({ error: e.message });
  });

async function tx(fn) {
  const c = await db.getConnection();
  try {
    await c.beginTransaction();
    const r = await fn(c);
    await c.commit();
    return r;
  } catch (e) {
    await c.rollback();
    throw e;
  } finally {
    c.release();
  }
}

async function nextNo(conn, table, prefix) {
  const [r] = await conn.query('SELECT IFNULL(MAX(id),0)+1 AS n FROM pmo_dashboard.' + table);
  return prefix + String(r[0].n).padStart(4, '0');
}

const today = () => new Date().toISOString().slice(0, 10);
const r2 = n => Math.round(Number(n || 0) * 100) / 100;

/* ---------------- LOCATIONS: one-time setup (runs on server start) ---------------- */
(async () => {
  try {
    await db.query(
      'CREATE TABLE IF NOT EXISTS pmo_dashboard.locations (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL)'
    );
    const [c] = await db.query('SELECT COUNT(*) AS n FROM pmo_dashboard.locations');
    if (!c[0].n) {
      await db.query("INSERT INTO pmo_dashboard.locations (name) VALUES ('Plant 1'),('Store'),('Office')");
    }
    try {
      await db.query('ALTER TABLE pmo_dashboard.stock_indents ADD COLUMN location_id INT NULL');
    } catch (e) { /* column already exists */ }
    // remove duplicate location names (keep the lowest id)
    try {
      await db.query(
        'UPDATE pmo_dashboard.stock_indents si ' +
        'JOIN pmo_dashboard.locations l1 ON l1.id=si.location_id ' +
        'JOIN (SELECT name, MIN(id) AS mid FROM pmo_dashboard.locations GROUP BY name) m ON m.name=l1.name ' +
        'SET si.location_id=m.mid'
      );
      await db.query(
        'DELETE l1 FROM pmo_dashboard.locations l1 ' +
        'JOIN pmo_dashboard.locations l2 ON l1.name=l2.name AND l1.id>l2.id'
      );
    } catch (e) { console.log('locations cleanup skipped:', e.message); }
  } catch (e) {
    console.log('locations setup error:', e.message);
  }
})();

/* ---------------- DEPARTMENTS ---------------- */
router.get('/departments', h(async (req, res) => {
  const [rows] = await db.query('SELECT id, name FROM pmo_dashboard.departments ORDER BY name');
  res.json(rows);
}));

/* ---------------- LOCATIONS ---------------- */
router.get('/locations', h(async (req, res) => {
  const [rows] = await db.query('SELECT id, name FROM pmo_dashboard.locations ORDER BY name');
  res.json(rows);
}));

router.post('/locations', only('admin'), h(async (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  const [ex] = await db.query('SELECT id, name FROM pmo_dashboard.locations WHERE name=?', [name]);
  if (ex.length) return res.json({ id: ex[0].id, name: ex[0].name });
  const [r] = await db.query('INSERT INTO pmo_dashboard.locations (name) VALUES (?)', [name]);
  res.json({ id: r.insertId, name });
}));

/* ---------------- HSN CODE ---------------- */
router.get('/hsn', h(async (req, res) => {
  const [rows] = await db.query('SELECT * FROM pmo_dashboard.stock_hsn WHERE is_active=1 ORDER BY hsn_code');
  res.json(rows);
}));

router.post('/hsn', only('admin'), h(async (req, res) => {
  const b = req.body;
  if (!b.hsn_code || !String(b.hsn_code).trim()) return res.status(400).json({ error: 'HSN code is required' });
  await db.query(
    'INSERT INTO pmo_dashboard.stock_hsn (hsn_code,description,gst_percent) VALUES (?,?,?)',
    [String(b.hsn_code).trim(), b.description || null, b.gst_percent === '' || b.gst_percent == null ? 18 : Number(b.gst_percent)]
  );
  res.json({ ok: true });
}));

router.put('/hsn/:id', only('admin'), h(async (req, res) => {
  const b = req.body;
  if (!b.hsn_code || !String(b.hsn_code).trim()) return res.status(400).json({ error: 'HSN code is required' });
  await db.query(
    'UPDATE pmo_dashboard.stock_hsn SET hsn_code=?, description=?, gst_percent=? WHERE id=?',
    [String(b.hsn_code).trim(), b.description || null, b.gst_percent === '' || b.gst_percent == null ? 18 : Number(b.gst_percent), req.params.id]
  );
  res.json({ ok: true });
}));

router.delete('/hsn/:id', only('admin'), h(async (req, res) => {
  const [u] = await db.query('SELECT COUNT(*) AS n FROM pmo_dashboard.stock_items WHERE hsn_id=? AND is_active=1', [req.params.id]);
  if (u[0].n > 0) return res.status(400).json({ error: 'This HSN is used by items. Change those items first.' });
  await db.query('DELETE FROM pmo_dashboard.stock_hsn WHERE id=?', [req.params.id]);
  res.json({ ok: true });
}));

/* ---------------- VENDOR ---------------- */
router.get('/vendors', h(async (req, res) => {
  const [rows] = await db.query('SELECT * FROM pmo_dashboard.stock_vendors WHERE is_active=1 ORDER BY name');
  res.json(rows);
}));

router.post('/vendors', only('admin'), h(async (req, res) => {
  const b = req.body;
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'Vendor name is required' });
  const [m] = await db.query("SELECT IFNULL(MAX(CAST(SUBSTRING(vendor_code,5) AS UNSIGNED)),0)+1 AS n FROM pmo_dashboard.stock_vendors");
  const code = 'VND-' + String(m[0].n).padStart(3, '0');
  await db.query(
    'INSERT INTO pmo_dashboard.stock_vendors (vendor_code,name,phone,email,address,gst_no) VALUES (?,?,?,?,?,?)',
    [code, String(b.name).trim(), b.phone || null, b.email || null, b.address || null, b.gst_no || null]
  );
  res.json({ ok: true, vendor_code: code });
}));

router.put('/vendors/:id', only('admin'), h(async (req, res) => {
  const b = req.body;
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'Vendor name is required' });
  await db.query(
    'UPDATE pmo_dashboard.stock_vendors SET name=?, phone=?, email=?, address=?, gst_no=? WHERE id=?',
    [String(b.name).trim(), b.phone || null, b.email || null, b.address || null, b.gst_no || null, req.params.id]
  );
  res.json({ ok: true });
}));

router.delete('/vendors/:id', only('admin'), h(async (req, res) => {
  const [u] = await db.query('SELECT COUNT(*) AS n FROM pmo_dashboard.stock_quotations WHERE vendor_id=?', [req.params.id]);
  if (u[0].n > 0) return res.status(400).json({ error: 'This vendor is used in quotations and cannot be deleted' });
  await db.query('DELETE FROM pmo_dashboard.stock_vendors WHERE id=?', [req.params.id]);
  res.json({ ok: true });
}));

/* ---------------- ITEMS ---------------- */
router.get('/items', h(async (req, res) => {
  const [rows] = await db.query(
    'SELECT s.*, hs.hsn_code, hs.gst_percent AS hsn_gst FROM pmo_dashboard.stock_items s ' +
    'LEFT JOIN pmo_dashboard.stock_hsn hs ON hs.id=s.hsn_id WHERE s.is_active=1 ORDER BY s.item_code'
  );
  res.json(rows);
}));

router.post('/items', only('admin'), h(async (req, res) => {
  const b = req.body;
  if (!b.name) return res.status(400).json({ error: 'Item name is required' });
  const [m] = await db.query("SELECT IFNULL(MAX(CAST(SUBSTRING(item_code,5) AS UNSIGNED)),0)+1 AS n FROM pmo_dashboard.stock_items");
  const code = b.item_code || 'ITM-' + String(m[0].n).padStart(3, '0');
  await db.query(
    'INSERT INTO pmo_dashboard.stock_items (item_code,name,category,unit,brand,model_no,specification,min_stock,hsn_id) VALUES (?,?,?,?,?,?,?,?,?)',
    [code, b.name, b.category || null, b.unit || 'Nos', b.brand || null, b.model_no || null, b.specification || null, b.min_stock || 0, b.hsn_id || null]
  );
  res.json({ ok: true, item_code: code });
}));

router.put('/items/:id', only('admin'), h(async (req, res) => {
  const b = req.body;
  await db.query(
    'UPDATE pmo_dashboard.stock_items SET name=?, category=?, unit=?, brand=?, model_no=?, specification=?, min_stock=?, hsn_id=? WHERE id=?',
    [b.name, b.category || null, b.unit || 'Nos', b.brand || null, b.model_no || null, b.specification || null, b.min_stock || 0, b.hsn_id || null, req.params.id]
  );
  res.json({ ok: true });
}));

router.delete('/items/:id', only('admin'), h(async (req, res) => {
  await db.query('UPDATE pmo_dashboard.stock_items SET is_active=0 WHERE id=?', [req.params.id]);
  res.json({ ok: true });
}));

/* ---------------- INDENT ---------------- */
// "department" in the response is the Location name (falls back to the old department name for old indents)
router.get('/indents', h(async (req, res) => {
  const u = req.user || {};
  let sql =
    'SELECT i.*, COALESCE(l.name, d.name) AS department, ' +
    '(SELECT COUNT(*) FROM pmo_dashboard.stock_indent_items x WHERE x.indent_id=i.id) AS item_count, ' +
    '(SELECT IFNULL(SUM(x.quantity),0) FROM pmo_dashboard.stock_indent_items x WHERE x.indent_id=i.id) AS total_qty ' +
    'FROM pmo_dashboard.stock_indents i ' +
    'LEFT JOIN pmo_dashboard.departments d ON d.id=i.department_id ' +
    'LEFT JOIN pmo_dashboard.locations l ON l.id=i.location_id';
  const p = [];
  if (u.role !== 'admin' && u.role !== 'management') {
    sql += ' WHERE i.department_id=?';
    p.push(u.department_id);
  }
  sql += ' ORDER BY i.id DESC';
  const [rows] = await db.query(sql, p);
  res.json(rows);
}));

router.get('/indents/:id', h(async (req, res) => {
  const [h1] = await db.query(
    'SELECT i.*, COALESCE(l.name, d.name) AS department FROM pmo_dashboard.stock_indents i ' +
    'LEFT JOIN pmo_dashboard.departments d ON d.id=i.department_id ' +
    'LEFT JOIN pmo_dashboard.locations l ON l.id=i.location_id WHERE i.id=?',
    [req.params.id]
  );
  if (!h1.length) return res.status(404).json({ error: 'Indent not found' });
  const u = req.user || {};
  if (u.role !== 'admin' && u.role !== 'management' && h1[0].department_id !== u.department_id)
    return res.status(403).json({ error: 'Access denied' });
  const [items] = await db.query(
    'SELECT x.*, s.item_code, s.name AS item_name, s.unit FROM pmo_dashboard.stock_indent_items x JOIN pmo_dashboard.stock_items s ON s.id=x.item_id WHERE x.indent_id=?',
    [req.params.id]
  );
  res.json({ ...h1[0], items });
}));

router.post('/indents', only('admin', 'user'), h(async (req, res) => {
  const b = req.body;
  const u = req.user || {};
  if (!Array.isArray(b.items) || !b.items.length) return res.status(400).json({ error: 'Add at least one item' });
  const dept = u.department_id || null;
  const loc = u.role === 'admin' ? (b.location_id || null) : null;
  const out = await tx(async c => {
    const no = await nextNo(c, 'stock_indents', 'IND-');
    const [r] = await c.query(
      'INSERT INTO pmo_dashboard.stock_indents (indent_no,indent_date,department_id,location_id,requested_by,remarks,created_by) VALUES (?,?,?,?,?,?,?)',
      [no, b.indent_date || today(), dept, loc, b.requested_by || u.name || null, b.remarks || null, u.id || u.userId || null]
    );
    for (const it of b.items) {
      await c.query(
        'INSERT INTO pmo_dashboard.stock_indent_items (indent_id,item_id,quantity,due_date,detail) VALUES (?,?,?,?,?)',
        [r.insertId, it.item_id, it.quantity, it.due_date || null, it.detail || null]
      );
    }
    return { id: r.insertId, indent_no: no };
  });
  res.json({ ok: true, ...out });
}));

router.put('/indents/:id/status', only('admin'), h(async (req, res) => {
  await db.query('UPDATE pmo_dashboard.stock_indents SET status=? WHERE id=?', [req.body.status, req.params.id]);
  res.json({ ok: true });
}));

async function checkIndent(req, id) {
  const [r] = await db.query('SELECT * FROM pmo_dashboard.stock_indents WHERE id=?', [id]);
  if (!r.length) return { err: [404, 'Indent not found'] };
  const u = req.user || {};
  if (u.role !== 'admin' && !(u.role === 'user' && r[0].department_id === u.department_id)) return { err: [403, 'Access denied'] };
  if (r[0].status !== 'Pending') return { err: [400, 'Only Pending indents can be changed'] };
  return { row: r[0] };
}

router.put('/indents/:id', only('admin', 'user'), h(async (req, res) => {
  const chk = await checkIndent(req, req.params.id);
  if (chk.err) return res.status(chk.err[0]).json({ error: chk.err[1] });
  const b = req.body;
  const u = req.user || {};
  if (!Array.isArray(b.items) || !b.items.length) return res.status(400).json({ error: 'Add at least one item' });
  const loc = u.role === 'admin' ? (b.location_id || null) : chk.row.location_id;
  await tx(async c => {
    await c.query(
      'UPDATE pmo_dashboard.stock_indents SET indent_date=?, requested_by=?, remarks=?, location_id=? WHERE id=?',
      [b.indent_date || chk.row.indent_date, b.requested_by || null, b.remarks || null, loc, req.params.id]
    );
    await c.query('DELETE FROM pmo_dashboard.stock_indent_items WHERE indent_id=?', [req.params.id]);
    for (const it of b.items) {
      await c.query(
        'INSERT INTO pmo_dashboard.stock_indent_items (indent_id,item_id,quantity,due_date,detail) VALUES (?,?,?,?,?)',
        [req.params.id, it.item_id, it.quantity, it.due_date || null, it.detail || null]
      );
    }
  });
  res.json({ ok: true });
}));

router.delete('/indents/:id', only('admin', 'user'), h(async (req, res) => {
  const chk = await checkIndent(req, req.params.id);
  if (chk.err) return res.status(chk.err[0]).json({ error: chk.err[1] });
  const [q] = await db.query('SELECT COUNT(*) AS n FROM pmo_dashboard.stock_quotations WHERE indent_id=?', [req.params.id]);
  if (q[0].n > 0) return res.status(400).json({ error: 'A quotation already exists for this indent' });
  await tx(async c => {
    await c.query('DELETE FROM pmo_dashboard.stock_indent_items WHERE indent_id=?', [req.params.id]);
    await c.query('DELETE FROM pmo_dashboard.stock_indents WHERE id=?', [req.params.id]);
  });
  res.json({ ok: true });
}));

/* ---------------- QUOTATION ---------------- */
const QT_VENDOR_SQL =
  'SELECT q.*, i.indent_no, v.phone AS vendor_phone, v.email AS vendor_email, v.address AS vendor_address, v.gst_no AS vendor_gst ' +
  'FROM pmo_dashboard.stock_quotations q ' +
  'LEFT JOIN pmo_dashboard.stock_indents i ON i.id=q.indent_id ' +
  'LEFT JOIN pmo_dashboard.stock_vendors v ON v.id=q.vendor_id';

router.get('/quotations', only('admin', 'management'), h(async (req, res) => {
  const [rows] = await db.query(QT_VENDOR_SQL + ' ORDER BY q.id DESC');
  res.json(rows);
}));

router.get('/quotations/:id', only('admin', 'management'), h(async (req, res) => {
  const [h1] = await db.query(QT_VENDOR_SQL + ' WHERE q.id=?', [req.params.id]);
  if (!h1.length) return res.status(404).json({ error: 'Quotation not found' });
  const [items] = await db.query(
    'SELECT x.*, s.item_code, s.name AS item_name, s.unit FROM pmo_dashboard.stock_quotation_items x JOIN pmo_dashboard.stock_items s ON s.id=x.item_id WHERE x.quotation_id=?',
    [req.params.id]
  );
  res.json({ ...h1[0], items });
}));

router.post('/quotations', only('admin'), h(async (req, res) => {
  const b = req.body;
  if (!b.vendor_id) return res.status(400).json({ error: 'Select a vendor' });
  if (!Array.isArray(b.items) || !b.items.length) return res.status(400).json({ error: 'Add at least one item' });
  const out = await tx(async c => {
    const [v] = await c.query('SELECT * FROM pmo_dashboard.stock_vendors WHERE id=?', [b.vendor_id]);
    if (!v.length) throw new Error('Vendor not found');
    const no = await nextNo(c, 'stock_quotations', 'QT-');
    let subtotal = 0, gstTotal = 0;
    const rows = [];
    for (const it of b.items) {
      const gstP = it.gst_percent === undefined || it.gst_percent === null || it.gst_percent === '' ? 18 : Number(it.gst_percent);
      const amt = r2(Number(it.quantity) * Number(it.rate || 0));
      const gstA = r2(amt * gstP / 100);
      subtotal += amt;
      gstTotal += gstA;
      const [hs] = await c.query(
        'SELECT hs.hsn_code FROM pmo_dashboard.stock_items s LEFT JOIN pmo_dashboard.stock_hsn hs ON hs.id=s.hsn_id WHERE s.id=?',
        [it.item_id]
      );
      rows.push({ ...it, gst_percent: gstP, amount: amt, gst_amount: gstA, final_amount: r2(amt + gstA), hsn_code: hs.length ? hs[0].hsn_code : null });
    }
    subtotal = r2(subtotal);
    gstTotal = r2(gstTotal);
    const total = r2(subtotal + gstTotal);
    const [r] = await c.query(
      'INSERT INTO pmo_dashboard.stock_quotations (quotation_no,quotation_date,indent_id,vendor_id,supplier_name,supplier_contact,remarks,subtotal,gst_total,total,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [no, b.quotation_date || today(), b.indent_id || null, v[0].id, v[0].name, v[0].phone || v[0].email || null, b.remarks || null, subtotal, gstTotal, total, (req.user || {}).id || null]
    );
    for (const it of rows) {
      await c.query(
        'INSERT INTO pmo_dashboard.stock_quotation_items (quotation_id,item_id,quantity,rate,amount,gst_percent,gst_amount,final_amount,hsn_code) VALUES (?,?,?,?,?,?,?,?,?)',
        [r.insertId, it.item_id, it.quantity, it.rate || 0, it.amount, it.gst_percent, it.gst_amount, it.final_amount, it.hsn_code]
      );
    }
    if (b.indent_id) await c.query("UPDATE pmo_dashboard.stock_indents SET status='Quotation Received' WHERE id=?", [b.indent_id]);
    return { id: r.insertId, quotation_no: no, subtotal, gst_total: gstTotal, total };
  });
  res.json({ ok: true, ...out });
}));

router.delete('/quotations/:id', only('admin'), h(async (req, res) => {
  const [r] = await db.query('SELECT * FROM pmo_dashboard.stock_quotations WHERE id=?', [req.params.id]);
  if (!r.length) return res.status(404).json({ error: 'Quotation not found' });
  if (r[0].status === 'Ordered') return res.status(400).json({ error: 'PO already created from this quotation' });
  await tx(async c => {
    await c.query('DELETE FROM pmo_dashboard.stock_quotation_items WHERE quotation_id=?', [req.params.id]);
    await c.query('DELETE FROM pmo_dashboard.stock_quotations WHERE id=?', [req.params.id]);
    if (r[0].indent_id) {
      const [o] = await c.query('SELECT COUNT(*) AS n FROM pmo_dashboard.stock_quotations WHERE indent_id=?', [r[0].indent_id]);
      if (o[0].n === 0) await c.query("UPDATE pmo_dashboard.stock_indents SET status='Pending' WHERE id=? AND status='Quotation Received'", [r[0].indent_id]);
    }
  });
  res.json({ ok: true });
}));

/* ---------------- PURCHASE ORDER ---------------- */
const PO_SQL =
  'SELECT p.*, i.indent_no, q.quotation_no, v.phone AS vendor_phone, v.email AS vendor_email, v.address AS vendor_address, v.gst_no AS vendor_gst ' +
  'FROM pmo_dashboard.stock_pos p ' +
  'LEFT JOIN pmo_dashboard.stock_indents i ON i.id=p.indent_id ' +
  'LEFT JOIN pmo_dashboard.stock_quotations q ON q.id=p.quotation_id ' +
  'LEFT JOIN pmo_dashboard.stock_vendors v ON v.id=p.vendor_id';

router.get('/pos', only('admin', 'management'), h(async (req, res) => {
  const [rows] = await db.query(PO_SQL + ' ORDER BY p.id DESC');
  res.json(rows);
}));

router.get('/pos/:id', only('admin', 'management'), h(async (req, res) => {
  const [h1] = await db.query(PO_SQL + ' WHERE p.id=?', [req.params.id]);
  if (!h1.length) return res.status(404).json({ error: 'PO not found' });
  const [items] = await db.query(
    'SELECT x.*, s.item_code, s.name AS item_name, s.unit FROM pmo_dashboard.stock_po_items x JOIN pmo_dashboard.stock_items s ON s.id=x.item_id WHERE x.po_id=?',
    [req.params.id]
  );
  res.json({ ...h1[0], items });
}));

// PO is created from a quotation: vendor, items, rates, HSN and GST are copied
router.post('/pos', only('admin'), h(async (req, res) => {
  const b = req.body;
  if (!b.quotation_id) return res.status(400).json({ error: 'Select a quotation' });
  const out = await tx(async c => {
    const [q] = await c.query('SELECT * FROM pmo_dashboard.stock_quotations WHERE id=?', [b.quotation_id]);
    if (!q.length) throw new Error('Quotation not found');
    const [qi] = await c.query('SELECT * FROM pmo_dashboard.stock_quotation_items WHERE quotation_id=?', [b.quotation_id]);
    const no = await nextNo(c, 'stock_pos', 'PO-');
    const [r] = await c.query(
      'INSERT INTO pmo_dashboard.stock_pos (po_no,po_date,indent_id,quotation_id,vendor_id,supplier_name,credit_period,delivery_terms,remarks,subtotal,gst_total,total,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [no, b.po_date || today(), q[0].indent_id, q[0].id, q[0].vendor_id, q[0].supplier_name, b.credit_period || 0, b.delivery_terms || null, b.remarks || null, q[0].subtotal, q[0].gst_total, q[0].total, (req.user || {}).id || null]
    );
    for (const it of qi) {
      await c.query(
        'INSERT INTO pmo_dashboard.stock_po_items (po_id,item_id,quantity,rate,amount,gst_percent,gst_amount,final_amount,hsn_code) VALUES (?,?,?,?,?,?,?,?,?)',
        [r.insertId, it.item_id, it.quantity, it.rate, it.amount, it.gst_percent, it.gst_amount, it.final_amount, it.hsn_code]
      );
    }
    await c.query("UPDATE pmo_dashboard.stock_quotations SET status='Ordered' WHERE id=?", [q[0].id]);
    if (q[0].indent_id) await c.query("UPDATE pmo_dashboard.stock_indents SET status='PO Created' WHERE id=?", [q[0].indent_id]);
    return { id: r.insertId, po_no: no };
  });
  res.json({ ok: true, ...out });
}));

module.exports = router;