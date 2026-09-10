'use strict';
const { chromium } = require('playwright');
const { pool } = require('./lib');

const BASE_URL = 'http://localhost:3000';

async function captureFlameProfile() {
  const rand = Math.floor(Math.random() * 1000000);
  const flameUname = `pennypops123_${rand}`;
  const viewerUname = `viewer_${rand}`;
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

  const flameId = await registerUser(flameUname, 'pennypops123', `pennypops_${rand}@arena.test`);
  const viewerId = await registerUser(viewerUname, 'Free Viewer', `viewer_${rand}@arena.test`);

  // Entitle Flame User
  await pool.query(
    `INSERT INTO premium_subscriptions (user_id, status, plan, source)
     VALUES ($1, 'active', 'premium', 'test')`, [flameId]
  );
  await pool.query(
    `UPDATE users SET ui_theme = 'flame', ui_theme_custom = $1 WHERE id = $2`,
    [JSON.stringify({ c1: '#ff5a00', c2: '#ffc300' }), flameId]
  );

  // Set stats: 14 battles, 0 wins, 0 losses, 14 draws
  await pool.query(
    `UPDATE user_statistics SET battles = 14, wins = 0, losses = 0, draws = 14 WHERE user_id = $1`,
    [flameId]
  );

  // Set joined_at to 2026-09-02
  await pool.query(
    `UPDATE users SET created_at = '2026-09-02T12:00:00Z' WHERE id = $1`,
    [flameId]
  );

  // Friendship so button shows 'Remove Friend' like the reference image
  await pool.query(
    `INSERT INTO friendships (user_a, user_b)
     VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid))`,
    [flameId, viewerId]
  );

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 600, height: 750 } });
  const page = await context.newPage();

  // Log in as viewer
  await page.goto(BASE_URL);
  await page.fill('#form-login input[name="login"]', viewerUname);
  await page.fill('#form-login input[name="password"]', pass);
  await page.click('#form-login button[type="submit"]');
  await page.waitForSelector('#view-arena:not(.hidden)', { timeout: 8000 });

  // Navigate to Friends page
  await page.evaluate(() => show('friends'));
  await page.waitForSelector('#view-friends:not(.hidden)', { timeout: 5000 });
  await page.waitForTimeout(400);

  // Click on the friend row in Friends list
  await page.click(`.fr-row[data-uid="${flameId}"]`);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(500);

  // Screenshot the card element specifically
  const cardElement = await page.$('#pm-card');
  await cardElement.screenshot({ path: '/home/user/flame_profile_rendered.png' });
  await page.screenshot({ path: '/home/user/flame_modal_full_screen.png' });

  await browser.close();
  console.log('Screenshots saved to /home/user/flame_profile_rendered.png and /home/user/flame_modal_full_screen.png');
  process.exit(0);
}

captureFlameProfile().catch((err) => {
  console.error(err);
  process.exit(1);
});
