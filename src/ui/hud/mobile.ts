// Phone-only HUD pieces (docs/MOBILE.md §1, §3):
//   RotatePill — the one-time `Rotate for the full map` line on a portrait phone, in the dock's line
//                slot; it dries after 4 s, at the first touch, or on rotating; never shown again.
//   NameCard   — the long-press lines above the finger: territory, continent + bonus, owner, armies,
//                serif words on the paper with a soft deepening behind them (no box, INK2 §3.3).
//                Driven by the board's long-press callback through GameVM.nameCard; releasing hides it.
//                v4 §7.3 (desktop, a click on any territory): the same lines with the name large, brushed
//                in beside the pointer, held one second, then drying out on their own.

import type { NameCardVM } from '../../game/viewModel';
import { PLAYER_COLORS } from '../../shared/palette';
import { animateIn, animateOut, drawIn, EASE_IN_QUAD, emblem, h, motion, setStyle, setText, toggle } from '../dom';
import { layout } from '../layout';

/** Desktop: the name card holds this long after a click, then dries (v4 §7.3: "one second"). */
const DESK_HOLD_MS = 1000;
const DESK_DRY_MS = 360;

const ROTATE_KEY = 'risk3d.rotateHint.v1';

function seen(): boolean {
  try {
    return localStorage.getItem(ROTATE_KEY) === '1';
  } catch {
    return false;
  }
}
function markSeen(): void {
  try {
    localStorage.setItem(ROTATE_KEY, '1');
  } catch {
    /* private mode: shows again next time, which is fine */
  }
}

/** The hint waits this long after the slot is claimed, so whatever was on the line has dried first. */
const HINT_ENTER_MS = 320;
/** It dries by itself after this long on the paper (or at the first touch). */
const HINT_HOLD_MS = 4000;

/**
 * The one-time rotate hint (INK F3): one serif line on the paper in the dock's line slot, never a pill
 * over the board. Shown once per device, on the first portrait game screen that has nothing else to
 * say (no turn line, roll, hand-off, sheet or victory); it dries out after 4 s, at the first touch, or
 * when any of those arrive. No ×: drying is the dismissal.
 */
export class RotatePill {
  readonly el: HTMLDivElement;
  private text: HTMLSpanElement;
  private shown = false;
  private timer = 0;
  private enterT = 0;
  private out: Animation | null = null;
  /** True while the hint owns the line slot (the strip's own line steps aside). */
  onShow: ((on: boolean) => void) | null = null;
  private onTouch = () => this.dismiss();

  constructor() {
    this.el = h('div', 'rotate-hint hidden');
    this.el.setAttribute('role', 'status');
    this.el.dataset.testid = 'rotate-pill';
    this.text = h('span', 'rh-text', 'Rotate for the full map');
    this.el.append(this.text);
  }

  /** Something (the hint or a drying hint) is in the line slot. */
  get busy(): boolean {
    return this.shown || this.out?.playState === 'running';
  }

  /**
   * Call on every render. `quiet`: the game screen with nothing else happening in the slot or on the
   * board; `phonePortrait`: the layout. Anything else arriving dries the hint.
   */
  update(quiet: boolean, phonePortrait: boolean): void {
    if (this.shown) {
      if (!quiet || !phonePortrait) this.dismiss();
      return;
    }
    if (!quiet || !phonePortrait || seen()) return;
    this.shown = true;
    markSeen();
    // Claim the slot now (the strip's line dries, 160 ms); brush in once it has gone.
    this.onShow?.(true);
    this.out?.cancel();
    this.out = null;
    this.el.classList.remove('hidden');
    this.text.style.opacity = '0';
    window.clearTimeout(this.enterT);
    this.enterT = window.setTimeout(() => {
      if (!this.shown) return;
      this.text.style.opacity = '';
      drawIn(this.text, 300);
      this.timer = window.setTimeout(() => this.dismiss(), HINT_HOLD_MS);
      window.addEventListener('pointerdown', this.onTouch, { capture: true, passive: true });
    }, motion.reduced ? 0 : HINT_ENTER_MS);
  }

  dismiss(): void {
    if (!this.shown) return;
    this.shown = false;
    window.clearTimeout(this.timer);
    window.clearTimeout(this.enterT);
    window.removeEventListener('pointerdown', this.onTouch, { capture: true });
    const done = () => {
      this.el.classList.add('hidden');
      this.text.style.opacity = '';
      this.onShow?.(false);
    };
    if (motion.reduced || this.text.style.opacity === '0' || typeof this.el.animate !== 'function') return done();
    // It dries (easeInQuad), then the strip's line comes back.
    const a = (this.out = this.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 240, easing: EASE_IN_QUAD, fill: 'forwards' }));
    a.onfinish = () => {
      if (this.shown) return;
      a.cancel();
      done();
    };
  }
}

export class NameCard {
  readonly el: HTMLDivElement;
  private title: HTMLDivElement;
  private cont: HTMLDivElement;
  private owner: HTMLDivElement;
  private ownerName: HTMLSpanElement;
  private emb: HTMLSpanElement;
  private armies: HTMLSpanElement;
  private key = -1;
  private deskT = 0;
  private deskUntil = 0;

  constructor() {
    this.el = h('div', 'name-card hidden');
    this.el.setAttribute('role', 'tooltip');
    this.title = h('div', 'nc-title');
    this.cont = h('div', 'nc-cont num');
    this.owner = h('div', 'nc-owner');
    this.emb = h('span', 'nc-emb');
    this.ownerName = h('span', 'nc-name');
    this.armies = h('span', 'nc-armies num');
    this.owner.append(this.emb, this.ownerName, this.armies);
    this.el.append(this.title, this.cont, this.owner, h('i', 'nc-nub'));
  }

  /** Desktop: the card dries out by itself after its second (the controller's clear never cuts it short). */
  private dryDesk(): void {
    window.clearTimeout(this.deskT);
    this.deskUntil = 0;
    if (this.key === -1) return;
    this.key = -1;
    delete this.el.dataset.testid;
    if (motion.reduced) return void this.el.classList.add('hidden');
    const a = this.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: DESK_DRY_MS, easing: EASE_IN_QUAD, fill: 'forwards' });
    a.onfinish = () => {
      if (this.key === -1) this.el.classList.add('hidden');
      a.cancel();
    };
  }

  update(vm: NameCardVM | null | undefined): void {
    const desk = !layout.touch;
    toggle(this.el, 'desk', desk);
    if (desk && !vm && performance.now() < this.deskUntil) return;
    if (!vm) {
      if (desk) return this.dryDesk();
      if (this.key !== -1) {
        this.key = -1;
        delete this.el.dataset.testid;
        animateOut(this.el, { dy: 4, ms: 110, remove: false }, () => {
          if (this.key === -1) this.el.classList.add('hidden');
        });
      }
      return;
    }
    const fresh = vm.key !== this.key;
    this.key = vm.key;
    this.el.dataset.testid = 'name-card';
    setText(this.title, vm.territory);
    setText(this.cont, `${vm.continent} · +${vm.bonus}`);
    this.emb.textContent = '';
    if (vm.owner) this.emb.append(emblem(vm.owner.color));
    setText(this.ownerName, vm.owner ? vm.owner.name : 'Unclaimed');
    setText(this.armies, vm.armies === 1 ? '1 army' : `${vm.armies} armies`);
    setStyle(this.el, '--seat', vm.owner ? PLAYER_COLORS[vm.owner.color].base : 'var(--brass)');
    this.el.classList.remove('hidden');
    // Above the finger (a thumb covers ~40 px), clamped inside the safe screen; flips below near the top.
    const r = this.el.getBoundingClientRect();
    const W = window.innerWidth;
    const w = r.width || 200;
    const hgt = r.height || 90;
    // Above the finger; below it near the top pills; beside it when neither fits (a short landscape
    // screen), so it never covers the top pills or the dock.
    const H = window.innerHeight;
    const top = document.querySelector('.topstrip')?.getBoundingClientRect().bottom ?? 0;
    const dockEl = document.querySelector('.strip');
    const dockTop = dockEl && (dockEl as HTMLElement).offsetParent !== null ? dockEl.getBoundingClientRect().top : H;
    const minY = Math.max(12, top + 6);
    const maxY = dockTop - 6;
    let mode: 'above' | 'below' | 'side' = 'above';
    if (vm.y - 56 - hgt < minY) mode = vm.y + 48 + hgt <= maxY ? 'below' : 'side';
    let left: number;
    let y: number;
    if (mode === 'side') {
      const right = vm.x + 40 + w <= W - 10;
      left = right ? vm.x + 40 : vm.x - 40 - w;
      y = Math.max(minY, Math.min(maxY - hgt, vm.y - hgt / 2));
    } else {
      left = Math.max(10, Math.min(W - 10 - w, vm.x - w / 2));
      y = mode === 'below' ? vm.y + 48 : vm.y - 56 - hgt;
    }
    toggle(this.el, 'below', mode === 'below');
    toggle(this.el, 'side', mode === 'side');
    this.el.style.left = `${Math.round(left)}px`;
    this.el.style.top = `${Math.round(y)}px`;
    setStyle(this.el, '--nub-x', `${Math.round(vm.x - left)}px`);
    const below = mode === 'below';
    if (fresh && desk) {
      // Brushed in large, held one second, then dried out.
      this.el.getAnimations().forEach((a) => a.cancel());
      drawIn(this.title, 260);
      window.clearTimeout(this.deskT);
      this.deskUntil = performance.now() + DESK_HOLD_MS;
      this.deskT = window.setTimeout(() => this.dryDesk(), DESK_HOLD_MS);
    } else if (fresh) animateIn(this.el, { dy: below ? -6 : 6, ms: 150, scale: 0.96 });
  }
}
