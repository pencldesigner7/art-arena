'use strict';
// v80 NAVIGATION PLACEMENT — Messages and Safety are no longer top-level
// destinations: Messages lives inside Community → Friends, Safety inside
// Community → Community settings. Every assertion here is against the real
// running app; nothing is mocked.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { chromium } = require('playwright');
const base = 'http://127.0.0.1:3000';
const db = new URL(process.env.DATABASE_URL || 'http://missing');
assert(['localhost', '127.0.0.1'].includes(db.hostname), 'Local disposable DATABASE_URL required');

const errors = [];
async function mk(account) {
  const b = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
  const ctx = await b.newContext({ viewport: { width: 1400, height: 950 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console: ' + m.text()); });
  await ctx.addInitScript((t) => sessionStorage.setItem('arena_session_token', t), account.token);
  await p.goto(base + '/');
  await p.waitForFunction(() => typeof me !== 'undefined' && !!me, null, { timeout: 20000 });
  await p.waitForTimeout(2400);
  return p;
}
async function user() {
  const name = 'nav80_' + randomBytes(5).toString('hex'), password = 'CommunityTest123!';
  const reg = await fetch(base + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: name, email: name + '@example.test', password }),
  });
  assert.equal(reg.status, 201);
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: name, password }),
  }).then((r) => r.json());
  return { token: login.session_token, name };
}
const visible = (p) => p.evaluate(() => [...document.querySelectorAll('.view')].filter((v) => getComputedStyle(v).display !== 'none').map((v) => v.id));
const gotoCommunity = async (p) => {
  await p.click('#bottom-nav .tab[data-tab="community"]');
  await p.waitForSelector('.cm-side-item', { timeout: 15000 });
  await p.waitForTimeout(900);
};

(async () => {
  const b = null; // per-page browsers are opened in mk(); see closeAll below
  const account = await user();
  const p = await mk(account);

  // ---- 1. the drawer no longer carries Messages or Safety ------------------
  await p.click('#btn-menu');
  await p.waitForTimeout(1000);
  const rows = await p.$$eval('#drawer-nav [data-navtab]', (n) => n.map((x) => x.textContent.trim()));
  assert.ok(!rows.includes('Messages'), 'Messages is not a drawer destination');
  assert.ok(!rows.includes('Safety'), 'Safety is not a drawer destination');
  assert.equal(await p.locator('#drawer-nav [data-view="messages"]').count(), 0);
  assert.equal(await p.locator('#drawer-nav [data-view="safety"]').count(), 0);
  // the destinations that remain are untouched
  for (const keep of ['Arena', 'Community', 'LIVE', 'Friends', 'Profile', 'Settings']) {
    assert.ok(rows.includes(keep), keep + ' is still a drawer destination');
  }
  await p.keyboard.press('Escape');
  await p.waitForTimeout(800);

  // ---- 2. Messages is reachable from Community → Friends -------------------
  await gotoCommunity(p);
  await p.click('.cm-side-item[data-cm="friends"]');
  await p.waitForTimeout(1600);
  assert.equal(await p.locator('.cm-open-messages').count(), 1, 'Friends offers a Messages entry');
  assert.equal(await p.locator('#cm-feed.cm-friends').count(), 1, 'the Friends section is in its row layout');
  await p.click('.cm-open-messages');
  await p.waitForSelector('#view-messages:not(.hidden)', { timeout: 15000 });
  assert.deepEqual(await visible(p), ['view-messages'], 'Messages opened');
  // the thread list is the real one
  assert.ok(await p.locator('#msg-list').count() === 1, 'conversation list is present');
  // Back returns to Community, not to an empty stack
  await p.click('#btn-back');
  await p.waitForTimeout(2000);
  assert.deepEqual(await visible(p), ['view-community'], 'Back from Messages lands on Community');
  assert.ok(await p.locator('.cm-side-item[data-cm="friends"].active').count() === 1, 'the Friends section is still the active section');

  // ---- 3. Safety is reachable from Community → Community settings ----------
  await p.click('#cm-side-settings');
  await p.waitForTimeout(2000);
  assert.deepEqual(await visible(p), ['view-community'], 'Community settings stays inside Community');
  assert.equal(await p.locator('.cm-side-item[data-cm="settings"].active').count(), 1, 'Community settings is the active rail item');
  const cards = await p.$$eval('.cm-set-card .cm-set-title', (n) => n.map((x) => x.textContent.trim()));
  assert.deepEqual(cards, ['Safety', 'Community guidelines'], 'Community settings lists Safety');
  // the Safety card shows the SAME counts the Safety view loads (real data)
  const safetyJson = await fetch(base + '/api/community/safety', { headers: { Authorization: 'Bearer ' + account.token } }).then((r) => r.json());
  const sub = await p.textContent('.cm-set-card[data-cm-open="safety"] .cm-set-sub');
  assert.ok(sub.includes(String(safetyJson.blocked.length)) && sub.includes(String(safetyJson.muted.length)),
    'Safety card counts come from the real safety data: ' + sub);
  await p.click('[data-cm-open="safety"]');
  await p.waitForSelector('#view-safety:not(.hidden)', { timeout: 15000 });
  assert.deepEqual(await visible(p), ['view-safety'], 'Safety opened');
  await p.click('#btn-back');
  await p.waitForTimeout(2000);
  assert.deepEqual(await visible(p), ['view-community'], 'Back from Safety lands on Community');

  // ---- 4. Back uses real history first, then a sane static fallback --------
  // With history exhausted (cold load / deep link), BACK_TARGETS decides. Both
  // destinations belong to Community now, so neither can strand the artist.
  await p.goto(base + '/');
  await p.waitForFunction(() => typeof me !== 'undefined' && !!me, null, { timeout: 20000 });
  await p.waitForTimeout(2200);
  await p.evaluate(() => { navStack.length = 0; show('messages'); });
  await p.waitForTimeout(1600);
  await p.click('#btn-back');
  await p.waitForTimeout(1800);
  assert.deepEqual(await visible(p), ['view-community'], 'with no history, Messages falls back to Community');
  await p.evaluate(() => { navStack.length = 0; show('safety'); });
  await p.waitForTimeout(1600);
  await p.click('#btn-back');
  await p.waitForTimeout(1800);
  assert.deepEqual(await visible(p), ['view-community'], 'with no history, Safety falls back to Community');

  // and with real history, Back returns to where you actually came from —
  // exactly the Community section you left
  await gotoCommunity(p);
  await p.click('.cm-side-item[data-cm="friends"]');
  await p.waitForTimeout(1400);
  await p.click('.cm-open-messages');
  await p.waitForSelector('#view-messages:not(.hidden)', { timeout: 15000 });
  await p.click('#btn-back');
  await p.waitForTimeout(2200);
  assert.deepEqual(await visible(p), ['view-community'], 'Back lands on Community');
  assert.equal(await p.locator('.cm-side-item[data-cm="friends"].active').count(), 1, 'and restores the Friends section you left, not the hub');

  // ---- 5. the Featured card carries the artwork, and never a placeholder ---
  await gotoCommunity(p);
  const feat = p.locator('.cm-featured .cm-feat-art');
  assert.equal(await feat.count(), 1, 'the Featured card carries its artwork');
  const meta = await feat.evaluate((el) => ({ src: el.getAttribute('src'), opacity: getComputedStyle(el).opacity, alt: el.getAttribute('alt') }));
  assert.equal(meta.src, '/community-gallery.png', 'the card uses the real asset');
  assert.ok(parseFloat(meta.opacity) > 0 && parseFloat(meta.opacity) < 0.5, 'the artwork is held back behind the copy: ' + meta.opacity);
  assert.equal(meta.alt, '', 'decorative artwork is not announced to screen readers');
  // it really loads (a 404 would leave naturalWidth at 0)
  const loaded = await feat.evaluate((el) => el.complete && el.naturalWidth > 0);
  assert.equal(loaded, true, 'the artwork actually loads');
  // the asset itself is a background-keyed PNG, not a white plate
  const bytes = Buffer.from(await (await fetch(base + '/community-gallery.png')).arrayBuffer());
  assert.ok(bytes.length > 1000, 'asset is served');
  assert.equal(bytes.toString('latin1', 1, 4), 'PNG', 'asset is a PNG');
  assert.equal(bytes[25], 6, 'asset is RGBA (has an alpha channel) — the white background is keyed out, not plated');

  assert.deepEqual(errors, [], 'no JS errors');
  console.log('PASS _shot-community-nav-v80 — drawer trimmed, Messages in Friends, Safety in Community settings, Featured artwork real & transparent');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
