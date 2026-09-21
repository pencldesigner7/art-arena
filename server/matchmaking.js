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
  // v67: mode-aware pairing — 3v3 searchers now live in the SAME queue, so a
  // 1v1 enter must never pull a 3v3 row (and vice-versa: the 3v3 branch below
  // filters FOR '3v3'). Legacy rows without a battle_mode are treated as 1v1.
  // v68: only 1v1 rows may pair here — 3v3 AND tournament rows live in the
  // same queue table and must never be pulled into a 1v1 match.
  const { rows } = await client.query(
    `SELECT user_id FROM matchmaking_queue
      WHERE status = 'queued' AND user_id <> $1
        AND COALESCE(prefs->>'battle_mode', '1v1') = '1v1'
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

// v67: the claimable-match record carries the battle_mode (the client's
// /status poll reads match.battle_mode) and `b` may be null for 3v3 — a team
// match has no single opponent, the ROOM is the connection.
function remember(a, b, code, mode) {
  const now = Date.now();
  const pub = (x) => (x ? { id: x.id, username: x.username, display_name: x.display_name, avatar_url: x.avatar_url } : null);
  recent.set(a.id, {
    room_code: code,
    opponent: pub(b),
    battle_mode: mode || '1v1',
    at: now,
  });
  if (b) {
    recent.set(b.id, {
      room_code: code,
      opponent: pub(a),
      battle_mode: mode || '1v1',
      at: now,
    });
  }
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

  // v68: three real modes — 1v1 (default), 3v3 team battle and PUBLIC
  // TOURNAMENT discovery (join an existing open bracket event; never a
  // fake head-to-head match).
  const reqMode = (req.body && req.body.mode) || '1v1';
  const mode = ['3v3', 'tournament'].includes(reqMode) ? reqMode : '1v1';

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
  // v67: the reclaim reports the MATCH's own mode — a claimable 3v3 room
  // stays 3v3 even if the artist re-enters from the 1v1 button.
  if (prev) {
    const prevMode = prev.battle_mode || mode;
    return res.json({ matched: true, room: prev.room_code, opponent: prev.opponent, reclaimed: true, mode: prevMode, battle_mode: prevMode });
  }

  if (await queuedRow(u.id))
    throw new HttpError(409, 'You are already searching for an opponent.');

  const client = await pool.connect();
  let m = null;
  // v67: 3v3 outcomes — exactly one of these is set when the mode is 3v3.
  // joined3 = seated into an existing open public room (a REAL connection);
  // m3      = paired with another queued 3v3 searcher into a NEW shared room;
  // search3 = nobody to connect to → honestly queued (matched:false).
  let joined3 = null, m3 = null, search3 = null;
  // v68: tournament outcomes — joinedT = seated into an existing open public
  // tournament; searchT = honestly queued until one appears (deadline sweeper
  // keeps trying to seat queued tournament searchers before expiring them).
  let joinedT = null, searchT = null;
  let queuedAt = null; // v42: the queue instant — the deadline anchor
  try {
    await client.query('BEGIN');

    if (mode === '3v3') {
      // 3v3 Matchmaking (v67 — REAL connections only):
      // 1. First, look for an existing open public 3v3 room with free seats in
      //    lobby — joining it IS a real connection (there is already at least
      //    one seated artist inside).
      const { rows: open3v3 } = await client.query(
        `SELECT r.id, r.code, r.battle_mode, r.max_players,
                (SELECT count(*)::int FROM room_participants rp WHERE rp.room_id = r.id AND rp.state IN ('waiting','ready')) AS player_count
           FROM battle_rooms r
          WHERE r.battle_mode = '3v3' AND r.visibility = 'public' AND r.status = 'lobby'
            AND r.deleted_at IS NULL
          ORDER BY r.created_at ASC
          FOR UPDATE SKIP LOCKED`
      );
      const candidate = open3v3.find((r) => r.player_count < 6 && r.player_count > 0);
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
          joined3 = { code: candidate.code, seat };
          await client.query('COMMIT');
        }
      }

      if (!joined3) {
        // 2. No room to join → the REAL queue (same table, deadline anchor and
        //    sweeper as 1v1). A solo 3v3 searcher is NEVER placed in a room of
        //    their own and NEVER told "matched" — that was the old bug that
        //    reported "Connected" for a single player.
        await client.query(
          `INSERT INTO matchmaking_queue (user_id, prefs)
           VALUES ($1, $2::jsonb)`,
          [u.id, JSON.stringify({ competition_type: 'casual', format: 'three_on_three', battle_mode: '3v3', time_limit_seconds: 3600 })]
        );
        const { rows: q3 } = await client.query(
          `SELECT queued_at FROM matchmaking_queue WHERE user_id = $1 AND status = 'queued'`, [u.id]);
        queuedAt = q3[0] ? q3[0].queued_at : null;

        // 3. Pair with the oldest OTHER queued 3v3 searcher (locked row — two
        //    concurrent enters can never double-pair).
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
            // ghost row — that artist joined a room elsewhere since queueing
            await client.query(
              `UPDATE matchmaking_queue SET status = 'cancelled' WHERE user_id = $1 AND status = 'queued'`,
              [other3v3Id]
            );
          } else {
            other3v3User = await userBrief(other3v3Id);
          }
        }

        if (other3v3User) {
          // REAL MATCH: ONE shared public 3v3 room seats BOTH searchers
          // (seat 1 = team A side, seat 4 = team B side). The remaining four
          // seats stay open — the next 3v3 searcher joins this room via
          // step 1, so the teams genuinely fill up.
          let code3v3 = null, room3v3Id = null;
          for (let attempt = 0; attempt < 10; attempt++) {
            try {
              code3v3 = newRoomCode();
              const { rows } = await client.query(
                `INSERT INTO battle_rooms (code, host_id, name, room_type, visibility, max_players,
                                           time_limit_seconds, result_method, battle_mode, auto_start,
                                           origin, randomizer_config)
                 VALUES ($1, $2, '3v3 Team Arena', 'casual', 'public', 6, 3600, 'voting_community', '3v3', false,
                         'matchmaking', '{"categories":["character","environment","object","style"]}'::jsonb)
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
             VALUES ($1, $2, 'waiting', 1), ($1, $3, 'waiting', 4)`,
            [room3v3Id, u.id, other3v3User.id]
          );
          await client.query(
            `UPDATE matchmaking_queue SET status = 'matched', matched_room_id = $2
              WHERE user_id IN ($1, $3) AND status = 'queued'`, [u.id, room3v3Id, other3v3User.id]
          );
          m3 = { code: code3v3, other: other3v3User };
          await client.query('COMMIT');
        } else {
          // Nobody to pair with — stay queued. The 180 s deadline sweeper
          // expires the row and pushes the timed-out state; GET /status keeps
          // reporting in_queue + deadline for the client's own countdown.
          await client.query('COMMIT');
          search3 = {
            matched: false,
            in_queue: true,
            mode: '3v3',
            battle_mode: '3v3',
            position: await queuePosition(u.id),
            queued_at: queuedAt ? queuedAt.toISOString() : null,
            deadline_at: queuedAt
              ? new Date(queuedAt.getTime() + MM_TIMEOUT_S * 1000).toISOString()
              : null,
          };
        }
      }
    }

    else if (mode === 'tournament') {
      // v68: TOURNAMENT discovery — the artist is looking for an existing
      // PUBLIC tournament to join, not a head-to-head opponent. Only lobby
      // rooms whose bracket has NOT been seeded yet are joinable (the roster
      // locks at the draw — rooms.js enforces the same rule on /join).
      const { rows: openT } = await client.query(
        `SELECT r.id, r.code, r.max_players,
                (SELECT count(*)::int FROM room_participants rp WHERE rp.room_id = r.id AND rp.state IN ('waiting','ready')) AS player_count
           FROM battle_rooms r
          WHERE r.battle_mode = 'tournament' AND r.visibility = 'public' AND r.status = 'lobby'
            AND r.bracket IS NULL AND r.deleted_at IS NULL
          ORDER BY r.created_at ASC
          FOR UPDATE SKIP LOCKED`
      );
      const candT = openT.find((r) => r.player_count < r.max_players);
      if (candT) {
        const seat = await pickSeatForJoin(client, candT, u.id);
        if (seat !== null) {
          const { rows: ex } = await client.query(
            `SELECT state FROM room_participants WHERE room_id = $1 AND user_id = $2`,
            [candT.id, u.id]
          );
          if (ex[0]) {
            await client.query(
              `UPDATE room_participants SET state = 'waiting', left_at = NULL, seat = $3
                WHERE room_id = $1 AND user_id = $2`,
              [candT.id, u.id, seat]
            );
          } else {
            await client.query(
              `INSERT INTO room_participants (room_id, user_id, state, seat)
               VALUES ($1, $2, 'waiting', $3)`,
              [candT.id, u.id, seat]
            );
          }
          joinedT = { code: candT.code, seat };
          await client.query('COMMIT');
        }
      }
      if (!joinedT) {
        // No open public tournament right now → the REAL queue. The 5 s
        // deadline sweeper re-offers queued tournament searchers to every
        // newly created/opened public tournament before expiring anyone.
        await client.query(
          `INSERT INTO matchmaking_queue (user_id, prefs)
           VALUES ($1, $2::jsonb)`,
          [u.id, JSON.stringify({ competition_type: 'casual', format: 'tournament', battle_mode: 'tournament', time_limit_seconds: 1200 })]
        );
        const { rows: qT } = await client.query(
          `SELECT queued_at FROM matchmaking_queue WHERE user_id = $1 AND status = 'queued'`, [u.id]);
        queuedAt = qT[0] ? qT[0].queued_at : null;
        await client.query('COMMIT');
        searchT = {
          matched: false,
          in_queue: true,
          mode: 'tournament',
          battle_mode: 'tournament',
          position: await queuePosition(u.id),
          queued_at: queuedAt ? queuedAt.toISOString() : null,
          deadline_at: queuedAt
            ? new Date(queuedAt.getTime() + MM_TIMEOUT_S * 1000).toISOString()
            : null,
        };
      }
    }

    else {
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
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  // v67: 3v3 outcomes — side effects run AFTER the commit so a notified
  // client can never race the room row into existence.
  if (joined3) {
    rt.emitRoom(joined3.code, { action: 'joined', user_id: u.id, username: u.username, display_name: u.display_name, seat: joined3.seat });
    rt.broadcastRoomsList('joined');
    return res.json({ matched: true, room: joined3.code, mode: '3v3', battle_mode: '3v3' });
  }
  if (m3) {
    remember(u, m3.other, m3.code, '3v3');
    rt.sendToUser(m3.other.id, { type: 'matchmaking', action: 'found', room: m3.code, mode: '3v3', battle_mode: '3v3' });
    rt.broadcastRoomsList('created');
    return res.json({ matched: true, room: m3.code, mode: '3v3', battle_mode: '3v3' });
  }
  if (search3) return res.json(search3);

  // v68: tournament outcomes — same post-COMMIT discipline as 3v3.
  if (joinedT) {
    rt.emitRoom(joinedT.code, { action: 'joined', user_id: u.id, username: u.username, display_name: u.display_name, seat: joinedT.seat });
    rt.broadcastRoomsList('joined');
    return res.json({ matched: true, room: joinedT.code, mode: 'tournament', battle_mode: 'tournament' });
  }
  if (searchT) return res.json(searchT);

  if (m) {
    remember(m.a, m.b, m.code, '1v1');
    // Live notification over the same real-time hub the rooms use.
    rt.sendToUser(m.a.id, { type: 'matchmaking', action: 'found', room: m.code, opponent: m.b, mode: '1v1', battle_mode: '1v1' });
    rt.sendToUser(m.b.id, { type: 'matchmaking', action: 'found', room: m.code, opponent: m.a, mode: '1v1', battle_mode: '1v1' });
    const opponent = m.a.id === u.id ? m.b : m.a;
    return res.json({ matched: true, room: m.code, opponent, mode: '1v1', battle_mode: '1v1' });
  }
  res.json({
    matched: false,
    in_queue: true,
    mode: '1v1',
    battle_mode: '1v1',
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
  // v69 (item 1): the searcher's OWN pending team invites — the server truth
  // the [+] slots restore from after a refresh (first invite → slot 1, second
  // → slot 2, in send order). Only unhandled invites count; declined/expired/
  // accepted ones are already reflected in the room/match state.
  let pendingTeamInvites = [];
  // v69 (item 1): the queued mode travels with the status so a client that
  // lost its local search state (refresh, nav round-trip) can ADOPT the live
  // queue row instead of fighting it with a doomed POST /enter.
  let qMode = null;
  if (q) {
    const { rows: mrow } = await pool.query(
      `SELECT prefs->>'battle_mode' AS mode FROM matchmaking_queue WHERE id = $1`, [q.id]);
    qMode = (mrow[0] && mrow[0].mode) || '1v1';
  }
  if (q) {
    const { rows: inv } = await pool.query(
      `SELECT n.id, n.user_id AS to_user_id, u.username, u.display_name
         FROM notifications n JOIN users u ON u.id = n.user_id
        WHERE n.type = 'mm_team_invite' AND n.payload->>'handled' IS NULL
          AND n.payload->>'from_user_id' = $1
          AND (SELECT prefs->>'battle_mode' FROM matchmaking_queue mq
                WHERE mq.id = $2) = '3v3'
        ORDER BY n.created_at`,
      [req.user.id, q.id]);
    pendingTeamInvites = inv.map((r) => ({
      id: r.id, to_user_id: r.to_user_id, username: r.username, display_name: r.display_name,
    }));
  }
  res.json({
    in_queue: !!q,
    mode: qMode, // v69 (item 1)
    queued_at: q ? q.queued_at : null,
    deadline_at: q
      ? new Date(new Date(q.queued_at).getTime() + MM_TIMEOUT_S * 1000).toISOString()
      : null, // v42: the client derives its countdown from this
    position: q ? await queuePosition(req.user.id) : 0,
    match,
    pending_team_invites: pendingTeamInvites, // v69 (item 1)
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
    // v68: a cancelled search invalidates its pending 3v3 team invitations —
    // an accept after this point gets the honest "that search has ended".
    await pool.query(
      `UPDATE notifications SET payload = payload || '{"handled":"expired"}'::jsonb
        WHERE type = 'mm_team_invite' AND payload->>'from_user_id' = $1 AND payload->>'handled' IS NULL`,
      [u.id]
    ).catch(() => {});
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
    // v67: 3v3 matches have no single opponent (opponent: null) — the room
    // channel itself carries the leave event to any teammates inside.
    if (m.opponent) {
      rt.sendToUser(m.opponent.id, {
        type: 'matchmaking', action: 'opponent_left', room: m.room_code, username: u.username,
      });
    }
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
// v68: 3v3 TEAM INVITES DURING MATCHMAKING — the two [+] slots on the
// searching screen. Built on the EXISTING friend system (friendship check +
// the one notification architecture); no parallel friend mechanism.
//   POST /team-invite            { friend_id }  → notification 'mm_team_invite'
//   POST /team-invite/:id/accept → the friend really joins: seats into the
//                                  inviter's 3v3 lobby room if one exists,
//                                  otherwise the inviter's live queue search
//                                  becomes a shared public 3v3 room seating
//                                  BOTH (inviter seat 1, friend seat 2 — one
//                                  side). Everyone is notified over the hub.
//   POST /team-invite/:id/decline
// ---------------------------------------------------------------------------
const MM_INVITE_WINDOW_H = 2; // invitations live as long as room invitations

router.post('/team-invite', ah(async (req, res) => {
  const u = req.user;
  const fid = String((req.body || {}).friend_id || '');
  if (!/^[0-9a-f-]{36}$/i.test(fid)) throw new HttpError(400, 'Pick a friend to invite.');
  if (fid === u.id) throw new HttpError(400, 'You cannot invite yourself.');
  const { areFriends } = require('./friends');
  if (!(await areFriends(u.id, fid))) throw new HttpError(403, 'You can only invite friends.');

  // My search state: queued for 3v3, OR already sitting in a 3v3 lobby room
  // that a previous accepted invite created (the second [+] slot case).
  const myRoom = await activeRoomOf(u.id);
  const { rows: qRows } = await pool.query(
    `SELECT prefs FROM matchmaking_queue WHERE user_id = $1 AND status = 'queued'`, [u.id]);
  const queued3v3 = qRows[0] && (qRows[0].prefs || {}).battle_mode === '3v3';
  if (myRoom && myRoom.battle_mode !== '3v3')
    throw new HttpError(409, 'Team invites are for 3v3 battles only.');
  if (!myRoom && !queued3v3)
    throw new HttpError(409, 'Start a 3v3 search before inviting teammates.');

  // The friend must be able to actually join: not seated anywhere else.
  const { rows: frSeat } = await pool.query(
    `SELECT u.username FROM users u JOIN room_participants rp ON rp.user_id = u.id
      WHERE u.id = $1 AND rp.state IN ('waiting','ready')
      LIMIT 1`, [fid]);
  if (frSeat[0])
    throw new HttpError(409, '@' + frSeat[0].username + ' is already in a room — they need to leave it before you can invite them.');

  // One open invite per (inviter, friend) — no duplicates.
  const { rows: dup } = await pool.query(
    `SELECT id FROM notifications
      WHERE user_id = $1 AND type = 'mm_team_invite' AND payload->>'from_user_id' = $2
        AND payload->>'handled' IS NULL AND created_at > now() - make_interval(hours => $3)`,
    [fid, u.id, MM_INVITE_WINDOW_H]);
  if (dup[0]) throw new HttpError(409, 'That friend already has an open team invite from you.');
  // The same person can never hold two pending invites from me (covered by
  // the dup check) AND can never be invited twice INTO the same side: the
  // side capacity below counts pending invites as claimed slots.

  // Side capacity: my side holds 3 (me + 2 teammates). Count seated teammates
  // (same side as me) + my pending invites.
  let sideCount = 1; // me
  if (myRoom) {
    const { rows: mySeat } = await pool.query(
      `SELECT seat FROM room_participants WHERE room_id = $1 AND user_id = $2 AND state IN ('waiting','ready')`,
      [myRoom.id, u.id]);
    const mySide = mySeat[0] && mySeat[0].seat <= 3 ? 'A' : 'B';
    const { rows: mates } = await pool.query(
      `SELECT seat FROM room_participants
        WHERE room_id = $1 AND user_id <> $2 AND state IN ('waiting','ready')`, [myRoom.id, u.id]);
    sideCount += mates.filter((m) => (mySide === 'A' ? m.seat <= 3 : m.seat > 3)).length;
  }
  const { rows: pend } = await pool.query(
    `SELECT count(*)::int AS n FROM notifications
      WHERE type = 'mm_team_invite' AND payload->>'from_user_id' = $1
        AND payload->>'handled' IS NULL AND created_at > now() - make_interval(hours => $2)`,
    [u.id, MM_INVITE_WINDOW_H]);
  if (sideCount + pend[0].n >= 3)
    throw new HttpError(409, 'Your side is full — a 3v3 team holds you plus two teammates.');

  const { notifyUser } = require('./notify');
  await notifyUser(fid, 'mm_team_invite', {
    from_user_id: u.id, from_username: u.username, from_display_name: u.display_name,
  });
  res.status(201).json({ ok: true, invited: fid });
}));

router.post('/team-invite/:id/accept', ah(async (req, res) => {
  const u = req.user;
  // v69 (production safety): a malformed invite id must 404, never reach the
  // uuid cast as garbage (that surfaced as a logged 500).
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(req.params.id || '')))
    throw new HttpError(404, 'Invitation not found.');
  // Claim the invitation atomically — a second accept (or an accept after
  // decline/expiry) finds it already handled and fails honestly.
  const { rows } = await pool.query(
    `UPDATE notifications SET payload = payload || '{"handled":"accepted"}'::jsonb
      WHERE id = $1 AND user_id = $2 AND type = 'mm_team_invite' AND payload->>'handled' IS NULL
      RETURNING payload`, [String(req.params.id), u.id]);
  if (!rows[0]) throw new HttpError(409, 'That invitation was already handled.');
  const inviterId = rows[0].payload && rows[0].payload.from_user_id;

  // The acceptee must be free to sit down (one active seat per artist).
  const myRoom = await activeRoomOf(u.id);
  if (myRoom) throw new HttpError(409, 'You are already in a room — leave it before joining a team.');

  const client = await pool.connect();
  let code = null, createdNew = false, seatTaken = null;
  try {
    await client.query('BEGIN');
    // v69 (item 1): the FULL room row — activeRoomOf() only returns
    // {code,status}, which silently killed the "inviter already sits in a 3v3
    // lobby → seat me beside them" branch (battle_mode was always undefined
    // and every second accept 409'd with "that search has ended"). Pending
    // team invites must keep seating real teammates into the team room.
    const { rows: invRoomRows } = await client.query(
      `SELECT r.id, r.code, r.status, r.battle_mode FROM battle_rooms r
        WHERE r.deleted_at IS NULL AND r.status IN ('lobby','starting','in_battle')
          AND r.id IN (SELECT room_id FROM room_participants
                        WHERE user_id = $1 AND state IN ('waiting','ready'))
        ORDER BY r.created_at DESC LIMIT 1`, [inviterId]);
    const inviterRoom = invRoomRows[0] || null;
    if (inviterRoom && inviterRoom.battle_mode === '3v3' && inviterRoom.status === 'lobby') {
      // The inviter already sits in a 3v3 lobby room (a previous accept or a
      // queue pairing created it) — seat me on THEIR side in the first free slot.
      await client.query(`SELECT id FROM battle_rooms WHERE id = $1 FOR UPDATE`, [inviterRoom.id]);
      const { rows: invSeat } = await client.query(
        `SELECT seat FROM room_participants WHERE room_id = $1 AND user_id = $2 AND state IN ('waiting','ready')`,
        [inviterRoom.id, inviterId]);
      const sideSeats = invSeat[0] && invSeat[0].seat > 3 ? [4, 5, 6] : [1, 2, 3];
      const { rows: takenRows } = await client.query(
        `SELECT seat FROM room_participants WHERE room_id = $1 AND state IN ('waiting','ready')`, [inviterRoom.id]);
      const taken = new Set(takenRows.map((t) => t.seat));
      const free = sideSeats.find((s) => !taken.has(s));
      if (free === undefined) throw new HttpError(409, 'Their side of the team is already full.');
      const { rows: ex } = await client.query(
        `SELECT state FROM room_participants WHERE room_id = $1 AND user_id = $2`, [inviterRoom.id, u.id]);
      if (ex[0]) {
        await client.query(
          `UPDATE room_participants SET state = 'waiting', left_at = NULL, seat = $3
            WHERE room_id = $1 AND user_id = $2`, [inviterRoom.id, u.id, free]);
      } else {
        await client.query(
          `INSERT INTO room_participants (room_id, user_id, state, seat)
           VALUES ($1, $2, 'waiting', $3)`, [inviterRoom.id, u.id, free]);
      }
      code = inviterRoom.code;
      seatTaken = free;
      await client.query('COMMIT');
    } else if (inviterRoom) {
      throw new HttpError(409, 'That search has ended — ask them to invite you again.');
    } else {
      // The inviter is still SEARCHING — this accept turns the search into a
      // real shared public 3v3 room for both (inviter seat 1, me seat 2: one
      // side; the open side fills via invites/public join, exactly like a
      // queue-paired 3v3 room).
      const { rows: invQ } = await client.query(
        `SELECT id FROM matchmaking_queue
          WHERE user_id = $1 AND status = 'queued' AND (prefs->>'battle_mode') = '3v3'
          FOR UPDATE`, [inviterId]);
      if (!invQ[0]) throw new HttpError(409, 'That search has ended — ask them to invite you again.');
      let roomId = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          code = newRoomCode();
          const { rows: ins } = await client.query(
            `INSERT INTO battle_rooms (code, host_id, name, room_type, visibility, max_players,
                                       time_limit_seconds, result_method, battle_mode, auto_start,
                                       origin, randomizer_config)
             VALUES ($1, $2, '3v3 Team Arena', 'casual', 'public', 6, 3600, 'voting_community', '3v3', false,
                     'matchmaking', '{"categories":["character","environment","object","style"]}'::jsonb)
             RETURNING id`,
            [code, inviterId]
          );
          roomId = ins[0].id;
          break;
        } catch (e) {
          if (e.code !== '23505') throw e;
        }
      }
      if (!roomId) throw new HttpError(500, 'Could not allocate a room code. Try again.');
      await client.query(
        `INSERT INTO room_participants (room_id, user_id, state, seat)
         VALUES ($1, $2, 'waiting', 1), ($1, $3, 'waiting', 2)`,
        [roomId, inviterId, u.id]);
      await client.query(
        `UPDATE matchmaking_queue SET status = 'matched', matched_room_id = $2
          WHERE user_id = $1 AND status = 'queued'`, [inviterId, roomId]);
      // my own queue row (if I was searching too) is cancelled — I'm seated now
      await client.query(
        `UPDATE matchmaking_queue SET status = 'cancelled'
          WHERE user_id = $1 AND status = 'queued'`, [u.id]);
      createdNew = true;
      seatTaken = 2;
      await client.query('COMMIT');
      remember({ id: inviterId }, null, code, '3v3');
      remember({ id: u.id }, null, code, '3v3');
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  // Post-COMMIT notifications (a notified client can never race the room row).
  const brief = await userBrief(u.id);
  rt.emitRoom(code, { action: 'joined', user_id: u.id, username: u.username, display_name: u.display_name, seat: seatTaken });
  rt.broadcastRoomsList(createdNew ? 'created' : 'joined');
  rt.sendToUser(inviterId, { type: 'matchmaking', action: 'teammate_joined', room: code, teammate: brief, battle_mode: '3v3' });
  if (createdNew) {
    // the inviter's search just became a real match — same event a queue pair gets
    rt.sendToUser(inviterId, { type: 'matchmaking', action: 'found', room: code, opponent: null, mode: '3v3', battle_mode: '3v3' });
  }
  res.json({ ok: true, room: code });
}));

router.post('/team-invite/:id/decline', ah(async (req, res) => {
  const u = req.user;
  // v69 (production safety): a malformed invite id must 404, never reach the
  // uuid cast as garbage (that surfaced as a logged 500).
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(req.params.id || '')))
    throw new HttpError(404, 'Invitation not found.');
  const { rows } = await pool.query(
    `UPDATE notifications SET payload = payload || '{"handled":"declined"}'::jsonb
      WHERE id = $1 AND user_id = $2 AND type = 'mm_team_invite' AND payload->>'handled' IS NULL
      RETURNING payload`, [String(req.params.id), u.id]);
  if (!rows[0]) throw new HttpError(409, 'That invitation was already handled.');
  const inviterId = rows[0].payload && rows[0].payload.from_user_id;
  if (inviterId) rt.sendToUser(inviterId, { type: 'matchmaking', action: 'invite_declined', user_id: u.id, username: u.username });
  res.json({ ok: true, handled: 'declined' });
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

// ---------------------------------------------------------------------------
// v68: TOURNAMENT DISCOVERY ENGINE — seats queued tournament searchers into
// open PUBLIC tournament rooms (lobby, bracket not yet seeded, free seat).
// Called (a) right after a public tournament room is created (rooms.js hook)
// and (b) by the 5 s deadline sweeper before it expires anyone, so seats
// freed by leaves/kicks are re-offered too. All seating happens in ONE
// transaction; the WS notifications fire AFTER the commit.
let tournamentSweepRunning = false;
async function matchTournamentSearchers() {
  if (tournamentSweepRunning) return;
  // cheap pre-check: nothing to do without both a queued searcher and an open room
  const pre = await pool.query(
    `SELECT EXISTS(SELECT 1 FROM matchmaking_queue
                    WHERE status = 'queued' AND (prefs->>'battle_mode') = 'tournament') AS has_q,
            EXISTS(SELECT 1 FROM battle_rooms r
                    WHERE r.battle_mode = 'tournament' AND r.visibility = 'public' AND r.status = 'lobby'
                      AND r.bracket IS NULL AND r.deleted_at IS NULL) AS has_room`);
  if (!pre.rows[0].has_q || !pre.rows[0].has_room) return;
  tournamentSweepRunning = true;
  const placed = []; // { userId, code } — notified after COMMIT
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: openRooms } = await client.query(
      `SELECT r.id, r.code, r.max_players,
              (SELECT count(*)::int FROM room_participants rp WHERE rp.room_id = r.id AND rp.state IN ('waiting','ready')) AS player_count
         FROM battle_rooms r
        WHERE r.battle_mode = 'tournament' AND r.visibility = 'public' AND r.status = 'lobby'
          AND r.bracket IS NULL AND r.deleted_at IS NULL
        ORDER BY r.created_at ASC
        FOR UPDATE SKIP LOCKED`
    );
    for (const room of openRooms) {
      let free = room.max_players - room.player_count;
      while (free > 0) {
        const { rows: q } = await client.query(
          `SELECT user_id FROM matchmaking_queue
            WHERE status = 'queued' AND (prefs->>'battle_mode') = 'tournament'
            ORDER BY queued_at, id
            LIMIT 1
            FOR UPDATE SKIP LOCKED`
        );
        if (!q[0]) break;
        const uid = q[0].user_id;
        // ghost row — the artist joined/created a room elsewhere since queueing
        if (await activeRoomOf(uid, client)) {
          await client.query(
            `UPDATE matchmaking_queue SET status = 'cancelled' WHERE user_id = $1 AND status = 'queued'`, [uid]);
          continue;
        }
        const seat = await pickSeatForJoin(client, room, uid);
        if (seat === null) break; // room filled under us — try the next room
        const { rows: ex } = await client.query(
          `SELECT state FROM room_participants WHERE room_id = $1 AND user_id = $2`, [room.id, uid]);
        if (ex[0]) {
          await client.query(
            `UPDATE room_participants SET state = 'waiting', left_at = NULL, seat = $3
              WHERE room_id = $1 AND user_id = $2`, [room.id, uid, seat]);
        } else {
          await client.query(
            `INSERT INTO room_participants (room_id, user_id, state, seat)
             VALUES ($1, $2, 'waiting', $3)`, [room.id, uid, seat]);
        }
        await client.query(
          `UPDATE matchmaking_queue SET status = 'matched', matched_room_id = $2
            WHERE user_id = $1 AND status = 'queued'`, [uid, room.id]);
        placed.push({ userId: uid, code: room.code });
        free--;
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    placed.length = 0;
  } finally {
    client.release();
    tournamentSweepRunning = false;
  }
  if (placed.length) {
    for (const p of placed) {
      try {
        remember({ id: p.userId }, null, p.code, 'tournament');
        rt.sendToUser(p.userId, { type: 'matchmaking', action: 'found', room: p.code, opponent: null, mode: 'tournament', battle_mode: 'tournament' });
        rt.emitRoom(p.code, { action: 'joined', user_id: p.userId });
      } catch (_) {}
    }
    rt.broadcastRoomsList('joined');
  }
}

// v42: the search window is EXACTLY 180 s from queued_at — the SAME anchor
// the client's countdown derives from. Rows past the deadline are expired
// here (at most DEADLINE_SWEEP_MS late) and the searcher is told in real
// time over the hub; the client's own deadline check is the fallback when
// the WS is down. Neither side can end the session early.
const deadlineSweep = setInterval(() => {
  // v68: seat tournament searchers into any open public tournament FIRST —
  // a discovery that lands in the same 5 s beat as the deadline still wins.
  matchTournamentSearchers().catch(() => {});
  pool.query(
    `UPDATE matchmaking_queue SET status = 'expired'
      WHERE status = 'queued' AND queued_at < now() - make_interval(secs => $1)
      RETURNING user_id`,
    [MM_TIMEOUT_S]
  ).then(({ rows }) => {
    for (const r of rows) {
      try { rt.sendToUser(r.user_id, { type: 'matchmaking', action: 'timeout' }); } catch (_) {}
    }
    // v69 (item 1): a timed-out search cleans up its pending team invites —
    // same handled-marking the /cancel path uses, so an Accept button can
    // never outlive the search it belonged to (it would 409 anyway; now the
    // notification honestly shows the expired outcome).
    if (rows.length) {
      pool.query(
        `UPDATE notifications SET payload = payload || '{"handled":"expired"}'::jsonb
          WHERE type = 'mm_team_invite' AND payload->>'handled' IS NULL
            AND (payload->>'from_user_id')::uuid = ANY($1::uuid[])`,
        [rows.map((r) => r.user_id)]
      ).catch(() => {});
    }
  }).catch(() => {});
}, DEADLINE_SWEEP_MS);
deadlineSweep.unref();

module.exports = { router, handleDisconnect, matchTournamentSearchers };
