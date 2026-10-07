'use strict';
// v72 regression: 3v3 join is genuinely OPTIONAL about the "+" invite
// affordance — six artists fill a 3v3 room by plain joins (no invites, no
// matchmaking), seats balance 3/3, a 7th is rejected, and the start gate
// still requires host + lobby + full room (server rules preserved).
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
  const name = 'reg_' + randomBytes(6).toString('hex'), password = 'RegressionTest123!';
  const d = await api(null, '/auth/register', { username: name, email: name + '@example.test', password }, 201);
  const login = await api(null, '/auth/login', { login: name, password });
  return { id: d.user.id, token: login.session_token, name };
}
async function main() {
  const six = [];
  for (let i = 0; i < 6; i++) six.push(await user());
  const rd = await api(six[0], '/rooms', { name: 'OptInvite', battle_mode: '3v3', max_players: 6, drawing_app_key: 'krita', battle_type: 'none' }, 201);
  const code = rd.code;
  // Five plain joins — nobody pressed "+", nobody was invited.
  for (const u of six.slice(1)) await api(u, `/rooms/${code}/join`, { drawing_app_key: 'krita' });
  const roomRow = (await pool.query('SELECT id FROM battle_rooms WHERE code=$1', [code])).rows[0];
  const teams = await pool.query(
    `SELECT CASE WHEN seat <= 3 THEN 1 ELSE 2 END AS team, count(*)::int AS n
       FROM room_participants
      WHERE room_id=$1 AND state IN ('waiting','ready')
      GROUP BY 1 ORDER BY 1`,
    [roomRow.id]);
  assert.deepEqual(teams.rows.map((r) => r.n).sort(), [3, 3], 'six natural joins balance 3/3 without invites');
  // A 7th artist is rejected (room full) — the lobby rules still hold.
  const seventh = await user();
  await api(seventh, `/rooms/${code}/join`, { drawing_app_key: 'krita' }, 409);
  // Start gate unchanged: host cannot start until everyone is ready.
  await api(six[0], `/rooms/${code}/start`, {}, 409);
  console.log('PASS 3v3 optional invite: six plain joins fill 3/3 teams, full-room rejection, start gate intact');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
