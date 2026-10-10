# COMMUNITY — FINAL REPORT (§97)

Base commit: `76b2098` (v72). All work below is **uncommitted**, pending your approval.
Companion phase reports: `COMMUNITY-PHASES-1-2-REPORT.md`, `COMMUNITY-PHASES-3-4-REPORT.md`, `COMMUNITY-PHASES-5-6-REPORT.md`.

---

## 1. What ALREADY existed (inspected before any change)

- **Tables shipped dormant in `schema.sql`** (never used by any endpoint): `community_posts`, `community_comments`, `community_post_likes`, `community_artwork`, `artwork_saves`, `follows`, `blocks`, `mutes`, `reports`, `conversations`, `conversation_members`, `messages`, `friend_requests`, `friendships`, `notifications`.
- **One canonical identity**: `users` + `user_profiles`, sessions via `auth_tokens`; friends page (`friends.js`), rooms, battles, brackets, streaming (`twitch.js`/`youtube.js`/`streams`), notifications table + bell UI.
- **Realtime hub** (`realtime.js`) with WS subscription channels (lobby/room/user) — extended, never replaced.
- **Moderation status vocabulary** (`visible/hidden/removed`) already modeled on `community_posts.status`.
- Drawer navigation, profile modal, notification bell, theme token system, premium themes.

Nothing was recreated, redesigned, or overwritten. The Community layer was built **on** the dormant tables and existing infra.

## 2. What was NEW (by phase)

**Phase 1–2 — Foundation & artwork posts**
- `server/community.js` (new module): authed router mounted at `/api/community`; `GET /community-art/:key` public bytes route (same pattern as `/avatars` — `<img>` tags carry no headers).
- Fast publish: image + title + caption + tags (server-normalized, deduped, capped) + optional drawing tool + optional battle association. Stored rows only; bytes on disk under `server/public/uploads/community/`.
- Artwork page data: hero image, Like (one-per-user, server-authoritative toggle), Comment, Save, Report.

**Phase 3–4 — Discovery & Arena links**
- Feeds: For You (multi-signal: freshness, engagement quality, following, battle activity, emerging-artist diversity; anti like-monopoly + anti artist-repetition), Following, Trending, New (chronological), Battle Art (canonical battle context via `battle_id`; deep-links into the existing battle experience).
- `GET /artists` + `GET /artists/:id` discovery (fair to emerging artists), `GET /search` (artists/artwork/battles/tags/live, categorized).
- Comments with 1-level replies, delete-own, report; Saves private (profile library); profile extension (`GET /profile/:id`): avatar/bio/follow/message/challenge, battle history (result+theme+artwork), Arena stats (wins/win-rate), Grand Arena status, live status — achievements only from authoritative Arena data; no follower centerpiece.
- Challenge button hands off to the existing Arena/matchmaking — no second battle system. Battle results surface in Community with view/share links.

**Phase 5 — Live/Upcoming**
- Live + Upcoming tabs read ONLY authoritative stream states (`inactive/starting/live/cancelled/ended/error`) from `streams`/`twitch_stream_sessions`/`youtube_broadcasts`; a `starting` stream never renders as LIVE.

**Phase 6 — Social & messaging (Chat spec)**
- `server/messages.js` (new module) at `/api/messages`: threads list, thread detail, paged messages (cursor), send, mark-read, group creation. DMs + groups on the dormant shipped tables.
- Realtime delivery via existing WS hub (per-user channel) — **no polling**.
- UI: Messages drawer row, thread list, conversation view, composer; Art Arena styling (not a messenger clone).

**Phase 7 — Safety**
- Server-enforced everywhere: `POST/DELETE /block/:id`, `POST/DELETE /mute/:id`, `GET /safety`, `POST /report`.
- Block overrides follow (kills follows both directions), blocks follow attempts (403), messaging, comments, challenges, and feed visibility.
- Mute silences notifications and live-start notices (`notify.js` + stream notifications check actor mute/block).
- Moderator endpoints: `GET /moderation/role`, `GET /moderation/queue` (reports joined, LIMIT 50), `POST /moderation/action` (`hide|remove|restore`; anything else 400). Moderation never destroys evidence — rows flip status, `admin_audit_log` records actions.
- UI: Safety view (blocked/muted management), Moderation view (queue + Hide/Remove/Restore), role-gated drawer row (hidden by default; shown only after `GET /moderation/role` confirms moderator), profile Mute/Block buttons, artwork moderation status chip for non-visible posts.

**Phase 8 — Polish**
- Notification grouping: engagement types (`post_like`, `new_follower`) grouped per type per day ("+N more that day"); challenges/messages/battle results stay individual. Grouping respects mutes/blocks (a muted actor's event never enters the bell).
- Empty states, error/offline handling (never fake success), reduced-motion + state-not-color-only a11y passes, pagination/cursor review, lazy images.

## 3. Files changed / added

**Modified (server):** `server.js` (mounts, boot migration incl. `blocks_pkey`), `schema.sql` (blocks PK + community indexes), `notify.js` (actor mute/block skip, community notification types), `battle-end.js` (battle-result → Community surfacing hook), `matchmaking.js` + `rooms.js` (v73 3v3 auto-refill; leave-resumes-search), `twitch.js` + `youtube.js` (live-state notifications carry actor), `public/index.html` (all client phases 1–8), `public/premium-themes.css` + `public/premium-scenes.js` (community/messages/safety views themed via tokens), 5 theme PNGs (v73 logos), `tests/entry-art-motion.js` (v73 assertions).

**Added (server):** `server/community.js`, `server/messages.js`.

**Added (tests):** `community-core.js`, `messages-core.js`, `3v3-autofill.js`, `_shot-v73.js`, `_shot-community.js`, `_shot-messages.js`, `_shot-safety.js`.

**Reports:** `COMMUNITY-PHASES-{1-2,3-4,5-6}-REPORT.md`, this file.

## 4. Database changes

- **No new tables** — built on the shipped dormant schema.
- `schema.sql`: `blocks` primary key (`blocks_pkey`) + indexes for feeds/queue lookups.
- `server.js` boot migration: idempotent `blocks_pkey` add for existing DBs; **fresh-schema parity verified** (`schema-bootstrap.js` builds a fresh DB from `schema.sql` and asserts identical structure).
- Migrations are incremental + idempotent; re-running boot on the existing DB is a no-op.

## 5. Tests

**Full battery: 21/21 PASS** (run against the live server + Postgres, this session):
`3v3-autofill, 3v3-matchmaking-browser, 3v3-optional-invite, _shot-community, _shot-live-ui, _shot-messages, _shot-safety, _shot-v73, brandmarks-v2, browser-regressions, community-core, entry-art-motion, manga-variant, messages-core, navigation-return, network-gate, premium-mode, room-regressions, schema-bootstrap, stream-cancel, theme-additions`.

- `community-core.js` — **PASS community phases 1–7**: publish/normalize/dedupe tags, like toggle one-per-user, comments+replies+delete-own, saves private, follow both directions, battle-art canonical context, search categorization, report → queue, mute silences bell (0 notifs) / unmute restores, block kills follows both dirs + 403 follow-while-blocked + safety list + unblock, role gate (non-mod 403 on queue), hide → `hidden` leaves feeds but retains evidence, restore, bogus moderation action 400.
- `messages-core.js` — DMs/groups, cursor paging, read receipts, block cuts messaging.
- `_shot-safety.js` (browser) — moderator sees role-gated Moderation row, queue renders the report, Hide retains status, Safety view + unblock; non-moderator never sees the row.
- All pre-existing suites regression-run after every phase (per your instruction).

**Test-hygiene fix this session:** `_shot-v73` scenario 11 intentionally leaves a 5/6 3v3 room searching for a replacement; `room-regressions` then legitimately absorbed its first 3v3 entrant into that room (real `joined3` behavior) and failed its "partial queue never matches" assert. Fixed by giving `_shot-v73` a post-run cleanup (same two statements as its pre-run hygiene). Not an app bug — verified by DB forensics: the entrant was seated into leftover room `06279`, and no product rule was violated.

## 6. Performance

- Cursor pagination on feeds/comments/messages; LIMIT 50 moderation queue; no full-history loads.
- Lazy image loading for artwork grids; artwork bytes served with the public `/community-art/:key` route.
- Realtime over the existing WS hub — no polling loops, no duplicate listeners (delegated handlers throughout).
- Feed queries use the added indexes; anti-repetition done in SQL window, not application loops.

## 7. Security

- Every endpoint authed; server-authoritative for likes/follows/blocks/roles — the client never decides.
- Moderator actions gated by `user_roles` server-side (403 otherwise); UI row is cosmetic only.
- Blocks enforced at the data layer for follows, messaging, comments, challenges, feeds, notifications, and share links.
- Anti-spam: server-side rate limits on posts/comments/messages/reports.
- Moderation preserves evidence (status flips + `admin_audit_log`), never deletes reports.
- No fake users/streams/data anywhere; live states only from authoritative stream records.

## 8. Limitations (honest)

- Report queue has no moderator assignment/notes workflow (single shared queue, LIMIT 50).
- Notification grouping is per-type-per-day; no cross-type digest.
- Message search within threads is not implemented (thread list only).
- Grand Arena treatment is presentation-only inside Community; eligibility logic untouched (as specified).
- Screenshot tests require Chromium (`/home/user/audit-tools`) and a running server + Postgres; they are environment-dependent by nature.
- Boot log still shows benign "must be owner" migration lines on the grant-restricted app role (objects already exist; fresh-schema path is clean via `schema-bootstrap`).

## 9. Visual previews (real components, no mockups)

`/home/user/theme-previews/` — 13 v73 shots (`v73-01…v73-13`) + Community phase shots (`v73-community-*.png`, `v73-messages-{a,b}.png`) + safety shots:
- `v73-moderation-queue.png` — moderator queue with Hide/Remove/Restore
- `v73-safety-view.png` — blocked/muted management with Unblock
- `v73-messages-{a,b}.png` — thread list + conversation view
- `v73-10-3v3-full.png` / `v73-11-3v3-searching.png` — 6/6 absolute + honest auto-search

## 10. Git status

Branch on `76b2098`, working tree dirty as listed in §3 (17 modified, 8 new source/test files, 4 reports). **Nothing committed or pushed** — awaiting your explicit approval per your standing instruction.
