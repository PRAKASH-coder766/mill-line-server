const express = require('express');
const bcrypt = require('bcryptjs');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { pool } = require('../db');
const { getUserRoleCodes } = require('../utils/rbac');

const router = express.Router();

const RP_ID = process.env.RP_ID || 'localhost';
const RP_NAME = process.env.RP_NAME || 'Mill Line';
const ORIGIN = process.env.ORIGIN || 'http://localhost:3000';

async function logAction(userId, action, details) {
  await pool.query(
    'INSERT INTO audit_log (user_id, action, details) VALUES ($1,$2,$3)',
    [userId, action, details ? JSON.stringify(details) : null]
  );
}

// Populates both the legacy singular role (untouched, still drives every
// existing Mill Line permission check) and the new multi-role array (drives
// the Export module's requireAnyRole() checks). Neither depends on the other.
async function toSession(req, user) {
  req.session.userId = user.id;
  req.session.role = user.role;
  req.session.name = user.name;
  req.session.username = user.username;
  req.session.roles = await getUserRoleCodes(user.id);
}

// ---------- who am I ----------
router.get('/me', (req, res) => {
  if (!req.session.userId) return res.json({ loggedIn: false });
  res.json({
    loggedIn: true,
    id: req.session.userId,
    name: req.session.name,
    username: req.session.username,
    role: req.session.role,
    roles: req.session.roles || [],
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MINUTES = 15;
// Owner review flagged this explicitly: Admin and Management should not be
// protected by a PIN alone. Since they already have real WebAuthn passkeys
// available, MFA here means "PIN, then also verify your passkey" — reusing
// the exact same login-options/login-verify ceremony below as the second
// factor, rather than inventing a separate OTP/SMS system this deployment
// has no infrastructure for.
const MFA_REQUIRED_ROLES = ['admin', 'management'];

async function recentFailedAttempts(username) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM login_attempts
     WHERE username=$1 AND success=false AND attempted_at > now() - interval '${LOCKOUT_WINDOW_MINUTES} minutes'`,
    [username]
  );
  return rows[0].n;
}
async function recordAttempt(username, success) {
  await pool.query('INSERT INTO login_attempts (username, success) VALUES ($1,$2)', [username, success]);
}

// ---------- PIN login (fallback, and first-time login before a passkey exists) ----------
router.post('/login-pin', async (req, res) => {
  const { username, pin } = req.body || {};
  if (!username || !pin) return res.status(400).json({ error: 'Username and PIN are required.' });
  const normalizedUsername = username.toLowerCase();

  const failedCount = await recentFailedAttempts(normalizedUsername);
  if (failedCount >= MAX_FAILED_ATTEMPTS) {
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${LOCKOUT_WINDOW_MINUTES} minutes, or contact an admin to reset your PIN.` });
  }

  const { rows } = await pool.query('SELECT * FROM users WHERE username=$1 AND active=true', [normalizedUsername]);
  const user = rows[0];
  if (!user || !user.pin_hash) {
    await recordAttempt(normalizedUsername, false);
    return res.status(401).json({ error: 'Invalid username or PIN.' });
  }

  const ok = await bcrypt.compare(pin, user.pin_hash);
  if (!ok) {
    await recordAttempt(normalizedUsername, false);
    return res.status(401).json({ error: 'Invalid username or PIN.' });
  }
  await recordAttempt(normalizedUsername, true);

  const roleCodes = await getUserRoleCodes(user.id);
  const requiresMfa = roleCodes.some(r => MFA_REQUIRED_ROLES.includes(r));
  const hasPasskey = (await pool.query('SELECT 1 FROM webauthn_credentials WHERE user_id=$1 LIMIT 1', [user.id])).rows.length > 0;

  if (requiresMfa && hasPasskey) {
    // PIN alone is not enough for this account — leave the session
    // unauthenticated and require the passkey step (login-options →
    // login-verify below) to actually complete sign-in.
    req.session.pendingUserId = user.id;
    await logAction(user.id, 'login_pin_awaiting_mfa');
    return res.json({ ok: true, mfaRequired: true, username: user.username });
  }

  await toSession(req, user);
  await logAction(user.id, 'login_pin');
  res.json({
    ok: true, role: user.role, roles: req.session.roles, name: user.name,
    mfaSetupRequired: requiresMfa && !hasPasskey, // nag banner — this account should have a passkey and doesn't yet
  });
});

// ---------- Passkey (fingerprint / Face ID) registration ----------
// Step 1: browser asks the server what to sign. Requires being logged in already
// (via PIN) so a stranger can't attach a passkey to someone else's account.
router.post('/register-options', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Log in with your PIN first, then add a passkey.' });

  const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.session.userId]);
  const user = rows[0];

  const { rows: existingCreds } = await pool.query(
    'SELECT credential_id, transports FROM webauthn_credentials WHERE user_id=$1',
    [user.id]
  );

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userID: Buffer.from(String(user.id)),
    userName: user.username,
    userDisplayName: user.name,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'required', // forces the device to actually check fingerprint/Face ID/PIN
    },
    excludeCredentials: existingCreds.map(c => ({
      id: c.credential_id,
      transports: c.transports ? JSON.parse(c.transports) : undefined,
    })),
  });

  // options.user.id is a Node Buffer at this point. Buffer survives fine
  // inside Node, but Buffer.prototype.toJSON() makes JSON.stringify (and
  // therefore res.json below) serialize it as {type:'Buffer',data:[...]}
  // instead of a string — which breaks the browser-side base64url decoder
  // entirely (it throws "The string contains invalid characters" trying to
  // atob() that object's string form). Encode it explicitly before it ever
  // reaches res.json.
  options.user.id = Buffer.from(String(user.id)).toString('base64url');

  req.session.currentChallenge = options.challenge;
  res.json(options);
});

// Step 2: browser sends back the signed challenge; verify and store the credential.
router.post('/register-verify', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
  const { response, deviceName } = req.body;

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: req.session.currentChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });
  } catch (err) {
    return res.status(400).json({ error: 'Could not verify passkey: ' + err.message });
  }

  if (!verification.verified || !verification.registrationInfo) {
    return res.status(400).json({ error: 'Passkey registration was not verified.' });
  }

  const { credential } = verification.registrationInfo;
  await pool.query(
    `INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, device_name, transports)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      req.session.userId,
      credential.id,
      Buffer.from(credential.publicKey).toString('base64'),
      credential.counter,
      deviceName || 'Unnamed device',
      JSON.stringify(response.response.transports || []),
    ]
  );

  await logAction(req.session.userId, 'passkey_registered', { deviceName });
  res.json({ ok: true });
});

// ---------- Passkey login ----------
router.post('/login-options', async (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Username is required.' });

  const { rows } = await pool.query('SELECT * FROM users WHERE username=$1 AND active=true', [username.toLowerCase()]);
  const user = rows[0];
  if (!user) return res.status(401).json({ error: 'No such user, or account is inactive.' });

  const { rows: creds } = await pool.query('SELECT credential_id, transports FROM webauthn_credentials WHERE user_id=$1', [user.id]);
  if (creds.length === 0) return res.status(404).json({ error: 'No passkey set up for this account yet. Use PIN login.' });

  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: 'required',
    allowCredentials: creds.map(c => ({
      id: c.credential_id,
      transports: c.transports ? JSON.parse(c.transports) : undefined,
    })),
  });

  req.session.currentChallenge = options.challenge;
  req.session.pendingUserId = user.id;
  res.json(options);
});

router.post('/login-verify', async (req, res) => {
  const { response } = req.body;
  const userId = req.session.pendingUserId;
  if (!userId) return res.status(400).json({ error: 'Login was not initiated correctly. Try again.' });

  const { rows } = await pool.query('SELECT * FROM webauthn_credentials WHERE credential_id=$1 AND user_id=$2', [response.id, userId]);
  const cred = rows[0];
  if (!cred) return res.status(400).json({ error: 'Unknown passkey.' });

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: req.session.currentChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: cred.credential_id,
        publicKey: Buffer.from(cred.public_key, 'base64'),
        counter: Number(cred.counter),
      },
      requireUserVerification: true,
    });
  } catch (err) {
    return res.status(400).json({ error: 'Could not verify passkey: ' + err.message });
  }

  if (!verification.verified) return res.status(400).json({ error: 'Passkey verification failed.' });

  await pool.query('UPDATE webauthn_credentials SET counter=$1 WHERE id=$2', [verification.authenticationInfo.newCounter, cred.id]);

  const { rows: userRows } = await pool.query('SELECT * FROM users WHERE id=$1', [userId]);
  const user = userRows[0];
  await toSession(req, user);
  delete req.session.pendingUserId;
  await logAction(user.id, 'login_passkey');
  res.json({ ok: true, role: user.role, roles: req.session.roles, name: user.name });
});

module.exports = router;
