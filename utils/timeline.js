const { pool } = require('../db');

// A curated, human-readable business narrative — deliberately NOT an
// auto-generated dump of every field change (that's export_audit_log's job).
// Called explicitly at real milestones from the route files.
async function addTimelineEvent({ salesOrderId, quotationId, eventLabel, eventType, isCustomerVisible = true, createdBy }) {
  await pool.query(
    `INSERT INTO export_order_timeline (sales_order_id, quotation_id, event_label, event_type, is_customer_visible, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [salesOrderId || null, quotationId || null, eventLabel, eventType || null, isCustomerVisible, createdBy || null]
  );
}

module.exports = { addTimelineEvent };
