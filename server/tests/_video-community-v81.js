'use strict';
// v81 COMMUNITY + RISING-BUTTONS VIDEO — one continuous recording of the
// Community exactly as it stands (post Phase-3 hero), followed by a
// documentation pass over the FLAME and MAGAZINE rising-button behaviour
// (buttons lift on hover/press while their icons shift/fade — the V81 phase
// 14 report). Seeds a LOCAL disposable demo feed from real project artwork so
// the gallery is populated on camera; production data is never involved.
// Usage: node tests/_video-community-v81.js
const { chromium } = require('playwright');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const base = 'http://127.0.0.1:3000';
const OUT = path.join(__dirname, '..', '..', 'docs', 'shots-v81');
fs.mkdirSync(OUT, { recursive: true });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(u, p, body, status = 200, method = body === undefined ? 'GET' : 'POST') {
  const r = await fetch(base + '/api' + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(u ? { Authorization: 'Bearer ' + u.token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  if (status && r.status !== status) throw new Error(p + ' → ' + r.status + ' ' + JSON.stringify(d));
  return d;
}
async function user(name) {
  const password = 'CommunityTour123!';
  const d = await api(null, '/auth/register', { username: name, email: name + '@example.test', password }, 201);
  const login = await api(null, '/auth/login', { login: name, password });
  return { id: d.user.id, token: login.session_token, name };
}
async function publish(u, file, fields = {}) {
  const fd = new FormData();
  fd.append('image', new Blob([fs.readFileSync(file)], { type: 'image/png' }), 'art.png');
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const r = await fetch(base + '/api/community/posts', { method: 'POST', headers: { Authorization: 'Bearer ' + u.token }, body: fd });
  if (r.status !== 201) throw new Error(JSON.stringify(await r.json()));
}

// slow, camera-friendly pointer choreography
async function hoverHold(p, sel, holdMs = 1300) {
  const el = await p.$(sel);
  if (!el) return;
  const box = await el.boundingBox();
  if (!box) return;
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 });
  await pause(holdMs);
}
async function hoverLeave(p, sel, away = 220) {
  await hoverHold(p, sel, 700);
  await p.mouse.move(12, 120, { steps: 14 });
  await pause(away);
}
async function pressHold(p, sel, holdMs = 1100) {
  const el = await p.$(sel);
  if (!el) return;
  const box = await el.boundingBox();
  if (!box) return;
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
  await p.mouse.down();
  await pause(holdMs);
  // drag off BEFORE releasing: the pressed state is on camera, but no click
  // fires (nothing should navigate away during a documentation pass)
  await p.mouse.move(12, 120, { steps: 10 });
  await p.mouse.up();
  await pause(450);
}

async function themeButtonPass(p, label) {
  await p.keyboard.press('Escape');   // never let a stray modal block the tour
  await pause(400);
  // Arena Home: the icon-bearing home cards (rise + icon treatment), the big
  // hero CTA, the rooms link, then the bottom-nav icons — then Community CTAs.
  await p.click('#bottom-nav .tab[data-tab="arena"]');
  await p.waitForSelector('.home-card');
  await pause(1400);
  for (const sel of ['.home-card[data-home="battle"]', '.home-card[data-home="join"]', '.home-card[data-home="create"]']) {
    await hoverLeave(p, sel);
    await hoverHold(p, sel, 900);
    await p.mouse.move(12, 120, { steps: 10 });
    await pause(260);
  }
  await hoverLeave(p, '.view-all[data-home="rooms"]');
  await pressHold(p, '.home-card[data-home="battle"]');       // pressed state
  await hoverLeave(p, '#bottom-nav .tab[data-tab="community"]');
  await hoverLeave(p, '#bottom-nav .tab[data-tab="profile"]');

  await p.click('#bottom-nav .tab[data-tab="community"]');
  await p.waitForSelector('#cm-hero .cm-hero-body');
  await pause(1600);
  await hoverLeave(p, '#cm-publish');                          // ＋ Share art
  await hoverLeave(p, '.cm-featured .cm-btn');                 // Explore now →
  await pressHold(p, '.cm-featured .cm-btn');
  await hoverLeave(p, '.cm-side-item[data-cm="discover"]');
  console.log('button pass done: ' + label);
}

(async () => {
  // ---- clean slate + demo feed (LOCAL test DB only) -------------------------
  const { Client } = require('pg');
  const c = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://aa_admin:aa-admin-pw@127.0.0.1:5432/art_arena' });
  await c.connect();
  await c.query(`TRUNCATE community_posts, community_post_likes, community_comments, artwork_saves, community_artwork, follows, reports CASCADE`);
  await c.end();

  const t = randomBytes(3).toString('hex');
  const aria = await user('aria_flame_' + t);
  const nova = await user('nova_ink_' + t);
  const pete = await user('pixel_pete_' + t);
  const viewer = await user('gallery_fan_' + t);
  await api(viewer, '/premium/test-activate', {}, 200);   // premium themes for the button pass
  const art = path.join(__dirname, '..', 'public', 'themes');
  await publish(aria, path.join(art, 'flame.png'), { title: 'Ember Study', caption: 'warm light over old stone', tags: 'digitalpainting, conceptart' });
  await publish(nova, path.join(art, 'cloud.png'), { title: 'Cloudfall', caption: 'soft skies, hard edges', tags: 'illustration' });
  await publish(pete, path.join(art, 'graffiti-bg.png'), { title: 'Wall Tags', caption: 'street colour study', tags: 'graffiti, colour' });
  await publish(aria, path.join(art, 'glowing.png'), { title: 'Night Glow', caption: 'light finds a way', tags: 'lighting' });
  await publish(nova, path.join(art, 'magazine.png'), { title: 'Cover Story', caption: 'editorial layout play', tags: 'design' });

  const b = await chromium.launch();
  const ctx = await b.newContext({
    viewport: { width: 1280, height: 812 },
    recordVideo: { dir: '/tmp/aa-video', size: { width: 1280, height: 812 } },
  });
  const p = await ctx.newPage();
  await p.addInitScript((tok) => sessionStorage.setItem('arena_session_token', tok), viewer.token);

  // ---- PART 1: Community tour (default dark) -------------------------------
  await p.goto(base);
  await p.waitForFunction(() => typeof me !== 'undefined' && !!me, null, { timeout: 20000 });
  await p.waitForTimeout(3200);
  await p.click('#bottom-nav .tab[data-tab="community"]');
  await p.waitForSelector('#cm-hero .cm-hero-body');
  await p.waitForTimeout(2200);
  for (let i = 0; i < 5; i++) { await p.mouse.wheel(0, 520); await pause(850); }
  await pause(1200);
  await p.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await pause(1600);
  await p.click('#cm-feed .cm-post');
  await p.waitForSelector('#cm-art:not(.hidden)');
  await pause(2400);
  await p.click('#cm-art-close');
  await pause(900);
  for (const tab of ['discover', 'friends', 'following', 'settings']) {
    await p.click(`.cm-side-item[data-cm="${tab}"]`);
    await pause(2000);
  }
  await p.click('#cm-side-profile');
  await p.waitForTimeout(2400);
  await p.click('#pm-close');                    // the profile opens as a modal — close it
  await p.waitForTimeout(700);
  await p.click('.cm-side-item[data-cm="for-you"]');
  await p.waitForSelector('#cm-hero .cm-hero-body');
  await p.waitForTimeout(1800);

  // ---- PART 2: FLAME — the rising buttons ----------------------------------
  await p.click('#btn-menu');
  await p.waitForSelector('#drawer-nav [data-view="settings"]', { timeout: 5000 });
  await pause(700);
  await p.click('#drawer-nav [data-view="settings"]');
  await p.waitForSelector('#settings-theme-grid .theme-swatch');
  await pause(900);
  await p.click('#settings-theme-grid [data-settings-theme="flame"]');
  await p.waitForTimeout(2200);
  await themeButtonPass(p, 'flame');

  // ---- PART 3: MAGAZINE — the rising buttons -------------------------------
  await p.click('#btn-menu');
  await p.waitForSelector('#drawer-nav [data-view="settings"]', { timeout: 5000 });
  await pause(700);
  await p.click('#drawer-nav [data-view="settings"]');
  await p.waitForSelector('#settings-theme-grid .theme-swatch');
  await pause(900);
  await p.click('#settings-theme-grid [data-settings-theme="magazine"]');
  await p.waitForTimeout(2200);
  await themeButtonPass(p, 'magazine');

  await ctx.close();
  const video = p.video();
  const dest = path.join(OUT, 'community-tour-v81.webm');
  await video.saveAs(dest);
  await b.close();
  console.log('VIDEO saved → ' + dest + ' (' + Math.round(fs.statSync(dest).size / 1024) + ' KB)');
})().catch((e) => { console.error('FAIL video tour:', e.message); process.exit(1); });
