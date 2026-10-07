'use strict';
// v72: Cancel Stream — server-authoritative, owner-only, starting-state
// cleared, live protected. YouTube and Twitch independent.
// Run only against a disposable LOCAL database + local server.
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
  const d = await r.json(); assert.equal(r.status, status, path + ' ' + JSON.stringify(d)); return d;
}
async function user() {
  const name = 'reg_' + randomBytes(6).toString('hex'), password = 'RegressionTest123!';
  const d = await api(null, '/auth/register', { username: name, email: name + '@example.test', password }, 201);
  const login = await api(null, '/auth/login', { login: name, password });
  return { id: d.user.id, token: login.session_token, name };
}
async function main() {
  const host = await user(), stranger = await user();
  const rd = await api(host, '/rooms', { name: 'StreamCancel', battle_mode: '1v1', max_players: 2, drawing_app_key: 'krita', battle_type: 'none' }, 201);
  const roomRow = (await pool.query('SELECT id FROM battle_rooms WHERE code=$1', [rd.code])).rows[0];

  // ---- Twitch: preparing session cancels (owner only), live cannot ----
  const ins = await pool.query(
    `INSERT INTO twitch_stream_sessions (room_id, host_user_id, title, status)
     VALUES ($1,$2,'cancel-test','preparing') RETURNING id`, [roomRow.id, host.id]);
  const sid = ins.rows[0].id;
  await api(stranger, `/twitch/sessions/${sid}/cancel`, {}, 404); // not the owner → invisible
  const tw = await api(host, `/twitch/sessions/${sid}/cancel`, {});
  assert.equal(tw.cancelled, true);
  assert.equal((await pool.query('SELECT 1 FROM twitch_stream_sessions WHERE id=$1', [sid])).rowCount, 0, 'no stale starting state');

  const ins2 = await pool.query(
    `INSERT INTO twitch_stream_sessions (room_id, host_user_id, title, status, started_at)
     VALUES ($1,$2,'live-test','live',now()) RETURNING id`, [roomRow.id, host.id]);
  await api(host, `/twitch/sessions/${ins2.rows[0].id}/cancel`, {}, 409); // live → end, not cancel
  await api(host, `/twitch/sessions/${ins2.rows[0].id}/end`, {});

  // ---- YouTube: scheduled broadcast cancels (owner only), live cannot ----
  const bcId = 'aa-cancel-' + randomBytes(4).toString('hex');
  const yb = await pool.query(
    `INSERT INTO youtube_broadcasts (user_id, room_id, youtube_broadcast_id, title, last_known_status, scheduled_start)
     VALUES ($1,$2,$3,'cancel-test','scheduled',now()+interval '5 minutes') RETURNING id`, [host.id, roomRow.id, bcId + '-1']);
  await api(stranger, `/youtube/broadcasts/${yb.rows[0].id}/cancel`, {}, 404);
  const yt = await api(host, `/youtube/broadcasts/${yb.rows[0].id}/cancel`, {});
  assert.equal(yt.cancelled, true);
  assert.equal((await pool.query('SELECT 1 FROM youtube_broadcasts WHERE id=$1', [yb.rows[0].id])).rowCount, 0, 'no stale scheduled state');

  const yb2 = await pool.query(
    `INSERT INTO youtube_broadcasts (user_id, room_id, youtube_broadcast_id, title, last_known_status)
     VALUES ($1,$2,$3,'live-test','live') RETURNING id`, [host.id, roomRow.id, bcId + '-2']);
  await api(host, `/youtube/broadcasts/${yb2.rows[0].id}/cancel`, {}, 409);

  console.log('PASS stream cancel: owner-only, starting states cleared, live protected, YT+Twitch independent');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
