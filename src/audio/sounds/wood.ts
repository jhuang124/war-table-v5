// Wood: the dice cup. Bone dice shaken in a small lacquered wooden cup: low, dry and hollow. The
// dice clicking against each other stay under the cup's knock, so the shake reads as wood, not glass.
// Timing: the shake fills `duration` (default 150 ms at 1×); its pitch never changes with length.

import { Tape, between, biquad, clamp, jitter, svf } from '../dsp';
import type { SoundFn } from '../types';
import { paperNoise } from './paper';

/**
 * v4 cue 'cupSlide': the turned-wood cup slides along the seat strip to the next player (turn passes).
 * Wood on paper: a low, soft friction with the cup's hollow body murmuring under it. ~400 ms (follows
 * `duration`), eased in and out so it never starts or stops abruptly.
 */
export const cupSlide: SoundFn = (ctx, dest, t, { rate, rand, duration }) => {
  const sr = ctx.sampleRate;
  const D = duration ?? 0.4;
  const tape = new Tape(sr, D + 0.06);
  const n = Math.round(D * sr);
  const x = paperNoise(n, rand, sr, 55, 1.6);
  for (let i = 0; i < n; i++) {
    const u = i / n;
    // eased: in over the first quarter, out over the last third
    const e = u < 0.25 ? Math.sin((Math.PI * u) / 0.5) : u > 0.67 ? Math.cos((Math.PI * (u - 0.67)) / 0.66) : 1;
    x[i] *= e * e;
  }
  const body = new Float32Array(x);
  // friction: a band that rises a little as the cup gets going, then settles
  svf(x, sr, 'bp', (i) => 520 + 380 * Math.sin(Math.PI * clamp(i / n, 0, 1)), 0.9);
  biquad(x, sr, 'lowpass', 2400, 0.7);
  // the hollow cup over the paper
  const cup = 330 * jitter(rand, 0.05);
  biquad(body, sr, 'bandpass', cup, 2.2);
  biquad(body, sr, 'highpass', 140, 0.7);
  for (let i = 0; i < n; i++) tape.data[i + 1] += x[i] * 0.85 + body[i] * 1.1;
  tape.dcBlock().endFade(0.03);
  return tape.play(ctx, dest, t, rate);
};

/**
 * v4 cue 'cupSet': the cup set down at the next seat. A placed (not slammed) knock of turned wood on
 * the table: a soft low thump and the cup's short hollow ring. The ring's pitch is the chord root
 * (a tone layer the mixer adds in key, see sounds/index.ts); this is the unpitched wood body.
 */
export const cupSet: SoundFn = (ctx, dest, t, { rate, rand }) => {
  const tape = new Tape(ctx.sampleRate, 0.4);
  const at = 0.003;
  tape.burst(at, { amp: 0.32, attack: 0.02, tau: 0.03, filter: [{ type: 'lowpass', f: 420 }, { type: 'highpass', f: 90 }] }, rand);
  tape.burst(at, { amp: 0.1, attack: 0.02, tau: 0.012, filter: [{ type: 'bandpass', f: 1200 * jitter(rand, 0.06), q: 0.8 }] }, rand);
  tape.mode(at + 0.001, 175 * jitter(rand, 0.04), 0.03, 0.34, 0.02);
  tape.mode(at + 0.001, 470 * jitter(rand, 0.04), 0.014, 0.1, 0.02);
  // the cup rocks once on its foot, softer
  const rock = at + between(rand, 0.045, 0.06);
  tape.mode(rock, 190 * jitter(rand, 0.04), 0.02, 0.09, 0.006);
  tape.dcBlock().endFade(0.04);
  return tape.play(ctx, dest, t, rate);
};

export const diceShake: SoundFn = (ctx, dest, t, { rate, rand, duration }) => {
  const sr = ctx.sampleRate;
  const D = duration ?? 0.15;
  const strokes = Math.max(1, Math.round(D / 0.16));
  const sd = D / strokes;
  const tape = new Tape(sr, D + 0.09);
  const cup = 560 * jitter(rand, 0.05);
  for (let s = 0; s < strokes; s++) {
    const at0 = 0.004 + s * sd;
    const amp = strokes === 1 ? 1 : s === 0 ? 0.75 : s === strokes - 1 ? 0.9 : 1;
    const span = sd * 0.86;
    const n = Math.round(between(rand, 7, 10) * Math.min(1.2, Math.max(0.5, sd / 0.16)));
    for (let i = 0; i < n; i++) {
      // the first collision lands right at the start of the stroke (instant response)
      const x = i === 0 ? 0.3 : rand();
      const at = i === 0 ? at0 : at0 + span * Math.pow(x, 0.6);
      const a = amp * between(rand, 0.3, 1) * (0.45 + 0.55 * x);
      if (rand() < 0.3) {
        // die against die: small, bony, damped
        const f = between(rand, 1900, 2700);
        tape.mode(at, f, 0.0016, a * 0.28, 0.0003);
      } else {
        // die against the lacquered wall
        const f = cup * between(rand, 0.85, 1.35);
        tape.mode(at, f, 0.007, a * 0.65, 0.0006);
        tape.mode(at, f * 2.4, 0.0028, a * 0.2, 0.0005);
        tape.burst(at, { amp: a * 0.12, attack: 0.0005, tau: 0.0025, filter: [{ type: 'lowpass', f: 1400 }] }, rand);
      }
    }
    // the dice slam the far wall together at the end of the stroke
    const slam = at0 + span + between(rand, -0.004, 0.003);
    for (let k = 0; k < 3; k++) {
      const at = slam + between(rand, 0, 0.01);
      tape.mode(at, cup * between(rand, 0.9, 1.2), 0.009, amp * 0.7, 0.0007);
      tape.burst(at, { amp: amp * 0.2, attack: 0.0006, tau: 0.004, filter: [{ type: 'lowpass', f: 1200 }] }, rand);
    }
  }
  // the cup is hollow: its body rings under everything
  const body = new Float32Array(tape.data);
  biquad(body, sr, 'bandpass', cup * 0.92, 3.5);
  for (let i = 0; i < body.length; i++) tape.data[i] += body[i] * 1.5;
  tape.filter('lowpass', 3600, 0.7).dcBlock().normalizeWindow(0.25).endFade(0.03);
  return tape.play(ctx, dest, t, rate);
};

/**
 * v5 cue 'rattle': the cup rattles once (~300 ms): before an AI's first attack, and when anyone taps the
 * cup. One short shake of the turned-wood cup with the bone dice inside: a few dice against the wall, the
 * dice meeting the far side together, then two of them settling with small bone clicks. Softer and
 * shorter than the roll's shake, so it reads as presence, not as a roll. Sits slightly across the table
 * (its default distance is 0.3).
 */
export const rattle: SoundFn = (ctx, dest, t, { rate, rand }) => {
  const sr = ctx.sampleRate;
  const tape = new Tape(sr, 0.34);
  const cup = 520 * jitter(rand, 0.05);
  const span = 0.15;
  const n = Math.round(between(rand, 6, 8));
  for (let i = 0; i < n; i++) {
    // the first collision lands right at the start (the cup answers at once)
    const x = i === 0 ? 0 : rand();
    const at = 0.004 + span * Math.pow(x, 0.7);
    const a = i === 0 ? 0.7 : between(rand, 0.35, 0.9) * (0.5 + 0.5 * x);
    if (i > 0 && rand() < 0.35) tape.mode(at, between(rand, 1900, 2600), 0.0016, a * 0.24, 0.0003);
    else {
      const f = cup * between(rand, 0.85, 1.3);
      tape.mode(at, f, 0.007, a * 0.6, 0.0006);
      tape.mode(at, f * 2.4, 0.0028, a * 0.18, 0.0005);
      tape.burst(at, { amp: a * 0.1, attack: 0.0005, tau: 0.0025, filter: [{ type: 'lowpass', f: 1400 }] }, rand);
    }
  }
  // the dice meet the far wall together
  const slam = 0.004 + span + between(rand, 0.005, 0.015);
  for (let k = 0; k < 3; k++) {
    const at = slam + between(rand, 0, 0.009);
    tape.mode(at, cup * between(rand, 0.9, 1.2), 0.009, 0.62, 0.0007);
    tape.burst(at, { amp: 0.16, attack: 0.0006, tau: 0.004, filter: [{ type: 'lowpass', f: 1200 }] }, rand);
  }
  // two dice settle inside: small bone clicks, the cup's floor under them
  for (let k = 0; k < 2; k++) {
    const at = slam + 0.04 + k * between(rand, 0.025, 0.04);
    const a = k ? 0.28 : 0.42;
    tape.mode(at, between(rand, 2000, 2600), 0.0016, a * 0.4, 0.0003);
    tape.mode(at + 0.0003, 400 * jitter(rand, 0.05), 0.008, a * 0.35, 0.0007);
  }
  const body = new Float32Array(tape.data);
  biquad(body, sr, 'bandpass', cup * 0.92, 3.5);
  for (let i = 0; i < body.length; i++) tape.data[i] += body[i] * 1.4;
  tape.filter('lowpass', 3600, 0.7).dcBlock().normalizeWindow(0.25).endFade(0.04);
  return tape.play(ctx, dest, t, rate);
};
