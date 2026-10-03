// How an AI with a personality handles truces: whether to accept an offer, and whom to offer one.
// Deterministic (no randomness): the same board always gets the same answer. The classic AI (no
// personality) never proposes and always declines.

import { grudgeOf, offerBetween, recentlyRebuffed, truceBetween } from '../diplomacy';
import { ADJACENCY, CONTINENTS, TERRITORIES, TERRITORY_IDS } from '../mapData';
import type { GameState, PlayerId, TruceProposal } from '../types';
import { TEMPERAMENTS } from './personality';

interface Border {
  /** Armies `them` has on territories touching `me`. */
  theirs: number;
  /** Armies `me` has on territories touching `them`. */
  mine: number;
}

function border(s: GameState, me: PlayerId, them: PlayerId): Border {
  let theirs = 0;
  let mine = 0;
  for (const t of TERRITORY_IDS) {
    const x = s.territories[t];
    if (x.owner !== me && x.owner !== them) continue;
    const other = x.owner === me ? them : me;
    if (!ADJACENCY[t].some((n) => s.territories[n].owner === other)) continue;
    if (x.owner === me) mine += x.armies;
    else theirs += x.armies;
  }
  return { theirs, mine };
}

function share(s: GameState, p: PlayerId): number {
  let n = 0;
  for (const t of TERRITORY_IDS) if (s.territories[t].owner === p) n++;
  return n / TERRITORY_IDS.length;
}

/** Opponent seats (not neutral, not eliminated) that border `me`. */
function neighbourSeats(s: GameState, me: PlayerId): Set<PlayerId> {
  const out = new Set<PlayerId>();
  for (const t of TERRITORY_IDS) {
    if (s.territories[t].owner !== me) continue;
    for (const n of ADJACENCY[t]) {
      const o = s.territories[n].owner;
      if (o >= 0 && o !== me && !s.players[o].neutral && !s.players[o].eliminated) out.add(o);
    }
  }
  return out;
}

/** Offer score from the answering seat's side; > 0 = accept. */
export function truceScore(s: GameState, offer: TruceProposal): number {
  const me = offer.to;
  const from = offer.from;
  const pl = s.players[me];
  if (!pl?.personality || pl.neutral) return -Infinity;
  const T = TEMPERAMENTS[pl.personality];
  const b = border(s, me, from);
  if (b.theirs === 0 && b.mine === 0) return -Infinity; // nothing to agree on
  const ratio = b.theirs / Math.max(1, b.mine);
  const others = [...neighbourSeats(s, me)].filter((o) => o !== from && !truceBetween(s, me, o));
  let v = T.acceptBias + Math.max(-1, Math.min(1.5, ratio - 0.8)) + (others.length > 0 ? 0.6 : -0.8);
  v -= grudgeOf(s, me, from) * 0.5;
  v -= (s.players[from]?.truceBreaks ?? 0) * 0.8;
  if (share(s, from) >= 0.45) v -= 3; // don't hold the door for the runaway leader
  if (pl.personality === 'opportunist' && ratio < 0.6) v -= 1.5; // they're weak: better eaten than befriended
  if (pl.personality === 'warlord') {
    let theirT = 0;
    for (const t of TERRITORY_IDS) if (s.territories[t].owner === from) theirT++;
    if (theirT <= 4) v -= 3; // prey
  }
  return v;
}

/** Would the AI seat `offer.to` accept? The classic AI never does. */
export function acceptsTruce(s: GameState, offer: TruceProposal): boolean {
  return truceScore(s, offer) > 0;
}

/**
 * v4 (PLAN §3 A5): an AI seat makes at most one offer per this many rounds (so a pair hears at most one),
 * whatever came of it.
 */
export const TRUCE_PAIR_ROUNDS = 3;

/**
 * The round of the last offer between `a` and `b` (either way), as the state still remembers it: a pending
 * offer (this round), a truce (its `since`), or a refusal / lapse (the rebuff's round). null = none known.
 */
export function lastOfferRound(s: GameState, a: PlayerId, b: PlayerId): number | null {
  const d = s.diplomacy;
  if (!d) return null;
  const pair = (x: PlayerId, y: PlayerId) => (x === a && y === b) || (x === b && y === a);
  let r: number | null = null;
  const see = (n: number) => (r = r === null ? n : Math.max(r, n));
  for (const o of d.offers) if (pair(o.from, o.to)) see(s.round);
  for (const t of d.truces) if (pair(t.from, t.to)) see(t.since);
  for (const x of d.rebuffs) if (pair(x.from, x.to)) see(x.round);
  return r;
}

/**
 * A human hears at most one AI offer at a time and none the round after one (the review saw three offers in
 * two rounds: spam that cheapens the one diplomatic act the game has).
 */
function humanRecentlyAsked(s: GameState, human: PlayerId): boolean {
  const d = s.diplomacy;
  if (!d) return false;
  if (d.offers.some((o) => o.to === human)) return true;
  const recent = (round: number) => s.round - round < 2;
  return d.truces.some((t) => t.to === human && recent(t.since)) || d.rebuffs.some((x) => x.to === human && recent(x.round));
}

/**
 * Why `from` wants a truce with `to`, in plain words, or null when it can't say: the continent where their
 * borders touch most. Addressed to the reader when `to` is human ('you share a border in Asia'), else
 * 'they share a border in Asia'. The AI only proposes when it can state one (v4 A5).
 */
export function truceReason(s: GameState, from: PlayerId, to: PlayerId): string | null {
  const touches: Partial<Record<string, number>> = {};
  for (const t of TERRITORY_IDS) {
    const o = s.territories[t].owner;
    if (o !== from && o !== to) continue;
    const other = o === from ? to : from;
    for (const n of ADJACENCY[t]) {
      if (s.territories[n].owner !== other) continue;
      const c = TERRITORIES[t].continent;
      touches[c] = (touches[c] ?? 0) + 1;
    }
  }
  let best: string | null = null;
  for (const [c, n] of Object.entries(touches)) if (!best || (n ?? 0) > (touches[best] ?? 0)) best = c;
  if (!best) return null;
  const who = s.players[to]?.kind === 'human' ? 'you' : 'they';
  return `${who} share a border in ${CONTINENTS[best as keyof typeof CONTINENTS].name}`;
}

/**
 * The truce this AI would offer at the start of its turn, or null. It only asks when it faces two or
 * more rivals (a truce frees one front), never a seat it holds a grudge against, never the runaway
 * leader, never a classic AI (they always refuse), and a human only when config.diplomacy is on.
 * v4 (PLAN §3 A5): at most once per TRUCE_PAIR_ROUNDS rounds per pair, a human one offer at a time with a
 * round's rest after it, and only with a reason it can state (truceReason).
 */
export function chooseTruceProposal(s: GameState, me: PlayerId): TruceProposal | null {
  const pl = s.players[me];
  if (!pl?.personality || pl.neutral) return null;
  // A human seat on autoplay speaks for a human: only with diplomacy on.
  if (pl.kind === 'human' && !s.config.diplomacy) return null;
  const T = TEMPERAMENTS[pl.personality];
  if (T.proposeBias <= 0) return null;
  if (s.diplomacy?.proposedOn[me] === s.turn) return null;
  // v4: one offer per TRUCE_PAIR_ROUNDS rounds from this seat at all (so per pair too). The engine keeps the
  // turn of each seat's last offer; a round is one turn per seat still in the game.
  const lastTurn = s.diplomacy?.proposedOn[me];
  const seatsIn = s.players.filter((p) => !p.eliminated).length;
  if (lastTurn !== undefined && s.turn - lastTurn < TRUCE_PAIR_ROUNDS * Math.max(1, seatsIn)) return null;
  const seats = neighbourSeats(s, me);
  if (seats.size < 2) return null;
  let best: PlayerId = -1;
  let bestV = 0;
  for (const z of seats) {
    const zp = s.players[z];
    if (truceBetween(s, me, z) || offerBetween(s, me, z)) continue;
    if (zp.kind === 'human' && !s.config.diplomacy) continue;
    if (zp.kind === 'ai' && !zp.personality) continue;
    if (recentlyRebuffed(s, me, z)) continue;
    const lastRound = lastOfferRound(s, me, z);
    if (lastRound !== null && s.round - lastRound < TRUCE_PAIR_ROUNDS) continue;
    if (zp.kind === 'human' && humanRecentlyAsked(s, z)) continue;
    if (!truceReason(s, me, z)) continue;
    if (grudgeOf(s, me, z) >= 1.5) continue;
    if (share(s, z) >= 0.45) continue;
    const b = border(s, me, z);
    const ratio = b.theirs / Math.max(1, b.mine);
    if (ratio < 0.7) continue; // not a real threat: no need for peace
    if (pl.personality === 'opportunist' && ratio < 1) continue; // it befriends only the strong
    const v = ratio * T.proposeBias;
    if (v > bestV) {
      bestV = v;
      best = z;
    }
  }
  if (best < 0 || bestV < 0.8) return null;
  return { from: me, to: best, rounds: T.truceRounds, kind: 'noAttack' };
}
