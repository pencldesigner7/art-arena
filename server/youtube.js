'use strict';
/**
 * ============================================================================
 *  ART ARENA™ — YOUTUBE LIVE FOUNDATION (v50)                    server/youtube.js
 * ============================================================================
 *  REAL integration architecture for going live from an Art Arena battle:
 *
 *    Art Arena user ──connect──▶ YouTube account (OAuth, server-side tokens)
 *                     └──create──▶ liveBroadcast + liveStream (bound)
 *                                   └──associated──▶ Art Arena battle/room
 *
 *  What this module REALLY does (no fakes):
 *    - OAuth 2.0 authorization-code flow with PKCE + single-use state
 *      (mirrors google-auth.js, plus access_type=offline for refresh tokens)
 *    - Channel identity via YouTube Data API v3 (channels?mine=true)
 *    - Token refresh; revoked/expired authorization detected and surfaced
 *    - liveBroadcasts.insert / liveStreams.insert / liveBroadcasts.bind
 *    - Status sync (lifeCycleStatus) — the LIVE page only shows a battle as
 *      LIVE when YouTube GENUINELY says so
 *
 *  What it deliberately does NOT do (v50 honesty):
 *    - No video ingestion. Creating a broadcast is not streaming — that is
 *      the future Art Arena Stream Studio, which will plug into the
 *      stream-target rows this module stores (no OAuth/broadcast rewrite).
 *
 *  SECURITY (same rules as google-auth.js):
 *    - GOOGLE_CLIENT_SECRET lives only in process.env — never in a response
 *    - Access/refresh tokens are stored SERVER-SIDE in youtube_connections
 *      and are NEVER returned to the browser (the API returns channel
 *      identity + status only)
 *    - Stream ingestion keys are stored server-side and NOT returned by the
 *      API in v50 (the future Stream Studio will surface them to the owner)
 *
 *  ENVIRONMENT
 *    GOOGLE_CLIENT_ID        OAuth Client ID (shared with Google sign-in)
 *    GOOGLE_CLIENT_SECRET    OAuth Client Secret (server-only)
 *    YOUTUBE_REDIRECT_URI    e.g. https://art-arena-galt.onrender.com/api/youtube/callback
 *                            (default: derived from the request host)
 *
 *  Missing credentials → every OAuth/broadcast endpoint fails clearly with
 *  setup instructions; /status reports available:false so the UI shows the
 *  honest setup state. No mock connections, ever.
 * ============================================================================
 */
const crypto = require('crypto');
const express = require('express');
const { pool, DEV, HttpError, ah, requireAuth } = require('./lib');

const router = express.Router();

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const YT_BASE = 'https://www.googleapis.com/youtube/v3';
const SCOPE = 'https://www.googleapis.com/auth/youtube';
const FLOW_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Config — read per-request (a .env change is picked up on restart).
// ---------------------------------------------------------------------------
const ytEnv = () => ({
  clientId: (process.env.GOOGLE_CLIENT_ID || '').trim(),
  clientSecret: (process.env.GOOGLE_CLIENT_SECRET || '').trim(),
  redirectUri: (process.env.YOUTUBE_REDIRECT_URI || '').trim(),
});
const isConfigured = () => {
  const e = ytEnv();
  return !!(e.clientId && e.clientSecret);
};

const isLoopback = (host) => /^localhost([:/].*)?$|^127\./.test(String(host || ''));
const protoFor = (req) => (DEV && isLoopback(req.headers.host) ? 'http' : 'https');

function redirectUriFor(req) {
  const explicit = ytEnv().redirectUri;
  if (explicit) return explicit;
  const host = String(req.headers.host || '');
  return `${protoFor(req)}://${host}/api/youtube/callback`;
}
function frontUrl(req, hash) {
  const host = String(req.headers.host || 'localhost');
  return `${protoFor(req)}://${host}/` + (hash ? `#${hash}` : '');
}
function failRedirect(req, res, reason) {
  console.log(`[youtube] connect failed: ${reason}`);
  res.redirect(frontUrl(req, `aa-youtube=error&reason=${encodeURIComponent(reason)}`));
}

// Safe return path for post-connect deep links (relative, no protocol jumps).
function safeReturnTo(raw) {
  const s = String(raw || '');
  if (/^\/(?!\/)[A-Za-z0-9\-._~!$&'()*+,;=:@/?%]*$/.test(s)) return s;
  return null;
}

// ---------------------------------------------------------------------------
// In-flight OAuth flows: state -> { verifier, userId, returnTo, createdAt }.
// Single-use, < 10 min, memory store (a restart mid-flow = "try again").
// ---------------------------------------------------------------------------
const flows = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of flows) if (now - v.createdAt > FLOW_TTL_MS) flows.delete(k);
}, 60 * 1000).unref();

const newOpaque = (bytes) => crypto.randomBytes(bytes).toString('base64url');

// ---------------------------------------------------------------------------
// Setup error (missing env) — one clear message everywhere.
// ---------------------------------------------------------------------------
const SETUP_HINT = 'YouTube is not configured on this deployment yet. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and YOUTUBE_REDIRECT_URI (see docs in the v50 report: Google Cloud OAuth client + Render environment variables).';
function requireConfigured() {
  if (!isConfigured()) throw new HttpError(503, SETUP_HINT);
  return ytEnv();
}

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------
async function exchangeCode(env, code, verifier, redirectUri) {
  const r = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.clientId,
      client_secret: env.clientSecret, // server-side ONLY
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });
  const tokens = await r.json().catch(() => ({}));
  if (!r.ok || !tokens.access_token) {
    throw new Error(tokens.error_description || tokens.error || 'token exchange failed');
  }
  return tokens;
}

async function refreshAccessToken(env, refreshToken) {
  const r = await fetch(GOOGLE_TOKEN_URL, {
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
  if (!r.ok) return { error: t.error || 'refresh_failed' };
  return { accessToken: t.access_token, expiresIn: t.expires_in || 3600 };
}

// ---------------------------------------------------------------------------
// Connection persistence
// ---------------------------------------------------------------------------
async function getConnection(userId) {
  const { rows } = await pool.query(
    `SELECT user_id, channel_id, channel_title, channel_thumbnail,
            token_expires_at, status, connected_at, updated_at
       FROM youtube_connections
      WHERE user_id = $1`,
    [userId]
  );
  return rows[0] || null;
}

// A usable access token for the user's connection — refreshing when needed.
// Returns { accessToken } or { revoked: true } (Google said the grant is
// dead — the UI must show the reconnect state, never a fake connected one).
async function usableAccessToken(userId) {
  requireConfigured();
  const { rows } = await pool.query(
    `SELECT access_token, refresh_token, token_expires_at, status
       FROM youtube_connections WHERE user_id = $1`,
    [userId]
  );
  const conn = rows[0];
  if (!conn || conn.status !== 'active') return { revoked: true };
  if (conn.token_expires_at && new Date(conn.token_expires_at).getTime() - Date.now() > 60 * 1000)
    return { accessToken: conn.access_token };

  if (!conn.refresh_token) return { revoked: true }; // nothing to refresh with
  const env = ytEnv();
  const out = await refreshAccessToken(env, conn.refresh_token);
  if (out.error) {
    if (/invalid_grant|invalid_refresh_token|unauthorized_client/.test(out.error)) {
      await pool.query(
        `UPDATE youtube_connections SET status = 'revoked', updated_at = now() WHERE user_id = $1`,
        [userId]
      );
      return { revoked: true };
    }
    throw new HttpError(502, 'Could not refresh the YouTube authorization — please try again.');
  }
  await pool.query(
    `UPDATE youtube_connections
        SET access_token = $2, token_expires_at = now() + ($3 || ' seconds')::interval, updated_at = now()
      WHERE user_id = $1`,
    [userId, out.accessToken, String(out.expiresIn)]
  );
  return { accessToken: out.accessToken };
}

// ---------------------------------------------------------------------------
// YouTube Data API helpers
// ---------------------------------------------------------------------------
async function ytFetch(accessToken, path, init = {}) {
  const r = await fetch(`${YT_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const why = (body.error && body.error.message) || `HTTP ${r.status}`;
    const code = (body.error && body.error.errors && body.error.errors[0] && body.error.errors[0].reason) || '';
    const err = new Error(why);
    err.ytReason = code;
    err.status = r.status;
    throw err;
  }
  return body;
}

// Map YouTube lifeCycleStatus -> Art Arena broadcast lifecycle.
const YT_LIFECYCLE_MAP = {
  created: 'scheduled',      // broadcast object exists, metadata only
  ready: 'ready',            // bound to a stream — READY FOR VIDEO INGESTION
  testing: 'ready',          // ingest testing in progress (still not public)
  live: 'live',              // GENUINELY live on YouTube
  complete: 'ended',
  revoked: 'failed',
};
function mapLifecycle(s) { return YT_LIFECYCLE_MAP[s] || 'scheduled'; }

// Sync one broadcast row's status from YouTube. Never trusts a stale 'live'.
async function syncBroadcastRow(row, accessToken) {
  try {
    const body = await ytFetch(accessToken, `liveBroadcasts?part=status&id=${encodeURIComponent(row.youtube_broadcast_id)}`);
    const yt = body.items && body.items[0];
    const lc = yt && yt.status && yt.status.lifeCycleStatus;
    if (lc) {
      await pool.query(
        `UPDATE youtube_broadcasts SET last_known_status = $2, last_synced_at = now() WHERE id = $1`,
        [row.id, mapLifecycle(lc)]
      );
      return mapLifecycle(lc);
    }
  } catch (err) {
    // quota/transient problems must not crash the page — keep last status.
    console.warn('[youtube] status sync skipped:', String(err.message).slice(0, 120));
  }
  return row.last_known_status;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Availability probe (public, mirrors /api/auth/google/status). No secrets.
router.get('/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const e = ytEnv();
  res.json({
    available: !!(e.clientId && e.clientSecret),
    redirectUriConfigured: !!e.redirectUri,
  });
});

// The user's connection state (authenticated). Channel identity ONLY —
// tokens never leave the server.
router.get('/connection', requireAuth, ah(async (req, res) => {
  const conn = await getConnection(req.user.id);
  if (!conn) return res.json({ connected: false });
  res.json({
    connected: conn.status === 'active',
    revoked: conn.status === 'revoked',
    channel: {
      id: conn.channel_id,
      title: conn.channel_title,
      thumbnail: conn.channel_thumbnail,
    },
    connectedAt: conn.connected_at,
  });
}));

// STEP 1 — send the artist to Google's consent screen (full-page redirect;
// the session cookie authenticates the request).
router.get('/connect', requireAuth, ah(async (req, res) => {
  const env = requireConfigured();
  const verifier = newOpaque(48);
  const state = newOpaque(24);
  flows.set(state, {
    verifier,
    userId: req.user.id,
    returnTo: safeReturnTo(req.query.returnTo),
    createdAt: Date.now(),
  });
  const p = new URLSearchParams({
    client_id: env.clientId,
    redirect_uri: redirectUriFor(req),
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',   // we need a refresh token for later broadcasts
    prompt: 'consent',        // fresh consent → refresh token is always issued
    include_granted_scopes: 'false',
    state,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  });
  res.redirect(`${GOOGLE_AUTH_URL}?${p.toString()}`);
}));

// STEP 2 — Google returns here. Denial, bad state, exchange failures and
// revoked sessions all redirect home with a machine-readable reason.
router.get('/callback', ah(async (req, res) => {
  const env = ytEnv();
  if (!env.clientId || !env.clientSecret) return failRedirect(req, res, 'setup');

  const { code, state, error } = req.query;
  const stateKey = String(state || '');
  const flow = flows.get(stateKey);
  // Denial burns the state too (single-use, even on cancel) — a replay of
  // the same denial URL must read bad_state, not a second "denied" grant.
  if (error || !code) {
    if (flow) flows.delete(stateKey);
    return failRedirect(req, res, flow ? 'denied' : 'bad_state');
  }
  if (!flow) return failRedirect(req, res, 'bad_state');
  flows.delete(stateKey); // single-use — a replayed state is dead

  let tokens;
  try {
    tokens = await exchangeCode(env, String(code), flow.verifier, redirectUriFor(req));
  } catch (err) {
    console.error('[youtube] token exchange failed:', String(err.message).replace(/client_secret[=\s]*\S+/g, 'client_secret=***'));
    return failRedirect(req, res, /fetch failed|EAI_AGAIN|ENOTFOUND|ECONN/.test(String(err.message)) ? 'network' : 'token');
  }

  // Channel identity (YouTube Data API v3). Also validates the youtube scope.
  let channel;
  try {
    const body = await ytFetch(tokens.access_token, 'channels?part=snippet&mine=true');
    const item = body.items && body.items[0];
    if (!item) return failRedirect(req, res, 'no_channel'); // brand accounts w/o channel
    channel = {
      id: item.id,
      title: (item.snippet && item.snippet.title) || 'Your channel',
      thumbnail:
        (item.snippet && item.snippet.thumbnails && (
          item.snippet.thumbnails.default || item.snippet.thumbnails.medium
        ) || {}).url || null,
    };
  } catch (err) {
    return failRedirect(req, res, err.status === 403 ? 'forbidden_scope' : 'channel');
  }

  // Upsert the connection. Keep an older refresh token if Google omitted one
  // (repeat consents may not re-issue it).
  await pool.query(
    `INSERT INTO youtube_connections
       (user_id, channel_id, channel_title, channel_thumbnail, access_token,
        refresh_token, token_expires_at, scopes, status)
     VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' seconds')::interval, $8, 'active')
     ON CONFLICT (user_id) DO UPDATE SET
       channel_id = $2, channel_title = $3, channel_thumbnail = $4,
       access_token = $5,
       refresh_token = COALESCE($6, youtube_connections.refresh_token),
       token_expires_at = now() + ($7 || ' seconds')::interval,
       scopes = $8, status = 'active', updated_at = now()`,
    [
      flow.userId, channel.id, channel.title, channel.thumbnail,
      tokens.access_token, tokens.refresh_token || null,
      String(tokens.expires_in || 3600), SCOPE,
    ]
  );

  const back = flow.returnTo ? `&returnTo=${encodeURIComponent(flow.returnTo)}` : '';
  res.redirect(frontUrl(req, `aa-youtube=ok${back}`));
}));

// Disconnect — revoke at Google, then forget the connection server-side.
router.post('/disconnect', requireAuth, ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT access_token, refresh_token FROM youtube_connections WHERE user_id = $1`,
    [req.user.id]
  );
  const conn = rows[0];
  if (conn) {
    const tokenToRevoke = conn.refresh_token || conn.access_token;
    if (tokenToRevoke) {
      try {
        await fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(tokenToRevoke)}`, { method: 'POST' });
      } catch (_) { /* revocation is best-effort; the row is deleted anyway */ }
    }
    await pool.query('DELETE FROM youtube_connections WHERE user_id = $1', [req.user.id]);
  }
  res.json({ disconnected: true });
}));

// My broadcasts (status-synced when credentials allow).
router.get('/broadcasts', requireAuth, ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.id, b.title, b.privacy, b.scheduled_start, b.watch_url,
            b.last_known_status, b.last_synced_at, b.created_at,
            b.room_id, r.code AS room_code, r.name AS room_name,
            bt.id AS battle_id
       FROM youtube_broadcasts b
       LEFT JOIN battle_rooms r ON r.id = b.room_id
       LEFT JOIN battles bt ON bt.id = b.battle_id
      WHERE b.user_id = $1
      ORDER BY b.created_at DESC
      LIMIT 50`,
    [req.user.id]
  );
  let out = rows;
  if (rows.length && isConfigured()) {
    const tok = await usableAccessToken(req.user.id).catch(() => null);
    if (tok && tok.accessToken) {
      out = [];
      for (const row of rows) out.push({ ...row, last_known_status: await syncBroadcastRow(row, tok.accessToken) });
    }
  }
  res.json({ broadcasts: out });
}));

// Create + bind a real broadcast on the user's connected channel.
// Eligibility (v51 spec): the ROOM OWNER, in the PRE-MATCH state — the lobby,
// before the battle starts. The broadcast is room-scoped now and is linked
// to the battle automatically the moment the battle is minted (rooms.js).
router.post('/broadcasts', requireAuth, ah(async (req, res) => {
  requireConfigured(); // clear setup error before anything else

  const { roomCode, title, privacy, scheduledStartTime } = req.body || {};
  const cleanTitle = String(title || '').trim().slice(0, 100);
  const cleanPrivacy = ['private', 'unlisted', 'public'].includes(privacy) ? privacy : 'private';
  if (!roomCode) throw new HttpError(400, 'A battle room is required.');
  if (!cleanTitle) throw new HttpError(400, 'A stream title is required.');

  // Room + ownership + pre-match state (server-authoritative).
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
  if (room.status !== 'lobby')
    throw new HttpError(409, 'Go Live is only available before the match starts.');

  // One broadcast per (room, owner) — reuse instead of duplicates.
  const { rows: existing } = await pool.query(
    `SELECT * FROM youtube_broadcasts WHERE room_id = $1 AND user_id = $2 LIMIT 1`,
    [room.id, req.user.id]
  );
  if (existing[0]) return res.status(200).json({ broadcast: existing[0], reused: true });

  // A valid YouTube connection (refreshing if needed).
  const tok = await usableAccessToken(req.user.id);
  if (tok.revoked) throw new HttpError(401, 'Your YouTube authorization has expired or was revoked — reconnect YouTube and try again.');

  const when = scheduledStartTime ? new Date(scheduledStartTime) : new Date(Date.now() + 5 * 60 * 1000);
  if (Number.isNaN(when.getTime())) throw new HttpError(400, 'The scheduled start time is not a valid date.');

  // 1) liveBroadcast
  let broadcast;
  try {
    broadcast = await ytFetch(tok.accessToken, 'liveBroadcasts?part=snippet,status,contentDetails', {
      method: 'POST',
      body: JSON.stringify({
        snippet: {
          title: cleanTitle,
          scheduledStartTime: when.toISOString(),
        },
        status: {
          privacyStatus: cleanPrivacy,
          selfDeclaredMadeForKids: false,
        },
        contentDetails: {
          enableAutoStart: true,  // goes live when ingestion starts (Stream Studio)
          enableAutoStop: true,   // ends when ingestion stops
          latencyPreference: 'low',
        },
      }),
    });
  } catch (err) {
    throw new HttpError(502, `YouTube rejected the broadcast: ${String(err.message).slice(0, 180)}`);
  }

  // 2) liveStream (the ingestion target the future Stream Studio binds to)
  let stream;
  try {
    stream = await ytFetch(tok.accessToken, 'liveStreams?part=snippet,cdn', {
      method: 'POST',
      body: JSON.stringify({
        snippet: { title: `${cleanTitle} — Art Arena` },
        cdn: {
          format: '720p',
          ingestionType: 'rtmp',
          resolution: '720p',
          frameRate: '30fps',
        },
      }),
    });
  } catch (err) {
    throw new HttpError(502, `YouTube rejected the stream target: ${String(err.message).slice(0, 180)}`);
  }

  // 3) bind broadcast <-> stream
  try {
    await ytFetch(
      tok.accessToken,
      `liveBroadcasts/bind?part=id,contentDetails&id=${encodeURIComponent(broadcast.id)}&streamId=${encodeURIComponent(stream.id)}`,
      { method: 'POST' }
    );
  } catch (err) {
    throw new HttpError(502, `YouTube could not bind the stream to the broadcast: ${String(err.message).slice(0, 180)}`);
  }

  // 4) remember everything server-side — INCLUDING the ingestion info for
  //    the future Stream Studio (never returned to the browser in v50).
  const ingestion = (stream.cdn && stream.cdn.ingestionInfo) || {};
  const { rows: inserted } = await pool.query(
    `INSERT INTO youtube_broadcasts
       (user_id, room_id, battle_id, youtube_broadcast_id, youtube_stream_id,
        stream_name, ingestion_address, title, privacy, scheduled_start,
        watch_url, last_known_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'scheduled')
     RETURNING *`,
    [
      req.user.id, room.id, null, broadcast.id, stream.id,
      ingestion.streamName || null, (ingestion.ingestionAddress || null),
      cleanTitle, cleanPrivacy, when.toISOString(),
      `https://www.youtube.com/watch?v=${broadcast.id}`,
    ]
  );
  res.status(201).json({ broadcast: inserted[0], reused: false });
}));

// ---------------------------------------------------------------------------
// The LIVE page data — exported for server.js to mount at GET /api/live.
// A battle appears LIVE only when YouTube genuinely reports it live;
// upcoming only when a real scheduled broadcast exists with a future start.
// ---------------------------------------------------------------------------
const LIVE_SQL = `
  SELECT b.id, b.title, b.privacy, b.scheduled_start, b.watch_url,
         b.last_known_status, b.last_synced_at,
         u.display_name AS artist_name, u.username AS artist_username,
         r.code AS room_code, r.name AS room_name,
         bt.id AS battle_id, bc.summary_text AS challenge_summary,
         (SELECT string_agg(DISTINCT ou.display_name, ' vs ')
            FROM room_participants orp
            JOIN users ou ON ou.id = orp.user_id
           WHERE orp.room_id = r.id AND orp.user_id <> b.user_id
             AND orp.state IN ('waiting','ready')) AS opponents
    FROM youtube_broadcasts b
    JOIN users u ON u.id = b.user_id
    LEFT JOIN battle_rooms r ON r.id = b.room_id
    LEFT JOIN battles bt ON bt.id = b.battle_id
    LEFT JOIN battle_challenges bc ON bc.battle_id = bt.id
   WHERE b.last_known_status <> 'ended' AND b.last_known_status <> 'failed'
     AND (bt.id IS NULL OR bt.status NOT IN ('complete','cancelled','forfeited','disqualified'))`;

async function liveData() {
  const { rows } = await pool.query(`${LIVE_SQL} ORDER BY b.scheduled_start ASC LIMIT 100`);
  // Genuine verification: when credentials exist, refresh statuses from
  // YouTube (per broadcasting artist). A 'live' status we cannot verify
  // RIGHT NOW (no credentials / no connection) is NEVER advertised — a
  // stored status alone must not put a card in LIVE NOW.
  const { rows: conns } = isConfigured()
    ? await pool.query(`SELECT user_id, access_token FROM youtube_connections WHERE status = 'active'`)
    : { rows: [] };
  const tokensByUser = new Map(conns.map((c) => [String(c.user_id), c.access_token]));
  const synced = [];
  for (const row of rows) {
    const token = tokensByUser.get(String(row.user_id));
    if (token) row.last_known_status = await syncBroadcastRow(row, token);
    if (row.last_known_status === 'live' && !token) continue; // unverifiable → hide
    synced.push(row);
  }
  const now = Date.now();
  const shape = (r) => ({
    id: r.id,
    title: r.title,
    artist: r.artist_name || r.artist_username,
    opponents: r.opponents ? String(r.opponents).split(' vs ') : [],
    challenge: r.challenge_summary || null,
    roomCode: r.room_code,
    roomName: r.room_name,
    platform: 'youtube',
    watchUrl: r.watch_url,
    scheduledStart: r.scheduled_start,
    status: r.last_known_status,
  });
  return {
    live: synced.filter((r) => r.last_known_status === 'live').map(shape),
    upcoming: synced
      .filter((r) => ['scheduled', 'ready'].includes(r.last_known_status)
        && r.scheduled_start && new Date(r.scheduled_start).getTime() > now - 60 * 1000)
      .map(shape),
  };
}

module.exports = { router, liveData, isConfigured };
