// The fight in the one line (fight text, John 2026-10-05: "words live on the rule, pieces live on the board").
// While a fight is armed or rolling (StripVM.fight, until the ring dries) the line slot reads
// 'Lusitania 5 → Tarraconensis 3 · 64% · likely', each name in its seat's light pigment and the counts in ivory.
// While it rolls the odds go and the two counts tick down per pair as the verdicts land (a drop of more than
// one at once steps down 70 ms apart, each with its small pop, so the losses read one die at a time); on a
// conquest it reads 'Tarraconensis captured' for its last second. It writes in (the brush) once the strip's
// own sentence has dried, and dries out (300 ms) as the ring does. Nothing floats on the dice ring any more:
// the ring carries dice only.
// It keeps the old header's hooks for tests: data-testid 'battle', '.bt-side' / '.bt-armies', and
// 'battle-captured'.

import type { BattleSideVM, StripVM } from '../../game/viewModel';
import { PLAYER_COLORS } from '../../shared/palette';
import { drawIn, EASE_IN_QUAD, h, motion, pop, setStyle, setText, toggle } from '../dom';

type FightVM = NonNullable<StripVM['fight']>;

/** The strip's sentence dries in 160 ms: the fight writes in just after. */
const ENTER_DELAY_MS = 150;
const DRY_MS = 300;

class Side {
  readonly el: HTMLSpanElement;
  private terr: HTMLSpanElement;
  private armies: HTMLSpanElement;
  private last = -1;
  /** The number on screen while a multi-step drop ticks down, and its timer. */
  private shown = -1;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(cls: string) {
    this.el = h('span', `bt-side ${cls}`);
    this.terr = h('span', 'bt-terr');
    this.armies = h('span', 'bt-armies num');
    this.el.append(this.terr, ' ', this.armies);
  }
  update(s: BattleSideVM): void {
    setStyle(this.el, '--seat-light', PLAYER_COLORS[s.seat.color].light);
    setText(this.terr, s.territory);
    if (s.armies !== this.last) {
      const from = this.shown >= 0 ? this.shown : this.last;
      this.last = s.armies;
      if (from >= 0 && from - s.armies > 1 && !motion.reduced) this.tickDown();
      else {
        this.stop();
        if (from >= 0) pop(this.armies, 1.2, 160);
        this.show(s.armies);
      }
    }
  }
  private show(n: number): void {
    this.shown = n;
    setText(this.armies, String(n));
  }
  private stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  /** One step toward the latest count, then the next 70 ms later. */
  private tickDown(): void {
    if (this.timer) return;
    const step = () => {
      this.timer = null;
      if (this.shown <= this.last) return;
      this.show(this.shown - 1);
      pop(this.armies, 1.2, 140);
      if (this.shown > this.last) this.timer = setTimeout(step, 70);
    };
    step();
  }
  reset(): void {
    this.stop();
    this.last = -1;
    this.shown = -1;
  }
}

export class FightWords {
  readonly el: HTMLDivElement;
  private att = new Side('bt-att');
  private def = new Side('bt-def');
  private arrow: HTMLSpanElement;
  private odds: HTMLSpanElement;
  private captured: HTMLSpanElement;
  private vm: FightVM | null = null;
  private on = false;
  private out: Animation | null = null;
  /** The fight owns the line slot (true at once) / gave it back (false once it has dried). */
  onSlot: ((on: boolean) => void) | null = null;

  constructor() {
    this.el = h('div', 'st-fight hidden');
    this.el.dataset.testid = 'battle';
    this.el.setAttribute('aria-label', 'Battle');
    this.arrow = h('span', 'bt-vs', '→');
    this.odds = h('span', 'bt-odds');
    this.captured = h('span', 'bt-captured hidden');
    this.captured.dataset.testid = 'battle-captured';
    this.el.append(this.att.el, ' ', this.arrow, ' ', this.def.el, this.odds, this.captured);
  }

  /** Something is in the slot (the fight, or the fight drying). */
  get busy(): boolean {
    return this.on || this.out?.playState === 'running';
  }

  update(vm: FightVM | null): void {
    if (vm === this.vm) return;
    this.vm = vm;
    if (!vm) {
      if (!this.on) return;
      this.on = false;
      const done = () => {
        if (this.on) return;
        this.el.classList.add('hidden');
        this.att.reset();
        this.def.reset();
        this.onSlot?.(false);
      };
      if (motion.reduced || typeof this.el.animate !== 'function') return done();
      const a = (this.out = this.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: DRY_MS, easing: EASE_IN_QUAD, fill: 'forwards' }));
      a.onfinish = () => {
        a.cancel();
        if (this.out === a) this.out = null;
        done();
      };
      return;
    }
    if (!this.on) {
      this.on = true;
      this.out?.cancel();
      this.out = null;
      this.el.getAnimations().forEach((a) => a.cancel());
      this.el.classList.remove('hidden');
      this.onSlot?.(true);
      if (!motion.reduced) drawIn(this.el, 220, ENTER_DELAY_MS);
    }
    this.att.update(vm.attacker);
    this.def.update(vm.defender);
    setText(this.odds, vm.odds ? ` · ${vm.odds}` : '');
    toggle(this.odds, 'hidden', !vm.odds);
    const cap = vm.captured;
    const was = !this.captured.classList.contains('hidden');
    for (const el of [this.att.el, this.arrow, this.def.el, this.odds]) toggle(el, 'hidden', !!cap || (el === this.odds && !vm.odds));
    toggle(this.captured, 'hidden', !cap);
    if (cap) {
      setStyle(this.captured, '--seat-light', PLAYER_COLORS[vm.attacker.seat.color].light);
      setText(this.captured, cap);
      if (!was && !motion.reduced) drawIn(this.captured, 220);
    }
  }
}
