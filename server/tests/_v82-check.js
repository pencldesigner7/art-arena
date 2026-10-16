'use strict';
// v82 verification: faded-into-backdrop Colosseum (computed opacity), mobile
// Community Friends rows keep the desktop single-row layout, and the
// "Chat works whether..." copy is gone from the rendered page.
const { chromium } = require('playwright');
const { randomBytes } = require('node:crypto');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = 'http://127.0.0.1:3000';
const OUT = path.join(__dirname, '..', '..', 'docs', 'shots-v81');
fs.mkdirSync(OUT, { recursive: true });

async function api(u, p, body, status = 200, method = body === undefined ? 'GET' : 'POST') {
  const r = await fetch(base + '/api' + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(u ? { Authorization: 'Bearer ' + u.token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  if (status && r.status !== status) throw new Error(p + ' → ' + r.status + ' ' + JSON.stringify(d));
  return d;
}
async function user() {
  const name = 'v82' + randomBytes(4).toString('hex'), password = '[SECURITY_DATA]';
  const d = await api(null, '/auth/register', { username: name, email: name + '@example.test', password }, 201);
  const login = await api(null, '/auth/login', { login: name, password });
  return { id: d.user.id, token: login.session_token, name };
}

(async () => {
  const A = await user(), B = await user(), C = await user();
  for (const f of [B, C]) {
    const fr = await api(A, '/friends/request', { user_id: f.id }, 201);
    const inbox = await api(f, '/friends');
    const reqId = (inbox.incoming || inbox.requests || []).map((x) => x.id || x.request_id).find(Boolean) || fr.id || fr.request_id;
    await api(f, '/friends/requests/' + reqId + '/accept', {}, 200);
  }
  const art = path.join(__dirname, '..', 'public', 'themes', 'flame.png');
  const fd = new FormData();
  fd.append('image', new Blob([fs.readFileSync(art)], { type: 'image/png' }), 'art.png');
  fd.append('title', 'Ember Study');
  const pr = await fetch(base + '/api/community/posts', { method: 'POST', headers: { Authorization: 'Bearer ' + B.token }, body: fd });
  assert.equal(pr.status, 201, 'seed post');

  const browser = await chromium.launch();
  const errors = [];
  // desktop look (reference) + hero
  const desk = await browser.newContext({ viewport: { width: 1280, height: 812 } });
  const dp = await desk.newPage();
  dp.on('pageerror', (e) => errors.push('desktop: ' + e.message));
  await dp.addInitScript((t) => sessionStorage.setItem('arena_session_token', t), A.token);
  await dp.goto(base);
  await dp.waitForFunction(() => typeof me !== 'undefined' && !!me, null, { timeout: 20000 });
  await dp.waitForTimeout(1500);
  await dp.click('#bottom-nav .tab[data-tab="community"]');
  await dp.waitForSelector('#cm-hero .cm-hero-body');
  await dp.waitForTimeout(1500);
  const cut = await dp.evaluate(() => {
    const img = document.querySelector('#cm-hero img.cm-hero-cut');
    return img ? { opacity: getComputedStyle(img).opacity, nw: img.naturalWidth } : null;
  });
  assert.ok(cut && cut.nw > 0, 'colosseum layer loads');
  assert.equal(cut.opacity, '0.5', 'colosseum faded into backdrop (opacity .5): ' + JSON.stringify(cut));
  await dp.screenshot({ path: path.join(OUT, 'v82-hero-desktop.png') });
  await dp.click('[data-cm="friends"]');
  await dp.waitForTimeout(1400);
  await dp.screenshot({ path: path.join(OUT, 'v82-friends-desktop.png') });

  // mobile
  const mob = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const mp = await mob.newPage();
  mp.on('pageerror', (e) => errors.push('mobile: ' + e.message));
  await mp.addInitScript((t) => sessionStorage.setItem('arena_session_token', t), A.token);
  await mp.goto(base);
  await mp.waitForFunction(() => typeof me !== 'undefined' && !!me, null, { timeout: 20000 });
  await mp.waitForTimeout(1200);
  await mp.click('#bottom-nav .tab[data-tab="community"]');
  await mp.waitForSelector('#cm-hero .cm-hero-body');
  await mp.waitForTimeout(1200);
  await mp.screenshot({ path: path.join(OUT, 'v82-hero-mobile375.png') });
  await mp.click('[data-cm="friends"]');
  await mp.waitForTimeout(1400);
  const layout = await mp.evaluate(() => {
    const row = document.querySelector('#cm-feed.cm-friends .fr-row');
    if (!row) return null;
    const name = row.querySelector('.fr-name').getBoundingClientRect();
    const acts = row.querySelector('.fr-actions').getBoundingClientRect();
    return {
      rowH: row.getBoundingClientRect().height,
      sameLine: Math.abs((name.top + name.height / 2) - (acts.top + acts.height / 2)) < 14,
      actionsRight: acts.right > window.innerWidth - 40,
      overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
      note: (document.querySelector('#cm-feed') || {}).textContent.includes('whether'),
    };
  });
  assert.ok(layout, 'friend rows render on mobile');
  assert.ok(layout.sameLine, 'mobile: name and actions share one row (desktop layout): ' + JSON.stringify(layout));
  assert.ok(layout.actionsRight, 'mobile: actions pinned right');
  assert.ok(layout.overflow, 'mobile: no horizontal overflow');
  assert.equal(layout.note, false, '"whether" copy gone');
  await mp.screenshot({ path: path.join(OUT, 'v82-friends-mobile375.png') });
  await mp.setViewportSize({ width: 320, height: 760 });
  await mp.waitForTimeout(700);
  const l320 = await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  assert.ok(l320, 'no overflow @320');
  await mp.screenshot({ path: path.join(OUT, 'v82-friends-mobile320.png') });

  assert.equal(errors.length, 0, 'no page errors: ' + JSON.stringify(errors));
  await browser.close();
  console.log('V82 CHECK: PASS', JSON.stringify({ cut, layout }));
})().catch((e) => { console.error('V82 CHECK: FAIL —', e.message); process.exit(1); });
