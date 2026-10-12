# v74 — MANGA SETTINGS FIX · REFERENCE CHAT PAGE · PREMIUM CHAT CUSTOMIZATION

Base: `76b2098` + uncommitted Community/v73 work (21-suite battery green before this task).
Result: **24/24 suites green** (21 pre-existing + `chat-core` + `_shot-chat-v74` + `_shot-settings-v74`).
Commits (approved, on `main`, author pencldesigner7 — **not pushed**; delivered as
`/home/user/art-arena-v74.bundle`, range `76b2098..main`):
`9302d5f` (Community phases 1–6, v73 polish, v74 core) → `ffc8e98` (v69 header circles on hover)
→ `64a74ca` (v70 composer refinement) → `ba3e97c` (battery-stability fixes, §9b below)
→ `5d329a1` (v75 composer correction, §9c below).
→ `fbcdf81` (v76 composer shape + tool placement, §9d below).
→ `9ca1b8a` (v77 back button, strokes, message actions, §9e below).

---

## 1. Root cause of the Manga Settings background issue

The Settings theme cards render each preset as a `.swatch-logo.sl-<key>` container whose
**background** is hard-coded per theme in `premium-themes.css`
(`.theme-swatch .swatch-logo.sl-comic { background:#ffb500 url('/themes/comic/background.jpg') … }`),
while the v73 logo-sync in `applyThemeLogo()` only swapped the **logo `<img src>`** to the Manga
wordmark. The two visuals therefore desynchronized: with the Manga finish active the Comic card
showed the Manga wordmark sitting on the Comic orange burst, and Chrome/Gold had the same latent
mismatch (gold wordmark on the silver gradient). The page-level ambient scene and app-wide
variables *did* follow the finish — only the card pairing was broken, which is exactly the
"logo changes but the background does not" symptom.

**Fix (not a CSS override of one symptom):** a single sync point — `pthSyncSwatchBgs(key, custom)` —
called from `applyThemeLogo()` (theme switch, finish toggle) **and** after every
`renderSettingsThemes()` grid rebuild, toggling `is-manga` / `is-gold` classes whose CSS rules carry
the matching backgrounds (`/themes/comic/manga/background.jpg`, gold gradient). Because the same
function drives logo `src` and container class, logo and background now always belong to the same
theme: selecting Manga, opening Settings with Manga active, switching away and back, and
refreshing all verified by `_shot-settings-v74` (browser). The identical consistency check was
applied to Chrome (Gold) and re-verified for Comic/Chrome/Glitch/Cloud/Glowing cards.

## 2. Logo sizing correction

Settings swatch logo boxes grew from 58 px → 96 px and images from `max-height:50px / max-width:86%`
to `max-height:84px / max-width:92%` with `object-fit:contain` (never stretched/cropped —
`_shot-settings-v74` asserts each rendered logo's aspect ratio matches its natural ratio within 12%
and enforces minimum visible size). Wide wordmarks (Manga, Comic, Chrome) now fill the card width;
squarer marks scale by height — every logo reads as designed-into the card, centred, no overlap
with labels/borders, and the grid stays responsive (`auto-fill minmax(150px,1fr)`).

## 3. Chat layout fidelity to the reference

The conversation view reproduces the reference composition inside Art Arena's token system:

- header shows the ringed **avatar** + username; the circular **back** and **appearance**
  controls appear only on hover/focus (no resting opaque oval top-right; always visible on
  touch devices) — v69 refinement;
- **composer (v70)**: the form is the pill **typing space** ("Send a chat"); the eyed emoji
  button **permanently rests** in the space; the sticker / voice-note / image cluster rests
  inside the pill's right side and **rises up** above the typing space with a springy
  overshoot (`aa-rise`) when a letter is typed, falling back with a landing bounce
  (`aa-fall`) when cleared — both suppressed under `prefers-reduced-motion`. The input is an
  auto-growing **textarea**: text ends at the back of the deliver button and moves to a new
  line (grows to ~5 lines then scrolls; Enter sends, Shift+Enter newlines); the deliver
  button appears only once text exists. The cluster is absolutely positioned so the typing
  space never has a dead gap. `_shot-chat-v74` asserts: at rest — 3 tools + emoji as circles
  (`|w−h| ≤ 2`) with icons ≥ 12 px inside the pill, deliver opacity 0; typing — cluster risen
  above the pill while the emoji stays, long text wraps with `padding-right` matching the
  deliver boundary.
  (Root cause of the earlier oval/icon-less rendering: the app's global
  `button { padding:11px 20px; margin-top:8px }` rule hit the composer buttons — the padding
  inflated them to 42×38 and squeezed each inner SVG to 0 width; `.aa-cbtn`/`.aa-send` now reset
  `padding:0; margin:0; aspect-ratio:1` and fix the SVG size.)
- emoji picker popover; stickers send the **official brandmarks** as real messages;
  voice notes use real `MediaRecorder` (honest toast when no mic); image attach uploads through
  the validated uploads endpoint.

All phase-6 messaging behaviour preserved: friends-only threads, groups, cursor-paged history,
unread dots, realtime WS push (no polling), read state, block enforcement, deep links, and the
existing artwork/profile/battle/room/stream share payloads — now with rich server-validated cards
in bubbles (`cmOpenPost`/`openProfile`/`openRoom` wired to the real openers).

## 4. The decorative line behind the bubbles

Implemented as each sender-group's `::before` stroke: a 4 px rounded vertical bar running the full
height of the group (extending slightly past first/last bubble, exactly as the reference's
side strokes), right side + blue glow for own groups, left side + pink glow for theirs. It is
`pointer-events:none` (never intercepts touch/scroll), `z-index` below the bubbles (bubbles are
`z-index:1` opaque surfaces, so the line never obscures text or controls), and the browser suite
asserts computed `width == 4px`, `pointerEvents == 'none'`, bubble `zIndex == '1'`. Consecutive
messages from one sender share one stroke — matching the reference's grouped container.

## 5. Wallpaper sources supported

One server-built registry (`GET /api/messages/threads/:id/walls`) derived from the **actual shipped
assets** — no second catalogue:

| Source | Contents |
|---|---|
| Brandmarks | every official mark in `public/themes/marks/` (chrome, chrome-gold, cloud, comic, comic-manga *Manga*, flame, glitch, glowing, graffiti, magazine, pixel) |
| Full logos | every full wordmark in `public/themes/*.png` **plus** `/themes/comic-manga.png` (full Japanese Manga logo) and `/themes/chrome-gold.png` — exposed **separately** from brandmarks |
| Theme art | comic + manga backgrounds, graffiti wall, and each premium theme's profile artwork (`profile-<key>.<ext>` with per-theme correct extension) |
| Profile images | your own avatar + conversation members' avatars (public data, clearly labelled) |
| Device uploads | PNG/JPEG/WebP, magic-byte sniffed, dimension-validated (16–10 000 px), 5 MB cap, stored bytea, bounded to the 12 most recent unreferenced wallpapers |
| Premium-theme backgrounds | same theme-art list (single registry; selecting a chat wallpaper never changes the account theme) |

Display controls: position (center/top/bottom), fit (fill/fit), dim overlay 0–80 %
(`#msg-wall::after` themed scrim), Reset/Cancel/Apply with live preview.

## 6. Premium enforcement

- `PUT /threads/:id/customization` and `POST /uploads (kind=wallpaper)` check `premiumOf()`
  server-side → 403 `{premium:true}` otherwise; verified by `chat-core` including a **direct-API
  bypass attempt** and a revoke-then-try case.
- Non-premium UI shows an upgrade CTA in the panel (no tiles), normal messaging untouched.
- No auto-activation anywhere; the existing explicit `test-activate` dev endpoint is the only
  test path (used by tests exactly as the premium suites always have).

## 7. Per-conversation storage

New table `chat_customizations (user_id, conversation_id, wallpaper jsonb, updated_at,
PK(user_id, conversation_id))` — one **personal** row per member per conversation:
- changing A's wallpaper never touches B's row (asserted for DMs **and** groups);
- strangers/non-members get 404 on customization and 403 on private upload bytes;
- attachments (`chat_uploads` with `conversation_id`) readable by members only.
Schema additions: `chat_customizations`, `chat_uploads` (+ index), widened
`messages_payload_type_check` (profile/stream/sticker/image/audio shares). Present in
`schema.sql` **and** idempotent boot migrations — `schema-bootstrap` (fresh-vs-migrated parity)
passes.

## 8. Modified & new files

**Modified:** `server/server.js` (v74 migrations + guarded v52/v53 boot wipes), `server/schema.sql`,
`server/messages.js` (share payloads + uploads + catalogue + customization endpoints),
`server/public/index.html` (chat view rebuild, appearance panel, Part-1 sync + sizing),
`server/public/premium-themes.css` (finish-matched card backgrounds),
`server/tests/_shot-messages.js` (new DOM selectors), `server/tests/schema-bootstrap.js`
(health-ready poll), `server/tests/premium-mode.js` (disposable-DB isolation),
`server/tests/room-regressions.js` (queue cleanup + seat-visibility retry).
**New:** `server/tests/chat-core.js`, `server/tests/_shot-chat-v74.js`,
`server/tests/_shot-settings-v74.js`, this report.

## 9. Tests & results

Previews (real components, live server): `/home/user/theme-previews/`
`v74-settings-manga.png`, `v74-settings-cards.png`, `v74-chat-manga-wall.png`,
`v74-chat-panel.png`, `v74-chat-gallery-logos.png`, `v74-chat-profile-wall.png`,
`v74-chat-upload-wall.png`, `v74-chat-nonpremium.png`, `v74-chat-mobile.png`,
`v74-chat-light.png` — covering all ten required visual-review items.

- `chat-core` — premium gating incl. bypass attempts, catalogue honesty (brandmarks ≠ logos,
  Manga in both), magic-byte/dimension rejection, private uploads, per-conversation &
  per-member isolation, sticker/profile/image/audio share snapshots, revoke behaviour. **PASS**
- `_shot-settings-v74` — Manga logo+background travel together (open/switch/return/refresh),
  Chrome/Gold consistency, logo prominence + aspect-ratio assertions. **PASS**
- `_shot-chat-v74` — reference composition, 4 px non-interactive stroke behind layered bubbles,
  deliver-on-type + cluster bounce, emoji/sticker tools, panel sections, Manga + profile +
  upload wallpapers (live preview → apply → persist across reload), non-premium lock,
  member isolation, long-message wrapping, mobile viewport, and **light-theme readability**
  over a busy wallpaper (bubble surface asserted opaque, text/bg contrast asserted,
  `v74-chat-light.png`). **PASS**
- **Full battery 24/24 PASS** (Community, Messages, moderation, safety, matchmaking,
  3v3 auto-fill, premium, themes, schema parity, streams, navigation, network gate, …).
  No existing test deleted or weakened; `_shot-messages.js` only updated to the new DOM.

### 9b. Battery-stability fix (commit `ba3e97c`)

Mid-task, consecutive battery runs showed an intermittent `room-regressions` reroll failure
(`500 No elements available for "character"`). It was **not** a v74 code defect — a DB-side
`AFTER DELETE` statement trigger on `randomizer_elements` proved the cause: the pool was being
emptied *during* the battery. Root-cause chain, all three links fixed:

1. **No migration tracking** — `MIGRATION_STEPS` replays every boot by design (idempotent
   statements), which is safe only while every step is non-destructive.
2. **Unguarded destructive steps** — v52/v53 were bare `DELETE FROM randomizer_elements`
   (whole-pool wipes, relying on the trailing `ensureRandomizerSeed()` to refill) plus v51's
   325-row phrase deletion, leaving a seconds-wide empty pool at every boot.
   **Fix:** both wipes are now guarded —
   `DELETE … WHERE (SELECT count(*) … WHERE status='active') < 1000` — a healthy pool can
   never be emptied at boot.
3. **Test cross-contamination (the trigger)** — `tests/premium-mode.js` spawned real
   `server.js` instances inheriting the battery's shared `DATABASE_URL`, so its boot replays
   wiped the shared pool mid-battery (trigger log: 6 DELETEs by `art_arena_app` at 10:36:51
   inside premium-mode's window, pool 1537→1212→0), racing `room-regressions`.
   **Fix:** premium-mode now builds a **disposable database** (`aa_premium_mode_db` + role via
   `TEST_PG_ADMIN_URL`), loads `server/schema.sql` into it, and spawns every server against
   that URL only. The shared battery DB is never touched by spawned boots.

Two companion hardenings (assertions unchanged): `schema-bootstrap` polls `/api/health` until
the async schema check leaves `'unchecked'`; `room-regressions` clears unmatched
`matchmaking_queue` leftovers at start and retries 3v3 seat visibility (≤ 3 s) instead of
crashing on an undefined seat.

**Verification:** `premium-mode` → `room-regressions` run back-to-back 3×: all PASS, pool
stayed 1537 every time (previously wiped); **two consecutive full batteries: 24/24 and
24/24**; diagnostic trigger/table dropped from the DB afterwards.

### 9c. v75 composer correction (user review of the live build)

Two corrections from hands-on review, shipped as UI v71:

- **Typing-space capacity 5 → 10 lines.** `#msg-input` `max-height` 112 px → 196 px and the
  JS auto-grow clamp (`aaFit`) raised to the same value, so long messages show ~10 lines
  before scrolling instead of ~5. Evidence: `v75-composer-10lines.png`.
- **Unnecessary border removed.** The loud `#msg-input:focus-visible` outline (the purple
  rectangle drawn around the text while typing) is gone — `outline:none` on the textarea in
  every state. Keyboard focus stays visible through the pill's existing 1 px border, which
  accents to the theme purple on `#msg-form:focus-within` (no new border added).
- New browser contracts in `_shot-chat-v74`: grows to the 10-line capacity (196 px ± 6),
  computed `outline-style:none` and `border-top-width:0` on the focused textarea, and the
  pill border visibly accents on focus-within.

**Premium-mode chat evidence (real app, three modes):** `v75-chat-manga.png` (Comic theme,
Manga finish), `v75-chat-chrome-gold.png` (Chrome theme, Gold finish), `v75-chat-glitch.png`.
**Rise/fall animation video:** `v75-rise-fall.webm` (8 s, recorded in a real browser: cluster
rests in the pill → rises above it while "hello arena" is typed with the deliver button
appearing → falls back on clear). Frame-verified with ffmpeg.

### 9d. v76 composer shape + tool placement (user review of the live build)

Two corrections after hands-on review of v75, shipped as UI v72:

- **Pill only at rest.** With one line the typing space keeps its pill radius; as soon as
  text wraps to a second line the form gains a `tall` class (JS toggles it on
  `scrollHeight > 50`) and the radius becomes 16 px — a rounded rectangle like the user's
  reference crop, with the deliver button resting vertically centred at the right edge and
  the emoji button inside on the left (`#msg-form.tall { border-radius:16px }`).
- **Tools never inside while text exists.** The cluster was re-anchored from
  `top:50%`/translate to `bottom`-based geometry: at rest it rests inside the pill
  (`bottom:9px`); with any text `#msg-form.ready .aa-cluster { bottom:calc(100% + 8px) }`
  places it fully **above** the typing space at *any* height (the old −56 px translate kept
  it inside a 10-line box). Rise/fall keyframes animate `bottom` with the same springy
  overshoot; mobile media query mirrors the geometry.

New browser contracts in `_shot-chat-v74`: rest radius `999px`; single line keeps the pill;
multi-line ⇒ `tall` class + computed radius `16px`; and while 30 lines of text exist every
tool button's bottom edge is above the form's top edge. Evidence: `v76-composer-rest.png`,
`v76-composer-typing.png`, `v76-composer-tall.png`, `v76-rise-fall.webm`, plus the three
premium-mode chats re-shot as `v76-chat-{manga,chrome-gold,glitch}.png`.

### 9e. v77 back button, stroke colours/length, message actions (user review)

Four corrections/features from hands-on review, shipped as UI v73:

- **Back button always visible.** `#msg-back` keeps its circular shape but no longer waits
  for hover (`opacity:1`); the appearance control stays hover/focus-revealed.
- **Strokes wear clearly different colours per side.** New `--stroke-mine/--stroke-theirs`
  pairs per theme with guaranteed contrast (default dark violet/white, light violet/black,
  glitch keeps its cyan/magenta, comic yellow/black, chrome gold/silver, graffiti
  white/spray-pink, …). Contract: RGB distance ≥ 150 between the two computed colours.
- **Strokes end at the text, not the timestamp.** `.msg-grp::before` now spans exactly
  `top:4px; bottom:26px` of the group (bubble area only — the 15 px timestamp row + 7 px
  gaps are excluded); contracts assert stroke top/bottom coincide with first/last bubble
  edges (±1.5 px) and never reach the timestamp.
- **Message actions (edit / delete own messages), server-authoritative.**
  `PUT/DELETE /api/messages/threads/:id/messages/:mid` — the SQL predicate
  `sender_id = $me` makes both own-only by construction (404 otherwise); edits set
  `messages.edited_at` (new v75 column in `schema.sql` + boot migration) and fan out
  `chat.edit` / `chat.delete` over the existing realtime hub. UI: two small circles on the
  sender's bubbles (hover/focus, always on touch); edit opens an inline editor with
  save/cancel and leaves an honest "· edited" marker; delete is two-step ("sure?") and
  removes the bubble (and the group when emptied). `chat-core` covers edit-own/edit-other/
  delete-other/delete-own + reader visibility; both sides update live via WS.

Evidence: `v77-strokes-default.png`, `v77-strokes-glitch.png`, and `v77-actions.webm`
(8.6 s real-browser session: send → hover → edit → "· edited" → send → two-step delete).

### 9f. v78 pink buttons, per-bubble strokes, text actions, saves, replies (user review)

- **Pink is the button colour in the normal UI.** The base `button` rule dropped the
  pink→purple gradient for solid `var(--pink)`; the default own-stroke also turned pink
  (`--stroke-mine:#FF3CAC` vs white theirs) so pink creates the contrast. Contract: a fresh
  `<button>` computes `rgb(255, 60, 172)`.
- **Strokes never connect.** The line moved from the sender-group to each bubble
  (`.msg-bub::before`, `top:0; bottom:0`), so consecutive messages keep separate strokes and
  each line is exactly as long as its bubble (contracts: both bubbles own a 4 px stroke,
  gap ≥ 4 px between them, last stroke above the timestamp).
- **Actions are text beneath the bubble.** Tapping a bubble toggles a row of TEXT links
  under it — Reply · Save (every message) plus Edit · Delete (own only); delete stays
  two-step. Contracts assert transparent background, position beneath the bubble, and the
  full label set.
- **Save chats.** New personal `saved_messages` table (v77 migration + `schema.sql`),
  `POST/DELETE /threads/:id/messages/:mid/save` (member-only, message must belong to the
  conversation) and `GET /messages/saved`; a ★ Saved panel in the Messages view lists saves
  and opens their thread. Saves are per-user (contract-checked invisible to others).
- **Reply — swipe mostly, tap too.** Swiping a bubble (pointer drag > 48 px horizontal)
  opens a reply chip above the composer; the Reply text action does the same for
  keyboard/tap users. Sends carry a server-validated `reply_to` (must be a message of the
  same conversation, 404 otherwise; new `messages.reply_to_id` v76 migration) and render a
  "↳ @user: preview" quote in the bubble; both sides update live via `chat.message`.

Evidence: `v78-strokes-default.png`, `v78-tap-actions.png`, `v78-reply-chip.png`,
`v78-reply-quote.png`, `v78-saved-panel.png`.

### 9g. v79 purple theirs-line, glow removed, saves live in the thread (user review)

- **The white line is now purple.** `--stroke-theirs` changed from white to `#A855F7` in
  the default theme and in every theme whose line was white/near-white (flame, glowing,
  chrome); graffiti's white *own* line became purple too. Light/cloud/comic/magazine keep
  their near-black lines (not white), glitch keeps its praised cyan/magenta pair.
  Contract: theirs `::before` computes `rgb(168, 85, 247)`.
- **The glow is gone.** Both stroke rules lost their `box-shadow` halos — the lines behind
  the bubbles are flat 4 px bars now (contracts: `box-shadow: none` on both sides).
- **Saved chats live in the regular chat page.** The ★ Saved header button and its panel
  are removed entirely (no `#msg-saved`, no `#msg-savedbox`, no `.saved-row` anywhere in
  `index.html`). Instead a saved message wears a **distinct gold outline** right on its
  bubble inside the thread (`.msg-bub.saved { outline:2px solid #FFC94D; outline-offset:3px }`),
  toggled live by Save/Unsave and restored on every render from the `saved` flag the API
  returns. Contracts: saved bubble carries the class in-thread, outline `2px`
  `rgb(255, 201, 77)`, and no separate panel exists.
- **Demo video.** `theme-previews/v79-demo.webm` walks the whole feature set: tap a
  bubble → text actions beneath it, Save → gold outline appears in the thread,
  Unsave/Save round-trip, Edit via text buttons (`· edited` marker), two-step text Delete
  removing a bubble, swipe → reply chip → quoted reply — all with pink own-lines,
  purple theirs-lines, per-bubble strokes and no glow.

## 10. Known limitations

- Swipe-to-act-on-bubbles (annotation in the mock) not implemented — message actions remain
  via existing safety/profile controls; noted as mock annotation, not a spec requirement.
- Voice notes require a microphone; browsers without one get an honest toast (no fake send).
- Wallpaper dim default is 35 %; extremely busy user uploads rely on the dim slider + opaque
  bubble surfaces for readability.
- Boot migrations replay every startup by design (idempotent statements; no completion
  ledger). The destructive v52/v53 pool wipes are now guarded, but any future destructive
  step must carry the same kind of guard — §9b documents why.
- If the app database role does not own its tables, boot migration DDL lines fail with
  "must be owner" (objects then exist only via `schema.sql`; fresh-schema parity is proven
  by `schema-bootstrap`). The sandbox DB runs the app role as owner, so boot is clean.
