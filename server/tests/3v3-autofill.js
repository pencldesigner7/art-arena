'use strict';
// v73 (items 7-9): 3v3 AUTO-REFILL regression. A forming matchmaking 3v3
// never starts with fewer than six; when players leave before the start the
// SERVER resumes matchmaking for exactly the missing seats — no user action.
// Replacements are fresh participants ('waiting', lowest free seat, never the
// host), queued artists seated in another active room are never pulled, and
// a seated artist can never hold two seats. Server truth at every step.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const db = new URL(process.env.DATABASE_URL || 'http://missing');
assert(['localhost', '127.0.0.1'].includes(db.hostname), 'Local disposable DATABASE_URL required');
const { pool } = require('../lib');
const base = 'http://127.0.0.1:3000';
async function api(u, path, body, status = 200, method = body === undefined ? 'GET' : 'POST') {
  const r = await fetch(base + '/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(u ? { Authorization: 'Bearer ' + u.token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  assert.equal(r.status, status, path + ' ' + JSON.stringify(d)); return d;
}
async function user() {
  const name = 'fill_' + randomBytes(6).toString('hex'), password = 'AutofillTest123!';
  const d = await api(null, '/auth/register', { username: name, email: name + '@example.test', password }, 201);
  const login = await api(null, '/auth/login', { login: name, password });
  return { id: d.user.id, token: login.session_token, name };
}
const seated = async (code) => (await pool.query(
  `SELECT p.user_id, p.state, p.seat, p.ready_at, r.host_id, r.status, r.origin
     FROM room_participants p JOIN battle_rooms r ON r.id = p.room_id
    WHERE r.code = $1 AND p.state IN ('waiting','ready') ORDER BY p.seat`, [code])).rows;
const teamSplit = (rows) => [rows.filter((r) => r.seat <= 3).length, rows.filter((r) => r.seat > 3).length];
const WS = require('ws'); // same library the realtime hub serves with
// Subscribe and resolve `ready` on the server's 'subscribed' ack so the
// caller can act without racing the subscription; events land in `got`.
function subscribeRoom(token, code) {
  const got = [];
  const ws = new WS('ws://127.0.0.1:3000/api/realtime?arena_token=' + encodeURIComponent(token));
  const ready = new Promise((resolve) => {
    const t = setTimeout(resolve, 2000); // safety: never hang the suite
    ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', room: code })));
    ws.on('message', (data) => {
      let m = null; try { m = JSON.parse(data); } catch (_) {}
      if (!m) return;
      if (m.type === 'subscribed' && m.room === code) { clearTimeout(t); resolve(); }
      if (m.type === 'room.event' && m.event) got.push(m.event);
    });
    ws.on('error', () => { clearTimeout(t); resolve(); });
  });
  return { got, ready, close: () => { try { ws.close(); } catch (_) {} } };
}

async function main() {
  // Hygiene: a previously crashed run can leave a PARTIAL 3v3 lobby behind,
  // which would legitimately absorb this run's first entrant (that IS the
  // auto-refill join path). End such stragglers so this run assembles its
  // own room from a clean slate.
  await pool.query(`UPDATE battle_rooms SET status='ended', ended_at=now()
    WHERE battle_mode='3v3' AND status='lobby' AND deleted_at IS NULL
      AND (SELECT count(*) FROM room_participants p WHERE p.room_id=battle_rooms.id AND p.state IN ('waiting','ready')) < 6`);
  await pool.query(`UPDATE matchmaking_queue SET status='cancelled'
    WHERE status='queued' AND prefs->>'battle_mode'='3v3'`);
  const six = [];
  for (let i = 0; i < 6; i++) six.push(await user());

  // ---- VALID: six queued artists assemble into a 6/6 room (never earlier)
  for (let i = 0; i < 5; i++) {
    const r = await api(six[i], '/matchmaking/enter', { mode: '3v3' });
    assert.equal(r.matched, false, 'no room may form before six artists are queued');
  }
  const sixth = await api(six[5], '/matchmaking/enter', { mode: '3v3' });
  assert.equal(sixth.matched, true);
  const code = sixth.room;
  let rows = await seated(code);
  assert.equal(rows.length, 6, 'room forms with exactly 6');
  assert.deepEqual(teamSplit(rows), [3, 3], 'seats always balance 3/3');
  assert.equal(rows[0].origin, 'matchmaking');
  const hostId = rows[0].host_id;

  // ---- REJECTED: a seated artist cannot queue again (no duplicate searches)
  await api(six[1], '/matchmaking/enter', { mode: '3v3' }, 409);

  // ---- READY state is per-seat and dies with the seat
  await api(six[0], `/rooms/${code}/ready`, { ready: true });
  let u0 = (await seated(code)).find((r) => String(r.user_id) === six[0].id);
  assert.equal(u0.state, 'ready');

  // ---- One player leaves → server marks the missing seat and SEARCHES (event)
  const sub1 = subscribeRoom(six[1].token, code);
  await sub1.ready;
  await api(six[0], `/rooms/${code}/leave`, {});
  const gone = (await pool.query(
    `SELECT state, ready_at FROM room_participants WHERE room_id=(SELECT id FROM battle_rooms WHERE code=$1) AND user_id=$2`,
    [code, six[0].id])).rows[0];
  assert.equal(gone.state, 'left');
  assert.equal(gone.ready_at, null, 'ready state is removed when the seat is vacated');
  rows = await seated(code);
  assert.equal(rows.length, 5);
  await new Promise((r) => setTimeout(r, 700));
  const searching1 = sub1.got.filter((e) => e.action === 'mm_searching');
  sub1.close();
  assert.ok(searching1.length >= 1, 'room members are told matchmaking resumed');
  assert.equal(searching1[searching1.length - 1].missing, 1, 'exactly one seat is searched');

  // ---- REJECTED: start with five is server-blocked (3v3_not_full)
  const hostNow = rows[0]; // host transferred to the lowest remaining seat
  assert.notEqual(String(hostNow.user_id), six[0].id, 'departed player is no longer host');
  const hostTok = six.find((u) => String(u.id) === String(hostNow.user_id));
  const st = await fetch(base + `/api/rooms/${code}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + hostTok.token } });
  assert.equal(st.status, 409);
  const stBody = await st.json();
  assert.equal(stBody.data && stBody.data.code, '3v3_not_full', 'five players can never start a 3v3');

  // ---- Replacement arrives through the NORMAL queue — zero user action
  const rep1 = await user();
  const j1 = await api(rep1, '/matchmaking/enter', { mode: '3v3' });
  assert.equal(j1.matched, true, 'a fresh searcher is seated into the forming room');
  assert.equal(j1.room, code, 'and into the room with the missing seat');
  rows = await seated(code);
  assert.equal(rows.length, 6, 'room refills to 6/6 automatically');
  assert.deepEqual(teamSplit(rows), [3, 3], 'invalid team distributions are impossible — seats are positional');
  const repRow = rows.find((r) => String(r.user_id) === rep1.id);
  assert.equal(repRow.state, 'waiting', 'a replacement is NOT ready');
  assert.equal(repRow.ready_at, null);
  assert.notEqual(String(rows[0].host_id), rep1.id, 'a replacement never inherits ownership');

  // ---- Two more leave → two seats searched → two replacements refill
  const sub2 = subscribeRoom(rep1.token, code);
  await sub2.ready;
  await api(six[2], `/rooms/${code}/leave`, {});
  await api(six[3], `/rooms/${code}/leave`, {});
  rows = await seated(code);
  assert.equal(rows.length, 4);
  await new Promise((r) => setTimeout(r, 900));
  const searching2 = sub2.got.filter((e) => e.action === 'mm_searching');
  sub2.close();
  assert.equal(searching2[searching2.length - 1].missing, 2, 'exactly two seats are searched');
  const rep2 = await user(), rep3 = await user();
  await api(rep2, '/matchmaking/enter', { mode: '3v3' });
  await api(rep3, '/matchmaking/enter', { mode: '3v3' });
  rows = await seated(code);
  assert.equal(rows.length, 6, 'refilled to 6/6 again');
  assert.deepEqual(teamSplit(rows), [3, 3]);
  const seats = rows.map((r) => r.seat).sort((a, b) => a - b);
  assert.deepEqual(seats, [1, 2, 3, 4, 5, 6], 'every replacement takes a distinct free seat');

  // ---- REJECTED: an artist seated in another ACTIVE room is never pulled
  const busy = await user();
  await api(busy, '/rooms', { name: 'BusyRoom', battle_mode: '1v1', max_players: 2, drawing_app_key: 'krita', battle_type: 'none' }, 201);
  // A manipulated/stale client left a 3v3 queue row behind for a seated artist:
  await pool.query(`INSERT INTO matchmaking_queue (user_id, prefs) VALUES ($1, $2::jsonb)`,
    [busy.id, JSON.stringify({ competition_type: 'casual', format: 'three_on_three', battle_mode: '3v3', time_limit_seconds: 3600 })]);
  await api(rep2, `/rooms/${code}/leave`, {}); // frees one seat → backfill runs
  await new Promise((r) => setTimeout(r, 400));
  rows = await seated(code);
  assert.equal(rows.length, 5, 'the in-another-match artist is NOT seated');
  assert.ok(!rows.some((r) => String(r.user_id) === busy.id));
  const busyQ = (await pool.query(`SELECT status FROM matchmaking_queue WHERE user_id=$1`, [busy.id])).rows[0];
  assert.equal(busyQ.status, 'queued', 'their stale queue row is untouched — eligibility is checked at placement');
  await pool.query(`UPDATE matchmaking_queue SET status='cancelled' WHERE user_id=$1`, [busy.id]);

  // ---- REJECTED: reconnecting cannot double-seat (one active seat per user)
  await api(rep1, '/matchmaking/enter', { mode: '3v3' }, 409);
  rows = await seated(code);
  assert.equal(rows.filter((r) => String(r.user_id) === rep1.id).length, 1);

  // ---- The freed seat from the busy-artist scenario refills honestly
  const rep4 = await user();
  await api(rep4, '/matchmaking/enter', { mode: '3v3' });
  rows = await seated(code);
  assert.equal(rows.length, 6, 'final state: 6/6 valid players, 3/3 teams');
  assert.deepEqual(teamSplit(rows), [3, 3]);

  console.log('PASS 3v3 auto-refill: 6/6 formation, leave→search 1, 2 leaves→search 2, queue refill to 6/6, ' +
    'start-with-5 rejected (3v3_not_full), in-other-match never pulled, no double seats, ready removed on leave, ' +
    'replacements fresh (waiting, never host), positional 3/3 invariant, duplicate queue rejected');
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAIL', e); process.exit(1); });
