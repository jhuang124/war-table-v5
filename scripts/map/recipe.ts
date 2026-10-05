// A map pack's build recipe (docs/MAPS.md): how scripts/map/pipeline.ts turns Natural Earth into
// maps/<id>/board.json. One per generated pack, in scripts/map/packs/<id>/index.ts, exporting `recipe`.
// The pack's rules.json (territory ids, names, continents) and topology.json (borders, sea lanes) are
// read from maps/<id>/; the recipe only says where each territory is on the globe and how to draw it.
//
// Recipe v2 (docs/MAP-AUTHORING.md), all additive: a local GeoJSON `source`, a `frame` + projection
// preset, `clip` (land outside a lon/lat polygon becomes faint decor or is dropped), `otherLand`, `splits`
// (cut lines, see cut.ts `cutBy`), and an optional `describe`.

import { BoardProjection, presetProjection, type LonLatBox, type ProjectionPreset } from './projection';
import { cutBy, type LonLat } from './cut';

export { cutBy } from './cut';
export type { LonLat } from './cut';
export type { LonLatBox, ProjectionPreset } from './projection';

/** A territory id from rules.json, an alias from `aliases`, 'decor' (neutral land) or 'drop'. */
export type Resolved = string;
export interface PolyInfo {
  lon: number;
  lat: number;
  /** approx area in square degrees */
  area: number;
}
/**
 * Which territory a Natural Earth country (or part of it) becomes. Either a fixed result, or:
 *   poly(c)  — decided per polygon (island) from its centroid; return undefined to fall through
 *   pixel(l) — decided per pixel from its lon/lat (used to split big countries)
 */
export type Rule =
  | Resolved
  | {
      poly?: (c: PolyInfo) => Resolved | undefined;
      pixel?: (lon: number, lat: number) => Resolved;
      default?: Resolved;
    };

export interface LaneHint {
  /** lon/lat hints: the lane starts at the coast point of a (ends at b's) nearest the hint. */
  ha?: [number, number];
  hb?: [number, number];
}

export interface Tuning {
  /** Raster resolution (pixels per board unit). */
  px: number;
  /** Anchor clearance the build must reach (board units); must equal pack.json anchorClearance. */
  minClearance: number;
  /** What the raster stage aims for, so the vector smoothing still clears minClearance. */
  targetClearance: number;
  /** Minimum water gap between land that must not touch (lane pairs, non-neighbours, decor). */
  gap: number;
  /** Wider water between the two ends of a sea lane, so the crossing reads on the board. */
  laneGap: number;
  /** Growth: at most this many 2 px rounds, claiming water within growthReach × target of the badge spot. */
  maxGrowthRounds: number;
  growthReach: number;
  /** Coast blur sigmas (px) before and after the growth loop. */
  coastSigma: [number, number];
  /** Arc stylisation: Douglas–Peucker tolerance (px), Chaikin rounds, final tolerance (px). */
  simplify: { tol: number; smooth: number; tol2: number };
  /** Minimum speck sizes kept, in square board units: territory pieces, decorative pieces. */
  speck: { terr: number; decor: number; terrLate: number };
  /** Enclosed water smaller than this (square units) is filled. */
  lakeMax: number;
}

export const DEFAULT_TUNING: Tuning = {
  px: 20,
  minClearance: 1.3,
  targetClearance: 1.5,
  gap: 0.4,
  laneGap: 0.8,
  maxGrowthRounds: 3,
  growthReach: 3.5,
  coastSigma: [1.1, 0.9],
  simplify: { tol: 1.35, smooth: 2, tol2: 0.22 },
  speck: { terr: 0.12, decor: 0.4, terrLate: 0.15 },
  lakeMax: 1.2,
};

export interface PreviewShot {
  name: string;
  /** Frame these territories' bboxes... */
  territories?: string[];
  /** ...or this lon/lat box [west, south, east, north]. */
  lonLat?: [number, number, number, number];
  pad: number;
  px: number;
}

/** Natural Earth countries file in node_modules/world-atlas (names are Natural Earth's short names). */
export type WorldAtlasSource = 'countries-50m.json' | 'countries-10m.json';
/**
 * A local GeoJSON FeatureCollection of Polygon / MultiPolygon features, path relative to the repo root
 * (keep it in maps/<id>/source/ with a README saying where it came from and its licence). `assign` keys
 * are then the features' `nameProperty` values.
 */
export interface GeoJsonSource {
  geojson: string;
  nameProperty: string;
}

/** A country carved by hand-drawn cut lines: see cut.ts `cutBy` (the same thing, declared as data). */
export interface Split {
  /** Polylines in lon/lat, each running past the country's edge on both ends. */
  lines: LonLat[][];
  /** One seed point (lon/lat) inside each piece → the territory (or 'decor' / 'drop') it becomes. */
  labels: Record<Resolved, LonLat>;
}

export interface MapRecipe {
  /** Natural Earth countries (world-atlas) or a local GeoJSON file. */
  source: WorldAtlasSource | GeoJsonSource;
  /**
   * A built projection (classic, true-world), or a preset fitted to `frame` (recipe v2):
   * `{ preset: 'mercatorLike' | 'equalEarth' | 'local', width?, margin?, yScale?, lenses? }`.
   */
  projection: BoardProjection | ProjectionPreset;
  /** The board frame [west, south, east, north] in degrees; required with a projection preset. */
  frame?: { lonLat: LonLatBox };
  /** Source feature name → rule. Features without a rule (or a split) are `otherLand`. */
  assign: Record<string, Rule>;
  /** Features carved by cut lines (feature name → split); same as `assign[name] = cutBy(lines, labels)`. */
  splits?: Record<string, Split>;
  /** What happens to features with no rule: 'drop' (default; logged) or 'decor' (faint neutral land). */
  otherLand?: 'decor' | 'drop';
  /**
   * A lon/lat polygon: land outside it becomes decor, or is dropped when it lies more than `clipDrop`
   * degrees outside (how a Roman board shows only the Mediterranean world). Applies to every label,
   * territories included, per pixel.
   */
  clip?: LonLat[];
  /** Degrees outside `clip` beyond which land is dropped instead of drawn as decor (default: never dropped). */
  clipDrop?: number;
  /**
   * Extra raster labels that belong to a territory but keep their own coastline (classic: Ireland is
   * Great Britain's, but must not fuse onto Britain). alias → territory id.
   */
  aliases?: Record<string, string>;
  /** Oriented stretch about an island territory's centroid before rasterising. */
  islandXform?: Record<string, { along: number; across: number; angle: number }>;
  /** When water is carved between one of these and other land, the gap is split instead of eating it. */
  protectedIslands: string[];
  /** Territories allowed to grow a little into the sea to reach targetClearance. */
  autoFatten: string[];
  /** Lane endpoint hints, keyed 'a|b' as the lane is listed in topology.json. */
  laneHints?: Record<string, LaneHint>;
  /** lon/lat near which each continent's name + bonus goes (on clear water). */
  continentLabelHints: Record<string, [number, number]>;
  oceanLabels: { text: string; hint: [number, number]; size: number }[];
  tuning: Tuning;
  /** The human-readable `projection` note written into board.json (default: preset + frame + source). */
  describe?(): string;
  /** Close-ups verify:map renders besides the whole board (artifacts/map/<id>/). */
  previews?: PreviewShot[];
}

const resolved = new WeakMap<MapRecipe, BoardProjection>();

/** The BoardProjection a recipe projects through (its own, or its preset fitted to its frame). */
export function projectionOf(recipe: MapRecipe): BoardProjection {
  if (recipe.projection instanceof BoardProjection) return recipe.projection;
  let p = resolved.get(recipe);
  if (!p) {
    if (!recipe.frame) throw new Error(`recipe: projection preset "${recipe.projection.preset}" needs frame: { lonLat: [west, south, east, north] }`);
    p = presetProjection(recipe.projection, recipe.frame.lonLat);
    resolved.set(recipe, p);
  }
  return p;
}

/** The rule for a source feature: assign, else its split, else otherLand. */
export function ruleOf(recipe: MapRecipe, name: string): Rule | undefined {
  const r = recipe.assign[name];
  const s = recipe.splits?.[name];
  if (r && s) throw new Error(`recipe: "${name}" is in both assign and splits`);
  if (s) {
    let cache = splitRules.get(s);
    if (!cache) splitRules.set(s, (cache = cutBy(s.lines, s.labels)));
    return cache;
  }
  return r ?? (recipe.otherLand === 'decor' ? 'decor' : undefined);
}
const splitRules = new WeakMap<Split, Rule>();

/** The board.json `projection` note. */
export function describeRecipe(recipe: MapRecipe): string {
  if (recipe.describe) return recipe.describe();
  const p = recipe.projection;
  const src = typeof recipe.source === 'string' ? `Natural Earth ${recipe.source}` : recipe.source.geojson;
  const proj = p instanceof BoardProjection ? 'custom projection' : `${p.preset} preset${p.lenses?.length ? ` with lenses ${p.lenses.map((l) => `${l.name} ×${l.m}`).join(', ')}` : ''}`;
  const f = recipe.frame?.lonLat;
  return (
    `${proj}${f ? ` over lon ${f[0]}…${f[2]}, lat ${f[1]}…${f[3]}` : ''}; source ${src}` +
    `${recipe.clip ? '; land outside the clip drawn as decor' : ''}. Rasterised at ${recipe.tuning.px} px/unit, ` +
    `borders are shared arcs (DP + Chaikin). Origin bottom-left, +y north.`
  );
}
