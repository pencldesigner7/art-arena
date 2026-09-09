'use strict';
const { chromium } = require('playwright');
const { pool } = require('./lib');

const BASE_URL = 'http://localhost:3000';

async function inspectLiveRendering() {
  const rand = Math.floor(Math.random() * 1000000);
  const userA_uname = `userA_prem_${rand}`;
  const userB_uname = `userB_free_${rand}`;
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

  const userA_id = await registerUser(userA_uname, 'User A (Glowing)', `usera_${rand}@arena.test`);
  const userB_id = await registerUser(userB_uname, 'User B (Free)', `userb_${rand}@arena.test`);

  console.log(`User A (Owner) ID: ${userA_id}, username: ${userA_uname}`);
  console.log(`User B (Viewer) ID: ${userB_id}, username: ${userB_uname}`);

  // Entitle User A with Glowing theme
  await pool.query(
    `INSERT INTO premium_subscriptions (user_id, status, plan, source)
     VALUES ($1, 'active', 'premium', 'test')`, [userA_id]
  );
  await pool.query(
    `UPDATE users SET ui_theme = 'glowing', ui_theme_custom = $1 WHERE id = $2`,
    [JSON.stringify({ c1: '#6ed4bf', c2: '#51a8d9' }), userA_id]
  );

  // Make User A and User B friends so User B sees User A in Friends list
  await pool.query(
    `INSERT INTO friendships (user_a, user_b)
     VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid))`,
    [userA_id, userB_id]
  );

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Log in as User B (Free viewer)
  await page.goto(BASE_URL);
  await page.fill('#form-login input[name="login"]', userB_uname);
  await page.fill('#form-login input[name="password"]', pass);
  await page.click('#form-login button[type="submit"]');
  await page.waitForSelector('#view-arena:not(.hidden)', { timeout: 8000 });

  // Navigate to Friends page
  await page.evaluate(() => show('friends'));
  await page.waitForSelector('#view-friends:not(.hidden)', { timeout: 5000 });
  await page.waitForTimeout(500);

  // Click the "Profile" button for User A in Friends list
  const profileBtn = page.locator(`button[data-fr-profile="${userA_id}"]`);
  await profileBtn.click();
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(500);

  // Take screenshot
  await page.screenshot({ path: 'debug_userB_viewing_userA.png' });

  // Inspect DOM and computed styles
  const inspection = await page.evaluate(() => {
    const card = document.querySelector('#pm-card');
    const badge = document.querySelector('#pm-prem-badge');
    const title = document.querySelector('#pm-title');
    const body = document.querySelector('body');
    const html = document.documentElement;

    const cardStyles = window.getComputedStyle(card);
    const titleStyles = window.getComputedStyle(title);

    return {
      body_data_ptheme: body.getAttribute('data-ptheme'),
      html_data_theme: html.getAttribute('data-theme'),
      html_data_visual: html.getAttribute('data-visual'),
      card_data_prof_theme: card.getAttribute('data-prof-theme'),
      card_style_pm_c1: card.style.getPropertyValue('--pm-c1'),
      card_style_pm_c2: card.style.getPropertyValue('--pm-c2'),
      badge_hidden: badge.classList.contains('hidden'),
      card_bg_image: cardStyles.backgroundImage,
      card_bg_color: cardStyles.backgroundColor,
      card_border: cardStyles.border,
      card_box_shadow: cardStyles.boxShadow,
      card_border_radius: cardStyles.borderRadius,
      title_color: titleStyles.color,
      title_font_family: titleStyles.fontFamily,
      card_innerHTML: card.innerHTML,
    };
  });

  console.log('\n--- LIVE INSPECTION RESULTS ---');
  console.log(JSON.stringify(inspection, null, 2));

  await browser.close();
  process.exit(0);
}

inspectLiveRendering().catch((err) => {
  console.error(err);
  process.exit(1);
});
