'use strict';
// ============================================================================
// FIX 3 (item 1): FRESH-BOOTSTRAP REGRESSION TEST.
// Proves that a brand-new database created from server/schema.sql ALONE —
// with the documented least-privilege app role (DML only, no DDL) — is
// runtime-complete: the real server boots against it, /api/health reports
// schema "ok", register+login succeed (users.ui_theme_custom), the
// battle-end sweeper's columns exist (battles.voting_ends_at), the new
// notification vocabulary inserts, and the app role really cannot run DDL.
//
// Run with an ADMIN Postgres URL that may create/drop disposable fixtures:
//   TEST_PG_ADMIN_URL=postgresql://postgres@127.0.0.1:5432/postgres \
//     node server/tests/schema-bootstrap.js
// Requires: psql on PATH (the documented bootstrap tool), nothing else.
// Fixtures (database aa_bootstrap_test_db, role aa_bootstrap_test) are
// dropped again in the finally block. NEVER point this at a shared database.
// ============================================================================
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { Client } = require('pg');

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL || 'postgresql://postgres@127.0.0.1:5432/postgres';
const DB = 'aa_bootstrap_test_db';
const ROLE = 'aa_bootstrap_test';
const ROLE_PW = 'bootstrap-test-pw';
const APP_URL = `postgresql://${ROLE}:${ROLE_PW}@127.0.0.1:5432/${DB}`;
const PORT = Number(process.env.TEST_BOOT_PORT || 3121);
const BASE = `http://127.0.0.1:${PORT}`;
const SCHEMA = path.join(__dirname, '..', 'schema.sql');

async function admin(sql, db) {
  // NOTE: GRANTs must run against the TARGET database — running them via the
  // admin URL's default database is a silent no-op (the README warns about
  // exactly this trap).
  const u = new URL(ADMIN_URL);
  if (db) u.pathname = '/' + db;
  const c = new Client({ connectionString: u.toString() });
  await c.connect();
  try { return await c.query(sql); } finally { await c.end(); }
}
async function asApp(sql, params) {
  const c = new Client({ connectionString: APP_URL });
  await c.connect();
  try { return await c.query(sql, params); } finally { await c.end(); }
}
async function http(method, p, body, token) {
  const r = await fetch(BASE + '/api' + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  return { status: r.status, body: d };
}

let serverProc = null;
async function main() {
  // ---- 1. fresh database from schema.sql, exactly as the README documents --
  await admin(`DROP DATABASE IF EXISTS ${DB}`);
  await admin(`DROP ROLE IF EXISTS ${ROLE}`);
  await admin(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${ROLE_PW}'`);
  await admin(`CREATE DATABASE ${DB}`);
  const schemaText = fs.readFileSync(SCHEMA, 'utf8');
  const stage = path.join(require('node:os').tmpdir(), 'aa_bootstrap_schema.sql');
  fs.writeFileSync(stage, schemaText, { mode: 0o644 });
  const adminUrlObj = new URL(ADMIN_URL);
  execFileSync('psql', [
    `postgresql://${adminUrlObj.username || 'postgres'}@${adminUrlObj.hostname}:${adminUrlObj.port || 5432}/${DB}`,
    '-v', 'ON_ERROR_STOP=1', '-q', '-f', stage,
  ], { env: { ...process.env, PGPASSWORD: decodeURIComponent(adminUrlObj.password || '') }, stdio: 'pipe' });

  // ---- 2. documented LEAST-PRIVILEGE grants (DML only — no DDL, no owner) -
  await admin(`GRANT CONNECT ON DATABASE ${DB} TO ${ROLE}`);
  await admin(`GRANT USAGE ON SCHEMA public TO ${ROLE}`, DB);
  await admin(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`, DB);
  await admin(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`, DB);

  // ---- 3. catalog completeness — every column/table the runtime reads -----
  const need = [
    ['users', 'ui_theme_custom'], ['battles', 'voting_ends_at'],
    ['user_profiles', 'avatar_data'], ['battle_rooms', 'bracket'],
  ];
  for (const [t, col] of need) {
    const r = await asApp(
      `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2`, [t, col]);
    assert.equal(r.rowCount, 1, `fresh schema missing ${t}.${col}`);
  }
  for (const t of ['team_drafts', 'team_draft_members', 'rematch_requests', 'premium_subscriptions',
                   'twitch_connections', 'twitch_stream_sessions', 'youtube_connections', 'youtube_broadcasts',
                   'friend_requests', 'friendships']) {
    const r = await asApp(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [t]);
    assert.equal(r.rowCount, 1, `fresh schema missing table ${t}`);
  }
  for (const idx of ['battle_votes_pkey', 'idx_battle_votes_battle', 'uq_one_active_seat_per_user',
                     'uq_one_challenge_per_battle', 'uq_one_result_per_battle', 'uq_randomizer_element_name']) {
    const r = await asApp(`SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=$1`, [idx]);
    assert.equal(r.rowCount, 1, `fresh schema missing index ${idx}`);
  }
  const fk = await asApp(`SELECT confdeltype FROM pg_constraint
    WHERE conname='matchmaking_queue_matched_room_id_fkey' AND conrelid='matchmaking_queue'::regclass`);
  assert.equal(fk.rowCount, 1, 'fresh schema missing matchmaking_queue matched_room_id FK');
  assert.equal(fk.rows[0].confdeltype, 'n', 'matched_room_id FK must be ON DELETE SET NULL');
  for (const v of ['premium_activated', 'team_invitation', 'mm_team_invite', 'battle_result', 'rematch_request']) {
    const r = await asApp(`SELECT 1 FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid
      WHERE t.typname='notification_type' AND e.enumlabel=$1`, [v]);
    assert.equal(r.rowCount, 1, `fresh schema missing notification_type value '${v}'`);
  }
  // least privilege is real: the app role must NOT be able to run DDL
  await assert.rejects(() => asApp(`CREATE TABLE aa_should_fail (id int)`), /permission denied/,
    'app role unexpectedly has DDL rights — test must prove least privilege');
  console.log('PASS fresh schema.sql catalog complete; app role is DML-only');

  // ---- 4. the REAL server boots on the fresh DB with the DML-only role ----
  serverProc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: APP_URL, PORT: String(PORT), NODE_ENV: 'development', MAIL_PROVIDER: 'dev' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bootLog = '';
  serverProc.stdout.on('data', (d) => { bootLog += d; });
  serverProc.stderr.on('data', (d) => { bootLog += d; });
  let health = null;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try { health = (await http('GET', '/health')).body; if (health && health.ok) break; } catch (_) {}
  }
  assert(health && health.ok, 'server never became healthy on the fresh bootstrap DB:\n' + bootLog.slice(-2000));
  assert.equal(health.schema, 'ok', 'health probe reports incomplete schema on fresh bootstrap: ' + health.schema);
  assert.equal(health.db, 'up');
  console.log('PASS server boot on fresh DB: /api/health {ok:true, schema:"ok"}');

  // ---- 5. login works end-to-end (the ui_theme_custom regression) ---------
  const uname = 'bootstrap_' + Date.now();
  const reg = await http('POST', '/auth/register', { username: uname, email: uname + '@example.test', password: 'BootstrapTest123!' });
  assert.equal(reg.status, 201, 'register failed: ' + JSON.stringify(reg.body));
  const login = await http('POST', '/auth/login', { login: uname, password: 'BootstrapTest123!' });
  assert.equal(login.status, 200, 'login failed (ui_theme_custom regression?): ' + JSON.stringify(login.body));
  assert(login.body.session_token, 'login returned no session token');
  const me = await http('GET', '/auth/me', undefined, login.body.session_token);
  assert.equal(me.status, 200, '/auth/me failed: ' + JSON.stringify(me.body));
  console.log('PASS register/login/me on fresh bootstrap (ui_theme_custom present)');

  // ---- 6. sweeper-shaped + vocabulary queries run under the DML-only role -
  await asApp(`SELECT id, status, voting_ends_at FROM battles
                WHERE status='judging' AND voting_ends_at IS NOT NULL AND voting_ends_at <= now() LIMIT 1`);
  const notif = await asApp(
    `INSERT INTO notifications (user_id, type, payload) VALUES ($1,'mm_team_invite','{}'::jsonb) RETURNING id`,
    [reg.body.user.id]);
  assert.equal(notif.rowCount, 1, 'mm_team_invite notification insert failed');
  await asApp(`DELETE FROM notifications WHERE id = $1`, [notif.rows[0].id]);
  console.log('PASS sweeper query + new notification vocabulary under DML-only role');
}
main()
  .then(() => console.log('PASS schema bootstrap: fresh schema.sql + least-privilege role is runtime-complete'))
  .catch((e) => { console.error('FAIL:', e.message); process.exitCode = 1; })
  .finally(async () => {
    if (serverProc) serverProc.kill('SIGTERM');
    try { await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); } catch (_) {}
    try { await admin(`DROP ROLE IF EXISTS ${ROLE}`); } catch (_) {}
  });
