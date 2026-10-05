// Map packs (docs/MAPS.md): the registry, the classic byte-identity proof, and the old-save default.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createGame, defaultConfig } from '../../src/engine/setup';
import { BORDERS, CONTINENTS, TERRITORY_IDS, mapDefOf, mapRulesOf } from '../../src/engine/mapData';
import { listMaps, getBoard, rawBoard, resolveMapId, mapIdOf, laneShores, activeMapId } from '../../src/map/registry';
import { packData, packIds } from '../../src/map/packs';
import { BOARD, seaLaneBetween } from '../../src/map';
import { memoryKV, SAVE_KEY } from '../../src/game/storage';
import { SEATS } from '../game/fixtures';

/** sha256 of src/map/board.json at d3717cc, the last commit before map packs. */
const PRE_PACK_BOARD_SHA256 = 'a4b77df40c6fc20d8c4df608ac63dbc05c991db8b2703551d415539b63d5d8e6';

const saveOf = (config: Record<string, unknown>) => JSON.stringify({ v: 1, savedAt: 0, state: { version: 1, config } });

describe('map registry', () => {
  it('lists classic first, then true-world, with seats and counts', () => {
    const maps = listMaps();
    expect(maps.map((m) => m.id).slice(0, 2)).toEqual(['classic', 'true-world']);
    for (const m of maps) {
      expect(m.name.length).toBeGreaterThan(0);
      expect(m.description.length).toBeGreaterThan(0);
      expect(m.seats).toEqual(packData(m.id).rules.seats);
      expect(m.territories).toBe(packData(m.id).rules.territories.length);
      expect(m.continents).toBe(packData(m.id).rules.continents.length);
      expect(m.thumbnail).toMatch(/thumb\.png/);
    }
    for (const m of maps.slice(0, 2)) {
      expect(m.seats).toEqual({ min: 2, max: 4 });
      expect(m.territories).toBe(42);
      expect(m.continents).toBe(6);
    }
    expect(maps[1].rulesFrom).toBe('classic');
  });

  it('classic board is byte-identical to the pre-pack src/map/board.json', () => {
    const bytes = JSON.stringify(rawBoard('classic'));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(PRE_PACK_BOARD_SHA256);
  });

  it('the loaded board only adds shore points to each sea lane', () => {
    const raw = rawBoard('classic');
    const b = getBoard('classic');
    expect(JSON.stringify({ ...b, seaLanes: b.seaLanes.map(({ shore: _s, ...l }) => l) })).toBe(JSON.stringify(raw));
    for (const lane of b.seaLanes) {
      expect(lane.shore).toEqual(laneShores(raw.seaLanes.find((l) => l.a === lane.a && l.b === lane.b)!));
      expect(lane.shore![0]).toEqual(lane.segments[0][0]);
    }
  });

  it('every playable pack has every territory, and plays by the rules the engine knows', () => {
    for (const id of packIds()) {
      const b = getBoard(id);
      // Each pack plays by its own rules + topology, read through mapDefOf (docs/MAPS.md, "A new board").
      const def = mapDefOf({ mapId: id });
      expect(def.id).toBe(id);
      expect(Object.keys(b.territories).sort()).toEqual([...def.territoryIds].sort());
      expect(Object.keys(b.continents).sort()).toEqual([...def.continentIds].sort());
      const { rules, topology } = mapRulesOf({ mapId: id });
      expect(rules.territories.map((t) => t.id)).toEqual(def.territoryIds);
      expect(topology.borders).toEqual(def.topology.borders);
      // A pack that takes classic's rules still plays classic's board exactly.
      if (packData(id).rulesFrom === 'classic' || id === 'classic') {
        expect(topology.borders).toEqual(BORDERS);
        expect(def.territoryIds).toEqual(TERRITORY_IDS);
        expect([...def.continentIds].sort()).toEqual(Object.keys(CONTINENTS).sort());
      }
      for (const lane of b.seaLanes) expect(lane.shore).toHaveLength(2);
    }
  });

  it('true-world is its own geometry, not a copy of classic', () => {
    expect(getBoard('true-world')).not.toBe(getBoard('classic'));
    expect(getBoard('true-world').projection).toMatch(/Equal Earth/);
    expect(packData('true-world').rulesFrom).toBe('classic');
  });

  it('unknown or absent ids fall back to classic', () => {
    expect(mapIdOf(undefined)).toBe('classic');
    expect(mapIdOf({})).toBe('classic');
    expect(mapIdOf('atlantis')).toBe('classic');
    expect(mapIdOf({ mapId: 'true-world' })).toBe('true-world');
    expect(getBoard('atlantis')).toBe(getBoard('classic'));
  });

  it('the page boots on classic in Node (no URL, no save), and src/map BOARD is that board', () => {
    expect(activeMapId()).toBe('classic');
    expect(BOARD).toBe(getBoard('classic'));
    expect(seaLaneBetween('kamchatka', 'alaska')?.wrap).toBe(true);
    expect(seaLaneBetween('alaska', 'alberta')).toBeNull();
  });
});

describe('boot map selection + saves', () => {
  it('a save without mapId (every save before map packs) loads classic', () => {
    expect(resolveMapId({ save: saveOf({ seed: 1 }) })).toBe('classic');
    expect(resolveMapId({ save: null })).toBe('classic');
    expect(resolveMapId({ save: '{not json' })).toBe('classic');
  });

  it('a save with a mapId loads that map; an unknown one loads classic', () => {
    expect(resolveMapId({ save: saveOf({ mapId: 'true-world' }) })).toBe('true-world');
    expect(resolveMapId({ save: saveOf({ mapId: 'atlantis' }) })).toBe('classic');
  });

  it('?map= wins only when allowed (dev + e2e builds), and only for a known map', () => {
    const save = saveOf({ mapId: 'true-world' });
    expect(resolveMapId({ search: '?map=classic', save, allowUrl: true })).toBe('classic');
    expect(resolveMapId({ search: '?map=classic', save, allowUrl: false })).toBe('true-world');
    expect(resolveMapId({ search: '?map=true-world', save: null, allowUrl: true })).toBe('true-world');
    expect(resolveMapId({ search: '?map=atlantis', save: null, allowUrl: true })).toBe('classic');
  });

  it('createGame keeps config.mapId, so the save carries it; absent stays absent', () => {
    const tw = createGame({ ...defaultConfig(SEATS.slice(0, 3)), seed: 7, mapId: 'true-world' }).state;
    expect(tw.config.mapId).toBe('true-world');
    const kv = memoryKV();
    kv.set(SAVE_KEY, JSON.stringify({ v: 1, savedAt: 0, state: tw }));
    expect(resolveMapId({ save: kv.get(SAVE_KEY) })).toBe('true-world');

    const old = createGame({ ...defaultConfig(SEATS.slice(0, 3)), seed: 7 }).state;
    expect('mapId' in old.config).toBe(false);
    expect(resolveMapId({ save: JSON.stringify({ v: 1, savedAt: 0, state: old }) })).toBe('classic');

    expect(createGame({ ...defaultConfig(SEATS.slice(0, 3)), seed: 7, mapId: 'atlantis' }).state.config.mapId).toBe('classic');
  });

  it('the map does not change the game: same seed, same deal on classic and true-world', () => {
    const a = createGame({ ...defaultConfig(SEATS.slice(0, 3)), seed: 42 }).state;
    const b = createGame({ ...defaultConfig(SEATS.slice(0, 3)), seed: 42, mapId: 'true-world' }).state;
    expect(b.territories).toEqual(a.territories);
    expect(b.deck).toEqual(a.deck);
  });
});
