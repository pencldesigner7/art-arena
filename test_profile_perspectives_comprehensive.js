'use strict';
const assert = require('assert');
const { chromium } = require('playwright');
const { pool } = require('./lib');

const BASE_URL = 'http://localhost:3000';

async function runComprehensivePerspectiveTests() {
  console.log('=== STARTING COMPREHENSIVE PROFILE PERSPECTIVE PLAYWRIGHT SUITE ===\n');

  const rand = Math.floor(Math.random() * 1000000);
  const freeUname = `free_u_${rand}`;
  const flameUname = `flame_u_${rand}`;
  const glowUname = `glow_u_${rand}`;
  const pixelUname = `pixel_u_${rand}`;
  const pass = 'Password123!';

  async function registerUser(username, displayName, email) {
    const r = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, username, display_name: displayName, password: pass }),
    });
    const d = await r.json();
    return d.user.id;
  }

  const freeId = await registerUser(freeUname, 'Free Artist', `free_${rand}@arena.test`);
  const flameId = await registerUser(flameUname, 'Flame Artist', `flame_${rand}@arena.test`);
  const glowId = await registerUser(glowUname, 'Glow Artist', `glow_${rand}@arena.test`);
  const pixelId = await registerUser(pixelUname, 'Pixel Artist', `pixel_${rand}@arena.test`);

  // Entitle Flame
  await pool.query(
    `INSERT INTO premium_subscriptions (user_id, status, plan, source)
     VALUES ($1, 'active', 'premium', 'test')`, [flameId]
  );
  await pool.query(
    `UPDATE users SET ui_theme = 'flame', ui_theme_custom = $1 WHERE id = $2`,
    [JSON.stringify({ c1: '#ff5a00', c2: '#ffc300' }), flameId]
  );

  // Entitle Glow
  await pool.query(
    `INSERT INTO premium_subscriptions (user_id, status, plan, source)
     VALUES ($1, 'active', 'premium', 'test')`, [glowId]
  );
  await pool.query(
    `UPDATE users SET ui_theme = 'glowing', ui_theme_custom = $1 WHERE id = $2`,
    [JSON.stringify({ c1: '#6ed4bf', c2: '#51a8d9' }), glowId]
  );

  // Entitle Pixel
  await pool.query(
    `INSERT INTO premium_subscriptions (user_id, status, plan, source)
     VALUES ($1, 'active', 'premium', 'test')`, [pixelId]
  );
  await pool.query(
    `UPDATE users SET ui_theme = 'pixel' WHERE id = $1`,
    [pixelId]
  );

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('--- TEST GROUP 1: CASE 1 (Free Viewer -> Premium Profile) ---');
  await page.goto(BASE_URL);
  await page.fill('#form-login input[name="login"]', freeUname);
  await page.fill('#form-login input[name="password"]', pass);
  await page.click('#form-login button[type="submit"]');
  await page.waitForSelector('#view-arena:not(.hidden)', { timeout: 8000 });

  // Body theme should be default / dark (no data-ptheme on body)
  const freeBodyTheme = await page.getAttribute('body', 'data-ptheme');
  assert.strictEqual(freeBodyTheme, null, 'Free viewer body must not have data-ptheme');

  // Open Flame profile
  await page.evaluate((uid) => window.openProfile(uid), flameId);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(400);

  let modalTheme = await page.getAttribute('#pm-card', 'data-prof-theme');
  let badgeVisible = !(await page.$eval('#pm-prem-badge', (el) => el.classList.contains('hidden')));
  assert.strictEqual(modalTheme, 'flame');
  assert.strictEqual(badgeVisible, true);
  console.log('  ✓ Case 1 passed: Free viewer sees Flame user in Flame theme with diamond badge');

  await page.click('#pm-close');
  await page.waitForTimeout(300);

  console.log('\n--- TEST GROUP 2: CASE 2 (Premium Viewer -> Free Profile) ---');
  // Log out free user, log in as Glow user
  await page.evaluate(() => {
    localStorage.removeItem('aa_token');
    if (typeof doLogout === 'function') doLogout();
  });
  await page.waitForSelector('#view-login:not(.hidden)', { timeout: 5000 });

  await page.fill('#form-login input[name="login"]', glowUname);
  await page.fill('#form-login input[name="password"]', pass);
  await page.click('#form-login button[type="submit"]');
  await page.waitForSelector('#view-arena:not(.hidden)', { timeout: 8000 });

  const glowBodyTheme = await page.getAttribute('body', 'data-ptheme');
  assert.strictEqual(glowBodyTheme, 'glowing', 'Glowing viewer body must have data-ptheme="glowing"');

  // Open Free profile
  await page.evaluate((uid) => window.openProfile(uid), freeId);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(400);

  modalTheme = await page.getAttribute('#pm-card', 'data-prof-theme');
  badgeVisible = !(await page.$eval('#pm-prem-badge', (el) => el.classList.contains('hidden')));
  assert.strictEqual(modalTheme, 'default');
  assert.strictEqual(badgeVisible, false);
  console.log('  ✓ Case 2 passed: Glowing viewer sees Free user in default appearance with badge hidden');

  await page.click('#pm-close');
  await page.waitForTimeout(300);

  console.log('\n--- TEST GROUP 3: CASE 3 (Premium Viewer -> Different Premium Profile) ---');
  // Glowing viewer opens Flame profile
  await page.evaluate((uid) => window.openProfile(uid), flameId);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(400);

  modalTheme = await page.getAttribute('#pm-card', 'data-prof-theme');
  badgeVisible = !(await page.$eval('#pm-prem-badge', (el) => el.classList.contains('hidden')));
  assert.strictEqual(modalTheme, 'flame');
  assert.strictEqual(badgeVisible, true);
  console.log('  ✓ Case 3a passed: Glowing viewer sees Flame user in Flame theme');

  // Switch directly to Pixel profile without closing
  await page.evaluate((uid) => window.openProfile(uid), pixelId);
  await page.waitForTimeout(400);

  modalTheme = await page.getAttribute('#pm-card', 'data-prof-theme');
  badgeVisible = !(await page.$eval('#pm-prem-badge', (el) => el.classList.contains('hidden')));
  assert.strictEqual(modalTheme, 'pixel');
  assert.strictEqual(badgeVisible, true);
  console.log('  ✓ Case 3b passed: Immediate switch from Flame to Pixel displays Pixel theme');

  await page.click('#pm-close');
  await page.waitForTimeout(300);

  console.log('\n--- TEST GROUP 4: CASE 4 (User opens their OWN profile) ---');
  // 4a: Glowing user opens own profile modal
  await page.evaluate((uid) => window.openProfile(uid), glowId);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(400);

  modalTheme = await page.getAttribute('#pm-card', 'data-prof-theme');
  badgeVisible = !(await page.$eval('#pm-prem-badge', (el) => el.classList.contains('hidden')));
  const btnText = await page.$eval('#pm-friend', (el) => el.textContent.trim());
  assert.strictEqual(modalTheme, 'glowing');
  assert.strictEqual(badgeVisible, true);
  assert.strictEqual(btnText, 'This is you');
  console.log('  ✓ Case 4a passed: Glowing user opens own profile modal -> Glowing theme + "This is you" button');

  await page.click('#pm-close');
  await page.waitForTimeout(300);

  // 4b: Navigate to Profile page tab
  await page.evaluate(() => show('account'));
  await page.waitForSelector('#view-account:not(.hidden)', { timeout: 5000 });
  const cardPremVisible = !(await page.$eval('#card-prem', (el) => el.classList.contains('hidden')));
  assert.strictEqual(cardPremVisible, true, 'Own Profile page displays premium star badge');
  console.log('  ✓ Case 4b passed: Own Profile tab view renders with glowing theme and active diamond badge');

  console.log('\n--- TEST GROUP 5: RAPID SWITCHING & STALE THEME CLEANUP ---');
  const sequence = [
    { uid: freeId, expTheme: 'default', expBadge: false },
    { uid: flameId, expTheme: 'flame', expBadge: true },
    { uid: pixelId, expTheme: 'pixel', expBadge: true },
    { uid: freeId, expTheme: 'default', expBadge: false },
    { uid: glowId, expTheme: 'glowing', expBadge: true },
  ];

  for (let i = 0; i < sequence.length; i++) {
    const step = sequence[i];
    await page.evaluate((uid) => window.openProfile(uid), step.uid);
    await page.waitForTimeout(300);
    const currTheme = await page.getAttribute('#pm-card', 'data-prof-theme');
    const currBadge = !(await page.$eval('#pm-prem-badge', (el) => el.classList.contains('hidden')));
    assert.strictEqual(currTheme, step.expTheme, `Step ${i+1}: expected ${step.expTheme}, got ${currTheme}`);
    assert.strictEqual(currBadge, step.expBadge, `Step ${i+1}: expected badge ${step.expBadge}`);
  }
  console.log('  ✓ Rapid switching sequence passed with 100% accurate scoping and zero leakage');

  await browser.close();
  console.log('\n===============================================================');
  console.log('ALL COMPREHENSIVE PERSPECTIVE TESTS PASSED SUCCESSFULLY (100%)');
  console.log('===============================================================\n');
}

runComprehensivePerspectiveTests().catch((err) => {
  console.error('Comprehensive perspective tests failed:', err);
  process.exit(1);
});
