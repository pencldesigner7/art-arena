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
  // v73 phase 7: mutes and blocks are server-enforced on the notification
  // path too — a muted or blocked actor never reaches your bell.
  const from = payload && payload.actor;
  if (from && from !== userId) {
    const { rows } = await pool.query(
      `SELECT 1 FROM mutes WHERE muter_id = $1 AND muted_id = $2
       UNION ALL
       SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
      [userId, from]);
    if (rows[0]) return null;
  }
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

// v73 COMMUNITY phase 5: a stream that GENUINELY flipped to live notifies the
// artist's Community followers — real states only, never scheduled/hyped.
async function notifyLiveStart(userId, platform, title) {
  const { rows: [u] } = await pool.query(`SELECT username, display_name FROM users WHERE id = $1`, [userId]);
  if (!u) return;
  const { rows: f } = await pool.query(`SELECT follower_id FROM follows WHERE following_id = $1`, [userId]);
  for (const r of f)
    await notifyUser(r.follower_id, 'livestream_start', {
      username: u.username, display_name: u.display_name, platform, title: title || null, actor: userId,
    });
}

module.exports = { notifyUser, notifyLiveStart };
