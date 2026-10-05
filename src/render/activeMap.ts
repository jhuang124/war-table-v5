// v6 maps: the renderer's map. The board's geometry is chosen once per page load (src/map/registry.ts
// activeMapId: ?map=<id>, else the save's config.mapId, else classic) and BOARD (src/map) is that map's
// board.json; this is the same map's rules side (ids, names, continents, adjacency), so nothing in src/render
// assumes the classic 42 or its six continents. Same names as the classic constants in src/engine/mapData,
// so a render file swaps its import and reads the active pack.

import { mapDefOf, type MapDef } from '../engine/mapData';
import { activeMapId } from '../map/registry';

export const MAP: MapDef = mapDefOf({ mapId: activeMapId() });

/** Canonical order: grouped by continent in continent order (index i ↔ ink field label i + 1). */
export const TERRITORY_IDS = MAP.territoryIds;
export const TERRITORIES = MAP.territories;
export const CONTINENTS = MAP.continents;
/** Display order; a continent's index here picks its tint (src/shared/palette.ts continentTint). */
export const CONTINENT_IDS = MAP.continentIds;
export const ADJACENCY = MAP.adjacency;
