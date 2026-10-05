// A 1-human + 3-AI game from the title via real clicks, timed by __risk.metrics().turns, with the stub
// board modelling the renderer's 1× durations (?timings). The human plays a short real-click turn each
// round (pick a tile, Place all, then `End turn` on the Turn Track straight from Place); the AIs run the
// highlight reel at `watch`.
// Budgets: AI turn median ≤ 6 s, p95 ≤ 12 s; a round of 3 AI turns ≤ 25 s; Start → first click ≤ 20 s.
import { check, clearStorage, clickBtn, finish, idle, open, place, rendered, seg, state, ui } from './lib';

const results: string[] = [];
const { browser, page, errors } = await open();
await clearStorage(page);
await page.reload();
await page.waitForFunction(() => !!window.__risk);
await clickBtn(page, 'title-new');
await page.locator('[data-testid="seat-name-0"]').fill('John');
await page.locator('[data-testid="seat-name-0"]').press('Tab');
const tStart = Date.now();
await clickBtn(page, 'ng-start');
// Sample the strip in the page during AI turns: the track is not live, it follows the AI's marker, and
// the narration is event-driven. (A string: tsx's keepNames helpers don't exist in the page.)
await page.evaluate(`(() => {
  const A = (window.__aiStrip = { n: 0, live: 0, steps: {}, seatMismatch: 0, mm: [], lines: {} });
  setInterval(() => {
    const s = window.__risk.getState();
    const u = window.__risk.ui();
    if (!s || u.screen !== 'game' || s.phase.kind === 'game-over' || s.phase.kind.startsWith('setup')) return;
    const p = s.players[s.currentPlayer];
    if (p.kind !== 'ai') return;
    A.n++;
    if (u.trackLive) A.live++;
    A.steps[u.step] = (A.steps[u.step] || 0) + 1;
    // The board may still be playing the previous seat's last move (display lags the engine), so compare
    // the marker with the seat the line narrates, not with getState().currentPlayer.
    const named = s.players.find((q) => u.line.startsWith(q.name + ' ') || u.line.startsWith(q.name + "'s "));
    if (named && u.trackSeat !== named.name) { A.seatMismatch++; if (A.mm.length < 10) A.mm.push(u.trackSeat + ' vs "' + u.line + '"'); }
    A.lines[u.line] = (A.lines[u.line] || 0) + 1;
  }, 60);
})()`);

let firstClickAt = 0;
let rounds = 0;
const placedLines: string[] = [];
const deadline = Date.now() + 240_000;
while (Date.now() < deadline && rounds < 3) {
  // Wait for the human's turn to be playable.
  await page.waitForFunction(
    () => {
      const s = window.__risk.getState();
      if (!s || s.phase.kind === 'game-over') return true;
      return s.players[s.currentPlayer].kind === 'human' && s.phase.kind === 'reinforce' && window.__risk.isIdle();
    },
    null,
    { timeout: 120_000, polling: 50 },
  );
  const s = await state(page);
  if (!s || s.phase.kind === 'game-over') break;
  await rendered(page);
  const mine = (Object.keys(s.territories) as (keyof typeof s.territories)[]).filter((t) => s.territories[t].owner === 0);
  const tile = mine.sort((a, b) => s.territories[b].armies - s.territories[a].armies)[0];
  if (!firstClickAt) firstClickAt = Date.now();
  await place(page, tile);
  await idle(page);
  // v5.1 E1: with everything placed, Place → Attack advances by itself (~250 ms); End turn stays explicit.
  const t0 = Date.now();
  await page.waitForFunction(() => window.__risk.ui().step === 'Attack', null, { timeout: 3000, polling: 20 }).catch(() => undefined);
  const u = await ui(page);
  placedLines.push(`${u.step} ${Date.now() - t0} ms`);
  await seg(page, 'endTurn');
  rounds++;
}
const m = await page.evaluate(() => window.__risk.metrics());
const ai = m.turns.filter((t) => t.kind === 'ai').map((t) => t.ms);
const sorted = [...ai].sort((a, b) => a - b);
const med = sorted[Math.floor(sorted.length / 2)];
const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
console.log('AI turn ms:', ai.join(', '));
const firstSeat = m.turns[0]?.player;
const before = m.turns.findIndex((t) => t.kind === 'human');
check(firstClickAt - tStart <= 20_000, `Start → first reinforce click ${firstClickAt - tStart} ms (≤ 20 s; ${before} AI turns went first, first seat ${firstSeat})`, results);
check(ai.length >= 6, `${ai.length} AI turns measured`, results);
check(med <= 6000, `AI turn median ${med} ms (≤ 6 s)`, results);
check(p95 <= 12000, `AI turn p95 ${p95} ms (≤ 12 s)`, results);
// Rounds: the three AI turns between two human turns.
const turns = m.turns;
let worst = 0;
for (let i = 0; i < turns.length; i++) {
  if (turns[i].kind !== 'human') continue;
  let sum = 0;
  let j = i + 1;
  while (j < turns.length && turns[j].kind === 'ai') sum += turns[j++].ms;
  if (j < turns.length && j - i - 1 === 3) worst = Math.max(worst, sum);
}
check(worst > 0 && worst <= 25_000, `a full round of 3 AI turns ≤ 25 s (worst ${worst} ms)`, results);
check(
  placedLines.length > 0 && placedLines.every((l) => /^Attack \d+ ms$/.test(l)),
  `all placed → the marker moves to Attack by itself (v5.1 E1; after idle): ${placedLines.join(' | ')}`,
  results,
);
const A = (await page.evaluate('window.__aiStrip')) as { n: number; live: number; steps: Record<string, number>; seatMismatch: number; mm: string[]; lines: Record<string, number> };
const lines = Object.keys(A.lines);
check(A.n > 50 && A.live === 0, `AI turns: the track is never live (${A.live} of ${A.n} samples)`, results);
check(Object.keys(A.steps).every((k) => ['Setup', 'Place', 'Attack', 'Fortify'].includes(k)) && (A.steps.Attack ?? 0) > 0 && (A.steps.Place ?? 0) > 0, `AI turns: the marker moves through the segments ${JSON.stringify(A.steps)} (Setup = the opening deal still on screen)`, results);
check(A.seatMismatch === 0, `AI turns: the marker is the narrated seat's (${A.seatMismatch} of ${A.n} samples off${A.mm.length ? ': ' + A.mm.join(' | ') : ''})`, results);
check(!lines.some((l) => /is (reinforcing|placing armies|attacking|fortifying)/.test(l)), 'no "is reinforcing / is attacking" lines', results);
check(
  lines.some((l) => /^\w+ gets \d+ armies$/.test(l)) && lines.some((l) => /^\w+ places \d+ arm(y|ies)$/.test(l)) && lines.some((l) => /^\w+ attacks [A-Z]/.test(l)),
  `event-driven narration: ${lines.slice(0, 12).join(' | ')}`,
  results,
);
const humans = turns.filter((t) => t.kind === 'human');
check(humans.every((t) => t.forcedWaitMs === 0), `human forced wait: ${humans.map((t) => t.forcedWaitMs).join(', ')} ms`, results);
// v5.1: Place → Attack is automatic (one click fewer) and no truce offer ever asks for an answer.
check(humans.length > 0 && humans.every((t) => t.clicks <= 3), `human clicks per quick turn: ${humans.map((t) => t.clicks).join(', ')} (≤ 3: pick, Place, End turn)`, results);
check(m.cameraMovesDuringHumanInput === 0, `cameraMovesDuringHumanInput ${m.cameraMovesDuringHumanInput}`, results);
await page.screenshot({ path: 'artifacts/e2e/round-end.png' });
await browser.close();
finish(results, errors);
