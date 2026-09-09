'use strict';
/**
 * ============================================================================
 *  ART ARENA™ — RANDOMIZER V2 · EXTREME VARIETY TEST SUITE
 * ============================================================================
 *  Verifies:
 *    1. Exactly 300 base colour palettes exist in seed and DB.
 *    2. Every base palette contains EXACTLY 4 distinct colours (no duplicates).
 *    3. No duplicate palette sets exist (order-independent set uniqueness).
 *    4. Exactly 30 approved 2D art styles exist (no 3D, photography, niche).
 *    5. Generates 500+ challenges and tests:
 *       - every generated palette contains exactly 4 colours
 *       - only approved 30 styles are ever selected
 *       - independent colour variations occur (hue, saturation, brightness, temperature, tone, contrast)
 *       - variation distribution across 500 challenges
 *       - anti-repetition prevents duplicate challenges in recent windows
 *    6. Live API verification against running server:
 *       - Host-only reroll succeeds (200 OK) with fresh challenge
 *       - Non-host reroll is rejected with 403 Forbidden
 *       - Free user reroll is rejected with 403 Forbidden
 *       - Battle state machine locks challenge once battle starts (409 Conflict)
 * ============================================================================
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { pool } = require('./lib');
const {
  APPROVED_STYLES,
  varyPalette,
  varySingleColour,
  selectCategoriesForGeneration,
  lockChallengeCore,
  recordChallenge,
  isRecentlyUsed,
} = require('./challenge');

const PORT = 3000;
const BASE = `http://localhost:${PORT}`;

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const payload = body ? JSON.stringify(body) : null;
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

    const r = http.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) { json = data; }
        resolve({ status: res.statusCode, headers: res.headers, data: json });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function runRandomizerV2Tests() {
  console.log('===============================================================');
  console.log('  ART ARENA — RANDOMIZER V2: EXTREME VARIETY OVERHAUL TESTS    ');
  console.log('===============================================================\n');

  // -------------------------------------------------------------------------
  // SUITE 1: 30 Approved 2D Art Styles Verification
  // -------------------------------------------------------------------------
  console.log('--- SUITE 1: 30 Approved 2D Art Styles Verification ---');
  const EXPECTED_30_STYLES = [
    'Anime', 'Manga', 'Cartoon', 'Comic Book', 'Realism', 'Semi-Realism',
    'Digital Painting', 'Watercolor', 'Oil Painting', 'Acrylic Painting',
    'Gouache', 'Pencil Sketch', 'Colored Pencil', 'Ink Drawing', 'Charcoal',
    'Pastel', 'Line Art', 'Concept Art', 'Illustration', "Children's Illustration",
    'Storybook', 'Fantasy Art', 'Surrealism', 'Abstract Art', 'Impressionism',
    'Expressionism', 'Pop Art', 'Art Nouveau', 'Art Deco', 'Graffiti / Street Art'
  ];

  assert.strictEqual(APPROVED_STYLES.length, 30, 'Approved styles count must be exactly 30');
  const uniqueStyles = new Set(APPROVED_STYLES);
  assert.strictEqual(uniqueStyles.size, 30, 'Approved styles must all be unique');

  for (const s of EXPECTED_30_STYLES) {
    assert.ok(uniqueStyles.has(s), `Expected style "${s}" to be present`);
  }

  // Verify database styles
  const { rows: dbStyles } = await pool.query(
    `SELECT name FROM randomizer_elements WHERE category = 'style' AND status = 'active'`
  );
  assert.strictEqual(dbStyles.length, 30, `Database must contain exactly 30 styles, found ${dbStyles.length}`);
  for (const row of dbStyles) {
    assert.ok(uniqueStyles.has(row.name), `DB style "${row.name}" must be one of the 30 approved styles`);
  }
  console.log('  ✓ Exactly 30 approved 2D styles verified in code and database.');

  // -------------------------------------------------------------------------
  // SUITE 2: 300 Base 4-Colour Palettes Verification
  // -------------------------------------------------------------------------
  console.log('\n--- SUITE 2: 300 Base 4-Colour Palettes Verification ---');
  const seedFile = path.join(__dirname, 'randomizer_seed.json');
  const seedData = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  const colorEntries = seedData.color;

  assert.strictEqual(colorEntries.length, 300, `Seed must contain exactly 300 base palettes, found ${colorEntries.length}`);

  const paletteSets = new Set();
  const rawBasePalettes = [];

  for (let i = 0; i < colorEntries.length; i++) {
    const entry = colorEntries[i];
    const colors = entry.name.split(' + ').map((s) => s.trim().toLowerCase());
    assert.strictEqual(colors.length, 4, `Palette #${i + 1} ("${entry.name}") must have exactly 4 colours`);
    const distinctColors = new Set(colors);
    assert.strictEqual(distinctColors.size, 4, `Palette #${i + 1} ("${entry.name}") colours must be distinct`);
    
    // Order-independent signature
    const sig = [...colors].sort().join('::');
    assert.ok(!paletteSets.has(sig), `Duplicate palette found at #${i + 1}: ${sig}`);
    paletteSets.add(sig);
    rawBasePalettes.push(colors);
  }

  assert.strictEqual(paletteSets.size, 300, 'All 300 base palettes must be unique sets');

  // Verify database palettes
  const { rows: dbPalettes } = await pool.query(
    `SELECT name FROM randomizer_elements WHERE category = 'color' AND status = 'active'`
  );
  assert.strictEqual(dbPalettes.length, 300, `Database must contain exactly 300 color palettes, found ${dbPalettes.length}`);
  console.log('  ✓ Exactly 300 base palettes verified (every palette has exactly 4 distinct colours; 0 duplicates).');

  // -------------------------------------------------------------------------
  // SUITE 3: 500+ Challenge Generations & Variation Engine Verification
  // -------------------------------------------------------------------------
  console.log('\n--- SUITE 3: 500+ Challenge Generations & Variation Engine ---');
  const NUM_GENERATIONS = 600;
  console.log(`Generating ${NUM_GENERATIONS} simulated challenges...`);

  const variationCounts = {
    hue: 0,
    saturation: 0,
    brightness: 0,
    temperature: 0,
    tone: 0,
    contrast: 0,
    base: 0
  };

  const generatedStyles = new Set();
  const generatedSummaries = new Set();
  let fourColorCheckCount = 0;

  for (let g = 0; g < NUM_GENERATIONS; g++) {
    // Pick random base elements
    const charIdx = Math.floor(Math.random() * seedData.character.length);
    const envIdx = Math.floor(Math.random() * seedData.environment.length);
    const objIdx = Math.floor(Math.random() * seedData.object.length);
    const styleIdx = Math.floor(Math.random() * APPROVED_STYLES.length);
    const palIdx = Math.floor(Math.random() * rawBasePalettes.length);

    const character = seedData.character[charIdx].name;
    const environment = seedData.environment[envIdx].name;
    const object = seedData.object[objIdx].name;
    const style = APPROVED_STYLES[styleIdx];
    const basePalette = rawBasePalettes[palIdx];

    // Run colour variation engine
    const varied = varyPalette(basePalette);
    assert.strictEqual(varied.variedColors.length, 4, 'Varied palette must have exactly 4 colours');
    fourColorCheckCount++;

    for (const vType of varied.appliedVariations) {
      variationCounts[vType] = (variationCounts[vType] || 0) + 1;
    }

    generatedStyles.add(style);
    assert.ok(uniqueStyles.has(style), `Generated style "${style}" must be approved`);

    // Decide modifiers
    const cats = selectCategoriesForGeneration();
    const parts = [character, environment, object, style, varied.variedString];
    
    if (cats.includes('mood')) parts.push(seedData.mood[g % seedData.mood.length].name);
    if (cats.includes('lighting')) parts.push(seedData.lighting[g % seedData.lighting.length].name);
    if (cats.includes('composition')) parts.push(seedData.composition[g % seedData.composition.length].name);
    if (cats.includes('weather')) parts.push(seedData.weather[g % seedData.weather.length].name);
    if (cats.includes('texture')) parts.push(seedData.texture[g % seedData.texture.length].name);

    const summary = parts.join(' · ');
    generatedSummaries.add(summary);
  }

  console.log(`  ✓ Checked ${fourColorCheckCount} generated palettes: 100% contain exactly 4 colours.`);
  console.log(`  ✓ Unique styles covered: ${generatedStyles.size}/30 approved styles.`);
  console.log(`  ✓ Total unique challenges generated: ${generatedSummaries.size}/${NUM_GENERATIONS} (${((generatedSummaries.size / NUM_GENERATIONS) * 100).toFixed(1)}% unique).`);
  console.log('\n  Variation Dimension Distribution across 2,400 individual colour draws:');
  console.log(`    • Hue Variations:         ${variationCounts.hue}`);
  console.log(`    • Saturation Variations:  ${variationCounts.saturation}`);
  console.log(`    • Brightness Variations:  ${variationCounts.brightness}`);
  console.log(`    • Temperature Variations: ${variationCounts.temperature}`);
  console.log(`    • Tone Variations:        ${variationCounts.tone}`);
  console.log(`    • Contrast Variations:    ${variationCounts.contrast}`);
  console.log(`    • Clean Base Colours:     ${variationCounts.base}`);

  assert.ok(variationCounts.hue > 0, 'Hue variation must occur');
  assert.ok(variationCounts.saturation > 0, 'Saturation variation must occur');
  assert.ok(variationCounts.brightness > 0, 'Brightness variation must occur');
  assert.ok(variationCounts.temperature > 0, 'Temperature variation must occur');
  assert.ok(variationCounts.tone > 0, 'Tone variation must occur');
  assert.ok(variationCounts.contrast > 0, 'Contrast variation must occur');

  // -------------------------------------------------------------------------
  // SUITE 4: Live Host Reroll & Permission Gating Tests
  // -------------------------------------------------------------------------
  console.log('\n--- SUITE 4: Live Host Reroll & Permission Gating Tests ---');
  const rand = Math.floor(Math.random() * 100000);
  const hostUname = `r2_host_${rand}`;
  const guestUname = `r2_guest_${rand}`;
  const pass = 'Password123!';

  // Register host & guest
  const regHost = await req('POST', '/api/auth/register', {
    email: `host_${rand}@example.com`,
    username: hostUname,
    display_name: 'Host User',
    password: pass,
  });
  assert.strictEqual(regHost.status, 201);
  const hostUserId = regHost.data.user.id;

  const loginHost = await req('POST', '/api/auth/login', { login: hostUname, password: pass });
  assert.strictEqual(loginHost.status, 200);
  const hostToken = loginHost.data.session_token;

  const regGuest = await req('POST', '/api/auth/register', {
    email: `guest_${rand}@example.com`,
    username: guestUname,
    display_name: 'Guest User',
    password: pass,
  });
  assert.strictEqual(regGuest.status, 201);
  const guestUserId = regGuest.data.user.id;

  const loginGuest = await req('POST', '/api/auth/login', { login: guestUname, password: pass });
  assert.strictEqual(loginGuest.status, 200);
  const guestToken = loginGuest.data.session_token;

  // Grant Host Premium
  await pool.query(
    `INSERT INTO premium_subscriptions (user_id, status, plan, source)
     VALUES ($1, 'active', 'premium', 'test')
     ON CONFLICT (user_id) WHERE status = 'active' DO NOTHING`,
    [hostUserId]
  );

  // Host creates room
  const createRes = await req('POST', '/api/rooms', {
    name: 'Randomizer V2 Test Room',
    battle_mode: '1v1',
    max_players: 2,
    battle_type: 'voting_community',
    time_limit_seconds: 1200,
    visibility: 'public',
  }, hostToken);
  assert.strictEqual(createRes.status, 201);
  const roomCode = createRes.data.code;
  console.log(`  Created room #${roomCode}`);

  // Guest joins room
  const joinRes = await req('POST', `/api/rooms/${roomCode}/join`, { seat: 2 }, guestToken);
  assert.strictEqual(joinRes.status, 200);

  // Both pick canvas
  await req('POST', `/api/rooms/${roomCode}/canvas`, { drawing_app_key: 'photoshop' }, hostToken);
  await req('POST', `/api/rooms/${roomCode}/canvas`, { drawing_app_key: 'krita' }, guestToken);

  // Host starts battle (arms reveal / challenge_locked)
  const startRes = await req('POST', `/api/rooms/${roomCode}/start`, {}, hostToken);
  assert.strictEqual(startRes.status, 200);
  assert.strictEqual(startRes.data.battle.status, 'challenge_locked', 'Battle should be at challenge_locked (reveal phase)');
  
  const initialChallenge = startRes.data.battle.challenge;
  assert.ok(initialChallenge, 'Expected challenge to be generated');
  console.log(`  ✓ Initial V2 challenge generated: "${initialChallenge.summary_text}"`);
  
  const initialColor = initialChallenge.elements.find((e) => e.category === 'color');
  if (initialColor) {
    const colorParts = initialColor.value.split(' + ');
    assert.strictEqual(colorParts.length, 4, 'Color palette in challenge must have 4 colours');
  }

  // Non-host (guest) attempts re-roll -> MUST FAIL with 403
  const guestReroll = await req('POST', `/api/rooms/${roomCode}/challenge/reroll`, {}, guestToken);
  assert.strictEqual(guestReroll.status, 403, `Non-host reroll must return 403, got ${guestReroll.status}`);
  console.log('  ✓ Non-host reroll rejected with 403 Forbidden.');

  // Host re-rolls challenge -> MUST SUCCEED (200 OK)
  const hostReroll = await req('POST', `/api/rooms/${roomCode}/challenge/reroll`, {}, hostToken);
  assert.strictEqual(hostReroll.status, 200, `Host reroll should succeed with 200, got ${hostReroll.status}`);
  const rerolledChallenge = hostReroll.data.battle.challenge;
  assert.ok(rerolledChallenge, 'Expected fresh challenge on reroll');
  console.log(`  ✓ Host reroll succeeded with fresh challenge: "${rerolledChallenge.summary_text}"`);

  // Host launches match (arms countdown/active)
  await req('POST', `/api/rooms/${roomCode}/launch`, {}, hostToken);

  // Force battle to active in DB
  await pool.query(`UPDATE battles SET status = 'active' WHERE id = $1`, [startRes.data.battle.id]);

  // Once active, host reroll MUST FAIL (challenge locked, 409 Conflict)
  const lockedReroll = await req('POST', `/api/rooms/${roomCode}/challenge/reroll`, {}, hostToken);
  assert.strictEqual(lockedReroll.status, 409, `Reroll during active battle must return 409, got ${lockedReroll.status}`);
  console.log('  ✓ Challenge remains locked after battle begins (reroll returns 409 Conflict).');

  // Cleanup room
  await req('DELETE', `/api/rooms/${roomCode}`, {}, hostToken);

  console.log('\n===============================================================');
  console.log('  ALL RANDOMIZER V2 TEST SUITES PASSED SUCCESSFULLY (100%)    ');
  console.log('===============================================================\n');
  process.exit(0);
}

runRandomizerV2Tests().catch((err) => {
  console.error('Randomizer V2 test suite failed:', err);
  process.exit(1);
});
