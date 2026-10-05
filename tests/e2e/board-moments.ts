// Two frozen moments for the v3 review: the dice in flight (~150 ms into the roll; v5.1 B: no cup, they pour
// in from the attacker's side of the ring) and the elimination topple
// (mid-topple, and at the last disc). The board runs in slow motion (__debug.anim.speed) and the DOM's own
// animations are paused at their frame, so each shot is the beat. A tool, not in test:e2e.
// Usage: npx tsx tests/e2e/board-moments.ts [outDir]   (server on RISK_URL)
import { clickT, idle, loadScenario, open, realtime, scenario } from './lib';
import { restBoard, PLAYERS } from './board-lib';
import type { Page } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'artifacts/board';
mkdirSync(OUT, { recursive: true });
const { page, browser } = await open(undefined, { width: 1440, height: 900 }, Number(process.env.DPR ?? 1));
await realtime(page);
const speed = (p: Page, v: number) =>
  p.evaluate((x) => {
    const anim = (window.__board as unknown as { __debug: { anim: Record<string, unknown> } }).__debug.anim;
    delete anim.speed;
    if (x === 1) anim.speed = 1;
    else Object.defineProperty(anim, 'speed', { configurable: true, get: () => x, set: () => undefined });
  }, v);
const press = async (id: string) => {
  const b = (await page.locator(`[data-testid="${id}"]`).first().boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
};
// (v5.1 A: no hand-off cover; the turn line dries on its own)
const cover = () => page.waitForTimeout(1800);

// --- the dice in flight -----------------------------------------------------------------------------------
await loadScenario(page, restBoard({ kind: 'attack' }, (s) => void (s.territories.siberia = { owner: 1, armies: 3 })));
await cover();
await clickT(page, 'ural');
await page.waitForTimeout(250);
await clickT(page, 'siberia');
await page.waitForTimeout(400);
await speed(page, 0.05);
await press('btn-roll');
// the dice fly on the board (WebGL) at 1/20 speed: 150 ms of board time is 3 s of wall time
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/moment-roll-150ms.png` });
await page.screenshot({ path: `${OUT}/moment-roll-150ms-closeup.png`, clip: { x: 0, y: 0, width: 760, height: 620 } });
await speed(page, 1);
await idle(page);

// --- the elimination topple ------------------------------------------------------------------------------
// Sam (a human seat) holds only Siberia, 4 armies; John's 19 on Ural takes it and knocks Sam out.
const s2 = scenario({ ural: [0, 19], siberia: [1, 4] }, { kind: 'attack' }, {
  players: PLAYERS,
  fill: (t, i) => (t === 'siberia' ? [1, 4] : [i % 2 === 0 ? 2 : 3, 1 + ((i * 7) % 5)]),
  mutate: (s) => void (s.round = 7),
});
await loadScenario(page, s2);
await cover();
await clickT(page, 'ural');
await page.waitForTimeout(250);
await clickT(page, 'siberia');
await page.waitForTimeout(400);
await speed(page, 0.2);
await press('btn-blitz');
await page.waitForFunction(() => (window.__board as unknown as { __debug: { armies: Record<string, number> } }).__debug.armies.siberia === 0, null, { timeout: 30000, polling: 10 });
// topple: 280 ms tip, then 920 ms of discs dissolving (at 0.2×: 1.4 s, then 4.6 s)
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/moment-topple-mid.png`, clip: { x: 760, y: 90, width: 520, height: 300 } });
await page.waitForTimeout(3300);
await page.screenshot({ path: `${OUT}/moment-topple-last-disc.png`, clip: { x: 760, y: 90, width: 520, height: 300 } });
await speed(page, 1);
await idle(page, 30000).catch(() => undefined);
console.log('done');
await browser.close();
