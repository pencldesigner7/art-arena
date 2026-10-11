# v74 — MANGA SETTINGS FIX · REFERENCE CHAT PAGE · PREMIUM CHAT CUSTOMIZATION

Base: `76b2098` + uncommitted Community/v73 work (21-suite battery green before this task).
Result: **24/24 suites green** (21 pre-existing + `chat-core` + `_shot-chat-v74` + `_shot-settings-v74`).
Commits (approved, on `main`, author pencldesigner7 — **not pushed**; delivered as
`/home/user/art-arena-v74.bundle`, range `76b2098..main`):
`9302d5f` (Community phases 1–6, v73 polish, v74 core) → `ffc8e98` (v69 header circles on hover)
→ `64a74ca` (v70 composer refinement) → `ba3e97c` (battery-stability fixes, §9b below).

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
