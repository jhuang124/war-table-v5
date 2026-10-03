// Damped orbit/pan/zoom-to-cursor camera with clamps, a home view fitted to the HUD-free region
// (principal point shifted to that region's center), and rate-limited automatic moves.
import * as THREE from 'three';
import type { ViewportInsets } from './BoardView';
import { clamp, ease, lerp } from './anim';
import { FRAME_W } from './scene';

const DEG = Math.PI / 180;
/**
 * Home pitch: 85° (John 2026-09-30 via the lead: one medium, the pieces are painted too, so the board is seen
 * from above like a painting on the table: the steepest the rig allows). The player may tilt 70–85° and
 * turn ±10°.
 */
export const HOME_PITCH = 85;
export const PITCH_MIN = 70;
export const PITCH_MAX = 85;
export const AZ_MAX = 10;
/** Clearance between the land (and every piece) and the HUD-free region's edges, CSS px. */
export const HOME_CLEAR_PX = 12;
const BASE_FOV = 36;

interface Pose {
  tx: number;
  tz: number;
  dist: number;
  pitch: number; // deg
  az: number; // deg
}

interface AutoMove {
  from: Pose;
  to: Pose;
  t: number;
  dur: number;
  resolve: () => void;
}

export class CameraRig {
  camera: THREE.PerspectiveCamera;
  /** Home pitch (deg): HOME_PITCH; landscape phones use a little less (a shorter land, so a wider one). */
  homePitch = HOME_PITCH;
  cur: Pose = { tx: 0, tz: 0, dist: 80, pitch: HOME_PITCH, az: 0 };
  goal: Pose = { tx: 0, tz: 0, dist: 80, pitch: HOME_PITCH, az: 0 };
  home: Pose = { tx: 0, tz: 0, dist: 80, pitch: HOME_PITCH, az: 0 };
  private auto: AutoMove | null = null;
  attract = false;
  private attractT = 0;
  private attractBlend = 0;
  /** (The attract orbit is cut; kept so old callers type-check.) */
  insets: ViewportInsets = { top: 0, right: 0, bottom: 0, left: 0, trayBand: 0 };
  W = 1;
  H = 1;
  boardW: number;
  boardH: number;
  /** Degrees per second of the fastest automatic rotation so far (metrics). */
  maxAutoDegPerSec = 0;
  /** The player moved the camera (orbit / pan / zoom) and it hasn't been sent home since. */
  userMoved = false;
  onWhoosh: ((ms: number) => void) | null = null;
  private tmp = new THREE.Vector3();

  constructor(boardW: number, boardH: number) {
    this.boardW = boardW;
    this.boardH = boardH;
    this.camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 1, 600);
  }

  get moving(): boolean {
    if (this.auto || this.attract || this.fling) return true;
    const c = this.cur;
    const g = this.goal;
    return (
      Math.abs(c.tx - g.tx) > 0.01 ||
      Math.abs(c.tz - g.tz) > 0.01 ||
      Math.abs(c.dist - g.dist) > 0.01 ||
      Math.abs(c.pitch - g.pitch) > 0.02 ||
      Math.abs(c.az - g.az) > 0.02
    );
  }

  /** Progress of the running automatic move (1 when none). */
  get autoProgress(): number {
    return this.auto ? this.auto.t / this.auto.dur : 1;
  }

  get zoom(): number {
    return this.home.dist / this.cur.dist;
  }

  setSize(W: number, H: number): void {
    this.W = W;
    this.H = H;
    this.applyProjection();
    this.recomputeHome();
  }

  setInsets(i: ViewportInsets): void {
    this.insets = { ...i };
    this.applyProjection();
    this.recomputeHome();
  }

  /** Free region (HUD-free) in canvas px. */
  region(): { x0: number; y0: number; x1: number; y1: number } {
    const i = this.insets;
    let x0 = clamp(i.left, 0, this.W * 0.45);
    let x1 = clamp(this.W - i.right, this.W * 0.55, this.W);
    let y0 = clamp(i.top, 0, this.H * 0.45);
    let y1 = clamp(this.H - i.bottom, this.H * 0.5, this.H);
    if (x1 - x0 < 100) {
      x0 = 0;
      x1 = this.W;
    }
    if (y1 - y0 < 100) {
      y0 = 0;
      y1 = this.H;
    }
    return { x0, y0, x1, y1 };
  }

  private applyProjection(): void {
    const { x0, y0, x1, y1 } = this.region();
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const dx = cx - this.W / 2;
    const dy = cy - this.H / 2;
    const fullW = this.W + 2 * Math.abs(dx);
    const fullH = this.H + 2 * Math.abs(dy);
    const cam = this.camera;
    cam.aspect = fullW / fullH;
    cam.fov = (2 * Math.atan(Math.tan((BASE_FOV * DEG) / 2) * (fullH / this.H))) / DEG;
    cam.setViewOffset(fullW, fullH, fullW / 2 - cx, fullH / 2 - cy, this.W, this.H);
    cam.updateProjectionMatrix();
  }

  private place(p: Pose, cam = this.camera): void {
    const pr = p.pitch * DEG;
    const az = p.az * DEG;
    const cp = Math.cos(pr);
    cam.position.set(p.tx + p.dist * Math.sin(az) * cp, p.dist * Math.sin(pr), p.tz + p.dist * Math.cos(az) * cp);
    cam.up.set(0, 1, 0);
    cam.lookAt(p.tx, 0, p.tz);
    cam.updateMatrixWorld(true);
  }

  /**
   * Home view: the biggest board the HUD allows at HOME_PITCH, azimuth 0 (docs/SIMPLIFY.md §1, §4).
   * - The land (every territory) fills the HUD-free region between the top and bottom strips, with a
   *   small margin; it is width-bound at 16:10 and 16:9, so it spans nearly the full window width. The
   *   frame and the outer ocean may run off the canvas edges.
   * - The dice tray only shows during fights and is not reserved: the land is centred, and lifted only
   *   if a token (with its name and the tray's header line) would sit under the tray's footprint, as
   *   far as the free region's slack allows. Coastline and ocean may run under the tray.
   */
  recomputeHome(): void {
    const wasHome = this.isHome(0.02);
    this.home = this.solveAll();
    if (wasHome || !this.initialized) {
      this.cur = { ...this.home };
      this.goal = { ...this.home };
      this.initialized = true;
    }
  }

  /** The home pose for the current mode, insets and focus. */
  private solveAll(): Pose {
    let home = this.solveHome(true);
    if (this.trayKeepOut && this.trayKeepOutSoft) {
      // Phones: the tray covers much of a short screen, so keeping every piece above it would shrink the
      // whole map. Reserve it only when that costs little; otherwise pieces may sit under it (their
      // numbers hide while it shows) and the land keeps its size.
      const free = this.solveHome(false);
      if (home.dist > free.dist * 1.03) home = free;
    }
    this.fitDist = home.dist;
    if (this.mode === 'fill') home = this.solveFill(home);
    return home;
  }

  /** Re-solve home (new focus, same layout) without moving the camera; the caller eases there. */
  retarget(): void {
    this.home = this.solveAll();
  }

  /** Fill mode: favour these world x's (the current player's territories); `fallback` when empty. */
  setFocus(xs: number[], fallback: number): void {
    this.focusXs = xs.slice();
    this.focusDefault = fallback;
  }

  /** Free region's vertical span (px): below the top HUD, above the bottom HUD. */
  private freeRows(): [number, number] {
    const H = this.H;
    const ins = this.insets;
    let y0 = clamp(ins.top, 0, H * 0.45);
    let y1 = H - clamp(ins.bottom, 0, H * 0.5);
    if (ins.rects && ins.rects.length) {
      y0 = 0;
      y1 = H;
      for (const r of ins.rects) {
        if (!(r.w > 0 && r.h > 0) || r.w < this.W * 0.5) continue; // full-width bands only (the top band, the dock)
        if (r.y + r.h / 2 < H / 2) y0 = Math.max(y0, r.y + r.h);
        else y1 = Math.min(y1, r.y);
      }
    }
    return [y0, y1];
  }

  /**
   * Portrait phones (docs/MOBILE.md §1, lead follow-up): the land's height fills `fillFrac` of the free
   * rows, centred between them; east–west the view crops, centred on the focus, clamped to the board.
   */
  private solveFill(fit: Pose): Pose {
    const [y0, y1] = this.freeRows();
    const want = (y1 - y0) * this.fillFrac;
    const hull = this.toWorldPts(this.landHull ?? []);
    const cam = this.camera.clone();
    const pose: Pose = { tx: 0, tz: 0, dist: fit.dist, pitch: this.homePitch, az: 0 };
    const span = (): [number, number] => {
      this.place(pose, cam);
      let a = Infinity;
      let b = -Infinity;
      for (const c of hull) {
        this.tmp.set(c[0], c[1], c[2]).project(cam);
        const py = (-this.tmp.y * 0.5 + 0.5) * this.H;
        a = Math.min(a, py);
        b = Math.max(b, py);
      }
      return [a, b];
    };
    const centre = () => {
      for (let it = 0; it < 8; it++) {
        const [a, b] = span();
        const shift = (y0 + y1) / 2 - (a + b) / 2; // px, + = move the land down
        if (Math.abs(shift) < 0.25) break;
        const u = (2 * pose.dist * Math.tan((BASE_FOV * DEG) / 2)) / this.H / Math.sin(pose.pitch * DEG);
        pose.tz -= shift * u;
      }
      const [a, b] = span();
      return b - a;
    };
    // Closer = taller land: bisect the distance for the wanted height (never farther than the fit).
    let lo = fit.dist / 8;
    let hi = fit.dist;
    if (centre() < want) {
      for (let it = 0; it < 30; it++) {
        pose.dist = (lo + hi) / 2;
        if (centre() > want) lo = pose.dist;
        else hi = pose.dist;
      }
      pose.dist = hi;
      centre();
    }
    // East–west: the window holding the most of the focus territories, centred on those it holds (so a
    // cluster sits mid-screen, not at the window's edge); none yet → the fallback (Europe / Africa).
    const [bx0, bx1, , , half] = this.edgeBounds(pose);
    let best = clamp(this.focusDefault, bx0, bx1);
    if (this.focusXs.length && bx1 > bx0) {
      let bestN = -1;
      let bestD = Infinity;
      const w = half * 0.85;
      for (let i = 0; i <= 64; i++) {
        const x = bx0 + ((bx1 - bx0) * i) / 64;
        let n = 0;
        let sum = 0;
        for (const f of this.focusXs)
          if (f >= x - w && f <= x + w) {
            n++;
            sum += f;
          }
        const d = n ? Math.abs(x - sum / n) : Infinity;
        if (n > bestN || (n === bestN && d < bestD)) {
          bestN = n;
          bestD = d;
          best = x;
        }
      }
    }
    pose.tx = best;
    return { ...pose };
  }

  /**
   * Fill mode: the look-at range that keeps the visible free region on the board (its middle row inside
   * the east / west edges; its far and near rows inside the north / south edges). Returns
   * [x0, x1, z0, z1, visible half-width].
   */
  private edgeBounds(p: Pose): [number, number, number, number, number] {
    const cam = this.camera.clone();
    this.place(p, cam);
    const [y0, y1] = this.freeRows();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const hw = this.boardW / 2;
    const hh = this.boardH / 2;
    let x0 = -hw;
    let x1 = hw;
    let half = hw;
    // East–west on the free region's middle row: perspective widens the far rows, and clamping on those
    // would keep Australia or Alaska from ever reaching the middle. (Past the chart's edge the open ocean
    // continues seamlessly, so a far corner running a little over it reads as sea.)
    const ym = (y0 + y1) / 2;
    if (this.groundAt(0, ym, a, cam) && this.groundAt(this.W, ym, b, cam)) {
      half = (b.x - a.x) / 2;
      const off = (a.x + b.x) / 2 - p.tx;
      x0 = -hw + half - off;
      x1 = hw - half - off;
      if (x0 > x1) x0 = x1 = -off;
    }
    let z0 = -hh;
    let z1 = hh + 4;
    if (this.groundAt(this.W / 2, y0, a, cam) && this.groundAt(this.W / 2, y1, c, cam)) {
      const m = 1.5;
      z0 = p.tz + (-hh - m - a.z);
      z1 = p.tz + (hh + m - c.z);
      if (z0 > z1) z0 = z1 = (z0 + z1) / 2;
    }
    return [x0, x1, z0, z1, half];
  }

  /** Convex hull of every territory outline, board coords (set once by the view). */
  landHull: [number, number][] | null = null;
  /**
   * World points bounding every piece at the home pitch (figure tops, base fronts and the count plaques
   * below them), set by the view. The home view keeps them inside the free region and clear of the tray.
   */
  pieceExtents: number[][] | null = null;
  /** The dice tray's footprint in canvas px: x span, and the top edge pieces must stay above. */
  trayKeepOut: { x0: number; x1: number; y0: number } | null = null;
  /** Compact (phone) layouts: the tray keep-out is dropped when it would cost > 10 % of the board's size. */
  trayKeepOutSoft = false;
  /** Clearance (px) between the land hull / the pieces and the viewport edges and HUD rectangles. */
  landClear = HOME_CLEAR_PX;
  pieceClear = HOME_CLEAR_PX;
  /** Clearance for the figures' tops only (null = pieceClear). Negative = may tuck under a HUD band. */
  figureClear: number | null = null;
  /** Side clearance (px) for everything, measured from the side safe areas (`safeLeft` / `safeRight`). */
  sideClear = HOME_CLEAR_PX;
  safeLeft = 0;
  safeRight = 0;
  /**
   * 'fit' (default): the whole land fits the free region. 'fill' (portrait phones): the land's height
   * fills `fillFrac` of the free region's height and the view crops east–west, centred on `focusX`
   * (see setFocus); panning reveals the rest and never shows past the board's edges.
   */
  mode: 'fit' | 'fill' = 'fit';
  fillFrac = 0.88;
  /** World x of the territories the fill view should favour (the current player's), and a fallback x. */
  private focusXs: number[] = [];
  private focusDefault = 0;
  /** The whole-land fit pose, solved alongside a fill home (the zoom-out limit in fill mode). */
  private fitDist = 0;

  private toWorldPts(ring: [number, number][]): number[][] {
    // board coords (origin bottom-left, +y north) → world (x east, z south), at the tile tops
    return ring.map(([bx, by]) => [bx - this.boardW / 2, 0.55, this.boardH / 2 - by]);
  }

  private project(pts: number[][], cam: THREE.PerspectiveCamera): { x0: number; y0: number; x1: number; y1: number } {
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const c of pts) {
      this.tmp.set(c[0], c[1], c[2]).project(cam);
      const px = (this.tmp.x * 0.5 + 0.5) * this.W;
      const py = (-this.tmp.y * 0.5 + 0.5) * this.H;
      x0 = Math.min(x0, px);
      x1 = Math.max(x1, px);
      y0 = Math.min(y0, py);
      y1 = Math.max(y1, py);
    }
    return { x0, y0, x1, y1 };
  }

  /** Lowest screen y of the points inside the x span [x0, x1] (−Infinity if none). */
  private lowestIn(pts: number[][], cam: THREE.PerspectiveCamera, x0: number, x1: number): number {
    let y = -Infinity;
    for (const c of pts) {
      this.tmp.set(c[0], c[1], c[2]).project(cam);
      const px = (this.tmp.x * 0.5 + 0.5) * this.W;
      if (px < x0 || px > x1) continue;
      y = Math.max(y, (-this.tmp.y * 0.5 + 0.5) * this.H);
    }
    return y;
  }

  /**
   * Home view (docs/ROUND2.md §C): the biggest board at HOME_PITCH, azimuth 0, such that
   * - the land hull and every piece stay 12 px clear of the viewport edges and of every HUD rectangle
   *   (the floating pills and strip; without `rects`, full-width top/bottom bands of the insets), and
   * - no piece sits under the dice tray's footprint (land may run under it: it is ocean-side chrome).
   * The vertical slack left over is split evenly above and below. Everything past the land is open ocean.
   */
  private solveHome(useTray = true): Pose {
    const m = Math.max(this.landClear, this.pieceClear);
    const mL = this.landClear;
    const mP = this.pieceClear;
    // extentPoints() lists 4 points per piece, the figure's top first: figures may use their own clearance.
    const mF = this.figureClear ?? mP;
    const W = this.W;
    const H = this.H;
    const ins = this.insets;
    const xL = clamp(Math.max(ins.left, this.safeLeft), 0, W * 0.45) + this.sideClear;
    const xR = W - clamp(Math.max(ins.right, this.safeRight), 0, W * 0.45) - this.sideClear;
    const BIG = 1e6;
    type Ex = { x0: number; x1: number; y0: number; y1: number; top: boolean; piecesOnly: boolean; pad: number };
    const ex: Ex[] = [];
    if (ins.rects && ins.rects.length) {
      for (const r of ins.rects) {
        if (!(r.w > 0 && r.h > 0)) continue;
        ex.push({ x0: r.x, x1: r.x + r.w, y0: r.y, y1: r.y + r.h, top: r.y + r.h / 2 < H / 2, piecesOnly: false, pad: -1 });
      }
    } else {
      if (ins.top > 0) ex.push({ x0: -BIG, x1: BIG, y0: -BIG, y1: clamp(ins.top, 0, H * 0.45), top: true, piecesOnly: false, pad: -1 });
      if (ins.bottom > 0) ex.push({ x0: -BIG, x1: BIG, y0: H - clamp(ins.bottom, 0, H * 0.5), y1: BIG, top: false, piecesOnly: false, pad: -1 });
    }
    const k = this.trayKeepOut;
    if (k && useTray) ex.push({ x0: k.x0, x1: k.x1, y0: k.y0, y1: BIG, top: false, piecesOnly: true, pad: 0 });
    const hull = this.toWorldPts(
      this.landHull ?? [
        [0, 0],
        [this.boardW, 0],
        [this.boardW, this.boardH],
        [0, this.boardH],
      ],
    );
    const pieces = this.pieceExtents ?? [];
    const nh = hull.length;
    const all = hull.concat(pieces);
    const sx = new Float64Array(all.length);
    const sy = new Float64Array(all.length);
    const cam = this.camera.clone();
    const pose: Pose = { tx: 0, tz: 0, dist: 90, pitch: this.homePitch, az: 0 };
    const pr = this.homePitch * DEG;
    const upp = (dist: number) => (2 * dist * Math.tan((BASE_FOV * DEG) / 2)) / H / Math.sin(pr);
    const evaluate = () => {
      this.place(pose, cam);
      let xOk = true;
      let sTop = Infinity;
      let sBot = Infinity;
      for (let i = 0; i < all.length; i++) {
        const c = all[i];
        this.tmp.set(c[0], c[1], c[2]).project(cam);
        const px = (this.tmp.x * 0.5 + 0.5) * W;
        const py = (-this.tmp.y * 0.5 + 0.5) * H;
        sx[i] = px;
        sy[i] = py;
        const mi = i < nh ? mL : (i - nh) % 4 === 0 ? mF : mP;
        if (px < xL - 0.5 || px > xR + 0.5) xOk = false;
        sTop = Math.min(sTop, py - mi);
        sBot = Math.min(sBot, H - mi - py);
      }
      for (const r of ex) {
        for (let i = r.piecesOnly ? nh : 0; i < all.length; i++) {
          const px = sx[i];
          const pad = r.pad < 0 ? (i < nh ? mL : (i - nh) % 4 === 0 ? mF : mP) : r.pad;
          if (px < r.x0 - pad || px > r.x1 + pad) continue;
          if (r.top) sTop = Math.min(sTop, sy[i] - (r.y1 + pad));
          else sBot = Math.min(sBot, r.y0 - pad - sy[i]);
        }
      }
      return { xOk, sTop, sBot };
    };
    // Place the pose at `dist`, the slack split evenly above and below; false if it can't fit.
    const fitAt = (dist: number): boolean => {
      pose.dist = dist;
      pose.tz = 0;
      const u = upp(dist);
      let e = evaluate();
      for (let it = 0; it < 6; it++) {
        const shift = (e.sBot - e.sTop) / 2; // px, + = move the land down
        if (Math.abs(shift) < 0.25) break;
        pose.tz -= shift * u;
        e = evaluate();
      }
      return e.xOk && e.sTop >= -0.5 && e.sBot >= -0.5;
    };
    // Largest board that fits: bisect the distance (feasibility is monotone in it).
    let lo = 20;
    let hi = 400;
    for (let it = 0; it < 40 && !fitAt(hi); it++) hi *= 1.5;
    for (let it = 0; it < 32; it++) {
      const mid = (lo + hi) / 2;
      if (fitAt(mid)) hi = mid;
      else lo = mid;
    }
    fitAt(hi);
    return { ...pose };
  }
  /** Fraction of the canvas the land hull covers at the home pose (for the framing report). */
  homeLandBox(): { x0: number; y0: number; x1: number; y1: number } {
    const cam = this.homeCamera();
    return this.project(this.toWorldPts(this.landHull ?? []), cam);
  }
  private initialized = false;

  /** A camera parked at the home pose (for layout that is decided at the home view). */
  homeCamera(): THREE.PerspectiveCamera {
    const cam = this.camera.clone();
    this.place(this.home, cam);
    return cam;
  }

  /** The player has orbited / panned / zoomed away from home (drives the HUD's `Reset view` pill). */
  get displaced(): boolean {
    return this.userMoved && !this.attract && !this.isHome(0.035, 1.5);
  }

  isHome(tol = 0.1, angTol = 5): boolean {
    const c = this.goal;
    const h = this.home;
    return (
      Math.abs(c.dist / h.dist - 1) <= tol &&
      Math.hypot(c.tx - h.tx, c.tz - h.tz) <= tol * this.boardH &&
      Math.abs(c.pitch - h.pitch) <= angTol &&
      Math.abs(c.az - h.az) <= angTol
    );
  }

  // --- user input ---------------------------------------------------------

  orbit(dxPx: number, dyPx: number): void {
    this.cancelAuto();
    this.userMoved = true;
    this.goal.az = clamp(this.goal.az - dxPx * 0.08, -AZ_MAX, AZ_MAX);
    this.goal.pitch = clamp(this.goal.pitch + dyPx * 0.08, PITCH_MIN, PITCH_MAX);
  }

  /** Ground point under a canvas pixel at the given pose (or current camera). */
  groundAt(px: number, py: number, out: THREE.Vector3, cam = this.camera): boolean {
    const ndc = new THREE.Vector2((px / this.W) * 2 - 1, -(py / this.H) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, cam);
    const t = -ray.ray.origin.y / ray.ray.direction.y;
    if (!(t > 0)) return false;
    out.copy(ray.ray.origin).addScaledVector(ray.ray.direction, t);
    return true;
  }

  pan(fromPx: [number, number], toPx: [number, number]): void {
    this.cancelAuto();
    this.userMoved = true;
    const cam = this.camera.clone();
    this.place(this.goal, cam);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    if (!this.groundAt(fromPx[0], fromPx[1], a, cam) || !this.groundAt(toPx[0], toPx[1], b, cam)) return;
    this.goal.tx -= b.x - a.x;
    this.goal.tz -= b.z - a.z;
    this.clampPan(this.goal);
  }

  zoomAt(px: number, py: number, deltaY: number): void {
    this.cancelAuto();
    this.userMoved = true;
    const f = Math.exp(-deltaY * 0.0016);
    const [minD, maxD] = this.distLimits();
    const nd = clamp(this.goal.dist / f, minD, maxD);
    const cam = this.camera.clone();
    this.place(this.goal, cam);
    const p = new THREE.Vector3();
    if (this.groundAt(px, py, p, cam)) {
      const k = nd / this.goal.dist;
      this.goal.tx = p.x + (this.goal.tx - p.x) * k;
      this.goal.tz = p.z + (this.goal.tz - p.z) * k;
    }
    this.goal.dist = nd;
    this.clampPan(this.goal);
  }

  /** Closest / farthest camera distance the player may zoom to (3.5× in by default; phones allow more). */
  zoomInMax = 3.5;
  private distLimits(): [number, number] {
    // Fill mode: zooming out stops at the whole-land fit (beyond it there's only ocean past the edges).
    if (this.mode === 'fill') return [this.home.dist / this.zoomInMax, Math.max(this.home.dist, this.fitDist)];
    return [this.home.dist / this.zoomInMax, this.home.dist / 0.9];
  }

  // --- touch (docs/MOBILE.md §3) ---------------------------------------------------
  // One finger pans, two pinch-zoom about their midpoint. While a finger is down the view is finger-locked
  // (cur = goal, no damping). Past the pan / zoom limits the view rubber-bands (soft clamps); on release it
  // springs back through the ordinary damping, or coasts (momentum) if it was thrown inside the limits.

  /** Finger-locked: cur follows goal 1:1 (a finger is down, or a fling is coasting). */
  private direct = false;
  /** Unclamped touch pose: `goal` is its rubber-banded image. */
  private raw = { tx: 0, tz: 0, ld: 0 };
  private hist: { t: number; dx: number; dz: number; dl: number; px: number; py: number }[] = [];
  private fling: { vx: number; vz: number; vl: number; px: number; py: number } | null = null;
  private touchLive = false;

  private panBounds(p: Pose = this.goal): [number, number, number, number] {
    if (this.mode === 'fill') {
      const [x0, x1, z0, z1] = this.edgeBounds(p);
      return [x0, x1, z0, z1];
    }
    return [-this.boardW / 2, this.boardW / 2, -this.boardH / 2, this.boardH / 2 + 4];
  }
  /** iOS-style rubber band: identity inside [lo, hi], an asymptote `c` past either end. */
  private static rubber(x: number, lo: number, hi: number, c: number): number {
    if (x < lo) return lo - c * (1 - 1 / ((lo - x) / c + 1));
    if (x > hi) return hi + c * (1 - 1 / ((x - hi) / c + 1));
    return x;
  }
  private applyRaw(): void {
    const [minD, maxD] = this.distLimits();
    this.goal.dist = Math.exp(CameraRig.rubber(this.raw.ld, Math.log(minD), Math.log(maxD), 0.22));
    // (Fill mode's limits depend on the distance: solve them at the new one.)
    const [x0, x1, z0, z1] = this.panBounds();
    const c = this.boardH * 0.12;
    this.goal.tx = CameraRig.rubber(this.raw.tx, x0, x1, c);
    this.goal.tz = CameraRig.rubber(this.raw.tz, z0, z1, c);
  }

  /** A touch gesture (pan / pinch) starts: catch the view where it is and lock it to the fingers. */
  touchBegin(): void {
    this.cancelAuto();
    this.fling = null;
    this.goal = { ...this.cur };
    this.raw = { tx: this.goal.tx, tz: this.goal.tz, ld: Math.log(this.goal.dist) };
    this.direct = true;
    this.touchLive = true;
    this.hist.length = 0;
  }
  /** Gesture history for the release velocity: pure pan (dx, dz) and pure zoom (dl) steps, kept apart. */
  private record(px: number, py: number, dx: number, dz: number, dl: number): void {
    const t = performance.now();
    this.hist.push({ t, dx, dz, dl, px, py });
    while (this.hist.length > 2 && t - this.hist[0].t > 120) this.hist.shift();
  }

  /** One-finger pan: the ground point under `fromPx` follows the finger to `toPx` (canvas px). */
  touchPan(fromPx: [number, number], toPx: [number, number]): void {
    if (!this.touchLive) this.touchBegin();
    this.userMoved = true;
    const cam = this.camera.clone();
    this.place(this.goal, cam);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    if (!this.groundAt(fromPx[0], fromPx[1], a, cam) || !this.groundAt(toPx[0], toPx[1], b, cam)) return;
    this.raw.tx -= b.x - a.x;
    this.raw.tz -= b.z - a.z;
    this.applyRaw();
    this.record(toPx[0], toPx[1], a.x - b.x, a.z - b.z, 0);
  }

  /** Pinch: scale the view by `factor` (> 1 = closer) about the canvas point (px, py). */
  touchZoom(px: number, py: number, factor: number): void {
    if (!this.touchLive) this.touchBegin();
    if (!(factor > 0) || Math.abs(factor - 1) < 1e-5) return;
    this.userMoved = true;
    const cam = this.camera.clone();
    this.place(this.goal, cam);
    const p = new THREE.Vector3();
    const before = this.goal.dist;
    this.raw.ld -= Math.log(factor);
    this.applyRaw();
    if (this.groundAt(px, py, p, cam)) {
      const k = this.goal.dist / before;
      this.raw.tx += p.x + (this.goal.tx - p.x) * k - this.goal.tx;
      this.raw.tz += p.z + (this.goal.tz - p.z) * k - this.goal.tz;
      this.applyRaw();
    }
    this.record(px, py, 0, 0, -Math.log(factor));
  }

  /** The last finger lifted: coast (momentum) if thrown inside the limits, else spring back. */
  touchEnd(): void {
    if (!this.touchLive) return;
    this.touchLive = false;
    const [x0, x1, z0, z1] = this.panBounds();
    const [minD, maxD] = this.distLimits();
    const g = this.goal;
    const outside = g.tx < x0 || g.tx > x1 || g.tz < z0 || g.tz > z1 || g.dist < minD * 0.999 || g.dist > maxD * 1.001;
    const h = this.hist;
    const now = performance.now();
    let fl: typeof this.fling = null;
    if (!outside && h.length >= 2 && now - h[h.length - 1].t < 80) {
      const a = h[0];
      const b = h[h.length - 1];
      const dt = Math.max(16, b.t - a.t) / 1000;
      let sx = 0;
      let sz = 0;
      let sl = 0;
      for (let i = 1; i < h.length; i++) {
        sx += h[i].dx;
        sz += h[i].dz;
        sl += h[i].dl;
      }
      const vx = sx / dt;
      const vz = sz / dt;
      // A pinch coasts a little (half its release rate, capped), a pan the full throw.
      const vl = clamp((sl / dt) * 0.4, -2, 2);
      // In board units / s: coast only a real throw (≥ ~4 % of the board width per second).
      const fast = Math.hypot(vx, vz) > this.boardW * 0.04;
      if (fast || Math.abs(vl) > 0.3) fl = { vx: fast ? vx : 0, vz: fast ? vz : 0, vl: Math.abs(vl) > 0.3 ? vl : 0, px: b.px, py: b.py };
    }
    // Hard limits: anything past them springs back through the damping; an over-pinch settles about the
    // pinch point, so what was under the fingers stays there.
    const last = h[h.length - 1];
    const nd = clamp(g.dist, minD, maxD);
    if (nd !== g.dist && last) {
      const cam = this.camera.clone();
      this.place(g, cam);
      const p = new THREE.Vector3();
      if (this.groundAt(last.px, last.py, p, cam)) {
        const k = nd / g.dist;
        g.tx = p.x + (g.tx - p.x) * k;
        g.tz = p.z + (g.tz - p.z) * k;
      }
      g.dist = nd;
    }
    this.hist.length = 0;
    g.dist = clamp(g.dist, minD, maxD);
    const [bx0, bx1, bz0, bz1] = this.panBounds();
    g.tx = clamp(g.tx, bx0, bx1);
    g.tz = clamp(g.tz, bz0, bz1);
    void x0;
    void x1;
    void z0;
    void z1;
    this.fling = fl;
    this.direct = !!fl;
  }

  /** A touch gesture was cancelled by the system: spring back inside the limits, no coast. */
  touchCancel(): void {
    this.hist.length = 0;
    this.touchEnd();
    this.fling = null;
    this.direct = false;
  }

  private stepFling(dt: number): void {
    const f = this.fling!;
    const s = dt / 1000;
    const g = this.goal;
    const [minD, maxD] = this.distLimits();
    if (f.vl) {
      const cam = this.camera.clone();
      this.place(g, cam);
      const p = new THREE.Vector3();
      const nd = clamp(g.dist * Math.exp(f.vl * s), minD, maxD);
      if (this.groundAt(f.px, f.py, p, cam)) {
        const k = nd / g.dist;
        g.tx = p.x + (g.tx - p.x) * k;
        g.tz = p.z + (g.tz - p.z) * k;
      }
      if (nd <= minD || nd >= maxD) f.vl = 0;
      g.dist = nd;
    }
    g.tx += f.vx * s;
    g.tz += f.vz * s;
    const [x0, x1, z0, z1] = this.panBounds();
    if (g.tx < x0 || g.tx > x1) {
      g.tx = clamp(g.tx, x0, x1);
      f.vx = 0;
    }
    if (g.tz < z0 || g.tz > z1) {
      g.tz = clamp(g.tz, z0, z1);
      f.vz = 0;
    }
    // iOS-like deceleration (time constant ~325 ms for pans, quicker for zoom).
    const kp = Math.exp(-dt / 325);
    f.vx *= kp;
    f.vz *= kp;
    f.vl *= Math.exp(-dt / 200);
    if (Math.hypot(f.vx, f.vz) < this.boardW * 0.004 && Math.abs(f.vl) < 0.02) {
      this.fling = null;
      this.direct = false;
    }
  }

  private clampPan(p: Pose): void {
    if (this.mode === 'fill') {
      const [x0, x1, z0, z1] = this.edgeBounds(p);
      p.tx = clamp(p.tx, x0, x1);
      p.tz = clamp(p.tz, z0, z1);
      return;
    }
    // keep the look-at point on the board, so the board never leaves the screen
    p.tx = clamp(p.tx, -this.boardW / 2, this.boardW / 2);
    p.tz = clamp(p.tz, -this.boardH / 2, this.boardH / 2 + 4);
  }

  // --- automatic moves ------------------------------------------------------

  private cancelAuto(): void {
    this.fling = null;
    if (!this.touchLive) this.direct = false;
    if (this.auto) {
      this.goal = { ...this.cur };
      const r = this.auto.resolve;
      this.auto = null;
      r();
    }
    if (this.attract) this.setAttract(false, false);
  }

  /** Ease to a pose with the SPEC limits. Resolves on arrival. */
  moveTo(to: Pose, durationMs?: number): Promise<void> {
    // An explicit move wins over the idle orbit: update() never advances a move while the orbit runs,
    // so anything awaiting this one (the board's camera waits) would otherwise hang.
    if (this.attract) {
      this.attract = false;
      this.goal = { ...this.cur };
    }
    if (this.auto) {
      const r = this.auto.resolve;
      this.auto = null;
      r();
    }
    const from = { ...this.cur };
    const dist = Math.hypot(to.tx - from.tx, to.tz - from.tz) + Math.abs(to.dist - from.dist) * 0.5;
    let dur = durationMs ?? clamp(500 + 400 * (dist / this.boardW), 500, 900);
    const rot = Math.max(Math.abs(to.az - from.az), Math.abs(to.pitch - from.pitch));
    // easeInOutCubic peaks at 1.5× the average rate: size the move so the PEAK stays ≤ 45°/s.
    dur = Math.max(dur, (rot / 45) * 1000 * 1.5);
    if (dist < 0.05 && rot < 0.05) {
      this.goal = { ...to };
      this.cur = { ...to };
      return Promise.resolve();
    }
    this.maxAutoDegPerSec = Math.max(this.maxAutoDegPerSec, (rot / dur) * 1000 * 1.5);
    if (dist > 0.3 * this.boardW) this.onWhoosh?.(dur);
    return new Promise((resolve) => {
      this.auto = { from, to: { ...to }, t: 0, dur, resolve };
    });
  }

  goHome(durationMs?: number): Promise<void> {
    this.userMoved = false;
    return this.moveTo({ ...this.home }, durationMs);
  }

  /**
   * How far these pieces sit inside the HUD-free view at `pose`, px per side (≥ 0 = clear), by the home
   * view's rules: `pts` is 4 world points per piece, the figure's top first (tokens.extentPoints); the
   * side safe areas + sideClear, the HUD rectangles (or the top/bottom inset bands), and the land/piece/
   * figure clearances. The dice tray is not counted (it only shows during a fight). `strict`: the figures'
   * tops keep the pieces' clearance too (the home view lets them tuck under a band: `figureClear`).
   */
  pieceSlack(pts: number[][], pose: Pose, strict = false): { top: number; bot: number; left: number; right: number } {
    const W = this.W;
    const H = this.H;
    const ins = this.insets;
    const mP = this.pieceClear;
    const mF = strict ? Math.max(mP, this.figureClear ?? mP) : (this.figureClear ?? mP);
    const xL = clamp(Math.max(ins.left, this.safeLeft), 0, W * 0.45) + this.sideClear;
    const xR = W - clamp(Math.max(ins.right, this.safeRight), 0, W * 0.45) - this.sideClear;
    const BIG = 1e6;
    const ex: { x0: number; x1: number; y0: number; y1: number; top: boolean }[] = [];
    if (ins.rects && ins.rects.length) {
      for (const r of ins.rects) if (r.w > 0 && r.h > 0) ex.push({ x0: r.x, x1: r.x + r.w, y0: r.y, y1: r.y + r.h, top: r.y + r.h / 2 < H / 2 });
    } else {
      if (ins.top > 0) ex.push({ x0: -BIG, x1: BIG, y0: -BIG, y1: clamp(ins.top, 0, H * 0.45), top: true });
      if (ins.bottom > 0) ex.push({ x0: -BIG, x1: BIG, y0: H - clamp(ins.bottom, 0, H * 0.5), y1: BIG, top: false });
    }
    const cam = this.camera.clone();
    this.place(pose, cam);
    let top = Infinity;
    let bot = Infinity;
    let left = Infinity;
    let right = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const c = pts[i];
      this.tmp.set(c[0], c[1], c[2]).project(cam);
      const px = (this.tmp.x * 0.5 + 0.5) * W;
      const py = (-this.tmp.y * 0.5 + 0.5) * H;
      const m = i % 4 === 0 ? mF : mP;
      top = Math.min(top, py - m);
      bot = Math.min(bot, H - m - py);
      left = Math.min(left, px - xL);
      right = Math.min(right, xR - px);
      for (const r of ex) {
        if (px < r.x0 - m || px > r.x1 + m) continue;
        if (r.top) top = Math.min(top, py - (r.y1 + m));
        else bot = Math.min(bot, r.y0 - m - py);
      }
    }
    return { top, bot, left, right };
  }

  /** These pieces (see pieceSlack) are clear of the HUD and the screen edges at `pose` (default: now). */
  piecesClear(pts: number[][], pose: Pose = this.cur, strict = false): boolean {
    const s = this.pieceSlack(pts, pose, strict);
    return s.top >= -0.5 && s.bot >= -0.5 && s.left >= -0.5 && s.right >= -0.5;
  }

  /**
   * Keep `pose` framing these pieces clear of the HUD (phones, where the free band is short): nudge it
   * so the slack is even on each axis, and if they still don't fit, zoom out (towards home) until they
   * do. Whole pieces, figure tops included: a framed fight never tucks under the HUD. Returns the adjusted
   * pose; home if even the home scale can't hold them clear.
   */
  private fitPieces(pose: Pose, pts: number[][]): Pose {
    const pr = pose.pitch * DEG;
    const tanH = Math.tan((BASE_FOV * DEG) / 2);
    const at = (dist: number): Pose => {
      const p: Pose = { ...pose, dist };
      // world units per px at the look-at point: across (x) and along the ground (z)
      const ux = (2 * dist * tanH) / this.H;
      const uz = ux / Math.sin(pr);
      for (let it = 0; it < 6; it++) {
        const s = this.pieceSlack(pts, p, true);
        const dy = (s.bot - s.top) / 2; // px, + = move the pieces down the screen
        const dx = (s.right - s.left) / 2; // px, + = move them right
        if (Math.abs(dy) < 0.25 && Math.abs(dx) < 0.25) break;
        p.tz -= dy * uz;
        p.tx -= dx * ux;
        this.clampPan(p);
      }
      return p;
    };
    const fits = (p: Pose) => this.piecesClear(pts, p, true);
    let p = at(pose.dist);
    if (fits(p)) return p;
    // The largest zoom (smallest distance) that holds them clear: bisect between this pose and home scale.
    let lo = pose.dist;
    let hi = Math.max(pose.dist, this.home.dist);
    if (!fits(at(hi))) return { ...this.home };
    for (let it = 0; it < 14; it++) {
      const mid = (lo + hi) / 2;
      if (fits(at(mid))) hi = mid;
      else lo = mid;
    }
    p = at(hi);
    return p;
  }

  /**
   * Pose that frames world-space points (keeps pitch within 8° of now, azimuth as is). `pieces` (4 world
   * points per piece, see pieceSlack): the pose also keeps those pieces clear of the HUD (phones).
   */
  framePose(points: THREE.Vector3[], minZoom = 1, maxZoom = 2.4, pieces?: number[][]): Pose {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of points) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    const pad = 4;
    const w = maxX - minX + pad * 2;
    const h = maxZ - minZ + pad * 2;
    const scale = Math.max(w / (this.boardW + 2 * FRAME_W), h / (this.boardH + 2 * FRAME_W));
    const zoom = clamp(1 / Math.max(scale, 1e-3), Math.min(minZoom, maxZoom), maxZoom);
    const pitch = clamp(this.cur.pitch, this.cur.pitch - 8, this.cur.pitch + 8);
    const pose: Pose = {
      tx: (minX + maxX) / 2,
      tz: (minZ + maxZ) / 2 + (this.home.tz * 1) / zoom,
      dist: this.home.dist / zoom,
      pitch,
      az: this.cur.az,
    };
    this.clampPan(pose);
    return pieces && pieces.length ? this.fitPieces(pose, pieces) : pose;
  }

  /** Cut (no motion) to a pose. */
  jump(p: Pose): void {
    this.cancelAuto();
    this.cur = { ...p };
    this.goal = { ...p };
  }

  /**
   * The title / victory view (docs/INK.md B §7: the attract orbit is cut): the flat painting at home. `on`
   * eases home once (unless the player has moved the view); the camera never orbits by itself.
   */
  setAttract(on: boolean, returnHome = true): void {
    this.attract = false;
    this.attractT = 0;
    this.attractBlend = 0;
    if (on && returnHome && !this.isHome(0.01, 0.5)) void this.goHome(900);
  }

  // --- per frame --------------------------------------------------------------

  update(dtMs: number): void {
    const dt = Math.min(dtMs, 50);
    if (this.auto) {
      const a = this.auto;
      a.t = Math.min(a.dur, a.t + dt);
      const e = ease.inOutCubic(a.t / a.dur);
      for (const key of ['tx', 'tz', 'dist', 'pitch', 'az'] as const) this.cur[key] = lerp(a.from[key], a.to[key], e);
      this.goal = { ...this.cur };
      if (a.t >= a.dur) {
        this.auto = null;
        a.resolve();
      }
    } else if (this.direct || this.fling) {
      if (this.fling) this.stepFling(dt);
      this.cur = { ...this.goal };
    } else {
      const k = 1 - Math.pow(1 - 0.12, dt / 16.67);
      for (const key of ['tx', 'tz', 'dist', 'pitch', 'az'] as const) {
        const d = this.goal[key] - this.cur[key];
        this.cur[key] = Math.abs(d) < 1e-4 ? this.goal[key] : this.cur[key] + d * k;
      }
    }
    // [fight v5] the fight's lean rides on top of the pose (never written into cur/goal/home)
    if (this.lean.x || this.lean.z) this.place({ ...this.cur, tx: this.cur.tx + this.lean.x, tz: this.cur.tz + this.lean.z });
    else this.place(this.cur);
  }

  // --- [fight v5] the fight's lean (PROPOSAL §4 A "anticipation") --------------------------------
  /**
   * An additive offset of the look-at point, world units, that the board eases toward a fight and back
   * (index.ts tweens it). It is never part of the pose: home, goal, `displaced` and every framing solve
   * ignore it, so a lean can't move the home view or light the Reset view pill.
   */
  lean = { x: 0, z: 0 };
  /** A copy of the live camera placed as it will be with `lean` = (dx, dz) (for predicting the leaned frame). */
  leanedCamera(dx: number, dz: number): THREE.PerspectiveCamera {
    const cam = this.camera.clone();
    this.place({ ...this.cur, tx: this.cur.tx + dx, tz: this.cur.tz + dz }, cam);
    return cam;
  }

  /** Finish an automatic move immediately. */
  finishAuto(): void {
    if (this.auto) {
      this.cur = { ...this.auto.to };
      this.goal = { ...this.auto.to };
      const r = this.auto.resolve;
      this.auto = null;
      r();
    }
  }
}

export type { Pose };
