'use strict';
/**
 * ============================================================================
 *  ART ARENA™ — v52 · THE ONE NOTIFIER
 * ============================================================================
 *  Inserts a PERSISTENT notification (24 h TTL, swept server-side) and pushes
 *  it over WebSocket to every open socket of that user. Shared by the friends
 *  backend (server.js) and the room/rematch backend (rooms.js) — there is
 *  exactly one notification architecture, never a parallel one.
 */
const { pool } = require('./lib');
const rt = require('./realtime');

async function notifyUser(userId, type, payload) {
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, type, payload) VALUES ($1, $2, $3) RETURNING id, created_at`,
    [userId, type, JSON.stringify(payload || {})]
  );
  rt.sendToUser(userId, {
    type: 'notification',
    notification: { id: rows[0].id, type, payload: payload || {}, created_at: rows[0].created_at },
  });
  return rows[0];
}

module.exports = { notifyUser };
