'use strict';
/**
 * ============================================================================
 *  ART ARENA™ — GOOGLE SIGN-IN (production Google OAuth 2.0)
 * ============================================================================
 *  Real OAuth 2.0 Authorization Code flow with PKCE (S256) — the flow Google
 *  has required for all OAuth clients since March 2025. No mock, no SDK, no
 *  separate auth framework: it is built directly on the existing Art Arena
 *  authentication architecture (same as password login):
 *
 *    - sign-in reuses the SAME server-side `sessions` table (SHA-256 token
 *      hash, 30-day TTL, revocable) and the same cookie as /api/auth/login,
 *    - brand-new Google accounts are created with the SAME transactional
 *      recipe as /api/auth/register (users + user_profiles + user_statistics
 *      in one transaction — it all happens or nothing does),
 *    - the redirect-home token reuses the existing `auth_tokens` table
 *      (purpose 'oauth_handoff': stored ONLY as a SHA-256 hash, single-use,
 *      5-minute TTL) — exactly like the other one-time codes.
 *
 *  FLOW
 *    1. GET  /api/auth/google          302 → Google consent screen
 *                                       (state + PKCE verifier kept server-side)
 *    2. GET  /api/auth/google/callback validate state (single-use) → exchange
 *                                       code for tokens WITH the client secret
 *                                       (server-side only) → fetch profile →
 *                                       resolve / create / link the Art Arena
 *                                       user → mint a normal Art Arena session
 *                                       → 302 → /#aa-google=ok&h=<one-time>
 *    3. POST /api/auth/google/complete the SPA exchanges the one-time token
 *                                       (from the URL hash — it never rides
 *                                       the query string, never hits the
 *                                       server, never appears in logs) for
 *                                       the real session: the same fullUser()
 *                                       payload + session_token as login.
 *
 *  ACCOUNT INTEGRITY (no duplicates, ever)
 *    - One Google account can be live-linked to exactly ONE Art Arena user
 *      (partial unique index uq_platform_account_active); login looks the
 *      link up FIRST.
 *    - A Google-verified email that matches an existing Art Arena account
 *      LINKS the Google account to that user instead of creating a second
 *      account.
 *    - Google accounts get an unusable random password hash: they can never
 *      be signed into with a password, only via Google.
 *
 *  SECURITY
 *    - GOOGLE_CLIENT_SECRET lives ONLY in process.env (server/.env). It is
 *      never written to the DB, never sent to the browser, never part of any
 *      API response, and never logged (the request logger already masks
 *      arena_token; this module logs no credentials at all).
 *    - The browser only ever talks to OUR routes (/api/auth/google/*); the
 *      consent URL is assembled server-side.
 *    - PKCE (S256) + single-use state (CSRF): a captured auth code is
 *      useless without the server-held verifier, and replayed states die.
 *    - Failure/cancellation at any step redirects home with
 *      #aa-google=error&reason=… and the UI explains it gracefully.
 *
 *  ENVIRONMENT (server/.env — entered via the platform's secrets system):
 *    GOOGLE_CLIENT_ID       OAuth Client ID (Web application)
 *    GOOGLE_CLIENT_SECRET   OAuth Client Secret (NEVER in code or the browser)
 *    GOOGLE_REDIRECT_URI    optional — pins one redirect URI; by default the
 *                           URI is derived from the incoming Host header so
 *                           the SAME code serves the dev sandbox AND
 *                           https://arena.ai. (Add each host you use to
 *                           Google Cloud → Authorized redirect URIs.)
 * ============================================================================
 */
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const {
  pool, DEV, SESSION_TTL_DAYS, COOKIE_NAME,
  sha256, HttpError, ah, fullUser, cookieOpts,
} = require('./lib');

const router = express.Router();

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const SCOPES = ['openid', 'profile', 'email'];
const FLOW_TTL_MS = 10 * 60 * 1000;  // in-flight state + PKCE verifier
const HANDOFF_TTL_MIN = 5;           // one-time redirect-home token
const BCRYPT_ROUNDS = 12;

// ---------------------------------------------------------------------------
// Config (read per-request so a .env change is picked up on restart without
// any module-level freezing; nothing sensitive is ever returned to clients)
// ---------------------------------------------------------------------------
const googleEnv = () => ({
  clientId: (process.env.GOOGLE_CLIENT_ID || '').trim(),
  clientSecret: (process.env.GOOGLE_CLIENT_SECRET || '').trim(),
});
const isConfigured = () => { const e = googleEnv(); return !!(e.clientId && e.clientSecret); };

// ---------------------------------------------------------------------------
// Host handling: one codebase, any deployment host. The redirect URI is
// derived from the incoming Host (arena.ai in production, the sandbox
// preview host in dev) unless GOOGLE_REDIRECT_URI pins it explicitly.
// ---------------------------------------------------------------------------
const isLoopback = (host) => /^localhost([:/].*)?$|^127\./.test(String(host || ''));
const protoFor = (req) => (DEV && isLoopback(req.headers.host) ? 'http' : 'https');

function redirectUriFor(req) {
  const explicit = (process.env.GOOGLE_REDIRECT_URI || '').trim();
  if (explicit) return explicit;
  const host = String(req.headers.host || '');
  return `${protoFor(req)}://${host}/api/auth/google/callback`;
}

// The SPA lives on this same origin (this server serves the frontend).
function frontUrl(req, hash) {
  const host = String(req.headers.host || 'localhost');
  return `${protoFor(req)}://${host}/` + (hash ? `#${hash}` : '');
}

// Failure taxonomy — the client maps `reason` to a friendly message.
function failRedirect(req, res, reason) {
  console.log(`[google] sign-in failed: ${reason}`);
  res.redirect(frontUrl(req, `aa-google=error&reason=${encodeURIComponent(reason)}`));
}

// ---------------------------------------------------------------------------
// In-flight OAuth flows: state -> { verifier, createdAt }. Memory is the
// right store: entries live < 10 minutes, are single-use, and a restart
// mid-flow just means "try again" (the state probe fails gracefully).
// ---------------------------------------------------------------------------
const flows = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of flows) if (now - v.createdAt > FLOW_TTL_MS) flows.delete(k);
}, 60 * 1000).unref();

const newOpaque = (bytes) => crypto.randomBytes(bytes).toString('base64url');
const b64url = (buf) => buf.toString('base64url');

// ---------------------------------------------------------------------------
// Route: availability probe. The UI shows the REAL Google button only when
// this server actually has Google credentials — deployments without them
// keep the honest "coming soon" state. No mock login, ever.
// ---------------------------------------------------------------------------
router.get('/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ available: isConfigured() });
});

// ---------------------------------------------------------------------------
// Route: STEP 1 — send the user to Google's consent screen.
// ---------------------------------------------------------------------------
router.get('/', ah(async (req, res) => {
  const e = googleEnv();
  if (!e.clientId || !e.clientSecret)
    throw new HttpError(503, 'Google sign-in is not configured.');

  const verifier = newOpaque(48);
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = newOpaque(24);
  flows.set(state, { verifier, createdAt: Date.now() });

  const p = new URLSearchParams({
    client_id: e.clientId,
    redirect_uri: redirectUriFor(req),
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'online',
  });
  res.redirect(`${GOOGLE_AUTH_URL}?${p.toString()}`);
}));

// ---------------------------------------------------------------------------
// User resolution: link an existing user, or create a fresh one.
// Returns { user: <users row for the payload>, created: boolean }.
// ---------------------------------------------------------------------------
const USER_COLS = `id, username, email, display_name, account_status,
          two_factor_enabled, last_login_at, email_verified_at,
          created_at AS joined_at`;

async function userRowById(client, id) {
  const { rows } = await client.query(
    `SELECT ${USER_COLS} FROM users WHERE id = $1`, [id]
  );
  return rows[0] || null;
}

async function linkedUserIdBySub(client, sub) {
  const { rows } = await client.query(
    `SELECT u.id
       FROM user_platform_accounts p
       JOIN users u ON u.id = p.user_id
      WHERE p.platform = 'google' AND p.external_user_id = $1
        AND p.disconnected_at IS NULL`,
    [sub]
  );
  return rows[0] ? rows[0].id : null;
}

async function resolveGoogleUser(info) {
  const sub = String(info.sub);
  const email = String(info.email).trim().toLowerCase();
  const displayName = String(info.name || '').trim() || null;
  const verified = info.email_verified === true;

  // 1) Already linked to an Art Arena user? Sign them in as that user.
  {
    const client = await pool.connect();
    try {
      const uid = await linkedUserIdBySub(client, sub);
      if (uid) return { user: await userRowById(client, uid), created: false };
    } finally { client.release(); }
  }

  // 2) Verified email matches an existing account → LINK, don't duplicate.
  if (verified) {
    const byEmail = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
    if (byEmail.rows[0]) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO user_platform_accounts
             (user_id, platform, external_user_id, external_email, display_name)
           VALUES ($1, 'google', $2, $3, $4)`,
          [byEmail.rows[0].id, sub, email, displayName]
        );
        await client.query('COMMIT');
        return { user: await userRowById(client, byEmail.rows[0].id), created: false };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (err && err.code === '23505') {
          // A concurrent sign-in linked the same Google account first —
          // race lost cleanly; use the winner's user.
          const uid = await linkedUserIdBySub(client, sub);
          if (uid) return { user: await userRowById(client, uid), created: false };
        }
        throw err;
      } finally { client.release(); }
    }
  }

  // 3) Brand-new Art Arena user — the registration transaction recipe.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Username from the Google email's local part; suffix on collision.
    const base =
      String((email.split('@')[0] || '')).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 16)
      || 'artist';
    let uname = base.length >= 3 ? base : 'artist';
    for (let i = 0; ; i += 1) {
      const cand = i === 0 ? uname : uname + String(Math.floor(1000 + Math.random() * 9000));
      const clash = await client.query(
        `SELECT 1 FROM users WHERE username = $1 OR email = $2`, [cand, email]
      );
      if (!clash.rows[0]) { uname = cand; break; }
      if (i >= 50) throw new HttpError(409, 'Could not allocate a username for this Google account.');
    }

    // users.password_hash is NOT NULL + non-empty by schema. A Google
    // account gets a random, unknowable hash: password login is impossible,
    // Google login is the only door (and "Forgot password" stays the path
    // for setting a password later, if ever wanted).
    const unusableHash = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), BCRYPT_ROUNDS);

    const inserted = await client.query(
      `INSERT INTO users (username, email, password_hash, display_name, email_verified_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${USER_COLS}`,
      [uname, email, unusableHash, displayName || uname, verified ? new Date() : null]
    );
    // Profile + competitive record exist from day one (same as register).
    await client.query(
      `INSERT INTO user_profiles (user_id, is_discoverable) VALUES ($1, true)`,
      [inserted.rows[0].id]
    );
    await client.query(`INSERT INTO user_statistics (user_id) VALUES ($1)`, [inserted.rows[0].id]);
    await client.query(
      `INSERT INTO user_platform_accounts
         (user_id, platform, external_user_id, external_email, display_name)
       VALUES ($1, 'google', $2, $3, $4)`,
      [inserted.rows[0].id, sub, email, displayName]
    );
    await client.query('COMMIT');
    return { user: inserted.rows[0], created: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err && err.code === '23505') {
      // Email collision (unverified Google email matching an existing user)
      // or a concurrent create — surface it as a graceful failure.
      const uid = await linkedUserIdBySub(client, sub);
      if (uid) return { user: await userRowById(client, uid), created: false };
      throw new HttpError(409, 'This Google email already has an Art Arena account — sign in with email + password.');
    }
    throw err;
  } finally { client.release(); }
}

// ---------------------------------------------------------------------------
// Route: STEP 2 — Google bounces back here. Server-side code exchange
// (client secret + PKCE verifier), profile fetch, user resolution, session
// minting — then 302 home with the one-time token in the URL HASH.
// ---------------------------------------------------------------------------
router.get('/callback', ah(async (req, res) => {
  const e = googleEnv();
  if (!e.clientId || !e.clientSecret)
    throw new HttpError(503, 'Google sign-in is not configured.');

  const { code, state, error } = req.query;
  // Denied / closed the consent screen (Google may send error=access_denied
  // or simply no code).
  if (error || !code) return failRedirect(req, res, 'cancelled');

  const stateKey = String(state || '');
  const flow = flows.get(stateKey);
  if (!flow) return failRedirect(req, res, 'bad_state');
  flows.delete(stateKey); // single-use — a replayed state is dead

  let tokens;
  try {
    const r = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code),
        client_id: e.clientId,
        client_secret: e.clientSecret, // server-side ONLY — never logged
        redirect_uri: redirectUriFor(req),
        grant_type: 'authorization_code',
        code_verifier: flow.verifier,
      }),
    });
    tokens = await r.json().catch(() => ({}));
    if (!r.ok || !tokens.access_token)
      throw new Error(tokens.error_description || tokens.error || 'token exchange failed');
  } catch (err) {
    // err.message may contain Google's response — sanitize before logging.
    console.error('[google] token exchange failed:', String(err.message).replace(/client_secret[=\s]*\S+/g, 'client_secret=***'));
    return failRedirect(req, res, /fetch failed|EAI_AGAIN|ENOTFOUND|ECONN/.test(String(err.message)) ? 'network' : 'token');
  }

  let info;
  try {
    const r = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    info = await r.json().catch(() => ({}));
    if (!r.ok || !info.sub) throw new Error('incomplete profile');
  } catch (_) {
    return failRedirect(req, res, 'profile');
  }
  if (!info.email) return failRedirect(req, res, 'profile');

  let resolved;
  try {
    resolved = await resolveGoogleUser(info);
  } catch (err) {
    if (err instanceof HttpError) return failRedirect(req, res, err.status === 409 ? 'email_taken' : 'other');
    throw err;
  }
  const user = resolved.user;
  if (!user) return failRedirect(req, res, 'other');
  if (user.account_status !== 'active') return failRedirect(req, res, 'account_locked');

  // Mint a session exactly like password login (same table, same TTL,
  // same cookie). The token then doubles as the one-time handoff token.
  const token = newOpaque(32);
  const ua = String(req.get('user-agent') || '').slice(0, 255) || null;
  await pool.query(
    `INSERT INTO sessions (user_id, token_hash, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4::inet, now() + ($5 || ' days')::interval)`,
    [user.id, sha256(token), ua, req.ip || null, SESSION_TTL_DAYS]
  );
  await pool.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
  await pool.query(
    `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at)
     VALUES ($1, 'oauth_handoff', $2, now() + ($3 || ' minutes')::interval)`,
    [user.id, sha256(token), HANDOFF_TTL_MIN]
  );

  console.log(`[google] sign-in OK: @${user.username}${resolved.created ? ' (new account)' : ''}`);
  res.cookie(COOKIE_NAME, token, cookieOpts());
  // The one-time token rides the URL HASH: it never enters the query string,
  // is never sent to any server as a URL, and never appears in logs.
  res.redirect(frontUrl(req, `aa-google=ok&h=${token}`));
}));

// ---------------------------------------------------------------------------
// Route: STEP 3 — the SPA exchanges the one-time token (from the hash) for
// the real session. Single-use + 5-minute TTL: replays get a clean 400 and
// the UI tells the user to sign in again.
// ---------------------------------------------------------------------------
router.post('/complete', ah(async (req, res) => {
  const handoff = (req.body && req.body.handoff) || '';
  if (!handoff || typeof handoff !== 'string' || handoff.length > 256)
    throw new HttpError(400, 'This sign-in link has expired — please sign in with Google again.');

  const t = await pool.query(
    `SELECT id, user_id FROM auth_tokens
      WHERE token_hash = $1
        AND purpose = 'oauth_handoff'
        AND used_at IS NULL
        AND expires_at > now()`,
    [sha256(handoff)]
  );
  if (!t.rows[0])
    throw new HttpError(400, 'This sign-in link has expired — please sign in with Google again.');

  // Claim it (single-use, even under a race).
  const claim = await pool.query(
    `UPDATE auth_tokens SET used_at = now()
      WHERE id = $1 AND used_at IS NULL
      RETURNING id`,
    [t.rows[0].id]
  );
  if (!claim.rows[0])
    throw new HttpError(400, 'This sign-in link has already been used — please sign in with Google again.');

  // The handoff token IS the session token minted in the callback —
  // confirm that session is still alive, then hand it to the client
  // exactly like a login response (fullUser payload + session_token).
  const s = await pool.query(
    `SELECT u.id, u.username, u.email, u.display_name, u.account_status,
            u.two_factor_enabled, u.last_login_at, u.email_verified_at,
            u.created_at AS joined_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()`,
    [sha256(handoff)]
  );
  if (!s.rows[0])
    throw new HttpError(400, 'This sign-in link has expired — please sign in with Google again.');
  const u = s.rows[0];
  if (u.account_status !== 'active')
    throw new HttpError(403, { suspended: 'This account is suspended.', banned: 'This account has been banned.', deactivated: 'This account is deactivated.' }[u.account_status] || 'This account cannot sign in.');

  res.cookie(COOKIE_NAME, handoff, cookieOpts());
  const out = await fullUser(u);
  out.session_token = handoff;
  res.json(out);
}));

router.moduleInfo = { isConfigured };
module.exports = { router, isConfigured };
