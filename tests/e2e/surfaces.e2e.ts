// v3 surfaces (logic lane): the engine's new features on screen, on the real board + HUD.
//   1. The map picker: True World is picked, the game starts on it (through a reload onto its board) and a
//      reload + Continue reopens it on True World (v5.1 D: the picker is folded under More). Personalities
//      default to Any (random and hidden): the strip shows none until that AI has spoken.
//   2–3. Standing (v5.1 C, replaces the truce offer): __risk.standing() has a value for every AI seat, each AI
//      ring carries its seat-standing mark, a hover writes the reason in the one line, a tap on a ring that
//      can be asked offers "Ask X for peace" with a bare Ask word (one gold per sampled frame), and Ask is
//      answered at once: "X agrees · three rounds" or "X refuses · …".
//   4. The strip: an AI's personality word once it has spoken, and its grudge tick ("Holds a grudge against John").
//   5. A 2-player game from the New game screen with Neutral armies on (under More): the grey neutral seat,
//      dimmed, with its count, no cup (v5.1 B: there is no cup at all).
//   6. A new build: the event line's "Update ready · reload" (a mocked controllerchange), and a reload at
//      once off the game.
//   7. True World under stones (?map=true-world) at 1440×900, iphone, iphone-land: no stone over another
//      territory's numeral, no stone over another territory's land; a cap below the 1-army size is reported.
// Screenshots go to artifacts/surfaces/.
import { mkdirSync } from 'node:fs';
import type { Page } from 'playwright';
import { BASE, Q, check, clearStorage, clickBtn, pickMap, finish, idle, loadScenario, open, scenario, state, ui } from './lib';
import { longPress, openDevice, type DeviceName } from './mobile-lib';
import type { GameState } from '../../src/engine';

const OUT = 'artifacts/surfaces';
mkdirSync(OUT, { recursive: true });
const results: string[] = [];
const allErrors: string[] = [];
/** SURF_ONLY=2,5 runs just those sections (by hand); the suite runs them all. */
const only = process.env.SURF_ONLY?.split(',');
const run = (n: string) => !only || only.includes(n);
const shot = (p: Page, name: string) => p.screenshot({ path: `${OUT}/${name}.png` });
const settleUi = (p: Page, ms = 450) => p.waitForTimeout(ms);

/** Visible gold things in the HUD (the ink flow's rule: text, border, fill or brush mark in the gold). */
async function goldThings(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const GOLD = [201, 169, 97];
    const near = (c: string) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return false;
      const [r, g, b, a = '1'] = m[1].split(/[,\s/]+/).filter(Boolean);
      return Math.abs(+r - GOLD[0]) <= 14 && Math.abs(+g - GOLD[1]) <= 14 && Math.abs(+b - GOLD[2]) <= 14 && +a >= 0.35;
    };
    const eff = (el: Element) => {
      let o = 1;
      for (let e: Element | null = el; e; e = e.parentElement) o *= +getComputedStyle(e).opacity;
      return o;
    };
    const found: Element[] = [];
    for (const el of document.querySelectorAll('.ui-root *')) {
      if (el.closest('.st-rule, .lk-rule, .ra-rule, #boot-splash, .leaving')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight) continue;
      if (!(el as HTMLElement).checkVisibility?.({ visibilityProperty: true, opacityProperty: true })) continue;
      const cs = getComputedStyle(el);
      const text = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim()) && near(cs.color);
      const svg = el instanceof SVGElement && !(el instanceof SVGSVGElement) && !el.closest('defs, mask') && (near(cs.fill) || near(cs.stroke));
      const border = ['top', 'right', 'bottom', 'left'].some((k) => parseFloat(cs.getPropertyValue(`border-${k}-width`)) >= 0.5 && cs.getPropertyValue(`border-${k}-style`) !== 'none' && near(cs.getPropertyValue(`border-${k}-color`)));
      if ((text || svg || border || near(cs.backgroundColor)) && eff(el) >= 0.3) found.push(el.closest('button, [data-testid]') ?? el);
    }
    return [...new Set(found)].map((e) => (e as HTMLElement).dataset?.testid ?? e.tagName.toLowerCase());
  });
}

/** Max gold things per frame over `ms`. */
async function goldOver(page: Page, ms: number): Promise<{ max: number; worst: string[] }> {
  let max = 0;
  let worst: string[] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const g = await goldThings(page);
    if (g.length > max) {
      max = g.length;
      worst = g;
    }
    await page.waitForTimeout(40);
  }
  return { max, worst };
}

// ---------------------------------------------------------------------------------------------------------
// 1. The map picker → a game on True World → resume on True World
// ---------------------------------------------------------------------------------------------------------
if (run('1')) {
  const ctx = await open();
  const { page } = ctx;
  await clearStorage(page);
  await page.goto(BASE + Q.replace(/([?&])map=[^&]*&?/, '$1'));
  await page.waitForFunction(() => !!window.__risk);
  check((await page.evaluate(() => window.__risk.map())) === 'classic', 'a fresh page boots on Classic', results);
  await clickBtn(page, 'title-new');
  await settleUi(page, 700);
  // v6 maps: the map is a primary decision, the Where row of ink tiles (John, 2026-10-04)
  check(await page.locator('[data-testid="ng-where"]').isVisible(), 'the Where row of map tiles shows without opening More', results);
  const maps = await page.locator('[data-testid="map-picker"] .map-opt').evaluateAll((els) =>
    els.map((e) => ({
      id: (e as HTMLElement).dataset.map,
      name: e.querySelector('.map-name')?.textContent,
      desc: !!e.querySelector('.map-desc')?.textContent,
      seats: e.querySelector('.map-seats')?.textContent,
      thumb: !!(e.querySelector('img') as HTMLImageElement | null)?.naturalWidth,
      on: e.getAttribute('aria-checked') === 'true',
    })),
  );
  check(
    maps.length >= 2 && maps[0].id === 'classic' && maps[0].on && maps.some((m) => m.id === 'true-world') && maps.every((m) => m.desc && m.thumb),
    `the Where row offers Classic (picked), True World and the rest, each an ink thumbnail and one line (${maps.map((m) => m.id).join(', ')})`,
    results,
  );
  // AI seats: personality 'Any' by default (v5.1 D: random and hidden), each word still titled with its line
  const pers = await page.evaluate(() =>
    [1, 2, 3].map((i) => ({
      on: document.querySelector(`[data-testid="seat-pers-${i}"] .seg-opt.on`)?.textContent,
      line: document.querySelector(`[data-testid="seat-pers-line-${i}"]`)?.textContent,
      title: (document.querySelector(`[data-testid="seat-pers-${i}-warlord"]`) as HTMLElement | null)?.title,
    })),
  );
  check(pers.map((p) => p.on).join(',') === 'Any,Any,Any' && pers.every((p) => !p.line && /Remembers who hurt it/.test(p.title ?? '')), `AI seats default to Any (random, hidden), no line under it (${JSON.stringify(pers)})`, results);
  await pickMap(page, 'true-world');
  await settleUi(page);
  const picked = await page.evaluate(() => ({
    tw: document.querySelector('[data-testid="map-true-world"]')?.getAttribute('aria-checked'),
    ul: getComputedStyle(document.querySelector('[data-testid="map-true-world"] .map-ul')!).opacity,
  }));
  check(picked.tw === 'true' && +picked.ul > 0.9, `True World picked: its name carries the brush underline (${JSON.stringify(picked)})`, results);
  await shot(page, 'newgame-1440x900');
  // House rules (v5.1 D: in the fold, off by default; no Truces switch: standing is the game, not a rule)
  const house = await page.evaluate(() => ({
    neutral: document.querySelector('[data-testid="house-neutral"]')?.getAttribute('aria-checked'),
    neutralNa: document.querySelector('[data-testid="house-neutral"]')?.classList.contains('na'),
    truces: document.querySelectorAll('[data-testid="house-truces"]').length,
  }));
  check(house.neutral === 'false' && house.neutralNa === true && house.truces === 0, `house rules: Neutral armies off (dimmed: 4 seats), no Truces switch (${JSON.stringify(house)})`, results);
  // (a plain scrollIntoView: Playwright's stability wait stalls on the sheet while the Where row's snap scroll settles)
  await page.evaluate(() => document.querySelector('[data-testid="house-seed"]')?.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  await shot(page, 'newgame-house-1440x900');
  // Start: the page reloads onto True World and deals the game there
  await Promise.all([page.waitForEvent('framenavigated', { timeout: 15000 }), clickBtn(page, 'ng-start')]);
  await page.waitForFunction(() => !!window.__risk && window.__risk.ui().screen === 'game' && !!window.__risk.getState(), null, { timeout: 20000 });
  await idle(page, 60000);
  const s1 = (await state(page))!;
  const booted1 = await page.evaluate(() => window.__risk.map());
  check(s1.config.mapId === 'true-world' && booted1 === 'true-world' && s1.config.diplomacy === true, `Start on True World: the page reloaded onto it (board ${booted1}, game ${s1.config.mapId}, diplomacy ${s1.config.diplomacy})`, results);
  // an AI seat's personality in the strip, in small caps under its name
  const strip = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.seat-chip')].map((c) => ({
      name: c.querySelector('.sc-name')?.textContent,
      // v5: an AI's voice line replaces its personality word for a turn
      pers: c.querySelector('.sc-pers:not(.hidden)')?.textContent ?? (c.querySelector('.sc-voice:not(.hidden)')?.textContent ? 'voice' : null),
      caps: getComputedStyle(c.querySelector('.sc-pers')!).fontVariantCaps,
      title: c.title,
    })),
  );
  // v5.1 D: a personality shows only once that AI has spoken (its first voice line reveals it)
  const known = await page.evaluate(() => (window.__risk as unknown as { standing(): { seat: number; personality: string | null }[] }).standing());
  check(
    strip[0].pers === null && strip.slice(1).every((c, i) => c.pers === 'voice' || (c.pers || null) === (known[i + 1]?.personality ?? null)),
    `the strip: an AI's personality only once it has spoken (${strip.map((c, i) => `${c.name}:${c.pers ?? '-'}/${known[i]?.personality ?? '-'}`).join(' ')})`,
    results,
  );
  await page.waitForTimeout(1800); // the turn banner dries
  await shot(page, 'true-world-rest-1440x900');
  // resume: reload, Continue → True World again
  await page.reload();
  await page.waitForFunction(() => !!window.__risk);
  const bootedAfter = await page.evaluate(() => window.__risk.map());
  await clickBtn(page, 'title-continue');
  await page.waitForFunction(() => window.__risk.ui().screen === 'game' && !!window.__risk.getState(), null, { timeout: 10000 });
  const s2 = (await state(page))!;
  check(bootedAfter === 'true-world' && s2.id === s1.id && s2.config.mapId === 'true-world', `a reload boots True World from the save and Continue resumes the same game on it (${bootedAfter}, ${s2.id === s1.id ? 'same game' : 'another game'})`, results);
  allErrors.push(...ctx.errors);
  await ctx.browser.close();
}

// the New game screen at phone-landscape size: the picker and the personalities fit the one column
if (run('1')) {
  const ctx = await openDevice('iphone-land');
  const { page } = ctx;
  await clearStorage(page);
  await page.reload();
  await page.waitForFunction(() => !!window.__risk);
  await page.locator('[data-testid="title-new"]').tap();
  await settleUi(page, 700);
  const seen = await page.evaluate(() => ({
    maps: document.querySelectorAll('[data-testid="map-picker"] .map-opt').length,
    pers: [1, 2, 3].map((i) => document.querySelector(`[data-testid="seat-pers-${i}"] .seg-opt.on`)?.textContent).join(','),
  }));
  check(seen.maps >= 2 && seen.pers === 'Any,Any,Any', `iphone-land New game: the map picker and each AI's personality (${JSON.stringify(seen)})`, results);
  await shot(page, 'newgame-iphone-land');
  await page.locator('[data-testid="ng-more"]').tap();
  await settleUi(page, 500);
  await page.locator('[data-testid="seat-pers-1"]').scrollIntoViewIfNeeded();
  await shot(page, 'newgame-iphone-land-seats');
  allErrors.push(...ctx.errors);
  await ctx.browser.close();
}

// ---------------------------------------------------------------------------------------------------------
// 2–3. Standing on screen (v5.1 C: replaces the truce offer; Classic, 1440×900 and iphone-land)
// ---------------------------------------------------------------------------------------------------------
/** John's turn (Place), his big stacks on Cobalt's, Amber's and Emerald's borders. */
function standingBoard(): GameState {
  return scenario(
    { ural: [0, 12], ukraine: [0, 12], afghanistan: [0, 10], middle_east: [0, 9], siberia: [1, 1], china: [1, 1], india: [1, 1] },
    { kind: 'reinforce', remaining: 3, mustTrade: false, placed: {}, midTurn: false },
    {
      fill: (_t, i) => [1 + (i % 3), 1],
      mutate: (st) => {
        st.config = { ...st.config, diplomacy: true };
        st.players[1].personality = 'turtle';
      },
    },
  );
}
type StandingRow = { seat: number; name: string; kind: string; standing: string | null; reason: string | null; canAskPeace: boolean; understandingWith: number[] };
const standingOf = (page: Page) => page.evaluate(() => (window.__risk as unknown as { standing(): StandingRow[] }).standing()) as Promise<StandingRow[]>;
const lineText = (page: Page) => page.evaluate(() => document.querySelector('[data-testid="line"]')?.textContent?.trim() ?? '');
const STANDINGS = ['ally', 'even', 'wary', 'hostile'];

if (run('2')) {
  const ctx = await open();
  const { page } = ctx;
  await loadScenario(page, standingBoard());
  await page.waitForTimeout(1700); // the turn banner dries
  const st = await standingOf(page);
  const ais = st.filter((r) => r.kind === 'ai');
  check(
    ais.length === 3 && ais.every((r) => STANDINGS.includes(r.standing ?? '') && !!r.reason) && st.filter((r) => r.kind === 'human').every((r) => r.standing === null),
    `__risk.standing(): a value and a reason for every AI seat (${ais.map((r) => `${r.name} ${r.standing}`).join(' · ')})`,
    results,
  );
  const marks = await page.evaluate(() =>
    [1, 2, 3].map((i) => {
      const m = document.querySelector(`[data-testid="seat-standing-${i}"]`);
      return m ? ([...m.classList].find((c) => c.startsWith('st-')) ?? 'mark') : null;
    }),
  );
  const johnMark = await page.locator('[data-testid="seat-standing-0"]').isVisible().catch(() => false);
  check(marks.every((m, i) => m === `st-${ais[i].standing}`) && !johnMark, `each AI ring carries its standing mark, John's none shown (${marks.join(', ')})`, results);
  // a hover over a ring writes its reason in the one line; leaving puts it away
  const who = ais.find((r) => r.canAskPeace) ?? ais[0];
  const ring = page.locator(`[data-testid="seat-${who.seat}"]`);
  const box = (await ring.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction((r) => window.__risk.ui().line === r, who.reason, { timeout: 2000 }).catch(() => undefined);
  let u = await ui(page);
  check(u.line === who.reason, `hover on ${who.name}'s ring: the line says "${u.line}" (reason "${who.reason}")`, results);
  await page.mouse.move(720, 500);
  await page.waitForFunction((r) => window.__risk.ui().line !== r, who.reason, { timeout: 2000 }).catch(() => undefined);
  u = await ui(page);
  check(u.line !== who.reason, `leaving the ring puts the reason away ("${u.line}")`, results);
  await shot(page, 'standing-marks-1440x900');
  // a tap on a ring that can be asked: "Ask X for peace" in the line, a bare Ask word
  check(ais.some((r) => r.canAskPeace), `on John's turn some AI can be asked (${ais.filter((r) => r.canAskPeace).map((r) => r.name).join(', ') || 'none'})`, results);
  await ring.click();
  const ask = `Ask ${who.name} for peace`;
  await page.mouse.move(720, 500);
  await page.waitForFunction((t) => (document.querySelector('[data-testid="line"]')?.textContent ?? '').includes(t), ask, { timeout: 2000 }).catch(() => undefined);
  const askBtn = page.locator('[data-testid="btn-askPeace"]');
  const bare = await askBtn.evaluate((b) => !b.classList.contains('gold') && (b.textContent ?? '').trim() === 'Ask').catch(() => false);
  check((await lineText(page)).includes(ask) && (await askBtn.isVisible()) && bare, `a tap on ${who.name}'s ring: "${await lineText(page)}" and a bare "Ask" word`, results);
  const g = await goldOver(page, 1000);
  check(g.max === 1, `one gold at a time while Ask waits: max ${g.max} per frame (${g.worst.join(', ')})`, results);
  await shot(page, 'standing-ask-1440x900');
  // Ask: answered at once, in one sentence
  const n0 = (await page.evaluate(() => window.__risk.ledger())).length;
  await askBtn.click();
  await page.waitForFunction((n) => window.__risk.ledger().length > n, n0, { timeout: 3000 }).catch(() => undefined);
  u = await ui(page);
  const answer = new RegExp(`^${who.name} (agrees · three rounds|refuses( · .+)?)$`);
  check(answer.test(u.line), `Ask is answered at once: "${u.line}"`, results);
  const lines = await page.evaluate(() => window.__risk.ledger().filter((l) => l.kind === 'truce').map((l) => l.text));
  const after = (await standingOf(page)).find((r) => r.seat === who.seat)!;
  const agreed = /agrees/.test(u.line);
  check(
    lines.some((l) => l.startsWith(`${who.name} ${agreed ? 'agrees' : 'refuses'}`)) && !after.canAskPeace && (!agreed || after.standing === 'ally'),
    `the ledger keeps the answer ("${lines[lines.length - 1]}"); ${who.name} is now ${after.standing}, can be asked again: ${after.canAskPeace}`,
    results,
  );
  check(
    !(await askBtn.isVisible()) && (await page.locator('[data-testid="btn-truce"], [data-testid="btn-acceptTruce"], [data-testid="btn-declineTruce"]').count()) === 0,
    'no Ask word left, and no Truce / Accept / Decline anywhere',
    results,
  );
  allErrors.push(...ctx.errors);
  await ctx.browser.close();
}

// the same marks at phone-landscape size: a long-press on a ring writes the reason
if (run('2')) {
  const ctx = await openDevice('iphone-land');
  const { page } = ctx;
  await loadScenario(page, standingBoard());
  await page.waitForTimeout(1700);
  const st = (await standingOf(page)).filter((r) => r.kind === 'ai');
  const marks = await page.locator('[data-testid^="seat-standing-"]:not(.hidden)').count();
  check(marks === st.length && st.every((r) => STANDINGS.includes(r.standing ?? '')), `iphone-land: a standing mark on each AI ring (${marks} marks; ${st.map((r) => r.standing).join(', ')})`, results);
  const box = (await page.locator(`[data-testid="seat-${st[0].seat}"]`).boundingBox())!;
  const said = await longPress(ctx, box.x + box.width / 2, box.y + box.height / 2, 800, async () => {
    await page.waitForFunction((r) => window.__risk.ui().line === r, st[0].reason, { timeout: 1500 }).catch(() => undefined);
    return (await ui(page)).line;
  });
  check(said === st[0].reason, `iphone-land: a long-press on ${st[0].name}'s ring writes "${said}"`, results);
  await shot(page, 'standing-iphone-land');
  allErrors.push(...ctx.errors);
  await ctx.browser.close();
}

// ---------------------------------------------------------------------------------------------------------
// 4. The strip: a personality word and a grudge tick
// ---------------------------------------------------------------------------------------------------------
for (const form of run('4') ? (['1440x900', 'iphone-land'] as const) : []) {
  const ctx = form === '1440x900' ? await open() : await openDevice(form);
  const { page } = ctx;
  const s = scenario({ ural: [0, 9], siberia: [1, 4] }, { kind: 'attack' }, {
    mutate: (st) => {
      st.players[1].personality = 'warlord';
      st.players[2].personality = 'turtle';
      st.players[3].personality = 'opportunist';
      st.players[1].grudges = { 0: 3.2, 2: 1 };
      st.players[3].grudges = { 0: 1.4 };
    },
  });
  await loadScenario(page, s);
  await page.waitForTimeout(1700);
  // v5.1 D: personalities are hidden until that AI has spoken: none of the three has yet
  const hidden = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.seat-chip')].slice(1).map((c) => {
      const p = c.querySelector<HTMLElement>('.sc-pers');
      return p && getComputedStyle(p).display !== 'none' && !p.classList.contains('hidden') ? p.textContent || null : null;
    }),
  );
  check(hidden.every((p) => !p), `${form}: no AI personality shown before it has spoken (${hidden.join(', ')})`, results);
  // each has spoken (the UI meta's revealed seats, as its first voice line writes them): written before the
  // page boots on the next load (once), then resume
  await page.addInitScript((id) => {
    if (sessionStorage.getItem('surf.revealed')) return;
    sessionStorage.setItem('surf.revealed', '1');
    const k = 'risk3d.ui.v1';
    const ui = JSON.parse(localStorage.getItem(k) ?? '{}');
    ui.game = { ...(ui.game ?? {}), id, revealed: [1, 2, 3] };
    localStorage.setItem(k, JSON.stringify(ui));
  }, s.id);
  await page.reload();
  await page.waitForFunction(() => !!window.__risk);
  await page.locator('[data-testid="title-continue"]').click();
  await page.waitForFunction(() => window.__risk.ui().screen === 'game' && !!window.__risk.getState());
  await idle(page);
  await page.waitForTimeout(1700);
  const marks = await page.evaluate(() => {
    const g = document.querySelector<HTMLElement>('[data-testid="seat-grudge-1"]');
    return {
      grudge: g ? { title: g.title, color: getComputedStyle(g).color, against: g.dataset.against } : null,
      others: document.querySelectorAll('.sc-grudge').length,
      pers: [...document.querySelectorAll<HTMLElement>('.seat-chip')].map((c) => (c.querySelector('.sc-pers') && getComputedStyle(c.querySelector('.sc-pers')!).display !== 'none' ? c.querySelector('.sc-pers')!.textContent : null)),
      titles: [...document.querySelectorAll<HTMLElement>('.seat-chip')].map((c) => c.title),
    };
  });
  const john = 'rgb(195, 155, 140)'; // Vermilion's light
  if (form === '1440x900') {
    check(!!marks.grudge && marks.grudge.title === 'Holds a grudge against John' && marks.grudge.color === john && marks.others === 1, `Cobalt (grudge 3.2 against John) has one brush tick in John's colour, "${marks.grudge?.title}"; Emerald's 1.4 shows nothing (${JSON.stringify(marks.grudge)})`, results);
    check(marks.pers.slice(1).join(',') === 'Warlord,Turtle,Opportunist', `once spoken, each AI's personality word under its name (${marks.pers.join(', ')})`, results);
  } else {
    check(marks.pers.every((p) => p === null) && /^Warlord · /.test(marks.titles[1]), `phones: no personality words on the strip, the title carries it ("${marks.titles[1]}")`, results);
  }
  await shot(page, `strip-personality-grudge-${form}`);
  if (form === '1440x900') await page.screenshot({ path: `${OUT}/strip-personality-grudge-closeup.png`, clip: { x: 0, y: 0, width: 760, height: 90 } });
  allErrors.push(...ctx.errors);
  await ctx.browser.close();
}

// ---------------------------------------------------------------------------------------------------------
// 5. A 2-player game from the New game screen: the grey neutral seat
// ---------------------------------------------------------------------------------------------------------
for (const form of run('5') ? (['1440x900', 'iphone-land'] as const) : []) {
  const ctx = form === '1440x900' ? await open() : await openDevice(form);
  const { page } = ctx;
  await clearStorage(page);
  await page.reload();
  await page.waitForFunction(() => !!window.__risk);
  if (form === '1440x900') {
    await clickBtn(page, 'title-new');
    await settleUi(page, 500);
    await clickBtn(page, 'seat-remove-3');
    await clickBtn(page, 'seat-remove-2');
    await settleUi(page, 300);
    // v5.1 D: Neutral armies is a house rule under More, off by default
    await clickBtn(page, 'ng-more');
    await settleUi(page, 300);
    await clickBtn(page, 'house-neutral');
    await page.waitForFunction(() => document.querySelector('[data-testid="house-neutral"]')?.getAttribute('aria-checked') === 'true', null, { timeout: 2000 });
    await clickBtn(page, 'ng-start');
  } else {
    // (the phone New game is covered by mobile-flow; start the same 2-player table through the hook)
    await page.evaluate(() => window.__risk.newGame({ players: [{ name: 'Vermilion', color: 'crimson', kind: 'human' }, { name: 'Slate', color: 'cobalt', kind: 'ai', difficulty: 'normal', personality: 'turtle' }] as never, neutral: true }));
  }
  await page.waitForFunction(() => window.__risk.ui().screen === 'game' && !!window.__risk.getState(), null, { timeout: 20000 });
  await idle(page, 60000);
  await page.waitForTimeout(1800);
  const s = (await state(page))!;
  const n = s.players.find((p) => p.neutral);
  const seat = await page.evaluate(() => {
    const c = document.querySelector<HTMLElement>('.seat-chip.neutral');
    const cups = document.querySelectorAll('[data-testid="cup"], .cup-body').length;
    return c
      ? {
          name: c.querySelector('.sc-name')?.textContent,
          terr: c.querySelector('.sc-terr')?.textContent,
          opacity: +getComputedStyle(c).opacity,
          current: c.classList.contains('current'),
          cups,
        }
      : null;
  });
  const grey = (s.territories as Record<string, { owner: number }>);
  const neutralTiles = Object.values(grey).filter((t) => t.owner === n?.id).length;
  // Dealt 14; by the time the strip is read the AI may already have taken one or two, so accept 1–14.
  check(!!n && (n.color as string) === 'neutral' && n.name === 'Neutral' && neutralTiles >= 1 && neutralTiles <= 14, `${form}: a 2-player game deals the grey neutral seat (${n?.name}, ${n?.color}, ${neutralTiles} territories)`, results);
  check(!!seat && seat.name === 'Neutral' && seat.terr === String(neutralTiles) && Math.abs(seat.opacity - 0.6) < 0.01 && !seat.current && seat.cups === 0, `${form}: its ring keeps its count, dimmed, never current, no cup anywhere (${JSON.stringify(seat)})`, results);
  await shot(page, `neutral-2p-${form}`);
  allErrors.push(...ctx.errors);
  await ctx.browser.close();
}

// ---------------------------------------------------------------------------------------------------------
// 6. A new build takes over (a mocked controllerchange)
// ---------------------------------------------------------------------------------------------------------
if (run('6')) {
  const ctx = await open();
  const { page } = ctx;
  await loadScenario(page, scenario({ ural: [0, 5] }, { kind: 'attack' }));
  // (no worker controls an e2e page, so the first change is the "first install" the controller ignores)
  const fire = () => page.evaluate(() => navigator.serviceWorker.dispatchEvent(new Event('controllerchange')));
  await fire();
  await fire();
  await settleUi(page, 300);
  const upd = await page.evaluate(() => document.querySelector('[data-testid="update-ready"]')?.textContent ?? null);
  check(upd === 'Update ready · reload', `in a game: the event line says "${upd}"`, results);
  await shot(page, 'update-ready-1440x900');
  const id0 = (await state(page))!.id;
  await Promise.all([page.waitForEvent('framenavigated', { timeout: 10000 }), clickBtn(page, 'update-ready')]);
  await page.waitForFunction(() => !!window.__risk);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('risk3d.save.v1') ?? 'null')?.state?.id ?? null);
  check(saved === id0 && (await ui(page)).screen === 'title', `a tap saved and reloaded (the save is the same game: ${saved === id0})`, results);
  // off the game: reload at once
  let navigated = false;
  page.once('framenavigated', () => (navigated = true));
  await fire();
  await fire();
  await page.waitForTimeout(1500);
  check(navigated, 'on the title screen a new build reloads at once', results);
  allErrors.push(...ctx.errors);
  await ctx.browser.close();
}

// ---------------------------------------------------------------------------------------------------------
// 7. True World under stones: numerals and land, three form factors
// ---------------------------------------------------------------------------------------------------------
if (run('7')) {
  const tall = scenario({}, { kind: 'attack' }, { fill: (_t, i) => [1 + (i % 3), 30] });
  const mixed = scenario({}, { kind: 'attack' }, { fill: (_t, i) => [1 + (i % 3), i % 2 ? 1 : 40] });
  for (const form of ['1440x900', 'iphone', 'iphone-land'] as const) {
    const q = `${Q.includes('?') ? `${Q}&` : '?'}map=true-world`.replace('??', '?');
    const ctx = form === '1440x900' ? await open(q) : await openDevice(form as DeviceName, { query: q });
    const { page } = ctx;
    const numerals: string[] = [];
    /** Pairs the renderer's cap fit itself reports still overlapping at the floor (every lever spent). */
    const tangled: string[] = [];
    const land: string[] = [];
    let floored: string[] = [];
    for (const s of [tall, mixed]) {
      await loadScenario(page, s);
      await page.waitForTimeout(300);
      // In the page: every stone as drawn (its body box, its diameter at home), every other territory's
      // coast projected through the home camera; a coast point inside a stone (1.5 px in from its painted
      // rim) is a stone over that territory's land.
      const r = await page.evaluate(() => {
        type V = { x: number; y: number; z: number; clone(): V; copy(v: V): V; project(c: unknown): V };
        type Tile = { id: string; anchor: [number, number]; anchorW: V; bbox: [number, number, number, number]; rings: [number, number][][] };
        const d = (window as unknown as { __board: { __debug: { rig: { homeCamera(): unknown }; canvas: HTMLCanvasElement; overlay: { pieceRects: (id: string) => { box: number[] } | null }; tiles: { list: Tile[] }; tokens: { stoneOf: (id: string) => { n: number; dPx: number; capPx: number }; dminPx: number; sizeScale: number } } } }).__board.__debug;
        const cam = d.rig.homeCamera();
        const cr = d.canvas.getBoundingClientRect();
        const t0 = d.tiles.list[0];
        const hw = t0.anchor[0] - t0.anchorW.x; // board half-width (toWorld: x − W/2)
        const hh = t0.anchorW.z + t0.anchor[1]; // board half-height (toWorld: H/2 − y)
        const v = t0.anchorW.clone();
        const proj = (bx: number, by: number) => {
          v.copy(t0.anchorW);
          v.x = bx - hw;
          v.z = hh - by;
          v.project(cam);
          return [cr.left + ((v.x + 1) / 2) * cr.width, cr.top + ((1 - v.y) / 2) * cr.height];
        };
        const nums = new Map<string, DOMRect>();
        document.querySelectorAll<HTMLElement>('.rb-badge').forEach((b) => {
          if (b.style.visibility !== 'hidden') nums.set(b.dataset.t!, b.getBoundingClientRect());
        });
        const over: string[] = [];
        const land: string[] = [];
        const floored: string[] = [];
        const dmin = d.tokens.dminPx * d.tokens.sizeScale;
        // (the table flow's rules, v3 icons: a piece = its stone and figure (pieceRects().fig); its numeral
        // sits at the stone's edge. Overlaps over 2 px² count.)
        const ov = (a: number[], b: number[]) => {
          const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
          const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
          return w > 0 && h > 0 && w * h > 2 ? `${Math.round(w)}×${Math.round(h)}` : '';
        };
        const numBox = new Map([...nums].map(([k, r]) => [k, [r.left, r.top, r.right, r.bottom]]));
        const piece = new Map<string, number[]>();
        for (const t of d.tiles.list) {
          const pr = d.overlay.pieceRects(t.id) as { fig: number[] } | null;
          if (pr) piece.set(t.id, [pr.fig[0] + cr.left, pr.fig[1] + cr.top, pr.fig[2] + cr.left, pr.fig[3] + cr.top]);
        }
        for (const [id, a] of piece)
          for (const [o, b] of numBox) {
            if (o === id) continue;
            const x = ov(a, b);
            if (x) over.push(`${id}'s piece over ${o}'s numeral (${x})`);
          }
        for (const [id, a] of numBox)
          for (const [o, b] of numBox) {
            if (o <= id) continue;
            const x = ov(a, b);
            if (x) over.push(`${id}'s numeral on ${o}'s (${x})`);
          }
        for (const t of d.tiles.list) {
          if (!piece.has(t.id)) continue;
          const st = d.tokens.stoneOf(t.id);
          const isFloor = st.capPx <= dmin + 1e-6;
          if (isFloor) floored.push(t.id);
          // the stone lies flat at its anchor
          const [cx, cy] = proj(t.anchor[0], t.anchor[1]);
          const rr = Math.max(0, st.dPx / 2 - 1.5);
          let hit: string | null = null;
          for (const o of d.tiles.list) {
            if (o.id === t.id || hit) continue;
            const [bx0, by0, bx1, by1] = o.bbox;
            const gap = Math.max(bx0 - t.anchor[0], 0, t.anchor[0] - bx1, by0 - t.anchor[1], 0, t.anchor[1] - by1);
            if (gap > 4) continue;
            for (const ring of o.rings) {
              for (let i = 0; i < ring.length && !hit; i++) {
                const a = ring[i];
                const b = ring[(i + 1) % ring.length];
                for (const k of [0, 0.5]) {
                  const [sx, sy] = proj(a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k);
                  if (Math.hypot(sx - cx, sy - cy) < rr) {
                    hit = o.id;
                    break;
                  }
                }
              }
            }
          }
          if (hit) land.push(`${t.id}'s stone over ${hit}'s land${isFloor ? ' (at the 1-army floor)' : ''}`);
        }
        return { over, land, floored, tangled: (d as unknown as { capsTangled: string[] }).capsTangled ?? [] };
      });
      numerals.push(...r.over);
      tangled.push(...r.tangled);
      land.push(...r.land);
      floored = r.floored;
    }
    const uniq = [...new Set(land)];
    // A sliver (≤ 4 px², e.g. 1×3) is reported, not failed (the drawn boxes snap to the device grid);
    // anything larger fails.
    const area = (x: string) => {
      const m = /\((\d+)×(\d+)\)/.exec(x);
      return m ? +m[1] * +m[2] : 99;
    };
    // An overlap between a pair the renderer reports as tangled at the floor is the pack's density at this size
    // (reported, a Maps / Board matter); any other overlap means the cap fit misjudged a part: that fails.
    const pairOf = (x: string) => (/^(\w+)'s (?:piece over|numeral on) (\w+)'s/.exec(x) ?? []).slice(1, 3).sort().join('/');
    const known = new Set(tangled.map((p) => p.split('/').sort().join('/')));
    const admitted = [...new Set(numerals.filter((x) => known.has(pairOf(x))))];
    const rest = numerals.filter((x) => !known.has(pairOf(x)));
    const slivers = [...new Set(rest.filter((x) => area(x) <= 4))];
    const bad = rest.filter((x) => area(x) > 4);
    check(bad.length === 0, `True World ${form}: no piece (stone + figure) or numeral covers another territory's numeral, outside the pairs the cap fit reports tangled${bad.length ? ` — ${bad.slice(0, 5).join('; ')}` : ''}`, results);
    if (admitted.length) console.log(`   NOTE True World ${form}: tangled at the 1-army floor (the renderer says so; anchors too close at this size): ${[...known].join(', ')} — ${admitted.join('; ')}`);
    if (slivers.length) console.log(`   NOTE True World ${form}: slivers (≤ 4 px²): ${slivers.join('; ')}`);
    // v4 (decision Q9): a strong stone may cross a neighbour's border; covering a numeral is the gate (table flow). Reported, not gated.
    results.push(`True World ${form}: stones crossing another territory's land (allowed in v4): ${uniq.filter((l) => !l.includes('1-army floor')).length}${uniq.length ? ` — ${uniq.slice(0, 4).join('; ')}` : ''}`);
    console.log(`   True World ${form}: stones held at the 1-army floor (their cap wanted less): ${floored.length ? floored.join(', ') : 'none'}${uniq.some((l) => l.includes('floor')) ? `; floor stones that still touch a neighbour's land: ${uniq.filter((l) => l.includes('floor')).join('; ')}` : ''}`);
    await loadScenario(page, scenario({ ural: [0, 19], ukraine: [0, 6], siberia: [1, 12], china: [2, 5], india: [0, 25], peru: [0, 1], brazil: [1, 8], egypt: [3, 14] }, { kind: 'attack' }));
    await page.waitForTimeout(1800);
    await shot(page, `true-world-stones-${form}`);
    allErrors.push(...ctx.errors);
    await ctx.browser.close();
  }
}

finish(results, allErrors);
