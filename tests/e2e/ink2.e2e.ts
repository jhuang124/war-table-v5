// INK2's three checks (docs/INK2.md §5 Phase D), on the real board + HUD:
//   (a) No rounded rectangle anywhere (INK2 §3): across the title, new game (and its swatch popover), the
//       game in Place (picked), Attack armed and Occupy, the menu, Settings, the Cards sheet and Victory
//       (v5.1: the hand-off cover is gone; New game's and Settings' More folds are scanned open), on desktop 1440×900, iPhone portrait and iPhone landscape: no visible element (or
//       its ::before / ::after) with border-radius > 0 that also has a non-transparent background or a
//       border. SVG is ink (the brush rings, underlines, the ensō), not a box, and is skipped; the gold
//       rule's signature (.st-rule, .lk-rule, .ra-rule) is skipped as the one-gold sampler skips it.
//   (b) Mid-roll on iPhone landscape (one real roll, realtime): every count ring still on the board reads
//       (effective opacity ≥ 0.6) and the fighting pair's washes are at dim 0 while the rest recede.
//   (c) After a Turn Track advance the ensō sits on the rule over the current word: its centre x equals
//       the word's centre x ± 2 px (each form factor, Place → Attack → Fortify).
import { check, finish, idle, loadScenario, open, realtime, scenario, TWO_HUMANS } from './lib';
import { openDevice, tapId, tapT, type MCtx } from './mobile-lib';
import type { Page } from 'playwright';
import { TERRITORY_IDS, type Card, type Phase, type TerritoryId } from '../../src/engine';
import { mkdirSync } from 'node:fs';

const results: string[] = [];
const allErrors: string[] = [];
const OUT = 'artifacts/e2e/ink2';
mkdirSync(OUT, { recursive: true });
const reinforce = (remaining: number): Phase => ({ kind: 'reinforce', remaining, mustTrade: false, placed: {}, midTurn: false });

/** Every visible rounded box in the UI (see (a) above). */
async function roundedBoxes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const alpha = (c: string) => {
      if (!c || c === 'transparent') return 0;
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return 1;
      const p = m[1].split(/[,\s/]+/).filter(Boolean);
      return p.length > 3 ? +p[3] : 1;
    };
    const effOpacity = (el: Element) => {
      let o = 1;
      for (let e: Element | null = el; e; e = e.parentElement) o *= +getComputedStyle(e).opacity;
      return o;
    };
    const boxy = (cs: CSSStyleDeclaration): string | null => {
      const rad = ['top-left', 'top-right', 'bottom-right', 'bottom-left'].map((k) => parseFloat(cs.getPropertyValue(`border-${k}-radius`)) || 0);
      if (!rad.some((r) => r > 0.5)) return null;
      const bg = alpha(cs.backgroundColor) > 0.02 || (cs.backgroundImage !== 'none' && !/^none$/.test(cs.backgroundImage));
      const border = ['top', 'right', 'bottom', 'left'].some(
        (s) => parseFloat(cs.getPropertyValue(`border-${s}-width`)) >= 0.5 && cs.getPropertyValue(`border-${s}-style`) !== 'none' && alpha(cs.getPropertyValue(`border-${s}-color`)) > 0.02,
      );
      if (!bg && !border) return null;
      return `r ${Math.max(...rad)}px${bg ? ' bg' : ''}${border ? ' border' : ''}`;
    };
    const name = (el: Element) => {
      const t = (el as HTMLElement).dataset?.testid;
      return t ? `[${t}]` : `${el.tagName.toLowerCase()}.${String(el.getAttribute('class') ?? '').split(' ').filter(Boolean).join('.')}`;
    };
    for (const el of document.querySelectorAll('.ui-root *')) {
      if (el instanceof SVGElement) continue;
      if (el.closest('.st-rule, .lk-rule, .ra-rule, #boot-splash, .leaving')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      if (!(el as HTMLElement).checkVisibility?.({ visibilityProperty: true, opacityProperty: true })) continue;
      if (effOpacity(el) < 0.05) continue;
      const own = boxy(getComputedStyle(el));
      if (own) out.push(`${name(el)} ${own}`);
      for (const pseudo of ['::before', '::after']) {
        const cs = getComputedStyle(el, pseudo);
        if (!cs.content || cs.content === 'none' || cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
        const p = boxy(cs);
        if (p) out.push(`${name(el)}${pseudo} ${p}`);
      }
    }
    return [...new Set(out)];
  });
}

/** The ensō's centre on the rule vs the current word's centre (CSS px). */
const ensoVsWord = (page: Page) =>
  page.evaluate(() => {
    const e = document.querySelector('[data-testid="rule-enso"]')?.getBoundingClientRect();
    const w = document.querySelector('.strip .tr-seg.is-current')?.getBoundingClientRect();
    const id = (document.querySelector('.strip .tr-seg.is-current') as HTMLElement | null)?.dataset.testid ?? '-';
    return e && w ? { enso: e.left + e.width / 2, word: w.left + w.width / 2, id } : null;
  });

type Target = '1440x900' | 'iphone' | 'iphone-land';
const TARGETS = (process.env.INK2_TARGETS ?? '1440x900,iphone,iphone-land').split(',') as Target[];
/** Debugging by hand: INK2_STEPS=title,game,cards,victory,roll runs only those. */
const ONLY = process.env.INK2_STEPS?.split(',');
const cards3 = (): Card[] => [
  { id: 0, territory: 'ural', symbol: 'infantry' },
  { id: 1, territory: 'peru', symbol: 'infantry' },
  { id: 2, territory: 'brazil', symbol: 'infantry' },
];

for (const target of TARGETS) {
  const phone = target !== '1440x900';
  let page: Page;
  let close: () => Promise<void>;
  let errors: string[];
  if (phone) {
    const ctx: MCtx = await openDevice(target);
    page = ctx.page;
    errors = ctx.errors;
    close = () => ctx.browser.close();
  } else {
    const c = await open();
    page = c.page;
    errors = c.errors;
    close = () => c.browser.close();
  }
  const tag = `[${target}]`;
  const press = async (testid: string) => {
    if (phone) return tapId(page, testid);
    const loc = page.locator(`[data-testid="${testid}"]`).first();
    await loc.waitFor({ state: 'visible', timeout: 5000 });
    await loc.click();
  };
  const tapTerr = async (t: string) => {
    if (phone) return tapT(page, t);
    const p = await page.evaluate((id) => window.__risk.screenPos(id as never), t);
    if (!p) throw new Error(`no screen position for ${t}`);
    await page.mouse.click(p.x, p.y);
  };
  const seen: Record<string, string[]> = {};
  const scan = async (label: string) => {
    await page.waitForTimeout(450); // sheets rise, words brush in
    const found = await roundedBoxes(page);
    seen[label] = found;
    if (found.length) await page.screenshot({ path: `${OUT}/rounded-${target}-${label}.png` });
  };
  const step = async (label: string, fn: () => Promise<void>) => {
    if (ONLY && !ONLY.includes(label)) return;
    try {
      await fn();
    } catch (e) {
      check(false, `${tag} ${label}: ${(e as Error).message.split('\n')[0]}`, results);
    }
  };

  await step('title', async () => {
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForFunction(() => window.__risk?.ui().screen === 'title');
    await page.waitForTimeout(900);
    // The scanner isn't vacuous: a pill planted in the UI is found (then removed).
    await page.evaluate(() => {
      const p = document.createElement('div');
      p.id = 'ink2-probe';
      p.style.cssText = 'position:fixed;left:40px;top:40px;width:120px;height:40px;border-radius:999px;border:1px solid rgba(226,221,207,.4);z-index:99';
      document.querySelector('.ui-root')!.append(p);
    });
    const probe = await roundedBoxes(page);
    await page.evaluate(() => document.getElementById('ink2-probe')?.remove());
    check(probe.some((x) => x.startsWith('div.') && /border/.test(x)), `${tag} (a) the scanner finds a planted pill (${probe.length} found)`, results);
    await scan('title');
    await press('title-new');
    await page.waitForFunction(() => window.__risk.ui().screen === 'newGame', null, { timeout: 5000 });
    await scan('newgame');
    // v5.1 D: what folded under More (map, setup, rules, the AI rows) is ink too
    await press('ng-more');
    await page.locator('[data-testid="ng-more-body"]').waitFor({ state: 'visible', timeout: 4000 });
    await scan('newgame-more');
    await press('seat-color-0');
    await scan('swatches');
  });

  await step('game', async () => {
    const own = { ural: [0, 12], ukraine: [0, 2], afghanistan: [0, 2], siberia: [1, 1] } as Partial<Record<TerritoryId, [number, number]>>;
    await loadScenario(page, scenario(own, reinforce(5), { fill: (_t, i) => [1 + (i % 3), 1 + ((i * 7) % 3)] }));
    if (phone) await page.evaluate(() => document.querySelector<HTMLElement>('[data-testid="rotate-pill-close"]')?.click());
    await tapTerr('ural');
    await page.waitForFunction(() => !!window.__risk.ui().count, null, { timeout: 4000 });
    await scan('place-picked');
    await page.waitForTimeout(400);
    const e0 = await ensoVsWord(page);
    await press('btn-place');
    await idle(page);
    // v5.1 E1: Place → Attack advances by itself after the last army
    await page.waitForFunction(() => window.__risk.ui().step === 'Attack', null, { timeout: 4000 });
    await idle(page);
    await page.waitForTimeout(400); // the slide is 180 ms
    const e1 = await ensoVsWord(page);
    check(
      !!e0 && !!e1 && Math.abs(e0.enso - e0.word) <= 2 && Math.abs(e1.enso - e1.word) <= 2 && e1.id === 'seg-attack',
      `${tag} (c) the ensō sits over the current word: ${e0?.id} Δ${e0 ? (e0.enso - e0.word).toFixed(1) : '?'} px → ${e1?.id} Δ${e1 ? (e1.enso - e1.word).toFixed(1) : '?'} px`,
      results,
    );
    await tapTerr('siberia');
    await page.waitForFunction(() => window.__risk.ui().buttons.includes('Blitz'), null, { timeout: 4000 });
    await scan('attack-armed');
    await press('btn-blitz');
    await idle(page);
    await page.waitForFunction(() => window.__risk.getState()?.phase.kind === 'occupy', null, { timeout: 5000 });
    await scan('occupy');
    await press('btn-move');
    await idle(page);
    await press('seg-fortify');
    await idle(page);
    await page.waitForTimeout(400);
    const e2 = await ensoVsWord(page);
    check(!!e2 && Math.abs(e2.enso - e2.word) <= 2 && e2.id === 'seg-fortify', `${tag} (c) after → Fortify: ${e2?.id} Δ${e2 ? (e2.enso - e2.word).toFixed(1) : '?'} px`, results);
    await press('menu');
    await scan('menu');
    await press('pause-settings');
    await scan('settings');
    // v5.1 E3: four primaries, the rest under More
    await press('settings-more');
    await page.locator('[data-testid="settings-more-body"]').waitFor({ state: 'visible', timeout: 4000 });
    await scan('settings-more');
  });

  await step('cards', async () => {
    await loadScenario(page, scenario({ ural: [0, 4], ukraine: [0, 2] }, reinforce(5), { mutate: (s) => void (s.players[0].cards = cards3()) }));
    const btn = await page.evaluate(() => window.__risk.ui().buttons.find((b) => /^Cards/.test(b)) ?? null);
    if (!btn) throw new Error('no Cards button');
    await press('btn-cards');
    await page.locator('[data-testid="cards"]').waitFor({ state: 'visible', timeout: 4000 });
    await scan('cards');
  });

  // (v5.1 A: the hand-off cover is gone; the turn passes with the one line. Its step went with it.)

  await step('victory', async () => {
    const all: Partial<Record<TerritoryId, [number, number]>> = {};
    for (const id of TERRITORY_IDS) all[id] = [0, 2];
    all.alaska = [1, 1];
    all.kamchatka = [0, 30];
    await loadScenario(page, scenario(all, { kind: 'attack' }, { players: TWO_HUMANS as never, mutate: (st) => void (st.config.dominationPercent = 100) }));
    await tapTerr('alaska');
    await page.waitForFunction(() => window.__risk.ui().buttons.includes('Blitz'), null, { timeout: 4000 });
    await press('btn-blitz');
    await page.waitForFunction(() => window.__risk.ui().screen === 'victory', null, { timeout: 20000 });
    await page.waitForTimeout(600);
    const vp = page.viewportSize()!;
    if (phone) await page.touchscreen.tap(vp.width / 2, vp.height / 2);
    else await page.mouse.click(vp.width / 2, vp.height / 2);
    await page.locator('[data-testid="rematch"]').waitFor({ state: 'visible', timeout: 5000 });
    await scan('victory');
  });

  const bad = Object.entries(seen).filter(([, v]) => v.length);
  if (ONLY) {
    if (bad.length) console.log(`${tag} rounded: ${JSON.stringify(bad)}`);
    allErrors.push(...errors.map((e) => `${tag} ${e}`));
    await close();
    continue;
  }
  check(
    Object.keys(seen).length >= 12 && bad.length === 0,
    `${tag} (a) no rounded rectangles across ${Object.keys(seen).join(', ')}${bad.length ? ` — ${bad.map(([k, v]) => `${k}: ${v.slice(0, 4).join('; ')}`).join(' | ')}` : ''}`,
    results,
  );
  allErrors.push(...errors.map((e) => `${tag} ${e}`));
  await close();
}

// (b) Mid-roll on iPhone landscape: one real roll.
if (!ONLY || ONLY.includes('roll')) {
  const ctx = await openDevice('iphone-land');
  const { page } = ctx;
  await realtime(page);
  await loadScenario(page, scenario({ brazil: [0, 12], north_africa: [1, 4] }, { kind: 'attack' }, { fill: (_t, i) => [1 + (i % 3), 1 + ((i * 7) % 5)] }));
  await page.waitForTimeout(600); // past the turn-start guard
  await tapT(page, 'north_africa');
  await page.waitForFunction(() => window.__risk.ui().buttons.includes('Roll'), null, { timeout: 4000 });
  await tapId(page, 'btn-roll');
  // single roll at 1×: shake 120 · tumble 450 · settle 100 → the silence runs 670–920 ms
  await page.waitForTimeout(790);
  const mid = await page.evaluate(() => {
    const dbg = (window.__board as unknown as { __debug: { tray: { visible: boolean }; tiles: { list: { id: string; dim: number }[] } } }).__debug;
    const eff = (el: Element) => {
      let o = 1;
      for (let e: Element | null = el; e; e = e.parentElement) o *= +getComputedStyle(e).opacity;
      return o;
    };
    const badges = [...document.querySelectorAll<HTMLElement>('.rb-badge')];
    const shown = badges.filter((b) => getComputedStyle(b).visibility !== 'hidden');
    const faint = shown.map((b) => ({ o: eff(b), t: b.innerText.trim() })).filter((x) => x.o < 0.6);
    const dim = (id: string) => dbg.tiles.list.find((t) => t.id === id)?.dim ?? -1;
    const rest = dbg.tiles.list.filter((t) => t.id !== 'brazil' && t.id !== 'north_africa').map((t) => t.dim);
    return {
      tray: dbg.tray.visible,
      total: badges.length,
      shown: shown.length,
      faint,
      pair: [dim('brazil'), dim('north_africa')],
      restMin: Math.min(...rest),
      minOpacity: Math.min(...shown.map(eff)),
    };
  });
  await page.screenshot({ path: `${OUT}/iphone-land-mid-roll.png` });
  check(mid.tray, 'iphone-land (b) the dice tray is up mid-roll', results);
  check(
    mid.faint.length === 0 && mid.shown > 0,
    `iphone-land (b) every count ring on the board reads mid-roll: min opacity ${mid.minOpacity.toFixed(2)} over ${mid.shown} shown (${mid.total - mid.shown} of ${mid.total} under the dice / header)${mid.faint.length ? ` — faint: ${JSON.stringify(mid.faint)}` : ''}`,
    results,
  );
  check(mid.pair[0] === 0 && mid.pair[1] === 0 && mid.restMin > 0, `iphone-land (b) the pair stays at dim 0 (${mid.pair.join(', ')}), the rest recede (min ${mid.restMin.toFixed(2)})`, results);
  await page.evaluate(() => window.__risk.waitIdle(8000));
  allErrors.push(...ctx.errors.map((e) => `iphone-land ${e}`));
  await ctx.browser.close();
}

finish(results, allErrors);
