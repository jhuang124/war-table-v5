// v6 maps: every visible pack boots, starts a game, and takes a placement. For each maps/<id>/pack.json
// without `hidden`: open ?map=<id>, title → New game → Start, wait for the game, check the booted map and the
// territory count against rules.json, place once on the strongest own territory, and save a rest shot to
// artifacts/e2e/maps-<id>.png. Logic lane, instant.
import { readdirSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { check, clearStorage, clickBtn, finish, launchBrowser, prepareContext, pickMap, place, rendered, state, BASE, ART } from './lib';

const results: string[] = [];
const errors: string[] = [];
const root = resolve(process.cwd());
const packs = readdirSync(resolve(root, 'maps'))
  .filter((id) => existsSync(resolve(root, 'maps', id, 'pack.json')))
  .map((id) => ({ id, manifest: JSON.parse(readFileSync(resolve(root, 'maps', id, 'pack.json'), 'utf8')) as { id: string; hidden?: boolean; extends?: string } }))
  .filter((p) => !p.manifest.hidden);
results.push(`visible packs: ${packs.map((p) => p.id).join(', ')}`);
mkdirSync(ART, { recursive: true });

const browser = await launchBrowser();
for (const p of packs) {
  const rulesPath = resolve(root, 'maps', p.manifest.extends ?? p.id, 'rules.json');
  const rules = JSON.parse(readFileSync(rulesPath, 'utf8')) as { territories: unknown[]; continents: unknown[] };
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await prepareContext(context);
  const page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && errors.push(`${p.id}: ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`${p.id}: ${String(e)}`));
  await page.goto(`${BASE}?map=${p.id}`);
  await page.waitForFunction(() => !!window.__risk);
  await clearStorage(page);
  await page.goto(`${BASE}?map=${p.id}`);
  await page.waitForFunction(() => !!window.__risk);
  const booted = await page.evaluate(() => window.__risk.map());
  check(booted === p.id, `${p.id}: the page boots on it (${booted})`, results);
  await clickBtn(page, 'title-new');
  await page.waitForTimeout(600);
  await pickMap(page, p.id);
  const picked = await page.evaluate(() => document.querySelector('[data-testid="map-picker"] .map-opt[aria-checked="true"]')?.getAttribute('data-map'));
  check(picked === p.id, `${p.id}: the Where row shows it picked (${picked})`, results);
  await clickBtn(page, 'ng-start');
  // starting on another map than the page booted on reloads the page onto it (the reload handoff)
  const deadline = Date.now() + 30_000;
  for (;;) {
    const ok = await page
      .waitForFunction(() => !!window.__risk && window.__risk.ui().screen === 'game' && !!window.__risk.getState(), null, { timeout: 5_000 })
      .then(() => true, () => false);
    if (ok) break;
    if (Date.now() > deadline) throw new Error(`${p.id}: the game did not start within 30 s`);
  }
  await page.waitForFunction(
    () => {
      const s = window.__risk.getState();
      return !!s && s.players[s.currentPlayer].kind === 'human' && s.phase.kind === 'reinforce' && window.__risk.isIdle();
    },
    null,
    { timeout: 120_000, polling: 50 },
  );
  await rendered(page);
  const s = (await state(page))!;
  const n = Object.keys(s.territories).length;
  check(n === rules.territories.length && s.config.mapId === p.id, `${p.id}: ${n} territories dealt on config.mapId=${s.config.mapId} (rules.json has ${rules.territories.length}, ${rules.continents.length} continents)`, results);
  await page.screenshot({ path: `${ART}/maps-${p.id}.png` });
  const mine = (Object.keys(s.territories) as (keyof typeof s.territories)[]).filter((t) => s.territories[t].owner === 0);
  const tile = mine.sort((a, b) => s.territories[b].armies - s.territories[a].armies)[0];
  await place(page, tile as string);
  const after = (await state(page))!;
  check(after.territories[tile as keyof typeof after.territories].armies > s.territories[tile].armies, `${p.id}: a placement on ${String(tile)} landed`, results);
  await context.close();
}
await browser.close();
finish(results, errors);
