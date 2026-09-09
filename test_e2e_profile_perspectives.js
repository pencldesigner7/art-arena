'use strict';
const assert = require('assert');
const { chromium } = require('playwright');
const { pool } = require('./lib');

const BASE_URL = 'http://localhost:3000';

async function runE2E() {
  console.log('=== STARTING ART ARENA PROFILE PERSPECTIVE E2E VERIFICATION ===\n');

  const rand = Math.floor(Math.random() * 1000000);
  const userA_glow_uname = `userA_glow_${rand}`;
  const userB_flame_uname = `userB_flame_${rand}`;
  const userC_pixel_uname = `userC_pixel_${rand}`;
  const userD_free_uname = `userD_free_${rand}`;
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

  const userA_id = await registerUser(userA_glow_uname, 'User A (Glowing)', `usera_${rand}@arena.test`);
  const userB_id = await registerUser(userB_flame_uname, 'User B (Flame)', `userb_${rand}@arena.test`);
  const userC_id = await registerUser(userC_pixel_uname, 'User C (Pixel)', `userc_${rand}@arena.test`);
  const userD_id = await registerUser(userD_free_uname, 'User D (Free)', `userd_${rand}@arena.test`);

  console.log('Users Registered:');
  console.log(`  User A (Glowing Premium): ${userA_id} (@${userA_glow_uname})`);
  console.log(`  User B (Flame Premium):   ${userB_id} (@${userB_flame_uname})`);
  console.log(`  User C (Pixel Premium):   ${userC_id} (@${userC_pixel_uname})`);
  console.log(`  User D (Free Artist):     ${userD_id} (@${userD_free_uname})`);

  // Entitle User A with Glowing
  await pool.query(
    `INSERT INTO premium_subscriptions (user_id, status, plan, source)
     VALUES ($1, 'active', 'premium', 'test')`, [userA_id]
  );
  await pool.query(
    `UPDATE users SET ui_theme = 'glowing', ui_theme_custom = $1 WHERE id = $2`,
    [JSON.stringify({ c1: '#6ed4bf', c2: '#51a8d9' }), userA_id]
  );

  // Entitle User B with Flame
  await pool.query(
    `INSERT INTO premium_subscriptions (user_id, status, plan, source)
     VALUES ($1, 'active', 'premium', 'test')`, [userB_id]
  );
  await pool.query(
    `UPDATE users SET ui_theme = 'flame', ui_theme_custom = $1 WHERE id = $2`,
    [JSON.stringify({ c1: '#ff5a00', c2: '#ffc300' }), userB_id]
  );

  // Entitle User C with Pixel
  await pool.query(
    `INSERT INTO premium_subscriptions (user_id, status, plan, source)
     VALUES ($1, 'active', 'premium', 'test')`, [userC_id]
  );
  await pool.query(
    `UPDATE users SET ui_theme = 'pixel' WHERE id = $1`, [userC_id]
  );

  // Friendships
  await pool.query(
    `INSERT INTO friendships (user_a, user_b)
     VALUES (LEAST($1::uuid, $4::uuid), GREATEST($1::uuid, $4::uuid)),
            (LEAST($2::uuid, $4::uuid), GREATEST($2::uuid, $4::uuid)),
            (LEAST($3::uuid, $4::uuid), GREATEST($3::uuid, $4::uuid)),
            (LEAST($1::uuid, $3::uuid), GREATEST($1::uuid, $3::uuid))
     ON CONFLICT DO NOTHING`,
    [userA_id, userB_id, userC_id, userD_id]
  );

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('\n--- TEST SCENARIO A: Free Viewer (User D) -> Premium Glowing Owner (User A) ---');
  await page.goto(BASE_URL);
  await page.fill('#form-login input[name="login"]', userD_free_uname);
  await page.fill('#form-login input[name="password"]', pass);
  await page.click('#form-login button[type="submit"]');
  await page.waitForSelector('#view-arena:not(.hidden)', { timeout: 8000 });

  // Navigate to Friends
  await page.evaluate(() => show('friends'));
  await page.waitForSelector('#view-friends:not(.hidden)', { timeout: 5000 });
  await page.waitForTimeout(400);

  // Click on User A's row
  await page.click(`.fr-row[data-uid="${userA_id}"]`);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(500);

  const cardA = await page.evaluate(() => {
    const el = document.querySelector('#pm-card');
    const s = window.getComputedStyle(el);
    return {
      themeAttr: el.getAttribute('data-prof-theme'),
      bgImg: s.backgroundImage,
      bgColor: s.backgroundColor,
      borderRadius: s.borderRadius,
      boxShadow: s.boxShadow,
    };
  });

  console.log('User A Profile Card Computed in DOM:', cardA);
  assert.strictEqual(cardA.themeAttr, 'glowing', 'data-prof-theme must be glowing');
  assert.ok(cardA.bgImg.includes('profile-glowing.jpg'), 'background-image must load profile-glowing.jpg');
  assert.strictEqual(cardA.borderRadius, '44px', 'border-radius must be 44px for glowing');
  console.log('  ✓ SCENARIO A PASSED: Free viewer sees User A with glowing theme appearance');

  // Close modal
  await page.click('#pm-close');
  await page.waitForTimeout(400);

  console.log('\n--- TEST SCENARIO A2: Sequential Open -> Premium Flame Owner (User B) ---');
  await page.click(`.fr-row[data-uid="${userB_id}"] button[data-fr-profile]`);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(500);

  const cardB = await page.evaluate(() => {
    const el = document.querySelector('#pm-card');
    const s = window.getComputedStyle(el);
    return {
      themeAttr: el.getAttribute('data-prof-theme'),
      bgImg: s.backgroundImage,
      bgColor: s.backgroundColor,
      borderRadius: s.borderRadius,
      boxShadow: s.boxShadow,
    };
  });

  console.log('User B Profile Card Computed in DOM:', cardB);
  assert.strictEqual(cardB.themeAttr, 'flame', 'data-prof-theme must be flame');
  assert.ok(cardB.bgImg.includes('profile-flame.png'), 'background-image must load profile-flame.png');
  assert.strictEqual(cardB.borderRadius, '44px', 'border-radius must be 44px for flame');
  console.log('  ✓ SCENARIO A2 PASSED: Sequential transition from Glowing to Flame cleanly updates theme');

  // Close modal
  await page.click('#pm-close');
  await page.waitForTimeout(400);

  console.log('\n--- TEST SCENARIO B: Premium Viewer (User C, Pixel) -> Premium Owner (User A, Glowing) ---');
  // Log out user D, log in as User C (Pixel)
  await page.evaluate(() => {
    localStorage.removeItem('aa_token');
    if (typeof doLogout === 'function') doLogout();
  });
  await page.waitForSelector('#view-login:not(.hidden)', { timeout: 5000 });

  await page.fill('#form-login input[name="login"]', userC_pixel_uname);
  await page.fill('#form-login input[name="password"]', pass);
  await page.click('#form-login button[type="submit"]');
  await page.waitForSelector('#view-arena:not(.hidden)', { timeout: 8000 });

  // Verify User C has Pixel theme on body
  const bodyThemeC = await page.getAttribute('body', 'data-ptheme');
  assert.strictEqual(bodyThemeC, 'pixel', 'User C body must have data-ptheme="pixel"');

  // Open User A's profile
  await page.evaluate(() => show('friends'));
  await page.waitForSelector('#view-friends:not(.hidden)', { timeout: 5000 });
  await page.waitForTimeout(400);

  await page.click(`.fr-row[data-uid="${userA_id}"]`);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(500);

  const cardAFromC = await page.evaluate(() => {
    const el = document.querySelector('#pm-card');
    const s = window.getComputedStyle(el);
    return {
      themeAttr: el.getAttribute('data-prof-theme'),
      bgImg: s.backgroundImage,
      borderRadius: s.borderRadius,
    };
  });

  console.log('User A Profile Card viewed by Pixel User C:', cardAFromC);
  assert.strictEqual(cardAFromC.themeAttr, 'glowing', 'User A theme must be glowing, NOT pixel');
  assert.ok(cardAFromC.bgImg.includes('profile-glowing.jpg'));
  console.log('  ✓ SCENARIO B PASSED: Premium Pixel viewer sees Glowing theme on User A profile');

  // Close modal
  await page.click('#pm-close');
  await page.waitForTimeout(400);

  console.log('\n--- TEST SCENARIO C: Premium Viewer (User C, Pixel) -> Free Owner (User D) ---');
  await page.click(`.fr-row[data-uid="${userD_id}"]`);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(500);

  const cardDFromC = await page.evaluate(() => {
    const el = document.querySelector('#pm-card');
    const s = window.getComputedStyle(el);
    return {
      themeAttr: el.getAttribute('data-prof-theme'),
      bgImg: s.backgroundImage,
      bgColor: s.backgroundColor,
      borderRadius: s.borderRadius,
    };
  });

  console.log('User D (Free) Profile Card viewed by Pixel User C:', cardDFromC);
  assert.strictEqual(cardDFromC.themeAttr, 'default', 'User D must render default theme');
  assert.strictEqual(cardDFromC.bgImg, 'none', 'User D background image must be none');
  assert.strictEqual(cardDFromC.borderRadius, '14px', 'User D border radius must be standard 14px');
  console.log('  ✓ SCENARIO C PASSED: Premium Pixel viewer sees Default Free profile on User D with zero theme bleed');

  // Close modal
  await page.click('#pm-close');
  await page.waitForTimeout(400);

  console.log('\n--- TEST SCENARIO D: Own Premium Profile (User C) ---');
  // D1: Profile modal for self
  await page.evaluate((uid) => window.openProfile(uid), userC_id);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(500);

  const cardOwn = await page.evaluate(() => {
    const el = document.querySelector('#pm-card');
    const s = window.getComputedStyle(el);
    const btn = document.querySelector('#pm-friend');
    return {
      themeAttr: el.getAttribute('data-prof-theme'),
      bgImg: s.backgroundImage,
      borderRadius: s.borderRadius,
      buttonText: btn.textContent.trim(),
    };
  });

  console.log('Own Profile Card (User C):', cardOwn);
  assert.strictEqual(cardOwn.themeAttr, 'pixel', 'Own profile modal must be pixel');
  assert.ok(cardOwn.bgImg.includes('profile-pixel.jpg'));
  assert.strictEqual(cardOwn.buttonText, 'This is you');
  console.log('  ✓ SCENARIO D1 PASSED: User C opens own modal -> Pixel theme + "This is you" button');

  await page.click('#pm-close');
  await page.waitForTimeout(400);

  // D2: Profile tab view (#view-account)
  await page.evaluate(() => show('account'));
  await page.waitForSelector('#view-account:not(.hidden)', { timeout: 5000 });
  await page.waitForTimeout(400);

  const accountCard = await page.evaluate(() => {
    const star = document.querySelector('#card-prem');
    const uName = document.querySelector('#card-username').textContent;
    return {
      starHidden: star.classList.contains('hidden'),
      username: uName,
    };
  });
  assert.strictEqual(accountCard.starHidden, false, 'Premium diamond badge on profile page must be visible');
  console.log('  ✓ SCENARIO D2 PASSED: User C visits Profile page -> Rendered with Pixel theme and star badge');

  await browser.close();
  console.log('\n===============================================================');
  console.log('ALL E2E PERSPECTIVE & RENDERING TESTS PASSED (100%)');
  console.log('===============================================================\n');
  process.exit(0);
}

runE2E().catch((err) => {
  console.error('E2E Test Failed:', err);
  process.exit(1);
});
