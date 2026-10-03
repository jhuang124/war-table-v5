// The ink layer (docs/INK.md B §3): built once at boot, sampled by the ground and by every tile top so the
// brush strokes sit on the washes.
//
// - `ink`   RGBA, 4096×~2028 (2048 on phones), board rect: R = coastlines as dry brush (multi-pass bristle
//           ribbons with noise-modulated width and dry gaps), G = interior borders (thinner; drawn at 40 %
//           by the shaders), B = the decorative (non-playable) coasts.
// - `field` RGBA, half the ink resolution: R = proximity to the territory's own border (1 at the border → 0
//           ~1.2 units inside; drives edge darkening and the selection rims), G = distance from land over
//           the sea (0 at the coast → 1 at 4 units; drives the coast feather and the mist), B = territory
//           index (1..42; over the sea: the nearest coast's, within ~1.5 units; read with texelFetch),
//           A = land coverage.
//           A = the interior borders again at the Medium weight ([place v5] front lines).
// - `cont`  RGBA at field resolution: the printed continents (v3; buildContinents); A = the territory across
//           the nearest land border ([place v5] front lines).
// - `noise` a small tileable fbm texture (4 channels) the shaders use for mist, mottling and breathing,
//           instead of evaluating fbm per pixel.
// - `waves` an atlas of calligraphic wave strokes (the board places 6–8 of them per game, seeded).
// - `maps`  the pigment maps (docs/INK2.md §4, texmaps.ts): the streaks shape the coasts' and waves' dry
//           brush at build time (when decoded in time); the paper and wash load after the first frame and
//           dry in (`uTexOn` 0 → 1, 400 ms). `setQuality()` steps the fallback ladder down.
import * as THREE from 'three';
import type { BoardGeometry, Vec2 } from '../map/types';
import { TERRITORY_IDS, TERRITORIES, CONTINENT_IDS } from '../engine/mapData';
import type { ContinentId, TerritoryId } from '../engine/types';
import { loadStreaks, loadTexMaps, type StreakData, type TexMaps } from './texmaps';

export interface InkLayer {
  ink: THREE.DataTexture;
  field: THREE.DataTexture;
  /** The printed continents (v3): R outline distance, G own continent (255 = open sea), B the outline's continent. */
  cont: THREE.DataTexture;
  noise: THREE.DataTexture;
  waves: THREE.CanvasTexture;
  /** Number of wave variants stacked vertically in `waves`. */
  waveRows: number;
  inkW: number;
  inkH: number;
  fieldW: number;
  fieldH: number;
  /** 1-based territory index as stored in field.B (TERRITORY_IDS order). */
  index: (t: TerritoryId) => number;
  /** Continent index (CONTINENT_IDS order) of a 1-based territory index. */
  continentIndex: (i: number) => number;
  /** Distance from land over the sea, board units (≥ 4 = open sea), at a board point. */
  seaDistance: (bx: number, by: number) => number;
  /** Board-space centre of each continent (the re-ink sweep turns about it). */
  continentCentre: Record<ContinentId, Vec2>;
  buildMs: number;
  // --- the pigment maps (docs/INK2.md §4; all additive) ------------------------------------------------
  /** Paper + wash maps once they have loaded (after the first frame); undefined until then or on failure. */
  maps?: TexMaps;
  /** Resolves when the maps have loaded (or null: the procedural board stays). */
  mapsReady: Promise<TexMaps | null>;
  /** The coasts and waves were drawn with the streak map (false: the value-noise brush, as before). */
  streaked: boolean;
  /** Current fallback-ladder level: 3 desktop, 2 phone, 1 one wash tap, 0 procedural (INK2 §4.3). */
  readonly quality: number;
  /**
   * Step the texture ladder down (never back up within a session): 2 = 512 maps / anisotropy 1 and three map
   * taps (paper 1, wash 2), 1 = one wash tap and the paper's fibre tap only, 0 = the procedural board
   * (`uTexOn` → 0 over 300 ms; the coasts keep the brush they were drawn with at boot).
   */
  setQuality(level: number): void;
  /** Called by the shared uniforms (inkGlsl.ts) so the ladder can drive `uPaperTex` / `uWashTex` / `uTexOn`. */
  bindShared(u: TexUniforms): void;
  /** Set by the tiles: asks the board for a frame while `uTexOn` eases (the board otherwise draws on demand). */
  kick?: () => void;
}

/** The shared uniforms the ladder drives (a subset of inkGlsl's SharedUniforms). */
export interface TexUniforms {
  uPaperTex: { value: THREE.Texture };
  uWashTex: { value: THREE.Texture };
  uTexOn: { value: number };
  uTexTaps: { value: number };
}

// ---------------------------------------------------------------------------
// small deterministic noise
// ---------------------------------------------------------------------------

function hash1(n: number, seed: number): number {
  let h = (Math.imul(n | 0, 374761393) + Math.imul(seed | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}
/** Smooth 1-D value noise in [0, 1]. */
function n1(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash1(i, seed) * (1 - u) + hash1(i + 1, seed) * u;
}
function hash2(x: number, y: number, seed: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}
function vnoise2(x: number, y: number, seed: number, wx: number, wy: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const w = (v: number, m: number) => ((v % m) + m) % m;
  const a = hash2(w(xi, wx), w(yi, wy), seed);
  const b = hash2(w(xi + 1, wx), w(yi, wy), seed);
  const c = hash2(w(xi, wx), w(yi + 1, wy), seed);
  const d = hash2(w(xi + 1, wx), w(yi + 1, wy), seed);
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
/** Tileable fbm: `cx`×`cy` cells across the tile at the first octave. */
function fbmTile(u: number, v: number, cx: number, cy: number, seed: number, oct: number): number {
  let s = 0;
  let amp = 0.5;
  let norm = 0;
  let fx = cx;
  let fy = cy;
  for (let o = 0; o < oct; o++) {
    s += amp * vnoise2(u * fx, v * fy, seed + o * 31, fx, fy);
    norm += amp;
    amp *= 0.5;
    fx *= 2;
    fy *= 2;
  }
  return s / norm;
}

/**
 * Stroke widths per repeat of the streak map along the stroke. INK2 §4.2 says 48; at 48 the gaps come about
 * once a unit and read as a steadier, wetter line than the value noise did. 24 keeps the streaks long (the map
 * is still stretched ~3× along the stroke) and gives the coasts their dry breaks.
 */
const STREAK_WIDTHS = 24;
/** A streak sampler's `on` value at the map's threshold (the source's 50 % ink level). */
const STREAK_THRESHOLD = 0.5;

const yieldFrame = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * The v4 edge ladder (_claude/v4/PLAN.md E2): four stroke weights, one job each, in CSS px at the 1440×900 home
 * view. Heavy = the coast (ivory), Medium = the continent outline (silver / its holder's colour; drawn by the
 * shaders, uContW), Light = the territory border (the paper's deep tone), Hair = sea lanes (lanes.ts) and the
 * decorative coasts. The baked strokes are sized for EDGE_REF_PPU px a board unit (the desktop home view).
 */
export const EDGE_PX = { heavy: 2.0, medium: 1.4, light: 0.6, hair: 0.4 } as const;
export const EDGE_REF_PPU = 14.5;

// ---------------------------------------------------------------------------
// dry brush
// ---------------------------------------------------------------------------

export interface BrushOpts {
  /** Full stroke width, px. */
  width: number;
  /** Bristle passes (the first ~third are the loaded core, the rest thinner dry bristles). */
  passes: number;
  /** Alpha of each pass (the core; bristles get less). */
  alpha: number;
  /** Lateral wander of each pass, ± px. */
  jitter: number;
  /** 0..1: how often the dry bristles lift off (0 = never). */
  dry: number;
  seed: number;
  /** Resample spacing, px. */
  spacing: number;
  /** Taper the two ends of an open stroke (px); 0 = butt ends (coast runs meeting borders). */
  endTaper: number;
  /** Width falloff along an open stroke: 0 = even, 1 = thick → thin (wave strokes, the arrow). */
  thin?: number;
  /**
   * Real dry-brush streaks (docs/INK2.md §4.2) instead of the 1-D value noise: for bristle `k` at `lateral`
   * (−1..1 across the stroke) and arc length `sPx`, `on` = the source's ink density there, scaled so 0.5 is
   * the map's threshold (the bristle shows where on > 0.5 · dry / 0.55) and `swell` = the stroke's
   * slow thickening (0..1, mean 0.5), shared by every bristle so the whole line swells together.
   */
  streak?: (sPx: number, k: number, lateral: number) => { on: number; swell: number };
}

/**
 * Stroke a polyline (canvas px, flat [x0,y0,x1,y1,…]) as a dry brush: several bristle ribbons, each
 * wandering a little across the stroke, with noise-modulated width and, for the outer bristles, dry gaps
 * where the brush lifted (their ends taper, so the gaps feather).
 */
export function dryBrush(ctx: CanvasRenderingContext2D, flat: number[], closed: boolean, o: BrushOpts): void {
  const n0 = flat.length / 2;
  if (n0 < 2) return;
  // Resample at an even spacing.
  const X: number[] = [];
  const Y: number[] = [];
  const S: number[] = [];
  const segs = closed ? n0 : n0 - 1;
  let acc = 0;
  let carry = 0;
  for (let i = 0; i < segs; i++) {
    const ax = flat[i * 2];
    const ay = flat[i * 2 + 1];
    const j = (i + 1) % n0;
    const bx = flat[j * 2];
    const by = flat[j * 2 + 1];
    const L = Math.hypot(bx - ax, by - ay);
    if (L < 1e-6) continue;
    let d = carry;
    while (d < L) {
      const t = d / L;
      X.push(ax + (bx - ax) * t);
      Y.push(ay + (by - ay) * t);
      S.push(acc + d);
      d += o.spacing;
    }
    carry = d - L;
    acc += L;
  }
  if (!closed) {
    X.push(flat[(n0 - 1) * 2]);
    Y.push(flat[(n0 - 1) * 2 + 1]);
    S.push(acc);
  }
  const n = X.length;
  if (n < 2) return;
  const total = acc;
  // Normals (central differences over ±2 samples: smooths the polygon's corners a little).
  const NX = new Float32Array(n);
  const NY = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = closed ? (i - 2 + n) % n : Math.max(0, i - 2);
    const b = closed ? (i + 2) % n : Math.min(n - 1, i + 2);
    const dx = X[b] - X[a];
    const dy = Y[b] - Y[a];
    const l = Math.hypot(dx, dy) || 1;
    NX[i] = -dy / l;
    NY[i] = dx / l;
  }
  const core = Math.max(1, Math.round(o.passes / 4));
  for (let k = 0; k < o.passes; k++) {
    const isCore = k < core;
    const sd = o.seed * 101 + k * 17;
    // The loaded core runs down the middle; the bristles are thin ribbons spread across (and a little past)
    // the stroke's width, each drier than the core, so the edges break up and feather.
    const wFrac = isCore ? 0.48 + 0.1 * hash1(k, sd) : 0.09 + 0.2 * hash1(k, sd);
    const alpha = isCore ? o.alpha : o.alpha * (0.45 + 0.55 * hash1(k + 9, sd));
    const side = isCore ? (hash1(k + 5, sd) * 2 - 1) * o.width * 0.08 : (hash1(k + 5, sd) * 2 - 1) * o.width * 0.62;
    const dry = isCore ? o.dry * 0.3 : Math.min(0.95, o.dry * (0.7 + 0.6 * hash1(k + 13, sd)));
    const on = new Uint8Array(n);
    const st = o.streak;
    const lateral = Math.max(-1, Math.min(1, side / (o.width * 0.62)));
    const swell = st ? new Float32Array(n) : null;
    if (st) {
      // the map's threshold is the source's 50 % ink level at the coasts' dry 0.55; drier bristles need
      // denser ink to show, the loaded core almost never lifts
      const thr = STREAK_THRESHOLD * (dry / 0.55);
      for (let i = 0; i < n; i++) {
        const v = st(S[i], k, lateral);
        on[i] = dry <= 0 || v.on > thr ? 1 : 0;
        swell![i] = v.swell;
      }
    } else for (let i = 0; i < n; i++) on[i] = dry <= 0 || n1(S[i] * 0.07 + sd * 0.37, sd) * 0.75 + n1(S[i] * 0.23 + 3.3, sd + 5) * 0.25 > dry * 0.66 ? 1 : 0;
    // Runs of "on" samples. A closed ring starts at a gap (so no run straddles the seam); if it has none,
    // it is one closed ribbon.
    let start = 0;
    let full = false;
    if (closed) {
      let g = -1;
      for (let i = 0; i < n; i++)
        if (!on[i]) {
          g = i;
          break;
        }
      if (g < 0) full = true;
      else start = g;
    }
    const path = new Path2D();
    const W = new Float32Array(n);
    const OF = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // line weight: the value-noise swell per bristle, or the streak map's swell for the whole stroke
      const sw = swell ? 0.7 + 0.6 * swell[i] : 0.5 + 1.0 * n1(S[i] * 0.035 + 11.3, sd + 1);
      let w = o.width * wFrac * sw * (0.85 + 0.3 * n1(S[i] * 0.2, sd + 7));
      if (o.thin) {
        const u = total > 0 ? S[i] / total : 0;
        w *= 1 - o.thin * 0.78 * u * u;
      }
      W[i] = w;
      OF[i] = side + o.jitter * (n1(S[i] * 0.02 + 4.1, sd + 2) * 2 - 1);
    }
    const ribbon = (idx: number[], taperA: boolean, taperB: boolean, close: boolean) => {
      if (idx.length < 2) return;
      const m = idx.length;
      const s0 = S[idx[0]];
      let s1 = S[idx[m - 1]];
      if (s1 < s0) s1 += total;
      const tl = Math.max(o.spacing * 2, Math.min(o.width * 3, (s1 - s0) / 2));
      const wAt = (q: number) => {
        const i = idx[q];
        let s = S[i];
        if (s < s0) s += total;
        let f = 1;
        if (taperA) f = Math.min(f, (s - s0) / tl);
        if (taperB) f = Math.min(f, (s1 - s) / tl);
        f = Math.max(0, Math.min(1, f));
        f = f * f * (3 - 2 * f);
        return W[i] * f;
      };
      for (let q = 0; q < m; q++) {
        const i = idx[q];
        const hw = wAt(q) / 2;
        const x = X[i] + NX[i] * (OF[i] + hw);
        const y = Y[i] + NY[i] * (OF[i] + hw);
        if (q === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      }
      if (close) {
        path.closePath();
        for (let q = m - 1; q >= 0; q--) {
          const i = idx[q];
          const hw = wAt(q) / 2;
          const x = X[i] + NX[i] * (OF[i] - hw);
          const y = Y[i] + NY[i] * (OF[i] - hw);
          if (q === m - 1) path.moveTo(x, y);
          else path.lineTo(x, y);
        }
        path.closePath();
        return;
      }
      for (let q = m - 1; q >= 0; q--) {
        const i = idx[q];
        const hw = wAt(q) / 2;
        path.lineTo(X[i] + NX[i] * (OF[i] - hw), Y[i] + NY[i] * (OF[i] - hw));
      }
      path.closePath();
    };
    if (full) {
      const idx: number[] = [];
      for (let i = 0; i < n; i++) idx.push(i);
      ribbon(idx, false, false, true);
    } else {
      let run: number[] = [];
      let runStartsAtEnd = true;
      for (let q = 0; q < n; q++) {
        const i = (start + q) % n;
        if (on[i]) {
          if (!run.length) runStartsAtEnd = !closed && i === 0;
          run.push(i);
        } else if (run.length) {
          ribbon(run, runStartsAtEnd ? o.endTaper > 0 : true, true, false);
          run = [];
        }
      }
      if (run.length) {
        const endsAtEnd = !closed && run[run.length - 1] === n - 1;
        ribbon(run, runStartsAtEnd ? o.endTaper > 0 : true, endsAtEnd ? o.endTaper > 0 : true, false);
      }
    }
    ctx.fillStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
    ctx.fill(path, 'nonzero');
  }
}

// ---------------------------------------------------------------------------
// the streak map as a brush (docs/INK2.md §4.2)
// ---------------------------------------------------------------------------

/** Per-row prefix sums of the streak map's R (bristle ink) and one swell profile for the whole stroke. */
export interface StreakBrush {
  w: number;
  h: number;
  /** (h × (w + 1)) prefix sums of R/255 along x, per row. */
  cum: Float32Array;
  /** Column swell (mean G across the rows), renormalised to mean 0.5, std 0.2, clamped 0..1. */
  swell: Float32Array;
  /** R/255 at the map's threshold (the source's 50 % ink level). */
  threshold: number;
}

export function makeStreakBrush(sd: StreakData): StreakBrush {
  const { w, h, data } = sd;
  const cum = new Float32Array(h * (w + 1));
  for (let y = 0; y < h; y++) {
    const o = y * (w + 1);
    let acc = 0;
    for (let x = 0; x < w; x++) {
      acc += data[(y * w + x) * 4] / 255;
      cum[o + x + 1] = acc;
    }
  }
  const col = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let a = 0;
    for (let y = 0; y < h; y++) a += data[(y * w + x) * 4 + 1];
    col[x] = a / h / 255;
  }
  let m = 0;
  for (const v of col) m += v;
  m /= w;
  let va = 0;
  for (const v of col) va += (v - m) ** 2;
  const sdv = Math.sqrt(va / w) || 1;
  const swell = new Float32Array(w);
  for (let x = 0; x < w; x++) swell[x] = Math.max(0, Math.min(1, 0.5 + ((col[x] - m) / sdv) * 0.2));
  return { w, h, cum, swell, threshold: sd.threshold };
}

/**
 * A `BrushOpts.streak` for one stroke: the stroke runs along the map's x (one repeat per STREAK_WIDTHS stroke widths,
 * wrapped, starting at a per-stroke offset); each bristle reads the row at its place across the stroke
 * (the loaded middle rows for the core, the drier outer rows for the edge bristles), averaged over the
 * stretch of map one resample step covers, so a gap in the ink is a gap in the stroke, not texel noise.
 */
function streakFor(b: StreakBrush, seed: number, widthPx: number, spacing: number): NonNullable<BrushOpts['streak']> {
  const perPx = b.w / Math.max(1, widthPx * STREAK_WIDTHS);
  const x0 = hash1(seed, 71) * b.w;
  const win = Math.max(1, Math.round(perPx * spacing));
  const scale = STREAK_THRESHOLD / b.threshold;
  return (sPx, k, lateral) => {
    let xs = Math.floor(x0 + sPx * perPx) % b.w;
    if (xs < 0) xs += b.w;
    const jitter = (hash1(k, seed * 7 + 3) - 0.5) * 0.1;
    const row = Math.max(0, Math.min(b.h - 1, Math.round((0.5 + 0.4 * lateral + jitter) * (b.h - 1))));
    const o = row * (b.w + 1);
    const xe = xs + win;
    const sum = xe <= b.w ? b.cum[o + xe] - b.cum[o + xs] : b.cum[o + b.w] - b.cum[o + xs] + b.cum[o + (xe - b.w)];
    return { on: (sum / win) * scale, swell: b.swell[xs] };
  };
}

// ---------------------------------------------------------------------------
// the texture ladder (docs/INK2.md §4.3): uTexOn / uTexTaps and the maps
// ---------------------------------------------------------------------------

const smooth01 = (x: number) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
};

class TexLadder {
  level: number;
  maps: TexMaps | null = null;
  private u: TexUniforms | null = null;
  private from = 0;
  private to = 0;
  private t0 = 0;
  private dur = 0;
  private raf = 0;
  private small: boolean;
  private swapping = false;
  kick?: () => void;
  /** Told when the maps change (loaded, or swapped for the 512 set at L2). */
  onMaps?: (m: TexMaps) => void;

  constructor(level: number, small: boolean) {
    this.level = level;
    this.small = small;
  }

  bind(u: TexUniforms): void {
    this.u = u;
    u.uTexTaps.value = Math.max(1, this.level);
    if (this.maps) this.useMaps(this.maps, 400);
  }

  /** The maps arrived: the paper dries in (uTexOn 0 → 1 over 400 ms), unless the ladder is at L0. */
  loaded(m: TexMaps | null): void {
    if (!m) {
      this.level = 0;
      return;
    }
    this.maps = m;
    this.onMaps?.(m);
    if (this.u) this.useMaps(m, 400);
  }

  private useMaps(m: TexMaps, ms: number): void {
    const u = this.u!;
    u.uPaperTex.value = m.paper;
    u.uWashTex.value = m.wash;
    if (this.level >= 1) this.ramp(1, ms);
  }

  setQuality(level: number): void {
    const l = Math.max(0, Math.min(3, Math.floor(level)));
    if (!(l < this.level)) return; // never steps back up
    this.level = l;
    const u = this.u;
    if (u) u.uTexTaps.value = Math.max(1, l);
    if (l === 0) {
      this.ramp(0, 300);
      return;
    }
    // L2 on a desktop: the 512 set, anisotropy 1 (swapped in when it has loaded; no fade, same look)
    if (l <= 2 && this.maps && this.maps.size > 512 && !this.swapping) {
      this.swapping = true;
      loadTexMaps(null, { small: true }).then((m) => {
        if (!m || this.level === 0) return;
        const old = this.maps;
        this.maps = m;
        this.onMaps?.(m);
        if (this.u) {
          this.u.uPaperTex.value = m.paper;
          this.u.uWashTex.value = m.wash;
        }
        this.kick?.();
        old?.paper.dispose();
        old?.wash.dispose();
      });
    }
    this.small = true;
    this.kick?.();
  }

  private ramp(to: number, ms: number): void {
    const u = this.u;
    if (!u) return;
    this.from = u.uTexOn.value;
    this.to = to;
    this.dur = ms;
    this.t0 = performance.now();
    if (this.raf) return;
    const step = () => {
      const k = this.dur > 0 ? (performance.now() - this.t0) / this.dur : 1;
      u.uTexOn.value = this.from + (this.to - this.from) * smooth01(k);
      this.kick?.();
      if (k >= 1) {
        u.uTexOn.value = this.to;
        this.raf = 0;
        return;
      }
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  get isSmall(): boolean {
    return this.small;
  }
}

/** The dev / e2e hook `?tex=0|1|2|3`: start the ladder at that level (0 = the procedural board, no maps). */
function texHook(): number | null {
  const env = import.meta.env as Record<string, unknown> | undefined;
  if (!env || !(env.DEV || env.VITE_E2E)) return null;
  if (typeof location === 'undefined') return null;
  const v = new URLSearchParams(location.search).get('tex');
  if (v == null || !/^[0-3]$/.test(v)) return null;
  return Number(v);
}

// ---------------------------------------------------------------------------
// rasterising the territories (id map) and the distance field
// ---------------------------------------------------------------------------

/** Scanline-fill rings (board coords) into `out` with `value` (even–odd per call). */
function fillRings(out: Uint8Array, FW: number, FH: number, rings: Vec2[][], s: number, BH: number, value: number): void {
  const rows = new Map<number, number[]>();
  for (const ring of rings) {
    const m = ring.length;
    for (let i = 0; i < m; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % m];
      const ax = a[0] * s;
      const ay = (BH - a[1]) * s;
      const bx = b[0] * s;
      const by = (BH - b[1]) * s;
      if (ay === by) continue;
      const y0 = Math.min(ay, by);
      const y1 = Math.max(ay, by);
      const r0 = Math.max(0, Math.ceil(y0 - 0.5));
      const r1 = Math.min(FH - 1, Math.ceil(y1 - 0.5) - 1);
      for (let r = r0; r <= r1; r++) {
        const yc = r + 0.5;
        const x = ax + ((yc - ay) / (by - ay)) * (bx - ax);
        let list = rows.get(r);
        if (!list) rows.set(r, (list = []));
        list.push(x);
      }
    }
  }
  for (const [r, xs] of rows) {
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil(xs[k] - 0.5));
      const c1 = Math.min(FW - 1, Math.ceil(xs[k + 1] - 0.5) - 1);
      const base = r * FW;
      for (let c = c0; c <= c1; c++) out[base + c] = value;
    }
  }
}

/** 1-D squared distance transform (Felzenszwalb) with the arg-min site. */
function edt1d(f: Float64Array, n: number, d: Float64Array, arg: Int32Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -1e30;
  z[1] = 1e30;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = 1e30;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    arg[q] = v[k];
  }
}

/** 2-D Euclidean distance transform (px) to the `feature` pixels, with the nearest feature's index. */
function edt2d(feature: Uint8Array, W: number, H: number): { dist: Float32Array; near: Int32Array } {
  const N = W * H;
  const d1 = new Float64Array(N);
  const ny = new Int32Array(N);
  {
    const f = new Float64Array(H);
    const d = new Float64Array(H);
    const arg = new Int32Array(H);
    const v = new Int32Array(H);
    const z = new Float64Array(H + 1);
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) f[y] = feature[y * W + x] ? 0 : 1e20;
      edt1d(f, H, d, arg, v, z);
      for (let y = 0; y < H; y++) {
        d1[y * W + x] = d[y];
        ny[y * W + x] = arg[y];
      }
    }
  }
  const dist = new Float32Array(N);
  const near = new Int32Array(N);
  {
    const f = new Float64Array(W);
    const d = new Float64Array(W);
    const arg = new Int32Array(W);
    const v = new Int32Array(W);
    const z = new Float64Array(W + 1);
    for (let y = 0; y < H; y++) {
      const base = y * W;
      for (let x = 0; x < W; x++) f[x] = d1[base + x];
      edt1d(f, W, d, arg, v, z);
      for (let x = 0; x < W; x++) {
        dist[base + x] = Math.sqrt(d[x]);
        const ax = arg[x];
        near[base + x] = ny[base + ax] * W + ax;
      }
    }
  }
  return { dist, near };
}

/** How far out from its coasts a continent's printed region reaches, board units. */
export const CONT_HALO = 0.45;
/** The closing's reach (board units): gaps under twice this between a continent's coasts are filled. */
export const CONT_REACH = 2.1;
/** The outline distance channel's range, board units (R = 1 at and past it). */
export const CONT_DR = 1.2;

/** The printed continents' field (see buildInk): outline distance, own continent, the outline's continent. */
async function buildContinents(ids: Uint8Array, W: number, H: number, sF: number, contOf: Uint8Array, DECOR: number): Promise<THREE.DataTexture> {
  const N = W * H;
  // nearest playable land for every texel (decorative land counts as sea: the halo runs over it)
  const land = new Uint8Array(N);
  for (let i = 0; i < N; i++) land[i] = ids[i] && ids[i] !== DECOR ? 1 : 0;
  const A = edt2d(land, W, H);
  await yieldFrame();
  // The region is smoothed like a printed zone (a morphological closing): grow CONT_REACH out from the land,
  // then shrink back to CONT_HALO, so bays, inlets and archipelagos fill in and the line runs in long,
  // calm curves instead of tracing every inlet.
  const reach = CONT_REACH * sF;
  const outside = new Uint8Array(N);
  for (let i = 0; i < N; i++) outside[i] = A.dist[i] > reach ? 1 : 0;
  const O = edt2d(outside, W, H);
  await yieldFrame();
  const shrink = (CONT_REACH - CONT_HALO) * sF;
  const cont = new Uint8Array(N).fill(255);
  for (let i = 0; i < N; i++) if (O.dist[i] > shrink) cont[i] = contOf[ids[A.near[i]]] ?? 255;
  // Small enclosed pools of open sea (the Arabian Sea's pocket between Africa and Asia's halos) are printed
  // over too: a ring of outline round a puddle reads as a mark, not a sea.
  {
    const maxPool = 36 * sF * sF;
    const seen = new Uint8Array(N);
    const stack: number[] = [];
    const comp: number[] = [];
    for (let s0 = 0; s0 < N; s0++) {
      if (seen[s0] || cont[s0] !== 255) continue;
      comp.length = 0;
      let edge = false;
      stack.push(s0);
      seen[s0] = 1;
      while (stack.length) {
        const i = stack.pop()!;
        comp.push(i);
        const x = i % W;
        const y = (i - x) / W;
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) edge = true;
        const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1];
        for (const j of nb)
          if (j >= 0 && !seen[j] && cont[j] === 255) {
            seen[j] = 1;
            stack.push(j);
          }
      }
      if (!edge && comp.length < maxPool) for (const i of comp) cont[i] = contOf[ids[A.near[i]]] ?? 255;
    }
  }
  // outline texels: inside a region, next to another region or open sea (or the board's edge: every
  // printed region is closed)
  const line = new Uint8Array(N);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const c = cont[i];
      if (c === 255) continue;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) line[i] = 1;
      else if (cont[i - 1] !== c || cont[i + 1] !== c || cont[i - W] !== c || cont[i + W] !== c) line[i] = 1;
    }
  const B = edt2d(line, W, H);
  await yieldFrame();
  const out = new Uint8Array(N * 4);
  const dr = CONT_DR * sF;
  for (let i = 0; i < N; i++) {
    const o = i * 4;
    // the outline texels sit on the inner side of the boundary: centre the line on it (half a texel out)
    const d = Math.max(0, B.dist[i] + (cont[i] === 255 ? -0.5 : 0.5));
    out[o] = Math.round(255 * Math.min(1, d / dr));
    out[o + 1] = cont[i];
    out[o + 2] = cont[B.near[i]];
    out[o + 3] = 255;
  }
  const t = new THREE.DataTexture(out, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

export interface InkOptions {
  /** Phones: the half-size canvas (2048). */
  small: boolean;
  maxTextureSize: number;
  /** Optional: lets the pigment maps upload as soon as they decode (otherwise on the first frame using them). */
  renderer?: THREE.WebGLRenderer;
}

export async function buildInk(g: BoardGeometry, opt: InkOptions): Promise<InkLayer> {
  const t0 = performance.now();
  // The pigment maps (INK2 §4): fetched in parallel with the canvas work below and never waited for. The
  // streaks are small and usually decoded by the time the coasts are drawn (else the noise brush runs, as
  // before); the paper and wash arrive after the first frame and dry in.
  const hook = texHook();
  const ladder = new TexLadder(hook ?? (opt.small ? 2 : 3), opt.small || hook === 2);
  let streakBrush: StreakBrush | null = null;
  const streakP =
    ladder.level === 0
      ? Promise.resolve(null)
      : loadStreaks(opt.small ? 1024 : 2048).then((d) => (streakBrush = d ? makeStreakBrush(d) : null));
  void streakP;
  const BW = g.width;
  const BH = g.height;
  const inkW = Math.min(opt.small ? 2048 : 4096, opt.maxTextureSize || 4096);
  const inkH = Math.round((inkW * BH) / BW);
  const fieldW = inkW / 2;
  const fieldH = Math.round((fieldW * BH) / BW);
  const sF = fieldW / BW;
  const index = (t: TerritoryId) => TERRITORY_IDS.indexOf(t) + 1;
  const contOf = new Uint8Array(64).fill(255);
  TERRITORY_IDS.forEach((t, i) => (contOf[i + 1] = CONTINENT_IDS.indexOf(TERRITORIES[t].continent)));

  // --- id map (field resolution) ------------------------------------------------------------
  const DECOR = 250;
  const ids = new Uint8Array(fieldW * fieldH);
  for (const p of g.decorativeLand) fillRings(ids, fieldW, fieldH, [p.outer, ...p.holes], sF, BH, DECOR);
  TERRITORY_IDS.forEach((t, i) => {
    const rings: Vec2[][] = [];
    for (const p of g.territories[t].polygons) rings.push(p.outer, ...p.holes);
    fillRings(ids, fieldW, fieldH, rings, sF, BH, i + 1);
  });
  await yieldFrame();

  // --- distance to the nearest border pixel (land pixels that touch a different id) -------------------
  const N = fieldW * fieldH;
  const feature = new Uint8Array(N);
  for (let y = 0; y < fieldH; y++)
    for (let x = 0; x < fieldW; x++) {
      const i = y * fieldW + x;
      const v = ids[i];
      if (!v) continue;
      if (
        (x > 0 && ids[i - 1] !== v) ||
        (x < fieldW - 1 && ids[i + 1] !== v) ||
        (y > 0 && ids[i - fieldW] !== v) ||
        (y < fieldH - 1 && ids[i + fieldW] !== v)
      )
        feature[i] = 1;
    }
  const d1 = new Float64Array(N);
  const ny = new Int32Array(N);
  {
    const n = fieldH;
    const f = new Float64Array(n);
    const d = new Float64Array(n);
    const arg = new Int32Array(n);
    const v = new Int32Array(n);
    const z = new Float64Array(n + 1);
    for (let x = 0; x < fieldW; x++) {
      for (let y = 0; y < n; y++) f[y] = feature[y * fieldW + x] ? 0 : 1e20;
      edt1d(f, n, d, arg, v, z);
      for (let y = 0; y < n; y++) {
        d1[y * fieldW + x] = d[y];
        ny[y * fieldW + x] = arg[y];
      }
    }
  }
  await yieldFrame();
  const dist = new Float32Array(N);
  const near = new Int32Array(N);
  {
    const n = fieldW;
    const f = new Float64Array(n);
    const d = new Float64Array(n);
    const arg = new Int32Array(n);
    const v = new Int32Array(n);
    const z = new Float64Array(n + 1);
    for (let y = 0; y < fieldH; y++) {
      const base = y * fieldW;
      for (let x = 0; x < n; x++) f[x] = d1[base + x];
      edt1d(f, n, d, arg, v, z);
      for (let x = 0; x < n; x++) {
        dist[base + x] = Math.sqrt(d[x]);
        const ax = arg[x];
        near[base + x] = ny[base + ax] * fieldW + ax;
      }
    }
  }
  await yieldFrame();

  // --- field texture --------------------------------------------------------------------------------
  const field = new Uint8Array(N * 4);
  const inR = 1.2 * sF; // edge proximity ramp, px
  const seaR = 4 * sF; // sea distance ramp, px
  const nearR = 1.5 * sF;
  const seaDist = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const v = ids[i];
    const o = i * 4;
    const d = dist[i];
    if (v) {
      field[o] = Math.round(255 * Math.max(0, Math.min(1, 1 - d / inR)));
      field[o + 1] = 0;
      field[o + 2] = v === DECOR ? 0 : v;
      field[o + 3] = 255;
    } else {
      const sd = Math.max(0, d - 0.5);
      const g8 = Math.round(255 * Math.min(1, sd / seaR));
      // Past the coast the proximity ramp stays at 1 for a texel or two, so it doesn't sag at the tile's edge.
      field[o] = d <= 2 ? 255 : 0;
      field[o + 1] = g8;
      seaDist[i] = g8;
      const nv = ids[near[i]];
      field[o + 2] = sd < nearR && nv !== DECOR ? nv : 0;
      field[o + 3] = 0;
    }
  }
  const fieldTex = new THREE.DataTexture(field, fieldW, fieldH, THREE.RGBAFormat, THREE.UnsignedByteType);
  fieldTex.magFilter = THREE.LinearFilter;
  fieldTex.minFilter = THREE.LinearFilter;
  fieldTex.generateMipmaps = false;
  fieldTex.flipY = false;
  fieldTex.needsUpdate = true;
  await yieldFrame();

  // --- printed continents (_claude/v3/PLAN.md §2) -------------------------------------------------------
  // Each continent is a printed region: its own land plus a halo of sea CONT_HALO units out from its coasts
  // (so its islands sit inside it), faintly tinted, bounded by one heavy line. Where two halos meet (a
  // strait) and where two continents share a land border, the line is the boundary between them.
  // `cont` RGBA at field resolution: R = distance to the nearest outline (0 → 1 over CONT_DR units; linear, so
  // the shaders draw a smooth line of any weight), G = the continent this texel belongs to (land or halo;
  // 255 = open sea), B = the continent the nearest outline belongs to (a held one takes its holder's ink).
  const contTex = await buildContinents(ids, fieldW, fieldH, sF, contOf, DECOR);
  // [place v5] front lines (PROPOSAL §4 B): `cont` A = the territory across the nearest land border (0 = none:
  // a coast, or deeper inland than FRONT_REACH). The tile shaders compare its owner with their own, so a border
  // between two seats draws as the split Medium stroke (ink A) and one inside a seat's land stays the hairline.
  {
    const cd = contTex.image.data as Uint8Array;
    const reach = 1.0 * sF;
    const landId = (j: number) => {
      const v = ids[j];
      return v && v !== DECOR ? v : 0;
    };
    for (let y = 0; y < fieldH; y++)
      for (let x = 0; x < fieldW; x++) {
        const i = y * fieldW + x;
        const v = landId(i);
        let nb = 0;
        if (v && dist[i] <= reach) {
          const f = near[i];
          const fv = landId(f);
          if (fv && fv !== v) nb = fv;
          else {
            const fx = f % fieldW;
            const fy = (f - fx) / fieldW;
            const cand = [fx > 0 ? f - 1 : -1, fx < fieldW - 1 ? f + 1 : -1, fy > 0 ? f - fieldW : -1, fy < fieldH - 1 ? f + fieldW : -1];
            for (const j of cand) {
              const w = j >= 0 ? landId(j) : 0;
              if (w && w !== fv) {
                nb = w;
                break;
              }
            }
          }
        }
        cd[i * 4 + 3] = nb;
      }
    contTex.needsUpdate = true;
  }

  // --- ink canvas -------------------------------------------------------------------------------------
  const s = inkW / BW;
  const canvas = document.createElement('canvas');
  canvas.width = inkW;
  canvas.height = inkH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const px = (p: Vec2): [number, number] => [p[0] * s, (BH - p[1]) * s];
  const inkData = new Uint8Array(inkW * inkH * 4);
  const grab = (ch: number) => {
    const img = ctx.getImageData(0, 0, inkW, inkH).data;
    // canvas row 0 = north; the texture's v = 1 − by/H, so row 0 stays row 0 (flipY off).
    for (let i = 0, j = ch; i < img.length; i += 4, j += 4) inkData[j] = img[i];
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, inkW, inkH);
  };
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, inkW, inkH);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // Classify each ring edge: interior (shared with another territory) or coast.
  const key = (p: Vec2) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
  const owners = new Map<string, number[]>();
  TERRITORY_IDS.forEach((t, i) => {
    for (const p of g.territories[t].polygons)
      for (const ring of [p.outer, ...p.holes])
        for (const v of ring) {
          const k = key(v);
          const l = owners.get(k);
          if (!l) owners.set(k, [i]);
          else if (!l.includes(i)) l.push(i);
        }
  });
  type Run = { pts: Vec2[]; closed: boolean };
  const coastRuns: Run[] = [];
  const borderRuns: Run[] = [];
  TERRITORY_IDS.forEach((t, ti) => {
    for (const p of g.territories[t].polygons)
      for (const ring of [p.outer, ...p.holes]) {
        const m = ring.length;
        // edge i: ring[i] → ring[i+1]; its neighbour (−1 = coast)
        const nb = new Int32Array(m);
        for (let i = 0; i < m; i++) {
          const a = owners.get(key(ring[i]))!;
          const b = owners.get(key(ring[(i + 1) % m]))!;
          let n = -1;
          for (const x of a) if (x !== ti && b.includes(x)) n = x;
          nb[i] = n;
        }
        let allSame = true;
        for (let i = 1; i < m; i++) if (nb[i] !== nb[0]) allSame = false;
        if (allSame) {
          if (nb[0] < 0) coastRuns.push({ pts: ring.slice(), closed: true });
          else if (ti < nb[0]) borderRuns.push({ pts: ring.slice(), closed: true });
          continue;
        }
        // start at an edge-class change
        let st = 0;
        for (let i = 0; i < m; i++)
          if (nb[i] !== nb[(i - 1 + m) % m]) {
            st = i;
            break;
          }
        let cur: Vec2[] = [ring[st]];
        let cls = nb[st];
        for (let q = 0; q < m; q++) {
          const i = (st + q) % m;
          if (nb[i] !== cls) {
            if (cls < 0) coastRuns.push({ pts: cur, closed: false });
            else if (ti < cls) borderRuns.push({ pts: cur, closed: false });
            cur = [ring[i]];
            cls = nb[i];
          }
          cur.push(ring[(i + 1) % m]);
        }
        if (cls < 0) coastRuns.push({ pts: cur, closed: false });
        else if (ti < cls) borderRuns.push({ pts: cur, closed: false });
      }
  });
  const flatOf = (pts: Vec2[]) => {
    const f: number[] = [];
    for (const p of pts) {
      const [x, y] = px(p);
      f.push(x, y);
    }
    return f;
  };
  // Island specks: a stroke wider than the island scribbles; their brush is finer.
  const ringLen = (pts: Vec2[]) => {
    let l = 0;
    for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return l;
  };
  const u = s; // px per board unit
  const spacing = opt.small ? 1.1 : 1.6;

  // v4 edge ladder (PLAN E2): four weights, one brush. The weights are CSS px at the 1440×900 home view
  // (EDGE_REF_PPU px a board unit); every stroke takes the same streak brush, the same jitter and dryness relative
  // to its width, and the shaders lay the same pen pressure (brushJit) over all four. v3's soft 0.34-unit
  // underlayer under the coasts (a second, glowing language) is gone: the coast glow is this stroke's own bloom.
  let seed = 1;
  const streakMs = Math.round(performance.now() - t0);
  const sb: StreakBrush | null = streakBrush;
  const streaked = !!sb;
  const oneBrush = (r: { pts: Vec2[]; closed: boolean }, width: number, passes: number, dry = 0.5, taper = 0) => {
    const sdn = seed++;
    dryBrush(ctx, flatOf(r.pts), r.closed, {
      width,
      passes,
      alpha: 0.62,
      jitter: width * 0.15,
      dry,
      seed: sdn,
      spacing,
      endTaper: taper,
      streak: sb ? streakFor(sb, sdn, width, spacing) : undefined,
    });
  };
  // R: coasts, the Heavy weight (an island speck a little finer, or its stroke scribbles over it). v4 round 2: a
  // brush, not an outline: drier bristles (more breaks along the stroke) and an open run's ends lift off (taper
  // over ~2.5 widths), so the line breaks where one coast run meets the next.
  for (const r of coastRuns) {
    const small = r.closed && ringLen(r.pts) < 3;
    const w = (small ? 0.75 : 1) * EDGE_PX.heavy * (u / EDGE_REF_PPU);
    oneBrush(r, w, small ? 6 : 10, small ? 0.3 : 0.66, r.closed ? 0 : w * 2.5);
  }
  grab(0);
  await yieldFrame();

  // G: interior borders, the Light weight (the shaders draw them in the paper's deep tone).
  const borderSeed = seed;
  for (const r of borderRuns) oneBrush(r, EDGE_PX.light * (u / EDGE_REF_PPU), 6);
  grab(1);
  await yieldFrame();
  // [place v5] A: the same interior borders at the Medium weight, the same brush and seeds (so the same breaks
  // along the line): a front line (two seats meeting) draws from this, each tile its own half in its pigment.
  {
    const after = seed;
    seed = borderSeed;
    for (const r of borderRuns) oneBrush(r, EDGE_PX.medium * (u / EDGE_REF_PPU), 6);
    seed = after;
    grab(3);
    await yieldFrame();
  }

  // B: the decorative (non-playable) coasts, the Hair weight.
  for (const p of g.decorativeLand) oneBrush({ pts: p.outer, closed: true }, EDGE_PX.hair * (u / EDGE_REF_PPU), 4);
  // (The sea lanes are printed crossings of their own now: lanes.ts. B keeps the decorative coasts.)
  grab(2);
  canvas.width = canvas.height = 1;
  await yieldFrame();

  const inkTex = new THREE.DataTexture(inkData, inkW, inkH, THREE.RGBAFormat, THREE.UnsignedByteType);
  inkTex.flipY = false;
  inkTex.generateMipmaps = true;
  inkTex.minFilter = THREE.LinearMipmapLinearFilter;
  inkTex.magFilter = THREE.LinearFilter;
  inkTex.anisotropy = 8;
  inkTex.needsUpdate = true;

  // --- noise (tileable, 4 channels) -----------------------------------------------------------------
  const NS = 256;
  const nd = new Uint8Array(NS * NS * 4);
  for (let y = 0; y < NS; y++)
    for (let x = 0; x < NS; x++) {
      const uu = x / NS;
      const vv = y / NS;
      const o = (y * NS + x) * 4;
      nd[o] = Math.round(255 * fbmTile(uu, vv, 4, 4, 3, 5)); // broad clouds (mist, mottling)
      nd[o + 1] = Math.round(255 * fbmTile(uu, vv, 8, 8, 11, 4)); // medium (blotches, breath)
      nd[o + 2] = Math.round(255 * fbmTile(uu, vv, 6, 36, 23, 3)); // fibres, 6:1
      nd[o + 3] = Math.round(255 * fbmTile(uu, vv, 32, 32, 41, 2)); // fine grain
    }
  const noise = new THREE.DataTexture(nd, NS, NS, THREE.RGBAFormat, THREE.UnsignedByteType);
  noise.wrapS = noise.wrapT = THREE.RepeatWrapping;
  noise.generateMipmaps = true;
  noise.minFilter = THREE.LinearMipmapLinearFilter;
  noise.magFilter = THREE.LinearFilter;
  noise.needsUpdate = true;
  await yieldFrame();

  // --- wave strokes atlas ---------------------------------------------------------------------------
  const waveRows = 4;
  const AW = opt.small ? 512 : 1024;
  const AH = (AW / 4) * waveRows;
  const wc = document.createElement('canvas');
  wc.width = AW;
  wc.height = AH;
  const wctx = wc.getContext('2d')!;
  const rowH = AH / waveRows;
  for (let r = 0; r < waveRows; r++) {
    // a swell: two to four parallel strokes, rising left to right and curling at the crest
    const lines = 2 + (r % 3);
    const amp = rowH * (0.12 + 0.05 * hash1(r, 13));
    const rise = rowH * (0.12 + 0.08 * hash1(r, 19));
    for (let l = 0; l < lines; l++) {
      const f: number[] = [];
      const x0 = AW * (0.05 + 0.07 * l + 0.04 * hash1(r * 7 + l, 5));
      const x1 = AW * (0.95 - 0.09 * l - 0.05 * hash1(r * 5 + l, 9));
      const yc = rowH * (r + 0.58) + (l - (lines - 1) / 2) * rowH * 0.13;
      const ph = 0.1 + hash1(r * 3 + l, 17) * 0.15;
      for (let q = 0; q <= 64; q++) {
        const t = q / 64;
        const x = x0 + (x1 - x0) * t;
        const y = yc - amp * Math.sin(Math.PI * 2 * (t * 0.85 + ph)) * (0.5 + 0.5 * t) - rise * t * t;
        f.push(x, y);
      }
      const width = rowH * (0.068 - 0.008 * l);
      dryBrush(wctx, f, false, {
        width,
        passes: 7,
        alpha: 0.72,
        jitter: rowH * 0.006,
        dry: 0.55,
        seed: 900 + r * 10 + l,
        spacing: 1,
        endTaper: 1,
        thin: 0.55,
        streak: sb ? streakFor(sb, 900 + r * 10 + l, width, 1) : undefined,
      });
    }
  }
  const waves = new THREE.CanvasTexture(wc);
  waves.flipY = false;
  waves.generateMipmaps = true;
  waves.minFilter = THREE.LinearMipmapLinearFilter;
  waves.needsUpdate = true;

  // --- queries ----------------------------------------------------------------------------------------
  const seaDistance = (bx: number, by: number): number => {
    const x = Math.floor(bx * sF);
    const y = Math.floor((BH - by) * sF);
    if (x < 0 || y < 0 || x >= fieldW || y >= fieldH) return 4;
    if (ids[y * fieldW + x]) return 0;
    return (seaDist[y * fieldW + x] / 255) * 4;
  };
  const continentCentre = {} as Record<ContinentId, Vec2>;
  for (const c of CONTINENT_IDS) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const t of TERRITORY_IDS) {
      if (TERRITORIES[t].continent !== c) continue;
      const b = g.territories[t].bbox;
      x0 = Math.min(x0, b[0]);
      y0 = Math.min(y0, b[1]);
      x1 = Math.max(x1, b[2]);
      y1 = Math.max(y1, b[3]);
    }
    continentCentre[c] = [(x0 + x1) / 2, (y0 + y1) / 2];
  }

  // The paper and wash: loaded after this returns (the first frame is never held for them).
  const mapsReady: Promise<TexMaps | null> =
    ladder.level === 0
      ? Promise.resolve(null)
      : new Promise<TexMaps | null>((resolve) => {
          const go = () =>
            loadTexMaps(opt.renderer ?? null, { small: ladder.isSmall }).then((m) => {
              ladder.onMaps = (mm) => (layer.maps = mm);
              ladder.loaded(m);
              resolve(m);
            });
          // after the first frame has been painted (two rAFs: the board's first draw happens in the first)
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(go));
          else setTimeout(go, 0);
        });

  const layer: InkLayer = {
    ink: inkTex,
    field: fieldTex,
    cont: contTex,
    noise,
    waves,
    waveRows,
    inkW,
    inkH,
    fieldW,
    fieldH,
    index,
    continentIndex: (i: number) => contOf[i] ?? 255,
    seaDistance,
    continentCentre,
    buildMs: Math.round(performance.now() - t0),
    mapsReady,
    streaked,
    get quality() {
      return ladder.level;
    },
    setQuality: (level: number) => ladder.setQuality(level),
    bindShared: (u: TexUniforms) => ladder.bind(u),
    get kick() {
      return ladder.kick;
    },
    set kick(f: (() => void) | undefined) {
      ladder.kick = f;
    },
  };
  if (import.meta.env?.DEV || import.meta.env?.VITE_E2E) (layer as unknown as { streakMs: number }).streakMs = streakMs;
  return layer;
}
