// v6 maps: the engine plays any pack's rules and topology per game. Proven on maps/test-twelve, a hidden
// synthetic board (12 territories; West 2 / Centre 3 / East 4 bonus on 2 / 3 / 7 territories; sea lanes
// Harbour–Market and Harbour–Tower; seats 2–3, starting armies 12 / 10).

import { describe, expect, it } from 'vitest';
import {
  chooseAiAction,
  continentName,
  createGame,
  legalActionsSummary,
  mapDefOf,
  mapOf,
  missionComplete,
  missionDeckFor,
  missionsFor,
  missionTerritories,
  missionText,
  neutralTerritories,
  reinforcementsFor,
  standingOf,
  standingReason,
  targetTerritories,
  territoriesNeeded,
  territoryName,
  validateConfig,
  wildCardIds,
  type GameEvent,
  type PlayerId,
  type TerritoryId,
} from '../../src/engine';
import { truceReason } from '../../src/engine/ai/diplomacy';
import { allPackIds, packIds } from '../../src/map/packs';
import { listMaps, resolveMapId } from '../../src/map/registry';
import { act, config, findOutcome, passTurn, scenario } from './helpers';
import { aiConfig, playAi } from './sim';

const T12 = { mapId: 'test-twelve' } as const;
const def = mapDefOf(T12);
const WEST = ['harbour', 'cliffs'];
const CENTRE = ['ford', 'mill', 'market'];
const EAST = ['hills', 'pines', 'lake', 'quarry', 'orchard', 'fen', 'tower'];

/** Owner + armies for each listed territory. */
function own(owner: PlayerId, ts: TerritoryId[], armies = 2): Partial<Record<TerritoryId, [PlayerId, number]>> {
  return Object.fromEntries(ts.map((t) => [t, [owner, armies]]));
}

describe('test-twelve: the pack', () => {
  it('is registered for the engine but hidden from the picker and from boot', () => {
    expect(allPackIds()).toContain('test-twelve');
    expect(packIds()).not.toContain('test-twelve');
    expect(listMaps().map((m) => m.id)).not.toContain('test-twelve');
    expect(listMaps().map((m) => m.id).slice(0, 2)).toEqual(['classic', 'true-world']);
    expect(resolveMapId({ search: '?map=test-twelve', allowUrl: true })).toBe('classic');
  });

  it('reads as a board of its own: 12 territories, 3 continents, 2 lanes', () => {
    expect(def.size).toBe(12);
    expect(def.continentIds).toEqual(['west', 'centre', 'east']);
    expect(def.continentIds.map((c) => def.continents[c].bonus)).toEqual([2, 3, 4]);
    expect(def.territoryIds).toEqual([...WEST, ...CENTRE, ...EAST]);
    expect(def.seaLanes).toEqual(new Set(['harbour|market', 'harbour|tower']));
    expect(def.areAdjacent('harbour', 'tower')).toBe(true);
    expect(mapOf({ config: T12 })).toBe(def);
    expect(territoryName('harbour')).toBe('Harbour');
    expect(continentName('east', T12)).toBe('East');
  });
});

describe('test-twelve: setup', () => {
  it('deals its own territories and starting armies', () => {
    for (const n of [2, 3]) {
      const { state } = createGame(config(n, { ...T12, initialPlacement: 'manual' }));
      expect(state.config.mapId).toBe('test-twelve');
      expect(Object.keys(state.territories).sort()).toEqual([...def.territoryIds].sort());
      const total = state.players.reduce((a, p) => a + p.setupArmies, 0) + 12;
      expect(total).toBe(n * def.startingArmies[n]);
      expect(state.players.every((p) => def.territoryIds.filter((t) => state.territories[t].owner === p.id).length === 12 / n)).toBe(true);
    }
  });

  it('validates the seat count against the pack', () => {
    expect(validateConfig(config(4, T12))).toBe('Test Twelve is for 2 to 3 players.');
    expect(() => createGame(config(4, T12))).toThrow(/2 to 3 players/);
    expect(validateConfig(config(3, T12))).toBeNull();
    // An unknown id plays classic, so it is checked as classic.
    expect(validateConfig(config(4, { mapId: 'atlantis' }))).toBeNull();
    expect(createGame(config(4, { mapId: 'atlantis' })).state.config.mapId).toBe('classic');
  });

  it('clamps a starting-army override to cover its own board', () => {
    const { state } = createGame(config(3, { ...T12, startingArmies: 1 }));
    expect(state.config.startingArmies).toBe(4);
  });

  it('deals the neutral seat a third of this board', () => {
    expect(neutralTerritories(def)).toBe(4);
    const { state } = createGame(config(2, { ...T12, neutral: true }));
    expect(def.territoryIds.filter((t) => state.territories[t].owner === 2)).toHaveLength(4);
  });

  it('draft: the summary offers this board to claim, in its order', () => {
    const { state } = createGame(config(3, { ...T12, setupMode: 'draft' }));
    expect(legalActionsSummary(state).claimable).toEqual(def.territoryIds);
    const a = chooseAiAction(state, state.currentPlayer);
    expect(a.type).toBe('claim');
    expect(def.territoryIds).toContain((a as { territory: string }).territory);
  });
});

describe('test-twelve: cards', () => {
  it('one card per territory plus two wilds: 12 + 2', () => {
    const { state } = createGame(config(3, T12));
    expect(state.deck).toHaveLength(14);
    expect(wildCardIds(state)).toEqual([12, 13]);
    const byId = [...state.deck].sort((a, b) => a.id - b.id);
    expect(byId.map((c) => c.id)).toEqual(Array.from({ length: 14 }, (_, i) => i));
    expect(byId.filter((c) => c.symbol === 'wild').map((c) => c.id)).toEqual([12, 13]);
    expect(byId.slice(0, 12).map((c) => c.territory)).toEqual(def.territoryIds);
    // The pack's symbol cycle, in territory order.
    expect(byId.slice(0, 12).map((c) => c.symbol)).toEqual(def.territoryIds.map((_, i) => def.rules.cardSymbols[i % 3]));
  });
});

describe('test-twelve: reinforcement and continents', () => {
  it('pays this board\'s bonuses', () => {
    const s = scenario({ players: 2, config: T12, terr: { ...own(0, [...WEST, ...CENTRE]), ...own(1, EAST) } });
    expect(reinforcementsFor(s, 0)).toEqual({
      territoryCount: 5,
      base: 3,
      continents: [
        { continent: 'west', bonus: 2 },
        { continent: 'centre', bonus: 3 },
      ],
      total: 8,
    });
    expect(reinforcementsFor(s, 1).continents).toEqual([{ continent: 'east', bonus: 4 }]);
    expect(reinforcementsFor(s, 1).total).toBe(3 + 4);
  });

  it('a turn starts with them', () => {
    const s = scenario({ players: 2, config: T12, terr: { ...own(0, [...WEST, ...CENTRE]), ...own(1, EAST) }, phase: { kind: 'fortify' } });
    const { events } = passTurn(s);
    const started = events.find((e): e is Extract<GameEvent, { type: 'turnStarted' }> => e.type === 'turnStarted')!;
    expect(started.player).toBe(1);
    expect(started.reinforcements.continents).toEqual([{ continent: 'east', bonus: 4 }]);
  });

  it('taking the last territory of a continent gains it', () => {
    const s = scenario({
      players: 2,
      config: T12,
      terr: { ...own(1, EAST), ...own(0, CENTRE), harbour: [1, 1], cliffs: [0, 6], market: [0, 2] },
    });
    // West is split; East is 1's. Cliffs takes Harbour → 0 holds West.
    const r = findOutcome(s, { type: 'blitz', player: 0, from: 'cliffs', to: 'harbour' }, (x) =>
      x.events.some((e) => e.type === 'territoryConquered'),
    );
    const evs = r.state.phase.kind === 'occupy' ? act(r.state, { type: 'occupy', player: 0, count: r.state.phase.min }).events : r.events;
    expect([...r.events, ...evs].some((e) => e.type === 'continentGained' && e.continent === 'west')).toBe(true);
  });

  it('win thresholds are a share of this board', () => {
    expect(targetTerritories(def, 70)).toBe(9);
    expect(targetTerritories(def, 100)).toBe(12);
    expect(targetTerritories(mapDefOf(), 70)).toBe(30);
    expect(targetTerritories(mapDefOf(), 100)).toBe(42);
    const s = scenario({ players: 3, config: { ...T12, dominationPercent: 70 } });
    expect(territoriesNeeded(s)).toBe(9);
  });
});

describe('test-twelve: missions are built from the board', () => {
  it('pairs of continents at 25–45 % of the board, count cards at 43 % and 57 %', () => {
    const deck = missionsFor(T12);
    const cont = deck.filter((m) => m.spec.kind === 'continents');
    expect(cont.map((m) => m.id)).toEqual(['west-centre']); // 5 of 12; West+East 9 and Centre+East 10 are too big
    expect(cont[0].text).toBe('Conquer West and Centre');
    expect(missionTerritories(T12)).toEqual({ count: 7, held: { count: 5, minArmies: 2 } });
    expect(deck.filter((m) => m.spec.kind === 'territories').map((m) => m.text)).toEqual([
      'Hold 5 territories with at least 2 armies on each',
      'Conquer 7 territories',
    ]);
    for (const m of deck) expect(m.text).not.toMatch(/!|Asia|Europe|Africa|America|Australia/);
  });

  it('deals and checks them on this board', () => {
    const { state } = createGame(config(3, { ...T12, missions: true }));
    expect(missionDeckFor(state)).toHaveLength(1 + 2 + 3);
    const s = scenario({ players: 3, config: { ...T12, missions: true }, terr: { ...own(0, [...WEST, ...CENTRE]), ...own(1, EAST.slice(0, 4)), ...own(2, EAST.slice(4)) } });
    s.players[0].mission = 'west-centre';
    s.players[1].mission = 'destroy-crimson';
    s.players[2].mission = 'territories-7';
    expect(missionText(s, 0)).toBe('Ann must hold West and Centre');
    expect(missionComplete(s, 0)).toBe(true);
    expect(missionText(s, 1)).toBe('Ben must knock out Ann (Vermilion)');
    expect(missionText(s, 2)).toBe('Cat must hold 7 territories');
    expect(missionComplete(s, 2)).toBe(false);
  });

  it('classic keeps the boxed deck', () => {
    expect(missionsFor().filter((m) => m.spec.kind === 'continents').map((m) => m.id)).toEqual([
      'north-america-africa',
      'north-america-australia',
      'asia-south-america',
      'asia-africa',
      'europe-south-america-plus',
      'europe-australia-plus',
    ]);
    expect(missionsFor({ mapId: 'true-world' })).toEqual(missionsFor());
  });
});

describe('test-twelve: standing', () => {
  it('reads borders on this board and names its continents', () => {
    const s = scenario({
      players: 3,
      config: T12,
      terr: { ...own(0, [...WEST, ...CENTRE]), ...own(1, EAST.slice(0, 4), 5), ...own(2, EAST.slice(4)) },
    });
    for (const p of s.players) p.kind = 'ai';
    s.players[0].personality = 'turtle';
    s.players[1].personality = 'warlord';
    // 0 and 1 meet at Market–Hills and Mill–Pines (Centre / East).
    expect(truceReason(s, 0, 1)).toMatch(/^they share a border in (Centre|East)$/);
    // 0 and 2 meet only across the Harbour–Tower lane.
    expect(truceReason(s, 0, 2)).toMatch(/^they share a border in (West|East)$/);
    expect(['ally', 'even', 'wary', 'hostile']).toContain(standingOf(s, 0, 1));
    expect(standingReason(s, 0, 1)).not.toMatch(/Asia|Europe|Africa|America|Australia/);
  });
});

describe('test-twelve: AI against AI, start to finish', () => {
  const runs: [string, ReturnType<typeof aiConfig>][] = [
    ['2p', aiConfig(['normal', 'hard'], { ...T12, seed: 11 })],
    ['3p draft, manual', aiConfig(['easy', 'normal', 'hard'], { ...T12, seed: 12, setupMode: 'draft', initialPlacement: 'manual' })],
    ['2p + neutral, missions', aiConfig(['normal', 'normal'], { ...T12, seed: 13, neutral: true, missions: true })],
    ['3p fixed cards, adjacent fortify, 70 %', aiConfig(['hard', 'hard', 'hard'], { ...T12, seed: 14, cardBonus: 'fixed', fortifyRule: 'adjacent', dominationPercent: 70 })],
  ];
  for (const [label, cfg] of runs) {
    it(`${label}: every AI move legal, someone wins`, () => {
      const g = playAi(cfg, { maxActions: 20000 });
      expect(g.rawIllegal).toEqual([]);
      expect(g.state.phase.kind).toBe('game-over');
      const ph = g.state.phase as Extract<typeof g.state.phase, { kind: 'game-over' }>;
      expect(ph.winner).toBeGreaterThanOrEqual(0);
      expect(Object.keys(g.state.territories)).toHaveLength(12);
      const cards = g.state.deck.length + g.state.discard.length + g.state.players.reduce((a, p) => a + p.cards.length, 0);
      expect(cards).toBe(14);
    });
  }

  it('personalities play it too (3p, standing on)', () => {
    const cfg = aiConfig(['normal', 'normal', 'normal'], { ...T12, seed: 21, diplomacy: true });
    cfg.players[0].personality = 'turtle';
    cfg.players[1].personality = 'opportunist';
    cfg.players[2].personality = 'warlord';
    const g = playAi(cfg, { maxActions: 20000 });
    expect(g.rawIllegal).toEqual([]);
    expect(g.state.phase.kind).toBe('game-over');
  });
});
