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
  UNCLAIMED,
  mapDefOf,
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
  missionText,
  isPersonality,
  truceSentence,
  trucePartners,
  standingOf,
  standingReason,
  canAskPeace,
  type Standing,
  type Action,
  type AiPersonality,
  type ActionResult,
  type ContinentId,
  type GameConfig,
  type GameEvent,
  type GameState,
  type AiDifficulty,
  type PlayerConfig,
  type PlayerKind,
  type PlayerId,
  type TerritoryId,
} from '../engine';
import * as engineNs from '../engine';
import { DEFAULT_MAP_ID, activeMapId, isKnownMap, listMaps } from '../map/registry';
import type { AudioEngine, PlayOptions, SfxName, V4Cue, V5Cue } from '../audio/types';
import type { BoardHighlights, BoardView, PlayEventOptions, TerritoryPointerInfo, ViewportInsets } from '../render/BoardView';
import { attackLine, buildStrip, buildTrack, emptySel, placeLeft, placeValue, selectionTargets, stagedTotal, tookLine, trackLockReason, type Placement, type Sel } from './strip';
import {
  buildReplay,
  emptyStory,
  grudgeTicks,
  holdingBreakdown,
  noteConquest,
  noteOut,
  noteRoundStart,
  rematchFirst,
  replayBoard,
  restoreStory,
  stoneHistory,
  type StoryLedger,
} from './story';
import { Voices, type VoiceEntry, type VoiceKind, type VoiceVars } from './voice';
import { SEP, armies, attackBegins, attackTakes, attackThrownBack, cName, click, goesFirst, pName, pct, poss, seatRef, setCopyMap, setTouchCopy, tName, upper } from './copy';
import { eventTier } from './timingModel';
import { createHaptics, type Haptics } from './haptics';
import { applyEventToDisplay, isBlocking } from './display';
import { explainTerritory, type ClickPlan, type ExplainUi, type Explanation } from './explain';
import { autoChain, bestSet, noSetStatus } from './helpers';
import {
  addSeat,
  buildNewGameVM,
  autoSetupBatch,
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
import {
  buildAwards,
  buildRecap,
  buildReceipt,
  emptyAwards,
  emptyReceipts,
  noteTurnStart,
  receiptSince,
  recordAward,
  recordReceipt,
  recordRecap,
  type AwardLedger,
  type RecapLedger,
  type ReceiptLedger,
} from './recap';
import {
  DEFAULT_SETTINGS,
  SETTINGS_MORE,
  SETTINGS_PRIMARY,
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
  ReceiptVM,
  ReplayVM,
  SaveSketchVM,
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
  /** v5.1: always null (the human truce protocol went); kept so older flows still read. */
  offer: { text: string; buttons: string[] } | null;
  /** Additive (v4 A3): the receipt's title and lines, or null. */
  receipt: { title: string; lines: string[]; summary: string | null } | null;
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
  /** Additive (v4): the receipt showing now ('While you were away'), or null. */
  receipt(): ReceiptVM | null;
  /** Additive (v4): dismiss the receipt (what any tap on it does). */
  dismissReceipt(): void;
  /** Additive (v4 A4): the loser's rings on the board now. */
  loserRings(): NonNullable<BoardHighlights['loserRings']>;
  /** Additive (v5 C): the end-of-game replay (kept after it is skipped), or null before a game ends. */
  replay(): ReplayVM | null;
  /** Additive (v5 E): the current human's holding dab (GameVM.holding), or null. */
  holding(): GameVM['holding'] | null;
  /** Additive (v5 D): every AI voice line said this game, oldest first. */
  voiceLines(): VoiceEntry[];
  /** Additive (v5.1 C): each seat's standing as the seat marks show it (toward the current / next human). */
  standing(): StandingHook[];
}

/** One seat's standing toward the reader (the `__risk.standing()` hook). */
export interface StandingHook {
  seat: PlayerId;
  name: string;
  kind: PlayerKind;
  /** null for humans and the neutral seat. */
  standing: Standing | null;
  reason: string | null;
  canAskPeace: boolean;
  understandingWith: PlayerId[];
  /** The personality label the seat mark shows (null until the seat has spoken). */
  personality: string | null;
  /** The reader these were computed for. */
  reader: PlayerId | null;
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
  /** Board speed for this entry (an AI turn's even pace, compressed on a long turn); default = the seat's speed. */
  speed?: number;
  /** v4 A1: the last roll of an AI engagement that did not take the territory (the line completes on it). */
  verdict?: 'held';
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

/**
 * One AI turn's pacing (v4 A1, the readable reel). Every event gets its tier's beat at one even pace; a turn
 * with more beats than the cap compresses every beat by the same factor (Pillar 5), never by snapping the tail.
 */
interface AiTurnCtx {
  key: string;
  player: PlayerId;
  startedAt: number;
  first: boolean;
  /** Beats this turn will play (engagements + a fortify), from a dry run of the AI on a copy of the state. */
  beats: number;
  /** 1 = full beats; < 1 = every beat shortened by this factor (≥ AI_MIN_SCALE). */
  scale: number;
  /** v5 D5: the dry run found an attack this turn. */
  attacks?: boolean;
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
  /** v4 A3: what the AI seats did since each human's last turn (the receipt). */
  receipts?: ReceiptLedger;
  /** v4 A4: per human seat, the territories it lost since its last turn (the loser's rings). */
  rings?: Record<number, TerritoryId[]>;
  /** v4 A5: someone has made the game's first move (the 'Sage goes first' beat is spent). */
  firstMoved?: boolean;
  /**
   * v5 C: the game's memory (src/game/story.ts): a board per round start, every conquest, every knockout. The
   * replay, the grudge ticks and a stone's history all read it.
   */
  story?: StoryLedger;
  /** v5.1 D: AI seats whose personality is known (it has said its first line). */
  revealed?: PlayerId[];
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

// v4 A1, the readable reel: steady beats, no wall-clock caps. At Watch every beat plays at 1×, at Fast at
// 2× (spacing, never pitch), at Skip the turn applies at once and the receipt carries it.
/** The breath before an AI turn's first move. */
const THINK_TURN_START = 300;
/** The breath before each AI engagement (× the turn's compression): the room reads one line, then the next. */
const AI_GAP_MS = 160;
/** An AI's placements land within this (tier-0 swells, staggered). */
const AI_PLACE_MS = 600;
/** Beats in an AI turn before every beat is shortened proportionally (Pillar 5: a round stays in budget). */
const AI_BEATS_CAP = 5;
/** Round-1 AI turns before any human has moved: nothing is at stake yet (Start → first click ≤ 20 s). */
const AI_BEATS_CAP_OPENING = 3;
/** The most a long turn is compressed (4×): past this a rampage takes its beats. */
const AI_MIN_SCALE = 0.25;
/** 'Sage goes first': the line holds before the opening AI move (A5). */
const FIRST_BEAT_MS = 1200;
/** No input and no events this long on a human's turn: the score thins (B3, §7.14). */
const IDLE_MS = 60_000;
/** 'You took Brazil · 3 armies move in' holds this long after the click, then the next instruction returns. */
const AUTO_MOVED_MS = 2500;
const PLAY_SAFETY_MS = 15_000;
/** A refused click's reason holds the line this long. */
const REJECT_MS = 2000;
/** A decided fight's tray header ('Siberia captured') stays this long, then fades (docs/ROUND2.md §E). */
const LINGER_MS = 1000;
const LOG_CAP = 300;
/** v5 D4: an AI's voice line holds the one line this long against its own placement narration. */
const VOICE_HOLD_MS = 1200;
/** v5 F: a clickable's line (a continent, the ensō, a lane, a stone) holds this long. */
const FLASH_MS = 1400;
/** v5 F4: a second tap on the ensō this soon opens the Ledger. */
const ENSO_DOUBLE_MS = 2000;
/** v5 A9: how far an AI's readable fight leans the camera (a human's leans the board's default). */
const AI_LEAN = 0.08;

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
    story: emptyStory(),
  };
}

/** A saved meta from this or an older build: keep the fields that still exist and are well-formed. */
function restoreMeta(id: string, saved: Partial<GameMeta> | undefined, config?: { mapId?: string } | null): GameMeta {
  const m = freshMeta(id);
  if (!saved || saved.id !== id) return m;
  if (saved.recap && typeof saved.recap === 'object') {
    for (const [k, v] of Object.entries(saved.recap)) if (v && typeof v === 'object' && v.lost && typeof v.lost === 'object') m.recap[Number(k)] = { lost: v.lost };
  }
  if (saved.awards && typeof saved.awards === 'object') m.awards = { ...m.awards, ...saved.awards };
  if (Array.isArray(saved.log)) m.log = saved.log.map((l) => ({ id: l.id, round: l.round, seat: l.seat, kind: l.kind, text: l.text, ...(l.detail ? { detail: l.detail } : {}) }));
  if (typeof saved.logId === 'number') m.logId = saved.logId;
  if (Array.isArray(saved.nearGoal)) m.nearGoal = saved.nearGoal;
  m.finalRoundShown = !!saved.finalRoundShown;
  m.lastTurnKind = saved.lastTurnKind ?? null;
  m.sel = restoreSel(saved.sel, config);
  if (saved.out && typeof saved.out === 'object') {
    m.out = {};
    for (const [k, v] of Object.entries(saved.out)) if (v && typeof v.by === 'number' && typeof v.round === 'number') m.out[Number(k)] = { by: v.by, round: v.round };
  }
  const r = saved.receipts;
  if (r && Array.isArray(r.items) && Array.isArray(r.aiTurns) && r.last && typeof r.last === 'object') {
    m.receipts = { items: r.items, aiTurns: r.aiTurns, last: { ...r.last }, pending: r.pending ?? null, done: r.done ?? null };
  }
  if (saved.rings && typeof saved.rings === 'object') {
    m.rings = {};
    for (const [k, v] of Object.entries(saved.rings)) if (Array.isArray(v)) m.rings[Number(k)] = v.filter((t) => !!mapDefOf(config).territories[t]);
  }
  m.firstMoved = !!saved.firstMoved;
  m.story = restoreStory(saved.story, config);
  if (Array.isArray(saved.revealed)) m.revealed = saved.revealed.filter((x) => typeof x === 'number');
  return m;
}

function restoreSel(x: unknown, config?: { mapId?: string } | null): Sel {
  const sel = emptySel();
  if (!x || typeof x !== 'object') return sel;
  const o = x as Partial<Sel>;
  const tid = (t: unknown): TerritoryId | null => (typeof t === 'string' && !!mapDefOf(config).territories[t] ? (t as TerritoryId) : null);
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

/** 'three rounds' (the peace answer's words; numerals past ten). */
function roundsWord(n: number): string {
  const w = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][n] ?? String(n);
  return `${w} ${n === 1 ? 'round' : 'rounds'}`;
}

/** v5 E6: the pour follows the armies: 85 ms a stone, 0.25–0.6 s. */
function pourSeconds(armies: number): number {
  return Math.min(0.6, Math.max(0.25, 0.085 * armies));
}

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
const TRUCE_EVENTS: ReadonlySet<GameEvent['type']> = new Set([
  'truceProposed',
  'truceAccepted',
  'truceDeclined',
  'truceBroken',
  'truceExpired',
  'peaceAnswered',
  'peaceBroken',
  'standingChanged',
]);

type FlashKind = 'tap' | 'stone' | 'mission' | 'standing' | 'peace';

/**
 * v5.1 C: the engine's 'why you cannot ask now' line ('You asked Sage in round 5 · ask again in round 8'), read
 * through the namespace so this builds against the stub too (it lacks `peaceAskBlock`).
 */
function peaceAskBlockOf(s: GameState, human: PlayerId, ai: PlayerId): string | null {
  const fn = (engineNs as unknown as { peaceAskBlock?: (s: GameState, h: PlayerId, a: PlayerId) => string | null }).peaceAskBlock;
  try {
    return fn ? fn(s, human, ai) : null;
  } catch {
    return null;
  }
}

/** v5.1 E1: Place → Attack advances by itself this long after the last army is placed. */
const AUTO_ATTACK_MS = 250;
/** v5.1 C: a standing reason holds the line this long on a long-press / tap (hover holds until it leaves). */
const STANDING_MS = 2400;
/** v5.1 C: a peace answer / a broken peace holds the line this long. */
const PEACE_MS = 2600;

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
      // v6 maps: the Where row scales the summary ("first to N") by the map's size
      territories: m.territories,
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
  /** v4: the tray's box beside the fight (desktop), for the fight header. */
  private trayRect: { x: number; y: number; w: number; h: number } | null = null;
  private disposers: (() => void)[] = [];

  // App
  private screen: Screen = 'title';
  private overlay: Overlay = null;
  private overlayReturn: Overlay = null;
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private draft: NewGameDraft = defaultDraft();
  /** v5.1 D: the New game screen's "More" fold is open. */
  private newGameMore = false;
  /** v5.1 E3: the Settings sheet's "More" fold is open. */
  private settingsMore = false;
  /** v5.1 E1: the pending Place → Attack advance (a timer handle), or null. */
  private autoAttackTimer: unknown = null;
  /** v3: a new build took over (service worker controllerchange) while a game is on. */
  private updateReady = false;
  private reloadFn: (() => void) | null;
  /** The map this page's board was booted on. */
  readonly bootMap: string;
  private saveSummary: ViewModel['save'] = null;
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
  /** The begun line of the AI engagement playing now ('Sage attacks Ural…'), completed by its verdict. */
  private narrBegun: string | null = null;

  // v4: the receipt, the loser's rings, idle
  /** The receipt showing now, for `seat`'s turn `turn` (input to the board waits on it; any tap dismisses). */
  private receipt: (ReceiptVM & { seat: PlayerId; turn: number }) | null = null;
  private receiptKey = 0;
  /** The territories of the receipt line writing now (BoardHighlights.pulse). */
  private pulse: TerritoryId[] = [];
  /** The turn banner held back while the receipt shows; it writes once the receipt is dismissed. */
  private bannerAfterReceipt: (() => void) | null = null;
  /** The game was just resumed: the next receipt reads 'Since your last turn'. */
  private resumedTitle = false;
  private idleOn = false;
  private lastActive = 0;
  // v5: the replay, voices, the holding dab, clickables, the camera lean
  /** The end-of-game replay showing now (GameVM.replay), and the last one built (the hook keeps it). */
  private replay: ReplayVM | null = null;
  /** The e2e build (VITE_E2E) never holds the recap for the replay; the hook still builds it. */
  private noReplay = (() => {
    try {
      return !!(import.meta as unknown as { env?: { VITE_E2E?: string } }).env?.VITE_E2E;
    } catch {
      return false;
    }
  })();
  private lastReplay: ReplayVM | null = null;
  private replayKey = 0;
  private replayTimer: unknown = null;
  private voices = new Voices();
  /** The voice line on the strip now, and how long it holds against placement narration. */
  private voiceNow: { text: string; seat: PlayerId } | null = null;
  private voiceHoldUntil = 0;
  /** The current human turn's armies as they arrived (turnStarted's breakdown) plus card trades since. */
  private turnArmies: { turn: number; player: PlayerId; b: import('../engine').ReinforcementBreakdown; cards: number } | null = null;
  /**
   * A clickable's line on the strip for a moment (a continent, the ensō, a lane, a stone); v5.1 a seat's
   * standing reason, a peace answer. `seat` sets it in that AI's light tint (StripVM.voice).
   */
  private flash: { text: string; until: number; kind: FlashKind; seat?: PlayerId } | null = null;
  /** The enemy tile under the pointer while a source is picked (the hover odds line, desktop). */
  private hoverTile: TerritoryId | null = null;
  /** The seat ring under the pointer (its territories lift, the rest rest). */
  private hoverSeatId: PlayerId | null = null;
  /** A tapped continent's territories, pulsed once. */
  private tapPulse: TerritoryId[] = [];
  private ensoAt = -Infinity;
  /** What the camera leans toward now ('' = home), so the board hears each change once. */
  private leanKey = '';
  /** The engine moved the armies in itself after the driver's conquest: the line says so (A5). */
  private autoMoved: { to: TerritoryId; n: number; chain: TerritoryId | null; turn: number; until: number } | null = null;

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
    setCopyMap({ mapId: this.bootMap });
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
    this.board.onTrayChange?.((visible, rect) => {
      this.trayUp = visible;
      this.trayRect = visible ? (rect ?? null) : null;
      if (!visible) this.clearLinger();
      this.invalidate();
    });
    // Only to tell an ocean click from a click on land (the board names hovered tiles itself).
    this.board.onTerritoryHover((info) => {
      this.overTile = info?.territory ?? null;
      // v5 E8: the hover odds line follows the pointer (desktop); only a change the line cares about redraws.
      const t = info?.territory ?? null;
      if (t === this.hoverTile) return;
      const was = this.hoverTile;
      this.hoverTile = t;
      const s = this.state;
      if (!this.touch && s && s.phase.kind === 'attack' && this.sel.selected && !this.sel.target) {
        const ts = attackTargets(s, this.sel.selected);
        if ((t && ts.includes(t)) || (was && ts.includes(was))) this.invalidate();
      }
    });
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
    if (!s || this.screen !== 'game') return false;
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
    setCopyMap(state.config);
    this.meta = freshMeta(state.id);
    this.seedScore(state);
    // The deal plays from an empty board.
    const blank = cloneState(state);
    for (const t of mapDefOf(state.config).territoryIds) blank.territories[t] = { owner: UNCLAIMED, armies: 0 };
    blank.round = 0;
    blank.turn = 0;
    blank.currentPlayer = state.firstPlayer;
    blank.phase = { kind: 'setup-claim' };
    this.disp = blank;
    // Whatever the last game was still animating (its victory wave, a march) ends here, before the deal.
    this.board.skipAnimations();
    this.board.setAttractMode(false);
    this.board.syncState(blank);
    this.setEvening(1);
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
    this.cancelAutoAttack();
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
    this.narrBegun = null;
    this.receipt = null;
    this.pulse = [];
    this.bannerAfterReceipt = null;
    this.resumedTitle = false;
    this.autoMoved = null;
    this.endReplay(false);
    this.lastReplay = null;
    this.voices = new Voices();
    this.voiceNow = null;
    this.voiceHoldUntil = 0;
    this.turnArmies = null;
    this.flash = null;
    this.hoverTile = null;
    this.hoverSeatId = null;
    this.tapPulse = [];
    this.ensoAt = -Infinity;
    this.syncLean(null);
    this.lastActive = this.now();
    this.setIdle(false);
  }

  private loadSave(): boolean {
    const f = readJson<SaveFile>(this.kv, SAVE_KEY);
    if (!f || !isPlausibleState(f.state) || f.state.phase.kind === 'game-over') return false;
    const s = f.state;
    this.resetGameLocals();
    this.state = s;
    setCopyMap(s.config);
    this.disp = cloneState(s);
    this.seedScore(s);
    const ui = readJson<UiFile>(this.kv, UI_KEY);
    this.meta = restoreMeta(s.id, ui?.game, s.config);
    this.sel = this.meta.sel;
    this.validateSel();
    if (s.phase.kind === 'occupy' && this.sel.occupyCount === null) {
      this.sel.occupyCount = s.phase.max;
    }
    this.board.skipAnimations();
    this.board.setAttractMode(false);
    this.board.syncState(s);
    this.setEvening(Math.max(1, s.round));
    this.screen = 'game';
    this.overlay = null;
    this.victory = null;
    this.applyBoardSpeed();
    this.humanHasPlayed = s.round > 1 || !!this.meta.lastTurnKind;
    if (s.turn > 0) this.meta.firstMoved = true;
    // v4 A3: a receipt still unread when the game was left shows again ('Since your last turn'); otherwise
    // the next one this session reads that way.
    this.resumedTitle = true;
    const pend = this.meta.receipts?.pending;
    if (s.round > 0 && !this.isAiDriven(s.currentPlayer) && pend && pend.seat === s.currentPlayer && pend.turn === s.turn) {
      this.openReceipt(s.currentPlayer, s.turn, pend.since);
    }
    // A fresh turn banner so the room knows whose turn it is (the army count only when it's still true).
    if (s.round > 0 && !this.isAiDriven(s.currentPlayer)) {
      const ph = s.phase;
      const fresh = ph.kind === 'reinforce' && !ph.midTurn && Object.keys(ph.placed).length === 0;
      const show = () => this.showTurnBanner(s.currentPlayer, fresh ? reinforcementsFor(s, s.currentPlayer).total : null, null, s);
      if (this.receipt) this.bannerAfterReceipt = show;
      else show();
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
    // v4 (HUD): the Continue card's ink thumbnail (§7.13): who holds what, in seat colours.
    const owners: NonNullable<SaveSketchVM['owners']> = {};
    for (const [t, ts] of Object.entries(s.territories)) {
      const p = ts && ts.owner >= 0 ? s.players[ts.owner] : null;
      if (p) owners[t as TerritoryId] = p.color;
    }
    this.saveSummary = { summary: `${when}${SEP}${who}`, sketch: { mapId: s.config.mapId, owners } };
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
    if (this.meta) this.meta.firstMoved = true;
    this.autoMoved = null;
    this.enqueue(
      r.events.map((ev, i) => ({ ev, after: r.state, end: i === r.events.length - 1 })),
      { ai: false, style: 'full' },
    );
    return r;
  }

  private enqueue(
    list: { ev: GameEvent; after: GameState; end: boolean; verdict?: 'held' }[],
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
        // v5 A: a human's full roll lands its dice one at a time.
        if (!opts.ai && (opts.style ?? 'full') === 'full') e.opts.stagger = 70;
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
      // v4 E5: every playEvent carries its stakes tier (motion, sound and line land in the same band).
      e.opts = { ...(e.opts ?? {}), tier: eventTier(x.ev) };
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
        // v5.1 A: no hand-off cover: the turn passes with the one line (the turn banner) and the seat ring.
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
        if (!skip) this.setBoardSpeed(e.speed ?? this.seatSpeed());
        if (!skip) this.lastActive = this.now();
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
          if (e.ev.type === 'territoryConquered' && this.lastBoardSpeed === 0 && !this.isSkipping(e)) await this.sleep(250);
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

  // =========================================================================
  // Event handlers (HUD reacts to each event as the board plays it)
  // =========================================================================

  private onEventStart(e: Entry, skip: boolean): void {
    const ev = e.ev;
    const d = this.disp!;
    // v4 A2 "distance, not silence": an AI-vs-AI event plays far across the room, never quieter.
    const aiFar = (players: PlayerId[]): PlayOptions => (players.some((p) => this.isHumanSeat(p)) ? {} : { distance: 0.6 });
    switch (ev.type) {
      case 'turnStarted': {
        this.closeEngagement();
        this.closeTurnMetric();
        const human = this.isHumanSeat(ev.player) && !this.autoplayOn;
        const aiTurn = this.isAiDriven(ev.player);
        if (human) this.humanHasPlayed = true;
        const prevKind = this.meta?.lastTurnKind ?? null;
        if (human && prevKind === 'human') this.guardUntil = this.now() + 250;
        // v4 A4: the seat whose turn just ended has seen its rings through that turn: they go.
        if (this.meta?.rings && d.turn > 0 && this.meta.rings[d.currentPlayer]) delete this.meta.rings[d.currentPlayer];
        if (this.meta) this.meta.lastTurnKind = aiTurn ? 'ai' : 'human';
        this.openTurnMetric(ev.player);
        this.sel = emptySel();
        this.frozenSel = null;
        // v5.1 A: cards are only shown on demand; the sheet closes as the turn passes (private with 2+ humans).
        if (this.cardsOpen) this.sheet(false);
        this.cardsOpen = false;
        this.cancelAutoAttack();
        this.autoMoved = null;
        this.narration = aiTurn ? `${pName(d, ev.player)} gets ${armies(ev.reinforcements.total)}` : null;
        this.narrBegun = null;
        this.narrPlaced = 0;
        this.aiHighlights = null;
        this.aiPreview = null;
        this.voiceNow = null;
        this.voiceHoldUntil = 0;
        this.hoverTile = null;
        // v5 C1: the board as this round starts (the replay's frames).
        if (this.meta && ev.round > d.round) noteRoundStart(this.story(), e.after, ev.round);
        // v5 D4: a seat's last line is spent as its turn begins; a grievance it carried is said now.
        const grievance = this.voices.turnBegins(ev.player);
        if (grievance && aiTurn) {
          const by = pName(d, grievance.by);
          this.say(ev.player, grievance.kind, { by }, ev.turn, d);
        }
        // v5 E6: the turn's armies arrive as a thing to spend (the holding dab), with a pour.
        this.turnArmies = human ? { turn: ev.turn, player: ev.player, b: ev.reinforcements, cards: 0 } : null;
        if (human && !skip) this.cue('pour', { delay: 0.6, duration: pourSeconds(ev.reinforcements.total) });
        // v5 B: the evening deepens with the rounds (score and paper from one place).
        if (ev.round !== d.round) this.setEvening(ev.round);
        let recap: string | null = null;
        if (this.meta && this.isHumanSeat(ev.player) && ev.round >= 2) {
          // The grudge line stays in the Ledger; v4 the receipt replaces it on screen.
          recap = buildRecap(this.meta.recap[ev.player], d);
          delete this.meta.recap[ev.player];
          if (recap) this.log('recap', ev.player, recap, ev.round);
        }
        // v4 A3: the receipt, when this human gets the cup back after AI turns (built before the ledger
        // marks this as the seat's last turn).
        if (human) this.openReceipt(ev.player, ev.turn, undefined, e.after);
        if (this.meta && !this.autoplayOn) noteTurnStart(this.receipts(), e.after, ev.player, ev.turn, aiTurn);
        // The turn banner is for the humans at the table; an AI turn is named by the step indicator. While
        // the receipt shows, the banner waits and writes once it is dismissed.
        if (!aiTurn) {
          // v5: the receipt is gone; the grudge sentence rides under the turn line again ('Ochre took 5 of yours')
          const show = () => this.showTurnBanner(ev.player, ev.reinforcements.total, recap, d, ev.round);
          if (this.receipt) this.bannerAfterReceipt = show;
          else show();
        }
        this.log('turn', ev.player, `${poss(pName(d, ev.player))} turn${SEP}${ev.reinforcements.total} to place`, ev.round);
        // v5.1 B: the cup went (no objects as UI); the sound of the turn passing stays: one wood set-down
        // ('cupSet') and the score's chord turning. A human's turn adds the turnStart (bright after AI turns).
        if (!this.autoplayOn) {
          try {
            this.audio.turnPassed?.(human);
          } catch {
            /* audio is best-effort */
          }
          this.cue('cupSet');
          // §7.9: a new round re-inks the round numeral, with a paper tick.
          if (ev.round > d.round && d.round > 0) this.cue('tick', { delay: 0.45 });
        }
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
          if (!this.voiceHolding()) this.narration = `${pName(d, ev.player)} places ${armies(this.narrPlaced)}`;
        }
        break;
      case 'diceRolled':
        this.onRollStart(ev, e);
        // v5 D4: a human attacked an AI seat: it remembers (said as its next turn begins).
        if (!e.ai && !this.autoplayOn && ev.defender >= 0 && this.isHumanSeat(ev.player) && d.players[ev.defender]?.kind === 'ai') {
          this.voices.aggrieve(ev.defender, ev.player, 'attacked');
        }
        if (e.ai) {
          // v4 A1: the line begins with the stroke and completes with the verdict.
          const begun = attackBegins(pName(d, ev.player), tName(ev.to));
          if (this.narrBegun !== begun) this.narrBegun = begun;
          this.narration = begun;
        }
        break;
      case 'territoryConquered':
        if (this.meta) noteConquest(this.story(), d.round, ev.to, ev.player, ev.previousOwner);
        this.lastConquest = { attacker: ev.player, victim: ev.previousOwner };
        if (ev.previousOwner >= 0) this.lostKeys[ev.previousOwner] = (this.lostKeys[ev.previousOwner] ?? 0) + 1;
        if (e.ai) this.narration = attackTakes(this.narrBegun ?? attackBegins(pName(d, ev.player), tName(ev.to)));
        // v4 A4: the loser's ring, as the territory falls on the board.
        if (ev.previousOwner >= 0 && this.isHumanSeat(ev.previousOwner) && !this.autoplayOn && this.meta) {
          const rings = (this.meta.rings ??= {});
          const list = (rings[ev.previousOwner] ??= []);
          if (!list.includes(ev.to)) rings[ev.previousOwner] = [...list, ev.to];
        }
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
        const bonus = mapDefOf(d.config).continents[c].bonus;
        // Human involvement only: a human took it, or took it from a human. AI-vs-AI just flares.
        const lc = this.lastConquest;
        const involved = this.isHumanSeat(ev.player) || (!!lc && lc.attacker === ev.player && this.isHumanSeat(lc.victim));
        if (involved) {
          // v5 E7: a human's continent says what it's worth to them: 'John holds Asia · +7 next turn'.
          const worth = this.isHumanSeat(ev.player) ? `+${bonus} next turn` : `+${bonus}`;
          this.announce('continent', `${upper(name)} HOLDS ${upper(cName(c))}${SEP}+${bonus}`, ev.player, {
            name: 'continent',
            opts: aiFar([ev.player]),
          }, `${name} holds ${cName(c)}${SEP}${worth}`);
        } else this.play('continent', { distance: 0.6 });
        // v5 D4: an AI that takes a continent on its own turn says so.
        if (e.ai && d.currentPlayer === ev.player && d.players[ev.player]?.kind === 'ai') this.say(ev.player, 'continent', { continent: cName(c) }, d.turn, d);
        this.log('continent', ev.player, `${name} holds ${cName(c)}${SEP}+${bonus} a turn`);
        break;
      }
      case 'continentLost': {
        const by = pName(d, ev.to);
        const victim = pName(d, ev.player);
        this.log('continent', ev.to, `${by} broke ${poss(victim)} ${cName(ev.continent)}`);
        // Losing stings (docs/INK.md A5): a human's broken continent gets the hand-damped bowl, and (v4 B3)
        // the score leans cold for one chord.
        if (this.isHumanSeat(ev.player) && !this.autoplayOn && !skip) {
          this.play('continent', { variant: 'somber' });
          this.lean();
        }
        break;
      }
      case 'playerEliminated': {
        if (e.ai) this.narration = `${pName(d, ev.by)} knocks out ${pName(d, ev.player)}`;
        if (this.meta) noteOut(this.story(), Math.max(1, d.round), ev.player, ev.by);
        // v5 D4: a knocked-out AI blames who did it; an AI that knocks out a human says so.
        if (d.players[ev.player]?.kind === 'ai') this.say(ev.player, 'out', { by: pName(d, ev.by) }, d.turn, d);
        else if (d.players[ev.by]?.kind === 'ai') this.say(ev.by, 'eliminates', { victim: pName(d, ev.player) }, d.turn, d);
        if (this.meta) this.meta.out = { ...(this.meta.out ?? {}), [ev.player]: { by: ev.by, round: d.round } };
        if (this.meta?.rings) delete this.meta.rings[ev.player];
        if (this.isHumanSeat(ev.player) && !this.autoplayOn) this.lean();
        this.holdUntil = this.now() + 500;
        this.audio.stopAll?.();
        this.play('eliminated', { delay: 0.15 });
        break;
      }
      case 'cardsTraded': {
        const v = ev.armies;
        if (e.ai) this.narration = `${pName(d, ev.player)} trades cards for +${v}`;
        // v5 E6: a trade pours its armies into the holding dab.
        if (this.turnArmies && this.turnArmies.player === ev.player && this.turnArmies.turn === d.turn) {
          this.turnArmies = { ...this.turnArmies, cards: this.turnArmies.cards + v };
          if (!skip) this.cue('pour', { delay: 0.2, duration: pourSeconds(v) });
        }
        const rate = v >= 20 ? 0.72 : 1 - ((Math.max(4, v) - 4) / 16) * 0.28;
        this.play('cardTrade', { rate, volume: v > 10 ? 1.26 : 1, ...aiFar([ev.player]) });
        break;
      }
      case 'cardDrawn':
        this.play('cardDraw', aiFar([ev.player]));
        break;
      case 'territoriesDealt':
        if (!skip) this.dealTicks(ev.owners);
        break;
      case 'truceProposed':
      case 'truceAccepted':
      case 'truceDeclined':
      case 'truceBroken':
      case 'truceExpired': {
        // v5.1 C: truces live between AI seats (understandings). The Ledger keeps every AI-to-AI sentence; the one
        // line says only when an understanding forms or breaks, once. Nothing here ever asks a human anything.
        const a = ev.type === 'truceBroken' ? ev.by : ev.from;
        const b = ev.type === 'truceBroken' ? ev.against : ev.to;
        const aiPair = d.players[a]?.kind === 'ai' && d.players[b]?.kind === 'ai';
        const text = truceSentence(e.after, ev);
        const actor =
          ev.type === 'truceBroken' ? ev.by : ev.type === 'truceAccepted' || (ev.type === 'truceDeclined' && ev.reason === 'declined') ? ev.to : ev.from;
        if (text && (aiPair || ev.type === 'truceBroken')) this.log('truce', actor, text);
        // An understanding ends by standing (v5.1 engine: truceExpired reason 'standing') or by an attack.
        const turned = ev.type === 'truceExpired' && (ev as { reason?: string }).reason === 'standing';
        if (aiPair && (ev.type === 'truceAccepted' || ev.type === 'truceBroken' || turned)) {
          const line =
            ev.type === 'truceAccepted'
              ? `${pName(d, ev.from)} and ${pName(d, ev.to)} have an understanding`
              : ev.type === 'truceBroken'
                ? `${pName(d, ev.by)} turned on ${pName(d, ev.against)}`
                : `${pName(d, a)} turned on ${pName(d, b)}`;
          this.understandingLine(line);
        }
        // v5 D4: a truce broken against an AI seat: it says so as its next turn begins.
        if (ev.type === 'truceBroken' && d.players[ev.against]?.kind === 'ai') this.voices.aggrieve(ev.against, ev.by, 'truceBroken');
        // A broken truce against a human stings like a lost continent: the ring dims, the somber bowl.
        if (ev.type === 'truceBroken' && this.isHumanSeat(ev.against) && !this.autoplayOn && !skip) {
          this.lostKeys[ev.against] = (this.lostKeys[ev.against] ?? 0) + 1;
          this.play('continent', { variant: 'somber' });
          this.haptics.play('conquest');
        }
        break;
      }
      case 'peaceAnswered':
        this.onPeaceAnswered(ev, d);
        break;
      case 'peaceBroken':
        this.onPeaceBroken(ev, d, skip);
        break;
      case 'standingChanged': {
        // The seat mark changes on its own (SeatChipVM.standing reads the board). The one line speaks only when it
        // is about the reader and the band is wary / hostile (or turns ally); the Ledger only when it hardens to
        // hostile toward a human.
        const toHuman = this.isHumanSeat(ev.toward) && d.players[ev.ai]?.kind === 'ai';
        if (ev.standing === 'hostile' && toHuman) this.log('truce', ev.ai, this.hostileLine(e.after, ev.ai, ev.toward));
        if (toHuman && !this.autoplayOn && !skip && ev.standing !== 'even' && ev.toward === this.standingReader(d)) {
          let why = '';
          try {
            why = standingReason(e.after, ev.ai, ev.toward) || '';
          } catch {
            why = '';
          }
          // Never over a peace answer or a broken peace said a moment ago (they already carry the news).
          if (why && this.flash?.kind !== 'peace') {
            if (this.isAiDriven(d.currentPlayer)) this.narration = why;
            else this.flashLine(why, 'standing', STANDING_MS, ev.ai);
          }
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
        this.startReplay(e.after, ev.winner);
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
        // v4 A1: the engagement ended without taking it: the line completes.
        if (e.ai && e.verdict === 'held') this.narration = attackThrownBack(this.narrBegun ?? attackBegins(pName(d, ev.player), tName(ev.to)));
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
        if (ev.phase === 'occupy' && this.state?.phase.kind === 'occupy' && this.sel.occupyCount === null) {
          // v5.1 E2: all but one moves in by default.
          this.sel.occupyCount = this.state.phase.max;
          this.sel.countTouched = false;
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
      // v4 A3: what an AI did on its own turn, for the receipt (skipped events too: Skip is receipt only).
      if (e.ai && !this.autoplayOn && d.turn > 0 && this.isAiDriven(d.currentPlayer)) recordReceipt(this.receipts(), d, ev);
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
      // v4 A2: the AI's marker clacks across the room (distance), not at a whisper.
      if (e.ai) this.play('place', { rate: 0.82, volume: 0.9, distance: 0.6 });
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
    // The house voice (v3 ledger): middle dots, no colon, no arrow. v4 A5: the line names the owner it was
    // taken from ('Vermilion took Brazil from Ochre · 4 vs 1 · lost 0'); the origin goes to the detail.
    const A = pName(d, g.attacker);
    const D = pName(d, g.defender);
    const odds = `${g.startA} vs ${g.startD}`;
    const upset = g.upset ? `${SEP}${g.upset}` : '';
    if (g.conquered) return `${A} took ${tName(g.to)} from ${D}${SEP}${odds}${SEP}lost ${g.attLost}${upset}`;
    if (final) return `${D} held ${tName(g.to)} against ${A}${SEP}${odds}${SEP}${A} lost ${g.attLost}${upset}`;
    return `${A} ${g.blitz ? 'blitzes' : 'attacks'} ${poss(D)} ${tName(g.to)}${SEP}${odds}${SEP}now ${d.territories[g.from].armies} vs ${d.territories[g.to].armies}`;
  }

  private writeEngagementLog(final: boolean): void {
    const g = this.eng;
    const meta = this.meta;
    if (!g || !meta) return;
    const text = this.engagementText(final);
    const detail = `from ${tName(g.from)}`;
    if (g.logId) {
      const i = meta.log.findIndex((l) => l.id === g.logId);
      if (i >= 0) {
        // Immutable update: the HUD short-circuits on the lines array's identity.
        meta.log = meta.log.map((l, j) => (j === i ? { ...l, text, detail } : l));
        this.invalidate();
        return;
      }
    }
    g.logId = this.log('engagement', g.attacker, text, undefined, detail);
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
      // v5.1 A: the turn passes with this one line in the seat's pigment, ~1.5 s: "Sam's turn · 7 armies" (no cover,
      // no cup). The round lives in the dock; a resumed mid-turn says whose turn only.
      line: armiesIn === null ? `${poss(name)} turn` : `${poss(name)} turn${SEP}${armies(armiesIn)}`,
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

  private log(kind: LogLineVM['kind'], player: PlayerId | null, text: string, round?: number, detail?: string): number {
    const meta = this.meta;
    const d = this.disp;
    if (!meta || !d) return 0;
    const id = meta.logId++;
    // A new array every time: the HUD short-circuits on the lines array's identity.
    const line: LogLineVM = { id, round: round ?? d.round, seat: player !== null && d.players[player] ? seatRef(d, player) : null, kind, text };
    if (detail) line.detail = detail;
    const next = [...meta.log, line];
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
  // v4: cues, the score's lean and idle, the receipt (PLAN §3 A2–A3, §4 B3, §7)
  // =========================================================================

  /** A v4 / v5 cue; engines without `cue` stay silent. */
  private cue(name: V4Cue | V5Cue, opts?: PlayOptions): void {
    try {
      this.audio.cue?.(name, opts);
    } catch {
      /* audio is best-effort */
    }
  }

  /**
   * A sheet of paper laid on the table (open) or lifted off it (close): overlays, the cards sheet, a
   * confirm, the receipt. ('lift' is the audio branch's SfxVariant; cast until that type lands here.)
   */
  private sheet(open: boolean): void {
    this.cue('sheet', open ? undefined : { variant: 'lift' });
  }

  /** A human lost a continent or a seat: the score leans cold for one chord (B3). */
  private lean(): void {
    try {
      this.audio.lean?.('cold');
    } catch {
      /* audio is best-effort */
    }
  }

  /** The table waits: the score thins after a minute untouched on a human's turn; any input brings it back. */
  private setIdle(on: boolean): void {
    if (on === this.idleOn) return;
    this.idleOn = on;
    try {
      this.audio.setIdle?.(on);
    } catch {
      /* audio is best-effort */
    }
  }

  /** Any input: the idle clock restarts and a thinned score comes back. */
  private markActive(): void {
    this.lastActive = this.now();
    this.setIdle(false);
  }

  /** The deal (§7.1): one paper tick per flip, panned to where it lands, spread over the deal. */
  private dealTicks(owners: Partial<Record<TerritoryId, PlayerId>>): void {
    const ts = Object.keys(owners) as TerritoryId[];
    const w = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 0;
    const span = 2.2 / Math.max(1, ts.length);
    ts.forEach((t, i) => {
      let pan: number | undefined;
      if (w) {
        const p = this.board.getScreenPosition(t);
        if (p) pan = Math.max(-1, Math.min(1, (p.x / w) * 2 - 1));
      }
      this.cue('tick', { delay: i * span, ...(pan !== undefined ? { pan } : {}) });
    });
  }

  // =========================================================================
  // v5: the game's memory, the voices, the replay, the camera lean (_claude/v5/PROPOSAL.md §4 C, D, A9)
  // =========================================================================

  /** A territory's stereo position, −1..1 from its screen x (null without a window or a position). */
  private panOf(t: TerritoryId): number | null {
    const w = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 0;
    const p = w ? this.board.getScreenPosition(t) : null;
    return p ? Math.max(-1, Math.min(1, (p.x / w) * 2 - 1)) : null;
  }

  /** v5 B "the evening deepens": dusk at round 1, night by round 12; the score and the paper both hear it. */
  private setEvening(round: number): void {
    const t = Math.min(1, Math.max(0, (round - 1) / 11));
    try {
      (this.audio as AudioEngine & { setEvening?: (t: number) => void }).setEvening?.(t);
      (this.board as BoardView & { setEvening?: (t: number) => void }).setEvening?.(t);
    } catch (err) {
      console.error(err);
    }
  }

  private story(): StoryLedger {
    const m = this.meta!;
    return (m.story ??= emptyStory());
  }

  /**
   * An AI seat says one line (at most one per turn, src/game/voice.ts). The chip keeps it; on an AI's turn it is
   * also the strip's one line (narration, in the seat's tint) and holds a moment against its placement count.
   */
  private say(seat: PlayerId, kind: VoiceKind, vars: VoiceVars, turn: number, d: GameState): void {
    const e = this.voices.say(d, seat, kind, vars, turn);
    if (!e) return;
    // v5.1 D: a personality is hidden until the seat first speaks; its first line reveals it.
    if (this.meta && !(this.meta.revealed ?? []).includes(seat)) this.meta.revealed = [...(this.meta.revealed ?? []), seat];
    if (this.isAiDriven(d.currentPlayer)) {
      this.narration = e.text;
      this.voiceNow = { text: e.text, seat };
      this.voiceHoldUntil = this.now() + VOICE_HOLD_MS;
    }
    this.invalidate();
  }

  private voiceHolding(): boolean {
    return !!this.voiceNow && this.now() < this.voiceHoldUntil && this.narration === this.voiceNow.text;
  }

  /**
   * v5 C1: the game is won: build the replay from the ledger. It shows before the recap unless the board plays at
   * instant speed (the logic lane, Skip players); any tap or 'skipReplay' ends it, and it ends itself after its
   * last round has dried.
   */
  private startReplay(final: GameState, winner: PlayerId): void {
    if (!this.meta) return;
    try {
      const r = buildReplay(this.story(), final, winner, ++this.replayKey);
      // v5 G: a mission win's last round says the mission's headline.
      const head = this.missionHeadline(final);
      const n = r.rounds.length;
      this.lastReplay = head && n ? { ...r, rounds: r.rounds.map((x, j) => (j === n - 1 ? { ...x, line: head } : x)) } : r;
    } catch (err) {
      console.error('[risk] replay failed', err);
      this.lastReplay = null;
      return;
    }
    if (this.victory) this.victory = { ...this.victory, moments: this.lastReplay.moments };
    if (this.settings.animationSpeed === 0 || !this.lastReplay.rounds.length || this.noReplay) return;
    this.replay = this.lastReplay;
    const total = this.replay.rounds.length * this.replay.msPerRound + 1500;
    const key = this.replay.key;
    if (this.replayTimer) this.clock.clearTimeout(this.replayTimer);
    this.replayTimer = this.timer(() => {
      this.replayTimer = null;
      if (this.replay?.key === key) this.endReplay(true);
    }, total);
  }

  /** The UI reached round `index` of the replay: the board re-soaks to that round's end, the numeral re-inks. */
  private replayTo(index: number): void {
    const r = this.replay;
    const s = this.state;
    if (!r || !s || !this.meta) return;
    const b = replayBoard(this.story(), s, index);
    if (!b) return;
    if (index === 0) this.board.setAttractMode(false);
    this.board.syncState(b);
    this.cue('tick');
  }

  /** The replay ends (a tap, 'skipReplay', its own timer, a new game): the final board, then the recap. */
  private endReplay(restore: boolean): void {
    if (this.replayTimer) {
      this.clock.clearTimeout(this.replayTimer);
      this.replayTimer = null;
    }
    if (!this.replay) return;
    this.replay = null;
    if (restore && this.state) {
      this.board.syncState(this.state);
      this.board.setAttractMode(true);
    }
    this.invalidate();
  }

  /**
   * v5 A9: the camera leans toward a fight: a human's armed or rolling pair (the board's default lean), an AI's
   * readable fight (lighter). Called on every highlight push; the board hears each change once.
   */
  private syncLean(target: { ts: TerritoryId[]; amount?: number } | null): void {
    const key = target ? `${target.ts.join('>')}|${target.amount ?? ''}` : '';
    if (key === this.leanKey) return;
    this.leanKey = key;
    try {
      if (target) this.board.leanTo?.(target.ts, target.amount !== undefined ? { amount: target.amount } : undefined);
      else this.board.leanBack?.();
      // The room goes cold for the fight's breath, and warms back with the camera.
      (this.audio as AudioEngine & { fightCold?: (on: boolean) => void }).fightCold?.(!!target);
    } catch (err) {
      console.error(err);
    }
  }

  private leanTarget(): { ts: TerritoryId[]; amount?: number } | null {
    const s = this.state;
    const d = this.disp;
    if (!s || !d || this.screen !== 'game' || this.replay) return null;
    const g = this.eng;
    const live = g && !g.endedAt ? g : null;
    if (live) return this.isAiDriven(live.attacker) ? { ts: [live.from, live.to], amount: AI_LEAN } : { ts: [live.from, live.to] };
    const interactive = this.interactive() && d.currentPlayer === s.currentPlayer;
    if (interactive) {
      const sel = this.viewSel();
      if (d.phase.kind === 'attack' && sel.selected && sel.target && d.territories[sel.selected].owner === d.currentPlayer && d.territories[sel.target].owner !== d.currentPlayer) {
        return { ts: [sel.selected, sel.target] };
      }
      return null;
    }
    const a = this.aiHighlights?.arrow;
    if (a && a.kind === 'attack') return { ts: [a.from, a.to], amount: AI_LEAN };
    return null;
  }

  /** A clickable's line holds the strip a moment (v5 F). */
  private flashLine(text: string, kind: FlashKind = 'tap', ms = FLASH_MS, seat?: PlayerId): void {
    this.flash = { text, until: this.now() + ms, kind, ...(seat !== undefined ? { seat } : {}) };
    this.lineKey++;
    const until = this.flash.until;
    this.timer(() => {
      if (this.flash && this.flash.until === until) {
        this.flash = null;
        this.lineKey++;
        this.invalidate();
      }
    }, ms + 5);
    this.invalidate();
  }

  /** The human the grudge ticks are read for: the driver on a human turn, else the next human to get the cup. */
  private grudgeReader(d: GameState): PlayerId | null {
    if (this.autoplayOn) return null;
    const n = d.players.length;
    for (let k = 0; k < n; k++) {
      const p = d.players[(d.currentPlayer + k) % n];
      if (p && p.kind === 'human' && !p.eliminated) return p.id;
    }
    return null;
  }

  /** v5 E6: the holding dab: the current human's armies still to place this turn, and where they came from. */
  private buildHolding(d: GameState): GameVM['holding'] {
    const s = this.state;
    if (!s || this.screen !== 'game' || this.autoplayOn) return null;
    const ph = d.phase;
    const me_ = d.currentPlayer;
    if (ph.kind !== 'reinforce' || ph.remaining <= 0 || !this.isHumanSeat(me_) || this.isAiDriven(me_) || d.currentPlayer !== s.currentPlayer) return null;
    const t = this.turnArmies && this.turnArmies.player === me_ && this.turnArmies.turn === d.turn ? this.turnArmies : null;
    const b = t?.b ?? reinforcementsFor(d, me_);
    const breakdown = ph.midTurn && !t ? `cards +${ph.remaining}` : holdingBreakdown(b, t?.cards ?? 0);
    return { seat: seatRef(d, me_), armies: ph.remaining, breakdown };
  }

  private receipts(): ReceiptLedger {
    const m = this.meta!;
    return (m.receipts ??= emptyReceipts());
  }

  /**
   * Open the receipt for `seat`'s turn `turn` if AI turns were played since its last one (A3). Idempotent
   * per turn: the hand-off cover opens it first, the turn start finds it open (or already dismissed).
   */
  private openReceipt(seat: PlayerId, turn: number, sinceIn?: number, at?: GameState): void {
    // Removed from v5 (John, 2026-10-03): the "While you were away" sheet never opens. The loser's rings, the
    // grudge ticks, the turn line's grudge sentence and the Ledger carry what happened. The ledger below is
    // still kept (the Ledger and the story read it); the sheet itself is gone.
    if (seat >= 0) return;
    const meta = this.meta;
    const s = at ?? this.state;
    if (!meta || !s || this.autoplayOn || s.players[seat]?.kind !== 'human') return;
    if (this.receipt && this.receipt.seat === seat && this.receipt.turn === turn) return;
    const l = this.receipts();
    if (l.done && l.done.seat === seat && l.done.turn === turn) return;
    const since = sinceIn ?? receiptSince(l, seat);
    if (since === null || since >= turn) return;
    const title = this.resumedTitle ? 'Since your last turn' : 'While you were away';
    const vm = buildReceipt(l, s, seat, since, title, ++this.receiptKey);
    if (!vm) return;
    this.resumedTitle = false;
    this.receipt = { ...vm, seat, turn };
    l.pending = { seat, turn, since };
    this.pulse = [];
    this.sheet(true);
    this.saveMeta();
    this.invalidate();
  }

  /** Any tap on the receipt: it lifts, and the turn banner it held back writes. */
  private dismissReceipt(): void {
    const r = this.receipt;
    if (!r) return;
    this.receipt = null;
    this.pulse = [];
    if (this.meta) {
      const l = this.receipts();
      l.pending = null;
      l.done = { seat: r.seat, turn: r.turn };
      this.saveMeta();
    }
    this.sheet(false);
    const show = this.bannerAfterReceipt;
    this.bannerAfterReceipt = null;
    show?.();
    // Behind the receipt the driver's first tap was spent on it: never carry it into the turn.
    this.guardUntil = Math.max(this.guardUntil, this.now() + 150);
    this.invalidate();
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
    if (!info || !d || this.screen !== 'game' || this.overlay || this.confirm) {
      this.hideNameCard();
      return;
    }
    if (!this.showNameCard(info)) return this.hideNameCard();
    this.haptics.play('select');
  }

  /** The name card for `info`'s territory at the pointer (touch long-press; v4 desktop click). */
  private showNameCard(info: TerritoryPointerInfo): boolean {
    const d = this.disp;
    const t = info.territory;
    const tile = d?.territories[t];
    if (!d || !tile) return false;
    const c = mapDefOf(d.config).territories[t].continent;
    const owner = tile.owner >= 0 && d.players[tile.owner] ? seatRef(d, tile.owner) : null;
    this.nameCard = {
      territory: tName(t),
      continent: cName(c),
      bonus: mapDefOf(d.config).continents[c].bonus,
      owner,
      armies: tile.armies,
      x: info.clientX,
      y: info.clientY,
      key: ++this.nameCardKey,
      history: this.meta ? stoneHistory(this.story(), d, t) : null,
    };
    this.invalidate();
    return true;
  }

  private hideNameCard(): void {
    if (!this.nameCard) return;
    this.nameCard = null;
    this.invalidate();
  }

  private onBoardClick(info: TerritoryPointerInfo): void {
    this.boardClicks++;
    this.hideNameCard();
    this.markActive();
    // v5 C1: any tap during the replay ends it (the recap shows).
    if (this.replay) {
      this.endReplay(true);
      return;
    }
    // v4 A3: input to the board waits on the receipt; the tap dismisses it and does nothing else.
    if (this.receipt && !this.overlay && !this.confirm) {
      this.dismissReceipt();
      return;
    }
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
    if (this.selKey() !== before) {
      this.haptics.play('select');
      // §7.3: a tapped territory answers with a paper tick, and (desktop) its name card; the UI holds the
      // card about a second and dries it.
      this.cue('tick');
      if (!this.touch) this.showNameCard(info);
    }
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
    this.markActive();
    // v4 A3: no stroke arms anything while the receipt shows (a finished one dismisses it, like a tap).
    if (this.receipt) {
      if (st.done) this.dismissReceipt();
      return;
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
    if (n >= left && s.phase.kind === 'reinforce') this.scheduleAutoAttack();
  }

  /**
   * v5.1 E1: the last army is placed: the marker moves to Attack by itself after a short beat (End turn stays
   * explicit). Not over a forced trade, not while the Cards sheet is open, and an Undo in the beat cancels it.
   */
  private scheduleAutoAttack(): void {
    this.cancelAutoAttack();
    const s0 = this.state;
    if (!s0) return;
    const turn = s0.turn;
    const epoch = this.epoch;
    const fire = () => {
      this.autoAttackTimer = null;
      const s = this.state;
      if (epoch !== this.epoch || !s || s.turn !== turn || this.screen !== 'game' || !this.interactive()) return;
      const ph = s.phase;
      if (ph.kind !== 'reinforce' || ph.remaining > 0 || ph.mustTrade || this.cardsOpen || this.overlay || this.confirm) return;
      // Still landing on the board: wait for it (a click-through would skip the drop's animation).
      if (this.busyBlocking() || this.pumping) {
        this.autoAttackTimer = this.timer(fire, 60);
        return;
      }
      this.goTo('attack');
      this.saveMeta();
      this.invalidate();
    };
    this.autoAttackTimer = this.timer(fire, AUTO_ATTACK_MS);
  }

  private cancelAutoAttack(): void {
    if (this.autoAttackTimer) {
      this.clock.clearTimeout(this.autoAttackTimer);
      this.autoAttackTimer = null;
    }
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
        const t = mapDefOf(s.config).territoryIds.find((x) => (ph.placed[x] ?? 0) > 0);
        if (t) last = { t, n: ph.placed[t]! };
      }
      if (!last) return;
      this.cancelAutoAttack();
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
      // v5.1 E2: all but one moves in by default; the stepper unfolds only if the count is touched.
      this.sel.occupyCount = after.phase.max;
      this.sel.countTouched = false;
      return;
    }
    if (after.phase.kind !== 'attack') {
      this.sel = emptySel();
      return;
    }
    if (after.territories[to].owner === me) {
      // Auto-occupied conquest: chain. v4 A5: no choice was offered, so the line says what moved in.
      const chain = autoChain(after, from, to);
      this.sel = { ...emptySel(), selected: chain };
      const mv = r.events.find((x): x is Extract<GameEvent, { type: 'armiesMoved' }> => x.type === 'armiesMoved' && x.reason === 'occupy');
      if (mv) {
        this.autoMoved = { to, n: mv.count, chain, turn: after.turn, until: this.now() + AUTO_MOVED_MS };
        this.timer(() => this.invalidate(), AUTO_MOVED_MS + 20);
      }
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
    this.markActive();
    if (this.receipt) {
      this.dismissReceipt();
      return;
    }
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
        this.sheet(this.cardsOpen);
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
      // v5.1 C: the human truce protocol went (standing replaces it); these ids are never shown.
      case 'truce':
      case 'acceptTruce':
      case 'declineTruce':
      case 'watchAis':
      case 'callGame':
        break;
    }
  }

  // --- Standing (v5.1 C): how each AI seat feels about the reader, and the one gesture -----------------

  /** The human the seat marks are read for: the driver on a human turn, else the next human to play. */
  private standingReader(d: GameState): PlayerId | null {
    return this.grudgeReader(d);
  }

  /** One AI seat's standing fields toward `reader` (tolerates the engine stub: 'even' / '' / false). */
  private standingFields(d: GameState, ai: PlayerId, reader: PlayerId | null): Pick<SeatChipVM, 'standing' | 'standingReason' | 'canAskPeace' | 'understandingWith'> {
    const p = d.players[ai];
    if (!p || p.kind !== 'ai' || p.neutral || p.eliminated) return {};
    const out: Pick<SeatChipVM, 'standing' | 'standingReason' | 'canAskPeace' | 'understandingWith'> = {};
    try {
      // AI-to-AI understandings only; a human's peace is the standing mark ('ally'), not a tie.
      out.understandingWith = trucePartners(d, ai).filter((x) => d.players[x]?.kind === 'ai' && !d.players[x].eliminated);
      if (reader === null || !d.players[reader] || d.players[reader].eliminated) return out;
      out.standing = standingOf(d, ai, reader);
      out.standingReason = standingReason(d, ai, reader) || null;
      // Asking is live only on the reader's own turn, on the engine's true state (the board may still be landing).
      const s = this.state;
      out.canAskPeace = !!s && this.interactive() && s.currentPlayer === reader && d.currentPlayer === reader && canAskPeace(s, reader, ai);
    } catch (err) {
      console.error('[risk] standing failed', err);
    }
    return out;
  }

  /** A seat ring hovered / long-pressed: its reason writes in the one line (null = released). */
  private showStanding(player: PlayerId | null, hold: boolean): void {
    if (player === null) {
      if (this.flash?.kind === 'standing') {
        this.flash = null;
        this.lineKey++;
      }
      return;
    }
    const d = this.disp;
    if (!d || this.screen !== 'game' || !d.players[player] || d.players[player].kind !== 'ai') return;
    const f = this.standingFields(d, player, this.standingReader(d));
    const text = f.standingReason || (f.standing ? this.plainStanding(d, player, f.standing) : null);
    if (!text) return;
    // Hover holds the line until the pointer leaves (a long safety net); a long-press holds a moment.
    this.flashLine(text, 'standing', hold ? 60_000 : STANDING_MS, player);
  }

  /** The fallback reason when the engine has none: 'Sage is wary of you'. */
  private plainStanding(d: GameState, ai: PlayerId, st: Standing): string {
    const name = pName(d, ai);
    switch (st) {
      case 'ally':
        return `${name} is at peace with you`;
      case 'even':
        return `${name} is even with you`;
      case 'wary':
        return `${name} is wary of you`;
      case 'hostile':
        return `${name} is hostile to you`;
    }
  }

  /** 'Ask Sage for peace', confirmed: the engine answers at once (peaceAnswered). One gesture, no protocol. */
  private askPeace(to: PlayerId): void {
    const s = this.state;
    if (!s || !this.interactive() || this.now() < this.holdUntil) return;
    const me = s.currentPlayer;
    if (s.players[me]?.kind !== 'human' || !s.players[to] || s.players[to].kind !== 'ai' || s.players[to].eliminated) return;
    if (this.busyBlocking()) {
      this.clickThrough(() => this.askPeace(to));
      return;
    }
    this.clearRejection();
    // Not now (asked recently, peace broken, not your main turn): the engine's own line, nothing applied.
    let can = true;
    try {
      can = canAskPeace(s, me, to);
    } catch {
      can = true;
    }
    const block = can ? null : peaceAskBlockOf(s, me, to);
    if (block) {
      this.reject('peace_blocked', block.replace(/\.$/, ''));
      this.invalidate();
      return;
    }
    const r = this.act({ type: 'askPeace', player: me, to });
    if (!r.ok) this.reject('peace_refused', r.error && r.error.length <= 60 ? r.error.replace(/\.$/, '') : `You cannot ask ${pName(s, to)} now`);
    this.invalidate();
  }

  /** The AI's answer, at once, in its light tint: 'Sage agrees · three rounds' / 'Sage refuses · you took Ural'. */
  private onPeaceAnswered(ev: Extract<GameEvent, { type: 'peaceAnswered' }>, d: GameState): void {
    const ai = d.players[ev.from]?.kind === 'ai' ? ev.from : ev.to;
    const human = ai === ev.from ? ev.to : ev.from;
    const name = pName(d, ai);
    const said = (truceSentence(d, ev) ?? ev.reason ?? '').trim();
    const text = said
      ? said
      : ev.accepted
        ? `${name} agrees${SEP}${roundsWord(ev.rounds)}`
        : `${name} refuses`;
    this.log('truce', ai, ev.accepted ? `${text}${SEP}peace with ${pName(d, human)}` : `${text}${SEP}asked by ${pName(d, human)}`);
    this.flashLine(text, 'peace', PEACE_MS, ai);
  }

  /** Peace broken: by a human ('You broke the peace with Sage'), or by an AI against a human (the room goes cold). */
  private onPeaceBroken(ev: Extract<GameEvent, { type: 'peaceBroken' }>, d: GameState, skip: boolean): void {
    const by = d.players[ev.by];
    const against = d.players[ev.against];
    if (!by || !against) return;
    if (by.kind === 'human') {
      // The somber conquer variant plays with the attack itself; this is the line and the record.
      const line = `You broke the peace with ${pName(d, ev.against)}`;
      this.log('truce', ev.by, truceSentence(d, ev) || `${pName(d, ev.by)} broke the peace with ${pName(d, ev.against)}`);
      if (!this.autoplayOn) this.flashLine(line, 'peace', PEACE_MS);
      if (against.kind === 'ai') this.voices.aggrieve(ev.against, ev.by, 'truceBroken');
    } else if (against.kind === 'human') {
      const line = `${pName(d, ev.by)} broke the peace${SEP}it is hostile now`;
      this.log('truce', ev.by, truceSentence(d, ev) || `${pName(d, ev.by)} broke the peace with ${pName(d, ev.against)}`);
      if (!this.autoplayOn) {
        if (this.isAiDriven(d.currentPlayer)) this.narration = line;
        else this.flashLine(line, 'peace', PEACE_MS, ev.by);
        if (!skip) {
          this.lostKeys[ev.against] = (this.lostKeys[ev.against] ?? 0) + 1;
          this.lean();
        }
      }
    }
  }

  /** The Ledger's line when an AI hardens to hostile toward a human: 'Sage is hostile to you · you took Ural'. */
  private hostileLine(s: GameState, ai: PlayerId, toward: PlayerId): string {
    let why = '';
    try {
      why = standingReason(s, ai, toward) || '';
    } catch {
      why = '';
    }
    const many = this.humanCount(s) >= 2;
    const head = `${pName(s, ai)} is hostile to ${many ? pName(s, toward) : 'you'}`;
    if (!why) return head;
    // The engine's reason is a whole sentence ('Sage is hostile · you took Ural'): keep only its reason part.
    const i = why.indexOf(SEP);
    return i >= 0 ? `${head}${why.slice(i)}` : head;
  }

  /** An AI-to-AI understanding forms or breaks: said once, in the narration's tint. */
  private understandingLine(line: string): void {
    if (this.autoplayOn) return;
    const d = this.disp;
    if (d && this.isAiDriven(d.currentPlayer)) {
      this.narration = line;
      this.invalidate();
    } else this.flashLine(line, 'tap', PEACE_MS);
  }

  /** A Turn Track click. Past and current segments are inert; a locked one explains itself. */
  pressTrack(seg: TrackSegId): void {
    this.markActive();
    if (this.receipt) {
      this.dismissReceipt();
      return;
    }
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
      for (const t of mapDefOf(s.config).territoryIds) {
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
    } else if (this.state.phase.kind === 'occupy' && !this.sel.countTouched) {
      // v5.1 E2: a touch on the folded count unfolds the stepper.
      this.sel.countTouched = true;
    }
    this.invalidate();
  }

  /** Esc / ocean: one level at a time (the cards sheet, the target, the pick). False = nothing to back out of. */
  private backOut(): boolean {
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
    this.markActive();
    // v4 A3: Enter, Space or Esc on the receipt dismisses it (and does nothing else).
    if (this.receipt && !this.overlay && !this.confirm && this.screen === 'game' && (key === 'Enter' || key === ' ' || key === 'Escape')) {
      if (!repeat) this.dismissReceipt();
      return true;
    }
    if (!this.menuKeys && (this.confirm || this.overlay || this.screen !== 'game')) {
      // src/ui owns keys on menus, overlays and confirms.
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
    // §7.12 / E8: a sheet laid on the table or lifted off it.
    // Switching one sheet for another (menu → settings) lays the new one down; closing lifts it.
    if (o !== this.overlay) this.sheet(!!o);
    this.overlay = o;
    if (o) this.cardsOpen = false;
    this.invalidate();
    if (!o) this.scheduleAi();
  }

  intent(i: UiIntent): void {
    this.markActive();
    switch (i.type) {
      case 'receiptLine': {
        // The line writing now pulses its territories on the board; the next line (or dismiss) clears it.
        const line = this.receipt?.lines[i.index];
        this.pulse = line ? [...line.territories] : [];
        break;
      }
      case 'dismissReceipt':
        this.dismissReceipt();
        break;
      case 'replayRound':
        this.replayTo(i.index);
        break;
      case 'skipReplay':
        this.endReplay(true);
        break;
      case 'tapContinent':
        this.tapContinent(i.id);
        break;
      case 'tapCup':
        // v5.1 B: the cup went; a stray tap from an older HUD does nothing.
        break;
      case 'seatStanding':
        // Hover / long-press of an AI's seat ring: its reason in the one line until released.
        this.showStanding(i.player, true);
        break;
      case 'askPeace':
        this.askPeace(i.to);
        break;
      case 'more':
        if (i.scope === 'settings') this.settingsMore = i.open;
        else this.newGameMore = i.open;
        break;
      case 'tapEnso': {
        const d = this.disp;
        if (!d || this.screen !== 'game') break;
        const now = this.now();
        if (now - this.ensoAt <= ENSO_DOUBLE_MS) {
          this.ensoAt = -Infinity;
          this.setOverlay('log');
          this.sheet(true);
        } else {
          this.ensoAt = now;
          this.flashLine(d.round > 0 ? `Round ${d.round}` : 'Setup');
        }
        break;
      }
      case 'tapLane': {
        if (this.screen !== 'game' || !mapDefOf(this.state?.config).territories[i.from] || !mapDefOf(this.state?.config).territories[i.to]) break;
        const a = this.panOf(i.from);
        const b = this.panOf(i.to);
        this.cue('glint', { ...(a !== null ? { pan: a } : {}), ...(b !== null ? { panTo: b } : {}), duration: 0.5 } as PlayOptions);
        this.flashLine(`${tName(i.from)} to ${tName(i.to)} by sea`);
        break;
      }
      case 'hoverSeat': {
        const d = this.disp;
        const id = i.player !== null && d?.players[i.player] && !d.players[i.player].eliminated ? i.player : null;
        if (id !== this.hoverSeatId) this.hoverSeatId = id;
        break;
      }
      case 'stoneHistory': {
        const d = this.disp;
        if (i.territory === null) {
          if (this.flash?.kind === 'stone') {
            this.flash = null;
            this.lineKey++;
          }
          break;
        }
        if (!d || !this.meta || this.screen !== 'game' || !d.territories[i.territory]) break;
        this.flashLine(stoneHistory(this.story(), d, i.territory), 'stone', 2400);
        break;
      }
      case 'seatMission': {
        const s = this.state;
        if (i.player === null) {
          if (this.flash?.kind === 'mission') {
            this.flash = null;
            this.lineKey++;
          }
          break;
        }
        // Secret: only the seat whose live turn it is reads its own mission.
        if (!s || this.screen !== 'game' || !this.interactive() || i.player !== s.currentPlayer) break;
        const m = this.missionFor(s, i.player);
        if (m) this.flashLine(m, 'mission', 2400);
        break;
      }
      case 'nav':
        this.endReplay(false);
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
        if (listMaps().some((m) => m.id === i.id)) this.draft = { ...this.draft, mapId: i.id }; // visible packs only (hidden never list)
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
      case 'cardsPanel': {
        const was = this.cardsOpen;
        this.cardsOpen = i.open && !!this.state && this.interactive() && this.state.phase.kind === 'reinforce';
        if (was !== this.cardsOpen) this.sheet(this.cardsOpen);
        break;
      }
      case 'handoffAccept':
        // v5.1 A: the cover went; an older HUD's tap is a no-op.
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
        this.sheet(true);
        break;
      case 'restart':
        this.confirm = { kind: 'restart', text: `Restart this game?${SEP}Same seats, a new deal.` };
        this.sheet(true);
        break;
      case 'confirm': {
        const c = this.confirm;
        this.confirm = null;
        if (c) this.sheet(false);
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
        // v5.1 C: the human truce protocol went (standing and 'Ask X for peace' replace it).
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
    return `End the game now? ${pName(s, leader)} wins on territories (${territoryCount(s, leader)} of ${mapDefOf(s.config).size}).`;
  }

  private endGameNow(): void {
    const s = this.state;
    if (!s) return;
    const leader = this.standingsOrder(s)[0];
    this.clearSave();
    this.wakeAll();
    // v5 C: what was still queued to play happened all the same: the game's memory keeps it.
    if (this.meta) {
      for (const q of this.queue) {
        if (q.ev.type === 'territoryConquered') noteConquest(this.story(), q.after.round, q.ev.to, q.ev.player, q.ev.previousOwner);
        else if (q.ev.type === 'playerEliminated') noteOut(this.story(), Math.max(1, q.after.round), q.ev.player, q.ev.by);
      }
    }
    this.queue = [];
    this.skipAll = true;
    this.board.skipAnimations();
    this.victory = this.buildVictory(s, leader, `Called in round ${Math.max(1, s.round)}`);
    this.startReplay(s, leader);
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
    this.endReplay(false);
    const players = s.config.players.map((p, i) => ({ ...p, kind: s.players[i]?.kind ?? p.kind }));
    // v5 C3: same seats; the loser goes first. The engine draws the first seat from the seed, so the rematch
    // picks a seed whose deal starts with the loser (a handful of tries; deterministic once chosen).
    const winner = s.phase.kind === 'game-over' ? s.phase.winner : (this.victory?.winner.id ?? null);
    const first = rematchFirst(s, winner);
    const config: GameConfig = { ...s.config, players, seed: this.randomSeed() };
    for (let tries = 0; tries < 64; tries++) {
      const seed = this.randomSeed();
      try {
        if (createGame({ ...config, seed }).state.firstPlayer === first) {
          config.seed = seed;
          break;
        }
      } catch {
        break;
      }
    }
    this.startGame(config);
  }

  /** v5 F2: a tapped continent label: its name and bonus (and holder) for a moment, its land pulses once. */
  private tapContinent(c: ContinentId): void {
    const d = this.disp;
    const info = d ? mapDefOf(d.config).continents[c] : undefined;
    if (!d || !info || this.screen !== 'game') return;
    const owners = new Set<number>(info.territories.map((t) => d.territories[t]?.owner ?? -1));
    const holder: number = owners.size === 1 ? [...owners][0] : -1;
    const held = holder >= 0 && d.players[holder] ? `${SEP}${pName(d, holder)} holds it` : '';
    this.flashLine(`${cName(c)}${SEP}+${info.bonus} a turn${held}`);
    this.tapPulse = [...info.territories];
    this.timer(() => {
      this.tapPulse = [];
      this.invalidate();
    }, FLASH_MS);
  }

  // =========================================================================
  // AI highlight reel (UX.md §6.1)
  // =========================================================================

  private aiShouldAct(): boolean {
    const s = this.state;
    if (!s || this.screen !== 'game' || this.overlay || this.confirm) return false;
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
    const speed = this.aiSpeed();
    if (!this.aiCtx || this.aiCtx.key !== key || this.aiCtx.player !== p) {
      // v4 A1: count the turn's beats up front (a dry run of the AI on a copy), and compress every beat by
      // the same factor when there are more than the cap. Nothing is ever snapped.
      const opening = s.round <= 1 && !this.humanHasPlayed;
      const plan = s.turn > 0 && speed !== 'instant' ? this.planAiBeats(s) : { beats: 0, attacks: false };
      const beats = plan.beats;
      const cap = opening ? AI_BEATS_CAP_OPENING : AI_BEATS_CAP;
      this.aiCtx = { key, player: p, startedAt: this.now(), first: true, beats, scale: beats > cap ? Math.max(AI_MIN_SCALE, cap / beats) : 1, attacks: plan.attacks };
    }
    const ctx = this.aiCtx;
    // Watch = beats at 1×, Fast = 2× (spacing, never pitch); a long turn's beats run faster by 1/scale.
    const pace = (speed === 'fast' ? 2 : 1) / ctx.scale;
    const k = 1 / pace;
    this.applyBoardSpeed();

    if (speed === 'instant') {
      await this.aiInstantTurn();
      return;
    }

    // A5: the opening move of the game is an AI's: the room hears who goes first before anything moves.
    if (this.meta && !this.meta.firstMoved) {
      this.meta.firstMoved = true;
      this.narration = goesFirst(pName(s, p));
      this.invalidate();
      await this.sleep(FIRST_BEAT_MS * k);
      if (this.state !== s || !this.aiShouldAct()) return;
    }

    const ph = s.phase.kind;
    if (ph === 'setup-claim') {
      const a = this.chooseFor(s);
      const r = this.applyRaw(a);
      if (!r.ok) return this.aiFallback();
      this.enqueue(r.events.map((ev, i) => ({ ev, after: r.state, end: i === r.events.length - 1 })), { ai: true, style: 'readable', speed: pace });
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
      // The narration follows the drops as they land (onEventStart): tier-0 swells inside one short beat.
      const drops = collected.filter((x) => x.ev.type === 'armiesPlaced').length;
      const budget = (ph === 'setup-place' ? 600 : AI_PLACE_MS) * k;
      const stagger = drops > 1 ? Math.min(50 * k, Math.max(0, budget - 290 * k) / (drops - 1)) : 0;
      this.enqueue(collected, { ai: true, style: 'readable', stagger: Math.max(10, stagger), speed: pace });
      return;
    }

    if (ph === 'occupy') {
      const r = this.applyRaw(this.chooseFor(s));
      if (!r.ok) return this.aiFallback(pace);
      this.enqueue(r.events.map((ev, i) => ({ ev, after: r.state, end: i === r.events.length - 1 })), { ai: true, style: 'readable', speed: pace });
      return;
    }

    if (ph === 'attack') {
      const a0 = this.chooseFor(s);
      if (isAttackAction(a0)) {
        // One even breath before each engagement, so the line is read before the next begins. (v5.1 B: the cup's
        // rattle went with the cup.)
        await this.sleep((ctx.first ? THINK_TURN_START : AI_GAP_MS) * k);
        ctx.first = false;
        if (this.state !== s || !this.aiShouldAct()) return;
        await this.aiEngagement(a0, pace);
        return;
      }
      ctx.first = false;
      const r = this.applyRaw(a0);
      if (!r.ok) return this.aiFallback(pace);
      this.enqueue(r.events.map((ev, i) => ({ ev, after: r.state, end: i === r.events.length - 1 })), { ai: true, style: 'readable', speed: pace });
      return;
    }

    if (ph === 'fortify') {
      const a = this.chooseFor(s);
      if (a.type === 'fortify') {
        this.aiHighlights = { arrow: { from: a.from, to: a.to, kind: 'fortify', path: fortifyPath(s, a.from, a.to) ?? undefined } };
        this.invalidate();
        await this.sleep(AI_GAP_MS * k);
        if (this.state !== s || !this.aiShouldAct()) return;
      }
      const r = this.applyRaw(a);
      if (!r.ok) return this.aiFallback(pace);
      this.enqueue(r.events.map((ev, i) => ({ ev, after: r.state, end: i === r.events.length - 1 })), { ai: true, style: 'readable', speed: pace });
      return;
    }
  }

  /**
   * The beats this AI turn will play (engagements, plus one for a fortify), from a dry run of the AI on a
   * copy of the state. The engine is deterministic, so the count matches the turn about to be played.
   */
  private planAiBeats(s0: GameState): { beats: number; attacks: boolean } {
    const p = s0.currentPlayer;
    let s = s0;
    let beats = 0;
    let attacks = false;
    let pair = '';
    try {
      for (let guard = 0; guard < 2000; guard++) {
        if (s.phase.kind === 'game-over' || s.currentPlayer !== p || s.turn !== s0.turn) break;
        let a = chooseAiAction(s, p);
        let r = applyAction(s, a);
        if (!r.ok) {
          a = fallbackAction(s, p);
          r = applyAction(s, a);
          if (!r.ok) break;
        }
        if (isAttackAction(a)) {
          attacks = true;
          const k = `${a.from}>${a.to}`;
          if (k !== pair) beats++;
          pair = k;
        } else if (a.type !== 'occupy') pair = '';
        if (a.type === 'fortify') beats++;
        s = r.state;
      }
    } catch {
      return { beats, attacks };
    }
    return { beats, attacks };
  }

  private aiFallback(pace?: number): void {
    const s = this.state;
    if (!s) return;
    const r = this.applyRaw(fallbackAction(s, s.currentPlayer));
    if (r.ok) this.enqueue(r.events.map((ev, i) => ({ ev, after: r.state, end: i === r.events.length - 1 })), { ai: true, style: 'readable', ...(pace ? { speed: pace } : {}) });
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

  /**
   * One AI engagement as a readable beat (v4 A1, sitting 2026-10-03 Q7): never the dice show, never snapped.
   * The stroke draws, one bone click stands in for every roll, the verdict floods, and the line completes:
   * 'Sage attacks Ural…' → '… and takes it' / '… and is thrown back'. `pace` is the turn's board speed.
   */
  private async aiEngagement(first: Extract<Action, { type: 'attack' | 'blitz' }>, pace: number): Promise<void> {
    const s0 = this.state!;
    const p = s0.currentPlayer;
    const { from, to } = first;
    const collected: { ev: GameEvent; after: GameState; end: boolean; verdict?: 'held' }[] = [];
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
    this.narrBegun = attackBegins(pName(d, p), tName(to));
    this.narration = this.narrBegun;
    // No conquest: the last roll carries the verdict, and the line completes on it.
    if (!collected.some((x) => x.ev.type === 'territoryConquered')) {
      for (let i = collected.length - 1; i >= 0; i--) {
        if (collected[i].ev.type === 'diceRolled') {
          collected[i] = { ...collected[i], verdict: 'held' };
          break;
        }
      }
    }
    // Camera: frame the fight once if it's off-screen, before the arrow (UX.md §8.3). The camera leans.
    if (!this.onScreenForAi(from) || !this.onScreenForAi(to)) {
      this.board.focusTerritories([from, to]);
      await this.waitCamera();
      if (this.state !== planned) return;
    }
    if (this.state !== planned) return;
    this.aiHighlights = { selected: from, targets: [to], arrow: { from, to, kind: 'attack' } };
    this.invalidate();
    this.enqueue(collected, { ai: true, style: 'readable', speed: pace });
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

  /** Skip (AI speed 'instant'): the turn applies at once, then a 300 ms beat; the receipt carries it (A1). */
  private async aiInstantTurn(): Promise<void> {
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
    this.narration = `${pName(s0, p)} is playing`;
    this.narrBegun = null;
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
      newGame: { ...buildNewGameVM(this.draft), ...newGameExtras(this.draft), advancedOpen: this.newGameMore },
      game: this.buildGame(),
      victory: this.victory,
      rulesNotes: this.rulesNotes(),
      boardLost: this.boardLost,
      settingsGroups: { primary: SETTINGS_PRIMARY, more: SETTINGS_MORE, moreOpen: this.settingsMore },
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
      // v4: the HUD shows ONE line (strip.line); these two stay for the HUD's own use, never a transcript.
      events: this.meta.log.slice(-2),
      receipt: this.receiptVM(),
      ...(this.updateReady ? { updateReady: true } : {}),
      banner,
      // v5.1 A: never a cover; the turn passes with the one line and the seat ring.
      handoff: null,
      confirm: this.confirm,
      seatActions: this.buildSeatActions(d),
      viewMoved: this.viewMoved,
      nameCard: this.nameCard,
      seed: this.gameSeed(s),
      replay: this.replay,
      holding: this.buildHolding(d),
    };
  }

  /**
   * One gold (docs/INK.md B2.1): the open Cards sheet's trade → the pending commit button → the recommended
   * track segment → the current segment. Never two.
   */
  private buildGold(d: GameState, strip: StripVM, cards: CardsVM | null): GoldVM {
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

  /** The receipt as the UI sees it (no controller bookkeeping); stable while unchanged. */
  private receiptVM(): ReceiptVM | null {
    const r = this.receipt;
    if (!r) return null;
    const { seat: _s, turn: _t, ...vm } = r;
    void _s;
    void _t;
    return vm;
  }

  /** v5 G: a seat's secret mission sentence (null when missions are off, for the neutral seat, or on error). */
  private missionFor(s: GameState, p: PlayerId): string | null {
    try {
      return missionText(s, p) ?? null;
    } catch {
      return null;
    }
  }

  /** Rules sheet, 'This game': this game's rules, or the New game draft's before a game starts. */
  private rulesNotes(): string[] {
    const s = this.state;
    const lines: string[] = [];
    const house = s ? s.config : this.draft.house;
    if (s) {
      const need = territoriesNeeded(s);
      lines.push(need >= mapDefOf(s.config).size ? 'Goal: take every territory.' : `Goal: first to ${need} territories wins.`);
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
    // v5.1 C: each AI seat's standing toward the reader (the driver on a human turn, else the next human).
    const sr = this.meta && !this.autoplayOn ? this.standingReader(d) : null;
    // v5 C2: the reader's grudges: per seat, the territories it took from them, net of the ones taken back.
    const reader = this.meta ? this.grudgeReader(d) : null;
    const ticks = reader !== null ? grudgeTicks(this.story(), reader) : {};
    const said = this.voices.bySeat;
    return d.players.map((p) => ({
      grudgeTicks: p.id === reader ? 0 : (ticks[p.id] ?? 0),
      voiceLine: said[p.id] ?? null,
      ...this.seatExtras(d, p.id),
      ...this.standingFields(d, p.id, sr),
      seat: seatRef(d, p.id),
      current: p.id === d.currentPlayer && d.phase.kind !== 'game-over',
      eliminated: p.eliminated,
      territories: territoryCount(d, p.id),
      armies: mapDefOf(d.config).territoryIds.reduce((n, t) => n + (d.territories[t].owner === p.id ? d.territories[t].armies : 0), 0),
      cards: p.cards.length,
      continents: mapDefOf(d.config).continentIds.filter((c) => mapDefOf(d.config).continents[c].territories.every((t) => d.territories[t].owner === p.id)),
      lostKey: this.lostKeys[p.id] ?? 0,
      out: p.eliminated && this.meta?.out?.[p.id] && d.players[this.meta.out[p.id].by] ? { by: seatRef(d, this.meta.out[p.id].by), round: this.meta.out[p.id].round } : null,
    }));
  }

  /**
   * v3 seat marks: the neutral flag, an AI's personality (v5.1 D: only once it has spoken), its strongest
   * grudge (≥ 2).
   */
  private seatExtras(d: GameState, id: PlayerId): Pick<SeatChipVM, 'neutral' | 'personality' | 'grudge'> {
    const p = d.players[id];
    const out: Pick<SeatChipVM, 'neutral' | 'personality' | 'grudge'> = {};
    if (p.neutral) out.neutral = true;
    if (p.kind === 'ai' && !p.neutral && p.personality) {
      const info = PERSONALITIES[p.personality];
      if (this.meta?.revealed?.includes(id)) out.personality = { name: info.name, line: info.line };
      const top = p.eliminated ? null : grudgesOf(d, id)[0];
      const at = top && top.value >= 2 ? d.players[top.seat] : null;
      if (at && !at.eliminated && !at.neutral) out.grudge = seatRef(d, top!.seat);
    }
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
      else {
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
    const am = this.autoMoved && this.autoMoved.turn === d.turn && this.now() < this.autoMoved.until ? this.autoMoved : null;
    const strip = buildStrip({
      s: d,
      sel,
      interactive,
      narration,
      handoff: null,
      humansOut: this.allHumansOut,
      idleLine: idle,
      rejection: interactive && this.rejection ? { text: this.rejection.text, key: this.rejection.key } : null,
      showWinChance: this.settings.showWinChance,
      lineKey: this.lineKey,
      rolling: this.fightPlaying(),
      boardPreview: this.boardPreview(),
      took,
      tookMoved: am && took === am.to ? am.n : null,
    });
    // v4 A5: after the conquest has played, the auto-move stays said until the driver picks something else.
    if (
      interactive && am && !took && strip.mode === 'attack' && strip.lineKind !== 'rejection' &&
      sel.selected === am.chain && !sel.target && d.territories[am.to].owner === me
    ) {
      strip.line = tookLine(am.to, am.n);
    }
    // The cards sheet's `Trade for +N` is the brass thing while it's open: one brass fill on screen.
    if (this.cardsOpen && interactive && d.phase.kind === 'reinforce' && bestSet(d, me)) {
      strip.buttons = strip.buttons.map((b) => (b.primary ? { ...b, primary: false } : b));
      strip.track = { ...strip.track, primary: false };
    }
    // v5.1 C: no offer line, no Truce word: standing lives on the seat marks and the one gesture.
    const out = strip;
    // v5 E8: desktop hover odds. A source is picked and the pointer rests on an enemy neighbour: the line reads
    // the armed odds before the click, and gives the instruction back when the pointer leaves.
    const hv = this.hoverTile;
    if (
      interactive && hv && !this.touch && out.mode === 'attack' && out.lineKind === 'normal' && sel.selected && !sel.target &&
      d.territories[sel.selected]?.owner === me && !this.fightPlaying() && attackTargets(d, sel.selected).includes(hv)
    ) {
      out.line = attackLine(d, sel.selected, hv, this.settings.showWinChance);
    }
    // v5 F: a clickable's line holds the strip a moment (never over a refused click's reason).
    if (this.flash && this.flash.until > this.now() && out.lineKind !== 'rejection') {
      out.line = this.flash.text;
      // v5.1 C: a standing reason or a peace answer is set in that AI's light tint.
      if (this.flash.seat !== undefined && d.players[this.flash.seat]) out.voice = seatRef(d, this.flash.seat);
    } else if (this.voiceNow && !interactive && out.line === this.voiceNow.text && d.players[this.voiceNow.seat]) {
      // v5 D4: the AI's own voice, set in its light tint.
      out.voice = seatRef(d, this.voiceNow.seat);
    }
    if (this.now() < this.holdUntil && out.buttons.length) {
      out.buttons = out.buttons.map((b) => (b.primary ? { ...b, busy: true } : b));
      this.timer(() => this.invalidate(), this.holdUntil - this.now() + 10);
    }
    return out;
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
      trayRect: this.trayRect,
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
    return mapDefOf(d.config).territoryIds.filter((t) => out.has(t));
  }

  /**
   * The board's highlights: the driver's (or the AI's telegraph), plus v4's loser's rings (A4) and the
   * receipt line's pulse (A3). While the receipt shows, the board offers nothing to click.
   */
  private buildHighlights(): BoardHighlights {
    let base = this.receipt ? {} : this.baseHighlights();
    // v5 F7: a hovered seat ring: its territories lift a shade and the rest rest, while the pointer is there.
    const d = this.disp;
    if (this.hoverSeatId !== null && d && !this.receipt && this.screen === 'game') {
      const theirs = mapDefOf(d.config).territoryIds.filter((t) => d.territories[t].owner === this.hoverSeatId);
      base = { selectable: theirs, dimOthers: true };
    }
    const rings = this.loserRings();
    const pulse = this.pulse.length ? this.pulse : this.tapPulse;
    if (!rings.length && !pulse.length) return base;
    return { ...base, ...(rings.length ? { loserRings: rings } : {}), ...(pulse.length ? { pulse } : {}) };
  }

  /** Territories each human lost since its last turn, still held by someone else, in the loser's colour. */
  private loserRings(): NonNullable<BoardHighlights['loserRings']> {
    const d = this.disp;
    const rings = this.meta?.rings;
    if (!d || !rings || this.screen !== 'game') return [];
    const out: NonNullable<BoardHighlights['loserRings']> = [];
    for (const [k, ts] of Object.entries(rings)) {
      const seat = d.players[Number(k)];
      if (!seat || seat.eliminated) continue;
      for (const t of ts) if (d.territories[t] && d.territories[t].owner !== seat.id) out.push({ territory: t, color: seat.color });
    }
    return out;
  }

  private baseHighlights(): BoardHighlights {
    const s = this.state;
    const d = this.disp;
    if (!s || !d || this.screen !== 'game') return {};
    const interactive = this.interactive() && d.currentPlayer === s.currentPlayer;
    if (!interactive) return this.aiHighlights ?? {};
    const sel = this.viewSel();
    const me = d.currentPlayer;
    const ph = d.phase;
    const own = () => mapDefOf(d.config).territoryIds.filter((t) => d.territories[t].owner === me);
    const picked = sel.selected && d.territories[sel.selected].owner === me ? sel.selected : null;
    switch (ph.kind) {
      case 'setup-claim':
        // A random deal is playing: nothing to claim, so nothing glows.
        if (d.config.setupMode !== 'draft') return {};
        return { selectable: mapDefOf(d.config).territoryIds.filter((t) => d.territories[t].owner === UNCLAIMED) };
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
    this.syncLean(this.leanTarget());
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

  /** v5 G: a game won by a mission headlines with it ('Vermilion holds Asia and Africa'); else null. */
  private missionHeadline(s: GameState): string | null {
    const ph = s.phase as { kind: string; by?: string; mission?: string };
    return ph.kind === 'game-over' && ph.by === 'mission' && typeof ph.mission === 'string' && ph.mission ? ph.mission : null;
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
      // v6 maps: "the world" only on the world boards; a regional or city board is "the board"
      title: this.missionHeadline(s) ?? `${pName(s, winner)} holds ${mapDefOf(s.config).rules === mapDefOf({ mapId: 'classic' }).rules ? 'the world' : 'the board'}`,
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
      // v4 B3 / §7.14: a minute untouched on a human's turn (no input, no events), the table waits.
      if (!this.idleOn && this.screen === 'game' && this.interactive() && this.queue.length === 0 && !this.blockingNow && this.now() - this.lastActive >= IDLE_MS) {
        this.setIdle(true);
      }
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
      this.markActive();
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

  /** Test hook (v4): the receipt showing now. */
  receiptHook(): ReceiptVM | null {
    return this.receiptVM();
  }

  /** Test hooks (v5): the replay (kept after it ends), the holding dab, the voice lines said this game. */
  replayHook(): ReplayVM | null {
    return this.lastReplay;
  }

  holdingHook(): GameVM['holding'] | null {
    return this.getViewModel().game?.holding ?? null;
  }

  voiceLinesHook(): VoiceEntry[] {
    return this.voices.log.map((e) => ({ ...e }));
  }

  /** Test hook (v5.1 C): the seat marks' standings, as the VM shows them. */
  standingHook(): StandingHook[] {
    const g = this.getViewModel().game;
    const d = this.disp;
    if (!g || !d) return [];
    const reader = this.autoplayOn ? null : this.standingReader(d);
    return g.seats.map((c) => ({
      seat: c.seat.id,
      name: c.seat.name,
      kind: c.seat.kind,
      standing: c.standing ?? null,
      reason: c.standingReason ?? null,
      canAskPeace: !!c.canAskPeace,
      understandingWith: [...(c.understandingWith ?? [])],
      personality: c.personality?.name ?? null,
      reader,
    }));
  }

  /** Test hook (v4): the loser's rings on the board now. */
  loserRingsHook(): NonNullable<BoardHighlights['loserRings']> {
    return this.loserRings();
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
    // The one gold thing's label (GameVM.gold), as the HUD draws it.
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
      offer: null,
      receipt: g?.receipt ? { title: g.receipt.title, lines: g.receipt.lines.map((l) => l.text), summary: g.receipt.summary } : null,
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
      const def = mapDefOf(cfg);
      cfg.setupBatch = autoSetupBatch(n, cfg.startingArmies ?? def.startingArmies[n] ?? 30, def.size);
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
        this.sel.occupyCount = s.phase.max;
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
    // v5 F1: open water answers with a ripple (the board draws it); nothing else changes because of it.
    if (this.replay) {
      this.endReplay(true);
      return;
    }
    if ((this.screen === 'game' || this.screen === 'victory') && !this.overlay && !this.confirm) this.cue('ripple');
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
    receipt: () => c.receiptHook(),
    dismissReceipt: () => c.intent({ type: 'dismissReceipt' }),
    loserRings: () => c.loserRingsHook(),
    replay: () => c.replayHook(),
    holding: () => c.holdingHook(),
    voiceLines: () => c.voiceLinesHook(),
    standing: () => c.standingHook(),
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

