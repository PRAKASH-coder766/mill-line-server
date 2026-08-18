const express = require('express');
const { pool } = require('../db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { validateIdParams } = require('../middleware/validateId');

const router = express.Router();

// A user's own notification inbox.
router.get('/export/notifications/mine', requireLogin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM export_notifications WHERE recipient_user_id=$1 ORDER BY created_at DESC LIMIT 100`,
    [req.session.userId]
  );
  res.json(rows);
});

router.patch('/export/notifications/:id/read', requireLogin, validateIdParams('id'), async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE export_notifications SET read_at=now() WHERE id=$1 AND recipient_user_id=$2 RETURNING *`,
    [req.params.id, req.session.userId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Notification not found.' });
  res.json(rows[0]);
});

// Admin: view/configure which role gets notified for which event.
router.get('/export/notification-rules', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM export_notification_rules ORDER BY event_type');
  res.json(rows);
});

router.patch('/export/notification-rules/:eventType', requireRole('admin'), async (req, res) => {
  const { recipientRole, active } = req.body || {};
  const fields = [];
  const values = [];
  let i = 1;
  if (recipientRole !== undefined) { fields.push(`recipient_role=$${i++}`); values.push(recipientRole); }
  if (active !== undefined) { fields.push(`active=$${i++}`); values.push(active); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });
  values.push(req.params.eventType);
  const { rows } = await pool.query(
    `UPDATE export_notification_rules SET ${fields.join(', ')} WHERE event_type=$${i} RETURNING *`, values
  );
  res.json(rows[0]);
});

module.exports = router;
