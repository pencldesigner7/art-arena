'use strict';
/**
 * ============================================================================
 *  ART ARENA™ — v35 · CHALLENGE GENERATION (shared core)
 * ============================================================================
 *  The ONE implementation of "walk the battle state machine → pick one
 *  random ACTIVE element per chosen category → write the official, locked
 *  challenge". Called by:
 *    - the host's manual Lock Challenge route (randomizer.js)
 *    - the battle start core (rooms.js) — the v35 flow generates the
 *      challenge the moment BOTH players have picked their canvas
 *  No category/element logic exists anywhere else — the 10,000+ element
 *  pool (randomizer_elements) is the only source of challenge content.
 * ============================================================================
 */
const { HttpError } = require('./lib');

const DEFAULT_CATEGORIES = ['character', 'environment', 'object', 'style'];

/**
 * Runs INSIDE the caller's transaction (no BEGIN/COMMIT here).
 *   client            — the open pg client/transaction
 *   battleId          — the (already created) battle row
 *   randomizerConfig  — battle_rooms.randomizer_config (host's category pick)
 *   actorId           — the user driving it (audit log); system = null
 * Returns { summary, picks } — the official locked challenge.
 */
async function lockChallengeCore(client, { battleId, randomizerConfig, actorId }) {
  const cfg = randomizerConfig || {};
  const cats = Array.isArray(cfg.categories) && cfg.categories.length
    ? cfg.categories
    : DEFAULT_CATEGORIES;

  const { rows: st } = await client.query(
    `SELECT status FROM battles WHERE id = $1 FOR UPDATE`, [battleId]);
  if (!st[0]) throw new HttpError(404, 'Battle not found.');
  let status = st[0].status;

  // Walk the canonical state machine (the trigger keeps it honest):
  //   waiting → ready → locked → randomizing → challenge_locked
  if (status === 'waiting') {
    await client.query(`UPDATE battles SET status = 'ready' WHERE id = $1`, [battleId]);
    status = 'ready';
  }
  if (status === 'ready') {
    await client.query(
      `UPDATE battles SET status = 'locked', settings_locked_at = now() WHERE id = $1`,
      [battleId]
    );
    status = 'locked';
  }
  if (status !== 'locked' && status !== 'randomizing')
    throw new HttpError(409, 'The challenge is already locked.');

  await client.query(`UPDATE battles SET status = 'randomizing' WHERE id = $1`, [battleId]);
  await client.query(
    `INSERT INTO battle_event_log (battle_id, event_type, actor_id, payload)
     VALUES ($1, 'randomizer_started', $2, $3)`,
    [battleId, actorId, JSON.stringify({ categories: cats })]
  );

  // One random ACTIVE element per chosen category (server picks; audit row).
  const picks = [];
  for (const cat of cats) {
    const { rows: el } = await client.query(
      `SELECT id, name FROM randomizer_elements
        WHERE category = $1 AND status = 'active'
        ORDER BY random() LIMIT 1`,
      [cat]
    );
    if (!el[0]) throw new HttpError(500, `No elements available for "${cat}" yet.`);
    picks.push({ category: cat, element_id: el[0].id, value: el[0].name });
  }

  // The OFFICIAL, LOCKED challenge — identical for every participant.
  const summary = picks.map((p) => p.value).join(' · ');
  const { rows: ch } = await client.query(
    `INSERT INTO battle_challenges (battle_id, summary_text) VALUES ($1, $2) RETURNING id`,
    [battleId, summary]
  );
  for (const p of picks) {
    await client.query(
      `INSERT INTO battle_challenge_elements (challenge_id, category, element_id, value)
       VALUES ($1, $2, $3, $4)`,
      [ch[0].id, p.category, p.element_id, p.value]
    );
  }
  await client.query(`UPDATE battles SET status = 'challenge_locked' WHERE id = $1`, [battleId]);
  await client.query(
    `INSERT INTO battle_event_log (battle_id, event_type, actor_id, payload)
     VALUES ($1, 'challenge_locked', $2, $3)`,
    [battleId, actorId, JSON.stringify({ summary, elements: picks })]
  );
  return { summary, picks };
}

module.exports = { lockChallengeCore, DEFAULT_CATEGORIES };
