'use strict';
// v73 phase 7 — Safety + Moderation UI in a real browser: moderator sees the
// queue via the drawer, hides/reports retain status; user manages blocks.
const { chromium } = require('playwright');
const { randomBytes } = require('node:crypto');
const assert = require('node:assert/strict');
const base = 'http://127.0.0.1:3000';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
async function api(u, path, body, status = 200, method = body === undefined ? 'GET' : 'POST') {
  const r = await fetch(base + '/api' + path, {
    method, headers: { 'Content-Type': 'application/json', ...(u ? { Authorization: 'Bearer ' + u.token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  if (status && r.status !== status) throw new Error(path + ' → ' + r.status + ' ' + JSON.stringify(d));
  return d;
}
async function user(p) {
  const name = 'sv_' + randomBytes(5).toString('hex'), password = 'SafetyUI123!';
  const d = await api(null, '/auth/register', { username: name, email: name + '@example.test', password }, 201);
  const login = await api(null, '/auth/login', { login: name, password });
  return { id: d.user.id, token: login.session_token, name };
}
(async () => {
  const b = await chromium.launch();
  const mod = await user(), artist = await user();
  // artist publishes; mod reports it; mod gets the role
  const fd = new FormData();
  fd.append('image', new Blob([PNG], { type: 'image/png' }), 'a.png');
  fd.append('title', 'Reported piece');
  const pr = await fetch(base + '/api/community/posts', { method: 'POST', headers: { Authorization: 'Bearer ' + artist.token }, body: fd });
  const post = await pr.json();
  await api(mod, '/community/report', { target_type: 'post', target_id: post.id, reason: 'spam' });
  const { Client } = require('pg');
  const c = new Client({ connectionString: 'postgresql://aa_admin:aa-admin-pw@127.0.0.1:5432/art_arena' });
  await c.connect();
  await c.query(`INSERT INTO user_roles (user_id, role) VALUES ($1,'moderator') ON CONFLICT DO NOTHING`, [mod.id]);
  await c.end();
  await api(artist, '/community/block/' + mod.id, {}, 200); // artist blocks mod (safety view content)

  const errors = [];
  const mk = async (u) => {
    const ctx = await b.newContext({ viewport: { width: 1100, height: 800 } });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    p.on('response', (r) => { if (r.status() === 404) errors.push('404: ' + r.url()); });
    await p.addInitScript((t) => sessionStorage.setItem('arena_session_token', t), u.token);
    await p.goto(base);
    await p.waitForFunction(() => typeof me !== 'undefined' && !!me, null, { timeout: 20000 });
    await p.waitForTimeout(2400);
    return p;
  };
  const pm = await mk(mod), pa = await mk(artist);

  // moderator: drawer row visible, queue renders, hide action retains status
  await pm.click('#btn-menu');
  await pm.waitForSelector('#drawer-nav [data-view="moderation"]:not(.hidden)');
  await pm.click('#drawer-nav [data-view="moderation"]');
  await pm.waitForSelector('#view-moderation:not(.hidden)');
  await pm.waitForSelector('[data-mod-act="hide"]');
  assert.ok((await pm.textContent('#mod-queue')).includes('Reported piece'));
  await pm.click('[data-mod-act="hide"]');
  await pm.waitForFunction(() => document.querySelector('#mod-queue').textContent.includes('hidden'));
  await pm.screenshot({ path: '/home/user/theme-previews/v73-moderation-queue.png' });

  // artist: safety view lists the block; unblock removes it
  await pa.click('#btn-menu');
  await pa.click('#drawer-nav [data-view="safety"]');
  await pa.waitForSelector('#view-safety:not(.hidden)');
  await pa.waitForSelector('[data-sf-unblock]');
  assert.ok((await pa.textContent('#sf-blocked')).includes('@' + mod.name));
  await pa.screenshot({ path: '/home/user/theme-previews/v73-safety-view.png' });
  await pa.click('[data-sf-unblock]');
  await pa.waitForFunction(() => document.querySelector('#sf-blocked').textContent.includes('Nobody blocked'));

  // non-mod never sees the moderation row (role gate applies the .sf-on class)
  assert.equal(await pa.locator('#drawer-nav [data-view="moderation"]').isVisible().catch(() => false), false);

  assert.deepEqual(errors.filter((e) => !e.includes('favicon')), [], 'no JS errors / 404s');
  await b.close();
  console.log('PASS safety/mod UI: role-gated drawer row, queue renders report, hide retains status, safety list + unblock, non-mod hidden');
})().catch((e) => { console.error('SHOT FAIL', e); process.exit(1); });
