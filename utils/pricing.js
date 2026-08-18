const { pool } = require('../db');

// Resolves the effective minimum selling price / minimum margin % that
// applies to a given (variantId, customerId) combination.
//
// Rule (Owner Decision 6, hardened in the Addendum):
//   - Gather every ACTIVE control that applies: global (always), variant-scope
//     matching this variant, customer-scope matching this customer, and
//     customer_variant-scope matching both.
//   - If a customer_variant row exists with is_explicit_override = true, its
//     thresholds are used ALONE — it supersedes everything else outright.
//   - Otherwise, the MOST RESTRICTIVE threshold wins: since these are
//     MINIMUMS, "most restrictive" means the HIGHEST value among whichever
//     controls actually specify that field (nulls are ignored, not treated
//     as zero).
//
// Returns: { minSellingPrice, minMarginPct, source, contributingControls }
// `source` is 'explicit_override' or 'computed' — useful for showing the
// person why a given floor applies, not just what it is.
async function resolvePricingControls(variantId, customerId) {
  const { rows } = await pool.query(
    `SELECT * FROM export_pricing_controls
     WHERE active = true AND (
       scope = 'global'
       OR (scope = 'variant' AND variant_id = $1)
       OR (scope = 'customer' AND customer_id = $2)
       OR (scope = 'customer_variant' AND variant_id = $1 AND customer_id = $2)
     )`,
    [variantId || null, customerId || null]
  );

  const override = rows.find(r => r.scope === 'customer_variant' && r.is_explicit_override);
  if (override) {
    return {
      minSellingPrice: override.min_selling_price !== null ? Number(override.min_selling_price) : null,
      minMarginPct: override.min_margin_pct !== null ? Number(override.min_margin_pct) : null,
      source: 'explicit_override',
      contributingControls: [override],
    };
  }

  const prices = rows.map(r => r.min_selling_price).filter(v => v !== null).map(Number);
  const margins = rows.map(r => r.min_margin_pct).filter(v => v !== null).map(Number);

  return {
    minSellingPrice: prices.length ? Math.max(...prices) : null,
    minMarginPct: margins.length ? Math.max(...margins) : null,
    source: rows.length ? 'computed' : 'none',
    contributingControls: rows,
  };
}

module.exports = { resolvePricingControls };
