const express = require('express');
const { pool } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { createBatch } = require('../utils/batchCode');

const router = express.Router();

const BACKDATE_LIMIT_DAYS = 15;

router.get('/sourcing', requireLogin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.*, b.batch_code, b.status, p.name AS product_name, p.code AS product_code,
            sup.name AS supplier_name, sup.company_name AS supplier_company
     FROM sourcing_records s
     JOIN batches b ON b.id = s.batch_id
     JOIN products p ON p.id = b.product_id
     LEFT JOIN suppliers sup ON sup.id = s.supplier_id
     ORDER BY s.date DESC, s.id DESC`
  );
  res.json(rows);
});

router.post('/sourcing', requireRole('admin', 'operator'), async (req, res) => {
  const { productId, date, supplierId, supplierBatchNo, origin, bags, sackWeight, grossWeight, rate, notes } = req.body || {};

  const missing = [];
  if (!productId) missing.push('product');
  if (!date) missing.push('date');
  if (!supplierId) missing.push('supplier');
  if (!origin) missing.push('origin');
  if (!bags) missing.push('bags');
  if (!sackWeight) missing.push('sackWeight');
  if (!grossWeight) missing.push('grossWeight');
  if (!rate) missing.push('rate');
  if (missing.length) return res.status(400).json({ error: 'Missing required fields: ' + missing.join(', ') });

  // Rule: sourcing dates older than 15 days can only be entered by an admin
  // (covers correcting/backfilling old records) — operators are restricted
  // to recent, real-time entry.
  const daysOld = (Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24);
  if (daysOld > BACKDATE_LIMIT_DAYS && req.session.role !== 'admin') {
    return res.status(403).json({ error: `Only an admin can log sourcing dated more than ${BACKDATE_LIMIT_DAYS} days ago.` });
  }

  const product = (await pool.query('SELECT * FROM products WHERE id=$1', [productId])).rows[0];
  if (!product) return res.status(404).json({ error: 'Unknown product.' });
  if (product.kind !== 'raw_material') return res.status(400).json({ error: 'That product is not marked as a raw material.' });

  const supplier = (await pool.query('SELECT * FROM suppliers WHERE id=$1', [supplierId])).rows[0];
  if (!supplier) return res.status(404).json({ error: 'Unknown supplier. Add them under Catalog first.' });

  // Gunny sack weight is always derived, never hand-entered — bags x weight per bag.
  const gunnyWeight = Number(bags) * Number(sackWeight);
  const netWeight = Number(grossWeight) - gunnyWeight;
  if (netWeight <= 0) return res.status(400).json({ error: 'Net weight (gross − gunny) must be greater than zero. Check gross weight, bags, and sack weight.' });

  const batch = await createBatch({
    productCode: product.code, productId: product.id, stage: 'raw_material',
    quantity: netWeight, unit: product.unit, originType: 'sourcing', createdBy: req.session.userId,
  });

  const { rows } = await pool.query(
    `INSERT INTO sourcing_records (batch_id, date, supplier, supplier_id, supplier_batch_no, origin, bags, sack_weight, gross_weight, gunny_weight, net_weight, rate, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [batch.id, date, supplier.name, supplier.id, supplierBatchNo || null, origin, bags, sackWeight, grossWeight, gunnyWeight, netWeight, rate, notes || null, req.session.userId]
  );

  await pool.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1,$2,$3)', [
    req.session.userId, 'sourcing_added', JSON.stringify({ batchCode: batch.batch_code, product: product.name, supplier: supplier.name }),
  ]);

  res.json({ ...rows[0], batch_code: batch.batch_code, status: batch.status, product_name: product.name });
});

module.exports = router;
