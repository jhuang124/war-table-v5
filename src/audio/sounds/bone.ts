// Bone: one die landing in the lacquer tray. A short, bright click, a smaller second click as it
// bounces once, and the tray's small wooden knock under both. The caller plays one per die, 40 ms
// apart, attacker panned −0.3 and defender +0.3, so a roll reads as two little clusters of clicks.

import { Tape, between, jitter } from '../dsp';
import type { Rand, SoundFn } from '../types';

function click(tape: Tape, at: number, a: number, f: number, rand: Rand): void {
  // the die (a small bone cube: stiff, heavily damped)
  tape.mode(at, f * jitter(rand, 0.03), 0.0018, a * 0.42, 0.0002);
  tape.mode(at, f * 1.57, 0.0011, a * 0.16, 0.0002);
  tape.burst(at, { amp: a * 0.16, attack: 0.0002, tau: 0.0009, filter: [{ type: 'bandpass', f: 2600, q: 0.9 }] }, rand);
  // the lacquer tray under it
  tape.mode(at + 0.0003, 440 * jitter(rand, 0.05), 0.011, a * 0.34, 0.0007);
  tape.mode(at + 0.0003, 1010 * jitter(rand, 0.05), 0.0045, a * 0.14, 0.0006);
}

/**
 * v4 cue 'bone': one short bone click, the AI's readable roll (never the full dice texture). A single
 * die settling on the tray: one click and its small bounce, a little darker and softer than diceLand.
 */
export const bone: SoundFn = (ctx, dest, t, { rate, rand }) => {
  const tape = new Tape(ctx.sampleRate, 0.14);
  const f = between(rand, 1900, 2400);
  click(tape, 0.003, 1, f, rand);
  click(tape, 0.003 + between(rand, 0.026, 0.034), 0.28, f * jitter(rand, 0.02), rand);
  tape.filter('lowpass', 4200, 0.7).dcBlock().endFade(0.03);
  return tape.play(ctx, dest, t, rate);
};

export const diceLand: SoundFn = (ctx, dest, t, { rate, rand }) => {
  const tape = new Tape(ctx.sampleRate, 0.16);
  const f = between(rand, 2200, 3000);
  click(tape, 0.003, 1, f, rand);
  click(tape, 0.003 + between(rand, 0.02, 0.032), 0.36, f * jitter(rand, 0.02), rand);
  if (rand() < 0.4) click(tape, 0.003 + between(rand, 0.045, 0.06), 0.1, f, rand);
  tape.filter('lowpass', 5000, 0.7).dcBlock().endFade(0.03);
  return tape.play(ctx, dest, t, rate);
};
