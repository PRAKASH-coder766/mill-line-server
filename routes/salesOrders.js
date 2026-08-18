const express = require('express');
const Decimal = require('decimal.js');
const { pool } = require('../db');
const { requireLogin } = require('../middleware/auth');
const { requireAnyRole } = require('../utils/rbac');
const { getNextDocumentNumber } = require('../utils/numbering');
const { startApprovalRun } = require('../utils/approvals');
const { addTimelineEvent } = require('../utils/timeline');
const { fireEvent } = require('../utils/notifications');
const { validateIdParams } = require('../middleware/validateId');

const router = express.Router();

const canManageSalesOrders = requireAnyRole('admin', 'export_sales', 'management');

async function logAction(userId, action, details) {
  await pool.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1,$2,$3)', [
    userId, action, details ? JSON.stringify(details) : null,
  ]);
}

// Read-only preview of a PO item's allocation balance — used by the UI while
// building a Sales Order, and re-derived (not trusted) at actual creation time.
async function getAllocationBalance(client, customerPoItemId) {
  const poItem = (await client.query('SELECT * FROM export_customer_po_items WHERE id=$1', [customerPoItemId])).rows[0];
  if (!poItem) return null;
  const allocated = (await client.query(
    `SELECT COALESCE(SUM(allocated_qty),0)::numeric AS total FROM export_sales_order_po_item_allocations
     WHERE customer_po_item_id=$1 AND status='active'`, [customerPoItemId]
  )).rows[0].total;
  return { poQty: Number(poItem.quantity), previouslyAllocated: Number(allocated), remainingBalance: Number(poItem.quantity) - Number(allocated) };
}

router.get('/export/customer-po-items/:itemId/allocation-balance', requireLogin, validateIdParams('itemId'), async (req, res) => {
  if (!Number.isInteger(Number(req.params.itemId))) return res.status(400).json({ error: 'Invalid PO item id.' });
  const balance = await getAllocationBalance(pool, req.params.itemId);
  if (!balance) return res.status(404).json({ error: 'PO item not found.' });
  res.json(balance);
});

// ---------- List / detail ----------
router.get('/export/sales-orders', requireLogin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.*, c.company_name AS customer_name FROM export_sales_orders s
     JOIN export_customers c ON c.id = s.customer_id ORDER BY s.created_at DESC`
  );
  res.json(rows);
});

router.get('/export/sales-orders/:id', requireLogin, validateIdParams('id'), async (req, res) => {
  if (!Number.isInteger(Number(req.params.id))) return res.status(400).json({ error: 'Invalid Sales Order id.' });
  const so = (await pool.query(
    `SELECT s.*, c.company_name AS customer_name FROM export_sales_orders s
     JOIN export_customers c ON c.id = s.customer_id WHERE s.id=$1`, [req.params.id]
  )).rows[0];
  if (!so) return res.status(404).json({ error: 'Sales Order not found.' });

  // Lazy-sync with the approval engine, same pattern as Quotations/Customer POs.
  const latestRun = (await pool.query(
    `SELECT * FROM approval_runs WHERE document_type='sales_order' AND document_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [req.params.id]
  )).rows[0];
  if (latestRun && so.status === 'pending_approval') {
    if (latestRun.status === 'approved') {
      await pool.query(`UPDATE export_sales_orders SET status='approved' WHERE id=$1`, [req.params.id]);
      await pool.query(`UPDATE export_sales_order_items SET status='locked' WHERE sales_order_id=$1`, [req.params.id]);
      so.status = 'approved';
      await addTimelineEvent({ salesOrderId: so.id, eventLabel: `${so.so_no} approved`, eventType: 'SALES_ORDER_APPROVED', createdBy: latestRun.created_by });
      await fireEvent('SALES_ORDER_APPROVED', { soNo: so.so_no });
    } else if (['rejected', 'returned'].includes(latestRun.status)) {
      await pool.query(`UPDATE export_sales_orders SET status='draft' WHERE id=$1`, [req.params.id]);
      so.status = 'draft';
      await addTimelineEvent({ salesOrderId: so.id, eventLabel: `${so.so_no} ${latestRun.status}`, eventType: 'SALES_ORDER_REJECTED', createdBy: latestRun.created_by });
      await fireEvent('SALES_ORDER_REJECTED', { soNo: so.so_no });
    }
  }
  so.latestApprovalRun = latestRun || null;

  so.items = (await pool.query(
    `SELECT i.*, v.sku_code, v.variant_name FROM export_sales_order_items i
     JOIN export_product_variants v ON v.id = i.variant_id WHERE i.sales_order_id=$1`, [req.params.id]
  )).rows;
  for (const item of so.items) {
    item.allocations = (await pool.query(
      `SELECT a.*, p.po_no FROM export_sales_order_po_item_allocations a
       JOIN export_customer_pos p ON p.id = a.customer_po_id
       WHERE a.sales_order_item_id=$1 AND a.status='active'`, [item.id]
    )).rows;
  }
  so.sourcePOs = (await pool.query(
    `SELECT p.* FROM export_sales_order_source_pos sp JOIN export_customer_pos p ON p.id = sp.customer_po_id WHERE sp.sales_order_id=$1`,
    [req.params.id]
  )).rows;
  so.creditSnapshot = (await pool.query(
    `SELECT * FROM export_customer_credit_snapshots WHERE sales_order_id=$1 ORDER BY snapshot_at DESC LIMIT 1`, [req.params.id]
  )).rows[0] || null;
  res.json(so);
});

// ---------- Create (the transactional allocation logic) ----------
router.post('/export/sales-orders', canManageSalesOrders, async (req, res) => {
  const b = req.body || {};
  if (!b.customerId) return res.status(400).json({ error: 'Customer is required.' });
  if (!Array.isArray(b.allocations) || !b.allocations.length) return res.status(400).json({ error: 'At least one PO-item allocation is required.' });
  for (const a of b.allocations) {
    if (!a.customerPoId || !a.customerPoItemId || !Number(a.allocatedQty) || Number(a.allocatedQty) <= 0) {
      return res.status(400).json({ error: 'Every allocation needs a source PO, a source PO item, and a positive allocated quantity.' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock every referenced PO item and verify remaining balance BEFORE any
    // writes — this is what makes concurrent SO creation against the same PO
    // safe (Addendum Section 6 / Owner-mandated allocation control).
    const lockedItems = [];
    for (const a of b.allocations) {
      const poItem = (await client.query(
        'SELECT * FROM export_customer_po_items WHERE id=$1 FOR UPDATE', [a.customerPoItemId]
      )).rows[0];
      if (!poItem) throw new Error(`PO item ${a.customerPoItemId} not found.`);

      const po = (await client.query('SELECT * FROM export_customer_pos WHERE id=$1', [poItem.po_id])).rows[0];
      // Sync with the approval engine here too — otherwise a PO that was just
      // approved but whose detail page nobody's opened yet would still show
      // its pre-approval status and wrongly block allocation.
      if (po.status === 'differences_pending_approval') {
        const latestRun = (await client.query(
          `SELECT * FROM approval_runs WHERE document_type='customer_po' AND document_id=$1 ORDER BY created_at DESC LIMIT 1`, [po.id]
        )).rows[0];
        if (latestRun?.status === 'approved') {
          await client.query(`UPDATE export_customer_pos SET status='confirmed' WHERE id=$1`, [po.id]);
          po.status = 'confirmed';
        }
      }
      if (po.status !== 'confirmed') throw new Error(`PO ${po.po_no} is "${po.status}", not confirmed — resolve any differences before allocating from it.`);

      const allocatedSoFar = (await client.query(
        `SELECT COALESCE(SUM(allocated_qty),0)::numeric AS total FROM export_sales_order_po_item_allocations
         WHERE customer_po_item_id=$1 AND status='active'`, [a.customerPoItemId]
      )).rows[0].total;
      const remaining = new Decimal(poItem.quantity).minus(allocatedSoFar);
      if (new Decimal(a.allocatedQty).gt(remaining)) {
        throw new Error(`PO ${po.po_no} line for this SKU has only ${remaining.toFixed(4)} remaining (of ${poItem.quantity}) — cannot allocate ${a.allocatedQty}.`);
      }
      lockedItems.push({ allocation: a, poItem, po });
    }

    // All balances confirmed under lock — safe to write now.
    const soNo = await getNextDocumentNumber('sales_order');

    // Commercial party snapshot: derive the source quotation revision from
    // the first locked PO item rather than requiring the caller to pass it
    // separately (every PO here already links back to a specific revision).
    let snapshot = {};
    const firstPoItemPoId = lockedItems[0]?.po?.quotation_revision_id;
    const revisionIdForSnapshot = b.quotationRevisionId || firstPoItemPoId;
    if (revisionIdForSnapshot) {
      const rev = (await client.query('SELECT * FROM export_quotation_revisions WHERE id=$1', [revisionIdForSnapshot])).rows[0];
      if (rev) {
        snapshot = {
          snapshot_customer_name: rev.snapshot_customer_name, snapshot_billing_address: rev.snapshot_billing_address,
          snapshot_consignee_address: rev.snapshot_consignee_address, snapshot_notify_party_address: rev.snapshot_notify_party_address,
          snapshot_country: rev.snapshot_country, snapshot_tax_reg_no: rev.snapshot_tax_reg_no,
          snapshot_contact_name: rev.snapshot_contact_name, snapshot_contact_email: rev.snapshot_contact_email,
        };
      }
    }

    const so = (await client.query(
      `INSERT INTO export_sales_orders
        (so_no, customer_id, currency_id, incoterm_id, payment_terms_id, etd_planned, eta_planned,
         snapshot_customer_name, snapshot_billing_address, snapshot_consignee_address, snapshot_notify_party_address,
         snapshot_country, snapshot_tax_reg_no, snapshot_contact_name, snapshot_contact_email, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [soNo, b.customerId, b.currencyId || null, b.incotermId || null, b.paymentTermsId || null, b.etdPlanned || null, b.etaPlanned || null,
       snapshot.snapshot_customer_name || null, snapshot.snapshot_billing_address || null, snapshot.snapshot_consignee_address || null,
       snapshot.snapshot_notify_party_address || null, snapshot.snapshot_country || null, snapshot.snapshot_tax_reg_no || null,
       snapshot.snapshot_contact_name || null, snapshot.snapshot_contact_email || null, req.session.userId]
    )).rows[0];

    let totalValue = new Decimal(0);
    const sourcePoIds = new Set();
    for (const { allocation, poItem } of lockedItems) {
      const variant = (await client.query(
        `SELECT v.*, p.classification FROM export_product_variants v JOIN products p ON p.id = v.product_id WHERE v.id=$1`,
        [poItem.variant_id]
      )).rows[0];

      const soItem = (await client.query(
        `INSERT INTO export_sales_order_items (sales_order_id, customer_po_item_id, variant_id, ordered_qty, unit_price, requires_manufacturing)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [so.id, poItem.id, poItem.variant_id, allocation.allocatedQty, poItem.price, variant.classification === 'manufactured']
      )).rows[0];

      await client.query(
        `INSERT INTO export_sales_order_po_item_allocations (sales_order_id, sales_order_item_id, customer_po_id, customer_po_item_id, allocated_qty)
         VALUES ($1,$2,$3,$4,$5)`,
        [so.id, soItem.id, allocation.customerPoId, allocation.customerPoItemId, allocation.allocatedQty]
      );

      totalValue = totalValue.plus(new Decimal(poItem.price).times(allocation.allocatedQty));
      sourcePoIds.add(allocation.customerPoId);
    }

    for (const poId of sourcePoIds) {
      await client.query(
        'INSERT INTO export_sales_order_source_pos (sales_order_id, customer_po_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [so.id, poId]
      );
    }

    await client.query(`UPDATE export_sales_orders SET total_value=$1 WHERE id=$2`, [totalValue.toFixed(4), so.id]);

    // ---- Credit exposure check ----
    const openOrders = (await client.query(
      `SELECT COALESCE(SUM(total_value),0)::numeric AS total FROM export_sales_orders
       WHERE customer_id=$1 AND id != $2 AND status NOT IN ('closed','cancelled')`,
      [b.customerId, so.id]
    )).rows[0].total;
    const customer = (await client.query('SELECT * FROM export_customers WHERE id=$1', [b.customerId])).rows[0];
    const outstandingAmount = new Decimal(0); // Payment/invoicing module not built yet (later phase) — treated as 0 for now.
    const projectedExposure = outstandingAmount.plus(openOrders).plus(totalValue);
    const exceeded = projectedExposure.gt(customer.credit_limit);

    await client.query(
      `INSERT INTO export_customer_credit_snapshots (customer_id, sales_order_id, outstanding_amount, open_orders_value, new_order_value, projected_exposure, credit_limit, exceeded)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [b.customerId, so.id, outstandingAmount.toFixed(4), openOrders, totalValue.toFixed(4), projectedExposure.toFixed(4), customer.credit_limit, exceeded]
    );

    await client.query('COMMIT');
    await logAction(req.session.userId, 'sales_order_created', { soNo, customerId: b.customerId, totalValue: totalValue.toFixed(4), creditExceeded: exceeded });
    await addTimelineEvent({ salesOrderId: so.id, eventLabel: `${soNo} created`, eventType: 'SALES_ORDER_CREATED', createdBy: req.session.userId });
    if (exceeded) await fireEvent('CREDIT_LIMIT_EXCEEDED', { soNo });
    res.json({ ...so, total_value: totalValue.toFixed(4) });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ---------- Submit for approval ----------
router.post('/export/sales-orders/:id/submit-for-approval', canManageSalesOrders, validateIdParams('id'), async (req, res) => {
  if (!Number.isInteger(Number(req.params.id))) return res.status(400).json({ error: 'Invalid Sales Order id.' });
  const so = (await pool.query('SELECT * FROM export_sales_orders WHERE id=$1', [req.params.id])).rows[0];
  if (!so) return res.status(404).json({ error: 'Sales Order not found.' });
  if (so.status !== 'draft') return res.status(400).json({ error: `Sales Order is "${so.status}", not draft — cannot submit.` });

  const creditSnapshot = (await pool.query(
    `SELECT * FROM export_customer_credit_snapshots WHERE sales_order_id=$1 ORDER BY snapshot_at DESC LIMIT 1`, [req.params.id]
  )).rows[0];

  const context = {
    orderValue: Number(so.total_value),
    creditExceeded: !!creditSnapshot?.exceeded,
  };

  try {
    const run = await startApprovalRun({ documentType: 'sales_order', documentId: so.id, context, createdBy: req.session.userId });
    await pool.query(`UPDATE export_sales_orders SET status='pending_approval' WHERE id=$1`, [req.params.id]);
    await logAction(req.session.userId, 'sales_order_submitted_for_approval', { soNo: so.so_no, context });
    await addTimelineEvent({ salesOrderId: so.id, eventLabel: `${so.so_no} submitted for approval`, eventType: 'SALES_ORDER_SUBMITTED_FOR_APPROVAL', isCustomerVisible: false, createdBy: req.session.userId });
    await fireEvent('SALES_ORDER_SUBMITTED_FOR_APPROVAL', { soNo: so.so_no });
    res.json({ salesOrder: { ...so, status: 'pending_approval' }, approvalRun: run });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/export/sales-orders/:id/cancel', canManageSalesOrders, validateIdParams('id'), async (req, res) => {
  if (!Number.isInteger(Number(req.params.id))) return res.status(400).json({ error: 'Invalid Sales Order id.' });
  const { reason } = req.body || {};
  if (!reason) return res.status(400).json({ error: 'A cancellation reason is required.' });
  const { rows } = await pool.query(
    `UPDATE export_sales_orders SET status='cancelled', cancelled_by=$1, cancelled_at=now(), cancellation_reason=$2 WHERE id=$3 RETURNING *`,
    [req.session.userId, reason, req.params.id]
  );
  await logAction(req.session.userId, 'sales_order_cancelled', { soId: Number(req.params.id), reason });
  res.json(rows[0]);
});

module.exports = router;
