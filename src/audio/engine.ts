// createAudio(): the live engine the game uses.
//
// - The AudioContext is created lazily inside the first user gesture (no autoplay warnings), via
//   one-shot pointer/key listeners or an explicit unlock().
// - play() before unlock is a silent no-op; nothing is queued, nothing throws.
// - Settings made before unlock (volume, mute, music) are remembered and applied on unlock.
// - The ambient score is ON by default (INK A4). It stops scheduling while muted, at music volume 0,
//   or while the tab is hidden (the context is suspended then too, so phones spend nothing), and
//   comes back with a slow fade-in.

import { clamp } from './dsp';
import { LOOKAHEAD, Mixer } from './mixer';
import { SFX } from './sounds';
import { V4_CUES, type AudioEngine, type AudioStats, type CreateAudioOptions, type PlayOptions, type SfxName, type StrokeHandle, type V4Cue } from './types';

type AudioContextCtor = new (opts?: AudioContextOptions) => AudioContext;

const GESTURES = ['pointerdown', 'mousedown', 'touchend', 'keydown'] as const;

export function createAudio(options: CreateAudioOptions = {}): AudioEngine {
  const w = typeof window !== 'undefined' ? (window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor }) : null;
  const AC: AudioContextCtor | undefined = w ? w.AudioContext ?? w.webkitAudioContext : undefined;

  let ctx: AudioContext | null = null;
  let mixer: Mixer | null = null;
  let volume = clamp(options.volume ?? 0.8, 0, 1);
  let musicVolume = clamp(options.musicVolume ?? 0.7, 0, 1);
  let muted = !!options.muted;
  let musicWanted = options.music ?? true;
  let musicSeed = Number.isFinite(options.musicSeed) ? (options.musicSeed as number) >>> 0 : (Math.random() * 1e9) >>> 0;
  let hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  let suspendTimer: ReturnType<typeof setTimeout> | undefined;
  let resumeAskedAt = -Infinity;
  let disposed = false;
  let listening = false;

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  const onGesture = () => {
    unlock();
  };
  const listen = (on: boolean) => {
    if (!w || listening === on) return;
    listening = on;
    for (const e of GESTURES) {
      if (on) window.addEventListener(e, onGesture, { capture: true, passive: true });
      else window.removeEventListener(e, onGesture, { capture: true });
    }
  };
  if (AC && options.autoUnlock !== false) listen(true);

  const musicShould = () => musicWanted && !muted && !hidden && musicVolume > 0.001;
  // Each restart after mute / a hidden tab continues the game's piece somewhere new, never the same opening.
  let restarts = 0;
  const syncMusic = () => {
    if (!ctx || !mixer || ctx.state !== 'running') return;
    if (musicShould() && !mixer.musicOn) mixer.startMusic(ctx.currentTime + 0.05, { seed: (musicSeed + 7919 * restarts++) >>> 0 });
    else if (!musicShould() && mixer.musicOn) mixer.stopMusic();
  };

  // Hidden tab: fade out, stop the score, suspend the context. Visible again: resume and fade back in.
  const onVisibility = () => {
    hidden = document.visibilityState === 'hidden';
    if (!ctx || !mixer) return;
    try {
      if (hidden) {
        mixer.stopMusic(ctx.currentTime, 0.3);
        mixer.stopAll();
        if (suspendTimer) clearTimeout(suspendTimer);
        suspendTimer = setTimeout(() => {
          if (hidden && ctx && ctx.state === 'running') void ctx.suspend().catch(() => {});
        }, 450);
      } else {
        if (suspendTimer) clearTimeout(suspendTimer);
        if (ctx.state !== 'running' && ctx.state !== 'closed') {
          resumeAskedAt = now();
          ctx.resume().then(syncMusic, () => {});
        }
        syncMusic();
      }
    } catch (err) {
      console.warn('[audio] visibility change failed', err);
    }
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);

  function unlock(): void {
    if (disposed || !AC) return;
    try {
      if (!ctx) {
        ctx = new AC({ latencyHint: 'interactive' });
        mixer = new Mixer(ctx, ctx.destination, { limiter: true, live: true });
        if (idle) mixer.setIdle(true);
        mixer.sfxBus.gain.value = volume * volume;
        mixer.musicVol.gain.value = musicVolume * musicVolume;
        mixer.muteGain.gain.value = muted ? 0 : 1;
        mixer.bank?.warmAll();
        ctx.onstatechange = () => syncMusic();
      }
      if (!hidden && (ctx.state === 'suspended' || (ctx.state as string) === 'interrupted')) {
        resumeAskedAt = now();
        ctx.resume().then(syncMusic, () => {});
      }
      syncMusic();
    } catch (err) {
      console.warn('[audio] unlock failed', err);
    }
  }

  function play(name: SfxName, o: PlayOptions = {}): void {
    try {
      if (disposed || !ctx || !mixer) return;
      if (ctx.state !== 'running') {
        // Sounds requested in the same gesture that unlocked us play the moment resume() lands.
        // Anything later while suspended is dropped (never a late burst of queued sounds).
        if (!(ctx.state === 'suspended' && now() - resumeAskedAt < 500)) return;
      }
      const delay = clamp(Number.isFinite(o.delay) ? (o.delay as number) : 0, 0, 30);
      mixer.trigger(name, ctx.currentTime + LOOKAHEAD + delay, {
        volume: Number.isFinite(o.volume) ? o.volume : undefined,
        pan: Number.isFinite(o.pan) ? o.pan : undefined,
        rate: Number.isFinite(o.rate) ? o.rate : undefined,
        duration: Number.isFinite(o.duration) ? o.duration : undefined,
        variant: o.variant,
        distance: Number.isFinite(o.distance) ? o.distance : undefined,
      });
    } catch (err) {
      console.warn(`[audio] play(${String(name)}) failed`, err);
    }
  }

  // v4 (B3): idle is remembered before unlock and across music restarts
  let idle = false;

  return {
    unlock,
    play,
    cue(name: V4Cue, o?: PlayOptions) {
      // tolerant: unknown names are a silent no-op
      if (!V4_CUES.includes(name) || !SFX[name as SfxName]) return;
      play(name as SfxName, o);
    },
    turnPassed(toHuman: boolean) {
      try {
        if (!ctx || !mixer || ctx.state !== 'running') return;
        mixer.turnPassed(!!toHuman, ctx.currentTime + LOOKAHEAD);
      } catch (err) {
        console.warn('[audio] turnPassed failed', err);
      }
    },
    lean(colour: 'cold') {
      try {
        if (colour !== 'cold' || !ctx || !mixer || ctx.state !== 'running') return;
        mixer.lean(ctx.currentTime + LOOKAHEAD);
      } catch (err) {
        console.warn('[audio] lean failed', err);
      }
    },
    setIdle(on: boolean) {
      idle = !!on;
      try {
        if (!ctx || !mixer) return;
        mixer.setIdle(idle, ctx.currentTime + LOOKAHEAD);
      } catch (err) {
        console.warn('[audio] setIdle failed', err);
      }
    },
    setVolume(v: number) {
      if (!Number.isFinite(v)) return;
      volume = clamp(v, 0, 1);
      if (mixer) mixer.setVolume(volume);
    },
    setMuted(m: boolean) {
      muted = !!m;
      if (mixer) mixer.setMuted(muted);
      try {
        syncMusic();
      } catch (err) {
        console.warn('[audio] music failed', err);
      }
    },
    setMusic(on: boolean) {
      musicWanted = !!on;
      try {
        syncMusic();
      } catch (err) {
        console.warn('[audio] music failed', err);
      }
    },
    setMusicVolume(v: number) {
      if (!Number.isFinite(v)) return;
      musicVolume = clamp(v, 0, 1);
      if (mixer) mixer.setMusicVolume(musicVolume);
      try {
        syncMusic();
      } catch (err) {
        console.warn('[audio] music failed', err);
      }
    },
    setMusicSeed(seed: number) {
      if (!Number.isFinite(seed)) return;
      const s = Math.floor(seed) >>> 0;
      if (s === musicSeed) return;
      musicSeed = s;
      restarts = 1;
      try {
        if (ctx && mixer && ctx.state === 'running' && mixer.musicOn) mixer.reseedMusic(s);
      } catch (err) {
        console.warn('[audio] music reseed failed', err);
      }
    },
    hush(ms?: number) {
      try {
        if (!ctx || !mixer || ctx.state !== 'running') return;
        const sec = Number.isFinite(ms) ? (ms as number) / 1000 : undefined;
        mixer.hush(ctx.currentTime + LOOKAHEAD, sec);
      } catch {
        /* never throw */
      }
    },
    stroke(o?: { pan?: number }): StrokeHandle | null {
      try {
        if (!ctx || !mixer || ctx.state !== 'running') return null;
        return mixer.stroke({ pan: o?.pan });
      } catch (err) {
        console.warn('[audio] stroke failed', err);
        return null;
      }
    },
    stopAll() {
      try {
        mixer?.stopAll();
      } catch {
        /* never throw */
      }
    },
    isUnlocked() {
      return !!ctx && ctx.state !== 'closed';
    },
    stats(): AudioStats {
      const state: AudioStats['state'] = !AC ? 'unavailable' : !ctx ? 'locked' : (ctx.state as AudioStats['state']);
      return {
        state,
        voices: mixer ? mixer.voiceCount() : 0,
        voicesByName: mixer ? mixer.voicesByName() : {},
        played: mixer?.played ?? 0,
        dropped: mixer?.dropped ?? 0,
        stolen: mixer?.stolen ?? 0,
        music: mixer?.musicOn ?? false,
        banked: mixer?.bank?.size ?? 0,
        musicSeed,
        musicWanted,
        chord: mixer?.chordName(),
        idle,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listen(false);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
      if (suspendTimer) clearTimeout(suspendTimer);
      try {
        mixer?.stopMusic();
        mixer?.bank?.dispose();
        void ctx?.close();
      } catch {
        /* ignore */
      }
      ctx = null;
      mixer = null;
    },
  };
}
