const express = require('express');
const { pool } = require('../db');
const { requireLogin } = require('../middleware/auth');
const { requireAnyRole } = require('../utils/rbac');
const { validateIdParams } = require('../middleware/validateId');

const router = express.Router();

// Anyone logged in can view customers (Purchase, QC, Logistics etc. all
// legitimately need to look one up); only Export Sales/Management/Admin can
// create or edit them. This is the first screen to use the new multi-role
// system from Module 1 for an actual business permission, not just Admin.
const canManageCustomers = requireAnyRole('admin', 'export_sales', 'management');

async function logAction(userId, action, details) {
  await pool.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1,$2,$3)', [
    userId, action, details ? JSON.stringify(details) : null,
  ]);
}

// ---------- Customers ----------
router.get('/export/customers', requireLogin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.*, cur.code AS currency_code, pt.name AS payment_terms_name, it.code AS incoterm_code
     FROM export_customers c
     LEFT JOIN export_currencies cur ON cur.id = c.currency_id
     LEFT JOIN export_payment_terms pt ON pt.id = c.payment_terms_id
     LEFT JOIN export_incoterms it ON it.id = c.incoterm_pref_id
     WHERE c.active = true ORDER BY c.company_name`
  );
  res.json(rows);
});

router.get('/export/customers/:id', requireLogin, validateIdParams('id'), async (req, res) => {
  const customer = (await pool.query(
    `SELECT c.*, cur.code AS currency_code, pt.name AS payment_terms_name, it.code AS incoterm_code
     FROM export_customers c
     LEFT JOIN export_currencies cur ON cur.id = c.currency_id
     LEFT JOIN export_payment_terms pt ON pt.id = c.payment_terms_id
     LEFT JOIN export_incoterms it ON it.id = c.incoterm_pref_id
     WHERE c.id = $1`,
    [req.params.id]
  )).rows[0];
  if (!customer) return res.status(404).json({ error: 'Customer not found.' });

  customer.contacts = (await pool.query(
    'SELECT * FROM export_customer_contacts WHERE customer_id=$1 ORDER BY is_primary DESC, name', [req.params.id]
  )).rows;
  customer.addresses = (await pool.query(
    `SELECT a.*, c.name AS country_name, p.name AS port_name FROM export_customer_addresses a
     LEFT JOIN export_countries c ON c.id = a.country_id
     LEFT JOIN export_ports p ON p.id = a.port_of_discharge_id
     WHERE a.customer_id=$1 ORDER BY a.address_type`, [req.params.id]
  )).rows;
  res.json(customer);
});

router.post('/export/customers', canManageCustomers, async (req, res) => {
  const {
    code, companyName, category, currencyId, paymentTermsId, creditLimit,
    incotermPrefId, isPrivateLabel, taxRegNo, importLicenseNo, website,
  } = req.body || {};

  if (!code || !companyName) return res.status(400).json({ error: 'Customer code and company name are required.' });
  if (creditLimit !== undefined && Number(creditLimit) < 0) return res.status(400).json({ error: 'Credit limit cannot be negative.' });

  try {
    const { rows } = await pool.query(
      `INSERT INTO export_customers
        (code, company_name, category, currency_id, payment_terms_id, credit_limit, incoterm_pref_id, is_private_label, tax_reg_no, import_license_no, website, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [code.toUpperCase(), companyName, category || null, currencyId || null, paymentTermsId || null,
       creditLimit || 0, incotermPrefId || null, !!isPrivateLabel, taxRegNo || null, importLicenseNo || null,
       website || null, req.session.userId]
    );
    await logAction(req.session.userId, 'customer_created', { code: rows[0].code, companyName });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That customer code already exists.' });
    throw err;
  }
});

router.patch('/export/customers/:id', canManageCustomers, validateIdParams('id'), async (req, res) => {
  const allowed = ['company_name','category','currency_id','payment_terms_id','credit_limit','incoterm_pref_id',
    'is_private_label','tax_reg_no','import_license_no','website','active'];
  const fieldMap = {
    companyName: 'company_name', category: 'category', currencyId: 'currency_id', paymentTermsId: 'payment_terms_id',
    creditLimit: 'credit_limit', incotermPrefId: 'incoterm_pref_id', isPrivateLabel: 'is_private_label',
    taxRegNo: 'tax_reg_no', importLicenseNo: 'import_license_no', website: 'website', active: 'active',
  };
  const fields = [];
  const values = [];
  let i = 1;
  for (const [bodyKey, column] of Object.entries(fieldMap)) {
    if (req.body?.[bodyKey] !== undefined && allowed.includes(column)) {
      fields.push(`${column}=$${i++}`);
      values.push(req.body[bodyKey]);
    }
  }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });
  fields.push(`updated_by=$${i++}`); values.push(req.session.userId);
  fields.push(`updated_at=now()`);
  values.push(req.params.id);

  const { rows } = await pool.query(
    `UPDATE export_customers SET ${fields.join(', ')} WHERE id=$${i} RETURNING *`,
    values
  );
  await logAction(req.session.userId, 'customer_updated', { targetId: Number(req.params.id) });
  res.json(rows[0]);
});

// ---------- Contacts ----------
router.post('/export/customers/:id/contacts', canManageCustomers, validateIdParams('id'), async (req, res) => {
  const { name, designation, phone, email, isPrimary } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Contact name is required.' });
  const { rows } = await pool.query(
    'INSERT INTO export_customer_contacts (customer_id, name, designation, phone, email, is_primary) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [req.params.id, name, designation || null, phone || null, email || null, !!isPrimary]
  );
  await logAction(req.session.userId, 'customer_contact_added', { customerId: Number(req.params.id), name });
  res.json(rows[0]);
});

router.delete('/export/customers/:id/contacts/:contactId', canManageCustomers, validateIdParams('id', 'contactId'), async (req, res) => {
  await pool.query('DELETE FROM export_customer_contacts WHERE id=$1 AND customer_id=$2', [req.params.contactId, req.params.id]);
  res.json({ ok: true });
});

// ---------- Addresses ----------
router.post('/export/customers/:id/addresses', canManageCustomers, validateIdParams('id'), async (req, res) => {
  const { addressType, addressLine, city, state, countryId, postalCode, portOfDischargeId, freightForwarder, clearingAgent, isDefault } = req.body || {};
  if (!addressType || !addressLine) return res.status(400).json({ error: 'Address type and address line are required.' });
  if (!['billing','shipping','consignee','notify_party'].includes(addressType)) {
    return res.status(400).json({ error: 'Address type must be billing, shipping, consignee, or notify_party.' });
  }
  const { rows } = await pool.query(
    `INSERT INTO export_customer_addresses
      (customer_id, address_type, address_line, city, state, country_id, postal_code, port_of_discharge_id, freight_forwarder, clearing_agent, is_default)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [req.params.id, addressType, addressLine, city || null, state || null, countryId || null, postalCode || null,
     portOfDischargeId || null, freightForwarder || null, clearingAgent || null, !!isDefault]
  );
  await logAction(req.session.userId, 'customer_address_added', { customerId: Number(req.params.id), addressType });
  res.json(rows[0]);
});

router.delete('/export/customers/:id/addresses/:addressId', canManageCustomers, validateIdParams('id', 'addressId'), async (req, res) => {
  await pool.query('DELETE FROM export_customer_addresses WHERE id=$1 AND customer_id=$2', [req.params.addressId, req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
