// Classic recipe tunables: lenses, island exaggeration, label hints. (Which borders are sea lanes is
// maps/classic/topology.json; the recipe only says how to draw them.)

import type { ContinentId, TerritoryId } from '../../../../src/engine/types';
import type { LensSpec } from '../../projection';

/** Raster resolution (pixels per board unit). */
export const PX = 20;

/** Required clearance (board units) around each anchor inside its main polygon. */
export const MIN_CLEARANCE = 1.3;
/** What the raster stage aims for, so the vector smoothing still clears MIN_CLEARANCE. */
export const TARGET_CLEARANCE = 1.5;
/** Minimum water gap between land that must not touch (lane pairs, non-neighbours, decor). */
export const GAP = 0.4;
/** Wider water between the two ends of a sea lane, so the dashed crossing reads on the board. */
export const LANE_GAP = 0.8;

export const LENSES: LensSpec[] = [
  // Europe: the crowded seven, Iceland to the Black Sea. Wide ellipse centred on the North Sea.
  { name: 'europe', lon: 6, lat: 53, r0: 5.6, R: 18, m: 1.5, ax: 1.2, ay: 0.95 },
  // Mexico + the isthmus.
  { name: 'central-america', lon: -94, lat: 18, r0: 2.2, R: 8.5, m: 1.4, ax: 1.2, ay: 0.9 },
  // Mainland SE Asia + the Indonesian archipelago + New Guinea.
  { name: 'se-asia', lon: 118, lat: 0, r0: 4.2, R: 14, m: 1.45, ax: 1.35, ay: 0.9 },
  // Northern Andes (Venezuela/Colombia, Peru/Ecuador).
  { name: 'andes', lon: -70, lat: -5, r0: 2.6, R: 9.5, m: 1.32, ax: 1.0, ay: 1.1 },
  // Japan / Korea.
  { name: 'japan', lon: 137, lat: 38, r0: 3.4, R: 9.5, m: 1.58, ax: 1.1, ay: 1.0 },
  // New Guinea.
  { name: 'new-guinea', lon: 142, lat: -5.5, r0: 1.8, R: 6.5, m: 1.35, ax: 1.3, ay: 0.85 },
];

/**
 * Islands exaggerated about their own centroid before rasterising: an oriented stretch
 * (`along` the island's long axis at `angle` degrees from east, `across` it). Thin islands get fat
 * without turning into potatoes. Afterwards AUTO_FATTEN may grow them a little around the badge spot.
 */
export const ISLAND_XFORM: Record<string, { along: number; across: number; angle: number }> = {
  iceland: { along: 1.5, across: 2.3, angle: 0 },
  great_britain: { along: 1.3, across: 1.75, angle: 80 },
  japan: { along: 1.05, across: 3.4, angle: 42 },
  madagascar: { along: 1.15, across: 2.15, angle: 72 },
};

/** When water must be carved between one of these and other land, the gap is split (or taken
 * from the other side) instead of eating the island. */
export const PROTECTED_ISLANDS: TerritoryId[] = ['iceland', 'great_britain', 'japan', 'madagascar', 'new_guinea'];

/**
 * Territories allowed to grow into the sea to reach TARGET_CLEARANCE. Growth is local: only water
 * within ~TARGET_CLEARANCE of the current badge spot is claimed, so outlines keep their character.
 */
/** Growth: at most this many 2 px rounds, claiming water within GROWTH_REACH × target of the badge spot. */
export const MAX_GROWTH_ROUNDS = 3;
export const GROWTH_REACH = 3.5;

export const AUTO_FATTEN: TerritoryId[] = [
  'iceland', 'great_britain', 'japan', 'madagascar', 'new_guinea', 'indonesia', 'central_america',
  'siam', 'scandinavia', 'western_europe', 'southern_europe', 'northern_europe', 'eastern_australia',
  'western_australia', 'egypt', 'venezuela', 'peru',
];

export const CONTINENT_LABEL_HINTS: Record<ContinentId, [number, number]> = {
  north_america: [-146, 24],
  south_america: [-102, -28],
  europe: [-26, 50],
  africa: [-12, -14],
  asia: [168, 44],
  australia: [128, -46],
};

export const OCEAN_LABELS: { text: string; hint: [number, number]; size: number }[] = [
  { text: 'PACIFIC OCEAN', hint: [-138, 6], size: 1.25 },
  { text: 'PACIFIC OCEAN', hint: [172, 8], size: 1.1 },
  { text: 'ATLANTIC OCEAN', hint: [-42, 26], size: 1.25 },
  { text: 'INDIAN OCEAN', hint: [78, -24], size: 1.25 },
  { text: 'ARCTIC OCEAN', hint: [-10, 84], size: 0.9 },
  { text: 'SOUTHERN OCEAN', hint: [40, -50], size: 0.95 },
];
