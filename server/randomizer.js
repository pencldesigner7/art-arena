'use strict';
/**
 * ============================================================================
 *  ART ARENA™ — PHASE 6 · RANDOMIZER
 * ============================================================================
 *  The signature challenge system:
 *
 *    1. HOST CHOOSES the categories (elements) the randomizer may use —
 *       stored in battle_rooms.randomizer_config while in the lobby.
 *    2. The battle is started (Phase 4 seam: battles row in 'waiting').
 *    3. The host locks the challenge: the SERVER walks the canonical state
 *       machine (waiting → ready → locked → randomizing → challenge_locked),
 *       picks one random ACTIVE element per chosen category, and writes the
 *       OFFICIAL, LOCKED challenge (battle_challenges +
 *       battle_challenge_elements) — identical for every participant.
 *    4. Every step is audit-logged (battle_event_log, append-only) and the
 *       result is broadcast to the room in real time (Phase 5 hub).
 *
 *  The word pool (10,000+ elements) lives in `randomizer_elements`, seeded
 *  at startup from randomizer_seed.json (see seed.js).
 * ============================================================================
 */
const express = require('express');
const { pool, HttpError, ah, requireAuth } = require('./lib');
const rt = require('./realtime');
const { roomByCode, roomPayload, canViewRoom, battleChallengePayload } = require('./rooms');
const { lockChallengeCore } = require('./challenge'); // v35: single challenge core

const router = express.Router();
router.use(requireAuth);

// Spec difficulty bands by number of active elements:
// Easy (2-3) · Normal (4-5) · Hard (6+) · Arena (8)
const difficultyFor = (n) => (n <= 3 ? 'easy' : n <= 5 ? 'normal' : n <= 7 ? 'hard' : 'arena');

function requireRoomHost(room, me) {
  if (!room.host_id) throw new HttpError(400, 'This room is platform-hosted.');
  if (room.host_id !== me) throw new HttpError(403, 'Only the host can do that.');
}

// ---------------------------------------------------------------------------
// CATEGORIES — what the randomizer can pick from (with live element counts)
// ---------------------------------------------------------------------------
router.get('/randomizer/categories', ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.key, c.display_name, c.icon, c.sort_order, c.is_optional,
            (SELECT count(*)::int FROM randomizer_elements e
              WHERE e.category = c.key AND e.status = 'active') AS count
       FROM randomizer_categories c
      WHERE c.is_active
      ORDER BY c.sort_order`
  );
  res.json({ categories: rows, total: rows.reduce((s, r) => s + r.count, 0) });
}));

// ---------------------------------------------------------------------------
// HOST CHOOSES — set the categories the randomizer may use (lobby only)
// ---------------------------------------------------------------------------
router.post('/rooms/:code/randomizer-config', ah(async (req, res) => {
  const room = await roomByCode(req.params.code);
  if (!room) throw new HttpError(404, 'Room not found.');
  requireRoomHost(room, req.user.id);
  if (room.status !== 'lobby')
    throw new HttpError(409, 'Challenge elements are locked once the battle starts.');
  if (room.auto_start) // v58: matchmaking battles use the fixed default categories
    throw new HttpError(409, 'Matchmaking battles use the default challenge elements (Character · Environment · Object · Style).');

  const catsIn = (req.body || {}).categories;
  if (!Array.isArray(catsIn))
    throw new HttpError(400, 'Categories must be a list.');

  const { rows: valid } = await pool.query(
    `SELECT key FROM randomizer_categories WHERE is_active`
  );
  const validKeys = new Set(valid.map((r) => r.key));
  const cats = [...new Set(catsIn)].filter((c) => validKeys.has(c));
  if (cats.length !== [...new Set(catsIn)].length)
    throw new HttpError(400, 'Unknown category selected.');
  if (cats.length === 0)
    throw new HttpError(400, 'Select at least one category.');

  const config = { categories: cats, difficulty: difficultyFor(cats.length), updated_at: new Date().toISOString() };
  await pool.query(
    'UPDATE battle_rooms SET randomizer_config = $1 WHERE id = $2',
    [JSON.stringify(config), room.id]
  );
  rt.emitRoom(room.code, { action: 'settings', username: req.user.username, what: 'challenge elements' });
  res.json(await roomPayload(room.code, req.user.id));
}));

// ---------------------------------------------------------------------------
// LOCK CHALLENGE — the server generates the OFFICIAL, LOCKED challenge
// ---------------------------------------------------------------------------
router.post('/battles/:id/lock-challenge', ah(async (req, res) => {
  const client = await pool.connect();
  let code;
  let summary;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT b.id, b.status, b.room_id, r.code, r.host_id, r.randomizer_config
         FROM battles b
         JOIN battle_rooms r ON r.id = b.room_id
        WHERE b.id = $1
        FOR UPDATE`,
      [req.params.id]
    );
    const row = rows[0];
    if (!row) throw new HttpError(404, 'Battle not found.');
    code = row.code;
    if (!row.host_id) throw new HttpError(400, 'This room is platform-hosted.');
    if (row.host_id !== req.user.id) throw new HttpError(403, 'Only the host can do that.');
    if (!['waiting', 'ready', 'locked'].includes(row.status))
      throw new HttpError(409, 'The challenge is already locked.');

    // v35: the generation itself lives in the shared core (./challenge) —
    // the same code the start flow runs when both canvases are picked.
    ({ summary } = await lockChallengeCore(client, {
      battleId: row.id,
      randomizerConfig: row.randomizer_config,
      actorId: req.user.id,
    }));
    // v53: the manual lock now REVEALS the challenge (same as /start) — the
    // host launches when ready, which arms the 3-2-1 countdown.
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  rt.emitRoom(code, {
    action: 'challenge_locked',
    by: req.user.username,
    summary,
  });
  const { rows: st } = await pool.query(
    'SELECT status, countdown_ends_at FROM battles WHERE id = $1', [req.params.id]
  );
  res.json({
    battle_status: st[0] ? st[0].status : 'challenge_locked',
    countdown_ends_at: st[0] && st[0].countdown_ends_at ? st[0].countdown_ends_at : null, // v36
    challenge: await battleChallengePayload(req.params.id),
  });
}));

// ---------------------------------------------------------------------------
// CHALLENGE — the locked result (same for everyone)
// ---------------------------------------------------------------------------
router.get('/battles/:id/challenge', ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.room_id, r.code, b.status
       FROM battles b
       JOIN battle_rooms r ON r.id = b.room_id
      WHERE b.id = $1`,
    [req.params.id]
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, 'Battle not found.');
  const access = await canViewRoom(row.code, req.user);
  if (!access.ok) throw new HttpError(403, access.reason || 'You cannot view that battle.');
  res.json({ battle_status: row.status, challenge: await battleChallengePayload(req.params.id) });
}));

module.exports = router;
