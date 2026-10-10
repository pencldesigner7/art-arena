'use strict';
// v73 COMMUNITY phase 6 — Messages API suite: friends-only threads, one DM
// per pair, server-authoritative fan-out (realtime + persistent notifs),
// unread/read state, block enforcement, groups, cursor paging.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
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
  const name = 'ms_' + randomBytes(5).toString('hex'), password = 'MessagesTest123!';
  const d = await api(null, '/auth/register', { username: name, email: name + '@example.test', password }, 201);
  const login = await api(null, '/auth/login', { login: name, password });
  return { id: d.user.id, token: login.session_token, name };
}
async function befriend(x, y) {
  await api(x, '/friends/request', { user_id: y.id }, 201);
  const fr = await api(y, '/friends');
  const rid = (fr.incoming || []).find((r) => r.user_id === x.id).id;
  await api(y, '/friends/requests/' + rid + '/accept', {}, 200);
}
(async () => {
  const { Client } = require('pg');
  const c = new Client({ connectionString: 'postgresql://aa_admin:aa-admin-pw@127.0.0.1:5432/art_arena' });
  await c.connect();
  await c.query(`TRUNCATE messages, conversation_members, conversations, notifications CASCADE`);
  await c.end();

  const a = await user(), b = await user(), stranger = await user();

  // strangers cannot start a DM
  await api(a, '/messages/threads', { user_id: stranger.id }, 403);

  await befriend(a, b);

  // DM lifecycle: create once, same thread on reopen (unique per pair)
  const t1 = await api(a, '/messages/threads', { user_id: b.id }, 201);
  const t2 = await api(b, '/messages/threads', { user_id: a.id }, 201);
  assert.equal(t1.id, t2.id, 'one DM thread per pair');

  // validation
  await api(a, '/messages/threads/' + t1.id + '/messages', { body: '' }, 400);
  await api(a, '/messages/threads/' + t1.id + '/messages', { body: 'x'.repeat(4001) }, 400);

  // send + unread + read
  await api(a, '/messages/threads/' + t1.id + '/messages', { body: 'hello from a' }, 201);
  let list = await api(b, '/messages/threads');
  assert.equal(list.threads[0].unread, 1, 'unread counted from read state');
  const page = await api(b, '/messages/threads/' + t1.id + '/messages');
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0].body, 'hello from a');
  list = await api(b, '/messages/threads');
  assert.equal(list.threads[0].unread, 0, 'fetching the page marks read');

  // persistent notification for the recipient
  const { rows: notif } = await (async () => {
    const cc = new Client({ connectionString: 'postgresql://aa_admin:aa-admin-pw@127.0.0.1:5432/art_arena' });
    await cc.connect();
    const r = await cc.query(`SELECT payload FROM notifications WHERE user_id=$1 AND type='message'`, [b.id]);
    await cc.end(); return r;
  })();
  assert.equal(notif.length, 1);
  assert.equal(notif[0].payload.thread_id, t1.id);

  // non-members cannot read or write
  await api(stranger, '/messages/threads/' + t1.id + '/messages', undefined, 404);
  await api(stranger, '/messages/threads/' + t1.id + '/messages', { body: 'nope' }, 404);

  // groups: members must be friends of the creator
  await api(a, '/messages/threads/group', { name: 'crew', member_ids: [b.id, stranger.id] }, 403);
  await befriend(a, stranger);
  const g = await api(a, '/messages/threads/group', { name: 'crew', member_ids: [b.id, stranger.id] }, 201);
  await api(a, '/messages/threads/' + g.id + '/messages', { body: 'welcome crew' }, 201);
  for (const m of [b, stranger]) {
    const l = await api(m, '/messages/threads');
    assert.equal(l.threads.find((t) => t.id === g.id).unread, 1, 'group fan-out unread');
  }

  // block kills sending (server-enforced), existing thread included
  const cc = new Client({ connectionString: 'postgresql://aa_admin:aa-admin-pw@127.0.0.1:5432/art_arena' });
  await cc.connect();
  await cc.query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [b.id, a.id]);
  await cc.end();
  await api(a, '/messages/threads/' + t1.id + '/messages', { body: 'still there?' }, 403);
  await api(b, '/messages/threads/' + t1.id + '/messages', { body: 'blocked reply' }, 403);

  // cursor paging: >50 messages page with has_more
  for (let i = 0; i < 55; i++) await api(stranger, '/messages/threads/' + g.id + '/messages', { body: 'm' + i }, 201);
  const pg1 = await api(b, '/messages/threads/' + g.id + '/messages');
  assert.equal(pg1.messages.length, 50);
  assert.equal(pg1.has_more, true);
  const pg2 = await api(b, '/messages/threads/' + g.id + '/messages?before=' + encodeURIComponent(pg1.next_before));
  assert.ok(pg2.messages.length >= 6);
  assert.ok(new Date(pg2.messages[pg2.messages.length - 1].created_at) < new Date(pg1.messages[0].created_at));

  console.log('PASS messages phase 6: friends-only DMs, one thread per pair, validation, unread/read state, ' +
    'persistent message notifications, non-member 404s, groups with friend gating + fan-out, block kills sending, cursor paging');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
