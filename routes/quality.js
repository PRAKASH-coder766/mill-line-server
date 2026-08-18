const express = require('express');
const { pool } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');

const router = express.Router();

// Batches waiting on a QC decision
router.get('/quality/pending', requireLogin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.*, p.name AS product_name, p.code AS product_code
     FROM batches b JOIN products p ON p.id = b.product_id
     WHERE b.status = 'pending_qc'
     ORDER BY b.created_at ASC`
  );
  res.json(rows);
});

router.get('/quality/inspections', requireLogin, async (req, res) => {
  const { batchId } = req.query;
  const base = `
    SELECT qi.*, u.name AS inspector_name, b.batch_code, p.name AS product_name
    FROM quality_inspections qi
    LEFT JOIN users u ON u.id = qi.inspector_id
    JOIN batches b ON b.id = qi.batch_id
    JOIN products p ON p.id = b.product_id`;
  const { rows } = batchId
    ? await pool.query(base + ' WHERE qi.batch_id=$1 ORDER BY qi.created_at DESC', [batchId])
    : await pool.query(base + ' ORDER BY qi.created_at DESC LIMIT 100');

  for (const insp of rows) {
    insp.readings = (await pool.query(
      `SELECT r.*, qp.name AS parameter_name, qp.unit, qp.min_value, qp.max_value
       FROM quality_inspection_readings r JOIN quality_parameters qp ON qp.id = r.parameter_id
       WHERE r.inspection_id=$1`, [insp.id]
    )).rows;
  }
  res.json(rows);
});

// body: { batchId, decision, notes, inspectedAt, readings: [{ parameterId, measuredValue }] }
router.post('/quality/inspections', requireRole('admin', 'qc'), async (req, res) => {
  const { batchId, decision, notes, inspectedAt, readings } = req.body || {};
  if (!batchId || !decision) return res.status(400).json({ error: 'Batch and decision are required.' });
  if (!['pass', 'fail', 'hold'].includes(decision)) return res.status(400).json({ error: 'Decision must be pass, fail, or hold.' });

  const batch = (await pool.query('SELECT * FROM batches WHERE id=$1', [batchId])).rows[0];
  if (!batch) return res.status(404).json({ error: 'Batch not found.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const insp = (await client.query(
      'INSERT INTO quality_inspections (batch_id, inspector_id, decision, notes, inspected_at) VALUES ($1,$2,$3,$4,COALESCE($5,now())) RETURNING *',
      [batchId, req.session.userId, decision, notes || null, inspectedAt || null]
    )).rows[0];

    for (const r of (readings || [])) {
      const param = (await client.query('SELECT * FROM quality_parameters WHERE id=$1', [r.parameterId])).rows[0];
      if (!param) continue;
      const v = Number(r.measuredValue);
      const withinLimits = (param.min_value === null || v >= Number(param.min_value)) && (param.max_value === null || v <= Number(param.max_value));
      await client.query(
        'INSERT INTO quality_inspection_readings (inspection_id, parameter_id, measured_value, within_limits) VALUES ($1,$2,$3,$4)',
        [insp.id, param.id, v, withinLimits]
      );
    }

    const newStatus = decision === 'pass' ? 'approved' : decision === 'fail' ? 'rejected' : 'on_hold';
    await client.query('UPDATE batches SET status=$1 WHERE id=$2', [newStatus, batchId]);

    await client.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1,$2,$3)', [
      req.session.userId, 'quality_inspection', JSON.stringify({ batchCode: batch.batch_code, decision }),
    ]);

    await client.query('COMMIT');
    res.json({ ...insp, newStatus });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
