'use strict';
// v63c — TOURNAMENT BRACKET (single elimination, server-owned).
// Stored as JSON on battle_rooms.bracket. Random seeding is done with
// crypto (Fisher–Yates); byes land wherever the shuffle puts them.
//
// Shape:
//   {
//     seeded_at: ISO,
//     slots: 8|16,                     // power-of-two capacity used
//     rounds: [                        // rounds[0] = first round (leaves)
//       { label: 'Round 1', matches: [ { a: uid|null, b: uid|null,
//                                        w: uid|null, played: bool,
//                                        auto: bool } ] },
//       ...                             // one match per parent slot upward
//     ],
//     champion: uid|null
//   }
// Rules:
//   - a match is 'played' ONLY when it has a winner (w). A draw leaves the
//     match open so the room replays the same pairing.
//   - advancing a winner fills the parent slot (round+1, match>>1).
//   - auto = decided without a battle (BYE at seed, or forfeit after a
//     leave) — the surviving side advances.
//   - current-match derivation: first unplayed two-sided match in round
//     order; single-sided unplayed matches resolve themselves (auto) in the
//     same forward sweep, so a chain of byes never blocks the bracket.

const crypto = require('crypto');

function shuffle(list) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

function roundLabel(i, depth) {
  const fromEnd = depth - 1 - i;           // 0 = final
  if (fromEnd === 0) return 'Final';
  if (fromEnd === 1) return 'Semifinals';
  if (depth === 3 && i === 0) return 'Quarterfinals'; // 8 slots → QF/SF/F
  return 'Round ' + (i + 1);
}

function seedBracket(participantIds) {
  const n = participantIds.length;
  const slots = n <= 8 ? 8 : 16;           // creator band is 8..16
  const depth = Math.round(Math.log2(slots));
  const leaves = shuffle(participantIds);
  while (leaves.length < slots) leaves.push(null);
  const rounds = [];
  let layer = leaves;
  for (let r = 0; r < depth; r++) {
    const matches = [];
    for (let i = 0; i < layer.length; i += 2) {
      const a = layer[i], b = layer[i + 1];
      const auto = (a !== null && a !== undefined) !== (b !== null && b !== undefined);
      matches.push({ a: a || null, b: b || null, w: null, played: false, auto: auto || false });
    }
    rounds.push({ label: roundLabel(r, depth), matches });
    // next round's layer = empty parent slots (winners land there later)
    layer = new Array(matches.length).fill(null);
  }
  return {
    seeded_at: new Date().toISOString(),
    slots,
    rounds,
    champion: null,
  };
}

// First unplayed TWO-sided match, in round order. Single-sided unplayed
// matches are auto-decided as the sweep goes (BYE / forfeit chains), so this
// function both resolves byes and returns where the next real battle happens.
// Returns { state:'match', r, m } | { state:'champion', id } |
//         { state:'none' } (nothing left to play, no champion).
function sweep(bracket) {
  const rounds = bracket.rounds;
  for (let r = 0; r < rounds.length; r++) {
    const ms = rounds[r].matches;
    for (let m = 0; m < ms.length; m++) {
      const match = ms[m];
      if (match.played) continue;
      const aLive = match.a !== null && match.a !== undefined;
      const bLive = match.b !== null && match.b !== undefined;
      if (aLive && bLive) return { state: 'match', r, m };
      if (aLive || bLive) {
        // auto decision — the only live side advances
        match.w = aLive ? match.a : match.b;
        match.played = true;
        match.auto = true;
        if (r + 1 < rounds.length) {
          const parent = rounds[r + 1].matches[m >> 1];
          if (m % 2 === 0) parent.a = match.w; else parent.b = match.w;
        }
      }
    }
  }
  // No playable match: champion is the final's winner (if any)
  const last = rounds[rounds.length - 1].matches;
  for (const match of last) {
    if (match.played && match.w !== null && match.w !== undefined) {
      bracket.champion = match.w;
      return { state: 'champion', id: match.w };
    }
  }
  return { state: 'none' };
}

// Apply a real battle result (winnerId; null = draw → pairing stays open so
// the room replays the same match). Then sweep. Returns sweep()'s verdict.
function applyResult(bracket, winnerId) {
  const cur = sweep(bracket); // resolves byes, may itself return the match
  if (cur.state !== 'match') return cur;
  const match = bracket.rounds[cur.r].matches[cur.m];
  if (winnerId === null || winnerId === undefined) {
    // draw — leave open; sweep() again finds the same match next time
    return { state: 'match', r: cur.r, m: cur.m, draw: true };
  }
  match.w = winnerId;
  match.played = true;
  match.auto = false;
  if (cur.r + 1 < bracket.rounds.length) {
    const parent = bracket.rounds[cur.r + 1].matches[cur.m >> 1];
    if (cur.m % 2 === 0) parent.a = winnerId; else parent.b = winnerId;
  }
  return sweep(bracket);
}

// A seated artist left the tournament (room still in lobby): clear their
// only open slot (a player can hold at most one open slot — they must win to
// advance). The forward sweep then forfeits/advances accordingly.
function onLeave(bracket, uid) {
  const rounds = bracket.rounds;
  for (let r = 0; r < rounds.length; r++) {
    const ms = rounds[r].matches;
    for (let m = 0; m < ms.length; m++) {
      const match = ms[m];
      if (match.played) continue;
      if (match.a === uid) { match.a = null; return sweep(bracket); }
      if (match.b === uid) { match.b = null; return sweep(bracket); }
    }
  }
  return sweep(bracket);
}

// The two players of the match a completed battle belongs to — by
// participant set (order-independent). Only unplayed matches qualify.
function matchForParticipants(bracket, userIds) {
  const set = userIds.slice().sort().join('|');
  for (const round of bracket.rounds) {
    for (const match of round.matches) {
      if (match.played) continue;
      if (match.a === null || match.b === null) continue;
      if ([match.a, match.b].sort().join('|') === set) return match;
    }
  }
  return null;
}

module.exports = { seedBracket, sweep, applyResult, onLeave, matchForParticipants };
