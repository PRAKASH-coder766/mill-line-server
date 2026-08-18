const express = require('express');
const { pool } = require('../db');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

router.get('/export/timeline', requireLogin, async (req, res) => {
  const { salesOrderId, quotationId } = req.query;
  if (!salesOrderId && !quotationId) return res.status(400).json({ error: 'salesOrderId or quotationId is required.' });

  const clauses = [];
  const values = [];
  let i = 1;
  if (salesOrderId) { clauses.push(`sales_order_id=$${i++}`); values.push(salesOrderId); }
  if (quotationId) { clauses.push(`quotation_id=$${i++}`); values.push(quotationId); }

  const { rows } = await pool.query(
    `SELECT t.*, u.name AS created_by_name FROM export_order_timeline t
     LEFT JOIN users u ON u.id = t.created_by
     WHERE ${clauses.join(' OR ')} ORDER BY t.event_at`,
    values
  );
  res.json(rows);
});

module.exports = router;
