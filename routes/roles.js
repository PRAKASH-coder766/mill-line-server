const express = require('express');
const { pool } = require('../db');
const { requireRole } = require('../middleware/auth'); // legacy check: admin gate for this admin-only screen
const { validateIdParams } = require('../middleware/validateId');

const router = express.Router();

// List every role in the system (both legacy-compatible and new Export roles).
router.get('/roles', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM roles WHERE active = true ORDER BY name');
  res.json(rows);
});

// The roles currently assigned to one user.
router.get('/users/:id/roles', requireRole('admin'), validateIdParams('id'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT r.id, r.code, r.name, ur.assigned_at, u.name AS assigned_by_name
     FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id
     LEFT JOIN users u ON u.id = ur.assigned_by
     WHERE ur.user_id = $1
     ORDER BY r.name`,
    [req.params.id]
  );
  res.json(rows);
});

// Assign one additional role to a user. A user may hold many roles at once —
// this only ever adds, never replaces (use the revoke endpoint to remove one).
router.post('/users/:id/roles', requireRole('admin'), validateIdParams('id'), async (req, res) => {
  const { roleCode } = req.body || {};
  if (!roleCode) return res.status(400).json({ error: 'roleCode is required.' });

  const role = (await pool.query('SELECT * FROM roles WHERE code=$1 AND active=true', [roleCode])).rows[0];
  if (!role) return res.status(404).json({ error: 'Unknown role.' });

  const targetUser = (await pool.query('SELECT * FROM users WHERE id=$1', [req.params.id])).rows[0];
  if (!targetUser) return res.status(404).json({ error: 'Unknown user.' });

  await pool.query(
    `INSERT INTO user_roles (user_id, role_id, assigned_by) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, role_id) DO NOTHING`,
    [req.params.id, role.id, req.session.userId]
  );

  await pool.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1,$2,$3)', [
    req.session.userId, 'role_assigned', JSON.stringify({ targetUserId: Number(req.params.id), targetUser: targetUser.name, role: roleCode }),
  ]);

  res.json({ ok: true });
});

// Remove one role from a user (their other roles are unaffected).
router.delete('/users/:id/roles/:roleCode', requireRole('admin'), validateIdParams('id'), async (req, res) => {
  const role = (await pool.query('SELECT * FROM roles WHERE code=$1', [req.params.roleCode])).rows[0];
  if (!role) return res.status(404).json({ error: 'Unknown role.' });

  await pool.query('DELETE FROM user_roles WHERE user_id=$1 AND role_id=$2', [req.params.id, role.id]);

  await pool.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1,$2,$3)', [
    req.session.userId, 'role_revoked', JSON.stringify({ targetUserId: Number(req.params.id), role: req.params.roleCode }),
  ]);

  res.json({ ok: true });
});

module.exports = router;
