// Long-session soak (a tool, not in the suite): full games at REAL speed (animation 1×, AI 'watch') on the
// real board + HUD, the human seats played through real pointer events at __risk.screenPos and the
// data-testid buttons, with every failure mode a player would call a "crash" instrumented:
//   JS errors / unhandled rejections / console.error, WebGL context loss, a board event whose promise
//   hangs (> 5 s), __risk.isIdle() false > 15 s, an AI turn whose player/phase doesn't move in 60 s, a
//   human state with no enabled button and no clickable tile, a bot move the game ignores, JS heap growth
//   across a session (several games in one page via Rematch), long frames, and reload/resume
//   mid-everything (mid-blitz, mid-occupy, mid-AI-turn, mid-forced-trade, victory).
//
// Needs a dev server: RISK_E2E=1 npx vite --port 5320 --strictPort &
//   RISK_URL=http://127.0.0.1:5320/ npx tsx tests/e2e/soak.ts [--games 30] [--parallel 5] [--seed 1]
//     [--only human|auto|mix] [--reloads 0|1] [--length quick|evening|full] [--out artifacts/soak]
// One JSON line per game in <out>/results.jsonl; a failure dumps <out>/fail-<game>.json (seed, config,
// bot action log, recent states, the save, the HUD).

import { chromium, type Browser, type Page } from 'playwright';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { seg as segClick, setCount } from './lib';

const BASE = process.env.RISK_URL ?? 'http://127.0.0.1:5320/';
const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const GAMES = Number(arg('games', '30'));
const PAR = Number(arg('parallel', '5'));
const SEED0 = Number(arg('seed', String(1 + Math.floor(Math.random() * 1e6))));
const ONLY = arg('only', 'mix');
const RELOADS = arg('reloads', '1') === '1';
/** Menu chaos: AI-speed toggles, pause/resume, save & quit → Continue, handing the seat to the AI and back. */
const MENU = Number(arg('menu', '0'));
const LENGTH = arg('length', '');
const OUT = arg('out', 'artifacts/soak');
const GAME_TIMEOUT = Number(arg('timeout', String(40 * 60_000)));
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// Deterministic job list
// ---------------------------------------------------------------------------

function mulberry(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Kind = 'human' | 'ai';
interface Job {
  n: number;
  seed: number;
  seats: Kind[];
  setup: 'auto' | 'manual' | 'draft';
  length: 'quick' | 'evening' | 'full';
  autoplay: boolean;
  reloads: boolean;
  chaos: number; // probability of click-through / skip clicks
}
const COLORS = ['crimson', 'cobalt', 'amber', 'emerald'];
const NAMES = ['John', 'Cobalt', 'Amber', 'Emerald'];
const DIFFS = ['easy', 'normal', 'hard'];

function makeJobs(): Job[] {
  const r = mulberry(SEED0);
  const jobs: Job[] = [];
  for (let n = 0; n < GAMES; n++) {
    const seed = Math.floor(r() * 2 ** 31);
    const auto = ONLY === 'auto' || (ONLY === 'mix' && r() < 0.25);
    const count = auto ? 4 : [2, 3, 4, 4, 4][Math.floor(r() * 5)];
    let seats: Kind[];
    if (auto) seats = Array(count).fill('ai');
    else {
      seats = Array(count).fill('ai');
      seats[0] = 'human';
      if (count >= 3 && r() < 0.25) seats[1] = 'human';
      if (count === 2 && r() < 0.3) seats[1] = 'human';
    }
    const setup = r() < 0.6 ? 'auto' : r() < 0.75 ? 'manual' : 'draft';
    const lr = r();
    const length = (LENGTH || (lr < 0.5 ? 'quick' : lr < 0.85 ? 'evening' : 'full')) as Job['length'];
    jobs.push({
      n,
      seed,
      seats,
      setup,
      length,
      autoplay: auto,
      reloads: RELOADS && r() < 0.6,
      chaos: r() < 0.5 ? 0.15 : 0.02,
    });
  }
  return jobs;
}

// ---------------------------------------------------------------------------
// In-page instrumentation (installed before any app code)
// ---------------------------------------------------------------------------

const MONITOR = String.raw`
window.__name = (f) => f;
(() => {
  const H = (window.__hunt = { errs: [], lost: 0, restored: 0, flags: [], hist: [], hangs: [],
    fr: { n: 0, sum: 0, max: 0, over50: 0, over250: 0 }, events: 0, settled: 0 });
  const push = (k, m) => { if (H.errs.length < 300) H.errs.push({ k, m: String(m).slice(0, 3000), t: Math.round(performance.now()) }); };
  addEventListener('error', (e) => push('error', (e.error && e.error.stack) || e.message));
  addEventListener('unhandledrejection', (e) => push('unhandledrejection', (e.reason && e.reason.stack) || e.reason));
  const ce = console.error.bind(console);
  console.error = (...a) => { push('console.error', a.map((x) => (x && x.stack) || (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ')); ce(...a); };
  const gc = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = gc.call(this, type, ...rest);
    if (/webgl/.test(String(type)) && !this.__hunted) {
      this.__hunted = true;
      this.addEventListener('webglcontextlost', () => { H.lost++; push('webglcontextlost', type); });
      this.addEventListener('webglcontextrestored', () => H.restored++);
    }
    return ctx;
  };
  let last = 0;
  const frame = (t) => {
    if (last) {
      const d = t - last;
      H.fr.n++; H.fr.sum += d; if (d > H.fr.max) H.fr.max = d;
      if (d > 50) H.fr.over50++;
      if (d > 250) H.fr.over250++;
    }
    last = t;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  const flag = (kind, extra) => {
    if (H.flags.length > 60) return;
    let snap = null;
    try {
      const s = window.__risk.getState();
      snap = { ui: window.__risk.ui(), phase: s && s.phase, cp: s && s.currentPlayer, turn: s && s.turn, idle: window.__risk.isIdle(), stats: window.__risk.stats() };
    } catch (e) { snap = String(e); }
    H.flags.push({ kind, t: Math.round(performance.now()), extra, snap });
  };
  H.flag = flag;
  // Wrap the board once it exists: time every playEvent promise.
  const wrapBoard = () => {
    const b = window.__board;
    if (!b || b.__hunted) return !!b;
    b.__hunted = true;
    const pe = b.playEvent.bind(b);
    b.playEvent = (ev, after, opts) => {
      H.events++;
      const t0 = performance.now();
      let p;
      try { p = pe(ev, after, opts); } catch (e) { push('playEvent-throw', (e && e.stack) || e); throw e; }
      let done = false;
      const timer = setTimeout(() => { if (!done) { H.hangs.push({ type: ev.type, ms: 5000, open: true }); flag('playEvent>5s', { ev: ev.type, opts }); } }, 5000);
      Promise.resolve(p).then(
        () => { done = true; H.settled++; clearTimeout(timer); const ms = performance.now() - t0; if (ms > 5000) H.hangs.push({ type: ev.type, ms: Math.round(ms) }); },
        (e) => { done = true; clearTimeout(timer); push('playEvent-reject', (e && e.stack) || e); },
      );
      return p;
    };
    const ss = b.syncState.bind(b);
    b.syncState = (s) => { try { return ss(s); } catch (e) { push('syncState-throw', (e && e.stack) || e); throw e; } };
    return true;
  };
  let notIdleSince = performance.now(), notIdleFlagged = false, lastAct = '';
  let progKey = '', progSince = performance.now(), progFlagged = false;
  let stuckSince = 0, stuckFlagged = false;
  let lastRef = null;
  setInterval(() => {
    const R = window.__risk;
    if (!R) return;
    wrapBoard();
    let s, u;
    try { s = R.getState(); u = R.ui(); } catch (e) { push('hook-throw', (e && e.stack) || e); return; }
    const now = performance.now();
    if (s !== lastRef && s) {
      lastRef = s;
      H.changes = (H.changes || 0) + 1;
      H.hist.push({ t: Math.round(now), turn: s.turn, round: s.round, cp: s.currentPlayer, ph: s.phase.kind, rem: s.phase.remaining, owners: null });
      if (H.hist.length > 400) H.hist.splice(0, H.hist.length - 400);
    }
    if (!s || u.screen !== 'game') { notIdleSince = 0; progSince = now; stuckSince = 0; return; }
    const idle = R.isIdle();
    // Busy but nothing moving: no board event started or finished and no state change for 15 s.
    // (isIdle() alone is false through every AI turn, so on its own it says nothing.)
    const act = H.events + ':' + H.settled + ':' + H.changes;
    if (!H.coverFlagged && document.querySelector('[data-testid="handoff"]')) { H.coverFlagged = true; flag('handoff-cover-shown (v5.1 removed it)', {}); }
    if (idle || act !== lastAct) { lastAct = act; notIdleSince = now; notIdleFlagged = false; }
    else if (now - notIdleSince > 15000 && !notIdleFlagged) { notIdleFlagged = true; flag('busy-no-progress>15s', { since: Math.round(now - notIdleSince) }); }
    const key = s.turn + '|' + s.currentPlayer + '|' + s.phase.kind + '|' + (s.phase.kind === 'setup-place' || s.phase.kind === 'reinforce' ? JSON.stringify(s.phase) : '');
    const aiTurn = s.players[s.currentPlayer].kind === 'ai' || H.autoplay;
    if (key !== progKey) { progKey = key; progSince = now; progFlagged = false; }
    else if (aiTurn && s.phase.kind !== 'game-over' && now - progSince > 60000 && !progFlagged && !document.querySelector('[data-testid="pause"],[data-testid="settings"],[data-testid="rules"]')) {
      progFlagged = true; flag('ai-no-progress>60s', { key });
    }
    // Human with nothing to do: no strip button, no eligible Turn Track segment, no clickable tile.
    if (!aiTurn && idle && s.phase.kind !== 'game-over') {
      const anyBtn = u.buttons.length > 0 || (u.trackLive && !u.trackDisabled && u.track.some((x) => x.startsWith('eligible:')));
      let anyTile = false;
      if (!anyBtn) for (const t of Object.keys(s.territories)) { if (R.explain(t).ok) { anyTile = true; break; } }
      if (!anyBtn && !anyTile) {
        if (!stuckSince) stuckSince = now;
        if (now - stuckSince > 3000 && !stuckFlagged) { stuckFlagged = true; flag('human-no-move', {}); }
      } else { stuckSince = 0; stuckFlagged = false; }
    } else { stuckSince = 0; }
  }, 250);
})();
`;

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

interface GameResult {
  n: number;
  seed: number;
  cfg: Omit<Job, 'n'>;
  ok: boolean;
  outcome: string;
  ms: number;
  rounds: number;
  humanActs: number;
  botStalls: number;
  reloads: string[];
  errs: unknown[];
  flags: unknown[];
  hangs: unknown[];
  lost: number;
  heapMB: number[];
  frames: { avg: number; max: number; over50: number; over250: number };
  events: number;
  worker: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Bot {
  log: string[] = [];
  acts = 0;
  stalls = 0;
  reloads: string[] = [];
  acc = { errs: [] as unknown[], flags: [] as unknown[], hangs: [] as unknown[], lost: 0, events: 0, fr: { n: 0, sum: 0, max: 0, over50: 0, over250: 0 }, hist: [] as unknown[] };
  async harvest() {
    const h = await readHunt(this.page);
    const a = this.acc;
    a.errs.push(...h.errs);
    a.flags.push(...h.flags);
    a.hangs.push(...h.hangs);
    a.lost += h.lost;
    a.events += h.events;
    a.fr.n += h.fr.n;
    a.fr.sum += h.fr.sum;
    a.fr.max = Math.max(a.fr.max, h.fr.max);
    a.fr.over50 += h.fr.over50;
    a.fr.over250 += h.fr.over250;
    a.hist = h.hist;
    return a;
  }
  constructor(
    public page: Page,
    public job: Job,
    public rnd: () => number,
  ) {}

  note(s: string) {
    const line = `${new Date().toISOString().slice(11, 23)} g${this.job.n} ${s}`;
    this.log.push(line);
    appendFileSync(`${OUT}/live-${this.job.n % 100}.log`, line + '\n');
    if (this.log.length > 600) this.log.splice(0, this.log.length - 600);
  }

  async ev<T>(fn: string, arg?: unknown): Promise<T> {
    return this.page.evaluate(`(${fn})(${JSON.stringify(arg ?? null)})`) as Promise<T>;
  }

  async pos(t: string): Promise<{ x: number; y: number } | null> {
    return this.page.evaluate((id) => window.__risk.screenPos(id as never), t);
  }

  async click(t: string, opts: { right?: boolean; shift?: boolean } = {}) {
    let p = await this.pos(t);
    if (!p || p.x < 2 || p.y < 2 || p.x > 1438 || p.y > 898) {
      // Off-screen: ask the board to frame it (F key frames the selection; we just wait for the camera).
      await sleep(400);
      p = await this.pos(t);
      if (!p) throw new Error(`no screen position for ${t}`);
    }
    if (opts.shift) await this.page.keyboard.down('Shift');
    await this.page.mouse.click(p.x, p.y, { button: opts.right ? 'right' : 'left' });
    if (opts.shift) await this.page.keyboard.up('Shift');
    this.note(`click ${t}${opts.right ? ' (right)' : ''}${opts.shift ? ' (shift)' : ''}`);
  }

  async btn(id: string, timeout = 8000): Promise<boolean> {
    const loc = this.page.locator(`[data-testid="${id}"]`).first();
    try {
      await loc.waitFor({ state: 'visible', timeout });
      await loc.click({ timeout });
      this.note(`btn ${id}`);
      return true;
    } catch {
      this.note(`btn ${id} MISSING`);
      return false;
    }
  }

  /** A Turn Track segment ('place' | 'attack' | 'fortify' | 'endTurn' | 'setup' | 'done'). */
  async seg(id: string, timeout = 8000): Promise<boolean> {
    try {
      await Promise.race([segClick(this.page, id), sleep(timeout).then(() => Promise.reject(new Error('timeout')))]);
      this.note(`seg ${id}`);
      return true;
    } catch {
      this.note(`seg ${id} MISSING`);
      return false;
    }
  }

  /** The count control by mouse (stepper or slider), if it is showing. */
  async count(n: number): Promise<void> {
    try {
      await setCount(this.page, n);
      this.note(`count ${n}`);
    } catch (e) {
      this.note(`count ${n} failed: ${String(e).slice(0, 120)}`);
    }
  }

  async think(lo = 120, hi = 520) {
    await sleep(lo + this.rnd() * (hi - lo));
  }

  async waitAnims() {
    // A real player waits for most animations, but sometimes clicks through.
    if (this.rnd() < this.job.chaos) return;
    await this.page.waitForFunction(() => window.__risk.isIdle(), null, { timeout: 30000, polling: 50 }).catch(() => this.note('waitAnims timeout'));
  }
}

async function stateSig(page: Page): Promise<string> {
  return page.evaluate(() => {
    const s = window.__risk.getState();
    if (!s) return 'none';
    return JSON.stringify([s.turn, s.currentPlayer, s.phase, s.rng, s.tradeCount, Object.values(s.territories).map((t) => t.armies * 10 + t.owner)]) + JSON.stringify(window.__risk.ui().buttons);
  });
}

/**
 * Plays one human decision through the UI (docs/ROUND2.md §A–B): board clicks only select, buttons
 * commit, the Turn Track is the only phase change (plus the fortify `Move N · end turn`). Returns a
 * description.
 */
async function humanStep(bot: Bot): Promise<string> {
  const page = bot.page;
  const info = (await page.evaluate(`(async () => {
    const eng = await import('/src/engine/index.ts');
    const s = window.__risk.getState();
    const a = eng.chooseAiAction(s, s.currentPlayer);
    return { a, phase: s.phase, cards: s.players[s.currentPlayer].cards.length, armies: s.territories, u: window.__risk.ui(), cp: s.currentPlayer };
  })()`)) as {
    a: Record<string, never> & { type: string; territory?: string; count?: number; from?: string; to?: string; dice?: number };
    phase: { kind: string; remaining?: number; toPlace?: number; mustTrade?: boolean; min?: number; max?: number; from?: string; to?: string };
    cards: number;
    armies: Record<string, { owner: number; armies: number }>;
    u: { buttons: string[]; primary: string | null; recommended: string | null; brass: string[]; count: { value: number } | null; line: string };
    cp: number;
  };
  const a = info.a;
  const ph = info.phase;
  bot.note(`decide ${ph.kind} → ${JSON.stringify(a)}`);
  const r = bot.rnd;
  const countShown = () => page.evaluate(() => !!window.__risk.ui().count);
  switch (a.type) {
    case 'claim':
      await bot.click(a.territory!);
      return 'claim';
    case 'placeSetup': {
      // Stage everything on the AI's pick (sometimes one first, taken back with Undo), then Done.
      const n = ph.toPlace ?? 1;
      await bot.click(a.territory!);
      if (n > 1 && r() < 0.3) {
        await bot.count(1);
        await bot.btn('btn-place');
        await bot.btn('btn-undo');
        if (!(await countShown())) await bot.click(a.territory!);
      }
      await bot.btn('btn-place');
      await bot.think();
      if (r() < 0.1) {
        await page.keyboard.press('Enter');
        bot.note('key Enter (Done)');
      } else await bot.seg('done');
      return 'placeSetup';
    }
    case 'trade':
      if (ph.mustTrade || r() < 0.5) {
        if (!(await bot.btn('btn-trade', 2500))) await bot.btn('btn-cards', 1500).then((ok) => ok && bot.btn('cards-trade', 2500));
      } else {
        await bot.btn('btn-cards', 2500);
        if (!(await bot.btn('cards-trade', 2500))) await bot.btn('cards-close', 1500);
      }
      return 'trade';
    case 'reinforce': {
      const n = a.count ?? 1;
      const rem = ph.remaining ?? n;
      await bot.click(a.territory!);
      if (n !== rem) await bot.count(n);
      await bot.btn('btn-place');
      if (r() < 0.05) {
        await bot.btn('btn-undo', 1500);
        await bot.click(a.territory!);
        if (n !== rem) await bot.count(n);
        await bot.btn('btn-place');
      }
      return 'reinforce';
    }
    case 'endReinforce':
      if (info.u.recommended === 'attack' && info.u.brass.includes('Attack') && r() < 0.1) {
        await page.keyboard.press('Enter');
        bot.note('key Enter (Attack)');
      } else await bot.seg('attack');
      return 'endReinforce';
    case 'attack':
    case 'blitz': {
      const from = a.from!;
      const to = a.to!;
      const ex = (t: string) => page.evaluate((id) => window.__risk.explain(id as never), t);
      // Target-first arms from the strongest neighbour; pick the AI's source first when it differs.
      let e = await ex(from);
      if (e.ok && !/Deselect/.test(e.text) && r() < 0.6) await bot.click(from);
      e = await ex(to);
      if (e.ok) await bot.click(to);
      else bot.note(`attack target explain: ${e.text}`);
      await bot.think(80, 300);
      if (a.type === 'blitz' || r() < 0.3) {
        if (r() < 0.2) {
          await page.keyboard.press('Space');
          bot.note('key Space');
        } else await bot.btn('btn-blitz');
      } else await bot.btn('btn-roll');
      return a.type;
    }
    case 'occupy': {
      const want = a.count ?? ph.max ?? 1;
      // Mostly the default; sometimes the AI's count on the count control; rarely Enter (Move is brass).
      if (r() < 0.4 && (await countShown())) await bot.count(want);
      if (r() < 0.1) {
        await page.keyboard.press('Enter');
        bot.note('key Enter (occupy)');
      } else await bot.btn('btn-move');
      return 'occupy';
    }
    case 'endAttack':
      await bot.seg('fortify');
      return 'endAttack';
    case 'fortify': {
      await bot.click(a.from!);
      await bot.click(a.to!);
      const max = info.armies[a.from!].armies - 1;
      if ((a.count ?? max) !== max && (await countShown())) await bot.count(a.count!);
      await bot.btn('btn-move');
      return 'fortify';
    }
    case 'endTurn':
      if (info.u.recommended === 'endTurn' && info.u.brass.includes('End turn') && r() < 0.1) {
        await page.keyboard.press('Enter');
        bot.note('key Enter (End turn)');
      } else await bot.seg('endTurn');
      return 'endTurn';
    default:
      bot.note(`unhandled ${a.type}; dispatching`);
      await page.evaluate((act) => window.__risk.dispatch(act as never), a);
      return 'dispatch';
  }
}

async function heapMB(page: Page): Promise<number> {
  return page.evaluate(() => {
    (window as unknown as { gc?: () => void }).gc?.();
    const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    const mb = m ? Math.round(m.usedJSHeapSize / 1e5) / 10 : -1;
    // GPU-side leaks show up as geometry/texture counts growing across games in one page.
    const info = (window.__board as unknown as { __debug?: { renderer?: { info: { memory: { geometries: number; textures: number } } } } } | undefined)?.__debug?.renderer?.info.memory;
    const w = window as unknown as { __gpu?: string[] };
    (w.__gpu ??= []).push(`${info ? `${info.geometries}g/${info.textures}t` : '?'}/${document.getElementsByTagName('*').length}dom`);
    return mb;
  });
}

async function continueFromTitle(page: Page): Promise<boolean> {
  await page.waitForFunction(() => !!window.__risk, null, { timeout: 60000, polling: 100 });
  const c = page.locator('[data-testid="title-continue"]');
  try {
    await c.waitFor({ state: 'visible', timeout: 5000 });
    await c.click();
  } catch {
    return false;
  }
  await page.waitForFunction(() => window.__risk.ui().screen === 'game', null, { timeout: 45000, polling: 100 });
  return true;
}

async function doReload(bot: Bot, why: string): Promise<string> {
  const page = bot.page;
  const before = await page.evaluate(() => {
    const raw = localStorage.getItem('risk3d.save.v1');
    const s = window.__risk.getState();
    return { save: raw ? JSON.parse(raw).state : null, live: s };
  });
  const savedSig = before.save ? JSON.stringify(before.save) : null;
  const liveSig = JSON.stringify(before.live);
  await bot.harvest();
  bot.note(`RELOAD (${why}) phase=${before.live?.phase.kind} savedMatchesLive=${savedSig === liveSig}`);
  await page.reload();
  const over = before.live?.phase.kind === 'game-over';
  const ok = await continueFromTitle(page);
  if (over) {
    // After victory there is nothing to continue; the title must still work.
    return ok ? 'victory-reload: Continue offered for a finished game' : 'victory-reload ok';
  }
  if (!ok) return `reload(${why}): no Continue on the title`;
  const after = await page.evaluate(() => JSON.stringify(window.__risk.getState()));
  let problem = '';
  if (savedSig !== liveSig) problem += ` save≠live before reload`;
  // (With an AI to move, the game goes on the moment it loads; only a human turn can be compared.)
  const humanTurn = !!before.live && before.live.players[before.live.currentPlayer].kind === 'human' && !bot.job.autoplay;
  if (humanTurn && after !== liveSig) problem += ` loaded≠live`;
  await page.evaluate(() => ((window as unknown as { __hunt: { autoplay: boolean } }).__hunt.autoplay = false));
  return `reload(${why}) phase=${before.live?.phase.kind}${problem ? ' PROBLEM' + problem : ' ok'}`;
}

async function menuChaos(bot: Bot, human: boolean): Promise<string> {
  const page = bot.page;
  const r = bot.rnd();
  const esc = async () => {
    await page.keyboard.press('Escape');
    bot.note('key Escape');
    const pause = page.locator('[data-testid="pause"]');
    // The first Esc may only back out a selection; give the overlay a moment before pressing again
    // (a second Esc on an open pause menu resumes).
    const opened = await pause.waitFor({ state: 'visible', timeout: 1200 }).then(() => true, () => false);
    if (!opened) {
      await page.keyboard.press('Escape');
      bot.note('key Escape (2)');
    }
    return page.locator('[data-testid="pause"]').waitFor({ state: 'visible', timeout: 4000 }).then(() => true, () => false);
  };
  if (r < 0.35) {
    const v = ['fast', 'instant', 'watch'][Math.floor(bot.rnd() * 3)];
    await bot.btn(`ai-${v}`, 3000);
    if (v !== 'watch') {
      await sleep(1500 + bot.rnd() * 3000);
      await bot.btn('ai-watch', 3000);
    }
    return `menu: ai ${v}→watch`;
  }
  if (r < 0.6) {
    if (!(await esc())) return 'menu: pause did not open';
    await sleep(300 + bot.rnd() * 2500);
    await bot.btn('pause-resume', 3000);
    return 'menu: pause/resume';
  }
  if (r < 0.8) {
    if (!(await esc())) return 'menu: pause did not open';
    await bot.harvest();
    await bot.btn('pause-quit', 3000);
    await sleep(500 + bot.rnd() * 1500);
    const ok = await continueFromTitle(page);
    return ok ? 'menu: save&quit → continue ok' : 'menu: save&quit → NO Continue PROBLEM';
  }
  if (human) {
    // Hand my seat to the AI for a bit, then take it back.
    if (!(await esc())) return 'menu: pause did not open';
    await bot.btn('pause-seat-0', 3000);
    await bot.btn('pause-resume', 3000);
    await sleep(3000 + bot.rnd() * 6000);
    if (!(await esc())) return 'menu: seat→AI, pause did not reopen PROBLEM';
    await bot.btn('pause-seat-0', 3000);
    await bot.btn('pause-resume', 3000);
    // (Applied at the next safe point, not mid-animation.)
    await page.waitForFunction(() => { const s = window.__risk.getState(); return !s || s.phase.kind === 'game-over' || s.players[0].kind === 'human' || s.players[0].eliminated; }, null, { timeout: 20000, polling: 100 }).catch(() => undefined);
    const back = await page.evaluate(() => { const s = window.__risk.getState(); return s && !s.players[0].eliminated && s.phase.kind !== 'game-over' ? s.players[0].kind : undefined; });
    return `menu: seat 0 → AI → back (${back})${back === 'human' || back === undefined ? '' : ' PROBLEM'}`;
  }
  return 'menu: none';
}

async function startGame(page: Page, job: Job, viaRematch: boolean): Promise<void> {
  if (viaRematch) {
    await page.locator('[data-testid="rematch"]').click({ timeout: 10000 });
  } else {
    await page.evaluate(
      ({ job, COLORS, NAMES, DIFFS }) => {
        window.__risk.setSpeed(1, 'watch');
        const players = job.seats.map((k, i) => ({
          name: NAMES[i],
          color: COLORS[i],
          kind: k,
          ...(k === 'ai' ? { difficulty: DIFFS[(job.seed + i) % 3] } : {}),
        }));
        const n = players.length;
        const len = job.length;
        const dominationPercent = len === 'quick' ? (n === 2 ? 75 : 60) : len === 'evening' ? (n === 2 ? 80 : 70) : 100;
        window.__risk.newGame({
          players: players as never,
          seed: job.seed,
          dominationPercent,
          turnLimit: len === 'quick' ? 12 : null,
          setupMode: job.setup === 'draft' ? 'draft' : 'random',
          initialPlacement: job.setup === 'auto' ? 'auto' : 'manual',
        });
        window.__risk.autoplay(job.autoplay);
        (window as unknown as { __hunt: { autoplay: boolean } }).__hunt.autoplay = job.autoplay;
      },
      { job, COLORS, NAMES, DIFFS },
    );
  }
  await page.waitForFunction(() => window.__risk.ui().screen === 'game', null, { timeout: 45000, polling: 100 });
}

async function readHunt(page: Page) {
  return page.evaluate(() => {
    const H = (window as unknown as { __hunt: Record<string, unknown> & { fr: { n: number; sum: number; max: number; over50: number; over250: number } } }).__hunt;
    const out = { errs: H.errs, flags: H.flags, hangs: H.hangs, lost: H.lost, fr: { ...H.fr }, events: H.events, hist: H.hist };
    H.errs = [];
    H.flags = [];
    H.hangs = [];
    H.fr = { n: 0, sum: 0, max: 0, over50: 0, over250: 0 };
    H.events = 0;
    H.lost = 0;
    return out;
  }) as Promise<{ errs: unknown[]; flags: unknown[]; hangs: unknown[]; lost: number; fr: { n: number; sum: number; max: number; over50: number; over250: number }; events: number; hist: unknown[] }>;
}

async function playGame(page: Page, job: Job, worker: number, viaRematch: boolean, heap: number[]): Promise<GameResult> {
  const rnd = mulberry(job.seed ^ 0x5eed);
  const bot = new Bot(page, job, rnd);
  const t0 = Date.now();
  await startGame(page, job, viaRematch);
  const seed = await page.evaluate(() => window.__risk.getState()!.config.seed);
  if (viaRematch) job = { ...job, seed };
  bot.note(`start game ${job.n} seed ${seed} ${JSON.stringify(job)}`);
  let outcome = 'timeout';
  let sameSig = 0;
  let lastSig = '';
  let lastHeap = Date.now();
  let didReloadVictory = false;
  let maxRound = 0;
  const reloadAt = new Set<string>();
  while (Date.now() - t0 < GAME_TIMEOUT) {
    if (Date.now() - lastHeap > 60_000) {
      heap.push(await heapMB(page));
      lastHeap = Date.now();
    }
    const snap = await page.evaluate(() => {
      const s = window.__risk.getState();
      const u = window.__risk.ui();
      return {
        screen: u.screen,
        over: !!s && s.phase.kind === 'game-over',
        human: !!s && s.players[s.currentPlayer].kind === 'human',
        phase: s?.phase.kind ?? null,
        mustTrade: !!s && s.phase.kind === 'reinforce' && s.phase.mustTrade,
        idle: window.__risk.isIdle(),
        handoff: !!document.querySelector('[data-testid="handoff"]'),
        humansOut: u.line === 'All humans are out' && !!document.querySelector('[data-testid="btn-watchAis"]'),
        round: s?.round ?? 0,
        rolling: !!u.battle,
      };
    });
    maxRound = Math.max(maxRound, snap.round);
    if (snap.screen === 'victory') {
      outcome = 'victory';
      if (job.reloads && !didReloadVictory && rnd() < 0.3) {
        didReloadVictory = true;
        await sleep(2000);
        bot.reloads.push(await doReload(bot, 'victory'));
        outcome = 'victory+reload';
      }
      break;
    }
    if (snap.screen !== 'game') {
      bot.note(`screen ${snap.screen}`);
      await sleep(500);
      continue;
    }
    // Reload/resume at interesting moments (once per kind per game).
    if (job.reloads && !snap.over) {
      const kinds: [string, boolean][] = [
        ['mid-occupy', snap.phase === 'occupy' && snap.human],
        ['mid-forced-trade', snap.mustTrade && snap.human],
        ['mid-ai-turn', !snap.human && !snap.idle && snap.round >= 2],
        ['mid-reinforce', snap.phase === 'reinforce' && snap.human && snap.round >= 3],
        ['mid-fortify', snap.phase === 'fortify' && snap.human],
        ['mid-setup', snap.round === 0 && snap.human],
      ];
      const k = kinds.find(([name, on]) => on && !reloadAt.has(name) && rnd() < 0.35);
      if (k) {
        reloadAt.add(k[0]);
        bot.reloads.push(await doReload(bot, k[0]));
        continue;
      }
    }
    if (MENU && !snap.over && rnd() < MENU) {
      const what = await menuChaos(bot, snap.human);
      bot.reloads.push(what);
      continue;
    }
    if (snap.humansOut && rnd() < 0.5) {
      await bot.btn('btn-watchAis', 1000);
    }
    if (snap.over || !snap.human || job.autoplay) {
      // Watching: sometimes click to skip a fight, like an impatient player.
      if (!job.autoplay && !snap.idle && rnd() < job.chaos / 4) {
        await page.mouse.click(700, 420);
        bot.note('skip-click (AI turn)');
      }
      await sleep(250);
      continue;
    }
    // Human turn.
    await bot.waitAnims();
    const sig = await stateSig(page);
    if (sig === lastSig) {
      sameSig++;
      if (sameSig === 4) {
        bot.stalls++;
        bot.note('STALL: 4 bot moves without any state/UI change');
        await page.evaluate(() => (window as unknown as { __hunt: { flag: (k: string, e: unknown) => void } }).__hunt.flag('bot-stall', {}));
      }
      if (sameSig >= 4) {
        // Unstick with the hook so the game can go on (the stall is already recorded).
        await page.evaluate(`(async () => { const eng = await import('/src/engine/index.ts'); const s = window.__risk.getState(); return window.__risk.dispatch(eng.chooseAiAction(s, s.currentPlayer)); })()`);
        bot.note('unstuck via dispatch');
        sameSig = 0;
      }
    } else sameSig = 0;
    lastSig = sig;
    try {
      const what = await humanStep(bot);
      bot.acts++;
      // Reload right after a blitz starts (mid-blitz).
      if (job.reloads && (what === 'blitz' || what === 'attack') && !reloadAt.has('mid-blitz') && rnd() < 0.2) {
        reloadAt.add('mid-blitz');
        await sleep(150);
        bot.reloads.push(await doReload(bot, 'mid-blitz'));
        continue;
      }
    } catch (e) {
      bot.note(`step error ${String(e).slice(0, 300)}`);
    }
    await bot.think();
  }
  const h = await bot.harvest();
  const st = await page.evaluate(() => window.__risk.getState());
  const rounds = Math.max(st?.round ?? 0, maxRound);
  const problems = [...bot.reloads.filter((x) => /PROBLEM|no Continue|offered|did not open/.test(x))];
  const res: GameResult = {
    n: job.n,
    seed: job.seed,
    cfg: { ...job },
    ok: /victory/.test(outcome) && h.errs.length === 0 && h.flags.length === 0 && h.lost === 0 && problems.length === 0 && bot.stalls === 0,
    outcome,
    ms: Date.now() - t0,
    rounds,
    humanActs: bot.acts,
    botStalls: bot.stalls,
    reloads: bot.reloads,
    errs: h.errs,
    flags: h.flags,
    hangs: h.hangs,
    lost: h.lost,
    heapMB: [...heap],
    frames: { avg: h.fr.n ? Math.round((h.fr.sum / h.fr.n) * 10) / 10 : 0, max: Math.round(h.fr.max), over50: h.fr.over50, over250: h.fr.over250 },
    events: h.events,
    worker,
  };
  if (!res.ok) {
    const dump = await page.evaluate(() => ({
      save: localStorage.getItem('risk3d.save.v1'),
      uiMeta: localStorage.getItem('risk3d.ui.v1'),
      state: window.__risk.getState(),
      ui: window.__risk.ui(),
      idle: window.__risk.isIdle(),
      stats: window.__risk.stats(),
    }));
    writeFileSync(`${OUT}/fail-${job.n}-${job.seed}.json`, JSON.stringify({ res, job, dump, botLog: bot.log, hist: h.hist }, null, 1));
    await page.screenshot({ path: `${OUT}/fail-${job.n}-${job.seed}.png` }).catch(() => undefined);
  }
  return res;
}

async function worker(id: number, jobs: Job[], results: GameResult[]): Promise<void> {
  let browser: Browser | null = null;
  let page: Page | null = null;
  let heap: number[] = [];
  let gamesInPage = 0;
  let prevVictory = false;
  const fresh = async () => {
    await (browser as Browser | null)?.close().catch(() => undefined);
    browser = await chromium.launch({
      args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio', '--enable-precise-memory-info', '--js-flags=--expose-gc'],
    });
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('crash', () => console.log(`[w${id}] PAGE CRASH`));
    await page.addInitScript(MONITOR);
    await page.goto(BASE);
    await page.waitForFunction(() => !!window.__risk, null, { timeout: 60000, polling: 100 });
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForFunction(() => !!window.__risk, null, { timeout: 60000, polling: 100 });
    heap = [await heapMB(page)];
    gamesInPage = 0;
    prevVictory = false;
  };
  await fresh();
  while (jobs.length) {
    const job = jobs.shift()!;
    // Long sessions: up to 4 games per page; a human-seat job after a victory sometimes uses Rematch.
    if (gamesInPage >= 4) await fresh();
    const viaRematch = prevVictory && !job.autoplay && Math.random() < 0.4;
    let res: GameResult;
    try {
      res = await playGame(page!, job, id, viaRematch, heap);
    } catch (e) {
      res = {
        n: job.n, seed: job.seed, cfg: { ...job }, ok: false, outcome: `harness-error: ${String(e).slice(0, 500)}`, ms: 0, rounds: 0, humanActs: 0,
        botStalls: 0, reloads: [], errs: [], flags: [], hangs: [], lost: 0, heapMB: heap, frames: { avg: 0, max: 0, over50: 0, over250: 0 }, events: 0, worker: id,
      };
      try {
        writeFileSync(`${OUT}/fail-${job.n}-${job.seed}.json`, JSON.stringify({ res, job, dump: await page!.evaluate(() => ({ state: window.__risk.getState(), ui: window.__risk.ui() })) }, null, 1));
      } catch {
        /* page gone */
      }
      await fresh();
    }
    gamesInPage++;
    prevVictory = /victory/.test(res.outcome) && !res.outcome.includes('reload');
    heap.push(await heapMB(page!).catch(() => -1));
    res.heapMB = [...heap];
    const gpu = await page!.evaluate(() => (window as unknown as { __gpu?: string[] }).__gpu ?? []).catch(() => []);
    (res as unknown as { gpu: string[] }).gpu = gpu;
    results.push(res);
    appendFileSync(`${OUT}/results.jsonl`, JSON.stringify(res) + '\n');
    const f = res.frames;
    console.log(
      `[w${id}] game ${res.n} seed ${res.seed} ${res.cfg.seats.join('/')} ${res.cfg.setup} ${res.cfg.length}${res.cfg.autoplay ? ' autoplay' : ''} → ${res.ok ? 'OK' : 'FAIL'} ${res.outcome} r${res.rounds} ${Math.round(res.ms / 1000)}s acts ${res.humanActs} ev ${res.events} errs ${res.errs.length} flags ${res.flags.length} hangs ${res.hangs.length} stalls ${res.botStalls} reloads[${res.reloads.join('; ')}] heap ${heap.slice(-3).join('→')}MB gpu ${((res as unknown as { gpu: string[] }).gpu ?? []).slice(-2).join('→')} frames avg ${f.avg} max ${f.max} >250:${f.over250}`,
    );
  }
  await (browser as Browser | null)?.close();
}

const jobs = makeJobs();
console.log(`soak: ${jobs.length} games, ${PAR} workers, seed0 ${SEED0}, ${BASE}`);
const results: GameResult[] = [];
await Promise.all(Array.from({ length: Math.min(PAR, jobs.length) }, (_, i) => worker(i, jobs, results)));
const fails = results.filter((r) => !r.ok);
console.log(`\n${results.length - fails.length}/${results.length} games clean`);
for (const f of fails) console.log(`  FAIL game ${f.n} seed ${f.seed}: ${f.outcome} errs ${f.errs.length} flags ${JSON.stringify(f.flags.map((x) => (x as { kind: string }).kind))} stalls ${f.botStalls} ${f.reloads.join('; ')}`);
process.exit(fails.length ? 1 : 0);
