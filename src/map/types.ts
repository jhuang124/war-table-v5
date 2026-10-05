// Contract between the map pipeline (scripts/build-map.ts → maps/<id>/board.json) and the renderer,
// plus the hand-written parts of a map pack (maps/<id>/pack.json, rules.json, topology.json).
// docs/MAPS.md describes the format.

import type { ContinentId, TerritoryId } from '../engine/types';

/** Board coordinates: origin bottom-left, +x east, +y north, units = board units. */
export type Vec2 = [number, number];

export interface PolygonGeom {
  /** Counter-clockwise, no repeated closing point. */
  outer: Vec2[];
  /** Clockwise, no repeated closing point. */
  holes: Vec2[][];
}

export interface TerritoryGeom {
  id: TerritoryId;
  /** Main landmass first. Tiny specks already dropped. */
  polygons: PolygonGeom[];
  /** Where the army piece + count badge sits. Inside the main polygon, clear of edges. */
  anchor: Vec2;
  /** Where the territory name label sits (near but not on top of the anchor). */
  labelAnchor: Vec2;
  area: number;
  /** [minX, minY, maxX, maxY] */
  bbox: [number, number, number, number];
}

export interface SeaLaneGeom {
  a: TerritoryId;
  b: TerritoryId;
  /**
   * Polyline segments in board coords, coast-to-coast. Normally one segment.
   * Alaska–Kamchatka wraps around the board edge: two segments, each running off an edge.
   */
  segments: Vec2[][];
  wrap: boolean;
  /**
   * Optional (additive, map packs): the two shore points of the crossing, [on a's coast, on b's coast],
   * where the crossing's shore ticks go. The loader (src/map/registry.ts) always fills it, from the
   * segment ends when the file omits it (the classic board.json predates it), so readers of a loaded
   * board can rely on it.
   */
  shore?: [Vec2, Vec2];
}

export interface ContinentGeom {
  id: ContinentId;
  /** Where the continent name + bonus label sits (usually on the ocean beside the continent). */
  labelAnchor: Vec2;
  /**
   * Optional (additive): width in board units of clear water centred on `labelAnchor` (no land,
   * sea lanes or other labels within ~0.35 units, for a ~1.3-unit-tall line of text).
   */
  labelRoom?: number;
}

export interface BoardGeometry {
  version: 1;
  width: number;
  height: number;
  /** Human-readable note on projection + crop, for maintainers. */
  projection: string;
  territories: Record<TerritoryId, TerritoryGeom>;
  seaLanes: SeaLaneGeom[];
  continents: Record<ContinentId, ContinentGeom>;
  /** Non-playable land drawn as neutral terrain (e.g. New Zealand, Caribbean specks). May be empty. */
  decorativeLand: PolygonGeom[];
  oceanLabels: { text: string; at: Vec2; size: number }[];
}

// ---------------------------------------------------------------------------------------------
// Map packs (docs/MAPS.md). Ids are plain strings in the files; the classic ids are the engine's
// TerritoryId / ContinentId unions.

/** maps/<id>/pack.json: the manifest + presentation knobs. Hand-written. */
export interface MapManifest {
  format: 1;
  /** Folder name under maps/, lowercase-kebab. Saved in GameConfig.mapId. */
  id: string;
  /** Shown in the New-game picker. */
  name: string;
  /** One plain-English line for the picker. */
  description: string;
  /**
   * Take rules.json + topology.json from this pack instead of shipping copies (a geometry variant of
   * an existing board, e.g. true-world extends classic). Absent = the pack ships its own.
   */
  extends?: string;
  /** Generated preview image beside pack.json (build:map writes it), or absent. */
  thumbnail?: string;
  /**
   * Optional (additive, v6): registered for the engine and tests but never offered in the New-game picker
   * (listMaps skips it) and never booted by `?map=` or a save. A hidden pack may ship no board.json
   * (maps/test-twelve, the engine's synthetic test board, ships none).
   */
  hidden?: boolean;
  presentation: MapPresentation;
}

export interface MapPresentation {
  /** Free radius (board units) the build guarantees around every anchor; verify:map checks it. */
  anchorClearance: number;
  /**
   * Optional: an army may overhang water. The anchor stays inside its own land by at least `ownLand`
   * units, and `anchorClearance` is measured to other territories' land only (open water may lie under
   * the disc). Absent = the whole disc sits on the territory's own land (classic).
   */
  anchorOverhang?: { ownLand: number };
  /**
   * Optional camera home: the board rectangle the resting camera frames ([minX, minY, maxX, maxY]).
   * Absent = the whole board. (The renderer frames the whole board today; see docs/MAPS.md.)
   */
  home?: [number, number, number, number];
}

/** maps/<id>/rules.json: continents, bonuses, seats, setup table. Hand-written. */
export interface MapRules {
  format: 1;
  /** Supported seat counts (inclusive). The game supports 2..4 today. */
  seats: { min: number; max: number };
  /** Starting armies per player by seat count; one entry per supported count. */
  startingArmies: Record<string, number>;
  /** Card symbols dealt to territories in `territories` order, cycling. Two wilds are added. */
  cardSymbols: ('infantry' | 'cavalry' | 'artillery')[];
  /** In display order. */
  continents: { id: string; name: string; bonus: number }[];
  /** Canonical order (grouped by continent, continents in the order above). */
  territories: { id: string; name: string; continent: string }[];
}

/** maps/<id>/topology.json: who borders whom, and which borders cross water. Hand-written. */
export interface MapTopology {
  format: 1;
  /** Undirected borders, each listed once. */
  borders: [string, string][];
  /**
   * The borders that cross water (drawn as crossings), each also in `borders`. `wrap` = the crossing
   * runs off the west edge from `a` and back in from the east edge to `b` (at most one per map).
   */
  seaLanes: { a: string; b: string; wrap?: boolean }[];
}
