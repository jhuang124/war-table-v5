// Canonical classic-Risk map data: 42 territories, 6 continents, 83 borders.
// Presentation lives elsewhere (src/map for geometry, src/shared/palette.ts for colors).
//
// Since the v3 map packs (docs/MAPS.md) the data itself lives in maps/classic/rules.json and
// maps/classic/topology.json, read through the one pack loader (src/map/packs.ts); this module keeps the
// same exports, in the same order, typed with the engine's ids. Every playable pack shares these rules
// and topology today (true-world extends classic), so the engine plays any of them unchanged.
// A pack with different territories needs the engine to read rules per game (docs/MAPS.md, "A new
// board"); `mapRulesOf` below is the hook for that.

import type { ContinentId, TerritoryId, CardSymbol } from './types';
import { DEFAULT_MAP_ID, mapIdOf, packData } from '../map/packs';
import type { MapRules, MapTopology } from '../map/types';

export interface ContinentInfo {
  id: ContinentId;
  name: string;
  bonus: number;
  territories: TerritoryId[];
}

export interface TerritoryInfo {
  id: TerritoryId;
  name: string;
  continent: ContinentId;
}

const CLASSIC = packData(DEFAULT_MAP_ID);
const RULES = CLASSIC.rules;
const TOPOLOGY = CLASSIC.topology;

export const CONTINENTS: Record<ContinentId, ContinentInfo> = Object.fromEntries(
  RULES.continents.map((c) => [
    c.id,
    {
      id: c.id as ContinentId,
      name: c.name,
      bonus: c.bonus,
      territories: RULES.territories.filter((t) => t.continent === c.id).map((t) => t.id as TerritoryId),
    },
  ]),
) as Record<ContinentId, ContinentInfo>;

export const CONTINENT_IDS = Object.keys(CONTINENTS) as ContinentId[];

const NAMES = Object.fromEntries(RULES.territories.map((t) => [t.id, t.name])) as Record<TerritoryId, string>;

export const TERRITORY_IDS: TerritoryId[] = CONTINENT_IDS.flatMap((c) => CONTINENTS[c].territories);

export const TERRITORIES: Record<TerritoryId, TerritoryInfo> = Object.fromEntries(
  CONTINENT_IDS.flatMap((c) =>
    CONTINENTS[c].territories.map((t) => [t, { id: t, name: NAMES[t], continent: c }]),
  ),
) as Record<TerritoryId, TerritoryInfo>;

/** The 83 undirected borders of the classic board. */
export const BORDERS: [TerritoryId, TerritoryId][] = TOPOLOGY.borders.map(([a, b]) => [a as TerritoryId, b as TerritoryId]);

export const ADJACENCY: Record<TerritoryId, TerritoryId[]> = (() => {
  const adj = Object.fromEntries(TERRITORY_IDS.map((t) => [t, [] as TerritoryId[]])) as Record<
    TerritoryId,
    TerritoryId[]
  >;
  for (const [a, b] of BORDERS) {
    adj[a].push(b);
    adj[b].push(a);
  }
  return adj;
})();

export function areAdjacent(a: TerritoryId, b: TerritoryId): boolean {
  return ADJACENCY[a].includes(b);
}

/** Card symbol printed on each territory's card: 14 of each, cycling through the canonical order. */
export const CARD_SYMBOLS: Record<TerritoryId, Exclude<CardSymbol, 'wild'>> = Object.fromEntries(
  TERRITORY_IDS.map((t, i) => [t, RULES.cardSymbols[i % RULES.cardSymbols.length]]),
) as Record<TerritoryId, Exclude<CardSymbol, 'wild'>>;

/** Default starting armies by player count (classic rules). */
export const STARTING_ARMIES: Record<number, number> = Object.fromEntries(
  Object.entries(RULES.startingArmies).map(([n, v]) => [Number(n), v]),
);

/** The map pack a config plays on: its `mapId` when that pack exists, else 'classic'. */
export { mapIdOf };

/**
 * The rules + topology a game's map pack plays by (`config.mapId`, absent = classic). Additive: the
 * engine still reads the classic constants above; this is where a per-game read would start.
 */
export function mapRulesOf(config?: { mapId?: string }): { mapId: string; rules: MapRules; topology: MapTopology } {
  const p = packData(config?.mapId);
  return { mapId: p.manifest.id, rules: p.rules, topology: p.topology };
}

// ---------------------------------------------------------------------------------------------------------
// v6 maps: the per-game map definition. Everything above is CLASSIC's; a game on another board reads its
// own ids, names, continents, adjacency, card symbols and starting armies through `mapDefOf(state.config)`.
// Builders replace reads of the classic constants with this (docs/MAPS.md "A new board").
// ---------------------------------------------------------------------------------------------------------

export interface MapDef {
  id: string;
  rules: MapRules;
  topology: MapTopology;
  continents: Record<ContinentId, ContinentInfo>;
  continentIds: ContinentId[];
  territories: Record<TerritoryId, TerritoryInfo>;
  /** Canonical order: grouped by continent in continent order (card symbols, AI iteration, numbering follow it). */
  territoryIds: TerritoryId[];
  borders: [TerritoryId, TerritoryId][];
  adjacency: Record<TerritoryId, TerritoryId[]>;
  cardSymbols: Record<TerritoryId, Exclude<CardSymbol, 'wild'>>;
  startingArmies: Record<number, number>;
  /** Sea lanes as unordered pairs ('a|b'), for "visible water = adjacency" and the AI's lane awareness. */
  seaLanes: Set<string>;
  areAdjacent(a: TerritoryId, b: TerritoryId): boolean;
  /** Territory count thresholds the length presets use (e.g. 70 % of the board). */
  size: number;
}

const DEFS = new Map<string, MapDef>();

function buildDef(id: string): MapDef {
  const { rules, topology } = packData(id);
  const continentIds = rules.continents.map((c) => c.id);
  const continents = Object.fromEntries(
    rules.continents.map((c) => [
      c.id,
      { id: c.id, name: c.name, bonus: c.bonus, territories: rules.territories.filter((t) => t.continent === c.id).map((t) => t.id) },
    ]),
  ) as Record<ContinentId, ContinentInfo>;
  const territoryIds = continentIds.flatMap((c) => continents[c].territories);
  const territories = Object.fromEntries(
    rules.territories.map((t) => [t.id, { id: t.id, name: t.name, continent: t.continent }]),
  ) as Record<TerritoryId, TerritoryInfo>;
  const borders = topology.borders.map(([a, b]) => [a, b] as [TerritoryId, TerritoryId]);
  const adjacency = Object.fromEntries(territoryIds.map((t) => [t, [] as TerritoryId[]])) as Record<TerritoryId, TerritoryId[]>;
  for (const [a, b] of borders) {
    adjacency[a]?.push(b);
    adjacency[b]?.push(a);
  }
  const symbols = rules.cardSymbols as Exclude<CardSymbol, 'wild'>[];
  const cardSymbols = Object.fromEntries(territoryIds.map((t, i) => [t, symbols[i % symbols.length]])) as Record<TerritoryId, Exclude<CardSymbol, 'wild'>>;
  const startingArmies = Object.fromEntries(Object.entries(rules.startingArmies).map(([k, v]) => [Number(k), v])) as Record<number, number>;
  const seaLanes = new Set(topology.seaLanes.map((l) => (l.a < l.b ? `${l.a}|${l.b}` : `${l.b}|${l.a}`)));
  return {
    id,
    rules,
    topology,
    continents,
    continentIds,
    territories,
    territoryIds,
    borders,
    adjacency,
    cardSymbols,
    startingArmies,
    seaLanes,
    areAdjacent: (a, b) => adjacency[a]?.includes(b) ?? false,
    size: territoryIds.length,
  };
}

/** The map a game is played on: `config.mapId` (an unknown id falls back to classic). Memoised per id. */
export function mapDefOf(config?: { mapId?: string } | null): MapDef {
  const id = mapIdOf(config ?? undefined);
  let d = DEFS.get(id);
  if (!d) {
    d = buildDef(id);
    DEFS.set(id, d);
  }
  return d;
}
