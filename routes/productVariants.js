const express = require('express');
const { pool } = require('../db');
const { requireLogin } = require('../middleware/auth');
const { requireAnyRole } = require('../utils/rbac');
const { validateIdParams } = require('../middleware/validateId');

const router = express.Router();

// Setting up SKUs/packaging is catalog-type work, similar in spirit to
// Customer Master — Export Sales and Management can do it, not just Admin.
const canManageVariants = requireAnyRole('admin', 'export_sales', 'management');

async function logAction(userId, action, details) {
  await pool.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1,$2,$3)', [
    userId, action, details ? JSON.stringify(details) : null,
  ]);
}

router.get('/export/product-variants', requireLogin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT v.*, p.name AS product_name, p.code AS product_code, p.classification,
            cur.code AS price_currency_code, c.company_name AS customer_name
     FROM export_product_variants v
     JOIN products p ON p.id = v.product_id
     LEFT JOIN export_currencies cur ON cur.id = v.price_currency_id
     LEFT JOIN export_customers c ON c.id = v.customer_id
     WHERE v.status != 'discontinued'
     ORDER BY p.name, v.variant_name`
  );
  res.json(rows);
});

router.get('/export/product-variants/:id', requireLogin, validateIdParams('id'), async (req, res) => {
  const variant = (await pool.query(
    `SELECT v.*, p.name AS product_name, p.code AS product_code, p.classification
     FROM export_product_variants v JOIN products p ON p.id = v.product_id
     WHERE v.id = $1`,
    [req.params.id]
  )).rows[0];
  if (!variant) return res.status(404).json({ error: 'Variant not found.' });

  variant.hsCodes = (await pool.query(
    `SELECT h.*, c.name AS country_name FROM export_variant_hs_codes h
     JOIN export_countries c ON c.id = h.country_id WHERE h.variant_id=$1`,
    [req.params.id]
  )).rows;
  variant.packaging = (await pool.query(
    'SELECT * FROM export_product_packaging WHERE variant_id=$1 AND active=true', [req.params.id]
  )).rows;
  variant.customerConfigs = (await pool.query(
    `SELECT cfg.*, c.company_name AS customer_name FROM export_customer_product_configs cfg
     JOIN export_customers c ON c.id = cfg.customer_id WHERE cfg.variant_id=$1 AND cfg.active=true`,
    [req.params.id]
  )).rows;
  res.json(variant);
});

router.post('/export/product-variants', canManageVariants, async (req, res) => {
  const { productId, skuCode, variantName, brand, isPrivateLabel, customerId, unitOfMeasure, standardExportPrice, priceCurrencyId, shelfLifeDays, moq } = req.body || {};
  if (!productId || !skuCode || !variantName) {
    return res.status(400).json({ error: 'Product, SKU code, and variant name are required.' });
  }
  const product = (await pool.query('SELECT * FROM products WHERE id=$1', [productId])).rows[0];
  if (!product) return res.status(404).json({ error: 'Unknown base product.' });

  try {
    const { rows } = await pool.query(
      `INSERT INTO export_product_variants
        (product_id, sku_code, variant_name, brand, is_private_label, customer_id, unit_of_measure, standard_export_price, price_currency_id, shelf_life_days, moq, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [productId, skuCode.toUpperCase(), variantName, brand || null, !!isPrivateLabel, customerId || null,
       unitOfMeasure || 'kg', standardExportPrice || null, priceCurrencyId || null, shelfLifeDays || null, moq || null, req.session.userId]
    );
    await logAction(req.session.userId, 'product_variant_created', { skuCode: rows[0].sku_code, variantName });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That SKU code already exists.' });
    throw err;
  }
});

router.patch('/export/product-variants/:id', canManageVariants, validateIdParams('id'), async (req, res) => {
  const fieldMap = {
    variantName: 'variant_name', brand: 'brand', isPrivateLabel: 'is_private_label', customerId: 'customer_id',
    unitOfMeasure: 'unit_of_measure', standardExportPrice: 'standard_export_price', priceCurrencyId: 'price_currency_id',
    shelfLifeDays: 'shelf_life_days', moq: 'moq', status: 'status',
  };
  const fields = [];
  const values = [];
  let i = 1;
  for (const [bodyKey, column] of Object.entries(fieldMap)) {
    if (req.body?.[bodyKey] !== undefined) { fields.push(`${column}=$${i++}`); values.push(req.body[bodyKey]); }
  }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });
  fields.push(`updated_by=$${i++}`); values.push(req.session.userId);
  fields.push(`updated_at=now()`);
  values.push(req.params.id);
  const { rows } = await pool.query(`UPDATE export_product_variants SET ${fields.join(', ')} WHERE id=$${i} RETURNING *`, values);
  res.json(rows[0]);
});

// ---------- HS codes (per country) ----------
router.post('/export/product-variants/:id/hs-codes', canManageVariants, validateIdParams('id'), async (req, res) => {
  const { countryId, hsCode } = req.body || {};
  if (!countryId || !hsCode) return res.status(400).json({ error: 'Country and HS code are required.' });
  const { rows } = await pool.query(
    `INSERT INTO export_variant_hs_codes (variant_id, country_id, hs_code) VALUES ($1,$2,$3)
     ON CONFLICT (variant_id, country_id) DO UPDATE SET hs_code=$3 RETURNING *`,
    [req.params.id, countryId, hsCode]
  );
  res.json(rows[0]);
});

// ---------- Packaging configuration ----------
router.post('/export/product-variants/:id/packaging', canManageVariants, validateIdParams('id'), async (req, res) => {
  const { packSize, innerPackQty, outerCartonQty, netWeightKg, grossWeightKg, cartonLengthCm, cartonWidthCm, cartonHeightCm, barcode } = req.body || {};
  let cbm = null;
  if (cartonLengthCm && cartonWidthCm && cartonHeightCm) {
    cbm = (Number(cartonLengthCm) * Number(cartonWidthCm) * Number(cartonHeightCm)) / 1000000;
  }
  const { rows } = await pool.query(
    `INSERT INTO export_product_packaging
      (variant_id, pack_size, inner_pack_qty, outer_carton_qty, net_weight_kg, gross_weight_kg, carton_length_cm, carton_width_cm, carton_height_cm, cbm, barcode)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [req.params.id, packSize || null, innerPackQty || null, outerCartonQty || null, netWeightKg || null,
     grossWeightKg || null, cartonLengthCm || null, cartonWidthCm || null, cartonHeightCm || null, cbm, barcode || null]
  );
  res.json(rows[0]);
});

// ---------- Customer-specific overrides ----------
router.post('/export/customer-product-configs', canManageVariants, async (req, res) => {
  const { customerId, variantId, specialPrice, priceCurrencyId, packagingRequirement, documentationRequirement } = req.body || {};
  if (!customerId || !variantId) return res.status(400).json({ error: 'Customer and variant are required.' });
  const { rows } = await pool.query(
    `INSERT INTO export_customer_product_configs (customer_id, variant_id, special_price, price_currency_id, packaging_requirement, documentation_requirement)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (customer_id, variant_id) DO UPDATE SET
       special_price=$3, price_currency_id=$4, packaging_requirement=$5, documentation_requirement=$6, active=true
     RETURNING *`,
    [customerId, variantId, specialPrice || null, priceCurrencyId || null, packagingRequirement || null, documentationRequirement || null]
  );
  res.json(rows[0]);
});

module.exports = router;
