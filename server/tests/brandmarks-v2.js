'use strict';
// v72: supplied brandmarks served verbatim; flame glow yellow; entry has NO
// bounce (static after fade) and settles within 4s; the useless settings
// slider is gone; the Manga UI uses the Japanese logo (transparent PNG).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const base = 'http://127.0.0.1:3000';
const PUB = path.join(__dirname, '..', 'public');
async function servedBytes(p, url) {
  const r = await p.request.get(base + url);
  assert.equal(r.status(), 200, url);
  return Buffer.from(await r.body());
}
(async () => {
  const b = await chromium.launch();
  try {
    const p = await b.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('response', (r) => { if (r.status() === 404) errors.push(r.url()); });
    await p.addInitScript(() => { window.entryStarts = 0; document.addEventListener('animationstart', (e) => { if (e.animationName === 'aa-entry-mark') window.entryStarts++; }); });

    // 1) the app serves the supplied artwork byte-for-byte (entry mark, theme logo, favicon)
    for (const key of ['chrome', 'cloud', 'comic', 'glowing', 'glitch']) {
      for (const rel of [`/themes/${key}.png`, `/themes/marks/${key}.png`, `/themes/marks/${key}-icon.png`]) {
        const got = await servedBytes(p, rel);
        const want = fs.readFileSync(path.join(PUB, rel));
        assert.ok(got.equals(want), rel + ' served verbatim');
      }
    }
    for (const rel of ['/themes/comic-manga.png', '/themes/marks/comic-manga.png', '/themes/marks/comic-manga-icon.png', '/themes/comic/manga/dodon.png', '/themes/comic/manga/pokan.png']) {
      const got = await servedBytes(p, rel);
      assert.ok(got.equals(fs.readFileSync(path.join(PUB, rel))), rel + ' served verbatim');
      assert.equal(got.readUInt8(25), 6, rel + ' keeps transparency (RGBA)'); // PNG IHDR color type
    }

    // 2) entry: single play, NO bounce (transform never leaves `none`), settled ≤ 4s
    await p.goto(base);
    const t0 = Date.now();
    let bounced = false;
    while (Date.now() - t0 < 1000) {
      const tf = await p.evaluate(() => { const i = document.querySelector('#aa-entry img'); return i ? getComputedStyle(i).transform : 'gone'; });
      if (tf !== 'none' && tf !== 'gone') bounced = true;
      await p.waitForTimeout(90);
    }
    assert.equal(bounced, false, 'entry mark never transforms (no bounce/overshoot)');
    assert.equal(await p.evaluate(() => entryStarts), 1);
    await p.waitForFunction(() => { const e = document.getElementById('aa-entry'); return !e || e.classList.contains('aa-done') || getComputedStyle(e).visibility === 'hidden'; }, { timeout: 5000 });
    assert.ok(Date.now() - t0 <= 4600, 'entry settles within 4s');

    // 3) flame brandmark glow is yellow neon, not orange
    await p.evaluate(() => applyPremiumTheme('flame', null));
    const filt = await p.locator('#aa-entry img').evaluate((e) => getComputedStyle(e).filter);
    assert.match(filt, /drop-shadow/);
    assert.match(filt, /rgba\(255, 2(14|24), \d+, /, 'yellow glow rgb (255,214/224,…): ' + filt);
    assert.ok(!/255, 133, 30|255, 65, 10/.test(filt), 'no orange glow');

    // 4) the useless slider is gone; unrelated controls remain
    assert.equal(await p.evaluate(() => !!document.getElementById('pth-dir')), false, 'slider removed');
    assert.equal(await p.evaluate(() => !!document.getElementById('pth-dir-deg')), false, 'slider label removed');
    assert.equal(await p.evaluate(() => !!document.getElementById('pth-c1')), true, 'colour controls kept');
    assert.equal(await p.evaluate(() => !!document.getElementById('pth-preview')), true, 'preview kept');

    // 5) Manga UI wears the Japanese logo (transparent, no Latin) everywhere brandmarks render
    await p.evaluate(() => applyPremiumTheme('comic', { finish: 'manga' }));
    await p.waitForFunction(() => (document.querySelector('.home-logo img') || {}).src?.includes('comic-manga.png'));
    assert.equal(await p.locator('#aa-entry').getAttribute('data-mark'), 'comic');
    assert.ok((await p.locator('link[rel="icon"]').getAttribute('href')).includes('comic-manga-icon'));

    // the connection notice must be INVISIBLE on a healthy load (regression:
    // display:flex once beat the UA [hidden] rule and the spinner always showed)
    await p.goto(base);
    await p.waitForTimeout(500);
    assert.equal(await p.evaluate(() => getComputedStyle(document.getElementById('aa-net')).display), 'none', 'net notice hidden when online');

    assert.deepEqual(errors, [], 'no JS errors / 404s');
    console.log('PASS brandmarks v2: verbatim assets, yellow flame glow, static ≤4s entry, slider gone, JP manga logo wired');
  } finally { await b.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
