'use strict';
// Screenshot helper (not an assertion suite): renders the LIVE page with a
// scheduled YouTube broadcast + preparing Twitch session for visual review.
const { chromium } = require('playwright');
const { randomBytes } = require('node:crypto');
const { pool } = require('../lib');
const base = 'http://127.0.0.1:3000';
(async () => {
  const b = await chromium.launch();
  const name = 'shot_' + randomBytes(4).toString('hex');
  let r = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, email: name + '@x.test', password: 'ShotTest123!' }) });
  const uid = (await r.json()).user.id;
  r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: name, password: 'ShotTest123!' }) });
  const tok = (await r.json()).session_token;
  r = await fetch(base + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify({ name: 'Showcase', drawing_app_key: 'krita', battle_type: 'none' }) });
  const code = (await r.json()).code;
  const roomRow = (await pool.query('SELECT id FROM battle_rooms WHERE code=$1', [code])).rows[0];
  await pool.query(`INSERT INTO youtube_broadcasts (user_id, room_id, youtube_broadcast_id, title, last_known_status, scheduled_start, watch_url) VALUES ($1,$2,$3,'Showcase battle — ROOM ${code}','scheduled', now()+interval '5 minutes', 'https://www.youtube.com/watch?v=showcase')`, [uid, roomRow.id, 'shot-bc-' + name]);
  await pool.query(`INSERT INTO twitch_stream_sessions (room_id, host_user_id, broadcaster_login, title, status) VALUES ($1,$2,$3,'Showcase battle — ROOM ${code}','preparing')`, [roomRow.id, uid, name]);

  const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
  await p.addInitScript((t) => sessionStorage.setItem('arena_session_token', t), tok);
  await p.goto(base);
  await p.waitForTimeout(1800);
  await p.evaluate(() => show('live'));
  await p.waitForTimeout(1200);
  await p.screenshot({ path: '/home/user/theme-previews/live-ui-dark.png', fullPage: true });
  await p.evaluate(() => { document.documentElement.setAttribute('data-theme', 'light'); });
  await p.waitForTimeout(400);
  await p.screenshot({ path: '/home/user/theme-previews/live-ui-light.png', fullPage: true });
  // flame ENTRY shot: fresh visitor with the persisted theme hint (a logged-in
  // account reconciles to its SAVED theme server-side, so the hint path is the
  // honest way to showcase the entry mark).
  const anon = await b.newPage({ viewport: { width: 1280, height: 900 } });
  await anon.addInitScript(() => localStorage.setItem('aa-ptheme', JSON.stringify({ key: 'flame' })));
  await anon.goto(base);
  await anon.waitForTimeout(650);
  await anon.screenshot({ path: '/home/user/theme-previews/flame-entry.png' });
  await anon.close();
  await p.waitForTimeout(600);
  // manga scene shot (SFX stickers mid-choreography)
  await p.evaluate(() => { applyPremiumTheme('comic', { finish: 'manga' }); show('arena'); });
  await p.waitForTimeout(1400);
  await p.screenshot({ path: '/home/user/theme-previews/manga-scene.png' });
  console.log('screenshots written');
  await b.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
