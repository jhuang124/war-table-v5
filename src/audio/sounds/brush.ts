// Brush: bristles dragged across paper. The arrow and camera sweep (whoosh), the traveller's route
// (march), the ink flood of a conquest (conquer), the ink dab of a placement, and the breath of smoke
// when a figure falls (hit). A brush sweep is filtered noise shaped by bristle grain: it presses in,
// carries, and lifts off dry (the tail thins and roughens, like a stroke running out of ink).
//
// conquer · somber is the A5 sting: a human lost this territory. A dry brush SNAPS on contact, then a
// rougher, darker flood eats the colour.

import { Tape, between, biquad, clamp, jitter, svf } from '../dsp';
import type { Rand, SoundFn } from '../types';
import { paperNoise } from './paper';

export interface StrokeOpts {
  dur: number;
  amp: number;
  /** Band centre at the start, at the press peak, and at the lift (Hz). */
  lo: number;
  hi: number;
  end: number;
  /** Fraction of the stroke spent pressing in (0..1). */
  press?: number;
  /** 0..1: how dry (grainy, broken) the tail gets. */
  dry?: number;
  /** 0..1: low body under the bristles (paper and table). */
  body?: number;
  q?: number;
}

/** One brush stroke into `tape` at `t0`. */
export function brushStroke(tape: Tape, t0: number, rand: Rand, o: StrokeOpts): void {
  const sr = tape.sr;
  const n = Math.max(16, Math.round(o.dur * sr));
  const press = clamp(o.press ?? 0.25, 0.05, 0.8);
  const dry = o.dry ?? 0.5;
  const raw = paperNoise(n, rand, sr, 90, 1.2);
  // bristle grain: a slower, deeper roughness that grows toward the dry tail
  let g = 0;
  const ga = 1 - Math.exp((-2 * Math.PI * 38) / sr);
  const env = (u: number) =>
    u < press ? Math.pow(Math.sin((Math.PI * u) / (2 * press)), 1.5) : Math.pow(Math.cos((Math.PI * (u - press)) / (2 * (1 - press))), 1.3);
  for (let i = 0; i < n; i++) {
    const u = i / n;
    g += ga * (rand() * 2 - 1 - g);
    const grain = 1 + dry * u * (Math.abs(g) * 6 - 0.6);
    raw[i] *= env(u) * Math.max(0.05, grain);
  }
  const body = new Float32Array(raw);
  const x = raw;
  svf(
    x,
    sr,
    'bp',
    (i) => {
      const u = clamp(i / n, 0, 1);
      return u < press ? o.lo + (o.hi - o.lo) * (u / press) : o.hi + (o.end - o.hi) * ((u - press) / (1 - press));
    },
    o.q ?? 0.85,
  );
  biquad(x, sr, 'lowpass', 3800, 0.7);
  const b = o.body ?? 0.5;
  if (b > 0) {
    biquad(body, sr, 'lowpass', 480, 0.7);
    biquad(body, sr, 'highpass', 150, 0.7);
  }
  const start = Math.max(0, Math.round(t0 * sr));
  for (let i = 0; i < n && start + i < tape.data.length; i++) tape.data[start + i] += (x[i] + body[i] * b * 0.9) * o.amp;
}

/** The brush tip meets the paper: a soft, short, low press (the figure's dab of ink). */
export function dab(tape: Tape, t0: number, amp: number, rand: Rand, o: { f?: number; wet?: number } = {}): void {
  const f = (o.f ?? 820) * jitter(rand, 0.07);
  tape.burst(t0, { amp: amp * 0.55, attack: 0.02, tau: 0.014, filter: [{ type: 'bandpass', f, q: 0.8 }] }, rand);
  tape.burst(t0, { amp: amp * 0.3, attack: 0.02, tau: 0.02 + 0.03 * (o.wet ?? 0), filter: [{ type: 'lowpass', f: 600 }] }, rand);
  tape.mode(t0 + 0.0005, 290 * jitter(rand, 0.05), 0.014, amp * 0.34, 0.02);
  tape.mode(t0 + 0.0005, 610 * jitter(rand, 0.05), 0.008, amp * 0.12, 0.02);
}

/** The dry brush snapping: bristles flick apart and the paper tears a little under them. */
export function snap(tape: Tape, t0: number, amp: number, rand: Rand): void {
  // the crack
  tape.burst(t0, { amp: amp * 0.75, attack: 0.0002, tau: 0.0016, filter: [{ type: 'bandpass', f: 2300 * jitter(rand, 0.06), q: 0.8 }] }, rand);
  tape.burst(t0, { amp: amp * 0.45, attack: 0.0003, tau: 0.0035, filter: [{ type: 'bandpass', f: 1100 * jitter(rand, 0.06), q: 0.9 }] }, rand);
  // bristles flicking free: a few tiny, stiff clicks
  for (let k = 0; k < 4; k++) {
    const at = t0 + 0.0015 + k * between(rand, 0.004, 0.009);
    tape.mode(at, between(rand, 1700, 3000), 0.0012, amp * between(rand, 0.12, 0.28), 0.0002);
  }
  // the body of the stroke hitting the paper hard
  tape.mode(t0 + 0.0004, 240 * jitter(rand, 0.05), 0.016, amp * 0.5, 0.0008);
  tape.mode(t0 + 0.0004, 520 * jitter(rand, 0.05), 0.008, amp * 0.25, 0.0008);
  // torn paper: a short rough rip right after
  const sr = tape.sr;
  const m = Math.round(0.07 * sr);
  const y = paperNoise(m, rand, sr, 320, 4);
  for (let i = 0; i < m; i++) {
    const u = i / m;
    y[i] *= Math.pow(1 - u, 2) * (rand() < 0.28 ? 1 : 0.35);
  }
  biquad(y, sr, 'bandpass', 1500, 0.8);
  biquad(y, sr, 'lowpass', 3600, 0.7);
  const s0 = Math.round((t0 + 0.006) * sr);
  for (let i = 0; i < m && s0 + i < tape.data.length; i++) tape.data[s0 + i] += y[i] * amp * 0.5;
}

// ---------------------------------------------------------------------------

/** Placement: the brush dabs ink onto the territory. Soft and quick; rapid placements stay calm. */
export const place: SoundFn = (ctx, dest, t, { rate, rand }) => {
  const tape = new Tape(ctx.sampleRate, 0.2);
  dab(tape, 0.002, 1, rand, { wet: 0.4 });
  // the ink soaking in: a breath of paper under the dab
  tape.burst(0.012, { amp: 0.05, attack: 0.01, tau: 0.03, filter: [{ type: 'bandpass', f: 1400, q: 0.7 }] }, rand);
  tape.dcBlock().endFade(0.02);
  return tape.play(ctx, dest, t, rate);
};

/** Taking a placement back: the brush lifts off with a small upward flick. */
export const unplace: SoundFn = (ctx, dest, t, { rate, rand }) => {
  const tape = new Tape(ctx.sampleRate, 0.16);
  dab(tape, 0.002, 0.55, rand, { f: 1000 });
  brushStroke(tape, 0.01, rand, { dur: 0.07, amp: 0.55, lo: 900, hi: 2000, end: 2200, press: 0.3, dry: 0.7, body: 0.2 });
  tape.dcBlock().endFade(0.02);
  return tape.play(ctx, dest, t, rate);
};

/**
 * Camera moves, and the attack arrow drawing itself: one brush sweep that lasts `duration`
 * (default 0.6 s), drifting across the stereo field.
 */
export const whoosh: SoundFn = (ctx, dest, t, { rate, rand, duration }) => {
  const sr = ctx.sampleRate;
  const dur = (duration ?? 0.6) * jitter(rand, 0.04);
  const tape = new Tape(sr, dur + 0.03);
  brushStroke(tape, 0.001, rand, {
    dur,
    amp: 1,
    lo: 380 * jitter(rand, 0.08),
    hi: 1250 * jitter(rand, 0.08),
    end: 700,
    press: 0.38,
    dry: 0.55,
    body: 0.5,
  });
  tape.dcBlock().endFade(0.02);
  const src = ctx.createBufferSource();
  src.buffer = tape.toBuffer(ctx);
  src.playbackRate.value = rate;
  let head: AudioNode = src;
  if (typeof ctx.createStereoPanner === 'function') {
    const p = ctx.createStereoPanner();
    const dirn = rand() < 0.5 ? -1 : 1;
    const len = tape.seconds / rate;
    p.pan.setValueAtTime(-0.3 * dirn, t);
    p.pan.linearRampToValueAtTime(0.3 * dirn, t + len);
    src.connect(p);
    head = p;
  }
  head.connect(dest);
  src.start(t);
  return tape.seconds / rate;
};

/**
 * The traveller walks the route (conquest march, occupy, fortify): a light, even stroke that lasts
 * `duration` (default 0.5 s), faint dabs at each hop, and a soft dab as it arrives.
 */
export const march: SoundFn = (ctx, dest, t, { rate, rand, duration }) => {
  const D = duration ?? 0.5;
  const tape = new Tape(ctx.sampleRate, D + 0.12);
  dab(tape, 0.002, 0.35, rand, { f: 1000 });
  brushStroke(tape, 0.004, rand, { dur: D, amp: 0.5, lo: 600, hi: 1150, end: 900, press: 0.22, dry: 0.45, body: 0.3 });
  const hops = Math.max(1, Math.min(5, Math.round(D / 0.16)));
  for (let i = 0; i < hops; i++) {
    const at = 0.004 + (D * (i + 1)) / (hops + 1) + between(rand, -0.008, 0.008);
    dab(tape, at, 0.22 * jitter(rand, 0.25), rand, { f: 900 });
  }
  dab(tape, 0.003 + D, 0.75, rand, { wet: 0.5 });
  tape.dcBlock().endFade(0.02);
  return tape.play(ctx, dest, t, rate);
};

/** A figure falls: a breath of ink smoke. A soft falling exhale, never a thud. */
export const hit: SoundFn = (ctx, dest, t, { rate, rand }) => {
  const sr = ctx.sampleRate;
  const D = 0.36 * jitter(rand, 0.06);
  const tape = new Tape(sr, D + 0.06);
  const n = Math.round(D * sr);
  const x = new Float32Array(n);
  let lp = 0;
  const la = 1 - Math.exp((-2 * Math.PI * 2200) / sr);
  for (let i = 0; i < n; i++) {
    lp += la * (rand() * 2 - 1 - lp);
    const u = i / n;
    const e = u < 0.12 ? Math.sin((Math.PI * u) / 0.24) : Math.pow(1 - (u - 0.12) / 0.88, 1.8);
    x[i] = lp * e * 2.2;
  }
  const body = new Float32Array(x);
  const f0 = 1300 * jitter(rand, 0.07);
  svf(x, sr, 'bp', (i) => f0 - (f0 - 520) * clamp(i / n, 0, 1), 0.75);
  biquad(body, sr, 'bandpass', 330, 0.8);
  for (let i = 0; i < n; i++) tape.data[i + 1] = x[i] + body[i] * 0.8;
  tape.dcBlock().endFade(0.03);
  return tape.play(ctx, dest, t, rate);
};

/**
 * Territory taken: the ink flood. A broad, wet brush soaks across the border (~0.6 s, the flood's
 * length) and settles. `somber` = a human lost it: a dry brush snap on contact, then a rougher,
 * darker flood that sounds like it is eating the colour.
 */
export const conquer: SoundFn = (ctx, dest, t, { rate, rand, variant }) => {
  const sr = ctx.sampleRate;
  const tape = new Tape(sr, 0.78);
  if (variant === 'somber') {
    snap(tape, 0.002, 1.1, rand);
    brushStroke(tape, 0.012, rand, { dur: 0.6, amp: 0.95, lo: 520, hi: 820, end: 380, press: 0.18, dry: 1, body: 0.9, q: 0.7 });
    dab(tape, 0.6, 0.35, rand, { f: 600, wet: 1 });
  } else {
    dab(tape, 0.002, 0.8, rand, { wet: 1 });
    brushStroke(tape, 0.006, rand, { dur: 0.6, amp: 1, lo: 420, hi: 1000, end: 520, press: 0.3, dry: 0.3, body: 0.9, q: 0.75 });
    dab(tape, 0.6, 0.3, rand, { f: 700, wet: 1 });
  }
  tape.dcBlock().endFade(0.04);
  return tape.play(ctx, dest, t, rate);
};

// ---------------------------------------------------------------------------
// The live stroke (A2: draw your attack) — a looping bristle texture the pointer drives.
// ---------------------------------------------------------------------------

/** A 2 s seamless loop of bristle-on-paper noise for the live stroke. Built once per context. */
export function strokeLoop(ctx: BaseAudioContext, rand: Rand): AudioBuffer {
  const sr = ctx.sampleRate;
  const fade = Math.round(0.08 * sr);
  const n = Math.round(2 * sr);
  const raw = paperNoise(n + fade, rand, sr, 70, 1.6);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = raw[i];
  for (let i = 0; i < fade; i++) {
    const a = i / fade;
    out[i] = raw[i] * a + raw[n + i] * (1 - a);
  }
  let e = 0;
  for (let i = 0; i < n; i++) e += out[i] * out[i];
  const s = 0.3 / Math.sqrt(e / n || 1);
  for (let i = 0; i < n; i++) out[i] *= s;
  const buf = ctx.createBuffer(1, n, sr);
  buf.copyToChannel(out, 0);
  return buf;
}
