'use strict';
/**
 * ============================================================================
 *  ART ARENA™ — PHASE 4 · BATTLE ROOM SYSTEM  (v35: room & battle flow)
 * ============================================================================
 *  The place where artists meet. A room has:
 *    - a short shareable code ("ROOM #48291")
 *    - a host (the creator; platform-hosted rooms have host_id NULL)
 *    - players (seated; up to the creator's max_players, hard cap 16)
 *    - spectators (join/leave freely while spectator_allowed — they NEVER
 *      count toward the player limit: a separate room_spectators table)
 *    - a status: lobby → starting → in_battle → ended
 *    - settings decided by the host: visibility, battle mode, max players,
 *      battle type (result_method) + time limit
 *
 *  v35 changes (room & battle flow updates):
 *    - CREATOR CONTROLS: max players (2..16) + battle mode (1v1 / 3v3 /
 *      tournament) are persisted on the room and shown everywhere a room
 *      is shown. 1v1 always seats exactly 2.
 *    - DELETE ROOM (host, lobby): hard delete — Close (soft end) is kept.
 *    - FULL → SPECTATOR: joining a full room returns
 *      { error, data:{ room_full:true } } so the UI offers "Enter as a
 *      Spectator" instead of a dead end. Spectators never occupy a player
 *      slot or count toward the limit.
 *    - SPECTATOR → PLAYER promotion when a seat opens.
 *    - CANVAS GATE: a battle cannot start (manual or auto) until EVERY
 *      seated player has picked a drawing app — the Randomizer only ever
 *      runs after both/all players have selected.
 *    - AUTO-CHALLENGE: the start core generates + locks the official
 *      challenge immediately (shared core in ./challenge — single
 *      implementation, also used by the manual Lock Challenge route).
 *    - MATCHMAKING: createMatchRoom() backs the /api/matchmaking queue;
 *      those rooms are private 1v1 with auto_start=true, so the battle
 *      begins on its own once every seated artist has a canvas.
 *
 *  Every route is behind requireAuth. The server is the source of truth:
 *  all capacity/status/role checks run server-side in transactions.
 * ============================================================================
 */
const express = require('express');
const { pool, HttpError, ah, requireAuth } = require('./lib');
const rt = require('./realtime');
const { lockChallengeCore } = require('./challenge');
const { finishBattleIfDue } = require('./battle-end');

const router = express.Router();
router.use(requireAuth);

const HARD_MAX_PLAYERS = 16;
const TIME_LIMIT = { min: 60, max: 43200 }; // 1 minute .. 12 hours
const BATTLE_TYPES = ['voting_community', 'voting_player', 'none', 'judging_official', 'host_decision'];
// v36: the UI offers exactly three battle types — Community Vote / Players
// Vote / None — and the value is SAVED with the room (result_method) and
// copied to the battle at start. The two legacy values stay accepted so
// rooms created before v36 keep working.
const ROOM_CODE_RE = /^[A-Z0-9]{4,12}$/; // v36: creator-chosen private room codes
// v35: the creator's battle mode (shown on the room; team formats beyond
// 1v1 are future engine work — see the spotlight note in startBattleInTx).
const BATTLE_MODES = ['1v1', '3v3', 'tournament'];
const COMPETITION_BY_ROOM_TYPE = {
  casual: 'casual',
  quick_match: 'quick_match',
  tournament: 'tournament',
  grand_arena: 'grand_arena',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const newRoomCode = () => String(Math.floor(Math.random() * 100000)).padStart(5, '0');

const isActiveParticipant = (u) => u.state === 'waiting' || u.state === 'ready';

// Canvas selection (v33): validate an optional drawing_app_key against the
// app registry. Returns:
//   undefined — key not sent (caller must not touch the column)
//   null      — key explicitly cleared
//   string    — a valid, active app key
// The drawing_apps table is the single source of truth, so new apps can be
// added later without touching the battle flow (no app is hardcoded here).
async function validateDrawingApp(b) {
  if (!('drawing_app_key' in b)) return undefined; // untouched
  const v = b.drawing_app_key == null ? null : String(b.drawing_app_key).trim();
  if (v === null) return null;
  const { rows } = await pool.query(
    `SELECT 1 FROM drawing_apps WHERE app_key = $1 AND is_active`, [v]
  );
  if (!rows[0]) throw new HttpError(400, 'Unknown drawing app.');
  return v;
}

async function roomById(roomId) {
  const { rows } = await pool.query('SELECT * FROM battle_rooms WHERE id = $1', [roomId]);
  return rows[0] || null;
}

async function roomByCode(code) {
  const { rows } = await pool.query(
    'SELECT * FROM battle_rooms WHERE code = $1 AND deleted_at IS NULL',
    [String(code).trim().toUpperCase()]); // v36: codes are case-insensitive on entry
  return rows[0] || null;
}

// v44: the ONE definition of "actively participating in a room" — a seat in
// state waiting/ready inside a live (lobby/starting/in_battle) room. This is
// what blocks joining/creating another room and entering matchmaking; it is
// enforced in routes (friendly 409s) AND at the DB level
// (uq_one_active_seat_per_user) so even concurrent tabs cannot double-seat.
async function activeRoomOf(userId, q) {
  const { rows } = await (q || pool).query(
    `SELECT r.code, r.status FROM battle_rooms r
      WHERE r.deleted_at IS NULL
        AND r.status IN ('lobby','starting','in_battle')
        AND r.id IN (SELECT room_id FROM room_participants
                      WHERE user_id = $1 AND state IN ('waiting','ready'))
      ORDER BY r.created_at DESC
      LIMIT 1`, [userId]);
  return rows[0] || null;
}

async function activeParticipants(roomId, q) {
  const client = q || pool;
  const { rows } = await client.query(
    `SELECT rp.user_id, rp.state, rp.seat, rp.drawing_app_key, u.username, u.display_name
       FROM room_participants rp
       JOIN users u ON u.id = rp.user_id
      WHERE rp.room_id = $1 AND rp.state IN ('waiting','ready')
      ORDER BY rp.seat`,
    [roomId]
  );
  return rows;
}

async function spectatorsOf(roomId) {
  const { rows } = await pool.query(
    `SELECT rs.user_id, u.username, u.display_name
       FROM room_spectators rs
       JOIN users u ON u.id = rs.user_id
      WHERE rs.room_id = $1
      ORDER BY rs.joined_at`,
    [roomId]
  );
  return rows;
}

async function latestBattle(roomId) {
  const { rows } = await pool.query(
    `SELECT b.id, b.status, b.result_method, b.time_limit_seconds,
            b.competition_type, b.created_at,
            b.start_time, b.official_end_time, b.countdown_ends_at -- v36: the synced clock
       FROM battles b
      WHERE b.room_id = $1
      ORDER BY b.created_at DESC
      LIMIT 1`,
    [roomId]
  );
  const battle = rows[0];
  if (!battle) return null;
  // Build the players array in JS (node-pg returns pg arrays as strings).
  // v44: include each participant's FINAL outcome (set once the battle
  // completes) — the post-battle banner is honest about win/loss/draw.
  const { rows: parts } = await pool.query(
    `SELECT u.username, u.display_name, bp.seat, bp.outcome
       FROM battle_participants bp
       JOIN users u ON u.id = bp.user_id
      WHERE bp.battle_id = $1
      ORDER BY bp.seat`,
    [battle.id]
  );
  // v44: the official result (winner is NULL for a draw). Decided exactly
  // once by the battle-end transaction — a refresh re-reads, never re-decides.
  let result = null;
  if (['result', 'complete'].includes(battle.status)) {
    const { rows: res } = await pool.query(
      `SELECT br.method, br.decided_at, u.username AS winner_username, u.display_name AS winner_display_name
         FROM battle_results br
         LEFT JOIN users u ON u.id = br.winner_id
        WHERE br.battle_id = $1 LIMIT 1`, [battle.id]);
    result = res[0]
      ? { method: res[0].method, decided_at: res[0].decided_at,
          winner_username: res[0].winner_username || null,
          winner_display_name: res[0].winner_display_name || null }
      : null;
  }
  return {
    ...battle,
    result,
    players: parts.map((p) => ({ username: p.username, display_name: p.display_name, seat: p.seat, outcome: p.outcome || null })),
  };
}

// The locked challenge for a battle (Phase 6) — null until the randomizer
// has locked one. Elements are joined with their category display names so
// the client never needs the categories table.
async function battleChallengePayload(battleId) {
  const { rows } = await pool.query(
    `SELECT bc.id, bc.generated_at, bc.summary_text,
            bce.category, cat.display_name AS category_display, bce.value
       FROM battle_challenges bc
       JOIN battle_challenge_elements bce ON bce.challenge_id = bc.id
       LEFT JOIN randomizer_categories cat ON cat.key = bce.category
      WHERE bc.battle_id = $1
      ORDER BY cat.sort_order, bce.category`,
    [battleId]
  );
  if (!rows.length) return null;
  const first = rows[0];
  return {
    id: first.id,
    generated_at: first.generated_at,
    summary_text: first.summary_text,
    elements: rows.map((r) => ({
      category: r.category,
      display_name: r.category_display || r.category,
      value: r.value,
    })),
  };
}

// Full detail payload: room + host + players + spectators + latest battle.
async function roomPayload(code, me) {
  const room = await roomByCode(code);
  if (!room) return null;
  // v44 self-heal (sibling of the v36 countdown heal): if this room's
  // battle clock has run out but the sweeper has not (yet) completed it,
  // complete it NOW — a late poller can never see a stale 'active' battle.
  try {
    const due = await pool.query(
      `SELECT id FROM battles
        WHERE room_id = $1 AND status = 'active'
          AND official_end_time IS NOT NULL AND official_end_time <= now()
        LIMIT 1`, [room.id]);
    if (due.rows[0]) {
      const r = await finishBattleIfDue(due.rows[0].id);
      if (r) {
        rt.emitRoom(r.code, { action: 'battle_ended', battle_id: r.battleId, outcome: r.outcome });
        return roomPayload(code, me); // fresh read — players were released
      }
    }
  } catch (_) { /* fall through to the current state */ }
  const [players, spectators, battleRow, hostRow] = await Promise.all([
    activeParticipants(room.id),
    spectatorsOf(room.id),
    latestBattle(room.id),
    room.host_id
      ? pool.query('SELECT id, username, display_name FROM users WHERE id = $1', [room.host_id])
      : Promise.resolve({ rows: [{}] }),
  ]);
  // v47 server fix: this was destructured as `const battle` above, so the
  // countdown self-heal below (`battle = await latestBattle(...)`) threw
  // "Assignment to constant variable" — the room GET 500'd in exactly the
  // countdown→active window it was supposed to heal. `let` fixes the heal.
  let battle = battleRow;
  const host = hostRow.rows[0];
  // v36: self-heal on read — if a countdown is already due but the sweeper
  // has not (yet) flipped it, flip it NOW (same atomic path) so a late
  // poller can never miss the start; then rebuild from fresh data.
  if (battle && battle.status === 'countdown' && battle.countdown_ends_at &&
      new Date(battle.countdown_ends_at).getTime() <= Date.now()) {
    const r = await flipCountdownDown(battle.id);
    if (r) {
      rt.emitRoom(r.code, {
        action: 'battle_active',
        start_time: r.start_time,
        official_end_time: new Date(new Date(r.start_time).getTime() + r.time_limit_seconds * 1000),
      });
      battle = await latestBattle(room.id);
    }
  }
  const challenge = battle ? await battleChallengePayload(battle.id) : null;
  // v44: a pending rematch request (post-battle UI state) — null when none.
  // v51: reads also RUN THE EXPIRY SWEEP — a rematch request older than
  // 2 minutes is expired server-side and the requester's seat (if they
  // re-seated waiting for the answer) is released. No ghost seats.
  let rematch = null;
  if (battle && battle.status === 'complete') {
    await expireStaleRematches();
    const { rows: rr } = await pool.query(
      `SELECT r.status, r.created_at AS requested_at,
              fu.username AS from_username, fu.display_name AS from_display_name,
              tu.username AS to_username, tu.display_name AS to_display_name
         FROM rematch_requests r
         JOIN users fu ON fu.id = r.from_user_id
         JOIN users tu ON tu.id = r.to_user_id
        WHERE r.room_id = $1 AND r.status = 'pending'
        ORDER BY r.created_at DESC LIMIT 1`, [room.id]);
    rematch = rr[0] || null;
  }
  return {
    code: room.code,
    // v51: the server's clock in the same payload as its timestamps — the
    // client measures its OWN skew and derives the 3-2-1 countdown (and the
    // battle clock) from SERVER time, never from a naive local Date.now().
    server_now: new Date().toISOString(),
    name: room.name,
    room_type: room.room_type,
    visibility: room.visibility,
    status: room.status,
    max_players: room.max_players,
    battle_mode: room.battle_mode || '1v1',          // v35
    auto_start: !!room.auto_start,                   // v35 (matchmaking rooms)
    time_limit_seconds: room.time_limit_seconds,
    battle_type: room.result_method,
    spectator_allowed: room.spectator_allowed,
    randomizer_config: room.randomizer_config || null,
    created_at: room.created_at,
    rematch,                                         // v44
    host: room.host_id ? { user_id: host.id, username: host.username, display_name: host.display_name } : null,
    players: players.map((p) => ({
      user_id: p.user_id,
      username: p.username,
      display_name: p.display_name,
      seat: p.seat,
      state: p.state,
      drawing_app_key: p.drawing_app_key || null,
      is_host: p.user_id === room.host_id,
      is_you: p.user_id === me,
    })),
    spectators: spectators.map((s) => ({
      user_id: s.user_id,
      username: s.username,
      display_name: s.display_name,
      is_you: s.user_id === me,
    })),
    player_count: players.length,
    spectator_count: spectators.length,
    battle: battle ? {
      id: battle.id,
      status: battle.status,
      result_method: battle.result_method,
      time_limit_seconds: battle.time_limit_seconds,
      competition_type: battle.competition_type,
      players: battle.players || [],
      created_at: battle.created_at,
      // v36: the server-synced clock — clients derive the 3-2-1 countdown
      // and the battle timer from these (never from their own wall clock).
      start_time: battle.start_time || null,
      official_end_time: battle.official_end_time || null,
      countdown_ends_at: battle.countdown_ends_at || null,
      result: battle.result || null, // v44: official result (winner NULL = draw)
      challenge,
    } : null,
  };
}

function requireHost(room, me) {
  if (!room.host_id) throw new HttpError(400, 'This room is platform-hosted.');
  if (room.host_id !== me) throw new HttpError(403, 'Only the host can do that.');
}

// ---------------------------------------------------------------------------
// The START CORE (v35) — shared by the host's /start AND matchmaking
// auto-start. Enforces the flow the product promises, in one place:
//   1. every seat the creator asked for is filled (1v1 = exactly 2)
//   2. EVERY seated player has picked a canvas — the Randomizer never
//      runs before both/all players have selected their drawing app
//   3. the battle is created AND the official challenge is generated +
//      locked immediately (shared core in ./challenge), so the moment the
//      gate passes: challenge exists, both players receive it, battle runs.
// Returns the challenge summary (null if generation failed — the start
// itself must not break; the host can still lock manually).
// ---------------------------------------------------------------------------
async function startBattleInTx(client, room, players, actorId) {
  const mode = room.battle_mode || '1v1';
  if (mode === '1v1') {
    if (players.length !== 2)
      throw new HttpError(409, `1v1 needs exactly 2 players (currently ${players.length}).`);
  } else if (players.length < room.max_players) {
    throw new HttpError(409, `Waiting for all players to join (${players.length}/${room.max_players}).`);
  }
  if (players.some((p) => !p.drawing_app_key))
    throw new HttpError(409, 'Waiting for all players to select their canvas.');

  // The current battle engine is one-on-one: for team formats (3v3 /
  // tournament — a later engine phase) the first two seated artists battle;
  // the room's mode + capacity stay the creator's truth and are displayed.
  const seated = players.slice(0, 2);
  const { rows: bRows } = await client.query(
    `INSERT INTO battles (room_id, competition_type, format, result_method,
                          time_limit_seconds, status)
     VALUES ($1, $2, 'one_on_one', $3, $4, 'waiting')
     RETURNING id`,
    [room.id, COMPETITION_BY_ROOM_TYPE[room.room_type] || 'casual',
     room.result_method, room.time_limit_seconds]
  );
  const battleId = bRows[0].id;
  // v51: any YouTube broadcast the owner prepared PRE-MATCH (room-scoped,
  // battle_id NULL) is now linked to this battle — the LIVE page chain
  // (user → broadcast → battle) completes the moment the battle exists.
  await client.query(
    `UPDATE youtube_broadcasts SET battle_id = $2
      WHERE room_id = $1 AND battle_id IS NULL`,
    [room.id, battleId]
  );
  for (const p of seated) {
    await client.query(
      'INSERT INTO battle_participants (battle_id, user_id, seat) VALUES ($1, $2, $3)',
      [battleId, p.user_id, p.seat]
    );
  }
  await client.query(
    `UPDATE battle_rooms SET status = 'starting', starts_at = now() WHERE id = $1`, [room.id]
  );

  // v35: the Randomizer runs the moment the canvas gate passes.
  let challengeSummary = null;
  let challengeLocked = false;
  try {
    const r = await lockChallengeCore(client, {
      battleId,
      randomizerConfig: room.randomizer_config,
      actorId: actorId || room.host_id,
    });
    challengeSummary = r.summary;
    challengeLocked = true;
  } catch (e) {
    // An empty category pool must not kill the start — the host keeps the
    // manual "Lock Challenge" button as the fallback.
    console.error('[start] auto challenge generation failed:', e.message);
  }

  // v36: the 3-2-1 COUNTDOWN — the battle does NOT start the instant the
  // challenge locks. The server owns the clock: countdown_ends_at is the
  // single source of truth, the sweeper flips the battle to 'active' at
  // exactly that moment (start_time = countdown_ends_at, so every client
  // derives the same "DRAW!" instant and the same battle clock), and no
  // client can ever see 'active' before the server says so — the timer
  // cannot begin early, and all players transition simultaneously.
  if (challengeLocked) {
    await client.query(
      `UPDATE battles SET status = 'countdown',
                         countdown_ends_at = now() + interval '3 seconds'
        WHERE id = $1`,
      [battleId]
    );
  }
  return challengeSummary;
}

// ---------------------------------------------------------------------------
// v36: THE COUNTDOWN SWEEPER — the single server-side clock that flips a
// 'countdown' battle to 'active' at exactly countdown_ends_at.
//   - start_time = countdown_ends_at → the PLANNED "DRAW!" instant; every
//     client derives the same moment and the same battle clock from it
//   - official_end_time = start_time + time_limit_seconds (server authority)
//   - room → 'in_battle'; everyone in the room gets 'battle_active'
// Idempotent: re-checked under FOR UPDATE, so overlapping ticks are no-ops.
// ---------------------------------------------------------------------------
async function flipCountdownDown(battleId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: br } = await client.query(
      `SELECT b.id, b.status, b.countdown_ends_at, b.time_limit_seconds, b.room_id
         FROM battles b WHERE b.id = $1 FOR UPDATE`, [battleId]
    );
    const b = br[0];
    if (!b || b.status !== 'countdown' || !b.countdown_ends_at) {
      await client.query('COMMIT');
      return null;
    }
    const { rows: rr } = await client.query(
      `SELECT id, code, status FROM battle_rooms WHERE id = $1 FOR UPDATE`, [b.room_id]
    );
    const room = rr[0];
    if (!room || !['starting', 'lobby'].includes(room.status)) {
      await client.query('COMMIT');
      return null;
    }
    // Both instants are computed here and passed as separate, explicitly
    // typed parameters — one shared $2 in an assignment AND interval math
    // makes Postgres reject the parse ("inconsistent types deduced").
    const startAt = new Date(b.countdown_ends_at);
    const endAt = new Date(startAt.getTime() + b.time_limit_seconds * 1000);
    await client.query(
      `UPDATE battles SET status = 'active',
                         start_time = $2,
                         official_end_time = $3
        WHERE id = $1`,
      [b.id, startAt, endAt]
    );
    if (room.status !== 'in_battle') {
      await client.query(`UPDATE battle_rooms SET status = 'in_battle' WHERE id = $1`, [room.id]);
    }
    await client.query('COMMIT');
    return { code: room.code, start_time: b.countdown_ends_at, time_limit_seconds: b.time_limit_seconds };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// v36: tell the room the countdown is on (after a start whose challenge
// auto-locked). No-op when the challenge was not locked (host keeps the
// manual "Lock Challenge" button as the fallback).
async function emitCountdownIfArmed(code) {
  try {
    const { rows } = await pool.query(
      `SELECT b.status, b.countdown_ends_at
         FROM battles b JOIN battle_rooms r ON r.id = b.room_id
        WHERE r.code = $1
        ORDER BY b.created_at DESC
        LIMIT 1`, [code]
    );
    if (rows[0] && rows[0].status === 'countdown' && rows[0].countdown_ends_at) {
      rt.emitRoom(code, { action: 'countdown', countdown_ends_at: rows[0].countdown_ends_at });
    }
  } catch (e) {
    console.error('[countdown-emit]', e.message);
  }
}

let countdownSweeperTimer = null;
// ---------------------------------------------------------------------------
// v51: REMATCH EXPIRY — server-authoritative 2-minute window. Any pending
// request older than 2 minutes is expired, and the requester is REMOVED from
// the room (their seat released) so nobody lingers as a ghost waiting for an
// answer that is never coming. Runs on room reads AND on a 15 s timer, so it
// is enforced even when nobody is looking at the room.
// ---------------------------------------------------------------------------
const REMATCH_TTL_SQL = "now() - interval '2 minutes'";
async function expireStaleRematches() {
  const { rows } = await pool.query(
    `UPDATE rematch_requests SET status = 'expired', responded_at = now()
      WHERE status = 'pending' AND created_at < ${REMATCH_TTL_SQL}
      RETURNING id, room_id, from_user_id,
                (SELECT code FROM battle_rooms WHERE id = rematch_requests.room_id) AS code`
  );
  for (const row of rows) {
    await pool.query(
      `UPDATE room_participants SET state = 'left', left_at = now()
        WHERE room_id = $1 AND user_id = $2 AND state IN ('waiting','ready')`,
      [row.room_id, row.from_user_id]
    );
    if (row.code) rt.emitRoom(row.code, { action: 'rematch_expired' });
  }
  return rows.length;
}
let rematchSweeperTimer = null;
function startRematchSweeper() {
  if (rematchSweeperTimer) return rematchSweeperTimer;
  rematchSweeperTimer = setInterval(() => { expireStaleRematches().catch(() => {}); }, 15000);
  if (rematchSweeperTimer.unref) rematchSweeperTimer.unref();
  return rematchSweeperTimer;
}

function startCountdownSweeper() {
  if (countdownSweeperTimer) return countdownSweeperTimer;
  countdownSweeperTimer = setInterval(async () => {
    try {
      const { rows } = await pool.query(
        `SELECT id FROM battles
          WHERE status = 'countdown' AND countdown_ends_at IS NOT NULL
            AND countdown_ends_at <= now()`
      );
      for (const b of rows) {
        const r = await flipCountdownDown(b.id);
        if (r) {
          rt.emitRoom(r.code, {
            action: 'battle_active',
            start_time: r.start_time,
            official_end_time: new Date(new Date(r.start_time).getTime() + r.time_limit_seconds * 1000),
          });
        }
      }
    } catch (e) {
      console.error('[countdown-sweeper]', e.message);
    }
  }, 1000);
  if (countdownSweeperTimer.unref) countdownSweeperTimer.unref();
  return countdownSweeperTimer;
}

// ---------------------------------------------------------------------------
// LIST — rooms I'm in + public rooms open for play
// ---------------------------------------------------------------------------
router.get('/', ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT r.code, r.name, r.room_type, r.visibility, r.status, r.max_players,
            r.battle_mode,
            r.time_limit_seconds, r.result_method, r.created_at, r.host_id,
            r.spectator_allowed,
            h.username AS host_username, h.display_name AS host_display_name,
            (SELECT count(*) FROM room_participants rp
              WHERE rp.room_id = r.id AND rp.state IN ('waiting','ready'))::int AS player_count,
            (SELECT count(*) FROM room_spectators rs
              WHERE rs.room_id = r.id)::int AS spectator_count,
            COALESCE((SELECT json_agg(t.username)
                    FROM (SELECT u.username
                            FROM room_participants rp JOIN users u ON u.id = rp.user_id
                            WHERE rp.room_id = r.id AND rp.state IN ('waiting','ready')
                            ORDER BY rp.seat
                            LIMIT 3) t), '[]'::json) AS player_names,
            (r.id IN (SELECT room_id FROM room_participants
                       WHERE user_id = $1 AND state IN ('waiting','ready'))) AS i_am_player,
            (r.id IN (SELECT room_id FROM room_spectators WHERE user_id = $1)) AS i_am_spectator
       FROM battle_rooms r
       LEFT JOIN users h ON h.id = r.host_id
      WHERE r.deleted_at IS NULL
        AND ( (r.visibility = 'public' AND r.status = 'lobby')
         OR r.host_id = $1
         OR (r.id IN (SELECT room_id FROM room_participants
                       WHERE user_id = $1 AND state IN ('waiting','ready')))
         OR (r.id IN (SELECT room_id FROM room_spectators WHERE user_id = $1)) )
      ORDER BY (r.host_id = $1) DESC, r.created_at DESC
      LIMIT 50`,
    [req.user.id]
  );
  res.json({
    rooms: rows.map((r) => ({
      code: r.code,
      name: r.name,
      status: r.status,
      visibility: r.visibility,
      room_type: r.room_type,
      battle_mode: r.battle_mode || '1v1',   // v35
      max_players: r.max_players,
      player_count: r.player_count,
      spectator_count: r.spectator_count,
      time_limit_seconds: r.time_limit_seconds,
      battle_type: r.result_method,
      spectator_allowed: r.spectator_allowed,
      created_at: r.created_at,
      host: r.host_id ? { username: r.host_username, display_name: r.host_display_name } : null,
      player_names: r.player_names || [],
      my_role: r.host_id === req.user.id ? 'host' : (r.i_am_player ? 'player' : (r.i_am_spectator ? 'spectator' : null)),
    })),
  });
}));

// ---------------------------------------------------------------------------
// CREATE — the current user becomes host AND player (seat 1)
// v35: creator controls — battle mode (1v1 / 3v3 / tournament) + max
// players (2..16; 1v1 always seats exactly 2).
// ---------------------------------------------------------------------------
router.post('/', ah(async (req, res) => {
  const b = req.body || {};
  // v44 (one active room per artist): creating a room seats the creator as
  // host + player 1 — that IS active participation, so it is blocked while
  // the artist already holds a live seat anywhere. (The DB partial unique
  // index is the backstop; this check gives the friendly message.)
  const already = await activeRoomOf(req.user.id);
  if (already) throw new HttpError(409, 'You are already in a room — leave it before creating another.');
  const visibility = b.visibility === undefined ? 'public' : b.visibility;
  if (!['public', 'private'].includes(visibility))
    throw new HttpError(400, 'Visibility must be "public" or "private".');
  const name = b.name === undefined ? null : String(b.name).trim().slice(0, 60) || null;
  const timeLimit = b.time_limit_seconds === undefined ? 1200 : Number(b.time_limit_seconds);
  if (!Number.isInteger(timeLimit) || timeLimit < TIME_LIMIT.min || timeLimit > TIME_LIMIT.max)
    throw new HttpError(400, 'Time limit must be between 1 minute and 12 hours.');
  const battleType = b.battle_type === undefined ? 'voting_community' : b.battle_type;
  if (!BATTLE_TYPES.includes(battleType))
    throw new HttpError(400, 'Unknown battle type.');
  const battleMode = b.battle_mode === undefined ? '1v1' : b.battle_mode;
  if (!BATTLE_MODES.includes(battleMode))
    throw new HttpError(400, 'Unknown battle mode.');
  let maxPlayers = b.max_players === undefined ? 2 : Number(b.max_players);
  if (!Number.isInteger(maxPlayers))
    throw new HttpError(400, `Max players must be between 2 and ${HARD_MAX_PLAYERS}.`);
  // v36: the mode is the source of truth for team sizes — 1v1 seats exactly
  // 2, 3v3 seats exactly 6 (three artists per side); only a tournament lets
  // the creator choose the size (8..16; the platform cap stays 16). The
  // tournament band is checked FIRST so an out-of-band tournament gets the
  // precise message.
  if (battleMode === 'tournament' && (maxPlayers < 8 || maxPlayers > 16))
    throw new HttpError(400, 'A tournament must seat between 8 and 16 players.');
  if (maxPlayers < 2 || maxPlayers > HARD_MAX_PLAYERS)
    throw new HttpError(400, `Max players must be between 2 and ${HARD_MAX_PLAYERS}.`);
  if (battleMode === '1v1') maxPlayers = 2; // a duel seats exactly two artists
  if (battleMode === '3v3') maxPlayers = 6; // the 3v3 requirement
  // v36: private rooms use a CREATOR-CHOSEN code — validated here on the
  // server (the frontend check is convenience only, never the gate).
  let chosenCode = null;
  if (visibility === 'private') {
    chosenCode = String(b.code === undefined ? '' : b.code).trim().toUpperCase();
    if (!ROOM_CODE_RE.test(chosenCode))
      throw new HttpError(400, 'Private rooms need a room code (4–12 letters or numbers).');
  }
  const drawingApp = await validateDrawingApp(b);

  const client = await pool.connect();
  let roomId;
  try {
    if (chosenCode) {
      // Creator-chosen code: a collision is a real, reportable error — that
      // code belongs to another room (no silent retry here).
      try {
        const { rows } = await client.query(
          `INSERT INTO battle_rooms (code, host_id, name, room_type, visibility, max_players,
                                     time_limit_seconds, result_method, battle_mode)
           VALUES ($1, $2, $3, 'casual', $4, $5, $6, $7, $8)
           RETURNING id`,
          [chosenCode, req.user.id, name, visibility, maxPlayers, timeLimit, battleType, battleMode]
        );
        roomId = rows[0].id;
      } catch (e) {
        if (e.code === '23505')
          throw new HttpError(409, 'That room code is already taken — choose a different one.');
        throw e;
      }
    } else {
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          const { rows } = await client.query(
            `INSERT INTO battle_rooms (code, host_id, name, room_type, visibility, max_players,
                                       time_limit_seconds, result_method, battle_mode)
             VALUES ($1, $2, $3, 'casual', $4, $5, $6, $7, $8)
             RETURNING id`,
            [newRoomCode(), req.user.id, name, visibility, maxPlayers, timeLimit, battleType, battleMode]
          );
          roomId = rows[0].id;
          break;
        } catch (e) {
          if (e.code !== '23505') throw e; // code collision — retry with a fresh code
        }
      }
      if (!roomId) throw new HttpError(500, 'Could not allocate a room code. Try again.');
    }
    await client.query(
      `INSERT INTO room_participants (room_id, user_id, state, seat, drawing_app_key)
       VALUES ($1, $2, 'waiting', 1, $3)`,
      [roomId, req.user.id, drawingApp === undefined ? null : drawingApp]
    );
  } finally {
    client.release();
  }

  const { rows } = await pool.query('SELECT code FROM battle_rooms WHERE id = $1', [roomId]);
  const payload = await roomPayload(rows[0].code, req.user.id);
  if (visibility === 'public') rt.broadcastRoomsList('created');
  res.status(201).json(payload);
}));

// ---------------------------------------------------------------------------
// DETAIL
// ---------------------------------------------------------------------------
router.get('/:code', ah(async (req, res) => {
  const payload = await roomPayload(req.params.code, req.user.id);
  if (!payload) throw new HttpError(404, 'Room not found.');
  res.json(payload);
}));

// ---------------------------------------------------------------------------
// JOIN as player (re-joins if you left earlier)
// v35: a FULL room answers { room_full:true } so the client can offer the
// spectator seat; a SPECTATOR with a free seat is promoted to a player.
// ---------------------------------------------------------------------------
router.post('/:code/join', ah(async (req, res) => {
  const drawingApp = await validateDrawingApp(req.body || {});
  const client = await pool.connect();
  let rejoined = false;
  let promoted = false;
  try {
    await client.query('BEGIN');
    const { rows: roomRows } = await client.query(
      'SELECT * FROM battle_rooms WHERE code = $1 AND deleted_at IS NULL FOR UPDATE',
      [String(req.params.code).trim().toUpperCase()]
    );
    const room = roomRows[0];
    // v36: joining is code-entry, so a wrong code must say exactly that —
    // not the generic "Room not found." every other route uses.
    if (!room) throw new HttpError(404, "We couldn't find a room with that code.");
    // v51 (spec 11): a room whose battle ENDED stays joinable — the rematch
    // window lives there. A declined/kicked/timed-out artist may rejoin the
    // public room (no ban); joining seats them as 'waiting' for whatever the
    // room mints next. Only an in-flight battle (countdown/in_battle/etc.)
    // truly closes the door.
    if (room.status !== 'lobby' && room.status !== 'ended')
      throw new HttpError(409, 'This room is not accepting players.');
    // v44 (one active room per artist): blocked from holding a live seat in
    // ANY other room (rejoining THIS room stays allowed — a left seat is
    // not an active one). The partial unique index enforces the same rule
    // even under concurrent tabs.
    const mine = await activeRoomOf(req.user.id, client);
    if (mine && mine.code !== room.code)
      throw new HttpError(409, 'You are already in a room — leave it before joining another.');

    const { rows: existing } = await client.query(
      'SELECT state, seat FROM room_participants WHERE room_id = $1 AND user_id = $2',
      [room.id, req.user.id]
    );
    if (existing[0] && isActiveParticipant(existing[0]))
      throw new HttpError(409, 'You are already in this room.');

    const { rows: spec } = await client.query(
      'SELECT 1 FROM room_spectators WHERE room_id = $1 AND user_id = $2', [room.id, req.user.id]
    );
    if (spec[0]) {
      // v35: spectator → player when a seat is open (checked BEFORE removing
      // the spectator row, so a full room leaves them spectating).
      const { rows: takenRows } = await client.query(
        `SELECT seat FROM room_participants WHERE room_id = $1 AND state IN ('waiting','ready')`,
        [room.id]
      );
      const taken = new Set(takenRows.map((s) => s.seat));
      let freeSeat = null;
      for (let i = 1; i <= room.max_players; i++) if (!taken.has(i)) { freeSeat = i; break; }
      if (freeSeat === null) {
        const e = new HttpError(409, 'This room is full.');
        e.data = { room_full: true };
        throw e;
      }
      await client.query(
        'DELETE FROM room_spectators WHERE room_id = $1 AND user_id = $2', [room.id, req.user.id]
      );
      promoted = true;
    }

    rejoined = !!existing[0];
    if (rejoined) {
      // Re-join: reactivate the (left) row, keep the seat.
      if (drawingApp !== undefined) {
        await client.query(
          `UPDATE room_participants SET state = 'waiting', left_at = NULL, ready_at = NULL,
                  joined_at = now(), drawing_app_key = $3
            WHERE room_id = $1 AND user_id = $2`,
          [room.id, req.user.id, drawingApp]
        );
      } else {
        await client.query(
          `UPDATE room_participants SET state = 'waiting', left_at = NULL, ready_at = NULL, joined_at = now()
            WHERE room_id = $1 AND user_id = $2`,
          [room.id, req.user.id]
        );
      }
    } else {
      const { rows: seats } = await client.query(
        `SELECT seat FROM room_participants WHERE room_id = $1 AND state IN ('waiting','ready')`,
        [room.id]
      );
      const taken = new Set(seats.map((s) => s.seat));
      let seat = null;
      for (let i = 1; i <= room.max_players; i++) if (!taken.has(i)) { seat = i; break; }
      if (seat === null) {
        const e = new HttpError(409, 'This room is full.');
        e.data = { room_full: true };
        throw e;
      }
      await client.query(
        `INSERT INTO room_participants (room_id, user_id, state, seat, drawing_app_key)
         VALUES ($1, $2, 'waiting', $3, $4)`,
        [room.id, req.user.id, seat, drawingApp === undefined ? null : drawingApp]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    // v44: the one-active-seat unique index firing under a race (two tabs)
    // must read as the friendly rule, not a database error.
    if (e && e.code === '23505' && e.constraint === 'uq_one_active_seat_per_user')
      throw new HttpError(409, 'You are already in a room — leave it before joining another.');
    throw e;
  } finally {
    client.release();
  }
  const payload = await roomPayload(req.params.code, req.user.id);
  rt.emitRoom(payload.code, {
    action: promoted ? 'joined' : (rejoined ? 'rejoined' : 'joined'),
    username: req.user.username,
    display_name: req.user.display_name,
    seat: (payload.players.find((p) => p.is_you) || {}).seat,
  });
  res.json(payload);
}));

// ---------------------------------------------------------------------------
// LEAVE (host leaving transfers the host or closes the room)
// Bug fix (v43): the room must RELEASE its seated players when it ends —
// before, an ended room kept every player's row in 'waiting' forever: the
// room (its #code card) never left their Rooms list, and /leave itself
// 409'd ("The battle has already started.") because it only accepted
// lobby rooms — a dead end with no way out for non-hosts. Now:
//   - leaving is allowed in an ENDED room too (the seat is over; the row
//     simply flips to 'left')
//   - every path that ends a room (close / host-leave-empties-it) marks
//     all active participants 'left' — the card disappears from their
//     lists the moment the room is over.
router.post('/:code/leave', ah(async (req, res) => {
  const client = await pool.connect();
  let closedRoom = false;
  let newHostUser = null;
  let roomVisibility = 'public';
  let wasSeated = false;
  try {
    await client.query('BEGIN');
    const { rows: roomRows } = await client.query(
      'SELECT * FROM battle_rooms WHERE code = $1 AND deleted_at IS NULL FOR UPDATE', [String(req.params.code).trim()]
    );
    const room = roomRows[0];
    if (!room) throw new HttpError(404, 'Room not found.');
    if (room.status !== 'lobby' && room.status !== 'ended') throw new HttpError(409, 'The battle has already started.');

    const { rows: gone } = await client.query(
      `UPDATE room_participants SET state = 'left', left_at = now()
        WHERE room_id = $1 AND user_id = $2 AND state IN ('waiting','ready')
        RETURNING user_id`,
      [room.id, req.user.id]
    );
    wasSeated = !!gone[0];
    if (!wasSeated) {
      // v44 (post-battle exit): a completed battle already released every
      // seat — leaving an ended room is IDEMPOTENT success, not an error,
      // so nobody is ever trapped in a finished room.
      if (room.status !== 'ended') throw new HttpError(409, 'You are not in this room.');
      await client.query('COMMIT');
      return res.json(await roomPayload(req.params.code, req.user.id));
    }

    roomVisibility = room.visibility;
    if (room.status !== 'ended' && room.host_id === req.user.id) {
      // Host leaving a LIVE lobby: transfer the host, or close if empty.
      const { rows: rest } = await client.query(
        `SELECT user_id FROM room_participants
          WHERE room_id = $1 AND state IN ('waiting','ready')
          ORDER BY seat LIMIT 1`,
        [room.id]
      );
      if (rest[0]) {
        await client.query('UPDATE battle_rooms SET host_id = $1 WHERE id = $2', [rest[0].user_id, room.id]);
        newHostUser = (await client.query(
          'SELECT username, display_name FROM users WHERE id = $1', [rest[0].user_id]
        )).rows[0];
      } else {
        await client.query(
          `UPDATE battle_rooms SET status = 'ended', ended_at = now() WHERE id = $1`, [room.id]
        );
        closedRoom = true;
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  const payload = await roomPayload(req.params.code, req.user.id);
  if (wasSeated) rt.emitRoom(payload.code, { action: 'left', username: req.user.username, display_name: req.user.display_name });
  if (closedRoom) rt.emitRoom(payload.code, { action: 'closed', by: req.user.username });
  else if (newHostUser) rt.emitRoom(payload.code, { action: 'host_transferred', username: newHostUser.username, display_name: newHostUser.display_name });
  if (closedRoom && roomVisibility === 'public') rt.broadcastRoomsList('closed');
  res.json(payload);
}));

// ---------------------------------------------------------------------------
// READY — a lobby player signals they are ready (toggle back off again).
// ---------------------------------------------------------------------------
router.post('/:code/ready', ah(async (req, res) => {
  const client = await pool.connect();
  let newState;
  try {
    await client.query('BEGIN');
    const { rows: roomRows } = await client.query(
      'SELECT * FROM battle_rooms WHERE code = $1 FOR UPDATE', [String(req.params.code).trim()]
    );
    const room = roomRows[0];
    if (!room) throw new HttpError(404, 'Room not found.');
    if (room.status !== 'lobby') throw new HttpError(409, 'The battle has already started.');
    const { rows: seat } = await client.query(
      `SELECT state FROM room_participants
        WHERE room_id = $1 AND user_id = $2 AND state IN ('waiting','ready')
        FOR UPDATE`,
      [room.id, req.user.id]
    );
    if (!seat[0]) throw new HttpError(409, 'You are not a player in this room.');
    newState = seat[0].state === 'ready' ? 'waiting' : 'ready';
    // Schema requires a ready_at timestamp whenever state = 'ready'
    // (ck_room_ready); cleared again when we un-ready.
    await client.query(
      `UPDATE room_participants
          SET state = $3::room_participant_state,
              ready_at = (CASE WHEN $3 = 'ready' THEN now() ELSE NULL END)
        WHERE room_id = $1 AND user_id = $2`,
      [room.id, req.user.id, newState]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  const payload = await roomPayload(req.params.code, req.user.id);
  rt.emitRoom(payload.code, {
    action: newState === 'ready' ? 'ready' : 'unready',
    username: req.user.username,
    display_name: req.user.display_name,
    seat: (payload.players.find((p) => p.is_you) || {}).seat,
  });
  res.json(payload);
}));

// ---------------------------------------------------------------------------
// CANVAS — a lobby player picks the drawing app for THIS battle session.
//   The choice is associated with the battle (room_participants.drawing_app_key)
//   and stays changeable at any time until the battle starts — nobody is
//   ever auto-locked into one app. The app registry (drawing_apps) is the
//   source of truth, so adding a new app later never touches this flow.
//   v35: for matchmaking rooms (auto_start=true), the moment EVERY seated
//   artist has a canvas, the battle + challenge start on their own.
// ---------------------------------------------------------------------------
router.post('/:code/canvas', ah(async (req, res) => {
  const drawingApp = await validateDrawingApp(req.body || {});
  if (!drawingApp) throw new HttpError(400, 'A drawing_app_key is required.');
  const client = await pool.connect();
  let autoStarted = false;
  let challengeSummary = null;
  let roomCode;
  try {
    await client.query('BEGIN');
    const { rows: roomRows } = await client.query(
      'SELECT * FROM battle_rooms WHERE code = $1 FOR UPDATE', [String(req.params.code).trim()]
    );
    const room = roomRows[0];
    if (!room) throw new HttpError(404, 'Room not found.');
    if (room.status !== 'lobby') throw new HttpError(409, 'The battle has already started.');
    const { rows: upd } = await client.query(
      `UPDATE room_participants SET drawing_app_key = $3
        WHERE room_id = $1 AND user_id = $2 AND state IN ('waiting','ready')
        RETURNING user_id`,
      [room.id, req.user.id, drawingApp]
    );
    if (!upd[0]) throw new HttpError(409, 'You are not a player in this room.');
    if (room.auto_start) {
      const players = await activeParticipants(room.id, client);
      if (players.length === room.max_players && players.length >= 2 &&
          players.every((p) => p.drawing_app_key)) {
        challengeSummary = await startBattleInTx(client, room, players, room.host_id);
        autoStarted = true;
      }
    }
    await client.query('COMMIT');
    roomCode = room.code;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  rt.emitRoom(roomCode, {
    action: 'canvas',
    username: req.user.username,
    display_name: req.user.display_name,
    drawing_app_key: drawingApp,
  });
  if (autoStarted) {
    rt.emitRoom(roomCode, { action: 'started', by: 'quick match' });
    if (challengeSummary) rt.emitRoom(roomCode, { action: 'challenge_locked', by: 'randomizer', summary: challengeSummary });
    await emitCountdownIfArmed(roomCode); // v36: 3-2-1, synchronized for everyone
  }
  res.json(await roomPayload(roomCode, req.user.id));
}));

// ---------------------------------------------------------------------------
// SPECTATE / STOP SPECTATING — spectators never count toward the player
// limit (room_spectators is its own table), so a FULL room can still be
// watched live. That is the spec's "Room Full → Enter as a Spectator".
// ---------------------------------------------------------------------------
router.post('/:code/spectate', ah(async (req, res) => {
  const room = await roomByCode(req.params.code);
  if (!room) throw new HttpError(404, 'Room not found.');
  if (!['lobby', 'starting', 'in_battle'].includes(room.status))
    throw new HttpError(409, 'This room is over.');
  if (!room.spectator_allowed) throw new HttpError(403, 'Spectating is disabled for this room.');
  const { rows: inRoom } = await pool.query(
    `SELECT 1 FROM room_participants
      WHERE room_id = $1 AND user_id = $2 AND state IN ('waiting','ready')`,
    [room.id, req.user.id]
  );
  if (inRoom[0]) throw new HttpError(409, 'You are a player in this room.');
  const ins = await pool.query(
    'INSERT INTO room_spectators (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING user_id',
    [room.id, req.user.id]
  );
  if (ins.rowCount) {
    rt.emitRoom(room.code, { action: 'spectated', username: req.user.username, display_name: req.user.display_name });
  }
  res.json(await roomPayload(room.code, req.user.id));
}));

router.post('/:code/leave-spectating', ah(async (req, res) => {
  const room = await roomByCode(req.params.code);
  if (!room) throw new HttpError(404, 'Room not found.');
  const del = await pool.query(
    'DELETE FROM room_spectators WHERE room_id = $1 AND user_id = $2 RETURNING user_id',
    [room.id, req.user.id]
  );
  if (del.rowCount) {
    rt.emitRoom(room.code, { action: 'spectate_left', username: req.user.username, display_name: req.user.display_name });
  }
  res.json(await roomPayload(room.code, req.user.id));
}));

// ---------------------------------------------------------------------------
// SETTINGS — host only, while in lobby
// ---------------------------------------------------------------------------
router.patch('/:code', ah(async (req, res) => {
  const room = await roomByCode(req.params.code);
  if (!room) throw new HttpError(404, 'Room not found.');
  requireHost(room, req.user.id);
  // v51: Edit Room also works after the battle (the owner shaping the
  // REMATCH) — settings apply to the next battle the room mints. Only an
  // in-flight battle locks settings.
  if (room.status !== 'lobby' && room.status !== 'ended')
    throw new HttpError(409, 'Settings are locked while the battle is in progress.');

  const b = req.body || {};
  const sets = [];
  const params = [];
  if ('time_limit_seconds' in b) {
    const v = Number(b.time_limit_seconds);
    if (!Number.isInteger(v) || v < TIME_LIMIT.min || v > TIME_LIMIT.max)
      throw new HttpError(400, 'Time limit must be between 1 minute and 12 hours.');
    params.push(v);
    sets.push(`time_limit_seconds = $${params.length}`);
  }
  if ('battle_type' in b) {
    if (!BATTLE_TYPES.includes(b.battle_type)) throw new HttpError(400, 'Unknown battle type.');
    params.push(b.battle_type);
    sets.push(`result_method = $${params.length}`);
  }
  if (!sets.length) throw new HttpError(400, 'Nothing to update.');
  params.push(room.id);
  await pool.query(`UPDATE battle_rooms SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  rt.emitRoom(room.code, { action: 'settings', username: req.user.username });
  res.json(await roomPayload(req.params.code, req.user.id));
}));

// ---------------------------------------------------------------------------
// CLOSE — host only, while in lobby (soft end: history is kept)
// ---------------------------------------------------------------------------
router.post('/:code/close', ah(async (req, res) => {
  const room = await roomByCode(req.params.code);
  if (!room) throw new HttpError(404, 'Room not found.');
  requireHost(room, req.user.id);
  // v51: Close Room works in the lobby AND after the battle (the owner's
  // post-battle exit). Only an in-flight battle blocks closing.
  if (room.status !== 'lobby' && room.status !== 'ended')
    throw new HttpError(409, 'The battle is still in progress — it completes automatically when its clock runs out.');
  await pool.query(
    `UPDATE battle_rooms SET status = 'ended', ended_at = now() WHERE id = $1`, [room.id]
  );
  // Bug fix (v43): the room is over — release every seated player ('left')
  // so the room leaves THEIR Rooms list too (it used to linger forever as
  // an "ended" card with no way out for non-hosts). The host still sees
  // the ended room (their call to delete or keep it) — host_id visibility.
  await pool.query(
    `UPDATE room_participants SET state = 'left', left_at = now()
      WHERE room_id = $1 AND state IN ('waiting','ready')`, [room.id]
  );
  rt.emitRoom(room.code, { action: 'closed', by: req.user.username });
  if (room.visibility === 'public') rt.broadcastRoomsList('closed');
  res.json(await roomPayload(req.params.code, req.user.id));
}));

// ---------------------------------------------------------------------------
// v51: KICK — host-only moderation. The host may remove any SEATED PLAYER
// (never themselves; the host seat is not kickable). Server-authoritative:
// the seat is released in the DB and everyone is told to refetch — a kicked
// player can never linger as a ghost participant.
// ---------------------------------------------------------------------------
router.post('/:code/kick', ah(async (req, res) => {
  const room = await roomByCode(req.params.code);
  if (!room) throw new HttpError(404, 'Room not found.');
  requireHost(room, req.user.id);
  const target = String((req.body || {}).user_id || '');
  if (!target) throw new HttpError(400, 'A user_id is required.');
  if (target === req.user.id) throw new HttpError(400, 'You cannot kick yourself.');
  if (target === room.host_id) throw new HttpError(403, 'The room owner cannot be kicked.');
  const { rows } = await pool.query(
    `UPDATE room_participants SET state = 'left', left_at = now()
      WHERE room_id = $1 AND user_id = $2 AND state IN ('waiting','ready')
      RETURNING user_id`,
    [room.id, target]
  );
  if (!rows[0]) throw new HttpError(409, 'That artist is not in this room.');
  const kicked = (await pool.query('SELECT username, display_name FROM users WHERE id = $1', [target])).rows[0];
  rt.emitRoom(room.code, { action: 'kicked', user_id: target, username: kicked.username, display_name: kicked.display_name, by: req.user.username });
  rt.sendToUser(target, { type: 'room.kicked', code: room.code, by: req.user.username });
  res.json(await roomPayload(req.params.code, req.user.id));
}));

// ---------------------------------------------------------------------------
// DELETE — host only (v44: ANY state the creator may delete, with history
// preserved). Two paths, decided by what the room CONTAINS:
//   - no battles → HARD delete (room, seats, spectators cascade away) —
//     the empty/waiting room is gone for everyone.
//   - has battles → ARCHIVE: deleted_at is set, the room ends and releases
//     everyone, and it disappears from every list — but the battles,
//     results, submissions and the stats they already produced REMAIN
//     (Battle History reads them straight off the battles tables).
// A battle that is still IN FLIGHT (not complete/cancelled/forfeited/
// disqualified) blocks deletion — it completes on its own when its clock
// runs out (the v44 sweeper), after which the room is deletable.
// ---------------------------------------------------------------------------
const TERMINAL_BATTLE = ['complete', 'cancelled', 'forfeited', 'disqualified'];
router.delete('/:code', ah(async (req, res) => {
  const room = await roomByCode(req.params.code);
  if (!room) throw new HttpError(404, 'Room not found.');
  requireHost(room, req.user.id); // 403 for everyone else — server-side rule
  const { rows: battles } = await pool.query(
    `SELECT status FROM battles WHERE room_id = $1`, [room.id]
  );
  const live = battles.filter((b) => !TERMINAL_BATTLE.includes(b.status));
  if (live.length)
    throw new HttpError(409, 'A battle is still in progress in this room — it completes automatically when its clock runs out. Delete the room after that.');

  if (!battles.length) {
    // v44 fix: this schema has NO foreign-key cascades (the original dump
    // dropped them), so "cascade" never worked — deleting only the room row
    // left orphaned 'waiting' seats behind, which then blocked the
    // one-active-seat index. Delete the dependents explicitly.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE room_participants SET state = 'left', left_at = now()
          WHERE room_id = $1 AND state IN ('waiting','ready')`, [room.id]);
      await client.query('DELETE FROM room_participants WHERE room_id = $1', [room.id]);
      await client.query('DELETE FROM room_spectators WHERE room_id = $1', [room.id]);
      await client.query(
        `UPDATE matchmaking_queue SET status = 'cancelled'
           WHERE matched_room_id = $1 AND status NOT IN ('cancelled','expired')`, [room.id]);
      await client.query('DELETE FROM battle_rooms WHERE id = $1', [room.id]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    rt.emitRoom(room.code, { action: 'deleted', by: req.user.username });
    if (room.visibility === 'public') rt.broadcastRoomsList('closed');
    return res.json({ ok: true, archived: false });
  }
  // Archive: the room container goes away; the history stays.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE battle_rooms SET deleted_at = now(), status = 'ended',
                               ended_at = COALESCE(ended_at, now())
        WHERE id = $1`, [room.id]
    );
    await client.query(
      `UPDATE room_participants SET state = 'left', left_at = now()
        WHERE room_id = $1 AND state IN ('waiting','ready')`, [room.id]
    );
    await client.query(`DELETE FROM room_spectators WHERE room_id = $1`, [room.id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  rt.emitRoom(room.code, { action: 'deleted', by: req.user.username });
  if (room.visibility === 'public') rt.broadcastRoomsList('closed');
  res.json({ ok: true, archived: true });
}));

// ---------------------------------------------------------------------------
// START BATTLE — the seam to the battle engine (host click, manual rooms)
// v35: runs the shared start core — full room + EVERY canvas picked, then
// the challenge is generated and locked in the same transaction.
// ---------------------------------------------------------------------------
router.post('/:code/start', ah(async (req, res) => {
  const client = await pool.connect();
  let challengeSummary = null;
  try {
    await client.query('BEGIN');
    const { rows: roomRows } = await client.query(
      'SELECT * FROM battle_rooms WHERE code = $1 FOR UPDATE', [String(req.params.code).trim()]
    );
    const room = roomRows[0];
    if (!room) throw new HttpError(404, 'Room not found.');
    requireHost(room, req.user.id);
    if (room.status !== 'lobby') throw new HttpError(409, 'This room is not ready to start.');
    const players = await activeParticipants(room.id, client);
    challengeSummary = await startBattleInTx(client, room, players, req.user.id);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  const code = String(req.params.code).trim();
  rt.emitRoom(code, { action: 'started', by: req.user.username });
  if (challengeSummary) rt.emitRoom(code, { action: 'challenge_locked', by: 'randomizer', summary: challengeSummary });
  await emitCountdownIfArmed(code); // v36: 3-2-1, synchronized for everyone
  res.json(await roomPayload(code, req.user.id));
}));

// ---------------------------------------------------------------------------
// REMATCH (v44) — the post-battle flow. One artist requests, the other
// decides; only on ACCEPT does a NEW battle instance begin (new battles row
// + new challenge via the same start core). The previous battle and its
// result are never touched — history stays history.
//   POST /:code/rematch            request (battle participant only)
//   POST /:code/rematch/accept     invitee accepts → new battle + challenge
//   POST /:code/rematch/decline    invitee declines
//   POST /:code/rematch/cancel     requester takes it back
// ---------------------------------------------------------------------------
async function latestBattleRow(roomId, q) {
  const { rows } = await (q || pool).query(
    `SELECT id, status FROM battles WHERE room_id = $1 ORDER BY created_at DESC LIMIT 1`, [roomId]
  );
  return rows[0] || null;
}

async function battleOpponent(battleId, meId, q) {
  const { rows } = await (q || pool).query(
    `SELECT bp.user_id, u.username, u.display_name
       FROM battle_participants bp JOIN users u ON u.id = bp.user_id
      WHERE bp.battle_id = $1 AND bp.user_id <> $2 LIMIT 1`,
    [battleId, meId]
  );
  return rows[0] || null;
}

router.post('/:code/rematch', ah(async (req, res) => {
  const room = await roomByCode(req.params.code);
  if (!room) throw new HttpError(404, 'Room not found.');
  const battle = await latestBattleRow(room.id);
  if (!battle || battle.status !== 'complete')
    throw new HttpError(409, 'A rematch is only available after the battle is completed.');

  // Only the two artists of THAT battle may rematch each other.
  const { rows: meRow } = await pool.query(
    `SELECT 1 FROM battle_participants WHERE battle_id = $1 AND user_id = $2`,
    [battle.id, req.user.id]
  );
  if (!meRow[0]) throw new HttpError(403, 'Only the artists of this battle can request a rematch.');
  const opponent = await battleOpponent(battle.id, req.user.id);
  if (!opponent) throw new HttpError(409, 'No opponent found for a rematch.');

  // One pending request per room (DB index uq_rematch_pending_per_room).
  const { rows: pending } = await pool.query(
    `SELECT from_user_id, to_user_id FROM rematch_requests
      WHERE room_id = $1 AND status = 'pending'`, [room.id]
  );
  if (pending[0]) {
    if (pending[0].from_user_id === req.user.id)
      return res.json(await roomPayload(req.params.code, req.user.id)); // idempotent (already pending)
    throw new HttpError(409, '@' + opponent.username + ' already requested a rematch — accept or decline it.');
  }
  // The opponent must be free to take the seat (one active room per artist).
  const oppRoom = await activeRoomOf(opponent.user_id);
  if (oppRoom)
    throw new HttpError(409, '@' + opponent.username + ' is currently in another room — they cannot accept a rematch yet.');

  try {
    await pool.query(
      `INSERT INTO rematch_requests (room_id, from_user_id, to_user_id) VALUES ($1, $2, $3)`,
      [room.id, req.user.id, opponent.user_id]
    );
  } catch (e) {
    if (e && e.code === '23505')
      return res.json(await roomPayload(req.params.code, req.user.id)); // race → idempotent
    throw e;
  }
  rt.emitRoom(room.code, { action: 'rematch_requested', username: req.user.username, display_name: req.user.display_name });
  res.json(await roomPayload(req.params.code, req.user.id)); // v44: room payload (client re-renders)
}));

router.post('/:code/rematch/accept', ah(async (req, res) => {
  const room = await roomByCode(req.params.code);
  if (!room) throw new HttpError(404, 'Room not found.');
  const battle = await latestBattleRow(room.id);
  if (!battle || battle.status !== 'complete')
    throw new HttpError(409, 'A rematch is only available after the battle is completed.');

  const client = await pool.connect();
  let summary = null;
  let requester = null;
  try {
    await client.query('BEGIN');
    const { rows: reqRows } = await client.query(
      `SELECT r.id, r.from_user_id, u.username, u.display_name
         FROM rematch_requests r JOIN users u ON u.id = r.from_user_id
        WHERE r.room_id = $1 AND r.status = 'pending' AND r.to_user_id = $2
        ORDER BY r.created_at DESC LIMIT 1 FOR UPDATE OF r`,
      [room.id, req.user.id]
    );
    const request = reqRows[0];
    if (!request) throw new HttpError(409, 'There is no rematch request for you in this room.');
    requester = request;

    // Both artists must be free (the DB one-active-seat index is the final
    // word — the checks here make the failure friendly).
    for (const uid of [request.from_user_id, req.user.id]) {
      const occupied = await activeRoomOf(uid, client);
      if (occupied && occupied.code !== room.code)
        throw new HttpError(409, 'One of the artists is already in another room — the rematch cannot start.');
    }
    // v44: re-seating can race with a fresh join elsewhere — the DB unique
    // index is the last word; surface it as a friendly 409, never a 500.
    try {
      await client.query(
        `UPDATE room_participants SET state = 'waiting', left_at = NULL, ready_at = NULL, joined_at = now()
          WHERE room_id = $1 AND user_id IN ($2, $3)`,
        [room.id, request.from_user_id, req.user.id]
      );
    } catch (e) {
      if (e && e.code === '23505')
        throw new HttpError(409, 'One of the artists just joined another room — the rematch cannot start.');
      throw e;
    }

    // Reopen the room: both seats reactivated (canvases are remembered on
    // the seat rows), the room returns to the lobby, then the SAME start
    // core mints a NEW battle (new battles row + new locked challenge +
    // the 3-2-1 countdown) — the previous battle/result stay untouched.
    // (Re-seating happened above, inside the 23505-guarded step.)
    await client.query(
      `UPDATE battle_rooms SET status = 'lobby', ended_at = NULL, starts_at = NULL WHERE id = $1`,
      [room.id]
    );
    const players = await activeParticipants(room.id, client);
    summary = await startBattleInTx(client, { ...room, status: 'lobby' }, players, null);
    await client.query(
      `UPDATE rematch_requests SET status = 'accepted', responded_at = now() WHERE id = $1`,
      [request.id]
    );
    await client.query(
      `INSERT INTO battle_event_log (battle_id, event_type, actor_id, payload)
       VALUES ((SELECT id FROM battles WHERE room_id = $1 ORDER BY created_at DESC LIMIT 1),
               'rematch_accepted', $2, '{}')`,
      [room.id, req.user.id]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  rt.emitRoom(room.code, { action: 'rematch_accepted', username: req.user.username, display_name: req.user.display_name });
  rt.emitRoom(room.code, { action: 'started', by: 'rematch' });
  if (summary) rt.emitRoom(room.code, { action: 'challenge_locked', by: 'randomizer', summary });
  await emitCountdownIfArmed(room.code);
  res.json(await roomPayload(req.params.code, req.user.id));
}));

router.post('/:code/rematch/decline', ah(async (req, res) => {
  const room = await roomByCode(req.params.code);
  if (!room) throw new HttpError(404, 'Room not found.');
  const { rows } = await pool.query(
    `UPDATE rematch_requests SET status = 'declined', responded_at = now()
      WHERE room_id = $1 AND status = 'pending' AND to_user_id = $2 RETURNING id`,
    [room.id, req.user.id]
  );
  if (!rows[0]) throw new HttpError(409, 'There is no rematch request for you in this room.');
  // v51 (spec): declining also REMOVES the decliner from the room — the
  // rematch state is cleaned up, no lingering membership. The room itself is
  // untouched: if it is public and still hosted, they can rejoin normally.
  const { rows: goneRows } = await pool.query(
    `UPDATE room_participants SET state = 'left', left_at = now()
      WHERE room_id = $1 AND user_id = $2 AND state IN ('waiting','ready')
      RETURNING user_id`,
    [room.id, req.user.id]
  );
  rt.emitRoom(room.code, { action: 'rematch_declined', username: req.user.username, display_name: req.user.display_name });
  if (goneRows[0]) rt.emitRoom(room.code, { action: 'left', username: req.user.username, display_name: req.user.display_name, why: 'rematch_declined' });
  res.json(await roomPayload(req.params.code, req.user.id));
}));

router.post('/:code/rematch/cancel', ah(async (req, res) => {
  const room = await roomByCode(req.params.code);
  if (!room) throw new HttpError(404, 'Room not found.');
  const { rows } = await pool.query(
    `UPDATE rematch_requests SET status = 'cancelled', responded_at = now()
      WHERE room_id = $1 AND status = 'pending' AND from_user_id = $2 RETURNING id`,
    [room.id, req.user.id]
  );
  if (!rows[0]) throw new HttpError(409, 'You have no pending rematch request in this room.');
  rt.emitRoom(room.code, { action: 'rematch_cancelled', username: req.user.username, display_name: req.user.display_name });
  res.json(await roomPayload(req.params.code, req.user.id));
}));

// ---------------------------------------------------------------------------
// MATCHMAKING — room creation for the /api/matchmaking queue (v35).
// Private 1v1, auto_start: the battle begins on its own once both artists
// have picked their canvas. `client` lets the caller join the room insert
// to the queue transaction (atomic match).
// ---------------------------------------------------------------------------
async function createMatchRoom(userA, userB, client) {
  const q = client || pool;
  let roomId;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const { rows } = await q.query(
        `INSERT INTO battle_rooms (code, host_id, name, room_type, visibility, max_players,
                                   time_limit_seconds, result_method, battle_mode, auto_start)
         VALUES ($1, $2, NULL, 'casual', 'private', 2, 1200, 'voting_community', '1v1', true)
         RETURNING id`,
        [newRoomCode(), userA.id]
      );
      roomId = rows[0].id;
      break;
    } catch (e) {
      if (e.code !== '23505') throw e; // code collision — fresh code
    }
  }
  if (!roomId) throw new HttpError(500, 'Could not allocate a room code. Try again.');
  await q.query(
    `INSERT INTO room_participants (room_id, user_id, state, seat)
     VALUES ($1, $2, 'waiting', 1), ($1, $3, 'waiting', 2)`,
    [roomId, userA.id, userB.id]
  );
  const { rows } = await q.query('SELECT code FROM battle_rooms WHERE id = $1', [roomId]);
  return { roomId, code: rows[0].code };
}

// ---------------------------------------------------------------------------
// Realtime access check — the Phase 5 hub calls this to decide whether a
// connected user may subscribe to a room: public rooms are visible to
// everyone, private rooms only to their players/spectators.
// ---------------------------------------------------------------------------
async function canViewRoom(code, user) {
  const room = await roomByCode(code);
  if (!room) return { ok: false, reason: 'Room not found.' };
  if (room.visibility === 'public') return { ok: true };
  const { rows } = await pool.query(
    `SELECT 1 FROM room_participants WHERE room_id = $1 AND user_id = $2
       UNION
     SELECT 1 FROM room_spectators WHERE room_id = $1 AND user_id = $2`,
    [room.id, user.id]
  );
  return rows.length
    ? { ok: true }
    : { ok: false, reason: 'You do not have access to that room.' };
}

module.exports = { router, canViewRoom, roomByCode, roomPayload, battleChallengePayload, createMatchRoom, startCountdownSweeper, startRematchSweeper, activeRoomOf };
