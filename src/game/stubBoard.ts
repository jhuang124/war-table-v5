// Fallback BoardView: a flat 2D canvas drawn from src/map BOARD polygons. Clickable tiles, army
// counts, highlights, instant events (or modelled 1× durations with `simulateTimings`). Used until the
// Three.js renderer lands, and by the controller's e2e checks (?stub=1).

import { cloneState, type GameEvent, type GameState, type TerritoryId } from '../engine';
import type { AudioEngine } from '../audio/types';
import type { BoardGeometry, Vec2 } from '../map/types';
import type {
  BoardHighlights,
  BoardStats,
  BoardView,
  PlayEventOptions,
  TerritoryPointerInfo,
  ViewportInsets,
} from '../render/BoardView';
import { EMBLEM_PATHS, PLAYER_COLORS, UNCLAIMED_COLOR } from '../shared/palette';
import { applyEventToDisplay } from './display';
import { eventDurationMs, scaledDuration } from './timingModel';

export interface StubBoardOptions {
  container: HTMLElement;
  geometry: BoardGeometry;
  /** Resolve playEvent after the modelled 1× duration instead of at once. */
  simulateTimings?: boolean;
}

const IVORY = '#f3ead8';

function pointInRing(x: number, y: number, ring: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function createStubBoard(opts: StubBoardOptions): BoardView {
  const { container, geometry } = opts;
  // v6: the board's own territories (any map), in its file order.
  const TERRITORY_IDS = Object.keys(geometry.territories) as TerritoryId[];
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;cursor:default';
  canvas.dataset.stub = '1';
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;

  let disp: GameState | null = null;
  let hl: BoardHighlights = {};
  let insets: ViewportInsets = { top: 0, right: 0, bottom: 0, left: 0, trayBand: 0 };
  let speed = 1;
  let labels = true;
  let uiScale = 1;
  let audio: AudioEngine | null = null;
  let clickCb: ((i: TerritoryPointerInfo) => void) | null = null;
  let hoverCb: ((i: TerritoryPointerInfo | null) => void) | null = null;
  let hovered: TerritoryId | null = null;
  let dirty = true;
  let disposed = false;
  const pending = new Set<() => void>();
  let frames: number[] = [];
  let lastFrame = performance.now();
  let pulse: { t: TerritoryId; until: number } | null = null;
  /** v4: the receipt's pulse (BoardHighlights.pulse), played once when the array changes. */
  let pulseSet: { ts: Set<TerritoryId>; until: number } | null = null;
  let pulseKey = '';

  // Board → screen transform
  let scale = 1;
  let ox = 0;
  let oy = 0;
  const layout = () => {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const availW = Math.max(100, w - insets.left - insets.right);
    const availH = Math.max(100, h - insets.top - insets.bottom);
    scale = Math.min(availW / geometry.width, availH / geometry.height) * 0.96;
    ox = insets.left + (availW - geometry.width * scale) / 2;
    oy = insets.top + (availH - geometry.height * scale) / 2;
    dirty = true;
  };
  const toScreen = ([x, y]: Vec2): [number, number] => [ox + x * scale, oy + (geometry.height - y) * scale];
  const toBoard = (sx: number, sy: number): [number, number] => [(sx - ox) / scale, geometry.height - (sy - oy) / scale];

  const hit = (clientX: number, clientY: number): TerritoryId | null => {
    const r = canvas.getBoundingClientRect();
    const [bx, by] = toBoard(clientX - r.left, clientY - r.top);
    for (const t of TERRITORY_IDS) {
      const g = geometry.territories[t];
      const [x0, y0, x1, y1] = g.bbox;
      if (bx < x0 || bx > x1 || by < y0 || by > y1) continue;
      if (g.polygons.some((p) => pointInRing(bx, by, p.outer))) return t;
    }
    return null;
  };

  const path = (ring: Vec2[]) => {
    ctx.beginPath();
    ring.forEach((pt, i) => {
      const [sx, sy] = toScreen(pt);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.closePath();
  };

  const draw = () => {
    const w = canvas.width / Math.min(2, window.devicePixelRatio || 1);
    const h = canvas.height / Math.min(2, window.devicePixelRatio || 1);
    ctx.fillStyle = '#0c0f13';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#123a3f';
    const [bx0, by0] = toScreen([0, geometry.height]);
    ctx.fillRect(bx0, by0, geometry.width * scale, geometry.height * scale);
    ctx.strokeStyle = '#c2a062';
    ctx.lineWidth = 2;
    ctx.strokeRect(bx0, by0, geometry.width * scale, geometry.height * scale);
    // Sea lanes
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(243,234,216,0.45)';
    ctx.lineWidth = 1;
    for (const lane of geometry.seaLanes) {
      for (const seg of lane.segments) {
        ctx.beginPath();
        seg.forEach((pt, i) => {
          const [sx, sy] = toScreen(pt);
          if (i === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        });
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    for (const poly of geometry.decorativeLand) {
      path(poly.outer);
      ctx.fillStyle = '#3a4a40';
      ctx.fill();
    }
    const selectable = new Set(hl.selectable ?? []);
    const targets = new Set(hl.targets ?? []);
    const dim = !!hl.dimOthers;
    const now = performance.now();
    for (const t of TERRITORY_IDS) {
      const g = geometry.territories[t];
      const ts = disp?.territories[t];
      const owner = ts && ts.owner >= 0 ? disp!.players[ts.owner] : null;
      const base = owner ? PLAYER_COLORS[owner.color].base : UNCLAIMED_COLOR;
      const isDim = dim && t !== hl.selected && !targets.has(t) && !selectable.has(t);
      for (const poly of g.polygons) {
        path(poly.outer);
        ctx.globalAlpha = isDim ? 0.45 : 1;
        ctx.fillStyle = base;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = 'rgba(12,15,19,0.8)';
        ctx.lineWidth = 1;
        ctx.stroke();
        if (t === hl.selected) {
          ctx.strokeStyle = IVORY;
          ctx.lineWidth = 3.5;
          ctx.stroke();
        } else if (targets.has(t)) {
          ctx.strokeStyle = IVORY;
          ctx.lineWidth = 2.5;
          ctx.setLineDash([5, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
        } else if (selectable.has(t)) {
          ctx.strokeStyle = 'rgba(243,234,216,0.55)';
          ctx.lineWidth = 1.6;
          ctx.stroke();
        }
        if (t === hovered && (selectable.has(t) || targets.has(t) || t === hl.selected)) {
          ctx.fillStyle = 'rgba(255,255,255,0.12)';
          ctx.fill();
        }
      }
    }
    // Arrow
    if (hl.arrow) {
      const pts = (hl.arrow.path && hl.arrow.path.length > 1 ? hl.arrow.path : [hl.arrow.from, hl.arrow.to]).map((x) =>
        toScreen(geometry.territories[x].anchor),
      );
      ctx.strokeStyle = hl.arrow.kind === 'attack' ? IVORY : 'rgba(243,234,216,0.9)';
      ctx.lineWidth = 3;
      if (hl.arrow.kind === 'fortify') ctx.setLineDash([6, 4]);
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
      ctx.setLineDash([]);
      const [x1, y1] = pts[pts.length - 1];
      const [x0, y0] = pts[pts.length - 2];
      const a = Math.atan2(y1 - y0, x1 - x0);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - 10 * Math.cos(a - 0.4), y1 - 10 * Math.sin(a - 0.4));
      ctx.lineTo(x1 - 10 * Math.cos(a + 0.4), y1 - 10 * Math.sin(a + 0.4));
      ctx.closePath();
      ctx.fillStyle = IVORY;
      ctx.fill();
    }
    // The live stroke: a gold line from the source to the pointer.
    if (stroke?.drawing) {
      const [x0, y0] = toScreen(geometry.territories[stroke.from].anchor);
      ctx.strokeStyle = '#cfa66b';
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(stroke.x, stroke.y);
      ctx.stroke();
      ctx.lineCap = 'butt';
    }
    // Badges
    const fs = Math.round(12 * uiScale);
    ctx.font = `700 ${fs}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const t of TERRITORY_IDS) {
      const g = geometry.territories[t];
      const ts = disp?.territories[t];
      if (!ts) continue;
      const [x, y] = toScreen(g.anchor);
      const owner = ts.owner >= 0 ? disp!.players[ts.owner] : null;
      const pop = (pulse && pulse.t === t && pulse.until > now) || (pulseSet && pulseSet.ts.has(t) && pulseSet.until > now) ? 1.15 : 1;
      const text = String(ts.armies);
      const bw = (ctx.measureText(text).width + fs * 1.6) * pop;
      const bh = fs * 1.6 * pop;
      ctx.fillStyle = 'rgba(18,21,26,0.92)';
      ctx.beginPath();
      ctx.roundRect(x - bw / 2, y - bh / 2, bw, bh, bh / 2);
      ctx.fill();
      ctx.strokeStyle = owner ? PLAYER_COLORS[owner.color].base : UNCLAIMED_COLOR;
      ctx.lineWidth = 2;
      ctx.stroke();
      if (owner) {
        const e = new Path2D(EMBLEM_PATHS[PLAYER_COLORS[owner.color].emblem]);
        ctx.save();
        const es = (fs * 0.8) / 24;
        ctx.translate(x - bw / 2 + fs * 0.35, y - (fs * 0.8) / 2);
        ctx.scale(es, es);
        ctx.fillStyle = PLAYER_COLORS[owner.color].light;
        ctx.fill(e);
        ctx.restore();
      }
      // v4 A4: a territory a human lost keeps a thin ring in the loser's colour.
      const ring = hl.loserRings?.find((r) => r.territory === t);
      if (ring && PLAYER_COLORS[ring.color]) {
        ctx.strokeStyle = PLAYER_COLORS[ring.color].base;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(bw, bh) / 2 + 4, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = IVORY;
      ctx.fillText(text, x + fs * 0.3, y + 0.5);
      const ghost = hl.pending?.[t];
      if (ghost) {
        ctx.fillStyle = IVORY;
        ctx.beginPath();
        ctx.roundRect(x + bw / 2 + 2, y - bh / 2, fs * 2.2, bh, bh / 2);
        ctx.fill();
        ctx.fillStyle = '#12151a';
        ctx.fillText(`+${ghost}`, x + bw / 2 + 2 + fs * 1.1, y + 0.5);
      }
      if (labels) {
        ctx.save();
        ctx.font = `500 ${Math.round(9 * uiScale)}px Inter, system-ui, sans-serif`;
        ctx.fillStyle = 'rgba(18,21,26,0.85)';
        const [lx, ly] = toScreen(g.labelAnchor);
        ctx.fillText(geometry.territories[t].id.replace(/_/g, ' '), lx, ly);
        ctx.restore();
      }
    }
  };

  const loop = () => {
    if (disposed) return;
    const now = performance.now();
    frames.push(now - lastFrame);
    if (frames.length > 120) frames = frames.slice(-120);
    lastFrame = now;
    if (pulse && pulse.until < now) {
      pulse = null;
      dirty = true;
    }
    if (pulseSet && pulseSet.until < now) {
      pulseSet = null;
      dirty = true;
    }
    if (dirty) {
      dirty = false;
      draw();
    }
    requestAnimationFrame(loop);
  };

  // Pointer → click / hover, and draw-to-attack (docs/INK.md A2): a drag from a stroke source
  let down: { x: number; y: number; t: number; tile: TerritoryId | null; button: number } | null = null;
  let strokeSources = new Set<TerritoryId>();
  let strokeTargets: (t: TerritoryId) => TerritoryId[] = () => [];
  let strokeCb: ((s: { from: TerritoryId; to: TerritoryId | null; done: boolean }) => void) | null = null;
  let stroke: { from: TerritoryId; x: number; y: number; to: TerritoryId | null; drawing: boolean } | null = null;
  const strokeTo = (x: number, y: number, from: TerritoryId): TerritoryId | null => {
    const t = hit(x, y);
    return t && strokeTargets(from).includes(t) ? t : null;
  };
  const info = (e: PointerEvent | MouseEvent, t: TerritoryId, button: number): TerritoryPointerInfo => ({
    territory: t,
    clientX: e.clientX,
    clientY: e.clientY,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
    button,
  });
  canvas.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY, t: performance.now(), tile: hit(e.clientX, e.clientY), button: e.button };
    stroke = down.tile && e.button === 0 && strokeSources.has(down.tile) ? { from: down.tile, x: e.clientX, y: e.clientY, to: null, drawing: false } : null;
  });
  canvas.addEventListener('pointerup', (e) => {
    const d = down;
    down = null;
    const st = stroke;
    stroke = null;
    if (st?.drawing) {
      dirty = true;
      strokeCb?.({ from: st.from, to: strokeTo(e.clientX, e.clientY, st.from), done: true });
      return;
    }
    if (!d || d.button !== e.button) return;
    const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
    if (moved > 6 || performance.now() - d.t > 350) return;
    const t = hit(e.clientX, e.clientY);
    if (!t || t !== d.tile) return;
    clickCb?.(info(e, t, e.button === 2 ? 2 : 0));
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointermove', (e) => {
    if (stroke && (stroke.drawing || Math.hypot(e.clientX - stroke.x, e.clientY - stroke.y) > 6)) {
      stroke.drawing = true;
      const r = canvas.getBoundingClientRect();
      stroke.x = e.clientX - r.left;
      stroke.y = e.clientY - r.top;
      stroke.to = strokeTo(e.clientX, e.clientY, stroke.from);
      dirty = true;
      strokeCb?.({ from: stroke.from, to: stroke.to, done: false });
    }
    const t = hit(e.clientX, e.clientY);
    if (t !== hovered) {
      hovered = t;
      dirty = true;
      const clickable = t && (hl.selectable?.includes(t) || hl.targets?.includes(t) || hl.selected === t);
      canvas.style.cursor = clickable ? 'pointer' : 'default';
    }
    hoverCb?.(t ? info(e, t, 0) : null);
  });
  canvas.addEventListener('pointerleave', () => {
    hovered = null;
    dirty = true;
    hoverCb?.(null);
  });
  const onResize = () => layout();
  window.addEventListener('resize', onResize);
  layout();
  requestAnimationFrame(loop);

  const playSound = (e: GameEvent, style: 'full' | 'brief' | 'readable', o?: PlayEventOptions) => {
    if (!audio) return;
    const vol = style === 'brief' ? 0.6 : 1;
    // v4 readable (an AI's engagement): one short bone click for the whole engagement, never the dice show.
    if (e.type === 'diceRolled' && style === 'readable') {
      if ((o?.seq?.index ?? 0) === 0) audio.cue?.('bone');
      return;
    }
    switch (e.type) {
      case 'armiesPlaced':
        audio.play(e.count < 0 ? 'unplace' : 'place', { volume: vol });
        break;
      case 'diceRolled':
        if (style === 'full') audio.play('diceLand', { volume: vol });
        if (e.defenderLosses || e.attackerLosses) audio.play('hit', { volume: vol * 0.8, delay: 0.05 });
        break;
      case 'territoryConquered':
        audio.play('conquer', { volume: vol });
        break;
      case 'armiesMoved':
        audio.play('march', { volume: vol });
        break;
      default:
        break;
    }
  };

  const view: BoardView = {
    syncState(state) {
      disp = cloneState(state);
      dirty = true;
    },
    playEvent(event, stateAfter, o?: PlayEventOptions) {
      if (disp) disp = applyEventToDisplay(disp, event, stateAfter, false);
      if (event.type === 'armiesPlaced') pulse = { t: event.territory, until: performance.now() + 160 };
      dirty = true;
      playSound(event, o?.style ?? 'full', o);
      const ms = opts.simulateTimings ? scaledDuration(eventDurationMs(event, o), speed) : 0;
      if (ms <= 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const done = () => {
          pending.delete(done);
          clearTimeout(h);
          resolve();
        };
        const h = setTimeout(done, ms);
        pending.add(done);
      });
    },
    setAnimationSpeed(m) {
      speed = m;
    },
    skipAnimations() {
      for (const d of [...pending]) d();
      audio?.stopAll?.();
    },
    setHighlights(h) {
      // v4 receipt pulse: once per new array (the renderer holds no state for it).
      const key = (h.pulse ?? []).join(',');
      if (key && key !== pulseKey) pulseSet = { ts: new Set(h.pulse), until: performance.now() + 450 };
      pulseKey = key;
      hl = h;
      dirty = true;
    },
    onTerritoryClick(cb) {
      clickCb = cb;
    },
    onTerritoryHover(cb) {
      hoverCb = cb;
    },
    setStrokeSources(sources, targetsOf) {
      strokeSources = new Set(sources);
      strokeTargets = targetsOf;
      if (stroke && !strokeSources.has(stroke.from)) {
        stroke = null;
        dirty = true;
      }
    },
    onStroke(cb) {
      strokeCb = cb;
    },
    focusTerritories() {
      /* flat board: nothing to move */
    },
    resetCamera() {
      /* flat board */
    },
    setAttractMode() {
      /* flat board */
    },
    setShowLabels(on) {
      labels = on;
      dirty = true;
    },
    setViewportInsets(i) {
      insets = i;
      layout();
    },
    setUiScale(s) {
      uiScale = s;
      dirty = true;
    },
    setReducedMotion() {
      /* no motion to reduce */
    },
    setAudio(a) {
      audio = a;
    },
    getScreenPosition(t) {
      const g = geometry.territories[t];
      if (!g) return null;
      const r = canvas.getBoundingClientRect();
      const [x, y] = toScreen(g.anchor);
      return { x: r.left + x, y: r.top + y };
    },
    getStats(): BoardStats {
      const sorted = [...frames].sort((a, b) => a - b);
      const avg = frames.length ? frames.reduce((a, b) => a + b, 0) / frames.length : 16.7;
      return {
        fps: Math.round(1000 / Math.max(1, avg)),
        frameMsP95: sorted[Math.floor(sorted.length * 0.95)] ?? 16.7,
        drawCalls: 0,
        triangles: 0,
        activeTweens: pending.size,
        cameraMoving: false,
        particles: 0,
      };
    },
    dispose() {
      disposed = true;
      window.removeEventListener('resize', onResize);
      canvas.remove();
    },
  };
  return view;
}
