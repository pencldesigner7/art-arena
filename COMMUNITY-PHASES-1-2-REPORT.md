# Art Arena — Community Build, Phases 1–2 Report (v73 continuation)

Base commit: `76b2098` (v72). **Nothing committed or pushed** — held for your approval.

## 1. What EXISTED before this work (inspected, reused, untouched)

- Dormant schema shipped in the repo dump: `community_posts`, `community_comments`,
  `community_post_likes`, `follows`, `reports` tables (no UI, no routes).
- One canonical identity system: `users` + `user_profiles.avatar_data` bytea avatars,
  session tokens, `requireAuth`, `notifyUser(userId, type, payload)` realtime notifier.
- Authoritative Arena data for achievements/context: `battles`, `battle_challenges`,
  `battle_participants`, `battle_results`, `battle_votes`, room/stream state tables.
- Canonical live states: `GET /api/live` (YouTube/Twitch verified; unverifiable statuses
  never advertised) — reused as-is by the Community Live/Upcoming tabs.
- Existing navigation, themes (all base + 5 premium), realtime WebSocket hub.

## 2. What was ADDED / CHANGED

### New files
- `server/community.js` — Community API router (phases 1–2): publish (multipart, 8 MB cap,
  type/bytes validation, tags normalized+deduped, ≤ cap), immutable artwork byte store served
  at `GET /community-art/:key` (public, unguessable keys, immutable cache), cursor-paginated
  feeds (`posts`, `posts/following`, `posts/battle-art`) with honest rankings
  (`sort=trending` = 7-day real engagement window; `sort=for-you` = followed-first then
  recency), server-authoritative like toggle + private save toggle, comments with
  one-level replies (depth capped), own-delete, @mention notifications, post edit/delete
  ownership, follow/unfollow idempotent, artist discovery ordered by Arena signals
  (battles + wins + recency, fair to emerging), artist profile view, reports → moderation
  queue **without auto-delete**, server rate limits (`rate()`), block pairs excluded from
  every read and every write.
- `server/tests/community-core.js` — API suite (PASS).
- `server/tests/_shot-community.js` — real-browser UI suite incl. 3 screenshots (PASS).

### Changed files
- `server/server.js` — mounts `community.js` + public art bytes; v73 idempotent boot
  migrations (fresh-schema parity): `community_artwork`, `artwork_saves`, PKs for
  `community_post_likes`/`follows`, notification enum values `post_like`/`post_comment`.
- `server/schema.sql` — same DDL + inline unique constraints (source of truth).
- `server/public/index.html` — replaced the COMING-SOON placeholder with the real
  Community view: 9 tabs (For You, Following, Trending, New, Battle Art, Artists, Live,
  Upcoming, Saved), artwork page overlay (hero image, like/save/share/report, follow,
  comments with replies + own-delete, tags, battle chip), fast-publish composer overlay,
  honest empty states per tab, single delegated listener (no per-card handlers, no
  polling, overlays release on close), CSS on theme tokens only
  (`--line/--muted/--pink/--card`), focus-visible states, `prefers-reduced-motion`
  respected, lazy-loaded thumbnails.

## 3. Database changes (all applied to the live DB AND recorded in schema.sql + boot migrations)
- Created: `community_artwork`, `artwork_saves`.
- Added uniqueness (shipped missing): `community_post_likes_pkey`, `follows_pkey`
  (one like per user per post; one follow per pair) — enforces toggle semantics at the DB.
- Enum: `notification_type` += `post_like`, `post_comment`.

## 4. Verification (this turn)
- `tests/community-core.js` → PASS: publish/validation/bytes, cursor feeds, likes/saves
  server-counted + private, comments→replies depth cap + own-delete + mentions,
  edit/delete ownership, follows + block override everywhere, artist discovery by Arena
  signals, reports to moderation without auto-delete, 401s.
- `tests/_shot-community.js` → PASS (real Chromium): nav opens Community, For You/New
  show real artwork, honest empty states (Battle Art/Live/Upcoming/Saved), Artists tab,
  artwork page like→1 / save / comment / follow→Following / report categories visible,
  composer publishes through the browser, Arena view intact afterwards, **zero JS errors,
  zero 404s**.
- All 14 pre-existing suites → PASS (brandmarks-v2, schema-bootstrap, network-gate,
  theme-additions, premium-mode, room-regressions, browser-regressions,
  navigation-return, entry-art-motion, manga-variant, stream-cancel, 3v3-autofill,
  3v3-optional-invite, 3v3-matchmaking-browser). Note: schema-bootstrap needs
  `TEST_PG_ADMIN_URL` pointed at the rebuilt DB's admin role — env difference of this
  sandbox, not a code change.
- Screenshots: `theme-previews/v73-community-feed.png`, `v73-community-artwork.png`,
  `v73-community-after-publish.png` (real components, no mockups).

## 5. git status (uncommitted, base 76b2098)
Modified: `server/matchmaking.js`, `server/public/index.html`,
`server/public/premium-scenes.js`, `server/public/premium-themes.css`, 5 theme PNGs,
`server/rooms.js`, `server/schema.sql`, `server/server.js`,
`server/tests/entry-art-motion.js`. New: `server/community.js`,
`server/tests/3v3-autofill.js`, `server/tests/_shot-community.js`,
`server/tests/_shot-v73.js`, `server/tests/community-core.js`.

## 6. Limitations (honest, per spec)
- Search (§search), profile Community extensions, challenge hand-off button, grouped
  notification centre, messaging (phase 6), moderation UI, Grand Arena surfacing are
  later phases — not yet built.
- Trending/For-You rankings are deliberately simple and honest (7-day engagement window;
  followed-first) — no hidden scores, no fake personalization.
- Live/Upcoming tabs show only what `/api/live` verifies; in this dev environment with no
  stream credentials they correctly show empty states.
- Report categories are fixed server-side; reports await a moderation UI.
