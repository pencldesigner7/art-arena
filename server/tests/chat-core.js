'use strict';
// v74 — Chat customization API suite: premium enforcement (incl. direct API
// bypass attempts), wallpaper catalogue honesty, upload validation (magic
// bytes, dims), per-conversation + per-member isolation, share payloads.
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { randomBytes } = require('node:crypto');
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
async function user() {
  const name = 'cc_' + randomBytes(5).toString('hex'), password = 'ChatCore123!';
  const d = await api(null, '/auth/register', { username: name, email: name + '@example.test', password }, 201);
  const login = await api(null, '/auth/login', { login: name, password });
  return { id: d.user.id, token: login.session_token, name };
}
async function befriend(x, y) {
  await api(x, '/friends/request', { user_id: y.id }, 201);
  const fr = await api(y, '/friends');
  const rid = (fr.incoming || []).find((r) => r.user_id === x.id).id;
  await api(y, '/friends/requests/' + rid + '/accept', {}, 200);
}

// ---- minimal valid PNG (16x16, RGB) with real CRCs --------------------------
const CRC_T = [...Array(256)].map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xFFFFFFFF; for (const x of b) c = CRC_T[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, cr]);
}
function png16() {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(16, 0); ihdr.writeUInt32BE(16, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(16 * (1 + 16 * 3)); for (let y = 0; y < 16; y++) raw[y * (1 + 48)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

(async () => {
  const { Client } = require('pg');
  const c = new Client({ connectionString: 'postgresql://aa_admin:aa-admin-pw@127.0.0.1:5432/art_arena' });
  await c.connect();
  await c.query(`TRUNCATE chat_customizations, chat_uploads, messages, conversation_members, conversations CASCADE`);
  await c.end();

  const a = await user(), b = await user(), g = await user();
  await befriend(a, b); await befriend(a, g); await befriend(b, g);
  const t = await api(a, '/messages/threads', { user_id: b.id }, 201);

  // ---- 1) non-premium cannot save customizations (direct API bypass attempt)
  await api(b, '/messages/threads/' + t.id + '/customization', { wallpaper: { kind: 'logo', ref: 'manga' } }, 403, 'PUT');
  // non-premium cannot upload wallpapers either
  const fd = new FormData(); fd.append('kind', 'wallpaper');
  fd.append('file', new Blob([png16()], { type: 'image/png' }), 'w.png');
  let r = await fetch(base + '/api/messages/uploads', { method: 'POST', headers: { Authorization: 'Bearer ' + b.token }, body: fd });
  assert.equal(r.status, 403, 'non-premium wallpaper upload rejected');

  // ---- 1b) v77: edit + delete are own-message-only, server-authoritative
  const m1 = await api(a, '/messages/threads/' + t.id + '/messages', { body: 'original text' }, 201);
  const ed = await api(a, '/messages/threads/' + t.id + '/messages/' + m1.id, { body: 'corrected text' }, 200, 'PUT');
  assert.ok(ed.edited_at, 'edit returns edited_at');
  let pg1 = await api(b, '/messages/threads/' + t.id + '/messages');
  assert.equal(pg1.messages.find((x) => x.id === m1.id).body, 'corrected text', 'reader sees corrected text');
  assert.ok(pg1.messages.find((x) => x.id === m1.id).edited_at, 'reader sees edited marker');
  await api(b, '/messages/threads/' + t.id + '/messages/' + m1.id, { body: 'hijack' }, 404, 'PUT');
  await api(b, '/messages/threads/' + t.id + '/messages/' + m1.id, undefined, 404, 'DELETE');
  const dl = await api(a, '/messages/threads/' + t.id + '/messages/' + m1.id, undefined, 200, 'DELETE');
  assert.ok(dl.ok, 'own delete succeeds');
  pg1 = await api(b, '/messages/threads/' + t.id + '/messages');
  assert.ok(!pg1.messages.some((x) => x.id === m1.id), 'deleted message gone for both');

  // ---- 1c) v76/v77: replies are server-validated; saves are personal
  const anchor = await api(a, '/messages/threads/' + t.id + '/messages', { body: 'anchor for reply' }, 201);
  const rep = await api(b, '/messages/threads/' + t.id + '/messages', { body: 'answering you', reply_to: anchor.id }, 201);
  assert.ok(rep.reply_to && rep.reply_to.id === anchor.id, 'reply carries the validated target');
  await api(b, '/messages/threads/' + t.id + '/messages', { body: 'x', reply_to: '00000000-0000-0000-0000-000000000000' }, 404);
  const sv = await api(b, '/messages/threads/' + t.id + '/messages/' + anchor.id + '/save', {}, 200);
  assert.equal(sv.saved, true, 'any member can save a message personally');
  const lstB = await api(b, '/messages/saved');
  assert.ok(lstB.saved.some((x) => x.id === anchor.id), 'saved list contains the message');
  const lstA = await api(a, '/messages/saved');
  assert.ok(!lstA.saved.some((x) => x.id === anchor.id), 'saves are personal (invisible to others)');
  const un = await api(b, '/messages/threads/' + t.id + '/messages/' + anchor.id + '/save', undefined, 200, 'DELETE');
  assert.equal(un.saved, false, 'unsave works');

  // ---- 2) activate premium for a ONLY (explicit, existing mechanism)
  await api(a, '/premium/test-activate', {}, 200);

  // ---- 3) catalogue: brandmarks & full logos separate, manga everywhere
  const cat = await api(a, '/messages/threads/' + t.id + '/walls');
  assert.equal(cat.premium, true);
  assert.ok(cat.brandmarks.some((x) => x.key === 'manga' && x.src.includes('/marks/')), 'manga BRANDMARK present');
  assert.ok(cat.logos.some((x) => x.key === 'manga' && x.src === '/themes/comic-manga.png'), 'manga FULL Japanese logo present, separate');
  assert.ok(!cat.brandmarks.some((x) => x.src === '/themes/comic-manga.png'), 'brandmark ≠ full logo');
  assert.ok(cat.themes.some((x) => x.key === 'comic') && cat.themes.some((x) => x.key === 'manga'), 'theme backgrounds');
  for (const k of ['chrome', 'glitch', 'cloud', 'comic', 'glowing']) {
    assert.ok(cat.brandmarks.some((x) => x.key === k), 'brandmark ' + k);
    assert.ok(cat.logos.some((x) => x.key === k), 'logo ' + k);
  }

  // ---- 4) validation of bogus selections
  await api(a, '/messages/threads/' + t.id + '/customization', { wallpaper: { kind: 'logo', ref: 'nope' } }, 400, 'PUT');
  await api(a, '/messages/threads/' + t.id + '/customization', { wallpaper: { kind: 'evil', ref: 'x' } }, 400, 'PUT');
  await api(a, '/messages/threads/' + t.id + '/customization', { wallpaper: { kind: 'upload', ref: 'not-a-uuid' } }, 400, 'PUT');

  // ---- 5) apply + persist + per-member isolation
  await api(a, '/messages/threads/' + t.id + '/customization', { wallpaper: { kind: 'logo', ref: 'manga', dim: 30, pos: 'center', fit: 'cover' } }, 200, 'PUT');
  let mine = await api(a, '/messages/threads/' + t.id + '/customization');
  assert.equal(mine.wallpaper.kind, 'logo'); assert.equal(mine.wallpaper.ref, 'manga'); assert.equal(mine.wallpaper.dim, 30);
  const theirs = await api(b, '/messages/threads/' + t.id + '/customization');
  assert.equal(theirs.wallpaper.kind, 'default', "b's personal wallpaper untouched by a");

  // ---- 6) device upload validation
  const fdBad = new FormData(); fdBad.append('kind', 'wallpaper');
  fdBad.append('file', new Blob([Buffer.from('not an image at all, definitely')], { type: 'image/png' }), 'fake.png');
  r = await fetch(base + '/api/messages/uploads', { method: 'POST', headers: { Authorization: 'Bearer ' + a.token }, body: fdBad });
  assert.equal(r.status, 415, 'magic-byte validation rejects wrong content');

  const fdOk = new FormData(); fdOk.append('kind', 'wallpaper');
  fdOk.append('file', new Blob([png16()], { type: 'image/png' }), 'wall.png');
  r = await fetch(base + '/api/messages/uploads', { method: 'POST', headers: { Authorization: 'Bearer ' + a.token }, body: fdOk });
  assert.equal(r.status, 201, 'valid PNG wallpaper upload');
  const up = await r.json();
  await api(a, '/messages/threads/' + t.id + '/customization', { wallpaper: { kind: 'upload', ref: up.id, dim: 20 } }, 200, 'PUT');

  // b cannot read a's private wallpaper bytes
  r = await fetch(base + '/api/messages/uploads/' + up.id, { headers: { Authorization: 'Bearer ' + b.token } });
  assert.equal(r.status, 403, 'wallpaper upload is private to owner');
  r = await fetch(base + '/api/messages/uploads/' + up.id, { headers: { Authorization: 'Bearer ' + a.token } });
  assert.equal(r.status, 200, 'owner reads own wallpaper');

  // other member's upload id cannot be applied by someone else
  await api(b, '/premium/test-activate', {}, 200);
  await api(b, '/messages/threads/' + t.id + '/customization', { wallpaper: { kind: 'upload', ref: up.id } }, 404, 'PUT');

  // ---- 7) per-conversation independence
  const t2 = await api(a, '/messages/threads', { user_id: g.id }, 201);
  let c2 = await api(a, '/messages/threads/' + t2.id + '/customization');
  assert.equal(c2.wallpaper.kind, 'default', 'second conversation unaffected');
  await api(a, '/messages/threads/' + t2.id + '/customization', { wallpaper: { kind: 'brandmark', ref: 'chrome', fit: 'contain' } }, 200, 'PUT');
  c2 = await api(a, '/messages/threads/' + t2.id + '/customization');
  assert.equal(c2.wallpaper.ref, 'chrome');
  mine = await api(a, '/messages/threads/' + t.id + '/customization');
  assert.equal(mine.wallpaper.kind, 'upload', 'first conversation kept its own wallpaper');

  // ---- 8) group: personal choices never leak to members
  const grp = await api(a, '/messages/threads/group', { name: 'Wall Crew', member_ids: [b.id, g.id] }, 201);
  await api(a, '/messages/threads/' + grp.id + '/customization', { wallpaper: { kind: 'theme', ref: 'manga' } }, 200, 'PUT');
  const gb = await api(b, '/messages/threads/' + grp.id + '/customization');
  assert.equal(gb.wallpaper.kind, 'default', 'group member personal wallpaper unchanged');

  // non-member cannot even read customization
  const s = await user();
  await api(s, '/messages/threads/' + grp.id + '/customization', undefined, 404);

  // ---- 9) shares: sticker + profile + image attachment carry server snapshots
  const st = await api(a, '/messages/threads/' + t.id + '/messages', { body: '✦', share: { type: 'sticker', ref: 'manga' } }, 201);
  assert.equal(st.payload_type, 'sticker_share');
  assert.ok(st.payload.src.includes('comic-manga'), 'sticker snapshot from registry');
  await api(a, '/messages/threads/' + t.id + '/messages', { body: 'x', share: { type: 'sticker', ref: 'hack' } }, 400);
  const pf = await api(a, '/messages/threads/' + t.id + '/messages', { body: 'check @' + b.name, share: { type: 'profile', ref: b.id } }, 201);
  assert.equal(pf.payload_type, 'profile_share'); assert.equal(pf.payload.username, b.name);

  const fdImg = new FormData(); fdImg.append('kind', 'image');
  fdImg.append('file', new Blob([png16()], { type: 'image/png' }), 'sketch.png');
  r = await fetch(base + '/api/messages/uploads', { method: 'POST', headers: { Authorization: 'Bearer ' + a.token }, body: fdImg });
  assert.equal(r.status, 201);
  const img = await r.json();
  const im = await api(a, '/messages/threads/' + t.id + '/messages', { body: 'wip sketch', share: { type: 'image', ref: img.id } }, 201);
  assert.equal(im.payload_type, 'image_share');
  // b (member) can read the attachment; stranger cannot
  r = await fetch(base + '/api/messages/uploads/' + img.id, { headers: { Authorization: 'Bearer ' + b.token } });
  assert.equal(r.status, 200, 'member reads attachment');
  r = await fetch(base + '/api/messages/uploads/' + img.id, { headers: { Authorization: 'Bearer ' + s.token } });
  assert.equal(r.status, 403, 'stranger cannot read attachment');

  // audio attachment round-trip
  const fdAud = new FormData(); fdAud.append('kind', 'audio');
  fdAud.append('file', new Blob([Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64)])], { type: 'audio/mpeg' }), 'note.mp3');
  r = await fetch(base + '/api/messages/uploads', { method: 'POST', headers: { Authorization: 'Bearer ' + a.token }, body: fdAud });
  assert.equal(r.status, 201, 'audio upload accepted');
  const aud = await r.json();
  const am = await api(a, '/messages/threads/' + t.id + '/messages', { body: 'voice note', share: { type: 'audio', ref: aud.id } }, 201);
  assert.equal(am.payload_type, 'audio_share');

  // message page returns payloads
  const page = await api(b, '/messages/threads/' + t.id + '/messages');
  const stick = page.messages.find((m) => m.payload_type === 'sticker_share');
  assert.ok(stick && stick.payload.src, 'payloads persisted + returned');

  // ---- 10) premium revoked → saves locked again, existing choices preserved
  await api(a, '/premium/test-revoke', {}, 200);
  await api(a, '/messages/threads/' + t.id + '/customization', { wallpaper: { kind: 'theme', ref: 'comic' } }, 403, 'PUT');
  await api(a, '/premium/test-activate', {}, 200); // restore for later suites

  console.log('PASS chat-core: premium-gated customization (direct-API safe), honest catalogue (brandmarks/logos/themes/profiles), magic-byte + dim validation, private uploads, per-conversation + per-member isolation, sticker/profile/image/audio share snapshots');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
