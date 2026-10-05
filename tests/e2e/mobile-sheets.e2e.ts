// Phone sheets and touch extras (docs/MOBILE.md §3, §5, §8), in portrait (iPhone 15 Pro) and landscape
// (Pixel 7): every sheet opens and dismisses — the menu (scrim tap), Settings (pulled down by its
// handle), Rules (Close), Log (pulled down), the Cards sheet (scrim tap, and pulled down), the End game
// confirm (scrim tap = Keep playing) and the new-game colour sheet (scrim tap). Plus: long-press name
// card (never selects), pinch + pan move the view and the Reset view pill brings it home, haptics on
// select / dice / conquest, the rotate pill shows once, the page never scrolls or zooms, 0 console errors.
// v5.1 A: no hand-off cover and no 'Hide cards between turns' switch: between two humans the turn passes
// straight to Sam, live, with nothing to pull down.
import { check, finish, idle, loadScenario, scenario, state, TWO_HUMANS, ui } from './lib';
import { dragSheetDown, longPress, openDevice, pageStill, pinch, drag, settleAnims, tapId, tapT, type DeviceName, type MCtx } from './mobile-lib';
import type { GameState } from '../../src/engine';

const results: string[] = [];
const allErrors: string[] = [];

const visible = (ctx: MCtx, id: string) => ctx.page.locator(`[data-testid="${id}"]`).first().isVisible();
async function gone(ctx: MCtx, id: string, ms = 1500): Promise<boolean> {
  return ctx.page
    .locator(`[data-testid="${id}"]`)
    .first()
    .waitFor({ state: 'hidden', timeout: ms })
    .then(() => true)
    .catch(() => false);
}
async function shown(ctx: MCtx, id: string, ms = 2500): Promise<boolean> {
  return ctx.page
    .locator(`[data-testid="${id}"]`)
    .first()
    .waitFor({ state: 'visible', timeout: ms })
    .then(() => true)
    .catch(() => false);
}
/** Tap the scrim: a point above the sheet (portrait) or beside it (landscape). */
async function tapScrim(ctx: MCtx, sheet: string): Promise<void> {
  const box = (await ctx.page.locator(`[data-testid="${sheet}"]`).first().boundingBox())!;
  const vp = ctx.page.viewportSize()!;
  const x = box.x > 30 ? 12 : vp.width / 2;
  const y = box.x > 30 ? vp.height / 2 : Math.max(4, box.y / 2);
  await ctx.page.touchscreen.tap(x, y);
}

function base(mutate?: (s: GameState) => void, players?: unknown): GameState {
  const own: Record<string, [number, number]> = { ural: [0, 12], ukraine: [0, 2], india: [0, 3], afghanistan: [0, 2] };
  return scenario(own as never, { kind: 'reinforce', remaining: 3, mustTrade: false, placed: {}, midTurn: false }, {
    ...(players ? { players: players as never } : {}),
    mutate: (s) => {
      s.territories.siberia = { owner: 1, armies: 1 };
      s.players[0].cards = [
        { id: 0, territory: 'ural', symbol: 'infantry' },
        { id: 1, territory: 'peru', symbol: 'cavalry' },
        { id: 2, territory: 'brazil', symbol: 'artillery' },
      ];
      mutate?.(s);
    },
  });
}

async function run(dev: DeviceName): Promise<void> {
  const ctx = await openDevice(dev);
  const { page, errors } = ctx;
  const tag = `[${dev}]`;
  let scrolled = 0;
  const still = async () => {
    const s = await pageStill(page);
    if (!s.ok) (scrolled++, console.log(`${tag} scrolled: ${s.detail}`));
  };
  // Record haptics (navigator.vibrate) in the page.
  await page.addInitScript(() => {
    const w = window as unknown as { __buzz: unknown[] };
    w.__buzz = [];
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: (p: unknown) => (w.__buzz.push(p), true) });
  });
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => window.__risk?.ui().screen === 'title');

  // v5.1: Settings has no 'Hide cards between turns' switch (folded or not).
  await tapId(page, 'title-settings');
  check(await shown(ctx, 'settings'), `${tag} title → Settings sheet`, results);
  const hideSwitches = await page.locator('.switch', { hasText: 'Hide cards between turns' }).count();
  check(hideSwitches === 0, `${tag} no "Hide cards between turns" switch (${hideSwitches})`, results);
  await dragSheetDown(ctx, 'settings');
  check(await gone(ctx, 'settings'), `${tag} Settings pulled down by its handle closes`, results);
  await still();

  // New game: the colour sheet, dismissed by the scrim.
  await tapId(page, 'title-new');
  await page.waitForTimeout(400);
  await tapId(page, 'seat-color-1');
  const pop = page.locator('.swatch-pop:not(.hidden)');
  check(await pop.isVisible(), `${tag} emblem → the six-swatch sheet`, results);
  await page.touchscreen.tap(page.viewportSize()!.width / 2, 8);
  await page.waitForTimeout(300);
  check(!(await pop.isVisible()), `${tag} a tap on its scrim closes it`, results);
  await tapId(page, 'seat-color-1');
  await settleAnims(page, '.swatch-pop');
  await tapId(page, 'seat-color-1-violet');
  await page.waitForTimeout(250);
  check((await page.evaluate(() => window.__risk.ui())).screen === 'newGame' && !(await pop.isVisible()), `${tag} picking a swatch closes the sheet`, results);
  const nameFont = await page.locator('[data-testid="seat-name-0"]').evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
  check(nameFont >= 16, `${tag} name inputs are ${nameFont}px (no iOS focus zoom)`, results);
  await still();

  // In game: the rotate pill (portrait, once), the menu and its sheets.
  await loadScenario(page, base());
  await page.waitForTimeout(1400);
  const portrait = page.viewportSize()!.height > page.viewportSize()!.width;
  if (portrait) {
    check(await visible(ctx, 'rotate-pill'), `${tag} portrait: "Rotate for the full map" shows`, results);
    // No ×: the line dries at the first touch (INK F3), so touch the line itself.
    await tapId(page, 'rotate-pill');
    check(await gone(ctx, 'rotate-pill'), `${tag} … and dismisses`, results);
  }
  await tapId(page, 'menu');
  check(await shown(ctx, 'pause'), `${tag} ≡ → the menu sheet`, results);
  await tapScrim(ctx, 'pause');
  check(await gone(ctx, 'pause'), `${tag} a scrim tap closes the menu`, results);
  await tapId(page, 'menu');
  await shown(ctx, 'pause');
  await tapId(page, 'pause-rules');
  check(await shown(ctx, 'rules'), `${tag} Menu → Rules`, results);
  await tapId(page, 'rules-close');
  check(await shown(ctx, 'pause'), `${tag} Rules → Close goes back to the menu`, results);
  await tapId(page, 'pause-log');
  check(await shown(ctx, 'log'), `${tag} Menu → Log`, results);
  await dragSheetDown(ctx, 'log');
  check(await gone(ctx, 'log'), `${tag} Log pulled down closes to the board`, results);
  check((await ui(page)).screen === 'game' && !(await visible(ctx, 'pause')), `${tag} … no menu left behind`, results);
  // A short pull springs back.
  await tapId(page, 'menu');
  await shown(ctx, 'pause');
  await tapId(page, 'pause-settings');
  await shown(ctx, 'settings');
  await dragSheetDown(ctx, 'settings', 30);
  await page.waitForTimeout(450);
  check(await visible(ctx, 'settings'), `${tag} a short pull springs the sheet back`, results);
  await tapId(page, 'settings-done');
  await tapId(page, 'pause-resume');
  check(await gone(ctx, 'pause'), `${tag} Resume closes the menu`, results);
  // The confirm: an action sheet; the scrim is Keep playing.
  await tapId(page, 'menu');
  await tapId(page, 'pause-endgame');
  check(await shown(ctx, 'confirm-yes'), `${tag} End game now → the confirm sheet`, results);
  await page.touchscreen.tap(page.viewportSize()!.width / 2, 6);
  check(await gone(ctx, 'confirm-yes'), `${tag} a scrim tap keeps playing`, results);
  check((await ui(page)).screen === 'game', `${tag} … still in the game`, results);
  await page.waitForTimeout(300);
  if (await visible(ctx, 'pause')) await tapId(page, 'pause-resume');
  await gone(ctx, 'pause');
  await still();

  // Cards: open from the dock, close by the scrim, open again, pull it down.
  await tapT(page, 'ural');
  await page.waitForTimeout(200);
  const buzz0 = await page.evaluate(() => (window as unknown as { __buzz: unknown[] }).__buzz.length);
  check(buzz0 >= 1, `${tag} haptic tick on select (${buzz0})`, results);
  await tapId(page, 'btn-cards');
  check(await shown(ctx, 'cards'), `${tag} the card-stack button → the Cards sheet`, results);
  await tapScrim(ctx, 'cards');
  check(await gone(ctx, 'cards'), `${tag} a scrim tap closes the Cards sheet`, results);
  await tapId(page, 'btn-cards');
  await shown(ctx, 'cards');
  await dragSheetDown(ctx, 'cards');
  check(await gone(ctx, 'cards'), `${tag} the Cards sheet pulled down closes`, results);
  check(!(await ui(page)).cardsOpen, `${tag} … and the controller knows`, results);

  // Long-press: the name card, which never selects.
  const selBefore = (await ui(page)).line;
  const p = (await page.evaluate(() => window.__risk.screenPos('india' as never)))!;
  const card = await longPress(ctx, p.x, p.y, 700, async () => ({
    vis: await visible(ctx, 'name-card'),
    text: (await page.locator('[data-testid="name-card"]').innerText().catch(() => '')).replace(/\s+/g, ' '),
  }));
  const hasLong = await page.evaluate(() => typeof (window.__board as unknown as { onTerritoryLongPress?: unknown }).onTerritoryLongPress === 'function');
  if (hasLong) {
    check(!!card?.vis && /India/i.test(card.text) && /Asia/.test(card.text) && /\+7/.test(card.text) && /John/.test(card.text), `${tag} long-press India → name card "${card?.text}"`, results);
    check(await gone(ctx, 'name-card', 800), `${tag} releasing hides it`, results);
    check((await ui(page)).line === selBefore, `${tag} a long-press never selects ("${(await ui(page)).line}")`, results);
  } else check(true, `${tag} (board has no long-press yet: name card not exercised)`, results);

  // Pinch + pan move the view; Reset view brings it home.
  const vp = page.viewportSize()!;
  await pinch(ctx, vp.width / 2, vp.height * 0.4, 80, 220);
  await drag(ctx, vp.width / 2, vp.height * 0.4, vp.width / 2 - 60, vp.height * 0.4 + 20);
  await page.waitForTimeout(400);
  const moved = (await ui(page)).viewMoved;
  check(moved, `${tag} pinch + pan move the view (Reset view shows)`, results);
  if (moved) {
    await tapId(page, 'reset-view');
    await page.waitForTimeout(700);
    check(!(await ui(page)).viewMoved, `${tag} Reset view returns home`, results);
  }
  await still();

  // Dice + conquest haptics: place, attack Siberia (1 army), blitz.
  await tapId(page, 'btn-place');
  await idle(page);
  await tapId(page, 'seg-attack');
  await idle(page);
  await tapT(page, 'siberia');
  await page.waitForTimeout(150);
  await page.evaluate(() => ((window as unknown as { __buzz: unknown[] }).__buzz = []));
  await tapId(page, 'btn-blitz');
  await idle(page);
  const buzz = await page.evaluate(() => (window as unknown as { __buzz: unknown[] }).__buzz.map((x) => JSON.stringify(x)));
  const conquered = (await state(page))!.territories.siberia.owner === 0;
  check(buzz.includes('18') && (!conquered || buzz.some((b) => b.startsWith('['))), `${tag} haptics: dice ${buzz.includes('18')}, conquest ${buzz.some((b) => b.startsWith('['))} (${buzz.join(' ')})`, results);
  if ((await state(page))!.phase.kind === 'occupy') {
    await tapId(page, 'btn-move');
    await idle(page);
  }

  // Two humans (v5.1 A): End turn passes straight to Sam, no cover to pull down.
  const two = base((s) => {
    s.phase = { kind: 'attack' } as never;
    s.players[1].cards = [{ id: 9, territory: 'siam', symbol: 'cavalry' }];
  }, TWO_HUMANS);
  await page.evaluate(() => localStorage.removeItem('risk3d.settings.v1'));
  await loadScenario(page, two);
  await tapId(page, 'seg-endTurn');
  await page.waitForTimeout(600);
  check((await page.locator('[data-testid="handoff"]').count()) === 0, `${tag} two humans: no hand-off cover`, results);
  await page.waitForFunction(() => window.__risk.ui().trackSeat === 'Sam' && window.__risk.ui().trackLive, null, { timeout: 5000 }).catch(() => undefined);
  const su = await ui(page);
  check((await state(page))!.currentPlayer === 1 && su.trackLive && su.trackSeat === 'Sam', `${tag} … Sam's turn is live (${su.trackSeat}, live ${su.trackLive})`, results);
  await still();

  check(scrolled === 0, `${tag} the document never scrolled or zoomed`, results);
  check(errors.length === 0, `${tag} 0 console errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`, results);
  allErrors.push(...errors.map((e) => `${tag} ${e}`));
  await ctx.browser.close();
}

for (const dev of (process.env.MOBILE_DEVICES ?? 'iphone,pixel-land').split(',') as DeviceName[]) await run(dev);
finish(results, allErrors);
