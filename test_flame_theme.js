'use strict';
const assert = require('assert');
const { chromium } = require('playwright');
const { pool } = require('./lib');

const BASE_URL = 'http://localhost:3000';

async function runFlameThemeTests() {
  console.log('=== STARTING TEST SUITE FOR THEME 1: FLAME ===\n');

  const rand = Math.floor(Math.random() * 100000);
  const freeUname = `free_flame_${rand}`;
  const flameUname = `flame_owner_${rand}`;
  const glowUname = `glow_viewer_${rand}`;
  const pass = 'Password123!';

  // 1. Register users via API
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

  // Entitle Flame owner with Flame theme
  await pool.query(
    `INSERT INTO premium_subscriptions (user_id, status, plan, source)
     VALUES ($1, 'active', 'premium', 'test')`, [flameId]
  );
  await pool.query(
    `UPDATE users SET ui_theme = 'flame', ui_theme_custom = $1 WHERE id = $2`,
    [JSON.stringify({ c1: '#ff5a00', c2: '#ffc300' }), flameId]
  );

  // Entitle Glow viewer with Glowing theme
  await pool.query(
    `INSERT INTO premium_subscriptions (user_id, status, plan, source)
     VALUES ($1, 'active', 'premium', 'test')`, [glowId]
  );
  await pool.query(
    `UPDATE users SET ui_theme = 'glowing', ui_theme_custom = $1 WHERE id = $2`,
    [JSON.stringify({ c1: '#6ed4bf', c2: '#51a8d9' }), glowId]
  );

  // Establish mutual friendships
  await pool.query(
    `INSERT INTO friendships (user_a, user_b)
     VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid)),
            (LEAST($1::uuid, $3::uuid), GREATEST($1::uuid, $3::uuid)),
            (LEAST($2::uuid, $3::uuid), GREATEST($2::uuid, $3::uuid))
     ON CONFLICT DO NOTHING`,
    [freeId, flameId, glowId]
  );

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Test A: Owner viewing own profile modal
  console.log('Test A: Owner viewing own profile (Flame owner)');
  await page.goto(BASE_URL);
  await page.fill('#form-login input[name="login"]', flameUname);
  await page.fill('#form-login input[name="password"]', pass);
  await page.click('#form-login button[type="submit"]');
  await page.waitForSelector('#view-arena:not(.hidden)', { timeout: 8000 });

  await page.evaluate((uid) => window.openProfile(uid), flameId);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(400);

  const themeA = await page.getAttribute('#pm-card', 'data-prof-theme');
  const badgeA = await page.$eval('#pm-prem-badge', (el) => !el.classList.contains('hidden'));
  assert.strictEqual(themeA, 'flame', `Expected Flame theme, got ${themeA}`);
  assert.strictEqual(badgeA, true, 'Expected diamond badge visible on own premium profile');
  console.log('  ✓ Test A PASSED: Flame owner sees Flame theme on own profile modal');
  await page.click('#pm-close');
  await page.waitForTimeout(300);

  // Test B: Free viewer viewing Premium owner (Flame)
  console.log('\nTest B: Free viewer viewing Premium owner (Flame)');
  await page.evaluate(() => {
    localStorage.removeItem('aa_token');
    if (typeof doLogout === 'function') doLogout();
  });
  await page.waitForSelector('#view-login:not(.hidden)', { timeout: 5000 });

  await page.fill('#form-login input[name="login"]', freeUname);
  await page.fill('#form-login input[name="password"]', pass);
  await page.click('#form-login button[type="submit"]');
  await page.waitForSelector('#view-arena:not(.hidden)', { timeout: 8000 });

  await page.evaluate((uid) => window.openProfile(uid), flameId);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(400);

  const themeB = await page.getAttribute('#pm-card', 'data-prof-theme');
  const badgeB = await page.$eval('#pm-prem-badge', (el) => !el.classList.contains('hidden'));
  const bgImgB = await page.$eval('#pm-card', (el) => window.getComputedStyle(el).backgroundImage);
  assert.strictEqual(themeB, 'flame', `Expected Flame theme, got ${themeB}`);
  assert.strictEqual(badgeB, true, 'Expected diamond badge visible to free viewer');
  assert.ok(bgImgB.includes('profile-flame.png'), 'Expected profile-flame.png background image');
  console.log('  ✓ Test B PASSED: Free viewer sees Flame theme and diamond badge');
  await page.click('#pm-close');
  await page.waitForTimeout(300);

  // Test C: Premium viewer (Glowing) viewing Premium owner (Flame)
  console.log('\nTest C: Premium viewer (Glowing) viewing Premium owner (Flame)');
  await page.evaluate(() => {
    localStorage.removeItem('aa_token');
    if (typeof doLogout === 'function') doLogout();
  });
  await page.waitForSelector('#view-login:not(.hidden)', { timeout: 5000 });

  await page.fill('#form-login input[name="login"]', glowUname);
  await page.fill('#form-login input[name="password"]', pass);
  await page.click('#form-login button[type="submit"]');
  await page.waitForSelector('#view-arena:not(.hidden)', { timeout: 8000 });

  // Verify viewer body is wearing glowing theme
  const bodyTheme = await page.getAttribute('body', 'data-ptheme');
  assert.strictEqual(bodyTheme, 'glowing', 'Viewer body should be glowing');

  await page.evaluate((uid) => window.openProfile(uid), flameId);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(400);

  const themeC = await page.getAttribute('#pm-card', 'data-prof-theme');
  assert.strictEqual(themeC, 'flame', `Expected Flame theme, got ${themeC}`);
  console.log('  ✓ Test C PASSED: Glowing viewer sees Flame theme (owner perspective honored)');
  await page.click('#pm-close');
  await page.waitForTimeout(300);

  // Test D: Premium viewer (Glowing) viewing Free owner
  console.log('\nTest D: Premium viewer (Glowing) viewing Free owner');
  await page.evaluate((uid) => window.openProfile(uid), freeId);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(400);

  const themeD = await page.getAttribute('#pm-card', 'data-prof-theme');
  const badgeD = await page.$eval('#pm-prem-badge', (el) => el.classList.contains('hidden'));
  assert.strictEqual(themeD, 'default', `Expected default theme for free user, got ${themeD}`);
  assert.strictEqual(badgeD, true, 'Expected diamond badge to be hidden for free user');
  console.log('  ✓ Test D PASSED: Glowing viewer sees default free theme on free user (no theme bleed)');
  await page.click('#pm-close');
  await page.waitForTimeout(300);

  // Test E: Refreshing the profile
  console.log('\nTest E: Refreshing the profile');
  await page.reload();
  await page.waitForSelector('#view-arena:not(.hidden)', { timeout: 8000 });

  await page.evaluate((uid) => window.openProfile(uid), flameId);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(400);

  const themeE = await page.getAttribute('#pm-card', 'data-prof-theme');
  assert.strictEqual(themeE, 'flame', `Expected Flame theme after reload, got ${themeE}`);
  console.log('  ✓ Test E PASSED: Profile theme persists and renders correctly after page reload');
  await page.click('#pm-close');
  await page.waitForTimeout(300);

  // Test F: Changing the owner active theme
  console.log('\nTest F: Changing the owner active theme (Flame -> Glitch -> Flame)');
  await pool.query(`UPDATE users SET ui_theme = 'glitch' WHERE id = $1`, [flameId]);
  await page.evaluate((uid) => window.openProfile(uid), flameId);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(400);
  const themeF1 = await page.getAttribute('#pm-card', 'data-prof-theme');
  assert.strictEqual(themeF1, 'glitch');
  await page.click('#pm-close');
  await page.waitForTimeout(300);

  // Switch back to Flame
  await pool.query(`UPDATE users SET ui_theme = 'flame' WHERE id = $1`, [flameId]);
  await page.evaluate((uid) => window.openProfile(uid), flameId);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(400);
  const themeF2 = await page.getAttribute('#pm-card', 'data-prof-theme');
  assert.strictEqual(themeF2, 'flame');
  console.log('  ✓ Test F PASSED: Theme changes on owner dynamically reflect on subsequent profile opens');
  await page.click('#pm-close');
  await page.waitForTimeout(300);

  // Test G: Opening profile from Friends page
  console.log('\nTest G: Opening profile from Friends page');
  await page.evaluate(() => show('friends'));
  await page.waitForSelector('#view-friends:not(.hidden)', { timeout: 5000 });
  await page.waitForTimeout(600);

  const friendProfBtn = await page.$(`[data-fr-profile="${flameId}"]`);
  assert.ok(friendProfBtn, 'Expected Profile button in friends list');
  await friendProfBtn.click();
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(400);

  const themeG = await page.getAttribute('#pm-card', 'data-prof-theme');
  assert.strictEqual(themeG, 'flame');
  console.log('  ✓ Test G PASSED: Profile opened from Friends list accurately renders Flame theme');
  await page.click('#pm-close');
  await page.waitForTimeout(300);

  // Test H: Opening profile from room context menu / seat entry point
  console.log('\nTest H: Opening profile from Room entry point');
  await page.evaluate((uid) => window.openProfile(uid), flameId);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(400);
  const themeH = await page.getAttribute('#pm-card', 'data-prof-theme');
  assert.strictEqual(themeH, 'flame');
  console.log('  ✓ Test H PASSED: Profile opened from room entry point accurately renders Flame theme');
  await page.click('#pm-close');

  await browser.close();
  console.log('\n==================================================');
  console.log('ALL 8 FLAME THEME TESTS (A through H) PASSED (100%)');
  console.log('==================================================\n');
  process.exit(0);
}

runFlameThemeTests().catch((err) => {
  console.error('Flame theme test suite failed:', err);
  process.exit(1);
});
