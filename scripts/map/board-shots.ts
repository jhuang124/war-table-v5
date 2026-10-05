// Map-pack hand-check on the real board (docs/MAPS.md "What an author hand-verifies"): screenshots of a
// pack at rest and close-ups, plus a phone-size tap check on the smallest territories.
//   npx vite --port 5392 --strictPort --host 127.0.0.1 &
//   npx tsx scripts/map/board-shots.ts --map true-world [--url http://127.0.0.1:5392/]
// Writes artifacts/maps/<id>-*.png. Needs a dev server or a VITE_E2E build (the ?map= hook).

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { ROOT, mapArg } from './pack';

const id = mapArg();
const urlArg = process.argv.indexOf('--url');
const BASE = urlArg > 0 ? process.argv[urlArg + 1] : 'http://127.0.0.1:5392/';
const OUT = resolve(ROOT, 'artifacts/maps');
mkdirSync(OUT, { recursive: true });

type XY = { x: number; y: number };
const PLAYERS = [
  { name: 'John', color: 'crimson', kind: 'human' },
  { name: 'Sam', color: 'cobalt', kind: 'human' },
  { name: 'Priya', color: 'amber', kind: 'ai', difficulty: 'normal' },
];

/** Close-ups: territories whose screen positions frame the shot, plus padding (css px). */
const CLOSEUPS: { name: string; frame: string[]; pad: number; leftEdge?: boolean; rightEdge?: boolean; arrow: [string, string] }[] = [
  { name: 'bering-west', frame: ['alaska', 'northwest_territory'], pad: 90, leftEdge: true, arrow: ['alaska', 'kamchatka'] },
  { name: 'bering-east', frame: ['kamchatka', 'yakutsk'], pad: 90, rightEdge: true, arrow: ['kamchatka', 'alaska'] },
  { name: 'central-america', frame: ['central_america', 'venezuela', 'eastern_us'], pad: 60, arrow: ['central_america', 'venezuela'] },
  { name: 'mediterranean', frame: ['western_europe', 'southern_europe', 'north_africa', 'egypt'], pad: 50, arrow: ['southern_europe', 'north_africa'] },
  { name: 'europe', frame: ['iceland', 'great_britain', 'scandinavia', 'southern_europe'], pad: 60, arrow: ['great_britain', 'western_europe'] },
];

async function boot(page: Page) {
  await page.goto(`${BASE}?map=${id}`);
  await page.waitForFunction(() => !!(window as unknown as { __risk?: unknown }).__risk);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => !!(window as unknown as { __risk?: unknown }).__risk);
  await page.evaluate(
    ([players, mapId]) => {
      window.__risk.setSpeed(0, 'instant');
      window.__risk.newGame({ players: players as never, initialPlacement: 'auto', seed: 11, mapId: mapId as string });
    },
    [PLAYERS, id] as const,
  );
  await page.evaluate(() => window.__risk.waitIdle(30000));
  await page.waitForTimeout(1500);
}

const pos = (page: Page, t: string) =>
  page.evaluate((x) => {
    try {
      return window.__risk.screenPos(x as never);
    } catch {
      return null; // a classic close-up on another pack: skipped
    }
  }, t) as Promise<XY | null>;

async function main() {
  const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio'] });
  const report: string[] = [];
  try {
    // Desktop at rest + close-ups (rendered at 2× so the close-ups are sharp).
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await boot(page);
    const cfg = await page.evaluate(() => window.__risk.getState()?.config.mapId ?? '(none)');
    report.push(`config.mapId = ${cfg}`);
    const ppu = await page.evaluate(() => (window.__board as unknown as { __debug: { homePxPerUnit: () => number } }).__debug.homePxPerUnit());
    report.push(`home scale: ${ppu.toFixed(2)} css px per board unit (an army disc of 1.3 units = ${(1.3 * ppu).toFixed(1)} px)`);
    await page.screenshot({ path: resolve(OUT, `${id}-rest.png`), scale: 'css' });
    for (const c of CLOSEUPS) {
      const ps = (await Promise.all(c.frame.map((t) => pos(page, t)))).filter((p): p is XY => !!p);
      if (!ps.length) continue;
      let x0 = Math.min(...ps.map((p) => p.x)) - c.pad, x1 = Math.max(...ps.map((p) => p.x)) + c.pad;
      let y0 = Math.min(...ps.map((p) => p.y)) - c.pad, y1 = Math.max(...ps.map((p) => p.y)) + c.pad;
      if (c.leftEdge) x0 = 0;
      if (c.rightEdge) x1 = 1440;
      x0 = Math.max(0, x0), y0 = Math.max(0, y0), x1 = Math.min(1440, x1), y1 = Math.min(900, y1);
      // Select the crossing's source and aim at the other shore, so the lane and its target light up.
      await page.evaluate(([from, to]) => {
        window.__board!.setHighlights({ selected: from as never, targets: [to as never], arrow: { from: from as never, to: to as never, kind: 'attack' } });
      }, c.arrow);
      await page.waitForTimeout(900);
      await page.screenshot({ path: resolve(OUT, `${id}-${c.name}.png`), clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } });
      await page.evaluate(() => window.__board!.setHighlights({}));
      await page.waitForTimeout(300);
    }
    report.push(`desktop page errors: ${errors.length ? errors.join(' | ') : 'none'}`);
    await ctx.close();

    // Phone portrait + landscape: every territory tappable at its army, the small ones checked hardest.
    for (const vp of [{ name: 'phone', width: 390, height: 844 }, { name: 'phone-land', width: 844, height: 390 }]) {
      const pc = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
      const pp = await pc.newPage();
      await boot(pp);
      await pp.screenshot({ path: resolve(OUT, `${id}-${vp.name}.png`), scale: 'css' });
      const res = await pp.evaluate(() => {
        const dbg = (window.__board as unknown as { __debug: { touchPick: (x: number, y: number) => string | null; pick: (x: number, y: number) => string | null } }).__debug;
        const s = window.__risk.getState()!;
        const out: { t: string; hit: string | null; ring: number; onScreen: boolean }[] = [];
        for (const t of Object.keys(s.territories)) {
          let p: { x: number; y: number } | null = null;
          try {
            p = window.__risk.screenPos(t as never);
          } catch {
            p = null;
          }
          if (!p) {
            out.push({ t, hit: null, ring: 0, onScreen: false });
            continue;
          }
          const hit = dbg.pick(p.x, p.y);
          // How many of 8 points 8 px around the army still pick this territory (mouse pick, no tolerance).
          let ring = 0;
          for (let k = 0; k < 8; k++) {
            const a = (k / 8) * Math.PI * 2;
            if (dbg.pick(p.x + 8 * Math.cos(a), p.y + 8 * Math.sin(a)) === t) ring++;
          }
          out.push({ t, hit, ring, onScreen: p.x >= 0 && p.y >= 0 && p.x <= innerWidth && p.y <= innerHeight });
        }
        return out;
      });
      const bad = res.filter((r) => r.hit !== r.t);
      const weak = res.filter((r) => r.hit === r.t && r.ring < 6).map((r) => `${r.t} ${r.ring}/8`);
      report.push(`${vp.name} ${vp.width}×${vp.height}: ${res.length - bad.length}/${res.length} armies pick their own territory${bad.length ? ` (misses: ${bad.map((b) => `${b.t}→${b.hit}${b.onScreen ? '' : ' offscreen'}`).join(', ')})` : ''}; 8 px ring weak: ${weak.join(', ') || 'none'}`);
      await pc.close();
    }
  } finally {
    await browser.close();
  }
  for (const r of report) console.log(r);
  console.log(`shots: artifacts/maps/${id}-*.png`);
}

await main();
