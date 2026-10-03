// Offline measurement: the team's ears. Pure functions over channel data (no WebAudio needed).
//
// Loudness uses ITU-R BS.1770 K-weighting (high-shelf + RLB high-pass) with a sliding window.
// `lk200` (200 ms window, close to the ear's temporal integration) is what we normalise on; `lufsM`
// is the standard 400 ms momentary loudness for reference.

export interface SoundStats {
  sampleRate: number;
  renderSec: number;
  /** Time until the signal last exceeds −60 dBFS. */
  durationSec: number;
  /** First sample above peak − 40 dB, ms. */
  onsetMs: number;
  /** Onset → peak sample, ms. */
  attackMs: number;
  /** v4 (B4): onset (−40 dB) → the 1 ms RMS envelope's first arrival within 0.5 dB of its maximum, ms. */
  riseMs: number;
  peakDb: number;
  /** RMS over onset..duration. */
  rmsDb: number;
  /** Max 200 ms K-weighted loudness, LUFS. */
  lk200: number;
  /** Max 400 ms (momentary) K-weighted loudness, LUFS. */
  lufsM: number;
  /** lk200 as heard through laptop speakers (2nd-order high-pass at 180 Hz before K-weighting). */
  lkLaptop: number;
  crestDb: number;
  /** Largest |mean| of any channel over the active region. */
  dc: number;
  clipped: number;
  nan: number;
  /** |x[0]| — must be ~0 (no click at the start). */
  startAbs: number;
  /** RMS of the last 10 ms of the render, dBFS — must be silent (the tail finished). */
  endDb: number;
  centroidHz: number;
  /** Energy share < 40 Hz (sub rumble; should be tiny). */
  subShare: number;
  /** Energy share 150 Hz – 5 kHz (what laptop speakers reproduce). */
  laptopShare: number;
  /** Energy share 2.5–5 kHz (harshness band). */
  harshShare: number;
  /** Energy share > 8 kHz (fizz / sibilance). */
  hfShare: number;
}

const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** BS.1770 K-weighting at any sample rate (libebur128 formulation). */
export function kWeightingFilters(fs: number): [Biquad, Biquad] {
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / fs);
  a0 = 1 + K / Q + K * K;
  const hp: Biquad = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [shelf, hp];
}

function runBiquad(x: Float32Array | Float64Array, f: Biquad): Float64Array {
  const y = new Float64Array(x.length);
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = f.b0 * x0 + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    y[i] = y0;
  }
  return y;
}

/** RBJ high-pass, used to approximate small laptop/TV speakers (little below ~180 Hz). */
export function speakerHighpass(fs: number, f = 180, q = 0.707): Biquad {
  const w0 = (2 * Math.PI * f) / fs;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return { b0: (1 + cw) / 2 / a0, b1: -(1 + cw) / a0, b2: (1 + cw) / 2 / a0, a1: (-2 * cw) / a0, a2: (1 - alpha) / a0 };
}

/** Max windowed K-weighted loudness (LUFS) for a window length in seconds. */
export function maxWindowLoudness(channels: Float32Array[], sr: number, windowSec: number, hopSec = 0.01, laptop = false): number {
  const [shelf, hp] = kWeightingFilters(sr);
  const spk = speakerHighpass(sr);
  const n = channels[0].length;
  const prefix = new Float64Array(n + 1);
  for (const ch of channels) {
    const src = laptop ? runBiquad(ch, spk) : ch;
    const z = runBiquad(runBiquad(src, shelf), hp);
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += z[i] * z[i];
      prefix[i + 1] += acc;
    }
  }
  const W = Math.max(1, Math.round(windowSec * sr));
  const H = Math.max(1, Math.round(hopSec * sr));
  let best = 0;
  for (let s = 0; s + W <= n || s === 0; s += H) {
    const e = Math.min(n, s + W);
    const ms = (prefix[e] - prefix[s]) / W;
    if (ms > best) best = ms;
    if (e === n) break;
  }
  return best > 0 ? -0.691 + 10 * Math.log10(best) : -Infinity;
}

// ---------------------------------------------------------------------------
// FFT (radix-2, in place)
// ---------------------------------------------------------------------------

export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang),
      wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1,
        ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k,
          b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** Averaged power spectrum (Hann, 2048, hop 1024) of a mono signal over [from, to). */
export function powerSpectrum(x: Float32Array, from: number, to: number, N = 2048): Float64Array {
  const P = new Float64Array(N / 2);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let s = from; s < Math.max(from + 1, to); s += N / 2) {
    for (let i = 0; i < N; i++) {
      const k = s + i;
      re[i] = k < x.length ? x[k] * win[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < N / 2; k++) P[k] += re[k] * re[k] + im[k] * im[k];
  }
  return P;
}

// ---------------------------------------------------------------------------

export function analyze(channels: Float32Array[], sr: number): SoundStats {
  const n = channels[0].length;
  let peak = 0,
    nan = 0,
    clipped = 0,
    peakIdx = 0;
  for (const ch of channels) {
    for (let i = 0; i < n; i++) {
      const v = ch[i];
      if (!Number.isFinite(v)) {
        nan++;
        continue;
      }
      const a = Math.abs(v);
      if (a > peak) {
        peak = a;
        peakIdx = i;
      }
      if (a >= 0.999) clipped++;
    }
  }
  const onsetThr = peak * Math.pow(10, -40 / 20);
  const endThr = Math.pow(10, -60 / 20);
  let onset = n,
    last = 0;
  for (const ch of channels) {
    for (let i = 0; i < n; i++) {
      const a = Math.abs(ch[i]);
      if (a > onsetThr && i < onset) onset = i;
      if (a > endThr) last = Math.max(last, i);
    }
  }
  if (onset === n) onset = 0;
  const from = onset;
  const to = Math.max(from + 1, last + 1);

  let e = 0;
  let dc = 0;
  for (const ch of channels) {
    let sum = 0;
    for (let i = from; i < to; i++) {
      e += ch[i] * ch[i];
      sum += ch[i];
    }
    dc = Math.max(dc, Math.abs(sum / (to - from)));
  }
  const rms = Math.sqrt(e / ((to - from) * channels.length));

  const tail = Math.max(1, Math.round(0.01 * sr));
  let te = 0;
  for (const ch of channels) for (let i = n - tail; i < n; i++) te += ch[i] * ch[i];
  const endRms = Math.sqrt(te / (tail * channels.length));

  // spectrum of the mono mix over the active region
  const mono = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) mono[i] += ch[i] / channels.length;
  const N = 2048;
  const P = powerSpectrum(mono, from, to, N);
  let tot = 0,
    wsum = 0,
    sub = 0,
    lap = 0,
    harsh = 0,
    hf = 0;
  for (let k = 1; k < N / 2; k++) {
    const f = (k * sr) / N;
    const p = P[k];
    tot += p;
    wsum += f * p;
    if (f < 40) sub += p;
    if (f >= 150 && f <= 5000) lap += p;
    if (f >= 2500 && f <= 5000) harsh += p;
    if (f > 8000) hf += p;
  }
  tot = tot || 1;

  const lk200 = maxWindowLoudness(channels, sr, 0.2);
  // rise: 1 ms RMS envelope of the mono mix
  const W1 = Math.max(1, Math.round(0.001 * sr));
  const envs: number[] = [];
  for (let s0 = 0; s0 + W1 <= n; s0 += W1) {
    let e1 = 0;
    for (let i = s0; i < s0 + W1; i++) e1 += mono[i] * mono[i];
    envs.push(Math.sqrt(e1 / W1));
  }
  let envMax = 0;
  for (const v of envs) envMax = Math.max(envMax, v);
  let riseIdx = 0;
  let envOn = -1;
  for (let k = 0; k < envs.length; k++) {
    if (envOn < 0 && envs[k] > envMax * 0.01) envOn = k;
    if (envs[k] >= envMax * 0.944) {
      riseIdx = k;
      break;
    }
  }
  const riseMs = Math.max(0, riseIdx - Math.max(0, envOn)) * (W1 / sr) * 1000;
  return {
    sampleRate: sr,
    renderSec: n / sr,
    durationSec: (last + 1) / sr,
    onsetMs: (onset / sr) * 1000,
    attackMs: (Math.max(0, peakIdx - onset) / sr) * 1000,
    riseMs,
    peakDb: db(peak),
    rmsDb: db(rms),
    lk200,
    lufsM: maxWindowLoudness(channels, sr, 0.4),
    lkLaptop: maxWindowLoudness(channels, sr, 0.2, 0.01, true),
    crestDb: db(peak) - db(rms),
    dc,
    clipped,
    nan,
    startAbs: Math.max(...channels.map((c) => Math.abs(c[0]))),
    endDb: db(endRms),
    centroidHz: wsum / tot,
    subShare: sub / tot,
    laptopShare: lap / tot,
    harshShare: harsh / tot,
    hfShare: hf / tot,
  };
}

/**
 * v4 (B1): reverberation time from a decaying tail (Schroeder backward integration). Fits the energy
 * decay curve between −5 and −25 dB below its start (T20) and extrapolates to 60 dB. `from` is where
 * the tail starts (after the dry sound), seconds.
 */
export function rt60(channels: Float32Array[], sr: number, from = 0): { rt60: number; fitR2: number } {
  const n = channels[0].length;
  const s0 = Math.min(n - 1, Math.round(from * sr));
  const e = new Float64Array(n - s0);
  for (const ch of channels) for (let i = s0; i < n; i++) e[i - s0] += ch[i] * ch[i];
  // backward integral
  const edc = new Float64Array(e.length);
  let acc = 0;
  for (let i = e.length - 1; i >= 0; i--) {
    acc += e[i];
    edc[i] = acc;
  }
  const top = edc[0] || 1e-30;
  const xs: number[] = [];
  const ys: number[] = [];
  const step = Math.max(1, Math.round(sr * 0.005));
  for (let i = 0; i < edc.length; i += step) {
    const db = 10 * Math.log10(edc[i] / top + 1e-30);
    if (db <= -5 && db >= -25) {
      xs.push(i / sr);
      ys.push(db);
    }
    if (db < -25) break;
  }
  if (xs.length < 3) return { rt60: NaN, fitR2: 0 };
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0,
    sxx = 0,
    syy = 0;
  for (let k = 0; k < xs.length; k++) {
    sxy += (xs[k] - mx) * (ys[k] - my);
    sxx += (xs[k] - mx) ** 2;
    syy += (ys[k] - my) ** 2;
  }
  const slope = sxy / sxx; // dB per second (negative)
  return { rt60: -60 / slope, fitR2: (sxy * sxy) / (sxx * syy) };
}

/**
 * v4 (B2): the strongest pitch within ±`semis` semitones of `fExpected` over [from, to) seconds, found
 * by a Hann-windowed DFT scanned in 1-cent steps. Returns the frequency and its offset in cents.
 */
export function pitchNear(x: Float32Array, sr: number, from: number, to: number, fExpected: number, semis = 3): { hz: number; cents: number } {
  const a = Math.max(0, Math.round(from * sr));
  const b = Math.min(x.length, Math.round(to * sr));
  const N = b - a;
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = x[a + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  let best = -1;
  let bestC = 0;
  const mag = (f: number) => {
    const w = (2 * Math.PI * f) / sr;
    // Goertzel
    const c = 2 * Math.cos(w);
    let s1 = 0,
      s2 = 0;
    for (let i = 0; i < N; i++) {
      const s = win[i] + c * s1 - s2;
      s2 = s1;
      s1 = s;
    }
    return s1 * s1 + s2 * s2 - c * s1 * s2;
  };
  // coarse 10-cent scan, then 1-cent refine
  for (let cts = -semis * 100; cts <= semis * 100; cts += 10) {
    const m = mag(fExpected * Math.pow(2, cts / 1200));
    if (m > best) {
      best = m;
      bestC = cts;
    }
  }
  const c0 = bestC;
  for (let cts = c0 - 10; cts <= c0 + 10; cts += 1) {
    const m = mag(fExpected * Math.pow(2, cts / 1200));
    if (m > best) {
      best = m;
      bestC = cts;
    }
  }
  return { hz: fExpected * Math.pow(2, bestC / 1200), cents: bestC };
}

/** 16-bit PCM WAV. */
export function encodeWav(channels: Float32Array[], sr: number): ArrayBuffer {
  const nch = channels.length;
  const n = channels[0].length;
  const buf = new ArrayBuffer(44 + n * nch * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * nch * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, nch, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * nch * 2, true);
  v.setUint16(32, nch * 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * nch * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return buf;
}

/**
 * Loudness of a long render: BS.1770 K-weighted, 400 ms blocks with 75% overlap, absolute gate at
 * −70 LUFS and the relative gate at −10 LU (integrated loudness, LUFS-I). Also returns the median
 * 3 s short-term loudness, which is how "the score's level" is felt.
 */
export function longLoudness(channels: Float32Array[], sr: number): { integrated: number; shortTermMedian: number } {
  const [shelf, hp] = kWeightingFilters(sr);
  const weighted = channels.map((c) => runBiquad(runBiquad(c, shelf), hp));
  const blockEnergy = (from: number, len: number) => {
    let e = 0;
    for (const w of weighted) for (let i = from; i < from + len; i++) e += w[i] * w[i];
    return e / len;
  };
  const lufs = (e: number) => -0.691 + 10 * Math.log10(e + 1e-20);
  const B = Math.round(0.4 * sr);
  const hop = Math.round(0.1 * sr);
  const blocks: number[] = [];
  for (let s = 0; s + B <= weighted[0].length; s += hop) blocks.push(blockEnergy(s, B));
  const abs = blocks.filter((e) => lufs(e) > -70);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const rel = lufs(mean(abs)) - 10;
  const gated = abs.filter((e) => lufs(e) > rel);
  const S = Math.round(3 * sr);
  const st: number[] = [];
  for (let s = 0; s + S <= weighted[0].length; s += sr) st.push(lufs(blockEnergy(s, S)));
  st.sort((a, b) => a - b);
  return { integrated: lufs(mean(gated)), shortTermMedian: st.length ? st[Math.floor(st.length / 2)] : -Infinity };
}
