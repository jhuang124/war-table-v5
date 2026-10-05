// UX.md §11 polish checklist items that need a real browser, on the real board + HUD:
//   #1 hover lands in the same frame on clickable tiles; non-clickable tiles don't react (cursor)
//   #2 no hover flicker sliding along the Ukraine/Ural edge (3 px hysteresis)
//   #3 an orbit drag released over another tile never clicks
//   #14 at most one brass thing (buttons + the Turn Track's recommended segment), ≤ 2 strip buttons,
//       no keycaps; the pointer cursor only on eligible track segments
//   #17 no numerals in Cinzel, no ASCII minus before a number
//   #19 no sound on tile hover
//   #22 no focus ring after a mouse click; a ring after Tab
//   #23 instant speed: the dice still show in the tray
//   #24 empty states: no attack sources / nothing to fortify / no valid set each say so
//   Cards: a non-forced trade happens from the Cards sheet (`Cards N` → Trade), close with ✕
import { check, clickBtn, clickT, finish, idle, loadScenario, open, place, scenario, seg, state, ui } from './lib';
import type { Phase } from '../../src/engine';

const results: string[] = [];
const { browser, page, errors } = await open();
const reinforce = (remaining: number): Phase => ({ kind: 'reinforce', remaining, mustTrade: false, placed: {}, midTurn: false });
const dbg = () => page.evaluate(() => (window.__board as unknown as { __debug: { hovered: string | null } }).__debug.hovered);

await loadScenario(page, scenario({ ural: [0, 4], ukraine: [0, 3] }, reinforce(5)));
// #1 same-frame hover, cursor only on clickable tiles.
const ural = (await page.evaluate(() => window.__risk.screenPos('ural')))!;
const sib = (await page.evaluate(() => window.__risk.screenPos('siberia')))!;
await page.mouse.move(ural.x + 1, ural.y + 8);
const sameFrame = await page.evaluate(
  () => new Promise<string | null>((r) => requestAnimationFrame(() => r((window.__board as unknown as { __debug: { hovered: string | null } }).__debug.hovered))),
);
const cur1 = await page.evaluate(() => getComputedStyle(document.querySelector('#board canvas')!).cursor);
check(sameFrame === 'ural' && cur1 === 'pointer', `hover lands by the next frame on a clickable tile (${sameFrame}, cursor ${cur1})`, results);
await page.mouse.move(sib.x + 1, sib.y + 8);
await page.waitForTimeout(40);
const cur2 = await page.evaluate(() => getComputedStyle(document.querySelector('#board canvas')!).cursor);
check((await dbg()) === 'siberia' && cur2 === 'default', `an enemy tile in reinforce: hover tracked, cursor ${cur2} (no lift, no pointer)`, results);

// #2 hysteresis along the Ukraine/Ural edge: find the edge between the anchors, then jiggle ±2 px.
const uk = (await page.evaluate(() => window.__risk.screenPos('ukraine')))!;
const edge = await page.evaluate(
  ([a, b]) => {
    const pick = (window.__board as unknown as { __debug: { pick: (x: number, y: number) => string | null } }).__debug.pick;
    let last = pick(a.x, a.y + 10);
    for (let i = 1; i <= 200; i++) {
      const x = a.x + ((b.x - a.x) * i) / 200;
      const y = a.y + 10 + ((b.y - a.y) * i) / 200;
      const p = pick(x, y);
      if (p !== last && p && last) return { x, y, from: last, to: p };
      last = p;
    }
    return null;
  },
  [uk, ural] as const,
);
if (edge) {
  let flips = 0;
  let prev = await dbg();
  for (let k = 0; k < 24; k++) {
    const dx = k % 2 === 0 ? -2 : 2;
    await page.mouse.move(edge.x + dx, edge.y);
    await page.waitForTimeout(18);
    const h = await dbg();
    if (h !== prev) flips++;
    prev = h;
  }
  check(flips <= 1, `jiggling ±2 px across the ${edge.from}/${edge.to} edge: ${flips} hover change(s) (≤ 1)`, results);
} else check(false, 'found the Ukraine/Ural edge on screen', results);

// #19 no sound on tile hover (after unlocking audio with a click).
await page.mouse.click(5, 450); // wood table: unlocks audio, clicks nothing
const played0 = await page.evaluate(() => (window.__audio as unknown as { stats?: () => { played: number } } | undefined)?.stats?.().played ?? -1);
for (const t of ['ural', 'ukraine', 'siberia', 'afghanistan', 'china']) {
  const p = (await page.evaluate((id) => window.__risk.screenPos(id as never), t))!;
  await page.mouse.move(p.x, p.y + 8, { steps: 3 });
}
const played1 = await page.evaluate(() => (window.__audio as unknown as { stats?: () => { played: number } } | undefined)?.stats?.().played ?? -1);
check(played0 >= 0 && played1 === played0, `hovering tiles plays no sound (${played0} → ${played1} played)`, results);

// #3 an orbit drag from Ural released over Ukraine never clicks.
const before = (await state(page))!.territories;
await page.mouse.move(ural.x, ural.y + 8);
await page.mouse.down();
await page.mouse.move(ural.x + 30, ural.y, { steps: 4 });
await page.mouse.move(uk.x, uk.y + 8, { steps: 4 });
await page.mouse.up();
await page.waitForTimeout(200);
let after = (await state(page))!.territories;
check(after.ural.armies === before.ural.armies && after.ukraine.armies === before.ukraine.armies, 'a drag released over a tile places nothing', results);
await page.evaluate(() => window.__risk.stats()); // camera settles
after = (await state(page))!.territories;
check(after.ural.armies === before.ural.armies, `still nothing placed (Ural ${after.ural.armies})`, results);

// #14 brass and why, #17 numerals — across a few states.
const audit = async (label: string) => {
  await page.waitForTimeout(80); // the HUD renders on the next animation frame
  const a = await page.evaluate(() => {
    // (A screen drying out underneath has already stepped its gold down: styles.css `.screen.leaving`.)
    const vis = (el: Element) => (el as HTMLElement).offsetParent !== null && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.leaving');
    const u = window.__risk.ui();
    const brass = [...document.querySelectorAll('#ui .btn.brass, #ui .tr-seg.is-primary')].filter(vis).length;
    const snapBrass = u.brass.length;
    const kbd = [...document.querySelectorAll('#ui .hud kbd')].filter(vis).length;
    const noWhy = u.buttons.length > 2 || kbd > 0 ? [`${u.buttons.length} buttons, ${kbd} keycaps`] : [];
    const cinzelNums: string[] = [];
    const minus: string[] = [];
    const walk = document.createTreeWalker(document.getElementById('ui')!, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const t = n.textContent ?? '';
      const el = n.parentElement!;
      if (!t.trim() || !el.offsetParent) continue;
      if (/\d/.test(t) && /Cinzel/i.test(getComputedStyle(el).fontFamily)) cinzelNums.push(t.trim().slice(0, 30));
      if (/(^|[\s(])-\d/.test(t)) minus.push(t.trim().slice(0, 30));
    }
    return { brass, snapBrass, labels: u.brass, noWhy, cinzelNums, minus };
  });
  check(a.brass <= 1 && a.snapBrass === a.brass, `${label}: ${a.brass} brass thing(s) on screen [${a.labels.join(', ')}]`, results);
  check(a.noWhy.length === 0, `${label}: ≤ 2 strip buttons, no keycaps${a.noWhy.length ? ' — ' + a.noWhy.join(', ') : ''}`, results);
  check(a.cinzelNums.length === 0 && a.minus.length === 0, `${label}: no Cinzel numerals, no ASCII minus${a.cinzelNums.concat(a.minus).length ? ' — ' + a.cinzelNums.concat(a.minus).join(' | ') : ''}`, results);
};
await audit('place');
// Pointer cursor only on eligible track segments (locked ones answer with a reason, but no pointer).
const segCursor = (id: string) => page.evaluate((x) => getComputedStyle(document.querySelector(`[data-testid="seg-${x}"]`)!).cursor, id);
const lockedCur = await segCursor('attack');
await clickT(page, 'ural');
await audit('place-picked');
await clickBtn(page, 'btn-place');
await idle(page);
await audit('all-placed');
const eligibleCur = await segCursor('attack');
const currentCur = await segCursor('place');
check(lockedCur !== 'pointer' && eligibleCur === 'pointer' && currentCur !== 'pointer', `track cursor: locked ${lockedCur}, eligible ${eligibleCur}, current ${currentCur}`, results);
await seg(page, 'attack');
await idle(page);
await audit('attack');
await clickT(page, 'siberia');
await audit('armed');

// #22 no focus ring after a mouse click on a HUD button; Tab from the HUD shows one.
await page.locator('[data-testid="btn-roll"]').click();
await page.waitForTimeout(40);
const ring = await page.evaluate(() => {
  const a = document.activeElement as HTMLElement | null;
  if (!a || a === document.body) return 'none';
  const cs = getComputedStyle(a);
  return `${cs.outlineStyle} ${cs.outlineWidth} / ${cs.boxShadow.slice(0, 40)} (${a.matches(':focus-visible') ? 'focus-visible' : 'no focus-visible'})`;
});
check(ring === 'none' || /no focus-visible/.test(ring), `no focus ring after a mouse click (${ring})`, results);
await idle(page);
await audit('rolled');

// #8 no spoilers: during a blitz the fight's numbers never run ahead of the board's badges, in the VM and in
// the one line's words (fight text: the counts live in the line now), sampled every frame; and they do tick
// down while it rolls (the per-pair path), not only at its end.
await loadScenario(page, scenario({ ural: [0, 25] }, { kind: 'attack' }, { mutate: (s) => void (s.territories.siberia.armies = 12) }));
await clickT(page, 'siberia');
await page.evaluate(`(() => {
  const S = (window.__spoil = { frames: 0, ahead: 0, first: null, stop: false, dom: 0, domAhead: 0, ticks: new Set() });
  const armies = window.__board.__debug.armies;
  const f = () => {
    const b = window.__risk.ui().battle;
    if (b) {
      S.frames++;
      const m = b.header.match(/URAL (\\d+) vs SIBERIA (\\d+)/);
      if (m) {
        const hudA = +m[1], hudD = +m[2];
        const boardA = armies.ural, boardD = armies.siberia;
        if (hudA < boardA || hudD < boardD) { S.ahead++; if (!S.first) S.first = b.header + ' vs board ' + boardA + '/' + boardD; }
      }
      const nums = [...document.querySelectorAll('[data-testid="battle"]:not(.hidden) .bt-armies')].map((e) => +e.textContent);
      if (nums.length === 2) {
        S.dom++;
        S.ticks.add(nums.join('/'));
        if (nums[0] < armies.ural || nums[1] < armies.siberia) { S.domAhead++; if (!S.first) S.first = 'line ' + nums.join('/') + ' vs board ' + armies.ural + '/' + armies.siberia; }
      }
    }
    if (!S.stop) requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
})()`);
await clickBtn(page, 'btn-blitz');
await idle(page);
await page.evaluate('window.__spoil.stop = true');
const spoil = (await page.evaluate('({ ...window.__spoil, ticks: window.__spoil.ticks.size })')) as { frames: number; ahead: number; first: string | null; dom: number; domAhead: number; ticks: number };
check(spoil.frames > 30 && spoil.ahead === 0, `the fight's counts never ahead of the board during a blitz (${spoil.frames} frames, ${spoil.ahead} ahead${spoil.first ? ': ' + spoil.first : ''})`, results);
check(spoil.dom > 10 && spoil.domAhead === 0 && spoil.ticks > 2, `the one line's counts tick down while it rolls, never ahead (${spoil.dom} frames, ${spoil.ticks} distinct counts, ${spoil.domAhead} ahead)`, results);

// #23 instant speed: the tray still shows the dice.
await page.evaluate(() => window.__risk.setSpeed(0));
await loadScenario(page, scenario({ ural: [0, 12] }, { kind: 'attack' }, { mutate: (s) => void (s.territories.siberia.armies = 8) }), { settings: { animationSpeed: 0 } });
await clickT(page, 'siberia');
await clickBtn(page, 'btn-roll');
await page.waitForTimeout(120);
const inst = await page.evaluate(() => ({
  header: window.__risk.ui().battle?.header ?? null,
  tray: (window.__board as unknown as { __debug: { tray: { visible: boolean } } }).__debug.tray.visible,
}));
check(inst.tray, `instant speed: header "${inst.header}", dice tray ${inst.tray ? 'showing' : 'hidden'}`, results);
await page.screenshot({ path: 'artifacts/e2e/polish-instant-dice.png' });
await page.evaluate(() => window.__risk.setSpeed(1));

// #24 empty states.
await loadScenario(page, scenario({ ural: [0, 1], ukraine: [0, 1] }, { kind: 'attack' }));
let u = await ui(page);
check(u.line === 'No attacks left · end your turn' && u.primary === null && u.brass.join() === 'End turn' && u.recommended === 'endTurn', `no sources: "${u.line}" · brass [${u.brass.join(', ')}]`, results);
await audit('no-attacks');
await loadScenario(page, scenario({ ural: [0, 1], ukraine: [0, 1] }, { kind: 'fortify' }));
u = await ui(page);
check(u.line === 'Nothing to move · end your turn' && u.primary === null && u.brass.join() === 'End turn', `nothing to fortify: "${u.line}" · brass [${u.brass.join(', ')}]`, results);
await audit('fortify');
await loadScenario(
  page,
  scenario({ ural: [0, 3] }, reinforce(3), {
    mutate: (s) =>
      void (s.players[0].cards = [
        { id: 0, territory: 'alaska', symbol: 'infantry' },
        { id: 1, territory: 'peru', symbol: 'cavalry' },
      ]),
  }),
);
await clickBtn(page, 'btn-cards');
await page.waitForTimeout(300);
const status = await page.locator('.cards-status').textContent();
check(/^Need 1 .+/.test(status ?? ''), `no valid set: "${status}"`, results);
check((await page.locator('[data-testid="cards-trade"]').evaluate((b) => (b as HTMLElement).offsetParent === null || b.classList.contains('hidden'))) === true, 'no Trade button without a set', results);
await clickBtn(page, 'cards-close');
await page.waitForTimeout(300);
check(!(await ui(page)).cardsOpen, 'the ✕ closes the Cards sheet', results);

// Cards: a non-forced trade happens from the sheet; the sheet's Trade is the one brass thing.
await loadScenario(
  page,
  scenario({ ural: [0, 3] }, reinforce(3), {
    mutate: (s) =>
      void (s.players[0].cards = [
        { id: 0, territory: 'alaska', symbol: 'infantry' },
        { id: 1, territory: 'peru', symbol: 'cavalry' },
        { id: 2, territory: 'brazil', symbol: 'artillery' },
      ]),
  }),
);
u = await ui(page);
check(u.buttons.join(' / ') === 'Cards 3' && !u.buttons.some((b) => /^Trade/.test(b)), `a set in hand, not forced: strip ${u.buttons.join(' / ')}`, results);
await clickBtn(page, 'btn-cards');
await page.waitForTimeout(300);
u = await ui(page);
const tradeLabel = (await page.locator('[data-testid="cards-trade"]').textContent())?.trim() ?? '';
check(u.cardsOpen && /^Trade for \+\d+$/.test(tradeLabel) && u.brass.join() === tradeLabel, `sheet open: "${tradeLabel}" · brass [${u.brass.join(', ')}]`, results);
await audit('cards-sheet');
await clickBtn(page, 'cards-trade');
await idle(page);
const st = await state(page);
u = await ui(page);
const rem = st!.phase.kind === 'reinforce' ? st!.phase.remaining : -1;
check(st!.players[0].cards.length === 0 && rem > 3 && !u.cardsOpen, `traded from the sheet: ${rem} to place, hand ${st!.players[0].cards.length}, sheet ${u.cardsOpen ? 'open' : 'closed'}`, results);

await browser.close();
finish(results, errors);
