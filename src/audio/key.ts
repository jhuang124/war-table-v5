// v4 (PLAN §4 B2): effects are notes in the music. The pitched effects take their pitch from the
// chord sounding when they play (music.ts knows it); without the score they fall back to the
// D-aeolian tonic (D minor: root D, minor third F, fifth A).

import { between, midiHz } from './dsp';
import type { KeyRole, Rand, SfxVariant, ToneLayer } from './types';

/** The no-score fallback: D minor (root first). */
export const TONIC_PCS = [2, 5, 9];

/** Pitch classes `role` may land on for this chord (root first in `pcs`). */
export function roleClasses(pcs: number[], role: KeyRole): number[] {
  const root = ((pcs[0] % 12) + 12) % 12;
  const fifth = (root + 7) % 12;
  if (role === 'root') return [root];
  // v5: every chord in the field has its fifth (sus chords included)
  if (role === 'fifth') return [fifth];
  if (role === 'bright') return [root, fifth];
  const m3 = (root + 3) % 12;
  return pcs.includes(m3) ? [m3] : [root, fifth];
}

/**
 * The chord tone for `role` nearest to the recipe's designed pitch `ref` (MIDI), within a tritone.
 * Ties go down (warmer).
 */
export function keyPitch(pcs: number[], role: KeyRole, ref: number): number {
  const cls = roleClasses(pcs, role);
  let best = ref;
  let bestD = Infinity;
  for (let m = ref - 6; m <= ref + 6; m++) {
    if (!cls.includes(((m % 12) + 12) % 12)) continue;
    const d = Math.abs(m - ref) + (m < ref ? 0 : 0.01);
    if (d < bestD) {
      bestD = d;
      best = m;
    }
  }
  return best;
}

/** Does this layer play on this variant? */
export function layerOn(l: ToneLayer, variant?: SfxVariant): boolean {
  return !l.variants || l.variants.includes(variant ?? 'default');
}

/** Seconds a tone layer lasts after the sound's start (to −60 dB). */
export function layerDur(l: ToneLayer): number {
  let tau = 0;
  for (const p of l.partials) tau = Math.max(tau, p[2]);
  return l.at + (l.fifth?.spread ?? 0) + l.attack + tau * 6.91;
}

/**
 * Build a tuned layer into `dest`; the sound starts at context time t (the layer at t + l.at·timeScale).
 * Sine partials with a soft attack (≥ 15 ms) and exponential decays. Cheap node graph, never banked.
 * Returns its end, seconds after t.
 */
export function toneLayer(ctx: BaseAudioContext, dest: AudioNode, t: number, midi: number, l: ToneLayer, rand: Rand, timeScale = 1): number {
  const notes: [number, number, number][] = [[midi, 1, 0]];
  if (l.fifth) notes.push([midi + 7, l.fifth.amp, l.fifth.spread]);
  let end = 0;
  for (const [m, rel, spread] of notes) {
    const f0 = midiHz(m);
    const T = t + (l.at + spread) * timeScale;
    for (const [ratio, a, tau] of l.partials) {
      const f = f0 * ratio * (1 + between(rand, -0.0006, 0.0006));
      if (f > 6000) continue;
      const osc = ctx.createOscillator();
      osc.frequency.value = f;
      const g = ctx.createGain();
      const peak = l.amp * a * rel;
      g.gain.value = 0;
      g.gain.setValueAtTime(0, T);
      g.gain.linearRampToValueAtTime(peak, T + l.attack);
      g.gain.setTargetAtTime(0, T + l.attack, tau);
      osc.connect(g).connect(dest);
      const stop = T + l.attack + tau * 6.91;
      osc.start(T);
      osc.stop(stop);
      end = Math.max(end, stop - t);
    }
  }
  return end;
}
