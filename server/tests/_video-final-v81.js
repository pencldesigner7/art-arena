'use strict';
// v81 FINAL VIDEO — one continuous phone-viewport tour of the finished app:
// hero, feed, artwork, profile images, Challenge, settings toggles, chat
// (emoji, swipe-reply, offline → Retry), voice-note draft, vivid themes,
// Premium Test. Seeds LOCAL disposable demo data through the real API only.
// Usage: node tests/_video-final-v81.js
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
  const password = '[SECURITY_DATA]';
  const d = await api(null, '/auth/register', { username: name, email: name + '@example.test', password }, 201);
  const login = await api(null, '/auth/login', { login: name, password });
  return { id: d.user.id, token: login.session_token, name };
}
async function publish(u, file, fields = {}) {
  const fd = new FormData();
  fd.append('image', new Blob([fs.readFileSync(file)], { type: 'image/png' }), 'art.png');
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const r = await fetch(base + '/api/community/posts', { method: 'POST', headers: { Authorization: 'Bearer ' + u.token }, body: fd });
  const d = await r.json();
  if (r.status !== 201) throw new Error('publish: ' + JSON.stringify(d));
  return d;
}
async function clickIf(p, sel, wait = 1200) {
  const el = await p.$(sel);
  if (!el) { console.log('skip (absent):', sel); return false; }
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await el.click().catch(() => {});
  await pause(wait);
  return true;
}

(async () => {
  const t = randomBytes(3).toString('hex');
  const aria = await user('aria_flame_' + t);
  const nova = await user('nova_ink_' + t);
  const pete = await user('pixel_pete_' + t);
  const viewer = await user('gallery_fan_' + t);
  await api(viewer, '/premium/test-activate', {}, 200);

  const art = path.join(__dirname, '..', 'public', 'themes');
  const p1 = await publish(aria, path.join(art, 'flame.png'), { title: 'Ember Study', caption: 'warm light over old stone', tags: 'digitalpainting, conceptart' });
  const p2 = await publish(nova, path.join(art, 'cloud.png'), { title: 'Cloudfall', caption: 'soft skies, hard edges', tags: 'illustration' });
  await publish(pete, path.join(art, 'graffiti-bg.png'), { title: 'Wall Tags', caption: 'street colour study', tags: 'graffiti, colour' });
  await publish(aria, path.join(art, 'glowing.png'), { title: 'Night Glow', caption: 'light finds a way', tags: 'lighting' });
  await publish(nova, path.join(art, 'chrome.png'), { title: 'Chrome Study', caption: 'polished metal study', tags: 'render' });
  // likes push the newest real art into hero/featured slots
  for (const [u, post] of [[viewer, p1], [viewer, p2], [aria, p2], [pete, p1], [nova, p1]]) {
    await api(u, '/community/posts/' + (post.post ? post.post.id : post.id) + '/like', {}, 200).catch(() => {});
  }
  // friendship + a real DM thread with one message from Aria
  const fr = await api(viewer, '/friends/request', { user_id: aria.id }, 201);
  const inbox = await api(aria, '/friends');
  const reqId = (inbox.incoming || inbox.requests || []).map((x) => x.id || x.request_id).find(Boolean) || fr.id || fr.request_id;
  await api(aria, '/friends/requests/' + reqId + '/accept', {}, 200);
  const thread = await api(viewer, '/messages/threads', { user_id: aria.id }, 201);
  const tid = thread.id || thread.thread_id || (thread.thread && thread.thread.id);
  await api(aria, '/messages/threads/' + tid + '/messages', { body: 'That ember piece is stunning 🔥 Ready for a rematch?' }, 201);
  console.log('demo data seeded');

  const b = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  const ctx = await b.newContext({
    viewport: { width: 390, height: 844 },
    recordVideo: { dir: '/tmp/aa-video-final', size: { width: 390, height: 844 } },
    permissions: ['microphone'],
  });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('pageerror:', e.message));
  await p.addInitScript((tok) => sessionStorage.setItem('arena_session_token', tok), viewer.token);
  await p.goto(base);
  await p.waitForFunction(() => typeof me !== 'undefined' && !!me, null, { timeout: 20000 });
  await pause(2600);

  // ---- 1 · Community hero + feed -------------------------------------------
  await p.click('#bottom-nav .tab[data-tab="community"]');
  await p.waitForSelector('#cm-hero .cm-hero-body');
  await pause(2600);
  for (let i = 0; i < 4; i++) { await p.mouse.wheel(0, 480); await pause(800); }
  await pause(800);
  await p.mouse.wheel(0, -4000);
  await pause(1200);

  // ---- 2 · artwork page + profile images ------------------------------------
  await clickIf(p, '#cm-feed .cm-post', 2400);
  await clickIf(p, '#cm-art-close', 900);
  // open the artist's profile from the first post avatar/name if present
  await p.evaluate((id) => { if (typeof openProfile === 'function') openProfile(id); }, aria.id);
  await pause(2600);
  await p.mouse.wheel(0, 320); await pause(900);
  await clickIf(p, '#pm-close', 800);

  // ---- 3 · Discover → Challenge a non-friend --------------------------------
  await clickIf(p, '[data-cm="discover"]', 1600);
  await p.waitForSelector('[data-cm-challenge]', { timeout: 8000 }).catch(() => {});
  await pause(1000);
  await clickIf(p, '[data-cm-challenge]', 1600);

  // ---- 4 · Community settings: message toggles + sound preview --------------
  await clickIf(p, '#cm-side-settings', 1600);
  await p.mouse.wheel(0, 500); await pause(700);
  await p.mouse.wheel(0, 500); await pause(700);
  await clickIf(p, '#cm-pf-preview', 1400);

  // ---- 5 · Messages: emoji, swipe-reply, offline → retry ---------------------
  await p.evaluate(() => { if (typeof show === 'function') show('messages'); });
  await pause(1600);
  await p.evaluate((id) => { document.querySelectorAll('[data-thread]').forEach((e) => { if (e.dataset.thread === id) e.click(); }); }, tid);
  await pause(1800);
  await clickIf(p, '#msg-emoji', 900);
  await pause(1200);
  // click the Nigeria flag in the picker
  await p.evaluate(() => {
    const b = Array.from(document.querySelectorAll('#msg-pop [data-emo]')).find((x) => x.dataset.emo === '🇳🇬');
    if (b) b.click();
  });
  await pause(700);
  await p.type('#msg-input', ' flying the flag!', { delay: 40 });
  await pause(600);
  await p.click('#msg-send');
  await pause(1500);
  // swipe right on Aria's bubble → reply chip
  const bub = await p.$('.msg-bub:not(.pending)');
  if (bub) {
    const box = await bub.boundingBox();
    if (box) {
      await p.mouse.move(box.x + 40, box.y + box.height / 2, { steps: 6 });
      await p.mouse.down();
      await p.mouse.move(box.x + 130, box.y + box.height / 2, { steps: 12 });
      await p.mouse.up();
      await pause(1200);
    }
  }
  await p.type('#msg-input', 'Swipe-to-reply works', { delay: 35 });
  await p.click('#msg-send');
  await pause(1400);
  // offline send → Retry
  await ctx.setOffline(true);
  await p.type('#msg-input', 'Sent while offline — watch me wait', { delay: 30 });
  await p.click('#msg-send');
  await pause(1800);
  await ctx.setOffline(false);
  await pause(800);
  await clickIf(p, '[data-retry]', 1800);

  // ---- 6 · voice-note draft (fake mic in headless Chrome) -------------------
  await clickIf(p, '#msg-voice', 2400);
  await clickIf(p, '#msg-voice', 1400); // stop → draft bar
  if (await p.$('#msg-voicedraft:not(.hidden)')) {
    await pause(1500);
    await clickIf(p, '#msg-voicedraft-send', 2000);
  } else {
    console.log('voice draft bar did not appear (fake mic) — segment skipped on camera');
  }

  // ---- 7 · vivid themes -------------------------------------------------------
  await p.evaluate(() => { if (typeof show === 'function') show('settings'); });
  await pause(1500);
  for (const th of ['graffiti', 'glowing', 'pixel']) {
    await clickIf(p, '#settings-theme-grid [data-settings-theme="' + th + '"]', 1200);
    await p.evaluate(() => { if (typeof show === 'function') show('community'); });
    await pause(1900);
    await p.evaluate(() => { if (typeof show === 'function') show('settings'); });
    await pause(900);
  }
  // restore default-ish dark for the finale
  await clickIf(p, '#settings-theme-grid [data-settings-theme="dark"]', 1000);

  // ---- 8 · Premium Test -------------------------------------------------------
  await p.evaluate(() => { if (typeof show === 'function') show('premium'); });
  await pause(2200);

  // ---- finale: Community -------------------------------------------------------
  await p.evaluate(() => { if (typeof show === 'function') show('community'); });
  await pause(2600);

  await ctx.close();
  const dest = path.join(OUT, 'art-arena-final-v81.webm');
  await p.video().saveAs(dest);
  await b.close();
  console.log('VIDEO saved → ' + dest + ' (' + Math.round(fs.statSync(dest).size / 1024) + ' KB)');
})().catch((e) => { console.error('FAIL final video:', e.message); process.exit(1); });
