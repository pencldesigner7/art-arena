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
const { pool, HttpError, ah, requireAuth, premiumOf, avatarUrlOf,
} = require('./lib');
const rt = require('./realtime');
const { lockChallengeCore } = require('./challenge');
const { notifyUser } = require('./notify'); // v52: the ONE notifier (rematch requests)
const { finishBattleIfDue, decideBattleIfDue, voteState, announce } = require('./battle-end');

const router = express.Router();
router.use(requireAuth);

const HARD_MAX_PLAYERS = 16;
const TIME_LIMIT = { min: Number(process.env.TIME_LIMIT_MIN_S || 60), max: 43200 }; // 1 minute .. 12 hours (min env-overridable test seam; default unchanged)
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
            b.start_time, b.official_end_time, b.countdown_ends_at, -- v36: the synced clock
            b.voting_ends_at                                        -- v58: the voting window
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
      `SELECT br.method, br.decided_at, br.scores,
              u.username AS winner_username, u.display_name AS winner_display_name
         FROM battle_results br
         LEFT JOIN users u ON u.id = br.winner_id
        WHERE br.battle_id = $1 LIMIT 1`, [battle.id]);
    result = res[0]
      ? { method: res[0].method, decided_at: res[0].decided_at,
          winner_username: res[0].winner_username || null,
          winner_display_name: res[0].winner_display_name || null,
          scores: res[0].scores || null }   // v64: lane tallies + team_winner
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
      if (r) { announce(r); return roomPayload(code, me); } // fresh read
    }
    // v58: same heal for a voting window that has closed
    const vdue = await pool.query(
      `SELECT id FROM battles
        WHERE room_id = $1 AND status = 'judging'
          AND voting_ends_at IS NOT NULL AND voting_ends_at <= now()
        LIMIT 1`, [room.id]);
    if (vdue.rows[0]) {
      const r = await decideBattleIfDue(vdue.rows[0].id);
      if (r) { announce(r); return roomPayload(code, me); } // fresh read — players were released
    }
  } catch (_) { /* fall through to the current state */ }
  const [players, spectators, battleRow, hostRow, twitchRow] = await Promise.all([
    activeParticipants(room.id),
    spectatorsOf(room.id),
    latestBattle(room.id),
    room.host_id
      ? pool.query('SELECT id, username, display_name FROM users WHERE id = $1', [room.host_id])
      : Promise.resolve({ rows: [{}] }),
    // v62: the room's active Twitch stream session (preparing/live only —
    // ended sessions are history and never surface as a live claim).
    pool.query(
      `SELECT id, status, title, started_at, broadcaster_twitch_id,
              broadcaster_login, broadcaster_display_name, broadcaster_profile_image_url
         FROM twitch_stream_sessions
        WHERE room_id = $1 AND status IN ('preparing','live')
        ORDER BY created_at DESC
        LIMIT 1`,
      [room.id]
    ),
  ]);
  // v47 server fix: this was destructured as `const battle` above, so the
  // countdown self-heal below (`battle = await latestBattle(...)`) threw
  // "Assignment to constant variable" — the room GET 500'd in exactly the
  // countdown→active window it was supposed to heal. `let` fixes the heal.
  let battle = battleRow;
  const host = hostRow.rows[0];
  // v62: the active Twitch session for this room — public info (the room
  // badge + watch link come from here); tokens never leave the server.
  const twitchSession = twitchRow.rows[0] || null;
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
    }
    // v52 (countdown bug): ALWAYS re-read after the flip attempt. When the
    // sweeper wins the race the UPDATE returns nothing — falling through with
    // the STALE 'countdown' row (a clock already in the past) made clients
    // restart the overlay and flash "GO!" twice. The fresh row is the truth.
    battle = await latestBattle(room.id);
  }
  const challenge = battle ? await battleChallengePayload(battle.id) : null;
  // v58: Community Voting state — during the window (live tally, my vote,
  // whether I may vote) and after it (the final count on the result panel).
  let voting = null;
  if (battle && battle.result_method === 'voting_community' &&
      (battle.status === 'judging' || battle.status === 'result' || battle.status === 'complete')) {
    const vs = await voteState(battle.id, me);
    const open = battle.status === 'judging' && battle.voting_ends_at && new Date(battle.voting_ends_at).getTime() > Date.now();
    const isArtist = !!(me && vs.options.some((o) => o.user_id === me));
    // v64: a 3v3 voter may cast up to one ballot per lane (vs.my_votes is a
    // { lane: user_id } map) — can_vote stays true while ANY lane is open
    // for them; 1v1 has exactly one lane, so the rule is unchanged there.
    const remaining = (vs.lanes || []).filter((l) => !vs.my_votes[l.lane]);
    voting = {
      open: !!open,
      ends_at: battle.voting_ends_at || null,
      total: vs.total,
      options: vs.options,
      my_vote: vs.my_vote,
      my_votes: vs.my_votes || {},   // v64
      lanes: vs.lanes || [],         // v64
      team: !!vs.team,               // v64
      can_vote: !!(open && me && !isArtist && remaining.length > 0),
      can_vote_lanes: !!open && me && !isArtist,
      is_artist: isArtist,
    };
  }
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
  // v53: re-roll is PRE-MATCH (reveal) only — unlimited while allowed.
  // Once the countdown/active starts the phase flips to 'live' and the
  // client hides the button entirely for EVERYONE (spec).
  let reroll = null;
  if (battle && (battle.status === 'challenge_locked' || battle.status === 'countdown' || battle.status === 'active')) {
    const isRoomHost = room.host_id === me;
    const prem = me ? await premiumOf(me) : { active: false };
    const reveal = battle.status === 'challenge_locked';
    reroll = { phase: reveal ? 'reveal' : 'live', allowed: !!(reveal && prem.active && isRoomHost) };
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
    bracket: (room.battle_mode === 'tournament') ? (room.bracket || null) : null, // v63c
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
      voting_ends_at: battle.voting_ends_at || null, // v58
      voting,                                         // v58: Community Voting
      reroll, // v52: Premium re-roll window (server-computed for THIS user)
      challenge,
    } : null,
    // v62: active Twitch stream session (preparing/live) for this room —
    // the UI renders the 🔴 LIVE badge, watch link and embed from this.
    // Server truth only: the session exists because the HOST prepared it and
    // 'live' only ever means Twitch confirmed the stream.
    twitch: twitchSession ? {
      id: twitchSession.id,
      status: twitchSession.status,
      title: twitchSession.title,
      started_at: twitchSession.started_at,
      broadcaster: {
        id: twitchSession.broadcaster_twitch_id,
        login: twitchSession.broadcaster_login,
        display_name: twitchSession.broadcaster_display_name || twitchSession.broadcaster_login,
        profile_image_url: twitchSession.broadcaster_profile_image_url,
      },
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
async function startBattleInTx(client, room, players, actorId, opts) {
  const mode = room.battle_mode || '1v1';
  if (mode === '1v1') {
    if (players.length !== 2)
      throw new HttpError(409, `1v1 needs exactly 2 players (currently ${players.length}).`);
  } else if (mode === 'tournament') {
    // v63d: a seeded tournament shrinks LEGITIMATELY (a lobby forfeit
    // releases the seat, the bracket auto-advances) — the fullness gate
    // applies only to the FIRST start, when the roster is drawn.
    if (!room.bracket && players.length < room.max_players)
      throw new HttpError(409, `Waiting for all players to join (${players.length}/${room.max_players}).`);
  } else if (players.length < room.max_players) {
    throw new HttpError(409, `Waiting for all players to join (${players.length}/${room.max_players}).`);
  }
  if (players.some((p) => !p.drawing_app_key))
    throw new HttpError(409, 'Waiting for all players to select their canvas.');

  // v63c: TOURNAMENT rooms battle on the BRACKET. The first time the room
  // starts, the full roster is seeded randomly (crypto shuffle) into a
  // single-elimination tree with byes; every later start plays the bracket's
  // next open two-sided match (the previous match's result already advanced
  // its winner and returned the room to lobby). Draws keep the same pairing
  // open for a replay.
  let seated;
  if (mode === 'tournament') {
    const bracketApi = require('./bracket');
    let bracket = room.bracket || null;
    if (!bracket) {
      bracket = bracketApi.seedBracket(players.map((p) => p.user_id));
      // v63d: the rooms layer annotates the tree with display names — the
      // engine stays id-only, but the UI can render an ENDED room (seats
      // released) without losing who was who.
      bracket.names = {};
      for (const p of players)
        bracket.names[p.user_id] = { username: p.username, display_name: p.display_name };
      await client.query(
        `UPDATE battle_rooms SET bracket = $2::jsonb WHERE id = $1`,
        [room.id, JSON.stringify(bracket)]
      );
    }
    const next = bracketApi.sweep(bracket);
    if (next.state !== 'match')
      throw new HttpError(409, 'The bracket has no open match — the tournament is over.');
    const m = bracket.rounds[next.r].matches[next.m];
    seated = players.filter((p) => p.user_id === m.a || p.user_id === m.b).sort((x, y) => x.seat - y.seat);
    if (seated.length !== 2)
      throw new HttpError(409, 'The next bracket match is not fully seated yet.');
    await client.query(
      `UPDATE battle_rooms SET bracket = $2::jsonb WHERE id = $1`,
      [room.id, JSON.stringify(bracket)]
    );
  } else if (mode === '3v3') {
    // v64 — FULL 3v3: every seated artist participates. Seats 1-3 are
    // Team A (host side), 4-6 are Team B (open side); the three LANES are
    // A1-B1 (seats 1v4), A2-B2 (2v5), A3-B3 (3v6), one shared challenge,
    // and the room's start gate above guarantees all six seats are full.
    seated = players.slice().sort((x, y) => x.seat - y.seat);
  } else {
    // The current battle engine is one-on-one: the two seated artists
    // battle; the room's mode + capacity stay the creator's truth.
    seated = players.slice(0, 2);
  }
  // v64: a 3v3 room runs ONE battle across all six artists (format 'multi',
  // lanes derived from seats at judging time); 1v1 and tournament matches
  // stay 'one_on_one'.
  const battleFormat = mode === '3v3' ? 'multi' : 'one_on_one';
  const { rows: bRows } = await client.query(
    `INSERT INTO battles (room_id, competition_type, format, result_method,
                          time_limit_seconds, status)
     VALUES ($1, $2, $3, $4, $5, 'waiting')
     RETURNING id`,
    [room.id, COMPETITION_BY_ROOM_TYPE[room.room_type] || 'casual',
     battleFormat, room.result_method, room.time_limit_seconds]
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
  // v62: same link for a prepared Twitch stream session (preparing/live) —
  // the LIVE page chain (host → session → battle) completes here too.
  await client.query(
    `UPDATE twitch_stream_sessions SET battle_id = $2, updated_at = now()
      WHERE room_id = $1 AND battle_id IS NULL AND status IN ('preparing','live')`,
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
  // v53 (premium re-roll spec): HOST-started battles get a REVEAL phase —
  // the challenge is generated and shown ('challenge_locked') WITHOUT the
  // countdown. Premium members may re-roll it here (infinitely); the host
  // then LAUNCHES, which arms the 3-2-1 countdown. Auto-start rooms
  // (matchmaking) keep the immediate countdown — no host UI to launch.
  if (challengeLocked && !(opts && opts.reveal)) {
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
            -- v65: the same three seated artists, now carrying their avatar
            -- keys (aligned 1:1 with player_names by seat order) so the
            -- homepage/rooms lists can show real profile pictures with the
            -- initial as the honest fallback instead of always initials.
            COALESCE((SELECT json_agg(json_build_object(
                              'username', u.username,
                              'display_name', u.display_name,
                              'key', p.avatar_storage_key,
                              'at', p.updated_at)
                          ORDER BY rp.seat)
                    FROM (SELECT rp.user_id, rp.seat
                            FROM room_participants rp
                            WHERE rp.room_id = r.id AND rp.state IN ('waiting','ready')
                            ORDER BY rp.seat LIMIT 3) rp
                    JOIN users u ON u.id = rp.user_id
                    LEFT JOIN user_profiles p ON p.user_id = u.id), '[]'::json) AS player_briefs,
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
      player_briefs: (r.player_briefs || []).map((pb) => ({
        username: pb.username,
        display_name: pb.display_name,
        avatar_url: avatarUrlOf ? avatarUrlOf(pb.key, pb.at) : (pb.key ? '/avatars/' + pb.key : null),
      })),   // v65: avatars for the live-strip/dashboard avatar circles
      my_role: r.host_id === req.user.id ? 'host' : (r.i_am_player ? 'player' : (r.i_am_spectator ? 'spectator' : null)),
    })),
  });
}));

// ---------------------------------------------------------------------------
// CREATE — the current user becomes host AND player (seat 1)
// v35: creator controls — battle mode (1v1 / 3v3 / tournament) + max
// players (2..16; 1v1 always seats exactly 2).
// ---------------------------------------------------------------------------
// v61: the create logic is a reusable function — the Friends page's
// "open a 3v3 room for my team" goes through EXACTLY this path (same
// validation, same seat rules, same broadcast). Returns the room payload.
async function createRoomForUser(user, b) {
  const req = { user, body: b || {} };
  let out = null;
  await createRoomImpl(req, { status() { return this; }, json(p) { out = p; } });
  return out;
}
router.post('/', ah(createRoomImpl));
async function createRoomImpl(req, res) {
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
  // v63c: tournaments run single-elimination — every match must be
  // decidable, so the community vote is the required battle type.
  if (battleMode === 'tournament' && battleType !== 'voting_community')
    throw new HttpError(400, 'Tournaments use Community Vote so every match can be decided.');
  // v65: tournament creation is a PREMIUM entitlement — enforced here (the
  // server is the gate; hiding the button client-side is never enough).
  if (battleMode === 'tournament' && !(await premiumOf(req.user.id)).active)
    throw new HttpError(403, 'Creating tournaments is an Art Arena Premium feature — upgrade to host a bracket.');
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
}

// ---------------------------------------------------------------------------
// DETAIL
// ---------------------------------------------------------------------------
router.get('/:code', ah(async (req, res) => {
  const payload = await roomPayload(req.params.code, req.user.id);
  if (!payload) throw new HttpError(404, 'Room not found.');
  res.json(payload);
}));

// ---------------------------------------------------------------------------
// v63f: 3v3 seat policy — seats 1-3 are the HOST'S side (Team A: the creator
// invited those teammates), seats 4-6 are the open side (Team B). A joiner
// who carries an open team-A room invitation seats on the host's side;
// everyone else fills the OPEN side first (their seats stay available for
// the invited teammates until the open side is full). 1v1/tournament rooms
// keep plain ascending first-free-seat order.
// ---------------------------------------------------------------------------
async function pickSeatForJoin(client, room, userId) {
  const { rows: takenRows } = await client.query(
    `SELECT seat FROM room_participants WHERE room_id = $1 AND state IN ('waiting','ready')`,
    [room.id]
  );
  const taken = new Set(takenRows.map((s) => s.seat));
  if (room.battle_mode !== '3v3') {
    for (let i = 1; i <= room.max_players; i++) if (!taken.has(i)) return i;
    return null;
  }
  // 3v3: does this user hold an OPEN team-A invitation to this room?
  const inv = await client.query(
    `SELECT 1 FROM notifications
      WHERE user_id = $1 AND type = 'room_invitation'
        AND payload->>'room_code' = $2 AND payload->>'team' = 'A'
        AND (payload->>'handled' IS NULL OR payload->>'handled' = 'accepted')
        AND created_at > now() - interval '2 hours'
      LIMIT 1`,
    [userId, room.code]
  );
  const invitedA = inv.rows.length > 0;
  const order = invitedA ? [2, 3, 4, 5, 6] : [4, 5, 6, 2, 3];
  for (const i of order) if (i >= 1 && i <= room.max_players && !taken.has(i)) return i;
  return null;
}

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
    // v63d: once a tournament bracket is seeded the roster is FIXED — the
    // tree was drawn from the original seated artists, so a new seat can
    // never join mid-event (even a re-join would strand them off-bracket).
    if (room.battle_mode === 'tournament' && room.bracket)
      throw new HttpError(409, 'This tournament has already been drawn — its bracket is locked.');
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
      // v63f: 3v3 rooms honour the team side of the invitation (A = host side).
      const freeSeat = await pickSeatForJoin(client, room, req.user.id);
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
      // v63f: seat policy shared with the spectator-promotion branch (3v3
      // rooms seat open-side joiners on 4-6 first; team-A invitees on 1-3).
      const seat = await pickSeatForJoin(client, room, req.user.id);
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
    // v63c: a tournament player leaving in lobby forfeits their bracket
    // path — their open slot is cleared and the sweep auto-advances (BYE /
    // forfeit). If that crowns a champion the room ends here.
    if (wasSeated && room.status === 'lobby' && room.battle_mode === 'tournament' && room.bracket) {
      const bracketApi = require('./bracket');
      const v = bracketApi.onLeave(room.bracket, req.user.id);
      if (v.state === 'champion') {
        room.bracket.champion = v.id;
        await client.query(
          `UPDATE battle_rooms SET bracket = $2::jsonb, status = 'ended', ended_at = now() WHERE id = $1`,
          [room.id, JSON.stringify(room.bracket)]
        );
        room.status = 'ended'; // host-transfer/close logic below stays inert
        await client.query(
          `UPDATE room_participants SET state = 'left', left_at = now()
            WHERE room_id = $1 AND state IN ('waiting','ready') AND user_id <> $2`,
          [room.id, req.user.id]
        );
      } else {
        await client.query(
          `UPDATE battle_rooms SET bracket = $2::jsonb WHERE id = $1`,
          [room.id, JSON.stringify(room.bracket)]
        );
      }
    }
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
  // v58: the Battle button's match uses the FIXED default settings.
  if (room.auto_start)
    throw new HttpError(409, 'Matchmaking battles use the fixed default settings (1v1 · public · community votes · 1 hour · randomizer).');
  // v65: a tournament may only be reshaped while its bracket is still open
  // (pre-draw); once the draw has happened the roster/tree are immutable.
  const tournamentLocked = room.battle_mode === 'tournament' && !!room.bracket;
  if (room.battle_mode === 'tournament' && room.status === 'ended' && !room.bracket)
    throw new HttpError(409, 'A tournament that never started cannot be edited — close or delete it and create a new one.');

  const b = req.body || {};
  const sets = [];
  const params = [];
  if ('name' in b) {
    const v = b.name === null ? null : String(b.name).trim().slice(0, 60) || null;
    if (v !== null && v.length < 1) throw new HttpError(400, 'Room name must be 1–60 characters.');
    params.push(v);
    sets.push(`name = $${params.length}`);
  }
  if ('visibility' in b) {
    if (!['public', 'private'].includes(b.visibility))
      throw new HttpError(400, 'Visibility must be "public" or "private".');
    if (b.visibility === 'private' && !ROOM_CODE_RE.test(room.code))
      throw new HttpError(400, 'This room needs a valid 4–12 character code before it can become private.');
    if (tournamentLocked)
      throw new HttpError(409, 'A drawn tournament is locked — its players are committed to the bracket.');
    params.push(b.visibility);
    sets.push(`visibility = $${params.length}`);
  }
  if ('max_players' in b && room.battle_mode === 'tournament') {
    if (tournamentLocked) throw new HttpError(409, 'A drawn tournament is locked.');
    const v = Number(b.max_players);
    const seated = room.player_count !== undefined ? room.player_count
      : (await pool.query(`SELECT count(*)::int n FROM room_participants WHERE room_id = $1 AND state IN ('waiting','ready')`, [room.id])).rows[0].n;
    if (!Number.isInteger(v) || v < Math.max(8, seated) || v > HARD_MAX_PLAYERS)
      throw new HttpError(400, 'A tournament must seat between 8 and 16 players (at least the ' + seated + ' already seated).');
    params.push(v);
    sets.push(`max_players = $${params.length}`);
  }
  if ('time_limit_seconds' in b) {
    const v = Number(b.time_limit_seconds);
    if (!Number.isInteger(v) || v < TIME_LIMIT.min || v > TIME_LIMIT.max)
      throw new HttpError(400, 'Time limit must be between 1 minute and 12 hours.');
    params.push(v);
    sets.push(`time_limit_seconds = $${params.length}`);
  }
  if ('battle_type' in b) {
    if (!BATTLE_TYPES.includes(b.battle_type)) throw new HttpError(400, 'Unknown battle type.');
    // v63d: tournaments are single-elimination decided by the community
    // vote — same fixed rule as create (editing it mid-event would stall
    // every later match).
    if (room.battle_mode === 'tournament' && b.battle_type !== 'voting_community')
      throw new HttpError(400, 'Tournaments use Community Vote so every match can be decided.');
    params.push(b.battle_type);
    sets.push(`result_method = $${params.length}`);
  }
  if (!sets.length) throw new HttpError(400, 'Nothing to update.');
  params.push(room.id);
  await pool.query(`UPDATE battle_rooms SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  rt.emitRoom(room.code, { action: 'settings', username: req.user.username, what: sets.join(', ') });
  if ('visibility' in b && b.visibility === 'public') rt.broadcastRoomsList('visibility');
  res.json(await roomPayload(req.params.code, req.user.id));
}));

// ---------------------------------------------------------------------------
// v65 — JOIN REQUESTS (full rooms): a lobby room at capacity can accept
// requests to join. The HOST is notified through the standard notifications
// engine (one notification row per request; state survives refresh/nav) and
// answers Accept / Decline. Accept seats the requester through the same
// rules as /join (free seat required — otherwise the host is told to free
// one first); Decline simply closes the request. Both sides always learn the
// outcome through a handled notification + a realtime push.
// ---------------------------------------------------------------------------
router.post('/:code/request-join', ah(async (req, res) => {
  const { rows: roomRows } = await pool.query(
    `SELECT r.*, (SELECT count(*) FROM room_participants rp
                   WHERE rp.room_id = r.id AND rp.state IN ('waiting','ready'))::int AS player_count
       FROM battle_rooms r WHERE r.code = $1 AND r.deleted_at IS NULL FOR UPDATE`, [String(req.params.code).trim().toUpperCase()]
  );
  const room = roomRows[0];
  if (!room) throw new HttpError(404, "We couldn't find a room with that code.");
  if (room.host_id === req.user.id) throw new HttpError(409, 'You host this room.');
  if (room.status !== 'lobby') throw new HttpError(409, 'This room is not open to requests right now.');
  const seated = await pool.query(
    `SELECT 1 FROM room_participants WHERE room_id = $1 AND user_id = $2 AND state IN ('waiting','ready')`, [room.id, req.user.id]
  );
  if (seated.rows.length) throw new HttpError(409, 'You are already in this room.');
  if (room.player_count < room.max_players)
    throw new HttpError(409, 'This room has a free seat — join it directly.');
  const mine = await activeRoomOf(req.user.id);
  if (mine) throw new HttpError(409, 'You are already in a room — leave it before requesting a seat.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dup = await client.query(
      `SELECT 1 FROM notifications
        WHERE user_id = $1 AND type = 'join_request' AND payload->>'handled' IS NULL
          AND payload->>'room_code' = $2 AND payload->>'requester_user_id' = $3
        LIMIT 1`, [room.host_id, room.code, req.user.id]
    );
    if (dup.rows.length) { await client.query('COMMIT'); throw new HttpError(409, 'You already have a pending request for this room.'); }
    await notifyUser(room.host_id, 'join_request', {
      room_code: room.code, room_name: room.name || null, battle_mode: room.battle_mode || '1v1',
      requester_user_id: req.user.id, requester_username: req.user.username, requester_display_name: req.user.display_name,
      requester_avatar_key: null,
    });
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  rt.sendToUser(room.host_id, { type: 'join_request.incoming', room_code: room.code });
  res.status(201).json({ ok: true, room_code: room.code });
}));

// shared seat step for an ACCEPTED request (mirrors the /join seat rules)
async function seatAcceptedRequester(client, room, requesterId) {
  const mine = await activeRoomOf(requesterId, client);
  if (mine && mine.code !== room.code)
    return { ok: false, message: 'That player is now in another room — their request has lapsed.' };
  const existing = await client.query(
    `SELECT state, seat FROM room_participants WHERE room_id = $1 AND user_id = $2`, [room.id, requesterId]
  );
  if (existing.rows[0] && ['waiting', 'ready'].includes(existing.rows[0].state))
    return { ok: true, already: true, seat: existing.rows[0].seat };
  const { rows: cnt } = await client.query(
    `SELECT count(*)::int AS n FROM room_participants WHERE room_id = $1 AND state IN ('waiting','ready')`, [room.id]
  );
  if (cnt[0].n >= room.max_players)
    return { ok: false, message: 'The room filled up again — kick or wait for a seat before accepting.' };
  const seat = await pickSeatForJoin(client, room, requesterId);
  if (seat === null)
    return { ok: false, message: 'No seat is free right now — free one first, then accept.' };
  if (existing.rows[0]) {
    // a row exists in a non-active state (left/kicked) — reactivate it
    await client.query(
      `UPDATE room_participants SET state = 'waiting', left_at = NULL, seat = $3
        WHERE room_id = $1 AND user_id = $2`,
      [room.id, requesterId, seat]
    );
  } else {
    await client.query(
      `INSERT INTO room_participants (room_id, user_id, state, seat)
       VALUES ($1, $2, 'waiting', $3)`,
      [room.id, requesterId, seat]
    );
  }
  return { ok: true, seat };
}
async function answerJoinRequest(req, res, action) {
  const requesterId = String(req.params.requesterId || '');
  if (!/^[0-9a-f-]{36}$/i.test(requesterId)) throw new HttpError(400, 'Invalid user id.');
  const client = await pool.connect();
  let outcome = null; let requesterName = null; let roomCode = String(req.params.code).trim().toUpperCase();
  try {
    await client.query('BEGIN');
    const { rows: roomRows } = await client.query(
      `SELECT * FROM battle_rooms WHERE code = $1 AND deleted_at IS NULL FOR UPDATE`, [roomCode]
    );
    const room = roomRows[0];
    if (!room) throw new HttpError(404, 'Room not found.');
    requireHost(room, req.user.id);
    if (room.status !== 'lobby') throw new HttpError(409, 'The room is no longer accepting players.');
    const pend = await client.query(
      `SELECT id FROM notifications
        WHERE user_id = $1 AND type = 'join_request' AND payload->>'handled' IS NULL
          AND payload->>'room_code' = $2 AND payload->>'requester_user_id' = $3
        FOR UPDATE`, [room.host_id, room.code, requesterId]
    );
    if (!pend.rows.length) throw new HttpError(409, 'That request is no longer pending.');
    const { rows: who } = await client.query(
      `SELECT username, display_name FROM users WHERE id = $1`, [requesterId]
    );
    requesterName = who[0];
    if (action === 'decline') {
      await client.query(
        `UPDATE notifications SET payload = payload || jsonb_build_object('handled', 'declined', 'answered_at', now()::text)
          WHERE id = ANY($1::uuid[])`, [pend.rows.map((r) => r.id)]
      );
      outcome = { action: 'declined' };
    } else {
      const seat = await seatAcceptedRequester(client, room, requesterId);
      if (!seat.ok) throw new HttpError(409, seat.message);
      await client.query(
        `UPDATE notifications SET payload = payload || jsonb_build_object('handled', 'accepted', 'answered_at', now()::text)
          WHERE id = ANY($1::uuid[])`, [pend.rows.map((r) => r.id)]
      );
      outcome = { action: 'accepted', seat: seat.seat, already: !!seat.already };
    }
    await client.query('COMMIT');
    if (outcome.action === 'accepted') {
      await notifyUser(requesterId, 'join_request', {
        room_code: room.code, room_name: room.name || null,
        host_user_id: req.user.id, host_username: req.user.username, host_display_name: req.user.display_name,
        handled: 'accepted',
      });
      rt.emitRoom(room.code, { action: 'joined', username: (requesterName && requesterName.username) || 'player', display_name: requesterName && requesterName.display_name, seat: outcome.seat });
    } else {
      await notifyUser(requesterId, 'join_request', {
        room_code: room.code, room_name: room.name || null,
        host_user_id: req.user.id, host_username: req.user.username, host_display_name: req.user.display_name,
        handled: 'declined',
      });
    }
    rt.sendToUser(requesterId, { type: 'join_request.answered', room_code: room.code, action: outcome.action });
    res.json({ ok: true, action: outcome.action });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}
router.post('/:code/join-requests/:requesterId/accept', ah(async (req, res) => answerJoinRequest(req, res, 'accept')));
router.post('/:code/join-requests/:requesterId/decline', ah(async (req, res) => answerJoinRequest(req, res, 'decline')));

// ---------------------------------------------------------------------------
// v65 — HOST TEAM ORGANIZER (3v3, pre-battle): the room creator can move any
// seated player between Team A (seats 1-3) and Team B (seats 4-6) while the
// room is still in the lobby. Capacity is enforced here (never more than
// three per side) and the move broadcasts to everyone — the board re-renders
// from the server payload on all screens. Once the battle starts the room
// leaves 'lobby' and this route refuses (server-side lock).
// ---------------------------------------------------------------------------
router.post('/:code/teams/move', ah(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: roomRows } = await client.query(
      `SELECT * FROM battle_rooms WHERE code = $1 AND deleted_at IS NULL FOR UPDATE`, [String(req.params.code).trim().toUpperCase()]
    );
    const room = roomRows[0];
    if (!room) throw new HttpError(404, 'Room not found.');
    requireHost(room, req.user.id);
    if (room.battle_mode !== '3v3') throw new HttpError(400, 'Team sides only exist in 3v3 rooms.');
    if (room.status !== 'lobby') throw new HttpError(409, 'Teams lock the moment the battle starts.');
    const targetId = String((req.body || {}).user_id || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(targetId)) throw new HttpError(400, 'Pick a seated player to move.');
    if (targetId === req.user.id) throw new HttpError(400, 'The host side of a 3v3 room is Team A — the host cannot be moved.');
    const side = String((req.body || {}).side || '').toUpperCase();
    if (side !== 'A' && side !== 'B') throw new HttpError(400, 'Choose a side: A or B.');
    const { rows: parts } = await client.query(
      `SELECT user_id, seat FROM room_participants WHERE room_id = $1 AND state IN ('waiting','ready')`, [room.id]
    );
    const me = parts.find((x) => x.user_id === targetId);
    if (!me) throw new HttpError(404, 'That player is not seated in this room.');
    const curSide = me.seat <= 3 ? 'A' : 'B';
    if (curSide === side) throw new HttpError(409, 'That player is already on Team ' + side + '.');
    const onSide = (sd) => parts.filter((x) => x.user_id !== targetId && (sd === 'A' ? x.seat <= 3 : x.seat > 3)).length;
    if (onSide(side) >= 3) throw new HttpError(409, 'Team ' + side + ' already has three players — move someone off it first.');
    const free = side === 'A' ? [1, 2, 3] : [4, 5, 6];
    const taken = new Set(parts.map((x) => x.seat));
    const seat = free.find((n) => !taken.has(n));
    await client.query(
      `UPDATE room_participants SET seat = $3 WHERE room_id = $1 AND user_id = $2`, [room.id, targetId, seat]
    );
    await client.query('COMMIT');
    rt.emitRoom(room.code, { action: 'teams_moved', by: req.user.username, user_id: targetId, side });
    res.json(await roomPayload(room.code, req.user.id));
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
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
// ---------------------------------------------------------------------------
// v52: PREMIUM RE-ROLL — regenerate the locked challenge from the SAME strict
// single-concept pool, never repeating the outgoing picks (data-level rule).
// Window: the first 60 s of the battle, max 3 per battle, Premium only —
// enforced HERE, so a free client can never bypass the gate.
// ---------------------------------------------------------------------------
router.post('/:code/challenge/reroll', ah(async (req, res) => {
  // v53 spec: Premium re-roll — PRE-MATCH ONLY (the reveal phase, while the
  // battle sits at 'challenge_locked') and UNLIMITED. Once the match starts
  // (countdown/active) the button is hidden client-side AND this route
  // refuses — free and premium alike draw with the locked challenge.
  const room = await roomByCode(req.params.code);
  if (!room) throw new HttpError(404, 'Room not found.');
  requireHost(room, req.user.id);
  const prem = await premiumOf(req.user.id);
  if (!prem.active)
    throw new HttpError(403, 'Re-roll is an Art Arena Premium feature — upgrade to re-roll the challenge.');
  const battle = await latestBattleRow(room.id);
  if (!battle) throw new HttpError(409, 'There is no challenge to re-roll.');
  if (battle.status !== 'challenge_locked')
    throw new HttpError(409, 'The match has started — the challenge is locked for this battle.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // keep the categories, never repeat the outgoing elements (same strict
    // single-concept pool — a re-roll is as clean as the first draw)
    const { rows: prev } = await client.query(
      `SELECT bce.category, bce.element_id
         FROM battle_challenge_elements bce
         JOIN battle_challenges bc ON bc.id = bce.challenge_id
        WHERE bc.battle_id = $1`, [battle.id]);
    const cfg = room.randomizer_config || {};
    const configuredCats = Array.isArray(cfg.categories) && cfg.categories.length
      ? cfg.categories
      : ['character', 'environment', 'object', 'style'];
    const catsToUse = prev.length ? prev.map((r) => r.category) : configuredCats;
    const prevIds = prev.map((r) => r.element_id);
    const picks = [];
    for (const cat of catsToUse) {
      let { rows: el } = await client.query(
        `SELECT id, name FROM randomizer_elements
          WHERE category = $1 AND status = 'active' AND id <> ALL($2::uuid[])
          ORDER BY random() LIMIT 1`, [cat, prevIds]);
      if (!el[0]) {
        const res = await client.query(
          `SELECT id, name FROM randomizer_elements
            WHERE category = $1 AND status = 'active'
            ORDER BY random() LIMIT 1`, [cat]);
        el = res.rows;
      }
      if (!el[0]) throw new HttpError(500, `No elements available for "${cat}".`);
      picks.push({ category: cat, element_id: el[0].id, value: el[0].name });
    }
    await client.query(
      `DELETE FROM battle_challenge_elements WHERE challenge_id IN
        (SELECT id FROM battle_challenges WHERE battle_id = $1)`, [battle.id]);
    await client.query(`DELETE FROM battle_challenges WHERE battle_id = $1`, [battle.id]);
    const summary = picks.map((x) => x.value).join(' · ');
    const { rows: ch } = await client.query(
      `INSERT INTO battle_challenges (battle_id, summary_text) VALUES ($1, $2) RETURNING id`,
      [battle.id, summary]);
    for (const x of picks) {
      await client.query(
        `INSERT INTO battle_challenge_elements (challenge_id, category, element_id, value)
         VALUES ($1, $2, $3, $4)`, [ch[0].id, x.category, x.element_id, x.value]);
    }
    await client.query(
      `INSERT INTO battle_event_log (battle_id, event_type, actor_id, payload)
       VALUES ($1, 'challenge_rerolled', $2, $3)`,
      [battle.id, req.user.id, JSON.stringify({ summary, elements: picks })]);
    await client.query('COMMIT');
    rt.emitRoom(room.code, { action: 'challenge_rerolled', by: req.user.username, summary });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  res.json(await roomPayload(req.params.code, req.user.id));
}));

// ---------------------------------------------------------------------------
// v65: MOVE / REARRANGE PLAYER SLOTS — host only (lobby phase).
// Moves or swaps a seated player between team slots (1..max_players).
// ---------------------------------------------------------------------------
router.post('/:code/move-player', ah(async (req, res) => {
  const room = await roomByCode(req.params.code);
  if (!room) throw new HttpError(404, 'Room not found.');
  requireHost(room, req.user.id);
  if (room.status !== 'lobby') throw new HttpError(409, 'Cannot rearrange players once the battle has started.');

  const b = req.body || {};
  const targetUid = b.user_id ? String(b.user_id).trim() : null;
  const fromSeat = Number(b.from_seat);
  const toSeat = Number(b.to_seat);

  if (!Number.isInteger(toSeat) || toSeat < 1 || toSeat > room.max_players) {
    throw new HttpError(400, `Target slot must be between 1 and ${room.max_players}.`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: parts } = await client.query(
      `SELECT user_id, seat FROM room_participants WHERE room_id = $1 AND state IN ('waiting','ready') FOR UPDATE`,
      [room.id]
    );

    let pFrom = null;
    if (targetUid) {
      pFrom = parts.find((p) => p.user_id === targetUid);
    } else if (Number.isInteger(fromSeat)) {
      pFrom = parts.find((p) => p.seat === fromSeat);
    }
    if (!pFrom) throw new HttpError(404, 'Player not found in this room.');
    if (pFrom.seat === toSeat) {
      await client.query('COMMIT');
      return res.json(await roomPayload(room.code, req.user.id));
    }

    const pTo = parts.find((p) => p.seat === toSeat);

    if (pTo) {
      // Swap seats using temporary negative seat to avoid conflict
      await client.query(
        `UPDATE room_participants SET seat = -1 WHERE room_id = $1 AND user_id = $2`,
        [room.id, pFrom.user_id]
      );
      await client.query(
        `UPDATE room_participants SET seat = $3 WHERE room_id = $1 AND user_id = $2`,
        [room.id, pTo.user_id, pFrom.seat]
      );
      await client.query(
        `UPDATE room_participants SET seat = $3 WHERE room_id = $1 AND user_id = $2`,
        [room.id, pFrom.user_id, toSeat]
      );
    } else {
      // Direct move into empty slot
      await client.query(
        `UPDATE room_participants SET seat = $3 WHERE room_id = $1 AND user_id = $2`,
        [room.id, pFrom.user_id, toSeat]
      );
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  rt.emitRoom(room.code, { action: 'slots_rearranged', by: req.user.username });
  res.json(await roomPayload(room.code, req.user.id));
}));


// ---------------------------------------------------------------------------
// v53: LAUNCH — the host ends the REVEAL phase. The locked challenge (as
// re-rolled or accepted) stays exactly as it is; the 3-2-1 countdown arms
// NOW and the sweeper flips the battle active at its end (the match timer
// can only begin after GO!, as ever — server-authoritative).
// ---------------------------------------------------------------------------
router.post('/:code/launch', ah(async (req, res) => {
  const room = await roomByCode(req.params.code);
  if (!room) throw new HttpError(404, 'Room not found.');
  requireHost(room, req.user.id);
  const battle = await latestBattleRow(room.id);
  if (!battle || battle.status !== 'challenge_locked')
    throw new HttpError(409, 'There is no revealed challenge to launch.');
  const { rows } = await pool.query(
    `UPDATE battles SET status = 'countdown', countdown_ends_at = now() + interval '3 seconds'
      WHERE id = $1 AND status = 'challenge_locked' RETURNING countdown_ends_at`,
    [battle.id]);
  if (!rows[0]) throw new HttpError(409, 'The battle is already launching.');
  rt.emitRoom(room.code, { action: 'countdown', countdown_ends_at: rows[0].countdown_ends_at });
  res.json(await roomPayload(req.params.code, req.user.id));
}));

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
// v58: COMMUNITY VOTING — POST /:code/vote { user_id }
// One REAL row in battle_votes per (battle, voter): the unique index is the
// authority, so refreshing/reopening/double-clicking can never vote twice.
// Eligible: any signed-in user who is NOT one of the two artists (the
// ck_no_self_vote check backs this at the DB too), only while the window is
// open (server clock). The room gets a live 'vote' event with the new tally.
// ---------------------------------------------------------------------------
router.post('/:code/vote', ah(async (req, res) => {
  const room = await roomByCode(req.params.code);
  if (!room) throw new HttpError(404, 'Room not found.');
  const votedFor = String((req.body || {}).user_id || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(votedFor)) throw new HttpError(400, 'Pick an artist to vote for.');
  // v64 — lane ballots: a 3v3 battle is three lanes and a voter may vote
  // once per lane. 1v1 voters omit the lane (defaults to 1, the only one).
  const rawLane = Number((req.body || {}).lane);
  const lane = Number.isInteger(rawLane) && rawLane >= 1 && rawLane <= 3 ? rawLane : 1;
  const isTeam = room.battle_mode === '3v3';
  if (!isTeam && Number.isInteger(rawLane) && rawLane > 1)
    throw new HttpError(400, 'This battle has a single lane.');
  const client = await pool.connect();
  let battleId = null;
  try {
    await client.query('BEGIN');
    const { rows: br } = await client.query(
      `SELECT id, status, result_method, voting_ends_at FROM battles
        WHERE room_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [room.id]);
    const b = br[0];
    if (!b || b.result_method !== 'voting_community') throw new HttpError(409, 'This battle has no community vote.');
    if (b.status !== 'judging' || !b.voting_ends_at) throw new HttpError(409, b.status === 'complete' ? 'Voting has closed — the result is in.' : 'Voting has not opened yet.');
    if (new Date(b.voting_ends_at).getTime() <= Date.now()) throw new HttpError(409, 'Voting has closed — counting the votes now.');
    battleId = b.id;
    const { rows: parts } = await client.query(
      `SELECT user_id, seat FROM battle_participants WHERE battle_id = $1`, [b.id]);
    if (parts.some((p) => p.user_id === req.user.id)) throw new HttpError(403, 'Artists cannot vote in their own battle.');
    // v64: in a 3v3 battle each lane is a fixed pairing — seat N (Team A)
    // vs seat N+3 (Team B) — so the vote target must be THAT lane's artist.
    const inLane = isTeam
      ? parts.some((p) => p.user_id === votedFor && (p.seat === lane || p.seat === lane + 3))
      : parts.some((p) => p.user_id === votedFor);
    if (!inLane) throw new HttpError(400, isTeam
      ? 'That artist is not in lane ' + lane + ' of this battle.'
      : 'That artist is not in this battle.');
    try {
      await client.query(
        `INSERT INTO battle_votes (battle_id, voter_id, voted_for, lane) VALUES ($1, $2, $3, $4)`,
        [b.id, req.user.id, votedFor, lane]);
    } catch (e) {
      if (e.code === '23505') throw new HttpError(409, isTeam
        ? 'You have already voted in lane ' + lane + ' of this battle.'
        : 'You have already voted in this battle.');
      throw e;
    }
    await client.query(
      `INSERT INTO battle_event_log (battle_id, event_type, actor_id, payload)
       VALUES ($1, 'vote_cast', $2, $3)`, [b.id, req.user.id, JSON.stringify({ voted_for: votedFor, lane })]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  const vs = await voteState(battleId, null);
  rt.emitRoom(room.code, { action: 'vote', total: vs.total, tally: vs.options.map((o) => ({ user_id: o.user_id, votes: o.votes })) });
  res.json(await roomPayload(room.code, req.user.id));
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
    challengeSummary = await startBattleInTx(client, room, players, req.user.id, { reveal: true }); // v53: reveal → launch
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
    `SELECT id, status, start_time FROM battles WHERE room_id = $1 ORDER BY created_at DESC LIMIT 1`, [roomId]
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
  // v63c: tournament rooms have NO rematches — the bracket decides every
  // later match; a draw replays the same pairing automatically at /start.
  if (room.battle_mode === 'tournament')
    throw new HttpError(409, 'Tournament matches are set by the bracket — no rematch requests.');
  // v64: 3v3 team battles are single matches (six artists, no two-person
  // rematch flow) — running it back means opening a new room.
  if (room.battle_mode === '3v3')
    throw new HttpError(409, '3v3 team battles are single matches — open a new room to run it back.');
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
  // v52: the request ALSO lands in the opponent's notification system (the
  // ONE architecture — persisted, 24 h TTL, WS push, bell + unread badge,
  // Accept/Decline straight from the panel).
  try {
    await notifyUser(opponent.user_id, 'rematch_request', {
      room_code: room.code,
      from_user_id: req.user.id,
      from_username: req.user.username,
      from_display_name: req.user.display_name || req.user.username,
    });
  } catch (e) { console.error('[rematch-notify]', e.message); }
  res.json(await roomPayload(req.params.code, req.user.id)); // v44: room payload (client re-renders)
}));

router.post('/:code/rematch/accept', ah(async (req, res) => {
  const room = await roomByCode(req.params.code);
  if (!room) throw new HttpError(404, 'Room not found.');
  // v64: 3v3 team battles have no rematch flow (single-match rooms).
  if (room.battle_mode === '3v3')
    throw new HttpError(409, '3v3 team battles are single matches — open a new room to run it back.');

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
    summary = await startBattleInTx(client, { ...room, status: 'lobby' }, players, null, { reveal: true }); // v53: reveal → launch
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
  // v52: the rematch notification updates in place (buttons → outcome) —
    // it stays listed (persistence) but can never be acted on twice.
    try {
      await pool.query(
        `UPDATE notifications
            SET payload = payload || jsonb_build_object('handled', 'accepted'::text),
                read_at = COALESCE(read_at, now())
          WHERE user_id = $1 AND type = 'rematch_request'
            AND payload->>'room_code' = $2 AND payload->>'handled' IS NULL`,
        [req.user.id, room.code]);
    } catch (_) {}
    res.json(await roomPayload(req.params.code, req.user.id));
}));

router.post('/:code/rematch/decline', ah(async (req, res) => {
  const room = await roomByCode(req.params.code);
  if (!room) throw new HttpError(404, 'Room not found.');
  // v64: 3v3 team battles have no rematch flow (single-match rooms).
  if (room.battle_mode === '3v3')
    throw new HttpError(409, '3v3 team battles are single matches — open a new room to run it back.');

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
  // v52: decline also resolves the notification in place.
    try {
      await pool.query(
        `UPDATE notifications
            SET payload = payload || jsonb_build_object('handled', 'declined'::text),
                read_at = COALESCE(read_at, now())
          WHERE user_id = $1 AND type = 'rematch_request'
            AND payload->>'room_code' = $2 AND payload->>'handled' IS NULL`,
        [req.user.id, room.code]);
    } catch (_) {}
    res.json(await roomPayload(req.params.code, req.user.id));
}));

router.post('/:code/rematch/cancel', ah(async (req, res) => {
  const room = await roomByCode(req.params.code);
  if (!room) throw new HttpError(404, 'Room not found.');
  // v64: 3v3 team battles have no rematch flow (single-match rooms).
  if (room.battle_mode === '3v3')
    throw new HttpError(409, '3v3 team battles are single matches — open a new room to run it back.');

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
// v58: PUBLIC 1v1 · 1 h · Community Votes · default Randomizer, auto_start:
// the battle begins on its own once both artists
// have picked their canvas. `client` lets the caller join the room insert
// to the queue transaction (atomic match).
// ---------------------------------------------------------------------------
async function createMatchRoom(userA, userB, client) {
  const q = client || pool;
  let roomId;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const { rows } = await q.query(
        // v58: the FIXED default battle — 1v1 · PUBLIC · Community Votes ·
        // 1 hour · Randomizer on (Character / Environment / Object / Style).
        // Not editable: PATCH refuses auto_start rooms (see below).
        `INSERT INTO battle_rooms (code, host_id, name, room_type, visibility, max_players,
                                   time_limit_seconds, result_method, battle_mode, auto_start,
                                   randomizer_config)
         VALUES ($1, $2, NULL, 'casual', 'public', 2, 3600, 'voting_community', '1v1', true,
                 '{"categories":["character","environment","object","style"]}'::jsonb)
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

module.exports = { router, canViewRoom, roomByCode, roomPayload, battleChallengePayload, createMatchRoom, createRoomForUser, startCountdownSweeper, startRematchSweeper, activeRoomOf, pickSeatForJoin, newRoomCode };
