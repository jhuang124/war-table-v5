// Reusable controls: action buttons (ButtonVM), plain UI buttons, segmented words, switches, the volume
// slider. Ink on paper (docs/INK2.md §3): controls are words, hairlines and brush marks; no box, no
// pill. The primary is a word inside a brush ring (gold when it holds the one gold: class `gold`, with
// `brass` kept as an alias for older selectors); a secondary is a bare word. Every control keeps an
// invisible hit box of at least 44×44 px (the element itself, transparent). One serif, lining figures.

import type { ButtonVM } from '../game/viewModel';
import { drawEnso, h, hashSeed, motion, ringEl, setAttr, setRing, setText, toggle, underlineEl } from './dom';

/**
 * The brush ring behind a primary word (INK2 §3.1): sized to the word (and a Continue sub-line), at
 * least as tall as the hit box, stretched with the box up to 3:1, and never narrower than the word
 * (beyond 3:1 it grows taller instead). Shown by CSS only on `.role-primary` / `.gold`.
 */
const ringed = new WeakMap<HTMLElement, { svg: SVGSVGElement; seed: number }>();
let ringRO: ResizeObserver | null = null;
function fitRing(b: HTMLElement): void {
  const r = ringed.get(b);
  if (!r || !b.isConnected) return;
  const bw = b.clientWidth;
  const bh = b.clientHeight;
  if (!bw || !bh) return;
  // The ink it rings: every child but the ring (the label, and a sub-line when there is one).
  let l = Infinity;
  let t = Infinity;
  let rr = -Infinity;
  let bb = -Infinity;
  const box = b.getBoundingClientRect();
  for (const c of b.children) {
    if (c === r.svg || !(c instanceof HTMLElement) || c.offsetParent === null || c.classList.contains('ring-skip')) continue;
    const q = c.getBoundingClientRect();
    if (!q.width) continue;
    l = Math.min(l, q.left);
    t = Math.min(t, q.top);
    rr = Math.max(rr, q.right);
    bb = Math.max(bb, q.bottom);
  }
  if (!isFinite(l)) return;
  const em = parseFloat(getComputedStyle(b).fontSize) || 18;
  const cw = rr - l;
  const ch = bb - t;
  const cx = (l + rr) / 2 - box.left;
  const cy = (t + bb) / 2 - box.top;
  // The ellipse must hold the words' box with room: (cw/W)² + (ch/H)² ≤ K (the brush sits a little
  // inside its own box, hence well under 1).
  const K = 0.66;
  let H = Math.max(Math.min(bh + 4, em * 2.8), ch + em * 1.1);
  if (K - (ch / H) ** 2 < 0.22) H = ch / Math.sqrt(K - 0.22);
  let W = Math.max(cw / Math.sqrt(K - (ch / H) ** 2), cw + em * 1.9, H * 1.45, Math.min(bw - 6, H * 3));
  if (W / H > 3) {
    // Beyond 3:1 the ring stays 3:1 and grows taller round the words.
    H = Math.max(H, Math.sqrt((cw * cw) / 9 + ch * ch) / Math.sqrt(K));
    W = Math.max(W, H * 3);
    H = W / 3;
  }
  const s = r.svg;
  s.style.width = `${W.toFixed(1)}px`;
  s.style.height = `${H.toFixed(1)}px`;
  s.style.left = `${(cx - W / 2).toFixed(1)}px`;
  s.style.top = `${(cy - H / 2).toFixed(1)}px`;
  setRing(s, r.seed, W / H, { weight: 0.95, drawable: true });
}

/** Give a word-button its brush ring (idempotent). `seed` defaults to a hash of its test id or label. */
export function attachRing(b: HTMLElement, seed?: number): SVGSVGElement {
  const had = ringed.get(b);
  const sd = seed ?? hashSeed(b.dataset.testid ?? b.textContent ?? 'btn');
  if (had) {
    if (had.seed !== sd) {
      had.seed = sd;
      fitRing(b);
    }
    return had.svg;
  }
  const s = ringEl(sd, 2, undefined, { cls: 'btn-ring', weight: 0.95, drawable: true });
  b.prepend(s);
  ringed.set(b, { svg: s, seed: sd });
  ringRO ??= new ResizeObserver((es) => {
    for (const e of es) {
      const t = e.target as HTMLElement;
      fitRing(ringed.has(t) ? t : (t.parentElement as HTMLElement));
    }
  });
  ringRO.observe(b);
  for (const c of b.children) if (c !== s) ringRO.observe(c);
  return s;
}

/** Re-fit a ring after its words changed (a label swap that kept the box size). */
export function refitRing(b: HTMLElement): void {
  if (ringed.has(b)) fitRing(b);
}

/** The busy state (a short hold): the ring redraws itself once along its spine, instead of a sweep. */
function ringBusy(b: HTMLElement): void {
  const r = ringed.get(b);
  if (r && !motion.reduced) drawEnso(r.svg, 700);
}

/** A button bound to a ButtonVM. No keycaps: the keyboard is a hidden accelerator. */
export class ActionButton {
  readonly el: HTMLButtonElement;
  private labelEl: HTMLSpanElement;
  vm: ButtonVM | null = null;

  constructor(onPress: (vm: ButtonVM) => void) {
    this.el = h('button', 'btn nofocus');
    this.el.type = 'button';
    this.labelEl = h('span', 'btn-label');
    this.el.append(this.labelEl);
    attachRing(this.el, 1);
    this.el.addEventListener('click', () => {
      const vm = this.vm;
      if (!vm || vm.busy) return;
      onPress(vm);
    });
  }

  private gold = false;

  update(vm: ButtonVM, gold = vm.primary): void {
    if (this.vm === vm && this.gold === gold) return;
    const wasBusy = !!this.vm?.busy;
    const relabel = this.vm?.label !== vm.label;
    this.vm = vm;
    this.gold = gold;
    setText(this.labelEl, vm.label);
    this.el.className = `btn nofocus ${gold ? 'role-primary gold brass' : vm.primary ? 'role-primary' : 'role-secondary'}${vm.busy ? ' is-busy' : ''}`;
    setAttr(this.el, 'data-id', vm.id);
    setAttr(this.el, 'data-testid', `btn-${vm.id}`);
    attachRing(this.el, hashSeed(`btn-${vm.id}`));
    if (relabel) refitRing(this.el);
    if (vm.busy && !wasBusy) ringBusy(this.el);
  }
}

/**
 * A plain UI button (menus, dialogs). `brass` in `cls` is the gold primary (a `gold` class is added).
 * Keycaps are gone (the keyboard is a hidden accelerator); the parameter stays for call-site shape.
 */
export function uiButton(label: string, cls: string, onClick: () => void, _keycap?: string, testid?: string): HTMLButtonElement {
  const b = h('button', `btn ${cls}${/\bbrass\b/.test(cls) ? ' gold' : ''}`);
  b.type = 'button';
  if (testid) b.dataset.testid = testid;
  b.append(h('span', 'btn-label', label));
  // A primary word carries its brush ring (CSS shows it only while the button is a primary / the gold).
  if (/\b(brass|role-primary|ringable)\b/.test(cls)) attachRing(b, hashSeed(testid ?? label));
  b.addEventListener('click', () => {
    if (b.getAttribute('aria-disabled') === 'true') return;
    onClick();
  });
  return b;
}

export interface SegOption<T extends string | number> {
  value: T;
  label: string;
  detail?: string;
  meta?: string;
  disabled?: boolean;
}

/** Segmented control: a row of options, one selected. Keyboard: arrows move within. */
export class Segmented<T extends string | number> {
  readonly el: HTMLDivElement;
  private buttons = new Map<T, HTMLButtonElement>();
  private value: T | null = null;
  private opts: SegOption<T>[] = [];

  constructor(cls: string, private onPick: (v: T) => void, ariaLabel: string, private testid?: string) {
    this.el = h('div', `seg ${cls}`);
    if (testid) this.el.dataset.testid = testid;
    this.el.setAttribute('role', 'radiogroup');
    this.el.setAttribute('aria-label', ariaLabel);
  }

  setOptions(opts: SegOption<T>[]): void {
    const same =
      opts.length === this.opts.length &&
      opts.every((o, i) => {
        const p = this.opts[i];
        return p.value === o.value && p.label === o.label && p.detail === o.detail && p.meta === o.meta && p.disabled === o.disabled;
      });
    if (same) return;
    this.opts = opts;
    this.el.textContent = '';
    this.buttons.clear();
    for (const o of opts) {
      const b = h('button', 'seg-opt');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      if (this.testid) b.dataset.testid = `${this.testid}-${o.value}`;
      const l = h('span', 'seg-label', o.label);
      // The active option's brush underline ("this one", ivory 70 %): under the label.
      l.append(underlineEl(hashSeed(`${this.testid ?? 'seg'}-${o.value}`), undefined, 'brush-ul seg-ul'));
      b.append(l);
      if (o.detail) b.append(h('span', 'seg-detail', o.detail));
      if (o.meta) b.append(h('span', 'seg-meta', o.meta));
      if (o.disabled) b.setAttribute('aria-disabled', 'true');
      b.addEventListener('click', () => {
        if (o.disabled || this.value === o.value) return;
        this.onPick(o.value);
      });
      b.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const i = this.opts.findIndex((x) => x.value === o.value);
        const n = this.opts[(i + (e.key === 'ArrowRight' ? 1 : this.opts.length - 1)) % this.opts.length];
        if (!n.disabled) {
          this.onPick(n.value);
          this.buttons.get(n.value)?.focus();
        }
      });
      this.buttons.set(o.value, b);
      this.el.append(b);
    }
    const v = this.value;
    this.value = null;
    if (v !== null) this.set(v);
  }

  set(v: T): void {
    if (this.value === v) return;
    this.value = v;
    for (const [k, b] of this.buttons) {
      const on = k === v;
      toggle(b, 'on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
  }
}

/** On/off switch with a label. */
export class Switch {
  readonly el: HTMLButtonElement;
  private on: boolean | null = null;
  constructor(label: string, private onFlip: (v: boolean) => void, detail?: string, testid?: string) {
    this.el = h('button', 'switch');
    if (testid) this.el.dataset.testid = testid;
    this.el.type = 'button';
    this.el.setAttribute('role', 'switch');
    const text = h('span', 'switch-text');
    text.append(h('span', 'switch-label', label));
    if (detail) text.append(h('span', 'switch-detail', detail));
    // A short hairline with a small brush-ring knob that slides (INK2 §3.3).
    const track = h('span', 'switch-track');
    const knob = h('span', 'switch-knob');
    knob.append(ringEl(hashSeed(`switch-${testid ?? label}`), 1, undefined, { cls: 'knob-ring', weight: 1.5 }));
    track.append(knob);
    this.el.append(text, track);
    this.el.addEventListener('click', () => this.onFlip(!this.on));
  }
  set(v: boolean): void {
    if (this.on === v) return;
    this.on = v;
    toggle(this.el, 'on', v);
    this.el.setAttribute('aria-checked', v ? 'true' : 'false');
  }
}

/** Custom slider (0..1) built from divs: pointer drag + arrow keys. */
export class Slider {
  readonly el: HTMLDivElement;
  private fill: HTMLDivElement;
  private knob: HTMLDivElement;
  private v = -1;
  constructor(label: string, private onSet: (v: number) => void) {
    this.el = h('div', 'slider');
    this.el.tabIndex = 0;
    this.el.setAttribute('role', 'slider');
    this.el.setAttribute('aria-label', label);
    this.el.setAttribute('aria-valuemin', '0');
    this.el.setAttribute('aria-valuemax', '100');
    const track = h('div', 'slider-track');
    this.fill = h('div', 'slider-fill');
    this.knob = h('div', 'slider-knob');
    this.knob.append(ringEl(hashSeed(`slider-${label}`), 1, undefined, { cls: 'knob-ring', weight: 1.5 }));
    track.append(this.fill, this.knob);
    this.el.append(track);
    const fromEvent = (e: PointerEvent) => {
      const r = track.getBoundingClientRect();
      const v = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      this.onSet(Math.round(v * 20) / 20);
    };
    this.el.addEventListener('pointerdown', (e) => {
      this.el.setPointerCapture(e.pointerId);
      fromEvent(e);
      const move = (ev: PointerEvent) => fromEvent(ev);
      const up = () => {
        this.el.removeEventListener('pointermove', move);
        this.el.removeEventListener('pointerup', up);
        this.el.removeEventListener('pointercancel', up);
      };
      this.el.addEventListener('pointermove', move);
      this.el.addEventListener('pointerup', up);
      this.el.addEventListener('pointercancel', up);
    });
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') this.onSet(Math.max(0, Math.round((this.v - 0.05) * 20) / 20));
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') this.onSet(Math.min(1, Math.round((this.v + 0.05) * 20) / 20));
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
  }
  set(v: number): void {
    if (this.v === v) return;
    this.v = v;
    const pct = `${Math.round(v * 100)}%`;
    this.fill.style.width = pct;
    this.knob.style.left = pct;
    this.el.setAttribute('aria-valuenow', String(Math.round(v * 100)));
  }
}

/**
 * v5.1 (QUIETER §3 D, E3): the one word 'More' that folds the rest of a sheet open in place (New game,
 * Settings). A bare serif word at 18 px, ivory 70 %; open, it carries the brush underline (the same mark as a
 * chosen word) and reads at full ivory. Never a chevron, a box or a disclosure triangle.
 */
export function moreWord(testid: string, onClick: () => void): HTMLButtonElement {
  const b = h('button', 'more-word nofocus');
  b.type = 'button';
  b.dataset.testid = testid;
  b.setAttribute('aria-expanded', 'false');
  const label = h('span', 'more-label', 'More');
  label.append(underlineEl(hashSeed(`more:${testid}`), undefined, 'brush-ul more-ul'));
  b.append(label);
  b.addEventListener('click', onClick);
  return b;
}

/** Reflect the fold's state on its 'More' word. */
export function setMoreWord(b: HTMLButtonElement, open: boolean): void {
  toggle(b, 'open', open);
  b.setAttribute('aria-expanded', String(open));
}
