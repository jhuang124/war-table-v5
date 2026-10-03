// The war in ink (v5 C, _claude/v5/PROPOSAL.md §4 C): on victory, before the recap, the board replays the
// game as a time-lapse. The board re-soaks round by round (the controller does it, per 'replayRound'); the
// UI's part is a thin paper strip at the bottom of the screen:
//
//   Round 6        Siberia changed hands three times
//   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━──────────────────────────
//
// the round numeral re-inks, the round's one sentence writes and dries, and a hairline in the one gold
// runs along the strip as the rounds pass. Nothing else is on the screen (the HUD steps aside). Any tap or
// key skips ('skipReplay'); the end of the last round does the same, so the recap follows on its own.
// Reduced motion (or a zero pace): no time-lapse at all, straight to the recap.

import type { ReplayVM, UiIntent } from '../../game/viewModel';
import { PLAYER_COLORS } from '../../shared/palette';
import { drawIn, EASE_IN_QUAD, h, minus, motion, setStyle, setText, toggle } from '../dom';

/** The last round's sentence stays on the paper this long before the recap comes. */
const HOLD_LAST_MS = 1200;

export class Replay {
  readonly el: HTMLDivElement;
  private strip: HTMLDivElement;
  private round: HTMLSpanElement;
  private line: HTMLSpanElement;
  private rule: HTMLElement;
  private vm: ReplayVM | null = null;
  private doneKey = -1;
  private index = -1;
  private timer = 0;
  private dryT = 0;
  /** Called when the replay starts or ends locally (the recap is held back while it plays). */
  onChange: (() => void) | null = null;

  constructor(private send: (i: UiIntent) => void) {
    this.el = h('div', 'replay hidden');
    this.el.dataset.testid = 'replay';
    this.el.setAttribute('role', 'status');
    this.strip = h('div', 'rp-strip');
    this.round = h('span', 'rp-round num');
    this.line = h('span', 'rp-line num');
    this.line.setAttribute('aria-live', 'polite');
    const rule = h('div', 'rp-rule');
    this.rule = h('i', 'rp-fill');
    rule.append(this.rule);
    const words = h('div', 'rp-words');
    words.append(this.round, this.line);
    this.strip.append(words, rule);
    this.el.append(this.strip);
    // Any tap skips (and never reaches the board under it).
    this.el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.skip();
    });
  }

  /** The time-lapse is on the screen (the recap waits for it). */
  get active(): boolean {
    return !!this.vm && this.doneKey !== this.vm.key;
  }

  update(vm: ReplayVM | null | undefined): void {
    vm = vm ?? null;
    if (vm === this.vm) return;
    const was = this.active;
    const fresh = !!vm && vm.key !== this.vm?.key;
    this.vm = vm;
    if (!vm) {
      this.stop(false);
      if (was) this.onChange?.();
      return;
    }
    if (!fresh) return;
    // A new replay. Reduced motion, a zero pace or nothing to show: straight to the recap.
    if (motion.reduced || !(vm.msPerRound > 0) || !vm.rounds.length) {
      this.doneKey = vm.key;
      toggle(this.el, 'hidden', true);
      this.send({ type: 'skipReplay' });
      if (was) this.onChange?.();
      return;
    }
    setStyle(this.el, '--rp-seat', PLAYER_COLORS[vm.winner.color].light);
    toggle(this.el, 'hidden', false);
    this.el.getAnimations().forEach((a) => a.cancel());
    this.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, easing: 'ease-out' });
    this.index = -1;
    this.rule.getAnimations().forEach((a) => a.cancel());
    this.rule.style.transform = 'scaleX(0)';
    this.advance();
    if (!was) this.onChange?.();
  }

  /** Any tap / key: the replay ends here and the recap comes. */
  skip(): void {
    if (!this.active) return;
    this.send({ type: 'skipReplay' });
    this.stop(true);
    this.onChange?.();
  }

  private advance(): void {
    const vm = this.vm!;
    this.index++;
    const i = this.index;
    if (i >= vm.rounds.length) {
      // The last sentence has had its moment: the recap.
      this.skip();
      return;
    }
    const r = vm.rounds[i];
    this.send({ type: 'replayRound', index: i });
    const ms = vm.msPerRound;
    const last = i === vm.rounds.length - 1;
    // The round numeral re-inks; the sentence writes, then dries before the next one.
    setText(this.round, `Round ${r.round}`);
    drawIn(this.round, Math.min(280, ms * 0.3));
    this.line.getAnimations().forEach((a) => a.cancel());
    setText(this.line, minus(r.line));
    drawIn(this.line, Math.min(520, ms * 0.45));
    window.clearTimeout(this.dryT);
    if (!last && ms > 500) {
      this.dryT = window.setTimeout(() => {
        this.line.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: EASE_IN_QUAD, fill: 'forwards' });
      }, ms - 220);
    }
    // The gold hairline runs to this round's end over the round.
    const k = (i + 1) / vm.rounds.length;
    const from = i / vm.rounds.length;
    this.rule.animate([{ transform: `scaleX(${from})` }, { transform: `scaleX(${k})` }], { duration: ms, easing: 'linear', fill: 'forwards' });
    this.timer = window.setTimeout(() => this.advance(), last ? Math.max(ms, HOLD_LAST_MS) : ms);
  }

  private stop(dry: boolean): void {
    window.clearTimeout(this.timer);
    window.clearTimeout(this.dryT);
    if (this.vm) this.doneKey = this.vm.key;
    if (this.el.classList.contains('hidden')) return;
    const hide = () => {
      if (!this.active) toggle(this.el, 'hidden', true);
    };
    if (!dry || motion.reduced) return hide();
    // The strip dries off the paper.
    const a = this.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 240, easing: EASE_IN_QUAD, fill: 'forwards' });
    a.onfinish = () => {
      hide();
      a.cancel();
    };
  }
}
