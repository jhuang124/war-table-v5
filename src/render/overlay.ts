// DOM overlay above the canvas: the army count painted on each stack's top disc (_claude/v3/PLAN.md §1: an
// ivory numeral on the inlay; no rings), the +N staged beside it while a placement is staged, −N as a loss
// lands, the walking stacks' counts, and territory names (hidden unless hovered, picked, in a fight, or the
// "Territory names" setting is on). Text is laid out at its real size (no CSS scale at rest), so it stays
// crisp at DPR 1 and 2. All writes are batched once per frame, and only when they change.
//
// The numbers are plain, crisp Cormorant Garamond 600 with lining, tabular figures, ivory with a 1 px halo in
// the seat's deep ink, at full height (the board is flat: nothing squashes them onto a tilted face any more).
import * as THREE from 'three';
import type { TerritoryId } from '../engine/types';
import { MAP } from './activeMap';
import { PLAYER_COLORS, type PlayerPalette } from '../shared/palette';
import type { BoardGeometry } from '../map/types';
import type { TileSet } from './tiles';
import { numeralBox, type TokenSystem } from './tokens';
import { hexToRgb } from './util';
import { Animator, ease } from './anim';

const SERIF = "'Cormorant Garamond Variable','Cormorant Garamond',Georgia,serif";
const CSS = `
.rb-overlay{position:absolute;inset:0;pointer-events:none;overflow:hidden;user-select:none;-webkit-user-select:none;contain:strict;--ui:1;--lab:1}
.rb-badge,.rb-trav{position:absolute;left:0;top:0;width:28px;height:16px;display:flex;align-items:center;justify-content:center;
  box-sizing:border-box;color:#f2ede2;font:600 14px/1 ${SERIF};font-variant-numeric:lining-nums tabular-nums;font-feature-settings:'lnum' 1,'tnum' 1;
  letter-spacing:0;white-space:nowrap;will-change:transform;visibility:hidden;transition:opacity 180ms ease-out}
.rb-ring{display:none}
.rb-badge .n,.rb-trav .n{position:relative;display:block;transform:translateY(-.04em);
  text-shadow:0 0 1px var(--halo,#0b1224),0 0 1px var(--halo,#0b1224),0 0 1.5px var(--halo,#0b1224)}
.rb-badge.dim{opacity:.8}
.rb-badge.ghosted{z-index:2}
.rb-ghost{position:absolute;left:calc(100% + 2px);top:50%;transform:translateY(-54%);color:#f2ede2;
  font:600 max(1em, calc(13px * var(--ui)))/1 ${SERIF};font-variant-numeric:lining-nums tabular-nums;letter-spacing:0;display:none}
.rb-ghost.at-left{left:auto;right:calc(100% + 2px)}
.rb-loss{position:absolute;left:0;top:0;color:#f2ede2;font:600 calc(18px * var(--ui))/1 ${SERIF};font-variant-numeric:lining-nums tabular-nums;
  will-change:transform,opacity;white-space:nowrap}
.rb-label{position:absolute;left:0;top:0;transform-origin:0 0;color:rgba(242,237,226,.94);font:600 calc(13.5px * var(--lab))/1.02 ${SERIF};
  letter-spacing:.09em;font-variant-caps:all-small-caps;text-align:center;white-space:pre;will-change:transform;
  visibility:hidden;opacity:0;transition:opacity 120ms ease-out}
.rb-label.focus{font-size:calc(15px * var(--lab));color:#f7f2e8;z-index:3}
.rb-label.on{opacity:1}
.rb-label.one{white-space:nowrap}
.rb-label.on.dry{opacity:.2;transition:opacity 200ms ease-out}
.dry-now .rb-label{transition:none}
.rb-cut{position:absolute;inset:0;background:#0b1224;opacity:0}
`;

/** Kept for the badge's stable per-territory variant (the old ring's). */
const RING_VARIANTS = 6;
const hash01 = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
};

interface Badge {
  id: TerritoryId;
  el: HTMLDivElement;
  ring: HTMLElement;
  num: HTMLSpanElement;
  /** The ring's variant and turn (stable per territory). */
  variant: number;
  turn: number;
  lastOp: number;
  /** A hidden badge dries out (opacity) before it leaves the layout. */
  hideAt: number;
  ghost: HTMLSpanElement;
  shown: number; // displayed number
  visible: boolean;
  lastT: string;
  lastD: number;
  lastInk: string;
  ghostN: number;
  /** Client px (for getScreenPosition / sound pan). */
  x: number;
  y: number;
  /** Container px. */
  cx: number;
  cy: number;
  /** Ring diameter, px. */
  diam: number;
  /** Plaque centre / size (container px). */
  px: number;
  py: number;
  ph: number;
  pw: number;
  /** The whole piece's screen box (stone, figure and numeral), container px. */
  box: [number, number, number, number];
  /** The stone and figure only (no numeral), container px. */
  fig: [number, number, number, number];
  lastW: number;
  lastDigits: number;
  onScreen: boolean;
}

interface Label {
  id: TerritoryId;
  el: HTMLDivElement;
  lastT: string;
  /** Laid-out size (measured when the font changes). */
  w: number;
  h: number;
  /** Currently on screen. */
  on: boolean;
  /** [fight text] where it was placed (container px), and whether it is drying under the dice ring. */
  box?: [number, number, number, number] | null;
  dry?: boolean;
  focus: boolean;
}

interface Chip {
  el: HTMLDivElement;
  id: TerritoryId;
  t: number;
  side: number;
  lastT: string;
  /** Where the chip sits against its ring, chosen on its first frame (then it only rises). */
  spot?: 'right' | 'left' | 'above';
}

interface TravEl {
  el: HTMLDivElement;
  ring: HTMLElement;
  num: HTMLSpanElement;
  used: boolean;
  lastT: string;
  lastD: number;
  n: number;
  owner: string;
}

const dpr = () => Math.min(2, window.devicePixelRatio || 1);
const snap = (v: number, r: number) => Math.round(v * r) / r;

export class Overlay {
  root: HTMLDivElement;
  cut: HTMLDivElement;
  private badges = new Map<TerritoryId, Badge>();
  private badgeList: Badge[] = [];
  private labels: Label[] = [];
  private chips: Chip[] = [];
  private travs: TravEl[] = [];
  private travLayer: HTMLDivElement;
  private v = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private right = new THREE.Vector3(1, 0, 0);
  private showAll = false;
  private focusIds = new Set<TerritoryId>();
  private hoverId: TerritoryId | null = null;
  private _ui = 1;
  private labScale = -1;
  zoomScale = 1;
  /** Smallest count plaque, CSS px (× the text-size softening). Phones use 20 (docs/MOBILE.md §6). */
  minPlaque = 22;
  /** Phones: nudge overlapping count plaques apart (relaxPlaques). */
  relax = false;
  private pos = new Float64Array(MAP.territoryIds.length * 6);
  private off = new Float64Array(MAP.territoryIds.length * 2);
  /** Per piece this frame: the numeral's font px, and the piece's box (stone + figure), container px. */
  private fsz = new Float64Array(MAP.territoryIds.length);
  private ext = new Float64Array(MAP.territoryIds.length * 4);
  private labelsDirty = true;
  /** Names need a re-layout (the board's render-on-demand loop asks). */
  get dirty(): boolean {
    return this.labelsDirty;
  }
  width = 1;
  height = 1;
  /** Screen rect (container px) the dice tray covers while it shows; numbers under it hide. */
  /**
   * What the dice tray covers while it shows (container px): x0..y1 = the dice (numbers under them hide);
   * `ring` = the whole ink ring's box (names are never placed on it); hx0/hx1/hy0 = the phone header's words.
   */
  occluder: { x0: number; y0: number; x1: number; y1: number; on: boolean; hx0?: number; hx1?: number; hy0?: number; ring?: [number, number, number, number] } = { x0: 0, y0: 0, x1: 0, y1: 0, on: false };

  constructor(
    container: HTMLElement,
    g: BoardGeometry,
    private tiles: TileSet,
    private tokens: TokenSystem,
    private anim: Animator,
  ) {
    void g;
    if (!document.getElementById('rb-style')) {
      const st = document.createElement('style');
      st.id = 'rb-style';
      st.textContent = CSS;
      document.head.appendChild(st);
    } else document.getElementById('rb-style')!.textContent = CSS;
    this.root = document.createElement('div');
    this.root.className = 'rb-overlay';
    const vig = document.createElement('div');
    vig.className = 'rb-vignette';
    this.root.appendChild(vig);
    const badgeLayer = document.createElement('div');
    this.root.appendChild(badgeLayer);
    this.travLayer = document.createElement('div');
    this.root.appendChild(this.travLayer);
    const labelLayer = document.createElement('div');
    this.root.appendChild(labelLayer);
    this.cut = document.createElement('div');
    this.cut.className = 'rb-cut';
    this.root.appendChild(this.cut);
    container.appendChild(this.root);

    for (const id of MAP.territoryIds) {
      const el = document.createElement('div');
      el.className = 'rb-badge';
      el.dataset.t = id;
      const ring = document.createElement('i');
      ring.className = 'rb-ring';
      const h = hash01(id);
      const turn = Math.round(h * 360);
      ring.style.transform = `rotate(${turn}deg)`;
      const num = document.createElement('span');
      num.className = 'n';
      const ghost = document.createElement('span');
      ghost.className = 'rb-ghost';
      el.append(ring, num, ghost);
      badgeLayer.appendChild(el);
      const b: Badge = {
        id,
        el,
        ring,
        num,
        variant: Math.floor(hash01(id + '~') * RING_VARIANTS),
        turn,
        lastOp: 1,
        hideAt: 0,
        ghost,
        shown: -1,
        visible: false,
        lastT: '',
        lastD: 0,
        lastInk: '',
        ghostN: 0,
        x: 0,
        y: 0,
        cx: 0,
        cy: 0,
        diam: 24,
        px: 0,
        py: 0,
        ph: 22,
        pw: 22,
        box: [0, 0, 0, 0],
        fig: [0, 0, 0, 0],
        lastW: 0,
        lastDigits: 0,
        onScreen: false,
      };
      this.badges.set(id, b);
      this.badgeList.push(b);

      const lab = document.createElement('div');
      lab.className = 'rb-label';
      lab.textContent = splitName(MAP.territories[id].name);
      labelLayer.appendChild(lab);
      this.labels.push({ id, el: lab, lastT: '', w: 0, h: 0, on: false, focus: false });
    }
  }

  get uiScale(): number {
    return this._ui;
  }
  set uiScale(s: number) {
    this._ui = s;
    this.root.style.setProperty('--ui', String(s));
    this.labelsDirty = true;
  }

  setBadge(id: TerritoryId, n: number, pal: PlayerPalette | null, pop = false): void {
    const b = this.badges.get(id)!;
    const vis = !!pal;
    if (b.visible !== vis) {
      b.visible = vis;
      if (!vis) b.el.style.visibility = 'hidden';
      b.lastT = '';
      b.hideAt = 0;
      b.lastOp = -1;
      this.labelsDirty = true;
    }
    if (!pal) return;
    if (b.shown !== n) {
      if (String(b.shown).length !== String(n).length) b.lastD = 0; // refit the font
      b.num.textContent = String(n);
      b.shown = n;
    }
    if (b.lastInk !== pal.id) {
      // ivory on every stone (the stone's wash is laid on thicker than the territory's, dark enough for it)
      const [r, g, bl] = hexToRgb(pal.base);
      const light = 0.299 * r + 0.587 * g + 0.114 * bl > 0.5;
      const [dr, dg, db] = hexToRgb(pal.deep).map((c) => Math.round(c * 0.72 * 255));
      void light;
      void dr;
      void dg;
      void db;
      b.el.style.color = '';
      // The numeral: ivory with a 1 px ink halo in the seat's deep tone, so it reads over the stone's rim,
      // the wash and the paper alike.
      b.el.style.setProperty('--halo', `rgba(${dr},${dg},${db},0.92)`);
      b.lastInk = pal.id;
    }
    if (pop) this.pop(id);
  }

  /** Numbers on dimmed tiles recede (still legible) so the choice in play leads. */
  setDim(id: TerritoryId, on: boolean): void {
    const b = this.badges.get(id)!;
    if (b.el.classList.contains('dim') !== on) b.el.classList.toggle('dim', on);
  }

  /** The ring dries out (180 ms) and leaves; at instant speed it goes at once. */
  hideBadge(id: TerritoryId): void {
    const b = this.badges.get(id)!;
    if (!b.visible) return;
    b.visible = false;
    if (this.anim.instant || b.lastT === '' || b.lastT === 'off') {
      b.el.style.visibility = 'hidden';
      b.hideAt = 0;
    } else {
      b.el.style.opacity = '0';
      b.lastOp = 0;
      b.hideAt = performance.now() + 190;
    }
    this.labelsDirty = true;
  }

  /** Pop the token (the number rides along: it reads the token's drawn size). */
  pop(id: TerritoryId): void {
    this.tokens.pop(id);
  }

  setGhost(id: TerritoryId, n: number): void {
    const b = this.badges.get(id)!;
    if (b.ghostN === n) return;
    b.ghostN = n;
    // The chip hangs off the token's right edge; lift it above its neighbours so it is never hidden.
    b.el.classList.toggle('ghosted', n > 0);
    if (n > 0) {
      b.ghost.textContent = `+${n}`;
      b.ghost.style.display = 'block';
    } else b.ghost.style.display = 'none';
  }

  /** "−N" beside a territory's ring: it rises a little and dries out (700 ms). */
  lossChip(id: TerritoryId, n: number, side: -1 | 1 = 1): void {
    if (n <= 0) return;
    const el = document.createElement('div');
    el.className = 'rb-loss';
    el.textContent = `−${n}`;
    // Hidden until the next frame places it (never a flash at the corner).
    el.style.visibility = 'hidden';
    this.root.insertBefore(el, this.cut);
    const chip: Chip = { el, id, t: 0, side, lastT: '' };
    this.chips.push(chip);
    const remove = () => {
      el.remove();
      this.chips = this.chips.filter((c) => c !== chip);
    };
    if (this.anim.instant) {
      // Instant speed: still readable briefly, without motion.
      chip.t = 0.35;
      setTimeout(remove, 900);
      return;
    }
    this.anim.tween({ ms: 700, ease: ease.linear, update: (v) => (chip.t = v), done: remove });
  }

  /**
   * The first clear spot for a loss chip `cw` px wide beside badge `b` (clear of every other count by a
   * little air): the ring's right (as always), else its left (over its own figure for a moment), else above.
   */
  private chipSpot(b: Badge, cw: number, order: ('right' | 'left' | 'above')[] = ['right', 'left', 'above'], rise = 14 * this._ui): 'right' | 'left' | 'above' {
    const u = this._ui;
    const h = 20 * u;
    const air = 6 * u;
    const boxOf = (spot: 'right' | 'left' | 'above'): [number, number, number, number] => {
      const x0 = spot === 'right' ? b.px + b.pw / 2 + 4 * u : spot === 'left' ? b.px - b.pw / 2 - 4 * u - cw : b.px - cw / 2;
      const yc = spot === 'above' ? b.py - b.ph / 2 - 10 * u : b.py - 2 * u;
      return [x0, yc - h / 2 - rise, x0 + cw, yc + h / 2];
    };
    // How much of the other counts the box covers, grown by `pad` (0 = touching is fine).
    const cover = (bx: [number, number, number, number], pad: number) => {
      let a = 0;
      for (const o of this.badges.values()) {
        if (o === b || !o.visible || o.lastT === 'off') continue;
        const w = Math.min(bx[2], o.px + o.pw / 2 + pad) - Math.max(bx[0], o.px - o.pw / 2 - pad);
        const hh = Math.min(bx[3], o.py + o.ph / 2 + pad) - Math.max(bx[1], o.py - o.ph / 2 - pad);
        if (w > 0 && hh > 0) a += w * hh;
      }
      return a;
    };
    for (const s of order) if (cover(boxOf(s), air) === 0) return s;
    // Crowded everywhere: the spot that touches the fewest counts (in order when tied).
    let best = order[0];
    let min = Infinity;
    for (const s of order) {
      const a = cover(boxOf(s), 0);
      if (a < min - 0.5) {
        min = a;
        best = s;
      }
    }
    return best;
  }

  /** Settings "Territory names": every name on (collision-culled). */
  setShowLabels(on: boolean): void {
    this.showAll = on;
    this.labelsDirty = true;
  }

  /** Names shown regardless of the setting: the picked source / target (from highlights). */
  setFocus(ids: Iterable<TerritoryId>): void {
    const next = new Set(ids);
    if (next.size === this.focusIds.size && [...next].every((x) => this.focusIds.has(x))) return;
    this.focusIds = next;
    this.labelsDirty = true;
  }

  setHover(id: TerritoryId | null): void {
    if (id === this.hoverId) return;
    this.hoverId = id;
    this.labelsDirty = true;
  }

  /** Fresh projection of a token's top centre (client px), independent of the last frame. */
  project(id: TerritoryId, camera: THREE.Camera, rect: { left: number; top: number }): { x: number; y: number } | null {
    this.tokens.freshTop(id, this.v).project(camera);
    const x = (this.v.x * 0.5 + 0.5) * this.width;
    const y = (-this.v.y * 0.5 + 0.5) * this.height;
    if (!(this.v.z < 1 && x > -20 && x < this.width + 20 && y > -20 && y < this.height + 20)) return null;
    return { x: x + rect.left, y: y + rect.top };
  }

  screenPos(id: TerritoryId): { x: number; y: number } | null {
    const b = this.badges.get(id)!;
    return b.onScreen ? { x: b.x, y: b.y } : null;
  }

  private overTray(x0: number, y0: number, x1: number, y1: number, above = 0): boolean {
    const o = this.occluder;
    if (!o.on) return false;
    if (x1 > o.x0 && x0 < o.x1 && y1 > o.y0 && y0 < o.y1) return true;
    if (above <= 0) return false;
    // The header strip above the tray: only where its words actually are (hx0..hx1 when known), so the
    // numbers beside a short 'Ural 12 · Siberia 4' stay on the board.
    const hx0 = o.hx0 ?? o.x0;
    const hx1 = o.hx1 ?? o.x1;
    return x1 > hx0 && x0 < hx1 && y1 > (o.hy0 ?? o.y0 - above) && y0 < o.y1;
  }
  /** Height of the HUD's fight header line just above the tray (CSS px). */
  get headerBand(): number {
    // Phones only: there the tray band is tight and the header runs over the board; on desktop the band
    // has its own text strip and the home view keeps pieces clear of the tray (behaviour unchanged).
    return this.relax ? 30 * this._ui : 0;
  }
  private trayWasOn = false;

  /**
   * Phones: at the home scale the ≥ 20 px plaques are bigger than the tiles, and neighbours overlap. Nudge
   * overlapping plaques apart along their shallower overlap, each by at most ~0.45 of its height from its
   * piece, so every number stays readable and still sits at its own piece. Deterministic per layout.
   */
  private relaxPlaques(n: number): void {
    const P = this.pos;
    const O = this.off;
    O.fill(0);
    const gap = 1;
    for (let it = 0; it < 4; it++) {
      let any = false;
      for (let i = 0; i < n; i++) {
        const a = i * 6;
        if (!P[a + 5]) continue;
        for (let j = i + 1; j < n; j++) {
          const b = j * 6;
          if (!P[b + 5]) continue;
          const dx = P[b] + O[j * 2] - (P[a] + O[i * 2]);
          const dy = P[b + 1] + O[j * 2 + 1] - (P[a + 1] + O[i * 2 + 1]);
          const ox = (P[a + 2] + P[b + 2]) / 2 + gap - Math.abs(dx);
          const oy = (P[a + 3] + P[b + 3]) / 2 + gap - Math.abs(dy);
          if (ox <= 0 || oy <= 0) continue;
          any = true;
          // Move along the axis that needs less (vertical slightly favoured: plaques are wider than tall).
          if (oy <= ox * 1.2) {
            const s = (dy >= 0 ? 1 : -1) * oy * 0.5;
            O[i * 2 + 1] -= s;
            O[j * 2 + 1] += s;
          } else {
            const s = (dx >= 0 ? 1 : -1) * ox * 0.5;
            O[i * 2] -= s;
            O[j * 2] += s;
          }
        }
      }
      for (let i = 0; i < n; i++) {
        const lim = P[i * 6 + 3] * 0.45;
        O[i * 2] = Math.max(-lim, Math.min(lim, O[i * 2]));
        O[i * 2 + 1] = Math.max(-lim, Math.min(lim, O[i * 2 + 1]));
      }
      if (!any) break;
    }
    for (let i = 0; i < n; i++) {
      P[i * 6] += O[i * 2];
      P[i * 6 + 1] += O[i * 2 + 1];
    }
  }

  private underTray(x: number, y: number): boolean {
    const o = this.occluder;
    return o.on && x > o.x0 && x < o.x1 && y > o.y0 && y < o.y1;
  }

  /** Projected feet (container px, depth) and the figure's screen height, px. */
  private figure(feet: THREE.Vector3, top: THREE.Vector3, camera: THREE.Camera): [number, number, number, number] {
    const W = this.width;
    const H = this.height;
    this.v.copy(feet).project(camera);
    const x = (this.v.x * 0.5 + 0.5) * W;
    const y = (-this.v.y * 0.5 + 0.5) * H;
    const z = this.v.z;
    this.v2.copy(top).project(camera);
    const h = Math.hypot((this.v2.x - this.v.x) * 0.5 * W, (this.v2.y - this.v.y) * 0.5 * H);
    return [x, y, h, z];
  }

  private proj(p: THREE.Vector3, camera: THREE.Camera): [number, number] {
    this.v.copy(p).project(camera);
    return [(this.v.x * 0.5 + 0.5) * this.width, (-this.v.y * 0.5 + 0.5) * this.height];
  }

  /** Kept for callers of the old API: the piece's nominal size for a figure `figH` px tall. */
  plaqueH(figH: number): number {
    const soft = 1 + (this._ui - 1) * 0.8;
    return Math.max(this.minPlaque * soft, Math.min(38 * soft, figH * 0.74));
  }
  /**
   * The numeral's font size from its height on screen (tokens.numeralSize, projected): small, at the stone's
   * edge, never under 18 px (v4 numeral floor, PLAN §5b E6; phones 12: tokens.numMin) × the text size, never
   * squashed (no scaleY anywhere on a numeral).
   */
  private numeralPx(h: number): number {
    const soft = 1 + (this._ui - 1) * 0.8;
    return Math.max(this.tokens.numMin * soft, Math.min(h, 28 * soft));
  }
  /** A disc's diameter on screen (px) at a base point, from its world radius. */
  private discPx(base: THREE.Vector3, r: number, camera: THREE.Camera): number {
    this.v.copy(base).project(camera);
    const x0 = this.v.x;
    const y0 = this.v.y;
    this.v2.copy(base).addScaledVector(this.right, r).project(camera);
    return 2 * Math.hypot((this.v2.x - x0) * 0.5 * this.width, (this.v2.y - y0) * 0.5 * this.height);
  }

  /**
   * The count plaque drawn under a container point (the numbers sit above the whole 3D board, so on touch
   * the number under the finger is what was meant). Overlapping plaques: the one drawn on top (a staged
   * "+N" plaque, else the later in document order) — the number the player can actually see there.
   */
  plaqueAt(x: number, y: number, pad = 0): TerritoryId | null {
    let best: TerritoryId | null = null;
    let bestZ = -1;
    for (const b of this.badgeList) {
      if (!b.visible || !b.onScreen || b.lastT === 'off') continue;
      if (Math.abs(x - b.px) > b.pw / 2 + pad || Math.abs(y - b.py) > b.ph / 2 + pad) continue;
      const z = b.ghostN > 0 ? 1 : 0;
      if (z >= bestZ) {
        bestZ = z;
        best = b.id;
      }
    }
    return best;
  }

  /** Every piece's screen box (container px) this frame, for the board's picking. Null = not drawn. */
  pieceBox(id: TerritoryId): [number, number, number, number] | null {
    const b = this.badges.get(id)!;
    return b.visible && b.onScreen && b.lastT !== 'off' ? b.box : null;
  }

  /** Project and write every transform. Call once per frame after the camera updates. */
  update(camera: THREE.Camera, rect: DOMRect): void {
    const W = this.width;
    const H = this.height;
    const r = dpr();
    const now = performance.now();
    let moved = false;
    const list = this.badgeList;
    const n = list.length;
    const P = this.pos;
    this.right.setFromMatrixColumn(camera.matrixWorld, 0);
    for (let i = 0; i < n; i++) {
      const b = list[i];
      const feet = this.tokens.top(b.id);
      const top = this.tokens.figTop(b.id);
      const [x, y, , z] = this.figure(feet, top, camera);
      // the numeral: small ivory at the stone's lower-right edge (tokens.figTop), its size from the home view's
      const [tx, ty] = this.proj(top, camera);
      const upx = this.discPx(feet, 0.5, camera);
      const dpx = this.tokens.halfWidth(b.id) * 2 * upx;
      const fs = this.numeralPx(this.tokens.numeralSize(b.id) * upx);
      const [pw0, ph] = numeralBox(fs, String(Math.max(0, b.shown)).length);
      // the piece: the stone and the figure standing on it
      const e = this.tokens.pieceExtent(b.id);
      const eo = i * 4;
      this.ext[eo] = x - e[0] * upx;
      this.ext[eo + 1] = y - e[1] * upx;
      this.ext[eo + 2] = x + e[2] * upx;
      this.ext[eo + 3] = y + e[3] * upx;
      this.fsz[i] = fs;
      b.cx = x;
      b.cy = y;
      b.diam = dpx;
      b.x = x + rect.left;
      b.y = y + rect.top;
      b.onScreen = z < 1 && x > -20 && x < W + 20 && y > -20 && y < H + 20;
      const o = i * 6;
      P[o] = tx;
      P[o + 1] = ty;
      P[o + 2] = pw0;
      P[o + 3] = ph;
      P[o + 4] = Math.min(ty - ph / 2, this.ext[eo + 1]);
      P[o + 5] = b.visible && b.onScreen && this.tokens.visual(b.id) >= 0.05 ? 1 : 0;
    }
    // (Numerals are painted on their stacks: they never move off them, so the phone nudge is off.)
    for (let i = 0; i < n; i++) {
      const b = list[i];
      const o = i * 6;
      const px = P[o];
      const py = P[o + 1];
      const pw = P[o + 2];
      const ph = P[o + 3];
      const fy = P[o + 4];
      const digits = String(Math.max(0, b.shown)).length;
      if (Math.abs(px - b.px) > 0.25 || Math.abs(py - b.py) > 0.25 || Math.abs(fy - b.box[1]) > 0.25) moved = true;
      b.px = px;
      b.py = py;
      b.ph = ph;
      b.pw = pw;
      const eo = i * 4;
      // The piece: the stone, the figure standing on it, and its numeral at the edge.
      b.box = [Math.min(this.ext[eo], px - pw / 2), fy, Math.max(this.ext[eo + 2], px + pw / 2), Math.max(this.ext[eo + 3], py + ph / 2)];
      b.fig = [this.ext[eo], this.ext[eo + 1], this.ext[eo + 2], this.ext[eo + 3]];
      if (!b.visible) {
        if (b.hideAt && now >= b.hideAt) {
          b.hideAt = 0;
          b.el.style.visibility = 'hidden';
          b.lastT = 'off';
          if (this.relax) this.labelsDirty = true;
        }
        continue;
      }
      const vis = this.tokens.visual(b.id);
      // Any part of the ring over the dice tray, or behind the HUD's fight header just above it, hides it
      // (a number straddling the tray's rim or cut by the header strip reads as broken).
      const tray = this.overTray(px - pw / 2, py - ph / 2, px + pw / 2, py + ph / 2, this.headerBand);
      if (!b.onScreen || vis < 0.05 || tray) {
        if (b.lastT !== 'off') {
          b.el.style.visibility = 'hidden';
          b.lastT = 'off';
          if (this.relax) this.labelsDirty = true;
        }
        continue;
      }
      const hq = Math.round(ph * 2) / 2;
      const wq = Math.round(pw * 2) / 2;
      if (hq !== b.lastD || wq !== b.lastW || digits !== b.lastDigits) {
        b.lastD = hq;
        b.lastW = wq;
        b.lastDigits = digits;
        const fs = this.fsz[i];
        b.el.style.width = `${wq}px`;
        b.el.style.height = `${hq}px`;
        b.el.style.fontSize = `${Math.round(fs * 2) / 2}px`;
      }
      const op = Math.round(Math.min(1, vis) * 20) / 20;
      if (op !== b.lastOp) {
        b.lastOp = op;
        b.el.style.opacity = op >= 1 ? '' : String(op);
      }
      const tr = `translate3d(${snap(px - wq / 2, r)}px,${snap(py - hq / 2, r)}px,0)`;
      if (tr !== b.lastT) {
        if (b.lastT === '' || b.lastT === 'off') {
          b.el.style.visibility = 'visible';
          // Phones: a count coming back (after a conquest's flood, or from under the tray) re-lays the names,
          // so a name placed while it was hidden never stays on top of it.
          if (this.relax && b.lastT === 'off') this.labelsDirty = true;
        }
        b.el.style.transform = tr;
        b.lastT = tr;
      }
    }
    this.updateTravelers(camera, r);
    if (this.occluder.on !== this.trayWasOn) {
      this.trayWasOn = this.occluder.on;
      this.labelsDirty = true;
    }
    this.updateLabels(moved, r);
    this.applyDry();
    // The "+N" preview beside a ring (placing) moves to the ring's left when a neighbour's count sits on its
    // right ("12 +7" beside a "1" reads as "+71").
    for (const b of this.badgeList) {
      if (b.ghostN <= 0) continue;
      const left = this.chipSpot(b, b.ghost.offsetWidth || 22 * this._ui, ['right', 'left'], 0) === 'left';
      if (left !== b.ghost.classList.contains('at-left')) b.ghost.classList.toggle('at-left', left);
    }
    for (const c of this.chips) {
      const b = this.badges.get(c.id)!;
      const e = ease.outCubic(Math.min(1, c.t));
      const op = c.t < 0.55 ? 1 : 1 - (c.t - 0.55) / 0.45;
      // −N beside the ring (the right of the piece by default), rising a little as it dries. It never
      // lands against a neighbour's count (a "−2" beside a "1" reads as "−21"): then the left, or above.
      const u = this._ui;
      const cw = c.el.offsetWidth || 22 * u;
      if (!c.spot) c.spot = this.chipSpot(b, cw);
      const x = c.spot === 'right' ? b.px + b.pw / 2 + 4 * u : c.spot === 'left' ? b.px - b.pw / 2 - 4 * u - cw : b.px - cw / 2;
      const y = (c.spot === 'above' ? b.py - b.ph / 2 - 10 * u : b.py - 2 * u) - 14 * e * u;
      const tr = `translate3d(${snap(x, r)}px,${snap(y, r)}px,0) translate(0,-50%)`;
      if (tr !== c.lastT) {
        if (!c.lastT) c.el.style.visibility = 'visible';
        c.el.style.transform = tr;
        c.el.style.opacity = op.toFixed(3);
        c.lastT = tr;
      }
    }
  }

  private updateTravelers(camera: THREE.Camera, r: number): void {
    const list = this.tokens.travelers;
    for (const t of this.travs) t.used = false;
    for (let i = 0; i < list.length; i++) {
      const tr = list[i];
      let e = this.travs[i];
      if (!e) {
        const el = document.createElement('div');
        el.className = 'rb-trav';
        const ring = document.createElement('i');
        ring.className = 'rb-ring';
        ring.style.transform = `rotate(${Math.round(i * 97) % 360}deg)`;
        const num = document.createElement('span');
        num.className = 'n';
        el.append(ring, num);
        this.travLayer.appendChild(el);
        e = { el, ring, num, used: false, lastT: '', lastD: 0, n: -1, owner: '' };
        this.travs.push(e);
      }
      e.used = true;
      if (e.n !== tr.n) {
        e.n = tr.n;
        e.num.textContent = String(tr.n);
        e.lastD = 0;
      }
      if (e.owner !== tr.owner) {
        e.owner = tr.owner;
        const pal = (PLAYER_COLORS as Record<string, PlayerPalette | undefined>)[tr.owner];
        if (pal) e.el.style.setProperty('--halo', `rgba(${hexToRgb(pal.deep).map((c) => Math.round(c * 0.72 * 255)).join(',')},0.92)`);
      }
      // the walking stack's numeral rides on its top face
      this.right.setFromMatrixColumn(camera.matrixWorld, 0);
      const [x, y] = this.proj(tr.figTop, camera);
      const fs = this.numeralPx(tr.numH * this.discPx(tr.top, 0.5, camera));
      const digits = String(tr.n).length;
      const [bw, bh] = numeralBox(fs, digits);
      const h = Math.round(bh * 2) / 2;
      const w = Math.round(bw * 2) / 2;
      if (h !== e.lastD) {
        e.lastD = h;
        e.el.style.width = `${w}px`;
        e.el.style.height = `${h}px`;
        e.el.style.fontSize = `${Math.round(fs * 2) / 2}px`;
      }
      const t = `translate3d(${snap(x - w / 2, r)}px,${snap(y - h / 2, r)}px,0)`;
      if (t !== e.lastT || e.el.style.visibility !== 'visible') {
        e.el.style.transform = t;
        e.el.style.visibility = this.underTray(x, y) ? 'hidden' : 'visible';
        e.lastT = t;
      }
    }
    for (const t of this.travs) {
      if (!t.used && t.el.style.visibility !== 'hidden') {
        t.el.style.visibility = 'hidden';
        t.lastT = '';
      }
    }
  }

  /**
   * Names: the hovered tile and the picked source/target always show theirs, just under the token
   * (or above it if another token sits below). With "Territory names" on, every other name shows too,
   * unless it would overlap a token or a name already placed. Runs only when the layout moved.
   */
  private updateLabels(moved: boolean, r: number): void {
    const ls = Math.round(this._ui * Math.min(1.3, Math.max(0.9, this.zoomScale)) * 20) / 20;
    if (ls !== this.labScale) {
      this.labScale = ls;
      this.root.style.setProperty('--lab', String(ls));
      for (const l of this.labels) l.w = 0;
      this.labelsDirty = true;
    }
    if (!moved && !this.labelsDirty) return;
    this.labelsDirty = false;
    const n = this.labels.length;
    const focus = new Set(this.focusIds);
    if (this.hoverId) focus.add(this.hoverId);
    // Piece boxes (figure top → plaque bottom) are the obstacles.
    const boxes: number[] = [];
    const tokenBox: (number[] | null)[] = [];
    for (let i = 0; i < n; i++) {
      const b = this.badgeList[i];
      if (!b.visible || !b.onScreen || b.lastT === 'off') {
        tokenBox.push(null);
        continue;
      }
      tokenBox.push([b.box[0], b.box[1], b.box[2], b.box[3]]);
    }
    const pad = 1.5;
    const hit = (a: number[], x0: number, y0: number, x1: number, y1: number) =>
      a[0] < x1 + pad && a[2] > x0 - pad && a[1] < y1 + pad && a[3] > y0 - pad;
    const free = (i: number, x0: number, y0: number, x1: number, y1: number): boolean => {
      for (let j = 0; j < n; j++) {
        const bb = tokenBox[j];
        if (j !== i && bb && hit(bb, x0, y0, x1, y1)) return false;
      }
      for (let k = 0; k < boxes.length; k += 4) if (hit([boxes[k], boxes[k + 1], boxes[k + 2], boxes[k + 3]], x0, y0, x1, y1)) return false;
      return true;
    };
    // Phones: a name never covers an army count, its own included. Every territory's count counts, even
    // one drying out or hidden for a moment (a conquest changing hands, the dice tray): it is still on
    // screen, or comes back where it was.
    const countsClear = (x0: number, y0: number, x1: number, y1: number): boolean => {
      if (!this.relax) return true;
      for (let j = 0; j < n; j++) {
        const o = this.badgeList[j];
        if (!o.onScreen || o.pw <= 0) continue;
        // A count hidden under the dice or the fight header for the fight doesn't hold its spot: when it
        // comes back the names are laid out again (update() marks them dirty).
        if (this.occluder.on && this.overTray(o.px - o.pw / 2, o.py - o.ph / 2, o.px + o.pw / 2, o.py + o.ph / 2, this.headerBand)) continue;
        if (o.px - o.pw / 2 < x1 + pad && o.px + o.pw / 2 > x0 - pad && o.py - o.ph / 2 < y1 + pad && o.py + o.ph / 2 > y0 - pad) return false;
      }
      return true;
    };
    const freeOfNames = (x0: number, y0: number, x1: number, y1: number): boolean => {
      for (let k = 0; k < boxes.length; k += 4) if (hit([boxes[k], boxes[k + 1], boxes[k + 2], boxes[k + 3]], x0, y0, x1, y1)) return false;
      return true;
    };
    // Focused names first (they always show), then the rest in board order.
    const order = [...Array(n).keys()].sort((a, b) => Number(focus.has(this.labels[b].id)) - Number(focus.has(this.labels[a].id)));
    for (const i of order) {
      const l = this.labels[i];
      const b = this.badgeList[i];
      const isFocus = focus.has(l.id);
      const want = (isFocus || this.showAll) && b.onScreen && !this.underTray(b.cx, b.cy);
      if (l.focus !== isFocus) {
        l.focus = isFocus;
        l.el.classList.toggle('focus', isFocus);
        l.w = 0;
      }
      let place: [number, number] | null = null;
      let small = false;
      let one: [number, number] | null = null;
      if (want) {
        if (l.el.style.visibility !== 'visible') l.el.style.visibility = 'visible';
        if (!l.w) {
          l.el.classList.remove('one');
          l.w = l.el.offsetWidth;
          l.h = l.el.offsetHeight;
        }
        const x0 = b.cx - l.w / 2;
        const x1 = b.cx + l.w / 2;
        const shown = b.visible && b.lastT !== 'off';
        const below = shown ? b.box[3] + 2 : b.cy + 2;
        const above = shown ? b.box[1] - 2 - l.h : b.cy - 2 - l.h;
        // Phones: a spot is clear when it covers no army count (its own included) and stays off the fight
        // header's line over the dice tray. (Desktop: counts and the tray are checked as before, below.)
        const oc = this.occluder;
        const onRing = (x0: number, y0: number, x1: number, y1: number) => !!oc.ring && x1 > oc.ring[0] && x0 < oc.ring[2] && y1 > oc.ring[1] && y0 < oc.ring[3];
        const clear = (x0: number, y0: number, x1: number, y1: number): boolean =>
          countsClear(x0, y0, x1, y1) && !(this.relax && oc.on && (this.overTray(x0, y0 + 2, x1, y1, this.headerBand) || onRing(x0, y0 + 2, x1, y1)));
        if (free(i, x0, below, x1, below + l.h) && clear(x0, below, x1, below + l.h)) place = [b.cx, below];
        else if (shown && free(i, x0, above, x1, above + l.h) && clear(x0, above, x1, above + l.h)) place = [b.cx, above];
        else if (isFocus && !this.relax) place = [b.cx, below];
        else if (isFocus) {
          // Phones: a name that must show: beside its piece if that is clear, else wherever it at least misses the
          // other names (the source and target names of a fight on a phone would otherwise stack).
          const cands: [number, number][] = [];
          for (const y of shown ? [below, above] : [below]) for (const dx of [0.55, -0.55]) cands.push([b.cx + dx * l.w, y]);
          if (shown) {
            // beside the piece, level with it
            const mid = (b.box[1] + b.box[3]) / 2 - l.h / 2;
            cands.push([b.box[2] + 2 + l.w / 2, mid], [b.box[0] - 2 - l.w / 2, mid]);
          }
          place = cands.find(([cx, y]) => free(i, cx - l.w / 2, y, cx + l.w / 2, y + l.h) && clear(cx - l.w / 2, y, cx + l.w / 2, y + l.h)) ?? null;
          // Crowded (a landscape phone's Ural, Europe): a name never prints over an army count (its own
          // included). Of the spots that miss the other names and every count, take the one that covers the
          // least of the other figures, then the nearest. None near at full size: the name steps down to
          // 80 % and looks farther out (INK2 §6, John 2026-09-29). It hides only if even that fails.
          const crowded = (k: number, far: boolean, lw = l.w, lh = l.h): [number, number] | null => {
            const w = lw * k;
            const h = lh * k;
            const bl = shown ? b.box[3] + 2 : b.cy + 2;
            const ab = shown ? b.box[1] - 2 - h : b.cy - 2 - h;
            const mid = shown ? (b.box[1] + b.box[3]) / 2 - h / 2 : b.cy - h / 2;
            const all: [number, number][] = [];
            const ys = shown ? [bl, ab, bl + 0.4 * h, ab - 0.4 * h, mid] : [bl, bl + 0.4 * h];
            // Farther out, but still plainly its own name: within about a line of its piece.
            if (far) for (const m of [0.6, 1.1]) ys.push(bl + m * h, ab - m * h, mid - m * 0.5 * h, mid + m * 0.5 * h);
            const dxs = [0, 0.3, -0.3, 0.55, -0.55, 0.8, -0.8, 1.05, -1.05];
            if (far) dxs.push(1.3, -1.3);
            for (const y of ys) for (const dx of dxs) all.push([b.cx + dx * w, y]);
            if (far && shown) all.push([b.box[2] + 2 + w / 2, mid], [b.box[0] - 2 - w / 2, mid], [b.box[2] + 2 + w / 2, bl], [b.box[0] - 2 - w / 2, bl]);
            const ov = (a0: number, a1: number, c0: number, c1: number) => Math.max(0, Math.min(a1, c1) - Math.max(a0, c0));
            let best: [number, number] | null = null;
            let bestC = Infinity;
            for (const p of all) {
              const x0 = p[0] - w / 2;
              const x1 = p[0] + w / 2;
              const y0 = p[1];
              const y1 = p[1] + h;
              if (x0 < 2 || y0 < 2 || x1 > this.width - 2 || y1 > this.height - 2) continue;
              if (!freeOfNames(x0, y0, x1, y1) || !clear(x0, y0, x1, y1)) continue;
              // It must still read as this piece's name: no other piece nearer to it than its own.
              const mx = p[0];
              const my = p[1] + h / 2;
              const own = shown ? Math.hypot(mx - (b.box[0] + b.box[2]) / 2, my - (b.box[1] + b.box[3]) / 2) : Math.hypot(mx - b.cx, my - b.cy);
              let mine = true;
              for (let j = 0; j < n && mine; j++) {
                const bb = tokenBox[j];
                if (j !== i && bb && Math.hypot(mx - (bb[0] + bb[2]) / 2, my - (bb[1] + bb[3]) / 2) < own * 0.55) mine = false;
              }
              if (!mine) continue;
              let figs = 0;
              for (let j = 0; j < n; j++) {
                const bb = tokenBox[j];
                if (j !== i && bb) figs += ov(x0, x1, bb[0], bb[2]) * ov(y0, y1, bb[1], bb[3]);
              }
              // the least figure covered, then the nearest to its own piece
              const c = figs + 3 * Math.hypot(p[0] - b.cx, p[1] + h / 2 - b.cy);
              if (c < bestC - 0.5) {
                best = p;
                bestC = c;
              }
            }
            return best;
          };
          if (!place) place = crowded(1, false);
          if (!place) {
            place = crowded(0.8, true);
            if (place) small = true;
          }
          // A two-line name ('Southern / Europe') last tries itself on one line, at 80 %.
          if (!place && l.el.textContent?.includes('\n')) {
            l.el.classList.add('one');
            const w1 = l.el.offsetWidth;
            const h1 = l.el.offsetHeight;
            place = crowded(0.8, true, w1, h1);
            if (place) {
              small = true;
              one = [w1, h1];
            }
          }
        }
      }
      if (!one && l.el.classList.contains('one')) l.el.classList.remove('one');
      const lw = one ? one[0] : l.w;
      const lh = one ? one[1] : l.h;
      const k = small ? 0.8 : 1;
      // While the dice tray shows, the HUD's header line above it names the fight: names that would sit in
      // that line (or on the tray) stay hidden rather than print over it.
      if (place && this.occluder.on && this.overTray(place[0] - (lw * k) / 2, place[1] + 2, place[0] + (lw * k) / 2, place[1] + lh * k, this.headerBand)) place = null;
      const on = !!place;
      l.box = place ? [place[0] - (lw * k) / 2, place[1], place[0] + (lw * k) / 2, place[1] + lh * k] : null;
      if (place) {
        boxes.push(place[0] - (lw * k) / 2, place[1], place[0] + (lw * k) / 2, place[1] + lh * k);
        const tr = `translate3d(${snap(place[0] - (lw * k) / 2, r)}px,${snap(place[1], r)}px,0)${small ? ' scale(0.8)' : ''}`;
        if (tr !== l.lastT) {
          l.el.style.transform = tr;
          l.lastT = tr;
        }
      }
      if (on !== l.on) {
        l.on = on;
        l.el.classList.toggle('on', on);
        if (!on) l.el.style.visibility = 'hidden';
      }
    }
  }

  // [fight text] the board's own names under the dice ring's halo dry to 0.2 (200 ms) while it is up, and come
  // back as it goes: words live on the rule, pieces on the board.
  private dryRing: [number, number, number, number] | null = null;
  /** The ring's box (container px) while it is up, else null; `instant` = no fade (reduced motion, instant speed). */
  dryUnder(ring: [number, number, number, number] | null, instant = false): void {
    this.root.classList.toggle('dry-now', instant);
    this.dryRing = ring;
  }
  private applyDry(): void {
    const r = this.dryRing;
    for (const l of this.labels) {
      const b = l.box;
      const d = !!r && !!b && l.on && b[0] < r[2] && b[2] > r[0] && b[1] < r[3] && b[3] > r[1];
      if (d !== !!l.dry) {
        l.dry = d;
        l.el.classList.toggle('dry', d);
      }
    }
  }
  /** Test hook: the names drying under the ring now. */
  get dryLabels(): TerritoryId[] {
    return this.labels.filter((l) => l.dry).map((l) => l.id);
  }

  /** A piece's screen box (figure top → stone or numeral bottom), its numeral, and its stone + figure alone; container px; null if hidden. */
  pieceRects(id: TerritoryId): { box: [number, number, number, number]; plaque: [number, number, number, number]; fig: [number, number, number, number] } | null {
    const b = this.badgeList.find((x) => x.id === id);
    if (!b || !b.visible || !b.onScreen) return null;
    return { box: [b.box[0], b.box[1], b.box[2], b.box[3]], plaque: [b.px - b.pw / 2, b.py - b.ph / 2, b.px + b.pw / 2, b.py + b.ph / 2], fig: [b.fig[0], b.fig[1], b.fig[2], b.fig[3]] };
  }

  get chipCount(): number {
    return this.chips.length;
  }

  dispose(): void {
    this.root.remove();
  }
}

function splitName(name: string): string {
  if (name.length <= 13) return name;
  const words = name.split(' ');
  if (words.length < 2) return name;
  let best = name;
  let bestD = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    const d = Math.abs(a.length - b.length);
    if (d < bestD) {
      bestD = d;
      best = `${a}\n${b}`;
    }
  }
  return best;
}
