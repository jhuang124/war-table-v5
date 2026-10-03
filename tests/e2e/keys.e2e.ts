// The keyboard is a hidden accelerator (docs/ROUND2.md §A–B): Enter = the one brass thing (the primary
// button, else the Turn Track's recommended segment when it's the brass one; nothing brass → nothing),
// Space = commit buttons only (Place, Blitz, Move, a forced trade), never a phase change, and during an
// animation it skips; Esc = back one level, then the menu. Nothing on screen names a key. Watched turns:
// a click only skips. Event-driven AI narration. Draft claim with a real click.
import { check, clickBtn, clickT, finish, idle, loadScenario, open, rendered, scenario, seg, state, ui } from './lib';
import type { Phase } from '../../src/engine';

const results: string[] = [];
const { browser, page, errors } = await open();
const reinforce = (remaining: number): Phase => ({ kind: 'reinforce', remaining, mustTrade: false, placed: {}, midTurn: false });
const settle = (ms = 80) => page.waitForTimeout(ms);

// --- Place: Space = Place N; Space again never leaves Place; Enter = the recommended Attack ----------
await loadScenario(page, scenario({ ural: [0, 9], ukraine: [0, 1] }, reinforce(4)));
await clickT(page, 'ural');
await settle();
await page.keyboard.press(' ');
await idle(page);
let s = await state(page);
let u = await ui(page);
check(s!.territories.ural.armies === 13 && u.primary === null, `Space placed all 4 (Ural ${s!.territories.ural.armies}); primary ${u.primary}`, results);
check(u.line === 'All placed · Attack is next' && u.recommended === 'attack' && u.brass.join() === 'Attack', `all placed: "${u.line}" · recommended ${u.recommended} · brass [${u.brass.join(', ')}]`, results);
await page.keyboard.press(' ');
await settle(150);
check((await state(page))!.phase.kind === 'reinforce', 'Space with all placed does not change phase (still Place)', results);
await page.keyboard.press('Enter');
await idle(page);
u = await ui(page);
check((await state(page))!.phase.kind === 'attack' && u.step === 'Attack', `Enter = the recommended segment → ${u.step}`, results);

// --- Attack with targets and nothing armed: the one gold is the current segment (INK B2.1; no commit
// pending), nothing is recommended, Enter does nothing ----------------------------------------------
check(u.brass.join() === 'Attack' && u.recommended === null && u.line === 'Click an enemy territory to attack', `nothing picked: brass [${u.brass.join(', ')}] · "${u.line}"`, results);
await page.keyboard.press('Enter');
await settle(150);
s = await state(page);
check(s!.phase.kind === 'attack' && s!.currentPlayer === 0 && (await ui(page)).line === 'Click an enemy territory to attack', 'Enter with nothing brass does nothing', results);

// --- Esc backs out one level at a time, then opens the menu --------------------------------------
await clickT(page, 'siberia');
await settle();
u = await ui(page);
check(u.buttons.join(' / ') === 'Roll / Blitz' && /^Ural → Siberia · \d+%( · .+)?$/.test(u.line) && u.brass.join() === 'Blitz', `armed: ${u.buttons.join(' / ')} · "${u.line}" · brass [${u.brass.join(', ')}]`, results);
await page.keyboard.press('Escape');
await settle(40);
u = await ui(page);
check(u.line === 'Attack from Ural · click an enemy', `Esc 1 → source only: ${u.line}`, results);
await page.keyboard.press('Escape');
await settle(40);
u = await ui(page);
check(u.line === 'Click an enemy territory to attack', `Esc 2 → nothing picked: ${u.line}`, results);
await page.keyboard.press('Escape');
await settle();
check((await page.locator('[data-testid="pause"]').count()) === 1, 'Esc 3 → the menu', results);
await page.keyboard.press('Escape');
await settle();
check((await page.locator('[data-testid="pause"]').count()) === 0, 'Esc closes the menu', results);

// --- Space blitzes an armed attack and commits the occupy (Move); it never ends a step -------------
await clickT(page, 'siberia');
await settle();
await page.keyboard.press(' ');
await idle(page);
s = await state(page);
check(s!.territories.siberia.owner === 0, 'Space blitzed Siberia', results);
if (s!.phase.kind === 'occupy') {
  u = await ui(page);
  check(u.trackDisabled && /^Move \d+$/.test(u.primary ?? ''), `occupy: track disabled, primary ${u.primary}`, results);
  await page.keyboard.press(' ');
  await idle(page);
  s = await state(page);
  check(s!.phase.kind === 'attack', 'Space commits the occupy (Move)', results);
}
// Back out to nothing picked (without opening the menu), then Space must not end the attack step.
for (let i = 0; i < 3 && (await ui(page)).line !== 'Click an enemy territory to attack'; i++) {
  await page.keyboard.press('Escape');
  await settle(40);
}
u = await ui(page);
check(u.line === 'Click an enemy territory to attack' && (await page.locator('[data-testid="pause"]').count()) === 0, `backed out to nothing picked: ${u.line}`, results);
await page.keyboard.press(' ');
await settle(150);
check((await state(page))!.phase.kind === 'attack', 'Space with nothing armed does not end the attack step', results);

// No keycaps anywhere on the HUD.
const kbd = await page.evaluate(() => [...document.querySelectorAll('#ui .hud kbd, #ui .overlays kbd')].filter((k) => (k as HTMLElement).offsetParent).length);
check(kbd === 0, `no keycaps on screen (${kbd})`, results);

// --- Space during an animation skips it (and commits nothing) --------------------------------------
await loadScenario(page, scenario({ ural: [0, 30], ukraine: [0, 1] }, { kind: 'attack' }, { mutate: (x) => void (x.territories.siberia.armies = 20) }));
await clickT(page, 'siberia');
await settle();
await clickBtn(page, 'btn-roll');
await page.waitForFunction(() => !window.__risk.isIdle(), null, { timeout: 3000 }).catch(() => undefined);
await settle(120);
const tSkip = Date.now();
await page.keyboard.press(' ');
await idle(page);
const skipMs = Date.now() - tSkip;
s = await state(page);
const lost = 50 - s!.territories.ural.armies - s!.territories.siberia.armies;
check(lost === 2 && s!.territories.siberia.owner !== 0 && (await ui(page)).buttons.join(' / ') === 'Roll / Blitz', `Space mid-roll skipped it (${skipMs} ms to idle) and committed nothing: one roll's 2 losses (${lost}), still armed`, results);
check(skipMs < 700, `the skip landed quickly (${skipMs} ms < 700)`, results);

// --- Place, all placed, nothing can attack: the recommended segment is End turn, and Enter takes it --
await loadScenario(page, scenario({ ural: [0, 1], ukraine: [0, 1] }, reinforce(0)));
u = await ui(page);
check(u.line === 'All placed · end your turn' && u.recommended === 'endTurn' && u.brass.join() === 'End turn', `all placed, no attacks: "${u.line}" · brass [${u.brass.join(', ')}]`, results);
await page.keyboard.press('Enter');
const passed = await page.waitForFunction(() => (window.__risk.getState()?.currentPlayer ?? 0) !== 0, null, { timeout: 5000 }).then(() => true, () => false);
check(passed, 'Enter = End turn from Place (the turn passed)', results);

// --- Attack with no attacks possible: Enter = the recommended End turn -----------------------------
await loadScenario(page, scenario({ ural: [0, 1], ukraine: [0, 1] }, { kind: 'attack' }));
u = await ui(page);
check(u.line === 'No attacks left · end your turn' && u.recommended === 'endTurn' && u.brass.join() === 'End turn', `no attacks: "${u.line}" · brass [${u.brass.join(', ')}]`, results);
await page.keyboard.press(' ');
await settle(150);
check((await state(page))!.currentPlayer === 0, 'Space never ends the turn', results);

// --- Fortify (reached by the track): Space does nothing, Enter = End turn → AI turns ---------------
await loadScenario(page, scenario({ ural: [0, 5], ukraine: [0, 1] }, { kind: 'attack' }));
await seg(page, 'fortify');
await idle(page);
u = await ui(page);
check(u.step === 'Fortify' && u.recommended === 'endTurn' && u.brass.join() === 'End turn', `Fortify: brass [${u.brass.join(', ')}]`, results);
await page.keyboard.press(' ');
await settle(150);
check((await state(page))!.phase.kind === 'fortify' && (await state(page))!.currentPlayer === 0, 'Space in Fortify does not end the turn', results);
await page.keyboard.press('Enter');
// Wait for the turn to actually pass before sampling the AI narration.
await page.waitForFunction(() => (window.__risk.getState()?.currentPlayer ?? 0) !== 0, null, { timeout: 8000 });
const narr: string[] = [];
const steps = new Set<string>();
const seats = new Set<string>();
let live = false;
const t0 = Date.now();
let clickedDuringAi = false;
while (Date.now() - t0 < 60_000) {
  const st = await state(page);
  if (!st || st.currentPlayer === 0) break;
  const uu = await ui(page);
  if (!narr.includes(uu.line)) narr.push(uu.line);
  steps.add(uu.step);
  seats.add(uu.trackSeat);
  live ||= uu.trackLive;
  if (!clickedDuringAi && / attacks /.test(uu.line)) {
    const p0 = st.currentPlayer;
    await clickT(page, 'ural');
    const st2 = await state(page);
    check(st2!.currentPlayer === p0, 'a click during an AI turn does not act for anyone', results);
    clickedDuringAi = true;
  }
  await page.waitForTimeout(60);
}
console.log('   narration:', narr.slice(0, 10).join(' | '));
check(narr.some((l) => /^\w+ (gets|places) \d+ arm(y|ies)$/.test(l) || /^\w+ trades cards for \+\d+$/.test(l)), 'narration: “Cobalt gets 5 armies” / “Cobalt places 5 armies”', results);
check(narr.some((l) => /^\w+ attacks [\w ]+(…| and (takes it|is thrown back))?$/.test(l)), 'narration: “Cobalt attacks Siam…”', results);
check(!narr.some((l) => /is (reinforcing|attacking|fortifying)/.test(l)), 'no “is reinforcing / attacking / fortifying” lines', results);
check([...steps].every((x) => ['Place', 'Attack', 'Fortify'].includes(x)) && steps.size > 0, `the track names the AI's step (${[...steps].join(', ')})`, results);
check([...seats].some((x) => x !== 'John') && !live, `the track follows the AI seat (${[...seats].join(', ')}), not clickable`, results);
const m = await page.evaluate(() => window.__risk.metrics());
check(m.inputDropped === 0, `watched-turn click counted as a skip, not dropped (${m.inputDropped})`, results);

// --- Draft: claim an open tile with a real click -----------------------------------------------------
await page.evaluate(() => {
  window.__risk.newGame({
    players: [
      { name: 'John', color: 'crimson', kind: 'human' },
      { name: 'Cobalt', color: 'cobalt', kind: 'ai', difficulty: 'normal' },
    ],
    setupMode: 'draft',
    initialPlacement: 'auto',
    seed: 5,
  });
});
await page.waitForFunction(() => {
  const s = window.__risk.getState();
  return !!s && s.phase.kind === 'setup-claim' && s.currentPlayer === 0 && window.__risk.isIdle();
});
await rendered(page);
u = await ui(page);
check(u.line === 'Claim a territory · click an open tile' && u.step === 'Setup', `draft: [${u.step}] ${u.line}`, results);
const sd = await state(page);
const free = (Object.keys(sd!.territories) as (keyof NonNullable<typeof sd>['territories'])[]).find((t) => sd!.territories[t].owner === -1)!;
await clickT(page, free);
await settle();
check((await state(page))!.territories[free].owner === 0, `claimed ${free}`, results);

await browser.close();
finish(results, errors);
