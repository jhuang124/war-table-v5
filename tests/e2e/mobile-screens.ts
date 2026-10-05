// Mobile screenshot sweep (docs/MOBILE.md §8; a tool, not in test:e2e): every state on the emulated
// iPhone 15 Pro (portrait + landscape), iPad Pro 11 (portrait + landscape) and Pixel 7, taps only:
// title, new game (+ colour sheet), place, attack armed, rolling, occupy, fortify, cards, hand-off,
// the menu / settings / rules / log sheets, the long-press name card, the rotate pill, victory.
// Usage: npx tsx tests/e2e/mobile-screens.ts [outDir] [device,...]   (server on RISK_URL)
import { idle, loadScenario, scenario, state, TWO_HUMANS } from './lib';
import { DEVICES, longPress, openDevice, pageStill, settle, tapId, tapT, type DeviceName } from './mobile-lib';
import type { GameState, Phase } from '../../src/engine';
import type { Page } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = process.argv[2] ?? 'artifacts/mobile';
const LIST = (process.argv[3] ?? 'iphone,iphone-land,ipad,ipad-land,pixel').split(',') as DeviceName[];
mkdirSync(OUT, { recursive: true });

const PLAYERS = [
  { name: 'John', color: 'crimson', kind: 'human' },
  { name: 'Cobalt', color: 'cobalt', kind: 'ai', difficulty: 'normal' },
  { name: 'Amber', color: 'amber', kind: 'ai', difficulty: 'normal' },
  { name: 'Emerald', color: 'emerald', kind: 'ai', difficulty: 'normal' },
] as never;
const own = (t: string[]) => Object.fromEntries(t.map((x) => [x, [0, 2]]));

function base(phase: Phase, mutate?: (s: GameState) => void, players = PLAYERS): GameState {
  return scenario(
    { ...own(['ural', 'ukraine', 'afghanistan', 'middle_east', 'india', 'scandinavia', 'egypt', 'north_africa', 'brazil', 'peru']), ural: [0, 12] } as never,
    phase,
    {
      players,
      fill: (_t, i) => [1 + (i % ((players as unknown[]).length - 1)), 1 + ((i * 7) % 4)],
      mutate: (s) => {
        s.round = 6;
        s.players[0].cards = [
          { id: 0, territory: 'ural', symbol: 'infantry' },
          { id: 1, territory: 'peru', symbol: 'cavalry' },
          { id: 2, territory: 'brazil', symbol: 'artillery' },
        ];
        s.territories.siberia = { owner: 1, armies: 5 };
        mutate?.(s);
      },
    },
  );
}

// A tap straight after a scenario loads can land in the controller's 250 ms guard after a turn starts
// (it's dropped on purpose): wait for the board to idle, then past the guard.
async function pastGuard(page: Page): Promise<void> {
  await page.evaluate(() => window.__risk.waitIdle(5000)).catch(() => undefined);
  await page.waitForTimeout(320);
}

const report: string[] = [];
for (const dev of LIST) {
  const ctx = await openDevice(dev);
  const { page, browser, errors } = ctx;
  const vp = DEVICES[dev].desc.viewport;
  const portrait = vp.height > vp.width;
  const shot = async (name: string) => {
    await settle(page, 120);
    await page.screenshot({ path: `${OUT}/${dev}-${name}.png` });
    const still = await pageStill(page);
    report.push(`${dev} ${name}${still.ok ? '' : ` SCROLLED ${still.detail}`}`);
  };
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      report.push(`${dev} ${name}: ERROR ${(e as Error).message.split('\n')[0]}`);
      console.log(dev, name, 'ERROR', (e as Error).message.split('\n')[0]);
    }
  };
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => window.__risk?.ui().screen === 'title');
  await page.waitForTimeout(1200);
  await step('title', () => shot('01-title'));
  await step('newgame', async () => {
    await tapId(page, 'title-new');
    await page.waitForTimeout(600);
    await shot('02-newgame');
    await tapId(page, 'seat-color-1');
    await page.waitForTimeout(450);
    await shot('03-newgame-colors');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    // Scroll the new game body to its end (sticky Start stays).
    await page.evaluate(() => document.querySelector('.ng-grid')?.scrollTo(0, 9999));
    await page.waitForTimeout(200);
    await shot('04-newgame-end');
  });
  await step('place', async () => {
    await loadScenario(page, base({ kind: 'reinforce', remaining: 5, mustTrade: false, placed: {}, midTurn: false }));
    await pastGuard(page);
    await page.waitForTimeout(1300);
    if (portrait) await shot('05-rotate-pill');
    await page.evaluate(() => document.querySelector<HTMLElement>('[data-testid="rotate-pill-close"]')?.click());
    await tapT(page, 'ural');
    await page.waitForTimeout(400);
    await shot('06-place');
  });
  await step('namecard', async () => {
    const pos = await page.evaluate(() => window.__risk.screenPos('india' as never));
    if (pos) {
      await longPress(ctx, pos.x, pos.y, 700, async () => {
        await page.waitForTimeout(80);
        await page.screenshot({ path: `${OUT}/${dev}-07-namecard.png` });
      });
      report.push(`${dev} 07-namecard`);
    }
  });
  await step('cards', async () => {
    if (await page.locator('[data-testid="btn-cards"]').count()) {
      await tapId(page, 'btn-cards');
      await page.waitForTimeout(450);
      await shot('08-cards');
      await tapId(page, 'cards-close');
      await page.waitForTimeout(400);
    }
  });
  await step('attack', async () => {
    await tapId(page, 'btn-place');
    await idle(page);
    await tapId(page, 'seg-attack');
    await idle(page);
    await tapT(page, 'siberia');
    await page.waitForTimeout(450);
    await shot('09-attack-armed');
    await tapId(page, 'btn-roll');
    await page.waitForTimeout(750);
    await shot('10-rolling');
    await idle(page);
    for (let i = 0; i < 4; i++) {
      const s = (await state(page))!;
      if (s.phase.kind !== 'attack' || s.territories.siberia.owner === 0 || s.territories.ural.armies < 2) break;
      await tapId(page, 'btn-blitz');
      await idle(page);
    }
    if ((await state(page))!.phase.kind === 'occupy') {
      await page.waitForTimeout(300);
      await shot('11-occupy');
      await tapId(page, 'btn-move');
      await idle(page);
    }
  });
  await step('fortify', async () => {
    await tapId(page, 'seg-fortify');
    await idle(page);
    const sf = (await state(page))!;
    const src = (['ural', 'siberia', 'ukraine', 'afghanistan'] as const).find((t) => sf.territories[t].owner === 0 && sf.territories[t].armies >= 2);
    if (src) {
      await tapT(page, src);
      const dst = (['ukraine', 'afghanistan', 'middle_east', 'ural'] as const).find((t) => t !== src && sf.territories[t].owner === 0);
      if (dst) await tapT(page, dst);
    }
    await page.waitForTimeout(400);
    await shot('12-fortify');
  });
  await step('sheets', async () => {
    await tapId(page, 'menu');
    await page.waitForTimeout(450);
    await shot('13-menu');
    await tapId(page, 'pause-settings');
    await page.waitForTimeout(450);
    await shot('14-settings');
    await tapId(page, 'settings-done');
    await page.waitForTimeout(400);
    await tapId(page, 'pause-rules');
    await page.waitForTimeout(450);
    await shot('15-rules');
    await tapId(page, 'rules-close');
    await page.waitForTimeout(400);
    await tapId(page, 'pause-log');
    await page.waitForTimeout(450);
    await shot('16-log');
    await tapId(page, 'log-close');
    await page.waitForTimeout(400);
    await tapId(page, 'pause-resume');
    await page.waitForTimeout(400);
  });
  await step('ai', async () => {
    await tapId(page, 'seg-endTurn');
    await page.waitForFunction(() => / attacks /.test(window.__risk.ui().line), null, { timeout: 25_000, polling: 30 }).catch(() => undefined);
    await page.waitForTimeout(300);
    await shot('17-ai-turn');
  });
  await step('turnline', async () => {
    // Two humans (v5.1 A): John ends his turn; Sam's turn line is the hand-off (no cover).
    const s = base({ kind: 'attack' }, (st) => {
      st.players[1].cards = [{ id: 7, territory: 'siam', symbol: 'cavalry' }];
    }, TWO_HUMANS as never);
    await loadScenario(page, s);
    await pastGuard(page);
    await tapId(page, 'seg-endTurn');
    await page.waitForFunction(() => /^Sam's turn/.test(window.__risk.ui().bannerLine ?? ''), null, { timeout: 8000 }).catch(() => undefined);
    await page.waitForTimeout(250);
    await shot('18-turn-line');
  });
  await step('victory', async () => {
    const s = base({ kind: 'attack' }, (st) => {
      for (const t of Object.keys(st.territories)) (st.territories as Record<string, { owner: number; armies: number }>)[t] = { owner: 0, armies: 1 };
      st.territories.alaska = { owner: 1, armies: 1 };
      st.territories.kamchatka = { owner: 0, armies: 30 };
      st.config.dominationPercent = 100;
      st.players[2].eliminated = true;
      st.players[3].eliminated = true;
      st.timeline = Array.from({ length: 8 }, (_, i) => ({ round: i + 1, territories: { 0: 10 + i * 3, 1: 12 - i, 2: 10 - i, 3: 10 - i } })) as never;
    });
    await loadScenario(page, s);
    await pastGuard(page);
    await tapT(page, 'alaska');
    await tapId(page, 'btn-blitz');
    await page.waitForFunction(() => window.__risk.ui().screen === 'victory', null, { timeout: 20000 });
    await page.waitForTimeout(900);
    await shot('19-victory-intro');
    await page.waitForTimeout(3200);
    await shot('20-victory');
    await page.evaluate(() => document.querySelector('.victory-screen .v-scroll, .victory-screen')?.scrollTo(0, 9999));
    await page.waitForTimeout(300);
    await shot('21-victory-end');
  });
  await step('long-fight', async () => {
    // The longest pair on the map: the fight header must fit (and only show with the tray on phones).
    const s = base({ kind: 'attack' }, (st) => {
      st.territories.western_europe = { owner: 0, armies: 9 };
      st.territories.southern_europe = { owner: 1, armies: 6 };
    });
    await loadScenario(page, s);
    await pastGuard(page);
    await page.evaluate(() => document.querySelector<HTMLElement>('[data-testid="rotate-pill-close"]')?.click());
    await tapT(page, 'southern_europe');
    await page.waitForTimeout(400);
    await shot('22-long-armed');
    await tapId(page, 'btn-roll');
    await page.waitForTimeout(700);
    await shot('23-long-rolling');
    await idle(page);
    await page.waitForTimeout(1800);
    await shot('24-long-after');
  });
  report.push(`${dev} console errors: ${errors.length}${errors.length ? ' ' + errors.slice(0, 5).join(' | ') : ''}`);
  console.log(dev, 'done', errors.length ? errors.slice(0, 3) : 'no errors');
  await browser.close();
}
writeFileSync(`${OUT}/report.txt`, report.join('\n') + '\n');
console.log(report.join('\n'));
