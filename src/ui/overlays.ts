// Modal-ish layers: the confirm dialog, and the menu (the ensō / Esc) with the sheets it opens: rules,
// settings (AI speed and the seat hand-off live here) and the read-only log. Every one
// is a paper sheet (docs/INK2.md §3.3): straight-edged deeper paper with one ivory hairline across its
// top and the title sitting on it, items as words with room between them; focus is a gold hairline
// underline. No radius, no box round a control. v4 (E1, E8): the paper carries the board's fibre and the
// one lamp's shadow, and is laid on the board from the top edge and lifted off it again (sheet.ts
// sheetDrop / sheetLift); never fading in from nowhere. Phones: bottom sheets (the same paper, rising).
// v5.1 (QUIETER §3 A, E3): the hand-off cover is gone (the turn line and the filled seat ring say whose turn
// it is). Settings show four things (Sound, Score, AI speed, Text size); the rest folds under one word, 'More'.

import type { GameVM, LogLineVM, SeatRef, Settings, UiIntent, ViewModel } from '../game/viewModel';

import { PLAYER_COLORS } from '../shared/palette';
import { moreWord, Segmented, setMoreWord, Slider, Switch, uiButton } from './controls';
import { animateIn, drawEnso, drawIn, EASE_IN_QUAD, emblem, ensoEl, h, hashSeed, minus, motion, setAttr, setEnso, setStyle, setText, titleText, toggle, underlineEl } from './dom';
import { unitSrc } from './hud/pictograms';
import { isPhone } from './layout';
import { dragToDismiss, grabHandle, resetSheet, sheetDrop, sheetIn, sheetLift, sheetOut } from './sheet';

type Send = (i: UiIntent) => void;

// ---------------------------------------------------------------------------
// Confirm dialog (End game now / Restart): the only confirms in the game.
// ---------------------------------------------------------------------------

export class Confirm {
  readonly el: HTMLDivElement;
  private text: HTMLParagraphElement;
  private yesLabel: HTMLSpanElement;
  private box: HTMLDivElement;
  private vm: GameVM['confirm'] = null;
  private yes: HTMLButtonElement;

  constructor(send: Send) {
    this.el = h('div', 'scrim confirm hidden');
    this.el.setAttribute('role', 'alertdialog');
    this.el.setAttribute('aria-modal', 'true');
    this.box = h('div', 'sheet confirm-box');
    this.box.append(grabHandle());
    this.text = h('p', 'confirm-text num');
    // Phones: an action sheet; a tap on the scrim or a pull down is "Keep playing".
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el && isPhone()) send({ type: 'confirm', yes: false });
    });
    dragToDismiss(this.box, [this.box], { scrim: () => this.el, onDismiss: () => send({ type: 'confirm', yes: false }) });
    const row = h('div', 'confirm-row');
    // Two words: the safe one (`Keep playing`) carries the gold ring; the destructive one is a bare word.
    this.yes = uiButton('', 'role-secondary', () => send({ type: 'confirm', yes: true }), undefined, 'confirm-yes');
    this.yesLabel = this.yes.querySelector('.btn-label')!;
    row.append(uiButton('Keep playing', 'brass role-primary', () => send({ type: 'confirm', yes: false }), undefined, 'confirm-no'), this.yes);
    this.box.append(this.text, row);
    this.el.append(this.box);
  }

  /** The sheet is leaving (lifting off desktop, sliding down on phones). */
  private leaving = false;

  update(vm: GameVM['confirm']): void {
    if (vm === this.vm) return;
    const was = this.vm;
    this.vm = vm;
    if (!vm) {
      if (!was) return toggle(this.el, 'hidden', true);
      // The sheet leaves the way it came; the scrim goes with it. Taps pass through meanwhile.
      this.leaving = true;
      this.el.classList.add('leaving');
      const done = () => {
        if (!this.leaving) return;
        this.leaving = false;
        this.el.classList.remove('leaving');
        resetSheet(this.box);
        this.el.style.opacity = '';
        if (!this.vm) this.el.classList.add('hidden');
      };
      // A pull-down already slid it off (parked at 100 %): just hide.
      if (!isPhone()) sheetLift(this.box, this.el, done);
      else if (this.box.style.transform.includes('100%')) done();
      else sheetOut(this.box, this.el, done);
      return;
    }
    if (this.leaving) {
      this.leaving = false;
      this.el.classList.remove('leaving');
      this.el.getAnimations().forEach((a) => a.cancel());
      this.el.style.opacity = '';
    }
    toggle(this.el, 'hidden', false);
    setText(this.text, vm.text);
    setText(this.yesLabel, vm.kind === 'endGame' ? 'End game' : 'Restart');
    if (!was) {
      if (isPhone()) sheetIn(this.box, this.el);
      else {
        sheetDrop(this.box, this.el);
        drawIn(this.box.querySelector<HTMLElement>('.confirm-text')!, 240, motion.reduced ? 0 : 200);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The menu and its sheets: one scrim, four sheets.
// ---------------------------------------------------------------------------

/** How to play: one scroll, five short blocks, each with a tiny ink picture (INK.md B5). */
const RULE_BLOCKS: { title: string; text: string[]; art: () => HTMLElement }[] = [
  {
    title: 'A turn',
    text: [
      'Place your new armies, attack as often as you like, then make one fortify move. The track at the bottom shows where you are; click the next step to move on.',
      'Take at least one territory in a turn to earn a card.',
    ],
    art: () => {
      // The Turn Track in miniature (INK2 §3.3): a tiny gold rule with the ensō over Attack, the four
      // words, and the brush underline under the current one.
      const t = h('div', 'ra-track');
      const rule = h('div', 'ra-rule');
      rule.append(h('i'), h('i'), ensoEl(2026, 'enso', { small: true }));
      const words = h('div', 'ra-words');
      ['Place', 'Attack', 'Fortify', 'End turn'].forEach((w, i) => {
        const s = h('span', i === 1 ? 'on' : '', w);
        if (i === 1) s.append(underlineEl(hashSeed('ra-attack')));
        words.append(s);
      });
      t.append(rule, words);
      // The ensō sits over Attack: once laid out, put it there.
      requestAnimationFrame(function place() {
        const on = words.querySelector<HTMLElement>('.on');
        if (!on || !t.offsetWidth) return void (t.isConnected || requestAnimationFrame(place));
        t.style.setProperty('--rx', `${on.offsetLeft + on.offsetWidth / 2}px`);
      });
      new ResizeObserver(() => {
        const on = words.querySelector<HTMLElement>('.on');
        if (on && t.offsetWidth) t.style.setProperty('--rx', `${on.offsetLeft + on.offsetWidth / 2}px`);
      }).observe(t);
      return t;
    },
  },
  {
    title: 'Armies and cards',
    text: [
      '1 army per 3 territories you hold (at least 3), plus a bonus for each whole continent.',
      'Three of a kind, one of each, or any two plus a wild trades for more. Sets grow every time anyone trades. At 5 cards you must trade.',
    ],
    art: () => {
      const r = h('div', 'ra-cards');
      for (const n of ['soldier', 'rider', 'cannon'] as const) {
        const c = h('span', 'ra-card');
        const img = h('img');
        img.alt = '';
        img.src = unitSrc(n);
        c.append(img);
        r.append(c);
      }
      r.append(h('span', 'ra-plus num', '+ armies'));
      return r;
    },
  },
  {
    title: 'Pieces',
    text: ['Pieces show army size: soldier 1–4, horse 5–9, cannon 10+.', 'The number beside each piece is the exact count.'],
    art: () => {
      const r = h('div', 'ra-units');
      for (const [n, label] of [
        ['soldier', '1–4'],
        ['rider', '5–9'],
        ['cannon', '10+'],
      ] as const) {
        const u = h('figure', 'ra-unit');
        const img = h('img');
        img.alt = '';
        img.src = unitSrc(n);
        u.append(img, h('figcaption', 'num', label));
        r.append(u);
      }
      return r;
    },
  },
  {
    title: 'Attacking',
    text: [
      'Attack a neighbor from a territory with 2+ armies: pick the enemy, or draw a stroke from yours to it. You roll up to 3 dice, the defender up to 2.',
      'Highest dice pair off, one loss per pair. Ties go to the defender.',
    ],
    art: () => {
      const r = h('div', 'ra-dice');
      const row = (vals: number[], cls: string, lose: boolean[]) => {
        const d = h('div', `ra-drow ${cls}`);
        vals.forEach((v, i) => d.append(die(v, lose[i])));
        return d;
      };
      r.append(row([6, 4, 2], 'att', [false, true, false]), row([5, 4], 'def', [true, false]));
      return r;
    },
  },
  {
    title: 'Fortify',
    text: ['Move armies once, through your own connected territories. It ends your turn.', 'One army always stays behind to hold a territory.'],
    art: () => {
      const r = h('div', 'ra-route');
      r.innerHTML =
        '<svg viewBox="0 0 220 60" aria-hidden="true"><path d="M34 34 C 80 8, 140 8, 186 30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="1 7"/></svg>';
      const a = ensoEl(21, 'enso ra-ring a', { small: true });
      const b = ensoEl(34, 'enso ra-ring b', { small: true });
      r.append(a, b, h('span', 'ra-n a num', '6'), h('span', 'ra-n b num', '2'));
      return r;
    },
  },
];

/** A bone die in ink: an ivory hairline square with pips; a loser is faded. */
function die(v: number, lost: boolean): HTMLElement {
  const P: Record<number, [number, number][]> = {
    1: [[12, 12]],
    2: [[7, 7], [17, 17]],
    3: [[7, 7], [12, 12], [17, 17]],
    4: [[7, 7], [17, 7], [7, 17], [17, 17]],
    5: [[7, 7], [17, 7], [12, 12], [7, 17], [17, 17]],
    6: [[7, 6.5], [17, 6.5], [7, 12], [17, 12], [7, 17.5], [17, 17.5]],
  };
  const s = h('span', `ra-die${lost ? ' lost' : ''}`);
  s.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="1.5" y="1.5" width="21" height="21" rx="4.5" fill="none" stroke="currentColor" stroke-width="1.2"/>${P[v]
    .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.9" fill="currentColor"/>`)
    .join('')}</svg>`;
  return s;
}

/**
 * The ledger (v3, _claude/v3/PLAN.md §3): the game's sentences as an ink scroll, by round, the newest round
 * first and open, the older rounds folded (a tap on a round's heading opens or folds it). Two taps away
 * (menu, Ledger) or one (the event line above the dock). It later feeds the "war in ink" victory.
 */
class LogSheet {
  readonly el: HTMLDivElement;
  private list: HTMLDivElement;
  private empty: HTMLDivElement;
  private lines: LogLineVM[] | null = null;
  /** Rounds the reader opened or folded by hand (round → open). */
  private opened = new Map<number, boolean>();
  head!: HTMLDivElement;

  constructor(back: () => void) {
    this.el = h('div', 'sheet log-sheet');
    this.el.append(grabHandle());
    const head = h('div', 'sheet-head');
    head.append(h('h1', 'sheet-title', 'Ledger'), uiButton('Close', 'role-exit', back, undefined, 'log-close'));
    this.list = h('div', 'log-list');
    this.empty = h('div', 'log-empty', 'Nothing yet. Every move of the game is written here, round by round.');
    this.el.append(head, this.list, this.empty);
    this.head = head;
  }

  update(lines: LogLineVM[]): void {
    if (lines === this.lines) return;
    this.lines = lines;
    this.list.textContent = '';
    const byRound = new Map<number, LogLineVM[]>();
    for (const l of lines) {
      const r = Math.max(0, l.round);
      if (!byRound.has(r)) byRound.set(r, []);
      byRound.get(r)!.push(l);
    }
    const rounds = [...byRound.keys()].sort((x, y) => y - x);
    rounds.forEach((r, i) => {
      const sec = h('section', 'lg-round');
      sec.dataset.round = String(r);
      const ls = byRound.get(r)!;
      const btn = h('button', 'lg-head nofocus');
      btn.type = 'button';
      btn.dataset.testid = `ledger-round-${r}`;
      btn.append(h('span', 'lg-r', r > 0 ? `Round ${r}` : 'The deal'), h('span', 'lg-n num', `${ls.length} ${ls.length === 1 ? 'line' : 'lines'}`));
      const body = h('div', 'lg-lines');
      // newest first within the round too
      for (let k = ls.length - 1; k >= 0; k--) {
        const l = ls[k];
        const row = h('div', `log-line kind-${l.kind}`);
        const emb = h('span', 'log-emb');
        if (l.seat) emb.append(emblem(l.seat.color));
        row.append(emb, h('span', 'log-text', minus(l.text)));
        body.append(row);
      }
      const open = this.opened.get(r) ?? i === 0;
      toggle(sec, 'closed', !open);
      btn.setAttribute('aria-expanded', String(open));
      btn.addEventListener('click', () => {
        const now = sec.classList.contains('closed');
        this.opened.set(r, now);
        toggle(sec, 'closed', !now);
        btn.setAttribute('aria-expanded', String(now));
      });
      sec.append(btn, body);
      this.list.append(sec);
    });
    toggle(this.empty, 'hidden', lines.length > 0);
    this.list.scrollTop = 0;
  }
}

export class Overlays {
  readonly el: HTMLDivElement;
  private pause: HTMLDivElement;
  private rules: HTMLDivElement;
  private settings: HTMLDivElement;
  private log: LogSheet;
  private rulesHouse: HTMLDivElement;
  private current: string | null = null;
  private s: {
    anim: Segmented<0 | 1 | 2>;
    ai: Segmented<Settings['aiSpeed']>;
    text: Segmented<Settings['textSize']>;
    vol: Slider;
    mvol: Slider;
    sw: Record<string, Switch>;
  };
  private fitNote: HTMLSpanElement;
  private moreBtn: HTMLButtonElement;
  private more: HTMLDivElement;
  private moreOpen = false;
  private seats: HTMLDivElement;
  private seatsKey = '';
  private screen = '';

  constructor(private send: Send) {
    this.el = h('div', 'scrim overlays hidden');
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-modal', 'true');
    // A click on the scrim itself (not a sheet) closes the menu; on phones, any sheet.
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el && (this.current === 'pause' || (isPhone() && this.current))) send({ type: 'overlay', overlay: null });
    });

    // Menu
    this.pause = h('div', 'sheet pause-sheet');
    const ph = h('div', 'pause-head');
    ph.append(h('h1', 'sheet-title', 'Menu'));
    this.pause.append(grabHandle(), ph);
    const list = h('div', 'menu-list');
    list.append(
      uiButton('Resume', 'menu-item resume', () => send({ type: 'overlay', overlay: null }), undefined, 'pause-resume'),
      uiButton('How to play', 'menu-item', () => send({ type: 'overlay', overlay: 'rules' }), undefined, 'pause-rules'),
      uiButton('Settings', 'menu-item', () => send({ type: 'overlay', overlay: 'settings' }), undefined, 'pause-settings'),
      uiButton('Ledger', 'menu-item', () => send({ type: 'overlay', overlay: 'log' }), undefined, 'pause-log'),
      uiButton('Save & quit', 'menu-item', () => send({ type: 'saveAndQuit' }), undefined, 'pause-quit'),
      h('div', 'menu-sep'),
      uiButton('End game now', 'menu-item quiet', () => send({ type: 'endGameNow' }), undefined, 'pause-endgame'),
      uiButton('Restart', 'menu-item quiet', () => send({ type: 'restart' }), undefined, 'pause-restart'),
    );
    this.pause.append(list);

    // Rules
    this.rules = h('div', 'sheet rules-sheet');
    this.rules.append(grabHandle());
    const rh = h('div', 'sheet-head');
    rh.append(h('h1', 'sheet-title', 'How to play'));
    rh.append(uiButton('Close', 'role-exit', () => send({ type: 'overlay', overlay: this.backTarget() }), undefined, 'rules-close'));
    const blocks = h('div', 'rules-blocks');
    for (const r of RULE_BLOCKS) {
      const blk = h('div', 'rule');
      const art = h('div', 'rule-art');
      art.append(r.art());
      const txt = h('div', 'rule-text');
      txt.append(h('h2', 'rule-title', r.title));
      r.text.forEach((t, i) => txt.append(h('p', i ? 'dim' : '', t)));
      blk.append(art, txt);
      blocks.append(blk);
    }
    this.rulesHouse = h('div', 'rule house');
    blocks.append(this.rulesHouse);
    this.rules.append(rh, blocks);

    // Settings
    this.settings = h('div', 'sheet settings-sheet');
    this.settings.append(grabHandle());
    const sh = h('div', 'sheet-head');
    sh.append(h('h1', 'sheet-title', 'Settings'));
    sh.append(uiButton('Done', 'role-exit', () => send({ type: 'overlay', overlay: this.backTarget() }), undefined, 'settings-done'));
    const set = (patch: Partial<Settings>) => send({ type: 'setting', patch });
    const anim = new Segmented<0 | 1 | 2>('seg-row', (v) => set({ animationSpeed: v }), 'Animation speed');
    anim.setOptions([
      { value: 1, label: '1×' },
      { value: 2, label: '2×' },
      { value: 0, label: 'Instant' },
    ]);
    const ai = new Segmented<Settings['aiSpeed']>('seg-row', (v) => set({ aiSpeed: v }), 'AI speed', 'ai');
    ai.setOptions([
      { value: 'watch', label: 'Watch' },
      { value: 'fast', label: 'Fast' },
      { value: 'instant', label: 'Skip' },
    ]);
    const text = new Segmented<Settings['textSize']>('seg-row', (v) => set({ textSize: v }), 'Text size');
    text.setOptions([
      { value: 'laptop', label: 'Laptop' },
      { value: 'couch', label: 'Couch' },
      { value: 'tv', label: 'TV' },
    ]);
    const vol = new Slider('Sound volume', (v) => set({ sfxVolume: v }));
    const mvol = new Slider('Score volume', (v) => set({ musicVolume: v }));
    const sw: Record<string, Switch> = {
      showLabels: new Switch('Territory names', (v) => set({ showLabels: v }), 'On every tile, not just the one you point at', 'set-labels'),
      showWinChance: new Switch('Show win chance', (v) => set({ showWinChance: v }), 'Otherwise a word: likely, coin flip…'),
      music: new Switch('Ambient score', (v) => set({ music: v }), 'A soft score under the game', 'set-music'),
      muted: new Switch('Mute all sound', (v) => set({ muted: v })),
      ambient: new Switch('Drifting board', (v) => set({ ambient: v }), 'Mist and ink move slowly while nobody plays', 'set-ambient'),
      autoCamera: new Switch('Return camera home each turn', (v) => set({ autoCamera: v }), 'Only if you moved it'),
      reduceMotion: new Switch('Reduce motion', (v) => set({ reduceMotion: v })),
    };
    this.s = { anim, ai, text, vol, mvol, sw };
    const field = (label: string, ctl: HTMLElement, detail?: string | HTMLElement) => {
      const f = h('div', 'field');
      const l = h('div', 'field-label');
      l.append(h('span', '', label));
      if (typeof detail === 'string') l.append(h('span', 'field-detail', detail));
      else if (detail) l.append(detail);
      f.append(l, ctl);
      return f;
    };
    this.fitNote = h('span', 'field-detail hidden', 'fitted to this screen');
    // v5.1 E3: the four things people change, then 'More' (the same fold as New game) for the rest.
    const primary = h('div', 'settings-primary');
    primary.dataset.testid = 'settings-primary';
    primary.append(field('Sound volume', vol.el), field('Score volume', mvol.el), field('AI speed', ai.el, 'How AI turns play'), field('Text size', text.el, this.fitNote));
    this.moreBtn = moreWord('settings-more', () => this.setMore(!this.moreOpen));
    this.more = h('div', 'settings-more-body fold hidden');
    this.more.dataset.testid = 'settings-more-body';
    const cols = h('div', 'settings-cols');
    const c1 = h('div', 'settings-col');
    c1.append(field('Animation speed', anim.el, 'Your own turns'));
    // Seats: hand a seat to the AI when a friend leaves (and back). Filled in update().
    this.seats = h('div', 'menu-seats hidden');
    c1.append(this.seats);
    const c2 = h('div', 'settings-col');
    c2.append(sw.music.el, sw.muted.el, sw.showLabels.el, sw.showWinChance.el, sw.autoCamera.el, sw.ambient.el, sw.reduceMotion.el);
    cols.append(c1, c2);
    this.more.append(cols);
    this.settings.append(sh, primary, this.moreBtn, this.more);

    // Log
    this.log = new LogSheet(() => send({ type: 'overlay', overlay: this.backTarget() }));

    this.el.append(this.pause, this.rules, this.settings, this.log.el);
    // Phones: pull any sheet down by its handle / header to close it (back to the board).
    const close = () => {
      this.dragged = true;
      send({ type: 'overlay', overlay: null });
    };
    for (const [sheet, head] of [
      [this.pause, ph],
      [this.rules, rh],
      [this.settings, sh],
      [this.log.el, this.log.head],
    ] as const)
      dragToDismiss(sheet, [sheet.querySelector<HTMLElement>('.grab')!, head], { scrim: () => this.el, onDismiss: close });
  }

  /** v5.1 E3: fold the rest of Settings open / shut (local: it closes again each time Settings opens). */
  setMore(on: boolean): void {
    if (on === this.moreOpen) return;
    this.moreOpen = on;
    setMoreWord(this.moreBtn, on);
    toggle(this.more, 'hidden', !on);
    if (on) animateIn(this.more, { ms: 200, dy: -6 });
  }

  /** The last close was a drag: the sheet has already slid off, so hide at once. */
  private dragged = false;
  /** A phone sheet sliding out after its overlay closed (the scrim stays up until it's gone). */
  private leaving: HTMLElement | null = null;

  /** The chosen text size was fitted down to this screen (src/ui/uiScale.ts). */
  setFitted(on: boolean): void {
    toggle(this.fitNote, 'hidden', !on);
  }

  /** Where Close / Esc goes from a sheet: back to the menu only if it was opened from there. */
  backTarget(): 'pause' | null {
    return this.screen === 'game' && this.fromPause ? 'pause' : null;
  }
  private fromPause = false;

  update(vm: ViewModel): void {
    this.screen = vm.screen;
    const o = vm.overlay;
    if (o !== this.current && o !== null && o !== 'pause') this.fromPause = this.current === 'pause' || (this.fromPause && this.current !== null);
    const sheets = { pause: this.pause, rules: this.rules, settings: this.settings, log: this.log.el };
    const phone = isPhone();
    // A closing sheet leaves before the scrim goes: phones slide it down, desktop lifts it back off the
    // top edge (a drag already slid it off).
    if (!o && this.current && !this.dragged && !this.leaving) {
      const out = sheets[this.current as keyof typeof sheets];
      this.leaving = out;
      // While it leaves, taps go through to the board and HUD underneath.
      this.el.classList.add('leaving');
      const finish = () => {
        if (this.leaving !== out) return;
        this.leaving = null;
        this.el.classList.remove('leaving');
        resetSheet(out);
        if (!this.current) {
          this.el.classList.add('hidden');
          this.el.style.opacity = '';
          toggle(out, 'hidden', true);
        }
      };
      if (phone) sheetOut(out, this.el, finish);
      else sheetLift(out, this.el, finish);
    } else if (o && this.leaving) {
      this.el.classList.remove('leaving');
      this.leaving.getAnimations().forEach((a) => a.cancel());
      this.el.getAnimations().forEach((a) => a.cancel());
      this.el.style.opacity = '';
      resetSheet(this.leaving);
      this.leaving = null;
    }
    this.dragged = false;
    if (!this.leaving) toggle(this.el, 'hidden', !o);
    toggle(this.el, 'over-menu', vm.screen !== 'game');
    // The ledger is ink on the paper: the board dims behind it, it never frosts (v3 review).
    toggle(this.el, 'is-ledger', o === 'log');
    for (const [k, el] of Object.entries(sheets)) {
      if (el === this.leaving) {
        setAttr(el, 'data-testid', null);
        continue;
      }
      toggle(el, 'hidden', o !== k);
      setAttr(el, 'data-testid', o === k ? k : null);
    }
    if (o !== this.current) {
      const prev = this.current;
      this.current = o;
      const sheet = o ? sheets[o] : null;
      if (o === 'settings') this.setMore(false);
      if (sheet) {
        if (phone) {
          // The first sheet rises from the bottom edge; moving between sheets swaps in place.
          if (!prev) sheetIn(sheet, this.el);
          else {
            resetSheet(sheet);
            animateIn(sheet, { ms: 200 });
          }
        } else {
          // A sheet of paper laid on the board from the top edge (v4 E8); moving between sheets lays
          // the next one down over the board the same way.
          sheetDrop(sheet, prev ? null : this.el);
          const t = sheet.querySelector<HTMLElement>('.sheet-title');
          if (t) drawIn(t, 300, motion.reduced ? 0 : 200);
        }
      }
    }
    if (o === 'settings') {
      const st = vm.settings;
      this.s.anim.set(st.animationSpeed);
      this.s.ai.set(st.aiSpeed);
      this.s.text.set(st.textSize);
      this.s.vol.set(st.sfxVolume);
      this.s.mvol.set(st.musicVolume ?? 0.7);
      for (const k of Object.keys(this.s.sw)) this.s.sw[k].set(k === 'ambient' ? st.ambient !== false : !!st[k as keyof Settings]);
      this.renderSeats(vm.game?.seatActions ?? []);
    }
    if (o === 'rules') this.renderHouse(vm.rulesNotes);
    if (o === 'log') this.log.update(vm.game?.log ?? []);
  }

  private renderSeats(actions: GameVM['seatActions']): void {
    const key = actions.map((a) => `${a.seat.id}:${a.seat.color}:${a.label}`).join('|');
    if (key === this.seatsKey) return;
    this.seatsKey = key;
    this.seats.textContent = '';
    toggle(this.seats, 'hidden', actions.length === 0);
    if (!actions.length) return;
    this.seats.append(h('div', 'field-label', 'Seats'));
    for (const a of actions) {
      const b = uiButton(a.label, 'menu-item quiet seat-item', () => this.send(a.intent), undefined, `seat-action-${a.seat.id}`);
      setStyle(b, '--seat-light', PLAYER_COLORS[a.seat.color].light);
      b.prepend(emblem(a.seat.color));
      this.seats.append(b);
    }
  }

  private renderHouse(lines: string[]): void {
    this.rulesHouse.textContent = '';
    this.rulesHouse.append(h('h2', 'rule-title', 'This game'));
    for (const l of lines) this.rulesHouse.append(h('p', 'num', minus(l)));
  }
}
