'use strict';
// v81 API contracts: challenge flow (phase 2), message prefs (phase 8),
// offline dedupe (phase 11), GIF uploads (phase 10). Local disposable DB.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const base = 'http://127.0.0.1:3000';
async function api(u, p, body, status = 200, method = body === undefined ? 'GET' : 'POST') {
  const r = await fetch(base + '/api' + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(u ? { Authorization: 'Bearer ' + u.token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  if (status) assert.equal(r.status, status, p + ' → ' + r.status + ' ' + JSON.stringify(d));
  return { status: r.status, d };
}
async function user(tag) {
  const name = 'v81_' + tag + '_' + randomBytes(3).toString('hex');
  const password = 'V81TestPass123!';
  const d = (await api(null, '/auth/register', { username: name, email: name + '@example.test', password }, 201)).d;
  const login = (await api(null, '/auth/login', { login: name, password })).d;
  return { id: d.user.id, token: login.session_token, name };
}
(async () => {
  const a = await user('chal_a'), b = await user('chal_b'), c = await user('chal_c');

  // ---- phase 2: challenge without friendship, no auto-friend, states -------
  let r = await api(a, `/community/challenge/state/${a.id}`);
  assert.equal(r.d.eligible, false); assert.equal(r.d.state, 'self');
  r = await api(a, `/community/challenge/${a.id}`, {}, 400);
  r = await api(a, `/community/challenge/state/${b.id}`);
  assert.deepEqual([r.d.eligible, r.d.state], [true, 'none']);
  r = await api(a, `/community/challenge/${b.id}`, {}, 201);
  assert.equal(r.d.state, 'pending'); assert.ok(r.d.room_code);
  r = await api(a, `/community/challenge/state/${b.id}`);
  assert.equal(r.d.state, 'pending');
  r = await api(a, `/community/challenge/${b.id}`, {}, 409); // duplicate challenge
  r = await api(b, `/community/challenge/state/${a.id}`);
  assert.equal(r.d.state, 'invited');
  // NOT friends — the challenge must not have created a friendship
  const fr = (await api(a, '/friends/list')).d;
  assert.ok(!(fr.friends || []).some((f) => f.id === b.id), 'challenge must not auto-friend');
  // b declines through the existing invitation endpoint
  const notifs = (await api(b, '/notifications')).d;
  const inv = (notifs.notifications || notifs || []).find((n) => n.type === 'room_invitation');
  assert.ok(inv, 'room_invitation notification exists');
  await api(b, `/friends/invitations/${inv.id}/decline`, {});
  r = await api(a, `/community/challenge/state/${b.id}`);
  assert.equal(r.d.state, 'declined');
  // blocked artists are ineligible
  await api(a, `/community/block/${c.id}`, {});
  r = await api(a, `/community/challenge/state/${c.id}`);
  assert.equal(r.d.eligible, false); assert.equal(r.d.state, 'blocked');
  await api(a, `/community/challenge/${c.id}`, {}, 403);

  // ---- phase 8: prefs default ON, independent persistence ------------------
  r = await api(a, '/messages/prefs');
  assert.deepEqual(r.d, { notifications: true, sound: true });
  r = await api(a, '/messages/prefs', { sound: false }, 200, 'PUT');
  assert.deepEqual(r.d, { notifications: true, sound: false });
  r = await api(a, '/messages/prefs');
  assert.deepEqual(r.d, { notifications: true, sound: false }, 'sound stays off, notifications untouched');

  // ---- phases 10/11: DM between friends, dedupe, GIF -----------------------
  await api(a, '/friends/request', { user_id: b.id }, 201);
  const inc = (await api(b, '/friends')).d;
  const rid = (inc.incoming || [])[0].id;
  await api(b, `/friends/requests/${rid}/accept`, {});
  const th = (await api(a, '/messages/threads', { user_id: b.id }, 201)).d;
  const cid = 'test-' + randomBytes(6).toString('hex');
  const s1 = (await api(a, `/messages/threads/${th.id}/messages`, { body: 'dedupe me', client_id: cid }, 201)).d;
  const s2 = (await api(a, `/messages/threads/${th.id}/messages`, { body: 'dedupe me', client_id: cid }, 200)).d;
  assert.equal(s2.id, s1.id, 'retry returns original ack');
  assert.equal(s2.deduped, true);
  const page = (await api(b, `/messages/threads/${th.id}/messages`)).d;
  assert.equal(page.messages.filter((m) => m.body === 'dedupe me').length, 1, 'exactly one copy stored');

  // GIF upload (1x1 GIF89a) then send as image share
  const gif = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
  gif.writeUInt16LE(32, 6); gif.writeUInt16LE(32, 8); // header dims pass the ≥16px rule
  const fd = new FormData();
  fd.append('kind', 'image'); fd.append('file', new Blob([gif], { type: 'image/gif' }), 'x.gif');
  const up = await fetch(base + '/api/messages/uploads', { method: 'POST', headers: { Authorization: 'Bearer ' + a.token }, body: fd });
  assert.equal(up.status, 201, 'GIF upload accepted: ' + up.status);
  const upd = await up.json();
  const sent = (await api(a, `/messages/threads/${th.id}/messages`, { body: 'gif', share: { type: 'image', ref: upd.id } }, 201)).d;
  assert.equal(sent.payload_type, 'image_share');

  // ---- phase 13: voice flag round-trips ------------------------------------
  const fd2 = new FormData();
  fd2.append('kind', 'audio'); fd2.append('file', new Blob([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0])], { type: 'audio/webm' }), 'v.webm');
  const up2 = await fetch(base + '/api/messages/uploads', { method: 'POST', headers: { Authorization: 'Bearer ' + a.token }, body: fd2 });
  assert.equal(up2.status, 201, 'audio upload: ' + up2.status);
  const upd2 = await up2.json();
  const vsent = (await api(a, `/messages/threads/${th.id}/messages`, { body: 'voice note', share: { type: 'audio', ref: upd2.id, voice: true } }, 201)).d;
  assert.equal(vsent.payload.voice, true);

  console.log('PASS _v81-api: challenge states w/o friendship or auto-friend + blocked/self guards, prefs independent+persistent, client_id dedupe ack, GIF upload/share, voice flag');
})().catch((e) => { console.error('FAIL _v81-api:', e.message); process.exit(1); });
