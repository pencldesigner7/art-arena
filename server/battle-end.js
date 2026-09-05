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

const VOTING_WINDOW_S = 120; // v58: the 2-minute Community Voting phase

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
      `SELECT b.id, b.status, b.voting_ends_at, b.result_method, b.room_id, r.code
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
    const { rows: tallyRows } = await client.query(
      `SELECT bp.user_id, count(v.id)::int AS votes
         FROM battle_participants bp
         LEFT JOIN battle_votes v ON v.battle_id = bp.battle_id AND v.voted_for = bp.user_id
        WHERE bp.battle_id = $1
        GROUP BY bp.user_id
        ORDER BY votes DESC`, [b.id]
    );
    const tally = {};
    for (const t of tallyRows) tally[t.user_id] = t.votes;
    let winnerId = null;
    if (tallyRows.length && tallyRows[0].votes > 0 &&
        (tallyRows.length === 1 || tallyRows[0].votes > tallyRows[1].votes)) {
      winnerId = tallyRows[0].user_id;
    }
    const total = tallyRows.reduce((n, t) => n + t.votes, 0);
    await client.query(
      `INSERT INTO battle_event_log (battle_id, event_type, actor_id, payload)
       VALUES ($1, 'voting_closed', NULL, $2)`,
      [b.id, JSON.stringify({ tally, total_votes: total, winner_id: winnerId })]
    );
    const done = await decideInTx(client, b, { winnerId, scores: { votes: tally, total_votes: total }, reason: winnerId ? 'most_votes' : (total ? 'tie' : 'no_votes') });
    await client.query('COMMIT');
    return { code: b.code, battleId: b.id, phase: 'complete', tally, total_votes: total, ...done };
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
async function decideInTx(client, b, { winnerId, scores, reason }) {
  await client.query(`UPDATE battles SET status = 'result' WHERE id = $1`, [b.id]);
  const { rows: parts } = await client.query(
    `SELECT user_id FROM battle_participants WHERE battle_id = $1`, [b.id]
  );
  await client.query(
    `INSERT INTO battle_results (battle_id, method, winner_id, scores)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [b.id, b.result_method || 'voting_community', winnerId, JSON.stringify(scores || {})]
  );
  const outcomes = {};
  for (const p of parts) {
    const outcome = winnerId ? (p.user_id === winnerId ? 'win' : 'loss') : 'draw';
    outcomes[p.user_id] = outcome;
    await client.query(
      `UPDATE battle_participants SET outcome = $2, final_position = $4 WHERE battle_id = $1 AND user_id = $3`,
      [b.id, outcome, p.user_id, winnerId ? (outcome === 'win' ? 1 : 2) : null]
    );
    await bumpStats(client, p.user_id, outcome); // same transaction = exactly once
  }
  await client.query(`UPDATE battles SET status = 'complete' WHERE id = $1`, [b.id]);
  await client.query(
    `INSERT INTO battle_event_log (battle_id, event_type, actor_id, payload)
     VALUES ($1, 'battle_completed', NULL, $2)`,
    [b.id, JSON.stringify({ winner_id: winnerId, reason, outcomes })]
  );
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
async function voteState(battleId, me) {
  const { rows } = await pool.query(
    `SELECT bp.user_id, u.username, u.display_name, bp.seat, count(v.id)::int AS votes
       FROM battle_participants bp
       JOIN users u ON u.id = bp.user_id
       LEFT JOIN battle_votes v ON v.battle_id = bp.battle_id AND v.voted_for = bp.user_id
      WHERE bp.battle_id = $1
      GROUP BY bp.user_id, u.username, u.display_name, bp.seat
      ORDER BY bp.seat`, [battleId]
  );
  let mine = null;
  if (me) {
    const { rows: mv } = await pool.query(
      `SELECT voted_for FROM battle_votes WHERE battle_id = $1 AND voter_id = $2`, [battleId, me]);
    mine = mv[0] ? mv[0].voted_for : null;
  }
  return {
    total: rows.reduce((n, r) => n + r.votes, 0),
    options: rows.map((r) => ({ user_id: r.user_id, username: r.username, display_name: r.display_name, seat: r.seat, votes: r.votes })),
    my_vote: mine,
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
    rt.emitRoom(r.code, { action: 'battle_ended', battle_id: r.battleId, outcome: r.outcome, winner_id: r.winner_id || null });
    rt.broadcastRoomsList('closed'); // the room left the live lists
  }
}

module.exports = { finishBattleIfDue, decideBattleIfDue, voteState, announce, startBattleEndSweeper, VOTING_WINDOW_S };
