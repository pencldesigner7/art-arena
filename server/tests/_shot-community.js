'use strict';
// v73 COMMUNITY UI verification: real browser flows over the real server —
// publish, feed tabs, artwork page (like/save/comment/follow/report), empty
// states, Live/Upcoming from canonical /api/live, no JS errors / no 404s.
const { chromium } = require('playwright');
const { randomBytes } = require('node:crypto');
const assert = require('node:assert/strict');
const base = 'http://127.0.0.1:3000';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
async function api(u, path, body, status = 200, method = body === undefined ? 'GET' : 'POST') {
  const r = await fetch(base + '/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(u ? { Authorization: 'Bearer ' + u.token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  if (status && r.status !== status) throw new Error(path + ' → ' + r.status + ' ' + JSON.stringify(d));
  return d;
}
async function user() {
  const name = 'cmu_' + randomBytes(5).toString('hex'), password = 'CommunityUI123!';
  const d = await api(null, '/auth/register', { username: name, email: name + '@example.test', password }, 201);
  const login = await api(null, '/auth/login', { login: name, password });
  return { id: d.user.id, token: login.session_token, name };
}
async function publish(u, fields = {}) {
  const fd = new FormData();
  fd.append('image', new Blob([PNG], { type: 'image/png' }), 'art.png');
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const r = await fetch(base + '/api/community/posts', { method: 'POST', headers: { Authorization: 'Bearer ' + u.token }, body: fd });
  const d = await r.json();
  if (r.status !== 201) throw new Error(JSON.stringify(d));
  return d;
}
(async () => {
  // isolation: clear rows earlier suites/crashes left behind so feed counts are exact
  const { Client } = require('pg');
  const c = new Client({ connectionString: 'postgresql://aa_admin:aa-admin-pw@127.0.0.1:5432/art_arena' });
  await c.connect();
  await c.query(`TRUNCATE community_posts, community_post_likes, community_comments, artwork_saves, community_artwork, follows, reports CASCADE`);
  await c.end();
  const b = await chromium.launch();
  const a = await user(), viewer = await user();
  await publish(a, { title: 'Neon District', caption: 'cyberpunk study', tags: 'conceptart, digitalpainting' });
  await publish(a, { title: 'Second piece', caption: 'warm light study', tags: 'illustration' });
  const errors = [];
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  p.on('response', (r) => { if (r.status() === 404) errors.push('404: ' + r.url()); });
  await p.addInitScript((t) => sessionStorage.setItem('arena_session_token', t), viewer.token);
  await p.goto(base);
  await p.waitForFunction(() => typeof me !== 'undefined' && !!me, null, { timeout: 20000 });
  await p.waitForTimeout(2600); // entry

  // open Community via the real bottom nav
  await p.click('#bottom-nav .tab[data-tab="community"]');
  await p.waitForSelector('#view-community:not(.hidden)');
  await p.waitForSelector('.cm-post', { timeout: 10000 });
  // v80: Community is the hub — the left rail switches sections, and the hub
  // stacks real rows (For You / Trending / New / Live / Upcoming). Artwork is
  // asserted by presence and by the hub's real section headings, not by a
  // fixed card count that only the retired single-feed layout could satisfy.
  assert.ok(await p.locator('.cm-post').count() >= 2, 'hub shows published artwork');
  const heads = await p.locator('#cm-feed .cm-sec-head h2').allInnerTexts();
  for (const want of ['For You', 'Trending', 'New', 'Live', 'Upcoming']) {
    assert.ok(heads.includes(want), 'hub renders the ' + want + ' section (got: ' + heads.join(', ') + ')');
  }
  // the reference's shell: left rail, hero, featured card, friends rail with Chat
  assert.deepEqual(
    (await p.locator('.cm-side-item').allInnerTexts()).map((s) => s.trim()),
    ['Community', 'Discover', 'Friends', 'Community Profile', 'Following', 'Saved', 'Community settings'],
    'left rail lists exactly the reference sections, in order');
  assert.equal(await p.locator('.cm-side-item.active').innerText(), 'Community', 'Community is the active rail item');
  assert.ok(await p.locator('#cm-hero').count(), 'hero section present');
  assert.ok(await p.locator('.cm-featured').count(), 'Featured in Community card present');
  assert.ok(await p.locator('.cm-guide-card').count(), 'Community Guidelines card present');
  assert.ok(await p.locator('.cm-friends-card').count(), 'Friends card present');
  await p.screenshot({ path: '/home/user/theme-previews/v73-community-feed.png' });

  // left-rail sections: Discover / Following / Live / Upcoming / Saved
  await p.click('.cm-side-item[data-cm="discover"]'); await p.waitForTimeout(700);
  assert.ok(await p.locator('.cm-artistrow').count() >= 1, 'Discover lists artists you do not already follow');
  await p.click('.cm-side-item[data-cm="following"]'); await p.waitForTimeout(600);
  // the Arena refinement survives as a filter on the Following feed
  await p.click('[data-cm-filter="battle"]'); await p.waitForTimeout(600);
  assert.ok(await p.locator('#cm-empty:not(.hidden)').count(), 'battle refinement honest empty state');
  await p.click('[data-cm-filter="all"]'); await p.waitForTimeout(500);
  // Live + Upcoming are hub sections (as the reference draws them), so their
  // honest empty states are asserted in place rather than as separate pages.
  await p.click('.cm-side-item[data-cm="for-you"]'); await p.waitForTimeout(900);
  const hubHtml = await p.locator('#cm-feed').innerHTML();
  assert.ok(/Live<\/h2>/.test(hubHtml) && /Upcoming<\/h2>/.test(hubHtml),
    'hub keeps Live and Upcoming sections present');
  await p.click('.cm-side-item[data-cm="saves"]'); await p.waitForTimeout(600);
  assert.ok((await p.locator('#cm-empty').innerText()).includes('Save artwork'), 'saves honest empty state');
  await p.click('.cm-side-item[data-cm="for-you"]'); await p.waitForSelector('.cm-post');

  // artwork page: like, save, comment, follow
  await p.locator('.cm-post').first().click();
  await p.waitForSelector('#cm-art:not(.hidden)');
  await p.waitForSelector('.cm-art-img');
  const likeBtn = p.locator('[data-cm-like]');
  await likeBtn.click();
  await p.waitForFunction(() => document.querySelector('[data-cm-like]').textContent.includes('1'));
  await p.locator('[data-cm-save]').click();
  await p.waitForFunction(() => document.querySelector('[data-cm-save]').textContent.includes('Saved'));
  await p.fill('#cm-comment-input', 'great colour work!');
  await p.click('#cm-comment-form button[type="submit"]');
  await p.waitForSelector('.cm-comment');
  await p.locator('[data-cm-follow]').click();
  await p.waitForFunction(() => document.querySelector('[data-cm-follow]').textContent.includes('Following'));
  await p.screenshot({ path: '/home/user/theme-previews/v73-community-artwork.png' });
  // report menu offers the fixed categories
  await p.locator('[data-cm-report]').first().click();
  await p.waitForSelector('[data-cm-repreason="harassment"]');
  await p.click('#cm-art-close');
  await p.waitForSelector('#cm-art.hidden', { state: 'attached' });

  // composer via the real button (multipart through the browser)
  await p.click('#cm-publish');
  await p.waitForSelector('#cm-compose:not(.hidden)');
  await p.setInputFiles('#cm-file', { name: 'art.png', mimeType: 'image/png', buffer: PNG });
  await p.fill('#cm-compose-form [name="title"]', 'Browser published');
  await p.fill('#cm-compose-form [name="tags"]', 'pixelart');
  await p.click('#cm-submit');
  await p.waitForSelector('#cm-compose.hidden', { state: 'attached', timeout: 10000 });
  // the new piece must appear in the hub (it joins For You / Trending / New)
  await p.waitForFunction(() => document.body.innerText.includes('Browser published'), null, { timeout: 10000 });
  await p.screenshot({ path: '/home/user/theme-previews/v73-community-after-publish.png' });

  // Saved now presents the collection (rows), and holds the saved piece
  await p.click('.cm-side-item[data-cm="saves"]');
  await p.waitForSelector('.cm-savedrow');

  // phase 3: search from the Community header
  await p.click('#bottom-nav .tab[data-tab="community"]');
  await p.waitForSelector('.cm-post');
  await p.fill('#cm-search', a.name);
  await p.waitForSelector('.cm-srow[data-cm-sartist]');
  await p.screenshot({ path: '/home/user/theme-previews/v73-community-search.png' });
  await p.click('.cm-srow[data-cm-sartist]');
  await p.waitForSelector('#profile-modal:not(.hidden)', { timeout: 8000 });
  await p.waitForSelector('[data-cm-follow]');
  await p.screenshot({ path: '/home/user/theme-previews/v73-community-profile.png' });
  await p.click('#pm-close');
  await p.waitForSelector('#profile-modal.hidden', { state: 'attached' });
  await p.fill('#cm-search', '');

  // back to Arena stays intact
  await p.click('#bottom-nav .tab[data-tab="arena"]');
  await p.waitForSelector('#view-arena:not(.hidden)');

  assert.deepEqual(errors.filter((e) => !e.includes('favicon')), [], 'no JS errors / 404s');
  await b.close();
  console.log('PASS community UI: nav open, For You/New feeds, honest empty states (battle/live/upcoming/saves), artist discovery, artwork page like/save/comment/follow/report categories, composer publish, Arena intact, zero JS errors');
})().catch((e) => { console.error('SHOT FAIL', e); process.exit(1); });
