const express = require('express');
const Decimal = require('decimal.js');
const { pool } = require('../db');
const { requireLogin } = require('../middleware/auth');
const { requireAnyRole } = require('../utils/rbac');
const { getNextDocumentNumber } = require('../utils/numbering');
const { resolvePricingControls } = require('../utils/pricing');
const { startApprovalRun } = require('../utils/approvals');
const { addTimelineEvent } = require('../utils/timeline');
const { fireEvent } = require('../utils/notifications');
const { validateIdParams } = require('../middleware/validateId');

const router = express.Router();

const canManageQuotations = requireAnyRole('admin', 'export_sales', 'management');

async function logAction(userId, action, details) {
  await pool.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1,$2,$3)', [
    userId, action, details ? JSON.stringify(details) : null,
  ]);
}

// Computes per-item margin (decimal-safe) and returns the values ready to
// insert, plus the pieces needed to build the approval-engine context.
function computeItemFinancials(item) {
  const qty = new Decimal(item.quantity || 0);
  const price = new Decimal(item.unitPrice || 0);
  const costFields = ['productCost', 'packingCost', 'freightAllocation', 'insuranceAllocation', 'chaDocCost', 'commission', 'otherCost'];
  const totalCostPerUnit = costFields.reduce((sum, f) => sum.plus(new Decimal(item[f] || 0)), new Decimal(0));
  const marginPerUnit = price.minus(totalCostPerUnit);
  const marginAmount = marginPerUnit.times(qty);
  const marginPct = price.gt(0) ? marginPerUnit.div(price).times(100) : new Decimal(0);
  return {
    expectedMarginAmount: marginAmount.toFixed(4),
    expectedMarginPct: marginPct.toFixed(4),
    lineTotal: price.times(qty),
    marginPctNum: marginPct.toNumber(),
  };
}

async function insertRevisionItem(client, revisionId, item) {
  const fin = computeItemFinancials(item);
  const { rows } = await client.query(
    `INSERT INTO export_quotation_revision_items
      (revision_id, variant_id, quantity, unit_price, cartons, net_weight_kg, gross_weight_kg, cbm,
       fob_price, freight, insurance, cif_price, product_cost, packing_cost, freight_allocation,
       insurance_allocation, cha_doc_cost, commission, other_cost, expected_margin_amount, expected_margin_pct)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
    [revisionId, item.variantId, item.quantity, item.unitPrice, item.cartons || null, item.netWeightKg || null,
     item.grossWeightKg || null, item.cbm || null, item.fobPrice || null, item.freight || null, item.insurance || null,
     item.cifPrice || null, item.productCost || null, item.packingCost || null, item.freightAllocation || null,
     item.insuranceAllocation || null, item.chaDocCost || null, item.commission || null, item.otherCost || null,
     fin.expectedMarginAmount, fin.expectedMarginPct]
  );
  return { row: rows[0], lineTotal: fin.lineTotal, marginPctNum: fin.marginPctNum };
}

async function snapshotCustomer(client, customerId) {
  const customer = (await client.query('SELECT * FROM export_customers WHERE id=$1', [customerId])).rows[0];
  if (!customer) throw new Error('Unknown customer.');
  const billing = (await client.query(
    `SELECT * FROM export_customer_addresses WHERE customer_id=$1 AND address_type='billing' ORDER BY is_default DESC LIMIT 1`, [customerId]
  )).rows[0];
  const consignee = (await client.query(
    `SELECT * FROM export_customer_addresses WHERE customer_id=$1 AND address_type='consignee' ORDER BY is_default DESC LIMIT 1`, [customerId]
  )).rows[0];
  const notify = (await client.query(
    `SELECT * FROM export_customer_addresses WHERE customer_id=$1 AND address_type='notify_party' ORDER BY is_default DESC LIMIT 1`, [customerId]
  )).rows[0];
  const primaryContact = (await client.query(
    `SELECT * FROM export_customer_contacts WHERE customer_id=$1 ORDER BY is_primary DESC LIMIT 1`, [customerId]
  )).rows[0];
  const country = billing?.country_id ? (await client.query('SELECT name FROM export_countries WHERE id=$1', [billing.country_id])).rows[0]?.name : null;

  return {
    snapshotCustomerName: customer.company_name,
    snapshotBillingAddress: billing?.address_line || null,
    snapshotConsigneeAddress: consignee?.address_line || null,
    snapshotNotifyPartyAddress: notify?.address_line || null,
    snapshotCountry: country,
    snapshotTaxRegNo: customer.tax_reg_no,
    snapshotContactName: primaryContact?.name || null,
    snapshotContactEmail: primaryContact?.email || null,
  };
}

// ---------- List / detail ----------
router.get('/export/quotations', requireLogin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT q.*, c.company_name AS customer_name FROM export_quotations q
     JOIN export_customers c ON c.id = q.customer_id ORDER BY q.created_at DESC`
  );
  res.json(rows);
});

router.get('/export/quotations/:id', requireLogin, validateIdParams('id'), async (req, res) => {
  const quotation = (await pool.query(
    `SELECT q.*, c.company_name AS customer_name FROM export_quotations q
     JOIN export_customers c ON c.id = q.customer_id WHERE q.id=$1`, [req.params.id]
  )).rows[0];
  if (!quotation) return res.status(404).json({ error: 'Quotation not found.' });

  // Lazy-sync with the approval engine: if the latest run for this quotation
  // reached a terminal state and our status hasn't caught up yet, update it.
  const latestRun = (await pool.query(
    `SELECT * FROM approval_runs WHERE document_type='quotation' AND document_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [req.params.id]
  )).rows[0];
  if (latestRun && quotation.status === 'pending_approval') {
    if (latestRun.status === 'approved') {
      await pool.query(`UPDATE export_quotations SET status='approved' WHERE id=$1`, [req.params.id]);
      quotation.status = 'approved';
      await addTimelineEvent({ quotationId: quotation.id, eventLabel: `${quotation.quotation_no} approved`, eventType: 'QUOTATION_APPROVED', createdBy: latestRun.created_by });
      await fireEvent('QUOTATION_APPROVED', { quotationNo: quotation.quotation_no });
    } else if (['rejected', 'returned'].includes(latestRun.status)) {
      await pool.query(`UPDATE export_quotations SET status='draft' WHERE id=$1`, [req.params.id]);
      quotation.status = 'draft';
      await addTimelineEvent({ quotationId: quotation.id, eventLabel: `${quotation.quotation_no} ${latestRun.status}`, eventType: 'QUOTATION_REJECTED', createdBy: latestRun.created_by });
      await fireEvent('QUOTATION_REJECTED', { quotationNo: quotation.quotation_no });
    }
  }
  quotation.latestApprovalRun = latestRun || null;

  const revisions = (await pool.query(
    `SELECT * FROM export_quotation_revisions WHERE quotation_id=$1 ORDER BY revision_no`, [req.params.id]
  )).rows;
  for (const rev of revisions) {
    rev.items = (await pool.query(
      `SELECT ri.*, v.sku_code, v.variant_name FROM export_quotation_revision_items ri
       JOIN export_product_variants v ON v.id = ri.variant_id WHERE ri.revision_id=$1`, [rev.id]
    )).rows;
  }
  quotation.revisions = revisions;
  res.json(quotation);
});

// ---------- Create (quotation header + revision 0 + items) ----------
router.post('/export/quotations', canManageQuotations, async (req, res) => {
  const b = req.body || {};
  if (!b.customerId) return res.status(400).json({ error: 'Customer is required.' });
  if (!Array.isArray(b.items) || !b.items.length) return res.status(400).json({ error: 'At least one line item is required.' });
  for (const item of b.items) {
    if (!item.variantId || !Number(item.quantity) || Number(item.quantity) <= 0 || Number(item.unitPrice) < 0) {
      return res.status(400).json({ error: 'Every item needs a product variant, a positive quantity, and a non-negative unit price.' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const quotationNo = await getNextDocumentNumber('quotation');
    const quotation = (await client.query(
      'INSERT INTO export_quotations (quotation_no, customer_id, created_by) VALUES ($1,$2,$3) RETURNING *',
      [quotationNo, b.customerId, req.session.userId]
    )).rows[0];

    const snapshot = await snapshotCustomer(client, b.customerId);
    const revision = (await client.query(
      `INSERT INTO export_quotation_revisions
        (quotation_id, revision_no, currency_id, incoterm_id, payment_terms_id, port_of_loading_id, port_of_destination_id,
         validity_date, production_lead_time_days, shipment_lead_time_days, special_conditions, remarks,
         snapshot_customer_name, snapshot_billing_address, snapshot_consignee_address, snapshot_notify_party_address,
         snapshot_country, snapshot_tax_reg_no, snapshot_contact_name, snapshot_contact_email, created_by)
       VALUES ($1,0,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
      [quotation.id, b.currencyId || null, b.incotermId || null, b.paymentTermsId || null, b.portOfLoadingId || null,
       b.portOfDestinationId || null, b.validityDate || null, b.productionLeadTimeDays || null, b.shipmentLeadTimeDays || null,
       b.specialConditions || null, b.remarks || null, snapshot.snapshotCustomerName, snapshot.snapshotBillingAddress,
       snapshot.snapshotConsigneeAddress, snapshot.snapshotNotifyPartyAddress, snapshot.snapshotCountry,
       snapshot.snapshotTaxRegNo, snapshot.snapshotContactName, snapshot.snapshotContactEmail, req.session.userId]
    )).rows[0];

    const items = [];
    for (const item of b.items) items.push(await insertRevisionItem(client, revision.id, item));

    await client.query('COMMIT');
    await logAction(req.session.userId, 'quotation_created', { quotationNo, customerId: b.customerId });
    await addTimelineEvent({ quotationId: quotation.id, eventLabel: `${quotationNo} created`, eventType: 'QUOTATION_CREATED', createdBy: req.session.userId });
    res.json({ ...quotation, revision, items: items.map(i => i.row) });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ---------- Edit current revision (only while mutable — trigger blocks otherwise) ----------
router.patch('/export/quotations/:id/current-revision', canManageQuotations, validateIdParams('id'), async (req, res) => {
  const quotation = (await pool.query('SELECT * FROM export_quotations WHERE id=$1', [req.params.id])).rows[0];
  if (!quotation) return res.status(404).json({ error: 'Quotation not found.' });
  const revision = (await pool.query(
    'SELECT * FROM export_quotation_revisions WHERE quotation_id=$1 AND revision_no=$2', [req.params.id, quotation.current_revision_no]
  )).rows[0];

  const fieldMap = {
    currencyId: 'currency_id', incotermId: 'incoterm_id', paymentTermsId: 'payment_terms_id',
    portOfLoadingId: 'port_of_loading_id', portOfDestinationId: 'port_of_destination_id', validityDate: 'validity_date',
    productionLeadTimeDays: 'production_lead_time_days', shipmentLeadTimeDays: 'shipment_lead_time_days',
    specialConditions: 'special_conditions', remarks: 'remarks',
  };
  const fields = []; const values = []; let i = 1;
  for (const [bodyKey, column] of Object.entries(fieldMap)) {
    if (req.body?.[bodyKey] !== undefined) { fields.push(`${column}=$${i++}`); values.push(req.body[bodyKey]); }
  }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });
  values.push(revision.id);

  try {
    const { rows } = await pool.query(`UPDATE export_quotation_revisions SET ${fields.join(', ')} WHERE id=$${i} RETURNING *`, values);
    res.json(rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message.includes('immutable') ? err.message : 'Could not update revision.' });
  }
});

router.post('/export/quotations/:id/items', canManageQuotations, validateIdParams('id'), async (req, res) => {
  const quotation = (await pool.query('SELECT * FROM export_quotations WHERE id=$1', [req.params.id])).rows[0];
  if (!quotation) return res.status(404).json({ error: 'Quotation not found.' });
  const revision = (await pool.query(
    'SELECT * FROM export_quotation_revisions WHERE quotation_id=$1 AND revision_no=$2', [req.params.id, quotation.current_revision_no]
  )).rows[0];
  try {
    const result = await insertRevisionItem(pool, revision.id, req.body || {});
    res.json(result.row);
  } catch (err) {
    res.status(400).json({ error: err.message.includes('immutable') ? err.message : 'Could not add item.' });
  }
});

router.delete('/export/quotations/:id/items/:itemId', canManageQuotations, validateIdParams('id', 'itemId'), async (req, res) => {
  try {
    await pool.query('DELETE FROM export_quotation_revision_items WHERE id=$1', [req.params.itemId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message.includes('immutable') ? err.message : 'Could not remove item.' });
  }
});

// ---------- Approval submission ----------
router.post('/export/quotations/:id/submit-for-approval', canManageQuotations, validateIdParams('id'), async (req, res) => {
  const quotation = (await pool.query('SELECT * FROM export_quotations WHERE id=$1', [req.params.id])).rows[0];
  if (!quotation) return res.status(404).json({ error: 'Quotation not found.' });
  if (quotation.status !== 'draft') return res.status(400).json({ error: `Quotation is "${quotation.status}", not draft — cannot submit.` });

  const revision = (await pool.query(
    'SELECT * FROM export_quotation_revisions WHERE quotation_id=$1 AND revision_no=$2', [req.params.id, quotation.current_revision_no]
  )).rows[0];
  const items = (await pool.query('SELECT * FROM export_quotation_revision_items WHERE revision_id=$1', [revision.id])).rows;

  let orderValue = new Decimal(0);
  let weightedMarginNumerator = new Decimal(0);
  let priceBelowMinimum = false;
  for (const item of items) {
    const lineTotal = new Decimal(item.unit_price).times(item.quantity);
    orderValue = orderValue.plus(lineTotal);
    weightedMarginNumerator = weightedMarginNumerator.plus(new Decimal(item.expected_margin_pct || 0).times(lineTotal));

    const floor = await resolvePricingControls(item.variant_id, quotation.customer_id);
    if (floor.minSellingPrice !== null && Number(item.unit_price) < floor.minSellingPrice) priceBelowMinimum = true;
    if (floor.minMarginPct !== null && Number(item.expected_margin_pct) < floor.minMarginPct) priceBelowMinimum = true;
  }
  const marginPct = orderValue.gt(0) ? weightedMarginNumerator.div(orderValue).toNumber() : 0;

  const priorCount = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM export_quotations WHERE customer_id=$1 AND id != $2`, [quotation.customer_id, quotation.id]
  )).rows[0].n;

  const context = {
    orderValue: orderValue.toNumber(), marginPct, priceBelowMinimum,
    isNewCustomer: priorCount === 0,
  };

  try {
    const run = await startApprovalRun({ documentType: 'quotation', documentId: quotation.id, context, createdBy: req.session.userId });
    await pool.query(`UPDATE export_quotations SET status='pending_approval' WHERE id=$1`, [quotation.id]);
    await logAction(req.session.userId, 'quotation_submitted_for_approval', { quotationNo: quotation.quotation_no, context });
    await addTimelineEvent({ quotationId: quotation.id, eventLabel: `${quotation.quotation_no} submitted for approval`, eventType: 'QUOTATION_SUBMITTED_FOR_APPROVAL', isCustomerVisible: false, createdBy: req.session.userId });
    await fireEvent('QUOTATION_SUBMITTED_FOR_APPROVAL', { quotationNo: quotation.quotation_no });
    res.json({ quotation: { ...quotation, status: 'pending_approval' }, approvalRun: run });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Send to customer ----------
router.post('/export/quotations/:id/send-to-customer', canManageQuotations, validateIdParams('id'), async (req, res) => {
  const quotation = (await pool.query('SELECT * FROM export_quotations WHERE id=$1', [req.params.id])).rows[0];
  if (!quotation) return res.status(404).json({ error: 'Quotation not found.' });
  if (quotation.status !== 'approved') return res.status(400).json({ error: 'Quotation must be Approved before it can be sent to the customer.' });

  await pool.query(
    `UPDATE export_quotation_revisions SET is_immutable=true, sent_to_customer_at=now()
     WHERE quotation_id=$1 AND revision_no=$2`,
    [req.params.id, quotation.current_revision_no]
  );
  const { rows } = await pool.query(`UPDATE export_quotations SET status='sent_to_customer' WHERE id=$1 RETURNING *`, [req.params.id]);
  await logAction(req.session.userId, 'quotation_sent_to_customer', { quotationNo: quotation.quotation_no });
  await addTimelineEvent({ quotationId: quotation.id, eventLabel: `${quotation.quotation_no} sent to customer`, eventType: 'QUOTATION_SENT_TO_CUSTOMER', createdBy: req.session.userId });
  await fireEvent('QUOTATION_SENT_TO_CUSTOMER', { quotationNo: quotation.quotation_no });
  res.json(rows[0]);
});

// ---------- Customer response (recorded by staff until the portal exists) ----------
router.patch('/export/quotations/:id/customer-response', canManageQuotations, validateIdParams('id'), async (req, res) => {
  const { response } = req.body || {};
  const map = { accepted: 'customer_accepted', rejected: 'customer_rejected', revision_requested: 'revision_requested' };
  if (!map[response]) return res.status(400).json({ error: 'Response must be accepted, rejected, or revision_requested.' });

  const { rows } = await pool.query(`UPDATE export_quotations SET status=$1 WHERE id=$2 RETURNING *`, [map[response], req.params.id]);
  await logAction(req.session.userId, 'quotation_customer_response', { quotationId: Number(req.params.id), response });
  res.json(rows[0]);
});

// ---------- Revise (new immutable-safe revision, copies items forward) ----------
router.post('/export/quotations/:id/revise', canManageQuotations, validateIdParams('id'), async (req, res) => {
  const quotation = (await pool.query('SELECT * FROM export_quotations WHERE id=$1', [req.params.id])).rows[0];
  if (!quotation) return res.status(404).json({ error: 'Quotation not found.' });

  const currentRevision = (await pool.query(
    'SELECT * FROM export_quotation_revisions WHERE quotation_id=$1 AND revision_no=$2', [req.params.id, quotation.current_revision_no]
  )).rows[0];
  if (!currentRevision.is_immutable) {
    return res.status(400).json({ error: 'The current revision has not been sent yet — edit it directly instead of creating a new revision.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const newRevisionNo = quotation.current_revision_no + 1;
    const newRevision = (await client.query(
      `INSERT INTO export_quotation_revisions
        (quotation_id, revision_no, currency_id, incoterm_id, payment_terms_id, port_of_loading_id, port_of_destination_id,
         validity_date, production_lead_time_days, shipment_lead_time_days, special_conditions, remarks,
         snapshot_customer_name, snapshot_billing_address, snapshot_consignee_address, snapshot_notify_party_address,
         snapshot_country, snapshot_tax_reg_no, snapshot_contact_name, snapshot_contact_email, created_by)
       SELECT quotation_id, $2, currency_id, incoterm_id, payment_terms_id, port_of_loading_id, port_of_destination_id,
         validity_date, production_lead_time_days, shipment_lead_time_days, special_conditions, remarks,
         snapshot_customer_name, snapshot_billing_address, snapshot_consignee_address, snapshot_notify_party_address,
         snapshot_country, snapshot_tax_reg_no, snapshot_contact_name, snapshot_contact_email, $3
       FROM export_quotation_revisions WHERE id=$1 RETURNING *`,
      [currentRevision.id, newRevisionNo, req.session.userId]
    )).rows[0];

    const oldItems = (await client.query('SELECT * FROM export_quotation_revision_items WHERE revision_id=$1', [currentRevision.id])).rows;
    for (const oldItem of oldItems) {
      await client.query(
        `INSERT INTO export_quotation_revision_items
          (revision_id, variant_id, quantity, unit_price, cartons, net_weight_kg, gross_weight_kg, cbm,
           fob_price, freight, insurance, cif_price, product_cost, packing_cost, freight_allocation,
           insurance_allocation, cha_doc_cost, commission, other_cost, expected_margin_amount, expected_margin_pct)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
        [newRevision.id, oldItem.variant_id, oldItem.quantity, oldItem.unit_price, oldItem.cartons, oldItem.net_weight_kg,
         oldItem.gross_weight_kg, oldItem.cbm, oldItem.fob_price, oldItem.freight, oldItem.insurance, oldItem.cif_price,
         oldItem.product_cost, oldItem.packing_cost, oldItem.freight_allocation, oldItem.insurance_allocation,
         oldItem.cha_doc_cost, oldItem.commission, oldItem.other_cost, oldItem.expected_margin_amount, oldItem.expected_margin_pct]
      );
    }

    await client.query(`UPDATE export_quotations SET current_revision_no=$1, status='draft' WHERE id=$2`, [newRevisionNo, req.params.id]);
    await client.query('COMMIT');
    await logAction(req.session.userId, 'quotation_revised', { quotationNo: quotation.quotation_no, newRevisionNo });
    res.json(newRevision);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
