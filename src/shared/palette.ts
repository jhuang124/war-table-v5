// Player colors. Renderer and UI both read from here so a seat looks the same everywhere.
// `base` is the tile wash / piece blot color, `deep` the shadowed side (edge darkening, dice shade),
// `light` a tint for text and marks on the indigo paper, `ink` the legible mark color on top of `base`
// (the ivory the figures and pips are drawn in).
//
// v3 physical board (_claude/v3/PLAN.md; John 2026-09-30: "palette back to the reference"). The bases are
// sampled from the chosen reference (_claude/moodboard/chosen-silver-ink-board.png): tests/e2e/palette-sample.ts
// takes the median wash over 4–5 territory patches per colour, and the board's own wash (≈ 0.91 of the base
// on screen) is backed out. Then lightness only moves (CIELAB L; chroma and hue kept) to pass the colour-blind
// check: Machado 2009 at full severity (protan, deutan, tritan) + CIEDE2000, raw and as a 0.92 wash over the
// #101a30 paper (tests/e2e/palette-check.ts, tests/e2e/colorblind.ts). Ids stay (`crimson`… are in saves).
//   sampled on screen → base: Vermilion #9d604f → #ac6957 · Slate #455c73 → #4c657e · Ochre #a78653 → #b7935b
//   · Sage #5c6852 → #65725a. As sampled the four fail (ΔE 2.45, protan Vermilion/Sage: the reference's red and
//   olive sit at one lightness); Vermilion −4 L and Sage +11 L pass. Wisteria and Plum (not in the reference)
//   take its chroma (~0.6 of the old) and move in lightness (+7, −5) to pass beside the other four.
//   Lead review (2026-09-30): Slate and Sage blurred at a 30 % squint, so Slate went a touch bluer and lighter
//   (#4c657e → #4f6e96; Slate/Sage ΔE 28.6 → 31.0 in normal vision). A warmer Sage was tried and dropped: every
//   warmer Sage fell under the bar against Ochre in protan (ΔE 6.4–8.8).
//   worst pair, default four (crimson, cobalt, amber, emerald): ΔE 10.27
//   worst pair, all six:                                       ΔE 9.97
// `deep` = base × 0.66; `light` = the base 42 % of the way to the ivory ink.

import type { PlayerColorId } from '../engine/types';
import { brushMark } from './enso';

export type SeatEmblem = 'triangle' | 'circle' | 'square' | 'diamond' | 'star' | 'cross' | 'dash';

/**
 * A seat's colour: one of the six a player can pick, or 'neutral' (v3): the 2-player neutral seat's muted
 * grey wash, which the engine deals that seat. Kept as an alias; PlayerColorId now carries 'neutral'.
 */
export type SeatColorId = PlayerColorId;

export interface PlayerPalette {
  id: SeatColorId;
  /** Shape shown wherever the seat appears (seat ring, roster, dice tray) — color-blind backup. */
  emblem: SeatEmblem;
  name: string;
  base: string;
  deep: string;
  light: string;
  ink: string;
  /**
   * v4 (additive; optional so older callers still type-check): the territory WASH, a desaturated (never lighter)
   * tint of `base`, which stays the seat's full PIGMENT (the stones). Read it through `washOf()`.
   */
  tint?: string;
  /**
   * v4 round 2 (additive, optional): the stone's 1 px edge ink (E2 Light weight), the seat's deep tone taken dark
   * enough to stand ≥ 25 % |ΔL*| off its own wash on screen: the pigment's hue, L* = the tint's − 34 (floor 8).
   * Plum's wash is already dark (L* 28), so its edge floors at L* 8 (≈ 18 off). Falls back to `deep`.
   */
  edge?: string;
}

/** The ivory the figures, pips and marks are drawn in, on every wash. */
const IVORY_INK = '#f2ede2';

// v4 (_claude/v4/PLAN.md E4, "colour in two intensities"; additive): `base` is the seat's PIGMENT (stones, seat
// ring: the seat as an object) and `tint` its WASH (the land it holds). The tint is the pigment DESATURATED in
// CIELAB, never lighter (round 2, lead 2026-10-03: a lighter tint was the rejected lightness pass): chroma × 0.8
// (the most desaturation the colour-blind bar allows; × 0.65–0.75 fail it), L* the pigment's or a little lower
// (Vermilion −2, Sage −2, Plum −6, Neutral −4: the moves that clear the bar). Tints, worst pair under Machado 2009
// full severity + CIEDE2000, raw and washed: all six ΔE 9.95 (bar 9.8), the neutral against the six 10.55
// (artifacts/board-paper/tints.ts DESAT=1, a local tool). The stone reads off its wash by its deep-tone edge, its
// painted shadow and its ivory figure and numeral, not by a lighter land.
// The reference's own washes (tests/e2e/palette-sample.ts re-run 2026-10-03: Vermilion #9d604f, Slate #455c73,
// Ochre #a78653, Sage #5c6852, paper #111d2a) stay the pigments' source; the renderer applies no lightness pass
// on top (the wash is the tint, laid at 0.92 over the paper, as in v3).
export const PLAYER_COLORS: Record<SeatColorId, PlayerPalette> = {
  crimson: { id: 'crimson', emblem: 'triangle', name: 'Vermilion', base: '#a15f4d', deep: '#6a3f33', light: '#c39b8c', ink: IVORY_INK, tint: '#935e4f', edge: '#3e0d00' },
  cobalt: { id: 'cobalt', emblem: 'circle', name: 'Slate', base: '#4f6e96', deep: '#344963', light: '#93a3b6', ink: IVORY_INK, tint: '#576e8e', edge: '#00213e' },
  emerald: { id: 'emerald', emblem: 'square', name: 'Sage', base: '#818e75', deep: '#555e4d', light: '#b0b6a3', ink: IVORY_INK, tint: '#7e8874', edge: '#2c3623' },
  amber: { id: 'amber', emblem: 'diamond', name: 'Ochre', base: '#b7935b', deep: '#79613c', light: '#d0b994', ink: IVORY_INK, tint: '#b29468', edge: '#594012' },
  violet: { id: 'violet', emblem: 'star', name: 'Wisteria', base: '#9f95bb', deep: '#69627b', light: '#c2bacb', ink: IVORY_INK, tint: '#9e96b4', edge: '#49425f' },
  rose: { id: 'rose', emblem: 'cross', name: 'Plum', base: '#704156', deep: '#4a2b39', light: '#a78991', ink: IVORY_INK, tint: '#5b3747', edge: '#2f091c' },
  // v3 (additive): the 2-player neutral seat. A muted grey wash, never pickable; ΔE ≥ 9.8 against all six
  // in every vision, raw and washed (tests/e2e/palette-check.ts prints the neutral line). The brief's #6f7278 fell
  // to 9.19 against Sage (tritan, washed); two steps darker (#6d7076) clears it at 9.83 (vs Plum, deutan, washed).
  neutral: { id: 'neutral', emblem: 'dash', name: 'Neutral', base: '#6d7076', deep: '#484a4e', light: '#a3a6ab', ink: IVORY_INK, tint: '#64666b', edge: '#181a1e' },
};

/** The wash a seat's territories take (v4 E4): its tint, or its pigment for a palette without one. */
export function washOf(p: Pick<PlayerPalette, 'base' | 'tint'>): string {
  return p.tint ?? p.base;
}

/**
 * The one gold (v4, _claude/v4/PLAN.md §5 and 8a Q2: "candle, not brass"; additive). v3's brass #c9a961
 * (CIELAB L 70.6, C 41.3, h 86°) turned 8° toward orange at 90 % of the chroma (L 70.6, C 37.2, h 78°): warmer,
 * a touch quieter. The renderer reads it through src/render/util.ts GOLD; the HUD's CSS gold should follow.
 */
export const GOLD = '#cfa66b';
/** v3's brass gold (for comparison shots only). */
export const GOLD_BRASS = '#c9a961';

/** The six colours a seat can pick, in picker order (the neutral grey is not one of them). */
export const PLAYER_COLOR_IDS: PlayerColorId[] = ['crimson', 'cobalt', 'emerald', 'amber', 'violet', 'rose'];

/** Default colors for seats 1-4 (docs/ROUND2.md §E): Vermilion, Slate, Ochre, Sage (worst pair ΔE 10.27). */
export const DEFAULT_SEAT_COLORS: PlayerColorId[] = ['crimson', 'cobalt', 'amber', 'emerald'];

type Pt = [number, number];
const ring = (n: number, r: number, cx = 12, cy = 12, rot = 0): Pt[] =>
  Array.from({ length: n }, (_, i) => {
    const a = rot + (i / n) * Math.PI * 2;
    return [cx + Math.sin(a) * r, cy - Math.cos(a) * r];
  });
const star: Pt[] = Array.from({ length: 10 }, (_, i) => {
  const a = (i / 10) * Math.PI * 2;
  const r = i % 2 ? 4 : 9.2;
  return [12 + Math.sin(a) * r, 12.6 - Math.cos(a) * r];
});

/**
 * Emblem marks as filled SVG path data in a 24×24 viewBox, drawn as brush strokes (a loaded brush
 * round each outline, stopping just short where it started). Render and UI fill the same shapes.
 */
export const EMBLEM_PATHS: Record<SeatEmblem, string> = {
  triangle: brushMark([[12, 3.2], [21, 19.6], [3, 19.6]], { seed: 11, width: 3, closed: true }),
  circle: brushMark(ring(36, 8.4, 12, 12, 0.35), { seed: 12, width: 3, closed: true, samples: 80 }),
  square: brushMark([[4.2, 4.4], [19.8, 4.2], [19.9, 19.8], [4.1, 19.9]], { seed: 13, width: 3, closed: true }),
  diamond: brushMark([[12, 2.4], [21.6, 12], [12, 21.6], [2.4, 12]], { seed: 14, width: 3, closed: true }),
  star: brushMark(star, { seed: 15, width: 2.5, closed: true, samples: 96 }),
  cross: brushMark([[12, 3], [12, 21]], { seed: 16, width: 3.4 }) + brushMark([[3, 12.2], [21, 11.8]], { seed: 17, width: 3.4 }),
  dash: brushMark([[4.5, 12.4], [19.5, 11.6]], { seed: 18, width: 3.2 }),
};

/** Neutral wash for unclaimed territories during a draft: bare paper-toned ivory, dimmed. */
export const UNCLAIMED_COLOR = '#8f8a7e';

/**
 * The continents' printed tints (v3, _claude/v3/PLAN.md §2: "the real board's coloured zones, at ink
 * restraint"), CONTINENT_IDS order: North America ochre, South America rust, Europe steel, Africa umber,
 * Asia green, Australia plum. The board mixes them 10 % into each continent's halo of sea and prints the
 * continent's name in them; the seat strip's held-continent ticks use them lifted toward the ivory.
 */
export const CONTINENT_TINTS = ['#8a7443', '#8a4f43', '#56709a', '#7d6448', '#56785c', '#76597f'];
/** A continent tint lifted toward the ivory ink, so it reads as a mark or a word on the indigo paper. */
export function continentInk(i: number, k = 0.38): string {
  const h = CONTINENT_TINTS[i] ?? '#888888';
  const c = [1, 3, 5].map((j) => parseInt(h.slice(j, j + 2), 16));
  const iv = [242, 237, 226];
  return `#${c.map((v, j) => Math.round(v + (iv[j] - v) * k).toString(16).padStart(2, '0')).join('')}`;
}
