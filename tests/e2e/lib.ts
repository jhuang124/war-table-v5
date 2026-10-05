// Shared Playwright helpers for the e2e flows. `npm run test:e2e` builds the game (VITE_E2E=1), serves it
// and runs every flow against the REAL board (src/render) and REAL HUD (src/ui); lanes, speeds and the
// quick tier live in tests/e2e/lanes.ts. Run one flow by hand against any server (dev or `vite preview`):
//   npx vite --port 5290 --strictPort --host 127.0.0.1 &   npx tsx tests/e2e/<flow>.e2e.ts
// RISK_URL overrides the server; RISK_QUERY adds URL flags (e.g. '?stub&debughud' for the stand-ins);
// E2E_SPEED=instant|real overrides the flow's lane speed (a logic flow run by hand is instant too).
// Clicks go through real pointer events at __risk.screenPos(t).

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { speedOf, type Speed } from './lanes';

export const BASE = process.env.RISK_URL ?? 'http://127.0.0.1:5290/';
/** URL flags for every flow; '' = the real renderer + real UI. */
export const Q = process.env.RISK_QUERY ?? '';
export const ART = 'artifacts/e2e';
mkdirSync(ART, { recursive: true });

export const GPU_ARGS = ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio'];

/**
 * The speed this flow runs at. The runner passes E2E_SPEED from lanes.ts; a flow run by hand looks itself
 * up there, so it runs the way the suite runs it. Tools that aren't in lanes.ts (screens, perf) run real.
 */
export const SPEED: Speed = (() => {
  const env = process.env.E2E_SPEED;
  if (env === 'instant' || env === 'real') return env;
  if (env) throw new Error(`E2E_SPEED must be instant or real (got ${env})`);
  return speedOf(basename(process.argv[1] ?? '').replace(/\.e2e\.ts$/, ''));
})();

export interface Ctx {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  errors: string[];
}

/**
 * A Chromium for one open(): the runner's shared browser for this worker when it hands one over (E2E_WS;
 * close() then only disconnects and drops this flow's contexts), else a fresh launch (a flow run by hand,
 * and the timing lane, where every open() gets a cold GPU process like a player's first load).
 */
export async function launchBrowser(): Promise<Browser> {
  const ws = process.env.E2E_WS;
  return ws ? chromium.connect(ws) : chromium.launch({ args: GPU_ARGS });
}

// Instant speed, pinned in the page before the game boots: every load starts with animation speed 0 and
// AI 'instant' in the saved settings (other settings are kept), and __risk.setSpeed() calls are held at
// instant, until realtime() sets the tab's opt-out flag. Speed changes made in the Settings UI aren't pinned.
const PIN = `(() => {
  const REAL = 'risk3d.e2e.realtime';
  try { if (sessionStorage.getItem(REAL)) return; } catch { return; }
  try {
    const k = 'risk3d.settings.v1';
    const s = JSON.parse(localStorage.getItem(k) || 'null') || {};
    localStorage.setItem(k, JSON.stringify({ ...s, animationSpeed: 0, aiSpeed: 'instant' }));
  } catch {}
  let hooks;
  Object.defineProperty(window, '__risk', {
    configurable: true,
    enumerable: true,
    get: () => hooks,
    set: (h) => {
      if (h && typeof h.setSpeed === 'function' && !h.__realSetSpeed) {
        const real = h.setSpeed;
        h.__realSetSpeed = real;
        h.setSpeed = (a, ai) => (sessionStorage.getItem(REAL) ? real(a, ai) : real(0, 'instant'));
      }
      hooks = h;
    },
  });
})()`;

let saidSpeed = false;
/** What every flow's browser context gets: the tsx __name shim, and the lane's speed pin. */
export async function prepareContext(context: BrowserContext): Promise<void> {
  // tsx (esbuild keepNames) wraps named functions inside page.evaluate callbacks in __name(); give the
  // page a no-op so callbacks can use local helper functions.
  await context.addInitScript('window.__name = (f) => f');
  if (SPEED !== 'instant') return;
  await context.addInitScript(PIN);
  if (!saidSpeed) console.log('(instant speed: a logic-lane flow, tests/e2e/lanes.ts; E2E_SPEED=real runs it at 1x)');
  saidSpeed = true;
}

/**
 * Real speed (1×, AI watch) for the rest of this page's life, reloads included: for the few checks in a
 * logic-lane flow that need real animations. A no-op when the flow already runs at real speed.
 */
export async function realtime(page: Page): Promise<void> {
  if (SPEED !== 'instant') return;
  await page.evaluate(() => {
    sessionStorage.setItem('risk3d.e2e.realtime', '1');
    (window.__risk as unknown as { __realSetSpeed?: (a: number, ai?: string) => void }).__realSetSpeed?.(1, 'watch');
  });
}

export async function open(query = Q, viewport = { width: 1440, height: 900 }, deviceScaleFactor = 1): Promise<Ctx> {
  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport, deviceScaleFactor });
  await prepareContext(context);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE + query);
  await page.waitForFunction(() => !!(window as unknown as { __risk?: unknown }).__risk);
  return { browser, context, page, errors };
}

export async function clearStorage(page: Page): Promise<void> {
  await page.evaluate(() => localStorage.clear());
}

/** Real pointer click at a territory's army piece. A board click only ever selects (docs/ROUND2.md §B). */
export async function clickT(page: Page, t: string): Promise<void> {
  const pos = await page.evaluate((id) => window.__risk.screenPos(id as never), t);
  if (!pos) throw new Error(`no screen position for ${t}`);
  await page.mouse.click(pos.x, pos.y);
}

/**
 * Click a Turn Track segment: 'place' | 'attack' | 'fortify' | 'endTurn' | 'setup' | 'done'. Waits for
 * it to be clickable (a disabled track, e.g. during a roll, holds the click) unless `force`.
 */
export async function seg(page: Page, id: string, force = false): Promise<void> {
  await page.locator(`[data-testid="seg-${id}"]`).first().click(force ? { force: true } : undefined);
}

/**
 * Set the one count control to `n` by mouse: the − / + stepper (≤ 6 options), or a click on the slider
 * track at n's position (> 6), nudged a pixel at a time until it reads n.
 */
export async function setCount(page: Page, n: number): Promise<void> {
  const c = (await ui(page)).count;
  if (!c) throw new Error('no count control');
  await expandCount(page);
  if (c.control === 'stepper') {
    await page.locator('[data-testid="count-inc"]').waitFor({ state: 'visible', timeout: 3000 });
    let v = c.value;
    while (v > n) {
      await clickBtn(page, 'count-dec');
      v--;
    }
    while (v < n) {
      await clickBtn(page, 'count-inc');
      v++;
    }
    return;
  }
  const track = page.locator('[data-testid="count-slider"] .cs-track');
  await track.waitFor({ state: 'visible', timeout: 3000 });
  const box = await track.boundingBox();
  if (!box) throw new Error('no slider track');
  const k = c.max > c.min ? (n - c.min) / (c.max - c.min) : 1;
  let x = box.x + k * box.width;
  const y = box.y + box.height / 2;
  for (let i = 0; i < 12; i++) {
    await page.mouse.click(x, y);
    const v = (await ui(page)).count?.value ?? n;
    if (v === n) return;
    x += (n - v) * Math.max(1, box.width / Math.max(1, c.max - c.min) / 3);
  }
  throw new Error(`slider did not reach ${n}`);
}

/**
 * v5.1 E2: a collapsed count (occupy: all-but-one already chosen) shows only its number (`count-expand`);
 * a touch opens the stepper / slider. Opens it when it shows; true if it did.
 */
export async function expandCount(page: Page): Promise<boolean> {
  const w = page.locator('[data-testid="count-expand"]').first();
  if (!(await w.isVisible().catch(() => false))) return false;
  await w.click();
  await page.waitForTimeout(60);
  return true;
}

/**
 * v3 diplomacy: a truce offer to the driver takes the dock (Decline / Accept) until it's answered, as a
 * player would answer it first. Answers it (Decline by default) when one is showing; no-op otherwise.
 */
/** v5.1 C: the human truce protocol went (no offers, no Accept / Decline). Kept for older flows: a no-op. */
export async function answerOffer(_page: Page, _accept = false): Promise<boolean> {
  return false;
}

/** Place: pick `t`, set the count to `n` (default: all), press Place. (A truce offer showing is declined first.) */
/** v4: the "While you were away" receipt takes the first tap; put it away through the hook before acting. */
export async function dismissReceipt(page: Page): Promise<boolean> {
  const had = await page.evaluate(() => {
    const r = window.__risk as unknown as { receipt?: () => unknown; dismissReceipt?: () => void };
    if (r.receipt?.()) {
      r.dismissReceipt?.();
      return true;
    }
    return false;
  });
  if (had) {
    await page.waitForFunction(() => window.__risk.isIdle(), null, { timeout: 3000 }).catch(() => undefined);
    // the sheet lifts off over ~400 ms; a click under it before that is lost
    await page.waitForTimeout(500);
  }
  return had;
}

export async function place(page: Page, t: string, n?: number): Promise<void> {
  await dismissReceipt(page);
  await answerOffer(page);
  await clickT(page, t);
  // v4: the first click after the receipt / turn line can land in the board's settle; one retry
  const got = await page.waitForFunction(() => !!window.__risk.ui().count, null, { timeout: 2500 }).then(() => true, () => false);
  if (!got) {
    await page.waitForTimeout(400);
    await clickT(page, t);
    await page.waitForFunction(() => !!window.__risk.ui().count, null, { timeout: 3000 }).catch(async (e) => {
      const u = await ui(page);
      throw new Error(`place(${t}): no count control (line "${u.line}", buttons ${u.buttons.join('/') || 'none'}, step ${u.step}): ${e}`);
    });
  }
  if (n !== undefined) await setCount(page, n);
  await clickBtn(page, 'btn-place');
}

export async function clickBtn(page: Page, testid: string): Promise<void> {
  // v4: the receipt covers the strip until it is put away (a human's first tap does that)
  await dismissReceipt(page);
  await page.locator(`[data-testid="${testid}"]`).first().click();
}

export async function idle(page: Page, ms = 20000): Promise<void> {
  await page.evaluate((t) => window.__risk.waitIdle(t), ms);
}

export async function ui(page: Page) {
  return page.evaluate(() => window.__risk.ui());
}

export async function state(page: Page) {
  return page.evaluate(() => window.__risk.getState());
}

export function check(cond: unknown, msg: string, results: string[]): void {
  const line = `${cond ? 'PASS' : 'FAIL'} ${msg}`;
  results.push(line);
  console.log(line);
}

export function finish(results: string[], errors: string[]): never {
  const fails = results.filter((r) => r.startsWith('FAIL'));
  if (errors.length) console.log('Console errors:\n  ' + errors.join('\n  '));
  console.log(`\n${results.length - fails.length}/${results.length} passed, ${errors.length} console errors`);
  process.exit(fails.length || errors.length ? 1 : 0);
}

export const ONE_HUMAN = [
  { name: 'John', color: 'crimson', kind: 'human' },
  { name: 'Cobalt', color: 'cobalt', kind: 'ai', difficulty: 'normal' },
  { name: 'Amber', color: 'amber', kind: 'ai', difficulty: 'normal' },
  { name: 'Emerald', color: 'emerald', kind: 'ai', difficulty: 'normal' },
];

export const TWO_HUMANS = [
  { name: 'John', color: 'crimson', kind: 'human' },
  { name: 'Sam', color: 'cobalt', kind: 'human' },
];

// ---------------------------------------------------------------------------
// Scenarios: build a GameState in Node, save it, reload, press Continue (the real resume path).
// ---------------------------------------------------------------------------

import { TERRITORY_IDS, createGame, type GameState, type Phase, type TerritoryId } from '../../src/engine';

export function scenario(
  own: Partial<Record<TerritoryId, [number, number]>>,
  phase: Phase,
  opts: { players?: typeof ONE_HUMAN; fill?: (t: TerritoryId, i: number) => [number, number]; mutate?: (s: GameState) => void } = {},
): GameState {
  const { state } = createGame({
    players: (opts.players ?? ONE_HUMAN) as never,
    setupMode: 'random',
    initialPlacement: 'auto',
    setupBatch: 5,
    cardBonus: 'progressive',
    fortifyRule: 'connected',
    dominationPercent: 70,
    turnLimit: null,
    seed: 1234,
  });
  const n = state.players.length;
  TERRITORY_IDS.forEach((t, i) => {
    state.territories[t] = opts.fill ? { owner: opts.fill(t, i)[0], armies: opts.fill(t, i)[1] } : { owner: 1 + (i % (n - 1)), armies: 1 };
  });
  for (const [t, v] of Object.entries(own)) state.territories[t as TerritoryId] = { owner: v![0], armies: v![1] };
  state.currentPlayer = 0;
  state.firstPlayer = 0;
  state.phase = phase;
  state.round = 2;
  state.turn = 5;
  state.conqueredThisTurn = false;
  for (const p of state.players) {
    p.cards = [];
    p.setupArmies = 0;
  }
  opts.mutate?.(state);
  return state;
}

export async function loadScenario(page: Page, s: GameState, opts: { waitIdle?: boolean; settings?: Record<string, unknown> } = {}): Promise<void> {
  await page.evaluate(
    ([st, settings]) => {
      localStorage.clear();
      localStorage.setItem('risk3d.save.v1', JSON.stringify({ v: 1, savedAt: Date.now(), state: st }));
      if (settings) localStorage.setItem('risk3d.settings.v1', JSON.stringify(settings));
    },
    [s as unknown as Record<string, unknown>, opts.settings ?? null] as const,
  );
  await page.reload();
  await page.waitForFunction(() => !!window.__risk);
  await page.locator('[data-testid="title-continue"]').click();
  await page.waitForFunction(() => window.__risk.ui().screen === 'game' && !!window.__risk.getState());
  const loaded = await page.evaluate(() => window.__risk.getState()?.id);
  if (loaded !== s.id) console.log(`   (scenario ${s.id} did not load; the page has ${loaded})`);
  if (opts.waitIdle === false) return;
  await idle(page);
  await rendered(page);
  await page.evaluate(() => window.__risk.resetMetrics());
}

/** Wait until the HUD has painted the game screen (the first frames after a reload can lag). */
export async function rendered(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const hud = document.querySelector('[data-hud="debug"]');
    if (!hud) return !!document.querySelector('#ui *:not(#boot-splash)');
    return !!document.querySelector('[data-testid="strip"]');
  });
  // The real board eases from the attract orbit to the home view on Continue/Start; board events wait
  // for that move, so let it land before a flow starts timing things.
  await page.waitForFunction(() => !window.__risk.stats().cameraMoving, null, { timeout: 5000 }).catch(() => undefined);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}
