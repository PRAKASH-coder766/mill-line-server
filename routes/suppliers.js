const express = require('express');
const { pool } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { validateIdParams } = require('../middleware/validateId');

const router = express.Router();

router.get('/suppliers', requireLogin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM suppliers WHERE active=true ORDER BY name');
  for (const s of rows) {
    s.productIds = (await pool.query('SELECT product_id FROM supplier_products WHERE supplier_id=$1', [s.id])).rows.map(r => r.product_id);
  }
  res.json(rows);
});

router.post('/suppliers', requireRole('admin', 'operator'), async (req, res) => {
  const { name, companyName, gstNumber, fssaiNumber, address, phone, email, notes, productIds } = req.body || {};
  if (!name || !address) return res.status(400).json({ error: 'Supplier name and address are required.' });

  const { rows } = await pool.query(
    `INSERT INTO suppliers (name, company_name, gst_number, fssai_number, address, phone, email, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [name, companyName || null, gstNumber || null, fssaiNumber || null, address, phone || null, email || null, notes || null]
  );
  for (const pid of (productIds || [])) {
    await pool.query('INSERT INTO supplier_products (supplier_id, product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [rows[0].id, pid]);
  }
  await pool.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1,$2,$3)', [
    req.session.userId, 'supplier_added', JSON.stringify({ name }),
  ]);
  res.json({ ...rows[0], productIds: productIds || [] });
});

// Lets an existing supplier's product list be edited later, not just set at creation.
router.post('/suppliers/:id/products', requireRole('admin', 'operator'), validateIdParams('id'), async (req, res) => {
  const { productIds } = req.body || {};
  if (!Array.isArray(productIds)) return res.status(400).json({ error: 'productIds must be an array.' });
  await pool.query('DELETE FROM supplier_products WHERE supplier_id=$1', [req.params.id]);
  for (const pid of productIds) {
    await pool.query('INSERT INTO supplier_products (supplier_id, product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, pid]);
  }
  res.json({ supplierId: Number(req.params.id), productIds });
});

router.patch('/suppliers/:id', requireRole('admin'), validateIdParams('id'), async (req, res) => {
  const { active } = req.body || {};
  const { rows } = await pool.query('UPDATE suppliers SET active=$1 WHERE id=$2 RETURNING *', [active, req.params.id]);
  res.json(rows[0]);
});

// Suggests the next supplier batch/lot number by looking at the last one used
// for this supplier and incrementing its trailing number. Falls back to a
// simple starter value if this supplier has no history yet.
router.get('/suppliers/:id/next-batch-no', requireLogin, validateIdParams('id'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT supplier_batch_no FROM sourcing_records WHERE supplier_id=$1 AND supplier_batch_no IS NOT NULL
     ORDER BY id DESC LIMIT 1`,
    [req.params.id]
  );
  const last = rows[0]?.supplier_batch_no;
  if (!last) return res.json({ suggestion: 'LOT-0001' });

  const match = last.match(/^(.*?)(\d+)(\D*)$/);
  if (!match) return res.json({ suggestion: last }); // no trailing number to increment, just repeat it

  const [, prefix, num, suffix] = match;
  const nextNum = String(Number(num) + 1).padStart(num.length, '0');
  res.json({ suggestion: `${prefix}${nextNum}${suffix}` });
});

module.exports = router;
