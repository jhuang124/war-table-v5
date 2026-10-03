// Audio verification (node + Playwright): `npx tsx src/audio/verify.ts` (npm run verify:audio)
//
// Opens audio.html, then:
//  1. live engine: play() before unlock is a no-op; a real click unlocks; the score is on by default;
//     every audible sound plays; hover is silent; spam is voice-limited; the silence rules hold
//     (≤ 1 cue per 70 ms, nothing inside the verdict beat); mute / hidden stop the score; no console errors.
//  2. offline: renders every sound (6 seeds) in an OfflineAudioContext inside the page and checks
//     NaN / silence / peak ≤ −1 dBFS / loudness on target / DC / clicks / tails / spectrum.
//  3. composites: a 5-die roll, a blitz storm through the limiter, limiter transparency, the live
//     brush stroke, and the score: 60 s render for level, density (events/min), loop-free variation,
//     and the duck under a conquest.
//  4. writes artifacts/audio/ink/{report.json, spectrograms.png, score.png, lab.png, *.wav} for John.
//  5. v4 (PLAN §4): one room (diceLand's tail RT60 vs the score's hall ±20 %), key-lock (every pitched
//     effect over every chord lands on the role's chord tone, rendered pitch ±25 c), the attack rule
//     (≥ 15 ms fade-in except the sharp family), distance (A2), the breathing score (turnPassed moves
//     the change, lean is cold, +2 dB swell, idle thins), the tier balance, and listening excerpts in
//     artifacts/audio/v4/*.wav.
//  6. v5 (PROPOSAL §4 A, B, D, F): the dice pour (5 dice 60 and 90 ms apart all land and are heard, live
//     and offline; the 70 ms rule never eats them, nor the verdict's same-frame pairs and splashes), the
//     three bone timbres, the pair tick's level, the new cues' tiers / attacks / key-lock (glint, pour,
//     hit · pair on the chord), fightCold (−2 dB top, room tone thins, back in ~1 s), setEvening (same
//     times and lengths, lower and darker, idle still thins), and excerpts in artifacts/audio/v5/*.wav.
// Exit code 1 on any failure. Uses an existing server on :5363 or starts its own (no HMR).

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.AUDIO_PORT ?? 5363);
const URL = `http://127.0.0.1:${PORT}/audio.html`;
const OUT = join(ROOT, 'artifacts/audio/ink');
const V4 = join(ROOT, 'artifacts/audio/v4');
const V5 = join(ROOT, 'artifacts/audio/v5');
const WAV = join(OUT, 'sfx');
const TMP = join(ROOT, 'artifacts/tmp/audio');

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

async function up(): Promise<boolean> {
  try {
    const r = await fetch(URL);
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureServer(): Promise<ChildProcess | null> {
  if (await up()) return null;
  const child = spawn('npx', ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT,
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, RISK_E2E: '1' },
  });
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await up()) return child;
  }
  throw new Error(`dev server did not come up on ${PORT}`);
}

const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : String(x));
/** v5: the tick tier (the pair tick's own level). */
const TICK_TIER = -30;
/** v5: chord names and roots (pitch class) for the fifth check; 'no score (Dm)' falls back to D. */
const CHORD_NAMES = ['Dm9', 'Fmaj7', 'Bbmaj7', 'Csus2', 'Gm9', 'Am7', 'Dsus4', 'no score (Dm)'];
const CHORD_ROOTS = [2, 5, 10, 0, 7, 9, 2];

async function main() {
  mkdirSync(WAV, { recursive: true });
  mkdirSync(V4, { recursive: true });
  mkdirSync(V5, { recursive: true });
  mkdirSync(TMP, { recursive: true });
  const server = await ensureServer();
  const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio'] });
  const failures: string[] = [];
  const consoleProblems: string[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    // tsx keeps function names with a __name() helper that doesn't exist inside the page
    await page.addInitScript('window.__name = (f) => f;');
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') consoleProblems.push(`${m.type()}: ${m.text()}`);
    });
    page.on('pageerror', (e) => consoleProblems.push(`pageerror: ${e.message}`));
    page.on('response', (r) => {
      if (r.status() >= 400) consoleProblems.push(`http: ${r.status()} ${r.url()}`);
    });
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!(window as Any).__audioLab);
    await page.waitForTimeout(500);

    // ---------------------------------------------------------------- live
    const before = await page.evaluate(() => {
      const lab = (window as Any).__audioLab;
      let threw = false;
      const wantedByDefault = lab.engine.stats().musicWanted;
      try {
        for (const n of lab.names) lab.engine.play(n);
        lab.engine.play('nope' as Any);
        lab.engine.setVolume(NaN);
        lab.engine.hush?.(250);
        lab.engine.stroke?.();
        lab.engine.setMusicSeed?.(NaN);
        lab.engine.cue?.('cupSet');
        lab.engine.cue?.('nope' as Any);
        lab.engine.turnPassed?.(true);
        lab.engine.lean?.('cold');
        lab.engine.setIdle?.(false);
        lab.engine.play('place', { distance: NaN });
        lab.engine.fightCold?.(false);
        lab.engine.setEvening?.(0);
        lab.engine.cue?.('rattle');
      } catch {
        threw = true;
      }
      return { threw, stats: lab.engine.stats(), wantedByDefault };
    });
    if (before.threw) failures.push('live: play() before unlock threw');
    if (!before.wantedByDefault) failures.push('live: the score is not on by default');
    if (before.stats.state !== 'locked') failures.push(`live: expected locked before gesture, got ${before.stats.state}`);
    if (before.stats.played !== 0) failures.push('live: sounds played before unlock');

    // Watch for long main-thread tasks while the bank warms up (they'd be dropped frames on the title).
    // The task containing the unlock click is excluded: Chrome spends ~120 ms opening the audio device
    // for the page's first AudioContext (measured on a blank page too); our own unlock() is ~14 ms.
    // A long task only fails when our own script made it long: Long Animation Frame attribution
    // names the scripts, so a long frame commit right after that stall (native, the lab's big page)
    // is reported but does not count against the audio.
    // (a string, so the bundler's __name helpers never leak into the page)
    await page.evaluate(`(() => {
      const w = window;
      w.__longTasks = [];
      window.addEventListener('pointerdown', () => { if (w.__clickAt === undefined) w.__clickAt = performance.now(); }, { capture: true });
      try {
        new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__longTasks.push([e.startTime, e.duration]); }).observe({ entryTypes: ['longtask'] });
      } catch (e) {}
      w.__longScripts = [];
      try {
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) for (const s of e.scripts || []) if (s.duration >= 50) w.__longScripts.push([s.startTime, s.duration, (s.invoker || '') + ' ' + (s.sourceFunctionName || '')]);
        }).observe({ type: 'long-animation-frame' });
      } catch (e) {}
      // keep frames flowing like the real game (idle callbacks are scheduled between frames)
      w.__rafLoop = () => requestAnimationFrame(w.__rafLoop);
      w.__rafLoop();
    })()`);
    await page.mouse.click(20, 20); // a real, trusted gesture
    const unlockAt = Date.now();
    await page.waitForFunction(() => (window as Any).__audioLab.engine.stats().state === 'running', null, { timeout: 5000 }).catch(() => {});
    await page.waitForFunction(() => (window as Any).__audioLab.engine.stats().banked >= (window as Any).__audioLab.warmKeys, null, { timeout: 30000, polling: 50 }).catch(() => {});
    const warm: Any = await page.evaluate(() => {
      const w = window as Any;
      const all: [number, number][] = w.__longTasks;
      const click = w.__clickAt ?? 0;
      const unlockTask = all.filter(([s, d]) => s <= click + 5 && s + d >= click - 5);
      const other = all.filter((t) => !unlockTask.includes(t));
      const scripts: [number, number, string][] = w.__longScripts;
      // scripts that started inside the unlock task are the unlock itself
      const inUnlock = (s: number) => unlockTask.some(([a, d]) => s >= a - 5 && s <= a + d);
      const ours = scripts.filter(([s]) => !inUnlock(s));
      return {
        unlockTaskMs: unlockTask.map(([, d]) => Math.round(d)),
        otherLongTasksMs: other.map(([, d]) => Math.round(d)),
        longScripts: ours.map(([, d, who]) => `${Math.round(d)} ms ${who.trim()}`),
      };
    });
    warm.ms = Date.now() - unlockAt;
    if (warm.longScripts.length) failures.push(`bank warm-up blocked the main thread: long scripts ${warm.longScripts.join(', ')}`);

    const live = await page.evaluate(async () => {
      const lab = (window as Any).__audioLab;
      const e = lab.engine;
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const state = e.stats().state;
      const musicDefault = e.stats().music; // the score starts on its own after the unlocking tap
      e.setMusic(false);
      await sleep(60);
      const p0 = e.stats().played;
      for (const n of lab.audible) {
        e.play(n, { volume: 0.2 });
        await sleep(90); // one cue per 70 ms: space them (plus a context-clock quantum) so every one is heard
      }
      const afterAll = e.stats();
      const playedAll = afterAll.played - p0;
      // v4: the cues through cue(), with the score's hooks (tolerant, never throw)
      const pc = e.stats().played;
      let v4threw = false;
      try {
        for (const c of ['sheet', 'cupSlide', 'cupSet', 'bone', 'tick']) {
          e.cue(c, { distance: 0.6 });
          await sleep(90);
        }
        e.cue('nope');
        e.turnPassed(true);
        e.lean('cold');
        e.setIdle(true);
        e.setIdle(false);
      } catch {
        v4threw = true;
      }
      const cuesPlayed = e.stats().played - pc;
      const pHover = e.stats().played;
      e.play('uiHover');
      const hoverPlayed = e.stats().played - pHover;
      e.stopAll();
      // silence rule: two routine cues in the same frame → one; an important cue replaces a lesser one
      const pa = e.stats().played;
      e.play('place');
      e.play('cardDraw');
      const sameFrameRoutine = e.stats().played - pa;
      e.stopAll();
      await sleep(30);
      e.play('uiClick');
      e.play('diceShake', { duration: 0.15 });
      const vb = e.stats().voicesByName;
      const shakeWon = (vb.diceShake ?? 0) === 1 && (vb.uiClick ?? 0) === 0;
      e.stopAll();
      await sleep(30);
      // the verdict beat: nothing new sounds inside it
      e.hush(250);
      const ph = e.stats().played;
      e.play('place');
      e.play('hit');
      const inBeat = e.stats().played - ph;
      await sleep(300);
      const pv = e.stats().played;
      e.play('hit');
      const afterBeat = e.stats().played - pv;
      e.stopAll();
      await sleep(30);
      const d0 = e.stats().dropped;
      for (let i = 0; i < 60; i++) e.play('diceLand');
      for (let i = 0; i < 30; i++) e.play('hit');
      const spam = e.stats();
      e.stopAll();
      e.setMusic(true);
      await sleep(400);
      const musicOn = e.stats().music;
      // mute stops the score (no scheduling while muted) and unmute brings it back
      e.setMuted(true);
      await sleep(50);
      const musicWhileMuted = e.stats().music;
      e.setMuted(false);
      await sleep(100);
      const musicAfterUnmute = e.stats().music;
      // a hidden tab stops the score and suspends the context; visible resumes both
      const setVis = (v: string) => {
        Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      };
      setVis('hidden');
      await sleep(700);
      const hidden = { state: e.stats().state, music: e.stats().music };
      setVis('visible');
      await sleep(400);
      const shown = { state: e.stats().state, music: e.stats().music };
      // a new game reseeds the score (crossfade), same seed is a no-op
      e.setMusicSeed(1234);
      await sleep(100);
      const seeded = e.stats().musicSeed;
      e.setMusic(false);
      await sleep(100);
      const musicOff = e.stats().music;
      lab.runScenario('Blitz (6 rolls)');
      await sleep(300);
      const blitz = e.stats();
      e.stopAll();
      // skipAnimations path: scheduled (delayed) sounds are cancelled by stopAll
      await sleep(120);
      e.play('victory', { delay: 1.5 });
      e.play('hit', { delay: 0.8 });
      const scheduled = e.stats().voices;
      e.stopAll();
      const afterStop = e.stats().voices;
      // the live stroke: starts, follows, ends; a second one replaces the first
      const s1 = e.stroke({ pan: -0.2 });
      s1?.move(0.8, 0.1);
      const s2 = e.stroke();
      s2?.move(1);
      s2?.end(false);
      s1?.end(true);
      const strokeOk = !!s1 && !!s2;
      // rapid music toggling never leaves two beds or a stuck state
      for (let i = 0; i < 12; i++) e.setMusic(i % 2 === 0);
      const musicAfterToggle = e.stats().music; // last call was setMusic(false)
      e.setMusic(true);
      await sleep(200);
      const musicFinal = e.stats().music;
      e.setMusic(false);
      // volume / mute edge values
      e.setVolume(-1);
      e.setVolume(5);
      e.setVolume(0.8);
      e.setMuted(true);
      e.setMuted(false);
      e.play('uiClick', { volume: 99, pan: -99, rate: 0, delay: -3, duration: 1e9 });
      return { cuesPlayed, v4threw, state, musicDefault, afterAll, playedAll, hoverPlayed, sameFrameRoutine, shakeWon, inBeat, afterBeat, spam, droppedBySpam: spam.dropped - d0, musicOn, musicWhileMuted, musicAfterUnmute, hidden, shown, seeded, musicOff, blitz, scheduled, afterStop, strokeOk, musicAfterToggle, musicFinal };
    });
    if (live.state !== 'running') failures.push(`live: context not running after a click (${live.state})`);
    if (!live.musicDefault) failures.push('live: the score did not start on its own after the first tap');
    if (live.playedAll < (await page.evaluate(() => (window as Any).__audioLab.audible.length))) failures.push(`live: only ${live.playedAll} audible sounds played after unlock`);
    if (live.hoverPlayed !== 0) failures.push('live: uiHover made a sound (no hover sounds)');
    if (live.v4threw) failures.push('live: a v4 hook threw');
    if (live.cuesPlayed !== 5) failures.push(`live: ${live.cuesPlayed}/5 v4 cues played through cue()`);
    if (live.sameFrameRoutine !== 1) failures.push(`live: ${live.sameFrameRoutine} routine cues in one frame (≤ 1 per 70 ms)`);
    if (!live.shakeWon) failures.push('live: diceShake did not replace the Roll click in the same frame');
    if (live.inBeat !== 0) failures.push(`live: ${live.inBeat} sounds inside the verdict beat`);
    if (live.afterBeat !== 1) failures.push('live: the verdict cue did not play after the beat');
    if ((live.spam.voicesByName.diceLand ?? 0) > 6) failures.push(`live: ${live.spam.voicesByName.diceLand} diceLand voices (cap 6)`);
    if ((live.spam.voicesByName.hit ?? 0) > 2) failures.push(`live: ${live.spam.voicesByName.hit} hit voices (cap 2)`);
    if (live.spam.voices > 20) failures.push(`live: ${live.spam.voices} voices (global cap 20)`);
    if (live.droppedBySpam < 80) failures.push(`live: spam of 90 same-frame plays only dropped ${live.droppedBySpam}`);
    if (live.scheduled < 2) failures.push(`live: delayed plays not scheduled (${live.scheduled} voices)`);
    if (live.afterStop !== 0) failures.push(`live: stopAll left ${live.afterStop} voices`);
    if (!live.strokeOk) failures.push('live: stroke() returned null after unlock');
    if (live.musicAfterToggle) failures.push('live: music on after toggling ending in off');
    if (!live.musicFinal) failures.push('live: music did not restart after toggling');
    if (!live.musicOn) failures.push('live: music did not start');
    if (live.musicWhileMuted) failures.push('live: the score kept playing while muted');
    if (!live.musicAfterUnmute) failures.push('live: the score did not come back after unmute');
    if (live.hidden.music || live.hidden.state !== 'suspended') failures.push(`live: hidden tab left ${JSON.stringify(live.hidden)}`);
    if (!live.shown.music || live.shown.state !== 'running') failures.push(`live: visible again left ${JSON.stringify(live.shown)}`);
    if (live.seeded !== 1234) failures.push(`live: setMusicSeed did not take (${live.seeded})`);
    if (live.musicOff) failures.push('live: music did not stop');

    // v5 live: the dice pour (5 dice, 60 ms apart) as delayed plays and as per-frame calls; the v5 cues and
    // hooks through the real engine
    const live5: Any = await page.evaluate(async () => {
      const lab = (window as Any).__audioLab;
      const e = lab.engine;
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      e.setMusic(false);
      e.stopAll();
      await sleep(60);
      const p0 = e.stats().played;
      for (let i = 0; i < 5; i++) e.play('diceLand', { delay: i * 0.06, pan: i < 3 ? -0.3 : 0.3 });
      const scheduled = e.stats().played - p0;
      await sleep(500);
      const p1 = e.stats().played;
      for (let i = 0; i < 5; i++) {
        e.play('diceLand', { pan: i < 3 ? -0.3 : 0.3 });
        await sleep(60);
      }
      const perFrame = e.stats().played - p1;
      await sleep(400);
      // the verdict: two pairs and two splashes on the same frame all sound
      const p2 = e.stats().played;
      e.play('hit', { variant: 'pair', pan: -0.3 });
      e.cue('splash', { pan: -0.3 });
      e.play('hit', { variant: 'pair', pan: 0.3 });
      e.cue('splash', { pan: 0.3 });
      const verdict = e.stats().played - p2;
      e.stopAll();
      await sleep(60);
      let threw = false;
      const pc = e.stats().played;
      let cold = false;
      let evening = -1;
      try {
        for (const c of lab.v5Cues) {
          e.cue(c, { pan: -0.2, panTo: 0.2 });
          await sleep(90);
        }
        e.fightCold(true);
        cold = e.stats().cold;
        e.fightCold(false);
        e.setEvening(0.6);
        evening = e.stats().evening;
        e.setEvening(NaN);
        e.setEvening(0);
      } catch {
        threw = true;
      }
      const cuesPlayed = e.stats().played - pc;
      e.stopAll();
      return { scheduled, perFrame, verdict, cuesPlayed, threw, cold, evening };
    });
    if (live5.scheduled !== 5) failures.push(`v5 live: ${live5.scheduled}/5 dice played when scheduled 60 ms apart`);
    if (live5.perFrame !== 5) failures.push(`v5 live: ${live5.perFrame}/5 dice played when called 60 ms apart`);
    if (live5.verdict !== 4) failures.push(`v5 live: ${live5.verdict}/4 verdict sounds (2 pairs + 2 splashes, same frame)`);
    if (live5.cuesPlayed !== 5) failures.push(`v5 live: ${live5.cuesPlayed}/5 v5 cues played through cue()`);
    if (live5.threw) failures.push('v5 live: a v5 hook threw');
    if (!live5.cold || Math.abs(live5.evening - 0.6) > 1e-9) failures.push(`v5 live: stats did not follow fightCold / setEvening (${live5.cold}, ${live5.evening})`);

    // ------------------------------------------------------------- offline
    const reports: Any[] = await page.evaluate(() => (window as Any).__audioLab.analyzeAll());
    for (const r of reports) for (const f of r.failures) failures.push(`${r.name}: ${f}`);

    const comp: Any = await page.evaluate(() => (window as Any).__audioLab.composites());
    const roll = comp.diceRoll;
    if (roll.peakDb > -1) failures.push(`dice roll (5 dice): peak ${f1(roll.peakDb)} dBFS`);
    if (Math.abs(roll.lk200 - roll.target) > 2) failures.push(`dice roll (5 dice): ${f1(roll.lk200)} LUFS vs board ${roll.target} ±2`);
    const st = comp.stress;
    if (st.nan) failures.push('stress: NaN');
    if (st.peakDb > -0.3) failures.push(`stress: peak ${f1(st.peakDb)} dBFS through limiter`);
    if (st.maxConcurrent > st.maxVoices) failures.push(`stress: ${st.maxConcurrent} concurrent voices`);
    if (Math.abs(comp.limiter.quietGainDb) > 0.3) failures.push(`limiter not transparent at −20 dBFS: ${comp.limiter.quietGainDb.toFixed(2)} dB`);
    if (comp.limiter.loudOutPeak > 0.95) failures.push(`limiter ceiling: +6 dBFS sine came out at ${comp.limiter.loudOutPeak.toFixed(3)}`);
    const mu = comp.music;
    if (mu.nan) failures.push('score: NaN');
    if (mu.minWindowDb < -60) failures.push(`score: a 2 s hole at ${f1(mu.minWindowDb)} dBFS (it should always be underneath)`);
    const sc: Any = await page.evaluate(() => (window as Any).__audioLab.musicAnalysis(60, 3));
    if (sc.nan) failures.push('score: NaN');
    if (sc.peakDb > -6) failures.push(`score: peak ${f1(sc.peakDb)} dBFS (it should be quiet)`);
    if (sc.vsBoardDb < -12 || sc.vsBoardDb > -6.5) failures.push(`score: ${f1(sc.integrated)} LUFS-I is ${f1(sc.vsBoardDb)} dB vs board SFX (want about −9 dB, 35%)`);
    if (sc.dc > 0.002) failures.push(`score: DC ${sc.dc}`);
    if (sc.laptopDropDb > 6) failures.push(`score: loses ${f1(sc.laptopDropDb)} dB on laptop/phone speakers (too much of it is below 180 Hz)`);
    if (sc.hfShare > 0.02) failures.push(`score: ${(sc.hfShare * 100).toFixed(1)}% above 8 kHz`);
    if (sc.eventsPerMin < 2 || sc.eventsPerMin > 7) failures.push(`score: ${f1(sc.eventsPerMin)} events/min (want a few)`);
    if (sc.long.perMin < 2.5 || sc.long.perMin > 6.5) failures.push(`score: ${f1(sc.long.perMin)} events/min over 30 min`);
    if (sc.long.stepwise > 0) failures.push(`score: ${sc.long.stepwise} stepwise piano moves (a hummable line)`);
    if (sc.long.gapSd < 2) failures.push(`score: event gaps too regular (sd ${f1(sc.long.gapSd)} s)`);
    if (sc.long.repeated4 > 3) failures.push(`score: ${sc.long.repeated4} repeated 4-event passages in 30 min`);
    if (sc.selfSimMax > 0.9) failures.push(`score: a 4 s passage repeats (similarity ${sc.selfSimMax.toFixed(2)} at ${sc.selfSimLagSec} s)`);
    if (sc.otherSeedSimMax > 0.9) failures.push(`score: another seed sounds the same (${sc.otherSeedSimMax.toFixed(2)})`);
    const duck: Any = await page.evaluate(() => (window as Any).__audioLab.duckTest('conquer'));
    if (duck.depthDb > -3) failures.push(`score duck under conquer only ${f1(duck.depthDb)} dB`);
    if (!(duck.recoveredWithin1dBAfterSec >= 1.5 && duck.recoveredWithin1dBAfterSec <= 4)) failures.push(`score duck recovers in ${f1(duck.recoveredWithin1dBAfterSec)} s (want 2–3 s)`);
    const stroke: Any = await page.evaluate(() => (window as Any).__audioLab.strokeStats());
    for (const [k, v] of Object.entries(stroke) as [string, Any][]) {
      if (v.nan) failures.push(`stroke ${k}: NaN`);
      if (v.peakDb > -1) failures.push(`stroke ${k}: peak ${f1(v.peakDb)}`);
      if (v.lk200 < -34 || v.lk200 > -22) failures.push(`stroke ${k}: ${f1(v.lk200)} LUFS (want a whisper, ~ −27)`);
      if (v.endDb > -70) failures.push(`stroke ${k}: does not dry out`);
    }

    const vars: Any[] = await page.evaluate(() => (window as Any).__audioLab.variants());
    const meta: Any = await page.evaluate(() => (window as Any).__audioLab.meta);
    const base = Object.fromEntries(reports.map((r) => [r.name, r]));
    for (const v of vars) {
      const m = meta[v.name];
      const allowed = (m.maxDur * (m.keyed ? Math.SQRT2 : 1) + (m.duration && v.duration !== undefined ? Math.max(0, v.duration - m.duration[2]) : 0)) / (v.rate ?? 1);
      if (v.reportedDur > allowed + 1e-6) failures.push(`${v.label}: reported ${v.reportedDur.toFixed(3)} s > allowed ${allowed.toFixed(3)} s`);
      if (v.nan) failures.push(`${v.label}: NaN`);
      if (v.peakDb > -1) failures.push(`${v.label}: peak ${f1(v.peakDb)} dBFS`);
      if (!(v.peakDb > -60)) failures.push(`${v.label}: silent`);
      if (v.endDb > -70) failures.push(`${v.label}: tail cut off`);
      if (v.variant && Math.abs(v.lk200 - base[v.name].median.lk200) > 2.5) failures.push(`${v.label}: ${f1(v.lk200)} LUFS, base ${f1(base[v.name].median.lk200)}`);
      if (v.duration !== undefined && v.name !== 'whoosh' && !m.toned) {
        // the sound's own length (before the room tail) must track the requested motion length
        if (v.reportedDur < v.duration || v.reportedDur > v.duration + 0.25) failures.push(`${v.label}: reported ${v.reportedDur.toFixed(3)} s`);
      }
    }

    // ------------------------------------------------------------------ v4
    const room: Any = await page.evaluate(() => (window as Any).__audioLab.roomCheck());
    if (!(Math.abs(room.ratio - 1) <= 0.2)) failures.push(`B1 one room: diceLand tail RT60 ${room.diceTail.rt60.toFixed(2)} s vs the score's hall ${room.scoreHall.rt60.toFixed(2)} s (ratio ${room.ratio.toFixed(2)}, want 1 ± 0.2)`);
    const keys: Any[] = await page.evaluate(() => (window as Any).__audioLab.keyLock());
    for (const k of keys) if (!k.ok) failures.push(`B2 key-lock: ${k.name} over ${k.chord}: midi ${k.midi} (want ${k.expected}, chord tone ${k.chordTone}), rendered ${k.cents} c`);
    const sharpNames = new Set(['diceLand', 'bone', 'continent', 'eliminated']);
    for (const r of reports) {
      const sharp = sharpNames.has(r.name);
      if (sharp && r.median.riseMs > 8) failures.push(`B4: ${r.name} should be sharp, rises in ${r.median.riseMs.toFixed(0)} ms`);
    }
    const dist: Any[] = await page.evaluate(() => (window as Any).__audioLab.distanceCheck());
    for (const n of new Set(dist.map((d) => d.name))) {
      const at = (d: number) => dist.find((x) => x.name === n && x.d === d);
      const near = at(0), mid = at(0.6), far = at(1);
      if (!(far.lk200 - near.lk200 <= -1.5 && far.lk200 - near.lk200 >= -6)) failures.push(`A2 distance: ${n} far is ${f1(far.lk200 - near.lk200)} dB vs the table (want −1.5…−6)`);
      if (!(far.tailShare > near.tailShare * 1.5)) failures.push(`A2 distance: ${n} far has no more hall (${far.tailShare.toFixed(3)} vs ${near.tailShare.toFixed(3)})`);
      if (!(far.centroidHz < near.centroidHz)) failures.push(`A2 distance: ${n} far is not softer on top`);
      if (!(mid.lk200 <= near.lk200 + 0.2 && mid.lk200 >= far.lk200 - 0.2)) failures.push(`A2 distance: ${n} 0.6 is not between`);
    }
    const breath: Any = await page.evaluate(() => (window as Any).__audioLab.breathCheck());
    if (!breath.turn.changedAtTurn) failures.push(`B3: turnPassed did not move the chord change (${breath.turn.turned})`);
    if (!breath.lean.cold || breath.lean.changeAt === null || breath.lean.changeAt > 9 + 4.6) failures.push(`B3: lean gave ${breath.lean.chord} at ${breath.lean.changeAt} s (want a cold chord within ~4 s)`);
    if (!(breath.swell.atPeakDb >= 1.4 && breath.swell.atPeakDb <= 2.6)) failures.push(`B3: swell ${f1(breath.swell.atPeakDb)} dB at its top (want +2)`);
    if (Math.abs(breath.swell.afterDb) > 0.5) failures.push(`B3: swell has not settled (${f1(breath.swell.afterDb)} dB after 11 s)`);
    if (breath.idle.heardIdle > 0 || breath.idle.heardBase < 1) failures.push(`B3: idle thin-out: ${breath.idle.heardIdle} notes heard while idle (baseline ${breath.idle.heardBase})`);
    const tiers: Any = Object.fromEntries(reports.map((r) => [r.name, r.median.lk200]));
    const bowlMax = Math.max(tiers.continent, tiers.eliminated, tiers.victory);
    const restMax = Math.max(...reports.filter((r) => !['continent', 'eliminated', 'victory'].includes(r.name)).map((r) => r.median.lk200));
    // v5: the tick tier now also holds ripple and glint (the board's details); the rule is per tier
    const tickMax = Math.max(...reports.filter((r) => r.tier === 'tick').map((r) => r.median.lk200));
    const restMin = Math.min(...reports.filter((r) => r.tier !== 'tick').map((r) => r.median.lk200));
    if (!(bowlMax > restMax && bowlMax - restMax <= 3.2)) failures.push(`levels: the bowls are ${f1(bowlMax - restMax)} dB over everything else (want loudest by ≤ 3)`);
    if (!(tickMax < restMin)) failures.push(`levels: paper ticks (${f1(tickMax)}) are not the quietest (${f1(restMin)})`);
    const scenes: Any[] = [];
    for (const name of (await page.evaluate(() => (window as Any).__audioLab.scenes)) as string[]) {
      const s: Any = await page.evaluate((n) => (window as Any).__audioLab.sceneWav(n), name);
      writeFileSync(join(V4, `${name}.wav`), Buffer.from(s.b64, 'base64'));
      if (s.stats.peakDb > -0.3) failures.push(`scene ${name}: peak ${f1(s.stats.peakDb)} dBFS`);
      if (s.stats.nan) failures.push(`scene ${name}: NaN`);
      delete s.b64;
      scenes.push({ name, peakDb: s.stats.peakDb, marks: s.marks });
    }

    // ------------------------------------------------------------------ v5
    const stagger: Any[] = await page.evaluate(() => (window as Any).__audioLab.staggerCheck());
    for (const s of stagger) {
      const g = `${Math.round(s.gap * 1000)} ms`;
      if (s.played !== s.requested) failures.push(`v5 stagger ${g}: ${s.played}/${s.requested} dice played (the arbitration ate a landing)`);
      if (s.heard !== s.requested) failures.push(`v5 stagger ${g}: ${s.heard}/${s.requested} landings heard as onsets (${s.risesDb.join(', ')} dB)`);
      if (s.indices.join(',') !== '0,1,2,3,4') failures.push(`v5 stagger ${g}: the pour's places ${s.indices.join(',')}`);
      if (s.pairsPlayed !== 2 || s.splashesPlayed !== 2) failures.push(`v5 stagger ${g}: same-frame verdict played ${s.pairsPlayed} pairs, ${s.splashesPlayed} splashes (want 2 + 2)`);
      if (!s.tickPlayed) failures.push(`v5 stagger ${g}: a paper tick inside the pour was eaten`);
      if (s.peakDb > -1) failures.push(`v5 stagger ${g}: peak ${f1(s.peakDb)} dBFS`);
    }
    const timbres: Any[] = await page.evaluate(() => (window as Any).__audioLab.timbreCheck());
    const tLk = timbres.map((t) => t.lk200);
    const tC = timbres.map((t) => t.centroidHz);
    if (Math.max(...tLk) - Math.min(...tLk) > 1.5) failures.push(`v5 timbres: loudness spread ${f1(Math.max(...tLk) - Math.min(...tLk))} dB (want ≤ 1.5)`);
    if (Math.max(...tC) - Math.min(...tC) < 80) failures.push(`v5 timbres: centroids ${tC.map((c) => Math.round(c)).join('/')} Hz are not three colours`);
    const tones: Any[] = await page.evaluate(() => (window as Any).__audioLab.toneLevels());
    const pairTone = tones.find((t) => t.name === 'hit · pair');
    if (Math.abs(pairTone.lk200 - TICK_TIER) > 1.5) failures.push(`v5 pair tick: ${f1(pairTone.lk200)} LUFS on its own (want ${TICK_TIER} ± 1.5)`);
    const v5Targets: Record<string, number> = { splash: -27, rattle: -27, ripple: -30, glint: -30, pour: -22 };
    for (const [n, want] of Object.entries(v5Targets)) {
      const r = base[n];
      if (!r) failures.push(`v5: ${n} not analysed`);
      else if (r.target !== want) failures.push(`v5: ${n} is on the ${r.tier} tier (${r.target}), want ${want}`);
    }
    const pairVar = vars.find((v) => v.label === 'hit pair');
    if (!pairVar || !(pairVar.riseMs >= 13)) failures.push(`v5 B4: hit · pair rises in ${pairVar?.riseMs} ms (want a ≥ 15 ms fade-in)`);
    const v5Keyed = keys.filter((k) => /hit · pair|glint|pour/.test(k.name));
    if (v5Keyed.length !== 24) failures.push(`v5 key-lock: ${v5Keyed.length}/24 (pair, glint, pour × 8 chords) checked`);
    const fifthOk = v5Keyed.filter((k) => /pair|glint/.test(k.name)).every((k) => {
      const c = [...CHORD_ROOTS, 2][Math.max(0, CHORD_NAMES.indexOf(k.chord))];
      return (((k.midi - c - 7) % 12) + 12) % 12 === 0;
    });
    if (!fifthOk) failures.push('v5 key-lock: the pair tick / glint is not on the chord\'s fifth');
    const coldV: Any = await page.evaluate(() => (window as Any).__audioLab.coldCheck());
    if (!(coldV.highDipDb <= -1.4 && coldV.highDipDb >= -2.6)) failures.push(`v5 fightCold: the score's top dips ${f1(coldV.highDipDb)} dB (want −2)`);
    if (Math.abs(coldV.bodyDb) > 0.5) failures.push(`v5 fightCold: the score's body moved ${f1(coldV.bodyDb)} dB (only the top should)`);
    if (Math.abs(coldV.backAfter1sDb) > 0.5) failures.push(`v5 fightCold: not back 1 s after off (${f1(coldV.backAfter1sDb)} dB)`);
    if (!(coldV.roomThinDb <= -3)) failures.push(`v5 fightCold: the room tone only thinned ${f1(coldV.roomThinDb)} dB`);
    const eve: Any = await page.evaluate(() => (window as Any).__audioLab.eveningCheck());
    if (!eve.sameTimes) failures.push('v5 evening: the score\'s timing changed with the evening (Pillar 5)');
    if (!(eve.padMidiNight <= eve.padMidiDusk - 1.5)) failures.push(`v5 evening: pads at night ${f1(eve.padMidiNight)} vs dusk ${f1(eve.padMidiDusk)} (want ≥ 1.5 st lower)`);
    if (!(eve.noteMidiNight < eve.noteMidiDusk)) failures.push('v5 evening: the felt notes did not sink at night');
    if (!(eve.centroidNight < eve.centroidDusk * 0.92)) failures.push(`v5 evening: night is not darker (centroid ${Math.round(eve.centroidNight)} vs ${Math.round(eve.centroidDusk)} Hz)`);
    if (Math.abs(eve.loudNight - eve.loudDusk) > 1.5) failures.push(`v5 evening: night is ${f1(eve.loudNight - eve.loudDusk)} dB vs dusk (want the same level ± 1.5)`);
    if (eve.idle.heardIdle > 0 || eve.idle.heardBase < 1) failures.push(`v5 evening: idle no longer thins at night (${eve.idle.heardIdle} notes heard, baseline ${eve.idle.heardBase})`);
    if (eve.ramp.nan || eve.ramp.peakDb > -6) failures.push(`v5 evening: the dusk → night ramp rendered badly (${JSON.stringify(eve.ramp)})`);
    const scenes5: Any[] = [];
    for (const name of (await page.evaluate(() => (window as Any).__audioLab.v5Scenes)) as string[]) {
      const s: Any = await page.evaluate((n) => (window as Any).__audioLab.v5SceneWav(n), name);
      writeFileSync(join(V5, `${name}.wav`), Buffer.from(s.b64, 'base64'));
      if (s.stats.peakDb > -0.3) failures.push(`v5 scene ${name}: peak ${f1(s.stats.peakDb)} dBFS`);
      if (s.stats.nan) failures.push(`v5 scene ${name}: NaN`);
      if (s.marks.some((m: Any) => /dropped/.test(m.what))) failures.push(`v5 scene ${name}: ${s.marks.filter((m: Any) => /dropped/.test(m.what)).map((m: Any) => m.what).join(', ')}`);
      delete s.b64;
      scenes5.push({ name, peakDb: s.stats.peakDb, marks: s.marks });
    }

    const sweep: string[] = await page.evaluate(() => (window as Any).__audioLab.buildSweep(20));
    for (const b of sweep.slice(0, 10)) failures.push(`build: ${b}`);
    if (sweep.length > 10) failures.push(`build: …and ${sweep.length - 10} more`);
    const bank: Any[] = await page.evaluate(() => (window as Any).__audioLab.bankCheck());
    for (const b of bank) if (!(Math.abs(b.dLk) < 0.15) || !(Math.abs(b.dPeak) < 0.15)) failures.push(`bank: ${b.name} banked differs from direct by ${b.dLk.toFixed(2)} dB loudness / ${b.dPeak.toFixed(2)} dB peak`);
    const cost: Any = await page.evaluate(() => (window as Any).__audioLab.liveCost());
    const warmKeys: number = await page.evaluate(() => (window as Any).__audioLab.warmKeys);
    if (cost.banked < warmKeys) failures.push(`bank: only ${cost.banked}/${warmKeys} keys warmed after ${Math.round(cost.warmMs)} ms`);
    for (const [n, c] of Object.entries(cost.cost) as [string, Any][]) if (c.median > 1) failures.push(`cpu: play('${n}') costs ${c.median.toFixed(2)} ms median after warm-up`);

    // ----------------------------------------------------------- artifacts
    await page.evaluate(() => (window as Any).__audioLab.drawAll([
      { label: 'turnStart · bright', name: 'turnStart', o: { variant: 'bright' } },
      { label: 'conquer · somber (the snap)', name: 'conquer', o: { variant: 'somber' } },
      { label: 'continent · somber (damped)', name: 'continent', o: { variant: 'somber' } },
    ]));
    await page.locator('#all').screenshot({ path: join(OUT, 'spectrograms.png') });
    await page.evaluate(() => (window as Any).__audioLab.drawMusic(60));
    await page.locator('#all').screenshot({ path: join(OUT, 'score.png') });
    await page.click('#analyze');
    await page.waitForFunction(() => /pass|attention/.test(document.getElementById('status')!.textContent ?? ''), null, { timeout: 120000 });
    await page.screenshot({ path: join(OUT, 'lab.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(OUT, 'lab-phone.png') });

    const names: string[] = await page.evaluate(() => (window as Any).__audioLab.audible);
    const meta2: Any = await page.evaluate(() => (window as Any).__audioLab.meta);
    for (const n of names) {
      const b64: string = await page.evaluate((name) => (window as Any).__audioLab.wavBase64(name, { seed: 1 }), n);
      writeFileSync(join(WAV, `${meta2[n].material}-${n}.wav`), Buffer.from(b64, 'base64'));
    }
    for (const [n, o, file] of [
      ['turnStart', { variant: 'bright', seed: 1 }, 'paper-turnStart-bright'],
      ['conquer', { variant: 'somber', seed: 1 }, 'brush-conquer-somber-snap'],
      ['continent', { variant: 'somber', seed: 1 }, 'bowl-continent-somber'],
    ] as [string, Any, string][]) {
      const b64: string = await page.evaluate(([name, opts]) => (window as Any).__audioLab.wavBase64(name, opts), [n, o] as const);
      writeFileSync(join(WAV, `${file}.wav`), Buffer.from(b64, 'base64'));
    }
    writeFileSync(join(WAV, 'bone-dice-roll-5.wav'), Buffer.from(await page.evaluate(() => (window as Any).__audioLab.rollWav()), 'base64'));
    writeFileSync(join(WAV, 'brush-live-stroke.wav'), Buffer.from(await page.evaluate(() => (window as Any).__audioLab.strokeWav(true)), 'base64'));
    writeFileSync(join(OUT, 'score-60s-seed3.wav'), Buffer.from(await page.evaluate(() => (window as Any).__audioLab.musicWav(60, 3)), 'base64'));
    writeFileSync(join(OUT, 'score-60s-seed4.wav'), Buffer.from(await page.evaluate(() => (window as Any).__audioLab.musicWav(60, 4)), 'base64'));
    const moment: Any = await page.evaluate(() => (window as Any).__audioLab.momentWav());
    writeFileSync(join(OUT, 'the-moment.wav'), Buffer.from(moment.b64, 'base64'));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('#all').screenshot({ path: join(OUT, 'the-moment.png') });
    if (moment.stats.peakDb > -0.3) failures.push(`the moment: peak ${f1(moment.stats.peakDb)} dBFS through the limiter`);
    if (moment.stats.nan) failures.push('the moment: NaN');
    delete moment.b64;

    // An agent worktree symlinks node_modules from the main checkout, and Vite refuses (403) to serve the
    // lab's webfont from outside the worktree root. That is the environment, not the audio: ignore exactly it.
    const fontFromSymlink = consoleProblems.some((m) => /^http: 403 .*\/@fs\/.*\/node_modules\/@fontsource/.test(m));
    const relevant = consoleProblems.filter(
      (m) => !/Download the React DevTools|\[vite\]/.test(m) && !(fontFromSymlink && /403/.test(m) && (/@fontsource/.test(m) || /Failed to load resource/.test(m))),
    );
    for (const m of relevant) failures.push(`console ${m}`);

    writeFileSync(join(OUT, 'report.json'), JSON.stringify({ when: new Date().toISOString(), live, warm, reports, composites: comp, score: sc, duck, stroke, moment, variants: vars, bank, cost, sweep, failures }, null, 2));
    writeFileSync(
      join(V5, 'report.json'),
      JSON.stringify({ when: new Date().toISOString(), live: live5, stagger, timbres, tones, cold: coldV, evening: eve, scenes: scenes5, keys: v5Keyed, levels: Object.fromEntries(reports.filter((r) => r.name in v5Targets || r.name === 'diceLand' || r.name === 'hit').map((r) => [r.name, { tier: r.tier, target: r.target, lk200: r.median.lk200, riseMs: r.median.riseMs, centroidHz: r.median.centroidHz }])), hitPair: pairVar }, null, 2),
    );
    writeFileSync(join(V4, 'report.json'), JSON.stringify({ when: new Date().toISOString(), room, keys, distance: dist, breath, scenes, levels: Object.fromEntries(reports.map((r) => [r.name, { tier: r.tier, target: r.target, lk200: r.median.lk200, riseMs: r.median.riseMs }])), scoreVsBoardDb: sc.vsBoardDb }, null, 2));

    // --------------------------------------------------------------- print
    const pad = (s: string, n: number) => s.padEnd(n);
    const lpad = (s: string, n: number) => s.padStart(n);
    console.log(
      pad('sound', 11) + pad('tier', 8) + lpad('target', 7) + lpad('LK200', 7) + lpad('range', 12) + lpad('LUFS-M', 7) + lpad('RMS', 7) + lpad('peak', 7) + lpad('dur', 6) + lpad('onset', 6) + lpad('rise', 6) + lpad('cent', 6) + lpad('lap%', 5) + lpad('>8k%', 6) + lpad('dc', 9) + lpad('trim', 6) + lpad('sugg', 6),
    );
    for (const r of reports) {
      const m = r.median;
      console.log(
        pad(r.name, 11) + pad(r.tier, 8) + lpad(String(r.target), 7) + lpad(f1(m.lk200), 7) + lpad(`${f1(r.lk200Min)}…${f1(r.lk200Max)}`, 12) + lpad(f1(m.lufsM), 7) + lpad(f1(m.rmsDb), 7) + lpad(f1(r.peakMaxDb), 7) + lpad(String(Math.round(m.durationSec * 1000)), 6) + lpad(f1(m.onsetMs), 6) + lpad(String(Math.round(m.riseMs)), 6) + lpad(String(Math.round(m.centroidHz)), 6) + lpad(String(Math.round(m.laptopShare * 100)), 5) + lpad((m.hfShare * 100).toFixed(2), 6) + lpad(m.dc.toExponential(1), 9) + lpad(f1(r.trimDb), 6) + lpad(f1(r.suggestedTrimDb), 6),
      );
    }
    console.log(`\n5-die roll: ${f1(roll.lk200)} LUFS, peak ${f1(roll.peakDb)} dBFS`);
    console.log(`stress: requested ${st.requested}, played ${st.played}, dropped ${st.dropped}, stolen ${st.stolen}, max concurrent ${st.maxConcurrent}, peak ${f1(st.peakDb)} dBFS`);
    console.log(`limiter: −20 dBFS sine gain ${comp.limiter.quietGainDb.toFixed(3)} dB · +6 dBFS sine peak ${comp.limiter.loudOutPeak.toFixed(3)}`);
    console.log(`score 60 s (seed 3): ${f1(sc.integrated)} LUFS-I (${f1(sc.vsBoardDb)} dB vs board SFX = ${Math.round(Math.pow(10, sc.vsBoardDb / 20) * 100)}%), 3 s median ${f1(sc.shortTermMedian)}, M max ${f1(sc.lufsM)}, peak ${f1(sc.peakDb)} dBFS, centroid ${Math.round(sc.centroidHz)} Hz, laptop −${f1(sc.laptopDropDb)} dB, min 2 s window ${f1(mu.minWindowDb)} dBFS`);
    console.log(`  events ${f1(sc.eventsPerMin)}/min planned, ${f1(sc.detectedOnsetsPerMin)}/min heard · pads ${sc.pads.map((p: Any) => p.chord).join(' → ')}`);
    console.log(`  events: ${sc.events.map((e: Any) => `${e.t}s ${e.kind} ${e.midis.join('+')}`).join(' · ')}`);
    console.log(`  loop-free: max 4 s self-similarity ${sc.selfSimMax.toFixed(2)} (lag ${sc.selfSimLagSec} s) · vs seed 4 ${sc.otherSeedSimMax.toFixed(2)}`);
    console.log(`  30 min plan: ${sc.long.events} events (${f1(sc.long.perMin)}/min), gaps ${f1(sc.long.gapMean)} ± ${f1(sc.long.gapSd)} s, stepwise ${sc.long.stepwise}, repeated 4-event passages ${sc.long.repeated4}, ${sc.long.chordFourGrams} distinct 4-chord paths in ${sc.long.pads} pads`);
    console.log(`  duck under conquer: ${f1(duck.depthDb)} dB, back within 1 dB after ${f1(duck.recoveredWithin1dBAfterSec)} s`);
    console.log(`stroke: commit ${f1(stroke.commit.lk200)} LUFS pk ${f1(stroke.commit.peakDb)} · cancel ${f1(stroke.cancel.lk200)} LUFS, dries in ${Math.round(stroke.cancel.durationSec * 1000 - 50 - 736)} ms after release`);
    console.log(`the moment (18 s through the limiter): peak ${f1(moment.stats.peakDb)} dBFS · ${moment.marks.map((m: Any) => `${m.t.toFixed(2)} ${m.what}`).join(' · ')}`);
    console.log('variants:');
    for (const v of vars) console.log(`  ${pad(v.label, 22)} ${f1(v.lk200)} LUFS  peak ${f1(v.peakDb)}  reported ${v.reportedDur.toFixed(3)} s  sound ${Math.round(v.durationSec * 1000)} ms`);
    console.log(`\nv4 · B1 one room: RT60 diceLand tail ${room.diceTail.rt60.toFixed(2)} s · score hall ${room.scoreHall.rt60.toFixed(2)} s · effects hall ${room.sfxHall.rt60.toFixed(2)} s · ratio ${room.ratio.toFixed(2)}`);
    const kOk = keys.filter((k) => k.ok).length;
    console.log(`v4 · B2 key-lock: ${kOk}/${keys.length} (sound × chord) on the chord tone; rendered pitch max |${Math.max(...keys.map((k) => Math.abs(k.cents)))}| c`);
    for (const n of [...new Set(keys.map((k) => k.name))]) console.log(`    ${pad(n, 20)} ${keys.filter((k) => k.name === n).map((k) => `${k.chord}:${k.midi}`).join(' ')}`);
    console.log(`v4 · A2 distance (lk200 at 0 / 0.6 / 1): ${[...new Set(dist.map((d) => d.name))].map((n) => `${n} ${dist.filter((d) => d.name === n).map((d) => f1(d.lk200)).join(' / ')}`).join(' · ')}`);
    console.log(`v4 · B3 breath: turn moved the change ${breath.turn.changedAtTurn} · lean → ${breath.lean.chord} at ${breath.lean.changeAt} s (cold ${breath.lean.cold}) · swell +${f1(breath.swell.atPeakDb)} dB, after ${f1(breath.swell.afterDb)} dB · idle notes heard ${breath.idle.heardIdle} (baseline ${breath.idle.heardBase}, planned ${breath.idle.plannedNotesAfter11s}), level ${f1(breath.idle.levelDropDb)} dB`);
    console.log(`v4 · levels: bowls loudest by ${f1(bowlMax - restMax)} dB · ticks quietest (${f1(tickMax)} vs next ${f1(restMin)}) · score ${f1(sc.vsBoardDb)} dB vs board`);
    console.log(`v4 · scenes: ${scenes.map((s) => `${s.name} (pk ${f1(s.peakDb)})`).join(', ')} → artifacts/audio/v4/`);
    console.log(`\nv5 · stagger: ${stagger.map((s) => `${Math.round(s.gap * 1000)} ms → ${s.played}/${s.requested} played, ${s.heard} heard (rise ${s.risesDb.slice(1).join('/')} dB), places ${s.indices.join('')}, verdict ${s.pairsPlayed}+${s.splashesPlayed}, tick ${s.tickPlayed ? 'kept' : 'eaten'}`).join(' · ')}`);
    console.log(`v5 · live: scheduled ${live5.scheduled}/5 · per-frame ${live5.perFrame}/5 · same-frame verdict ${live5.verdict}/4 · cues ${live5.cuesPlayed}/5`);
    console.log(`v5 · timbres: ${timbres.map((t) => `${t.timbre}: ${f1(t.lk200)} LUFS ${Math.round(t.centroidHz)} Hz`).join(' · ')}`);
    console.log(`v5 · levels: ${['splash', 'rattle', 'ripple', 'glint', 'pour'].map((n) => `${n} ${f1(base[n].median.lk200)} (${base[n].target}, rise ${Math.round(base[n].median.riseMs)} ms)`).join(' · ')} · hit·pair ${f1(pairVar.lk200)} (rise ${Math.round(pairVar.riseMs)} ms) · tones alone: ${tones.map((t) => `${t.name} ${f1(t.lk200)}`).join(', ')}`);
    console.log(`v5 · key-lock: ${v5Keyed.filter((k) => k.ok).length}/${v5Keyed.length} · ${[...new Set(v5Keyed.map((k) => k.name))].map((n) => `${n} ${v5Keyed.filter((k) => k.name === n).map((k) => `${k.chord.split(' ')[0]}:${k.midi}`).join(' ')}`).join(' | ')}`);
    console.log(`v5 · fightCold: top ${f1(coldV.highDipDb)} dB, body ${f1(coldV.bodyDb)} dB, 1 s after off ${f1(coldV.backAfter1sDb)} dB, room tone ${f1(coldV.roomThinDb)} dB (low ${f1(coldV.roomLowDb)})`);
    console.log(`v5 · evening: same times ${eve.sameTimes} (${eve.items} items/30 min) · pads ${f1(eve.padMidiDusk)} → ${f1(eve.padMidiNight)} · notes ${f1(eve.noteMidiDusk)} → ${f1(eve.noteMidiNight)} · centroid ${Math.round(eve.centroidDusk)} → ${Math.round(eve.centroidNight)} Hz · level ${f1(eve.loudDusk)} → ${f1(eve.loudNight)} LUFS · idle at night heard ${eve.idle.heardIdle} (baseline ${eve.idle.heardBase})`);
    console.log(`v5 · scenes: ${scenes5.map((s) => `${s.name} (pk ${f1(s.peakDb)})`).join(', ')} → artifacts/audio/v5/`);
    console.log(`build sweep: ${sweep.length ? sweep.length + ' failures' : 'every sound × variant × rate/duration extreme × 20 seeds built cleanly'}`);
    console.log(`bank: max |Δ loudness| ${Math.max(...bank.map((b) => Math.abs(b.dLk))).toFixed(3)} dB · mono keys ${bank.filter((b) => b.channels === 1).map((b) => b.name).join(', ')}`);
    console.log(`warm-up after unlock: ${Math.round(warm.ms)} ms · unlock-click task ${warm.unlockTaskMs.join(', ') || '<50'} ms (browser audio-device init) · other long tasks: ${warm.otherLongTasksMs.length ? warm.otherLongTasksMs.join(', ') + ' ms' : 'none'} · of them our script: ${warm.longScripts.length ? warm.longScripts.join(', ') : 'none'}`);
    console.log(`bank keys ${cost.banked} · play() cost median/max (ms): ${Object.entries(cost.cost).map(([n, c]: [string, Any]) => `${n} ${c.median.toFixed(2)}/${c.max.toFixed(2)}`).join(', ')}`);
    console.log(`live: ${JSON.stringify({ state: live.state, playedAll: live.playedAll, hover: live.hoverPlayed, sameFrame: live.sameFrameRoutine, shakeWon: live.shakeWon, inBeat: live.inBeat, spamVoices: live.spam.voicesByName, droppedBySpam: live.droppedBySpam, musicDefault: live.musicDefault, muted: live.musicWhileMuted, hidden: live.hidden, shown: live.shown })}`);
    console.log(failures.length ? `\nFAIL (${failures.length})\n  ${failures.join('\n  ')}` : '\nPASS — all audio checks');
  } finally {
    await browser.close();
    if (server?.pid) {
      try {
        process.kill(-server.pid);
      } catch {
        /* already gone */
      }
    }
  }
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
