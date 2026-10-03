// The bottom of the board (docs/INK2.md §3.1, frame 5): the one line on the paper, the gold hairline rule
// across the width with the game's ensō sitting on it above the current phase word, and under it the
// Turn Track as four words with the action words beside them. Desktop also shows the seat mark at the
// far left (a brush dab in the seat's colour and its name).
//                         Ural → Siberia · 64% · likely
//   ─────────────────────────────  ◯  ───────────────────────────────────────
//   ~ John          Place    Attack    Fortify    End turn           ( Blitz )   Roll
//                            ‾‾‾‾‾‾
// No boxes, no pills. ONE GOLD (GameVM.gold), and it moves: the pending commit's brush ring, or the
// current (or recommended next) word and its brush underline; everything else is ivory. The line swaps
// (the old one dries, the new one is drawn in; never two at once) when its wording changes; when only
// a number changes it re-inks (±1) or counts (≥ 5). Everything is patched in place.
// v4 (_claude/v4/PLAN.md §8a Q4): ONE line above the rule. It writes and dries; nothing stacks above it.
// The receipt and the Ledger carry the record. "Round 6" is written at the left of the line's row
// (desktop) and is the way into the Ledger (a click opens it, by round). The ledger's latest sentence
// stays only for screen readers (a polite live region), never as ink.
// v5 E (the turn ritual): beside the seat mark, a holding dab in the seat's pigment carries the turn's
// reinforcements as a small stack of ink stones (GameVM.holding) that empties one by one as they are placed;
// as the turn starts, the breakdown ('3 territories · Asia +4') writes under the line and dries (~1.5 s).
// Phones: the dab sits in the action row. v5 F4: the ensō on the rule answers a tap ('tapEnso').

import type { ButtonVM, CountVM, GameVM, GoldVM, LogLineVM, StripVM, TrackSegId, TrackVM, UiIntent } from '../../game/viewModel';
import { layout, onLayout } from '../layout';
import { PLAYER_COLORS } from '../../shared/palette';
import { ActionButton } from '../controls';
import { brushMark } from '../../shared/enso';
import { countUp, drawIn, EASE_BRUSH, EASE_IN_QUAD, ensoEl, h, hashSeed, minus, motion, pop, ringEl, setAttr, setEnso, setStyle, setText, svg, toggle, underlineEl } from '../dom';

/** Short labels on phones: the track's segments are equal-width words there. */
const SEG_SHORT: Partial<Record<TrackSegId, string>> = { endTurn: 'End' };

/** The one line, with number-aware transitions. A change of wording never shows two lines at once:
 *  the outgoing line slides up while fading, then the new one comes in. */
class Line {
  readonly el: HTMLDivElement;
  private cur: HTMLSpanElement;
  private text = '';
  private kind = '';
  private key = -1;
  private cancels: (() => void)[] = [];

  constructor() {
    this.el = h('div', 'st-line');
    this.el.dataset.testid = 'line';
    this.cur = h('span', 'ln-text');
    this.el.append(this.cur);
  }

  private fill(span: HTMLSpanElement, text: string): void {
    span.textContent = '';
    for (const part of text.split(/(\d+%?)/)) {
      if (!part) continue;
      if (/^\d/.test(part)) span.append(h('span', 'ln-num', part));
      else span.append(document.createTextNode(part));
    }
  }

  /** While another line owns the slot the strip's line is stepping aside: changes wait, then land silently. */
  private aside = false;
  private asideAt = 0;
  private pending: [string, StripVM['lineKind'], number, string | null] | null = null;
  private pendingT = 0;

  /**
   * The strip's line steps aside for a breath line or the rotate hint (INK B4: one thing in the slot).
   * The words on the paper stay as they were while they dry (160 ms, easeInQuad); whatever changed
   * meanwhile is swapped in unseen, so the line comes back already current, and nothing slides.
   */
  setAside(on: boolean): void {
    if (on === this.aside) return;
    this.aside = on;
    if (on) this.asideAt = performance.now();
    else this.flush();
  }

  private flush(): void {
    window.clearTimeout(this.pendingT);
    const p = this.pending;
    this.pending = null;
    if (p) this.apply(...p, true);
  }

  update(text: string, kind: StripVM['lineKind'], key: number, narr: string | null): void {
    if (this.aside) {
      this.pending = [text, kind, key, narr];
      // Once it has dried, swap unseen (so a later reveal is already current).
      window.clearTimeout(this.pendingT);
      const left = Math.max(0, 170 - (performance.now() - this.asideAt));
      this.pendingT = window.setTimeout(() => this.aside && this.flush(), left);
      return;
    }
    this.apply(text, kind, key, narr, false);
  }

  private apply(text: string, kind: StripVM['lineKind'], key: number, narr: string | null, silent: boolean): void {
    text = minus(text);
    const sameKey = key === this.key;
    if (text === this.text && kind === this.kind && sameKey) return;
    const prevText = this.text;
    const prevKind = this.kind;
    const skeleton = (s: string) => s.replace(/\d+/g, '#');
    const nums = (s: string) => (s.match(/\d+/g) ?? []).map(Number);
    const rejection = kind === 'rejection' && (!sameKey || prevKind !== 'rejection');
    const kindChanged = kind !== prevKind;
    this.text = text;
    this.kind = kind;
    this.key = key;
    this.el.dataset.kind = kind;
    toggle(this.el, 'is-rejection', kind === 'rejection');
    toggle(this.el, 'is-narration', kind === 'narration');
    setStyle(this.el, '--narr', narr ?? 'var(--ivory)');
    this.el.title = text;

    if (!silent && !rejection && !kindChanged && prevText && skeleton(prevText) === skeleton(text)) {
      // Same sentence, different number(s): patch the numbers in place.
      const a = nums(prevText);
      const b = nums(text);
      const spans = this.cur.querySelectorAll<HTMLSpanElement>('.ln-num');
      if (spans.length === b.length) {
        b.forEach((n, i) => {
          if (a[i] === n) return;
          const suffix = spans[i].textContent?.endsWith('%') ? '%' : '';
          if (Math.abs(n - a[i]) >= 5) this.cancels.push(countUp(spans[i], a[i], n, (x) => `${x}${suffix}`));
          else {
            setText(spans[i], `${n}${suffix}`);
            pop(spans[i], 1.14, 160);
          }
        });
        return;
      }
    }
    this.cancels.forEach((c) => c());
    this.cancels = [];
    // Only one line leaves at a time: any line still on its way out goes now.
    this.el.querySelectorAll('.ln-ghost').forEach((g) => g.remove());
    const old = this.cur;
    old.getAnimations().forEach((a) => a.cancel());
    const next = h('span', 'ln-text');
    this.fill(next, text);
    this.cur = next;
    this.el.append(next);
    if (!prevText || motion.reduced || silent) {
      old.remove();
      return;
    }
    const quick = kind === 'rejection' || prevKind === 'rejection';
    const outMs = quick ? 70 : 100;
    old.classList.add('ln-ghost');
    const out = old.animate([{ opacity: 1 }, { opacity: 0 }], { duration: outMs, easing: EASE_IN_QUAD, fill: 'forwards' });
    out.onfinish = () => old.remove();
    next.style.opacity = '0';
    window.setTimeout(() => {
      next.style.opacity = '';
      if (this.cur === next) drawIn(next, quick ? 150 : 220);
    }, outMs);
  }
}

/**
 * The Turn Track (docs/ROUND2.md §A, INK2 §3.1): Place · Attack · Fortify · End turn (or Setup · Done) as
 * four words centred as a group (the group never moves). The current word carries a brush underline:
 * gold when the track holds the one gold, ivory 70 % otherwise. A recommended next word that carries
 * the gold is a gold word with a gold underline. The ensō on the rule above sits over the current word
 * (the GoldRule reads `currentX()`). Forward segments are the buttons that change phase; the track never
 * hides or renames. Each word is a transparent ≥ 44 px hit box.
 */
class Track {
  readonly el: HTMLDivElement;
  private segs = new Map<TrackSegId, HTMLButtonElement>();
  private uls = new Map<TrackSegId, SVGSVGElement>();
  private order: TrackSegId[] = [];
  private vm: TrackVM | null = null;
  private gold: TrackSegId | null = null;
  private turnKey = '';
  private placed: TrackSegId | null = null;
  private lined = new Set<TrackSegId>();
  /** The ensō follows the current word: `slide` false = a cut (the turn changed hands, a resize). */
  onPlace: ((slide: boolean) => void) | null = null;

  constructor(private send: (i: UiIntent) => void) {
    this.el = h('div', 'track');
    this.el.dataset.testid = 'track';
    this.el.setAttribute('role', 'group');
    this.el.setAttribute('aria-label', 'Turn');
  }

  private build(ids: TrackSegId[]): void {
    for (const b of this.segs.values()) b.remove();
    this.segs.clear();
    this.uls.clear();
    this.lined.clear();
    this.order = ids;
    for (const id of ids) {
      const b = h('button', `tr-seg nofocus seg-${id}`);
      b.type = 'button';
      b.dataset.testid = `seg-${id}`;
      b.dataset.slop = '0'; // the word's own transparent box is the ≥ 44 px hit area (no pill to reach into)
      b.dataset.seg = id;
      const words = h('span', 'tr-words');
      words.append(h('span', 'tr-label'), h('span', 'tr-short'));
      const ul = underlineEl(hashSeed(`seg-${id}`), undefined, 'brush-ul tr-ul');
      words.append(ul);
      b.append(words);
      b.addEventListener('click', () => {
        const vm = this.vm;
        const seg = vm?.segments.find((x) => x.id === id);
        if (!vm || !seg || !vm.live) return;
        if (seg.state === 'eligible' || seg.state === 'locked') this.send({ type: 'track', seg: id });
      });
      this.segs.set(id, b);
      this.uls.set(id, ul);
      this.el.append(b);
    }
    this.placed = null;
  }

  /** The current word's centre, in px from the left of `ref` (the rule), or null when there's none. */
  currentX(ref: HTMLElement): number | null {
    const cur = this.vm?.segments.find((x) => x.state === 'current');
    const b = cur ? this.segs.get(cur.id) : null;
    if (!b || !b.offsetWidth) return null;
    const r = b.getBoundingClientRect();
    return r.left + r.width / 2 - ref.getBoundingClientRect().left;
  }

  /**
   * Which words carry an underline: the current one, and a gold recommended one. A new underline is
   * drawn in left → right (180 ms); one that goes dries out (140 ms, and never in gold: the gold leaves
   * at once, so two golds are never on the paper together).
   */
  private underlines(): void {
    const vm = this.vm!;
    const want = new Set<TrackSegId>();
    for (const seg of vm.segments) if (seg.state === 'current' || (this.gold === seg.id && seg.state !== 'done')) want.add(seg.id);
    for (const [id, ul] of this.uls) {
      const on = want.has(id);
      const was = this.lined.has(id);
      toggle(ul, 'on', on);
      if (on === was) continue;
      ul.getAnimations().forEach((a) => a.cancel());
      if (motion.reduced || typeof ul.animate !== 'function') continue;
      if (on) ul.animate([{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)' }], { duration: 180, easing: EASE_BRUSH });
      else {
        ul.classList.add('drying');
        const a = ul.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: EASE_IN_QUAD });
        a.onfinish = a.oncancel = () => ul.classList.remove('drying');
      }
    }
    this.lined = want;
  }

  update(vm: TrackVM, gold: TrackSegId | null): void {
    if (this.vm === vm && this.gold === gold) return;
    const prev = this.vm;
    this.vm = vm;
    this.gold = gold;
    const ids = vm.segments.map((x) => x.id);
    if (ids.join() !== this.order.join()) this.build(ids);
    const pal = PLAYER_COLORS[vm.seat.color];
    setStyle(this.el, '--seat', pal.base);
    setStyle(this.el, '--seat-light', pal.light);
    toggle(this.el, 'is-live', vm.live);
    toggle(this.el, 'is-disabled', vm.disabled);
    toggle(this.el, 'is-watch', !vm.live);
    this.el.dataset.kind = vm.kind;
    const cur = vm.segments.find((x) => x.state === 'current')?.id ?? null;
    for (const seg of vm.segments) {
      const b = this.segs.get(seg.id)!;
      const label = b.querySelector<HTMLElement>('.tr-label')!;
      const short = b.querySelector<HTMLElement>('.tr-short')!;
      setText(label, seg.label);
      setText(short, SEG_SHORT[seg.id] ?? seg.label);
      // Each word's box is reserved at its heaviest (600) weight, so the current word never nudges the group.
      label.dataset.w = seg.label;
      short.dataset.w = SEG_SHORT[seg.id] ?? seg.label;
      b.dataset.state = seg.state;
      for (const st of ['done', 'current', 'eligible', 'locked'] as const) toggle(b, `is-${st}`, seg.state === st);
      const rec = vm.recommended === seg.id;
      toggle(b, 'is-rec', rec);
      // The one gold: this word and its underline.
      const isGold = gold === seg.id;
      toggle(b, 'gold', isGold);
      toggle(b, 'is-primary', isGold);
      // A locked segment still answers a click (its reason goes in the line); done / current don't.
      const answers = vm.live && !vm.disabled && (seg.state === 'eligible' || seg.state === 'locked');
      setAttr(b, 'aria-disabled', answers ? null : 'true');
      b.tabIndex = vm.live && !vm.disabled && seg.state === 'eligible' ? 0 : -1;
      setAttr(b, 'aria-current', seg.state === 'current' ? 'step' : null);
    }
    this.underlines();
    const handsChanged = vm.turnKey !== this.turnKey;
    this.turnKey = vm.turnKey;
    if (cur !== this.placed || handsChanged || prev?.seat.color !== vm.seat.color) {
      const slide = !!prev && !handsChanged && prev.kind === vm.kind;
      this.placed = cur;
      this.onPlace?.(slide);
    }
  }
}

/**
 * The seat mark (INK2 §3.1, desktop only): at the far left of the track row, a brush dab in the current
 * seat's colour and the seat's name. No number (John, 2026-09-29). An AI's dab and name while it plays.
 */
class SeatMark {
  readonly el: HTMLDivElement;
  private dab: SVGSVGElement;
  private name: HTMLSpanElement;
  private key = '';

  constructor() {
    this.el = h('div', 'st-seat');
    this.el.dataset.testid = 'seat-mark';
    this.dab = svg('svg', { viewBox: '0 0 44 20', class: 'sm-dab', 'aria-hidden': 'true' });
    this.name = h('span', 'sm-name');
    this.el.append(this.dab, this.name);
  }

  update(seat: TrackVM['seat']): void {
    const key = `${seat.id}:${seat.color}:${seat.name}`;
    if (key === this.key) return;
    const first = !this.key;
    this.key = key;
    const seed = hashSeed(`dab:${seat.id}:${seat.color}`);
    // A short loaded dab laid on a slight rise, left to right (frame 5's vermilion stroke).
    let s = seed;
    const r = () => ((s = (Math.imul(s ^ (s >>> 13), 1274126177) + 0x6d2b79f5) >>> 0) / 4294967296);
    const pts: [number, number][] = [];
    const lift = 3 + r() * 3;
    const sag = 0.6 + r() * 0.8;
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      pts.push([4 + t * 36, 12.5 - t * lift + Math.sin(Math.PI * t) * sag]);
    }
    this.dab.textContent = '';
    this.dab.append(svg('path', { d: brushMark(pts, { seed, width: 7.5, samples: 48, bristles: 5 }), fill: 'currentColor' }));
    this.dab.style.color = PLAYER_COLORS[seat.color].base;
    setText(this.name, seat.name);
    this.el.setAttribute('aria-label', `${seat.name}'s turn`);
    if (!first) drawIn(this.el, 240);
  }
}

type HoldingVM = NonNullable<GameVM['holding']>;

/** Stones drawn at most; more reads as a numeral on the dab. */
const HOLD_STONES = 12;
/** The stack: rows from the bottom, stones per row (4 · 3 · 3 · 2 = 12). */
const HOLD_ROWS = [4, 3, 3, 2];

/**
 * The holding dab (v5 E): a painted dab in the seat's pigment with the turn's armies on it as tiny ink stones,
 * stacked bottom row first. A stone placed on the board leaves the dab (it shrinks away, tier 0); a trade's
 * armies arrive as new stones (they swell in). More than 12, or reduced motion: the count as a numeral.
 */
class Holding {
  readonly el: HTMLDivElement;
  private dab: SVGSVGElement;
  private stones: HTMLDivElement;
  private num: HTMLSpanElement;
  private n = -1;
  private seatKey = '';

  constructor() {
    this.el = h('div', 'st-hold hidden');
    this.el.dataset.testid = 'holding';
    this.dab = svg('svg', { viewBox: '0 0 64 30', class: 'hd-dab', 'aria-hidden': 'true' });
    this.stones = h('div', 'hd-stones');
    this.stones.setAttribute('aria-hidden', 'true');
    this.num = h('span', 'hd-num num hidden');
    this.el.append(this.dab, this.stones, this.num);
  }

  /** Where stone `i` sits on the dab, in % of the stones box (bottom row first, each row centred). */
  private spot(i: number): { x: number; y: number } {
    let row = 0;
    let k = i;
    while (row < HOLD_ROWS.length - 1 && k >= HOLD_ROWS[row]) k -= HOLD_ROWS[row++];
    const inRow = HOLD_ROWS[row];
    const x = 50 + (k - (inRow - 1) / 2) * 24;
    const y = 100 - row * 30;
    return { x, y };
  }

  private stone(i: number): HTMLElement {
    const st = h('i', 'hd-stone');
    const p = this.spot(i);
    st.style.left = `${p.x}%`;
    st.style.top = `${p.y}%`;
    st.style.zIndex = String(10 + i);
    return st;
  }

  update(vm: HoldingVM | null): void {
    toggle(this.el, 'hidden', !vm);
    if (!vm) {
      this.n = -1;
      this.seatKey = '';
      this.stones.textContent = '';
      return;
    }
    const pal = PLAYER_COLORS[vm.seat.color];
    const seatKey = `${vm.seat.id}:${vm.seat.color}`;
    const fresh = seatKey !== this.seatKey;
    if (fresh) {
      this.seatKey = seatKey;
      // A wider, wetter dab than the seat mark's: the stones rest on it.
      const seed = hashSeed(`hold:${seatKey}`);
      let s = seed;
      const r = () => ((s = (Math.imul(s ^ (s >>> 13), 1274126177) + 0x6d2b79f5) >>> 0) / 4294967296);
      const pts: [number, number][] = [];
      const lift = 1.5 + r() * 2;
      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        pts.push([5 + t * 54, 18 - t * lift + Math.sin(Math.PI * t) * 0.8]);
      }
      this.dab.textContent = '';
      this.dab.append(svg('path', { d: brushMark(pts, { seed, width: 21, samples: 48, bristles: 6 }), fill: 'currentColor' }));
      setStyle(this.el, '--hold', pal.base);
      setStyle(this.el, '--hold-deep', pal.deep);
      setStyle(this.el, '--hold-stone', pal.light);
      this.stones.textContent = '';
      this.n = -1;
    }
    const n = Math.max(0, vm.armies);
    this.el.setAttribute('aria-label', `${n} ${n === 1 ? 'army' : 'armies'} to place`);
    this.el.title = `${n} to place`;
    const asNumber = motion.reduced || n > HOLD_STONES;
    toggle(this.num, 'hidden', !asNumber);
    toggle(this.stones, 'hidden', asNumber);
    if (asNumber) {
      if (n !== this.n && this.n >= 0) pop(this.num, 1.1, 200);
      setText(this.num, String(n));
      this.stones.textContent = '';
      this.n = n;
      return;
    }
    const animate = this.n >= 0 && !fresh;
    const live = [...this.stones.querySelectorAll<HTMLElement>('.hd-stone:not(.leaving)')];
    if (n > live.length) {
      for (let i = live.length; i < n; i++) {
        const st = this.stone(i);
        this.stones.append(st);
        // a trade pours in: each stone swells onto the dab, a few ms after the last (tier 0)
        if (animate && typeof st.animate === 'function')
          st.animate([{ transform: 'translate(-50%, -100%) scale(0)', opacity: 0 }, { transform: 'translate(-50%, -100%) scale(1.18)', opacity: 1, offset: 0.6 }, { transform: 'translate(-50%, -100%) scale(1)' }], { duration: 220, delay: (i - live.length) * 40, easing: EASE_BRUSH, fill: 'backwards' });
      }
    } else if (n < live.length) {
      // the top stones leave first: they shrink off the dab (tier 0)
      for (const st of live.slice(n)) {
        if (!animate || typeof st.animate !== 'function') {
          st.remove();
          continue;
        }
        st.classList.add('leaving');
        const a = st.animate([{ transform: 'translate(-50%, -100%) scale(1)', opacity: 1 }, { transform: 'translate(-50%, -100%) scale(1.15)', opacity: 1, offset: 0.3 }, { transform: 'translate(-50%, -100%) scale(0)', opacity: 0 }], { duration: 200, easing: EASE_IN_QUAD, fill: 'forwards' });
        a.onfinish = () => st.remove();
      }
    }
    this.n = n;
  }
}

/**
 * The breakdown under the one line as the turn starts (v5 E): '3 territories · Asia +4' writes, holds, and
 * dries, about 1.5 s in all. It never stacks: a newer one replaces it.
 */
class Breakdown {
  readonly el: HTMLDivElement;
  private t = 0;
  private a: Animation | null = null;
  constructor() {
    this.el = h('div', 'st-break hidden');
    this.el.dataset.testid = 'holding-breakdown';
  }
  show(text: string): void {
    window.clearTimeout(this.t);
    this.a?.cancel();
    if (!text) return void toggle(this.el, 'hidden', true);
    setText(this.el, minus(text));
    toggle(this.el, 'hidden', false);
    if (!motion.reduced) drawIn(this.el, 380);
    this.t = window.setTimeout(() => {
      if (motion.reduced || typeof this.el.animate !== 'function') return void toggle(this.el, 'hidden', true);
      const a = (this.a = this.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 320, easing: EASE_IN_QUAD, fill: 'forwards' }));
      a.onfinish = () => {
        toggle(this.el, 'hidden', true);
        a.cancel();
      };
    }, motion.reduced ? 1500 : 1180);
  }
}

/** − N + for the Place count. Hold a side to repeat. */
class Stepper {
  readonly el: HTMLDivElement;
  private dec: HTMLButtonElement;
  private inc: HTMLButtonElement;
  private n: HTMLSpanElement;
  private vm: CountVM | null = null;
  private repeatT = 0;
  private repeatI = 0;
  private value = -1;

  constructor(private send: (i: UiIntent) => void) {
    this.el = h('div', 'stepper-ctl');
    this.dec = h('button', 'sp-btn nofocus', '−');
    this.inc = h('button', 'sp-btn nofocus', '+');
    this.dec.type = this.inc.type = 'button';
    this.dec.setAttribute('aria-label', 'One fewer');
    this.inc.setAttribute('aria-label', 'One more');
    this.dec.dataset.testid = 'count-dec';
    this.inc.dataset.testid = 'count-inc';
    this.n = h('span', 'sp-n num');
    this.n.dataset.testid = 'count';
    this.el.append(this.dec, this.n, this.inc);
    for (const [b, d] of [
      [this.dec, -1],
      [this.inc, 1],
    ] as const) {
      b.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        this.step(d);
        this.stop();
        this.repeatT = window.setTimeout(() => (this.repeatI = window.setInterval(() => this.step(d), 90)), 380);
      });
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => this.stop());
      b.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.step(d);
        }
      });
    }
  }

  private step(d: number): void {
    const vm = this.vm;
    if (!vm) return;
    const v = Math.max(vm.min, Math.min(vm.max, vm.value + d));
    if (v !== vm.value) {
      this.vm = { ...vm, value: v };
      this.send({ type: 'setCount', value: v });
    } else this.stop();
  }

  private stop(): void {
    window.clearTimeout(this.repeatT);
    window.clearInterval(this.repeatI);
  }

  update(vm: CountVM): void {
    this.vm = vm;
    setAttr(this.dec, 'aria-disabled', vm.value <= vm.min ? 'true' : null);
    setAttr(this.inc, 'aria-disabled', vm.value >= vm.max ? 'true' : null);
    if (vm.value !== this.value) {
      if (this.value >= 0) pop(this.n, 1.12, 140);
      this.value = vm.value;
      setText(this.n, String(vm.value));
    }
    this.el.setAttribute('aria-label', `${vm.value} of ${vm.max}`);
  }

  reset(): void {
    this.stop();
    this.value = -1;
  }
}

/** A min…max slider for Occupy and Fortify: drag, click the track, or arrow keys. */
class CountSlider {
  readonly el: HTMLDivElement;
  private track: HTMLDivElement;
  private fill: HTMLDivElement;
  private knob: HTMLDivElement;
  private lo: HTMLSpanElement;
  private hi: HTMLSpanElement;
  private vm: CountVM | null = null;

  constructor(private send: (i: UiIntent) => void) {
    this.el = h('div', 'count-slider');
    this.el.tabIndex = 0;
    this.el.setAttribute('role', 'slider');
    this.el.setAttribute('aria-label', 'Armies to move');
    this.el.dataset.testid = 'count-slider';
    this.lo = h('span', 'cs-end num');
    this.hi = h('span', 'cs-end num');
    this.track = h('div', 'cs-track');
    this.fill = h('div', 'cs-fill');
    this.knob = h('div', 'cs-knob');
    this.knob.append(ringEl(hashSeed('count-knob'), 1, undefined, { cls: 'knob-ring', weight: 1.6 }));
    this.track.append(this.fill, this.knob);
    this.el.append(this.lo, this.track, this.hi);
    const at = (e: PointerEvent) => {
      const vm = this.vm;
      if (!vm) return;
      const r = this.track.getBoundingClientRect();
      const k = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
      this.set(Math.round(vm.min + k * (vm.max - vm.min)));
    };
    this.el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.el.setPointerCapture(e.pointerId);
      at(e);
      const move = (ev: PointerEvent) => at(ev);
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
      const vm = this.vm;
      if (!vm) return;
      const d = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : 0;
      if (e.key === 'Home') this.set(vm.min);
      else if (e.key === 'End') this.set(vm.max);
      else if (d) this.set(vm.value + d);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
  }

  private set(v: number): void {
    const vm = this.vm;
    if (!vm) return;
    const value = Math.max(vm.min, Math.min(vm.max, v));
    if (value === vm.value) return;
    this.vm = { ...vm, value };
    this.paint();
    this.send({ type: 'setCount', value });
  }

  private paint(): void {
    const vm = this.vm!;
    const k = vm.max > vm.min ? (vm.value - vm.min) / (vm.max - vm.min) : 1;
    const pct = `${(k * 100).toFixed(2)}%`;
    this.fill.style.width = pct;
    this.knob.style.left = pct;
    this.el.setAttribute('aria-valuemin', String(vm.min));
    this.el.setAttribute('aria-valuemax', String(vm.max));
    this.el.setAttribute('aria-valuenow', String(vm.value));
  }

  update(vm: CountVM): void {
    this.vm = vm;
    setText(this.lo, String(vm.min));
    setText(this.hi, String(vm.max));
    this.paint();
  }
}

/** Keyed pool of ActionButtons. */
class Buttons {
  readonly el: HTMLDivElement;
  private pool = new Map<string, ActionButton>();
  constructor(private press: (b: ButtonVM) => void) {
    this.el = h('div', 'st-buttons');
  }
  update(list: ButtonVM[], gold: GoldVM | undefined): void {
    const seen = new Set<string>();
    list.forEach((b, i) => {
      let ab = this.pool.get(b.id);
      if (!ab) {
        ab = new ActionButton(this.press);
        this.pool.set(b.id, ab);
      }
      ab.update(b, gold === undefined ? b.primary : gold?.kind === 'button' && gold.id === b.id);
      seen.add(b.id);
      if (this.el.children[i] !== ab.el) this.el.insertBefore(ab.el, this.el.children[i] ?? null);
    });
    for (const [id, ab] of this.pool) if (!seen.has(id)) (ab.el.remove(), this.pool.delete(id));
  }
}

/**
 * The gold hairline rule with the game's ensō on it (INK A1: a glint every ~14 s, the ensō breathes).
 * The ensō sits over the current phase word and slides there on an advance (180 ms, the brush); when
 * the turn changes hands it cuts. The rule's halves run from the edges to the ensō's gap wherever it is.
 */
class GoldRule {
  readonly el: HTMLDivElement;
  private mark: SVGSVGElement;
  private enso: HTMLSpanElement;
  private l: HTMLElement;
  private r: HTMLElement;
  private x = -1;
  constructor() {
    this.el = h('div', 'st-rule');
    this.el.setAttribute('aria-hidden', 'true');
    this.l = h('i', 'sr-half sr-l');
    this.r = h('i', 'sr-half sr-r');
    const glint = h('i', 'sr-glint');
    const c = (this.enso = h('span', 'sr-enso'));
    c.dataset.testid = 'rule-enso';
    this.mark = ensoEl(1, 'enso', { small: true });
    c.append(this.mark);
    this.el.append(this.l, this.r, glint, c);
    // v5 F4: the ensō answers a tap (never required): the controller writes the round, and a second tap
    // within 2 s opens the Ledger (its call).
    c.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onTap?.();
    });
  }
  onTap: (() => void) | null = null;
  setSeed(seed: number): void {
    setEnso(this.mark, seed, { small: true });
  }
  /** Put the ensō at `x` px along the rule (null: the centre). A slide (180 ms), or a cut. */
  place(x: number | null, slide: boolean): void {
    const w = this.el.clientWidth;
    if (!w) return;
    const px = Math.round((x ?? w / 2) * 10) / 10;
    if (px === this.x) return;
    const cut = !slide || motion.reduced || this.x < 0;
    this.x = px;
    if (cut) this.el.classList.add('sr-cut');
    this.el.style.setProperty('--ex', `${px}px`);
    this.enso.dataset.x = String(px);
    if (cut) {
      void this.el.offsetWidth;
      this.el.classList.remove('sr-cut');
    }
  }
  /** Turn start: the rule redraws outward from wherever the ensō is (400 ms). */
  redraw(): void {
    if (motion.reduced || typeof this.l.animate !== 'function') return;
    for (const el of [this.l, this.r]) el.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: 400, easing: EASE_BRUSH });
  }
}

export class BottomStrip {
  readonly el: HTMLElement;
  private track: Track;
  private line = new Line();
  private say: HTMLDivElement;
  private rule = new GoldRule();
  private count: HTMLDivElement;
  private stepper: Stepper;
  private slider: CountSlider;
  private buttons: Buttons;
  /** v4 (A5): a truce offer waits on its own secondary line, never in the primary slot. */
  private offer: HTMLDivElement;
  private offerText: HTMLSpanElement;
  private offerButtons: Buttons;
  private zone: HTMLDivElement;
  private seat = new SeatMark();
  private hold = new Holding();
  private breakdown = new Breakdown();
  private holdVm: GameVM['holding'] = null;
  private vm: StripVM | null = null;
  private gold: GoldVM | undefined = undefined;
  private turnKey = '';
  private events: HTMLDivElement;
  private round: HTMLSpanElement;
  private latest: HTMLSpanElement;
  private update$: HTMLDivElement;
  private eventsKey = '';

  constructor(private send: (i: UiIntent) => void) {
    this.el = h('section', 'strip');
    this.el.dataset.testid = 'strip';
    this.el.setAttribute('aria-label', 'Your move');
    this.el.setAttribute('aria-live', 'polite');
    this.track = new Track(send);
    this.count = h('div', 'st-count');
    this.stepper = new Stepper(send);
    this.slider = new CountSlider(send);
    this.count.append(this.stepper.el, this.slider.el);
    this.buttons = new Buttons((b) => send({ type: 'button', id: b.id }));
    const zone = (this.zone = h('div', 'st-zone'));
    zone.dataset.testid = 'action-zone';
    zone.append(this.count, this.buttons.el);
    this.offer = h('div', 'st-offer hidden');
    this.offer.dataset.testid = 'offer';
    this.offerText = h('span', 'st-offer-text');
    this.offerButtons = new Buttons((b) => send({ type: 'button', id: b.id }));
    this.offer.append(this.offerText, this.offerButtons.el);
    zone.append(this.offer);
    this.say = h('div', 'st-say');
    // The round word, at the left of the line's row: a click (a mouse) opens the Ledger. On touch it is a
    // word only (a 44 px target there would take taps from the board above the dock); the menu has it.
    this.events = h('div', 'st-events');
    this.events.dataset.testid = 'events';
    this.events.title = 'The ledger';
    this.events.addEventListener('click', (e) => {
      if ((e as PointerEvent).pointerType === 'touch' || matchMedia('(pointer: coarse)').matches) return;
      send({ type: 'overlay', overlay: 'log' });
    });
    this.round = h('span', 'st-round num');
    this.round.dataset.testid = 'round';
    // The ledger's latest sentence, for screen readers only (one line of ink is the strip's own).
    this.latest = h('span', 'sr-only');
    this.latest.dataset.testid = 'event-line';
    this.latest.setAttribute('aria-live', 'polite');
    this.events.append(this.round, this.latest);
    // 'Update ready · reload' sits where the stack used to: centred above the line, words only.
    this.update$ = h('div', 'st-update hidden');
    this.say.append(this.events, this.update$, this.line.el);
    this.el.append(this.say, this.rule.el, this.seat.el, this.track.el, zone);
    this.say.append(this.breakdown.el);
    this.rule.onTap = () => send({ type: 'tapEnso' });
    // The holding dab: beside the seat mark on the desktop strip; in the action row on the phone dock.
    const placeHold = () => {
      const phone = layout.form === 'phone' || layout.stacked;
      if (phone && this.hold.el.parentElement !== zone) zone.prepend(this.hold.el);
      else if (!phone && this.hold.el.parentElement !== this.seat.el) this.seat.el.append(this.hold.el);
    };
    placeHold();
    onLayout(placeHold);
    // The ensō follows the current word: on an advance it slides; on a resize (or fonts arriving) it cuts.
    const put = (slide: boolean) => this.rule.place(this.track.currentX(this.rule.el), slide);
    this.track.onPlace = (slide) => put(slide);
    new ResizeObserver(() => put(false)).observe(this.track.el);
    new ResizeObserver(() => put(false)).observe(this.el);
    // The mouse wheel over the strip adjusts the count.
    this.el.addEventListener(
      'wheel',
      (e) => {
        const c = this.vm?.count;
        if (!c) return;
        e.preventDefault();
        const v = Math.max(c.min, Math.min(c.max, c.value + (e.deltaY < 0 ? 1 : -1)));
        if (v !== c.value) send({ type: 'setCount', value: v });
      },
      { passive: false },
    );
  }

  /** The game's ensō on the rule. */
  setSeed(seed: number): void {
    this.rule.setSeed(seed);
  }

  /**
   * The round (written at the left of the line's row; a click opens the Ledger) and the ledger's latest
   * sentence, for screen readers only: one line of ink above the rule, never a stack (v4 Q4).
   * `updateReady` (v3): a new build has taken over; the slot reads 'Update ready · reload', two bare words.
   */
  setEvents(lines: LogLineVM[] | undefined, round: number | undefined, updateReady = false): void {
    setText(this.round, round && round > 0 ? `Round ${round}` : '');
    if (updateReady) {
      if (this.eventsKey === 'update') return;
      this.eventsKey = 'update';
      this.update$.textContent = '';
      const b = h('button', 'ev-update nofocus', 'Update ready · reload');
      b.type = 'button';
      b.dataset.testid = 'update-ready';
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.send({ type: 'reloadForUpdate' });
      });
      this.update$.append(b);
      toggle(this.update$, 'hidden', false);
      drawIn(b, 240);
      return;
    }
    if (this.eventsKey === 'update') {
      this.update$.textContent = '';
      toggle(this.update$, 'hidden', true);
    }
    const last = (lines ?? [])[(lines ?? []).length - 1];
    const key = last ? `${last.id}:${last.text}` : '';
    if (key === this.eventsKey) return;
    this.eventsKey = key;
    setText(this.latest, last ? minus(last.text) : '');
  }

  private holdsInZone(): boolean {
    return !!this.holdVm && this.hold.el.parentElement === this.zone;
  }

  /**
   * v5 E: the current human's reinforcements as a holding dab (null = none). A new seat's holding (the turn
   * starting) also writes its breakdown under the line.
   */
  setHolding(vm: GameVM['holding']): void {
    vm = vm ?? null;
    if (vm === this.holdVm) return;
    const prev = this.holdVm;
    this.holdVm = vm;
    this.hold.update(vm);
    if (vm && (!prev || prev.seat.id !== vm.seat.id)) this.breakdown.show(vm.breakdown);
    else if (!vm) this.breakdown.show('');
    const v = this.vm;
    if (v) toggle(this.zone, 'is-empty', !v.count && v.buttons.length === 0 && !v.offer && !this.holdsInZone());
  }

  /** Another line owns the slot (a breath line, the rotate hint): the strip's line steps aside. */
  setLineAside(on: boolean): void {
    this.line.setAside(on);
  }

  update(vm: StripVM, gold?: GoldVM): void {
    if (this.vm === vm && this.gold === gold) return;
    const prev = this.vm;
    this.vm = vm;
    this.gold = gold;
    // Legacy fallback (no GameVM.gold): the primary button, else the track's recommended segment.
    const g: GoldVM | undefined =
      gold !== undefined
        ? gold
        : vm.buttons.find((b) => b.primary)
          ? { kind: 'button', id: vm.buttons.find((b) => b.primary)!.id }
          : vm.track.primary && vm.track.recommended
            ? { kind: 'segment', seg: vm.track.recommended }
            : null;
    this.el.dataset.mode = vm.mode;
    if (vm.track.turnKey !== this.turnKey) {
      if (prev) this.rule.redraw();
      this.turnKey = vm.track.turnKey;
    }
    this.seat.update(vm.track.seat);
    this.track.update(vm.track, g?.kind === 'segment' ? g.seg : null);
    // v5 D: an AI's voice line is set in that seat's light pigment (the narration italic), never ivory.
    const voice = vm.voice ?? null;
    toggle(this.line.el, 'is-voice', !!voice);
    this.line.update(vm.line, voice ? 'narration' : vm.lineKind, vm.lineKey, voice ? PLAYER_COLORS[voice.color].light : vm.lineKind === 'narration' ? PLAYER_COLORS[vm.track.seat.color].light : null);
    const c = vm.count;
    toggle(this.count, 'hidden', !c);
    toggle(this.stepper.el, 'hidden', c?.control !== 'stepper');
    toggle(this.slider.el, 'hidden', c?.control !== 'slider');
    if (c?.control === 'stepper') this.stepper.update(c);
    else this.stepper.reset();
    if (c?.control === 'slider') this.slider.update(c);
    this.buttons.update(vm.buttons, g ?? null);
    // v4: the offer line (plain words; Accept is never the gold while the player is acting)
    const offer = (vm as StripVM & { offer?: { text: string; buttons: ButtonVM[] } | null }).offer ?? null;
    toggle(this.offer, 'hidden', !offer);
    if (offer) {
      setText(this.offerText, offer.text);
      this.offerButtons.update(offer.buttons, null);
    } else this.offerButtons.update([], null);
    // The action row folds away when there is nothing to press (portrait docks).
    toggle(this.zone, 'is-empty', !c && vm.buttons.length === 0 && !offer && !this.holdsInZone());
    this.el.dataset.buttons = String(vm.buttons.length + (c ? 1 : 0) + (offer ? offer.buttons.length : 0));
  }
}
