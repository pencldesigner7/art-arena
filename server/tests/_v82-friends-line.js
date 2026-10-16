'use strict';
// v82: mobile Community → Friends — avatar · name · @handle · status all on
// ONE horizontal line, actions pinned right (owner's chosen layout).
const { chromium } = require('playwright');
const { randomBytes } = require('node:crypto');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = 'http://127.0.0.1:3000';
const OUT = path.join(__dirname, '..', '..', 'docs', 'shots-v81');
fs.mkdirSync(OUT, { recursive: true });

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
  const name = 'fl' + randomBytes(5).toString('hex'), password = '[SECURITY_DATA]';
  const d = await api(null, '/auth/register', { username: name, email: name + '@example.test', password }, 201);
  const login = await api(null, '/auth/login', { login: name, password });
  return { id: d.user.id, token: login.session_token, name };
}

(async () => {
  const A = await user(), B = await user(), C = await user();
  for (const f of [B, C]) {
    const fr = await api(A, '/friends/request', { user_id: f.id }, 201);
    const inbox = await api(f, '/friends');
    const reqId = (inbox.incoming || inbox.requests || []).map((x) => x.id || x.request_id).find(Boolean) || fr.id || fr.request_id;
    await api(f, '/friends/requests/' + reqId + '/accept', {}, 200);
  }
  const browser = await chromium.launch();
  const errors = [];
  for (const w of [375, 320]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 800 } });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(w + ': ' + e.message));
    await p.addInitScript((t) => sessionStorage.setItem('arena_session_token', t), A.token);
    await p.goto(base);
    await p.waitForFunction(() => typeof me !== 'undefined' && !!me, null, { timeout: 20000 });
    await p.waitForTimeout(1100);
    await p.click('#bottom-nav .tab[data-tab="community"]');
    await p.waitForTimeout(700);
    await p.click('[data-cm="friends"]');
    await p.waitForTimeout(1300);
    const probe = await p.evaluate(() => {
      const row = document.querySelector('#cm-feed.cm-friends .fr-row');
      if (!row) return null;
      const r = (s) => row.querySelector(s).getBoundingClientRect();
      const name = r('.fr-name'), sub = r('.fr-sub'), acts = r('.fr-actions'), ava = r('.fr-ava');
      const mid = (b) => b.top + b.height / 2;
      return {
        oneLine: Math.abs(mid(name) - mid(sub)) < 10,
        allInRow: Math.abs(mid(ava) - mid(name)) < 12 && Math.abs(mid(name) - mid(acts)) < 16,
        rowH: Math.round(row.getBoundingClientRect().height),
        overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
      };
    });
    console.log(w + 'px', JSON.stringify(probe));
    assert.ok(probe && probe.oneLine && probe.allInRow && probe.overflow, w + 'px one-line layout: ' + JSON.stringify(probe));
    await p.screenshot({ path: path.join(OUT, 'v82-friends-oneline-' + w + '.png') });
    await ctx.close();
  }
  assert.equal(errors.length, 0, JSON.stringify(errors));
  await browser.close();
  console.log('V82 FRIENDS ONE-LINE: PASS');
})().catch((e) => { console.error('V82 FRIENDS ONE-LINE: FAIL —', e.message); process.exit(1); });
