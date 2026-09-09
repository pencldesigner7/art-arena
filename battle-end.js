'use strict';
/**
 * ============================================================================
 *  ART ARENA™ — v44 · BATTLE COMPLETION CORE (battle-end.js)
 * ============================================================================
 *  The end of the chain the state machine has been waiting for:
 *
 *      active ──clock reaches official_end_time──▶ time_expired ▶ submitting
 *              ▶ submission_locked ▶ judging ▶ result ▶ complete
 *
 *  Every edge above is already legal in `battle_state_transitions` — this
 *  module WALKS the machine, it never bypasses it (the DB trigger stays the
 *  authority; an illegal jump would raise exactly like anywhere else).
 *
 *  v58: COMMUNITY VOTING is live. Clock-out no longer walks straight to a
 *  draw: voting_community battles park in 'judging' for a 2-minute window
 *  (battles.voting_ends_at); real rows in battle_votes decide the winner.
 *
 *  What happened at 'result' before v58 (kept for history):
 *    - The submission/voting engine is the NEXT build phase — no submissions
 *      or votes exist yet, so a battle that runs out of clock completes as a
 *      DRAW: battle_results gets its (single) row with winner_id NULL,
 *      every battle_participant row gets outcome 'draw'.
 *    - user_statistics is bumped ATOMICALLY IN THE SAME TRANSACTION as the
 *      'result → complete' transition itself: because that transition can
 *      happen exactly once (FOR UPDATE + status re-check), a refresh or a
 *      re-visited page can NEVER increment stats twice.
 *    - The room flips to 'ended' and every seated participant is RELEASED
 *      (state 'left') — the v43 semantics — so nobody is trapped and the
 *      one-active-seat guard frees them to join/matchmake again.
 *    - When submissions/voting land, this core is the seam: 'time_expired'
 *      will open the upload window instead of walking straight through, and
 *      the result branch will read votes instead of defaulting to a draw.
 *
 *  Sweeper: 1 s interval, same pattern as the v36 countdown sweeper; the
 *  room read-path ALSO self-heals (rooms.roomPayload calls finishBattleIfDue)
 *  so a late poller can never see a stale 'active' battle either.
 * ============================================================================
 */
const { pool, DEV } = require('./lib');
const rt = require('./realtime');

// How each participant outcome moves user_statistics. Deliberate rules:
//   win/loss/draw — Battles +1 and the matching counter +1; a WIN also
//   extends the win streak (and best streak), any non-win resets it;
//   forfeit counts as a loss (Battles +1, Losses +1);
//   disqualified/eliminated/not_started and cancelled battles never reach
//   this core at all (no stats) — "only a final, valid result counts".
async function bumpStats(client, userId, outcome) {
  const sql = {
    win: `UPDATE user_statistics
             SET battles = battles + 1, wins = wins + 1,
                 win_streak = win_streak + 1,
                 best_streak = GREATEST(best_streak, win_streak + 1),
                 last_battle_at = now()
           WHERE user_id = $1`,
    loss: `UPDATE user_statistics
              SET battles = battles + 1, losses = losses + 1,
                  win_streak = 0, last_battle_at = now()
            WHERE user_id = $1`,
    draw: `UPDATE user_statistics
              SET battles = battles + 1, draws = draws + 1,
                  win_streak = 0, last_battle_at = now()
            WHERE user_id = $1`,
    forfeit: `UPDATE user_statistics
                 SET battles = battles + 1, losses = losses + 1,
                     win_streak = 0, last_battle_at = now()
               WHERE user_id = $1`,
  }[outcome];
  if (sql) await client.query(sql, [userId]);
}

const VOTING_WINDOW_S = Number(process.env.VOTING_WINDOW_S || 120); // v58: 2-minute Community Voting window (env-overridable test seam; default unchanged)

/**
 * v58 — PHASE 1: the clock ran out. The battle leaves 'active' and, when its
 * result method is community voting, PARKS in 'judging' with a 2-minute
 * voting_ends_at. Nothing is decided here; the room stays 'in_battle' and
 * every seat stays occupied until the result lands (phase 2), so the artists
 * cannot start another battle while their own is being judged.
 * Battles with any other result method still complete immediately (draw —
 * the honest outcome when nothing decides them), exactly as before.
 * Idempotent + race-safe (FOR UPDATE + status re-check).
 * Returns { code, battleId, phase:'voting', voting_ends_at } |
 *         { code, battleId, phase:'complete', outcome } | null.
 */
async function finishBattleIfDue(battleId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: br } = await client.query(
      `SELECT b.id, b.status, b.official_end_time, b.result_method, b.room_id, r.code
         FROM battles b JOIN battle_rooms r ON r.id = b.room_id
        WHERE b.id = $1 FOR UPDATE OF b`,
      [battleId]
    );
    const b = br[0];
    if (!b || b.status !== 'active' || !b.official_end_time ||
        new Date(b.official_end_time).getTime() > Date.now()) {
      await client.query('COMMIT');
      return null;
    }

    // Walk the machine — every hop is a seeded legal edge.
    for (const status of ['time_expired', 'submitting', 'submission_locked', 'judging']) {
      await client.query(`UPDATE battles SET status = $2 WHERE id = $1`, [b.id, status]);
    }
    await client.query(
      `INSERT INTO battle_event_log (battle_id, event_type, actor_id, payload)
       VALUES ($1, 'battle_time_expired', NULL, '{}')`, [b.id]
    );

    if (b.result_method === 'voting_community') {
      // Open the Community Voting window. The battle rests in 'judging'
      // until voting_ends_at; decideBattleIfDue() finishes it.
      const { rows: vr } = await client.query(
        `UPDATE battles SET voting_ends_at = now() + make_interval(secs => $2)
          WHERE id = $1 RETURNING voting_ends_at`, [b.id, VOTING_WINDOW_S]
      );
      await client.query(
        `INSERT INTO battle_event_log (battle_id, event_type, actor_id, payload)
         VALUES ($1, 'voting_opened', NULL, $2)`,
        [b.id, JSON.stringify({ voting_ends_at: vr[0].voting_ends_at, window_seconds: VOTING_WINDOW_S })]
      );
      await client.query('COMMIT');
      return { code: b.code, battleId: b.id, phase: 'voting', voting_ends_at: vr[0].voting_ends_at };
    }

    // No deciding mechanism → the honest outcome is a draw for everyone.
    const done = await decideInTx(client, b, { winnerId: null, scores: {}, reason: 'no_result_method' });
    await client.query('COMMIT');
    return { code: b.code, battleId: b.id, phase: 'complete', ...done };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * v58 — PHASE 2 (community voting): the voting window closed. Count the
 * REAL rows in battle_votes, declare the most-voted artist the winner (a
 * tie — including zero votes — is a draw), persist the result, bump stats,
 * end the room and release the seats. Idempotent + race-safe.
 * Returns { code, battleId, phase:'complete', outcome, winner_id, tally } | null.
 */
async function decideBattleIfDue(battleId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: br } = await client.query(
      `SELECT b.id, b.status, b.voting_ends_at, b.result_method, b.room_id,
              r.code, r.battle_mode
         FROM battles b JOIN battle_rooms r ON r.id = b.room_id
        WHERE b.id = $1 FOR UPDATE OF b`,
      [battleId]
    );
    const b = br[0];
    if (!b || b.status !== 'judging' || !b.voting_ends_at ||
        new Date(b.voting_ends_at).getTime() > Date.now()) {
      await client.query('COMMIT');
      return null;
    }
    const team = b.battle_mode === '3v3';
    const { rows: tallyRows } = await client.query(
      `SELECT bp.user_id, bp.seat, count(v.id)::int AS votes
         FROM battle_participants bp
         LEFT JOIN battle_votes v
           ON v.battle_id = bp.battle_id AND v.voted_for = bp.user_id
          AND v.lane = CASE WHEN $2::boolean AND bp.seat <= 3 THEN bp.seat
                            WHEN $2::boolean THEN bp.seat - 3
                            ELSE 1 END
        WHERE bp.battle_id = $1
        GROUP BY bp.user_id, bp.seat
        ORDER BY votes DESC, bp.seat`, [b.id, team]
    );
    const tally = {};
    const bySeat = {};
    for (const t of tallyRows) { tally[t.user_id] = t.votes; bySeat[t.seat] = t; }
    const total = tallyRows.reduce((n, t) => n + t.votes, 0);
    let winnerId = null;
    let teamWinner = null;
    let lanesOut = null;
    let scores;
    let reason;
    if (team) {
      // v64 — TEAM LANE VERDICT: each lane is won by the artist with more
      // votes (equal votes = lane draw); the team winning more lanes takes
      // the battle. Tied lane counts (or zero votes anywhere) = a draw for
      // both teams — the same honesty rule as 1v1, replay via a new room.
      const laneWins = { A: 0, B: 0 };
      lanesOut = [];
      for (let lane = 1; lane <= 3; lane++) {
        const a = bySeat[lane], b = bySeat[lane + 3];
        const av = a ? a.votes : 0, bv = b ? b.votes : 0;
        const side = av > bv ? 'A' : bv > av ? 'B' : null;
        if (side === 'A') laneWins.A++;
        else if (side === 'B') laneWins.B++;
        lanesOut.push({
          lane,
          a: { user_id: a ? a.user_id : null, votes: av },
          b: { user_id: b ? b.user_id : null, votes: bv },
          winner: side, // which TEAM won the lane ('A' | 'B' | null)
        });
      }
      teamWinner = laneWins.A > laneWins.B ? 'A' : laneWins.B > laneWins.A ? 'B' : null;
      scores = {
        lanes: lanesOut,
        teams: { A: { votes: lanesOut.reduce((n, l) => n + l.a.votes, 0), lanes_won: laneWins.A },
                 B: { votes: lanesOut.reduce((n, l) => n + l.b.votes, 0), lanes_won: laneWins.B } },
        team_winner: teamWinner,
        total_votes: total,
      };
      reason = teamWinner ? ('team_' + teamWinner + '_lanes') : (total ? 'lanes_tied' : 'no_votes');
    } else {
      // 1v1 (incl. bracket matches): the most-voted artist wins; a tie —
      // including zero votes — is a draw (unchanged).
      if (tallyRows.length && tallyRows[0].votes > 0 &&
          (tallyRows.length === 1 || tallyRows[0].votes > tallyRows[1].votes)) {
        winnerId = tallyRows[0].user_id;
      }
      scores = { votes: tally, total_votes: total };
      reason = winnerId ? 'most_votes' : (total ? 'tie' : 'no_votes');
    }
    await client.query(
      `INSERT INTO battle_event_log (battle_id, event_type, actor_id, payload)
       VALUES ($1, 'voting_closed', NULL, $2)`,
      [b.id, JSON.stringify({ tally, total_votes: total, winner_id: winnerId, team_winner: teamWinner, lanes: lanesOut })]
    );
    const done = await decideInTx(client, b, { winnerId, teamWinner, team, scores, reason });
    await client.query('COMMIT');
    return {
      code: b.code, battleId: b.id, phase: 'complete', tally, total_votes: total,
      team_winner: teamWinner, lanes: lanesOut, winner_id: winnerId, ...done,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// The shared result core: judging → result → complete, ONE battle_results
// row, per-participant outcomes, stats bumped exactly once, room ended and
// seats released — all in the caller's transaction.
// v64: TEAM verdicts — when a 3v3 lane battle is decided, `team` is true and
// teamWinner ('A'|'B'|null) is the side that took more lanes. Every member
// of the winning team gets a win, every member of the other a loss, and a
// tied (or un-voted) battle draws ALL six — battle_results.winner_id stays
// NULL and the verdict + lane tallies live in scores (jsonb).
async function decideInTx(client, b, { winnerId, scores, reason, team, teamWinner }) {
  await client.query(`UPDATE battles SET status = 'result' WHERE id = $1`, [b.id]);
  const { rows: parts } = await client.query(
    `SELECT user_id, seat FROM battle_participants WHERE battle_id = $1`, [b.id]
  );
  const resultWinner = team ? null : winnerId;
  await client.query(
    `INSERT INTO battle_results (battle_id, method, winner_id, scores)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [b.id, b.result_method || 'voting_community', resultWinner, JSON.stringify(scores || {})]
  );
  const outcomes = {};
  for (const p of parts) {
    let outcome;
    if (team) {
      if (!teamWinner) outcome = 'draw';
      else {
        const onTeamA = p.seat <= 3; // seats 1-3 = Team A, 4-6 = Team B
        outcome = (onTeamA === (teamWinner === 'A')) ? 'win' : 'loss';
      }
    } else {
      outcome = winnerId ? (p.user_id === winnerId ? 'win' : 'loss') : 'draw';
    }
    outcomes[p.user_id] = outcome;
    const pos = outcome === 'win' ? 1 : outcome === 'loss' ? 2 : null;
    await client.query(
      `UPDATE battle_participants SET outcome = $2, final_position = $4 WHERE battle_id = $1 AND user_id = $3`,
      [b.id, outcome, p.user_id, pos]
    );
    await bumpStats(client, p.user_id, outcome); // same transaction = exactly once
  }
  await client.query(`UPDATE battles SET status = 'complete' WHERE id = $1`, [b.id]);
  await client.query(
    `INSERT INTO battle_event_log (battle_id, event_type, actor_id, payload)
     VALUES ($1, 'battle_completed', NULL, $2)`,
    [b.id, JSON.stringify({ winner_id: winnerId, reason, outcomes })]
  );
  // v63c — TOURNAMENT rooms: a match result does NOT end the room. The
  // bracket advances the winner and the room returns to 'lobby' for the
  // host to start the next match — seats stay seated (no release). A draw
  // (winnerId null) leaves the same pairing open for a replay. Only the
  // FINAL (champion decided) ends the room and releases everyone.
  let tournament = null;
  const { rows: roomRows } = await client.query(
    `SELECT id, code, battle_mode, bracket FROM battle_rooms WHERE id = $1 FOR UPDATE`,
    [b.room_id]
  );
  const room = roomRows[0];
  if (room && room.battle_mode === 'tournament') {
    const bracket = room.bracket || null;
    if (bracket) {
      const ids = parts.map((p) => p.user_id);
      const bracketApi = require('./bracket');
      const match = bracketApi.matchForParticipants(bracket, ids);
      if (match) {
        const adv = bracketApi.applyResult(bracket, winnerId);
        tournament = { phase: winnerId ? (adv.state === 'champion' ? 'champion' : 'next') : 'draw' };
        if (adv.state === 'champion') tournament.champion_id = adv.id;
        await client.query(
          `UPDATE battle_rooms SET bracket = $2::jsonb,
                  status = $3::room_status,
                  ended_at = CASE WHEN $3::room_status = 'ended' THEN now() ELSE ended_at END
            WHERE id = $1`,
          [b.room_id, JSON.stringify(bracket), adv.state === 'champion' ? 'ended' : 'lobby']
        );
        if (adv.state === 'champion') {
          await client.query(
            `UPDATE room_participants SET state = 'left', left_at = now()
              WHERE room_id = $1 AND state IN ('waiting','ready')`, [b.room_id]
          );
        }
      } else {
        // This battle's pairing is no longer open in the bracket (e.g. a
        // forfeit already decided it) — do not touch the bracket; put the
        // room back to lobby so play continues normally.
        tournament = { phase: 'none' };
        await client.query(
          `UPDATE battle_rooms SET status = 'lobby', ended_at = NULL WHERE id = $1`, [b.room_id]
        );
      }
    } else {
      // No bracket (legacy/edge) — end the room exactly like a normal room.
      tournament = { phase: 'ended' };
      await client.query(
        `UPDATE battle_rooms SET status = 'ended', ended_at = now() WHERE id = $1 AND status <> 'ended'`,
        [b.room_id]
      );
      await client.query(
        `UPDATE room_participants SET state = 'left', left_at = now()
          WHERE room_id = $1 AND state IN ('waiting','ready')`, [b.room_id]
      );
    }
    return { outcome: winnerId ? 'decided' : 'draw', winner_id: winnerId, outcomes, tournament };
  }
  // The room is over: end it and RELEASE every seated player (v43
  // semantics) so the one-active-seat guard frees them immediately.
  await client.query(
    `UPDATE battle_rooms SET status = 'ended', ended_at = now() WHERE id = $1 AND status <> 'ended'`,
    [b.room_id]
  );
  await client.query(
    `UPDATE room_participants SET state = 'left', left_at = now()
      WHERE room_id = $1 AND state IN ('waiting','ready')`, [b.room_id]
  );
  return { outcome: winnerId ? 'decided' : 'draw', winner_id: winnerId, outcomes };
}

// v58: the live tally for a battle (during voting AND after — the result
// panel shows the final count). Also whether `me` has voted, and for whom.
// v64: 3v3 battles count votes PER LANE — every artist belongs to exactly
// one lane (seat N is Team A's lane-N artist, seat N+3 Team B's) and a
// voter may cast one ballot per lane. 1v1 stays a single lane (all votes
// land on lane 1), so `options` keeps its historical meaning there.
async function voteState(battleId, me) {
  const { rows } = await pool.query(
    `SELECT bp.user_id, u.username, u.display_name, bp.seat,
            count(v.id)::int AS votes
       FROM battle_participants bp
       JOIN users u ON u.id = bp.user_id
       JOIN battles b ON b.id = bp.battle_id
       JOIN battle_rooms r ON r.id = b.room_id
       LEFT JOIN battle_votes v
         ON v.battle_id = bp.battle_id AND v.voted_for = bp.user_id
        AND v.lane = CASE WHEN r.battle_mode = '3v3' AND bp.seat <= 3 THEN bp.seat
                          WHEN r.battle_mode = '3v3' THEN bp.seat - 3
                          ELSE 1 END
      WHERE bp.battle_id = $1
      GROUP BY bp.user_id, u.username, u.display_name, bp.seat
      ORDER BY bp.seat`, [battleId]
  );
  const { rows: mr } = await pool.query(
    `SELECT r.battle_mode FROM battles b JOIN battle_rooms r ON r.id = b.room_id
      WHERE b.id = $1`, [battleId]
  );
  const team = !!(mr[0] && mr[0].battle_mode === '3v3');
  let mine = null;
  const myVotes = {};
  if (me) {
    const { rows: mv } = await pool.query(
      `SELECT voted_for, lane FROM battle_votes WHERE battle_id = $1 AND voter_id = $2`,
      [battleId, me]);
    for (const m of mv) { myVotes[m.lane] = m.voted_for; }
    mine = mv[0] ? mv[0].voted_for : null;
  }
  const bySeat = {};
  for (const r of rows) bySeat[r.seat] = r;
  const fmt = (r) => (r ? { user_id: r.user_id, username: r.username, display_name: r.display_name, seat: r.seat, votes: r.votes } : null);
  let lanes = [];
  if (team) {
    for (let lane = 1; lane <= 3; lane++) {
      const a = bySeat[lane], b = bySeat[lane + 3];
      if (a && b) lanes.push({ lane, a: fmt(a), b: fmt(b) });
    }
  } else if (rows.length) {
    lanes = [{ lane: 1, a: fmt(rows[0]), b: fmt(rows[1] || null) }];
  }
  return {
    total: rows.reduce((n, r) => n + r.votes, 0),
    options: rows.map((r) => ({ user_id: r.user_id, username: r.username, display_name: r.display_name, seat: r.seat, votes: r.votes })),
    my_vote: mine,
    my_votes: myVotes,   // v64: { lane: voted_for_user_id }
    lanes,               // v64: lane pairings with live vote counts
    team,
  };
}

// ---------------------------------------------------------------------------
// The sweeper — 1 s tick. Two duties now: (1) battles whose clock ran out →
// open voting (or complete); (2) battles whose voting window closed → count
// the votes and declare the result. Each through its idempotent core.
// ---------------------------------------------------------------------------
let sweeperTimer = null;
function startBattleEndSweeper() {
  if (sweeperTimer) return sweeperTimer;
  sweeperTimer = setInterval(async () => {
    try {
      const { rows } = await pool.query(
        `SELECT id FROM battles
          WHERE status = 'active' AND official_end_time IS NOT NULL
            AND official_end_time <= now()`
      );
      for (const b of rows) {
        const r = await finishBattleIfDue(b.id);
        if (r) announce(r);
      }
      const { rows: due } = await pool.query(
        `SELECT id FROM battles
          WHERE status = 'judging' AND voting_ends_at IS NOT NULL
            AND voting_ends_at <= now()`
      );
      for (const b of due) {
        const r = await decideBattleIfDue(b.id);
        if (r) announce(r);
      }
    } catch (e) { console.error('[battle-end sweeper]', e.message); }
  }, 1000);
  if (sweeperTimer.unref) sweeperTimer.unref();
  return sweeperTimer;
}

// One place that tells the room what just happened (the read-path
// self-heals in rooms.js call this too).
function announce(r) {
  if (!r) return;
  if (r.phase === 'voting') {
    rt.emitRoom(r.code, { action: 'voting_opened', battle_id: r.battleId, voting_ends_at: r.voting_ends_at });
    rt.broadcastRoomsList('voting');
  } else {
    rt.emitRoom(r.code, {
      action: 'battle_ended',
      battle_id: r.battleId,
      outcome: r.outcome,
      winner_id: r.winner_id || null,
      tournament: r.tournament || null, // v63c
    });
    // v63c: a mid-tournament match keeps the room ALIVE (back to lobby for
    // the next match) — only a finished room leaves the live lists.
    const stillLive = r.tournament && r.tournament.phase !== 'champion' && r.tournament.phase !== 'ended';
    rt.broadcastRoomsList(stillLive ? 'created' : 'closed');
  }
}

module.exports = { finishBattleIfDue, decideBattleIfDue, voteState, announce, startBattleEndSweeper, VOTING_WINDOW_S };
