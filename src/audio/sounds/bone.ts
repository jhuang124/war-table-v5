// Bone: one die landing in the lacquer tray. A short, bright click, a smaller second click as it
// bounces once, and the tray's small wooden knock under both. The caller plays one per die as it lands
// (v5: 60–90 ms apart), attacker panned −0.3 and defender +0.3.
//
// v5 (the pour): three bone timbres, so five dice landing one after another read as five dice, not one
// sample five times: 0 a small bright die, 1 a rounder one, 2 a worn, heavier one. The mixer picks the
// timbre from the die's place in the landing sequence and adds the per-die rate spread (±4 %).

import { Tape, between, jitter } from '../dsp';
import type { Rand, SoundFn } from '../types';

function click(tape: Tape, at: number, a: number, f: number, rand: Rand, tray = 440, trayTau = 0.011): void {
  // the die (a small bone cube: stiff, heavily damped)
  tape.mode(at, f * jitter(rand, 0.03), 0.0018, a * 0.42, 0.0002);
  tape.mode(at, f * 1.57, 0.0011, a * 0.16, 0.0002);
  tape.burst(at, { amp: a * 0.16, attack: 0.0002, tau: 0.0009, filter: [{ type: 'bandpass', f: 2600, q: 0.9 }] }, rand);
  // the lacquer tray under it
  tape.mode(at + 0.0003, tray * jitter(rand, 0.05), trayTau, a * 0.34, 0.0007);
  tape.mode(at + 0.0003, tray * 2.3 * jitter(rand, 0.05), 0.0045, a * 0.14, 0.0006);
}

/** v5: the three bone timbres [die band lo, hi, tray Hz, tray tau, level, lowpass, second-bounce level]. */
const TIMBRES: [number, number, number, number, number, number, number][] = [
  [2200, 3000, 440, 0.011, 1, 5000, 0.36], // a small bright die (the v4 die)
  [1850, 2450, 405, 0.012, 0.97, 4600, 0.42], // a rounder one
  [1550, 2050, 365, 0.014, 0.96, 4100, 0.3], // a worn, heavier one
];

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

export const diceLand: SoundFn = (ctx, dest, t, { rate, rand, timbre }) => {
  const [lo, hi, tray, trayTau, a, lp, second] = TIMBRES[Math.max(0, Math.min(2, Math.round(timbre ?? 0)))];
  const tape = new Tape(ctx.sampleRate, 0.16);
  const f = between(rand, lo, hi);
  click(tape, 0.003, a, f, rand, tray, trayTau);
  click(tape, 0.003 + between(rand, 0.02, 0.032), a * second, f * jitter(rand, 0.02), rand, tray, trayTau);
  if (rand() < 0.4) click(tape, 0.003 + between(rand, 0.045, 0.06), a * 0.1, f, rand, tray, trayTau);
  tape.filter('lowpass', lp, 0.7).dcBlock().endFade(0.03);
  return tape.play(ctx, dest, t, rate);
};
