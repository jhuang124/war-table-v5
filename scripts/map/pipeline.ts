// The map pipeline: one pack's rules + topology + recipe → BoardGeometry (maps/<id>/board.json).
//
//   countries → territory rules (recipe.assign) → projection + smooth lenses (recipe.projection)
//   → label raster (px / unit) → coast smoothing, island exaggeration, water gaps, speck removal
//   → shared-arc vectorisation (borders stay vertex-identical) → DP + Chaikin stylisation
//   → anchors (polylabel), label anchors, sea lanes, continent + ocean labels.
//
// Deterministic: the same inputs give the same bytes (classic's output is pinned by verify:map).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { feature } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import polylabel from 'polylabel';

import type { BoardGeometry, PolygonGeom, SeaLaneGeom, TerritoryGeom, Vec2 } from '../../src/map/types';
import { describeRecipe, projectionOf, ruleOf, type MapRecipe, type Resolved, type Rule } from './recipe';
import { ROOT, pairKey, type LoadedPack } from './pack';
import { Grid, OCEAN, fillPolygon, edt, labelBboxes, components, blur, fillFromNearest, SAT } from './raster';
import { extractArcs, simplifyArc, findCrossingArcs, assemble, type LabelPolygon } from './vectorize';
import { ringArea, closestOnSeg, round3, bboxOf, pointInPoly, distToPolyBoundary, type P } from './geom';

type SourceFeature = { properties: { name: string }; geometry: { type: string; coordinates: any } | null };

/** The recipe's source as features named by `name` (world-atlas countries, or a local GeoJSON file). */
export function loadSource(recipe: MapRecipe): { features: SourceFeature[] } {
  const src = recipe.source;
  if (typeof src === 'string') {
    const topo = JSON.parse(readFileSync(resolve(ROOT, 'node_modules/world-atlas', src), 'utf8')) as Topology;
    return feature(topo, topo.objects.countries as GeometryCollection) as unknown as { features: SourceFeature[] };
  }
  const gj = JSON.parse(readFileSync(resolve(ROOT, src.geojson), 'utf8')) as {
    type: string;
    features: { properties: Record<string, unknown> | null; geometry: SourceFeature['geometry'] }[];
  };
  if (gj.type !== 'FeatureCollection') throw new Error(`${src.geojson}: expected a GeoJSON FeatureCollection`);
  const features: SourceFeature[] = [];
  for (const f of gj.features) {
    const name = f.properties?.[src.nameProperty];
    if (typeof name !== 'string' || !name) throw new Error(`${src.geojson}: a feature has no "${src.nameProperty}" property`);
    features.push({ properties: { name }, geometry: f.geometry });
  }
  return { features };
}

/** Even-odd point in a lon/lat ring, and the distance (degrees) to it. */
function inRing(x: number, y: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function ringDist(x: number, y: number, ring: [number, number][]): number {
  let d = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const c = closestOnSeg(x, y, ring[j][0], ring[j][1], ring[i][0], ring[i][1]);
    d = Math.min(d, Math.hypot(c[0] - x, c[1] - y));
  }
  return d;
}

export function buildBoard(pack: LoadedPack, recipe: MapRecipe, log: (...a: unknown[]) => void): BoardGeometry {
  const TERRITORY_IDS = pack.territoryIds;
  const NAME = pack.names;
  const T = recipe.tuning;
  const PX = T.px, GAP = T.gap, LANE_GAP = T.laneGap, MIN_CLEARANCE = T.minClearance, TARGET_CLEARANCE = T.targetClearance;
  const proj = projectionOf(recipe);
  const unwrapLon = (lon: number) => proj.unwrapLon(lon);
  const WIDTH = proj.width;
  const OVERHANG = pack.manifest.presentation.anchorOverhang ?? null;
  if (MIN_CLEARANCE !== pack.manifest.presentation.anchorClearance)
    throw new Error(`recipe minClearance ${MIN_CLEARANCE} ≠ pack.json anchorClearance ${pack.manifest.presentation.anchorClearance}`);

  // -------------------------------------------------------------------------------------------
  // Labels: 1..N territories, N+1 decor, then aliases.
  const N = TERRITORY_IDS.length;
  const DECOR = N + 1;
  const ALIASES = Object.entries(recipe.aliases ?? {});
  const ALIAS_LABEL = new Map<string, number>(ALIASES.map(([a], i) => [a, N + 2 + i]));
  const NLABELS = N + 2 + ALIASES.length;
  if (NLABELS > 255) throw new Error(`too many labels (${NLABELS}); the raster holds 255`);
  const LABEL_OF = new Map<string, number>(TERRITORY_IDS.map((t, i) => [t, i + 1]));
  const ALIAS_OF = new Map<number, string>(ALIASES.map(([, t], i) => [N + 2 + i, t]));
  const TERR_OF = (l: number): string => ALIAS_OF.get(l) ?? TERRITORY_IDS[l - 1];
  const SEA_LANES = pack.topology.seaLanes;
  const LANE_SET = new Set(SEA_LANES.map((l) => pairKey(l.a, l.b)));
  const BORDER_SET = new Set(pack.topology.borders.map(([a, b]) => pairKey(a, b)));
  for (const k of LANE_SET) if (!BORDER_SET.has(k)) throw new Error(`sea lane ${k} is not a border`);
  for (const [a, t] of ALIASES) {
    if (LABEL_OF.has(a)) throw new Error(`alias ${a} collides with a territory id`);
    if (!LABEL_OF.has(t)) throw new Error(`alias ${a} → unknown territory ${t}`);
  }

  /** May these two labels share a land border? */
  function mayTouch(a: number, b: number): boolean {
    if (a === b) return true;
    if (a === OCEAN || b === OCEAN) return true;
    if (a === DECOR || b === DECOR) return false;
    if (TERR_OF(a) === TERR_OF(b)) return false; // Britain vs Ireland: keep the Irish Sea
    const k = pairKey(TERR_OF(a), TERR_OF(b));
    return BORDER_SET.has(k) && !LANE_SET.has(k);
  }
  const MAY = new Uint8Array(NLABELS * NLABELS);
  for (let a = 0; a < NLABELS; a++) for (let b = 0; b < NLABELS; b++) MAY[a * NLABELS + b] = mayTouch(a, b) ? 1 : 0;
  /** Required water gap (px) between two labels that may not touch. */
  const GAPPX = new Float64Array(NLABELS * NLABELS);
  for (let a = 1; a < NLABELS; a++)
    for (let b = 1; b < NLABELS; b++) {
      const lane = a !== DECOR && b !== DECOR && a !== b && LANE_SET.has(pairKey(TERR_OF(a), TERR_OF(b)));
      GAPPX[a * NLABELS + b] = (lane ? LANE_GAP : GAP) * PX;
    }

  // -------------------------------------------------------------------------------------------
  // 1. Source geometry
  const fc = loadSource(recipe);
  const WIDTH_PX = WIDTH * PX;
  const HEIGHT = Math.ceil(proj.height * 2) / 2; // round to 0.5 units
  const HEIGHT_PX = Math.round(HEIGHT * PX);
  log(`board ${WIDTH} × ${HEIGHT} units, raster ${WIDTH_PX} × ${HEIGHT_PX}`);

  type Code = { label: number } | { pixel: (lon: number, lat: number) => Resolved };
  const codes: Code[] = [];
  const labelFor = (r: Resolved): number => {
    if (r === 'drop') return -1;
    if (r === 'decor') return DECOR;
    const l = ALIAS_LABEL.get(r) ?? LABEL_OF.get(r);
    if (l === undefined) throw new Error(`assignment names unknown territory "${r}"`);
    return l;
  };

  interface SrcPoly {
    rings: P[][]; // board coords
    code: number;
    direct: string | null;
  }
  const srcPolys: SrcPoly[] = [];
  const unassigned = new Set<string>();
  const codeCache = new Map<string, number>();
  function codeForLabel(l: number): number {
    const k = `L${l}`;
    if (!codeCache.has(k)) codeCache.set(k, codes.push({ label: l }) - 1);
    return codeCache.get(k)!;
  }

  for (const f of fc.features) {
    const name = f.properties.name;
    const rule: Rule | undefined = ruleOf(recipe, name);
    if (!f.geometry) continue;
    if (!rule) {
      unassigned.add(name);
      continue;
    }
    const polys: [number, number][][][] =
      f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [];
    let pixelCode = -1;
    for (const rawPoly of polys) {
      // Make every ring continuous in longitude (rings may cross the antimeridian in one piece).
      const poly = rawPoly.map((ring) => {
        const out: [number, number][] = [];
        let prev = ring[0][0];
        let off = 0;
        for (const [lo, la] of ring) {
          let l = lo + off;
          while (l - prev > 180) (l -= 360), (off -= 360);
          while (prev - l > 180) (l += 360), (off += 360);
          out.push([l, la]);
          prev = l;
        }
        return out;
      });
      const outer = poly[0];
      let mlon = 0, mlat = 0;
      for (const [lo, la] of outer) (mlon += lo), (mlat += la);
      mlon /= outer.length;
      mlat /= outer.length;
      const shift = unwrapLon(mlon) - mlon;
      const lon = mlon + shift, lat = mlat;
      const area = Math.abs(ringArea(outer as P[]));
      let res: Resolved | 'pixel';
      if (typeof rule === 'string') res = rule;
      else {
        const r = rule.poly?.({ lon, lat, area });
        res = r ?? (rule.pixel ? 'pixel' : (rule.default ?? 'drop'));
      }
      if (res === 'drop') continue;
      let code: number;
      let direct: string | null = null;
      if (res === 'pixel') {
        if (pixelCode < 0) pixelCode = codes.push({ pixel: (rule as { pixel: (a: number, b: number) => Resolved }).pixel }) - 1;
        code = pixelCode;
      } else {
        code = codeForLabel(labelFor(res));
        if (res !== 'decor') direct = recipe.aliases?.[res] ?? res;
      }
      const rings = poly.map((ring) =>
        ring.slice(0, ring.length - 1).map(([lo, la]) => {
          const clampedLat = Math.max(-85, Math.min(85, la));
          return proj.forward(lo + shift, clampedLat) as P;
        }),
      );
      srcPolys.push({ rings, code, direct });
    }
  }
  if (unassigned.size) log(`dropped (no rule): ${[...unassigned].sort().join(', ')}`);

  // Island exaggeration: oriented stretch about each island-territory's area-weighted centroid.
  const ISLAND_XFORM = recipe.islandXform ?? {};
  for (const [t, xf] of Object.entries(ISLAND_XFORM)) {
    const ps = srcPolys.filter((p) => p.direct === t);
    let ax = 0, ay = 0, aw = 0;
    for (const p of ps) {
      const a = Math.abs(ringArea(p.rings[0]));
      const bb = bboxOf([p.rings[0]]);
      ax += ((bb[0] + bb[2]) / 2) * a;
      ay += ((bb[1] + bb[3]) / 2) * a;
      aw += a;
    }
    const cx = ax / aw, cy = ay / aw;
    const th = (xf.angle * Math.PI) / 180, ux = Math.cos(th), uy = Math.sin(th);
    const map = ([x, y]: P): P => {
      const dx = x - cx, dy = y - cy;
      const u = (dx * ux + dy * uy) * xf.along, v = (-dx * uy + dy * ux) * xf.across;
      return [cx + u * ux - v * uy, cy + u * uy + v * ux];
    };
    for (const p of ps) p.rings = p.rings.map((r) => r.map(map));
  }

  // -------------------------------------------------------------------------------------------
  // 2. Rasterise
  const g = new Grid(WIDTH_PX, HEIGHT_PX, PX);
  const codeGrid = new Int16Array(WIDTH_PX * HEIGHT_PX).fill(-1);
  const scaled = new Set(Object.keys(ISLAND_XFORM));
  for (const pass of [0, 1]) {
    for (const p of srcPolys) {
      const isScaled = p.direct !== null && scaled.has(p.direct);
      if ((pass === 0) === isScaled) continue;
      fillPolygon(p.rings, WIDTH_PX, HEIGHT_PX, PX, (idx) => {
        if (pass === 1 && codeGrid[idx] >= 0) return; // exaggerated islands never overwrite real land
        codeGrid[idx] = p.code;
      });
    }
  }
  // Recipe v2 clip: land outside the lon/lat polygon becomes decor (or is dropped beyond clipDrop degrees).
  const CLIP = recipe.clip?.map(([lo, la]) => [unwrapLon(lo), la] as [number, number]) ?? null;
  const CLIP_DROP = recipe.clipDrop ?? Infinity;
  let clippedPx = 0;
  for (let idx = 0; idx < codeGrid.length; idx++) {
    const c = codeGrid[idx];
    if (c < 0) continue;
    const code = codes[c];
    let l: number;
    let ll: [number, number] | null = null;
    const lonLat = () => {
      if (!ll) {
        const i = idx % WIDTH_PX, r = (idx - i) / WIDTH_PX;
        ll = proj.inverse((i + 0.5) / PX, (r + 0.5) / PX);
      }
      return ll;
    };
    if ('label' in code) l = code.label;
    else {
      const [lon, lat] = lonLat();
      l = labelFor(code.pixel(lon, lat));
    }
    if (CLIP && l >= 0) {
      const [lon, lat] = lonLat();
      if (!inRing(lon, lat, CLIP)) {
        l = CLIP_DROP === Infinity || ringDist(lon, lat, CLIP) <= CLIP_DROP ? DECOR : -1;
        clippedPx++;
      }
    }
    g.lab[idx] = l < 0 ? OCEAN : l;
  }
  if (CLIP) log(`clip: ${clippedPx} land px outside the clip became decor or dropped`);
  log('rasterised');

  // -------------------------------------------------------------------------------------------
  // 3. Raster clean-up
  function smoothCoast(sigma: number) {
    const n = g.w * g.h;
    const land = new Float32Array(n);
    for (let p = 0; p < n; p++) land[p] = g.lab[p] !== OCEAN ? 1 : 0;
    const b = blur(land, g.w, g.h, sigma);
    const need = new Uint8Array(n);
    for (let p = 0; p < n; p++) {
      const isLand = b[p] >= 0.5;
      if (!isLand && g.lab[p] !== OCEAN) g.lab[p] = OCEAN;
      else if (isLand && g.lab[p] === OCEAN) need[p] = 1;
    }
    fillFromNearest(g, need);
  }

  function dropSpecks(minTerrPx: number, minDecorPx: number) {
    const { comp, sizes, labels } = components(g, (l) => l !== OCEAN);
    const biggest = new Map<number, number>();
    sizes.forEach((s, id) => {
      const l = labels[id];
      if (!biggest.has(l) || sizes[biggest.get(l)!] < s) biggest.set(l, id);
    });
    for (let p = 0; p < comp.length; p++) {
      const id = comp[p];
      if (id < 0) continue;
      const l = labels[id];
      const min = l === DECOR ? minDecorPx : minTerrPx;
      if (sizes[id] < min && biggest.get(l) !== id) g.lab[p] = OCEAN;
    }
  }

  function fillSmallLakes(maxPx: number) {
    const { comp, sizes } = components(g, (l) => l === OCEAN);
    const touchesEdge = new Uint8Array(sizes.length);
    for (let i = 0; i < g.w; i++) {
      touchesEdge[comp[i]] = 1;
      touchesEdge[comp[(g.h - 1) * g.w + i]] = 1;
    }
    for (let r = 0; r < g.h; r++) {
      touchesEdge[comp[r * g.w]] = 1;
      touchesEdge[comp[r * g.w + g.w - 1]] = 1;
    }
    const need = new Uint8Array(g.w * g.h);
    for (let p = 0; p < comp.length; p++) {
      const id = comp[p];
      if (id >= 0 && !touchesEdge[id] && sizes[id] <= maxPx) need[p] = 1;
    }
    fillFromNearest(g, need);
  }

  /** Grow `label` into the sea by up to radPx, but only within maxDist px of (ci, cr). */
  function fatten(label: number, radPx: number, ci: number, cr: number, maxDist: number) {
    const bb = labelBboxes(g)[label];
    if (!bb) return;
    const x0 = Math.max(0, bb.x0 - radPx - 1), y0 = Math.max(0, bb.y0 - radPx - 1);
    const x1 = Math.min(g.w - 1, bb.x1 + radPx + 1), y1 = Math.min(g.h - 1, bb.y1 + radPx + 1);
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const d = edt((i, r) => g.lab[r * g.w + i] === label, x0, y0, w, h);
    const r2 = radPx * radPx, m2 = maxDist * maxDist;
    for (let r = 0; r < h; r++)
      for (let i = 0; i < w; i++) {
        const p = (r + y0) * g.w + i + x0;
        const di = i + x0 - ci, dr = r + y0 - cr;
        if (g.lab[p] === OCEAN && d[r * w + i] <= r2 && di * di + dr * dr <= m2) g.lab[p] = label;
      }
  }

  const PROTECTED = new Set<number>([...recipe.protectedIslands.map((t) => LABEL_OF.get(t)!), ...ALIAS_LABEL.values()]);
  /** Carve water gaps of at least `gapPx` between land that must not touch. */
  function separate(gapPx: number, symmetric: boolean): number {
    const { comp, sizes, labels } = components(g, (l) => l !== OCEAN);
    const n = sizes.length;
    // component bboxes
    const bx0 = new Int32Array(n).fill(1e9), by0 = new Int32Array(n).fill(1e9), bx1 = new Int32Array(n).fill(-1), by1 = new Int32Array(n).fill(-1);
    for (let p = 0; p < comp.length; p++) {
      const id = comp[p];
      if (id < 0) continue;
      const i = p % g.w, r = (p - i) / g.w;
      if (i < bx0[id]) bx0[id] = i;
      if (i > bx1[id]) bx1[id] = i;
      if (r < by0[id]) by0[id] = r;
      if (r > by1[id]) by1[id] = r;
    }
    const carve = new Uint8Array(comp.length);
    const G = Math.ceil(gapPx);
    const contactPairs = new Map<string, number>();
    for (let c = 0; c < n; c++) {
      const lc = labels[c];
      if (lc === DECOR) continue;
      const x0 = Math.max(0, bx0[c] - G - 1), y0 = Math.max(0, by0[c] - G - 1);
      const x1 = Math.min(g.w - 1, bx1[c] + G + 1), y1 = Math.min(g.h - 1, by1[c] + G + 1);
      // Is any must-separate pixel in the window at all? (cheap pre-check)
      let any = false;
      for (let r = y0; r <= y1 && !any; r++)
        for (let i = x0; i <= x1; i++) {
          const l = g.lab[r * g.w + i];
          if (l !== OCEAN && !MAY[lc * NLABELS + l]) {
            any = true;
            break;
          }
        }
      if (!any) continue;
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      const d = edt((i, r) => comp[r * g.w + i] === c, x0, y0, w, h);
      for (let r = 0; r < h; r++)
        for (let i = 0; i < w; i++) {
          const p = (r + y0) * g.w + i + x0;
          const l = g.lab[p];
          if (l === OCEAN || MAY[lc * NLABELS + l]) continue;
          const dd = d[r * w + i];
          const gp = GAPPX[lc * NLABELS + l];
          if (dd >= gp * gp) continue;
          const H2 = (gp / 2) * (gp / 2);
          if (dd <= 1) {
            const k = l === DECOR ? `${TERR_OF(lc)}|decor` : pairKey(TERR_OF(lc), TERR_OF(l));
            contactPairs.set(k, (contactPairs.get(k) ?? 0) + 1);
          }
          const other = comp[p];
          // Exaggerated islands are protected: they never lose the whole gap to a mainland.
          const pc = PROTECTED.has(lc), po = PROTECTED.has(l);
          const ratio = (sizes[c] * (pc ? 1e6 : 1)) / (sizes[other] * (po ? 1e6 : 1));
          if (l === DECOR) carve[p] = 1;
          else if (symmetric && ((pc || po) || (ratio < 5 && ratio > 0.2))) {
            if (dd < H2) carve[p] = 1;
          } else if (ratio > 1 || (ratio === 1 && c < other)) carve[p] = 1;
        }
    }
    let count = 0;
    for (let p = 0; p < carve.length; p++) if (carve[p]) (g.lab[p] = OCEAN), count++;
    if (contactPairs.size) {
      const list = [...contactPairs.entries()].map(([k, v]) => `${k}(${v})`).join(', ');
      log(`  note: direct contacts carved apart: ${list}`);
    }
    return count;
  }

  function removeDiagonals() {
    let changed = true, rounds = 0;
    while (changed && rounds++ < 20) {
      changed = false;
      for (let r = 0; r + 1 < g.h; r++)
        for (let i = 0; i + 1 < g.w; i++) {
          const pa = r * g.w + i, pb = pa + 1, pc = pa + g.w, pd = pc + 1;
          const a = g.lab[pa], b = g.lab[pb], c = g.lab[pc], d = g.lab[pd];
          if (a === d && a !== OCEAN && b !== a && c !== a) {
            const target = b === OCEAN ? pb : c === OCEAN ? pc : pb;
            g.lab[target] = a;
            changed = true;
          } else if (b === c && b !== OCEAN && a !== b && d !== b) {
            const target = a === OCEAN ? pa : d === OCEAN ? pd : pa;
            g.lab[target] = b;
            changed = true;
          }
        }
    }
  }

  /** Max distance (px) from the main component of each territory to its edge. */
  const POLE = new Map<number, [number, number]>();
  function rasterClearance(): Map<number, number> {
    const res = new Map<number, number>();
    const { comp, sizes, labels } = components(g, (l) => l !== OCEAN && l !== DECOR);
    const main = new Map<number, number>();
    sizes.forEach((s, id) => {
      const l = labels[id];
      if (!main.has(l) || sizes[main.get(l)!] < s) main.set(l, id);
    });
    const bbs = labelBboxes(g);
    for (const [l, id] of main) {
      const bb = bbs[l]!;
      const x0 = bb.x0 - 1, y0 = bb.y0 - 1, w = bb.x1 - bb.x0 + 3, h = bb.y1 - bb.y0 + 3;
      const d = edt((i, r) => i < 0 || r < 0 || i >= g.w || r >= g.h || comp[r * g.w + i] !== id, x0, y0, w, h);
      let best = 0, bk = 0;
      for (let k = 0; k < d.length; k++) if (d[k] > best) (best = d[k]), (bk = k);
      res.set(l, Math.sqrt(best));
      POLE.set(l, [x0 + (bk % w), y0 + Math.floor(bk / w)]);
    }
    return res;
  }

  const SPK = T.speck;
  const gapPx = Math.max(GAP, LANE_GAP) * PX;
  smoothCoast(T.coastSigma[0]);
  dropSpecks(Math.round(SPK.terr * PX * PX), Math.round(SPK.decor * PX * PX));
  log('coast smoothed, specks dropped');

  // Island / small-territory growth loop: a small, broad buffer (never a lollipop). The real size
  // comes from the lenses and island stretches in the recipe; this only tops up the last few pixels.
  const target = TARGET_CLEARANCE * PX;
  {
    const cl = rasterClearance();
    log('pre-growth clearance (tight):', TERRITORY_IDS.map((t) => [t, (cl.get(LABEL_OF.get(t)!) ?? 0) / PX] as const)
      .filter(([, c]) => c < TARGET_CLEARANCE + 0.2).map(([t, c]) => `${t}=${c.toFixed(2)}`).join(' '));
  }
  for (let round = 0; round < T.maxGrowthRounds; round++) {
    const cl = rasterClearance();
    const short = recipe.autoFatten.filter((t) => (cl.get(LABEL_OF.get(t)!) ?? 0) < target);
    if (!short.length) break;
    for (const t of short) {
      const l = LABEL_OF.get(t)!;
      const [ci, cr] = POLE.get(l)!;
      fatten(l, 2, ci, cr, target * T.growthReach);
    }
    separate(gapPx, true);
    separate(gapPx, false);
    dropSpecks(Math.round(SPK.terr * PX * PX), Math.round(SPK.decor * PX * PX));
    log(`  fatten round ${round}: ${short.join(', ')}`);
  }
  separate(gapPx, true);
  separate(gapPx, false);
  smoothCoast(T.coastSigma[1]);
  separate(gapPx, false);
  dropSpecks(Math.round(SPK.terrLate * PX * PX), Math.round(SPK.decor * PX * PX));
  fillSmallLakes(Math.round(T.lakeMax * PX * PX));
  removeDiagonals();
  separate(gapPx, false);
  removeDiagonals();
  log('raster cleaned');

  {
    const cl = rasterClearance();
    const rows = TERRITORY_IDS.map((t) => [t, ((cl.get(LABEL_OF.get(t)!) ?? 0) / PX).toFixed(2)] as const)
      .filter(([, c]) => Number(c) < TARGET_CLEARANCE + 0.3);
    if (rows.length) log('raster clearance (tight ones):', rows.map(([t, c]) => `${t}=${c}`).join(' '));
  }

  // -------------------------------------------------------------------------------------------
  // 4. Vectorise with shared arcs
  const arcs = extractArcs(g);
  log(`arcs: ${arcs.length}`);
  const { tol: TOL, smooth: SMOOTH, tol2: TOL2 } = T.simplify;
  for (const a of arcs) simplifyArc(a, TOL, SMOOTH, TOL2);
  for (let round = 0; round < 6; round++) {
    const bad = findCrossingArcs(arcs);
    if (!bad.size) break;
    for (const ai of bad) {
      const a = arcs[ai];
      const tol = round >= 4 ? 0 : a.tol * 0.5;
      simplifyArc(a, tol, round >= 3 ? 0 : 1, round >= 3 ? 0 : TOL2 * 0.5);
    }
    log(`  crossing repair round ${round}: ${bad.size} arcs`);
  }
  const allLabels = [...TERRITORY_IDS.map((t) => LABEL_OF.get(t)!), DECOR, ...ALIAS_LABEL.values()];
  const polys = assemble(arcs, allLabels, PX);
  for (const [a, t] of ALIASES) {
    const tl = LABEL_OF.get(t)!, al = ALIAS_LABEL.get(a)!;
    const merged = [...(polys.get(tl) ?? []), ...(polys.get(al) ?? [])].sort((p, q) => q.area - p.area);
    polys.set(tl, merged);
    polys.delete(al);
  }
  log('assembled polygons');

  // -------------------------------------------------------------------------------------------
  // 5. Anchors + labels
  const r3 = (p: P): Vec2 => [round3(p[0]), round3(p[1])];
  const toGeom = (lp: LabelPolygon): PolygonGeom => ({ outer: lp.outer.map(r3), holes: lp.holes.map((h) => h.map(r3)) });

  const territories = {} as Record<string, TerritoryGeom>;
  const labelAt = (x: number, y: number) => g.at(Math.floor(x * PX), Math.floor(y * PX));

  for (const t of TERRITORY_IDS) {
    const lps = polys.get(LABEL_OF.get(t)!) ?? [];
    if (!lps.length) throw new Error(`territory ${t} has no geometry`);
    const geoms = lps.map(toGeom);
    const main = geoms[0];
    const pl = polylabel([main.outer, ...main.holes] as [number, number][][], 0.005);
    const anchor: Vec2 = [round3(pl[0]), round3(pl[1])];
    const area = geoms.reduce((s, gm) => s + ringArea(gm.outer) + gm.holes.reduce((q, h) => q + ringArea(h), 0), 0);
    territories[t] = {
      id: t as TerritoryGeom['id'],
      polygons: geoms,
      anchor,
      labelAnchor: anchor,
      area: round3(area),
      bbox: bboxOf(geoms.map((gm) => gm.outer)).map(round3) as [number, number, number, number],
    };
    if (pl.distance < MIN_CLEARANCE && !OVERHANG) log(`  WARN ${t}: anchor clearance ${pl.distance.toFixed(2)} < ${MIN_CLEARANCE}`);
  }

  // Overhanging anchors (pack.json presentation.anchorOverhang): where the whole disc can't sit on the
  // territory's own land, put it where it clears every other territory's land by MIN_CLEARANCE and keeps
  // the most own land under it; the rest of the disc overhangs open water.
  if (OVERHANG) {
    const others = (t: string) => [
      ...TERRITORY_IDS.filter((u) => u !== t).flatMap((u) => territories[u].polygons.map((pg) => ({ pg, bb: bboxOf([pg.outer as P[]]) }))),
      ...(polys.get(DECOR) ?? []).map(toGeom).map((pg) => ({ pg, bb: bboxOf([pg.outer as P[]]) })),
    ];
    for (const t of TERRITORY_IDS) {
      const tg = territories[t];
      const main = tg.polygons[0];
      const own0 = distToPolyBoundary(tg.anchor[0], tg.anchor[1], main);
      if (own0 >= MIN_CLEARANCE) continue;
      const near = others(t);
      const foreign = (x: number, y: number) => {
        let d = Infinity;
        for (const { pg, bb } of near) {
          if (bb[0] - d > x || bb[2] + d < x || bb[1] - d > y || bb[3] + d < y) continue;
          d = pointInPoly(x, y, pg) ? 0 : Math.min(d, distToPolyBoundary(x, y, pg));
          if (d === 0) break;
        }
        // Another army's disc counts as land: two discs never overlap.
        for (const u of TERRITORY_IDS) if (u !== t) d = Math.min(d, Math.hypot(x - territories[u].anchor[0], y - territories[u].anchor[1]) - MIN_CLEARANCE);
        return d;
      };
      const [x0, y0, x1, y1] = bboxOf([main.outer as P[]]);
      let best: Vec2 = tg.anchor, bestScore = -Infinity, bestOwn = own0, bestForeign = foreign(...tg.anchor);
      const step = 0.08;
      for (let y = y0 + step / 2; y < y1; y += step)
        for (let x = x0 + step / 2; x < x1; x += step) {
          if (!pointInPoly(x, y, main)) continue;
          const own = distToPolyBoundary(x, y, main);
          if (own < OVERHANG.ownLand) continue;
          const f = foreign(x, y);
          const score = Math.min(f, MIN_CLEARANCE + 0.05) * 100 + Math.min(own, MIN_CLEARANCE) - 0.02 * Math.hypot(x - tg.anchor[0], y - tg.anchor[1]);
          if (score > bestScore) (bestScore = score), (best = [round3(x), round3(y)]), (bestOwn = own), (bestForeign = f);
        }
      tg.anchor = best;
      tg.labelAnchor = best;
      const ok = bestForeign >= MIN_CLEARANCE && bestOwn >= OVERHANG.ownLand;
      log(`  ${ok ? 'overhang' : 'WARN'} ${t}: own land ${bestOwn.toFixed(2)}, other land ${bestForeign.toFixed(2)} away${ok ? '' : ` < ${MIN_CLEARANCE}`}`);
    }
  }

  // Territory name anchors: greedy, smallest territories first. A name box (assumed cap height ~0.55,
  // 0.36 units/char) should sit on its own tile, clear of every badge disc (r = MIN_CLEARANCE) and of
  // names already placed; hanging over water is tolerated, over a neighbour is not.
  {
    const placed: [number, number, number, number][] = [];
    const order = [...TERRITORY_IDS].sort((p, q) => territories[p].area - territories[q].area);
    const anchors = TERRITORY_IDS.map((t) => territories[t].anchor);
    for (const t of order) {
      const L = LABEL_OF.get(t)!;
      const [ax, ay] = territories[t].anchor;
      const name = NAME[t];
      const bw = 0.36 * name.length + 0.3, bh = 0.72;
      const cands: [number, number][] = [];
      for (const dy of [-1.85, 1.85, -2.25, 2.25, -2.7, 2.7, -3.2, 3.2])
        for (const dx of [0, -0.8, 0.8, -1.6, 1.6, -2.6, 2.6]) cands.push([dx, dy]);
      for (const dx of [1, -1]) cands.push([dx * (MIN_CLEARANCE + 0.25 + bw / 2), 0]);
      let best: [number, number] = [ax, ay - 1.85], bestScore = -Infinity;
      for (const [dx, dy] of cands) {
        const cx = ax + dx, cy = ay + dy;
        let score = -0.08 * Math.hypot(dx, dy);
        for (let sx = 0; sx <= 8; sx++)
          for (let sy = 0; sy <= 2; sy++) {
            const x = cx - bw / 2 + (bw * sx) / 8, y = cy - bh / 2 + (bh * sy) / 2;
            const l = labelAt(x, y);
            const alias = ALIAS_OF.get(l);
            const lt = alias !== undefined ? LABEL_OF.get(alias)! : l;
            score += lt === L ? 1 : l === OCEAN ? 0.2 : -1.6;
            for (const [px, py] of anchors) if (Math.hypot(x - px, y - py) < MIN_CLEARANCE) score -= 2.5;
            for (const [x0, y0, x1, y1] of placed) if (x > x0 && x < x1 && y > y0 && y < y1) score -= 3;
            if (x < 0.3 || x > WIDTH - 0.3 || y < 0.3 || y > HEIGHT - 0.3) score -= 3;
          }
        if (score > bestScore) (bestScore = score), (best = [cx, cy]);
      }
      placed.push([best[0] - bw / 2 - 0.1, best[1] - bh / 2 - 0.05, best[0] + bw / 2 + 0.1, best[1] + bh / 2 + 0.05]);
      territories[t].labelAnchor = [round3(best[0]), round3(best[1])];
    }
  }

  // -------------------------------------------------------------------------------------------
  // 6. Sea lanes
  function coastPoints(t: string): P[][] {
    return territories[t].polygons.map((pg) => pg.outer as P[]);
  }
  function closestPair(a: string, b: string): [P, P, number] {
    let best: [P, P, number] = [[0, 0], [0, 0], Infinity];
    const A = coastPoints(a), B = coastPoints(b);
    const test = (from: P[][], to: P[][], flip: boolean) => {
      for (const ra of from)
        for (const p of ra)
          for (const rb of to) {
            for (let k = 0; k < rb.length; k++) {
              const q0 = rb[k], q1 = rb[(k + 1) % rb.length];
              // quick reject by bbox distance
              const mx = Math.max(Math.min(q0[0], q1[0]) - p[0], p[0] - Math.max(q0[0], q1[0]), 0);
              const my = Math.max(Math.min(q0[1], q1[1]) - p[1], p[1] - Math.max(q0[1], q1[1]), 0);
              if (mx * mx + my * my >= best[2] * best[2]) continue;
              const c = closestOnSeg(p[0], p[1], q0[0], q0[1], q1[0], q1[1]);
              const d = Math.hypot(c[0] - p[0], c[1] - p[1]);
              if (d < best[2]) best = flip ? [c, p, d] : [p, c, d];
            }
          }
    };
    test(A, B, false);
    test(B, A, true);
    return best;
  }
  function nearestCoast(t: string, x: number, y: number): P {
    let best: P = [x, y], bd = Infinity;
    for (const ring of coastPoints(t))
      for (let k = 0; k < ring.length; k++) {
        const q0 = ring[k], q1 = ring[(k + 1) % ring.length];
        const c = closestOnSeg(x, y, q0[0], q0[1], q1[0], q1[1]);
        const d = Math.hypot(c[0] - x, c[1] - y);
        if (d < bd) (bd = d), (best = c);
      }
    return best;
  }
  function foreignLand(pts: P[], a: string, b: string): number {
    const la = LABEL_OF.get(a)!, lb = LABEL_OF.get(b)!;
    let bad = 0;
    for (let k = 1; k < pts.length; k++) {
      const [x0, y0] = pts[k - 1], [x1, y1] = pts[k];
      const L = Math.hypot(x1 - x0, y1 - y0);
      const n = Math.max(1, Math.ceil(L / 0.05));
      for (let s = 0; s < n; s++) {
        const x = x0 + ((x1 - x0) * (s + 0.5)) / n, y = y0 + ((y1 - y0) * (s + 0.5)) / n;
        const l = g.at(Math.floor(x * PX), Math.floor(y * PX));
        if (l !== OCEAN && l !== la && l !== lb) bad += L / n;
      }
    }
    return bad;
  }
  function arcPts(p: P, q: P, bulge: number): P[] {
    const dx = q[0] - p[0], dy = q[1] - p[1];
    const L = Math.hypot(dx, dy);
    const nx = -dy / L, ny = dx / L;
    const c: P = [(p[0] + q[0]) / 2 + nx * bulge, (p[1] + q[1]) / 2 + ny * bulge];
    const n = Math.max(8, Math.min(24, Math.round(L * 2.5)));
    const out: P[] = [];
    for (let k = 0; k <= n; k++) {
      const t = k / n, u = 1 - t;
      out.push([u * u * p[0] + 2 * u * t * c[0] + t * t * q[0], u * u * p[1] + 2 * u * t * c[1] + t * t * q[1]]);
    }
    return out;
  }

  const seaLanes: SeaLaneGeom[] = [];
  for (const spec of SEA_LANES) {
    const hint = recipe.laneHints?.[`${spec.a}|${spec.b}`] ?? {};
    if (spec.wrap) {
      // Wrap: a's westernmost coast → left edge; right edge → b's easternmost coast.
      // (With lon/lat hints, from the coast nearest each hint instead: on a pseudocylindrical board the
      // westernmost point of `a` need not be on the strait.)
      let pa: P = [Infinity, 0], pb: P = [-Infinity, 0];
      for (const ring of coastPoints(spec.a)) for (const p of ring) if (p[0] < pa[0]) pa = p;
      for (const ring of coastPoints(spec.b)) for (const p of ring) if (p[0] > pb[0]) pb = p;
      if (hint.ha) pa = nearestCoast(spec.a, ...proj.forward(unwrapLon(hint.ha[0]), hint.ha[1]));
      if (hint.hb) pb = nearestCoast(spec.b, ...proj.forward(unwrapLon(hint.hb[0]), hint.hb[1]));
      const yEdge = (pa[1] + pb[1]) / 2;
      const seg = (from: P, to: P): P[] => {
        const n = 8;
        const out: P[] = [];
        for (let k = 0; k <= n; k++) {
          const t = k / n;
          // ease the y so the lane leaves the coast and meets the edge smoothly
          const e = t * t * (3 - 2 * t);
          out.push([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * e]);
        }
        return out;
      };
      seaLanes.push({
        a: spec.a as SeaLaneGeom['a'],
        b: spec.b as SeaLaneGeom['b'],
        segments: [seg(pa, [0, yEdge]).map(r3), seg([WIDTH, yEdge], pb).map(r3)],
        wrap: true,
      });
      continue;
    }
    let pa: P, pb: P;
    if (hint.ha || hint.hb) {
      const [p0, q0] = closestPair(spec.a, spec.b);
      pa = hint.ha ? nearestCoast(spec.a, ...proj.forward(unwrapLon(hint.ha[0]), hint.ha[1])) : p0;
      pb = hint.hb ? nearestCoast(spec.b, ...proj.forward(unwrapLon(hint.hb[0]), hint.hb[1])) : q0;
    } else {
      [pa, pb] = closestPair(spec.a, spec.b);
    }
    const L = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
    const bulge = Math.min(1.1, Math.max(0.08, L * 0.12));
    let bestPts = arcPts(pa, pb, bulge), bestBad = foreignLand(bestPts, spec.a, spec.b);
    for (const bb of [-bulge, bulge * 0.4, -bulge * 0.4, 0]) {
      const pts = arcPts(pa, pb, bb);
      const bad = foreignLand(pts, spec.a, spec.b);
      if (bad < bestBad - 1e-6) (bestBad = bad), (bestPts = pts);
    }
    if (bestBad > 0.05) log(`  lane ${spec.a}–${spec.b} crosses ${bestBad.toFixed(2)} units of other land`);
    seaLanes.push({ a: spec.a as SeaLaneGeom['a'], b: spec.b as SeaLaneGeom['b'], segments: [bestPts.map(r3)], wrap: false });
  }
  log(`sea lanes: ${seaLanes.length}`);

  // -------------------------------------------------------------------------------------------
  // 7. Continent + ocean labels (placed on clear water, avoiding lanes and each other)
  const obstacle = new Uint8Array(g.w * g.h);
  for (let p = 0; p < obstacle.length; p++) obstacle[p] = g.lab[p] !== OCEAN ? 1 : 0;
  const stamp = (x: number, y: number, rad: number) => {
    const R = Math.ceil(rad * PX);
    const ci = Math.floor(x * PX), cr = Math.floor(y * PX);
    for (let dr = -R; dr <= R; dr++)
      for (let di = -R; di <= R; di++) {
        if (di * di + dr * dr > R * R) continue;
        const i = ci + di, r = cr + dr;
        if (i >= 0 && r >= 0 && i < g.w && r < g.h) obstacle[r * g.w + i] = 1;
      }
  };
  for (const lane of seaLanes) for (const seg of lane.segments) for (let k = 1; k < seg.length; k++) {
    const [x0, y0] = seg[k - 1], [x1, y1] = seg[k];
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.1);
    for (let s = 0; s <= n; s++) stamp(x0 + ((x1 - x0) * s) / n, y0 + ((y1 - y0) * s) / n, 0.25);
  }
  function placeBox(hint: [number, number], w: number, h: number, margin: number): { at: Vec2; room: number } {
    const [hx, hy] = proj.forward(unwrapLon(hint[0]), hint[1]);
    const sat = new SAT(g.w, g.h, (p) => obstacle[p] === 1);
    const clear = (cx: number, cy: number, ww: number) => {
      const i0 = Math.floor((cx - ww / 2 - margin) * PX), i1 = Math.ceil((cx + ww / 2 + margin) * PX);
      const r0 = Math.floor((cy - h / 2 - margin) * PX), r1 = Math.ceil((cy + h / 2 + margin) * PX);
      return sat.count(i0, r0, i1, r1, 1) === 0;
    };
    let best: [number, number] | null = null, bd = Infinity;
    for (let ww = w; ww >= w * 0.55 && !best; ww *= 0.9) {
      for (let dx = -16; dx <= 16; dx += 0.25)
        for (let dy = -10; dy <= 10; dy += 0.25) {
          const d = Math.hypot(dx, dy * 1.3);
          if (d >= bd) continue;
          const cx = hx + dx, cy = hy + dy;
          if (clear(cx, cy, ww)) (bd = d), (best = [cx, cy]);
        }
    }
    if (!best) best = [hx, hy];
    let room = 0;
    for (let ww = 0.5; ww <= 30; ww += 0.25) {
      if (!clear(best[0], best[1], ww)) break;
      room = ww;
    }
    return { at: r3(best), room: round3(room) };
  }
  const markBox = (at: Vec2, w: number, h: number) => {
    for (let x = at[0] - w / 2; x <= at[0] + w / 2; x += 0.2)
      for (let y = at[1] - h / 2; y <= at[1] + h / 2; y += 0.2) stamp(x, y, 0.35);
  };

  // Territory names that hang over the water also block labels.
  for (const t of TERRITORY_IDS) {
    const [lx, ly] = territories[t].labelAnchor;
    const bw = 0.36 * NAME[t].length + 0.3;
    for (let x = lx - bw / 2; x <= lx + bw / 2; x += 0.2) stamp(x, ly, 0.4);
  }
  const continents = {} as Record<string, { id: string; labelAnchor: Vec2; labelRoom: number }>;
  for (const c of pack.rules.continents) {
    const text = `${c.name.toUpperCase()} · +${c.bonus}`;
    const w = text.length * 0.62, h = 1.3;
    const hint = recipe.continentLabelHints[c.id];
    if (!hint) throw new Error(`recipe has no continentLabelHints entry for ${c.id}`);
    const { at, room } = placeBox(hint, w, h, 0.35);
    continents[c.id] = { id: c.id, labelAnchor: at, labelRoom: room };
    markBox(at, Math.min(room, w), h);
  }
  const oceanLabels: BoardGeometry['oceanLabels'] = [];
  for (const o of recipe.oceanLabels) {
    const w = o.text.length * o.size * 0.62, h = o.size * 1.2;
    const { at } = placeBox(o.hint, w, h, 0.3);
    oceanLabels.push({ text: o.text, at, size: o.size });
    markBox(at, w, h);
  }

  // -------------------------------------------------------------------------------------------
  // 8. Assemble (key order is part of the byte-for-byte contract for classic)
  const decorativeLand = (polys.get(DECOR) ?? []).map(toGeom);
  const board = {
    version: 1,
    width: WIDTH,
    height: HEIGHT,
    projection: describeRecipe(recipe),
    territories,
    seaLanes,
    continents,
    decorativeLand,
    oceanLabels,
  };
  return board as unknown as BoardGeometry;
}
