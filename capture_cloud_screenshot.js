'use strict';
const { chromium } = require('playwright');
const { pool } = require('./lib');

const BASE_URL = 'http://localhost:3000';

async function captureCloudScreenshot() {
  console.log('Capturing Cloud Theme profile modal screenshot...');

  const uname = 'pennypops123';
  const pass = 'Password123!';
  const email = 'pennypops123@arena.test';

  // Ensure user exists
  let userId;
  const userCheck = await pool.query('SELECT id FROM users WHERE username = $1', [uname]);
  if (userCheck.rows.length > 0) {
    userId = userCheck.rows[0].id;
  } else {
    const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, username: uname, display_name: uname, password: pass }),
    });
    const d = await regRes.json();
    userId = d.user.id;
  }

  // Set subscription and cloud theme
  await pool.query('DELETE FROM premium_subscriptions WHERE user_id = $1', [userId]);
  await pool.query(
    `INSERT INTO premium_subscriptions (user_id, status, plan, source)
     VALUES ($1, 'active', 'premium', 'test')`,
    [userId]
  );
  await pool.query(
    `UPDATE users SET ui_theme = 'cloud', created_at = '2026-09-02T12:00:00Z' WHERE id = $1`,
    [userId]
  );
  await pool.query('DELETE FROM user_statistics WHERE user_id = $1', [userId]);
  await pool.query(
    `INSERT INTO user_statistics (user_id, battles, wins, losses, draws)
     VALUES ($1, 14, 0, 0, 14)`,
    [userId]
  );

  const viewerUname = 'arena_viewer';
  let viewerId;
  const viewerCheck = await pool.query('SELECT id FROM users WHERE username = $1', [viewerUname]);
  if (viewerCheck.rows.length > 0) {
    viewerId = viewerCheck.rows[0].id;
  } else {
    const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'viewer@arena.test', username: viewerUname, display_name: 'Viewer', password: pass }),
    });
    const d = await regRes.json();
    viewerId = d.user.id;
  }

  // Establish friendship
  await pool.query(
    `INSERT INTO friendships (user_a, user_b)
     VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid))
     ON CONFLICT DO NOTHING`,
    [userId, viewerId]
  );

  // Launch browser
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1200, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  await page.goto(BASE_URL);
  await page.fill('#form-login input[name="login"]', viewerUname);
  await page.fill('#form-login input[name="password"]', pass);
  await page.click('#form-login button[type="submit"]');
  await page.waitForSelector('#view-arena:not(.hidden)', { timeout: 8000 });

  // Open pennypops123 profile
  await page.evaluate((uid) => window.openProfile(uid), userId);
  await page.waitForSelector('#profile-modal.open', { timeout: 5000 });
  await page.waitForTimeout(600);

  // Take screenshot of the card
  const cardElement = await page.$('#pm-card');
  if (cardElement) {
    await cardElement.screenshot({
      path: '/home/user/cloud_theme_rendered.png',
    });
    console.log('✓ Saved screenshot to /home/user/cloud_theme_rendered.png');
  }

  await browser.close();
  process.exit(0);
}

captureCloudScreenshot().catch((err) => {
  console.error('Screenshot capture failed:', err);
  process.exit(1);
});
