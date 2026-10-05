// The cards sheet behind `Cards N` (docs/SIMPLIFY.md §1): your hand, one status line, and a single
// `Trade for +8` (the word in a gold brush ring, GoldVM 'cardsTrade') when a set is ready. It is for
// looking: the best set is chosen for you. A card is a card: a straight-edged hairline rectangle.

import type { CardVM, CardsVM, UiIntent } from '../../game/viewModel';
import { uiButton } from '../controls';
import { animateIn, animateOut, h, setText, toggle } from '../dom';
import { isPhone } from '../layout';
import { dragToDismiss, grabHandle, sheetIn, sheetOut } from '../sheet';
import { pictogram, SYMBOL_NAME } from './pictograms';

class CardFace {
  readonly el: HTMLDivElement;
  private art: HTMLDivElement;
  private sym: HTMLSpanElement;
  private terr: HTMLSpanElement;
  private bonus: HTMLSpanElement;
  private symbol: CardVM['symbol'] | null = null;
  private vm: CardVM | null = null;

  constructor() {
    this.el = h('div', 'card');
    this.art = h('div', 'card-art');
    this.sym = h('span', 'card-sym');
    this.terr = h('span', 'card-terr');
    this.bonus = h('span', 'card-bonus', '+2');
    this.el.append(this.bonus, this.art, this.sym, this.terr);
  }

  update(vm: CardVM): void {
    if (this.vm === vm) return;
    this.vm = vm;
    this.el.dataset.testid = `card-${vm.id}`;
    if (this.symbol !== vm.symbol) {
      this.symbol = vm.symbol;
      this.art.textContent = '';
      this.art.append(pictogram(vm.symbol));
      setText(this.sym, SYMBOL_NAME[vm.symbol]);
    }
    setText(this.terr, vm.territory ?? 'Any symbol');
    toggle(this.bonus, 'hidden', !vm.ownedBonus);
    toggle(this.el, 'in-set', vm.inSet);
    toggle(this.el, 'wild', vm.symbol === 'wild');
    this.el.setAttribute('aria-label', `${SYMBOL_NAME[vm.symbol]}${vm.territory ? `, ${vm.territory}` : ''}${vm.ownedBonus ? ', yours, +2' : ''}`);
  }
}

export class CardsSheet {
  readonly el: HTMLElement;
  /** Phones: the scrim behind the bottom sheet (a tap closes it). Mounted just before `el`. */
  readonly scrim: HTMLDivElement;
  private grid: HTMLDivElement;
  private status: HTMLDivElement;
  private trade: HTMLButtonElement;
  private tradeLabel: HTMLSpanElement;
  private faces = new Map<number, CardFace>();
  private vm: CardsVM | null = null;
  private shown = false;

  constructor(send: (i: UiIntent) => void) {
    this.el = h('section', 'cards-sheet panel hidden');
    this.el.setAttribute('aria-label', 'Your cards');
    this.scrim = h('div', 'cards-scrim hidden');
    this.scrim.addEventListener('click', () => send({ type: 'cardsPanel', open: false }));
    this.el.append(grabHandle());
    const head = h('div', 'cs-head');
    const close = h('button', 'icon-btn nofocus');
    close.type = 'button';
    close.dataset.testid = 'cards-close';
    close.setAttribute('aria-label', 'Close');
    close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>';
    close.addEventListener('click', () => send({ type: 'cardsPanel', open: false }));
    head.append(h('h2', 'cs-title', 'Your cards'), close);
    this.grid = h('div', 'cards-grid');
    this.status = h('div', 'cards-status');
    this.trade = uiButton('', 'brass role-primary', () => send({ type: 'button', id: 'trade' }), undefined, 'cards-trade');
    this.tradeLabel = this.trade.querySelector('.btn-label')!;
    const foot = h('div', 'cs-foot');
    foot.append(this.status, this.trade);
    this.el.append(head, this.grid, foot);
    dragToDismiss(this.el, [this.el.querySelector<HTMLElement>('.grab')!, head], {
      scrim: () => this.scrim,
      onDismiss: () => {
        this.dragged = true;
        send({ type: 'cardsPanel', open: false });
      },
    });
  }

  private dragged = false;

  update(vm: CardsVM | null): void {
    if (vm === this.vm) return;
    this.vm = vm;
    const open = !!vm?.open;
    if (open !== this.shown) {
      this.shown = open;
      const phone = isPhone();
      if (open) {
        this.el.getAnimations().forEach((a) => a.cancel());
        this.el.classList.remove('hidden');
        this.el.dataset.testid = 'cards';
        if (phone) {
          this.scrim.classList.remove('hidden', 'leaving');
          this.el.classList.remove('leaving');
          sheetIn(this.el, this.scrim);
        } else animateIn(this.el, { dy: 10 });
      } else {
        delete this.el.dataset.testid;
        const hide = () => {
          this.scrim.classList.remove('leaving');
          this.el.classList.remove('leaving');
          if (this.shown) return;
          this.el.classList.add('hidden');
          this.scrim.classList.add('hidden');
        };
        this.scrim.classList.add('leaving');
        if (phone) this.el.classList.add('leaving');
        if (phone && this.dragged) hide();
        else if (phone) sheetOut(this.el, this.scrim, hide);
        else animateOut(this.el, { dy: 8, remove: false }, hide);
      }
      this.dragged = false;
    }
    // v5.1 A (privacy without a cover): the hand is drawn only while the sheet is open. A closing sheet keeps the
    // faces it had; the next seat's cards are rendered only when that seat opens the sheet.
    if (!vm || !open) return;
    const seen = new Set<number>();
    vm.hand.forEach((c, i) => {
      let f = this.faces.get(c.id);
      if (!f) {
        f = new CardFace();
        this.faces.set(c.id, f);
      }
      f.update(c);
      seen.add(c.id);
      if (this.grid.children[i] !== f.el) this.grid.insertBefore(f.el, this.grid.children[i] ?? null);
    });
    for (const [id, f] of this.faces) if (!seen.has(id)) (f.el.remove(), this.faces.delete(id));
    setText(this.status, vm.status);
    toggle(this.trade, 'hidden', !vm.trade);
    if (vm.trade) setText(this.tradeLabel, vm.trade.label);
  }
}
