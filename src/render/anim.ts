// Animation scheduler for the board: tweens with easing, a speed multiplier, a clamped clock,
// and skip-to-end. Every promise it hands out ALWAYS resolves (on completion, skip, or dispose).

export type Easing = (t: number) => number;

export const ease = {
  linear: (t: number) => t,
  inQuad: (t: number) => t * t,
  outQuad: (t: number) => 1 - (1 - t) * (1 - t),
  inOutQuad: (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  outCubic: (t: number) => 1 - Math.pow(1 - t, 3),
  inCubic: (t: number) => t * t * t,
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  inOutSine: (t: number) => -(Math.cos(Math.PI * t) - 1) / 2,
  outQuart: (t: number) => 1 - Math.pow(1 - t, 4),
  outBack:
    (s = 1.70158) =>
    (t: number) => {
      const c3 = s + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2);
    },
  inBack:
    (s = 1.70158) =>
    (t: number) =>
      (s + 1) * t * t * t - s * t * t,
};

/** A playback "run" (one playEvent). Once skipped, every later tween/wait in it completes at once. */
export class Run {
  skipped = false;
}

interface Tween {
  dur: number;
  t: number;
  ease: Easing;
  update: (v: number, raw: number) => void;
  done?: () => void;
  resolve: () => void;
  run: Run | null;
  finished: boolean;
}

export interface TweenOpts {
  /** Duration at 1x, ms. Scaled by the animator speed unless `unscaled`. */
  ms: number;
  ease?: Easing;
  update?: (v: number, raw: number) => void;
  done?: () => void;
  run?: Run | null;
  unscaled?: boolean;
  /** Delay before the tween starts (scaled like ms). */
  delay?: number;
}

export class Animator {
  speed = 1;
  private tweens: Tween[] = [];
  private runs = new Set<Run>();
  /** Animator time, ms (advances with the clamped delta). */
  now = 0;

  /** Board duration at the current speed: 2x halves (floor 80 ms), 0 = instant. */
  scale(ms: number): number {
    if (this.speed <= 0) return 0;
    if (this.speed === 1) return ms;
    return Math.max(Math.min(ms, 80), ms / this.speed);
  }

  get instant(): boolean {
    return this.speed <= 0;
  }

  beginRun(): Run {
    const r = new Run();
    if (this.speed <= 0) r.skipped = true;
    this.runs.add(r);
    return r;
  }

  endRun(r: Run): void {
    this.runs.delete(r);
  }

  tween(o: TweenOpts): Promise<void> {
    const run = o.run ?? null;
    const dur = o.unscaled ? o.ms : this.scale(o.ms);
    const delay = o.delay ? (o.unscaled ? o.delay : this.scale(o.delay)) : 0;
    const easeFn = o.ease ?? ease.outCubic;
    const update = o.update ?? (() => {});
    if ((run && run.skipped) || (dur <= 0 && delay <= 0)) {
      try {
        update(1, 1);
        o.done?.();
      } catch (e) {
        console.warn('[render] tween', e);
      }
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const tw: Tween = {
        dur: Math.max(1, dur),
        t: -delay,
        ease: easeFn,
        update,
        done: o.done,
        resolve,
        run,
        finished: false,
      };
      this.tweens.push(tw);
      if (delay <= 0) {
        try {
          update(0, 0);
        } catch (e) {
          console.warn('[render] tween', e);
        }
      }
    });
  }

  /** Wait on the animator clock (scaled; skipped runs return at once). */
  wait(ms: number, run?: Run | null, unscaled = false): Promise<void> {
    return this.tween({ ms, run, unscaled, ease: ease.linear });
  }

  get active(): number {
    return this.tweens.length;
  }

  tick(dtMs: number): void {
    const dt = Math.min(Math.max(dtMs, 0), 50);
    this.now += dt;
    if (!this.tweens.length) return;
    const list = this.tweens;
    this.tweens = [];
    const keep: Tween[] = [];
    for (const tw of list) {
      if (tw.finished) continue;
      const wasNeg = tw.t < 0;
      tw.t += dt;
      if (tw.t < 0) {
        keep.push(tw);
        continue;
      }
      const raw = Math.min(1, tw.t / tw.dur);
      try {
        if (wasNeg && raw < 1) tw.update(tw.ease(0), 0);
        tw.update(tw.ease(raw), raw);
      } catch (e) {
        console.warn('[render] tween', e);
      }
      if (raw >= 1) this.finish(tw, false);
      else keep.push(tw);
    }
    // Tweens created during updates were pushed to this.tweens.
    this.tweens = keep.concat(this.tweens);
  }

  private finish(tw: Tween, snap: boolean): void {
    if (tw.finished) return;
    tw.finished = true;
    try {
      if (snap) tw.update(tw.ease(1), 1);
      tw.done?.();
    } catch (e) {
      console.warn('[render] tween', e);
    }
    tw.resolve();
  }

  /** Complete every running tween and flag every open run as skipped. */
  skipAll(): void {
    for (const r of this.runs) r.skipped = true;
    // Completing a tween can spawn new ones (sequences); loop until quiet.
    for (let guard = 0; guard < 20 && this.tweens.length; guard++) {
      const list = this.tweens;
      this.tweens = [];
      for (const tw of list) this.finish(tw, true);
    }
  }

  /** Skip only the tweens belonging to one run. */
  skipRun(r: Run): void {
    r.skipped = true;
    const mine = this.tweens.filter((t) => t.run === r);
    this.tweens = this.tweens.filter((t) => t.run !== r);
    for (const tw of mine) this.finish(tw, true);
  }

  dispose(): void {
    this.skipAll();
    this.runs.clear();
  }
}

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// --- v4 one motion ladder (_claude/v4/PLAN.md §5b E5) ------------------------------------------------------
/** The tier bands at 1×, ms: 0 tick · 1 stroke · 2 soak · 3 breath. */
export const TIER_BANDS: Readonly<Record<0 | 1 | 2 | 3, readonly [number, number]>> = {
  0: [160, 290],
  1: [400, 650],
  2: [650, 1200],
  3: [1600, 2400],
};
/** A motion's duration kept inside its tier's band (absent tier: the event's own v3 number, unchanged). */
export function tierMs(ms: number, tier?: 0 | 1 | 2 | 3): number {
  if (tier === undefined) return ms;
  const [a, b] = TIER_BANDS[tier];
  return clamp(ms, a, b);
}
/**
 * The readable beat (v4 §8a Q7, PlayEventOptions.style 'readable'): one AI engagement, ≈ 900 ms at 1×.
 * The stroke draws (STROKE), the casualties tick on the loser's stone (TICKS, shared by every roll of the
 * engagement, so a long blitz folds into the same beat), then the verdict: the flood with the march
 * (CONQUER_WAIT + MARCH) or, if the attack stops, the attacker's recoil (RECOIL).
 */
export const READABLE = { STROKE: 300, TICKS: 160, CONQUER_WAIT: 100, MARCH: 340, FLOOD: 650, RECOIL: 300 } as const;
