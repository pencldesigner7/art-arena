'use strict';
// v74 — Manga Settings + logo sizing: finish-matched backgrounds, persistence,
// refresh, chrome/gold consistency, proportional prominent logos.
const { chromium } = require('playwright');
const { randomBytes } = require('node:crypto');
const assert = require('node:assert/strict');
const base = 'http://127.0.0.1:3000';
async function api(u, path, body, status = 200, method = body === undefined ? 'GET' : 'POST') {
  const r = await fetch(base + '/api' + path, {
    method, headers: { 'Content-Type': 'application/json', ...(u ? { Authorization: 'Bearer ' + u.token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  if (status && r.status !== status) throw new Error(path + ' → ' + r.status + ' ' + JSON.stringify(d));
  return d;
}
async function user() {
  const name = 'sv_' + randomBytes(5).toString('hex'), password = 'SettingsV74x123!';
  const d = await api(null, '/auth/register', { username: name, email: name + '@example.test', password }, 201);
  const login = await api(null, '/auth/login', { login: name, password });
  return { id: d.user.id, token: login.session_token, name };
}
(async () => {
  const u = await user();
  await api(u, '/premium/test-activate', {}, 200);
  await api(u, '/premium/theme', { theme: 'comic', custom: { finish: 'manga' } }, 200, 'PUT');

  const b = await chromium.launch();
  const errors = [];
  const ctx = await b.newContext({ viewport: { width: 1100, height: 800 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  p.on('response', (r) => { if (r.status() === 404) errors.push('404: ' + r.url()); });
  await p.addInitScript((t) => sessionStorage.setItem('arena_session_token', t), u.token);
  await p.goto(base);
  await p.waitForFunction(() => typeof me !== 'undefined' && !!me, null, { timeout: 20000 });
  await p.waitForTimeout(2000);

  // opening Settings directly with Manga active → correct logo + background at once
  await p.click('#btn-menu');
  await p.click('#drawer-nav [data-view="settings"]');
  await p.waitForSelector('#settings-theme-grid .theme-swatch');
  await p.waitForSelector('.swatch-logo.sl-comic.is-manga');
  const src1 = await p.getAttribute('img[data-swatch-logo="comic"]', 'src');
  assert.ok(src1.includes('comic-manga.png'), 'Manga wordmark on the Comic card: ' + src1);

  // logo prominence: the visible artwork must be large, not a tiny icon
  const box = await p.locator('img[data-swatch-logo="comic"]').boundingBox();
  assert.ok(box && box.height >= 40, 'manga logo rendered prominently (h=' + (box && box.height) + ')');
  assert.ok(box && box.width >= 80, 'manga wordmark uses the card width (w=' + (box && box.width) + ')');
  await p.screenshot({ path: '/home/user/theme-previews/v74-settings-manga.png', fullPage: true });

  // switching to plain Comic updates logo AND background together
  await p.click('#settings-theme-grid [data-settings-theme="comic"]'); // reselect comic
  await p.waitForSelector('#comic-finish:not(.hidden)');
  await p.click('#comic-finish [data-comic-finish="comic"]');
  await p.waitForFunction(() => !document.querySelector('.swatch-logo.sl-comic')?.classList.contains('is-manga'));
  const src2 = await p.getAttribute('img[data-swatch-logo="comic"]', 'src');
  assert.ok(src2.includes('/themes/comic.png'), 'Comic logo restored: ' + src2);

  // back to Manga restores both
  await p.click('#comic-finish [data-comic-finish="manga"]');
  await p.waitForSelector('.swatch-logo.sl-comic.is-manga');

  // refresh keeps Manga
  await p.reload();
  await p.waitForFunction(() => typeof me !== 'undefined' && !!me, null, { timeout: 20000 });
  await p.click('#btn-menu');
  await p.click('#drawer-nav [data-view="settings"]');
  await p.waitForSelector('.swatch-logo.sl-comic.is-manga');
  const src3 = await p.getAttribute('img[data-swatch-logo="comic"]', 'src');
  assert.ok(src3.includes('comic-manga.png'), 'Manga persists after refresh');

  // Chrome/Gold consistency: logo + card background travel together
  await p.click('#settings-theme-grid [data-settings-theme="chrome"]');
  await p.waitForSelector('#chrome-finish:not(.hidden)');
  await p.click('#chrome-finish [data-chrome-finish="gold"]');
  await p.waitForSelector('.swatch-logo.sl-chrome.is-gold');
  const gsrc = await p.getAttribute('img[data-swatch-logo="chrome"]', 'src');
  assert.ok(gsrc.includes('chrome-gold.png'), 'Gold logo on gold card: ' + gsrc);
  await p.click('#chrome-finish [data-chrome-finish="chrome"]');
  await p.waitForFunction(() => !document.querySelector('.swatch-logo.sl-chrome')?.classList.contains('is-gold'));

  // every card logo is prominent + contained (never stretched/clipped)
  const sizes = await p.evaluate(() => [...document.querySelectorAll('#settings-theme-grid .sw-logo-img')].map((img) => {
    const r = img.getBoundingClientRect();
    const ar = img.naturalWidth / img.naturalHeight, rr = r.width / Math.max(1, r.height);
    return { k: img.dataset.swatchLogo, w: Math.round(r.width), h: Math.round(r.height), ok: Math.abs(ar - rr) < 0.12 && r.height >= 24 };
  }));
  for (const s of sizes) assert.ok(s.ok, `logo ${s.k} proportional + visible (${s.w}x${s.h})`);
  await p.screenshot({ path: '/home/user/theme-previews/v74-settings-cards.png', fullPage: true });

  assert.deepEqual(errors.filter((e) => !e.includes('favicon')), [], 'no JS errors / 404s');
  await b.close();
  console.log('PASS settings v74: manga bg+logo travel together (open/switch/return/refresh), chrome/gold consistent, logos prominent + undistorted');
})().catch((e) => { console.error('SHOT FAIL', e); process.exit(1); });
