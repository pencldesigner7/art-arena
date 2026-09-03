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
 *  What happens at 'result' (today, honestly):
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

/**
 * Complete one battle whose clock has run out. Idempotent + race-safe:
 * the battle row is locked and its status re-checked, so overlapping
 * sweeper ticks and read-path self-heals are no-ops.
 * Returns { code, battleId, outcome } when it completed, null otherwise.
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

    // Walk the machine to 'complete' — every hop is a seeded legal edge.
    for (const status of ['time_expired', 'submitting', 'submission_locked', 'judging', 'result']) {
      await client.query(`UPDATE battles SET status = $2 WHERE id = $1`, [b.id, status]);
    }
    await client.query(
      `INSERT INTO battle_event_log (battle_id, event_type, actor_id, payload)
       VALUES ($1, 'battle_time_expired', NULL, '{}')`, [b.id]
    );

    // The result. No submissions/votes exist yet → the honest outcome is a
    // draw for every participant (winner_id NULL = no winner).
    const { rows: parts } = await client.query(
      `SELECT user_id FROM battle_participants WHERE battle_id = $1`, [b.id]
    );
    await client.query(
      `INSERT INTO battle_results (battle_id, method, winner_id, scores)
       VALUES ($1, $2, NULL, '{}'::jsonb)`,
      [b.id, b.result_method || 'voting_community']
    );
    const outcome = 'draw';
    for (const p of parts) {
      await client.query(
        `UPDATE battle_participants SET outcome = $2, final_position = NULL WHERE battle_id = $1 AND user_id = $3`,
        [b.id, outcome, p.user_id]
      );
      await bumpStats(client, p.user_id, outcome); // same transaction = exactly once
    }
    await client.query(`UPDATE battles SET status = 'complete' WHERE id = $1`, [b.id]);
    await client.query(
      `INSERT INTO battle_event_log (battle_id, event_type, actor_id, payload)
       VALUES ($1, 'battle_completed', NULL, $2)`,
      [b.id, JSON.stringify({ outcome, participants: parts.map((p) => p.user_id) })]
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

    await client.query('COMMIT');
    return { code: b.code, battleId: b.id, outcome };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// The sweeper — the missing twin of the v36 countdown sweeper. Runs every
// second; each due battle is completed through the idempotent core above.
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
        if (r) {
          rt.emitRoom(r.code, { action: 'battle_ended', battle_id: r.battleId, outcome: r.outcome });
          rt.broadcastRoomsList('closed'); // the room left the live lists
        }
      }
    } catch (e) { console.error('[battle-end sweeper]', e.message); }
  }, 1000);
  if (sweeperTimer.unref) sweeperTimer.unref();
  return sweeperTimer;
}

module.exports = { finishBattleIfDue, startBattleEndSweeper };
