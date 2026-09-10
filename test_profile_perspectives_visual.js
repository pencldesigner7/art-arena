'use strict';
const assert = require('assert');
const { chromium } = require('playwright');
const { pool } = require('./lib');

const BASE_URL = 'http://localhost:3000';

async function runVisualPerspectiveVerification() {
  console.log('================================================================');
  console.log('  STARTING PRODUCTION PROFILE VISUAL PERSPECTIVE VERIFICATION   ');
  console.log('================================================================\n');

  const rand = Math.floor(Math.random() * 1000000);
  const freeUname = `free_vis_${rand}`;
  const flameUname = `flame_vis_${rand}`;
  const cloudUname = `cloud_vis_${rand}`;
  const glowUname = `glow_vis_${rand}`;
  const pixelUname = `pixel_vis_${rand}`;
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
  const cloudId = await registerUser(cloudUname, 'Cloud Artist', `cloud_${rand}@arena.test`);
  const glowId = await registerUser(glowUname, 'Glow Artist', `glow_${rand}@arena.test`);
  const pixelId = await registerUser(pixelUname, 'Pixel Artist', `pixel_${rand}@arena.test`);

  // Entitle Premium subscriptions in database
  for (const [id, th, custom] of [
    [flameId, 'flame', { c1: '#ff5a00', c2: '#ffc300' }],
    [cloudId, 'cloud', null],
    [glowId, 'glowing', { c1: '#6ed4bf', c2: '#51a8d9' }],
    [pixelId, 'pixel', null],
  ]) {
    await pool.query(
      `INSERT INTO premium_subscriptions (user_id, status, plan, source)
       VALUES ($1, 'active', 'premium', 'test')`, [id]
    );
    await pool.query(
      `UPDATE users SET ui_theme = $1, ui_theme_custom = $2 WHERE id = $3`,
      [th, custom ? JSON.stringify(custom) : null, id]
    );
  }

  // Create mutual friendships so all users appear in friends list
  const allIds = [freeId, flameId, cloudId, glowId, pixelId];
  for (let i = 0; i < allIds.length; i++) {
    for (let j = i + 1; j < allIds.length; j++) {
      await pool.query(
        `INSERT INTO friendships (user_a, user_b)
         VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid))
         ON CONFLICT DO NOTHING`,
        [allIds[i], allIds[j]]
      );
    }
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Helper to extract computed styles of profile modal
  async function getModalComputedStyles() {
    return await page.evaluate(() => {
      const card = document.querySelector('#pm-card');
      const badge = document.querySelector('#pm-prem-badge');
      const friendBtn = document.querySelector('#pm-friend');
      const statCell = document.querySelector('#pm-body .prof-stat-cell');
      const sCard = card ? window.getComputedStyle(card) : {};
      const sStat = statCell ? window.getComputedStyle(statCell) : {};
      const sBtn = friendBtn ? window.getComputedStyle(friendBtn) : {};
      return {
        themeAttr: card ? card.getAttribute('data-prof-theme') : null,
        cardBgImg: sCard.backgroundImage,
        cardBgColor: sCard.backgroundColor,
        cardBorderRadius: sCard.borderRadius,
        cardBorder: sCard.border,
        cardBoxShadow: sCard.boxShadow,
        badgeVisible: badge ? !badge.classList.contains('hidden') : false,
        friendBtnText: friendBtn ? friendBtn.textContent.trim() : '',
        friendBtnBorder: sBtn.border,
        friendBtnColor: sBtn.color,
        statBorder: sStat.border,
      };
    });
  }

  // --------------------------------------------------------------------------
  // SCENARIO 1: Free Viewer opens Premium Flame Owner
  // --------------------------------------------------------------------------
  console.log('--- SCENARIO 1: Free Viewer -> Premium Flame Owner ---');
  await page.goto(BASE_URL);
  await page.fill('#form-login input[name="login"]', freeUname);
  await page.fill('#form-login input[name="password"]', pass);
  await page.click('#form-login button[type="submit"]');
  await page.waitForSelector('#view-arena:not(.hidden)', { timeout: 8000 });

  // Navigate to Friends tab
  await page.evaluate(() => show('friends'));
  await page.waitForSelector('#view-friends:not(.hidden)', { timeout: 5000 });
  await page.waitForTimeout(400);

  // Click on Flame owner row
  await page.click(`.fr-row[data-uid="${flameId}"] button[data-fr-profile]`);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(500);

  const res1 = await getModalComputedStyles();
  console.log('Scenario 1 Visual DOM state:', {
    themeAttr: res1.themeAttr,
    cardBgImg: res1.cardBgImg,
    cardBorderRadius: res1.cardBorderRadius,
  });

  assert.strictEqual(res1.themeAttr, 'flame', 'Profile card must have data-prof-theme="flame"');
  assert.ok(res1.cardBgImg.includes('profile-flame.png'), 'Profile card background must load profile-flame.png');
  assert.strictEqual(res1.cardBorderRadius, '44px', 'Flame profile card border-radius must be 44px');
  console.log('  ✓ SCENARIO 1 PASSED: Free viewer visually renders Flame owner profile correctly\n');

  // Close modal
  await page.click('#pm-close');
  await page.waitForTimeout(400);

  // --------------------------------------------------------------------------
  // SCENARIO 2: Free Viewer opens Premium Cloud Owner
  // --------------------------------------------------------------------------
  console.log('--- SCENARIO 2: Free Viewer -> Premium Cloud Owner ---');
  await page.click(`.fr-row[data-uid="${cloudId}"] button[data-fr-profile]`);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(500);

  const res2 = await getModalComputedStyles();
  console.log('Scenario 2 Visual DOM state:', {
    themeAttr: res2.themeAttr,
    cardBgImg: res2.cardBgImg,
    cardBorderRadius: res2.cardBorderRadius,
    badgeVisible: res2.badgeVisible,
  });

  assert.strictEqual(res2.themeAttr, 'cloud', 'Profile card must have data-prof-theme="cloud"');
  assert.ok(res2.cardBgImg.includes('profile-cloud.jpg'), 'Profile card background must load profile-cloud.jpg');
  assert.strictEqual(res2.cardBorderRadius, '44px', 'Cloud profile card border-radius must be 44px');
  assert.strictEqual(res2.badgeVisible, true, 'Premium diamond badge must be visible on Cloud profile');
  console.log('  ✓ SCENARIO 2 PASSED: Free viewer visually renders Cloud owner profile correctly\n');

  // Close modal
  await page.click('#pm-close');
  await page.waitForTimeout(400);

  // --------------------------------------------------------------------------
  // SCENARIO 3: Premium Viewer (Pixel) opens Premium Flame Owner
  // --------------------------------------------------------------------------
  console.log('--- SCENARIO 3: Premium Pixel Viewer -> Premium Flame Owner ---');
  // Log out Free user and log in as Pixel user
  await page.evaluate(() => {
    localStorage.removeItem('aa_token');
    if (typeof doLogout === 'function') doLogout();
  });
  await page.waitForSelector('#view-login:not(.hidden)', { timeout: 5000 });

  await page.fill('#form-login input[name="login"]', pixelUname);
  await page.fill('#form-login input[name="password"]', pass);
  await page.click('#form-login button[type="submit"]');
  await page.waitForSelector('#view-arena:not(.hidden)', { timeout: 8000 });

  // Verify body theme is pixel
  const viewerTheme = await page.getAttribute('body', 'data-ptheme');
  assert.strictEqual(viewerTheme, 'pixel', 'Viewer body must have data-ptheme="pixel"');

  // Navigate to friends
  await page.evaluate(() => show('friends'));
  await page.waitForSelector('#view-friends:not(.hidden)', { timeout: 5000 });
  await page.waitForTimeout(400);

  // Open Flame owner
  await page.click(`.fr-row[data-uid="${flameId}"] button[data-fr-profile]`);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(500);

  const res3 = await getModalComputedStyles();
  console.log('Scenario 3 Visual DOM state:', {
    viewerTheme,
    cardThemeAttr: res3.themeAttr,
    cardBgImg: res3.cardBgImg,
    cardBorderRadius: res3.cardBorderRadius,
  });

  assert.strictEqual(res3.themeAttr, 'flame', 'Owner Flame theme must be rendered, NOT viewer Pixel theme');
  assert.ok(res3.cardBgImg.includes('profile-flame.png'), 'Flame background must be rendered');
  assert.strictEqual(res3.cardBorderRadius, '44px', 'Border-radius must be 44px (Flame), not 0px (Pixel)');
  console.log('  ✓ SCENARIO 3 PASSED: Pixel viewer sees Flame theme on Flame owner (owner controls theme)\n');

  // Close modal
  await page.click('#pm-close');
  await page.waitForTimeout(400);

  // --------------------------------------------------------------------------
  // SCENARIO 4: Premium Viewer (Pixel) opens Premium Cloud Owner
  // --------------------------------------------------------------------------
  console.log('--- SCENARIO 4: Premium Pixel Viewer -> Premium Cloud Owner ---');
  await page.click(`.fr-row[data-uid="${cloudId}"] button[data-fr-profile]`);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(500);

  const res4 = await getModalComputedStyles();
  console.log('Scenario 4 Visual DOM state:', {
    viewerTheme,
    cardThemeAttr: res4.themeAttr,
    cardBgImg: res4.cardBgImg,
    cardBorderRadius: res4.cardBorderRadius,
  });

  assert.strictEqual(res4.themeAttr, 'cloud', 'Owner Cloud theme must be rendered');
  assert.ok(res4.cardBgImg.includes('profile-cloud.jpg'), 'Cloud background must be rendered');
  assert.strictEqual(res4.cardBorderRadius, '44px', 'Border-radius must be 44px (Cloud), not 0px (Pixel)');
  console.log('  ✓ SCENARIO 4 PASSED: Pixel viewer sees Cloud theme on Cloud owner\n');

  // Close modal
  await page.click('#pm-close');
  await page.waitForTimeout(400);

  // --------------------------------------------------------------------------
  // SCENARIO 5: Premium Viewer (Pixel) opens Free Owner
  // --------------------------------------------------------------------------
  console.log('--- SCENARIO 5: Premium Pixel Viewer -> Free Owner (Zero Theme Bleed) ---');
  await page.click(`.fr-row[data-uid="${freeId}"] button[data-fr-profile]`);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(500);

  const res5 = await getModalComputedStyles();
  console.log('Scenario 5 Visual DOM state:', {
    viewerTheme,
    cardThemeAttr: res5.themeAttr,
    cardBgImg: res5.cardBgImg,
    cardBgColor: res5.cardBgColor,
    cardBorderRadius: res5.cardBorderRadius,
    badgeVisible: res5.badgeVisible,
  });

  assert.strictEqual(res5.themeAttr, 'default', 'Free user card must have data-prof-theme="default"');
  assert.strictEqual(res5.cardBgImg, 'none', 'Free user card background-image must be none');
  assert.strictEqual(res5.cardBorderRadius, '14px', 'Free user border-radius must be 14px (not 0px from Pixel)');
  assert.strictEqual(res5.badgeVisible, false, 'Premium diamond badge must be hidden for Free user');
  console.log('  ✓ SCENARIO 5 PASSED: Pixel viewer viewing Free owner renders standard Free theme (no theme bleed)\n');

  // Close modal
  await page.click('#pm-close');
  await page.waitForTimeout(400);

  // --------------------------------------------------------------------------
  // SCENARIO 6: User viewing their own profile
  // --------------------------------------------------------------------------
  console.log('--- SCENARIO 6: User viewing own profile ---');
  // Open own profile modal
  await page.evaluate((uid) => window.openProfile(uid), pixelId);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(500);

  const res6 = await getModalComputedStyles();
  console.log('Scenario 6 Visual DOM state:', {
    cardThemeAttr: res6.themeAttr,
    cardBgImg: res6.cardBgImg,
    friendBtnText: res6.friendBtnText,
  });

  assert.strictEqual(res6.themeAttr, 'pixel', 'Own profile modal must render own active theme (Pixel)');
  assert.ok(res6.cardBgImg.includes('profile-pixel.jpg'), 'Pixel background must be rendered');
  assert.strictEqual(res6.friendBtnText, 'This is you', 'Button text must be "This is you"');
  console.log('  ✓ SCENARIO 6 PASSED: User viewing own profile correctly displays own theme and "This is you"\n');

  // Close modal
  await page.click('#pm-close');
  await page.waitForTimeout(400);

  // --------------------------------------------------------------------------
  // SCENARIO 7: Sequential Profile Transitions (No Stuck Themes)
  // --------------------------------------------------------------------------
  console.log('--- SCENARIO 7: Sequential Profile Transitions (Flame -> Cloud -> Free) ---');
  // 1. Open Flame
  await page.click(`.fr-row[data-uid="${flameId}"] button[data-fr-profile]`);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(400);
  const seq1 = await getModalComputedStyles();
  assert.strictEqual(seq1.themeAttr, 'flame');
  assert.ok(seq1.cardBgImg.includes('profile-flame.png'));
  await page.click('#pm-close');
  await page.waitForTimeout(400);

  // 2. Open Cloud immediately
  await page.click(`.fr-row[data-uid="${cloudId}"] button[data-fr-profile]`);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(400);
  const seq2 = await getModalComputedStyles();
  assert.strictEqual(seq2.themeAttr, 'cloud');
  assert.ok(seq2.cardBgImg.includes('profile-cloud.jpg'));
  await page.click('#pm-close');
  await page.waitForTimeout(400);

  // 3. Open Free immediately
  await page.click(`.fr-row[data-uid="${freeId}"] button[data-fr-profile]`);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(400);
  const seq3 = await getModalComputedStyles();
  assert.strictEqual(seq3.themeAttr, 'default');
  assert.strictEqual(seq3.cardBgImg, 'none');
  await page.click('#pm-close');
  await page.waitForTimeout(400);

  console.log('  ✓ SCENARIO 7 PASSED: Sequential profile transitions immediately swap themes with zero sticking\n');

  await browser.close();
  console.log('================================================================');
  console.log('  ALL VISUAL PERSPECTIVE & RENDERING CHECKS PASSED (100%)       ');
  console.log('================================================================\n');
  process.exit(0);
}

runVisualPerspectiveVerification().catch((err) => {
  console.error('Visual Perspective Verification Failed:', err);
  process.exit(1);
});
