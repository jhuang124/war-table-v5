// v3 surfaces (logic lane): the engine's new features on screen, on the real board + HUD.
//   1. The map picker: True World is picked, the game starts on it (through a reload onto its board) and a
//      reload + Continue reopens it on True World. An AI seat shows its personality in the strip.
//   2. A scripted AI → human proposal: the AI's truce sentence lands in the ledger; on John's turn the line is
//      that sentence and the dock says Decline / Accept, Accept holding the one gold (sampled per frame, the
//      track's underline yields); Accept answers it and the ledger says so.
//   3. John's own offer: `Truce` in Attack lights the rings that can take one; a tap on a lit ring proposes.
//   4. The strip: an AI's personality word and its grudge tick ("Holds a grudge against John").
//   5. A 2-player game from the New game screen: the grey neutral seat, dimmed, with its count, no cup.
//   6. A new build: the event line's "Update ready · reload" (a mocked controllerchange), and a reload at
//      once off the game.
//   7. True World under stones (?map=true-world) at 1440×900, iphone, iphone-land: no stone over another
//      territory's numeral, no stone over another territory's land; a cap below the 1-army size is reported.
// Screenshots go to artifacts/surfaces/.
import { mkdirSync } from 'node:fs';
import type { Page } from 'playwright';
import { BASE, Q, check, clearStorage, clickBtn, finish, idle, loadScenario, open, place, rendered, scenario, seg, state, ui } from './lib';
import { openDevice, type DeviceName } from './mobile-lib';
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
    maps.length === 2 && maps[0].id === 'classic' && maps[0].on && maps[1].id === 'true-world' && maps.every((m) => m.desc && m.thumb && m.seats === '2–4 players'),
    `the picker offers Classic (picked) and True World, each a thumbnail, a line and its seats (${JSON.stringify(maps)})`,
    results,
  );
  // AI seats: three different personalities by default, each word titled with its line
  const pers = await page.evaluate(() =>
    [1, 2, 3].map((i) => ({
      on: document.querySelector(`[data-testid="seat-pers-${i}"] .seg-opt.on`)?.textContent,
      line: document.querySelector(`[data-testid="seat-pers-line-${i}"]`)?.textContent,
      title: (document.querySelector(`[data-testid="seat-pers-${i}-warlord"]`) as HTMLElement | null)?.title,
    })),
  );
  check(pers.map((p) => p.on).join(',') === 'Turtle,Opportunist,Warlord' && pers.every((p) => !!p.line && /Remembers who hurt it/.test(p.title ?? '')), `AI seats default to Turtle, Opportunist, Warlord, the chosen line under each (${JSON.stringify(pers)})`, results);
  await clickBtn(page, 'map-true-world');
  await settleUi(page);
  const picked = await page.evaluate(() => ({
    tw: document.querySelector('[data-testid="map-true-world"]')?.getAttribute('aria-checked'),
    ul: getComputedStyle(document.querySelector('[data-testid="map-true-world"] .map-ul')!).opacity,
  }));
  check(picked.tw === 'true' && +picked.ul > 0.9, `True World picked: its name carries the brush underline (${JSON.stringify(picked)})`, results);
  await shot(page, 'newgame-1440x900');
  // House rules: Neutral armies and Truces, both on
  await clickBtn(page, 'house-toggle');
  await settleUi(page, 400);
  const house = await page.evaluate(() => ({
    neutral: document.querySelector('[data-testid="house-neutral"]')?.getAttribute('aria-checked'),
    neutralNa: document.querySelector('[data-testid="house-neutral"]')?.classList.contains('na'),
    truces: document.querySelector('[data-testid="house-truces"]')?.getAttribute('aria-checked'),
  }));
  check(house.neutral === 'true' && house.neutralNa === true && house.truces === 'true', `house rules: Neutral armies on (dimmed: 4 seats) and Truces on (${JSON.stringify(house)})`, results);
  await page.locator('[data-testid="house-truces"]').scrollIntoViewIfNeeded();
  await shot(page, 'newgame-house-1440x900');
  await clickBtn(page, 'house-toggle');
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
  check(
    strip[0].pers === null && strip.slice(1).every((c, i) => c.pers === ['Turtle', 'Opportunist', 'Warlord'][i] || c.pers === 'voice') && /Keeps its word/.test(strip[1].title),
    `the strip: each AI's personality under its name (v4: 14 px italic), its line as the title (${strip.map((c) => `${c.name}:${c.pers}`).join(' ')})`,
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
  check(seen.maps === 2 && seen.pers === 'Turtle,Opportunist,Warlord', `iphone-land New game: the map picker and each AI's personality (${JSON.stringify(seen)})`, results);
  await shot(page, 'newgame-iphone-land');
  await page.locator('[data-testid="seat-pers-1"]').scrollIntoViewIfNeeded();
  await shot(page, 'newgame-iphone-land-seats');
  allErrors.push(...ctx.errors);
  await ctx.browser.close();
}

// ---------------------------------------------------------------------------------------------------------
// 2–4. Diplomacy on screen (Classic, 1440×900)
// ---------------------------------------------------------------------------------------------------------
/**
 * A board where Cobalt (seat 1, an AI Turtle) faces John's big stacks on its border and is the one to move:
 * its truce logic offers John a truce at the start of its turn (John is the only threat it can ask). Amber
 * and Emerald stay classic AIs (they never propose, and always decline).
 */
function offerBoard(): GameState {
  const s = scenario(
    { ural: [0, 12], ukraine: [0, 12], afghanistan: [0, 10], middle_east: [0, 9], siberia: [1, 1], china: [1, 1], india: [1, 1] },
    { kind: 'reinforce', remaining: 3, mustTrade: false, placed: {}, midTurn: false },
    {
      fill: (_t, i) => [1 + (i % 3), 1],
      mutate: (st) => {
        st.config = { ...st.config, diplomacy: true };
        st.players[1].personality = 'turtle';
        st.currentPlayer = 1;
        st.firstPlayer = 1;
      },
    },
  );
  return s;
}

if (run('2')) {
  const ctx = await open();
  const { page } = ctx;
  const s0 = offerBoard();
  await loadScenario(page, s0, { waitIdle: false });
  // the AI turns play (instant), then John's turn opens
  await page.waitForFunction(() => {
    const s = window.__risk.getState();
    return !!s && s.currentPlayer === 0 && s.turn > 5 && window.__risk.isIdle();
  }, null, { timeout: 30000 });
  await rendered(page);
  const ledger = await page.evaluate(() => window.__risk.ledger());
  const proposed = ledger.find((l) => l.kind === 'truce' && /^Cobalt proposes a truce with John · \d rounds?( · .+)?$/.test(l.text));
  check(!!proposed, `the AI proposed: "${proposed?.text ?? (ledger.filter((l) => l.kind === 'truce').map((l) => l.text).join(' | ') || 'no truce line')}" is in the ledger`, results);
  await page.waitForTimeout(1700); // the turn banner dries
  let u = (await ui(page)) as Awaited<ReturnType<typeof ui>> & { offer?: { text: string; buttons: string[] } | null };
  // v4 (A5): the offer waits on its own line; the strip's line and the one gold stay with the player's step
  check(!!u.offer && /^Cobalt proposes a truce with John · \d rounds?( · .+)?$/.test(u.offer.text) && u.offer.buttons.join(' / ') === 'Decline / Accept' && u.gold !== 'button:acceptTruce', `John's turn: the offer waits on its own line ("${u.offer?.text}"), its words ${u.offer?.buttons.join(' / ')}, the gold stays ${u.gold}`, results);
  const dock = await page.evaluate(() => {
    const acc = document.querySelector('[data-testid="btn-acceptTruce"]');
    const dec = document.querySelector('[data-testid="btn-declineTruce"]');
    const cur = document.querySelector('.tr-seg.is-current');
    return {
      acceptRinged: !!acc?.classList.contains('gold') && getComputedStyle(acc!.querySelector('.btn-ring')!).display !== 'none',
      declineBare: !!dec && !dec.classList.contains('gold') && getComputedStyle(dec.querySelector('.btn-ring')!).display === 'none',
      trackGold: !!cur?.classList.contains('gold'),
    };
  });
  check(!dock.acceptRinged && dock.declineBare && dock.trackGold, `v4: Accept and Decline are bare words, the phase underline keeps the gold (${JSON.stringify(dock)})`, results);
  const g = await goldOver(page, 1200);
  check(g.max === 1, `one gold at a time while the offer waits: max ${g.max} per frame (${g.worst.join(', ')})`, results);
  await shot(page, 'truce-offer-1440x900');
  await clickBtn(page, 'btn-acceptTruce');
  await idle(page);
  const after = (await state(page))!;
  const lines = await page.evaluate(() => window.__risk.ledger().filter((l) => l.kind === 'truce').map((l) => l.text));
  check(
    (after.diplomacy?.truces ?? []).some((t) => t.from === 1 && t.to === 0) && lines.some((l) => /^John accepts Cobalt's truce · until round \d+$/.test(l)),
    `Accept answers it: a truce between Cobalt and John, and the ledger says "${lines[lines.length - 1]}"`,
    results,
  );
  u = await ui(page);
  check(!u.buttons.includes('Accept') && u.gold !== 'button:acceptTruce', `the dock is John's again (${u.buttons.join(' / ') || 'no buttons'}, gold ${u.gold})`, results);
  // --- 3. John's own offer, from Attack ---------------------------------------------------------------
  await place(page, 'ural');
  await idle(page);
  await seg(page, 'attack');
  await idle(page);
  u = await ui(page);
  check(u.buttons.join('/') === 'Truce' && u.gold === 'segment:attack', `Attack: a bare "Truce" in the secondary slot (${u.buttons.join('/')}; gold ${u.gold})`, results);
  await clickBtn(page, 'btn-truce');
  await settleUi(page, 400);
  const lit = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.seat-chip.truce-target')].map((c) => c.querySelector('.sc-name')?.textContent));
  const line = (await ui(page)).line;
  check(lit.join(',') === 'Amber,Emerald' && /^Offer a 3-round truce · click a seat$/.test(line), `Truce lights the rings that can take one (${lit.join(', ')}; Cobalt already has one) and the line says "${line}"`, results);
  await shot(page, 'truce-pick-1440x900');
  await page.locator('.seat-chip.truce-target').first().click();
  await idle(page);
  const lines2 = await page.evaluate(() => window.__risk.ledger().filter((l) => l.kind === 'truce').map((l) => l.text));
  check(lines2.includes('John proposes a truce with Amber · 3 rounds') && lines2.includes("Amber turns down John's truce"), `a lit ring proposes 3 rounds; a classic AI turns it down (${lines2.slice(-2).join(' | ')})`, results);
  // the ledger with the truce lines
  await page.waitForTimeout(300);
  await clickBtn(page, 'events');
  await settleUi(page, 500);
  const ledgerShown = await page.evaluate(() => [...document.querySelectorAll('[data-testid="log"] .log-line.kind-truce')].map((l) => l.textContent));
  check(ledgerShown.length >= 3, `the ledger sheet prints the truce sentences (${ledgerShown.length} lines)`, results);
  await shot(page, 'ledger-truce-1440x900');
  await page.keyboard.press('Escape');
  allErrors.push(...ctx.errors);
  await ctx.browser.close();
}

// the same offer at phone-landscape size (screenshot + the dock's words)
if (run('2')) {
  const ctx = await openDevice('iphone-land');
  const { page } = ctx;
  const s0 = offerBoard();
  await loadScenario(page, s0, { waitIdle: false });
  await page.waitForFunction(() => {
    const s = window.__risk.getState();
    return !!s && s.currentPlayer === 0 && s.turn > 5 && window.__risk.isIdle();
  }, null, { timeout: 30000 });
  await rendered(page);
  await page.waitForTimeout(1700);
  const u = (await ui(page)) as Awaited<ReturnType<typeof ui>> & { offer?: { text: string; buttons: string[] } | null };
  check(u.offer?.buttons.join(' / ') === 'Decline / Accept', `iphone-land: the offer's Decline / Accept (${u.offer?.buttons.join(' / ') ?? ''})`, results);
  await shot(page, 'truce-offer-iphone-land');
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
    check(marks.pers.slice(1).join(',') === 'Warlord,Turtle,Opportunist', `each AI's personality word under its name (${marks.pers.join(', ')})`, results);
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
    const cup = document.querySelector<HTMLElement>('[data-testid="cup"] .cup-body')?.getBoundingClientRect();
    const r = c?.querySelector('.sc-ring')?.getBoundingClientRect();
    return c
      ? {
          name: c.querySelector('.sc-name')?.textContent,
          terr: c.querySelector('.sc-terr')?.textContent,
          opacity: +getComputedStyle(c).opacity,
          current: c.classList.contains('current'),
          cupNear: !!cup && !!r && Math.abs(cup.right - r.left) < 30 && Math.abs(cup.bottom - r.bottom) < 20,
        }
      : null;
  });
  const grey = (s.territories as Record<string, { owner: number }>);
  const neutralTiles = Object.values(grey).filter((t) => t.owner === n?.id).length;
  // Dealt 14; by the time the strip is read the AI may already have taken one or two, so accept 1–14.
  check(!!n && (n.color as string) === 'neutral' && n.name === 'Neutral' && neutralTiles >= 1 && neutralTiles <= 14, `${form}: a 2-player game deals the grey neutral seat (${n?.name}, ${n?.color}, ${neutralTiles} territories)`, results);
  check(!!seat && seat.name === 'Neutral' && seat.terr === String(neutralTiles) && Math.abs(seat.opacity - 0.6) < 0.01 && !seat.current && !seat.cupNear, `${form}: its ring keeps its count, dimmed, never current, no cup (${JSON.stringify(seat)})`, results);
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
