'use strict';
/**
 * ============================================================================
 *  ART ARENA™ — PHASE 6 / V2 · RANDOMIZER WORD-POOL SEED
 * ============================================================================
 *  Loads server/randomizer_seed.json into `randomizer_elements`.
 *  Ensures:
 *    - exactly 30 approved 2D styles
 *    - exactly 300 base 4-colour palettes
 *    - comprehensive character, environment, object, and modifier libraries
 * ============================================================================
 */
const fs = require('fs');
const path = require('path');
const { pool, DEV } = require('./lib');

const CHUNK = 1000;

const CATEGORIES_DEF = [
  { key: 'character', display_name: 'Character', sort_order: 1 },
  { key: 'environment', display_name: 'Environment', sort_order: 2 },
  { key: 'object', display_name: 'Object', sort_order: 3 },
  { key: 'style', display_name: 'Drawing Style', sort_order: 4 },
  { key: 'color', display_name: 'Colour Palette', sort_order: 5 },
  { key: 'mood', display_name: 'Atmosphere / Mood', sort_order: 6 },
  { key: 'lighting', display_name: 'Lighting', sort_order: 7 },
  { key: 'composition', display_name: 'Composition', sort_order: 8 },
  { key: 'weather', display_name: 'Weather / Time', sort_order: 9 },
  { key: 'texture', display_name: 'Visual Finish', sort_order: 10 },
  { key: 'wildcard', display_name: 'Wildcard', sort_order: 11 },
];

async function ensureRandomizerSeed(forceV2Reload = false) {
  // 1. Synchronize randomizer_categories
  for (const c of CATEGORIES_DEF) {
    const { rows } = await pool.query(
      `SELECT 1 FROM randomizer_categories WHERE key = $1`, [c.key]
    );
    if (!rows.length) {
      await pool.query(
        `INSERT INTO randomizer_categories (key, display_name, sort_order, is_active)
         VALUES ($1, $2, $3, true)`,
        [c.key, c.display_name, c.sort_order]
      );
    } else {
      await pool.query(
        `UPDATE randomizer_categories SET display_name = $2, sort_order = $3, is_active = true WHERE key = $1`,
        [c.key, c.display_name, c.sort_order]
      );
    }
  }

  const file = path.join(__dirname, 'randomizer_seed.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));

  // Check if styles and colors match V2 specifications
  const { rows: styleRows } = await pool.query(
    `SELECT count(*)::int AS n FROM randomizer_elements WHERE category = 'style'`
  );
  const { rows: colorRows } = await pool.query(
    `SELECT count(*)::int AS n FROM randomizer_elements WHERE category = 'color'`
  );

  // If V2 refresh needed or forced:
  const needsV2Sync = forceV2Reload || styleRows[0].n !== 30 || colorRows[0].n !== 300;
  if (needsV2Sync) {
    console.log('[seed] Synchronizing Randomizer V2 element pool (30 styles, 300 4-colour palettes)...');
    await pool.query(
      `DELETE FROM randomizer_elements WHERE category IN ('style', 'color', 'composition', 'weather', 'texture')`
    );
  }

  const { rows } = await pool.query(
    `SELECT category, count(*)::int AS n FROM randomizer_elements GROUP BY category`
  );
  const present = new Map(rows.map((r) => [r.category, r.n]));

  const rowsToInsert = [];
  for (const [category, entries] of Object.entries(data)) {
    if (present.get(category) > 0 && !needsV2Sync) continue;
    for (const e of entries) {
      rowsToInsert.push({ category, name: e.name, tags: e.tags || [] });
    }
  }

  let inserted = 0;
  for (let i = 0; i < rowsToInsert.length; i += CHUNK) {
    const chunk = rowsToInsert.slice(i, i + CHUNK);
    const params = [];
    const values = chunk.map((r, j) => {
      params.push(r.category, r.name, r.tags);
      return `($${j * 3 + 1}, $${j * 3 + 2}, $${j * 3 + 3}, 'official', 'active')`;
    }).join(', ');
    const res = await pool.query(
      `INSERT INTO randomizer_elements (category, name, tags, source, status)
       VALUES ${values}
       ON CONFLICT (category, name) DO NOTHING`,
      params
    );
    inserted += res.rowCount;
  }

  const { rows: totalRows } = await pool.query(
    `SELECT count(*)::int AS total FROM randomizer_elements WHERE status = 'active'`
  );
  const total = totalRows[0] ? totalRows[0].total : 0;
  console.log(`SEED randomizer V2 pool ready: ${total} active elements (${inserted} inserted this run)`);
  return total;
}

module.exports = { ensureRandomizerSeed };
