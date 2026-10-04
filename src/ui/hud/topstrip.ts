// Top of the board (docs/INK.md B5 "In-game HUD"): the seats as ink rings on the paper, in turn order,
// the territory count inside each ring and the name beside it; the game's ensō at the top right is the
// menu, with the words `Reset view` beside it only while the camera is off home.
//   (11) John   (9) Sam   (8) Ochre   ( ) Sage                                   Reset view   (ensō)
// The current seat's ring is inked at full strength and its name underlined in a hairline; the others
// stay quieter. Losing a territory dims your ring for 300 ms (A5). An eliminated seat's ring dries out
// over a breath (v3 "the exhale"), is empty and faintly cracked, and says who did it.
// v3 (_claude/v3/PLAN.md §2–3, John 2026-09-30 "fuller, not busier"): under each ring, one short brush tick
// per continent the seat holds, in that continent's printed tint (the colour its name is printed in on the
// board), and the seat's card count. The ring keeps one numeral, territories: the win condition counts them;
// the army read is the board's stack heights (the seat's total is in its label for screen readers).
// v3 AI (quietly): an AI seat's personality under its name only when the controller sends it (v5.1: hidden
// until revealed), and, when it holds a grudge of 2 or more, one short slanted brush tick under its ring in
// the grudged seat's colour ('Holds a grudge against Sam'). The 2-player neutral seat is a dimmed ring
// with its count and no name underline.
// v5 C (grudges that last): under each ring, beside the held-continent ticks, one hairline tick in that seat's
// pigment per territory it has taken from you (SeatChipVM.grudgeTicks; 8 drawn at most, then '+'); taking one
// back dries a tick out. v5 D: an AI's last voice line ('Sage remembers that') sits faint and italic under its
// name for one turn, in place of the personality word. v5 F: hovering a ring (a mouse) sends 'hoverSeat'
// (the board lifts that seat's land).
// v5.1 (QUIETER §3 A–C, "decide, don't ask"; "no objects as UI"): whose turn is the current seat's ring FILLED
// in its pigment with the count in ivory on it, the largest mark in the strip, and its name in pigment. No cup.
// Beside each AI's ring, one small ink mark for its standing toward you: a hollow hairline dot (ally), half
// filled (even), filled in the seat's base (wary), filled in its deep tone and a touch larger (hostile).
// Hover / long-press sends 'seatStanding' (the controller writes the reason in the one line); a tap on a ring
// that can be asked for peace offers 'Ask Sage for peace' in the one line (index.ts / strip.ts). An AI-to-AI
// understanding is a brush hairline tied between the two rings, in their light tints, while it holds.

import type { SeatChipVM, UiIntent } from '../../game/viewModel';
import type { PlayerId } from '../../engine/types';
import { PLAYER_COLORS, continentInk } from '../../shared/palette';
import { CONTINENT_IDS, CONTINENTS } from '../../engine/mapData';
import { brushMark } from '../../shared/enso';
import { drawIn, EASE_IN_QUAD, emblem, ensoEl, h, hashSeed, minus, motion, pop, setEmblem, setEnso, setStyle, setText, svg, toggle } from '../dom';

/** The standing as a word, for screen readers (the reason itself is the controller's, in the one line). */
const STANDING_WORD = { ally: 'an ally', even: 'even', wary: 'wary', hostile: 'hostile' } as const;

/**
 * A painted blot: a closed path round (cx, cy) at radius r whose edge wanders a little (a brush, not a
 * compass). Deterministic per seed. `wobble` is the edge's wander as a fraction of r.
 */
export function blotPath(seed: number, cx: number, cy: number, r: number, wobble = 0.045): string {
  let s = seed >>> 0 || 1;
  const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9) >>> 0) / 4294967296);
  const a1 = rnd() * Math.PI * 2;
  const a2 = rnd() * Math.PI * 2;
  const n = 28;
  const pts: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const k = 1 + wobble * (Math.sin(t * 2 + a1) * 0.6 + Math.sin(t * 3 + a2) * 0.4);
    pts.push(`${(cx + Math.cos(t) * r * k).toFixed(2)} ${(cy + Math.sin(t) * r * k).toFixed(2)}`);
  }
  return `M${pts.join(' L')} Z`;
}

/** Grudge ticks drawn at most; more reads as 8 and a '+'. */
const GRUDGE_MAX = 8;

/**
 * The grudge ticks under a seat ring (v5 C): one hairline per territory this seat has taken from you, in its
 * own pigment. Patched in place, so a tick that goes dries out (tier 0) rather than the row redrawing.
 */
class GrudgeTicks {
  readonly el: HTMLSpanElement;
  private n = 0;
  private more: HTMLSpanElement;

  constructor() {
    this.el = h('span', 'sc-grudges hidden');
    this.el.dataset.testid = 'grudge-ticks';
    this.more = h('span', 'gt-more num', '+');
    this.more.setAttribute('aria-hidden', 'true');
  }

  private tick(i: number): HTMLElement {
    const t = h('i', 'gt-tick');
    // a hairline, each leaning a hair differently (a hand, not a ruler)
    const lean = ((i * 37) % 7) / 10 - 0.3;
    t.innerHTML = `<svg viewBox="0 0 4 12" aria-hidden="true"><path d="M${(2 + lean).toFixed(2)} 0.8 L${(2 - lean).toFixed(2)} 11.2" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" fill="none"/></svg>`;
    return t;
  }

  update(count: number, name: string, animate: boolean): void {
    count = Math.max(0, Math.floor(count));
    const shown = Math.min(GRUDGE_MAX, count);
    const live = [...this.el.querySelectorAll<HTMLElement>('.gt-tick:not(.drying)')];
    if (shown > live.length) {
      for (let i = live.length; i < shown; i++) {
        const t = this.tick(i);
        this.el.insertBefore(t, this.more.parentNode === this.el ? this.more : null);
        if (animate && !motion.reduced && typeof t.animate === 'function')
          t.animate([{ transform: 'scaleY(0.2)', opacity: 0 }, { transform: 'scaleY(1)', opacity: 1 }], { duration: 220, easing: 'cubic-bezier(0.2, 0.9, 0.2, 1)' });
      }
    } else if (shown < live.length) {
      // the newest ticks dry out first
      for (const t of live.slice(shown)) {
        if (!animate || motion.reduced || typeof t.animate !== 'function') {
          t.remove();
          continue;
        }
        t.classList.add('drying');
        const a = t.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, easing: EASE_IN_QUAD, fill: 'forwards' });
        a.onfinish = () => t.remove();
      }
    }
    if (count > GRUDGE_MAX) this.el.append(this.more);
    else this.more.remove();
    this.n = count;
    toggle(this.el, 'hidden', count === 0 && !this.el.querySelector('.gt-tick'));
    this.el.title = count ? `${name} has taken ${count} ${count === 1 ? 'territory' : 'territories'} from you` : '';
  }

  get count(): number {
    return this.n;
  }
}

class Chip {
  readonly el: HTMLDivElement;
  private pers: HTMLSpanElement;
  private ring: HTMLSpanElement;
  private mark: SVGSVGElement;
  private disc: SVGSVGElement;
  private discKey = '';
  private stand: SVGSVGElement;
  private standKey = '';
  /** The last press was a long-press: the click it ends in is not a tap. */
  private longPressed = false;
  /** v5.1 C: a tap on a ring whose seat can be asked for peace (TopStrip wires it to index.ts). */
  onAsk: ((vm: SeatChipVM) => void) | null = null;
  private emb: SVGSVGElement;
  private name: HTMLSpanElement;
  private terr: HTMLSpanElement;
  private by: HTMLSpanElement;
  private marks: HTMLSpanElement;
  private marksKey = '';
  private vm: SeatChipVM | null = null;
  private grudges: GrudgeTicks;
  private voice: HTMLSpanElement;
  /** The voice line on show, and how many turn changes it has seen (it stays for one turn). */
  private voiceText = '';
  private voiceAt = 0;
  /** TopStrip's count of turn changes (the current seat moving on). */
  turn = 0;

  constructor(send: (i: UiIntent) => void) {
    this.el = h('div', 'seat-chip');
    this.grudges = new GrudgeTicks();
    // v5 F7: a mouse over the ring lifts that seat's land on the board (never on touch: no hover there).
    // v5.1 C: over an AI's ring it also asks for its standing's reason (the controller writes it in the line).
    let standingShown = false;
    this.el.addEventListener('pointerenter', (e) => {
      if (e.pointerType !== 'mouse' || !this.vm) return;
      send({ type: 'hoverSeat', player: this.vm.seat.id });
      if (this.vm.standing) {
        standingShown = true;
        send({ type: 'seatStanding', player: this.vm.seat.id });
      }
    });
    this.el.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'mouse') return;
      send({ type: 'hoverSeat', player: null });
      if (standingShown) send({ type: 'seatStanding', player: null });
      standingShown = false;
    });
    // A long-press (touch) or a 600 ms press (mouse): on an AI seat with a standing, its reason (v5.1 C); on
    // anyone else the secret mission (v5 G; the controller shows it only on that seat's live turn).
    // Releasing puts it away.
    let pressT = 0;
    let pressed: 'mission' | 'standing' | null = null;
    this.el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.vm) return;
      const player = this.vm.seat.id;
      const standing = !!this.vm.standing;
      window.clearTimeout(pressT);
      pressT = window.setTimeout(() => {
        // A mouse already has the reason from hover.
        if (standing && e.pointerType === 'mouse') return;
        pressed = standing ? 'standing' : 'mission';
        this.longPressed = true;
        send(standing ? { type: 'seatStanding', player } : { type: 'seatMission', player });
      }, 600);
    });
    const release = (e: PointerEvent) => {
      window.clearTimeout(pressT);
      if (pressed === 'mission') send({ type: 'seatMission', player: null });
      else if (pressed === 'standing' && e.pointerType !== 'mouse') send({ type: 'seatStanding', player: null });
      pressed = null;
    };
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave'] as const) this.el.addEventListener(ev, release);
    // v5.1 C: a tap on a ring that can be asked for peace offers 'Ask Sage for peace' in the one line.
    this.el.addEventListener('click', () => {
      const vm = this.vm;
      const held = this.longPressed;
      this.longPressed = false;
      if (vm?.canAskPeace && !held) this.onAsk?.(vm);
    });
    this.el.addEventListener('keydown', (e) => {
      const vm = this.vm;
      if (!vm?.canAskPeace || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      e.stopPropagation();
      this.onAsk?.(vm);
    });
    this.ring = h('span', 'sc-ring');
    // v5.1: the current seat's ring is filled in its pigment (a painted disc under the ensō); the others are rings.
    this.disc = svg('svg', { viewBox: '0 0 48 48', class: 'sc-disc', 'aria-hidden': 'true' });
    this.mark = ensoEl(1, 'sc-enso', { small: true });
    this.terr = h('span', 'sc-terr num');
    this.ring.append(this.disc, this.mark, this.terr, h('i', 'sc-crack'));
    // v5.1 C: the standing mark, beside the ring (AI seats only).
    this.stand = svg('svg', { viewBox: '0 0 12 12', class: 'sc-stand hidden', 'aria-hidden': 'true' });
    this.marks = h('span', 'sc-marks');
    const col = h('span', 'sc-col');
    col.append(this.ring, this.stand, this.marks);
    const text = h('span', 'sc-text');
    this.emb = emblem('crimson', 'emb sc-emb');
    this.name = h('span', 'sc-name');
    this.by = h('span', 'sc-by hidden');
    this.pers = h('span', 'sc-pers hidden');
    this.voice = h('span', 'sc-voice hidden');
    const nm = h('span', 'sc-nameline');
    nm.append(this.emb, this.name);
    text.append(nm, this.by, this.pers, this.voice);
    this.el.append(col, text);
  }

  private seenTurn = 0;

  update(vm: SeatChipVM): void {
    if (this.vm === vm && this.seenTurn === this.turn) return;
    this.seenTurn = this.turn;
    const prev = this.vm;
    this.vm = vm;
    const pal = PLAYER_COLORS[vm.seat.color];
    setStyle(this.el, '--seat', pal.base);
    setStyle(this.el, '--seat-light', pal.light);
    setEnso(this.mark, hashSeed(`${vm.seat.id}:${vm.seat.color}`), { small: true });
    setEmblem(this.emb, vm.seat.color, 'light');
    setText(this.name, vm.seat.name);
    setText(this.terr, vm.eliminated ? '' : String(vm.territories));
    toggle(this.el, 'current', vm.current && !vm.neutral);
    toggle(this.el, 'out', vm.eliminated);
    toggle(this.el, 'neutral', !!vm.neutral);
    const pers = !vm.eliminated && vm.personality ? vm.personality : null;
    // v5 D: the last voice line, for one turn, in place of the personality word.
    const voice = this.voiceFor(vm);
    toggle(this.voice, 'hidden', !voice);
    if (voice && voice !== this.voice.textContent) {
      setText(this.voice, voice);
      this.voice.title = voice;
      if (prev) drawIn(this.voice, 320);
    }
    toggle(this.pers, 'hidden', !pers || !!voice);
    setText(this.pers, pers?.name ?? '');
    // Phones hide the word: the ring's title carries it (hover / long-press).
    this.el.title = pers ? `${pers.name} · ${pers.line}` : '';
    this.el.dataset.personality = pers?.name.toLowerCase() ?? '';
    // v5.1 C: a ring that can be asked for peace is a button (a tap offers 'Ask Sage for peace').
    const ask = !!vm.canAskPeace && !vm.eliminated;
    toggle(this.el, 'can-ask', ask);
    if (ask) {
      this.el.setAttribute('role', 'button');
      this.el.tabIndex = 0;
    } else if (this.el.getAttribute('role')) {
      this.el.removeAttribute('role');
      this.el.removeAttribute('tabindex');
    }
    this.updateDisc(vm);
    this.updateStanding(vm);
    const out = vm.eliminated ? vm.out : null;
    toggle(this.by, 'hidden', !out);
    if (out) setText(this.by, `taken by ${out.by.name}`);
    this.el.dataset.testid = `seat-${vm.seat.id}`;
    this.voice.dataset.testid = `seat-voice-${vm.seat.id}`;
    this.grudges.el.dataset.seat = String(vm.seat.id);
    this.updateMarks(vm);
    const held = (vm.continents ?? []).map((c) => CONTINENTS[c].name);
    const gt = vm.eliminated ? 0 : (vm.grudgeTicks ?? 0);
    const standing = !vm.eliminated && vm.standing ? `, ${STANDING_WORD[vm.standing]} toward you` : '';
    this.el.setAttribute(
      'aria-label',
      vm.eliminated
        ? `${vm.seat.name}, out${out ? `, taken by ${out.by.name}` : ''}`
        : `${vm.seat.name}${pers ? `, ${pers.name}` : ''}: ${vm.territories} territories${vm.armies !== undefined ? `, ${vm.armies} armies` : ''}${held.length ? `, holds ${held.join(' and ')}` : ''}${vm.cards ? `, ${vm.cards} ${vm.cards === 1 ? 'card' : 'cards'}` : ''}${vm.grudge ? `, holds a grudge against ${vm.grudge.name}` : ''}${gt ? `, has taken ${gt} of yours` : ''}${standing}${ask ? '; tap to ask for peace' : ''}`,
    );
    if (!prev) return;
    // Turn start (INK B4 "seat ring inks"): the ring is brushed in fresh ivory ink and dries into its wash
    // (~900 ms, with the breath line). Ivory, not gold: one gold on screen at a time (INK A9), and the
    // track / commit already holds it.
    if (vm.current && !prev.current) {
      drawIn(this.ring, 300);
      if (!motion.reduced && typeof this.mark.animate === 'function')
        this.mark.animate([{ color: '#f2ede2' }, { color: '#f2ede2', offset: 0.3 }, { color: pal.base }], { duration: 900, easing: 'cubic-bezier(0.11, 0, 0.5, 0)' });
    }
    if (prev.territories !== vm.territories && !vm.eliminated) pop(this.terr);
    // A5: your colour is eaten — the ring dims for 300 ms each time a territory goes.
    if ((vm.lostKey ?? 0) !== (prev.lostKey ?? 0) && !motion.reduced && typeof this.ring.animate === 'function')
      this.ring.animate([{ opacity: 1 }, { opacity: 0.3, offset: 0.35 }, { opacity: 1 }], { duration: 300, easing: 'ease-out' });
    // The exhale (PLAN §3): the knocked-out seat's ring dries out over a breath (~1.2 s) and stays dry.
    if (vm.eliminated && !prev.eliminated && typeof this.ring.animate === 'function')
      this.ring.animate([{ opacity: 1, filter: 'saturate(1)' }, { opacity: 0.4, filter: 'saturate(0.2)' }], { duration: motion.reduced ? 150 : 1200, easing: 'cubic-bezier(0.3, 0, 0.4, 1)' });
  }

  /**
   * The voice line to show: a new line shows at once and stays for one turn: the rest of the turn it was
   * said in and the whole of the next seat's (it goes when the turn passes twice). The controller clearing
   * it hides it sooner.
   */
  private voiceFor(vm: SeatChipVM): string {
    const line = !vm.eliminated && vm.voiceLine ? minus(vm.voiceLine) : '';
    if (!line) {
      this.voiceText = '';
      return '';
    }
    if (line !== this.voiceText) {
      this.voiceText = line;
      this.voiceAt = this.turn;
    }
    return this.turn - this.voiceAt >= 2 ? '' : line;
  }

  /** Under the ring: an AI's grudge tick, your grudge ticks, a tick per held continent (in its printed tint), then the card count. */
  private updateMarks(vm: SeatChipVM): void {
    const conts = vm.eliminated ? [] : (vm.continents ?? []);
    const cards = vm.eliminated ? 0 : (vm.cards ?? 0);
    const grudge = vm.eliminated ? null : (vm.grudge ?? null);
    const ticks = vm.eliminated ? 0 : (vm.grudgeTicks ?? 0);
    // Patched in place (a tick that goes dries out), so outside the rebuild below.
    this.grudges.update(ticks, vm.seat.name, this.marksKey !== '');
    const key = `${conts.join(',')}|${cards}|${grudge ? `${grudge.id}:${grudge.color}:${grudge.name}` : ''}|${ticks > 0 || this.grudges.el.childElementCount > 0}`;
    if (key === this.marksKey) {
      toggle(this.marks, 'empty', !this.marks.querySelector(':scope > :not(.hidden)'));
      return;
    }
    this.marksKey = key;
    this.marks.textContent = '';
    if (grudge) {
      // one short brush tick, slanted (a continent's tick stands upright), in the grudged seat's colour
      const g = h('span', 'sc-tick sc-grudge');
      g.dataset.testid = `seat-grudge-${vm.seat.id}`;
      g.dataset.against = String(grudge.id);
      g.title = `Holds a grudge against ${grudge.name}`;
      g.style.color = PLAYER_COLORS[grudge.color].light;
      g.innerHTML = `<svg viewBox="0 0 6 12" aria-hidden="true"><path d="${brushMark([[4.6, 1.2], [1.5, 10.8]], { seed: 71 + grudge.id * 5, width: 2.8 })}" fill="currentColor"/></svg>`;
      this.marks.append(g);
    }
    setStyle(this.grudges.el, 'color', PLAYER_COLORS[vm.seat.color].light);
    this.marks.append(this.grudges.el);
    for (const c of conts) {
      const i = CONTINENT_IDS.indexOf(c);
      const t = h('span', 'sc-tick');
      t.dataset.continent = c;
      t.title = `Holds ${CONTINENTS[c].name}`;
      t.style.color = continentInk(i, 0.4);
      t.innerHTML = `<svg viewBox="0 0 6 12" aria-hidden="true"><path d="${brushMark([[3.3, 0.9], [2.7, 11.1]], { seed: 31 + i * 7, width: 3 })}" fill="currentColor"/></svg>`;
      this.marks.append(t);
    }
    if (cards > 0) {
      const k = h('span', 'sc-cards num');
      k.dataset.testid = `seat-cards-${vm.seat.id}`;
      k.title = `${cards} ${cards === 1 ? 'card' : 'cards'}`;
      // a card in ink (square corners: no rounded rectangles anywhere): its face, a border, a hairline inside
      k.innerHTML = `<svg viewBox="0 0 8 11" aria-hidden="true"><path d="M0.7 0.7 L7.3 0.6 L7.4 10.4 L0.6 10.4 Z" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-width="0.9"/><path d="M2 2 L6 2 L6 9 L2 9 Z" fill="none" stroke="currentColor" stroke-width="0.45" opacity="0.6"/></svg>`;
      k.append(document.createTextNode(String(cards)));
      this.marks.append(k);
    }
    toggle(this.marks, 'empty', !this.marks.querySelector(':scope > :not(.hidden)'));
  }

  /** v5.1 A: the current seat's ring, filled in its pigment (a painted disc, not a flat circle). */
  private updateDisc(vm: SeatChipVM): void {
    const key = `${vm.seat.id}:${vm.seat.color}`;
    if (key === this.discKey) return;
    this.discKey = key;
    this.disc.textContent = '';
    this.disc.append(svg('path', { d: blotPath(hashSeed(`disc:${key}`), 24, 24, 20.5), class: 'sc-disc-fill' }));
  }

  /** The tie anchor (the ring's centre) in the seats row's box. */
  ringCentre(): { x: number; y: number; r: number } {
    const col = this.ring.parentElement as HTMLElement;
    return { x: this.el.offsetLeft + col.offsetLeft + this.ring.offsetLeft + this.ring.offsetWidth / 2, y: this.el.offsetTop + col.offsetTop + this.ring.offsetTop + this.ring.offsetHeight / 2, r: this.ring.offsetWidth / 2 };
  }

  /**
   * v5.1 C: one small ink mark beside an AI's ring for its standing toward you. ally: a hollow hairline dot ·
   * even: half filled · wary: filled in the seat's base · hostile: filled in its deep tone, slightly larger.
   */
  private updateStanding(vm: SeatChipVM): void {
    const st = !vm.eliminated && !vm.neutral ? (vm.standing ?? null) : null;
    toggle(this.stand, 'hidden', !st);
    this.el.dataset.standing = st ?? '';
    const key = `${st}:${vm.seat.id}:${vm.seat.color}`;
    if (key === this.standKey) return;
    const was = this.standKey;
    this.standKey = key;
    this.stand.textContent = '';
    this.stand.setAttribute('class', `sc-stand${st ? ` st-${st}` : ' hidden'}`);
    this.stand.dataset.testid = `seat-standing-${vm.seat.id}`;
    if (!st) return;
    const pal = PLAYER_COLORS[vm.seat.color];
    const seed = hashSeed(`stand:${vm.seat.id}`);
    const r = st === 'hostile' ? 5 : 4.1;
    const dot = blotPath(seed, 6, 6, r, 0.06);
    if (st === 'ally') this.stand.append(svg('path', { d: dot, fill: 'none', stroke: pal.light, 'stroke-width': 0.9 }));
    else if (st === 'even') {
      // the left half filled (a dot half inked), the whole edge a hairline
      const clip = svg('clipPath', { id: `sc-half-${vm.seat.id}` });
      clip.append(svg('rect', { x: 0, y: 0, width: 6, height: 12 }));
      const defs = svg('defs');
      defs.append(clip);
      this.stand.append(defs, svg('path', { d: dot, fill: pal.base, 'clip-path': `url(#sc-half-${vm.seat.id})` }), svg('path', { d: dot, fill: 'none', stroke: pal.light, 'stroke-width': 0.9 }));
    } else if (st === 'wary') this.stand.append(svg('path', { d: dot, fill: pal.base, stroke: pal.light, 'stroke-width': 0.5 }));
    else this.stand.append(svg('path', { d: dot, fill: pal.deep, stroke: pal.base, 'stroke-width': 0.7 }));
    if (was && !motion.reduced) drawIn(this.stand, 320);
  }
}

export class TopStrip {
  readonly el: HTMLElement;
  private seats: HTMLDivElement;
  private chips: Chip[] = [];
  private reset: HTMLButtonElement;
  private menuMark: SVGSVGElement;
  private vm: SeatChipVM[] | null = null;
  private moved = false;
  private curSeat = -1;
  private turn = 0;
  /** v5.1 C: the understanding ties, one hairline per AI pair, drawn over the seats row. */
  private ties: SVGSVGElement;
  private tiesKey = '';
  /** v5.1 C: a ring that can be asked for peace was tapped (index.ts offers it in the one line). */
  onAsk: ((vm: SeatChipVM) => void) | null = null;

  constructor(private send: (i: UiIntent) => void) {
    this.el = h('header', 'topstrip');
    this.el.dataset.testid = 'topstrip';
    this.seats = h('div', 'ts-seats');
    this.seats.setAttribute('aria-label', 'Players');
    const right = h('div', 'ts-right');
    // `Reset view`: the words with a hairline under them (INK2 §3.2), a 44 px hit box; never a pill.
    this.reset = h('button', 'ts-reset nofocus hidden', 'Reset view');
    this.reset.type = 'button';
    this.reset.dataset.testid = 'reset-view';
    this.reset.addEventListener('click', () => send({ type: 'resetView' }));
    const menu = h('button', 'ts-menu nofocus');
    menu.type = 'button';
    menu.dataset.testid = 'menu';
    menu.setAttribute('aria-label', 'Menu');
    this.menuMark = ensoEl(1, 'ts-enso', { small: true });
    menu.append(this.menuMark);
    menu.addEventListener('click', () => send({ type: 'overlay', overlay: 'pause' }));
    right.append(this.reset, menu);
    this.el.append(this.seats, right);
    this.ties = svg('svg', { class: 'ts-ties', 'aria-hidden': 'true' });
    this.seats.append(this.ties);
    new ResizeObserver(() => this.drawTies(true)).observe(this.seats);
  }

  /** The game's ensō (seed = the game's seed) is the menu mark. */
  setSeed(seed: number): void {
    setEnso(this.menuMark, seed, { small: true });
  }

  update(vm: SeatChipVM[]): void {
    if (this.vm === vm) return;
    this.vm = vm;
    while (this.chips.length < vm.length) {
      const c = new Chip(this.send);
      c.onAsk = (chip) => this.onAsk?.(chip);
      this.chips.push(c);
      this.seats.append(c.el);
    }
    while (this.chips.length > vm.length) this.chips.pop()!.el.remove();
    // The turn count the voice lines live by: it moves on whenever the current seat does.
    const cur = vm.findIndex((c) => c.current);
    if (cur >= 0 && cur !== this.curSeat) {
      if (this.curSeat >= 0) this.turn++;
      this.curSeat = cur;
    }
    vm.forEach((c, i) => {
      this.chips[i].turn = this.turn;
      this.chips[i].update(c);
    });
    this.drawTies(false);
  }

  /** The AI pairs holding an understanding, each once ('1-3'), in seat order. */
  private pairs(): [number, number][] {
    const vm = this.vm ?? [];
    const idx = new Map(vm.map((c, i) => [c.seat.id, i]));
    const out: [number, number][] = [];
    const seen = new Set<string>();
    vm.forEach((c, i) => {
      if (c.eliminated) return;
      for (const p of c.understandingWith ?? []) {
        const j = idx.get(p);
        if (j === undefined || j === i || vm[j].eliminated) continue;
        const [a, b] = i < j ? [i, j] : [j, i];
        const k = `${a}-${b}`;
        if (!seen.has(k)) (seen.add(k), out.push([a, b]));
      }
    });
    return out;
  }

  /**
   * v5.1 C: a brush hairline tied between two AI rings while their understanding holds, in the two seats'
   * light tints (a gradient from one to the other), bowing up over the names between them. Patched on
   * layout; a new tie is drawn in, a broken one dries out.
   */
  private drawTies(relayout: boolean): void {
    const vm = this.vm;
    if (!vm) return;
    const pairs = this.pairs();
    const key = pairs.map(([a, b]) => `${a}-${b}:${vm[a].seat.color}:${vm[b].seat.color}`).join('|');
    if (key === this.tiesKey && !relayout) return;
    const was = this.tiesKey;
    this.tiesKey = key;
    this.ties.textContent = '';
    toggle(this.ties, 'hidden', !pairs.length);
    if (!pairs.length) return;
    const W = this.seats.clientWidth;
    const H = this.seats.clientHeight;
    if (!W) return;
    this.ties.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const defs = svg('defs');
    this.ties.append(defs);
    for (const [a, b] of pairs) {
      const ca = this.chips[a]?.ringCentre();
      const cb = this.chips[b]?.ringCentre();
      if (!ca || !cb) continue;
      // from the top of one ring to the top of the other, bowing up a little over whatever lies between
      const x0 = ca.x + ca.r * 0.15;
      const y0 = ca.y - ca.r * 1.02;
      const x1 = cb.x - cb.r * 0.15;
      const y1 = cb.y - cb.r * 1.02;
      const lift = Math.min(14, 6 + (x1 - x0) * 0.025);
      const pts: [number, number][] = [];
      for (let i = 0; i <= 16; i++) {
        const t = i / 16;
        const x = x0 + (x1 - x0) * t;
        const y = y0 + (y1 - y0) * t - Math.sin(t * Math.PI) * lift;
        pts.push([x, y]);
      }
      const id = `ts-tie-${vm[a].seat.id}-${vm[b].seat.id}`;
      const g = svg('linearGradient', { id, gradientUnits: 'userSpaceOnUse', x1: x0, y1: y0, x2: x1, y2: y1 });
      g.append(svg('stop', { offset: '0', 'stop-color': PLAYER_COLORS[vm[a].seat.color].light }), svg('stop', { offset: '1', 'stop-color': PLAYER_COLORS[vm[b].seat.color].light }));
      defs.append(g);
      const path = svg('path', { d: brushMark(pts, { seed: hashSeed(id), width: 1.5, samples: 64, bristles: 2 }), fill: `url(#${id})`, class: 'ts-tie' });
      path.dataset.testid = `tie-${vm[a].seat.id}-${vm[b].seat.id}`;
      this.ties.append(path);
      if (!relayout && !was.includes(`${a}-${b}:`) && !motion.reduced && typeof path.animate === 'function')
        path.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 420, easing: 'cubic-bezier(0.2, 0.9, 0.2, 1)' });
    }
  }

  /** `Reset view` beside the ensō, only while the camera is off home. */
  setViewMoved(on: boolean): void {
    if (on === this.moved) return;
    this.moved = on;
    toggle(this.reset, 'hidden', !on);
    if (on) drawIn(this.reset, 200);
  }
}
