'use strict';
// v82 verification: (1) hero renders the lead ARTWORK full-bleed (gallery),
// (2) Featured card art spans the card's full height on desktop + mobile.
const { chromium } = require('playwright');
const { randomBytes } = require('node:crypto');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = 'http://127.0.0.1:3000';
const OUT = path.join(__dirname, '..', '..', 'docs', 'shots-v81');
fs.mkdirSync(OUT, { recursive: true });

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
async function user() {
  const name = 'hf' + randomBytes(4).toString('hex'), password = '[SECURITY_DATA]';
  const d = await api(null, '/auth/register', { username: name, email: name + '@example.test', password }, 201);
  const login = await api(null, '/auth/login', { login: name, password });
  return { id: d.user.id, token: login.session_token, name };
}

(async () => {
  const artist = await user(), fan = await user();
  const art = path.join(__dirname, '..', 'public', 'themes', 'glowing.png');
  const fd = new FormData();
  fd.append('image', new Blob([fs.readFileSync(art)], { type: 'image/png' }), 'art.png');
  fd.append('title', 'Night Glow'); fd.append('caption', 'light finds a way');
  const pr = await fetch(base + '/api/community/posts', { method: 'POST', headers: { Authorization: 'Bearer ' + artist.token }, body: fd });
  const post = await pr.json();
  assert.equal(pr.status, 201, 'seed post: ' + JSON.stringify(post));
  await api(fan, '/community/posts/' + (post.post ? post.post.id : post.id) + '/like', {}, 200).catch(() => {});

  const browser = await chromium.launch();
  const errors = [];
  for (const [label, w, h] of [['desktop', 1280, 812], ['mobile375', 375, 812]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(label + ': ' + e.message));
    await p.addInitScript((t) => sessionStorage.setItem('arena_session_token', t), fan.token);
    await p.goto(base);
    await p.waitForFunction(() => typeof me !== 'undefined' && !!me, null, { timeout: 20000 });
    await p.waitForTimeout(1300);
    await p.click('#bottom-nav .tab[data-tab="community"]');
    await p.waitForSelector('#cm-hero .cm-hero-body');
    await p.waitForTimeout(1500);
    const probe = await p.evaluate(() => {
      const heroArt = document.querySelector('#cm-hero img.cm-hero-art');
      const hero = document.querySelector('#cm-hero').getBoundingClientRect();
      const feat = document.querySelector('.cm-featured');
      const featArt = document.querySelector('.cm-feat-art');
      const fr = feat.getBoundingClientRect(), fa = featArt.getBoundingClientRect();
      return {
        heroArt: heroArt ? { ok: heroArt.complete && heroArt.naturalWidth > 0, src: heroArt.getAttribute('src') } : null,
        heroH: Math.round(hero.height),
        featFullHeight: Math.abs(fa.height - fr.height) <= 5,
        featCoversTopBottom: Math.abs(fa.top - fr.top) <= 2 && Math.abs(fa.bottom - fr.bottom) <= 2,
        featFit: getComputedStyle(featArt).objectFit,
      };
    });
    console.log(label, JSON.stringify(probe));
    assert.ok(probe.heroArt && probe.heroArt.ok, label + ': hero shows the real artwork: ' + JSON.stringify(probe.heroArt));
    assert.ok(probe.featFullHeight && probe.featCoversTopBottom, label + ': featured art vertically full');
    assert.equal(probe.featFit, 'cover');
    await p.screenshot({ path: path.join(OUT, 'v82-hero-feat-' + label + '.png') });
    await ctx.close();
  }
  assert.equal(errors.length, 0, 'page errors: ' + JSON.stringify(errors));
  await browser.close();
  console.log('V82 HERO+FEATURED: PASS');
})().catch((e) => { console.error('V82 HERO+FEATURED: FAIL —', e.message); process.exit(1); });
