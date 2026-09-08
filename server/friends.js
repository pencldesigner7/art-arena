'use strict';
/**
 * ============================================================================
 *  ART ARENA™ — v61 · FRIENDS PAGE BACKEND
 * ============================================================================
 *  Extends the v51 friends system (friend_requests / friendships live in
 *  server.js) with what the dedicated Friends page needs:
 *
 *    GET  /api/friends/list                 friends + avatar + presence + room
 *    POST /api/friends/:userId/invite       invite a friend to one of MY rooms
 *                                           (notification type room_invitation
 *                                           — the enum value has existed since
 *                                           the original schema; it just was
 *                                           never emitted)
 *    GET  /api/teams/draft                  my current 3v3 team draft
 *    PUT  /api/teams/draft                  set/replace the draft (≤ 2 mates)
 *    POST /api/teams/draft/invite           notify the drafted friends
 *    POST /api/teams/draft/open-room        create a 3v3 room (existing rooms
 *                                           API, battle_mode='3v3', 6 seats)
 *                                           and invite the whole draft
 *
 *  The 3v3 BATTLE ENGINE itself does not exist yet (rooms.js runs team
 *  formats as a 1v1 between the first two seated artists and says so). This
 *  module only builds the team-selection / invitation foundation on top of
 *  the real rooms + notifications architecture; nothing here fakes a battle.
 * ============================================================================
 */
const express = require('express');
const { pool, HttpError, ah, requireAuth, avatarUrlOf } = require('./lib');
const rt = require('./realtime');
const { notifyUser } = require('./notify');

const router = express.Router();
router.use(requireAuth);

const TEAM_SIZE = 3; // 3v3: me + 2 friends per side

async function areFriends(a, b, q) {
  const { rows } = await (q || pool).query(
    `SELECT 1 FROM friendships
      WHERE user_a = LEAST($1::uuid,$2::uuid) AND user_b = GREATEST($1::uuid,$2::uuid)`, [a, b]);
  return !!rows[0];
}

/** Friends with presence (open WebSocket = online) and current room. */
async function friendsOf(userId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.display_name, f.created_at AS since,
            p.avatar_storage_key, p.updated_at AS profile_updated_at,
            (SELECT r.code FROM battle_rooms r
              WHERE r.deleted_at IS NULL AND r.status IN ('lobby','starting','in_battle')
                AND r.id IN (SELECT room_id FROM room_participants
                              WHERE user_id = u.id AND state IN ('waiting','ready'))
              ORDER BY r.created_at DESC LIMIT 1) AS room_code
       FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.user_a = $1 THEN f.user_b ELSE f.user_a END
       LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE $1 IN (f.user_a, f.user_b) AND u.account_status = 'active'
      ORDER BY lower(COALESCE(u.display_name, u.username))`, [userId]);
  return rows.map((r) => ({
    id: r.id, username: r.username, display_name: r.display_name, since: r.since,
    avatar_url: avatarUrlOf(r.avatar_storage_key, r.profile_updated_at),
    online: rt.isUserOnline(r.id),
    room_code: r.room_code || null,
  }));
}

router.get('/friends/list', ah(async (req, res) => {
  const friends = await friendsOf(req.user.id);
  // my invitable rooms: rooms I host that are in lobby with a free seat
  const { rows: rooms } = await pool.query(
    `SELECT r.code, r.name, r.battle_mode, r.max_players, r.visibility,
            (SELECT count(*) FROM room_participants rp
              WHERE rp.room_id = r.id AND rp.state IN ('waiting','ready'))::int AS player_count
       FROM battle_rooms r
      WHERE r.deleted_at IS NULL AND r.host_id = $1 AND r.status = 'lobby'
      ORDER BY r.created_at DESC LIMIT 10`, [req.user.id]);
  res.json({
    friends,
    online_count: friends.filter((f) => f.online).length,
    my_rooms: rooms.filter((r) => r.player_count < r.max_players)
      .map((r) => ({ code: r.code, name: r.name, battle_mode: r.battle_mode || '1v1', max_players: r.max_players, player_count: r.player_count, visibility: r.visibility })),
  });
}));

/** Invite a friend into one of MY rooms (host only, lobby, free seat). */
async function inviteToRoom(fromUser, toUserId, code, extra) {
  const { rows } = await pool.query(
    `SELECT r.id, r.code, r.name, r.host_id, r.status, r.max_players, r.battle_mode,
            (SELECT count(*) FROM room_participants rp
              WHERE rp.room_id = r.id AND rp.state IN ('waiting','ready'))::int AS player_count,
            EXISTS (SELECT 1 FROM room_participants rp
                     WHERE rp.room_id = r.id AND rp.user_id = $2 AND rp.state IN ('waiting','ready')) AS already_in
       FROM battle_rooms r WHERE r.code = $1 AND r.deleted_at IS NULL`, [code, toUserId]);
  const room = rows[0];
  if (!room) throw new HttpError(404, 'Room not found.');
  if (room.host_id !== fromUser.id) throw new HttpError(403, 'Only the host can invite friends to a room.');
  if (room.status !== 'lobby') throw new HttpError(409, 'That room is not accepting players right now.');
  if (room.already_in) throw new HttpError(409, 'That friend is already in the room.');
  if (room.player_count >= room.max_players) throw new HttpError(409, 'That room is full.');
  // v65 (item 11): one live seat per artist — a friend seated in ANOTHER room
  // cannot accept this invitation (the join-time seat rule would reject it).
  // Fail the invite now with an honest reason instead of a confusing late
  // error on their side.
  const { rows: frSeat } = await pool.query(
    `SELECT u.username FROM users u JOIN room_participants rp ON rp.user_id = u.id
      WHERE u.id = $1 AND rp.state IN ('waiting','ready') AND rp.room_id <> $2
      LIMIT 1`, [toUserId, room.id]);
  if (frSeat[0])
    throw new HttpError(409, '@' + frSeat[0].username + ' is already in a room — they need to leave it before you can invite them.');
  // one live invitation per (room, friend) — re-inviting just re-pushes it
  const { rows: dup } = await pool.query(
    `SELECT id FROM notifications
      WHERE user_id = $1 AND type = 'room_invitation' AND payload->>'room_code' = $2
        AND payload->>'handled' IS NULL AND created_at > now() - interval '2 hours'`, [toUserId, room.code]);
  if (dup[0]) throw new HttpError(409, 'That friend already has an open invitation to this room.');
  await notifyUser(toUserId, 'room_invitation', Object.assign({
    room_code: room.code, room_name: room.name || null, battle_mode: room.battle_mode || '1v1',
    from_user_id: fromUser.id, from_username: fromUser.username, from_display_name: fromUser.display_name,
  }, extra || {}));
  return room;
}

router.post('/friends/:userId/invite', ah(async (req, res) => {
  const to = String(req.params.userId || '');
  if (!/^[0-9a-f-]{36}$/i.test(to)) throw new HttpError(400, 'Invalid user id.');
  if (!(await areFriends(req.user.id, to))) throw new HttpError(403, 'You can only invite friends.');
  const code = String((req.body || {}).room_code || '').trim().toUpperCase();
  if (!code) throw new HttpError(400, 'Choose a room to invite them to.');
  // v63f: 3v3 host-side invites can name the side — team A invitations seat
  // the friend on the captain's side (1-3) when they join.
  const extra = (req.body || {}).team === 'A' ? { team: 'A' } : undefined;
  const room = await inviteToRoom(req.user, to, code, extra);
  res.status(201).json({ ok: true, room_code: room.code });
}));

/** An invited artist marks the invitation handled (accepted = they joined via
    the normal /api/rooms/:code/join; declined = just dismissed). */
router.post('/friends/invitations/:notificationId/:action', ah(async (req, res) => {
  const action = req.params.action === 'accept' ? 'accepted' : req.params.action === 'decline' ? 'declined' : null;
  if (!action) throw new HttpError(400, 'Unknown action.');
  const { rows } = await pool.query(
    `UPDATE notifications SET payload = payload || jsonb_build_object('handled', $3::text)
      WHERE id = $1 AND user_id = $2 AND type IN ('room_invitation') AND payload->>'handled' IS NULL
      RETURNING payload`, [String(req.params.notificationId), req.user.id, action]);
  if (!rows[0]) throw new HttpError(409, 'That invitation was already handled.');
  const p = rows[0].payload || {};
  if (p.from_user_id) rt.sendToUser(p.from_user_id, { type: 'friends.changed', reason: 'invitation_' + action, user_id: req.user.id });
  res.json({ ok: true, handled: action, room_code: p.room_code || null });
}));

// ---------------------------------------------------------------------------
// 3v3 TEAM DRAFT (foundation) — one draft per captain, ≤ 2 friends. This is
// the durable "who is on my team" record the future 3v3 engine consumes;
// today it drives invitations + a 3v3 room opened through the rooms API.
// ---------------------------------------------------------------------------
async function draftOf(userId) {
  const { rows } = await pool.query(
    `SELECT d.id, d.name, d.updated_at,
            COALESCE(json_agg(json_build_object(
                'id', u.id, 'username', u.username, 'display_name', u.display_name,
                'status', m.status, 'avatar_key', p.avatar_storage_key, 'avatar_at', p.updated_at)
              ORDER BY m.position) FILTER (WHERE u.id IS NOT NULL), '[]'::json) AS members
       FROM team_drafts d
       LEFT JOIN team_draft_members m ON m.draft_id = d.id
       LEFT JOIN users u ON u.id = m.user_id
       LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE d.captain_id = $1
      GROUP BY d.id`, [userId]);
  const d = rows[0];
  if (!d) return { id: null, name: null, members: [], size: TEAM_SIZE };
  return {
    id: d.id, name: d.name, updated_at: d.updated_at, size: TEAM_SIZE,
    members: (d.members || []).map((m) => ({
      id: m.id, username: m.username, display_name: m.display_name, status: m.status,
      avatar_url: avatarUrlOf(m.avatar_key, m.avatar_at), online: rt.isUserOnline(m.id),
    })),
  };
}

router.get('/teams/draft', ah(async (req, res) => { res.json(await draftOf(req.user.id)); }));

router.put('/teams/draft', ah(async (req, res) => {
  const b = req.body || {};
  const ids = Array.from(new Set((Array.isArray(b.member_ids) ? b.member_ids : []).map(String)))
    .filter((id) => /^[0-9a-f-]{36}$/i.test(id) && id !== req.user.id);
  if (ids.length > TEAM_SIZE - 1) throw new HttpError(400, `A 3v3 team is you plus ${TEAM_SIZE - 1} players.`);
  for (const id of ids) {
    if (!(await areFriends(req.user.id, id))) throw new HttpError(403, 'Only your friends can be added to a team here — random players join through open rooms.');
    // v65: Add to My Side needs the friend ONLINE — the button is only
    // enabled then, and this server check is the real gate (an offline
    // friend can never be drafted through a crafted request).
    if (!rt.isUserOnline(id)) throw new HttpError(409, 'That friend is offline — invite them when they are online to add them to your side.');
  }
  const name = b.name === undefined ? null : String(b.name || '').trim().slice(0, 40) || null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO team_drafts (captain_id, name) VALUES ($1, $2)
       ON CONFLICT (captain_id) DO UPDATE SET name = COALESCE(EXCLUDED.name, team_drafts.name), updated_at = now()
       RETURNING id`, [req.user.id, name]);
    const draftId = rows[0].id;
    // keep the status of members that stay; drop the rest; add new as 'drafted'
    await client.query(`DELETE FROM team_draft_members WHERE draft_id = $1 AND NOT (user_id = ANY($2::uuid[]))`, [draftId, ids]);
    for (let i = 0; i < ids.length; i++) {
      await client.query(
        `INSERT INTO team_draft_members (draft_id, user_id, position) VALUES ($1, $2, $3)
         ON CONFLICT (draft_id, user_id) DO UPDATE SET position = EXCLUDED.position`, [draftId, ids[i], i + 1]);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  res.json(await draftOf(req.user.id));
}));

/** Tell the drafted players they've been picked (team_invitation notification).
    Not restricted to friends: a drafted player only needs to be a real user. */
router.post('/teams/draft/invite', ah(async (req, res) => {
  const d = await draftOf(req.user.id);
  if (!d.id || !d.members.length) throw new HttpError(400, 'Pick at least one player for your team first.');
  let sent = 0;
  for (const m of d.members) {
    if (m.status === 'invited' || m.status === 'accepted') continue;
    await pool.query(`UPDATE team_draft_members SET status = 'invited', invited_at = now() WHERE draft_id = $1 AND user_id = $2`, [d.id, m.id]);
    await notifyUser(m.id, 'team_invitation', {
      draft_id: d.id, team_name: d.name || null, mode: '3v3',
      from_user_id: req.user.id, from_username: req.user.username, from_display_name: req.user.display_name,
    });
    sent++;
  }
  res.json(Object.assign({ sent }, await draftOf(req.user.id)));
}));

/** A drafted friend answers the team invitation. */
router.post('/teams/invitations/:draftId/:action', ah(async (req, res) => {
  const action = req.params.action === 'accept' ? 'accepted' : req.params.action === 'decline' ? 'declined' : null;
  if (!action) throw new HttpError(400, 'Unknown action.');
  const { rows } = await pool.query(
    `UPDATE team_draft_members m SET status = $3, responded_at = now()
       FROM team_drafts d
      WHERE m.draft_id = d.id AND d.id = $1 AND m.user_id = $2 AND m.status IN ('drafted','invited')
      RETURNING d.captain_id`, [String(req.params.draftId), req.user.id, action]);
  if (!rows[0]) throw new HttpError(409, 'That team invitation is no longer open.');
  await pool.query(
    `UPDATE notifications SET payload = payload || jsonb_build_object('handled', $3::text)
      WHERE user_id = $2 AND type = 'team_invitation' AND payload->>'draft_id' = $1 AND payload->>'handled' IS NULL`,
    [String(req.params.draftId), req.user.id, action]);
  rt.sendToUser(rows[0].captain_id, { type: 'team.changed', draft_id: req.params.draftId, user_id: req.user.id, status: action });
  res.json({ ok: true, status: action });
}));

/** Open a 3v3 room for the draft (through the REAL rooms API) and invite the
    whole team into it. The caller must not already be seated elsewhere. The
    room respects the requested visibility — public rooms leave the remaining
    seats open for any eligible artist; private rooms require the code (the
    room's real join gate). */
router.post('/teams/draft/open-room', ah(async (req, res) => {
  const d = await draftOf(req.user.id);
  if (!d.id || !d.members.length) throw new HttpError(400, 'Pick your players first.');
  const b = req.body || {};
  const visibility = b.visibility === undefined ? 'public' : b.visibility;
  if (!['public', 'private'].includes(visibility)) throw new HttpError(400, 'Visibility must be "public" or "private".');
  const rooms = require('./rooms');
  const room = await rooms.createRoomForUser(req.user, {
    name: (d.name ? d.name + ' · ' : '') + '3v3 Team Battle',
    battle_mode: '3v3', max_players: 6, visibility,
    code: visibility === 'private' ? String(b.code || '').trim() : undefined,
    time_limit_seconds: Number((req.body || {}).time_limit_seconds) || 900,
    battle_type: (req.body || {}).battle_type || 'voting_community',
  });
  const invited = [];
  for (const m of d.members) {
    try { await inviteToRoom(req.user, m.id, room.code, { team: 'A', draft_id: d.id }); invited.push(m.username); } catch (_) {}
  }
  res.status(201).json({ ok: true, room_code: room.code, visibility: room.visibility || visibility, invited });
}));

module.exports = { router, friendsOf };
