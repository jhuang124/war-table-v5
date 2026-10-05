// Two humans share the device (v5.1 A, _claude/v5/QUIETER.md §3 A): there is no hand-off cover. John looks
// at his hand in the Cards sheet, places with it open (Place waits: it never advances under the sheet) and
// ends his turn through the Turn Track with the sheet still open. Zero frames of Sam's hand may be visible: every
// DOM mutation and every animation frame is checked in the page across the real end-turn transition. As the
// turn passes, John's sheet closes itself, no cover element ever appears, and the turn line names Sam
// ("Sam's turn · N armies") with Sam's seat ring the current one. Sam's hand shows only when Sam opens it.
import { ART, check, clickBtn, finish, idle, loadScenario, open, place, rendered, scenario, seg, state, ui } from './lib';
import type { Card, GameState } from '../../src/engine';

const results: string[] = [];
const { browser, page, errors } = await open();
const TWO = [
  { name: 'John', color: 'crimson', kind: 'human' },
  { name: 'Sam', color: 'cobalt', kind: 'human' },
] as never;
const johnCards: Card[] = [
  { id: 0, territory: 'alaska', symbol: 'infantry' },
  { id: 1, territory: 'alberta', symbol: 'cavalry' },
];
const samCards: Card[] = [
  { id: 20, territory: 'brazil', symbol: 'infantry' },
  { id: 21, territory: 'peru', symbol: 'cavalry' },
  { id: 22, territory: 'china', symbol: 'infantry' },
];
const hs = scenario({ ural: [0, 5], ukraine: [0, 2] }, { kind: 'reinforce', remaining: 3, mustTrade: false, placed: {}, midTurn: false }, {
  players: TWO,
  fill: (_t, i) => [i % 2, 2],
  mutate: (s: GameState) => {
    s.players[0].cards = johnCards;
    s.players[1].cards = samCards;
  },
});
// An old settings file that still asks to hide cards: v5.1 ignores it (the setting went).
await loadScenario(page, hs, { settings: { hideCardsBetweenTurns: true } });

// John opens his hand from the strip (Cards 2), a read-only sheet.
let u0 = await ui(page);
check(u0.buttons.includes('Cards 2'), `Place strip offers Cards 2 (${u0.buttons.join(' / ')})`, results);
await clickBtn(page, 'btn-cards');
await page.waitForSelector('[data-testid="card-0"]', { state: 'visible' });
check(await page.locator('[data-testid="card-0"]').isVisible(), 'John’s hand is open', results);
u0 = await ui(page);
check(u0.cardsOpen && (await page.locator('[data-testid="cards-trade"]').isVisible()) === false, 'no set: the sheet only shows the hand', results);

await page.evaluate(`(() => {
  const sam = [20, 21, 22];
  const L = (window.__leak = { checks: 0, leaks: 0, cover: 0, first: null, stop: false });
  const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; let n = el; while (n && n !== document.body) { const cs = getComputedStyle(n); if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false; n = n.parentElement; } return true; };
  const probe = (src) => {
    if (L.stop) return;
    L.checks++;
    if (document.querySelector('[data-testid="handoff"], [data-testid="handoff-accept"], [data-testid="handoff-mission"]')) L.cover++;
    const shown = sam.filter((id) => visible(document.querySelector('[data-testid="card-' + id + '"]')));
    if (shown.length) { L.leaks++; L.last = Math.round(performance.now() - (window.__endAt || 0)); if (!L.first) { const u = window.__risk.ui(); L.first = src + ' cards ' + shown.join(',') + ' (engine seat ' + window.__risk.getState().currentPlayer + ', track ' + u.trackSeat + ', cardsOpen ' + u.cardsOpen + ', line "' + u.line + '", t ' + Math.round(performance.now() - (window.__endAt || 0)) + ' ms after End turn)'; } }
  };
  new MutationObserver(() => probe('mutation')).observe(document.getElementById('ui'), { subtree: true, childList: true, attributes: true, characterData: true });
  const raf = () => { probe('frame'); if (!L.stop) requestAnimationFrame(raf); };
  requestAnimationFrame(raf);
})()`);

// Place everything with the hand still open: the marker waits in Place (v5.1 E1 never advances while the
// Cards sheet is open), and End turn on the track ends the turn with John's hand on screen.
await place(page, 'ural');
await page.waitForTimeout(600);
let ua = await ui(page);
const openAtEnd = ua.cardsOpen;
check(openAtEnd && ua.step === 'Place' && (await page.locator('[data-testid="card-0"]').isVisible()), `all placed with the hand open: still Place, the hand on screen (step ${ua.step}, open ${ua.cardsOpen})`, results);
await page.evaluate(() => ((window as unknown as { __endAt: number }).__endAt = performance.now()));
await seg(page, 'endTurn', true);
await page.waitForFunction(() => window.__risk.getState()!.currentPlayer === 1, null, { timeout: 5000 });
await page.waitForFunction(() => /^Sam's turn/.test(window.__risk.ui().bannerLine ?? ''), null, { timeout: 3000 }).catch(() => undefined);
let u = await ui(page);
const turnLine = u.bannerLine;
await page.screenshot({ path: `${ART}/handoff-turn-line.png` });
await page.waitForTimeout(600); // keep watching while Sam's turn settles
await idle(page);
await rendered(page);
const ring = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.seat-chip.current')].map((c) => c.dataset.testid));
const leak = (await page.evaluate('window.__leak')) as { checks: number; leaks: number; cover: number; first: string | null; last?: number };
await page.evaluate('window.__leak.stop = true');
check(leak.checks > 20 && leak.leaks === 0, `zero frames of Sam’s hand across the turn pass (${leak.checks} checks, ${leak.leaks} leaks${leak.first ? `, first: ${leak.first}; last ${leak.last} ms after End turn` : ''})`, results);
check(leak.cover === 0, `no hand-off cover element in any of those frames (${leak.cover})`, results);
u = await ui(page);
check(!u.cardsOpen && (await page.locator('[data-testid="card-0"]').isVisible()) === false, `John's sheet closed itself as the turn passed (open before ${openAtEnd}, now ${u.cardsOpen})`, results);
check(!!turnLine && /^Sam's turn · \d+ arm(y|ies)$/.test(turnLine), `the turn line names Sam: "${turnLine}"`, results);
check(ring.length === 1 && ring[0] === 'seat-1', `Sam's seat ring is the current one (${ring.join(', ')})`, results);
const s = (await state(page))!;
check(s.currentPlayer === 1 && s.phase.kind === 'reinforce' && u.trackLive && u.trackSeat === 'Sam', `Sam's reinforce, live at once, nothing to accept (${s.phase.kind}, track ${u.trackSeat} live ${u.trackLive})`, results);
// Sam's hand shows when Sam opens it.
await clickBtn(page, 'btn-cards');
await page.waitForSelector('[data-testid="card-20"]', { state: 'visible', timeout: 3000 }).catch(() => undefined);
check(await page.locator('[data-testid="card-20"]').isVisible(), 'Sam’s hand shows when Sam opens it', results);
await page.screenshot({ path: `${ART}/handoff-after.png` });
await browser.close();
finish(results, errors);
