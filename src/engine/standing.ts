// v5.1 C "truces become standing" (_claude/v5/QUIETER.md §3 C, docs/SPEC.md §11.8). How each AI seat feels about
// each other seat, from state alone: recent losses to that seat (the grudge store, which decays each round),
// shared borders and the armies massed on them, who leads the table, and the AI's personality. Agreed peace pins
// ally; broken peace pins hostile for the game. Pure: no DOM, no Date.now()/Math.random(); the one random draw
// (a wary AI weighing a peace request) uses state.rng in the reducer.

import { brokenPeace, ensureDiplomacy, grudgeOf, isPeace, truceBetween } from './diplomacy';
import { mapOf, territoryName } from './rules';
import type { AiPersonality, GameEvent, GameState, PlayerId, Truce } from './types';

/** How an AI seat feels about another seat. Hardens from ally → even → wary → hostile. */
export type Standing = 'ally' | 'even' | 'wary' | 'hostile';

export const STANDINGS: readonly Standing[] = ['ally', 'even', 'wary', 'hostile'];

/** Peace lasts this many rounds after the round it is agreed in. */
export const PEACE_ROUNDS = 3;
/** A human may ask the same AI seat for peace once per this many rounds. */
export const PEACE_ASK_ROUNDS = 3;
/** A wary AI agrees to peace with this probability (state.rng). Ally and even always agree; hostile never. */
export const WARY_ACCEPT: Record<AiPersonality | 'classic', number> = { turtle: 0.7, opportunist: 0.4, warlord: 0.15, classic: 0.3 };

// Band edges on the heat score: ≤ ALLY_MAX ally, < EVEN_MAX even, < WARY_MAX wary, else hostile.
const ALLY_MAX = -0.5;
const EVEN_MAX = 1.0;
const WARY_MAX = 2.8;
/** A band cools only once the heat is this far under its edge (no flicker from turn to turn). */
const HYSTERESIS = 0.4;
/** Grudge counts up to this many points (three territories); past it, more losses do not add heat. */
const GRUDGE_SATURATE = 3;
/** A grudge under this (about a territory four rounds ago) no longer colours standing. */
const GRUDGE_NOTICE = 0.4;
/**
 * Hostile from losses is kept for the main aggressor: a seat whose grudge is under this share of the AI's largest
 * grudge stays wary at most (unless it leads the table or broke the peace).
 */
const MAIN_AGGRESSOR = 0.8;

/** Heat added by sharing a border (alone it reads as even). */
const BORDER = 0.5;
/** Heat when `toward` masses armies on the border: at least PRESSURE_MIN and PRESSURE_RATIO × ours. */
const PRESSURE = 0.6;
const PRESSURE_MIN = 6;
const PRESSURE_RATIO = 1.5;

interface Disposition {
  /** Heat per point of grudge (the grudge store: +1 per territory taken, decays ×0.75 a round). */
  grudge: number;
  /** Heat toward the seat that leads the table (the leader is wary at least, whatever the sum). */
  leader: number;
  /** Heat toward a seat that is not the leader when a third seat leads (negative: a shared rival draws them in). */
  common: number;
  /** Heat toward a seat with no shared border. */
  apart: number;
  /** Heat toward everyone. */
  base: number;
}

/** The Turtle forgives and leans ally with seats it does not touch; the Warlord hardens fastest. */
const DISPOSITION: Record<AiPersonality | 'classic', Disposition> = {
  turtle: { grudge: 0.6, leader: 1.0, common: -1.0, apart: -0.6, base: -0.3 },
  opportunist: { grudge: 0.8, leader: 1.6, common: -1.0, apart: 0, base: 0 },
  warlord: { grudge: 1.2, leader: 1.2, common: -0.6, apart: 0, base: 0.1 },
  classic: { grudge: 0.8, leader: 1.2, common: -1.0, apart: 0, base: 0 },
};

type FactorKey = 'grudge' | 'pressure' | 'border' | 'leader' | 'common' | 'apart';

interface Reading {
  band: Standing;
  pin: 'peace' | 'broken' | null;
  /** The truce behind a peace pin, or an AI-AI understanding that holds. */
  truce?: Truce;
  /** The round of the broken peace (pin 'broken'). */
  brokenRound?: number;
  heat: number;
  factors: Partial<Record<FactorKey, number>>;
  neighbour: boolean;
  theirBorder: number;
  leader: PlayerId;
  /** The band was raised to wary because `toward` leads the table. */
  leaderFloor: boolean;
}

const pairKey = (a: PlayerId, b: PlayerId) => `${a}>${b}`;

/** Living, non-neutral seats. */
function inPlay(s: GameState, p: PlayerId): boolean {
  const pl = s.players[p];
  return !!pl && !pl.eliminated && !pl.neutral;
}

/**
 * The seat that leads the table, or -1: the most territories among seats still in, at least 3 clear of the next
 * and at least 1.2× an even share. Nobody leads a level table.
 */
export function tableLeader(s: GameState): PlayerId {
  const n = s.players.length;
  const count = new Array<number>(n).fill(0);
  for (const t of mapOf(s).territoryIds) {
    const o = s.territories[t].owner;
    if (o >= 0) count[o]++;
  }
  let best = -1;
  let second = 0;
  let alive = 0;
  for (const p of s.players) {
    if (!inPlay(s, p.id)) continue;
    alive++;
    if (best < 0 || count[p.id] > count[best]) {
      if (best >= 0) second = Math.max(second, count[best]);
      best = p.id;
    } else second = Math.max(second, count[p.id]);
  }
  if (best < 0 || alive < 2) return -1;
  // Territories held by seats in play (the neutral seat's land does not make anyone lead).
  let held = 0;
  for (const p of s.players) if (inPlay(s, p.id)) held += count[p.id];
  if (count[best] < second + 3 || count[best] < (1.2 * held) / alive) return -1;
  return best;
}

function hardened(s: GameState, ai: PlayerId, toward: PlayerId): boolean {
  return s.diplomacy?.hardened?.includes(pairKey(ai, toward)) ?? false;
}

/** The heat edge crossed going from band `a` to band `b` (the nearer edge to `a` in that direction). */
function edgeBetween(a: Standing, b: Standing): number {
  const edges = [ALLY_MAX, EVEN_MAX, WARY_MAX];
  const ra = rank(a);
  const rb = rank(b);
  return rb > ra ? edges[ra] : edges[ra - 1];
}

function maxGrudge(s: GameState, ai: PlayerId): number {
  let m = 0;
  for (const [k, v] of Object.entries(s.players[ai]?.grudges ?? {})) if (inPlay(s, Number(k))) m = Math.max(m, v ?? 0);
  return m;
}

function bandOf(heat: number): Standing {
  if (heat <= ALLY_MAX) return 'ally';
  if (heat < EVEN_MAX) return 'even';
  if (heat < WARY_MAX) return 'wary';
  return 'hostile';
}

const rank = (b: Standing) => STANDINGS.indexOf(b);
const atLeast = (b: Standing, floor: Standing): Standing => (rank(b) < rank(floor) ? floor : b);

function read(s: GameState, ai: PlayerId, toward: PlayerId): Reading {
  const empty: Reading = { band: 'even', pin: null, heat: 0, factors: {}, neighbour: false, theirBorder: 0, leader: -1, leaderFloor: false };
  if (ai === toward || !inPlay(s, ai) || !inPlay(s, toward)) return empty;
  const broken = brokenPeace(s, toward, ai);
  if (broken) return { ...empty, band: 'hostile', pin: 'broken', brokenRound: broken.round };
  const truce = truceBetween(s, ai, toward);
  if (truce && isPeace(s, truce)) return { ...empty, band: 'ally', pin: 'peace', truce };

  const D = DISPOSITION[s.players[ai].personality ?? 'classic'];
  const factors: Partial<Record<FactorKey, number>> = {};
  // Border: does `toward` touch us, and how many of its armies stand on the shared border (and ours facing them)?
  let neighbour = false;
  let theirs = 0;
  let mine = 0;
  const m = mapOf(s);
  for (const t of m.territoryIds) {
    const x = s.territories[t];
    if (x.owner !== ai && x.owner !== toward) continue;
    const other = x.owner === ai ? toward : ai;
    if (!m.adjacency[t].some((n) => s.territories[n].owner === other)) continue;
    neighbour = true;
    if (x.owner === ai) mine += x.armies;
    else theirs += x.armies;
  }
  if (neighbour) {
    factors.border = BORDER;
    if (theirs >= PRESSURE_MIN && theirs > PRESSURE_RATIO * mine) factors.pressure = PRESSURE;
  } else if (D.apart) factors.apart = D.apart;
  const g = grudgeOf(s, ai, toward);
  if (g >= GRUDGE_NOTICE) factors.grudge = Math.min(GRUDGE_SATURATE, g) * D.grudge;
  const leader = tableLeader(s);
  if (leader === toward) factors.leader = D.leader;
  else if (leader >= 0 && leader !== ai) factors.common = D.common;
  let heat = D.base;
  for (const v of Object.values(factors)) heat += v ?? 0;
  let band = bandOf(heat);
  // Hysteresis, softening only: a loss hardens at once (you feel it), but a band cools only once the heat is
  // clearly under the edge, so a fading grudge does not flicker between two bands turn after turn.
  const was = s.diplomacy?.standings?.[pairKey(ai, toward)];
  if (was && rank(band) < rank(was) && edgeBetween(was, band) - heat < HYSTERESIS) band = was;
  // Hostile from losses alone is for the main aggressor.
  if (band === 'hostile' && leader !== toward && g < MAIN_AGGRESSOR * maxGrudge(s, ai)) band = 'wary';
  let leaderFloor = false;
  if (leader === toward && rank(band) < rank('wary')) {
    band = 'wary';
    leaderFloor = true;
  }
  if (band === 'ally' && hardened(s, ai, toward)) band = 'even';
  const r: Reading = { band, pin: null, heat, factors, neighbour, theirBorder: theirs, leader, leaderFloor };
  if (truce) r.truce = truce;
  return r;
}

/** `ai`'s standing toward `toward`, from recent losses, shared borders, who leads, and its personality. */
export function standingOf(s: GameState, ai: PlayerId, toward: PlayerId): Standing {
  return read(s, ai, toward).band;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const SEP = ' · ';
const MAX_REASON = 70;

interface Voice {
  /** 'you' or the name. */
  who: string;
  /** 'you took' / 'Ochre took'. */
  verb: (you: string, them: string) => string;
  human: boolean;
}

function voiceFor(s: GameState, toward: PlayerId): Voice {
  const human = s.players[toward]?.kind === 'human';
  const who = human ? 'you' : (s.players[toward]?.name ?? `Seat ${toward + 1}`);
  return { who, human, verb: (you, them) => (human ? `you ${you}` : `${who} ${them}`) };
}

const nameOf = (s: GameState, p: PlayerId) => s.players[p]?.name ?? `Seat ${p + 1}`;

function subject(s: GameState, ai: PlayerId, toward: PlayerId, band: Standing): string {
  const a = nameOf(s, ai);
  const v = voiceFor(s, toward);
  switch (band) {
    case 'ally':
      return v.human ? `${a} is your ally` : `${a} is ${possessive(v.who)} ally`;
    case 'even':
      return `${a} is even with ${v.who}`;
    case 'wary':
      return `${a} is wary of ${v.who}`;
    case 'hostile':
      return v.human ? `${a} is hostile` : `${a} is hostile to ${v.who}`;
  }
}

function possessive(n: string): string {
  return n.endsWith('s') ? `${n}'` : `${n}'s`;
}

function whenTaken(s: GameState, round: number): string {
  if (round >= s.round) return 'this round';
  if (round === s.round - 1) return 'last round';
  return `in round ${round}`;
}

/** The strongest factor behind a reading, as phrases from longest to shortest (the caller fits one in). */
function factorPhrases(s: GameState, ai: PlayerId, toward: PlayerId, r: Reading): string[] {
  const v = voiceFor(s, toward);
  if (r.pin === 'broken') {
    const base = v.verb('broke the peace', 'broke the peace');
    return [`${base} in round ${r.brokenRound}`, base];
  }
  if (r.pin === 'peace') {
    const until = r.truce?.until ?? s.round;
    return [`peace until round ${until}`, 'peace holds'];
  }
  if (r.band === 'ally') {
    if (r.factors.common !== undefined && r.leader >= 0) return [`${nameOf(s, r.leader)} leads the table`, 'a shared rival'];
    if (!r.neighbour) return [v.human ? 'you share no border' : 'they share no border'];
    return [v.human ? 'you have given it no reason' : 'nothing between them'];
  }
  if (r.band === 'even') {
    if (r.truce) return ['they have an understanding'];
    if (r.neighbour) return [v.human ? 'you share a border' : 'they share a border'];
    return [v.human ? 'you share no border' : 'they share no border'];
  }
  // wary / hostile: the largest heat that pushed it there.
  if (r.leaderFloor) return [v.verb('lead the table', 'leads the table')];
  let top: FactorKey | null = null;
  for (const k of ['grudge', 'leader', 'pressure', 'border'] as FactorKey[]) {
    const x = r.factors[k];
    if (x !== undefined && x > 0 && (top === null || x > (r.factors[top] ?? 0))) top = k;
  }
  switch (top) {
    case 'grudge':
      return grudgePhrases(s, ai, toward);
    case 'leader':
      return [v.verb('lead the table', 'leads the table')];
    case 'pressure':
      return [v.verb(`have ${r.theirBorder} armies on its border`, `has ${r.theirBorder} armies on its border`), v.verb('mass on its border', 'masses on its border')];
    default:
      return [v.human ? 'you share a border' : 'they share a border'];
  }
}

function grudgePhrases(s: GameState, ai: PlayerId, toward: PlayerId): string[] {
  const v = voiceFor(s, toward);
  const lost = s.players[ai]?.lastTakenBy?.[toward];
  if (lost) {
    const took = v.verb(`took ${territoryName(lost.territory, s)}`, `took ${territoryName(lost.territory, s)}`);
    return [`${took} ${whenTaken(s, lost.round)}`, took];
  }
  if ((s.players[toward]?.truceBreaks ?? 0) > 0) return [v.verb('broke a truce', 'broke a truce')];
  return [v.human ? 'it remembers your attacks' : `it remembers ${possessive(v.who)} attacks`];
}

function fit(head: string, tails: string[]): string {
  for (const t of tails) {
    const line = `${head}${SEP}${t}`;
    if (line.length <= MAX_REASON) return line;
  }
  return `${head}${SEP}${tails[tails.length - 1]}`;
}

/**
 * One plain sentence with the single strongest factor: 'Sage is wary of you · you took Ural last round' ·
 * 'Slate is even with you · you share no border' · 'Ochre is hostile · you broke the peace in round 4' ·
 * 'Theo is your ally · peace until round 9' · 'Sage is wary of you · you lead the table'. Addressed as 'you'
 * when `toward` is human, by name otherwise. ≤ 70 characters with the default seat names.
 */
export function standingReason(s: GameState, ai: PlayerId, toward: PlayerId): string {
  if (ai === toward || !s.players[ai] || !s.players[toward]) return '';
  const r = read(s, ai, toward);
  return fit(subject(s, ai, toward, r.band), factorPhrases(s, ai, toward, r));
}

/** Why `ai` refuses `human`, short: 'you took Ural' · 'you lead the table' · 'you share a border'. */
function refusalPhrase(s: GameState, ai: PlayerId, human: PlayerId, r: Reading): string {
  const ps = factorPhrases(s, ai, human, r);
  return ps[ps.length - 1];
}

// ---------------------------------------------------------------------------
// Asking for peace
// ---------------------------------------------------------------------------

function isMainTurnStep(s: GameState): boolean {
  const k = s.phase.kind;
  return k === 'reinforce' || k === 'attack' || k === 'fortify';
}

/** The round `human` last asked `ai` for peace, or null. */
export function lastPeaceAsk(s: GameState, human: PlayerId, ai: PlayerId): number | null {
  return s.diplomacy?.asked?.[pairKey(human, ai)] ?? null;
}

/**
 * Why `human` may not ask `ai` for peace right now, or null when it may. Plain sentences for the one line:
 * "Ochre is hostile · you broke the peace in round 4" · "You asked Sage in round 5 · ask again in round 8".
 */
export function peaceAskBlock(s: GameState, human: PlayerId, ai: PlayerId): string | null {
  const h = s.players[human];
  const a = s.players[ai];
  if (!h || !a || human === ai) return 'No such player.';
  if (s.phase.kind === 'game-over') return 'The game is over.';
  if (s.currentPlayer !== human) return `It's ${nameOf(s, s.currentPlayer)}'s turn, not ${h.name}'s.`;
  if (h.kind !== 'human') return 'Only a person asks for peace.';
  if (!isMainTurnStep(s)) return 'Ask for peace during your turn, not in the middle of a move.';
  if (a.kind !== 'ai' || a.neutral) return `${a.name} is not an AI seat.`;
  if (a.eliminated) return `${a.name} is out of the game.`;
  if (brokenPeace(s, human, ai)) return standingReason(s, ai, human);
  const t = truceBetween(s, human, ai);
  if (t) return `${a.name} is already at peace with you${SEP}until round ${t.until}`;
  const last = lastPeaceAsk(s, human, ai);
  if (last !== null && s.round - last < PEACE_ASK_ROUNDS) return `You asked ${a.name} in round ${last}${SEP}ask again in round ${last + PEACE_ASK_ROUNDS}`;
  return null;
}

/**
 * True when `human` may ask `ai` for peace now: the human's main turn (reinforce, attack or fortify), once per
 * three rounds per AI seat, not while peace already holds with that seat, and never with a seat the human broke
 * the peace with (it refuses forever; `standingReason` says why).
 */
export function canAskPeace(s: GameState, human: PlayerId, ai: PlayerId): boolean {
  return peaceAskBlock(s, human, ai) === null;
}

/**
 * The AI's answer, from its standing: ally and even agree, hostile refuses, wary agrees with its personality's
 * probability (`roll` is a uniform [0,1) draw from state.rng, taken only when wary). Pure.
 */
export function peaceAnswer(
  s: GameState,
  human: PlayerId,
  ai: PlayerId,
  roll: () => number,
): { accepted: boolean; reason: string; standing: Standing } {
  const r = read(s, ai, human);
  const name = nameOf(s, ai);
  let accepted: boolean;
  if (r.band === 'ally' || r.band === 'even') accepted = true;
  else if (r.band === 'hostile') accepted = false;
  else accepted = roll() < WARY_ACCEPT[s.players[ai].personality ?? 'classic'];
  const reason = accepted ? `${name} agrees${SEP}three rounds` : `${name} refuses${SEP}${refusalPhrase(s, ai, human, r)}`;
  return { accepted, reason, standing: r.band };
}

// ---------------------------------------------------------------------------
// Turn boundaries (draft-only)
// ---------------------------------------------------------------------------

/** AI seats whose standing is tracked: AI, in play. */
function trackedPairs(s: GameState): [PlayerId, PlayerId][] {
  const out: [PlayerId, PlayerId][] = [];
  for (const a of s.players) {
    if (a.kind !== 'ai' || !inPlay(s, a.id)) continue;
    for (const b of s.players) if (b.id !== a.id && inPlay(s, b.id)) out.push([a.id, b.id]);
  }
  return out;
}

/**
 * Draft-only, at a turn boundary (and silently at the start of play): end AI-AI understandings that either side
 * now reads as wary or hostile (truceExpired 'standing'), mark Warlords that went hostile, and emit
 * standingChanged for every tracked pair whose band moved since the last boundary. A pair seen for the first time
 * (game start, an old save, a seat handed to the AI) is recorded without an event. Returns the events in order.
 */
export function refreshStandings(s: GameState, silent = false): GameEvent[] {
  const ev: GameEvent[] = [];
  const dip = ensureDiplomacy(s);
  // 1) Understandings break when either side turns wary or hostile.
  const keep: Truce[] = [];
  for (const t of dip.truces) {
    if (isPeace(s, t)) {
      keep.push(t);
      continue;
    }
    const ab = standingOf(s, t.from, t.to);
    const ba = standingOf(s, t.to, t.from);
    const turned = rank(ab) >= rank('wary') ? t.from : rank(ba) >= rank('wary') ? t.to : -1;
    if (turned < 0) keep.push(t);
    else ev.push({ type: 'truceExpired', from: turned, to: turned === t.from ? t.to : t.from, reason: 'standing' });
  }
  if (keep.length !== dip.truces.length) dip.truces = keep;
  // 2) Bands.
  const prev = dip.standings ?? {};
  const next: Partial<Record<string, Standing>> = {};
  for (const [a, b] of trackedPairs(s)) {
    const k = pairKey(a, b);
    const band = standingOf(s, a, b);
    next[k] = band;
    if (band === 'hostile' && s.players[a].personality === 'warlord' && !hardened(s, a, b)) dip.hardened = [...(dip.hardened ?? []), k];
    const was = prev[k];
    if (!silent && was !== undefined && was !== band) ev.push({ type: 'standingChanged', ai: a, toward: b, standing: band });
  }
  dip.standings = next;
  return ev;
}

/**
 * Draft-only: record one pair's band now (after peace is agreed or broken) and return a standingChanged event when
 * it moved, so the boundary refresh does not announce it twice.
 */
export function noteStanding(s: GameState, ai: PlayerId, toward: PlayerId): GameEvent | null {
  const a = s.players[ai];
  if (!a || a.kind !== 'ai' || !inPlay(s, ai)) return null;
  const dip = ensureDiplomacy(s);
  const k = pairKey(ai, toward);
  const band = standingOf(s, ai, toward);
  const was = dip.standings?.[k];
  dip.standings = { ...(dip.standings ?? {}), [k]: band };
  return was !== band ? { type: 'standingChanged', ai, toward, standing: band } : null;
}

/** Draft-only: peace agreed clears a Warlord's hardening toward that seat. */
export function clearHardened(s: GameState, ai: PlayerId, toward: PlayerId): void {
  const dip = s.diplomacy;
  if (!dip?.hardened) return;
  const k = pairKey(ai, toward);
  if (dip.hardened.includes(k)) dip.hardened = dip.hardened.filter((x) => x !== k);
}
