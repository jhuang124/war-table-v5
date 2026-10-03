// The dice cup (_claude/v3/PLAN.md §2 "the cup = the turn"): a turned-wood cup, an OBJECT on the paper, not
// UI. It sits beside the current seat's ring in the seat strip and is the largest mark there (v4 §6: the
// turn token is found first); when the turn passes it slides along the strip to the next seat (400 ms);
// when that seat rolls it tips and a few dice pour out toward the ink ring on the board (the board's own
// dice take over as they land), then it rights itself. On the hand-off cover it is painted in the next
// seat's colour.
// v4 (PLAN E1, sitting Q8/Q11): PAINTED, never lit. Three flat tones of wood (the lamp-side band, the body,
// the shadow-side band), an ink edge round the silhouette and the rim, and the one lamp's painted shadow
// falling lower right on the paper. No gradients, no highlights. Wood, never gold: the one gold stays the
// UI's (docs/INK.md B2.1).
import { PLAYER_COLORS } from '../../shared/palette';
import type { PlayerColorId } from '../../engine/types';
import { EASE_BRUSH, h, motion } from '../dom';

let gid = 0;
const hex = (s: string) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
const rgb = (c: number[]) => `rgb(${c.map((v) => Math.round(Math.max(0, Math.min(255, v)))).join(',')})`;
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);

/** Turned wood in three flat tones, its rim, the dark mouth and the ink of its edge. */
const WOOD = { lit: [150, 106, 70], body: [116, 80, 52], shade: [80, 54, 35], rim: [164, 120, 82], mouth: [26, 17, 11], edge: [22, 14, 9] };

/**
 * The cup as an inline SVG (viewBox 40 × 46: the cup, a little from above, and its painted shadow).
 * `tint`: painted in a seat's colour (the hand-off cover) over the wood.
 */
export function cupSvg(tint?: PlayerColorId | null, cls = 'cup-svg'): string {
  const id = `cup${gid++}`;
  let w = WOOD;
  if (tint) {
    const t = hex(PLAYER_COLORS[tint].base);
    const k = 0.72;
    w = {
      lit: mix(WOOD.lit, t.map((v) => Math.min(255, v * 1.18)), k),
      body: mix(WOOD.body, t, k),
      shade: mix(WOOD.shade, t.map((v) => v * 0.66), k),
      rim: mix(WOOD.rim, t.map((v) => Math.min(255, v * 1.3)), k),
      mouth: WOOD.mouth,
      edge: mix(WOOD.edge, t.map((v) => v * 0.3), 0.5),
    };
  }
  // The silhouette: the rolled rim's outer edge, the tapering body, the foot.
  const body = 'M9.6 9.4 L8.1 36.4 L7.2 36.6 L7.0 39.0 Q20 42.6 33.0 39.0 L32.8 36.6 L31.9 36.4 L30.4 9.4 Z';
  return (
    `<svg class="${cls}" viewBox="0 0 40 46" aria-hidden="true">` +
    `<defs><filter id="${id}s" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="0.9"/></filter></defs>` +
    // the one lamp (upper left): the shadow falls lower right, a darker wash of the paper, soft-edged
    `<g filter="url(#${id}s)" fill="rgba(3,5,12,0.5)"><path d="${body}" transform="translate(3.2 2.2)"/><ellipse cx="23.4" cy="41.6" rx="13.6" ry="2.6"/></g>` +
    // three flat tones: the body, the lamp-side band, the shadow-side band
    `<path d="${body}" fill="${rgb(w.body)}"/>` +
    `<path d="M9.6 9.4 L8.1 36.4 L7.2 36.6 L7.0 39.0 Q10.8 40.2 14.6 40.8 L15.2 10.2 Z" fill="${rgb(w.lit)}"/>` +
    `<path d="M26.0 10.0 L27.0 40.6 Q30.2 40.0 33.0 39.0 L32.8 36.6 L31.9 36.4 L30.4 9.4 Z" fill="${rgb(w.shade)}"/>` +
    // the foot's lip and two turned beads, as ink lines following the curve
    `<path d="M7.6 36.6 Q20 39.8 32.4 36.6" fill="none" stroke="${rgb(w.edge)}" stroke-width="0.8" opacity="0.75"/>` +
    `<path d="M9.3 15.0 Q20 17.8 30.7 15.0" fill="none" stroke="${rgb(w.edge)}" stroke-width="0.85" opacity="0.7"/>` +
    `<path d="M8.6 30.4 Q20 33.2 31.4 30.4" fill="none" stroke="${rgb(w.edge)}" stroke-width="0.85" opacity="0.65"/>` +
    // the ink edge round the silhouette
    `<path d="${body}" fill="none" stroke="${rgb(w.edge)}" stroke-width="1.15" stroke-linejoin="round"/>` +
    // the rolled rim, flat, its ink edge, and the dark mouth
    `<ellipse cx="20" cy="9.4" rx="11.6" ry="3.5" fill="${rgb(w.rim)}" stroke="${rgb(w.edge)}" stroke-width="1.1"/>` +
    `<ellipse cx="20" cy="9.7" rx="8.9" ry="2.3" fill="${rgb(w.mouth)}"/>` +
    `</svg>`
  );
}

/** A small bone die for the pour (DOM, a few px): ivory with two pips. */
function pourDie(): HTMLElement {
  const d = h('i', 'cup-die');
  d.innerHTML = `<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.2 1.6 L8.6 1.1 L8.9 8.5 L1.4 8.9 Z" fill="#e8e1d2"/><circle cx="3.4" cy="3.6" r="1" fill="#2a241c"/><circle cx="6.6" cy="6.4" r="1" fill="#2a241c"/></svg>`;
  return d;
}

/**
 * The cup in the seat strip: moves to a seat's slot, tips and pours toward a point on screen (the ink ring),
 * rights itself. Positioned in its container's coordinates.
 */
export class Cup {
  readonly el: HTMLDivElement;
  private body: HTMLDivElement;
  private x = -1;
  private y = -1;
  private tipped = false;

  constructor() {
    this.el = h('div', 'ts-cup');
    this.el.dataset.testid = 'cup';
    this.el.setAttribute('aria-hidden', 'true');
    this.body = h('div', 'cup-body');
    this.body.innerHTML = cupSvg(null);
    this.el.append(this.body);
  }

  /** Sit at (x, y) in the container (the cup's base centre). A slide (400 ms) unless `cut`. */
  moveTo(x: number, y: number, cut: boolean): void {
    if (Math.abs(x - this.x) < 0.5 && Math.abs(y - this.y) < 0.5) return;
    const first = this.x < 0;
    const from = [this.x, this.y];
    this.x = x;
    this.y = y;
    this.el.style.transform = `translate(${x}px, ${y}px)`;
    this.el.dataset.x = String(Math.round(x));
    if (first || cut || motion.reduced || typeof this.el.animate !== 'function') return;
    // the cup is picked up a hair, slides along the strip, and is set down (its shadow tightens as it lands)
    this.el.animate(
      [
        { transform: `translate(${from[0]}px, ${from[1]}px)` },
        { transform: `translate(${(from[0] + x) / 2}px, ${Math.min(from[1], y) - 3}px)`, offset: 0.5 },
        { transform: `translate(${x}px, ${y}px)` },
      ],
      { duration: 400, easing: EASE_BRUSH },
    );
  }

  /** The roll: the cup tips toward the ring and a few dice pour out toward `to` (client px); then it rights. */
  pour(to: { x: number; y: number } | null, dice: number): void {
    if (this.tipped || motion.reduced || typeof this.body.animate !== 'function') return;
    this.tipped = true;
    const tip = this.body.animate(
      [{ transform: 'rotate(0deg)' }, { transform: 'rotate(-58deg)', offset: 0.35 }, { transform: 'rotate(-58deg)', offset: 0.6 }, { transform: 'rotate(0deg)' }],
      { duration: 620, easing: 'cubic-bezier(0.3, 0, 0.3, 1)' },
    );
    tip.onfinish = () => (this.tipped = false);
    if (!to) return;
    const r = this.el.getBoundingClientRect();
    const sx = r.left + r.width * 0.3;
    const sy = r.top + r.height * 0.3;
    for (let i = 0; i < Math.min(5, Math.max(1, dice)); i++) {
      const d = pourDie();
      d.style.left = `${sx}px`;
      d.style.top = `${sy}px`;
      document.body.append(d);
      const dx = to.x - sx + (i - 1.5) * 18;
      const dy = to.y - sy;
      const a = d.animate(
        [
          { transform: 'translate(0,0) rotate(0deg) scale(1)', opacity: 0 },
          { transform: `translate(${dx * 0.18}px, ${dy * 0.02 - 18}px) rotate(${90 + i * 40}deg) scale(1.15)`, opacity: 1, offset: 0.2 },
          { transform: `translate(${dx}px, ${dy}px) rotate(${320 + i * 70}deg) scale(1.9)`, opacity: 0 },
        ],
        { duration: 300, delay: 90 + i * 22, easing: 'cubic-bezier(0.4, 0, 0.9, 0.6)', fill: 'both' },
      );
      a.onfinish = () => d.remove();
    }
  }
}
