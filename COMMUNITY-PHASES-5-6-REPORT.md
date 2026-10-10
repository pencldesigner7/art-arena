# Art Arena — Community Build, Phases 5–6 Report (live surfacing + messaging)

Base commit: `76b2098`. **Nothing committed or pushed** — held for approval.
Builds on `COMMUNITY-PHASES-1-2-REPORT.md` and `COMMUNITY-PHASES-3-4-REPORT.md`.

## Phase 5 — Live surfacing (real states only)
- `notify.js` gained `notifyLiveStart(userId, platform, title)`: on a **genuine**
  inactive→live flip it notifies the artist's Community followers (`follows`) with the
  existing `livestream_start` notification type.
- Hooks placed at the two authoritative transition sites:
  - `twitch.js` `applyStreamOnline()` — the preparing→live flip confirmed by
    EventSub/sweep (`host_user_id` added to the session query).
  - `youtube.js` `syncBroadcastRow()` — lifecycle sync flip to `live`.
- Notification centre renders it with an **Open LIVE** action → canonical LIVE view.
- No scheduled/hyped states anywhere: the hook fires only on confirmed flips.

## Phase 6 — Messaging (DMs + groups) on the dormant shipped tables
The repo already shipped `conversations`, `messages`, `mutes` (unused). Phase 6
extends them instead of inventing a parallel system:

### Schema (schema.sql fresh-parity + idempotent v73 boot migrations + applied live)
- `conversations` += `is_group`, `name`, `created_by`; pair columns nullable for
  groups with `ck_group_or_pair` integrity; PK added (dump shipped none).
- New `conversation_members` (membership + per-member `last_read_at`), PK, FKs.
- `messages` PK + `(conversation_id, created_at DESC)` index; `mutes` PK.
- `uq_one_dm_per_pair` unique index — one DM thread per pair, DB-enforced.

### Server — new `server/messages.js` mounted at `/api/messages`
- `GET /threads` — newest-first list with preview + unread (per-member read state).
- `POST /threads {user_id}` — DM, **friends only**, block-enforced, idempotent.
- `POST /threads/group {name, member_ids}` — creator + ≤7 friends; every member must
  be the creator's friend; blocks refused.
- `GET /threads/:id` + `GET /threads/:id/messages?before=` (cursor, 50/page; fetch
  marks read) + `POST /threads/:id/read`.
- `POST /threads/:id/messages` — 1–4000 chars (DB check), 120/hour rate limit,
  member-only, block pair → 403; fan-out = realtime `chat.message` push **plus**
  persistent `message` notification per recipient (payload from server only).

### Client
- Drawer **Messages** entry (new NAV row + icon); `view-messages` two-pane UI
  (threads / thread), theme-token CSS, responsive stack, Enter-to-send,
  scroll-top history paging, unread dots.
- Realtime through the EXISTING WS hub: `chat.message` added to the onmessage
  whitelist → `aa-chat` event; open thread appends instantly, otherwise toast +
  list refresh. **Zero polling.**
- Profile modal gained a **Message** button (friends only) opening/creating the DM.

## Verification (fresh DB rebuilt from schema.sql; all ran this turn)
- `tests/messages-core.js` → PASS: stranger DM 403, one-thread-per-pair, validation
  (empty/4001), unread→read, persistent `message` notification, non-member 404s,
  group friend-gating + fan-out unread, **block kills sending on existing threads**,
  cursor paging (50 + has_more ordering).
- `tests/_shot-messages.js` → PASS in two real browser sessions: drawer entry, DM
  start from friends, send, unread dot on the other account, **realtime push both
  ways** (reply appears in the first open session via WS), zero JS errors/404s.
  Screenshots: `theme-previews/v73-messages-a.png`, `v73-messages-b.png`.
- Full battery: 14 pre-existing + community-core + messages-core + both UI suites
  → **18/18 PASS**.

## Bugs found & fixed this phase (verified by test progression)
1. `LEAST($1,$2)` on untyped bind params → `uuid = text` 500; cast to `::uuid`.
2. Cursor predicate `created_at` ambiguous after JOIN; aliased `m.created_at`.
3. `ws.onmessage` type whitelist predated `chat.message` — pushes arrived at the
   socket but never reached the dispatcher; whitelist extended (proven by the
   two-browser realtime test).
4. schema.sql forward reference: `conversation_members` FK to `users` deferred to
   end-of-dump ALTER (dump ordering).

## Limitations (honest)
- Message payloads (battle/artwork/room shares inside chat) are schema-supported
  (`messages.payload_type`) but not yet surfaced as rich bubbles — phase 7/8 polish.
- No message edit/delete; block stops *new* sends, history stays visible to both
  sides (consistent with Community content behaviour).
- Moderation queue UI, grouped notification centre, a11y/perf polish = phases 7–8.
