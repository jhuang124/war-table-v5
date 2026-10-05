// Render sandbox: exercises the BoardView without the UI. A 4-AI engine game plays events with
// style full/brief and seq; on-page controls drive speed, skip, highlights, camera, insets, etc.
import { BOARD } from '../map';
import { createBoardView } from './index';
import { ADJACENCY, CONTINENTS, MAP, TERRITORY_IDS } from './activeMap';
import type { BoardView, PlayEventOptions, ViewportInsets } from './BoardView';
import {
  applyAction,
  attackTargets,
  chooseAiAction,
  createGame,
  defaultConfig,
  fortifyPath,
  type Action,
  type GameEvent,
  type GameState,
  type PlayerConfig,
  type TerritoryId,
} from '../engine';
import { DEFAULT_SEAT_COLORS, PLAYER_COLORS } from '../shared/palette';
import { trayGeometry } from '../shared/tray';
import { createAudio } from '../audio';

const NON_BLOCKING = new Set(['armiesPlaced', 'territoryClaimed', 'setupTurn', 'phaseChanged', 'cardDrawn', 'controllerChanged']);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const params = new URLSearchParams(location.search);
let view: BoardView;
let state: GameState;
let running = false;
let styleMode: 'full' | 'brief' | 'auto' = (params.get('style') as 'full' | 'brief' | 'auto') ?? 'full';
let busy = false;
const log: string[] = [];

// ---------------------------------------------------------------------------
// HUD mock (insets presets)
// ---------------------------------------------------------------------------

/** The HUD's battle band (src/ui/index.ts solveBand), copied so the sandbox doesn't pull in the UI. */
function solveBand(H: number, scale: number, W: number): number {
  const rem = 16 * scale;
  const need = Math.ceil(Math.max(0.022 * H, 1.0625 * rem) * 1.6);
  const cap = Math.round(H * 0.34);
  let band = 120;
  for (; band <= cap; band += 2) if (Math.floor((band - trayGeometry(W, H, band, scale).trayH) / 2) >= need) break;
  return Math.min(band, cap);
}

/** The floating HUD's persistent pills (docs/ROUND2.md §C): seat chips, ≡, the bottom strip. */
function floatRects(W: number, H: number, s: number): { x: number; y: number; w: number; h: number }[] {
  const ch = Math.round(40 * s);
  const chipsW = [82, 74, 74, 74].reduce((a, w) => a + Math.round(w * s) + 8, 0) - 8;
  const sw = Math.min(1180, W - 24);
  const sh = Math.round(64 * s);
  return [
    { x: 12, y: 12, w: chipsW, h: ch },
    { x: W - 12 - ch, y: 12, w: ch, h: ch },
    { x: (W - sw) / 2, y: H - 12 - sh, w: sw, h: sh },
  ];
}

/**
 * Phone HUD mock (docs/MOBILE.md §4). Landscape: emblem pills top-left (the current seat's pill shows its
 * name), `≡` 44×44 top-right, a ~64 px dock along the bottom. Portrait: the pills in one row with `≡` at
 * the right, and a two-row dock (Turn Track 44 px + the line / count / buttons 48 px).
 */
function phoneRects(W: number, H: number): { rects: { x: number; y: number; w: number; h: number }[]; top: number; bottom: number; labels: string[] } {
  const portrait = H > W;
  const m = 8;
  const pills = [96, 52, 52, 52];
  const rects: { x: number; y: number; w: number; h: number }[] = [];
  let x = 12;
  for (const w of pills) {
    rects.push({ x, y: m, w, h: 40 });
    x += w + 6;
  }
  rects.push({ x: W - 12 - 44, y: m - 2, w: 44, h: 44 });
  const dockH = portrait ? 44 + 8 + 48 + 16 : 64;
  rects.push({ x: m, y: H - m - dockH, w: W - 2 * m, h: dockH });
  return { rects, top: m + 44 + 4, bottom: m + dockH + 4, labels: ['▲ John 11', '● 10', '■ 11', '◆ 10', '≡', portrait ? 'Place · Attack · Fortify · End\nJohn — pick a territory       [ Attack ]' : 'Place · Attack · Fortify · End   John — pick a territory   [ Attack ]'] };
}

const PRESETS: Record<string, (W: number, H: number, s: number) => ViewportInsets> = {
  none: () => ({ top: 0, right: 0, bottom: 0, left: 0, trayBand: 0 }),
  phone: (W, H, s) => {
    const p = phoneRects(W, H);
    return { top: p.top, right: 0, bottom: p.bottom, left: 0, trayBand: solveBand(H, s, W), rects: p.rects };
  },
  // docs/ROUND2.md §C: glass pills float on the ocean — seat chips top-left, ≡ top-right (12 px from the
  // edges, 40 px tall), and a 64 px bottom strip at bottom: 12 px. Insets = the pills' inner edges (+4).
  float: (W, H, s) => ({
    top: Math.round(12 + 40 * s + 4),
    right: 0,
    bottom: Math.round(12 + 64 * s + 4),
    left: 0,
    trayBand: solveBand(H, s, W),
    rects: floatRects(W, H, s),
  }),
  // The same pills reported as top/bottom bands only (a HUD that doesn't send rects).
  floatBands: (W, H, s) => ({ top: Math.round(12 + 40 * s + 4), right: 0, bottom: Math.round(12 + 64 * s + 4), left: 0, trayBand: solveBand(H, s, W) }),
  // docs/SIMPLIFY.md §1: a ~44 px top strip (seat chips) and a one-row ~64 px bottom strip. The tray
  // band is not reported (the board uses its own nominal band just above the bottom strip).
  strip: (_W, _H, s) => ({ top: Math.round(44 * s), right: 0, bottom: Math.round(64 * s), left: 0, trayBand: 0 }),
  // Round-1 HUD (side panels, `bottom` including the tray band): kept to check the legacy convention.
  hud: (W, H, s) => {
    const bar = 84 * s;
    const band = Math.max(128, Math.round(H * 0.17)) * Math.min(1.2, s);
    return { top: 56 * s + 8, left: Math.min(232 * s, W * 0.2), right: 64 * s, bottom: bar + 16 + band, trayBand: band };
  },
};
let preset = params.get('insets') ?? (Math.min(innerWidth, innerHeight) < 520 ? 'phone' : 'float');
let uiScale = Number(params.get('scale') ?? 1);
let showHudText = false;
let displaced = false;
let hudText: { header: string; result: string } = { header: '', result: '' };
let lastSbHl: import('./BoardView').BoardHighlights = {};

function applyInsets(): void {
  const W = innerWidth;
  const H = innerHeight;
  const ins = PRESETS[preset](W, H, uiScale);
  view.setViewportInsets(ins);
  const hud = document.getElementById('hud')!;
  hud.innerHTML = '';
  if (preset === 'none') return;
  const z = (l: number, t: number, w: number, h: number, cls = 'zone') => {
    const d = document.createElement('div');
    d.className = cls;
    Object.assign(d.style, { left: `${l}px`, top: `${t}px`, width: `${w}px`, height: `${h}px` });
    hud.appendChild(d);
    return d;
  };
  if (preset === 'phone') {
    const p = phoneRects(W, H);
    p.rects.forEach((r, i) => {
      const d = z(r.x, r.y, r.w, r.h, 'zone pill');
      d.textContent = p.labels[i];
      d.style.whiteSpace = 'pre';
      d.style.fontSize = i === p.rects.length - 1 ? '13px' : '14px';
    });
    if (displaced) {
      const d = z(W - 12 - 44 - 8 - 104, 6, 104, 44, 'zone pill');
      d.textContent = 'Reset view';
      d.dataset.reset = '1';
    }
    return;
  }
  if (preset === 'float' || preset === 'floatBands') {
    const pill = (l: number, t: number, w: number, h: number, txt = '') => {
      const d = z(l, t, w, h, 'zone pill');
      if (txt) d.textContent = txt;
      return d;
    };
    const ch = Math.round(40 * uiScale);
    let x = 12;
    for (const [i, name] of ['John 11', 'Sam 10', 'Priya 11', 'Alex 10'].entries()) {
      const w = Math.round((74 + (i === 0 ? 8 : 0)) * uiScale);
      pill(x, 12, w, ch, name);
      x += w + 8;
    }
    pill(W - 12 - ch, 12, ch, ch, '≡');
    if (displaced) pill(W - 12 - ch - 8 - 104 * uiScale, 12, 104 * uiScale, ch, 'Reset view').dataset.reset = '1';
    const sw = Math.min(1180, W - 24);
    const sh = Math.round(64 * uiScale);
    pill((W - sw) / 2, H - 12 - sh, sw, sh, 'Place  ·  Attack  ·  Fortify  ·  End turn');
    if (showHudText && hudText.header) {
      const band = ins.trayBand;
      const g = trayGeometry(W, H, band, uiScale);
      const top = H - ins.bottom - band + (band - g.trayH) / 2;
      const h = document.createElement('div');
      h.className = 'txt';
      h.style.top = `${top - 26}px`;
      h.textContent = hudText.header;
      hud.appendChild(h);
    }
    return;
  }
  if (preset === 'strip') {
    z(0, 0, W, ins.top, 'zone strip');
    z(0, H - ins.bottom, W, ins.bottom, 'zone strip');
    if (showHudText && hudText.header) {
      // The HUD's one header line, just above the tray.
      const band = trayGeometry(W, H, 1e9, uiScale).trayH + 12;
      const g = trayGeometry(W, H, band, uiScale);
      const top = H - ins.bottom - band + (band - g.trayH) / 2;
      const h = document.createElement('div');
      h.className = 'txt';
      h.style.top = `${top - 24}px`;
      h.textContent = hudText.header;
      hud.appendChild(h);
    }
    return;
  }
  z(0, 0, W, 56 * uiScale);
  z(8, 56 * uiScale + 8, ins.left - 20, Math.min(H * 0.5, 4 * 76 * uiScale));
  z(W - ins.right + 8, 56 * uiScale + 8, ins.right - 16, 160);
  const barW = Math.min(920, W * 0.94);
  z((W - barW) / 2, H - 84 * uiScale - 8, barW, 84 * uiScale);
  const bandW = Math.min(720, W * 0.7);
  const band = z((W - bandW) / 2, H - ins.bottom, bandW, ins.trayBand, 'band');
  if (showHudText && hudText.header) {
    const h = document.createElement('div');
    h.className = 'txt';
    h.style.top = '4px';
    h.textContent = hudText.header;
    band.appendChild(h);
    const r = document.createElement('div');
    r.className = 'txt';
    r.style.bottom = '4px';
    r.style.fontSize = '18px';
    r.textContent = hudText.result;
    band.appendChild(r);
  }
}

// ---------------------------------------------------------------------------
// Event playback (what the controller will do)
// ---------------------------------------------------------------------------

function styleFor(e: GameEvent, s: GameState): 'full' | 'brief' {
  if (styleMode !== 'auto') return styleMode;
  if (e.type === 'diceRolled') return s.players[e.defender].kind === 'human' ? 'full' : 'brief';
  return 'full';
}

async function playEvents(events: GameEvent[], after: GameState): Promise<void> {
  let engagementStyle: 'full' | 'brief' = 'full';
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const o: PlayEventOptions = {};
    if (e.type === 'diceRolled') {
      let j = i;
      while (j > 0 && events[j - 1].type === 'diceRolled') j--;
      let k = i;
      while (k + 1 < events.length && events[k + 1].type === 'diceRolled') k++;
      o.seq = { index: i - j, count: k - j + 1 };
      engagementStyle = styleFor(e, after);
      o.style = engagementStyle;
      if (o.seq.index === 0 && engagementStyle === 'full') {
        const a = after.players[e.player];
        const d = after.players[e.defender];
        void a;
        void d;
        const name = (t: TerritoryId) => t.replace(/_/g, ' ').toUpperCase();
        const shown = (t: TerritoryId) => (view as unknown as { __debug: { armies: Record<string, number> } }).__debug.armies[t];
        hudText = {
          header: `${name(e.from)} ${shown(e.from)}   vs   ${name(e.to)} ${shown(e.to)}`,
          result: '',
        };
        if (showHudText) applyInsets();
      }
      hudText.result =
        e.defenderLosses && e.attackerLosses
          ? 'Each loses 1'
          : e.defenderLosses
            ? `${after.players[e.defender].name} loses ${e.defenderLosses}`
            : `${after.players[e.player].name} loses ${e.attackerLosses}`;
    } else if (e.type === 'territoryConquered' || e.type === 'armiesMoved') o.style = engagementStyle;
    const p = view.playEvent(e, after, o);
    if (e.type === 'diceRolled' && showHudText) setTimeout(applyInsets, 900);
    if (!NON_BLOCKING.has(e.type)) await p;
  }
  // Drift check: before the drain-time sync, the board must already show the engine state.
  const dbg = (view as unknown as { __debug?: { owners: Record<string, number>; armies: Record<string, number> } }).__debug;
  if (dbg) {
    for (const t of TERRITORY_IDS) {
      if (dbg.owners[t] !== after.territories[t].owner || dbg.armies[t] !== after.territories[t].armies) {
        drift.count++;
        if (drift.samples.length < 8) drift.samples.push(`${t}: shown ${dbg.owners[t]}/${dbg.armies[t]} vs ${after.territories[t].owner}/${after.territories[t].armies} after ${events.map((x) => x.type).join(',')}`);
      }
    }
  }
  drift.batches++;
  view.syncState(after);
}
const drift = { count: 0, batches: 0, samples: [] as string[] };

async function act(a: Action): Promise<boolean> {
  const r = applyAction(state, a);
  if (!r.ok) {
    log.push(`rejected ${a.type}: ${r.error}`);
    return false;
  }
  state = r.state;
  await playEvents(r.events, state);
  return true;
}

async function aiStep(): Promise<boolean> {
  if (state.phase.kind === 'game-over') return false;
  const a = chooseAiAction(state, state.currentPlayer);
  return act(a);
}

async function loop(): Promise<void> {
  while (running) {
    if (busy) {
      await sleep(50);
      continue;
    }
    busy = true;
    const ok = await aiStep();
    busy = false;
    if (!ok) {
      running = false;
      break;
    }
    await sleep(state.phase.kind === 'attack' ? 200 : 40);
  }
  render();
}

function players(): PlayerConfig[] {
  const names = ['John', 'Sam', 'Priya', 'Alex'];
  return names.map((name, i) => ({ name, color: DEFAULT_SEAT_COLORS[i], kind: 'ai', difficulty: 'normal' }));
}

async function newGame(seed = Number(params.get('seed') ?? 7), skipDeal = false): Promise<void> {
  const cfg = { ...defaultConfig(players()), seed, dominationPercent: 100, mapId: MAP.id };
  const g = createGame(cfg);
  state = g.state;
  if (skipDeal) {
    view.syncState(state);
    return;
  }
  await playEvents(g.events, state);
}

// ---------------------------------------------------------------------------
// Demos
// ---------------------------------------------------------------------------

/** Advance the AI until the current player is in attack. */
async function toAttack(): Promise<void> {
  for (let n = 0; n < 60 && state.phase.kind !== 'attack'; n++) {
    const a = chooseAiAction(state, state.currentPlayer);
    const r = applyAction(state, a);
    if (!r.ok) break;
    state = r.state;
  }
  view.syncState(state);
}

function bestPair(minFrom = 2): { from: TerritoryId; to: TerritoryId } | null {
  const me = state.currentPlayer;
  let best: { from: TerritoryId; to: TerritoryId; s: number } | null = null;
  for (const t of TERRITORY_IDS) {
    if (state.territories[t].owner !== me || state.territories[t].armies < minFrom) continue;
    for (const to of attackTargets(state, t)) {
      const s = state.territories[t].armies - state.territories[to].armies;
      if (!best || s > best.s) best = { from: t, to, s };
    }
  }
  return best;
}

function force(from: TerritoryId, to: TerritoryId, a: number, d: number): void {
  state = structuredClone(state);
  state.territories[from].armies = a;
  state.territories[to].armies = d;
  view.syncState(state);
}

async function arm(from: TerritoryId, to: TerritoryId, ms = 450): Promise<void> {
  view.setHighlights({
    selected: from,
    targets: attackTargets(state, from),
    arrow: { from, to, kind: 'attack' },
    dimOthers: true,
  });
  await sleep(ms);
}

async function demoRoll(kind: 'single' | 'blitz' | 'conquest' | 'brief', pair?: { from: TerritoryId; to: TerritoryId; a: number; d: number }): Promise<void> {
  busy = true;
  try {
    await toAttack();
    let p = pair ?? null;
    const bp = bestPair();
    if (!p && bp) p = { ...bp, a: kind === 'blitz' || kind === 'brief' ? 13 : kind === 'conquest' ? 9 : 8, d: kind === 'conquest' ? 1 : kind === 'single' ? 4 : 7 };
    if (!p) return;
    force(p.from, p.to, p.a, p.d);
    const prevStyle = styleMode;
    if (kind === 'brief') styleMode = 'brief';
    else if (styleMode === 'brief') styleMode = 'full';
    if (kind !== 'brief') await arm(p.from, p.to);
    const me = state.currentPlayer;
    if (kind === 'single' || kind === 'conquest') await act({ type: 'attack', player: me, from: p.from, to: p.to, dice: 3 });
    else await act({ type: 'blitz', player: me, from: p.from, to: p.to });
    styleMode = prevStyle;
  } finally {
    busy = false;
  }
}

function demoHighlights(kind: string): void {
  const me = state.currentPlayer;
  const mine = TERRITORY_IDS.filter((t) => state.territories[t].owner === me);
  const src = bestPair()?.from ?? mine[0];
  const targets = attackTargets(state, src);
  switch (kind) {
    case 'none':
      view.setHighlights({});
      break;
    case 'selectable':
      view.setHighlights({ selectable: mine.filter((t) => state.territories[t].armies >= 2) });
      break;
    case 'selected':
      view.setHighlights({ selected: src, targets, dimOthers: true });
      break;
    case 'arrow':
      view.setHighlights({ selected: src, targets, arrow: { from: src, to: targets[0], kind: 'attack' }, dimOthers: true });
      break;
    case 'pending': {
      const pend: Partial<Record<TerritoryId, number>> = {};
      mine.slice(0, 3).forEach((t, i) => (pend[t] = [3, 1, 5][i]));
      view.setHighlights({ selectable: mine, pending: pend });
      break;
    }
    case 'fortify': {
      let path: TerritoryId[] | null = null;
      for (const a of mine) {
        for (const b of mine) {
          if (a === b) continue;
          const p = fortifyPath(state, a, b);
          if (p && p.length >= 2 && (!path || p.length > path.length) && p.length <= 5) path = p;
        }
      }
      if (path) view.setHighlights({ selected: path[0], targets: [path[path.length - 1]], arrow: { from: path[0], to: path[path.length - 1], kind: 'fortify', path }, dimOthers: true });
      break;
    }
  }
}

async function demoContinent(): Promise<void> {
  // Player 0 takes South America; player 1 is one short of Australia (classic-rules maps only).
  if (!CONTINENTS.south_america || !CONTINENTS.australia) return;
  busy = true;
  state = structuredClone(state);
  for (const t of CONTINENTS.south_america.territories) state.territories[t].owner = 0;
  const au = CONTINENTS.australia.territories;
  au.forEach((t, i) => (state.territories[t].owner = i === 0 ? 2 : 1));
  for (const t of TERRITORY_IDS) if (state.territories[t].armies < 1) state.territories[t].armies = 1;
  const lastSA = 'brazil';
  const prev = structuredClone(state);
  prev.territories[lastSA].owner = 3;
  view.syncState(prev);
  await sleep(300);
  await view.playEvent({ type: 'territoryConquered', player: 0, from: 'venezuela', to: lastSA, previousOwner: 3 }, state);
  await view.playEvent({ type: 'armiesMoved', player: 0, from: 'venezuela', to: lastSA, count: 1, reason: 'occupy' }, state);
  await view.playEvent({ type: 'continentGained', player: 0, continent: 'south_america' }, state);
  view.syncState(state);
  busy = false;
}

async function demoVictory(): Promise<void> {
  busy = true;
  await view.playEvent({ type: 'gameOver', winner: state.currentPlayer, reason: 'domination' }, state);
  busy = false;
}

async function demoElimination(): Promise<void> {
  busy = true;
  await view.playEvent({ type: 'playerEliminated', player: 1, by: 0 }, state);
  busy = false;
}

/** Every denomination on the board at once: infantry 1–4, cavalry 5–9, artillery 10+ by region. */
function demoDenoms(): void {
  state = structuredClone(state);
  TERRITORY_IDS.forEach((t, i) => {
    const x = BOARD.territories[t].anchor[0];
    state.territories[t].armies = x < 36 ? 1 + (i % 4) : x < 62 ? 5 + (i % 5) : 10 + ((i * 7) % 90);
  });
  view.syncState(state);
}

async function demoPlace(n = 10): Promise<void> {
  const me = state.currentPlayer;
  const mine = TERRITORY_IDS.filter((t) => state.territories[t].owner === me);
  const t = mine[0];
  for (let i = 0; i < n; i++) {
    state = structuredClone(state);
    state.territories[t].armies += 1;
    void view.playEvent({ type: 'armiesPlaced', player: me, territory: t, count: 1, source: 'reinforce' }, state);
    await sleep(140);
  }
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

let speed = Number(params.get('speed') ?? 1);
let reduced = params.get('reduced') === '1';
let labels = params.get('labels') === '1';
let attract = false;

function render(): void {
  const panel = document.getElementById('panel')!;
  if (params.get('panel') === '0') panel.classList.add('hidden');
  const b = (label: string, fn: () => void, on = false) => {
    const el = document.createElement('button');
    el.textContent = label;
    if (on) el.className = 'on';
    el.onclick = () => {
      fn();
      render();
    };
    return el;
  };
  const h = (t: string) => {
    const el = document.createElement('h4');
    el.textContent = t;
    return el;
  };
  panel.innerHTML = '';
  panel.append(
    h('Game'),
    b(running ? 'Pause AI' : 'Run AI', () => {
      running = !running;
      if (running) void loop();
    }, running),
    b('Step', () => void aiStep()),
    b('Skip', () => view.skipAnimations()),
    b('New game', () => void newGame(Math.floor(Math.random() * 1e6))),
    h('Style'),
    ...(['full', 'brief', 'auto'] as const).map((s) => b(s, () => (styleMode = s), styleMode === s)),
    h('Speed'),
    ...[1, 2, 0].map((s) =>
      b(s === 0 ? 'instant' : `${s}×`, () => {
        speed = s;
        view.setAnimationSpeed(s);
      }, speed === s),
    ),
    h('Demos'),
    b('Single roll', () => void demoRoll('single')),
    b('Blitz', () => void demoRoll('blitz')),
    b('Conquest', () => void demoRoll('conquest')),
    b('Brief AI', () => void demoRoll('brief')),
    b('Continent', () => void demoContinent()),
    b('Eliminate', () => void demoElimination()),
    b('Victory', () => void demoVictory()),
    b('Place ×10', () => void demoPlace()),
    b('Denominations', () => demoDenoms()),
    h('Phase'),
    ...(['attack', 'fortify', 'end'] as const).map((k) => b(k, () => view.pulsePhase?.(k))),
    h('Highlights'),
    ...['none', 'selectable', 'selected', 'arrow', 'pending', 'fortify'].map((k) => b(k, () => demoHighlights(k))),
    h('Camera'),
    b('Home', () => view.resetCamera()),
    b('Europe', () => view.focusTerritories(CONTINENTS.europe?.territories ?? TERRITORY_IDS)),
    b('Random', () => view.focusTerritories([TERRITORY_IDS[Math.floor(Math.random() * TERRITORY_IDS.length)]])),
    b('Attract', () => {
      attract = !attract;
      view.setAttractMode(attract);
    }, attract),
    h('View'),
    b('Labels', () => {
      labels = !labels;
      view.setShowLabels(labels);
    }, labels),
    b('Reduced motion', () => {
      reduced = !reduced;
      view.setReducedMotion?.(reduced);
    }, reduced),
    b('HUD text', () => {
      showHudText = !showHudText;
      applyInsets();
    }, showHudText),
    ...Object.keys(PRESETS).map((p) =>
      b(`insets:${p}`, () => {
        preset = p;
        applyInsets();
      }, preset === p),
    ),
    ...[1, 1.25, 1.5].map((s) =>
      b(`ui ${s}`, () => {
        uiScale = s;
        view.setUiScale(s);
        applyInsets();
      }, uiScale === s),
    ),
  );
  const st = document.createElement('div');
  st.id = 'stats';
  panel.append(h('Stats'), st);
}

function statsLoop(): void {
  const el = document.getElementById('stats');
  if (el && view) {
    const s = view.getStats();
    el.textContent = `fps ${s.fps}  p95 ${s.frameMsP95}ms\ncalls ${s.drawCalls}  tris ${(s.triangles / 1000).toFixed(0)}k\ntweens ${s.activeTweens}  cam ${s.cameraMoving ? 'moving' : 'still'}\nparticles ${s.particles}\nround ${state?.round ?? 0}  ${state?.phase.kind ?? ''}`;
  }
  setTimeout(statsLoop, 500);
}

// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  const container = document.getElementById('board')!;
  const t0 = performance.now();
  view = await createBoardView({ container, geometry: BOARD });
  (window as unknown as { __sbBootMs: number }).__sbBootMs = Math.round(performance.now() - t0);
  view.setAnimationSpeed(speed);
  if (params.get('sound') !== '0') view.setAudio?.(createAudio({ volume: 0.8 }));
  view.setShowLabels(labels);
  view.setUiScale(uiScale);
  if (reduced) view.setReducedMotion?.(true);
  applyInsets();
  addEventListener('resize', applyInsets);
  view.onTerritoryClick((i) => {
    log.push(`click ${i.territory} b${i.button}`);
    // Tap / click to pick, as the controller would: the source with its targets, then arm one.
    const hl = lastSbHl;
    if (hl.selected && hl.targets?.includes(i.territory)) {
      lastSbHl = { ...hl, arrow: { from: hl.selected, to: i.territory, kind: 'attack' } };
    } else {
      const targets = attackTargets(state, i.territory);
      lastSbHl = state.territories[i.territory].owner === state.currentPlayer ? { selected: i.territory, targets, dimOthers: true } : {};
    }
    if (params.get('pick') === '1') view.setHighlights(lastSbHl);
  });
  // Long-press name card mock (the HUD renders the real one).
  const card = document.createElement('div');
  Object.assign(card.style, { position: 'fixed', display: 'none', transform: 'translate(-50%, calc(-100% - 28px))', padding: '8px 12px', borderRadius: '12px',
    background: 'rgba(16,19,24,.92)', color: '#f3ead8', font: '600 14px Inter Variable, system-ui', boxShadow: '0 6px 24px rgba(0,0,0,.45)', border: '1px solid rgba(243,234,216,.2)',
    pointerEvents: 'none', zIndex: '20', whiteSpace: 'nowrap' });
  document.body.appendChild(card);
  view.onTerritoryLongPress?.((i) => {
    log.push(i ? `long ${i.territory}` : 'long end');
    if (!i) {
      card.style.display = 'none';
      return;
    }
    const ts = state.territories[i.territory];
    card.textContent = `${i.territory.replace(/_/g, ' ')} · ${state.players[ts.owner]?.name ?? ''} · ${ts.armies}`;
    card.style.left = `${i.clientX}px`;
    card.style.top = `${i.clientY}px`;
    card.style.display = 'block';
  });
  view.onContextLoss?.((lost) => log.push(lost ? 'context lost' : 'context back'));
  view.onTerritoryHover(() => {});
  view.onViewDisplacedChange?.((d) => {
    displaced = d;
    applyInsets();
  });
  document.getElementById('hud')!.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).dataset.reset) view.resetCamera();
  });
  render();
  statsLoop();
  await newGame(Number(params.get('seed') ?? 7), params.get('deal') === '0');
  if (params.get('run') === '1') {
    running = true;
    void loop();
    render();
  }
  (window as unknown as { __sb: unknown }).__sb = {
    view,
    get state() {
      return state;
    },
    set state(s: GameState) {
      state = s;
    },
    act,
    aiStep,
    newGame,
    toAttack,
    bestPair,
    force,
    arm,
    demoRoll,
    demoHighlights,
    demoContinent,
    demoVictory,
    demoElimination,
    demoPlace,
    demoDenoms,
    playEvents,
    log,
    drift,
    setRunning(on: boolean) {
      running = on;
      if (on) void loop();
    },
    setStyle(s: 'full' | 'brief' | 'auto') {
      styleMode = s;
    },
    setPreset(p: string) {
      preset = p;
      applyInsets();
    },
    setHudText(on: boolean) {
      showHudText = on;
      applyInsets();
    },
    get busy() {
      return busy;
    },
    PLAYER_COLORS,
    ADJACENCY,
  };
  (window as unknown as { __sbReady: boolean }).__sbReady = true;
}

boot().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<pre style="color:#f88;position:fixed;left:8px;bottom:8px">${String(e?.stack ?? e)}</pre>`);
});
