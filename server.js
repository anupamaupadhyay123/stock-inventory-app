const { can, logActivity } = require('./permissions');
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const mysql = require('mysql2/promise');
const ExcelJS = require('exceljs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'stock_inventory',
  dateStrings: true,
  waitForConnections: true,
  connectionLimit: 10
});

const wrap = fn => (req, res) => fn(req, res).catch(e => {
  console.error(e);
  res.status(500).json({ error: e.message });
});
const bad = (res, msg) => res.status(400).json({ error: msg });

// ---------- Login / Security ----------
const auth = require('./authRoutes')(pool);
app.use('/api/auth', auth.router);
app.use('/api', auth.guard);

// Current stock = Total In - Total Out + Returned
async function currentStock(code) {
  const [[a]] = await pool.query('SELECT COALESCE(SUM(qty_received),0) AS t FROM stock_in WHERE item_code=?', [code]);
  const [[b]] = await pool.query('SELECT COALESCE(SUM(qty),0) AS t, COALESCE(SUM(returned_qty),0) AS r FROM stock_out WHERE item_code=?', [code]);
  return Number(a.t) - Number(b.t) + Number(b.r);
}

async function getSummary() {
  const [items] = await pool.query(`
    SELECT i.item_code, i.item_name, i.category, i.min_stock,
      COALESCE((SELECT SUM(qty_received) FROM stock_in WHERE item_code=i.item_code),0) AS total_in,
      COALESCE((SELECT SUM(qty) FROM stock_out WHERE item_code=i.item_code),0) AS total_out,
      COALESCE((SELECT SUM(returned_qty) FROM stock_out WHERE item_code=i.item_code),0) AS total_returned
    FROM items i ORDER BY i.item_name`);
  const [ins] = await pool.query('SELECT item_code, location, created_at, in_date, qty_received FROM stock_in');
  const [outs] = await pool.query('SELECT item_code, location, created_at, returned_at, employee_name, qty FROM stock_out');

  const last = {};
  const upd = (code, t, loc, text) => {
    if (!t) return;
    if (!last[code] || t >= last[code].t) last[code] = { t, loc, text };
  };
  ins.forEach(r => upd(r.item_code, r.created_at, r.location, 'Stock In +' + r.qty_received));
  outs.forEach(r => {
    upd(r.item_code, r.created_at, r.location, 'Issued ' + r.qty + ' to ' + r.employee_name);
    upd(r.item_code, r.returned_at, r.location, 'Returned by ' + r.employee_name);
  });

  return items.map(i => {
    const tin = Number(i.total_in), tout = Number(i.total_out), tret = Number(i.total_returned);
    const cur = tin - tout + tret;
    const l = last[i.item_code];
    return {
      item_code: i.item_code,
      item_name: i.item_name,
      category: i.category,
      min_stock: i.min_stock,
      total_in: tin,
      total_out: tout,
      total_returned: tret,
      current_stock: cur,
      low: i.min_stock > 0 && cur <= i.min_stock,
      last_location: l ? l.loc : '',
      last_activity: l ? l.text : '',
      last_activity_at: l ? l.t : ''
    };
  });
}

// ---------- Items ----------
app.get('/api/items', wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT item_code, item_name, category, min_stock FROM items ORDER BY item_name');
  res.json(rows);
}));

app.put('/api/items/:code/min', wrap(async (req, res) => {
  const m = parseInt(req.body.min_stock, 10);
  if (!(m >= 0)) return bad(res, 'Enter a valid number');
  await pool.query('UPDATE items SET min_stock=? WHERE item_code=?', [m, req.params.code]);
  res.json({ ok: true });
}));

// ---------- Stock In ----------
app.get('/api/stockin', wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM stock_in ORDER BY in_date DESC, id DESC');
  res.json(rows);
}));

app.post('/api/stockin', can('add'), wrap(async (req, res) => {
  const b = req.body;
  const code = (b.item_code || '').trim();
  const name = (b.item_name || '').trim();
  const qty = parseInt(b.qty_received, 10);
  const cost = parseFloat(b.unit_cost) || 0;
  if (!b.in_date || !code || !name) return bad(res, 'Date, Item Code and Item Name are required');
  if (!(qty > 0)) return bad(res, 'Qty Received must be more than 0');
  await pool.query(
    'INSERT INTO items (item_code, item_name, category) VALUES (?,?,?) ON DUPLICATE KEY UPDATE item_name=VALUES(item_name), category=VALUES(category)',
    [code, name, (b.category || '').trim() || null]);
  await pool.query(
    'INSERT INTO stock_in (in_date, item_code, item_name, category, vendor, qty_received, unit_cost, location, serial_no) VALUES (?,?,?,?,?,?,?,?,?)',
    [b.in_date, code, name, (b.category || '').trim() || null, (b.vendor || '').trim() || null, qty, cost, (b.location || '').trim() || null, (b.serial_no || '').trim() || null]);
  await logActivity(pool, req, 'ADD', 'Stock In', code + ' - ' + name + ' x' + qty);
  res.json({ ok: true });
}));

app.put('/api/stockin/:id', can('edit'), wrap(async (req, res) => {
  const b = req.body;
  const name = (b.item_name || '').trim();
  const qty = parseInt(b.qty_received, 10);
  const cost = parseFloat(b.unit_cost) || 0;
  const cat = (b.category || '').trim() || null;
  const [[r]] = await pool.query('SELECT item_code, qty_received FROM stock_in WHERE id=?', [req.params.id]);
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (!b.in_date || !name) return bad(res, 'Date and Item Name are required');
  if (!(qty > 0)) return bad(res, 'Qty Received must be more than 0');
  const cur = await currentStock(r.item_code);
  if (cur - r.qty_received + qty < 0) return bad(res, 'Cannot reduce: items of this entry are already issued');
  await pool.query(
    'UPDATE stock_in SET in_date=?, item_name=?, category=?, vendor=?, qty_received=?, unit_cost=?, location=?, serial_no=? WHERE id=?',
    [b.in_date, name, cat, (b.vendor || '').trim() || null, qty, cost, (b.location || '').trim() || null, (b.serial_no || '').trim() || null, req.params.id]);
  await pool.query('UPDATE items SET item_name=?, category=? WHERE item_code=?', [name, cat, r.item_code]);
  await logActivity(pool, req, 'EDIT', 'Stock In', r.item_code + ' - ' + name + ' x' + qty);
  res.json({ ok: true });
}));

app.get('/api/stockin/template', wrap(async (req, res) => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Stock In');
  ws.columns = [
    { header: 'Date', key: 'd', width: 14 }, { header: 'Item Code', key: 'c', width: 16 },
    { header: 'Item Name', key: 'n', width: 30 }, { header: 'Category', key: 'k', width: 16 },
    { header: 'Vendor', key: 'v', width: 22 }, { header: 'Qty Received', key: 'q', width: 14 },
    { header: 'Unit Cost', key: 'u', width: 12 }, { header: 'Location', key: 'l', width: 18 }
  ];
  ws.getRow(1).font = { bold: true };
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=stock_in_template.xlsx');
  await wb.xlsx.write(res);
  res.end();
}));

app.post('/api/stockin/import', can('add'), wrap(async (req, res) => {
  const buf = Buffer.from(req.body.file || '', 'base64');
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf); } catch (e) { return bad(res, 'Invalid file. Please use .xlsx Excel file'); }
  const ws = wb.worksheets[0];
  if (!ws) return bad(res, 'Sheet not found');

  const cv = c => {
    const v = c.value;
    if (v instanceof Date) return v;
    if (v && typeof v === 'object') {
      if (v.result !== undefined) return v.result;
      if (v.richText) return v.richText.map(t => t.text).join('');
      if (v.text !== undefined) return v.text;
    }
    return v == null ? '' : v;
  };
  const key = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  const iso = v => {
    if (v instanceof Date) return v.getUTCFullYear() + '-' + String(v.getUTCMonth() + 1).padStart(2, '0') + '-' + String(v.getUTCDate()).padStart(2, '0');
    const s = String(v || '').trim();
    let m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/);
    if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? m[1] + '-' + m[2] + '-' + m[3] : null;
  };

  const col = {};
  ws.getRow(1).eachCell((c, n) => { col[key(cv(c))] = n; });
  const missing = ['date', 'itemcode', 'itemname', 'qtyreceived'].filter(k => !col[k]);
  if (missing.length) return bad(res, 'Excel header missing. Use the Template button for correct columns');

  const rows = [], errs = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const g = k => col[k] ? cv(row.getCell(col[k])) : '';
    const code = String(g('itemcode') || '').trim();
    const name = String(g('itemname') || '').trim();
    if (!code && !name && !g('qtyreceived')) return;
    const date = iso(g('date'));
    const qty = parseInt(g('qtyreceived'), 10);
    const cost = parseFloat(g('unitcost')) || 0;
    if (!date || !code || !name || !(qty > 0)) { errs.push(n); return; }
    rows.push({
      date, code, name, qty, cost,
      cat: String(g('category') || '').trim() || null,
      vendor: String(g('vendor') || '').trim() || null,
      loc: String(g('location') || '').trim() || null
    });
  });
  if (errs.length) return bad(res, 'Nothing imported. Fix these Excel rows (Date, Item Code, Item Name, Qty are required): ' + errs.slice(0, 10).join(', '));
  if (!rows.length) return bad(res, 'No data rows found in Excel');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const r of rows) {
      await conn.query(
        'INSERT INTO items (item_code, item_name, category) VALUES (?,?,?) ON DUPLICATE KEY UPDATE item_name=VALUES(item_name), category=VALUES(category)',
        [r.code, r.name, r.cat]);
      await conn.query(
        'INSERT INTO stock_in (in_date, item_code, item_name, category, vendor, qty_received, unit_cost, location) VALUES (?,?,?,?,?,?,?,?)',
        [r.date, r.code, r.name, r.cat, r.vendor, r.qty, r.cost, r.loc]);
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  await logActivity(pool, req, 'IMPORT', 'Stock In', rows.length + ' rows imported from Excel');
  res.json({ ok: true, count: rows.length });
}));

app.delete('/api/stockin/:id', can('delete'), wrap(async (req, res) => {
  const [[r]] = await pool.query('SELECT item_code, qty_received FROM stock_in WHERE id=?', [req.params.id]);
  if (!r) return res.status(404).json({ error: 'Not found' });
  const cur = await currentStock(r.item_code);
  if (cur - r.qty_received < 0) return bad(res, 'Cannot delete: items of this entry are already issued');
  await pool.query('DELETE FROM stock_in WHERE id=?', [req.params.id]);
  await pool.query(
    'DELETE FROM items WHERE item_code=? AND NOT EXISTS (SELECT 1 FROM stock_in WHERE item_code=?) AND NOT EXISTS (SELECT 1 FROM stock_out WHERE item_code=?)',
    [r.item_code, r.item_code, r.item_code]);
  await logActivity(pool, req, 'DELETE', 'Stock In', r.item_code + ' x' + r.qty_received);
  res.json({ ok: true });
}));

// ---------- Stock Out (Issue to Employee) ----------
app.get('/api/stockout', wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM stock_out ORDER BY out_date DESC, id DESC');
  res.json(rows);
}));

app.post('/api/stockout', can('add'), wrap(async (req, res) => {
  const b = req.body;
  const code = (b.item_code || '').trim();
  const qty = parseInt(b.qty, 10);
  const rr = b.return_required ? 1 : 0;
  if (!b.out_date || !code || !(b.employee_id || '').trim() || !(b.employee_name || '').trim())
    return bad(res, 'Date, Item Code, Employee Id and Employee Name are required');
  if (!(qty > 0)) return bad(res, 'Qty must be more than 0');
  if (rr && !b.return_date) return bad(res, 'Please select Return Date');
  const [[item]] = await pool.query('SELECT item_name FROM items WHERE item_code=?', [code]);
  if (!item) return bad(res, 'Item Code not found. Add it in Stock In first.');
  const cur = await currentStock(code);
  if (qty > cur) return bad(res, 'Only ' + cur + ' in stock');
  await pool.query(
    'INSERT INTO stock_out (out_date, employee_id, employee_name, department, item_code, item_name, qty, location, remarks, return_required, return_date, serial_no) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [b.out_date, b.employee_id.trim(), b.employee_name.trim(), (b.department || '').trim() || null, code, item.item_name, qty,
     (b.location || '').trim() || null, (b.remarks || '').trim() || null, rr, rr ? b.return_date : null, (b.serial_no || '').trim() || null]);
  await logActivity(pool, req, 'ADD', 'Stock Out', code + ' x' + qty + ' to ' + b.employee_name.trim());
  res.json({ ok: true });
}));

app.put('/api/stockout/:id', can('edit'), wrap(async (req, res) => {
  const b = req.body;
  const qty = parseInt(b.qty, 10);
  const rr = b.return_required ? 1 : 0;
  const [[o]] = await pool.query('SELECT item_code, qty, returned_qty FROM stock_out WHERE id=?', [req.params.id]);
  if (!o) return res.status(404).json({ error: 'Not found' });
  if (!b.out_date || !(b.employee_id || '').trim() || !(b.employee_name || '').trim())
    return bad(res, 'Date, Employee Id and Employee Name are required');
  if (!(qty > 0)) return bad(res, 'Qty must be more than 0');
  if (qty < o.returned_qty) return bad(res, 'Qty cannot be less than already returned (' + o.returned_qty + ')');
  if (rr && !b.return_date) return bad(res, 'Please select Return Date');
  const cur = await currentStock(o.item_code);
  if (cur + o.qty - qty < 0) return bad(res, 'Only ' + (cur + o.qty) + ' available for this item');
  await pool.query(
    'UPDATE stock_out SET out_date=?, employee_id=?, employee_name=?, department=?, qty=?, location=?, remarks=?, return_required=?, return_date=?, serial_no=? WHERE id=?',
    [b.out_date, b.employee_id.trim(), b.employee_name.trim(), (b.department || '').trim() || null, qty,
     (b.location || '').trim() || null, (b.remarks || '').trim() || null, rr, rr ? b.return_date : null, (b.serial_no || '').trim() || null, req.params.id]);
  await logActivity(pool, req, 'EDIT', 'Stock Out', o.item_code + ' x' + qty + ' to ' + b.employee_name.trim());
  res.json({ ok: true });
}));

app.post('/api/stockout/:id/return', can('edit'), wrap(async (req, res) => {
  const [[r]] = await pool.query('SELECT qty, returned_qty FROM stock_out WHERE id=?', [req.params.id]);
  if (!r) return res.status(404).json({ error: 'Not found' });
  const pending = r.qty - r.returned_qty;
  const q = parseInt(req.body.qty, 10);
  if (!(q > 0) || q > pending) return bad(res, 'Return qty must be between 1 and ' + pending);
  await pool.query('UPDATE stock_out SET returned_qty = returned_qty + ?, returned_at = NOW() WHERE id=?', [q, req.params.id]);
  await logActivity(pool, req, 'RETURN', 'Stock Out', 'id ' + req.params.id + ' returned x' + q);
  res.json({ ok: true });
}));

app.delete('/api/stockout/:id', can('delete'), wrap(async (req, res) => {
  await pool.query('DELETE FROM stock_out WHERE id=?', [req.params.id]);
  await logActivity(pool, req, 'DELETE', 'Stock Out', 'id ' + req.params.id);
  res.json({ ok: true });
}));

// ---------- Activity Logs (admin only) ----------
app.get('/api/logs', can('logs'), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM activity_logs ORDER BY id DESC LIMIT 500');
  res.json(rows);
}));
// ---------- Summary ----------
app.get('/api/summary', wrap(async (req, res) => {
  res.json(await getSummary());
}));

// ---------- Excel Export ----------
function addSheet(wb, name, cols, rows) {
  const ws = wb.addWorksheet(name);
  ws.columns = cols.map(c => ({ header: c[0], key: c[1], width: c[2] }));
  rows.forEach(r => ws.addRow(r));
  ws.getRow(1).font = { bold: true };
  return ws;
}

app.get('/api/export', wrap(async (req, res) => {
  const wb = new ExcelJS.Workbook();
  const sum = await getSummary();
  const [ins] = await pool.query('SELECT * FROM stock_in ORDER BY in_date, id');
  const [outs] = await pool.query('SELECT * FROM stock_out ORDER BY out_date, id');

  addSheet(wb, 'Current Stock', [
    ['Material Code', 'item_code', 16], ['Material Description', 'item_name', 30], ['Category', 'category', 16],
    ['Total In', 'total_in', 10], ['Total Out', 'total_out', 10], ['Returned', 'total_returned', 10],
    ['Current Stock', 'current_stock', 14], ['Last Location', 'last_location', 18], ['Last Activity', 'last_activity', 34]
  ], sum);

  addSheet(wb, 'Stock In', [
    ['Date', 'in_date', 12], ['Item Code', 'item_code', 16], ['Item Name', 'item_name', 28], ['Category', 'category', 16],
    ['Vendor', 'vendor', 22], ['Qty Received', 'qty_received', 12], ['Unit Cost', 'unit_cost', 12], ['Location', 'location', 18]
  ], ins);

  addSheet(wb, 'Stock Out', [
    ['Date', 'out_date', 12], ['Employee Id', 'employee_id', 14], ['Employee Name', 'employee_name', 24], ['Department', 'department', 18],
    ['Item Code', 'item_code', 16], ['Item Name', 'item_name', 28], ['Qty', 'qty', 8], ['Location', 'location', 18],
    ['Remarks', 'remarks', 26], ['Return Required', 'return_required', 14], ['Return Date', 'return_date', 12],
    ['Returned Qty', 'returned_qty', 12]
  ], outs);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=stock_register.xlsx');
  await wb.xlsx.write(res);
  res.end();
}));

const PORT = process.env.PORT || 5001;
app.use('/api/sims', require('./sim-routes')(pool));
app.listen(PORT, () => {
  console.log('Stock Inventory running on http://localhost:' + PORT);
  pool.query('SELECT 1')
    .then(() => console.log('MySQL connected -> db: ' + (process.env.DB_NAME || 'stock_inventory')))
    .catch(e => console.log('MySQL NOT connected: ' + e.message));
});