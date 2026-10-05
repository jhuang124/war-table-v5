// Motion screenshots for the v3 physical board (_claude/v3/PLAN.md §1): a roll (v5.1: no cup), a disc sliding
// off at the verdict, a conquest's stack walking the arrow, a placement drop, the ledger open. The board runs
// in slow motion (__debug.anim.speed) so each frame is the beat. A tool, not in test:e2e.
// Usage: npx tsx tests/e2e/board-motion.ts [outDir] [1440x900|iphone-land]   (server on RISK_URL)
import { clickT, idle, loadScenario, open, realtime } from './lib';
import { openDevice, type DeviceName } from './mobile-lib';
import { restBoard } from './board-lib';
import type { Page } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'artifacts/board';
const TARGET = process.argv[3] ?? '1440x900';
mkdirSync(OUT, { recursive: true });

const phone = !/^\d+x\d+$/.test(TARGET);
const ctx = phone ? await openDevice(TARGET as DeviceName) : await open(undefined, { width: +TARGET.split('x')[0], height: +TARGET.split('x')[1] }, Number(process.env.DPR ?? 1));
const { page, browser } = ctx;
await realtime(page);

const speed = (p: Page, v: number) =>
  p.evaluate((x) => {
    const anim = (window.__board as unknown as { __debug: { anim: Record<string, unknown> } }).__debug.anim;
    delete anim.speed;
    if (x === 1) anim.speed = 1;
    else Object.defineProperty(anim, 'speed', { configurable: true, get: () => x, set: () => undefined });
  }, v);
const press = async (id: string) => {
  const loc = page.locator(`[data-testid="${id}"]`).first();
  await loc.waitFor({ state: 'visible', timeout: 6000 });
  const b = (await loc.boundingBox())!;
  if (phone) await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
  else await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
};
const shot = (n: string) => page.screenshot({ path: `${OUT}/motion-${TARGET}-${n}.png` });
// (v5.1 A: no hand-off cover to accept; this only lets the turn line dry)
const handoff = () => page.waitForTimeout(1800);
const only = process.env.STEPS?.split(',');
const step = async (name: string, fn: () => Promise<void>) => {
  if (only && !only.includes(name)) return;
  try {
    await fn();
  } catch (e) {
    console.log(name, 'ERROR', (e as Error).message.split('\n')[0]);
  }
};

await step('place', async () => {
  await loadScenario(page, restBoard({ kind: 'reinforce', remaining: 3, mustTrade: false, placed: {}, midTurn: false }));
  await handoff();
  await clickT(page, 'ural');
  await page.waitForTimeout(400);
  await shot('01-place-ghost');
  await speed(page, 0.25);
  await press('btn-place');
  await page.waitForTimeout(260);
  await shot('02-place-drop');
  await speed(page, 1);
  await idle(page);
});

await step('roll', async () => {
  await loadScenario(
    page,
    restBoard({ kind: 'attack' }, (s) => {
      s.territories.siberia = { owner: 1, armies: 3 };
    }),
  );
  await handoff();
  await clickT(page, 'ural');
  await page.waitForTimeout(250);
  await clickT(page, 'siberia');
  await page.waitForTimeout(400);
  await speed(page, 0.3);
  await press('btn-roll');
  await page.waitForTimeout(450 / 0.3);
  await shot('03-roll-mid');
  await page.waitForTimeout(500 / 0.3);
  await shot('04-verdict');
  await speed(page, 1);
  await idle(page);
});

await step('conquest', async () => {
  await loadScenario(
    page,
    restBoard({ kind: 'attack' }, (s) => {
      s.territories.siberia = { owner: 1, armies: 1 };
    }),
  );
  await handoff();
  await clickT(page, 'ural');
  await page.waitForTimeout(250);
  await clickT(page, 'siberia');
  await page.waitForTimeout(300);
  await speed(page, 0.25);
  await press('btn-blitz');
  await page.waitForFunction(() => (window.__board as unknown as { __debug: { owners: Record<string, number> } }).__debug.owners.siberia === 0, null, { timeout: 20000, polling: 10 });
  await page.waitForFunction(() => (window.__board as unknown as { __debug: { tokens: { travelers: unknown[] } } }).__debug.tokens.travelers.length > 0, null, { timeout: 8000, polling: 10 }).catch(() => undefined);
  await page.waitForTimeout(700);
  await shot('05a-occupy-ghost');
  // a human's occupy: the chosen count's stack walks the arrow
  await speed(page, 0.25);
  await press('btn-move');
  await page.waitForTimeout(800);
  await shot('05-conquest-walk');
  await speed(page, 1);
  await idle(page);
  await page.waitForTimeout(600);
  await shot('06-after-conquest');
});

await step('ledger', async () => {
  const loc = page.locator('[data-testid="events"]').first();
  if (await loc.count()) {
    await press('events');
    await page.waitForTimeout(700);
    await shot('07-ledger-open');
  } else console.log('no ledger toggle');
});

console.log('done');
await browser.close();
