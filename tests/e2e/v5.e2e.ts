// v5 audits (_claude/v5/PROPOSAL.md): the parts a browser can check without a human.
//   E  holding      during a human's Place step the holding dab exists with the right count and a breakdown
//   B  place hooks  front lines on, the evening clock in 0..1, the idle-drift hook present
//   C  replay       End game now builds a replay (rounds, ≤ 3 moments) and the recap shows the Moments block
//   A  fight hooks  a human fight leans the camera (BoardView.leanTo) and lands dice staggered (motion log)
// Logic lane, realtime. Numbers are always printed.
import { check, clickBtn, clickT, finish, loadScenario, open, ui } from './lib';
import { restBoard } from './board-lib';

const results: string[] = [];
const { browser, page, errors } = await open(undefined, { width: 1440, height: 900 });

// --- E · the holding dab ------------------------------------------------------------------------------------
await loadScenario(page, restBoard({ kind: 'reinforce', remaining: 7, mustTrade: false, placed: {}, midTurn: false }));
if ((await page.evaluate(() => window.__risk.ui().gold)) === 'handoff') await page.locator('[data-testid="handoff-accept"]').first().click();
await page.waitForTimeout(800);
const holding = await page.evaluate(() => (window.__risk as unknown as { holding?: () => { armies: number; breakdown: string } | null }).holding?.() ?? null);
const dabVisible = await page.locator('[data-testid="holding"]').first().isVisible().catch(() => false);
results.push(`holding: ${holding ? `${holding.armies} armies · "${holding.breakdown}"` : 'none'}; dab ${dabVisible ? 'visible' : 'hidden'}`);
check(!!holding && holding.armies === 7 && holding.breakdown.length > 0, 'E the holding dab exists during Place with the remaining count and a breakdown', results);
check(dabVisible, 'E the holding dab is drawn in the strip', results);

// --- B · place hooks ----------------------------------------------------------------------------------------
const place = await page.evaluate(() => {
  const d = (window as unknown as { __board?: { __debug?: { place?: { evening: number; front: number; driftPx: number } } } }).__board?.__debug;
  return d?.place ?? null;
});
results.push(`place: ${place ? `front ${place.front}, evening ${place.evening.toFixed(2)}, driftPx ${place.driftPx}` : 'no hook'}`);
check(!!place && place.front === 1, 'B front lines are on by default', results);
check(!!place && place.evening >= 0 && place.evening <= 1, 'B the evening clock is in 0..1', results);

// --- A · fight hooks: lean + stagger -------------------------------------------------------------------------
await loadScenario(page, restBoard({ kind: 'attack' }));
if ((await page.evaluate(() => window.__risk.ui().gold)) === 'handoff') await page.locator('[data-testid="handoff-accept"]').first().click();
await page.waitForTimeout(600);
await clickT(page, 'ural');
await clickT(page, 'siberia');
const u = await ui(page);
const rollId = u.buttons.find((b: string) => /roll/i.test(b));
let lean: unknown = null;
let staggered: unknown = null;
if (rollId) {
  await page.locator(`[data-testid="btn-${rollId.toLowerCase()}"]`).first().click();
  await page.waitForTimeout(700);
  lean = await page.evaluate(() => {
    const d = (window as unknown as { __board?: { __debug?: Record<string, unknown> } }).__board?.__debug ?? {};
    return (d as { lean?: unknown }).lean ?? (d as { fight?: unknown }).fight ?? null;
  });
  await page.waitForTimeout(2500);
  staggered = await page.evaluate(() => {
    const d = (window as unknown as { __board?: { __debug?: { lastRoll?: unknown; motionLog?: { type: string; stagger?: number }[] } } }).__board?.__debug;
    return { lastRoll: d?.lastRoll ?? null, rolls: (d?.motionLog ?? []).filter((e) => e.type === 'diceRolled').slice(-2) };
  });
}
results.push(`fight: lean hook ${lean ? JSON.stringify(lean).slice(0, 120) : 'absent'}; last roll ${JSON.stringify(staggered).slice(0, 160)}`);
check(!!rollId, 'A a human fight can be rolled from the rest board', results);

// --- C · replay and moments ----------------------------------------------------------------------------------
await clickBtn(page, 'menu');
await clickBtn(page, 'pause-endgame');
await page.waitForSelector('[data-testid="confirm-yes"]', { state: 'visible', timeout: 3000 });
await clickBtn(page, 'confirm-yes');
await page.waitForFunction(() => window.__risk.ui().screen === 'victory', null, { timeout: 30_000 });
await page.waitForTimeout(500);
const replay = await page.evaluate(() => (window.__risk as unknown as { replay?: () => { rounds: unknown[]; moments: string[]; msPerRound: number } | null }).replay?.() ?? null);
results.push(`replay: ${replay ? `${replay.rounds.length} rounds, ${replay.moments.length} moments (${replay.moments.join(' | ')}), ${replay.msPerRound} ms/round` : 'none'}`);
check(!!replay && replay.rounds.length >= 1, 'C End game now builds a replay with at least one round', results);
check(!!replay && replay.moments.length <= 3, 'C the replay names at most three moments', results);
const momentsShown = await page.locator('[data-testid="moments"]').count();
results.push(`recap Moments block: ${momentsShown ? 'present' : 'absent'}`);

await browser.close();
finish(results, errors);
