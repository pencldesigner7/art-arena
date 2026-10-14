'use strict';
// ---------------------------------------------------------------------------
// v73 COMMUNITY — Phase 1 (foundation) + Phase 2 (artwork).
// Reuses the dormant community tables from the original schema
// (community_posts / community_post_likes / community_comments / follows /
// blocks / mutes / reports) and the avatar byte-store pattern; adds only the
// genuinely missing pieces (community_artwork, artwork_saves, two notification
// types — see server.js v73 migrations + schema.sql parity).
// Every action is authorized HERE: ownership, blocks, visibility and counts
// are server truth. The client never supplies ids/flags we trust.
// ---------------------------------------------------------------------------
const express = require('express');
const multer = require('multer');
const { pool, HttpError, ah, avatarUrlOf, requireAuth } = require("./lib");
const { notifyUser } = require('./notify');
const router = express.Router();
const av = (r) => avatarUrlOf(r.avatar_storage_key, r.updated_at);
router.use(requireAuth); // artwork bytes are served app-level at /community-art/:key

// ---- anti-spam (§51): server-side token buckets, configurable, per action
const LIMITS = {
  post:    { n: 10,  ms: 3600e3 },
  comment: { n: 60,  ms: 3600e3 },
  like:    { n: 300, ms: 3600e3 },
  save:    { n: 300, ms: 3600e3 },
  follow:  { n: 200, ms: 3600e3 },
  report:  { n: 20,  ms: 3600e3 },
};
const buckets = new Map();
function rate(userId, kind) {
  const L = LIMITS[kind]; const now = Date.now();
  const key = kind + ':' + userId;
  let b = buckets.get(key);
  if (!b || now - b.t0 > L.ms) { b = { t0: now, n: 0 }; buckets.set(key, b); }
  if (++b.n > L.n) throw new HttpError(429, 'Too many actions — slow down a little.');
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now - b.t0 > 3600e3) buckets.delete(k); }, 600e3).unref();

// ---- tags (§17): normalized, de-duplicated, capped — no tag spam
function normalizeTags(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(',');
  const out = [];
  for (const t0 of raw) {
    const t = String(t0).trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 30);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= 12) break;
  }
  return out;
}

async function blockPair(a, b) {
  const { rows } = await pool.query(
    `SELECT 1 FROM blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)`, [a, b]);
  return !!rows[0];
}
// feed/comment visibility: never show a blocked artist's content (both ways)
const noBlock = (me, author) =>
  `NOT EXISTS (SELECT 1 FROM blocks bl WHERE (bl.blocker_id=${me} AND bl.blocked_id=${author}) OR (bl.blocker_id=${author} AND bl.blocked_id=${me}))`;

const POST_COLS = `p.id, p.author_id, p.title, p.caption, p.tags, p.image_storage_key, p.battle_id,
  p.like_count, p.comment_count, p.created_at, p.status,
  u.username, u.display_name, up.avatar_storage_key`;
const POST_ME = `EXISTS(SELECT 1 FROM community_post_likes l WHERE l.post_id=p.id AND l.user_id=$2) AS liked_by_me,
  EXISTS(SELECT 1 FROM artwork_saves s WHERE s.post_id=p.id AND s.user_id=$2) AS saved_by_me`;

function postCard(r) {
  return {
    id: r.id, author: { id: r.author_id, username: r.username, display_name: r.display_name, avatar_url: av(r) },
    title: r.title, caption: r.caption, tags: r.tags, image_url: '/community-art/' + r.image_storage_key,
    battle_id: r.battle_id, like_count: r.like_count, comment_count: r.comment_count,
    liked_by_me: !!r.liked_by_me, saved_by_me: !!r.saved_by_me, created_at: r.created_at,
  };
}

async function battleContext(ids) {
  if (!ids.length) return new Map();
  const { rows } = await pool.query(
    `SELECT b.id, b.status, bc.summary_text, br.winner_id,
       (SELECT json_agg(json_build_object('user_id', bp.user_id, 'username', u.username,
          'display_name', u.display_name, 'outcome', bp.outcome) ORDER BY bp.seat)
          FROM battle_participants bp JOIN users u ON u.id = bp.user_id
         WHERE bp.battle_id = b.id) AS artists
      FROM battles b
      LEFT JOIN battle_challenges bc ON bc.battle_id = b.id
      LEFT JOIN LATERAL (SELECT winner_id FROM battle_results br2 WHERE br2.battle_id = b.id ORDER BY decided_at DESC LIMIT 1) br ON true
     WHERE b.id = ANY($1::uuid[])`, [ids]);
  return new Map(rows.map((r) => [r.id, {
    id: r.id, status: r.status, theme: r.summary_text, winner_id: r.winner_id, artists: r.artists || [],
  }]));
}

// ---------------------------------------------------------------------------
// ARTWORK BYTES — immutable key, long cache (same discipline as avatars)
// ---------------------------------------------------------------------------
async function artHandler(req, res) {
  const { rows } = await pool.query(`SELECT data, mime FROM community_artwork WHERE storage_key=$1`, [String(req.params.key)]);
  if (!rows[0]) throw new HttpError(404, 'Artwork not found.');
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.set('Content-Type', rows[0].mime);
  res.send(rows[0].data);
}

// ---------------------------------------------------------------------------
// PUBLISH (§11) — fast form: image + optional title/caption/tags/tool/battle
// ---------------------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpeg|webp)$/.test(file.mimetype)),
});
router.post('/posts', upload.single('image'), ah(async (req, res) => {
  const me = req.user.id;
  rate(me, 'post');
  if (!req.file) throw new HttpError(400, 'An artwork image is required (PNG, JPEG or WebP, up to 8 MB).');
  const body = req.body || {};
  const title = String(body.title || '').trim().slice(0, 80) || null;
  const caption = String(body.caption || '').trim().slice(0, 1000) || null;
  const tool = String(body.tool || '').trim().slice(0, 40) || null;
  const tags = normalizeTags(body.tags);
  let battleId = String(body.battle_id || '').trim() || null;
  if (battleId) {
    // §54: battle association is CANONICAL — only a real battle you fought in
    const { rows } = await pool.query(
      `SELECT 1 FROM battle_participants WHERE battle_id=$1 AND user_id=$2`, [battleId, me]);
    if (!rows[0]) throw new HttpError(403, 'You can only associate artwork with your own battles.');
  }
  const key = 'art-' + me.slice(0, 8) + '-' + Date.now().toString(36) + '-' + require('crypto').randomBytes(3).toString('hex');
  const client = await pool.connect();
  let post;
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO community_artwork (storage_key, data, mime) VALUES ($1, $2, $3)`,
      [key, req.file.buffer, req.file.mimetype]);
    const { rows } = await client.query(
      `INSERT INTO community_posts (author_id, battle_id, title, caption, tags, image_storage_key)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
      [me, battleId, title, caption, tags, key]);
    post = rows[0];
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
  res.status(201).json({ id: post.id, created_at: post.created_at, tool });
}));

// ---------------------------------------------------------------------------
// FEEDS — cursor pagination (§56), block-aware, honest (visible+public only)
// ---------------------------------------------------------------------------
async function feed(res, me, extraWhere, params) {
  const limit = 20;
  const args = [me, me];
  let cursorWhere = '';
  if (params.cursor && params.cursor_id) {
    args.push(params.cursor, params.cursor_id);
    cursorWhere = ` AND (p.created_at, p.id) < ($3::timestamptz, $4::uuid)`;
  }
  // honest multi-signal orderings (§5/§7): trending = real engagement inside a
  // 7-day window (never lifetime likes); for-you = followed artists first,
  // then recency — no fake scores, no popularity monopoly.
  let order = 'p.created_at DESC, p.id DESC';
  if (params.sort === 'trending')
    order = `(p.like_count + p.comment_count) DESC, p.created_at DESC, p.id DESC`;
  if (params.sort === 'for-you')
    order = `EXISTS (SELECT 1 FROM follows f WHERE f.follower_id=$1 AND f.following_id=p.author_id) DESC, p.created_at DESC, p.id DESC`;
  const trendingWhere = params.sort === 'trending' ? `AND p.created_at > now() - interval '7 days'` : '';
  const { rows } = await pool.query(
    `SELECT ${POST_COLS}, ${POST_ME}
       FROM community_posts p JOIN users u ON u.id = p.author_id LEFT JOIN user_profiles up ON up.user_id = u.id
      WHERE p.status = 'visible' AND p.visibility = 'public'
        AND ${noBlock('$1', 'p.author_id')} ${extraWhere} ${trendingWhere} ${cursorWhere}
      ORDER BY ${order}
      LIMIT ${limit + 1}`, args);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const ctx = await battleContext([...new Set(page.filter((r) => r.battle_id).map((r) => r.battle_id))]);
  res.json({
    posts: page.map((r) => ({ ...postCard(r), battle: r.battle_id ? ctx.get(r.battle_id) || null : null })),
    has_more: hasMore,
    next_cursor: hasMore ? { cursor: page[page.length - 1].created_at, cursor_id: page[page.length - 1].id } : null,
  });
}
router.get('/posts', ah(async (req, res) => feed(res, req.user.id, '', req.query)));
router.get('/posts/battle-art', ah(async (req, res) => feed(res, req.user.id, 'AND p.battle_id IS NOT NULL', req.query)));
router.get('/posts/following', ah(async (req, res) =>
  feed(res, req.user.id, 'AND EXISTS (SELECT 1 FROM follows f WHERE f.follower_id=$1 AND f.following_id=p.author_id)', req.query)));

// ---- artwork page (§12)
router.get('/posts/:id', ah(async (req, res) => {
  const me = req.user.id;
  const { rows } = await pool.query(
    `SELECT ${POST_COLS}, ${POST_ME},
            EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=$2 AND f.following_id=p.author_id) AS following_author
       FROM community_posts p JOIN users u ON u.id = p.author_id LEFT JOIN user_profiles up ON up.user_id = u.id
      WHERE p.id = $1 AND (p.status = 'visible' OR p.author_id = $2)`, [req.params.id, me]);
  if (!rows[0]) throw new HttpError(404, 'Artwork not found.');
  const r = rows[0];
  if (await blockPair(me, r.author_id)) throw new HttpError(404, 'Artwork not found.');
  const ctx = await battleContext(r.battle_id ? [r.battle_id] : []);
  res.json({ ...postCard(r), battle: r.battle_id ? ctx.get(r.battle_id) || null : null, following_author: !!r.following_author });
}));

// ---- edit / delete OWN post (§37/§38) — soft delete keeps moderation evidence
router.patch('/posts/:id', ah(async (req, res) => {
  const me = req.user.id;
  const b = req.body || {};
  const sets = []; const args = [];
  if (b.title !== undefined) { args.push(String(b.title || '').trim().slice(0, 80) || null); sets.push(`title=$${args.length}`); }
  if (b.caption !== undefined) { args.push(String(b.caption || '').trim().slice(0, 1000) || null); sets.push(`caption=$${args.length}`); }
  if (b.tags !== undefined) { args.push(normalizeTags(b.tags)); sets.push(`tags=$${args.length}`); }
  if (!sets.length) throw new HttpError(400, 'Nothing to update.');
  args.push(req.params.id, me);
  const { rows } = await pool.query(
    `UPDATE community_posts SET ${sets.join(', ')} WHERE id=$${args.length - 1} AND author_id=$${args.length} AND status <> 'removed' RETURNING id`,
    args);
  if (!rows[0]) throw new HttpError(403, 'Only the artist can edit this artwork.');
  res.json({ ok: true });
}));
router.delete('/posts/:id', ah(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE community_posts SET status='removed' WHERE id=$1 AND author_id=$2 RETURNING id`,
    [req.params.id, req.user.id]);
  if (!rows[0]) throw new HttpError(403, 'Only the artist can delete this artwork.');
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// LIKES (§13) — one per user, toggle, server-counted, block-aware
// ---------------------------------------------------------------------------
router.post('/posts/:id/like', ah(async (req, res) => {
  const me = req.user.id;
  rate(me, 'like');
  const { rows: p } = await pool.query(`SELECT author_id, status FROM community_posts WHERE id=$1`, [req.params.id]);
  if (!p[0] || p[0].status !== 'visible') throw new HttpError(404, 'Artwork not found.');
  if (p[0].author_id !== me && await blockPair(me, p[0].author_id)) throw new HttpError(403, 'You cannot interact with this artist.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO community_post_likes (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1`,
      [req.params.id, me]);
    if (rows[0]) {
      await client.query(`UPDATE community_posts SET like_count = like_count + 1 WHERE id=$1`, [req.params.id]);
      if (p[0].author_id !== me) notifyUser(p[0].author_id, 'post_like', { post_id: req.params.id, actor: me }).catch(() => {});
    }
    const c = await client.query(`SELECT like_count FROM community_posts WHERE id=$1`, [req.params.id]);
    await client.query('COMMIT');
    res.json({ liked: true, like_count: c.rows[0].like_count });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}));
router.delete('/posts/:id/like', ah(async (req, res) => {
  const me = req.user.id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `DELETE FROM community_post_likes WHERE post_id=$1 AND user_id=$2 RETURNING 1`, [req.params.id, me]);
    if (rows[0]) await client.query(`UPDATE community_posts SET like_count = GREATEST(like_count - 1, 0) WHERE id=$1`, [req.params.id]);
    const c = await client.query(`SELECT like_count FROM community_posts WHERE id=$1`, [req.params.id]);
    await client.query('COMMIT');
    res.json({ liked: false, like_count: c.rows[0] ? c.rows[0].like_count : 0 });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}));

// ---------------------------------------------------------------------------
// SAVES (§15) — private library
// ---------------------------------------------------------------------------
router.post('/posts/:id/save', ah(async (req, res) => {
  rate(req.user.id, 'save');
  const { rows } = await pool.query(
    `INSERT INTO artwork_saves (user_id, post_id)
     SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM community_posts p WHERE p.id=$2 AND p.status='visible')
     ON CONFLICT DO NOTHING RETURNING 1`, [req.user.id, req.params.id]);
  if (!rows[0]) {
    const { rows: p } = await pool.query(`SELECT 1 FROM community_posts WHERE id=$1 AND status='visible'`, [req.params.id]);
    if (!p[0]) throw new HttpError(404, 'Artwork not found.');
  }
  res.json({ saved: true });
}));
router.delete('/posts/:id/save', ah(async (req, res) => {
  await pool.query(`DELETE FROM artwork_saves WHERE user_id=$1 AND post_id=$2`, [req.user.id, req.params.id]);
  res.json({ saved: false });
}));
router.get('/saves', ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ${POST_COLS}, ${POST_ME}
       FROM artwork_saves s JOIN community_posts p ON p.id = s.post_id JOIN users u ON u.id = p.author_id LEFT JOIN user_profiles up ON up.user_id = u.id
      WHERE s.user_id = $1 AND p.status = 'visible' AND ${noBlock('$1', 'p.author_id')}
      ORDER BY s.created_at DESC LIMIT 50`, [req.user.id, req.user.id]);
  res.json({ saves: rows.map(postCard) });
}));

// ---------------------------------------------------------------------------
// COMMENTS (§14) — comment → replies, depth-capped, block-aware, own-delete
// ---------------------------------------------------------------------------
router.get('/posts/:id/comments', ah(async (req, res) => {
  const me = req.user.id;
  const { rows } = await pool.query(
    `SELECT c.id, c.body, c.created_at, c.user_id AS author_id, u.username, u.display_name, up.avatar_storage_key,
       (SELECT count(*) FROM community_comments r WHERE r.parent_id = c.id AND r.status = 'visible') AS reply_count
       FROM community_comments c JOIN users u ON u.id = c.user_id LEFT JOIN user_profiles up ON up.user_id = u.id
      WHERE c.post_id = $2 AND c.parent_id IS NULL AND c.status = 'visible'
        AND ${noBlock('$1', 'c.user_id')}
      ORDER BY c.created_at DESC, c.id DESC LIMIT 40`, [me, req.params.id]);
  res.json({ comments: rows.map((r) => ({ ...r, author: { id: r.author_id, username: r.username, display_name: r.display_name, avatar_url: av(r) } })) });
}));
router.get('/comments/:id/replies', ah(async (req, res) => {
  const me = req.user.id;
  const { rows } = await pool.query(
    `SELECT c.id, c.body, c.created_at, c.user_id AS author_id, u.username, u.display_name, up.avatar_storage_key
       FROM community_comments c JOIN users u ON u.id = c.user_id LEFT JOIN user_profiles up ON up.user_id = u.id
      WHERE c.parent_id = $2 AND c.status = 'visible' AND ${noBlock('$1', 'c.user_id')}
      ORDER BY c.created_at ASC, c.id ASC LIMIT 40`, [me, req.params.id]);
  res.json({ replies: rows.map((r) => ({ ...r, author: { id: r.author_id, username: r.username, display_name: r.display_name, avatar_url: av(r) } })) });
}));
router.post('/posts/:id/comments', ah(async (req, res) => {
  const me = req.user.id;
  rate(me, 'comment');
  const body = String((req.body && req.body.body) || '').trim();
  if (body.length < 1 || body.length > 2000) throw new HttpError(400, 'Comments must be 1–2000 characters.');
  const parentId = String((req.body && req.body.parent_id) || '').trim() || null;
  const { rows: p } = await pool.query(`SELECT author_id, status FROM community_posts WHERE id=$1`, [req.params.id]);
  if (!p[0] || p[0].status !== 'visible') throw new HttpError(404, 'Artwork not found.');
  if (await blockPair(me, p[0].author_id)) throw new HttpError(403, 'You cannot interact with this artist.');
  if (parentId) {
    const { rows: par } = await pool.query(
      `SELECT post_id, parent_id, user_id AS author_id FROM community_comments WHERE id=$1 AND status='visible'`, [parentId]);
    if (!par[0] || par[0].post_id !== req.params.id) throw new HttpError(404, 'Comment not found.');
    if (par[0].parent_id) throw new HttpError(409, 'Replies stay one level deep — reply to the top comment.');
    if (await blockPair(me, par[0].author_id)) throw new HttpError(403, 'You cannot interact with this artist.');
  }
  const { rows } = await pool.query(
    `INSERT INTO community_comments (post_id, user_id, parent_id, body) VALUES ($1, $2, $3, $4) RETURNING id`,
    [req.params.id, me, parentId, body]);
  await pool.query(`UPDATE community_posts SET comment_count = comment_count + 1 WHERE id=$1`, [req.params.id]);
  // notify: reply target > post author; @mentions separately (§32)
  const target = parentId ? (await pool.query(`SELECT user_id FROM community_comments WHERE id=$1`, [parentId])).rows[0].user_id : p[0].author_id;
  if (target !== me) notifyUser(target, 'post_comment', { post_id: req.params.id, comment_id: rows[0].id, reply: !!parentId, actor: me }).catch(() => {});
  for (const m of [...new Set((body.match(/@([a-zA-Z0-9_]{3,24})/g) || []).map((s) => s.slice(1).toLowerCase()))].slice(0, 5)) {
    const { rows: mu } = await pool.query(`SELECT id FROM users WHERE lower(username)=$1`, [m]);
    if (mu[0] && mu[0].id !== me && mu[0].id !== target)
      notifyUser(mu[0].id, 'post_comment', { post_id: req.params.id, comment_id: rows[0].id, mention: true, actor: me }).catch(() => {});
  }
  res.status(201).json({ id: rows[0].id });
}));
router.delete('/comments/:id', ah(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE community_comments SET status='removed' WHERE id=$1 AND user_id=$2 RETURNING post_id`,
    [req.params.id, req.user.id]);
  if (!rows[0]) throw new HttpError(403, 'Only the author can delete this comment.');
  await pool.query(`UPDATE community_posts SET comment_count = GREATEST(comment_count - 1, 0) WHERE id=$1`, [rows[0].post_id]);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// FOLLOWS (§33) — block overrides follow; idempotent; notified
// ---------------------------------------------------------------------------
router.post('/follow/:userId', ah(async (req, res) => {
  const me = req.user.id; const target = String(req.params.userId);
  if (me === target) throw new HttpError(400, 'You cannot follow yourself.');
  rate(me, 'follow');
  const { rows: u } = await pool.query(`SELECT 1 FROM users WHERE id=$1`, [target]);
  if (!u[0]) throw new HttpError(404, 'Artist not found.');
  if (await blockPair(me, target)) throw new HttpError(403, 'This artist is not available for following.');
  const { rows } = await pool.query(
    `INSERT INTO follows (follower_id, following_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1`, [me, target]);
  if (rows[0]) notifyUser(target, 'new_follower', { actor: me }).catch(() => {});
  res.json({ following: true });
}));
router.delete('/follow/:userId', ah(async (req, res) => {
  await pool.query(`DELETE FROM follows WHERE follower_id=$1 AND following_id=$2`, [req.user.id, req.params.userId]);
  res.json({ following: false });
}));
router.get('/follow/state/:userId', ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT EXISTS(SELECT 1 FROM follows WHERE follower_id=$1 AND following_id=$2) AS f`, [req.user.id, req.params.userId]);
  res.json({ following: !!rows[0].f });
}));
router.get('/following/:userId', ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.display_name, up.avatar_storage_key
       FROM follows f JOIN users u ON u.id = f.following_id LEFT JOIN user_profiles up ON up.user_id = u.id
      WHERE f.follower_id = $1 AND ${noBlock('$2', 'u.id')}
      ORDER BY f.created_at DESC LIMIT 50`, [req.params.userId, req.user.id]);
  res.json({ users: rows.map((r) => ({ id: r.id, username: r.username, display_name: r.display_name, avatar_url: av(r) })) });
}));
router.get('/followers/:userId', ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.display_name, up.avatar_storage_key
       FROM follows f JOIN users u ON u.id = f.follower_id LEFT JOIN user_profiles up ON up.user_id = u.id
      WHERE f.following_id = $1 ORDER BY f.created_at DESC LIMIT 50`, [req.params.userId]);
  res.json({ users: rows.map((r) => ({ id: r.id, username: r.username, display_name: r.display_name, avatar_url: av(r) })) });
}));

// ---------------------------------------------------------------------------
// ARTISTS (§10/§19) — discovery by real Arena signals, never follower rank
// ---------------------------------------------------------------------------
router.get('/artists', ah(async (req, res) => {
  const sort = ['emerging', 'active', 'winners', 'recent'].includes(req.query.sort) ? req.query.sort : 'recent';
  const order = {
    recent: 'u.created_at DESC',
    active: 'battles_n DESC, u.created_at DESC',
    winners: 'wins_n DESC, battles_n DESC',
    emerging: 'u.created_at DESC',
  }[sort];
  // v80: discover=1 means genuine DISCOVERY — exclude artists you already
  // follow, so "Discover" is not a restatement of the Following feed.
  // Omitted (the default), the endpoint is byte-for-byte as it was before,
  // so every existing caller keeps its current behaviour.
  const discover = req.query.discover === '1' || req.query.discover === 'true';
  const discoverWhere = discover
    ? ` AND NOT EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.following_id = u.id)`
    : '';
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.display_name, up.avatar_storage_key, u.created_at,
       (SELECT count(*) FROM battle_participants bp WHERE bp.user_id = u.id) AS battles_n,
       (SELECT count(*) FROM battle_participants bp WHERE bp.user_id = u.id AND bp.outcome = 'win') AS wins_n,
       (SELECT count(*) FROM community_posts p WHERE p.author_id = u.id AND p.status = 'visible') AS posts_n
       FROM users u LEFT JOIN user_profiles up ON up.user_id = u.id
      WHERE ${noBlock('$1', 'u.id')} AND u.id <> $1 ${discoverWhere}
        AND (EXISTS (SELECT 1 FROM community_posts p WHERE p.author_id = u.id AND p.status = 'visible')
             OR EXISTS (SELECT 1 FROM battle_participants bp WHERE bp.user_id = u.id))
      ORDER BY ${order} LIMIT 24`, [req.user.id]);
  res.json({ artists: rows.map((r) => ({ ...r, avatar_url: av(r) })) });
}));
router.get('/artists/:id', ah(async (req, res) => {
  const me = req.user.id; const id = String(req.params.id);
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.display_name, up.avatar_storage_key, u.created_at,
       (SELECT count(*) FROM battle_participants bp WHERE bp.user_id = u.id) AS battles_n,
       (SELECT count(*) FROM battle_participants bp WHERE bp.user_id = u.id AND bp.outcome = 'win') AS wins_n,
       (SELECT count(*) FROM follows f WHERE f.following_id = u.id) AS followers_n,
       EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = $2 AND f.following_id = u.id) AS following,
       EXISTS(SELECT 1 FROM event_registrations er WHERE er.user_id = u.id) AS grand_arena
       FROM users u LEFT JOIN user_profiles up ON up.user_id = u.id WHERE u.id = $1`, [id, me]);
  if (!rows[0]) throw new HttpError(404, 'Artist not found.');
  const a = rows[0];
  if (me !== id && await blockPair(me, id)) throw new HttpError(404, 'Artist not found.');
  const { rows: posts } = await pool.query(
    `SELECT ${POST_COLS}, ${POST_ME}
       FROM community_posts p JOIN users u ON u.id = p.author_id LEFT JOIN user_profiles up ON up.user_id = u.id
      WHERE p.author_id = $1 AND p.status = 'visible' AND p.visibility = 'public'
      ORDER BY p.created_at DESC LIMIT 12`, [id, me]);
  res.json({
    ...a, avatar_url: av(a),
    win_rate: a.battles_n > 0 ? Math.round((a.wins_n / a.battles_n) * 100) : null,
    achievements: [
      a.wins_n >= 1 ? 'Battle Winner' : null,
      a.battles_n >= 100 ? '100 Battles Completed' : a.battles_n >= 10 ? '10 Battle Wins Candidate' : null,
      a.grand_arena ? 'Grand Arena Participant' : null,
    ].filter(Boolean),
    posts: posts.map(postCard),
  });
}));

// ---------------------------------------------------------------------------
// REPORTS (§34) — into the existing moderation table; categories are fixed
// ---------------------------------------------------------------------------
const REPORT_REASONS = ['spam', 'harassment', 'hate', 'inappropriate', 'copyright', 'cheating', 'other'];
router.post('/report', ah(async (req, res) => {
  const me = req.user.id;
  rate(me, 'report');
  const b = req.body || {};
  const type = ['post', 'comment', 'user'].includes(b.target_type) ? b.target_type : null;
  const reason = REPORT_REASONS.includes(b.reason) ? b.reason : null;
  const targetId = String(b.target_id || '');
  if (!type || !reason || !targetId) throw new HttpError(400, 'A target and a reason are required.');
  const exists = type === 'post'
    ? await pool.query(`SELECT 1 FROM community_posts WHERE id=$1`, [targetId])
    : type === 'comment'
      ? await pool.query(`SELECT 1 FROM community_comments WHERE id=$1`, [targetId])
      : await pool.query(`SELECT 1 FROM users WHERE id=$1`, [targetId]);
  if (!exists.rows[0]) throw new HttpError(404, 'Nothing to report.');
  await pool.query(
    `INSERT INTO reports (reporter_id, target_type, target_id, reason, details) VALUES ($1, $2, $3, $4, $5)`,
    [me, type, targetId, reason, String(b.details || '').slice(0, 1000) || null]);
  res.json({ ok: true }); // no content auto-removed (§34)
}));

// ---- phase 3: categorized instant search -------------------------------
// Artists / artwork / battles / tags / live — one query box, honest sources
// only. Block pairs never appear in each other's results; private or
// moderated artwork never appears at all.
const youtube = require('./youtube');
const twitch = require('./twitch');
router.get('/search', ah(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const out = { artists: [], posts: [], battles: [], tags: [], live: [] };
  if (q.length < 2) return res.json(out);
  const me = req.user.id;
  // literal-match search: % _ \ are escaped, escape char passed as a bind
  // parameter so quoting can never break it.
  const like = '%' + q.replace(/[%_\\]/g, (m) => '\\' + m) + '%';
  const ESC = '\\';
  const [artists, posts, battles, tags] = await Promise.all([
    pool.query(
      `SELECT u.id, u.username, up.avatar_storage_key, up.updated_at
         FROM users u LEFT JOIN user_profiles up ON up.user_id = u.id
        WHERE (u.username ILIKE $2 ESCAPE $3 OR u.display_name ILIKE $2 ESCAPE $3)
          AND u.id <> $1 AND ${noBlock('$1', 'u.id')}
        ORDER BY u.username LIMIT 8`, [me, like, ESC]),
    pool.query(
      `SELECT ${POST_COLS}, ${POST_ME}
         FROM community_posts p JOIN users u ON u.id = p.author_id LEFT JOIN user_profiles up ON up.user_id = u.id
        WHERE p.status = 'visible' AND p.visibility = 'public'
          AND (p.title ILIKE $3 ESCAPE $4 OR p.caption ILIKE $3 ESCAPE $4
               OR EXISTS (SELECT 1 FROM unnest(p.tags) t WHERE t ILIKE $3 ESCAPE $4))
          AND ${noBlock('$1', 'p.author_id')}
        ORDER BY p.created_at DESC LIMIT 8`, [me, me, like, ESC]),
    pool.query(
      `SELECT b.id, bc.summary_text AS theme, r.code AS room_code,
              (SELECT winner_id FROM battle_results br WHERE br.battle_id = b.id ORDER BY br.decided_at DESC LIMIT 1) AS winner_id
         FROM battles b JOIN battle_rooms r ON r.id = b.room_id
         LEFT JOIN battle_challenges bc ON bc.battle_id = b.id
        WHERE b.status IN ('result', 'complete') AND COALESCE(bc.summary_text, r.name) ILIKE $1 ESCAPE $2
        ORDER BY b.created_at DESC LIMIT 8`, [like, ESC]),
    pool.query(
      `SELECT DISTINCT t FROM community_posts p, unnest(p.tags) t
        WHERE t ILIKE $1 ESCAPE $2 AND p.status = 'visible' ORDER BY t LIMIT 10`, [like, ESC]),
  ]);
  out.artists = artists.rows.map((r) => ({ id: r.id, username: r.username, avatar_url: av(r) }));
  out.posts = posts.rows.map(postCard);
  out.battles = battles.rows.map((r) => ({ id: r.id, theme: r.theme, room_code: r.room_code, winner_id: r.winner_id }));
  out.tags = tags.rows.map((r) => r.t);
  const [y, t] = await Promise.all([youtube.liveData(), twitch.liveData()]);
  const lq = q.toLowerCase();
  out.live = [...y.live, ...t.live, ...y.upcoming, ...t.upcoming]
    .filter((s) => ((s.title || '') + ' ' + (s.artist || '')).toLowerCase().includes(lq)).slice(0, 8);
  res.json(out);
}));

// ---- phase 4: profile Community layer (Arena links) --------------------
// Extends the existing identity modal: artworks, battle history with the
// canonical theme + outcome + linked artwork, Arena stats, Grand Arena
// record, live status — all from authoritative tables, nothing invented.
router.get('/profile/:id', ah(async (req, res) => {
  const id = String(req.params.id || ''), me = req.user.id;
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, 'Invalid artist id.');
  const { rows: [u] } = await pool.query(
    `SELECT u.id, u.username, u.display_name, up.avatar_storage_key, up.updated_at
       FROM users u LEFT JOIN user_profiles up ON up.user_id = u.id WHERE u.id = $1`, [id]);
  if (!u) throw new HttpError(404, 'Artist not found.');
  const [posts, battles, follow] = await Promise.all([
    pool.query(
      `SELECT ${POST_COLS},
              EXISTS(SELECT 1 FROM community_post_likes l WHERE l.post_id = p.id AND l.user_id = $1) AS liked_by_me,
              EXISTS(SELECT 1 FROM artwork_saves s WHERE s.post_id = p.id AND s.user_id = $1) AS saved_by_me
         FROM community_posts p JOIN users u ON u.id = p.author_id LEFT JOIN user_profiles up ON up.user_id = u.id
        WHERE p.author_id = $2 AND p.status = 'visible' AND p.visibility = 'public'
          AND ${noBlock('$1', 'p.author_id')}
        ORDER BY p.created_at DESC LIMIT 12`, [me, id]),
    pool.query(
      `SELECT b.id AS battle_id, b.competition_type, bc.summary_text AS theme, bp.outcome,
              (SELECT winner_id FROM battle_results br WHERE br.battle_id = b.id ORDER BY br.decided_at DESC LIMIT 1) AS winner_id,
              (SELECT p2.id FROM community_posts p2
                WHERE p2.battle_id = b.id AND p2.author_id = $1 AND p2.status = 'visible' LIMIT 1) AS post_id
         FROM battle_participants bp JOIN battles b ON b.id = bp.battle_id
         LEFT JOIN battle_challenges bc ON bc.battle_id = b.id
        WHERE bp.user_id = $1 AND b.status IN ('result', 'complete')
        ORDER BY COALESCE(b.official_end_time, b.created_at) DESC LIMIT 10`, [id]),
    pool.query(`SELECT 1 AS f FROM follows WHERE follower_id = $1 AND following_id = $2`, [me, id]),
  ]);
  const wins = battles.rows.filter((r) => r.outcome === 'win').length;
  const ga = battles.rows.filter((r) => r.competition_type === 'grand_arena');
  const gaWins = ga.filter((r) => r.outcome === 'win').length;
  let liveNow = null;
  try {
    const [y, t] = await Promise.all([youtube.liveData(), twitch.liveData()]);
    liveNow = [...y.live, ...t.live].find((s) => s.artist === (u.display_name || u.username)) || null;
  } catch (_) { /* live status is additive; never break the profile */ }
  res.json({
    user: { id: u.id, username: u.username, display_name: u.display_name, avatar_url: av(u) },
    following: !!follow.rows[0],
    posts: posts.rows.map(postCard),
    battles: battles.rows.map((r) => ({
      battle_id: r.battle_id, theme: r.theme, outcome: r.outcome,
      winner_id: r.winner_id, post_id: r.post_id,
      grand_arena: r.competition_type === 'grand_arena',
    })),
    stats: {
      battles: battles.rows.length, wins,
      winrate: battles.rows.length ? Math.round((wins / battles.rows.length) * 100) : 0,
      grand_arena_battles: ga.length, grand_arena_wins: gaWins,
    },
    live: liveNow ? { title: liveNow.title, watch_url: liveNow.watchUrl, platform: liveNow.platform } : null,
  });
}));

// ---- phase 7: safety management (block/mute lists + toggles) -------------
const personRow = (r) => ({ id: r.id, username: r.username, display_name: r.display_name, avatar_url: av(r) });
router.get('/safety', ah(async (req, res) => {
  const me = req.user.id;
  const [bl, mu] = await Promise.all([
    pool.query(
      `SELECT u.id, u.username, u.display_name, up.avatar_storage_key, up.updated_at
         FROM blocks b JOIN users u ON u.id = b.blocked_id LEFT JOIN user_profiles up ON up.user_id = u.id
        WHERE b.blocker_id = $1 ORDER BY b.created_at DESC`, [me]),
    pool.query(
      `SELECT u.id, u.username, u.display_name, up.avatar_storage_key, up.updated_at
         FROM mutes m JOIN users u ON u.id = m.muted_id LEFT JOIN user_profiles up ON up.user_id = u.id
        WHERE m.muter_id = $1 ORDER BY m.created_at DESC`, [me]),
  ]);
  res.json({ blocked: bl.rows.map(personRow), muted: mu.rows.map(personRow) });
}));
router.post('/block/:id', ah(async (req, res) => {
  const me = req.user.id, id = String(req.params.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, 'Invalid user id.');
  if (id === me) throw new HttpError(400, 'You cannot block yourself.');
  await pool.query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [me, id]);
  // block overrides follow — both directions die server-side
  await pool.query(`DELETE FROM follows WHERE (follower_id=$1 AND following_id=$2) OR (follower_id=$2 AND following_id=$1)`, [me, id]);
  res.json({ ok: true });
}));
router.delete('/block/:id', ah(async (req, res) => {
  await pool.query(`DELETE FROM blocks WHERE blocker_id=$1 AND blocked_id=$2`, [req.user.id, String(req.params.id)]);
  res.json({ ok: true });
}));
router.post('/mute/:id', ah(async (req, res) => {
  const me = req.user.id, id = String(req.params.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, 'Invalid user id.');
  if (id === me) throw new HttpError(400, 'You cannot mute yourself.');
  await pool.query(`INSERT INTO mutes (muter_id, muted_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [me, id]);
  res.json({ ok: true });
}));
router.delete('/mute/:id', ah(async (req, res) => {
  await pool.query(`DELETE FROM mutes WHERE muter_id=$1 AND muted_id=$2`, [req.user.id, String(req.params.id)]);
  res.json({ ok: true });
}));

// ---- phase 7: moderation queue (roles enforced server-side) --------------
async function requireMod(id) {
  const { rows } = await pool.query(
    `SELECT 1 FROM user_roles WHERE user_id = $1 AND role IN ('admin','moderator')`, [id]);
  if (!rows[0]) throw new HttpError(403, 'Moderators only.');
}
router.get('/moderation/role', ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT 1 FROM user_roles WHERE user_id = $1 AND role IN ('admin','moderator')`, [req.user.id]);
  res.json({ moderator: !!rows[0] });
}));
router.get('/moderation/queue', ah(async (req, res) => {
  await requireMod(req.user.id);
  const { rows } = await pool.query(
    `SELECT r.id, r.target_type, r.target_id, r.reason, r.details, r.created_at,
            rep.username AS reporter,
            p.title AS post_title, p.status AS post_status, p.caption AS post_caption,
            c.body AS comment_body, c.status AS comment_status,
            a.username AS author_username
       FROM reports r
       JOIN users rep ON rep.id = r.reporter_id
       LEFT JOIN community_posts p ON r.target_type = 'post' AND p.id = r.target_id
       LEFT JOIN community_comments c ON r.target_type = 'comment' AND c.id = r.target_id
       LEFT JOIN users a ON a.id = COALESCE(p.author_id, c.user_id)
      ORDER BY r.created_at DESC LIMIT 50`, []);
  res.json({ reports: rows });
}));
router.post('/moderation/action', ah(async (req, res) => {
  await requireMod(req.user.id);
  const { target_type, target_id, action } = req.body || {};
  const status = action === 'hide' ? 'hidden' : action === 'remove' ? 'removed' : action === 'restore' ? 'visible' : null;
  if (!status || !/^[0-9a-f-]{36}$/i.test(String(target_id))) throw new HttpError(400, 'Unknown action or target.');
  const table = target_type === 'post' ? 'community_posts' : target_type === 'comment' ? 'community_comments' : null;
  if (!table) throw new HttpError(400, 'Unknown target type.');
  // statuses are retained, never destroyed — evidence stays in the queue row
  const { rowCount } = await pool.query(`UPDATE ${table} SET status = $2 WHERE id = $1`, [target_id, status]);
  if (!rowCount) throw new HttpError(404, 'Target not found.');
  res.json({ ok: true, status });
}));

// recent decided battles of the viewer — feeds the composer's optional
// battle link (only battles the publisher genuinely fought in).
router.get('/my-battles', ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.id, bc.summary_text AS theme
       FROM battle_participants bp JOIN battles b ON b.id = bp.battle_id
       LEFT JOIN battle_challenges bc ON bc.battle_id = b.id
      WHERE bp.user_id = $1 AND b.status IN ('result', 'complete')
      ORDER BY COALESCE(b.official_end_time, b.created_at) DESC LIMIT 5`, [req.user.id]);
  res.json({ battles: rows });
}));

module.exports = { router, artHandler };
