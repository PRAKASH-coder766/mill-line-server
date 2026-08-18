const express = require('express');
const { pool } = require('../db');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

router.get('/batches', requireLogin, async (req, res) => {
  const { stage, status, productId, isPacked } = req.query;
  const clauses = [];
  const values = [];
  let i = 1;
  if (stage) { clauses.push(`b.stage=$${i++}`); values.push(stage); }
  if (status) { clauses.push(`b.status=$${i++}`); values.push(status); }
  if (productId) { clauses.push(`b.product_id=$${i++}`); values.push(productId); }
  if (isPacked !== undefined) { clauses.push(`b.is_packed=$${i++}`); values.push(isPacked === 'true'); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const { rows } = await pool.query(
    `SELECT b.*, p.name AS product_name, p.code AS product_code, c.name AS category_name
     FROM batches b JOIN products p ON p.id=b.product_id JOIN categories c ON c.id=p.category_id
     ${where} ORDER BY b.created_at DESC`, values
  );
  res.json(rows);
});

// Stock on hand per product — only counts approved batches with remaining quantity.
router.get('/stock', requireLogin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.id AS product_id, p.name AS product_name, p.code, p.kind, p.unit, c.name AS category_name,
            COALESCE(SUM(b.remaining_qty) FILTER (WHERE b.status='approved'), 0)::float AS stock_on_hand,
            COUNT(*) FILTER (WHERE b.status='pending_qc')::int AS pending_qc_batches,
            COUNT(*) FILTER (WHERE b.status='on_hold')::int AS on_hold_batches
     FROM products p
     JOIN categories c ON c.id = p.category_id
     LEFT JOIN batches b ON b.product_id = p.id
     WHERE p.active = true
     GROUP BY p.id, p.name, p.code, p.kind, p.unit, c.name
     ORDER BY c.name, p.kind, p.name`
  );
  res.json(rows);
});

module.exports = router;
