/**
 * ============================================================================
 *  ART ARENA™ — PHASE 1 · FOUNDATION
 *  Authentication service (dev build)
 *
 *  Implements: sign up · log in · log out · forgot password (the ONLY
 *  password-change path) · email verification (code delivered by email —
 *  never shown on a form) · username creation · profile creation ·
 *  session persistence · basic account settings (profile).
 *
 *  Design rules (from the product spec):
 *   - THE SERVER IS THE SOURCE OF TRUTH: passwords hashed (bcrypt), one-time
 *     tokens stored ONLY as SHA-256 hashes, sessions server-side in
 *     Postgres, all timestamps server-generated.
 *   - Registration auto-creates the full identity record:
 *     users + user_profiles + user_statistics + verification token
 *     (one transaction — it all happens or nothing does).
 *   - EMAIL IS THE ONLY CHANNEL for one-time codes. All delivery lives in
 *     mail.js (sendEmail + provider seam: dev simulated inbox / Resend /
 *     Postmark, chosen by env — see mail.js). The auth flow only ever calls
 *     sendEmail() and knows nothing about providers.
 *   - The login response returns the session token; the client sends it back
 *     as `Authorization: Bearer <token>`. The server also accepts the
 *     HttpOnly cookie. (Bearer support is what makes sessions work in
 *     embedded/iframe previews where browsers partition third-party cookies.)
 *
 *  Stack: Node 20 · Express 4 · pg · bcryptjs
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { sendEmail, resolveProvider, outboxRead, TTL_HOURS } = require('./mail');
const {
  pool, DEV, SESSION_TTL_DAYS, COOKIE_NAME,
  sha256, HttpError, ah, parseCookies, maskToken,
  sessionTokenFromRequest, requireAuth,
  authUserPayload, fullUser, cookieOpts,
} = require('./lib');
const rooms = require('./rooms');
const matchmaking = require('./matchmaking');
const battleEnd = require('./battle-end');
const googleAuth = require('./google-auth');
const multer = require('multer');
const { initRealtime, closeRealtime } = require('./realtime');
const randomizerRouter = require('./randomizer');
const { ensureRandomizerSeed } = require('./seed');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT || 3000);
const BCRYPT_ROUNDS = 12;

// Fail fast on broken mail config: a server that cannot deliver one-time
// codes must never start (dev defaults to the simulated inbox; production
// requires MAIL_PROVIDER + the matching API key — see mail.js).
const mailProvider = resolveProvider();

// Pre-computed hash used to equalize timing on login for unknown users
// (prevents user enumeration via response time).
const DUMMY_HASH = bcrypt.hashSync('art-arena-dummy', BCRYPT_ROUNDS);

// pool + session auth live in ./lib (shared with feature routers)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const newToken = () => crypto.randomBytes(32).toString('hex');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;
const validPassword = (pw) => typeof pw === 'string' && pw.length >= 8 && pw.length <= 128;

// ---------------------------------------------------------------------------
// Email delivery lives in ./mail — the auth flow calls sendEmail() (same
// signature as before) and nothing else. Provider choice (dev simulated
// inbox / Resend / Postmark), email bodies, and code lifetimes are all
// configured there via environment. Swap providers by editing .env only.
// ---------------------------------------------------------------------------

const ACCOUNT_STATUS_MSG = {
  suspended: 'This account is suspended.',
  banned: 'This account has been banned.',
  deactivated: 'This account is deactivated.',
};

// ---------------------------------------------------------------------------
// Session resolution lives in ./lib (requireAuth) — shared with the feature
// routers. The server decides who is logged in (never the client); channels:
// Bearer header → arena_session cookie → ?arena_token (masked in logs).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
// v45: post-migration schema check result (read by /api/health).
let schemaState = null; // null = not checked yet; [] = all good

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
// no-store for HTML: the dev preview must NEVER serve a stale page —
// a stale page carries old session logic and causes phantom
// "Not authenticated" errors that don't reproduce server-side.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
  },
}));

// Request log (dev) — makes session/auth problems diagnosable in one glance.
// Also records WHICH channel carried the session token (header / cookie /
// query / none), which is how embedded-preview header-stripping is caught.
app.use((req, res, next) => {
  if (DEV && req.originalUrl.startsWith('/api/')) {
    res.on('finish', () => {
      const auth = req.headers.authorization || '';
      const via = auth.startsWith('Bearer ') ? 'header'
        : parseCookies(req.headers.cookie)[COOKIE_NAME] ? 'cookie'
        : typeof (req.query && req.query.arena_token) === 'string' ? 'query' : '-';
      console.log(`${req.method} ${maskToken(req.originalUrl)} -> ${res.statusCode} [token via ${via}]`);
    });
  }
  next();
});

// ----------------------------- health --------------------------------------
app.get('/api/health', ah(async (req, res) => {
  const { rows } = await pool.query('SELECT 1');
  res.json({
    ok: true,
    db: rows.length ? 'up' : 'down',
    dev: DEV,
    // v45: schema migration state — 'ok', or the missing objects by name.
    // (Surfaced so a permissions-blocked migration on a managed DB is
    // visible in Render logs/dashboards instead of surfacing as 500s.)
    schema: Array.isArray(schemaState) ? (schemaState.length ? 'incomplete: ' + schemaState.join(', ') : 'ok') : 'unchecked',
  });
}));

// --------------------- 0b. UI VERSION GUARD --------------------------------
// Stale browser tabs are how real users ended up debugging phantom bugs.
// The client polls this; if the served version differs from the version the
// open page was loaded with, the page shows a reload banner and reloads.
let UI_VERSION = '0';
try {
  const htmlText = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const m = htmlText.match(/aa-ui-version" content="(\d+)"/);
  if (m) UI_VERSION = m[1];
} catch (_) { /* index.html missing — guard stays inert */ }
app.get('/api/ui-version', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ui: UI_VERSION });
});

// --------------------------- 1. SIGN UP ------------------------------------
// Auto-creates users + user_profiles + user_statistics + verification code
// (emailed). The code is NOT returned in this response.
app.post('/api/auth/register', ah(async (req, res) => {
  const { username, email, password } = req.body || {};

  const problems = [];
  if (!username || typeof username !== 'string' || !USERNAME_RE.test(username.trim()))
    problems.push('Username must be 3-30 characters (letters, numbers, underscore).');
  if (!email || typeof email !== 'string' || !EMAIL_RE.test(email.trim()))
    problems.push('Enter a valid email address.');
  if (!validPassword(password))
    problems.push('Password must be 8-128 characters.');
  if (problems.length) throw new HttpError(400, problems.join(' '));

  const uname = username.trim();
  const uemail = email.trim().toLowerCase();
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const client = await pool.connect();
  let verifyToken;
  let user;
  try {
    await client.query('BEGIN');

    // Integrity: citext UNIQUE handles case; explicit check for a clean 409.
    const dupe = await client.query(
      `SELECT username, email FROM users WHERE username = $1 OR email = $2`,
      [uname, uemail]
    );
    if (dupe.rows[0]) {
      await client.query('ROLLBACK');
      const which = dupe.rows[0].username === uname ? 'username' : 'email';
      throw new HttpError(409, `That ${which} is already taken.`);
    }

    const u = await client.query(
      `INSERT INTO users (username, email, password_hash, display_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, email, display_name, account_status,
                 two_factor_enabled, last_login_at, email_verified_at,
                 created_at AS joined_at`,
      [uname, uemail, hash, uname]
    );
    user = u.rows[0];

    // Profile + competitive record exist from day one (schema §3).
    await client.query(
      `INSERT INTO user_profiles (user_id, is_discoverable) VALUES ($1, true)`,
      [user.id]
    );
    await client.query(`INSERT INTO user_statistics (user_id) VALUES ($1)`, [user.id]);

    verifyToken = newToken();
    await client.query(
      `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at)
       VALUES ($1, 'email_verification', $2, now() + ($3 || ' hours')::interval)`,
      [user.id, sha256(verifyToken), TTL_HOURS.verification]
    );

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e && e.code === '23505') throw new HttpError(409, 'That username or email is already taken.');
    throw e;
  } finally {
    client.release();
  }

  await sendEmail({ email: uemail }, 'Verify your Art Arena email', verifyToken, 'verification');

  res.status(201).json({
    user: authUserPayload({ ...user, email: uemail }),
    message: 'Account created. A verification code has been sent to your email.',
  });
}));

// ------------------------ 2. EMAIL VERIFICATION ----------------------------
app.post('/api/auth/verify-email', ah(async (req, res) => {
  const { token } = req.body || {};
  if (!token || typeof token !== 'string' || !token.trim())
    throw new HttpError(400, 'A verification code is required.');

  const t = await pool.query(
    `SELECT id, user_id FROM auth_tokens
      WHERE token_hash = $1
        AND purpose = 'email_verification'
        AND used_at IS NULL
        AND expires_at > now()`,
    [sha256(token.trim())]
  );
  if (!t.rows[0]) throw new HttpError(400, 'Invalid or expired verification code.');

  const u = await pool.query(
    `UPDATE users SET email_verified_at = now()
      WHERE id = $1 AND email_verified_at IS NULL
      RETURNING id, username, email, display_name, account_status,
                two_factor_enabled, last_login_at, email_verified_at,
                created_at AS joined_at`,
    [t.rows[0].user_id]
  );
  if (!u.rows[0]) throw new HttpError(400, 'Invalid or expired verification code.');

  await pool.query(`UPDATE auth_tokens SET used_at = now() WHERE id = $1`, [t.rows[0].id]);
  res.json({ ok: true, message: 'Email verified. Welcome to the Arena.', user: authUserPayload(u.rows[0]) });
}));

// Resend a fresh verification code (validates the sender's own session).
app.post('/api/auth/resend-verification', requireAuth, ah(async (req, res) => {
  if (req.user.email_verified_at) throw new HttpError(400, 'Email is already verified.');

  const token = newToken();
  await pool.query(
    `UPDATE auth_tokens SET used_at = now()
      WHERE user_id = $1 AND purpose = 'email_verification' AND used_at IS NULL`,
    [req.user.id]
  );
  await pool.query(
    `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at)
     VALUES ($1, 'email_verification', $2, now() + ($3 || ' hours')::interval)`,
     [req.user.id, sha256(token), TTL_HOURS.verification]
  );
  await sendEmail(req.user, 'Verify your Art Arena email', token, 'verification');

  res.json({ ok: true, message: 'A new verification code has been sent to your email.' });
}));

// ----------------------------- 3. LOG IN -----------------------------------
// Accepts email OR username (citext = case-insensitive).
// Response includes the full account payload AND the session token, which the
// client echoes back as `Authorization: Bearer <token>` (cookie also set).
app.post('/api/auth/login', ah(async (req, res) => {
  const { login, password } = req.body || {};
  if (!login || typeof login !== 'string' || !password || typeof password !== 'string')
    throw new HttpError(400, 'Enter your email (or username) and password.');

  const { rows } = await pool.query(
    `SELECT id, username, email, password_hash, display_name, account_status,
            two_factor_enabled, last_login_at, email_verified_at,
            created_at AS joined_at
       FROM users
      WHERE email = $1 OR username = $1`,
    [login.trim()]
  );
  const user = rows[0];

  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) {
    // v37 dev diagnostic (never logs the password): proves WHERE a failed
    // login died — lookup miss (wrong email/username, typo) vs hash
    // mismatch (the password itself differs from what is stored).
    if (DEV) console.log('  ! login rejected for "' + login.trim() + '": ' +
      (user ? 'user FOUND — password does not match the stored hash'
            : 'no user with that email or username'));
    throw new HttpError(401, 'Invalid credentials.');
  }
  if (user.account_status !== 'active') throw new HttpError(403, ACCOUNT_STATUS_MSG[user.account_status]);

  const token = newToken();
  const ua = (req.get('user-agent') || '').slice(0, 255) || null;
  await pool.query(
    `INSERT INTO sessions (user_id, token_hash, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4::inet, now() + ($5 || ' days')::interval)`,
    [user.id, sha256(token), ua, req.ip || null, SESSION_TTL_DAYS]
  );
  const loginAt = new Date().toISOString();
  await pool.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);

  res.cookie(COOKIE_NAME, token, cookieOpts());
  const out = await fullUser({ ...user, last_login_at: loginAt });
  out.session_token = token;
  res.json(out);
}));

// ----------------------------- 4. LOG OUT ----------------------------------
app.post('/api/auth/logout', ah(async (req, res) => {
  const raw = sessionTokenFromRequest(req);
  if (raw) {
    await pool.query(
      `UPDATE sessions SET revoked_at = now()
        WHERE token_hash = $1 AND revoked_at IS NULL`,
      [sha256(raw)]
    );
  }
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
}));

// --------------------------- 5. CURRENT USER --------------------------------
app.get('/api/auth/me', requireAuth, ah(async (req, res) => {
  res.json(await fullUser(req.user));
}));

// ------------------------ 6. FORGOT PASSWORD --------------------------------
// Deliberately generic response: never reveals whether the email exists.
// The reset code is emailed only.
app.post('/api/auth/forgot-password', ah(async (req, res) => {
  const generic = { ok: true, message: 'If that email is registered, a password reset code has been sent to it.' };
  const { email } = req.body || {};
  if (!email || typeof email !== 'string' || !EMAIL_RE.test(email.trim())) return res.json(generic);

  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [email.trim().toLowerCase()]);
  if (!rows[0]) return res.json(generic);

  const token = newToken();
  await pool.query(
    `UPDATE auth_tokens SET used_at = now()
      WHERE user_id = $1 AND purpose = 'password_reset' AND used_at IS NULL`,
    [rows[0].id]
  );
  await pool.query(
    `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at)
     VALUES ($1, 'password_reset', $2, now() + ($3 || ' hours')::interval)`,
    [rows[0].id, sha256(token), TTL_HOURS.reset]
  );
  await sendEmail({ email: email.trim() }, 'Reset your Art Arena password', token, 'reset');

  res.json(generic);
}));

// ------------------------ 7. RESET PASSWORD ---------------------------------
app.post('/api/auth/reset-password', ah(async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || typeof token !== 'string' || !token.trim())
    throw new HttpError(400, 'A reset code is required.');
  if (!validPassword(password))
    throw new HttpError(400, 'New password must be 8-128 characters.');

  const t = await pool.query(
    `SELECT id, user_id FROM auth_tokens
      WHERE token_hash = $1
        AND purpose = 'password_reset'
        AND used_at IS NULL
        AND expires_at > now()`,
    [sha256(token.trim())]
  );
  if (!t.rows[0]) throw new HttpError(400, 'Invalid or expired reset code.');

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await pool.query(`UPDATE auth_tokens SET used_at = now() WHERE id = $1`, [t.rows[0].id]);
  await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, t.rows[0].user_id]);
  // Every session for this account is revoked — old devices signed out.
  await pool.query(
    `UPDATE sessions SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [t.rows[0].user_id]
  );
  res.json({ ok: true, message: 'Password updated. Log in with your new password.' });
}));

// ---------------------- 8. GOOGLE SIGN-IN (OAuth 2.0 + PKCE) ------------------
// Real Google login built on the existing session architecture — see
// ./google-auth for the full flow + security notes. The client secret stays
// server-side; the browser only ever talks to these /api/auth/google routes.
app.use('/api/auth/google', googleAuth.router);

// ------------------------ 9. DRAWING APPS (reference) ------------------------
// v33: the "Choose your canvas" picker is driven entirely by this list.
// Status is derived from integration_level:
//   3        → "connected"     — a live integration exists (selectable)
//   other    → "external"      — the artist brings any app they use (selectable)
//   anything else → "coming_soon" — shown, but never selectable
// Adding a new drawing app later = one row in drawing_apps; no UI change.
app.get('/api/drawing-apps', ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT app_key, display_name, integration_level
       FROM drawing_apps WHERE is_active ORDER BY display_name`
  );
  const apps = rows.map((r) => {
    const connected = r.integration_level === 3;
    return {
      app_key: r.app_key,
      display_name: r.display_name,
      integration_level: r.integration_level,
      status: connected ? 'connected' : (r.app_key === 'other' ? 'external' : 'coming_soon'),
      integration_available: connected,
      selectable: connected || r.app_key === 'other',
    };
  });
  res.json({ drawing_apps: apps });
}));

// ----------------------- 10. DEV: SIMULATED MAILBOX -------------------------
// Dev-only stand-in for the user's real inbox (what sendEmail() would send).
// NEVER enabled in production.
app.get('/api/dev/outbox', ah(async (req, res) => {
  if (!DEV) throw new HttpError(404, 'Not found.');
  const to = String(req.query.to || '').trim().toLowerCase();
  const all = outboxRead();
  const emails = to ? all.filter((e) => e.to.toLowerCase() === to) : all;
  res.json({
    dev: true,
    note: 'Simulated mailbox (dev only). In production these emails go to the user\'s real inbox via the mail provider.',
    emails,
  });
}));

// ----------------------- 11. ACCOUNT SETTINGS -------------------------------
// Basic account settings: display name, bio, country, drawing app, discoverable.
// NOTE: password changes are ONLY via forgot password (product decision) —
// there is no change-password endpoint.
app.put('/api/account/profile', requireAuth, ah(async (req, res) => {
  const b = req.body || {};
  const keys = Object.keys(b);
  if (keys.length === 0) throw new HttpError(400, 'Nothing to update.');

  // [column, value] pairs, validated first, then applied per table.
  const userCols = [];
  const profileCols = [];

  if ('display_name' in b) {
    const v = String(b.display_name ?? '').trim();
    if (v.length < 1 || v.length > 50) throw new HttpError(400, 'Display name must be 1-50 characters.');
    userCols.push(['display_name', v]);
  }
  if ('bio' in b) {
    const v = b.bio == null ? '' : String(b.bio);
    if (v.length > 300) throw new HttpError(400, 'Bio must be 300 characters or fewer.');
    profileCols.push(['bio', v || null]);
  }
  if ('country_code' in b) {
    const v = b.country_code == null || b.country_code === '' ? null : String(b.country_code).toUpperCase().trim(); // v38: blank field = no country (null), not a 400
    if (v !== null && !/^[A-Z]{2,3}$/.test(v)) throw new HttpError(400, 'Country code must be 2-3 letters (ISO).');
    profileCols.push(['country_code', v]);
  }
  if ('drawing_app_key' in b) {
    const v = b.drawing_app_key == null || b.drawing_app_key === '' ? null : String(b.drawing_app_key); // v38: '— none —' option = null, not a 400
    if (v !== null) {
      const { rows } = await pool.query(
        `SELECT 1 FROM drawing_apps WHERE app_key = $1 AND is_active`, [v]
      );
      if (!rows[0]) throw new HttpError(400, 'Unknown drawing app.');
    }
    profileCols.push(['drawing_app_key', v]);
  }
  if ('is_discoverable' in b) {
    if (typeof b.is_discoverable !== 'boolean') throw new HttpError(400, 'is_discoverable must be true or false.');
    profileCols.push(['is_discoverable', b.is_discoverable]);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (userCols.length) {
      const sets = userCols.map((c, i) => `${c[0]} = $${i + 1}`);
      const params = userCols.map((c) => c[1]);
      params.push(req.user.id);
      await client.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    }
    if (profileCols.length) {
      const sets = profileCols.map((c, i) => `${c[0]} = $${i + 1}`);
      const params = profileCols.map((c) => c[1]);
      params.push(req.user.id);
      await client.query(`UPDATE user_profiles SET ${sets.join(', ')} WHERE user_id = $${params.length}`, params);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  const u = await pool.query(
    `SELECT id, username, email, display_name, account_status, two_factor_enabled,
            last_login_at, email_verified_at, created_at AS joined_at
       FROM users WHERE id = $1`,
    [req.user.id]
  );
  res.json(await fullUser(u.rows[0]));
}));

// --------------------- 11b. PROFILE PICTURE (v29) ----------------------------
// Users upload their own picture (PNG/JPEG/WebP, <= 5 MB). The file lands in
// server/avatars/ (a workspace file — survives sandbox resets) and is served
// statically at /avatars/<user-uuid>.<ext>. The key lives in the schema's
// pre-existing user_profiles.avatar_storage_key column. Magic-byte sniffing
// rejects files that lie about their type.
const AVATARS_DIR = path.join(__dirname, 'avatars');
fs.mkdirSync(AVATARS_DIR, { recursive: true });
app.use('/avatars', express.static(AVATARS_DIR, { fallthrough: false, maxAge: '1d' }));

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    cb(null, /^image\/(png|jpeg|webp)$/.test(file.mimetype)),
});

function sniffImage(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

app.post('/api/account/avatar', requireAuth, avatarUpload.single('image'), ah(async (req, res) => {
  const f = req.file;
  if (!f) throw new HttpError(400, 'Choose an image file (PNG, JPEG or WebP).');
  const ext = sniffImage(f.buffer);
  if (!ext) throw new HttpError(400, 'That file does not look like a valid image.');
  // v36 (the real storage fix): IMMUTABLE, VERSIONED file — the key embeds
  // the upload epoch, so an upload NEVER overwrites an existing file. The
  // old bug: the same path was overwritten on every upload while the
  // browser kept the 1-day-cached OLD bytes at the old URL, so the picture
  // "reverted". Old versions are still unlinked; the DB key is the truth,
  // and every payload (fullUser in lib.js) derives the same ?v= from the
  // key's epoch — so /me, opponents, the drawer and matchmaking all agree.
  const key = req.user.id + '-' + Date.now() + '.' + ext;
  const tmp = path.join(AVATARS_DIR, key + '.tmp');
  fs.writeFileSync(tmp, f.buffer);
  fs.renameSync(tmp, path.join(AVATARS_DIR, key)); // atomic
  const prev = await pool.query('SELECT avatar_storage_key FROM user_profiles WHERE user_id = $1', [req.user.id]);
  const oldKey = prev.rows[0] && prev.rows[0].avatar_storage_key;
  if (oldKey && oldKey !== key) { try { fs.unlinkSync(path.join(AVATARS_DIR, oldKey)); } catch (_) {} }
  await pool.query('UPDATE user_profiles SET avatar_storage_key = $1, updated_at = now() WHERE user_id = $2', [key, req.user.id]);
  // Cache-buster = the epoch embedded in the key — identical to the value
  // fullUser() derives, so the upload response and every later payload
  // return the SAME stable URL for the bytes on disk.
  res.json({ avatar_url: '/avatars/' + key + '?v=' + key.match(/-(\d{10,15})\./)[1] });
}));

app.delete('/api/account/avatar', requireAuth, ah(async (req, res) => {
  const prev = await pool.query('SELECT avatar_storage_key FROM user_profiles WHERE user_id = $1', [req.user.id]);
  const oldKey = prev.rows[0] && prev.rows[0].avatar_storage_key;
  if (oldKey) {
    try { fs.unlinkSync(path.join(AVATARS_DIR, oldKey)); } catch (_) {}
    await pool.query('UPDATE user_profiles SET avatar_storage_key = NULL, updated_at = now() WHERE user_id = $1', [req.user.id]);
  }
  res.json({ avatar_url: null });
}));

// ---------------- 11c. MY BATTLES / MY ARTWORKS (v29) -----------------------
// Real data only: these feed the profile page's "Battle History" and
// "Saved Artworks" lists. Both are honest empty states until battles exist
// (the Phase 7 engine will populate them).
app.get('/api/account/battles', requireAuth, ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.id, b.status, b.competition_type, b.time_limit_seconds, b.start_time, b.created_at,
            bp.outcome, bp.final_position,
            r.code AS room_code, r.name AS room_name
       FROM battle_participants bp
       JOIN battles b ON b.id = bp.battle_id
       JOIN battle_rooms r ON r.id = b.room_id
      WHERE bp.user_id = $1
      ORDER BY b.created_at DESC
      LIMIT 50`,
    [req.user.id]
  );
  res.json({ battles: rows });
}));

app.get('/api/account/artworks', requireAuth, ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.id, s.mime_type, s.file_size_bytes, s.status, s.submitted_at, s.storage_key,
            r.code AS room_code, r.name AS room_name
       FROM submissions s
       JOIN battles b ON b.id = s.battle_id
       JOIN battle_rooms r ON r.id = b.room_id
      WHERE s.artist_id = $1
      ORDER BY s.submitted_at DESC
      LIMIT 50`,
    [req.user.id]
  );
  res.json({ artworks: rows });
}));

// ------------------------- 12. BATTLE ROOMS (Phase 4) ------------------------
// The place where artists meet: create rooms, join as players, spectate,
// set battle type + time limit, start the battle. Implementation in ./rooms.
app.get('/api/notifications/unread', requireAuth, ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
    [req.user.id]
  );
  res.json({ unread: rows[0].n });
}));

app.use('/api/rooms', rooms.router);
// v35: matchmaking (the "Battle" button) — a real persisted queue that
// pairs queued artists into real private 1v1 rooms (./matchmaking).
app.use('/api/matchmaking', matchmaking.router);
// Phase 6: the randomizer (categories, host element choice, lock-challenge).
app.use('/api', randomizerRouter);

// ------------------------------ fallbacks -----------------------------------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.name === 'MulterError') {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Image must be 5 MB or smaller.'
      : err.code === 'LIMIT_UNEXPECTED_FILE' ? 'Send exactly one image file named "image".'
      : 'Upload failed — please try again.';
    return res.status(400).json({ error: msg });
  }
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err);
  if (res.headersSent) return next(err);
  res.status(status).json({
    error: status >= 500 ? (DEV ? err.message : 'Something went wrong on our side. Try again.') : err.message,
    // v35: structured extras for the UI (e.g. { room_full: true }) — the
    // client can offer "Enter as a Spectator" instead of a dead end.
    // Nest under `data` so the client reads one namespaced field (j.data).
    ...(status < 500 && err.data ? { data: err.data } : {}),
  });
});

// ---------------------------------------------------------------------------
const httpServer = app.listen(PORT, '0.0.0.0', async () => {
  console.log(`ART ARENA — auth service listening on 0.0.0.0:${PORT} (dev=${DEV})`);
  console.log('GOOGLE auth: ' + (googleAuth.isConfigured()
    ? 'configured — “Continue with Google” is live.'
    : 'not configured — Google button stays in “coming soon” until GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET are set in server/.env.'));
  console.log(`MAIL provider: ${mailProvider.name}` +
    (mailProvider.name === 'dev-inbox'
      ? ' — codes go to the simulated inbox: GET /api/dev/outbox?to=<email> (never shown on forms).'
      : ''));
  // v33: idempotent schema migrations (run on every boot; no-ops once done).
  //  - room_participants.drawing_app_key: each artist's canvas choice for the
  //    battle session (set by the "Choose your canvas" step before start).
  //  - Krita is the one fully connected integration (level 3); the canvas
  //    picker derives its Connected / Coming-soon states from this column.
  try {
    await pool.query('ALTER TABLE room_participants ADD COLUMN IF NOT EXISTS drawing_app_key text');
    await pool.query(`UPDATE drawing_apps SET integration_level = 3
                        WHERE app_key = 'krita' AND integration_level < 3`);
    console.log('MIGRATE v33: canvas selection ready (room_participants.drawing_app_key, krita=level 3)');
  } catch (e) { console.error('[migrate] v33 migration failed:', e.message); }
  // v35: idempotent schema migrations (run on every boot; no-ops once done).
  //  - battle_rooms.battle_mode: the creator's mode (1v1 / 3v3 / tournament)
  //  - battle_rooms.auto_start:  matchmaking rooms start themselves once
  //    every seated artist has picked a canvas
  try {
    await pool.query(`ALTER TABLE battle_rooms ADD COLUMN IF NOT EXISTS battle_mode text NOT NULL DEFAULT '1v1'`);
    await pool.query(`ALTER TABLE battle_rooms ADD COLUMN IF NOT EXISTS auto_start boolean NOT NULL DEFAULT false`);
    console.log('MIGRATE v35: room controls ready (battle_rooms.battle_mode, auto_start) — matchmaking live');
  } catch (e) { console.error('[migrate] v35 migration failed:', e.message); }
  // v36: idempotent schema migration — private room codes + battle countdown.
  //  - battle_rooms.code: widened char(5) → varchar(12) so private rooms
  //    can use CREATOR-CHOSEN codes (4–12 A–Z0-9), not just 5-digit
  //    numbers. Existing 5-digit codes survive the conversion untouched.
  //  - battles.countdown_ends_at: the server-owned moment the 3-2-1 hits
  //    zero. The schema already had the 'countdown' status + its legal
  //    transitions; this adds the clock that keeps every client in sync.
  try {
    await pool.query(`ALTER TABLE battle_rooms ALTER COLUMN code TYPE varchar(12)`);
    await pool.query('ALTER TABLE battles ADD COLUMN IF NOT EXISTS countdown_ends_at timestamptz');
    console.log('MIGRATE v36: room codes widened (varchar 12) + battle countdown ready (battles.countdown_ends_at)');
  } catch (e) { console.error('[migrate] v36 migration failed:', e.message); }
  // v36: the "None" battle type. ALTER TYPE … ADD VALUE must run autocommit
  // (not inside BEGIN), so it is its own guarded step; IF NOT EXISTS keeps
  // reboots idempotent.
  try {
    await pool.query(`ALTER TYPE result_method ADD VALUE IF NOT EXISTS 'none'`);
    console.log("MIGRATE v36: result_method enum gained 'none' (no-voting battles)");
  } catch (e) { console.error('[migrate] v36 enum migration failed:', e.message); }
  // v44/v45 migrations — ordered, INDEPENDENTLY guarded steps.
  //
  // WHY this shape (the production incident): v44 ran all migrations in one
  // try-block whose FIRST statement was the one-active-seat unique index.
  // Production Neon held real pre-v44 data — users with several active
  // seats (legal then) and orphaned seat rows — so that index creation
  // threw, the catch swallowed it, and `ALTER TABLE battle_rooms ADD COLUMN
  // deleted_at` (statement #2) NEVER RAN. Every query referencing
  // r.deleted_at then failed ("column r.deleted_at does not exist") across
  // Rooms + matchmaking.
  //
  // The fix, in order:
  //   1. REPAIR the data first (sweep orphaned seats, then de-duplicate
  //      active seats keeping the user's most-live room) — never destroys
  //      rooms, battles or history; retired seats just become 'left'.
  //   2. Apply each schema change as its own step — one failure can never
  //      hide another again.
  //   3. VERIFY afterwards: the exact objects the runtime queries depend on
  //      are checked; the result is logged and exposed via /api/health
  //      (`schema`), so a permission/ownership problem on a managed DB is
  //      diagnosable at a glance instead of surfacing as a mystery 500.
  // `server/migrations-v45.sql` carries the same steps for manual runs.
  const MIGRATION_STEPS = [
    ['v45 sweep orphaned seats (pre-FK-schema deletes left these)',
     `DELETE FROM room_participants rp
        WHERE NOT EXISTS (SELECT 1 FROM battle_rooms r WHERE r.id = rp.room_id)`],
    ['v45 sweep orphaned spectators',
     `DELETE FROM room_spectators rs
        WHERE NOT EXISTS (SELECT 1 FROM battle_rooms r WHERE r.id = rs.room_id)`],
    ['v45 de-duplicate active seats (keep the user\'s most-live room)',
     `WITH ranked AS (
        SELECT rp.ctid AS ctid,
               row_number() OVER (
                 PARTITION BY rp.user_id
                 ORDER BY (CASE r.status WHEN 'in_battle' THEN 3 WHEN 'starting' THEN 2
                                         WHEN 'lobby' THEN 1 ELSE 0 END) DESC,
                          rp.joined_at DESC NULLS LAST,
                          r.created_at DESC NULLS LAST
               ) AS rn
          FROM room_participants rp
          LEFT JOIN battle_rooms r ON r.id = rp.room_id
         WHERE rp.state IN ('waiting','ready'))
      UPDATE room_participants SET state = 'left', left_at = now()
       WHERE ctid IN (SELECT ctid FROM ranked WHERE rn > 1)`],
    ['v44 battle_rooms.deleted_at (room archive marker)',
     `ALTER TABLE battle_rooms ADD COLUMN IF NOT EXISTS deleted_at timestamptz`],
    ['v44 battle_rooms primary key (dump shipped without PKs)',
     `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint
                        WHERE conrelid = 'battle_rooms'::regclass AND contype = 'p') THEN
          ALTER TABLE battle_rooms ADD CONSTRAINT battle_rooms_pkey PRIMARY KEY (id);
        END IF;
      END $$;`],
    ['v44 battle_rooms code lookup index',
     `CREATE INDEX IF NOT EXISTS idx_battle_rooms_code ON battle_rooms (code)`],
    ['v44 users primary key',
     `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint
                        WHERE conrelid = 'users'::regclass AND contype = 'p') THEN
          ALTER TABLE users ADD CONSTRAINT users_pkey PRIMARY KEY (id);
        END IF;
      END $$;`],
    ['v44 rematch_requests table',
     `CREATE TABLE IF NOT EXISTS rematch_requests (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          room_id uuid NOT NULL REFERENCES battle_rooms(id) ON DELETE CASCADE,
          from_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          to_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          status text NOT NULL DEFAULT 'pending',
          created_at timestamptz NOT NULL DEFAULT now(),
          responded_at timestamptz
        )`],
    ['v44 one pending rematch per room',
     `CREATE UNIQUE INDEX IF NOT EXISTS uq_rematch_pending_per_room
        ON rematch_requests (room_id) WHERE status = 'pending'`],
    ['v44 challenge dedupe (elements of duplicated challenges)',
     `DELETE FROM battle_challenge_elements bce
        USING battle_challenges bc
        WHERE bce.challenge_id = bc.id
          AND bc.ctid NOT IN (SELECT DISTINCT ON (battle_id) ctid
                                FROM battle_challenges ORDER BY battle_id, generated_at)`],
    ['v44 challenge dedupe (keep the oldest row per battle)',
     `DELETE FROM battle_challenges bc
        WHERE bc.ctid NOT IN (SELECT DISTINCT ON (battle_id) ctid
                                FROM battle_challenges ORDER BY battle_id, generated_at)`],
    ['v44 one challenge per battle (randomizer integrity)',
     `CREATE UNIQUE INDEX IF NOT EXISTS uq_one_challenge_per_battle
        ON battle_challenges (battle_id)`],
    ['v44.1 randomizer pool unique index (seed.js ON CONFLICT target)',
     `CREATE UNIQUE INDEX IF NOT EXISTS uq_randomizer_element_name
        ON randomizer_elements (category, name)`],
    ['v45 result dedupe (keep the oldest row per battle)',
     `DELETE FROM battle_results br
        WHERE br.ctid NOT IN (SELECT DISTINCT ON (battle_id) ctid
                               FROM battle_results ORDER BY battle_id, decided_at)`],
    ['v44 one result per battle (stats exactly-once insurance)',
     `CREATE UNIQUE INDEX IF NOT EXISTS uq_one_result_per_battle
        ON battle_results (battle_id)`],
    ['v44 one active seat per artist (the one-room rule)',
     `CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_seat_per_user
        ON room_participants (user_id) WHERE state IN ('waiting','ready')`],
  ];
  const migrationFailures = [];
  for (const [label, sql] of MIGRATION_STEPS) {
    try {
      const r = await pool.query(sql);
      const n = (r.command === 'UPDATE' || r.command === 'DELETE') ? ` (${r.rowCount} rows)` : '';
      console.log(`MIGRATE ${label}${n}`);
    } catch (e) {
      migrationFailures.push(label);
      console.error(`[migrate] FAILED — ${label}: ${e.message}`);
    }
  }
  // Post-migration verification: everything the runtime queries depend on.
  try {
    const v = await pool.query(`SELECT
        EXISTS(SELECT 1 FROM information_schema.columns
                WHERE table_name='battle_rooms' AND column_name='deleted_at') AS deleted_at,
        EXISTS(SELECT 1 FROM information_schema.tables
                WHERE table_name='rematch_requests') AS rematch_table,
        EXISTS(SELECT 1 FROM pg_indexes WHERE indexname='uq_one_active_seat_per_user') AS seat_guard,
        EXISTS(SELECT 1 FROM pg_indexes WHERE indexname='uq_one_challenge_per_battle') AS challenge_guard,
        EXISTS(SELECT 1 FROM pg_indexes WHERE indexname='uq_one_result_per_battle') AS result_guard,
        EXISTS(SELECT 1 FROM pg_indexes WHERE indexname='uq_randomizer_element_name') AS pool_guard`);
    const s = v.rows[0];
    schemaState = Object.entries(s).filter(([, ok]) => !ok).map(([k]) => k);
    if (schemaState.length === 0 && migrationFailures.length === 0) {
      console.log('MIGRATE v44/v45: schema verified OK (deleted_at, rematch_requests, seat/challenge/result/pool guards all present)');
    } else {
      console.error('[migrate] SCHEMA INCOMPLETE after startup — missing: ' +
        (schemaState.join(', ') || 'none') +
        (migrationFailures.length ? '; failed steps: ' + migrationFailures.join(' | ') : '') +
        '. If this is a permissions problem, run server/migrations-v45.sql as the database owner.');
    }
  } catch (e) {
    console.error('[migrate] verification query failed:', e.message);
  }
  // Phase 6: self-seed the randomizer word pool (no-op when already loaded).
  try { await ensureRandomizerSeed(); }
  catch (e) { console.error('[seed] randomizer pool seeding failed:', e.message); }
});
// Phase 5: the real-time hub (WebSocket) shares this HTTP server — no
// second port, no second process.
initRealtime(httpServer, {
  canViewRoom: rooms.canViewRoom,
  onUserDisconnect: matchmaking.handleDisconnect, // v35: drop queue rows on socket loss
});
rooms.startCountdownSweeper(); // v36: flip 'countdown' battles to 'active' on the server clock
battleEnd.startBattleEndSweeper(); // v44: complete 'active' battles when their clock runs out

process.on('SIGTERM', async () => {
  closeRealtime();
  httpServer.close();
  await pool.end();
  process.exit(0);
});
