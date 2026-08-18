const express = require('express');
const { pool } = require('../db');
const { requireLogin } = require('../middleware/auth');
const { requireAnyRole } = require('../utils/rbac');
const { resolvePricingControls } = require('../utils/pricing');
const { validateIdParams } = require('../middleware/validateId');

const router = express.Router();

// Setting pricing floors is a policy decision — Management/Admin only, not
// Export Sales (who work within the floor, per Owner Decision 6/17).
const canManagePricing = requireAnyRole('admin', 'management');
// Checking what the floor IS (without seeing every underlying control row)
// is something Export Sales legitimately needs while quoting.
const canCheckPricing = requireAnyRole('admin', 'management', 'export_sales');

async function logAction(userId, action, details) {
  await pool.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1,$2,$3)', [
    userId, action, details ? JSON.stringify(details) : null,
  ]);
}

router.get('/export/pricing-controls', canManagePricing, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT pc.*, v.sku_code, v.variant_name, c.company_name AS customer_name, cur.code AS currency_code
     FROM export_pricing_controls pc
     LEFT JOIN export_product_variants v ON v.id = pc.variant_id
     LEFT JOIN export_customers c ON c.id = pc.customer_id
     LEFT JOIN export_currencies cur ON cur.id = pc.currency_id
     WHERE pc.active = true
     ORDER BY pc.scope, c.company_name NULLS FIRST, v.variant_name NULLS FIRST`
  );
  res.json(rows);
});

router.post('/export/pricing-controls', canManagePricing, async (req, res) => {
  const { scope, variantId, customerId, minSellingPrice, minMarginPct, currencyId, isExplicitOverride } = req.body || {};
  if (!scope) return res.status(400).json({ error: 'Scope is required.' });
  if (!['global', 'variant', 'customer', 'customer_variant'].includes(scope)) {
    return res.status(400).json({ error: 'Scope must be global, variant, customer, or customer_variant.' });
  }
  if (scope === 'variant' && !variantId) return res.status(400).json({ error: 'Variant is required for a variant-scoped control.' });
  if (scope === 'customer' && !customerId) return res.status(400).json({ error: 'Customer is required for a customer-scoped control.' });
  if (scope === 'customer_variant' && (!variantId || !customerId)) {
    return res.status(400).json({ error: 'Both customer and variant are required for a customer_variant control.' });
  }
  if (minSellingPrice === undefined && minMarginPct === undefined) {
    return res.status(400).json({ error: 'Provide at least a minimum selling price or minimum margin %.' });
  }
  if (isExplicitOverride && scope !== 'customer_variant') {
    return res.status(400).json({ error: 'Only a customer_variant control can be an explicit override.' });
  }

  const { rows } = await pool.query(
    `INSERT INTO export_pricing_controls (scope, variant_id, customer_id, min_selling_price, min_margin_pct, currency_id, is_explicit_override, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [scope, scope === 'variant' || scope === 'customer_variant' ? variantId : null,
     scope === 'customer' || scope === 'customer_variant' ? customerId : null,
     minSellingPrice || null, minMarginPct || null, currencyId || null, !!isExplicitOverride, req.session.userId]
  );
  await logAction(req.session.userId, 'pricing_control_created', { scope, variantId, customerId, minSellingPrice, minMarginPct });
  res.json(rows[0]);
});

router.patch('/export/pricing-controls/:id', canManagePricing, validateIdParams('id'), async (req, res) => {
  const { active } = req.body || {};
  const { rows } = await pool.query('UPDATE export_pricing_controls SET active=$1 WHERE id=$2 RETURNING *', [active, req.params.id]);
  await logAction(req.session.userId, 'pricing_control_updated', { targetId: Number(req.params.id), active });
  res.json(rows[0]);
});

// Effective floor for a specific (variant, customer) combination — this is
// what the Quotation module (Module 7) will call to decide whether Management
// approval is mandatory (Owner Decision 6).
router.get('/export/pricing-controls/resolve', canCheckPricing, async (req, res) => {
  const { variantId, customerId } = req.query;
  const result = await resolvePricingControls(variantId ? Number(variantId) : null, customerId ? Number(customerId) : null);
  res.json(result);
});

module.exports = router;
