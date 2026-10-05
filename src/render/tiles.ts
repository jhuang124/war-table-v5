// Territory tiles: flat painted washes (docs/INK.md B §3) — one thin extruded sheet per territory, drawn by
// an unlit wash shader (owner colour × paper grain × edge darkening, the ink layer on top, the selection rim
// as a screen-constant ivory line inside the border), plus the flat footprint data used for picking.
import * as THREE from 'three';
import type { BoardGeometry, Vec2 } from '../map/types';
import type { TerritoryId } from '../engine/types';
import { MAP } from './activeMap';
import { TILE_DEPTH, TILE_TOP, adjust, hexToRgb, IVORY, distToRing, toWorld, unclaimedRgb, type RGB } from './util';
import { SIDE_FRAG, SIDE_VERT, TILE_FRAG, TILE_VERT, type SharedUniforms } from './inkGlsl';
import type { InkLayer } from './ink';

export type RimMode = 'none' | 'selectable' | 'selected' | 'target' | 'armed';

export interface TileUniforms {
  [k: string]: THREE.IUniform;
  uAnchorW: { value: THREE.Vector2 };
  uColor: { value: THREE.Vector3 };
  uDeep: { value: THREE.Vector3 };
  uId: { value: number };
  uDim: { value: number };
  uLight: { value: number };
  uFlash: { value: number };
  uGlow: { value: number };
  uDry: { value: number };
  uPhase: { value: number };
  uPeriod: { value: number };
  uSeed: { value: number };
  uRim: { value: THREE.Vector2 };
  uFloodOn: { value: number };
  uFloodR: { value: number };
  uFloodMode: { value: number };
  uFloodTorn: { value: number };
  uFloodSeed: { value: number };
  uFloodOrigin: { value: THREE.Vector2 };
  uFloodDir: { value: THREE.Vector2 };
  uFloodColor: { value: THREE.Vector3 };
  uFloodDeep: { value: THREE.Vector3 };
}

export interface Tile {
  id: TerritoryId;
  /** 1-based index (the ink field's territory id). */
  index: number;
  pivot: THREE.Group;
  mesh: THREE.Mesh;
  top: THREE.ShaderMaterial;
  side: THREE.ShaderMaterial;
  uniforms: TileUniforms;
  /** World-space anchor at the un-lifted tile top. */
  anchorW: THREE.Vector3;
  anchor: Vec2;
  rings: Vec2[][];
  bbox: [number, number, number, number];
  /** Max distance from the anchor to any vertex (board units). */
  radius: number;
  /** Clear radius around the anchor inside the tile (board units); the army token sits at the anchor. */
  clearance: number;
  // --- displayed look (animated)
  rgb: RGB; // owner wash currently shown (before dim/light)
  dim: number; // 0..1 (up to ~1.8 for fortify's phase dim)
  light: number; // 0..1 hover lightness
  flash: number; // 0..1 ivory flash
  flashColor: RGB;
  /** Victory: the wash dries back to paper (0..1). */
  dry: number;
  hoverLift: number;
  selectLift: number;
  press: number;
  fxLift: number;
  /** Phase-change lift (unused on the flat board; kept for the contract of the look fields). */
  phaseLift: number;
  /** Transient coastline glow 0..1 (pulsePhase 'attack'), on top of the rim mode. */
  glow: number;
  flipX: number; // 1 = normal
  rimMode: RimMode;
  rimAlpha: number; // animated rim opacity multiplier
  dirty: boolean;
  ver: Record<string, number>;
}

/** Deep (edge) tone of a wash: darker and a touch more saturated, like pigment pooled at the edge. */
export function deepOf(c: RGB): RGB {
  return adjust(c, 1.12, 0.62);
}

export class TileSet {
  group = new THREE.Group();
  tiles = new Map<TerritoryId, Tile>();
  list: Tile[] = [];
  private entry = new Map<string, Vec2>();
  materials: THREE.Material[] = [];

  constructor(g: BoardGeometry, ink: InkLayer, shared: SharedUniforms) {
    const un = unclaimedRgb();
    for (const id of MAP.territoryIds) {
      const tg = g.territories[id];
      const index = ink.index(id);
      const anchorW = toWorld(tg.anchor[0], tg.anchor[1], TILE_TOP);
      const shapes: THREE.Shape[] = [];
      const rings: Vec2[][] = [];
      for (const p of tg.polygons) {
        rings.push(p.outer);
        const s = new THREE.Shape(p.outer.map(([x, y]) => new THREE.Vector2(x, y)));
        for (const h of p.holes) s.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
        shapes.push(s);
      }
      const geo = new THREE.ExtrudeGeometry(shapes, { depth: TILE_DEPTH, bevelEnabled: false, curveSegments: 1 });
      // shape (x, y, z) → world (x − W/2, z, H/2 − y), then relative to the anchor.
      geo.rotateX(-Math.PI / 2);
      geo.translate(-g.width / 2 - anchorW.x, 0, g.height / 2 - anchorW.z);
      geo.deleteAttribute('normal');
      geo.deleteAttribute('uv');
      geo.computeBoundingSphere();

      // Per-territory breath: its own period (10–18 s) and phase.
      const h = (k: number) => {
        const x = Math.sin(index * 12.9898 + k * 78.233) * 43758.5453;
        return x - Math.floor(x);
      };
      const uniforms: TileUniforms = {
        uAnchorW: { value: new THREE.Vector2(anchorW.x, anchorW.z) },
        uColor: { value: new THREE.Vector3(un[0], un[1], un[2]) },
        uDeep: { value: new THREE.Vector3() },
        uId: { value: index },
        uDim: { value: 0 },
        uLight: { value: 0 },
        uFlash: { value: 0 },
        uGlow: { value: 0 },
        uDry: { value: 0 },
        uPhase: { value: h(1) * Math.PI * 2 },
        uPeriod: { value: 10 + 8 * h(2) },
        uSeed: { value: h(3) * 7.13 },
        uRim: { value: new THREE.Vector2(0, 2) },
        uFloodOn: { value: 0 },
        uFloodR: { value: 0 },
        uFloodMode: { value: 0 },
        uFloodTorn: { value: 0 },
        uFloodSeed: { value: h(4) * 3.7 },
        uFloodOrigin: { value: new THREE.Vector2() },
        uFloodDir: { value: new THREE.Vector2(1, 0) },
        uFloodColor: { value: new THREE.Vector3() },
        uFloodDeep: { value: new THREE.Vector3() },
      };
      const top = new THREE.ShaderMaterial({
        uniforms: { ...shared, ...uniforms },
        vertexShader: TILE_VERT,
        fragmentShader: TILE_FRAG,
        toneMapped: false,
      });
      const side = new THREE.ShaderMaterial({
        uniforms: { uColor: uniforms.uColor },
        vertexShader: SIDE_VERT,
        fragmentShader: SIDE_FRAG,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(geo, [top, side]);
      mesh.userData.territory = id;
      const pivot = new THREE.Group();
      pivot.position.set(anchorW.x, 0, anchorW.z);
      pivot.add(mesh);

      let radius = 0;
      for (const ring of rings)
        for (const [x, y] of ring) radius = Math.max(radius, Math.hypot(x - tg.anchor[0], y - tg.anchor[1]));
      let clearance = Infinity;
      for (const ring of rings) clearance = Math.min(clearance, distToRing(tg.anchor[0], tg.anchor[1], ring));

      const tile: Tile = {
        id,
        index,
        pivot,
        mesh,
        top,
        side,
        uniforms,
        anchorW,
        anchor: tg.anchor,
        rings,
        bbox: tg.bbox,
        radius,
        clearance,
        rgb: un,
        dim: 0,
        light: 0,
        flash: 0,
        flashColor: hexToRgb(IVORY),
        dry: 0,
        hoverLift: 0,
        selectLift: 0,
        press: 0,
        fxLift: 0,
        phaseLift: 0,
        glow: 0,
        flipX: 1,
        rimMode: 'none',
        rimAlpha: 0,
        dirty: true,
        ver: {},
      };
      this.tiles.set(id, tile);
      this.list.push(tile);
      this.group.add(pivot);
      this.materials.push(top, side);
    }
    this.buildEntryPoints(g);
    // While the pigment maps dry in (or fade out on the ladder's L0), the board needs frames even when
    // nothing else moves (reduced motion, the ambient loop off): a dirty tile asks for one.
    ink.kick = () => {
      const t = this.list[0];
      if (t) t.dirty = true;
    };
  }

  get(id: TerritoryId): Tile {
    return this.tiles.get(id)!;
  }

  /** Point (board coords) on `to`'s edge where an attack/march from `from` enters. */
  entryPoint(from: TerritoryId, to: TerritoryId): Vec2 {
    return this.entry.get(`${from}|${to}`) ?? this.get(to).anchor;
  }

  private buildEntryPoints(g: BoardGeometry): void {
    const key = (p: Vec2) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
    const vertsOf = new Map<TerritoryId, Set<string>>();
    for (const id of MAP.territoryIds) {
      const s = new Set<string>();
      for (const p of g.territories[id].polygons) for (const v of p.outer) s.add(key(v));
      vertsOf.set(id, s);
    }
    for (const a of MAP.territoryIds) {
      for (const b of MAP.territoryIds) {
        if (a === b) continue;
        const sa = vertsOf.get(a)!;
        const shared: Vec2[] = [];
        for (const p of g.territories[b].polygons) for (const v of p.outer) if (sa.has(key(v))) shared.push(v);
        if (shared.length >= 2) {
          // centroid of the shared vertices, snapped to the nearest shared vertex
          let cx = 0;
          let cy = 0;
          for (const v of shared) {
            cx += v[0];
            cy += v[1];
          }
          cx /= shared.length;
          cy /= shared.length;
          let best = shared[0];
          let bd = Infinity;
          for (const v of shared) {
            const d = (v[0] - cx) ** 2 + (v[1] - cy) ** 2;
            if (d < bd) {
              bd = d;
              best = v;
            }
          }
          this.entry.set(`${a}|${b}`, best);
        }
      }
    }
    for (const lane of g.seaLanes) {
      for (const [from, to] of [
        [lane.a, lane.b],
        [lane.b, lane.a],
      ] as const) {
        const anchor = g.territories[to].anchor;
        let best: Vec2 = anchor;
        let bd = Infinity;
        for (const seg of lane.segments)
          for (const p of [seg[0], seg[seg.length - 1]]) {
            const d = (p[0] - anchor[0]) ** 2 + (p[1] - anchor[1]) ** 2;
            if (d < bd) {
              bd = d;
              best = p;
            }
          }
        this.entry.set(`${from}|${to}`, best);
      }
    }
  }

  /** (Kept for the view's resize hook; the rims are drawn in the wash shader now.) */
  setResolution(_w: number, _h: number): void {}

  /** Push a tile's animated fields into its uniforms and transform. `pulse` = the breathing target rim. */
  apply(t: Tile, pulse: number, rimScale: number): void {
    const lift = t.hoverLift + t.selectLift + t.press + t.fxLift + t.phaseLift;
    t.pivot.position.y = lift;
    t.pivot.scale.x = Math.max(0.001, t.flipX);
    if (!t.dirty && t.rimMode !== 'target') return;
    const u = t.uniforms;
    if (t.dirty) {
      u.uColor.value.set(t.rgb[0], t.rgb[1], t.rgb[2]);
      const d = deepOf(t.rgb);
      u.uDeep.value.set(d[0], d[1], d[2]);
      u.uDim.value = Math.min(1.8, t.dim);
      u.uLight.value = t.light;
      u.uFlash.value = t.flash;
      u.uGlow.value = t.glow;
      u.uDry.value = t.dry;
    }
    // Rim: selectable ≈ 0.6 / 2.5 px (readable on every wash at home zoom); the picked source full ivory; the
    // eligible targets breathe 0.5 ↔ 0.8 (the board's only pulse); the armed target steady.
    let a = 0;
    let w = 2;
    switch (t.rimMode) {
      case 'selectable':
        a = 0.55;
        w = 2.2;
        break;
      case 'selected':
        a = 1;
        w = 3;
        break;
      case 'target':
        a = pulse;
        w = 2.5;
        break;
      case 'armed':
        a = 0.95;
        w = 2.8;
        break;
    }
    a *= t.rimAlpha;
    u.uRim.value.set(a, w * rimScale);
    t.dirty = false;
  }

  dispose(): void {
    for (const t of this.list) t.mesh.geometry.dispose();
    for (const m of this.materials) m.dispose();
  }
}

export { TILE_TOP };
