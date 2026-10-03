// v5 C "the war in ink" (_claude/v5/PROPOSAL.md §4 C): the game's memory, built from the event stream as the
// board plays it, saved next to the game (GameMeta.story), and read back as the end-of-game replay, its three
// turning points, the grudge ticks under the seat rings, a stone's history, the holding dab's breakdown and the
// rematch's first seat. Pure: plain data in, plain data and plain sentences out.

import {
  CONTINENTS,
  CONTINENT_IDS,
  TERRITORY_IDS,
  type ContinentId,
  type GameState,
  type PlayerColorId,
  type PlayerId,
  type ReinforcementBreakdown,
  type TerritoryId,
} from '../engine';
import { SEP, cName, pName, plural, seatRef, tName } from './copy';
import type { ReplayVM } from './viewModel';

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

/** One board at a round's start: owners and armies in TERRITORY_IDS order (owner −1 = nobody). */
export interface StorySnap {
  r: number;
  o: number[];
  a: number[];
}

export interface StoryLedger {
  /** Round-start boards, oldest first (one per round; ~84 small numbers each). */
  snaps: StorySnap[];
  /** Every conquest in play order: [round, territory, by, from]. */
  took: [number, TerritoryId, PlayerId, PlayerId][];
  /** Every knockout: [round, player, by]. */
  outs: [number, PlayerId, PlayerId][];
}

export function emptyStory(): StoryLedger {
  return { snaps: [], took: [], outs: [] };
}

/** A saved ledger from this or an older build: keep what is well-formed for this map. */
export function restoreStory(x: unknown): StoryLedger {
  const out = emptyStory();
  if (!x || typeof x !== 'object') return out;
  const o = x as Partial<StoryLedger>;
  const n = TERRITORY_IDS.length;
  const known = new Set<string>(TERRITORY_IDS);
  if (Array.isArray(o.snaps)) {
    for (const s of o.snaps) {
      if (s && typeof s.r === 'number' && Array.isArray(s.o) && Array.isArray(s.a) && s.o.length === n && s.a.length === n) out.snaps.push({ r: s.r, o: [...s.o], a: [...s.a] });
    }
  }
  if (Array.isArray(o.took)) {
    for (const t of o.took) if (Array.isArray(t) && t.length === 4 && known.has(t[1] as string)) out.took.push([t[0], t[1], t[2], t[3]] as StoryLedger['took'][number]);
  }
  if (Array.isArray(o.outs)) {
    for (const t of o.outs) if (Array.isArray(t) && t.length === 3) out.outs.push([t[0], t[1], t[2]]);
  }
  return out;
}

/** The board at the start of round `round` (called on that round's first turnStarted). Once per round. */
export function noteRoundStart(l: StoryLedger, s: GameState, round: number): void {
  if (round < 1 || l.snaps.some((x) => x.r === round)) return;
  l.snaps.push({
    r: round,
    o: TERRITORY_IDS.map((t) => s.territories[t]?.owner ?? -1),
    a: TERRITORY_IDS.map((t) => s.territories[t]?.armies ?? 0),
  });
}

export function noteConquest(l: StoryLedger, round: number, t: TerritoryId, by: PlayerId, from: PlayerId): void {
  l.took.push([round, t, by, from]);
}

export function noteOut(l: StoryLedger, round: number, player: PlayerId, by: PlayerId): void {
  if (l.outs.some((x) => x[1] === player)) return;
  l.outs.push([round, player, by]);
}

// ---------------------------------------------------------------------------
// Grudges that last (C2) and a stone's history (F5)
// ---------------------------------------------------------------------------

/**
 * Per seat, the territories it has taken from `reader` this game, net of the ones the reader took back. A
 * territory taken from the reader stays that seat's mark until the reader takes it back (passing it on to a
 * third seat does not clear what the first one did).
 */
export function grudgeTicks(l: StoryLedger, reader: PlayerId): Record<number, number> {
  const mark = new Map<TerritoryId, PlayerId>();
  for (const [, t, by, from] of l.took) {
    if (from === reader) mark.set(t, by);
    else if (by === reader) mark.delete(t);
  }
  const out: Record<number, number> = {};
  for (const by of mark.values()) if (by !== reader) out[by] = (out[by] ?? 0) + 1;
  return out;
}

/** 'Ural · 19 · held since round 3 · taken from Sage' · 'Ural · 19 · held since the deal'. */
export function stoneHistory(l: StoryLedger, s: GameState, t: TerritoryId): string {
  const tile = s.territories[t];
  const head = `${tName(t)}${SEP}${tile?.armies ?? 0}`;
  let last: StoryLedger['took'][number] | null = null;
  for (const x of l.took) if (x[1] === t) last = x;
  if (!last || !tile || last[2] !== tile.owner) return `${head}${SEP}held since the deal`;
  const from = last[3] >= 0 && s.players[last[3]] ? `${SEP}taken from ${pName(s, last[3])}` : '';
  return `${head}${SEP}held since round ${Math.max(1, last[0])}${from}`;
}

// ---------------------------------------------------------------------------
// The turn ritual (E1): the holding dab's breakdown
// ---------------------------------------------------------------------------

/** '14 territories +4 · Asia +7 · cards +6': where this turn's armies came from. */
export function holdingBreakdown(b: ReinforcementBreakdown, cards = 0): string {
  const parts = [`${plural(b.territoryCount, 'territory', 'territories')} +${b.base}`];
  for (const c of b.continents) parts.push(`${cName(c.continent)} +${c.bonus}`);
  if (cards > 0) parts.push(`cards +${cards}`);
  return parts.join(SEP);
}

// ---------------------------------------------------------------------------
// Rematch (C3): the loser goes first
// ---------------------------------------------------------------------------

/**
 * Who opens the rematch: the human knocked out earliest; else the human (not the winner) with the fewest
 * territories (then armies). A table whose only human won (or has none) hands it to the last-placed seat.
 */
export function rematchFirst(s: GameState, winner: PlayerId | null): PlayerId {
  const seats = s.players.filter((p) => !p.neutral);
  let pool = seats.filter((p) => p.kind === 'human' && p.id !== winner);
  if (!pool.length) pool = seats.filter((p) => p.id !== winner);
  if (!pool.length) return seats[0]?.id ?? 0;
  const out = pool.filter((p) => p.eliminated).sort((a, b) => (a.eliminatedOnTurn ?? 0) - (b.eliminatedOnTurn ?? 0) || a.id - b.id);
  if (out.length) return out[0].id;
  const terr = (id: PlayerId) => TERRITORY_IDS.filter((t) => s.territories[t].owner === id).length;
  const arm = (id: PlayerId) => TERRITORY_IDS.reduce((n, t) => n + (s.territories[t].owner === id ? s.territories[t].armies : 0), 0);
  return [...pool].sort((a, b) => terr(a.id) - terr(b.id) || arm(a.id) - arm(b.id) || a.id - b.id)[0].id;
}

// ---------------------------------------------------------------------------
// The replay (C1): one frame per round, one sentence per round, three turning points
// ---------------------------------------------------------------------------

/** The whole replay lands in 15–20 s; very short or very long games clamp per round. */
export const REPLAY_TOTAL_MS = 17_000;
export const REPLAY_MIN_ROUND_MS = 450;
export const REPLAY_MAX_ROUND_MS = 2_500;

export function replayMsPerRound(rounds: number): number {
  if (rounds <= 0) return REPLAY_MAX_ROUND_MS;
  return Math.round(Math.min(REPLAY_MAX_ROUND_MS, Math.max(REPLAY_MIN_ROUND_MS, REPLAY_TOTAL_MS / rounds)));
}

interface Frame {
  round: number;
  /** Owner per territory, TERRITORY_IDS order, at the round's end. */
  o: number[];
  a: number[];
}

function boardOf(s: GameState): { o: number[]; a: number[] } {
  return { o: TERRITORY_IDS.map((t) => s.territories[t]?.owner ?? -1), a: TERRITORY_IDS.map((t) => s.territories[t]?.armies ?? 0) };
}

/** Round-end boards: round r ends where round r + 1 starts; the last round ends on the final board. */
function frames(l: StoryLedger, final: GameState): Frame[] {
  const last = Math.max(1, final.round);
  const byRound = new Map(l.snaps.map((x) => [x.r, x]));
  const out: Frame[] = [];
  for (let r = 1; r <= last; r++) {
    if (r === last) out.push({ round: r, ...boardOf(final) });
    else {
      const next = byRound.get(r + 1);
      if (next) out.push({ round: r, o: next.o, a: next.a });
    }
  }
  return out;
}

const TIMES = ['', 'once', 'twice', 'three times', 'four times', 'five times', 'six times'];
function times(n: number): string {
  return TIMES[n] ?? `${n} times`;
}

function colorOf(s: GameState, p: number): PlayerColorId | 'neutral' | null {
  const pl = p >= 0 ? s.players[p] : null;
  if (!pl) return null;
  return pl.neutral ? 'neutral' : pl.color;
}

function holderOf(o: number[], c: ContinentId): number {
  const idx = CONTINENTS[c].territories.map((t) => TERRITORY_IDS.indexOf(t));
  const first = o[idx[0]];
  return first >= 0 && idx.every((i) => o[i] === first) ? first : -1;
}

/** The round's one sentence, from its biggest event (no round number: the replay writes that itself). */
export function roundSentence(l: StoryLedger, s: GameState, round: number, end: number[] | null, prev: number[] | null): string {
  const outs = l.outs.filter((x) => x[0] === round);
  if (outs.length) {
    const [, p, by] = outs[0];
    return `${pName(s, p)} was knocked out by ${pName(s, by)}`;
  }
  if (end) {
    let best: { c: ContinentId; p: number } | null = null;
    for (const c of CONTINENT_IDS) {
      const h = holderOf(end, c);
      if (h < 0 || s.players[h]?.neutral) continue;
      if (prev && holderOf(prev, c) === h) continue;
      if (!best || CONTINENTS[c].bonus > CONTINENTS[best.c].bonus) best = { c, p: h };
    }
    if (best) return `${pName(s, best.p)} took ${cName(best.c)}`;
  }
  const took = l.took.filter((x) => x[0] === round);
  const perT = new Map<TerritoryId, number>();
  for (const x of took) perT.set(x[1], (perT.get(x[1]) ?? 0) + 1);
  const hot = [...perT.entries()].sort((a, b) => b[1] - a[1])[0];
  if (hot && hot[1] >= 2) return `${tName(hot[0])} changed hands ${times(hot[1])}`;
  const perP = new Map<number, StoryLedger['took']>();
  for (const x of took) perP.set(x[2], [...(perP.get(x[2]) ?? []), x]);
  const top = [...perP.entries()].sort((a, b) => b[1].length - a[1].length || a[0] - b[0])[0];
  if (top) {
    const [p, xs] = top;
    if (xs.length === 1) {
      const [, t, , from] = xs[0];
      return from >= 0 && s.players[from] ? `${pName(s, p)} took ${tName(t)} from ${pName(s, from)}` : `${pName(s, p)} took ${tName(t)}`;
    }
    return `${pName(s, p)} took ${xs.length} territories`;
  }
  return 'No territory changed hands';
}

interface Candidate {
  round: number;
  kind: 'out' | 'held' | 'lead' | 'contested' | 'rampage';
  score: number;
  text: string;
}

/** The game's turning points as candidates, each scored; `moments` picks three. */
export function momentCandidates(l: StoryLedger, s: GameState, winner: PlayerId): Candidate[] {
  const out: Candidate[] = [];
  const human = (p: number) => s.players[p]?.kind === 'human';
  for (const [r, p, by] of l.outs) {
    out.push({ round: r, kind: 'out', score: 100 + (human(p) || human(by) ? 30 : 0), text: `Round ${r}: ${pName(s, p)} was knocked out by ${pName(s, by)}` });
  }
  // A territory that changed hands again and again in one round.
  const perRT = new Map<string, number>();
  for (const [r, t] of l.took) perRT.set(`${r}|${t}`, (perRT.get(`${r}|${t}`) ?? 0) + 1);
  for (const [k, n] of perRT) {
    if (n < 2) continue;
    const [r, t] = k.split('|');
    out.push({ round: Number(r), kind: 'contested', score: 40 + 15 * n, text: `Round ${r}: ${tName(t as TerritoryId)} changed hands ${times(n)}` });
  }
  // A seat's biggest round (never outranks a knockout).
  const perRP = new Map<string, number>();
  for (const [r, , by] of l.took) perRP.set(`${r}|${by}`, (perRP.get(`${r}|${by}`) ?? 0) + 1);
  for (const [k, n] of perRP) {
    if (n < 4) continue;
    const [r, p] = k.split('|').map(Number);
    out.push({ round: r, kind: 'rampage', score: Math.min(80, 30 + 5 * n), text: `Round ${r}: ${pName(s, p)} took ${n} territories` });
  }
  const fr = frames(l, s);
  if (fr.length) {
    // The longest-held continent: held to the end, or the longest run that broke (3 rounds or more). A continent
    // held since the first round was dealt, not taken: it is a turning point only when nothing else is. The
    // winner's and the humans' continents come first.
    const weight = (p: number, startIdx: number) => (startIdx === 0 ? -40 : 0) + (p === winner || human(p) ? 10 : 0);
    for (const c of CONTINENT_IDS) {
      let runStart = -1;
      let holder = -1;
      for (let i = 0; i < fr.length; i++) {
        const h = holderOf(fr[i].o, c);
        if (h !== holder) {
          if (holder >= 0 && !s.players[holder]?.neutral) {
            const len = fr[i - 1].round - fr[runStart].round + 1;
            if (len >= 3) out.push({ round: fr[runStart].round, kind: 'held', score: 45 + 3 * len + CONTINENTS[c].bonus + weight(holder, runStart), text: `Round ${fr[runStart].round}: ${pName(s, holder)} took ${cName(c)} and held it ${len} rounds` });
          }
          holder = h;
          runStart = i;
        }
      }
      if (holder >= 0 && !s.players[holder]?.neutral && runStart >= 0) {
        const len = fr[fr.length - 1].round - fr[runStart].round + 1;
        if (len >= 2 || fr.length <= 2) {
          out.push({ round: fr[runStart].round, kind: 'held', score: 60 + 3 * len + CONTINENTS[c].bonus + weight(holder, runStart), text: `Round ${fr[runStart].round}: ${pName(s, holder)} took ${cName(c)} and held it to the end` });
        }
      }
    }
    // The round the winner took the lead for good, if someone else led before it.
    const count = (o: number[], p: number) => o.filter((x) => x === p).length;
    const leads = (o: number[]) => s.players.every((q) => q.id === winner || count(o, q.id) < count(o, winner));
    let from = -1;
    for (let i = fr.length - 1; i >= 0; i--) {
      if (leads(fr[i].o)) from = i;
      else break;
    }
    if (from > 0) out.push({ round: fr[from].round, kind: 'lead', score: 70, text: `Round ${fr[from].round}: ${pName(s, winner)} took the lead and kept it` });
  }
  return out;
}

/** Three turning points, different kinds first, told in game order. */
export function pickMoments(cands: Candidate[], n = 3): string[] {
  const sorted = [...cands].sort((a, b) => b.score - a.score || a.round - b.round);
  const picked: Candidate[] = [];
  // Three different moments of the game: a new kind in a new round first, then a new kind, then the best left.
  const pass = (ok: (c: Candidate) => boolean) => {
    for (const c of sorted) {
      if (picked.length >= n) return;
      if (!picked.includes(c) && ok(c)) picked.push(c);
    }
  };
  pass((c) => !picked.some((p) => p.kind === c.kind || p.round === c.round));
  pass((c) => !picked.some((p) => p.kind === c.kind));
  for (const c of sorted) {
    if (picked.length >= n) break;
    if (!picked.includes(c)) picked.push(c);
  }
  return picked.sort((a, b) => a.round - b.round || b.score - a.score).map((c) => c.text);
}

export function buildMoments(l: StoryLedger, s: GameState, winner: PlayerId): string[] {
  const m = pickMoments(momentCandidates(l, s, winner));
  if (m.length) return m;
  const held = TERRITORY_IDS.filter((t) => s.territories[t].owner === winner).length;
  return [`Round ${Math.max(1, s.round)}: ${pName(s, winner)} held ${plural(held, 'territory', 'territories')}`];
}

/** The replay, built at the end of the game from the ledger and the final board. */
export function buildReplay(l: StoryLedger, s: GameState, winner: PlayerId, key: number): ReplayVM {
  const fr = frames(l, s);
  const rounds: ReplayVM['rounds'] = [];
  let prev: number[] | null = null;
  for (const f of fr) {
    const owners: ReplayVM['rounds'][number]['owners'] = {};
    TERRITORY_IDS.forEach((t, i) => {
      const c = colorOf(s, f.o[i]);
      if (c) owners[t] = c;
    });
    rounds.push({ round: f.round, owners, line: roundSentence(l, s, f.round, f.o, prev) });
    prev = f.o;
  }
  return { key, winner: seatRef(s, winner), rounds, moments: buildMoments(l, s, winner), msPerRound: replayMsPerRound(rounds.length) };
}

/** The board as it stood at the end of replay frame `index` (owners and armies), for the board to re-soak to. */
export function replayBoard(l: StoryLedger, s: GameState, index: number): GameState | null {
  const f = frames(l, s)[index];
  if (!f) return null;
  const territories = { ...s.territories };
  TERRITORY_IDS.forEach((t, i) => {
    territories[t] = { owner: f.o[i], armies: Math.max(f.o[i] >= 0 ? 1 : 0, f.a[i]) };
  });
  return { ...s, territories, round: f.round };
}
