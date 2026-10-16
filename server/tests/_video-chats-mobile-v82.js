'use strict';
// v82 chats video SUPPLEMENT — Cloud (desktop) + phone (Glowing, Graffiti).
// Self-seeded; robust thread opening (waits for the visible composer).
const { chromium } = require('playwright');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const base = 'http://127.0.0.1:3000';
const TMP = '/tmp/aa-chats-v82';
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
  await p.keyboard.press('Escape');
  await p.evaluate(() => { if (typeof show === 'function') show('messages'); });
  const row = '[data-thread="' + tid + '"]';
  await p.waitForSelector(row, { timeout: 20000, state: 'attached' });
  await pause(300);
  for (let attempt = 0; attempt < 3; attempt++) {
    await p.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.click(); }, row);
    try {
      await p.waitForSelector('#msg-input >> visible=true', { timeout: 6000 });
      await p.waitForSelector('.msg-bub', { timeout: 30000 }).catch(() => {});
      return;
    } catch (_) { await pause(800); }
  }
  throw new Error('thread composer never became visible');
}

(async () => {
  const t = randomBytes(3).toString('hex');
  const kaya = await user('kaya_ink_' + t);
  const viewer = await user('studio_fan_' + t);
  await api(viewer, '/premium/test-activate', {}, 200);
  const fr = await api(viewer, '/friends/request', { user_id: kaya.id }, 201);
  const inbox = await api(kaya, '/friends');
  const reqId = (inbox.incoming || inbox.requests || []).map((x) => x.id || x.request_id).find(Boolean) || fr.id || fr.request_id;
  await api(kaya, '/friends/requests/' + reqId + '/accept', {}, 200);
  const thread = await api(viewer, '/messages/threads', { user_id: kaya.id }, 201);
  const tid = thread.id || thread.thread_id || (thread.thread && thread.thread.id);
  for (const [u, body] of [
    [kaya, 'Your Night Glow piece is gorgeous 🔥 the rim light!!'],
    [viewer, 'Thank you! 🙏🏽 I struggled with the glow for days'],
    [kaya, 'It paid off. Rematch this weekend? I owe you one 😄'],
    [viewer, 'You are on. Loser posts their sketchbook page 🇳🇬'],
    [kaya, 'Deal 🤝 Bring your best inks'],
  ]) await api(u, '/messages/threads/' + tid + '/messages', { body }, 201);
  console.log('supplement seeded', tid);

  const b = await chromium.launch();
  // phone: glowing + graffiti
  const ctxB = await b.newContext({
    viewport: { width: 390, height: 844 },
    recordVideo: { dir: path.join(TMP, 'b'), size: { width: 390, height: 844 } },
  });
  const m = await ctxB.newPage();
  m.on('pageerror', (e) => console.log('mobile pageerror:', e.message));
  await m.addInitScript((tok) => sessionStorage.setItem('arena_session_token', tok), viewer.token);
  await m.goto(base);
  await m.waitForFunction(() => typeof me !== 'undefined' && !!me, null, { timeout: 20000 });
  await pause(1800);
  await openThread(m, tid);
  await pause(1800);
  await setTheme(m, 'glowing');
  await openThread(m, tid);
  await pause(1800);
  await setTheme(m, 'graffiti');
  await openThread(m, tid);
  await pause(2200);
  await ctxB.close();
  const vidB = await m.video().path();
  await b.close();
  fs.writeFileSync(path.join(TMP, 'mobile.json'), JSON.stringify({ b: vidB }));
  console.log('MOBILE PART:', vidB);
})().catch((e) => { console.error('FAIL supp:', e.message); process.exit(1); });
