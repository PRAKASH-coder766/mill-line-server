const express = require('express');
const { pool } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { validateIdParams } = require('../middleware/validateId');

const router = express.Router();

// Deliberately separate from export_customers — these are local/domestic
// buyers of oil and by-products, a different population from export trading
// partners, kept simple on purpose (Owner Decision).
router.get('/dispatch-customers', requireLogin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM dispatch_customers WHERE active=true ORDER BY name');
  res.json(rows);
});

router.post('/dispatch-customers', requireRole('admin', 'operator'), async (req, res) => {
  const { name, code, address, phone } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Customer name is required.' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO dispatch_customers (name, code, address, phone) VALUES ($1,$2,$3,$4) RETURNING *',
      [name, code || null, address || null, phone || null]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That customer code is already in use.' });
    throw err;
  }
});

router.patch('/dispatch-customers/:id', requireRole('admin'), validateIdParams('id'), async (req, res) => {
  const { active } = req.body || {};
  const { rows } = await pool.query('UPDATE dispatch_customers SET active=$1 WHERE id=$2 RETURNING *', [active, req.params.id]);
  res.json(rows[0]);
});

module.exports = router;
