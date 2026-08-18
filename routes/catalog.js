const express = require('express');
const { pool } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { validateIdParams } = require('../middleware/validateId');

const router = express.Router();

// ---------- categories ----------
router.get('/categories', requireLogin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM categories ORDER BY id');
  res.json(rows);
});

router.post('/categories', requireRole('admin'), async (req, res) => {
  const { name, code } = req.body || {};
  if (!name || !code) return res.status(400).json({ error: 'Name and code are required.' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO categories (name, code) VALUES ($1,$2) RETURNING *',
      [name, code.toUpperCase()]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That name or code already exists.' });
    throw err;
  }
});

// ---------- products ----------
router.get('/products', requireLogin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.*, c.name AS category_name, c.code AS category_code
     FROM products p JOIN categories c ON c.id = p.category_id
     WHERE p.active = true
     ORDER BY c.id, p.kind, p.name`
  );
  res.json(rows);
});

router.post('/products', requireRole('admin'), async (req, res) => {
  const { categoryId, name, code, kind, unit } = req.body || {};
  if (!categoryId || !name || !code || !kind) {
    return res.status(400).json({ error: 'Category, name, code, and kind (raw_material / finished_good) are required.' });
  }
  if (!['raw_material', 'finished_good'].includes(kind)) {
    return res.status(400).json({ error: 'Kind must be raw_material or finished_good.' });
  }
  try {
    const { rows } = await pool.query(
      'INSERT INTO products (category_id, name, code, kind, unit) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [categoryId, name, code.toUpperCase(), kind, unit || 'kg']
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That product code already exists.' });
    throw err;
  }
});

router.patch('/products/:id', requireRole('admin'), validateIdParams('id'), async (req, res) => {
  const { active, classification } = req.body || {};
  const fields = [];
  const values = [];
  let i = 1;
  if (active !== undefined) { fields.push(`active=$${i++}`); values.push(active); }
  if (classification !== undefined) {
    if (!['manufactured', 'traded', 'repacked', 'outsourced'].includes(classification)) {
      return res.status(400).json({ error: 'Classification must be manufactured, traded, repacked, or outsourced.' });
    }
    fields.push(`classification=$${i++}`); values.push(classification);
  }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });
  values.push(req.params.id);
  const { rows } = await pool.query(`UPDATE products SET ${fields.join(', ')} WHERE id=$${i} RETURNING *`, values);
  res.json(rows[0]);
});

// ---------- quality parameters ----------
router.get('/quality-parameters', requireLogin, async (req, res) => {
  const { productId } = req.query;
  const q = productId
    ? pool.query('SELECT * FROM quality_parameters WHERE product_id=$1 AND active=true ORDER BY sort_order, id', [productId])
    : pool.query('SELECT * FROM quality_parameters WHERE active=true ORDER BY product_id, sort_order, id');
  const { rows } = await q;
  res.json(rows);
});

router.post('/quality-parameters', requireRole('admin', 'qc'), async (req, res) => {
  const { productId, stage, name, unit, minValue, maxValue } = req.body || {};
  if (!productId || !stage || !name) return res.status(400).json({ error: 'Product, stage, and parameter name are required.' });
  if (!['raw_material', 'finished_good'].includes(stage)) return res.status(400).json({ error: 'Stage must be raw_material or finished_good.' });
  if ((minValue === undefined || minValue === '' || minValue === null) && (maxValue === undefined || maxValue === '' || maxValue === null)) {
    return res.status(400).json({ error: 'Provide at least a minimum or maximum acceptable value.' });
  }
  const { rows } = await pool.query(
    'INSERT INTO quality_parameters (product_id, stage, name, unit, min_value, max_value) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [productId, stage, name, unit || null, minValue || null, maxValue || null]
  );
  res.json(rows[0]);
});

router.delete('/quality-parameters/:id', requireRole('admin'), validateIdParams('id'), async (req, res) => {
  await pool.query('UPDATE quality_parameters SET active=false WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ---------- process definitions ----------
// A process definition maps a process name (e.g. "Groundnut Oil") to the
// output products it's expected to produce (e.g. Groundnut Oil + Groundnut Oil
// Cake). Selecting the process name in Processing auto-fills these outputs.
router.get('/process-definitions', requireLogin, async (req, res) => {
  const defs = (await pool.query(
    `SELECT pd.*, c.name AS category_name FROM process_definitions pd
     LEFT JOIN categories c ON c.id = pd.category_id
     WHERE pd.active = true ORDER BY pd.name`
  )).rows;
  for (const def of defs) {
    def.outputs = (await pool.query(
      `SELECT p.id, p.name, p.code, p.unit FROM process_definition_outputs pdo
       JOIN products p ON p.id = pdo.product_id WHERE pdo.process_definition_id=$1`,
      [def.id]
    )).rows;
    def.inputs = (await pool.query(
      `SELECT p.id, p.name, p.code, p.unit FROM process_definition_inputs pdi
       JOIN products p ON p.id = pdi.product_id WHERE pdi.process_definition_id=$1`,
      [def.id]
    )).rows;
  }
  res.json(defs);
});

// body: { name, categoryId, outputProductIds: [1,2], inputProductIds: [3], rmWastagePct, pmWastagePct }
router.post('/process-definitions', requireRole('admin'), async (req, res) => {
  const { name, categoryId, outputProductIds, inputProductIds, rmWastagePct, pmWastagePct } = req.body || {};
  if (!name || !Array.isArray(outputProductIds) || outputProductIds.length === 0) {
    return res.status(400).json({ error: 'Process name and at least one output product are required.' });
  }
  try {
    const { rows } = await pool.query(
      'INSERT INTO process_definitions (name, category_id, rm_wastage_pct, pm_wastage_pct) VALUES ($1,$2,$3,$4) RETURNING *',
      [name, categoryId || null, rmWastagePct || null, pmWastagePct || null]
    );
    const def = rows[0];
    for (const pid of outputProductIds) {
      await pool.query('INSERT INTO process_definition_outputs (process_definition_id, product_id) VALUES ($1,$2)', [def.id, pid]);
    }
    for (const pid of (inputProductIds || [])) {
      await pool.query('INSERT INTO process_definition_inputs (process_definition_id, product_id) VALUES ($1,$2)', [def.id, pid]);
    }
    res.json(def);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A process with that name already exists.' });
    throw err;
  }
});

router.delete('/process-definitions/:id', requireRole('admin'), validateIdParams('id'), async (req, res) => {
  await pool.query('UPDATE process_definitions SET active=false WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ---------- Pack types / sizes (shared master list, used by Packing) ----------
router.get('/pack-types', requireLogin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM pack_types WHERE active=true ORDER BY name');
  res.json(rows);
});
router.post('/pack-types', requireRole('admin'), async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  try {
    const { rows } = await pool.query('INSERT INTO pack_types (name) VALUES ($1) RETURNING *', [name]);
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That pack type already exists.' });
    throw err;
  }
});

router.get('/pack-sizes', requireLogin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM pack_sizes WHERE active=true ORDER BY weight_kg NULLS LAST, label');
  res.json(rows);
});
router.post('/pack-sizes', requireRole('admin'), async (req, res) => {
  const { label, weightKg } = req.body || {};
  if (!label) return res.status(400).json({ error: 'Label is required.' });
  try {
    const { rows } = await pool.query('INSERT INTO pack_sizes (label, weight_kg) VALUES ($1,$2) RETURNING *', [label, weightKg || null]);
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That pack size already exists.' });
    throw err;
  }
});
router.patch('/pack-sizes/:id', requireRole('admin'), validateIdParams('id'), async (req, res) => {
  const { weightKg } = req.body || {};
  const { rows } = await pool.query('UPDATE pack_sizes SET weight_kg=$1 WHERE id=$2 RETURNING *', [weightKg, req.params.id]);
  res.json(rows[0]);
});

module.exports = router;
