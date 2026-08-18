const express = require('express');
const { pool } = require('../db');
const { requireLogin } = require('../middleware/auth');
const { requireAnyRole } = require('../utils/rbac');
const { validateIdParams } = require('../middleware/validateId');
const { startApprovalRun } = require('../utils/approvals');

const router = express.Router();

async function getConfig(key, fallback) {
  const row = (await pool.query('SELECT value FROM urid_config WHERE key=$1', [key])).rows[0];
  return row ? Number(row.value) : fallback;
}
async function nextBatchNo(prefix, table) {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE batch_no LIKE $1`, [`${prefix}-${dateStr}-%`]);
  return `${prefix}-${dateStr}-${String(rows[0].n + 1).padStart(3, '0')}`;
}

router.get('/urid/loss-reasons', requireLogin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM urid_loss_reasons WHERE active=true ORDER BY name');
  res.json(rows);
});

// Available (unconsumed) Good Material from approved Pre-Processing batches
// — this is what "PP-20260817-001 — Available 10,000 kg" (spec section 11)
// actually is: the linked batches.remaining_qty for each approved PP batch's
// Good Material lot.
router.get('/urid/available-good-material', requireLogin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT pp.id AS preprocessing_batch_id, pp.batch_no, b.id AS good_material_batch_id, b.batch_code,
            b.remaining_qty, b.unit, b.status AS batch_status
     FROM urid_preprocessing_batches pp
     JOIN batches b ON b.id = pp.good_material_batch_id
     WHERE pp.status='approved' AND b.remaining_qty > 0
     ORDER BY pp.batch_no`
  );
  res.json(rows);
});

router.get('/urid/dhall-batches', requireLogin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT db.*, u1.name AS operator_name, u2.name AS supervisor_name, lr.name AS process_loss_reason
     FROM urid_dhall_batches db
     LEFT JOIN users u1 ON u1.id = db.operator_id
     LEFT JOIN users u2 ON u2.id = db.supervisor_id
     LEFT JOIN urid_loss_reasons lr ON lr.id = db.process_loss_reason_id
     ORDER BY db.created_at DESC`
  );
  res.json(rows);
});

// Applies the approved Dhall run: mints real stock batches for whole/split/
// dust, and records proportional lineage back to every Good Material batch
// that contributed to this run (a Dhall run can blend several Stage 1
// batches, so no single input gets 100% credit for any one output).
async function applyDhallApproval(dhallBatchId, approvedBy) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const batch = (await client.query('SELECT * FROM urid_dhall_batches WHERE id=$1 FOR UPDATE', [dhallBatchId])).rows[0];
    if (!batch || batch.status !== 'awaiting_review') { await client.query('ROLLBACK'); return; }

    const inputs = (await client.query('SELECT * FROM urid_dhall_inputs WHERE dhall_batch_id=$1', [dhallBatchId])).rows;
    const outputs = (await client.query('SELECT * FROM urid_dhall_outputs WHERE dhall_batch_id=$1', [dhallBatchId])).rows;
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const productCodeFor = { whole: 'URID-WHOLEDHALL', split: 'URID-SPLITDHALL', dust: 'URID-DUST' };
    const batchIdFields = { whole: 'whole_batch_id', split: 'split_batch_id', dust: 'dust_batch_id' };

    for (const out of outputs) {
      if (out.output_type === 'other' || Number(out.quantity) <= 0) continue;
      const productCode = productCodeFor[out.output_type];
      const product = (await client.query('SELECT * FROM products WHERE code=$1', [productCode])).rows[0];
      if (!product) continue;

      const insert = await client.query(
        `INSERT INTO batches (batch_code, product_id, stage, quantity, remaining_qty, unit, status, origin_type, created_by, is_packed, pack_type, pack_size)
         VALUES ('PENDING',$1,'finished_good',$2,$2,'kg','pending_qc','processing',$3,false,NULL,$4) RETURNING id`,
        [product.id, out.quantity, approvedBy, out.bag_size || null]
      );
      const id = insert.rows[0].id;
      const code = `KAF-${productCode}-${dateStr}-${String(id).padStart(6, '0')}`;
      const stockBatch = (await client.query('UPDATE batches SET batch_code=$1 WHERE id=$2 RETURNING *', [code, id])).rows[0];
      await client.query('UPDATE urid_dhall_outputs SET stock_batch_id=$1 WHERE id=$2', [stockBatch.id, out.id]);
      await client.query(`UPDATE urid_dhall_batches SET ${batchIdFields[out.output_type]}=$1 WHERE id=$2`, [stockBatch.id, dhallBatchId]);

      // Proportional lineage: each input contributed a share of the total,
      // so it gets that same share of credit for every output.
      for (const input of inputs) {
        const share = Number(input.quantity_consumed) / Number(batch.total_input_qty);
        const attributedQty = share * Number(out.quantity);
        if (attributedQty <= 0) continue;
        await client.query(
          'INSERT INTO batch_lineage (parent_batch_id, child_batch_id, quantity_used, processing_run_id) VALUES ($1,$2,$3,$4)',
          [input.good_material_batch_id, stockBatch.id, attributedQty.toFixed(3), null]
        );
      }
    }

    await client.query(`UPDATE urid_dhall_batches SET status='approved' WHERE id=$1`, [dhallBatchId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

router.get('/urid/dhall-batches/:id', requireLogin, validateIdParams('id'), async (req, res) => {
  const batch = (await pool.query(
    `SELECT db.*, u1.name AS operator_name, u2.name AS supervisor_name, lr.name AS process_loss_reason
     FROM urid_dhall_batches db
     LEFT JOIN users u1 ON u1.id = db.operator_id
     LEFT JOIN users u2 ON u2.id = db.supervisor_id
     LEFT JOIN urid_loss_reasons lr ON lr.id = db.process_loss_reason_id
     WHERE db.id=$1`, [req.params.id]
  )).rows[0];
  if (!batch) return res.status(404).json({ error: 'Batch not found.' });

  const latestRun = (await pool.query(
    `SELECT * FROM approval_runs WHERE document_type='urid_dhall_processing' AND document_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [req.params.id]
  )).rows[0];
  if (latestRun && batch.status === 'awaiting_review') {
    if (latestRun.status === 'approved') {
      await applyDhallApproval(batch.id, latestRun.created_by);
      const refreshed = (await pool.query('SELECT * FROM urid_dhall_batches WHERE id=$1', [req.params.id])).rows[0];
      Object.assign(batch, refreshed);
    } else if (latestRun.status === 'rejected') {
      await pool.query(`UPDATE urid_dhall_batches SET status='cancelled' WHERE id=$1`, [req.params.id]);
      batch.status = 'cancelled';
    } else if (latestRun.status === 'returned') {
      await pool.query(`UPDATE urid_dhall_batches SET status='draft' WHERE id=$1`, [req.params.id]);
      batch.status = 'draft';
    }
  }
  batch.latestApprovalRun = latestRun || null;

  batch.inputs = (await pool.query(
    `SELECT di.*, pp.batch_no AS preprocessing_batch_no, b.batch_code AS good_material_batch_code
     FROM urid_dhall_inputs di
     JOIN urid_preprocessing_batches pp ON pp.id = di.preprocessing_batch_id
     JOIN batches b ON b.id = di.good_material_batch_id
     WHERE di.dhall_batch_id=$1`, [req.params.id]
  )).rows;
  batch.outputs = (await pool.query('SELECT * FROM urid_dhall_outputs WHERE dhall_batch_id=$1', [req.params.id])).rows;
  res.json(batch);
});

// body: { processingDate, machineLine, operatorId, supervisorId, shift, startTime, endTime,
//         inputs: [{ preprocessingBatchId, goodMaterialBatchId, quantityConsumed }],
//         whole: { quantity, bagCount, bagSize, storageLocation }, split: {...}, dust: {..., classification},
//         processLossQty, processLossReasonId, varianceReason, remarks }
router.post('/urid/dhall-batches', requireAnyRole('admin', 'operator', 'supervisor'), async (req, res) => {
  const b = req.body || {};
  if (!Array.isArray(b.inputs) || b.inputs.length === 0) return res.status(400).json({ error: 'At least one Stage 1 Good Material input is required.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock every referenced Good Material batch before checking balances —
    // same pattern as Sales Order PO allocation — so two concurrent Dhall
    // runs can never both succeed in over-consuming the same Stage 1 lot.
    const lockedBatches = {};
    const ppBatches = {};
    for (const inp of b.inputs) {
      if (!inp.quantityConsumed || Number(inp.quantityConsumed) <= 0) throw new Error('Every input needs a positive quantity.');
      const gm = (await client.query('SELECT * FROM batches WHERE id=$1 FOR UPDATE', [inp.goodMaterialBatchId])).rows[0];
      if (!gm) throw new Error(`Good Material batch ${inp.goodMaterialBatchId} not found.`);
      if (Number(inp.quantityConsumed) > Number(gm.remaining_qty) + 0.0001) {
        throw new Error(`Only ${gm.remaining_qty} kg remaining in ${gm.batch_code}, cannot consume ${inp.quantityConsumed}.`);
      }
      lockedBatches[inp.goodMaterialBatchId] = gm;
      const pp = (await client.query('SELECT * FROM urid_preprocessing_batches WHERE id=$1', [inp.preprocessingBatchId])).rows[0];
      if (!pp) throw new Error(`Pre-Processing batch ${inp.preprocessingBatchId} not found.`);
      if (pp.status !== 'approved') throw new Error(`Pre-Processing batch ${pp.batch_no} is "${pp.status}", not approved.`);
      ppBatches[inp.preprocessingBatchId] = pp;
    }

    const totalInputQty = b.inputs.reduce((s, i) => s + Number(i.quantityConsumed), 0);
    const wholeQty = Number(b.whole?.quantity || 0);
    const splitQty = Number(b.split?.quantity || 0);
    const dustQty = Number(b.dust?.quantity || 0);
    const otherQty = Number(b.otherByproductQty || 0);
    const lossQty = Number(b.processLossQty || 0);
    const totalAccounted = wholeQty + splitQty + dustQty + otherQty + lossQty;

    const tolerancePct = await getConfig('mass_balance_tolerance_pct', 0.10);
    const diffPct = totalInputQty > 0 ? ((totalInputQty - totalAccounted) / totalInputQty) * 100 : 0;
    const massBalanceOk = Math.abs(diffPct) <= tolerancePct;
    if (!massBalanceOk && !b.varianceReason) {
      throw new Error(`Mass balance variance of ${diffPct.toFixed(4)}% exceeds the +/-${tolerancePct}% tolerance. A variance reason is required.`);
    }

    // Yield against THIS batch's own input.
    const wholeYield = totalInputQty > 0 ? (wholeQty / totalInputQty) * 100 : 0;
    const splitYield = totalInputQty > 0 ? (splitQty / totalInputQty) * 100 : 0;
    const dustYield = totalInputQty > 0 ? (dustQty / totalInputQty) * 100 : 0;
    const lossYield = totalInputQty > 0 ? (lossQty / totalInputQty) * 100 : 0;

    // Yield against the ORIGINAL raw urid (Section 15) — trace each input's
    // Good Material back to how much raw urid it took to produce that
    // specific portion, at that Stage 1 batch's own yield rate.
    let equivalentRawInputQty = 0;
    for (const inp of b.inputs) {
      const pp = ppBatches[inp.preprocessingBatchId];
      const share = Number(pp.good_material_qty) > 0 ? Number(inp.quantityConsumed) / Number(pp.good_material_qty) : 0;
      equivalentRawInputQty += share * Number(pp.net_input_qty);
    }
    const overallWholeYield = equivalentRawInputQty > 0 ? (wholeQty / equivalentRawInputQty) * 100 : 0;
    const overallSplitYield = equivalentRawInputQty > 0 ? (splitQty / equivalentRawInputQty) * 100 : 0;
    const overallDustYield = equivalentRawInputQty > 0 ? (dustQty / equivalentRawInputQty) * 100 : 0;

    const batchNo = await nextBatchNo('DP', 'urid_dhall_batches');
    const insert = await client.query(
      `INSERT INTO urid_dhall_batches
        (batch_no, processing_date, machine_line, operator_id, supervisor_id, shift, start_time, end_time,
         total_input_qty, whole_dhall_qty, split_dhall_qty, dust_qty, other_byproduct_qty, process_loss_qty, process_loss_reason_id,
         mass_balance_diff_pct, mass_balance_ok, whole_yield_pct, split_yield_pct, dust_yield_pct, loss_pct,
         overall_yield_whole_pct, overall_yield_split_pct, overall_yield_dust_pct, equivalent_raw_input_qty,
         status, variance_reason, remarks, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,'draft',$26,$27,$28)
       RETURNING *`,
      [batchNo, b.processingDate, b.machineLine || null, b.operatorId || null, b.supervisorId || null, b.shift || null,
       b.startTime || null, b.endTime || null, totalInputQty, wholeQty, splitQty, dustQty, otherQty, lossQty,
       b.processLossReasonId || null, diffPct.toFixed(4), massBalanceOk, wholeYield.toFixed(4), splitYield.toFixed(4),
       dustYield.toFixed(4), lossYield.toFixed(4), overallWholeYield.toFixed(4), overallSplitYield.toFixed(4),
       overallDustYield.toFixed(4), equivalentRawInputQty.toFixed(3), b.varianceReason || null, b.remarks || null, req.session.userId]
    );
    const dhallBatch = insert.rows[0];

    for (const inp of b.inputs) {
      await client.query(
        'INSERT INTO urid_dhall_inputs (dhall_batch_id, preprocessing_batch_id, good_material_batch_id, quantity_consumed) VALUES ($1,$2,$3,$4)',
        [dhallBatch.id, inp.preprocessingBatchId, inp.goodMaterialBatchId, inp.quantityConsumed]
      );
      // Consumption happens now, at creation — matches how the rest of the
      // system treats physical material consumption (it already happened on
      // the factory floor; approval governs the paperwork, not the physics).
      const gm = lockedBatches[inp.goodMaterialBatchId];
      const newRemaining = Number(gm.remaining_qty) - Number(inp.quantityConsumed);
      await client.query('UPDATE batches SET remaining_qty=$1, status=$2 WHERE id=$3', [
        Math.max(newRemaining, 0), newRemaining <= 0.0001 ? 'consumed' : gm.status, gm.id,
      ]);
    }

    const outputDefs = [
      ['whole', wholeQty, wholeYield, b.whole],
      ['split', splitQty, splitYield, b.split],
      ['dust', dustQty, dustYield, b.dust],
    ];
    for (const [type, qty, yieldPct, detail] of outputDefs) {
      if (qty <= 0) continue;
      await client.query(
        `INSERT INTO urid_dhall_outputs (dhall_batch_id, output_type, quantity, yield_pct, bag_count, bag_size, storage_location, classification, remarks)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [dhallBatch.id, type, qty, yieldPct.toFixed(4), detail?.bagCount || null, detail?.bagSize || null,
         detail?.storageLocation || null, detail?.classification || null, detail?.remarks || null]
      );
    }

    await client.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1,$2,$3)', [
      req.session.userId, 'urid_dhall_created', JSON.stringify({ batchNo, totalInputQty, massBalanceOk }),
    ]);

    await client.query('COMMIT');
    res.json({ ...dhallBatch, massBalance: { diffPct, massBalanceOk } });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.post('/urid/dhall-batches/:id/submit', requireAnyRole('admin', 'operator', 'supervisor'), validateIdParams('id'), async (req, res) => {
  const batch = (await pool.query('SELECT * FROM urid_dhall_batches WHERE id=$1', [req.params.id])).rows[0];
  if (!batch) return res.status(404).json({ error: 'Batch not found.' });
  if (batch.status !== 'draft') return res.status(400).json({ error: `Batch is "${batch.status}", not draft -- cannot submit.` });

  const maxLossPct = await getConfig('max_stage2_loss_pct', 3);
  const context = {
    massBalanceExceeded: !batch.mass_balance_ok,
    wasteExceeded: Number(batch.loss_pct) > maxLossPct, // "loss" is Stage 2's equivalent of waste
    yieldBelowThreshold: false, // Stage 2 doesn't have a configured yield floor in the spec; reserved for future config
    quantityAdjusted: false,
    isReopened: false,
    batchNo: batch.batch_no,
  };

  try {
    const run = await startApprovalRun({ documentType: 'urid_dhall_processing', documentId: batch.id, context, createdBy: req.session.userId });
    await pool.query(`UPDATE urid_dhall_batches SET status='awaiting_review' WHERE id=$1`, [batch.id]);
    await pool.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1,$2,$3)', [
      req.session.userId, 'urid_dhall_submitted', JSON.stringify({ batchNo: batch.batch_no, context }),
    ]);
    res.json({ batch: { ...batch, status: 'awaiting_review' }, approvalRun: run });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/urid/dhall-batches/:id/hold', requireAnyRole('admin', 'supervisor', 'management'), validateIdParams('id'), async (req, res) => {
  const { reason } = req.body || {};
  const batch = (await pool.query('SELECT * FROM urid_dhall_batches WHERE id=$1', [req.params.id])).rows[0];
  if (!batch) return res.status(404).json({ error: 'Batch not found.' });
  if (['approved', 'cancelled'].includes(batch.status)) return res.status(400).json({ error: `Batch is "${batch.status}" -- cannot be put on hold.` });
  const { rows } = await pool.query(
    `UPDATE urid_dhall_batches SET status='on_hold', remarks=COALESCE(remarks,'') || $1 WHERE id=$2 RETURNING *`,
    [` | On hold: ${reason || ''}`, req.params.id]
  );
  res.json(rows[0]);
});
router.post('/urid/dhall-batches/:id/release-hold', requireAnyRole('admin', 'supervisor', 'management'), validateIdParams('id'), async (req, res) => {
  const batch = (await pool.query('SELECT * FROM urid_dhall_batches WHERE id=$1', [req.params.id])).rows[0];
  if (!batch) return res.status(404).json({ error: 'Batch not found.' });
  if (batch.status !== 'on_hold') return res.status(400).json({ error: 'Batch is not on hold.' });
  const { rows } = await pool.query(`UPDATE urid_dhall_batches SET status='draft' WHERE id=$1 RETURNING *`, [req.params.id]);
  res.json(rows[0]);
});

module.exports = router;
