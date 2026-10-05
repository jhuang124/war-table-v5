// Projections + smooth regional magnification ("lenses") for a board. A pack recipe
// (scripts/map/packs/<id>/) picks a base projection and a list of lenses.
//
// Base projections map (lon, lat) to raw board units, with longitudes unwrapped into the board's
// window [lonLeft, lonLeft + 360] (the seam is at lonLeft):
//   miller   — Miller cylindrical (k = 0.8), squeezed into [marginX, width - marginX] (classic).
//   pseudo   — a pseudocylindrical d3-geo raw projection (true-world: Equal Earth), centred opposite the
//              seam, scaled so a chosen share of the equator spans the board, cropped to a latitude window.
//
// Lenses: elliptical radial maps r -> f(r) that are monotone along every ray from the
// lens centre (f(0)=0, f' > 0, f(r)=r outside the lens). Each lens is therefore a
// bijection of the plane, so composing them can never create or destroy land contacts:
// topology is preserved, only sizes change.

import { geoEqualEarthRaw, type GeoRawProjection } from 'd3-geo';

export interface BaseProjection {
  /** Board width (units). */
  width: number;
  /** Raw board height before rounding (units). */
  rawHeight: number;
  /** Western edge of the longitude window (the seam). */
  lonLeft: number;
  /** lon (already unwrapped into the window) / lat → raw board units. */
  forward(lon: number, lat: number): [number, number];
  inverse(x: number, y: number): [number, number];
}

/** Unwrap a longitude into [lonLeft, lonLeft + 360). */
export function unwrapLonFrom(lonLeft: number, lon: number): number {
  let l = lon;
  while (l < lonLeft) l += 360;
  while (l >= lonLeft + 360) l -= 360;
  return l;
}

export interface MillerParams {
  width: number;
  lonLeft: number;
  marginX: number;
  latBottom: number;
  latTop: number;
  marginBottom: number;
  marginTop: number;
}

/** Miller cylindrical, Pacific seam: the classic board's base. */
export function millerBase(p: MillerParams): BaseProjection {
  const WIDTH = p.width, LON_LEFT = p.lonLeft, MARGIN_X = p.marginX;
  const LAT_BOTTOM = p.latBottom, LAT_TOP = p.latTop, MARGIN_BOTTOM = p.marginBottom, MARGIN_TOP = p.marginTop;
  const SX = (WIDTH - 2 * MARGIN_X) / 360; // board units per degree of longitude
  const RAD_SCALE = (SX * 180) / Math.PI; // board units per radian
  const millerY = (latDeg: number) => {
    const phi = (latDeg * Math.PI) / 180;
    return 1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * phi));
  };
  const millerLat = (y: number) => ((Math.atan(Math.exp(y / 1.25)) - Math.PI / 4) / 0.4) * (180 / Math.PI);
  const Y0 = millerY(LAT_BOTTOM);
  return {
    width: WIDTH,
    lonLeft: LON_LEFT,
    rawHeight: MARGIN_BOTTOM + (millerY(LAT_TOP) - Y0) * RAD_SCALE + MARGIN_TOP,
    forward(lon, lat) {
      const x = MARGIN_X + (lon - LON_LEFT) * SX;
      const y = MARGIN_BOTTOM + (millerY(lat) - Y0) * RAD_SCALE;
      return [x, y];
    },
    inverse(x, y) {
      const lon = (x - MARGIN_X) / SX + LON_LEFT;
      const lat = millerLat((y - MARGIN_BOTTOM) / RAD_SCALE + Y0);
      return [lon, lat];
    },
  };
}

export interface PseudoParams {
  width: number;
  lonLeft: number;
  /**
   * How much of the globe the board's width shows: the equator's half-length that maps onto half the
   * board (1 = the whole equator edge to edge; less crops the empty mid-Pacific at the sides).
   */
  span: number;
  /**
   * Straighten the meridians toward the sides: x = λ·(edge·g(0) + (1 − edge)·g(φ)) instead of λ·g(φ).
   * 0 = the projection as designed (equal-area for Equal Earth); 0.3 widens the far north by up to ~10%.
   */
  edge?: number;
  latBottom: number;
  latTop: number;
  marginBottom: number;
  marginTop: number;
  /** Uniform vertical scale after projecting (1 = the projection's own proportions). */
  yScale?: number;
}

/**
 * A pseudocylindrical d3 raw projection (Equal Earth, Natural Earth I: straight parallels, x linear in
 * λ) as a board base. The central meridian is lonLeft + 180; +y north; latBottom sits at marginBottom.
 */
export function pseudoBase(raw: GeoRawProjection, p: PseudoParams): BaseProjection {
  const central = p.lonLeft + 180;
  const D = Math.PI / 180;
  const edge = p.edge ?? 0;
  const g = (phi: number) => raw(1, phi)[0]; // x per radian of λ at latitude phi
  const g0 = g(0);
  const fx = (phi: number) => edge * g0 + (1 - edge) * g(phi);
  const yOf = (phi: number) => raw(0, phi)[1];
  const k = p.width / 2 / (g0 * Math.PI * p.span); // board units per projection unit
  const yb = yOf(p.latBottom * D), yt = yOf(p.latTop * D);
  const X0 = p.width / 2;
  const ky = k * (p.yScale ?? 1);
  return {
    width: p.width,
    lonLeft: p.lonLeft,
    rawHeight: p.marginBottom + (yt - yb) * ky + p.marginTop,
    forward(lon, lat) {
      const phi = lat * D;
      return [X0 + (lon - central) * D * fx(phi) * k, p.marginBottom + (yOf(phi) - yb) * ky];
    },
    inverse(x, y) {
      const py = (y - p.marginBottom) / ky + yb;
      const r = raw.invert!(0, py);
      const phi = r[1];
      const lam = (x - X0) / k / fx(phi);
      return [central + lam / D, phi / D];
    },
  };
}

export interface LensSpec {
  name: string;
  /** Centre in lon/lat. */
  lon: number;
  lat: number;
  /** Core radius (board units, before the ellipse scaling) magnified uniformly by m. */
  r0: number;
  /** Outer radius where the map returns to identity. */
  R: number;
  m: number;
  /** Ellipse axis scale: distances are measured as hypot(dx/ax, dy/ay). */
  ax?: number;
  ay?: number;
}

export class Lens {
  spec: LensSpec;
  cx = 0;
  cy = 0;
  ax: number;
  ay: number;
  // Hermite coefficients for the transition zone.
  private h0 = 0;
  private h1 = 0;
  constructor(spec: LensSpec, center: [number, number]) {
    this.spec = spec;
    [this.cx, this.cy] = center;
    this.ax = spec.ax ?? 1;
    this.ay = spec.ay ?? 1;
    const { r0, R, m } = spec;
    if (!(m * r0 < R)) throw new Error(`lens ${spec.name}: m*r0 must be < R`);
    this.h0 = m * r0;
    this.h1 = R;
    // Monotonicity check of the transition.
    let prev = -Infinity;
    for (let i = 0; i <= 2000; i++) {
      const r = (R * 1.02 * i) / 2000;
      const v = this.f(r);
      if (!(v > prev)) throw new Error(`lens ${spec.name} is not monotone at r=${r}`);
      prev = v;
    }
  }
  /** Radial profile. */
  f(r: number): number {
    const { r0, R, m } = this.spec;
    if (r <= r0) return m * r;
    if (r >= R) return r;
    const L = R - r0;
    const t = (r - r0) / L;
    const t2 = t * t, t3 = t2 * t;
    const H00 = 2 * t3 - 3 * t2 + 1, H10 = t3 - 2 * t2 + t, H01 = -2 * t3 + 3 * t2, H11 = t3 - t2;
    return H00 * this.h0 + H10 * L * m + H01 * this.h1 + H11 * L * 1;
  }
  finv(q: number): number {
    const { r0, R, m } = this.spec;
    if (q <= m * r0) return q / m;
    if (q >= R) return q;
    let lo = r0, hi = R;
    for (let i = 0; i < 48; i++) {
      const mid = (lo + hi) / 2;
      if (this.f(mid) < q) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }
  apply(x: number, y: number): [number, number] {
    const dx = (x - this.cx) / this.ax, dy = (y - this.cy) / this.ay;
    const r = Math.hypot(dx, dy);
    if (r === 0 || r >= this.spec.R) return [x, y];
    const s = this.f(r) / r;
    return [this.cx + dx * s * this.ax, this.cy + dy * s * this.ay];
  }
  invert(x: number, y: number): [number, number] {
    const dx = (x - this.cx) / this.ax, dy = (y - this.cy) / this.ay;
    const q = Math.hypot(dx, dy);
    if (q === 0 || q >= this.spec.R) return [x, y];
    const s = this.finv(q) / q;
    return [this.cx + dx * s * this.ax, this.cy + dy * s * this.ay];
  }
}

/** A base projection with lenses composed on top: what the pipeline projects through. */
export class BoardProjection {
  base: BaseProjection;
  lenses: Lens[];
  width: number;
  height: number;
  constructor(base: BaseProjection, specs: LensSpec[]) {
    this.base = base;
    this.lenses = [];
    for (const s of specs) {
      // Lens centres are specified in lon/lat and placed after the previous lenses.
      let c = base.forward(this.unwrapLon(s.lon), s.lat);
      for (const l of this.lenses) c = l.apply(c[0], c[1]);
      this.lenses.push(new Lens(s, c));
    }
    this.width = base.width;
    this.height = base.rawHeight;
  }
  unwrapLon(lon: number): number {
    return unwrapLonFrom(this.base.lonLeft, lon);
  }
  /** lon (already unwrapped) / lat → board. */
  forward(lon: number, lat: number): [number, number] {
    let p = this.base.forward(lon, lat);
    for (const l of this.lenses) p = l.apply(p[0], p[1]);
    return p;
  }
  inverse(x: number, y: number): [number, number] {
    let p: [number, number] = [x, y];
    for (let i = this.lenses.length - 1; i >= 0; i--) p = this.lenses[i].invert(p[0], p[1]);
    return this.base.inverse(p[0], p[1]);
  }
}

// ---------------------------------------------------------------------------------------------
// Recipe v2: projection presets fitted to a lon/lat frame (docs/MAP-AUTHORING.md). An author picks a
// preset and a frame; the preset sizes the board so the frame spans `width` units across, centred on the
// frame's middle meridian (the seam sits opposite it, so a regional board never wraps).

/** [west, south, east, north] in degrees. East may exceed 180 for a frame across the antimeridian. */
export type LonLatBox = [number, number, number, number];

export type PresetName = 'mercatorLike' | 'equalEarth' | 'local';

export interface ProjectionPreset {
  /**
   *   mercatorLike — Miller cylindrical: shapes read like the familiar wall map (classic's base);
   *                  for a continent or a sea (Europe, the Mediterranean).
   *   equalEarth   — equal-area (true-world's base): for a hemisphere or the whole world.
   *   local        — plain equirectangular, true scale at the frame's middle latitude: for a city or
   *                  a small country, where the earth's curve doesn't matter.
   */
  preset: PresetName;
  /** Board width in units (default 80; classic is 100 for the whole world). */
  width?: number;
  /** Empty paper around the frame, in board units (default 1.5). */
  margin?: number;
  /** Vertical scale after projecting (default 1). */
  yScale?: number;
  /** Optional smooth lenses on top (see Lens), centres in lon/lat. */
  lenses?: LensSpec[];
}

type Raw = { fwd(lam: number, phi: number): [number, number]; inv(u: number, v: number): [number, number] };

function rawOf(preset: PresetName, phi0: number): Raw {
  if (preset === 'mercatorLike')
    return {
      fwd: (lam, phi) => [lam, 1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * phi))],
      inv: (u, v) => [u, (Math.atan(Math.exp(v / 1.25)) - Math.PI / 4) / 0.4],
    };
  if (preset === 'equalEarth')
    return {
      fwd: (lam, phi) => geoEqualEarthRaw(lam, phi) as [number, number],
      inv: (u, v) => geoEqualEarthRaw.invert!(u, v) as [number, number],
    };
  if (preset === 'local') {
    const c = Math.cos(phi0);
    return { fwd: (lam, phi) => [lam * c, phi], inv: (u, v) => [u / c, v] };
  }
  throw new Error(`unknown projection preset "${preset}" (mercatorLike, equalEarth, local)`);
}

/** A base projection that fits `frame` into a board `width` units wide (presets above). */
export function frameBase(preset: PresetName, frame: LonLatBox, o: { width?: number; margin?: number; yScale?: number } = {}): BaseProjection {
  const [w, s, e, n] = frame;
  if (!(e > w && n > s)) throw new Error(`frame [${frame.join(', ')}] must be [west, south, east, north] with east > west and north > south`);
  const D = Math.PI / 180;
  const width = o.width ?? 80, margin = o.margin ?? 1.5, ys = o.yScale ?? 1;
  const central = (w + e) / 2;
  const raw = rawOf(preset, ((s + n) / 2) * D);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let i = 0; i <= 16; i++)
    for (let j = 0; j <= 16; j++) {
      const [u, v] = raw.fwd((w + ((e - w) * i) / 16 - central) * D, (s + ((n - s) * j) / 16) * D);
      (u0 = Math.min(u0, u)), (u1 = Math.max(u1, u)), (v0 = Math.min(v0, v)), (v1 = Math.max(v1, v));
    }
  const k = (width - 2 * margin) / (u1 - u0);
  return {
    width,
    lonLeft: central - 180,
    rawHeight: 2 * margin + (v1 - v0) * k * ys,
    forward(lon, lat) {
      const [u, v] = raw.fwd((lon - central) * D, lat * D);
      return [margin + (u - u0) * k, margin + (v - v0) * k * ys];
    },
    inverse(x, y) {
      const [lam, phi] = raw.inv((x - margin) / k + u0, (y - margin) / (k * ys) + v0);
      return [central + lam / D, phi / D];
    },
  };
}

/** A preset + frame as the BoardProjection the pipeline projects through. */
export function presetProjection(p: ProjectionPreset, frame: LonLatBox): BoardProjection {
  return new BoardProjection(frameBase(p.preset, frame, p), p.lenses ?? []);
}
