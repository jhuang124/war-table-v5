// Continents on the printed board (_claude/v3/PLAN.md §2): a serif label on the sea ("ASIA · +7") printed in
// the continent's own tint (the tint its halo of sea carries, and the tick a holder's seat shows in the strip),
// and — once someone holds the whole continent — its heavy outline (ink.ts / inkGlsl.ts continentInk) re-inked
// in the holder's colour. A new holder's ink sweeps clockwise from north (600 ms) while the label's "+N"
// brightens; a lost hold dries back to silver.
import * as THREE from 'three';
import type { BoardGeometry } from '../map/types';
import type { ContinentId, GameState, PlayerId, TerritoryId } from '../engine/types';
import { CONTINENTS, CONTINENT_IDS } from './activeMap';
import { PLAYER_COLORS, continentInk } from '../shared/palette';
import { Animator, ease, type Run } from './anim';
import { INK_COAST, hexToRgb, mixRgb, setColor, toWorld, type RGB } from './util';
import type { SharedUniforms } from './inkGlsl';
import type { InkLayer } from './ink';

export const FONT_SERIF = "'Cormorant Garamond Variable', 'Cormorant Garamond', Georgia, serif";
void INK_COAST;
/**
 * The label in its continent's tint, lifted toward the ivory so the words read on the indigo. v4 E3: the label and
 * its bonus are Layer 1 with the outline they name (≥ 60 % against the paper; v3's were ≈ 25 %).
 */
const tintOf = (ci: number): RGB => hexToRgb(continentInk(ci, 0.72, CONTINENT_IDS.length));
/** Label opacity: unheld labels are Layer 1 at rest (lead round 2: a touch quieter); a held one a little stronger. */
const LABEL_A = 0.8;
const HELD_LABEL_A = 0.9;

interface Cont {
  id: ContinentId;
  ci: number;
  label: THREE.Mesh;
  labelMat: THREE.MeshBasicMaterial;
  holder: PlayerId;
  labelRgb: RGB;
  labelA: number;
  /** Coast tint amount (0..1) and sweep progress. */
  amount: number;
  sweep: number;
  ver: number;
}

/** Serif small caps on transparent (no shadow: the board carries no text shadows). */
function labelTexture(name: string, bonus: number, px = 112): { texture: THREE.CanvasTexture; aspect: number } {
  const probe = document.createElement('canvas').getContext('2d')!;
  const capsFont = `600 ${px}px ${FONT_SERIF}`;
  const smallFont = `600 ${Math.round(px * 0.78)}px ${FONT_SERIF}`;
  const track = px * 0.08;
  // Small caps: the first letter full size, the rest at 78 %.
  const glyphs: { ch: string; font: string }[] = [];
  for (const word of name.split(' ')) {
    if (glyphs.length) glyphs.push({ ch: ' ', font: capsFont });
    word.split('').forEach((ch, i) => glyphs.push({ ch: ch.toUpperCase(), font: i === 0 ? capsFont : smallFont }));
  }
  const tail = `   ·   +${bonus}`;
  let w = 0;
  for (const g of glyphs) {
    probe.font = g.font;
    w += probe.measureText(g.ch).width + track;
  }
  probe.font = capsFont;
  const tailW = probe.measureText(tail).width;
  const pad = px * 0.2;
  const c = document.createElement('canvas');
  c.width = Math.ceil(w + tailW + pad * 2);
  c.height = Math.ceil(px * 1.35);
  const ctx = c.getContext('2d')!;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  let x = pad;
  const y = c.height / 2;
  for (const g of glyphs) {
    ctx.font = g.font;
    ctx.fillText(g.ch, x, y);
    x += ctx.measureText(g.ch).width + track;
  }
  ctx.font = capsFont;
  (ctx as unknown as { fontVariantNumeric?: string }).fontVariantNumeric = 'lining-nums';
  ctx.fillText(tail, x, y);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return { texture: t, aspect: c.width / c.height };
}

export class Continents {
  group = new THREE.Group();
  private conts = new Map<ContinentId, Cont>();
  materials: THREE.Material[] = [];
  reducedMotion = false;
  private rooms = new Map<ContinentId, number>();
  private anchors = new Map<ContinentId, THREE.Vector3>();

  constructor(
    g: BoardGeometry,
    private anim: Animator,
    private shared: SharedUniforms,
    ink: InkLayer,
  ) {
    CONTINENT_IDS.forEach((id, ci) => {
      const info = CONTINENTS[id];
      const la = g.continents[id].labelAnchor;
      const room = g.continents[id].labelRoom ?? 10;
      const { texture, aspect } = labelTexture(info.name, info.bonus);
      let h = 1.55;
      let w = h * aspect;
      if (w > room * 1.05) {
        w = room * 1.05;
        h = w / aspect;
      }
      const labelMat = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, opacity: LABEL_A, toneMapped: false });
      setColor(labelMat.color, tintOf(ci));
      const label = new THREE.Mesh(new THREE.PlaneGeometry(w, h), labelMat);
      label.rotation.x = -Math.PI / 2;
      toWorld(la[0], la[1], 0.03, label.position);
      label.renderOrder = 2;
      this.group.add(label);
      this.anchors.set(id, label.position.clone());
      this.rooms.set(id, room * 0.96);
      this.materials.push(labelMat);
      const c = ink.continentCentre[id];
      shared.uContSweep.value[ci].set(c[0], c[1], 0, 0);
      this.conts.set(id, { id, ci, label, labelMat, holder: -2, labelRgb: tintOf(ci), labelA: LABEL_A, amount: 0, sweep: 0, ver: 0 });
    });
    for (const c of this.conts.values()) this.apply(c);
  }

  private apply(c: Cont): void {
    setColor(c.labelMat.color, c.labelRgb);
    c.labelMat.opacity = c.labelA;
    const s = this.shared.uContSweep.value[c.ci];
    s.z = c.sweep;
    s.w = c.amount;
  }

  /** Seat colours changed (new game): force the next refresh to recolour. */
  invalidate(): void {
    for (const c of this.conts.values()) c.holder = -2;
  }

  /** The holder's outline ink: its wash, lifted toward its light so it still reads as a line on the indigo. */
  private inkFor(state: GameState | null, holder: PlayerId): RGB | null {
    const pal = holder >= 0 && state?.players[holder] ? PLAYER_COLORS[state.players[holder].color] : null;
    if (!pal) return null;
    return mixRgb(hexToRgb(pal.base), hexToRgb(pal.light), 0.45);
  }
  /** Test hook: each continent's holder and whether its outline is inked in the holder's colour. */
  state(): Record<string, { holder: PlayerId; amount: number; color: [number, number, number] }> {
    const out: Record<string, { holder: PlayerId; amount: number; color: [number, number, number] }> = {};
    for (const c of this.conts.values()) {
      const v = this.shared.uContColor.value[c.ci];
      out[c.id] = { holder: c.holder, amount: c.amount, color: [v.x, v.y, v.z] };
    }
    return out;
  }

  /**
   * Recompute holders from displayed owners. A lost hold dries back (300 ms); a new holder recolours
   * quietly unless `sweep` handles it (continentGained plays the sweep). `snap` = no animation.
   */
  refresh(owners: Record<TerritoryId, PlayerId>, state: GameState | null, snap: boolean): void {
    for (const c of this.conts.values()) {
      const ts = CONTINENTS[c.id].territories;
      let holder: PlayerId = ts.length ? owners[ts[0]] : -1;
      for (const t of ts) if (owners[t] !== holder) holder = -1;
      if (holder < 0) holder = -1;
      if (holder === c.holder) continue;
      const prevHolder = c.holder;
      c.holder = holder;
      const ink = this.inkFor(state, holder);
      const toLabel: RGB = tintOf(c.ci);
      const toLabelA = ink ? HELD_LABEL_A : LABEL_A;
      const from = { l: c.labelRgb, la: c.labelA, a: c.amount };
      const ver = ++c.ver;
      if (ink) this.shared.uContColor.value[c.ci].set(ink[0], ink[1], ink[2]);
      const toA = ink ? 1 : 0;
      const step = (v: number) => {
        if (c.ver !== ver) return;
        c.labelRgb = mixRgb(from.l, toLabel, v);
        c.labelA = from.la + (toLabelA - from.la) * v;
        if (!ink) c.amount = from.a * (1 - v);
        this.apply(c);
      };
      if (ink) {
        // A holder change between two holders (rare: a whole continent changing hands in one go) or a
        // load: the new ink is simply there; a gain plays its sweep (continentGained).
        c.sweep = 1;
        c.amount = toA;
      }
      if (snap || prevHolder === -2) step(1);
      else void this.anim.tween({ ms: 300, ease: ease.inOutQuad, update: step });
    }
  }

  /**
   * Continent gained: the coastline re-inks in the holder's wash, clockwise from north (600 ms). Resolves
   * when the stroke has gone round.
   */
  async sweep(id: ContinentId, state: GameState | null, holder: PlayerId, run: Run | null): Promise<void> {
    const c = this.conts.get(id)!;
    const rgb = this.inkFor(state, holder);
    if (!rgb) return;
    this.shared.uContColor.value[c.ci].set(rgb[0], rgb[1], rgb[2]);
    const ver = ++c.ver;
    c.amount = 1;
    if (this.anim.instant || this.reducedMotion) {
      c.sweep = 1;
      c.labelRgb = tintOf(c.ci);
      c.labelA = HELD_LABEL_A;
      this.apply(c);
      if (this.reducedMotion && !this.anim.instant) await this.anim.wait(150, run);
      return;
    }
    c.sweep = 0;
    const tint = tintOf(c.ci);
    const fromA = c.labelA;
    this.apply(c);
    // the outline re-inks round the continent; the label's "+N" brightens (toward ivory, full strength) and
    // settles to its held weight as the stroke closes
    await this.anim.tween({
      ms: 600,
      ease: ease.inOutSine,
      run,
      update: (v) => {
        if (c.ver !== ver) return;
        c.sweep = v;
        const glow = Math.sin(Math.PI * Math.min(1, v * 1.25));
        c.labelRgb = mixRgb(tint, [0.95, 0.93, 0.89], 0.5 * glow);
        c.labelA = Math.min(1, fromA + (HELD_LABEL_A - fromA) * v + 0.3 * glow);
        this.apply(c);
      },
    });
    if (c.ver === ver) {
      c.labelRgb = tint;
      c.labelA = HELD_LABEL_A;
      this.apply(c);
    }
  }

  /**
   * Keep every label on screen at the home view: a label anchored in open ocean off a board edge shrinks
   * toward the inner end of its clear water (labelRoom) until it clears the edge, never into the land.
   */
  fitLabels(cam: THREE.Camera, W: number): void {
    const margin = Math.max(10, W * 0.012);
    const v = new THREE.Vector3();
    for (const c of this.conts.values()) {
      const home = this.anchors.get(c.id)!;
      const room = this.rooms.get(c.id)!;
      c.label.position.x = home.x;
      c.label.scale.set(1, 1, 1);
      const g = c.label.geometry as THREE.PlaneGeometry;
      const hw = (g.parameters.width / 2) * 0.88;
      const px = (x: number) => (v.set(x, home.y, home.z).project(cam).x * 0.5 + 0.5) * W;
      const l = px(home.x - hw);
      const r = px(home.x + hw);
      if (l >= margin && r <= W - margin) continue;
      const upp = (2 * hw) / Math.max(1, r - l);
      const west = l < margin;
      const innerX = west ? Math.max(home.x + hw, home.x + room / 2) : Math.min(home.x - hw, home.x - room / 2);
      const outerX = west ? home.x - hw + (margin - l) * upp : home.x + hw - (r - (W - margin)) * upp;
      const k = Math.max(0.6, Math.min(1, Math.abs(innerX - outerX) / (2 * hw)));
      c.label.scale.set(k, k, 1);
      c.label.position.x = west ? outerX + hw * k : outerX - hw * k;
    }
  }

  labelCenter(id: ContinentId): THREE.Vector3 {
    return this.conts.get(id)!.label.position;
  }

  dispose(): void {
    for (const c of this.conts.values()) {
      c.label.geometry.dispose();
      c.labelMat.map?.dispose();
    }
    for (const m of this.materials) m.dispose();
  }
}
