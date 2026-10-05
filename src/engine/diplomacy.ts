// Grudges and truces: the state helpers the reducer and the AI share, plus one plain sentence per
// diplomacy event. Pure; the mutating helpers only ever touch a reducer draft.

import { territoryName } from './rules';
import type { DiplomacyState, GameEvent, GameState, PlayerId, Truce } from './types';

// --- Grudges ---------------------------------------------------------------------------------------

/** Grudge added per territory someone takes from you. */
export const GRUDGE_TAKEN = 1;
/** Extra grudge when that conquest also broke a continent you held. */
export const GRUDGE_CONTINENT = 1;
/** Grudge against a seat that eliminated someone you had a truce with. */
export const GRUDGE_PARTNER_ELIMINATED = 2;
/** Grudge against a seat that broke its truce with you. */
export const GRUDGE_BETRAYED = 3;
/** Grudge every other seat takes against a truce breaker (lost standing). */
export const GRUDGE_STANDING = 1;
/** Each new round multiplies every grudge by this (about half gone after 2.4 rounds). */
export const GRUDGE_DECAY = 0.75;
/** Grudges below this are forgotten. */
export const GRUDGE_FLOOR = 0.1;
export const GRUDGE_CAP = 12;

/** Truce length bounds, in rounds. */
export const TRUCE_MIN_ROUNDS = 1;
export const TRUCE_MAX_ROUNDS = 5;
/** An AI waits this many rounds before asking a seat that refused it again. */
export const REBUFF_ROUNDS = 3;

const round2 = (x: number) => Math.round(x * 100) / 100;

/** How much `holder` wants payback from `target` (0 if none). */
export function grudgeOf(s: GameState, holder: PlayerId, target: PlayerId): number {
  return s.players[holder]?.grudges?.[target] ?? 0;
}

/** `holder`'s grudges, strongest first, for the UI. */
export function grudgesOf(s: GameState, holder: PlayerId): { seat: PlayerId; value: number }[] {
  const g = s.players[holder]?.grudges ?? {};
  return Object.entries(g)
    .map(([k, v]) => ({ seat: Number(k), value: v ?? 0 }))
    .filter((x) => x.value > 0)
    .sort((a, b) => b.value - a.value || a.seat - b.seat);
}

/** Draft-only. Neutral seats neither hold nor earn grudges; nobody holds one against themselves. */
export function addGrudge(s: GameState, holder: PlayerId, target: PlayerId, amount: number): void {
  const h = s.players[holder];
  const t = s.players[target];
  if (!h || !t || holder === target || h.neutral || t.neutral || amount <= 0) return;
  const g = { ...(h.grudges ?? {}) };
  g[target] = round2(Math.min(GRUDGE_CAP, (g[target] ?? 0) + amount));
  h.grudges = g;
}

/** Draft-only, once per new round. */
export function decayGrudges(s: GameState): void {
  for (const p of s.players) {
    if (!p.grudges) continue;
    const g: Partial<Record<PlayerId, number>> = {};
    for (const [k, v] of Object.entries(p.grudges)) {
      const nv = round2((v ?? 0) * GRUDGE_DECAY);
      if (nv >= GRUDGE_FLOOR) g[Number(k)] = nv;
    }
    p.grudges = g;
  }
}

// --- Truces ----------------------------------------------------------------------------------------

export function truceBetween(s: GameState, a: PlayerId, b: PlayerId): Truce | undefined {
  return s.diplomacy?.truces.find((t) => (t.from === a && t.to === b) || (t.from === b && t.to === a));
}

/** Seats `p` has a truce with right now. */
export function trucePartners(s: GameState, p: PlayerId): PlayerId[] {
  const out: PlayerId[] = [];
  for (const t of s.diplomacy?.truces ?? []) {
    if (t.from === p) out.push(t.to);
    else if (t.to === p) out.push(t.from);
  }
  return out;
}

/** A pending offer between the two seats (either direction), if any. */
export function offerBetween(s: GameState, a: PlayerId, b: PlayerId) {
  return s.diplomacy?.offers.find((o) => (o.from === a && o.to === b) || (o.from === b && o.to === a));
}

/** `to` refused `from` within the last REBUFF_ROUNDS rounds. */
export function recentlyRebuffed(s: GameState, from: PlayerId, to: PlayerId): boolean {
  return (s.diplomacy?.rebuffs ?? []).some((r) => r.from === from && r.to === to && s.round - r.round < REBUFF_ROUNDS);
}

/** Draft-only: the diplomacy block, created on first use. */
export function ensureDiplomacy(s: GameState): DiplomacyState {
  if (!s.diplomacy) s.diplomacy = { truces: [], offers: [], proposedOn: {}, rebuffs: [] };
  return s.diplomacy;
}

export function cloneDiplomacy(d: DiplomacyState): DiplomacyState {
  const out: DiplomacyState = {
    truces: d.truces.map((t) => ({ ...t })),
    offers: d.offers.map((o) => ({ ...o })),
    proposedOn: { ...d.proposedOn },
    rebuffs: d.rebuffs.map((r) => ({ ...r })),
  };
  if (d.broken) out.broken = d.broken.map((b) => ({ ...b }));
  if (d.asked) out.asked = { ...d.asked };
  if (d.standings) out.standings = { ...d.standings };
  if (d.hardened) out.hardened = [...d.hardened];
  return out;
}

/**
 * v5.1: peace a human asked for, as opposed to an understanding between two AIs. A truce from before v5.1 with a
 * human in it (the retired offer protocol) reads as peace too.
 */
export function isPeace(s: GameState, t: Truce): boolean {
  return !!t.peace || s.players[t.from]?.kind === 'human' || s.players[t.to]?.kind === 'human';
}

/** v5.1: `by` broke the peace with `against` (any time this game), or undefined. */
export function brokenPeace(s: GameState, by: PlayerId, against: PlayerId) {
  return s.diplomacy?.broken?.find((b) => b.by === by && b.against === against);
}

// --- Sentences -------------------------------------------------------------------------------------

const SEP = ' · ';
const rounds = (n: number) => (n === 1 ? '1 round' : `${n} rounds`);

/**
 * One plain-English line for a diplomacy event, or null for any other event. Names come from `state`
 * (any state from the same game will do).
 *   truceProposed  "Theo proposes a truce with John · 3 rounds"
 *   truceAccepted  "John accepts Theo's truce · until round 9"
 *   truceDeclined  "John turns down Theo's truce"  |  lapsed: "Theo's truce offer to John lapses"
 *   truceBroken    "Theo breaks the truce with John · attacks Ukraine"
 *   truceExpired   "The truce between Theo and John ends"
 * v5.1, between two AIs (an "understanding"):
 *   truceAccepted  "Sage and Ochre have an understanding"
 *   truceBroken    "Sage turned on Ochre · attacks Ukraine"
 *   truceExpired   "The understanding between Sage and Ochre ends"  |  standing: "Sage turned on Ochre"
 * v5.1 peace:
 *   peaceAnswered  the event's own reason ("Sage agrees · three rounds" / "Sage refuses · you took Ural")
 *   peaceBroken    "John broke the peace with Sage"
 * standingChanged has no sentence here: write `standingReason(stateAfter, ai, toward)`.
 */
export function truceSentence(state: GameState, e: GameEvent): string | null {
  const name = (p: PlayerId) => state.players[p]?.name ?? `Seat ${p + 1}`;
  const poss = (p: PlayerId) => {
    const n = name(p);
    return n.endsWith('s') ? `${n}'` : `${n}'s`;
  };
  const ais = (a: PlayerId, b: PlayerId) => state.players[a]?.kind === 'ai' && state.players[b]?.kind === 'ai';
  switch (e.type) {
    case 'peaceAnswered':
      return e.reason;
    case 'peaceBroken':
      return `${name(e.by)} broke the peace with ${name(e.against)}`;
    case 'truceProposed':
      return `${name(e.from)} proposes a truce with ${name(e.to)}${SEP}${rounds(e.rounds)}`;
    case 'truceAccepted':
      if (ais(e.from, e.to)) return `${name(e.from)} and ${name(e.to)} have an understanding`;
      return `${name(e.to)} accepts ${poss(e.from)} truce${SEP}until round ${e.until}`;
    case 'truceDeclined':
      return e.reason === 'lapsed'
        ? `${poss(e.from)} truce offer to ${name(e.to)} lapses`
        : `${name(e.to)} turns down ${poss(e.from)} truce`;
    case 'truceBroken':
      if (ais(e.by, e.against)) return `${name(e.by)} turned on ${name(e.against)}${SEP}attacks ${territoryName(e.to, state)}`;
      return `${name(e.by)} breaks the truce with ${name(e.against)}${SEP}attacks ${territoryName(e.to, state)}`;
    case 'truceExpired':
      if (e.reason === 'standing') return `${name(e.from)} turned on ${name(e.to)}`;
      if (ais(e.from, e.to)) return `The understanding between ${name(e.from)} and ${name(e.to)} ends`;
      return `The truce between ${name(e.from)} and ${name(e.to)} ends`;
    default:
      return null;
  }
}
