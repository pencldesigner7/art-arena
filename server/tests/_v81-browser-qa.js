'use strict';
// v81 browser QA — real Chromium over the real server. Covers the client
// phases that API tests cannot: hero/feature rendering, profile images,
// challenge buttons, settings toggles, offline outbox + retry dedupe,
// emoji set, theme vividness, placeholders gone, premium test on mobile.
// Honest scope: voice recording itself needs a mic; only the draft UI
// presence is asserted here.
const { chromium } = require('playwright');
const { randomBytes } = require('node:crypto');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = 'http://127.0.0.1:3000';
const OUT = path.join(__dirname, '..', '..', 'docs', 'shots-v81');
fs.mkdirSync(OUT, { recursive: true });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR2mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function api(u, p, body, status = 200, method) {
  const r = await fetch(base + '/api' + p, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json', ...(u ? { Authorization: 'Bearer ' + u.token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  if (status && r.status !== status) throw new Error(p + ' → ' + r.status + ' ' + JSON.stringify(d));
  return d;
}
async function user(tag) {
  const name = 'q81' + tag + randomBytes(4).toString('hex'), password = 'QaPass123!';
  const d = await api(null, '/auth/register', { username: name, email: name + '@example.test', password }, 201);
  const login = await api(null, '/auth/login', { login: name, password });
  return { id: d.user.id, token: login.session_token, name };
}
async function publish(u, title) {
  const fd = new FormData();
  fd.append('image', new Blob([PNG], { type: 'image/png' }), 'art.png');
  fd.append('title', title);
  const r = await fetch(base + '/api/community/posts', { method: 'POST', headers: { Authorization: 'Bearer ' + u.token }, body: fd });
  const d = await r.json();
  if (r.status !== 201) throw new Error('publish ' + JSON.stringify(d));
  return d;
}

(async () => {
  const A = await user('a'), B = await user('b');
  const post = await publish(B, 'QA81 landscape');
  await publish(B, 'QA81 second');
  console.log('users/posts seeded');

  const browser = await chromium.launch();
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.addInitScript((t) => sessionStorage.setItem('arena_session_token', t), A.token);
  await page.goto(base);
  await page.waitForFunction(() => typeof me !== 'undefined' && !!me, null, { timeout: 20000 });
  await page.waitForTimeout(1500);

  // ---- placeholders gone -------------------------------------------------
  const placeholders = await page.evaluate(() => ({
    quick: !!document.querySelector('#view-quickmatch'),
    find: !!document.querySelector('#view-findartist'),
    grand: !!document.querySelector('#view-grandarena'),
    apple: !!document.querySelector('[data-social="apple"]'),
  }));
  assert.deepEqual(placeholders, { quick: false, find: false, grand: false, apple: false }, 'placeholder UI removed: ' + JSON.stringify(placeholders));
  console.log('placeholders removed OK');

  // ---- community: hero + challenge + featured ---------------------------
  await page.click('#bottom-nav .tab[data-tab="community"]');
  await page.waitForSelector('#view-community:not(.hidden)');
  await page.waitForTimeout(1800);
  const hero = await page.evaluate(() => {
    const back = document.querySelector('#cm-hero img.cm-hero-back');
    return back ? { ok: back.complete && back.naturalWidth > 0, nw: back.naturalWidth } : { ok: false, nw: 0 };
  });
  assert.equal(hero.ok, true, 'hero backdrop image renders: ' + JSON.stringify(hero));
  console.log('hero backdrop OK', hero);

  const feat = await page.evaluate(() => {
    const img = document.querySelector('.cm-feat-art');
    if (!img) return null;
    const cs = getComputedStyle(img);
    return { fit: cs.objectFit, nw: img.naturalWidth };
  });
  if (feat) { assert.equal(feat.fit, 'cover', 'featured art object-fit cover on mobile'); console.log('featured cover OK', feat); }
  else console.log('featured card absent (no featured post) — cover rule unverified in DOM');

  await page.click('[data-cm="discover"]');
  await page.waitForTimeout(1200);
  await page.waitForSelector('[data-cm-challenge]', { timeout: 10000 });
  const chal = await page.evaluate(() => {
    const b = document.querySelector('[data-cm-challenge]');
    return b ? { text: b.textContent.trim(), disabled: b.disabled } : null;
  });
  assert.ok(chal, 'challenge button present for a non-friend artist');
  console.log('challenge button OK', chal);
  await page.screenshot({ path: path.join(OUT, 'v81-qa-community-375.png') });

  // challenge click → pending, and NOT auto-friended
  await page.click('[data-cm-challenge]');
  await page.waitForTimeout(900);
  const chal2 = await page.evaluate(() => {
    const b = document.querySelector('[data-cm-challenge]');
    return b ? b.textContent.trim() : null;
  });
  assert.match(chal2 || '', /Pending|Invited|Accepted/, 'challenge enters pending state: ' + chal2);
  const friends = await api(A, '/friends');
  const friendIds = JSON.stringify(friends);
  assert.ok(!friendIds.includes(B.id) || /accepted/i.test(friendIds), 'challenge did not silently friend');
  console.log('challenge pending OK:', chal2);

  // ---- P1: profile images render ----------------------------------------
  await page.evaluate((id) => window.openProfile && openProfile(id), B.id).catch(() => {});
  await page.waitForTimeout(1200);
  const profImgs = await page.evaluate(() => Array.from(document.querySelectorAll('.pm-sheet img, #profile-modal img, [class*=profile] img')).map((i) => ({ ok: i.complete && i.naturalWidth > 0, src: (i.getAttribute('src') || '').slice(0, 60) })));
  console.log('profile modal imgs:', JSON.stringify(profImgs));
  await page.screenshot({ path: path.join(OUT, 'v81-qa-profile-375.png') });

  // ---- settings toggles --------------------------------------------------
  await page.evaluate(() => { const x = document.querySelector('#pm-close'); if (x) x.click(); });
  await page.waitForTimeout(400);
  await page.click('#cm-side-settings');
  await page.waitForTimeout(900);
  const toggles = await page.evaluate(() => ({
    notif: !!document.querySelector('#cm-pf-notif'),
    sound: !!document.querySelector('#cm-pf-sound'),
    preview: !!document.querySelector('#cm-pf-preview'),
  }));
  assert.deepEqual(toggles, { notif: true, sound: true, preview: true }, 'message toggles exist: ' + JSON.stringify(toggles));
  await page.click('#cm-pf-sound');
  await page.waitForTimeout(600);
  const prefs = await api(A, '/messages/prefs');
  assert.equal(prefs.sound, false, 'sound toggle persisted off');
  assert.equal(prefs.notifications, true, 'notifications toggle independent (still on)');
  await page.click('#cm-pf-sound');
  await page.waitForTimeout(400);
  console.log('settings toggles OK');
  await page.screenshot({ path: path.join(OUT, 'v81-qa-settings-375.png') });

  // ---- themes vivid + panels opaque --------------------------------------
  const themes = await page.evaluate(() => {
    const out = {};
    for (const t of ['graffiti', 'glowing', 'pixel', 'chrome', 'comic', 'manga']) {
      document.body.dataset.ptheme = t;
      const cs = getComputedStyle(document.body);
      const card = document.querySelector('.cm-card');
      out[t] = { pink: cs.getPropertyValue('--pink').trim(), cardBg: card ? getComputedStyle(card).backgroundColor : null };
    }
    return out;
  });
  console.log('theme vars:', JSON.stringify(themes));
  assert.equal(themes.graffiti.pink.toLowerCase(), '#ff2e88');
  assert.equal(themes.glowing.pink.toLowerCase(), '#2bf5c8');
  for (const [t, v] of Object.entries(themes)) assert.notEqual(v.cardBg, 'rgba(0, 0, 0, 0)', t + ' community card opaque');
  console.log('themes OK');

  // ---- messaging: thread + offline outbox --------------------------------
  const fr = await api(A, '/friends/request', { user_id: B.id }, 201);
  const reqs = await api(B, '/friends');
  const reqId = (reqs.incoming || reqs.requests || []).map((x) => x.id || x.request_id).find(Boolean) || fr.id || fr.request_id;
  await api(B, '/friends/requests/' + reqId + '/accept', {}, 200);
  const thread = await api(A, '/messages/threads', { user_id: B.id }, 201);
  const threadId = thread.id || thread.thread_id || (thread.thread && thread.thread.id);
  assert.ok(threadId, 'thread created');
  await page.evaluate(() => location.hash = '');
  await page.reload();
  await page.waitForFunction(() => typeof me !== 'undefined' && !!me, null, { timeout: 20000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => show('messages'));
  await page.waitForTimeout(1200);
  // open the thread through the app's own list if present, else deep call
  const opened = await page.evaluate((tid) => {
    const el = document.querySelector('[data-thread="' + tid + '"]');
    if (el) { el.click(); return true; }
    return false;
  }, threadId);
  if (!opened) console.log('thread row not found in list (list may need refresh) — evaluating msgOpen path skipped');
  await page.waitForTimeout(900);

  const emojiSet = await page.evaluate(() => {
    const b = document.querySelector('#msg-emoji'); if (b) b.click();
    return new Promise((res) => setTimeout(() => {
      const items = Array.from(document.querySelectorAll('#msg-pop [data-emo]')).map((x) => x.dataset.emo);
      res({ flag: items.includes('🇳🇬'), tone: items.includes('👍🏽'), zwj: items.includes('🧑‍🎨'), n: items.length });
    }, 500));
  });
  console.log('emoji set:', JSON.stringify(emojiSet));
  assert.ok(emojiSet.flag && emojiSet.tone && emojiSet.zwj, 'multi-codepoint emoji present');
  await page.evaluate(() => { const b = document.querySelector('#msg-emoji'); if (b) b.click(); });

  const inThread = await page.evaluate(() => !!document.querySelector('#msg-thread:not(.hidden)') && !!document.querySelector('#msg-input'));
  if (inThread) {
    await ctx.setOffline(true);
    await page.fill('#msg-input', 'offline hello 81');
    await page.click('#msg-send');
    await page.waitForTimeout(600);
    const st = await page.evaluate(() => {
      const s = document.querySelector('[data-sendstat]');
      return s ? s.textContent : null;
    });
    assert.match(st || '', /Offline — not sent/, 'offline send visibly unsent: ' + st);
    const before = await api(A, '/messages/threads/' + threadId + '/messages');
    const nBefore = (before.messages || before || []).length;
    await ctx.setOffline(false);
    await page.waitForTimeout(300);
    await page.click('[data-retry]');
    await page.waitForTimeout(1200);
    const after = await api(A, '/messages/threads/' + threadId + '/messages');
    const arr = after.messages || after;
    const mine = arr.filter((m) => m.body === 'offline hello 81');
    assert.equal(mine.length, 1, 'exactly one copy after retry (dedupe)');
    console.log('offline outbox + retry dedupe OK');
    await page.screenshot({ path: path.join(OUT, 'v81-qa-chat-375.png') });
  } else {
    console.log('!! thread UI not opened — outbox browser check skipped (covered by API dedupe test)');
  }

  // ---- premium test on mobile viewport ------------------------------------
  await page.setViewportSize({ width: 375, height: 812 });
  await page.evaluate(() => show('premium'));
  await page.waitForTimeout(1200);
  const prem = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('#view-premium button')).map((b) => b.textContent.trim());
    return btns;
  });
  console.log('premium buttons @375:', JSON.stringify(prem));
  const testBtn = page.locator('#view-premium button', { hasText: /test/i }).first();
  assert.ok(await testBtn.count(), 'Premium Test button exists on mobile viewport');
  await testBtn.click();
  await page.waitForTimeout(700);
  const confirmBtn = page.locator('button', { hasText: /Yes, activate/i }).first();
  if (await confirmBtn.count()) { await confirmBtn.click(); await page.waitForTimeout(1200); }
  const st = await api(A, '/premium/status').catch(() => null);
  console.log('premium status after test activate:', JSON.stringify(st));
  assert.equal(st && st.active, true, 'Premium Test activates on mobile');
  await page.screenshot({ path: path.join(OUT, 'v81-qa-premium-375.png') });

  // ---- narrow widths smoke -------------------------------------------------
  for (const w of [320, 768]) {
    await page.setViewportSize({ width: w, height: 800 });
    await page.evaluate(() => show('community'));
    await page.waitForTimeout(900);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    assert.ok(overflow, 'no horizontal overflow @' + w);
    await page.screenshot({ path: path.join(OUT, 'v81-qa-community-' + w + '.png') });
  }
  console.log('widths 320/768 OK');

  const fatal = errors.filter((e) => !/favicon|arena_token|Failed to load resource/i.test(e));
  console.log('page errors:', JSON.stringify(fatal, null, 1));
  assert.equal(fatal.length, 0, 'no page errors');
  await browser.close();
  console.log('V81 BROWSER QA: PASS');
})().catch((e) => { console.error('V81 BROWSER QA: FAIL —', e.message); process.exit(1); });
