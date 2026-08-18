const express = require('express');
const { pool } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { validateIdParams } = require('../middleware/validateId');

const router = express.Router();

// ---------- Countries ----------
router.get('/export/countries', requireLogin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM export_countries WHERE active = true ORDER BY name');
  res.json(rows);
});
router.post('/export/countries', requireRole('admin'), async (req, res) => {
  const { name, isoCode } = req.body || {};
  if (!name || !isoCode) return res.status(400).json({ error: 'Country name and ISO code are required.' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO export_countries (name, iso_code) VALUES ($1,$2) RETURNING *',
      [name, isoCode.toUpperCase()]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That country or ISO code already exists.' });
    throw err;
  }
});
router.patch('/export/countries/:id', requireRole('admin'), validateIdParams('id'), async (req, res) => {
  const { active } = req.body || {};
  const { rows } = await pool.query('UPDATE export_countries SET active=$1 WHERE id=$2 RETURNING *', [active, req.params.id]);
  res.json(rows[0]);
});

// ---------- Currencies ----------
router.get('/export/currencies', requireLogin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM export_currencies WHERE active = true ORDER BY code');
  res.json(rows);
});
router.post('/export/currencies', requireRole('admin'), async (req, res) => {
  const { code, name, symbol } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: 'Currency code and name are required.' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO export_currencies (code, name, symbol) VALUES ($1,$2,$3) RETURNING *',
      [code.toUpperCase(), name, symbol || null]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That currency code already exists.' });
    throw err;
  }
});
router.patch('/export/currencies/:id', requireRole('admin'), validateIdParams('id'), async (req, res) => {
  const { active } = req.body || {};
  const { rows } = await pool.query('UPDATE export_currencies SET active=$1 WHERE id=$2 RETURNING *', [active, req.params.id]);
  res.json(rows[0]);
});

// ---------- Ports ----------
router.get('/export/ports', requireLogin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.*, c.name AS country_name FROM export_ports p
     LEFT JOIN export_countries c ON c.id = p.country_id
     WHERE p.active = true ORDER BY p.name`
  );
  res.json(rows);
});
router.post('/export/ports', requireRole('admin'), async (req, res) => {
  const { name, portCode, countryId, portType } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Port name is required.' });
  const { rows } = await pool.query(
    'INSERT INTO export_ports (name, port_code, country_id, port_type) VALUES ($1,$2,$3,$4) RETURNING *',
    [name, portCode || null, countryId || null, portType || 'both']
  );
  res.json(rows[0]);
});
router.patch('/export/ports/:id', requireRole('admin'), validateIdParams('id'), async (req, res) => {
  const { active } = req.body || {};
  const { rows } = await pool.query('UPDATE export_ports SET active=$1 WHERE id=$2 RETURNING *', [active, req.params.id]);
  res.json(rows[0]);
});

// ---------- Incoterms ----------
router.get('/export/incoterms', requireLogin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM export_incoterms WHERE active = true ORDER BY code');
  res.json(rows);
});
router.post('/export/incoterms', requireRole('admin'), async (req, res) => {
  const { code, name } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: 'Incoterm code and name are required.' });
  try {
    const { rows } = await pool.query('INSERT INTO export_incoterms (code, name) VALUES ($1,$2) RETURNING *', [code.toUpperCase(), name]);
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That incoterm code already exists.' });
    throw err;
  }
});
router.patch('/export/incoterms/:id', requireRole('admin'), validateIdParams('id'), async (req, res) => {
  const { active } = req.body || {};
  const { rows } = await pool.query('UPDATE export_incoterms SET active=$1 WHERE id=$2 RETURNING *', [active, req.params.id]);
  res.json(rows[0]);
});

// ---------- Payment terms ----------
router.get('/export/payment-terms', requireLogin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM export_payment_terms WHERE active = true ORDER BY name');
  res.json(rows);
});
router.post('/export/payment-terms', requireRole('admin'), async (req, res) => {
  const { name, description } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Payment term name is required.' });
  try {
    const { rows } = await pool.query('INSERT INTO export_payment_terms (name, description) VALUES ($1,$2) RETURNING *', [name, description || null]);
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That payment term already exists.' });
    throw err;
  }
});
router.patch('/export/payment-terms/:id', requireRole('admin'), validateIdParams('id'), async (req, res) => {
  const { active } = req.body || {};
  const { rows } = await pool.query('UPDATE export_payment_terms SET active=$1 WHERE id=$2 RETURNING *', [active, req.params.id]);
  res.json(rows[0]);
});

// ---------- Container types ----------
router.get('/export/container-types', requireLogin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM export_container_types WHERE active = true ORDER BY name');
  res.json(rows);
});
router.post('/export/container-types', requireRole('admin'), async (req, res) => {
  const { name, maxCbm, maxWeightKg } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Container type name is required.' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO export_container_types (name, max_cbm, max_weight_kg) VALUES ($1,$2,$3) RETURNING *',
      [name, maxCbm || null, maxWeightKg || null]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That container type already exists.' });
    throw err;
  }
});
router.patch('/export/container-types/:id', requireRole('admin'), validateIdParams('id'), async (req, res) => {
  const { active } = req.body || {};
  const { rows } = await pool.query('UPDATE export_container_types SET active=$1 WHERE id=$2 RETURNING *', [active, req.params.id]);
  res.json(rows[0]);
});

// ---------- Document number settings (Owner Decision 3: configurable, not hard-coded) ----------
router.get('/export/document-number-settings', requireLogin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM export_document_number_settings ORDER BY document_type');
  res.json(rows);
});
router.patch('/export/document-number-settings/:documentType', requireRole('admin'), async (req, res) => {
  const { prefix, code } = req.body || {};
  const fields = [];
  const values = [];
  let i = 1;
  if (prefix !== undefined) { fields.push(`prefix=$${i++}`); values.push(prefix); }
  if (code !== undefined) { fields.push(`code=$${i++}`); values.push(code); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });
  values.push(req.params.documentType);
  const { rows } = await pool.query(
    `UPDATE export_document_number_settings SET ${fields.join(', ')} WHERE document_type=$${i} RETURNING *`,
    values
  );
  res.json(rows[0]);
});

// ---------- Supplier categories (many-to-many with the existing suppliers table) ----------
router.get('/export/supplier-categories', requireLogin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM export_supplier_categories ORDER BY name');
  res.json(rows);
});
router.post('/export/supplier-categories', requireRole('admin'), async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Category name is required.' });
  try {
    const { rows } = await pool.query('INSERT INTO export_supplier_categories (name) VALUES ($1) RETURNING *', [name]);
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That category already exists.' });
    throw err;
  }
});

// Assign/revoke a category on an existing supplier (from the existing Mill Line suppliers table).
router.get('/export/suppliers/:supplierId/categories', requireLogin, validateIdParams('supplierId'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.* FROM supplier_category_links l JOIN export_supplier_categories c ON c.id = l.category_id
     WHERE l.supplier_id = $1 ORDER BY c.name`,
    [req.params.supplierId]
  );
  res.json(rows);
});
router.post('/export/suppliers/:supplierId/categories', requireRole('admin'), validateIdParams('supplierId'), async (req, res) => {
  const { categoryId } = req.body || {};
  if (!categoryId) return res.status(400).json({ error: 'categoryId is required.' });
  await pool.query(
    'INSERT INTO supplier_category_links (supplier_id, category_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [req.params.supplierId, categoryId]
  );
  res.json({ ok: true });
});
router.delete('/export/suppliers/:supplierId/categories/:categoryId', requireRole('admin'), validateIdParams('supplierId', 'categoryId'), async (req, res) => {
  await pool.query(
    'DELETE FROM supplier_category_links WHERE supplier_id=$1 AND category_id=$2',
    [req.params.supplierId, req.params.categoryId]
  );
  res.json({ ok: true });
});

module.exports = router;
