'use strict';
const { chromium } = require('playwright');
const { randomBytes } = require('node:crypto');
const base = 'http://127.0.0.1:3000';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(u, p, body, status = 200, method = body === undefined ? 'GET' : 'POST') {
  const r = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(u ? { Authorization: 'Bearer ' + u.token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let d = null; try { d = await r.json(); } catch (_) {}
  if (status && r.status !== status) throw new Error(p + ' → ' + r.status);
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
  await api(kaya, '/messages/threads/' + tid + '/messages', { body: 'probe hello' }, 201);

  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1280, height: 812 } })).newPage();
  p.on('pageerror', (e) => console.log('pageerror:', e.message));
  p.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text().slice(0, 200)); });
  await p.addInitScript((tok) => sessionStorage.setItem('arena_session_token', tok), viewer.token);
  await p.goto(base);
  await p.waitForFunction(() => typeof me !== 'undefined' && !!me, null, { timeout: 20000 });
  await pause(2000);
  // theme first, like the failing path
  await p.click('#btn-menu');
  await p.waitForSelector('#drawer-nav [data-view="settings"]', { timeout: 6000 });
  await pause(400);
  await p.click('#drawer-nav [data-view="settings"]');
  await p.waitForSelector('#settings-theme-grid .theme-swatch', { timeout: 8000 });
  await pause(500);
  await p.click('#settings-theme-grid [data-settings-theme="cloud"]');
  await pause(1500);
  await p.evaluate(() => {
    window.__rej = [];
    window.addEventListener('unhandledrejection', (e) => window.__rej.push(String(e.reason && e.reason.message || e.reason)));
    if (typeof show === 'function') show('messages');
  });
  await pause(3500);
  console.log('after show(messages):', await p.evaluate(async () => {
    const r = await fetch('/api/messages/threads', { headers: { Authorization: 'Bearer ' + sessionStorage.getItem('arena_session_token') } });
    const d = await r.json().catch(() => null);
    return {
      apiStatus: r.status, apiThreads: d && d.threads ? d.threads.length : JSON.stringify(d).slice(0, 120),
      listHTML: (document.querySelector('#msg-list') || { innerHTML: '?' }).innerHTML.slice(0, 160),
      rows: document.querySelectorAll('[data-thread]').length,
      rej: window.__rej,
    };
  }));
  await p.evaluate((id) => { const el = document.querySelector('[data-thread="' + id + '"]'); console.log('clicking', !!el); if (el) el.click(); }, tid);
  await pause(2000);
  console.log('after row click:', await p.evaluate(() => ({
    threadHidden: document.querySelector('#msg-thread').className,
    inputVisible: !!document.querySelector('#msg-input') && document.querySelector('#msg-input').offsetParent !== null,
    bubbles: document.querySelectorAll('.msg-bub').length,
  })));
  const cover = await p.evaluate(() => {
    const inp = document.querySelector('#msg-input');
    const r = inp.getBoundingClientRect();
    const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { rect: { x: r.x, y: r.y, w: r.width, h: r.height }, hit: el ? (el.id || el.className || el.tagName) : null, same: el === inp };
  });
  console.log('composer hit-test:', JSON.stringify(cover));
  await pause(4000);
  console.log('bubbles after 4s:', await p.evaluate(() => document.querySelectorAll('.msg-bub').length));
  try {
    await p.evaluate(() => document.querySelector('#msg-input').focus());
    await p.keyboard.type('probe typing in cloud', { delay: 40 });
    console.log('KEYBOARD TYPE OK, value =', await p.evaluate(() => document.querySelector('#msg-input').value));
  } catch (e) {
    console.log('KEYBOARD TYPE FAILED:', e.message.split('\n').slice(0, 6).join('\n'));
  }
  console.log('endpoint timings:', await p.evaluate(async (id) => {
    const H = { Authorization: 'Bearer ' + sessionStorage.getItem('arena_session_token') };
    const out = {};
    for (const [k, u] of [['meta','/api/messages/threads/'+id],['walls','/api/messages/threads/'+id+'/walls'],['cust','/api/messages/threads/'+id+'/customization'],['msgs','/api/messages/threads/'+id+'/messages']]) {
      const t0 = performance.now();
      try { const r = await fetch(u, { headers: H }); const d = await r.json().catch(()=>null); out[k] = r.status + ' ' + Math.round(performance.now()-t0) + 'ms ' + (d && d.messages ? 'n='+d.messages.length : ''); }
      catch (e) { out[k] = 'ERR ' + e.message; }
    }
    return out;
  }, tid));
  console.log('rejections:', await p.evaluate(() => window.__rej));
  console.log('flow html head:', await p.evaluate(() => document.querySelector('#msg-flow').innerHTML.slice(0, 120)));
  await p.screenshot({ path: '/tmp/probe-thread.png' });
  await b.close();
})().catch((e) => { console.error('PROBE FAIL:', e.message); process.exit(1); });
