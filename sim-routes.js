const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const ExcelJS = require('exceljs');

module.exports = function (db) {
  const router = express.Router();

  const query = (sql, params = []) =>
    typeof db.promise === 'function'
      ? db.promise().query(sql, params).then(r => r[0])
      : db.query(sql, params).then(r => r[0]);

  const fail = (status, message) => Object.assign(new Error(message), { status });
  const wrap = fn => (req, res) =>
    fn(req, res).catch(err => {
      console.error(err);
      res.status(err.status || 500).json({
        error: err.code === 'ER_DUP_ENTRY' ? 'This mobile number is already added' : err.message
      });
    });

  const uploadDir = path.join(__dirname, 'uploads', 'sim-docs');
  fs.mkdirSync(uploadDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (req, file, cb) =>
        cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_'))
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const ok = /\.(pdf|jpe?g|png)$/i.test(file.originalname);
      cb(ok ? null : new Error('Only PDF, JPG and PNG files are allowed'), ok);
    }
  });
  const uploadOne = (req, res, next) =>
    upload.single('file')(req, res, err =>
      err ? res.status(400).json({ error: err.message }) : next()
    );

  query('ALTER TABLE sim_assignments ADD COLUMN location VARCHAR(255) NULL').catch(() => {});
query('ALTER TABLE sim_assignments ADD COLUMN contact_person VARCHAR(255) NULL').catch(() => {});

  const JOIN_LATEST = `
    LEFT JOIN sim_assignments a
      ON a.id = (SELECT MAX(id) FROM sim_assignments WHERE sim_id = s.id)
     AND s.status IN ('With Employee','At Site')`;

  async function listSims({ search, status, verification }) {
    let sql = `
      SELECT s.id, s.mobile_no, s.sim_serial, s.operator, s.plan_type, s.plan_details,
             DATE_FORMAT(s.purchase_date, '%Y-%m-%d') AS purchase_date, s.status,
             a.id AS assignment_id, a.assigned_type, a.employee_id, a.employee_name,
             a.department, a.site_name, a.location, a.device, a.contact_person,
             DATE_FORMAT(a.issue_date, '%Y-%m-%d') AS issue_date,
             a.remarks, a.verification_status, a.verified_by,
             DATE_FORMAT(a.verified_on, '%Y-%m-%d') AS verified_on, a.verification_remarks,
             (SELECT COUNT(*) FROM sim_documents d WHERE d.sim_id = s.id) AS doc_count
      FROM sims s ${JOIN_LATEST}
      WHERE 1=1`;
    const params = [];
    if (search) {
      sql += ` AND (s.mobile_no LIKE ? OR s.sim_serial LIKE ? OR a.employee_name LIKE ?
                 OR a.employee_id LIKE ? OR a.site_name LIKE ?)`;
      const l = `%${search}%`;
      params.push(l, l, l, l, l);
    }
    if (status) { sql += ' AND s.status = ?'; params.push(status); }
    if (verification) { sql += ' AND a.verification_status = ?'; params.push(verification); }
    sql += ' ORDER BY s.id DESC';
    return query(sql, params);
  }

  // ---------- Report ----------
  router.get('/summary', wrap(async (req, res) => {
    const [row] = await query(`
      SELECT COUNT(*) AS total,
        SUM(s.status = 'In Stock') AS in_stock,
        SUM(s.status = 'With Employee') AS with_employee,
        SUM(s.status = 'At Site') AS at_site,
        SUM(a.verification_status = 'Verified') AS verified,
        SUM(a.verification_status IN ('Pending','Not Reachable')) AS pending
      FROM sims s ${JOIN_LATEST}`);
    res.json(row);
  }));

  router.get('/export-csv', wrap(async (req, res) => {
    const rows = await listSims(req.query);
    const cols = [
      ['Mobile No', 'mobile_no'], ['SIM Serial', 'sim_serial'], ['Operator', 'operator'],
      ['Plan Type', 'plan_type'], ['Plan Details', 'plan_details'], ['Status', 'status'],
      ['Assigned Type', 'assigned_type'], ['Employee Id', 'employee_id'],
      ['Employee Name', 'employee_name'], ['Department', 'department'],
      ['Site', 'site_name'], ['Site Contact', 'contact_person'], ['Device', 'device'], ['Issue Date', 'issue_date'],
      ['Verification', 'verification_status'], ['Verified By', 'verified_by'],
      ['Verified On', 'verified_on'], ['Remarks', 'verification_remarks'],
      ['Documents', 'doc_count']
    ];
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [
      cols.map(c => esc(c[0])).join(','),
      ...rows.map(r => cols.map(c => esc(r[c[1]])).join(','))
    ].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="sim_report.csv"');
    res.send('\uFEFF' + csv);
  }));

  router.get('/', wrap(async (req, res) => res.json(await listSims(req.query))));

  // ---------- SIM master ----------
  router.post('/', wrap(async (req, res) => {
    const b = req.body;
    if (!b.mobile_no) throw fail(400, 'Mobile number is required');
    const r = await query(
      `INSERT INTO sims (mobile_no, sim_serial, operator, plan_type, plan_details, purchase_date)
       VALUES (?,?,?,?,?,?)`,
      [b.mobile_no.trim(), b.sim_serial || null, b.operator || null,
       b.plan_type || 'Prepaid', b.plan_details || null, b.purchase_date || null]
    );
    res.json({ id: r.insertId });
  }));

  router.put('/:id', wrap(async (req, res) => {
    const b = req.body;
    if (!b.mobile_no) throw fail(400, 'Mobile number is required');
    await query(
      `UPDATE sims SET mobile_no=?, sim_serial=?, operator=?, plan_type=?, plan_details=?,
         purchase_date=?, status=COALESCE(?, status) WHERE id=?`,
      [b.mobile_no.trim(), b.sim_serial || null, b.operator || null, b.plan_type || 'Prepaid',
       b.plan_details || null, b.purchase_date || null, b.status || null, req.params.id]
    );
    res.json({ ok: true });
  }));

  router.delete('/:id', wrap(async (req, res) => {
    const docs = await query('SELECT file_path FROM sim_documents WHERE sim_id = ?', [req.params.id]);
    docs.forEach(d => fs.unlink(path.join(uploadDir, d.file_path), () => {}));
    await query('DELETE FROM sims WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  }));

  // ---------- Assign / Return / Verify ----------
  router.post('/:id/assign', wrap(async (req, res) => {
    const b = req.body;
    if (!['Employee', 'Site'].includes(b.assigned_type)) throw fail(400, 'Please select Employee or Site');
    if (b.assigned_type === 'Employee' && !b.employee_name) throw fail(400, 'Employee name is required');
    if (b.assigned_type === 'Site' && !b.site_name) throw fail(400, 'Site name is required');
    await query(
      `INSERT INTO sim_assignments
        (sim_id, assigned_type, employee_id, employee_name, department, site_name, location, device, issue_date, remarks)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [req.params.id, b.assigned_type, b.employee_id || null, b.employee_name || null,
       b.department || null, b.site_name || null, b.location || null, b.device || null,
       b.issue_date || new Date().toISOString().slice(0, 10), b.remarks || null]
    );
    await query('UPDATE sims SET status = ? WHERE id = ?',
      [b.assigned_type === 'Employee' ? 'With Employee' : 'At Site', req.params.id]);
    await query("UPDATE sim_assignments SET contact_person = ? WHERE id = (SELECT m FROM (SELECT MAX(id) AS m FROM sim_assignments WHERE sim_id = ?) t)", [b.assigned_type === 'Site' ? (b.contact_person || null) : null, req.params.id]);
    res.json({ ok: true });
  }));

  router.post('/:id/return', wrap(async (req, res) => {
    await query(
      `UPDATE sim_assignments SET return_date = CURDATE()
       WHERE id = (SELECT m FROM (SELECT MAX(id) AS m FROM sim_assignments WHERE sim_id = ?) t)`,
      [req.params.id]
    );
    await query("UPDATE sims SET status = 'In Stock' WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  }));

  router.post('/:id/verify', wrap(async (req, res) => {
    const b = req.body;
    const [s] = await query('SELECT status FROM sims WHERE id = ?', [req.params.id]);
    if (!s || !['With Employee', 'At Site'].includes(s.status))
      throw fail(400, 'Assign the SIM first before verification');
    await query(
      `UPDATE sim_assignments SET verification_status=?, verified_by=?, verified_on=?, verification_remarks=?
       WHERE id = (SELECT m FROM (SELECT MAX(id) AS m FROM sim_assignments WHERE sim_id = ?) t)`,
      [b.verification_status || 'Pending', b.verified_by || null,
       b.verified_on || null, b.verification_remarks || null, req.params.id]
    );
    res.json({ ok: true });
  }));

  // ---------- Documents ----------
  router.get('/:id/documents', wrap(async (req, res) => {
    res.json(await query(
      `SELECT id, doc_type, DATE_FORMAT(uploaded_at, '%Y-%m-%d') AS uploaded_on
       FROM sim_documents WHERE sim_id = ? ORDER BY id DESC`, [req.params.id]));
  }));

  router.post('/:id/documents', uploadOne, wrap(async (req, res) => {
    if (!req.file) throw fail(400, 'Please select a file first');
    await query('INSERT INTO sim_documents (sim_id, doc_type, file_path) VALUES (?,?,?)',
      [req.params.id, req.body.doc_type || 'Other', req.file.filename]);
    res.json({ ok: true });
  }));

  router.get('/documents/:docId/file', wrap(async (req, res) => {
    const [d] = await query('SELECT file_path FROM sim_documents WHERE id = ?', [req.params.docId]);
    if (!d) throw fail(404, 'Document not found');
    res.sendFile(path.join(uploadDir, d.file_path));
  }));

  router.delete('/documents/:docId', wrap(async (req, res) => {
    const [d] = await query('SELECT file_path FROM sim_documents WHERE id = ?', [req.params.docId]);
    if (d) fs.unlink(path.join(uploadDir, d.file_path), () => {});
    await query('DELETE FROM sim_documents WHERE id = ?', [req.params.docId]);
    res.json({ ok: true });
  }));

  router.get('/:id/history', wrap(async (req, res) => {
    res.json(await query(
      `SELECT id, assigned_type, employee_id, employee_name, department, site_name, location, device, contact_person,
              DATE_FORMAT(issue_date, '%Y-%m-%d') AS issue_date,
              DATE_FORMAT(return_date, '%Y-%m-%d') AS return_date,
              remarks, verification_status, verified_by,
              DATE_FORMAT(verified_on, '%Y-%m-%d') AS verified_on, verification_remarks
       FROM sim_assignments WHERE sim_id = ? ORDER BY id DESC`, [req.params.id]));
  }));

  router.get('/export', wrap(async (req, res) => {
    const rows = await listSims(req.query);
    const BLUE = 'FF1F6FD6', WHITE = 'FFFFFFFF';
    const fill = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
    const thin = { style: 'thin', color: { argb: 'FFD5E0F0' } };
    const border = { top: thin, left: thin, bottom: thin, right: thin };
    const STATUS_FILL = {
      'In Stock': 'FFE3EEFC', 'With Employee': 'FFD9EAD3', 'At Site': 'FFCFE2F3',
      'Deactivated': 'FFEEEEEE', 'Lost': 'FFF4CCCC'
    };
    const VER_FILL = { 'Verified': 'FFD9EAD3', 'Pending': 'FFFFF2CC', 'Not Reachable': 'FFF4CCCC' };

    const cols = [
      ['Mobile No', 'mobile_no', 16], ['SIM Serial', 'sim_serial', 24], ['Operator', 'operator', 12],
      ['Plan Type', 'plan_type', 12], ['Plan Details', 'plan_details', 20], ['Status', 'status', 16],
      ['Assigned Type', 'assigned_type', 15], ['Employee Id', 'employee_id', 13],
      ['Employee Name', 'employee_name', 22], ['Department', 'department', 18],
      ['Site', 'site_name', 20], ['Site Contact', 'contact_person', 20], ['Location', 'location', 22], ['Device', 'device', 16], ['Issue Date', 'issue_date', 13],
      ['Verification', 'verification_status', 15], ['Verified By', 'verified_by', 16],
      ['Verified On', 'verified_on', 13], ['Verification Remarks', 'verification_remarks', 24],
      ['Remarks', 'remarks', 24], ['Documents', 'doc_count', 11]
    ];

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('SIM Report', { views: [{ state: 'frozen', ySplit: 7 }] });
    ws.columns = cols.map(c => ({ width: c[2] }));

    // Title
    ws.mergeCells(1, 1, 1, cols.length);
    const title = ws.getCell(1, 1);
    title.value = 'SIM Tracking Report';
    title.font = { bold: true, size: 16, color: { argb: WHITE } };
    title.fill = fill(BLUE);
    title.alignment = { vertical: 'middle', horizontal: 'center' };
    ws.getRow(1).height = 30;

    ws.mergeCells(2, 1, 2, cols.length);
    const sub = ws.getCell(2, 1);
    sub.value = 'Generated on ' + new Date().toLocaleString('en-IN');
    sub.font = { italic: true, color: { argb: 'FF6B7A90' } };
    sub.alignment = { horizontal: 'center' };

    // Summary cards
    const cnt = f => rows.filter(f).length;
    const summary = [
      ['Total SIMs', rows.length, 'FFE3EEFC'],
      ['In Stock', cnt(r => r.status === 'In Stock'), 'FFE3EEFC'],
      ['With Employees', cnt(r => r.status === 'With Employee'), 'FFE3EEFC'],
      ['At Sites', cnt(r => r.status === 'At Site'), 'FFE3EEFC'],
      ['Verified', cnt(r => r.verification_status === 'Verified'), 'FFD9EAD3'],
      ['Pending Verification', cnt(r => r.verification_status === 'Pending'), 'FFFFF2CC'],
      ['Not Reachable', cnt(r => r.verification_status === 'Not Reachable'), 'FFF4CCCC']
    ];
    summary.forEach((s, i) => {
      const h = ws.getCell(4, i + 1);
      h.value = s[0];
      h.font = { bold: true, color: { argb: WHITE } };
      h.fill = fill(BLUE);
      h.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      h.border = border;
      const v = ws.getCell(5, i + 1);
      v.value = s[1];
      v.font = { bold: true, size: 14 };
      v.fill = fill(s[2]);
      v.alignment = { vertical: 'middle', horizontal: 'center' };
      v.border = border;
    });
    ws.getRow(4).height = 24;
    ws.getRow(5).height = 26;

    // Table header
    const hdr = ws.getRow(7);
    cols.forEach((c, i) => {
      const cell = hdr.getCell(i + 1);
      cell.value = c[0];
      cell.font = { bold: true, color: { argb: WHITE } };
      cell.fill = fill(BLUE);
      cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
      cell.border = border;
    });
    hdr.height = 24;

    // Table rows
    rows.forEach((r, idx) => {
      const row = ws.getRow(8 + idx);
      cols.forEach((c, i) => {
        const cell = row.getCell(i + 1);
        cell.value = (['issue_date', 'verified_on'].includes(c[1]) && r[c[1]]) ? String(r[c[1]]).split('-').reverse().join('-') : (r[c[1]] ?? '');
        cell.border = border;
        cell.alignment = { vertical: 'middle', wrapText: true };
        if (idx % 2) cell.fill = fill('FFF7FAFF');
        if (c[1] === 'status' && STATUS_FILL[r.status]) cell.fill = fill(STATUS_FILL[r.status]);
        if (c[1] === 'verification_status' && VER_FILL[r.verification_status])
          cell.fill = fill(VER_FILL[r.verification_status]);
      });
    });

    ws.autoFilter = { from: { row: 7, column: 1 }, to: { row: 7, column: cols.length } };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="sim_report.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  }));
  // ---------- Import SIMs from Excel ----------
  const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

  router.get('/import-template', wrap(async (req, res) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('SIMs');
    ws.columns = [
      { header: 'Mobile No', key: 'mobile_no', width: 16 },
      { header: 'SIM Serial', key: 'sim_serial', width: 24 },
      { header: 'Operator', key: 'operator', width: 14 },
      { header: 'Plan Type', key: 'plan_type', width: 14 },
      { header: 'Plan Details', key: 'plan_details', width: 24 },
      { header: 'Purchase Date (DD-MM-YYYY)', key: 'purchase_date', width: 28 }
    ];
    ws.getColumn(1).numFmt = '@';
    ws.getColumn(2).numFmt = '@';
    ws.addRow({
      mobile_no: '9876543210', sim_serial: '8991000000000000000', operator: 'Airtel',
      plan_type: 'Prepaid', plan_details: 'Rs 299 / 28 days', purchase_date: '29-10-2026'
    });
    const h = ws.getRow(1);
    h.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F6FD6' } };
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="sim_import_template.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  }));

  router.post('/import',
    (req, res, next) => memUpload.single('file')(req, res, err =>
      err ? res.status(400).json({ error: err.message }) : next()),
    wrap(async (req, res) => {
      if (!req.file) throw fail(400, 'Please select an Excel file');
      const wb = new ExcelJS.Workbook();
      try { await wb.xlsx.load(req.file.buffer); }
      catch (e) { throw fail(400, 'Could not read the file. Please upload a .xlsx file'); }
      const ws = wb.worksheets[0];
      if (!ws) throw fail(400, 'The file has no sheet');

      const txt = cell => {
        let v = cell ? cell.value : null;
        if (v == null) return '';
        if (v instanceof Date) return v;
        if (typeof v === 'object') v = v.text || v.result || (v.richText ? v.richText.map(r => r.text).join('') : '');
        return String(v == null ? '' : v).trim();
      };
      const toDate = v => {
        if (!v) return null;
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        const m = String(v).match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/);
        if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
        return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
      };

      const head = {};
      ws.getRow(1).eachCell((cell, n) => { head[String(txt(cell)).toLowerCase()] = n; });
      const col = (...names) => {
        for (const nm of names)
          for (const k of Object.keys(head)) if (k.startsWith(nm)) return head[k];
        return 0;
      };
      const cMobile = col('mobile'), cSerial = col('sim serial', 'serial'), cOp = col('operator'),
            cType = col('plan type'), cPlan = col('plan details'), cDate = col('purchase');
      if (!cMobile) throw fail(400, 'Column "Mobile No" not found. Please use the template');
      const get = (row, c) => (c ? txt(row.getCell(c)) : '');

      let added = 0;
      const skipped = [];
      for (let i = 2; i <= ws.rowCount; i++) {
        const row = ws.getRow(i);
        const mobile = String(get(row, cMobile)).replace(/[\s-]/g, '');
        if (!mobile) continue;
        const ptype = String(get(row, cType)).toLowerCase() === 'postpaid' ? 'Postpaid' : 'Prepaid';
        try {
          await query(
            `INSERT INTO sims (mobile_no, sim_serial, operator, plan_type, plan_details, purchase_date)
             VALUES (?,?,?,?,?,?)`,
            [mobile, String(get(row, cSerial)) || null, String(get(row, cOp)) || null, ptype,
             String(get(row, cPlan)) || null, toDate(get(row, cDate))]
          );
          added++;
        } catch (e) {
          skipped.push('Row ' + i + ' (' + mobile + '): ' + (e.code === 'ER_DUP_ENTRY' ? 'already exists' : e.message));
        }
      }
      res.json({ added, skipped });
    })
  );
  return router;
};