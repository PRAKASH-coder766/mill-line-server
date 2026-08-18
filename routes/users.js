const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { requireRole, requireLogin } = require('../middleware/auth');
const { validateIdParams } = require('../middleware/validateId');

const router = express.Router();

// Minimal, safe-for-anyone directory — just id/name/role, no PINs, no
// passkey counts. Used to populate "Operator"/"Supervisor" pickers on forms
// like Urid Pre-Processing without requiring admin access.
router.get('/basic', requireLogin, async (req, res) => {
  const { rows } = await pool.query(`SELECT id, name, role FROM users WHERE active=true ORDER BY name`);
  res.json(rows);
});

// List all users (admin only) — no PIN hashes ever leave the server.
router.get('/', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.username, u.role, u.active, u.created_at,
            COUNT(w.id)::int AS passkey_count
     FROM users u
     LEFT JOIN webauthn_credentials w ON w.user_id = u.id
     GROUP BY u.id
     ORDER BY u.created_at ASC`
  );
  res.json(rows);
});

// Create a new employee login. Admin sets a temporary PIN; the employee
// logs in once with it, then registers their own fingerprint/Face ID passkey.
router.post('/', requireRole('admin'), async (req, res) => {
  const { name, username, role, pin } = req.body || {};
  if (!name || !username || !role || !pin) {
    return res.status(400).json({ error: 'Name, username, role, and a temporary PIN are all required.' });
  }
  if (!['admin', 'operator', 'viewer', 'qc'].includes(role)) {
    return res.status(400).json({ error: 'Role must be admin, operator, viewer, or qc.' });
  }
  if (String(pin).length < 4) {
    return res.status(400).json({ error: 'PIN should be at least 4 digits.' });
  }

  const pinHash = await bcrypt.hash(String(pin), 10);
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (name, username, role, pin_hash) VALUES ($1,$2,$3,$4)
       RETURNING id, name, username, role, active, created_at`,
      [name, username.toLowerCase(), role, pinHash]
    );
    const newUser = rows[0];

    // Mirror the legacy role into the new multi-role system immediately —
    // don't wait for the next server boot's backfill. Admins can layer on
    // additional Export-module roles afterward via /users/:id/roles.
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id, assigned_by)
       SELECT $1, r.id, $2 FROM roles r WHERE r.code = $3
       ON CONFLICT (user_id, role_id) DO NOTHING`,
      [newUser.id, req.session.userId, role]
    );

    await pool.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1,$2,$3)', [
      req.session.userId, 'user_created', JSON.stringify({ created: username, role }),
    ]);
    res.json(newUser);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That username is already taken.' });
    throw err;
  }
});

// Change role or activate/deactivate an account.
router.patch('/:id', requireRole('admin'), validateIdParams('id'), async (req, res) => {
  const { role, active } = req.body || {};
  const fields = [];
  const values = [];
  let i = 1;
  if (role !== undefined) { fields.push(`role=$${i++}`); values.push(role); }
  if (active !== undefined) { fields.push(`active=$${i++}`); values.push(active); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });
  values.push(req.params.id);

  const { rows } = await pool.query(
    `UPDATE users SET ${fields.join(', ')} WHERE id=$${i} RETURNING id, name, username, role, active`,
    values
  );
  await pool.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1,$2,$3)', [
    req.session.userId, 'user_updated', JSON.stringify({ targetId: req.params.id, role, active }),
  ]);
  res.json(rows[0]);
});

// Reset a user's PIN (e.g. they lost their device and need to log in and re-register a passkey).
router.post('/:id/reset-pin', requireRole('admin'), validateIdParams('id'), async (req, res) => {
  const { pin } = req.body || {};
  if (!pin || String(pin).length < 4) return res.status(400).json({ error: 'PIN should be at least 4 digits.' });
  const pinHash = await bcrypt.hash(String(pin), 10);
  await pool.query('UPDATE users SET pin_hash=$1 WHERE id=$2', [pinHash, req.params.id]);
  await pool.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1,$2,$3)', [
    req.session.userId, 'pin_reset', JSON.stringify({ targetId: req.params.id }),
  ]);
  res.json({ ok: true });
});

// Remove a passkey-registered device from a user (lost phone, etc).
router.delete('/:id/credentials/:credId', requireRole('admin'), validateIdParams('id', 'credId'), async (req, res) => {
  await pool.query('DELETE FROM webauthn_credentials WHERE id=$1 AND user_id=$2', [req.params.credId, req.params.id]);
  res.json({ ok: true });
});

router.get('/:id/credentials', requireRole('admin'), validateIdParams('id'), async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, device_name, created_at FROM webauthn_credentials WHERE user_id=$1 ORDER BY created_at',
    [req.params.id]
  );
  res.json(rows);
});

module.exports = router;
