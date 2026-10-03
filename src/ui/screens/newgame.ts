// New game (UX.md §4.1, INK.md B5, INK2 §3.4): seats, length, setup, house rules drawer, summary + Start,
// on one paper sheet (one hairline across its top). Each seat is an ensō ring in its wash (tap → six
// brush-ring swatches on a patch of deeper paper), a serif name, `Human · AI` and the difficulty as words
// (the active one carries the brush underline, ivory 70 %). Start is the word in the gold brush ring.
// v3: the map picker first (each pack as its thumbnail in a hairline frame, its name in serif, one line and
// the seats it takes; the picked one's name carries the brush underline); an AI seat's personality as
// three words, Turtle · Opportunist · Warlord, with the chosen one's line in small text under it (and every
// word's line as its hover title); two house rules, Neutral armies (2 players) and Truces.
// v5 G: a third, Missions (off by default): each seat gets a secret mission; completing it wins.

import type { AiDifficulty, AiPersonality, PlayerColorId, PlayerKind } from '../../engine/types';
import type { HouseRulesDraft, LengthPreset, MapOptionVM, NewGameVM, PersonalityOptionVM, SeatDraft, SetupPreset, UiIntent } from '../../game/viewModel';
import { PLAYER_COLOR_IDS, PLAYER_COLORS } from '../../shared/palette';
import { Segmented, Switch, uiButton } from '../controls';
import { animateIn, emblem, ensoEl, h, hashSeed, ringEl, setAttr, setEmblem, setStyle, setText, toggle, underlineEl } from '../dom';
import { isPhone, layout } from '../layout';
import { dragToDismiss, grabHandle, sheetIn } from '../sheet';

type Send = (i: UiIntent) => void;

/** v5 G: the Missions switch's one line. */
const MISSIONS_LINE = 'Each seat gets a secret mission; completing it wins';

/** One colour emblem per seat; clicking it opens the six swatches (docs/ROUND2.md §E). */
class SeatRow {
  readonly el: HTMLDivElement;
  private swatches = new Map<PlayerColorId, HTMLButtonElement>();
  private colorBtn: HTMLButtonElement;
  private pop: HTMLDivElement;
  private swSheet: HTMLDivElement;
  private open = false;
  private name: HTMLInputElement;
  private kind: Segmented<PlayerKind>;
  private diff: Segmented<AiDifficulty>;
  private diffWrap: HTMLDivElement;
  private pers: Segmented<AiPersonality>;
  private persWrap: HTMLDivElement;
  private persLine: HTMLSpanElement;
  private persKey = '';
  private persOpts: PersonalityOptionVM[] = [];
  private remove: HTMLButtonElement;
  private num: HTMLSpanElement;
  private seat: SeatDraft | null = null;

  constructor(private index: number, send: Send) {
    this.el = h('div', 'seat-row');
    this.num = h('span', 'seat-num num', String(index + 1));
    const wrap = h('div', 'seat-color');
    this.colorBtn = h('button', 'swatch seat-emblem');
    this.colorBtn.type = 'button';
    this.colorBtn.dataset.testid = `seat-color-${index}`;
    this.colorBtn.setAttribute('aria-haspopup', 'true');
    this.colorBtn.setAttribute('aria-expanded', 'false');
    this.colorBtn.append(ensoEl(hashSeed(`seat${index}`), 'enso sw-ring', { small: true }), emblem('crimson', 'emb', 'light'));
    this.colorBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setOpen(!this.open);
    });
    // Desktop: a popover beside the emblem. Phones: a bottom sheet of six big swatches (mobile.css);
    // the pop itself is the scrim there, so a tap outside the sheet closes it.
    this.pop = h('div', 'swatch-pop hidden');
    const sheet = (this.swSheet = h('div', 'sw-sheet'));
    const sw = h('div', 'swatches');
    sw.setAttribute('role', 'radiogroup');
    sw.setAttribute('aria-label', `Seat ${index + 1} color`);
    sheet.append(grabHandle(), h('div', 'sw-title', `Seat ${index + 1} colour`), sw);
    this.pop.append(sheet);
    this.pop.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.target === this.pop) this.setOpen(false);
    });
    dragToDismiss(sheet, [sheet], { scrim: () => this.pop, onDismiss: () => this.setOpen(false) });
    wrap.append(this.colorBtn, this.pop);
    for (const c of PLAYER_COLOR_IDS) {
      const b = h('button', 'swatch');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', PLAYER_COLORS[c].name);
      b.dataset.tip = PLAYER_COLORS[c].name;
      b.dataset.testid = `seat-color-${index}-${c}`;
      setStyle(b, '--seat', PLAYER_COLORS[c].base);
      setStyle(b, '--seat-light', PLAYER_COLORS[c].light);
      b.append(ringEl(hashSeed(`sw${c}`), 1, undefined, { cls: 'sw-ring', weight: 1.7 }), emblem(c, 'emb', 'light'), h('span', 'sw-name', PLAYER_COLORS[c].name));
      b.addEventListener('click', () => {
        send({ type: 'seat', index: this.index, patch: { color: c } });
        this.setOpen(false);
      });
      this.swatches.set(c, b);
      sw.append(b);
    }
    this.name = h('input', 'name-input');
    this.name.type = 'text';
    this.name.maxLength = 12;
    this.name.spellcheck = false;
    this.name.autocomplete = 'off';
    this.name.setAttribute('aria-label', `Seat ${index + 1} name`);
    this.name.dataset.testid = `seat-name-${index}`;
    this.name.addEventListener('input', () => send({ type: 'seat', index: this.index, patch: { name: this.name.value } }));
    this.name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') this.name.blur();
    });
    this.kind = new Segmented<PlayerKind>('seg-row', (v) => send({ type: 'seat', index: this.index, patch: { kind: v } }), 'Human or AI', `seat-kind-${index}`);
    this.kind.setOptions([
      { value: 'human', label: 'Human' },
      { value: 'ai', label: 'AI' },
    ]);
    this.diffWrap = h('div', 'diff-wrap');
    this.diff = new Segmented<AiDifficulty>('seg-row', (v) => send({ type: 'seat', index: this.index, patch: { difficulty: v } }), 'AI difficulty', `seat-diff-${index}`);
    this.diff.setOptions([
      { value: 'easy', label: 'Easy' },
      { value: 'normal', label: 'Normal' },
      { value: 'hard', label: 'Hard' },
    ]);
    this.diffWrap.append(this.diff.el);
    // v3: how the AI plays. Three words; the chosen one's line in small text under it.
    this.persWrap = h('div', 'pers-wrap');
    this.pers = new Segmented<AiPersonality>('seg-row seg-pers', (v) => send({ type: 'seat', index: this.index, patch: { personality: v } }), 'AI personality', `seat-pers-${index}`);
    this.persLine = h('span', 'pers-line');
    this.persLine.dataset.testid = `seat-pers-line-${index}`;
    this.persWrap.append(this.pers.el, this.persLine);
    this.remove = h('button', 'icon-btn remove-seat');
    this.remove.type = 'button';
    this.remove.setAttribute('aria-label', `Remove seat ${index + 1}`);
    this.remove.dataset.testid = `seat-remove-${index}`;
    this.remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>';
    this.remove.addEventListener('click', () => {
      if (this.remove.getAttribute('aria-disabled') !== 'true') send({ type: 'removeSeat', index: this.index });
    });
    this.el.append(this.num, wrap, this.name, this.kind.el, this.diffWrap, this.persWrap, this.remove);
  }

  setOpen(on: boolean): void {
    if (on === this.open) return;
    this.open = on;
    toggle(this.pop, 'hidden', !on);
    this.colorBtn.setAttribute('aria-expanded', String(on));
    if (on) {
      if (isPhone()) sheetIn(this.swSheet, this.pop);
      else animateIn(this.pop.firstElementChild as HTMLElement, { ms: 160 });
      this.onOpen?.(this);
    }
  }

  get isOpen(): boolean {
    return this.open;
  }

  onOpen: ((row: SeatRow) => void) | null = null;

  /** Focus the name so typing edits it (UX: people skip naming otherwise); caret at the end, nothing selected (INK F8). */
  focusName(): void {
    // The caret waits at the end of the name: no selection block on open (typing edits it).
    this.name.focus({ preventScroll: true });
    const n = this.name.value.length;
    this.name.setSelectionRange(n, n);
  }

  get kindValue(): PlayerKind | null {
    return this.seat?.kind ?? null;
  }

  /** The chosen personality's line sits under its word (kept inside the row). */
  private placePersLine(): void {
    const b = this.pers.el.querySelector<HTMLElement>('.seg-opt.on');
    if (!b || !this.persWrap.offsetWidth) return;
    // Under the chosen word; a long line slides left (under the difficulty words if it must) so it ends
    // inside the row, never past the sheet.
    const row = this.el.getBoundingClientRect();
    const wrap = this.persWrap.getBoundingClientRect();
    const w = this.persLine.scrollWidth;
    const left = Math.max(-(wrap.left - row.left) + 4, Math.min(b.offsetLeft, row.right - wrap.left - w - 2));
    this.persLine.style.marginLeft = `${left}px`;
  }

  update(seat: SeatDraft, taken: Set<PlayerColorId>, canRemove: boolean, clash: boolean, personalities: PersonalityOptionVM[] = []): void {
    this.seat = seat;
    if (personalities !== this.persOpts) {
      this.persOpts = personalities;
      this.pers.setOptions(personalities.map((p) => ({ value: p.id, label: p.name })));
      for (const p of personalities) {
        const b = this.pers.el.querySelector<HTMLElement>(`[data-testid="seat-pers-${this.index}-${p.id}"]`);
        if (b) b.title = p.line;
      }
    }
    const ai = seat.kind === 'ai' && personalities.length > 0;
    toggle(this.persWrap, 'off', !ai);
    toggle(this.el, 'has-pers', ai);
    setAttr(this.persWrap, 'aria-hidden', ai ? null : 'true');
    const chosen = personalities.find((p) => p.id === seat.personality) ?? null;
    if (chosen) this.pers.set(chosen.id);
    setText(this.persLine, chosen?.line ?? '');
    const key = `${ai}:${chosen?.id ?? ''}`;
    if (key !== this.persKey) {
      this.persKey = key;
      requestAnimationFrame(() => this.placePersLine());
    }
    setStyle(this.el, '--seat', PLAYER_COLORS[seat.color].base);
    setStyle(this.colorBtn, '--seat', PLAYER_COLORS[seat.color].base);
    setStyle(this.colorBtn, '--seat-light', PLAYER_COLORS[seat.color].light);
    setEmblem(this.colorBtn.querySelector<SVGSVGElement>('.emb')!, seat.color, 'light');
    this.colorBtn.setAttribute('aria-label', `Seat ${this.index + 1} colour: ${PLAYER_COLORS[seat.color].name}`);
    toggle(this.colorBtn, 'clash', clash);
    for (const [c, b] of this.swatches) {
      const on = c === seat.color;
      toggle(b, 'on', on);
      b.setAttribute('aria-checked', String(on));
      toggle(b, 'taken', !on && taken.has(c));
      toggle(b, 'clash', on && clash);
    }
    if (document.activeElement !== this.name && this.name.value !== seat.name) this.name.value = seat.name;
    this.name.placeholder = `Seat ${this.index + 1}`;
    this.kind.set(seat.kind);
    this.diff.set(seat.difficulty);
    toggle(this.diffWrap, 'off', seat.kind !== 'ai');
    setAttr(this.diffWrap, 'aria-hidden', seat.kind !== 'ai' ? 'true' : null);
    setAttr(this.remove, 'aria-disabled', canRemove ? null : 'true');
    toggle(this.remove, 'is-disabled', !canRemove);
    this.remove.dataset.why = canRemove ? '' : 'At least 2 seats';
  }
}

/**
 * The map picker (v3, docs/MAPS.md): every pack as its thumbnail (radius 0, a 1 px ivory hairline frame), its
 * name in serif, one plain line and the seats it takes. The picked one's name carries the brush underline.
 */
class MapPicker {
  readonly el: HTMLDivElement;
  private opts = new Map<string, HTMLButtonElement>();
  private key = '';

  constructor(private send: Send) {
    this.el = h('div', 'map-picker');
    this.el.dataset.testid = 'map-picker';
    this.el.setAttribute('role', 'radiogroup');
    this.el.setAttribute('aria-label', 'Map');
  }

  update(maps: MapOptionVM[], mapId: string): void {
    const key = maps.map((m) => `${m.id}:${m.name}:${m.description}:${m.seats}:${m.thumbnail}:${m.disabled}`).join('|');
    if (key !== this.key) {
      this.key = key;
      this.el.textContent = '';
      this.opts.clear();
      for (const m of maps) {
        const b = h('button', 'map-opt');
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.dataset.testid = `map-${m.id}`;
        b.dataset.map = m.id;
        const frame = h('span', 'map-thumb');
        if (m.thumbnail) {
          const img = h('img', 'map-img');
          img.src = m.thumbnail;
          img.alt = '';
          img.decoding = 'async';
          frame.append(img);
        }
        const text = h('span', 'map-text');
        const name = h('span', 'map-name', m.name);
        name.append(underlineEl(hashSeed(`map-${m.id}`), undefined, 'brush-ul map-ul'));
        text.append(name, h('span', 'map-desc', m.description), h('span', 'map-seats', m.seats));
        b.append(frame, text);
        if (m.disabled) b.setAttribute('aria-disabled', 'true');
        b.addEventListener('click', () => {
          if (m.disabled || b.classList.contains('on')) return;
          this.send({ type: 'map', id: m.id });
        });
        this.opts.set(m.id, b);
        this.el.append(b);
      }
    }
    for (const [id, b] of this.opts) {
      const on = id === mapId;
      toggle(b, 'on', on);
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
  }
}

export class NewGameScreen {
  readonly el: HTMLElement;
  private seatsWrap: HTMLDivElement;
  private rows: SeatRow[] = [];
  private addBtn: HTMLButtonElement;
  private length: Segmented<LengthPreset>;
  private setup: Segmented<SetupPreset>;
  private summary: HTMLParagraphElement;
  private problems: HTMLUListElement;
  private start: HTMLButtonElement;
  private houseBtn: HTMLButtonElement;
  private house: HTMLDivElement;
  private houseOpen = false;
  private maps: MapPicker;
  private h: {
    neutral: Switch;
    truces: Switch;
    missions: Switch;
    draft: Switch;
    cards: Segmented<HouseRulesDraft['cardBonus']>;
    fortify: Segmented<HouseRulesDraft['fortifyRule']>;
    batch: Segmented<string>;
    seed: HTMLInputElement;
  };
  private vm: NewGameVM | null = null;

  constructor(private send: Send) {
    this.el = h('section', 'screen newgame-screen');
    const sheet = h('div', 'sheet ng-sheet');
    const head = h('div', 'sheet-head');
    head.append(h('h1', 'sheet-title', 'New game'), uiButton('Back', 'role-exit', () => send({ type: 'nav', screen: 'title' }), undefined, 'ng-back'));

    const grid = h('div', 'ng-grid');
    // Map (v3)
    this.maps = new MapPicker(send);
    grid.append(h('div', 'ng-label', 'Map'), this.maps.el);
    // Seats
    this.seatsWrap = h('div', 'seats');
    this.addBtn = uiButton('Add a seat', 'role-exit add-seat', () => send({ type: 'addSeat' }), undefined, 'add-seat');
    const seatsCell = h('div', 'ng-cell');
    seatsCell.append(this.seatsWrap, this.addBtn);
    grid.append(h('div', 'ng-label', 'Seats'), seatsCell);
    // Length
    this.length = new Segmented<LengthPreset>('seg-cards', (v) => send({ type: 'length', value: v }), 'Game length', 'length');
    grid.append(h('div', 'ng-label', 'Length'), this.length.el);
    // Setup
    this.setup = new Segmented<SetupPreset>('seg-cards', (v) => send({ type: 'setup', value: v }), 'Setup', 'setup');
    grid.append(h('div', 'ng-label', 'Setup'), this.setup.el);

    // House rules drawer
    this.houseBtn = h('button', 'house-toggle');
    this.houseBtn.type = 'button';
    this.houseBtn.dataset.houseToggle = '';
    this.houseBtn.dataset.testid = 'house-toggle';
    this.houseBtn.innerHTML =
      '<span>House rules</span><span class="house-sum"></span>';
    this.houseBtn.addEventListener('click', () => this.setHouseOpen(!this.houseOpen));
    this.house = h('div', 'house hidden');
    const patch = (p: Partial<HouseRulesDraft>) => send({ type: 'house', patch: p });
    const draft = new Switch('Draft territories', (v) => patch({ draft: v }), 'Take turns claiming them · adds ~10 min', 'house-draft');
    const neutral = new Switch('Neutral armies', (v) => patch({ neutral: v }), 'Two players · a third army holds 14 territories', 'house-neutral');
    const truces = new Switch('Truces', (v) => patch({ truces: v }), 'AIs with a personality offer and take them', 'house-truces');
    const missions = new Switch('Missions', (v) => patch({ missions: v }), MISSIONS_LINE, 'house-missions');
    const cards = new Segmented<HouseRulesDraft['cardBonus']>('seg-row', (v) => patch({ cardBonus: v }), 'Card values', 'house-cards');
    cards.setOptions([
      { value: 'progressive', label: 'Growing', detail: '4, 6, 8, 10 …' },
      { value: 'fixed', label: 'Fixed', detail: '4 · 6 · 8 · 10' },
    ]);
    const fortify = new Segmented<HouseRulesDraft['fortifyRule']>('seg-row', (v) => patch({ fortifyRule: v }), 'Fortify rule', 'house-fortify');
    fortify.setOptions([
      { value: 'connected', label: 'Connected', detail: 'any chain of yours' },
      { value: 'adjacent', label: 'Adjacent', detail: 'neighbors only' },
    ]);
    const batch = new Segmented<string>('seg-row', (v) => patch({ setupBatch: v === 'auto' ? 'auto' : Number(v) }), 'Setup batch', 'house-batch');
    batch.setOptions([
      { value: 'auto', label: 'Two passes' },
      { value: '3', label: '3' },
      { value: '5', label: '5' },
      { value: '8', label: '8' },
    ]);
    const seed = h('input', 'name-input seed-input num');
    seed.type = 'text';
    seed.inputMode = 'numeric';
    seed.placeholder = 'Random';
    seed.maxLength = 10;
    seed.setAttribute('aria-label', 'Seed');
    seed.dataset.testid = 'house-seed';
    seed.addEventListener('input', () => {
      const digits = seed.value.replace(/\D/g, '');
      if (digits !== seed.value) seed.value = digits;
      patch({ seed: digits ? Number(digits) : null });
    });
    seed.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') seed.blur();
    });
    this.h = { neutral, truces, missions, draft, cards, fortify, batch, seed };
    const hf = (label: string, ctl: HTMLElement, detail?: string) => {
      const f = h('div', 'field');
      const l = h('div', 'field-label');
      l.append(h('span', '', label));
      if (detail) l.append(h('span', 'field-detail', detail));
      f.append(l, ctl);
      return f;
    };
    const hg = h('div', 'house-grid');
    hg.append(
      neutral.el,
      truces.el,
      missions.el,
      draft.el,
      hf('Card sets', cards.el),
      hf('Fortify', fortify.el),
      hf('Armies per setup turn', batch.el, 'Place your own only'),
      hf('Seed', seed, 'Same seed, same dice'),
    );
    this.house.append(hg);
    grid.append(h('div', 'ng-label'), this.houseBtn, h('div', ''), this.house);

    const foot = h('div', 'ng-foot');
    const sumWrap = h('div', 'ng-sum');
    this.summary = h('p', 'ng-summary num');
    this.summary.dataset.testid = 'ng-summary';
    this.problems = h('ul', 'ng-problems');
    sumWrap.append(this.summary, this.problems);
    this.start = uiButton('Start', 'brass role-primary big', () => {
      if (this.vm?.canStart) send({ type: 'start' });
    }, 'Enter', 'ng-start');
    foot.append(sumWrap, this.start);
    sheet.append(head, grid, foot);
    this.el.append(sheet);
    // One swatch popover at a time; a click anywhere else (or Esc, in src/ui/index.ts) closes it.
    this.el.addEventListener('click', () => this.closeSwatches());
  }

  /** Close any open colour popover. True if one was open. */
  closeSwatches(): boolean {
    const open = this.rows.filter((r) => r.isOpen);
    open.forEach((r) => r.setOpen(false));
    return open.length > 0;
  }

  setHouseOpen(on: boolean): void {
    this.houseOpen = on;
    toggle(this.houseBtn, 'open', on);
    this.houseBtn.setAttribute('aria-expanded', String(on));
    toggle(this.house, 'hidden', !on);
    if (on) animateIn(this.house);
  }

  /** On entering the screen: the first human seat's name, focused. */
  focusFirstName(): void {
    // Touch: focusing a field raises the on-screen keyboard over the screen; the player taps a name to edit.
    if (layout.touch || isPhone()) return;
    const row = this.rows.find((r) => r.kindValue === 'human');
    row?.focusName();
  }

  update(vm: NewGameVM): void {
    if (this.vm === vm) return;
    this.vm = vm;
    while (this.rows.length < vm.seats.length) {
      const r = new SeatRow(this.rows.length, this.send);
      r.onOpen = (me) => this.rows.forEach((x) => x !== me && x.setOpen(false));
      this.rows.push(r);
      this.seatsWrap.append(r.el);
      if (this.rows.length > 2) animateIn(r.el);
    }
    while (this.rows.length > vm.seats.length) this.rows.pop()!.el.remove();
    const counts = new Map<PlayerColorId, number>();
    for (const s of vm.seats) counts.set(s.color, (counts.get(s.color) ?? 0) + 1);
    vm.seats.forEach((s, i) => {
      const taken = new Set(vm.seats.filter((_, j) => j !== i).map((x) => x.color));
      this.rows[i].update(s, taken, vm.canRemoveSeat, (counts.get(s.color) ?? 0) > 1, vm.personalities);
    });
    if (vm.maps?.length) this.maps.update(vm.maps, vm.mapId ?? vm.maps[0].id);
    toggle(this.maps.el, 'hidden', !vm.maps?.length);
    toggle(this.maps.el.previousElementSibling as HTMLElement, 'hidden', !vm.maps?.length);
    toggle(this.addBtn, 'hidden', !vm.canAddSeat);

    this.length.setOptions(vm.lengthOptions.map((o) => ({ value: o.id, label: o.label, detail: o.detail, meta: o.estimate })));
    this.length.set(vm.length);
    this.setup.setOptions(vm.setupOptions.map((o) => ({ value: o.id, label: o.label, detail: o.detail })));
    this.setup.set(vm.setup);

    const hr = vm.house;
    // v3 house rules: on by default; a rule that doesn't apply to this table says why, dimmed.
    this.h.neutral.set(hr.neutral !== false);
    this.h.truces.set(hr.truces !== false);
    const na = (sw: Switch, applies: boolean, yes: string, no: string) => {
      toggle(sw.el, 'na', !applies);
      setText(sw.el.querySelector('.switch-detail')!, applies ? yes : no);
    };
    na(this.h.neutral, vm.neutralApplies !== false, 'Two players · a third army holds 14 territories', 'Two-player games only');
    na(this.h.truces, vm.trucesApply !== false, 'AIs with a personality offer and take them', 'Needs a human and an AI at the table');
    this.h.missions.set(hr.missions === true);
    na(this.h.missions, vm.missionsApply !== false, MISSIONS_LINE, 'Three or more players, or two with neutral armies');
    this.h.draft.set(hr.draft);
    this.h.cards.set(hr.cardBonus);
    this.h.fortify.set(hr.fortifyRule);
    this.h.batch.set(String(hr.setupBatch));
    if (document.activeElement !== this.h.seed) this.h.seed.value = hr.seed == null ? '' : String(hr.seed);
    const changed: string[] = [];
    if (hr.draft) changed.push('draft');
    if (hr.cardBonus === 'fixed') changed.push('fixed cards');
    if (hr.fortifyRule === 'adjacent') changed.push('adjacent fortify');
    if (hr.setupBatch !== 'auto') changed.push(`${hr.setupBatch} per setup turn`);
    if (hr.seed != null) changed.push(`seed ${hr.seed}`);
    if (hr.neutral === false && vm.neutralApplies) changed.push('no neutral armies');
    if (hr.truces === false && vm.trucesApply) changed.push('no truces');
    if (hr.missions === true && vm.missionsApply !== false) changed.push('missions');
    setText(this.houseBtn.querySelector('.house-sum')!, changed.length ? changed.join(' · ') : 'classic');

    setText(this.summary, vm.summary);
    this.problems.textContent = '';
    for (const p of vm.problems) this.problems.append(h('li', '', p));
    toggle(this.problems, 'hidden', vm.problems.length === 0);
    toggle(this.start, 'is-disabled', !vm.canStart);
    setAttr(this.start, 'aria-disabled', vm.canStart ? null : 'true');
    this.start.dataset.why = vm.canStart ? '' : (vm.problems[0] ?? 'Fix the seats first');
  }
}
