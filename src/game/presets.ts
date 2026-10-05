// New game screen (UX.md §4.1): the draft the menu edits, its GameConfig mapping, the length/setup
// presets with honest time estimates, the summary line, and the problems that block Start.

import { PLAYER_COLORS, PLAYER_COLOR_IDS, DEFAULT_SEAT_COLORS } from '../shared/palette';
import { isPersonality, PERSONALITY_IDS, STARTING_ARMIES, type AiPersonality, type GameConfig, type PlayerColorId } from '../engine';
import { DEFAULT_MAP_ID, mapIdOf } from '../map/packs';
import { SEP } from './copy';
import type { HouseRulesDraft, LengthPreset, NewGameVM, SeatDraft, SetupPreset } from './viewModel';

/** The neutral seat applies only to exactly 2 seats (engine ignores it otherwise). */
export function usesNeutral(d: NewGameDraft): boolean {
  return d.seats.length === 2 && d.house.neutral === true;
}

export interface NewGameDraft {
  seats: SeatDraft[];
  length: LengthPreset;
  setup: SetupPreset;
  house: HouseRulesDraft;
  /** v3: the map pack (docs/MAPS.md); absent = classic. */
  mapId?: string;
  /**
   * v5.1 D: the draft was written by a v5.1+ build (personalities absent = random, house rules off by default).
   * A remembered draft without it keeps its table (seats, length, map) and drops the old auto-filled
   * personalities and house-rule defaults.
   */
  v51?: true;
}

/**
 * v5.1 D: a seat keeps a personality only when one was chosen (under "More"); absent = random at Start
 * (`draftToConfig` draws it from the seed). Invalid values are dropped.
 */
export function fillPersonalities(seats: SeatDraft[]): SeatDraft[] {
  return seats.map((s) => {
    const { personality, ...rest } = s;
    return isPersonality(personality) ? { ...rest, personality } : rest;
  }) as SeatDraft[];
}

/** A small seeded generator (mulberry32) for the Start-time draws; never Math.random. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * v5.1 D "just randomize": every AI seat without a chosen personality gets one at random from the seed
 * (Turtle · Opportunist · Warlord). A table of up to three random AIs is dealt without repeats when it can be,
 * so a fresh table still meets different opponents; with more AIs than personalities the rest repeat at random.
 */
export function randomPersonalities(seats: SeatDraft[], seed: number): (AiPersonality | undefined)[] {
  const rnd = seeded(seed ^ 0x51a7e);
  const bag: AiPersonality[] = [];
  const draw = (): AiPersonality => {
    if (!bag.length) {
      const fresh = [...PERSONALITY_IDS];
      for (let i = fresh.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [fresh[i], fresh[j]] = [fresh[j], fresh[i]];
      }
      bag.push(...fresh);
    }
    return bag.shift()!;
  };
  return seats.map((s) => (s.kind !== 'ai' ? undefined : isPersonality(s.personality) ? s.personality : draw()));
}

/** v5 G Missions apply: a third seat at the table (3–4 players, or 2 with the neutral seat). */
export function missionsApply(d: NewGameDraft): boolean {
  return d.seats.length >= 3 || usesNeutral(d);
}

/**
 * v3 Truces apply (v5.1: standing): at least one human and one AI at the table. Every AI seat plays with a
 * personality since v5.1 (random when not chosen), so any AI counts.
 */
export function trucesApply(seats: { kind: SeatDraft['kind']; personality?: AiPersonality }[]): boolean {
  return seats.some((s) => s.kind === 'human') && seats.some((s) => s.kind === 'ai');
}

export function defaultDraft(): NewGameDraft {
  return {
    seats: [
      { name: PLAYER_COLORS[DEFAULT_SEAT_COLORS[0]].name, color: DEFAULT_SEAT_COLORS[0], kind: 'human', difficulty: 'normal' },
      { name: PLAYER_COLORS[DEFAULT_SEAT_COLORS[1]].name, color: DEFAULT_SEAT_COLORS[1], kind: 'ai', difficulty: 'normal' },
      { name: PLAYER_COLORS[DEFAULT_SEAT_COLORS[2]].name, color: DEFAULT_SEAT_COLORS[2], kind: 'ai', difficulty: 'normal' },
      { name: PLAYER_COLORS[DEFAULT_SEAT_COLORS[3]].name, color: DEFAULT_SEAT_COLORS[3], kind: 'ai', difficulty: 'normal' },
    ],
    length: 'evening',
    setup: 'quickDeal',
    // v5.1 D: house rules off (neutral seat, missions); standing (`truces`, config.diplomacy) is the game, not a rule.
    house: { draft: false, cardBonus: 'progressive', fortifyRule: 'connected', setupBatch: 'auto', seed: null, neutral: false, truces: true, missions: false },
    mapId: DEFAULT_MAP_ID,
    v51: true,
  };
}

/** Sanitize a remembered draft (from localStorage) into a valid one. */
export function sanitizeDraft(x: unknown): NewGameDraft {
  const d = defaultDraft();
  if (!x || typeof x !== 'object') return d;
  const o = x as Partial<NewGameDraft>;
  // A pre-v5.1 draft: its personalities were auto-filled and its house rules were the old defaults, not choices.
  const fresh = o.v51 === true;
  const seats = Array.isArray(o.seats)
    ? o.seats
        .filter((s) => s && typeof s === 'object' && PLAYER_COLOR_IDS.includes(s.color))
        .slice(0, 4)
        .map((s) => ({
          // Older drafts defaulted humans to "Player N"; seats now default to their color's name (R1-16). A name
          // that is a colour id ('Cobalt', from before the ink palette) is the old default too: its display name.
          name:
            typeof s.name === 'string' && !/^Player \d$/.test(s.name.trim()) && !(PLAYER_COLOR_IDS as string[]).includes(s.name.trim().toLowerCase())
              ? s.name.slice(0, 24)
              : PLAYER_COLORS[s.color].name,
          color: s.color,
          kind: s.kind === 'ai' ? ('ai' as const) : ('human' as const),
          difficulty: s.difficulty === 'easy' || s.difficulty === 'hard' ? s.difficulty : ('normal' as const),
          ...(fresh && isPersonality(s.personality) ? { personality: s.personality } : {}),
        }))
    : d.seats;
  return {
    seats: fillPersonalities(seats.length >= 2 ? seats : d.seats),
    mapId: mapIdOf(typeof o.mapId === 'string' ? o.mapId : null),
    length: o.length === 'quick' || o.length === 'full' ? o.length : 'evening',
    setup: o.setup === 'placeOwn' ? 'placeOwn' : 'quickDeal',
    v51: true,
    house: {
      draft: !!o.house?.draft,
      cardBonus: o.house?.cardBonus === 'fixed' ? 'fixed' : 'progressive',
      fortifyRule: o.house?.fortifyRule === 'adjacent' ? 'adjacent' : 'connected',
      setupBatch:
        typeof o.house?.setupBatch === 'number' && o.house.setupBatch >= 1 ? Math.floor(o.house.setupBatch) : 'auto',
      seed: typeof o.house?.seed === 'number' && Number.isFinite(o.house.seed) ? o.house.seed >>> 0 : null,
      // v5.1 D: the neutral seat is off unless switched on (a pre-v5.1 draft's `true` was the old default)
      neutral: fresh && o.house?.neutral === true,
      truces: o.house?.truces !== false,
      // v5 G: off unless switched on
      missions: fresh && o.house?.missions === true,
    },
  };
}

/**
 * Win rules per length preset. 2 players are dealt 50% each, so their thresholds sit higher (lead notes).
 * With the neutral seat each player starts on a third of the board, as in a 3-player game, so 2 players
 * use the 3-player thresholds.
 */
export function lengthRules(
  length: LengthPreset,
  players: number,
  neutral = false,
): { dominationPercent: number; turnLimit: number | null } {
  const two = players === 2 && !neutral;
  switch (length) {
    case 'quick':
      return { dominationPercent: two ? 75 : 60, turnLimit: 12 };
    case 'evening':
      return { dominationPercent: two ? 80 : 70, turnLimit: null };
    case 'full':
      return { dominationPercent: 100, turnLimit: null };
  }
}

/** Two passes of manual placement: ceil((startingArmies − floor(42 / n)) / 2) → 10 for 2p/4p, 11 for 3p. */
export function autoSetupBatch(players: number, startingArmies = STARTING_ARMIES[players] ?? 30): number {
  return Math.max(1, Math.ceil((startingArmies - Math.floor(42 / players)) / 2));
}

export function territoriesToWin(percent: number): number {
  return Math.ceil((42 * percent) / 100);
}

export function draftToConfig(d: NewGameDraft, seed: number): GameConfig {
  const n = d.seats.length;
  const neutral = usesNeutral(d);
  const { dominationPercent, turnLimit } = lengthRules(d.length, n, neutral);
  // v5.1 D: an AI seat without a chosen personality gets one at random from the seed.
  const drawn = randomPersonalities(d.seats, d.house.seed ?? seed);
  const players = d.seats.map((s, i) => ({
    name: s.name.trim() || PLAYER_COLORS[s.color].name,
    color: s.color,
    kind: s.kind,
    ...(s.kind === 'ai' ? { difficulty: s.difficulty } : {}),
    ...(s.kind === 'ai' && drawn[i] ? { personality: drawn[i] } : {}),
  }));
  const diplomacy = d.house.truces !== false && trucesApply(players);
  return {
    ...(neutral ? { neutral: true } : {}),
    ...(diplomacy ? { diplomacy: true } : {}),
    ...(d.house.missions === true && missionsApply(d) ? { missions: true } : {}),
    mapId: mapIdOf(d.mapId ?? null),
    players,
    setupMode: d.house.draft ? 'draft' : 'random',
    initialPlacement: d.setup === 'placeOwn' ? 'manual' : 'auto',
    setupBatch: d.house.setupBatch === 'auto' ? autoSetupBatch(n) : d.house.setupBatch,
    cardBonus: d.house.cardBonus,
    fortifyRule: d.house.fortifyRule,
    dominationPercent,
    turnLimit,
    seed: d.house.seed ?? seed,
  };
}

// Rounds until someone first holds X% of the board: [median, p90] for normal AIs, from
// `npm run sim -- 200` (SPEC §11.1; 100 games per player count, 2026-09-27; re-checked 2026-09-30,
// unchanged). Re-run and paste if the AI or the rules change.
const ROUNDS: Record<number, Record<number, [number, number]>> = {
  2: { 60: [1, 3], 70: [4, 7], 75: [4, 8], 80: [5, 9], 100: [8, 11] },
  3: { 60: [6, 11], 70: [8, 15], 75: [9, 18], 80: [10, 18], 100: [13, 22] },
  4: { 60: [8, 14], 70: [11, 19], 75: [12, 21], 80: [13, 26], 100: [15, 31] },
};
/** 2 players plus the neutral seat (`2p+neutral` line of `npm run sim`, 100 games, 2026-09-30). */
const ROUNDS_2P_NEUTRAL: Record<number, [number, number]> = { 60: [5, 8], 70: [7, 12], 75: [7, 13], 80: [8, 13], 100: [12, 18] };
/** Humans attack less eagerly than the sim's AIs, so real games run a few more rounds. */
const HUMAN_ROUND_FACTOR = 1.3;
/** Seconds per human turn: UX.md §4.3 puts early turns at 60–90 s; later turns carry more fights. */
const HUMAN_TURN_S = 80;
/** Seconds per AI turn at `watch`: measured in the real app (tests/e2e/round.e2e.ts, median ≈ 5 s). */
const AI_TURN_S = 5;

function fmtRange(loMin: number, hiMin: number): string {
  const r5 = (m: number) => Math.max(5, Math.round(m / 5) * 5);
  if (hiMin <= 100) {
    const a = r5(loMin);
    const b = r5(hiMin);
    return a === b ? `~${a} min` : `~${a}–${b} min`;
  }
  const h = (m: number) => Math.max(1, Math.round((m / 60) * 2) / 2);
  const a = h(loMin);
  const b = h(hiMin);
  const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
  return a === b ? `~${fmt(a)} h` : `~${fmt(a)}–${fmt(b)} h`;
}

export function lengthEstimate(length: LengthPreset, seats: SeatDraft[], neutral = false): string {
  const n = Math.min(4, Math.max(2, seats.length));
  const withNeutral = neutral && n === 2;
  const { dominationPercent, turnLimit } = lengthRules(length, n, withNeutral);
  const table = withNeutral ? ROUNDS_2P_NEUTRAL : ROUNDS[n];
  const row = table[dominationPercent] ?? table[70];
  const humans = seats.filter((s) => s.kind === 'human').length;
  const perRound = humans * HUMAN_TURN_S + (n - humans) * AI_TURN_S;
  const cap = (r: number) => (turnLimit ? Math.min(turnLimit, r) : r);
  // Centre on the median; the sim's p90 tail is long, so cap the top at 1.6× the median.
  const lo = (cap(row[0] * 0.8 * HUMAN_ROUND_FACTOR) * perRound) / 60;
  const hi = (cap(Math.min(row[1], row[0] * 1.6) * HUMAN_ROUND_FACTOR) * perRound) / 60;
  return fmtRange(lo, hi);
}

export function draftProblems(d: NewGameDraft): string[] {
  const out: string[] = [];
  const colors = new Map<PlayerColorId, number>();
  for (const s of d.seats) colors.set(s.color, (colors.get(s.color) ?? 0) + 1);
  for (const [c, n] of colors) if (n > 1) out.push(`Two seats share ${PLAYER_COLORS[c].name}`);
  const names = new Map<string, number>();
  for (const s of d.seats) {
    const k = s.name.trim().toLowerCase();
    if (k) names.set(k, (names.get(k) ?? 0) + 1);
  }
  for (const [k, n] of names) {
    if (n > 1) out.push(`Two seats are called ${d.seats.find((s) => s.name.trim().toLowerCase() === k)!.name.trim()}`);
  }
  if (d.seats.length < 2) out.push('At least 2 seats');
  return out;
}

export function draftSummary(d: NewGameDraft): string {
  const n = d.seats.length;
  const { dominationPercent, turnLimit } = lengthRules(d.length, n, usesNeutral(d));
  const deal = d.house.draft ? 'Territories claimed in turn' : 'Territories dealt at random';
  const place = d.setup === 'quickDeal' ? 'armies placed for you' : 'you place your own armies';
  const need = territoriesToWin(dominationPercent);
  // v5 G: with Missions on, a secret mission is the other way to win.
  const m = d.house.missions === true && missionsApply(d);
  const goal =
    dominationPercent >= 100
      ? `take every territory${m ? ' or complete your secret mission' : ''} to win`
      : turnLimit
        ? `first to ${need} territories${m ? ' or a secret mission' : ''}, or most after ${turnLimit} rounds`
        : `first to ${need} territories${m ? ' or a secret mission' : ''} wins`;
  return [deal, place, goal].join(SEP);
}

export function buildNewGameVM(d: NewGameDraft): NewGameVM {
  const n = d.seats.length;
  const neutral = usesNeutral(d);
  const q = lengthRules('quick', n, neutral);
  const e = lengthRules('evening', n, neutral);
  const problems = draftProblems(d);
  return {
    seats: d.seats,
    length: d.length,
    setup: d.setup,
    house: d.house,
    lengthOptions: [
      { id: 'quick', label: 'Quick', detail: `${q.dominationPercent}% or ${q.turnLimit} rounds`, estimate: lengthEstimate('quick', d.seats, neutral) },
      { id: 'evening', label: 'Evening', detail: `${e.dominationPercent}% of the world`, estimate: lengthEstimate('evening', d.seats, neutral) },
      { id: 'full', label: 'Full conquest', detail: 'every territory', estimate: lengthEstimate('full', d.seats, neutral) },
    ],
    setupOptions: [
      { id: 'quickDeal', label: 'Quick deal', detail: 'armies placed for you' },
      { id: 'placeOwn', label: 'Place your own', detail: '~3 min' },
    ],
    summary: draftSummary(d),
    canStart: problems.length === 0 && n >= 2 && n <= 4,
    problems,
    canAddSeat: n < 4,
    canRemoveSeat: n > 2,
    missionsApply: missionsApply(d),
  };
}

/**
 * Apply a seat patch with the naming conventions: every seat defaults to its color's name, a default
 * name follows the seat's color, and flipping Human/AI never renames a seat (R1-16).
 */
export function patchSeat(d: NewGameDraft, index: number, patch: Partial<SeatDraft>): NewGameDraft {
  const seats = d.seats.map((s) => ({ ...s }));
  const s = seats[index];
  if (!s) return d;
  const wasDefaultName =
    !s.name.trim() || /^Player \d$/.test(s.name.trim()) || s.name === PLAYER_COLORS[s.color].name;
  const next = { ...s, ...patch };
  if (patch.name === undefined && wasDefaultName) next.name = PLAYER_COLORS[next.color].name;
  seats[index] = next;
  return { ...d, seats: fillPersonalities(seats) };
}

export function addSeat(d: NewGameDraft): NewGameDraft {
  if (d.seats.length >= 4) return d;
  const used = new Set(d.seats.map((s) => s.color));
  const color = [...DEFAULT_SEAT_COLORS, ...PLAYER_COLOR_IDS].find((c) => !used.has(c)) ?? 'emerald';
  return {
    ...d,
    seats: fillPersonalities([...d.seats, { name: PLAYER_COLORS[color].name, color, kind: 'ai', difficulty: 'normal' }]),
  };
}

export function removeSeat(d: NewGameDraft, index: number): NewGameDraft {
  if (d.seats.length <= 2) return d;
  return { ...d, seats: d.seats.filter((_, i) => i !== index) };
}
