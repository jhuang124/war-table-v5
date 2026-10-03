// "While you were away" (v4 PLAN §3 A3; sitting 2026-10-03: the receipt is THE channel for bot turns).
// A sheet of paper laid on the board when a human gets the cup back after AI turns: the title in the
// serif on the sheet's hairline, then one line per AI seat, written in one at a time (≈ 600 ms apart,
// brushed in like the turn line); the summary about the reader last, a size up. A line where the reader
// lost something is set in that seat's pigment; the rest are ivory with the seat's name in its pigment.
// As each line begins the UI sends `receiptLine` (the board pulses its territories). Any tap, click or
// key sends `dismissReceipt`; the sheet lifts back off the top edge (phones: a bottom sheet, sliding down).
// Reduced motion: the sheet is simply there and every line is written at once.

import type { ReceiptVM, UiIntent } from '../../game/viewModel';
import { PLAYER_COLORS } from '../../shared/palette';
import { drawIn, h, minus, motion, setText, toggle } from '../dom';
import { isPhone } from '../layout';
import { DROP_MS, grabHandle, resetSheet, sheetDrop, sheetIn, sheetLift, sheetOut } from '../sheet';

/** Between one line beginning and the next (the plan's ≈ 600 ms). */
export const RECEIPT_LINE_MS = 600;

export class Receipt {
  readonly el: HTMLDivElement;
  private sheet: HTMLDivElement;
  private title: HTMLHeadingElement;
  private lines: HTMLDivElement;
  private summary: HTMLParagraphElement;
  private vm: ReceiptVM | null = null;
  private key = -1;
  private timers: number[] = [];
  private leaving = false;
  /** Lines already announced for this key (each `receiptLine` goes once). */
  private sent = new Set<number>();

  constructor(private send: (i: UiIntent) => void) {
    this.el = h('div', 'receipt hidden');
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-live', 'polite');
    this.sheet = h('div', 'sheet receipt-sheet');
    this.title = h('h1', 'sheet-title rc-title');
    this.lines = h('div', 'rc-lines');
    this.summary = h('p', 'rc-summary num');
    this.sheet.append(grabHandle(), this.title, this.lines, this.summary);
    this.el.append(this.sheet);
    // Any tap or click anywhere dismisses. The whole press lands on the receipt (it covers the board), and
    // it acts on the click, so the release can't fall through to a territory as the sheet lifts away.
    this.el.addEventListener('pointerdown', (e) => {
      if (!this.vm || this.leaving) return;
      e.stopPropagation();
    });
    this.el.addEventListener('click', (e) => {
      if (!this.vm || this.leaving) return;
      e.stopPropagation();
      this.dismiss();
    });
  }

  /** True while the receipt is on the paper (the root routes any key to `dismiss`). */
  get open(): boolean {
    return !!this.vm && !this.leaving;
  }

  dismiss(): void {
    if (!this.vm) return;
    this.send({ type: 'dismissReceipt' });
  }

  update(vm: ReceiptVM | null | undefined): void {
    vm = vm ?? null;
    if (vm === this.vm) return;
    const was = this.vm;
    this.vm = vm;
    if (!vm) {
      this.clearTimers();
      this.key = -1;
      if (!was) return;
      this.el.removeAttribute('data-testid');
      this.leaving = true;
      this.el.classList.add('leaving');
      const done = () => {
        if (!this.leaving) return;
        this.leaving = false;
        this.el.classList.remove('leaving');
        resetSheet(this.sheet);
        this.el.style.opacity = '';
        if (!this.vm) this.el.classList.add('hidden');
      };
      if (isPhone()) sheetOut(this.sheet, this.el, done);
      else sheetLift(this.sheet, this.el, done);
      return;
    }
    if (this.leaving) {
      this.leaving = false;
      this.el.classList.remove('leaving');
      this.el.getAnimations().forEach((a) => a.cancel());
      this.el.style.opacity = '';
    }
    this.el.dataset.testid = 'receipt';
    this.el.setAttribute('aria-label', vm.title);
    if (vm.key === this.key) return;
    const fresh = !was || this.el.classList.contains('hidden');
    this.key = vm.key;
    this.write(vm, fresh);
  }

  private clearTimers(): void {
    this.timers.forEach((t) => window.clearTimeout(t));
    this.timers = [];
  }

  /** Lay the sheet down (if it isn't already) and write its lines in, one at a time. */
  private write(vm: ReceiptVM, fresh: boolean): void {
    this.clearTimers();
    this.sent.clear();
    setText(this.title, vm.title);
    this.lines.textContent = '';
    const els = vm.lines.map((l, i) => {
      const pal = PLAYER_COLORS[l.seat.color];
      const row = h('p', `rc-line num${l.stings ? ' stings' : ''}`);
      row.dataset.testid = `receipt-line-${i}`;
      row.style.setProperty('--seat-light', pal.light);
      row.style.setProperty('--seat', pal.base);
      const text = minus(l.text);
      // The seat's name (the line's first words) in its pigment; a line that stings is pigment throughout.
      if (text.startsWith(l.seat.name)) row.append(h('span', 'rc-name', l.seat.name), document.createTextNode(text.slice(l.seat.name.length)));
      else row.textContent = text;
      this.lines.append(row);
      return row;
    });
    setText(this.summary, vm.summary ? minus(vm.summary) : '');
    toggle(this.summary, 'hidden', !vm.summary);
    toggle(this.el, 'hidden', false);
    resetSheet(this.sheet);
    if (fresh) {
      if (isPhone()) sheetIn(this.sheet, this.el);
      else sheetDrop(this.sheet, this.el);
    }
    const at = (ms: number, fn: () => void) => {
      if (ms <= 0) fn();
      else this.timers.push(window.setTimeout(fn, ms));
    };
    const begin = (i: number) => {
      if (this.sent.has(i) || this.vm !== vm) return;
      this.sent.add(i);
      this.send({ type: 'receiptLine', index: i });
    };
    if (motion.reduced) {
      // Written at once: every line (and the board's pulses) now.
      this.summary.style.visibility = '';
      els.forEach((el, i) => {
        el.style.visibility = '';
        begin(i);
      });
      return;
    }
    // The title is brushed on as the sheet lands; the lines follow it, one every ≈ 600 ms.
    const t0 = fresh ? Math.round(DROP_MS * 0.75) : 0;
    drawIn(this.title, 320, t0);
    els.forEach((el) => (el.style.visibility = 'hidden'));
    this.summary.style.visibility = 'hidden';
    els.forEach((el, i) =>
      at(t0 + 360 + i * RECEIPT_LINE_MS, () => {
        el.style.visibility = '';
        drawIn(el, 420);
        begin(i);
      }),
    );
    if (vm.summary)
      at(t0 + 360 + els.length * RECEIPT_LINE_MS, () => {
        this.summary.style.visibility = '';
        drawIn(this.summary, 480);
      });
  }
}
