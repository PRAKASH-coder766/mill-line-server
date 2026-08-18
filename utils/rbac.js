const { pool } = require('../db');

// Fetches the full set of role codes currently assigned to a user via the
// new user_roles table. Used at login time to populate req.session.roles
// (an array), which every Export-module permission check reads from —
// completely separate from the legacy req.session.role (singular) that
// Mill Line's existing requireRole() checks continue to use untouched.
async function getUserRoleCodes(userId) {
  const { rows } = await pool.query(
    `SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = $1 AND r.active = true`,
    [userId]
  );
  return rows.map(r => r.code);
}

// Express middleware: allows the request through if the logged-in user
// holds ANY of the listed role codes (checked against req.session.roles,
// populated at login — see routes/auth.js). This is the Export module's
// equivalent of the legacy requireRole(), but multi-role aware.
function requireAnyRole(...roleCodes) {
  return (req, res, next) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: 'Not logged in.' });
    }
    const userRoles = req.session.roles || [];
    const allowed = roleCodes.some(code => userRoles.includes(code));
    if (!allowed) {
      return res.status(403).json({ error: 'You do not have permission to do that.' });
    }
    next();
  };
}

// Convenience check for use inside route handlers (not just as middleware),
// e.g. when a single endpoint needs different behavior per role rather than
// an outright allow/deny.
function sessionHasRole(req, ...roleCodes) {
  const userRoles = req.session.roles || [];
  return roleCodes.some(code => userRoles.includes(code));
}

module.exports = { getUserRoleCodes, requireAnyRole, sessionHasRole };
