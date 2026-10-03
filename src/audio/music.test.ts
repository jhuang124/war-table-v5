// v4 (PLAN §4 B2/B3): the pure halves of the breathing score and the key-lock.
import { describe, expect, it } from 'vitest';
import { TONIC_PCS, keyPitch, roleClasses } from './key';
import { CHORDS, COLD, Composer, MIN_CHANGE, planScore, type PadItem } from './music';

const pads = (c: Composer, until: number): PadItem[] => {
  const out: PadItem[] = [];
  while (c.peekTime() < until) {
    const it = c.next();
    if (it.kind === 'pad') out.push(it);
  }
  return out;
};

describe('Composer (B3)', () => {
  it('is deterministic per seed', () => {
    expect(planScore(7, 300)).toEqual(planScore(7, 300));
  });

  it('turn passed: the next chord change happens now, the walk keeps going from there', () => {
    const c = new Composer(3);
    const first = pads(c, 0.01);
    expect(first.length).toBe(1);
    const naturalNext = c.peekIsPad() ? c.peekTime() : Infinity;
    expect(c.retime(6)).toBe(true);
    const p = pads(c, 6.01).at(-1)!;
    expect(p.t).toBeCloseTo(6, 6);
    expect(p.moved).toBe(true);
    expect(p.t).toBeLessThan(naturalNext);
    // the next change is a normal walk step after it (18–30 s)
    const after = pads(c, 60)[0];
    expect(after.t - p.t).toBeGreaterThanOrEqual(18);
    expect(after.t - p.t).toBeLessThanOrEqual(30);
  });

  it('never changes twice within MIN_CHANGE', () => {
    const c = new Composer(4);
    pads(c, 0.01);
    expect(c.retime(1)).toBe(true); // clamps to MIN_CHANGE after the first change
    const p = pads(c, 10).at(-1)!;
    expect(p.t).toBeCloseTo(MIN_CHANGE, 6);
    expect(c.retime(p.t + 1)).toBe(true);
    expect(pads(c, 60)[0].t).toBeCloseTo(p.t + MIN_CHANGE, 6);
  });

  it('lean: the next chord is a cold one, once', () => {
    for (let seed = 1; seed < 40; seed++) {
      const c = new Composer(seed);
      pads(c, 0.01);
      c.lean();
      const [cold, next] = pads(c, 200);
      expect(COLD[cold.chord]).toBe(1);
      expect(cold.cold).toBe(true);
      expect(next.cold).toBeUndefined();
    }
  });
});

describe('key-lock (B2)', () => {
  it('every role lands on a tone of the chord, near the designed pitch', () => {
    for (const ch of [...CHORDS.map((c) => c.pcs), TONIC_PCS]) {
      for (const role of ['root', 'bright', 'somber'] as const) {
        for (const ref of [50, 62, 64, 69, 74]) {
          const m = keyPitch(ch, role, ref);
          expect(ch).toContain(((m % 12) + 12) % 12);
          expect(roleClasses(ch, role)).toContain(m % 12);
          expect(Math.abs(m - ref)).toBeLessThanOrEqual(6);
          if (role === 'bright') expect(Math.abs(m - ref)).toBeLessThanOrEqual(4);
        }
      }
    }
  });

  it('somber takes the minor third when the chord has one, else the open root/fifth', () => {
    expect(keyPitch([2, 5, 9, 4], 'somber', 50)).toBe(53); // Dm9 → F3
    expect(keyPitch([0, 2, 7], 'somber', 50) % 12).toBe(0); // Csus2 → C (no third)
    expect(keyPitch(TONIC_PCS, 'bright', 69)).toBe(69); // no score: A4, the fifth of D
  });
});
