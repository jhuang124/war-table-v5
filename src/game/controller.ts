// The game controller (SPEC §7 Controller, UX.md [ctrl]).
//
// Owns the GameState, applies actions through the engine, queues the resulting events and plays them
// on the board one at a time, keeps a *displayed* state that follows the board (no spoilers), runs the
// input state machine and the keyboard map, drives the AI as a highlight reel, writes every line of
// copy into the ViewModel, autosaves, and exposes the window.__risk hooks.
//
// Flow:  input/AI → applyAction → queue entries {event, stateAfter}
//        → pump: board.playEvent (blocking events awaited, non-blocking fired) → display delta + HUD
//        → queue empty: pending click-through inputs run; all settled: syncState, next AI beat.

import {
  CONTINENTS,
  CONTINENT_IDS,
  TERRITORIES,
  TERRITORY_IDS,
  UNCLAIMED,
  applyAction,
  attackSources,
  attackTargets,
  chooseAiAction,
  cloneState,
  createGame,
  fallbackAction,
  fortifyPath,
  fortifySources,
  fortifyTargets,
  maxAttackDice,
  reinforcementsFor,
  territoriesNeeded,
  territoryCount,
  totalArmies,
  validateConfig,
  winProbability,
  PERSONALITIES,
  PERSONALITY_IDS,
  grudgesOf,
  isPersonality,
  truceOffersTo,
  truceSentence,
  truceTargets,
  type Action,
  type AiPersonality,
  type ActionResult,
  type GameConfig,
  type GameEvent,
  type GameState,
  type AiDifficulty,
  type PlayerConfig,
  type PlayerKind,
  type PlayerId,
  type TerritoryId,
} from '../engine';
import { DEFAULT_MAP_ID, activeMapId, isKnownMap, listMaps } from '../map/registry';
import type { AudioEngine, PlayOptions, SfxName } from '../audio/types';
import type { BoardHighlights, BoardView, PlayEventOptions, TerritoryPointerInfo, ViewportInsets } from '../render/BoardView';
import { buildStrip, buildTrack, emptySel, placeLeft, placeValue, selectionTargets, stagedTotal, trackLockReason, type Placement, type Sel } from './strip';
import { SEP, armies, cName, click, pName, pct, poss, seatRef, setTouchCopy, tName, upper } from './copy';
import { createHaptics, type Haptics } from './haptics';
import { applyEventToDisplay, isBlocking } from './display';
import { explainTerritory, type ClickPlan, type ExplainUi, type Explanation } from './explain';
import { autoChain, bestSet, noSetStatus, occupyDefault } from './helpers';
import {
  addSeat,
  buildNewGameVM,
  defaultDraft,
  draftToConfig,
  lengthRules,
  patchSeat,
  removeSeat,
  sanitizeDraft,
  trucesApply,
  type NewGameDraft,
} from './presets';
import { reconcile } from './reconcile';
import { effectiveUiScale } from '../ui/uiScale';
import { buildAwards, buildRecap, emptyAwards, recordAward, recordRecap, type AwardLedger, type RecapLedger } from './recap';
import {
  DEFAULT_SETTINGS,
  SAVE_KEY,
  SETTINGS_KEY,
  TEXT_SCALE,
  UI_KEY,
  browserKV,
  isPlausibleState,
  readJson,
  sanitizeSettings,
  SETTINGS_VERSION,
  writeJson,
  type KV,
  type SaveFile,
} from './storage';
import type {
  AiSpeed,
  BannerVM,
  BattleVM,
  ButtonId,
  ButtonVM,
  CardsVM,
  ControllerApi,
  GameVM,
  GoldVM,
  LogLineVM,
  NameCardVM,
  Overlay,
  SeatDraft,
  Screen,
  SeatChipVM,
  Settings,
  StripVM,
  TrackSegId,
  UiIntent,
  ViewModel,
  VictoryVM,
  NewGameVM,
} from './viewModel';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  raf(fn: () => void): void;
}

export interface ControllerOptions {
  board: BoardView;
  audio: AudioEngine;
  storage?: KV;
  clock?: Clock;
  /** Install window listeners (keyboard map, click metrics). Default: true when `window` exists. */
  dom?: boolean;
  /** OS-level reduced motion; default reads matchMedia. */
  prefersReducedMotion?: () => boolean;
  /**
   * Also handle menu/overlay keys (Esc on overlays and confirms, Enter on the hand-off, title, new game
   * and victory). Off when src/ui is mounted (it owns those); on for the fallback debug HUD.
   */
  menuKeys?: boolean;
  /**
   * A touch device (pointer: coarse; docs/MOBILE.md): the hand-off cover defaults on, haptics play, the
   * long-press name card replaces hover. Default false (desktop, Node tests).
   */
  touch?: boolean;
  /**
   * Reload the page (v3 map packs: a game on another map than the page booted on starts after a reload,
   * because the board's geometry is fixed per page load; and a new build taking over reloads). Default: in
   * a browser, `location` with any `?map=` dropped (the save decides the map); absent in Node tests, where
   * a game on another map just starts on the booted board.
   */
  reload?: () => void;
  /** The map the board was booted on (default: src/map/registry.ts activeMapId()). */
  bootMap?: string;
}

/** A finished or live draw-to-attack stroke (BoardView.onStroke, docs/INK.md A2). */
type StrokeInfo = { from: TerritoryId; to: TerritoryId | null; done: boolean };

/** Additive board members from the mobile renderer pass (docs/MOBILE.md §3); used when present. */
interface TouchBoard {
  /** Long-press (≈ 400 ms) on a territory: the name card. null = released / cancelled. */
  onTerritoryLongPress?(cb: (info: TerritoryPointerInfo | null) => void): void;
  /** The WebGL context was lost (true) / the board has drawn again (false). */
  onContextLoss?(cb: (lost: boolean) => void): void;
}

export interface TurnMetric {
  player: PlayerId;
  kind: 'human' | 'ai';
  ms: number;
  clicks: number;
  rejected: number;
  forcedWaitMs: number;
}

export interface RollMetric {
  blitz: boolean;
  count: number;
  ms: number;
  style: 'full' | 'brief' | 'readable';
}

export interface Metrics {
  turns: TurnMetric[];
  rolls: RollMetric[];
  maxCameraDegPerSec: number;
  cameraMovesDuringHumanInput: number;
  inputDropped: number;
}

export interface UiSnapshot {
  screen: string;
  /** The Turn Track segment the marker is on: 'Place' | 'Attack' | 'Fortify' | 'Setup' ('' at game over). */
  step: string;
  /** Every track segment, 'state:id' in order, e.g. ['done:place', 'current:attack', 'eligible:fortify', 'eligible:endTurn']. */
  track: string[];
  /** The glowing recommended segment's id, or null. */
  recommended: string | null;
  /** Whose marker is on the track (seat name). */
  trackSeat: string;
  /** The driver can click the track / it's visibly disabled. */
  trackLive: boolean;
  trackDisabled: boolean;
  /** The one gold thing's label (GameVM.gold: a button, a track segment, the cards trade); [] when none. */
  brass: string[];
  /** The bottom strip's one line. */
  line: string;
  lineKind: string;
  /** The brass button's label. */
  primary: string | null;
  /** Every strip button label, in reading order. */
  buttons: string[];
  count: { control: string; value: number; min: number; max: number } | null;
  /** The banner on screen: its title (and sub line). */
  banners: string[];
  recap: string | null;
  /** The dice tray header: 'URAL 12 vs SIBERIA 5'. */
  battle: { header: string } | null;
  /** Top chips: 'John 14'. */
  seats: string[];
  cardsOpen: boolean;
  /** The `Reset view` pill is showing. */
  viewMoved: boolean;
  /** The one gold element (GameVM.gold): 'button:blitz' · 'segment:attack' · 'cardsTrade' · 'handoff', or null. */
  gold: string | null;
  /** The banner's serif line ('John · 3 armies', 'Sam · taken by John · round 9'), or null. */
  bannerLine: string | null;
}

export interface RiskHooks {
  getState(): GameState | null;
  newGame(config?: Partial<GameConfig> & { players?: PlayerConfig[] }): void;
  dispatch(action: Action): { ok: boolean; error?: string };
  isIdle(): boolean;
  waitIdle(timeoutMs?: number): Promise<void>;
  setSpeed(animation: number, ai?: AiSpeed): void;
  autoplay(on: boolean): void;
  screenPos(t: TerritoryId): { x: number; y: number } | null;
  stats(): ReturnType<BoardView['getStats']>;
  ui(): UiSnapshot;
  explain(t: TerritoryId): { ok: boolean; code?: string; text: string };
  /** Additive (v3): the ledger (the log), oldest first. */
  ledger(): { id: number; round: number; kind: string; text: string }[];
  /** Additive (v3 map packs): the map pack this page's board was booted on. */
  map(): string;
  metrics(): Metrics;
  resetMetrics(): void;
}

export interface GameController extends ControllerApi {
  hooks: RiskHooks;
  dispose(): void;
  /** The in-game key handler without a DOM (unit tests); the browser path goes through keydown. */
  handleKey(key: string, repeat?: boolean): boolean;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface Entry {
  ev: GameEvent;
  after: GameState;
  /** Last event of its action: the display snaps to `after`. */
  end: boolean;
  opts?: PlayEventOptions;
  beat: number;
  /** HUD only, no board animation (instant AI turns). */
  skip?: boolean;
  /** Stagger before firing (AI placement beats). */
  delayMs?: number;
  ai: boolean;
  /** Board speed for this entry (compressed AI-vs-AI engagements); default = the seat's speed. */
  speed?: number;
}

interface Engagement {
  attacker: PlayerId;
  defender: PlayerId;
  from: TerritoryId;
  to: TerritoryId;
  startA: number;
  startD: number;
  rolls: number;
  attLost: number;
  defLost: number;
  blitz: boolean;
  winP: number;
  style: 'full' | 'brief' | 'readable';
  conquered: boolean;
  startedAt: number;
  lastRollEnd: number;
  logId: number;
  endedAt: number | null;
  turn: number;
  /** An upset: a note on the log line (and an award entry), never a banner. */
  upset?: string | null;
  /** The decided fight's header was dismissed early (a new selection, a phase change). */
  cleared?: boolean;
}

interface BannerItem {
  vm: BannerVM;
  createdAt: number;
  sound?: { name: SfxName; opts?: PlayOptions };
}

interface AiTurnCtx {
  key: string;
  player: PlayerId;
  startedAt: number;
  first: boolean;
  /** AI-vs-AI engagements played this turn (headline compression from the 3rd). */
  briefCount: number;
  /** Past the cap: the rest of the turn plays at instant. */
  capped: boolean;
  /** 10 s normally; 5 s for opening turns before any human has played (Start → first click ≤ 20 s). */
  capMs: number;
  headlineMs: number;
  /** The n-th AI-vs-AI engagement of the turn from which they play at 2×. */
  compressFrom: number;
  /** Full-dice fights against a human played this turn (capped at AI_FULL_FIGHTS_PER_TURN). */
  fullCount: number;
}

interface GameMeta {
  id: string;
  recap: RecapLedger;
  awards: AwardLedger;
  log: LogLineVM[];
  logId: number;
  /** Seats already logged as within 5 of victory. */
  nearGoal: number[];
  finalRoundShown: boolean;
  sel: Sel;
  lastTurnKind: 'human' | 'ai' | null;
  /** Who knocked each seat out, and in which round (the empty seat ring, docs/INK.md A5). */
  out?: Record<number, { by: PlayerId; round: number }>;
}

interface UiFile {
  v: 1;
  lastSetup?: NewGameDraft;
  game?: GameMeta;
}

const defaultClock = (): Clock => ({
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  raf: (fn) => {
    if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(() => fn());
    else setTimeout(fn, 16);
  },
});

const THINK_TURN_START = 350;
const THINK_BETWEEN = 200;
/** Between AI-vs-AI engagements once they run compressed (the 3rd+ in a turn, or past the headline point). */
const THINK_BETWEEN_COMPRESSED = 140;
/** The beat after a snapped AI-vs-AI conquest (a human's instant speed keeps 250 ms, UX.md §8.2). */
const SNAP_BEAT_MS = 170;
const AI_TURN_CAP_MS = 10_000;
/** Past this point in an AI turn, AI-vs-AI engagements snap; fights against a human keep their weight. */
const AI_HEADLINE_MS = 6_000;
/** From round 4 the board is crowded and turns run long: the headline point comes sooner. */
const AI_HEADLINE_LATE_MS = 4_000;
const AI_HEADLINE_LATE_ROUND = 4;
/** Full-dice fights against a human per AI turn; later ones play brief (arrow, ticks, flip, one log line). */
const AI_FULL_FIGHTS_PER_TURN = 2;
/** Round-1 AI turns before any human has moved: nothing is at stake yet, so they stay short. */
const AI_OPENING_CAP_MS = 5_000;
const TELEGRAPH_MS = 400;
const PLAY_SAFETY_MS = 15_000;
/** A refused click's reason holds the line this long. */
const REJECT_MS = 2000;
/** A decided fight's tray header ('Siberia captured') stays this long, then fades (docs/ROUND2.md §E). */
const LINGER_MS = 1000;
const LOG_CAP = 300;

function freshMeta(id: string): GameMeta {
  return {
    id,
    recap: {},
    awards: emptyAwards(),
    log: [],
    logId: 1,
    nearGoal: [],
    finalRoundShown: false,
    sel: emptySel(),
    lastTurnKind: null,
  };
}

/** A saved meta from this or an older build: keep the fields that still exist and are well-formed. */
function restoreMeta(id: string, saved: Partial<GameMeta> | undefined): GameMeta {
  const m = freshMeta(id);
  if (!saved || saved.id !== id) return m;
  if (saved.recap && typeof saved.recap === 'object') {
    for (const [k, v] of Object.entries(saved.recap)) if (v && typeof v === 'object' && v.lost && typeof v.lost === 'object') m.recap[Number(k)] = { lost: v.lost };
  }
  if (saved.awards && typeof saved.awards === 'object') m.awards = { ...m.awards, ...saved.awards };
  if (Array.isArray(saved.log)) m.log = saved.log.map((l) => ({ id: l.id, round: l.round, seat: l.seat, kind: l.kind, text: l.text }));
  if (typeof saved.logId === 'number') m.logId = saved.logId;
  if (Array.isArray(saved.nearGoal)) m.nearGoal = saved.nearGoal;
  m.finalRoundShown = !!saved.finalRoundShown;
  m.lastTurnKind = saved.lastTurnKind ?? null;
  m.sel = restoreSel(saved.sel);
  if (saved.out && typeof saved.out === 'object') {
    m.out = {};
    for (const [k, v] of Object.entries(saved.out)) if (v && typeof v.by === 'number' && typeof v.round === 'number') m.out[Number(k)] = { by: v.by, round: v.round };
  }
  return m;
}

function restoreSel(x: unknown): Sel {
  const sel = emptySel();
  if (!x || typeof x !== 'object') return sel;
  const o = x as Partial<Sel>;
  const tid = (t: unknown): TerritoryId | null => (typeof t === 'string' && (TERRITORY_IDS as readonly string[]).includes(t) ? (t as TerritoryId) : null);
  const num = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) ? n : null);
  sel.selected = tid(o.selected);
  sel.target = tid(o.target);
  sel.placeCount = num(o.placeCount);
  sel.occupyCount = num(o.occupyCount);
  sel.fortifyCount = num(o.fortifyCount);
  if (o.staged && typeof o.staged === 'object') {
    for (const [t, n] of Object.entries(o.staged)) if (tid(t) && typeof n === 'number' && n > 0) sel.staged[t as TerritoryId] = n;
  }
  if (Array.isArray(o.placements)) {
    sel.placements = o.placements.filter((p): p is Placement => !!p && typeof p === 'object' && !!tid(p.t) && typeof p.n === 'number' && p.n > 0);
  }
  return sel;
}

/** Optional renderer extension: the resulting totals drawn on the pieces while a count is chosen. */
type PreviewBoard = BoardView & { setCountPreview?: (totals: Partial<Record<TerritoryId, number>> | null) => void };

function isAttackAction(a: Action): a is Extract<Action, { type: 'attack' | 'blitz' }> {
  return a.type === 'attack' || a.type === 'blitz';
}

// ---------------------------------------------------------------------------
// v3 New game extras: the map, seat personalities, Neutral armies, Truces
// ---------------------------------------------------------------------------

/** One boot-time instruction across a reload (a game on another map; a Continue onto another map). */
const BOOT_KEY = 'risk3d.boot.v1';
type BootFile = { v: 1; start?: GameConfig; resume?: boolean };

/** Diplomacy events: HUD only (display.ts lists them non-blocking; the board is never asked to play them). */
const TRUCE_EVENTS: ReadonlySet<GameEvent['type']> = new Set(['truceProposed', 'truceAccepted', 'truceDeclined', 'truceBroken', 'truceExpired']);

/** A truce the dock offers: 3 rounds, no attacks (the one kind the engine knows). */
const TRUCE_ROUNDS = 3;

/** Reload this page onto whatever the save says (a `?map=` override is dropped: the save decides). */
function reloadPage(): void {
  const u = new URL(location.href);
  if (u.searchParams.has('map')) {
    u.searchParams.delete('map');
    location.replace(u.toString());
  } else location.reload();
}

/** The New game screen's v3 fields: the map picker, the personalities, which house rules apply. */
function newGameExtras(d: NewGameDraft): Pick<NewGameVM, 'maps' | 'mapId' | 'personalities' | 'neutralApplies' | 'trucesApply'> {
  const n = d.seats.length;
  return {
    maps: listMaps().map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      seats: m.seats.min === m.seats.max ? `${m.seats.min} players` : `${m.seats.min}–${m.seats.max} players`,
      thumbnail: m.thumbnail,
      disabled: n < m.seats.min || n > m.seats.max,
    })),
    mapId: d.mapId ?? DEFAULT_MAP_ID,
    personalities: PERSONALITY_IDS.map((id) => ({ id, name: PERSONALITIES[id].name, line: PERSONALITIES[id].line })),
    neutralApplies: n === 2,
    trucesApply: trucesApply(d.seats),
  };
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

class Controller {
  readonly board: BoardView;
  readonly audio: AudioEngine;
  private kv: KV;
  private clock: Clock;
  private prefersReduced: () => boolean;
  private menuKeys: boolean;
  private touch: boolean;
  private haptics: Haptics;
  /** The long-press name card (touch), or null. */
  private nameCard: NameCardVM | null = null;
  /** The board's WebGL context is lost and rebuilding. */
  private boardLost = false;
  /** The board's dice tray is showing (onTrayChange). */
  private trayUp = false;
  private disposers: (() => void)[] = [];

  // App
  private screen: Screen = 'title';
  private overlay: Overlay = null;
  private overlayReturn: Overlay = null;
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private draft: NewGameDraft = defaultDraft();
  /** v3 diplomacy: the driver tapped `Truce` and is choosing a seat (the eligible rings are lit). */
  private truceMode = false;
  /** v3: a new build took over (service worker controllerchange) while a game is on. */
  private updateReady = false;
  private reloadFn: (() => void) | null;
  /** The map this page's board was booted on. */
  readonly bootMap: string;
  private saveSummary: { summary: string } | null = null;
  private sessionAiSpeed: AiSpeed | null = null;
  private autoplayOn = false;

  // Game
  private state: GameState | null = null;
  private disp: GameState | null = null;
  private meta: GameMeta | null = null;
  private sel: Sel = emptySel();
  private frozenSel: Sel | null = null;
  private victory: VictoryVM | null = null;
  private confirm: GameVM['confirm'] = null;
  private allHumansOut = false;
  private allHumansOutDismissed = false;
  private cardsOpen = false;
  /** The player orbited / zoomed away from the home view (the `Reset view` pill). */
  private viewMoved = false;
  /** The last conquest on the displayed board: a continent banner needs a human in it. */
  private lastConquest: { attacker: PlayerId; victim: PlayerId } | null = null;
  /** Per seat, bumps as each of its territories falls on the board (SeatChipVM.lostKey, the A5 ring dim). */
  private lostKeys: Record<number, number> = {};
  /** The draw-to-attack sources last handed to the board (change detection). */
  private lastStrokeKey = '';

  // Queue
  private queue: Entry[] = [];
  private pumping = false;
  private blockingNow: Entry | null = null;
  private inflight = 0;
  private skipAll = false;
  private skipBeat: number | null = null;
  private beat = 1;
  private currentBeat = 0;
  private boardStale = false;
  private pendingInputs: { fn: () => void; at: number }[] = [];
  private sleepers = new Set<() => void>();
  private handoff: { player: PlayerId } | null = null;
  private rolling = false;
  /** A draw-to-attack stroke is being drawn (the board's gold stroke is the one gold). */
  private strokeLive = false;
  /** Bumps on every new/loaded game so stale async work drops out. */
  private epoch = 0;

  // AI
  private aiBusy = false;
  private aiCtx: AiTurnCtx | null = null;
  private aiHighlights: BoardHighlights | null = null;
  private aiPreview: { from: TerritoryId; to: TerritoryId } | null = null;
  private narration: string | null = null;
  /** Armies an AI has placed so far this turn / setup turn (the narration counts them up). */
  private narrPlaced = 0;
  private aiScheduled = false;
  /** A human seat has started a main turn this game (ends the short "opening" AI turns). */
  private humanHasPlayed = false;

  // Presentation
  private eng: Engagement | null = null;
  private banner: BannerItem | null = null;
  private bannerQueue: BannerItem[] = [];
  private bannerNextAt = 0;
  private bannerTimer: unknown = null;
  private turnBanner: BannerVM | null = null;
  private turnBannerTimer: unknown = null;
  private idSeq = 1;
  private rejection: { text: string; key: number; until: number; code: string } | null = null;
  private lineKey = 0;
  private lastHighlightsKey = '';
  private insets: ViewportInsets = { top: 0, right: 0, bottom: 0, left: 0, trayBand: 0 };

  // Timing guards
  private guardUntil = 0;
  private holdUntil = 0;
  private spaceGuardUntil = 0;

  // Metrics
  private metricTurns: TurnMetric[] = [];
  private curTurn: (TurnMetric & { start: number }) | null = null;
  private metricRolls: RollMetric[] = [];
  private inputDropped = 0;
  private cameraMovesDuringHumanInput = 0;
  private lastCameraMoving = false;
  private humanInputSince = 0;
  private pointerActiveUntil = 0;

  // VM
  private vm: ViewModel;
  private dirty = true;
  private rafPending = false;
  private subs = new Set<(vm: ViewModel) => void>();
  private lastNotified: ViewModel | null = null;
  private lastBoardSpeed = -1;

  constructor(opts: ControllerOptions) {
    this.board = opts.board;
    this.audio = opts.audio;
    this.kv = opts.storage ?? browserKV();
    this.clock = opts.clock ?? defaultClock();
    this.prefersReduced =
      opts.prefersReducedMotion ??
      (() => {
        try {
          return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
        } catch {
          return false;
        }
      });
    this.menuKeys = opts.menuKeys ?? false;
    this.touch = opts.touch ?? false;
    setTouchCopy(this.touch);
    this.haptics = createHaptics(this.touch);
    this.settings = sanitizeSettings(readJson(this.kv, SETTINGS_KEY), this.touch);
    const ui = readJson<UiFile>(this.kv, UI_KEY);
    if (ui?.lastSetup) this.draft = sanitizeDraft(ui.lastSetup);
    this.bootMap = opts.bootMap ?? activeMapId();
    this.reloadFn = opts.reload ?? (typeof location !== 'undefined' && typeof window !== 'undefined' ? () => reloadPage() : null);
    this.refreshSaveSummary();

    this.board.onTerritoryClick((info) => this.onBoardClick(info));
    // Draw-to-attack (docs/INK.md A2): a finished stroke arms exactly like a target-first tap.
    this.board.onStroke?.((st) => this.onStroke(st));
    // The `Reset view` pill follows the board's own notion of "off home" when it has one.
    this.board.onViewDisplacedChange?.((moved) => {
      if (moved === this.viewMoved) return;
      this.viewMoved = moved && this.screen === 'game';
      this.invalidate();
    });
    // The tray started fading: a decided fight's header fades with it.
    this.board.onTrayChange?.((visible) => {
      this.trayUp = visible;
      if (!visible) this.clearLinger();
      this.invalidate();
    });
    // Only to tell an ocean click from a click on land (the board names hovered tiles itself).
    this.board.onTerritoryHover((info) => (this.overTile = info?.territory ?? null));
    (this.board as BoardView & TouchBoard).onTerritoryLongPress?.((info) => this.onLongPress(info));
    (this.board as BoardView & TouchBoard).onContextLoss?.((lost) => {
      this.boardLost = lost;
      if (lost) this.hideNameCard();
      this.invalidate();
    });
    this.applySettingsToBoard();
    this.board.setAttractMode(true);
    this.vm = this.buildVM();

    const dom = opts.dom ?? typeof window !== 'undefined';
    if (dom && typeof window !== 'undefined') this.installDom();
    this.sampleCamera();
    // A game started (or continued) on another map reloaded the page onto it: pick up where it left off,
    // once the UI has mounted.
    const boot = readJson<BootFile>(this.kv, BOOT_KEY);
    if (boot) {
      this.kv.remove(BOOT_KEY);
      this.timer(() => this.runBoot(boot), 0);
    }
  }

  private runBoot(boot: BootFile): void {
    if (boot.start && (boot.start.mapId ?? DEFAULT_MAP_ID) === this.bootMap) {
      this.startGame(boot.start);
      this.invalidate();
      return;
    }
    if (boot.resume && !this.loadSave()) this.refreshSaveSummary();
    this.invalidate();
  }

  /** The page was booted on its board by an explicit `?map=` (dev server and e2e builds only). */
  private mapFromUrl(): boolean {
    try {
      return typeof location !== 'undefined' && new URLSearchParams(location.search).get('map') === this.bootMap;
    } catch {
      return false;
    }
  }

  /** Reload onto the map in `mapId` (the page's board is fixed per load). False when this build can't reload. */
  private reloadOnto(boot: BootFile): boolean {
    if (!this.reloadFn) return false;
    writeJson(this.kv, BOOT_KEY, boot);
    this.reloadFn();
    return true;
  }

  // =========================================================================
  // Timers & scheduling
  // =========================================================================

  private now(): number {
    return this.clock.now();
  }

  private timer(fn: () => void, ms: number): unknown {
    return this.clock.setTimeout(fn, Math.max(0, ms));
  }

  /** Cancellable sleep: skip() wakes every sleeper. */
  private sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.sleepers.delete(finish);
        resolve();
      };
      this.sleepers.add(finish);
      this.timer(finish, ms);
    });
  }

  private wakeAll(): void {
    for (const w of [...this.sleepers]) w();
  }

  invalidate(): void {
    this.dirty = true;
    if (this.rafPending) return;
    this.rafPending = true;
    this.clock.raf(() => {
      this.rafPending = false;
      this.flush();
    });
  }

  private flush(): void {
    if (this.dirty) {
      this.vm = reconcile(this.vm, this.buildVM());
      this.dirty = false;
      this.pushHighlights();
    }
    // getViewModel() may have rebuilt already this frame; subscribers still hear about it once.
    if (this.vm === this.lastNotified) return;
    this.lastNotified = this.vm;
    for (const fn of this.subs) {
      try {
        fn(this.vm);
      } catch (e) {
        console.error(e);
      }
    }
  }

  getViewModel(): ViewModel {
    if (this.dirty) {
      this.vm = reconcile(this.vm, this.buildVM());
      this.dirty = false;
      this.pushHighlights();
    }
    return this.vm;
  }

  subscribe(fn: (vm: ViewModel) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  // =========================================================================
  // Settings
  // =========================================================================

  private reducedMotion(): boolean {
    return this.settings.reduceMotion || this.prefersReduced();
  }

  private applySettingsToBoard(): void {
    const b = this.board;
    b.setShowLabels(this.settings.showLabels);
    this.lastBoardUiScale = this.boardUiScale();
    b.setUiScale(this.lastBoardUiScale);
    b.setReducedMotion?.(this.reducedMotion());
    b.setAutoCamera?.(this.settings.autoCamera);
    this.audio.setVolume(this.settings.sfxVolume);
    this.audio.setMuted(this.settings.muted);
    this.audio.setMusic(this.settings.music);
    this.audio.setMusicVolume?.(this.settings.musicVolume ?? 0.7);
    // The living board (A1): off under reduced motion, whether that's the setting or the OS.
    b.setAmbient?.((this.settings.ambient ?? true) && !this.reducedMotion());
    this.applyBoardSpeed();
  }

  /** The text size fitted to this screen (UX.md §10.3), so badges and dice match the HUD and tray band. */
  private boardUiScale(): number {
    if (typeof window === 'undefined' || !window.innerWidth) return TEXT_SCALE[this.settings.textSize];
    return effectiveUiScale(this.settings.textSize, window.innerWidth, window.innerHeight);
  }

  private lastBoardUiScale = -1;
  private onResizeUiScale = (): void => {
    const s = this.boardUiScale();
    if (s === this.lastBoardUiScale) return;
    this.lastBoardUiScale = s;
    this.board.setUiScale(s);
  };

  private aiSpeed(): AiSpeed {
    return this.sessionAiSpeed ?? this.settings.aiSpeed;
  }

  /** Board speed follows whoever is playing: the human setting on human turns, the AI speed on AI turns. */
  private seatSpeed(): number {
    const s = this.disp;
    if (s && s.phase.kind !== 'game-over' && this.isAiDriven(s.currentPlayer)) {
      const ai = this.aiSpeed();
      return ai === 'fast' ? 2 : ai === 'instant' ? 0 : 1;
    }
    return this.settings.animationSpeed;
  }

  private setBoardSpeed(speed: number): void {
    if (speed !== this.lastBoardSpeed) {
      this.lastBoardSpeed = speed;
      this.board.setAnimationSpeed(speed);
    }
  }

  private applyBoardSpeed(): void {
    this.setBoardSpeed(this.seatSpeed());
  }

  private setSettings(patch: Partial<Settings>): void {
    this.settings = sanitizeSettings({ ...this.settings, ...patch, v: SETTINGS_VERSION }, this.touch);
    writeJson(this.kv, SETTINGS_KEY, { ...this.settings, v: SETTINGS_VERSION });
    if (patch.aiSpeed) this.sessionAiSpeed = null;
    this.applySettingsToBoard();
    this.invalidate();
  }

  // =========================================================================
  // Seat helpers
  // =========================================================================

  private isAiDriven(p: PlayerId): boolean {
    const s = this.state;
    if (!s) return false;
    return this.autoplayOn || s.players[p]?.kind === 'ai';
  }

  private isHumanSeat(p: PlayerId, s: GameState | null = this.disp): boolean {
    return !!s && s.players[p]?.kind === 'human';
  }

  /** The driver may act on the board now. */
  private interactive(): boolean {
    const s = this.state;
    if (!s || this.screen !== 'game' || this.handoff) return false;
    if (s.phase.kind === 'game-over') return false;
    return !this.isAiDriven(s.currentPlayer);
  }

  private humanCount(s: GameState, aliveOnly = false): number {
    return s.players.filter((p) => p.kind === 'human' && (!aliveOnly || !p.eliminated)).length;
  }

  // =========================================================================
  // Game lifecycle
  // =========================================================================

  /** The game's seed (config.seed): the ensō is drawn from it and the score is seeded by it (INK A4). */
  private gameSeed(s: GameState): number {
    const v = Number(s.config.seed);
    return Number.isFinite(v) ? v >>> 0 : 0;
  }

  private seedScore(s: GameState): void {
    this.audio.setMusicSeed?.(this.gameSeed(s));
  }

  private randomSeed(): number {
    return Math.floor(Math.random() * 0x100000000) >>> 0;
  }

  startGame(config: GameConfig): void {
    const problem = validateConfig(config);
    if (problem) {
      console.warn('[risk] new game refused:', problem);
      return;
    }
    const { state, events } = createGame(config);
    this.resetGameLocals();
    this.state = state;
    this.meta = freshMeta(state.id);
    this.seedScore(state);
    // The deal plays from an empty board.
    const blank = cloneState(state);
    for (const t of TERRITORY_IDS) blank.territories[t] = { owner: UNCLAIMED, armies: 0 };
    blank.round = 0;
    blank.turn = 0;
    blank.currentPlayer = state.firstPlayer;
    blank.phase = { kind: 'setup-claim' };
    this.disp = blank;
    // Whatever the last game was still animating (its victory wave, a march) ends here, before the deal.
    this.board.skipAnimations();
    this.board.setAttractMode(false);
    this.board.syncState(blank);
    this.screen = 'game';
    this.overlay = null;
    this.victory = null;
    this.save();
    this.enqueue(
      events.map((ev, i) => ({ ev, after: state, end: i === events.length - 1 })),
      { ai: false },
    );
    this.invalidate();
  }

  private resetGameLocals(): void {
    this.epoch++;
    this.humanHasPlayed = false;
    this.queue = [];
    this.skipAll = false;
    this.skipBeat = null;
    this.pendingInputs = [];
    this.wakeAll();
    this.sel = emptySel();
    this.frozenSel = null;
    this.eng = null;
    this.banner = null;
    this.bannerQueue = [];
    this.turnBanner = null;
    this.rejection = null;
    this.handoff = null;
    this.aiCtx = null;
    this.aiHighlights = null;
    this.aiPreview = null;
    this.narration = null;
    this.confirm = null;
    this.allHumansOut = false;
    this.allHumansOutDismissed = false;
    this.cardsOpen = false;
    this.viewMoved = false;
    this.lastConquest = null;
    this.lostKeys = {};
    this.sessionAiSpeed = null;
    this.curTurn = null;
    this.lastBoardSpeed = -1;
    this.truceMode = false;
  }

  private loadSave(): boolean {
    const f = readJson<SaveFile>(this.kv, SAVE_KEY);
    if (!f || !isPlausibleState(f.state) || f.state.phase.kind === 'game-over') return false;
    const s = f.state;
    this.resetGameLocals();
    this.state = s;
    this.disp = cloneState(s);
    this.seedScore(s);
    const ui = readJson<UiFile>(this.kv, UI_KEY);
    this.meta = restoreMeta(s.id, ui?.game);
    this.sel = this.meta.sel;
    this.validateSel();
    if (s.phase.kind === 'occupy' && this.sel.occupyCount === null) {
      this.sel.occupyCount = occupyDefault(s, s.phase.from, s.phase.to, s.phase.min, s.phase.max);
    }
    this.board.skipAnimations();
    this.board.setAttractMode(false);
    this.board.syncState(s);
    this.screen = 'game';
    this.overlay = null;
    this.victory = null;
    this.applyBoardSpeed();
    this.humanHasPlayed = s.round > 1 || !!this.meta.lastTurnKind;
    // A fresh turn banner so the room knows whose turn it is (the army count only when it's still true).
    if (s.round > 0 && !this.isAiDriven(s.currentPlayer)) {
      const ph = s.phase;
      const fresh = ph.kind === 'reinforce' && !ph.midTurn && Object.keys(ph.placed).length === 0;
      this.showTurnBanner(s.currentPlayer, fresh ? reinforcementsFor(s, s.currentPlayer).total : null, null, s);
    }
    if (s.round > 0) this.openTurnMetric(s.currentPlayer);
    this.invalidate();
    this.afterSettled();
    return true;
  }

  /** Drop a restored selection that no longer makes sense for the state. */
  private validateSel(): void {
    const s = this.state;
    if (!s) return;
    const me = s.currentPlayer;
    const sel = this.sel;
    const ph = s.phase;
    const own = (t: TerritoryId | null) => !!t && s.territories[t]?.owner === me;
    if (sel.selected && !own(sel.selected)) sel.selected = null;
    if (ph.kind === 'attack' && sel.target && (!sel.selected || s.territories[sel.target].owner === me)) sel.target = null;
    if (ph.kind === 'fortify' && sel.target && (!sel.selected || !own(sel.target))) sel.target = null;
    if (ph.kind !== 'attack' && ph.kind !== 'fortify') sel.target = null;
    if (ph.kind === 'setup-place') {
      for (const [t, n] of Object.entries(sel.staged)) if (!own(t as TerritoryId) || !n) delete sel.staged[t as TerritoryId];
      if (stagedTotal(sel) > ph.toPlace) {
        sel.staged = {};
        sel.placements = [];
      }
      sel.placements = sel.placements.filter((p) => (sel.staged[p.t] ?? 0) > 0);
    } else sel.staged = {};
    if (ph.kind === 'reinforce') sel.placements = sel.placements.filter((p) => (ph.placed[p.t] ?? 0) > 0);
    else if (ph.kind !== 'setup-place') sel.placements = [];
    if (ph.kind !== 'reinforce' && ph.kind !== 'setup-place') sel.placeCount = null;
  }

  private save(): void {
    const s = this.state;
    if (!s || this.screen === 'victory') return;
    if (s.phase.kind === 'game-over') {
      this.clearSave();
      return;
    }
    const file: SaveFile = { v: 1, savedAt: Date.now(), state: s };
    writeJson(this.kv, SAVE_KEY, file);
    this.saveMeta();
    this.refreshSaveSummary();
  }

  private saveMeta(): void {
    const ui: UiFile = readJson<UiFile>(this.kv, UI_KEY) ?? { v: 1 };
    ui.v = 1;
    if (this.meta) {
      this.meta.sel = this.sel;
      ui.game = { ...this.meta, log: this.meta.log.slice(-120) };
    }
    writeJson(this.kv, UI_KEY, ui);
  }

  private clearSave(): void {
    this.kv.remove(SAVE_KEY);
    const ui = readJson<UiFile>(this.kv, UI_KEY);
    if (ui?.game) {
      delete ui.game;
      writeJson(this.kv, UI_KEY, ui);
    }
    this.refreshSaveSummary();
  }

  private refreshSaveSummary(): void {
    const f = readJson<SaveFile>(this.kv, SAVE_KEY);
    if (!f || !isPlausibleState(f.state) || f.state.phase.kind === 'game-over') {
      this.saveSummary = null;
      return;
    }
    const s = f.state;
    const humans = s.players.filter((p) => p.kind === 'human').map((p) => p.name);
    const ais = s.players.length - humans.length;
    const who =
      humans.length === 0
        ? `${ais} AI`
        : humans.length === 1
          ? `${humans[0]} vs ${ais} AI`
          : `${humans.join(' vs ')}${ais ? ` + ${ais} AI` : ''}`;
    const when = s.round > 0 ? `Round ${s.round}` : 'Setup';
    this.saveSummary = { summary: `${when}${SEP}${who}` };
  }

  private rememberDraft(): void {
    const ui: UiFile = readJson<UiFile>(this.kv, UI_KEY) ?? { v: 1 };
    ui.lastSetup = this.draft;
    writeJson(this.kv, UI_KEY, ui);
  }

  // =========================================================================
  // Applying actions
  // =========================================================================

  /** Apply to the engine state (no queueing). */
  private applyRaw(action: Action): ActionResult {
    const s = this.state;
    if (!s) return { ok: false, error: 'No game in progress.' };
    const r = applyAction(s, action);
    if (!r.ok) return r;
    this.state = r.state;
    this.save();
    return r;
  }

  /** Apply a human/hook action and queue its events. */
  private act(action: Action): ActionResult {
    const before = this.sel;
    const r = this.applyRaw(action);
    if (!r.ok) {
      console.warn('[risk] refused:', r.error);
      return r;
    }
    if (!this.frozenSel && r.events.some(isBlocking)) this.frozenSel = { ...before, staged: { ...before.staged } };
    this.enqueue(
      r.events.map((ev, i) => ({ ev, after: r.state, end: i === r.events.length - 1 })),
      { ai: false, style: 'full' },
    );
    return r;
  }

  private enqueue(
    list: { ev: GameEvent; after: GameState; end: boolean }[],
    opts: { ai: boolean; style?: 'full' | 'brief' | 'readable'; skip?: boolean; stagger?: number; beat?: number; speed?: number },
  ): void {
    const beat = opts.beat ?? this.beat++;
    const rolls = list.filter((x) => x.ev.type === 'diceRolled').length;
    let rollIndex = 0;
    let placeIndex = 0;
    let conquered = false;
    for (const x of list) {
      // Instant batches still play the next turn's start and the finale on a freshly synced board.
      const keep = opts.skip && (x.ev.type === 'turnStarted' || x.ev.type === 'gameOver');
      const e: Entry = { ...x, beat, ai: opts.ai, skip: opts.skip && !keep };
      if (x.ev.type === 'diceRolled') {
        e.opts = { style: opts.style ?? 'full', seq: { index: rollIndex++, count: rolls } };
      } else if (opts.style) {
        e.opts = { style: opts.style };
      }
      if (x.ev.type === 'territoryConquered') conquered = true;
      // Losing stings (docs/INK.md A5): tell the board when the loser is a human at the table.
      const victim = x.ev.type === 'territoryConquered' ? x.ev.previousOwner : x.ev.type === 'playerEliminated' ? x.ev.player : -1;
      if (victim >= 0 && !this.autoplayOn && x.after.players[victim]?.kind === 'human') e.opts = { ...(e.opts ?? {}), sting: true };
      if (x.ev.type === 'armiesMoved' && x.ev.reason === 'occupy' && (conquered || opts.ai)) {
        e.opts = { ...(e.opts ?? {}), inlineMarch: true };
      }
      if (opts.speed !== undefined) e.speed = opts.speed;
      if (opts.stagger && x.ev.type === 'armiesPlaced') {
        e.delayMs = placeIndex++ === 0 ? 0 : opts.stagger;
      }
      this.queue.push(e);
    }
    void this.pump();
  }

  // =========================================================================
  // Queue pump
  // =========================================================================

  private isSkipping(e: Entry): boolean {
    return !!e.skip || this.skipAll || (this.skipBeat !== null && e.beat === this.skipBeat);
  }

  /** A blocking animation is running or queued (input should click-through). */
  private busyBlocking(): boolean {
    if (this.blockingNow) return true;
    return this.queue.some((e) => isBlocking(e.ev) && !this.isSkipping(e));
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        const next = this.queue[0];
        if (next.ev.type === 'turnStarted' && this.needsHandoff(next.ev.player) && !this.handoff) {
          this.handoff = { player: next.ev.player };
          this.invalidate();
        }
        if (this.handoff) {
          await new Promise<void>((resolve) => {
            const check = () => (this.handoff ? this.timer(check, 50) : resolve());
            check();
          });
        }
        const e = this.queue.shift()!;
        const epoch = this.epoch;
        try {
        this.currentBeat = e.beat;
        if (e.delayMs && !this.isSkipping(e)) await this.sleep(e.delayMs);
        if (epoch !== this.epoch || !this.disp) continue;
        const skip = this.isSkipping(e);
        const blocking = isBlocking(e.ev);
        const earlyDisplay = !blocking || e.ev.type === 'turnStarted';
        if (!skip && this.boardStale && this.disp) {
          this.boardStale = false;
          this.board.syncState(this.disp);
        }
        if (!skip) this.setBoardSpeed(e.ai && this.aiCtx?.capped && e.ev.type !== 'turnStarted' ? 0 : (e.speed ?? this.seatSpeed()));
        this.onEventStart(e, skip);
        if (earlyDisplay) this.applyDisplay(e);
        if (skip) {
          this.boardStale = true;
        } else if (!blocking) {
          this.inflight++;
          let p: Promise<void>;
          try {
            // A truce event is words only (the line, the ledger): the board has nothing to play or wait for.
            p = TRUCE_EVENTS.has(e.ev.type) ? Promise.resolve() : this.board.playEvent(e.ev, e.after, e.opts);
          } catch (err) {
            console.error(err);
            p = Promise.resolve();
          }
          this.withSafety(p).finally(() => {
            this.inflight--;
            if (this.inflight === 0) this.afterSettled();
          });
        } else {
          this.blockingNow = e;
          if (e.ev.type === 'diceRolled') this.rolling = true;
          this.invalidate();
          let p: Promise<void>;
          try {
            p = this.board.playEvent(e.ev, e.after, e.opts);
          } catch (err) {
            console.error(err);
            p = Promise.resolve();
          }
          await this.withSafety(p);
          // Instant speed still leaves a 250 ms beat after each conquest (UX.md §8.2).
          // A snapped AI-vs-AI headline (past the turn's headline point) gets a shorter beat.
          if (e.ev.type === 'territoryConquered' && this.lastBoardSpeed === 0 && !this.isSkipping(e)) await this.sleep(e.ai && e.speed === 0 ? SNAP_BEAT_MS : 250);
          this.blockingNow = null;
          this.rolling = false;
          if (epoch !== this.epoch || !this.disp) continue;
        }
        if (!earlyDisplay) this.applyDisplay(e);
        this.onEventEnd(e, skip);
        this.invalidate();
        } catch (err) {
          // Never let one event's HUD bookkeeping freeze the game: log it, drop to the true state,
          // and keep draining so the turn (and the AI) can continue.
          console.error('[risk] event failed', e.ev.type, err);
          this.blockingNow = null;
          this.rolling = false;
          if (this.state) this.disp = cloneState(this.state);
          this.boardStale = true;
        }
      }
    } finally {
      this.pumping = false;
    }
    this.onQueueEmpty();
  }

  private withSafety(p: Promise<void>): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.sleepers.delete(onSkip);
        resolve();
      };
      // After a skip the board must settle promptly; never let one event hang the queue.
      const onSkip = () => {
        this.sleepers.delete(onSkip);
        this.timer(finish, 350);
      };
      this.sleepers.add(onSkip);
      p.then(finish, (err) => {
        console.error(err);
        finish();
      });
      this.timer(finish, PLAY_SAFETY_MS);
    });
  }

  private applyDisplay(e: Entry): void {
    if (!this.disp) return;
    this.disp = applyEventToDisplay(this.disp, e.ev, e.after, e.end);
  }

  private onQueueEmpty(): void {
    if (this.queue.length || this.pumping) return;
    if (this.boardStale && this.state) {
      this.boardStale = false;
      this.board.syncState(this.state);
      this.disp = cloneState(this.state);
    }
    this.skipAll = false;
    this.skipBeat = null;
    this.frozenSel = null;
    this.applyBoardSpeed();
    const pending = this.pendingInputs;
    this.pendingInputs = [];
    const now = this.now();
    for (const p of pending) {
      // Forced wait = time an input was held beyond the 50 ms acknowledgement budget (UX.md §8.1).
      if (this.curTurn) this.curTurn.forcedWaitMs += Math.max(0, now - p.at - 50);
      try {
        p.fn();
      } catch (err) {
        console.error(err);
      }
    }
    this.invalidate();
    if (this.inflight === 0) this.afterSettled();
    else this.scheduleAi();
  }

  /** Everything has finished: consistency sync, then the next AI beat. */
  private afterSettled(): void {
    if (this.queue.length || this.pumping || this.inflight > 0) return;
    if (this.state && this.screen === 'game' && !this.aiBusy) {
      this.board.syncState(this.state);
      this.disp = cloneState(this.state);
      this.invalidate();
    }
    this.scheduleAi();
  }

  /** Dice are rolling now or still queued for this fight (a blitz's gaps between rolls count). */
  private fightPlaying(): boolean {
    if (this.rolling || this.blockingNow?.ev.type === 'diceRolled') return true;
    return this.queue.some((e) => e.ev.type === 'diceRolled' && !this.isSkipping(e));
  }

  /** Click-through on your own turn: finish the running animation, then do what was clicked. */
  private clickThrough(fn: () => void): void {
    // The engine may already be on the next turn while the board still plays the last one (a fortify
    // march, an AI's final fight). Input now was aimed at what's on screen: finish the animation, but
    // never carry the input over as the next player's first move.
    if (this.screenBehindTurn()) {
      this.inputDropped++;
      this.skipAll = true;
      this.board.skipAnimations();
      this.wakeAll();
      this.invalidate();
      return;
    }
    this.pendingInputs.push({ fn, at: this.now() });
    this.skipAll = true;
    this.board.skipAnimations();
    this.wakeAll();
    this.invalidate();
  }

  private screenBehindTurn(): boolean {
    const s = this.state;
    const d = this.disp;
    return !!s && !!d && s.turn > 0 && (d.turn !== s.turn || d.currentPlayer !== s.currentPlayer);
  }

  /** Watched turns: a click skips the current engagement only. */
  private skipWatched(): void {
    this.skipBeat = this.currentBeat;
    for (const e of this.queue) if (e.beat === this.currentBeat) e.skip = true;
    this.board.skipAnimations();
    this.wakeAll();
  }

  private needsHandoff(player: PlayerId): boolean {
    const s = this.disp;
    if (!s || !this.settings.hideCardsBetweenTurns || this.autoplayOn) return false;
    if (s.players[player]?.kind !== 'human') return false;
    // v3: the cup passes whenever 2+ humans share the device, cards or not (one tap dismisses it).
    return this.humanCount(s, true) >= 2;
  }

  // =========================================================================
  // Event handlers (HUD reacts to each event as the board plays it)
  // =========================================================================

  private onEventStart(e: Entry, skip: boolean): void {
    const ev = e.ev;
    const d = this.disp!;
    const aiVol = (players: PlayerId[]) => (players.some((p) => this.isHumanSeat(p)) ? 1 : 0.5);
    switch (ev.type) {
      case 'turnStarted': {
        this.closeEngagement();
        this.closeTurnMetric();
        const human = this.isHumanSeat(ev.player) && !this.autoplayOn;
        if (human) this.humanHasPlayed = true;
        const prevKind = this.meta?.lastTurnKind ?? null;
        if (human && prevKind === 'human') this.guardUntil = this.now() + 250;
        if (this.meta) this.meta.lastTurnKind = this.isAiDriven(ev.player) ? 'ai' : 'human';
        this.openTurnMetric(ev.player);
        this.sel = emptySel();
        this.frozenSel = null;
        this.cardsOpen = false;
        this.truceMode = false;
        this.narration = this.isAiDriven(ev.player) ? `${pName(d, ev.player)} gets ${armies(ev.reinforcements.total)}` : null;
        this.narrPlaced = 0;
        this.aiHighlights = null;
        this.aiPreview = null;
        let recap: string | null = null;
        if (this.meta && this.isHumanSeat(ev.player) && ev.round >= 2) {
          recap = buildRecap(this.meta.recap[ev.player], d);
          delete this.meta.recap[ev.player];
          if (recap) this.log('recap', ev.player, recap, ev.round);
        }
        // The turn banner is for the humans at the table; an AI turn is named by the step indicator.
        if (!this.isAiDriven(ev.player)) this.showTurnBanner(ev.player, ev.reinforcements.total, recap, d, ev.round);
        this.log('turn', ev.player, `${poss(pName(d, ev.player))} turn${SEP}${ev.reinforcements.total} to place`, ev.round);
        if (human) this.play('turnStart', { variant: prevKind === 'ai' ? 'bright' : undefined });
        // Boards that implement setAutoCamera return home themselves on turnStarted.
        if (this.settings.autoCamera && !skip && !this.board.setAutoCamera) this.board.focusTerritories([]);
        if (this.settings.autoCamera) this.viewMoved = false;
        this.humanInputSince = this.now() + 1200;
        const lim = d.config.turnLimit;
        if (lim && ev.round === lim && this.meta && !this.meta.finalRoundShown) {
          this.meta.finalRoundShown = true;
          this.log('system', null, `Final round${SEP}most territories wins`);
        }
        break;
      }
      case 'setupTurn':
        this.sel = emptySel();
        this.narration = null;
        this.narrPlaced = 0;
        break;
      case 'territoryClaimed':
        if (e.ai) this.narration = `${pName(d, ev.player)} claims ${tName(ev.territory)}`;
        break;
      case 'armiesPlaced':
        // The AI's narration says what happened, as it lands (docs/ROUND2.md §E).
        if (e.ai && ev.count > 0 && ev.source !== 'undo') {
          this.narrPlaced += ev.count;
          this.narration = `${pName(d, ev.player)} places ${armies(this.narrPlaced)}`;
        }
        break;
      case 'diceRolled':
        this.onRollStart(ev, e);
        if (e.ai) this.narration = `${pName(d, ev.player)} attacks ${tName(ev.to)}`;
        break;
      case 'territoryConquered':
        this.lastConquest = { attacker: ev.player, victim: ev.previousOwner };
        if (ev.previousOwner >= 0) this.lostKeys[ev.previousOwner] = (this.lostKeys[ev.previousOwner] ?? 0) + 1;
        if (e.ai) this.narration = `${pName(d, ev.player)} takes ${tName(ev.to)}`;
        break;
      case 'armiesMoved':
        if (e.ai && ev.reason === 'fortify') this.narration = `${pName(d, ev.player)} moves ${ev.count} into ${tName(ev.to)}`;
        break;
      case 'phaseChanged':
        this.onPhaseCue(ev, e);
        break;
      case 'continentGained': {
        const name = pName(d, ev.player);
        const c = ev.continent;
        const bonus = CONTINENTS[c].bonus;
        // Human involvement only: a human took it, or took it from a human. AI-vs-AI just flares.
        const lc = this.lastConquest;
        const involved = this.isHumanSeat(ev.player) || (!!lc && lc.attacker === ev.player && this.isHumanSeat(lc.victim));
        if (involved) {
          this.announce('continent', `${upper(name)} HOLDS ${upper(cName(c))}${SEP}+${bonus}`, ev.player, {
            name: 'continent',
            opts: { volume: aiVol([ev.player]) },
          }, `${name} holds ${cName(c)}${SEP}+${bonus}`);
        } else this.play('continent', { volume: 0.5 });
        this.log('continent', ev.player, `${name} holds ${cName(c)}${SEP}+${bonus} a turn`);
        break;
      }
      case 'continentLost': {
        const by = pName(d, ev.to);
        const victim = pName(d, ev.player);
        this.log('continent', ev.to, `${by} broke ${poss(victim)} ${cName(ev.continent)}`);
        // Losing stings (docs/INK.md A5): a human's broken continent gets the hand-damped bowl.
        if (this.isHumanSeat(ev.player) && !this.autoplayOn && !skip) this.play('continent', { variant: 'somber' });
        break;
      }
      case 'playerEliminated': {
        if (e.ai) this.narration = `${pName(d, ev.by)} knocks out ${pName(d, ev.player)}`;
        if (this.meta) this.meta.out = { ...(this.meta.out ?? {}), [ev.player]: { by: ev.by, round: d.round } };
        this.holdUntil = this.now() + 500;
        this.audio.stopAll?.();
        this.play('eliminated', { delay: 0.15 });
        break;
      }
      case 'cardsTraded': {
        const v = ev.armies;
        if (e.ai) this.narration = `${pName(d, ev.player)} trades cards for +${v}`;
        const rate = v >= 20 ? 0.72 : 1 - ((Math.max(4, v) - 4) / 16) * 0.28;
        this.play('cardTrade', { rate, volume: (v > 10 ? 1.26 : 1) * aiVol([ev.player]) });
        break;
      }
      case 'cardDrawn':
        this.play('cardDraw', { volume: aiVol([ev.player]) });
        break;
      case 'truceProposed':
      case 'truceAccepted':
      case 'truceDeclined':
      case 'truceBroken':
      case 'truceExpired': {
        // Diplomacy (v3): one plain sentence in the event line and the ledger, as it lands; no wait.
        const text = truceSentence(e.after, ev);
        const actor =
          ev.type === 'truceBroken' ? ev.by : ev.type === 'truceAccepted' || (ev.type === 'truceDeclined' && ev.reason === 'declined') ? ev.to : ev.from;
        if (text) {
          this.log('truce', actor, text);
          if (e.ai) this.narration = text;
        }
        // A broken truce against a human stings like a lost continent: the ring dims, the somber bowl.
        if (ev.type === 'truceBroken' && this.isHumanSeat(ev.against) && !this.autoplayOn && !skip) {
          this.lostKeys[ev.against] = (this.lostKeys[ev.against] ?? 0) + 1;
          this.play('continent', { variant: 'somber' });
          this.haptics.play('conquest');
        }
        break;
      }
      case 'gameOver': {
        this.closeEngagement();
        this.closeTurnMetric();
        this.holdUntil = this.now() + 1500;
        this.play('victory');
        this.clearSave();
        this.victory = this.buildVictory(e.after, ev.winner, null);
        this.screen = 'victory';
        this.turnBanner = null;
        this.banner = null;
        this.bannerQueue = [];
        break;
      }
      default:
        break;
    }
  }

  private onEventEnd(e: Entry, skip: boolean): void {
    const ev = e.ev;
    const d = this.disp!;
    const meta = this.meta;
    switch (ev.type) {
      case 'diceRolled':
        this.onRollEnd(ev);
        if (!skip && e.opts?.style !== 'brief' && (this.isHumanSeat(ev.player) || this.isHumanSeat(ev.defender))) this.haptics.play('dice');
        break;
      case 'territoryConquered': {
        if (!skip && (this.isHumanSeat(ev.player) || this.isHumanSeat(ev.previousOwner))) this.haptics.play('conquest');
        const g = this.eng;
        if (g && g.from === ev.from && g.to === ev.to) {
          g.conquered = true;
          if (g.winP <= 0.3) {
            g.upset = `against the odds (${pct(g.winP)}%)`;
            meta?.awards.upsets.push({ player: ev.player, kind: 'odds', pct: pct(g.winP), round: d.round });
          }
          this.finishEngagement();
        }
        this.checkNearGoal();
        break;
      }
      case 'armiesMoved':
        if (ev.reason === 'fortify') this.log('system', ev.player, `${pName(d, ev.player)} moved ${ev.count} from ${tName(ev.from)} to ${tName(ev.to)}`);
        break;
      case 'playerEliminated': {
        if (!skip) this.haptics.play('eliminated');
        const victim = pName(d, ev.player);
        // The epitaph names who did it (docs/INK.md A5): 'Sam · taken by John · round 9'.
        this.announce('elimination', `${upper(victim)} IS OUT`, ev.by, undefined, `${victim}${SEP}taken by ${pName(d, ev.by)}${SEP}round ${Math.max(1, d.round)}`);
        this.log('elimination', ev.by, `${pName(d, ev.by)} knocked out ${victim}`);
        this.checkAllHumansOut();
        break;
      }
      case 'cardsCaptured': {
        const n = ev.cards.length;
        this.log('card', ev.player, `${pName(d, ev.player)} took ${poss(pName(d, ev.from))} ${n === 1 ? 'card' : `${n} cards`}`);
        break;
      }
      case 'cardsTraded': {
        const name = pName(d, ev.player);
        this.log('card', ev.player, `${name} traded 3 cards for +${ev.armies}`);
        if (ev.bonusTerritory) this.log('card', ev.player, `+2 on ${tName(ev.bonusTerritory)}${SEP}${name} owns a traded card's territory`);
        break;
      }
      case 'cardDrawn':
        this.log('card', ev.player, `${pName(d, ev.player)} drew a card`);
        break;
      case 'gameOver':
        if (!skip) this.board.setAttractMode(true);
        break;
      case 'phaseChanged':
        if (ev.phase === 'fortify' || ev.phase === 'reinforce') {
          this.closeEngagement();
          this.clearLinger();
        }
        if (ev.phase !== 'reinforce') this.cardsOpen = false;
        if (ev.phase !== 'attack') this.truceMode = false;
        if (ev.phase === 'occupy' && this.state?.phase.kind === 'occupy' && this.sel.occupyCount === null) {
          const ph = this.state.phase;
          this.sel.occupyCount = occupyDefault(this.state, ph.from, ph.to, ph.min, ph.max);
        }
        break;
      case 'controllerChanged':
        this.checkAllHumansOut();
        break;
      default:
        break;
    }
    if (meta) {
      recordAward(meta.awards, d, ev);
      recordRecap(meta.recap, d, ev);
    }
    if (e.end && meta && ev.type !== 'gameOver') this.saveMeta();
  }

  /** Within 5 of the goal, once per seat: a log line (no banner). */
  private checkNearGoal(): void {
    const d = this.disp!;
    const meta = this.meta;
    if (!meta) return;
    const need = territoriesNeeded(d);
    for (const p of d.players) {
      if (p.eliminated || meta.nearGoal.includes(p.id)) continue;
      const left = need - territoryCount(d, p.id);
      if (left > 0 && left <= 5) {
        meta.nearGoal.push(p.id);
        this.log('system', p.id, `${p.name} is ${left} from victory`);
      }
    }
  }

  private checkAllHumansOut(): void {
    const s = this.disp;
    if (!s || this.allHumansOutDismissed) return;
    const humans = s.players.filter((p) => p.kind === 'human');
    if (humans.length > 0 && humans.every((p) => p.eliminated) && s.phase.kind !== 'game-over') this.allHumansOut = true;
  }

  // --- Phase changes: the board answers (docs/ROUND2.md §A) ------------------

  /** A phase change reached the board: an AI's marker clacks softly; a human's gets the board's response. */
  private onPhaseCue(ev: Extract<GameEvent, { type: 'phaseChanged' }>, e: Entry): void {
    // An AI's fighting is over: its last telegraph dries now, inside its own turn, not over the next
    // player's turn start (INK F6).
    if (e.ai && ev.phase === 'fortify' && this.aiHighlights?.arrow?.kind === 'attack') {
      this.aiHighlights = null;
      this.aiPreview = null;
      this.invalidate();
    }
    if (ev.phase !== 'attack' && ev.phase !== 'fortify') return;
    if (this.isAiDriven(ev.player)) {
      if (e.ai) this.play('place', { rate: 0.82, volume: 0.35 });
      return;
    }
    // The occupy step returning to attack is not an advance.
    if (ev.phase === 'attack' && this.disp?.phase.kind === 'occupy') return;
    this.boardCue(ev.phase, ev.player);
  }

  /** Ask the board for its phase-change response, if it has one (lift + rim sweep, dim others, clear). */
  private boardCue(phase: 'attack' | 'fortify' | 'endTurn', player: PlayerId): void {
    try {
      this.board.pulsePhase?.(phase === 'endTurn' ? 'end' : phase, { player });
    } catch (err) {
      console.error(err);
    }
  }

  // --- Engagements (battle panel, log line, upsets, roll metrics) -------------

  private onRollStart(ev: Extract<GameEvent, { type: 'diceRolled' }>, e: Entry): void {
    const d = this.disp!;
    const g = this.eng;
    const same = g && !g.endedAt && g.from === ev.from && g.to === ev.to && g.turn === d.turn && !g.conquered;
    if (!same) {
      this.closeEngagement();
      const a = d.territories[ev.from].armies;
      const def = d.territories[ev.to].armies;
      this.eng = {
        attacker: ev.player,
        defender: ev.defender,
        from: ev.from,
        to: ev.to,
        startA: a,
        startD: def,
        rolls: 0,
        attLost: 0,
        defLost: 0,
        blitz: ev.blitz,
        winP: winProbability(a, def),
        style: e.opts?.style ?? 'full',
        conquered: false,
        startedAt: this.now(),
        lastRollEnd: this.now(),
        logId: 0,
        endedAt: null,
        turn: d.turn,
      };
    }
    if (ev.blitz && this.eng) this.eng.blitz = true;
  }

  private onRollEnd(ev: Extract<GameEvent, { type: 'diceRolled' }>): void {
    const g = this.eng;
    const d = this.disp!;
    if (!g) return;
    g.rolls++;
    g.attLost += ev.attackerLosses;
    g.defLost += ev.defenderLosses;
    g.lastRollEnd = this.now();
    this.writeEngagementLog(false);
    // Blitz stopped without taking it, or the source is down to 1: the engagement is over.
    if (d.territories[ev.to].armies > 0 && d.territories[ev.from].armies < 2) this.finishEngagement();
  }

  private engagementText(final: boolean): string {
    const g = this.eng!;
    const d = this.disp!;
    // The house voice (v3 ledger): middle dots, no colon, no arrow. 'John took Siberia from Ural · 19 vs 1 · lost 1'
    const A = pName(d, g.attacker);
    const odds = `${g.startA} vs ${g.startD}`;
    const upset = g.upset ? `${SEP}${g.upset}` : '';
    if (g.conquered) return `${A} took ${tName(g.to)} from ${tName(g.from)}${SEP}${odds}${SEP}lost ${g.attLost}${upset}`;
    if (final) return `${pName(d, g.defender)} held ${tName(g.to)} against ${A}${SEP}${odds}${SEP}${A} lost ${g.attLost}${upset}`;
    return `${A} ${g.blitz ? 'blitzes' : 'attacks'} ${tName(g.to)} from ${tName(g.from)}${SEP}${odds}${SEP}now ${d.territories[g.from].armies} vs ${d.territories[g.to].armies}`;
  }

  private writeEngagementLog(final: boolean): void {
    const g = this.eng;
    const meta = this.meta;
    if (!g || !meta) return;
    const text = this.engagementText(final);
    if (g.logId) {
      const i = meta.log.findIndex((l) => l.id === g.logId);
      if (i >= 0) {
        // Immutable update: the HUD short-circuits on the lines array's identity.
        meta.log = meta.log.map((l, j) => (j === i ? { ...l, text } : l));
        this.invalidate();
        return;
      }
    }
    g.logId = this.log('engagement', g.attacker, text);
  }

  /** The engagement is decided (conquest, or the attacker stopped): log, upsets, metrics. */
  private finishEngagement(): void {
    const g = this.eng;
    if (!g || g.endedAt) return;
    g.endedAt = this.now();
    const d = this.disp!;
    if (!g.conquered && g.winP >= 0.75 && g.rolls > 0) {
      g.upset = `an upset (${pName(d, g.attacker)} had ${pct(g.winP)}%)`;
      this.meta?.awards.upsets.push({ player: g.defender, kind: 'held', pct: pct(g.winP), round: d.round });
    }
    this.writeEngagementLog(true);
    this.metricRolls.push({ blitz: g.blitz, count: g.rolls, ms: Math.round(g.lastRollEnd - g.startedAt), style: g.style });
    this.timer(() => this.invalidate(), LINGER_MS + 20);
  }

  /** A new selection or a phase change: a decided fight's header goes at once. */
  private clearLinger(): void {
    const g = this.eng;
    if (g && g.endedAt && !g.cleared) {
      g.cleared = true;
      this.invalidate();
    }
  }

  private closeEngagement(): void {
    const g = this.eng;
    if (g && !g.endedAt) {
      // Stopped by choice (switched target, ended the phase).
      const d = this.disp!;
      const couldGoOn = d.territories[g.from].armies >= 2 && !g.blitz;
      if (couldGoOn) {
        g.endedAt = this.now();
        this.writeEngagementLog(true);
        this.metricRolls.push({ blitz: g.blitz, count: g.rolls, ms: Math.round(g.lastRollEnd - g.startedAt), style: g.style });
      } else this.finishEngagement();
    }
  }

  // =========================================================================
  // Banners (docs/SIMPLIFY.md §5): the turn banner, continent captured, elimination. One at a time.
  // =========================================================================

  private announce(kind: 'continent' | 'elimination', title: string, seat: PlayerId, sound?: { name: SfxName; opts?: PlayOptions }, line?: string): void {
    const d = this.disp;
    const item: BannerItem = {
      vm: { id: this.idSeq++, kind, title, line, sub: '', recap: null, seat: d?.players[seat] ? seatRef(d, seat) : null, holdMs: kind === 'elimination' ? 1600 : 1200 },
      createdAt: this.now(),
      sound,
    };
    // An elimination keeps its moment: it jumps the queue.
    if (kind === 'elimination') this.bannerQueue.unshift(item);
    else this.bannerQueue.push(item);
    this.tickBanners();
  }

  private tickBanners(): void {
    const now = this.now();
    if (this.banner && now >= this.banner.createdAt + 240 + this.banner.vm.holdMs && this.banner.createdAt <= now) {
      this.banner = null;
      this.bannerNextAt = now + 400; // 200 out + 200 gap
      this.invalidate();
    }
    const blocked = this.rolling || !!this.turnBanner;
    if (!this.banner && this.bannerQueue.length && now >= this.bannerNextAt && !blocked) {
      const next = this.bannerQueue.shift()!;
      next.createdAt = now;
      this.banner = next;
      if (next.sound) this.play(next.sound.name, next.sound.opts);
      this.invalidate();
    }
    if ((this.banner || this.bannerQueue.length) && !this.bannerTimer) {
      this.bannerTimer = this.timer(() => {
        this.bannerTimer = null;
        this.tickBanners();
      }, 100);
    }
  }

  /** "JOHN'S TURN" + '+9 armies' (null = a resumed mid-turn: no count), and the one recap line. */
  private showTurnBanner(player: PlayerId, armiesIn: number | null, recap: string | null, s: GameState, roundIn?: number): void {
    const round = roundIn ?? s.round;
    const name = pName(s, player);
    const instant = this.settings.animationSpeed === 0;
    // Non-blocking and click-through (any input dismisses it); a grudge line gets time to be read.
    // ~2 s in all with its draw-in and dry-out (PLAN §3); a grudge line gets a little longer.
    const holdMs = instant ? 500 : recap ? 1800 : 1400;
    // An elimination banner keeps its moment: the turn banner waits for it to leave, so the room never
    // sees two banners at once.
    if (this.banner && this.banner.vm.kind === 'elimination') {
      const wait = Math.max(0, this.banner.createdAt + 240 + this.banner.vm.holdMs + 200 - this.now());
      const turn = s.turn;
      if (this.turnBannerTimer) this.clock.clearTimeout(this.turnBannerTimer);
      this.turnBannerTimer = this.timer(() => {
        this.turnBannerTimer = null;
        if (this.disp && this.disp.turn === turn && this.screen === 'game') this.showTurnBanner(player, armiesIn, recap, s, round);
      }, wait + 10);
      return;
    }
    // The turn banner takes the slot: a continent banner still showing bows out, and the ones still
    // queued from the turns before are stale news (the recap carries what matters).
    if (this.banner) {
      this.banner = null;
      this.bannerNextAt = this.now() + 200;
    }
    this.bannerQueue = this.bannerQueue.filter((x) => x.vm.kind === 'elimination');
    this.turnBanner = {
      id: this.idSeq++,
      kind: 'turn',
      title: `${upper(poss(name))} TURN`,
      // The turn banner (PLAN §3): "Sam's turn · round 6 · 7 to place", drawn in as the cup arrives.
      line: armiesIn === null ? `${poss(name)} turn${SEP}round ${round}` : `${poss(name)} turn${SEP}round ${round}${SEP}${armiesIn} to place`,
      sub: armiesIn === null ? '' : `+${armiesIn} ${armiesIn === 1 ? 'army' : 'armies'}`,
      recap,
      seat: seatRef(s, player),
      holdMs,
    };
    if (this.turnBannerTimer) this.clock.clearTimeout(this.turnBannerTimer);
    const id = this.turnBanner.id;
    this.turnBannerTimer = this.timer(() => {
      if (this.turnBanner?.id === id) this.dismissTurnBanner();
    }, (instant ? 150 : 280) + holdMs);
  }

  private dismissTurnBanner(): void {
    if (!this.turnBanner) return;
    this.turnBanner = null;
    this.bannerNextAt = Math.max(this.bannerNextAt, this.now() + 200);
    this.invalidate();
    this.tickBanners();
  }

  private log(kind: LogLineVM['kind'], player: PlayerId | null, text: string, round?: number): number {
    const meta = this.meta;
    const d = this.disp;
    if (!meta || !d) return 0;
    const id = meta.logId++;
    // A new array every time: the HUD short-circuits on the lines array's identity.
    const next = [...meta.log, { id, round: round ?? d.round, seat: player !== null && d.players[player] ? seatRef(d, player) : null, kind, text }];
    meta.log = next.length > LOG_CAP ? next.slice(next.length - LOG_CAP) : next;
    this.invalidate();
    return id;
  }

  private play(name: SfxName, opts?: PlayOptions): void {
    if (opts?.volume === 0) return;
    try {
      this.audio.play(name, opts);
    } catch {
      /* audio is best-effort */
    }
  }

  // =========================================================================
  // Board input
  // =========================================================================

  private explainUi(): ExplainUi {
    return {
      selected: this.sel.selected,
      target: this.sel.target,
      staged: this.sel.staged,
      interactive: this.interactive(),
      showWinChance: this.settings.showWinChance,
    };
  }

  explain(t: TerritoryId): Explanation {
    const s = this.state;
    if (!s) return { ok: false, text: 'No game in progress' };
    return explainTerritory(s, this.explainUi(), t);
  }

  /** Territory clicks seen (the ocean-click detector compares it across a press). */
  private boardClicks = 0;
  /** The territory under the pointer, or null over ocean and table. */
  private overTile: TerritoryId | null = null;

  private nameCardKey = 0;

  /** Long-press on touch (docs/MOBILE.md §3): the name card above the finger; release hides it. Never selects. */
  private onLongPress(info: TerritoryPointerInfo | null | undefined): void {
    const d = this.disp;
    if (!info || !d || this.screen !== 'game' || this.overlay || this.confirm || this.handoff) {
      this.hideNameCard();
      return;
    }
    const t = info.territory;
    const tile = d.territories[t];
    if (!tile) return this.hideNameCard();
    const c = TERRITORIES[t].continent;
    const owner = tile.owner >= 0 && d.players[tile.owner] ? seatRef(d, tile.owner) : null;
    this.nameCard = {
      territory: tName(t),
      continent: cName(c),
      bonus: CONTINENTS[c].bonus,
      owner,
      armies: tile.armies,
      x: info.clientX,
      y: info.clientY,
      key: ++this.nameCardKey,
    };
    this.haptics.play('select');
    this.invalidate();
  }

  private hideNameCard(): void {
    if (!this.nameCard) return;
    this.nameCard = null;
    this.invalidate();
  }

  private onBoardClick(info: TerritoryPointerInfo): void {
    this.boardClicks++;
    this.hideNameCard();
    if (this.turnBanner) this.dismissTurnBanner();
    const s = this.state;
    if (!s || this.screen !== 'game' || this.overlay || this.confirm) return;
    if (this.now() < this.holdUntil) {
      this.inputDropped++;
      return;
    }
    if (!this.interactive()) {
      this.skipWatched();
      return;
    }
    if (this.now() < this.guardUntil) {
      this.inputDropped++;
      return;
    }
    if (info.button !== 0) return;
    if (this.busyBlocking()) {
      this.clickThrough(() => this.handleClick(info));
      return;
    }
    const before = this.selKey();
    this.handleClick(info);
    if (this.selKey() !== before) this.haptics.play('select');
  }

  /**
   * Draw-to-attack (docs/INK.md A2). While the pointer drags, the stroke is the player's attention: a turn
   * line still showing bows out. Released over an eligible target it arms that fight exactly like a
   * target-first tap from that source (the line, the odds, Roll / Blitz); released anywhere else it dries
   * out and nothing changes. A stroke never commits. The same guards as a tap apply: the knockout hold,
   * the tail-of-turn guard, and click-through (finish what's animating, then arm).
   */
  private onStroke(st: StrokeInfo): void {
    // While the gold stroke is on the board, the board holds the one gold (buildGold).
    const live = !st.done;
    if (live !== this.strokeLive) {
      this.strokeLive = live;
      this.invalidate();
    }
    if (!st.done) {
      this.hideNameCard();
      if (this.turnBanner) this.dismissTurnBanner();
      return;
    }
    if (!st.to) return;
    const s = this.state;
    if (!s || this.screen !== 'game' || this.overlay || this.confirm) return;
    if (this.now() < this.holdUntil) {
      this.inputDropped++;
      return;
    }
    if (!this.interactive()) return;
    if (this.now() < this.guardUntil) {
      this.inputDropped++;
      return;
    }
    const { from, to } = st;
    if (this.busyBlocking()) {
      this.clickThrough(() => this.armFromStroke(from, to));
      return;
    }
    const before = this.selKey();
    this.armFromStroke(from, to);
    if (this.selKey() !== before) this.haptics.play('select');
  }

  private armFromStroke(from: TerritoryId, to: TerritoryId): void {
    const s = this.state;
    if (!s || !this.interactive() || s.phase.kind !== 'attack') return;
    // The same reasoner as a tap on `to` with `from` picked: only a legal pairing arms.
    const ex = explainTerritory(s, { ...this.explainUi(), selected: from, target: null }, to);
    if (!ex.ok || ex.plan?.kind !== 'arm' || ex.plan.from !== from) return;
    this.clearRejection();
    this.runPlan(ex.plan);
    this.invalidate();
  }

  /** Where a stroke may start now: your eligible attack sources in your own Attack step, else none. */
  private strokeSources(): TerritoryId[] {
    const s = this.state;
    const d = this.disp;
    if (!s || !d || this.screen !== 'game' || this.overlay || this.confirm) return [];
    if (!this.interactive() || d.currentPlayer !== s.currentPlayer) return [];
    // Not while the dice roll or an occupy holds the turn (the phase reads 'occupy' then).
    if (s.phase.kind !== 'attack' || d.phase.kind !== 'attack' || this.fightPlaying()) return [];
    return attackSources(s, s.currentPlayer).filter((t) => attackTargets(s, t).length > 0);
  }

  private strokeTargets = (src: TerritoryId): TerritoryId[] => {
    const s = this.state;
    if (!s || s.phase.kind !== 'attack' || s.territories[src]?.owner !== s.currentPlayer || s.territories[src].armies < 2) return [];
    return attackTargets(s, src);
  };

  private pushStrokeSources(): void {
    if (!this.board.setStrokeSources) return;
    const src = this.strokeSources();
    const s = this.state;
    // The targets read the live state, but a new board (owners, armies) is a new offer.
    const key = src.length && s ? `${s.turn}|${src.map((t) => `${t}:${attackTargets(s, t).join(',')}`).join(';')}` : '';
    if (key === this.lastStrokeKey) return;
    this.lastStrokeKey = key;
    try {
      this.board.setStrokeSources(src, this.strokeTargets);
    } catch (err) {
      console.error(err);
    }
  }

  /** What the player has picked (source, target, pending count), for the select haptic. */
  private selKey(): string {
    return JSON.stringify(this.sel);
  }

  private handleClick(info: TerritoryPointerInfo): void {
    const s = this.state;
    if (!s || !this.interactive()) return;
    // A board tap while choosing a truce partner goes back to the board (the rings go out).
    this.truceMode = false;
    const t = info.territory;
    const ex = explainTerritory(s, this.explainUi(), t);
    if (!ex.ok || !ex.plan) {
      if (ex.code) this.reject(ex.code, ex.text);
      return;
    }
    this.clearRejection();
    this.runPlan(ex.plan);
    this.invalidate();
  }

  /** A refused click: its plain reason replaces the line for 2 s, with a soft tick. */
  private reject(code: string, text: string): void {
    this.lineKey++;
    this.rejection = { text, key: this.lineKey, until: this.now() + REJECT_MS, code };
    if (this.curTurn) this.curTurn.rejected++;
    this.play('uiError', { volume: 0.25 });
    const key = this.lineKey;
    this.timer(() => {
      if (this.rejection?.key === key) {
        this.rejection = null;
        this.lineKey++;
        this.invalidate();
      }
    }, REJECT_MS);
    this.invalidate();
  }

  /** A successful input changes the state the line describes: a pending rejection no longer applies. */
  private clearRejection(): void {
    if (!this.rejection) return;
    this.rejection = null;
    this.lineKey++;
  }

  /** A board click: it selects or previews, never commits (docs/ROUND2.md §B). A claim is the exception. */
  private runPlan(plan: ClickPlan): void {
    const s = this.state!;
    const me = s.currentPlayer;
    if (plan.kind !== 'claim') this.clearLinger();
    switch (plan.kind) {
      case 'claim':
        this.act({ type: 'claim', player: me, territory: plan.t });
        break;
      case 'pick':
        if (this.sel.selected !== plan.t) this.sel = { ...this.sel, selected: plan.t, placeCount: null };
        break;
      case 'selectSource':
        this.sel = { ...emptySel(), selected: plan.t };
        break;
      case 'deselect':
        this.sel = { ...emptySel() };
        break;
      case 'arm':
        this.sel = { ...emptySel(), selected: plan.from, target: plan.to };
        break;
      case 'fortifySource':
        this.sel = { ...emptySel(), selected: plan.t };
        break;
      case 'fortifyDest': {
        const max = Math.max(1, s.territories[plan.from].armies - 1);
        this.sel = { ...emptySel(), selected: plan.from, target: plan.to, fortifyCount: max };
        break;
      }
    }
    this.saveMeta();
    this.invalidate();
  }

  /**
   * `Place N` on the picked territory: reinforce commits to the engine (Undo = unreinforce); setup
   * stages locally until Done. The pick stays while armies are left; the count resets to all.
   */
  private placeNow(): void {
    const s = this.state!;
    const me = s.currentPlayer;
    const sel = this.sel;
    const t = sel.selected;
    if (!t || s.territories[t].owner !== me) return;
    const left = placeLeft(s, sel);
    if (left <= 0) return;
    const n = placeValue(s, sel);
    if (s.phase.kind === 'reinforce') {
      const r = this.act({ type: 'reinforce', player: me, territory: t, count: n });
      if (!r.ok) return;
    } else if (s.phase.kind === 'setup-place') {
      sel.staged[t] = (sel.staged[t] ?? 0) + n;
      this.play('place', { volume: 0.8 });
    } else return;
    sel.placements.push({ t, n });
    sel.placeCount = null;
    if (n >= left) sel.selected = null;
  }

  /** Undo takes back the last placement, whole. */
  private undoPlacement(): void {
    const s = this.state!;
    const me = s.currentPlayer;
    const ph = s.phase;
    const sel = this.sel;
    if (ph.kind === 'setup-place') {
      const last = sel.placements.pop();
      if (!last) return;
      const have = sel.staged[last.t] ?? 0;
      const n = Math.min(have, last.n);
      if (have - n > 0) sel.staged[last.t] = have - n;
      else delete sel.staged[last.t];
      this.play('unplace', { volume: 0.7 });
    } else if (ph.kind === 'reinforce') {
      let last: Placement | undefined;
      while (sel.placements.length && !last) {
        const c = sel.placements.pop()!;
        if ((ph.placed[c.t] ?? 0) > 0) last = c;
      }
      // A save from before placements were tracked: take back a whole tile.
      if (!last) {
        const t = TERRITORY_IDS.find((x) => (ph.placed[x] ?? 0) > 0);
        if (t) last = { t, n: ph.placed[t]! };
      }
      if (!last) return;
      this.act({ type: 'unreinforce', player: me, territory: last.t, count: Math.min(last.n, ph.placed[last.t] ?? 0) });
    }
    sel.placeCount = null;
  }

  private doAttack(blitz: boolean): void {
    const s = this.state!;
    const me = s.currentPlayer;
    const { selected: from, target: to } = this.sel;
    if (!from || !to || s.phase.kind !== 'attack') return;
    const dice = maxAttackDice(s, from);
    if (dice < 1) return;
    // Always the most dice you can roll.
    const r = this.act(blitz ? { type: 'blitz', player: me, from, to, stopAt: 1 } : { type: 'attack', player: me, from, to, dice: dice as 1 | 2 | 3 });
    if (!r.ok) return;
    const after = this.state!;
    if (after.phase.kind === 'occupy') {
      const ph = after.phase;
      this.sel.occupyCount = occupyDefault(after, ph.from, ph.to, ph.min, ph.max);
      this.sel.countTouched = false;
      return;
    }
    if (after.phase.kind !== 'attack') {
      this.sel = emptySel();
      return;
    }
    if (after.territories[to].owner === me) {
      // Auto-occupied conquest: chain.
      this.sel = { ...emptySel(), selected: autoChain(after, from, to) };
      return;
    }
    if (after.territories[from].armies < 2) this.sel = emptySel();
  }

  /** `Move N`: occupy, then the new territory is the source if it can keep attacking. */
  private doOccupy(): void {
    const s = this.state!;
    if (s.phase.kind !== 'occupy') return;
    const ph = s.phase;
    const count = Math.min(ph.max, Math.max(ph.min, this.sel.occupyCount ?? ph.max));
    const r = this.act({ type: 'occupy', player: s.currentPlayer, count });
    if (!r.ok) return;
    this.clearLinger();
    const after = this.state!;
    this.sel = after.phase.kind === 'attack' ? { ...emptySel(), selected: autoChain(after, ph.from, ph.to) } : emptySel();
  }

  // =========================================================================
  // Buttons, the Turn Track, keyboard, intents
  // =========================================================================

  private currentStrip(): StripVM | null {
    return this.getViewModel().game?.strip ?? null;
  }

  pressButton(id: ButtonId): void {
    if (this.turnBanner) this.dismissTurnBanner();
    const s = this.state;
    if (!s || this.screen !== 'game') return;
    // All humans out: the strip offers these during AI turns.
    if (id === 'watchAis' || id === 'callGame') {
      if (!this.allHumansOut) return;
      if (id === 'callGame') this.endGameNow();
      else {
        this.sessionAiSpeed = 'instant';
        this.allHumansOut = false;
        this.allHumansOutDismissed = true;
        this.applyBoardSpeed();
      }
      this.invalidate();
      return;
    }
    if (this.now() < this.holdUntil) {
      this.inputDropped++;
      return;
    }
    if (!this.interactive()) {
      this.skipWatched();
      return;
    }
    if (this.busyBlocking()) {
      this.clickThrough(() => this.pressButton(id));
      return;
    }
    const strip = this.currentStrip();
    // The Cards sheet's own Trade button works whenever the sheet offers it.
    const fromSheet = id === 'trade' && !!this.getViewModel().game?.cards?.trade;
    if (!strip?.buttons.some((b) => b.id === id) && !fromSheet) return;
    this.clearRejection();
    this.runButton(id);
    this.saveMeta();
    this.invalidate();
  }

  private runButton(id: ButtonId): void {
    const s = this.state!;
    const me = s.currentPlayer;
    const ph = s.phase;
    const sel = this.sel;
    switch (id) {
      case 'place':
        this.placeNow();
        break;
      case 'undo':
        this.undoPlacement();
        break;
      case 'trade': {
        if (ph.kind !== 'reinforce') break;
        const best = bestSet(s, me);
        if (best && this.act({ type: 'trade', player: me, cardIds: best.cardIds }).ok) {
          sel.placeCount = null;
          this.cardsOpen = false;
        }
        break;
      }
      case 'cards':
        this.cardsOpen = !this.cardsOpen;
        break;
      case 'roll':
        this.doAttack(false);
        break;
      case 'blitz':
        this.doAttack(true);
        break;
      case 'move':
        if (ph.kind === 'occupy') this.doOccupy();
        else if (ph.kind === 'fortify' && sel.selected && sel.target) {
          const max = Math.max(1, s.territories[sel.selected].armies - 1);
          const count = Math.min(max, Math.max(1, sel.fortifyCount ?? max));
          this.act({ type: 'fortify', player: me, from: sel.selected, to: sel.target, count });
        }
        break;
      case 'truce':
        // The seats a truce can be offered to light up in the strip; a second tap puts them out.
        this.truceMode = !this.truceMode && this.truceSeats().length > 0;
        break;
      case 'acceptTruce':
      case 'declineTruce': {
        const o = this.pendingOffer();
        if (o) this.act({ type: 'answerTruce', player: me, from: o.from, accept: id === 'acceptTruce' });
        break;
      }
      case 'watchAis':
      case 'callGame':
        break;
    }
  }

  // --- Diplomacy (v3): offers to the driver, and the driver's own offers -------------------------------

  /** Diplomacy is on for the driver: a human seat, their own live turn, config.diplomacy. */
  private diplomacyLive(): boolean {
    const s = this.state;
    const d = this.disp;
    if (!s || !d || !s.config.diplomacy || !this.interactive() || d.currentPlayer !== s.currentPlayer) return false;
    return s.players[s.currentPlayer]?.kind === 'human';
  }

  /**
   * The offer waiting for the driver's answer (oldest first), or null. Offers are answered on your own turn
   * (pass and play: an offer to John waits for John's turn; it lapses when that turn ends), and never
   * over a move that must finish first (an occupy, a forced trade).
   */
  private pendingOffer(): ReturnType<typeof truceOffersTo>[number] | null {
    const s = this.state;
    if (!s || !this.diplomacyLive()) return null;
    const ph = s.phase;
    if (ph.kind === 'occupy' || (ph.kind === 'reinforce' && ph.mustTrade)) return null;
    if (ph.kind !== 'reinforce' && ph.kind !== 'attack' && ph.kind !== 'fortify') return null;
    return truceOffersTo(s, s.currentPlayer).find((o) => !!s.players[o.from] && !s.players[o.from].eliminated) ?? null;
  }

  /** Seats the driver may offer a 3-round truce to now: Attack only, no offer of theirs pending. */
  private truceSeats(): PlayerId[] {
    const s = this.state;
    if (!s || !this.diplomacyLive() || s.phase.kind !== 'attack' || this.pendingOffer()) return [];
    return truceTargets(s, s.currentPlayer, TRUCE_ROUNDS);
  }

  /** A lit seat ring was tapped: offer that seat a 3-round no-attack truce. */
  private proposeTruce(to: PlayerId): void {
    const s = this.state;
    if (!s || !this.truceMode || this.now() < this.holdUntil) return;
    if (!this.truceSeats().includes(to)) return;
    if (this.busyBlocking()) {
      this.clickThrough(() => this.proposeTruce(to));
      return;
    }
    this.truceMode = false;
    this.clearRejection();
    this.act({ type: 'proposeTruce', player: s.currentPlayer, to, rounds: TRUCE_ROUNDS, kind: 'noAttack' });
    this.invalidate();
  }

  /** A Turn Track click. Past and current segments are inert; a locked one explains itself. */
  pressTrack(seg: TrackSegId): void {
    if (this.turnBanner) this.dismissTurnBanner();
    const s = this.state;
    if (!s || this.screen !== 'game') return;
    if (this.now() < this.holdUntil) {
      this.inputDropped++;
      return;
    }
    if (!this.interactive()) {
      this.skipWatched();
      return;
    }
    // Visibly disabled while the dice roll: the click does nothing (it never queues a phase change).
    if (this.fightPlaying()) return;
    // Past and current segments are inert (Risk never goes back).
    const shown = this.currentStrip()?.track.segments.find((x) => x.id === seg);
    if (!shown || shown.state === 'done' || shown.state === 'current') return;
    if (this.busyBlocking()) {
      this.clickThrough(() => this.pressTrack(seg));
      return;
    }
    this.goTo(seg);
    this.saveMeta();
    this.invalidate();
  }

  /** Move the marker forward to `seg` (docs/ROUND2.md §A). */
  private goTo(seg: TrackSegId): void {
    const s = this.state!;
    const me = s.currentPlayer;
    const track = buildTrack({ s, sel: this.sel, live: true, rolling: false });
    const target = track.segments.find((x) => x.id === seg);
    if (!target || target.state === 'done' || target.state === 'current') return;
    const why = trackLockReason(s, this.sel, seg);
    if (target.state === 'locked' || why) {
      this.reject('track_locked', why ?? '');
      return;
    }
    this.clearRejection();
    this.clearLinger();
    this.cardsOpen = false;
    this.play('place', { rate: 0.82, volume: 0.9 });
    if (s.phase.kind === 'setup-place') {
      if (seg !== 'done') return;
      const staged = { ...this.sel.staged };
      this.sel = emptySel();
      for (const t of TERRITORY_IDS) {
        const n = staged[t];
        if (n) this.act({ type: 'placeSetup', player: me, territory: t, count: n });
      }
      return;
    }
    if (s.phase.kind === 'reinforce' && !this.act({ type: 'endReinforce', player: me }).ok) return;
    this.sel = emptySel();
    if (seg === 'attack') return;
    const ph = this.state!.phase.kind;
    if (seg === 'fortify') {
      if (ph === 'attack') this.act({ type: 'endAttack', player: me });
      return;
    }
    if (seg === 'endTurn' && (ph === 'attack' || ph === 'fortify')) {
      this.boardCue('endTurn', me);
      this.act({ type: 'endTurn', player: me });
    }
  }

  /** The one count control's range for the current step. */
  private countRange(): { min: number; max: number; value: number; set: (v: number) => void } | null {
    const s = this.state!;
    const ph = s.phase;
    const sel = this.sel;
    if ((ph.kind === 'reinforce' || ph.kind === 'setup-place') && sel.selected) {
      const left = placeLeft(s, sel);
      if (left < 1) return null;
      return { min: 1, max: left, value: placeValue(s, sel), set: (v) => (sel.placeCount = v) };
    }
    if (ph.kind === 'occupy') {
      return { min: ph.min, max: ph.max, value: sel.occupyCount ?? ph.max, set: (v) => ((sel.occupyCount = v), (sel.countTouched = true)) };
    }
    if (ph.kind === 'fortify' && sel.selected && sel.target) {
      const max = Math.max(1, s.territories[sel.selected].armies - 1);
      return { min: 1, max, value: sel.fortifyCount ?? max, set: (v) => ((sel.fortifyCount = v), (sel.countTouched = true)) };
    }
    return null;
  }

  private setCount(v: number): void {
    if (!this.state || !this.interactive()) return;
    const r = this.countRange();
    if (!r) return;
    const value = Math.min(r.max, Math.max(r.min, Math.round(v)));
    if (value !== r.value) {
      this.clearRejection();
      r.set(value);
    }
    this.invalidate();
  }

  /** Esc / ocean: one level at a time (the cards sheet, the target, the pick). False = nothing to back out of. */
  private backOut(): boolean {
    if (this.truceMode) {
      this.truceMode = false;
      return true;
    }
    if (this.cardsOpen) {
      this.cardsOpen = false;
      return true;
    }
    const sel = this.sel;
    if (sel.target) {
      this.sel = { ...sel, target: null, fortifyCount: null, countTouched: false };
      this.clearLinger();
      return true;
    }
    if (sel.selected) {
      this.sel = { ...sel, selected: null, placeCount: null };
      this.clearLinger();
      return true;
    }
    return false;
  }

  /** What Enter does now: the brass button, else the track's recommended segment when it's the brass one. */
  private enterTarget(): { button: ButtonId } | { seg: TrackSegId } | null {
    const strip = this.currentStrip();
    if (!strip) return null;
    const b = strip.buttons.find((x) => x.primary);
    if (b) return { button: b.id };
    const tr = strip.track;
    if (tr.live && !tr.disabled && tr.primary && tr.recommended) return { seg: tr.recommended };
    return null;
  }

  private onKey(e: KeyboardEvent): void {
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.tagName === 'SELECT' || tgt.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    const key = e.key;
    // A keyboard-focused HUD control gets its own Enter/Space.
    const active = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
    if ((key === 'Enter' || key === ' ') && active && active !== document.body && (active.tagName === 'BUTTON' || active.getAttribute('role') === 'button' || active.getAttribute('role') === 'slider')) return;
    if (this.handleKey(key, e.repeat)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  /**
   * The hidden keyboard accelerators: Enter = the brass thing (the primary button, or the recommended
   * track segment), Space = Blitz / confirm (never a phase change), Esc = back one level, then the menu.
   * Returns true when the key was consumed.
   */
  handleKey(key: string, repeat = false): boolean {
    if (!this.menuKeys && (this.confirm || this.overlay || this.screen !== 'game' || this.handoff)) {
      // src/ui owns keys on menus, overlays, confirms and the hand-off cover.
      return false;
    }
    if (key === 'Escape') {
      if (this.confirm) {
        this.confirm = null;
        this.invalidate();
        return true;
      }
      if (this.overlay) {
        this.setOverlay(this.overlay === 'pause' ? null : this.overlayReturn);
        return true;
      }
      if (this.screen === 'newGame') {
        this.screen = 'title';
        this.invalidate();
        return true;
      }
      if (this.screen !== 'game') return false;
      if (this.interactive() && this.backOut()) {
        this.clearRejection();
        this.invalidate();
        return true;
      }
      this.setOverlay('pause');
      return true;
    }
    if (this.screen === 'victory') {
      if (key === 'Enter' && !repeat) {
        this.intent({ type: 'rematch' });
        return true;
      }
      return false;
    }
    if (this.screen !== 'game' || this.overlay || this.confirm) return false;
    if (!this.state || (key !== 'Enter' && key !== ' ')) return false;
    if (repeat) return true;
    if (this.turnBanner) this.dismissTurnBanner();
    if (this.handoff) {
      this.intent({ type: 'handoffAccept' });
      return true;
    }
    if (!this.interactive()) {
      this.skipWatched();
      return true;
    }
    if (key === ' ') {
      if (this.now() < this.spaceGuardUntil) return true;
      if (this.busyBlocking()) {
        // Space skips; it never also commits.
        this.skipAll = true;
        this.board.skipAnimations();
        this.wakeAll();
        this.spaceGuardUntil = this.now() + 300;
        return true;
      }
      const commit = this.commitButton();
      if (commit) this.pressButton(commit);
      return true;
    }
    // Enter means the brass thing the player is looking at now. If a click-through changes it before
    // the key runs, the key is spent, not redirected.
    const seen = JSON.stringify(this.enterTarget());
    const run = () => {
      const t = this.enterTarget();
      if (!t || JSON.stringify(t) !== seen) return;
      if ('button' in t) this.pressButton(t.button);
      else this.pressTrack(t.seg);
    };
    if (this.busyBlocking()) this.clickThrough(run);
    else run();
    return true;
  }

  /** The button Space commits (Blitz, Place, Move, a forced trade); never a phase change. */
  private commitButton(): ButtonId | null {
    const ids = new Set(this.currentStrip()?.buttons.map((b) => b.id) ?? []);
    for (const id of ['blitz', 'place', 'move'] as const) if (ids.has(id)) return id;
    const ph = this.state!.phase;
    if (ph.kind === 'reinforce' && ph.mustTrade && ids.has('trade')) return 'trade';
    return null;
  }

  private setOverlay(o: Overlay): void {
    if (o === 'rules' || o === 'settings' || o === 'log') {
      this.overlayReturn = this.overlay === 'rules' || this.overlay === 'settings' || this.overlay === 'log' ? this.overlayReturn : this.overlay;
    } else this.overlayReturn = null;
    this.overlay = o;
    if (o) this.cardsOpen = false;
    this.invalidate();
    if (!o) this.scheduleAi();
  }

  intent(i: UiIntent): void {
    switch (i.type) {
      case 'nav':
        this.screen = i.screen;
        this.overlay = null;
        this.board.setAttractMode(true);
        if (i.screen === 'title') this.refreshSaveSummary();
        break;
      case 'overlay':
        this.setOverlay(i.overlay);
        break;
      case 'continue': {
        // The save is on another map than this page's board (a `?map=` override): reload onto it.
        const f = readJson<SaveFile>(this.kv, SAVE_KEY);
        const want = f && isPlausibleState(f.state) ? (isKnownMap(f.state.config.mapId) ? f.state.config.mapId : DEFAULT_MAP_ID) : this.bootMap;
        // (An explicit `?map=` on a dev / e2e build wins: that board plays the save.)
        if (want !== this.bootMap && !this.mapFromUrl() && this.reloadOnto({ v: 1, resume: true })) break;
        if (!this.loadSave()) {
          console.warn("[risk] that save couldn't be loaded");
          this.refreshSaveSummary();
        }
        break;
      }
      case 'seat':
        this.draft = patchSeat(this.draft, i.index, i.patch);
        this.rememberDraft();
        break;
      case 'addSeat':
        this.draft = addSeat(this.draft);
        this.rememberDraft();
        break;
      case 'removeSeat':
        this.draft = removeSeat(this.draft, i.index);
        this.rememberDraft();
        break;
      case 'map':
        if (isKnownMap(i.id)) this.draft = { ...this.draft, mapId: i.id };
        this.rememberDraft();
        break;
      case 'length':
        this.draft = { ...this.draft, length: i.value };
        this.rememberDraft();
        break;
      case 'setup':
        this.draft = { ...this.draft, setup: i.value };
        this.rememberDraft();
        break;
      case 'house':
        this.draft = sanitizeDraft({ ...this.draft, house: { ...this.draft.house, ...i.patch } });
        this.rememberDraft();
        break;
      case 'start': {
        const vm = buildNewGameVM(this.draft);
        if (!vm.canStart) break;
        this.rememberDraft();
        const config = draftToConfig(this.draft, this.randomSeed());
        // The board's geometry is fixed per page load: a game on another map starts after a reload onto it
        // (the save names the map, src/map/registry.ts activeMapId; the deal plays from BOOT_KEY).
        if ((config.mapId ?? DEFAULT_MAP_ID) !== this.bootMap && !validateConfig(config)) {
          const { state } = createGame(config);
          writeJson(this.kv, SAVE_KEY, { v: 1, savedAt: Date.now(), state } satisfies SaveFile);
          if (this.reloadOnto({ v: 1, start: config })) break;
        }
        this.startGame(config);
        break;
      }
      case 'button':
        this.pressButton(i.id);
        break;
      case 'track':
        this.pressTrack(i.seg);
        break;
      case 'resetView':
        if (this.screen === 'game') {
          this.viewMoved = false;
          this.board.resetCamera();
        }
        break;
      case 'setCount':
        this.setCount(i.value);
        break;
      case 'cardsPanel':
        this.cardsOpen = i.open && !!this.state && this.interactive() && this.state.phase.kind === 'reinforce';
        break;
      case 'handoffAccept':
        if (this.handoff) {
          this.handoff = null;
          this.guardUntil = this.now() + 250;
        }
        break;
      case 'dismissTurnBanner':
        this.dismissTurnBanner();
        break;
      case 'endGameNow':
        if (this.allHumansOut) {
          this.endGameNow();
          break;
        }
        this.confirm = { kind: 'endGame', text: this.endGameText() };
        break;
      case 'restart':
        this.confirm = { kind: 'restart', text: `Restart this game?${SEP}Same seats, a new deal.` };
        break;
      case 'confirm': {
        const c = this.confirm;
        this.confirm = null;
        if (c && i.yes) {
          // Both leave the paused game behind: close the menu they were opened from.
          this.overlay = null;
          if (c.kind === 'endGame') this.endGameNow();
          else this.restart();
        }
        break;
      }
      case 'setController':
        this.setSeatController(i.player, i.kind, i.difficulty);
        break;
      case 'proposeTruce':
        this.proposeTruce(i.to);
        break;
      case 'reloadForUpdate':
        this.save();
        this.reloadFn?.();
        break;
      case 'saveAndQuit':
        this.save();
        this.wakeAll();
        this.queue = [];
        this.screen = 'title';
        this.overlay = null;
        this.state = null;
        this.disp = null;
        this.board.setAttractMode(true);
        this.refreshSaveSummary();
        break;
      case 'rematch':
        if (this.now() < this.holdUntil) {
          this.inputDropped++;
          break;
        }
        this.rematch();
        break;
      case 'setting':
        this.setSettings(i.patch);
        break;
    }
    this.invalidate();
  }

  /**
   * Hand a seat to the AI or back (R1-22). Applied at a safe point: never inside an AI beat or while
   * events are still playing, so the display and the engine agree on who drives the turn.
   */
  private setSeatController(player: PlayerId, kind: PlayerKind, difficulty?: AiDifficulty): void {
    const epoch = this.epoch;
    const tryApply = () => {
      const s = this.state;
      if (epoch !== this.epoch || !s || this.screen !== 'game' || s.phase.kind === 'game-over') return;
      const p = s.players[player];
      if (!p || p.eliminated || p.kind === kind) return;
      if (this.aiBusy || this.pumping || this.queue.length || this.inflight > 0) {
        this.timer(tryApply, 60);
        return;
      }
      // A seat handed to the AI plays with a personality (v3): its own if it had one, else the least used
      // at the table, so the AI it becomes can make truces like the others.
      const personality: AiPersonality | undefined =
        kind === 'ai' ? (p.personality ?? [...PERSONALITY_IDS].sort((a, b) => s.players.filter((x) => x.personality === a).length - s.players.filter((x) => x.personality === b).length)[0]) : undefined;
      const r = this.applyRaw({ type: 'setController', player, kind, ...(kind === 'ai' ? { difficulty: difficulty ?? 'normal', personality } : {}) });
      if (!r.ok) {
        console.warn('[risk] seat change refused:', r.error);
        return;
      }
      if (player === s.currentPlayer) {
        // Whoever takes over starts from a clean selection (staged armies were never committed).
        this.sel = emptySel();
        this.frozenSel = null;
        this.aiCtx = null;
      }
      this.enqueue(r.events.map((ev, i) => ({ ev, after: r.state, end: i === r.events.length - 1 })), { ai: false });
      const name = p.name;
      this.log('system', player, kind === 'ai' ? `The AI plays ${name}'s seat` : `${name} takes the seat back`);
      this.applyBoardSpeed();
      this.invalidate();
      this.scheduleAi();
    };
    tryApply();
  }

  private standingsOrder(s: GameState): PlayerId[] {
    // The 2-player neutral seat never wins and never places (the engine's victory ignores it too).
    return s.players
      .filter((p) => !p.neutral)
      .sort((a, b) => {
        const ta = territoryCount(s, a.id);
        const tb = territoryCount(s, b.id);
        if (tb !== ta) return tb - ta;
        const aa = totalArmies(s, a.id);
        const ab = totalArmies(s, b.id);
        if (ab !== aa) return ab - aa;
        if (a.eliminated && b.eliminated) return (b.eliminatedOnTurn ?? 0) - (a.eliminatedOnTurn ?? 0);
        return a.id - b.id;
      })
      .map((p) => p.id);
  }

  private endGameText(): string {
    const s = this.state;
    if (!s) return 'End the game now?';
    const leader = this.standingsOrder(s)[0];
    return `End the game now? ${pName(s, leader)} wins on territories (${territoryCount(s, leader)} of 42).`;
  }

  private endGameNow(): void {
    const s = this.state;
    if (!s) return;
    const leader = this.standingsOrder(s)[0];
    this.clearSave();
    this.wakeAll();
    this.queue = [];
    this.skipAll = true;
    this.board.skipAnimations();
    this.victory = this.buildVictory(s, leader, `Called in round ${Math.max(1, s.round)}`);
    this.screen = 'victory';
    this.allHumansOut = false;
    this.holdUntil = this.now() + 600;
    this.board.setAttractMode(true);
    this.play('victory');
    this.closeTurnMetric();
  }

  private restart(): void {
    const s = this.state;
    if (!s) return;
    this.startGame({ ...s.config, seed: this.randomSeed() });
  }

  private rematch(): void {
    const s = this.state;
    if (!s) {
      this.intent({ type: 'nav', screen: 'newGame' });
      return;
    }
    const players = s.config.players.map((p, i) => ({ ...p, kind: s.players[i]?.kind ?? p.kind }));
    this.startGame({ ...s.config, players, seed: this.randomSeed() });
  }

  // =========================================================================
  // AI highlight reel (UX.md §6.1)
  // =========================================================================

  private aiShouldAct(): boolean {
    const s = this.state;
    if (!s || this.screen !== 'game' || this.overlay || this.confirm || this.handoff) return false;
    if (s.phase.kind === 'game-over') return false;
    return this.isAiDriven(s.currentPlayer);
  }

  private scheduleAi(): void {
    if (this.aiScheduled || this.aiBusy) return;
    if (!this.aiShouldAct()) return;
    // Non-blocking drops may still be landing: the next beat's think time overlaps them.
    if (this.queue.length || this.pumping) return;
    this.aiScheduled = true;
    this.timer(() => {
      this.aiScheduled = false;
      if (this.aiBusy || !this.aiShouldAct() || this.queue.length || this.pumping) return;
      void this.aiBeat();
    }, 0);
  }

  private aiTurnKey(s: GameState): string {
    return s.turn > 0 ? `t${s.turn}` : `s${s.currentPlayer}:${s.players[s.currentPlayer].setupArmies}`;
  }

  private async aiBeat(): Promise<void> {
    this.aiBusy = true;
    const epoch = this.epoch;
    try {
      await this.aiBeatInner();
    } catch (err) {
      const s = this.state;
      if (epoch === this.epoch && s && s.phase.kind !== 'game-over') {
        console.error('[risk] AI beat failed', err);
        const r = this.applyRaw(fallbackAction(s, s.currentPlayer));
        if (r.ok) this.enqueue(r.events.map((ev, i) => ({ ev, after: r.state, end: i === r.events.length - 1 })), { ai: true, skip: true });
      }
    } finally {
      this.aiBusy = false;
    }
    if (!this.queue.length && !this.pumping) {
      if (this.inflight === 0) this.afterSettled();
      else this.scheduleAi();
    }
  }

  private chooseFor(s: GameState): Action {
    return chooseAiAction(s, s.currentPlayer);
  }

  private async aiBeatInner(): Promise<void> {
    let s = this.state!;
    const p = s.currentPlayer;
    const key = this.aiTurnKey(s);
    if (!this.aiCtx || this.aiCtx.key !== key || this.aiCtx.player !== p) {
      const opening = s.round === 1 && !this.humanHasPlayed;
      const fresh: AiTurnCtx = {
        key,
        player: p,
        startedAt: this.now(),
        first: true,
        briefCount: 0,
        capped: false,
        capMs: opening ? AI_OPENING_CAP_MS : AI_TURN_CAP_MS,
        // Round 1 is a land grab: AI-vs-AI fights are pure headline there.
        headlineMs: s.round <= 1 ? AI_OPENING_CAP_MS * 0.6 : s.round >= AI_HEADLINE_LATE_ROUND ? AI_HEADLINE_LATE_MS : AI_HEADLINE_MS,
        compressFrom: s.round <= 1 ? 2 : 3,
        fullCount: 0,
      };
      this.aiCtx = fresh;
      if (s.turn > 0) this.timer(() => this.capAiTurn(fresh), fresh.capMs);
    }
    const ctx = this.aiCtx;
    const speed = this.aiSpeed();
    const k = speed === 'fast' ? 0.4 : 1;
    const overCap = ctx.capped || (s.turn > 0 && this.now() - ctx.startedAt > ctx.capMs);
    const name = pName(s, p);
    this.applyBoardSpeed();

    if (speed === 'instant' || overCap) {
      await this.aiInstantTurn(overCap && speed !== 'instant');
      return;
    }

    const ph = s.phase.kind;
    if (ph === 'setup-claim') {
      const a = this.chooseFor(s);
      const r = this.applyRaw(a);
      if (!r.ok) return this.aiFallback();
      this.enqueue(r.events.map((ev, i) => ({ ev, after: r.state, end: i === r.events.length - 1 })), { ai: true });
      await this.sleep(120 * k);
      return;
    }

    if (ph === 'setup-place' || ph === 'reinforce') {
      if (ctx.first && ph === 'reinforce') await this.sleep(THINK_TURN_START * k);
      ctx.first = false;
      if (this.state !== s) return; // something else moved the game
      const collected: { ev: GameEvent; after: GameState; end: boolean }[] = [];
      for (let guard = 0; guard < 200; guard++) {
        s = this.state!;
        if (s.currentPlayer !== p || (s.phase.kind !== 'reinforce' && s.phase.kind !== 'setup-place')) break;
        const a = this.chooseFor(s);
        const r = this.applyRaw(a);
        if (!r.ok) {
          const fb = this.applyRaw(fallbackAction(s, p));
          if (!fb.ok) break;
          fb.events.forEach((ev, i) => collected.push({ ev, after: fb.state, end: i === fb.events.length - 1 }));
          continue;
        }
        r.events.forEach((ev, i) => collected.push({ ev, after: r.state, end: i === r.events.length - 1 }));
        if (a.type === 'endReinforce') break;
      }
      // The narration follows the drops as they land (onEventStart).
      const drops = collected.filter((x) => x.ev.type === 'armiesPlaced').length;
      const budget = ph === 'setup-place' ? 800 : 1000;
      const stagger = drops > 1 ? Math.min(50 * k, (budget - 290) / (drops - 1)) : 0;
      this.enqueue(collected, { ai: true, style: 'brief', stagger: Math.max(10, stagger) });
      return;
    }

    if (ph === 'occupy') {
      const r = this.applyRaw(this.chooseFor(s));
      if (!r.ok) return this.aiFallback();
      this.enqueue(r.events.map((ev, i) => ({ ev, after: r.state, end: i === r.events.length - 1 })), { ai: true });
      return;
    }

    if (ph === 'attack') {
      const a0 = this.chooseFor(s);
      if (isAttackAction(a0)) {
        // Once AI-vs-AI fights are compressed (2× / snapped), the pause between them shrinks too.
        const late = this.now() - ctx.startedAt > ctx.headlineMs;
        const between = ctx.briefCount >= ctx.compressFrom || late ? THINK_BETWEEN_COMPRESSED : THINK_BETWEEN;
        await this.sleep((ctx.first ? THINK_TURN_START : between) * k);
        ctx.first = false;
        if (this.state !== s || !this.aiShouldAct()) return;
        await this.aiEngagement(a0, speed, ctx);
        return;
      }
      ctx.first = false;
      const r = this.applyRaw(a0);
      if (!r.ok) return this.aiFallback();
      this.enqueue(r.events.map((ev, i) => ({ ev, after: r.state, end: i === r.events.length - 1 })), { ai: true });
      return;
    }

    if (ph === 'fortify') {
      const a = this.chooseFor(s);
      if (a.type === 'fortify') {
        this.aiHighlights = { arrow: { from: a.from, to: a.to, kind: 'fortify', path: fortifyPath(s, a.from, a.to) ?? undefined } };
        this.invalidate();
      }
      const r = this.applyRaw(a);
      if (!r.ok) return this.aiFallback();
      this.enqueue(r.events.map((ev, i) => ({ ev, after: r.state, end: i === r.events.length - 1 })), { ai: true });
      return;
    }
  }

  /** 10 s into an AI turn: finish what's animating now and play the rest at instant (UX.md §6.1). */
  private capAiTurn(ctx: AiTurnCtx): void {
    const s = this.state;
    if (this.aiCtx !== ctx || !s || s.currentPlayer !== ctx.player || s.phase.kind === 'game-over' || this.aiSpeed() === 'instant') return;
    const d = this.disp;
    if (!d || d.currentPlayer !== ctx.player) return;
    ctx.capped = true;
    for (const e of this.queue) if (e.ai && e.ev.type !== 'turnStarted') e.speed = 0;
    this.setBoardSpeed(0);
    this.board.skipAnimations();
    this.wakeAll();
  }

  private aiFallback(): void {
    const s = this.state;
    if (!s) return;
    const r = this.applyRaw(fallbackAction(s, s.currentPlayer));
    if (r.ok) this.enqueue(r.events.map((ev, i) => ({ ev, after: r.state, end: i === r.events.length - 1 })), { ai: true });
  }

  private onScreenForAi(t: TerritoryId): boolean {
    const pos = this.board.getScreenPosition(t);
    if (!pos) return false;
    if (typeof window === 'undefined') return true;
    const m = 16;
    return (
      pos.x >= this.insets.left + m &&
      pos.x <= window.innerWidth - this.insets.right - m &&
      pos.y >= this.insets.top + m &&
      pos.y <= window.innerHeight - this.insets.bottom - m
    );
  }

  private async waitCamera(): Promise<void> {
    const start = this.now();
    await this.sleep(60);
    while (this.now() - start < 720) {
      const st = this.board.getStats();
      if (st.cameraMoving === undefined) {
        await this.sleep(560 - (this.now() - start));
        return;
      }
      if (!st.cameraMoving) return;
      await this.sleep(40);
    }
  }

  private async aiEngagement(first: Extract<Action, { type: 'attack' | 'blitz' }>, speed: AiSpeed, ctx: AiTurnCtx): Promise<void> {
    const s0 = this.state!;
    const p = s0.currentPlayer;
    const { from, to } = first;
    const defender = s0.territories[to].owner;
    // Fights against a human get the full show; once the turn is past its headline point, later ones
    // play brief (still visible: arrow, badge ticks, flip) instead of stalling the room.
    const pastHeadline = this.now() - ctx.startedAt > ctx.headlineMs;
    const full =
      speed === 'watch' && this.isHumanSeat(defender, s0) && !this.autoplayOn && !pastHeadline && ctx.fullCount < AI_FULL_FIGHTS_PER_TURN;
    if (full) ctx.fullCount++;
    const vsHuman = this.isHumanSeat(defender, s0) && !this.autoplayOn;
    const style: 'full' | 'brief' = full ? 'full' : 'brief';
    const collected: { ev: GameEvent; after: GameState; end: boolean }[] = [];
    let act: Action = first;
    for (let guard = 0; guard < 60; guard++) {
      const r = this.applyRaw(act);
      if (!r.ok) break;
      r.events.forEach((ev, i) => collected.push({ ev, after: r.state, end: i === r.events.length - 1 }));
      const s = this.state!;
      if (s.phase.kind === 'game-over') break;
      if (s.phase.kind === 'occupy') {
        const occ = this.chooseFor(s);
        const r2 = this.applyRaw(occ.type === 'occupy' ? occ : fallbackAction(s, p));
        if (r2.ok) r2.events.forEach((ev, i) => collected.push({ ev, after: r2.state, end: i === r2.events.length - 1 }));
        break;
      }
      if (s.territories[to].owner === p || s.phase.kind !== 'attack') break;
      const next = this.chooseFor(s);
      if (isAttackAction(next) && next.from === from && next.to === to) {
        act = next;
        continue;
      }
      break;
    }
    const d = this.disp!;
    const planned = this.state;
    this.narration = `${pName(d, p)} attacks ${tName(to)}`;
    // Camera: frame the fight once if it's off-screen, before the arrow (UX.md §8.3).
    if (!this.onScreenForAi(from) || !this.onScreenForAi(to)) {
      this.board.focusTerritories([from, to]);
      await this.waitCamera();
      if (this.state !== planned) return;
    }
    // A snapped fight (AI vs AI past the headline point) plays at once and its own event dries the arrow;
    // a telegraph set now would land after that and redraw the stroke over the next turn's start (INK F6).
    const snapped = !full && !vsHuman && pastHeadline;
    if (!snapped) this.aiHighlights = { selected: from, targets: [to], arrow: { from, to, kind: 'attack' } };
    if (full) {
      this.aiPreview = { from, to };
      this.invalidate();
      await this.sleep(TELEGRAPH_MS);
    }
    if (this.state !== planned) return;
    this.invalidate();
    // Weight follows stakes: AI-vs-AI fights are headlines. From the third one in a turn they run at 2×,
    // and once the turn is past its headline point (6 s; 4 s from round 4) they snap (the result still lands).
    let boardSpeed: number | undefined;
    let snap = false;
    if (!full && !vsHuman) {
      ctx.briefCount++;
      if (ctx.briefCount >= ctx.compressFrom && speed === 'watch') boardSpeed = 2;
      if (snapped) snap = true;
    } else if (!full && vsHuman && speed === 'watch') {
      // Past the headline point or the full-fight cap, fights against a human stay visible (arrow, ticks,
      // flip; never snapped) but run at 2×, so a rampage doesn't stall the room. The recap lists them.
      boardSpeed = 2;
    }
    // (A snapped conquest still gets the instant-speed 250 ms beat in the pump.)
    this.enqueue(collected, { ai: true, style, speed: snap ? 0 : boardSpeed });
    const beat = this.beat - 1;
    // Clear the telegraph once this engagement's events have played.
    const clear = () => {
      if (this.queue.some((e) => e.beat === beat) || (this.blockingNow && this.blockingNow.beat === beat)) {
        this.timer(clear, 50);
        return;
      }
      if (this.aiPreview?.from === from && this.aiPreview.to === to) this.aiPreview = null;
      if (this.aiHighlights?.arrow?.from === from && this.aiHighlights.arrow.to === to) this.aiHighlights = null;
      this.invalidate();
    };
    this.timer(clear, 50);
  }

  /** Instant AI speed (and the 10 s cap): the rest of the turn snaps, then a 300 ms beat. */
  private async aiInstantTurn(capped: boolean): Promise<void> {
    const s0 = this.state!;
    const p = s0.currentPlayer;
    const turn = s0.turn;
    const collected: { ev: GameEvent; after: GameState; end: boolean }[] = [];
    for (let guard = 0; guard < 2000; guard++) {
      const s = this.state!;
      if (s.phase.kind === 'game-over' || s.currentPlayer !== p || s.turn !== turn) break;
      if (s.turn === 0 && collected.some((x) => x.ev.type === 'setupTurn' || x.ev.type === 'territoryClaimed')) break;
      let r = this.applyRaw(this.chooseFor(s));
      if (!r.ok) r = this.applyRaw(fallbackAction(s, p));
      if (!r.ok) break;
      const rr = r;
      rr.events.forEach((ev, i) => collected.push({ ev, after: rr.state, end: i === rr.events.length - 1 }));
    }
    this.narration = capped ? `${pName(s0, p)} finishes the turn` : `${pName(s0, p)} is playing`;
    this.aiHighlights = null;
    this.aiPreview = null;
    this.enqueue(collected, { ai: true, skip: true });
    await this.sleep(s0.turn === 0 ? 60 : 300);
  }

  // =========================================================================
  // ViewModel
  // =========================================================================

  private viewSel(): Sel {
    return this.frozenSel && this.busyBlocking() ? this.frozenSel : this.sel;
  }

  private buildVM(): ViewModel {
    return {
      screen: this.screen,
      overlay: this.overlay,
      settings: this.settings,
      reducedMotion: this.reducedMotion(),
      save: this.saveSummary,
      newGame: { ...buildNewGameVM(this.draft), ...newGameExtras(this.draft) },
      game: this.buildGame(),
      victory: this.victory,
      rulesNotes: this.rulesNotes(),
      boardLost: this.boardLost,
    };
  }

  private buildGame(): GameVM | null {
    const d = this.disp;
    const s = this.state;
    if (!d || !s || !this.meta) return null;
    if (this.rejection && this.rejection.until <= this.now()) this.rejection = null;
    const interactive = this.interactive() && d.currentPlayer === s.currentPlayer;
    const sel = this.viewSel();
    const banner = this.banner?.vm.kind === 'elimination' ? this.banner.vm : (this.turnBanner ?? this.banner?.vm ?? null);
    const strip = this.buildStripVM(d, sel, interactive);
    const cards = this.buildCards(d, interactive);
    return {
      seats: this.buildSeats(d),
      strip,
      gold: this.buildGold(d, strip, cards),
      battle: this.buildBattle(d, sel, interactive),
      cards,
      log: this.meta.log,
      round: d.round,
      events: this.meta.log.slice(-2),
      ...(this.updateReady ? { updateReady: true } : {}),
      banner,
      handoff: this.handoff ? { seat: seatRef(d, this.handoff.player), subline: this.handoffSubline(this.handoff.player) } : null,
      confirm: this.confirm,
      seatActions: this.buildSeatActions(d),
      viewMoved: this.viewMoved,
      nameCard: this.nameCard,
      seed: this.gameSeed(s),
    };
  }

  /**
   * One gold (docs/INK.md B2.1): the hand-off ring → the open Cards sheet's trade → the pending commit
   * button → the recommended track segment → the current segment. Never two.
   */
  private buildGold(d: GameState, strip: StripVM, cards: CardsVM | null): GoldVM {
    if (this.handoff) return { kind: 'handoff' };
    if (this.screen !== 'game' || d.phase.kind === 'game-over') return null;
    if (cards?.open && cards.trade) return { kind: 'cardsTrade' };
    // Gold is "now" (INK B2.1, A9): while the board's gold is in flight (a stroke being drawn, the dice
    // deciding), the HUD's gold steps down to ivory. The resting armed arrow is ivory, so Blitz takes it.
    if (this.strokeLive || this.fightPlaying()) return null;
    const b = strip.buttons.find((x) => x.primary);
    if (b) return { kind: 'button', id: b.id };
    const tr = strip.track;
    if (tr.primary && tr.recommended) return { kind: 'segment', seg: tr.recommended };
    if (strip.mode === 'idle') return null;
    const cur = tr.segments.find((x) => x.state === 'current');
    return cur ? { kind: 'segment', seg: cur.id } : null;
  }

  private handoffSubline(p: PlayerId): string {
    const s = this.state!;
    const r = reinforcementsFor(s, p);
    const n = s.players[p].cards.length;
    const parts = [`+${r.total} armies waiting`, n === 1 ? '1 card' : `${n} cards`];
    if (bestSet(s, p)) parts.push('set ready');
    return parts.join(SEP);
  }

  /** Rules sheet, 'This game': this game's rules, or the New game draft's before a game starts. */
  private rulesNotes(): string[] {
    const s = this.state;
    const lines: string[] = [];
    const house = s ? s.config : this.draft.house;
    if (s) {
      const need = territoriesNeeded(s);
      lines.push(need >= 42 ? 'Goal: take every territory.' : `Goal: first to ${need} territories wins.`);
      if (s.config.turnLimit) lines.push(`Game ends after round ${s.config.turnLimit}${SEP}most territories wins.`);
    } else lines.push(buildNewGameVM(this.draft).summary);
    lines.push(
      house.cardBonus === 'progressive'
        ? 'Card sets: 4, 6, 8, 10, 12, 15, then +5 each.'
        : 'Card sets: 3 infantry 4 · 3 cavalry 6 · 3 artillery 8 · one of each 10.',
    );
    lines.push(house.fortifyRule === 'connected' ? 'Fortify: along any chain of your territories.' : 'Fortify: to a neighbor only.');
    return lines;
  }

  private buildSeats(d: GameState): SeatChipVM[] {
    const lit = this.truceMode ? this.truceSeats() : [];
    return d.players.map((p) => ({
      ...this.seatExtras(d, p.id, lit),
      seat: seatRef(d, p.id),
      current: p.id === d.currentPlayer && d.phase.kind !== 'game-over',
      eliminated: p.eliminated,
      territories: territoryCount(d, p.id),
      armies: TERRITORY_IDS.reduce((n, t) => n + (d.territories[t].owner === p.id ? d.territories[t].armies : 0), 0),
      cards: p.cards.length,
      continents: CONTINENT_IDS.filter((c) => CONTINENTS[c].territories.every((t) => d.territories[t].owner === p.id)),
      lostKey: this.lostKeys[p.id] ?? 0,
      out: p.eliminated && this.meta?.out?.[p.id] && d.players[this.meta.out[p.id].by] ? { by: seatRef(d, this.meta.out[p.id].by), round: this.meta.out[p.id].round } : null,
    }));
  }

  /** v3 seat marks: the neutral flag, an AI's personality, its strongest grudge (≥ 2), a lit truce ring. */
  private seatExtras(d: GameState, id: PlayerId, lit: PlayerId[]): Pick<SeatChipVM, 'neutral' | 'personality' | 'grudge' | 'truceTarget'> {
    const p = d.players[id];
    const out: Pick<SeatChipVM, 'neutral' | 'personality' | 'grudge' | 'truceTarget'> = {};
    if (p.neutral) out.neutral = true;
    if (p.kind === 'ai' && !p.neutral && p.personality) {
      const info = PERSONALITIES[p.personality];
      out.personality = { name: info.name, line: info.line };
      const top = p.eliminated ? null : grudgesOf(d, id)[0];
      const at = top && top.value >= 2 ? d.players[top.seat] : null;
      if (at && !at.eliminated && !at.neutral) out.grudge = seatRef(d, top!.seat);
    }
    if (lit.includes(id)) out.truceTarget = true;
    return out;
  }

  /** Settings → Seats: hand a human seat to the AI, or give a seat that started human back. */
  private buildSeatActions(d: GameState): GameVM['seatActions'] {
    if (d.phase.kind === 'game-over' || this.autoplayOn) return [];
    const out: GameVM['seatActions'] = [];
    for (const p of d.players) {
      if (p.eliminated) continue;
      const startedHuman = d.config.players[p.id]?.kind === 'human';
      if (p.kind === 'human') {
        out.push({ seat: seatRef(d, p.id), label: `Let the AI play ${p.name}`, intent: { type: 'setController', player: p.id, kind: 'ai', difficulty: 'normal' } });
      } else if (startedHuman) {
        out.push({ seat: seatRef(d, p.id), label: `${p.name} takes the seat back`, intent: { type: 'setController', player: p.id, kind: 'human' } });
      }
    }
    return out;
  }

  private buildStripVM(d: GameState, sel: Sel, interactive: boolean): StripVM {
    const me = d.currentPlayer;
    let narration: string | null = null;
    let idle: string | null = null;
    if (!interactive) {
      if (d.phase.kind === 'game-over') idle = `${pName(d, d.phase.winner)} wins`;
      else if (this.screen === 'victory') idle = 'The game is over';
      else if (!this.handoff) {
        // What happened, as it lands (set from the events); before anything has, whose turn it is.
        narration =
          this.narration ?? (d.phase.kind === 'setup-claim' && d.config.setupMode !== 'draft' ? 'Dealing territories' : `${poss(pName(d, me))} turn`);
      }
    }
    // The armed target has fallen on the displayed board while the conquest still plays: the frozen
    // selection would describe a half-moved board.
    const took =
      interactive && this.frozenSel && sel === this.frozenSel && d.phase.kind === 'attack' && sel.selected && sel.target &&
      d.territories[sel.selected].owner === me && d.territories[sel.target].owner === me
        ? sel.target
        : null;
    const strip = buildStrip({
      s: d,
      sel,
      interactive,
      narration,
      handoff: this.handoff ? this.handoff.player : null,
      humansOut: this.allHumansOut,
      idleLine: idle,
      rejection: interactive && this.rejection ? { text: this.rejection.text, key: this.rejection.key } : null,
      showWinChance: this.settings.showWinChance,
      lineKey: this.lineKey,
      rolling: this.fightPlaying(),
      boardPreview: this.boardPreview(),
      took,
    });
    // The cards sheet's `Trade for +N` is the brass thing while it's open: one brass fill on screen.
    if (this.cardsOpen && interactive && d.phase.kind === 'reinforce' && bestSet(d, me)) {
      strip.buttons = strip.buttons.map((b) => (b.primary ? { ...b, primary: false } : b));
      strip.track = { ...strip.track, primary: false };
    }
    // Diplomacy (v3). An offer to the driver asks first: the line is its sentence, the dock says Accept
    // (in the brush ring, the one gold; the track's underline yields) and Decline (bare). Otherwise, in
    // Attack with nothing armed, `Truce` sits bare in the secondary slot while someone can take one.
    if (interactive) {
      const offer = this.pendingOffer();
      if (offer) {
        const said = truceSentence(d, { type: 'truceProposed', from: offer.from, to: offer.to, rounds: offer.rounds, kind: offer.kind }) ?? '';
        if (strip.lineKind !== 'rejection') strip.line = said;
        strip.count = null;
        strip.buttons = [
          { id: 'declineTruce', label: 'Decline', primary: false },
          { id: 'acceptTruce', label: 'Accept', primary: true },
        ];
        strip.track = { ...strip.track, primary: false };
      } else if (strip.mode === 'attack' && strip.buttons.length === 0 && this.truceSeats().length > 0) {
        strip.buttons = [{ id: 'truce', label: 'Truce', primary: false }];
        if (this.truceMode && strip.lineKind !== 'rejection') strip.line = `Offer a ${TRUCE_ROUNDS}-round truce${SEP}${click()} a seat`;
      }
    }
    if (this.now() < this.holdUntil && strip.buttons.length) {
      strip.buttons = strip.buttons.map((b) => (b.primary ? { ...b, busy: true } : b));
      this.timer(() => this.invalidate(), this.holdUntil - this.now() + 10);
    }
    return strip;
  }

  private buildBattle(d: GameState, sel: Sel, interactive: boolean): BattleVM | null {
    const g = this.eng;
    const now = this.now();
    let pair: { from: TerritoryId; to: TerritoryId } | null = null;
    let useEng = false;
    // A pair is only a fight while the two tiles have different owners on the displayed board.
    const contested = (p: { from: TerritoryId; to: TerritoryId }) => {
      const o = d.territories[p.from].owner;
      return o >= 0 && d.territories[p.to].owner !== o;
    };
    const armed =
      interactive && d.phase.kind === 'attack' && sel.selected && sel.target && d.territories[sel.selected].owner === d.currentPlayer
        ? { from: sel.selected, to: sel.target }
        : null;
    // A decided full fight lingers ~1 s, only inside the attack step it was fought in, and goes at once
    // on a new selection or a phase change (docs/ROUND2.md §E).
    const inFight = d.phase.kind === 'attack' || d.phase.kind === 'occupy';
    const lingering = !!g && !!g.endedAt && !g.cleared && g.style === 'full' && g.turn === d.turn && inFight && now - g.endedAt < LINGER_MS;
    const preview = this.aiPreview;
    const previewIsEng = !!preview && !!g && g.from === preview.from && g.to === preview.to && g.turn === d.turn && (!!g.endedAt || g.conquered);
    if (g && !g.endedAt && g.style === 'full' && g.turn === d.turn) {
      pair = g;
      useEng = true;
    } else if (armed && contested(armed)) {
      pair = armed;
      useEng = !!g && g.from === armed.from && g.to === armed.to && g.turn === d.turn && !g.conquered;
    } else if (preview && !previewIsEng && contested(preview)) {
      pair = preview;
    } else if (lingering) {
      pair = g;
      useEng = true;
    }
    if (!pair) return null;
    const { from, to } = pair;
    const attacker = useEng && g ? g.attacker : d.territories[from].owner;
    const defender = useEng && g ? g.defender : d.territories[to].owner;
    if (attacker < 0 || defender < 0 || attacker === defender || !d.players[attacker] || !d.players[defender]) return null;
    // A decided engagement renders from its own record (the armies when the verdict landed), never from
    // the board after the occupy march has moved troops or the tile has changed hands.
    const decided = useEng && !!g && (!!g.endedAt || g.conquered);
    const a = decided ? g!.startA - g!.attLost : d.territories[from].armies;
    const def = decided ? Math.max(0, g!.startD - g!.defLost) : d.territories[to].owner === defender ? d.territories[to].armies : 0;
    return {
      attacker: { seat: seatRef(d, attacker), territory: tName(from), armies: a },
      defender: { seat: seatRef(d, defender), territory: tName(to), armies: def },
      rolling: this.rolling && useEng,
      captured: decided && g!.conquered ? `${tName(to)} captured` : null,
      tray: this.trayUp,
    };
  }

  /** The read-only hand sheet: only for the seat placing now (never behind the hand-off cover). */
  private buildCards(d: GameState, interactive: boolean): CardsVM | null {
    if (!interactive || d.phase.kind !== 'reinforce') return null;
    const me = d.currentPlayer;
    const hand = d.players[me].cards;
    const best = bestSet(d, me);
    return {
      open: this.cardsOpen,
      hand: hand.map((c) => ({
        id: c.id,
        symbol: c.symbol,
        territory: c.territory ? tName(c.territory) : null,
        ownedBonus: !!c.territory && d.territories[c.territory].owner === me,
        inSet: !!best?.cardIds.includes(c.id),
      })),
      status: best ? `Set ready${SEP}+${best.value}` : noSetStatus(hand),
      trade: best ? { label: `Trade for +${best.value}` } : null,
    };
  }

  /** Enemy tiles a target-first click can attack right now. */
  private attackableTargets(d: GameState, me: PlayerId): TerritoryId[] {
    const out = new Set<TerritoryId>();
    for (const src of attackSources(d, me)) for (const t of attackTargets(d, src)) out.add(t);
    return TERRITORY_IDS.filter((t) => out.has(t));
  }

  private buildHighlights(): BoardHighlights {
    const s = this.state;
    const d = this.disp;
    if (!s || !d || this.screen !== 'game') return {};
    const interactive = this.interactive() && d.currentPlayer === s.currentPlayer;
    if (!interactive) return this.aiHighlights ?? {};
    const sel = this.viewSel();
    const me = d.currentPlayer;
    const ph = d.phase;
    const own = () => TERRITORY_IDS.filter((t) => d.territories[t].owner === me);
    const picked = sel.selected && d.territories[sel.selected].owner === me ? sel.selected : null;
    switch (ph.kind) {
      case 'setup-claim':
        // A random deal is playing: nothing to claim, so nothing glows.
        if (d.config.setupMode !== 'draft') return {};
        return { selectable: TERRITORY_IDS.filter((t) => d.territories[t].owner === UNCLAIMED) };
      case 'setup-place': {
        const left = placeLeft(d, sel);
        const pending = { ...sel.staged };
        // The staged armies, plus the stepper's count on the pick as a preview.
        if (picked && left > 0) pending[picked] = (pending[picked] ?? 0) + placeValue(d, sel);
        return { selectable: left > 0 ? own() : [], selected: left > 0 ? picked : null, pending };
      }
      case 'reinforce': {
        if (ph.mustTrade) return {};
        if (ph.remaining > 0) return { selectable: own(), selected: picked, pending: picked ? { [picked]: placeValue(d, sel) } : {} };
        // All placed: the track moves on; the board has nothing to click.
        return {};
      }
      case 'attack': {
        if (!picked) return { selectable: this.attackableTargets(d, me) };
        const targets = attackTargets(d, picked);
        const armed = sel.target && targets.includes(sel.target) ? sel.target : null;
        // Armed: only the pair and the arrow are lit; the other targets fall back to plain selectable.
        if (armed) {
          return {
            selected: picked,
            targets: [armed],
            selectable: targets.filter((t) => t !== armed),
            arrow: { from: picked, to: armed, kind: 'attack' },
            dimOthers: true,
          };
        }
        return { selected: picked, targets, arrow: null, dimOthers: true };
      }
      case 'occupy':
        return { selected: ph.from, targets: [ph.to], arrow: { from: ph.from, to: ph.to, kind: 'attack' } };
      case 'fortify': {
        if (!picked) return { selectable: fortifySources(d, me).filter((t) => fortifyTargets(d, t).length > 0) };
        const targets = selectionTargets(d, sel);
        const dest = sel.target && targets.includes(sel.target) ? sel.target : null;
        return {
          selected: picked,
          targets,
          arrow: dest ? { from: picked, to: dest, kind: 'fortify', path: fortifyPath(d, picked, dest) ?? undefined } : null,
          dimOthers: true,
        };
      }
      case 'game-over':
        return {};
    }
  }

  private pushHighlights(): void {
    this.pushStrokeSources();
    const h = this.buildHighlights();
    const preview = this.boardPreview() ? this.previewTotals() : null;
    const key = JSON.stringify([h, preview]);
    if (key === this.lastHighlightsKey) return;
    this.lastHighlightsKey = key;
    this.board.setHighlights(h);
    if (this.boardPreview()) (this.board as PreviewBoard).setCountPreview!(preview);
  }

  /** The board can draw the totals a count would leave on both pieces (docs/ROUND2.md §B). */
  private boardPreview(): boolean {
    return typeof (this.board as PreviewBoard).setCountPreview === 'function';
  }

  /** Occupy / fortify: the two totals the chosen count leaves, while choosing. */
  private previewTotals(): Partial<Record<TerritoryId, number>> | null {
    const d = this.disp;
    const s = this.state;
    if (!d || !s || !this.interactive() || d.currentPlayer !== s.currentPlayer) return null;
    const ph = d.phase;
    const sel = this.viewSel();
    if (ph.kind === 'occupy') {
      const v = Math.min(ph.max, Math.max(ph.min, sel.occupyCount ?? ph.max));
      return { [ph.from]: d.territories[ph.from].armies - v, [ph.to]: v };
    }
    if (ph.kind === 'fortify' && sel.selected && sel.target && d.territories[sel.selected].owner === d.currentPlayer) {
      const max = Math.max(1, d.territories[sel.selected].armies - 1);
      const v = Math.min(max, Math.max(1, sel.fortifyCount ?? max));
      return { [sel.selected]: d.territories[sel.selected].armies - v, [sel.target]: d.territories[sel.target].armies + v };
    }
    return null;
  }

  private buildVictory(s: GameState, winner: PlayerId, called: string | null): VictoryVM {
    const meta = this.meta;
    const order = this.standingsOrder(s).filter((p) => p !== winner);
    const ranked = [winner, ...order];
    const reason = s.phase.kind === 'game-over' ? s.phase.reason : null;
    // 'Round 14 · 31 territories' (docs/INK.md B5): real numbers, no percentages.
    const held = territoryCount(s, winner);
    const terr = `${held} ${held === 1 ? 'territory' : 'territories'}`;
    const subline = called
      ? `${called}${SEP}${terr}`
      : reason === 'turnLimit'
        ? `Round ${s.round} of ${s.config.turnLimit}${SEP}${terr}`
        : `Round ${Math.max(1, s.round)}${SEP}${terr}`;
    const awards = meta ? buildAwards(meta.awards, s) : [];
    const timeline = [...s.timeline];
    if (called) {
      timeline.push({
        round: s.round,
        territories: s.players.map((p) => territoryCount(s, p.id)),
        armies: s.players.map((p) => totalArmies(s, p.id)),
      });
    }
    return {
      seed: this.gameSeed(s),
      winner: seatRef(s, winner),
      title: `${pName(s, winner)} holds the world`,
      subline,
      awards: awards.map((a) => ({ id: a.id, title: a.title, text: a.text, seat: seatRef(s, a.player) })),
      seats: s.players.map((p) => seatRef(s, p.id)),
      timeline,
      standings: ranked.map((p, i) => ({
        seat: seatRef(s, p),
        place: i + 1,
        territories: territoryCount(s, p),
        stats: s.players[p].stats,
      })),
    };
  }

  // =========================================================================
  // Metrics & hooks
  // =========================================================================

  private openTurnMetric(player: PlayerId): void {
    this.curTurn = {
      player,
      kind: this.isAiDriven(player) ? 'ai' : 'human',
      ms: 0,
      clicks: 0,
      rejected: 0,
      forcedWaitMs: 0,
      start: this.now(),
    };
  }

  private closeTurnMetric(): void {
    const c = this.curTurn;
    if (!c) return;
    const { start, ...rest } = c;
    this.metricTurns.push({ ...rest, ms: Math.round(this.now() - start), forcedWaitMs: Math.round(rest.forcedWaitMs) });
    this.curTurn = null;
  }

  private countClick(): void {
    if (this.curTurn && this.screen === 'game') this.curTurn.clicks++;
  }

  /** The board says whether the view is off home, if it can (else the canvas drag / wheel heuristic). */
  private boardDisplaced(): boolean | null {
    try {
      return this.board.isViewDisplaced ? this.board.isViewDisplaced() : null;
    } catch {
      return null;
    }
  }

  private sampleCamera(): void {
    const tick = () => {
      if (this.screen === 'game') {
        const moved = this.boardDisplaced();
        if (moved !== null && moved !== this.viewMoved) {
          this.viewMoved = moved;
          this.invalidate();
        }
      }
      if (this.screen === 'game' && this.interactive()) {
        let moving = false;
        try {
          moving = !!this.board.getStats().cameraMoving;
        } catch {
          moving = false;
        }
        const t = this.now();
        if (moving && !this.lastCameraMoving && t > this.humanInputSince && t > this.pointerActiveUntil) {
          this.cameraMovesDuringHumanInput++;
        }
        this.lastCameraMoving = moving;
      } else this.lastCameraMoving = false;
      if (!this.disposed) this.timer(tick, 100);
    };
    this.timer(tick, 100);
  }

  private disposed = false;

  private installDom(): void {
    const onKey = (e: KeyboardEvent) => this.onKey(e);
    const onClick = (e: MouseEvent) => {
      if (e.detail > 0 && e.button === 0) this.countClick();
    };
    const onCtx = () => this.countClick();
    const onPointer = () => {
      this.pointerActiveUntil = this.now() + 1000;
    };
    // Ocean clicks: the board reports territory clicks synchronously from its canvas pointerup, so a
    // short press on the canvas that produced no territory click by the time it bubbles here missed land.
    let press: { x: number; y: number; t: number; clicks: number } | null = null;
    // A drag on the canvas (orbit / pan) or a wheel over it (zoom) moves the view off home: the
    // `Reset view` pill shows, unless the board reports displacement itself.
    let drag: { x: number; y: number } | null = null;
    const markMoved = () => {
      if (this.screen !== 'game' || this.viewMoved || this.boardDisplaced() !== null) return;
      this.viewMoved = true;
      this.invalidate();
    };
    const onBoardDown = (e: PointerEvent) => {
      const onBoard = e.target instanceof HTMLCanvasElement && !!e.target.closest('#board');
      press = onBoard && e.button === 0 ? { x: e.clientX, y: e.clientY, t: e.timeStamp, clicks: this.boardClicks } : null;
      drag = onBoard ? { x: e.clientX, y: e.clientY } : null;
    };
    const onBoardMove = (e: PointerEvent) => {
      if (drag && e.buttons && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 8) {
        drag = null;
        markMoved();
      }
    };
    const onBoardWheel = (e: WheelEvent) => {
      if (e.target instanceof HTMLCanvasElement && e.target.closest('#board')) markMoved();
    };
    const onBoardUp = (e: PointerEvent) => {
      const p = press;
      press = null;
      drag = null;
      if (!p || e.button !== 0 || this.boardClicks !== p.clicks || this.overTile) return;
      if (e.timeStamp - p.t > 350 || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 6) return;
      this.oceanClick();
    };
    // The long-press name card lives while the finger is down; any release hides it.
    const onRelease = () => this.hideNameCard();
    for (const ev of ['pointerup', 'pointercancel', 'touchend', 'touchcancel'] as const) window.addEventListener(ev, onRelease, true);
    this.disposers.push(() => {
      for (const ev of ['pointerup', 'pointercancel', 'touchend', 'touchcancel'] as const) window.removeEventListener(ev, onRelease, true);
    });
    window.addEventListener('pointerdown', onBoardDown);
    window.addEventListener('pointermove', onBoardMove);
    window.addEventListener('wheel', onBoardWheel, { passive: true });
    window.addEventListener('pointerup', onBoardUp);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('contextmenu', onCtx, true);
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('pointerup', onPointer, true);
    window.addEventListener('wheel', onPointer, { capture: true, passive: true });
    window.addEventListener('resize', this.onResizeUiScale);
    this.watchForUpdates();
    const mq = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    const onMq = () => {
      this.applySettingsToBoard();
      this.invalidate();
    };
    mq?.addEventListener?.('change', onMq);
    this.disposers.push(() => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('contextmenu', onCtx, true);
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('pointerup', onPointer, true);
      window.removeEventListener('pointerdown', onBoardDown);
      window.removeEventListener('pointermove', onBoardMove);
      window.removeEventListener('wheel', onBoardWheel);
      window.removeEventListener('pointerup', onBoardUp);
      window.removeEventListener('wheel', onPointer, true);
      window.removeEventListener('resize', this.onResizeUiScale);
      mq?.removeEventListener?.('change', onMq);
    });
  }

  /**
   * A new build (v3): the service worker (public/sw.js) skips waiting and claims the page, so a new version
   * takes over behind a running page. When it does (controllerchange): off the game (title, New game,
   * victory) reload at once; in a game the event line says 'Update ready · reload' and a tap saves and
   * reloads. On boot, ask the registration to look for a new build now rather than on the browser's
   * schedule. The very first install also fires controllerchange (nothing was stale): that one is ignored.
   */
  private watchForUpdates(): void {
    const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
    if (!sw) return;
    let had = !!sw.controller;
    const onChange = () => {
      if (!had) {
        had = true;
        return;
      }
      this.onUpdateReady();
    };
    sw.addEventListener('controllerchange', onChange);
    this.disposers.push(() => sw.removeEventListener('controllerchange', onChange));
    sw.getRegistration?.()
      .then((r) => r?.update())
      .catch(() => undefined);
  }

  private onUpdateReady(): void {
    const inGame = this.screen === 'game' && !!this.state && this.state.phase.kind !== 'game-over';
    if (!inGame) {
      this.reloadFn?.();
      return;
    }
    this.updateReady = true;
    this.invalidate();
  }

  isIdle(): boolean {
    return (
      !this.pumping &&
      this.queue.length === 0 &&
      this.inflight === 0 &&
      !this.aiBusy &&
      !this.aiScheduled &&
      this.pendingInputs.length === 0 &&
      !this.aiShouldAct()
    );
  }

  metrics(): Metrics {
    let maxDeg = 0;
    try {
      const st = this.board.getStats() as { maxCameraDegPerSec?: number; maxAutoDegPerSec?: number };
      maxDeg = st.maxCameraDegPerSec ?? st.maxAutoDegPerSec ?? 0;
    } catch {
      maxDeg = 0;
    }
    return {
      turns: [...this.metricTurns],
      rolls: [...this.metricRolls],
      maxCameraDegPerSec: maxDeg,
      cameraMovesDuringHumanInput: this.cameraMovesDuringHumanInput,
      inputDropped: this.inputDropped,
    };
  }

  resetMetrics(): void {
    this.metricTurns = [];
    this.metricRolls = [];
    this.inputDropped = 0;
    this.cameraMovesDuringHumanInput = 0;
    if (this.curTurn) {
      this.curTurn.start = this.now();
      this.curTurn.clicks = 0;
      this.curTurn.rejected = 0;
      this.curTurn.forcedWaitMs = 0;
    }
  }

  /** Test hook (v3): the ledger, oldest first. */
  ledgerHook(): { id: number; round: number; kind: string; text: string }[] {
    return (this.meta?.log ?? []).map((l) => ({ id: l.id, round: l.round, kind: l.kind, text: l.text }));
  }

  uiSnapshot(): UiSnapshot {
    const vm = this.getViewModel();
    const g = vm.game;
    const strip = g?.strip;
    const b = g?.battle;
    const tr = strip?.track;
    const step = tr?.segments.find((x) => x.state === 'current')?.label ?? '';
    // The one gold thing's label (GameVM.gold), as the HUD draws it; the hand-off ring has no label.
    const gd = g?.gold ?? null;
    const brass =
      !gd || gd.kind === 'handoff'
        ? []
        : gd.kind === 'cardsTrade'
          ? g?.cards?.trade
            ? [g.cards.trade.label]
            : []
          : gd.kind === 'button'
            ? (strip?.buttons.filter((x) => x.id === gd.id).map((x) => x.label) ?? [])
            : (tr?.segments.filter((x) => x.id === gd.seg).map((x) => x.label) ?? []);
    return {
      screen: vm.screen,
      step,
      track: tr ? tr.segments.map((x) => `${x.state}:${x.id}`) : [],
      recommended: tr?.recommended ?? null,
      trackSeat: tr?.seat.name ?? '',
      trackLive: !!tr?.live,
      trackDisabled: !!tr?.disabled,
      brass,
      line: strip?.line ?? '',
      lineKind: strip?.lineKind ?? '',
      primary: strip?.buttons.find((x) => x.primary)?.label ?? null,
      buttons: (strip?.buttons ?? []).map((x) => x.label),
      count: strip?.count ? { ...strip.count } : null,
      banners: g?.banner ? [g.banner.sub ? `${g.banner.title} · ${g.banner.sub}` : g.banner.title] : [],
      recap: g?.banner?.recap ?? null,
      battle: b ? { header: b.captured ?? `${upper(b.attacker.territory)} ${b.attacker.armies} vs ${upper(b.defender.territory)} ${b.defender.armies}` } : null,
      seats: (g?.seats ?? []).map((c) => `${c.seat.name} ${c.territories}`),
      cardsOpen: !!g?.cards?.open,
      viewMoved: !!g?.viewMoved,
      gold: !g?.gold ? null : g.gold.kind === 'button' ? `button:${g.gold.id}` : g.gold.kind === 'segment' ? `segment:${g.gold.seg}` : g.gold.kind,
      bannerLine: g?.banner?.line ?? null,
    };
  }

  newGameHook(config?: Partial<GameConfig> & { players?: PlayerConfig[] }): void {
    // The hook keeps the classic AIs unless its caller names personalities (test stability; the New game
    // screen's draft carries them). A game started here plays on this page's board unless it says otherwise.
    const base = draftToConfig(this.draft, this.randomSeed());
    base.players = base.players.map(({ personality: _p, ...rest }) => (void _p, rest));
    delete base.diplomacy;
    base.mapId = this.bootMap;
    const players = config?.players ?? base.players;
    const n = players.length;
    const rules = lengthRules(this.draft.length, n);
    const cfg: GameConfig = {
      ...base,
      dominationPercent: rules.dominationPercent,
      turnLimit: rules.turnLimit,
      ...config,
      players,
    };
    if (config?.setupBatch === undefined && cfg.initialPlacement === 'manual' && this.draft.house.setupBatch === 'auto') {
      cfg.setupBatch = Math.max(1, Math.ceil(((cfg.startingArmies ?? ({ 2: 40, 3: 35, 4: 30 } as Record<number, number>)[n]) - Math.floor(42 / n)) / 2));
    }
    this.overlay = null;
    this.startGame(cfg);
  }

  dispatchHook(action: Action): { ok: boolean; error?: string } {
    const r = this.act(action);
    if (r.ok) {
      this.validateSel();
      const s = this.state!;
      if (s.phase.kind === 'occupy' && this.sel.occupyCount === null) {
        this.sel.occupyCount = occupyDefault(s, s.phase.from, s.phase.to, s.phase.min, s.phase.max);
      }
      this.invalidate();
      return { ok: true };
    }
    return { ok: false, error: r.error };
  }

  setSpeedHook(animation: number, ai?: AiSpeed): void {
    const a = animation <= 0 ? 0 : animation >= 2 ? 2 : 1;
    this.setSettings({ animationSpeed: a, ...(ai ? { aiSpeed: ai } : {}) });
  }

  autoplay(on: boolean): void {
    this.autoplayOn = on;
    this.haptics.enabled = !on;
    this.applyBoardSpeed();
    this.invalidate();
    this.scheduleAi();
  }

  getState(): GameState | null {
    return this.state;
  }

  setViewportInsets(insets: ViewportInsets): void {
    this.insets = insets;
    this.board.setViewportInsets(insets);
  }

  /** An empty-ocean (or table) click on your turn backs out one level, like Esc. */
  private oceanClick(): void {
    if (this.screen !== 'game' || this.overlay || this.confirm || !this.interactive() || this.busyBlocking()) return;
    if (this.backOut()) {
      this.clearRejection();
      this.saveMeta();
      this.invalidate();
    }
  }

  screenPos(t: TerritoryId): { x: number; y: number } | null {
    return this.board.getScreenPosition(t);
  }

  dispose(): void {
    this.disposed = true;
    for (const d of this.disposers) d();
    this.disposers = [];
    this.wakeAll();
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createController(opts: { board: BoardView; audio: AudioEngine } & Partial<ControllerOptions>): GameController {
  const c = new Controller(opts as ControllerOptions);
  const hooks: RiskHooks = {
    getState: () => c.getState(),
    newGame: (config) => c.newGameHook(config),
    dispatch: (action) => c.dispatchHook(action),
    isIdle: () => c.isIdle(),
    waitIdle: (timeoutMs = 15000) =>
      new Promise<void>((resolve, reject) => {
        const start = Date.now();
        const check = () => {
          if (c.isIdle()) resolve();
          else if (Date.now() - start > timeoutMs) reject(new Error('waitIdle timed out'));
          else setTimeout(check, 20);
        };
        check();
      }),
    setSpeed: (a, ai) => c.setSpeedHook(a, ai),
    autoplay: (on) => c.autoplay(on),
    screenPos: (t) => c.screenPos(t),
    stats: () => c.board.getStats(),
    ui: () => c.uiSnapshot(),
    ledger: () => c.ledgerHook(),
    map: () => c.bootMap,
    explain: (t) => {
      const e = c.explain(t);
      return { ok: e.ok, ...(e.code ? { code: e.code } : {}), text: e.text };
    },
    metrics: () => c.metrics(),
    resetMetrics: () => c.resetMetrics(),
  };
  return {
    getViewModel: () => c.getViewModel(),
    subscribe: (fn) => c.subscribe(fn),
    intent: (i) => c.intent(i),
    setViewportInsets: (insets) => c.setViewportInsets(insets),
    audio: c.audio,
    hooks,
    dispose: () => c.dispose(),
    handleKey: (key, repeat) => c.handleKey(key, repeat),
  };
}

