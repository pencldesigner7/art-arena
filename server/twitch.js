'use strict';
/**
 * ============================================================================
 *  ART ARENA™ — TWITCH GO LIVE FOUNDATION (v62)                    server/twitch.js
 * ============================================================================
 *  REAL Twitch integration architecture for livestreaming an Art Arena
 *  battle, modeled on the v50 YouTube module (same shapes, same security
 *  rules). What this module REALLY does (no fakes):
 *
 *    - OAuth 2.0 authorization-code flow with single-use state, attaching
 *      the connected Twitch account to the CURRENTLY LOGGED-IN Art Arena
 *      account (like YouTube v50 — it NEVER creates or switches accounts;
 *      it is a connection, not a sign-in).
 *    - Twitch identity via Helix (GET /helix/users).
 *    - Stream metadata (title) set on the broadcaster's channel via
 *      PATCH /helix/channels (scope: channel:manage:broadcast) at
 *      prepare-time — the minimum permission that lets Art Arena stage a
 *      real stream.
 *    - Art Arena "stream sessions" (twitch_stream_sessions): preparing →
 *      live → ended. A session is NEVER marked live by our own actions:
 *      it only becomes live when TWITCH CONFIRMS the broadcaster is
 *      genuinely streaming (EventSub stream.online / Helix Get Streams).
 *    - LIVE detection through Twitch EventSub webhooks (stream.online +
 *      stream.offline, signature-verified, replay-safe, idempotent) with a
 *      polling sweeper (Helix Get Streams with an app access token) as the
 *      always-on fallback when EventSub is not configured / unreachable.
 *    - Live/offline state changes push room events over the EXISTING
 *      WebSocket hub (rt.emitRoom) so rooms update without a refresh, and
 *      the LIVE page only ever lists battles Twitch confirms as live.
 *
 *  What it deliberately does NOT do (honesty, same as v50):
 *    - No video ingestion or broadcasting from Art Arena. Twitch handles
 *      the actual video; Art Arena tracks and verifies. The broadcaster
 *      streams from their own streaming software (OBS etc.).
 *    - No fake live states, no mock connections, ever.
 *
 *  SECURITY (mirrors google-auth / discord-auth / youtube rules):
 *    - TWITCH_CLIENT_SECRET lives only in process.env — never in responses.
 *    - Access/refresh tokens are stored SERVER-SIDE in twitch_connections
 *      and never returned to the browser (only broadcaster identity +
 *      session statuses are).
 *    - OAuth state is single-use with a 10-minute TTL; the authorization
 *      code is exchanged server-side.
 *    - EventSub webhooks are verified with HMAC-SHA256 signatures over
 *      (message-id + timestamp + raw body) using TWITCH_EVENTSECRET,
 *      timestamps older than 10 minutes are rejected (replay protection),
 *      and duplicate events are safe (DB-guarded transitions).
 *
 *  ENVIRONMENT
 *    TWITCH_CLIENT_ID        OAuth Client ID (Twitch Developer portal)
 *    TWITCH_CLIENT_SECRET    OAuth Client Secret (server-only)
 *    TWITCH_REDIRECT_URI     e.g. https://art-arena-galt.onrender.com/api/twitch/callback
 *                            (default: derived from the request host)
 *    TWITCH_EVENTSECRET      (optional) EventSub webhook signing secret —
 *                            enables push live/offline detection. Without
 *                            it the polling sweeper still verifies states.
 *
 *  Missing credentials → every OAuth/session endpoint fails clearly with
 *  setup instructions; /status reports available:false so the UI shows the
 *  honest setup state. No mock connections, ever.
 * ============================================================================
 */
const crypto = require('crypto');
const express = require('express');
const { pool, DEV, HttpError, ah, requireAuth } = require('./lib');
const rt = require('./realtime'); // v62: the EXISTING hub — never a parallel one

const router = express.Router();

const TWITCH_AUTH_URL = 'https://id.twitch.tv/oauth2/authorize';
const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const TWITCH_REVOKE_URL = 'https://id.twitch.tv/oauth2/revoke';
const HELIX_BASE = 'https://api.twitch.tv/helix';
// The ONLY scope Art Arena asks for. channel:manage:broadcast is required
// to stage the stream title on the broadcaster's channel (PATCH
// /helix/channels). Live detection (Get Streams) and EventSub subscription
// creation use an APP access token (client-credentials) — no user scope.
const SCOPE = 'channel:manage:broadcast';
const FLOW_TTL_MS = 10 * 60 * 1000;   // in-flight OAuth state lifetime
const EVENTSECRET_REPLAY_MS = 10 * 60 * 1000; // Twitch replay window (official guidance)
const SWEEP_MS = 45 * 1000;           // fallback live-state poll cadence
const PREPARE_EXPIRE_H = 3;           // preparing sessions expire after 3 h
const OFFLINE_CONFIRM_POLLS = 2;      // consecutive offline polls before ending

// ---------------------------------------------------------------------------
// Config — read per-request (a .env change is picked up on restart).
// ---------------------------------------------------------------------------
const twEnv = () => ({
  clientId: (process.env.TWITCH_CLIENT_ID || '').trim(),
  clientSecret: (process.env.TWITCH_CLIENT_SECRET || '').trim(),
  redirectUri: (process.env.TWITCH_REDIRECT_URI || '').trim(),
  eventSecret: (process.env.TWITCH_EVENTSECRET || '').trim(),
});
const isConfigured = () => {
  const e = twEnv();
  return !!(e.clientId && e.clientSecret);
};
const eventSubReady = () => {
  const e = twEnv();
  return !!(e.clientId && e.clientSecret && e.eventSecret);
};

const isLoopback = (host) => /^localhost([:/].*)?$|^127\./.test(String(host || ''));
const protoFor = (req) => (DEV && isLoopback(req.headers.host) ? 'http' : 'https');

function redirectUriFor(req) {
  const explicit = twEnv().redirectUri;
  if (explicit) return explicit;
  const host = String(req.headers.host || '');
  return `${protoFor(req)}://${host}/api/twitch/callback`;
}
function frontUrl(req, hash) {
  const host = String(req.headers.host || 'localhost');
  return `${protoFor(req)}://${host}/` + (hash ? `#${hash}` : '');
}
function failRedirect(req, res, reason) {
  console.log(`[twitch] connect failed: ${reason}`);
  res.redirect(frontUrl(req, `aa-twitch=error&reason=${encodeURIComponent(reason)}`));
}
function safeReturnTo(raw) {
  const s = String(raw || '');
  if (/^\/(?!\/)[A-Za-z0-9\-._~!$&'()*+,;=:@/?%]*$/.test(s)) return s;
  return null;
}

// ---------------------------------------------------------------------------
// In-flight OAuth flows: state -> { userId, returnTo, createdAt }.
// Single-use, < 10 min, memory store (a restart mid-flow = "try again").
// userId is bound at /connect time so the callback can never attach a Twitch
// account to anyone but the user who started the flow.
// ---------------------------------------------------------------------------
const flows = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of flows) if (now - v.createdAt > FLOW_TTL_MS) flows.delete(k);
}, 60 * 1000).unref();

const newOpaque = (bytes) => crypto.randomBytes(bytes).toString('base64url');

const SETUP_HINT = 'Twitch is not configured on this deployment yet. Set TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET and TWITCH_REDIRECT_URI (see the v62 report: Twitch Developer Portal app + Render environment variables).';
function requireConfigured() {
  if (!isConfigured()) throw new HttpError(503, SETUP_HINT);
  return twEnv();
}

// ---------------------------------------------------------------------------
// Token helpers (server-side only — tokens never leave this process).
// ---------------------------------------------------------------------------
async function exchangeCode(env, code, redirectUri) {
  const r = await fetch(TWITCH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.clientId,
      client_secret: env.clientSecret,
      code: String(code),
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });
  const tokens = await r.json().catch(() => ({}));
  if (!r.ok || !tokens.access_token) {
    throw new Error(tokens.message || tokens.error || 'token exchange failed');
  }
  return tokens;
}

async function refreshAccessToken(env, refreshToken) {
  const r = await fetch(TWITCH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.clientId,
      client_secret: env.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) return { error: t.message || t.error || 'refresh_failed' };
  return { accessToken: t.access_token, refreshToken: t.refresh_token || null, expiresIn: t.expires_in || 3600 };
}

// App access token (client-credentials) — used for Get Streams polling and
// EventSub subscription management. Cached in-process; re-fetched when close
// to expiry. NEVER exposed to the browser.
let appTokenCache = { token: null, expiresAt: 0 };
async function appAccessToken(env) {
  if (appTokenCache.token && Date.now() < appTokenCache.expiresAt - 5 * 60 * 1000) {
    return appTokenCache.token;
  }
  const r = await fetch(TWITCH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.clientId,
      client_secret: env.clientSecret,
      grant_type: 'client_credentials',
    }),
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) {
    throw new Error('Could not get a Twitch app token: ' + (t.message || t.error || `HTTP ${r.status}`));
  }
  appTokenCache = { token: t.access_token, expiresAt: Date.now() + (t.expires_in || 3600) * 1000 };
  return appTokenCache.token;
}

// ---------------------------------------------------------------------------
// Connection persistence (mirror of youtube_connections).
// ---------------------------------------------------------------------------
async function getConnection(userId) {
  const { rows } = await pool.query(
    `SELECT user_id, twitch_user_id, login, display_name, profile_image_url,
            token_expires_at, status, connected_at, updated_at
       FROM twitch_connections
      WHERE user_id = $1`,
    [userId]
  );
  return rows[0] || null;
}

async function rawConnection(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM twitch_connections WHERE user_id = $1`, [userId]
  );
  return rows[0] || null;
}

// A usable user access token for the user's connection — refreshing when
// needed. Returns { accessToken } or { revoked: true } (Twitch said the
// grant is dead — the UI must show the reconnect state, never a fake one).
async function usableUserToken(userId) {
  requireConfigured();
  const conn = await rawConnection(userId);
  if (!conn || conn.status !== 'active') return { revoked: true };
  if (conn.token_expires_at && new Date(conn.token_expires_at).getTime() - Date.now() > 60 * 1000)
    return { accessToken: conn.access_token };
  if (!conn.refresh_token) return { revoked: true };
  const env = twEnv();
  const out = await refreshAccessToken(env, conn.refresh_token);
  if (out.error) {
    if (/invalid_refresh_token|unauthorized_client|invalid_client|revoked/i.test(out.error)) {
      await pool.query(
        `UPDATE twitch_connections SET status = 'revoked', updated_at = now() WHERE user_id = $1`,
        [userId]
      );
      return { revoked: true };
    }
    throw new HttpError(502, 'Could not refresh the Twitch authorization — please try again.');
  }
  await pool.query(
    `UPDATE twitch_connections
        SET access_token = $2,
            refresh_token = COALESCE($3, refresh_token),
            token_expires_at = now() + ($4 || ' seconds')::interval,
            updated_at = now()
      WHERE user_id = $1`,
    [userId, out.accessToken, out.refreshToken, String(out.expiresIn)]
  );
  return { accessToken: out.accessToken };
}

// ---------------------------------------------------------------------------
// Helix API helper (user or app token — both carry Client-Id).
// ---------------------------------------------------------------------------
async function helixFetch(accessToken, path, init = {}) {
  const env = twEnv();
  const r = await fetch(`${HELIX_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Client-Id': env.clientId,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (body.message) || `HTTP ${r.status}`;
    const err = new Error(msg);
    err.twitchStatus = r.status;
    err.status = r.status;
    throw err;
  }
  return body;
}

// Small in-process cache so the LIVE page poll (every few seconds) never
// hammers Helix with a request per broadcaster per poll.
const streamCache = new Map(); // broadcaster_twitch_id -> { online, at, error }
const STREAM_CACHE_MS = 15 * 1000;
async function broadcasterOnline(broadcasterId, force = false) {
  const hit = streamCache.get(broadcasterId);
  if (!force && hit && Date.now() - hit.at < STREAM_CACHE_MS) return hit;
  let out;
  try {
    const env = requireConfigured();
    const token = await appAccessToken(env);
    const body = await helixFetch(token, `/streams?user_id=${encodeURIComponent(broadcasterId)}`);
    const s = (body.data || []).find((x) => x.type === 'live') || null;
    out = { online: !!s, stream: s || null, error: false };
  } catch (err) {
    out = { online: null, stream: null, error: String(err.message || 'twitch_error') };
  }
  streamCache.set(broadcasterId, { ...out, at: Date.now() });
  return out;
}

// ---------------------------------------------------------------------------
// Live-state application — THE single place transitions happen, shared by
// the EventSub webhook and the polling sweeper. SQL-guarded UPDATEs make
// duplicates safe: the second identical event simply matches no row.
// ---------------------------------------------------------------------------
const offlineStrikes = new Map(); // session_id -> consecutive offline polls

function emitSessionEvent(session, action) {
  if (!session.room_code) return;
  rt.emitRoom(session.room_code, {
    action,
    platform: 'twitch',
    username: session.broadcaster_login || undefined,
    display_name: session.broadcaster_display_name || session.broadcaster_login || undefined,
    title: session.title || undefined,
  });
}

async function activeSessionsForBroadcaster(broadcasterId) {
  const { rows } = await pool.query(
    `SELECT s.id, s.status, s.title, s.broadcaster_login, s.broadcaster_display_name,
            r.code AS room_code
       FROM twitch_stream_sessions s
       LEFT JOIN battle_rooms r ON r.id = s.room_id
      WHERE s.broadcaster_twitch_id = $1
        AND s.status IN ('preparing','live')
      ORDER BY s.created_at DESC`,
    [String(broadcasterId)]
  );
  return rows;
}

// stream.online confirmed (EventSub or sweep): preparing → live. A 'live'
// session stays live (duplicate/refresh events are no-ops). Returns count
// of sessions that genuinely flipped.
async function applyStreamOnline(broadcasterId) {
  const rows = await activeSessionsForBroadcaster(broadcasterId);
  let flipped = 0;
  for (const row of rows) {
    offlineStrikes.delete(row.id);
    if (row.status === 'live') continue; // idempotent: already live
    const { rowCount } = await pool.query(
      `UPDATE twitch_stream_sessions
          SET status = 'live', started_at = COALESCE(started_at, now()), updated_at = now()
        WHERE id = $1 AND status = 'preparing'`,
      [row.id]
    );
    if (rowCount > 0) {
      flipped += 1;
      row.status = 'live';
      emitSessionEvent(row, 'twitch_live');
      if (DEV) console.log(`  ⚡ twitch stream.online → LIVE (session ${String(row.id).slice(0, 8)}…)`);
    }
  }
  return flipped;
}

// stream.offline confirmed. EventSub (`immediate`) ends right away; the
// polling sweeper requires OFFLINE_CONFIRM_POLLS consecutive offline checks
// so a momentary blip never kills a real stream.
async function applyStreamOffline(broadcasterId, opts = {}) {
  const rows = await activeSessionsForBroadcaster(broadcasterId);
  let ended = 0;
  for (const row of rows) {
    if (row.status === 'preparing') continue; // never confirmed live — expiry handles it
    if (!opts.immediate) {
      const n = (offlineStrikes.get(row.id) || 0) + 1;
      offlineStrikes.set(row.id, n);
      if (n < OFFLINE_CONFIRM_POLLS) continue;
    }
    offlineStrikes.delete(row.id);
    const { rowCount } = await pool.query(
      `UPDATE twitch_stream_sessions
          SET status = 'ended', ended_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'live'`,
      [row.id]
    );
    if (rowCount > 0) {
      ended += 1;
      row.status = 'ended';
      emitSessionEvent(row, 'twitch_ended');
      if (DEV) console.log(`  ⚡ twitch stream.offline → ENDED (session ${String(row.id).slice(0, 8)}…)`);
    }
  }
  return ended;
}

async function expireStalePreparing() {
  const { rows } = await pool.query(
    `SELECT s.id, s.broadcaster_login, s.broadcaster_display_name, s.title,
            r.code AS room_code
       FROM twitch_stream_sessions s
       LEFT JOIN battle_rooms r ON r.id = s.room_id
      WHERE s.status = 'preparing'
        AND s.created_at < now() - make_interval(hours => ${PREPARE_EXPIRE_H})
      ORDER BY s.created_at DESC`
  );
  for (const row of rows) {
    await pool.query(`UPDATE twitch_stream_sessions SET status = 'ended', ended_at = now(), updated_at = now() WHERE id = $1 AND status = 'preparing'`, [row.id]);
    emitSessionEvent(row, 'twitch_ended');
    if (DEV) console.log(`  ⚡ twitch preparing session expired (session ${String(row.id).slice(0, 8)}…)`);
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// EventSub webhook — POST /api/twitch/eventsub (registered in server.js with
// express.raw BEFORE the JSON parser so the raw body is available for
// signature verification). Handles the challenge handshake, verified
// notifications and revocations. Twitch sends the signature in
// 'Twitch-Eventsub-Message-Signature': sha256=HMAC-SHA256(secret,
// message-id + message-timestamp + RAW BODY).
// ---------------------------------------------------------------------------
function verifyEventSubSignature(req) {
  const env = twEnv();
  if (!env.eventSecret) return false;
  const sig = String(req.headers['twitch-eventsub-message-signature'] || '');
  const id = String(req.headers['twitch-eventsub-message-id'] || '');
  const ts = String(req.headers['twitch-eventsub-message-timestamp'] || '');
  if (!/^sha256=[0-9a-f]{64}$/i.test(sig)) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', env.eventSecret)
    .update(id + ts + req.body)   // req.body is the RAW Buffer (express.raw)
    .digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function eventSubTimestampFresh(req) {
  const ts = Date.parse(String(req.headers['twitch-eventsub-message-timestamp'] || ''));
  if (Number.isNaN(ts)) return false;
  return Math.abs(Date.now() - ts) <= EVENTSECRET_REPLAY_MS;
}

// Recent message-id ring — belt & braces dedupe on top of the DB-guarded
// transitions (EventSub delivers at-least-once).
const seenEventIds = new Map(); // id -> ts
function alreadySeenEvent(id) {
  const now = Date.now();
  if (seenEventIds.size > 500) {
    for (const [k, t] of seenEventIds) if (now - t > 30 * 60 * 1000) seenEventIds.delete(k);
  }
  if (seenEventIds.has(id)) return true;
  seenEventIds.set(id, now);
  return false;
}

async function handleEventSub(req, res) {
  const send = (status, body, type = 'application/json') => {
    res.status(status);
    if (type === 'text/plain') res.type('text/plain').send(body);
    else res.json(body);
  };
  if (!eventSubReady()) return send(503, { error: 'Twitch EventSub is not configured on this deployment.' });
  if (!verifyEventSubSignature(req) || !eventSubTimestampFresh(req)) {
    // Twitch retries failures, but an unverifiable webhook must NEVER be
    // processed — log and 403 so Twitch stops retrying a broken sender.
    return send(403, { error: 'Invalid signature.' });
  }
  const type = String(req.headers['twitch-eventsub-message-type'] || '');
  const subType = String(req.headers['twitch-eventsub-subscription-type'] || '');
  let body;
  try { body = JSON.parse(req.body.toString('utf8')); }
  catch (_) { return send(400, { error: 'Bad JSON.' }); }

  // 1) Challenge handshake — respond with the raw challenge as text/plain.
  if (type === 'webhook_callback_verification') {
    if (body && typeof body.challenge === 'string') return send(200, body.challenge, 'text/plain');
    return send(400, { error: 'Missing challenge.' });
  }
  // 2) Revocation — Twitch revoked a subscription (secret/callback/app).
  if (type === 'revocation') {
    console.warn('[twitch] EventSub subscription revoked:', subType, (body && body.subscription && body.subscription.status) || '');
    return send(204, {});
  }
  // 3) Notifications.
  if (type !== 'notification') return send(400, { error: 'Unknown message type.' });

  const msgId = String(req.headers['twitch-eventsub-message-id'] || '');
  if (alreadySeenEvent(msgId)) return send(204, {}); // duplicate delivery — done already
  if (!body || !body.event) return send(400, { error: 'Malformed notification.' });

  const broadcasterId = String(body.event.broadcaster_user_id || '');
  if (!broadcasterId) return send(400, { error: 'Missing broadcaster_user_id.' });

  try {
    if (subType === 'stream.online') await applyStreamOnline(broadcasterId);
    else if (subType === 'stream.offline') await applyStreamOffline(broadcasterId, { immediate: true });
    else if (DEV) console.log('  ⚡ twitch EventSub notification (unhandled type):', subType);
  } catch (err) {
    console.error('[twitch] EventSub processing error:', String(err.message).slice(0, 160));
    return send(500, { error: 'Processing failed.' }); // Twitch will retry
  }
  return send(204, {});
}
const eventsubRoute = (req, res) => { handleEventSub(req, res).catch(() => { if (!res.headersSent) res.status(500).json({ error: 'EventSub handler failed.' }); }); };

// ---------------------------------------------------------------------------
// EventSub subscription management (stream.online + stream.offline only).
// Webhook subscriptions are created with an APP access token; the connected
// broadcaster has authorized the app through the OAuth connect above.
// ---------------------------------------------------------------------------
function eventSubCallbackUrl() {
  const env = twEnv();
  const origin = (env.redirectUri || '').replace(/\/+$/, '');
  const m = origin.match(/^https?:\/\/[^/]+/);
  return m ? m[0] + '/api/twitch/eventsub' : null;
}

async function ensureEventSubSubscriptions(broadcasterId, { silent } = {}) {
  if (!eventSubReady()) return { ok: false, reason: 'event_secret_missing' };
  const callback = eventSubCallbackUrl();
  if (!callback) return { ok: false, reason: 'no_public_callback' };
  const env = twEnv();
  const token = await appAccessToken(env);
  const existing = await helixFetch(token, '/eventsub/subscriptions?status=enabled&status=webhook_callback_verification_pending&first=100')
    .catch(() => ({ data: [] }));
  const mine = (existing.data || []).filter((s) =>
    String(s.transport && s.transport.callback || '') === callback &&
    String(s.condition && s.condition.broadcaster_user_id || '') === String(broadcasterId)
  );
  const have = new Set(mine.map((s) => s.type));
  const want = ['stream.online', 'stream.offline'];
  for (const type of want) {
    if (have.has(type)) continue;
    try {
      const r = await fetch(`${HELIX_BASE}/eventsub/subscriptions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Client-Id': env.clientId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type,
          version: '1',
          condition: { broadcaster_user_id: String(broadcasterId) },
          transport: { method: 'webhook', callback, secret: env.eventSecret },
        }),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (!silent) console.warn(`[twitch] EventSub subscribe ${type} failed:`, (b.message || r.status));
      } else if (DEV) {
        console.log(`  ⚡ twitch EventSub subscribed ${type} for broadcaster ${broadcasterId} (${(b.data || [])[0] ? (b.data[0].id || '').slice(0, 8) : '?'})`);
      }
    } catch (err) {
      if (!silent) console.warn('[twitch] EventSub subscribe error:', String(err.message).slice(0, 140));
    }
  }
  return { ok: true };
}

async function removeEventSubSubscriptions(broadcasterId) {
  if (!eventSubReady()) return;
  const callback = eventSubCallbackUrl();
  if (!callback) return;
  try {
    const env = twEnv();
    const token = await appAccessToken(env);
    const existing = await helixFetch(token, `/eventsub/subscriptions?first=100`).catch(() => ({ data: [] }));
    const mine = (existing.data || []).filter((s) =>
      String(s.transport && s.transport.callback || '') === callback &&
      String(s.condition && s.condition.broadcaster_user_id || '') === String(broadcasterId) &&
      (s.type === 'stream.online' || s.type === 'stream.offline'));
    for (const s of mine) {
      await fetch(`${HELIX_BASE}/eventsub/subscriptions?id=${encodeURIComponent(s.id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}`, 'Client-Id': env.clientId },
      }).catch(() => {});
    }
  } catch (_) { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
router.get('/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const e = twEnv();
  res.json({
    available: isConfigured(),
    redirectUriConfigured: !!e.redirectUri,
    eventSubReady: eventSubReady(),
  });
});

router.get('/connection', requireAuth, ah(async (req, res) => {
  const conn = await getConnection(req.user.id);
  if (!conn) return res.json({ connected: false });
  res.json({
    connected: conn.status === 'active',
    revoked: conn.status === 'revoked',
    broadcaster: {
      id: conn.twitch_user_id,
      login: conn.login,
      display_name: conn.display_name,
      profile_image_url: conn.profile_image_url,
    },
    connectedAt: conn.connected_at,
  });
}));

// STEP 1 — send the artist to Twitch's authorization screen. The Art Arena
// session cookie authenticates the request; the state binds the flow to THIS
// user, so the callback can never attach the account to someone else.
router.get('/connect', requireAuth, ah(async (req, res) => {
  const env = requireConfigured();
  const state = newOpaque(24);
  flows.set(state, {
    userId: req.user.id,
    returnTo: safeReturnTo(req.query.returnTo),
    createdAt: Date.now(),
  });
  const p = new URLSearchParams({
    client_id: env.clientId,
    redirect_uri: redirectUriFor(req),
    response_type: 'code',
    scope: SCOPE,
    state,
    // force_verify not set: an already-authorized user returns directly to
    // the callback (reconnect stays frictionless).
  });
  res.redirect(`${TWITCH_AUTH_URL}?${p.toString()}`);
}));

// STEP 2 — Twitch returns here. Denial, bad state and exchange failures all
// redirect home with a machine-readable reason. NO account is created or
// switched — the connection binds to the Art Arena user stored in the state.
router.get('/callback', ah(async (req, res) => {
  const env = twEnv();
  if (!env.clientId || !env.clientSecret) return failRedirect(req, res, 'setup');

  const { code, state, error } = req.query;
  const stateKey = String(state || '');
  const flow = flows.get(stateKey);
  if (error || !code) {
    if (flow) flows.delete(stateKey); // denial burns the state too
    return failRedirect(req, res, flow ? 'denied' : 'bad_state');
  }
  if (!flow) return failRedirect(req, res, 'bad_state');
  flows.delete(stateKey); // single-use — a replayed state is dead

  let tokens;
  try {
    tokens = await exchangeCode(env, String(code), redirectUriFor(req));
  } catch (err) {
    console.error('[twitch] token exchange failed:', String(err.message).replace(/client_secret[=\s]*\S+/g, 'client_secret=***'));
    return failRedirect(req, res, /fetch failed|EAI_AGAIN|ENOTFOUND|ECONN/.test(String(err.message)) ? 'network' : 'token');
  }

  // Twitch identity (Helix /users — resolves from the access token itself).
  let user;
  try {
    const body = await helixFetch(tokens.access_token, '/users');
    user = (body.data || [])[0];
    if (!user || !user.id) return failRedirect(req, res, 'identity');
  } catch (err) {
    return failRedirect(req, res, err.twitchStatus === 401 ? 'token' : 'identity');
  }

  await pool.query(
    `INSERT INTO twitch_connections
       (user_id, twitch_user_id, login, display_name, profile_image_url,
        access_token, refresh_token, token_expires_at, scopes, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() + ($8 || ' seconds')::interval, $9, 'active')
     ON CONFLICT (user_id) DO UPDATE SET
       twitch_user_id = $2, login = $3, display_name = $4, profile_image_url = $5,
       access_token = $6,
       refresh_token = COALESCE($7, twitch_connections.refresh_token),
       token_expires_at = now() + ($8 || ' seconds')::interval,
       scopes = $9, status = 'active', updated_at = now()`,
    [
      flow.userId, String(user.id), String(user.login || ''), String(user.display_name || user.login || ''),
      user.profile_image_url || null,
      tokens.access_token, tokens.refresh_token || null,
      String(tokens.expires_in || 3600), SCOPE,
    ]
  );

  // Push EventSub subscriptions (best effort — the sweeper covers failures).
  try {
    await ensureEventSubSubscriptions(String(user.id), { silent: false });
  } catch (err) {
    console.warn('[twitch] EventSub setup after connect failed (sweeper will cover):', String(err.message).slice(0, 120));
  }

  const back = flow.returnTo ? `&returnTo=${encodeURIComponent(flow.returnTo)}` : '';
  res.redirect(frontUrl(req, `aa-twitch=ok${back}`));
}));

// Disconnect — revoke at Twitch, end any live sessions, forget the
// connection server-side, remove EventSub subscriptions.
router.post('/disconnect', requireAuth, ah(async (req, res) => {
  const conn = await rawConnection(req.user.id);
  if (conn) {
    const tokenToRevoke = conn.refresh_token || conn.access_token;
    if (tokenToRevoke) {
      try {
        await fetch(`${TWITCH_REVOKE_URL}?client_id=${encodeURIComponent(twEnv().clientId)}&token=${encodeURIComponent(tokenToRevoke)}`, { method: 'POST' });
      } catch (_) { /* revocation is best-effort; the row is deleted anyway */ }
    }
    await removeEventSubSubscriptions(conn.twitch_user_id).catch(() => {});
    await pool.query('DELETE FROM twitch_connections WHERE user_id = $1', [req.user.id]);
  }
  // End any active sessions this user hosts — the room badge must clear
  // immediately (Twitch itself may keep streaming; Art Arena stops tracking).
  const { rows } = await pool.query(
    `SELECT s.id, r.code AS room_code, s.broadcaster_login, s.broadcaster_display_name, s.title
       FROM twitch_stream_sessions s
       JOIN battle_rooms r ON r.id = s.room_id
      WHERE s.host_user_id = $1 AND s.status IN ('preparing','live')`,
    [req.user.id]
  );
  for (const row of rows) {
    await pool.query(`UPDATE twitch_stream_sessions SET status='ended', ended_at=now(), updated_at=now() WHERE id = $1 AND status IN ('preparing','live')`, [row.id]);
    emitSessionEvent(row, 'twitch_ended');
  }
  res.json({ disconnected: true });
}));

// ---------------------------------------------------------------------------
// Stream sessions
// ---------------------------------------------------------------------------
// Sessions the current user is hosting (latest first) — powers the "my
// streams" state in the Go Live UI and future Stream Studio screens.
router.get('/sessions', requireAuth, ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.id, s.room_id, s.battle_id, s.title, s.status, s.started_at, s.ended_at,
            s.created_at, r.code AS room_code, r.name AS room_name
       FROM twitch_stream_sessions s
       LEFT JOIN battle_rooms r ON r.id = s.room_id
      WHERE s.host_user_id = $1
      ORDER BY s.created_at DESC
      LIMIT 20`,
    [req.user.id]
  );
  res.json({ sessions: rows });
}));

// Prepare a stream session for a battle room (host only, room not ended).
// Sets the channel title on Twitch (channel:manage:broadcast) so the stream
// is genuinely staged, then records status 'preparing'. It does NOT claim
// live — Twitch confirming the stream is what flips the status.
router.post('/sessions', requireAuth, ah(async (req, res) => {
  requireConfigured(); // clear setup error before anything else

  const { roomCode, title } = req.body || {};
  const cleanTitle = String(title || '').trim().slice(0, 140);
  if (!roomCode) throw new HttpError(400, 'A battle room is required.');
  if (!cleanTitle) throw new HttpError(400, 'A stream title is required.');

  const { rows: roomRows } = await pool.query(
    `SELECT r.id, r.code, r.name, r.status, r.host_id
       FROM battle_rooms r
      WHERE UPPER(r.code) = UPPER($1) AND r.deleted_at IS NULL
      LIMIT 1`,
    [String(roomCode)]
  );
  const room = roomRows[0];
  if (!room) throw new HttpError(404, 'That battle room does not exist.');
  if (room.host_id !== req.user.id)
    throw new HttpError(403, 'Only the room owner can go live from this room.');
  if (!['lobby', 'starting', 'in_battle'].includes(room.status))
    throw new HttpError(409, 'Go Live is only available while the room is open.');

  const { rows: existing } = await pool.query(
    `SELECT id, status FROM twitch_stream_sessions
      WHERE room_id = $1 AND status IN ('preparing','live') LIMIT 1`,
    [room.id]
  );
  if (existing[0]) throw new HttpError(409, 'This room already has an active stream session.');

  const conn = await getConnection(req.user.id);
  if (!conn || conn.status !== 'active') {
    throw new HttpError(401, conn && conn.revoked
      ? 'Your Twitch authorization expired or was revoked — reconnect Twitch and try again.'
      : 'Connect your Twitch account before going live.');
  }

  // A usable user token (refreshing when needed) for the channel-title write.
  const tok = await usableUserToken(req.user.id);
  if (tok.revoked) throw new HttpError(401, 'Your Twitch authorization expired or was revoked — reconnect Twitch and try again.');

  // Honest guard: if this broadcaster is ALREADY live on Twitch, preparing a
  // second session would mislabel an unrelated stream as this battle.
  const liveNow = await broadcasterOnline(conn.twitch_user_id, true);
  if (liveNow.online) {
    throw new HttpError(409, 'You are already live on Twitch. End your current stream before preparing an Art Arena battle stream.');
  }

  // Stage the title on Twitch (PATCH /helix/channels — needs
  // channel:manage:broadcast). Best effort: a Twitch rejection stops the
  // prepare so the session never silently claims a title Twitch refused.
  try {
    await helixFetch(tok.accessToken, `/channels?broadcaster_id=${encodeURIComponent(conn.twitch_user_id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: cleanTitle }),
    });
  } catch (err) {
    const hint = err.twitchStatus === 403
      ? 'Art Arena needs channel:manage:broadcast permission to stage the stream title — disconnect and reconnect Twitch allowing the permission.'
      : '';
    throw new HttpError(502, `Twitch rejected the stream title: ${String(err.message).slice(0, 140)}${hint ? ' ' + hint : ''}`);
  }

  // Link the battle when one is already live in this room.
  const { rows: battleRows } = await pool.query(
    `SELECT id FROM battles
      WHERE room_id = $1 AND status NOT IN ('complete','cancelled','forfeited','disqualified')
      ORDER BY created_at DESC LIMIT 1`,
    [room.id]
  );

  const { rows: inserted } = await pool.query(
    `INSERT INTO twitch_stream_sessions
       (room_id, host_user_id, battle_id,
        broadcaster_twitch_id, broadcaster_login, broadcaster_display_name,
        broadcaster_profile_image_url, title, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'preparing')
     RETURNING id, status, title, started_at, ended_at, created_at`,
    [
      room.id, req.user.id, (battleRows[0] && battleRows[0].id) || null,
      conn.twitch_user_id, conn.login, conn.display_name,
      conn.profile_image_url, cleanTitle,
    ]
  );
  const session = inserted[0];

  // Realtime: everyone in the room sees the preparing chip immediately.
  rt.emitRoom(room.code, {
    action: 'twitch_preparing',
    platform: 'twitch',
    username: conn.login || undefined,
    display_name: conn.display_name || undefined,
    title: cleanTitle,
  });

  res.status(201).json({ session });
}));

// End (or cancel) a stream session — the HOST only. For a preparing session
// this cancels; for a live session it stops Art Arena tracking (Twitch keeps
// streaming until the broadcaster ends it; stream.offline still arrives).
router.post('/sessions/:id/end', requireAuth, ah(async (req, res) => {
  const id = String(req.params.id || '');
  const { rows } = await pool.query(
    `SELECT s.id, s.status, s.title, s.broadcaster_login, s.broadcaster_display_name,
            r.code AS room_code
       FROM twitch_stream_sessions s
       JOIN battle_rooms r ON r.id = s.room_id
      WHERE s.id = $1 AND s.host_user_id = $2
        AND s.status IN ('preparing','live')
      LIMIT 1`,
    [id, req.user.id]
  );
  const session = rows[0];
  if (!session) throw new HttpError(404, 'No active stream session found for that room.');
  await pool.query(
    `UPDATE twitch_stream_sessions SET status = 'ended', ended_at = now(), updated_at = now() WHERE id = $1`,
    [session.id]
  );
  emitSessionEvent(session, 'twitch_ended');
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// The LIVE page data — exported for server.js (merged with youtube.liveData()
// under GET /api/live). A battle appears LIVE only when Twitch GENUINELY
// reports the stream online — and only while its battle is still live.
// ---------------------------------------------------------------------------
async function liveData() {
  const { rows } = await pool.query(
    `SELECT s.id, s.title, s.started_at, s.broadcaster_login, s.broadcaster_display_name,
            s.broadcaster_profile_image_url, s.broadcaster_twitch_id,
            u.display_name AS host_display, u.username AS host_username,
            r.code AS room_code, r.name AS room_name, r.status AS room_status,
            bt.id AS battle_id, bt.status AS battle_status,
            bc.summary_text AS challenge_summary,
            (SELECT string_agg(DISTINCT ou.display_name, ' vs ')
               FROM room_participants orp
               JOIN users ou ON ou.id = orp.user_id
              WHERE orp.room_id = r.id AND orp.user_id <> s.host_user_id
                AND orp.state IN ('waiting','ready')) AS opponents
       FROM twitch_stream_sessions s
       JOIN users u ON u.id = s.host_user_id
       JOIN battle_rooms r ON r.id = s.room_id
       LEFT JOIN battles bt ON bt.id = s.battle_id
       LEFT JOIN battle_challenges bc ON bc.battle_id = bt.id
      WHERE s.status = 'live'
        AND r.deleted_at IS NULL
        AND (bt.id IS NULL OR bt.status NOT IN ('complete','cancelled','forfeited','disqualified'))`
  );

  // Genuine verification: when configured, confirm each broadcaster is still
  // online RIGHT NOW via Helix Get Streams (app token). A stored 'live' we
  // cannot verify (no credentials) is never advertised — a status alone must
  // not put a card in LIVE NOW.
  const configured = isConfigured();
  const live = [];
  for (const row of rows) {
    if (!configured) continue; // unverifiable → hide (same rule as youtube v50)
    const check = await broadcasterOnline(row.broadcaster_twitch_id);
    if (check.error || check.online === null) {
      live.push(row); // transient verification failure — keep the stored state
      continue;
    }
    if (check.online) {
      live.push(row);
    } else {
      // Twitch says offline but our row still says live → end it honestly.
      await applyStreamOffline(row.broadcaster_twitch_id, { immediate: false });
    }
  }
  const shape = (r) => ({
    id: r.id,
    title: r.title,
    artist: r.host_display || r.host_username,
    opponents: r.opponents ? String(r.opponents).split(' vs ') : [],
    challenge: r.challenge_summary || null,
    roomCode: r.room_code,
    roomName: r.room_name,
    platform: 'twitch',
    broadcaster: {
      login: r.broadcaster_login,
      display_name: r.broadcaster_display_name || r.broadcaster_login,
      profile_image_url: r.broadcaster_profile_image_url,
    },
    watchUrl: r.broadcaster_login ? `https://www.twitch.tv/${encodeURIComponent(r.broadcaster_login)}` : null,
    startedAt: r.started_at,
    status: 'live',
  });
  return { live: live.map(shape), upcoming: [] }; // Twitch has no scheduled-broadcast concept
}

// ---------------------------------------------------------------------------
// Fallback sweeper — polls Helix Get Streams for every non-ended session and
// applies the same transitions as EventSub. Also expires stale preparing
// sessions. Started from server.js at boot; EventSub remains the preferred
// push path when configured.
// ---------------------------------------------------------------------------
let sweeperTimer = null;
function startLiveSweeper(intervalMs = SWEEP_MS) {
  if (sweeperTimer) return;
  const tick = async () => {
    if (!isConfigured()) return; // nothing verifiable without credentials
    try {
      const { rows } = await pool.query(
        `SELECT DISTINCT broadcaster_twitch_id
           FROM twitch_stream_sessions
          WHERE status IN ('preparing','live') AND broadcaster_twitch_id IS NOT NULL`
      );
      for (const { broadcaster_twitch_id: id } of rows) {
        const state = await broadcasterOnline(id, true);
        if (state.online === null) continue; // transient API trouble — retry next tick
        if (state.online) await applyStreamOnline(id);
        else await applyStreamOffline(id, { immediate: false });
      }
      await expireStalePreparing();
    } catch (err) {
      console.warn('[twitch] live sweeper error:', String(err.message).slice(0, 160));
    }
  };
  tick();
  sweeperTimer = setInterval(tick, intervalMs);
  sweeperTimer.unref();
  if (DEV) console.log('RT twitch live sweeper: every ' + (intervalMs / 1000) + 's (Helix Get Streams verification)');
}

// ---------------------------------------------------------------------------
// Testability seam — exported internals used by server/twitch.selftest.js.
// ---------------------------------------------------------------------------
async function selftestOnly() {
  return { applyStreamOnline, applyStreamOffline, expireStalePreparing, broadcasterOnline };
}

module.exports = {
  router,
  liveData,
  isConfigured,
  eventsubRoute,
  startLiveSweeper,
  __selftest: selftestOnly,
};
