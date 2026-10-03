// Public audio types. `SfxName`, `AudioEngine` and `createAudio()` match docs/SPEC.md §8;
// everything marked "extra" is additive.

export type SfxName =
  | 'uiClick'
  | 'uiHover'
  | 'uiError'
  | 'place'
  | 'unplace'
  | 'diceShake'
  | 'diceLand'
  | 'hit'
  | 'conquer'
  | 'march'
  | 'cardDraw'
  | 'cardTrade'
  | 'continent'
  | 'eliminated'
  | 'victory'
  | 'turnStart'
  | 'whoosh';

export const SFX_NAMES: readonly SfxName[] = [
  'uiClick',
  'uiHover',
  'uiError',
  'place',
  'unplace',
  'diceShake',
  'diceLand',
  'hit',
  'conquer',
  'march',
  'cardDraw',
  'cardTrade',
  'continent',
  'eliminated',
  'victory',
  'turnStart',
  'whoosh',
];

/**
 * v4 cues (PLAN §4, §7) added as a tolerant string API so callers compile before the bank has them: the
 * audio builder maps each to a real recipe; unknown = silent no-op.
 *   sheet     a sheet of paper laid on / lifted off the table (overlays open and close)
 *   cupSlide  the cup slides along the seat strip (turn passes)
 *   cupSet    the cup set down at the next seat (every seat; a human's gets turnStart on top)
 *   bone      one short bone click: the AI's roll in 'readable' style (never the dice show)
 *   tick      a paper tick: tap a territory, the deal's flips, the round numeral re-inking
 */
export type V4Cue = 'sheet' | 'cupSlide' | 'cupSet' | 'bone' | 'tick';

export interface PlayOptions {
  /** Per-play gain, 0..2 (1 = designed level). */
  volume?: number;
  /**
   * v4 (PLAN §3 A2 "distance, not silence"): 0 = at the table (dry, full), 1 = far across the room (longer
   * hall send, −4 dB, softened top). AI events pass ≈ 0.6 instead of volume 0.5. The engine ignores it
   * until the audio builder wires the shared hall (B1).
   */
  distance?: number;
  /** Stereo position, -1 (left) .. 1 (right). */
  pan?: number;
  /** Playback rate, 0.5..2: scales pitch and timing together (tape-style). */
  rate?: number;
  /** extra: start this many seconds from now (sample-accurate, cancelled by stopAll). */
  delay?: number;
  /**
   * extra: length in seconds for sounds that follow a motion, without changing pitch
   * (diceShake = the shake, march = lift-off to landing, whoosh = the camera move). Others ignore it.
   */
  duration?: number;
  /**
   * extra: 'bright' = turnStart after one or more AI turns (the sheet lifts higher).
   * 'somber' = a human lost it. conquer · somber is the A5 sting (a dry brush snap, then a rougher,
   * darker flood): play it whenever the previous owner is human. continent · somber = the bowl is
   * hand-damped (your continent was broken).
   */
  variant?: SfxVariant;
}

export type SfxVariant = 'bright' | 'somber';

export interface AudioStats {
  /** 'locked' until the first user gesture creates/resumes the context. */
  state: 'locked' | 'suspended' | 'running' | 'closed' | 'unavailable';
  voices: number;
  voicesByName: Partial<Record<SfxName, number>>;
  played: number;
  dropped: number;
  stolen: number;
  music: boolean;
  /** Keys held in the pre-rendered sound bank (warms up in the background after unlock). */
  banked: number;
  /** extra: the score's seed (per game) and whether the player wants it on (it pauses while muted/hidden). */
  musicSeed?: number;
  musicWanted?: boolean;
}

/** extra: a live brush stroke the pointer drives (INK A2: draw your attack). */
export interface StrokeHandle {
  /**
   * Pointer speed, normalised: 0 = resting on the paper, 1 = a quick sure stroke (about one board
   * width per second). Call on pointermove; it is smoothed. Optional pan −1..1 follows the tip.
   */
  move(speed: number, pan?: number): void;
  /** commit = the stroke armed an attack (it settles into the arrow); false = it dries out in 200 ms. */
  end(commit: boolean): void;
}

export interface AudioEngine {
  /** Create/resume the AudioContext. Call from a user gesture (also done automatically on the first gesture). */
  unlock(): void;
  /** Fire-and-forget. Safe before unlock (no-op) and never throws. */
  play(name: SfxName, opts?: PlayOptions): void;
  /** 0..1 master for SFX (perceptual curve). */
  setVolume(v: number): void;
  /** Mutes SFX and music (the score stops scheduling while muted, and resumes on unmute). */
  setMuted(m: boolean): void;
  /** Ambient score on/off. Remembered if called before unlock. Default ON (INK A4). */
  setMusic(on: boolean): void;

  /** extra: 0..1 music level (default 0.7 ≈ the score sits at ~35% of the effects level). 0 stops it. */
  setMusicVolume(v: number): void;
  /**
   * extra (ink): seed the generative score for this game (e.g. from the game seed). A new seed while
   * the score plays crossfades to the new piece over ~3 s. Same seed = no-op.
   */
  setMusicSeed?(seed: number): void;
  /**
   * extra (ink): the verdict beat. Nothing new sounds for `ms` (default 250) and the score dips, then
   * recovers over 2–3 s. Call as the dice settle; the verdict cue ('hit') plays after it ends.
   */
  hush?(ms?: number): void;
  /**
   * extra (ink): start a live brush stroke that follows the pointer (drag-to-attack). One at a time;
   * starting a new one dries out the old. Null before unlock. Silent when the stroke isn't moving.
   */
  stroke?(o?: { pan?: number }): StrokeHandle | null;
  /** extra: fade out every playing/scheduled SFX voice (use with skipAnimations). Music is untouched. */
  stopAll(): void;
  /** v4: play a V4Cue (see the type). Absent on older engines; callers use `audio.cue?.(…)`. */
  cue?(name: V4Cue, opts?: PlayOptions): void;
  /**
   * v4 (PLAN §4 B3 "the score breathes"): the turn passed. The score takes its next chord change now (the
   * walk keeps its weights; only the moment moves). `toHuman` adds the +2 dB swell over 2 s.
   */
  turnPassed?(toHuman: boolean): void;
  /**
   * v4 (B3): a human lost a continent or a seat was eliminated: bias the walk to the open/minor voicings for
   * one chord, then return. 'cold' is the only colour for now.
   */
  lean?(colour: 'cold'): void;
  /** v4 (B3, §7.14): idle. true = the score thins to pad only over ~4 s; false = back over ~2 s. */
  setIdle?(on: boolean): void;
  /** extra: true once the AudioContext exists and has been asked to run. */
  isUnlocked(): boolean;
  /** extra: counters for debugging / tests. */
  stats(): AudioStats;
  /** extra: close the context and remove listeners. */
  dispose(): void;
}

export interface CreateAudioOptions {
  volume?: number;
  muted?: boolean;
  /** Default true (INK A4: a soft score always underneath). */
  music?: boolean;
  musicVolume?: number;
  /** Score seed (default random). */
  musicSeed?: number;
  /** Install one-shot pointer/key listeners that call unlock(). Default true. */
  autoUnlock?: boolean;
}

// ---------------------------------------------------------------------------
// Internal: how a sound is described
// ---------------------------------------------------------------------------

export type Rand = () => number;

export interface VoiceOpts {
  /** Tape-style rate, already clamped to 0.5..2. */
  rate: number;
  /** Uniform [0,1). Seeded in offline renders, Math.random live. */
  rand: Rand;
  /** Motion length in seconds (see PlayOptions.duration), already clamped. */
  duration?: number;
  variant?: SfxVariant;
}

/**
 * Builds one sound into `dest`, starting at context time `t`.
 * Returns how long (seconds after t) until it is silent, excluding the shared room tail.
 */
export type SoundFn = (ctx: BaseAudioContext, dest: AudioNode, t: number, opts: VoiceOpts) => number;

/**
 * Loudness tiers, following the stakes ladder (routine stays quiet so swings feel big).
 * Targets are short-term (200 ms window, K-weighted) peak loudness in LUFS at volume 1.
 * Ink bank, five materials (paper · brush · wood · bone · bowl):
 *  micro  uiHover (silent: no hover sounds)
 *  ui     uiClick, uiError (paper), whoosh (brush)
 *  die    one diceLand (bone; a 5-die roll sums to about board level)
 *  board  place, unplace, march, hit (brush), diceShake (wood), cardDraw, turnStart (paper)
 *  cue    conquer (brush flood; somber = the snap), cardTrade (paper)
 *  swing  continent (bowl A4)
 *  drama  eliminated (bowl D3, hard onset)
 *  finale victory (bowl D5)
 */
export type LoudnessTier = 'micro' | 'ui' | 'die' | 'board' | 'cue' | 'swing' | 'drama' | 'finale';

export const TIER_TARGET_LUFS: Record<LoudnessTier, number> = {
  micro: -45,
  ui: -27,
  die: -27,
  board: -22,
  cue: -21,
  swing: -19,
  drama: -18,
  finale: -17,
};

export interface SfxMeta {
  fn: SoundFn;
  label: string;
  group: 'UI' | 'Board' | 'Battle' | 'Cards' | 'Stingers';
  tier: LoudnessTier;
  /** Loudness-normalisation trim, measured offline (see lab "Analyze"). */
  trimDb: number;
  /** Room reverb send, linear. */
  wet: number;
  /** Upper bound on SoundFn's returned duration at rate 1 (offline render length). */
  maxDur: number;
  /** Concurrent voices of this sound before the oldest is stolen. */
  maxVoices: number;
  /** Retriggers closer than this are dropped. */
  minGapMs: number;
  /** Global voice stealing takes the lowest priority first. */
  priority: number;
  /** Duck the music bed by this many dB while the sound plays. */
  duckDb?: number;
  /** Each already-playing voice of this sound lowers a new one by this many dB (density control). */
  densityDb?: number;
  /** Cap for the density attenuation, dB. */
  densityMaxDb?: number;
  /** Clamp range for PlayOptions.duration, seconds [min, max, default]. Absent = not motion-following. */
  duration?: [number, number, number];
  /** Pitched in D with the music bed: banked playback never adds pitch jitter. */
  musical?: boolean;
  /** extra (ink): never sounds (uiHover: no hover sounds). play() is a silent no-op. */
  silent?: boolean;
  /**
   * extra (ink): part of one texture (the dice landing), so exempt from the global "≤ 1 cue per 70 ms"
   * spacing. Its own minGapMs and density still apply.
   */
  texture?: boolean;
}
