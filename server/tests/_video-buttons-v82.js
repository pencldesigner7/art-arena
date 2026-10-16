'use strict';
// v82 VIDEO — the edited buttons, on camera, in every theme.
// PART A (desktop): Community hero with the Colosseum faded into the
// backdrop, the desktop Friends tab, then a button pass per theme —
// Flame, Glowing, Pixel, Graffiti, Magazine, Glitch, Chrome, Comic, Cloud —
// hovering (lift + icon) and pressing the home cards and Community CTAs.
// PART B (phone): hero + the rebuilt single-row Friends tab.
// Merged into ONE webm with ffmpeg. Local disposable seed data only.
const { chromium } = require('playwright');
const { randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const base = 'http://127.0.0.1:3000';
const OUT = path.join(__dirname, '..', '..', 'docs', 'shots-v81');
const TMP = '/tmp/aa-video-v82';
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });
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
async function hoverHold(p, sel, holdMs = 1300) {
  const el = await p.$(sel);
  if (!el) { console.log('skip hover (absent):', sel); return; }
  const box = await el.boundingBox();
  if (!box) return;
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 });
  await pause(holdMs);
}
async function hoverLeave(p, sel, away = 240) {
  await hoverHold(p, sel, 800);
  await p.mouse.move(14, 130, { steps: 14 });
  await pause(away);
}
async function pressHold(p, sel, holdMs = 1100) {
  const el = await p.$(sel);
  if (!el) { console.log('skip press (absent):', sel); return; }
  const box = await el.boundingBox();
  if (!box) return;
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
  await p.mouse.down();
  await pause(holdMs);
  await p.mouse.move(14, 130, { steps: 10 }); // drag off so no click fires
  await p.mouse.up();
  await pause(450);
}
async function setTheme(p, key) {
  await p.keyboard.press('Escape');
  await pause(300);
  await p.click('#btn-menu');
  await p.waitForSelector('#drawer-nav [data-view="settings"]', { timeout: 6000 });
  await pause(600);
  await p.click('#drawer-nav [data-view="settings"]');
  await p.waitForSelector('#settings-theme-grid .theme-swatch', { timeout: 8000 });
  await pause(800);
  await p.click('#settings-theme-grid [data-settings-theme="' + key + '"]');
  await pause(1700);
}
async function buttonPass(p, label) {
  await p.click('#bottom-nav .tab[data-tab="arena"]');
  await p.waitForSelector('.home-card');
  await pause(1200);
  for (const sel of ['.home-card[data-home="battle"]', '.home-card[data-home="join"]', '.home-card[data-home="create"]']) {
    await hoverLeave(p, sel);
    await hoverHold(p, sel, 850);
    await p.mouse.move(14, 130, { steps: 10 });
    await pause(220);
  }
  await hoverLeave(p, '.view-all[data-home="rooms"]');
  await pressHold(p, '.home-card[data-home="battle"]');
  await hoverLeave(p, '#cm-publish'.replace('#cm-publish', '#bottom-nav .tab[data-tab="community"]'));
  await p.click('#bottom-nav .tab[data-tab="community"]');
  await p.waitForSelector('#cm-hero .cm-hero-body');
  await pause(1300);
  await hoverLeave(p, '#cm-publish');
  await hoverLeave(p, '.cm-featured .cm-btn');
  await pressHold(p, '.cm-featured .cm-btn');
  await hoverLeave(p, '.cm-side-item[data-cm="discover"]');
  console.log('button pass done:', label);
}

(async () => {
  const t = randomBytes(3).toString('hex');
  const pal1 = await user('sol_brush_' + t);
  const pal2 = await user('kaya_ink_' + t);
  const viewer = await user('studio_fan_' + t);
  await api(viewer, '/premium/test-activate', {}, 200);
  for (const f of [pal1, pal2]) {
    const fr = await api(viewer, '/friends/request', { user_id: f.id }, 201);
    const inbox = await api(f, '/friends');
    const reqId = (inbox.incoming || inbox.requests || []).map((x) => x.id || x.request_id).find(Boolean) || fr.id || fr.request_id;
    await api(f, '/friends/requests/' + reqId + '/accept', {}, 200);
  }
  const art = path.join(__dirname, '..', 'public', 'themes');
  async function publish(u, file, title, caption) {
    const fd = new FormData();
    fd.append('image', new Blob([fs.readFileSync(file)], { type: 'image/png' }), 'art.png');
    fd.append('title', title); fd.append('caption', caption);
    const r = await fetch(base + '/api/community/posts', { method: 'POST', headers: { Authorization: 'Bearer ' + u.token }, body: fd });
    if (r.status !== 201) throw new Error('publish ' + JSON.stringify(await r.json()));
    return r.json();
  }
  const lead = await publish(pal1, path.join(art, 'flame.png'), 'Ember Study', 'warm light over old stone');
  await publish(pal2, path.join(art, 'glowing.png'), 'Night Glow', 'light finds a way');
  await api(viewer, '/community/posts/' + (lead.post ? lead.post.id : lead.id) + '/like', {}, 200).catch(() => {});
  console.log('demo data seeded');

  const b = await chromium.launch();

  // ---------------- PART A: desktop themes ---------------------------------
  const ctxA = await b.newContext({
    viewport: { width: 1280, height: 812 },
    recordVideo: { dir: path.join(TMP, 'a'), size: { width: 1280, height: 812 } },
  });
  const p = await ctxA.newPage();
  p.on('pageerror', (e) => console.log('pageerror:', e.message));
  await p.addInitScript((tok) => sessionStorage.setItem('arena_session_token', tok), viewer.token);
  await p.goto(base);
  await p.waitForFunction(() => typeof me !== 'undefined' && !!me, null, { timeout: 20000 });
  await pause(2800);
  // hero with faded colosseum + desktop friends
  await p.click('#bottom-nav .tab[data-tab="community"]');
  await p.waitForSelector('#cm-hero .cm-hero-body');
  await pause(2800);
  await p.click('[data-cm="friends"]');
  await pause(2400);
  await p.click('[data-cm="for-you"]');
  await pause(1500);

  for (const th of ['flame', 'glowing', 'pixel', 'graffiti', 'magazine', 'glitch', 'chrome', 'comic', 'cloud']) {
    await setTheme(p, th);
    await buttonPass(p, th);
  }
  // finale: Flame once more on the Arena home
  await setTheme(p, 'flame');
  await p.click('#bottom-nav .tab[data-tab="arena"]');
  await p.waitForSelector('.home-card');
  await pause(2200);
  await ctxA.close();
  const vidA = await p.video().path();

  // ---------------- PART B: mobile friends ---------------------------------
  const ctxB = await b.newContext({
    viewport: { width: 390, height: 844 },
    recordVideo: { dir: path.join(TMP, 'b'), size: { width: 390, height: 844 } },
  });
  const m = await ctxB.newPage();
  m.on('pageerror', (e) => console.log('mobile pageerror:', e.message));
  await m.addInitScript((tok) => sessionStorage.setItem('arena_session_token', tok), viewer.token);
  await m.goto(base);
  await m.waitForFunction(() => typeof me !== 'undefined' && !!me, null, { timeout: 20000 });
  await pause(2400);
  await m.click('#bottom-nav .tab[data-tab="community"]');
  await m.waitForSelector('#cm-hero .cm-hero-body');
  await pause(2600);
  await m.click('[data-cm="friends"]');
  await pause(2800);
  await m.mouse.wheel(0, 300);
  await pause(1200);
  await m.mouse.wheel(0, -300);
  await pause(1200);
  await ctxB.close();
  const vidB = await m.video().path();
  await b.close();

  // ---------------- merge ---------------------------------------------------
  const ffmpeg = require('ffmpeg-static');
  const norm = (inp, outp) => execFileSync(ffmpeg, ['-y', '-i', inp,
    '-vf', 'scale=1280:812:force_original_aspect_ratio=decrease,pad=1280:812:(ow-iw)/2:(oh-ih)/2:black,fps=25',
    '-c:v', 'libvpx-vp9', '-b:v', '900k', '-an', outp], { stdio: 'pipe' });
  const nA = path.join(TMP, 'a.webm'), nB = path.join(TMP, 'b.webm');
  norm(vidA, nA); norm(vidB, nB);
  const list = path.join(TMP, 'list.txt');
  fs.writeFileSync(list, "file '" + nA + "'\nfile '" + nB + "'\n");
  const dest = path.join(OUT, 'art-arena-buttons-v82.webm');
  execFileSync(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', dest], { stdio: 'pipe' });
  console.log('VIDEO saved → ' + dest + ' (' + Math.round(fs.statSync(dest).size / 1024) + ' KB)');
})().catch((e) => { console.error('FAIL v82 video:', e.message); process.exit(1); });
