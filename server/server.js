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
  premiumOf,
  themeCatalog,
  sanitizeTheme,
  sanitizeThemeCustom,
} = require('./lib');
const rooms = require('./rooms');
const matchmaking = require('./matchmaking');
const battleEnd = require('./battle-end');
const googleAuth = require('./google-auth');
const discordAuth = require('./discord-auth'); // v59: same architecture, Discord provider
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

// v49: public legal pages. /privacy and /terms serve the same SPA; the
// client boots straight into the matching view (no session required), so
// the pages work logged-out, get the full theme system, and share one HTML
// file with the rest of the app.
app.get(['/privacy', '/terms'], (req, res) => {
  res.set('Cache-Control', 'no-store'); // same policy as the SPA itself
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

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
app.use('/api/auth/discord', discordAuth.router);

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
// ---------------------------------------------------------------------------
// v51: NOTIFICATIONS — real history + 24 h expiry + realtime push.
//   notifyUser()       insert + WS push to every open socket of that user
//   GET  /api/notifications        the last 24 h of items (oldest first
//                                  readable order, newest first) — opening the
//                                  panel NEVER deletes anything
//   POST /api/notifications/read   mark some/all as read (they STAY listed
//                                  until they expire)
//   GET  /api/notifications/unread the live badge count
// Expiry is SERVER-AUTHORITATIVE: a sweep on every list call plus a 5 min
// timer deletes rows older than 24 h — they vanish from every device.
// ---------------------------------------------------------------------------
const rtHub = require('./realtime');
async function sweepExpiredNotifications() {
  await pool.query(`DELETE FROM notifications WHERE created_at < now() - interval '24 hours'`);
}
setInterval(() => { sweepExpiredNotifications().catch(() => {}); }, 5 * 60 * 1000).unref();

// v52: notifyUser moved to ./notify — the ONE notifier shared by the friends
// backend (here) and the room/rematch backend (rooms.js). One notification
// architecture, one persistence rule (24 h server-side TTL), one WS shape.
const { notifyUser } = require('./notify');

app.get('/api/notifications', requireAuth, ah(async (req, res) => {
  await sweepExpiredNotifications();
  const { rows } = await pool.query(
    `SELECT id, type, payload, read_at, created_at
       FROM notifications
      WHERE user_id = $1 AND created_at >= now() - interval '24 hours'
      ORDER BY created_at DESC
      LIMIT 100`,
    [req.user.id]
  );
  const { rows: unread } = await pool.query(
    `SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
    [req.user.id]
  );
  res.json({ notifications: rows, unread: unread[0].n });
}));

app.post('/api/notifications/read', requireAuth, ah(async (req, res) => {
  const id = (req.body || {}).id || null;
  if (id) {
    await pool.query(
      `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = $2 AND read_at IS NULL`,
      [req.user.id, id]
    );
  } else {
    await pool.query(
      `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`,
      [req.user.id]
    );
  }
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
    [req.user.id]
  );
  res.json({ ok: true, unread: rows[0].n });
}));

app.get('/api/notifications/unread', requireAuth, ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
    [req.user.id]
  );
  res.json({ unread: rows[0].n });
}));

// ---------------------------------------------------------------------------
// v51: PUBLIC PROFILE READING (room context menu → View Profile). LIVE data
// straight from the tables — never a cached snapshot.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// v52: PREMIUM — entitlement endpoints (TEST MODE). No payment integration:
// activation writes source='test' rows. A future Paystack webhook writes the
// SAME table with source='paystack' after verified payment — gating, badge,
// themes and re-roll read ONLY the entitlement, never the button.
// ---------------------------------------------------------------------------
const PREMIUM_TEST_MODE = process.env.PREMIUM_TEST_MODE !== '0'; // set PREMIUM_TEST_MODE=0 in production
app.get('/api/premium/status', requireAuth, ah(async (req, res) => {
  res.json({ ...(await premiumOf(req.user.id)), test_mode: PREMIUM_TEST_MODE });
}));
app.post('/api/premium/test-activate', requireAuth, ah(async (req, res) => {
  if (!PREMIUM_TEST_MODE) throw new HttpError(403, 'Test activation is disabled on this deployment.');
  // v54 (spec 3): the welcome notification is tied to the REAL transition —
  // only an account that was NOT premium becomes premium. Re-activations of
  // an already-active entitlement notify nobody (and logins never do).
  const wasActive = (await premiumOf(req.user.id)).active;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      `UPDATE premium_subscriptions SET status = 'ended', ended_at = now(), updated_at = now()
        WHERE user_id = $1 AND status = 'active'`, [req.user.id]);
    await c.query(
      `INSERT INTO premium_subscriptions (user_id, plan, status, source)
       VALUES ($1, 'premium', 'active', 'test')`, [req.user.id]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  if (!wasActive) {
    await notifyUser(req.user.id, 'premium_activated', { plan: 'premium', source: 'test' });
  }
  res.json({ ...(await premiumOf(req.user.id)), test_mode: PREMIUM_TEST_MODE });
}));
app.post('/api/premium/test-revoke', requireAuth, ah(async (req, res) => {
  if (!PREMIUM_TEST_MODE) throw new HttpError(403, 'Test revocation is disabled on this deployment.');
  await pool.query(
    `UPDATE premium_subscriptions SET status = 'revoked', ended_at = now(), updated_at = now()
      WHERE user_id = $1 AND status = 'active'`, [req.user.id]);
  // Safe fallback: a revoked account can never keep a Premium-only theme.
  await pool.query(`UPDATE users SET ui_theme = NULL WHERE id = $1`, [req.user.id]);
  res.json({ ...(await premiumOf(req.user.id)), test_mode: PREMIUM_TEST_MODE });
}));
app.get('/api/premium/themes', requireAuth, ah(async (req, res) => {
  const { rows } = await pool.query('SELECT ui_theme, ui_theme_custom FROM users WHERE id = $1', [req.user.id]);
  const ui_theme = await sanitizeTheme(req.user.id, rows[0] ? rows[0].ui_theme : null);
  res.json({
    themes: themeCatalog(),
    premium: (await premiumOf(req.user.id)).active,
    ui_theme,
    ui_custom: ui_theme ? sanitizeThemeCustom(ui_theme, rows[0] ? rows[0].ui_theme_custom : null) : null,
  });
}));
app.put('/api/premium/theme', requireAuth, ah(async (req, res) => {
  const key = String((req.body || {}).theme || '');
  const t = themeCatalog().find((x) => x.key === key);
  if (!t) throw new HttpError(400, 'Unknown theme.');
  if (t.premium) {
    const p = await premiumOf(req.user.id);
    if (!p.active) throw new HttpError(403, 'Art Arena Premium is required for that theme.');
  }
  // v53: manual colors travel with the theme (validated + entitlement-bound)
  const custom = (key !== 'default' && (req.body || {}).custom) ? sanitizeThemeCustom(key, req.body.custom) : null;
  await pool.query('UPDATE users SET ui_theme = $1, ui_theme_custom = $2 WHERE id = $3',
    [key === 'default' ? null : key, JSON.stringify(custom), req.user.id]);
  res.json({ ok: true, ui_theme: key === 'default' ? null : key, ui_custom: custom, premium: (await premiumOf(req.user.id)).active });
}));

app.get('/api/users/:id/profile', requireAuth, ah(async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, 'Invalid user id.');
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.display_name, u.created_at AS joined_at,
            p.bio, p.avatar_storage_key,
            s.battles, s.wins, s.losses, s.draws
       FROM users u
       LEFT JOIN user_profiles p ON p.user_id = u.id
       LEFT JOIN user_statistics s ON s.user_id = u.id
      WHERE u.id = $1 AND u.account_status = 'active'`,
    [id]
  );
  if (!rows[0]) throw new HttpError(404, 'That artist does not exist.');
  const r = rows[0];
  const prem = await premiumOf(r.id); // v52: badge = REAL entitlement, never a client flag
  res.json({
    user: {
      id: r.id, username: r.username, display_name: r.display_name, joined_at: r.joined_at,
      bio: r.bio || null,
      avatar_url: r.avatar_storage_key ? '/avatars/' + r.avatar_storage_key : null,
      premium: prem.active, // v52: Premium badge on View Profile
    },
    statistics: {
      battles_played: r.battles || 0, wins: r.wins || 0,
      losses: r.losses || 0, draws: r.draws || 0,
    },
  });
}));

// ---------------------------------------------------------------------------
// v51: FRIENDS — the real relationship backend (requests → friendship).
//   POST   /api/friends/request          { user_id }  send a request
//   GET    /api/friends                  friends + incoming/outgoing requests
//   POST   /api/friends/requests/:id/accept   accept (both become friends)
//   POST   /api/friends/requests/:id/decline  decline
//   DELETE /api/friends/:userId          remove a friend (or cancel MY outgoing request)
// Friend requests notify the recipient through the v51 notification engine.
// ---------------------------------------------------------------------------
const FRIEND_TYPES = ['friend_request', 'friend_accepted'];
async function areFriends(a, b) {
  const { rows } = await pool.query(
    `SELECT 1 FROM friendships
      WHERE (user_a = LEAST($1::uuid,$2::uuid) AND user_b = GREATEST($1::uuid,$2::uuid))`,
    [a, b]
  );
  return !!rows[0];
}
app.post('/api/friends/request', requireAuth, ah(async (req, res) => {
  const target = String((req.body || {}).user_id || '');
  if (!target || target === req.user.id) throw new HttpError(400, 'You cannot friend yourself.');
  const { rows: tgt } = await pool.query(
    `SELECT id, username, display_name FROM users WHERE id = $1 AND account_status = 'active'`, [target]
  );
  if (!tgt[0]) throw new HttpError(404, 'That artist does not exist.');
  if (await areFriends(req.user.id, target))
    throw new HttpError(409, 'You are already friends with ' + (tgt[0].display_name || tgt[0].username) + '.');
  const { rows: out } = await pool.query(
    `SELECT 1 FROM friend_requests
      WHERE from_user = $1 AND to_user = $2 AND status = 'pending'`, [req.user.id, target]
  );
  if (out[0]) throw new HttpError(409, 'You already have a pending friend request to this artist.');
  const { rows: inc } = await pool.query(
    `SELECT id FROM friend_requests
      WHERE from_user = $1 AND to_user = $2 AND status = 'pending'`, [target, req.user.id]
  );
  if (inc[0]) { // they asked US first — accept their request instead of a second one
    await pool.query(`UPDATE friend_requests SET status='accepted', responded_at=now() WHERE id=$1`, [inc[0].id]);
    await pool.query(
      `INSERT INTO friendships (user_a, user_b) VALUES (LEAST($1::uuid,$2::uuid), GREATEST($1::uuid,$2::uuid))`,
      [req.user.id, target]
    );
    await notifyUser(target, 'friend_accepted', { username: req.user.username, display_name: req.user.display_name });
    return res.json({ status: 'friends' });
  }
  const { rows: reqs } = await pool.query(
    `INSERT INTO friend_requests (from_user, to_user) VALUES ($1, $2) RETURNING id`,
    [req.user.id, target]
  );
  await notifyUser(target, 'friend_request', {
    request_id: reqs[0].id, username: req.user.username, display_name: req.user.display_name,
  });
  res.status(201).json({ status: 'requested' });
}));
app.get('/api/friends', requireAuth, ah(async (req, res) => {
  const [friends, incoming, outgoing] = await Promise.all([
    pool.query(
      `SELECT u.id, u.username, u.display_name, f.created_at AS since
         FROM friendships f JOIN users u ON u.id = CASE WHEN f.user_a = $1 THEN f.user_b ELSE f.user_a END
        WHERE $1 IN (f.user_a, f.user_b) ORDER BY u.display_name`, [req.user.id]),
    pool.query(
      `SELECT r.id, u.id AS user_id, u.username, u.display_name, r.created_at
         FROM friend_requests r JOIN users u ON u.id = r.from_user
        WHERE r.to_user = $1 AND r.status = 'pending' ORDER BY r.created_at DESC`, [req.user.id]),
    pool.query(
      `SELECT r.id, u.id AS user_id, u.username, u.display_name, r.created_at
         FROM friend_requests r JOIN users u ON u.id = r.to_user
        WHERE r.from_user = $1 AND r.status = 'pending' ORDER BY r.created_at DESC`, [req.user.id]),
  ]);
  res.json({ friends: friends.rows, incoming: incoming.rows, outgoing: outgoing.rows });
}));
app.post('/api/friends/requests/:id/accept', requireAuth, ah(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE friend_requests SET status = 'accepted', responded_at = now()
      WHERE id = $1 AND to_user = $2 AND status = 'pending' RETURNING from_user`,
    [String(req.params.id), req.user.id]
  );
  if (!rows[0]) throw new HttpError(409, 'That friend request is no longer pending.');
  await pool.query(
    `INSERT INTO friendships (user_a, user_b) VALUES (LEAST($1::uuid,$2::uuid), GREATEST($1::uuid,$2::uuid))`,
    [req.user.id, rows[0].from_user]
  );
  const sender = (await pool.query('SELECT username, display_name FROM users WHERE id = $1', [rows[0].from_user])).rows[0];
  await notifyUser(rows[0].from_user, 'friend_accepted', { username: req.user.username, display_name: req.user.display_name });
  res.json({ ok: true, friend: sender });
}));
app.post('/api/friends/requests/:id/decline', requireAuth, ah(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE friend_requests SET status = 'declined', responded_at = now()
      WHERE id = $1 AND to_user = $2 AND status = 'pending' RETURNING id`,
    [String(req.params.id), req.user.id]
  );
  if (!rows[0]) throw new HttpError(409, 'That friend request is no longer pending.');
  res.json({ ok: true });
}));
app.delete('/api/friends/:userId', requireAuth, ah(async (req, res) => {
  const other = String(req.params.userId);
  // remove the friendship if any…
  await pool.query(
    `DELETE FROM friendships WHERE (user_a = LEAST($1::uuid,$2::uuid) AND user_b = GREATEST($1::uuid,$2::uuid))`,
    [req.user.id, other]
  );
  // …and/or cancel MY outgoing pending request (both are "remove" from the
  // user's point of view; the other side is untouched).
  await pool.query(
    `UPDATE friend_requests SET status='cancelled', responded_at=now()
      WHERE from_user = $1 AND to_user = $2 AND status = 'pending'`,
    [req.user.id, other]
  );
  res.json({ ok: true });
}));

app.use('/api/rooms', rooms.router);
// v50: YouTube LIVE foundation (OAuth + broadcasts) + the LIVE page feed.
const youtube = require('./youtube');
app.use('/api/youtube', youtube.router);
app.get('/api/live', requireAuth, ah(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await youtube.liveData());
}));
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
  console.log('DISCORD auth: ' + (discordAuth.isConfigured()
    ? 'configured — “Continue with Discord” is live.'
    : 'not configured — Discord button stays in “coming soon” until DISCORD_CLIENT_ID + DISCORD_CLIENT_SECRET are set in server/.env.'));
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
    // v50: YouTube LIVE foundation — one YouTube connection per artist,
    // broadcasts bound to battles. Tokens live server-side ONLY.
    ['v50 youtube_connections table',
     `CREATE TABLE IF NOT EXISTS youtube_connections (
          user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          channel_id text NOT NULL,
          channel_title text NOT NULL,
          channel_thumbnail text,
          access_token text NOT NULL,
          refresh_token text,
          token_expires_at timestamptz,
          scopes text,
          status text NOT NULL DEFAULT 'active',
          connected_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )`],
    ['v50 youtube_broadcasts table',
     `CREATE TABLE IF NOT EXISTS youtube_broadcasts (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          room_id uuid REFERENCES battle_rooms(id) ON DELETE SET NULL,
          battle_id uuid REFERENCES battles(id) ON DELETE SET NULL,
          youtube_broadcast_id text NOT NULL UNIQUE,
          youtube_stream_id text,
          stream_name text,
          ingestion_address text,
          title text NOT NULL,
          privacy text NOT NULL DEFAULT 'private',
          scheduled_start timestamptz,
          watch_url text,
          last_known_status text NOT NULL DEFAULT 'scheduled',
          last_synced_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now()
        )`],
    ['v50 one broadcast per battle per artist',
     `CREATE UNIQUE INDEX IF NOT EXISTS uq_yt_broadcast_per_battle_artist
        ON youtube_broadcasts (battle_id, user_id)`],
    // v51: friends + rematch expiry + notification types.
    ['v51 friend_requests table',
     `CREATE TABLE IF NOT EXISTS friend_requests (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          from_user uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          to_user uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          status text NOT NULL DEFAULT 'pending',
          created_at timestamptz NOT NULL DEFAULT now(),
          responded_at timestamptz,
          CONSTRAINT no_self_friend CHECK (from_user <> to_user)
        )`],
    ['v51 one pending friend request per pair',
     `CREATE UNIQUE INDEX IF NOT EXISTS uq_friend_request_pending
        ON friend_requests (from_user, to_user) WHERE status = 'pending'`],
    ['v51 friendships table',
     `CREATE TABLE IF NOT EXISTS friendships (
          user_a uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          user_b uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (user_a, user_b),
          CONSTRAINT ordered_pair CHECK (user_a < user_b)
        )`],
    ['v51 notification types: friend_request',
     `ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'friend_request'`],
    ['v51 notification types: friend_accepted',
     `ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'friend_accepted'`],
    // v51 (randomizer spec): challenges are CLEAN CONCEPTS — at most two
    // words, no descriptive scene phrases (no function words, no verb /
    // participle modifiers, no -ing/-ed words). Mirrors the re-curated
    // randomizer_seed.json so existing databases match fresh installs.
    ['v51 randomizer: remove descriptive phrases (clean concepts only)',
     `DELETE FROM randomizer_elements
       WHERE array_length(string_to_array(lower(trim(name)), ' '), 1) > 2
          OR string_to_array(lower(trim(name)), ' ') && ARRAY['in','on','with','under','over','the','a','an','of','at','by','from','into','onto','and','or','his','her','their','its','while','during','as','holding','standing','sitting','wearing','carrying','riding','walking','running','flying','sad','angry','happy','lonely','terrified','shocked','surprised','bored','tired','sleepy','crying','smiling','laughing','screaming','sleeping','dancing']::text[]
          OR name ~* '\m\w+(ing|ed)\M'`],
    // ---------------- v52 ----------------
    // Premium entitlements — payments-agnostic: a future Paystack webhook
    // writes the SAME rows with source='paystack' after verified payment;
    // feature access reads only this table.
    ['v52 premium_subscriptions table',
     `CREATE TABLE IF NOT EXISTS premium_subscriptions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        plan text NOT NULL DEFAULT 'premium',
        status text NOT NULL DEFAULT 'active',
        source text NOT NULL DEFAULT 'test',
        started_at timestamptz NOT NULL DEFAULT now(),
        ended_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`],
    ['v52 one active premium subscription per user',
     `CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_premium_per_user
        ON premium_subscriptions (user_id) WHERE status = 'active'`],
    ['v52 users.ui_theme (persisted UI customization)',
     `ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_theme text`],
    ['v52 notification types: rematch_request',
     `ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'rematch_request'`],
    // v54 (spec 3): the Premium welcome notification fires ONCE per real
    // activation event (never per login/refresh — guarded at insert time).
    ['v54 notification types: premium_activated',
     `ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'premium_activated'`],
    // v52 (randomizer spec, stricter): ONE concise concept per category. The
    // pool is emptied and re-seeded at boot from the re-curated base list in
    // randomizer_seed.json (single nouns / established compounds only — the
    // adjective cross-product variants are gone at the DATA source).
    ['v52 randomizer: single-concept pool (re-seed from curated base list)',
     `DELETE FROM randomizer_elements`],
      // ---------------- v53 ----------------
    ['v53 users.ui_theme_custom (manual theme colors)',
     `ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_theme_custom jsonb`],
    // v53 (randomizer spec: broader, more open): the pool is re-seeded from
    // the v53 JSON — long-tail over-specific compounds out, broad inspiring
    // direction concepts in. One concise concept per category, as ever.
    ['v53 randomizer: broader open-concept pool (re-seed)',
     `DELETE FROM randomizer_elements`],
      // ---------------- v58 ----------------
    // v58 FIX (Rooms error): production carries a foreign key
    // matchmaking_queue.matched_room_id -> battle_rooms(id) that the shipped
    // schema dump lost (it had NO action clause → RESTRICT). Deleting a room
    // that was minted by matchmaking then failed with
    //   "update or delete on table battle_rooms violates foreign key
    //    constraint matchmaking_queue_matched_room_id_fkey".
    // The queue row is HISTORY (status matched/cancelled/expired) — it must
    // never pin a room. Recreate the constraint as ON DELETE SET NULL, so the
    // record survives (auditable) while the room can go. Idempotent: drops
    // whichever definition exists, re-adds the right one, and never touches
    // rows. (rooms.js also cancels live rows explicitly — belt and braces.)
    ['v58 matchmaking_queue.matched_room_id → ON DELETE SET NULL',
     `DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'matchmaking_queue_matched_room_id_fkey'
                      AND conrelid = 'matchmaking_queue'::regclass
                      AND confdeltype <> 'n') THEN
          ALTER TABLE matchmaking_queue DROP CONSTRAINT matchmaking_queue_matched_room_id_fkey;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint
                        WHERE conname = 'matchmaking_queue_matched_room_id_fkey'
                          AND conrelid = 'matchmaking_queue'::regclass) THEN
          -- orphans from earlier hard deletes would block the ADD; null them first
          UPDATE matchmaking_queue q SET matched_room_id = NULL
           WHERE matched_room_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM battle_rooms r WHERE r.id = q.matched_room_id);
          ALTER TABLE matchmaking_queue
            ADD CONSTRAINT matchmaking_queue_matched_room_id_fkey
            FOREIGN KEY (matched_room_id) REFERENCES battle_rooms(id) ON DELETE SET NULL;
        END IF;
      END $$;`],
    // v58 COMMUNITY VOTING: one vote per voter per battle — enforced by the
    // database, so refreshing/reopening can never double-vote.
    ['v58 battle_votes primary key',
     `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint
                        WHERE conrelid = 'battle_votes'::regclass AND contype = 'p') THEN
          ALTER TABLE battle_votes ADD CONSTRAINT battle_votes_pkey PRIMARY KEY (id);
        END IF;
      END $$;`],
    ['v58 battle_votes: one vote per voter per battle',
     `CREATE UNIQUE INDEX IF NOT EXISTS uq_battle_vote_once ON battle_votes (battle_id, voter_id)`],
    ['v58 battle_votes lookup index',
     `CREATE INDEX IF NOT EXISTS idx_battle_votes_battle ON battle_votes (battle_id)`],
    // v58: the voting window is a real timestamp on the battle row — the
    // sweeper closes it, the client counts down to it (server time).
    ['v58 battles.voting_ends_at (community voting window)',
     `ALTER TABLE battles ADD COLUMN IF NOT EXISTS voting_ends_at timestamptz`],
    ['v58 notification types: battle_result',
     `ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'battle_result'`],
    // v59: Discord joins the linked-platform enum (user_platform_accounts.platform).
    ['v59 platform_name gains discord (Sign in with Discord)',
     `ALTER TYPE public.platform_name ADD VALUE IF NOT EXISTS 'discord'`],
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
rooms.startRematchSweeper();  // v51: expire 2-minute-old rematch requests server-side
battleEnd.startBattleEndSweeper(); // v44: complete 'active' battles when their clock runs out

process.on('SIGTERM', async () => {
  closeRealtime();
  httpServer.close();
  await pool.end();
  process.exit(0);
});
