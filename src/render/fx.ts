// Brush strokes on the board (docs/INK2.md §2.1, INK.md A2): the attack arrow as one dry-brush stroke that
// lands loaded at the source figure, swells, thins as it crosses the border and lifts off inside the target
// in a few separate bristle hairs (no arrowhead: direction reads from where the brush lifted); the live
// stroke that follows a finger or mouse in draw-to-attack (the same brush, wet under the finger); and the
// fortify route as a dotted ink line. They lie flat on the paper; nothing glows.
// (Sea lanes are ink dabs in the ink layer now; dust and ripple rings are cut.)
import * as THREE from 'three';
import type { TerritoryId } from '../engine/types';
import { BOARD, seaLaneBetween } from '../map';
import { Animator, ease, type Run } from './anim';
import { loadTexmap } from './texmaps';
import { GOLD, IVORY, TILE_TOP, hexToRgb, toWorld, type RGB } from './util';
import type { TileSet } from './tiles';

const STROKE_Y = TILE_TOP + 0.34;

/**
 * The brush-tip map (public/tex/tip.png, Phase 0; docs/INK2.md §4.1): the end of a real dry stroke where
 * the brush lifted, alpha = ink, stroke axis left → right (u = 1 where the brush lifts). Served by texmaps.ts
 * with flipY off (v = 0 is the image's top row), so the shader samples v = 0.5 − d (the side the hairs sit on
 * matches Phase A's flipped load). Loaded once, on the first brush; until it arrives (or if it fails) the
 * strokes fray with the procedural noise alone.
 */
const TIP: { tex: THREE.Texture | null; mats: Set<THREE.ShaderMaterial>; asked: boolean } = { tex: null, mats: new Set(), asked: false };
function useTip(mat: THREE.ShaderMaterial): void {
  TIP.mats.add(mat);
  if (TIP.tex) {
    mat.uniforms.uTip.value = TIP.tex;
    mat.uniforms.uTipOn.value = 1;
    return;
  }
  if (TIP.asked || typeof document === 'undefined') return;
  TIP.asked = true;
  void loadTexmap('tip').then((t) => {
    if (!t) return; // the procedural fray stays
    TIP.tex = t;
    for (const m of TIP.mats) {
      m.uniforms.uTip.value = t;
      m.uniforms.uTipOn.value = 1;
    }
  });
}

const BRUSH_VERT = /* glsl */ `
attribute vec2 aUV;
attribute vec3 aW;
varying vec2 vUV;
varying vec3 vW;
void main() {
  vUV = aUV;
  vW = aW;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const BRUSH_FRAG = /* glsl */ `
uniform sampler2D uNoise;
uniform sampler2D uTip;
uniform float uTipOn;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uProgress;
uniform float uTail;
uniform float uLen;
uniform float uDots;
uniform float uSeed;
uniform float uDry;
uniform float uDryK;
uniform float uStyle;
uniform float uLive;
uniform float uPx;
uniform float uFadeIn;
uniform float uFadeOut;
varying vec2 vUV;
varying vec3 vW;
float h1(float n) { return fract(sin(n * 12.9898 + uSeed * 78.233) * 43758.5453); }
void main() {
  float u = vUV.x;
  float v = vUV.y;
  float s = u * uLen;
  // reveal (tip first): a soft brush front
  float rev = 1.0 - smoothstep(uProgress - 0.012, uProgress + 0.002, u);
  vec4 n = texture2D(uNoise, vec2(s / 7.5 + uSeed, v * 0.17 + 0.5));
  vec4 e = texture2D(uNoise, vec2(s / 2.6 + uSeed * 1.3, 0.21 + v * 0.015));
  float bristle = n.b;
  float a;
  if (uStyle > 0.5) {
    // The brush that lifts (INK2 §2.1), all in home-view px: vW = (half-width of the ribbon, half-width of
    // the loaded body, g = 0 → 1 along the whole stroke). w runs from the loaded end (0) to where the brush
    // lifts (1): the arrow lands at its source; the live stroke is wet under the finger.
    float g = vW.z;
    float w = uLive > 0.5 ? 1.0 - g : g;
    float d = v * vW.x;
    float ad = abs(d);
    vec4 st = texture2D(uNoise, vec2(s / 19.0 + uSeed, v * 0.62 + 0.5));
    vec4 st2 = texture2D(uNoise, vec2(s / 6.0 + uSeed * 2.1, v * 1.3 + 0.13));
    bristle = st.b * 0.65 + st2.a * 0.35;
    // the body: its loaded width, ±8 % bristle wobble; the landing is round
    float hb = vW.y * (1.0 + 0.16 * (e.g - 0.5));
    float sPx = (uLive > 0.5 ? (1.0 - u) : u) * uLen / max(uPx, 1e-5);
    float h0 = vW.y;
    if (sPx < h0) hb = min(hb, sqrt(max(0.0, h0 * h0 - (h0 - sPx) * (h0 - sPx))) + 0.4);
    float body = 1.0 - smoothstep(hb - 0.6, hb + 0.4, ad);
    // faint bristle streaks in the body; dry gaps begin as it thins across the border
    float dryness = clamp(0.1 + 0.8 * smoothstep(0.62, 0.92, w) + uDry * 0.3, 0.0, 1.0) * uDryK;
    body *= mix(1.0, smoothstep(0.3, 0.6, bristle), dryness);
    // the last 30 %: the real brush tip's fray (u-mapped along the stroke, v across it)
    float env = max(vW.y, 1.4 + 1.3 * smoothstep(0.9, 1.0, w));
    float tipA = 1.0;
    if (w > 0.7 && uTipOn > 0.5) tipA = texture2D(uTip, vec2(clamp((w - 0.7) / 0.3, 0.02, 0.98), clamp(0.5 - 0.46 * d / env, 0.02, 0.98))).a;
    body *= mix(1.0, tipA, smoothstep(0.7, 0.76, w));
    // the lift: the body gives way to 3–5 bristle hairs, 0.6–1.2 px, each ending on its own
    float hz = smoothstep(0.9, 1.0, w);
    float hairs = 0.0;
    if (w > 0.86) {
      float K = 3.0 + floor(h1(1.0) * 2.99);
      for (int k = 0; k < 5; k++) {
        float fk = float(k);
        if (fk >= K) break;
        float c = (-0.8 + 1.6 * (fk + 0.5) / K + (h1(fk + 3.0) - 0.5) * 0.25) * (1.5 + 1.1 * hz);
        float wk = 0.6 + 0.6 * h1(fk + 7.0);
        float endK = 0.94 + 0.06 * h1(fk + 11.0);
        float hk = (1.0 - smoothstep(wk * 0.5 - 0.35, wk * 0.5 + 0.35, abs(d - c))) * (1.0 - smoothstep(endK - 0.03, endK, w));
        if (uTipOn > 0.5) hk *= mix(0.45, 1.0, texture2D(uTip, vec2(clamp((w - 0.7) / 0.3, 0.02, 0.98), clamp(0.5 - 0.46 * c / env, 0.02, 0.98))).a);
        else hk *= mix(0.55, 1.0, smoothstep(0.35, 0.6, texture2D(uNoise, vec2(s / 3.0 + fk * 0.37, 0.5)).b));
        hairs = max(hairs, hk * 0.9);
      }
    }
    a = max(body * (1.0 - smoothstep(0.9, 0.95, w)), hairs * smoothstep(0.86, 0.92, w));
  } else {
    // ragged, feathered edges
    float halfW = 1.0 - 0.3 * e.g;
    a = 1.0 - smoothstep(halfW - 0.22, halfW, abs(v));
    // dry streaks: more toward the thin end, and wherever the brush is running out
    float dryness = clamp((0.3 + 0.45 * u + uDry * (1.0 - u)) * uDryK, 0.0, 1.0);
    a *= mix(1.0, smoothstep(0.24, 0.56, bristle), dryness * 0.65);
  }
  // the tail dries first
  if (uTail > 0.0) a *= smoothstep(uTail, uTail + 0.14, u + 0.14 * (bristle - 0.5));
  // a stroke that leaves (or enters) over the board's edge fades out into the paper there
  if (uFadeIn > 0.0) a *= smoothstep(0.0, uFadeIn, u + 0.05 * (bristle - 0.5));
  if (uFadeOut > 0.0) a *= smoothstep(0.0, uFadeOut, 1.0 - u + 0.05 * (bristle - 0.5));
  if (uDots > 0.5) {
    float dd = abs(fract(s / 0.46) - 0.5) * 2.0;
    a *= 1.0 - smoothstep(0.38, 0.62, dd);
  }
  a *= rev * uOpacity;
  if (a < 0.004) discard;
  vec3 col = uColor * (0.86 + 0.26 * bristle);
  gl_FragColor = vec4(col, a);
}
`;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * The brush profile (INK2 §2.1), full width in home-view px at w = 0 (the loaded end) → 1 (the lift):
 * a round landing 4 → 8, a slow swell 8 → 9 → 7, thinning 7 → 3 across the border, then the hairs.
 */
export function brushWidthPx(w: number): number {
  if (w < 0.08) return 4 + 4 * Math.sqrt(Math.max(0, w) / 0.08);
  if (w < 0.35) return 8 + smooth(0.08, 0.35, w);
  if (w < 0.7) return 9 - 2 * smooth(0.35, 0.7, w);
  if (w < 0.92) return 7 - 4 * Math.pow((w - 0.7) / 0.22, 0.9);
  return 3 - 1.2 * Math.min(1, (w - 0.92) / 0.08);
}
/** Half the ribbon (px): the body, or the hairs' splay near the lift, plus a pixel of feather. */
function ribbonHalfPx(w: number): number {
  const env = w > 0.86 ? 1.4 + 1.3 * smooth(0.9, 1, w) : 0;
  return Math.max(brushWidthPx(w) / 2, env * 1.15) + 1.2;
}

/** A flat ribbon along a world-space path, drawn by the brush shader. */
class BrushRibbon {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  private pos: Float32Array;
  private uv: Float32Array;
  private wv: Float32Array;
  private geo: THREE.BufferGeometry;
  constructor(
    noise: THREE.Texture,
    color: RGB,
    private max = 200,
    dots = false,
  ) {
    this.pos = new Float32Array(max * 2 * 3);
    this.uv = new Float32Array(max * 2 * 2);
    this.wv = new Float32Array(max * 2 * 3);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aUV', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aW', new THREE.BufferAttribute(this.wv, 3).setUsage(THREE.DynamicDrawUsage));
    const idx: number[] = [];
    for (let i = 0; i < max - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.geo.setIndex(idx);
    this.geo.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uNoise: { value: noise },
        uTip: { value: null },
        uTipOn: { value: 0 },
        uColor: { value: new THREE.Vector3(color[0], color[1], color[2]) },
        uOpacity: { value: 1 },
        uProgress: { value: 1 },
        uTail: { value: 0 },
        uLen: { value: 1 },
        uDots: { value: dots ? 1 : 0 },
        uSeed: { value: Math.random() },
        uDry: { value: 0 },
        uDryK: { value: 1 },
        uStyle: { value: 0 },
        uLive: { value: 0 },
        uPx: { value: 0.08 },
        uFadeIn: { value: 0 },
        uFadeOut: { value: 0 },
      },
      vertexShader: BRUSH_VERT,
      fragmentShader: BRUSH_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
  }

  get u(): Record<string, THREE.IUniform> {
    return this.mat.uniforms;
  }

  /** The brush that lifts (style 1): the profile is set in home-view px; `px` = board units per px. */
  brush(live: boolean, px: number): void {
    this.u.uStyle.value = 1;
    this.u.uLive.value = live ? 1 : 0;
    this.u.uPx.value = px;
    useTip(this.mat);
  }

  /**
   * Lay the ribbon along `pts` (world; y ignored → STROKE_Y) with half-width `w(u)` in board units.
   * `prof(u)` (the brush): [ribbon half px, body half px, g along the whole stroke] for the shader.
   */
  set(pts: THREE.Vector3[], w: (u: number) => number, prof?: (u: number) => [number, number, number]): number {
    const n = Math.min(this.max, pts.length);
    if (n < 2) {
      this.geo.setDrawRange(0, 0);
      return 0;
    }
    const cum = [0];
    for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
    const L = cum[n - 1] || 1;
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(n - 1, i + 1)];
      let tx = b.x - a.x;
      let tz = b.z - a.z;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      const u = cum[i] / L;
      const hw = w(u);
      const nx = -tz * hw;
      const nz = tx * hw;
      const o = i * 6;
      this.pos[o] = pts[i].x + nx;
      this.pos[o + 1] = STROKE_Y;
      this.pos[o + 2] = pts[i].z + nz;
      this.pos[o + 3] = pts[i].x - nx;
      this.pos[o + 4] = STROKE_Y;
      this.pos[o + 5] = pts[i].z - nz;
      const q = i * 4;
      this.uv[q] = u;
      this.uv[q + 1] = 1;
      this.uv[q + 2] = u;
      this.uv[q + 3] = -1;
      const p = prof ? prof(u) : [0, 0, u];
      this.wv.set(p, o);
      this.wv.set(p, o + 3);
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aUV as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aW as THREE.BufferAttribute).needsUpdate = true;
    this.geo.setDrawRange(0, (n - 1) * 6);
    this.mat.uniforms.uLen.value = L;
    return L;
  }

  dispose(): void {
    TIP.mats.delete(this.mat);
    this.geo.dispose();
    this.mat.dispose();
  }
}

function bezier(a: THREE.Vector3, c: THREE.Vector3, b: THREE.Vector3, n: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const m = 1 - t;
    out.push(new THREE.Vector3(m * m * a.x + 2 * m * t * c.x + t * t * b.x, STROKE_Y, m * m * a.z + 2 * m * t * c.z + t * t * b.z));
  }
  return out;
}

/** A gentle bow between two board points (always to the stroke's left), as a brush would arc. */
function bow(a: THREE.Vector3, b: THREE.Vector3, k: number, n = 48): THREE.Vector3[] {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1;
  const c = new THREE.Vector3((a.x + b.x) / 2 - (dz / len) * len * k, STROKE_Y, (a.z + b.z) / 2 + (dx / len) * len * k);
  return bezier(a, c, b, n);
}

// ---------------------------------------------------------------------------
// Attack arrow: one dry-brush stroke that lifts
// ---------------------------------------------------------------------------

export class AttackArrow {
  group = new THREE.Group();
  /** Reduced motion: the stroke fades in whole (150 ms) instead of drawing tip-first. */
  reduced = false;
  /** Where a territory's figure stands (world); the stroke runs figure to figure. Default: the anchor. */
  anchorOf: ((id: TerritoryId) => THREE.Vector3) | null = null;
  private bodies: BrushRibbon[];
  private lens: number[] = [0, 0];
  /** Board units per CSS px at the home view (set on layout): the stroke's weight is set in screen px. */
  pxUnit = 0.08;
  progress = 0;
  key = '';
  private ver = 0;

  constructor(
    private tiles: TileSet,
    private anim: Animator,
    noise: THREE.Texture,
  ) {
    const gold = hexToRgb(GOLD);
    this.bodies = [new BrushRibbon(noise, gold, 80), new BrushRibbon(noise, gold, 80)];
    // Loaded where it leaves the source figure, dry where it crosses into the target, lifted inside it.
    for (const r of this.bodies) {
      r.brush(false, this.pxUnit);
      r.u.uDryK.value = 1;
    }
    for (const b of this.bodies) this.group.add(b.mesh);
    this.group.visible = false;
  }

  get materials(): THREE.Material[] {
    return this.bodies.map((b) => b.mat);
  }

  /** Re-lay the stroke at a new screen scale (a resize while armed), keeping its progress and ink. */
  relayout(): void {
    for (const b of this.bodies) b.u.uPx.value = this.pxUnit;
    if (!this.group.visible || !this.key) return;
    const [from, to] = this.key.split('|') as [TerritoryId, TerritoryId];
    const p = this.progress;
    this.build(from, to);
    this.setProgress(p);
  }

  private build(from: TerritoryId, to: TerritoryId): void {
    const A = (this.anchorOf ? this.anchorOf(from) : this.tiles.get(from).anchorW).clone();
    const B = (this.anchorOf ? this.anchorOf(to) : this.tiles.get(to).anchorW).clone();
    const lane = seaLaneBetween(from, to);
    const px = this.pxUnit;
    for (const b of this.bodies) b.u.uPx.value = px;
    let curves: THREE.Vector3[][];
    let wrapped = false;
    if (lane && lane.wrap) {
      // Across the date line: two short strokes, one leaving the source over its nearest board edge and one
      // arriving at the target from the opposite edge, each arcing a little toward the pole and fading into
      // the paper at the edge (never a bar across the board).
      wrapped = true;
      const [s1, s2] = lane.segments;
      // the board's centre line (board units), from the booted pack's geometry
      const mid = BOARD.width / 2;
      const edgeOf = (seg: typeof s1) => {
        const p0 = seg[0];
        const p1 = seg[seg.length - 1];
        return Math.abs(p0[0] - mid) > Math.abs(p1[0] - mid) ? p0 : p1;
      };
      const e1 = edgeOf(s1);
      const e2 = edgeOf(s2);
      const [ea, eb] = Math.sign(e1[0] - mid) === Math.sign(A.x) ? [e1, e2] : [e2, e1];
      const EA = toWorld(ea[0] + Math.sign(ea[0] - mid) * 0.6, ea[1], STROKE_Y);
      const EB = toWorld(eb[0] + Math.sign(eb[0] - mid) * 0.6, eb[1], STROKE_Y);
      const A2 = A.clone().lerp(EA, Math.min(0.3, 0.75 / Math.max(1, A.distanceTo(EA))));
      const B2 = B.clone().lerp(EB, Math.min(0.36, 1.45 / Math.max(1, B.distanceTo(EB))));
      // both arcs bow the same way on screen (north), so the pair reads as one stroke over the edge
      const k = (a: THREE.Vector3, b: THREE.Vector3) => (Math.sign(b.x - a.x) || 1) * 0.16;
      curves = [bow(A2, EA, k(A2, EA), 32), bow(EB, B2, k(EB, B2), 32)];
    } else {
      const d = Math.hypot(B.x - A.x, B.z - A.z);
      // start just off the source's figure; the brush lifts inside the target, short of its figure
      const A2 = A.clone().lerp(B, Math.min(0.3, 0.75 / Math.max(d, 0.001)));
      const B2 = B.clone().lerp(A, Math.min(0.36, 1.45 / Math.max(d, 0.001)));
      curves = [bow(A2, B2, 0.14, 56), []];
    }
    const total = (c: THREE.Vector3[]) => {
      let l = 0;
      for (let i = 1; i < c.length; i++) l += Math.hypot(c[i].x - c[i - 1].x, c[i].z - c[i - 1].z);
      return l;
    };
    const L0 = total(curves[0]);
    const L1 = curves[1].length ? total(curves[1]) : 0;
    const LT = L0 + L1 || 1;
    // The weight is set in screen px at the home view (brushWidthPx); g runs over both pieces of a wrap.
    const half = (g: number) => ribbonHalfPx(g) * px;
    const prof = (g: number): [number, number, number] => [ribbonHalfPx(g), brushWidthPx(g) / 2, g];
    this.lens = [L0 / LT, L1 / LT];
    this.bodies[0].set(curves[0], (u) => half((u * L0) / LT), (u) => prof((u * L0) / LT));
    if (L1 > 0) this.bodies[1].set(curves[1], (u) => half((L0 + u * L1) / LT), (u) => prof((L0 + u * L1) / LT));
    else this.bodies[1].set([], () => 0);
    // wrapped: each piece fades out into the paper over its last ~110 px at the edge
    const fade = (L: number) => (wrapped && L > 0 ? Math.min(0.7, (110 * px) / L) : 0);
    this.bodies[0].u.uFadeOut.value = fade(L0);
    this.bodies[0].u.uFadeIn.value = 0;
    this.bodies[1].u.uFadeIn.value = fade(L1);
    this.bodies[1].u.uFadeOut.value = 0;
  }

  private setProgress(p: number): void {
    this.progress = p;
    const [f0, f1] = this.lens;
    this.bodies[0].u.uProgress.value = f0 > 0 ? Math.min(1.02, (p / f0) * 1.02) : 0;
    this.bodies[1].u.uProgress.value = f1 > 0 ? Math.max(0, Math.min(1.02, ((p - f0) / f1) * 1.02)) : 0;
  }

  private setDry(tail: number, opacity: number): void {
    for (const r of this.bodies) {
      r.u.uTail.value = tail;
      r.u.uOpacity.value = opacity;
    }
  }

  /** Draw the stroke (tip first, `growMs`), from `startAt` of the way if given. Colour is always the gold. */
  show(from: TerritoryId, to: TerritoryId, _color?: RGB, run: Run | null = null, growMs = 260, startAt = 0): Promise<void> {
    const key = `${from}|${to}`;
    if (this.key === key && this.group.visible && this.progress >= 1) {
      this.setDry(0, 1);
      return Promise.resolve();
    }
    const same = this.key === key && this.group.visible;
    this.key = key;
    this.build(from, to);
    this.group.visible = true;
    this.setDry(0, 1);
    const ver = ++this.ver;
    const start = same ? Math.min(this.progress, 1) : startAt;
    if (this.reduced && !same) {
      this.setProgress(1);
      this.setDry(0, 0);
      return this.anim.tween({
        ms: 150,
        ease: ease.outQuad,
        run,
        update: (v) => {
          if (ver === this.ver) this.setDry(0, v);
        },
      });
    }
    this.setProgress(start);
    return this.anim.tween({
      ms: growMs,
      ease: (t) => 1 - Math.pow(1 - t, 2.4),
      run,
      update: (v) => {
        if (ver !== this.ver) return;
        this.setProgress(start + (1 - start) * v);
      },
    });
  }

  private gold = 1;
  private inkVer = 0;
  /**
   * Gold while the fight is in flight (the stroke, the dice deciding); ivory at rest, when the armed
   * arrow waits and the commit button holds the one gold (INK B2.1 / A9). `ms` 0 = at once.
   */
  ink(gold: boolean, ms = 200): void {
    const to = gold ? 1 : 0;
    const ver = ++this.inkVer;
    const G = hexToRgb(GOLD);
    const I = hexToRgb(IVORY);
    const apply = (g: number) => {
      this.gold = g;
      for (const r of this.bodies) {
        const c = r.u.uColor.value as THREE.Vector3;
        c.set(I[0] + (G[0] - I[0]) * g, I[1] + (G[1] - I[1]) * g, I[2] + (G[2] - I[2]) * g);
      }
    };
    if (ms <= 0 || this.anim.instant || !this.group.visible || this.reduced) return apply(to);
    const from = this.gold;
    if (from === to) return;
    void this.anim.tween({
      ms,
      ease: ease.outQuad,
      update: (v) => {
        if (ver === this.inkVer) apply(from + (to - from) * v);
      },
    });
  }

  /** The tail dries up to `v` (0..1 of the stroke) — the conquest's traveller walking it. */
  trail(v: number): void {
    if (!this.group.visible) return;
    for (const r of this.bodies) r.u.uTail.value = Math.max(r.u.uTail.value, v);
  }

  /**
   * [fight v5] A repulse (PROPOSAL §4 A "verdict"): the stroke dries back toward home, the tip withdrawing
   * along the line to the source figure as the ink pales (tier 1, ~450 ms). Fire and forget; a new show()
   * wins.
   */
  retract(ms = 450): Promise<void> {
    if (!this.group.visible) return Promise.resolve();
    this.key = '';
    const ver = ++this.ver;
    if (this.anim.instant || this.reduced) {
      this.hide(true);
      return Promise.resolve();
    }
    const from = Math.min(1, this.progress);
    return this.anim.tween({
      ms,
      ease: ease.inOutQuad,
      update: (v) => {
        if (ver !== this.ver) return;
        this.setProgress(from * (1 - v));
        this.setDry(0, 1 - 0.55 * v * v);
      },
      done: () => {
        if (ver === this.ver) {
          this.group.visible = false;
          this.progress = 0;
        }
      },
    });
  }

  /** Dry out from the tail (140 ms). */
  hide(immediate = false): void {
    if (!this.group.visible) return;
    this.key = '';
    const ver = ++this.ver;
    if (immediate || this.anim.instant) {
      this.group.visible = false;
      this.progress = 0;
      return;
    }
    this.anim.tween({
      ms: 140,
      ease: ease.inQuad,
      update: (v) => {
        if (ver !== this.ver) return;
        this.setDry(v * 1.05, 1 - v * 0.6);
      },
      done: () => {
        if (ver === this.ver) {
          this.group.visible = false;
          this.progress = 0;
        }
      },
    });
  }

  dispose(): void {
    for (const b of this.bodies) b.dispose();
  }
}

// ---------------------------------------------------------------------------
// Draw-to-attack: the live stroke under the pointer (docs/INK.md A2)
// ---------------------------------------------------------------------------

export class LiveStroke {
  group = new THREE.Group();
  private body: BrushRibbon;
  private pts: THREE.Vector3[] = [];
  /** Board units per CSS px at the home view (set on layout), as AttackArrow.pxUnit. */
  pxUnit = 0.08;
  active = false;
  private ver = 0;
  private startedAt = 0;

  constructor(
    private anim: Animator,
    noise: THREE.Texture,
  ) {
    this.body = new BrushRibbon(noise, hexToRgb(GOLD), 200);
    // the same brush as the settled arrow, wet end at the finger: loaded under the pointer, drying toward
    // the source (INK2 §2.1)
    this.body.brush(true, this.pxUnit);
    this.body.u.uDryK.value = 1;
    this.group.add(this.body.mesh);
    this.group.visible = false;
  }

  get materials(): THREE.Material[] {
    return [this.body.mat];
  }

  begin(at: THREE.Vector3): void {
    ++this.ver;
    this.active = true;
    this.pts = [new THREE.Vector3(at.x, STROKE_Y, at.z)];
    this.startedAt = performance.now();
    this.body.u.uTail.value = 0;
    this.body.u.uOpacity.value = 1;
    this.body.u.uProgress.value = 1.02;
    this.body.u.uDry.value = 0;
    this.body.u.uSeed.value = Math.random();
    this.body.set([], () => 0);
    this.group.visible = true;
    // The brush touches down (80 ms) as the HUD's gold steps aside: one gold, never two at once.
    if (!this.anim.instant) {
      const ver = this.ver;
      this.body.u.uOpacity.value = 0;
      this.anim.tween({
        ms: 80,
        unscaled: true,
        ease: ease.outQuad,
        update: (v) => {
          if (ver === this.ver && this.active) this.body.u.uOpacity.value = v;
        },
      });
    }
  }

  /** Extend to a new pointer point on the board (world). */
  move(p: THREE.Vector3): void {
    if (!this.active) return;
    const last = this.pts[this.pts.length - 1];
    const d = Math.hypot(p.x - last.x, p.z - last.z);
    if (d < 0.12) return;
    // fill long jumps so the ribbon bends smoothly
    const steps = Math.min(12, Math.ceil(d / 0.35));
    for (let i = 1; i <= steps; i++) this.pts.push(new THREE.Vector3(last.x + ((p.x - last.x) * i) / steps, STROKE_Y, last.z + ((p.z - last.z) * i) / steps));
    // keep it bounded: thin out the oldest points
    while (this.pts.length > 190) this.pts.splice(1, 2);
    this.rebuild();
  }

  private rebuild(): void {
    // one Chaikin pass smooths the hand's wobble
    const src = this.pts;
    let pts = src;
    if (src.length > 3) {
      pts = [src[0]];
      for (let i = 0; i < src.length - 1; i++) {
        const a = src[i];
        const b = src[i + 1];
        pts.push(new THREE.Vector3(a.x * 0.75 + b.x * 0.25, STROKE_Y, a.z * 0.75 + b.z * 0.25), new THREE.Vector3(a.x * 0.25 + b.x * 0.75, STROKE_Y, a.z * 0.25 + b.z * 0.75));
      }
      pts.push(src[src.length - 1]);
      if (pts.length > 200) pts = pts.filter((_, i) => i % 2 === 0 || i === pts.length - 1);
    }
    // The arrow's profile in home-view px, mirrored: the round landing under the finger (u = 1), the dry
    // end back at the source (u = 0).
    const px = this.pxUnit;
    this.body.u.uPx.value = px;
    const L = this.body.set(
      pts,
      (u) => ribbonHalfPx(1 - u) * px,
      (u) => [ribbonHalfPx(1 - u), brushWidthPx(1 - u) / 2, u],
    );
    // the tail dries as the stroke grows
    this.body.u.uDry.value = Math.min(0.6, L / 30);
  }

  /**
   * Cancelled: the stroke dries out (200 ms). Settled (160 ms): it gives way to the armed arrow drawing its
   * last stretch underneath, so the finger end dries into the lifted hairs.
   */
  end(settle: boolean): void {
    if (!this.active && !this.group.visible) return;
    this.active = false;
    const ver = ++this.ver;
    if (this.anim.instant) {
      this.group.visible = false;
      return;
    }
    void this.startedAt;
    this.anim.tween({
      // Settling into the arrow is quick: the gold moves on to the commit button (one gold, INK A9).
      ms: settle ? 160 : 200,
      unscaled: true,
      ease: ease.inQuad,
      update: (v) => {
        if (ver !== this.ver) return;
        this.body.u.uTail.value = settle ? 0 : v * 1.05;
        this.body.u.uOpacity.value = 1 - v * (settle ? 1 : 0.5);
      },
      done: () => {
        if (ver === this.ver) this.group.visible = false;
      },
    });
  }

  dispose(): void {
    this.body.dispose();
  }
}

// ---------------------------------------------------------------------------
// Fortify route: a dotted ink line through the owned chain
// ---------------------------------------------------------------------------

export class FortifyRoute {
  group = new THREE.Group();
  /** Reduced motion: the route fades in whole (150 ms). */
  reduced = false;
  /** Where a territory's figure stands (world); the route runs figure to figure. Default: the anchor. */
  anchorOf: ((id: TerritoryId) => THREE.Vector3) | null = null;
  /** A walk is drawing the route: highlight changes (the controller clearing the armed route) leave it be. */
  private walking = 0;
  private line: BrushRibbon;
  key = '';
  private ver = 0;
  /** Kept for the view's resize hook (the route is a mesh now, not a screen-space line). */
  mats: { resolution: THREE.Vector2 }[] = [];

  constructor(
    private tiles: TileSet,
    private anim: Animator,
    noise: THREE.Texture,
  ) {
    this.line = new BrushRibbon(noise, hexToRgb(IVORY), 200, true);
    this.group.add(this.line.mesh);
    this.group.visible = false;
  }

  get materials(): THREE.Material[] {
    return [this.line.mat];
  }

  show(path: TerritoryId[]): void {
    if (this.walking) return;
    const key = path.join('>');
    if (key === this.key && this.group.visible) return;
    this.key = key;
    this.layout(path);
    const ver = ++this.ver;
    if (this.anim.instant) {
      this.line.u.uProgress.value = 1.02;
      return;
    }
    if (this.reduced) {
      this.line.u.uProgress.value = 1.02;
      this.line.u.uOpacity.value = 0;
      void this.anim.tween({ ms: 150, unscaled: true, ease: ease.outQuad, update: (v) => ver === this.ver && (this.line.u.uOpacity.value = 0.92 * v) });
      return;
    }
    this.line.u.uProgress.value = 0;
    void this.anim.tween({
      ms: Math.min(420, 160 + 60 * path.length),
      unscaled: true,
      ease: ease.outCubic,
      update: (v) => {
        if (ver === this.ver) this.line.u.uProgress.value = v * 1.02;
      },
    });
  }

  /**
   * The fortify move (B §4): the dotted route draws a little ahead of the walking figure and dries behind
   * it, over the walk's `ms`, then is gone. `ease` matches the walker's.
   */
  walk(path: TerritoryId[], ms: number, run: Run | null, e: (t: number) => number = ease.inOutSine): Promise<void> {
    if (this.anim.instant || (run && run.skipped) || path.length < 2) {
      this.hide();
      return Promise.resolve();
    }
    this.key = `walk:${path.join('>')}`;
    this.layout(path);
    const ver = ++this.ver;
    const w = ++this.walking;
    const end = () => {
      if (this.walking === w) this.walking = 0;
      if (ver === this.ver) this.hide();
    };
    const u = this.line.u;
    if (this.reduced) {
      u.uProgress.value = 1.02;
      u.uTail.value = 0;
      u.uOpacity.value = 0.92;
      return this.anim.tween({ ms, run, update: () => undefined }).then(end);
    }
    u.uProgress.value = 0.34;
    u.uTail.value = 0;
    u.uOpacity.value = 0.92;
    return this.anim
      .tween({
        ms,
        ease: ease.linear,
        run,
        update: (raw) => {
          if (ver !== this.ver) return;
          const v = e(raw);
          u.uProgress.value = Math.min(1.02, v * 1.02 + 0.34);
          u.uTail.value = Math.max(0, v - 0.24);
        },
      })
      .then(end);
  }

  private layout(path: TerritoryId[]): void {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < path.length; i++) {
      const a = (this.anchorOf ? this.anchorOf(path[i]) : this.tiles.get(path[i]).anchorW).clone();
      a.y = STROKE_Y;
      if (i > 0) {
        const prev = pts[pts.length - 1];
        const dx = a.x - prev.x;
        const dz = a.z - prev.z;
        const mid = prev.clone().add(a).multiplyScalar(0.5);
        mid.x -= dz * 0.1;
        mid.z += dx * 0.1;
        pts.push(mid);
      }
      pts.push(a);
    }
    // stop short of both numbers
    const trim = (p: THREE.Vector3, q: THREE.Vector3, d: number) => {
      const v = q.clone().sub(p);
      const l = v.length();
      if (l > 0.01) p.addScaledVector(v.normalize(), Math.min(d, l * 0.4));
    };
    if (pts.length >= 2) {
      trim(pts[0], pts[1], 0.7);
      trim(pts[pts.length - 1], pts[pts.length - 2], 0.9);
    }
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const sp = curve.getSpacedPoints(Math.min(190, Math.max(24, path.length * 24)));
    this.line.set(sp, () => 0.13);
    this.line.u.uTail.value = 0;
    this.line.u.uOpacity.value = 0.92;
    this.group.visible = true;
  }

  hide(): void {
    if (this.walking) return;
    if (!this.group.visible) {
      this.key = '';
      return;
    }
    this.key = '';
    const ver = ++this.ver;
    if (this.anim.instant) {
      this.group.visible = false;
      return;
    }
    void this.anim.tween({
      ms: 150,
      unscaled: true,
      ease: ease.inQuad,
      update: (v) => {
        if (ver === this.ver) {
          this.line.u.uTail.value = v;
          this.line.u.uOpacity.value = 0.92 * (1 - v);
        }
      },
      done: () => {
        if (ver === this.ver) this.group.visible = false;
      },
    });
  }

  dispose(): void {
    this.line.dispose();
  }
}

// ---------------------------------------------------------------------------
// [fight v5] The room goes cold for a breath (PROPOSAL §4 A "anticipation", SOUL "Feel")
// ---------------------------------------------------------------------------

const CHILL_VERT = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
const CHILL_FRAG = /* glsl */ `
uniform vec2 uRes;
uniform vec3 uCool;
uniform float uAmt;
uniform vec2 uFocus;
uniform float uFocusR;
void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 q = px / uRes - 0.5;
  q.x *= uRes.x / max(1.0, uRes.y) * 0.62;
  // the lamp's warm margins pull in and go cool: a tighter vignette than the cozy one (inkGlsl vigMask 0.24–0.8)
  float m = smoothstep(0.16, 0.7, length(q));
  // the paper right around the fight keeps its light (the fight is what you look at); the rest cools a shade
  float f = uFocusR > 0.0 ? smoothstep(uFocusR * 0.55, uFocusR * 1.6, distance(px, uFocus)) : 1.0;
  float a = uAmt * (0.06 * f + 0.2 * m);
  if (a < 0.002) discard;
  gl_FragColor = vec4(uCool, a);
}
`;

/**
 * A screen-space veil drawn over the board (after it, before the dice): during a fight the margins cool and
 * tighten and the paper away from the fight goes a shade colder. Paint only: an alpha wash of cold indigo,
 * never a light. `amt` 0..1 is driven by the board's lean (index.ts).
 */
export class ChillVeil {
  scene = new THREE.Scene();
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mat: THREE.ShaderMaterial;
  private mesh: THREE.Mesh;
  amt = 0;
  constructor() {
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uRes: { value: new THREE.Vector2(1, 1) },
        uCool: { value: new THREE.Vector3(0.012, 0.035, 0.1) },
        uAmt: { value: 0 },
        uFocus: { value: new THREE.Vector2(0, 0) },
        uFocusR: { value: 0 },
      },
      vertexShader: CHILL_VERT,
      fragmentShader: CHILL_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }
  get visible(): boolean {
    return this.amt > 0.002;
  }
  /** Drawing-buffer size and the fight's centre and radius in buffer px (y up, GL convention). */
  set(bufW: number, bufH: number, focus: [number, number] | null, radius: number): void {
    const u = this.mat.uniforms;
    (u.uRes.value as THREE.Vector2).set(bufW, bufH);
    u.uAmt.value = this.amt;
    if (focus) (u.uFocus.value as THREE.Vector2).set(focus[0], focus[1]);
    u.uFocusR.value = focus ? radius : 0;
  }
  get material(): THREE.Material {
    return this.mat;
  }
  dispose(): void {
    this.mat.dispose();
    this.mesh.geometry.dispose();
  }
}
