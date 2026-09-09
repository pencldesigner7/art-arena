'use strict';
const assert = require('assert');
const { chromium } = require('playwright');
const { pool } = require('./lib');

const BASE_URL = 'http://localhost:3000';

async function runBrowserTests() {
  console.log('=== STARTING PLAYWRIGHT BROWSER PERSPECTIVE VERIFICATION ===\n');

  const rand = Math.floor(Math.random() * 100000);
  const freeUname = `free_br_${rand}`;
  const flameUname = `flame_br_${rand}`;
  const glowUname = `glow_br_${rand}`;
  const pass = 'Password123!';

  // Helper to register via API
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

  // Entitle Flame user with Flame theme
  await pool.query(
    `INSERT INTO premium_subscriptions (user_id, status, plan, source)
     VALUES ($1, 'active', 'premium', 'test')`, [flameId]
  );
  await pool.query(
    `UPDATE users SET ui_theme = 'flame', ui_theme_custom = $1 WHERE id = $2`,
    [JSON.stringify({ c1: '#ff5a00', c2: '#ffc300' }), flameId]
  );

  // Entitle Glow user with Glowing theme
  await pool.query(
    `INSERT INTO premium_subscriptions (user_id, status, plan, source)
     VALUES ($1, 'active', 'premium', 'test')`, [glowId]
  );
  await pool.query(
    `UPDATE users SET ui_theme = 'glowing', ui_theme_custom = $1 WHERE id = $2`,
    [JSON.stringify({ c1: '#6ed4bf', c2: '#51a8d9' }), glowId]
  );

  // Make them friends so they can view profiles easily
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

  console.log('Test 1: Free viewer viewing Flame user profile');
  await page.goto(BASE_URL);
  // Log in as free user
  await page.fill('#form-login input[name="login"]', freeUname);
  await page.fill('#form-login input[name="password"]', pass);
  await page.click('#form-login button[type="submit"]');
  await page.waitForSelector('#view-arena:not(.hidden)', { timeout: 8000 });

  // Open Flame user's profile modal directly using window.openProfile
  await page.evaluate((uid) => window.openProfile(uid), flameId);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(500);

  const cardTheme1 = await page.getAttribute('#pm-card', 'data-prof-theme');
  const badgeHidden1 = await page.$eval('#pm-prem-badge', (el) => el.classList.contains('hidden'));
  assert.strictEqual(cardTheme1, 'flame', `Expected data-prof-theme to be flame, got ${cardTheme1}`);
  assert.strictEqual(badgeHidden1, false, 'Expected Premium diamond badge to be visible');
  console.log('  ✓ Free viewer renders Flame user profile in Flame theme with diamond badge visible');

  // Close modal
  await page.click('#pm-close');
  await page.waitForTimeout(400);

  // Log out
  await page.evaluate(() => {
    localStorage.removeItem('aa_token');
    if (typeof doLogout === 'function') doLogout();
  });
  await page.waitForSelector('#view-login:not(.hidden)', { timeout: 5000 });

  console.log('\nTest 2: Premium Glowing viewer viewing Free user profile');
  // Log in as Glowing user
  await page.fill('#form-login input[name="login"]', glowUname);
  await page.fill('#form-login input[name="password"]', pass);
  await page.click('#form-login button[type="submit"]');
  await page.waitForSelector('#view-arena:not(.hidden)', { timeout: 8000 });

  // Check that body has Glowing theme
  const bodyTheme = await page.getAttribute('body', 'data-ptheme');
  assert.strictEqual(bodyTheme, 'glowing');

  // Open Free user's profile modal
  await page.evaluate((uid) => window.openProfile(uid), freeId);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(500);

  const cardTheme2 = await page.getAttribute('#pm-card', 'data-prof-theme');
  const badgeHidden2 = await page.$eval('#pm-prem-badge', (el) => el.classList.contains('hidden'));
  assert.strictEqual(cardTheme2, 'default', `Expected Free profile to have data-prof-theme=default, got ${cardTheme2}`);
  assert.strictEqual(badgeHidden2, true, 'Expected Premium diamond badge to be hidden for Free user');
  console.log('  ✓ Glowing viewer viewing Free user renders default theme with diamond badge hidden (no theme bleed)');

  // Close modal
  await page.click('#pm-close');
  await page.waitForTimeout(400);

  console.log('\nTest 3: Premium Glowing viewer viewing Premium Flame user profile');
  // Open Flame user's profile modal
  await page.evaluate((uid) => window.openProfile(uid), flameId);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(500);

  const cardTheme3 = await page.getAttribute('#pm-card', 'data-prof-theme');
  const badgeHidden3 = await page.$eval('#pm-prem-badge', (el) => el.classList.contains('hidden'));
  assert.strictEqual(cardTheme3, 'flame', `Expected Flame owner theme, got ${cardTheme3}`);
  assert.strictEqual(badgeHidden3, false, 'Expected Premium diamond badge to be visible');
  console.log('  ✓ Glowing viewer viewing Flame user renders Flame theme (owner perspective honored)');

  // Close modal
  await page.click('#pm-close');
  await page.waitForTimeout(400);

  console.log('\nTest 4: Dynamic theme switch on owner and re-viewing');
  // Change Flame user's theme to Cloud via DB
  await pool.query(`UPDATE users SET ui_theme = 'cloud' WHERE id = $1`, [flameId]);

  // Glowing user re-opens Flame user's profile
  await page.evaluate((uid) => window.openProfile(uid), flameId);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(500);

  const cardTheme4 = await page.getAttribute('#pm-card', 'data-prof-theme');
  assert.strictEqual(cardTheme4, 'cloud', `Expected Cloud theme after switch, got ${cardTheme4}`);
  console.log('  ✓ Re-opening profile immediately reflects updated theme (Cloud)');

  // Close modal
  await page.click('#pm-close');
  await page.waitForTimeout(400);

  console.log('\nTest 5: Verify all 7 Premium theme attributes and computed CSS on profile card');
  const themeExpectations = {
    flame: { bgAsset: 'profile-flame.png', badgeVisible: true },
    cloud: { bgAsset: 'profile-cloud.jpg', badgeVisible: true },
    glowing: { bgAsset: 'profile-glowing.jpg', badgeVisible: true },
    glitch: { bgAsset: 'profile-glitch.jpg', badgeVisible: true },
    graffiti: { bgAsset: 'profile-graffiti.jpg', badgeVisible: true },
    magazine: { bgAsset: 'profile-magazine.png', badgeVisible: true },
    pixel: { bgAsset: 'profile-pixel.jpg', badgeVisible: true },
  };

  for (const [th, exp] of Object.entries(themeExpectations)) {
    await pool.query(`UPDATE users SET ui_theme = $1 WHERE id = $2`, [th, flameId]);
    await page.evaluate((uid) => window.openProfile(uid), flameId);
    await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
    await page.waitForTimeout(300);

    const thAttr = await page.getAttribute('#pm-card', 'data-prof-theme');
    assert.strictEqual(thAttr, th);

    const computed = await page.$eval('#pm-card', (el) => {
      const s = window.getComputedStyle(el);
      return {
        bgImg: s.backgroundImage,
        bgColor: s.backgroundColor,
      };
    });
    assert.ok(computed.bgImg.includes(exp.bgAsset), `Expected background-image to include ${exp.bgAsset}, got ${computed.bgImg}`);
    
    const isBadgeHidden = await page.$eval('#pm-prem-badge', (el) => el.classList.contains('hidden'));
    assert.strictEqual(isBadgeHidden, !exp.badgeVisible);
    console.log(`  ✓ ${th.toUpperCase()} theme card correctly renders ${exp.bgAsset} background asset & styles`);

    await page.click('#pm-close');
    await page.waitForTimeout(300);
  }

  await browser.close();
  console.log('\n==================================================');
  console.log('ALL PLAYWRIGHT BROWSER TESTS PASSED (100%)');
  console.log('==================================================\n');
  process.exit(0);
}

runBrowserTests().catch((err) => {
  console.error('Playwright browser test failed:', err);
  process.exit(1);
});
