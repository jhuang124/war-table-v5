// Screenshot sweep for the visual review (docs/INK.md A9; a tool, not in test:e2e), on the real board +
// HUD, desktop sizes and emulated phones: title, new game, place (picked), a drawn attack mid-stroke,
// the armed stroke, the dice at the held silence, the verdict (the losing figure's puff), a conquest (smoke + flood, a human's territory: the torn rim), an AI turn,
// the hand-off cover, the menu sheet, the rules scroll, the victory scroll, and three idle frames 4 s apart (the living
// calm). Ceremony shots run the board in slow motion (__debug.anim.speed) so the frame is the beat.
// Also reports the words on screen per state and the idle redraw rate (frames drawn / s).
// Usage: npx tsx tests/e2e/screens.ts [outDir] [1440x900,1920x1080,iphone,iphone-land]   (server on RISK_URL)
import { idle, loadScenario, open, scenario, state, TWO_HUMANS } from './lib';
import { DEVICES, openDevice, type DeviceName } from './mobile-lib';
import type { GameState, Phase, TerritoryId } from '../../src/engine';
import { TERRITORY_IDS } from '../../src/engine';
import type { Browser, CDPSession, Page } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = process.argv[2] ?? 'artifacts/ink2/final';
const TARGETS = (process.argv[3] ?? '1440x900,1920x1080,iphone,iphone-land').split(',');
mkdirSync(OUT, { recursive: true });

const PLAYERS = [
  { name: 'John', color: 'crimson', kind: 'human' },
  { name: 'Sam', color: 'cobalt', kind: 'human' },
  { name: 'Priya', color: 'amber', kind: 'ai', difficulty: 'normal' },
  { name: 'Theo', color: 'emerald', kind: 'ai', difficulty: 'normal' },
] as never;
const own = (t: string[]) => Object.fromEntries(t.map((x) => [x, [0, 2]]));

/** Round 6: John holds a band from Scandinavia to India, the rest is spread over the other three. */
function base(phase: Phase, mutate?: (s: GameState) => void): GameState {
  return scenario(
    { ...own(['ural', 'ukraine', 'afghanistan', 'middle_east', 'india', 'scandinavia', 'egypt', 'north_africa', 'brazil', 'peru']), ural: [0, 12] } as never,
    phase,
    {
      players: PLAYERS,
      fill: (_t, i) => [1 + (i % 3), 1 + ((i * 7) % 5)],
      mutate: (s) => {
        s.round = 6;
        s.territories.siberia = { owner: 1, armies: 4 };
        mutate?.(s);
      },
    },
  );
}
const reinforce = (n: number): Phase => ({ kind: 'reinforce', remaining: n, mustTrade: false, placed: {}, midTurn: false });

async function words(page: Page): Promise<number> {
  return page.evaluate(() =>
    ['.topstrip', '.strip', '.battle:not(.hidden)']
      .map((q) => document.querySelector(q) as HTMLElement | null)
      .filter((e): e is HTMLElement => !!e && e.offsetParent !== null)
      .map((e) => e.innerText)
      .join(' ')
      .split(/\s+/)
      .filter((w) => /[A-Za-z0-9]/.test(w)).length,
  );
}
/** Slow motion for the ceremony frames, pinned (the controller sets the board's speed on every event). */
const speed = (page: Page, v: number) =>
  page.evaluate((x) => {
    const anim = (window.__board as unknown as { __debug: { anim: Record<string, unknown> } }).__debug.anim;
    delete anim.speed;
    if (x === 1) anim.speed = 1;
    else Object.defineProperty(anim, 'speed', { configurable: true, get: () => x, set: () => undefined });
  }, v);
const posOf = (page: Page, t: string) => page.evaluate((id) => window.__risk.screenPos(id as never)!, t);
const displayedOwner = (page: Page, t: string) => page.evaluate((id) => (window.__board as unknown as { __debug: { owners: Record<string, number> } }).__debug.owners[id], t);

const report: string[] = [];
for (const target of TARGETS) {
  const phone = !/^\d+x\d+$/.test(target);
  let browser: Browser;
  let page: Page;
  let cdp: CDPSession | null = null;
  let errors: string[];
  if (phone) {
    const ctx = await openDevice(target as DeviceName);
    ({ browser, page, cdp, errors } = ctx);
  } else {
    const [w, h] = target.split('x').map(Number);
    ({ browser, page, errors } = await open(undefined, { width: w, height: h }));
  }
  const vp = phone ? DEVICES[target as DeviceName].desc.viewport : page.viewportSize()!;
  const tag = target;
  const shot = async (name: string) => {
    await page.screenshot({ path: `${OUT}/${tag}-${name}.png` });
    const u = await page.evaluate(() => window.__risk.ui());
    report.push(`${tag} ${name}: ${await words(page)} words · "${u.line}" · ${u.buttons.join(' / ') || '-'} · gold ${u.gold ?? '-'}${u.battle ? ` · tray "${u.battle.header}"` : ''}`);
  };
  const press = async (testid: string) => {
    const loc = page.locator(`[data-testid="${testid}"]`).first();
    await loc.waitFor({ state: 'visible', timeout: 5000 });
    const b = (await loc.boundingBox())!;
    if (phone) await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
    else await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  };
  const tapTerr = async (t: string) => {
    const p = await posOf(page, t);
    if (phone) await page.touchscreen.tap(p.x, p.y);
    else await page.mouse.click(p.x, p.y);
  };
  /** A finger / mouse stroke from a to b; `hold` runs with the pointer 75% of the way, still down. */
  const strokeTo = async (a: { x: number; y: number }, b: { x: number; y: number }, hold?: () => Promise<void>) => {
    const steps = 14;
    const at = (i: number) => ({ x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps });
    if (phone) {
      const t = (type: string, p?: { x: number; y: number }) => cdp!.send('Input.dispatchTouchEvent', { type: type as never, touchPoints: p ? [{ x: p.x, y: p.y, id: 1 }] : [] });
      await t('touchStart', a);
      for (let i = 1; i <= steps; i++) {
        await t('touchMove', at(i));
        await page.waitForTimeout(16);
        if (i === Math.round(steps * 0.75) && hold) await hold();
      }
      await t('touchEnd');
    } else {
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      for (let i = 1; i <= steps; i++) {
        await page.mouse.move(at(i).x, at(i).y);
        await page.waitForTimeout(16);
        if (i === Math.round(steps * 0.75) && hold) await hold();
      }
      await page.mouse.up();
    }
  };
  const load = async (s: GameState) => {
    await loadScenario(page, s);
    // (v5.1 A: no hand-off sheet between humans)
    await page.waitForTimeout(1700); // the turn line comes and goes; past the input guard
  };
  const only = process.env.STEPS?.split(',');
  const step = async (name: string, fn: () => Promise<void>) => {
    if (only && !only.includes(name)) return;
    try {
      await fn();
    } catch (e) {
      report.push(`${tag} ${name}: ERROR ${(e as Error).message.split('\n')[0]}`);
    }
  };

  await step('title', async () => {
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForFunction(() => window.__risk?.ui().screen === 'title');
    await page.waitForTimeout(1800);
    await shot('01-title');
    await press('title-new');
    await page.waitForTimeout(700);
    await shot('02-newgame');
  });

  await step('place', async () => {
    await load(base(reinforce(7)));
    await tapTerr('ural');
    await page.waitForTimeout(400);
    await shot('03-place');
    await press('btn-place');
    await idle(page);
    await press('seg-attack');
    await idle(page);
  });

  await step('stroke', async () => {
    const a = await posOf(page, 'ural');
    const b = await posOf(page, 'siberia');
    await strokeTo(a, b, async () => {
      await page.waitForTimeout(60);
      await shot('04-stroke-mid');
    });
    await page.waitForTimeout(500);
    await shot('05-stroke-armed');
  });

  await step('verdict', async () => {
    await speed(page, 0.3);
    await press('btn-roll');
    // Single roll at 1×: shake 120 · tumble 450 · settle 100 · silence 250 (670–920) · verdict 260 → at
    // 0.3× the silence is mid-way at ~2.65 s; the verdict's hairlines and the losing figure's puff (it
    // peaks half-way through the 260 ms verdict) ~0.4 s after the verdict lands at ~3.07 s.
    const t0 = Date.now();
    await page.waitForTimeout(795 / 0.3);
    await shot('06a-dice-silence');
    await page.waitForTimeout(Math.max(0, 920 / 0.3 + 420 - (Date.now() - t0)));
    await shot('06-dice-verdict-puff');
    await speed(page, 1);
    await idle(page);
  });

  await step('conquest', async () => {
    // Sam (human) takes John's Siberia: the sting (torn rim), the smoke, the flood.
    await load(
      base({ kind: 'attack' }, (s) => {
        s.currentPlayer = 1;
        s.territories.ural = { owner: 1, armies: 14 };
        s.territories.siberia = { owner: 0, armies: 1 };
        s.territories.ukraine = { owner: 1, armies: 3 };
      }),
    );
    await tapTerr('siberia');
    await page.waitForTimeout(300);
    await speed(page, 0.3);
    await press('btn-blitz');
    // The last defender falls at the verdict (its count hits 0): the figure lifts off as ink smoke.
    await page.waitForFunction(() => (window.__board as unknown as { __debug: { armies: Record<string, number> } }).__debug.armies.siberia === 0, null, { timeout: 20000, polling: 10 });
    await page.waitForTimeout(350);
    await shot('07a-defender-smoke');
    await page.waitForFunction(() => (window.__board as unknown as { __debug: { owners: Record<string, number> } }).__debug.owners.siberia === 1, null, { timeout: 20000, polling: 10 });
    // At 0.3× the flood takes ~2 s and soaks in slowly at first: mid-soak, then nearly landed.
    await page.waitForTimeout(900);
    await shot('07-conquest-smoke-flood');
    await page.waitForTimeout(250);
    await shot('07b-conquest-flood-late');
    await speed(page, 1);
    await idle(page);
    void displayedOwner;
  });

  await step('ai', async () => {
    await load(
      base(reinforce(0), (s) => {
        s.players[1].kind = 'ai';
        (s.players[1] as { difficulty?: string }).difficulty = 'normal';
      }),
    );
    await press('seg-endTurn');
    await page.waitForFunction(() => / attacks /.test(window.__risk.ui().line), null, { timeout: 25_000, polling: 30 });
    await page.waitForTimeout(250);
    await shot('08-ai-turn');
    await idle(page, 40000).catch(() => undefined);
  });

  await step('turnline', async () => {
    // v5.1 A: John ends his turn and the next seat's turn line is the whole hand-off (no cover, no cup).
    await loadScenario(page, base({ kind: 'attack' }));
    await page.waitForTimeout(1700);
    await press('seg-endTurn');
    await page.waitForFunction(() => /'s turn/.test(window.__risk.ui().bannerLine ?? ''), null, { timeout: 8000 }).catch(() => undefined);
    await page.waitForTimeout(250);
    await shot('09a-turn-line');
    await idle(page, 40000).catch(() => undefined);
  });

  await step('menu', async () => {
    await load(base({ kind: 'attack' }));
    await press('menu');
    await page.waitForTimeout(600);
    await shot('09-menu');
    await press('pause-rules');
    await page.waitForTimeout(700);
    await shot('10-rules');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  });

  await step('idle', async () => {
    await load(base({ kind: 'attack' }));
    await page.waitForTimeout(2500);
    const f0 = await page.evaluate(() => (window.__board as unknown as { __debug: { drawn: number } }).__debug.drawn);
    const t0 = Date.now();
    for (let i = 1; i <= 3; i++) {
      await shot(`11-idle-${i}`);
      if (i < 3) await page.waitForTimeout(4000);
    }
    const f1 = await page.evaluate(() => (window.__board as unknown as { __debug: { drawn: number } }).__debug.drawn);
    const amb = await page.evaluate(() => (window.__board as unknown as { __debug: { ambient: unknown } }).__debug.ambient);
    report.push(`${tag} idle: ${((f1 - f0) / ((Date.now() - t0) / 1000)).toFixed(1)} frames/s drawn while only the ambient layer runs · ${JSON.stringify(amb)}`);
  });

  await step('victory', async () => {
    const all: Partial<Record<TerritoryId, [number, number]>> = {};
    for (const id of TERRITORY_IDS) all[id] = [0, 2];
    all.alaska = [1, 1];
    all.kamchatka = [0, 30];
    await load(
      scenario(all, { kind: 'attack' }, {
        players: TWO_HUMANS as never,
        mutate: (st) => {
          st.config.dominationPercent = 100;
          st.round = 14;
        },
      }),
    );
    await tapTerr('alaska');
    await page.waitForTimeout(250);
    await press('btn-blitz');
    await page.waitForFunction(() => window.__risk.ui().screen === 'victory', null, { timeout: 20000 });
    await page.waitForTimeout(1400);
    await shot('12-victory-board');
    if (phone) await page.touchscreen.tap(vp.width / 2, vp.height / 2);
    else await page.mouse.click(vp.width / 2, vp.height / 2);
    await page.locator('[data-testid="rematch"]').waitFor({ state: 'visible', timeout: 4000 });
    await page.waitForTimeout(1200);
    await shot('13-victory-scroll');
    void state;
  });

  report.push(`${tag} console errors: ${errors.length ? errors.join(' | ') : 0}`);
  console.log(tag, 'done');
  await browser.close();
}
writeFileSync(`${OUT}/report.txt`, report.join('\n') + '\n');
console.log(report.join('\n'));
