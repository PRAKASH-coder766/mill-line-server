const express = require('express');
const { pool } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { createBatch } = require('../utils/batchCode');

const router = express.Router();

router.get('/processing', requireLogin, async (req, res) => {
  const runs = (await pool.query('SELECT * FROM processing_runs ORDER BY date DESC, id DESC')).rows;
  for (const run of runs) {
    run.inputs = (await pool.query(
      `SELECT pi.*, b.batch_code, p.name AS product_name FROM processing_inputs pi
       JOIN batches b ON b.id = pi.batch_id JOIN products p ON p.id = b.product_id
       WHERE pi.processing_run_id=$1`, [run.id]
    )).rows;
    run.outputs = (await pool.query(
      `SELECT po.*, b.batch_code, b.status, p.name AS product_name FROM processing_outputs po
       JOIN batches b ON b.id = po.batch_id JOIN products p ON p.id = b.product_id
       WHERE po.processing_run_id=$1`, [run.id]
    )).rows;
  }
  res.json(runs);
});

// body: { processDefinitionId, date, shift, labour, notes,
//         inputs: [{ batchId, quantityUsed }],
//         outputs: [{ productId, quantity }] }
router.post('/processing', requireRole('admin', 'operator'), async (req, res) => {
  const { processDefinitionId, date, shift, labour, notes, inputs, outputs } = req.body || {};
  if (!processDefinitionId || !date || !shift || !Array.isArray(inputs) || inputs.length === 0 || !Array.isArray(outputs) || outputs.length === 0) {
    return res.status(400).json({ error: 'Process name, date, shift, at least one input batch, and at least one output are required.' });
  }
  const outputProductIds = outputs.map(o => o.productId);
  if (new Set(outputProductIds).size !== outputProductIds.length) {
    return res.status(400).json({ error: 'The same product was selected for more than one output line — combine them into a single line instead.' });
  }

  const processDef = (await pool.query('SELECT * FROM process_definitions WHERE id=$1', [processDefinitionId])).rows[0];
  if (!processDef) return res.status(404).json({ error: 'Unknown process. Pick one from the list, or add it under Catalog first.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Validate + lock input batches
    const inputBatches = [];
    for (const inp of inputs) {
      const { rows } = await client.query('SELECT * FROM batches WHERE id=$1 FOR UPDATE', [inp.batchId]);
      const b = rows[0];
      if (!b) throw new Error(`Input batch ${inp.batchId} not found.`);
      if (b.status !== 'approved') throw new Error(`Batch ${b.batch_code} is not QC-approved (status: ${b.status}). Only approved batches can be used as input.`);
      if (Number(inp.quantityUsed) <= 0) throw new Error(`Quantity used for ${b.batch_code} must be greater than zero.`);
      if (Number(inp.quantityUsed) > Number(b.remaining_qty)) throw new Error(`Only ${b.remaining_qty} ${b.unit} remaining in batch ${b.batch_code}, cannot use ${inp.quantityUsed}.`);
      inputBatches.push({ batch: b, quantityUsed: Number(inp.quantityUsed) });
    }

    // Mass balance: you can't produce more output than the raw material you put in.
    const totalInput = inputBatches.reduce((s, i) => s + i.quantityUsed, 0);
    const totalOutput = outputs.reduce((s, o) => s + Number(o.quantity || 0), 0);
    if (totalOutput > totalInput + 0.0001) {
      throw new Error(`Total output quantity (${totalOutput}) cannot exceed total input quantity (${totalInput}).`);
    }

    const run = (await client.query(
      `INSERT INTO processing_runs (process_name, process_definition_id, date, shift, labour, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [processDef.name, processDef.id, date, shift, labour || 0, notes || null, req.session.userId]
    )).rows[0];

    // Record inputs + decrement remaining_qty
    for (const { batch, quantityUsed } of inputBatches) {
      await client.query('INSERT INTO processing_inputs (processing_run_id, batch_id, quantity_used) VALUES ($1,$2,$3)', [run.id, batch.id, quantityUsed]);
      const newRemaining = Number(batch.remaining_qty) - quantityUsed;
      const newStatus = newRemaining <= 0.0001 ? 'consumed' : batch.status;
      await client.query('UPDATE batches SET remaining_qty=$1, status=$2 WHERE id=$3', [Math.max(newRemaining,0), newStatus, batch.id]);
    }

    // Create output batches + lineage
    const createdOutputs = [];
    for (const out of outputs) {
      if (!out.productId || !Number(out.quantity) || Number(out.quantity) <= 0) {
        throw new Error('Each output needs a product and a positive quantity.');
      }
      const product = (await client.query('SELECT * FROM products WHERE id=$1', [out.productId])).rows[0];
      if (!product) throw new Error(`Unknown output product ${out.productId}.`);

      const insert = await client.query(
        `INSERT INTO batches (batch_code, product_id, stage, quantity, remaining_qty, unit, origin_type, created_by)
         VALUES ('PENDING',$1,'finished_good',$2,$2,$3,'processing',$4) RETURNING id`,
        [product.id, out.quantity, product.unit, req.session.userId]
      );
      const id = insert.rows[0].id;
      const dateStr = new Date().toISOString().slice(0,10).replace(/-/g,'');
      const code = `KAF-${product.code}-${dateStr}-${String(id).padStart(6,'0')}`;
      const outputBatch = (await client.query('UPDATE batches SET batch_code=$1 WHERE id=$2 RETURNING *', [code, id])).rows[0];

      await client.query('INSERT INTO processing_outputs (processing_run_id, batch_id, quantity) VALUES ($1,$2,$3)', [run.id, outputBatch.id, out.quantity]);

      for (const { batch, quantityUsed } of inputBatches) {
        await client.query(
          'INSERT INTO batch_lineage (parent_batch_id, child_batch_id, quantity_used, processing_run_id) VALUES ($1,$2,$3,$4)',
          [batch.id, outputBatch.id, quantityUsed, run.id]
        );
      }
      createdOutputs.push({ ...outputBatch, product_name: product.name });
    }

    await client.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1,$2,$3)', [
      req.session.userId, 'processing_run_added',
      JSON.stringify({ runId: run.id, process: processDef.name, outputs: createdOutputs.map(o=>o.batch_code) }),
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
