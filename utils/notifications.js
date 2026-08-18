const { pool } = require('../db');

// Event-driven notifications, deliberately decoupled from any one channel.
// Phase 1 only actually delivers "in_app" (a row the recipient can see in
// their inbox) — email/WhatsApp/SMS slot into the same event names later by
// adding a new channel sender, without the business logic that fires these
// events ever needing to change.
async function fireEvent(eventType, payload = {}) {
  const rule = (await pool.query(
    'SELECT * FROM export_notification_rules WHERE event_type=$1 AND active=true', [eventType]
  )).rows[0];
  if (!rule) return []; // no rule configured for this event — nothing to do, not an error

  const recipients = (await pool.query(
    `SELECT DISTINCT u.id FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id
     WHERE r.code = $1 AND u.active = true`,
    [rule.recipient_role]
  )).rows;

  const created = [];
  for (const recipient of recipients) {
    const { rows } = await pool.query(
      `INSERT INTO export_notifications (recipient_user_id, channel, event_type, payload, status, sent_at)
       VALUES ($1,$2,$3,$4,'sent',now()) RETURNING *`,
      [recipient.id, rule.channel, eventType, JSON.stringify(payload)]
    );
    created.push(rows[0]);
  }
  return created;
}

module.exports = { fireEvent };
