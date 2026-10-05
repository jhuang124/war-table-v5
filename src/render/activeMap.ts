// v6 maps: the renderer's map. The board's geometry is chosen once per page load (src/map/registry.ts
// activeMapId: ?map=<id>, else the save's config.mapId, else classic) and BOARD (src/map) is that map's
// board.json; this is the same map's rules side (ids, names, continents, adjacency), so nothing in src/render
// assumes the classic 42 or its six continents. Render files read MAP.territoryIds,
// MAP.continents, MAP.adjacency etc. (index i in MAP.territoryIds ↔ ink field label i + 1; a continent's index in
// MAP.continentIds picks its tint, src/shared/palette.ts continentTint).

import { mapDefOf, type MapDef } from '../engine/mapData';
import { activeMapId } from '../map/registry';

export const MAP: MapDef = mapDefOf({ mapId: activeMapId() });
