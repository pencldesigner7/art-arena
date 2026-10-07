'use strict';
// v72: NETWORK GATE — offline visitors stay on the entry screen with a
// themed spinner + error notice; reconnecting proceeds automatically.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const base = 'http://127.0.0.1:3000';
(async () => {
  const b = await chromium.launch();
  try {
    const p = await b.newPage();
    let offline = true;
    await p.route('**/api/**', (r) => (offline ? r.abort() : r.continue()));
    await p.goto(base);
    await p.waitForTimeout(2500);
    const held = await p.evaluate(() => {
      const e = document.getElementById('aa-entry');
      const net = document.getElementById('aa-net');
      return { hold: e.classList.contains('aa-hold'), net: getComputedStyle(net).display !== 'none', spin: !!e.querySelector('.aa-spin') };
    });
    assert.equal(held.hold, true, 'entry holds the user while offline');
    assert.equal(held.net, true, 'connection notice visible');
    assert.equal(held.spin, true, 'themed spinner visible');
    assert.equal(await p.locator('#aa-net-msg').textContent(), 'Checking connection…');
    await p.waitForTimeout(2500); // second failed check → the error notice
    assert.equal(await p.locator('#aa-net-err').isHidden(), false, 'error notice appears');
    assert.match(await p.locator('#aa-net-err').textContent(), /No network connection\. Please check your connection and try again\./);
    offline = false; // reconnect
    await p.waitForFunction(() => {
      const e = document.getElementById('aa-entry');
      return !e || e.classList.contains('aa-done') || getComputedStyle(e).visibility === 'hidden';
    }, { timeout: 20000 });
    // the app is now usable (login page reachable behind the gate)
    await p.waitForSelector('#view-auth, .auth-card, form', { timeout: 10000 }).catch(() => {});
    const done = await p.evaluate(() => document.getElementById('aa-entry').classList.contains('aa-done'));
    assert.equal(done, true, 'overlay fully removed after proceeding');
    console.log('PASS network gate: offline entry hold + spinner + error notice; auto-proceed on reconnect; overlay gone');
  } finally { await b.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
