// The mixer: voice management + room reverb + master chain. Works on any BaseAudioContext, so the
// exact same routing renders live and inside an OfflineAudioContext for measurement.
//
//  voice ─ fade-in ─ [distance shelf] ─┬─ panner ─────────────────► sfxBus (volume²) ─ HP 30 Hz ─ shelf ─┐
//                                      └─ send(wet·distance) ─ hall (the score's impulse, shorter tap)    │
//                                                                  ─ warm LP ─ return ► sfxBus            │
//  music ─ duck ─ swell ─ musicVol ─────────────────────────────────────────────────────────────────────── ┤
//                                                                                                         ▼
//                                                          preMaster ─ limiter ─ makeup-comp ─ soft clip ─ mute ─ out
//
// v4 (PLAN §4): B1 one room (the effects' send goes into the score's hall: same impulse, same RT60),
// B2 key-locked effects (chordAt from the score; D-minor fallback), B3 the score breathes (turnPassed,
// lean, setIdle, the +2 dB swell), B4 every voice fades in over ≥ 15 ms except the one sharp family,
// A2 distance (0 at the table .. 1 far: −4 dB, more hall, a gentle high-shelf cut).
//
// v5 (PROPOSAL §4 A, B, F): the dice pour (landings 60–90 ms apart are one sequence: each die takes the
// next of three bone timbres and a ±4 % rate spread; the first is a touch louder, later ones a little
// wetter; dice stay exempt from the 70 ms rule), texture variants (hit · pair is exempt too, so the
// verdict's pairs are never thinned), a default distance per sound (rattle 0.3), panTo (a voice that
// travels), fightCold (a 2 dB high shelf on the score + the room tone thins), setEvening (the score's clock).

import { SoundBank } from './bank';
import { cached, clamp, dbToGain, mulberry32, roomImpulse, softClipCurve } from './dsp';
import { TONIC_PCS, keyPitch, layerOn, toneLayer } from './key';
import { CHORDS, HALL_RT60, SFX_HALL_SECONDS, createMusicHall, musicHallImpulse, startMusic, type MusicHall, type MusicHandle } from './music';
import { SFX } from './sounds';
import { strokeLoop } from './sounds/brush';
import type { Rand, SfxName, SfxVariant, StrokeHandle } from './types';

export const MAX_VOICES = 20;
/** Scheduling lookahead for live plays (keeps envelopes from starting in the past). */
export const LOOKAHEAD = 0.006;
/** Silence rule: at most one cue starts per this many seconds (textures like the dice are exempt). */
export const CUE_GAP = 0.07;
/** Music duck recovery time constant: back to ~95% in 2–3 s. */
const DUCK_RECOVER_TAU = 0.8;
/** Default verdict beat (INK: 250 ms of silence between the dice settling and the verdict). */
export const HUSH_DEFAULT = 0.25;

// Limiter: hard knee so the WebAudio auto-makeup gain is exactly predictable and can be undone.
const LIM_THRESHOLD = -3;
const LIM_RATIO = 20;
/** Spec'd DynamicsCompressor makeup = (1/fullRangeGain)^0.6; this undoes it. */
export const LIMITER_MAKEUP_COMP = dbToGain(0.6 * (LIM_THRESHOLD + -LIM_THRESHOLD / LIM_RATIO));

/** Live stroke level: at full speed it sits around the ui tier (a whisper under the board). */
export const STROKE_TRIM_DB = -9.5;

/** B4: default voice fade-in (s). Nothing starts from zero except the sounds that set attack: 0. */
export const DEFAULT_ATTACK = 0.02;
/** A2: at distance 1 (far across the room). */
export const FAR_DB = -4;
export const FAR_SHELF_DB = -6;
const FAR_SHELF_HZ = 1800;
/** A2: hall send at distance 1 = wet·FAR_WET_MUL + FAR_WET_ADD (linear in between). */
const FAR_WET_MUL = 2.2;
const FAR_WET_ADD = 0.12;
/** B3: the swell when a human's turn begins. */
export const SWELL_DB = 2;
const SWELL_IN = 2;
const SWELL_OUT = 8;
/** v5: landings closer than this to the previous one belong to the same pour. */
export const DICE_SEQ_GAP = 0.2;
/** v5: the dice pour. Later dice sit this far under the first (dB) … */
export const DICE_LATER_DB = -1;
/** … each die's hall send grows by this (×, per place in the pour, up to 4 places). */
export const DICE_WET_STEP = 0.18;
/** v5: per-die rate spread (±). */
export const DICE_RATE_SPREAD = 0.04;
/** v5: fightCold: the score's high shelf (Hz, dB) and how fast it goes cold / comes back (time constants, s). */
export const COLD_SHELF_HZ = 1100;
export const COLD_SHELF_DB = -2;
const COLD_IN_TAU = 0.1;
const COLD_OUT_TAU = 0.3;

export interface MixerOptions {
  /** Master limiter + soft clip (live: on; per-sound analysis: off, to prove sounds are clean alone). */
  limiter?: boolean;
  /** Live contexts schedule node cleanup with timers; offline ones don't need it. */
  live?: boolean;
  /** Pre-rendered variation bank (default: on when live). */
  bank?: boolean;
  /** Rand for bank renders and variation picks (tests pass a seeded one). */
  bankRand?: Rand;
  /** ±2% playback-rate jitter on banked, non-musical sounds (default true). */
  rateJitter?: boolean;
}

export interface TriggerOptions {
  volume?: number;
  pan?: number;
  rate?: number;
  duration?: number;
  variant?: SfxVariant;
  rand?: Rand;
  /** A2: 0 = at the table .. 1 = far. */
  distance?: number;
  /** Tests: force the chord (pitch classes, root first) instead of asking the score. */
  chord?: number[];
  /** v5: travel from `pan` to `panTo` over the motion length (or the sound's own). */
  panTo?: number;
  /** v5 (tests): force a diceLand timbre (0..2) instead of the pour's own choice. */
  timbre?: number;
}

interface Voice {
  name: SfxName;
  start: number;
  end: number;
  priority: number;
  gain: GainNode;
  nodes: AudioNode[];
  timer?: ReturnType<typeof setTimeout>;
}

export class Mixer {
  readonly ctx: BaseAudioContext;
  readonly sfxBus: GainNode;
  readonly musicBus: GainNode;
  readonly musicDuck: GainNode;
  /** v5: fightCold's high shelf on the whole score (hall and room tone included). */
  readonly coldShelf: BiquadFilterNode;
  readonly musicVol: GainNode;
  /** B3: +2 dB when a human's turn begins. */
  readonly musicSwell: GainNode;
  readonly muteGain: GainNode;
  /** B1: the effects' hall (the score's impulse, a shorter tap). */
  readonly room: ConvolverNode;
  private idle = false;
  private cold = false;
  private evening = 0;
  /** v5: the dice pour in progress (context time of the last landing, its place in the pour). */
  private diceSeq = { last: -Infinity, index: -1 };
  /** v5: the last diceLand's place in its pour (0 = first), for tests. */
  lastDiceIndex = -1;
  /** Last pitch the key-lock chose per sound (debugging, tests). */
  lastKey: Partial<Record<SfxName, number>> = {};
  private readonly live: boolean;
  private readonly rateJitter: boolean;
  readonly bank: SoundBank | null;
  private voices: Voice[] = [];
  private lastAt: Partial<Record<SfxName, number>> = {};
  private duckUntil = 0;
  private duckDepth = 0;
  private music: MusicHandle | null = null;
  private hall: MusicHall | null = null;
  private hallReady: Promise<void> | null = null;
  /** Recent cue starts (context time, priority), for the ≤ 1 cue per 70 ms rule. */
  private cues: { t: number; p: number; v: Voice }[] = [];
  private hushFrom = -1;
  private hushUntil = -1;
  private liveStroke: { handle: StrokeHandle; kill: (at: number) => void } | null = null;
  /** Plays suppressed by the silence rules (hush, cue spacing, silent sounds). */
  hushed = 0;
  played = 0;
  dropped = 0;
  stolen = 0;
  /** Duration (s) the last successful trigger reported. */
  lastDuration = 0;

  constructor(ctx: BaseAudioContext, out: AudioNode = ctx.destination, opts: MixerOptions = {}) {
    this.ctx = ctx;
    this.live = opts.live ?? false;
    this.rateJitter = opts.rateJitter ?? true;
    this.bank = opts.bank ?? this.live ? new SoundBank(ctx, { rand: opts.bankRand, background: this.live }) : null;
    const limiter = opts.limiter ?? true;

    this.sfxBus = ctx.createGain();
    this.room = ctx.createConvolver();
    this.room.normalize = false;
    this.room.buffer = roomImpulse(ctx, HALL_RT60, SFX_HALL_SECONDS);
    // the same warm high cut the score's hall return has
    const roomTone = ctx.createBiquadFilter();
    roomTone.type = 'lowpass';
    roomTone.frequency.value = 3200;
    roomTone.Q.value = 0.5;
    const roomReturn = ctx.createGain();
    roomReturn.gain.value = 1;
    this.room.connect(roomTone).connect(roomReturn).connect(this.sfxBus);

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 30;
    hp.Q.value = 0.6;
    const shelf = ctx.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = 7500;
    shelf.gain.value = -2.5;

    this.musicBus = ctx.createGain();
    this.musicDuck = ctx.createGain();
    this.musicVol = ctx.createGain();
    this.musicVol.gain.value = 0.7 * 0.7;
    this.musicSwell = ctx.createGain();
    this.coldShelf = ctx.createBiquadFilter();
    this.coldShelf.type = 'highshelf';
    this.coldShelf.frequency.value = COLD_SHELF_HZ;
    this.coldShelf.gain.value = 0;
    this.musicBus.connect(this.coldShelf).connect(this.musicDuck).connect(this.musicSwell).connect(this.musicVol);

    const pre = ctx.createGain();
    this.sfxBus.connect(hp).connect(shelf).connect(pre);
    this.musicVol.connect(pre);

    this.muteGain = ctx.createGain();
    let tail: AudioNode = pre;
    if (limiter) {
      const lim = ctx.createDynamicsCompressor();
      lim.threshold.value = LIM_THRESHOLD;
      lim.knee.value = 0;
      lim.ratio.value = LIM_RATIO;
      lim.attack.value = 0.001;
      lim.release.value = 0.12;
      const comp = ctx.createGain();
      comp.gain.value = LIMITER_MAKEUP_COMP;
      const clip = ctx.createWaveShaper();
      clip.curve = softClipCurve(0.75, 0.944);
      clip.oversample = 'none';
      tail = tail.connect(lim).connect(comp).connect(clip);
    }
    tail.connect(this.muteGain).connect(out);
  }

  // -------------------------------------------------------------------------

  trigger(name: SfxName, when: number, o: TriggerOptions = {}): boolean {
    const meta = SFX[name];
    if (!meta) return false;
    if (meta.silent) {
      this.hushed++;
      return false;
    }
    // the verdict beat: nothing new starts inside it
    if (when >= this.hushFrom && when < this.hushUntil) {
      this.hushed++;
      return false;
    }
    // v5: a texture variant (hit · pair) is part of the verdict's texture, like the dice
    const textureVariant = !!o.variant && !!meta.textureVariants?.includes(o.variant);
    const texture = !!meta.texture || textureVariant;
    const minGapMs = textureVariant ? (meta.textureGapMs ?? 20) : meta.minGapMs;
    // A sound retriggered inside its own minimum gap is a repeat, not a new cue: drop it first, so a
    // burst of one sound thins to one instead of queueing up behind itself.
    const prev = this.lastAt[name];
    if (prev !== undefined && when >= prev && (when - prev) * 1000 < minGapMs) {
      this.dropped++;
      return false;
    }
    // ≤ 1 cue per 70 ms. The more important cue wins: a new one replaces a lesser one that is
    // (about to be) sounding; an equal important one waits its turn (≤ a few frames, never audibly
    // late); routine sounds that collide simply drop (that is what thins dense bursts).
    if (!texture) {
      for (let k = 0; k < 4; k++) {
        const clash = this.cues.find((c) => Math.abs(when - c.t) < CUE_GAP - 1e-6);
        if (!clash) break;
        if (meta.priority > clash.p) {
          this.steal(clash.v, when);
          this.cues = this.cues.filter((c) => c !== clash);
          continue;
        }
        if (meta.priority < 3 || k === 3) {
          this.hushed++;
          return false;
        }
        when = clash.t + CUE_GAP;
      }
      if (when >= this.hushFrom && when < this.hushUntil) {
        this.hushed++;
        return false;
      }
    }
    this.prune(when);

    const last = this.lastAt[name];
    if (last !== undefined && when >= last && (when - last) * 1000 < minGapMs) {
      this.dropped++;
      return false;
    }
    const mine = this.voices.filter((v) => v.name === name);
    if (mine.length >= meta.maxVoices) this.steal(mine[0], when);
    const others = Math.min(mine.length, meta.maxVoices - 1);
    if (this.voices.length >= MAX_VOICES) {
      let victim: Voice | null = null;
      for (const v of this.voices) if (!victim || v.priority < victim.priority) victim = v;
      if (victim && victim.priority <= meta.priority) this.steal(victim, when);
      else {
        this.dropped++;
        return false;
      }
    }

    const ctx = this.ctx;
    const rand = o.rand ?? Math.random;
    const volume = clamp(o.volume ?? 1, 0, 2);
    const distance = clamp(Number.isFinite(o.distance) ? (o.distance as number) : (meta.distance ?? 0), 0, 1);
    const density = meta.densityDb ? Math.min(meta.densityMaxDb ?? 6, others * meta.densityDb) : 0;
    const duration = meta.duration ? clamp(o.duration ?? meta.duration[2], meta.duration[0], meta.duration[1]) : undefined;
    // B2: a whole-note sound is re-pitched to the chord tone (the caller's rate is ignored: key wins)
    let rate = clamp(o.rate ?? 1, 0.5, 2);
    // v5: the dice pour. Landings within DICE_SEQ_GAP of the last one continue the pour: each die takes the
    // next bone timbre and its own small rate; the first is a touch louder, later ones send more to the hall.
    let timbre: number | undefined;
    let seqDb = 0;
    let seqWet = 1;
    if (meta.timbres) {
      const s = this.diceSeq;
      const index = when >= s.last && when - s.last < DICE_SEQ_GAP ? s.index + 1 : 0;
      this.diceSeq = { last: when, index };
      this.lastDiceIndex = index;
      timbre = Number.isFinite(o.timbre) ? clamp(Math.round(o.timbre as number), 0, meta.timbres - 1) : index % meta.timbres;
      seqDb = index > 0 ? DICE_LATER_DB : 0;
      seqWet = 1 + DICE_WET_STEP * Math.min(index, 4);
      // (off with rateJitter: false, so a bank-vs-direct comparison draws the same stream)
      if (this.rateJitter) rate = clamp(rate * (1 + (rand() * 2 - 1) * DICE_RATE_SPREAD), 0.5, 2);
    }
    const pcs = meta.key || meta.tone ? (o.chord ?? this.chordPcs(when)) : null;
    if (meta.key && pcs) {
      const role = o.variant === 'somber' && meta.key.somberRole ? meta.key.somberRole : meta.key.role;
      const m = keyPitch(pcs, role, meta.key.ref);
      this.lastKey[name] = m;
      rate = Math.pow(2, (m - meta.key.ref) / 12);
    }
    // the voice: fade-in (B4) → distance shelf (A2) → panner + hall send (B1)
    const gain = ctx.createGain();
    const level = dbToGain(meta.trimDb - density + FAR_DB * distance + seqDb) * volume;
    const attack = meta.attack ?? DEFAULT_ATTACK;
    if (attack > 0) {
      gain.gain.value = 0;
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(level, when + attack);
    } else gain.gain.value = level;
    const nodes: AudioNode[] = [gain];
    let tap: AudioNode = gain;
    if (distance > 0) {
      const sh = ctx.createBiquadFilter();
      sh.type = 'highshelf';
      sh.frequency.value = FAR_SHELF_HZ;
      sh.gain.value = FAR_SHELF_DB * distance;
      gain.connect(sh);
      tap = sh;
      nodes.push(sh);
    }
    let head: AudioNode = tap;
    let panner: StereoPannerNode | null = null;
    if (typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(o.pan ?? 0, -1, 1);
      tap.connect(p);
      head = p;
      nodes.push(p);
      panner = p;
    }
    head.connect(this.sfxBus);
    const wet = (meta.wet * (1 + (FAR_WET_MUL - 1) * distance) + FAR_WET_ADD * distance) * seqWet;
    if (wet > 0) {
      const send = ctx.createGain();
      send.gain.value = wet;
      tap.connect(send).connect(this.room);
      nodes.push(send);
    }

    let dur: number;
    try {
      const dq = SoundBank.quantize(duration);
      const banked = this.bank?.take(name, o.variant, dq, timbre) ?? null;
      if (banked) {
        const src = ctx.createBufferSource();
        src.buffer = banked;
        // (the dice already carry their own ±4 % spread)
        const r = rate * (meta.musical || meta.timbres || !this.rateJitter ? 1 : 1 + (rand() * 2 - 1) * 0.02);
        src.playbackRate.value = r;
        src.connect(gain);
        src.start(when);
        dur = banked.duration / r;
      } else {
        dur = meta.fn(ctx, gain, when, { rate, rand, duration: dq, variant: o.variant, timbre });
        this.bank?.request(name, o.variant, dq, timbre);
      }
      // B2: tuned layers at the chord's pitch (never banked: a few oscillators)
      if (meta.tone && pcs) {
        for (const l of meta.tone) {
          if (!layerOn(l, o.variant)) continue;
          const m = keyPitch(pcs, l.role, l.ref);
          this.lastKey[name] = this.lastKey[name] === undefined || l === meta.tone[0] ? m : this.lastKey[name];
          dur = Math.max(dur, toneLayer(ctx, gain, when, m, l, rand, 1 / rate));
        }
      }
    } catch (err) {
      for (const n of nodes) n.disconnect();
      console.warn(`[audio] ${name} failed`, err);
      return false;
    }
    if (!Number.isFinite(dur) || dur <= 0) dur = meta.maxDur / rate;
    // v5: a voice that travels (the glint runs shore to shore)
    if (panner && Number.isFinite(o.panTo)) {
      const span = Math.max(0.05, (duration ?? dur) / rate);
      panner.pan.setValueAtTime(clamp(o.pan ?? 0, -1, 1), when);
      panner.pan.linearRampToValueAtTime(clamp(o.panTo as number, -1, 1), when + span);
    }

    const v: Voice = { name, start: when, end: when + dur, priority: meta.priority, gain, nodes };
    if (this.live) {
      const ms = (v.end - ctx.currentTime) * 1000 + 250;
      v.timer = setTimeout(() => this.release(v), Math.max(50, ms));
    }
    this.voices.push(v);
    if (!texture) {
      this.cues.push({ t: when, p: meta.priority, v });
      if (this.cues.length > 12) this.cues.shift();
    }
    this.lastAt[name] = when;
    this.lastDuration = dur;
    this.played++;
    if (meta.duckDb) this.duck(when, dur, meta.duckDb);
    return true;
  }

  /** Fade out everything playing or scheduled (e.g. on skipAnimations). */
  stopAll(at = this.ctx.currentTime): void {
    for (const v of [...this.voices]) this.steal(v, at, false);
    this.lastAt = {};
    this.cues = [];
    this.hushUntil = -1;
    this.diceSeq = { last: -Infinity, index: -1 };
    this.liveStroke?.kill(at);
    this.liveStroke = null;
  }

  /** The verdict beat: nothing new starts in [at, at+sec), and the score dips under it. */
  hush(at: number, sec = HUSH_DEFAULT): void {
    const s = clamp(sec, 0, 2);
    this.hushFrom = at;
    this.hushUntil = at + s;
    this.duck(at, s, 5);
  }

  voiceCount(): number {
    return this.voiceCountAt(this.ctx.currentTime);
  }

  /** Voices still sounding (or scheduled) at context time t. */
  voiceCountAt(t: number): number {
    this.prune(t);
    return this.voices.length;
  }

  voicesByName(): Partial<Record<SfxName, number>> {
    this.prune(this.ctx.currentTime);
    const out: Partial<Record<SfxName, number>> = {};
    for (const v of this.voices) out[v.name] = (out[v.name] ?? 0) + 1;
    return out;
  }

  setVolume(v: number, at = this.ctx.currentTime): void {
    const g = clamp(v, 0, 1);
    this.sfxBus.gain.setTargetAtTime(g * g, at, 0.03);
  }

  setMusicVolume(v: number, at = this.ctx.currentTime): void {
    const g = clamp(v, 0, 1);
    this.musicVol.gain.setTargetAtTime(g * g, at, 0.1);
  }

  setMuted(m: boolean, at = this.ctx.currentTime): void {
    this.muteGain.gain.setTargetAtTime(m ? 0 : 1, at, 0.02);
  }

  // v4: the chord, the breathing score -------------------------------------

  /** Pitch classes of the chord sounding at context time t (root first); D minor without the score. */
  chordPcs(t: number): number[] {
    const i = this.music?.chordAt?.(t);
    return i === null || i === undefined ? TONIC_PCS : CHORDS[i].pcs;
  }

  /** Name of the chord the effects are tuned to at t ('Dm' = the no-score fallback). */
  chordName(t = this.ctx.currentTime): string {
    const i = this.music?.chordAt?.(t);
    return i === null || i === undefined ? 'Dm' : CHORDS[i].name;
  }

  /**
   * B3: the turn passed. The score takes its next chord change at `at` (the walk keeps its weights;
   * only the moment moves). `toHuman`: the score swells +2 dB over 2 s and settles back over ~8 s.
   */
  turnPassed(toHuman: boolean, at = this.ctx.currentTime): void {
    this.music?.advance?.(at);
    if (toHuman) this.swell(at);
  }

  /** B3: the +2 dB swell (never stacks: a new one starts from wherever the last one is). */
  swell(at = this.ctx.currentTime): void {
    const g = this.musicSwell.gain;
    g.cancelScheduledValues(at);
    g.setValueAtTime(this.swellValueAt(at), at);
    g.linearRampToValueAtTime(dbToGain(SWELL_DB), at + SWELL_IN);
    g.linearRampToValueAtTime(1, at + SWELL_IN + SWELL_OUT);
    this.swellFrom = at;
  }

  private swellFrom = -Infinity;
  private swellValueAt(t: number): number {
    const u = t - this.swellFrom;
    const top = dbToGain(SWELL_DB);
    if (!(u >= 0) || u >= SWELL_IN + SWELL_OUT) return 1;
    if (u < SWELL_IN) return 1 + (top - 1) * (u / SWELL_IN);
    return top + (1 - top) * ((u - SWELL_IN) / SWELL_OUT);
  }

  /** B3: a human lost a continent or a seat: one cold chord, soon, then the walk returns. */
  lean(at = this.ctx.currentTime): void {
    this.music?.lean?.(at);
  }

  /** B3 / §7.14: idle. The score thins to drone + pads over ~4 s; back over ~2 s. Tempo untouched. */
  setIdle(on: boolean, at = this.ctx.currentTime): void {
    this.idle = on;
    this.music?.setIdle?.(on, at);
  }

  get isIdle(): boolean {
    return this.idle;
  }

  /**
   * v5 (the room goes cold for a breath): with the camera lean. on = the score's top dips COLD_SHELF_DB
   * (quickly) and the room tone thins; off = both come back over ~1 s.
   */
  setCold(on: boolean, at = this.ctx.currentTime): void {
    if (on === this.cold) return;
    this.cold = on;
    const g = this.coldShelf.gain;
    g.cancelScheduledValues(at);
    g.setValueAtTime(on ? 0 : COLD_SHELF_DB, at);
    g.setTargetAtTime(on ? COLD_SHELF_DB : 0, at, on ? COLD_IN_TAU : COLD_OUT_TAU);
    this.music?.setCold?.(on, at);
  }

  get isCold(): boolean {
    return this.cold;
  }

  /** v5: the evening clock, 0 (dusk) .. 1 (night): the score's voicings and room tone lean darker, slowly. */
  setEvening(t: number, at = this.ctx.currentTime): void {
    const e = clamp(Number.isFinite(t) ? t : 0, 0, 1);
    this.evening = e;
    this.music?.setEvening?.(e, at);
  }

  get eveningValue(): number {
    return this.evening;
  }

  // Music ------------------------------------------------------------------

  startMusic(at = this.ctx.currentTime, opts: { seed?: number; renderUntil?: number; fadeIn?: number } = {}): void {
    if (this.music) return;
    const seed = opts.seed ?? ((Math.random() * 1e9) | 0);
    const begin = (t: number) =>
      startMusic(this.ctx, this.musicBus, t, { seed, live: this.live, renderUntil: opts.renderUntil, fadeIn: opts.fadeIn, hall: this.hall ?? undefined, evening: this.evening, cold: this.cold });
    if (!this.live) {
      this.hall ??= createMusicHall(this.ctx, this.musicBus);
      this.music = begin(at);
      if (this.idle) this.music.setIdle?.(true, at);
      return;
    }
    if (this.hall) {
      this.music = begin(at);
      if (this.idle) this.music.setIdle?.(true, at);
      return;
    }
    // Live, first start: the hall (a 4 s impulse plus the convolver's setup, ~40 ms together) is
    // built across two idle slices so it never lands as one long task. The score fades in over
    // seconds, so starting ~100 ms later is inaudible.
    let cancelled = false;
    const pending: MusicHandle = {
      seed,
      stop: () => {
        cancelled = true;
      },
    };
    this.music = pending;
    void this.buildHall().then(() => {
      if (cancelled || this.music !== pending) return;
      this.music = begin(Math.max(at, this.ctx.currentTime + 0.05));
      if (this.idle) this.music.setIdle?.(true, this.ctx.currentTime);
    });
  }

  private buildHall(): Promise<void> {
    if (this.hallReady) return this.hallReady;
    const w = typeof window !== 'undefined' ? (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }) : null;
    const idle = (cb: () => void) => (w?.requestIdleCallback ? w.requestIdleCallback(cb, { timeout: 250 }) : setTimeout(cb, 16));
    this.hallReady = new Promise<void>((resolve) => {
      idle(() => {
        musicHallImpulse(this.ctx);
        idle(() => {
          this.hall = createMusicHall(this.ctx, this.musicBus);
          resolve();
        });
      });
    });
    return this.hallReady;
  }

  stopMusic(at = this.ctx.currentTime, fade = 1.5): void {
    this.music?.stop(at, fade);
    this.music = null;
  }

  /** Crossfade to a newly seeded score (a new game), ~3 s. */
  reseedMusic(seed: number, at = this.ctx.currentTime): void {
    if (!this.music || this.music.seed === seed) return;
    this.music.stop(at, 3);
    this.music = null;
    this.startMusic(at + 0.5, { seed, fadeIn: 5 });
  }

  get musicSeed(): number | null {
    return this.music?.seed ?? null;
  }

  get musicOn(): boolean {
    return this.music !== null;
  }

  // -------------------------------------------------------------------------

  /** Dip the score while a cue sounds; a smaller cue never lifts a deeper duck. Recovers over 2–3 s. */
  private duck(when: number, dur: number, db: number): void {
    const g = this.musicDuck.gain;
    const active = when < this.duckUntil;
    const depth = active ? Math.max(this.duckDepth, Math.abs(db)) : Math.abs(db);
    const end = Math.max(when + Math.min(dur * 0.8, 3), this.duckUntil);
    this.duckUntil = end;
    this.duckDepth = depth;
    g.cancelScheduledValues(when);
    g.setTargetAtTime(dbToGain(-depth), when, 0.06);
    g.setTargetAtTime(1, end, DUCK_RECOVER_TAU);
  }

  // Live stroke ---------------------------------------------------------------

  /**
   * A brush stroke the pointer drives (drag-to-attack). A looping bristle texture whose band and level
   * follow the pointer's speed. `at` lets offline renders script it; live callers omit it.
   */
  stroke(o: { pan?: number; at?: number } = {}): StrokeHandle {
    const ctx = this.ctx;
    const t0 = o.at ?? ctx.currentTime;
    this.liveStroke?.kill(t0);
    const src = ctx.createBufferSource();
    src.buffer = cached(ctx, 'strokeLoop', () => strokeLoop(ctx, mulberry32(77)));
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.8;
    bp.frequency.value = 600;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3600;
    const g = ctx.createGain();
    g.gain.value = 0;
    const out = ctx.createGain();
    out.gain.value = dbToGain(STROKE_TRIM_DB);
    const nodes: AudioNode[] = [src, bp, lp, g, out];
    src.connect(bp).connect(lp).connect(g).connect(out);
    let head: AudioNode = out;
    let pan: StereoPannerNode | null = null;
    if (typeof ctx.createStereoPanner === 'function') {
      pan = ctx.createStereoPanner();
      pan.pan.value = clamp(o.pan ?? 0, -1, 1);
      out.connect(pan);
      head = pan;
      nodes.push(pan);
    }
    head.connect(this.sfxBus);
    const send = ctx.createGain();
    send.gain.value = 0.1;
    out.connect(send).connect(this.room);
    nodes.push(send);
    src.start(t0, Math.random() * 1.5);

    let done = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const maxAt = t0 + 8;
    const kill = (at: number, fade = 0.2) => {
      if (done) return;
      done = true;
      if (idle) clearTimeout(idle);
      const t = Math.max(at, ctx.currentTime);
      g.gain.cancelScheduledValues(t);
      g.gain.setTargetAtTime(0, t, fade / 4);
      src.stop(t + fade + 0.05);
      if (this.live) setTimeout(() => nodes.forEach((n) => n.disconnect()), (t + fade + 0.2 - ctx.currentTime) * 1000);
      if (this.liveStroke?.handle === handle) this.liveStroke = null;
    };
    const handle: StrokeHandle & { moveAt?: (speed: number, at: number, p?: number) => void; endAt?: (commit: boolean, at: number) => void } = {
      move: (speed, p) => handle.moveAt!(speed, ctx.currentTime, p),
      end: (commit) => handle.endAt!(commit, ctx.currentTime),
    };
    handle.moveAt = (speed: number, at: number, p?: number) => {
      if (done || !Number.isFinite(speed)) return;
      if (at >= maxAt) return kill(at);
      const v = clamp(speed, 0, 1.5);
      // resting = silent; a quick stroke = a soft, bright sweep
      const level = v < 0.02 ? 0 : Math.pow(Math.min(1, v), 0.7);
      g.gain.setTargetAtTime(level, at, 0.05);
      bp.frequency.setTargetAtTime(480 + 1100 * Math.min(1, v), at, 0.08);
      if (pan && p !== undefined && Number.isFinite(p)) pan.pan.setTargetAtTime(clamp(p, -1, 1), at, 0.1);
      if (this.live) {
        if (idle) clearTimeout(idle);
        // a stuck pointer never leaves a hiss behind
        idle = setTimeout(() => g.gain.setTargetAtTime(0, ctx.currentTime, 0.1), 400);
      }
    };
    handle.endAt = (commit: boolean, at: number) => {
      if (done) return;
      if (commit) {
        // the stroke settles into the arrow: a last short press, then it lifts
        g.gain.cancelScheduledValues(at);
        g.gain.setTargetAtTime(0.6, at, 0.02);
        bp.frequency.setTargetAtTime(700, at, 0.04);
        kill(at + 0.08, 0.28);
      } else kill(at, 0.2);
    };
    this.liveStroke = { handle, kill };
    return handle;
  }

  private prune(now: number): void {
    if (!this.voices.length) return;
    // Offline renders schedule a whole scene up front, so a voice that "ended" before a later
    // trigger's start time has not even played yet: only forget it, never disconnect it (live
    // voices are disconnected by their own timers).
    this.voices = this.voices.filter((v) => v.end > now);
  }

  private steal(v: Voice, when: number, count = true): void {
    const at = Math.max(when, this.ctx.currentTime);
    const g = v.gain.gain;
    const cur = g.value;
    g.cancelScheduledValues(0);
    if (at <= v.start) g.setValueAtTime(0, at);
    else {
      g.setValueAtTime(cur, at);
      g.linearRampToValueAtTime(0, at + 0.03);
    }
    v.end = Math.min(v.end, at + 0.03);
    this.voices = this.voices.filter((x) => x !== v);
    if (count) this.stolen++;
    if (this.live) {
      if (v.timer) clearTimeout(v.timer);
      const ms = (at + 0.06 - this.ctx.currentTime) * 1000;
      v.timer = setTimeout(() => this.disconnect(v), Math.max(40, ms));
    }
  }

  private release(v: Voice): void {
    this.voices = this.voices.filter((x) => x !== v);
    this.disconnect(v);
  }

  private disconnect(v: Voice): void {
    for (const n of v.nodes) {
      try {
        n.disconnect();
      } catch {
        /* already disconnected */
      }
    }
  }
}
