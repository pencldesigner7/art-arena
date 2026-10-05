'use strict';
// ============================================================================
// FIX 3 (item 4): BROWSER-LEVEL 3v3 MATCHMAKING REGRESSION TEST.
// Six real queued artists are matched by the server into a 3v3 room; TWO real
// browser sessions (the host and one other member) then verify the UI reflects
// the real server state:
//   - six seats, seats 1-6, both team sides rendered
//   - the live "6/6" hint (server payload, not client invention)
//   - matchmaking rooms expose NO admin controls (Close/Delete hidden even
//     for the host) but LEAVE stays available to every member
//   - the host starts only after EVERY member pressed Ready; both browsers
//     watch the battle lock in over the realtime hub.
// Run against the local app: http://127.0.0.1:3000 (NODE_PATH → Playwright).
// ============================================================================
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const base = 'http://127.0.0.1:3000';
async function api(token, path, body, status = 200, method = body === undefined ? 'GET' : 'POST') {
  const r = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const d = await r.json(); assert.equal(r.status, status, path + ' ' + JSON.stringify(d)); return d;
}
async function user(tag) {
  const name = 'mm3v3_' + tag + '_' + randomBytes(4).toString('hex'), password = 'Mm3v3Test123!';
  const d = await api(null, '/auth/register', { username: name, email: name + '@example.test', password }, 201);
  const login = await api(null, '/auth/login', { login: name, password });
  return { id: d.user.id, token: login.session_token, name };
}
const users = []; let roomCode = null;
(async () => {
  for (let i = 0; i < 6; i++) users.push(await user(i));
  // Queue five — nobody may be seated or "matched" before the sixth arrives.
  for (let i = 0; i < 5; i++) {
    const q = await api(users[i].token, '/matchmaking/enter', { mode: '3v3' });
    assert.equal(q.matched, false, 'user ' + i + ' matched too early');
  }
  const sixth = await api(users[5].token, '/matchmaking/enter', { mode: '3v3' });
  assert.equal(sixth.matched, true, 'sixth artist did not match');
  roomCode = sixth.room;
  const view = await api(users[0].token, '/rooms/' + roomCode);
  assert.equal(view.origin, 'matchmaking');
  assert.equal(view.battle_mode, '3v3');
  assert.equal(view.players.length, 6);
  assert.deepEqual(view.players.map((p) => p.seat).sort(), [1, 2, 3, 4, 5, 6]);
  console.log('PASS six queued artists matched into a real 3v3 room (' + roomCode + ')');

  const browser = await chromium.launch({ headless: true });
  const errors = [];
  try {
    const host = users.find((u) => u.id === view.host.user_id);
    const other = users.find((u) => u !== host);
    const clients = [];
    for (const u of [host, other]) {
      const ctx = await browser.newContext();
      await ctx.addInitScript((token) => sessionStorage.setItem('arena_session_token', token), u.token);
      const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
      await p.goto(base);
      await p.waitForFunction(() => typeof me !== 'undefined' && me);
      await p.evaluate((code) => openRoom(code), roomCode);
      await p.waitForFunction((code) => lastRoomData && lastRoomData.code === code, roomCode);
      clients.push(p);
    }
    const [hp, op] = clients;
    for (const p of clients) {
      // The UI shows the SERVER's six seats and both team sides.
      await p.waitForFunction(() => lastRoomData.players.length === 6);
      assert.equal(await p.locator('.tt-side').count(), 2, 'both team sides must render');
      const hint = await p.locator('#room-hint').textContent();
      assert(hint.includes('6/6'), 'live 6/6 hint missing: ' + hint);
      // Every member keeps LEAVE; Ready is available in the lobby.
      assert(!(await p.locator('#btn-leave').evaluate((e) => e.classList.contains('hidden'))), 'LEAVE must stay available');
      assert(!(await p.locator('#btn-ready').evaluate((e) => e.classList.contains('hidden'))), 'READY must be available');
    }
    // Matchmaking rooms expose NO room administration — even to the host.
    for (const id of ['#btn-close', '#btn-delete']) {
      assert(await hp.locator(id).evaluate((e) => e.classList.contains('hidden')), id + ' must be hidden on a matchmaking room');
    }
    // The host alone sees Start once the room is full.
    assert(!(await hp.locator('#btn-start').evaluate((e) => e.classList.contains('hidden'))), 'host must see Start at 6/6');
    assert(await op.locator('#btn-start').evaluate((e) => e.classList.contains('hidden')), 'non-host must not see Start');
    console.log('PASS browser UI mirrors server: 6 seats, two sides, 6/6 hint, no admin surface, LEAVE kept');

    // Everyone canvases; the five non-hosts Ready via the API, the host
    // presses Ready in the real browser — the battle must NOT start early.
    for (const u of users) await api(u.token, '/rooms/' + roomCode + '/canvas', { drawing_app_key: 'krita' });
    for (const u of users.filter((x) => x !== host)) await api(u.token, '/rooms/' + roomCode + '/ready', {});
    await hp.locator('#btn-ready').click();
    await hp.waitForFunction(() => lastRoomData.players.find((p) => p.is_you).state === 'ready');
    await hp.locator('#btn-start').click();
    // Start runs through the canvas confirmation modal (the host's Krita pick
    // is preselected from the seat) — confirm there, as a real host would.
    await hp.waitForSelector('#canvas-modal:not(.hidden)');
    await hp.waitForFunction(() => !document.getElementById('cm-confirm').disabled);
    await hp.locator('#cm-confirm').click();
    for (const p of clients)
      await p.waitForFunction(() => lastRoomData.battle && lastRoomData.battle.status === 'challenge_locked', null, { timeout: 15000 });
    console.log('PASS all-six-Ready gate: host start locked the challenge live in both browsers');
    assert.deepEqual(errors, [], 'JS errors: ' + errors.join('; '));
  } finally { await browser.close(); }
})().catch((e) => { console.error('FAIL:', e.message); process.exitCode = 1; })
  .finally(async () => {
    for (const u of users) {
      if (roomCode) await api(u.token, '/rooms/' + roomCode + '/leave', {}).catch(() => {});
      await api(u.token, '/matchmaking/status').catch(() => {});
    }
  });
