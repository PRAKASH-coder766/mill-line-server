const express = require('express');
const { pool } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/packing', requireLogin, async (req, res) => {
  const runs = (await pool.query('SELECT * FROM packing_runs ORDER BY date DESC, id DESC')).rows;
  for (const run of runs) {
    run.inputs = (await pool.query(
      `SELECT pi.*, b.batch_code, p.name AS product_name FROM packing_inputs pi
       JOIN batches b ON b.id = pi.batch_id JOIN products p ON p.id = b.product_id
       WHERE pi.packing_run_id=$1`, [run.id]
    )).rows;
    run.outputs = (await pool.query(
      `SELECT po.*, b.batch_code, b.status, b.pack_type, b.pack_size, b.units_per_pack, p.name AS product_name
       FROM packing_outputs po JOIN batches b ON b.id = po.batch_id JOIN products p ON p.id = b.product_id
       WHERE po.packing_run_id=$1`, [run.id]
    )).rows;
  }
  res.json(runs);
});

// body: { packName, date, shift, labour, notes,
//         inputs: [{ batchId, quantityUsed }],
//         outputs: [{ productId, quantity, packType, packSize, unitsPerPack }] }
router.post('/packing', requireRole('admin', 'operator'), async (req, res) => {
  const { packName, date, shift, labour, notes, inputs, outputs } = req.body || {};
  if (!packName || !date || !shift || !Array.isArray(inputs) || inputs.length === 0 || !Array.isArray(outputs) || outputs.length === 0) {
    return res.status(400).json({ error: 'Pack name, date, shift, at least one input batch, and at least one packed output are required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const inputBatches = [];
    for (const inp of inputs) {
      const { rows } = await client.query('SELECT * FROM batches WHERE id=$1 FOR UPDATE', [inp.batchId]);
      const b = rows[0];
      if (!b) throw new Error(`Input batch ${inp.batchId} not found.`);
      if (b.stage !== 'finished_good') throw new Error(`Batch ${b.batch_code} is not a finished good and cannot be packed.`);
      if (b.status !== 'approved') throw new Error(`Batch ${b.batch_code} is not QC-approved (status: ${b.status}).`);
      if (Number(inp.quantityUsed) <= 0) throw new Error(`Quantity used for ${b.batch_code} must be greater than zero.`);
      if (Number(inp.quantityUsed) > Number(b.remaining_qty)) throw new Error(`Only ${b.remaining_qty} ${b.unit} remaining in batch ${b.batch_code}, cannot use ${inp.quantityUsed}.`);
      inputBatches.push({ batch: b, quantityUsed: Number(inp.quantityUsed) });
    }

    const totalInput = inputBatches.reduce((s, i) => s + i.quantityUsed, 0);
    const totalOutput = outputs.reduce((s, o) => s + Number(o.quantity || 0), 0);
    if (totalOutput > totalInput + 0.0001) {
      throw new Error(`Total packed quantity (${totalOutput}) cannot exceed total input quantity (${totalInput}).`);
    }

    const run = (await client.query(
      `INSERT INTO packing_runs (pack_name, date, shift, labour, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [packName, date, shift, labour || 0, notes || null, req.session.userId]
    )).rows[0];

    for (const { batch, quantityUsed } of inputBatches) {
      await client.query('INSERT INTO packing_inputs (packing_run_id, batch_id, quantity_used) VALUES ($1,$2,$3)', [run.id, batch.id, quantityUsed]);
      const newRemaining = Number(batch.remaining_qty) - quantityUsed;
      const newStatus = newRemaining <= 0.0001 ? 'consumed' : batch.status;
      await client.query('UPDATE batches SET remaining_qty=$1, status=$2 WHERE id=$3', [Math.max(newRemaining,0), newStatus, batch.id]);
    }

    const createdOutputs = [];
    for (const out of outputs) {
      if (!out.productId || !Number(out.quantity) || Number(out.quantity) <= 0) {
        throw new Error('Each packed output needs a product and a positive quantity.');
      }
      const product = (await client.query('SELECT * FROM products WHERE id=$1', [out.productId])).rows[0];
      if (!product) throw new Error(`Unknown output product ${out.productId}.`);

      const insert = await client.query(
        `INSERT INTO batches (batch_code, product_id, stage, quantity, remaining_qty, unit, origin_type, created_by, is_packed, pack_type, pack_size, units_per_pack)
         VALUES ('PENDING',$1,'finished_good',$2,$2,$3,'processing',$4,true,$5,$6,$7) RETURNING id`,
        [product.id, out.quantity, product.unit, req.session.userId, out.packType || null, out.packSize || null, out.unitsPerPack || null]
      );
      const id = insert.rows[0].id;
      const dateStr = new Date().toISOString().slice(0,10).replace(/-/g,'');
      const code = `KAF-${product.code}-PACK-${dateStr}-${String(id).padStart(6,'0')}`;
      const outputBatch = (await client.query('UPDATE batches SET batch_code=$1 WHERE id=$2 RETURNING *', [code, id])).rows[0];

      // Packed goods carry the QC status of a fresh batch — pending inspection
      // before it can ship, even though the bulk material was already approved.
      await client.query('INSERT INTO packing_outputs (packing_run_id, batch_id, quantity) VALUES ($1,$2,$3)', [run.id, outputBatch.id, out.quantity]);

      for (const { batch, quantityUsed } of inputBatches) {
        await client.query(
          'INSERT INTO batch_lineage (parent_batch_id, child_batch_id, quantity_used, processing_run_id) VALUES ($1,$2,$3,$4)',
          [batch.id, outputBatch.id, quantityUsed, run.id]
        );
      }
      createdOutputs.push({ ...outputBatch, product_name: product.name });
    }

    await client.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1,$2,$3)', [
      req.session.userId, 'packing_run_added',
      JSON.stringify({ runId: run.id, pack: packName, outputs: createdOutputs.map(o=>o.batch_code) }),
    ]);

    await client.query('COMMIT');
    res.json({ run, outputs: createdOutputs });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
