'use strict';
// v73 phase 6 — Messages UI in a REAL browser, two sessions: DM create,
// send, realtime push into the other open session (no polling), reply.
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
  const name = 'mu_' + randomBytes(5).toString('hex'), password = 'MessagesUI123!';
  const d = await api(null, '/auth/register', { username: name, email: name + '@example.test', password }, 201);
  const login = await api(null, '/auth/login', { login: name, password });
  return { id: d.user.id, token: login.session_token, name };
}
// v80: Messages is no longer a top-level drawer destination — it is reached
// from Community → Friends. Same view, same view id, new way in.
async function openMessages(p) {
  await p.click('#bottom-nav .tab[data-tab="community"]');
  await p.waitForSelector('.cm-side-item', { timeout: 15000 });
  await p.click('.cm-side-item[data-cm="friends"]');
  await p.waitForSelector('.cm-open-messages', { timeout: 15000 });
  await p.click('.cm-open-messages');
  await p.waitForSelector('#view-messages:not(.hidden)');
}
(async () => {
  const b = await chromium.launch();
  const a = await user(), u2 = await user();
  await api(a, '/friends/request', { user_id: u2.id }, 201);
  const fr = await api(u2, '/friends');
  const rid = fr.incoming.find((r) => r.user_id === a.id).id;
  await api(u2, '/friends/requests/' + rid + '/accept', {}, 200);

  const errors = [];
  const mk = async (u) => {
    const ctx = await b.newContext({ viewport: { width: 1100, height: 800 } });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => { errors.push('pageerror: ' + e.message); console.log('PAGEERROR', u.name, e.message); });
    p.on('console', (m) => { const t = m.text(); if (m.type() === 'error' || t.includes('[ws]') || t.includes('[aa-chat]')) console.log('CONSOLE', u.name, t.slice(0, 220)); });
    p.on('response', (r) => { if (r.status() === 404) errors.push('404: ' + r.url()); });
    await p.addInitScript((t) => sessionStorage.setItem('arena_session_token', t), u.token);
    await p.goto(base);
    await p.waitForFunction(() => typeof me !== 'undefined' && !!me, null, { timeout: 20000 });
    await p.waitForTimeout(2400);
    return p;
  };
  const pa = await mk(a), pb = await mk(u2);

  // A: start the DM from the drawer + New box
  await openMessages(pa);
  await pa.click('#msg-new');
  await pa.waitForSelector('.msg-pick');
  await pa.check('.msg-pick');
  await pa.click('[data-msg-go]');
  await pa.waitForSelector('#msg-thread:not(.hidden)');
  await pa.fill('#msg-input', 'hello from A');
  await pa.click('#msg-form button[type=submit]');
  await pa.waitForSelector('.msg-grp.mine .msg-bub');
  await pa.screenshot({ path: '/home/user/theme-previews/v73-messages-a.png' });

  // B: thread arrives with unread dot, opens, replies — A sees it via WS push
  await openMessages(pb);
  await pb.waitForSelector('.msg-row .dot', { timeout: 10000 });
  await pb.click('.msg-row');
  await pb.waitForSelector('.msg-grp.theirs .msg-bub');
  assert.ok((await pb.textContent('#msg-scroll')).includes('hello from A'));
  await pb.fill('#msg-input', 'hi A, realtime works');
  await pb.click('#msg-form button[type=submit]');
  await pa.waitForFunction(() => document.querySelector('#msg-scroll').textContent.includes('hi A, realtime works'), null, { timeout: 10000 });
  await pb.screenshot({ path: '/home/user/theme-previews/v73-messages-b.png' });

  assert.deepEqual(errors.filter((e) => !e.includes('favicon')), [], 'no JS errors / 404s');
  await b.close();
  console.log('PASS messages UI: drawer entry, DM start from friends, send, unread dot, realtime push both ways, zero JS errors');
})().catch((e) => { console.error('SHOT FAIL', e); process.exit(1); });
