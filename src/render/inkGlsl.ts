// Shared shader code and uniforms for the painted board: washi paper, the ink layer (still strokes; the coast's
// glow breathes and drifts), mist veils, the lamp's warm vignette, contact shadows of lifted tiles, and the
// continent re-ink sweep. The ground and every tile top use the same functions, so a coastline stroke reads as one
// stroke across the seam. v4 (_claude/v4/PLAN.md §5, E2–E4, E9, E10): one edge ladder with one brush (brushJit),
// tints on the land, the cozy lamp, and nothing on the paper moving at rest but the mist, the coast glow and the lamp.
//
// All colour math is in display (sRGB) space and written out as is (the materials are unlit and not
// tone-mapped), so the palette's hexes land on screen exactly.
import * as THREE from 'three';
import { CONTINENT_TINTS } from '../shared/palette';
import type { InkLayer } from './ink';
import { GOLD, INK_BORDER, INK_COAST, INK_TERR, IVORY, LAMP_UMBER, PAPER, PAPER_DEEP, PAPER_FIBRE, hexToRgb, unclaimedRgb, type RGB } from './util';

/** The continent outline (v4 E2: the Medium weight, ≈1.4 px at the home view), a cooler silver than the coasts. */
export const CONT_LINE = '#d3d8e0';

// --- v4 paper constants (one source for the shaders and the CPU-side drift hook) -------------------------
/**
 * Mist veils (PLAN §5 "drift you can see"): the lead veil's drift, board units per second of the ambient clock
 * (v3's pace, kept: 0.65 × 1.1). The board is 100 units wide; at the 1440 home view (≈14.6 px a unit) this is
 * ≈10 px/s, a cloud's pace. What v3 lacked was an edge to see it by: the veils are a touch crisper and denser now.
 */
export const MIST_SPEED = 0.715;
/**
 * The coast glow's drift (the ivory bloom under the heavy coast stroke; the stroke itself holds still, E10):
 * its reach in board units and its two periods, s. Peak speed ≈ 2π · reach / period.
 */
export const GLOW_REACH = 0.16;
export const GLOW_PERIODS: [number, number] = [11.0, 13.7];
/** The cozy vignette (PLAN §5): how far the frame's margins warm toward LAMP_UMBER, and the margin darkening. */
export const VIG_WARM = 0.2;
export const VIG_DARK = 0.07;
/** E3 / E2: the coast stroke's opacity at rest (Layer 2), its glow, and the territory border's opacity. */
export const COAST_A = 0.82;
// --- [place v5] a place, not a picture (PROPOSAL §4 B) -------------------------------------------------------
/**
 * Mist parallax: the near veils (the ones that cross the coasts) sit above the paper and slide against the
 * camera's offset by PAR_NEAR of it; the far veils (the sea's own) sit below it and trail by PAR_FAR. A lean of
 * 0.15 board widths (15 units) moves the near veils ≈ 3 units and the far ≈ 1.2 the other way against the land.
 */
export const PAR_NEAR = 0.2;
export const PAR_FAR = 0.08;
/**
 * The evening (round 1 dusk → round 12+ night): at uEve = 1 the whole paper is EVE_ALL darker and the open sea
 * EVE_SEA more, the lamp's margin darkening grows by EVE_VIG_DARK and its warmth by EVE_VIG_WARM (fractions of the
 * v4 values), and the lit centre narrows a little. A few points of L* at the margins, about one at the centre.
 */
export const EVE_SEA = 0.1;
export const EVE_ALL = 0.03;
export const EVE_VIG_DARK = 2.2;
export const EVE_VIG_WARM = 0.25;
/**
 * Front lines: the split Medium stroke's opacity, and how far each half's ink is lifted from its seat's colour
 * toward the ivory (the seat's light tone, as the palette's `light` is: a pigment that reads on the indigo, like
 * every other line on the board, and in its seat's hue so the two halves are two seats).
 */
export const FRONT_A = 0.95;
export const FRONT_LIFT = 0.6;
export const COAST_BLOOM = 0.2;
export const TERR_A = 0.75;
/** The continents' paper tints: src/shared/palette.ts CONTINENT_TINTS. */
export const CONT_TINTS = CONTINENT_TINTS;
const v3 = (hex: string | RGB) => {
  const c = typeof hex === 'string' ? hexToRgb(hex) : hex;
  return new THREE.Vector3(c[0], c[1], c[2]);
};

export interface SharedUniforms {
  [k: string]: THREE.IUniform;
  uInk: { value: THREE.Texture };
  uField: { value: THREE.Texture };
  uNoise: { value: THREE.Texture };
  uTerr: { value: THREE.DataTexture };
  uBoard: { value: THREE.Vector2 };
  uFieldSize: { value: THREE.Vector2 };
  uInkSize: { value: THREE.Vector2 };
  /** Ambient clock, seconds (advances only while the living calm runs; half speed when idle long). */
  uTime: { value: number };
  /** Ambient motion amplitude: 1 = at rest, 0.5 = yielding to gameplay, 0 = off (reduced motion). */
  uAmb: { value: number };
  /** Mist opacity factor: 1 at rest, 0.5 while gameplay moves. */
  uMist: { value: number };
  /** The coastline breath's reach in ink texels: 0.5 CSS px at the home zoom (set by the board on layout). */
  uWob: { value: number };
  /** Drawing-buffer size, px (screen-space vignette). */
  uRes: { value: THREE.Vector2 };
  uPaper: { value: THREE.Vector3 };
  uPaperDeep: { value: THREE.Vector3 };
  uFibre: { value: THREE.Vector3 };
  uInkCoast: { value: THREE.Vector3 };
  uInkBorder: { value: THREE.Vector3 };
  uIvory: { value: THREE.Vector3 };
  uGold: { value: THREE.Vector3 };
  uUnclaimed: { value: THREE.Vector3 };
  /** Lifted tiles casting a contact shadow: (territory index, lift in board units); index 0 = none. */
  uLiftA: { value: THREE.Vector2 };
  uLiftB: { value: THREE.Vector2 };
  /** The turn "breath": washes dim 8 % at 1. */
  uBreath: { value: number };
  /** A held continent's outline ink: colour per continent (CONTINENT_IDS order). */
  uContColor: { value: THREE.Vector3[] };
  /** The printed continents (ink.ts buildContinents): R outline distance, G own continent, B the outline's. */
  uCont: { value: THREE.Texture };
  /** The continent outline's silver (unheld). */
  uContLine: { value: THREE.Vector3 };
  /** Each continent's paper tint (its halo of sea), CONTINENT_IDS order. */
  uContTint: { value: THREE.Vector3[] };
  /** The outline's half-width, board units (set on layout: a fixed weight in screen px at the home view). */
  uContW: { value: number };
  /** Continent sweep: (centre bx, centre by, progress 0..1 clockwise from north, amount 0..1). */
  uContSweep: { value: THREE.Vector4[] };
  // --- the pigment maps (docs/INK2.md §4.2), driven by the ink layer's texture ladder -------------------
  /** Paper: R fibre · G mottle · B grain · A flecks (mask). A neutral grey texel until the map loads. */
  uPaperTex: { value: THREE.Texture };
  /** Wash: R pigment · G bloom (16 px blur) · B granulation · A tide lines (mask). */
  uWashTex: { value: THREE.Texture };
  /** 0 = procedural (the value noise, as before), 1 = the maps; eases 0 → 1 as the maps dry in. */
  uTexOn: { value: number };
  /**
   * The ladder level the shaders read (INK2 §4.3 has "1 or 2"; three values here): 3 = paper 3 taps + wash 2,
   * 2 = paper 1 + wash 2 (phones: ≤ 3 map taps), 1 = paper fibre tap + wash 1.
   */
  uTexTaps: { value: number };
  // --- v4 paper (additive) ----------------------------------------------------------------------------
  /** The territory border's ink (E2 Light weight): the paper's deep tone. */
  uTerrInk: { value: THREE.Vector3 };
  /** The lamp's umber (the cozy vignette warms the margins toward it). */
  uUmber: { value: THREE.Vector3 };
  // --- [place v5] (additive) ----------------------------------------------------------------------------
  /** The camera's offset from home (board units, +x east, +y north), the idle drift included: the mist parallax. */
  uPar: { value: THREE.Vector2 };
  /** The evening, 0 = dusk (round 1) … 1 = night (round 12+). */
  uEve: { value: number };
  /** Front lines on (1) / off (0) (BoardHighlights.frontLines). */
  uFront: { value: number };
}

/** A 1×1 mid-grey (mask channels unset): what the map samplers read before the maps load. */
function neutralTexture(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([128, 128, 128, 128]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * Per-territory data (64×1 RGBA8): R = coast glow 0..1, G = ink dim 0..1, B = continent index, A = the displayed
 * owner's seat + 1 ([place v5] front lines; 0 = unclaimed or the neutral seat).
 */
export function makeTerrTexture(ink: InkLayer): THREE.DataTexture {
  const d = new Uint8Array(64 * 4);
  for (let i = 1; i <= 42; i++) d[i * 4 + 2] = ink.continentIndex(i);
  d[2] = 255;
  const t = new THREE.DataTexture(d, 64, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.magFilter = t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

export function makeSharedUniforms(ink: InkLayer, boardW: number, boardH: number): SharedUniforms {
  const u: SharedUniforms = {
    uInk: { value: ink.ink },
    uField: { value: ink.field },
    uNoise: { value: ink.noise },
    uTerr: { value: makeTerrTexture(ink) },
    uBoard: { value: new THREE.Vector2(boardW, boardH) },
    uFieldSize: { value: new THREE.Vector2(ink.fieldW, ink.fieldH) },
    uInkSize: { value: new THREE.Vector2(ink.inkW, ink.inkH) },
    uTime: { value: 0 },
    uAmb: { value: 0 },
    uMist: { value: 1 },
    uWob: { value: 1.7 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uPaper: { value: v3(PAPER) },
    uPaperDeep: { value: v3(PAPER_DEEP) },
    uFibre: { value: v3(PAPER_FIBRE) },
    uInkCoast: { value: v3(INK_COAST) },
    uInkBorder: { value: v3(INK_BORDER) },
    uIvory: { value: v3(IVORY) },
    uGold: { value: v3(GOLD) },
    uUnclaimed: { value: v3(unclaimedRgb()) },
    uLiftA: { value: new THREE.Vector2(0, 0) },
    uLiftB: { value: new THREE.Vector2(0, 0) },
    uBreath: { value: 0 },
    uContColor: { value: Array.from({ length: 6 }, () => new THREE.Vector3(1, 1, 1)) },
    uCont: { value: ink.cont },
    uContLine: { value: v3(CONT_LINE) },
    uContTint: { value: CONT_TINTS.map((h) => v3(h)) },
    uContW: { value: 0.11 },
    uContSweep: { value: Array.from({ length: 6 }, () => new THREE.Vector4(0, 0, 0, 0)) },
    uPaperTex: { value: neutralTexture() },
    uWashTex: { value: neutralTexture() },
    uTexOn: { value: 0 },
    uTexTaps: { value: 3 },
    uTerrInk: { value: v3(INK_TERR) },
    uUmber: { value: v3(LAMP_UMBER) },
    uPar: { value: new THREE.Vector2(0, 0) },
    uEve: { value: 0 },
    uFront: { value: 1 },
  };
  ink.bindShared?.(u);
  return u;
}

export const INK_GLSL = /* glsl */ `
uniform sampler2D uInk;
uniform sampler2D uField;
uniform sampler2D uNoise;
uniform sampler2D uTerr;
uniform vec2 uBoard;
uniform vec2 uFieldSize;
uniform vec2 uInkSize;
uniform float uTime;
uniform float uAmb;
uniform float uMist;
uniform float uWob;
uniform vec2 uRes;
uniform vec3 uPaper;
uniform vec3 uPaperDeep;
uniform vec3 uFibre;
uniform vec3 uInkCoast;
uniform vec3 uInkBorder;
uniform vec3 uIvory;
uniform vec3 uGold;
uniform vec3 uUnclaimed;
uniform vec2 uLiftA;
uniform vec2 uLiftB;
uniform float uBreath;
uniform vec3 uContColor[6];
uniform vec4 uContSweep[6];
uniform sampler2D uCont;
uniform vec3 uContLine;
uniform vec3 uContTint[6];
uniform float uContW;
uniform sampler2D uPaperTex;
uniform sampler2D uWashTex;
uniform float uTexOn;
uniform float uTexTaps;
uniform vec3 uTerrInk;
uniform vec3 uUmber;
uniform vec2 uPar;
uniform float uEve;
uniform float uFront;

vec2 bUV(vec2 bp) { return vec2(bp.x / uBoard.x, 1.0 - bp.y / uBoard.y); }
bool inBoard(vec2 bp) { return bp.x > 0.0 && bp.y > 0.0 && bp.x < uBoard.x && bp.y < uBoard.y; }
vec4 nz(vec2 p) { return texture2D(uNoise, p); }
vec4 fieldAt(vec2 bp) { return texture2D(uField, bUV(bp)); }
float idAt(vec2 bp) {
  vec2 uv = bUV(bp);
  if (uv.x <= 0.0 || uv.y <= 0.0 || uv.x >= 1.0 || uv.y >= 1.0) return 0.0;
  ivec2 c = ivec2(uv * uFieldSize);
  return floor(texelFetch(uField, c, 0).b * 255.0 + 0.5);
}
/** The territory under a board point, land only (sea texels carry their nearest coast's id; this ignores them). */
float landIdAt(vec2 bp) {
  vec2 uv = bUV(bp);
  if (uv.x <= 0.0 || uv.y <= 0.0 || uv.x >= 1.0 || uv.y >= 1.0) return 0.0;
  vec4 f = texelFetch(uField, ivec2(uv * uFieldSize), 0);
  return f.a > 0.5 ? floor(f.b * 255.0 + 0.5) : 0.0;
}
vec4 terrAt(float id) { return texelFetch(uTerr, ivec2(int(id + 0.5), 0), 0); }

// The pigment maps (INK2 §4.2). Every channel is equalised to mean 128 / std 40; nz()'s channels have
// std 33 (R, G), 36 (B) and 41 (A) of 255, so a map channel standing in for an nz() tap is scaled about 0.5
// to that tap's std: the same coefficients and smoothstep thresholds then mean what they did. Each map is
// read with all four channels from one tap, at the scale of its R (paper 14 units a repeat, wash 22): the
// finer 1.9 / 4.5-unit taps would shrink a 1024 map 8–19× on screen and mip its detail to grey.
const float PAPER_REP = 14.0;
const float WASH_REP = 22.0;
const float TAP2 = 1.37;
const float GRAIN_TEX = 0.67; // the maps' granulation spread vs the noise's (see the wash block)
float eqTo(float v, float k) { return 0.5 + (v - 0.5) * k; }
const vec4 K_NZ = vec4(0.83, 0.82, 0.89, 1.0); // nz() std / map std, per nz() channel (r, g, b, a)

// Washi: indigo, a little deeper toward the edges, long anisotropic fibres (6:1), soft mottling, fine grain.
// With the maps (uTexOn): fibres f1 / grain / flecks from one paper tap at 14 units, f2 and the medium mottle
// from a second tap at 1.37× rotated 90°, the broad mottle from the fibre map's mottle channel at 37 units.
// Taps per level (uTexTaps = the ladder level): L3 paper 3 + wash 2; L2 paper 1 + wash 2 (the mottle and f2
// stay value noise); L1 paper 1 (fibre only) + wash 1.
// fib = the fibre value (f1), which the wash reuses for the fibres showing through it.
vec3 paperAt(vec2 bp, out float fib) {
  vec2 c = (bp - uBoard * 0.5) / (uBoard * vec2(0.62, 0.78));
  float r = length(c);
  vec3 col = mix(uPaper, uPaperDeep, smoothstep(0.2, 1.25, r));
  float tx = uTexOn;
  bool full = uTexTaps > 2.5; // L3: three paper taps
  bool grain = uTexTaps > 1.5; // L2: the fibre tap also gives the grain and flecks
  float a = 0.0, b = 0.0, f1 = 0.0, f2 = 0.0, g = 0.0, fl = 0.0;
  // the value noise, as before: all of it while the maps fade; below L3, whatever the maps don't give
  if (tx < 0.999 || !full) {
    a = clamp((nz(bp / 37.0).r - 0.5) * 3.0, -1.0, 1.0);
    b = clamp((nz(bp / 8.5 + 0.37).g - 0.5) * 3.0, -1.0, 1.0);
    f2 = nz(vec2(bp.y, -bp.x) / 7.5 + 0.23).b;
  }
  if (tx < 0.999 || !grain) g = nz(bp / 1.9 + 0.5).a;
  if (tx < 0.999) f1 = nz(bp / 5.5 + 0.71).b;
  if (tx > 0.001) {
    vec4 p1 = texture2D(uPaperTex, bp / PAPER_REP + vec2(0.31, 0.17));
    f1 = mix(f1, eqTo(p1.r, K_NZ.b), tx);
    if (grain) {
      g = mix(g, eqTo(p1.b, K_NZ.a), tx);
      fl = smoothstep(0.6, 0.9, p1.a) * tx;
    }
    if (full) {
      vec4 p2 = texture2D(uPaperTex, vec2(bp.y, -bp.x) / (PAPER_REP * TAP2) + vec2(0.57, 0.11));
      vec4 p3 = texture2D(uPaperTex, bp / 37.0 + vec2(0.13, 0.71));
      a = mix(a, clamp((eqTo(p3.g, K_NZ.r) - 0.5) * 3.0, -1.0, 1.0), tx);
      b = mix(b, clamp((eqTo(p2.g, K_NZ.g) - 0.5) * 3.0, -1.0, 1.0), tx);
      f2 = mix(f2, eqTo(p2.r, K_NZ.b), tx);
    }
  }
  col *= 1.0 + 0.055 * a + 0.03 * b;
  col = mix(col, uFibre, 0.3 * smoothstep(0.56, 0.84, f1) + 0.14 * smoothstep(0.6, 0.88, f2));
  col *= 0.975 + 0.05 * g;
  // flecks: a few specks of fibre caught in the sheet
  col = mix(col, uFibre, 0.25 * fl);
  fib = f1;
  return col;
}
vec3 paperAt(vec2 bp) {
  float fib;
  return paperAt(bp, fib);
}

// The lamp (v4 cozy, PLAN §5 / E10): the frame's margins warm a few points toward umber and dim a little, the
// centre is untouched; at rest the warmth breathes ±12 % over ~23 s, the slowest thing on screen.
// [place v5] the evening: as the game gets later the lit centre narrows a little and the margins go darker and
// warmer (uEve, driven by the round; never back).
float vigMask() {
  vec2 q = gl_FragCoord.xy / uRes - 0.5;
  q.x *= uRes.x / max(1.0, uRes.y) * 0.62;
  return smoothstep(0.24 - 0.05 * uEve, 0.8, length(q));
}
float vigDark() {
  return ${VIG_DARK.toFixed(3)} * (1.0 + ${EVE_VIG_DARK.toFixed(3)} * uEve);
}
vec3 lamp(vec3 c) {
  float v = vigMask();
  float warm = ${VIG_WARM.toFixed(3)} * (1.0 + ${EVE_VIG_WARM.toFixed(3)} * uEve) * (1.0 + 0.12 * uAmb * sin(uTime * 0.273));
  c *= (1.0 - vigDark() * v) * (1.0 - ${EVE_ALL.toFixed(3)} * uEve);
  return mix(c, uUmber, warm * v);
}
// (v3's darkening-only vignette, kept for the marks that are alpha-blended: their ink dims at the margins too)
float vignette() {
  return 1.0 - vigDark() * vigMask();
}

// One brush (v4 E2): every edge on the paper (coast, continent outline, territory border, sea lane) carries the
// same pen pressure, a hair drier here and there along it, so the four weights read as one hand.
float brushJit(vec2 bp) {
  return 0.84 + 0.16 * smoothstep(0.3, 0.62, nz(bp / 1.3 + 0.61).a);
}
// The coast's pressure (v4 round 2): the same pen (brushJit) plus a slower swell along the shore, every ~3 units the
// brush loads and runs drier, so the heavy line reads as a brush, never as a vector outline. The bloom swells with it.
float coastJit(vec2 bp) {
  float sw = smoothstep(0.28, 0.72, nz(bp / 3.1 + 0.37).g);
  return brushJit(bp) * (0.4 + 0.6 * sw);
}
// The coast's ink at rest (E3 Layer 2: 30–60 % against its paper; the continent outline is the Layer 1 line) and
// its glow's strength. A territory's phase glow takes the stroke to full ivory.
const float COAST_A = ${COAST_A.toFixed(3)};
const float COAST_BLOOM = ${COAST_BLOOM.toFixed(3)};
// The territory border (E2 Light weight, the paper's deep tone) at rest.
const float TERR_A = ${TERR_A.toFixed(3)};

// The ink layer. v4 E10: the strokes themselves hold still (board-game linework does not breathe); the coast's
// dry-brush opacity still breathes ±6 % with its own phase from place to place (R only: the coast glow).
vec4 inkAt(vec2 bp) {
  vec4 k = texture2D(uInk, bUV(bp));
  float a = uAmb;
  if (a > 0.001) {
    float t = uTime;
    float br = sin(t * 0.47 + nz(bp / 61.0 + 0.53).g * 12.566) * 0.7 + 0.3 * sin(t * 0.39 + nz(bp / 23.0).r * 12.566);
    k.r *= 1.0 + 0.06 * a * br;
  }
  return k;
}

// The coast glow's drift (PLAN §5 "drift you can see"): two slow sines per axis, phased by a broad noise field,
// so every stretch of coast drifts on its own. Board units; mirrored on the CPU by inkGlsl.ts glowOffset().
vec2 glowOffset(vec2 bp) {
  float t = uTime;
  vec4 ph = nz(bp / 47.0 * 0.37 + 0.19) * 6.2831853;
  const float w1 = 6.2831853 / ${GLOW_PERIODS[0].toFixed(2)};
  const float w2 = 6.2831853 / ${GLOW_PERIODS[1].toFixed(2)};
  vec2 d = vec2(
    0.6 * sin(t * w1 + ph.r * 2.0) + 0.4 * sin(t * w2 + ph.g * 3.0),
    0.6 * sin(t * w1 * 1.07 + ph.b * 2.0) + 0.4 * sin(t * w2 * 1.03 + ph.a * 3.0)
  );
  return d * ${GLOW_REACH.toFixed(3)} * uAmb;
}
// The coast glow: the same coast stroke, blurred ~0.3 board units (a coarse mip) and drifting slowly; the wet
// feather where the ivory ink bled into the paper beside it. One brush, so one language (E2).
float coastSoft(vec2 bp) {
  return textureLod(uInk, bUV(bp + glowOffset(bp)), log2(0.3 * uInkSize.x / uBoard.x)).r;
}

// Mist veils (A1): large fbm veils, 3-5 on the board at a time, drifting east ~0.7 % of the board width
// a second (the board is 100 units wide) and morphing slowly. x = the veils that keep to the sea (thinner
// near the coasts), y = the two that cross coasts, so the land breathes too. Peak opacity is 7-8 %.
// [place v5] two layers with parallax: the sea's veils (x) are the far layer, sampled at bp − uPar·PAR_FAR (they
// trail the land as the camera moves); the crossing veils (y) are the near layer, at bp + uPar·PAR_NEAR (they
// run ahead of it). The broad warp is shared (260 / 210 units: a few units of parallax don't change it); each
// layer has its own fine break-up and wisps, so the detail moves with its veil.
vec2 mistAt(vec2 bp) {
  // the lead veil drifts MIST_SPEED units a second (~0.7 % of the board width): clearly drifting at couch
  // distance, never hurrying (mirrored on the CPU by inkGlsl.ts mistSeaCPU for the drift hook)
  float t = uTime * ${(MIST_SPEED / 1.1).toFixed(5)};
  vec2 pf = bp - uPar * ${PAR_FAR.toFixed(3)};
  vec2 pn = bp + uPar * ${PAR_NEAR.toFixed(3)};
  vec2 w = vec2(nz(pf / 260.0 + vec2(t * 0.0011, -t * 0.0008)).r, nz(pf / 210.0 + vec2(0.41 - t * 0.0009, 0.17 + t * 0.001)).r) - 0.5;
  float f = nz(pf / 26.0 + vec2(-t * 1.1 / 26.0, 0.33)).g - 0.5;
  float fn = nz(pn / 26.0 + vec2(-t * 1.1 / 26.0, 0.33)).g - 0.5;
  float m1 = nz(pf / 170.0 + vec2(-t * 1.1 / 170.0, t * 0.1 / 170.0) + w * 0.3).r + 0.05 * f;
  float m2 = nz(pf / 140.0 + vec2(0.37 - t * 1.0 / 140.0, 0.61 - t * 0.12 / 140.0) - w.yx * 0.26).r + 0.05 * f;
  float m3 = nz(pn / 190.0 + vec2(0.73 - t * 1.15 / 190.0, 0.29 + t * 0.06 / 190.0) + w * 0.24).r + 0.05 * fn;
  float m4 = nz(pn / 155.0 + vec2(0.13 - t * 1.05 / 155.0, 0.83 - t * 0.05 / 155.0) - w * 0.2).r + 0.05 * fn;
  // (v4: the veils' edges a touch crisper than v3's, 0.04 of the field instead of 0.055, so the drift reads)
  float sea = max(smoothstep(0.592, 0.632, m1), smoothstep(0.607, 0.647, m2) * 0.85);
  float over = max(smoothstep(0.607, 0.647, m3), smoothstep(0.617, 0.657, m4) * 0.8);
  // wisps inside the veils
  float wisp = 0.8 + 0.4 * (nz(pf / 11.0 + vec2(-t * 1.1 / 11.0, 0.7)).a);
  float wispN = 0.8 + 0.4 * (nz(pn / 11.0 + vec2(-t * 1.1 / 11.0, 0.7)).a);
  return vec2(sea * wisp, over * wispN);
}
const vec3 MIST = vec3(0.78, 0.82, 0.9);

// The coast's ink colour here: ivory, brightened by a territory's glow. (v3: a held continent re-inks its
// printed outline, continentInk, not its coast.)
vec3 coastColor(float id, vec2 bp, out float glow) {
  vec3 c = uInkCoast;
  glow = 0.0;
  if (id > 0.5) {
    vec4 td = terrAt(id);
    glow = td.r;
    c = mix(c, uIvory, glow * 0.7);
  }
  return c;
}

// The printed continents (PLAN §2): a thin band of sea along each continent's shores takes its faint paper tint
// (sea = the band's weight, 0 elsewhere), and one heavy line bounds it: silver, or the holder's ink while it is held, swept round clockwise
// from north as it is taken (uContSweep: centre, progress, amount).
const float CONT_DR = 1.2;
vec3 continentInk(vec3 c, vec2 bp, float sea) {
  if (!inBoard(bp)) return c;
  vec2 uv = bUV(bp);
  vec4 k = texture2D(uCont, uv);
  vec4 kn = texelFetch(uCont, ivec2(uv * uFieldSize), 0);
  int own = int(kn.g * 255.0 + 0.5);
  // the region's paper tint: the continent's hue at the paper's own lightness (a zone, never a glow)
  if (own < 6 && sea > 0.001) {
    vec3 t = uContTint[own];
    float lc = dot(c, vec3(0.299, 0.587, 0.114));
    float lt = max(dot(t, vec3(0.299, 0.587, 0.114)), 1e-3);
    c = max(c + ((t - vec3(lt)) * 0.2 + 0.012) * sea, vec3(0.0));
  }
  float d = k.r * CONT_DR;
  float aa = max(fwidth(d), 1e-4);
  // a crisp printed line, lightly feathered like the coasts (the pen swells a little here and there)
  float w = uContW * (1.0 + 0.22 * (nz(bp / 4.3 + 0.17).g - 0.5));
  float a = 1.0 - smoothstep(w - 0.45 * aa, w + 0.45 * aa, d);
  if (a < 0.002) return c;
  // the pen's pressure: the line is solid, a hair drier here and there (the one brush, E2)
  a *= brushJit(bp);
  int li = int(kn.b * 255.0 + 0.5);
  vec3 lc = uContLine;
  if (li < 6) {
    vec4 sw = uContSweep[li];
    if (sw.w > 0.001) {
      vec2 dd = bp - sw.xy;
      float ang = fract(atan(dd.x, dd.y) / 6.2831853 + 1.0);
      float m = sw.z >= 0.999 ? 1.0 : 1.0 - smoothstep(sw.z - 0.035, sw.z, ang);
      lc = mix(lc, uContColor[li], sw.w * m);
    }
  }
  return mix(c, lc, a);
}

// Contact shadow of a lifted tile (the only sign of a lift on the flat board): its footprint, offset
// south-east by the lift, softened with a few taps.
float liftShadow(vec2 bp, vec2 L, float own) {
  if (L.x < 0.5 || L.y <= 0.001 || abs(L.x - own) < 0.5) return 0.0;
  vec2 o = vec2(0.8, -1.1) * L.y;
  float s = 0.0;
  s += landIdAt(bp - o) == L.x ? 0.3 : 0.0;
  s += landIdAt(bp - o * 0.72 + vec2(0.035, 0.02)) == L.x ? 0.25 : 0.0;
  s += landIdAt(bp - o * 1.25 - vec2(0.03, -0.035)) == L.x ? 0.2 : 0.0;
  s += landIdAt(bp - o * 0.9 + vec2(-0.04, -0.03)) == L.x ? 0.25 : 0.0;
  return s * clamp(L.y / 0.08, 0.0, 1.0);
}
`;

/** Ground (the whole sea, past every board edge). */
export const GROUND_VERT = /* glsl */ `
uniform vec2 uBoard;
varying vec2 vBP;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vBP = vec2(w.x + uBoard.x * 0.5, uBoard.y * 0.5 - w.z);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

export const GROUND_FRAG = /* glsl */ `
${INK_GLSL}
varying vec2 vBP;
void main() {
  vec2 bp = vBP;
  vec3 c = paperAt(bp);
  // [place v5] the evening: the open sea a few points darker by night (the washes keep their colour)
  c *= 1.0 - ${EVE_SEA.toFixed(3)} * uEve;
  float seaD = 4.0;
  if (inBoard(bp)) {
    vec4 f = fieldAt(bp);
    seaD = f.g * 4.0;
    float id = idAt(bp);
    // decorative (non-playable) land: raw paper, a shade lighter
    if (f.a > 0.5 && id < 0.5) c = mix(c, uUnclaimed, 0.55);
    // the coast glow: the heavy stroke's own bloom bleeding into the sea, drifting slowly (E2: one brush)
    float cj = coastJit(bp);
    c = mix(c, uInkCoast, COAST_BLOOM * (0.6 + 0.4 * cj) * smoothstep(0.03, 0.55, coastSoft(bp)) * (1.0 - f.a));
    vec4 k = inkAt(bp);
    float glow;
    vec3 cc = coastColor(id, bp, glow);
    float jit = brushJit(bp);
    // the decorative coasts: the Hair weight, Layer 3
    c = mix(c, uInkCoast * 0.96, k.b * 0.4 * jit);
    // the coast: the Heavy weight, Layer 2 (30–60 % against its paper), full ivory only when it glows
    c = mix(c, cc, clamp(k.r * mix(cj, 1.0, glow) * (COAST_A + (1.0 - COAST_A) * glow), 0.0, 1.0));
    // the tint: a thin shore band only (~0.3 units out); water the outline encloses stays paper
    c = continentInk(c, bp, (1.0 - f.a) * (1.0 - smoothstep(0.15, 0.32, seaD)));
    float sh = max(liftShadow(bp, uLiftA, -1.0), liftShadow(bp, uLiftB, -1.0));
    c *= 1.0 - 0.34 * sh;
  }
  // mist: the sea's own veils thin out near the coasts; the crossing veils run on over the land
  vec2 mv = mistAt(bp);
  float mist = max(mv.x * mix(0.35, 1.0, smoothstep(0.0, 0.8, seaD)), mv.y);
  c = mix(c, MIST, min(mist, 1.0) * 0.085 * uMist);
  gl_FragColor = vec4(lamp(c), 1.0);
}
`;

/** Tile tops: the wash. Local positions are relative to the tile's pivot (its anchor). */
export const TILE_VERT = /* glsl */ `
uniform vec2 uBoard;
uniform vec2 uAnchorW;
varying vec2 vBP;
void main() {
  vBP = vec2(position.x + uAnchorW.x + uBoard.x * 0.5, uBoard.y * 0.5 - (position.z + uAnchorW.y));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const TILE_FRAG = /* glsl */ `
${INK_GLSL}
uniform vec3 uColor;
uniform vec3 uDeep;
uniform float uId;
uniform float uDim;
uniform float uLight;
uniform float uFlash;
uniform float uGlow;
uniform float uDry;
uniform float uPhase;
uniform float uPeriod;
uniform float uSeed;
uniform vec2 uRim;
uniform float uFloodOn;
uniform float uFloodR;
uniform float uFloodMode;
uniform float uFloodTorn;
uniform float uFloodSeed;
uniform vec2 uFloodOrigin;
uniform vec2 uFloodDir;
uniform vec3 uFloodColor;
uniform vec3 uFloodDeep;
varying vec2 vBP;

void main() {
  vec2 bp = vBP;
  vec4 f = fieldAt(bp);
  float prox = f.r;
  float fib;
  vec3 paper = paperAt(bp, fib);
  vec3 wash = uColor;
  vec3 deep = uDeep;

  // Ink flood: the new wash soaks in behind an fbm-perturbed front with a darker, wetter leading rim.
  // Torn (a human's territory falling): a rougher, darker rim, paper fibres showing past it.
  float fresh = 0.0;
  float floodK = 0.0;
  if (uFloodOn > 0.5) {
    vec2 d = bp - uFloodOrigin;
    float r = uFloodMode > 0.5 ? dot(d, uFloodDir) : length(d);
    float ang = uFloodMode > 0.5 ? dot(d, vec2(-uFloodDir.y, uFloodDir.x)) * 0.12 : atan(d.y, d.x) * 0.55;
    float n = nz(vec2(ang, r * 0.045) + uFloodSeed).g - 0.5;
    float ragged = nz(bp / 2.3 + uFloodSeed * 1.7).a - 0.5;
    float fine = nz(bp / 0.9 + uFloodSeed * 2.9).a - 0.5;
    float front = uFloodR * (1.0 + 0.24 * n) + ragged * (0.22 + 0.5 * uFloodTorn) + fine * 0.5 * uFloodTorn;
    float soft = mix(0.22, 0.06, uFloodTorn);
    float k = 1.0 - smoothstep(front - soft, front, r);
    // the wet front: a dark tide line right at the edge, fading back into the fresh wash behind it
    float rimW = mix(0.75, 0.5, uFloodTorn);
    float rim = smoothstep(front - rimW, front - soft * 0.5, r) * k;
    rim = pow(rim, 1.6) * (0.75 + 0.5 * (ragged + 0.5));
    vec3 fc = mix(uFloodColor, uFloodDeep, clamp(rim * mix(0.95, 1.25, uFloodTorn), 0.0, 1.0));
    wash = mix(wash, fc, k);
    deep = mix(deep, uFloodDeep, k);
    floodK = k;
    // torn paper: a thin pale fringe just past the dark rim, where the old colour is being eaten
    float fringe = uFloodTorn * smoothstep(front - 0.02, front + 0.03, r) * (1.0 - smoothstep(front + 0.06, front + 0.22, r));
    wash = mix(wash, uIvory * 0.82, fringe * 0.42);
    fresh = rim;
  }

  // Watercolour: broad pools where the pigment settled, medium blotches, backrun blooms (a paler pool with
  // a darker tide line where a wetter patch pushed the pigment out), pigment granulating in the paper's
  // tooth, fibres showing through, and a darker edge where the wash dried against its border.
  // With the maps (uTexOn), from two wash taps offset per territory (so neighbours never share a bloom):
  // W1 at 22 units gives the broad pools and the bloom mask (G, the blurred pigment field: pale bloom centres
  // are where the pools are pale), the tide lines round them (A) and the granulation (B); W2 at 1.37×
  // rotated 90° gives the medium blotches from the raw pigment (R) and the second, fainter granulation (B).
  // L1 (one tap): W1 only; the blotches and the second granulation stay value noise. The edge band's inner
  // edge wanders with the bloom field, so the dried edge pools unevenly. Coefficients as before.
  float tx = uTexOn;
  bool full = uTexTaps > 1.5; // L2, L3: two wash taps
  float b1 = 0.0, b2 = 0.0, bloom = 0.0, tide = 0.0, gr = 0.0, gr2 = 0.0, wander = 0.0;
  if (tx < 0.999 || !full) {
    b2 = clamp((nz(bp / 7.0 + uSeed * 1.7).g - 0.5) * 3.0, -1.0, 1.0);
    gr2 = nz(bp / 1.7 + uSeed * 0.9 + 0.4).a;
  }
  if (tx < 0.999) {
    b1 = clamp((nz(bp / 23.0 + uSeed).r - 0.5) * 3.2, -1.0, 1.0);
    float bm = nz(bp / 13.0 + uSeed * 0.61 + 0.29).g;
    bloom = smoothstep(0.56, 0.66, bm);
    tide = 1.0 - smoothstep(0.0, 0.028, abs(bm - 0.575));
    gr = nz(bp / 3.6 + uSeed * 2.3).a;
  }
  if (tx > 0.001) {
    vec4 w1 = texture2D(uWashTex, bp / WASH_REP + vec2(uSeed, uSeed * 1.618));
    b1 = mix(b1, clamp((eqTo(w1.g, K_NZ.r) - 0.5) * 3.2, -1.0, 1.0), tx);
    bloom = mix(bloom, smoothstep(0.56, 0.66, w1.g), tx);
    tide = mix(tide, smoothstep(0.55, 0.9, w1.a), tx);
    wander = (w1.g - 0.5) * tx;
    // The map's granulation is finer and crisper than the noise it replaces, so it reads as sponge
    // speckle up close; its spread round the mean is taken down by a third (John, 2026-09-30: grain busy).
    float g1 = 0.5 + (eqTo(w1.b, K_NZ.a) - 0.5) * GRAIN_TEX;
    if (full) {
      vec4 w2 = texture2D(uWashTex, vec2(bp.y, -bp.x) / (WASH_REP * TAP2) + vec2(uSeed * 0.73 + 0.41, uSeed * 1.31 + 0.07));
      b2 = mix(b2, clamp((eqTo(w2.r, K_NZ.g) - 0.5) * 3.0, -1.0, 1.0), tx);
      gr2 = mix(gr2, 0.5 + (eqTo(w2.b, K_NZ.a) - 0.5) * GRAIN_TEX, tx);
    }
    gr = mix(gr, g1, tx);
  }
  wash *= 1.0 + 0.085 * b1 + 0.05 * b2;
  wash *= 1.0 + 0.05 * bloom - 0.07 * tide;
  wash *= 0.93 + 0.1 * smoothstep(0.28, 0.74, gr) + 0.04 * smoothstep(0.35, 0.7, gr2);
  wash *= 0.97 + 0.06 * fib;
  float edge = smoothstep(0.45 - 0.12 * wander, 1.0, prox);
  wash = mix(wash, deep, 0.26 * edge * edge + 0.1 * smoothstep(0.93, 1.0, prox));
  // (v4 E10: the wash no longer breathes at rest; only the mist, the coast glow and the lamp move)
  wash *= 1.0 - 0.08 * uBreath;

  vec3 c = mix(paper, wash, 0.92);
  c = mix(c, mix(paper, uUnclaimed, 0.6), uDry);
  // recede toward the paper
  c = mix(c, paper, 0.3 * uDim) * (1.0 - 0.05 * uDim);
  c *= 1.0 + 0.07 * uLight;
  c = mix(c, uIvory, 0.14 * uFlash);
  // the crossing veils drift over the land too (thinner there, never over a number: those sit above)
  vec2 mv = mistAt(bp);
  c = mix(c, MIST, min(1.0, mv.y * 0.6 + mv.x * 0.12) * 0.08 * uMist);

  // the coast glow bleeding into the wash (the heavy stroke's own bloom, drifting; uneven with the grain)
  float cs = coastSoft(bp);
  float cj = coastJit(bp);
  c = mix(c, uInkCoast, COAST_BLOOM * 0.8 * (0.6 + 0.4 * cj) * smoothstep(0.03, 0.55, cs) * (0.75 + 0.5 * gr));

  // ink (v4 E2): the territory border is the Light weight in the paper's deep tone, a crack of indigo between
  // washes; the coast is the Heavy weight in ivory (Layer 2 at rest, full when the territory glows)
  vec4 k = inkAt(bp);
  float glow;
  vec3 cc = coastColor(uId, bp, glow);
  glow = max(glow, uGlow);
  float jit = brushJit(bp);
  // [place v5] front lines: where this territory's border meets another seat's land, the border is the Medium
  // weight (ink A, the same brush) and this side of it is inked in this seat's light tone (from the wash showing
  // here, so a flood re-inks its half as it soaks); the neighbour's tile draws the other half in its own. Inside one
  // seat's land, against a coast, or unclaimed/neutral land, the Light hairline as before.
  float front = 0.0;
  if (uFront > 0.5 && k.a > 0.002) {
    float nb = floor(texelFetch(uCont, ivec2(bUV(bp) * uFieldSize), 0).a * 255.0 + 0.5);
    if (nb > 0.5) {
      float mine = floor(terrAt(uId).a * 255.0 + 0.5);
      float theirs = floor(terrAt(nb).a * 255.0 + 0.5);
      front = (mine > 0.5 && theirs > 0.5 && abs(mine - theirs) > 0.5) ? 1.0 : 0.0;
    }
  }
  if (front > 0.5) {
    // this seat's colour here (the flood's, behind its front), lifted to its light tone
    vec3 seat = mix(uColor, uFloodColor, floodK);
    c = mix(c, mix(seat, uIvory, ${FRONT_LIFT.toFixed(3)}), clamp(k.a * jit * ${FRONT_A.toFixed(3)} * (1.0 - 0.3 * uLight), 0.0, 1.0));
  }
  else c = mix(c, uTerrInk, clamp(k.g * jit * TERR_A * (1.0 - 0.3 * uLight), 0.0, 1.0));
  float gl = max(glow, 0.3 * uLight);
  c = mix(c, cc, clamp(k.r * mix(cj, 1.0, gl) * (COAST_A + (1.0 - COAST_A) * gl), 0.0, 1.0));
  // a continent's border across land (Ural, the isthmus, Suez) is the printed outline too
  c = continentInk(c, bp, 0.0);

  // selection rim: a screen-constant ivory line just inside the territory's own border
  if (uRim.x > 0.001) {
    float fw = max(fwidth(prox), 1e-4);
    float dpx = (1.0 - prox) / fw;
    float rim = 1.0 - smoothstep(uRim.y - 0.75, uRim.y + 0.75, dpx);
    c = mix(c, uIvory, rim * uRim.x);
  }

  float sh = max(liftShadow(bp, uLiftA, uId), liftShadow(bp, uLiftB, uId));
  c *= 1.0 - 0.3 * sh;
  gl_FragColor = vec4(lamp(c), 1.0);
}
`;

export const SIDE_FRAG = /* glsl */ `
uniform vec3 uColor;
void main() { gl_FragColor = vec4(uColor * 0.55, 1.0); }
`;
export const SIDE_VERT = /* glsl */ `
void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

// ---------------------------------------------------------------------------
// CPU mirrors of the drifting paper (v4 PLAN §5: "a point on a mist edge moves ≥ 1 px every 2 s"), for the
// board's drift hook. They read the same noise texture the shaders do (bilinear, repeat) and follow the same
// formulas, so what they measure is what the paper does.
// ---------------------------------------------------------------------------

/** The noise texture's channels, bilinear with repeat (texture2D at the base mip). */
export function nzCPU(noise: THREE.DataTexture, x: number, y: number): [number, number, number, number] {
  const img = noise.image as { data: Uint8Array; width: number; height: number };
  const W = img.width;
  const H = img.height;
  const fx = x * W - 0.5;
  const fy = y * H - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const out: [number, number, number, number] = [0, 0, 0, 0];
  const w = (v: number, m: number) => ((v % m) + m) % m;
  for (let j = 0; j < 2; j++)
    for (let i = 0; i < 2; i++) {
      const o = (w(y0 + j, H) * W + w(x0 + i, W)) * 4;
      const k = (i ? tx : 1 - tx) * (j ? ty : 1 - ty);
      for (let c = 0; c < 4; c++) out[c] += (img.data[o + c] / 255) * k;
    }
  return out;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The sea veils' field (mistAt().x before the wisps) at a board point and ambient time. */
export function mistSeaCPU(noise: THREE.DataTexture, bx: number, by: number, uTime: number, par: [number, number] = [0, 0]): number {
  // [place v5] the far layer's parallax (mistAt's pf)
  bx -= par[0] * PAR_FAR;
  by -= par[1] * PAR_FAR;
  const t = uTime * (MIST_SPEED / 1.1);
  const nz = (x: number, y: number) => nzCPU(noise, x, y);
  const w = [nz(bx / 260 + t * 0.0011, by / 260 - t * 0.0008)[0] - 0.5, nz(bx / 210 + 0.41 - t * 0.0009, by / 210 + 0.17 + t * 0.001)[0] - 0.5];
  const f = nz(bx / 26 - (t * 1.1) / 26, by / 26 + 0.33)[1] - 0.5;
  const m1 = nz(bx / 170 - (t * 1.1) / 170 + w[0] * 0.3, by / 170 + (t * 0.1) / 170 + w[1] * 0.3)[0] + 0.05 * f;
  const m2 = nz(bx / 140 + 0.37 - (t * 1.0) / 140 - w[1] * 0.26, by / 140 + 0.61 - (t * 0.12) / 140 - w[0] * 0.26)[0] + 0.05 * f;
  return Math.max(smooth(0.592, 0.632, m1), smooth(0.607, 0.647, m2) * 0.85);
}

/** The coast glow's offset (glowOffset() in the shaders), board units, at full ambient amplitude. */
export function glowOffsetCPU(noise: THREE.DataTexture, bx: number, by: number, uTime: number): [number, number] {
  const ph = nzCPU(noise, (bx / 47) * 0.37 + 0.19, (by / 47) * 0.37 + 0.19).map((v) => v * Math.PI * 2);
  const w1 = (Math.PI * 2) / GLOW_PERIODS[0];
  const w2 = (Math.PI * 2) / GLOW_PERIODS[1];
  const t = uTime;
  return [
    (0.6 * Math.sin(t * w1 + ph[0] * 2) + 0.4 * Math.sin(t * w2 + ph[1] * 3)) * GLOW_REACH,
    (0.6 * Math.sin(t * w1 * 1.07 + ph[2] * 2) + 0.4 * Math.sin(t * w2 * 1.03 + ph[3] * 3)) * GLOW_REACH,
  ];
}

/**
 * How far the paper drifted between two ambient times, board units: the median displacement of points on the
 * sea veils' edges (each tracked along its field's gradient to where the edge's level sits at t1), and the median
 * coast-glow offset change over sample coast points. `seaPts` are open-sea board points to search for edges.
 */
export function paperDriftCPU(
  noise: THREE.DataTexture,
  seaPts: [number, number][],
  coastPts: [number, number][],
  t0: number,
  t1: number,
): { mist: number; mistN: number; glow: number; glowN: number } {
  const med = (a: number[]) => {
    const s = a.slice().sort((p, q) => p - q);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };
  const LEVEL = 0.5;
  const mist: number[] = [];
  for (const [bx, by] of seaPts) {
    // walk east from the point to the first crossing of the edge's level at t0
    let px = bx;
    let prev = mistSeaCPU(noise, px, by, t0) - LEVEL;
    let edge: number | null = null;
    for (let s = 0; s < 120 && edge === null; s++) {
      const nx = px + 0.1;
      const v = mistSeaCPU(noise, nx, by, t0) - LEVEL;
      if (Math.sign(v) !== Math.sign(prev) && prev !== 0) {
        // refine the crossing
        let a = px;
        let b = nx;
        for (let it = 0; it < 18; it++) {
          const m = (a + b) / 2;
          if (Math.sign(mistSeaCPU(noise, m, by, t0) - LEVEL) === Math.sign(prev)) a = m;
          else b = m;
        }
        edge = (a + b) / 2;
      }
      px = nx;
      prev = v;
    }
    if (edge === null) continue;
    // its normal at t0
    const h = 0.05;
    const gx = (mistSeaCPU(noise, edge + h, by, t0) - mistSeaCPU(noise, edge - h, by, t0)) / (2 * h);
    const gy = (mistSeaCPU(noise, edge, by + h, t0) - mistSeaCPU(noise, edge, by - h, t0)) / (2 * h);
    const gl = Math.hypot(gx, gy);
    if (gl < 1e-4) continue;
    const nx = gx / gl;
    const ny = gy / gl;
    // where the level sits along that normal at t1: the nearest crossing within ±6 units
    const at = (d: number) => mistSeaCPU(noise, edge! + nx * d, by + ny * d, t1) - LEVEL;
    let best: number | null = null;
    const step = 0.02;
    let pv = at(0);
    if (Math.abs(pv) < 1e-6) best = 0;
    for (let k = 1; k <= 300 && best === null; k++) {
      for (const sgn of [1, -1]) {
        const d0 = sgn * (k - 1) * step;
        const d1 = sgn * k * step;
        const v0 = at(d0);
        const v1 = at(d1);
        if (Math.sign(v0) !== Math.sign(v1)) {
          best = Math.abs((d0 + d1) / 2);
          break;
        }
      }
      pv = 0;
    }
    if (best !== null) mist.push(best);
  }
  const glow: number[] = [];
  for (const [bx, by] of coastPts) {
    const a = glowOffsetCPU(noise, bx, by, t0);
    const b = glowOffsetCPU(noise, bx, by, t1);
    glow.push(Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  return { mist: med(mist), mistN: mist.length, glow: med(glow), glowN: glow.length };
}
