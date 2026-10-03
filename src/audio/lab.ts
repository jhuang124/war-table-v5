// Sound Lab (audio.html): the ink bank by material, the ambient score, game-beat scenarios, and the
// offline analysis the team uses instead of ears. Also exposes window.__audioLab for the verify script.

import '@fontsource-variable/cormorant-garamond';
import { analyze, encodeWav, fft, longLoudness, pitchNear, rt60, speakerHighpass, type SoundStats } from './analyze';
import { midiHz } from './dsp';
import { TONIC_PCS, keyPitch, layerOn } from './key';
import { WARM_ORDER } from './bank';
import { LIMITS, summarize, type SoundReport } from './checks';
import { createAudio } from './engine';
import { LIMITER_MAKEUP_COMP, MAX_VOICES, Mixer } from './mixer';
import { CHORDS, COLD, planScore, type NoteItem } from './music';
import { OFFLINE_SR, buildSweep, renderBankPair, renderBreath, renderDiceRoll, renderInKey, renderLimiterProbe, renderMoment, renderMusic, renderRoomProbes, renderScene, renderSfx, renderStress, renderStroke, type RenderOptions, type SceneName } from './offline';
import { SFX } from './sounds';
import { SFX_NAMES, TIER_TARGET_LUFS, V4_CUES, type PlayOptions, type SfxName, type SfxVariant, type StrokeHandle } from './types';

const engine = createAudio({ volume: 0.8 });
/** Sounds that actually sound (uiHover is silent by design: no hover sounds). */
const AUDIBLE = SFX_NAMES.filter((n) => !SFX[n].silent);

/** The five materials (INK §6). */
const MATERIAL: Record<SfxName, 'paper' | 'brush' | 'wood' | 'bone' | 'bowl'> = {
  uiHover: 'paper', uiClick: 'paper', uiError: 'paper', cardDraw: 'paper', cardTrade: 'paper', turnStart: 'paper',
  whoosh: 'brush', place: 'brush', unplace: 'brush', march: 'brush', hit: 'brush', conquer: 'brush',
  diceShake: 'wood', diceLand: 'bone', continent: 'bowl', eliminated: 'bowl', victory: 'bowl',
  sheet: 'paper', tick: 'paper', cupSlide: 'wood', cupSet: 'wood', bone: 'bone',
};

// ---------------------------------------------------------------------------
// Rendering + analysis API (used by the page and by src/audio/verify.ts)
// ---------------------------------------------------------------------------

const channelsOf = (b: AudioBuffer) => Array.from({ length: b.numberOfChannels }, (_, i) => b.getChannelData(i));
const SEEDS = [1, 2, 3, 4, 5, 6];

async function analyzeSound(name: SfxName, seeds = SEEDS, o: RenderOptions = {}): Promise<SoundReport> {
  const runs: { stats: SoundStats; reportedDur: number }[] = [];
  for (const seed of seeds) {
    const r = await renderSfx(name, { ...o, seed });
    runs.push({ stats: analyze(channelsOf(r.buffer), r.buffer.sampleRate), reportedDur: r.reportedDur });
  }
  return summarize(name, runs);
}

async function analyzeAll(seeds = SEEDS): Promise<SoundReport[]> {
  const out: SoundReport[] = [];
  for (const n of AUDIBLE) out.push(await analyzeSound(n, seeds));
  return out;
}

/** A single measurement for a specific option set (variants, durations, rates). */
async function measure(name: SfxName, o: RenderOptions = {}): Promise<SoundStats & { reportedDur: number }> {
  const r = await renderSfx(name, o);
  return { ...analyze(channelsOf(r.buffer), r.buffer.sampleRate), reportedDur: r.reportedDur };
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Trim trailing near-silence (keeps 30 ms) so exported WAVs don't carry a second of nothing. */
function trimmed(b: AudioBuffer): Float32Array[] {
  const ch = channelsOf(b);
  let last = 0;
  for (const c of ch) for (let i = 0; i < c.length; i++) if (Math.abs(c[i]) > 1e-4) last = Math.max(last, i);
  const end = Math.min(ch[0].length, last + Math.round(0.03 * b.sampleRate));
  return ch.map((c) => c.slice(0, end));
}

async function wavBase64(name: SfxName, o: RenderOptions = {}): Promise<string> {
  const r = await renderSfx(name, o);
  return toBase64(encodeWav(trimmed(r.buffer), r.buffer.sampleRate));
}

async function composites() {
  const roll = await renderDiceRoll(1);
  const rollStats = analyze(channelsOf(roll), roll.sampleRate);
  const stress = await renderStress(4);
  const stressStats = analyze(channelsOf(stress.buffer), stress.buffer.sampleRate);
  const quiet = await renderLimiterProbe(0.1);
  const loud = await renderLimiterProbe(2.0);
  const music = await renderMusic(60, 3);
  const musicCh = channelsOf(music);
  const musicStats = analyze(musicCh, music.sampleRate);
  // gap check: RMS of every 2 s window after the 6 s fade-in
  const sr = music.sampleRate;
  let minWindowDb = Infinity;
  for (let s = 6 * sr; s + 2 * sr <= musicCh[0].length; s += sr) {
    let e = 0;
    for (const c of musicCh) for (let i = s; i < s + 2 * sr; i++) e += c[i] * c[i];
    const db = 10 * Math.log10(e / (2 * sr * musicCh.length) + 1e-20);
    minWindowDb = Math.min(minWindowDb, db);
  }
  return {
    diceRoll: { ...rollStats, target: TIER_TARGET_LUFS.board },
    stress: { ...stressStats, played: stress.played, dropped: stress.dropped, stolen: stress.stolen, maxConcurrent: stress.maxConcurrent, requested: stress.requested, maxVoices: MAX_VOICES },
    limiter: {
      makeupComp: LIMITER_MAKEUP_COMP,
      quietGainDb: 20 * Math.log10(quiet.outRms / quiet.inRms),
      loudOutPeak: loud.outPeak,
    },
    music: { ...musicStats, minWindowDb },
  };
}

async function bankCheck() {
  const out: { name: SfxName; directLk: number; bankedLk: number; dLk: number; dPeak: number; channels: number }[] = [];
  for (const name of AUDIBLE) {
    const { direct, banked, bankChannels } = await renderBankPair(name);
    const a = analyze(channelsOf(direct), direct.sampleRate);
    const b = analyze(channelsOf(banked), banked.sampleRate);
    out.push({ name, directLk: a.lk200, bankedLk: b.lk200, dLk: b.lk200 - a.lk200, dPeak: b.peakDb - a.peakDb, channels: bankChannels });
  }
  return out;
}

/** Live: wait for the bank to warm, then time play() for every sound (muted). */
async function liveCost(timeoutMs = 30000) {
  const t0 = performance.now();
  while (engine.stats().banked < WARM_ORDER.length && performance.now() - t0 < timeoutMs) await new Promise((r) => setTimeout(r, 100));
  const warmMs = performance.now() - t0;
  engine.setMuted(true);
  const cost: Record<string, { median: number; max: number }> = {};
  for (const n of AUDIBLE) {
    const ts: number[] = [];
    for (let i = 0; i < 7; i++) {
      engine.stopAll();
      await new Promise((r) => setTimeout(r, 30));
      const a = performance.now();
      engine.play(n);
      ts.push(performance.now() - a);
    }
    ts.sort((x, y) => x - y);
    cost[n] = { median: ts[3], max: ts[6] };
  }
  engine.stopAll();
  engine.setMuted(false);
  return { banked: engine.stats().banked, warmMs, cost };
}

async function variants() {
  const cases: [SfxName, RenderOptions, string][] = [
    ['turnStart', { variant: 'bright' }, 'turnStart bright'],
    ['conquer', { variant: 'somber' }, 'conquer somber (snap)'],
    ['continent', { variant: 'somber' }, 'continent somber'],
    ['diceShake', { duration: 0.08 }, 'diceShake 80 ms'],
    ['diceShake', { duration: 0.6 }, 'diceShake 600 ms'],
    ['march', { duration: 0.22 }, 'march 220 ms'],
    ['march', { duration: 0.9 }, 'march 900 ms'],
    ['whoosh', { duration: 0.3 }, 'whoosh 300 ms'],
    ['whoosh', { duration: 0.9 }, 'whoosh 900 ms'],
    ['diceLand', { rate: 1.4 }, 'diceLand rate 1.4'],
    ['cardTrade', { rate: 0.75 }, 'cardTrade rate 0.75'],
    ['sheet', { variant: 'lift' }, 'sheet lift'],
    ['cupSlide', { duration: 0.25 }, 'cupSlide 250 ms'],
    ['cupSlide', { duration: 0.8 }, 'cupSlide 800 ms'],
    ['eliminated', { chord: CHORDS[2].pcs }, 'eliminated over Bbmaj7'],
    ['continent', { chord: CHORDS[4].pcs }, 'continent over Gm9'],
  ];
  const out = [];
  for (const [name, o, label] of cases) out.push({ label, name, ...o, ...(await measure(name, { ...o, seed: 1 })) });
  return out;
}

// ---------------------------------------------------------------------------
// v4: one room, key-lock, the breathing score, distance
// ---------------------------------------------------------------------------

/** B1: RT60 of diceLand's real tail vs the score's hall (a pad note's room) and the effects' hall send. */
async function roomCheck() {
  const p = await renderRoomProbes();
  const dice = rt60(channelsOf(p.diceLand), p.diceLand.sampleRate, p.diceDrySec + 0.03);
  const sfx = rt60(channelsOf(p.sfxHall), p.sfxHall.sampleRate, 0.02);
  const score = rt60(channelsOf(p.scoreHall), p.scoreHall.sampleRate, 0.02);
  return { diceTail: dice, sfxHall: sfx, scoreHall: score, ratio: dice.rt60 / score.rt60 };
}

/** The pitched effects and where to listen for their note (s). */
const PITCHED: { name: SfxName; variant?: SfxVariant; from: number; to: number }[] = [
  { name: 'continent', from: 0.05, to: 1.6 },
  { name: 'continent', variant: 'somber', from: 0.03, to: 0.7 },
  { name: 'eliminated', from: 0.05, to: 1.6 },
  { name: 'victory', from: 0.05, to: 1.6 },
  { name: 'turnStart', from: 0.8, to: 2.4 },
  { name: 'turnStart', variant: 'bright', from: 0.8, to: 2.4 },
  { name: 'cardTrade', from: 0.6, to: 2.0 },
  { name: 'cupSet', from: 0.08, to: 0.9 },
];

/** The role + designed pitch the key-lock uses for this sound/variant. */
function keySpec(name: SfxName, variant?: SfxVariant): { role: 'root' | 'bright' | 'somber'; ref: number } {
  const m = SFX[name];
  if (m.key) return { role: variant === 'somber' && m.key.somberRole ? m.key.somberRole : m.key.role, ref: m.key.ref };
  const l = m.tone!.find((x) => layerOn(x, variant))!;
  return { role: l.role, ref: l.ref };
}

/**
 * B2: every pitched effect over every chord of the field (and with no score): the pitch the mixer
 * chose is the role's chord tone and a tone of the chord, and the rendered note sounds there (±25 c).
 */
async function keyLock() {
  const out: { name: string; chord: string; midi: number; expected: number; chordTone: boolean; cents: number; ok: boolean }[] = [];
  const chords: { name: string; pcs: number[] | null }[] = [...CHORDS.map((c) => ({ name: c.name, pcs: c.pcs })), { name: 'no score (Dm)', pcs: null }];
  for (const p of PITCHED) {
    for (const c of chords) {
      const pcs = c.pcs ?? TONIC_PCS;
      const spec = keySpec(p.name, p.variant);
      const expected = keyPitch(pcs, spec.role, spec.ref);
      const r = await renderInKey(p.name, c.pcs, p.variant);
      const midi = r.midi ?? NaN;
      const chordTone = pcs.includes(((midi % 12) + 12) % 12);
      const det = pitchNear(r.buffer.getChannelData(0), r.buffer.sampleRate, p.from, p.to, midiHz(midi), 2.5);
      const ok = midi === expected && chordTone && Math.abs(det.cents) <= 25;
      out.push({ name: p.name + (p.variant ? ` · ${p.variant}` : ''), chord: c.name, midi, expected, chordTone, cents: det.cents, ok });
    }
  }
  return out;
}

/** A2: the same sound at the table, at 0.6 (the AI) and far. */
async function distanceCheck() {
  const out: { name: SfxName; d: number; lk200: number; centroidHz: number; tailShare: number }[] = [];
  for (const name of ['place', 'bone', 'conquer', 'cupSet'] as SfxName[]) {
    for (const d of [0, 0.6, 1]) {
      const r = await renderSfx(name, { seed: 1, distance: d });
      const ch = channelsOf(r.buffer);
      const s = analyze(ch, r.buffer.sampleRate);
      // the share of energy after the sound's own body (the hall)
      const cut = Math.round((r.reportedDur + 0.02) * r.buffer.sampleRate);
      let tail = 0,
        all = 0;
      for (const c of ch)
        for (let i = 0; i < c.length; i++) {
          all += c[i] * c[i];
          if (i >= cut) tail += c[i] * c[i];
        }
      out.push({ name, d, lk200: s.lk200, centroidHz: s.centroidHz, tailShare: tail / (all || 1) });
    }
  }
  return out;
}

const bandDb = (b: AudioBuffer, from: number, to: number) => {
  const m = monoOf(b);
  const a = Math.round(from * b.sampleRate);
  const z = Math.round(to * b.sampleRate);
  let e = 0;
  for (let i = a; i < z; i++) e += m[i] * m[i];
  return 10 * Math.log10(e / Math.max(1, z - a) + 1e-20);
};

/** B3: the turn moves the chord change; lean gives one cold chord; the swell is +2 dB; idle thins. */
async function breathCheck() {
  const plain = await renderBreath({ seconds: 20 });
  const turned = await renderBreath({ seconds: 20, turnAt: 9 });
  const at = (cs: { t: number; chord: string }[], t: number) => cs.filter((c) => c.t <= t + 1e-9).at(-1)!.chord;
  // the turned render changes chord at the turn (between 8.5 and 9.5 s); the plain one does not
  const turn = {
    plain: plain.chords.map((c) => c.chord).join(' '),
    turned: turned.chords.map((c) => c.chord).join(' '),
    changedAtTurn: at(turned.chords, 8.5) !== at(turned.chords, 9.5) && at(plain.chords, 8.5) === at(plain.chords, 9.5),
  };
  const leaned = await renderBreath({ seconds: 24, leanAt: 9 });
  const firstChange = leaned.chords.find((c, i) => i > 0 && c.t > 9 && c.chord !== leaned.chords[i - 1].chord);
  const coldNames = CHORDS.filter((_, i) => COLD[i]).map((c) => c.name);
  const lean = { at: 9, changeAt: firstChange?.t ?? null, chord: firstChange?.chord ?? null, cold: !!firstChange && coldNames.includes(firstChange.chord) };
  const swelled = await renderBreath({ seconds: 20, swellAt: 6 });
  const swell = { atPeakDb: bandDb(swelled.buffer, 7.8, 8.2) - bandDb(plain.buffer, 7.8, 8.2), afterDb: bandDb(swelled.buffer, 17, 19) - bandDb(plain.buffer, 17, 19) };
  const base40 = await renderBreath({ seconds: 40, sampleRate: 24000 });
  const idle40 = await renderBreath({ seconds: 40, idleAt: 6, sampleRate: 24000 });
  const planned = planScore(5, 40).filter((p) => p.kind !== 'pad' && p.t > 11).length;
  const idle = { plannedNotesAfter11s: planned, heardBase: detectOnsets(monoOf(base40.buffer), 24000).filter((t) => t > 11).length, heardIdle: detectOnsets(monoOf(idle40.buffer), 24000).filter((t) => t > 11).length, levelDropDb: bandDb(idle40.buffer, 11, 40) - bandDb(base40.buffer, 11, 40) };
  return { turn, lean, swell, idle };
}

const SCENES: SceneName[] = ['human-turn', 'ai-readable', 'continent-in-key', 'cold-lean', 'idle-thin'];
async function sceneWav(name: SceneName) {
  const s = await renderScene(name);
  return { b64: wavOf(s.buffer), marks: s.marks, stats: analyze(channelsOf(s.buffer), s.buffer.sampleRate) };
}

// ---------------------------------------------------------------------------
// Drawing: waveform + log-frequency spectrogram
// ---------------------------------------------------------------------------

const RAMP = ['#0b1224', '#15223f', '#2c3e63', '#6b6a6e', '#c9a961', '#f0ebe0'].map((h) => parseInt(h.slice(1), 16));
function rampColor(v: number, out: Uint8ClampedArray, o: number): void {
  const x = Math.max(0, Math.min(0.9999, v)) * (RAMP.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = RAMP[i];
  const b = RAMP[i + 1];
  out[o] = ((a >> 16) & 255) * (1 - f) + ((b >> 16) & 255) * f;
  out[o + 1] = ((a >> 8) & 255) * (1 - f) + ((b >> 8) & 255) * f;
  out[o + 2] = (a & 255) * (1 - f) + (b & 255) * f;
  out[o + 3] = 255;
}

function drawSound(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, mono: Float32Array, sr: number, seconds: number, title: string, lines: string[]): void {
  g.fillStyle = '#0b1224';
  g.fillRect(x, y, w, h);
  const n = Math.min(mono.length, Math.round(seconds * sr));
  const waveH = Math.round(h * 0.28);
  const specY = y + waveH + 2;
  const specH = h - waveH - 2 - 30;
  // waveform (min/max per column), dBFS grid lines at ±0.5 (−6 dB)
  g.strokeStyle = 'rgba(240,235,224,0.12)';
  g.beginPath();
  g.moveTo(x, y + waveH / 2);
  g.lineTo(x + w, y + waveH / 2);
  g.stroke();
  g.fillStyle = 'rgba(240,235,224,0.8)';
  for (let c = 0; c < w; c++) {
    const s0 = Math.floor((c / w) * n);
    const s1 = Math.max(s0 + 1, Math.floor(((c + 1) / w) * n));
    let lo = 0,
      hi = 0;
    for (let i = s0; i < s1; i++) {
      if (mono[i] < lo) lo = mono[i];
      if (mono[i] > hi) hi = mono[i];
    }
    const yy = y + waveH / 2 - hi * (waveH / 2);
    g.fillRect(x + c, yy, 1, Math.max(1, (hi - lo) * (waveH / 2)));
  }
  // spectrogram 40 Hz .. 12 kHz, log axis, −100..−20 dB
  const N = 1024;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const img = g.createImageData(w, specH);
  for (let c = 0; c < w; c++) {
    const center = Math.floor((c / w) * n);
    for (let i = 0; i < N; i++) {
      const k = center - N / 2 + i;
      re[i] = k >= 0 && k < mono.length ? mono[k] * win[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    for (let r = 0; r < specH; r++) {
      const f = 40 * Math.pow(12000 / 40, 1 - r / (specH - 1));
      const k = Math.min(N / 2 - 1, Math.max(1, Math.round((f * N) / sr)));
      const p = (re[k] * re[k] + im[k] * im[k]) / (N * N / 4);
      const dbv = 10 * Math.log10(p + 1e-20);
      rampColor((dbv + 100) / 80, img.data, (r * w + c) * 4);
    }
  }
  g.putImageData(img, x, specY);
  // frequency guides: 100 Hz, 1 kHz, 5 kHz
  g.font = '11px "Cormorant Garamond Variable", serif';
  for (const f of [100, 1000, 5000]) {
    const r = (1 - Math.log(f / 40) / Math.log(12000 / 40)) * (specH - 1);
    g.fillStyle = 'rgba(240,235,224,0.25)';
    g.fillRect(x, specY + r, 6, 1);
    g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 8, specY + r + 3);
  }
  g.fillStyle = '#c9a961';
  g.font = '600 14px "Cormorant Garamond Variable", serif';
  g.fillText(title, x + 6, y + h - 17);
  g.fillStyle = 'rgba(240,235,224,0.7)';
  g.font = '500 12px "Cormorant Garamond Variable", serif';
  g.fillText(lines.join('  ·  '), x + 6, y + h - 4);
}

function monoOf(b: AudioBuffer): Float32Array {
  const ch = channelsOf(b);
  const m = new Float32Array(ch[0].length);
  for (const c of ch) for (let i = 0; i < m.length; i++) m[i] += c[i] / ch.length;
  return m;
}

/** Draw every sound (seed 1) into a grid canvas. Used for the screenshot review. */
async function drawAll(canvas: HTMLCanvasElement, extra: { label: string; name: SfxName; o: RenderOptions }[] = []): Promise<void> {
  const items: { label: string; name: SfxName; o: RenderOptions }[] = [...AUDIBLE.map((n) => ({ label: `${n} · ${MATERIAL[n]}`, name: n, o: {} })), ...extra];
  const cols = 4;
  const cw = 290,
    ch = 200,
    gap = 8;
  const rows = Math.ceil(items.length / cols);
  canvas.width = cols * cw + (cols - 1) * gap;
  canvas.height = rows * ch + (rows - 1) * gap;
  canvas.style.aspectRatio = `${canvas.width} / ${canvas.height}`;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#101a30';
  g.fillRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const r = await renderSfx(it.name, { ...it.o, seed: 1 });
    const s = analyze(channelsOf(r.buffer), r.buffer.sampleRate);
    const secs = Math.min(r.buffer.duration, Math.max(0.25, s.durationSec + 0.05));
    drawSound(g, (i % cols) * (cw + gap), Math.floor(i / cols) * (ch + gap), cw, ch, monoOf(r.buffer), r.buffer.sampleRate, secs, it.label, [
      `${s.lk200.toFixed(1)} LUFS`,
      `pk ${s.peakDb.toFixed(1)}`,
      `${(s.durationSec * 1000).toFixed(0)} ms`,
      `c ${(s.centroidHz / 1000).toFixed(2)}k`,
    ]);
  }
}

async function drawMusic(canvas: HTMLCanvasElement, seconds = 60): Promise<void> {
  const b = await renderMusic(seconds, 3);
  const s = analyze(channelsOf(b), b.sampleRate);
  canvas.width = 1180;
  canvas.height = 260;
  canvas.style.aspectRatio = `${canvas.width} / ${canvas.height}`;
  const g = canvas.getContext('2d')!;
  drawSound(g, 0, 0, canvas.width, canvas.height, monoOf(b), b.sampleRate, seconds, `score · ${seconds} s · seed 3`, [
    `M ${s.lufsM.toFixed(1)} LUFS`,
    `pk ${s.peakDb.toFixed(1)} dBFS`,
    `centroid ${s.centroidHz.toFixed(0)} Hz`,
  ]);
}

// ---------------------------------------------------------------------------
// The score: density, variety, loop-freeness, level, ducking
// ---------------------------------------------------------------------------

const mono = (b: AudioBuffer) => monoOf(b);

/** Log band energies per frame (24 bands, 80 Hz – 4 kHz), mean-removed per band (drone cancels out). */
function bandFrames(x: Float32Array, sr: number, frameSec: number): Float64Array[] {
  const N = 4096;
  const hop = Math.round(frameSec * sr);
  const bands = 24;
  const edges = Array.from({ length: bands + 1 }, (_, k) => 80 * Math.pow(4000 / 80, k / bands));
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const out: Float64Array[] = [];
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let s0 = 0; s0 + N <= x.length; s0 += hop) {
    for (let i = 0; i < N; i++) {
      re[i] = x[s0 + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    const v = new Float64Array(bands);
    for (let b = 0; b < bands; b++) {
      const k0 = Math.max(1, Math.floor((edges[b] * N) / sr));
      const k1 = Math.max(k0 + 1, Math.floor((edges[b + 1] * N) / sr));
      let e = 0;
      for (let k = k0; k < k1; k++) e += re[k] * re[k] + im[k] * im[k];
      v[b] = 10 * Math.log10(e / (k1 - k0) + 1e-12);
    }
    out.push(v);
  }
  const bandsMean = new Float64Array(bands);
  for (const v of out) for (let b = 0; b < bands; b++) bandsMean[b] += v[b] / out.length;
  for (const v of out) for (let b = 0; b < bands; b++) v[b] -= bandsMean[b];
  return out;
}

/** Max cosine similarity between any two `winFrames`-long windows at least `minLagFrames` apart. */
function selfSimilarity(frames: Float64Array[], winFrames: number, minLagFrames: number): { max: number; atLagSec: number } {
  const vec = (i: number) => {
    const v: number[] = [];
    for (let k = 0; k < winFrames; k++) v.push(...frames[i + k]);
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    return v.map((x) => x - m);
  };
  const W: number[][] = [];
  for (let i = 0; i + winFrames <= frames.length; i++) W.push(vec(i));
  let best = -1;
  let lag = 0;
  for (let i = 0; i < W.length; i++)
    for (let j = i + minLagFrames; j < W.length; j++) {
      let d = 0,
        a = 0,
        b = 0;
      for (let k = 0; k < W[i].length; k++) {
        d += W[i][k] * W[j][k];
        a += W[i][k] * W[i][k];
        b += W[j][k] * W[j][k];
      }
      const c = d / Math.sqrt(a * b + 1e-12);
      if (c > best) {
        best = c;
        lag = j - i;
      }
    }
  return { max: best, atLagSec: lag };
}

/** Onsets heard in the render (piano/bowl strikes, not the slow pads): energy flux in 300 Hz–4 kHz. */
function detectOnsets(x: Float32Array, sr: number): number[] {
  const hopSec = 0.05;
  const frames = bandFrames(x, sr, hopSec);
  // un-normalised mid-band level per frame
  const lvl = frames.map((v) => {
    let e = 0;
    for (let b = 6; b < 24; b++) e += Math.pow(10, v[b] / 10);
    return 10 * Math.log10(e + 1e-12);
  });
  const on: number[] = [];
  for (let i = 10; i < lvl.length; i++) {
    let m = 0;
    for (let k = i - 10; k < i - 1; k++) m += lvl[k] / 9;
    const rise = lvl[i] - m;
    if (rise > 4 && (!on.length || i * hopSec - on[on.length - 1] > 2.5)) on.push(i * hopSec);
  }
  return on;
}

async function musicAnalysis(seconds = 60, seed = 3) {
  const plan = planScore(seed, seconds);
  const notes = plan.filter((p): p is NoteItem => p.kind !== 'pad');
  const pads = plan.filter((p) => p.kind === 'pad');
  const b = await renderMusic(seconds, seed);
  const ch = channelsOf(b);
  const stats = analyze(ch, b.sampleRate);
  const loud = longLoudness(ch, b.sampleRate);
  // through laptop / phone speakers (2nd-order high-pass at 180 Hz)
  const hpf = speakerHighpass(b.sampleRate);
  const lap = ch.map((c) => {
    const y = new Float32Array(c.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < c.length; i++) {
      const y0 = hpf.b0 * c[i] + hpf.b1 * x1 + hpf.b2 * x2 - hpf.a1 * y1 - hpf.a2 * y2;
      x2 = x1; x1 = c[i]; y2 = y1; y1 = y0; y[i] = y0;
    }
    return y;
  });
  const loudLaptop = longLoudness(lap, b.sampleRate);
  const m = mono(b);
  const frames = bandFrames(m, b.sampleRate, 0.5);
  // skip the fade-in; 4 s windows, at least 10 s apart
  const sim = selfSimilarity(frames.slice(12), 8, 20);
  const onsets = detectOnsets(m, b.sampleRate).filter((t) => t > 6);
  // a second seed must be a different piece
  const b2 = await renderMusic(seconds, seed + 1);
  const f2 = bandFrames(mono(b2), b2.sampleRate, 0.5);
  let cross = 0;
  const n = Math.min(frames.length, f2.length);
  for (let i = 12; i + 8 <= n; i += 4) {
    const a: number[] = [];
    const c: number[] = [];
    for (let k = 0; k < 8; k++) {
      a.push(...frames[i + k]);
      c.push(...f2[i + k]);
    }
    let d = 0,
      aa = 0,
      cc = 0;
    for (let k = 0; k < a.length; k++) {
      d += a[k] * c[k];
      aa += a[k] * a[k];
      cc += c[k] * c[k];
    }
    cross = Math.max(cross, d / Math.sqrt(aa * cc + 1e-12));
  }
  // 30 minutes of plan: no stepwise runs, no repeated passages, gaps never regular
  const long = planScore(seed, 1800).filter((p): p is NoteItem => p.kind !== 'pad');
  const pianoSeq = long.filter((p) => p.kind === 'piano').map((p) => p.midis[0]);
  let stepwise = 0;
  for (let i = 1; i < pianoSeq.length; i++) if (Math.abs(pianoSeq[i] - pianoSeq[i - 1]) <= 2) stepwise++;
  const gaps = long.slice(1).map((p, i) => p.t - long[i].t);
  const gMean = gaps.reduce((a, x) => a + x, 0) / gaps.length;
  const gSd = Math.sqrt(gaps.reduce((a, x) => a + (x - gMean) ** 2, 0) / gaps.length);
  const grams = new Map<string, number>();
  for (let i = 0; i + 4 <= long.length; i++) {
    const k = long.slice(i, i + 4).map((p) => `${p.kind}:${p.midis.join('+')}`).join(' ');
    grams.set(k, (grams.get(k) ?? 0) + 1);
  }
  const repeated4 = [...grams.values()].filter((c) => c > 1).length;
  const longPads = planScore(seed, 1800).filter((p) => p.kind === 'pad') as { chord: number }[];
  const chordGrams = new Set<string>();
  for (let i = 0; i + 4 <= longPads.length; i++) chordGrams.add(longPads.slice(i, i + 4).map((p) => p.chord).join('-'));
  return {
    seconds,
    seed,
    eventsPerMin: (notes.length * 60) / seconds,
    events: notes.map((p) => ({ t: +p.t.toFixed(2), kind: p.kind, midis: p.midis })),
    pads: pads.map((p) => ({ t: +p.t.toFixed(2), chord: CHORDS[(p as { chord: number }).chord].name })),
    detectedOnsetsPerMin: (onsets.length * 60) / (seconds - 6),
    onsets: onsets.map((t) => +t.toFixed(2)),
    peakDb: stats.peakDb,
    lufsM: stats.lufsM,
    integrated: loud.integrated,
    shortTermMedian: loud.shortTermMedian,
    vsBoardDb: loud.integrated - TIER_TARGET_LUFS.board,
    laptopIntegrated: loudLaptop.integrated,
    laptopDropDb: loud.integrated - loudLaptop.integrated,
    centroidHz: stats.centroidHz,
    hfShare: stats.hfShare,
    dc: stats.dc,
    nan: stats.nan,
    selfSimMax: sim.max,
    selfSimLagSec: sim.atLagSec * 0.5,
    otherSeedSimMax: cross,
    long: { minutes: 30, events: long.length, perMin: long.length / 30, stepwise, gapMean: gMean, gapSd: gSd, repeated4, chordFourGrams: chordGrams.size, pads: longPads.length },
  };
}

/** The duck: the same score rendered with and without a cue on top (the cue itself muted). */
async function duckTest(name: SfxName = 'conquer', at = 20, seconds = 28) {
  const sr = 24000;
  const render = async (withCue: boolean) => {
    const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sr), sr);
    const mixer = new Mixer(ctx, ctx.destination, { limiter: false });
    mixer.sfxBus.gain.value = 0;
    mixer.startMusic(0, { seed: 5, renderUntil: seconds });
    if (withCue) mixer.trigger(name, at, {});
    return ctx.startRendering();
  };
  const a = monoOf(await render(false));
  const b = monoOf(await render(true));
  const W = Math.round(0.1 * sr);
  const curve: { t: number; db: number }[] = [];
  for (let s0 = Math.round((at - 1) * sr); s0 + W <= a.length; s0 += W) {
    let ea = 0,
      eb = 0;
    for (let i = s0; i < s0 + W; i++) {
      ea += a[i] * a[i];
      eb += b[i] * b[i];
    }
    curve.push({ t: s0 / sr - at, db: 10 * Math.log10((eb + 1e-20) / (ea + 1e-20)) });
  }
  const depth = Math.min(...curve.map((c) => c.db));
  const rec = curve.find((c) => c.t > 0.3 && c.db > -1 && curve.filter((d) => d.t >= c.t).every((d) => d.db > -1));
  return { name, depthDb: depth, recoveredWithin1dBAfterSec: rec ? rec.t : Infinity, curve: curve.filter((_, i) => i % 5 === 0) };
}

async function strokeStats() {
  const b = await renderStroke(true);
  const s = analyze(channelsOf(b), b.sampleRate);
  const c = await renderStroke(false);
  const sc = analyze(channelsOf(c), c.sampleRate);
  return { commit: s, cancel: sc };
}

// ---------------------------------------------------------------------------
// Scenarios: real game beats (ink timings: dice tray single roll, INK §4)
// ---------------------------------------------------------------------------

let demoStroke: StrokeHandle | null = null;
const scenarios: Record<string, () => void> = {
  'Single roll (3v2)': () => {
    engine.play('uiClick');
    engine.play('diceShake', { duration: 0.15, delay: 0.02 });
    [-0.3, -0.3, -0.3, 0.3, 0.3].forEach((pan, i) => engine.play('diceLand', { pan, delay: 0.46 + i * 0.04 }));
    setTimeout(() => engine.hush?.(250), 720);
    engine.play('hit', { pan: 0.3, delay: 0.98 });
  },
  'Blitz (6 rolls)': () => {
    engine.play('diceShake', { duration: 0.1 });
    const gaps = [0.7, 0.45, 0.4, 0.36, 0.34, 0.7];
    let t = 0;
    gaps.forEach((g, k) => {
      t += g;
      engine.play('diceLand', { delay: t - 0.1, rate: Math.min(1.4, 1 + 0.08 * k) });
      engine.play('hit', { delay: t, pan: k % 2 ? 0.3 : -0.3, volume: k === gaps.length - 1 ? 1 : 0.5 });
    });
    engine.play('conquer', { delay: t + 0.35 });
    engine.play('march', { delay: t + 0.5, duration: 0.5 });
  },
  'You lose a territory': () => {
    engine.play('hit', { pan: 0.3 });
    engine.play('conquer', { delay: 0.34, variant: 'somber', pan: 0.2 });
    engine.play('march', { delay: 0.49, duration: 0.5 });
  },
  'Conquest + continent': () => {
    engine.play('hit', { pan: 0.3 });
    engine.play('conquer', { delay: 0.34 });
    engine.play('march', { delay: 0.49, duration: 0.5 });
    engine.play('continent', { delay: 1.25 });
  },
  'Continent broken': () => engine.play('continent', { variant: 'somber' }),
  'Draw an attack (stroke)': () => {
    demoStroke?.end(false);
    const h = engine.stroke?.({ pan: -0.2 });
    demoStroke = h ?? null;
    if (!h) return;
    let k = 0;
    const id = setInterval(() => {
      const u = k / 40;
      h.move(0.1 + 0.9 * Math.sin(Math.PI * Math.min(1, u * 1.1)), -0.2 + 0.4 * u);
      if (++k > 40) {
        clearInterval(id);
        h.end(true);
      }
    }, 16);
  },
  'Reinforce ×8': () => {
    for (let i = 0; i < 8; i++) engine.play('place', { delay: 0.2 + i * 0.16, rate: Math.min(1.15, 1 + 0.03 * i), pan: (i % 3) * 0.2 - 0.2 });
  },
  'AI drop wave (20)': () => {
    for (let i = 0; i < 20; i++) engine.play('place', { delay: i * 0.05, volume: 0.5, pan: Math.sin(i) * 0.5 });
  },
  'Elimination': () => {
    engine.stopAll();
    engine.play('eliminated', { delay: 0.15 });
  },
  'Victory': () => {
    engine.stopAll();
    engine.play('victory');
  },
  'New game (reseed score)': () => engine.setMusicSeed?.((Math.random() * 1e9) >>> 0),
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text) e.textContent = text;
  return e;
}

function build(): void {
  const app = document.getElementById('app')!;
  app.append(el('h1', {}, 'War Table · Sound'));
  app.append(el('div', { class: 'rule' }));
  app.append(
    el('p', { class: 'sub' }, 'Five materials: paper, brush, wood, bone, bowl. A soft score underneath. Everything is synthesized in the browser. Press a sound to hear it; Analyze renders each one offline and measures it.'),
  );

  // controls
  const controls = el('div', { class: 'panel controls' });
  const slider = (label: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, on: (v: number) => void) => {
    const l = el('label');
    l.append(label);
    const i = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
    const o = el('output', {}, fmt(value));
    i.addEventListener('input', () => {
      const v = Number(i.value);
      o.textContent = fmt(v);
      on(v);
    });
    l.append(i, o);
    controls.append(l);
    return i;
  };
  const opts: PlayOptions & { useDuration: boolean } = { useDuration: false };
  slider('Effects', 0, 1, 0.01, 0.8, (v) => v.toFixed(2), (v) => engine.setVolume(v));
  slider('Score', 0, 1, 0.01, 0.7, (v) => v.toFixed(2), (v) => engine.setMusicVolume(v));
  slider('Rate', 0.5, 2, 0.01, 1, (v) => v.toFixed(2), (v) => (opts.rate = v));
  slider('Pan', -1, 1, 0.05, 0, (v) => v.toFixed(2), (v) => (opts.pan = v));
  slider('Distance', 0, 1, 0.05, 0, (v) => (v === 0 ? 'table' : v.toFixed(2)), (v) => (opts.distance = v || undefined));
  slider('Duration', 0.06, 1.5, 0.01, 0.5, (v) => `${(v * 1000).toFixed(0)} ms`, (v) => {
    opts.duration = v;
    opts.useDuration = true;
  });
  const vl = el('label');
  vl.append('Variant');
  const vs = el('select');
  for (const v of ['', 'bright', 'somber', 'lift']) vs.append(el('option', { value: v }, v || 'default'));
  vs.addEventListener('change', () => (opts.variant = (vs.value || undefined) as SfxVariant | undefined));
  vl.append(vs);
  controls.append(vl);
  const mute = el('button', { class: 'pill' }, 'Mute');
  let muted = false;
  mute.addEventListener('click', () => {
    muted = !muted;
    engine.setMuted(muted);
    mute.classList.toggle('on', muted);
  });
  const music = el('button', { id: 'music', class: 'pill on' }, 'Score: on');
  let musicOn = true;
  music.addEventListener('click', () => {
    musicOn = !musicOn;
    engine.setMusic(musicOn);
    music.textContent = `Score: ${musicOn ? 'on' : 'off'}`;
    music.classList.toggle('on', musicOn);
  });
  controls.append(mute, music);
  app.append(controls);

  // sounds, by material
  const cards = new Map<SfxName, HTMLElement>();
  const mats = ['paper', 'brush', 'wood', 'bone', 'bowl'] as const;
  const blurb: Record<(typeof mats)[number], string> = {
    paper: 'turn breath, sheets, the Turn Track',
    brush: 'the stroke, the dab, the flood, the breath of smoke',
    wood: 'dice shaken in a lacquer cup',
    bone: 'dice landing in the tray',
    bowl: 'a struck rin: continent, elimination, victory',
  };
  for (const mat of mats) {
    const h = el('h2', {}, mat);
    h.append(el('span', {}, blurb[mat]));
    app.append(h);
    const grid = el('div', { class: 'grid' });
    for (const name of AUDIBLE.filter((n) => MATERIAL[n] === mat)) {
      const meta = SFX[name];
      const b = el('button', { class: 'sfx', 'data-sfx': name });
      b.append(el('b', {}, meta.label));
      b.append(el('small', {}, `${name} · ${meta.tier} ${TIER_TARGET_LUFS[meta.tier]} LUFS${meta.duration ? ' · follows motion' : ''}`));
      const m = el('small', { class: 'm' }, '');
      b.append(m);
      cards.set(name, m);
      b.addEventListener('click', () => {
        const o: PlayOptions = { rate: opts.rate, pan: opts.pan, variant: opts.variant, distance: opts.distance };
        if (opts.useDuration) o.duration = opts.duration;
        engine.play(name, o);
        void showOne(name, o);
      });
      grid.append(b);
    }
    app.append(grid);
  }

  const beats = el('h2', {}, 'game beats');
  beats.append(el('span', {}, 'timed like the board plays them'));
  app.append(beats);
  const row = el('div', { class: 'row' });
  for (const [label, fn] of Object.entries(scenarios)) {
    const b = el('button', { class: 'pill' }, label);
    b.addEventListener('click', fn);
    row.append(b);
  }
  app.append(row);

  // v4: the cues and the breathing score, so a human can audition them
  const cueH = el('h2', {}, 'v4 cues');
  cueH.append(el('span', {}, 'audio.cue(name): sheet, cup, bone, tick (Distance applies)'));
  app.append(cueH);
  const cueRow = el('div', { class: 'row' });
  const cueBtn = (label: string, fn: () => void) => {
    const b = el('button', { class: 'pill', 'data-cue': label }, label);
    b.addEventListener('click', fn);
    cueRow.append(b);
  };
  for (const c of V4_CUES) cueBtn(c, () => engine.cue?.(c, { pan: opts.pan, distance: opts.distance }));
  cueBtn('sheet · lift', () => engine.cue?.('sheet', { variant: 'lift', pan: opts.pan, distance: opts.distance }));
  app.append(cueRow);

  const brH = el('h2', {}, 'the score breathes');
  brH.append(el('span', {}, 'turnPassed · lean · idle (tempo never changes)'));
  app.append(brH);
  const brRow = el('div', { class: 'row' });
  const brBtn = (label: string, fn: (b: HTMLButtonElement) => void) => {
    const b = el('button', { class: 'pill', 'data-breath': label }, label);
    b.addEventListener('click', () => fn(b));
    brRow.append(b);
    return b;
  };
  brBtn('Turn passes → a human', () => {
    engine.cue?.('cupSlide', { duration: 0.4 });
    engine.turnPassed?.(true);
    engine.cue?.('cupSet', { delay: 0.4 });
    engine.play('turnStart', { variant: 'bright', delay: 0.65 });
  });
  brBtn('Turn passes → an AI', () => {
    engine.cue?.('cupSlide', { duration: 0.4, distance: 0.6 });
    engine.turnPassed?.(false);
    engine.cue?.('cupSet', { delay: 0.4, distance: 0.6 });
  });
  brBtn('AI fight (readable, distance 0.6)', () => {
    const d = 0.6;
    engine.play('whoosh', { duration: 0.5, distance: d, pan: 0.2 });
    engine.cue?.('bone', { delay: 0.75, distance: d, pan: 0.2 });
    engine.play('hit', { delay: 1.2, distance: d, pan: 0.2 });
    engine.play('conquer', { delay: 1.55, distance: d, pan: 0.2 });
    engine.play('march', { delay: 1.7, duration: 0.4, distance: d, pan: 0.2 });
  });
  brBtn('A human loses a continent (lean cold)', () => {
    engine.play('continent', { variant: 'somber', distance: 0.6 });
    engine.lean?.('cold');
  });
  let idleOn = false;
  brBtn('Idle: off', (b) => {
    idleOn = !idleOn;
    engine.setIdle?.(idleOn);
    b.textContent = `Idle: ${idleOn ? 'on' : 'off'}`;
    b.classList.toggle('on', idleOn);
  });
  app.append(brRow);

  app.append(el('h2', {}, 'selected sound'));
  const one = el('canvas', { id: 'one', width: '1180', height: '240' });
  one.style.aspectRatio = '1180 / 240';
  app.append(one);

  app.append(el('h2', {}, 'analysis'));
  const bar = el('div', { class: 'row' });
  const analyzeBtn = el('button', { class: 'pill gold', id: 'analyze' }, 'Analyze all');
  bar.append(analyzeBtn);
  app.append(bar);
  const status = el('div', { id: 'status' });
  app.append(status);
  const table = el('div', { class: 'panel', id: 'table' });
  table.style.display = 'none';
  app.append(table);
  const all = el('canvas', { id: 'all' });
  app.append(all);

  analyzeBtn.addEventListener('click', async () => {
    status.textContent = 'Rendering every sound offline, six seeds each…';
    const reports = await analyzeAll();
    renderTable(table, reports);
    for (const r of reports) cards.get(r.name)!.textContent = `${r.median.lk200.toFixed(1)} LUFS · pk ${r.peakMaxDb.toFixed(1)} · ${(r.median.durationSec * 1000).toFixed(0)} ms`;
    await drawAll(all);
    const bad = reports.filter((r) => r.failures.length);
    status.textContent = bad.length ? `${bad.length} sound(s) need attention.` : 'All sounds pass.';
  });

  setInterval(() => {
    const s = engine.stats();
    const live = document.getElementById('live');
    if (live) live.textContent = `context ${s.state} · voices ${s.voices} · played ${s.played} · dropped ${s.dropped} · score ${s.music ? 'playing' : s.musicWanted ? 'waiting for a tap' : 'off'} · seed ${s.musicSeed} · chord ${s.chord ?? '–'}${s.idle ? ' · idle' : ''}`;
  }, 250);
  const live = el('div', { id: 'live', class: 'sub' });
  app.insertBefore(live, controls.nextSibling);

  async function showOne(name: SfxName, o: PlayOptions) {
    const r = await renderSfx(name, { seed: (Math.random() * 1e6) | 0, rate: o.rate, duration: o.duration, variant: o.variant });
    const s = analyze(channelsOf(r.buffer), r.buffer.sampleRate);
    const g = one.getContext('2d')!;
    drawSound(g, 0, 0, one.width, one.height, monoOf(r.buffer), r.buffer.sampleRate, Math.max(0.3, s.durationSec + 0.05), `${name}${o.variant ? ' · ' + o.variant : ''}`, [
      `${s.lk200.toFixed(1)} LUFS (200 ms)`,
      `peak ${s.peakDb.toFixed(1)} dBFS`,
      `${(s.durationSec * 1000).toFixed(0)} ms`,
      `onset ${s.onsetMs.toFixed(1)} ms`,
      `centroid ${s.centroidHz.toFixed(0)} Hz`,
      `laptop band ${(s.laptopShare * 100).toFixed(0)}%`,
    ]);
  }
}

function renderTable(host: HTMLElement, reports: SoundReport[]): void {
  host.style.display = '';
  const cols = ['sound', 'material', 'tier', 'target', 'LK200', 'range', 'peak', 'dur ms', 'onset', 'rise ms', 'centroid', 'laptop %', '>8k %', 'trim', 'suggest', 'issues'];
  const t = el('table');
  const tr = el('tr');
  for (const c of cols) tr.append(el('th', {}, c));
  t.append(tr);
  for (const r of reports) {
    const m = r.median;
    const row = el('tr');
    const cells = [
      r.name,
      MATERIAL[r.name],
      r.tier,
      String(r.target),
      m.lk200.toFixed(1),
      `${r.lk200Min.toFixed(1)}…${r.lk200Max.toFixed(1)}`,
      r.peakMaxDb.toFixed(1),
      (m.durationSec * 1000).toFixed(0),
      m.onsetMs.toFixed(1),
      m.riseMs.toFixed(0),
      m.centroidHz.toFixed(0),
      (m.laptopShare * 100).toFixed(0),
      (m.hfShare * 100).toFixed(2),
      r.trimDb.toFixed(1),
      r.suggestedTrimDb.toFixed(1),
      r.failures.join('; ') || 'ok',
    ];
    cells.forEach((c, i) => {
      const td = el('td', {}, c);
      if (i === cells.length - 1 && r.failures.length) td.className = 'bad';
      row.append(td);
    });
    t.append(row);
  }
  host.replaceChildren(t);
}

build();

declare global {
  interface Window {
    __audioLab: unknown;
  }
}

const wavOf = (b: AudioBuffer, trim = false) => toBase64(encodeWav(trim ? trimmed(b) : channelsOf(b), b.sampleRate));

window.__audioLab = {
  engine,
  names: SFX_NAMES,
  audible: AUDIBLE,
  warmKeys: WARM_ORDER.length,
  limits: LIMITS,
  sampleRate: OFFLINE_SR,
  meta: Object.fromEntries(SFX_NAMES.map((n) => [n, { tier: SFX[n].tier, trimDb: SFX[n].trimDb, maxDur: SFX[n].maxDur, maxVoices: SFX[n].maxVoices, minGapMs: SFX[n].minGapMs, group: SFX[n].group, duration: SFX[n].duration, silent: !!SFX[n].silent, keyed: !!SFX[n].key, material: MATERIAL[n] }])),
  analyzeSound,
  analyzeAll,
  measure,
  composites,
  variants,
  bankCheck,
  liveCost,
  buildSweep,
  wavBase64,
  musicAnalysis,
  duckTest,
  strokeStats,
  roomCheck,
  keyLock,
  distanceCheck,
  breathCheck,
  scenes: SCENES,
  sceneWav,
  scenarios: Object.keys(scenarios),
  runScenario: (k: string) => scenarios[k]?.(),
  drawAll: (extra?: { label: string; name: SfxName; o: RenderOptions }[]) => drawAll(document.getElementById('all') as HTMLCanvasElement, extra),
  drawMusic: (s?: number) => drawMusic(document.getElementById('all') as HTMLCanvasElement, s),
  musicWav: async (seconds = 60, seed = 3) => wavOf(await renderMusic(seconds, seed)),
  rollWav: async () => wavOf(await renderDiceRoll(1), true),
  strokeWav: async (commit = true) => wavOf(await renderStroke(commit), true),
  momentWav: async () => {
    const m = await renderMoment();
    const canvas = document.getElementById('all') as HTMLCanvasElement;
    canvas.width = 1180;
    canvas.height = 300;
    canvas.style.aspectRatio = '1180 / 300';
    const g = canvas.getContext('2d')!;
    const secs = m.buffer.duration;
    drawSound(g, 0, 0, canvas.width, canvas.height, monoOf(m.buffer), m.buffer.sampleRate, secs, 'the moment · stroke, roll, beat, breath, snap, flood, settle', m.marks.filter((x) => !/diceLand/.test(x.what)).map((x) => `${x.t.toFixed(1)} ${x.what.split(' ')[0]}`));
    return { b64: wavOf(m.buffer), marks: m.marks, stats: analyze(channelsOf(m.buffer), m.buffer.sampleRate) };
  },
};
