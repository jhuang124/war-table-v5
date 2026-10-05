// v5.1 "decide, don't ask" (_claude/v5/QUIETER.md §3), logic lane at instant speed, on the real board + HUD:
//   D  New game shows Seats / Length / More / Start and nothing else; More unfolds the map, setup, rules
//      and the per-AI difficulty + personality rows (personality 'Any' by default).
//   A  two humans: no hand-off element ever appears as the turn passes; the turn line names the next seat.
//   B  no cup element anywhere on the game screen.
//   E3 Settings: four primary controls and a More fold for the rest; no 'Hide cards between turns'.
//   E1 Place → Attack advances by itself after the last army.
//   E2 occupy: all but one by default (Move N), the count collapsed to its number until touched.
//   C  standing: a mark on every AI ring with its __risk.standing() value; a hover writes the reason in the
//      line; a tap offers "Ask X for peace", Ask is answered at once; an AI–AI understanding reaches the
//      Ledger ("X and Y have an understanding" / "X turned on Y") in an all-AI autoplay game.
import { check, clearStorage, clickBtn, finish, idle, loadScenario, open, place, scenario, seg, state, ui, ONE_HUMAN } from './lib';
import type { Page } from 'playwright';

const results: string[] = [];
const { browser, page, errors } = await open();
const shown = (id: string) => page.locator(`[data-testid="${id}"]`).first().isVisible().catch(() => false);

// --- D · New game: three decisions, the rest folded ------------------------------------------------------
await clearStorage(page);
await page.reload();
await page.waitForFunction(() => window.__risk?.ui().screen === 'title');
await clickBtn(page, 'title-new');
await page.waitForFunction(() => window.__risk.ui().screen === 'newGame');
await page.waitForTimeout(300);
const FOLDED = ['ng-more-body', 'setup-placeOwn', 'house-neutral', 'house-missions', 'house-seed', 'seat-diff-1', 'seat-pers-1'];
const top = async () =>
  page.evaluate(() => {
    const vis = (e: Element) => (e as HTMLElement).checkVisibility?.({ visibilityProperty: true, opacityProperty: true }) ?? true;
    const grid = document.querySelector('.ng-grid')!;
    return {
      labels: [...grid.querySelectorAll(':scope > .ng-label')].filter(vis).map((l) => l.textContent?.trim() ?? ''),
      more: (document.querySelector('[data-testid="ng-more"]')?.textContent ?? '').trim(),
    };
  });
const t0 = await top();
const before = await Promise.all(FOLDED.map(shown));
check(
  t0.labels.filter(Boolean).join(' / ') === 'Seats / Map / Length' && (await shown('ng-more')) && (await shown('ng-start')) && before.every((v) => !v),
  `New game shows Seats / Map / Length / ${t0.more} / Start and nothing folded (${t0.labels.filter(Boolean).join(', ')}; folded shown: ${FOLDED.filter((_, i) => before[i]).join(', ') || 'none'})`,
  results,
);
await clickBtn(page, 'ng-more');
await page.waitForTimeout(400);
const after = await Promise.all(FOLDED.map(shown));
check(after.every(Boolean), `More unfolds the rest (${FOLDED.filter((_, i) => !after[i]).join(', ') || 'all shown'})`, results);
const pers = await page.evaluate(() => [1, 2, 3].map((i) => document.querySelector(`[data-testid="seat-pers-${i}"] .seg-opt.on`)?.getAttribute('data-testid') ?? null));
check(pers.every((p, i) => p === `seat-pers-${i + 1}-any`), `every AI's personality defaults to Any (${pers.join(', ')})`, results);

// --- E3 · Settings: four primaries and a fold ------------------------------------------------------------
await page.locator('[data-testid="ng-back"]').click();
await page.waitForFunction(() => window.__risk.ui().screen === 'title');
await clickBtn(page, 'title-settings');
await page.locator('[data-testid="settings"]').waitFor({ state: 'visible', timeout: 3000 });
await page.waitForTimeout(300);
const prim = await page.evaluate(() => [...document.querySelectorAll('[data-testid="settings-primary"] > .field')].map((f) => f.querySelector('.field-label > span')?.textContent?.trim()));
const foldShut = !(await shown('settings-more-body'));
check(prim.length === 4 && (await shown('settings-more')) && foldShut, `Settings: four primaries (${prim.join(', ')}) and More, folded (${foldShut})`, results);
await clickBtn(page, 'settings-more');
await page.waitForTimeout(300);
const hide = await page.locator('.switch', { hasText: 'Hide cards between turns' }).count();
check((await shown('settings-more-body')) && hide === 0, `More unfolds the rest; no "Hide cards between turns" (${hide})`, results);
await clickBtn(page, 'settings-done');

// --- A + B · two humans: the turn passes with the line, no cover, no cup ---------------------------------
const TWO = [
  { name: 'John', color: 'crimson', kind: 'human' },
  { name: 'Sam', color: 'cobalt', kind: 'human' },
  { name: 'Amber', color: 'amber', kind: 'ai', difficulty: 'normal' },
] as never;
await loadScenario(page, scenario({ ural: [0, 6], ukraine: [0, 2] }, { kind: 'reinforce', remaining: 3, mustTrade: false, placed: {}, midTurn: false }, {
  players: TWO,
  fill: (_t, i) => [1 + (i % 2), 2],
  mutate: (s) => void (s.players[1].cards = [{ id: 5, territory: 'peru', symbol: 'infantry' }]),
}));
const cups = await page.evaluate(() => document.querySelectorAll('[data-testid="cup"], .cup, .cup-body, .ts-cup').length);
check(cups === 0, `no cup on the game screen (${cups})`, results);
await page.evaluate(() => {
  const w = window as unknown as { __cover: number };
  w.__cover = 0;
  const probe = () => {
    if (document.querySelector('[data-testid="handoff"], [data-testid="handoff-accept"], [data-testid="handoff-mission"]')) w.__cover++;
  };
  new MutationObserver(probe).observe(document.getElementById('ui')!, { subtree: true, childList: true, attributes: true });
  const raf = () => (probe(), requestAnimationFrame(raf));
  requestAnimationFrame(raf);
});
// E1: the last army placed, the marker moves to Attack by itself
await place(page, 'ural');
const placed = Date.now();
await page.waitForFunction(() => window.__risk.ui().step === 'Attack', null, { timeout: 3000, polling: 20 }).catch(() => undefined);
const ua = await ui(page);
check(ua.step === 'Attack' && (await state(page))!.phase.kind === 'attack', `Place → Attack by itself, ${Date.now() - placed} ms after the last army, no click (${ua.track.join(', ')})`, results);
await idle(page);
await seg(page, 'endTurn');
await page.waitForFunction(() => window.__risk.getState()!.currentPlayer === 1, null, { timeout: 5000 });
await page.waitForFunction(() => /^Sam's turn/.test(window.__risk.ui().bannerLine ?? ''), null, { timeout: 3000 }).catch(() => undefined);
const passed = await ui(page);
await page.waitForTimeout(500);
const cover = await page.evaluate(() => (window as unknown as { __cover: number }).__cover);
check(cover === 0 && (await page.locator('[data-testid="handoff"]').count()) === 0, `no hand-off element in any frame as the turn passed (${cover})`, results);
check(/^Sam's turn · \d+ arm(y|ies)$/.test(passed.bannerLine ?? ''), `the turn line names Sam: "${passed.bannerLine}"`, results);
await idle(page);

// --- E2 · occupy: all but one, collapsed until touched ---------------------------------------------------
await loadScenario(page, scenario({ greenland: [0, 10], ontario: [0, 0] }, { kind: 'occupy', from: 'greenland', to: 'ontario', min: 3, max: 9, previousOwner: 1 }));
let u = await ui(page);
const word = page.locator('[data-testid="count-expand"]');
const folded = {
  word: await word.isVisible(),
  text: (await word.textContent())?.trim(),
  stepper: await shown('count-inc'),
  slider: await page.locator('[data-testid="count-slider"]').isVisible(),
};
check(u.primary === 'Move 9' && u.count?.value === 9 && folded.word && folded.text === '9' && !folded.stepper && !folded.slider, `occupy: ${u.primary} by default, the count collapsed to "${folded.text}" (${JSON.stringify(folded)})`, results);
await word.click();
await page.waitForTimeout(250);
const opened = { word: await word.isVisible(), slider: await page.locator('[data-testid="count-slider"]').isVisible(), stepper: await shown('count-inc') };
check(!opened.word && (opened.slider || opened.stepper), `a touch on the number opens the control (${JSON.stringify(opened)})`, results);

// --- C · standing --------------------------------------------------------------------------------------
await loadScenario(
  page,
  scenario({ ural: [0, 12], ukraine: [0, 12], afghanistan: [0, 10], siberia: [1, 1], china: [1, 1], india: [1, 1] }, { kind: 'reinforce', remaining: 3, mustTrade: false, placed: {}, midTurn: false }, {
    players: ONE_HUMAN as never,
    fill: (_t, i) => [1 + (i % 3), 1],
    mutate: (s) => void (s.config = { ...s.config, diplomacy: true }),
  }),
);
await page.waitForTimeout(400);
type Row = { seat: number; name: string; kind: string; standing: string | null; reason: string | null; canAskPeace: boolean };
const standing = (p: Page) => p.evaluate(() => (window.__risk as unknown as { standing(): Row[] }).standing()) as Promise<Row[]>;
const rows = (await standing(page)).filter((r) => r.kind === 'ai');
const marks = await page.evaluate((ids) => ids.map((i) => [...(document.querySelector(`[data-testid="seat-standing-${i}"]:not(.hidden)`)?.classList ?? [])].find((c) => c.startsWith('st-')) ?? null), rows.map((r) => r.seat));
check(
  rows.length === 3 && rows.every((r, i) => ['ally', 'even', 'wary', 'hostile'].includes(r.standing ?? '') && marks[i] === `st-${r.standing}`),
  `a standing mark on every AI ring, as __risk.standing() says (${rows.map((r, i) => `${r.name} ${r.standing}/${marks[i]}`).join(' · ')})`,
  results,
);
const who = rows.find((r) => r.canAskPeace) ?? rows[0];
const box = (await page.locator(`[data-testid="seat-${who.seat}"]`).boundingBox())!;
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForFunction((r) => window.__risk.ui().line === r, who.reason, { timeout: 2000 }).catch(() => undefined);
u = await ui(page);
check(!!who.reason && u.line === who.reason, `hover on ${who.name}: "${u.line}"`, results);
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.move(720, 520);
const ask = `Ask ${who.name} for peace`;
const offered = await page.waitForFunction((t) => (document.querySelector('[data-testid="line"]')?.textContent ?? '').includes(t), ask, { timeout: 2000 }).then(() => true, () => false);
check(who.canAskPeace && offered && (await shown('btn-askPeace')), `a tap on ${who.name}'s ring offers "${ask}" with a bare Ask word`, results);
await clickBtn(page, 'btn-askPeace');
await page.waitForFunction((n) => new RegExp(`^${n} (agrees|refuses)`).test(window.__risk.ui().line), who.name, { timeout: 3000 }).catch(() => undefined);
u = await ui(page);
check(new RegExp(`^${who.name} (agrees · three rounds|refuses( · .+)?)$`).test(u.line), `Ask is answered at once: "${u.line}"`, results);

// --- C · an AI–AI understanding reaches the Ledger (all-AI autoplay at instant speed) ----------------------
await clearStorage(page);
await page.reload();
await page.waitForFunction(() => !!window.__risk);
await page.evaluate(() => {
  window.__risk.newGame({
    players: [
      // understandings form between two AIs that are allies both ways: Turtles forgive, so seat them
      { name: 'Cobalt', color: 'cobalt', kind: 'ai', difficulty: 'normal', personality: 'turtle' },
      { name: 'Amber', color: 'amber', kind: 'ai', difficulty: 'normal', personality: 'turtle' },
      { name: 'Emerald', color: 'emerald', kind: 'ai', difficulty: 'normal', personality: 'opportunist' },
      { name: 'Violet', color: 'violet', kind: 'ai', difficulty: 'normal', personality: 'warlord' },
    ] as never,
    seed: 51,
    diplomacy: true,
  } as never);
  window.__risk.autoplay(true);
});
const UNDERSTANDING = /^(\S+ and \S+ have an understanding|\S+ turned on \S+)( · .+)?$/;
const found = await page
  .waitForFunction((re) => window.__risk.ledger().some((l) => new RegExp(re).test(l.text)) || window.__risk.ui().screen === 'victory', UNDERSTANDING.source, { timeout: 90_000, polling: 250 })
  .then(() => true, () => false);
const led = await page.evaluate(() => window.__risk.ledger());
const lines = led.filter((l) => UNDERSTANDING.test(l.text));
const sx = await state(page);
// while an understanding holds, a hairline ties the two rings
const held = (await standing(page)).find((r) => (r as Row & { understandingWith: number[] }).understandingWith?.length) as (Row & { understandingWith: number[] }) | undefined;
const tie = held ? await page.locator(`[data-testid="tie-${Math.min(held.seat, held.understandingWith[0])}-${Math.max(held.seat, held.understandingWith[0])}"]`).count() : -1;
await page.evaluate(() => window.__risk.autoplay(false));
check(found && lines.length > 0, `an AI–AI understanding reached the Ledger: ${lines.length ? `"${lines[0].text}" (round ${lines[0].round})` : `none by round ${sx?.round} (${led.filter((l) => l.kind === 'truce').map((l) => l.text).slice(0, 3).join(' | ') || 'no truce lines'})`}`, results);
if (held) check(tie === 1, `while ${held.name}'s understanding holds, a tie joins the rings (tie-${Math.min(held.seat, held.understandingWith[0])}-${Math.max(held.seat, held.understandingWith[0])}: ${tie})`, results);
else console.log('   (no understanding held at the moment the Ledger was read: the tie is not checked)');

await browser.close();
finish(results, errors);
