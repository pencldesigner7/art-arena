'use strict';
/**
 * ============================================================================
 *  ART ARENA™ — v35 · MATCHMAKING (the "Battle" button)
 * ============================================================================
 *  REAL matchmaking on the REAL infrastructure — no simulation:
 *    - the queue is PERSISTED in the pre-existing `matchmaking_queue`
 *      table (one active entry per user via uq_mm_active), so it survives
 *      server restarts and every state change is auditable
 *    - matching is atomic: the oldest other queued user is locked with
 *      FOR UPDATE SKIP LOCKED, a private 1v1 room is created, and both
 *      queue rows flip to 'matched' in ONE transaction
 *    - both players are notified over the SAME real-time hub the rooms
 *      use (rt.sendToUser) — plus a 3 s status poll that picks up the
 *      match even where a proxy kills the WebSocket
 *    - the matched room is auto_start (rooms.js): the battle begins the
 *      moment BOTH artists have picked their canvas — the Randomizer
 *      never runs before both selections exist
 *
 *  "Could Not Find Player" can only happen two ways: the client's 3-minute
 *  timeout (nobody else was actually searching) or a real error response.
 *  If an eligible opponent IS in the queue, the match is created
 *  synchronously the instant they press Battle.
 * ============================================================================
 */
const express = require('express');
const { pool, HttpError, ah, requireAuth, avatarUrlOf } = require('./lib');
const rt = require('./realtime');
const { createMatchRoom, activeRoomOf, pickSeatForJoin, newRoomCode } = require('./rooms'); // v44: shared one-active-seat rule

const router = express.Router();
router.use(requireAuth);

const RECENT_TTL_MS = 30 * 60 * 1000;  // a formed match stays claimable 30 min
const SWEEP_MS = 60 * 1000;
const STALE_QUEUE_MIN = 10;            // older queue rows = abandoned
const MM_TIMEOUT_S = 180;              // v42: the search window is EXACTLY 3 minutes
const DEADLINE_SWEEP_MS = 5 * 1000;    // v42: expiry granularity (<< the window)

// userId -> { room_code, opponent, at } — lets a reconnecting client (or a
// client that missed the WS event) still claim its match via GET /status.
const recent = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function userBrief(userId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.display_name, p.avatar_storage_key, p.updated_at
       FROM users u
       LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE u.id = $1`, [userId]);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    username: r.username,
    display_name: r.display_name,
    avatar_url: avatarUrlOf(r.avatar_storage_key, r.updated_at), // v61: one builder everywhere
  };
}

async function queuedRow(userId, q) {
  const { rows } = await (q || pool).query(
    `SELECT id, queued_at FROM matchmaking_queue
      WHERE user_id = $1 AND status = 'queued'`, [userId]);
  return rows[0] || null;
}

async function queuePosition(userId) {
  const { rows } = await pool.query(
    `SELECT (SELECT count(*) FROM matchmaking_queue q2
              WHERE q2.status = 'queued' AND q2.queued_at <= q1.queued_at)::int AS pos
       FROM matchmaking_queue q1
      WHERE q1.user_id = $1 AND q1.status = 'queued'`, [userId]);
  return rows[0] ? rows[0].pos : 0;
}

// Try to pair `initiator` with the oldest other queued user. The partner row
// is locked (FOR UPDATE SKIP LOCKED) so two concurrent enters can never
// double-pair; room insert + row updates commit as ONE transaction.
async function tryMatch(client, initiator) {
  const { rows } = await client.query(
    `SELECT user_id FROM matchmaking_queue
      WHERE status = 'queued' AND user_id <> $1
      ORDER BY queued_at, id
      LIMIT 1
      FOR UPDATE SKIP LOCKED`, [initiator.id]);
  const otherId = rows[0] && rows[0].user_id;
  if (!otherId) return null;

  // v44 (one active room per artist): a queued artist may have joined a
  // room in another tab since entering the queue — a live seat ANYWHERE
  // makes them ineligible to be paired. Cancel their ghost queue row and
  // try the next candidate; if the INITIATOR is the seated one, stop.
  const oppRoom = await activeRoomOf(otherId, client);
  if (oppRoom) {
    await client.query(
      `UPDATE matchmaking_queue SET status = 'cancelled'
        WHERE user_id = $1 AND status = 'queued'`, [otherId]);
    return tryMatch(client, initiator); // next candidate
  }
  if (await activeRoomOf(initiator.id, client)) return null; // initiator seated mid-enter

  const { rows: pair } = await client.query(
    `SELECT user_id FROM matchmaking_queue
      WHERE status = 'queued' AND user_id IN ($1, $2)
      ORDER BY queued_at, id`, [initiator.id, otherId]);
  if (pair.length < 2) return null;
  const [aId, bId] = pair.map((r) => r.user_id);

  const a = await userBrief(aId);
  const b = await userBrief(bId);
  if (!a || !b) return null;

  const { roomId, code } = await createMatchRoom(a, b, client);
  await client.query(
    `UPDATE matchmaking_queue
        SET status = 'matched', matched_room_id = $3
      WHERE user_id IN ($1, $2) AND status = 'queued'`, [aId, bId, roomId]);
  return { code, a, b };
}

function remember(a, b, code) {
  const now = Date.now();
  recent.set(a.id, {
    room_code: code,
    opponent: { id: b.id, username: b.username, display_name: b.display_name, avatar_url: b.avatar_url },
    at: now,
  });
  recent.set(b.id, {
    room_code: code,
    opponent: { id: a.id, username: a.username, display_name: a.display_name, avatar_url: a.avatar_url },
    at: now,
  });
}

function claimable(userId) {
  const m = recent.get(userId);
  if (!m) return null;
  if (Date.now() - m.at > RECENT_TTL_MS) { recent.delete(userId); return null; }
  return m;
}

// ---------------------------------------------------------------------------
// POST /enter — join the queue; if a partner exists, the match is made
// inside this request (response: { matched:true, room, opponent }).
// Supports mode: '1v1' (default) or '3v3' (team battle).
// ---------------------------------------------------------------------------
router.post('/enter', ah(async (req, res) => {
  const u = req.user;
  const inRoom = await activeRoomOf(u.id);
  if (inRoom) throw new HttpError(409, 'You are already in a room — leave it before matchmaking.');

  const mode = (req.body && req.body.mode === '3v3') ? '3v3' : '1v1';

  // Already matched (missed the WS event / refreshed the page)? Re-claim.
  // v48 fix: the reclaim is only valid while the room still exists — /status
  // already validated this, but /enter did not. A user whose matched room
  // was deleted/closed got instantly "reclaimed" into a DEAD room on every
  // new matchmaking entry (client: instant "Found Player" → room gone).
  // That was a previous session poisoning every new one. Same rule as
  // /status: gone/ended → drop the stale record and queue normally.
  let prev = claimable(u.id);
  if (prev) {
    const { rows } = await pool.query(
      `SELECT status FROM battle_rooms WHERE code = $1`, [prev.room_code]);
    if (!rows[0] || rows[0].status === 'ended') { recent.delete(u.id); prev = null; }
  }
  if (prev) return res.json({ matched: true, room: prev.room_code, opponent: prev.opponent, reclaimed: true, mode });

  if (await queuedRow(u.id))
    throw new HttpError(409, 'You are already searching for an opponent.');

  const client = await pool.connect();
  let m = null;
  let queuedAt = null; // v42: the queue instant — the deadline anchor
  try {
    await client.query('BEGIN');

    if (mode === '3v3') {
      // 3v3 Matchmaking:
      // 1. First, look for an existing open public 3v3 room with free seats in lobby
      const { rows: open3v3 } = await client.query(
        `SELECT r.id, r.code, r.battle_mode, r.max_players,
                (SELECT count(*)::int FROM room_participants rp WHERE rp.room_id = r.id AND rp.state IN ('waiting','ready')) AS player_count
           FROM battle_rooms r
          WHERE r.battle_mode = '3v3' AND r.visibility = 'public' AND r.status = 'lobby'
            AND r.deleted_at IS NULL
          ORDER BY r.created_at ASC
          FOR UPDATE SKIP LOCKED`
      );
      const candidate = open3v3.find((r) => r.player_count < 6);
      if (candidate) {
        const seat = await pickSeatForJoin(client, candidate, u.id);
        if (seat !== null) {
          const { rows: ex } = await client.query(
            `SELECT state FROM room_participants WHERE room_id = $1 AND user_id = $2`,
            [candidate.id, u.id]
          );
          if (ex[0]) {
            await client.query(
              `UPDATE room_participants SET state = 'waiting', left_at = NULL, seat = $3
                WHERE room_id = $1 AND user_id = $2`,
              [candidate.id, u.id, seat]
            );
          } else {
            await client.query(
              `INSERT INTO room_participants (room_id, user_id, state, seat)
               VALUES ($1, $2, 'waiting', $3)`,
              [candidate.id, u.id, seat]
            );
          }
          rt.emitRoom(candidate.code, { action: 'joined', user_id: u.id, username: u.username, display_name: u.display_name, seat });
          rt.broadcastRoomsList('joined');
          await client.query('COMMIT');
          return res.json({ matched: true, room: candidate.code, mode: '3v3' });
        }
      }

      // 2. If no open room, look for other 3v3 searchers in queue or create a new public 3v3 room
      const { rows: queued3v3 } = await client.query(
        `SELECT user_id FROM matchmaking_queue
          WHERE status = 'queued' AND user_id <> $1 AND (prefs->>'battle_mode') = '3v3'
          ORDER BY queued_at, id
          LIMIT 1
          FOR UPDATE SKIP LOCKED`, [u.id]
      );
      const other3v3Id = queued3v3[0] && queued3v3[0].user_id;
      let other3v3User = null;
      if (other3v3Id) {
        const otherRoom = await activeRoomOf(other3v3Id, client);
        if (otherRoom) {
          await client.query(
            `UPDATE matchmaking_queue SET status = 'cancelled' WHERE user_id = $1 AND status = 'queued'`,
            [other3v3Id]
          );
        } else {
          other3v3User = await userBrief(other3v3Id);
        }
      }

      let code3v3, room3v3Id;
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          code3v3 = newRoomCode();
          const { rows } = await client.query(
            `INSERT INTO battle_rooms (code, host_id, name, room_type, visibility, max_players,
                                       time_limit_seconds, result_method, battle_mode, auto_start,
                                       randomizer_config)
             VALUES ($1, $2, '3v3 Team Arena', 'casual', 'public', 6, 3600, 'voting_community', '3v3', false,
                     '{"categories":["character","environment","object","style"]}'::jsonb)
             RETURNING id`,
            [code3v3, u.id]
          );
          room3v3Id = rows[0].id;
          break;
        } catch (e) {
          if (e.code !== '23505') throw e;
        }
      }

      await client.query(
        `INSERT INTO room_participants (room_id, user_id, state, seat)
         VALUES ($1, $2, 'waiting', 1)`,
        [room3v3Id, u.id]
      );

      if (other3v3User) {
        await client.query(
          `INSERT INTO room_participants (room_id, user_id, state, seat)
           VALUES ($1, $2, 'waiting', 4)`,
          [room3v3Id, other3v3User.id]
        );
        await client.query(
          `UPDATE matchmaking_queue SET status = 'matched', matched_room_id = $2
            WHERE user_id = $1 AND status = 'queued'`, [other3v3User.id, room3v3Id]
        );
        rt.sendToUser(other3v3User.id, { type: 'matchmaking', action: 'found', room: code3v3, mode: '3v3' });
      }

      rt.broadcastRoomsList('created');
      await client.query('COMMIT');
      return res.json({ matched: true, room: code3v3, mode: '3v3' });
    }

    // 1v1 Matchmaking (default)
    await client.query(
      `INSERT INTO matchmaking_queue (user_id, prefs)
       VALUES ($1, $2::jsonb)`,
      [u.id, JSON.stringify({ competition_type: 'casual', format: 'one_on_one', battle_mode: '1v1', time_limit_seconds: 1200 })]
    );
    // v42: the deadline anchor — the client countdown and the server expiry
    // are BOTH derived from this exact queued_at instant (+ 180 s).
    const { rows: qRows } = await client.query(
      `SELECT queued_at FROM matchmaking_queue WHERE user_id = $1 AND status = 'queued'`, [u.id]);
    queuedAt = qRows[0] ? qRows[0].queued_at : null;
    m = await tryMatch(client, u);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  if (m) {
    remember(m.a, m.b, m.code);
    // Live notification over the same real-time hub the rooms use.
    rt.sendToUser(m.a.id, { type: 'matchmaking', action: 'found', room: m.code, opponent: m.b, mode: '1v1' });
    rt.sendToUser(m.b.id, { type: 'matchmaking', action: 'found', room: m.code, opponent: m.a, mode: '1v1' });
    const opponent = m.a.id === u.id ? m.b : m.a;
    return res.json({ matched: true, room: m.code, opponent, mode: '1v1' });
  }
  res.json({
    matched: false,
    in_queue: true,
    mode: '1v1',
    position: await queuePosition(u.id),
    queued_at: queuedAt ? queuedAt.toISOString() : null,          // v42: anchor
    deadline_at: queuedAt
      ? new Date(queuedAt.getTime() + MM_TIMEOUT_S * 1000).toISOString()
      : null,                                                     // v42: + exactly 180 s
  });
}));

// ---------------------------------------------------------------------------
// GET /status — searching? claimable match? (the client polls every 3 s;
// this is what makes matchmaking work even when the proxy kills the WS)
// ---------------------------------------------------------------------------
router.get('/status', ah(async (req, res) => {
  const q = await queuedRow(req.user.id);
  let match = claimable(req.user.id);
  if (match) {
    // The room must still be around (it can be closed/deleted).
    const { rows } = await pool.query(
      `SELECT status FROM battle_rooms WHERE code = $1`, [match.room_code]);
    if (!rows[0] || rows[0].status === 'ended') { recent.delete(req.user.id); match = null; }
  }
  res.json({
    in_queue: !!q,
    queued_at: q ? q.queued_at : null,
    deadline_at: q
      ? new Date(new Date(q.queued_at).getTime() + MM_TIMEOUT_S * 1000).toISOString()
      : null, // v42: the client derives its countdown from this
    position: q ? await queuePosition(req.user.id) : 0,
    match,
  });
}));

// ---------------------------------------------------------------------------
// POST /cancel — leave the queue (or, if already matched, leave the room)
// ---------------------------------------------------------------------------
router.post('/cancel', ah(async (req, res) => {
  const u = req.user;
  const q = await queuedRow(u.id);
  if (q) {
    await pool.query(`UPDATE matchmaking_queue SET status = 'cancelled' WHERE id = $1`, [q.id]);
    recent.delete(u.id);
    return res.json({ ok: true, canceled: 'queue' });
  }
  const m = claimable(u.id);
  if (m) {
    await pool.query(
      `UPDATE room_participants SET state = 'left', left_at = now()
        WHERE room_id = (SELECT id FROM battle_rooms WHERE code = $1)
          AND user_id = $2 AND state IN ('waiting','ready')`, [m.room_code, u.id]);
    recent.delete(u.id);
    // Tell the partner (their client may not be in the room channel yet).
    rt.sendToUser(m.opponent.id, {
      type: 'matchmaking', action: 'opponent_left', room: m.room_code, username: u.username,
    });
    // If nobody is left, the room ends itself.
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM room_participants
        WHERE room_id = (SELECT id FROM battle_rooms WHERE code = $1)
          AND state IN ('waiting','ready')`, [m.room_code]);
    if (rows[0].n === 0) {
      await pool.query(
        `UPDATE battle_rooms SET status = 'ended', ended_at = now()
          WHERE code = $1 AND status = 'lobby'`, [m.room_code]);
    }
    return res.json({ ok: true, canceled: 'room' });
  }
  throw new HttpError(404, 'You are not in matchmaking.');
}));

// ---------------------------------------------------------------------------
// Real-time hook (wired in realtime.js): a closed socket = the artist is
// gone. Cancel their QUEUE entry — searching is an active intent. A FORMED
// match survives: it stays claimable for 30 min so a dropped connection can
// reconnect and re-enter the room via GET /status.
// ---------------------------------------------------------------------------
async function handleDisconnect(userId) {
  try {
    const q = await queuedRow(userId);
    if (q) await pool.query(`UPDATE matchmaking_queue SET status = 'cancelled' WHERE id = $1`, [q.id]);
  } catch (_) { /* best effort (server shutdown) */ }
}

// Abandoned queue rows (client vanished without a clean close) expire after
// STALE_QUEUE_MIN so they never pair a live artist with a ghost.
const sweep = setInterval(() => {
  pool.query(
    `UPDATE matchmaking_queue SET status = 'expired'
      WHERE status = 'queued' AND queued_at < now() - make_interval(mins => $1)`,
    [STALE_QUEUE_MIN]
  ).catch(() => {});
}, SWEEP_MS);
sweep.unref();

// v42: the search window is EXACTLY 180 s from queued_at — the SAME anchor
// the client's countdown derives from. Rows past the deadline are expired
// here (at most DEADLINE_SWEEP_MS late) and the searcher is told in real
// time over the hub; the client's own deadline check is the fallback when
// the WS is down. Neither side can end the session early.
const deadlineSweep = setInterval(() => {
  pool.query(
    `UPDATE matchmaking_queue SET status = 'expired'
      WHERE status = 'queued' AND queued_at < now() - make_interval(secs => $1)
      RETURNING user_id`,
    [MM_TIMEOUT_S]
  ).then(({ rows }) => {
    for (const r of rows) {
      try { rt.sendToUser(r.user_id, { type: 'matchmaking', action: 'timeout' }); } catch (_) {}
    }
  }).catch(() => {});
}, DEADLINE_SWEEP_MS);
deadlineSweep.unref();

module.exports = { router, handleDisconnect };
