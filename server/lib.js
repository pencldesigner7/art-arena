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

// ---------------- v52: PREMIUM ENTITLEMENTS ----------------
// Payments-agnostic by design: the entitlement TABLE is the single source of
// truth. Today only the test-mode endpoints write rows (source='test'); a
// future Paystack webhook writes the SAME rows with source='paystack' after
// a verified payment — feature access, gating, badge and themes never change.
// ---------------- v53: DESIGN THEME REGISTRY ----------------
// The user-supplied design styles. Every theme is a COMPLETE visual
// system: logo (public/themes/<key>.png), accent variables, button/border
// treatments and its own animated background (themes.js). flame/glitch/
// glowing additionally expose manual color customization (solid or gradient
// + direction) persisted in users.ui_theme_custom. All strictly 2D.
const PREMIUM_THEMES = [
  { key: 'flame',    name: 'Flame',           hint: 'Fire gradients · ember background · animated buttons', premium: true,  customizable: true, c1: '#FF5A00', c2: '#FFC300' },
  { key: 'cloud',    name: 'Cloud',           hint: 'Blue sky · drifting clouds · calm and smooth', premium: true,  customizable: false },
  { key: 'glitch',   name: 'Glitch',          hint: 'Neon RGB · occasional glitch pulses', premium: true,  customizable: true, c1: '#00F0FF', c2: '#FF2BD1' },
  { key: 'graffiti', name: 'Graffiti',        hint: 'Black & white street art · raw wall', premium: true,  customizable: false },
  { key: 'stitch',   name: 'Stitch',          hint: 'Embroidery · stitched borders · handcrafted motion', premium: true,  customizable: false },
  { key: 'glowing',  name: 'Glowing',         hint: 'Green & blue glow · gradient buttons · luminous accents', premium: true,  customizable: true, c1: '#6ED4BF', c2: '#51A8D9' },
  { key: 'magazine', name: 'Magazine Cutout', hint: 'Paper collage · cutout layers · editorial', premium: true,  customizable: false },
  { key: 'pixel',    name: 'Pixelated',        hint: 'Retro pixel art · dithered sky · chunky arcade UI', premium: true, customizable: false, c1: '#E337C4', c2: '#77D5DF' },
];
const FREE_THEMES = [
  { key: 'default', name: 'Art Arena', hint: 'Light / Dark mode (built in)', premium: false },
];
function themeCatalog() { return [...FREE_THEMES, ...PREMIUM_THEMES]; }
// v53: manual color customization — {c1, c2, dir} kept only for themes that
// declare it, values strictly validated (hex colors + angle). Anything else
// is dropped server-side; the client never decides entitlement.
function sanitizeThemeCustom(themeKey, custom) {
  const t = PREMIUM_THEMES.find((x) => x.key === themeKey);
  if (!t || !t.customizable || !custom || typeof custom !== 'object') return null;
  const hex = (v) => /^#[0-9a-fA-F]{6}$/.test(String(v)) ? String(v).toUpperCase() : null;
  const c1 = hex(custom.c1) || t.c1;
  const c2 = hex(custom.c2) || t.c2;
  const dir = Number.isFinite(Number(custom.dir)) ? Math.max(0, Math.min(360, Math.round(Number(custom.dir)))) : 135;
  return { c1, c2, dir };
}

async function premiumOf(userId) {
  const { rows } = await pool.query(
    `SELECT plan, source, started_at FROM premium_subscriptions
      WHERE user_id = $1 AND status = 'active'
        AND (ended_at IS NULL OR ended_at > now())
      ORDER BY started_at DESC LIMIT 1`, [userId]);
  return rows[0]
    ? { active: true, plan: rows[0].plan, source: rows[0].source, started_at: rows[0].started_at }
    : { active: false, plan: null, source: null, started_at: null };
}
// A stored theme is only honored while entitled — a revoked Premium account
// safely falls back to the free Light/Dark system (server truth, never a
// client-side check).
async function sanitizeTheme(userId, theme) {
  if (!theme || theme === 'default') return null;
  if (!PREMIUM_THEMES.some((t) => t.key === theme)) return null; // unknown key → fallback
  const p = await premiumOf(userId);
  return p.active ? theme : null;
}

// v61: THE ONE avatar URL builder. Every payload (me, public profile,
// matchmaking brief) must produce the identical, stable, versioned URL for
// the same stored picture — before v61 three copies disagreed (one had no
// ?v=, one used updated_at), so a picture could flip between a cached and
// an uncached URL and briefly "vanish".
function avatarUrlOf(key, updatedAt) {
  if (!key) return null;
  const m = String(key).match(/-(\d{10,15})\./);
  const v = m ? m[1] : (updatedAt ? new Date(updatedAt).getTime() : 0);
  return '/avatars/' + key + '?v=' + v;
}

async function fullUser(u) {
  const { rows } = await pool.query(
    `SELECT p.bio, p.country_code, p.drawing_app_key, p.is_discoverable,
            p.avatar_storage_key, p.updated_at,
            da.display_name AS drawing_app_name,
            s.battles, s.wins, s.losses, s.draws, s.win_streak, s.best_streak, s.rating,
            u.ui_theme, u.ui_theme_custom,
            ps.plan AS premium_plan, ps.source AS premium_source, ps.started_at AS premium_started_at
       FROM user_profiles p
       JOIN user_statistics s ON s.user_id = p.user_id
       JOIN users u ON u.id = p.user_id
       LEFT JOIN drawing_apps da ON da.app_key = p.drawing_app_key
       LEFT JOIN premium_subscriptions ps
              ON ps.user_id = p.user_id AND ps.status = 'active'
             AND (ps.ended_at IS NULL OR ps.ended_at > now())
      WHERE p.user_id = $1`,
    [u.id]
  );
  const p = rows[0] || {};
  // v52: entitlement + sanitized theme travel with the session user — the
  // badge, theme application and re-roll gating all read THIS (server truth).
  const premium = { active: !!p.premium_plan, plan: p.premium_plan || null, source: p.premium_source || null, started_at: p.premium_started_at || null };
  const ui_theme = (p.ui_theme && p.ui_theme !== 'default' && PREMIUM_THEMES.some((t) => t.key === p.ui_theme) && premium.active) ? p.ui_theme : null;
  const ui_custom = ui_theme ? sanitizeThemeCustom(ui_theme, p.ui_theme_custom) : null;
  return {
    user: authUserPayload(u),
    premium,
    ui_theme,
    ui_custom,
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
      avatar_url: avatarUrlOf(p.avatar_storage_key, p.updated_at),
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
  avatarUrlOf,
  PREMIUM_THEMES,
  themeCatalog,
  sanitizeThemeCustom,
  premiumOf,
  sanitizeTheme,
  cookieOpts,
};
