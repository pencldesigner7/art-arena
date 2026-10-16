# V81 — Completion Report

Base: `c7c79ef` (V80). **Nothing committed or pushed** — everything below is
uncommitted working-tree change, ready for your review.

Final video: `docs/shots-v81/art-arena-final-v81.webm` (new tour recorded
after all fixes; the earlier `community-tour-v81.webm` was never presented —
superseded by this one).

## What was wrong → what changed

| # | Root cause | Fix |
|---|-----------|-----|
| P1 | Probed live first: profile-modal artwork already uses real `/community-art/:key` images and renders. No fake bug fix. Honest boundary: Saved Artworks has no battle-submission byte store anywhere in the codebase (battle engine unbuilt), so there are no battle images to show — nothing was mocked. | Verified rendering in browser QA (`naturalWidth > 0` on real post images). |
| P2 | No challenge affordance outside friends; no state endpoint. | `GET/POST /api/community/challenge/...` reusing `friends.inviteToRoom` + `rooms.createRoomForUser`. Never auto-friends. Buttons everywhere artists appear (rows, Discover cards, artwork page, profile modal) with server-driven states: ⚔ Challenge / ⏳ Pending / ⚔ Invited you / ✓ Accepted / ⚔ Challenge again; hidden for self/blocked/ineligible. |
| P3 | Hero Colosseum cut-out had a 1,333px enclosed sky hole left by border flood-fill removal. | Global warm-only sky classification filled it (`community-hero-colosseum.png`, 188KB; QA proof screenshots kept). |
| P4 | `/team-invite` used `INSERT … ON CONFLICT … WHERE … DO NOTHING` against a partial unique index that didn't exist → duplicate invite = 500, stale slots. Disconnects never expired invites. | Migration `uq_mm_team_invite_open` (+ schema.sql parity); inviter disconnect cancels queue and expires their open invites (stale accepts → 409); decline frees the slot. 1v1 untouched. |
| P5 | `/api/premium/test-activate` is intentionally locked unless `PREMIUM_TEST_MODE=1`. | Verified end-to-end at 375px in a real browser: button → confirm → status `active:true, source:"test"`. Production deployments must set the env flag deliberately — this is a security gate, not a bug. |
| P6 | Featured art didn't fill its card on small screens. | ≤560px: `.cm-feat-art` covers the container (`object-fit:cover`). Verified computed `cover` + rendered image at 375px. |
| P7 | Swipe handler kept its start point until *any* later `pointerup`; a scroll ending in `pointercancel` left a stale target → wrong-message replies; it also fired on un-acked bubbles and on drags starting on audio/buttons; focus scrolled the page. | Rebuilt: rightward horizontal-dominant swipe on real bubbles only, live drag feedback capped at 72px, vertical motion abandons the swipe (scroll never fought), `pointercancel` clears state, `focus({preventScroll:true})`. |
| P8 | No notification/sound preferences existed; no message sound asset. | `user_message_prefs` (independent toggles, default ON/ON, PUT-merge), Community Settings "Messages" card with preview button, new shipped `message-chime.wav` (E6→A6). Sound gates the chime, notifications gate the toast — independently. |
| P9 | Wallpaper lived inside the scrolling content (scrolled away); incoming messages always yanked scroll to bottom. | Wallpaper moved to a static sibling layer under the scroller; autoscroll only when already within 180px of the bottom (own sends always follow). |
| P10 | Emoji set lacked multi-codepoint sequences entirely (had a lone variation-selector entry); GIFs blocked by type sniffing rules. | 116 native emoji incl. 🇳🇬 flags, skin tones (👍🏽), ZWJ (🧑‍🎨). Server accepts real GIFs by content sniff + dimensions; chat attach accepts GIF. |
| P11 | Sends fired while offline and were lost or silently restored. | Client outbox: one `client_id` per composed message, provisional bubble marked Sending…/Not sent + manual Retry, **no auto-resend on reconnect**, server dedupes on `(conversation, sender, client_id)` → retry returns the original ack; exactly one stored copy (proven in browser). |
| P12 | Community panels could render transparent/unreadable under some themes. | `.cm-card`, `.cm-featured`, `.cm-search-wrap` pinned to `var(--surface)`. Computed background verified opaque across graffiti/glowing/pixel/chrome/comic/manga. |
| P13 | Recording auto-sent instantly; voice notes rendered as a bare audio tag inside a text bubble. | Record → local draft with preview player → Send (upload+post) or Discard (revoke object URL); mic tracks stopped; dedicated 🎙 voice-note component (no empty bubble); delete-own already existed and is sender-scoped server-side. |
| P14 | Flame home-card icons/chevrons and Magazine glyphs washed out on hover/active/lift. | Icons pinned to theme-ink through hover/active/focus-visible; identities and animations preserved. |
| P15 | Graffiti/Glowing/Pixel default palettes had drifted to washed-out values. | Restored vivid: Graffiti `#FF2E88/#8B5CFF`, Glowing `#2BF5C8/#2EA8FF`, Pixel `#FF2ED1→#2BF0FF` gradient (CSS, catalog, scene defaults). Users' saved custom colours untouched by design. |
| P16 | Glowing text input showed a glowing rectangle halo. | Focus now uses a pink inset underline — visible and accessible; no global outline removal. |
| Placeholders | Apple sign-in button (unimplemented), orphan Quick Match / Find Artist / Grand Arena COMING SOON pages, dead social buttons, non-selectable canvas cards presented as choices. | Apple button removed; orphan pages + their nav-map entries removed (real equivalents: matchmaking + Community discovery; Grand Arena's data model/stats untouched); unconfigured social providers hidden, never "coming soon" toasts; coming-soon canvas apps hidden from picker and preferred-canvas select. Honest empty states and input hints kept. |
| schema.sql | Fresh-bootstrap parity broken twice: v81 index referenced `messages.client_id` before the column existed in the dump, then the v81 block referenced `users`/`notifications` before dump-order created them. | Column added to the messages table; v81 DDL moved to EOF (same pattern as v74). `schema-bootstrap` + `premium-mode` now pass. |

## Files changed

Server: `server.js`, `community.js`, `friends.js`, `matchmaking.js`,
`messages.js`, `lib.js`, `schema.sql`.
Client: `public/index.html`, `public/themes.js`.
New assets: `public/community-hero-colosseum.png`,
`public/community-hero-backdrop.jpg`, `public/message-chime.wav`.
New tests: `tests/_v81-api.js`, `tests/_v81-matchmaking.js`,
`tests/_v81-browser-qa.js`, `tests/_shot-hero-v81.js`,
`tests/_video-final-v81.js` (plus the earlier `_video-community-v81.js`).

## Tests — all run this session, honestly reported

New/targeted: `_v81-api` PASS · `_v81-matchmaking` PASS (exactly six seats,
7th queued, duplicate invite 409, decline frees slot, disconnect expiry,
1v1 intact) · `_v81-browser-qa` PASS (hero, cover, challenge→pending,
profile images, toggles persist independently, theme vividness, emoji,
offline→retry = exactly one copy, Premium Test @375, no overflow at
320/768, zero page errors).

Existing suites — all PASS: community-core, messages-core, chat-core,
theme-additions, manga-variant, premium-mode, schema-bootstrap,
browser-regressions, navigation-return, room-regressions, 3v3-autofill,
3v3-optional-invite, 3v3-matchmaking-browser, network-gate, stream-cancel,
brandmarks-v2, entry-art-motion.

Not tested (honest): real multi-device play, production deployment,
physical-microphone recording (headless used Chrome's fake mic — the draft
Send/Discard flow recorded correctly on camera), real OAuth providers
(unconfigured locally, buttons now hidden rather than decorative).

## Git status

All changes uncommitted on top of `c7c79ef` — 9 modified files plus new
assets/tests/docs (see `git status`). Await your say-so before any commit.
