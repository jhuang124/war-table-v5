// A model of the renderer's event durations at 1× (UX.md §8.2), for the stub board's simulated mode
// and the reel-scheduling unit tests. The real renderer owns the real numbers; this only lets the
// controller's pacing be measured without WebGL.
//
// v4 (_claude/v4/PLAN.md §5b E5 "one motion grammar"): every playEvent carries a stakes tier, and an
// event with a tier is held inside that tier's band. The dice show (a human's 'full' roll) is the one
// exception: it is theatre, timed by the dice, never stretched or squeezed into the ladder.

import type { GameEvent } from '../engine';
import type { PlayEventOptions } from '../render/BoardView';

const BLITZ_CAP = 3000;

export type Tier = 0 | 1 | 2 | 3;

/** The duration ladder (E5): 0 tick · 1 stroke · 2 soak · 3 breath, in ms at 1×. */
export const TIER_BANDS: Readonly<Record<Tier, readonly [number, number]>> = {
  0: [160, 290],
  1: [400, 650],
  2: [650, 1200],
  3: [1600, 2400],
};

/**
 * The tier table (E5). A human's roll is a stroke (1); an AI's readable engagement is one tier-1 beat (the
 * stroke and the bone click) plus a tier-2 flood if it conquers. Events not listed (phase changes, setup
 * turns, truces, seat changes) have no motion of their own and get tier 0.
 */
export const EVENT_TIERS: Readonly<Partial<Record<GameEvent['type'], Tier>>> = {
  turnStarted: 0,
  armiesPlaced: 0,
  territoryClaimed: 0,
  cardsCaptured: 0,
  cardDrawn: 0,
  diceRolled: 1,
  armiesMoved: 1,
  cardsTraded: 1,
  territoryConquered: 2,
  continentGained: 2,
  continentLost: 2,
  playerEliminated: 3,
  gameOver: 3,
  territoriesDealt: 3,
};

export function eventTier(e: GameEvent): Tier {
  return EVENT_TIERS[e.type] ?? 0;
}

/** Clamp a duration into a tier's band (0 stays 0: an event with no motion of its own). */
export function inTier(ms: number, tier: Tier | undefined): number {
  if (tier === undefined || ms <= 0) return ms;
  const [lo, hi] = TIER_BANDS[tier];
  return Math.min(hi, Math.max(lo, ms));
}

/**
 * A readable AI engagement (v4 A1): one beat for the whole engagement's dice — the stroke draws and one
 * short bone click stands in for every roll (a blitz of six rolls is still one beat). Tier 1.
 */
export const READABLE_ROLL_MS = 420;

function diceMs(opts: PlayEventOptions | undefined): number {
  const seq = opts?.seq;
  if (opts?.style === 'readable') return (seq?.index ?? 0) === 0 ? READABLE_ROLL_MS : 0;
  if (opts?.style === 'brief') {
    // arrow 150 + hit ticks ≤ 400 in total across the engagement.
    const count = seq?.count ?? 1;
    const ticks = 400 / count;
    return (seq?.index ?? 0) === 0 ? 150 + ticks : ticks;
  }
  if (!seq || seq.count <= 1) return 1200;
  const { index, count } = seq;
  if (index === 0) return 700;
  if (index === count - 1) return 700;
  // Middle rolls: max(180, 600 × 0.75^(k−1)), scaled uniformly to fit the cap (floor 120).
  let total = 1400;
  for (let k = 1; k < count - 1; k++) total += Math.max(180, 600 * Math.pow(0.75, k - 1));
  const mid = Math.max(180, 600 * Math.pow(0.75, index - 1));
  if (total <= BLITZ_CAP) return mid;
  const scale = (BLITZ_CAP - 1400) / (total - 1400);
  return Math.max(120, mid * scale);
}

/** The v3 duration of one playEvent at speed 1, before the tier band. */
function rawDurationMs(e: GameEvent, opts?: PlayEventOptions): number {
  const brief = opts?.style === 'brief';
  switch (e.type) {
    case 'diceRolled':
      return diceMs(opts);
    case 'territoryConquered':
      return brief ? 250 : 650;
    case 'armiesMoved':
      if (e.reason === 'fortify') return Math.min(900, 220 * Math.max(1, (e.path?.length ?? 2) - 1));
      // An inline march is part of the conquest's 650 ms; a manual-count occupy move is 400 ms.
      return brief || opts?.inlineMarch ? 0 : 400;
    case 'continentGained':
      return 1150;
    case 'continentLost':
      return 300;
    case 'playerEliminated':
      return 1600;
    case 'cardsCaptured':
      return 300;
    case 'cardsTraded':
      return 400;
    case 'territoriesDealt':
      return 2500;
    case 'gameOver':
      return 2400;
    case 'armiesPlaced':
      return 290;
    case 'territoryClaimed':
      return 250;
    case 'turnStarted':
      return 0;
    default:
      return 0;
  }
}

/**
 * Duration in ms of one playEvent at speed 1. With `opts.tier` the event stays inside its tier's band
 * (E5), except a human's dice show ('full' diceRolled), which keeps the dice's own timing.
 */
export function eventDurationMs(e: GameEvent, opts?: PlayEventOptions): number {
  const ms = rawDurationMs(e, opts);
  const show = e.type === 'diceRolled' && (opts?.style ?? 'full') === 'full';
  return show ? ms : inTier(ms, opts?.tier);
}

/** Scale by animation speed: 2× halves (floor 80 ms), 0 = instant. */
export function scaledDuration(ms: number, speed: number): number {
  if (speed <= 0 || ms <= 0) return 0;
  if (speed === 1) return ms;
  return Math.max(80, ms / speed);
}
