'use strict';
/**
 * ============================================================================
 *  ART ARENA™ — RANDOMIZER V2 · EXTREME VARIETY OVERHAUL
 * ============================================================================
 *  Core challenge generator with multi-dimensional independence:
 *    - Core: Character + Environment + Object + Art Style + 4-Colour Palette
 *    - Optional Modifiers: Lighting, Atmosphere/Mood, Composition, Weather, Texture
 *    - 30 Approved 2D Art Styles ONLY
 *    - 300 Curated 4-Colour Base Palettes (each exactly 4 distinct colours)
 *    - Independent Colour Variation Engine (hue, saturation, brightness, temperature, tone, contrast)
 *    - Anti-Repetition Engine (recent history buffer & combination guards)
 * ============================================================================
 */
const { HttpError } = require('./lib');

// EXACTLY 30 APPROVED 2D ART STYLES
const APPROVED_STYLES = [
  'Anime',
  'Manga',
  'Cartoon',
  'Comic Book',
  'Realism',
  'Semi-Realism',
  'Digital Painting',
  'Watercolor',
  'Oil Painting',
  'Acrylic Painting',
  'Gouache',
  'Pencil Sketch',
  'Colored Pencil',
  'Ink Drawing',
  'Charcoal',
  'Pastel',
  'Line Art',
  'Concept Art',
  'Illustration',
  "Children's Illustration",
  'Storybook',
  'Fantasy Art',
  'Surrealism',
  'Abstract Art',
  'Impressionism',
  'Expressionism',
  'Pop Art',
  'Art Nouveau',
  'Art Deco',
  'Graffiti / Street Art',
];

// VARIATION MODIFIERS FOR COLOUR ENGINE
const HUE_SHIFTS = [
  'warm', 'cool', 'coral-shifted', 'golden-tinted', 'amber-shifted',
  'violet-shifted', 'rose-tinted', 'cyan-tinted', 'lime-shifted',
  'slight hue-shifted', 'moderate hue-shifted', 'vibrant-shifted'
];

const SATURATION_VARIATIONS = [
  'muted', 'low-saturation', 'medium-saturation', 'vivid',
  'highly saturated', 'neon', 'desaturated'
];

const BRIGHTNESS_VARIATIONS = [
  'dark', 'deep', 'medium', 'bright', 'luminous', 'pale', 'midnight', 'shadowy'
];

const TEMPERATURE_VARIATIONS = [
  'cooler', 'neutral', 'warmer', 'ice-cold', 'sun-warmed'
];

const TONE_VARIATIONS = [
  'pastel', 'dusty', 'rich', 'earthy', 'smoky', 'washed', 'luminous', 'velvet'
];

const CONTRAST_VARIATIONS = [
  'low-contrast', 'high-contrast', 'extreme-contrast'
];

const ALL_VARIATION_POOLS = [
  { type: 'hue', pool: HUE_SHIFTS },
  { type: 'saturation', pool: SATURATION_VARIATIONS },
  { type: 'brightness', pool: BRIGHTNESS_VARIATIONS },
  { type: 'temperature', pool: TEMPERATURE_VARIATIONS },
  { type: 'tone', pool: TONE_VARIATIONS },
  { type: 'contrast', pool: CONTRAST_VARIATIONS }
];

/**
 * Independently varies a single colour name.
 * Returns { value: string, variationType: string }
 */
function varySingleColour(colorName, forceVariation = false) {
  const clean = colorName.trim();
  // 25% chance clean base colour unless forced
  if (!forceVariation && Math.random() < 0.25) {
    return { value: clean, variationType: 'base' };
  }
  const choice = ALL_VARIATION_POOLS[Math.floor(Math.random() * ALL_VARIATION_POOLS.length)];
  const mod = choice.pool[Math.floor(Math.random() * choice.pool.length)];
  return { value: `${mod} ${clean}`, variationType: choice.type };
}

/**
 * Applies independent variations to each of the 4 colours in a palette.
 * Input can be an array of 4 colours or a string formatted as "c1 + c2 + c3 + c4".
 * Returns { variedString, variedColors, appliedVariations }
 */
function varyPalette(paletteInput) {
  let rawColors = [];
  if (Array.isArray(paletteInput)) {
    rawColors = paletteInput;
  } else if (typeof paletteInput === 'string') {
    rawColors = paletteInput.split(' + ').map((s) => s.trim());
  }
  if (rawColors.length !== 4) {
    // If not exactly 4, slice or pad to guarantee 4
    rawColors = rawColors.slice(0, 4);
    while (rawColors.length < 4) rawColors.push('neutral grey');
  }

  const variedColors = [];
  const appliedVariations = [];

  for (const c of rawColors) {
    const res = varySingleColour(c);
    variedColors.push(res.value);
    appliedVariations.push(res.variationType);
  }

  return {
    variedString: variedColors.join(' + '),
    variedColors,
    appliedVariations,
  };
}

// ANTI-REPETITION HISTORY BUFFER
const RECENT_CHALLENGES = [];
const MAX_HISTORY = 40;

function isRecentlyUsed(challengeRecord) {
  const { summary, triplet } = challengeRecord;
  for (let i = RECENT_CHALLENGES.length - 1; i >= 0; i--) {
    const h = RECENT_CHALLENGES[i];
    if (h.summary === summary) return true;
    if (triplet && h.triplet && h.triplet === triplet && (RECENT_CHALLENGES.length - i) < 15) {
      return true;
    }
  }
  return false;
}

function recordChallenge(challengeRecord) {
  RECENT_CHALLENGES.push(challengeRecord);
  if (RECENT_CHALLENGES.length > MAX_HISTORY) {
    RECENT_CHALLENGES.shift();
  }
}

/**
 * v67: Decides which categories to select for a generation.
 * The five modifier categories (mood, lighting, composition, weather,
 * texture) were REMOVED from the product — they can never be selected,
 * whatever an old room config still contains. The host's configured list is
 * respected after filtering to the allowed set; with no (valid) config the
 * default core five are used.
 */
const ALLOWED_CATEGORIES = ['character', 'environment', 'object', 'style', 'color', 'wildcard'];

function selectCategoriesForGeneration(userConfigured) {
  if (Array.isArray(userConfigured) && userConfigured.length > 0) {
    const filtered = [...new Set(userConfigured)].filter((c) => ALLOWED_CATEGORIES.includes(c));
    if (filtered.length > 0) return filtered;
  }
  return DEFAULT_CATEGORIES.slice();
}

const DEFAULT_CATEGORIES = ['character', 'environment', 'object', 'style', 'color'];

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
  const catsToUse = selectCategoriesForGeneration(cfg.categories);

  const { rows: st } = await client.query(
    `SELECT status FROM battles WHERE id = $1 FOR UPDATE`, [battleId]
  );
  if (!st[0]) throw new HttpError(404, 'Battle not found.');
  let status = st[0].status;

  // Canonical state machine:
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
    [battleId, actorId, JSON.stringify({ categories: catsToUse })]
  );

  let picks = [];
  let summary = '';
  let attempts = 0;
  const maxAttempts = 5;

  while (attempts < maxAttempts) {
    attempts++;
    picks = [];

    for (const cat of catsToUse) {
      const { rows: el } = await client.query(
        `SELECT id, name FROM randomizer_elements
          WHERE category = $1 AND status = 'active'
          ORDER BY random() LIMIT 1`,
        [cat]
      );
      if (!el[0]) {
        // Fallback for optional categories if empty
        continue;
      }

      let val = el[0].name;
      // If color palette, run through Colour Variation Engine
      if (cat === 'color') {
        const varied = varyPalette(val);
        val = varied.variedString;
      }

      picks.push({ category: cat, element_id: el[0].id, value: val });
    }

    summary = picks.map((p) => p.value).join(' · ');

    const charPick = picks.find((p) => p.category === 'character');
    const envPick = picks.find((p) => p.category === 'environment');
    const stylePick = picks.find((p) => p.category === 'style');
    const triplet =
      charPick && envPick && stylePick
        ? `${charPick.value}::${envPick.value}::${stylePick.value}`
        : null;

    if (!isRecentlyUsed({ summary, triplet }) || attempts === maxAttempts) {
      recordChallenge({ summary, triplet });
      break;
    }
  }

  // The OFFICIAL, LOCKED challenge — identical for every participant.
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

module.exports = {
  lockChallengeCore,
  DEFAULT_CATEGORIES,
  APPROVED_STYLES,
  varySingleColour,
  varyPalette,
  selectCategoriesForGeneration,
  recordChallenge,
  isRecentlyUsed,
};
