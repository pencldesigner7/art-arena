# Art Arena — Community Build, Phases 3–4 Report (search + Arena links)

Base commit: `76b2098`. **Nothing committed or pushed** — held for approval.
Builds on phases 1–2 (`COMMUNITY-PHASES-1-2-REPORT.md`).

## Phase 3 — Categorized instant search (§search)
- `GET /api/community/search?q=` → `{ artists, posts, battles, tags, live }`, capped
  (8/8/8/10/8), one request per keystroke-debounce (250 ms client-side), no polling.
- Sources are honest: artists from `users`, artwork from visible+public posts only,
  battles from decided battles (`battle_challenges.summary_text` / room name), tags
  from real post tags, live/upcoming from the canonical `youtube/twitch liveData()`
  (never-fake states).
- Safety: block pairs never appear in each other's results; the searcher is never
  listed as an artist result; `% _ \` in queries are escaped with a bind-parameter
  `ESCAPE` so input can't act as wildcards or break matching (usernames with `_`
  still match literally — regression-tested).
- UI: search box in the Community header; categorized sections (Artists / Artwork /
  Battles / Tags / Live & upcoming); artist row → existing profile modal; artwork →
  artwork page; battle row → canonical room view (`openRoom`); tag row re-runs search.

## Phase 4 — Arena links (profile extension, results in Community)
- `GET /api/community/profile/:id` — additive Community layer for the EXISTING
  identity modal: follow state, artworks (block-aware), battle history with canonical
  theme + outcome + linked artwork (`View art` when the artist shared it), stats
  (battles/wins/winrate), Grand Arena record from `competition_type='grand_arena'`
  only, live status from verified stream states. Profile still renders if this fetch
  fails (Promise.all with catch).
- Profile modal now shows: Follow (server-authoritative toggle), Challenge (hands off
  to the existing Arena — routes to your rooms to invite the artist; no second battle
  system), LIVE chip when genuinely live, ★ GRAND ARENA chip with real W/L, artwork
  thumbnails, battle-history rows.
- `GET /api/community/my-battles` — the composer's optional battle link is limited to
  battles the publisher actually fought (server-checked at publish time as well).
- Results surface in Community: `battle-end.js` (the ONE decide path) now sends each
  participant an individual `battle_result` notification carrying theme, outcome,
  room code. Notification centre renders it with **Share your art** (opens the
  composer with that battle pre-linked) and **View battle** (canonical room view).
  Payload comes only from the authoritative decide transaction.

## Files changed (this phase)
- `server/community.js` — +`/search`, +`/profile/:id`, +`/my-battles`.
- `server/battle-end.js` — awaited `notifyUser(..., 'battle_result', …)` inside the
  canonical decide path (house style: callers await the notifier).
- `server/public/index.html` — search box + results panel + styles; profile modal
  Community layer; composer battle `<select>`; `NOTIF_TEXT.battle_result` +
  Share/View actions; Challenge hand-off handler.
- `server/tests/community-core.js` — phases 3–4 assertions (search incl. block-aware
  + literal-underscore, seeded canonical battle → `decideBattleIfDue` → per-
  participant notifications, profile GA record + battle↔artwork link, my-battles).
- `server/tests/_shot-community.js` — search UI + profile-layer browser assertions +
  2 new screenshots.

## Verification (all ran this turn, fresh DB rebuilt from schema.sql)
- `community-core.js` → PASS (all phases 1–4 assertions).
- `_shot-community.js` (real Chromium) → PASS incl. search → artist row → profile
  modal with Follow/Challenge/artworks; zero JS errors, zero 404s.
  Screenshots: `theme-previews/v73-community-search.png`,
  `v73-community-profile.png`.
- Full battery: 14 pre-existing suites + community-core → **15/15 PASS**.

## Bugs found & fixed during this phase (verified by test progression)
1. Search sanitization turned `_` into spaces → usernames unfindable; replaced with
   proper `ESCAPE`-parameter escaping.
2. `battle_result` notify was fire-and-forget → raced its own assertions; now awaited
   (matches every other caller of `notifyUser`).
3. Profile posts query reused `POST_ME` (viewer hardcoded as `$2`) with the wrong arg
   order → bind-count 500; rewritten with explicit viewer placeholders + block filter.

## Limitations (honest)
- Messaging/group chat = phase 6 (next), moderation UI + grouped notification centre =
  phases 7–8; Challenge button currently routes to the rooms/invite flow (the only
  existing way to battle a specific artist) — a dedicated accept/decline challenge
  notification can layer on in phase 6 without a second battle engine.
- Search is `ILIKE`-based (fine at this scale); no ranking beyond recency/alphabetical.
