'use strict';
/**
 * ============================================================================
 *  ART ARENA™ — PHASE 5 · REAL-TIME COMMUNICATION
 * ============================================================================
 *  A WebSocket hub attached to the SAME HTTP server (no second port):
 *
 *      ws(s)://<host>/api/realtime?arena_token=<session token>
 *
 *  Authentication uses the exact same session tokens as the REST API
 *  (lib.sessionUser — Bearer header or ?arena_token; the query channel is
 *  the one proven to survive the preview proxy chain). Bad/expired
 *  sessions and inactive accounts are rejected with close code 4401.
 *
 *  Protocol (JSON text frames):
 *    client → server
 *      { type:'subscribe',   room:'48291' }   // a room code, or 'lobby'
 *      { type:'unsubscribe', room:'48291' }
 *    server → client
 *      { type:'hello', user:{ id, username, display_name } }
 *      { type:'subscribed',   room:'48291' }
 *      { type:'unsubscribed', room:'48291' }
 *      { type:'room.event', room:'48291',
 *          event:{ action, username, display_name, seat? } }
 *      { type:'rooms.list', reason:'created' | 'closed' }
 *      { type:'error', error:'…' }
 *
 *  The 'lobby' channel is the global channel — it carries rooms-list
 *  refreshes whenever a public room is created or closed, so the room
 *  list is live as well.
 *
 *  Feature routers (rooms.js today, the battle engine tomorrow) call
 *  emitRoom() / broadcastRoomsList() right after every state change.
 *  Clients treat the REST payload as the single source of truth: on an
 *  event they re-fetch the room and toast what changed. The existing 2.5s
 *  polling fallback keeps the app correct even where a proxy refuses the
 *  WebSocket upgrade.
 *
 *  A 30s ping/pong heartbeat prunes dead sockets.
 * ============================================================================
 */
const { WebSocketServer } = require('ws');
const { DEV, sessionUser } = require('./lib');

const HEARTBEAT_MS = 30000;      // prune dead sockets
const MAX_SUBS_PER_CLIENT = 8;
const LOBBY_CHANNEL = 'lobby';

let wss = null;
const clients = new Set();       // { ws, user, subs:Set<string>, alive }

// ---------------------------------------------------------------------------
// Public API — feature routers call these right after a state change.
// ---------------------------------------------------------------------------

/** Emit a fine-grained event to everyone subscribed to this room. */
function emitRoom(roomCode, event) {
  broadcast(roomCode, { type: 'room.event', room: roomCode, event });
}

/** Tell every 'lobby' subscriber that the room list changed. */
function broadcastRoomsList(reason) {
  broadcast(LOBBY_CHANNEL, { type: 'rooms.list', reason: reason || 'updated' });
}

/** v35: deliver a message to ALL open sockets of one specific user
    (matchmaking notifies both matched artists over the same hub). */
function sendToUser(userId, obj) {
  const data = JSON.stringify(obj);
  let delivered = 0;
  for (const c of clients) {
    if (c.user && c.user.id === userId && c.ws.readyState === 1) {
      try { c.ws.send(data); delivered++; } catch (_) { /* pruned by heartbeat */ }
    }
  }
  if (DEV) console.log(`  ⚡ rt ${obj && obj.type} → user:${String(userId).slice(0, 8)}… (delivered=${delivered})`);
}

/** v61: presence — true while the user has at least one open socket. */
function isUserOnline(userId) {
  for (const c of clients) if (c.user && c.user.id === userId && c.ws.readyState === 1) return true;
  return false;
}

function broadcast(channel, message) {
  const data = JSON.stringify(message);
  let delivered = 0;
  for (const c of clients) {
    if (c.subs.has(channel) && c.ws.readyState === 1) {
      try { c.ws.send(data); delivered++; } catch (_) { /* pruned by heartbeat */ }
    }
  }
  if (DEV) console.log(`  ⚡ rt ${message.type} → ${channel} (delivered=${delivered})`);
}

function send(c, obj) {
  try { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(obj)); } catch (_) {}
}

// ---------------------------------------------------------------------------
// Connection handling
// ---------------------------------------------------------------------------

async function userForUpgrade(req) {
  // Build the shape lib.sessionUser expects (headers + query + originalUrl)
  // from the raw upgrade request. Tokens may ride the Bearer header or the
  // ?arena_token query param — the query param is what survives the proxy.
  const url = new URL(req.url, 'http://localhost');
  return sessionUser({
    headers: req.headers,
    query: Object.fromEntries(url.searchParams.entries()),
    originalUrl: req.url,
  });
}

async function handleMessage(c, raw, canViewRoom) {
  let msg;
  try { msg = JSON.parse(raw.toString()); }
  catch (_) { return send(c, { type: 'error', error: 'Bad message.' }); }
  if (DEV) console.log(`  ⚡ msg from @${c.user.username}: ${msg && msg.type}${msg && msg.room ? ' ' + msg.room : ''}`);
  if (!msg || typeof msg.type !== 'string') {
    return send(c, { type: 'error', error: 'Bad message.' });
  }

  if (msg.type === 'subscribe' && typeof msg.room === 'string'
      && msg.room.length > 0 && msg.room.length <= 20) {
    const channel = msg.room;
    if (c.subs.has(channel)) return;
    if (c.subs.size >= MAX_SUBS_PER_CLIENT) {
      return send(c, { type: 'error', error: 'Too many subscriptions.' });
    }
    if (channel !== LOBBY_CHANNEL) {
      let access;
      try { access = await canViewRoom(channel, c.user); }
      catch (_) { access = { ok: false, reason: 'You cannot view that room.' }; }
      if (!access || !access.ok) {
        return send(c, {
          type: 'error',
          error: (access && access.reason) || 'You cannot view that room.',
        });
      }
    }
    c.subs.add(channel);
    send(c, { type: 'subscribed', room: channel });
    if (DEV) console.log(`  ⚡ @${c.user.username} sub +${channel}`);
    return;
  }

  if (msg.type === 'unsubscribe' && typeof msg.room === 'string') {
    if (c.subs.delete(msg.room)) {
      send(c, { type: 'unsubscribed', room: msg.room });
      if (DEV) console.log(`  ⚡ @${c.user.username} sub -${msg.room}`);
    }
  }
}

function initRealtime(httpServer, opts = {}) {
  const canViewRoom = opts.canViewRoom || (async () => ({ ok: true }));
  const onUserDisconnect = opts.onUserDisconnect || null; // v35: matchmaking

  wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  // Only /api/realtime is a WebSocket endpoint in this app; any other
  // upgrade attempt is destroyed (there is nothing else to upgrade to).
  httpServer.on('upgrade', (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; }
    catch (_) { pathname = ''; }
    if (pathname !== '/api/realtime') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    // The client fires `open` and typically sends its first `subscribe`
    // immediately, which can reach us WHILE the session lookup below is
    // still in flight. Listeners must be attached up front and early frames
    // queued, or they are parsed with no 'message' handler and silently lost.
    const c = { ws, user: null, subs: new Set(), alive: true, ready: false, queue: [] };
    clients.add(c);

    ws.on('message', (raw) => {
      if (!c.ready) { c.queue.push(raw); return; } // session still resolving
      handleMessage(c, raw, canViewRoom);
    });
    ws.on('pong', () => { c.alive = true; });
    ws.on('close', () => {
      clients.delete(c);
      if (c.user && onUserDisconnect) Promise.resolve(onUserDisconnect(c.user.id)).catch(() => {});
      if (DEV) console.log(`  ⚡ ws disconnect @${c.user ? c.user.username : 'unauth'}`);
    });
    ws.on('error', () => { try { ws.terminate(); } catch (_) {} });

    (async () => {
      let user = null;
      try { user = await userForUpgrade(req); } catch (_) { user = null; }
      if (!user || user.account_status !== 'active') {
        if (DEV) console.log('  ! ws rejected: bad/expired session or inactive account');
        clients.delete(c);
        send(c, { type: 'error', error: 'Not authenticated.' });
        try { ws.close(4401, 'unauthorized'); } catch (_) {}
        return;
      }
      c.user = user;
      if (DEV) console.log(`  ⚡ ws connect @${user.username}`);
      send(c, {
        type: 'hello',
        user: { id: user.id, username: user.username, display_name: user.display_name },
      });
      // Session resolved — flush anything that arrived while we were looking.
      c.ready = true;
      const pending = c.queue;
      c.queue = [];
      for (const raw of pending) handleMessage(c, raw, canViewRoom);
    })();
  });

  const hb = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) {
        try { c.ws.terminate(); } catch (_) {}
        clients.delete(c);
        continue;
      }
      c.alive = false;
      try { c.ws.ping(); } catch (_) {}
    }
  }, HEARTBEAT_MS);
  hb.unref();

  if (DEV) console.log('RT realtime hub: WebSocket endpoint /api/realtime ready');
}

function closeRealtime() {
  if (!wss) return;
  for (const c of clients) {
    try { c.ws.close(1001, 'server shutting down'); } catch (_) {}
  }
  clients.clear();
  wss.close();
  wss = null;
}

module.exports = { initRealtime, closeRealtime, emitRoom, broadcastRoomsList, sendToUser, isUserOnline, LOBBY_CHANNEL };
