// Bottom sheets on phones (docs/MOBILE.md §5, INK.md B4): a grab handle, drag-down (or a tap on the scrim)
// to dismiss, a spring of at most 2 % overshoot (280 ms in), reduced motion = no travel. Every entry point
// checks `isPhone()`.
// Desktop (v4 E8, sitting Q10): a sheet of paper is laid on the board from the top edge (sheetDrop, 400 ms,
// the brush) and lifted back out the same way (sheetLift); it never fades in from nowhere. Reduced motion:
// the sheet is simply there (and gone), with no travel.

import { EASE_BRUSH, h, motion } from './dom';

/** Desktop: how long a sheet takes to come down onto the board, and to lift back off it. */
export const DROP_MS = 400;
export const LIFT_MS = 300;

/** Distance from where the sheet rests to just above the top edge (its lamp shadow included). */
function aboveTop(sheet: HTMLElement): number {
  const r = sheet.getBoundingClientRect();
  return Math.ceil(r.bottom + 48);
}

/** Desktop: lay a sheet on the board from the top edge (and bring its scrim up under it). */
export function sheetDrop(sheet: HTMLElement, scrim?: HTMLElement | null, ms = DROP_MS): void {
  resetSheet(sheet);
  if (scrim) scrim.style.opacity = '';
  if (typeof sheet.animate !== 'function') return;
  sheet.getAnimations().forEach((a) => a.cancel());
  if (motion.reduced) return;
  const dy = aboveTop(sheet);
  sheet.animate([{ transform: `translateY(${-dy}px)` }, { transform: 'translateY(0)' }], { duration: ms, easing: EASE_BRUSH });
  // The scrim's dimming comes up under it (its colour, never its opacity: the sheet is inside it and must
  // arrive as opaque paper, never fade in).
  scrim?.animate([{ backgroundColor: 'rgba(8, 13, 27, 0)' }, {}], { duration: Math.round(ms * 0.6), easing: 'ease-out' });
}

/** Desktop: lift a sheet back off the top edge (its scrim goes with it), then `done`. */
export function sheetLift(sheet: HTMLElement, scrim: HTMLElement | null | undefined, done: () => void, ms = LIFT_MS): void {
  if (motion.reduced || typeof sheet.animate !== 'function') return done();
  sheet.getAnimations().forEach((a) => a.cancel());
  const dy = aboveTop(sheet);
  const a = sheet.animate([{ transform: 'translateY(0)' }, { transform: `translateY(${-dy}px)` }], { duration: ms, easing: 'cubic-bezier(0.5, 0, 0.75, 0)', fill: 'forwards' });
  scrim?.animate([{}, { backgroundColor: 'rgba(8, 13, 27, 0)' }], { duration: ms, easing: 'ease-in', fill: 'forwards' });
  a.onfinish = () => {
    sheet.style.transform = `translateY(${-dy}px)`;
    a.cancel();
    if (scrim) {
      scrim.getAnimations().forEach((x) => x.cancel());
      scrim.style.opacity = '0';
    }
    done();
  };
}
import { isPhone } from './layout';

/** The sheet's spring: fast out of the gate, one small overshoot (1.55 %, under the 2 % cap), a soft settle. */
export const SHEET_SPRING = 'cubic-bezier(0.3, 1.22, 0.6, 1)';
/** Kept for older call sites: the same spring. */
export const SHEET_EASE = SHEET_SPRING;

/** The grab handle: a short hairline, centred at the top of the sheet (hidden off phones by CSS). */
export function grabHandle(testid?: string): HTMLDivElement {
  const g = h('div', 'grab');
  g.setAttribute('aria-hidden', 'true');
  if (testid) g.dataset.testid = testid;
  g.append(h('i'));
  return g;
}

/** Slide a sheet up from the bottom edge (and fade its scrim in). */
export function sheetIn(sheet: HTMLElement, scrim?: HTMLElement | null): void {
  resetSheet(sheet);
  if (scrim) scrim.style.opacity = '';
  if (typeof sheet.animate !== 'function') return;
  sheet.getAnimations().forEach((a) => a.cancel());
  // Reduced motion: the sheet is simply there (v4 §7.15: sheets still arrive, instantly).
  if (motion.reduced) return;
  sheet.animate([{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }], { duration: 280, easing: SHEET_SPRING });
  scrim?.animate([{ backgroundColor: 'rgba(8, 13, 27, 0)' }, {}], { duration: 240, easing: 'ease-out' });
}

/** Clear what a slide-out left behind (parked transform / opacity). */
export function resetSheet(sheet: HTMLElement): void {
  sheet.style.transform = '';
  sheet.style.opacity = '';
}

/** Slide a sheet back down (from wherever a drag left it), fade the scrim, then `done`. */
export function sheetOut(sheet: HTMLElement, scrim: HTMLElement | null | undefined, done: () => void, fromPx?: number): void {
  if (typeof sheet.animate !== 'function') return done();
  // Reduced motion: gone at once (parked hidden until the owner hides it), no travel, no fade.
  if (motion.reduced) {
    sheet.getAnimations().forEach((x) => x.cancel());
    sheet.style.opacity = '0';
    if (scrim) scrim.style.opacity = '0';
    return done();
  }
  const from = fromPx ?? currentY(sheet);
  const H = sheet.getBoundingClientRect().height || 400;
  const ms = Math.round(Math.max(140, Math.min(240, 240 * (1 - from / H))));
  const a = sheet.animate([{ transform: `translateY(${from}px)` }, { transform: 'translateY(100%)' }], { duration: ms, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' });
  scrim?.animate([{ opacity: scrim.style.opacity || 1 }, { opacity: 0 }], { duration: ms, easing: 'ease-in', fill: 'forwards' });
  a.onfinish = () => {
    // Stays parked off-screen until the owner hides it (and sheetIn brings it back): no flash.
    sheet.style.transform = 'translateY(100%)';
    a.cancel();
    if (scrim) {
      scrim.getAnimations().forEach((x) => x.cancel());
      scrim.style.opacity = '0';
    }
    done();
  };
}

function currentY(el: HTMLElement): number {
  const m = /translateY\((-?[\d.]+)px\)/.exec(el.style.transform);
  return m ? Number(m[1]) : 0;
}

export interface DragOpts {
  /** The drag only runs when this is true (phones). Default: isPhone(). */
  enabled?: () => boolean;
  /** The scrim that fades as the sheet is pulled down. */
  scrim?: () => HTMLElement | null;
  /** Called once the sheet has slid off (it sits at translateY(100%) until the owner hides it). */
  onDismiss: () => void;
}

/**
 * Drag-down-to-dismiss on the sheet's grab handle and header. A tap on a button inside a grip still
 * clicks; the drag starts after 6 px. Released past ~28 % of the sheet (or flicked down) it slides away
 * and calls onDismiss; otherwise it springs back.
 */
export function dragToDismiss(sheet: HTMLElement, grips: HTMLElement[], opts: DragOpts): void {
  const enabled = opts.enabled ?? isPhone;
  let start: { y: number; id: number; t: number } | null = null;
  let dragging = false;
  let samples: { y: number; t: number }[] = [];
  let H = 1;
  const down = (e: PointerEvent) => {
    if (!enabled() || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (e.target instanceof Element && e.target.closest('button, input, [role="slider"]')) return;
    start = { y: e.clientY, id: e.pointerId, t: e.timeStamp };
    dragging = false;
    samples = [{ y: e.clientY, t: e.timeStamp }];
    H = sheet.getBoundingClientRect().height || 400;
  };
  const move = (e: PointerEvent) => {
    if (!start || e.pointerId !== start.id) return;
    const dy = e.clientY - start.y;
    if (!dragging) {
      if (Math.abs(dy) < 6) return;
      dragging = true;
      sheet.getAnimations().forEach((a) => a.cancel());
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        /* capture is best-effort */
      }
    }
    e.preventDefault();
    // Down follows the finger; up resists (a rubber band of a fifth).
    const y = dy >= 0 ? dy : dy * 0.2;
    sheet.style.transform = `translateY(${y}px)`;
    const s = opts.scrim?.();
    if (s) s.style.opacity = String(Math.max(0, 1 - Math.max(0, y) / H));
    samples.push({ y: e.clientY, t: e.timeStamp });
    if (samples.length > 6) samples.shift();
  };
  const up = (e: PointerEvent) => {
    if (!start || e.pointerId !== start.id) return;
    const st = start;
    start = null;
    if (!dragging) return;
    dragging = false;
    const dy = Math.max(0, e.clientY - st.y);
    const a = samples[0];
    const v = a && e.timeStamp > a.t ? (e.clientY - a.y) / (e.timeStamp - a.t) : 0; // px / ms
    if (dy > Math.min(H * 0.28, 180) || (v > 0.55 && dy > 24)) {
      sheetOut(sheet, opts.scrim?.(), () => opts.onDismiss(), dy);
    } else {
      const from = currentY(sheet);
      sheet.style.transform = '';
      const s = opts.scrim?.();
      if (s) s.style.opacity = '';
      if (!motion.reduced && typeof sheet.animate === 'function')
        sheet.animate([{ transform: `translateY(${from}px)` }, { transform: 'translateY(0)' }], { duration: 300, easing: SHEET_SPRING });
    }
  };
  for (const g of grips) {
    g.addEventListener('pointerdown', down);
    g.addEventListener('pointermove', move);
    g.addEventListener('pointerup', up);
    g.addEventListener('pointercancel', up);
    g.style.touchAction = 'none';
  }
}
