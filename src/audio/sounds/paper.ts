// Paper: the sheet the game is painted on. Button ticks, the refused-click pat, cards, and the
// turn "breath" (a sheet lifting and settling). Everything is soft, short and dry: paper never rings.

import { Tape, between, biquad, clamp, jitter, svf } from '../dsp';
import type { Rand, SoundFn } from '../types';

/** Noise with paper-fibre grain: white noise amplitude-modulated by slow random roughness. */
export function paperNoise(n: number, rand: Rand, sr: number, grainHz = 140, grain = 2.2): Float32Array {
  const out = new Float32Array(n);
  let g = 0;
  const a = 1 - Math.exp((-2 * Math.PI * grainHz) / sr);
  for (let i = 0; i < n; i++) {
    g += a * (rand() * 2 - 1 - g);
    out[i] = (rand() * 2 - 1) * (0.6 + grain * Math.abs(g));
  }
  return out;
}

/** A fingertip pat on paper over the table: a tiny dry burst with the table's small body under it. */
export function pat(tape: Tape, t0: number, amp: number, rand: Rand, o: { f?: number; body?: number; dull?: number } = {}): void {
  const f = (o.f ?? 1700) * jitter(rand, 0.08);
  const dull = o.dull ?? 0;
  tape.burst(t0, { amp: amp * 0.5 * (1 - 0.5 * dull), attack: 0.0004, tau: 0.0024 + 0.003 * dull, filter: [{ type: 'bandpass', f: f * (1 - 0.45 * dull), q: 0.9 }] }, rand);
  tape.burst(t0, { amp: amp * 0.22, attack: 0.0006, tau: 0.006, filter: [{ type: 'lowpass', f: 700 }] }, rand);
  const body = o.body ?? 1;
  if (body > 0) {
    tape.mode(t0 + 0.0003, 430 * jitter(rand, 0.05) * (1 - 0.3 * dull), 0.007 + 0.006 * dull, amp * 0.3 * body, 0.0008);
    tape.mode(t0 + 0.0003, 1080 * jitter(rand, 0.05), 0.0028, amp * 0.1 * body, 0.0006);
  }
}

/** A sheet sliding `dur` seconds from `t0`, swept band-pass (friction brightens as it speeds up). */
export function cardSlide(tape: Tape, t0: number, dur: number, amp: number, rand: Rand, fLo = 1200, fHi = 2600): void {
  const sr = tape.sr;
  const n = Math.round(dur * sr);
  const x = paperNoise(n, rand, sr);
  for (let i = 0; i < n; i++) {
    const u = i / n;
    x[i] *= Math.pow(Math.sin(Math.PI * Math.pow(u, 0.7)), 1.4);
  }
  svf(x, sr, 'bp', (i) => fLo + (fHi - fLo) * clamp(i / n, 0, 1), 0.9);
  biquad(x, sr, 'lowpass', 3800, 0.7);
  const start = Math.max(0, Math.round(t0 * sr));
  for (let i = 0; i < n && start + i < tape.data.length; i++) tape.data[start + i] += x[i] * amp;
}

/**
 * v4 paper tick (B4): a fingertip brushing the sheet, no pitch at all (no table mode under it), so it
 * never competes with the score. Fibre noise only, a short swell (≥ 15 ms with the mixer's fade-in)
 * and a quick dry fall. `f` sets the fibre band; `body` adds a little low paper (not a tone).
 */
export function paperTick(tape: Tape, t0: number, amp: number, rand: Rand, o: { f?: number; body?: number } = {}): void {
  const sr = tape.sr;
  const f = (o.f ?? 2000) * jitter(rand, 0.07);
  const n = Math.round(0.07 * sr);
  const x = paperNoise(n, rand, sr, 260, 2.4);
  const lo = new Float32Array(x);
  const rise = 0.026;
  for (let i = 0; i < n; i++) {
    const tt = i / sr;
    const e = tt < rise ? 0.5 - 0.5 * Math.cos((Math.PI * tt) / rise) : Math.exp(-(tt - rise) / 0.012);
    x[i] *= e;
    lo[i] *= e;
  }
  biquad(x, sr, 'bandpass', f, 0.9);
  biquad(x, sr, 'lowpass', 4200, 0.7);
  biquad(lo, sr, 'lowpass', 520, 0.7);
  biquad(lo, sr, 'highpass', 160, 0.7);
  const b = o.body ?? 0.35;
  const s0 = Math.max(0, Math.round(t0 * sr));
  for (let i = 0; i < n && s0 + i < tape.data.length; i++) tape.data[s0 + i] += (x[i] + lo[i] * b) * amp;
}

/** Button press / Turn Track segment change: the paper tick (pitchless). */
export const uiClick: SoundFn = (ctx, dest, t, { rate, rand }) => {
  const tape = new Tape(ctx.sampleRate, 0.1);
  paperTick(tape, 0.001, 1, rand, { f: 2100, body: 0.3 });
  tape.dcBlock().endFade(0.015);
  return tape.play(ctx, dest, t, rate);
};

/** v4 cue 'tick': the board's paper tick (tap a territory, the deal's flips, the round numeral). */
export const tick: SoundFn = (ctx, dest, t, { rate, rand }) => {
  const tape = new Tape(ctx.sampleRate, 0.1);
  paperTick(tape, 0.001, 1, rand, { f: 1600, body: 0.55 });
  tape.dcBlock().endFade(0.015);
  return tape.play(ctx, dest, t, rate);
};

/**
 * v4 cue 'sheet': a sheet of paper laid on the table (overlays open), or lifted off it ('lift').
 * Laid on: a short slide as it comes down, the air pushed out from under it, a soft settle.
 * Lifted: the sheet peels up (air rushing in under it, brightening), one small flutter, gone.
 */
export const sheet: SoundFn = (ctx, dest, t, { rate, rand, variant }) => {
  const sr = ctx.sampleRate;
  const lift = variant === 'lift';
  const tape = new Tape(sr, 0.5);
  if (!lift) {
    const d = 0.2 * jitter(rand, 0.08);
    cardSlide(tape, 0.002, d, 0.75, rand, 700 * jitter(rand, 0.06), 1500 * jitter(rand, 0.06));
    // the air pushed out from under it, then the sheet settles
    tape.burst(0.002 + d * 0.8, { amp: 0.16, attack: 0.03, tau: 0.05, filter: [{ type: 'bandpass', f: 650, q: 0.6 }] }, rand);
    paperTick(tape, 0.002 + d * 0.92, 0.55, rand, { f: 1100, body: 1 });
  } else {
    const n = Math.round(0.26 * sr);
    const x = paperNoise(n, rand, sr, 80, 1.3);
    for (let i = 0; i < n; i++) {
      const u = i / n;
      x[i] *= u < 0.35 ? Math.sin((Math.PI * u) / 0.7) : Math.pow(Math.cos((Math.PI * (u - 0.35)) / 1.3), 2);
    }
    svf(x, sr, 'bp', (i) => 600 + 1300 * clamp(i / n, 0, 1), 0.8);
    biquad(x, sr, 'lowpass', 3600, 0.7);
    for (let i = 0; i < n; i++) tape.data[i + 1] += x[i] * 0.8;
    // one small flutter as it leaves the table
    const fl = Math.round(0.16 * sr);
    const m = Math.round(0.06 * sr);
    const y = paperNoise(m, rand, sr, 220, 2.6);
    for (let i = 0; i < m; i++) y[i] *= Math.sin((Math.PI * i) / m);
    biquad(y, sr, 'bandpass', 1900, 1);
    for (let i = 0; i < m; i++) tape.data[fl + i] += y[i] * 0.3;
  }
  tape.dcBlock().endFade(0.03);
  return tape.play(ctx, dest, t, rate);
};

/** Hover is silent in the ink build (no hover sounds). Kept buildable so old callers never break. */
export const uiHover: SoundFn = (ctx, dest, t, { rate, rand }) => {
  const tape = new Tape(ctx.sampleRate, 0.05);
  pat(tape, 0.001, 0.4, rand, { f: 1500, body: 0.4 });
  tape.dcBlock().endFade(0.012);
  return tape.play(ctx, dest, t, rate);
};

/** "Not allowed": two dull pats on the paper, the second lower. Gentle, never a buzzer. */
export const uiError: SoundFn = (ctx, dest, t, { rate, rand }) => {
  const tape = new Tape(ctx.sampleRate, 0.3);
  const knock = (t0: number, f: number, amp: number) => {
    tape.mode(t0, f, 0.022, amp, 0.0015);
    tape.mode(t0, f * 2.1, 0.009, amp * 0.3, 0.0015);
    pat(tape, t0, amp * 0.9, rand, { f: 900, body: 0, dull: 1 });
  };
  const p = jitter(rand, 0.02);
  knock(0.002, 250 * p, 1);
  knock(0.002 + 0.1 + between(rand, -0.004, 0.004), 198 * p, 0.8);
  tape.dcBlock().endFade(0.02);
  return tape.play(ctx, dest, t, rate);
};

export const cardDraw: SoundFn = (ctx, dest, t, { rate, rand }) => {
  const tape = new Tape(ctx.sampleRate, 0.3);
  const dur = 0.17 * jitter(rand, 0.1);
  cardSlide(tape, 0.003, dur, 0.9, rand, 1000 * jitter(rand, 0.08), 2300 * jitter(rand, 0.08));
  pat(tape, 0.003 + dur * 0.92, 0.8, rand, { f: 1400, body: 0.9, dull: 0.4 });
  tape.dcBlock().endFade(0.02);
  return tape.play(ctx, dest, t, rate);
};

/** Cards cashed in: three sheets fanned onto the paper, then the stack settles. */
export const cardTrade: SoundFn = (ctx, dest, t, { rate, rand }) => {
  const tape = new Tape(ctx.sampleRate, 0.5);
  for (let k = 0; k < 3; k++) {
    const at = Math.max(0.001, 0.003 + k * 0.075 + between(rand, -0.004, 0.004));
    cardSlide(tape, at, 0.06, 0.55, rand, 1100, 2400);
    pat(tape, at + 0.055, 0.75 - k * 0.08, rand, { f: 1500, body: 0.7, dull: 0.3 });
  }
  // the stack settles: a soft, low pat and a breath of air pushed out from under it
  const s = 0.3 + between(rand, -0.005, 0.005);
  pat(tape, s, 0.9, rand, { f: 900, body: 1.2, dull: 0.8 });
  tape.burst(s, { amp: 0.08, attack: 0.012, tau: 0.035, filter: [{ type: 'bandpass', f: 800, q: 0.7 }] }, rand);
  tape.dcBlock().endFade(0.03);
  return tape.play(ctx, dest, t, rate);
};

/**
 * Your move: the turn "breath". A sheet lifts, air moves under it, and it settles back on the table.
 * `bright` (after AI turns): the sheet lifts a little higher and flutters once, so the room looks up.
 */
export const turnStart: SoundFn = (ctx, dest, t, { rate, rand, variant }) => {
  const sr = ctx.sampleRate;
  const bright = variant === 'bright';
  const D = (bright ? 0.52 : 0.46) * jitter(rand, 0.04);
  const tape = new Tape(sr, D + 0.2);
  const n = Math.round(D * sr);
  const x = paperNoise(n, rand, sr, 60, 1.4);
  const peakAt = 0.3;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const e = u < peakAt ? Math.sin((Math.PI * u) / (2 * peakAt)) : Math.pow(Math.cos((Math.PI * (u - peakAt)) / (2 * (1 - peakAt))), 1.6);
    x[i] *= e;
  }
  const body = new Float32Array(x);
  const lo = 620 * jitter(rand, 0.06);
  const hi = (bright ? 2000 : 1600) * jitter(rand, 0.06);
  svf(x, sr, 'bp', (i) => {
    const u = clamp(i / n, 0, 1);
    return u < peakAt ? lo + (hi - lo) * (u / peakAt) : hi - (hi - 800) * ((u - peakAt) / (1 - peakAt));
  }, 0.8);
  biquad(x, sr, 'lowpass', 3800, 0.7);
  biquad(body, sr, 'lowpass', 420, 0.7);
  biquad(body, sr, 'highpass', 160, 0.7);
  for (let i = 0; i < n; i++) tape.data[i + 1] += x[i] * 0.8 + body[i] * 0.9;
  if (bright) {
    // one small flutter as the sheet turns
    const fl = D * 0.42;
    const m = Math.round(0.07 * sr);
    const y = paperNoise(m, rand, sr, 200, 2.6);
    for (let i = 0; i < m; i++) y[i] *= Math.sin((Math.PI * i) / m);
    biquad(y, sr, 'bandpass', 2100, 1);
    const s0 = Math.round(fl * sr);
    for (let i = 0; i < m; i++) tape.data[s0 + i] += y[i] * 0.35;
  }
  // it settles
  pat(tape, D * 0.9, 0.42, rand, { f: 1100, body: 1, dull: 0.7 });
  tape.dcBlock().endFade(0.03);
  return tape.play(ctx, dest, t, rate);
};
