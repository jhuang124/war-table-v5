// Title (docs/INK.md B5, INK2 §3.4): the painting, flat, and on it "War Table" in serif small caps with
// the ensō drawing itself beneath on the gold rule (~900 ms). Three lines: New game · Continue · How to
// play, and one quiet Settings word (text size lives in Settings). One gold: Continue when a save
// exists, else New game — the word inside a gold brush ring (Continue's save summary under the word,
// inside the same ring); the rest are bare words.

// v4 §7.13: the Continue word carries a small ink thumbnail of the board as it was left (territory tints
// only, 120 × 60), beside it on the paper, outside its ring.

import type { SaveSketchVM, UiIntent, ViewModel } from '../../game/viewModel';
import type { PlayerColorId, TerritoryId } from '../../engine/types';
import { getBoard } from '../../map';
import { PLAYER_COLORS } from '../../shared/palette';
import { uiButton } from '../controls';
import { drawEnso, drawIn, ensoEl, h, motion, setEnso, setText, toggle } from '../dom';

const THUMB_W = 120;
const THUMB_H = 60;

/** The board as it was left: each territory in its owner's wash, a faint ivory coast, on the indigo. */
export function drawSketch(cv: HTMLCanvasElement, sketch: SaveSketchVM): boolean {
  let board;
  try {
    board = getBoard(sketch.mapId ?? null);
  } catch {
    return false;
  }
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  cv.width = Math.round(THUMB_W * dpr);
  cv.height = Math.round(THUMB_H * dpr);
  const ctx = cv.getContext('2d');
  if (!ctx) return false;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, THUMB_W, THUMB_H);
  const k = Math.min(THUMB_W / board.width, THUMB_H / board.height);
  const ox = (THUMB_W - board.width * k) / 2;
  const oy = (THUMB_H - board.height * k) / 2;
  const trace = (pts: [number, number][]) => {
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(ox + x * k, oy + (board.height - y) * k) : ctx.moveTo(ox + x * k, oy + (board.height - y) * k)));
    ctx.closePath();
  };
  for (const [id, t] of Object.entries(board.territories)) {
    const c = sketch.owners[id as TerritoryId] as PlayerColorId | undefined;
    ctx.beginPath();
    for (const p of t.polygons) {
      trace(p.outer);
      for (const hole of p.holes) trace(hole);
    }
    ctx.fillStyle = c && PLAYER_COLORS[c] ? PLAYER_COLORS[c].base : 'rgba(240, 235, 224, 0.14)';
    ctx.globalAlpha = 0.88;
    ctx.fill('evenodd');
    ctx.globalAlpha = 1;
    ctx.lineWidth = 0.35;
    ctx.strokeStyle = 'rgba(240, 235, 224, 0.35)';
    ctx.stroke();
  }
  return true;
}

/** The title's mark is always the same brush (the game's own ensō is drawn from its seed in play). */
const TITLE_SEED = 2026;

export class TitleScreen {
  readonly el: HTMLElement;
  private cont: HTMLButtonElement;
  private contSub: HTMLSpanElement;
  private ng: HTMLButtonElement;
  private menu: HTMLDivElement;
  private mark: SVGSVGElement;
  private name: HTMLElement;
  private hasSave: boolean | null = null;
  private drawn = false;
  private thumb: HTMLCanvasElement;
  private sketch: SaveSketchVM | null | undefined = undefined;

  constructor(send: (i: UiIntent) => void) {
    this.el = h('section', 'screen title-screen');
    const col = h('div', 'title-col');
    const lock = h('div', 'lockup');
    this.name = h('h1', 'lk-name', 'War Table');
    const rule = h('div', 'lk-rule');
    this.mark = ensoEl(TITLE_SEED, 'enso lk-enso', { drawable: true });
    rule.append(h('i', 'lk-half'), this.mark, h('i', 'lk-half'));
    lock.append(this.name, rule);

    const menu = (this.menu = h('div', 'title-menu'));
    // Both can be the primary (it depends on a save): each carries a ring, shown only while it is the gold.
    this.ng = uiButton('New game', 'title-item ringable', () => send({ type: 'nav', screen: 'newGame' }), undefined, 'title-new');
    this.cont = uiButton('Continue', 'title-item continue ringable', () => send({ type: 'continue' }), undefined, 'title-continue');
    this.contSub = h('span', 'btn-sub num');
    // The thumbnail sits beside the word on the paper (outside the ring: `ring-skip`), part of its press.
    this.thumb = h('canvas', 'cont-thumb ring-skip hidden');
    this.thumb.dataset.testid = 'continue-thumb';
    this.thumb.setAttribute('aria-hidden', 'true');
    this.cont.append(this.contSub, this.thumb);
    const rules = uiButton('How to play', 'title-item', () => send({ type: 'overlay', overlay: 'rules' }), undefined, 'title-rules');
    const settings = uiButton('Settings', 'title-item quiet', () => send({ type: 'overlay', overlay: 'settings' }), undefined, 'title-settings');
    menu.append(this.ng, this.cont, rules, settings);
    col.append(lock, menu);
    this.el.append(h('div', 'title-scrim'), col);
  }

  /** Kept for the root's call (the fitted-text note now lives only in Settings). */
  setFitted(_on: boolean): void {}

  update(vm: ViewModel): void {
    const save = !!vm.save;
    if (save !== this.hasSave) {
      this.hasSave = save;
      toggle(this.cont, 'hidden', !save);
      const primary = save ? this.cont : this.ng;
      const secondary = save ? this.ng : this.cont;
      primary.classList.add('brass', 'gold', 'role-primary');
      secondary.classList.remove('brass', 'gold', 'role-primary');
      // Primary first.
      this.menu.prepend(primary);
      primary.after(secondary);
    }
    if (vm.save) setText(this.contSub, vm.save.summary);
    const sketch = vm.save?.sketch ?? null;
    if (sketch !== this.sketch) {
      this.sketch = sketch;
      toggle(this.thumb, 'hidden', !(sketch && drawSketch(this.thumb, sketch)));
    }
    setEnso(this.mark, TITLE_SEED, { drawable: true });
    if (vm.screen === 'title' && !this.drawn) {
      this.drawn = true;
      // Arrival: the name is brushed on, then the ensō draws itself round once; the words follow.
      drawIn(this.name, 420);
      drawEnso(this.mark, 900, motion.reduced ? 0 : 180);
      if (!motion.reduced) [...this.menu.children].forEach((c, i) => drawIn(c as HTMLElement, 260, 420 + i * 70));
    }
    if (vm.screen !== 'title') this.drawn = false;
  }
}
