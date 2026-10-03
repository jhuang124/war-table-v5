// Shared constants and helpers for the renderer.
import * as THREE from 'three';
import type { BoardGeometry, Vec2 } from '../map/types';
import { GOLD as PALETTE_GOLD, PLAYER_COLORS, UNCLAIMED_COLOR, washOf } from '../shared/palette';
import type { GameState, PlayerId } from '../engine/types';

/** Ink overhaul (docs/INK.md B §3): the world is flat — a painted sheet, no bevel. */
export const TILE_DEPTH = 0.06;
export const BEVEL_T = 0;
export const BEVEL_S = 0;
/** Height of the un-lifted tile top (picking plane). */
export const TILE_TOP = TILE_DEPTH + BEVEL_T;
/**
 * Lift unit (board units) for hover / select / press: the old bevelled tile depth. On the flat board a lift
 * reads through the contact shadow it casts, not through the tile's own side.
 */
export const LIFT_UNIT = 0.42;
export const IVORY = '#f0ebe0';
export const INK_DARK = '#12151a';
/** Paper and ink (docs/INK.md B §3 "Palette"): indigo washi, silver-ivory ink, one gold. */
export const PAPER = '#101a30';
export const PAPER_DEEP = '#0b1224';
export const PAPER_FIBRE = '#1b2a48';
export const INK_COAST = '#e2ddcf';
export const INK_BORDER = '#c9c3b4';
/** The one gold (v4: candle, src/shared/palette.ts GOLD). */
export const GOLD = PALETTE_GOLD;
/**
 * v4 edge ladder (PLAN E2), the Light weight: a territory border is drawn in the paper's deep tone, a crack of
 * indigo between two washes (the v3 ivory hairline was a second ink colour on land).
 */
export const INK_TERR = '#0d1528';
/** v4 cozy (PLAN §5): the lamp-lit umber the paper warms toward at the frame's margins. */
export const LAMP_UMBER = '#3a2a1c';

let BW = 100;
let BH = 49.5;
export function setBoardSize(g: BoardGeometry): void {
  BW = g.width;
  BH = g.height;
}
export const boardW = () => BW;
export const boardH = () => BH;

/** Board coords (origin bottom-left, +y north) → world (x east, y up, z south). */
export function toWorld(bx: number, by: number, y = 0, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(bx - BW / 2, y, BH / 2 - by);
}
export function toBoard(x: number, z: number): Vec2 {
  return [x + BW / 2, BH / 2 - z];
}

// ---------------------------------------------------------------------------
// Color (all math in sRGB 0..1, converted on assignment)
// ---------------------------------------------------------------------------

export type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHsv([r, g, b]: RGB): RGB {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 1e-6) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

export function hsvToRgb([h, s, v]: RGB): RGB {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (((i % 6) + 6) % 6) {
    case 0:
      return [v, t, p];
    case 1:
      return [q, v, p];
    case 2:
      return [p, v, t];
    case 3:
      return [p, q, v];
    case 4:
      return [t, p, v];
    default:
      return [v, p, q];
  }
}

export function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Scale saturation / value in HSV. */
export function adjust(c: RGB, satMul: number, valMul: number, valAdd = 0): RGB {
  const hsv = rgbToHsv(c);
  hsv[1] = Math.min(1, hsv[1] * satMul);
  hsv[2] = Math.min(1, Math.max(0, hsv[2] * valMul + valAdd));
  return hsvToRgb(hsv);
}

export function setColor(c: THREE.Color, rgb: RGB): THREE.Color {
  return c.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
}

export function rgbCss(c: RGB, a = 1): string {
  return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
}

/**
 * Unclaimed land: raw paper, a shade lighter than the sea and faintly warm (the palette's neutral, thinned
 * into the indigo), so the linework carries the painting until someone's ink soaks in.
 */
export function unclaimedRgb(): RGB {
  return mixRgb(hexToRgb('#18233c'), hexToRgb(UNCLAIMED_COLOR), 0.3);
}

/**
 * An owner's PIGMENT: the seat's base, full strength (v4 E4: the stones, the attack stroke, anything that is the
 * seat as an object). Unowned: the unclaimed paper tone.
 */
export function tileRgb(state: GameState | null, owner: PlayerId): RGB {
  if (owner < 0 || !state || !state.players[owner]) return unclaimedRgb();
  const p = PLAYER_COLORS[state.players[owner].color];
  return hexToRgb(p.base);
}

/** An owner's WASH (v4 E4): the seat's tint (its pigment desaturated, never lighter), laid on the territories it holds. */
export function washRgb(state: GameState | null, owner: PlayerId): RGB {
  if (owner < 0 || !state || !state.players[owner]) return unclaimedRgb();
  return hexToRgb(washOf(PLAYER_COLORS[state.players[owner].color]));
}

/** An owner's stone EDGE ink (v4 E4, paper round 2): `PlayerPalette.edge` when set, else the deep tone of the pigment. */
export function edgeRgb(state: GameState | null, owner: PlayerId): RGB | null {
  if (owner < 0 || !state || !state.players[owner]) return null;
  const p = PLAYER_COLORS[state.players[owner].color] as { edge?: string };
  return p.edge ? hexToRgb(p.edge) : null;
}

export function paletteOf(state: GameState | null, owner: PlayerId) {
  if (owner < 0 || !state || !state.players[owner]) return null;
  return PLAYER_COLORS[state.players[owner].color];
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

export function pointInRing(x: number, y: number, ring: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distToRing(x: number, y: number, ring: Vec2[]): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = ring[j][0];
    const ay = ring[j][1];
    const bx = ring[i][0];
    const by = ring[i][1];
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + t * dx - x;
    const py = ay + t * dy - y;
    const d = px * px + py * py;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

export function disposeObject(o: THREE.Object3D): void {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => disposeMaterial(x));
    else if (mat) disposeMaterial(mat);
  });
}

function disposeMaterial(m: THREE.Material): void {
  for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
  m.dispose();
}

/** Convex hull (monotone chain), counter-clockwise, no repeated end point. */
export function convexHull(points: Vec2[]): Vec2[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Vec2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Vec2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Signed-area magnitude of a ring (board units²). */
export function ringArea(r: Vec2[]): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return Math.abs(a / 2);
}

/** Douglas–Peucker on a closed ring: drops coastline detail finer than `tol` (board units). */
export function simplifyRing(r: Vec2[], tol: number): Vec2[] {
  if (r.length < 8) return r;
  const seg = (pts: Vec2[], a: number, b: number, keep: boolean[]) => {
    const stack: [number, number][] = [[a, b]];
    while (stack.length) {
      const [i0, i1] = stack.pop()!;
      const [ax, ay] = pts[i0];
      const [bx, by] = pts[i1];
      const dx = bx - ax;
      const dy = by - ay;
      const l2 = dx * dx + dy * dy || 1e-12;
      let best = -1;
      let bd = tol * tol;
      for (let i = i0 + 1; i < i1; i++) {
        let t = ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = ax + t * dx - pts[i][0];
        const ey = ay + t * dy - pts[i][1];
        const d = ex * ex + ey * ey;
        if (d > bd) {
          bd = d;
          best = i;
        }
      }
      if (best >= 0) {
        keep[best] = true;
        stack.push([i0, best], [best, i1]);
      }
    }
  };
  // split at the vertex farthest from the first one
  let far = 0;
  let fd = -1;
  for (let i = 1; i < r.length; i++) {
    const d = (r[i][0] - r[0][0]) ** 2 + (r[i][1] - r[0][1]) ** 2;
    if (d > fd) {
      fd = d;
      far = i;
    }
  }
  const pts = [...r, r[0]];
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[far] = keep[pts.length - 1] = true;
  seg(pts, 0, far, keep);
  seg(pts, far, pts.length - 1, keep);
  const out = pts.filter((_, i) => keep[i]);
  out.pop();
  return out.length >= 3 ? out : r;
}
