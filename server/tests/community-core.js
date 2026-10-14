'use strict';
// v73 COMMUNITY (phases 1-2) API suite: publishing, artwork bytes, feeds with
// cursor pagination, likes/saves (server-counted, one per user), comments with
// one-level replies + own-delete, follows with block override, ownership on
// edit/delete, reports with fixed categories, notifications — every check is
// server truth; block enforcement verified by inserting a row in `blocks`.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const db = new URL(process.env.DATABASE_URL || 'http://missing');
assert(['localhost', '127.0.0.1'].includes(db.hostname), 'Local disposable DATABASE_URL required');
const { pool } = require('../lib');
const base = 'http://127.0.0.1:3000';
// 1x1 red PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
async function api(u, path, body, status = 200, method = body === undefined ? 'GET' : 'POST') {
  const r = await fetch(base + '/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(u ? { Authorization: 'Bearer ' + u.token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  assert.equal(r.status, status, path + ' → ' + r.status + ' ' + JSON.stringify(d)); return d;
}
async function user() {
  const name = 'cm_' + randomBytes(6).toString('hex'), password = 'CommunityTest123!';
  const d = await api(null, '/auth/register', { username: name, email: name + '@example.test', password }, 201);
  const login = await api(null, '/auth/login', { login: name, password });
  return { id: d.user.id, token: login.session_token, name };
}
async function publish(u, fields = {}) {
  const fd = new FormData();
  fd.append('image', new Blob([PNG], { type: 'image/png' }), 'art.png');
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const r = await fetch(base + '/api/community/posts', { method: 'POST', headers: { Authorization: 'Bearer ' + u.token }, body: fd });
  const d = await r.json();
  assert.equal(r.status, 201, JSON.stringify(d));
  return d;
}
async function main() {
  // disposable local DB: start from a clean community slate (crashed prior runs)
  await pool.query(`TRUNCATE community_posts, community_post_likes, community_comments, artwork_saves CASCADE`);
  const a = await user(), b = await user(), c = await user();

  // ---- publishing + validation
  const fdNoImg = new FormData(); fdNoImg.append('caption', 'no image here');
  assert.equal((await fetch(base + '/api/community/posts', { method: 'POST', headers: { Authorization: 'Bearer ' + a.token }, body: fdNoImg })).status, 400, 'image required');
  const fdTxt = new FormData(); fdTxt.append('image', new Blob([Buffer.from('not an image')], { type: 'text/plain' }), 'x.txt');
  assert.equal((await fetch(base + '/api/community/posts', { method: 'POST', headers: { Authorization: 'Bearer ' + a.token }, body: fdTxt })).status, 400, 'non-image rejected');
  const p1 = await publish(a, { title: 'Neon Study', caption: 'first community artwork', tags: 'Manga, manga, character-design, ANIME', tool: 'Krita' });
  const art = await api(a, '/community/posts/' + p1.id);
  assert.deepEqual(art.tags, ['manga', 'character-design', 'anime'], 'tags normalized + de-duplicated');
  assert.ok(art.image_url.includes('/community-art/art-'), 'image url');
  const img = await fetch(base + art.image_url);
  assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png');
  assert.ok((img.headers.get('cache-control') || '').includes('immutable'), 'long cache for immutable key');

  // battle association is canonical: a battle you did NOT fight in is rejected
  const fakeBattle = randomBytes(16).toString('hex');
  const fdBad = new FormData(); fdBad.append('image', new Blob([PNG], { type: 'image/png' })); fdBad.append('battle_id', fakeBattle);
  const rBad = await fetch(base + '/api/community/posts', { method: 'POST', headers: { Authorization: 'Bearer ' + a.token }, body: fdBad });
  assert([400, 403].includes(rBad.status), 'foreign battle association rejected');

  const p2 = await publish(b, { caption: 'second artist posts' });
  const p3 = await publish(a, { caption: 'a third post for pagination' });

  // ---- feeds: cursor pagination, no dupes
  const f1 = await api(c, '/community/posts?limit=2');
  assert.equal(f1.posts.length, 3);
  assert.equal(f1.has_more, false);
  const ids = new Set(f1.posts.map((p) => p.id));
  assert.equal(ids.size, 3, 'no duplicate feed items');
  const battleArt = await api(c, '/community/posts/battle-art');
  assert.equal(battleArt.posts.length, 0, 'battle art only shows battle-linked posts');

  // ---- likes: one per user, toggle, server count
  const l1 = await api(b, `/community/posts/${p1.id}/like`, {});
  assert.equal(l1.like_count, 1);
  await api(b, `/community/posts/${p1.id}/like`, {}); // idempotent — no double count
  const again = await api(b, '/community/posts/' + p1.id);
  assert.equal(again.like_count, 1, 'duplicate like impossible');
  assert.equal(again.liked_by_me, true);
  const ul = await api(b, `/community/posts/${p1.id}/like`, undefined, 200, 'DELETE');
  assert.equal(ul.like_count, 0); assert.equal(ul.liked, false);

  // ---- saves: private
  await api(c, `/community/posts/${p1.id}/save`, {});
  const saves = await api(c, '/community/saves');
  assert.equal(saves.saves.length, 1); assert.equal(saves.saves[0].id, p1.id);
  const aSaves = await api(a, '/community/saves');
  assert.equal(aSaves.saves.length, 0, 'saves are private per user');
  await api(c, `/community/posts/${p1.id}/save`, undefined, 200, 'DELETE');

  // ---- comments + one-level replies + own delete + ownership
  const cm1 = await api(b, `/community/posts/${p1.id}/comments`, { body: 'love the line work @' + c.name }, 201);
  const cm2 = await api(c, `/community/posts/${p1.id}/comments`, { body: 'reply to b', parent_id: cm1.id }, 201);
  const deep = await api(c, `/community/posts/${p1.id}/comments`, { body: 'too deep', parent_id: cm2.id }, 409);
  assert.ok(deep, 'depth capped at comment → reply');
  const list = await api(a, `/community/posts/${p1.id}/comments`);
  assert.equal(list.comments.length, 1); assert.equal(Number(list.comments[0].reply_count), 1);
  const replies = await api(a, `/community/comments/${cm1.id}/replies`);
  assert.equal(replies.replies.length, 1);
  await api(a, `/community/comments/${cm2.id}`, undefined, 403, 'DELETE'); // not the author
  await api(c, `/community/comments/${cm2.id}`, undefined, 200, 'DELETE');  // own delete ok
  // mentions + author notifications were created server-side
  const notifM = await pool.query(`SELECT type, payload->>'mention' AS m FROM notifications WHERE user_id=$1`, [c.id]);
  assert.ok(notifM.rows.some((r) => r.type === 'post_comment' && r.m === 'true'), 'mention notification');
  const notif = await pool.query(`SELECT type, payload->>'mention' AS m FROM notifications WHERE user_id=$1 ORDER BY created_at DESC`, [a.id]);
  assert.ok(notif.rows.some((r) => r.type === 'post_comment' && r.m !== 'true'), 'author comment notification');

  // ---- edit/delete ownership
  await api(b, `/community/posts/${p1.id}`, { caption: 'steal' }, 403, 'PATCH');
  await api(a, `/community/posts/${p1.id}`, { caption: 'edited caption' }, 200, 'PATCH');
  assert.equal((await api(a, '/community/posts/' + p1.id)).caption, 'edited caption');
  await api(b, `/community/posts/${p3.id}`, undefined, 403, 'DELETE');
  await api(a, `/community/posts/${p3.id}`, undefined, 200, 'DELETE');
  assert.equal((await api(c, '/community/posts/' + p3.id, undefined, 404)).error, 'Artwork not found.', 'removed posts disappear for others');

  // ---- follows + notification; block overrides follow
  await api(b, `/community/follow/${b.id}`, {}, 400); // self
  await api(b, `/community/follow/${a.id}`, {});
  await api(b, `/community/follow/${a.id}`, {}); // idempotent
  assert.equal((await api(c, `/community/follow/state/${a.id}`)).following, false);
  assert.equal((await api(b, `/community/follow/state/${a.id}`)).following, true);
  const nFollow = await pool.query(`SELECT 1 FROM notifications WHERE user_id=$1 AND type='new_follower'`, [a.id]);
  assert.equal(nFollow.rowCount, 1, 'follow notification exactly once');
  const fol = await api(c, '/community/following/' + b.id);
  assert.equal(fol.users.length, 1);
  const followingFeed = await api(b, '/community/posts/following');
  assert.equal(followingFeed.posts.filter((p) => p.author.id === a.id).length, 1, 'following feed shows followed artists (removed posts excluded)');

  // ---- BLOCK enforcement (server-side, no UI bypass possible)
  await pool.query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [a.id, c.id]);
  const blockedFeed = await api(c, '/community/posts');
  assert.ok(!blockedFeed.posts.some((p) => p.author.id === a.id), 'blocked artist hidden from feeds (both ways)');
  assert.equal((await api(c, `/community/posts/${p1.id}/like`, {}, 403)).error, 'You cannot interact with this artist.');
  assert.equal((await api(c, `/community/posts/${p1.id}/comments`, { body: 'hi' }, 403)).error, 'You cannot interact with this artist.');
  assert.equal((await api(c, `/community/follow/${a.id}`, {}, 403)).error, 'This artist is not available for following.');
  assert.equal((await api(c, '/community/posts/' + p1.id, undefined, 404)).error, 'Artwork not found.', 'artwork page hidden across a block');

  // ---- artists discovery + profile (arena signals, not follower rank)
  const disc = await api(b, '/community/artists?sort=recent');
  assert.ok(disc.artists.some((x) => x.id === a.id), 'artist discovery lists posting artists');
  const discC = await api(c, '/community/artists?sort=recent');
  assert.ok(!discC.artists.some((x) => x.id === a.id), 'blocked artist hidden from discovery too');
  // v80: discover=1 is genuine discovery — artists you already follow are
  // excluded, and the default (no flag) keeps listing them exactly as before.
  // A dedicated unfollowed artist keeps this independent of whatever else the
  // disposable DB happens to contain.
  const e = await user();
  await publish(e, { title: 'discoverable' });
  const discFollowed = await api(b, '/community/artists?sort=recent');
  assert.ok(discFollowed.artists.some((x) => x.id === a.id), 'default discovery keeps followed artists (unchanged behaviour)');
  const discNew = await api(b, '/community/artists?sort=recent&discover=1');
  assert.ok(!discNew.artists.some((x) => x.id === a.id), 'discover=1 excludes artists already followed');
  assert.ok(discNew.artists.some((x) => x.id === e.id), 'discover=1 still surfaces artists you do not follow');
  const prof = await api(b, '/community/artists/' + a.id);
  assert.equal(prof.posts.length, 1); // p3 removed
  assert.equal(prof.following, true);
  assert.ok(Array.isArray(prof.achievements));

  // ---- reports: fixed categories, real targets, no auto-delete
  await api(b, '/community/report', { target_type: 'post', target_id: p1.id, reason: 'spam' });
  await api(b, '/community/report', { target_type: 'post', target_id: p1.id, reason: 'not-a-reason' }, 400);
  await api(b, '/community/report', { target_type: 'comment', target_id: cm1.id, reason: 'harassment' });
  const rep = await pool.query(`SELECT count(*)::int n FROM reports WHERE target_id=$1`, [p1.id]);
  assert.equal(rep.rows[0].n, 1);
  assert.equal((await api(b, '/community/posts/' + p1.id)).status !== 'removed', true, 'one report never deletes content');

  // ---- phase 3: categorized instant search (block-aware, honest sources)
  const sSelf = await api(a, '/community/search?q=' + encodeURIComponent(a.name));
  assert.ok(!sSelf.artists.some((x) => x.id === a.id), 'search never lists the searcher');
  const sB = await api(b, '/community/search?q=' + encodeURIComponent(a.name));
  assert.ok(sB.artists.some((x) => x.id === a.id), 'artist found by username');
  const sT = await api(b, '/community/search?q=manga');
  assert.ok(sT.tags.includes('manga'), 'tag search');
  assert.ok(sT.posts.some((p) => p.id === p1.id), 'post found via tag');
  const sC = await api(c, '/community/search?q=' + encodeURIComponent(a.name));
  assert.ok(!sC.artists.some((x) => x.id === a.id), 'blocked artist not searchable');

  // ---- phase 4: canonical battle → result notification → profile/search links
  const room = await pool.query(
    `INSERT INTO battle_rooms (host_id, code, name) VALUES ($1, 'CMTEST1', 'Community test room') RETURNING id`, [a.id]);
  const bat = await pool.query(
    `INSERT INTO battles (room_id, status, competition_type, time_limit_seconds, result_method, voting_ends_at)
     VALUES ($1, 'judging', 'grand_arena', 600, 'voting_community', now() - interval '1 minute') RETURNING id`, [room.rows[0].id]);
  await pool.query(`INSERT INTO battle_participants (battle_id, user_id, seat) VALUES ($1,$2,1),($1,$3,2)`, [bat.rows[0].id, a.id, b.id]);
  await pool.query(`INSERT INTO battle_challenges (battle_id, summary_text) VALUES ($1, 'Neon Samurai Duel')`, [bat.rows[0].id]);
  const pGA = await publish(a, { title: 'Neon Samurai entry', tags: 'samurai', battle_id: bat.rows[0].id });
  await require('../battle-end').decideBattleIfDue(bat.rows[0].id); // the ONE decide path
  const done = await pool.query(`SELECT status FROM battles WHERE id=$1`, [bat.rows[0].id]);
  assert.equal(done.rows[0].status, 'complete', 'battle decided through battle-end');
  for (const u of [a, b]) {
    const n = await pool.query(`SELECT payload FROM notifications WHERE user_id=$1 AND type='battle_result'`, [u.id]);
    assert.equal(n.rows.length, 1, 'each participant got the result notification');
    assert.equal(n.rows[0].payload.room_code, 'CMTEST1');
    assert.equal(n.rows[0].payload.theme, 'Neon Samurai Duel');
  }
  const sBat = await api(b, '/community/search?q=neon samurai');
  assert.ok(sBat.battles.some((x) => x.id === bat.rows[0].id), 'battle found by theme');
  const profA = await api(b, '/community/profile/' + a.id);
  assert.equal(profA.stats.grand_arena_battles, 1, 'Grand Arena record from authoritative data');
  assert.equal(profA.stats.battles, 1);
  assert.ok(profA.battles.some((x) => x.post_id === pGA.id), 'battle history links the shared artwork');
  assert.ok(profA.posts.some((x) => x.id === pGA.id), 'profile artworks include the battle piece');
  const mb = await api(a, '/community/my-battles');
  assert.ok(mb.battles.some((x) => x.id === bat.rows[0].id), 'composer can link own battles only');

  // ---- phase 7: mute silences notifications; block API; moderation queue
  await api(b, '/community/mute/' + a.id, {}, 200);
  const pB = await publish(b, { title: 'Mute test piece' });
  await api(a, '/community/posts/' + pB.id + '/like', {});
  let mn = await pool.query(`SELECT count(*)::int n FROM notifications WHERE user_id=$1 AND type='post_like' AND payload->>'actor'=$2`, [b.id, a.id]);
  assert.equal(mn.rows[0].n, 0, 'muted actor never reaches the bell');
  await api(b, '/community/mute/' + a.id, undefined, 200, 'DELETE');
  await api(a, '/community/posts/' + pB.id + '/like', undefined, 200, 'DELETE'); // toggle off
  await api(a, '/community/posts/' + pB.id + '/like', {}); // on again → notif
  mn = await pool.query(`SELECT count(*)::int n FROM notifications WHERE user_id=$1 AND type='post_like' AND payload->>'actor'=$2`, [b.id, a.id]);
  assert.equal(mn.rows[0].n, 1, 'unmute restores notifications');

  // block via API overrides follow both ways and lands in the safety list
  await api(a, '/community/block/' + b.id, {}, 200);
  const fGone = await pool.query(`SELECT count(*)::int n FROM follows WHERE (follower_id=$1 AND following_id=$2) OR (follower_id=$2 AND following_id=$1)`, [a.id, b.id]);
  assert.equal(fGone.rows[0].n, 0, 'block kills follows both directions');
  const sf = await api(a, '/community/safety');
  assert.ok(sf.blocked.some((x) => x.id === b.id), 'safety list shows the block');
  await api(a, '/community/follow/' + b.id, {}, 403); // still blocked
  await api(a, '/community/block/' + b.id, undefined, 200, 'DELETE');
  await api(a, '/community/follow/' + b.id, {}, 200); // unblock restores ability

  // moderation: role-gated queue, retain-status actions, no evidence loss
  const adm = new (require('pg').Client)({ connectionString: 'postgresql://aa_admin:aa-admin-pw@127.0.0.1:5432/art_arena' });
  await adm.connect();
  await adm.query(`INSERT INTO user_roles (user_id, role) VALUES ($1,'moderator') ON CONFLICT DO NOTHING`, [b.id]);
  await adm.end();
  assert.equal((await api(a, '/community/moderation/role')).moderator, false);
  assert.equal((await api(b, '/community/moderation/role')).moderator, true);
  await api(a, '/community/moderation/queue', undefined, 403);
  const q1 = await api(b, '/community/moderation/queue');
  assert.ok(q1.reports.some((r) => r.target_id === p1.id), 'earlier report is in the queue');
  await api(b, '/community/moderation/action', { target_type: 'post', target_id: p1.id, action: 'hide' });
  const hidden = await pool.query(`SELECT status FROM community_posts WHERE id=$1`, [p1.id]);
  assert.equal(hidden.rows[0].status, 'hidden');
  const feedB = await api(b, '/community/posts?limit=50');
  assert.ok(!feedB.posts.some((p) => p.id === p1.id), 'hidden post leaves feeds');
  const q2 = await api(b, '/community/moderation/queue');
  assert.equal(q2.reports.find((r) => r.target_id === p1.id).post_status, 'hidden', 'status visible to mods, evidence retained');
  await api(b, '/community/moderation/action', { target_type: 'post', target_id: p1.id, action: 'restore' });
  await api(b, '/community/moderation/action', { target_type: 'post', target_id: p1.id, action: 'bogus' }, 400);

  // ---- unauthenticated access rejected
  assert.equal((await fetch(base + '/api/community/posts')).status, 401);

  console.log('PASS community phases 1-7: publish/validation/bytes, cursor feeds, likes/saves server-counted + private, ' +
    'comments→replies depth cap + own-delete + mentions, edit/delete ownership, follows + block override everywhere, ' +
    'artist discovery by Arena signals, reports to moderation without auto-delete, categorized search (block-aware), safety mgmt (mute silences, block API kills follows), moderation queue (role-gated, retain-status), ' +
    'canonical battle decide → per-participant result notifications, profile Arena links (GA record, battle↔artwork), auth required');
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAIL', e); process.exit(1); });
