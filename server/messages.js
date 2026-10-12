'use strict';
/**
 * ============================================================================
 *  ART ARENA™ — v73 COMMUNITY phase 6 · MESSAGES (DMs + groups)
 * ============================================================================
 *  Built ON the dormant shipped tables (conversations/messages/mutes),
 *  extended with groups + membership + per-member read state. One message
 *  store, one realtime channel, no polling. Safety is server-enforced:
 *  threads start between friends only, blocks kill sending everywhere,
 *  bodies capped at the DB check (4000), per-user rate limit.
 */
const express = require('express');
const { pool, HttpError, ah, requireAuth, avatarUrlOf, premiumOf, themeCatalog } = require('./lib');
const multer = require('multer');
const rt = require('./realtime');
const { notifyUser } = require('./notify');
const { areFriends } = require('./friends');

const router = express.Router();
router.use(requireAuth);

const av = (r) => avatarUrlOf(r.avatar_storage_key, r.updated_at);
const UUID = /^[0-9a-f-]{36}$/i;

// anti-spam (§51): 120 messages/hour per sender
const buckets = new Map();
function rate(userId) {
  const now = Date.now();
  let b = buckets.get(userId);
  if (!b || now - b.t > 3600e3) { b = { t: now, n: 0 }; buckets.set(userId, b); }
  if (++b.n > 120) throw new HttpError(429, 'Too many messages — slow down a little.');
}

async function blockedPair(a, b) {
  const { rows } = await pool.query(
    `SELECT 1 FROM blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)`, [a, b]);
  return !!rows[0];
}

async function memberRows(threadId) {
  const { rows } = await pool.query(
    `SELECT cm.user_id, cm.last_read_at, u.username, u.display_name, up.avatar_storage_key, up.updated_at
       FROM conversation_members cm JOIN users u ON u.id = cm.user_id
       LEFT JOIN user_profiles up ON up.user_id = u.id
      WHERE cm.conversation_id = $1`, [threadId]);
  return rows;
}

async function assertMember(me, threadId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND user_id=$2`, [threadId, me]);
  if (!rows[0]) throw new HttpError(404, 'Thread not found.');
}

function threadShape(c, members, me, last, unread) {
  const others = members.filter((m) => m.user_id !== me);
  return {
    id: c.id, is_group: c.is_group, name: c.is_group ? c.name : null,
    title: c.is_group ? c.name : (others[0] ? (others[0].display_name || others[0].username) : '…'),
    members: members.map((m) => ({ id: m.user_id, username: m.username, display_name: m.display_name, avatar_url: av(m) })),
    last: last ? { id: last.id, body: last.body, sender_id: last.sender_id, created_at: last.created_at } : null,
    unread, updated_at: c.updated_at,
  };
}

// ---- list my threads (newest first; unread from per-member read state) ----
router.get('/threads', ah(async (req, res) => {
  const me = req.user.id;
  const { rows: convs } = await pool.query(
    `SELECT c.* FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id
      WHERE cm.user_id = $1 ORDER BY c.updated_at DESC LIMIT 50`, [me]);
  const out = [];
  for (const c of convs) {
    const members = await memberRows(c.id);
    const { rows: [my] } = await pool.query(
      `SELECT last_read_at FROM conversation_members WHERE conversation_id=$1 AND user_id=$2`, [c.id, me]);
    const { rows: [un] } = await pool.query(
      `SELECT count(*)::int n FROM messages WHERE conversation_id=$1 AND sender_id <> $2 AND created_at > $3`,
      [c.id, me, my.last_read_at]);
    const { rows: [last] } = await pool.query(
      `SELECT id, body, sender_id, created_at FROM messages WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 1`, [c.id]);
    out.push(threadShape(c, members, me, last, un.n));
  }
  res.json({ threads: out });
}));

// ---- open a DM (friends only; one thread per pair — unique index) --------
router.post('/threads', ah(async (req, res) => {
  const me = req.user.id;
  const other = String((req.body || {}).user_id || '');
  if (!UUID.test(other)) throw new HttpError(400, 'Invalid user id.');
  if (other === me) throw new HttpError(400, 'Choose someone else.');
  if (!(await areFriends(me, other))) throw new HttpError(403, 'Messages start between friends.');
  if (await blockedPair(me, other)) throw new HttpError(403, 'Messaging is unavailable between you two.');
  let { rows: [c] } = await pool.query(
    `SELECT id FROM conversations
      WHERE NOT is_group AND LEAST(participant_a,participant_b)=LEAST($1::uuid,$2::uuid) AND GREATEST(participant_a,participant_b)=GREATEST($1::uuid,$2::uuid)`,
    [me, other]);
  if (!c) {
    c = (await pool.query(
      `INSERT INTO conversations (participant_a, participant_b, is_group) VALUES ($1,$2,false) RETURNING id`,
      [me, other])).rows[0];
    await pool.query(
      `INSERT INTO conversation_members (conversation_id,user_id) VALUES ($1,$2),($1,$3) ON CONFLICT DO NOTHING`,
      [c.id, me, other]);
  }
  res.status(201).json({ id: c.id });
}));

// ---- create a group (creator + up to 7 friends; blocks respected) --------
router.post('/threads/group', ah(async (req, res) => {
  const me = req.user.id;
  const name = String((req.body || {}).name || '').trim().slice(0, 60);
  const ids = [...new Set((req.body || {}).member_ids || [])].filter((x) => UUID.test(x) && x !== me).slice(0, 7);
  if (!name) throw new HttpError(400, 'Give the group a name.');
  if (ids.length < 1) throw new HttpError(400, 'Add at least one more member.');
  for (const id of ids) {
    if (!(await areFriends(me, id))) throw new HttpError(403, 'Group members must be your friends.');
    if (await blockedPair(me, id)) throw new HttpError(403, 'Messaging is unavailable between you two.');
  }
  const c = (await pool.query(
    `INSERT INTO conversations (is_group, name, created_by) VALUES (true,$1,$2) RETURNING id`, [name, me])).rows[0];
  await pool.query(
    `INSERT INTO conversation_members (conversation_id,user_id) VALUES ($1,$2)`, [c.id, me]);
  for (const id of ids)
    await pool.query(`INSERT INTO conversation_members (conversation_id,user_id) VALUES ($1,$2)`, [c.id, id]);
  res.status(201).json({ id: c.id });
}));

// ---- thread meta ----------------------------------------------------------
router.get('/threads/:id', ah(async (req, res) => {
  await assertMember(req.user.id, req.params.id);
  const { rows: [c] } = await pool.query(`SELECT * FROM conversations WHERE id=$1`, [req.params.id]);
  res.json(threadShape(c, await memberRows(c.id), req.user.id, null, 0));
}));

// ---- message page (cursor = created_at) + mark read -----------------------
router.get('/threads/:id/messages', ah(async (req, res) => {
  const me = req.user.id, id = req.params.id;
  await assertMember(me, id);
  const args = [id, me];
  let where = '';
  if (req.query.before) { args.push(req.query.before); where = ` AND m.created_at < $3::timestamptz`; }
  const { rows } = await pool.query(
    `SELECT m.id, m.body, m.sender_id, m.created_at, m.edited_at, m.payload_type, m.payload, m.reply_to_id,
            r.body AS reply_body, ru.username AS reply_username, (s.message_id IS NOT NULL) AS saved,
            u.username, u.display_name, up.avatar_storage_key, up.updated_at
       FROM messages m JOIN users u ON u.id = m.sender_id LEFT JOIN user_profiles up ON up.user_id = u.id
       LEFT JOIN messages r ON r.id = m.reply_to_id LEFT JOIN users ru ON ru.id = r.sender_id
       LEFT JOIN saved_messages s ON s.message_id = m.id AND s.user_id = $2
      WHERE m.conversation_id = $1 ${where}
      ORDER BY m.created_at DESC LIMIT 51`, args);
  const hasMore = rows.length > 50;
  const page = rows.slice(0, 50).reverse();
  await pool.query(
    `UPDATE conversation_members SET last_read_at = now() WHERE conversation_id=$1 AND user_id=$2`, [id, me]);
  res.json({ messages: page, has_more: hasMore,
    next_before: hasMore ? page[0].created_at : null });
}));

// ---- v74: share payloads — server validates the referenced entity and
// stores an honest snapshot; the client can never inject arbitrary cards.
async function buildShare(me, threadId, share) {
  if (!share || typeof share !== 'object' || Array.isArray(share)) return null;
  const type = String(share.type || ''), ref = String(share.ref || '');
  if (type === 'sticker') {
    const st = CHAT_STICKERS.find((x) => x.key === ref);
    if (!st) throw new HttpError(400, 'Unknown sticker.');
    return { type: 'sticker_share', payload: { src: st.src, label: st.label } };
  }
  if (type === 'artwork') {
    const { rows } = await pool.query(
      `SELECT p.id, p.title, p.image_storage_key, u.username FROM community_posts p JOIN users u ON u.id=p.author_id
        WHERE p.id=$1 AND p.status='visible'`, [ref]);
    if (!rows[0]) throw new HttpError(404, 'Artwork not found or not public.');
    return { type: 'artwork_share', payload: { post_id: rows[0].id, title: rows[0].title, image_url: '/community-art/' + rows[0].image_storage_key, author_username: rows[0].username } };
  }
  if (type === 'profile') {
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.display_name, up.avatar_storage_key, up.updated_at FROM users u LEFT JOIN user_profiles up ON up.user_id=u.id WHERE u.id=$1`, [ref]);
    if (!rows[0]) throw new HttpError(404, 'Artist not found.');
    return { type: 'profile_share', payload: { user_id: rows[0].id, username: rows[0].username, display_name: rows[0].display_name, avatar_url: av(rows[0]) } };
  }
  if (type === 'battle') {
    const { rows } = await pool.query(
      `SELECT b.id, bc.summary_text FROM battles b LEFT JOIN battle_challenges bc ON bc.battle_id=b.id
        WHERE b.id=$1 AND EXISTS (SELECT 1 FROM battle_participants bp WHERE bp.battle_id=b.id AND bp.user_id=$2)`, [ref, me]);
    if (!rows[0]) throw new HttpError(404, 'Only battles you fought in can be shared.');
    return { type: 'battle_invitation', payload: { battle_id: rows[0].id, theme: rows[0].summary_text } };
  }
  if (type === 'room') {
    const { rows } = await pool.query(`SELECT id, code, name, battle_mode, status FROM battle_rooms WHERE code=$1 AND deleted_at IS NULL`, [ref]);
    if (!rows[0]) throw new HttpError(404, 'Room not found.');
    return { type: 'room_share', payload: { code: rows[0].code, name: rows[0].name, battle_mode: rows[0].battle_mode, status: rows[0].status } };
  }
  if (type === 'stream') {
    const { rows } = await pool.query(`SELECT id, provider, status FROM streams WHERE id=$1`, [ref]);
    if (!rows[0]) throw new HttpError(404, 'Stream not found.');
    return { type: 'stream_share', payload: { stream_id: rows[0].id, provider: rows[0].provider, status: rows[0].status } };
  }
  if (type === 'image' || type === 'audio') {
    const kind = type === 'image' ? 'image' : 'audio';
    const { rows } = await pool.query(`SELECT id, kind FROM chat_uploads WHERE id=$1 AND user_id=$2`, [ref, me]);
    if (!rows[0] || rows[0].kind !== kind) throw new HttpError(404, 'Attachment not found.');
    await pool.query(`UPDATE chat_uploads SET conversation_id=$1 WHERE id=$2`, [threadId, ref]);
    return { type: kind + '_share', payload: { upload_id: ref } };
  }
  throw new HttpError(400, 'Unknown share type.');
}

// ---- send (server-authoritative fan-out: realtime + persistent notif) -----
router.post('/threads/:id/messages', ah(async (req, res) => {
  const me = req.user.id, id = req.params.id;
  const body = String((req.body || {}).body || '').trim();
  if (body.length < 1) throw new HttpError(400, 'Message is empty.');
  if (body.length > 4000) throw new HttpError(400, 'Message is too long (4000 max).');
  await assertMember(me, id);
  rate(me);
  const members = await memberRows(id);
  for (const m of members) {
    if (m.user_id !== me && (await blockedPair(me, m.user_id)))
      throw new HttpError(403, 'Messaging is unavailable between you two.');
  }
  const share = await buildShare(me, id, (req.body || {}).share);
  // v76: replies reference a message of THIS conversation (server-validated)
  let replyTo = null;
  const rtId = String((req.body || {}).reply_to || '');
  if (rtId) {
    const rr = await pool.query(
      `SELECT m.id, m.body, u.username FROM messages m JOIN users u ON u.id = m.sender_id
        WHERE m.id = $1 AND m.conversation_id = $2`, [rtId, id]);
    if (!rr.rows[0]) throw new HttpError(404, 'Reply target not found in this conversation.');
    replyTo = rr.rows[0];
  }
  const { rows: [msg] } = await pool.query(
    `INSERT INTO messages (conversation_id, sender_id, body, payload_type, payload, reply_to_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
    [id, me, body, share ? share.type : null, share ? JSON.stringify(share.payload) : null, replyTo ? replyTo.id : null]);
  await pool.query(`UPDATE conversations SET updated_at = now() WHERE id=$1`, [id]);
  const wire = { id: msg.id, body, sender_id: me, created_at: msg.created_at, payload_type: share ? share.type : null, payload: share ? share.payload : null, reply_to: replyTo ? { id: replyTo.id, username: replyTo.username, body: replyTo.body } : null };
  const meRow = members.find((m) => m.user_id === me);
  for (const m of members) {
    if (m.user_id === me) continue;
    rt.sendToUser(m.user_id, { type: 'chat.message', thread_id: id, message: { ...wire, sender: { id: me, username: meRow.username, display_name: meRow.display_name, avatar_url: av(meRow) } } });
    notifyUser(m.user_id, 'message', { thread_id: id, from_username: meRow.username, preview: body.slice(0, 80), actor: me });
  }
  res.status(201).json({ id: msg.id, created_at: msg.created_at, payload_type: share ? share.type : null, payload: share ? share.payload : null, reply_to: wire.reply_to });
}));

// ---- v77: personal chat saves (any member may save; purely personal) --------
router.post('/threads/:id/messages/:mid/save', ah(async (req, res) => {
  const me = req.user.id, id = req.params.id, mid = req.params.mid;
  await assertMember(me, id);
  const chk = await pool.query(`SELECT id FROM messages WHERE id=$1 AND conversation_id=$2`, [mid, id]);
  if (!chk.rows[0]) throw new HttpError(404, 'Message not found in this conversation.');
  await pool.query(`INSERT INTO saved_messages (user_id, message_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [me, mid]);
  res.json({ ok: true, saved: true });
}));
router.delete('/threads/:id/messages/:mid/save', ah(async (req, res) => {
  const me = req.user.id;
  await pool.query(`DELETE FROM saved_messages WHERE user_id=$1 AND message_id=$2`, [me, req.params.mid]);
  res.json({ ok: true, saved: false });
}));
router.get('/saved', ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.saved_at, m.id, m.conversation_id, m.body, m.created_at, u.username
       FROM saved_messages s JOIN messages m ON m.id = s.message_id JOIN users u ON u.id = m.sender_id
      WHERE s.user_id = $1 ORDER BY s.saved_at DESC LIMIT 100`, [req.user.id]);
  res.json({ saved: rows });
}));

// ---- v77: edit own message (text-only; share payloads stay immutable) -----
router.put('/threads/:id/messages/:mid', ah(async (req, res) => {
  const me = req.user.id, id = req.params.id, mid = req.params.mid;
  const body = String((req.body || {}).body || '').trim();
  if (body.length < 1) throw new HttpError(400, 'Message is empty.');
  if (body.length > 4000) throw new HttpError(400, 'Message is too long (4000 max).');
  await assertMember(me, id);
  const { rows } = await pool.query(
    `UPDATE messages SET body=$1, edited_at=now() WHERE id=$2 AND conversation_id=$3 AND sender_id=$4 RETURNING id, edited_at`,
    [body, mid, id, me]);
  if (!rows[0]) throw new HttpError(404, 'Only your own messages can be edited.');
  const members = await memberRows(id);
  for (const m of members) if (m.user_id !== me)
    rt.sendToUser(m.user_id, { type: 'chat.edit', thread_id: id, message_id: mid, body, edited_at: rows[0].edited_at });
  res.json({ id: mid, body, edited_at: rows[0].edited_at });
}));

// ---- v77: delete own message ------------------------------------------------
router.delete('/threads/:id/messages/:mid', ah(async (req, res) => {
  const me = req.user.id, id = req.params.id, mid = req.params.mid;
  await assertMember(me, id);
  const { rows } = await pool.query(
    `DELETE FROM messages WHERE id=$1 AND conversation_id=$2 AND sender_id=$3 RETURNING id`,
    [mid, id, me]);
  if (!rows[0]) throw new HttpError(404, 'Only your own messages can be deleted.');
  const members = await memberRows(id);
  for (const m of members) if (m.user_id !== me)
    rt.sendToUser(m.user_id, { type: 'chat.delete', thread_id: id, message_id: mid });
  res.json({ ok: true });
}));

// ---- mark read (also happens on every page fetch) -------------------------
router.post('/threads/:id/read', ah(async (req, res) => {
  await assertMember(req.user.id, req.params.id);
  await pool.query(
    `UPDATE conversation_members SET last_read_at = now() WHERE conversation_id=$1 AND user_id=$2`,
    [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

// ===========================================================================
// v74 — CHAT APPEARANCE: Premium per-conversation customization + uploads.
// One wallpaper registry built from the ACTUAL shipped assets (no second
// catalogue), server-enforced Premium on every save, personal-per-member
// storage that can never overwrite another member's choice.
// ===========================================================================
const THEME_KEYS = themeCatalog().filter((t) => t.premium).map((t) => t.key);
const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
const BRANDMARKS = THEME_KEYS.map((k) => ({ key: k, label: cap(k), src: `/themes/marks/${k}.png` }));
BRANDMARKS.push({ key: 'manga', label: 'Manga', src: '/themes/marks/comic-manga.png' });
BRANDMARKS.push({ key: 'chrome-gold', label: 'Chrome Gold', src: '/themes/marks/chrome-gold.png' });
const LOGOS = THEME_KEYS.map((k) => ({ key: k, label: cap(k) + ' logo', src: `/themes/${k}.png` }));
LOGOS.push({ key: 'manga', label: 'Manga logo (Japanese)', src: '/themes/comic-manga.png' });
LOGOS.push({ key: 'chrome-gold', label: 'Chrome Gold logo', src: '/themes/chrome-gold.png' });
const CHAT_STICKERS = BRANDMARKS; // official marks double as chat stickers
const THEME_BG = [
  { key: 'comic', label: 'Comic pop art', src: '/themes/comic/background.jpg' },
  { key: 'manga', label: 'Manga ink', src: '/themes/comic/manga/background.jpg' },
  { key: 'graffiti', label: 'Graffiti wall', src: '/themes/graffiti-bg.png' },
];
const THEME_ART_EXT = { chrome: 'jpg', cloud: 'jpg', comic: 'jpg', flame: 'png', glitch: 'jpg', glowing: 'jpg', graffiti: 'jpg', magazine: 'png', pixel: 'jpg' };
for (const k of THEME_KEYS) {
  THEME_BG.push({ key: 'art-' + k, label: cap(k) + ' artwork', src: `/themes/profile-${k}.${THEME_ART_EXT[k] || 'jpg'}` });
}
THEME_BG.push({ key: 'art-chrome-gold', label: 'Chrome Gold artwork', src: '/themes/profile-chrome-gold.png' });

// ---- byte sniffing: never trust the filename or the client mime -----------
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return 'audio/webm';
  if (buf.toString('ascii', 0, 3) === 'ID3' || (buf[0] === 0xFF && (buf[1] & 0xE6) === 0xE0)) return 'audio/mpeg';
  if (buf.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  return null;
}
function imageDims(mime, buf) {
  try {
    if (mime === 'image/png') return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (mime === 'image/webp') {
      const f = buf.toString('ascii', 12, 16);
      if (f === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      if (f === 'VP8L') { const b = buf.readUInt32LE(21); return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 }; }
      if (f === 'VP8X') return { w: (buf.readUIntLE(24, 3) + 1), h: (buf.readUIntLE(27, 3) + 1) };
    }
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xFF) { i++; continue; }
        const m = buf[i + 1];
        if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC)
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch (_) {}
  return null;
}
const wallUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// anti-spam for uploads: 40/hour
const upBuckets = new Map();
function upRate(userId) {
  const now = Date.now();
  let b = upBuckets.get(userId);
  if (!b || now - b.t > 3600e3) { b = { t: now, n: 0 }; upBuckets.set(userId, b); }
  if (++b.n > 40) throw new HttpError(429, 'Too many uploads — slow down a little.');
}

// ---- upload (wallpaper | image | audio attachment) -------------------------
router.post('/uploads', wallUpload.single('file'), ah(async (req, res) => {
  const me = req.user.id;
  const kind = String((req.body || {}).kind || '');
  if (!['wallpaper', 'image', 'audio'].includes(kind)) throw new HttpError(400, 'Unknown upload kind.');
  if (kind === 'wallpaper') {
    const p = await premiumOf(me);
    if (!p.active) throw new HttpError(403, 'Chat wallpapers are a Premium feature.', { premium: true });
  }
  if (!req.file) throw new HttpError(400, 'No file received.');
  upRate(me);
  const mime = sniff(req.file.buffer);
  const isImageKind = kind !== 'audio';
  if (isImageKind && (!mime || !mime.startsWith('image/'))) throw new HttpError(415, 'Only PNG, JPEG or WebP images are accepted (validated by content, not filename).');
  if (!isImageKind && (!mime || !mime.startsWith('audio/'))) throw new HttpError(415, 'Only recorded audio (WebM/OGG/MP3) is accepted.');
  let w = null, h = null;
  if (isImageKind) {
    const d = imageDims(mime, req.file.buffer);
    if (!d || d.w < 16 || d.h < 16 || d.w > 10000 || d.h > 10000) throw new HttpError(422, 'Image dimensions are invalid.');
    w = d.w; h = d.h;
  }
  const { rows } = await pool.query(
    `INSERT INTO chat_uploads (user_id, kind, mime, width, height, data) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
    [me, kind, mime, w, h, req.file.buffer]);
  // bounded wallpaper library: keep the 12 most recent UNREFERENCED uploads
  if (kind === 'wallpaper') {
    await pool.query(
      `DELETE FROM chat_uploads WHERE id IN (
         SELECT id FROM chat_uploads
          WHERE user_id=$1 AND kind='wallpaper'
            AND NOT EXISTS (SELECT 1 FROM chat_customizations c WHERE c.wallpaper->>'kind'='upload' AND (c.wallpaper->>'ref')=chat_uploads.id::text)
          ORDER BY created_at DESC OFFSET 12)`, [me]);
  }
  res.status(201).json({ id: rows[0].id, created_at: rows[0].created_at, width: w, height: h });
}));

// ---- serve (owner, or conversation members for attachments) ----------------
router.get('/uploads/:id', ah(async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM chat_uploads WHERE id=$1`, [req.params.id]);
  const u = rows[0];
  if (!u) throw new HttpError(404, 'Not found.');
  const me = req.user.id;
  if (u.user_id !== me) {
    if (u.kind === 'wallpaper' || !u.conversation_id) throw new HttpError(403, 'Private upload.');
    const { rows: mem } = await pool.query(`SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND user_id=$2`, [u.conversation_id, me]);
    if (!mem[0]) throw new HttpError(403, 'Private upload.');
  }
  res.set('Cache-Control', 'private, max-age=3600');
  res.set('Content-Type', u.mime);
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(u.data);
}));

// ---- delete own upload ------------------------------------------------------
router.delete('/uploads/:id', ah(async (req, res) => {
  const { rows } = await pool.query(`DELETE FROM chat_uploads WHERE id=$1 AND user_id=$2 RETURNING id`, [req.params.id, req.user.id]);
  if (!rows[0]) throw new HttpError(404, 'Not found.');
  res.json({ ok: true });
}));

// ---- wallpaper catalogue (single source of truth) ---------------------------
router.get('/threads/:id/walls', ah(async (req, res) => {
  const me = req.user.id, id = req.params.id;
  await assertMember(me, id);
  const p = await premiumOf(me);
  const members = await memberRows(id);
  const profiles = members
    .filter((m) => m.avatar_storage_key)
    .map((m) => ({ id: m.user_id === me ? 'self' : m.user_id, label: m.user_id === me ? 'Your avatar' : '@' + m.username + '’s avatar', src: av(m) }));
  const { rows: ups } = await pool.query(
    `SELECT id, width, height, created_at FROM chat_uploads WHERE user_id=$1 AND kind='wallpaper' ORDER BY created_at DESC LIMIT 12`, [me]);
  res.json({
    premium: p.active,
    brandmarks: BRANDMARKS, logos: LOGOS, themes: THEME_BG, profiles,
    uploads: ups.map((u) => ({ id: u.id, width: u.width, height: u.height, src: '/api/messages/uploads/' + u.id })),
  });
}));

// ---- validation of a saved wallpaper object ---------------------------------
function sanitizeWallpaper(w, me, memberIds) {
  if (!w || typeof w !== 'object' || Array.isArray(w)) return null;
  const kind = String(w.kind || 'default');
  const dim = Math.max(0, Math.min(80, Math.round(Number(w.dim) || 0)));
  const pos = ['center', 'top', 'bottom'].includes(w.pos) ? w.pos : 'center';
  const fit = ['cover', 'contain'].includes(w.fit) ? w.fit : 'cover';
  const base = { kind, pos, fit, dim };
  if (kind === 'default') return base;
  const ref = String(w.ref || '');
  if (kind === 'brandmark' && BRANDMARKS.some((b) => b.key === ref)) return { ...base, ref };
  if (kind === 'logo' && LOGOS.some((l) => l.key === ref)) return { ...base, ref };
  if (kind === 'theme' && THEME_BG.some((t) => t.key === ref)) return { ...base, ref };
  if (kind === 'profile' && (ref === 'self' || (UUID.test(ref) && memberIds.includes(ref)))) return { ...base, ref };
  if (kind === 'upload' && UUID.test(ref)) return { ...base, ref }; // ownership re-checked on save
  return null;
}

// ---- my customization for a thread ------------------------------------------
router.get('/threads/:id/customization', ah(async (req, res) => {
  const me = req.user.id, id = req.params.id;
  await assertMember(me, id);
  const { rows } = await pool.query(`SELECT wallpaper FROM chat_customizations WHERE user_id=$1 AND conversation_id=$2`, [me, id]);
  const p = await premiumOf(me);
  res.json({ wallpaper: rows[0] ? rows[0].wallpaper : { kind: 'default' }, premium: p.active });
}));

// ---- save customization (PREMIUM enforced server-side) -----------------------
router.put('/threads/:id/customization', ah(async (req, res) => {
  const me = req.user.id, id = req.params.id;
  await assertMember(me, id);
  const p = await premiumOf(me);
  if (!p.active) throw new HttpError(403, 'Chat customization is a Premium feature.', { premium: true });
  const members = await memberRows(id);
  const wall = sanitizeWallpaper((req.body || {}).wallpaper, me, members.map((m) => m.user_id));
  if (!wall) throw new HttpError(400, 'Invalid wallpaper selection.');
  if (wall.kind === 'upload') {
    const { rows } = await pool.query(`SELECT 1 FROM chat_uploads WHERE id=$1 AND user_id=$2 AND kind='wallpaper'`, [wall.ref, me]);
    if (!rows[0]) throw new HttpError(404, 'That wallpaper upload no longer exists.');
  }
  await pool.query(
    `INSERT INTO chat_customizations (user_id, conversation_id, wallpaper, updated_at)
     VALUES ($1,$2,$3,now())
     ON CONFLICT (user_id, conversation_id) DO UPDATE SET wallpaper=EXCLUDED.wallpaper, updated_at=now()`,
    [me, id, JSON.stringify(wall)]);
  res.json({ ok: true, wallpaper: wall });
}));

module.exports = { router };
