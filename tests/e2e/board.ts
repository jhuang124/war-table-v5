// Resting-board screenshot tool for the v3 physical board (_claude/v3/PLAN.md §1): the round-6 board at rest
// on desktop and phones, plus a 30 % downscale (the couch squint). A tool, not in test:e2e.
// Usage: npx tsx tests/e2e/board.ts [outDir] [1440x900,iphone,iphone-land] [tag]   (server on RISK_URL)
import { clickT, loadScenario, open } from './lib';
import { restBoard } from './board-lib';
import { openDevice, type DeviceName } from './mobile-lib';
import type { Browser, Page } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'artifacts/board';
const TARGETS = (process.argv[3] ?? '1440x900,iphone,iphone-land').split(',');
const TAG = process.argv[4] ?? 'rest';
mkdirSync(OUT, { recursive: true });

async function settle(page: Page) {
  // (v5.1 A: no hand-off cover to accept between humans; the turn line dries on its own)
  await page.waitForTimeout(2600);
}

for (const target of TARGETS) {
  const phone = !/^\d+x\d+$/.test(target);
  let browser: Browser;
  let page: Page;
  if (phone) ({ browser, page } = await openDevice(target as DeviceName));
  else {
    const [w, h] = target.split('x').map(Number);
    ({ browser, page } = await open(undefined, { width: w, height: h }, Number(process.env.DPR ?? 1)));
  }
  await loadScenario(page, restBoard({ kind: 'attack' }));
  await settle(page);
  // SELECT=territory: pick it first (its reach: the lanes brighten, land it can't touch recedes)
  if (process.env.SELECT) {
    await clickT(page, process.env.SELECT);
    await page.waitForTimeout(500);
  }
  const path = `${OUT}/${TAG}-${target}.png`;
  await page.screenshot({ path });
  // CLIP=x,y,w,h: a close-up of that region too (CSS px)
  if (process.env.CLIP) {
    const [x, y, width, height] = process.env.CLIP.split(',').map(Number);
    await page.screenshot({ path: `${OUT}/${TAG}-${target}-closeup.png`, clip: { x, y, width, height } });
  }
  if (!phone) {
    // the couch squint: the same frame at 30 %
    const vp = page.viewportSize()!;
    const data = await page.screenshot({ type: 'png' });
    const b64 = data.toString('base64');
    const small = await page.evaluate(
      async ([src, w, h]) => {
        const img = new Image();
        img.src = 'data:image/png;base64,' + src;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = Math.round(w * 0.3);
        c.height = Math.round(h * 0.3);
        const g = c.getContext('2d')!;
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, c.width, c.height);
        return c.toDataURL('image/png').split(',')[1];
      },
      [b64, vp.width, vp.height] as const,
    );
    const { writeFileSync } = await import('node:fs');
    writeFileSync(`${OUT}/${TAG}-${target}-squint30.png`, Buffer.from(small, 'base64'));
  }
  console.log('wrote', path);
  await browser.close();
}
