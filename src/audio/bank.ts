// Sound bank: pre-rendered variations ("round robin"), so play() costs ~0.1 ms instead of running the
// synthesis on the main thread mid-animation (victory alone is ~35 ms of JS).
//
// After unlock, the engine warms every sound in the background, a few variations each, one render
// per idle slice. A play() that misses the bank synthesizes live (exactly as before) and asks the
// bank to cache that key. Buffers keep the channel layout the live graph would produce (mono stays
// mono) so a banked sound pans and measures identically to a live one.

import { SFX } from './sounds';
import type { Rand, SfxName, SfxVariant } from './types';

/** Variations kept per key. Rare, long cues keep fewer. */
function variationsFor(name: SfxName): number {
  // bowls are long (4–7 s of buffer each) and rare: keep memory small on phones
  if (name === 'victory' || name === 'eliminated') return 1;
  if (name === 'continent') return 2;
  if (name === 'turnStart' || name === 'cardTrade' || name === 'conquer' || name === 'sheet' || name === 'cupSlide' || name === 'cupSet') return 3;
  return 5;
}

/** Warm-up order: what the first minutes of a game need first. */
export const WARM_ORDER: { name: SfxName; variant?: SfxVariant }[] = [
  { name: 'uiClick' },
  { name: 'tick' },
  { name: 'place' },
  { name: 'unplace' },
  { name: 'cupSlide' },
  { name: 'cupSet' },
  { name: 'turnStart' },
  { name: 'turnStart', variant: 'bright' },
  { name: 'bone' },
  { name: 'sheet' },
  { name: 'sheet', variant: 'lift' },
  { name: 'diceShake' },
  { name: 'diceLand' },
  { name: 'hit' },
  { name: 'conquer' },
  { name: 'march' },
  { name: 'whoosh' },
  { name: 'uiError' },
  { name: 'cardDraw' },
  { name: 'cardTrade' },
  { name: 'conquer', variant: 'somber' },
  { name: 'continent' },
  { name: 'continent', variant: 'somber' },
  { name: 'eliminated' },
  { name: 'victory' },
];

const MAX_KEYS = 48;

export interface BankOptions {
  rand?: Rand;
  /** Background warm-up scheduling (live). Off for tests that await prepare() directly. */
  background?: boolean;
}

export class SoundBank {
  private readonly ctx: BaseAudioContext;
  private readonly rand: Rand;
  private readonly background: boolean;
  private readonly store = new Map<string, AudioBuffer[]>();
  private readonly last = new Map<string, number>();
  private readonly queue: { name: SfxName; variant?: SfxVariant; duration?: number }[] = [];
  private readonly queued = new Set<string>();
  private pumping = false;
  private disposed = false;

  constructor(ctx: BaseAudioContext, o: BankOptions = {}) {
    this.ctx = ctx;
    this.rand = o.rand ?? Math.random;
    this.background = o.background ?? true;
  }

  static key(name: SfxName, variant?: SfxVariant, duration?: number): string {
    return `${name}|${variant ?? ''}|${duration === undefined ? '' : Math.round(duration * 100)}`;
  }

  /** Motion-following durations are cached in 10 ms steps. */
  static quantize(duration?: number): number | undefined {
    return duration === undefined ? undefined : Math.round(duration * 100) / 100;
  }

  get size(): number {
    return this.store.size;
  }

  /** A cached variation (never the same one twice in a row), or null. */
  take(name: SfxName, variant?: SfxVariant, duration?: number): AudioBuffer | null {
    const k = SoundBank.key(name, variant, duration);
    const list = this.store.get(k);
    if (!list || !list.length) return null;
    let i = Math.floor(this.rand() * list.length);
    if (list.length > 1 && i === this.last.get(k)) i = (i + 1) % list.length;
    this.last.set(k, i);
    // LRU touch
    this.store.delete(k);
    this.store.set(k, list);
    return list[i];
  }

  /** Ask for a key to be cached in the background. */
  request(name: SfxName, variant?: SfxVariant, duration?: number): void {
    const k = SoundBank.key(name, variant, duration);
    if (this.store.has(k) || this.queued.has(k) || this.disposed) return;
    this.queued.add(k);
    this.queue.push({ name, variant, duration });
    if (this.background) this.pump();
  }

  warmAll(): void {
    for (const w of WARM_ORDER) if (!SFX[w.name].silent) this.request(w.name, w.variant, SFX[w.name].duration?.[2]);
  }

  /** Render and store the variations of a key now (awaitable; used by tests). */
  async prepare(name: SfxName, variant?: SfxVariant, duration?: number, count = variationsFor(name)): Promise<AudioBuffer[]> {
    const k = SoundBank.key(name, variant, duration);
    const out: AudioBuffer[] = [];
    for (let i = 0; i < count; i++) out.push(await this.renderOne(name, variant, duration));
    this.put(k, out);
    return out;
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
    this.store.clear();
  }

  // -------------------------------------------------------------------------

  private put(k: string, list: AudioBuffer[]): void {
    this.store.set(k, list);
    while (this.store.size > MAX_KEYS) {
      const oldest = this.store.keys().next().value as string;
      this.store.delete(oldest);
    }
  }

  private pump(): void {
    if (this.pumping || this.disposed) return;
    this.pumping = true;
    const idle = (cb: () => void) => {
      const w = typeof window !== 'undefined' ? (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }) : null;
      if (w?.requestIdleCallback) w.requestIdleCallback(cb, { timeout: 400 });
      else setTimeout(cb, 16);
    };
    const step = async () => {
      if (this.disposed) return;
      const job = this.queue.shift();
      if (!job) {
        this.pumping = false;
        return;
      }
      const k = SoundBank.key(job.name, job.variant, job.duration);
      try {
        const list: AudioBuffer[] = [];
        for (let i = 0; i < variationsFor(job.name); i++) {
          list.push(await this.renderOne(job.name, job.variant, job.duration));
          // yield between variations so a long cue never blocks more than one render
          await new Promise<void>((r) => idle(r));
          if (this.disposed) return;
        }
        this.put(k, list);
      } catch (err) {
        console.warn(`[audio] bank render ${k} failed`, err);
      } finally {
        this.queued.delete(k);
      }
      idle(() => void step());
    };
    idle(() => void step());
  }

  private async renderOne(name: SfxName, variant?: SfxVariant, duration?: number): Promise<AudioBuffer> {
    const meta = SFX[name];
    const sr = this.ctx.sampleRate;
    const extra = meta.duration && duration !== undefined ? Math.max(0, duration - meta.duration[2]) : 0;
    const len = Math.ceil((meta.maxDur + extra + 0.05) * sr);
    const octx = new OfflineAudioContext(2, len, sr);
    const dur = meta.fn(octx, octx.destination, 0, { rate: 1, rand: this.rand, duration, variant });
    const buf = await octx.startRendering();
    const n = Math.min(buf.length, Math.ceil((dur + 0.01) * sr));
    const L = buf.getChannelData(0);
    const R = buf.getChannelData(1);
    let mono = true;
    for (let i = 0; i < n; i++) {
      if (L[i] !== R[i]) {
        mono = false;
        break;
      }
    }
    const out = this.ctx.createBuffer(mono ? 1 : 2, n, sr);
    out.copyToChannel(L.subarray(0, n), 0);
    if (!mono) out.copyToChannel(R.subarray(0, n), 1);
    return out;
  }
}
