'use strict';
// Probe: chat composer (#msg-form / #msg-input) rendering per theme —
// rest state and typing state — for the Glowing line + Cloud/Graffiti look.
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
    headers: { 'Content-Type': 'application/json', ...(u ? { Authorization: 'Bearer ' + u.tok } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  if (status && r.status !== status) throw new Error(p + ' → ' + r.status + ' ' + JSON.stringify(d));
  return d;
}
async function user(name) {
  const pw = 'Studio!qa77';
  const d = await api(null, '/auth/register', { username: name, email: name + '@example.test', password: pw }, 201);
  const login = await api(null, '/auth/login', { login: name, password: pw });
  const key = Object.keys(login).find((k) => k.includes('tok'));
  return { id: d.user.id, tok: login[key], name };
}

(async () => {
  const t = randomBytes(3).toString('hex');
  const pal = await user('composer_pal_' + t);
  const viewer = await user('composer_fan_' + t);
  await api(viewer, '/premium/test-activate', {}, 200);
  const fr = await api(viewer, '/friends/request', { user_id: pal.id }, 201);
  const inbox = await api(pal, '/friends');
  const reqId = (inbox.incoming || inbox.requests || []).map((x) => x.id || x.request_id).find(Boolean) || fr.id || fr.request_id;
  await api(pal, '/friends/requests/' + reqId + '/accept', {}, 200);
  const thread = await api(viewer, '/messages/threads', { user_id: pal.id }, 201);
  const tid = thread.id || thread.thread_id || (thread.thread && thread.thread.id);
  await api(pal, '/messages/threads/' + tid + '/messages', { body: 'Composer check 🎨' }, 201);

  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 320, height: 700 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('pageerror:', e.message));
  await p.addInitScript((tok) => sessionStorage.setItem('arena_session_token', tok), viewer.tok);
  await p.goto(base);
  await p.waitForFunction(() => typeof me !== 'undefined' && !!me, null, { timeout: 20000 });
  await pause(1500);
  await p.evaluate(() => { if (typeof show === 'function') show('messages'); });
  await p.waitForSelector('[data-thread="' + tid + '"]', { timeout: 20000, state: 'attached' });
  await p.evaluate((id) => { const el = document.querySelector('[data-thread="' + id + '"]'); if (el) el.click(); }, tid);
  await p.waitForSelector('#msg-input >> visible=true', { timeout: 15000 });
  await pause(1200);

  for (const theme of ['cloud', 'graffiti', 'flame']) {
    await p.evaluate((k) => { if (k === 'default') delete document.body.dataset.ptheme; else document.body.dataset.ptheme = k; }, theme);
    await pause(600);
    // typing state
    await p.evaluate(() => { const i = document.querySelector('#msg-input'); i.focus(); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await p.keyboard.type('Typing here to check the space', { delay: 25 });
    await pause(900);
    const info = await p.evaluate(() => {
      const form = document.querySelector('#msg-form'); const inp = document.querySelector('#msg-input');
      const fcs = getComputedStyle(form); const ics = getComputedStyle(inp);
      const send = getComputedStyle(document.querySelector('#msg-send'));
      const emo = getComputedStyle(document.querySelector('#msg-emoji'));
      return {
        formBg: fcs.backgroundColor, inpShadow: ics.boxShadow,
        sendBg: send.backgroundColor, sendBgImg: send.backgroundImage.slice(0, 40), sendColor: send.color, sendRadius: send.borderRadius,
        emoBg: emo.backgroundColor, emoBgImg: emo.backgroundImage.slice(0, 40), emoColor: emo.color, emoRadius: emo.borderRadius,
      };
    });
    console.log(theme, JSON.stringify(info));
    await p.screenshot({ path: path.join(OUT, 'v82-composer320-' + theme + '.png') });
    // REST state: blurred & empty -> "Send a chat" placeholder
    await p.evaluate(() => { const i = document.querySelector('#msg-input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); i.blur(); });
    await pause(500);
    const rest = await p.evaluate(() => {
      const inp = document.querySelector('#msg-input');
      const ph = getComputedStyle(inp, '::placeholder');
      const form = getComputedStyle(document.querySelector('#msg-form'));
      return { phColor: ph.color, phOpacity: ph.opacity, formBg: form.backgroundColor, formH: Math.round(document.querySelector('#msg-form').getBoundingClientRect().height), inpScrollH: inp.scrollHeight, inpClientH: inp.clientHeight };
    });
    const geo = await p.evaluate(() => { const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), w: Math.round(b.width) }; }; return { form: r('#msg-form'), inp: r('#msg-input'), cluster: r('.aa-cluster'), send: r('#msg-send'), emo: r('#msg-emoji') }; });
    const meas = await p.evaluate(() => { const inp = document.querySelector('#msg-input'); const cs = getComputedStyle(inp); const cv = document.createElement('canvas').getContext('2d'); cv.font = cs.font; return { padR: cs.paddingRight, padL: cs.paddingLeft, clientW: inp.clientWidth, textW: Math.round(cv.measureText('Send a chat').width), font: cs.font }; });
    console.log(theme + ' MEAS', JSON.stringify(meas));
    console.log(theme + ' GEO', JSON.stringify(geo));
    console.log(theme + ' REST', JSON.stringify(rest));
    await p.screenshot({ path: path.join(OUT, 'v82-composer320-rest-' + theme + '.png') });
    await p.evaluate(() => { const i = document.querySelector('#msg-input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await pause(300);
  }
  await b.close();
  console.log('COMPOSER PROBE DONE');
})().catch((e) => { console.error(e); process.exit(1); });
