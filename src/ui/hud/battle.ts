// The dice tray's header (docs/ROUND2.md §E, INK.md B5): serif words on the paper above the tray while a
// fight is armed or rolling, 'Kamchatka 6 · Alaska 4', each name in its owner's wash; on a conquest it
// reads 'Siberia captured' for its last second, then dries out (300 ms). The renderer draws the tray and the dice; the odds live in
// the bottom strip's line.

import type { BattleSideVM, BattleVM } from '../../game/viewModel';
import { PLAYER_COLORS } from '../../shared/palette';
import { drawIn, EASE_IN_QUAD, h, pop, setStyle, setText, toggle } from '../dom';

class Side {
  readonly el: HTMLSpanElement;
  private terr: HTMLSpanElement;
  private armies: HTMLSpanElement;
  private last = -1;
  constructor(cls: string) {
    this.el = h('span', `bt-side ${cls}`);
    this.terr = h('span', 'bt-terr');
    this.armies = h('span', 'bt-armies num');
    this.el.append(this.terr, this.armies);
  }
  update(s: BattleSideVM): void {
    setStyle(this.el, '--seat-light', PLAYER_COLORS[s.seat.color].light);
    setText(this.terr, s.territory);
    if (s.armies !== this.last) {
      if (this.last >= 0) pop(this.armies, 1.2, 160);
      this.last = s.armies;
      setText(this.armies, String(s.armies));
    }
  }
  reset(): void {
    this.last = -1;
  }
}

export class BattleHeader {
  readonly el: HTMLElement;
  private att = new Side('bt-att');
  private def = new Side('bt-def');
  private vs: HTMLSpanElement;
  private captured: HTMLSpanElement;
  private vm: BattleVM | null = null;
  private shown = false;

  constructor() {
    this.el = h('section', 'battle hidden');
    this.el.dataset.testid = 'battle';
    this.el.setAttribute('aria-label', 'Battle');
    const head = h('div', 'bt-head');
    this.vs = h('span', 'bt-vs', '·');
    this.captured = h('span', 'bt-captured hidden');
    this.captured.dataset.testid = 'battle-captured';
    head.append(this.att.el, this.vs, this.def.el, this.captured);
    this.el.append(head);
  }

  update(vm: BattleVM | null): void {
    if (vm === this.vm) return;
    this.vm = vm;
    if (!vm) {
      if (!this.shown) return;
      this.shown = false;
      this.el.classList.add('leaving');
      const a = this.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, easing: EASE_IN_QUAD, fill: 'forwards' });
      a.onfinish = () => {
        if (!this.shown) {
          this.el.classList.add('hidden');
          this.el.classList.remove('leaving');
          this.att.reset();
          this.def.reset();
        }
        a.cancel();
      };
      return;
    }
    // The header rides in and out with the tray (styles.css): an armed fight alone would float mid-board.
    const noTray = !vm.tray && !vm.rolling && !vm.captured;
    if (!this.shown) {
      this.shown = true;
      this.el.getAnimations().forEach((a) => a.cancel());
      this.el.classList.remove('hidden', 'leaving');
      // (A draw-in's opacity would override .no-tray: armed-only, the header waits for the tray's fade.)
      if (!noTray) drawIn(this.el, 220);
    }
    toggle(this.el, 'no-tray', noTray);
    // v4: on desktop the ring sits beside the fight; the header rides on its top rim
    const r = vm.trayRect;
    if (r) {
      this.el.style.left = `${r.x + r.w / 2}px`;
      const h = this.el.offsetHeight || 28;
      const above = r.y - h - 4;
      // under the seat strip (≈ 64 px) the header goes below the ring instead
      this.el.style.top = `${above >= 68 ? above : r.y + r.h + 4}px`;
      this.el.style.bottom = 'auto';
    } else if (this.el.style.top) {
      this.el.style.left = '';
      this.el.style.top = '';
      this.el.style.bottom = '';
    }
    this.att.update(vm.attacker);
    this.def.update(vm.defender);
    const cap = vm.captured;
    const was = !this.captured.classList.contains('hidden');
    for (const el of [this.att.el, this.vs, this.def.el]) toggle(el, 'hidden', !!cap);
    toggle(this.captured, 'hidden', !cap);
    if (cap) {
      setStyle(this.captured, '--seat-light', PLAYER_COLORS[vm.attacker.seat.color].light);
      setText(this.captured, cap);
      if (!was) drawIn(this.captured, 220);
    }
  }
}
