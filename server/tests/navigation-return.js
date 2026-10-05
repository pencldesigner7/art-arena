'use strict';
// ============================================================================
// FIX 3 (item 5): REAL NAVIGATION-RETURN REGRESSION TEST.
// A real cross-document navigation AWAY from the app, then a real browser
// BACK, must show the entry animation exactly once in the returned document —
// played, not doubled, not skipped, and gone (hidden) when finished.
//
// BFCache note (audited, intentional): the server serves index.html with
// `Cache-Control: no-store` (the v28 stale-tab guard), and Chromium never
// BFCaches no-store pages — so a real back navigation to this app is always
// a fresh document load, which is exactly what this test asserts. The
// `pageshow{persisted:true}` replay handler still exists for environments
// that do restore from BFCache and is covered by the deterministic synthetic
// event in entry-art-motion.js / browser-regressions.js.
// Run against the local app: http://127.0.0.1:3000 (NODE_PATH → Playwright).
// ============================================================================
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const base = 'http://127.0.0.1:3000';
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => {
      window.entryStarts = 0;
      window.pageShows = [];
      document.addEventListener('animationstart', (e) => { if (e.animationName === 'aa-entry-mark') window.entryStarts++; });
      window.addEventListener('pageshow', (e) => window.pageShows.push(e.persisted));
    });
    await page.goto(base);
    await page.waitForTimeout(1700);
    assert.equal(await page.evaluate(() => entryStarts), 1, 'entry must play exactly once on first load');

    // REAL navigation away (cross-document), then a REAL browser back.
    await page.goto(base + '/privacy');
    await page.waitForTimeout(300);
    await page.goBack();
    await page.waitForFunction(() => window.pageShows && window.pageShows.length >= 1, null, { timeout: 15000 });
    await page.waitForTimeout(300);
    // Whichever restoration path the browser takes (fresh load — guaranteed
    // here by no-store — or BFCache), the entry animation must have played
    // exactly once in the returned document.
    assert.equal(await page.evaluate(() => entryStarts), 1, 'entry must play exactly once after a real back navigation');
    assert(await page.evaluate(() => !!document.getElementById('aa-entry')), 'the app document must be back');
    // ...and it must finish: the overlay hides itself, no replay loop.
    await page.waitForTimeout(1600);
    assert.equal(await page.locator('#aa-entry').evaluate((e) => getComputedStyle(e).visibility), 'hidden', 'entry overlay must hide after finishing');
    assert.equal(await page.evaluate(() => entryStarts), 1, 'entry must NOT replay on its own');
    assert.deepEqual(errors, [], 'JS errors: ' + errors.join('; '));
    console.log('PASS real navigation away + browser back: entry plays exactly once and finishes; no replay loop');
  } finally { await browser.close(); }
})().catch((e) => { console.error('FAIL:', e.message); process.exitCode = 1; });
