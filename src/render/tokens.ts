// Army pieces (_claude/v3/PLAN.md §1, John 2026-09-30 via the lead: "one medium — everything on the board is
// painted, including the pieces"): each territory's army is ONE painted stone set on the paper, in the same hand
// that painted the coasts. A stone is a slightly irregular ellipse (a brushed wobble, fixed per territory)
// filled with the seat's colour as a flat wash (laid on thicker than the territory's own, so it stands off it), a 1 px ink edge in the seat's deep tone, and one darker
// wash stroke offset ~1.5 px lower-right for its shadow — painted, never blurred, no gradient, no highlight.
// A piece is a thing because it has an edge, a painted shadow, and it moves, not because it is lit.
//
// Size is strength (v4 stone scale law, _claude/v4/PLAN.md §6, review 2026-09-30 §1): area-linear and steep,
// d ∝ √n from 1 to 20 armies: ≈ 10 px for 1 → 22 for 5 → 32 for 10 → 44 for 20+ at the 1440×900 home (the
// board scales the pair per device; phones run a flatter pair). A big stone may cross a neighbour's border
// (decision Q9); the only per-territory caps (set from the home view by index.ts, `piecesClash`) keep a stone,
// a figure or a numeral from covering another territory's numeral, and two figures from standing on each other
// (pieceEnvelope below is the box the caps are fitted with).
//
// The piece (John 2026-09-30, "Bring the icons back"; SOUL touchstone units-place.png: the pale ivory brush
// figure on an owner-coloured blot — the stone is the blot): the unit figure STANDS ON the stone, centred,
// scaled to it. Soldier 1–4 armies, rider 5–9, cannon 10+, from the ivory brush atlas (dark strokes in the
// seat's deep ink, light in ivory). Its long side is FIG_K × the stone's diameter (a 1-army soldier on the
// 18 px stone is ~20 px tall at 1440×900; a cannon on a 36 px stone ~40 px across); its feet sit FEET × the
// radius below the centre, on a small darker-wash shadow that runs into the stone's own lower-right shadow.
// Flat, unlit, the same hand as the coasts. The numeral is DOM (overlay.ts): small ivory, at the stone's
// lower-right edge (figTop() is its point, numeralSize() its height), never on the figure.
//
// Motion (the same beats as before; Pillar 5):
//   place       the stone swells as the wash soaks in (≤ 200 ms), the figure swelling with it (on a new stone it
//               fades up as the stone grows); the wood click lands as it starts
//   band        4→5, 9→10 (and back): the old figure dissolves and the new one inks in from the feet, 160 ms
//   loss        the figure puffs ink smoke, then the stone shrinks a step (inside the verdict)
//   empty       at 0 the figure goes to smoke and the stone dries back to paper (320 ms; a seat's last ~1.2 s)
//   traveller   a stone and its figure slide together along the stroke (or the fortify route) and settle
//   preview     a ghost stone at the size a count would leave (occupy / fortify / staged); if that count is in
//               another band (or the stone is empty), the figure it would be stands as a ghost in the real one's place
// In a fight the two figures turn to face each other, the attacker leans in, a hit knocks one back.
import * as THREE from 'three';
import type { TerritoryId } from '../engine/types';
import { TERRITORY_IDS } from '../engine/mapData';
import { Animator, ease, type Run } from './anim';
import { IVORY, TILE_TOP, hexToRgb, type RGB } from './util';
import { deepOf, type TileSet } from './tiles';
import { loadTexmap } from './texmaps';
import ATLAS from './unitsAtlas.json';

/** 0 = infantry (1–4), 1 = cavalry (5–9), 2 = artillery (10+): the figure standing on the stone. */
export type Denom = 0 | 1 | 2;
export const denomOf = (n: number): Denom => (n >= 10 ? 2 : n >= 5 ? 1 : 0);
export const DENOM_NAMES = ['infantry', 'cavalry', 'artillery'] as const;

/** The count past which a stone stops growing (the numeral carries the rest): 20+ is the largest stone. */
export const STONE_FULL = 20;
/**
 * A stone's diameter for a count: dmin at 1, dmax at STONE_FULL, √n between (area-linear: a stone's area is
 * its army). With the desktop pair 10 / 44: 1 → 10, 5 → 22, 10 → 31, 20+ → 44 px.
 */
export function stoneK(n: number, dmin: number, dmax: number): number {
  if (n <= 0) return 0;
  const k = (Math.sqrt(Math.min(Math.max(n, 1), STONE_FULL)) - 1) / (Math.sqrt(STONE_FULL) - 1);
  return dmin + (dmax - dmin) * k;
}
/** Kept for the overlay's numeral box: a stone's numeral box is 70 % of its diameter tall. */
export const DISC_E = 0.7;
/** Kept for callers of the old API. */
export const HEIGHT_CAP = 1;
export const TOKEN_R = 1.1;
export const TOKEN_H = 0;
/** Kept for callers of the old stack API (tests): the chips a count would be. */
export function discsOf(n: number): { thick: number; thin: number } {
  if (n <= 0) return { thick: 0, thin: 0 };
  if (n <= 5) return { thick: 0, thin: n };
  return { thick: Math.floor(n / 5), thin: n % 5 };
}

/** Kept for callers of the old API: the free-standing fight figure heights (board units). */
const FIG_H = [3.45, 3.3, 1.9];
const SPRITES = [ATLAS.sprites.soldier, ATLAS.sprites.rider, ATLAS.sprites.cannon];
const ASPECT = SPRITES.map((s) => s.w / s.h);

// --- the figure on the stone (units of the stone's diameter / radius) -------------------------------------
/** The figure's long side (height for the soldier and rider, width for the cannon) ÷ the stone's diameter. */
export const FIG_K = 1.1;
/** The figure's feet, below the stone's centre, × its radius. */
export const FEET = 0.4;
/** Kept for callers of the old API: the numeral's centre from the stone's centre, × its radius (now numOffset). */
export const NUM_AT: readonly [number, number] = [0.98, 0.8];
/**
 * Where the numeral sits (v4): straddling the stone's lower-right edge, its left edge NUM_IN × R right of the
 * centre and its top NUM_TOP × R below it (the figure's feet are at FEET × R), so the digit never stands on the
 * figure whatever the band. Px about the stone's centre (y down); `side` −1 mirrors it to the lower-left.
 */
export const NUM_IN = 0.5;
export const NUM_TOP = 0.36;
export function numOffset(R: number, nw: number, nh: number, side = 1): [number, number] {
  return [side * (NUM_IN * R + nw / 2), NUM_TOP * R + nh / 2];
}
/** The small soldier's opacity (the squint guard's lever: thinner than a rider, never a smaller stone). */
export const SOLDIER_ALPHA = 0.85;
/** The smallest figure a crowded layout may draw (× the stone's diameter), after the stone is at its floor. */
export const FIG_K_MIN = 0.7;
/** The figure's width and height for a stone `d` across (any unit); `k` = its long side ÷ d. */
export function figDims(denom: Denom, d: number, k = FIG_K): [number, number] {
  const long = k * d;
  return denom === 2 ? [long, long / ASPECT[2]] : [long * ASPECT[denom], long];
}
/**
 * The numeral's smallest size, CSS px (× the text size): the v4 type scale's numeral floor (PLAN §5b E6, review
 * §1): 18 px at 1440 on desktop, 12 px on phones (TokenSystem.numMin, set per device by index.ts). Never squashed.
 */
export const NUMERAL_MIN = 18;
export const NUMERAL_MIN_PHONE = 12;
/** The numeral's top size, CSS px (the type scale's 24 step), on the largest stones. */
export const NUMERAL_MAX = 24;
/** The numeral's height (CSS px at the home view) on a stone `d` px across: the floor, to ~22 on a 20+ stone. */
export function numeralPxFor(d: number, s = 1, min = NUMERAL_MIN): number {
  return Math.min(NUMERAL_MAX * s, Math.max(min * s, 0.3 * d + 9));
}
/** The DOM numeral's box for a font size (as overlay.ts lays it out): [w, h]. */
export function numeralBox(fs: number, digits: number): [number, number] {
  return [fs * (0.52 * digits + 0.14), fs * 0.95];
}
export type PxBox = [number, number, number, number];
/**
 * The three parts of a piece at the home view, CSS px about its anchor (y down): the stone, the figure and
 * the numeral, for a count on a stone `d` across. The caps (index.ts fitCaps) and the table check use it.
 */
export function pieceBoxes(n: number, d: number, s = 1, k = FIG_K, side = 1, numMin = NUMERAL_MIN): { stone: PxBox; fig: PxBox; num: PxBox } {
  const R = d / 2;
  const [w, h] = figDims(denomOf(n), d, k);
  const feet = FEET * R;
  const fs = numeralPxFor(d, s, numMin);
  const [nw, nh] = numeralBox(fs, String(n).length);
  const [cx, cy] = numOffset(R, nw, nh, side);
  return { stone: [-R, -R, R, R], fig: [-w / 2, feet - h, w / 2, feet], num: [cx - nw / 2, cy - nh / 2, cx + nw / 2, cy + nh / 2] };
}
/**
 * PIECE_AIR px of air between parts: the drawn boxes snap to the device grid, the stones lie a hair foreshortened
 * and a tilted phone view stretches the numeral's box against the model's.
 */
export const PIECE_AIR = 2.5;
export function boxesHit(a: PxBox, b: PxBox, air = PIECE_AIR): boolean {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]) + air;
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]) + air;
  return w > 0 && h > 0;
}
/**
 * The v4 cap rule (review §1, decision Q9): two pieces clash only where one would hide the other's count (any
 * part of one over the other's numeral) or two figures would stand on each other. A stone over a neighbour's
 * stone or border is allowed: a big army spreads past its border.
 */
export function piecesClash(A: { stone: PxBox; fig: PxBox; num: PxBox }, B: { stone: PxBox; fig: PxBox; num: PxBox }, air = PIECE_AIR): boolean {
  return (
    boxesHit(A.num, B.num, air) ||
    boxesHit(A.num, B.fig, air) ||
    boxesHit(A.num, B.stone, air) ||
    boxesHit(A.fig, B.num, air) ||
    boxesHit(A.stone, B.num, air) ||
    boxesHit(A.fig, B.fig, air)
  );
}
const grow = (a: PxBox, b: PxBox): PxBox => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
/**
 * The count buckets the caps are fitted for (v4): a territory's caps hold for every count up to the top of its
 * bucket, so they are refitted only when a stone crosses into the next bucket (not on every army).
 */
export const CAP_BUCKETS = [2, 4, 6, 9, 12, 16, 20, 99] as const;
export const capBucket = (n: number): number => CAP_BUCKETS.find((b) => n <= b) ?? 99;
/**
 * The union of a territory's piece parts over every count 1–`maxN` (default 99: count-independent) when its
 * stone is capped at `cap` px (dmin/dmax: the 1 → 20 sizes, already × sizeScale). A cap that clears this
 * clears every count up to maxN.
 */
export function pieceEnvelope(cap: number, dmin: number, dmax: number, s = 1, k = FIG_K, side = 1, numMin = NUMERAL_MIN, maxN = 99): { stone: PxBox; fig: PxBox; num: PxBox } {
  let out: { stone: PxBox; fig: PxBox; num: PxBox } | null = null;
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30, 99, maxN]) {
    if (n > maxN) continue;
    const d = Math.min(stoneK(n, dmin, dmax), Math.max(dmin, cap));
    const b = pieceBoxes(n, d, s, k, side, numMin);
    out = out ? { stone: grow(out.stone, b.stone), fig: grow(out.fig, b.fig), num: grow(out.num, b.num) } : b;
  }
  return out!;
}
const MAX_TRAVELERS = 8;
/** The loser's ring (v4 A4): its centre line this many px outside the stone's edge at the home view. */
const RING_GAP_PX = 3.5;
/** The receipt pulse (v4 A3): one tier-0 swell, this long at 1×, the stone this much larger at its height. */
export const PULSE_MS = 260;
const PULSE_SWELL = 0.22;
const STONE_CAP = TERRITORY_IDS.length * 2;
const FIG_CAP = TERRITORY_IDS.length * 2;
const BLOT_CAP = TERRITORY_IDS.length;
const IVORY_RGB = hexToRgb(IVORY);

export interface TokenTraveler {
  /** Count carried (drawn as the traveller's number). */
  n: number;
  /** Number color (the mover's palette ink). */
  ink: string;
  /** World position of the traveller's centre on the paper (updated every frame while it slides). */
  top: THREE.Vector3;
  plaque: THREE.Vector3;
  /** Its numeral's point (the stone's lower-right edge). */
  figTop: THREE.Vector3;
  /** The stone's radius, world units. */
  halfW: number;
  /** The numeral's height at the home view, world units (the overlay scales it with the zoom). */
  numH: number;
  /** The mover's palette id. */
  owner: string;
  denom: Denom;
  alive: boolean;
}

interface Tok {
  id: TerritoryId;
  col: RGB;
  deep: RGB;
  /** The engine count this piece ends at. */
  n: number;
  /** The count the stone reads (its numeral, the test hook). */
  shown: number;
  /** The count the stone's size shows right now (a float while it swells or shrinks). */
  disp: number;
  /** 0..1 presence. */
  alpha: number;
  /** Drying back to paper, 0..1 (emptied, conquered, eliminated). */
  dry: number;
  /** The wash soaking in (placement), 0..1: a brief deepening of the fill. */
  soak: number;
  /** Ghost total (preview), or null. */
  preview: number | null;
  /** v4 A4: the loser's ring colour (its pigment), or null. */
  ring: RGB | null;
  /** v4 A3: the receipt's pulse, 0..1 (a tier-0 swell of the stone). */
  swell: number;
  // --- the figure on the stone
  /** Presence 0..1 (1 whenever the stone stands; 0 once it has gone to smoke). */
  fig: number;
  denom: Denom;
  reveal: number;
  figOld: { denom: Denom; dry: number } | null;
  figSmoke: number;
  puff: number;
  figOffX: number;
  figOffY: number;
  lean: number;
  flip: number;
  frozen: { col: RGB; deep: RGB } | null;
  pendingColor: { col: RGB; deep: RGB } | null;
  ver: Record<string, number>;
  seed: number;
  /** World centre of the stone, refreshed by update(). */
  top: THREE.Vector3;
  plaque: THREE.Vector3;
  /** The numeral's point: the stone's lower-right edge. */
  figTop: THREE.Vector3;
  halfW: number;
  /** The numeral's height at home, world units. */
  numH: number;
  /** The piece's extent about its centre, world units in screen directions: left, up, right, down. */
  ext: [number, number, number, number];
}

interface Traveler extends TokenTraveler {
  /** Where it's going (its stone takes that territory's cap). */
  to: TerritoryId;
  col: RGB;
  deep: RGB;
  pts: THREE.Vector3[];
  cum: number[];
  t: number;
  flip: number;
  seed: number;
}

// ---------------------------------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------------------------------

/** The stone lies flat on the paper (world XZ), its quad a little bigger than it for the wobble and shadow. */
const STONE_VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iSize;
attribute vec4 iCol;
attribute vec3 iDeep;
attribute vec4 iFx;
attribute vec4 iRing;
varying vec2 vP;
varying vec4 vSize;
varying vec4 vCol;
varying vec3 vDeep;
varying vec4 vFx;
varying vec4 vRing;
void main() {
  // (a loser's ring (v4 A4) sits a few px outside the stone: the quad grows to hold it)
  float M = max(1.35, iRing.w + 0.3);
  float R = iSize.x;
  vP = position.xy * 2.0 * M;
  vec3 w = iPos + vec3(position.x * 2.0 * M * R + iFx.x, 0.0, -position.y * 2.0 * M * R + iFx.y);
  vSize = iSize;
  vCol = iCol;
  vDeep = iDeep;
  vFx = iFx;
  vRing = iRing;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;

const STONE_FRAG = /* glsl */ `
uniform sampler2D uNoise;
uniform vec3 uPaper;
varying vec2 vP;
varying vec4 vSize;
varying vec4 vCol;
varying vec3 vDeep;
varying vec4 vFx;
varying vec4 vRing;
float nrm(float v) { return clamp((v - 0.22) * 1.8, 0.0, 1.0); }
// the stone's brushed wobble: a few low harmonics, fixed per territory
float wob(vec2 p, float seed) {
  float a = atan(p.y, p.x);
  return 1.0 + 0.045 * sin(2.0 * a + seed * 6.3) + 0.035 * sin(3.0 * a + seed * 11.1) + 0.02 * sin(5.0 * a + seed * 3.7);
}
void main() {
  float seed = vSize.y;
  float ghost = vSize.z;
  float dry = vSize.w;
  vec2 p = vP;
  // the paper's pixel, in stone radii
  float fw = max(fwidth(length(p)), 1e-4);
  float d = length(p) / wob(p, seed);
  // a painted shadow: the same shape one and a half pixels to the lower right (screen: +x, south = -p.y)
  vec2 q = p - vec2(1.6 * fw, -1.6 * fw);
  float ds = length(q) / wob(q, seed);
  float inside = 1.0 - smoothstep(1.0 - 0.7 * fw, 1.0 + 0.3 * fw, d);
  float shadowIn = 1.0 - smoothstep(1.0 - 0.7 * fw, 1.0 + 0.3 * fw, ds);
  float shadow = shadowIn * (1.0 - inside);
  // the loser's ring (v4 A4, edge ladder Hair): a thin closed brush line in the loser's pigment, a few px out
  float ringA = 0.0;
  if (vRing.w > 0.0) {
    float rd = abs(d - vRing.w) / fw;
    vec4 rn = texture2D(uNoise, p * 0.31 + seed * 1.7);
    ringA = (1.0 - smoothstep(0.45, 1.15, rd)) * (0.78 + 0.22 * nrm(rn.r)) * vCol.a * (1.0 - dry);
  }
  if (inside < 0.004 && shadow < 0.004 && ringA < 0.004) discard;
  // the fill: a flat wash of the seat's base (a hair of paper grain, like every wash on the board)
  vec4 nz = texture2D(uNoise, p * 0.18 + seed);
  // (more pigment than the territory's own wash: the same colour, laid on thicker, so the stone stands off it)
  vec3 fill = mix(vCol.rgb, vDeep, 0.5) * (1.0 + 0.03 * (nrm(nz.a) - 0.5));
  // the wash soaking in (placement): the pigment deepens for a moment
  fill = mix(fill, vDeep, 0.35 * vFx.z);
  // the ink edge: ~1 px in the seat's deep tone, just inside the outline, a little uneven like the coasts
  float edgeW = (1.0 + 0.35 * (nrm(nz.g) - 0.5)) * fw;
  float edge = 1.0 - smoothstep(0.35 * edgeW, 1.25 * edgeW, 1.0 - d);
  vec3 ink = vDeep * 0.8;
  vec3 col = mix(fill, ink, edge * 0.9);
  float a = inside;
  if (ghost > 0.5) {
    // a ghost: the edge, and only a breath of wash
    col = mix(vCol.rgb, ink, edge);
    a *= mix(0.22, 0.85, edge);
  }
  // drying back to paper: the pigment lifts in patches, the edge last
  if (dry > 0.0) {
    float e = nrm(nz.b) * 0.75 + 0.25 * nrm(nz.r);
    float keep = smoothstep(dry * 1.15 - 0.15, dry * 1.15, e + 0.25 * edge);
    a *= keep;
    col = mix(col, mix(uPaper, vec3(0.8, 0.79, 0.76), 0.2), dry * 0.5);
  }
  float dim = min(vFx.w, 1.3);
  col *= 1.0 - 0.14 * dim;
  a *= vCol.a * (1.0 - 0.08 * dim);
  // the shadow stroke: a darker wash of the seat's deep (on the paper under it), never blurred
  float sa = shadow * 0.55 * vCol.a * (1.0 - dry) * (1.0 - 0.8 * ghost);
  vec3 sc = vDeep * 0.42;
  // stone over shadow (premultiplied), the ring beside both
  vec3 outC = col * a + sc * sa * (1.0 - a);
  float outA = a + sa * (1.0 - a);
  outC += vRing.rgb * ringA * (1.0 - outA);
  outA += ringA * (1.0 - outA);
  if (outA < 0.004) discard;
  gl_FragColor = vec4(outC, outA);
}
`;

const FIG_VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec2 iSize;
attribute vec4 iUV;
attribute vec4 iA;
attribute vec4 iB;
attribute vec4 iC;
attribute vec2 iOff;
varying vec2 vSt;
varying vec4 vUV;
varying vec4 vA;
varying vec4 vB;
varying vec4 vC;
const float PADX = 0.3;
const float PADY = 0.1;
void main() {
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  float smoke = iA.z;
  float grow = 1.0 + 1.3 * smoke;
  float widen = 1.0 + 0.6 * smoke;
  // (the quad runs a little past the sprite so its hairline (E7) has room outside the drawing)
  float qx = position.x * (1.0 + 2.0 * PADX);
  float qy = position.y * (1.0 + 2.0 * PADY) - PADY;
  vSt = vec2(qx + 0.5, qy * grow);
  vec2 p = vec2(qx * iSize.x * widen, qy * grow * iSize.y);
  float c = cos(iB.x);
  float s = sin(iB.x);
  p = vec2(p.x * c + p.y * s, -p.x * s + p.y * c);
  vec3 w = iPos + right * (p.x + iOff.x) + up * (p.y + iOff.y);
  vUV = iUV;
  vA = iA;
  vB = iB;
  vC = iC;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;

const FIG_FRAG = /* glsl */ `
uniform sampler2D uAtlas;
uniform sampler2D uNoise;
uniform sampler2D uSmoke;
uniform float uSmokeOn;
uniform vec3 uIvory;
uniform vec2 uAtlasPx;
varying vec2 vSt;
varying vec4 vUV;
varying vec4 vA;
varying vec4 vB;
varying vec4 vC;
float nrm(float v) { return clamp((v - 0.22) * 1.8, 0.0, 1.0); }
// the drawing at a point of the sprite (0..1 both ways; nothing outside it)
vec4 samp(vec2 q) {
  // (two atlas texels in from the sprite's box: the crop leaves a faint frame on its very edge)
  vec2 e = 2.0 / max(abs(vec2(vUV.z - vUV.x, vUV.w - vUV.y)) * uAtlasPx, vec2(1.0));
  if (q.x < e.x || q.x > 1.0 - e.x || q.y < e.y || q.y > 1.0 - e.y) return vec4(0.0);
  float fx = vB.y < 0.0 ? 1.0 - q.x : q.x;
  return texture2D(uAtlas, vec2(mix(vUV.x, vUV.z, fx), mix(vUV.y, vUV.w, q.y)));
}
// the drawing's own strokes only (the atlas's faint margins never grow a hairline)
float edgeA(vec2 q) { return smoothstep(0.2, 0.6, samp(q).a); }
void main() {
  float smoke = vA.z;
  float seed = vB.w;
  vec2 sp = vec2((vSt.x - 0.5) * (1.0 + 0.6 * smoke) + 0.5, vSt.y);
  vec2 sc = vec2(sp.x * 0.5 + seed, sp.y * 0.4 - smoke * 0.45 + seed * 0.37);
  vec4 nz = texture2D(uNoise, sc);
  if (smoke > 0.0 && uSmokeOn > 0.5) {
    nz.r = texture2D(uSmoke, vec2(sc.x, -sc.y)).r;
    vec2 s2 = sc * vec2(1.0, 0.8) + vec2(0.37, 0.61);
    nz.g = texture2D(uSmoke, vec2(s2.x, -s2.y)).r;
    vec2 s3 = sc * 1.6 + vec2(0.71, 0.13);
    nz.b = texture2D(uSmoke, vec2(s3.x, -s3.y)).r;
  }
  if (smoke > 0.0) {
    float rise = smoke * (0.4 + 0.95 * nrm(nz.r)) * (0.3 + 0.7 * clamp(sp.y, 0.0, 1.3));
    sp.y -= rise;
    sp.x += (nrm(nz.g) - 0.5) * 0.9 * smoke * (0.15 + sp.y);
  }
  if (sp.x < -0.3 || sp.x > 1.3 || sp.y < -0.1 || sp.y > 1.1) discard;
  vec4 tex = samp(sp);
  // (the lossy atlas leaves a faint veil inside each sprite's box: never drawn)
  float body = tex.a * smoothstep(0.08, 0.22, tex.a);
  // E7 (v4): a hairline of the seat's deep tone round the figure, heavier on its lamp-shadow side (the lower
  // right, E1's one light), so the ivory reads on any wash: one screen pixel, never a glow.
  vec2 f1 = max(fwidth(sp), vec2(1e-4)) * 1.1;
  float ring = 0.0;
  ring = max(ring, edgeA(sp + vec2(f1.x, 0.0)));
  ring = max(ring, edgeA(sp - vec2(f1.x, 0.0)));
  ring = max(ring, edgeA(sp + vec2(0.0, f1.y)));
  ring = max(ring, edgeA(sp - vec2(0.0, f1.y)));
  float under = max(edgeA(sp + vec2(-f1.x, f1.y) * 1.5), edgeA(sp + vec2(0.0, f1.y) * 1.8));
  float hair = max(ring * 0.8, under) * (1.0 - smoke);
  float a = body + hair * (1.0 - body);
  if (a < 0.02) discard;
  vec3 rgb = tex.rgb / max(tex.a, 0.001);
  float L = dot(rgb, vec3(0.299, 0.587, 0.114));
  // pale ivory figures with the ink only in the drawing's darkest strokes (the touchstone's, not a dark silhouette)
  float k = smoothstep(0.06, 0.42, L);
  vec3 deep = vC.rgb * 0.38 + vec3(0.012, 0.016, 0.03);
  vec3 ivory = uIvory * (1.0 + 0.07 * vB.z);
  deep *= 1.0 - 0.35 * vB.z;
  vec3 col = mix(deep, ivory, k);
  vec3 hairCol = vC.rgb * 0.5 + vec3(0.006, 0.008, 0.015);
  col = mix(hairCol, col, body / max(a, 1e-4));
  float rv = vA.y;
  if (rv < 0.999) {
    float rn = texture2D(uNoise, vec2(sp.x * 1.3 + seed * 3.1, sp.y * 0.35 + seed)).b;
    float front = rv * 1.2 - 0.1;
    a *= 1.0 - smoothstep(front - 0.07, front, sp.y + (nrm(rn) - 0.5) * 0.18);
  }
  float dry = vA.w;
  if (dry > 0.0) {
    float dn = nrm(texture2D(uNoise, vec2(sp.x * 0.9 + seed * 1.7, sp.y * 0.8)).a);
    a *= smoothstep(dry * 1.15 - 0.15, dry * 1.15, dn * 0.8 + 0.2 * (1.0 - sp.y)) * (1.0 - 0.35 * dry);
  }
  if (smoke > 0.0) {
    float e = nrm(nz.b);
    a *= smoothstep(smoke * 0.95 - 0.3, smoke * 0.95, e * 0.7 + 0.3 * (1.0 - vSt.y / (1.0 + 1.3 * smoke)));
    a *= 1.0 - smoke * smoke * 0.75;
    col = mix(col, vec3(0.8, 0.79, 0.76), min(1.0, smoke * 1.3) * 0.85);
  }
  float dim = min(vC.w, 1.0);
  a *= vA.x * (1.0 - 0.12 * dim);
  col *= 1.0 - 0.15 * dim;
  if (a < 0.004) discard;
  gl_FragColor = vec4(col * a, a);
}
`;

/** Soft flat marks on the paper: the fight figures' ground blots. */
const BLOT_VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec3 iR;
attribute vec4 iCol;
attribute vec2 iK;
varying vec2 vP;
varying vec4 vCol;
varying vec2 vK;
void main() {
  vP = position.xy * 2.0;
  vCol = iCol;
  vK = iK;
  vec3 w = iPos + vec3(position.x * 2.0 * iR.x, 0.0, -position.y * 2.0 * iR.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;

const BLOT_FRAG = /* glsl */ `
uniform sampler2D uNoise;
varying vec2 vP;
varying vec4 vCol;
varying vec2 vK;
float nrm(float v) { return clamp((v - 0.22) * 1.8, 0.0, 1.0); }
void main() {
  float seed = vK.y;
  float d = length(vP);
  float a;
  if (vK.x > 1.5) {
    // a contact shadow: dense under the stack, feathering out
    a = (1.0 - smoothstep(0.25, 1.0, d));
    a *= a;
  } else {
    vec4 n = texture2D(uNoise, vP * 0.22 + seed);
    float edge = d + (nrm(n.g) - 0.5) * 0.42 + (nrm(n.a) - 0.5) * 0.14;
    a = 1.0 - smoothstep(0.52, 0.98, edge);
    a *= 0.72 + 0.28 * nrm(n.r);
    a *= 0.85 + 0.15 * smoothstep(-0.9, 0.4, vP.y);
  }
  a *= vCol.a;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vCol.rgb * a, a);
}
`;

class Instanced {
  geo: THREE.InstancedBufferGeometry;
  attrs: Record<string, THREE.InstancedBufferAttribute> = {};
  mesh: THREE.Mesh;
  k = 0;
  constructor(
    base: THREE.BufferGeometry,
    spec: Record<string, number>,
    private cap: number,
    mat: THREE.Material,
  ) {
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = base.index;
    this.geo.setAttribute('position', base.getAttribute('position'));
    for (const [name, size] of Object.entries(spec)) {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      this.attrs[name] = a;
      this.geo.setAttribute(name, a);
    }
    this.geo.instanceCount = 0;
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
  }
  next(): boolean {
    return this.k < this.cap;
  }
  set(name: string, ...v: number[]): void {
    const a = this.attrs[name];
    const arr = a.array as Float32Array;
    const o = this.k * a.itemSize;
    for (let i = 0; i < v.length; i++) arr[o + i] = v[i];
  }
  push(): void {
    this.k++;
  }
  commit(): void {
    this.geo.instanceCount = this.k;
    for (const a of Object.values(this.attrs)) {
      a.needsUpdate = true;
      a.addUpdateRange(0, this.k * a.itemSize);
    }
    this.k = 0;
  }
  get count(): number {
    return this.geo.instanceCount;
  }
  dispose(): void {
    this.geo.dispose();
  }
}

// ---------------------------------------------------------------------------------------------------

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
};

/** A gentle bow between two points (to the stroke's left), as the attack arrow draws it (fx.ts `bow`). */
function bowPts(a: THREE.Vector3, b: THREE.Vector3, k: number, n = 24): THREE.Vector3[] {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1;
  const cx = (a.x + b.x) / 2 - (dz / len) * len * k;
  const cz = (a.z + b.z) / 2 + (dx / len) * len * k;
  const out: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const m = 1 - t;
    out.push(new THREE.Vector3(m * m * a.x + 2 * m * t * cx + t * t * b.x, a.y + (b.y - a.y) * t, m * m * a.z + 2 * m * t * cz + t * t * b.z));
  }
  return out;
}


/** The stone's wash: the seat's own base colour. */
function lacquer(tile: RGB): RGB {
  return [tile[0], tile[1], tile[2]];
}

export class TokenSystem {
  group = new THREE.Group();
  // The layer being written: the resting pieces, then the travellers (their own meshes, drawn over the attack
  // stroke and the fortify route, fx.ts renderOrder 20, so a moving stone and figure are never under the ink).
  private stones: Instanced;
  private figs: Instanced;
  private blots: Instanced;
  private rest: { stones: Instanced; figs: Instanced; blots: Instanced };
  private trav: { stones: Instanced; figs: Instanced; blots: Instanced };
  private stoneMat: THREE.ShaderMaterial;
  private figMat: THREE.ShaderMaterial;
  private blotMat: THREE.ShaderMaterial;
  private atlas: THREE.Texture | null = null;
  /** Resolves once the figures' sprite atlas has loaded. */
  ready: Promise<void>;
  readonly figH = FIG_H;
  readonly figHalfW = FIG_H.map((h, i) => (h * ASPECT[i]) / 2);
  private toks = new Map<TerritoryId, Tok>();
  private list: Tok[] = [];
  private movers: Traveler[] = [];
  private dirty = true;
  materials: THREE.Material[] = [];
  /** Size multiplier from the UI text size. */
  sizeScale = 1;
  /** Kept for callers of the old API (the free-standing fight figures' phone boost; unused by the figures on stones). */
  figBoost = 1;
  /** Reduced motion: counts change in place — stones fade, nothing swells, slides or dries in patches. */
  reduced = false;
  /**
   * The stone's diameter at the home view, CSS px: `dminPx` for 1 army, `dmaxPx` at 30+; and board units per
   * CSS px there (index.ts sets all three on layout). Pieces scale with the zoom.
   */
  dminPx = 14;
  dmaxPx = 36;
  /** The numeral's smallest size at home, CSS px (13; phones 11). */
  numMin = NUMERAL_MIN;
  pxUnit = 1 / 12.7;
  /** Kept for callers of the old stack API: the disc size fields. */
  discPx = 36;
  thinPx = 0;
  private camAz = 0;
  private camPitch = 84;
  private right = new THREE.Vector3(1, 0, 0);
  private up = new THREE.Vector3(0, 0.1, -0.99);
  private p = new THREE.Vector3();
  private q = new THREE.Vector3();
  /** The view's up, laid flat on the paper (unit): "north" on screen. */
  private upG = new THREE.Vector3(0, 0, -1);
  private last = new Float32Array(0);
  private fight = new Set<TerritoryId>();
  /** Per-territory caps on the diameter, CSS px at the home view (index.ts fitCaps). */
  private caps = new Map<TerritoryId, number>();
  private figK = new Map<TerritoryId, number>();
  /** −1: the numeral sits at the stone's lower-LEFT edge (a crowded neighbour to the lower right). */
  private numSide = new Map<TerritoryId, number>();
  /** Called as a placed army's wash first touches the stone (the wood click). */
  onContact: ((id: TerritoryId) => void) | null = null;

  constructor(
    private anim: Animator,
    private tiles: TileSet,
    noise?: THREE.Texture,
  ) {
    const common = {
      transparent: true,
      premultipliedAlpha: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    } as const;
    this.stoneMat = new THREE.ShaderMaterial({
      uniforms: { uNoise: { value: noise ?? null }, uPaper: { value: new THREE.Vector3(0.063, 0.102, 0.188) } },
      vertexShader: STONE_VERT,
      fragmentShader: STONE_FRAG,
      ...common,
    });
    this.figMat = new THREE.ShaderMaterial({
      uniforms: {
        uAtlas: { value: null },
        uNoise: { value: noise ?? null },
        uSmoke: { value: null },
        uSmokeOn: { value: 0 },
        uIvory: { value: new THREE.Vector3(IVORY_RGB[0], IVORY_RGB[1], IVORY_RGB[2]) },
        uAtlasPx: { value: new THREE.Vector2(ATLAS.width, ATLAS.height) },
      },
      vertexShader: FIG_VERT,
      fragmentShader: FIG_FRAG,
      ...common,
    });
    this.blotMat = new THREE.ShaderMaterial({
      uniforms: { uNoise: { value: noise ?? null } },
      vertexShader: BLOT_VERT,
      fragmentShader: BLOT_FRAG,
      ...common,
    });
    this.materials.push(this.stoneMat, this.figMat, this.blotMat);
    if (typeof document !== 'undefined')
      void loadTexmap('smoke').then((t) => {
        if (!t) return;
        this.figMat.uniforms.uSmoke.value = t;
        this.figMat.uniforms.uSmokeOn.value = 1;
        this.dirty = true;
      });
    const flat = new THREE.PlaneGeometry(1, 1);
    const stoneSpec = { iPos: 3, iSize: 4, iCol: 4, iDeep: 3, iFx: 4, iRing: 4 };
    const figSpec = { iPos: 3, iSize: 2, iUV: 4, iA: 4, iB: 4, iC: 4, iOff: 2 };
    const blotSpec = { iPos: 3, iR: 3, iCol: 4, iK: 2 };
    this.stones = new Instanced(flat, stoneSpec, STONE_CAP, this.stoneMat);
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.translate(0, 0.5, 0);
    this.figs = new Instanced(quad, figSpec, FIG_CAP, this.figMat);
    const blotQuad = new THREE.PlaneGeometry(1, 1);
    this.blots = new Instanced(blotQuad, blotSpec, BLOT_CAP, this.blotMat);
    // the feet's shadow lies on the stone, the figure over both
    this.stones.mesh.renderOrder = 9;
    this.blots.mesh.renderOrder = 9.5;
    this.figs.mesh.renderOrder = 10;
    this.rest = { stones: this.stones, figs: this.figs, blots: this.blots };
    this.trav = {
      stones: new Instanced(flat, stoneSpec, MAX_TRAVELERS, this.stoneMat),
      figs: new Instanced(quad, figSpec, MAX_TRAVELERS, this.figMat),
      blots: new Instanced(blotQuad, blotSpec, MAX_TRAVELERS, this.blotMat),
    };
    this.trav.stones.mesh.renderOrder = 21;
    this.trav.blots.mesh.renderOrder = 21.5;
    this.trav.figs.mesh.renderOrder = 22;
    this.group.add(this.blots.mesh, this.stones.mesh, this.figs.mesh, this.trav.blots.mesh, this.trav.stones.mesh, this.trav.figs.mesh);

    this.ready = new Promise<void>((resolve) => {
      const base = (import.meta.env?.BASE_URL as string | undefined) ?? './';
      new THREE.TextureLoader().load(
        `${base}units/atlas.webp`,
        (tex) => {
          tex.colorSpace = THREE.NoColorSpace;
          tex.premultiplyAlpha = true;
          tex.generateMipmaps = true;
          tex.minFilter = THREE.LinearMipmapLinearFilter;
          tex.magFilter = THREE.LinearFilter;
          tex.anisotropy = 4;
          tex.flipY = true;
          tex.needsUpdate = true;
          this.atlas = tex;
          this.figMat.uniforms.uAtlas.value = tex;
          this.dirty = true;
          resolve();
        },
        undefined,
        () => {
          console.warn('[render] unit atlas failed to load');
          resolve();
        },
      );
    });

    for (const id of TERRITORY_IDS) {
      const a = tiles.get(id).anchorW;
      const t: Tok = {
        id,
        col: [0.4, 0.4, 0.4],
        deep: [0.3, 0.3, 0.3],
        n: 0,
        shown: 0,
        disp: 0,
        alpha: 0,
        dry: 0,
        soak: 0,
        preview: null,
        ring: null,
        swell: 0,
        fig: 0,
        denom: 0,
        reveal: 1,
        figOld: null,
        figSmoke: 0,
        puff: 0,
        figOffX: 0,
        figOffY: 0,
        lean: 0,
        flip: 1,
        frozen: null,
        pendingColor: null,
        ver: {},
        seed: hash(id),
        top: a.clone(),
        plaque: a.clone(),
        figTop: a.clone(),
        halfW: TOKEN_R,
        numH: 1,
        ext: [0, 0, 0, 0],
      };
      this.toks.set(id, t);
      this.list.push(t);
    }
    this.last = new Float32Array(this.list.length * 4);
  }

  // --- sizes ----------------------------------------------------------------------------------------

  /** A stone's diameter at the home view (CSS px) for a count on a territory, its cap applied. */
  diamPx(n: number, id?: TerritoryId): number {
    if (n <= 0) return 0;
    const d = stoneK(n, this.dminPx, this.dmaxPx) * this.sizeScale;
    const cap = id ? this.caps.get(id) : undefined;
    return cap !== undefined ? Math.min(d, Math.max(this.dminPx * this.sizeScale, cap)) : d;
  }
  /** Its radius in board units. */
  radiusFor(n: number, id?: TerritoryId): number {
    return (this.diamPx(n, id) / 2) * this.pxUnit;
  }
  /** The nominal piece radius (board units): a 30-army stone. */
  get radius(): number {
    return (this.dmaxPx * this.sizeScale * this.pxUnit) / 2;
  }
  /** The caps, and (crowded layouts) the figures drawn smaller than FIG_K once a stone is at its floor. */
  setCaps(caps: Map<TerritoryId, number>, figK?: Map<TerritoryId, number>, numSide?: Map<TerritoryId, number>): void {
    this.caps = caps;
    this.figK = figK ?? new Map();
    this.numSide = numSide ?? new Map();
    this.dirty = true;
  }
  /** This territory's figure size, × its stone's diameter. */
  figKOf(id?: TerritoryId): number {
    return (id && this.figK.get(id)) || FIG_K;
  }
  capOf(id?: TerritoryId): number {
    return id ? (this.caps.get(id) ?? this.dmaxPx * this.sizeScale) : this.dmaxPx * this.sizeScale;
  }

  get travelers(): readonly TokenTraveler[] {
    return this.movers;
  }
  get animating(): boolean {
    return this.movers.length > 0;
  }
  markDirty(): void {
    this.dirty = true;
  }
  get needsUpdate(): boolean {
    return this.dirty;
  }

  setView(azDeg: number, pitchDeg: number): void {
    if (Math.abs(azDeg - this.camAz) < 0.01 && Math.abs(pitchDeg - this.camPitch) < 0.01) return;
    this.camAz = azDeg;
    this.camPitch = pitchDeg;
    const az = (azDeg * Math.PI) / 180;
    const pr = (pitchDeg * Math.PI) / 180;
    this.right.set(Math.cos(az), 0, -Math.sin(az));
    this.up.set(-Math.sin(az) * Math.sin(pr), Math.cos(pr), -Math.cos(az) * Math.sin(pr));
    this.upG.set(this.up.x, 0, this.up.z).normalize();
    this.dirty = true;
  }

  static fill(tile: RGB): RGB {
    return lacquer(tile);
  }
  static paint(tile: RGB): RGB {
    return deepOf(tile);
  }

  setColor(id: TerritoryId, tileColor: RGB): void {
    const t = this.toks.get(id)!;
    const c = { col: lacquer(tileColor), deep: deepOf(tileColor) };
    if (t.frozen) t.pendingColor = c;
    else {
      t.col = c.col;
      t.deep = c.deep;
    }
    this.dirty = true;
  }

  feet(id: TerritoryId, out = new THREE.Vector3()): THREE.Vector3 {
    const a = this.tiles.get(id).anchorW;
    return out.set(a.x, TILE_TOP, a.z);
  }
  top(id: TerritoryId): THREE.Vector3 {
    return this.toks.get(id)!.top;
  }
  plaquePoint(id: TerritoryId): THREE.Vector3 {
    return this.toks.get(id)!.plaque;
  }
  /** The numeral's point (world): the stone's lower-right edge. */
  figTop(id: TerritoryId): THREE.Vector3 {
    return this.toks.get(id)!.figTop;
  }
  /** The numeral's height at the home view, world units (the overlay scales it with the zoom, ≥ 11 px). */
  numeralSize(id: TerritoryId): number {
    return this.toks.get(id)!.numH;
  }
  /** The piece (stone + figure) about its centre, world units in screen directions: [left, up, right, down]. */
  pieceExtent(id: TerritoryId): readonly [number, number, number, number] {
    return this.toks.get(id)!.ext;
  }
  /** The stone's radius (world), as drawn now. */
  halfWidth(id: TerritoryId): number {
    return this.toks.get(id)!.halfW;
  }
  denom(id: TerritoryId): Denom {
    return this.toks.get(id)!.denom;
  }
  facing(id: TerritoryId): number {
    return this.toks.get(id)!.flip;
  }
  shownCount(id: TerritoryId): number {
    return this.toks.get(id)!.shown;
  }
  /** Test hook: the stone a territory is drawn with (its count, diameter at home, cap). */
  stoneOf(id: TerritoryId): { n: number; dPx: number; capPx: number; alpha: number; denom: Denom; fig: number; figWPx: number; figHPx: number } {
    const t = this.toks.get(id)!;
    const d = this.diamPx(t.shown, id);
    const [w, h] = figDims(denomOf(t.shown), d, this.figKOf(id));
    return { n: t.shown, dPx: d, capPx: this.capOf(id), alpha: t.alpha, denom: t.denom, fig: t.fig, figWPx: t.shown > 0 ? w : 0, figHPx: t.shown > 0 ? h : 0 };
  }
  /** Kept for the old test hook name. */
  stackOf(id: TerritoryId): { n: number; thick: number; thin: number; alpha: number; heightPx: number } {
    const t = this.toks.get(id)!;
    return { n: t.shown, ...discsOf(t.shown), alpha: t.alpha, heightPx: this.diamPx(t.shown, id) };
  }
  visual(id: TerritoryId): number {
    const t = this.toks.get(id)!;
    if (t.shown <= 0) return 0;
    return t.alpha * (1 - Math.max(0, t.dry - 0.3) * 1.4);
  }
  freshTop(id: TerritoryId, out: THREE.Vector3): THREE.Vector3 {
    const tile = this.tiles.get(id);
    return out.set(tile.anchorW.x, tile.pivot.position.y + TILE_TOP, tile.anchorW.z);
  }

  /**
   * World points bounding every piece at the home camera, four per piece (the figure's top first, camera.ts):
   * the tallest figure's head, the widest part's west and east, and the lowest of the stone and numeral — the
   * envelope over every count of an uncapped stone (pieceEnvelope), so the home view never moves with a count.
   */
  extentPoints(_pitchDeg: number, _plaqueUnits: number, _denom: Denom | null = null, _ringUnits = 0): number[][] {
    const s = this.sizeScale;
    const [st, fg, nm] = ((e) => [e.stone, e.fig, e.num])(pieceEnvelope(this.dmaxPx * s, this.dminPx * s, this.dmaxPx * s, s, FIG_K, 1, this.numMin));
    const u = this.pxUnit;
    const top = -fg[1] * u;
    const west = -Math.min(st[0], fg[0]) * u;
    const east = Math.max(st[2], fg[2], nm[2]) * u;
    const south = Math.max(st[3], nm[3]) * u;
    const out: number[][] = [];
    for (const t of this.list) {
      const a = this.tiles.get(t.id).anchorW;
      const y0 = TILE_TOP;
      out.push([a.x, y0, a.z - top], [a.x - west, y0, a.z], [a.x + east, y0, a.z], [a.x, y0, a.z + south]);
    }
    return out;
  }

  private tw(t: Tok, key: string, o: { ms: number; ease?: (v: number) => number; run?: Run | null; delay?: number; update: (v: number) => void; done?: () => void }): Promise<void> {
    const ver = (t.ver[key] = (t.ver[key] ?? 0) + 1);
    return this.anim.tween({
      ms: o.ms,
      ease: o.ease ?? ease.linear,
      run: o.run ?? null,
      delay: o.delay,
      update: (v) => {
        if (t.ver[key] !== ver) return;
        o.update(v);
        this.dirty = true;
      },
      done: () => {
        if (t.ver[key] === ver) o.done?.();
        this.dirty = true;
      },
    });
  }
  private cancel(t: Tok, keys: string[]): void {
    for (const k of keys) t.ver[k] = (t.ver[k] ?? 0) + 1;
  }
  private unfreeze(t: Tok): void {
    t.frozen = null;
    if (t.pendingColor) {
      t.col = t.pendingColor.col;
      t.deep = t.pendingColor.deep;
      t.pendingColor = null;
    }
  }

  private screenDir(from: TerritoryId, to: TerritoryId | null | undefined): [number, number] {
    if (to && to !== from) {
      const a = this.tiles.get(from).anchorW;
      const b = this.tiles.get(to).anchorW;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const r = dx * this.right.x + dz * this.right.z;
      const u = dx * this.up.x + dz * this.up.z;
      const d = Math.hypot(r, u);
      if (d > 1e-3) return [r / d, u / d];
    }
    return [1, 0];
  }

  // --- the figures in a fight ---------------------------------------------------------------------------

  /**
   * The fighting pair (index.ts, with the ink ring). Every figure already stands on its stone, so there is no
   * fight-only figure any more (the old one stood beside the stone on a blot); this only records the pair.
   */
  setFight(pair: TerritoryId[] | null): void {
    this.fight = new Set(pair ?? []);
    this.dirty = true;
  }

  face(id: TerritoryId, other: TerritoryId | null): void {
    if (!other) return;
    const t = this.toks.get(id)!;
    const [r] = this.screenDir(id, other);
    if (Math.abs(r) < 0.08) return;
    const f = r < 0 ? -1 : 1;
    if (f !== t.flip) {
      t.flip = f;
      this.dirty = true;
    }
  }

  lean(from: TerritoryId, to: TerritoryId, on: boolean): void {
    const t = this.toks.get(from)!;
    this.face(from, to);
    this.face(to, from);
    if (this.reduced || this.anim.instant) {
      t.lean = 0;
      this.dirty = true;
      return;
    }
    const [r] = this.screenDir(from, to);
    const goal = on ? Math.sign(r || 1) * 0.12 : 0;
    const from0 = t.lean;
    this.tw(t, 'lean', { ms: on ? 180 : 140, ease: on ? ease.outCubic : ease.inOutQuad, update: (v) => (t.lean = from0 + (goal - from0) * v) });
  }

  puff(id: TerritoryId, ms: number, run: Run | null = null): void {
    const t = this.toks.get(id);
    if (!t || this.reduced || this.anim.instant || (run && run.skipped)) return;
    if (t.fig <= 0.01 || t.shown <= 0 || t.figSmoke > 0) return;
    this.tw(t, 'puff', {
      ms,
      ease: ease.linear,
      run,
      update: (v) => (t.puff = 0.3 * Math.sin(Math.PI * Math.min(1, v)) * (v < 0.5 ? 1 : 1 - 0.15 * (v - 0.5))),
      done: () => (t.puff = 0),
    });
  }

  private figHit(t: Tok, other: TerritoryId | null, fall: boolean): void {
    if (t.fig <= 0.01 || this.reduced) return;
    if (fall) {
      if (t.figSmoke > 0) return;
      this.tw(t, 'figSmoke', { ms: 420, ease: ease.outQuad, update: (v) => (t.figSmoke = v * 1.02), done: () => (t.fig = 0) });
      return;
    }
    const [r, u] = this.screenDir(other ?? t.id, t.id);
    // knocked back a step, a fifth of the stone's radius (it stays on its stone)
    const k = this.radiusFor(Math.max(1, t.shown), t.id);
    this.tw(t, 'figOff', {
      ms: 260,
      update: (v) => {
        const e = v < 0.25 ? ease.outQuad(v / 0.25) : 1 - ease.inOutQuad((v - 0.25) / 0.75);
        t.figOffX = r * 0.22 * k * e;
        t.figOffY = u * 0.14 * k * e;
      },
      done: () => {
        t.figOffX = 0;
        t.figOffY = 0;
      },
    });
    const l0 = t.lean;
    const back = (r >= 0 ? 1 : -1) * 0.16;
    this.tw(t, 'lean', {
      ms: 260,
      update: (v) => (t.lean = l0 * (1 - v) + back * Math.sin(Math.min(1, v * 1.4) * Math.PI) * (1 - v * 0.4)),
      done: () => (t.lean = 0),
    });
  }

  // --- the stone's motion ---------------------------------------------------------------------------------

  /** The stone's size goes from its current count to `to` (a swell with a little give, or a shrink). */
  private resize(t: Tok, to: number, ms: number, run: Run | null, overshoot = 0, delay = 0): void {
    const from = t.disp;
    this.tw(t, 'size', {
      ms,
      ease: ease.outCubic,
      run,
      delay,
      update: (v) => {
        const o = overshoot * Math.sin(Math.PI * v) * (1 - v);
        t.disp = from + (to - from) * v + o * Math.max(1, to);
      },
      done: () => (t.disp = to),
    });
  }

  /** Dry back to paper over `ms`, then leave. */
  private dryOut(t: Tok, ms: number, run: Run | null): void {
    t.frozen = t.frozen ?? { col: t.col, deep: t.deep };
    this.cancel(t, ['size']);
    this.tw(t, 'dry', {
      ms,
      ease: ease.inOutSine,
      run,
      update: (v) => (t.dry = v),
      done: () => {
        if (t.n > 0) return;
        t.shown = 0;
        t.disp = 0;
        t.alpha = 0;
        t.dry = 0;
        t.fig = 0;
        t.figSmoke = 0;
        this.unfreeze(t);
      },
    });
  }

  /**
   * Change a territory's count. mode:
   * - 'snap'  no motion (sync, deal)
   * - 'drop'  placement: the stone swells as the wash soaks in; the wood click lands as it starts
   * - 'lift'  armies leave (march start / unplace): it shrinks
   * - 'hit'   dice losses: it shrinks a step; at 0 it dries to paper (`topple`: the seat's last stone, slowly)
   * - 'land'  a traveller arrived: it settles
   * - 'out'   conquered: a stone still standing dries away
   */
  setArmies(
    id: TerritoryId,
    n: number,
    mode: 'snap' | 'drop' | 'lift' | 'hit' | 'land' | 'out',
    run: Run | null = null,
    other: TerritoryId | null = null,
    o: { topple?: boolean; unplace?: boolean } = {},
  ): void {
    const t = this.toks.get(id)!;
    const prev = t.shown;
    t.n = Math.max(0, n);
    this.dirty = true;
    const instant = this.anim.instant || (run && run.skipped);
    if (mode === 'snap' || instant) {
      this.cancel(t, ['size', 'dry', 'soak', 'alpha']);
      t.shown = t.n;
      t.disp = t.n;
      t.alpha = t.n > 0 ? 1 : 0;
      t.dry = 0;
      t.soak = 0;
      if (t.n > 0) this.unfreeze(t);
      this.figReset(t);
      if (mode === 'drop' && instant) this.onContact?.(id);
      return;
    }
    if (this.reduced) {
      if (mode === 'drop') this.onContact?.(id);
      if (t.n <= 0 || mode === 'out') {
        if (t.alpha <= 0.001) return;
        t.frozen = t.frozen ?? { col: t.col, deep: t.deep };
        const a0 = t.alpha;
        this.tw(t, 'alpha', {
          ms: 150,
          run,
          update: (v) => (t.alpha = a0 * (1 - v)),
          done: () => {
            t.shown = 0;
            t.disp = 0;
            t.fig = 0;
            this.unfreeze(t);
          },
        });
        return;
      }
      t.shown = t.n;
      t.disp = t.n;
      this.figReset(t);
      if (prev <= 0 || t.alpha < 1) {
        this.unfreeze(t);
        const a0 = t.alpha;
        this.tw(t, 'alpha', { ms: 150, run, update: (v) => (t.alpha = a0 + (1 - a0) * v), done: () => (t.alpha = 1) });
      }
      return;
    }
    if (t.n <= 0 || mode === 'out') {
      if (prev <= 0 && t.alpha <= 0.001) {
        t.shown = 0;
        return;
      }
      if (mode === 'hit' || mode === 'out') this.figHit(t, other, true);
      // the stone dries back to paper: 320 ms for a fall, ~1.2 s for a seat's last stone, 170 ms marched out
      this.dryOut(t, o.topple ? 1200 : mode === 'lift' ? 170 : 320, mode === 'lift' ? run : null);
      return;
    }
    // n > 0 from here
    this.cancel(t, ['dry', 'alpha']);
    t.dry = 0;
    // a stone standing up again (placed on paper, landed, or back from its smoke): a fresh figure on it
    const fresh = prev <= 0 || t.alpha < 0.999 || t.fig < 0.999 || t.figSmoke > 0;
    if (fresh) {
      this.unfreeze(t);
      t.frozen = null;
      if (prev <= 0) t.disp = mode === 'land' ? t.n : 0;
      this.figReset(t);
    }
    t.alpha = 1;
    t.shown = t.n;
    switch (mode) {
      case 'drop':
        this.onContact?.(id);
        this.resize(t, t.n, 180, run, 0.04);
        this.tw(t, 'soak', { ms: 200, update: (v) => (t.soak = Math.sin(v * Math.PI) * (1 - v * 0.4)), done: () => (t.soak = 0) });
        break;
      case 'lift':
        this.resize(t, t.n, o.unplace ? 170 : 150, run);
        break;
      case 'hit':
        // the figure takes the hit (its puff, index.ts, starts on this beat), then the stone gives a step
        this.figHit(t, other, false);
        this.resize(t, t.n, 200, run, 0, 90);
        this.tw(t, 'soak', { ms: 240, update: (v) => (t.soak = 0.7 * Math.sin(v * Math.PI)), done: () => (t.soak = 0) });
        break;
      case 'land':
        // the traveller's stone and figure become this one: it settles, it doesn't grow again
        this.resize(t, t.n, 160, run, 0.03);
        break;
    }
    const nd = denomOf(t.n);
    if (nd !== t.denom) {
      // a band change: the old figure dissolves as the new one inks in from its feet (160 ms in all)
      t.figOld = { denom: t.denom, dry: 0 };
      t.denom = nd;
      t.reveal = 0;
      this.tw(t, 'figOld', { ms: 120, update: (v) => (t.figOld ? (t.figOld.dry = v) : undefined), done: () => (t.figOld = null) });
      this.tw(t, 'reveal', { ms: 120, delay: 40, ease: (x) => 1 - Math.pow(1 - x, 1.6), update: (v) => (t.reveal = v), done: () => (t.reveal = 1) });
    }
  }

  /** The figure as the count stands now, with nothing in flight (no smoke, no swap). */
  private figReset(t: Tok): void {
    this.cancel(t, ['figSmoke', 'figOld', 'reveal', 'puff']);
    t.fig = t.n > 0 ? 1 : 0;
    t.figSmoke = 0;
    t.puff = 0;
    t.figOld = null;
    t.reveal = 1;
    t.denom = denomOf(t.n);
  }

  /**
   * v4 A4 "losing leaves a mark": a thin ring (Hair weight) in the loser's pigment round each listed stone;
   * every other stone loses its ring. The ring is still (E10): it never breathes.
   */
  setRings(rings: { id: TerritoryId; rgb: RGB }[]): void {
    const next = new Map(rings.map((r) => [r.id, r.rgb] as const));
    for (const t of this.list) {
      const c = next.get(t.id) ?? null;
      const same = c === t.ring || (c && t.ring && c[0] === t.ring[0] && c[1] === t.ring[1] && c[2] === t.ring[2]);
      if (!same) {
        t.ring = c;
        this.dirty = true;
      }
    }
  }
  /** Test hook: the ring a stone wears (its rgb) or null. */
  ringOf(id: TerritoryId): RGB | null {
    return this.toks.get(id)!.ring;
  }
  /** v4 A3: the receipt's pulse — one tier-0 swell of the stone (PULSE_MS), the wash deepening with it. */
  pulse(id: TerritoryId): void {
    const t = this.toks.get(id);
    if (!t || t.shown <= 0 || this.anim.instant || this.reduced) return;
    this.tw(t, 'swell', { ms: PULSE_MS, ease: ease.linear, update: (v) => (t.swell = Math.sin(Math.PI * v) * (1 - 0.25 * v)), done: () => (t.swell = 0) });
  }

  /** A count changed with no motion of its own: the wash deepens once. */
  pop(id: TerritoryId, _amt = 0.12): void {
    const t = this.toks.get(id)!;
    if (this.anim.instant || this.reduced || t.shown <= 0) return;
    this.tw(t, 'soak', { ms: 220, update: (v) => (t.soak = 0.6 * Math.sin(v * Math.PI)), done: () => (t.soak = 0) });
  }

  setPreview(totals: Partial<Record<TerritoryId, number>> | null): void {
    for (const t of this.list) {
      const v = totals?.[t.id];
      const next = v === undefined || v === null ? null : Math.max(0, v);
      if (next !== t.preview) {
        t.preview = next;
        this.dirty = true;
      }
    }
  }

  /** A stone carrying `count` slides from a to b along the stroke's bow (or the fortify route) and settles. */
  march(
    from: TerritoryId,
    to: TerritoryId,
    count: number,
    tileColor: RGB,
    ink: string,
    ms: number,
    run: Run | null,
    viaIds: TerritoryId[] = [],
    arc = 1.1,
    owner = '',
  ): Promise<void> {
    if (this.anim.instant || (run && run.skipped) || this.movers.length >= MAX_TRAVELERS) return Promise.resolve();
    const at = (id: TerritoryId) => {
      const v = this.tiles.get(id).anchorW.clone();
      v.y = TILE_TOP;
      return v;
    };
    const a = at(from);
    const b = at(to);
    let pts: THREE.Vector3[];
    if (viaIds.length) pts = [a, ...viaIds.map(at), b];
    else if (arc >= 1) {
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      const a2 = a.clone().lerp(b, Math.min(0.3, (this.radiusFor(count) * 1.2) / Math.max(d, 0.001)));
      pts = bowPts(a2, b, 0.14);
    } else pts = [a, b];
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
    const tr: Traveler = {
      n: count,
      ink,
      owner,
      top: a.clone(),
      plaque: a.clone(),
      figTop: a.clone(),
      halfW: this.radiusFor(count, to),
      numH: 1,
      to,
      alive: true,
      col: lacquer(tileColor),
      deep: deepOf(tileColor),
      pts,
      cum,
      t: 0,
      denom: denomOf(count),
      flip: 1,
      seed: Math.random(),
    };
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    tr.flip = dx * this.right.x + dz * this.right.z < 0 ? -1 : 1;
    this.face(from, to);
    this.movers.push(tr);
    this.dirty = true;
    return this.anim
      .tween({
        ms,
        ease: viaIds.length ? ease.inOutSine : ease.inOutQuad,
        run,
        update: (v) => {
          tr.t = v;
          this.dirty = true;
        },
      })
      .then(() => {
        tr.alive = false;
        this.movers = this.movers.filter((x) => x !== tr);
        this.toks.get(to)!.flip = tr.flip;
        this.dirty = true;
      });
  }

  travelerProgress(): number {
    return this.movers.length ? this.movers[this.movers.length - 1].t : 1;
  }
  dustPoint(id: TerritoryId, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.toks.get(id)!.top);
  }

  // --- per frame ----------------------------------------------------------------------------------

  private writeStone(pos: THREE.Vector3, R: number, col: RGB, deep: RGB, alpha: number, o: { seed?: number; ghost?: boolean; dry?: number; soak?: number; dim?: number; ring?: RGB | null } = {}): void {
    const s = this.stones;
    if (!s.next() || alpha <= 0.002 || R <= 0) return;
    s.set('iPos', pos.x, pos.y, pos.z);
    s.set('iSize', R, o.seed ?? 0, o.ghost ? 1 : 0, o.dry ?? 0);
    s.set('iCol', col[0], col[1], col[2], alpha);
    s.set('iDeep', deep[0], deep[1], deep[2]);
    s.set('iFx', 0, 0, o.soak ?? 0, o.dim ?? 0);
    // the ring's radius in stone radii: 3.5 px clear of the edge at the home view (RING_GAP_PX)
    if (o.ring) s.set('iRing', o.ring[0], o.ring[1], o.ring[2], 1 + RING_GAP_PX / Math.max(1, R / this.pxUnit));
    else s.set('iRing', 0, 0, 0, 0);
    s.push();
  }

  /** A figure `d` (the stone's diameter, world) standing with its feet `offY` along the view's up from `pos`. */
  private writeFig(pos: THREE.Vector3, denom: Denom, d: number, alpha: number, reveal: number, smoke: number, dry: number, lean: number, flip: number, ink: number, seed: number, deep: RGB, dim: number, offX: number, offY: number, k = FIG_K): void {
    const f = this.figs;
    if (!f.next() || alpha <= 0.002 || d <= 0) return;
    const s = SPRITES[denom];
    const [w, h] = figDims(denom, d, k);
    f.set('iPos', pos.x, pos.y, pos.z);
    f.set('iSize', w, h);
    f.set('iUV', s.x / ATLAS.width, 1 - (s.y + s.h) / ATLAS.height, (s.x + s.w) / ATLAS.width, 1 - s.y / ATLAS.height);
    f.set('iA', alpha, reveal, smoke, dry);
    f.set('iB', lean, flip, ink, seed);
    f.set('iC', deep[0], deep[1], deep[2], dim);
    f.set('iOff', offX, offY);
    f.push();
  }

  /** The figure's painted shadow on its stone: a flat darker-wash dab under the feet, offset lower-right. */
  private writeFeet(c: THREE.Vector3, R: number, w: number, deep: RGB, alpha: number, seed: number): void {
    if (alpha <= 0.002 || R <= 0) return;
    const g = this.upG;
    const down = FEET * R + 0.05 * R;
    this.q.set(c.x - g.x * down + this.right.x * 0.07 * R, c.y, c.z - g.z * down + this.right.z * 0.07 * R);
    this.writeBlot(this.q, Math.min(0.8 * R, Math.max(0.36 * R, w * 0.55)), 0.2 * R, [deep[0] * 0.55, deep[1] * 0.55, deep[2] * 0.55], alpha, seed);
  }
  /**
   * Where the numeral's centre sits for a stone of radius R at c (world): straddling the lower-right edge
   * (numOffset), for a numeral `numH` tall (world) with `digits` digits.
   */
  private numAt(c: THREE.Vector3, R: number, out: THREE.Vector3, side: number, numH: number, digits: number): THREE.Vector3 {
    const g = this.upG;
    const px = this.pxUnit;
    const [nw, nh] = numeralBox(numH / px, digits);
    const [x, y] = numOffset(R / px, nw, nh, side).map((v) => v * px);
    return out.set(c.x + this.right.x * x - g.x * y, c.y, c.z + this.right.z * x - g.z * y);
  }

  private writeBlot(pos: THREE.Vector3, rx: number, rz: number, col: RGB, alpha: number, seed: number): void {
    const b = this.blots;
    if (!b.next() || alpha <= 0.002) return;
    b.set('iPos', pos.x, pos.y, pos.z);
    b.set('iR', rx, rz, 0);
    b.set('iCol', col[0], col[1], col[2], alpha);
    b.set('iK', 0, seed);
    b.push();
  }

  update(): void {
    const L = this.last;
    for (let i = 0; i < this.list.length; i++) {
      const tile = this.tiles.get(this.list[i].id);
      const y = tile.pivot.position.y;
      const d = tile.dim;
      const o = i * 4;
      if (L[o] !== y || L[o + 2] !== d) {
        L[o] = y;
        L[o + 2] = d;
        this.dirty = true;
      }
    }
    if (!this.dirty && !this.movers.length) return;
    this.dirty = false;
    const px = this.pxUnit;
    const ss = this.sizeScale;
    for (const t of this.list) {
      const tile = this.tiles.get(t.id);
      const a = tile.anchorW;
      const y0 = tile.pivot.position.y + TILE_TOP;
      this.p.set(a.x, y0, a.z);
      const colors = t.frozen ?? { col: t.col, deep: t.deep };
      // the size follows the displayed count (a float while it swells), capped for this territory; a stone
      // arriving on an empty territory grows from nothing (below one army it scales, never pops)
      const R = (t.disp > 0 ? this.radiusFor(Math.max(1, t.disp), t.id) * Math.min(1, t.disp) : 0) * (1 + PULSE_SWELL * t.swell);
      const Rn = this.radiusFor(Math.max(1, t.shown), t.id);
      t.top.copy(this.p);
      t.plaque.copy(this.p);
      const Rs = t.shown > 0 ? Math.max(R, Rn * 0.5) : R;
      t.halfW = Rs;
      t.numH = numeralPxFor((2 * Rn) / px, ss, this.numMin) * px;
      this.numAt(this.p, Rs, t.figTop, this.numSide.get(t.id) ?? 1, t.numH, String(Math.max(1, t.shown)).length);
      const dim = tile.dim;
      const ghost = t.preview !== null && t.preview !== t.shown && t.preview > 0 ? t.preview : 0;
      if (R > 0 && t.alpha > 0.002) this.writeStone(this.p, R, colors.col, colors.deep, t.alpha, { seed: t.seed, dry: t.dry, soak: Math.max(t.soak, 0.5 * t.swell), dim, ring: t.ring });
      if (ghost) this.writeStone(this.p, this.radiusFor(ghost, t.id), t.col, t.deep, 1, { seed: t.seed, ghost: true, dim });
      // the figure standing on the stone: sized with the stone as drawn (it swells with it), fading up as a
      // new stone grows, drying with it, gone to smoke at 0
      const smoke = Math.max(t.figSmoke, t.puff);
      const figA = t.fig * t.alpha * Math.min(1, t.disp) * (t.figSmoke > 0 ? 1 : 1 - t.dry);
      const fk = this.figKOf(t.id);
      const [fw, fh] = figDims(t.denom, 2 * Rs, fk);
      t.ext[0] = t.ext[2] = t.fig > 0.002 ? Math.max(Rs, fw / 2) : Rs;
      t.ext[1] = t.fig > 0.002 ? Math.max(Rs, fh - FEET * Rs) : Rs;
      t.ext[3] = Rs;
      // (a preview in the same band keeps the real figure; one that changes the band shows the new figure as
      // a ghost in its place — never two figures on one stone)
      if (ghost && (t.shown <= 0 || denomOf(ghost) !== t.denom)) {
        const Rg = this.radiusFor(ghost, t.id);
        const dg = denomOf(ghost);
        this.writeFig(this.p, dg, 2 * Rg, 0.5 * (t.shown > 0 ? t.alpha : 1), 1, 0, 0, 0, t.flip, 0.4, t.seed, t.deep, dim, 0, -FEET * Rg, fk);
      } else if (figA > 0.002 && R > 0) {
        const a = figA * (t.denom === 0 ? SOLDIER_ALPHA : 1);
        const [ow] = t.figOld ? figDims(t.figOld.denom, 2 * R, fk) : [0];
        this.writeFeet(this.p, R, Math.max(fw * (R / Rs), ow), colors.deep, 0.42 * a * (1 - 0.8 * Math.min(1, t.figSmoke * 1.5)), t.seed);
        if (t.figOld) this.writeFig(this.p, t.figOld.denom, 2 * R, a, 1, 0, t.figOld.dry, t.lean, t.flip, 0, t.seed, colors.deep, dim, t.figOffX, t.figOffY - FEET * R, fk);
        this.writeFig(this.p, t.denom, 2 * R, a, t.reveal, smoke, 0, t.lean, t.flip, 0, t.seed, colors.deep, dim, t.figOffX, t.figOffY - FEET * R, fk);
      }
    }
    this.layer(this.trav);
    for (const tr of this.movers) {
      const pts = tr.pts;
      const Lt = tr.cum[tr.cum.length - 1] || 1;
      const s = tr.t * Lt;
      let j = 0;
      while (j < pts.length - 2 && tr.cum[j + 1] < s) j++;
      const seg = tr.cum[j + 1] - tr.cum[j] || 1;
      const lt = Math.min(1, Math.max(0, (s - tr.cum[j]) / seg));
      this.p.lerpVectors(pts[j], pts[j + 1], lt);
      this.p.y = TILE_TOP;
      tr.top.copy(this.p);
      tr.plaque.copy(this.p);
      tr.halfW = this.radiusFor(tr.n, tr.to);
      tr.numH = numeralPxFor((2 * tr.halfW) / px, ss, this.numMin) * px;
      this.numAt(this.p, tr.halfW, tr.figTop, this.numSide.get(tr.to) ?? 1, tr.numH, String(Math.max(1, tr.n)).length);
      const fadeIn = Math.min(1, tr.t * 10);
      // the stone and its figure travel together
      const R = tr.halfW;
      this.writeStone(this.p, R, tr.col, tr.deep, fadeIn, { seed: tr.seed });
      const tk = this.figKOf(tr.to);
      const [fw] = figDims(tr.denom, 2 * R, tk);
      this.writeFeet(this.p, R, fw, tr.deep, 0.42 * fadeIn, tr.seed);
      this.writeFig(this.p, tr.denom, 2 * R, fadeIn * (tr.denom === 0 ? SOLDIER_ALPHA : 1), 1, 0, 0, 0, tr.flip, 0, tr.seed, tr.deep, 0, 0, -FEET * R, tk);
    }
    for (const L of [this.rest, this.trav]) {
      L.blots.commit();
      L.stones.commit();
      L.figs.commit();
    }
    this.layer(this.rest);
  }
  private layer(L: { stones: Instanced; figs: Instanced; blots: Instanced }): void {
    this.stones = L.stones;
    this.figs = L.figs;
    this.blots = L.blots;
  }

  dispose(): void {
    for (const L of [this.rest, this.trav]) {
      L.stones.dispose();
      L.figs.dispose();
      L.blots.dispose();
    }
    this.atlas?.dispose();
    for (const m of this.materials) m.dispose();
  }
}
