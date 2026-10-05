// Multi-human paths through real clicks: manual setup ("Place your own" under New game's More: pick,
// Place, Undo, Place the rest, Done on the Turn Track), the turn passing between two humans (v5.1 A: no
// cover; the turn line names the next seat), forced + mid-turn card trades (one button, the best set; the
// track locked meanwhile), and all humans out → the strip offers "Watch to the end" → victory → rematch.
import { check, clearStorage, clickBtn, clickT, finish, idle, loadScenario, open, place, rendered, scenario, seg, state, ui } from './lib';
import type { Card, GameState, TerritoryId } from '../../src/engine';

const results: string[] = [];
const { browser, page, errors } = await open();

// --- Manual setup, 2 humans + 1 AI, from the New game screen -------------------------------------
await clearStorage(page);
await page.reload();
await page.waitForFunction(() => !!window.__risk);
await clickBtn(page, 'title-new');
await page.locator('[data-testid="seat-name-0"]').fill('John');
await page.locator('[data-testid="seat-name-0"]').press('Tab');
await clickBtn(page, 'seat-kind-1-human');
await page.waitForTimeout(50);
await page.locator('[data-testid="seat-name-1"]').fill('Sam');
await page.locator('[data-testid="seat-name-1"]').press('Tab');
await clickBtn(page, 'seat-remove-3');
// v5.1 D: setup is folded under More
check(!(await page.locator('[data-testid="setup-placeOwn"]').isVisible()), 'setup choices are folded away before More', results);
await clickBtn(page, 'ng-more');
await clickBtn(page, 'setup-placeOwn');
await page.waitForFunction(() => document.querySelector('[data-testid="ng-summary"]')?.textContent?.includes('your own'));
const summary = await page.locator('[data-testid="ng-summary"]').textContent();
check(summary === 'Territories dealt at random · you place your own armies · first to 30 territories wins', `summary: ${summary}`, results);
const t0 = Date.now();
await clickBtn(page, 'ng-start');
let humanSetupTurns = 0;
let sawCover = false;
for (let guard = 0; guard < 40; guard++) {
  await page.waitForFunction(
    () => {
      const s = window.__risk.getState();
      return !!s && window.__risk.isIdle() && (s.phase.kind !== 'setup-place' || s.players[s.currentPlayer].kind === 'human');
    },
    null,
    { timeout: 60_000 },
  );
  const s = await state(page);
  if (await page.locator('[data-testid="handoff"]').count()) sawCover = true;
  await rendered(page);
  if (!s || s.phase.kind !== 'setup-place') break;
  const toPlace = s.phase.toPlace;
  const u0 = await ui(page);
  if (humanSetupTurns === 0) check(u0.line === `Place ${toPlace} armies · click a territory` && u0.step === 'Setup', `setup: [${u0.step}] ${u0.line}`, results);
  const own = (Object.keys(s.territories) as TerritoryId[]).filter((t) => s.territories[t].owner === s.currentPlayer);
  await place(page, own[0], 1);
  await place(page, own[1], 2);
  await clickBtn(page, 'btn-undo'); // takes the 2 back
  await place(page, own[1]); // everything left on own[1]
  await page.waitForTimeout(100);
  const u1 = await ui(page);
  if (humanSetupTurns === 0) {
    check(u1.line === `All ${toPlace} placed · click Done` && u1.primary === null && u1.brass.join() === 'Done', `staged: ${u1.line} · brass ${u1.brass.join(' / ')}`, results);
    const before = await state(page);
    check(before!.territories[own[0]].armies === s.territories[own[0]].armies, 'staging does not touch the engine until Done', results);
  }
  await seg(page, 'done');
  humanSetupTurns++;
}
const sMain = await state(page);
check(sMain!.phase.kind === 'reinforce' && sMain!.round === 1, `setup finished → round 1 reinforce (${humanSetupTurns} human setup turns)`, results);
check(!sawCover, 'no hand-off cover during setup or as the first main turn passes (v5.1 A)', results);
console.log(`   manual setup took ${Math.round((Date.now() - t0) / 1000)} s of wall time with scripted clicks`);

// --- The turn passes between two humans (v5.1 A): no cover, the turn line names Sam ------------------
const TWO_PLUS_AI = [
  { name: 'John', color: 'crimson', kind: 'human' },
  { name: 'Sam', color: 'cobalt', kind: 'human' },
  { name: 'Amber', color: 'amber', kind: 'ai', difficulty: 'normal' },
] as never;
const cards = (ids: number[]): Card[] => ids.map((id) => ({ id, territory: null, symbol: (['infantry', 'cavalry', 'artillery'] as const)[id % 3] }));
const hs = scenario({ ural: [0, 5], ukraine: [0, 2] }, { kind: 'attack' }, {
  players: TWO_PLUS_AI,
  fill: (_t, i) => [1 + (i % 2), 2],
  mutate: (s: GameState) => {
    s.players[1].cards = cards([3, 4]);
  },
});
await loadScenario(page, hs);
const set0 = await page.evaluate(() => JSON.parse(localStorage.getItem('risk3d.settings.v1') ?? '{}'));
check(!set0.hideCardsBetweenTurns, `no 'Hide cards between turns' setting in force (${set0.hideCardsBetweenTurns})`, results);
await page.evaluate(() => {
  const w = window as unknown as { __cover: number };
  w.__cover = 0;
  new MutationObserver(() => {
    if (document.querySelector('[data-testid="handoff"], [data-testid="handoff-accept"]')) w.__cover++;
  }).observe(document.getElementById('ui')!, { subtree: true, childList: true, attributes: true });
});
await seg(page, 'endTurn'); // straight from Attack: skips fortify
await page.waitForFunction(() => window.__risk.getState()!.currentPlayer === 1, null, { timeout: 5000 });
await page.waitForFunction(() => /^Sam's turn · \d+ armies$/.test(window.__risk.ui().bannerLine ?? ''), null, { timeout: 3000 }).catch(() => undefined);
const passed = await ui(page);
check(passed.bannerLine !== null && /^Sam's turn · \d+ armies$/.test(passed.bannerLine), `the turn line names Sam: "${passed.bannerLine}" (${passed.banners.join(' | ')})`, results);
check((await page.evaluate(() => (window as unknown as { __cover: number }).__cover)) === 0 && (await page.locator('[data-testid="handoff"]').count()) === 0, 'no hand-off cover appeared as the turn passed', results);
await idle(page);
const afterPass = await state(page);
check(afterPass!.currentPlayer === 1 && afterPass!.phase.kind === 'reinforce', `Sam's reinforce, nothing to accept (${afterPass!.phase.kind})`, results);

// --- Forced trade at 5 cards -------------------------------------------------------------------------
const hand5: Card[] = [
  { id: 0, territory: 'ural', symbol: 'infantry' },
  { id: 1, territory: 'alberta', symbol: 'infantry' },
  { id: 2, territory: 'peru', symbol: 'infantry' },
  { id: 3, territory: 'brazil', symbol: 'cavalry' },
  { id: 4, territory: 'china', symbol: 'cavalry' },
];
await loadScenario(page, scenario({ ural: [0, 3], ukraine: [0, 1] }, { kind: 'reinforce', remaining: 3, mustTrade: true, placed: {}, midTurn: false }, { mutate: (s) => void (s.players[0].cards = hand5) }));
let u = await ui(page);
let s0 = await state(page);
check(u.line === 'Trade cards first · you hold 5', `forced trade: ${u.line}`, results);
check(u.primary === 'Trade cards +4' && u.buttons.length === 1, `the only button: ${u.buttons.join(' / ')}`, results);
check(u.trackDisabled && u.recommended === null && u.brass.join() === 'Trade cards +4', `the track is locked during the forced trade (disabled ${u.trackDisabled}, brass ${u.brass.join(' / ')})`, results);
await seg(page, 'attack', true); // the track is disabled: the click changes no phase, only explains
await page.waitForTimeout(100);
s0 = await state(page);
u = await ui(page);
check(s0!.phase.kind === 'reinforce' && s0!.players[0].cards.length === 5 && u.line === 'Trade cards first', `a click on the locked track changes nothing, it says why (${s0!.phase.kind} · ${u.line})`, results);
await clickBtn(page, 'btn-trade');
await idle(page);
let s = await state(page);
u = await ui(page);
check(s!.players[0].cards.length === 2 && (s!.phase as { remaining: number }).remaining === 7, `traded: 2 cards left, 7 to place`, results);
check(s!.territories.ural.armies === 5, '+2 landed on Ural (a traded card shows it)', results);
const log = await page.evaluate(() => ((JSON.parse(localStorage.getItem('risk3d.ui.v1') ?? '{}').game?.log ?? []) as { text: string }[]).map((l) => l.text));
check(log.some((t) => t.startsWith('+2 on Ural')), 'the +2 is in the log (no toast)', results);
check(u.line === 'Place 7 armies · click a territory' && u.buttons.join(' / ') === 'Cards 2', `after the trade: ${u.line} · ${u.buttons.join(' / ')}`, results);

// --- Mid-turn trade after a knockout ------------------------------------------------------------------
await loadScenario(
  page,
  scenario({ ural: [0, 12], ukraine: [0, 1] }, { kind: 'attack' }, {
    players: TWO_PLUS_AI,
    fill: (_t, i) => [i % 2 === 0 ? 0 : 2, 1 + (i % 2)],
    mutate: (s) => {
      s.territories.siberia = { owner: 1, armies: 1 };
      s.players[0].cards = cards([0, 1]);
      s.players[1].cards = cards([5, 6, 7, 8]);
    },
  }),
);
await clickT(page, 'siberia');
await clickBtn(page, 'btn-blitz');
await idle(page);
s = await state(page);
if (s!.phase.kind === 'occupy') {
  await clickBtn(page, 'btn-move');
  await idle(page);
  s = await state(page);
}
u = await ui(page);
check(s!.phase.kind === 'reinforce' && (s!.phase as { midTurn: boolean }).midTurn, 'mid-turn reinforce after the knockout', results);
check(u.line === 'Trade cards first · you hold 6' && u.step === 'Place', `[${u.step}] ${u.line}`, results);
await clickBtn(page, 'btn-trade');
await idle(page);
s = await state(page);
u = await ui(page);
check(s!.players[0].cards.length === 3 && (s!.phase as { remaining: number }).remaining > 0, `after the trade: ${u.line}`, results);
const own = (Object.keys(s!.territories) as TerritoryId[]).find((t) => s!.territories[t].owner === 0)!;
await place(page, own);
u = await ui(page);
const exitLine = u.line;
// v5.1 E1: the last army placed, Place → Attack advances by itself (~250 ms); no click on the track.
await page.waitForFunction(() => window.__risk.ui().step === 'Attack', null, { timeout: 3000 }).catch(() => undefined);
await idle(page);
s = await state(page);
u = await ui(page);
check(s!.phase.kind === 'attack' && u.step === 'Attack', `all placed ("${exitLine}") → back to Attack by itself (${s!.phase.kind}, step ${u.step})`, results);
const gotBanner = await page.evaluate(() => window.__risk.getState()!.players[1].eliminated);
check(gotBanner, 'Sam is out', results);

// --- All humans out ----------------------------------------------------------------------------------
await loadScenario(
  page,
  scenario({ siberia: [0, 1] }, { kind: 'attack' }, {
    fill: (_t, i) => [1 + (i % 3), 3],
    mutate: (s) => {
      s.currentPlayer = 1;
      s.territories.ural = { owner: 1, armies: 30 };
      s.territories.yakutsk = { owner: 1, armies: 30 };
    },
  }),
  { waitIdle: false },
);
await page.waitForFunction(() => window.__risk.ui().line === 'All humans are out', null, { timeout: 60_000 });
const ho = await ui(page);
check(ho.buttons.join(' / ') === 'End game / Watch to the end', `all humans out: ${ho.buttons.join(' / ')}`, results);
check(!ho.trackLive && ho.trackSeat !== 'John', `all humans out: the track follows the AI (${ho.trackSeat}, live ${ho.trackLive})`, results);
await clickBtn(page, 'btn-watchAis');
{
  // Poll with a progress trail, so a stall shows where it happened.
  const t0 = Date.now();
  let last = '';
  let same = 0;
  let done = false;
  while (Date.now() - t0 < 180_000) {
    const r = await page.evaluate(() => {
      const s = window.__risk.getState();
      const u = window.__risk.ui();
      return { screen: u.screen, key: `${s?.round}/${s?.turn}/${s?.currentPlayer}/${s?.phase.kind}`, line: u.line, idle: window.__risk.isIdle() };
    });
    if (r.screen === 'victory') {
      done = true;
      break;
    }
    same = r.key === last ? same + 1 : 0;
    last = r.key;
    if (same === 20) console.log(`   stalled 10 s at ${r.key} · "${r.line}" · idle ${r.idle}`);
    await page.waitForTimeout(500);
  }
  check(done, `Watch the AIs finish → victory (${Math.round((Date.now() - t0) / 1000)} s)`, results);
  if (!done) finish(results, errors);
}
await page.waitForTimeout(1700);
await clickBtn(page, 'rematch');
await page.waitForFunction(() => window.__risk.ui().screen === 'game');
const rs = await state(page);
check(rs!.players.map((p) => p.name).join(',') === 'John,Cobalt,Amber,Emerald', 'Rematch: same seats, new game', results);
await page.screenshot({ path: 'artifacts/e2e/hotseat-rematch.png' });

await browser.close();
finish(results, errors);
