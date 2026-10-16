'use strict';
// v81 phase 4 invariants: exactly six seats, no duplicate team invites,
// decline/disconnect keep every client's state honest, 1v1 untouched.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const db = new URL(process.env.DATABASE_URL || 'http://missing');
assert(['localhost', '127.0.0.1'].includes(db.hostname), 'Local disposable DATABASE_URL required');
const { pool } = require('../lib');
const WS = require('ws');
const base = 'http://127.0.0.1:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  const name = 'v81mm_' + tag + '_' + randomBytes(3).toString('hex');
  const password = 'V81MmTest123!';
  const d = (await api(null, '/auth/register', { username: name, email: name + '@example.test', password }, 201)).d;
  const login = (await api(null, '/auth/login', { login: name, password })).d;
  return { id: d.user.id, token: login.session_token, name };
}
async function befriend(a, b) {
  await api(a, '/friends/request', { user_id: b.id }, 201);
  const inc = (await api(b, '/friends')).d;
  const rid = (inc.incoming || []).find((r) => r.user_id === a.id).id;
  await api(b, `/friends/requests/${rid}/accept`, {});
}
function connect(u) {
  return new Promise((resolve) => {
    const ws = new WS('ws://127.0.0.1:3000/api/realtime?arena_token=' + encodeURIComponent(u.token));
    ws.on('open', () => resolve(ws));
    ws.on('error', () => resolve(ws));
    setTimeout(() => resolve(ws), 2500);
  });
}
(async () => {
  // clean slate: no stray 3v3 lobbies/queues may absorb this run
  await pool.query(`UPDATE battle_rooms SET status='ended', ended_at=now() WHERE battle_mode='3v3' AND status='lobby' AND deleted_at IS NULL`);
  await pool.query(`UPDATE matchmaking_queue SET status='cancelled' WHERE status='queued'`);

  // ---- exactly six: 6 entrants -> one room, seats 1..6, all distinct -------
  const six = [];
  for (let i = 0; i < 6; i++) six.push(await user('six' + i));
  let last;
  for (const u of six) last = await api(u, '/matchmaking/enter', { mode: '3v3' });
  assert.equal(last.d.matched, true, 'sixth entrant completes the match');
  const code = last.d.room;
  const { rows: seats } = await pool.query(
    `SELECT p.user_id, p.seat FROM room_participants p JOIN battle_rooms r ON r.id=p.room_id
      WHERE r.code=$1 AND p.state IN ('waiting','ready') ORDER BY p.seat`, [code]);
  assert.equal(seats.length, 6, 'exactly six seated');
  assert.deepEqual(seats.map((s) => s.seat), [1, 2, 3, 4, 5, 6], 'seats 1-6');
  assert.equal(new Set(seats.map((s) => s.user_id)).size, 6, 'no duplicated player');
  assert.deepEqual(new Set(seats.map((s) => s.user_id)), new Set(six.map((u) => u.id)), 'exactly the six searchers');

  // seventh searcher stays honestly queued (no seventh seat)
  const seven = await user('seven');
  const r7 = await api(seven, '/matchmaking/enter', { mode: '3v3' });
  assert.equal(r7.d.matched, false); assert.equal(r7.d.in_queue, true);
  await api(seven, '/matchmaking/cancel', {});

  // ---- duplicate invite, decline frees, disconnect expires -----------------
  const cap = await user('cap'), mate = await user('mate'), mate2 = await user('mate2');
  await befriend(cap, mate); await befriend(cap, mate2);
  const wsCap = await connect(cap);
  await api(cap, '/matchmaking/enter', { mode: '3v3' });
  await api(cap, '/matchmaking/team-invite', { friend_id: mate.id }, 201);
  await api(cap, '/matchmaking/team-invite', { friend_id: mate.id }, 409); // duplicate
  const n1 = (await api(mate, '/notifications')).d;
  const inv1 = (n1.notifications || []).find((n) => n.type === 'mm_team_invite');
  assert.ok(inv1, 'invite delivered once');
  await api(mate, `/matchmaking/team-invite/${inv1.id}/decline`, {});
  const st1 = (await api(cap, '/matchmaking/status')).d;
  assert.deepEqual(st1.pending_team_invites, [], 'decline frees the [+] slot');
  await api(cap, '/matchmaking/team-invite', { friend_id: mate.id }, 201); // re-invite after decline works
  await api(cap, '/matchmaking/team-invite', { friend_id: mate2.id }, 201);

  // captain disconnects -> queue row cancelled AND both invites expired
  wsCap.close();
  await sleep(1200);
  const q = await pool.query(`SELECT status FROM matchmaking_queue WHERE user_id=$1 ORDER BY queued_at DESC LIMIT 1`, [cap.id]);
  assert.notEqual(q.rows[0].status, 'queued', 'disconnect cancels the search');
  const pend = await pool.query(
    `SELECT count(*)::int n FROM notifications WHERE type='mm_team_invite' AND payload->>'from_user_id'=$1 AND payload->>'handled' IS NULL`, [cap.id]);
  assert.equal(pend.rows[0].n, 0, 'disconnect expires pending invites');
  const n2 = (await api(mate2, '/notifications')).d;
  const inv2 = (n2.notifications || []).find((n) => n.type === 'mm_team_invite');
  await api(mate2, `/matchmaking/team-invite/${inv2.id}/accept`, {}, 409); // stale invite cannot seat anyone

  // ---- 1v1 preserved --------------------------------------------------------
  const x = await user('duelx'), y = await user('duely');
  await api(x, '/matchmaking/enter', { mode: '1v1' });
  const duel = await api(y, '/matchmaking/enter', { mode: '1v1' });
  assert.equal(duel.d.matched, true); assert.equal(duel.d.mode, '1v1');
  console.log('PASS _v81-matchmaking: exactly six distinct seats 1-6, 7th queued, duplicate invite 409, decline frees slot, disconnect expires invites (stale accept 409), 1v1 intact');
  process.exit(0);
})().catch((e) => { console.error('FAIL _v81-matchmaking:', e.message); process.exit(1); });
