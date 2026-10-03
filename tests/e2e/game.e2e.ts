// The main path, 1 human + 3 normal AIs, from the title with real mouse clicks on the real board and HUD
// (no keys): title → New game (name, seed) → Start → Quick deal → first Place (≤ 20 s)
//   Place: pick, count to 2, Place 2, Undo, Place all · the Turn Track: Attack · target-first attack ·
//   Roll (a single roll) · Blitz · occupy with Move N · the chained source · another fight · the track:
//   Fortify → a move that ends the turn · AI turns hand control back within budget · later rounds (skip
//   fortify: End turn straight from Attack) until a card set is ready → traded from the Cards sheet (or
//   the forced one-button trade).
// Also checks the §10 feel budgets from __risk.metrics(): roll/blitz/brief timings, AI turn median and
// p95, forced wait 0, camera never moves during human input and stays ≤ 45°/s, idle board 0 tweens.
import { ART, check, clearStorage, clickBtn, clickT, finish, idle, open, place, rendered, seg, state, ui } from './lib';
import { attackTargets, fortifyTargets, TERRITORY_IDS, type GameState, type TerritoryId } from '../../src/engine';

const results: string[] = [];
const { browser, page, errors } = await open();
await clearStorage(page);
await page.reload();
await page.waitForFunction(() => window.__risk?.ui().screen === 'title');

// Watch line 1 in the page the whole time: it must never be empty on the game screen.
await page.evaluate(`(() => {
  window.__l1 = { samples: 0, empty: 0, maxBanners: 0, maxToasts: 0 };
  setInterval(() => {
    const u = window.__risk.ui();
    if (u.screen !== 'game') return;
    window.__l1.samples++;
    if (!u.line) window.__l1.empty++;
    window.__l1.maxBanners = Math.max(window.__l1.maxBanners, u.banners.length);
    window.__l1.maxToasts = Math.max(window.__l1.maxToasts, u.buttons.length);
  }, 50);
})()`);

await clickBtn(page, 'title-new');
await page.locator('[data-testid="seat-name-0"]').fill('John');
await page.locator('[data-testid="seat-name-0"]').press('Enter');
await clickBtn(page, 'house-toggle');
await page.locator('[data-testid="house-seed"]').fill('4242');
await page.locator('[data-testid="house-seed"]').press('Enter');
const summary = await page.locator('[data-testid="ng-summary"]').textContent();
check(summary === 'Territories dealt at random · armies placed for you · first to 30 territories wins', `summary: ${summary}`, results);
const tStart = Date.now();
await clickBtn(page, 'ng-start');

const mine = (s: GameState) => TERRITORY_IDS.filter((t) => s.territories[t].owner === 0);
async function myTurn(timeout = 90_000): Promise<GameState | null> {
  await page.waitForFunction(
    () => {
      const s = window.__risk.getState();
      if (!s || s.phase.kind === 'game-over' || window.__risk.ui().screen !== 'game') return true;
      return s.currentPlayer === 0 && s.phase.kind === 'reinforce' && window.__risk.isIdle();
    },
    null,
    { timeout, polling: 50 },
  );
  const s = await state(page);
  if (!s || s.phase.kind !== 'reinforce' || s.players[0].eliminated) return null;
  await rendered(page);
  return s;
}
/** The border tile with the most armies, and its weakest enemy neighbour. */
function front(s: GameState): { from: TerritoryId; to: TerritoryId } | null {
  let best: { from: TerritoryId; to: TerritoryId; score: number } | null = null;
  for (const t of mine(s)) {
    for (const n of attackTargets({ ...s, territories: { ...s.territories, [t]: { ...s.territories[t], armies: 99 } } }, t)) {
      const score = s.territories[t].armies * 10 - s.territories[n].armies;
      if (!best || score > best.score) best = { from: t, to: n, score };
    }
  }
  return best;
}

// --- Turn 1: every step by real clicks -------------------------------------------------------------
let s = await myTurn();
const firstClick = Date.now() - tStart;
check(!!s, 'reached John’s first reinforce', results);
check(firstClick <= 20_000, `Start → first reinforce click ${firstClick} ms (≤ 20 s)`, results);
if (!s) finish(results, errors);
await page.evaluate(() => window.__risk.resetMetrics());
await page.screenshot({ path: `${ART}/game-reinforce-start.png` });

const f = front(s!)!;
const toPlace = (s!.phase as { remaining: number }).remaining;
const before = s!.territories[f.from].armies;
let u = await ui(page);
check(u.step === 'Place' && new RegExp(`^Place ${toPlace} arm(y|ies) · click a territory$`).test(u.line), `[${u.step}] ${u.line}`, results);
await place(page, f.from, 2);
let st = (await state(page))!;
check(st.territories[f.from].armies === before + 2, `pick, stepper 2, Place 2 → ${f.from} ${st.territories[f.from].armies} (was ${before})`, results);
await clickBtn(page, 'btn-undo');
await idle(page);
st = (await state(page))!;
check(st.territories[f.from].armies === before, `Undo → ${f.from} ${st.territories[f.from].armies}`, results);
// The track explains itself before all are placed.
await seg(page, 'attack');
check((await ui(page)).line === `Place your ${toPlace} armies first`, `locked Attack: "${(await ui(page)).line}"`, results);
await place(page, f.from);
await idle(page);
st = (await state(page))!;
check((st.phase as { remaining: number }).remaining === 0 && st.territories[f.from].armies === before + toPlace, `Place ${toPlace} → all on ${f.from}`, results);
u = await ui(page);
check(u.line === 'All placed · Attack is next' && u.brass.join() === 'Attack' && u.recommended === 'attack', `the line: ${u.line} · brass ${u.brass.join()}`, results);
// A board click never leaves Place.
await clickT(page, f.to);
check((await state(page))!.phase.kind === 'reinforce', 'an enemy click in Place (all placed) does not start attacking', results);

// The track: Attack. Target-first: click the enemy; Roll = a single roll.
await seg(page, 'attack');
await idle(page);
await clickT(page, f.to);
u = await ui(page);
check(u.primary === 'Blitz' && !!u.battle && /^.+ → .+ · \d+%( · .+)?$/.test(u.line) && u.step === 'Attack', `armed target-first: "${u.line}" · tray ${u.battle?.header}`, results);
check(u.track.join(' ') === 'done:place current:attack eligible:fortify eligible:endTurn' && u.brass.join() === 'Blitz', `the track never hides while armed (${u.track.join(' ')}), one brass (${u.brass.join()})`, results);
await page.screenshot({ path: `${ART}/game-armed.png` });
const pre = (await state(page))!;
const sum0 = pre.territories[f.from].armies + pre.territories[f.to].armies;
await clickT(page, f.to); // the armed target again: still armed, nothing rolls
check((await state(page))!.territories[f.to].armies === pre.territories[f.to].armies, 'clicking the armed target again does not roll', results);
await clickBtn(page, 'btn-roll');
await page.waitForTimeout(700);
await page.screenshot({ path: `${ART}/game-roll.png` });
await idle(page);
st = (await state(page))!;
u = await ui(page);
const lost = sum0 - (st.territories[f.from].armies + (st.territories[f.to].owner === 0 ? 0 : st.territories[f.to].armies));
check(lost >= 1 && lost <= 3, `Roll rolled once (${lost} armies lost in the fight)`, results);
let conquests = 0;
// Blitz until it falls (or we run dry).
for (let guard = 0; guard < 3 && st.phase.kind === 'attack' && st.territories[f.to].owner !== 0 && st.territories[f.from].armies > 1; guard++) {
  await clickBtn(page, 'btn-blitz');
  await idle(page);
  st = (await state(page))!;
}
if (st.phase.kind === 'occupy' || st.territories[f.to].owner === 0) conquests++;
check(conquests === 1, `took ${f.to}`, results);
if (st.phase.kind === 'occupy') {
  u = await ui(page);
  check(/^Move \d+$/.test(u.primary ?? ''), `occupy primary: ${u.primary}`, results);
  check(u.trackDisabled && u.brass.join() === u.primary, `occupy locks the track; the one brass is ${u.primary}`, results);
  const next = attackTargets({ ...st, territories: { ...st.territories, [f.to]: { owner: 0, armies: 9 } } }, f.to)[0];
  // A board click never confirms the occupy.
  if (next) await clickT(page, next);
  check((await state(page))!.phase.kind === 'occupy', 'a board click during occupy does not move armies', results);
  await clickBtn(page, 'btn-move');
  await idle(page);
  st = (await state(page))!;
  u = await ui(page);
  check(st.phase.kind === 'attack' && st.territories[f.to].armies >= 1, `Move confirmed the occupy (${f.to} ${st.territories[f.to].armies})`, results);
  if (next && st.territories[f.to].armies >= 2) {
    // The conquered tile is the source now: one click on the next enemy arms it.
    check(/^Attack from /.test(u.line), `chained: ${u.line}`, results);
    await clickT(page, next);
    u = await ui(page);
    if (u.primary === 'Blitz') {
      await clickBtn(page, 'btn-blitz');
      await idle(page);
      st = (await state(page))!;
      if (st.phase.kind === 'occupy') {
        await clickBtn(page, 'btn-move');
        await idle(page);
      }
    }
  }
}
st = (await state(page))!;
u = await ui(page);
check(u.buttons.every((b) => b !== 'End turn' && b !== 'Fortify →') && u.track.includes('eligible:fortify'), `the action zone never changes phase: ${u.buttons.join(' / ') || '(empty)'}`, results);

// Fortify from the track (even with a fight still armed), pick a source and a destination, Move N · end turn.
await seg(page, 'fortify');
await idle(page);
st = (await state(page))!;
check(st.phase.kind === 'fortify', 'the Fortify segment reaches the fortify step', results);
u = await ui(page);
check(u.recommended === 'endTurn' && u.brass.join() === 'End turn', `in Fortify, End turn is the brass one (${u.brass.join()})`, results);
const src = mine(st).filter((t) => st.territories[t].armies >= 2 && fortifyTargets(st, t).length > 0).sort((a, b) => st.territories[b].armies - st.territories[a].armies)[0];
if (src) {
  const dst = fortifyTargets(st, src)[0];
  await clickT(page, src);
  await clickT(page, dst);
  u = await ui(page);
  const range = u.count ? u.count.max - u.count.min + 1 : 1;
  check(/^Move \d+ · end turn$/.test(u.primary ?? '') && (range === 1 || u.count?.control === (range <= 6 ? 'stepper' : 'slider')), `fortify primary: ${u.primary} with a ${u.count?.control ?? 'fixed count'} (${range} options)`, results);
  check(u.recommended === 'endTurn' && u.brass.join() === u.primary, `a pending move is the one brass; End turn only glows (${u.brass.join()})`, results);
  const moved = st.territories[src].armies - 1;
  await clickBtn(page, 'btn-move');
  await page.waitForFunction((p) => window.__risk.getState()!.currentPlayer !== p, 0, { timeout: 10_000 });
  st = (await state(page))!;
  check(st.territories[dst].armies >= moved, `fortified ${moved} ${src} → ${dst} and the turn ended`, results);
} else {
  await seg(page, 'endTurn');
}

// --- AI turns, then later rounds until a set is ready -----------------------------------------------
let traded = false;
let round = 1;
for (; round < 12 && !traded; round++) {
  s = await myTurn(120_000);
  if (!s) break;
  if (round === 4) {
    // The watch-speed budget sample is rounds 1–3; AI speed lives in Settings now.
    await clickBtn(page, 'menu');
    await clickBtn(page, 'pause-settings');
    await clickBtn(page, 'ai-fast');
    await clickBtn(page, 'settings-done');
    await clickBtn(page, 'pause-resume');
    await page.waitForFunction(() => !document.querySelector('[data-testid="pause"]'));
  }
  u = await ui(page);
  const forced = u.primary?.startsWith('Trade cards +');
  const canTrade = forced || (u.buttons.some((b) => b.startsWith('Cards ')) && (await page.evaluate(() => {
    const s = window.__risk.getState()!;
    return s.players[0].cards.length >= 3;
  })));
  if (canTrade) {
    const r0 = (s.phase as { remaining: number }).remaining;
    if (forced) {
      const label = u.primary!;
      check(u.trackDisabled && u.buttons.length === 1, `forced trade: "${label}" is the only action, the track is locked`, results);
      await clickBtn(page, 'btn-trade');
    } else {
      await clickBtn(page, 'btn-cards');
      await page.locator('[data-testid="cards"]').waitFor({ timeout: 3000 });
    }
    const sheetTrade = page.locator('[data-testid="cards-trade"]:visible');
    if (!forced && (await sheetTrade.count())) {
      const label = (await sheetTrade.textContent()) ?? '';
      check((await ui(page)).brass.join() === label, `the sheet's ${label} is the one brass`, results);
      await sheetTrade.click();
    } else if (!forced) await clickBtn(page, 'cards-close');
    await idle(page);
    st = (await state(page))!;
    const gained = (st.phase as { remaining: number }).remaining - r0;
    if (gained > 0) {
      check(gained >= 4, `traded a set: ${r0} → ${(st.phase as { remaining: number }).remaining} to place`, results);
      traded = true;
    }
    s = st;
  }
  const fr = front(s);
  if (!fr) break;
  await place(page, fr.from);
  await idle(page);
  await seg(page, 'attack');
  await idle(page);
  await clickT(page, fr.to);
  u = await ui(page);
  if (u.primary !== 'Blitz') {
    const dbg = await page.evaluate((t) => {
      const p = window.__risk.screenPos(t as never);
      const el = p ? document.elementFromPoint(p.x, p.y) : null;
      return { ex: window.__risk.explain(t as never), p, hit: el ? el.className || el.tagName : null, line: window.__risk.ui().line };
    }, fr.to);
    console.log('   target click did not arm:', fr.from, '→', fr.to, JSON.stringify(dbg));
  }
  if (u.primary === 'Blitz') {
    await clickBtn(page, 'btn-blitz');
    await idle(page);
  }
  st = (await state(page))!;
  if (st.phase.kind === 'occupy') {
    await clickBtn(page, 'btn-move');
    await idle(page);
  }
  st = (await state(page))!;
  if (st.phase.kind === 'game-over') break;
  if (st.phase.kind !== 'attack' && st.phase.kind !== 'fortify') {
    console.log('   unexpected step before End turn:', JSON.stringify(st.phase), (await ui(page)).line);
    await page.screenshot({ path: `${ART}/game-unexpected.png` });
  }
  // Skip fortify: End turn straight from Attack (1 click), even with a source still selected.
  await seg(page, 'endTurn');
}
check(traded, `a card set came up and was traded with one button (round ${round})`, results);

// --- Budgets -----------------------------------------------------------------------------------------
const m = await page.evaluate(() => window.__risk.metrics());
const watchAi = m.turns.slice(0, 12).filter((t) => t.kind === 'ai').map((t) => t.ms);
const sorted = [...watchAi].sort((a, b) => a - b);
const med = sorted[Math.floor(sorted.length / 2)] ?? 0;
const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
console.log('   AI turns at watch (ms):', watchAi.join(', '));
check(watchAi.length >= 4 && med <= 6000, `AI turn median ${med} ms (≤ 6 s, ${watchAi.length} turns)`, results);
check(p95 <= 12_000, `AI turn p95 ${p95} ms (≤ 12 s)`, results);
const humans = m.turns.filter((t) => t.kind === 'human');
console.log('   human turns:', humans.map((t) => `${t.clicks} clicks/${t.ms} ms`).join(', '));
check(humans.length > 0 && humans[0].clicks <= 26, `turn 1 (place with a count and an Undo, the track, roll, blitz, move, chain, fortify) took ${humans[0]?.clicks} clicks`, results);
check(humans.every((t) => t.forcedWaitMs === 0), `human forced wait: ${humans.map((t) => t.forcedWaitMs).join(', ')} ms`, results);
const full1 = m.rolls.filter((r) => r.style === 'full' && !r.blitz && r.count === 1).map((r) => r.ms);
const blitz = m.rolls.filter((r) => r.blitz && r.style === 'full').map((r) => r.ms);
// v4: AI engagements play 'readable' (one steady beat, never the dice show); 'brief' no longer exists
const brief = m.rolls.filter((r) => r.style === 'readable' || r.style === 'brief').map((r) => r.ms);
console.log(`   rolls: single ${full1.join(',')} · blitz ${blitz.join(',')} · readable max ${Math.max(0, ...brief)} (${brief.length})`);
// INK A6's budgets, exactly (metrics are wall-clock from dispatch to the last promise). The single roll
// includes the 250 ms verdict silence; the blitz's middle rolls share its budget against the real clock.
check(full1.length > 0 && Math.max(...full1) <= 1250, `single roll ≤ 1.25 s incl. the silence (max ${Math.max(0, ...full1)} ms)`, results);
check(blitz.length > 0 && Math.max(...blitz) <= 3000, `blitz ≤ 3.0 s (max ${Math.max(0, ...blitz)} ms over ${blitz.length})`, results);
check(brief.length > 0 && Math.max(...brief) <= 1400, `readable AI engagement ≤ 1.4 s at 1× (max ${Math.max(0, ...brief)} ms over ${brief.length})`, results);
check(m.cameraMovesDuringHumanInput === 0, `cameraMovesDuringHumanInput ${m.cameraMovesDuringHumanInput}`, results);
check(m.maxCameraDegPerSec <= 45, `automatic camera peak ${m.maxCameraDegPerSec}°/s (≤ 45)`, results);
check(m.inputDropped === 0, `inputDropped ${m.inputDropped}`, results);
const l1 = (await page.evaluate('window.__l1')) as { samples: number; empty: number; maxBanners: number; maxToasts: number };
check(l1.samples > 200 && l1.empty === 0, `the line is never empty (${l1.empty} of ${l1.samples} samples)`, results);
check(l1.maxBanners <= 1 && l1.maxToasts <= 2, `≤ 1 banner (max ${l1.maxBanners}), ≤ 2 strip buttons (max ${l1.maxToasts})`, results);
await page.screenshot({ path: `${ART}/game-end.png` });
await browser.close();
finish(results, errors);
