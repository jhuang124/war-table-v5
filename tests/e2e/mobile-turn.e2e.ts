// A full human turn by taps only (docs/MOBILE.md §8) on the emulated iPhone 15 Pro in portrait and
// landscape, and on the iPad Pro 11 in portrait (the stacked tablet dock): place with the stepper (−),
// place the rest, the Turn Track to Attack, one Roll, Blitz to the capture, Occupy with the slider,
// the Track to Fortify, pick a route, `Move N · end turn`. After every step: the document never
// scrolled or zoomed, the dock and seat pills sit inside the safe area, every dock control is ≥ 44 px (on
// the phones every control in the UI: the dock, the top strip, the menu and Settings sheets).
// 0 console errors.
import { check, finish, idle, loadScenario, scenario, state, ui } from './lib';
import { DEVICES, openDevice, pageStill, smallTargets, tapId, tapT, type DeviceName } from './mobile-lib';
import type { GameState } from '../../src/engine';

const results: string[] = [];
const allErrors: string[] = [];

function turnScenario(): GameState {
  const own: Record<string, [number, number]> = {
    ural: [0, 12],
    ukraine: [0, 2],
    afghanistan: [0, 2],
    middle_east: [0, 2],
    scandinavia: [0, 2],
    egypt: [0, 2],
    north_africa: [0, 2],
    brazil: [0, 2],
    peru: [0, 2],
    siberia: [1, 2],
  };
  return scenario(own as never, { kind: 'reinforce', remaining: 5, mustTrade: false, placed: {}, midTurn: false }, {
    fill: (_t, i) => [1 + (i % 3), 1 + ((i * 7) % 3)],
    mutate: (s) => {
      s.territories.siberia = { owner: 1, armies: 2 };
      s.players[0].cards = [
        { id: 0, territory: 'ural', symbol: 'infantry' },
        { id: 1, territory: 'peru', symbol: 'cavalry' },
      ];
    },
  });
}

async function run(dev: DeviceName): Promise<void> {
  const ctx = await openDevice(dev);
  const { page, errors } = ctx;
  const tag = `[${dev}]`;
  const safe = DEVICES[dev].safe;
  const vp = DEVICES[dev].desc.viewport;
  let scrolled = 0;
  const still = async (what: string) => {
    const s = await pageStill(page);
    if (!s.ok) {
      scrolled++;
      console.log(`${tag} scrolled after ${what}: ${s.detail}`);
    }
  };
  const tiny: string[] = [];
  // Phones: every control in the whole UI (the dock, the top strip, the sheets; INK2 §3); the tablet: the dock.
  const scope = dev.startsWith('iphone') ? '.ui-root' : '.strip';
  const targets = async (where = '') => {
    for (const t of await smallTargets(page, scope)) if (!tiny.includes(t + where)) tiny.push(t + where);
  };

  await loadScenario(page, turnScenario());
  await page.waitForTimeout(1300);
  const placeLine = (await ui(page)).line;
  await page.evaluate(() => document.querySelector<HTMLElement>('[data-testid="rotate-pill-close"]')?.click());
  // Layout: inside the safe area.
  const geo = await page.evaluate(() => {
    const r = (q: string) => document.querySelector(q)!.getBoundingClientRect();
    // The dock's controls and line (the gold rule is a hairline that runs edge to edge by design).
    const parts = [...document.querySelectorAll('.strip .track, .strip .st-zone:not(.is-empty), .strip .st-say')].map((e) => e.getBoundingClientRect()).filter((b) => b.width > 0);
    const s = { left: Math.min(...parts.map((b) => b.left)), right: Math.max(...parts.map((b) => b.right)), top: Math.min(...parts.map((b) => b.top)), bottom: Math.max(...parts.map((b) => b.bottom)) };
    const t = r('.ts-seats');
    const m = r('[data-testid="menu"]');
    return { s: { l: s.left, r: s.right, t: s.top, b: s.bottom }, t: { l: t.left, t: t.top }, m: { r: m.right, t: m.top, w: m.width, h: m.height }, form: document.documentElement.className };
  });
  const tuck = 24; // the dock may tuck ≤ 22 px into a landscape side inset (clear of the rounded corner)
  check(
    geo.s.b <= vp.height - Math.max(0, safe.bottom - 8) + 0.5 && geo.s.l >= Math.max(0, safe.left - tuck) && geo.s.r <= vp.width - Math.max(0, safe.right - tuck) + 0.5,
    `${tag} dock inside the safe area (${Math.round(geo.s.l)}–${Math.round(geo.s.r)} × ${Math.round(geo.s.t)}–${Math.round(geo.s.b)}; ${geo.form})`,
    results,
  );
  check(geo.t.t >= safe.top && geo.m.t >= safe.top && geo.m.w >= 44 && geo.m.h >= 44, `${tag} pills below the top inset, ≡ is ${Math.round(geo.m.w)}×${Math.round(geo.m.h)}`, results);
  if (scope === '.ui-root') {
    // The sheets' controls too: the menu and Settings (then back to the board).
    await targets();
    await tapId(page, 'menu');
    await page.waitForTimeout(500);
    await targets(' (menu)');
    await tapId(page, 'pause-settings');
    await page.waitForTimeout(500);
    await targets(' (settings)');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    if (await page.locator('[data-testid="settings"]').isVisible().catch(() => false)) await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    if (await page.locator('.pause-sheet').isVisible().catch(() => false)) await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }

  // Place: Ural → − → Place 4; Ukraine → Place 1.
  await tapT(page, 'ural');
  await page.waitForFunction(() => !!window.__risk.ui().count, null, { timeout: 4000 });
  let u = await ui(page);
  check(u.line === 'Place on Ural' && u.count?.value === 5 && u.count.control === 'stepper', `${tag} tap Ural: "${u.line}", stepper ${u.count?.value}`, results);
  await targets();
  await tapId(page, 'count-dec');
  await page.waitForTimeout(80);
  check((await ui(page)).count?.value === 4, `${tag} − on the stepper → 4`, results);
  await tapId(page, 'btn-place');
  await idle(page);
  await still('place');
  let s = (await state(page))!;
  check(s.territories.ural.armies === 16, `${tag} Place 4 → Ural 16 (${s.territories.ural.armies})`, results);
  await tapT(page, 'ukraine');
  await page.waitForFunction(() => !!window.__risk.ui().count, null, { timeout: 4000 });
  await tapId(page, 'btn-place');
  await idle(page);
  u = await ui(page);
  check(u.recommended === 'attack' && !/click/i.test(u.line), `${tag} all placed: recommended ${u.recommended}, "${u.line}"`, results);
  // Touch copy: the place line says "tap", never "click".
  check(/· tap a territory$/.test(placeLine), `${tag} touch copy: "${placeLine}"`, results);

  // Attack: the track, then target-first Siberia, one Roll, then Blitz until it falls.
  await tapId(page, 'seg-attack');
  await idle(page);
  if ((await state(page))!.phase.kind !== 'attack') {
    await page.waitForTimeout(600);
    await tapId(page, 'seg-attack');
    await idle(page);
  }
  check((await state(page))!.phase.kind === 'attack', `${tag} Turn Track → Attack`, results);
  await tapT(page, 'siberia');
  await page.waitForTimeout(250);
  u = await ui(page);
  check(/^Ural → Siberia · \d+%( · .+)?$/.test(u.line) && u.buttons.join(' / ') === 'Roll / Blitz', `${tag} tap Siberia arms: "${u.line}" · ${u.buttons.join(' / ')}`, results);
  await targets();
  const before = (await state(page))!;
  await tapId(page, 'btn-roll');
  await idle(page);
  await still('roll');
  s = (await state(page))!;
  const rolled = s.territories.ural.armies + s.territories.siberia.armies < before.territories.ural.armies + before.territories.siberia.armies || s.territories.siberia.owner === 0;
  check(rolled, `${tag} Roll resolved (Ural ${s.territories.ural.armies}, Siberia ${s.territories.siberia.armies})`, results);
  for (let i = 0; i < 6; i++) {
    s = (await state(page))!;
    if (s.phase.kind !== 'attack' || s.territories.siberia.owner === 0 || s.territories.ural.armies < 2) break;
    if (!(await ui(page)).buttons.includes('Blitz')) await tapT(page, 'siberia');
    await tapId(page, 'btn-blitz');
    await idle(page);
  }
  s = (await state(page))!;
  check(s.phase.kind === 'occupy' || s.territories.siberia.owner === 0, `${tag} Blitz took Siberia (phase ${s.phase.kind})`, results);
  if (s.phase.kind === 'occupy') {
    u = await ui(page);
    const c = u.count!;
    check(c.control === 'slider' && u.primary === `Move ${c.value}`, `${tag} occupy: slider ${c.min}–${c.max} at ${c.value}, ${u.primary}`, results);
    await targets();
    // v5.1 E2: the count starts collapsed (all but one chosen): its number is a word; a tap opens the slider.
    const word = page.locator('[data-testid="count-expand"]');
    check(await word.isVisible(), `${tag} occupy count collapsed to its number (${(await word.textContent())?.trim()})`, results);
    await tapId(page, 'count-expand');
    await page.waitForTimeout(120);
    // A tap on the slider track sets the count (the left third).
    const track = page.locator('[data-testid="count-slider"] .cs-track');
    await track.waitFor({ state: 'visible', timeout: 3000 }).catch(async () => page.screenshot({ path: `artifacts/e2e/mobile-turn-${dev}-occupy.png` }));
    const box = (await track.boundingBox())!;
    await page.touchscreen.tap(box.x + box.width * 0.25, box.y + box.height / 2);
    await page.waitForTimeout(100);
    const v = (await ui(page)).count!.value;
    check(v < c.value && v >= c.min, `${tag} a tap on the slider moves it (${c.value} → ${v})`, results);
    await tapId(page, 'btn-move');
    await idle(page);
    await still('occupy');
    s = (await state(page))!;
    check(s.territories.siberia.owner === 0 && s.territories.siberia.armies === v, `${tag} Move ${v} into Siberia (${s.territories.siberia.armies})`, results);
  }

  // Fortify: the track, Ural → Siberia, then `Move N · end turn`.
  // A tap inside the post-conquest input guard is dropped (as a click is on desktop): tap again once.
  await tapId(page, 'seg-fortify');
  await idle(page);
  if ((await state(page))!.phase.kind !== 'fortify') {
    await page.waitForTimeout(600);
    await tapId(page, 'seg-fortify');
    await idle(page);
  }
  check((await state(page))!.phase.kind === 'fortify', `${tag} Turn Track → Fortify`, results);
  s = (await state(page))!;
  const src = s.territories.ural.armies >= 2 ? 'ural' : 'siberia';
  const dst = src === 'ural' ? 'siberia' : 'ural';
  await tapT(page, src);
  await page.waitForTimeout(150);
  await tapT(page, dst);
  await page.waitForFunction(() => /end turn/.test(window.__risk.ui().primary ?? ''), null, { timeout: 4000 }).catch(() => undefined);
  u = await ui(page);
  check(/^Move \d+ · end turn$/.test(u.primary ?? ''), `${tag} fortify route picked: "${u.line}" · ${u.primary}`, results);
  await targets();
  await tapId(page, 'btn-move');
  await page.waitForFunction(() => window.__risk.getState()!.currentPlayer !== 0, null, { timeout: 8000 }).catch(() => undefined);
  s = (await state(page))!;
  check(s.currentPlayer !== 0, `${tag} the turn passed to ${s.players[s.currentPlayer].name}`, results);
  await still('fortify');

  check(scrolled === 0, `${tag} the document never scrolled or zoomed`, results);
  check(tiny.length === 0, `${tag} every ${scope === '.ui-root' ? 'control (dock, top strip, sheets)' : 'dock control'} ≥ 44 px${tiny.length ? ` (small: ${tiny.join(', ')})` : ''}`, results);
  check(errors.length === 0, `${tag} 0 console errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`, results);
  allErrors.push(...errors.map((e) => `${tag} ${e}`));
  await ctx.browser.close();
}

for (const dev of (process.env.MOBILE_DEVICES ?? 'iphone,iphone-land,ipad').split(',') as DeviceName[]) await run(dev);
finish(results, allErrors);
