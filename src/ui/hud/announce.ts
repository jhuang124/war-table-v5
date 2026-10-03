// The one banner slot (docs/INK.md B2.6, A5): no banners any more, one serif line brushed onto the
// paper where the strip's line sits, just above the gold rule. It is drawn in, holds, and dries; it
// never takes input and never makes anyone wait (a press anywhere on the UI dismisses a turn line).
//   turn          'John · 3 armies' (v4: the grudge is the receipt's now, never a second line here)
//   continent     'John holds Asia · +7'
//   elimination   'Sam · taken by John · round 9' (the epitaph)
// While it shows, the strip's own line steps aside (root class `has-say`). The controller owns timing.

import type { BannerVM } from '../../game/viewModel';
import { PLAYER_COLORS } from '../../shared/palette';
import { drawIn, EASE_IN_QUAD, h, minus, motion, setStyle } from '../dom';

/** A replacement never waits longer than this for the outgoing line: the old one is cut short. */
const CUT_MS = 120;

/** 'JOHN'S TURN' + '+3 armies' → 'John · 3 armies' for controllers that don't send `line` yet. */
function fallbackLine(b: BannerVM): string {
  const name = b.seat?.name ?? '';
  if (b.kind === 'turn') {
    const n = /\d+/.exec(b.sub ?? '');
    return n ? `${name} · ${n[0]} ${n[0] === '1' ? 'army' : 'armies'}` : name;
  }
  const t = b.title.toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export class Announcements {
  readonly el: HTMLElement;
  private shownId = -1;
  private shownEl: HTMLElement | null = null;
  private outgoing: Animation[] = [];
  /**
   * Called with true while a line shows (the root steps the strip's line aside). On arrival it returns
   * how long to wait before brushing in: the line that was in the slot dries first (never two lines).
   */
  onShow: ((on: boolean) => number | void) | null = null;

  constructor() {
    this.el = h('div', 'announce');
  }

  private leave(el: HTMLElement, ms: number): Animation {
    el.classList.add('leaving');
    const a = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: EASE_IN_QUAD, fill: 'forwards' });
    a.onfinish = () => el.remove();
    return a;
  }

  /** Cut whatever is still leaving so the next line enters alone; returns the wait in ms. */
  private clearStage(): number {
    let wait = 0;
    this.outgoing = this.outgoing.filter((a) => a.playState === 'running');
    for (const a of this.outgoing) {
      const dur = Number(a.effect?.getTiming().duration) || 0;
      const left = (dur - Number(a.currentTime ?? 0)) / (a.playbackRate || 1);
      if (left > CUT_MS) a.playbackRate *= left / CUT_MS;
      wait = Math.max(wait, Math.min(left, CUT_MS));
    }
    return Math.max(0, Math.round(wait));
  }

  update(b: BannerVM | null): void {
    const id = b?.id ?? -1;
    if (id === this.shownId) return;
    const fast = !!b && b.holdMs <= 700;
    // Dismissed (no next line): the line dries quickly and the strip's own line comes back only once
    // it has mostly gone, so the two never sit on the same baseline at once.
    const leaveMs = !b ? 150 : fast ? 150 : 300;
    if (this.shownEl) this.outgoing.push(this.leave(this.shownEl, leaveMs));
    const had = !!this.shownEl;
    this.shownEl = null;
    this.shownId = id;
    if (!b) {
      if (!had || motion.reduced) this.onShow?.(false);
      else
        // Only once the breath line has fully dried does the strip's line come back.
        setTimeout(() => {
          if (this.shownId === -1) this.onShow?.(false);
        }, leaveMs);
      return;
    }
    const clear = this.onShow?.(true) || 0;
    const delay = Math.max(this.clearStage(), clear);
    const el = this.build(b);
    this.el.append(el);
    this.shownEl = el;
    if (motion.reduced) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, delay, fill: 'backwards' });
    else {
      // The line is brushed on, then the grudge under it a beat later.
      const main = el.querySelector<HTMLElement>('.rb-title');
      const recap = el.querySelector<HTMLElement>('.rb-recap');
      if (main) drawIn(main, fast ? 180 : 300, delay);
      if (recap) drawIn(recap, fast ? 180 : 260, delay + (fast ? 60 : 160));
    }
  }

  private build(b: BannerVM): HTMLElement {
    const el = h('div', `ribbon banner-${b.kind}`);
    el.dataset.testid = 'banner';
    const pal = b.seat ? PLAYER_COLORS[b.seat.color] : null;
    setStyle(el, '--seat-light', pal ? pal.light : 'var(--ivory)');
    const text = minus(b.line ?? fallbackLine(b));
    const t = h('div', 'rb-title num');
    // The seat's name (the first words, up to the first ' · ') in its own wash; the rest in ivory.
    const cut = b.seat && text.startsWith(b.seat.name) ? b.seat.name.length : 0;
    if (cut) t.append(h('span', 'rb-name', text.slice(0, cut)), document.createTextNode(text.slice(cut)));
    else t.textContent = text;
    el.append(t);
    // v4 Q4: one line above the rule. The grudge (`recap`) is the receipt's to tell now ('While you were
    // away'), so it is never a second line under the turn line; screen readers still hear it.
    if (b.recap) el.append(h('span', 'sr-only', ` ${minus(b.recap)}`));
    return el;
  }
}
