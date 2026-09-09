'use strict';
const assert = require('assert');
const http = require('http');

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

async function run() {
  console.log('=== RUNNING ART ARENA FULL VERIFICATION TEST SUITE ===\n');

  // 1. Check all 7 theme assets are served
  console.log('Test 1: Theme profile asset endpoints');
  const assets = [
    'profile-flame.png',
    'profile-cloud.jpg',
    'profile-glowing.jpg',
    'profile-glitch.jpg',
    'profile-graffiti.jpg',
    'profile-magazine.png',
    'profile-pixel.jpg',
  ];
  for (const asset of assets) {
    const res = await req('GET', `/themes/${asset}`);
    assert.strictEqual(res.status, 200, `Expected 200 for /themes/${asset}, got ${res.status}`);
  }
  console.log('  ✓ All 7 profile background assets exist and serve 200 OK');

  // 2. Register free user, friend user, and premium user
  console.log('\nTest 2: Register Free, Friend, and Premium test accounts');
  const rand = Math.floor(Math.random() * 100000);
  const freeEmail = `free_${rand}@example.com`;
  const premEmail = `prem_${rand}@example.com`;
  const friendEmail = `friend_${rand}@example.com`;

  const regFree = await req('POST', '/api/auth/register', {
    email: freeEmail,
    username: `freeuser_${rand}`,
    display_name: 'Free User',
    password: 'Password123!',
  });
  assert.strictEqual(regFree.status, 201);
  const freeUserId = regFree.data.user.id;
  const loginFree = await req('POST', '/api/auth/login', {
    login: `freeuser_${rand}`,
    password: 'Password123!',
  });
  assert.strictEqual(loginFree.status, 200);
  const freeToken = loginFree.data.session_token;

  const regPrem = await req('POST', '/api/auth/register', {
    email: premEmail,
    username: `premuser_${rand}`,
    display_name: 'Prem User',
    password: 'Password123!',
  });
  assert.strictEqual(regPrem.status, 201);
  const premUserId = regPrem.data.user.id;
  const loginPrem = await req('POST', '/api/auth/login', {
    login: `premuser_${rand}`,
    password: 'Password123!',
  });
  assert.strictEqual(loginPrem.status, 200);
  const premToken = loginPrem.data.session_token;

  const regFriend = await req('POST', '/api/auth/register', {
    email: friendEmail,
    username: `friend_${rand}`,
    display_name: 'Friend User',
    password: 'Password123!',
  });
  assert.strictEqual(regFriend.status, 201);
  const friendUserId = regFriend.data.user.id;
  const loginFriend = await req('POST', '/api/auth/login', {
    login: `friend_${rand}`,
    password: 'Password123!',
  });
  assert.strictEqual(loginFriend.status, 200);
  const friendToken = loginFriend.data.session_token;

  // Upgrade premUser directly in DB
  const { pool } = require('./lib');
  await pool.query(
    `INSERT INTO premium_subscriptions (user_id, status, plan, source)
     VALUES ($1, 'active', 'premium', 'test')
     ON CONFLICT (user_id) WHERE status = 'active' DO NOTHING`,
    [premUserId]
  );
  // Set premUser theme to flame
  await pool.query(
    `UPDATE users SET ui_theme = 'flame', ui_theme_custom = $1 WHERE id = $2`,
    [JSON.stringify({ c1: '#ff5a00', c2: '#ffc300' }), premUserId]
  );
  console.log('  ✓ Created Free user, Friend user, and entitled Premium user (Flame theme)');

  // 3. Test Profile API endpoints & Perspective logic payloads
  console.log('\nTest 3: Profile API perspectives');
  const viewPremAsFree = await req('GET', `/api/users/${premUserId}/profile`, null, freeToken);
  assert.strictEqual(viewPremAsFree.status, 200);
  assert.strictEqual(viewPremAsFree.data.user.premium, true);
  assert.strictEqual(viewPremAsFree.data.user.ui_theme, 'flame');
  assert.strictEqual(viewPremAsFree.data.user.ui_custom.c1.toLowerCase(), '#ff5a00');
  assert.strictEqual(viewPremAsFree.data.user.ui_custom.c2.toLowerCase(), '#ffc300');
  console.log('  ✓ Free viewing Premium returns owner theme (Flame) and premium=true');

  const viewFreeAsPrem = await req('GET', `/api/users/${freeUserId}/profile`, null, premToken);
  assert.strictEqual(viewFreeAsPrem.status, 200);
  assert.strictEqual(viewFreeAsPrem.data.user.premium, false);
  assert.strictEqual(viewFreeAsPrem.data.user.ui_theme, null);
  console.log('  ✓ Premium viewing Free returns premium=false and ui_theme=null (Free/Default)');

  // 4. Test Randomizer Challenge generation and Host-Only Re-roll Permissions
  console.log('\nTest 4: Randomizer generation & Host-Only re-roll permissions');
  const create1v1 = await req('POST', '/api/rooms', {
    name: '1v1 Challenge Test',
    battle_mode: '1v1',
    max_players: 2,
    battle_type: 'voting_community',
    time_limit_seconds: 1200,
    drawing_app_key: 'krita',
  }, premToken);
  assert.strictEqual(create1v1.status, 201);
  const room1v1Code = create1v1.data.code;

  // Free user joins 1v1 room
  const join1v1 = await req('POST', `/api/rooms/${room1v1Code}/join`, { drawing_app_key: 'krita' }, freeToken);
  assert.strictEqual(join1v1.status, 200);

  // Host starts battle -> triggers authoritative challenge generation
  const start1v1 = await req('POST', `/api/rooms/${room1v1Code}/start`, {}, premToken);
  assert.strictEqual(start1v1.status, 200);
  assert.ok(start1v1.data.battle);
  assert.strictEqual(start1v1.data.battle.status, 'challenge_locked');
  assert.ok(start1v1.data.battle.challenge);
  const originalSummary = start1v1.data.battle.challenge.summary_text;
  console.log('  ✓ Authoritative challenge generated in DB:', originalSummary);

  // Non-host (free user) attempts re-roll -> MUST be rejected with 403 Forbidden
  const freeReroll = await req('POST', `/api/rooms/${room1v1Code}/challenge/reroll`, {}, freeToken);
  assert.strictEqual(freeReroll.status, 403, `Expected 403 for non-host reroll, got ${freeReroll.status}`);
  console.log('  ✓ Non-host re-roll rejected with 403 Forbidden');

  // Host (premium) executes re-roll -> 200 OK
  const hostReroll = await req('POST', `/api/rooms/${room1v1Code}/challenge/reroll`, {}, premToken);
  assert.strictEqual(hostReroll.status, 200);
  assert.ok(hostReroll.data.battle.challenge);
  console.log('  ✓ Host re-roll succeeded with fresh elements:', hostReroll.data.battle.challenge.summary_text);

  // Cancel battle so room can be cleanly archived/deleted
  await pool.query(`UPDATE battles SET status = 'cancelled' WHERE id = $1`, [start1v1.data.battle.id]);
  await req('DELETE', `/api/rooms/${room1v1Code}`, {}, premToken);

  // 5. Test 3v3 Team Slot Rearrangement (Host Only)
  console.log('\nTest 5: 3v3 Team Slot Rearrangement');
  // Create 3v3 room
  const create3v3 = await req('POST', '/api/rooms', {
    name: '3v3 Team Move Test',
    battle_mode: '3v3',
    max_players: 6,
    battle_type: 'voting_community',
    time_limit_seconds: 1200,
    drawing_app_key: 'krita',
  }, premToken);
  assert.strictEqual(create3v3.status, 201);
  const room3v3Code = create3v3.data.code;

  // Free user joins 3v3 room
  const join3v3 = await req('POST', `/api/rooms/${room3v3Code}/join`, { drawing_app_key: 'krita' }, freeToken);
  assert.strictEqual(join3v3.status, 200);
  const freeUserSeat = join3v3.data.players.find((p) => p.user_id === freeUserId).seat;

  // Non-host tries to move player -> 403
  const freeMove = await req('POST', `/api/rooms/${room3v3Code}/move-player`, {
    from_seat: freeUserSeat,
    to_seat: 5,
  }, freeToken);
  assert.strictEqual(freeMove.status, 403);
  console.log('  ✓ Non-host slot movement rejected with 403 Forbidden');

  // Host moves Free user to slot 5 (Team B slot 2)
  const hostMove = await req('POST', `/api/rooms/${room3v3Code}/move-player`, {
    from_seat: freeUserSeat,
    to_seat: 5,
  }, premToken);
  assert.strictEqual(hostMove.status, 200);
  const updatedFreeSeat = hostMove.data.players.find((p) => p.user_id === freeUserId).seat;
  assert.strictEqual(updatedFreeSeat, 5);
  console.log('  ✓ Host moved player from slot ' + freeUserSeat + ' to slot 5');

  // Host swaps seat 1 (Host) with seat 5 (Free user)
  const hostSwap = await req('POST', `/api/rooms/${room3v3Code}/move-player`, {
    from_seat: 1,
    to_seat: 5,
  }, premToken);
  assert.strictEqual(hostSwap.status, 200);
  const newHostSeat = hostSwap.data.players.find((p) => p.user_id === premUserId).seat;
  const newFreeSeat = hostSwap.data.players.find((p) => p.user_id === freeUserId).seat;
  assert.strictEqual(newHostSeat, 5);
  assert.strictEqual(newFreeSeat, 1);
  console.log('  ✓ Host successfully swapped slots between Team A and Team B (Seat 1 <-> Seat 5)');

  // 6. Test Friend Availability API & Online Status Logic
  console.log('\nTest 6: Friend availability & Online status checking');
  // Make Prem and Friend mutual friends in DB
  await pool.query(
    `INSERT INTO friendships (user_a, user_b)
     VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid))
     ON CONFLICT DO NOTHING`,
    [premUserId, friendUserId]
  );

  // Friend is currently not connected to WS -> offline
  const availOffline = await req('GET', `/api/friends/${friendUserId}/availability`, null, premToken);
  assert.strictEqual(availOffline.status, 200);
  assert.strictEqual(availOffline.data.online, false);
  assert.strictEqual(availOffline.data.available, false);
  console.log('  ✓ Availability returns online=false and available=false for offline friend');

  // Test PUT /api/teams/draft rejection for offline friend
  const draftOffline = await req('PUT', '/api/teams/draft', { member_ids: [friendUserId] }, premToken);
  assert.strictEqual(draftOffline.status, 409);
  console.log('  ✓ PUT /api/teams/draft rejects offline friend with 409 Conflict');

  // Clean up 3v3 room
  await req('POST', `/api/rooms/${room3v3Code}/leave`, {}, freeToken);
  await req('DELETE', `/api/rooms/${room3v3Code}`, {}, premToken);

  // 7. Test Tournament Participant Voting Permissions
  console.log('\nTest 7: Tournament Participant Voting Permissions');
  // Create 8-player tournament room by Premium host
  const tourneyRoom = await req('POST', '/api/rooms', {
    name: 'Tournament Voting Test',
    battle_mode: 'tournament',
    max_players: 8,
    battle_type: 'voting_community',
    time_limit_seconds: 60,
    drawing_app_key: 'krita',
  }, premToken);
  assert.strictEqual(tourneyRoom.status, 201);
  const tourneyCode = tourneyRoom.data.code;

  // Create additional test users to fill 8 slots in tournament
  const tUsers = [];
  for (let i = 2; i <= 8; i++) {
    const regT = await req('POST', '/api/auth/register', {
      email: `tourney_${i}_${rand}@example.com`,
      username: `tuser_${i}_${rand}`,
      display_name: `Tourney User ${i}`,
      password: 'Password123!',
    });
    const logT = await req('POST', '/api/auth/login', {
      login: `tuser_${i}_${rand}`,
      password: 'Password123!',
    });
    tUsers.push({ id: regT.data.user.id, token: logT.data.session_token, username: `tuser_${i}_${rand}` });
    await req('POST', `/api/rooms/${tourneyCode}/join`, { drawing_app_key: 'krita' }, logT.data.session_token);
  }

  // Host starts the tournament -> seeds bracket and starts first match between 2 artists
  const startTourney = await req('POST', `/api/rooms/${tourneyCode}/start`, {}, premToken);
  assert.strictEqual(startTourney.status, 200);
  assert.ok(startTourney.data.battle);

  // Advance match to judging state with voting_ends_at in future
  const battleId = startTourney.data.battle.id;
  await pool.query(
    `UPDATE battles SET status = 'judging', voting_ends_at = now() + interval '2 minutes' WHERE id = $1`,
    [battleId]
  );

  // Find the 2 competing artists in this match
  const { rows: competingParts } = await pool.query(
    `SELECT user_id FROM battle_participants WHERE battle_id = $1`, [battleId]
  );
  assert.strictEqual(competingParts.length, 2);
  const compA = competingParts[0].user_id;
  const compB = competingParts[1].user_id;

  // Competing artist A attempts to vote on own match -> MUST BE REJECTED (403 Forbidden)
  const tokenCompA = (compA === premUserId) ? premToken : tUsers.find((u) => u.id === compA).token;
  const selfVote = await req('POST', `/api/rooms/${tourneyCode}/vote`, { user_id: compB }, tokenCompA);
  assert.strictEqual(selfVote.status, 403, `Expected 403 for self-vote, got ${selfVote.status}`);
  console.log('  ✓ Competing artist blocked from voting on own match (403 Forbidden)');

  // Non-competing tournament participant (waiting in bracket) casts vote -> 200 OK
  const nonCompUser = tUsers.find((u) => u.id !== compA && u.id !== compB);
  assert.ok(nonCompUser);
  const nonCompVote = await req('POST', `/api/rooms/${tourneyCode}/vote`, { user_id: compA }, nonCompUser.token);
  assert.strictEqual(nonCompVote.status, 200, `Expected 200 for non-competing tournament participant vote, got ${nonCompVote.status}`);
  console.log('  ✓ Non-competing tournament participant successfully voted on active match (200 OK)');

  // Clean up tournament
  await pool.query(`UPDATE battles SET status = 'cancelled' WHERE id = $1`, [battleId]);
  await req('DELETE', `/api/rooms/${tourneyCode}`, {}, premToken);

  console.log('\n==================================================');
  console.log('ALL 7 VERIFICATION SUITES PASSED (100%)');
  console.log('==================================================\n');
  process.exit(0);
}

run().catch((err) => {
  console.error('Test suite failed with error:', err);
  process.exit(1);
});
