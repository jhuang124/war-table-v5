import { expect } from 'vitest';
import {
  applyAction,
  cloneState,
  createGame,
  mapOf,
  TERRITORY_IDS,
  type Action,
  type ActionResult,
  type GameConfig,
  type GameEvent,
  type GameState,
  type Phase,
  type PlayerConfig,
  type PlayerId,
  type TerritoryId,
} from '../../src/engine';

const COLORS = ['crimson', 'cobalt', 'emerald', 'amber'] as const;
export const NAMES = ['Ann', 'Ben', 'Cat', 'Dan'];

export function seats(n: number, kind: 'human' | 'ai' = 'human'): PlayerConfig[] {
  return Array.from({ length: n }, (_, i) => ({
    name: NAMES[i],
    color: COLORS[i],
    kind,
    ...(kind === 'ai' ? { difficulty: 'normal' as const } : {}),
  }));
}

export function config(n: number, over: Partial<GameConfig> = {}): GameConfig {
  return {
    players: seats(n),
    setupMode: 'random',
    initialPlacement: 'auto',
    setupBatch: 5,
    cardBonus: 'progressive',
    fortifyRule: 'connected',
    dominationPercent: 100,
    turnLimit: null,
    seed: 12345,
    ...over,
  };
}

export function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

/** Apply to a deep-frozen copy of `state` (so any mutation throws), expect ok. */
export function act(state: GameState, action: Action): { state: GameState; events: GameEvent[] } {
  const frozen = deepFreeze(cloneState(state));
  const before = JSON.stringify(frozen);
  const r = applyAction(frozen, action);
  expect(JSON.stringify(frozen)).toBe(before);
  if (!r.ok) throw new Error(`expected ok for ${JSON.stringify(action)}, got: ${r.error}`);
  return { state: r.state, events: r.events };
}

/** Apply and expect a rejection; returns the error. */
export function reject(state: GameState, action: Action): string {
  const frozen = deepFreeze(cloneState(state));
  const r = applyAction(frozen, action);
  if (r.ok) throw new Error(`expected rejection for ${JSON.stringify(action)}`);
  expect(typeof r.error).toBe('string');
  expect(r.error.length).toBeGreaterThan(3);
  return r.error;
}

export function types(events: GameEvent[]): string[] {
  return events.map((e) => e.type);
}

export function cardId(t: TerritoryId): number {
  return TERRITORY_IDS.indexOf(t);
}

/** First `k` card ids with the given symbol (0 = infantry, 1 = cavalry, 2 = artillery by index % 3). */
export function idsBySymbol(symbol: 'infantry' | 'cavalry' | 'artillery', k: number, skip = 0): number[] {
  const r = { infantry: 0, cavalry: 1, artillery: 2 }[symbol];
  const out: number[] = [];
  for (let i = 0; i < 42 && out.length < k + skip; i++) if (i % 3 === r) out.push(i);
  return out.slice(skip);
}

export interface ScenarioOpts {
  players?: number;
  /** Owner of every territory not listed in `terr` (default 0), 1 army each. */
  fill?: PlayerId;
  terr?: Partial<Record<TerritoryId, [PlayerId, number]>>;
  phase?: Phase;
  current?: PlayerId;
  /** Card ids moved from the deck into each player's hand. */
  cards?: Partial<Record<PlayerId, number[]>>;
  config?: Partial<GameConfig>;
  conquered?: boolean;
}

/** A hand-built mid-game state (consistent: 44 cards, eliminated flags match territory counts). */
export function scenario(o: ScenarioOpts = {}): GameState {
  const n = o.players ?? 2;
  const s = cloneState(createGame(config(n, o.config)).state);
  for (const t of mapOf(s).territoryIds) {
    const spec = o.terr?.[t];
    s.territories[t] = spec ? { owner: spec[0], armies: spec[1] } : { owner: o.fill ?? 0, armies: 1 };
  }
  for (const p of s.players) {
    p.cards = [];
    p.setupArmies = 0;
  }
  const all = [...s.deck, ...s.discard];
  s.discard = [];
  for (const [pid, ids] of Object.entries(o.cards ?? {})) {
    for (const id of ids ?? []) {
      const i = all.findIndex((c) => c.id === id);
      if (i < 0) throw new Error(`card ${id} not available`);
      s.players[Number(pid)].cards.push(all[i]);
      all.splice(i, 1);
    }
  }
  s.deck = all;
  for (const p of s.players) {
    p.eliminated = !mapOf(s).territoryIds.some((t) => s.territories[t].owner === p.id);
  }
  s.currentPlayer = o.current ?? 0;
  s.firstPlayer = 0;
  s.round = 1;
  s.turn = 1;
  s.phase = o.phase ?? { kind: 'attack' };
  s.conqueredThisTurn = o.conquered ?? false;
  return s;
}

/** Try rng values until `pred` holds for the result of `action`; returns that result. */
export function findOutcome(
  state: GameState,
  action: Action,
  pred: (r: Extract<ActionResult, { ok: true }>) => boolean,
  tries = 5000,
): { state: GameState; events: GameEvent[]; rng: number } {
  for (let seed = 1; seed <= tries; seed++) {
    const s = cloneState(state);
    s.rng = seed;
    const r = applyAction(s, action);
    if (r.ok && pred(r)) return { state: r.state, events: r.events, rng: seed };
  }
  throw new Error('no rng produced the wanted outcome');
}

export function withRng(state: GameState, rng: number): GameState {
  const s = cloneState(state);
  s.rng = rng;
  return s;
}

/** Finish the current player's main turn with no attacks: dump reinforcements, end. */
export function passTurn(state: GameState): { state: GameState; events: GameEvent[] } {
  let s = state;
  const events: GameEvent[] = [];
  const p = s.currentPlayer;
  if (s.phase.kind === 'reinforce') {
    const ph = s.phase;
    if (ph.remaining > 0) {
      const t = mapOf(s).territoryIds.find((x) => s.territories[x].owner === p)!;
      const r = act(s, { type: 'reinforce', player: p, territory: t, count: ph.remaining });
      s = r.state;
      events.push(...r.events);
    }
    const r = act(s, { type: 'endReinforce', player: p });
    s = r.state;
    events.push(...r.events);
  }
  const r = act(s, { type: 'endTurn', player: p });
  events.push(...r.events);
  return { state: r.state, events };
}
