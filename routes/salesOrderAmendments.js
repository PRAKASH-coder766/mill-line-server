const express = require('express');
const { pool } = require('../db');
const { requireLogin } = require('../middleware/auth');
const { requireAnyRole } = require('../utils/rbac');
const { startApprovalRun } = require('../utils/approvals');
const { addTimelineEvent } = require('../utils/timeline');
const { fireEvent } = require('../utils/notifications');
const { validateIdParams } = require('../middleware/validateId');

const router = express.Router();

const canManageAmendments = requireAnyRole('admin', 'export_sales', 'management');

async function logAction(userId, action, details) {
  await pool.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1,$2,$3)', [
    userId, action, details ? JSON.stringify(details) : null,
  ]);
}

// Whitelisted, explicitly-typed fields only — never interpolate an arbitrary
// column name from client input into SQL.
const HEADER_FIELDS = {
  currencyId: 'currency_id', incotermId: 'incoterm_id', paymentTermsId: 'payment_terms_id',
  etdPlanned: 'etd_planned', etaPlanned: 'eta_planned',
};
const ITEM_FIELDS = { unitPrice: 'unit_price', orderedQty: 'ordered_qty' };
// Owner Decision 3: these are the "material/commercial" fields that force
// Management approval; ETD/ETA and similar are "operational" and route
// through whatever the configured operational workflow step requires.
const COMMERCIAL_COLUMNS = new Set(['currency_id', 'incoterm_id', 'payment_terms_id', 'unit_price', 'ordered_qty']);

router.get('/export/sales-orders/:id/amendments', requireLogin, validateIdParams('id'), async (req, res) => {
  const amendments = (await pool.query(
    'SELECT * FROM export_sales_order_amendments WHERE sales_order_id=$1 ORDER BY amendment_no', [req.params.id]
  )).rows;
  for (const a of amendments) {
    a.items = (await pool.query('SELECT * FROM export_sales_order_amendment_items WHERE amendment_id=$1', [a.id])).rows;
  }
  res.json(amendments);
});

router.get('/export/sales-orders/:id/amendments/:amendmentId', requireLogin, validateIdParams('id', 'amendmentId'), async (req, res) => {
  const amendment = (await pool.query(
    'SELECT * FROM export_sales_order_amendments WHERE id=$1 AND sales_order_id=$2', [req.params.amendmentId, req.params.id]
  )).rows[0];
  if (!amendment) return res.status(404).json({ error: 'Amendment not found.' });

  const latestRun = (await pool.query(
    `SELECT * FROM approval_runs WHERE document_type='sales_order_amendment' AND document_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [amendment.id]
  )).rows[0];

  if (latestRun && amendment.status === 'pending') {
    if (latestRun.status === 'approved') {
      await applyAmendment(amendment.id, latestRun.created_by);
      amendment.status = 'approved';
      amendment.approved_by = latestRun.created_by;
      amendment.approved_at = new Date();
    } else if (['rejected', 'returned'].includes(latestRun.status)) {
      const lastAction = (await pool.query(
        `SELECT * FROM approval_actions WHERE approval_run_id=$1 ORDER BY decided_at DESC LIMIT 1`, [latestRun.id]
      )).rows[0];
      await pool.query(
        `UPDATE export_sales_order_amendments SET status='rejected', rejected_by=$1, rejected_at=now(), decision_comment=$2 WHERE id=$3`,
        [lastAction?.approver_id || null, lastAction?.comment || null, amendment.id]
      );
      amendment.status = 'rejected';
    }
  }
  amendment.latestApprovalRun = latestRun || null;
  amendment.items = (await pool.query('SELECT * FROM export_sales_order_amendment_items WHERE amendment_id=$1', [req.params.amendmentId])).rows;
  res.json(amendment);
});

// body: { reason, items: [{ entityLevel: 'header'|'item', salesOrderItemId?, fieldName, newValue }] }
router.post('/export/sales-orders/:id/amendments', canManageAmendments, validateIdParams('id'), async (req, res) => {
  const { reason, items } = req.body || {};
  if (!reason) return res.status(400).json({ error: 'A reason is required for the amendment.' });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'At least one field change is required.' });

  const so = (await pool.query('SELECT * FROM export_sales_orders WHERE id=$1', [req.params.id])).rows[0];
  if (!so) return res.status(404).json({ error: 'Sales Order not found.' });
  if (['cancelled', 'closed'].includes(so.status)) return res.status(400).json({ error: `Sales Order is ${so.status} — cannot amend.` });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const nextNo = (await client.query(
      'SELECT COALESCE(MAX(amendment_no),0)::int + 1 AS n FROM export_sales_order_amendments WHERE sales_order_id=$1', [req.params.id]
    )).rows[0].n;

    const amendment = (await client.query(
      `INSERT INTO export_sales_order_amendments (sales_order_id, amendment_no, reason, requested_by) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, nextNo, reason, req.session.userId]
    )).rows[0];

    let hasCommercialChange = false;
    const insertedItems = [];
    for (const item of items) {
      if (item.entityLevel === 'header') {
        const column = HEADER_FIELDS[item.fieldName];
        if (!column) throw new Error(`"${item.fieldName}" is not an amendable header field.`);
        const oldValue = so[column];
        if (COMMERCIAL_COLUMNS.has(column)) hasCommercialChange = true;
        const row = (await client.query(
          `INSERT INTO export_sales_order_amendment_items (amendment_id, entity_level, field_name, old_value, new_value)
           VALUES ($1,'header',$2,$3,$4) RETURNING *`,
          [amendment.id, column, oldValue, item.newValue]
        )).rows[0];
        insertedItems.push(row);
      } else if (item.entityLevel === 'item') {
        if (!item.salesOrderItemId) throw new Error('An item-level change needs salesOrderItemId.');
        const column = ITEM_FIELDS[item.fieldName];
        if (!column) throw new Error(`"${item.fieldName}" is not an amendable item field.`);
        const soItem = (await client.query('SELECT * FROM export_sales_order_items WHERE id=$1 AND sales_order_id=$2', [item.salesOrderItemId, req.params.id])).rows[0];
        if (!soItem) throw new Error(`Sales Order item ${item.salesOrderItemId} not found on this order.`);
        const oldValue = soItem[column];
        if (COMMERCIAL_COLUMNS.has(column)) hasCommercialChange = true;
        const row = (await client.query(
          `INSERT INTO export_sales_order_amendment_items (amendment_id, sales_order_item_id, entity_level, field_name, old_value, new_value)
           VALUES ($1,$2,'item',$3,$4,$5) RETURNING *`,
          [amendment.id, item.salesOrderItemId, column, oldValue, item.newValue]
        )).rows[0];
        insertedItems.push(row);
      } else {
        throw new Error('entityLevel must be "header" or "item".');
      }
    }

    await client.query('COMMIT');

    const run = await startApprovalRun({
      documentType: 'sales_order_amendment', documentId: amendment.id,
      context: { hasCommercialChange, soNo: so.so_no }, createdBy: req.session.userId,
    });

    await logAction(req.session.userId, 'sales_order_amendment_submitted', { soNo: so.so_no, amendmentNo: nextNo, hasCommercialChange });
    await addTimelineEvent({ salesOrderId: so.id, eventLabel: `${so.so_no}/A${String(nextNo).padStart(2,'0')} proposed (${hasCommercialChange?'commercial':'operational'})`, eventType: 'AMENDMENT_REQUESTED', isCustomerVisible: false, createdBy: req.session.userId });
    await fireEvent('AMENDMENT_REQUESTED', { soNo: so.so_no, amendmentNo: nextNo });
    res.json({ ...amendment, items: insertedItems, approvalRun: run });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Applies every item in one amendment atomically — called only once, from
// the lazy-sync check above, the moment the approval run reaches Approved.
// Also writes one export_audit_log row per field changed — the clearest,
// most honest use of that field-level audit table in Phase 1: every value
// here already carries an explicit old/new pair, nothing inferred.
async function applyAmendment(amendmentId, approvedBy) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const amendment = (await client.query('SELECT * FROM export_sales_order_amendments WHERE id=$1 FOR UPDATE', [amendmentId])).rows[0];
    if (!amendment || amendment.status !== 'pending') { await client.query('ROLLBACK'); return; } // already applied — don't double-apply

    const items = (await client.query('SELECT * FROM export_sales_order_amendment_items WHERE amendment_id=$1', [amendmentId])).rows;
    for (const item of items) {
      if (item.entity_level === 'header') {
        await client.query(`UPDATE export_sales_orders SET ${item.field_name}=$1, updated_at=now() WHERE id=$2`, [item.new_value, amendment.sales_order_id]);
        await client.query(
          `INSERT INTO export_audit_log (table_name, row_id, user_id, action, field_name, old_value, new_value) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          ['export_sales_orders', amendment.sales_order_id, approvedBy, 'amendment_applied', item.field_name, item.old_value, item.new_value]
        );
      } else {
        await client.query(`UPDATE export_sales_order_items SET ${item.field_name}=$1 WHERE id=$2`, [item.new_value, item.sales_order_item_id]);
        await client.query(
          `INSERT INTO export_audit_log (table_name, row_id, user_id, action, field_name, old_value, new_value) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          ['export_sales_order_items', item.sales_order_item_id, approvedBy, 'amendment_applied', item.field_name, item.old_value, item.new_value]
        );
      }
    }
    await client.query(
      `UPDATE export_sales_order_amendments SET status='approved', approved_by=$1, approved_at=now() WHERE id=$2`,
      [approvedBy, amendmentId]
    );
    await client.query('COMMIT');

    const so = (await pool.query('SELECT so_no FROM export_sales_orders WHERE id=$1', [amendment.sales_order_id])).rows[0];
    await addTimelineEvent({ salesOrderId: amendment.sales_order_id, eventLabel: `${so?.so_no||''}/A${String(amendment.amendment_no).padStart(2,'0')} approved and applied`, eventType: 'AMENDMENT_APPROVED', createdBy: approvedBy });
    await fireEvent('AMENDMENT_APPROVED', { soNo: so?.so_no, amendmentNo: amendment.amendment_no });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = router;
