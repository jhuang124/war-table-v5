// Pass/fail rules for offline measurements. Shared by the lab page and the verify script.

import type { SoundStats } from './analyze';
import { DEFAULT_ATTACK } from './mixer';
import { SFX } from './sounds';
import { TIER_TARGET_LUFS, type SfxName } from './types';

export const LIMITS = {
  /** Every render, every seed. */
  peakMaxDb: -1,
  /** Median short-term loudness must land within this of the tier target. */
  loudnessTolDb: 1.5,
  /** Spread of lk200 across seeds (variation must not change loudness much). */
  seedSpreadDb: 3,
  dcMax: 0.002,
  startAbsMax: 1e-3,
  endDbMax: -70,
  centroidMaxHz: 3500,
  hfShareMax: 0.03,
  subShareMax: 0.05,
  onsetMaxMs: 12,
  onsetMaxMsStinger: 40,
  onsetMaxMsSwell: 80,
  laptopShareMin: 0.45,
  /** On laptop speakers a sound may lose at most this much against its tier target. */
  laptopDropMaxDb: 4,
  /**
   * v4 (B4): everything but the one sharp family (diceLand, bone, continent, eliminated) fades in over
   * ≥ 15 ms; measured as onset → within 1 dB of the envelope's max (a linear fade reaches −1 dB at 89%).
   */
  riseMinMs: 13,
  /** v4 (B4): the sharp family really is sharp. */
  sharpRiseMaxMs: 8,
};

/** v4 (B4): this sound starts from zero (no fade-in). */
export const isSharp = (name: SfxName): boolean => (SFX[name].attack ?? DEFAULT_ATTACK) === 0;

export interface SoundReport {
  name: SfxName;
  tier: string;
  target: number;
  trimDb: number;
  seeds: number;
  median: SoundStats;
  lk200Min: number;
  lk200Max: number;
  peakMaxDb: number;
  reportedDurMax: number;
  suggestedTrimDb: number;
  failures: string[];
}

const med = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export function summarize(name: SfxName, runs: { stats: SoundStats; reportedDur: number }[]): SoundReport {
  const meta = SFX[name];
  const target = TIER_TARGET_LUFS[meta.tier];
  const lk = runs.map((r) => r.stats.lk200);
  const byLk = [...runs].sort((a, b) => a.stats.lk200 - b.stats.lk200);
  const median = byLk[Math.floor(byLk.length / 2)].stats;
  const lkMed = med(lk);
  const peakMax = Math.max(...runs.map((r) => r.stats.peakDb));
  const repMax = Math.max(...runs.map((r) => r.reportedDur));
  const f: string[] = [];
  const stinger = meta.group === 'Stingers' || name === 'cardTrade';

  for (const r of runs) {
    const s = r.stats;
    if (s.nan) f.push(`NaN samples: ${s.nan}`);
    if (s.clipped) f.push(`clipped samples: ${s.clipped}`);
    if (!(s.peakDb > -60)) f.push(`silent (peak ${s.peakDb.toFixed(1)} dBFS)`);
    if (s.dc > LIMITS.dcMax) f.push(`DC offset ${s.dc.toExponential(2)}`);
    if (s.startAbs > LIMITS.startAbsMax) f.push(`click at start (|x0| = ${s.startAbs.toExponential(2)})`);
    if (s.endDb > LIMITS.endDbMax) f.push(`tail cut off (last 10 ms at ${s.endDb.toFixed(1)} dBFS)`);
  }
  if (peakMax > LIMITS.peakMaxDb) f.push(`peak ${peakMax.toFixed(2)} dBFS > ${LIMITS.peakMaxDb}`);
  if (Math.abs(lkMed - target) > LIMITS.loudnessTolDb) f.push(`loudness ${lkMed.toFixed(1)} LUFS vs target ${target} (±${LIMITS.loudnessTolDb})`);
  if (Math.max(...lk) - Math.min(...lk) > LIMITS.seedSpreadDb) f.push(`loudness varies ${(Math.max(...lk) - Math.min(...lk)).toFixed(1)} dB across seeds`);
  if (median.centroidHz > LIMITS.centroidMaxHz) f.push(`bright: centroid ${median.centroidHz.toFixed(0)} Hz`);
  if (median.hfShare > LIMITS.hfShareMax) f.push(`fizz: ${(median.hfShare * 100).toFixed(1)}% energy > 8 kHz`);
  if (median.subShare > LIMITS.subShareMax) f.push(`sub rumble: ${(median.subShare * 100).toFixed(1)}% < 40 Hz`);
  if (median.laptopShare < LIMITS.laptopShareMin) f.push(`laptop speakers lose it: ${(median.laptopShare * 100).toFixed(0)}% in 150 Hz–5 kHz`);
  const lapMed = med(runs.map((r) => r.stats.lkLaptop));
  if (lapMed < target - LIMITS.laptopDropMaxDb) f.push(`on laptop speakers ${lapMed.toFixed(1)} LUFS, more than ${LIMITS.laptopDropMaxDb} dB under target ${target}`);
  // whoosh is a swell by design; stingers may breathe in; everything else must answer instantly
  const onsetMax = name === 'whoosh' ? LIMITS.onsetMaxMsSwell : stinger ? LIMITS.onsetMaxMsStinger : LIMITS.onsetMaxMs;
  if (median.onsetMs > onsetMax) f.push(`slow onset ${median.onsetMs.toFixed(1)} ms`);
  const riseMin = Math.min(...runs.map((r) => r.stats.riseMs));
  if (!isSharp(name) && riseMin < LIMITS.riseMinMs) f.push(`hard onset: rises in ${riseMin.toFixed(0)} ms (B4: ≥ 15 ms fade-in)`);
  if (repMax > meta.maxDur + 1e-6) f.push(`reported duration ${repMax.toFixed(3)} s > maxDur ${meta.maxDur}`);

  return {
    name,
    tier: meta.tier,
    target,
    trimDb: meta.trimDb,
    seeds: runs.length,
    median,
    lk200Min: Math.min(...lk),
    lk200Max: Math.max(...lk),
    peakMaxDb: peakMax,
    reportedDurMax: repMax,
    suggestedTrimDb: Math.round((meta.trimDb + (target - lkMed)) * 10) / 10,
    failures: [...new Set(f)],
  };
}
