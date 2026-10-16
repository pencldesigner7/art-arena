'use strict';
// Probe: chat composer attachment cluster in its FLOATING state
// (#msg-form.ready) under each theme — are the icons visible?
const { chromium } = require('playwright');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const base = 'http://127.0.0.1:3000';
const OUT = path.join(__dirname, '..', '..', 'docs', 'shots-v81');
fs.mkdirSync(OUT, { recursive: true });
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
  await api(kaya, '/messages/threads/' + tid + '/messages', { body: 'Floating buttons check 🎨' }, 201);

  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('pageerror:', e.message));
  await p.addInitScript((tok) => sessionStorage.setItem('arena_session_token', tok), viewer.token);
  await p.goto(base);
  await p.waitForFunction(() => typeof me !== 'undefined' && !!me, null, { timeout: 20000 });
  await pause(1500);
  await p.evaluate(() => { if (typeof show === 'function') show('messages'); });
  await p.waitForSelector('[data-thread="' + tid + '"]', { timeout: 20000, state: 'attached' });
  await p.evaluate((id) => { const el = document.querySelector('[data-thread="' + id + '"]'); if (el) el.click(); }, tid);
  await p.waitForSelector('#msg-input >> visible=true', { timeout: 15000 });
  await pause(1200);

  for (const theme of ['flame', 'glowing', 'magazine', 'chrome', 'pixel', 'graffiti']) {
    await p.evaluate((k) => { document.body.dataset.ptheme = k; }, theme);
    await pause(500);
    // float the cluster: focus + type (JS focus; keyboard works everywhere)
    await p.evaluate(() => { const i = document.querySelector('#msg-input'); i.focus(); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await p.keyboard.type('hi', { delay: 30 });
    await pause(900);
    const probe = await p.evaluate(() => {
      const form = document.querySelector('#msg-form');
      const btn = document.querySelector('#msg-voice');
      const cs = getComputedStyle(btn);
      return {
        ready: form.classList.contains('ready'),
        color: cs.color, bg: cs.backgroundColor, bgImg: cs.backgroundImage.slice(0, 60),
      };
    });
    console.log(theme, JSON.stringify(probe));
    await p.screenshot({ path: path.join(OUT, 'v82-float-' + theme + '.png') });
    await p.evaluate(() => { const i = document.querySelector('#msg-input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await pause(300);
  }
  await b.close();
  console.log('PROBE DONE');
})().catch((e) => { console.error('PROBE FAIL:', e.message); process.exit(1); });
