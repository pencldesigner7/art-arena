'use strict';
// ============================================================================
// FIX 3 (items 2+3): PREMIUM TEST-MODE OPT-IN REGRESSION TEST.
//   - PREMIUM_TEST_MODE unset  -> /api/premium/test-activate is 403 (and
//                                 /api/premium/status reports test_mode:false)
//   - PREMIUM_TEST_MODE=0      -> 403
//   - PREMIUM_TEST_MODE=1      -> activation works (200, active:true),
//                                 revocation works, and the Premium
//                                 entitlement gate (themes) behaves normally.
// The endpoints must REMAIN present in every mode (403, never 404).
//
// Run against the disposable LOCAL database + no other server needed (this
// test spawns its own short-lived instances on ports 3122-3124):
//   DATABASE_URL=postgresql://...@127.0.0.1/... node server/tests/premium-mode.js
// ============================================================================
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// v74 fix: the spawned servers used to INHERIT the battery's shared
// DATABASE_URL, re-running boot migrations (incl. randomizer pool wipes)
// against the DB other suites use — flaking room-regressions. premium-mode
// now builds its own disposable DB and spawns servers against it only.
const ADMIN_URL = process.env.TEST_PG_ADMIN_URL;
assert(ADMIN_URL, 'TEST_PG_ADMIN_URL required (admin role for the disposable DB)');
assert(['localhost', '127.0.0.1'].includes(new URL(ADMIN_URL).hostname), 'Local TEST_PG_ADMIN_URL required');
const PDB = 'aa_premium_mode_db';
const PROLE = 'aa_premium_mode';
const PPW = 'premium-mode-pw';
const APP_URL = `postgresql://${PROLE}:${PPW}@127.0.0.1:5432/${PDB}`;
function psqlAdmin(url, args) {
  const u = new URL(url);
  execFileSync('psql', [u.toString(), ...args], {
    env: { ...process.env, PGPASSWORD: decodeURIComponent(u.password || '') }, stdio: 'pipe',
  });
}
psqlAdmin(ADMIN_URL, ['-c', `DROP DATABASE IF EXISTS ${PDB}`]);
psqlAdmin(ADMIN_URL, ['-c', `DROP ROLE IF EXISTS ${PROLE}`]);
psqlAdmin(ADMIN_URL, ['-c', `CREATE ROLE ${PROLE} LOGIN PASSWORD '${PPW}'`]);
psqlAdmin(ADMIN_URL, ['-c', `CREATE DATABASE ${PDB}`]);
psqlAdmin(ADMIN_URL, ['-c', `GRANT CONNECT ON DATABASE ${PDB} TO ${PROLE}`]);
{
  const u = new URL(ADMIN_URL); u.pathname = '/' + PDB;
  const stage = path.join(os.tmpdir(), 'aa_premium_mode_schema.sql');
  fs.writeFileSync(stage, fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'), { mode: 0o644 });
  psqlAdmin(u, ['-v', 'ON_ERROR_STOP=1', '-q', '-f', stage]);
  psqlAdmin(u, ['-c', `GRANT USAGE ON SCHEMA public TO ${PROLE}; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${PROLE}; GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${PROLE};`]);
}

function startServer(port, extraEnv) {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: APP_URL, PORT: String(port), NODE_ENV: 'development', MAIL_PROVIDER: 'dev', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  return {
    proc,
    async ready() {
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const r = await fetch(`http://127.0.0.1:${port}/api/health`);
          if (r.ok) return;
        } catch (_) {}
      }
      throw new Error(`server on ${port} never became healthy:\n${log.slice(-1500)}`);
    },
    stop() { proc.kill('SIGTERM'); },
  };
}
async function api(port, u, p, body, method) {
  const r = await fetch(`http://127.0.0.1:${port}/api` + p, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json', ...(u ? { Authorization: 'Bearer ' + u } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  return { status: r.status, body: d };
}
async function newUser(port) {
  const name = 'premmode_' + randomBytes(5).toString('hex');
  const password = 'PremiumMode123!';
  const reg = await api(port, null, '/auth/register', { username: name, email: name + '@example.test', password });
  assert.equal(reg.status, 201, 'register: ' + JSON.stringify(reg.body));
  const login = await api(port, null, '/auth/login', { login: name, password });
  assert.equal(login.status, 200, 'login: ' + JSON.stringify(login.body));
  return login.body.session_token;
}

const cases = [
  { label: 'PREMIUM_TEST_MODE unset', env: {}, testMode: false, activate: 403 },
  { label: 'PREMIUM_TEST_MODE=0', env: { PREMIUM_TEST_MODE: '0' }, testMode: false, activate: 403 },
  { label: 'PREMIUM_TEST_MODE=1', env: { PREMIUM_TEST_MODE: '1' }, testMode: true, activate: 200 },
];
(async () => {
  let port = 3122;
  for (const c of cases) {
    const srv = startServer(port, c.env);
    try {
      await srv.ready();
      const token = await newUser(port);
      const status = await api(port, token, '/premium/status');
      assert.equal(status.status, 200, c.label + ': status route missing');
      assert.equal(status.body.test_mode, c.testMode, c.label + ': /premium/status test_mode wrong');
      const act = await api(port, token, '/premium/test-activate', {});
      assert.equal(act.status, c.activate, c.label + ': test-activate status ' + act.status + ' ' + JSON.stringify(act.body));
      if (c.activate === 403) {
        // endpoint must REMAIN present (403, not 404) and grant nothing
        const themes = await api(port, token, '/premium/themes');
        assert.equal(themes.status, 200);
        assert.equal(themes.body.premium, false, c.label + ': user is premium without activation!');
        const put = await api(port, token, '/premium/theme', { theme: 'chrome' }, 'PUT');
        assert.equal(put.status, 403, c.label + ': premium theme PUT must stay gated');
        console.log('PASS ' + c.label + ' — self-grant rejected (403), entitlement stays locked, endpoint present');
      } else {
        assert.equal(act.body.active, true, c.label + ': activation did not grant premium');
        // legitimate premium behaviour preserved: entitlement gate opens,
        // revoke works (the same opt-in flag guards it), gate closes again.
        const put = await api(port, token, '/premium/theme', { theme: 'chrome' }, 'PUT');
        assert.equal(put.status, 200, c.label + ': premium theme PUT should work while active');
        const rev = await api(port, token, '/premium/test-revoke', {});
        assert.equal(rev.status, 200, c.label + ': revoke failed while enabled');
        assert.equal(rev.body.active, false, c.label + ': revoke did not end the entitlement');
        const put2 = await api(port, token, '/premium/theme', { theme: 'chrome' }, 'PUT');
        assert.equal(put2.status, 403, c.label + ': theme gate must close after revocation');
        console.log('PASS ' + c.label + ' — controlled activation/revocation works; entitlement gate consistent (re-roll reads the same premiumOf)');
      }
    } finally { srv.stop(); }
    port += 1;
  }
  console.log('PASS premium test-mode is opt-in; default deployments cannot self-grant premium');
})().catch((e) => { console.error('FAIL:', e.message); process.exitCode = 1; });
