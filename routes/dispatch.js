const express = require('express');
const { pool } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/dispatch', requireLogin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT d.*, b.batch_code, p.name AS product_name, dc.name AS customer_master_name, dc.code AS customer_code
     FROM dispatch d JOIN batches b ON b.id = d.batch_id JOIN products p ON p.id = b.product_id
     LEFT JOIN dispatch_customers dc ON dc.id = d.customer_id
     ORDER BY d.date DESC, d.id DESC`
  );
  for (const r of rows) r.display_customer = r.customer_master_name || r.customer;
  res.json(rows);
});

router.post('/dispatch', requireRole('admin', 'operator'), async (req, res) => {
  const { batchId, date, customerId, customer, quantity, rate, notes } = req.body || {};
  let resolvedCustomerName = customer || null;
  if (customerId) {
    const dc = (await pool.query('SELECT * FROM dispatch_customers WHERE id=$1', [customerId])).rows[0];
    if (!dc) return res.status(404).json({ error: 'Unknown customer.' });
    resolvedCustomerName = dc.name;
  }
  if (!batchId || !date || !resolvedCustomerName || !quantity) return res.status(400).json({ error: 'Batch, date, customer, and quantity are required.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const batch = (await client.query('SELECT * FROM batches WHERE id=$1 FOR UPDATE', [batchId])).rows[0];
    if (!batch) throw new Error('Batch not found.');
    if (batch.stage !== 'finished_good') throw new Error('Only finished-good batches can be dispatched.');
    if (!batch.is_packed) throw new Error(`Batch ${batch.batch_code} hasn't been packed yet. Pack it first under the Packing tab.`);
    if (batch.status !== 'approved') throw new Error(`Batch ${batch.batch_code} is not QC-approved (status: ${batch.status}).`);
    if (Number(quantity) > Number(batch.remaining_qty)) throw new Error(`Only ${batch.remaining_qty} ${batch.unit} remaining in batch ${batch.batch_code}.`);

    const { rows } = await client.query(
      'INSERT INTO dispatch (batch_id, date, customer, customer_id, quantity, rate, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [batchId, date, resolvedCustomerName, customerId || null, quantity, rate || 0, notes || null, req.session.userId]
    );

    const newRemaining = Number(batch.remaining_qty) - Number(quantity);
    await client.query('UPDATE batches SET remaining_qty=$1, status=$2 WHERE id=$3', [
      Math.max(newRemaining, 0), newRemaining <= 0.0001 ? 'dispatched' : batch.status, batchId,
    ]);

    await client.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1,$2,$3)', [
      req.session.userId, 'dispatch_added', JSON.stringify({ batchCode: batch.batch_code, customer, quantity }),
    ]);

    await client.query('COMMIT');
    res.json({ ...rows[0], batch_code: batch.batch_code });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
