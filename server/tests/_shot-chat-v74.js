'use strict';
// v74 — Chat page + premium customization in a real browser: reference
// composition (header, day pills, decorative strokes behind bubbles, composer
// tools, deliver-on-type), wallpaper gallery (brandmarks/logos/themes/profile/
// uploads), manga + upload wallpapers, non-premium lock, isolation, responsive.
const { chromium } = require('playwright');
const { randomBytes } = require('node:crypto');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = 'http://127.0.0.1:3000';
async function api(u, path, body, status = 200, method = body === undefined ? 'GET' : 'POST') {
  const r = await fetch(base + '/api' + path, {
    method, headers: { 'Content-Type': 'application/json', ...(u ? { Authorization: 'Bearer ' + u.token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  if (status && r.status !== status) throw new Error(path + ' → ' + r.status + ' ' + JSON.stringify(d));
  return d;
}
async function user(tag) {
  const name = tag + randomBytes(5).toString('hex'), password = 'ChatShot123!';
  const d = await api(null, '/auth/register', { username: name, email: name + '@example.test', password }, 201);
  const login = await api(null, '/auth/login', { login: name, password });
  return { id: d.user.id, token: login.session_token, name };
}
const CRC_T = [...Array(256)].map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xFFFFFFFF; for (const x of b) c = CRC_T[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, cr]);
}
function png64() {
  const W = 64;
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(W * (1 + W * 3));
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const o = y * (1 + W * 3) + 1 + x * 3;
    raw[o] = 40 + x * 3; raw[o + 1] = 20 + y * 2; raw[o + 2] = 90;
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 16, 10].map((x, i) => i === 6 ? 0x1A : x)),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
(async () => {
  fs.writeFileSync('/tmp/v74-wall.png', png64());
  const a = await user('csa_'), b = await user('csb_');
  await api(a, '/friends/request', { user_id: b.id }, 201);
  const fr = await api(b, '/friends');
  await api(b, '/friends/requests/' + fr.incoming.find((r) => r.user_id === a.id).id + '/accept', {}, 200);
  await api(a, '/premium/test-activate', {}, 200);
  // avatars so profile wallpapers exist in the catalogue
  for (const u of [a, b]) {
    const fd = new FormData(); fd.append('image', new Blob([png64()], { type: 'image/png' }), 'av.png');
    const r = await fetch(base + '/api/account/avatar', { method: 'POST', headers: { Authorization: 'Bearer ' + u.token }, body: fd });
    if (r.status !== 200) throw new Error('avatar upload ' + r.status);
  }
  const thread = await api(a, '/messages/threads', { user_id: b.id }, 201);

  const errors = [];
  const b1 = await chromium.launch();
  const mk = async (u, vp) => {
    const ctx = await b1.newContext({ viewport: vp || { width: 1100, height: 820 } });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    p.on('response', (r) => { if (r.status() === 404 && !r.url().includes('favicon')) errors.push('404: ' + r.url()); });
    await p.addInitScript((t) => sessionStorage.setItem('arena_session_token', t), u.token);
    await p.goto(base);
    await p.waitForFunction(() => typeof me !== 'undefined' && !!me, null, { timeout: 20000 });
    await p.waitForTimeout(1800);
    return p;
  };
  const pa = await mk(a);

  // open the thread via drawer
  await pa.click('#btn-menu');
  await pa.click('#drawer-nav [data-view="messages"]');
  await pa.waitForSelector('#view-messages:not(.hidden)');
  await pa.click('.msg-row');
  await pa.waitForSelector('#msg-thread:not(.hidden)');

  // header controls: true circles, hidden at rest (no opaque oval top-right),
  // revealed on hover
  const head = await pa.evaluate(() => {
    const ap = document.querySelector('#msg-appearance'); const bk = document.querySelector('#msg-back');
    const ra = ap.getBoundingClientRect(); const rb = bk.getBoundingClientRect();
    const si = ap.querySelector('svg').getBoundingClientRect();
    return { apOp: getComputedStyle(ap).opacity, bkOp: getComputedStyle(bk).opacity,
      sq: Math.abs(ra.width - ra.height) <= 1 && Math.abs(rb.width - rb.height) <= 1, icon: si.width >= 12 };
  });
  assert.equal(head.apOp, '0', 'appearance control hidden at rest (oval removed)');
  assert.equal(head.bkOp, '0', 'back control hidden at rest');
  assert.ok(head.sq, 'header controls are circles');
  assert.ok(head.icon, 'appearance icon visible when revealed');
  await pa.hover('.aa-mh');
  await pa.waitForTimeout(250);
  assert.equal(await pa.evaluate(() => getComputedStyle(document.querySelector('#msg-appearance')).opacity), '1', 'header controls appear on hover');
  await pa.mouse.move(550, 700); // rest the pointer off the header
  await pa.waitForTimeout(250);

  // composer at rest: four circular tools WITH visible icons resting INSIDE the
  // typing space; deliver button hidden until a letter is typed
  const rest = await pa.evaluate(() => {
    const f = document.querySelector('#msg-form').getBoundingClientRect();
    const tools = [...document.querySelectorAll('#msg-form .aa-cbtn')].map((b) => {
      const r = b.getBoundingClientRect(); const s2 = b.querySelector('svg').getBoundingClientRect();
      return { round: Math.abs(r.width - r.height) <= 2, inPill: r.top >= f.top - 1 && r.bottom <= f.bottom + 1, icon: s2.width >= 12 && s2.height >= 12 };
    });
    return { n: tools.length, tools, sendHidden: getComputedStyle(document.querySelector('#msg-send')).opacity === '0' };
  });
  assert.equal(rest.n, 4, 'emoji + sticker + voice + image buttons present');
  for (const t of rest.tools) {
    assert.ok(t.round, 'tool buttons are circles, not ovals');
    assert.ok(t.inPill, 'tools rest inside the typing space');
    assert.ok(t.icon, 'tool icons are visible');
  }
  assert.ok(rest.sendHidden, 'deliver button hidden at rest');

  // reference composition: header, deliver-on-type, decorative strokes
  await pa.fill('#msg-input', 'Hello!');
  await pa.waitForSelector('#msg-form.ready');
  assert.equal(await pa.locator('.aa-send').isVisible(), true, 'deliver button appears while typing');
  await pa.waitForTimeout(650); // let the rise animation settle
  const risen = await pa.evaluate(() => {
    const f = document.querySelector('#msg-form').getBoundingClientRect();
    const up = [...document.querySelectorAll('#msg-form .aa-cluster .aa-cbtn')].every((b) => b.getBoundingClientRect().bottom < f.top + 4);
    const em = document.querySelector('#msg-emoji').getBoundingClientRect();
    return up && em.top >= f.top - 1 && em.bottom <= f.bottom + 1;
  });
  assert.ok(risen, 'the three tools rise on typing while the emoji button stays in the typing space');

  // long text wraps to new lines and ends at the back of the deliver button
  await pa.fill('#msg-input', 'a'.repeat(160));
  await pa.waitForTimeout(250);
  const wrap = await pa.evaluate(() => {
    const i = document.querySelector('#msg-input'); const cs = getComputedStyle(i);
    return { multi: i.scrollHeight > 44, pr: parseInt(cs.paddingRight, 10), tag: i.tagName };
  });
  assert.equal(wrap.tag, 'TEXTAREA', 'typing space grows with content');
  assert.ok(wrap.multi, 'long text moves to a new line inside the typing space');
  assert.ok(wrap.pr >= 44, 'text ends at the back of the deliver button (no dead gap)');
  await pa.fill('#msg-input', 'Hello!');
  await pa.waitForTimeout(250);
  await pa.click('#msg-send');
  await pa.waitForSelector('.msg-grp.mine .msg-bub');
  const stroke = await pa.evaluate(() => {
    const g = document.querySelector('.msg-grp.mine');
    const cs = getComputedStyle(g, '::before');
    const bub = getComputedStyle(g.querySelector('.msg-bub'));
    return { w: cs.width, pe: cs.pointerEvents, bz: bub.zIndex, bg: cs.backgroundColor };
  });
  assert.equal(stroke.w, '4px', 'decorative stroke present behind bubbles');
  assert.equal(stroke.pe, 'none', 'stroke never intercepts pointer events');
  assert.equal(stroke.bz, '1', 'bubble layers above the stroke');

  // emoji + sticker tools
  await pa.click('#msg-emoji');
  await pa.waitForSelector('#msg-pop button[data-emo]');
  await pa.click('#msg-pop button[data-emo]');
  assert.ok((await pa.inputValue('#msg-input')).length > 0, 'emoji inserted');
  await pa.fill('#msg-input', '');
  await pa.click('#msg-sticker');
  await pa.waitForSelector('#msg-pop.stickers button[data-stick]');
  await pa.click('#msg-pop.stickers button[data-stick]');
  await pa.waitForSelector('.aa-stick');

  // premium appearance panel: gallery sections with separate brandmarks/logos
  await pa.click('#msg-appearance');
  await pa.waitForSelector('#msg-ap-panel:not(.hidden)');
  const counts = await pa.evaluate(() => ({
    brand: document.querySelectorAll('#msg-ap-body .aa-ap-tile[data-wall-kind="brandmark"]').length,
    logo: document.querySelectorAll('#msg-ap-body .aa-ap-tile[data-wall-kind="logo"]').length,
    theme: document.querySelectorAll('#msg-ap-body .aa-ap-tile[data-wall-kind="theme"]').length,
    prof: document.querySelectorAll('#msg-ap-body .aa-ap-tile[data-wall-kind="profile"]').length,
  }));
  assert.ok(counts.brand >= 11 && counts.logo >= 11 && counts.theme >= 12 && counts.prof >= 1, JSON.stringify(counts));
  await pa.screenshot({ path: '/home/user/theme-previews/v74-chat-panel.png' });

  // the FULL-LOGO gallery section is separate from brandmarks
  await pa.evaluate(() => { const h = [...document.querySelectorAll('#msg-ap-body h4')].find((x) => /logo/i.test(x.textContent)); h.scrollIntoView(); });
  await pa.waitForTimeout(250);
  await pa.screenshot({ path: '/home/user/theme-previews/v74-chat-gallery-logos.png' });

  // manga logo wallpaper: live preview, apply, persist
  await pa.click('#msg-ap-body .aa-ap-tile[data-wall-kind="logo"][data-wall-ref="manga"]');
  await pa.waitForFunction(() => (document.querySelector('#msg-wall').style.backgroundImage || '').includes('comic-manga'));
  await pa.click('#msg-ap-apply');
  await pa.waitForFunction(() => document.querySelector('#msg-ap-panel').classList.contains('hidden'));
  await pa.screenshot({ path: '/home/user/theme-previews/v74-chat-manga-wall.png' });

  // profile-image wallpaper (own avatar)
  await pa.click('#msg-appearance');
  await pa.waitForSelector('#msg-ap-panel:not(.hidden)');
  await pa.click('#msg-ap-body .aa-ap-tile[data-wall-kind="profile"][data-wall-ref="self"]');
  await pa.waitForFunction(() => (document.querySelector('#msg-wall').style.backgroundImage || '').includes('/avatars/'));
  await pa.click('#msg-ap-apply');
  await pa.waitForFunction(() => document.querySelector('#msg-ap-panel').classList.contains('hidden'));
  await pa.screenshot({ path: '/home/user/theme-previews/v74-chat-profile-wall.png' });

  // device upload wallpaper
  await pa.click('#msg-appearance');
  await pa.waitForSelector('#msg-ap-panel:not(.hidden)');
  await pa.setInputFiles('#msg-ap-file', '/tmp/v74-wall.png');
  await pa.waitForFunction(() => (document.querySelector('#msg-wall').style.backgroundImage || '').includes('/api/messages/uploads/'));
  await pa.click('#msg-ap-apply');
  await pa.waitForFunction(() => document.querySelector('#msg-ap-panel').classList.contains('hidden'));
  await pa.screenshot({ path: '/home/user/theme-previews/v74-chat-upload-wall.png' });

  // reload thread → wallpaper persists
  await pa.reload();
  await p2wait(pa);
  await pa.click('#btn-menu');
  await pa.click('#drawer-nav [data-view="messages"]');
  await pa.click('.msg-row');
  await pa.waitForFunction(() => (document.querySelector('#msg-wall').style.backgroundImage || '').includes('/api/messages/uploads/'), null, { timeout: 10000 });

  // B: non-premium sees the lock, personal wallpaper stays default
  const pb = await mk(b);
  await pb.click('#btn-menu');
  await pb.click('#drawer-nav [data-view="messages"]');
  await pb.click('.msg-row');
  await pb.waitForSelector('#msg-thread:not(.hidden)');
  const bWall = await pb.evaluate(() => document.querySelector('#msg-wall').style.backgroundImage || 'none');
  assert.equal(bWall, 'none', "B's conversation view keeps B's own (default) wallpaper");
  await pb.click('#msg-appearance');
  await pb.waitForSelector('#msg-ap-upgrade');
  await pb.screenshot({ path: '/home/user/theme-previews/v74-chat-nonpremium.png' });

  // long message + conversation usability
  await pb.click('#msg-ap-close');
  await pb.fill('#msg-input', 'A very long message '.repeat(12) + '— wraps correctly over any wallpaper.');
  await pb.click('#msg-send');
  await pb.waitForSelector('.msg-grp.mine .msg-bub');

  // light theme over a busy wallpaper: bubbles must stay readable (Part 4)
  await pa.setViewportSize({ width: 1100, height: 820 });
  await pa.evaluate(() => { document.documentElement.setAttribute('data-theme', 'light'); localStorage.setItem('aa-theme', 'light'); });
  await pa.waitForTimeout(400);
  const lightC = await pa.evaluate(() => {
    const b = document.querySelector('.msg-grp.mine .msg-bub');
    const cs = getComputedStyle(b);
    return { bg: cs.backgroundColor, fg: cs.color, alpha: cs.backgroundColor.match(/[\d.]+\)$/)?.[0] };
  });
  assert.notEqual(lightC.bg, lightC.fg, 'bubble text differs from bubble bg (light theme)');
  assert.ok(!lightC.alpha || !lightC.alpha.startsWith('0.'), 'bubble surface stays opaque');
  await pa.screenshot({ path: '/home/user/theme-previews/v74-chat-light.png' });
  await pa.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); localStorage.setItem('aa-theme', 'dark'); });
  await pa.waitForTimeout(300);

  // responsive
  await pa.setViewportSize({ width: 390, height: 780 });
  await pa.waitForTimeout(500);
  await pa.screenshot({ path: '/home/user/theme-previews/v74-chat-mobile.png' });

  assert.deepEqual(errors.filter((e) => !e.includes('favicon')), [], 'no JS errors / 404s');
  await b1.close();
  console.log('PASS chat v74 UI: reference composition, stroke behind bubbles (non-interactive), composer tools, premium gallery (brandmarks/logos/themes/profiles/uploads), manga + upload wallpapers persist, non-premium lock, isolation, responsive');
  async function p2wait(p) { await p.waitForFunction(() => typeof me !== 'undefined' && !!me, null, { timeout: 20000 }); await p.waitForTimeout(1500); }
})().catch((e) => { console.error('SHOT FAIL', e); process.exit(1); });
