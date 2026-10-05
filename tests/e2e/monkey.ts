// Couch-monkey soak (a tool, not in the suite): plays whole games at real speed (1×, AI watch) the way
// impatient friends do — legal clicks mixed with double clicks, nonsense clicks, key spam, menu flips,
// camera drags, resizes and hidden-tab stretches — and watches for crashes, hangs and HUD/board drift.
//
//   RISK_URL=http://127.0.0.1:5330/ npx tsx tests/e2e/monkey.ts [games=4] [parallel=2] [firstSeed=1]
//   MONKEY_MODE=1h3ai|2h|3h|4h|2h2ai|mix (default mix) MONKEY_MINUTES=12 (per game cap)
//
// Each game is seeded: the seed picks the seats, the game seed, and the monkey's input stream. Failures
// print the seed, the last inputs and a screenshot path under artifacts/monkey/.

import { chromium, type Browser, type Page } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { TERRITORY_IDS, type GameState } from '../../src/engine';
import { PLAYER_COLORS } from '../../src/shared/palette';

const BASE = process.env.RISK_URL ?? 'http://127.0.0.1:5290/';
const ART = 'artifacts/monkey';
mkdirSync(ART, { recursive: true });
const GAMES = Number(process.argv[2] ?? 4);
const PAR = Number(process.argv[3] ?? 2);
const FIRST = Number(process.argv[4] ?? 1);
const MODE = process.env.MONKEY_MODE ?? 'mix';
const MINUTES = Number(process.env.MONKEY_MINUTES ?? 12);
const CHAOS = Number(process.env.MONKEY_CHAOS ?? 1); // 0 = legal-ish only, 1 = default mess

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Mode = '1h3ai' | '2h' | '3h' | '4h' | '2h2ai';
const MODES: Mode[] = ['1h3ai', '2h', '3h', '4h', '2h2ai'];
const COLORS = ['crimson', 'cobalt', 'amber', 'emerald'] as const;
function seats(mode: Mode) {
  const kinds: ('human' | 'ai')[] =
    mode === '1h3ai' ? ['human', 'ai', 'ai', 'ai'] : mode === '2h' ? ['human', 'human'] : mode === '3h' ? ['human', 'human', 'human'] : mode === '4h' ? ['human', 'human', 'human', 'human'] : ['human', 'ai', 'human', 'ai'];
  return kinds.map((k, i) => ({ name: ['John', 'Sam', 'Ana', 'Lee'][i], color: COLORS[i], kind: k, ...(k === 'ai' ? { difficulty: 'normal' } : {}) }));
}

interface Snap {
  screen: string;
  overlay: boolean;
  handoff: boolean;
  confirm: boolean;
  idle: boolean;
  human: boolean;
  phase: string;
  turn: number;
  round: number;
  cur: number;
  key: string;
  /** Strip buttons plus Turn Track segments the player can click now. */
  enabledButtons: number;
  clickable: number;
  hidden: boolean;
  errs: string[];
  ctxLost: number;
}

interface Result {
  seed: number;
  mode: Mode;
  ok: boolean;
  finished: boolean;
  reason: string;
  inputs: number;
  turns: number;
  ms: number;
  log: string[];
}

async function snap(page: Page): Promise<Snap> {
  return page.evaluate(() => {
    const r = window.__risk;
    const s = r.getState();
    const u = r.ui();
    const m = (window as unknown as { __monkey: { errs: string[]; ctxLost: number } }).__monkey;
    const errs = m.errs.splice(0);
    const q = (sel: string) => !!document.querySelector(sel);
    const human = !!s && s.phase.kind !== 'game-over' && s.players[s.currentPlayer].kind === 'human';
    let clickable = 0;
    if (s && human) for (const t of Object.keys(s.territories)) if (r.explain(t as never).ok) clickable++;
    return {
      screen: u.screen,
      overlay: q('[data-testid="pause"]') || q('[data-testid="rules"]') || q('[data-testid="settings"]'),
      handoff: q('[data-testid="handoff"]'),
      confirm: q('[data-testid="confirm-yes"]') && !!(document.querySelector('[data-testid="confirm-yes"]') as HTMLElement).offsetParent,
      idle: r.isIdle(),
      human,
      phase: s?.phase.kind ?? '',
      turn: s?.turn ?? -1,
      round: s?.round ?? -1,
      cur: s?.currentPlayer ?? -1,
      key: s ? `${s.turn}:${s.currentPlayer}:${s.phase.kind}:${JSON.stringify(s.territories).length}:${Object.values(s.territories).reduce((a, t) => a + t.armies * 7 + t.owner, 0)}` : '',
      enabledButtons: u.buttons.length + (u.trackLive && !u.trackDisabled ? u.track.filter((x) => x.startsWith('eligible:')).length : 0),
      clickable,
      hidden: document.visibilityState === 'hidden',
      errs,
      ctxLost: m.ctxLost,
    };
  });
}

/** Board badges vs engine state, once everything has settled. */
async function boardDrift(page: Page): Promise<string | null> {
  const r = await page.evaluate(() => {
    const s = window.__risk.getState();
    // The renderer's own owners/armies (what pieces and badges are drawn from); badges off-screen are
    // culled, so their visibility says nothing.
    const dbg = (window.__board as unknown as { __debug?: { owners: Record<string, number>; armies: Record<string, number> } } | undefined)?.__debug;
    const badges = [...document.querySelectorAll('.rb-badge')].map((b) => ({
      n: (b.querySelector('.n') as HTMLElement).textContent,
      ring: (b as HTMLElement).style.getPropertyValue('--ring'),
    }));
    const strip = !!document.querySelector('[data-testid="strip"]');
    return { s, badges, strip, owners: dbg ? { ...dbg.owners } : null, armies: dbg ? { ...dbg.armies } : null };
  });
  const s = r.s as GameState | null;
  if (!s || s.phase.kind === 'game-over') return null;
  if (!r.badges.length || !r.owners || !r.armies) return null; // stub board
  const bad: string[] = [];
  TERRITORY_IDS.forEach((t, i) => {
    const b = r.badges[i];
    const ts = s.territories[t];
    if (r.owners![t] !== ts.owner) bad.push(`${t} board owner ${r.owners![t]} vs state ${ts.owner}`);
    if (r.armies![t] !== ts.armies) bad.push(`${t} board armies ${r.armies![t]} vs state ${ts.armies}`);
    if (!b || ts.armies <= 0) return;
    const want = PLAYER_COLORS[s.players[ts.owner]?.color as keyof typeof PLAYER_COLORS]?.base;
    if (b.n !== String(ts.armies)) bad.push(`${t} badge ${b.n} vs state ${ts.armies}`);
    if (want && b.ring && b.ring.toLowerCase() !== want.toLowerCase()) bad.push(`${t} ring ${b.ring} vs owner ${s.players[ts.owner].name}`);
  });
  if (!r.strip) bad.push('no bottom strip on the game screen');
  return bad.length ? bad.slice(0, 6).join('; ') : null;
}

async function playGame(browser: Browser, seed: number): Promise<Result> {
  const R = rng(seed * 7919 + 13);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(R() * xs.length)];
  const mode: Mode = MODE === 'mix' ? MODES[seed % MODES.length] : (MODE as Mode);
  const players = seats(mode);
  const t0 = Date.now();
  const log: string[] = [];
  const note = (s: string) => {
    log.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);
    if (log.length > 400) log.shift();
  };
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('console', (m) => {
    // Chrome's own audio-device failure under heavy machine load is not the game's.
    if (m.type() === 'error' && !m.text().includes('AudioContext encountered an error')) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e.stack ?? e)));
  page.on('crash', () => errors.push('PAGE CRASH'));
  await page.addInitScript(() => {
    const w = window as unknown as { __name: unknown; __monkey: { errs: string[]; ctxLost: number } };
    w.__name = (f: unknown) => f;
    w.__monkey = { errs: [], ctxLost: 0 };
    window.addEventListener('unhandledrejection', (e) => w.__monkey.errs.push('unhandledrejection: ' + String((e.reason && e.reason.stack) || e.reason)));
    window.addEventListener('error', (e) => w.__monkey.errs.push('error: ' + e.message));
    document.addEventListener('webglcontextlost', () => w.__monkey.ctxLost++, true);
    // Hidden-tab simulation (headless tabs never report hidden): rAF stops, timers keep running.
    let hidden = false;
    const held: FrameRequestCallback[] = [];
    const raf0 = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => {
      if (hidden) {
        held.push(cb);
        return -1;
      }
      return raf0(cb);
    };
    Object.defineProperty(document, 'visibilityState', { get: () => (hidden ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { get: () => hidden });
    (window as unknown as { __setHidden: (h: boolean) => void }).__setHidden = (h: boolean) => {
      hidden = h;
      document.dispatchEvent(new Event('visibilitychange'));
      if (!h) for (const cb of held.splice(0)) raf0(cb);
    };
  });
  await page.goto(BASE, { timeout: 120_000 });
  await page.waitForFunction(() => !!window.__risk, null, { timeout: 120_000 });
  // (v5.1 A: no 'Hide cards between turns' setting and no hand-off cover; one draw kept so seeds replay the same)
  if (mode !== '1h3ai') R();
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('risk3d.settings.v1', JSON.stringify({ animationSpeed: 1, aiSpeed: 'watch' }));
  });
  await page.reload({ timeout: 120_000 });
  await page.waitForFunction(() => !!window.__risk, null, { timeout: 120_000 });
  const turnLimit = 4 + Math.floor(R() * 5);
  const manual = R() < 0.25;
  await page.evaluate(
    ([p, sd, tl, man]) => window.__risk.newGame({ players: p as never, seed: sd, dominationPercent: 60, turnLimit: tl, initialPlacement: man ? 'manual' : 'auto' }),
    [players, seed, turnLimit, manual] as const,
  );
  note(`start seed=${seed} mode=${mode} turnLimit=${turnLimit} manual=${manual}`);

  let inputs = 0;
  let reason = '';
  let finished = false;
  let lastKey = '';
  let lastKeyAt = Date.now();
  let busySince = 0;
  let stuckSince = 0;
  let checks = 0;
  const vp = { w: 1440, h: 900 };
  const fail = async (why: string) => {
    reason = why;
    const shot = `${ART}/fail-${seed}.png`;
    await page.screenshot({ path: shot }).catch(() => undefined);
    const st = await page.evaluate(() => ({ s: window.__risk.getState(), ui: window.__risk.ui(), idle: window.__risk.isIdle() })).catch(() => null);
    writeFileSync(`${ART}/fail-${seed}.json`, JSON.stringify({ why, log, st }, null, 1));
  };

  const clickAt = async (x: number, y: number, button: 'left' | 'right' = 'left', mods: string[] = [], count = 1) => {
    for (const m of mods) await page.keyboard.down(m);
    await page.mouse.click(x, y, { button, clickCount: count, delay: R() < 0.5 ? 0 : 20 });
    for (const m of mods) await page.keyboard.up(m);
  };
  const tilePos = async (legal: boolean) =>
    page.evaluate((lg) => {
      const r = window.__risk;
      const s = r.getState();
      if (!s) return null;
      const ids = Object.keys(s.territories).filter((t) => !lg || r.explain(t as never).ok);
      if (!ids.length) return null;
      const t = ids[Math.floor(Math.random() * ids.length)];
      const p = r.screenPos(t as never);
      return p ? { t, ...p } : null;
    }, legal);
  const buttons = async () =>
    page.evaluate(() =>
      [...document.querySelectorAll('#ui button, #ui [role="button"]')]
        .filter((b) => {
          const e = b as HTMLElement;
          if ((b as HTMLButtonElement).disabled || !e.offsetParent) return false;
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .map((b) => {
          const r = (b as HTMLElement).getBoundingClientRect();
          return { id: (b as HTMLElement).dataset.testid ?? '', text: (b.textContent ?? '').trim().slice(0, 30), x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }),
    );
  const DANGER = /pause-quit|pause-restart|pause-endgame|humans-out-end|victory-|title-|ng-|seat-|add-seat|house/;

  async function act(): Promise<void> {
    const roll = R();
    inputs++;
    if (roll < 0.3) {
      const p = await tilePos(true);
      if (!p) return;
      const dbl = R() < 0.15;
      note(`legal ${dbl ? 'dbl' : ''}click ${p.t}`);
      await clickAt(p.x, p.y, 'left', R() < 0.1 ? [pick(['Shift', 'Alt'])] : [], dbl ? 2 : 1);
    } else if (roll < 0.42 * CHAOS + 0.3 * (1 - CHAOS) + 0.001) {
      const p = await tilePos(false);
      if (!p) return;
      const right = R() < 0.3;
      note(`random ${right ? 'right' : ''}click ${p.t}`);
      await clickAt(p.x, p.y, right ? 'right' : 'left');
    } else if (roll < 0.64) {
      const bs = await buttons();
      if (!bs.length) return;
      let b = pick(bs);
      if (DANGER.test(b.id) && R() > 0.04 * CHAOS) b = pick(bs.filter((x) => !DANGER.test(x.id)).concat(bs.filter((x) => /confirm-no|pause-resume/.test(x.id))));
      if (!b) return;
      if (DANGER.test(b.id) && /victory-|title-|ng-|seat-|add-seat|house/.test(b.id)) return;
      const dbl = R() < 0.12;
      note(`button ${b.id || b.text}${dbl ? ' x2' : ''}`);
      await clickAt(b.x, b.y, 'left', [], 1);
      if (dbl) await clickAt(b.x, b.y, 'left', [], 1);
    } else if (roll < 0.8) {
      const k = pick(['Enter', 'Enter', ' ', ' ', 'Escape', 'e', 'b', '1', '2', '3', 'Tab', 'Shift+Tab', 'f', '?', 'l', 'Escape']);
      note(`key ${k}`);
      await page.keyboard.press(k);
    } else if (roll < 0.86 * CHAOS + 0.8 * (1 - CHAOS) + 0.001) {
      note('burst');
      for (let i = 0; i < 4 + Math.floor(R() * 10); i++) {
        const r2 = R();
        if (r2 < 0.4) {
          const p = await tilePos(r2 < 0.3);
          if (p) await clickAt(p.x, p.y);
        } else if (r2 < 0.7) await page.keyboard.press(pick(['Enter', ' ', 'e', 'b', 'Escape']));
        else {
          const bs = (await buttons()).filter((x) => !DANGER.test(x.id));
          if (bs.length) {
            const b = pick(bs);
            await clickAt(b.x, b.y);
          }
        }
        if (R() < 0.5) await page.waitForTimeout(Math.floor(R() * 25));
      }
    } else if (roll < 0.91) {
      const x = 300 + R() * 800;
      const y = 200 + R() * 400;
      if (R() < 0.5) {
        note('drag orbit');
        await page.mouse.move(x, y);
        await page.mouse.down({ button: R() < 0.7 ? 'left' : 'right' });
        for (let i = 1; i <= 6; i++) await page.mouse.move(x + i * (R() * 40 - 20), y + i * (R() * 30 - 15));
        await page.mouse.up({ button: 'left' }).catch(() => undefined);
        await page.mouse.up({ button: 'right' }).catch(() => undefined);
      } else {
        note('wheel');
        await page.mouse.move(x, y);
        await page.mouse.wheel(0, R() * 800 - 400);
      }
    } else if (roll < 0.93 && CHAOS) {
      const sizes = [
        [1440, 900],
        [1280, 720],
        [1920, 1080],
        [1024, 700],
        [800, 600],
        [1600, 1000],
      ];
      const [w, h] = pick(sizes);
      vp.w = w;
      vp.h = h;
      note(`resize ${w}x${h}`);
      await page.setViewportSize({ width: w, height: h });
    } else if (roll < 0.935 && CHAOS) {
      const ms = 500 + Math.floor(R() * 6000);
      note(`hide tab ${ms}ms`);
      await page.evaluate(() => (window as unknown as { __setHidden: (h: boolean) => void }).__setHidden(true));
      await page.waitForTimeout(ms);
      await page.evaluate(() => (window as unknown as { __setHidden: (h: boolean) => void }).__setHidden(false));
    } else if (roll < 0.95) {
      // settings flips mid-game through the real settings screen are covered by random buttons; this
      // path pokes the speed setters the same way the top-bar toggle does.
      const bs = (await buttons()).filter((b) => /aispeed|ai-speed|speed/i.test(b.id));
      if (bs.length) {
        const b = pick(bs);
        note(`speed toggle ${b.id}`);
        await clickAt(b.x, b.y);
      }
    } else {
      // Progress, so games end: Enter (the brass thing), or a click on the Turn Track's recommended
      // segment, else End turn / Done (the track is the only phase control, docs/ROUND2.md §A).
      if (R() < 0.4) {
        const k = pick(['Enter', 'Enter', ' ']);
        note(`progress ${k}`);
        await page.keyboard.press(k);
      } else {
        const b = await page.evaluate(() => {
          const vis = (e: Element | null) => !!e && (e as HTMLElement).offsetParent !== null && e.getAttribute('aria-disabled') !== 'true';
          const rec = document.querySelector('[data-testid="track"] .tr-seg.is-rec');
          const el = vis(rec) ? rec : ['seg-endTurn', 'seg-done', 'seg-attack'].map((id) => document.querySelector(`[data-testid="${id}"]`)).find((e) => vis(e) && e!.classList.contains('is-eligible'));
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { id: (el as HTMLElement).dataset.testid ?? '', x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        if (!b) return;
        note(`progress ${b.id}`);
        await clickAt(b.x, b.y);
      }
    }
  }

  const deadline = t0 + MINUTES * 60_000;
  let lastSnap: Snap | null = null;
  try {
    while (Date.now() < deadline) {
      let sn: Snap;
      try {
        sn = await snap(page);
      } catch (e) {
        await fail('snapshot threw: ' + String(e));
        break;
      }
      lastSnap = sn;
      if (sn.errs.length) errors.push(...sn.errs);
      if (errors.length) {
        await fail('errors: ' + errors.slice(0, 5).join(' | '));
        break;
      }
      if (sn.ctxLost) {
        await fail('webglcontextlost');
        break;
      }
      if (sn.screen === 'victory') {
        finished = true;
        note('victory');
        break;
      }
      if (sn.screen === 'title') {
        // Save & quit / Title: come back the way a player would.
        note('title → continue');
        const c = page.locator('[data-testid="title-continue"]');
        if (await c.count()) await c.click().catch(() => undefined);
        else {
          await fail('back on the title with no Continue (save lost)');
          break;
        }
        await page.waitForTimeout(300);
        continue;
      }
      if (sn.screen === 'newGame') {
        await page.keyboard.press('Escape');
        continue;
      }
      const now = Date.now();
      if (sn.key !== lastKey) {
        lastKey = sn.key;
        lastKeyAt = now;
      }
      // AI turns must keep moving (cap is 10 s); a human turn is only on the clock while idle-less.
      if (!sn.human && !sn.overlay && !sn.confirm && !sn.handoff && now - lastKeyAt > 30_000 && !sn.hidden) {
        await fail(`AI turn frozen 30 s (phase ${sn.phase}, player ${sn.cur}, idle ${sn.idle})`);
        break;
      }
      if (sn.human && !sn.idle && !sn.overlay && !sn.handoff) {
        if (!busySince) busySince = now;
        if (now - busySince > 15_000) {
          await fail(`human turn not idle for 15 s (phase ${sn.phase})`);
          break;
        }
      } else busySince = 0;
      if (sn.human && sn.idle && !sn.overlay && !sn.handoff && !sn.confirm && sn.enabledButtons === 0 && sn.clickable === 0) {
        if (!stuckSince) stuckSince = now;
        if (now - stuckSince > 3000) {
          await fail(`stuck: human turn, idle, no enabled button and no clickable tile (phase ${sn.phase})`);
          break;
        }
      } else stuckSince = 0;
      // v5.1 A: the hand-off cover is gone; one showing up is a failure.
      if (sn.handoff) {
        await fail('a hand-off cover appeared (v5.1 removed it)');
        break;
      }
      // Quiet check every ~25 inputs on a human turn: let it settle, then compare board vs state.
      if (sn.human && inputs > 0 && inputs % 25 === 0 && checks < inputs / 25) {
        checks++;
        await page.keyboard.press('Escape').catch(() => undefined);
        const settled = await page
          .waitForFunction(() => window.__risk.isIdle(), null, { timeout: 15_000 })
          .then(() => true)
          .catch(() => false);
        if (!settled) {
          const s2 = await snap(page);
          if (s2.human) {
            await fail('did not settle within 15 s on a human turn');
            break;
          }
        } else {
          await page.waitForTimeout(600);
          const s2 = await snap(page);
          if (s2.human && s2.idle && s2.screen === 'game') {
            const d = await boardDrift(page);
            if (d) {
              await page.waitForTimeout(1500);
              const d2 = await boardDrift(page);
              if (d2) {
                await fail('board/state drift: ' + d2);
                break;
              }
            }
          }
        }
      }
      if (sn.human || R() < 0.35) await act();
      await page.waitForTimeout(sn.human ? Math.floor(R() * 120) : 80 + Math.floor(R() * 300));
    }
    if (!finished && !reason) {
      await fail(`timeout after ${MINUTES} min (round ${lastSnap?.round}, phase ${lastSnap?.phase})`);
    }
  } catch (e) {
    await fail('harness threw: ' + String((e as Error).stack ?? e));
  }
  const turns = lastSnap?.turn ?? -1;
  await ctx.close().catch(() => undefined);
  return { seed, mode, ok: finished && !reason, finished, reason, inputs, turns, ms: Date.now() - t0, log };
}

const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio'] });
const seeds = Array.from({ length: GAMES }, (_, i) => FIRST + i);
const results: Result[] = [];
let next = 0;
async function worker() {
  while (next < seeds.length) {
    const seed = seeds[next++];
    const r = await playGame(browser, seed).catch(
      (e): Result => ({ seed, mode: '1h3ai', ok: false, finished: false, reason: 'harness: ' + String(e).slice(0, 300), inputs: 0, turns: -1, ms: 0, log: [] }),
    );
    results.push(r);
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} seed ${r.seed} ${r.mode} · ${r.inputs} inputs · turn ${r.turns} · ${Math.round(r.ms / 1000)} s${r.reason ? ' · ' + r.reason : ''}`);
    if (!r.ok) console.log('   last inputs:\n     ' + r.log.slice(-25).join('\n     '));
  }
}
await Promise.all(Array.from({ length: PAR }, worker));
await browser.close();
const fails = results.filter((r) => !r.ok);
console.log(`\n${results.length - fails.length}/${results.length} games clean, ${results.reduce((a, r) => a + r.inputs, 0)} inputs`);
process.exit(fails.length ? 1 : 0);
