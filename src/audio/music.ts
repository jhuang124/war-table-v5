// The ambient score (INK A4): on by default, warm, slow and sparse. A gentle bowed drone on D, low
// bowed pads that drift through a small harmonic field (never a fixed progression), and a few events
// a minute: a soft felt-piano note or dyad, or a distant bowl. Long tails, no melody you could hum,
// no loop: the harmony is a seeded random walk with voice-leading, the events land on random gaps at
// random chord tones, and nothing repeats on a cycle.
//
// Two halves:
//  - `Composer` (pure, seeded): yields the score as timed items. Offline checks read it directly.
//  - `startMusic` (the performer): turns items into cheap node graphs (oscillators + envelopes, no
//    JS synthesis on the main thread), scheduled a few seconds ahead. Live and offline share it.
//
// v4 (PLAN §4 B3, "the score breathes with the table"; tempo and density never change, Pillar 5):
//  - advance(at): the turn passed: the next chord change happens now (the walk keeps its weights;
//    only the moment moves). Pads are scheduled only ~1.5 s ahead so the moment can still move.
//  - lean(at): one cold chord (minor or open, voiced open) within ~2.5 s, then the walk returns.
//  - setIdle(on, at): the felt-piano notes and distant bowls thin out (~4 s) leaving drone + pads;
//    back over ~2 s.
//  - chordAt(t): the chord sounding at context time t, so effects can be notes in it (B2).
//  - a faint room tone (paper and air) under everything, so silence never has a hard floor and the
//    score's fade-in is not "sound appears".
//
// v5 (PROPOSAL §4 A, B; tempo and density still never change, Pillar 5):
//  - setEvening(e, at): the game's clock, 0 dusk .. 1 night. Pads voice lower and darker, the felt notes
//    sit lower and softer-topped, the distant bowls favour the lower one, the score's top darkens, the
//    room tone deepens a touch. Only *which* notes and *what colour*: every item's time, every pad's
//    length and the random stream's consumption are identical at any evening (checked).
//  - setCold(on, at): the fight. The room tone thins (quieter, less body) quickly; back over ~1 s.
//    (The 2 dB high shelf on the whole score lives in the mixer.)

import { between, cached, cents, midiHz, mulberry32, noiseBuffer, roomImpulse } from './dsp';
import { scoreBowl } from './sounds/bowl';
import type { Rand } from './types';

/** Overall score level (linear). Calibrated so the score sits ~9 dB (≈ 35%) under board-level SFX. */
export const MUSIC_LEVEL = 1.18;
const FADE_IN = 6;

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

/** Harmonic field in D (aeolian with a warm major-seventh colour). Pitch classes, root first. */
export const CHORDS: { name: string; pcs: number[] }[] = [
  { name: 'Dm9', pcs: [2, 5, 9, 4] },
  { name: 'Fmaj7', pcs: [5, 9, 0, 4] },
  { name: 'Bbmaj7', pcs: [10, 2, 5, 9] },
  { name: 'Csus2', pcs: [0, 2, 7] },
  { name: 'Gm9', pcs: [7, 10, 2, 9] },
  { name: 'Am7', pcs: [9, 0, 4, 7] },
  { name: 'Dsus4', pcs: [2, 7, 9] },
];
/** Chords a cold lean may take (minor, or open with no third): Dm9, Csus2, Gm9, Am7, Dsus4. */
export const COLD = [1, 0, 0, 1, 1, 1, 1];
/** A chord change never lands closer than this to the previous one (s): the room changes once. */
export const MIN_CHANGE = 4;
/** Where each chord may drift next (weights), so the walk has direction but no cycle. */
const NEXT: number[][] = [
  // Dm9 Fmaj7 Bb  Csus Gm9  Am7  Dsus4
  [0, 3, 3, 2, 2, 1, 2], // Dm9
  [3, 0, 3, 2, 1, 2, 0], // Fmaj7
  [3, 3, 0, 2, 1, 0, 1], // Bbmaj7
  [3, 2, 2, 0, 1, 2, 1], // Csus2
  [3, 1, 3, 1, 0, 0, 2], // Gm9
  [2, 3, 1, 2, 1, 0, 1], // Am7
  [4, 1, 2, 1, 1, 1, 0], // Dsus4
];

export interface PadItem {
  kind: 'pad';
  t: number;
  /** attack + hold (the release runs after). */
  dur: number;
  attack: number;
  release: number;
  chord: number;
  midis: number[];
  cutoff: number;
  /** v4: this change was moved (turn passed / lean) rather than timed by the walk. */
  moved?: boolean;
  /** v4: a cold chord (lean): voiced open, a touch darker. */
  cold?: boolean;
  /** v5: the evening when it was written (0 dusk .. 1 night). */
  ev?: number;
}
export interface NoteItem {
  kind: 'piano' | 'bowl';
  t: number;
  midis: number[];
  vel: number;
  /** Seconds between the notes of a dyad (a rolled hand). */
  spread: number;
  /** v5: the evening when it was written (0 dusk .. 1 night). */
  ev?: number;
}
export type ScoreItem = PadItem | NoteItem;

const PAD_LO = 45; // A2
const PAD_HI = 65; // F4
/** v5 evening: voicing cost per semitone of average pad height at night (pulls the pads ~3 st lower). */
const EVENING_VOICE_COST = 1.2;

function pick<T>(r: Rand, xs: T[], w: number[]): T {
  let s = 0;
  for (const x of w) s += x;
  let u = r() * s;
  for (let i = 0; i < xs.length; i++) {
    u -= w[i];
    if (u <= 0) return xs[i];
  }
  return xs[xs.length - 1];
}

/**
 * Three-note voicing of `pcs` in the pad register, closest to `prev` (voice-leading), spacing 3–12.
 * `open` (v4 lean): an open fifth or wider at the bottom. `low` (v5 evening, 0..1): lean the whole
 * voicing lower (a cost per semitone of average height), so the night sits deeper in the register.
 */
export function voice(pcs: number[], prev: number[] | null, r: Rand, open = false, low = 0): number[] {
  const notes: number[] = [];
  for (let m = PAD_LO; m <= PAD_HI; m++) if (pcs.includes(((m % 12) + 12) % 12)) notes.push(m);
  let best: number[] = [notes[0], notes[1], notes[2]];
  let bestCost = Infinity;
  for (let a = 0; a < notes.length; a++)
    for (let b = a + 1; b < notes.length; b++)
      for (let c = b + 1; c < notes.length; c++) {
        const v = [notes[a], notes[b], notes[c]];
        const g1 = v[1] - v[0];
        const g2 = v[2] - v[1];
        if (g1 < 3 || g2 < 3 || g1 > 12 || g2 > 12) continue;
        // prefer the root (or fifth) in the bass, open low voicings, and small motion
        const bassPc = ((v[0] % 12) + 12) % 12;
        let cost = bassPc === pcs[0] ? 0 : bassPc === (pcs[0] + 7) % 12 ? 2 : 5;
        cost += g1 < 5 ? 2 : 0;
        if (open) cost += g1 >= 7 ? 0 : 8;
        if (prev) cost += Math.abs(v[0] - prev[0]) + Math.abs(v[1] - prev[1]) + Math.abs(v[2] - prev[2]);
        else cost += Math.abs(v[0] - 50) * 0.5;
        if (low > 0) cost += low * EVENING_VOICE_COST * ((v[0] + v[1] + v[2]) / 3 - 52);
        cost += r() * 2.5;
        if (cost < bestCost) {
          bestCost = cost;
          best = v;
        }
      }
  return best;
}

/**
 * The score as an endless, seeded stream of items in start-time order.
 * Pads every 18–30 s (overlapping crossfades); notes on gaps of 7–26 s (≈ 4 a minute).
 */
export class Composer {
  private readonly r: Rand;
  private pads: PadItem[] = [];
  private padNext = 0;
  private chord = 0;
  private voicing: number[] | null = null;
  private noteNext: number;
  private lastNote = -100;
  private lastKind: NoteItem['kind'] = 'bowl';
  private coldNext = false;
  private movedNext = false;
  private lastPadT = -Infinity;
  /** v5: the evening, 0 (dusk) .. 1 (night). */
  private ev = 0;

  constructor(seed: number) {
    this.r = mulberry32((seed ^ 0x5eed) >>> 0);
    // start somewhere in the field (seeded), usually home
    this.chord = this.r() < 0.6 ? 0 : Math.floor(this.r() * CHORDS.length);
    this.noteNext = between(this.r, 8, 14);
  }

  /** v5: the game's clock. Changes which voicing / note / colour, never when (the stream is identical). */
  setEvening(e: number): void {
    this.ev = Math.max(0, Math.min(1, Number.isFinite(e) ? e : 0));
  }

  get evening(): number {
    return this.ev;
  }

  private makePad(): PadItem {
    const r = this.r;
    const cold = this.coldNext;
    if (this.pads.length) {
      let w = NEXT[this.chord];
      if (cold) {
        const cw = w.map((x, i) => x * COLD[i]);
        if (cw.some((x) => x > 0)) w = cw;
      }
      this.chord = pick(r, CHORDS.map((_, i) => i), w);
    }
    const pcs = CHORDS[this.chord].pcs;
    this.voicing = voice(pcs, this.voicing, r, cold, this.ev);
    const gap = between(r, 18, 30);
    const attack = between(r, 6, 9.5);
    const item: PadItem = {
      kind: 'pad',
      t: this.padNext,
      attack,
      dur: gap + between(r, 1, 3),
      release: between(r, 8, 11),
      chord: this.chord,
      midis: this.voicing,
      cutoff: between(r, 580, 900) * (cold ? 0.8 : 1) * (1 - 0.22 * this.ev),
      ev: this.ev,
    };
    if (this.movedNext) item.moved = true;
    if (cold) item.cold = true;
    this.coldNext = false;
    this.movedNext = false;
    this.lastPadT = item.t;
    this.padNext += gap;
    this.pads.push(item);
    if (this.pads.length > 8) this.pads.shift();
    return item;
  }

  /** The chord sounding at time t (the latest pad that has started). */
  chordAt(t: number): number {
    let c = this.pads.length ? this.pads[0].chord : this.chord;
    for (const p of this.pads) if (p.t <= t) c = p.chord;
    return c;
  }

  private makeNote(): NoteItem {
    const r = this.r;
    const t = this.noteNext;
    // gaps: mostly 8–18 s, sometimes a longer rest; never regular
    const g = -Math.log(1 - r() * 0.95) * 9;
    this.noteNext = t + Math.min(26, 7 + g);
    const pcs = CHORDS[this.chordAt(t)].pcs;
    const kind: NoteItem['kind'] = this.lastKind === 'bowl' ? (r() < 0.8 ? 'piano' : 'bowl') : r() < 0.6 ? 'piano' : 'bowl';
    this.lastKind = kind;
    if (kind === 'bowl') {
      // two small distant bowls tuned to the key: A4 and D5 (v5: the night favours the lower)
      const m = r() < 0.5 + 0.3 * this.ev ? 69 : 74;
      return { kind, t, midis: [m], vel: between(r, 0.5, 0.8), spread: 0, ev: this.ev };
    }
    const cands: number[] = [];
    // v5 evening: the felt notes' range sinks a little at night (57–77 at dusk, 54–72 at night)
    const lo = 57 - Math.round(3 * this.ev);
    const hi = 77 - Math.round(5 * this.ev);
    for (let m = lo; m <= hi; m++) {
      if (!pcs.includes(m % 12)) continue;
      // no stepwise contour: nothing within a whole tone of the last note
      if (Math.abs(m - this.lastNote) <= 2) continue;
      cands.push(m);
    }
    const m = cands[Math.floor(r() * cands.length)] ?? 62;
    this.lastNote = m;
    const midis = [m];
    if (r() < 0.32) {
      const above = [];
      for (let k = 3; k <= 9; k++) if (pcs.includes((m + k) % 12) && m + k <= 81) above.push(m + k);
      // (one draw whether or not there is a note above: the stream never depends on the evening)
      const u = r();
      if (above.length) midis.push(above[Math.floor(u * above.length)]);
    }
    return { kind, t, midis, vel: between(r, 0.35, 0.65), spread: between(r, 0.07, 0.2), ev: this.ev };
  }

  /** v4: when the next item starts, and whether it is a pad (nothing is generated by peeking). */
  peekTime(): number {
    return Math.min(this.padNext, this.noteNext);
  }
  peekIsPad(): boolean {
    return this.padNext <= this.noteNext;
  }
  /** Score time of the most recent chord change. */
  get lastChange(): number {
    return this.lastPadT;
  }
  /**
   * v4: take the next chord change at score time `s` (if it is later than that). Never closer than
   * MIN_CHANGE to the previous change. Returns whether the moment moved.
   */
  retime(s: number): boolean {
    if (!this.pads.length) return false;
    const t = Math.max(s, this.lastPadT + MIN_CHANGE);
    if (t >= this.padNext) return false;
    this.padNext = t;
    this.movedNext = true;
    return true;
  }
  /** v4: the next chord is a cold one (minor or open), once. */
  lean(): void {
    this.coldNext = true;
  }

  /** Next item in time order. */
  next(): ScoreItem {
    if (this.padNext <= this.noteNext) return this.makePad();
    return this.makeNote();
  }
}

/** The plan for [0, seconds): what offline checks measure (density, variety, loop-freeness). */
export function planScore(seed: number, seconds: number, evening = 0): ScoreItem[] {
  const c = new Composer(seed);
  c.setEvening(evening);
  const out: ScoreItem[] = [];
  for (;;) {
    const it = c.next();
    if (it.t >= seconds) break;
    out.push(it);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Performer
// ---------------------------------------------------------------------------

export interface MusicHandle {
  stop(at: number, fade?: number): void;
  readonly seed: number;
  /** v4: CHORDS index sounding at context time t (null before the score is set up). */
  chordAt?(t: number): number | null;
  /** v4: the turn passed: take the next chord change at context time `at`. Returns whether it moved. */
  advance?(at: number): boolean;
  /** v4: one cold chord, soon (≤ ~2.5 s, or MIN_CHANGE after the last change). */
  lean?(at: number): void;
  /** v4: idle thin-out (true: notes fade over ~4 s, drone + pads stay; false: back over ~2 s). */
  setIdle?(on: boolean, at: number): void;
  /** v5: the fight: the room tone thins quickly; off = back over ~1 s. */
  setCold?(on: boolean, at: number): void;
  /** v5: the evening, 0 dusk .. 1 night (voicings, colour and room tone; never time). */
  setEvening?(e: number, at: number): void;
}

/** Pads are scheduled at most this far ahead (s), so a turn passing can still move the change. */
const PAD_AHEAD = 1.5;
/** Room tone level (linear, into the score bus): far under the score. */
export const ROOM_TONE_LEVEL = 0.0042;
/** v5: the room tone while the fight is on (linear gain on the room tone) and its extra high-pass (Hz). */
export const ROOM_COLD_GAIN = 0.55;
const ROOM_COLD_HP = 140;
/** v5: how slowly the evening moves (time constant, s). */
const EVENING_TAU = 3;
/** v5: the score's warm top at dusk and how much darker it gets at night (Hz). */
const TONE_DUSK_HZ = 3200;
const TONE_NIGHT_DROP_HZ = 900;
const roomHpHz = (ev: number, cold: boolean) => 160 - 40 * ev + (cold ? ROOM_COLD_HP : 0);
const roomLpHz = (ev: number) => 1300 - 450 * ev;
const ROOM_TONE_FADE = 2.5;

/**
 * Offline renders schedule the score incrementally (like live) using OfflineAudioContext.suspend, so
 * scripted events (turn passed, lean, idle) can move it. One suspend per quantum, shared by callers.
 */
export function offlineAt(ctx: BaseAudioContext, t: number, cb: () => void): boolean {
  const oc = ctx as OfflineAudioContext;
  if (typeof oc.suspend !== 'function' || typeof oc.startRendering !== 'function') return false;
  const q = 128 / ctx.sampleRate;
  const tq = Math.ceil(t / q) * q;
  if (tq <= ctx.currentTime || tq >= oc.length / ctx.sampleRate) return false;
  const reg = cached(ctx, 'offlineTicks', () => new Map<number, (() => void)[]>());
  const key = Math.round(tq / q);
  const list = reg.get(key);
  if (list) {
    list.push(cb);
    return true;
  }
  const cbs = [cb];
  reg.set(key, cbs);
  oc.suspend(tq)
    .then(() => {
      for (const f of cbs) {
        try {
          f();
        } catch (err) {
          console.warn('[audio] offline tick failed', err);
        }
      }
      return oc.resume();
    })
    .catch(() => {});
  return true;
}

export interface MusicOptions {
  seed: number;
  /** Live: keep scheduling with a timer. Offline: schedule [at, renderUntil] immediately. */
  live: boolean;
  renderUntil?: number;
  /** Fade-in seconds (default 6). */
  fadeIn?: number;
  /**
   * A hall built ahead with `createMusicHall` (live: the mixer builds it once, off the critical path,
   * and every restart reuses it). Absent = build one now.
   */
  hall?: MusicHall;
  /** v5: start at this evening (0 dusk .. 1 night). */
  evening?: number;
  /** v5: start with the fight on (the room tone thinned). */
  cold?: boolean;
}

const LOOKAHEAD = 5;

/** The score's shared hall: a long, dark room and the warm high cut on its return. */
export interface MusicHall {
  input: AudioNode;
}

/** Hall impulse (cached per context). Split from `createMusicHall` so live callers can spread the cost. */
export function musicHallImpulse(ctx: BaseAudioContext): AudioBuffer {
  return roomImpulse(ctx, HALL_RT60, 4.2);
}

/** The hall's decay (s). B1: the effects use the same impulse, so the same RT60. */
export const HALL_RT60 = 3.6;
/** B1: the effects' tap of the hall is shorter (the same seeded impulse, cut at −40 dB and tapered). */
export const SFX_HALL_SECONDS = 2.4;

export function createMusicHall(ctx: BaseAudioContext, dest: AudioNode): MusicHall {
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 3200;
  tone.Q.value = 0.5;
  tone.connect(dest);
  const hall = ctx.createConvolver();
  hall.normalize = false;
  hall.buffer = musicHallImpulse(ctx);
  hall.connect(tone);
  return { input: hall };
}

export function startMusic(ctx: BaseAudioContext, dest: AudioNode, at: number, o: MusicOptions): MusicHandle {
  const hall = o.hall ?? createMusicHall(ctx, dest);
  // One fade envelope on the dry path and one on the send into the hall, so a stop fades the
  // piece while the hall lets its last tail ring out naturally.
  const fades: GainNode[] = [];
  const fade = () => {
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(MUSIC_LEVEL, at + (o.fadeIn ?? FADE_IN));
    fades.push(g);
    return g;
  };
  const out = fade();
  out.connect(dest);
  const wet = fade();
  wet.connect(hall.input);

  // v4: the room tone (paper and air), very low, filtered, under everything. It fades in faster than
  // the score so the score arrives into a room rather than out of digital silence.
  const room = ctx.createGain();
  room.gain.value = 0;
  room.gain.setValueAtTime(0, at);
  room.gain.linearRampToValueAtTime(ROOM_TONE_LEVEL, at + Math.min(ROOM_TONE_FADE, o.fadeIn ?? FADE_IN));
  fades.push(room);
  room.connect(dest);

  let ev = Math.max(0, Math.min(1, Number.isFinite(o.evening) ? (o.evening as number) : 0));
  let cold = !!o.cold;
  // gentle high cut on the whole score: warm, never airy (the hall return has its own); v5: darker at night
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = TONE_DUSK_HZ - TONE_NIGHT_DROP_HZ * ev;
  tone.Q.value = 0.5;
  tone.connect(out);
  const bus = ctx.createGain();
  const hallSend = ctx.createGain();
  hallSend.gain.value = 0.5;
  bus.connect(tone);
  bus.connect(hallSend).connect(wet);
  // distant things: mostly hall
  const far = ctx.createGain();
  far.gain.value = 0.35;
  far.connect(tone);
  const farSend = ctx.createGain();
  farSend.gain.value = 1.1;
  far.connect(farSend).connect(wet);

  const sources = new Set<AudioScheduledSourceNode>();
  const track = (s: AudioScheduledSourceNode) => {
    sources.add(s);
    s.onended = () => sources.delete(s);
    return s;
  };

  // room tone graph: pink noise, band-limited to the paper/air band, breathing very slowly
  const roomSrcs: AudioScheduledSourceNode[] = [];
  // v5: the room tone's shape (evening: deeper; the fight: thinner) and its fight gain
  const roomHp = ctx.createBiquadFilter();
  const roomLp = ctx.createBiquadFilter();
  const roomCold = ctx.createGain();
  roomCold.gain.value = cold ? ROOM_COLD_GAIN : 1;
  const roomEve = ctx.createGain();
  roomEve.gain.value = 1 + 0.12 * ev;
  {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, 'pink');
    src.loop = true;
    const hp = roomHp;
    hp.type = 'highpass';
    hp.frequency.value = roomHpHz(ev, cold);
    hp.Q.value = 0.5;
    const lp = roomLp;
    lp.type = 'lowpass';
    lp.frequency.value = roomLpHz(ev);
    lp.Q.value = 0.5;
    const breath = ctx.createGain();
    breath.gain.value = 1;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.031;
    const lfoD = ctx.createGain();
    lfoD.gain.value = 0.22;
    lfo.connect(lfoD).connect(breath.gain);
    src.connect(hp).connect(lp).connect(breath).connect(roomCold).connect(roomEve).connect(room);
    src.start(at, (o.seed % 2000) / 1000);
    lfo.start(at);
    roomSrcs.push(src, lfo);
  }
  const hasPan = typeof ctx.createStereoPanner === 'function';
  const panned = (node: AudioNode, pan: number, to: AudioNode) => {
    if (hasPan) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      node.connect(p).connect(to);
    } else node.connect(to);
  };

  // --- drone: a bowed D, breathing on two slow, unrelated cycles ----------------
  const droneLp = ctx.createBiquadFilter();
  droneLp.type = 'lowpass';
  droneLp.frequency.value = 340;
  droneLp.Q.value = 0.6;
  const droneGain = ctx.createGain();
  droneGain.gain.value = 0.032;
  droneLp.connect(droneGain).connect(bus);
  const lfoA = track(ctx.createOscillator()) as OscillatorNode;
  lfoA.frequency.value = 0.043;
  const lfoAd = ctx.createGain();
  lfoAd.gain.value = 110;
  lfoA.connect(lfoAd).connect(droneLp.frequency);
  const lfoB = track(ctx.createOscillator()) as OscillatorNode;
  lfoB.frequency.value = 0.0171;
  const lfoBd = ctx.createGain();
  lfoBd.gain.value = 0.011;
  lfoB.connect(lfoBd).connect(droneGain.gain);
  for (const [m, type, g, dc] of [
    [38, 'sawtooth', 0.55, -4],
    [38, 'sawtooth', 0.55, 5],
    [45, 'triangle', 0.6, 0],
    [50, 'triangle', 0.35, 2],
  ] as [number, OscillatorType, number, number][]) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = midiHz(m);
    osc.detune.value = dc;
    const og = ctx.createGain();
    og.gain.value = g;
    osc.connect(og).connect(droneLp);
    track(osc);
  }
  for (const s of sources) s.start(at);
  for (const s of roomSrcs) track(s);

  // --- idle (v4): notes go through one gain that thins to nothing; drone + pads stay ---------
  const notesNear = ctx.createGain();
  notesNear.connect(bus);
  const notesFar = ctx.createGain();
  notesFar.connect(far);
  let idle = false;

  // pads still sounding, so a moved change can release the old chord early
  const livePads: { gains: GainNode[]; releaseAt: number; tau: number }[] = [];

  // --- items -------------------------------------------------------------------
  const pad = (s: number, p: PadItem, r: Rand) => {
    if (p.moved) {
      // the change was moved forward: let the old chord go about as it would have, a couple of
      // seconds into the new one's bow, instead of holding over it
      const rel = s + 2;
      for (const lp of livePads) {
        if (lp.releaseAt <= rel) continue;
        for (const g of lp.gains) {
          g.gain.cancelScheduledValues(rel);
          g.gain.setTargetAtTime(0, rel, lp.tau);
        }
        lp.releaseAt = rel;
      }
    }
    for (let i = livePads.length - 1; i >= 0; i--) if (livePads[i].releaseAt + livePads[i].tau * 7 < s) livePads.splice(i, 1);
    const mine: GainNode[] = [];
    livePads.push({ gains: mine, releaseAt: s + p.dur, tau: p.release / 5 });
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.5;
    const total = p.dur + p.release;
    lp.frequency.setValueAtTime(p.cutoff * 0.6, s);
    lp.frequency.linearRampToValueAtTime(p.cutoff, s + p.attack + 2);
    lp.frequency.linearRampToValueAtTime(p.cutoff * 0.75, s + total);
    lp.connect(bus);
    const pans = [-0.3, 0.25, -0.05];
    p.midis.forEach((m, i) => {
      // bows enter one after another
      const T = s + i * between(r, 0.6, 1.8);
      const g = ctx.createGain();
      const peak = 0.03 * (i === 0 ? 1.1 : 0.85);
      g.gain.value = 0;
      g.gain.setValueAtTime(0, T);
      // raised-cosine-ish swell: linear to a third, then a slow exponential approach
      g.gain.linearRampToValueAtTime(peak * 0.35, T + p.attack * 0.35);
      g.gain.setTargetAtTime(peak, T + p.attack * 0.35, p.attack * 0.3);
      g.gain.setTargetAtTime(0, T + p.dur, p.release / 5);
      mine.push(g);
      panned(g, pans[i % 3], lp);
      const f = midiHz(m);
      for (const dc of [-6, 5]) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = f * cents(between(r, -2, 2));
        osc.detune.value = dc;
        osc.connect(g);
        track(osc);
        osc.start(T);
        osc.stop(T + p.dur + p.release + 0.1);
      }
    });
  };

  const piano = (s: number, n: NoteItem, r: Rand) => {
    n.midis.forEach((m, j) => {
      const T = s + j * n.spread;
      const f = midiHz(m);
      const vel = n.vel * (j ? 0.8 : 1);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = (900 + 900 * vel) * (1 - 0.2 * (n.ev ?? 0));
      lp.Q.value = 0.4;
      panned(lp, between(r, -0.35, 0.35), notesNear);
      const tau1 = 2.4 * Math.pow(220 / f, 0.35);
      const B = 0.00032;
      for (let k = 1; k <= 6; k++) {
        const fk = k * f * Math.sqrt(1 + B * k * k);
        if (fk > 5000) break;
        const a = (0.06 * vel) / Math.pow(k, 1.25) * (k >= 4 ? 0.55 : 1);
        const tau = tau1 / Math.pow(k, 0.75);
        const osc = ctx.createOscillator();
        osc.frequency.value = fk * cents(between(r, -1.5, 1.5));
        const g = ctx.createGain();
        g.gain.value = 0;
        g.gain.setValueAtTime(0, T);
        g.gain.linearRampToValueAtTime(a, T + 0.009);
        g.gain.setTargetAtTime(a * 0.55, T + 0.009, 0.25);
        g.gain.setTargetAtTime(0, T + 0.5, tau);
        osc.connect(g).connect(lp);
        track(osc);
        osc.start(T);
        osc.stop(T + 0.5 + tau * 7);
      }
      // the felt hammer: a soft, dark thump
      const hs = ctx.createBufferSource();
      hs.buffer = noiseBuffer(ctx, 'pink');
      const hf = ctx.createBiquadFilter();
      hf.type = 'lowpass';
      hf.frequency.value = 700;
      const hg = ctx.createGain();
      hg.gain.value = 0;
      hg.gain.setValueAtTime(0, T);
      hg.gain.linearRampToValueAtTime(0.02 * vel, T + 0.003);
      hg.gain.setTargetAtTime(0, T + 0.003, 0.01);
      hs.connect(hf).connect(hg).connect(lp);
      track(hs);
      hs.start(T, r() * 2);
      hs.stop(T + 0.1);
    });
  };

  const bowl = (s: number, n: NoteItem, r: Rand) => {
    const g = ctx.createGain();
    g.gain.value = 0.045;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2400;
    g.connect(lp);
    panned(lp, between(r, -0.5, 0.5), notesFar);
    scoreBowl(ctx, g, s, n.midis[0], n.vel, r, track);
  };

  const composer = new Composer(o.seed);
  composer.setEvening(ev);
  const perf = mulberry32((o.seed * 2654435761) >>> 0);
  let stopped = false;
  // Notes are scheduled LOOKAHEAD ahead; pads only PAD_AHEAD ahead (so the change can still move).
  const scheduleUntil = (tEnd: number, now: number) => {
    if (stopped) return;
    for (;;) {
      const s = at + composer.peekTime();
      if (s >= tEnd) return;
      if (composer.peekIsPad() && s > now + PAD_AHEAD) return;
      const it = composer.next();
      if (it.kind === 'pad') pad(s, it, perf);
      else if (it.kind === 'piano') piano(s, it, perf);
      else bowl(s, it, perf);
    }
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  const end = o.renderUntil ?? at + 60;
  if (o.live) {
    scheduleUntil(ctx.currentTime + LOOKAHEAD, ctx.currentTime);
    timer = setInterval(() => scheduleUntil(ctx.currentTime + LOOKAHEAD, ctx.currentTime), 1000);
  } else {
    const t0 = Math.max(at, ctx.currentTime);
    scheduleUntil(Math.min(end, t0 + LOOKAHEAD), t0);
    // offline: the same incremental schedule, one tick a second (falls back to all at once)
    let incremental = true;
    for (let k = t0 + 1; k < end && incremental; k += 1) {
      const tick = k;
      incremental = offlineAt(ctx, tick, () => scheduleUntil(Math.min(end, tick + LOOKAHEAD), tick));
    }
    if (!incremental) scheduleUntil(end, end);
  }

  /** Run `f` at context time `t`: now (live), or when the offline render reaches it. */
  const when = (t: number, f: (t: number) => void) => {
    if (o.live || t <= ctx.currentTime + 0.01 || !offlineAt(ctx, t - 0.004, () => f(t))) f(Math.max(t, ctx.currentTime));
  };

  return {
    seed: o.seed,
    chordAt(t: number) {
      return composer.chordAt(t - at);
    },
    advance(t: number) {
      if (stopped) return false;
      if (o.live) {
        const moved = composer.retime(t - at);
        if (moved) scheduleUntil(ctx.currentTime + LOOKAHEAD, ctx.currentTime);
        return moved;
      }
      when(t, (tt) => {
        if (composer.retime(tt - at)) scheduleUntil(tt + LOOKAHEAD, tt);
      });
      return true;
    },
    lean(t: number) {
      if (stopped) return;
      when(t, (tt) => {
        composer.lean();
        const target = Math.max(tt - at + 2.5, composer.lastChange + MIN_CHANGE);
        if (composer.retime(target)) scheduleUntil(tt + LOOKAHEAD, tt);
      });
    },
    setCold(on: boolean, t: number) {
      if (stopped || on === cold) return;
      cold = on;
      const tau = on ? 0.1 : 0.3;
      roomCold.gain.cancelScheduledValues(t);
      roomCold.gain.setValueAtTime(on ? 1 : ROOM_COLD_GAIN, t);
      roomCold.gain.setTargetAtTime(on ? ROOM_COLD_GAIN : 1, t, tau);
      roomHp.frequency.cancelScheduledValues(t);
      roomHp.frequency.setValueAtTime(roomHpHz(ev, !on), t);
      roomHp.frequency.setTargetAtTime(roomHpHz(ev, on), t, tau);
    },
    setEvening(e: number, t: number) {
      if (stopped || !Number.isFinite(e)) return;
      const v = Math.max(0, Math.min(1, e));
      if (v === ev) return;
      ev = v;
      // the notes still to be written take it when the render reaches t; the colour drifts slowly
      when(t, () => composer.setEvening(v));
      tone.frequency.setTargetAtTime(TONE_DUSK_HZ - TONE_NIGHT_DROP_HZ * v, t, EVENING_TAU);
      roomLp.frequency.setTargetAtTime(roomLpHz(v), t, EVENING_TAU);
      roomHp.frequency.setTargetAtTime(roomHpHz(v, cold), t, EVENING_TAU);
      roomEve.gain.setTargetAtTime(1 + 0.12 * v, t, EVENING_TAU);
    },
    setIdle(on: boolean, t: number) {
      if (stopped || on === idle) return;
      idle = on;
      when(t, (tt) => {
        for (const g of [notesNear, notesFar]) {
          g.gain.cancelScheduledValues(tt);
          g.gain.setValueAtTime(g.gain.value, tt);
          g.gain.setTargetAtTime(on ? 0 : 1, tt, on ? 4 / 3 : 2 / 3);
        }
      });
    },
    stop(t: number, fade = 1.5) {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      for (const f of fades) {
        const g = f.gain;
        g.cancelScheduledValues(t);
        g.setValueAtTime(g.value, t);
        g.linearRampToValueAtTime(0, t + fade);
      }
      const end = t + fade + 0.1;
      for (const s of sources) {
        try {
          s.stop(end);
        } catch {
          /* not started yet or already stopped */
        }
      }
      if (o.live) {
        setTimeout(() => {
          out.disconnect();
          wet.disconnect();
        }, (end - ctx.currentTime) * 1000 + 4500);
      }
    },
  };
}
