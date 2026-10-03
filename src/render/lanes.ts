// Visible water = adjacency (_claude/v3/PLAN.md §2): every sea lane is printed as a crossing — one silver
// hairline over the water you can see, with a short tick where it meets each shore — so "where can Ural
// attack?" answers itself from the board. At rest the crossings are quiet (paint, printed); they brighten
// with the selected territory, the armed attack's pair, and the hovered tile, then settle back (160 ms).
// Wrapped lanes (Alaska–Kamchatka) run off the board's edges; only their shore ends get a tick. The ticks sit
// on the lane's two shore points (`lane.shore`, map packs), so a crossing starts and ends on the coast.
import * as THREE from 'three';
import type { BoardGeometry, Vec2 } from '../map/types';
import type { TerritoryId } from '../engine/types';
import { Animator, ease } from './anim';
import { EDGE_PX } from './ink';
import { INK_COAST, TILE_TOP, hexToRgb, toWorld } from './util';

// v4 (PLAN E2 / E3 / E9): the crossing is the Hair weight (0.4 px at the home view, drawn as a 1 px ribbon at
// 0.4 coverage), carries the board's one brush (the same pen pressure as the coasts and outlines), and sits in
// Layer 3 at rest (≤ 15 % against the sea), Layer 2 when either shore is picked (30–60 %).
const QUAD_PX = 1.0;
const COVER = EDGE_PX.hair / QUAD_PX;
/** Opacity at rest and lit, before the hair's coverage (measured: rest ΔL* ≈ 12, lit ≈ 38 on the open sea). */
const REST = 0.36;
const LIT = 1.25;
/**
 * [place v5] Water that remembers (PROPOSAL §4 B): a lane a fight has crossed this game rests USED× brighter than
 * one never used (still Layer 3: ≤ 15 ΔL* on the open sea), and a crossing glints once as the fight starts: a
 * brightening that travels from the attacker's shore to the defender's over GLINT_MS (tier 1).
 */
const USED = 1.1;
export const GLINT_MS = 560;
const GLINT_A = 1.6;

const VERT = /* glsl */ `
attribute float aLane;
attribute float aSide;
attribute float aAlong;
attribute float aT;
uniform float uLit[32];
uniform float uUsed[32];
uniform vec2 uGlint[32];
uniform vec2 uBoard;
varying float vLit;
varying float vSide;
varying float vAlong;
varying vec2 vBP;
varying float vUsed;
varying float vGlint;
void main() {
  int li = int(aLane + 0.5);
  vLit = uLit[li];
  vUsed = uUsed[li];
  // the glint: x = its head along the lane (0 = a's shore … 1 = b's; −1 = none), y = ±1 its direction
  vec2 gl = uGlint[li];
  float along = gl.y < 0.0 ? 1.0 - aT : aT;
  vGlint = gl.x < -0.5 ? -9.0 : along - gl.x;
  vSide = aSide;
  vAlong = aAlong;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vBP = vec2(w.x + uBoard.x * 0.5, uBoard.y * 0.5 - w.z);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
const FRAG = /* glsl */ `
uniform vec3 uInk;
uniform float uRest;
uniform float uLitA;
uniform float uCover;
uniform float uUsedK;
uniform float uGlintA;
uniform sampler2D uNoise;
varying float vUsed;
varying float vGlint;
varying float vLit;
varying float vSide;
varying float vAlong;
varying vec2 vBP;
void main() {
  // a hairline, soft at its two edges, with the board's pen pressure along it (inkGlsl brushJit)
  float edge = 1.0 - smoothstep(0.35, 1.0, abs(vSide));
  float jit = 0.84 + 0.16 * smoothstep(0.3, 0.62, texture2D(uNoise, vBP / 1.3 + 0.61).a);
  float rest = uRest * mix(1.0, uUsedK, vUsed);
  // a soft bright band ~0.12 of the lane long, its tail a little longer than its head
  float g = vGlint < -8.0 ? 0.0 : exp(-pow(vGlint / (vGlint > 0.0 ? 0.08 : 0.14), 2.0));
  float a = edge * jit * uCover * (mix(rest, uLitA, vLit) + uGlintA * g);
  if (a < 0.004) discard;
  gl_FragColor = vec4(uInk * a, a);
}
`;

export class SeaLanes {
  group = new THREE.Group();
  private mat: THREE.ShaderMaterial;
  private mesh: THREE.Mesh | null = null;
  private lanes: { a: TerritoryId; b: TerritoryId }[] = [];
  private lit: number[];
  private goal: number[];
  /** [place v5] lanes a fight has crossed this game (1) and the running glints (head, direction). */
  private used: number[];
  private glints: THREE.Vector2[];
  private glintVer: number[];
  private ver = 0;
  /** Board units per CSS px at the home view (the hairline is the Hair weight, the ticks ~7 px). */
  private pxUnit = 1 / 12.7;

  constructor(
    private g: BoardGeometry,
    private anim: Animator,
    noise?: THREE.Texture,
  ) {
    const ink = hexToRgb(INK_COAST);
    this.lit = new Array(32).fill(0);
    this.goal = new Array(32).fill(0);
    this.used = new Array(32).fill(0);
    this.glints = Array.from({ length: 32 }, () => new THREE.Vector2(-1, 1));
    this.glintVer = new Array(32).fill(0);
    // (no noise texture: a flat mid-grey texel, so the pen pressure is even)
    const flat = new THREE.DataTexture(new Uint8Array([128, 128, 128, 128]), 1, 1, THREE.RGBAFormat);
    flat.needsUpdate = true;
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uLit: { value: this.lit.slice() },
        uUsed: { value: this.used },
        uGlint: { value: this.glints },
        uUsedK: { value: USED },
        uGlintA: { value: GLINT_A },
        uInk: { value: new THREE.Vector3(ink[0], ink[1], ink[2]) },
        uRest: { value: REST },
        uLitA: { value: LIT },
        uCover: { value: COVER },
        uNoise: { value: noise ?? flat },
        uBoard: { value: new THREE.Vector2(g.width, g.height) },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      premultipliedAlpha: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.lanes = g.seaLanes.slice(0, 32).map((l) => ({ a: l.a, b: l.b }));
    this.build();
  }

  /** Rebuild the ribbons for a new home scale (the weights are set in screen px). */
  setPxUnit(u: number): void {
    if (Math.abs(u - this.pxUnit) / this.pxUnit < 0.02) return;
    this.pxUnit = u;
    this.build();
  }

  private build(): void {
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
    }
    const pos: number[] = [];
    const lane: number[] = [];
    const side: number[] = [];
    const along: number[] = [];
    const tAt: number[] = [];
    const idx: number[] = [];
    // [place v5] each vertex's place along its whole lane (0 = a's shore, 1 = b's), for the glint
    let laneLen = 1;
    let laneAt = 0;
    let tickT: number | null = null;
    // (the ribbon is QUAD_PX wide; its soft edges leave a ~0.8 px core, drawn at the hair's coverage)
    const hw = (QUAD_PX / 2 + 0.25) * this.pxUnit;
    const tick = 3.6 * this.pxUnit;
    const y = TILE_TOP + 0.004;
    const quad = (a: Vec2, b: Vec2, h: number, li: number, s0: number) => {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const L = Math.hypot(dx, dy) || 1;
      const nx = (-dy / L) * h;
      const ny = (dx / L) * h;
      const base = pos.length / 3;
      const pts: [number, number, number][] = [
        [a[0] + nx, a[1] + ny, -1],
        [a[0] - nx, a[1] - ny, 1],
        [b[0] + nx, b[1] + ny, -1],
        [b[0] - nx, b[1] - ny, 1],
      ];
      pts.forEach(([x, z, sd], k) => {
        const w = toWorld(x, z, y);
        pos.push(w.x, w.y, w.z);
        lane.push(li);
        side.push(sd);
        along.push(s0 + (k >= 2 ? L : 0));
        tAt.push(tickT ?? Math.min(1, (laneAt + (k >= 2 ? L : 0)) / laneLen));
      });
      if (tickT === null) laneAt += L;
      idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      return L;
    };
    this.g.seaLanes.slice(0, 32).forEach((l, li) => {
      // The crossing starts on a's coast and ends on b's (the lane's two shore points, map packs; the
      // loader fills them from the polyline's ends when a board omits them). A polyline end that sits
      // near a shore point is moved onto it, so the hairline meets the coast exactly on every pack.
      const segs = l.segments.map((seg) => seg.map((p) => [p[0], p[1]] as Vec2));
      const shores: Vec2[] = l.shore ? [l.shore[0], l.shore[1]] : [segs[0][0], segs[segs.length - 1][segs[segs.length - 1].length - 1]];
      const ends: { p: Vec2; q: Vec2 }[] = [];
      for (const sh of shores) {
        let best: { seg: Vec2[]; i: number; d: number } | null = null;
        for (const seg of segs)
          for (const i of [0, seg.length - 1]) {
            const d = Math.hypot(seg[i][0] - sh[0], seg[i][1] - sh[1]);
            if (!best || d < best.d) best = { seg, i, d };
          }
        if (!best || best.seg.length < 2) continue;
        if (best.d < 1.5) best.seg[best.i] = [sh[0], sh[1]];
        else if (best.i === 0) best.seg.unshift([sh[0], sh[1]]);
        else best.seg.push([sh[0], sh[1]]);
        const at = best.d < 1.5 ? best.i : best.i === 0 ? 0 : best.seg.length - 1;
        const q = best.seg[at === 0 ? 1 : best.seg.length - 2];
        ends.push({ p: best.seg[at], q });
      }
      laneLen = 0;
      for (const seg of segs) for (let i = 1; i < seg.length; i++) laneLen += Math.hypot(seg[i][0] - seg[i - 1][0], seg[i][1] - seg[i - 1][1]);
      laneLen = Math.max(1e-3, laneLen);
      laneAt = 0;
      tickT = null;
      for (const seg of segs) {
        let s = 0;
        for (let i = 1; i < seg.length; i++) s += quad(seg[i - 1], seg[i], hw, li, s);
      }
      // a tick across the line at each shore point (a wrapped lane's board-edge ends have none)
      for (const [ei, { p, q }] of ends.entries()) {
        tickT = ends.length === 2 ? ei : Math.hypot(p[0] - shores[0][0], p[1] - shores[0][1]) < Math.hypot(p[0] - shores[1][0], p[1] - shores[1][1]) ? 0 : 1;
        const dx = q[0] - p[0];
        const dy = q[1] - p[1];
        const L = Math.hypot(dx, dy) || 1;
        const c: Vec2 = [p[0] + (dx / L) * 0.35 * tick, p[1] + (dy / L) * 0.35 * tick];
        const n: Vec2 = [-dy / L, dx / L];
        quad([c[0] - n[0] * tick, c[1] - n[1] * tick], [c[0] + n[0] * tick, c[1] + n[1] * tick], hw, li, 0.2);
      }
      tickT = null;
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aLane', new THREE.Float32BufferAttribute(lane, 1));
    geo.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
    geo.setAttribute('aAlong', new THREE.Float32BufferAttribute(along, 1));
    geo.setAttribute('aT', new THREE.Float32BufferAttribute(tAt, 1));
    geo.setIndex(idx);
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    // over the paper and the washes, under the pieces (8+) and the strokes (20)
    this.mesh.renderOrder = 3;
    this.group.add(this.mesh);
  }

  /** Brighten the crossings that touch `ids` (the selected territory, an armed pair, the hovered tile). */
  light(ids: Iterable<TerritoryId>): void {
    const set = new Set(ids);
    let changed = false;
    this.lanes.forEach((l, i) => {
      const g = set.has(l.a) || set.has(l.b) ? 1 : 0;
      if (g !== this.goal[i]) {
        this.goal[i] = g;
        changed = true;
      }
    });
    if (!changed) return;
    const from = this.lit.slice();
    const ver = ++this.ver;
    void this.anim.tween({
      ms: 160,
      ease: ease.outQuad,
      unscaled: true,
      update: (v) => {
        if (ver !== this.ver) return;
        for (let i = 0; i < 32; i++) this.lit[i] = from[i] + (this.goal[i] - from[i]) * v;
        (this.mat.uniforms.uLit.value as number[]).splice(0, 32, ...this.lit);
      },
    });
  }

  /** [place v5] The lane between two territories (either order), or −1. */
  laneOf(x: TerritoryId, y: TerritoryId): number {
    return this.lanes.findIndex((l) => (l.a === x && l.b === y) || (l.a === y && l.b === x));
  }

  /**
   * [place v5] A fight crosses the lane `from`–`to`: it is remembered (one shade brighter at rest from now on) and,
   * unless `still` (reduced motion, instant speed), glints once from `from`'s shore to `to`'s. Resolves when the
   * glint has crossed; returns null when the two are not joined by a lane.
   */
  cross(from: TerritoryId, to: TerritoryId, still = false): Promise<void> | null {
    const i = this.laneOf(from, to);
    if (i < 0) return null;
    this.used[i] = 1;
    if (still) return Promise.resolve();
    const g = this.glints[i];
    g.y = this.lanes[i].a === from ? 1 : -1;
    const ver = ++this.glintVer[i];
    return this.anim.tween({
      ms: GLINT_MS,
      ease: ease.inOutSine,
      update: (v) => {
        if (ver !== this.glintVer[i]) return;
        g.x = -0.2 + 1.4 * v;
      },
      done: () => {
        if (ver === this.glintVer[i]) g.x = -1;
      },
    });
  }

  /** [place v5] Forget every crossing (a new game). */
  forget(): void {
    this.used.fill(0);
    for (const g of this.glints) g.x = -1;
  }

  /** Test hook: how lit each lane is, by its two ends (+ [place v5] used this game, a glint's head or −1). */
  state(): { a: TerritoryId; b: TerritoryId; lit: number; used: boolean; glint: number }[] {
    return this.lanes.map((l, i) => ({ ...l, lit: this.lit[i], used: this.used[i] > 0, glint: this.glints[i].x }));
  }

  dispose(): void {
    this.mesh?.geometry.dispose();
    this.mat.dispose();
  }
}
