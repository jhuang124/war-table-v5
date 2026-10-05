// v6 maps: the game layer and the shared palette read the game's own map (config.mapId), never the classic
// 42 / six continents. Runs on the engine's hidden test pack, maps/test-twelve (12 territories; West, Centre,
// East; seats 2–3).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGame, mapDefOf, type GameState, type PlayerConfig, type TerritoryId } from '../../src/engine';
import { cName, setCopyMap, tName } from '../../src/game/copy';
import { attackStake } from '../../src/game/strip';
import { autoSource } from '../../src/game/helpers';
import { buildReplay, emptyStory, noteConquest, noteRoundStart, restoreStory } from '../../src/game/story';
import { autoSetupBatch, buildNewGameVM, defaultDraft, draftProblems, draftSummary, draftToConfig, territoriesToWin } from '../../src/game/presets';
import { listMaps } from '../../src/map/registry';
import { CONTINENT_TINTS, continentTint, continentTintIndex } from '../../src/shared/palette';
import { createController } from '../../src/game/controller';
import { memoryKV, SETTINGS_KEY } from '../../src/game/storage';
import type { AudioEngine } from '../../src/audio/types';
import type { BoardView } from '../../src/render/BoardView';

const ID = 'test-twelve';
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

describe('the test map', () => {
  it('is twelve territories in three continents, and never offered', () => {
    expect(def().size).toBe(12);
    expect(def().continentIds).toEqual(['west', 'centre', 'east']);
    expect(listMaps().map((m) => m.id)).not.toContain(ID);
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
    d.seats = d.seats.slice(0, 3);
    expect(draftSummary(d)).toContain('first to 9 territories wins');
    expect(draftSummary(defaultDraft())).toContain('first to 30 territories wins');
    expect(buildNewGameVM(d).lengthOptions[1].detail).toBe('70% of the map');
    expect(buildNewGameVM(defaultDraft()).lengthOptions[1].detail).toBe('70% of the world');
  });

  it("the auto setup batch uses the map's starting armies and size", () => {
    expect([2, 3, 4].map((n) => autoSetupBatch(n))).toEqual([10, 11, 10]);
    // 3 seats on twelve, 10 armies each: ceil((10 − floor(12 / 3)) / 2) = 3
    const d = { ...defaultDraft(), mapId: ID, setup: 'placeOwn' as const };
    d.seats = d.seats.slice(0, 3);
    expect(draftToConfig(d, 1).setupBatch).toBe(3);
  });

  it("a map outside the table's seat count can't start", () => {
    const four = { ...defaultDraft(), mapId: ID };
    expect(four.seats).toHaveLength(4);
    expect(draftProblems(four)).toContain('Test Twelve is for 2–3 players');
    expect(buildNewGameVM(four).canStart).toBe(false);
    expect(draftProblems({ ...four, seats: four.seats.slice(0, 3) })).toEqual([]);
  });
});

describe('copy, strip, helpers and story on another map', () => {
  afterEach(() => setCopyMap(null));

  it("names come from the game's map", () => {
    setCopyMap({ mapId: ID });
    expect(tName('mill')).toBe('Mill');
    expect(cName('east')).toBe('East');
    setCopyMap(null);
    expect(tName('ural')).toBe('Ural');
    // a state names its own map whatever the copy map is
    expect(tName('orchard', twelve())).toBe('Orchard');
  });

  it("attack stakes read the map's continents", () => {
    const s = twelve({ harbour: [0, 5] });
    // taking Cliffs completes West for John
    expect(attackStake(s, 'harbour', 'cliffs')).toBe('takes West');
    // Centre is Priya's whole: John breaks it
    expect(attackStake(s, 'harbour', 'market')).toBe("breaks Priya's Centre");
  });

  it('the target-first source walks the map adjacency', () => {
    const s = twelve({ market: [0, 3], tower: [0, 6] });
    expect(autoSource(s, 'hills', 0)).toBe('tower');
    expect(autoSource(s, 'ford', 0)).toBe('market');
  });

  it('the replay keeps a twelve-territory ledger and tells the round in its names', () => {
    const s0 = twelve();
    const l = emptyStory();
    noteRoundStart(l, s0, 1);
    expect(l.snaps[0].o).toHaveLength(12);
    const s1 = twelve({ harbour: [0, 2], cliffs: [0, 1], ford: [1, 1], hills: [1, 1] });
    s1.round = 1;
    noteConquest(l, 1, 'cliffs', 0, 2);
    const r = buildReplay(l, s1, 0, 1);
    expect(r.rounds[0].line).toBe('John took West');
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
// The controller's view model on the test map.
// ---------------------------------------------------------------------------------------------------------


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

describe('the controller on the test map', () => {
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
    expect(Object.keys(s.territories).sort()).toEqual([...def().territoryIds].sort());
    c.dispose();
  });
});

// ---------------------------------------------------------------------------------------------------------
// Lint: src/game, src/render and the HUD top strip never name the classic constants (tests/engine has the
// engine's twin of this).
// ---------------------------------------------------------------------------------------------------------
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

describe('game + render read the map, never the classic constants', () => {
  it('no classic constant named in src/game, src/render, src/ui/hud/topstrip.ts', () => {
    const ROOT = join(__dirname, '..', '..');
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith('.ts') ? [join(d, f)] : []));
    const files = [...walk(join(ROOT, 'src', 'game')), ...walk(join(ROOT, 'src', 'render')), join(ROOT, 'src', 'ui', 'hud', 'topstrip.ts')];
    const banned = ['TERRITORIES', 'CONTINENTS', 'TERRITORY_IDS', 'CONTINENT_IDS', 'ADJACENCY', 'BORDERS', 'CARD_SYMBOLS', 'STARTING_ARMIES', 'WILD_CARD_IDS'];
    const re = new RegExp(`(?<![\\w.$])(${banned.join('|')})(?![\\w$])`, 'g');
    const hits: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
      src.split('\n').forEach((line, i) => {
        for (const m of line.matchAll(re)) hits.push(`${relative(ROOT, f)}:${i + 1} ${m[1]}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
