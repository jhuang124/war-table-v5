// Checks a map pack (maps/<id>/: pack.json, rules.json, topology.json, board.json) and renders previews.
//   npm run verify:map                          (classic: checks + previews)
//   npm run verify:map -- --map true-world
//   npm run verify:map -- --map <id> --no-preview
//   npm run verify:map -- --map <id> --thumb    (also rewrite maps/<id>/thumb.png)
//   npm run verify:map -- --map <id> --no-sim   (skip the balance pass: `npm run sim 30 -- --map <id>`)
// Besides the pass/fail checks it prints balance notes (each continent's bonus against its size and the
// borders it must hold, with a suggested value) and, unless --no-sim, runs 30 AI games on the map.
// Exits non-zero on any failure. docs/MAPS.md lists what each check means and what it can't see.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BoardGeometry, PolygonGeom } from '../src/map/types';
import {
  ringArea, pointInPoly, distToPolyBoundary, segmentsCross, segDist2, SegGrid, polylineLength, type P,
} from './map/geom';
import { renderPreviews, renderThumb } from './map/preview';
import { ROOT, lintPack, loadPack, mapArg, pairKey as key } from './map/pack';
import { projectionOf, type MapRecipe } from './map/recipe';
import { balanceNotes, runSim } from './map/balance';

/**
 * sha256 of the classic board.json as it shipped before map packs (src/map/board.json at d3717cc).
 * The classic pack must stay byte-identical to it; if you change classic on purpose, update this and
 * say so in the change.
 */
const CLASSIC_SHA256 = 'a4b77df40c6fc20d8c4df608ac63dbc05c991db8b2703551d415539b63d5d8e6';

const TOUCH_MIN_LEN = 0.1; // shared boundary shorter than this = point touch, not a border
const MIN_GAP = 0.25; // non-touching territories must be at least this far apart
const MAX_LANE_LEN = 14;
const MAX_FOREIGN = 0.3; // lane length allowed over land of unrelated territories
const MIN_WATER = 0.6; // share of each lane's length that must be over open water (visible water)

// --all (npm run verify:maps): every folder under maps/ with a pack.json, one child run each.
if (process.argv.includes('--all')) {
  const { readdirSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const rest = process.argv.slice(2).filter((a) => a !== '--all');
  const ids = readdirSync(resolve(ROOT, 'maps')).filter((d) => existsSync(resolve(ROOT, 'maps', d, 'pack.json'))).sort();
  const bad: string[] = [];
  for (const m of ids) {
    const r = spawnSync(process.execPath, [...process.execArgv, process.argv[1], '--map', m, ...rest], { stdio: 'inherit' });
    if (r.status !== 0) bad.push(m);
  }
  console.log(`\nverify:maps: ${ids.length - bad.length}/${ids.length} packs pass${bad.length ? `; failing: ${bad.join(', ')}` : ''}`);
  process.exit(bad.length ? 1 : 0);
}

const id = mapArg();
const pack = loadPack(id);
const MIN_CLEARANCE = pack.manifest.presentation.anchorClearance;
const TERRITORY_IDS = pack.territoryIds as (keyof BoardGeometry['territories'])[];
type TerritoryId = (typeof TERRITORY_IDS)[number];
const NAMES = pack.names;
const BORDERS = pack.topology.borders;

const failures: string[] = [];
const notes: string[] = [];
const fail = (m: string) => failures.push(m);
for (const p of lintPack(pack)) fail(p);
if (/\bTODO\b/.test(pack.manifest.description)) notes.push('NOTE: pack.json description is still the scaffold TODO (docs/MAP-AUTHORING.md step h)');
if (pack.manifest.hidden) notes.push(`NOTE: ${id} is hidden (not in the picker; ?map=${id} loads it). Remove "hidden" when the author checklist is done.`);

const boardPath = resolve(pack.dir, 'board.json');
if (!existsSync(boardPath)) {
  console.log(`maps/${id}/board.json is missing: run npm run build:map -- --map ${id}`);
  process.exit(1);
}
const bytes = readFileSync(boardPath);
const sha = createHash('sha256').update(bytes).digest('hex');
const board = JSON.parse(bytes.toString('utf8')) as BoardGeometry;
if (id === 'classic' && sha !== CLASSIC_SHA256) fail(`classic board.json changed: sha256 ${sha} ≠ the pre-pack board ${CLASSIC_SHA256}`);

// ------------------------------------------------------------------ engine compatibility
// A pack with its own rules is played through the v6 per-game map definition (src/engine/mapData.ts
// mapDefOf); it needs the engine, renderer and HUD to read that instead of the classic constants.
if (pack.rulesFrom !== 'classic') {
  const c = loadPack('classic');
  const same = JSON.stringify(c.rules) === JSON.stringify(pack.rules) && JSON.stringify(c.topology) === JSON.stringify(pack.topology);
  if (!same) notes.push(`NOTE: ${id} has its own rules/topology; it plays only where the engine reads mapDefOf(config) (docs/MAPS.md, "A new board")`);
}

// ------------------------------------------------------------------ presence
const ids = Object.keys(board.territories);
for (const t of TERRITORY_IDS) if (!board.territories[t]) fail(`missing territory ${t}`);
for (const t of ids) if (!TERRITORY_IDS.includes(t as TerritoryId)) fail(`unknown territory ${t}`);
if (ids.length !== TERRITORY_IDS.length) fail(`expected ${TERRITORY_IDS.length} territories, got ${ids.length}`);
for (const t of ids) if (board.territories[t as TerritoryId].id !== t) fail(`territory ${t} has id ${board.territories[t as TerritoryId].id}`);

// ------------------------------------------------------------------ polygon validity
type Owner = { t: string; poly: number; ring: number };
const owners: Owner[] = [];
const grid = new SegGrid(1.5);
function addRings(t: string, polys: PolygonGeom[]) {
  polys.forEach((pg, pi) => {
    const rings = [pg.outer, ...pg.holes];
    rings.forEach((r, ri) => {
      const label = `${t}#${pi}${ri ? `h${ri}` : ''}`;
      if (r.length < 3) fail(`${label}: ring has ${r.length} points`);
      for (const [x, y] of r) if (!Number.isFinite(x) || !Number.isFinite(y)) fail(`${label}: non-finite coordinate`);
      for (let k = 0; k < r.length; k++) {
        const a = r[k], b = r[(k + 1) % r.length];
        if (a[0] === b[0] && a[1] === b[1]) {
          fail(`${label}: repeated point at ${a}`);
          break;
        }
      }
      const area = ringArea(r as P[]);
      if (ri === 0 && !(area > 0)) fail(`${label}: outer ring is not counter-clockwise (area ${area.toFixed(3)})`);
      if (ri > 0 && !(area < 0)) fail(`${label}: hole is not clockwise (area ${area.toFixed(3)})`);
      const oi = owners.push({ t, poly: pi, ring: ri }) - 1;
      for (let k = 0; k < r.length; k++) grid.add({ a: r[k] as P, b: r[(k + 1) % r.length] as P, ring: oi, idx: k });
    });
  });
}
for (const t of TERRITORY_IDS) if (board.territories[t]) addRings(t, board.territories[t].polygons);
addRings('decor', board.decorativeLand);

let crossings = 0;
const ringLen = (oi: number) => {
  const o = owners[oi];
  const pg = o.t === 'decor' ? board.decorativeLand[o.poly] : board.territories[o.t as TerritoryId].polygons[o.poly];
  return (o.ring === 0 ? pg.outer : pg.holes[o.ring - 1]).length;
};
grid.pairs((s, u) => {
  if (s.ring === u.ring) {
    const n = ringLen(s.ring);
    const d = Math.abs(s.idx - u.idx);
    if (d <= 1 || d === n - 1) return;
  }
  if (segmentsCross(s.a, s.b, u.a, u.b)) {
    crossings++;
    if (crossings <= 10) {
      const A = owners[s.ring], B = owners[u.ring];
      fail(`segments cross: ${A.t}#${A.poly}/${A.ring} × ${B.t}#${B.poly}/${B.ring} near ${s.a.map((v) => v.toFixed(2))}`);
    }
  }
});
if (crossings > 10) fail(`... ${crossings} crossings in total`);

// Interior overlap: a representative interior point of each polygon must not lie inside another territory.
function interiorPoint(pg: PolygonGeom): P {
  // midpoint of the widest horizontal span through the bbox middle
  const ys = pg.outer.map((p) => p[1]);
  const y = (Math.min(...ys) + Math.max(...ys)) / 2 + 1e-4;
  const xs: number[] = [];
  for (const r of [pg.outer, ...pg.holes])
    for (let k = 0; k < r.length; k++) {
      const a = r[k], b = r[(k + 1) % r.length];
      if (a[1] > y !== b[1] > y) xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
  xs.sort((p, q) => p - q);
  let best: P = pg.outer[0] as P, bw = -1;
  for (let k = 0; k + 1 < xs.length; k += 2) if (xs[k + 1] - xs[k] > bw) (bw = xs[k + 1] - xs[k]), (best = [(xs[k] + xs[k + 1]) / 2, y]);
  return best;
}
for (const t of TERRITORY_IDS) {
  for (const pg of board.territories[t]?.polygons ?? []) {
    const [x, y] = interiorPoint(pg);
    for (const u of TERRITORY_IDS) {
      if (u === t) continue;
      if (board.territories[u].polygons.some((q) => pointInPoly(x, y, q))) fail(`${t} overlaps ${u} at ${x.toFixed(2)},${y.toFixed(2)}`);
    }
  }
}

// ------------------------------------------------------------------ touching pairs
const edgeOwners = new Map<string, Set<string>>();
const edgeLen = new Map<string, number>();
const ek = (a: P, b: P) => {
  const s = `${a[0]},${a[1]}`, u = `${b[0]},${b[1]}`;
  return s < u ? `${s}|${u}` : `${u}|${s}`;
};
function eachEdge(polys: PolygonGeom[], fn: (a: P, b: P) => void) {
  for (const pg of polys) for (const r of [pg.outer, ...pg.holes]) for (let k = 0; k < r.length; k++) fn(r[k] as P, r[(k + 1) % r.length] as P);
}
for (const t of [...TERRITORY_IDS, 'decor'] as string[]) {
  const polys = t === 'decor' ? board.decorativeLand : board.territories[t as TerritoryId]?.polygons ?? [];
  eachEdge(polys, (a, b) => {
    const k = ek(a, b);
    const set = edgeOwners.get(k) ?? new Set<string>();
    set.add(t);
    edgeOwners.set(k, set);
    edgeLen.set(k, Math.hypot(b[0] - a[0], b[1] - a[1]));
  });
}
const shared = new Map<string, number>();
for (const [k, set] of edgeOwners) {
  if (set.size < 2) continue;
  const arr = [...set];
  for (let i = 0; i < arr.length; i++)
    for (let j = i + 1; j < arr.length; j++) {
      const pk = key(arr[i], arr[j]);
      shared.set(pk, (shared.get(pk) ?? 0) + edgeLen.get(k)!);
    }
}
const landPairs = new Set([...shared.entries()].filter(([, l]) => l >= TOUCH_MIN_LEN).map(([k]) => k));
for (const [k, l] of shared) if (l < TOUCH_MIN_LEN) fail(`point-like touch ${k} (shared ${l.toFixed(3)})`);
for (const k of landPairs) if (k.split('|').includes('decor')) fail(`decorative land touches a territory: ${k}`);

// near contacts between non-touching land
{
  const ownerT = (oi: number) => owners[oi].t;
  const g2 = new SegGrid(1.0);
  owners.forEach((o, oi) => {
    const pg = o.t === 'decor' ? board.decorativeLand[o.poly] : board.territories[o.t as TerritoryId].polygons[o.poly];
    const r = o.ring === 0 ? pg.outer : pg.holes[o.ring - 1];
    for (let k = 0; k < r.length; k++) g2.add({ a: r[k] as P, b: r[(k + 1) % r.length] as P, ring: oi, idx: k });
  });
  const minGap = new Map<string, number>();
  g2.pairs((s, u) => {
    const A = ownerT(s.ring), B = ownerT(u.ring);
    if (A === B) return;
    const pk = key(A, B);
    if (landPairs.has(pk)) return;
    const d = Math.sqrt(
      Math.min(
        segDist2(s.a[0], s.a[1], u.a[0], u.a[1], u.b[0], u.b[1]),
        segDist2(s.b[0], s.b[1], u.a[0], u.a[1], u.b[0], u.b[1]),
        segDist2(u.a[0], u.a[1], s.a[0], s.a[1], s.b[0], s.b[1]),
        segDist2(u.b[0], u.b[1], s.a[0], s.a[1], s.b[0], s.b[1]),
      ),
    );
    if (d < (minGap.get(pk) ?? Infinity)) minGap.set(pk, d);
  });
  for (const [pk, d] of minGap) if (d < MIN_GAP) fail(`near contact ${pk}: ${d.toFixed(3)} apart (need ≥ ${MIN_GAP} or a real shared border)`);
}

// ------------------------------------------------------------------ borders == land ∪ lanes, lanes == topology
const borderSet = new Set(BORDERS.map(([a, b]) => key(a, b)));
const topoLanes = new Map(pack.topology.seaLanes.map((l) => [key(l.a, l.b), l]));
const laneSet = new Set<string>();
for (const lane of board.seaLanes) {
  const k = key(lane.a, lane.b);
  if (laneSet.has(k)) fail(`duplicate sea lane ${k}`);
  laneSet.add(k);
  if (landPairs.has(k)) fail(`sea lane ${k} duplicates a land border`);
  const spec = topoLanes.get(k);
  if (!spec) fail(`board has sea lane ${k} that topology.json doesn't list`);
  else {
    if (spec.a !== lane.a) fail(`sea lane ${k}: board runs ${lane.a}→${lane.b}, topology.json lists ${spec.a}→${spec.b}`);
    if (!!spec.wrap !== lane.wrap) fail(`sea lane ${k}: wrap is ${lane.wrap} on the board, ${!!spec.wrap} in topology.json`);
  }
}
for (const k of topoLanes.keys()) if (!laneSet.has(k)) fail(`topology.json lane ${k} is missing from the board`);
const terrLand = new Set([...landPairs].filter((k) => !k.split('|').includes('decor')));
for (const k of terrLand) if (!borderSet.has(k)) fail(`extra land contact ${k} (not a border in topology.json)`);
for (const k of laneSet) if (!borderSet.has(k)) fail(`sea lane ${k} is not a border`);
for (const k of borderSet) if (!terrLand.has(k) && !laneSet.has(k)) fail(`missing border ${k} (no land contact, no lane)`);

// ------------------------------------------------------------------ anchors
const OVERHANG = pack.manifest.presentation.anchorOverhang ?? null;
const overhangs: string[] = [];
/** Distance from (x, y) to the nearest land that isn't t's (other territories + decorative land). */
function foreignLandDist(t: string, x: number, y: number): number {
  let d = Infinity;
  const polys = [
    ...TERRITORY_IDS.filter((u) => u !== t).flatMap((u) => board.territories[u].polygons),
    ...board.decorativeLand,
  ];
  for (const pg of polys) {
    if (pointInPoly(x, y, pg)) return 0;
    d = Math.min(d, distToPolyBoundary(x, y, pg));
  }
  return d;
}
const clearance = new Map<string, number>();
for (const t of TERRITORY_IDS) {
  const tg = board.territories[t];
  if (!tg) continue;
  const main = tg.polygons[0];
  const areas = tg.polygons.map((pg) => ringArea(pg.outer as P[]));
  if (areas.some((a) => a > areas[0] + 1e-9)) fail(`${t}: polygons[0] is not the largest polygon`);
  const [x, y] = tg.anchor;
  if (!pointInPoly(x, y, main)) fail(`${t}: anchor is outside its main polygon`);
  const c = distToPolyBoundary(x, y, main);
  clearance.set(t, c);
  if (!OVERHANG) {
    if (c < MIN_CLEARANCE) fail(`${t}: anchor clearance ${c.toFixed(2)} < ${MIN_CLEARANCE}`);
  } else if (c < MIN_CLEARANCE) {
    // The disc may overhang open water, never another territory's land.
    if (c < OVERHANG.ownLand - 1e-6) fail(`${t}: anchor has ${c.toFixed(2)} of own land around it < ${OVERHANG.ownLand}`);
    const f = foreignLandDist(t, x, y);
    if (f < MIN_CLEARANCE) fail(`${t}: army disc (r ${MIN_CLEARANCE}) reaches other land ${f.toFixed(2)} away`);
    overhangs.push(`${t} (own ${c.toFixed(2)}, other land ${f.toFixed(2)})`);
  }
  const [lx, ly] = tg.labelAnchor;
  if (!(lx >= 0 && lx <= board.width && ly >= 0 && ly <= board.height)) fail(`${t}: labelAnchor off the board`);
  const bb = tg.bbox;
  for (const pg of tg.polygons) for (const [px, py] of pg.outer) if (px < bb[0] - 1e-6 || px > bb[2] + 1e-6 || py < bb[1] - 1e-6 || py > bb[3] + 1e-6) {
    fail(`${t}: bbox does not contain its polygons`);
    break;
  }
}

// Two army discs never overlap, and neighbours' stacks (v3: ~1.3-unit discs) keep a gap between them.
const MIN_NEIGHBOUR_ANCHOR = 1.6;
let closestNeighbours: [string, number] = ['', Infinity];
for (let i = 0; i < TERRITORY_IDS.length; i++)
  for (let j = i + 1; j < TERRITORY_IDS.length; j++) {
    const a = board.territories[TERRITORY_IDS[i]]?.anchor, b = board.territories[TERRITORY_IDS[j]]?.anchor;
    if (!a || !b) continue;
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (d < 2 * MIN_CLEARANCE - 1e-6) fail(`army discs of ${TERRITORY_IDS[i]} and ${TERRITORY_IDS[j]} overlap`);
    if (borderSet.has(key(TERRITORY_IDS[i], TERRITORY_IDS[j]))) {
      if (d < MIN_NEIGHBOUR_ANCHOR) fail(`neighbours ${TERRITORY_IDS[i]} and ${TERRITORY_IDS[j]}: anchors ${d.toFixed(2)} apart < ${MIN_NEIGHBOUR_ANCHOR}`);
      if (d < closestNeighbours[1]) closestNeighbours = [key(TERRITORY_IDS[i], TERRITORY_IDS[j]), d];
    }
  }

// ------------------------------------------------------------------ lanes
const allLand = (x: number, y: number, except: string[]): string | null => {
  for (const t of TERRITORY_IDS) {
    if (except.includes(t)) continue;
    const tg = board.territories[t];
    if (tg.bbox[0] > x || tg.bbox[2] < x || tg.bbox[1] > y || tg.bbox[3] < y) continue;
    if (tg.polygons.some((pg) => pointInPoly(x, y, pg))) return t;
  }
  for (const pg of board.decorativeLand) if (pointInPoly(x, y, pg)) return 'decor';
  return null;
};
const coastDist = (t: TerritoryId, p: P) => Math.min(...board.territories[t].polygons.map((pg) => distToPolyBoundary(p[0], p[1], pg)));
const laneRows: string[] = [];
for (const lane of board.seaLanes) {
  const k = key(lane.a, lane.b);
  const len = lane.segments.reduce((s, seg) => s + polylineLength(seg as P[]), 0);
  if (len > MAX_LANE_LEN) fail(`lane ${k} is long (${len.toFixed(1)})`);
  if (lane.wrap) {
    if (lane.segments.length !== 2) fail(`wrap lane ${k} needs 2 segments`);
    const xs = lane.segments.flat().map((p) => p[0]);
    if (!(Math.min(...xs) <= 0.001 && Math.max(...xs) >= board.width - 0.001)) fail(`wrap lane ${k} must run off both edges`);
  } else if (lane.segments.length !== 1) fail(`lane ${k} should be one segment`);
  const first = lane.segments[0][0] as P, lastSeg = lane.segments[lane.segments.length - 1];
  const last = lastSeg[lastSeg.length - 1] as P;
  // Shore points: the start sits on a's coast and the end on b's (the crossing's shore ticks go there).
  if (!(coastDist(lane.a, first) < 0.3 && coastDist(lane.b, last) < 0.3)) fail(`lane ${k}: shore points are not on the coasts of ${lane.a} (start) and ${lane.b} (end)`);
  if (lane.shore) {
    const [sa, sb] = lane.shore;
    if (Math.hypot(sa[0] - first[0], sa[1] - first[1]) > 1e-6 || Math.hypot(sb[0] - last[0], sb[1] - last[1]) > 1e-6) fail(`lane ${k}: shore points differ from the lane's ends`);
  }
  let foreign = 0, water = 0;
  const hits = new Set<string>();
  for (const seg of lane.segments)
    for (let i = 1; i < seg.length; i++) {
      const [x0, y0] = seg[i - 1], [x1, y1] = seg[i];
      const L = Math.hypot(x1 - x0, y1 - y0);
      const n = Math.max(1, Math.ceil(L / 0.05));
      for (let s = 0; s < n; s++) {
        const x = x0 + ((x1 - x0) * (s + 0.5)) / n, y = y0 + ((y1 - y0) * (s + 0.5)) / n;
        const hit = allLand(x, y, [lane.a, lane.b]);
        if (hit) (foreign += L / n), hits.add(hit);
        else if (!allLand(x, y, [])) water += L / n;
      }
    }
  if (foreign > MAX_FOREIGN) fail(`lane ${k} crosses ${foreign.toFixed(2)} units of other land (${[...hits].join(', ')})`);
  if (water / len < MIN_WATER) fail(`lane ${k}: only ${Math.round((100 * water) / len)}% of it is over open water (visible water = adjacency)`);
  laneRows.push(`  ${k.padEnd(38)} ${len.toFixed(2).padStart(6)}  water ${String(Math.round((100 * water) / len)).padStart(3)}%${lane.wrap ? '  (wraps)' : ''}${foreign > 0 ? `  over land ${foreign.toFixed(2)}` : ''}`);
}

// continents / ocean labels sit on water
for (const [c, cg] of Object.entries(board.continents)) {
  const [x, y] = cg.labelAnchor;
  const hit = allLand(x, y, []);
  if (hit) fail(`continent label ${c} sits on land (${hit})`);
}
const contIds = pack.rules.continents.map((c) => c.id);
if (Object.keys(board.continents).length !== contIds.length || contIds.some((c) => !(c in board.continents)))
  fail(`board continents (${Object.keys(board.continents).join(', ')}) ≠ rules.json (${contIds.join(', ')})`);
for (const o of board.oceanLabels) if (allLand(o.at[0], o.at[1], [])) fail(`ocean label ${o.text} sits on land`);

// ------------------------------------------------------------------ report
const nbrs = new Map<string, { land: string[]; sea: string[] }>();
for (const t of TERRITORY_IDS) nbrs.set(t, { land: [], sea: [] });
for (const k of terrLand) {
  const [a, b] = k.split('|');
  nbrs.get(a)!.land.push(b);
  nbrs.get(b)!.land.push(a);
}
for (const k of laneSet) {
  const [a, b] = k.split('|');
  nbrs.get(a)?.sea.push(b);
  nbrs.get(b)?.sea.push(a);
}
console.log(`\nmap ${id} (${pack.manifest.name})  ·  board.json sha256 ${sha.slice(0, 16)}…`);
console.log(`board ${board.width} × ${board.height}  ·  ${board.seaLanes.length} lanes  ·  ${board.decorativeLand.length} decorative polygons`);
console.log('territory              polys  verts   area  clear  land sea');
let totalV = 0;
for (const t of TERRITORY_IDS) {
  const tg = board.territories[t];
  if (!tg) continue;
  const v = tg.polygons.reduce((s, pg) => s + pg.outer.length + pg.holes.reduce((q, h) => q + h.length, 0), 0);
  totalV += v;
  const c = clearance.get(t) ?? 0;
  const n = nbrs.get(t)!;
  console.log(
    `${t.padEnd(22)} ${String(tg.polygons.length).padStart(5)} ${String(v).padStart(6)} ${tg.area.toFixed(1).padStart(6)} ${c.toFixed(2).padStart(6)}${c < MIN_CLEARANCE ? (OVERHANG ? '~' : '!') : ' '} ${String(n.land.length).padStart(4)} ${String(n.sea.length).padStart(3)}  ${NAMES[t]}`,
  );
}
console.log(`total territory vertices: ${totalV}`);
console.log(`closest neighbouring anchors: ${closestNeighbours[0]} ${closestNeighbours[1].toFixed(2)} apart (need ≥ ${MIN_NEIGHBOUR_ANCHOR})`);
{
  // Europe-style crowding report: each territory's room for a disc, measured to other territories' land.
  const rows = TERRITORY_IDS.filter((t) => pack.continentOf[t] === 'europe').map((t) => {
    const [x, y] = board.territories[t].anchor;
    return `${t} ${foreignLandDist(t, x, y).toFixed(2)}`;
  });
  if (rows.length) console.log(`europe, anchor → nearest other land: ${rows.join(', ')}`);
}
if (overhangs.length) console.log(`armies overhanging water (${overhangs.length}): ${overhangs.join(', ')}`);
console.log(`land borders: ${terrLand.size}, sea lanes: ${laneSet.size}, borders: ${borderSet.size}`);
console.log('sea lanes (length in board units):');
for (const r of laneRows) console.log(r);

// ------------------------------------------------------------------ balance (notes, then the sim)
{
  const b = balanceNotes(pack, board);
  console.log('\nbalance (notes, not failures):');
  for (const r of b.rows) console.log(r);
  notes.push(...b.notes);
}
if (!process.argv.includes('--no-sim')) {
  const r = await runSim(id, 30);
  if (r.ok) console.log(`sim: 30 AI games on ${id} finished · ${r.rounds}`);
  else fail(`sim: npm run sim 30 -- --map ${id} did not finish cleanly:\n${r.tail}`);
  if (r.note) notes.push(r.note);
}

if (!process.argv.includes('--no-preview')) {
  const recipePath = resolve(ROOT, 'scripts/map/packs', id, 'index.ts');
  const recipe = existsSync(recipePath) ? ((await import(pathToFileURL(recipePath).href)) as { recipe: MapRecipe }).recipe : null;
  const thumb = pack.manifest.thumbnail ? resolve(pack.dir, pack.manifest.thumbnail) : null;
  const files = await renderPreviews(board, pack, {
    outDir: resolve(ROOT, 'artifacts/map', id),
    minClear: MIN_CLEARANCE,
    shots: recipe?.previews ?? [],
    project: recipe ? (lon, lat) => projectionOf(recipe).forward(projectionOf(recipe).unwrapLon(lon), lat) : undefined,
    thumbPath: thumb && (process.argv.includes('--thumb') || !existsSync(thumb)) ? thumb : undefined,
  });
  console.log(`previews: ${files.map((f) => f.replace(ROOT + '/', '')).join(', ')}`);
} else if (process.argv.includes('--thumb') && pack.manifest.thumbnail) {
  await renderThumb(board, pack, resolve(pack.dir, pack.manifest.thumbnail));
  console.log(`thumbnail: maps/${id}/${pack.manifest.thumbnail}`);
}

for (const n of notes) console.log(`\n${n}`);
if (failures.length) {
  console.log(`\nFAIL (${failures.length})`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
} else {
  console.log(`\nPASS ${id}: files well-formed, geometry valid, adjacency == topology.json, anchors clear, lanes over visible water`);
}
