// v6 maps: the game layer and the shared palette read the game's own map (config.mapId), never the classic
// 42 / six continents. Runs on a twelve-territory fixture pack injected into src/map/packs.
//
// TODO(v6 merge): the engine builder registers a hidden `maps/test-twelve` pack. Once it is in, drop the
// vi.mock below and the FIXTURE: the same ids are used here ('test-twelve'), so the assertions stay; point
// the territory/continent ids at the real pack's if they differ.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MapManifest, MapRules, MapTopology } from '../../src/map/types';

const { ID, FIXTURE } = vi.hoisted(() => {
  const ID = 'test-twelve';
  const FIXTURE = (() => {
  const conts = [
    { id: 'north', name: 'Northmark', bonus: 3 },
    { id: 'middle', name: 'Midlands', bonus: 2 },
    { id: 'south', name: 'Southreach', bonus: 4 },
  ];
  const territories = conts.flatMap((c) => [1, 2, 3, 4].map((k) => ({ id: `${c.id}_${k}`, name: `${c.name} ${k}`, continent: c.id })));
  const borders: [string, string][] = [];
  for (const c of conts) for (const [a, b] of [[1, 2], [2, 3], [3, 4], [4, 1]]) borders.push([`${c.id}_${a}`, `${c.id}_${b}`]);
  borders.push(['north_3', 'middle_1'], ['middle_3', 'south_1'], ['south_3', 'north_1']);
  const manifest: MapManifest = { format: 1, id: ID, name: 'Test Twelve', description: 'Twelve territories, three continents.', presentation: { anchorClearance: 1 } };
  const rules: MapRules = { format: 1, seats: { min: 2, max: 4 }, startingArmies: { '2': 14, '3': 12, '4': 10 }, cardSymbols: ['infantry', 'cavalry', 'artillery'], continents: conts, territories };
  const topology: MapTopology = { format: 1, borders, seaLanes: [{ a: 'south_3', b: 'north_1' }] };
  return { manifest, rules, topology, rulesFrom: ID };
})();
  return { ID, FIXTURE };
});

vi.mock('../../src/map/packs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/map/packs')>();
  // Known to the rules side only (packIds stays as registered, so the geometry registry has nothing to load).
  const isKnownMap = (id: string | null | undefined): id is string => id === ID || real.isKnownMap(id);
  const mapIdOf = (x?: { mapId?: string } | string | null) => {
    const id = typeof x === 'string' ? x : x?.mapId;
    return id === ID ? ID : real.mapIdOf(x);
  };
  const packData = (id?: string | null) => (id === ID ? FIXTURE : real.packData(id));
  return { ...real, isKnownMap, mapIdOf, packData };
});

import { createGame, mapDefOf, type GameState, type PlayerConfig, type TerritoryId } from '../../src/engine';
import { cName, setCopyMap, tName } from '../../src/game/copy';
import { attackStake } from '../../src/game/strip';
import { autoSource } from '../../src/game/helpers';
import { buildReplay, emptyStory, noteConquest, noteRoundStart, restoreStory } from '../../src/game/story';
import { autoSetupBatch, buildNewGameVM, defaultDraft, draftSummary, draftToConfig, territoriesToWin } from '../../src/game/presets';
import { CONTINENT_TINTS, continentTint, continentTintIndex } from '../../src/shared/palette';
import { createController } from '../../src/game/controller';
import { memoryKV, SETTINGS_KEY } from '../../src/game/storage';
import type { AudioEngine } from '../../src/audio/types';
import type { BoardView } from '../../src/render/BoardView';

const def = () => mapDefOf({ mapId: ID });

const SEATS: PlayerConfig[] = [
  { name: 'John', color: 'crimson', kind: 'human' },
  { name: 'Sam', color: 'cobalt', kind: 'human' },
  { name: 'Priya', color: 'amber', kind: 'ai', difficulty: 'normal' },
];

/** A hand-set game on the fixture map: every territory Priya's (seat 2, 1 army) unless listed. */
function twelve(own: Partial<Record<string, [number, number]>> = {}): GameState {
  const { state } = createGame({ players: SEATS, setupMode: 'random', initialPlacement: 'auto', setupBatch: 5, cardBonus: 'progressive', fortifyRule: 'connected', dominationPercent: 70, turnLimit: null, seed: 7 });
  const s: GameState = { ...state, config: { ...state.config, mapId: ID }, territories: {} as GameState['territories'] };
  for (const t of def().territoryIds) s.territories[t] = { owner: 2, armies: 1 };
  for (const [t, v] of Object.entries(own)) s.territories[t as TerritoryId] = { owner: v![0], armies: v![1] };
  s.currentPlayer = 0;
  s.phase = { kind: 'attack' };
  s.round = 3;
  return s;
}

/** The engine plays rules per game (the engine builder's v6 change): createGame deals the map's territories. */
const engineReadsMaps = (() => {
  try {
    const { state } = createGame({ players: SEATS, setupMode: 'random', initialPlacement: 'auto', setupBatch: 5, cardBonus: 'progressive', fortifyRule: 'connected', dominationPercent: 70, turnLimit: null, seed: 3, mapId: ID });
    return Object.keys(state.territories).length === 12;
  } catch {
    return false;
  }
})();

describe('the fixture map', () => {
  it('is twelve territories in three continents', () => {
    expect(def().size).toBe(12);
    expect(def().continentIds).toEqual(['north', 'middle', 'south']);
  });
});

describe('presets read the chosen map (v6)', () => {
  it('thresholds are shares of the map, rounded up like the engine', () => {
    expect(territoriesToWin(70, { mapId: ID })).toBe(9);
    expect(territoriesToWin(60, { mapId: ID })).toBe(8);
    expect(territoriesToWin(100, { mapId: ID })).toBe(12);
    // classic unchanged
    expect(territoriesToWin(70)).toBe(30);
    expect(territoriesToWin(60)).toBe(26);
  });

  it("the New game summary names the chosen map's number", () => {
    const d = { ...defaultDraft(), mapId: ID };
    expect(draftSummary(d)).toContain('first to 9 territories wins');
    expect(draftSummary(defaultDraft())).toContain('first to 30 territories wins');
    expect(buildNewGameVM(d).lengthOptions[1].detail).toBe('70% of the map');
    expect(buildNewGameVM(defaultDraft()).lengthOptions[1].detail).toBe('70% of the world');
  });

  it("the auto setup batch uses the map's starting armies and size", () => {
    expect([2, 3, 4].map((n) => autoSetupBatch(n))).toEqual([10, 11, 10]);
    // 3 seats on twelve: ceil((12 − floor(12 / 3)) / 2) = 4
    const d = { ...defaultDraft(), mapId: ID, setup: 'placeOwn' as const };
    d.seats = d.seats.slice(0, 3);
    expect(draftToConfig(d, 1).setupBatch).toBe(4);
  });
});

describe('copy, strip, helpers and story on another map', () => {
  afterEach(() => setCopyMap(null));

  it("names come from the game's map", () => {
    setCopyMap({ mapId: ID });
    expect(tName('north_2')).toBe('Northmark 2');
    expect(cName('south')).toBe('Southreach');
    setCopyMap(null);
    expect(tName('ural')).toBe('Ural');
    // a state names its own map whatever the copy map is
    expect(tName('middle_4', twelve())).toBe('Midlands 4');
  });

  // attackStake asks the engine's territoryCount first: needs the engine merge.
  it.skipIf(!engineReadsMaps)("attack stakes read the map's continents", () => {
    const s = twelve({ north_1: [0, 5], north_2: [0, 1], north_3: [0, 1], south_3: [0, 4] });
    // taking north_4 completes Northmark for John (north_1 borders it)
    expect(attackStake(s, 'north_1', 'north_4')).toBe('takes Northmark');
    // Priya holds all of Southreach; John attacks into it from the Midlands: he breaks it
    const s2 = twelve({ middle_3: [0, 4] });
    expect(attackStake(s2, 'middle_3', 'south_1')).toBe("breaks Priya's Southreach");
    // attacking from inside a continent the defender does not hold whole is no stake
    expect(attackStake(s, 'south_3', 'south_4')).toBeNull();
  });

  it('the target-first source walks the map adjacency', () => {
    const s = twelve({ middle_1: [0, 3], north_3: [0, 6] });
    expect(autoSource(s, 'middle_2', 0)).toBe('middle_1');
    expect(autoSource(s, 'north_4', 0)).toBe('north_3');
  });

  it('the replay keeps a twelve-territory ledger and tells the round in its names', () => {
    const s0 = twelve();
    const l = emptyStory();
    noteRoundStart(l, s0, 1);
    expect(l.snaps[0].o).toHaveLength(12);
    const s1 = twelve({ north_1: [0, 2], north_2: [0, 1], north_3: [0, 1], north_4: [0, 1], south_1: [1, 1] });
    s1.round = 1;
    noteConquest(l, 1, 'north_4', 0, 2);
    const r = buildReplay(l, s1, 0, 1);
    expect(r.rounds[0].line).toBe('John took Northmark');
    expect(Object.keys(r.rounds[0].owners)).toHaveLength(12);
    // a saved ledger restores against its own map
    expect(restoreStory(JSON.parse(JSON.stringify(l)), { mapId: ID }).snaps).toHaveLength(1);
    expect(restoreStory(JSON.parse(JSON.stringify(l))).snaps).toHaveLength(0);
  });
});

describe('continent tints (src/shared/palette.ts)', () => {
  it("classic's six keep their colours", () => {
    expect([0, 1, 2, 3, 4, 5].map((i) => continentTint(i, 6))).toEqual(CONTINENT_TINTS);
    expect([0, 1, 2, 3, 4, 5].map((i) => continentTint(i))).toEqual(CONTINENT_TINTS);
  });
  it('three spread across the six; eight are all different', () => {
    expect([0, 1, 2].map((i) => continentTintIndex(i, 3))).toEqual([0, 2, 4]);
    const eight = new Set([0, 1, 2, 3, 4, 5, 6, 7].map((i) => continentTint(i, 8)));
    expect(eight.size).toBe(8);
  });
});

// ---------------------------------------------------------------------------------------------------------
// The controller's view model on the fixture map. Needs the engine to play rules per game (createGame deals
// the map's territories); skipped until the engine builder's change is merged.
// ---------------------------------------------------------------------------------------------------------

/* engineReadsMaps: defined above the suites */

function quietBoard(): BoardView {
  const nop = () => undefined;
  return {
    syncState: nop,
    playEvent: () => Promise.resolve(),
    setAnimationSpeed: nop,
    skipAnimations: nop,
    setHighlights: nop,
    onTerritoryClick: nop,
    onTerritoryHover: nop,
    focusTerritories: nop,
    resetCamera: nop,
    setAttractMode: nop,
    setShowLabels: nop,
    setViewportInsets: nop,
    setUiScale: nop,
    getScreenPosition: () => ({ x: 1, y: 1 }),
    getStats: () => ({ fps: 60, frameMsP95: 16, drawCalls: 0, triangles: 0, cameraMoving: false }),
    dispose: nop,
  } as BoardView;
}
const audio = new Proxy({}, { get: (_t, k) => (k === 'isUnlocked' ? () => false : k === 'stats' ? () => ({}) : () => undefined) }) as AudioEngine;
const clock = {
  now: () => Date.now(),
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
  raf: (fn: () => void) => void setTimeout(fn, 16),
};

describe.skipIf(!engineReadsMaps)('the controller on the fixture map (after the engine merge)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    setCopyMap(null);
  });

  it('builds the game view model from the map: twelve territories, its continents, its goal', async () => {
    const kv = memoryKV();
    kv.set(SETTINGS_KEY, JSON.stringify({ hideCardsBetweenTurns: false, v: 5 }));
    const c = createController({ board: quietBoard(), audio, storage: kv, clock, dom: false, prefersReducedMotion: () => false, bootMap: ID, reload: () => undefined });
    c.hooks.newGame({ players: SEATS.map((p) => ({ ...p, kind: 'ai' as const, difficulty: 'normal' as const })), dominationPercent: 70 });
    await vi.advanceTimersByTimeAsync(200);
    const s = c.hooks.getState()!;
    expect(s.config.mapId).toBe(ID);
    const vm = c.getViewModel();
    expect(vm.screen).toBe('game');
    const seats = vm.game!.seats;
    expect(seats.reduce((n, x) => n + x.territories, 0)).toBe(12);
    for (const x of seats) for (const k of x.continents ?? []) expect(def().continentIds).toContain(k);
    c.dispose();
  });
});
