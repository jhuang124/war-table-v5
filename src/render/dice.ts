// The battle tray (docs/INK2.md §2.3, "the ink ring"): no object on the painting, just one closed brush
// ellipse in silver ink that brushes itself onto the paper clockwise from the west, with a feathered wash
// of deep paper inside it so the dice have ground over ocean or land. Drawn in its own pass (depth cleared,
// after the board) with a pixel-mapped camera, so it sits at one fixed CSS-px spot per layout in the battle
// band.
//
// The dice are painted (v4, _claude/v4/PLAN.md §5b E5, decision Q8: one medium): flat bone faces with ink
// pips, never lit, never 3D. Each die is a brushed bone square facing the viewer with a painted shadow (a
// darker wash of the paper under it, offset lower-right like every shadow on the board: E1's one lamp, upper
// left). They pour from the cup's direction (the seats and the cup sit along the top edge, so from above),
// tumble flat (they turn in the picture plane, their faces flicking over as they go) and land with a squash,
// keyframed (no physics) onto the engine's faces. The attacker's dice carry the seat's pigment on their edge
// and pips; the defender's stay bone and ink.
//   shake → pour/tumble → land (squash) → 250 ms of stillness → the verdict: each compared pair is joined by
//   a hairline, drawn from the winner; the loser dims to half under a splash of ink.
// [fight v5] (PROPOSAL §4 A) the dice pour one at a time (`stagger`, 60–90 ms apart, pairs interleaved so a
// matched pair lands together), each touching down with its own squash and bone click; the verdict reads pair
// by pair: a GOLD hairline draws in 120 ms (the one gold moves off the board's stroke onto "what's happening
// now"), then the loser of that pair takes its ink splash and dims (`onPair`, so the board ticks that loss).
import * as THREE from 'three';
import { Animator, ease, type Run } from './anim';
import { inkRingTexture, inkSplashTexture } from './textures';
import { GOLD, hexToRgb } from './util';
import type { PlayerPalette } from '../shared/palette';
import { boardTrayGeometry, inkRingGeometry, inkTrayGeometry, inkTrayTop, INK_TRAY_MID_GAP, INK_TRAY_PAD, INK_TRAY_STEP } from '../shared/tray';
// The HUD's tray band (src/shared/tray.ts) is re-exported here; the tray actually drawn is the slimmer
// `inkTrayGeometry`, placed by `inkTrayTop` (shared with the HUD, so the fight header sits on its rim).
export { boardTrayGeometry, inkTrayGeometry };

/** Die spacing (in die edges): the gap between the two sides' inner dice, and die to die within a side. */
const MID_GAP = INK_TRAY_MID_GAP;
const STEP = INK_TRAY_STEP;
/** Padding from the outermost die to the tray's inner rim, in die edges. */
const PAD = INK_TRAY_PAD;
void PAD;

/** Bone, the dice's body (a little warmer than the ivory ink), its mottle, and the defender's ink. */
const BONE = '#e4d9c4';
const BONE_MOTTLE = '#cdbfa5';
const DIE_INK = '#151b2c';
/** The painted shadow: a darker wash of the deep paper (the stones' shadow ink), lower-right of the die. */
const SHADOW_INK = '#05080f';
const SHADOW_A = 0.5;
/** Its offset at rest, × the die's edge (screen: right and down); it opens a little while the die is in the air. */
const SHADOW_OFF = 0.075;
const PIPS: Record<number, [number, number][]> = {
  1: [[0.5, 0.5]],
  2: [
    [0.28, 0.28],
    [0.72, 0.72],
  ],
  3: [
    [0.27, 0.27],
    [0.5, 0.5],
    [0.73, 0.73],
  ],
  4: [
    [0.29, 0.29],
    [0.71, 0.29],
    [0.29, 0.71],
    [0.71, 0.71],
  ],
  5: [
    [0.28, 0.28],
    [0.72, 0.28],
    [0.5, 0.5],
    [0.28, 0.72],
    [0.72, 0.72],
  ],
  6: [
    [0.29, 0.25],
    [0.71, 0.25],
    [0.29, 0.5],
    [0.71, 0.5],
    [0.29, 0.75],
    [0.71, 0.75],
  ],
};
const h01 = (a: number, b: number, c: number) => {
  const x = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
  return x - Math.floor(x);
};
/** The die's brushed outline: a rounded square (a superellipse), a little uneven, fixed per seed. */
function dieOutline(ctx: CanvasRenderingContext2D, S: number, inset: number, seed: number): void {
  const N = 64;
  const half = S / 2 - inset;
  ctx.beginPath();
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * Math.PI * 2;
    const c = Math.cos(t);
    const sn = Math.sin(t);
    const e = 0.24;
    const w = 1 + (h01(i % N, seed, 3) - 0.5) * 0.02;
    const X = S / 2 + Math.sign(c) * Math.pow(Math.abs(c), e) * half * w;
    const Y = S / 2 + Math.sign(sn) * Math.pow(Math.abs(sn), e) * half * w;
    if (i === 0) ctx.moveTo(X, Y);
    else ctx.lineTo(X, Y);
  }
  ctx.closePath();
}
/** A painted die face: bone, a soft flat mottle, a brushed edge, ink pips. Transparent outside the die. */
function paintDieFace(value: number, edge: string, pip: string, S = 128): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d')!;
  const inset = S * 0.05;
  dieOutline(ctx, S, inset, value);
  ctx.fillStyle = BONE;
  ctx.fill();
  // the bone's mottle: a few soft, flat dabs (painted, not shaded: no gradient toward any light)
  ctx.save();
  ctx.clip();
  for (let i = 0; i < 7; i++) {
    ctx.globalAlpha = 0.1 + 0.08 * h01(i, value, 1);
    ctx.fillStyle = BONE_MOTTLE;
    ctx.beginPath();
    ctx.ellipse(S * h01(i, value, 2), S * h01(i, value, 4), S * (0.12 + 0.2 * h01(i, value, 5)), S * (0.08 + 0.12 * h01(i, value, 6)), h01(i, value, 7) * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  ctx.globalAlpha = 0.92;
  // the edge: one brushed line in the seat's pigment (attacker) or the ink (defender)
  dieOutline(ctx, S, inset + S * 0.02, value + 7);
  ctx.lineWidth = S * 0.042;
  ctx.strokeStyle = edge;
  ctx.stroke();
  ctx.globalAlpha = 1;
  const r = S * (value === 1 ? 0.115 : 0.085);
  for (const [px, py] of PIPS[value]) {
    const x = px * S;
    const y = py * S;
    ctx.beginPath();
    const n = 14;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const rr = r * (1 + (h01(i, Math.round(x * 7 + y), value) - 0.5) * 0.16);
      const X = x + Math.cos(a) * rr;
      const Y = y + Math.sin(a) * rr;
      if (i) ctx.lineTo(X, Y);
      else ctx.moveTo(X, Y);
    }
    ctx.closePath();
    ctx.fillStyle = pip;
    ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
/** The die's painted shadow: the same rounded square, flat, its edge softened by a hair (the stones' softness). */
function paintDieShadow(S = 64): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d')!;
  ctx.filter = `blur(${(S * 0.022).toFixed(2)}px)`;
  dieOutline(ctx, S, S * 0.07, 3);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

const TILT = -0.42; // tray pitch (top edge recedes)
/** The verdict's held stillness (B §4): after the dice settle, nothing moves, then the verdict. */
export const VERDICT_SILENCE_MS = 250;
/**
 * A full roll's tumble and settle (single, repeat, a blitz's final roll). 2026-09-30: the tumble slowed
 * 380 → 450; the settle stays 100 (120 measured 1249 ms against the 1250 budget in the game flow).
 */
export const DICE_TUMBLE_MS = 450;
export const DICE_SETTLE_MS = 100;
/** [fight v5] The verdict after the hush (pair hairlines + splashes): 260 → 240 for headroom under the 1.25 s budget. */
const VERDICT_MS = 240;
/** The ring brushes itself on (INK2 §2.2 t = 0): 220 ms, clockwise from the west. Reduced motion: a 150 ms fade. */
const RING_DRAW_MS = 220;
/** The ring's ink (`--coast`, silver on indigo) and the wash inside it (the deep paper). */
const RING_INK = hexToRgb('#e2ddcf');
const RING_WASH = hexToRgb('#0b1224');
/** Ring weight at home, CSS px: the brush's full width where it bears down (it breathes ~1.4–3 px). */
const RING_PX = 2.9;
/** One brush for every ring (the same hand every fight). */
const RING_SEED = 11;

const RING_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const RING_FRAG = /* glsl */ `
uniform sampler2D uRing;
uniform vec3 uInk;
uniform vec3 uWash;
uniform float uProgress;
uniform float uAlpha;
uniform float uWashA;
uniform vec2 uSize;
uniform vec2 uRad;
varying vec2 vUv;
void main() {
  vec2 q = (vUv - 0.5) * uSize / uRad;
  float r = length(q);
  // the brush travels clockwise from the west (9 o'clock): 0 → 1 round the loop
  float th = mod(3.14159265 - atan(q.y, q.x), 6.2831853) / 6.2831853;
  float rev = 1.0 - smoothstep(uProgress - 0.035, uProgress, th);
  float ring = texture2D(uRing, vUv).a * 0.38 * rev;
  // the deep-paper wash inside: 30 %, feathered over 12 px inward from the brush's centre line
  vec2 dir = r > 1e-4 ? q / r : vec2(1.0, 0.0);
  float d = (1.0 - r) * length(dir * uRad);
  float wash = smoothstep(0.0, 12.0, d) * 0.3 * uWashA;
  float a = ring + wash * (1.0 - ring);
  if (a * uAlpha < 0.003) discard;
  vec3 col = (uInk * ring + uWash * wash * (1.0 - ring)) / max(a, 1e-4);
  gl_FragColor = vec4(col, a * uAlpha);
}
`;

const HAIR_VERT = /* glsl */ `
attribute float aU;
varying float vU;
void main() {
  vU = aU;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const HAIR_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uProgress;
uniform float uOpacity;
uniform float uFromEnd;
varying float vU;
void main() {
  float u = uFromEnd > 0.5 ? 1.0 - vU : vU;
  float a = 1.0 - smoothstep(uProgress - 0.04, uProgress, u);
  a *= uOpacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
}
`;

interface Die {
  /** The painted face: a flat quad turned square to the viewer. */
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  /** Its painted shadow, lying on the paper. */
  shadow: THREE.Mesh;
  shadowMat: THREE.MeshBasicMaterial;
  splash: THREE.Mesh;
  splashMat: THREE.MeshBasicMaterial;
  side: -1 | 1; // attacker left (−1), defender right (+1)
  /** The face it lands on, and the face it shows now (it flicks over while it tumbles). */
  value: number;
  shown: number;
  faces: THREE.Texture[];
  // animated state (tray-local px; z = height off the paper)
  pos: THREE.Vector3;
  /** Its turn in the picture plane (radians) and its squash (x, y) on landing and mid-flip. */
  rot: number;
  sx: number;
  sy: number;
  bright: number;
  alpha: number;
  lift: number;
  scale: number;
  active: boolean;
  splashA: number;
}

export interface RollSpec {
  attack: number[];
  defend: number[];
  attacker: PlayerPalette;
  defender: PlayerPalette;
  /**
   * 'single' 1.18 s · 'repeat' 1.06 s (both with the 250 ms silence) · 'first' 660 ms · 'middle' (durMs) ·
   * 'final' 1.02 s (keeps the silence and the single roll's tumble) · 'static'
   */
  mode: 'single' | 'repeat' | 'first' | 'middle' | 'final' | 'static';
  durMs?: number;
  reduced: boolean;
  run: Run | null;
  onShake?: (ms: number) => void;
  /** First touch of die i (side −1 attacker / +1 defender); compressed rolls call it once. */
  onLand?: (side: -1 | 1, i: number) => void;
  /** The held breath begins (ms at 1×): the caller hushes the sound for it (INK B4 "silence"). */
  onSilence?: (ms: number) => void;
  onVerdict?: () => void;
  /**
   * [fight v5] ms between dice landing (0 / absent = together). Clamped so the pour still fits the roll's own
   * window (≤ 90; a repeat roll ~67 for five dice): the roll's length never changes.
   */
  stagger?: number;
  /**
   * [fight v5] Pair `k`'s verdict lands (full rolls: one pair after another as its gold hairline arrives; a
   * blitz's middle rolls: every pair at once). `attackerWins` = the attacker's die beat the defender's.
   */
  onPair?: (k: number, attackerWins: boolean) => void;
}

/** [fight v5] The verdict hairline draws in this long (1×), pairs a little apart (PROPOSAL §4 A). */
export const HAIR_DRAW_MS = 120;

export class DiceTray {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(20, 1, 10, 20000);
  private root = new THREE.Group();
  private tray = new THREE.Group();
  private dice: Die[] = [];
  private faceCache = new Map<string, THREE.Texture[]>();
  /** The ink ring (a quad on the tray's plane). */
  private ring: THREE.Mesh;
  private ringMat: THREE.ShaderMaterial;
  private ringKey = '';
  private shadowTex: THREE.CanvasTexture | null = null;
  private splashTex = inkSplashTexture();
  private hairs: { mesh: THREE.Mesh; mat: THREE.ShaderMaterial }[] = [];
  private opacity = 0;
  /** How far round the ring the brush has come (0 → 1.04), clockwise from the west. */
  private drawn = 0;
  private shown = false;
  private ver = 0;
  size = 64; // die size in px
  trayW = 640;
  trayH = 110;
  cx = 0;
  cy = 0;
  private W = 1;
  private H = 1;
  materials: THREE.Material[] = [];
  lingerUntil = 0;
  /** Where layout() put the tray (the band), and the fight-side spot that overrides it (v4 desktop), CSS px. */
  private bandCx = 0;
  private bandCy = 0;
  private spot: { x: number; y: number } | null = null;
  /** Test hook (v4): the last roll's wall-clock length at the speed it ran (ms) and its mode. */
  lastRoll: { mode: RollSpec['mode']; ms: number } | null = null;

  constructor(
    private anim: Animator,
    _env?: THREE.Texture,
  ) {
    // No lights (E1, one lamp expressed only as painted shadow): everything in the tray is unlit paint.
    this.scene.add(this.root);
    this.root.add(this.tray);
    this.tray.rotation.x = TILT;
    // The ring and its wash lie on the paper plane the dice land on (no floor, no rim, no lacquer).
    this.ringMat = new THREE.ShaderMaterial({
      uniforms: {
        uRing: { value: null },
        uInk: { value: new THREE.Vector3(...RING_INK) },
        uWash: { value: new THREE.Vector3(...RING_WASH) },
        uProgress: { value: 0 },
        uAlpha: { value: 0 },
        uWashA: { value: 0 },
        uSize: { value: new THREE.Vector2(1, 1) },
        uRad: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    });
    this.ring = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.ringMat);
    this.ring.renderOrder = -2;
    this.tray.add(this.ring);
    this.materials.push(this.ringMat);

    const quad = new THREE.PlaneGeometry(1, 1);
    const splashGeo = new THREE.PlaneGeometry(0.9, 0.9);
    if (typeof document !== 'undefined') this.shadowTex = paintDieShadow();
    for (let i = 0; i < 5; i++) {
      const flat = { transparent: true, depthWrite: false, depthTest: false, toneMapped: false } as const;
      const mat = new THREE.MeshBasicMaterial({ ...flat, opacity: 0 });
      const mesh = new THREE.Mesh(quad, mat);
      mesh.renderOrder = 2 + i;
      const shadowMat = new THREE.MeshBasicMaterial({ ...flat, color: SHADOW_INK, alphaMap: this.shadowTex, opacity: 0 });
      const shadow = new THREE.Mesh(quad, shadowMat);
      shadow.renderOrder = -1;
      shadow.visible = false;
      const splashMat = new THREE.MeshBasicMaterial({ ...flat, map: this.splashTex, opacity: 0 });
      const splash = new THREE.Mesh(splashGeo, splashMat);
      splash.position.z = 0.01;
      splash.renderOrder = 8 + i;
      mesh.add(splash);
      mesh.visible = false;
      this.tray.add(shadow, mesh);
      this.materials.push(mat, shadowMat, splashMat);
      this.dice.push({
        mesh,
        mat,
        shadow,
        shadowMat,
        splash,
        splashMat,
        side: i < 3 ? -1 : 1,
        value: 1,
        shown: 1,
        faces: [],
        pos: new THREE.Vector3(),
        rot: 0,
        sx: 1,
        sy: 1,
        bright: 1,
        alpha: 1,
        lift: 0,
        scale: 1,
        active: false,
        splashA: 0,
      });
    }
    // the verdict's hairlines (one per compared pair)
    for (let i = 0; i < 3; i++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(GOLD) },
          uProgress: { value: 0 },
          uOpacity: { value: 0 },
          uFromEnd: { value: 0 },
        },
        vertexShader: HAIR_VERT,
        fragmentShader: HAIR_FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
      mesh.visible = false;
      mesh.renderOrder = 15;
      this.tray.add(mesh);
      this.hairs.push({ mesh, mat });
      this.materials.push(mat);
    }
    this.root.visible = false;
  }

  get visible(): boolean {
    return this.root.visible;
  }
  /** Shown and not fading out. */
  get showing(): boolean {
    return this.shown;
  }

  /** Place the tray: band top y, band height, viewport, die size. All CSS px. */
  layout(W: number, H: number, bandTop: number, bandH: number, uiScale: number): void {
    this.W = W;
    this.H = H;
    // Shared with the HUD's battle band (src/shared/tray.ts), so the text strips always clear the tray.
    const { trayW, die: s, trayH } = inkTrayGeometry(W, H, bandH, uiScale);
    const changed = Math.abs(trayW - this.trayW) > 0.5 || Math.abs(trayH - this.trayH) > 0.5 || Math.abs(s - this.size) > 0.5;
    this.size = s;
    this.trayW = trayW;
    this.trayH = trayH;
    this.cx = W / 2;
    // Placed by the shared rule (the HUD's header sits just above this top), so the header rests on the
    // ring. One fixed spot per layout: the ring's translucent wash keeps anything under it readable.
    this.cy = bandTop + bandH - inkTrayTop(W, H, bandH, uiScale) + trayH / 2;
    this.bandCx = this.cx;
    this.bandCy = this.cy;
    if (this.spot) {
      this.cx = this.spot.x;
      this.cy = this.spot.y;
    }
    const fov = 20;
    this.camera.fov = fov;
    this.camera.aspect = W / H;
    const D = H / 2 / Math.tan((fov * Math.PI) / 360);
    this.camera.near = D * 0.2;
    this.camera.far = D * 3;
    this.camera.position.set(0, 0, D);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
    this.place();
    this.buildRing(W, H, bandH, uiScale, changed);
    for (const d of this.dice) if (d.active) this.applyDie(d);
  }

  /**
   * v4 (desktop, the home view no longer keeps a southern band for the tray): lay the ring at (x, y) CSS px,
   * beside the fight; null puts it back where layout() placed it (the band, phones).
   */
  moveTo(spot: { x: number; y: number } | null): void {
    this.spot = spot ? { ...spot } : null;
    this.cx = spot ? spot.x : this.bandCx;
    this.cy = spot ? spot.y : this.bandCy;
    this.place();
  }
  /** The fight-side spot in use, or null (the band). */
  get placedAt(): { x: number; y: number } | null {
    return this.spot;
  }

  /** Tray centre in world = pixel-mapped at z = 0. */
  private place(): void {
    this.root.position.set(this.cx - this.W / 2, this.H / 2 - this.cy, 0);
  }

  /**
   * The ring for this size (INK2 §2.3): its centre line is the ellipse inscribed in the tray box with a 6 %
   * overshoot on the long axis, weight ~RING_PX at its heaviest. The quad carries the brush's margin; the
   * canvas is rasterised once per size (textures.ts caches it).
   */
  private buildRing(W: number, H: number, bandH: number, uiScale: number, changed: boolean): void {
    const { rx, ry } = inkRingGeometry(W, H, bandH, uiScale);
    // brushRing's viewBox is 100 tall; its centre line sits (1.6·Wmax + 3) units inside the box, and the
    // weight scales with the box. Solve for the px weight (a few fixed-point steps converge).
    let wmax = 3;
    let s = 1;
    for (let i = 0; i < 5; i++) {
      s = ry / (50 - wmax * 1.6 - 3);
      wmax = RING_PX / s;
    }
    const m = wmax * 1.6 + 3;
    const aspect = (2 * (rx / s + m)) / 100;
    const qw = 100 * aspect * s;
    const qh = 100 * s;
    const dpr = Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
    const cw = Math.min(2048, Math.round(qw * dpr));
    const ch = Math.min(512, Math.round(qh * dpr));
    const key = `${cw}x${ch}|${aspect.toFixed(3)}`;
    if (key === this.ringKey && !changed) return;
    this.ringKey = key;
    this.ringMat.uniforms.uRing.value = inkRingTexture(RING_SEED, aspect, cw, ch, wmax / 5.2, 5);
    (this.ringMat.uniforms.uSize.value as THREE.Vector2).set(qw, qh);
    (this.ringMat.uniforms.uRad.value as THREE.Vector2).set(rx, ry);
    // On the tilted paper plane: stretched along its depth so it projects to the box's height.
    const k = 1 / Math.cos(TILT);
    this.ring.scale.set(qw, qh * k, 1);
  }

  /** The six painted faces for a side: the attacker's take its seat's pigment on the edge and pips. */
  private faces(p: PlayerPalette, attacker: boolean): THREE.Texture[] {
    const key = attacker ? `a:${p.id}` : 'd';
    let f = this.faceCache.get(key);
    if (!f) {
      f = [1, 2, 3, 4, 5, 6].map((v) => (attacker ? paintDieFace(v, p.base, p.deep) : paintDieFace(v, DIE_INK, DIE_INK)));
      this.faceCache.set(key, f);
    }
    return f;
  }

  private slotX(side: -1 | 1, i: number): number {
    const s = this.size;
    return side * (MID_GAP * s + s / 2 + i * s * STEP);
  }

  private applyDie(d: Die): void {
    const s = this.size * d.scale;
    const on = d.active && d.alpha > 0.005;
    d.mesh.visible = on;
    d.shadow.visible = on;
    if (!on) return;
    // The face stands square to the viewer above its spot on the (pitched) paper; z = its height off it.
    const y = d.pos.y + d.lift;
    d.mesh.position.set(d.pos.x, y, d.pos.z + s * 0.5 * Math.sin(-TILT));
    d.mesh.rotation.set(-TILT, 0, 0);
    d.mesh.rotateZ(d.rot);
    d.mesh.scale.set(s * d.sx, s * d.sy, 1);
    const tex = d.faces[d.shown - 1] ?? null;
    if (d.mat.map !== tex) {
      d.mat.map = tex;
      d.mat.needsUpdate = true;
    }
    const b = d.bright;
    d.mat.color.setRGB(b, b, b, THREE.SRGBColorSpace);
    d.mat.opacity = d.alpha * this.opacity;
    d.splashMat.opacity = d.splashA * 0.6 * this.opacity;
    d.splash.visible = d.splashA > 0.01;
    // The painted shadow: lower-right of the die (one lamp, upper left), on the paper; it opens a little
    // and pales as the die is lifted, never blurs further (the same softness at every height).
    const h = Math.max(0, d.pos.z) / Math.max(1, this.size);
    const off = s * (SHADOW_OFF + 0.18 * Math.min(1, h));
    d.shadow.position.set(d.pos.x + off, y - off * 1.25, 0.02);
    d.shadow.rotation.set(0, 0, d.rot);
    d.shadow.scale.set(s * d.sx * 1.02, s * d.sy * 1.02 / Math.cos(TILT), 1);
    d.shadowMat.opacity = SHADOW_A * d.alpha * this.opacity * (1 - 0.55 * Math.min(1, h));
  }

  private setFade(v: number): void {
    this.opacity = v;
    this.ringMat.uniforms.uAlpha.value = v;
    for (const d of this.dice) this.applyDie(d);
    for (const h of this.hairs) h.mat.uniforms.uOpacity.value = Math.min(h.mat.uniforms.uOpacity.value, v * 0.8);
    this.root.visible = v > 0.002;
  }

  private setDrawn(v: number): void {
    this.drawn = v;
    this.ringMat.uniforms.uProgress.value = v;
    this.ringMat.uniforms.uWashA.value = Math.min(1, v * 1.15);
  }

  /**
   * The ring brushes itself onto the paper clockwise from the west (220 ms, brush easing) and the wash
   * inside fades in with it. Already up (a repeat roll, a blitz): it stays. Reduced motion: a 150 ms fade.
   */
  show(reduced = false): void {
    this.lingerUntil = 0;
    if (this.shown && this.opacity >= 1 && this.drawn >= 1) return;
    this.shown = true;
    const ver = ++this.ver;
    const from = this.opacity;
    this.root.visible = true;
    if (this.anim.instant) {
      this.setDrawn(1.04);
      this.setFade(1);
      return;
    }
    // Still on the paper (drying out, or up): it comes back whole; only a dry ring is drawn again.
    const redraw = this.drawn < 1 || from <= 0.002;
    if (redraw && !reduced) this.setDrawn(0);
    else this.setDrawn(1.04);
    const brush = (t: number) => 1 - Math.pow(1 - t, 2.4);
    this.anim.tween({
      ms: redraw && !reduced ? RING_DRAW_MS : 150,
      unscaled: true,
      ease: ease.linear,
      update: (v) => {
        if (ver !== this.ver) return;
        if (redraw && !reduced) {
          this.setDrawn(brush(v) * 1.04);
          // the dice (and their shadows) are there from the first frame of the shake
          this.setFade(from + (1 - from) * Math.min(1, v * 4));
        } else this.setFade(from + (1 - from) * ease.outQuad(v));
      },
    });
  }

  /** It dries out: alpha only (the ring, its wash and the dice together). */
  hide(ms = 200): void {
    this.lingerUntil = 0;
    if (!this.shown && this.opacity <= 0) return;
    this.shown = false;
    const ver = ++this.ver;
    const from = this.opacity;
    this.onHide?.(ms);
    this.anim.tween({
      ms,
      unscaled: true,
      ease: ease.inQuad,
      update: (v) => {
        if (ver !== this.ver) return;
        this.setFade(from * (1 - v));
      },
      done: () => {
        if (ver === this.ver) {
          this.setFade(0);
          this.setDrawn(0);
          for (const d of this.dice) {
            d.active = false;
            this.applyDie(d);
          }
          for (const h of this.hairs) h.mesh.visible = false;
        }
      },
    });
  }

  /** Called as the tray starts to dry out (`ms` = its fade): the board's washes come back with it. */
  onHide: ((ms: number) => void) | null = null;

  /** Warm-up: show a static roll so shaders/textures are uploaded. */
  warm(p: PlayerPalette, q: PlayerPalette): void {
    this.prepare({ attack: [6, 5, 4], defend: [3, 2], attacker: p, defender: q, mode: 'static', reduced: false, run: null });
    this.setDrawn(1.04);
    this.setFade(1);
    this.root.visible = true;
    for (const d of this.dice) this.applyDie(d);
    for (let i = 0; i < 2; i++) this.layHair(i, this.dice[i], this.dice[3 + i], true);
  }

  resetWarm(): void {
    this.setFade(0);
    this.setDrawn(0);
    this.shown = false;
    for (const d of this.dice) {
      d.active = false;
      this.applyDie(d);
    }
    for (const h of this.hairs) h.mesh.visible = false;
  }

  /**
   * Lay pair `i`'s hairline: an arc over the dice from one to the other (tray-local, on the floor plane),
   * drawn from the winner. Pairs nest: the outer pairs arc higher.
   */
  private layHair(i: number, a: Die, b: Die, aWins: boolean): void {
    const h = this.hairs[i];
    const s = this.size;
    const x0 = a.pos.x;
    const x1 = b.pos.x;
    const y0 = a.pos.y + s * 0.62;
    const apex = a.pos.y + s * (0.86 + 0.2 * i);
    const N = 40;
    const w = Math.max(1.3, s * 0.028);
    const pos: number[] = [];
    const us: number[] = [];
    const idx: number[] = [];
    const pt = (t: number): [number, number] => {
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (apex - y0) * Math.sin(t * Math.PI);
      return [x, y];
    };
    for (let k = 0; k <= N; k++) {
      const t = k / N;
      const [x, y] = pt(t);
      const [xa, ya] = pt(Math.max(0, t - 0.01));
      const [xb, yb] = pt(Math.min(1, t + 0.01));
      let nx = -(yb - ya);
      let ny = xb - xa;
      const nl = Math.hypot(nx, ny) || 1;
      nx /= nl;
      ny /= nl;
      // a brush hairline: a hair thicker in the middle
      const ww = w * (0.7 + 0.3 * Math.sin(t * Math.PI));
      pos.push(x + nx * ww, y + ny * ww, s * 0.02, x - nx * ww, y - ny * ww, s * 0.02);
      us.push(t, t);
      if (k < N) {
        const o = k * 2;
        idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
      }
    }
    h.mesh.geometry.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aU', new THREE.Float32BufferAttribute(us, 1));
    g.setIndex(idx);
    h.mesh.geometry = g;
    h.mat.uniforms.uFromEnd.value = aWins ? 0 : 1;
    h.mat.uniforms.uProgress.value = 1.05;
    h.mat.uniforms.uOpacity.value = 0.8;
    h.mesh.visible = true;
  }

  private prepare(spec: RollSpec): { atk: Die[]; def: Die[] } {
    const atk = this.dice.slice(0, 3);
    const def = this.dice.slice(3, 5);
    for (const h of this.hairs) {
      h.mesh.visible = false;
      h.mat.uniforms.uOpacity.value = 0;
    }
    const setup = (list: Die[], vals: number[], pal: PlayerPalette, side: -1 | 1) => {
      const faces = typeof document !== 'undefined' ? this.faces(pal, side < 0) : [];
      list.forEach((d, i) => {
        d.active = i < vals.length;
        if (!d.active) {
          this.applyDie(d);
          return;
        }
        d.faces = faces;
        d.side = side;
        d.value = Math.max(1, Math.min(6, vals[i] | 0));
        d.shown = d.value;
        // the ink splash lies on the face, turned its own way
        d.splash.rotation.z = (vals[i] * 1.7 + i) % 6.28;
        // Seat the dice slightly below centre (the tilt lifts them on screen).
        d.pos.set(this.slotX(side, i), -this.size * 0.2, 0);
        d.rot = 0;
        d.sx = 1;
        d.sy = 1;
        d.bright = 1;
        d.alpha = 1;
        d.lift = 0;
        d.scale = 1;
        d.splashA = 0;
      });
    };
    setup(atk, spec.attack, spec.attacker, -1);
    setup(def, spec.defend, spec.defender, 1);
    return { atk: atk.filter((d) => d.active), def: def.filter((d) => d.active) };
  }

  /** Play one roll. Always resolves. */
  async roll(spec: RollSpec): Promise<void> {
    const t0 = performance.now();
    try {
      await this.rollInner(spec);
    } finally {
      this.lastRoll = { mode: spec.mode, ms: Math.round(performance.now() - t0) };
    }
  }

  private async rollInner(spec: RollSpec): Promise<void> {
    this.show(spec.reduced);
    const { atk, def } = this.prepare(spec);
    const all = [...atk, ...def];
    const run = spec.run;
    const s = this.size;
    const pairs = Math.min(atk.length, def.length);
    const upd = () => all.forEach((d) => this.applyDie(d));

    /**
     * The verdict. Full: pair by pair, a gold hairline draws from the winner (HAIR_DRAW_MS), then that pair's
     * loser takes its ink splash and dims to half (`onPair` fires as the hairline arrives); the winners lift a
     * hair. Not full (a blitz's middle rolls, the first roll): every pair at once, the losers dim, no lines.
     */
    const verdict = async (full: boolean, ms: number) => {
      spec.onVerdict?.();
      const aw = (k: number) => spec.attack[k] > spec.defend[k];
      for (let k = 0; k < pairs; k++) if (full) this.layHair(k, atk[k], def[k], aw(k));
      const hair = this.hairs.slice(0, full ? pairs : 0);
      for (const h of hair) h.mat.uniforms.uProgress.value = 0;
      const fired = new Set<number>();
      const fire = (k: number) => {
        if (fired.has(k)) return;
        fired.add(k);
        spec.onPair?.(k, aw(k));
      };
      if (!full) for (let k = 0; k < pairs; k++) fire(k);
      // pair k's hairline starts at k·gap; its loser dims from the moment it arrives to the verdict's end
      const gap = full && pairs > 1 ? Math.max(0, Math.min(70, (ms - HAIR_DRAW_MS - 60) / (pairs - 1))) : 0;
      await this.anim.tween({
        ms,
        ease: ease.linear,
        run,
        update: (_v, raw) => {
          const t = raw >= 1 ? Infinity : raw * ms;
          for (let i = pairs; i < atk.length; i++) atk[i].bright = 1 - 0.3 * Math.min(1, raw);
          for (let k = 0; k < pairs; k++) {
            const win = aw(k) ? atk[k] : def[k];
            const lose = aw(k) ? def[k] : atk[k];
            if (!full) {
              lose.bright = 1 - 0.5 * ease.outCubic(raw);
              lose.splashA = 0.6 * raw;
              continue;
            }
            const t0 = k * gap;
            const arrive = t0 + HAIR_DRAW_MS;
            if (hair[k]) hair[k].mat.uniforms.uProgress.value = Math.min(1.05, Math.max(0, ((t - t0) / HAIR_DRAW_MS) * 1.05));
            if (t >= arrive) fire(k);
            const w = t >= arrive ? Math.min(1, (t - arrive) / Math.max(40, ms - arrive)) : 0;
            lose.bright = 1 - 0.5 * ease.outCubic(w);
            lose.splashA = Math.min(1, w * 1.8);
            win.lift = 3 * ease.outCubic(Math.min(1, raw));
          }
          upd();
        },
      });
      for (let k = 0; k < pairs; k++) fire(k);
    };

    // Static / instant: final faces, verdict applied at once.
    if (spec.mode === 'static' || this.anim.instant || (run && run.skipped)) {
      spec.onLand?.(-1, 0);
      await verdict(true, 0);
      upd();
      return;
    }

    if (spec.reduced) {
      // Fade in on the final faces, hold, then pair and compare.
      all.forEach((d) => (d.alpha = 0));
      await this.anim.tween({
        ms: 150,
        ease: ease.outQuad,
        run,
        update: (v) => {
          all.forEach((d) => (d.alpha = v));
          upd();
        },
      });
      spec.onLand?.(-1, 0);
      if (spec.mode !== 'middle' && spec.mode !== 'first') spec.onSilence?.(this.anim.scale(VERDICT_SILENCE_MS));
      await this.anim.wait(spec.mode === 'middle' ? 0 : spec.mode === 'first' ? 150 : VERDICT_SILENCE_MS + 100, run);
      await verdict(spec.mode !== 'middle' && spec.mode !== 'first', spec.mode === 'middle' ? 80 : 260);
      return;
    }

    if (spec.mode === 'middle') {
      // A blitz's middle roll: the dice hop and flick to their new faces with a small squash; one land per
      // roll; no silence (the blitz cap rules).
      // [fight v5] the drum: the attacker's dice touch down, then the defender's a beat later (two clicks per
      // roll), and as the middles shorten the drum quickens.
      const dur = spec.durMs ?? 300;
      const pop = Math.min(110, dur * 0.4);
      const beat = Math.min(40, pop * 0.3);
      const r0 = all.map((_, i) => 0.35 * (i % 2 ? 1 : -1));
      all.forEach((d) => (d.shown = 1 + Math.floor(h01(d.value, d.pos.x, 9) * 6)));
      let atkLanded = false;
      await this.anim.tween({
        ms: pop,
        ease: ease.linear,
        run,
        update: (_v, raw) => {
          const tms = raw * pop;
          if (!atkLanded && tms >= pop - beat && raw < 1) {
            atkLanded = true;
            spec.onLand?.(-1, 0);
          }
          all.forEach((d, i) => {
            const v = ease.outCubic(Math.min(1, Math.max(0, d.side < 0 ? tms / (pop - beat) : (tms - beat) / (pop - beat))));
            if (v > 0.45) d.shown = d.value;
            d.rot = r0[i] * (1 - v);
            d.pos.z = Math.sin(v * Math.PI) * s * 0.18;
            // the flip: narrow across the turn of the face, then a squash as it lands
            const f = Math.abs(Math.cos(Math.min(1, v / 0.9) * Math.PI));
            d.sx = 0.72 + 0.28 * f + (v > 0.85 ? 0.08 * Math.sin(((v - 0.85) / 0.15) * Math.PI) : 0);
            d.sy = 1 - (v > 0.85 ? 0.08 * Math.sin(((v - 0.85) / 0.15) * Math.PI) : 0);
            d.scale = 0.9 + 0.1 * v;
          });
          upd();
        },
      });
      all.forEach((d) => {
        d.shown = d.value;
        d.rot = 0;
        d.sx = d.sy = d.scale = 1;
        d.pos.z = 0;
      });
      upd();
      if (!atkLanded) spec.onLand?.(-1, 0);
      if (def.length && beat > 8 && atkLanded) spec.onLand?.(1, 0);
      // The losers dim while the next roll is already coming: the verdict isn't awaited (one frame-
      // quantised await per middle roll keeps a long blitz inside its cap).
      const vms = Math.min(90, dur * 0.3);
      void verdict(false, vms);
      const rest = dur - pop;
      if (rest > 20) await this.anim.wait(rest, run);
      return;
    }

    // Timings (1×). Single roll 120 + 450 + 100 + 250 + 240 = 1160 ms (≤ 1.25 s with the silence). Since
    // 2026-09-30 the tumble is 450 (was 380); a blitz's final roll gets
    // the same tumble and settle so the decisive roll reads like a single roll (its middles absorb it).
    const T =
      spec.mode === 'single'
        ? { shake: 120, tumble: DICE_TUMBLE_MS, settle: DICE_SETTLE_MS, silence: VERDICT_SILENCE_MS, verdict: VERDICT_MS, full: true }
        : spec.mode === 'repeat'
          ? { shake: 0, tumble: DICE_TUMBLE_MS, settle: DICE_SETTLE_MS, silence: VERDICT_SILENCE_MS, verdict: VERDICT_MS, full: true }
          : spec.mode === 'first'
            ? { shake: 80, tumble: 320, settle: 60, silence: 0, verdict: 200, full: false }
            : { shake: 0, tumble: DICE_TUMBLE_MS, settle: DICE_SETTLE_MS, silence: VERDICT_SILENCE_MS, verdict: 220, full: true }; // final

    // [fight v5] The pour (PROPOSAL §4 A "action"). The roll's own window (shake + tumble + settle: 670 ms for a
    // single roll) is unchanged; inside it the dice leave the cup's side one at a time, pairs interleaved
    // (a0, d0, a1, d1, a2) so a matched pair lands together, each on a short arc down into the ring: it turns
    // flat (1¼–2 turns easing out), its face flicks over 3–4 times, and it touches down with its own squash (and
    // its own bone click, onLand). The last die's squash ends as the window does; the held breath follows.
    const pre = T.shake + T.tumble + T.settle;
    const order: Die[] = [];
    for (let k = 0; k < Math.max(atk.length, def.length); k++) {
      if (atk[k]) order.push(atk[k]);
      if (def[k]) order.push(def[k]);
    }
    const n = order.length;
    const SQ = spec.mode === 'first' ? 60 : 90;
    const lastLand = pre - SQ;
    // a die needs ≥ 160 ms in the air and leaves ≥ 30 ms in (the ring is still brushing on)
    const maxSt = n > 1 ? Math.max(0, (lastLand - 30 - 160) / (n - 1)) : 0;
    const st = Math.max(0, Math.min(90, spec.stagger ?? 0, maxSt));
    const firstLand = lastLand - st * (n - 1);
    const F = Math.max(120, Math.min(380, firstLand - 30));
    const land = order.map((_, j) => firstLand + j * st);
    const dep = land.map((t) => t - F);
    const sideIdx = order.map((d) => (d.side < 0 ? atk.indexOf(d) : def.indexOf(d)));
    // from each side's own end of the ring (the attacker's cup side, the defender's): just inside the rim,
    // raised off the paper, so the arc stays inside the ring and never crosses the header above it
    const rimX = this.trayW / 2 - s * 0.55;
    const starts = order.map((d, j) => new THREE.Vector3(d.side * (rimX + s * 0.25 * (j % 2)), d.pos.y + s * (0.35 + 0.12 * (j % 3)), s * (0.75 + 0.1 * (j % 2))));
    const turns = order.map((d, j) => d.side * (1.25 + (j % 3) * 0.3) * Math.PI * 2);
    const flips = order.map((_, j) => 3 + (j % 2));
    const finals = order.map((d) => d.pos.clone());
    const landed = new Set<number>();
    order.forEach((d) => (d.alpha = 0));
    upd();
    if (T.shake > 0) spec.onShake?.(this.anim.scale(T.shake));
    const step = (tms: number) => {
      order.forEach((d, j) => {
        if (tms < dep[j]) {
          d.alpha = 0;
          return;
        }
        if (tms < land[j]) {
          const u = Math.min(1, (tms - dep[j]) / F);
          const e = ease.outCubic(u);
          d.pos.x = starts[j].x + (finals[j].x - starts[j].x) * ease.outQuad(u);
          d.pos.y = starts[j].y + (finals[j].y - starts[j].y) * e;
          // the arc: tossed up a little, then it falls (gravity) onto its spot
          d.pos.z = starts[j].z * (1 - ease.inQuad(u)) + Math.sin(u * Math.PI) * s * 0.45 * (1 - 0.5 * u);
          d.rot = (1 - e) * turns[j];
          const ph = Math.min(1, e / 0.85) * flips[j];
          const k = Math.floor(ph);
          d.shown = k >= flips[j] ? d.value : 1 + Math.floor(h01(j, k, d.value + 3) * 6);
          d.sx = k >= flips[j] ? 1 : 0.62 + 0.38 * Math.abs(Math.cos((ph - k) * Math.PI));
          d.sy = 1;
          d.alpha = Math.min(1, (tms - dep[j]) / 40);
          return;
        }
        if (!landed.has(j)) {
          landed.add(j);
          spec.onLand?.(d.side, sideIdx[j]);
        }
        d.pos.copy(finals[j]);
        d.rot = 0;
        d.shown = d.value;
        d.alpha = 1;
        // the squash on landing: wider and lower, then back, with a hair of bounce
        const v = Math.min(1, (tms - land[j]) / SQ);
        const q = v < 1 ? Math.sin(v * Math.PI) * (1 - 0.3 * v) : 0;
        d.sx = 1 + 0.13 * q;
        d.sy = 1 - 0.15 * q;
        d.pos.z = v < 1 ? Math.sin(v * Math.PI) * s * 0.035 : 0;
      });
      upd();
    };
    await this.anim.tween({ ms: pre, ease: ease.linear, run, update: (_v, raw) => step(raw >= 1 ? pre + SQ : raw * pre) });
    order.forEach((d, j) => {
      if (!landed.has(j)) spec.onLand?.(d.side, sideIdx[j]);
      d.pos.copy(finals[j]);
      d.pos.z = 0;
      d.rot = 0;
      d.shown = d.value;
      d.sx = d.sy = 1;
      d.alpha = 1;
    });
    upd();
    // The held breath: nothing moves, nothing sounds.
    if (T.silence) {
      spec.onSilence?.(this.anim.scale(T.silence));
      await this.anim.wait(T.silence, run);
    }
    await verdict(T.full, T.verdict);
  }

  private proj = new THREE.Vector3();
  /**
   * Where the dice sit on screen (CSS px, x0 y0 x1 y1): their seats, not the ring. The ring is ink on the
   * paper with a translucent wash, so what lies under it stays readable (John, 2026-09-29); only the dice
   * themselves cover the board. Null when no die is out.
   */
  diceRect(): [number, number, number, number] | null {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    this.root.updateMatrixWorld();
    const s = this.size;
    for (let i = 0; i < this.dice.length; i++) {
      const d = this.dice[i];
      if (!d.active) continue;
      // the die's seat (its final spot), a flat face square to the viewer
      this.proj.set(this.slotX(d.side, i < 3 ? i : i - 3), -s * 0.2, s * 0.5 * Math.sin(-TILT));
      this.tray.localToWorld(this.proj);
      this.proj.project(this.camera);
      const x = (this.proj.x * 0.5 + 0.5) * this.W;
      const y = (-this.proj.y * 0.5 + 0.5) * this.H;
      x0 = Math.min(x0, x - s * 0.6);
      x1 = Math.max(x1, x + s * 0.7);
      y0 = Math.min(y0, y - s * 0.62);
      y1 = Math.max(y1, y + s * 0.7);
    }
    return x0 < x1 ? [x0, y0, x1, y1] : null;
  }

  /** Linger bookkeeping: hide after `ms` of real time unless another roll starts. */
  linger(ms: number, now: number): void {
    this.lingerUntil = now + ms;
  }

  tick(now: number): void {
    if (this.lingerUntil && now >= this.lingerUntil) {
      this.lingerUntil = 0;
      this.hide(300);
    }
  }

  dispose(): void {
    for (const m of this.materials) m.dispose();
    for (const f of this.faceCache.values()) f.forEach((t) => t.dispose());
    this.splashTex.dispose();
    this.shadowTex?.dispose();
    this.ring.geometry.dispose();
    this.dice[0]?.mesh.geometry.dispose();
    this.dice[0]?.splash.geometry.dispose();
    for (const h of this.hairs) h.mesh.geometry.dispose();
  }
}
