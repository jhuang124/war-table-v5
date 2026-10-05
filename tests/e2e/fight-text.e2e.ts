// Fight text (John 2026-10-05: "words live on the rule, pieces live on the board"), on the round-6 rest board,
// logic lane at real speed (the checks need a ring that is really up and dice that are really rolling):
//   desktop 1440×900 · an armed fight and a rolling one:
//     - no HUD text and no undried board name intersects the dice ring's box (the ring carries dice only)
//     - the one line carries the fight: both territory names and both counts ([data-testid="battle"])
//     - the territory note is absent (and a hover mid-roll does not bring it back)
//   after the ring dries: hovering a territory writes the note in the left margin (x < 320 px), never over
//   the board's centre
//   phone 390×844 · armed + rolling: the fight is in the line, no note; after: a long-press writes the note in
//   the dock's line slot (above the rule), two lines at most
// Screenshots → artifacts/fight-text/.
import { mkdirSync } from 'node:fs';
import type { Page } from 'playwright';
import { check, clickBtn, clickT, finish, idle, loadScenario, open, realtime } from './lib';
import { longPress, openDevice, tapId, tapT } from './mobile-lib';
import { restBoard } from './board-lib';

const OUT = 'artifacts/fight-text';
mkdirSync(OUT, { recursive: true });
const results: string[] = [];
const allErrors: string[] = [];

/** Board animation speed (1 = real); the dice in slow motion for a mid-roll frame. */
const speed = (p: Page, v: number) =>
  p.evaluate((x) => {
    const anim = (window.__board as unknown as { __debug: { anim: Record<string, unknown> } }).__debug.anim;
    delete anim.speed;
    if (x === 1) anim.speed = 1;
    else Object.defineProperty(anim, 'speed', { configurable: true, get: () => x, set: () => undefined });
  }, v);

/** What is on screen around the fight: words over the ring, the line's fight words, the note. */
const look = (p: Page) =>
  p.evaluate(() => {
    const t = (window.__board as unknown as { __debug: { tray: { visible: boolean; cx: number; cy: number; trayW: number; trayH: number } } }).__debug.tray;
    const ring = t.visible ? [t.cx - t.trayW * 0.53, t.cy - t.trayH / 2, t.cx + t.trayW * 0.53, t.cy + t.trayH / 2] : null;
    const hit = (r: DOMRect) => !!ring && r.width > 0 && r.left < ring[2] && r.right > ring[0] && r.top < ring[3] && r.bottom > ring[1];
    const vis = (e: Element) => (e as HTMLElement).checkVisibility?.({ visibilityProperty: true, opacityProperty: true }) ?? true;
    const over: string[] = [];
    // every HUD word
    const walk = document.createTreeWalker(document.getElementById('ui')!, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const s = n.textContent?.trim();
      const el = n.parentElement;
      if (!s || !el || !vis(el) || el.closest('.sr-only, [aria-hidden="true"]')) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (hit(r)) over.push(`hud "${s.slice(0, 30)}"`);
    }
    // the board's own names: under the ring they dry to 0.2
    for (const el of document.querySelectorAll<HTMLElement>('.rb-label.on')) {
      if (el.classList.contains('dry')) continue;
      if (hit(el.getBoundingClientRect())) over.push(`name "${el.textContent?.replace(/\s+/g, ' ')}"`);
    }
    const dried = [...document.querySelectorAll<HTMLElement>('.rb-label.on.dry')].map((e) => e.textContent?.replace(/\s+/g, ' ') ?? '');
    const fight = document.querySelector<HTMLElement>('[data-testid="battle"]');
    const fightOn = !!fight && vis(fight) && !fight.classList.contains('hidden');
    const fr = fight?.getBoundingClientRect();
    const rule = document.querySelector('.strip .st-rule')?.getBoundingClientRect();
    const note = document.querySelector<HTMLElement>('[data-testid="name-card"]');
    return {
      ring,
      over,
      dried,
      fight: fightOn ? (fight!.innerText ?? '').replace(/\s+/g, ' ').trim() : '',
      fightAboveRule: !!fr && !!rule && fr.bottom <= rule.top + 4 && fr.top >= rule.top - 80,
      note: !!note && vis(note),
      line: window.__risk.ui().line,
    };
  });

// --- desktop -----------------------------------------------------------------------------------------------
{
  const { browser, page, errors } = await open(undefined, { width: 1440, height: 900 });
  await realtime(page);
  await loadScenario(page, restBoard({ kind: 'attack' }));
  await page.waitForTimeout(1800); // the turn line dries
  // a note first (hover Ural), so arming the fight has something to put away
  const ural = (await page.evaluate(() => window.__risk.screenPos('ural')))!;
  await page.mouse.move(ural.x + 1, ural.y + 6);
  await page.waitForTimeout(300);
  const pre = await look(page);
  check(pre.note, 'desktop: hovering Ural writes its note before the fight', results);
  await clickT(page, 'ural');
  await page.waitForTimeout(250);
  await clickT(page, 'siberia');
  await page.waitForTimeout(500);
  const armed = await look(page);
  await page.screenshot({ path: `${OUT}/desktop-armed.png` });
  check(/Ural 19/.test(armed.fight) && /Siberia 12/.test(armed.fight) && /→/.test(armed.fight) && /\d+%/.test(armed.fight), `desktop armed: the one line reads "${armed.fight}"`, results);
  check(armed.fightAboveRule, 'desktop armed: the fight words sit on the line above the rule', results);
  check(!armed.note, 'desktop armed: no territory note while a fight is armed', results);
  check(armed.over.length === 0, `desktop armed: nothing written over the ring (${armed.ring ? 'ring up' : 'no ring yet'}; ${armed.over.join(', ') || 'clear'})`, results);

  // roll, in slow motion, and look mid-roll
  await speed(page, 0.3);
  await clickBtn(page, 'btn-roll');
  await page.waitForFunction(() => (window.__board as unknown as { __debug: { tray: { visible: boolean } } }).__debug.tray.visible, null, { timeout: 5000 });
  await page.waitForTimeout(600);
  const sib = (await page.evaluate(() => window.__risk.screenPos('siberia')))!;
  await page.mouse.move(sib.x + 1, sib.y + 6); // a hover mid-roll never brings the note back
  await page.waitForTimeout(250);
  const rolling = await look(page);
  await page.screenshot({ path: `${OUT}/desktop-rolling.png` });
  check(!!rolling.ring, 'desktop rolling: the ring is up', results);
  check(rolling.over.length === 0, `desktop rolling: no words over the ring but the dice (${rolling.over.join(', ') || 'clear'}; dried: ${rolling.dried.join(', ') || 'none'})`, results);
  check(/Ural \d+/.test(rolling.fight) && /Siberia \d+/.test(rolling.fight), `desktop rolling: the one line carries both names and counts ("${rolling.fight}")`, results);
  check(!rolling.note, 'desktop rolling: no territory note (a hover mid-roll included)', results);
  await speed(page, 1);
  await idle(page);
  // a single roll leaves the fight armed: Esc twice backs out to nothing picked, and the ring dries (with the
  // source alone still picked the renderer keeps the deciding roll's ring: R1-07)
  await page.mouse.move(40, 760);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(80);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !(window.__board as unknown as { __debug: { tray: { visible: boolean } } }).__debug.tray.visible, null, { timeout: 6000 }).catch(() => undefined);
  await page.waitForTimeout(500);
  const after = await look(page);
  check(!after.fight && after.dried.length === 0, `desktop after: the fight left the line ("${after.line}") and the names came back (${after.dried.join(', ') || 'none dried'})`, results);

  // after the ring: a hover writes the note in the left margin, never over the board's centre
  const india = (await page.evaluate(() => window.__risk.screenPos('india')))!;
  await page.mouse.move(india.x + 1, india.y + 6);
  await page.waitForTimeout(450);
  const note = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="name-card"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, right: r.right, bottom: r.bottom, text: el.innerText.replace(/\s+/g, ' '), bg: getComputedStyle(el).backgroundColor };
  });
  await page.screenshot({ path: `${OUT}/desktop-note.png` });
  const W = 1440;
  const H = 900;
  check(!!note && /India/.test(note.text) && /Asia/.test(note.text), `desktop: hovering India writes its note ("${note?.text}")`, results);
  check(!!note && note.x < 320 && note.right < W * 0.35, `desktop: the note sits in the left margin (x ${Math.round(note?.x ?? -1)}–${Math.round(note?.right ?? -1)})`, results);
  check(!!note && note.y >= 60 && !(note.x < W / 2 && note.right > W / 2 && note.y < H / 2 && note.bottom > H / 2), `desktop: never over the board's centre (y ${Math.round(note?.y ?? -1)})`, results);
  check(!!note && /rgba\(0, 0, 0, 0\)|transparent/.test(note.bg), `desktop: no box behind it (${note?.bg})`, results);
  // the ocean: it dries
  await page.mouse.move(W / 2, 4);
  await page.waitForTimeout(1300);
  check(!(await look(page)).note, 'desktop: leaving the land dries the note', results);
  await browser.close();
  allErrors.push(...errors);
}

// --- phone 390×844 -----------------------------------------------------------------------------------------
{
  const ctx = await openDevice('iphone');
  const { page } = ctx;
  await realtime(page);
  await loadScenario(page, restBoard({ kind: 'attack' }));
  await page.waitForTimeout(1800);
  await tapT(page, 'ural');
  await page.waitForTimeout(250);
  await tapT(page, 'siberia');
  await page.waitForTimeout(500);
  const india = (await page.evaluate(() => window.__risk.screenPos('india')))!;
  const armedPress = await longPress(ctx, india.x, india.y, 650, () => look(page));
  const armed = await look(page);
  await page.screenshot({ path: `${OUT}/phone-armed.png` });
  check(/Ural 19/.test(armed.fight) && /Siberia 12/.test(armed.fight), `phone armed: the one line reads "${armed.fight}"`, results);
  check(!armedPress?.note && !armed.note, 'phone armed: a long-press writes no note while a fight is armed', results);
  await speed(page, 0.3);
  await tapId(page, 'btn-roll');
  await page.waitForFunction(() => (window.__board as unknown as { __debug: { tray: { visible: boolean } } }).__debug.tray.visible, null, { timeout: 5000 });
  await page.waitForTimeout(600);
  const rolling = await look(page);
  await page.screenshot({ path: `${OUT}/phone-rolling.png` });
  check(/Ural \d+/.test(rolling.fight) && /Siberia \d+/.test(rolling.fight) && !rolling.note, `phone rolling: the fight in the line ("${rolling.fight}"), no note`, results);
  check(rolling.over.length === 0, `phone rolling: no words over the ring but the dice (${rolling.over.join(', ') || 'clear'})`, results);
  await speed(page, 1);
  await idle(page);
  // the fight stays armed after a single roll: picking another source puts it away, and the ring dries
  await tapT(page, 'india');
  await page.waitForFunction(() => !(window.__board as unknown as { __debug: { tray: { visible: boolean } } }).__debug.tray.visible, null, { timeout: 6000 }).catch(() => undefined);
  await page.waitForTimeout(500);
  const slot = await longPress(ctx, india.x, india.y, 700, async () => {
    await page.screenshot({ path: `${OUT}/phone-note.png` });
    return page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-testid="name-card"]');
      const rule = document.querySelector('.strip .st-rule')!.getBoundingClientRect();
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 21;
      return { top: r.top, bottom: r.bottom, rule: rule.top, lines: Math.round(r.height / lh), text: el.innerText.replace(/\s+/g, ' ') };
    });
  });
  check(!!slot && /India/.test(slot.text) && /Asia/.test(slot.text) && /\+7/.test(slot.text), `phone: a long-press writes the note ("${slot?.text}")`, results);
  check(!!slot && slot.bottom <= slot.rule + 4 && slot.top >= slot.rule - 80 && slot.lines <= 2, `phone: in the line slot above the rule, ${slot?.lines} line(s) (${Math.round(slot?.top ?? -1)}–${Math.round(slot?.bottom ?? -1)}, rule ${Math.round(slot?.rule ?? -1)})`, results);
  await ctx.browser.close();
  allErrors.push(...ctx.errors);
}

finish(results, allErrors);
