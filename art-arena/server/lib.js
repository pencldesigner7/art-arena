'use strict';
/**
 * ============================================================================
 *  ART ARENA™ — shared server infrastructure
 * ============================================================================
 *  DB pool + session authentication, shared by server.js and the feature
 *  routers (rooms.js, and the battle engine when it lands). Feature routers
 *  protect their routes with requireAuth and never re-implement session
 *  logic — there is exactly one definition of "who is logged in".
 *
 *  Session channels (checked in order):
 *    1. Authorization: Bearer <token>
 *    2. arena_session cookie (HttpOnly, set at login)
 *    3. ?arena_token=<token>  (embedded-preview fallback — the only channel
 *       proven to survive the preview proxy chain; masked in all logs)
 * ============================================================================
 */
const crypto = require('crypto');
const { Pool } = require('pg');

const DEV = (process.env.NODE_ENV || 'development') !== 'production';
const SESSION_TTL_DAYS = 30;   // session persistence window
const COOKIE_NAME = 'arena_session';

// DB connection: a full connection string (DATABASE_URL — e.g. Neon) takes
// precedence; otherwise fall back to the individual PG* variables (sandbox).
// Backward compatible: behaviour is unchanged when DATABASE_URL is not set.
const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, max: 10 }
    : {
        host: process.env.PGHOST || '127.0.0.1',
        port: Number(process.env.PGPORT || 5432),
        database: process.env.PGDATABASE || 'art_arena',
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        max: 10,
      }
);

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Wrap async handlers so rejections reach the error middleware.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Mask session tokens out of logged URLs (the token can ride in the query
// string as a fallback channel, so it must never appear in logs verbatim).
const maskToken = (url) => String(url).replace(/(arena_token=)[^&]+/g, '$1***');

function sessionTokenFromRequest(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  const cookie = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (cookie) return cookie;
  const q = req.query && req.query.arena_token;
  if (typeof q === 'string' && q) return q;
  return null;
}

// Resolve "who is logged in" for any request-like object → session user row
// or null. This is the single session lookup, shared by requireAuth (REST)
// and the realtime hub (Phase 5), which passes a pseudo request
// { headers, query, originalUrl } built from the WebSocket upgrade.
async function sessionUser(req) {
  const raw = sessionTokenFromRequest(req);
  if (!raw) return null;
  const { rows } = await pool.query(
    `SELECT s.id AS session_id,
            u.id, u.username, u.email, u.display_name, u.account_status,
            u.two_factor_enabled, u.last_login_at, u.email_verified_at,
            u.created_at AS joined_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()`,
    [sha256(raw)]
  );
  return rows[0] || null;
}

async function requireAuth(req, res, next) {
  try {
    const raw = sessionTokenFromRequest(req);
    if (!raw) {
      if (DEV) console.log(`  ! auth rejected ${maskToken(req.originalUrl)}: no session token sent by client (checked header, cookie, ?arena_token)`);
      throw new HttpError(401, 'Not authenticated.');
    }
    const row = await sessionUser(req);
    if (!row) {
      if (DEV) console.log(`  ! auth rejected ${maskToken(req.originalUrl)}: token not found / revoked / expired`);
      throw new HttpError(401, 'Not authenticated.');
    }
    if (row.account_status !== 'active') {
      const msg = { suspended: 'This account is suspended.', banned: 'This account has been banned.', deactivated: 'This account is deactivated.' };
      throw new HttpError(403, msg[row.account_status] || 'This account cannot sign in.');
    }
    req.sessionId = row.session_id;
    req.user = row;
    next();
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Auth user payload — the single definition of "what the client sees" for a
// signed-in user (user + profile + competitive stats). Used by password
// login, /me, and Google sign-in, so every entry path hands the client the
// exact same shape.
// ---------------------------------------------------------------------------
function authUserPayload(u) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    display_name: u.display_name,
    email_verified: u.email_verified_at != null,
    email_verified_at: u.email_verified_at,
    two_factor_enabled: u.two_factor_enabled,
    last_login_at: u.last_login_at,
    joined_at: u.joined_at || u.created_at,
  };
}

async function fullUser(u) {
  const { rows } = await pool.query(
    `SELECT p.bio, p.country_code, p.drawing_app_key, p.is_discoverable,
            p.avatar_storage_key, p.updated_at,
            da.display_name AS drawing_app_name,
            s.battles, s.wins, s.losses, s.draws, s.win_streak, s.best_streak, s.rating
       FROM user_profiles p
       JOIN user_statistics s ON s.user_id = p.user_id
       LEFT JOIN drawing_apps da ON da.app_key = p.drawing_app_key
      WHERE p.user_id = $1`,
    [u.id]
  );
  const p = rows[0] || {};
  return {
    user: authUserPayload(u),
    profile: {
      bio: p.bio || '',
      country_code: p.country_code || null,
      drawing_app_key: p.drawing_app_key || null,
      drawing_app_name: p.drawing_app_name || null,
      is_discoverable: p.is_discoverable !== false,
      // Profile picture: the storage key maps 1:1 to a served file at
      // /avatars/<key> (see the avatar routes in server.js). v36: uploads
      // are IMMUTABLE — the key embeds the upload epoch
      // (<user-uuid>-<epochMs>.<ext>) — so the ?v= cache-buster is derived
      // from that epoch: EVERY payload (me, opponents, matchmaking, drawer)
      // returns the SAME stable URL for the bytes on disk, and a refresh /
      // navigation / logout-login can never surface a stale cached image.
      // Legacy keys (<uuid>.<ext>) fall back to the profile updated_at.
      avatar_url: p.avatar_storage_key
        ? '/avatars/' + p.avatar_storage_key + '?v=' + (function (k, ua) {
            const m = k.match(/-(\d{10,15})\./);
            return m ? m[1] : (ua ? new Date(ua).getTime() : 0);
          })(p.avatar_storage_key, p.updated_at)
        : null,
    },
    stats: {
      battles: p.battles || 0,
      wins: p.wins || 0,
      losses: p.losses || 0,
      draws: p.draws || 0,
      win_streak: p.win_streak || 0,
      best_streak: p.best_streak || 0,
      rating: p.rating == null ? 1000 : Number(p.rating),
    },
  };
}

// Session cookie options (shared by password login and Google sign-in).
function cookieOpts() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_DAYS * 86400 * 1000,
  };
}

module.exports = {
  pool,
  DEV,
  SESSION_TTL_DAYS,
  COOKIE_NAME,
  sha256,
  HttpError,
  ah,
  parseCookies,
  maskToken,
  sessionTokenFromRequest,
  sessionUser,
  requireAuth,
  authUserPayload,
  fullUser,
  cookieOpts,
};
