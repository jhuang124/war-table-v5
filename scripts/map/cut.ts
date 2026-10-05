// Recipe v2: carve one country (or one GeoJSON feature) into several territories with hand-drawn cut
// lines, instead of writing lon/lat inequalities (docs/MAP-AUTHORING.md, "Splitting a country").
//
//   assign: {
//     Algeria: cutBy(
//       [[[3.2, 37.5], [3.0, 30], [1.0, 18]]],          // one or more polylines, lon/lat, drawn past the coast
//       { oran: [-0.6, 35.2], constantine: [6.6, 36.3] } // one seed point inside each piece
//     ),
//   }
//
// How it decides: the lines are drawn as walls on a fine lon/lat grid covering the lines and seeds (plus a
// margin); each seed floods the cells it can reach without crossing a wall; a pixel belongs to the seed that
// reached its cell. Cells no seed reached (the walls themselves, or a pocket with no seed) go to the nearest
// reached cell. Two seeds that reach each other mean a line doesn't close: that throws, naming them.
// A line's loose ends are extended straight on (in the direction of their last segment) to the grid's edge,
// so a line only has to cross the country; an end that stops on another line (a T junction) is left as is.
// Land outside the grid takes the nearest grid cell's answer.

import type { Resolved, Rule } from './recipe';

export type LonLat = [number, number];

export interface CutOptions {
  /** Extra grid around the lines and seeds, in degrees (default: 5 % of the larger span, at least 0.01°). */
  pad?: number;
  /** Grid cells along the longer side (default 1200). */
  cells?: number;
}

/** A pixel rule: which territory (or 'decor' / 'drop') each part of the country becomes. */
export function cutBy(lines: LonLat[][], labels: Record<Resolved, LonLat>, opts: CutOptions = {}): Rule {
  const seeds = Object.entries(labels);
  if (seeds.length < 2) throw new Error('cutBy: needs at least two labels (one seed point per piece)');
  if (!lines.length || lines.some((l) => l.length < 2)) throw new Error('cutBy: every line needs at least two points');
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [lo, la] of [...lines.flat(), ...seeds.map(([, p]) => p)]) (w = Math.min(w, lo)), (e = Math.max(e, lo)), (s = Math.min(s, la)), (n = Math.max(n, la));
  const pad = opts.pad ?? Math.max(0.01, 0.05 * Math.max(e - w, n - s));
  (w -= pad), (e += pad), (s -= pad), (n += pad);
  const cells = opts.cells ?? 1200;
  const res = Math.max(e - w, n - s) / cells;
  const W = Math.ceil((e - w) / res) + 1, H = Math.ceil((n - s) / res) + 1;
  const ci = (lon: number) => Math.min(W - 1, Math.max(0, Math.floor((lon - w) / res)));
  const cj = (lat: number) => Math.min(H - 1, Math.max(0, Math.floor((lat - s) / res)));

  // Walls: every cell a line passes through (sampled at a third of a cell, so the wall is 8-connected and a
  // 4-connected flood can't slip through it diagonally).
  const WALL = -2, NONE = -1;
  const lab = new Int16Array(W * H).fill(NONE);
  const owner = new Int16Array(W * H).fill(-1); // which line drew each wall cell
  const draw = (x0: number, y0: number, x1: number, y1: number, li: number) => {
    const steps = Math.max(1, Math.ceil((Math.hypot(x1 - x0, y1 - y0) / res) * 3));
    for (let t = 0; t <= steps; t++) {
      const c = cj(y0 + ((y1 - y0) * t) / steps) * W + ci(x0 + ((x1 - x0) * t) / steps);
      lab[c] = WALL;
      if (owner[c] < 0) owner[c] = li;
    }
  };
  lines.forEach((line, li) => {
    for (let k = 1; k < line.length; k++) draw(...line[k - 1], ...line[k], li);
  });
  // A line's loose end runs on in its last direction to the edge of the grid (so one line across a country
  // splits it, however far past the coast it was drawn); an end that stops on another line (a T) stays put.
  const nearOther = (lon: number, lat: number, li: number) => {
    const i0 = ci(lon), j0 = cj(lat);
    for (let dj = -2; dj <= 2; dj++)
      for (let di = -2; di <= 2; di++) {
        const i = i0 + di, j = j0 + dj;
        if (i < 0 || j < 0 || i >= W || j >= H) continue;
        const o = owner[j * W + i];
        if (o >= 0 && o !== li) return true;
      }
    return false;
  };
  const far = 2 * Math.hypot(e - w, n - s);
  lines.forEach((line, li) => {
    for (const [end, prev] of [[line[0], line[1]], [line[line.length - 1], line[line.length - 2]]] as const) {
      if (nearOther(end[0], end[1], li)) continue;
      const dx = end[0] - prev[0], dy = end[1] - prev[1], L = Math.hypot(dx, dy) || 1;
      const tx = end[0] + (dx / L) * far, ty = end[1] + (dy / L) * far;
      // clip the ray to the grid box, then draw it
      let t1 = 1;
      for (const [d, lo, hi, p] of [[tx - end[0], w, e, end[0]], [ty - end[1], s, n, end[1]]] as const) {
        if (d > 0) t1 = Math.min(t1, (hi - p) / d);
        else if (d < 0) t1 = Math.min(t1, (lo - p) / d);
      }
      t1 = Math.max(0, t1);
      draw(end[0], end[1], end[0] + (tx - end[0]) * t1, end[1] + (ty - end[1]) * t1, li);
    }
  });

  // Flood from each seed (4-connected, walls block).
  const q = new Int32Array(W * H);
  seeds.forEach(([name, [lo, la]], si) => {
    const start = cj(la) * W + ci(lo);
    if (lab[start] === WALL) throw new Error(`cutBy: seed ${name} sits on a cut line; move it into its piece`);
    if (lab[start] >= 0) throw new Error(`cutBy: seeds ${seeds[lab[start]][0]} and ${name} are in the same piece; a line doesn't close between them (run it past the coast on both ends)`);
    let head = 0, tail = 0;
    q[tail++] = start;
    lab[start] = si;
    while (head < tail) {
      const p = q[head++];
      const i = p % W, j = (p - i) / W;
      const nb = [i > 0 ? p - 1 : -1, i < W - 1 ? p + 1 : -1, j > 0 ? p - W : -1, j < H - 1 ? p + W : -1];
      for (const r of nb) {
        if (r < 0 || lab[r] === WALL) continue;
        if (lab[r] === NONE) (lab[r] = si), (q[tail++] = r);
        else if (lab[r] !== si) throw new Error(`cutBy: seeds ${seeds[lab[r]][0]} and ${name} are in the same piece; a line doesn't close between them (run it past the coast on both ends)`);
      }
    }
  });

  // Walls and seedless pockets go to the nearest reached cell (multi-source BFS through everything).
  {
    let head = 0, tail = 0;
    for (let p = 0; p < lab.length; p++) if (lab[p] >= 0) q[tail++] = p;
    while (head < tail) {
      const p = q[head++];
      const i = p % W, j = (p - i) / W;
      const nb = [i > 0 ? p - 1 : -1, i < W - 1 ? p + 1 : -1, j > 0 ? p - W : -1, j < H - 1 ? p + W : -1];
      for (const r of nb) if (r >= 0 && lab[r] < 0) (lab[r] = lab[p]), (q[tail++] = r);
    }
  }
  const names = seeds.map(([k]) => k);
  return { pixel: (lon: number, lat: number) => names[lab[cj(lat) * W + ci(lon)]] };
}
