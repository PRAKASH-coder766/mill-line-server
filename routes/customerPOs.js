const express = require('express');
const { pool } = require('../db');
const { requireLogin } = require('../middleware/auth');
const { requireAnyRole } = require('../utils/rbac');
const { startApprovalRun } = require('../utils/approvals');
const { addTimelineEvent } = require('../utils/timeline');
const { fireEvent } = require('../utils/notifications');
const { validateIdParams } = require('../middleware/validateId');

const router = express.Router();

const canManagePOs = requireAnyRole('admin', 'export_sales', 'management');

async function logAction(userId, action, details) {
  await pool.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1,$2,$3)', [
    userId, action, details ? JSON.stringify(details) : null,
  ]);
}

// ---------- List / detail ----------
router.get('/export/customer-pos', requireLogin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.*, c.company_name AS customer_name, q.quotation_no
     FROM export_customer_pos p
     JOIN export_customers c ON c.id = p.customer_id
     JOIN export_quotation_revisions r ON r.id = p.quotation_revision_id
     JOIN export_quotations q ON q.id = r.quotation_id
     ORDER BY p.created_at DESC`
  );
  res.json(rows);
});

router.get('/export/customer-pos/:id', requireLogin, validateIdParams('id'), async (req, res) => {
  const po = (await pool.query(
    `SELECT p.*, c.company_name AS customer_name, q.quotation_no, r.revision_no
     FROM export_customer_pos p
     JOIN export_customers c ON c.id = p.customer_id
     JOIN export_quotation_revisions r ON r.id = p.quotation_revision_id
     JOIN export_quotations q ON q.id = r.quotation_id
     WHERE p.id=$1`, [req.params.id]
  )).rows[0];
  if (!po) return res.status(404).json({ error: 'Customer PO not found.' });

  // Lazy-sync with the approval engine, same pattern as Quotations.
  const latestRun = (await pool.query(
    `SELECT * FROM approval_runs WHERE document_type='customer_po' AND document_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [req.params.id]
  )).rows[0];
  if (latestRun && po.status === 'differences_pending_approval') {
    if (latestRun.status === 'approved') {
      await pool.query(
        `UPDATE export_po_comparison SET resolved=true, resolved_by=$2, resolved_at=now() WHERE po_id=$1 AND requires_approval=true AND resolved=false`,
        [req.params.id, latestRun.created_by]
      );
      await pool.query(`UPDATE export_customer_pos SET status='confirmed' WHERE id=$1`, [req.params.id]);
      po.status = 'confirmed';
    } else if (['rejected', 'returned'].includes(latestRun.status)) {
      await pool.query(`UPDATE export_customer_pos SET status='uploaded' WHERE id=$1`, [req.params.id]);
      po.status = 'uploaded';
    }
  }
  po.latestApprovalRun = latestRun || null;

  po.items = (await pool.query(
    `SELECT i.*, v.sku_code, v.variant_name FROM export_customer_po_items i
     JOIN export_product_variants v ON v.id = i.variant_id WHERE i.po_id=$1`, [req.params.id]
  )).rows;
  po.comparison = (await pool.query('SELECT * FROM export_po_comparison WHERE po_id=$1 ORDER BY id', [req.params.id])).rows;
  res.json(po);
});

// ---------- Create ----------
router.post('/export/customer-pos', canManagePOs, async (req, res) => {
  const b = req.body || {};
  if (!b.poNo || !b.poDate || !b.customerId || !b.quotationRevisionId) {
    return res.status(400).json({ error: 'PO number, PO date, customer, and the quotation revision it responds to are required.' });
  }
  if (!Array.isArray(b.items) || !b.items.length) return res.status(400).json({ error: 'At least one line item is required.' });

  const revision = (await pool.query('SELECT * FROM export_quotation_revisions WHERE id=$1', [b.quotationRevisionId])).rows[0];
  if (!revision) return res.status(404).json({ error: 'Unknown quotation revision.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const po = (await client.query(
      `INSERT INTO export_customer_pos
        (po_no, po_date, customer_id, quotation_revision_id, currency_id, incoterm_id, payment_terms_id,
         requested_shipment_date, port_of_destination_id, shipping_instructions, special_packing_instructions,
         special_documentation_requirements, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [b.poNo, b.poDate, b.customerId, b.quotationRevisionId, b.currencyId || null, b.incotermId || null,
       b.paymentTermsId || null, b.requestedShipmentDate || null, b.portOfDestinationId || null,
       b.shippingInstructions || null, b.specialPackingInstructions || null, b.specialDocumentationRequirements || null,
       req.session.userId]
    )).rows[0];

    for (const item of b.items) {
      if (!item.variantId || !Number(item.quantity) || Number(item.price) < 0) {
        throw new Error('Every item needs a product variant, a positive quantity, and a non-negative price.');
      }
      const matchingRevItem = (await client.query(
        'SELECT id FROM export_quotation_revision_items WHERE revision_id=$1 AND variant_id=$2', [b.quotationRevisionId, item.variantId]
      )).rows[0];
      await client.query(
        `INSERT INTO export_customer_po_items (po_id, quotation_revision_item_id, variant_id, quantity, price, requested_shipment_date, special_instructions)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [po.id, matchingRevItem?.id || null, item.variantId, item.quantity, item.price, item.requestedShipmentDate || null, item.specialInstructions || null]
      );
    }

    await client.query('COMMIT');
    await logAction(req.session.userId, 'customer_po_uploaded', { poNo: b.poNo, customerId: b.customerId });
    await addTimelineEvent({ quotationId: revision.quotation_id, eventLabel: `Customer PO ${b.poNo} uploaded`, eventType: 'CUSTOMER_PO_UPLOADED', createdBy: req.session.userId });
    await fireEvent('CUSTOMER_PO_UPLOADED', { poNo: b.poNo });
    res.json(po);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ---------- Comparison engine ----------
router.post('/export/customer-pos/:id/compare', canManagePOs, validateIdParams('id'), async (req, res) => {
  const po = (await pool.query('SELECT * FROM export_customer_pos WHERE id=$1', [req.params.id])).rows[0];
  if (!po) return res.status(404).json({ error: 'Customer PO not found.' });

  const revision = (await pool.query('SELECT * FROM export_quotation_revisions WHERE id=$1', [po.quotation_revision_id])).rows[0];
  const revisionItems = (await pool.query('SELECT * FROM export_quotation_revision_items WHERE revision_id=$1', [po.quotation_revision_id])).rows;
  const poItems = (await pool.query('SELECT * FROM export_customer_po_items WHERE po_id=$1', [req.params.id])).rows;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM export_po_comparison WHERE po_id=$1', [req.params.id]); // re-runnable

    const rows = [];

    // ---- Header comparisons — only compare fields the PO actually captured ----
    if (po.currency_id) {
      rows.push({ field: 'currency', qv: revision.currency_id, pv: po.currency_id, diff: revision.currency_id !== po.currency_id });
    }
    if (po.incoterm_id) {
      rows.push({ field: 'incoterm', qv: revision.incoterm_id, pv: po.incoterm_id, diff: revision.incoterm_id !== po.incoterm_id });
    }
    if (po.payment_terms_id) {
      rows.push({ field: 'payment_terms', qv: revision.payment_terms_id, pv: po.payment_terms_id, diff: revision.payment_terms_id !== po.payment_terms_id });
    }
    if (po.requested_shipment_date && (revision.production_lead_time_days || revision.shipment_lead_time_days)) {
      const baseDate = new Date(revision.sent_to_customer_at || revision.created_at);
      const feasibleDate = new Date(baseDate);
      feasibleDate.setDate(feasibleDate.getDate() + (revision.production_lead_time_days || 0) + (revision.shipment_lead_time_days || 0));
      const requestedDate = new Date(po.requested_shipment_date);
      rows.push({
        field: 'requested_shipment_date', qv: feasibleDate.toISOString().slice(0, 10), pv: po.requested_shipment_date,
        diff: requestedDate < feasibleDate,
      });
    }
    if (po.port_of_destination_id && revision.port_of_destination_id) {
      rows.push({ field: 'destination_port', qv: revision.port_of_destination_id, pv: po.port_of_destination_id, diff: revision.port_of_destination_id !== po.port_of_destination_id });
    }

    // ---- Item comparisons ----
    for (const poItem of poItems) {
      const match = revisionItems.find(ri => ri.variant_id === poItem.variant_id);
      if (!match) {
        rows.push({ field: 'sku', poItemId: poItem.id, qv: 'not on quotation', pv: String(poItem.variant_id), diff: true });
        continue;
      }
      if (Number(match.quantity) !== Number(poItem.quantity)) {
        rows.push({ field: 'quantity', poItemId: poItem.id, qv: match.quantity, pv: poItem.quantity, diff: true });
      }
      if (Number(match.unit_price) !== Number(poItem.price)) {
        rows.push({ field: 'unit_price', poItemId: poItem.id, qv: match.unit_price, pv: poItem.price, diff: true });
      }
    }

    // Every field compared here is material per the approved conservative
    // policy — none of these ever resolve without a formal approval.
    for (const r of rows) {
      await client.query(
        `INSERT INTO export_po_comparison (po_id, po_item_id, field_name, quotation_value, po_value, is_difference, requires_approval)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [req.params.id, r.poItemId || null, r.field, String(r.qv ?? ''), String(r.pv ?? ''), r.diff, r.diff]
      );
    }

    const hasDifferences = rows.some(r => r.diff);
    if (hasDifferences) {
      await client.query(`UPDATE export_customer_pos SET status='differences_pending_approval' WHERE id=$1`, [req.params.id]);
    } else {
      await client.query(`UPDATE export_customer_pos SET status='confirmed' WHERE id=$1`, [req.params.id]);
    }
    await client.query('COMMIT');

    let approvalRun = null;
    if (hasDifferences) {
      try {
        approvalRun = await startApprovalRun({
          documentType: 'customer_po', documentId: Number(req.params.id),
          context: { poDifference: true }, createdBy: req.session.userId,
        });
      } catch (err) {
        // No workflow configured yet for customer_po — surface this clearly
        // rather than silently leaving the PO stuck with no path forward.
        return res.json({ differences: rows, hasDifferences, approvalRunError: err.message });
      }
    }

    await logAction(req.session.userId, 'customer_po_compared', { poId: Number(req.params.id), hasDifferences });
    if (hasDifferences) {
      await addTimelineEvent({ quotationId: revision.quotation_id, eventLabel: `PO ${po.po_no} has differences from the quotation`, eventType: 'PO_DIFFERENCE_DETECTED', isCustomerVisible: false, createdBy: req.session.userId });
      await fireEvent('PO_DIFFERENCE_DETECTED', { poNo: po.po_no });
    }
    res.json({ differences: rows, hasDifferences, approvalRun });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Manual resolution — only ever applicable to a requires_approval=false row,
// which none of Phase 1's defined comparison fields produce. Kept for when
// non-material fields are added later, per the addendum.
router.patch('/export/customer-pos/:id/comparison/:comparisonId/resolve', canManagePOs, validateIdParams('id', 'comparisonId'), async (req, res) => {
  const row = (await pool.query('SELECT * FROM export_po_comparison WHERE id=$1 AND po_id=$2', [req.params.comparisonId, req.params.id])).rows[0];
  if (!row) return res.status(404).json({ error: 'Comparison row not found.' });
  if (row.requires_approval) return res.status(400).json({ error: 'This difference is material and requires formal approval, not a manual resolution.' });

  const { rows } = await pool.query(
    `UPDATE export_po_comparison SET resolved=true, resolved_by=$1, resolved_at=now(), resolution_notes=$2 WHERE id=$3 RETURNING *`,
    [req.session.userId, req.body?.notes || null, req.params.comparisonId]
  );
  res.json(rows[0]);
});

module.exports = router;
