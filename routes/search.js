const express = require('express');
const { pool } = require('../db');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

// A single lightweight cross-module search — not a replacement for each
// module's own filters, just a fast way to jump straight to a record by
// number/name from anywhere in the app.
router.get('/export/search', requireLogin, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const like = `%${q}%`;
  const results = [];

  const quotations = (await pool.query(
    `SELECT q.id, q.quotation_no, c.company_name FROM export_quotations q
     JOIN export_customers c ON c.id = q.customer_id
     WHERE q.quotation_no ILIKE $1 OR c.company_name ILIKE $1 LIMIT 8`, [like]
  )).rows;
  for (const r of quotations) results.push({ type: 'quotation', id: r.id, label: r.quotation_no, sub: r.company_name });

  const pos = (await pool.query(
    `SELECT p.id, p.po_no, c.company_name FROM export_customer_pos p
     JOIN export_customers c ON c.id = p.customer_id
     WHERE p.po_no ILIKE $1 OR c.company_name ILIKE $1 LIMIT 8`, [like]
  )).rows;
  for (const r of pos) results.push({ type: 'customer_po', id: r.id, label: r.po_no, sub: r.company_name });

  const salesOrders = (await pool.query(
    `SELECT s.id, s.so_no, c.company_name FROM export_sales_orders s
     JOIN export_customers c ON c.id = s.customer_id
     WHERE s.so_no ILIKE $1 OR c.company_name ILIKE $1 LIMIT 8`, [like]
  )).rows;
  for (const r of salesOrders) results.push({ type: 'sales_order', id: r.id, label: r.so_no, sub: r.company_name });

  const customers = (await pool.query(
    `SELECT id, company_name, code FROM export_customers WHERE company_name ILIKE $1 OR code ILIKE $1 LIMIT 8`, [like]
  )).rows;
  for (const r of customers) results.push({ type: 'customer', id: r.id, label: r.company_name, sub: r.code });

  const variants = (await pool.query(
    `SELECT id, sku_code, variant_name FROM export_product_variants WHERE sku_code ILIKE $1 OR variant_name ILIKE $1 LIMIT 8`, [like]
  )).rows;
  for (const r of variants) results.push({ type: 'product_variant', id: r.id, label: r.sku_code, sub: r.variant_name });

  res.json(results.slice(0, 30));
});

module.exports = router;
