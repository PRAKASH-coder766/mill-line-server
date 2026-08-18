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
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ${table} WHERE batch_no LIKE $1`, [`${prefix}-${dateStr}-%`]
  );
  return `${prefix}-${dateStr}-${String(rows[0].n + 1).padStart(3, '0')}`;
}

router.get('/urid/config', requireLogin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM urid_config');
  res.json(rows);
});
router.patch('/urid/config/:key', requireAnyRole('admin', 'management'), async (req, res) => {
  const { value } = req.body || {};
  const { rows } = await pool.query('UPDATE urid_config SET value=$1 WHERE key=$2 RETURNING *', [value, req.params.key]);
  res.json(rows[0]);
});

router.get('/urid/output-categories', requireLogin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM urid_output_categories WHERE active=true ORDER BY sort_order');
  res.json(rows);
});
router.post('/urid/output-categories', requireAnyRole('admin'), async (req, res) => {
  const { name, isRecoverable } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  const { rows } = await pool.query(
    'INSERT INTO urid_output_categories (name, is_recoverable, sort_order) VALUES ($1,$2,(SELECT COALESCE(MAX(sort_order),0)+1 FROM urid_output_categories)) RETURNING *',
    [name, !!isRecoverable]
  );
  res.json(rows[0]);
});

// ---------- List ----------
router.get('/urid/preprocessing-batches', requireLogin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT pp.*, s.name AS supplier_name, u1.name AS operator_name, u2.name AS supervisor_name
     FROM urid_preprocessing_batches pp
     LEFT JOIN suppliers s ON s.id = pp.supplier_id
     LEFT JOIN users u1 ON u1.id = pp.operator_id
     LEFT JOIN users u2 ON u2.id = pp.supervisor_id
     ORDER BY pp.created_at DESC`
  );
  res.json(rows);
});

// Applies the same "mint the real Good Material batch" logic whether it's
// triggered by the (legacy, Phase 1) direct decision or by the approval
// engine reaching Approved (Phase 2). Idempotent — checks status first.
async function applyPreprocessingApproval(batchId, approvedBy) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const batch = (await client.query('SELECT * FROM urid_preprocessing_batches WHERE id=$1 FOR UPDATE', [batchId])).rows[0];
    if (!batch || batch.status !== 'awaiting_review') { await client.query('ROLLBACK'); return; }

    const goodMatProduct = (await client.query(`SELECT * FROM products WHERE code='URID-GOODMAT'`)).rows[0];
    const gmInsert = await client.query(
      `INSERT INTO batches (batch_code, product_id, stage, quantity, remaining_qty, unit, status, origin_type, created_by)
       VALUES ('PENDING',$1,'raw_material',$2,$2,'kg','pending_qc','processing',$3) RETURNING id`,
      [goodMatProduct.id, batch.good_material_qty, approvedBy]
    );
    const gmId = gmInsert.rows[0].id;
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const gmCode = `KAF-URIDGM-${dateStr}-${String(gmId).padStart(6, '0')}`;
    const goodMaterialBatch = (await client.query('UPDATE batches SET batch_code=$1 WHERE id=$2 RETURNING *', [gmCode, gmId])).rows[0];

    if (batch.raw_material_batch_id) {
      await client.query(
        'INSERT INTO batch_lineage (parent_batch_id, child_batch_id, quantity_used) VALUES ($1,$2,$3)',
        [batch.raw_material_batch_id, goodMaterialBatch.id, batch.net_input_qty]
      );
    }

    const stockOutputs = (await client.query(
      `SELECT o.*, c.name AS category_name FROM urid_preprocessing_outputs o
       JOIN urid_output_categories c ON c.id = o.category_id
       WHERE o.preprocessing_id=$1 AND o.disposition='transfer_to_stock'`, [batch.id]
    )).rows;
    for (const out of stockOutputs) {
      const productCode = out.category_name.includes('Split') ? 'URID-SPLIT' : out.category_name.includes('Dust') ? 'URID-DUST' : null;
      if (!productCode) continue;
      const product = (await client.query('SELECT * FROM products WHERE code=$1', [productCode])).rows[0];
      if (!product) continue;
      const outInsert = await client.query(
        `INSERT INTO batches (batch_code, product_id, stage, quantity, remaining_qty, unit, status, origin_type, created_by)
         VALUES ('PENDING',$1,'finished_good',$2,$2,'kg','pending_qc','processing',$3) RETURNING id`,
        [product.id, out.quantity, approvedBy]
      );
      const outId = outInsert.rows[0].id;
      const outCode = `KAF-${productCode}-${dateStr}-${String(outId).padStart(6, '0')}`;
      const stockBatch = (await client.query('UPDATE batches SET batch_code=$1 WHERE id=$2 RETURNING *', [outCode, outId])).rows[0];
      await client.query('UPDATE urid_preprocessing_outputs SET stock_batch_id=$1 WHERE id=$2', [stockBatch.id, out.id]);
      if (batch.raw_material_batch_id) {
        await client.query('INSERT INTO batch_lineage (parent_batch_id, child_batch_id, quantity_used) VALUES ($1,$2,$3)', [batch.raw_material_batch_id, stockBatch.id, out.quantity]);
      }
    }

    await client.query(
      `UPDATE urid_preprocessing_batches SET status='approved', good_material_batch_id=$1 WHERE id=$2`,
      [goodMaterialBatch.id, batch.id]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

router.get('/urid/preprocessing-batches/:id', requireLogin, validateIdParams('id'), async (req, res) => {
  const batch = (await pool.query(
    `SELECT pp.*, s.name AS supplier_name, u1.name AS operator_name, u2.name AS supervisor_name
     FROM urid_preprocessing_batches pp
     LEFT JOIN suppliers s ON s.id = pp.supplier_id
     LEFT JOIN users u1 ON u1.id = pp.operator_id
     LEFT JOIN users u2 ON u2.id = pp.supervisor_id
     WHERE pp.id=$1`, [req.params.id]
  )).rows[0];
  if (!batch) return res.status(404).json({ error: 'Batch not found.' });

  // Lazy-sync with the approval engine, same pattern used across the export
  // modules: if the latest run reached a terminal state and our status
  // hasn't caught up, update it now.
  const latestRun = (await pool.query(
    `SELECT * FROM approval_runs WHERE document_type='urid_preprocessing' AND document_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [req.params.id]
  )).rows[0];
  if (latestRun && batch.status === 'awaiting_review') {
    if (latestRun.status === 'approved') {
      await applyPreprocessingApproval(batch.id, latestRun.created_by);
      const refreshed = (await pool.query('SELECT * FROM urid_preprocessing_batches WHERE id=$1', [req.params.id])).rows[0];
      Object.assign(batch, refreshed);
    } else if (latestRun.status === 'rejected') {
      await pool.query(`UPDATE urid_preprocessing_batches SET status='cancelled' WHERE id=$1`, [req.params.id]);
      batch.status = 'cancelled';
    } else if (latestRun.status === 'returned') {
      await pool.query(`UPDATE urid_preprocessing_batches SET status='draft' WHERE id=$1`, [req.params.id]);
      batch.status = 'draft';
    }
  }
  batch.latestApprovalRun = latestRun || null;

  batch.outputs = (await pool.query(
    `SELECT o.*, c.name AS category_name, c.is_recoverable AS category_is_recoverable
     FROM urid_preprocessing_outputs o JOIN urid_output_categories c ON c.id = o.category_id
     WHERE o.preprocessing_id=$1`, [req.params.id]
  )).rows;
  res.json(batch);
});

// Computes the mass balance for a given input + outputs + weighed good
// material, without persisting anything.
function computeMassBalance(netInputQty, outputs, categoriesById, weighedGoodMaterialQty, tolerancePct) {
  let nonRecoverableSum = 0;
  let recoverableKeptSum = 0;
  for (const o of outputs) {
    const cat = categoriesById[o.categoryId];
    if (!cat) continue;
    if (!cat.is_recoverable) {
      nonRecoverableSum += Number(o.quantity);
    } else if (o.disposition !== 'transfer_to_dhall') {
      recoverableKeptSum += Number(o.quantity);
    }
  }
  const expectedGoodMaterial = netInputQty - nonRecoverableSum - recoverableKeptSum;
  const diff = Number(weighedGoodMaterialQty) - expectedGoodMaterial;
  const diffPct = netInputQty > 0 ? (diff / netInputQty) * 100 : 0;
  const massBalanceOk = Math.abs(diffPct) <= tolerancePct;
  return { expectedGoodMaterial, diff, diffPct, massBalanceOk, nonRecoverableSum, recoverableKeptSum };
}

router.post('/urid/preprocessing-batches', requireAnyRole('admin', 'operator', 'supervisor'), async (req, res) => {
  const b = req.body || {};
  if (!b.netInputQty || Number(b.netInputQty) <= 0) return res.status(400).json({ error: 'Net raw urid input must be a positive quantity.' });
  if (!Array.isArray(b.outputs)) return res.status(400).json({ error: 'outputs must be an array (can be empty).' });
  if (b.goodMaterialQty === undefined || Number(b.goodMaterialQty) < 0) return res.status(400).json({ error: 'Weighed good material quantity is required.' });

  const categories = (await pool.query('SELECT * FROM urid_output_categories')).rows;
  const categoriesById = Object.fromEntries(categories.map(c => [c.id, c]));
  for (const o of b.outputs) {
    if (!categoriesById[o.categoryId]) return res.status(400).json({ error: `Unknown output category ${o.categoryId}.` });
    if (Number(o.quantity) < 0) return res.status(400).json({ error: 'Output quantities cannot be negative.' });
    if (categoriesById[o.categoryId].is_recoverable && o.quantity > 0 && !o.disposition) {
      return res.status(400).json({ error: `"${categoriesById[o.categoryId].name}" is recoverable — a disposition (transfer to stock/Dhall/reprocess/hold/reject) is required.` });
    }
  }

  const tolerancePct = await getConfig('mass_balance_tolerance_pct', 0.10);
  const mb = computeMassBalance(Number(b.netInputQty), b.outputs, categoriesById, Number(b.goodMaterialQty), tolerancePct);

  if (!mb.massBalanceOk && !b.varianceReason) {
    return res.status(400).json({
      error: `Mass balance variance of ${mb.diffPct.toFixed(4)}% exceeds the +/-${tolerancePct}% tolerance. A variance reason is required, and this batch will need Management approval.`,
      massBalance: mb,
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const batchNo = await nextBatchNo('PP', 'urid_preprocessing_batches');

    const insert = await client.query(
      `INSERT INTO urid_preprocessing_batches
        (batch_no, processing_date, supplier_id, supplier_lot_no, po_reference, grn_reference, raw_material_batch_id,
         warehouse_location, machine_line, operator_id, supervisor_id, shift, start_time, end_time,
         gross_quantity, bag_count, standard_bag_weight, actual_bag_weight, net_input_qty,
         good_material_qty, mass_balance_diff_pct, mass_balance_ok, status, variance_reason, remarks, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,'draft',$23,$24,$25) RETURNING *`,
      [batchNo, b.processingDate, b.supplierId || null, b.supplierLotNo || null, b.poReference || null, b.grnReference || null,
       b.rawMaterialBatchId || null, b.warehouseLocation || null, b.machineLine || null, b.operatorId || null, b.supervisorId || null,
       b.shift || null, b.startTime || null, b.endTime || null, b.grossQuantity || null, b.bagCount || null,
       b.standardBagWeight || null, b.actualBagWeight || null, b.netInputQty, b.goodMaterialQty,
       mb.diffPct.toFixed(4), mb.massBalanceOk, b.varianceReason || null, b.remarks || null, req.session.userId]
    );
    const batch = insert.rows[0];

    for (const o of b.outputs) {
      if (Number(o.quantity) <= 0) continue;
      const cat = categoriesById[o.categoryId];
      const pct = (Number(o.quantity) / Number(b.netInputQty)) * 100;
      await client.query(
        `INSERT INTO urid_preprocessing_outputs (preprocessing_id, category_id, quantity, percentage, is_recoverable, disposition, is_stockable, remarks)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [batch.id, o.categoryId, o.quantity, pct.toFixed(4), cat.is_recoverable, o.disposition || null,
         o.disposition === 'transfer_to_stock', o.remarks || null]
      );
    }

    await client.query(
      'INSERT INTO audit_log (user_id, action, details) VALUES ($1,$2,$3)',
      [req.session.userId, 'urid_preprocessing_created', JSON.stringify({ batchNo, massBalance: mb })]
    );

    await client.query('COMMIT');
    res.json({ ...batch, massBalance: mb });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Submitting now starts a real approval run, with escalation context computed
// per the spec: mass balance variance, waste threshold, yield threshold.
router.post('/urid/preprocessing-batches/:id/submit', requireAnyRole('admin', 'operator', 'supervisor'), validateIdParams('id'), async (req, res) => {
  const batch = (await pool.query('SELECT * FROM urid_preprocessing_batches WHERE id=$1', [req.params.id])).rows[0];
  if (!batch) return res.status(404).json({ error: 'Batch not found.' });
  if (batch.status !== 'draft') return res.status(400).json({ error: `Batch is "${batch.status}", not draft -- cannot submit.` });

  const outputs = (await pool.query(
    `SELECT o.*, c.name AS category_name FROM urid_preprocessing_outputs o
     JOIN urid_output_categories c ON c.id = o.category_id WHERE o.preprocessing_id=$1`, [batch.id]
  )).rows;
  const wasteOutput = outputs.find(o => o.category_name === 'Waste');
  const wastePct = wasteOutput ? Number(wasteOutput.percentage) : 0;
  const maxWastePct = await getConfig('max_waste_pct', 5);
  const yieldPct = Number(batch.net_input_qty) > 0 ? (Number(batch.good_material_qty) / Number(batch.net_input_qty)) * 100 : 0;
  const minYieldPct = await getConfig('min_preprocessing_yield_pct', 90);

  const context = {
    massBalanceExceeded: !batch.mass_balance_ok,
    wasteExceeded: wastePct > maxWastePct,
    yieldBelowThreshold: yieldPct < minYieldPct,
    quantityAdjusted: false, // set true by the (future) reopen/amendment flow
    isReopened: false,
    batchNo: batch.batch_no,
  };

  try {
    const run = await startApprovalRun({ documentType: 'urid_preprocessing', documentId: batch.id, context, createdBy: req.session.userId });
    await pool.query(`UPDATE urid_preprocessing_batches SET status='awaiting_review' WHERE id=$1`, [batch.id]);
    await pool.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1,$2,$3)', [
      req.session.userId, 'urid_preprocessing_submitted', JSON.stringify({ batchNo: batch.batch_no, context }),
    ]);
    res.json({ batch: { ...batch, status: 'awaiting_review' }, approvalRun: run });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Hold is an operational pause, not an approval decision — decoupled from
// the approval engine so a supervisor can freeze a batch at any point, not
// just while it's awaiting review.
router.post('/urid/preprocessing-batches/:id/hold', requireAnyRole('admin', 'supervisor', 'management'), validateIdParams('id'), async (req, res) => {
  const { reason } = req.body || {};
  const batch = (await pool.query('SELECT * FROM urid_preprocessing_batches WHERE id=$1', [req.params.id])).rows[0];
  if (!batch) return res.status(404).json({ error: 'Batch not found.' });
  if (['approved', 'transferred_to_dhall', 'cancelled'].includes(batch.status)) {
    return res.status(400).json({ error: `Batch is "${batch.status}" -- cannot be put on hold.` });
  }
  const { rows } = await pool.query(
    `UPDATE urid_preprocessing_batches SET status='on_hold', remarks=COALESCE(remarks,'') || $1 WHERE id=$2 RETURNING *`,
    [` | On hold: ${reason || ''}`, req.params.id]
  );
  await pool.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1,$2,$3)', [
    req.session.userId, 'urid_preprocessing_held', JSON.stringify({ batchNo: batch.batch_no, reason }),
  ]);
  res.json(rows[0]);
});

router.post('/urid/preprocessing-batches/:id/release-hold', requireAnyRole('admin', 'supervisor', 'management'), validateIdParams('id'), async (req, res) => {
  const batch = (await pool.query('SELECT * FROM urid_preprocessing_batches WHERE id=$1', [req.params.id])).rows[0];
  if (!batch) return res.status(404).json({ error: 'Batch not found.' });
  if (batch.status !== 'on_hold') return res.status(400).json({ error: 'Batch is not on hold.' });
  const { rows } = await pool.query(`UPDATE urid_preprocessing_batches SET status='draft' WHERE id=$1 RETURNING *`, [req.params.id]);
  res.json(rows[0]);
});

module.exports = router;
