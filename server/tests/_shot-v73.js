'use strict';
// v73 visual verification (helper, not an assertion suite): 13 real-app
// screenshots — six themed UIs with FULL logos, Settings Comic/Manga
// previews, Comic-vs-Manga pop art, 3v3 6/6, post-leave auto-search,
// Help without numbers, entry brandmark context.
const { chromium } = require('playwright');
const { randomBytes } = require('node:crypto');
const assert = require('node:assert/strict');
const base = 'http://127.0.0.1:3000';
const OUT = '/home/user/theme-previews';
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
  const name = 'v73_' + randomBytes(6).toString('hex'), password = 'V73Shots123!';
  const d = await api(null, '/auth/register', { username: name, email: name + '@example.test', password }, 201);
  const login = await api(null, '/auth/login', { login: name, password });
  return { id: d.user.id, token: login.session_token, name };
}
(async () => {
  const b = await chromium.launch();
  const me = await user();
  await api(me, '/premium/test-activate', {});

  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await p.addInitScript((t) => sessionStorage.setItem('arena_session_token', t), me.token);
  const settle = async () => { // entry finishes → app visible
    await p.waitForFunction(() => {
      const e = document.getElementById('aa-entry');
      return typeof me !== 'undefined' && !!me && (!e || getComputedStyle(e).visibility === 'hidden');
    }, null, { timeout: 20000 });
    await p.waitForTimeout(350);
  };

  // ---- 1-6: FULL logos in each themed UI (home view, real app chrome)
  const THEMES = [
    ['chrome', null, '/themes/chrome.png', 'v73-01-chrome-fulllogo.png'],
    ['cloud', null, '/themes/cloud.png', 'v73-02-cloud-fulllogo.png'],
    ['comic', null, '/themes/comic.png', 'v73-03-comic-fulllogo.png'],
    ['glowing', null, '/themes/glowing.png', 'v73-04-glowing-fulllogo.png'],
    ['glitch', null, '/themes/glitch.png', 'v73-05-glitch-fulllogo.png'],
    ['comic', { finish: 'manga' }, '/themes/comic-manga.png', 'v73-06-manga-fulllogo.png'],
  ];
  for (const [theme, custom, expectSrc, file] of THEMES) {
    await api(me, '/premium/theme', { theme, ...(custom ? { custom } : {}) }, 200, 'PUT');
    await p.goto(base); await settle();
    await p.evaluate(() => show('arena')); // the home view IS 'arena'
    await p.waitForTimeout(500);
    const src = await p.locator('.home-logo img').first().getAttribute('src');
    assert.ok(src && src.includes(expectSrc.replace('/themes/', '')), `${theme}: home logo must be the FULL logo (${src})`);
    await p.screenshot({ path: `${OUT}/${file}` });
    console.log('shot', file, '←', src);
  }

  // ---- 7-8: Settings preview always equals the ACTIVE theme
  const settingsShot = async (file) => {
    await p.evaluate(() => show('settings'));
    await p.waitForSelector('#settings-theme-grid [data-settings-theme]', { timeout: 10000 });
    await p.waitForTimeout(700); // let the tint pass finish
    const comicSrc = await p.locator('img[data-swatch-logo="comic"]').getAttribute('src');
    await p.locator('#settings-theme-grid').screenshot({ path: `${OUT}/${file}` });
    console.log('shot', file, 'comic-card ←', comicSrc);
    return comicSrc;
  };
  // finish is sticky server-side (by design, tested in manga-variant) — ask
  // for the Comic finish explicitly after the Manga shot above.
  await api(me, '/premium/theme', { theme: 'comic', custom: { finish: 'comic' } }, 200, 'PUT');
  await p.goto(base); await settle();
  const s1 = await settingsShot('v73-07-settings-comic.png');
  assert.ok(s1.includes('/themes/comic.png') && !s1.includes('manga'), 'Comic active → card shows Comic logo');
  await api(me, '/premium/theme', { theme: 'comic', custom: { finish: 'manga' } }, 200, 'PUT');
  await p.goto(base); await settle();
  const s2 = await settingsShot('v73-08-settings-manga.png');
  assert.ok(s2.includes('comic-manga.png'), 'Manga active → card shows the Manga wordmark, never Comic');

  // ---- 9: Comic vs Manga pop art — same composition, different art
  const sceneShot = async (finish, file) => {
    await p.evaluate((f) => applyPremiumTheme('comic', { finish: f }), finish);
    await p.waitForSelector('.aa-comic-scene img', { timeout: 8000 });
    await p.waitForTimeout(900); // mid-cycle: stickers visible
    await p.locator('.aa-comic-scene').screenshot({ path: `${OUT}/${file}` });
    const anim = await p.locator('.aa-comic-scene img').first().evaluate((e) => getComputedStyle(e).animationName + ' ' + getComputedStyle(e).animationDuration);
    console.log('shot', file, 'anim:', anim);
    return anim;
  };
  const aC = await sceneShot('comic', 'v73-09a-popart-comic.png');
  const aM = await sceneShot('manga', 'v73-09b-popart-manga.png');
  assert.equal(aC, aM, 'Manga mirrors Comic choreography exactly');

  // ---- 10-11: 3v3 6/6, then a leave → honest auto-search
  // Same hygiene as the autofill suite: partial lobbies from crashed runs
  // would legitimately absorb the first entrant — end them first.
  const { pool } = require('../lib');
  await pool.query(`UPDATE battle_rooms SET status='ended', ended_at=now()
    WHERE battle_mode='3v3' AND status='lobby' AND deleted_at IS NULL
      AND (SELECT count(*) FROM room_participants p WHERE p.room_id=battle_rooms.id AND p.state IN ('waiting','ready')) < 6`);
  await pool.query(`UPDATE matchmaking_queue SET status='cancelled'
    WHERE status='queued' AND prefs->>'battle_mode'='3v3'`);
  const six = [me]; for (let i = 0; i < 5; i++) six.push(await user());
  let code = null;
  for (const u of six) { const r = await api(u, '/matchmaking/enter', { mode: '3v3' }); if (r.matched) code = r.room; }
  assert.ok(code, '3v3 room formed');
  await p.evaluate((c) => openRoom(c), code);
  await p.waitForFunction((c) => lastRoomData && lastRoomData.code === c, code, { timeout: 10000 });
  await p.waitForFunction(() => lastRoomData.players.length === 6, null, { timeout: 10000 });
  await p.waitForTimeout(700);
  await p.screenshot({ path: `${OUT}/v73-10-3v3-full.png` });
  console.log('shot v73-10 (6/6)');
  await api(six[5], `/rooms/${code}/leave`, {}); // one artist leaves
  await p.waitForFunction(() => lastRoomData.players.length === 5, null, { timeout: 10000 });
  await p.waitForTimeout(900);
  const hint = await p.locator('#room-hint').innerText();
  assert.ok(/searching for 1 replacement/i.test(hint), 'auto-search hint visible: ' + hint);
  await p.screenshot({ path: `${OUT}/v73-11-3v3-searching.png` });
  console.log('shot v73-11 (searching) hint:', hint.slice(0, 90));

  // ---- 12: Help — cards without numbers
  await p.evaluate(() => show('help'));
  await p.waitForSelector('#view-help:not(.hidden)');
  await p.waitForTimeout(400);
  assert.equal(await p.locator('.help-cat-n').count(), 0, 'no numeric labels remain');
  assert.equal(await p.locator('.help-cat').count(), 12, 'all 12 cards intact');
  await p.screenshot({ path: `${OUT}/v73-12-help-no-numbers.png`, fullPage: true });
  console.log('shot v73-12 (help clean)');

  // ---- 13: brandmark contexts intact — entry mark + favicon (Manga theme)
  const p2 = await (await b.newContext({ viewport: { width: 1280, height: 820 } })).newPage();
  await p2.addInitScript((t) => sessionStorage.setItem('arena_session_token', t), me.token);
  await p2.goto(base);
  await p2.waitForSelector('#aa-entry img', { timeout: 8000 });
  await p2.waitForTimeout(700); // mid-entry: brandmark visible
  const entrySrc = await p2.locator('#aa-entry img').first().getAttribute('src');
  const icon = await p2.locator('link[rel="icon"]').getAttribute('href');
  assert.ok(entrySrc.includes('/themes/marks/comic-manga.png'), 'entry uses the brandmark: ' + entrySrc);
  assert.ok(icon.includes('comic-manga-icon'), 'favicon uses the brandmark icon: ' + icon);
  await p2.locator('#aa-entry').screenshot({ path: `${OUT}/v73-13-entry-brandmark.png` });
  console.log('shot v73-13 (entry brandmark) ←', entrySrc, icon);

  await b.close();

  // Post-hygiene: scenario 11 INTENTIONALLY leaves a 5/6 room searching for a
  // replacement. Later suites that assert "a partial 3v3 queue never matches"
  // (room-regressions) would legitimately absorb their first entrant into it,
  // so this suite must not hand that room over. Same two statements as the
  // pre-run hygiene above.
  await pool.query(`UPDATE battle_rooms SET status='ended', ended_at=now()
    WHERE battle_mode='3v3' AND status='lobby' AND deleted_at IS NULL
      AND (SELECT count(*) FROM room_participants p WHERE p.room_id=battle_rooms.id AND p.state IN ('waiting','ready')) < 6`);
  await pool.query(`UPDATE matchmaking_queue SET status='cancelled'
    WHERE status='queued' AND prefs->>'battle_mode'='3v3'`);

  console.log('DONE — 13 v73 visual verifications captured in ' + OUT);
})().catch((e) => { console.error('SHOT FAIL', e); process.exit(1); });
