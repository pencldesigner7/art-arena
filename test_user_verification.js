'use strict';
const assert = require('assert');
const { chromium } = require('playwright');
const { pool } = require('./lib');

const BASE_URL = 'http://localhost:3000';

async function runVerification() {
  console.log('=== STARTING ART ARENA PROFILE OWNER PERSPECTIVE SUITE ===\n');

  const rand = Math.floor(Math.random() * 1000000);
  const freeUname = `free_viewer_${rand}`;
  const flameUname = `prem_flame_${rand}`;
  const glowUname = `prem_glow_${rand}`;
  const pixelUname = `prem_pixel_${rand}`;
  const pass = 'Password123!';

  const consoleErrors = [];

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
  const glowId = await registerUser(glowUname, 'Glowing Artist', `glow_${rand}@arena.test`);
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
    `UPDATE users SET ui_theme = 'pixel' WHERE id = $1`, [pixelId]
  );

  // Establish friendships between all pairs
  const uids = [freeId, flameId, glowId, pixelId];
  for (let i = 0; i < uids.length; i++) {
    for (let j = i + 1; j < uids.length; j++) {
      await pool.query(
        `INSERT INTO friendships (user_a, user_b)
         VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid))
         ON CONFLICT DO NOTHING`,
        [uids[i], uids[j]]
      );
    }
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  page.on('pageerror', (err) => {
    consoleErrors.push(err.message);
  });

  console.log('--- TEST A: Free viewer -> Premium owner (Glowing) ---');
  await page.goto(BASE_URL);
  await page.fill('#form-login input[name="login"]', freeUname);
  await page.fill('#form-login input[name="password"]', pass);
  await page.click('#form-login button[type="submit"]');
  await page.waitForSelector('#view-arena:not(.hidden)', { timeout: 8000 });

  // Open Glowing owner profile from friends list
  await page.evaluate(() => show('friends'));
  await page.waitForSelector('#view-friends:not(.hidden)', { timeout: 5000 });
  await page.waitForTimeout(400);

  await page.click(`.fr-row[data-uid="${glowId}"]`);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(400);

  const domA = await page.evaluate(() => {
    const card = document.querySelector('#pm-card');
    const s = window.getComputedStyle(card);
    return {
      ownerId: window.pmUserId,
      themeAttr: card.getAttribute('data-prof-theme'),
      bgImg: s.backgroundImage,
      bgColor: s.backgroundColor,
      borderRadius: s.borderRadius,
      boxShadow: s.boxShadow,
    };
  });
  console.log('Test A DOM Results:', domA);
  assert.strictEqual(domA.themeAttr, 'glowing');
  assert.ok(domA.bgImg.includes('profile-glowing.jpg'));
  console.log('  ✓ Test A Passed: Free viewer sees Glowing theme appearance on Premium owner');

  // Close modal
  await page.click('#pm-close');
  await page.waitForTimeout(400);

  console.log('\n--- TEST B: Premium viewer (Pixel) -> Premium owner (Flame) ---');
  // Log out Free user, log in as Pixel user
  await page.evaluate(() => {
    localStorage.removeItem('aa_token');
    if (typeof doLogout === 'function') doLogout();
  });
  await page.waitForSelector('#view-login:not(.hidden)', { timeout: 5000 });

  await page.fill('#form-login input[name="login"]', pixelUname);
  await page.fill('#form-login input[name="password"]', pass);
  await page.click('#form-login button[type="submit"]');
  await page.waitForSelector('#view-arena:not(.hidden)', { timeout: 8000 });

  // Open Flame owner profile
  await page.evaluate(() => show('friends'));
  await page.waitForSelector('#view-friends:not(.hidden)', { timeout: 5000 });
  await page.waitForTimeout(400);

  await page.click(`.fr-row[data-uid="${flameId}"]`);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(400);

  const domB = await page.evaluate(() => {
    const card = document.querySelector('#pm-card');
    const s = window.getComputedStyle(card);
    return {
      ownerId: window.pmUserId,
      themeAttr: card.getAttribute('data-prof-theme'),
      bgImg: s.backgroundImage,
      borderRadius: s.borderRadius,
    };
  });
  console.log('Test B DOM Results:', domB);
  assert.strictEqual(domB.themeAttr, 'flame');
  assert.ok(domB.bgImg.includes('profile-flame.png'));
  console.log('  ✓ Test B Passed: Pixel viewer sees Flame theme on Flame owner (owner controls theme)');

  // Close modal
  await page.click('#pm-close');
  await page.waitForTimeout(400);

  console.log('\n--- TEST C: Premium viewer (Pixel) -> Free owner ---');
  await page.click(`.fr-row[data-uid="${freeId}"]`);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(400);

  const domC = await page.evaluate(() => {
    const card = document.querySelector('#pm-card');
    const s = window.getComputedStyle(card);
    return {
      ownerId: window.pmUserId,
      themeAttr: card.getAttribute('data-prof-theme'),
      bgImg: s.backgroundImage,
      bgColor: s.backgroundColor,
      borderRadius: s.borderRadius,
    };
  });
  console.log('Test C DOM Results:', domC);
  assert.strictEqual(domC.themeAttr, 'default');
  assert.strictEqual(domC.bgImg, 'none');
  assert.strictEqual(domC.borderRadius, '14px');
  console.log('  ✓ Test C Passed: Pixel viewer sees default appearance on Free owner (zero theme bleed)');

  // Close modal
  await page.click('#pm-close');
  await page.waitForTimeout(400);

  console.log('\n--- TEST D: Own Premium profile (Pixel) ---');
  await page.evaluate((uid) => window.openProfile(uid), pixelId);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(400);

  const domD = await page.evaluate(() => {
    const card = document.querySelector('#pm-card');
    const s = window.getComputedStyle(card);
    const btn = document.querySelector('#pm-friend');
    return {
      ownerId: window.pmUserId,
      themeAttr: card.getAttribute('data-prof-theme'),
      bgImg: s.backgroundImage,
      borderRadius: s.borderRadius,
      buttonText: btn.textContent.trim(),
    };
  });
  console.log('Test D DOM Results:', domD);
  assert.strictEqual(domD.themeAttr, 'pixel');
  assert.ok(domD.bgImg.includes('profile-pixel.jpg'));
  assert.strictEqual(domD.buttonText, 'This is you');
  console.log('  ✓ Test D Passed: User viewing own profile sees own Pixel appearance');

  await page.click('#pm-close');
  await page.waitForTimeout(400);

  console.log('\n--- TEST: User A -> Close -> User B Theme Switch ---');
  // Open User A (Glowing)
  await page.click(`.fr-row[data-uid="${glowId}"]`);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(400);
  let switchA = await page.getAttribute('#pm-card', 'data-prof-theme');
  assert.strictEqual(switchA, 'glowing');

  // Close
  await page.click('#pm-close');
  await page.waitForTimeout(400);

  // Open User B (Flame)
  await page.click(`.fr-row[data-uid="${flameId}"]`);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(400);
  let switchB = await page.getAttribute('#pm-card', 'data-prof-theme');
  assert.strictEqual(switchB, 'flame');
  console.log('  ✓ Theme Switch Passed: Glowing theme cleanly replaced by Flame theme without caching/sticking');

  await page.click('#pm-close');
  await page.waitForTimeout(400);

  console.log('\n--- TEST: Page Refresh & Re-verify ---');
  await page.reload();
  await page.waitForSelector('#view-arena:not(.hidden)', { timeout: 8000 });
  await page.evaluate(() => show('friends'));
  await page.waitForSelector('#view-friends:not(.hidden)', { timeout: 5000 });
  await page.waitForTimeout(400);

  await page.click(`.fr-row[data-uid="${glowId}"]`);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(400);

  const reloadTheme = await page.getAttribute('#pm-card', 'data-prof-theme');
  assert.strictEqual(reloadTheme, 'glowing');
  console.log('  ✓ Page Refresh Passed: Theme correctly loads after browser refresh');

  await browser.close();

  console.log('\nConsole Errors Logged during session:', consoleErrors.length);
  if (consoleErrors.length > 0) {
    console.log('Errors:', consoleErrors);
  }

  console.log('\n===============================================================');
  console.log('ALL VERIFICATION TESTS COMPLETED SUCCESSFULLY (100% PASS)');
  console.log('===============================================================\n');
  process.exit(0);
}

runVerification().catch((err) => {
  console.error(err);
  process.exit(1);
});
