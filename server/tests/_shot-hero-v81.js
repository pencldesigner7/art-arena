'use strict';
// v81 PHASE 3 — Community hero composition verification (real browser flows
// over the real server). Captures the hero in both its states (welcome caption
// with no posts / trending caption with a lead post), at phone/tablet/desktop
// widths, in Dark, Light and a premium theme, and proves the image-failure
// fallback keeps the hero usable. Usage: node tests/_shot-hero-v81.js [before|after]
const { chromium } = require('playwright');
const { randomBytes } = require('node:crypto');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = 'http://127.0.0.1:3000';
const prefix = (process.argv[2] || 'after').replace(/[^a-z0-9-]/gi, '');
const OUT = path.join(__dirname, '..', '..', 'docs', 'shots-v81');
fs.mkdirSync(OUT, { recursive: true });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR2mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

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
  const name = 'hr_' + randomBytes(5).toString('hex'), password = 'HeroShot123!';
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

async function openCommunity(p) {
  await p.addInitScript((t) => sessionStorage.setItem('arena_session_token', t), p.__token);
  await p.goto(base);
  await p.waitForFunction(() => typeof me !== 'undefined' && !!me, null, { timeout: 20000 });
  await p.waitForTimeout(2600); // entry animation, same settle as the other suites
  await p.click('#bottom-nav .tab[data-tab="community"]');
  await p.waitForSelector('#view-community:not(.hidden)');
  await p.waitForSelector('#cm-hero .cm-hero-body', { timeout: 10000 });
  await p.waitForTimeout(600);
}

async function heroContracts(p, { imgMode, expectKicker }) {
  // imgMode: 'full' = the composed hero (after) · 'off' = pre-change renderer
  // (no art layers yet — capture only) · 'fallback' = images deliberately failed
  const state = await p.evaluate(() => {
    const hero = document.querySelector('#cm-hero');
    const back = hero.querySelector('img.cm-hero-back');
    const cut = hero.querySelector('img.cm-hero-cut');
    const kicker = hero.querySelector('.cm-hero-kicker');
    const title = hero.querySelector('.cm-hero-title');
    return {
      plain: hero.classList.contains('plain'),
      backOk: !!back && back.naturalWidth > 0,
      cutOk: !!cut && cut.naturalWidth > 0,
      cutRatio: cut ? cut.clientWidth / cut.clientHeight : 0,
      cutVisible: !!cut && cut.getBoundingClientRect().width > 40,
      heroH: hero.getBoundingClientRect().height,
      kicker: kicker ? kicker.textContent.trim() : '',
      title: title ? title.textContent.trim() : '',
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  if (imgMode === 'full') {
    assert.equal(state.plain, false, 'hero must not be in fallback state');
    assert.equal(state.backOk, true, 'backdrop image must load');
    assert.equal(state.cutOk, true, 'colosseum cutout must load');
    assert.equal(state.cutVisible, true, 'cutout must be visible');
    // contain + width:auto must preserve the artwork's aspect ratio (700/633)
    assert.ok(Math.abs(state.cutRatio - 700 / 633) < 0.06, 'cutout must not be stretched: ratio ' + state.cutRatio.toFixed(3));
    assert.ok(state.heroH <= 340, 'hero must not dominate the page: ' + state.heroH + 'px');
  } else if (imgMode === 'fallback') {
    assert.equal(state.plain, true, 'failed images must switch the hero to .plain fallback');
    assert.ok(state.heroH > 120, 'fallback hero must keep its layout');
  }
  if (expectKicker) assert.equal(state.kicker, expectKicker, 'hero kicker');
  assert.ok(state.title.length > 0, 'hero title must render');
  assert.ok(state.overflow <= 1, 'no horizontal overflow (+' + state.overflow + 'px)');
  return state;
}

(async () => {
  // isolation: exact feed state regardless of what earlier suites left behind
  const { Client } = require('pg');
  const c = new Client({ connectionString: 'postgresql://aa_admin:aa-admin-pw@127.0.0.1:5432/art_arena' });
  await c.connect();
  await c.query(`TRUNCATE community_posts, community_post_likes, community_comments, artwork_saves, community_artwork, follows, reports CASCADE`);
  await c.end();

  const b = await chromium.launch();
  const errors = [];
  const shots = [];
  const a = await user(), viewer = await user();
  viewer.__token = viewer.token;

  // ---------- 1. WELCOME state (no posts) — desktop dark ----------
  let ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  let p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  p.on('response', (r) => { if (r.status() === 404) errors.push('404: ' + r.url()); });
  p.__token = viewer.token;
  await openCommunity(p);
  await heroContracts(p, { imgMode: prefix === 'after' ? 'full' : 'off', expectKicker: 'Art Arena™ Community' });
  await p.screenshot({ path: path.join(OUT, `${prefix}-01-hero-welcome-desktop-dark.png`) });
  await p.locator('#cm-hero').screenshot({ path: path.join(OUT, `${prefix}-02-hero-welcome-clip.png`) });
  shots.push('welcome desktop dark');

  // ---------- 2. TRENDING state (lead post) — desktop dark ----------
  await publish(a, { title: 'Colosseum Dreams', caption: 'arena study', tags: 'conceptart' });
  await publish(a, { title: 'Second piece', caption: 'light study', tags: 'illustration' });
  await p.reload();
  await p.waitForFunction(() => typeof me !== 'undefined' && !!me, null, { timeout: 20000 });
  await p.waitForTimeout(2600);
  await p.click('#bottom-nav .tab[data-tab="community"]');
  await p.waitForSelector('#cm-hero .cm-hero-body');
  await p.waitForTimeout(600);
  await heroContracts(p, { imgMode: prefix === 'after' ? 'full' : 'off', expectKicker: 'Trending in the Arena' });
  assert.ok((await p.locator('#cm-hero .cm-hero-sub').innerText()).includes('@'), 'trending caption keeps artist + counts');
  await p.screenshot({ path: path.join(OUT, `${prefix}-03-hero-trending-desktop-dark.png`) });
  // the hero caption is still a real control: clicking it opens the artwork
  await p.click('#cm-hero');
  await p.waitForSelector('.cm-overlay', { timeout: 5000 });
  await p.keyboard.press('Escape');
  await p.waitForTimeout(400);
  shots.push('trending desktop dark + click-through');

  // ---------- 3. TABLET ----------
  await p.setViewportSize({ width: 768, height: 1024 });
  await p.waitForTimeout(500);
  await heroContracts(p, { imgMode: prefix === 'after' ? 'full' : 'off', expectKicker: 'Trending in the Arena' });
  await p.screenshot({ path: path.join(OUT, `${prefix}-04-hero-trending-tablet.png`) });
  shots.push('trending tablet');

  // ---------- 4. MOBILE ----------
  await p.setViewportSize({ width: 375, height: 812 });
  await p.waitForTimeout(500);
  await heroContracts(p, { imgMode: prefix === 'after' ? 'full' : 'off', expectKicker: 'Trending in the Arena' });
  await p.screenshot({ path: path.join(OUT, `${prefix}-05-hero-trending-mobile375.png`) });
  shots.push('trending mobile 375');
  await p.setViewportSize({ width: 320, height: 700 });
  await p.waitForTimeout(400);
  await heroContracts(p, { imgMode: prefix === 'after' ? 'full' : 'off', expectKicker: 'Trending in the Arena' });
  await p.screenshot({ path: path.join(OUT, `${prefix}-06-hero-trending-mobile320.png`) });
  shots.push('trending mobile 320');
  await ctx.close();

  // ---------- 5. LIGHT MODE desktop ----------
  ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push('pageerror(light): ' + e.message));
  p.__token = viewer.token;
  await p.addInitScript(() => localStorage.setItem('aa-theme', 'light'));
  await openCommunity(p);
  await heroContracts(p, { imgMode: prefix === 'after' ? 'full' : 'off', expectKicker: 'Trending in the Arena' });
  await p.screenshot({ path: path.join(OUT, `${prefix}-07-hero-trending-desktop-light.png`) });
  shots.push('trending desktop light');
  await ctx.close();

  // ---------- 6. PREMIUM THEME (flame) ----------
  await api(viewer, '/premium/test-activate', {}, 200);
  const themes = await api(viewer, '/premium/themes');
  const key = (themes.themes || []).map((t) => (typeof t === 'string' ? t : t.key)).find((k) => k === 'flame') || 'flame';
  ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push('pageerror(flame): ' + e.message));
  p.__token = viewer.token;
  await p.addInitScript((k) => localStorage.setItem('aa-ptheme', JSON.stringify({ key: k, custom: null })), key);
  await openCommunity(p);
  await heroContracts(p, { imgMode: prefix === 'after' ? 'full' : 'off', expectKicker: 'Trending in the Arena' });
  await p.screenshot({ path: path.join(OUT, `${prefix}-08-hero-trending-desktop-flame.png`) });
  shots.push('trending desktop flame');
  await ctx.close();

  // ---------- 7. IMAGE-FAILURE FALLBACK (after only) ----------
  if (prefix === 'after') {
    ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
    p = await ctx.newPage();
    p.__token = viewer.token;
    await p.route(/community-hero-(backdrop|colosseum)/, (r) => r.abort());
    await openCommunity(p);
    await heroContracts(p, { imgMode: 'fallback', expectKicker: 'Trending in the Arena' });
    await p.screenshot({ path: path.join(OUT, `${prefix}-09-hero-image-failure-fallback.png`) });
    shots.push('image-failure fallback');
    await ctx.close();
  }

  await b.close();
  const realErrors = errors.filter((e) => !/community-hero/.test(e));
  assert.deepEqual(realErrors, [], 'no page/404 errors: ' + realErrors.join(' | '));
  console.log('PASS _shot-hero-v81 [' + prefix + ']: ' + shots.join(' · '));
  console.log('shots → ' + OUT);
})().catch((e) => { console.error('FAIL _shot-hero-v81 [' + prefix + ']:', e.message); process.exit(1); });
