# Art Arena™ — dev service (built through Phase 6 · Randomizer)

Built so far on this stack: **Phase 1** Authentication · **Phase 2** Arena
Home · **Phase 4** Battle Rooms · **Phase 5** Real-Time Communication ·
**Phase 6** Randomizer.
Next in the build order: the **battle engine** (takes over from
`battles.status = 'challenge_locked'` — the pre-battle chain ends there).

## What it does

| Flow | Endpoint(s) | Notes |
|---|---|---|
| **Sign up** | `POST /api/auth/register` | Validates username (3-30, `[A-Za-z0-9_]`) + email + password (8+). **Auto-creates in one transaction:** `users` row, `user_profiles` row, `user_statistics` row, and an email-verification token. 409 on duplicate username/email (case-insensitive). **The code is emailed — never returned in the response.** |
| **Email verification** | `POST /api/auth/verify-email` · `POST /api/auth/resend-verification` | One-time code delivered **only by email** (see "Dev-mode email" below). 256-bit token; only its SHA-256 hash is stored; one-time; 24h expiry. Verified = `users.email_verified_at` set. Verification does **not** block login — the account page shows a verify banner until it's done. |
| **Log in** | `POST /api/auth/login` | Accepts email **or** username (citext). Creates a server-side `sessions` row (30-day expiry) + `HttpOnly SameSite=Lax` cookie, **and returns `session_token`** in the body (client echoes it as `Authorization: Bearer <token>`). Sets `last_login_at`. 401 generic on bad credentials (timing-equalized, no user enumeration). 403 for suspended/banned/deactivated. Returns the full account payload (user + profile + stats) so no follow-up call is needed. |
| **Log out** | `POST /api/auth/logout` | Revokes the session server-side (`revoked_at`), clears the cookie. |
| **Session persistence** | — | Sessions live in Postgres, so they survive server restarts. The client keeps the session token in `sessionStorage`; every request carries it via **three redundant channels** — `Authorization: Bearer <token>` header, the `arena_session` cookie, and `?arena_token=<token>` in the query string (see "Session channels" below). `GET /api/auth/me` resolves token → session → user + profile + stats. |
| **Forgot password** | `POST /api/auth/forgot-password` | Generic response always (no email enumeration). Issues a 1h one-time code **emailed only**; supersedes older unused ones. |
| **Reset password** | `POST /api/auth/reset-password` | One-time code, then revokes **all** sessions for the account (old devices signed out). |
| **Account settings** | `PUT /api/account/profile` | Display name, bio (≤300), country code (ISO, normalized), drawing app (validated against `drawing_apps`), discoverable flag. **Password changes are ONLY via Forgot password** (tap-only from the login screen) — by design there is no change-password endpoint or UI. |
| **Reference / dev** | `GET /api/drawing-apps` · `GET /api/health` · `GET /api/ui-version` · `GET /api/dev/outbox?to=<email>` | App list for the settings dropdown; health probe; deployed UI version (stale-tab guard); dev-only simulated mailbox (see below). |

## UI (post-login app shell)

`public/index.html` is a single-page vanilla-JS app (no dependencies):

- **Auth screens** — Log in / Sign up / Forgot password (Phase 1, unchanged behavior: Bearer + query-token session channels, dev inbox buttons, self-healing 401).
- **After login → Arena Home** — the main screen: personalized welcome, live RATING/W/L/D/STREAK strip (from `GET /api/auth/me`), a **⚔️ QUICK MATCH** hero card ("Ready to battle?") plus **👥 FIND ARTIST / 🏠 ROOMS / 👑 GRAND ARENA** cards.
- **Bottom nav** — 🏟️ Arena · 🌐 Community · 👤 Profile. The Profile tab is the Phase-1 account/settings page (profile form, verified badge, logout). Nav is **config-driven**: the `NAV` array at the top of the page script renders the tabs, and the view list, in-app detection, and active-tab highlighting are all derived from it (plus `TAB_CHILDREN` for destination screens under a tab). **Adding a tab later (e.g. LIVE with the livestream system) = one `NAV` entry + one `<section id="view-live">`** — no restructuring.
- **🏠 Rooms is a real system (Phases 4+5)** — create a room (short shareable code, public/private, battle type, time limit), join as a player, press **READY**, spectate, and the host starts the battle. See "Battle Rooms" and "Real-Time Communication" below. Room changes reach every open screen **live over the WebSocket**; the 2.5s poll is only the fallback. The header shows the active mode: **⚡ LIVE** (WebSocket connected) or **⚡ POLLING** (degraded). Live changes also appear as toasts ("⚔️ @alex joined the room", "🟢 Maya is ready").
- **Remaining placeholders** — the ⚔️ Quick Match, 👥 Find Artist, and 👑 Grand Arena cards plus Community lead to honest destination screens ("NEXT IN THE BUILD ORDER" / "LATER PHASE") — those systems are upcoming build items, not dead buttons.
- Brand per spec: Arena Black base, Neon Pink → Electric Purple gradients, dark default.

## Battle Rooms (Phase 4)

The place where artists meet. Built on the foundation schema (`battle_rooms`,
`room_participants`, `room_spectators`) — no parallel structures. Two columns
were added to `battle_rooms` to carry what the spec requires of a room: `code`
(short shareable ID, "ROOM #48291") and `result_method` (the battle type the
host chooses). The `set_updated_at` trigger needed `battle_rooms.updated_at`,
which was added (the column was missing and every room UPDATE 500'd).

| Endpoint | Notes |
|---|---|
| `GET /api/rooms` | Rooms I'm in (host/player/spectator) + public rooms open in lobby. |
| `POST /api/rooms` | Create a room; creator becomes host AND player (seat 1). Body: `{ name?, visibility: public\|private, time_limit_seconds: 60..43200 (1 min – 12 h), battle_type }`. |
| `GET /api/rooms/:code` | Full detail: host, seated players, spectators, settings, latest battle. |
| `POST /api/rooms/:code/join` | Join as a player (re-joins if you left earlier; seat preserved; `ready_at` reset). 409 if not in lobby / full / already in / you're a spectator. |
| `POST /api/rooms/:code/ready` | **Toggle READY** (Phase 5). Any seated player, lobby only. Sets `state='ready'` + `ready_at=now()` (the `ck_room_ready` constraint requires the timestamp) or back to `waiting` (clearing `ready_at`). 409 if you're not a player in the room or the battle already started. Broadcasts a `ready`/`unready` event live. |
| `POST /api/rooms/:code/leave` | Leave. **If the host leaves, the host transfers** to the next seated player, or the room closes if empty. |
| `POST /api/rooms/:code/spectate` · `/leave-spectating` | Spectate freely while `spectator_allowed` and the room isn't over. |
| `PATCH /api/rooms/:code` | Host only, lobby only — change `time_limit_seconds` and/or `battle_type`. |
| `POST /api/rooms/:code/close` | Host only, lobby only → room `ended`. |
| `POST /api/rooms/:code/start` | **Host only; needs exactly 2 players.** Creates a `battles` row in `waiting` with both players seated and the room's locked settings, then flips the room to `starting`. |

**The battle seam:** `start` is where this build ends and the battle engine
(next build) begins. It writes a `waiting` battle through the same table the
canonical state machine (`battle_status_transition` trigger) governs, so the
engine can take over `waiting → ready → locked → …` without any rework.
MVP rooms seat exactly 2 (one_on_one); `max_players` 2–16 and the `multi`
format stay available for later. All role/capacity/status checks run
server-side in transactions — the client never decides who can start.

## Real-Time Communication (Phase 5)

The two users in a room now see each other's changes **almost immediately**:
"@Maya joined the room", "🟢 Maya is ready", settings changes, battle start,
room closed — pushed the instant the server commits the change. No polling
required (the 2.5s poll remains only as a fallback).

**How it works** — a WebSocket hub (`realtime.js`) attached to the **same
HTTP server and port** (no second process):

```
ws(s)://<host>/api/realtime?arena_token=<session token>
```

- **Auth** = the same session tokens as REST, resolved by the same
  `lib.sessionUser()` (Bearer header or `?arena_token` — the query channel is
  the one proven to survive the preview proxy). Bad/expired sessions and
  inactive accounts are rejected with close code **4401**.
- **Channels** — clients `subscribe`/`unsubscribe` to room codes plus the
  global **`lobby`** channel (room-list refreshes). Max 8 channels/client.
  Private rooms: only their players/spectators may subscribe
  (`canViewRoom()` in `rooms.js`); public rooms: anyone.
- **Events** — every state change in `rooms.js` calls `rt.emitRoom(code,
  event)` right after the transaction commits (and `rt.broadcastRoomsList()`
  for public create/close). The client treats the **REST payload as the
  single source of truth**: on an event it re-fetches the room and shows a
  toast — so the live layer can never drift from the API.

| `room.event` → `event.action` | Meaning (toast on other screens) |
|---|---|
| `joined` / `rejoined` | ⚔️ @user joined / rejoined the room (carries `seat`) |
| `left` | 👋 @user left the room |
| `ready` / `unready` | 🟢 user is ready / ⚪ no longer ready (carries `seat`) |
| `spectated` / `spectate_left` | 📺 user is spectating / stopped spectating |
| `settings` | ⚙️ room settings updated |
| `host_transferred` | 👑 user is now the host |
| `started` | 🚀 the battle has started |
| `closed` | ⚪ the room was closed (viewers return to the list) |

Plus `{ type:'rooms.list', reason:'created' \| 'closed' }` on the `lobby`
channel — the room list itself is live.

**Client** (`public/index.html`): one socket per browser session, auto-retry
with exponential backoff (1s → 30s cap), re-subscribes on view changes, and
dedupes its own actions (your REST response already re-rendered your screen).
If the WebSocket can't connect (e.g. a proxy that refuses the upgrade), the
app degrades gracefully to the 2.5s poll and the header chip shows
**⚡ POLLING** instead of **⚡ LIVE**. A 30s ping/pong heartbeat on the server
prunes dead sockets.

**Extending to the battle engine (next build):** the engine just calls
`rt.emitRoom(battleRoomCode, { action: '…' })` after each state-machine
transition (`randomizing`, `countdown`, `active`, …) — the hub, subscriptions,
toasts, and fallback already exist. No new infrastructure needed.

> **Testing:** `/tmp/rt_e2e.js` (38 checks — live join/ready/spectate/
> settings/start/close/list events, WS auth incl. post-logout rejection,
> private-room subscribe denial, Phase 4 guard regression) and
> `/tmp/rooms_regression.js` (28 checks — host transfer, solo-leave close,
> rejoin-keeps-seat, role/capacity guards). Both run against a local server
> with throwaway users and clean up after themselves. (Rebuildable from this
> section if `/tmp` is wiped by a sandbox reset.)
>
> **Fixed during Phase 6 testing** — a first-frame race: the connection
> handler awaited the session lookup before attaching the `message`
> listener, so a client's immediate `subscribe` (sent on `open`) could be
> parsed with no handler and silently dropped. Listeners are now attached
> up front and frames arriving while the session resolves are queued, then
> flushed after `hello`.
## Randomizer (Phase 6)

The signature challenge system. The host chooses **which elements/categories**
take part; the **server** then rolls the official challenge from a pool of
**10,467 official elements** and locks it — both players receive the
identical, persisted challenge.

```
HOST CHOOSES                THE SERVER ROLLS             BOTH PLAYERS SEE
Character ✅                Character:    🐉 DRAGON      🔒 CHALLENGE LOCKED
Environment ✅              Environment:  🌃 CYBERPUNK CITY   Character: 🐉 DRAGON
Object ✅                   Object:       ⚔️ SWORD          Environment: 🌃 CYBERPUNK CITY
Style ✅                    Style:        🎨 WATERCOLOUR     Object: ⚔️ SWORD
Mood ❌                                                 Style: 🎨 WATERCOLOUR
```

**The word pool** — 8 categories (from `randomizer_categories`), all
`status = 'active'`, `source = 'official'`:

| Category | Icon | Elements | Notes |
|---|---|---|---|
| character | 🧙 | 2,600 | |
| environment | 🌍 | 2,000 | |
| object | ⚔️ | 2,000 | |
| style | 🎨 | 1,100 | |
| mood | 🎭 | 1,000 | |
| lighting | 💡 | 635 | |
| color | 🌈 | 900 | `is_optional = true` |
| wildcard | 🎲 | 232 | |

**Total: 10,467** (target was 10,000+). Generated by
`tools/generate_randomizer.py` — deterministic (fixed seed), curated seed
vocabulary + coherent combinatorial expansion, deduped, writes
`server/randomizer_seed.json` (~0.5 MB). Re-run it any time to regenerate the
same pool. `seed.js → ensureRandomizerSeed()` loads the JSON at startup in
idempotent 1,000-row chunks (`ON CONFLICT (category,name) DO NOTHING`) and
**skips entirely when the pool is already present** — so a sandbox reset
self-heals on the next `npm start`.

**Endpoints** (all require an active session):

| Endpoint | Purpose | Rules |
|---|---|---|
| `GET /api/randomizer/categories` | Category list with live active-element counts (drives the settings grid) | returns `total` across categories |
| `POST /api/rooms/:code/randomizer-config` | Host saves the chosen categories | host only (403), **lobby only** (409 once started), body `{categories:[keys]}` — unknown key 400, empty 400. Stored as `battle_rooms.randomizer_config` jsonb + emits `settings` (what: "challenge elements") |
| `POST /api/battles/:id/lock-challenge` | **The roll.** Generates and locks the official challenge | host only; battle must be `waiting`/`ready`/`locked` (409 after). Default: the classic four (`character, environment, object, style`) when no config was saved |
| `GET /api/battles/:id/challenge` | The locked challenge (used to re-sync any screen) | `canViewRoom()` gate — private-room outsiders get 403 |

**How the lock works** (one transaction, `randomizer.js`):

1. Locks the battle + room rows (`FOR UPDATE`), verifies host + status.
2. **Walks the canonical state machine** the way the schema trigger
   requires: `waiting → ready → locked` (sets `settings_locked_at`)
   `→ randomizing → challenge_locked`. The DB trigger
   (`trg_battle_status_transition`) rejects anything else, so the server can
   never skip a state.
3. Audits `randomizer_started {categories}` in `battle_event_log`.
4. Picks **one random active element per chosen category**
   (`ORDER BY random() LIMIT 1`) — the server decides; no client
   involvement, no re-rolls.
5. Persists the OFFICIAL challenge: `battle_challenges` (denormalized
   `summary_text` = values joined ` · `) + one `battle_challenge_elements`
   row per category (element id + name snapshot).
6. Audits `challenge_locked {summary, elements}`, commits — **then**
   broadcasts `rt.emitRoom(code, { action: 'challenge_locked', by, summary })`.

**Difficulty bands** (shown under the category grid, derived from count):
2–3 **easy** · 4–5 **normal** · 6–7 **hard** · 8 **arena**.

**UI (v16):** the time limit is a preset chip row — **20 min · 30 min ·
1 hour · Custom** (server range 1 min – 12 h). **Custom opens a floating
modal** that hovers above the page with **Hours** and **Minutes** fields and a
live "= 1 h 30 min" summary; **Set time** dissolves it (fade + shrink), and
the choice stays editable via a **✏️ Edit time** chip that shows the current
value. Out-of-range input (0:00, 12 h+, minutes > 59) is rejected inline in
the modal.
*Bug history:* v13/v14 shipped `if (b.dataset.custom)` — but a bare
`data-custom` attribute reads as `""` (falsy!) in `dataset`, so "Custom"
actually took the preset branch with `NaN` seconds, the input never appeared,
and saves sent `null` → the server's 400. The field test caught it; fixed
with `hasAttribute('data-custom')` and covered by a real-DOM-semantics
simulation (30 checks).
*v16 fix (login page regression):* in v15 the modal's markup sat **below**
the app `<script>` tag, but the `timeModal` IIFE queries `#tm-set`
synchronously at script-run time — in a real browser the element is not
parsed yet, so it was `null` and the resulting top-level `TypeError` killed
**the entire UI script** before the login form's submit handler was ever
bound (login page looked dead: clicking "Log in" only fired a native form
reload). Fixed by moving the modal / upgrade-banner / version-badge markup
**above** the script tag (comment in the HTML warns not to move it back);
regression-proofed with a parse-order-aware DOM harness plus a full jsdom
login-flow E2E (boot → 401 → login view, fill + submit → arena home,
password toggle, stale-tab banner).
**Version guard:** the client polls `GET /api/ui-version` (no-store, read
from the served HTML at boot) every 15 s; if the deployed version is newer
than the open tab's, a top banner appears and the page auto-reloads after
~12 s — stale tabs can no longer hide fresh fixes from the user.

**UI (v17):** rooms are titled by the **name the host gives them** — the
Rooms list card and the room detail header show e.g. `food` instead of
`ROOM #66814` (only unnamed rooms fall back to `ROOM #<code>`; the code is
still what you share — the "waiting for more players" hint and the create
success message keep the code / quote the name). The randomizer's
challenge-elements grid is now **checkbox + category name only** (element
counts and the "optional" tag removed from the UI — counts still exist
server-side and drive the pool).

**UI (v18):** the Profile tab's **Save profile** button exchanges to
**Edit profile** after a *successful* save — the form fields lock while in
that state, and clicking **Edit profile** re-enables the form and restores
the **Save profile** label (no save fires from that click). Failed saves
leave the form in edit mode with the error shown. `renderAccount` always
ends in the editable state, so logging in / re-entering the tab resets the
toggle.

**UI (v19 — performance):** the app is now noticeably faster and more
responsive:
- **Instant view entry** — `startPolling` fires the first refresh
  immediately (rooms list / room detail render in ~30 ms instead of sitting
  blank up to 2.5 s).
- **WS-aware adaptive polling** — polling is the fallback clock: 2.5 s when
  the WebSocket is down, a 10 s safety net when it's live (the server
  already pushes every change). `rtChip()` reschedules the interval on
  every connection-state change.
- **Coalesced fetches** — `refreshRoomsList` / `refreshRoom` are
  busy/dirty coalesced: WS-event + poll bursts collapse to one in-flight
  fetch + one catch-up, never a storm.
- **Change-detected rendering** — both list and room render only when the
  payload actually changed (full-payload JSON key); unchanged polls do
  ZERO DOM work, so no flicker, no reflow, no hover/focus theft.
  `renderRoom` keeps the key in sync when actions render REST responses
  directly.
- **Login shows the Arena instantly** — `enterAccount` / the login handler
  call `show('arena')` before the profile tab's `/api/drawing-apps` fetch
  resolves (the profile fills in behind the main screen).

**UI (v20 — branding):** the header now shows the official Art Arena™
wordmark as **`/logo.png`** — the uploaded white-on-black logo converted
to the brand's pink→purple gradient (`#FF3CAC → #7B2CFF`, left-to-right,
luminance→alpha so the gothic anti-aliasing stays crisp), trimmed to the
content bounds. A 64×64 **`/favicon.png`** (the crowned "A", same gradient)
is wired up via `<link rel="icon">`. The old gradient-text `.brand` span is
gone; the image carries fixed 73×30 dimensions so the header never shifts.

**UI (v21 — login page per mockup):** the login screen was rebuilt to the
user's mockup: big centered gradient wordmark + **"WELCOME TO THE ARENA."**
tagline (gradient "ARENA."), **"Welcome back"** heading, gradient-border
icon fields (user / lock SVGs, eye ↔ eye-off password toggle now SVGs too),
right-aligned **Forgot password?**, full-width gradient **LOG IN** button,
**"Or continue with"** divider with circular **Google / Apple / Discord**
buttons, and the **Don't have an account? Sign up** line.
- Social buttons are honest for now: clicking shows a *"…sign-in is coming
  soon"* toast — real OAuth needs provider keys + redirect URLs and ships
  in a later phase.
- The top header is **hidden on all three auth screens** (login / register
  / forgot — the big centered logo is the branding there) and returns when
  logged in; the in-app header logo was bumped 30px → 38px ("a bit bigger").
- Register / forgot / reset forms reuse the same `.field` styling so the
  whole auth flow is visually consistent.

**UI (v22):** the login-page logo now has a **pink/purple glow** — two
layered `drop-shadow`s (pink + purple) with a slow 3.2 s `logo-glow` pulse
(`prefers-reduced-motion` disables the pulse). The in-app header logo was
sized up again, 38px → 46px (112×46).

**UI (v23 — outline glow):** per user preference the logo glow is now an
**outline** glow — a crisp 1–2 px pink rim (`drop-shadow 1px/2px`) with a
tight purple halo (the pulse only breathes the halo, the rim stays sharp).
The **outer login card** (`#view-login`) carries a matching pink/purple
outline glow (static). **Hover glow** added to the icon fields (`.field`)
and the **LOG IN** button; **`.social-btn` (Google/Apple/Discord) is
deliberately glow-free** (comment in the CSS marks the exclusion).

**UI (v24):** the logo's outline glow was **removed** — replaced with a
**gloss slide**: a soft diagonal light band (`.logo-gloss`) that sweeps
across the wordmark every ~4.5 s, masked to the letter shapes via
`mask-image: url('/logo.png')` (the PNG's alpha *is* the mask), so the
sheen only lives inside the letters. `prefers-reduced-motion` disables it.
The hover glows (`.field`, `.login-btn`) are now **smooth**: `transition:
box-shadow .45s ease` so they bloom in/out gently instead of snapping.

**UI (v25):** the gloss was **removed completely** (CSS + DOM element +
wrapper — nothing left). Hover interaction upgraded: the icon fields and
the **LOG IN** button now **rise 2px** (`translateY(-2px)`) alongside the
glow when hovered, and fields stay raised while focused; the rise eases
over 0.25 s (glow stays 0.45 s) so it feels like a gentle lift.

In Room Settings the host also gets a two-column checkbox grid —
icon + name per category (element counts were removed from the UI in v17),
color marked *optional* — with a live
"N elements · difficulty X" line; the choice is saved together with the time
and type settings. Non-hosts see a static list of the host's chosen elements.
Once the battle starts, the host gets a **🎲 Lock Challenge** button; on
lock, **both** players instantly see the **🔒 CHALLENGE LOCKED** box (one row
per element + the summary line) via the realtime event — and the room
payload (REST) carries the same `challenge` object, so polling and the live
layer can never disagree.

> **Testing:** `/tmp/randomizer_e2e.js` — 53 checks: pool API (8 categories,
> counts sum to `total`, auth gate), room setup, config guards (non-host 403,
> empty 400, unknown key 400, post-start 409), difficulty bands, start, lock
> guards (non-host 403, re-lock 409), challenge shape (exact chosen
> categories in display order, summary lists every value), **identical
> challenge for both participants** (REST + room payload), live
> `challenge_locked` delivery over WebSocket, private-room outsider blocked
> (GET 403 + WS subscribe denial). Ran 3× consecutive, 53/53 each. Plus
> `/tmp/phase5_regression.js` (10 checks — lobby list, ready/unready live
> events, ready guards) to confirm Phase 5 still holds. Both use throwaway
> users; external cleanup deletes `*_rnd_*`/`*_p5_*` users (plus their
> `battle_event_log` rows first — the audit FK is restrictive) and sweeps
> orphaned rooms.

**UI (v26):** the homepage was rebuilt from the user's mockup (`arena hp.png`) —
a mobile-style Arena home plus the app shell around it. Top bar: **hamburger**
(left) + a small 26px logo (center — hidden on the home itself, where the big
logo lives in the content) + a **notification bell** with its pink dot (right;
honest "all caught up" toast — real notifications are a later phase). The
hamburger opens a **slide-in drawer**: signed-in user (gradient avatar
initial, name, @username), the three main nav items (SVG line icons, active
one pink), the realtime LIVE/POLLING chip (moved in from the header), and
**Sign out**. The bottom nav was restyled to the mockup: SVG line icons,
uppercase micro-labels, pink active state with a short underline bar.

Homepage content: big gradient logo, "WELCOME TO THE ARENA." tagline (ARENA
underlined), three full-width action cards — **BATTLE** (crossed-swords icon →
Rooms), **JOIN ROOM** (new code-entry modal on the existing
`POST /api/rooms/:code/join`; success opens the room, bad code shows the
server's error inline), **CREATE ROOM** (→ Rooms with the create panel
already open). Below sits **LIVE BATTLES**: "VIEW ALL" link + the live strip —
pink LIVE badge, the featured (first live) room's players as avatar circles
with "VS" separators, "+N" counting the other live rooms, and "N battles live
now". "Live" = any non-ended room (lobby / starting / in_battle); with none
live the strip hides and a friendly empty state shows. The strip renders from
the **same coalesced, change-detected rooms-list fetch** as the Rooms view —
zero extra requests, and the home reuses the v19 machinery (immediate fetch
on entry, 10s safety-net poll when the WebSocket is live).

Server: `GET /api/rooms` now includes `player_names` per room (up to 3 active
players, ordered by seat, via `json_agg` so the pg driver returns a real JS
array — an earlier `text[]` form came back as a raw string and would have
crashed the strip; caught in the live DB check before release).

> **Testing:** `/tmp/v26_e2e.js` — 73 checks: parse-order integrity, v21 login
> mockup regression (10), login flow → homepage, home content (logo/tagline/3
> cards/labels/icons/chevrons), LIVE strip (badge, PE/MA avatars, VS, +1,
> "2 battles live now", chevron), bottom nav (3 SVG tabs, active follows view,
> header logo hidden on home / visible elsewhere), drawer (open/user block/
> nav routing/close via X/bell), card routing (battle→rooms with v17 named
> titles, create→panel open, join modal success + error + cancel), empty
> strip state, sign-out. All green. Regression battery re-run green: login 12,
> v15 time-modal 30, v17 naming 15, v18 profile 12, v19 perf 12 (check 2
> updated: total list fetches is now 2 — home strip + rooms entry — and ZERO
> extra in the 2.5s window with WS live), v20 branding 8, v21 login 37
> (header-logo check updated to the deliberate 26px bar logo). Live verification
> on the real DB: health ok, `/api/ui-version` → 26, served page byte-identical
> to disk, `player_names` array shape confirmed via a throwaway account
> (register→verify→login→list), then fully cleaned up (1 user / 2 rooms /
> 10,467 elements — pennypops' #66814 "gh" and #77560 "my arena" untouched,
> outbox reset to `[]`).

**UI (v27):** both logos are now **dead-center** (user request: "make the logo
aligned to the center"). Two mechanisms were fragile and could render the
logo off-center depending on browser: (1) the **header logo** sat in a
`flex:1` middle region that split the *leftover* space evenly — not the same
as centered when the hamburger and bell buttons differ in width; it now sits
in a **`1fr / auto / 1fr` CSS grid** center track (hamburger `justify-self:
start`, bell `end`), so it is exactly centered regardless of the side buttons.
(2) the **homepage logo** used `width:fit-content` + `margin:auto` with the
img sized at `min(352px, 84%)` of that shrink-to-fit box — a percentage-of-fit
cycle; the wrapper is now `display:flex; justify-content:center` with the img
capped at `min(352px, 100%)` of the wrapper. Pure CSS; no JS touched.

> **Testing:** `/tmp/v27_e2e.js` — 17 checks (version trio, grid + justify-self
> rules, flex centering rule, old `fit-content`/`84%` rules gone, header/home/
> drawer/login logos present, no jsdom errors). Full battery re-run green:
> v26 73, v27 17, login 12, v15 30, v17 15, v18 12, v19 12, v20 8, v21 37
> (216 total).
>
> **Harness bug found while verifying (app was innocent):** with the dev
> server running, jsdom's *built-in* WebSocket client let the test page
> `rtConnect()` to the LIVE `:3000` server using the fake test token; the
> server correctly rejected it (`ws rejected: bad/expired session`), and the
> app correctly signed the fake session out mid-test — 7 v26 checks failed.
> Fix: suites that don't stub WebSocket now set `window.WebSocket = undefined`
> in `beforeParse`. Server logs showed the rejections, which is what made the
> diagnosis obvious.
>
> **Bugs the e2e caught (all fixed):** (1) the state-machine walk used a
> stale status snapshot, skipping `locked` and tripping the trigger
> (`ready → randomizing` illegal); (2) `summary` was block-scoped inside the
> transaction try-block but referenced after COMMIT for the realtime emit —
> the challenge committed yet the client got a 500; (3) the Phase 5
> first-frame race (see note in the Phase 5 section).

**UI (v28):** real **“Continue with Google”** sign-in — production Google
OAuth 2.0 (Authorization Code + PKCE/S256), built directly on the existing
auth architecture (no new framework, no Supabase — this project has its own
Postgres session system). Implementation lives in `google-auth.js` (mounted
at `/api/auth/google`), reusing the same `sessions` table + cookie as
password login, the same transactional user-creation recipe as
`/api/auth/register`, and the existing `auth_tokens` table for the one-time
redirect-home token (purpose `oauth_handoff`, SHA-256 hash only, single-use,
5-minute TTL). The schema reuses the pre-existing `user_platform_accounts`
extension point (new `external_email` column + partial unique index
`uq_platform_account_active` → one Google account can link to exactly ONE
Art Arena user). Account rules: existing Google link → sign in; Google-
verified email matching an existing account → **link, don't duplicate**;
otherwise a new user is created (username from the email local part,
unusable random password hash, email marked verified when Google says so).

Flow: button click → full-page `GET /api/auth/google` (server assembles the
consent URL; PKCE verifier + single-use state kept server-side) → Google
consent → `GET /api/auth/google/callback` (state checked, code exchanged
server-side WITH the client secret, profile fetched, user resolved, normal
Art Arena session minted) → `302` home with the one-time token in the **URL
hash** (`#aa-google=ok&h=<token>` — never the query string, never the
server, never the logs) → the SPA posts it to `POST /api/auth/google/complete`
(single-use claim) and receives the same `fullUser + session_token` payload
as a normal login. Failures/cancel/denial at every step redirect home with
`#aa-google=error&reason=…` and the login screen explains it. The button is
only **armed** when `GET /api/auth/google/status` reports real credentials —
unconfigured deployments keep the honest “coming soon” state (no mock login,
ever). Apple/Discord buttons unchanged (honest “coming soon”).

Security: `GOOGLE_CLIENT_SECRET` exists only in `process.env`
(`server/.env`); it is never in the DB, browser, API responses, or logs
(the token-exchange error path sanitizes before logging). The browser only
ever talks to our own `/api/auth/google/*` routes. PKCE is mandatory per
Google's 2025 policy and is implemented.

**Google Cloud Console values (exact):**

- **Authorized JavaScript origins:** `https://arena.ai`
- **Authorized redirect URIs:**
  - `https://arena.ai/api/auth/google/callback` (production)
  - `https://3000-<sandbox-id>.e2b.app/api/auth/google/callback` (this dev
    sandbox — the server derives the redirect URI from the incoming Host
    header, so every host you list works; current sandbox id
    `iez5rmcl24tmwuv4thu16`)

**Environment (`server/.env`):** `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET` (entered via the platform's secrets system — never in
code), optional `GOOGLE_REDIRECT_URI` to pin one URI instead of the
Host-derived default. The boot log prints a configured/not-configured flag
(never the secret).

> **Testing:** `/tmp/v28_google_e2e.js` — 24 checks (jsdom, fetch-stubbed,
> `WebSocket=undefined`: version trio, button arming both states, click
> navigation, handoff exchange → signed in + hash stripped + welcome toast,
> error hash → graceful login message, apple “coming soon” preserved,
> password login, bottom nav, home cards, drawer).
> `/tmp/v28_google_http.js` — 20 checks (real server instance on :3999 with
> throwaway credentials: exact `redirect_uri` for Host `arena.ai` AND the
> sandbox host, PKCE S256 + state + scopes, bad-state/cancelled/missing-param
> error redirects, REAL token exchange against Google rejecting the
> throwaway client cleanly, single-use state replay rejected, bogus handoff
> 400, and secret hygiene across all responses + server logs). Live smoke:
> register→login→/me→profile→room→logout all green on the running server,
> throwaway account fully removed (users=1 / rooms=2 / elements=10467).

**UI (v29):** the Profile tab was rebuilt from the user's mockup
(`uploads/image-1.png`) and the app gained a **back button throughout**:

- **Profile page (mockup layout, real data only).** Circular avatar (the
  user's own initial on the brand gradient when no photo is set — never a
  placeholder image) with a 📷 chip, name + @username + verified badge +
  email, a **✏️ Edit Profile** pill, a 4-column stats card
  (**Battles / Wins / Losses / Draws** — `RATING n · STREAK n` line under),
  and two list rows: **Battle History** and **Saved Artworks**. Per the
  request, the mockup's **Level, XP bar, and Ranking column were NOT
  added**, and the always-visible save-profile form now lives behind the
  **Edit Profile** pill (same existing form — display name, bio, country,
  drawing app, discoverable — with the original Save/Edit lock behavior).
- **Profile picture from the device.** `#avatar-btn` opens the native file
  picker (`accept=image/png,image/jpeg,image/webp`); the selection is a
  multipart `POST /api/account/avatar` (multer 2.3.0, memory storage, 5 MB
  cap). The server **sniffs the real bytes** (PNG/JPEG/RIFF-WEBP magic
  numbers — the file extension and Content-Type are never trusted), stores
  `server/avatars/<user-uuid>.<ext>` (atomic `.tmp` + rename, old file
  unlinked), updates the pre-existing `user_profiles.avatar_storage_key`
  column (no schema change), and serves it from the new
  `GET /avatars/…` static mount (1-day max-age). `DELETE /api/account/avatar`
  removes the file + column (idempotent). `GET /api/auth/me` now includes
  `profile.avatar_url` so every screen (profile card + hamburger drawer)
  stays in sync.
- **Battle History + Saved Artworks are real views, not placeholders.**
  `GET /api/account/battles` (battle_participants ⋈ battles ⋈ battle_rooms,
  newest first, 50) and `GET /api/account/artworks` (submissions ⋈ battles ⋈
  battle_rooms, newest first, 50). Both show an **honest empty state**
  today — the Phase 7 battle engine populates them as real battles happen.
  `TAB_CHILDREN` maps both under the Profile tab; the header back button
  returns to Profile from either.
- **Back button throughout.** A chevron sits left of the hamburger
  (`#btn-back`, `.nav-left` group) and is visible on **every non-home view**:
  rooms/room/quickmatch/findartist/grandarena/community → Arena;
  battlehistory/savedartworks → Profile. Arena (home) hides it — it IS the
  home. Driven by one `BACK_TARGETS` map in `show()`; the old per-view
  "← Rooms" / "← Arena" text links were removed (the auth screens keep
  "← Back to log in" since they have no header).

> **Testing:** `/tmp/v29_profile_ui.js` — 44 checks (jsdom, fetch-stubbed,
> `WebSocket=undefined`, auth-aware `/api/auth/me` stub): version trio,
> returning-user boot → arena; profile page real data (name/email/verified/
> 4 stats/rating line), NO Level/XP/Ranking anywhere on the page; Edit
> Profile toggle; device avatar upload (FormData POST → img in profile +
> drawer) and remove; Battle History + Saved Artworks empty states AND
> 1-row renders; back button hidden on home / correct target on
> profile/battlehistory/community; regressions (3 tabs, drawer, home cards,
> rooms list, login flow, google coming-soon + armed-redirect states). All
> green. Live HTTP smoke (throwaway account, fully removed afterwards):
> avatar upload → byte-identical serve from `/avatars/`, `me.avatar_url`,
> fake-file 400, 5 MB+1 byte → "Image must be 5 MB or smaller.", delete →
> null + file gone, battles/artworks empty arrays, unauthenticated upload 401.
> DB verified back to users=1 / rooms=1 / 10,467 elements.

**UI (v30):** profile polish from user feedback on v29 (all changes are
frontend; the API still returns the full stats payload, the UI simply no
longer renders the removed items):

- **Stats card is 3 columns now — Battles / Wins / Losses.** The `Draws`
  column and the `RATING n · STREAK n` line under it were removed per
  request. Grid `repeat(4,1fr)` → `repeat(3,1fr)`; `#stat-draws` /
  `#stat-ratingline` deleted (no stale refs).
- **App iconography (no more emojis) on the profile controls.** The
  `✏️ Edit Profile` pill now leads with the app's line-icon-style pencil SVG
  (`stroke=currentColor`, matching the nav/list icon set) and the label
  swaps in its own `<span>` so the toggle never wipes the icon; the avatar's
  `📷` chip is now a line-icon camera SVG on the same purple roundel.
- **Verified = a small green circle with a white tick, shown ONLY for
  verified emails.** The old text badge ("✓ email verified" / "⚠ email not
  verified") is gone — `renderAccount` now just toggles the
  `.verified-tick` span's `hidden` on `user.email_verified`. Unverified users
  see nothing (the existing verify banner still handles that flow).
- **Full email on the profile header.** The email previously lived only
  inside the Edit Profile panel; it's now a `.prof-email` line in the
  profile header (name / @username / **email**) with
  `overflow-wrap:anywhere` so long addresses wrap instead of clipping.
  The duplicate line inside the edit panel was removed (one source).
- **Back button before the dashboard (menu) button.** The header's
  `.nav-left` order is `[back chevron][hamburger]` (verified in-DOM, no CSS
  `order`/`row-reverse` anywhere); the gap between the two was widened
  2px → 8px so the back arrow reads clearly as the first control.
- **Messages are momentary.** `msg()` now clears itself **3 s** after
  showing (per-element `clearTimeout` re-arm), so save/upload success and
  error notes never sit forever — applies to every `msg()` target
  (profile, login, rooms, verify).
- **Profile card carries the login glow.** `#view-account` gets the exact
  same `border-color` + `box-shadow` pink/purple glow as `#view-login`
  (the "large background card" of the profile page is the `.view` card
  itself).

> **Testing:** `/tmp/v30_profile_ui.js` — 44 checks (jsdom, fetch-stubbed,
> `WebSocket=undefined`, auth-aware `/api/auth/me`): version trio (30),
> full email in header (and NOT in the edit panel), green tick circle with
> no text (verified) / hidden (unverified scenario), 3-col stats with
> draws + rating/streak elements absent, NO Level/XP/Ranking/Draws/RATING/
> STREAK anywhere on the page, pencil + camera SVGs (no emojis), back
> before menu in-DOM, profile glow === login glow (computed styles), Edit
> Profile toggle keeps the icon, device avatar upload + remove, msg
> auto-dismiss after ~3s, Battle History / Saved Artworks empty + 1-row
> renders, back-button routing, regressions (3 tabs, drawer, home cards,
> rooms, login flow, google coming-soon). All green. Served page
> byte-identical to disk through the public tunnel.

**UI (v31):** second round of profile feedback (frontend + one data change):

- **Header buttons swapped** per explicit request ("switch their position"):
  the menu/dashboard (hamburger) button now comes **first**, the back
  chevron **second** — the `.nav-left` DOM order is `[#btn-menu][#btn-back]`
  (back still toggles hidden per view via `show()`).
- **Button outlines pink, not purple.** `button.secondary`, `.toast`, and
  the profile's `.edit-profile` pill all moved from `border:1px solid
  var(--purple)` to `var(--pink)` — no `border:1px solid var(--purple)`
  rules remain anywhere in the sheet.
- **Email removed from the profile header.** The `.prof-email` line added in
  v30 is gone (element + CSS + the `renderAccount` assignment) — the profile
  header is now name + verified tick / @username / Edit Profile. The email
  is untouched in the DB.
- **Username corrected (data).** The live account's `users.username` was
  renamed `pencldesigner` → **`peniel`** (its display name, the name the
  user wanted) so the `@username` line matches. One-row `UPDATE` on the
  user's own account at their request; the Google platform link is keyed by
  user id + external sub (not the username), so Google sign-in is
  unaffected. Room host lines / drawer now show `@peniel`.

> **Testing:** `/tmp/v31_profile_ui.js` — 45 checks (jsdom, fetch-stubbed,
> `WebSocket=undefined`): version trio (31), header order menu→back, no
> purple `border:1px solid var(--purple)` rules (pink on secondary/toast/
> edit-profile), email absent from the profile header, all v30 profile
> checks carried over (3-col stats, tick circle, pencil/camera SVGs, glow,
> msg auto-dismiss, avatar upload/remove, history/artworks, back routing,
> regressions, unverified scenario, login flow). All green. Live: served
> page byte-identical to disk local + through the public tunnel; DB row
> verified `peniel | peniel | pencldesigner@gmail.com`.

## v46 — theme & matchmaking pass (login theme, Apple icon, logout theme, count-up timer, Line Ripple home)

Client (`server/public/index.html`, v46 + NEW `line-ripple.js`):
- **Login page follows the theme** — the full-viewport auth backdrop (`#login-bg`)
  was hardcoded dark `#070115`; it now uses `--auth-page-bg` (dark `#070115`,
  light `#f5f2fa`). Card, text, inputs, buttons and icons were already
  token-driven from v45; the backdrop completes the page.
- **Dark chrome tokens REPAIRED (v45 regression)** — v45 accidentally wrote
  the dark `:root` tokens (`--header-bg/--nav-bg/--scrim*/--ok|warn|danger|info
  |canvas-*`) as self-references, which are CSS cycles → invalid at computed
  value time, silently turning dark-mode header glass, nav, scrims and status
  tints transparent. Restored with the exact v44 dark literals.
- **Apple icon visibility** — Apple is `currentColor` on `--icon-strong`
  (white on dark, `#241a3d` on light); Discord keeps brand blurple `#5865F2`
  and Google stays multicolor — all readable in both themes.
- **Theme preserved across logout** — logout never touches `aa-theme`; the
  pre-paint `<head>` script applies the theme before first render, so the
  login page comes up in the user's theme with no wrong-theme flash.
- **Settings is the dedicated page** — routed `#view-settings` (drawer +
  Profile row); the Appearance (Dark/Light) controls live THERE, Profile has
  none. Verified by battery.
- **Matchmaking timer counts UP** — `00:00 → 00:01 → …` elapsed search time
  (still anchored to the server's `queued_at`, so a refresh cannot lie); it
  freezes when an opponent is found / the search is cancelled, and shows
  `03:00` only when the 3-minute window genuinely expires. No countdown.
- **Homepage Line Ripple background** — vanilla port of the user-supplied
  Originkit component (`line-ripple.js`): same seeded-noise curl physics and
  grid math, one instance, stroke themed in place (dark `#EA69F1`, light
  `#F200FF`), mounted only while the home view + session are active and
  disposed on leave — exactly one background animation ever runs. The light
  version's page background rides the app's `--bg` (identical `#09070d` in
  dark; the light paper in light) so it can never seam.
- **Dead code removed** — `arch-corridor.js` + `vendor/three.min.js` were
  unreferenced since v45's globe removal; both deleted (~600 KB less per
  cold load).

Verified: `e2e/v46-browser` 43/43 (the 10-point list + dark-token regression
guard), `v45-browser` 33/33, `v44-browser` 27/27, `v44` node 50/50,
`regress` 20/20.

## v45 — 5 reported issues (schema heal, matchmaking visual, Settings page, Light Mode, login linger)

Server (`server/`):
- **Schema self-heal at boot (the `deleted_at` failure)** — `MIGRATION_STEPS`: an
  idempotent, ordered ladder where the v45 sweeps (orphaned seats/spectators,
  duplicate active seats, duplicate results) run BEFORE the v44 DDL, so a
  pre-v44 database heals instead of crashing on `deleted_at`. Every step is
  individually guarded; failures are never hidden — `/api/health` gains a
  `schema` field (`"ok"` | `"incomplete: …"`) and the boot log points at the
  remediation. Additive only: production data is never wiped.
  **`migrations-v45.sql` (NEW)** mirrors the ladder for manual psql runs.

Client (`server/public/index.html`, v45):
- **Matchmaking planet → searching LINE** — globe, scanner, `d3.min.js` and
  `land.json` fully removed (files deleted from the repo). A pure-CSS line
  runs between the two player slots: `#mm-link` with `data-mode`
  `off`/`search`/`connected`; on match it locks solid green. No network
  requests to dead scripts.
- **Settings is its own page** — routed `#view-settings` with back nav,
  reachable from the drawer and a Profile row. The edit form and logout moved
  there; Profile stays profile-focused; save verified end-to-end via API.
- **Light Mode completed via tokens** — one palette swap (`:root` +
  `html[data-theme="light"]`): header/nav/scrims, canvas families, icon
  colors. White brand icons (Apple) adapt via `currentColor` /
  `--icon-strong`; auth cards via the new `--auth-card`. Dark remains the
  default.
- **Login no longer lingers** — `enterAccount()` renders the homepage the
  instant authentication exists and fetches the profile behind it (measured
  ~0.4 s login→homepage, no flicker); a rejected session still bounces back
  to login with a clear message.

Verified: `e2e/v45-browser` 33/33 (the 10-point list), `v44-browser` 27/27,
`v44` node 50/50, `regress` 20/20; publish rehearsal — patch applies onto
`f4e885e` with a bit-identical tree, boots `MIGRATE v44/v45: schema verified
OK`, `/api/health` → `"schema":"ok"`, two-user matchmaking matches.

## v44 — 10-item feature + integrity pass (battle lifecycle completion)

Server (`server/`):
- **battle-end.js (NEW)** — `finishBattleIfDue(battleId)`: one transaction walks an
  expired `active` battle through the DB's legal edges to `complete`, records
  `battle_results` (no votes → honest draw, winner NULL), stamps participant
  outcomes, bumps `user_statistics` INSIDE the same tx (exactly-once — refreshes
  can never re-count), ends the room and releases every seat. A 1s sweeper +
  read-path self-heal mean no client can ever see a stale `active` battle.
- **One active room/match per artist (server-enforced)** — partial unique index
  `uq_one_active_seat_per_user` on `room_participants(user_id) WHERE state IN
  ('waiting','ready')`; create/join/matchmaking guards return friendly 409s.
  Two racing tabs/devices still cannot double-seat (DB has the final word).
- **Rematch (request → accept/decline)** — `rematch_requests` table (+ one
  PENDING per room index). Only ACCEPT starts anything: it re-seats both
  artists, reopens the room, and runs the SAME start core → new `battles` row +
  NEW locked challenge + countdown. History/results/stats untouched.
- **Room deletion = archive when history exists** — `battle_rooms.deleted_at`;
  archived rooms vanish from lists/lookups while battles, results, stats and
  submissions survive. Empty rooms hard-delete (with explicit dependent deletes
  — this schema has no FK cascades). Host-only, live battles block, confirm
  modal explains exactly what will happen.
- **Randomizer integrity** — dedupe + `uq_one_challenge_per_battle`: a battle can
  ever hold exactly ONE challenge row; `/start` was already race-safe
  (FOR UPDATE + status re-check).
- **Stats exactly-once** — `uq_one_result_per_battle` unique index as DB-level
  insurance on top of the single-tx bump.
- **Schema repairs (discovered en route)** — the original dump shipped without
  PRIMARY KEYS (46 tables!). v44 restores `battle_rooms` + `users` PKs (needed
  by the new constraints/indexes), adds a `code` lookup index, and sweeps
  orphaned seat rows left by pre-v44 room deletes (they blocked the seat guard).
- **Mail (provider seam was already in place)** — every mail now also carries a
  branded dark-theme HTML template (inline styles, email-safe tables, plain-text
  twin). Provider recommendation: **Resend** (see `.env.example`); Postmark
  stays a drop-in alternative. Keys only ever in `.env`; dev outbox unchanged.

Client (`server/public/index.html`, v44):
- **Appearance setting** — Dark stays the default Art Arena theme; Light is an
  intentional opt-in (soft lilac paper, same pink→purple brand accents, light
  status tints — NOT an invert). Persisted in localStorage, applied pre-paint
  (no flash), control lives in Edit Profile.
- **Fresh-tab fix** — `init()` no longer calls `/api/auth/me` when no session
  token exists (a brand-new visitor can never be told "Your session has
  ended"); the login backdrop now arms a retry if its effect script lost the
  race with the app script.
- **Post-battle panel** — honest outcome (VICTORY / DEFEAT / DRAW / ended),
  REQUEST REMATCH with live request/accept/decline/cancel states, and LEAVE
  CURRENT ROOM (clean exit; releases the one-room seat; history untouched).
- **Go Live (coming soon)** — a button in the battle card, visible only while a
  battle runs. Says plainly that livestreaming is on the roadmap; no LIVE tab,
  no streaming infrastructure.
- Delete confirm modal copy now reflects archive-vs-delete truthfully.

## v43 — bug-fix pass (5 reported issues, all verified in a real browser)

1. **Matchmaking timer ("Battle" showed an instant failure instead of counting
   down).** Root cause was a STATE bug, not the clock: the account was still
   seated in a leftover lobby room, and the matchmaking guard
   (`activeRoomOf`) rejects `/api/matchmaking/enter` with 409 — the client's
   `fail()` then painted "Could Not Find Player" with the timer frozen at
   0:00, which reads like a connection failure. Fixes: the stale seat was
   released with the app's own host-leave semantics (participant → `left`,
   empty room → `ended`), and a 409 room-conflict now shows the honest
   headline **"Already In A Room"** (the sub-line names the room conflict).
   With a clear account the 3:00 deadline timer counts down correctly
   (verified: 2:56 → 2:53).
2. **Ready state ("Continue with…" options were showing around Ready).** The
   v42 flow asked "Continue with [App]?" on the way INTO Ready. Inverted per
   request: **READY is now instant** (the canvas is already picked and shown
   as the seat chip; picking an app and pressing CONTINUE also sets Ready
   directly), **nothing extra shows while in the Ready state**, and the
   "Continue with [App]? / Change App" options appear **only when you click
   CANCEL READY**. Also fixed in the same flow: the canvas step's commits now
   call the API directly instead of `roomAction`, so the normal matchmaking
   auto-start races no longer flash "The battle has already started." /
   "Waiting for all players…" error banners (the known-benign 409 is handled
   as the success it is; manual host starts keep their honest messages).
3. **Room hashtag lingering.** An ended/closed room kept every seated
   player's row in `waiting`, so the room (its `ROOM #code` card) never left
   their Rooms list — and `/leave` 409'd in ended rooms ("The battle has
   already started."), a dead end for non-hosts. Fixes (`rooms.js`):
   ending a room (close, host-leave-empties) now marks all active
   participants `left` (the card disappears for everyone live), and
   `/leave` is allowed in ended rooms as an escape hatch for pre-fix rows.
   The host still sees ended rooms (delete affordance) — unchanged.
4. **The blue dots were wrong.** v42 spawned them across the whole
   matchmaking card and they accumulated into a field. Now
   (`mm-scan-wrap.js` + the canvas moved inside `#mm-globe-layer`): ONE
   light-blue beacon at a time **on the planet** (rejection-sampled inside
   the globe circle), each new dot retires the previous (quick fade), and on
   "Found Player" the current dot stops and turns light green on the planet.
   Pixel-verified: every painted pixel inside the planet circle, spread ≈ a
   single dot, centroid hopping across the globe over time.
5. **Profiles touching the planet.** The stage's 460px max-width + a 300px
   globe + 96px avatar circles guaranteed overlap (~43px at every width).
   The slots are now pinned to the stage edges (`space-between`) and the
   planet is sized per viewport tier (240/170/160/110/96/80px; slots narrow
   to 130px ≤560px) — verified zero overlap from 360px to 900px viewports
   (gaps +3…+58px).

> **Testing:** every fix reproduced FIRST in a real headless browser
> (Puppeteer, two concurrent users, real WebSocket + poll), then re-verified
> after the fix, plus a 20-check regression battery (all green): profile
> edit persists, manual room chain (create → join → canvas → ready/cancel →
> start → identical locked challenge → 3-2-1 → active → ticking battle
> clock 19:56 → 19:53), matchmaking pair flow (both reach ACTIVE with zero
> error banners), spectate / close / delete / guards. Throwaway `@t.local`
> accounts fully removed afterwards (users=1, rooms=1 ended "my arena",
> elements=10,467).

## v32 — camera in the profile picture space (revert + big camera)

User requests: (1) **revert the username** — the v31 rename to
`peniel` was wrong: "i was wrong so undo that". DB-only fix:
`UPDATE users SET username='pencldesigner'`; the display name stays
`peniel` (the part the user ticked off). (2) **profile picture space**:
first pass added a 15px camera under the initial ("in the apps
iconography"), but the user saw a stray "Profile picture" string in the
circle and asked to "remove the profile picture in that space and make
the camera bigger — almost as big as the space but small enough for the
full camera to be seen."

**Final design (no photo set):**
- `#avatar-cam` — one **54×54 app-style camera line icon**, centred in
  the 88px circle (`.prof-ava-cam { position:absolute; inset:0; display:flex;
  align-items:center; justify-content:center }`). 17px margin every side →
  the whole camera is visible while nearly filling the space. The initial
  and the corner chip are hidden while the big camera shows (it IS the
  affordance).
- **No label text:** the `<img>` alt is now `""` — the "Profile picture"
  string in the user's screenshot was the alt of a *broken* image (the
  avatar file was lost to a sandbox reset; `avatar_storage_key` was cleared
  to NULL alongside the restore, so the UI shows the clean camera state
  and the user re-uploads).
- **Photo set:** photo fills the circle, the small purple corner chip
  (`#avatar-chip`) returns as the change-photo affordance, pink ✕ removes.
  `applyAvatar(url)` toggles cam / chip / initial / remove in both branches.

**Environment note:** a hard sandbox reset landed mid-turn (new sandbox
id, Postgres + node_modules + /tmp wiped, processes dead). Recovered via
`tools/recover.sh`, re-applied the username revert, cleared the stale
avatar key, re-downloaded cloudflared, and started a **new** quick tunnel
(`carnival-isa-handmade-abu.trycloudflare.com` at the time of writing).
The old hostname kept answering from the dying old sandbox — it is NOT
the live build; the Google Cloud dev callback must point at the new
hostname and the user signs in again there.

**Version:** trio 31→32 (meta, console log, badge). Served page
byte-identical to disk; `/api/ui-version` → `{"ui":"32"}`.

> **Testing:** `/tmp/v32_profile_ui.js` — 38 checks (jsdom, fetch-stubbed,
> `WebSocket=undefined`): returning-user boot, big-camera state (visible,
> 54×54, inside `#avatar-btn`, initial/chip/✕ hidden, no "Profile
> picture" text, empty alt, absolute-inset CSS not column stack), upload
> flow (POST recorded, photo shown, cam hidden / chip + ✕ shown, toast,
> drawer img), delete flow (DELETE recorded, big camera restored, drawer
> initial, toast), v31 regressions (no email, pencil button, stats,
> menu→back order, pink outlines), version trio 32, upgrade banner stays
> hidden across the 3s guard tick. All green. DB row verified
> `pencldesigner | peniel | pencldesigner@gmail.com` with
> `avatar_storage_key` NULL; backup re-dumped (`art_arena_20260829_2245.sql`).

## Session channels (why the token travels three ways)

The preview is viewed **embedded in an iframe** behind a chain of proxies
(browser → platform proxy → E2B traffic proxy → app). Two session channels
have silently failed in that chain:

1. **Cookies** — browsers partition/block cookies in cross-site iframes.
2. **`Authorization` header** — the preview proxy chain strips it (proven by
   symptoms: login 200, every authenticated follow-up 401 "no session token
   sent by client", while the session row in Postgres stayed perfectly valid).

The **query string provably survives the whole chain** (the dev-inbox feature
has always worked: `GET /api/dev/outbox?to=<email>` reaches the server from
the embedded preview with its query intact).

So the client sends the session token on every authenticated request via all
three channels, and the server checks them in order:

| Priority | Channel | Notes |
|---|---|---|
| 1 | `Authorization: Bearer <token>` | Standard; works in top-level tabs, curl, native clients. |
| 2 | `arena_session` cookie | `HttpOnly`, set at login. |
| 3 | `?arena_token=<token>` | The embedded-preview workhorse. |

The dev request log records which channel carried the token
(`[token via header|cookie|query|-]`), and `maskToken()` guarantees the token
never appears verbatim in logs or error output.

> Hardening note for production: JS-accessible tokens (header or query) are a
> weaker XSS posture than cookie-only auth. If you want cookie-only, drop
> `out.session_token` from the login response and the `arena_token` append in
> `public/index.html` — the server keeps accepting all three channels either
> way. The query channel also exposes the token in URLs (proxy/server logs),
> so treat it as a dev-preview accommodation, not a production pattern.

> Hardening note for production: the Bearer token is accessible to JS. If
> you want cookie-only auth (stronger XSS posture), remove
> `out.session_token` from the login response and drop the header logic —
> the server keeps accepting the cookie either way.

> **Stale-page guard:** `index.html` is served with `Cache-Control: no-store`
> so the preview never runs old session logic. A cached pre-Bearer page is
> the classic source of phantom "Not authenticated" errors that don't
> reproduce server-side.

## Email architecture (provider swap lives in `mail.js`)

All email delivery lives in **`server/mail.js`** — the single abstraction
point. The auth flow only ever calls `await sendEmail(user, subject, token, kind)`
and knows **nothing** about providers. Provider choice is pure environment:

| `MAIL_PROVIDER` | Transport | Requires |
|---|---|---|
| *(unset in dev)* → `dev` | Simulated mailbox `dev-outbox.json`, read via `GET /api/dev/outbox?to=<email>` (the 📬 buttons in the UI) | nothing |
| `resend` | [Resend](https://resend.com) REST API | `RESEND_API_KEY` |
| `postmark` | [Postmark](https://postmarkapp.com) Send Message API | `POSTMARK_SERVER_TOKEN` |

**Going to production (Resend or Postmark) = edit `.env` only** — zero
auth-flow changes:

```
NODE_ENV=production
MAIL_PROVIDER=resend              # or: postmark
RESEND_API_KEY=re_xxxx            # or: POSTMARK_SERVER_TOKEN=xxxx
MAIL_FROM=Art Arena <noreply@yourdomain.com>
```

Guards baked in:

- The server **fails fast at startup** if production would run without a
  working provider (a server that can't deliver codes must never start), and
  `MAIL_PROVIDER=dev` is rejected when `NODE_ENV=production`.
- Delivery failures **throw** — register/forgot then fails loudly instead of
  silently stranding a user without their code. The account row survives
  (email is sent after the transaction commits), so recovery is always
  possible: log in (login is not gated on verification) and tap **Resend**.
- Code lifetimes are a single source of truth in `mail.js` (`TTL_HOURS`):
  verification 24h, reset 1h — the DB expiry and the email text can never
  drift apart.

One-time codes (verification, reset) are **only ever in the email** (or the
dev outbox entry) — never in any API response, never on any form. The
`/api/dev/outbox` endpoint is disabled entirely when `NODE_ENV=production`.

## Running it

```bash
cd art-arena/server
npm install
npm start          # node --env-file=.env server.js  →  http://0.0.0.0:3000
```

Database: PostgreSQL `art_arena` (foundation schema from `../schema/`),
accessed as the least-privilege role `art_arena_app` (DML only — no DDL,
no superuser). Connection details in `.env` (dev sandbox only).

## Security posture (foundation rules from the spec)

- Passwords: bcrypt cost 12; only hashes ever touch the database.
- One-time tokens: 256-bit random; only SHA-256 hashes stored; purpose-scoped;
  one-time; expiry enforced in SQL (`expires_at > now()`).
- **Codes travel only through email** — never in responses, never on forms.
- Sessions: server-side only; the client holds an opaque token. The server
  decides who is logged in on every request (expiry + revocation + account
  status checked per request).
- Login responses never reveal whether an email/username exists.
- `art_arena_app` DB role: `SELECT/INSERT/UPDATE/DELETE` only — no DDL.

## Rebuilding this environment (sandbox resets)

**One-command recovery (preferred):** the platform recycles this sandbox from
time to time (Postgres + node_modules vanish; files under `/home/user`
survive). The database is backed up to `../backups/latest.sql` (re-dump any
time with `sudo -u postgres pg_dump art_arena > ../backups/latest.sql`), and
`tools/recover.sh` restores everything — Postgres, the full saved DB (users,
Google links, rooms, sessions, 10,467-element pool), the app role, and node
deps:

```bash
/home/user/art-arena/tools/recover.sh   # then: cd server && npm start
# public link (if needed): cloudflared tunnel --url http://127.0.0.1:3000 --no-autoupdate
```

Recovery procedure validated by actually restoring the live DB. NOTE: after a
reset the sandbox ID changes, so the e2b preview URL AND the quick-tunnel
hostname both get new values — the Google Cloud dev redirect URI must be
updated to match (the server derives it from the Host header automatically).
The manual procedure below is the fallback if the backup is missing:

If the sandbox is reset, in order:

```bash
# 1. PostgreSQL
sudo apt-get update -qq
sudo apt-get install -y -qq postgresql postgresql-contrib
sudo pg_ctlcluster 17 main start
sudo -u postgres createdb art_arena
cp server/schema.sql /tmp/ && chmod 644 /tmp/schema.sql
sudo -u postgres psql -v ON_ERROR_STOP=1 -d art_arena -f /tmp/schema.sql
# 2. App role (or reuse credentials from .env)
#    NOTE: run GRANTs with `-d art_arena` (running against the default
#    `postgres` db is a silent no-op — this bit us once).
sudo -u postgres psql -c "CREATE ROLE art_arena_app LOGIN PASSWORD '<pw from .env>'"
sudo -u postgres psql -d art_arena \
  -c "GRANT CONNECT ON DATABASE art_arena TO art_arena_app" \
  -c "GRANT USAGE ON SCHEMA public TO art_arena_app" \
  -c "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO art_arena_app" \
  -c "GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO art_arena_app"
# 3. Server
cd art-arena/server && npm install && npm start
```
