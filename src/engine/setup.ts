// Game creation: config defaults/sanitizing, seat setup, deck, first player, deal or draft.

import { isPersonality } from './ai/personality';
import { buildDeck } from './cards';
import { afterTerritoriesAssigned, emit, setPhase, updatePeak, type Draft } from './flow';
import { dealMissions } from './missions';
import { STARTING_ARMIES, TERRITORY_IDS, mapIdOf } from './mapData';
import { randInt, shuffleInPlace, toSeed } from './rng';
import {
  UNCLAIMED,
  type GameConfig,
  type GameEvent,
  type GameState,
  type PlayerConfig,
  type PlayerId,
  type PlayerStats,
  type TerritoryId,
  type TerritoryState,
} from './types';

const COLORS = ['crimson', 'cobalt', 'emerald', 'amber', 'violet', 'rose'] as const;

/**
 * The 2-player neutral seat (config.neutral): a third of the board, dealt at random before anything
 * else, with `armiesEach` armies on every territory. Tuned with `npm run sim` so the first mover's
 * 2-player win rate sits near 50–60 % instead of ~76 %.
 */
export const NEUTRAL_SETUP = { territories: 14, armiesEach: 3, name: 'Neutral' };

/** Sensible defaults: random deal, auto placement, progressive cards, connected fortify, world domination. */
export function defaultConfig(players: PlayerConfig[]): GameConfig {
  return {
    players,
    setupMode: 'random',
    initialPlacement: 'auto',
    setupBatch: 5,
    cardBonus: 'progressive',
    fortifyRule: 'connected',
    dominationPercent: 100,
    turnLimit: null,
    // Seed generation is the one place outside game logic that may use Math.random.
    seed: Math.floor(Math.random() * 0x100000000) >>> 0,
  };
}

/** Human-readable problem with a config, or null if createGame will accept it. */
export function validateConfig(config: GameConfig): string | null {
  if (!config || typeof config !== 'object') return 'Missing game settings.';
  if (!Array.isArray(config.players) || config.players.length < 2 || config.players.length > 4)
    return 'Risk needs 2 to 4 players.';
  const colors = new Set<string>();
  for (const [i, p] of config.players.entries()) {
    if (!p || typeof p !== 'object') return `Seat ${i + 1} is empty.`;
    if (p.kind !== 'human' && p.kind !== 'ai') return `Seat ${i + 1} must be human or AI.`;
    if (!COLORS.includes(p.color as (typeof COLORS)[number])) return `Seat ${i + 1} needs a color.`;
    if (colors.has(p.color)) return 'Each player needs a different color.';
    colors.add(p.color);
  }
  return null;
}

/**
 * Fill gaps and clamp numbers so the engine never sees nonsense. Documented clamps:
 * setupBatch ≥ 1 (default 5); startingArmies ≥ enough to hold every territory dealt;
 * dominationPercent in [30, 100]; turnLimit null or ≥ 1.
 */
export function sanitizeConfig(config: GameConfig): GameConfig {
  const n = config.players.length;
  const int = (x: unknown, dflt: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.floor(x) : dflt);
  const minArmies = Math.ceil(TERRITORY_IDS.length / n);
  const players = config.players.map((p, i) => ({
    name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : `Player ${i + 1}`,
    color: p.color,
    kind: p.kind,
    ...(p.kind === 'ai' ? { difficulty: p.difficulty ?? 'normal' } : p.difficulty ? { difficulty: p.difficulty } : {}),
    ...(isPersonality(p.personality) ? { personality: p.personality } : {}),
  })) as PlayerConfig[];
  const out: GameConfig = {
    players,
    setupMode: config.setupMode === 'draft' ? 'draft' : 'random',
    initialPlacement: config.initialPlacement === 'manual' ? 'manual' : 'auto',
    setupBatch: Math.max(1, int(config.setupBatch, 5)),
    cardBonus: config.cardBonus === 'fixed' ? 'fixed' : 'progressive',
    fortifyRule: config.fortifyRule === 'adjacent' ? 'adjacent' : 'connected',
    dominationPercent: Math.min(100, Math.max(30, int(config.dominationPercent, 100))),
    turnLimit:
      config.turnLimit === null || config.turnLimit === undefined ? null : Math.max(1, int(config.turnLimit, 1)),
    seed: toSeed(int(config.seed, 0)),
  };
  if (config.startingArmies !== undefined) out.startingArmies = Math.max(minArmies, int(config.startingArmies, minArmies));
  // Additive flags: only written when on, so a classic config sanitizes to exactly what it did before.
  if (config.diplomacy === true) out.diplomacy = true;
  if (config.neutral === true && n === 2) out.neutral = true;
  // Missions need a third seat: two players on 21 territories each meet a mission in round 2 or 3.
  if (config.missions === true && (n >= 3 || out.neutral)) out.missions = true;
  // Map packs (docs/MAPS.md): keep the map so the save carries it; an unknown id plays classic.
  if (typeof config.mapId === 'string' && config.mapId) out.mapId = mapIdOf(config.mapId);
  return out;
}

export function emptyStats(): PlayerStats {
  return {
    territoriesConquered: 0,
    battlesWon: 0,
    battlesLost: 0,
    armiesDestroyed: 0,
    armiesLost: 0,
    cardsTraded: 0,
    reinforcementsReceived: 0,
    peakTerritories: 0,
  };
}

/**
 * Start a game. Throws only for configs `validateConfig` rejects (wrong seat count, duplicate
 * colors) — the UI should validate first. Events: gameStarted, then
 *   random: territoriesDealt → (auto) armiesPlaced×N(setup) → turnStarted → phaseChanged(reinforce)
 *                            → (manual) phaseChanged(setup-place) → setupTurn
 *   draft:  phaseChanged(setup-claim)
 * With config.neutral (2 players): the neutral seat is appended (id 2) and dealt its third first;
 *   random: its territories are in territoriesDealt, then armiesPlaced(setup) for its extra armies;
 *   draft:  territoryClaimed ×14 (neutral) → armiesPlaced(setup) ×14 → phaseChanged(setup-claim).
 * With config.missions (v5 G): one secret mission per seat (PlayerState.mission), dealt with state.rng
 *   after everything above; no event (the mission is secret; missionText reads it).
 */
export function createGame(inputConfig: GameConfig): { state: GameState; events: GameEvent[] } {
  const problem = validateConfig(inputConfig);
  if (problem) throw new Error(problem);
  const config = sanitizeConfig(inputConfig);
  const n = config.players.length;
  const starting = config.startingArmies ?? STARTING_ARMIES[n];

  const territories = {} as Record<TerritoryId, TerritoryState>;
  for (const t of TERRITORY_IDS) territories[t] = { owner: UNCLAIMED, armies: 0 };

  const s: GameState = {
    version: 1,
    id: '',
    config,
    players: config.players.map((p, i) => ({
      id: i,
      name: p.name,
      color: p.color,
      kind: p.kind,
      ...(p.kind === 'ai' ? { difficulty: p.difficulty ?? 'normal' } : {}),
      ...(p.personality ? { personality: p.personality } : {}),
      cards: [],
      eliminated: false,
      setupArmies: starting,
      stats: emptyStats(),
    })),
    territories,
    currentPlayer: 0,
    firstPlayer: 0,
    turn: 0,
    round: 0,
    phase: { kind: 'setup-claim' },
    deck: [],
    discard: [],
    tradeCount: 0,
    conqueredThisTurn: false,
    rng: config.seed,
    timeline: [],
  };
  const d: Draft = { s, ev: [] };

  let id = 'g_';
  for (let i = 0; i < 6; i++) id += '0123456789abcdefghijklmnopqrstuvwxyz'[randInt(s, 36)];
  s.id = id;

  s.deck = shuffleInPlace(s, buildDeck());
  s.firstPlayer = randInt(s, n);
  s.currentPlayer = s.firstPlayer;
  emit(d, { type: 'gameStarted', firstPlayer: s.firstPlayer });

  // 2-player neutral seat: appended after the real seats (id n), never in turn order.
  let open: TerritoryId[] = [...TERRITORY_IDS];
  const neutralId = config.neutral ? n : -1;
  if (config.neutral) {
    s.players.push({
      id: neutralId,
      name: NEUTRAL_SETUP.name,
      color: 'neutral',
      kind: 'ai',
      neutral: true,
      cards: [],
      eliminated: false,
      setupArmies: 0,
      stats: emptyStats(),
    });
    const pick = shuffleInPlace(s, [...TERRITORY_IDS]).slice(0, NEUTRAL_SETUP.territories);
    const taken = new Set(pick);
    for (const t of pick) s.territories[t] = { owner: neutralId, armies: NEUTRAL_SETUP.armiesEach };
    open = TERRITORY_IDS.filter((t) => !taken.has(t));
    updatePeak(d, neutralId);
  }

  if (config.setupMode === 'random') {
    const order = shuffleInPlace(s, open);
    const owners = {} as Record<TerritoryId, PlayerId>;
    order.forEach((t, i) => {
      const pid = (s.firstPlayer + i) % n;
      s.territories[t] = { owner: pid, armies: 1 };
      s.players[pid].setupArmies -= 1;
    });
    for (const t of TERRITORY_IDS) owners[t] = s.territories[t].owner;
    for (const p of s.players) p.setupArmies = Math.max(0, p.setupArmies);
    emit(d, { type: 'territoriesDealt', owners });
    if (config.neutral) neutralArmiesEvents(d, neutralId);
    for (const p of s.players) updatePeak(d, p.id);
    afterTerritoriesAssigned(d);
  } else {
    if (config.neutral) {
      for (const t of TERRITORY_IDS) {
        if (s.territories[t].owner === neutralId) emit(d, { type: 'territoryClaimed', player: neutralId, territory: t });
      }
      neutralArmiesEvents(d, neutralId);
    }
    setPhase(d, { kind: 'setup-claim' });
  }
  // v5 G: secret missions, dealt last so the board and the first turn match the same seed without them.
  if (config.missions) dealMissions(s);
  return { state: s, events: d.ev };
}

/** The neutral seat's armies beyond the first, as setup placements (so the display counts them in). */
function neutralArmiesEvents(d: Draft, neutralId: PlayerId): void {
  if (NEUTRAL_SETUP.armiesEach <= 1) return;
  for (const t of TERRITORY_IDS) {
    if (d.s.territories[t].owner !== neutralId) continue;
    emit(d, { type: 'armiesPlaced', player: neutralId, territory: t, count: NEUTRAL_SETUP.armiesEach - 1, source: 'setup' });
  }
}
