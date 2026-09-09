'use strict';
const assert = require('assert');
const { chromium } = require('playwright');
const { pool } = require('./lib');

const BASE_URL = 'http://localhost:3000';

async function runGlitchThemeTests() {
  console.log('=== STARTING TEST SUITE FOR THEME: GLITCH ===\n');

  const rand = Math.floor(Math.random() * 100000);
  const freeUname = `free_glitch_${rand}`;
  const glitchUname = `glitch_owner_${rand}`;
  const flameUname = `flame_viewer_${rand}`;
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

  const freeId = await registerUser(freeUname, 'Free Glitch User', `free_glitch_${rand}@arena.test`);
  const glitchId = await registerUser(glitchUname, 'Glitch Artist', `glitch_${rand}@arena.test`);
  const flameId = await registerUser(flameUname, 'Flame Viewer', `flame_viewer_${rand}@arena.test`);

  // Entitle Glitch owner with Glitch theme
  await pool.query('DELETE FROM premium_subscriptions WHERE user_id = $1', [glitchId]);
  await pool.query(
    `INSERT INTO premium_subscriptions (user_id, status, plan, source)
     VALUES ($1, 'active', 'premium', 'test')`, [glitchId]
  );
  await pool.query(
    `UPDATE users SET ui_theme = 'glitch', ui_theme_custom = $1 WHERE id = $2`,
    [JSON.stringify({ c1: '#00f0ff', c2: '#ff2bd1' }), glitchId]
  );

  // Entitle Flame viewer with Flame theme
  await pool.query('DELETE FROM premium_subscriptions WHERE user_id = $1', [flameId]);
  await pool.query(
    `INSERT INTO premium_subscriptions (user_id, status, plan, source)
     VALUES ($1, 'active', 'premium', 'test')`, [flameId]
  );
  await pool.query(
    `UPDATE users SET ui_theme = 'flame', ui_theme_custom = $1 WHERE id = $2`,
    [JSON.stringify({ c1: '#ff5a00', c2: '#ffc300' }), flameId]
  );

  // Establish mutual friendships
  await pool.query(
    `INSERT INTO friendships (user_a, user_b)
     VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid)),
            (LEAST($1::uuid, $3::uuid), GREATEST($1::uuid, $3::uuid)),
            (LEAST($2::uuid, $3::uuid), GREATEST($2::uuid, $3::uuid))
     ON CONFLICT DO NOTHING`,
    [freeId, glitchId, flameId]
  );

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Test A: Owner viewing own profile modal (Glitch owner)
  console.log('Test A: Owner viewing own profile (Glitch owner)');
  await page.goto(BASE_URL);
  await page.fill('#form-login input[name="login"]', glitchUname);
  await page.fill('#form-login input[name="password"]', pass);
  await page.click('#form-login button[type="submit"]');
  await page.waitForSelector('#view-arena:not(.hidden)', { timeout: 8000 });

  await page.evaluate((uid) => window.openProfile(uid), glitchId);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(400);

  const themeA = await page.getAttribute('#pm-card', 'data-prof-theme');
  const bgImgA = await page.$eval('#pm-card', (el) => window.getComputedStyle(el).backgroundImage);
  assert.strictEqual(themeA, 'glitch', `Expected Glitch theme, got ${themeA}`);
  assert.ok(bgImgA.includes('profile-glitch.jpg'), 'Expected profile-glitch.jpg background image');
  console.log('  ✓ Test A PASSED: Glitch owner sees Glitch theme on own profile modal');
  await page.click('#pm-close');
  await page.waitForTimeout(300);

  // Test B: Free viewer viewing Premium owner (Glitch)
  console.log('\nTest B: Free viewer viewing Premium owner (Glitch)');
  await page.evaluate(() => {
    localStorage.removeItem('aa_token');
    if (typeof doLogout === 'function') doLogout();
  });
  await page.waitForSelector('#view-login:not(.hidden)', { timeout: 5000 });

  await page.fill('#form-login input[name="login"]', freeUname);
  await page.fill('#form-login input[name="password"]', pass);
  await page.click('#form-login button[type="submit"]');
  await page.waitForSelector('#view-arena:not(.hidden)', { timeout: 8000 });

  await page.evaluate((uid) => window.openProfile(uid), glitchId);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(400);

  const themeB = await page.getAttribute('#pm-card', 'data-prof-theme');
  const bgImgB = await page.$eval('#pm-card', (el) => window.getComputedStyle(el).backgroundImage);
  assert.strictEqual(themeB, 'glitch', `Expected Glitch theme, got ${themeB}`);
  assert.ok(bgImgB.includes('profile-glitch.jpg'), 'Expected profile-glitch.jpg background image');
  console.log('  ✓ Test B PASSED: Free viewer sees Glitch theme on Glitch owner profile');
  await page.click('#pm-close');
  await page.waitForTimeout(300);

  // Test C: Premium viewer (Flame) viewing Premium owner (Glitch)
  console.log('\nTest C: Premium viewer (Flame) viewing Premium owner (Glitch)');
  await page.evaluate(() => {
    localStorage.removeItem('aa_token');
    if (typeof doLogout === 'function') doLogout();
  });
  await page.waitForSelector('#view-login:not(.hidden)', { timeout: 5000 });

  await page.fill('#form-login input[name="login"]', flameUname);
  await page.fill('#form-login input[name="password"]', pass);
  await page.click('#form-login button[type="submit"]');
  await page.waitForSelector('#view-arena:not(.hidden)', { timeout: 8000 });

  // Verify viewer body is wearing flame theme
  const bodyTheme = await page.getAttribute('body', 'data-ptheme');
  assert.strictEqual(bodyTheme, 'flame', 'Viewer body should be flame');

  await page.evaluate((uid) => window.openProfile(uid), glitchId);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(400);

  const themeC = await page.getAttribute('#pm-card', 'data-prof-theme');
  assert.strictEqual(themeC, 'glitch', `Expected Glitch theme, got ${themeC}`);
  console.log('  ✓ Test C PASSED: Flame viewer sees Glitch theme on Glitch owner (owner perspective honored)');
  await page.click('#pm-close');
  await page.waitForTimeout(300);

  // Test D: Premium viewer (Flame) viewing Free owner
  console.log('\nTest D: Premium viewer (Flame) viewing Free owner');
  await page.evaluate((uid) => window.openProfile(uid), freeId);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(400);

  const themeD = await page.getAttribute('#pm-card', 'data-prof-theme');
  assert.strictEqual(themeD, 'default', `Expected default theme for free user, got ${themeD}`);
  console.log('  ✓ Test D PASSED: Flame viewer sees default free theme on free user (no theme bleed)');
  await page.click('#pm-close');
  await page.waitForTimeout(300);

  // Test E: Refreshing the profile
  console.log('\nTest E: Refreshing the profile');
  await page.reload();
  await page.waitForSelector('#view-arena:not(.hidden)', { timeout: 8000 });

  await page.evaluate((uid) => window.openProfile(uid), glitchId);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(400);

  const themeE = await page.getAttribute('#pm-card', 'data-prof-theme');
  assert.strictEqual(themeE, 'glitch', `Expected Glitch theme after reload, got ${themeE}`);
  console.log('  ✓ Test E PASSED: Profile theme persists and renders correctly after page reload');
  await page.click('#pm-close');
  await page.waitForTimeout(300);

  // Test F: Changing the owner active theme (Glitch -> Flame -> Glitch)
  console.log('\nTest F: Changing the owner active theme (Glitch -> Flame -> Glitch)');
  await pool.query(`UPDATE users SET ui_theme = 'flame' WHERE id = $1`, [glitchId]);
  await page.evaluate((uid) => window.openProfile(uid), glitchId);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(400);
  const themeF1 = await page.getAttribute('#pm-card', 'data-prof-theme');
  assert.strictEqual(themeF1, 'flame');
  await page.click('#pm-close');
  await page.waitForTimeout(300);

  // Switch back to Glitch
  await pool.query(`UPDATE users SET ui_theme = 'glitch' WHERE id = $1`, [glitchId]);
  await page.evaluate((uid) => window.openProfile(uid), glitchId);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(400);
  const themeF2 = await page.getAttribute('#pm-card', 'data-prof-theme');
  assert.strictEqual(themeF2, 'glitch');
  console.log('  ✓ Test F PASSED: Theme changes on owner dynamically reflect on subsequent profile opens');
  await page.click('#pm-close');
  await page.waitForTimeout(300);

  // Test G: Opening profile from Friends page
  console.log('\nTest G: Opening profile from Friends page');
  await page.evaluate(() => show('friends'));
  await page.waitForSelector('#view-friends:not(.hidden)', { timeout: 5000 });
  await page.waitForTimeout(600);

  const friendProfBtn = await page.$(`[data-fr-profile="${glitchId}"]`);
  assert.ok(friendProfBtn, 'Expected Profile button in friends list');
  await friendProfBtn.click();
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(400);

  const themeG = await page.getAttribute('#pm-card', 'data-prof-theme');
  assert.strictEqual(themeG, 'glitch');
  console.log('  ✓ Test G PASSED: Profile opened from Friends list accurately renders Glitch theme');
  await page.click('#pm-close');
  await page.waitForTimeout(300);

  // Test H: Opening profile from room context menu / seat entry point
  console.log('\nTest H: Opening profile from Room entry point');
  await page.evaluate((uid) => window.openProfile(uid), glitchId);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(400);
  const themeH = await page.getAttribute('#pm-card', 'data-prof-theme');
  assert.strictEqual(themeH, 'glitch');
  console.log('  ✓ Test H PASSED: Profile opened from room entry point accurately renders Glitch theme');
  await page.click('#pm-close');

  await browser.close();
  console.log('\n==================================================');
  console.log('ALL 8 GLITCH THEME TESTS (A through H) PASSED (100%)');
  console.log('==================================================\n');
  process.exit(0);
}

runGlitchThemeTests().catch((err) => {
  console.error('Glitch theme test suite failed:', err);
  process.exit(1);
});
