'use strict';
// v82 VIDEO — chats (Messages) in EVERY UI theme. Seeds a real DM thread,
// then walks all themes: default, Flame, Glowing, Pixel, Graffiti,
// Magazine, Glitch, Chrome, Comic, Cloud — opening the same conversation
// in each and sending a message so bubbles/composer render per theme.
// Ends with a short phone segment. Raw video lands in /tmp only; the
// caller encodes the final MP4. Usage: node tests/_video-chats-v82.js
const { chromium } = require('playwright');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const base = 'http://127.0.0.1:3000';
const TMP = '/tmp/aa-chats-v82';
fs.mkdirSync(TMP, { recursive: true });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

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
async function user(name) {
  const password = '[SECURITY_DATA]';
  const d = await api(null, '/auth/register', { username: name, email: name + '@example.test', password }, 201);
  const login = await api(null, '/auth/login', { login: name, password });
  return { id: d.user.id, token: login.session_token, name };
}
async function setTheme(p, key) {
  await p.keyboard.press('Escape');
  await pause(250);
  await p.click('#btn-menu');
  await p.waitForSelector('#drawer-nav [data-view="settings"]', { timeout: 6000 });
  await pause(500);
  await p.click('#drawer-nav [data-view="settings"]');
  await p.waitForSelector('#settings-theme-grid .theme-swatch', { timeout: 8000 });
  await pause(600);
  await p.click('#settings-theme-grid [data-settings-theme="' + key + '"]');
  await pause(1400);
}
async function openThread(p, tid) {
  await p.evaluate(() => { if (typeof show === 'function') show('messages'); });
  await pause(1000);
  await p.evaluate((id) => {
    const el = document.querySelector('[data-thread="' + id + '"]');
    if (el) el.click();
  }, tid);
  await pause(1300);
}

(async () => {
  const t = randomBytes(3).toString('hex');
  const kaya = await user('kaya_ink_' + t);
  const viewer = await user('studio_fan_' + t);
  await api(viewer, '/premium/test-activate', {}, 200);
  const art = path.join(__dirname, '..', 'public', 'themes');
  // one community post so names/avatars feel lived-in
  {
    const fd = new FormData();
    fd.append('image', new Blob([fs.readFileSync(path.join(art, 'glowing.png'))], { type: 'image/png' }), 'art.png');
    fd.append('title', 'Night Glow'); fd.append('caption', 'light finds a way');
    const r = await fetch(base + '/api/community/posts', { method: 'POST', headers: { Authorization: 'Bearer ' + kaya.token }, body: fd });
    if (r.status !== 201) throw new Error('seed post failed');
  }
  const fr = await api(viewer, '/friends/request', { user_id: kaya.id }, 201);
  const inbox = await api(kaya, '/friends');
  const reqId = (inbox.incoming || inbox.requests || []).map((x) => x.id || x.request_id).find(Boolean) || fr.id || fr.request_id;
  await api(kaya, '/friends/requests/' + reqId + '/accept', {}, 200);
  const thread = await api(viewer, '/messages/threads', { user_id: kaya.id }, 201);
  const tid = thread.id || thread.thread_id || (thread.thread && thread.thread.id);
  const script = [
    [kaya, 'Your Night Glow piece is gorgeous 🔥 the rim light!!'],
    [viewer, 'Thank you! 🙏🏽 I struggled with the glow for days'],
    [kaya, 'It paid off. Rematch this weekend? I owe you one 😄'],
    [viewer, 'You are on. Loser posts their sketchbook page 🇳🇬'],
    [kaya, 'Deal 🤝 Bring your best inks'],
  ];
  for (const [u, body] of script) await api(u, '/messages/threads/' + tid + '/messages', { body }, 201);
  console.log('chat seeded, thread', tid);

  const b = await chromium.launch();

  // ---------------- desktop: all themes ------------------------------------
  const ctxA = await b.newContext({
    viewport: { width: 1280, height: 812 },
    recordVideo: { dir: path.join(TMP, 'a'), size: { width: 1280, height: 812 } },
  });
  const p = await ctxA.newPage();
  p.on('pageerror', (e) => console.log('pageerror:', e.message));
  await p.addInitScript((tok) => sessionStorage.setItem('arena_session_token', tok), viewer.token);
  await p.goto(base);
  await p.waitForFunction(() => typeof me !== 'undefined' && !!me, null, { timeout: 20000 });
  await pause(2400);
  await openThread(p, tid);
  await pause(2200);

  const THEMES = [
    ['default', 'Art Arena (default)'], ['flame', 'Flame'], ['glowing', 'Glowing'],
    ['pixel', 'Pixel'], ['graffiti', 'Graffiti'], ['magazine', 'Magazine'],
    ['glitch', 'Glitch'], ['chrome', 'Chrome'], ['comic', 'Comic'], ['cloud', 'Cloud'],
  ];
  for (const [key, label] of THEMES) {
    if (key !== 'default') await setTheme(p, key);
    await openThread(p, tid);
    await pause(700);
    await p.evaluate(() => { const s = document.querySelector('#msg-scroll'); if (s) s.scrollTop = 0; });
    await pause(900);
    await p.evaluate(() => { const s = document.querySelector('#msg-scroll'); if (s) s.scrollTop = s.scrollHeight; });
    await pause(900);
    await p.type('#msg-input', 'Chatting in the ' + label + ' theme ✨', { delay: 45 });
    await pause(500);
    await p.click('#msg-send');
    await pause(1700);
    console.log('theme pass:', label);
  }
  await ctxA.close();
  const vidA = await p.video().path();

  // ---------------- phone: two themes --------------------------------------
  const ctxB = await b.newContext({
    viewport: { width: 390, height: 844 },
    recordVideo: { dir: path.join(TMP, 'b'), size: { width: 390, height: 844 } },
  });
  const m = await ctxB.newPage();
  m.on('pageerror', (e) => console.log('mobile pageerror:', e.message));
  await m.addInitScript((tok) => sessionStorage.setItem('arena_session_token', tok), viewer.token);
  await m.goto(base);
  await m.waitForFunction(() => typeof me !== 'undefined' && !!me, null, { timeout: 20000 });
  await pause(2000);
  await openThread(m, tid);
  await pause(2000);
  await setTheme(m, 'glowing');
  await openThread(m, tid);
  await pause(2000);
  await setTheme(m, 'graffiti');
  await openThread(m, tid);
  await pause(2200);
  await ctxB.close();
  const vidB = await m.video().path();
  await b.close();

  fs.writeFileSync(path.join(TMP, 'parts.json'), JSON.stringify({ a: vidA, b: vidB }));
  console.log('RAW PARTS:', vidA, '|', vidB);
})().catch((e) => { console.error('FAIL chats video:', e.message); process.exit(1); });
