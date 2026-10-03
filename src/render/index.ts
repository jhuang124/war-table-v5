// createBoardView: the painted war table (docs/INK.md). Implements the BoardView contract (./BoardView.ts).
import * as THREE from 'three';
import '@fontsource-variable/cormorant-garamond/wght.css';
import '@fontsource-variable/cormorant-garamond/wght-italic.css';
import type {
  BoardHighlights,
  BoardStats,
  BoardView,
  BoardViewOptions,
  CreateBoardView,
  PlayEventOptions,
  TerritoryPointerInfo,
  ViewportInsets,
} from './BoardView';
import type { GameEvent, GameState, PlayerId, TerritoryId } from '../engine/types';
import { ADJACENCY, TERRITORIES, TERRITORY_IDS } from '../engine/mapData';
import type { AudioEngine, PlayOptions, SfxName, StrokeHandle } from '../audio/types';
import { PLAYER_COLORS, type PlayerPalette } from '../shared/palette';
import { Animator, ease, clamp, READABLE, tierMs, type Run } from './anim';
import { buildScene } from './scene';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { TileSet, deepOf, type Tile, type RimMode } from './tiles';
import { FIG_K, FIG_K_MIN, NUMERAL_MIN, NUMERAL_MIN_PHONE, PULSE_MS, TokenSystem, capBucket, pieceEnvelope, piecesClash, stoneK, type PxBox } from './tokens';
import { Overlay } from './overlay';
import { Continents } from './continents';
import { AttackArrow, FortifyRoute, LiveStroke } from './fx';
import { SeaLanes } from './lanes';
import { EDGE_PX, buildInk } from './ink';
import { makeSharedUniforms, paperDriftCPU } from './inkGlsl';
import { DiceTray, boardTrayGeometry } from './dice';
import { CameraRig, HOME_CLEAR_PX, HOME_PITCH } from './camera';
import {
  IVORY,
  LIFT_UNIT,
  TILE_TOP,
  convexHull,
  distToRing,
  hexToRgb,
  paletteOf,
  pointInRing,
  setBoardSize,
  tileRgb,
  washRgb,
  toBoard,
  toWorld,
  mixRgb,
  type RGB,
} from './util';

// 3.0 s budget (INK A6), less the measured overhead: the ends' own frames, and per middle roll the
// dispatch plus a frame or two (MID_OVERHEAD_MS), so a 20-roll blitz holds the cap as well as a 5-roll one.
const BLITZ_CAP = 2800;
const MID_OVERHEAD_MS = 15;
/** The live clamp's target for a whole blitz (the metric's budget is 3.0 s; 150 ms of room for the tail). */
const BLITZ_BUDGET_MS = 2850;
/** Battle tray: fade length, and how long a decided fight's result stays up (docs/ROUND2.md §E). */
const TRAY_FADE_MS = 300;
const TRAY_DECIDED_MS = 1000;
const IVORY_RGB = hexToRgb(IVORY);

async function loadFonts(): Promise<void> {
  if (!('fonts' in document)) return;
  const want = [
    "600 64px 'Cormorant Garamond Variable'",
    "italic 500 64px 'Cormorant Garamond Variable'",
  ];
  const t = new Promise<void>((r) => setTimeout(r, 1500));
  await Promise.race([Promise.all(want.map((f) => document.fonts.load(f, 'AB·+7'))).then(() => undefined), t]).catch(() => undefined);
}

/**
 * Blitz roll durations (UX.md §8.2, docs/INK.md B §4 "Blitz"): the first roll full (660 ms, no held
 * silence), the last full with the 250 ms silence and the single roll's tumble and settle (1020 ms), the
 * middle ones snapping, compressed so the whole blitz stays ≤ 3.0 s.
 */
const BLITZ_FIRST_MS = 660;
const BLITZ_FINAL_MS = 1020;
export function blitzRollMs(index: number, count: number): number {
  if (count <= 1) return 1180;
  if (index === 0) return BLITZ_FIRST_MS;
  if (index === count - 1) return BLITZ_FINAL_MS;
  const ends = BLITZ_FIRST_MS + BLITZ_FINAL_MS;
  let total = ends;
  for (let k = 1; k < count - 1; k++) total += Math.max(180, 600 * Math.pow(0.75, k - 1));
  const mid = Math.max(180, 600 * Math.pow(0.75, index - 1));
  const midCount = count - 2;
  const room = Math.max(0, BLITZ_CAP - ends - midCount * MID_OVERHEAD_MS);
  if (total - ends <= room) return mid;
  const scale = room / (total - ends);
  // floor 120 ms unless the cap can't hold it (very long blitzes): the cap wins.
  const floor = Math.min(120, room / midCount);
  return Math.max(floor, mid * scale);
}

export const createBoardView: CreateBoardView = async (opts: BoardViewOptions): Promise<BoardView> => {
  const { container, geometry: G } = opts;
  setBoardSize(G);
  await loadFonts();

  // --- device profile (docs/MOBILE.md §7) ------------------------------------------
  // Chosen by capability, not user agent: a coarse primary pointer = a touch device (phone or tablet);
  // a small screen on top of that = a phone GPU budget.
  const mq = (q: string) => typeof matchMedia === 'function' && matchMedia(q).matches;
  const coarse = mq('(pointer: coarse)') || (!mq('(pointer: fine)') && (navigator.maxTouchPoints ?? 0) > 0);
  const phoneGpu = coarse && Math.min(screen.width || 9999, screen.height || 9999) < 600;
  /** Device pixel ratio cap: 2 everywhere; touch devices step down to 1.5 when frames miss budget (§7). */
  let dprCap = 2;
  const pixelRatio = () => Math.min(dprCap, window.devicePixelRatio || 1);

  // --- renderer -------------------------------------------------------------
  const makeRenderer = (): THREE.WebGLRenderer => {
    const r = new THREE.WebGLRenderer({ antialias: true, stencil: true, powerPreference: 'high-performance', alpha: false });
    r.setPixelRatio(pixelRatio());
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.08;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.shadowMap.autoUpdate = false;
    r.shadowMap.needsUpdate = true;
    r.autoClear = false;
    r.info.autoReset = false;
    Object.assign(r.domElement.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      display: 'block',
      opacity: '0',
      transition: 'opacity 400ms ease-out',
      touchAction: 'none',
      outline: 'none',
      // A lost context (or the first frames) shows the indigo paper, never a white page.
      background: '#0b1224',
      webkitUserSelect: 'none',
      userSelect: 'none',
      webkitTouchCallout: 'none',
      webkitTapHighlightColor: 'transparent',
    } as Partial<CSSStyleDeclaration>);
    return r;
  };
  let renderer = makeRenderer();
  let canvas = renderer.domElement;
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.appendChild(canvas);

  const anim = new Animator();
  // The ink layer: built once, before the first frame (the canvas stays hidden until it has drawn).
  const ink = await buildInk(G, { small: phoneGpu, maxTextureSize: renderer.capabilities.maxTextureSize, renderer });
  const shared = makeSharedUniforms(ink, G.width, G.height);
  const terrData = shared.uTerr.value.image.data as Uint8Array;
  const parts = buildScene(renderer, G, ink, shared);
  const scene = parts.scene;
  const tiles = new TileSet(G, ink, shared);
  scene.add(tiles.group);
  const tokens = new TokenSystem(anim, tiles, ink.noise);
  scene.add(tokens.group);
  // The figures' sprite atlas (~40 KB): the canvas stays hidden until it has drawn with them.
  await tokens.ready;
  tokens.reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)').matches : false;
  const continents = new Continents(G, anim, shared, ink);
  scene.add(continents.group);
  const arrow = new AttackArrow(tiles, anim, ink.noise);
  scene.add(arrow.group);
  const route = new FortifyRoute(tiles, anim, ink.noise);
  scene.add(route.group);
  const lanes = new SeaLanes(G, anim, ink.noise);
  scene.add(lanes.group);
  const live = new LiveStroke(anim, ink.noise);
  scene.add(live.group);
  // The gold stroke and the fortify route run stone to stone (each figure stands on its stone).
  const feetOf = (id: TerritoryId) => tokens.feet(id);
  arrow.anchorOf = feetOf;
  route.anchorOf = feetOf;
  arrow.reduced = route.reduced = tokens.reduced;
  const overlay = new Overlay(container, G, tiles, tokens, anim);
  const tray = new DiceTray(anim, parts.envTexture);
  const rig = new CameraRig(G.width, G.height);
  // The home view fits the land (not the frame) inside the HUD-free region.
  rig.landHull = convexHull(TERRITORY_IDS.flatMap((id) => G.territories[id].polygons.flatMap((p) => p.outer)));
  // Piece extents (figure tops, base sides, plaque depth): the home view keeps every piece inside the free
  // region and clear of the dice tray's footprint.
  const setPieceExtents = () => {
    // The blot and the ring's foot reach ~0.8 board units below the feet at the home scale.
    rig.pieceExtents = tokens.extentPoints(HOME_PITCH, 0.8 * (1 + (uiScale - 1) * 0.8));
  };
  const camera = rig.camera;

  // --- displayed board state --------------------------------------------------
  const owners = {} as Record<TerritoryId, PlayerId>;
  const armies = {} as Record<TerritoryId, number>;
  for (const t of TERRITORY_IDS) {
    owners[t] = -1;
    armies[t] = 0;
  }
  let lastState: GameState | null = null;
  let colorKey = '';
  let syncGen = 0;
  let reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)').matches : false;
  let audio: AudioEngine | null = null;
  let autoCamera = true;
  let uiScale = 1;
  /** Effective insets: `bottom` = the bottom strip only, `trayBand` = the band above it (0 = default). */
  let insets: ViewportInsets = { top: 0, right: 0, bottom: 0, left: 0, trayBand: 0 };
  let W = 1;
  let H = 1;
  let disposed = false;
  /** Frames still to draw after the last change (a short tail, so settling values land). */
  let hot = 3;
  const invalidate = () => {
    hot = Math.max(hot, 3);
  };
  /** playEvent promises still running: their handlers may change the board between tweens. */
  let inflight = 0;
  let lastConquered: TerritoryId | null = null;
  let lastConquestFrom: TerritoryId | null = null;
  let lastConquestAt = -1e9;
  let lastPairKey = '';
  let lastRollEnd = -1e9;
  let rolling = 0;
  let arrowSource: 'hl' | 'event' | null = null;
  let lastHl: BoardHighlights = {};
  let clickable = new Set<TerritoryId>();
  let hovered: TerritoryId | null = null;
  let pressed: TerritoryId | null = null;
  const clickCbs: ((i: TerritoryPointerInfo) => void)[] = [];
  const hoverCbs: ((i: TerritoryPointerInfo | null) => void)[] = [];

  // Phase response (pulsePhase): other players' tiles dimmed in fortify.
  const phaseDimmed = new Set<TerritoryId>();
  let phaseVer = 0;
  // Listeners: the view left home (Reset view pill) / the battle tray showed or started to fade.
  const displacedCbs: ((d: boolean) => void)[] = [];
  let lastDisplaced = false;
  const trayCbs: ((v: boolean) => void)[] = [];
  let trayShownEmitted = false;
  const emitTray = (v: boolean) => {
    if (v === trayShownEmitted) return;
    trayShownEmitted = v;
    for (const cb of trayCbs) {
      try {
        cb(v);
      } catch (err) {
        console.error(err);
      }
    }
  };
  const hideTray = (ms: number) => {
    tray.hide(ms);
    emitTray(false);
  };
  /**
   * The fight recession (docs/INK2.md §2.2): while the ink ring is up, every territory but the pair recedes
   * to dim 1.3 on desktop (1.0 on phones, the armed dim only) over 180 ms; the pair stays at 0; the count
   * rings on receded tiles go to their dim look (80 %, never below 60 %). It comes back (300 ms) as the ring
   * dries out. Reduced motion: at once.
   */
  let fightPair: string[] | null = null;
  let fightDimMs: number | null = null;
  const fightDimOf = (id: TerritoryId): number => (fightPair && !fightPair.includes(id) ? (compact ? 1 : 1.3) : 0);
  const recede = (pair: string[] | null, ms: number) => {
    if ((fightPair?.join('>') ?? '') === (pair?.join('>') ?? '')) return;
    fightPair = pair;
    // The fighting pair (every figure stands on its stone at rest now; the pair only faces and leans).
    tokens.setFight(pair as TerritoryId[] | null);
    fightDimMs = reduced || anim.instant ? 0 : ms;
    try {
      applyHighlights(lastHl, lastHl);
    } finally {
      fightDimMs = null;
    }
  };
  tray.onHide = (ms) => recede(null, Math.max(ms, 300));
  const pal = (p: PlayerId): PlayerPalette | null => paletteOf(lastState, p);
  const isHuman = (p: PlayerId) => !!lastState?.players[p] && lastState.players[p].kind === 'human';
  const isAi = (p: PlayerId) => !!lastState?.players[p] && lastState.players[p].kind === 'ai';

  // A blitz's middle rolls share what's left of the 3.0 s budget against the real clock (frames and
  // dispatch cost more on a busy machine), never more than their planned length (blitzRollMs).
  let blitzT0 = 0;
  const blitzMidMs = (idx: number, count: number): number => {
    const planned = blitzRollMs(idx, count);
    if (anim.speed !== 1) return planned;
    const midsLeft = Math.max(1, count - 1 - idx);
    const left = BLITZ_BUDGET_MS - (performance.now() - blitzT0) - BLITZ_FINAL_MS;
    return Math.max(0, Math.min(planned, left / midsLeft - MID_OVERHEAD_MS));
  };

  // --- sound helpers ------------------------------------------------------------
  const sfx = (name: SfxName, o: PlayOptions = {}) => {
    if (!audio) return;
    try {
      audio.play(name, o);
    } catch {
      /* never throws, but be safe */
    }
  };
  const panOf = (t: TerritoryId) => {
    const p = overlay.screenPos(t);
    if (!p) return 0;
    return clamp(((p.x / Math.max(1, window.innerWidth)) * 2 - 1) * 0.6, -1, 1);
  };
  // Camera moves > 0.3 board widths get a whoosh that lasts as long as the move.
  rig.onWhoosh = (ms) => sfx('whoosh', { duration: Math.min(1.5, Math.max(0.2, ms / 1000)) });
  const placeSound = new Map<TerritoryId, { t: number; streak: number }>();
  const playPlace = (t: TerritoryId, vol: number) => {
    const now = performance.now();
    const s = placeSound.get(t) ?? { t: -1e9, streak: 0 };
    if (now - s.t < 70) return;
    s.streak = now - s.t < 650 ? Math.min(5, s.streak + 1) : 0;
    s.t = now;
    placeSound.set(t, s);
    sfx('place', { volume: vol, pan: panOf(t), rate: 1 + 0.03 * s.streak + (Math.random() - 0.5) * 0.08 });
  };

  // --- tile look helpers ----------------------------------------------------------
  const tw = (t: Tile, key: string, from: number, to: number, ms: number, e = ease.outCubic, set?: (v: number) => void, run: Run | null = null) => {
    const ver = (t.ver[key] = (t.ver[key] ?? 0) + 1);
    const apply =
      set ??
      ((v: number) => {
        (t as unknown as Record<string, number>)[key] = v;
      });
    if (Math.abs(from - to) < 1e-4) {
      apply(to);
      t.dirty = true;
      return Promise.resolve();
    }
    return anim.tween({
      ms,
      ease: e,
      run,
      update: (v) => {
        if (t.ver[key] !== ver) return;
        apply(from + (to - from) * v);
        t.dirty = true;
      },
    });
  };

  const setOwnerLook = (id: TerritoryId, owner: PlayerId) => {
    const t = tiles.get(id);
    // v4 E4: the land takes the seat's tint, the stone keeps its full pigment
    t.rgb = washRgb(lastState, owner);
    t.dirty = true;
    tokens.setColor(id, tileRgb(lastState, owner));
  };

  const refreshBadge = (id: TerritoryId, pop = false) => {
    const p = pal(owners[id]);
    if (!p || armies[id] <= 0) {
      overlay.hideBadge(id);
      return;
    }
    overlay.setBadge(id, armies[id], p, pop);
  };

  // --- highlights ------------------------------------------------------------------
  const applyHighlights = (h: BoardHighlights, prev: BoardHighlights) => {
    const sel = h.selected ?? null;
    const targets = new Set(h.targets ?? []);
    const selectable = new Set(h.selectable ?? []);
    const arrowTo = h.arrow?.kind === 'attack' ? h.arrow.to : null;
    const arrowFrom = h.arrow?.from ?? null;
    clickable = new Set<TerritoryId>([...selectable, ...targets]);
    if (sel) clickable.add(sel);
    if (arrowTo) clickable.add(arrowTo);
    const keep = new Set<TerritoryId>([...clickable]);
    if (arrowFrom) keep.add(arrowFrom);
    if (h.arrow?.path) h.arrow.path.forEach((x) => keep.add(x));
    for (const t of tiles.list) {
      let mode: RimMode = 'none';
      // Armed (an attack arrow is up): only the pair and the arrow are lit; the other targets fall back
      // to plain selectable (still clickable), so the fight in play leads (docs/ROUND2.md §E).
      if (t.id === sel) mode = 'selected';
      else if (t.id === arrowTo) mode = 'armed';
      else if (targets.has(t.id)) mode = arrowTo ? 'selectable' : reduced ? 'armed' : 'target';
      else if (selectable.has(t.id)) mode = 'selectable';
      if (mode !== t.rimMode) {
        const wasNone = t.rimMode === 'none';
        t.rimMode = mode;
        t.dirty = true;
        if (wasNone && mode !== 'none') tw(t, 'rimAlpha', 0, 1, mode === 'selected' ? 120 : 100, ease.outQuad);
        else t.rimAlpha = 1;
      }
      const lift = t.id === sel ? 0.35 * LIFT_UNIT : 0;
      if (Math.abs(lift - t.selectLift) > 1e-4) {
        const up = lift > t.selectLift;
        tw(t, 'selectLift', t.selectLift, lift, up ? 160 : 120, up ? (reduced ? ease.outCubic : ease.outBack(1.4)) : ease.inQuad);
      }
      // Fortify's phase dim is deeper than a selection's: the board becomes "your side" (docs/ROUND2.md §A).
      // A pick shows its reach (PLAN §2 'visible water = adjacency'): land it can't touch recedes a little.
      const reach = sel && !fightPair && t.id !== sel && !ADJACENCY[sel].includes(t.id) ? 0.8 : 0;
      const dim = Math.max(h.dimOthers && !keep.has(t.id) ? 1 : 0, phaseDimmed.has(t.id) ? 1.8 : 0, fightDimOf(t.id), reach);
      if (Math.abs(dim - t.dim) > 1e-4) tw(t, 'dim', t.dim, dim, fightDimMs ?? (dim > t.dim ? 180 : 140), ease.outQuad);
      overlay.setDim(t.id, dim >= 1);
      if (!clickable.has(t.id) && t.hoverLift > 0 && t.id !== hovered) tw(t, 'hoverLift', t.hoverLift, 0, 140);
    }
    // hover state may have changed clickability
    if (hovered) setHoverLook(hovered, clickable.has(hovered));
    updateCursor();
    // pending ghosts
    for (const id of TERRITORY_IDS) overlay.setGhost(id, Math.max(0, h.pending?.[id] ?? 0));
    pushPreview(h);
    // names: the picked source and the armed target show theirs (the hovered tile's is set on hover)
    const named: TerritoryId[] = [];
    if (sel) named.push(sel);
    if (h.arrow) named.push(h.arrow.from, h.arrow.to);
    overlay.setFocus(named);
    litLanes(h);
    // arrow / route
    const a = h.arrow ?? null;
    if (a && a.kind === 'attack') {
      route.hide();
      const color = tileRgb(lastState, owners[a.from]);
      arrowSource = 'hl';
      const sameArrow = prev.arrow?.kind === 'attack' && prev.arrow.from === a.from && prev.arrow.to === a.to;
      const off = !sameArrow && rig.autoProgress >= 1 && isAi(owners[a.from]) ? needsFraming(a.from, a.to) : false;
      // An attack armed by a drawn stroke: the arrow picks up where the stroke left off (it settles).
      const settle = strokeSettle && strokeSettle.key === `${a.from}|${a.to}` && performance.now() - strokeSettle.at < 600;
      if (settle) strokeSettle = null;
      // At rest the armed arrow is ivory (the moodboard's): Blitz holds the one gold. A drawn stroke's
      // gold settles into it and dries to ivory as the commit button takes the gold.
      if (!sameArrow && rolling === 0) arrow.ink(!!settle, 0);
      if (off) {
        void frameEngagement(a.from, a.to, null).then(() => {
          if (lastHl.arrow?.from === a.from && lastHl.arrow?.to === a.to) void arrow.show(a.from, a.to, color);
        });
      } else if (settle) {
        void arrow.show(a.from, a.to, color, null, 150, 0.55);
        arrow.ink(false, 140);
      } else void arrow.show(a.from, a.to, color);
    } else if (a && a.kind === 'fortify') {
      if (arrowSource === 'hl') arrow.hide();
      arrowSource = null;
      route.show(a.path && a.path.length >= 2 ? a.path : [a.from, a.to]);
    } else {
      route.hide();
      if (arrowSource === 'hl') {
        arrow.hide();
        arrowSource = null;
      }
    }
    // A selection change ends the dice linger, except the controller's auto-chain after a conquest:
    // with no arrow and the selection on the last engagement's own pair, the deciding roll keeps its
    // moment until the linger timer or the next roll ends it (R1-07).
    const selKey = (x: BoardHighlights) => `${x.selected ?? ''}|${x.arrow ? `${x.arrow.from}>${x.arrow.to}` : ''}`;
    const [pairFrom, pairTo] = lastPairKey.split('>');
    const autoChain = !h.arrow && !!h.selected && (h.selected === pairFrom || h.selected === pairTo);
    if (selKey(h) !== selKey(prev) && tray.visible && rolling === 0 && !autoChain) hideTray(TRAY_FADE_MS);
  };

  /**
   * Ghost stacks (PLAN §1 "occupy preview = a ghost stack"): a staged placement's total, and the controller's
   * occupy / fortify totals while a count is being chosen (setCountPreview). A total under the stack fades
   * the discs that would leave; one over it stands as a paler ghost at that height.
   */
  let countPreview: Partial<Record<TerritoryId, number>> | null = null;
  const pushPreview = (h: BoardHighlights) => {
    const tot: Partial<Record<TerritoryId, number>> = {};
    let any = false;
    for (const [id, n] of Object.entries(h.pending ?? {}) as [TerritoryId, number][])
      if (n > 0) {
        tot[id] = armies[id] + n;
        any = true;
      }
    if (countPreview)
      for (const [id, n] of Object.entries(countPreview) as [TerritoryId, number][]) {
        tot[id] = n;
        any = true;
      }
    tokens.setPreview(any ? tot : null);
  };

  /** The crossings brighten with the pick, the armed pair and the hovered tile. */
  const litLanes = (h: BoardHighlights) => {
    const ids: TerritoryId[] = [];
    if (h.selected) ids.push(h.selected);
    if (h.arrow) ids.push(h.arrow.from, h.arrow.to);
    if (hovered) ids.push(hovered);
    lanes.light(ids);
  };

  // --- phase response (no camera moves) ---------------------------------------------------------
  const clearPhase = () => {
    phaseVer++;
    const had = phaseDimmed.size > 0;
    phaseDimmed.clear();
    for (const t of tiles.list) {
      if (t.phaseLift > 1e-4) tw(t, 'phaseLift', t.phaseLift, 0, 160, ease.inQuad);
      if (t.glow > 1e-4) tw(t, 'glow', t.glow, 0, 240, ease.outQuad);
    }
    if (had) applyHighlights(lastHl, lastHl);
  };
  /**
   * The board answers a phase change (docs/ROUND2.md §A, in the ink language — docs/INK.md B §4): → attack,
   * the coastlines of the territories that can attack brighten, west → east, and settle; → fortify, other
   * players' washes recede (until the turn ends); → end, it all clears. Any change also ends the battle tray.
   */
  const pulsePhase = (phase: 'attack' | 'fortify' | 'end', o?: { player?: PlayerId; territories?: TerritoryId[] }) => {
    if (disposed) return;
    if (tray.visible && rolling === 0) hideTray(TRAY_FADE_MS);
    clearPhase();
    if (phase === 'end') return;
    const me = o?.player ?? lastState?.currentPlayer;
    if (me === undefined || me === null || me < 0) return;
    if (phase === 'fortify') {
      for (const id of TERRITORY_IDS) if (owners[id] !== me) phaseDimmed.add(id);
      applyHighlights(lastHl, lastHl);
      return;
    }
    const ids = o?.territories ?? TERRITORY_IDS.filter((id) => owners[id] === me && armies[id] >= 2 && ADJACENCY[id].some((n) => owners[n] !== me));
    if (!ids.length) return;
    const xs = ids.map((id) => tiles.get(id).anchor[0]);
    const x0 = Math.min(...xs);
    const span = Math.max(1, Math.max(...xs) - x0);
    const ver = phaseVer;
    ids.forEach((id, i) => {
      const t = tiles.get(id);
      const go = () => {
        if (ver !== phaseVer) return;
        // the ink brightens (quick, sure) and dries back slowly
        void tw(t, 'glow', t.glow, 1, reduced ? 120 : 160, ease.outQuad).then(() => {
          if (ver === phaseVer) void tw(t, 'glow', t.glow, 0, reduced ? 300 : 700, ease.inOutSine);
        });
      };
      const delay = reduced ? 0 : (300 * (xs[i] - x0)) / span;
      if (delay <= 1) go();
      else void anim.wait(delay, null, true).then(go);
    });
  };

  /** Turn start: the washes dim 8 % and come back (a breath; never waited on). */
  let breathVer = 0;
  const turnBreath = () => {
    if (anim.instant || reduced) return;
    const ver = ++breathVer;
    const from = shared.uBreath.value;
    void anim
      .tween({
        ms: 300,
        unscaled: true,
        ease: ease.outCubic,
        update: (v) => {
          if (ver === breathVer) shared.uBreath.value = from + (1 - from) * v;
        },
      })
      .then(() => {
        if (ver !== breathVer) return;
        void anim.tween({
          ms: 520,
          unscaled: true,
          ease: ease.inOutSine,
          update: (v) => {
            if (ver === breathVer) shared.uBreath.value = 1 - v;
          },
        });
      });
  };

  // --- hover / picking -----------------------------------------------------------------
  const setHoverLook = (id: TerritoryId, on: boolean) => {
    const t = tiles.get(id);
    const lift = on ? 0.15 * LIFT_UNIT : 0;
    if (Math.abs(t.hoverLift - lift) > 1e-4) tw(t, 'hoverLift', t.hoverLift, lift, on ? 90 : 140);
    const light = on ? 1 : 0;
    if (Math.abs(t.light - light) > 1e-4) tw(t, 'light', t.light, light, on ? 90 : 140);
  };
  const updateCursor = () => {
    const c = dragging ? 'grabbing' : hovered && clickable.has(hovered) ? 'pointer' : 'default';
    if (canvas.style.cursor !== c) canvas.style.cursor = c;
  };

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const hit = new THREE.Vector3();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -TILE_TOP);
  const rectOf = () => canvas.getBoundingClientRect();

  /** Board point under a client pixel on the un-lifted tile-top plane. */
  const boardPoint = (cx: number, cy: number): [number, number] | null => {
    const r = rectOf();
    ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    if (!ray.ray.intersectPlane(plane, hit)) return null;
    return toBoard(hit.x, hit.z);
  };
  const territoryAt = (bx: number, by: number): TerritoryId | null => {
    for (const t of tiles.list) {
      const [x0, y0, x1, y1] = t.bbox;
      if (bx < x0 || bx > x1 || by < y0 || by > y1) continue;
      for (const ring of t.rings) if (pointInRing(bx, by, ring)) return t.id;
    }
    return null;
  };
  /** Board units per CSS px near a board point (for the 3 px hysteresis). */
  const unitsPerPx = (bx: number, by: number): number => {
    const a = toWorld(bx, by, TILE_TOP).project(camera);
    const b = toWorld(bx + 1, by, TILE_TOP).project(camera);
    const px = Math.hypot((b.x - a.x) * 0.5 * W, (b.y - a.y) * 0.5 * H);
    return px > 0 ? 1 / px : 0.1;
  };
  /** A piece's figure stands up over the tiles behind it: a click on the figure picks its own territory. */
  const inPiece = (id: TerritoryId, x: number, y: number, pad: number): boolean => {
    const b = overlay.pieceBox(id);
    if (!b) return false;
    const hw = (b[2] - b[0]) * 0.5 * 0.8 + pad;
    const mx = (b[0] + b[2]) / 2;
    // The top third of a brush figure's box is mostly spear, pennant and air: it never takes a tap
    // from the tile or figure behind it (at phone scale Afghanistan's spear stands over Ural's anchor).
    const top = b[1] + (b[3] - b[1]) * 0.3;
    return x >= mx - hw && x <= mx + hw && y >= top - pad && y <= b[3] + pad;
  };
  const pieceAt = (x: number, y: number): TerritoryId | null => {
    let best: TerritoryId | null = null;
    let bestY = -Infinity;
    for (const t of tiles.list) {
      if (!inPiece(t.id, x, y, 0)) continue;
      const b = overlay.pieceBox(t.id)!;
      // overlapping pieces: the one standing in front (lower on screen) wins
      if (b[3] > bestY) {
        bestY = b[3];
        best = t.id;
      }
    }
    return best;
  };
  const pick = (cx: number, cy: number, useHysteresis: boolean): TerritoryId | null => {
    const r = rectOf();
    const x = cx - r.left;
    const y = cy - r.top;
    const bp = boardPoint(cx, cy);
    const ground = bp ? territoryAt(bp[0], bp[1]) : null;
    const cand = pieceAt(x, y) ?? ground;
    if (!useHysteresis || !hovered || cand === hovered) return cand;
    // A new tile or piece takes hover only once the pointer is ≥ 3 px past the hovered one's edge.
    if (inPiece(hovered, x, y, 3)) return hovered;
    if (!bp) return cand;
    const cur = tiles.get(hovered);
    let d = Infinity;
    for (const ring of cur.rings) d = Math.min(d, distToRing(bp[0], bp[1], ring));
    if (ground === hovered || d / unitsPerPx(bp[0], bp[1]) < 3) {
      // still over (or within 3 px of) the hovered tile: a piece standing there takes it only once the
      // pointer is 3 px inside that piece
      const onPiece = pieceAt(x, y);
      if (!onPiece || !inPiece(onPiece, x, y, -3)) return hovered;
      return onPiece;
    }
    return cand;
  };

  const pointerInfo = (e: PointerEvent | MouseEvent, id: TerritoryId, button?: number): TerritoryPointerInfo => ({
    territory: id,
    clientX: e.clientX,
    clientY: e.clientY,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
    button: button ?? e.button,
  });

  let down: { x: number; y: number; t: number; button: number; tile: TerritoryId | null; id: number } | null = null;
  let dragging = false;
  let lastMove = { x: 0, y: 0 };
  let lastHoverEvent: PointerEvent | null = null;

  const setHovered = (id: TerritoryId | null, e: PointerEvent | null) => {
    if (id === hovered) return;
    const prev = hovered;
    hovered = id;
    overlay.setHover(id);
    litLanes(lastHl);
    if (prev) setHoverLook(prev, false);
    if (id && clickable.has(id)) setHoverLook(id, true);
    updateCursor();
    if (!e) for (const cb of hoverCbs) cb(null);
  };

  // --- draw-to-attack (docs/INK.md A2) ---------------------------------------------------------------
  // A drag that starts on an eligible source (setStrokeSources) draws a live gold stroke that follows the
  // pointer, instead of panning. Releasing over one of that source's targets reports it (onStroke done, `to`
  // set: the controller arms it like a target-first tap, and the stroke settles into the arrow); anywhere
  // else cancels and the stroke dries out. Taps are unaffected; a stroke never commits anything.
  let strokeSources = new Set<TerritoryId>();
  let strokeTargetsOf: ((s: TerritoryId) => TerritoryId[]) | null = null;
  const strokeCbs: ((s: { from: TerritoryId; to: TerritoryId | null; done: boolean }) => void)[] = [];
  let stroke: { from: TerritoryId; to: TerritoryId | null; targets: Set<TerritoryId>; live: boolean } | null = null;
  /** The last stroke that armed an attack: its arrow grows from where the stroke left off. */
  let strokeSettle: { key: string; at: number } | null = null;
  const emitStroke = (from: TerritoryId, to: TerritoryId | null, done: boolean) => {
    for (const cb of strokeCbs) {
      try {
        cb({ from, to, done });
      } catch (err) {
        console.error(err);
      }
    }
  };
  const strokeCandidate = (id: TerritoryId | null) => {
    if (!id || !strokeSources.has(id) || !strokeTargetsOf) return null;
    const targets = new Set(strokeTargetsOf(id));
    return targets.size ? { from: id, to: null, targets, live: false } : null;
  };
  /**
   * The stroke source a pointer-down means: the number plaque under it (the most natural thing to grab), else
   * the tile or piece under it; on touch, else the nearest eligible source within 12 px (a fingertip is wide
   * and figures overlap their neighbours at phone scale). Null = this drag pans.
   */
  const strokeSourceAt = (cx: number, cy: number, touch: boolean): TerritoryId | null => {
    if (!strokeSources.size) return null;
    const r = rectOf();
    const x = cx - r.left;
    const y = cy - r.top;
    const onPlaque = overlay.plaqueAt(x, y);
    if (onPlaque) return strokeSources.has(onPlaque) ? onPlaque : null;
    const exact = pick(cx, cy, false);
    if (exact && strokeSources.has(exact)) return exact;
    if (!touch) return null;
    const bp = boardPoint(cx, cy);
    const upp = bp ? unitsPerPx(bp[0], bp[1]) : 0;
    let best: TerritoryId | null = null;
    let bd = 12;
    for (const id of strokeSources) {
      const d = pxDistTo(id, x, y, bp, upp, bd);
      if (d <= bd) {
        bd = d;
        best = id;
      }
    }
    return best;
  };
  const strokeWorld = (cx: number, cy: number): THREE.Vector3 | null => {
    const bp = boardPoint(cx, cy);
    return bp ? toWorld(bp[0], bp[1], 0) : null;
  };
  // The live brush sound follows the stroke (INK B6 "brush"): speed 1 ≈ one board width per second.
  let strokeSnd: StrokeHandle | null = null;
  let strokeLast: { x: number; y: number; t: number } | null = null;
  const panAt = (cx: number) => clamp(((cx / Math.max(1, window.innerWidth)) * 2 - 1) * 0.6, -1, 1);
  const strokeStart = (cx: number, cy: number) => {
    if (!stroke) return;
    stroke.live = true;
    try {
      strokeSnd?.end(false);
      strokeSnd = audio?.stroke?.({ pan: panAt(cx) }) ?? null;
    } catch {
      strokeSnd = null;
    }
    strokeLast = { x: cx, y: cy, t: performance.now() };
    live.begin(tokens.feet(stroke.from));
    const w = strokeWorld(cx, cy);
    if (w) live.move(w);
    emitStroke(stroke.from, null, false);
  };
  const strokeMove = (cx: number, cy: number, touch: boolean) => {
    if (!stroke || !stroke.live) return;
    const w = strokeWorld(cx, cy);
    if (w) live.move(w);
    const r = rectOf();
    const now = performance.now();
    if (strokeSnd && strokeLast && now > strokeLast.t) {
      const px = Math.hypot(cx - strokeLast.x, cy - strokeLast.y);
      const speed = px / Math.max(1, r.width) / ((now - strokeLast.t) / 1000);
      try {
        strokeSnd.move(Math.min(4, speed), panAt(cx));
      } catch {
        /* sound never breaks the gesture */
      }
    }
    strokeLast = { x: cx, y: cy, t: now };
    const under = touch ? touchPick(cx, cy, stroke.targets) : (overlay.plaqueAt(cx - r.left, cy - r.top) ?? pick(cx, cy, false));
    const to = under && stroke.targets.has(under) ? under : null;
    if (to !== stroke.to) {
      if (stroke.to && stroke.to !== hovered) setHoverLook(stroke.to, false);
      stroke.to = to;
      if (to) setHoverLook(to, true);
      emitStroke(stroke.from, to, false);
    }
  };
  const strokeEnd = (cancelled: boolean) => {
    if (!stroke) return;
    const s0 = stroke;
    stroke = null;
    if (!s0.live) return;
    const to = cancelled ? null : s0.to;
    try {
      strokeSnd?.end(!!to);
    } catch {
      /* ignore */
    }
    strokeSnd = null;
    strokeLast = null;
    if (s0.to && s0.to !== hovered) setHoverLook(s0.to, false);
    if (to) strokeSettle = { key: `${s0.from}|${to}`, at: performance.now() };
    live.end(!!to);
    emitStroke(s0.from, to, true);
  };

  const onPointerDown = (e: PointerEvent) => {
    if (disposed) return;
    audio?.unlock?.();
    invalidate();
    noteInput();
    if (isTouch(e)) return onTouchDown(e);
    canvas.setPointerCapture?.(e.pointerId);
    const id = pick(e.clientX, e.clientY, true);
    down = { x: e.clientX, y: e.clientY, t: e.timeStamp, button: e.button, tile: id, id: e.pointerId };
    lastMove = { x: e.clientX, y: e.clientY };
    dragging = false;
    stroke = e.button === 0 ? strokeCandidate(strokeSourceAt(e.clientX, e.clientY, false)) : null;
    if (id && clickable.has(id) && (e.button === 0 || e.button === 2)) {
      pressed = id;
      const t = tiles.get(id);
      tw(t, 'press', t.press, -0.05 * LIFT_UNIT, 60, ease.outQuad);
    }
  };
  const releasePress = () => {
    if (!pressed) return;
    const t = tiles.get(pressed);
    tw(t, 'press', t.press, 0, 90, reduced ? ease.outCubic : ease.outBack(1.5));
    pressed = null;
  };
  const onPointerMove = (e: PointerEvent) => {
    if (disposed) return;
    invalidate();
    if (isTouch(e)) return onTouchMove(e);
    const r = rectOf();
    if (down) {
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      if (!dragging && moved > 6) {
        dragging = true;
        releasePress();
        if (hovered) setHovered(null, null);
        if (stroke) strokeStart(e.clientX, e.clientY);
        updateCursor();
      }
      if (dragging) {
        if (stroke) {
          strokeMove(e.clientX, e.clientY, false);
          return;
        }
        const dx = e.clientX - lastMove.x;
        const dy = e.clientY - lastMove.y;
        // Left / middle drag pans the flat board; right drag tilts and turns it a little (70–85°, ±10°).
        if (down.button === 2) rig.orbit(dx, dy);
        else rig.pan([lastMove.x - r.left, lastMove.y - r.top], [e.clientX - r.left, e.clientY - r.top]);
        lastMove = { x: e.clientX, y: e.clientY };
        return;
      }
    }
    const id = pick(e.clientX, e.clientY, true);
    setHovered(id, e);
    lastHoverEvent = e;
    if (id) for (const cb of hoverCbs) cb(pointerInfo(e, id, 0));
    else for (const cb of hoverCbs) cb(null);
  };
  const onPointerUp = (e: PointerEvent) => {
    if (disposed) return;
    invalidate();
    if (isTouch(e)) return onTouchUp(e, false);
    if (!down) return;
    const d = down;
    down = null;
    canvas.releasePointerCapture?.(e.pointerId);
    const wasDrag = dragging;
    dragging = false;
    releasePress();
    updateCursor();
    if (stroke) {
      const live0 = stroke.live;
      strokeEnd(false);
      if (live0) return;
    }
    if (wasDrag) {
      const id = pick(e.clientX, e.clientY, false);
      setHovered(id, e);
      return;
    }
    const dt = e.timeStamp - d.t; // event timestamps: a main-thread stall between press and release must not eat a real click
    const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
    if (dt > 350 || moved > 6) return;
    const id = pick(e.clientX, e.clientY, true);
    if (!id || id !== d.tile) return;
    const info = pointerInfo(e, id, d.button);
    for (const cb of clickCbs) {
      try {
        cb(info);
      } catch (err) {
        console.error(err);
      }
    }
  };
  const onPointerCancel = (e: PointerEvent) => {
    invalidate();
    if (isTouch(e)) return onTouchUp(e, true);
    strokeEnd(true);
    down = null;
    dragging = false;
    releasePress();
    updateCursor();
  };
  const onLeave = (e: PointerEvent) => {
    if (isTouch(e) || down) return;
    setHovered(null, null);
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    invalidate();
    noteInput();
    const r = rectOf();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    rig.zoomAt(e.clientX - r.left, e.clientY - r.top, clamp(dy, -240, 240));
  };

  // --- touch (docs/MOBILE.md §3) ------------------------------------------------------------
  // Tap = select (the click callback; a tap on open water picks the nearest selectable territory within
  // ~22 px). One finger drags = pan, two = pinch-zoom about their midpoint (momentum + soft limits);
  // no orbit, no double-tap zoom, and a drag never selects. Hold 400 ms = the name card
  // (onTerritoryLongPress; sliding the held finger moves it to the tile under it; lifting clears it).
  // A long-press never selects. The pressed tile shows its name (touch has no hover).
  const TOUCH_SLOP = 10;
  const TAP_TOLERANCE = 22;
  const LONG_PRESS_MS = 400;
  const isTouch = (e: PointerEvent) => e.pointerType === 'touch' || e.pointerType === 'pen';
  const touches = new Map<number, { x: number; y: number; x0: number; y0: number; t0: number }>();
  let tMode: 'none' | 'maybe' | 'pan' | 'pinch' | 'long' | 'stroke' | 'done' = 'none';
  let tPressed: TerritoryId | null = null;
  let tNamed: TerritoryId | null = null;
  let tLong: TerritoryId | null = null;
  let tTimer: ReturnType<typeof setTimeout> | null = null;
  let tPinch: { d: number; mx: number; my: number } | null = null;
  const longCbs: ((i: TerritoryPointerInfo | null) => void)[] = [];
  const emitLong = (info: TerritoryPointerInfo | null) => {
    for (const cb of longCbs) {
      try {
        cb(info);
      } catch (err) {
        console.error(err);
      }
    }
  };
  /** Distance (CSS px) from a canvas point to a territory: its tile outline or its piece, 0 inside. */
  const pxDistTo = (id: TerritoryId, x: number, y: number, bp: [number, number] | null, upp: number, max: number): number => {
    let d = Infinity;
    const b = overlay.pieceBox(id);
    if (b) {
      const hw = (b[2] - b[0]) * 0.5 * 0.8;
      const mx = (b[0] + b[2]) / 2;
      const dx = Math.max(mx - hw - x, 0, x - mx - hw);
      const dy = Math.max(b[1] + 2 - y, 0, y - b[3]);
      d = Math.hypot(dx, dy);
    }
    if (bp && upp > 0) {
      const t = tiles.get(id);
      const [x0, y0, x1, y1] = t.bbox;
      const bx = Math.max(x0 - bp[0], 0, bp[0] - x1);
      const by = Math.max(y0 - bp[1], 0, bp[1] - y1);
      if (Math.hypot(bx, by) / upp <= Math.min(d, max)) {
        for (const ring of t.rings) {
          if (pointInRing(bp[0], bp[1], ring)) return 0;
          d = Math.min(d, distToRing(bp[0], bp[1], ring) / upp);
        }
      }
    }
    return d;
  };
  /**
   * The territory a finger means: the tile or piece exactly under it; on open water, the nearest
   * `pool` territory (the selectable ones for a tap, any for the name card) within TAP_TOLERANCE px.
   */
  const touchPick = (cx: number, cy: number, pool: Iterable<TerritoryId>): TerritoryId | null => {
    const r0 = rectOf();
    // A number under the finger wins: it is drawn above every piece and tile (a neighbour's figure may
    // stand over it in 3D, e.g. Argentina's over Peru's plaque at the portrait zoom).
    const onPlaque = overlay.plaqueAt(cx - r0.left, cy - r0.top);
    if (onPlaque) return onPlaque;
    const exact = pick(cx, cy, false);
    if (exact) return exact;
    const r = rectOf();
    const x = cx - r.left;
    const y = cy - r.top;
    const bp = boardPoint(cx, cy);
    const upp = bp ? unitsPerPx(bp[0], bp[1]) : 0;
    let best: TerritoryId | null = null;
    let bd = TAP_TOLERANCE;
    for (const id of pool) {
      const d = pxDistTo(id, x, y, bp, upp, bd);
      if (d <= bd) {
        bd = d;
        best = id;
      }
    }
    return best;
  };
  /** Name shown under the finger (the overlay's hover name; the mouse's own hover is restored after). */
  const touchName = (id: TerritoryId | null) => {
    if (id === tNamed) return;
    tNamed = id;
    overlay.setHover(id ?? hovered);
  };
  const touchPress = (id: TerritoryId | null) => {
    if (tPressed === id) return;
    if (tPressed) {
      const t = tiles.get(tPressed);
      tw(t, 'press', t.press, 0, 90, reduced ? ease.outCubic : ease.outBack(1.5));
      setHoverLook(tPressed, false);
    }
    tPressed = id;
    if (id) {
      const t = tiles.get(id);
      // Same-frame feedback: the tile dips and brightens under the finger.
      tw(t, 'press', t.press, -0.05 * LIFT_UNIT, 60, ease.outQuad);
      const light = 1;
      if (Math.abs(t.light - light) > 1e-4) tw(t, 'light', t.light, light, 70);
    }
  };
  const clearTimer = () => {
    if (tTimer) clearTimeout(tTimer);
    tTimer = null;
  };
  const endLong = () => {
    if (!tLong) return;
    setHoverLook(tLong, false);
    tLong = null;
    emitLong(null);
  };
  const longInfo = (id: TerritoryId, x: number, y: number): TerritoryPointerInfo => ({
    territory: id,
    clientX: x,
    clientY: y,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    button: 0,
  });
  const showLong = (id: TerritoryId, x: number, y: number) => {
    if (tLong !== id) {
      if (tLong) setHoverLook(tLong, false);
      tLong = id;
      setHoverLook(id, true);
      touchName(id);
    }
    emitLong(longInfo(id, x, y));
  };
  const pinchOf = () => {
    const [a, b] = [...touches.values()];
    const r = rectOf();
    return { d: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)), mx: (a.x + b.x) / 2 - r.left, my: (a.y + b.y) / 2 - r.top };
  };
  const onTouchDown = (e: PointerEvent) => {
    canvas.setPointerCapture?.(e.pointerId);
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: e.timeStamp });
    if (touches.size === 1) {
      tMode = 'maybe';
      const id = touchPick(e.clientX, e.clientY, clickable);
      touchPress(id && clickable.has(id) ? id : null);
      touchName(id);
      // A drag that starts on an eligible source draws (not pans); only a tile exactly under the finger.
      stroke = strokeCandidate(strokeSourceAt(e.clientX, e.clientY, true));
      clearTimer();
      tTimer = setTimeout(() => {
        tTimer = null;
        if (disposed || tMode !== 'maybe' || touches.size !== 1) return;
        const p = [...touches.values()][0];
        const lid = touchPick(p.x, p.y, TERRITORY_IDS);
        if (!lid) return;
        tMode = 'long';
        stroke = null;
        touchPress(null);
        showLong(lid, p.x, p.y);
        invalidate();
      }, LONG_PRESS_MS);
      return;
    }
    // A second finger: pinch (never a tap, never a long-press, never a stroke).
    strokeEnd(true);
    clearTimer();
    touchPress(null);
    touchName(null);
    endLong();
    if (touches.size === 2) {
      tMode = 'pinch';
      rig.touchBegin();
      tPinch = pinchOf();
    }
  };
  const onTouchMove = (e: PointerEvent) => {
    const p = touches.get(e.pointerId);
    if (!p) return;
    const r = rectOf();
    const px = p.x;
    const py = p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (tMode === 'maybe') {
      if (Math.hypot(p.x - p.x0, p.y - p.y0) <= TOUCH_SLOP) return;
      clearTimer();
      touchPress(null);
      touchName(null);
      if (stroke) {
        tMode = 'stroke';
        strokeStart(p.x, p.y);
        return;
      }
      tMode = 'pan';
      rig.touchBegin();
      rig.touchPan([p.x0 - r.left, p.y0 - r.top], [p.x - r.left, p.y - r.top]);
      return;
    }
    if (tMode === 'pan') {
      rig.touchPan([px - r.left, py - r.top], [p.x - r.left, p.y - r.top]);
      return;
    }
    if (tMode === 'stroke') {
      strokeMove(p.x, p.y, true);
      return;
    }
    if (tMode === 'long') {
      // Scrub: the card follows the finger to the tile under it.
      const id = touchPick(p.x, p.y, TERRITORY_IDS);
      if (id) showLong(id, p.x, p.y);
      return;
    }
    if (tMode === 'pinch' && touches.size >= 2 && tPinch) {
      const n = pinchOf();
      rig.touchPan([tPinch.mx, tPinch.my], [n.mx, n.my]);
      rig.touchZoom(n.mx, n.my, n.d / tPinch.d);
      tPinch = n;
    }
  };
  const onTouchUp = (e: PointerEvent, cancelled: boolean) => {
    const p = touches.get(e.pointerId);
    if (!p) return;
    touches.delete(e.pointerId);
    canvas.releasePointerCapture?.(e.pointerId);
    if (tMode === 'pinch') {
      if (touches.size === 1) {
        // One finger stays: it carries on panning from where it is.
        tMode = 'pan';
        tPinch = null;
        return;
      }
      if (touches.size >= 2) {
        tPinch = pinchOf();
        return;
      }
    }
    if (touches.size > 0) return;
    if (pendingRecenter) {
      pendingRecenter = false;
      if (!rig.displaced && tMode !== 'pan' && tMode !== 'pinch') void rig.goHome();
    }
    const mode = tMode;
    tMode = 'none';
    tPinch = null;
    clearTimer();
    touchPress(null);
    touchName(null);
    if (mode === 'stroke') {
      strokeEnd(cancelled);
      return;
    }
    stroke = null;
    if (mode === 'long') endLong();
    if (mode === 'pan' || mode === 'pinch') {
      if (cancelled) rig.touchCancel();
      else rig.touchEnd();
      return;
    }
    if (mode !== 'maybe' || cancelled) return;
    if (e.timeStamp - p.t0 >= LONG_PRESS_MS || Math.hypot(e.clientX - p.x0, e.clientY - p.y0) > TOUCH_SLOP) return;
    const id = touchPick(e.clientX, e.clientY, clickable);
    if (!id) return;
    const info = pointerInfo(e, id, 0);
    for (const cb of clickCbs) {
      try {
        cb(info);
      } catch (err) {
        console.error(err);
      }
    }
  };
  // Safari's own pinch gesture events: never let the page zoom under the board.
  const onGesture = (e: Event) => e.preventDefault();

  const onContext = (e: Event) => e.preventDefault();
  const bindCanvas = (c: HTMLCanvasElement) => {
    c.addEventListener('pointerdown', onPointerDown);
    c.addEventListener('pointermove', onPointerMove);
    c.addEventListener('pointerup', onPointerUp);
    c.addEventListener('pointercancel', onPointerCancel);
    c.addEventListener('pointerleave', onLeave);
    c.addEventListener('wheel', onWheel, { passive: false });
    c.addEventListener('contextmenu', onContext);
    c.addEventListener('gesturestart', onGesture);
    c.addEventListener('gesturechange', onGesture);
    c.addEventListener('webglcontextlost', onContextLost, false);
    c.addEventListener('webglcontextrestored', onContextRestored, false);
  };
  const unbindCanvas = (c: HTMLCanvasElement) => {
    c.removeEventListener('pointerdown', onPointerDown);
    c.removeEventListener('pointermove', onPointerMove);
    c.removeEventListener('pointerup', onPointerUp);
    c.removeEventListener('pointercancel', onPointerCancel);
    c.removeEventListener('pointerleave', onLeave);
    c.removeEventListener('wheel', onWheel);
    c.removeEventListener('contextmenu', onContext);
    c.removeEventListener('gesturestart', onGesture);
    c.removeEventListener('gesturechange', onGesture);
    c.removeEventListener('webglcontextlost', onContextLost, false);
    c.removeEventListener('webglcontextrestored', onContextRestored, false);
  };
  bindCanvas(canvas);
  container.addEventListener('contextmenu', onContext);

  // --- camera helpers ------------------------------------------------------------------
  const camWaiters: { resolve: () => void; run: Run | null }[] = [];
  const waitCamera = (run: Run | null): Promise<void> => {
    if (rig.autoProgress >= 0.8 || (run && run.skipped)) return Promise.resolve();
    return new Promise((resolve) => camWaiters.push({ resolve, run }));
  };
  const cutTo = (pose: import('./camera').Pose) => {
    rig.jump(pose);
    overlay.cut.style.transition = 'none';
    overlay.cut.style.opacity = '1';
    requestAnimationFrame(() => {
      overlay.cut.style.transition = 'opacity 200ms ease-out';
      overlay.cut.style.opacity = '0';
    });
  };
  const projTmp = new THREE.Vector3();
  /**
   * Landscape phones: the home view already shows every piece clear of the HUD, the free band is short,
   * and a zoom pushes the pieces around the fight under the seat chips and the dock. There the camera
   * frames a fight only when one of its pieces is actually hidden, and keeps both whole pieces (figure
   * top to plaque) clear of the HUD when it does.
   */
  const phoneLand = () => compact && W > H;
  const pieceIndex = new Map(TERRITORY_IDS.map((id, i) => [id, i]));
  const extentsOf = (ids: TerritoryId[]): number[][] | undefined => {
    const all = rig.pieceExtents;
    if (!all) return undefined;
    return ids.flatMap((id) => {
      const i = pieceIndex.get(id);
      return i === undefined ? [] : all.slice(i * 4, i * 4 + 4);
    });
  };
  const needsFraming = (from: TerritoryId, to: TerritoryId): boolean => {
    if (phoneLand()) {
      const ext = extentsOf([from, to]);
      if (ext) return !rig.piecesClear(ext);
    }
    const { x0, y0, x1, y1 } = rig.region();
    for (const id of [from, to]) {
      const t = tiles.get(id);
      projTmp.copy(t.anchorW).project(camera);
      const px = (projTmp.x * 0.5 + 0.5) * W;
      const py = (-projTmp.y * 0.5 + 0.5) * H;
      if (projTmp.z > 1 || px < x0 + 8 || px > x1 - 8 || py < y0 + 8 || py > y1 - 8) return true;
    }
    const t = tiles.get(to);
    const a = toWorld(t.bbox[0], (t.bbox[1] + t.bbox[3]) / 2, TILE_TOP).project(camera);
    const b = toWorld(t.bbox[2], (t.bbox[1] + t.bbox[3]) / 2, TILE_TOP).project(camera);
    return Math.abs(b.x - a.x) * 0.5 * W < 24;
  };
  const frameEngagement = async (from: TerritoryId, to: TerritoryId, run: Run | null) => {
    const pts = [tiles.get(from).anchorW, tiles.get(to).anchorW];
    const t = tiles.get(to);
    const widthUnits = t.bbox[2] - t.bbox[0];
    // zoom so the target is at least ~40 px wide
    const pxPerUnitHome = W / (G.width * 1.1);
    const minZoom = clamp(40 / Math.max(1, widthUnits * pxPerUnitHome), 1, 1.8);
    // Frame a region, not a close-up: the room still needs context around the fight.
    const pose = rig.framePose(pts, minZoom, 1.7, phoneLand() ? extentsOf([from, to]) : undefined);
    if (reduced || anim.instant) {
      cutTo(pose);
      return;
    }
    void rig.moveTo(pose);
    await waitCamera(run);
  };

  // --- placement batching (same-frame bursts stagger 35–50 ms, ≤ 1.2 s spread) ----------
  const placeQueue: { id: TerritoryId; count: number; source: string; vol: number; run: Run }[] = [];
  const flushPlacements = () => {
    if (!placeQueue.length) return;
    const list = placeQueue.splice(0);
    const n = list.length;
    const stagger = n > 1 ? Math.min(50, 1200 / (n - 1)) : 0;
    list.forEach((p, i) => {
      const go = () => {
        if (p.count > 0) {
          // The token hops (or drops in, on an empty tile); dust, pop and sound land on touchdown.
          tokens.setArmies(p.id, armies[p.id], 'drop');
          if (anim.instant) refreshBadge(p.id, false);
        } else {
          tokens.setArmies(p.id, armies[p.id], 'lift', null, null, { unplace: true });
          overlay.pop(p.id);
          sfx('unplace', { volume: p.vol, pan: panOf(p.id) });
        }
      };
      if (i === 0 || anim.instant) go();
      else void anim.wait(stagger * i, null, true).then(go);
    });
  };
  tokens.onContact = (id) => {
    tokens.pop(id, 0.1);
    playPlace(id, (isHuman(owners[id]) ? 1 : 0.5) * (anim.instant ? 0.8 : 1));
  };

  // --- ink floods (conquest, the deal, elimination) ---------------------------------------------------
  /**
   * A new wash soaks into `to` from `origin` (board coords) behind an fbm-perturbed front with a dark, wet
   * leading rim; no ghost of the old wash is left (docs/INK.md A3). `torn`: a human's territory falling —
   * the rim is rough and darker, like torn paper (A5). `dir`: a straight front travelling along `dir`
   * (the elimination sweep) instead of a radial one. Resolves when the tile shows the new owner.
   */
  const floodInk = (
    to: TerritoryId,
    origin: [number, number],
    owner: PlayerId,
    ms: number,
    run: Run | null,
    o: { torn?: boolean; dir?: [number, number]; color?: RGB; ease?: (t: number) => number } = {},
  ): Promise<void> => {
    const t = tiles.get(to);
    const toRgb = washRgb(lastState, owner);
    const u = t.uniforms;
    // A flood still soaking (the conquest's, when the elimination sweep follows it): land it first, so the
    // new one runs over the colour that was arriving, never back over the old owner's.
    if (u.uFloodOn.value > 0.5) {
      const c = u.uFloodColor.value;
      t.rgb = [c.x, c.y, c.z];
      u.uFloodOn.value = 0;
      t.dirty = true;
    }
    const ver = (t.ver.flood = (t.ver.flood ?? 0) + 1);
    const done = () => {
      if (t.ver.flood !== ver) return;
      u.uFloodOn.value = 0;
      // A drift-correcting syncState may have moved on; always land on the displayed owner.
      t.rgb = owners[to] === owner ? (o.color ?? toRgb) : washRgb(lastState, owners[to]);
      t.dirty = true;
    };
    if (anim.instant || (run && run.skipped)) {
      done();
      return Promise.resolve();
    }
    const fc = o.color ?? toRgb;
    if (reduced) {
      // Reduced motion: a 250 ms crossfade.
      u.uFloodOn.value = 0;
      const fromRgb = t.rgb;
      return anim.tween({
        ms: 250,
        ease: ease.inOutQuad,
        run,
        update: (v) => {
          if (t.ver.flood !== ver) return;
          t.rgb = [fromRgb[0] + (fc[0] - fromRgb[0]) * v, fromRgb[1] + (fc[1] - fromRgb[1]) * v, fromRgb[2] + (fc[2] - fromRgb[2]) * v];
          t.dirty = true;
        },
        done,
      });
    }
    u.uFloodOrigin.value.set(origin[0], origin[1]);
    u.uFloodColor.value.set(fc[0], fc[1], fc[2]);
    const dp = deepOf(fc);
    const torn = !!o.torn;
    u.uFloodDeep.value.set(dp[0] * (torn ? 0.8 : 1), dp[1] * (torn ? 0.8 : 1), dp[2] * (torn ? 0.8 : 1));
    u.uFloodTorn.value = torn ? 1 : 0;
    u.uFloodMode.value = o.dir ? 1 : 0;
    if (o.dir) u.uFloodDir.value.set(o.dir[0], o.dir[1]).normalize();
    u.uFloodSeed.value = Math.random() * 10;
    let maxD = 0;
    const dx = o.dir ? u.uFloodDir.value.x : 0;
    const dy = o.dir ? u.uFloodDir.value.y : 0;
    for (const ring of t.rings)
      for (const [x, y] of ring) maxD = Math.max(maxD, o.dir ? (x - origin[0]) * dx + (y - origin[1]) * dy : Math.hypot(x - origin[0], y - origin[1]));
    // the perturbed front runs ±15 % and ragged: overshoot so the last corner soaks too
    const reach = maxD * 1.22 + 1.1;
    u.uFloodR.value = 0;
    u.uFloodOn.value = 1;
    return anim.tween({
      ms,
      ease: o.ease ?? ease.inOutCubic,
      run,
      update: (v) => {
        if (t.ver.flood !== ver) return;
        u.uFloodR.value = v * reach;
      },
      done,
    });
  };
  const flood = (from: TerritoryId, to: TerritoryId, owner: PlayerId, ms: number, run: Run | null, torn = false): Promise<void> => {
    const ep = tiles.entryPoint(from, to);
    return floodInk(to, [ep[0], ep[1]], owner, ms, run, { torn });
  };

  /**
   * The deal and the draft's claims: the owner's wash blooms out from the territory's centre (≈ 320 ms),
   * the number arriving as it starts.
   */
  const bloom = (id: TerritoryId, owner: PlayerId, delay: number, run: Run | null, vol: number): Promise<void> => {
    const t = tiles.get(id);
    const start = () => {
      owners[id] = owner;
      tokens.setColor(id, tileRgb(lastState, owner));
      if (armies[id] < 1) armies[id] = 1;
      tokens.setArmies(id, armies[id], 'snap');
      refreshBadge(id, true);
      if (vol > 0) sfx('place', { volume: 0.35 * vol, pan: panOf(id) });
    };
    if (anim.instant || (run && run.skipped)) {
      start();
      setOwnerLook(id, owner);
      return Promise.resolve();
    }
    return anim.wait(delay, run).then(() => {
      start();
      return floodInk(id, [t.anchor[0], t.anchor[1]], owner, 320, run, { ease: ease.outCubic });
    });
  };

  /**
   * Elimination (docs/INK.md A5): the eliminator's ink sweeps over the victim's last territory — a straight,
   * torn front from the attacker's side, deeper than the wash, that then settles to the wash. ≈ 1.3 s.
   */
  const elimSweep = async (id: TerritoryId | null, from: TerritoryId | null, by: PlayerId, run: Run | null, torn = true): Promise<void> => {
    if (!id || by < 0 || !lastState?.players[by]) {
      await anim.wait(700, run);
      return;
    }
    const t = tiles.get(id);
    const a = from ? tiles.get(from).anchor : ([t.anchor[0] - 1, t.anchor[1]] as [number, number]);
    let dx = t.anchor[0] - a[0];
    let dy = t.anchor[1] - a[1];
    const dl = Math.hypot(dx, dy) || 1;
    dx /= dl;
    dy /= dl;
    // start behind the tile's back edge (as seen along the sweep)
    let back = Infinity;
    for (const ring of t.rings) for (const [x, y] of ring) back = Math.min(back, (x - t.anchor[0]) * dx + (y - t.anchor[1]) * dy);
    const origin: [number, number] = [t.anchor[0] + dx * (back - 0.3), t.anchor[1] + dy * (back - 0.3)];
    const wash = washRgb(lastState, by);
    const deep = mixRgb(wash, deepOf(wash), 0.7);
    await floodInk(id, origin, by, 900, run, { torn, dir: [dx, dy], color: deep, ease: ease.inOutSine });
    if (anim.instant || (run && run.skipped)) {
      t.rgb = owners[id] === by ? wash : washRgb(lastState, owners[id]);
      t.dirty = true;
      return;
    }
    // the deep ink settles into the ordinary wash (not blocking the queue past the beat)
    void tw(t, 'settle', 0, 1, 520, ease.inOutSine, (v) => {
      t.rgb = owners[id] === by ? mixRgb(deep, wash, v) : washRgb(lastState, owners[id]);
    });
    await anim.wait(380, run);
  };

  /**
   * Victory: every other wash dries back to paper, staggered by distance from the winner's heart (their
   * territories' centre); the winner's ink stays. ≈ 1.2 s.
   */
  const victoryDry = (winner: PlayerId, run: Run | null): Promise<void> => {
    const mine = TERRITORY_IDS.filter((id) => owners[id] === winner);
    let cx = G.width / 2;
    let cy = G.height / 2;
    if (mine.length) {
      cx = mine.reduce((acc, id) => acc + tiles.get(id).anchor[0], 0) / mine.length;
      cy = mine.reduce((acc, id) => acc + tiles.get(id).anchor[1], 0) / mine.length;
    }
    const others = tiles.list.filter((t) => owners[t.id] !== winner);
    if (anim.instant || (run && run.skipped)) {
      for (const t of others) {
        t.dry = 1;
        t.dirty = true;
      }
      return Promise.resolve();
    }
    let maxD = 1;
    const dist = others.map((t) => {
      const d = Math.hypot(t.anchor[0] - cx, t.anchor[1] - cy);
      maxD = Math.max(maxD, d);
      return d;
    });
    return Promise.all(
      others.map((t, i) => {
        const delay = reduced ? 0 : 600 * (dist[i] / maxD);
        return anim.wait(delay, run).then(() => tw(t, 'dry', t.dry, 0.85, reduced ? 250 : 600, ease.inOutSine, undefined, run));
      }),
    ).then(() => undefined);
  };

  // [board-pieces v4] loser rings (A4) and the receipt pulse (A3): rings in the loser's pigment on the stones;
  // a pulse swells each listed stone once (tier 0, tokens.PULSE_MS) and lifts its wash for the same beat.
  let lastPulseKey = '';
  const applyPieceMarks = (h: BoardHighlights, _prev: BoardHighlights) => {
    tokens.setRings((h.loserRings ?? []).map((r) => ({ id: r.territory, rgb: hexToRgb((PLAYER_COLORS[r.color] ?? PLAYER_COLORS.neutral).base) })));
    const key = (h.pulse ?? []).join(',');
    if (key === lastPulseKey) return;
    lastPulseKey = key;
    for (const id of h.pulse ?? []) {
      tokens.pulse(id);
      const t = tiles.get(id);
      if (!t || anim.instant || reduced) continue;
      const ver = (t.ver.flash = (t.ver.flash ?? 0) + 1);
      void anim.tween({
        ms: PULSE_MS,
        ease: ease.linear,
        update: (v) => {
          if (t.ver.flash !== ver) return;
          t.flash = 0.8 * Math.sin(v * Math.PI);
          t.dirty = true;
        },
        done: () => {
          if (t.ver.flash !== ver) return;
          t.flash = 0;
          t.dirty = true;
        },
      });
    }
  };

  // [board-pieces v4] the ring beside the fight (desktop; phones keep the band): try below, above, right and
  // left of the attacker → defender midpoint, far enough out to clear both pieces, and take the spot whose
  // dice cover the fewest pieces (stone, figure, numeral) and stay inside the HUD's insets.
  const placeTrayNearFight = (from: TerritoryId, to: TerritoryId) => {
    if (compact) {
      tray.moveTo(null);
      return;
    }
    const a = overlay.pieceBox(from);
    const b = overlay.pieceBox(to);
    if (!a || !b) {
      tray.moveTo(null);
      return;
    }
    const mx = (a[0] + a[2] + b[0] + b[2]) / 4;
    const my = (a[1] + a[3] + b[1] + b[3]) / 4;
    const x0 = Math.min(a[0], b[0]);
    const x1 = Math.max(a[2], b[2]);
    const y0 = Math.min(a[1], b[1]);
    const y1 = Math.max(a[3], b[3]);
    const hw = tray.trayW / 2;
    const hh = tray.trayH / 2;
    const gap = 10;
    const cands: [number, number][] = [
      [mx, y1 + gap + hh],
      [mx, y0 - gap - hh],
      [x1 + gap + hw, my],
      [x0 - gap - hw, my],
      [mx, y1 + gap + hh + 40],
      [mx, y0 - gap - hh - 40],
    ];
    const boxes = TERRITORY_IDS.map((id) => overlay.pieceBox(id)).filter((p): p is [number, number, number, number] => !!p);
    const top = Math.max(insets.top, ...(insets.rects ?? []).filter((q) => q.y < H / 3).map((q) => q.y + q.h)) + 10;
    const bot = H - insets.bottom - 8;
    let best: [number, number] | null = null;
    let bestScore = Infinity;
    for (const [cx0, cy0] of cands) {
      // (the dice sit in the middle of the ring: score the ring's inner box)
      const cx = clamp(cx0, hw + 8, W - hw - 8);
      const cy = clamp(cy0, top + hh, bot - hh);
      const r = [cx - hw * 0.8, cy - hh * 0.8, cx + hw * 0.8, cy + hh * 0.8];
      let score = 0;
      for (const p of boxes) if (p[0] < r[2] && p[2] > r[0] && p[1] < r[3] && p[3] > r[1]) score += 1;
      // (the fight itself must stay in sight: a spot over either fighter is the worst)
      for (const p of [a, b]) if (p[0] < r[2] && p[2] > r[0] && p[1] < r[3] && p[3] > r[1]) score += 100;
      score += Math.hypot(cx - cx0, cy - cy0) / 400;
      if (score < bestScore) {
        bestScore = score;
        best = [cx, cy];
      }
    }
    tray.moveTo(best ? { x: best[0], y: best[1] } : null);
  };

  // --- losses at a verdict ---------------------------------------------------------------------
  const applyLosses = (e: Extract<GameEvent, { type: 'diceRolled' }>, fromN: number, toN: number, gen: number, chips: boolean) => {
    if (gen !== syncGen) return;
    armies[e.from] = fromN;
    armies[e.to] = toN;
    if (e.attackerLosses > 0) {
      tokens.setArmies(e.from, fromN, 'hit', null, e.to);
      refreshBadge(e.from, true);
      if (chips) overlay.lossChip(e.from, e.attackerLosses, -1);
      const t = tiles.get(e.from);
      hitFlash(t);
    }
    if (e.defenderLosses > 0) {
      // Emptied: the top disc slides off; if this was the seat's last territory, its last stack topples and
      // dissolves disc by disc (PLAN §1 "elimination"), inside the elimination's own sweep.
      const last = toN <= 0 && !TERRITORY_IDS.some((t) => t !== e.to && owners[t] === e.defender) && !!lastState?.players[e.defender]?.eliminated;
      tokens.setArmies(e.to, toN, 'hit', null, e.from, { topple: last });
      refreshBadge(e.to, true);
      if (chips) overlay.lossChip(e.to, e.defenderLosses, 1);
      hitFlash(tiles.get(e.to));
    }
    if (toN <= 0) overlay.hideBadge(e.to);
  };
  const hitFlash = (t: Tile) => {
    t.flashColor = IVORY_RGB;
    if (anim.instant) return;
    const ver = (t.ver.flash = (t.ver.flash ?? 0) + 1);
    void anim.tween({
      ms: 260,
      ease: ease.linear,
      update: (v) => {
        if (t.ver.flash !== ver) return;
        t.flash = Math.sin(v * Math.PI) * (1 - v * 0.3);
        t.dirty = true;
      },
      done: () => {
        if (t.ver.flash === ver) {
          t.flash = 0;
          t.dirty = true;
        }
      },
    });
  };

  // --- event playback ----------------------------------------------------------------------------
  const ensureColors = (s: GameState) => {
    const key = s.players.map((p) => p.color).join(',');
    if (key !== colorKey) {
      colorKey = key;
      for (const id of TERRITORY_IDS) {
        setOwnerLook(id, owners[id]);
        refreshBadge(id, false);
      }
      continents.invalidate();
    }
  };

  async function handle(e: GameEvent, s: GameState, o: PlayEventOptions, run: Run): Promise<void> {
    const gen = syncGen;
    const style = o.style ?? 'full';
    switch (e.type) {
      case 'phaseChanged': {
        // The fighting is over for this turn: an engagement's arrow dries now, inside the turn that drew
        // it, so the next player's turn never opens with the last player's stroke on the board (INK F6).
        if (e.phase !== 'attack' && arrowSource === 'event') {
          arrow.hide();
          arrowSource = null;
        }
        return;
      }
      case 'gameStarted':
      case 'setupTurn':
      case 'cardDrawn':
      case 'cardsCaptured':
      case 'controllerChanged':
      case 'cardsTraded':
        return;

      case 'territoriesDealt': {
        const ids = TERRITORY_IDS.filter((t) => e.owners[t] !== undefined);
        ids.sort((a, b) => tiles.get(a).anchor[0] - tiles.get(b).anchor[0]);
        const stagger = ids.length > 1 ? Math.min(35, 1200 / (ids.length - 1)) : 0;
        await Promise.all(ids.map((id, i) => bloom(id, e.owners[id], i * stagger, run, i % 3 === 0 ? 1 : 0)));
        continents.refresh(owners, lastState, false);
        return;
      }

      case 'territoryClaimed': {
        void bloom(e.territory, e.player, 0, null, 1).then(() => continents.refresh(owners, lastState, false));
        return;
      }

      case 'armiesPlaced': {
        const id = e.territory;
        if (owners[id] !== e.player) {
          owners[id] = e.player;
          setOwnerLook(id, e.player);
        }
        armies[id] = Math.max(0, armies[id] + e.count);
        refreshBadge(id, false);
        placeQueue.push({ id, count: e.count, source: e.source, vol: isHuman(e.player) ? 1 : 0.5, run });
        return;
      }

      case 'turnStarted': {
        clearPhase();
        turnBreath();
        if (arrowSource === 'event') {
          arrow.hide();
          arrowSource = null;
        }
        if (rig.mode === 'fill') {
          // Portrait phones: home centres on the new player's territories; the view eases there only if the
          // player hasn't moved it (and never under a finger: then it waits for the lift).
          setFocusFor(e.player);
          rig.retarget();
          if (autoCamera && !rig.attract && !rig.displaced && !rig.isHome(0.01)) {
            if (touches.size > 0 || down) pendingRecenter = true;
            else if (reduced || anim.instant) cutTo({ ...rig.home });
            else {
              void rig.goHome();
              await waitCamera(run);
            }
          }
          return;
        }
        if (autoCamera && !rig.attract && !rig.isHome(0.1)) {
          if (reduced || anim.instant) cutTo({ ...rig.home });
          else {
            void rig.goHome();
            await waitCamera(run);
          }
        }
        return;
      }

      case 'diceRolled': {
        const idx = o.seq?.index ?? 0;
        const count = o.seq?.count ?? 1;
        if (idx === 0) blitzT0 = performance.now();
        const fromN = Math.max(1, armies[e.from] - e.attackerLosses);
        const toN = Math.max(0, armies[e.to] - e.defenderLosses);
        const vol = isHuman(e.player) || isHuman(e.defender) ? 1 : 0.5;
        const aPal = pal(e.player) ?? PLAYER_COLORS.crimson;
        const dPal = pal(e.defender) ?? PLAYER_COLORS.cobalt;
        const key = `${e.from}>${e.to}`;
        if (idx === 0 && isAi(e.player)) {
          if (rig.autoProgress < 1) await waitCamera(run);
          else if (needsFraming(e.from, e.to)) await frameEngagement(e.from, e.to, run);
        }
        const hlMatches = lastHl.arrow?.kind === 'attack' && lastHl.arrow.from === e.from && lastHl.arrow.to === e.to;
        if (!hlMatches && (arrow.key !== key || !arrow.group.visible)) {
          arrowSource = 'event';
          arrow.ink(true, 0);
          // [board-pieces v4] the readable beat's stroke draws in ≈ 300 ms
          const p = arrow.show(e.from, e.to, tileRgb(lastState, owners[e.from]), run, style === 'brief' ? 150 : style === 'readable' ? READABLE.STROKE : 240);
          if (idx === 0) await p;
        } else if (idx === 0) arrow.ink(true, 120); // the dice decide: the arrow inks gold (the HUD steps down)
        const last = idx >= count - 1;
        if (style === 'readable') {
          // [board-pieces v4] the readable beat (PLAN §8a Q7): no dice tray, ever. One short bone click stands in
          // for the roll; each roll's casualties tick on the loser's stone inside one shared, compressed window
          // (READABLE.TICKS for the whole engagement); a stopped attack ends on the attacker's recoil.
          if (tray.visible) tray.hide(120);
          if (idx === 0) {
            readableBeat = { key, t0: blitzT0, conquered: false };
            tokens.face(e.from, e.to);
            tokens.face(e.to, e.from);
            sfx('diceLand', { volume: 0.6 * vol, pan: panOf(e.to) });
          }
          if (e.defenderLosses > 0 || e.attackerLosses > 0) sfx('hit', { volume: (idx === 0 ? 0.55 : 0.3) * vol, pan: panOf(e.defenderLosses >= e.attackerLosses ? e.to : e.from) });
          applyLosses(e, fromN, toN, gen, false);
          await anim.wait(Math.max(16, READABLE.TICKS / Math.max(1, count)), run);
          if (last && toN > 0) {
            // the attack stops: the attacker's figure breathes out a little ink and the stroke dries
            tokens.puff(e.from, READABLE.RECOIL, run);
            arrow.ink(false, 200);
            await anim.wait(READABLE.RECOIL, run);
            if (arrowSource === 'event') {
              arrow.hide();
              arrowSource = null;
            }
            closeReadable(key);
          }
          return;
        }
        if (style === 'brief') {
          tray.hide(120);
          if (idx === 0) {
            tokens.face(e.from, e.to);
            tokens.face(e.to, e.from);
          }
          // arrow 150 + hit ticks ≤ 350 + flip/march 300 ≤ 0.8 s per engagement
          const tick = 350 / Math.max(1, count);
          if (idx === 0 && (e.defenderLosses > 0 || e.attackerLosses > 0)) sfx('hit', { volume: 0.45 * vol, pan: panOf(e.to) });
          applyLosses(e, fromN, toN, gen, false);
          await anim.wait(tick, run);
          if (last) arrow.ink(false, 200);
          if (last && toN > 0 && arrowSource === 'event') {
            arrow.hide();
            arrowSource = null;
          }
          return;
        }
        // full: the battle tray. The two figures face each other; the attacker leans in while the dice roll.
        // The ring brushes on and the rest of the board recedes with it (INK2 §2.2 t = 0).
        // [board-pieces v4] desktop: the ring lands beside the fight, clear of every stone and numeral
        if (idx === 0 && !tray.showing) placeTrayNearFight(e.from, e.to);
        recede([e.from, e.to], 180);
        tokens.lean(e.from, e.to, true);
        rolling++;
        try {
          let mode: 'single' | 'repeat' | 'first' | 'middle' | 'final';
          const now = performance.now();
          if (count <= 1) mode = lastPairKey === key && now - lastRollEnd < 3000 ? 'repeat' : 'single';
          else mode = idx === 0 ? 'first' : last ? 'final' : 'middle';
          let hitPlayed = false;
          await tray.roll({
            attack: e.attackDice,
            defend: e.defendDice,
            attacker: aPal,
            defender: dPal,
            mode,
            durMs: mode === 'middle' ? blitzMidMs(idx, count) : undefined,
            reduced,
            run,
            onShake: (ms) => sfx('diceShake', { duration: Math.max(0.06, ms / 1000), volume: vol }),
            onLand: (side, i) => {
              if (mode === 'middle' || (reduced && i === 0)) {
                sfx('diceLand', { volume: vol, rate: Math.min(1.4, 1 + 0.08 * idx) });
              } else sfx('diceLand', { volume: vol, pan: side * 0.3, rate: count > 1 ? Math.min(1.4, 1 + 0.08 * idx) : 1 });
            },
            // The verdict beat (A6/B4): nothing new sounds while the dice sit still, and the score dips.
            // A hair shorter than the beat so the verdict's own 'hit' is never the thing it swallows.
            onSilence: (ms) => audio?.hush?.(Math.max(0, ms - 30)),
            onVerdict: () => {
              if (!hitPlayed) {
                hitPlayed = true;
                const loserSide = e.defenderLosses >= e.attackerLosses ? 0.3 : -0.3;
                sfx('hit', { volume: (mode === 'middle' ? 0.5 : 1) * vol, pan: loserSide });
              }
              applyLosses(e, fromN, toN, gen, mode !== 'middle' || count <= 6);
              // The losing figure puffs (INK2 §2.2): each side that lost a die and still stands breathes
              // out a little ink over the verdict beat (a defender at 0 starts its full dissolve instead).
              if (gen === syncGen && (mode !== 'middle' || count <= 6)) {
                const pm = mode === 'middle' ? 160 : mode === 'first' ? 200 : mode === 'final' ? 220 : 260;
                if (e.attackerLosses > 0 && fromN > 0) tokens.puff(e.from, pm, run);
                if (e.defenderLosses > 0 && toN > 0) tokens.puff(e.to, pm, run);
              }
            },
          });
        } finally {
          rolling--;
          if (last || count <= 1) tokens.lean(e.from, e.to, false);
        }
        lastPairKey = key;
        lastRollEnd = performance.now();
        // Decided: the gold leaves the board (Roll / Move / the track takes it back).
        if (last) arrow.ink(false, 240);
        if (last) {
          // A decided fight (captured, or the attacker can't go on) fades ~1 s after the verdict; an
          // undecided single roll keeps the tray for the next roll.
          const decided = toN <= 0 || fromN <= 1 || count > 1;
          tray.linger(decided ? TRAY_DECIDED_MS : 2500, performance.now());
          if (toN > 0 && arrowSource === 'event') {
            arrow.hide();
            arrowSource = null;
          }
        } else tray.lingerUntil = 0;
        return;
      }

      case 'territoryConquered': {
        const to = e.to;
        lastConquered = to;
        lastConquestFrom = e.from;
        lastConquestAt = performance.now();
        const prevOwner = e.previousOwner;
        owners[to] = e.player;
        armies[to] = 0;
        overlay.hideBadge(to);
        tokens.setArmies(to, 0, 'out', null, e.from);
        tokens.setColor(to, tileRgb(lastState, e.player));
        // A5: a human's territory falling is the sting (the dry brush snap), whoever took it.
        const somber = o.sting ?? isHuman(prevOwner);
        sfx('conquer', { volume: isHuman(e.player) || isHuman(prevOwner) ? 1 : 0.5, pan: panOf(to), variant: somber ? 'somber' : undefined });
        // [board-pieces v4] the readable beat's verdict flood (650) and the tier band, when the controller sends one
        const ms = tierMs(style === 'brief' ? 250 : style === 'readable' ? READABLE.FLOOD : 600, o.tier);
        noteMotion(ms);
        if (style === 'readable' && readableBeat) readableBeat.conquered = true;
        // A human's territory falling: the rim tears (docs/INK.md A5).
        const torn = (o.sting ?? isHuman(prevOwner)) && style !== 'brief';
        const f = flood(e.from, to, e.player, ms, null, torn).then(() => {
          if (gen === syncGen) continents.refresh(owners, lastState, false);
        });
        // The march starts +150 ms into the flood (full) / +100 ms into the flip (brief); the rest of
        // the color change keeps running while the token moves.
        void f;
        await anim.wait(style === 'brief' ? 100 : style === 'readable' ? READABLE.CONQUER_WAIT : 150, run);
        return;
      }

      case 'armiesMoved': {
        const { from, to, count } = e;
        const color = tileRgb(lastState, e.player);
        const vol = isHuman(e.player) ? 1 : 0.5;
        const fromN = Math.max(0, armies[from] - count);
        const toN = armies[to] + count;
        let ms: number;
        let via: TerritoryId[] = [];
        if (e.reason === 'fortify') {
          const path = e.path && e.path.length >= 2 ? e.path : [from, to];
          const hops = path.length - 1;
          ms = Math.min(900, 220 * hops);
          via = path.slice(1, -1);
          if (via.length > 4) via = via.filter((_, i) => i % Math.ceil(via.length / 4) === 0);
        } else {
          // inlineMarch = the conquest's own march (AI occupy / auto-occupy): 500 ms from +150.
          // A manual occupy count after a pause is a 400 ms move.
          const inline = o.inlineMarch ?? (lastConquered === to && performance.now() - lastConquestAt < 1500);
          ms = style === 'brief' ? 200 : style === 'readable' ? READABLE.MARCH : inline ? 500 : 400;
        }
        // [board-pieces v4] the tier band, when the controller sends one
        ms = tierMs(ms, o.tier);
        noteMotion(ms);
        // the count is chosen: its ghost goes as the real stack sets off
        if (countPreview) {
          countPreview = null;
          pushPreview(lastHl);
        }
        // lift-off
        armies[from] = fromN;
        tokens.setArmies(from, fromN, 'lift', run);
        refreshBadge(from, false);
        sfx('march', { volume: vol, duration: anim.scale(ms) / 1000, pan: panOf(from) });
        if (!owners[to] || owners[to] !== e.player) {
          owners[to] = e.player;
          setOwnerLook(to, e.player);
        }
        // A figure carrying the count walks there — the conquest walks the arrow (whose tail dries behind it),
        // a fortify its dotted route (drawn just ahead, drying behind); the number updates on arrival.
        const ink = pal(e.player)?.ink ?? IVORY;
        const walkEase = via.length ? ease.inOutSine : ease.inOutQuad;
        if (e.reason === 'fortify') {
          const path = e.path && e.path.length >= 2 ? e.path : [from, to];
          void route.walk(path, ms, run, walkEase);
        } else if (arrow.key === `${from}|${to}` && arrow.group.visible) {
          void anim.tween({ ms, ease: walkEase, run, update: (v) => arrow.trail(Math.max(0, v * 1.05 - 0.12)) });
        }
        await tokens.march(from, to, count, color, ink, ms, run, via, e.reason === 'fortify' ? 0.7 : 1.3, pal(e.player)?.id ?? '');
        if (gen === syncGen) {
          armies[to] = toN;
          tokens.setArmies(to, toN, 'land', run);
          refreshBadge(to, false);
        }
        if (e.reason === 'occupy' && arrowSource === 'event') {
          arrow.hide();
          arrowSource = null;
        }
        if (e.reason === 'occupy' && style === 'readable' && readableBeat?.conquered) closeReadable(readableBeat.key);
        return;
      }

      case 'continentGained': {
        continents.refresh(owners, lastState, false);
        await continents.sweep(e.continent, lastState, e.player, run);
        return;
      }

      case 'continentLost': {
        continents.refresh(owners, lastState, false);
        await anim.wait(300, run);
        return;
      }

      case 'playerEliminated': {
        // The sweep is the knockout's sting: torn and dark for a human seat, a plain deep sweep for an AI.
        await elimSweep(lastConquered, lastConquestFrom, e.by, run, o.sting ?? isHuman(e.player));
        return;
      }

      case 'gameOver': {
        if (arrowSource) {
          arrow.hide();
          arrowSource = null;
        }
        hideTray(200);
        // The winner's ink stays; every other wash dries back to paper. No wave, no orbit, no table.
        await victoryDry(e.winner, run);
        return;
      }
    }
  }

  // [board-pieces v4] test hooks for the motion audit (E5) and the readable beat (Q7), read via __debug.
  interface MotionEntry {
    type: string;
    style: string;
    tier: number | null;
    /** The motion duration the renderer chose at 1× (flood, march), when the event has one. */
    motionMs: number | null;
    /** Wall-clock, at the speed it ran. */
    ms: number;
    speed: number;
  }
  const motionLog: MotionEntry[] = [];
  let currentMotion: MotionEntry | null = null;
  const noteMotion = (ms: number) => {
    if (currentMotion) currentMotion.motionMs = ms;
  };
  /** The readable engagement in flight (opened by its first roll, closed after its recoil or its march). */
  let readableBeat: { key: string; t0: number; conquered: boolean } | null = null;
  const readableBeats: { key: string; ms: number; conquered: boolean; speed: number }[] = [];
  const closeReadable = (key: string) => {
    if (!readableBeat || readableBeat.key !== key) return;
    readableBeats.push({ key, ms: Math.round(performance.now() - readableBeat.t0), conquered: readableBeat.conquered, speed: anim.speed });
    if (readableBeats.length > 100) readableBeats.shift();
    readableBeat = null;
  };

  const NON_BLOCKING = new Set(['armiesPlaced', 'territoryClaimed', 'setupTurn', 'phaseChanged', 'cardDrawn', 'controllerChanged']);

  const playEvent = (e: GameEvent, stateAfter: GameState, o: PlayEventOptions = {}): Promise<void> => {
    if (disposed) return Promise.resolve();
    lastState = stateAfter;
    ensureColors(stateAfter);
    const run = anim.beginRun();
    const nb = NON_BLOCKING.has(e.type);
    inflight++;
    invalidate();
    // [board-pieces v4] the motion audit (E5): each event's style, tier, chosen motion ms and wall-clock ms
    const t0 = performance.now();
    const entry: MotionEntry = { type: e.type, style: o.style ?? 'full', tier: o.tier ?? null, motionMs: null, ms: 0, speed: anim.speed };
    currentMotion = entry;
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        entry.ms = Math.round(performance.now() - t0);
        motionLog.push(entry);
        if (motionLog.length > 300) motionLog.splice(0, motionLog.length - 300);
        if (currentMotion === entry) currentMotion = null;
        inflight--;
        invalidate();
        clearTimeout(dog);
        anim.endRun(run);
        resolve();
      };
      // Watchdog: nothing may hang the queue.
      const dog = setTimeout(() => {
        anim.skipRun(run);
        setTimeout(finish, 50);
      }, 9000);
      const go = async () => {
        try {
          if (!nb) await waitCamera(run);
          await handle(e, stateAfter, o, run);
        } catch (err) {
          console.error('[render] playEvent', e.type, err);
        } finally {
          finish();
        }
      };
      void go();
    });
  };

  // Portrait fill view: which player's territories home favours (the current player; before any owner,
  // Europe and Africa).
  let focusPlayer: PlayerId | -2 = -2;
  let focusGame: string | null = null;
  let pendingRecenter = false;
  const FOCUS_FALLBACK = (() => {
    const ids = TERRITORY_IDS.filter((id) => ['europe', 'africa'].includes(TERRITORIES[id].continent));
    return ids.reduce((a, id) => a + tiles.get(id).anchorW.x, 0) / Math.max(1, ids.length);
  })();
  /**
   * The fill view centres on where the player's turn happens: their front (their territories that border
   * an enemy, and the enemies across it); with no front, all of theirs; with none, Europe / Africa.
   */
  function setFocusFor(p: PlayerId): void {
    focusPlayer = p;
    const mine = TERRITORY_IDS.filter((id) => owners[id] === p);
    const front = new Set<TerritoryId>();
    for (const id of mine) {
      const foes = ADJACENCY[id].filter((n) => owners[n] !== p && owners[n] >= 0);
      if (!foes.length) continue;
      front.add(id);
      for (const f of foes) front.add(f);
    }
    const ids = front.size ? [...front] : mine;
    rig.setFocus(
      ids.map((id) => tiles.get(id).anchorW.x),
      FOCUS_FALLBACK,
    );
  }
  const syncState = (s: GameState) => {
    lastState = s;
    ensureColors(s);
    let changed = false;
    // A snap (load, resume, after a skip) leaves no fight on the board: an event-drawn arrow with nothing
    // playing is stale.
    if (arrowSource === 'event' && inflight === 0) {
      arrow.hide(true);
      arrowSource = null;
    }
    if (s.id !== focusGame) {
      // A new game (or a load): the paper is fresh — no dried washes — and its wave strokes are its own.
      parts.waves.place(s.config?.seed ?? 7);
      for (const t of tiles.list)
        if (t.dry > 0) {
          t.ver.dry = (t.ver.dry ?? 0) + 1;
          t.dry = 0;
          t.dirty = true;
        }
    }
    for (const id of TERRITORY_IDS) {
      const ts = s.territories[id];
      if (owners[id] !== ts.owner) {
        owners[id] = ts.owner;
        const t = tiles.get(id);
        t.uniforms.uFloodOn.value = 0;
        setOwnerLook(id, ts.owner);
        changed = true;
      }
      if (armies[id] !== ts.armies) {
        armies[id] = ts.armies;
        tokens.setArmies(id, ts.armies, 'snap');
        changed = true;
      }
      refreshBadge(id, false);
    }
    if (changed) {
      syncGen++;
      needShadow = true;
    }
    continents.refresh(owners, s, true);
    // Portrait fill view: home follows the current player's territories. A new game / load / resume (a new
    // state id) eases there; otherwise home is only re-aimed (turnStarted moves the camera, never mid-turn).
    if (changed || focusPlayer !== s.currentPlayer || s.id !== focusGame) {
      const fresh = s.id !== focusGame;
      focusGame = s.id;
      setFocusFor(s.currentPlayer);
      if (rig.mode === 'fill') {
        rig.retarget();
        if (fresh && !rig.displaced && touches.size === 0 && !down && !rig.attract) {
          if (reduced || anim.instant) cutTo({ ...rig.home });
          else void rig.goHome();
        }
      }
    }
  };

  // --- the living calm (docs/INK.md A1) -------------------------------------------------------------
  // Mist over the sea, the coastlines' wet-ink breath, each wash's slow lightness breath and the wave
  // strokes' sway all run off one ambient clock in the shaders (no tweens). (v4 E10: only the mist, the coast
  // glow and the lamp's vignette move now; the washes, the wave marks and the strokes hold still.) It is always the slowest thing
  // on screen and yields — dims to half — while anything gameplay-related moves; it draws at ≤ 30 fps
  // (≤ 24 on phones) when it is the only thing moving, runs at half speed after 3 minutes without input,
  // stops while the tab is hidden, and is off under reduced motion (the board is still).
  let ambientWanted = true;
  let ambT = 0;
  let ambAmp = 0;
  let mistAmp = 1;
  let lastInputAt = performance.now();
  let lastAmbientDraw = 0;
  const IDLE_SLOW_MS = 180000;
  const ambientOn = () => ambientWanted && !reduced;
  const noteInput = () => {
    lastInputAt = performance.now();
  };
  const onWindowInput = () => noteInput();
  window.addEventListener('keydown', onWindowInput, { passive: true });
  window.addEventListener('pointerdown', onWindowInput, { passive: true });
  const setRes = () => shared.uRes.value.set(W * renderer.getPixelRatio(), H * renderer.getPixelRatio());
  /** Per-territory data (the ground's half of each coast): the glow of the phase response. */
  const syncTerr = () => {
    let changed = false;
    for (const t of tiles.list) {
      const v = Math.round(Math.min(1, Math.max(0, t.glow)) * 255);
      const o = t.index * 4;
      if (terrData[o] !== v) {
        terrData[o] = v;
        changed = true;
      }
    }
    if (changed) shared.uTerr.value.needsUpdate = true;
    return changed;
  };
  /** Contact shadows: the two most lifted tiles cast theirs. */
  const syncLifts = () => {
    let a: Tile | null = null;
    let b: Tile | null = null;
    const lift = (t: Tile) => Math.max(0, t.hoverLift + t.selectLift + t.fxLift);
    for (const t of tiles.list) {
      const l = lift(t);
      if (l <= 1e-3) continue;
      if (!a || l > lift(a)) {
        b = a;
        a = t;
      } else if (!b || l > lift(b)) b = t;
    }
    shared.uLiftA.value.set(a ? a.index : 0, a ? lift(a) : 0);
    shared.uLiftB.value.set(b ? b.index : 0, b ? lift(b) : 0);
  };

  // --- frame loop ------------------------------------------------------------------------------
  const frameTimes: number[] = [];
  let lastT = performance.now();
  let fps = 60;
  let fpsAcc = 0;
  let fpsN = 0;
  let raf = 0;
  // Container origin in client px (the overlay itself is positioned in container px).
  const rect0 = { left: 0, top: 0 } as DOMRect;
  const clientOrigin = () => {
    const r = container.getBoundingClientRect();
    (rect0 as { left: number; top: number }).left = r.left;
    (rect0 as { left: number; top: number }).top = r.top;
  };
  let prevLift = new Float32Array(tiles.list.length);

  /** Phone-sized layout (either side under 520 CSS px): phone framing, 20 px plaques, deeper zoom. */
  let compact = false;
  /** Landscape phones look down a little less steeply: a shorter land fits the short screen wider. */
  let phoneLandPitch = HOME_PITCH;
  let landClearOverride: number | null = null;
  // The side safe areas (notch / Dynamic Island in landscape): the land runs to 12 px inside them.
  const safeProbe = document.createElement('div');
  Object.assign(safeProbe.style, {
    position: 'absolute',
    visibility: 'hidden',
    pointerEvents: 'none',
    width: '0',
    height: '0',
    paddingLeft: 'env(safe-area-inset-left, 0px)',
    paddingRight: 'env(safe-area-inset-right, 0px)',
  } as Partial<CSSStyleDeclaration>);
  container.appendChild(safeProbe);
  const readSafeArea = () => {
    const cs = getComputedStyle(safeProbe);
    rig.safeLeft = parseFloat(cs.paddingLeft) || 0;
    rig.safeRight = parseFloat(cs.paddingRight) || 0;
  };
  const resize = () => {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    clientOrigin();
    invalidate();
    if (w === W && h === H) return;
    W = w;
    H = h;
    compact = Math.min(W, H) < 520;
    rig.trayKeepOutSoft = compact;
    // Phones: portrait fills the height (east–west crops, pans); landscape fits the land edge to edge,
    // tighter to the HUD bands. Desktop and tablets keep the round-2 home.
    rig.mode = compact && H > W ? 'fill' : 'fit';
    // Landscape phones are height-bound (the land is ~2.1:1, the free band ~3.5:1): the land's own edge
    // (Arctic islands, Tierra del Fuego) may tuck under the translucent HUD bands, and the figures' tops a
    // little under the top one; every count plaque and base stays 6 px clear, so every piece is tappable.
    const phoneLand = compact && W > H;
    rig.landClear = landClearOverride ?? (phoneLand ? -40 : compact ? 4 : HOME_CLEAR_PX);
    rig.pieceClear = compact ? 6 : HOME_CLEAR_PX;
    rig.figureClear = phoneLand ? -14 : null;
    rig.homePitch = phoneLand ? phoneLandPitch : HOME_PITCH;
    readSafeArea();
    overlay.minPlaque = compact ? 20 : 22;
    overlay.relax = compact;
    // (figBoost: the old free-standing fight figures' phone size; the figures on the stones scale with them.)
    tokens.figBoost = phoneLand ? 1.25 : compact ? 1.1 : 1;
    tokens.markDirty();
    renderer.setSize(W, H, false);
    rig.setSize(W, H);
    overlay.width = W;
    overlay.height = H;
    tiles.setResolution(W, H);
    setRes();
    keepBand = insets.trayBand;
    layoutTray();
  };
  /**
   * A stone never crosses another territory's land (lead review 2026-09-30), and a piece — the stone, the figure
   * standing on it, the numeral at its edge — never covers another territory's figure or numeral (John
   * 2026-09-30, "Bring the icons back"). At the home view each territory's largest stone (diameter, CSS px)
   * starts at twice its anchor's distance to any other territory's land; then, for every pair of nearby pieces
   * whose parts would overlap at their caps (every count's envelope, tokens.pieceEnvelope; stone on stone is the
   * land rule's), the larger cap steps down 4 % until nothing overlaps. Floor: the 1-army stone (then the stone
   * stops growing; the numeral carries the count). Count-independent, so a piece never jumps when a
   * neighbour's count changes — with one exception (lead review 2026-09-30): the board's three largest stacks
   * are exempt. Against one of them the neighbour gives way (its stone to the floor, then its figure to 0.7×,
   * then its numeral to the lower-left edge); only if that still can't clear, the big one's stone gives a
   * step (`capsLost` names it). The caps are fitted again when the three largest change.
   * `capsTangled` lists the pairs still overlapping at the floor.
   */
  let capsFloored = 0;
  let capsLowered = 0;
  let capsLost: string[] = [];
  /** The board's three largest stacks (exempt from the floor), and the key the caps were fitted for. */
  const bigThree = (): TerritoryId[] => {
    const top: TerritoryId[] = [];
    for (const id of TERRITORY_IDS) {
      if (!(armies[id] > 0)) continue;
      let k = top.length;
      while (k > 0 && armies[top[k - 1]] < armies[id]) k--;
      if (k < 3) {
        top.splice(k, 0, id);
        if (top.length > 3) top.pop();
      }
    }
    return top;
  };
  let bigKey = '';
  // [board-pieces v4] the caps follow the counts' buckets (tokens.capBucket): refit when a stone crosses one
  let bucketKey = '';
  const bucketsNow = () => TERRITORY_IDS.map((id) => capBucket(Math.max(1, armies[id] ?? 1))).join(',');
  let capsTangled: string[] = [];
  let capsFigSmaller = 0;
  let capsNumLeft = 0;
  const fitCaps = () => {
    const cam = rig.homeCamera();
    const v = new THREE.Vector3();
    const pts = TERRITORY_IDS.map((id) => {
      v.copy(tiles.get(id).anchorW).project(cam);
      return [(v.x * 0.5 + 0.5) * W, (-v.y * 0.5 + 0.5) * H];
    });
    const ppu = homePxPerUnit();
    const ss = tokens.sizeScale;
    const dmin = tokens.dminPx * ss;
    const dmax = tokens.dmaxPx * ss;
    // [board-pieces v4] No land cap: a big stone may cross a neighbour's border (decision Q9); the caps below
    // only keep every numeral clear (tokens.piecesClash).
    void ppu;
    // (each cap starts at the stone its count's bucket draws, so "which is larger" means the army on the board)
    const caps = TERRITORY_IDS.map((id) => Math.min(dmax, stoneK(capBucket(Math.max(1, armies[id] ?? 1)), dmin, dmax)));
    // the pieces' parts at their caps, placed at their anchors
    type Parts = { stone: PxBox; fig: PxBox; num: PxBox };
    // (a crowded layout's second lever, once a stone is at its floor: its figure is drawn smaller, to FIG_K_MIN)
    const figK = TERRITORY_IDS.map(() => FIG_K);
    // (and last, a numeral at the lower-left edge instead)
    const side = TERRITORY_IDS.map(() => 1);
    const at = (i: number): Parts => {
      // [board-pieces v4] fitted for the counts on the board now (up to the top of each count's bucket)
      const e = pieceEnvelope(caps[i], dmin, dmax, ss, figK[i], side[i], tokens.numMin, capBucket(Math.max(1, armies[TERRITORY_IDS[i]] ?? 1)));
      const [x, y] = pts[i];
      const mv = (b: PxBox): PxBox => [b[0] + x, b[1] + y, b[2] + x, b[3] + y];
      return { stone: mv(e.stone), fig: mv(e.fig), num: mv(e.num) };
    };
    // (a pixel of air between parts: the drawn boxes snap to the device grid and the stones lie a hair foreshortened)
    const hit = (a: PxBox, b: PxBox) => {
      const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]) + 1;
      const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]) + 1;
      return w > 0 && h > 0;
    };
    // [board-pieces v4] a clash is a hidden numeral or two figures on each other (tokens.piecesClash)
    const tangled = (A: Parts, B: Parts) => piecesClash(A, B);
    // (one of the three largest against a neighbour: only the numerals must stay clear — the big piece may
    // stand over the neighbour's shrunken figure, never over its count)
    const numTangled = (A: Parts, B: Parts) => hit(A.fig, B.num) || hit(A.num, B.fig) || hit(A.num, B.num) || hit(A.num, B.stone) || hit(A.stone, B.num);
    const near: [number, number][] = [];
    const reach = dmax * 2.6;
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++) if (Math.abs(pts[i][0] - pts[j][0]) < reach && Math.abs(pts[i][1] - pts[j][1]) < reach) near.push([i, j]);
    const bigIds = bigThree();
    bigKey = bigIds.join(',');
    bucketKey = bucketsNow();
    const big = TERRITORY_IDS.map((id) => bigIds.includes(id));
    const lost = new Set<number>();
    let parts = TERRITORY_IDS.map((_, i) => at(i));
    /** One of the three largest against a neighbour: the neighbour gives way, the big one last. */
    const yieldTo = (b: number, o: number): boolean => {
      if (caps[o] > dmin + 1e-6) {
        caps[o] = Math.max(dmin, caps[o] * 0.96);
        parts[o] = at(o);
        return true;
      }
      if (figK[o] > FIG_K_MIN + 1e-6) {
        figK[o] = Math.max(FIG_K_MIN, figK[o] * 0.95);
        parts[o] = at(o);
        return true;
      }
      if (side[o] > 0) {
        side[o] = -1;
        const P = at(o);
        if (!numTangled(P, parts[b])) {
          parts[o] = P;
          return true;
        }
        side[o] = 1;
      }
      // (the big one's own numeral to its lower-left edge, before its stone gives way)
      if (side[b] > 0) {
        side[b] = -1;
        const P = at(b);
        if (!numTangled(P, parts[o])) {
          parts[b] = P;
          return true;
        }
        side[b] = 1;
      }
      if (caps[b] <= dmin + 1e-6) return false;
      caps[b] = Math.max(dmin, caps[b] * 0.96);
      lost.add(b);
      parts[b] = at(b);
      return true;
    };
    for (let it = 0; it < 120; it++) {
      let changed = false;
      for (const [i, j] of near) {
        if (big[i] !== big[j]) {
          // the neighbour gives way first (its stone, its figure, its numeral's side), then the big one
          if (!numTangled(parts[i], parts[j])) {
            // clear of every numeral: the neighbour's figure still shrinks to make room, the stones stay
            if (tangled(parts[i], parts[j])) {
              const o = big[i] ? j : i;
              if (figK[o] > FIG_K_MIN + 1e-6) {
                figK[o] = Math.max(FIG_K_MIN, figK[o] * 0.95);
                parts[o] = at(o);
                changed = true;
              }
            }
            continue;
          }
          if (yieldTo(big[i] ? i : j, big[i] ? j : i)) {
            changed = true;
            continue;
          }
        } else if (!tangled(parts[i], parts[j])) continue;
        // [board-pieces v4] the smaller army gives way first (its stone, its figure, its numeral's side), the
        // larger last, so size keeps meaning strength; a pair at the floor stays as it is
        const ai = armies[TERRITORY_IDS[i]] ?? 0;
        const aj = armies[TERRITORY_IDS[j]] ?? 0;
        const order = ai < aj ? [i, j] : aj < ai ? [j, i] : [i, j];
        let moved = false;
        for (const x of order) {
          if (caps[x] > dmin + 1e-6) {
            caps[x] = Math.max(dmin, caps[x] * 0.96);
            parts[x] = at(x);
            moved = true;
          } else if (figK[x] > FIG_K_MIN + 1e-6) {
            figK[x] = Math.max(FIG_K_MIN, figK[x] * 0.95);
            parts[x] = at(x);
            moved = true;
          } else if (side[x] > 0) {
            side[x] = -1;
            const P = at(x);
            if (tangled(P, x === i ? parts[j] : parts[i])) side[x] = 1;
            else {
              parts[x] = P;
              moved = true;
            }
          }
          if (moved) break;
        }
        if (moved) changed = true;
      }
      if (!changed) break;
    }
    parts = TERRITORY_IDS.map((_, i) => at(i));
    // (reported at the 1 px standard of a real overlap; the fit itself keeps tokens.PIECE_AIR of air where it can)
    capsTangled = near.filter(([i, j]) => (big[i] !== big[j] ? numTangled : (A: Parts, B: Parts) => piecesClash(A, B, 1))(parts[i], parts[j])).map(([i, j]) => `${TERRITORY_IDS[i]}/${TERRITORY_IDS[j]}`);
    capsFloored = caps.filter((c) => c <= dmin + 1e-6).length;
    capsLowered = caps.filter((c) => c < dmax - 1e-6).length;
    capsFigSmaller = figK.filter((k) => k < FIG_K - 1e-6).length;
    capsNumLeft = side.filter((v) => v < 0).length;
    capsLost = [...lost].map((i) => TERRITORY_IDS[i]);
    tokens.setCaps(
      new Map(TERRITORY_IDS.map((id, i) => [id, caps[i]])),
      new Map(TERRITORY_IDS.map((id, i) => [id, figK[i]])),
      new Map(TERRITORY_IDS.map((id, i) => [id, side[i]])),
    );
  };

  /** The dice tray's own band height when the HUD doesn't report one (tray + a little air). */
  const nominalBand = () => boardTrayGeometry(W, H, 1e9, uiScale).trayH + 12;
  /** Largest band the HUD has reported (sticky): the home view's tray keep-out follows it. */
  let keepBand = 0;
  const layoutTray = () => {
    const band = insets.trayBand > 0 ? insets.trayBand : nominalBand();
    // The band sits just above the bottom strip; the tray is centred in it.
    tray.layout(W, H, H - insets.bottom - band, band, uiScale);
    // The home view keeps tokens clear of the tray's footprint where it can (camera.ts). The band it
    // assumes only ever grows, so a HUD that reports the band only during fights never moves the camera
    // mid-game (it re-homes once, the first time).
    keepBand = Math.max(keepBand, insets.trayBand);
    const kb = keepBand > 0 ? keepBand : nominalBand();
    // The keep-out follows the HUD's tray band (src/shared/tray.ts), not the slimmer ink tray drawn inside
    // its top (dice.ts): the home view keeps the round-2 framing, and the drawn tray sits in open ocean below.
    const g = boardTrayGeometry(W, H, kb, uiScale);
    // Every piece (its plaque included) stays above the tray's top with a little air, and clear of its
    // sides. (The HUD's header line is centred and short; southern pieces near the tray's ends sit beside it.)
    const clear = 6 * uiScale;
    // v4 (PLAN §5 "fill the frame"; review 2026-09-30 §5): on desktop the home view no longer reserves the
    // South Atlantic for the dice; the land fills the height between the seats row and the bottom strip, and the
    // dice ring sits under the fight. Phones keep their framing (portrait already fills).
    rig.trayKeepOut = compact ? { x0: W / 2 - g.trayW / 2 - 12, x1: W / 2 + g.trayW / 2 + 12, y0: H - insets.bottom - kb + (kb - g.trayH) / 2 - clear } : null;
    // The stones are sized in CSS px at the home view (14 → 36 px at 1440×900; phones 15.5 → 26, so a 1-army numeral is ≥ 11 px without the floor), so their
    // board size follows the home scale: fit, size, fit again.
    // (Landscape phones: the numeral now sits at the stone's edge, so the floor no longer has to hold an 11 px
    // numeral inside; a smaller floor lets the crowded pieces clear each other.)
    const phoneLandNow = compact && W > H;
    // [board-pieces v4] the stone scale law (tokens.stoneK): 10 → 44 px at 1440; phones a flatter pair.
    tokens.dminPx = phoneLandNow ? 8.5 : compact ? 9 : 10;
    tokens.numMin = compact ? NUMERAL_MIN_PHONE : NUMERAL_MIN;
    tokens.dmaxPx = phoneLandNow ? 28 : compact ? 30 : 44;
    for (let it = 0; it < 3; it++) {
      setPieceExtents();
      rig.recomputeHome();
      tokens.pxUnit = 1 / Math.max(0.5, homePxPerUnit());
    }
    setPieceExtents();
    rig.recomputeHome();
    fitCaps();
    tokens.markDirty();
    rig.zoomInMax = compact ? clamp(40 / Math.max(1, homePxPerUnit()), 3.5, 9) : 3.5;
    continents.fitLabels(rig.homeCamera(), W);
    // The coastline breath reaches 0.5 CSS px at the home zoom (A1): in ink texels at this scale.
    const pxPerTexel = (homePxPerUnit() * G.width) / Math.max(1, shared.uInkSize.value.x);
    shared.uWob.value = clamp(0.5 / Math.max(0.05, pxPerTexel), 0.25, 6);
    // The continent outline (v4 E2): the Medium weight, a crisp 1.4 px at the home view (1.2 on phones).
    shared.uContW.value = clamp((compact ? 0.6 : EDGE_PX.medium / 2) / Math.max(1, homePxPerUnit()), 0.02, 0.3);
    // The attack stroke's weight is set in screen px at the home view (INK review F4): ~2 px tail, ~9 px head.
    arrow.pxUnit = live.pxUnit = 1 / Math.max(1, homePxPerUnit());
    arrow.relayout();
    lanes.setPxUnit(1 / Math.max(1, homePxPerUnit()));
    invalidate();
  };
  /** CSS px per board unit at the centre of the board, at the home view. */
  const homePxPerUnit = (): number => {
    const cam = rig.homeCamera();
    const a = toWorld(G.width / 2, G.height / 2, TILE_TOP).project(cam);
    const b = toWorld(G.width / 2 + 1, G.height / 2, TILE_TOP).project(cam);
    return Math.hypot((b.x - a.x) * 0.5 * W, (b.y - a.y) * 0.5 * H);
  };

  const ro = new ResizeObserver(() => resize());
  ro.observe(container);
  resize();

  // --- power (docs/MOBILE.md §7): render on demand, pause when hidden, adaptive pixel ratio ----------
  // The loop keeps ticking (cheap bookkeeping), but the GPU only draws when something changed: a tween,
  // the camera, a piece, a particle, a pulsing outline, an API call or input (invalidate()).
  let frameNo = 0;
  let drawnN = 0;
  let drawnAcc = 0;
  let drawnFps = 0;
  let drawnTotal = 0;
  let drewLast = false;
  /** Adaptive pixel ratio (touch GPUs): a smoothed frame time and how long it has been over budget. */
  let emaMs = 16.7;
  let overMs = 0;
  /** The frame-budget ladder (MOBILE §7, INK2 §4.3): 0 = DPR 2 + maps; 1 = DPR 1.5 + texture L1; 2 = L0. */
  let budgetStep = 0;
  let contextLost = false;
  let lossCount = 0;
  const applyPixelRatio = () => {
    renderer.setPixelRatio(pixelRatio());
    renderer.setSize(W, H, false);
    setRes();
    needShadow = true;
    invalidate();
  };
  const frame = () => {
    raf = requestAnimationFrame(frame);
    const now = performance.now();
    const rawDt = now - lastT;
    lastT = now;
    frameNo++;
    if (rawDt > 0 && rawDt < 1000) {
      frameTimes.push(rawDt);
      if (frameTimes.length > 240) frameTimes.shift();
      fpsAcc += rawDt;
      fpsN++;
      if (fpsAcc >= 500) {
        fps = (fpsN * 1000) / fpsAcc;
        drawnFps = (drawnN * 1000) / fpsAcc;
        fpsAcc = 0;
        fpsN = 0;
        drawnN = 0;
      }
    }
    if (contextLost) return;
    flushPlacements();
    const tweening = anim.active > 0;
    anim.tick(rawDt);
    const camMoving = rig.moving;
    rig.update(rawDt);
    // camera waiters
    for (let i = camWaiters.length - 1; i >= 0; i--) {
      const w = camWaiters[i];
      if (rig.autoProgress >= 0.8 || (w.run && w.run.skipped)) {
        camWaiters.splice(i, 1);
        w.resolve();
      }
    }
    const disp = rig.displaced;
    if (disp !== lastDisplaced) {
      lastDisplaced = disp;
      for (const cb of displacedCbs) {
        try {
          cb(disp);
        } catch (err) {
          console.error(err);
        }
      }
    }
    if (tray.lingerUntil && now >= tray.lingerUntil) {
      tray.lingerUntil = 0;
      hideTray(TRAY_FADE_MS);
      invalidate();
    }
    // Anything to draw? (`pulsing` = an unarmed target outline breathes: it draws at the ambient cadence.)
    let pulsing = false;
    let tileDirty = false;
    for (const t of tiles.list) {
      if (t.rimMode === 'target') pulsing = true;
      if (t.dirty) tileDirty = true;
    }
    // Gameplay motion: the ambient layer yields to it (and it draws at the full rate).
    const gameplay = inflight > 0 || tweening || anim.active > 0 || camMoving || rig.moving || tokens.animating || tray.visible || !!stroke?.live;
    const busy = hot > 0 || gameplay || tokens.needsUpdate || needShadow || tileDirty || overlay.dirty || overlay.chipCount > 0;
    // The ambient clock and amplitude: yield quickly (~250 ms), come back slowly (~1.5 s).
    const amb = ambientOn();
    const dtS = Math.min(Math.max(rawDt, 0), 100) / 1000;
    const idleSlow = now - lastInputAt > IDLE_SLOW_MS;
    if (amb) ambT += dtS * (idleSlow ? 0.5 : 1);
    const ampTo = amb ? (gameplay ? 0.5 : 1) : 0;
    ambAmp += (ampTo - ambAmp) * (1 - Math.exp(-dtS / (ampTo < ambAmp ? 0.25 : 1.5)));
    if (Math.abs(ampTo - ambAmp) < 0.003) ambAmp = ampTo;
    const mistTo = gameplay ? 0.5 : 1;
    mistAmp += (mistTo - mistAmp) * (1 - Math.exp(-dtS / (mistTo < mistAmp ? 0.25 : 1.5)));
    if (Math.abs(mistTo - mistAmp) < 0.003) mistAmp = mistTo;
    const calm = amb || ambAmp > 0 || mistAmp !== mistTo;
    if (!busy) {
      if (!calm && !pulsing) {
        drewLast = false;
        return;
      }
      // Only the calm is moving: ≤ 30 fps (≤ 24 on phones; two-thirds of that when idle for long).
      const cap = (phoneGpu ? 24 : 30) * (idleSlow ? 0.67 : 1);
      if (now - lastAmbientDraw < 1000 / cap - 4) return;
    }
    lastAmbientDraw = now;
    shared.uTime.value = ambT;
    shared.uAmb.value = ambAmp;
    shared.uMist.value = mistAmp;
    if (hot > 0) hot--;
    // Adaptive pixel ratio on touch GPUs: over budget (< ~48 fps smoothed) for 2 s of continuous drawing
    // drops the cap from 2 to 1.5 and the pigment maps to L1 (one wash tap), once; still over budget for a
    // further 4 s drops the maps to L0 (the procedural board). Never steps back up (INK2 §4.3).
    if (coarse && drewLast && rawDt > 0 && rawDt < 250 && budgetStep < 2 && (window.devicePixelRatio || 1) > 1.5) {
      emaMs = emaMs * 0.92 + rawDt * 0.08;
      overMs = emaMs > 21 ? overMs + rawDt : 0;
      if (budgetStep === 0 && overMs > 2000) {
        dprCap = 1.5;
        overMs = 0;
        applyPixelRatio();
        ink.setQuality(1);
        budgetStep = 1;
      } else if (budgetStep === 1 && overMs > 4000) {
        ink.setQuality(0);
        budgetStep = 2;
      }
    }
    drewLast = true;
    drawnN++;
    drawnTotal++;
    // Eligible targets breathe 0.5 ↔ 0.8 on a slow 2.4 s sine: the board's only pulse (B §4 "Select").
    const pulse = 0.5 + 0.3 * (0.5 + 0.5 * Math.sin((now / 2400) * Math.PI * 2));
    const rimScale = 1;
    let moved = false;
    tiles.list.forEach((t, i) => {
      tiles.apply(t, pulse, rimScale);
      const y = t.pivot.position.y + t.pivot.scale.x;
      if (y !== prevLift[i]) {
        prevLift[i] = y;
        moved = true;
      }
    });
    syncTerr();
    syncLifts();
    const tokensMoving = tokens.animating;
    // the board's three largest stacks changed: they keep their size (fitCaps)
    if (W > 1 && (bigThree().join(',') !== bigKey || bucketsNow() !== bucketKey)) fitCaps();
    tokens.setView(rig.cur.az, rig.cur.pitch);
    tokens.update();
    tray.tick(now);
    if (tray.showing !== trayShownEmitted) emitTray(tray.showing);
    overlay.zoomScale = clamp(Math.pow(rig.zoom, 0.3), 0.85, 1.3);
    // Numbers and names under the dice tray hide while it shows (the tray is drawn after the board).
    const oc = overlay.occluder;
    oc.on = tray.visible;
    if (oc.on) {
      // Only the dice cover the board: the ink ring and its translucent wash leave what's under them
      // readable (INK2 §2.3; the tray has one fixed spot per layout). No die out yet: the ring's box.
      const dr = tray.diceRect();
      oc.x0 = dr ? dr[0] : tray.cx - tray.trayW / 2;
      oc.x1 = dr ? dr[2] : tray.cx + tray.trayW / 2;
      oc.y0 = dr ? dr[1] : tray.cy - tray.trayH / 2 - 4;
      oc.y1 = dr ? dr[3] : tray.cy + tray.trayH / 2 + 4;
      oc.ring = [tray.cx - tray.trayW * 0.53, tray.cy - tray.trayH / 2 - 2, tray.cx + tray.trayW * 0.53, tray.cy + tray.trayH / 2 + 2];
      // Phones: the fight header's words (read from the HUD's DOM a few times a second, never written).
      if (compact && (frameNo % 6 === 0 || oc.hx0 === undefined)) {
        const kids = document.querySelectorAll<HTMLElement>('[data-testid="battle"] .bt-head > *');
        let l = Infinity;
        let r = -Infinity;
        let t = Infinity;
        kids.forEach((k) => {
          const b = k.getBoundingClientRect();
          if (b.width > 0) {
            l = Math.min(l, b.left - rect0.left);
            r = Math.max(r, b.right - rect0.left);
            t = Math.min(t, b.top - rect0.top);
          }
        });
        const ok = l < r && t < oc.y0;
        oc.hx0 = ok ? l - 6 : undefined;
        oc.hx1 = ok ? r + 6 : undefined;
        oc.hy0 = ok ? t - 4 : undefined;
      }
    } else {
      oc.hx0 = oc.hx1 = oc.hy0 = undefined;
    }
    overlay.update(camera, rect0);

    renderer.info.reset();
    renderer.clear();
    if (moved || tokensMoving || anim.active > 0 || needShadow) {
      renderer.shadowMap.needsUpdate = true;
      needShadow = false;
    }
    renderer.render(scene, camera);
    if (tray.visible) {
      renderer.clearDepth();
      renderer.shadowMap.needsUpdate = true;
      renderer.render(tray.scene, tray.camera);
    }
    if (reloading && !contextLost) {
      reloading = false;
      overlay.root.style.transition = 'opacity 300ms ease-out';
      overlay.root.style.opacity = '1';
      emitLoss(false);
    }
  };
  const onVisibility = () => {
    if (disposed) return;
    if (document.hidden) {
      // Paused while hidden: no frames at all (the watchdogs still resolve every playEvent).
      cancelAnimationFrame(raf);
      raf = 0;
      return;
    }
    if (!raf) {
      lastT = performance.now();
      invalidate();
      needShadow = true;
      raf = requestAnimationFrame(frame);
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  // --- WebGL context loss (docs/MOBILE.md §7): a quiet reload, never a white screen ------------------
  // Lost: stop drawing (the canvas shows the far-ocean colour) and tell the HUD (`Reloading the board…`).
  // Restored: three.js re-creates its GL state and re-uploads every geometry and texture on the next draw;
  // the board regenerates what only lived on the GPU (the environment map, the shadow maps) and redraws.
  // No restore within 3 s: a fresh renderer (new canvas) takes over the same scene.
  const lossCbs: ((lost: boolean) => void)[] = [];
  let reloading = false;
  let lossTimer: ReturnType<typeof setTimeout> | null = null;
  const emitLoss = (lost: boolean) => {
    for (const cb of lossCbs) {
      try {
        cb(lost);
      } catch (err) {
        console.error(err);
      }
    }
  };
  const regenEnvironment = () => {
    const pm = new THREE.PMREMGenerator(renderer);
    const env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    pm.dispose();
    const old = parts.envTexture;
    parts.envTexture = env;
    scene.environment = env;
    tray.scene.environment = env;
    old.dispose();
  };
  const afterRestore = () => {
    contextLost = false;
    if (lossTimer) clearTimeout(lossTimer);
    lossTimer = null;
    try {
      regenEnvironment();
    } catch (err) {
      console.warn('[render] environment', err);
    }
    needShadow = true;
    for (const t of tiles.list) t.dirty = true;
    tokens.markDirty();
    invalidate();
    // `reloading` clears (and the HUD hears `false`) after the first frame is drawn.
  };
  function onContextLost(e: Event): void {
    e.preventDefault(); // ask the browser to restore it
    if (disposed || contextLost) return;
    contextLost = true;
    reloading = true;
    // A second loss in a session: the pigment maps go (L0, the procedural board; INK2 §4.3).
    if (++lossCount >= 2) ink.setQuality(0);
    // Numbers and names would float over an empty canvas: they wait for the board to come back.
    overlay.root.style.transition = 'opacity 160ms ease-out';
    overlay.root.style.opacity = '0';
    emitLoss(true);
    if (lossTimer) clearTimeout(lossTimer);
    lossTimer = setTimeout(recreateRenderer, 3000);
  }
  function onContextRestored(): void {
    if (disposed) return;
    afterRestore();
  }
  function recreateRenderer(): void {
    lossTimer = null;
    if (disposed || !contextLost) return;
    try {
      const old = renderer;
      const oldCanvas = canvas;
      unbindCanvas(oldCanvas);
      renderer = makeRenderer();
      canvas = renderer.domElement;
      canvas.style.opacity = '1';
      container.insertBefore(canvas, oldCanvas);
      oldCanvas.remove();
      bindCanvas(canvas);
      try {
        old.dispose();
      } catch {
        /* the old context is gone */
      }
      renderer.setSize(W, H, false);
      setRes();
      afterRestore();
    } catch (err) {
      console.error('[render] renderer rebuild', err);
      lossTimer = setTimeout(recreateRenderer, 3000);
    }
  }

  let needShadow = true;

  // --- warm-up: compile every material, render one hidden dice + flood frame ------------------
  {
    const t0 = tiles.list[0];
    t0.uniforms.uFloodOn.value = 1;
    t0.uniforms.uFloodR.value = 3;
    tray.warm(PLAYER_COLORS.crimson, PLAYER_COLORS.cobalt);
    arrow.group.visible = true;
    void arrow.show('ural', 'siberia', [1, 0, 0], null, 0);
    route.show(['ural', 'siberia', 'yakutsk']);
    live.group.visible = true;
    tokens.setArmies('ural', 1, 'snap');
    tokens.update();
    try {
      renderer.compile(scene, camera);
      renderer.compile(tray.scene, tray.camera);
    } catch (err) {
      console.warn('[render] compile', err);
    }
    frame();
    cancelAnimationFrame(raf);
    t0.uniforms.uFloodOn.value = 0;
    t0.dirty = true;
    live.group.visible = false;
    tray.resetWarm();
    arrow.hide(true);
    route.hide();
    anim.skipAll();
    tokens.setArmies('ural', 0, 'snap');
    tokens.markDirty();
    // The warm-up frame baked the arrow/route into the shadow map: re-render it clean.
    needShadow = true;
  }
  lastT = performance.now();
  raf = requestAnimationFrame(frame);
  // The DOM overlay (numbers, names) fades in with the canvas, so text never floats over a black board.
  overlay.root.style.opacity = '0';
  requestAnimationFrame(() => {
    canvas.style.opacity = '1';
    overlay.root.style.opacity = '1';
    overlay.root.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 400, easing: 'ease-out' });
  });

  // --- the BoardView ------------------------------------------------------------------------------
  const view: BoardView = {
    syncState,
    playEvent,
    setAnimationSpeed(m: number) {
      anim.speed = m <= 0 ? 0 : m;
    },
    skipAnimations() {
      anim.skipAll();
      rig.finishAuto();
      for (const w of camWaiters.splice(0)) w.resolve();
      if (audio) {
        try {
          audio.stopAll();
        } catch {
          /* ignore */
        }
      }
    },
    setHighlights(hl: BoardHighlights) {
      const h = hl ?? {};
      const prev = lastHl;
      lastHl = { ...h, targets: h.targets ? [...h.targets] : undefined };
      applyHighlights(h, prev);
      applyPieceMarks(h, prev);
    },
    onTerritoryClick(cb) {
      clickCbs.push(cb);
    },
    onTerritoryHover(cb) {
      hoverCbs.push(cb);
    },
    focusTerritories(ids: TerritoryId[], o?: { durationMs?: number }) {
      if (!ids.length) {
        if (reduced) cutTo({ ...rig.home });
        else void rig.goHome(o?.durationMs);
        return;
      }
      const ext = phoneLand() ? extentsOf(ids) : undefined;
      // Landscape phones: pieces already clear of the HUD stay where they are (see phoneLand).
      if (ext && !rig.moving && rig.piecesClear(ext)) return;
      const pose = rig.framePose(ids.map((id) => tiles.get(id).anchorW), ids.length === 1 ? 2.2 : 1, 2.4, ext);
      if (reduced) cutTo(pose);
      else void rig.moveTo(pose, o?.durationMs);
    },
    resetCamera() {
      rig.userMoved = false;
      if (reduced) cutTo({ ...rig.home });
      else void rig.goHome();
    },
    setAttractMode(on: boolean) {
      // Title / victory: the flat painting, no table, no orbit (docs/INK.md B §7); the calm keeps drifting.
      if (on && !rig.userMoved) {
        if (reduced) cutTo({ ...rig.home });
        else rig.setAttract(true);
      }
    },
    isViewDisplaced() {
      return rig.displaced;
    },
    onViewDisplacedChange(cb: (displaced: boolean) => void) {
      displacedCbs.push(cb);
    },
    onTrayChange(cb: (visible: boolean) => void) {
      trayCbs.push(cb);
    },
    pulsePhase(phase: 'attack' | 'fortify' | 'end', o?: { player?: PlayerId; territories?: TerritoryId[] }) {
      pulsePhase(phase, o);
    },
    setShowLabels(on: boolean) {
      overlay.setShowLabels(on);
    },
    setViewportInsets(i: ViewportInsets) {
      // `bottom` is the bottom strip; `trayBand` the band above it. A HUD that folds the band into
      // `bottom` (the round-1 convention) is recognised, so the home view never reserves the band.
      let bottom = i.bottom;
      const band = i.trayBand > 0 ? i.trayBand : 0;
      // (Not when rects are sent: that HUD reports the strip's real top edge, whatever its height.)
      if (band > 0 && bottom >= band + 40 && !(i.rects && i.rects.length)) bottom -= band;
      insets = { top: i.top, right: i.right, left: i.left, bottom, trayBand: band, rects: i.rects?.map((r) => ({ ...r })) };
      rig.setInsets(insets);
      layoutTray();
    },
    setUiScale(scale: number) {
      uiScale = clamp(scale || 1, 0.75, 2);
      tokens.sizeScale = 1 + (uiScale - 1) * 0.6;
      overlay.uiScale = uiScale;
      // Bigger numbers need a bigger disc (softened, so tokens still leave their tiles showing).
      tokens.sizeScale = 1 + (uiScale - 1) * 0.6;
      tokens.markDirty();
      keepBand = insets.trayBand;
      layoutTray();
    },
    setReducedMotion(on: boolean) {
      reduced = on;
      tokens.reduced = on;
      arrow.reduced = on;
      route.reduced = on;
      continents.reducedMotion = on;
      applyHighlights(lastHl, lastHl);
    },
    setAmbient(on: boolean) {
      ambientWanted = on;
    },
    setStrokeSources(sources: TerritoryId[], targetsOf: (source: TerritoryId) => TerritoryId[]) {
      strokeSources = new Set(sources ?? []);
      strokeTargetsOf = strokeSources.size ? targetsOf : null;
      // A stroke in flight whose source is no longer eligible is cancelled.
      if (stroke && !strokeSources.has(stroke.from)) strokeEnd(true);
    },
    onStroke(cb: (s: { from: TerritoryId; to: TerritoryId | null; done: boolean }) => void) {
      strokeCbs.push(cb);
    },
    setAudio(a: AudioEngine | null) {
      audio = a;
    },
    setCountPreview(totals: Partial<Record<TerritoryId, number>> | null) {
      countPreview = totals ? { ...totals } : null;
      pushPreview(lastHl);
    },
    setAutoCamera(on: boolean) {
      autoCamera = on;
    },
    getScreenPosition(t: TerritoryId) {
      // Fresh each call (not last frame's value), in client px.
      return overlay.project(t, camera, container.getBoundingClientRect());
    },
    onTerritoryLongPress(cb: (info: TerritoryPointerInfo | null) => void) {
      longCbs.push(cb);
    },
    onContextLoss(cb: (lost: boolean) => void) {
      lossCbs.push(cb);
    },
    getStats(): BoardStats {
      const sorted = [...frameTimes].sort((a, b) => a - b);
      const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
      return {
        fps: Math.round(fps * 10) / 10,
        frameMsP95: Math.round(p95 * 10) / 10,
        drawCalls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        // Gameplay tweens only: the living calm runs off the ambient clock and reports separately.
        activeTweens: anim.active,
        cameraMoving: rig.moving,
        particles: 0,
        ambientOn: ambientOn(),
        ambientLevel: Math.round(ambAmp * 100) / 100,
        maxCameraDegPerSec: Math.round(rig.maxAutoDegPerSec * 10) / 10,
        drawnFps: Math.round(drawnFps * 10) / 10,
        pixelRatio: renderer.getPixelRatio(),
        contextLost,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      anim.dispose();
      unbindCanvas(canvas);
      clearTimer();
      if (lossTimer) clearTimeout(lossTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      container.removeEventListener('contextmenu', onContext);
      for (const w of camWaiters.splice(0)) w.resolve();
      tiles.dispose();
      tokens.dispose();
      continents.dispose();
      arrow.dispose();
      route.dispose();
      live.dispose();
      lanes.dispose();
      tray.dispose();
      overlay.dispose();
      parts.waves.dispose();
      for (const t of [ink.ink, ink.field, ink.cont, ink.noise, ink.waves, shared.uTerr.value]) t.dispose();
      window.removeEventListener('keydown', onWindowInput);
      window.removeEventListener('pointerdown', onWindowInput);
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && m.geometry) m.geometry.dispose();
      });
      parts.materials.forEach((m) => m.dispose());
      parts.envTexture.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };

  // Every call from the controller may change what the board shows: draw the next frames.
  for (const k of Object.keys(view) as (keyof BoardView)[]) {
    const f = view[k];
    if (typeof f !== 'function' || k === 'getStats' || k === 'getScreenPosition' || k === 'isViewDisplaced') continue;
    (view as unknown as Record<string, unknown>)[k] = function (this: unknown, ...args: unknown[]) {
      invalidate();
      return (f as (...a: unknown[]) => unknown).apply(this, args);
    };
  }

  // v4 board paper (PLAN §5 "drift you can see"): the drift test hook (BoardView.paperDrift, additive).
  view.paperDrift = async (ms = 2000) => {
    const seaPts: [number, number][] = [];
    for (let by = 4; by < G.height - 4; by += 5.5)
      for (let bx = 3; bx < G.width - 3; bx += 7.5) if (ink.seaDistance(bx, by) >= 3) seaPts.push([bx, by]);
    const coastPts: [number, number][] = [];
    TERRITORY_IDS.forEach((id, i) => {
      if (i % 2) return;
      const ring = G.territories[id].polygons[0]?.outer ?? [];
      for (let j = 0; j < ring.length; j += Math.max(1, Math.floor(ring.length / 4))) coastPts.push([ring[j][0], ring[j][1]]);
    });
    const t0 = ambT;
    const a0 = ambAmp;
    await new Promise((r) => setTimeout(r, ms));
    const t1 = ambT;
    const amp = (a0 + ambAmp) / 2;
    const d = paperDriftCPU(ink.noise, seaPts, coastPts, t0, t1);
    const ppu = homePxPerUnit();
    return { mistPx: d.mist * ppu, glowPx: d.glow * amp * ppu, clockS: t1 - t0, pxPerUnit: ppu, samples: d.mistN };
  };

  // Debug hook for the sandbox / e2e (cheap).
  (view as unknown as { __debug: unknown }).__debug = {
    rig,
    anim,
    tray,
    owners,
    armies,
    tiles,
    get renderer() {
      return renderer;
    },
    get canvas() {
      return canvas;
    },
    get compact() {
      return compact;
    },
    set figureClear(v: number) {
      rig.figureClear = v;
      W = -1;
      resize();
    },
    set landClear(v: number) {
      landClearOverride = v;
      W = -1;
      resize();
    },
    set phoneLandPitch(v: number) {
      phoneLandPitch = v;
      W = -1;
      resize();
    },
    get frameNo() {
      return frameNo;
    },
    /** Why the render-on-demand loop is drawing right now (debugging idle redraws). */
    busyWhy: () => ({
      hot,
      inflight,
      tweens: anim.active,
      cam: rig.moving,
      tokens: tokens.animating || tokens.needsUpdate,
      needShadow,
      tileDirty: tiles.list.filter((t) => t.dirty).map((t) => t.id),
      pulsing: tiles.list.filter((t) => t.rimMode === 'target').length,
      overlay: overlay.dirty,
      chips: overlay.chipCount,
      tray: tray.visible,
    }),
    get drawn() {
      return drawnTotal;
    },
    coarse,
    phoneGpu,
    ink,
    shared,
    arrow,
    live,
    get ambient() {
      return { on: ambientOn(), amp: ambAmp, mist: mistAmp, t: ambT, idleSlow: performance.now() - lastInputAt > IDLE_SLOW_MS };
    },
    /** Test hook: pretend the last input was `ms` ago (the 3-minute half-speed rule). */
    set idleFor(ms: number) {
      lastInputAt = performance.now() - ms;
    },
    touchPick: (x: number, y: number) => touchPick(x, y, clickable),
    homePxPerUnit,
    tokens,
    /** [board-pieces v4] every played event: style, tier, chosen motion ms (1×), wall-clock ms (last 300). */
    get motionLog() {
      return motionLog;
    },
    /** [board-pieces v4] readable AI engagements: wall-clock from the first roll to the end of the beat. */
    get readableBeats() {
      return readableBeats;
    },
    /** [board-pieces v4] the last dice roll's wall-clock ms and mode (dice.ts). */
    get lastRoll() {
      return tray.lastRoll;
    },
    get capsFloored() {
      return capsFloored;
    },
    get capsLowered() {
      return capsLowered;
    },
    /** Pairs of pieces that still overlap with both at the 1-army floor (fitCaps). */
    get capsTangled() {
      return capsTangled;
    },
    /** Of the three largest stacks: those whose stone still had to give a step to keep a neighbour's numeral clear. */
    get capsLost() {
      return capsLost;
    },
    /** The three largest stacks the caps were fitted for. */
    get capsBig() {
      return bigKey;
    },
    /** Territories whose figure is drawn under FIG_K to clear a neighbour (after the stone floor). */
    get capsFigSmaller() {
      return capsFigSmaller;
    },
    /** Territories whose numeral sits at the lower-left edge to clear a neighbour. */
    get capsNumLeft() {
      return capsNumLeft;
    },
    lanes,
    continents,
    overlay,
    get hovered() {
      return hovered;
    },
    pick: (x: number, y: number) => pick(x, y, false),
  };
  void lastHoverEvent;
  void prevLift;
  prevLift = prevLift;
  return view;
};

export default createBoardView;
