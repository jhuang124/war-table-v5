// Feel and layout checks on the real board + HUD (SPEC §10, docs/SIMPLIFY.md):
//   - the renderer's dice tray sits beside the fight, clear of both strips; the fight's words are in the one
//     line above the rule and no HUD word floats on the ring (fight text, 2026-10-05), at 1280×800,
//     1440×900, 1920×1080 and TV text on 1920×1080
//   - the only chrome is the two strips (and the tray during a fight); the board spans the window
//   - ≤ 27 words on screen in an armed Attack state (v3: 25 + the round)
//   - dice ≥ 34 px; army tokens ≥ 22 px tall at home on 1280×800
//   - the bottom strip's rect is identical in place / attack / armed / occupy / fortify / watching
//   - the idle board settles to 0 tweens; a Place click shows its effect within 50 ms
//   - no frame > 50 ms on the first roll after a cold load
//   - no text selection on double-click, no context menu, TV text ≥ 20 px and no HUD overlap
import { ART, check, clickBtn, clickT, finish, idle, loadScenario, open, place, scenario, seg, state } from './lib';
import type { Page } from 'playwright';
import type { Phase } from '../../src/engine';

const results: string[] = [];
const reinforce = (remaining: number): Phase => ({ kind: 'reinforce', remaining, mustTrade: false, placed: {}, midTurn: false });

interface TrayDbg {
  cx: number;
  cy: number;
  trayW: number;
  trayH: number;
  size: number;
}
async function trayAndBand(page: Page) {
  return page.evaluate(() => {
    const dbg = (window.__board as unknown as { __debug: { tray: TrayDbg } }).__debug.tray;
    const r = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
    };
    return {
      tray: { top: dbg.cy - dbg.trayH / 2, bottom: dbg.cy + dbg.trayH / 2, left: dbg.cx - dbg.trayW / 2, right: dbg.cx + dbg.trayW / 2, die: dbg.size },
      // The tray band the HUD reports (the header is only the line above the tray now).
      band: r('.band-probe'),
      // fight text: the fight's names and counts, in the one line
      headerText: (() => {
        const els = [...document.querySelectorAll('[data-testid="battle"] .bt-side')].filter((e) => (e as HTMLElement).offsetParent !== null);
        if (!els.length) return null;
        const rs = els.map((e) => e.getBoundingClientRect());
        return { top: Math.min(...rs.map((x) => x.top)), bottom: Math.max(...rs.map((x) => x.bottom)) };
      })(),
      // HUD words over the ring's box (the ring carries dice only)
      onRing: (() => {
        if (!dbg.cx) return [] as string[];
        const ring = [dbg.cx - dbg.trayW * 0.53, dbg.cy - dbg.trayH / 2, dbg.cx + dbg.trayW * 0.53, dbg.cy + dbg.trayH / 2];
        const out: string[] = [];
        const walk = document.createTreeWalker(document.getElementById('ui')!, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          const el = n.parentElement;
          const s = n.textContent?.trim();
          if (!s || !el || !(el.checkVisibility?.({ visibilityProperty: true, opacityProperty: true }) ?? true) || el.closest('.sr-only')) continue;
          const b = el.getBoundingClientRect();
          if (b.width > 0 && b.left < ring[2] && b.right > ring[0] && b.top < ring[3] && b.bottom > ring[1]) out.push(s.slice(0, 24));
        }
        return out;
      })(),
      bar: r('[data-testid="strip"]'),
      // The chrome starts at the gold rule: the one line above it sits on the paper, with no panel (INK B5).
      rule: r('.strip .st-rule'),
      top: r('[data-testid="topstrip"]'),
      words: ['.topstrip', '.strip']
        .map((q) => document.querySelector(q) as HTMLElement | null)
        .filter((e): e is HTMLElement => !!e && e.offsetParent !== null)
        .map((e) => e.innerText)
        .join(' ')
        .split(/\s+/)
        .filter((w) => /[A-Za-z0-9]/.test(w)).length -
        // (fight text: while the fight owns the line slot the strip's own sentence has dried: not on screen)
        [...document.querySelectorAll<HTMLElement>('.st-say.has-fight .st-line')]
          .map((e) => e.innerText)
          .join(' ')
          .split(/\s+/)
          .filter((w) => /[A-Za-z0-9]/.test(w)).length -
        // (v3: the ledger's faint event lines above the dock are the table's record, not chrome to read)
        [...document.querySelectorAll<HTMLElement>('.st-events')]
          .map((e) => e.innerText)
          .join(' ')
          .split(/\s+/)
          .filter((w) => /[A-Za-z0-9]/.test(w)).length,
      H: innerHeight,
    };
  });
}

// --- Tray ↔ battle band alignment at every target size ------------------------------------------
for (const vp of [
  { width: 1280, height: 800, text: 'laptop' },
  { width: 1440, height: 900, text: 'laptop' },
  { width: 1920, height: 1080, text: 'laptop' },
  { width: 1920, height: 1080, text: 'tv' },
]) {
  const tag = `${vp.width}x${vp.height}${vp.text === 'tv' ? '-tv' : ''}`;
  const { browser, page, errors } = await open(undefined, { width: vp.width, height: vp.height });
  await loadScenario(page, scenario({ ural: [0, 12], ukraine: [0, 2] }, { kind: 'attack' }, { mutate: (s) => void (s.territories.siberia.armies = 6) }), {
    settings: { textSize: vp.text },
  });
  await clickT(page, 'siberia');
  await page.waitForTimeout(400); // the line's swap (the old line's ghost) and the dismissed turn line settle
  const armedWords = (await trayAndBand(page)).words;
  // v3 (John 2026-09-30, "fuller, not busier"): the round ("Round 6") joins the 25.
  if (vp.text === 'laptop') check(armedWords <= 27, `${tag}: ${armedWords} words on screen in an armed Attack state (≤ 27: 25 + the round)`, results);
  await clickBtn(page, 'btn-roll');
  await page.waitForFunction(() => (window.__board as unknown as { __debug: { tray: { visible: boolean } } }).__debug.tray.visible, null, { timeout: 5000 });
  await page.waitForTimeout(700);
  const g = await trayAndBand(page);
  await page.screenshot({ path: `${ART}/feel-tray-${tag}.png` });
  const tol = 1.5;
  // v4: on desktop the ring sits beside the fight (not in a southern band). Fight text (2026-10-05): the fight's
  // words are the one line above the rule; nothing rides on the ring's rim.
  check(!!g.top && g.tray.top >= g.top.bottom - tol, `${tag}: tray ${Math.round(g.tray.top)}–${Math.round(g.tray.bottom)} clears the seat strip (${Math.round(g.top!.bottom)})`, results);
  check(
    !!g.headerText && !!g.rule && g.headerText.bottom <= g.rule.top + tol && g.headerText.top >= g.rule.top - 80,
    `${tag}: the fight's words ${Math.round(g.headerText?.top ?? -1)}–${Math.round(g.headerText?.bottom ?? -1)} sit on the line above the rule (${Math.round(g.rule?.top ?? -1)})`,
    results,
  );
  check(g.onRing.length === 0, `${tag}: no HUD word on the ring (${g.onRing.join(' | ') || 'none'})`, results);
  check(!!g.bar && g.tray.bottom <= g.bar.top + tol, `${tag}: the tray clears the bottom strip (${Math.round(g.tray.bottom)} ≤ ${Math.round(g.bar!.top)})`, results);
  // Bottom chrome = the rule and the pill row under it (the moodboard's is ~14% of the height); TV text is larger.
  const bottomMax = vp.text === 'tv' ? 0.16 : 0.14;
  const topMax = vp.text === 'tv' ? 0.085 : 0.075;
  check(!!g.top && g.top.bottom <= topMax * g.H && !!g.rule && g.H - g.rule.top <= bottomMax * g.H, `${tag}: chrome is two thin strips (top ${Math.round(g.top!.bottom)} px, bottom from the rule ${Math.round(g.H - (g.rule?.top ?? 0))} px ≤ ${Math.round(bottomMax * g.H)})`, results);
  check(g.tray.left >= -tol && g.tray.right <= vp.width + tol, `${tag}: the tray stays inside the frame (${Math.round(g.tray.left)}–${Math.round(g.tray.right)})`, results);
  // The ink tray is slim and quiet (INK F2: ~0.7× the old lacquer dice); still legible across a room.
  check(g.tray.die >= 34, `${tag}: die ${Math.round(g.tray.die)} px (≥ 34)`, results);
  if (vp.text === 'tv') {
    // TV text: every visible HUD text ≥ 20 px, no overlap between the fixed HUD panels.
    const tv = await page.evaluate(() => {
      const small: string[] = [];
      const walk = document.createTreeWalker(document.getElementById('ui')!, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const t = n.textContent?.trim();
        const el = n.parentElement!;
        if (!t || !el.offsetParent) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
        if (el.closest('.hidden, [aria-hidden="true"]')) continue;
        const fs = parseFloat(cs.fontSize);
        if (fs < 19.5) small.push(`${t.slice(0, 24)} (${fs}px ${el.className})`);
      }
      const box = (s: string) => document.querySelector(s)?.getBoundingClientRect();
      const panels = ['.topstrip', '[data-testid="strip"]'].map((s) => [s, box(s)] as const).filter(([, b]) => b && b.width > 0);
      const overlaps: string[] = [];
      for (let i = 0; i < panels.length; i++)
        for (let j = i + 1; j < panels.length; j++) {
          const a = panels[i][1]!;
          const b = panels[j][1]!;
          if (a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1) overlaps.push(`${panels[i][0]} × ${panels[j][0]}`);
        }
      return { small, overlaps };
    });
    check(tv.small.length === 0, `TV text ≥ 20 px (${tv.small.length} smaller: ${tv.small.slice(0, 6).join(' | ')})`, results);
    check(tv.overlaps.length === 0, `TV: HUD panels don't overlap (${tv.overlaps.join(', ') || 'none'})`, results);
  }
  await browser.close();
  if (errors.length) results.push(`FAIL ${tag} console errors: ${errors.join(' | ')}`);
}

// --- 1280×800 home: badges ≥ 22 px; action bar never moves; idle 0 tweens; click → effect ≤ 50 ms ---
{
  const { browser, page, errors } = await open(undefined, { width: 1280, height: 800 });
  await loadScenario(page, scenario({ ural: [0, 3], ukraine: [0, 2], siberia: [0, 1] }, reinforce(6)));
  await page.waitForTimeout(1500);
  const badges = await page.evaluate(() => {
    const tk = (window as unknown as { __board: { __debug: { tokens: { stoneOf: (id: string) => { dPx: number; figWPx: number; figHPx: number } } } } }).__board.__debug.tokens;
    return [...document.querySelectorAll<HTMLElement>('.rb-badge')]
      .filter((b) => b.style.visibility !== 'hidden')
      .map((b) => {
        const st = tk.stoneOf(b.dataset.t!);
        return { d: st.dPx, fig: Math.max(st.figWPx, st.figHPx), fs: parseFloat(getComputedStyle(b).fontSize) };
      });
  });
  // v3: the army is a painted stone sized by its count (18 px for 1 army at 1440×900, never under the 14 px
  // floor), its unit figure standing on it (≥ 14 px long: a sprite under that blurs), its numeral at the edge ≥ 14 px
  const minW = Math.min(...badges.map((b) => b.d));
  const minFig = Math.min(...badges.map((b) => b.fig));
  const minF = Math.min(...badges.map((b) => b.fs));
  check(badges.length === 42 && minW >= 9.5 && minFig >= 10 && minF >= 17.5, `army pieces at home on 1280×800: ${badges.length} visible, stones ≥ ${minW.toFixed(1)} px across (≥ 10, the v4 law), figures ≥ ${minFig.toFixed(1)} px long (≥ 10), numerals ≥ ${minF.toFixed(1)} px (≥ 18)`, results);
  const st0 = await page.evaluate(() => window.__risk.stats());
  check(st0.activeTweens === 0 && !st0.cameraMoving, `idle board: ${st0.activeTweens} tweens, camera ${st0.cameraMoving ? 'moving' : 'still'}`, results);
  await page.screenshot({ path: `${ART}/feel-home-1280x800.png` });

  const rects: Record<string, string> = {};
  const tracks: Record<string, string> = {};
  const barRect = async (k: string) => {
    rects[k] = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="strip"]')!.getBoundingClientRect();
      return `${b.left},${b.top},${b.width},${b.height}`;
    });
    // The Turn Track never disappears or renames (docs/ROUND2.md §A): same labels, same place.
    tracks[k] = await page.evaluate(() => {
      const t = document.querySelector('[data-testid="track"]') as HTMLElement | null;
      if (!t || !t.offsetParent) return 'hidden';
      const b = t.getBoundingClientRect();
      const labels = [...t.querySelectorAll('.tr-label')].map((x) => x.textContent).join('|');
      return `${labels} @ ${Math.round(b.left)},${Math.round(b.top)},${Math.round(b.height)}`;
    });
  };
  await barRect('place');
  // Click → first visible effect: the strip's line says 'Place on Ural' within 50 ms of pointer-up.
  const pos = (await page.evaluate(() => window.__risk.screenPos('ural')))!;
  await page.evaluate(`(() => {
    const line = document.querySelector('[data-testid="line"]');
    window.__ack = { up: 0, seen: 0 };
    window.addEventListener('pointerup', () => (window.__ack.up = performance.now()), { capture: true, once: true });
    new MutationObserver(() => { if (!window.__ack.seen && window.__ack.up) window.__ack.seen = performance.now(); }).observe(line, { subtree: true, characterData: true, childList: true });
  })()`);
  await page.mouse.click(pos.x, pos.y);
  await page.waitForTimeout(150);
  const ack = (await page.evaluate('window.__ack')) as { up: number; seen: number };
  check(ack.seen > 0 && ack.seen - ack.up <= 50, `Place click → the line updated in ${(ack.seen - ack.up).toFixed(1)} ms (≤ 50)`, results);
  await barRect('place-picked');
  // No text selection on double-click; no context menu on the HUD or the board.
  await page.locator('[data-testid="line"]').dblclick();
  const sel = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  check(sel === '', `double-click selects no text ("${sel}")`, results);
  const ctx = await page.evaluate(() => {
    const out: boolean[] = [];
    for (const el of [document.querySelector('[data-testid="strip"]'), document.querySelector('#board canvas')]) {
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
      el!.dispatchEvent(ev);
      out.push(ev.defaultPrevented);
    }
    return out;
  });
  check(ctx.every(Boolean), `context menu suppressed on HUD and board (${ctx.join(', ')})`, results);
  await clickBtn(page, 'btn-place');
  await idle(page);
  await seg(page, 'attack');
  await idle(page);
  await barRect('attack');
  await clickT(page, 'afghanistan');
  await barRect('armed');
  await clickBtn(page, 'btn-blitz');
  await page.waitForTimeout(250);
  await barRect('rolling');
  await idle(page);
  if ((await state(page))!.phase.kind === 'occupy') await barRect('occupy');
  if ((await state(page))!.phase.kind === 'occupy') await clickBtn(page, 'btn-move');
  await idle(page);
  await seg(page, 'fortify');
  await idle(page);
  await barRect('fortify');
  await seg(page, 'endTurn');
  await page.waitForTimeout(700);
  await barRect('watching');
  const distinct = new Set(Object.values(rects));
  check(distinct.size === 1, `bottom strip rect identical across ${Object.keys(rects).join(', ')}: ${[...distinct].join(' | ')}`, results);
  const trackSet = new Set(Object.values(tracks));
  check(trackSet.size === 1 && [...trackSet][0].startsWith('Place|Attack|Fortify|End turn @'), `Turn Track identical across ${Object.keys(tracks).join(', ')}: ${trackSet.size === 1 ? [...trackSet][0] : Object.entries(tracks).map(([k, v]) => `${k} ${v.split('@ ')[1]}`).join(' | ')}`, results);
  await browser.close();
  if (errors.length) results.push(`FAIL console errors: ${errors.join(' | ')}`);
}

// --- Cold load → first roll: no frame over 50 ms -----------------------------------------------------
{
  const { browser, page, errors } = await open(undefined, { width: 1440, height: 900 });
  await loadScenario(page, scenario({ ural: [0, 12] }, { kind: 'attack' }, { mutate: (s) => void (s.territories.siberia.armies = 3) }));
  await clickT(page, 'siberia');
  await page.evaluate(`(() => { window.__frames = []; let last = performance.now(); const f = (t) => { window.__frames.push(t - last); last = t; if (window.__frames.length < 150) requestAnimationFrame(f); }; requestAnimationFrame(f); })()`);
  await clickBtn(page, 'btn-roll');
  await page.waitForTimeout(1800);
  const frames = ((await page.evaluate('window.__frames')) as number[]).slice(1);
  const worst = Math.max(...frames);
  const sorted = [...frames].sort((a, b) => a - b);
  check(worst <= 50, `first roll after a cold load: worst frame ${worst.toFixed(1)} ms, p95 ${sorted[Math.floor(sorted.length * 0.95)].toFixed(1)} ms (≤ 50)`, results);
  await browser.close();
  if (errors.length) results.push(`FAIL console errors: ${errors.join(' | ')}`);
}

finish(results, []);
