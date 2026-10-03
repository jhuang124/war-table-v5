// Offline renders (OfflineAudioContext) through the same Mixer the game uses. Browser-only.

import { mulberry32 } from './dsp';
import { MAX_VOICES, Mixer } from './mixer';
import { createMusicHall } from './music';
import { SFX } from './sounds';
import type { SfxName, SfxVariant } from './types';

export const OFFLINE_SR = 48000;
/** Room tail allowance after a sound's own duration (B1: the shared hall's tap is 2.4 s). */
const TAIL = 2.6;
/** Key-locked sounds may be re-pitched down by up to a tritone (longer by up to √2). */
const KEY_STRETCH = Math.SQRT2;

export interface RenderOptions {
  seed?: number;
  rate?: number;
  duration?: number;
  variant?: SfxVariant;
  volume?: number;
  /** Include the master limiter + soft clip (default false: measure the sound on its own). */
  limiter?: boolean;
  sampleRate?: number;
  /** v4 A2: 0 = at the table .. 1 = far. */
  distance?: number;
  /** v4 B2: force the chord (pitch classes, root first); default: no score → D minor. */
  chord?: number[];
}

export interface RenderResult {
  buffer: AudioBuffer;
  /** What the SoundFn reported (seconds). */
  reportedDur: number;
}

export function renderLength(name: SfxName, o: RenderOptions = {}): number {
  const meta = SFX[name];
  const rate = o.rate ?? 1;
  let dur = meta.maxDur * (meta.key ? KEY_STRETCH : 1);
  if (meta.duration && o.duration !== undefined) dur += Math.max(0, o.duration - meta.duration[2]);
  return dur / rate + TAIL;
}

export async function renderSfx(name: SfxName, o: RenderOptions = {}): Promise<RenderResult> {
  const sr = o.sampleRate ?? OFFLINE_SR;
  const len = Math.ceil(renderLength(name, o) * sr);
  const ctx = new OfflineAudioContext(2, len, sr);
  const mixer = new Mixer(ctx, ctx.destination, { limiter: o.limiter ?? false, live: false });
  const ok = mixer.trigger(name, 0, { rand: mulberry32(o.seed ?? 1), rate: o.rate, duration: o.duration, variant: o.variant, volume: o.volume, distance: o.distance, chord: o.chord });
  if (!ok) throw new Error(`${name} failed to build (seed ${o.seed ?? 1})`);
  const reportedDur = mixer.lastDuration;
  const buffer = await ctx.startRendering();
  return { buffer, reportedDur };
}

/**
 * Bank consistency: a banked playback must equal a direct synthesis of the same seed (same channel
 * layout, same level). Mono sounds must stay mono in the bank, or the panner would play them 3 dB hot.
 */
export async function renderBankPair(name: SfxName): Promise<{ direct: AudioBuffer; banked: AudioBuffer; bankChannels: number }> {
  const sr = OFFLINE_SR;
  const len = Math.ceil(renderLength(name) * sr);
  const a = new OfflineAudioContext(2, len, sr);
  new Mixer(a, a.destination, { limiter: false, bank: false }).trigger(name, 0, { rand: mulberry32(1) });
  const b = new OfflineAudioContext(2, len, sr);
  const mb = new Mixer(b, b.destination, { limiter: false, bank: true, bankRand: mulberry32(1), rateJitter: false });
  const d = SFX[name].duration?.[2];
  const [stored] = await mb.bank!.prepare(name, undefined, d, 1);
  if (!mb.trigger(name, 0, { rand: mulberry32(1) })) throw new Error(`bank trigger failed for ${name}`);
  return { direct: await a.startRendering(), banked: await b.startRendering(), bankChannels: stored.numberOfChannels };
}

/**
 * Robustness sweep: build every sound (and variant, rate and duration extreme) with many random
 * seeds at t = 0. Any exception inside a SoundFn (e.g. a note jittered to a negative time) shows up
 * as a failed trigger.
 */
export async function buildSweep(seeds = 20): Promise<string[]> {
  const bad: string[] = [];
  const cases: { name: SfxName; variant?: SfxVariant; duration?: number; rate?: number }[] = [];
  for (const name of Object.keys(SFX) as SfxName[]) {
    if (SFX[name].silent) continue;
    cases.push({ name }, { name, rate: 0.5 }, { name, rate: 2 });
    const d = SFX[name].duration;
    if (d) cases.push({ name, duration: d[0] }, { name, duration: d[1] });
  }
  for (const name of ['turnStart', 'conquer', 'continent', 'sheet'] as SfxName[]) cases.push({ name, variant: 'bright' }, { name, variant: 'somber' });
  cases.push({ name: 'sheet', variant: 'lift' });
  const origWarn = console.warn;
  let msg = '';
  console.warn = (...a: unknown[]) => (msg = a.map(String).join(' '));
  try {
    for (const c of cases) {
      for (let s = 0; s < seeds; s++) {
        // one short context per build, rendered to completion so its buffers can be collected
        const ctx = new OfflineAudioContext(2, 128, OFFLINE_SR);
        const m = new Mixer(ctx, ctx.destination, { limiter: false, bank: false });
        msg = '';
        if (!m.trigger(c.name, 0, { rand: mulberry32(1000 + s), rate: c.rate, duration: c.duration, variant: c.variant })) bad.push(`${JSON.stringify(c)} seed ${1000 + s}: ${msg}`);
        await ctx.startRendering();
      }
    }
  } finally {
    console.warn = origWarn;
  }
  return bad;
}

/** A full single roll: 3 attacker dice (pan −0.3) + 2 defender dice (+0.3), 40 ms apart (UX §8.2). */
export async function renderDiceRoll(seed = 1): Promise<AudioBuffer> {
  const sr = OFFLINE_SR;
  const ctx = new OfflineAudioContext(2, Math.ceil(2 * sr), sr);
  const mixer = new Mixer(ctx, ctx.destination, { limiter: false });
  const rand = mulberry32(seed);
  const pans = [-0.3, -0.3, -0.3, 0.3, 0.3];
  pans.forEach((pan, i) => mixer.trigger('diceLand', 0.01 + i * 0.04, { pan, rand }));
  return ctx.startRendering();
}

export interface StressResult {
  buffer: AudioBuffer;
  played: number;
  dropped: number;
  stolen: number;
  maxConcurrent: number;
  requested: number;
}

/**
 * Worst case: a blitz storm far denser than the game ever produces (every 25 ms: die, hit, place,
 * shake, card) plus every stinger at once, through the full limiter chain.
 */
export async function renderStress(seconds = 4): Promise<StressResult> {
  const sr = OFFLINE_SR;
  const ctx = new OfflineAudioContext(2, Math.ceil((seconds + 7.5) * sr), sr);
  const mixer = new Mixer(ctx, ctx.destination, { limiter: true });
  const rand = mulberry32(7);
  let requested = 0;
  let maxConcurrent = 0;
  const spam: SfxName[] = ['diceLand', 'hit', 'place', 'diceShake', 'cardDraw', 'uiClick', 'march'];
  for (let t = 0.01; t < seconds; t += 0.025) {
    for (const name of spam) {
      requested++;
      mixer.trigger(name, t, { rand, pan: rand() * 2 - 1, volume: 1.5 });
    }
    maxConcurrent = Math.max(maxConcurrent, mixer.voiceCountAt(t));
  }
  for (const name of ['conquer', 'continent', 'eliminated', 'victory', 'turnStart', 'cardTrade'] as SfxName[]) {
    requested++;
    mixer.trigger(name, 0.5, { rand, volume: 1.5 });
  }
  maxConcurrent = Math.max(maxConcurrent, mixer.voiceCountAt(0.5));
  if (maxConcurrent > MAX_VOICES) throw new Error(`voice cap exceeded: ${maxConcurrent}`);
  const buffer = await ctx.startRendering();
  return { buffer, played: mixer.played, dropped: mixer.dropped, stolen: mixer.stolen, maxConcurrent, requested };
}

/** Limiter transparency: a −20 dBFS sine through the master chain must come out at −20 dBFS. */
export async function renderLimiterProbe(amplitude: number): Promise<{ inPeak: number; outPeak: number; outRms: number; inRms: number }> {
  const sr = OFFLINE_SR;
  const ctx = new OfflineAudioContext(2, sr, sr);
  const mixer = new Mixer(ctx, ctx.destination, { limiter: true });
  const osc = ctx.createOscillator();
  osc.frequency.value = 440;
  const g = ctx.createGain();
  g.gain.value = amplitude;
  osc.connect(g).connect(mixer.sfxBus);
  osc.start(0);
  const buf = await ctx.startRendering();
  const d = buf.getChannelData(0);
  let peak = 0,
    e = 0,
    n = 0;
  for (let i = Math.floor(sr * 0.5); i < d.length; i++) {
    peak = Math.max(peak, Math.abs(d[i]));
    e += d[i] * d[i];
    n++;
  }
  return { inPeak: amplitude, outPeak: peak, outRms: Math.sqrt(e / n), inRms: amplitude / Math.SQRT2 };
}

export async function renderMusic(seconds = 60, seed = 3, sampleRate = OFFLINE_SR): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
  const mixer = new Mixer(ctx, ctx.destination, { limiter: false });
  mixer.startMusic(0, { seed, renderUntil: seconds });
  return ctx.startRendering();
}

/**
 * The live brush stroke, scripted: press, a quick sure drag (speed rising to 1 and easing), release.
 * `commit` = it armed an attack; otherwise it dries out.
 */
export async function renderStroke(commit = true): Promise<AudioBuffer> {
  const sr = OFFLINE_SR;
  const ctx = new OfflineAudioContext(2, Math.ceil(2.2 * sr), sr);
  const mixer = new Mixer(ctx, ctx.destination, { limiter: false });
  const h = mixer.stroke({ at: 0.05 }) as ReturnType<Mixer['stroke']> & { moveAt: (v: number, at: number, p?: number) => void; endAt: (c: boolean, at: number) => void };
  for (let k = 0; k <= 45; k++) {
    const t = 0.05 + k * 0.016;
    const u = k / 45;
    h.moveAt(Math.sin(Math.PI * Math.min(1, u * 1.15)) * 1.0 + 0.05, t, -0.3 + 0.6 * u);
  }
  h.endAt(commit, 0.05 + 46 * 0.016);
  return ctx.startRendering();
}

/**
 * SOUL's moment, rendered through the live mix (limiter on): the score underneath; Sam's brush stroke
 * from Ural toward Siberia; Roll; the wooden cup; bone dice click into the tray; the verdict beat;
 * a breath of smoke as John's figure falls; the snap and the flood as Sam's colour soaks across;
 * the march; then the board settles back into the score. Timings follow the dice tray (single roll).
 */
export async function renderMoment(seed = 6, seconds = 18): Promise<{ buffer: AudioBuffer; marks: { t: number; what: string }[] }> {
  const sr = OFFLINE_SR;
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sr), sr);
  const mixer = new Mixer(ctx, ctx.destination, { limiter: true });
  const rand = mulberry32(seed);
  mixer.startMusic(0, { seed: 11, renderUntil: seconds, fadeIn: 3 });
  const marks: { t: number; what: string }[] = [];
  const play = (name: SfxName, t: number, o: Parameters<Mixer['trigger']>[2] = {}) => {
    mixer.trigger(name, t, { rand, ...o });
    marks.push({ t, what: name + (o.variant ? ` · ${o.variant}` : '') });
  };
  // the stroke
  const S = 6;
  const h = mixer.stroke({ at: S }) as ReturnType<Mixer['stroke']> & { moveAt: (v: number, at: number, p?: number) => void; endAt: (c: boolean, at: number) => void };
  for (let k = 0; k <= 40; k++) {
    const u = k / 40;
    h.moveAt(0.1 + 0.9 * Math.sin(Math.PI * Math.min(1, u * 1.1)), S + k * 0.016, -0.2 + 0.4 * u);
  }
  h.endAt(true, S + 0.66);
  marks.push({ t: S, what: 'stroke (drag Ural → Siberia)' });
  // Roll
  const R = S + 1.3;
  play('uiClick', R);
  play('diceShake', R + 0.02, { duration: 0.15 });
  // tumble 450 ms, dice touch down 40 ms apart
  const land = R + 0.02 + 0.15 + 0.29;
  [-0.3, -0.3, -0.3, 0.3, 0.3].forEach((pan, i) => play('diceLand', land + i * 0.04, { pan }));
  const settle = land + 0.16 + 0.1;
  mixer.hush(settle, 0.25);
  marks.push({ t: settle, what: 'verdict beat (hush 250 ms)' });
  const verdict = settle + 0.25;
  play('hit', verdict, { pan: 0.3 });
  const fall = verdict + 0.34;
  play('conquer', fall, { variant: 'somber', pan: 0.2 });
  play('march', fall + 0.15, { duration: 0.5, pan: 0.1 });
  return { buffer: await ctx.startRendering(), marks };
}

// ---------------------------------------------------------------------------
// v4: one room (B1), key-lock (B2), the breathing score (B3), distance (A2)
// ---------------------------------------------------------------------------

/**
 * B1: the hall's decay as each path hears it. Renders (a) diceLand, seed 1, through the effects path
 * (its real tail), (b) a unit click through the effects' hall send alone, and (c) a unit click through
 * the score's own hall path (createMusicHall + the score's warm high cut): the "pad note's" room.
 */
export async function renderRoomProbes(): Promise<{ diceLand: AudioBuffer; sfxHall: AudioBuffer; scoreHall: AudioBuffer; diceDrySec: number }> {
  const sr = OFFLINE_SR;
  const len = Math.ceil(4.5 * sr);
  const a = new OfflineAudioContext(2, len, sr);
  const ma = new Mixer(a, a.destination, { limiter: false });
  ma.trigger('diceLand', 0, { rand: mulberry32(1) });
  const diceDrySec = ma.lastDuration;
  const click = (ctx: OfflineAudioContext, dest: AudioNode) => {
    const b = ctx.createBuffer(1, 2, sr);
    b.getChannelData(0)[0] = 1;
    const s = ctx.createBufferSource();
    s.buffer = b;
    s.connect(dest);
    s.start(0);
  };
  const b = new OfflineAudioContext(2, len, sr);
  const mb = new Mixer(b, b.destination, { limiter: false });
  click(b, mb.room);
  const c = new OfflineAudioContext(2, len, sr);
  const hall = createMusicHall(c, c.destination);
  click(c, hall.input);
  return { diceLand: await a.startRendering(), sfxHall: await b.startRendering(), scoreHall: await c.startRendering(), diceDrySec };
}

/** B2: render one pitched sound over a forced chord; returns the buffer and the pitch the key-lock chose. */
export async function renderInKey(name: SfxName, chord: number[] | null, variant?: SfxVariant, seed = 1): Promise<{ buffer: AudioBuffer; midi: number | undefined }> {
  const sr = OFFLINE_SR;
  const ctx = new OfflineAudioContext(1, Math.ceil(renderLength(name) * sr), sr);
  const mixer = new Mixer(ctx, ctx.destination, { limiter: false });
  mixer.room.disconnect(); // the dry note only: the hall would smear the pitch estimate
  mixer.trigger(name, 0, { rand: mulberry32(seed), variant, chord: chord ?? undefined });
  return { buffer: await ctx.startRendering(), midi: mixer.lastKey[name] };
}

/** B3: the score alone (effects muted) with scripted breathing; for level and chord checks. */
export async function renderBreath(o: { seconds: number; seed?: number; swellAt?: number; turnAt?: number; leanAt?: number; idleAt?: number; wakeAt?: number; sampleRate?: number }): Promise<{ buffer: AudioBuffer; chords: { t: number; chord: string }[] }> {
  const sr = o.sampleRate ?? 24000;
  const ctx = new OfflineAudioContext(2, Math.ceil(o.seconds * sr), sr);
  const mixer = new Mixer(ctx, ctx.destination, { limiter: false });
  mixer.sfxBus.gain.value = 0;
  mixer.startMusic(0, { seed: o.seed ?? 5, renderUntil: o.seconds, fadeIn: 2 });
  if (o.swellAt !== undefined) mixer.swell(o.swellAt);
  if (o.turnAt !== undefined) mixer.turnPassed(false, o.turnAt);
  if (o.leanAt !== undefined) mixer.lean(o.leanAt);
  if (o.idleAt !== undefined) mixer.setIdle(true, o.idleAt);
  if (o.wakeAt !== undefined) mixer.setIdle(false, o.wakeAt);
  const buffer = await ctx.startRendering();
  const chords: { t: number; chord: string }[] = [];
  for (let t = 0; t < o.seconds; t += 0.5) chords.push({ t, chord: mixer.chordName(t) });
  return { buffer, chords };
}

export type SceneName = 'human-turn' | 'ai-readable' | 'continent-in-key' | 'idle-thin' | 'cold-lean';

/**
 * Listening excerpts for the lead and John (artifacts/audio/v4/*.wav). Through the live mix (limiter
 * on), the score underneath (seeded), effects at the controller's v4 mapping.
 */
export async function renderScene(name: SceneName): Promise<{ buffer: AudioBuffer; marks: { t: number; what: string }[] }> {
  const sr = OFFLINE_SR;
  const seconds = name === 'idle-thin' ? 24 : 10;
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sr), sr);
  const mixer = new Mixer(ctx, ctx.destination, { limiter: true });
  const rand = mulberry32(21);
  mixer.startMusic(0, { seed: 11, renderUntil: seconds, fadeIn: 1.5 });
  const marks: { t: number; what: string }[] = [];
  const play = (n: SfxName, t: number, o: Parameters<Mixer['trigger']>[2] = {}) => {
    mixer.trigger(n, t, { rand, ...o });
    marks.push({ t, what: n + (o.variant ? ` · ${o.variant}` : '') + (o.distance ? ` · d ${o.distance}` : '') });
  };
  const mark = (t: number, what: string) => marks.push({ t, what });
  if (name === 'human-turn') {
    // an AI turn ends; the cup slides to Sam (a human): the chord changes with the slide, the score
    // swells, the cup is set down in the new chord's root, the sheet breath brightens
    play('cupSlide', 3.6, { duration: 0.4, pan: 0.2 });
    mixer.turnPassed(true, 3.6);
    mark(3.6, 'turnPassed(toHuman)');
    play('cupSet', 4.0, { pan: 0.3 });
    play('turnStart', 4.25, { variant: 'bright' });
    play('tick', 6.2, { pan: -0.2 });
    play('place', 6.8, { pan: -0.1 });
    play('place', 7.1, { pan: 0.05, rate: 1.03 });
    play('place', 7.4, { pan: 0.15, rate: 1.06 });
  } else if (name === 'ai-readable') {
    // an AI turn at distance 0.6: stroke → one bone click → verdict → the flood; twice, evenly
    const d = 0.6;
    play('cupSlide', 1.0, { duration: 0.4, distance: d });
    mixer.turnPassed(false, 1.0);
    mark(1.0, 'turnPassed(AI)');
    play('cupSet', 1.4, { distance: d });
    for (let k = 0; k < 4; k++) play('place', 2.0 + k * 0.12, { distance: d, pan: -0.3 + 0.1 * k });
    for (const [t0, pan] of [[3.2, -0.2], [6.2, 0.25]] as [number, number][]) {
      play('whoosh', t0, { duration: 0.5, distance: d, pan });
      play('bone', t0 + 0.75, { distance: d, pan });
      play('hit', t0 + 1.2, { distance: d, pan });
      play('conquer', t0 + 1.55, { distance: d, pan });
      play('march', t0 + 1.7, { duration: 0.4, distance: d, pan });
    }
  } else if (name === 'continent-in-key') {
    // Sam takes the last territory of a continent: flood, then the bowl rings in the chord's key;
    // later a human's continent is broken: the damped bowl on the minor third, and one cold chord
    play('hit', 2.0, { pan: 0.2 });
    play('conquer', 2.35, { pan: 0.2 });
    play('continent', 3.1);
    play('conquer', 6.6, { variant: 'somber', pan: -0.2, distance: 0.6 });
    play('continent', 7.3, { variant: 'somber', distance: 0.6 });
    mixer.lean(7.3);
    mark(7.3, 'lean(cold)');
  } else if (name === 'cold-lean') {
    play('cupSlide', 1.0, { duration: 0.4 });
    mixer.turnPassed(true, 1.0);
    play('cupSet', 1.4);
    play('eliminated', 5.0);
    mixer.lean(5.0);
    mark(5.0, 'lean(cold)');
  } else {
    // idle: nobody touches the table at 2 s; the notes thin out over ~4 s (drone + pads stay); a tap
    // at 18 s brings them back over ~2 s
    mixer.setIdle(true, 2);
    mark(2, 'setIdle(true)');
    mixer.setIdle(false, 18);
    mark(18, 'setIdle(false)');
    play('tick', 18);
  }
  const buffer = await ctx.startRendering();
  const chordAt = (t: number) => mixer.chordName(t);
  for (const m of marks) if (/turnPassed|lean/.test(m.what)) m.what += ` (chord ${chordAt(m.t - 0.2)} → ${chordAt(m.t + 3)})`;
  return { buffer, marks };
}

