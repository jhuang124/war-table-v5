// Contract between the controller (src/game/**) and the HTML UI (src/ui/**).
//
// The controller owns all game logic, timing, and copy: it turns GameState + the event stream into a
// plain-data ViewModel (strings already written, per docs/SIMPLIFY.md) and receives UiIntents back.
// The UI owns layout, styling, and motion: it renders the ViewModel and never imports the engine.
//
// The in-game HUD floats on the board (docs/ROUND2.md): seat chips + ≡ as glass pills at the top, and
// one floating bottom strip: the Turn Track, one line, then the action zone (at most one count control,
// at most two buttons). The dice tray header, one banner, the cards sheet and the menu sheets come and go.

import type { AudioEngine } from '../audio/types';
import type { AiDifficulty, AiPersonality, CardSymbol, ContinentId, PlayerColorId, PlayerId, PlayerKind, PlayerStats, TerritoryId, TimelinePoint } from '../engine/types';
import type { ViewportInsets } from '../render/BoardView';

// ---------------------------------------------------------------------------
// App-level
// ---------------------------------------------------------------------------

export type Screen = 'boot' | 'title' | 'newGame' | 'game' | 'victory';
/** Sheets over the board: the menu (≡ / Esc) and what it opens. */
export type Overlay = 'pause' | 'rules' | 'settings' | 'log' | null;
export type AiSpeed = 'watch' | 'fast' | 'instant';
export type TextSize = 'laptop' | 'couch' | 'tv';

export interface Settings {
  /** Board animation speed for human turns: 1×, 2×, or 0 = instant. */
  animationSpeed: 0 | 1 | 2;
  aiSpeed: AiSpeed;
  textSize: TextSize; // root font scale 1.0 / 1.25 / 1.5
  /** Territory names on every tile (off by default: the hovered and picked tiles show theirs). */
  showLabels: boolean;
  hideCardsBetweenTurns: boolean; // the pass-the-cup cover: default on everywhere since settings v5 (_claude/v3/PLAN.md §2)
  sfxVolume: number; // 0..1
  muted: boolean;
  /** The soft ambient score (docs/INK.md A4). Default on since settings v4. */
  music: boolean;
  /** Additive (ink overhaul): the score's level, 0..1 (default 0.7; the audio engine mixes it under the effects). Always set by the controller (optional only so older fixtures still type-check). */
  musicVolume?: number;
  /**
   * Additive (ink overhaul, docs/INK.md A1): the living board (mist, coastline and wash breath). Default on.
   * The board gets `ambient && !reducedMotion`: reduced motion (the setting or the OS) always stills it.
   */
  ambient?: boolean;
  reduceMotion: boolean; // user setting; effective value is ViewModel.reducedMotion
  showWinChance: boolean; // default true
  autoCamera: boolean; // return home at turn start if displaced, default true
}

export interface SeatRef {
  id: PlayerId;
  name: string;
  /**
   * Emblem via PLAYER_COLORS[color].emblem. The 2-player neutral seat carries 'neutral' here at run time (v3:
   * the controller repaints it; see SeatColorId in src/shared/palette.ts) until PlayerColorId grows the id.
   */
  color: PlayerColorId;
  kind: PlayerKind;
}

// ---------------------------------------------------------------------------
// New game screen
// ---------------------------------------------------------------------------

export type LengthPreset = 'quick' | 'evening' | 'full';
export type SetupPreset = 'quickDeal' | 'placeOwn';

export interface SeatDraft {
  name: string;
  color: PlayerColorId;
  kind: PlayerKind;
  difficulty: AiDifficulty;
  /**
   * Additive (v3): how an AI seat plays (src/engine/ai/personality.ts). The controller fills it for every
   * AI seat, rotating Turtle → Opportunist → Warlord so a fresh table has three different AIs.
   */
  personality?: AiPersonality;
}

export interface HouseRulesDraft {
  draft: boolean; // setupMode 'draft' instead of random deal
  cardBonus: 'progressive' | 'fixed';
  fortifyRule: 'connected' | 'adjacent';
  setupBatch: number | 'auto'; // 'auto' = two passes
  seed: number | null; // null = random
  /** Additive (v3): the 2-player neutral seat ("Neutral armies"). Default on; applies to exactly 2 seats. */
  neutral?: boolean;
  /**
   * Additive (v3): "Truces" — config.diplomacy. Default on; it only switches diplomacy on when the table has
   * at least one human and one AI with a personality.
   */
  truces?: boolean;
  /**
   * Additive (v5 G): "Missions" — config.missions. Default off; applies to 3–4 seats, or 2 with the neutral
   * seat (the engine drops it otherwise).
   */
  missions?: boolean;
}

/** Additive (v3): one map pack in the New game picker (src/map/registry.ts listMaps). */
export interface MapOptionVM {
  id: string;
  name: string;
  /** One plain line. */
  description: string;
  /** '2–4 players'. */
  seats: string;
  /** Preview image URL, or null. */
  thumbnail: string | null;
  /** The table's seat count is outside the map's range. */
  disabled: boolean;
}

/** Additive (v3): an AI personality as the seat picker offers it. */
export interface PersonalityOptionVM {
  id: AiPersonality;
  name: string;
  /** One plain line (the hover title, and the small text under the chosen one). */
  line: string;
}

export interface NewGameVM {
  seats: SeatDraft[]; // 2..4
  length: LengthPreset;
  setup: SetupPreset;
  house: HouseRulesDraft;
  lengthOptions: { id: LengthPreset; label: string; detail: string; estimate: string }[];
  setupOptions: { id: SetupPreset; label: string; detail: string }[];
  /** One line above Start, e.g. 'Territories dealt at random · armies placed for you · first to 30 territories wins'. */
  summary: string;
  canStart: boolean;
  problems: string[]; // e.g. 'Two seats share Cobalt'
  canAddSeat: boolean;
  canRemoveSeat: boolean;
  /** Additive (v3): the map picker, in registry order, and the picked map's id. */
  maps?: MapOptionVM[];
  mapId?: string;
  /** Additive (v3): the three AI personalities (Turtle · Opportunist · Warlord). */
  personalities?: PersonalityOptionVM[];
  /** Additive (v3): the Neutral armies rule applies (exactly 2 seats). */
  neutralApplies?: boolean;
  /** Additive (v3): the Truces rule applies (a human and a personality AI at the table). */
  trucesApply?: boolean;
  /** Additive (v5 G): the Missions rule applies (3–4 seats, or 2 with Neutral armies on). */
  missionsApply?: boolean;
  /**
   * Additive (v5.1 D, HUD builder): the 'More' fold on New game is open (map, difficulty, personalities, setup,
   * house rules). Absent = the UI keeps its own fold state (closed on entry).
   */
  advancedOpen?: boolean;
}

// ---------------------------------------------------------------------------
// In-game HUD (docs/ROUND2.md, docs/SIMPLIFY.md)
// ---------------------------------------------------------------------------

/** One chip per seat in the top strip, in turn order. */
export interface SeatChipVM {
  seat: SeatRef;
  /** Filled in the seat's color. */
  current: boolean;
  /** Struck through and dimmed. */
  eliminated: boolean;
  territories: number;
  /**
   * Additive (v5 C "grudges that last"): territories this seat has taken from the reader this game, net of any
   * taken back: one small tick per territory under the ring (Pillar 4). Absent / 0 = none.
   */
  grudgeTicks?: number;
  /** Additive (v5 D): the one plain line this AI said last ('Sage remembers that'), shown in its light tint. */
  voiceLine?: string | null;
  /**
   * Additive (v5.1 C): this AI seat's standing toward the reader (the current human), for the small ink mark beside
   * its ring: hollow (ally) → filling → solid in the seat's deep tone (hostile). Absent for humans / when unknown.
   */
  standing?: 'ally' | 'even' | 'wary' | 'hostile' | null;
  /** Additive (v5.1 C): the reason, one plain sentence, written in the one line on hover / long-press. */
  standingReason?: string | null;
  /** Additive (v5.1 C): the reader may ask this seat for peace now (a tap offers 'Ask Sage for peace'). */
  canAskPeace?: boolean;
  /** Additive (v5.1 C): AI-to-AI understanding: the seat ids this AI currently holds a truce with (a hairline tie). */
  understandingWith?: PlayerId[];
  /**
   * Additive (ink overhaul, docs/INK.md A5 "your seat ring dims for 300 ms"): bumps each time this seat
   * loses a territory on the displayed board (as the conquest plays), so the UI can re-run the dim. 0 = never.
   */
  lostKey?: number;
  /** Additive (ink overhaul, A5): who knocked this seat out and when, for the empty / cracked ring. */
  out?: { by: SeatRef; round: number } | null;
  /** Additive (v3 table cues): the seat's army total on the displayed board. */
  armies?: number;
  /** Additive (v3): cards in hand (a count only; the hand stays private). */
  cards?: number;
  /** Additive (v3): the continents this seat holds whole, CONTINENT_IDS order. */
  continents?: ContinentId[];
  /**
   * Additive (v3 AI): the 2-player neutral seat. Its ring keeps its territory count; no name underline,
   * never the cup, drawn dimmed.
   */
  neutral?: boolean;
  /** Additive (v3 AI): an AI seat's personality, 'Turtle' / 'Opportunist' / 'Warlord', and its one line. */
  personality?: { name: string; line: string } | null;
  /**
   * Additive (v3 AI): the seat this AI holds its strongest grudge against, when that grudge is ≥ 2 (a short
   * brush tick in that seat's colour under the ring, 'Holds a grudge against Sam'). null = none worth showing.
   */
  grudge?: SeatRef | null;
  /**
   * Additive (v3 diplomacy): the driver is choosing whom to offer a truce, and this seat can take one: its
   * ring is lit and a tap proposes (UiIntent 'proposeTruce').
   */
  truceTarget?: boolean;
}

/**
 * The Turn Track (docs/ROUND2.md §A): one fixed phase control at the left of the bottom strip. Four
 * segments on a main turn (Place · Attack · Fortify · End turn), two in setup (Setup · Done). It never
 * disappears or renames; clicking a forward segment is the only way to change phase (plus the fortify
 * `Move N · end turn` button, which says so).
 */
export type TrackSegId = 'place' | 'attack' | 'fortify' | 'endTurn' | 'setup' | 'done';

export interface TrackSegVM {
  id: TrackSegId;
  /** 'Place' / 'Attack' / 'Fortify' / 'End turn' / 'Setup' / 'Done' (the UI adds the ✓ on done). */
  label: string;
  /**
   * done: passed this turn (inert) · current: where the marker is (filled in the seat's colour) ·
   * eligible: a click goes there · locked: a click puts the reason in the line.
   */
  state: 'done' | 'current' | 'eligible' | 'locked';
}

export interface TrackVM {
  kind: 'turn' | 'setup';
  /** Whose marker: the current segment fills in this seat's colour (an AI's too, while it plays). */
  seat: SeatRef;
  segments: TrackSegVM[];
  /** The recommended next segment: its brass edge glows. Enter goes there when no button is brass. */
  recommended: TrackSegId | null;
  /** The recommended segment is the one brass fill on screen (no commit is pending in the action zone). */
  primary: boolean;
  /** The driver can click it (their own turn, no cover). False = a marker to watch. */
  live: boolean;
  /** Visibly disabled: a roll is playing, or a mandatory occupy / trade holds the turn. */
  disabled: boolean;
  /** Bumps when the turn passes to another seat, so the UI can re-seat the fill instead of sliding it back. */
  turnKey: string;
}

export type ButtonId =
  | 'place' // 'Place 9'
  | 'undo'
  | 'trade' // forced: 'Trade cards +8' (the only action); otherwise from the Cards sheet
  | 'cards' // 'Cards 3': opens the read-only hand sheet
  | 'blitz'
  | 'roll'
  | 'move' // 'Move 8' (occupy) / 'Move 5 · end turn' (fortify)
  | 'watchAis' // all humans out: 'Watch to the end'
  | 'callGame' // all humans out: 'End game'
  // Additive (v3 diplomacy):
  | 'truce' // 'Truce': the secondary word in Attack; lights the seats a truce can be offered to
  | 'acceptTruce' // 'Accept': a pending offer to the driver (the gold, in its brush ring)
  | 'declineTruce'; // 'Decline': bare

export interface ButtonVM {
  id: ButtonId;
  label: string; // exact copy
  /** Brass fill. At most one brass thing on screen: this, or the track's recommended segment. */
  primary: boolean;
  /** A short hold (a knockout, the game ending): a brass underline sweeps and clicks are ignored. */
  busy?: boolean;
}

/** The one count control: a − N + stepper for ≤ 6 options, a slider for more. */
export interface CountVM {
  control: 'stepper' | 'slider';
  value: number;
  min: number;
  max: number;
  /**
   * Additive (v5.1 E2, HUD builder): the default is already chosen (occupy moves all but one): the HUD shows the
   * primary (`Move N`) and the number as a bare word, and the stepper / slider only once the number is touched.
   */
  collapsed?: boolean;
}

export interface StripVM {
  mode: 'setup' | 'place' | 'attack' | 'occupy' | 'fortify' | 'watching' | 'idle';
  /** Left end: the Turn Track. */
  track: TrackVM;
  /** 3 px top edge. */
  accent: PlayerColorId;
  /**
   * The one line: ≤ ~50 characters, real names and numbers. v4 (sitting 2026-10-03 Q4): the single current
   * sentence above the rule, the only line the HUD shows (no transcript). An AI engagement writes
   * 'Sage attacks Ural…' and then completes it in place ('… and takes it' / '… and is thrown back').
   */
  line: string;
  /** 'rejection' while a refused-click reason is swapped in (2 s); 'narration' during AI turns. */
  lineKind: 'normal' | 'rejection' | 'narration';
  /** Bumps on every rejection so the UI can re-run the swap even for identical copy. */
  lineKey: number;
  count: CountVM | null;
  /** The action zone (right end): ≤ 2, in reading order: the secondary (if any), then the primary. */
  buttons: ButtonVM[];
  /**
   * Additive (v4, PLAN §3 A5): a truce offer waiting for the driver's answer. It never takes the line, the
   * count or the buttons (Place N stays the one gold): it is a secondary line under the main one, with
   * 'Accept' and 'Decline' as small words (ButtonVM, never primary; the HUD sends them as 'button' intents).
   * text: 'Sage proposes a truce with John · 3 rounds · you share a border in Asia'. null / absent = none.
   */
  offer?: { text: string; buttons: ButtonVM[] } | null;
  /**
   * Additive (v5 D): the line is an AI seat's own voice ('Sage remembers that'), set in that seat's light tint.
   * lineKind stays 'narration'. null / absent = an ordinary line.
   */
  voice?: SeatRef | null;
}

export interface BattleSideVM {
  seat: SeatRef;
  territory: string; // display name
  armies: number; // displayed (follows the board, not the state)
}

/**
 * The dice tray's header line, 'URAL 12  vs  SIBERIA 5'. The dice are drawn by the renderer. It lives
 * while a fight is armed or rolling and ~1 s after it's decided (null at once on a new selection or a
 * phase change); on a conquest it reads `captured` ('Siberia captured') for that second.
 */
export interface BattleVM {
  attacker: BattleSideVM;
  defender: BattleSideVM;
  rolling: boolean;
  captured: string | null;
  /**
   * Additive (mobile pass): the board's dice tray is on screen (BoardView.onTrayChange). Phones show the
   * header only with the tray (an armed fight's header alone would float mid-board).
   */
  tray?: boolean;
  /** Additive (v4): the tray's box in container px when it sits beside the fight (desktop); absent = the band. */
  trayRect?: { x: number; y: number; w: number; h: number; /** Additive (v5 A): the side the header rides. */ header?: 'above' | 'below' } | null;
}

export interface CardVM {
  id: number;
  symbol: CardSymbol;
  territory: string | null; // display name, null for wild
  /** You own the pictured territory: trading it puts +2 there. */
  ownedBonus: boolean;
  /** Part of the best set (the one a trade uses). */
  inSet: boolean;
}

/** The read-only hand sheet behind `Cards N`. */
export interface CardsVM {
  open: boolean;
  hand: CardVM[];
  /** 'Set ready · +8' / 'Need 1 artillery, or a third match'. */
  status: string;
  /** 'Trade for +8' when a trade is allowed right now; null otherwise. */
  trade: { label: string } | null;
}

export interface LogLineVM {
  id: number;
  round: number;
  seat: SeatRef | null;
  /** 'truce' (v3, additive): a diplomacy event's sentence (truceSentence). */
  kind: 'engagement' | 'turn' | 'recap' | 'card' | 'continent' | 'elimination' | 'system' | 'truce';
  text: string; // 'Vermilion took Brazil from Ochre · 4 vs 1 · lost 0'
  /**
   * Additive (v4, PLAN §3 A5): the line's detail for the Ledger, kept out of the line itself. An
   * engagement's origin territory: 'from Venezuela'. Absent = none.
   */
  detail?: string;
}

/** The one banner slot (docs/SIMPLIFY.md §5). */
export interface BannerVM {
  /**
   * Additive (ink overhaul, docs/INK.md B2.6/A5): the one serif line to brush onto the paper, plain case.
   * turn: 'John · 3 armies' ('John' on a resumed mid-turn) · continent: 'John holds Asia · +7' ·
   * elimination (the epitaph): 'Sam · taken by John · round 9'. `title`/`sub` stay for older HUDs.
   * The turn's grudge line is `recap` ('John took Ural and Siberia from you'), shown under it.
   */
  line?: string;
  id: number;
  kind: 'turn' | 'continent' | 'elimination';
  /** "JOHN'S TURN" / 'JOHN HOLDS ASIA · +7' / 'SAM IS OUT'. */
  title: string;
  /** Turn banner: '+9 armies' ('' on a resumed mid-turn). Others: ''. */
  sub: string;
  /**
   * Turn banner for a human seat from round 2, only if it lost territory since its last turn — the grudge
   * line (docs/INK.md A5): 'John took Ural and Siberia from you' · 'John took Ural, Sam took Peru' ·
   * 'John took 4 of yours'. ≤ ~60 characters.
   */
  recap: string | null;
  seat: SeatRef | null;
  /** Hold time in ms; the controller removes the banner after it. The UI animates in and out. */
  holdMs: number;
}

/**
 * Additive (ink overhaul, docs/INK.md B2.1 "one gold"): the single element on screen that carries gold.
 * Precedence: the Cards sheet's trade (while open) → the pending commit button (the strip's primary) →
 * the recommended Turn Track segment → the current segment (a live human turn, or the marker an AI moves).
 * The hand-off cover is its own gold ring. null = nothing gold (game over, setup deal). The UI must draw
 * gold on this one element only; `ButtonVM.primary` / `TrackVM.primary` agree with it.
 */
export type GoldVM =
  | { kind: 'button'; id: ButtonId }
  | { kind: 'segment'; seg: TrackSegId }
  | { kind: 'cardsTrade' }
  | { kind: 'handoff' }
  | null;

export interface GameVM {
  seats: SeatChipVM[];
  strip: StripVM;
  battle: BattleVM | null;
  /** null = not your Place step (or the hand-off cover is up). */
  cards: CardsVM | null;
  /** Oldest first; the Log sheet shows it newest first. */
  log: LogLineVM[];
  /** Additive (v3, PLAN §3): the round on the displayed board ("Round 6" in the dock). */
  round?: number;
  /**
   * Additive (v3, PLAN §3): the ledger's last lines, oldest first. v4 (sitting 2026-10-03, Q4 "one line"):
   * the HUD shows ONE line above the rule, `StripVM.line`; the faded history goes. These last two lines
   * stay only for the HUD's own use (e.g. what to show when the strip is hidden); never as a transcript.
   */
  events?: LogLineVM[];
  /**
   * Additive (v3): a new build has taken over (the service worker's controllerchange) while a game is on.
   * The event line reads 'Update ready · reload' instead of the ledger; a tap sends 'reloadForUpdate'.
   */
  updateReady?: boolean;
  banner: BannerVM | null;
  /**
   * 'Pass to Sam' cover. `mission` (additive, v5 G): the seat's secret mission as one plain line under the armies
   * line ('Hold Asia and Africa'), shown only on this cover. Absent / null = none.
   */
  handoff: { seat: SeatRef; subline: string; mission?: string | null } | null;
  confirm: { kind: 'endGame' | 'restart'; text: string } | null;
  /** Settings → Seats: hand a human seat to the AI (and back). Empty when there's nothing to offer. */
  seatActions: { seat: SeatRef; label: string; intent: UiIntent }[];
  /** The player orbited / zoomed away from the home view: the `Reset view` pill shows beside ≡. */
  viewMoved: boolean;
  /** Additive (ink overhaul): the one gold element (see GoldVM). */
  gold?: GoldVM;
  /**
   * Additive (ink overhaul, docs/INK.md B3 "the ensō"): the game's seed (state.config.seed). The UI draws
   * the game's own ensō from it (the gold rule, the menu mark). Absent = the UI hashes the seats instead.
   */
  seed?: number;
  /**
   * Additive (mobile pass, docs/MOBILE.md §3): the long-press name card on touch, shown above the finger
   * while it is held (hover doesn't exist on touch). null / absent = none.
   */
  nameCard?: NameCardVM | null;
  /**
   * Additive (v4, PLAN §3 A3; sitting 2026-10-03: the receipt is THE channel for bot turns): the
   * "While you were away" sheet, shown when a human gets the cup back after one or more AI turns. null /
   * absent = none. The UI writes the lines one at a time (≈ 600 ms apart) and sends 'receiptLine' as each
   * begins so the board can pulse its territories; any tap sends 'dismissReceipt'.
   */
  receipt?: ReceiptVM | null;
  /**
   * Additive (v5 C "the war in ink"): on victory, before the recap, the board replays the game as a time-lapse.
   * The UI drives the board through `__risk`/controller (`replayRound` intents) and shows one ledger sentence per
   * round; any tap sends 'skipReplay'. null / absent = none.
   */
  replay?: ReplayVM | null;
  /**
   * Additive (v5 E "the turn ritual"): the current human's reinforcements as a thing to spend: a holding dab
   * beside the seat mark with `armies` stones that empties as they are placed; `breakdown` writes under the turn
   * line for a second ('3 territories · Asia +4'). null / absent = none.
   */
  holding?: { seat: SeatRef; armies: number; breakdown: string } | null;
}

/** v5: the end-of-game time-lapse. */
export interface ReplayVM {
  key: number;
  winner: SeatRef;
  /** One frame per round, oldest first: who held what at the round's end, and the round's one sentence. */
  rounds: { round: number; owners: Partial<Record<TerritoryId, PlayerColorId | 'neutral'>>; line: string }[];
  /** The three named turning points for the recap ('Round 6: Siberia changed hands three times'). */
  moments: string[];
  /** ms per round at 1× (the whole replay ≈ 15–20 s). */
  msPerRound: number;
}

/**
 * Additive (v4 PLAN §7.13): the board as it was left, for the title's Continue thumbnail (a tiny ink sketch:
 * territory tints only). The UI draws it from the map's own geometry. Absent / null = no thumbnail.
 */
export interface SaveSketchVM {
  /** The saved game's map pack (GameConfig.mapId); absent = classic. */
  mapId?: string;
  /** Each held territory's owner colour (the neutral seat's 'neutral' allowed, as on SeatRef). */
  owners: Partial<Record<TerritoryId, PlayerColorId>>;
}

/** The "While you were away" receipt (v4). One line per AI seat that acted, in turn order. */
export interface ReceiptVM {
  /** Bumps per receipt; the UI restarts its writing when it changes. */
  key: number;
  /** 'While you were away' · 'Since your last turn' on a resumed game. */
  title: string;
  lines: ReceiptLineVM[];
  /** The one line about the reader, if any: 'You lost 5 territories · you hold 7' (plain, numbered). */
  summary: string | null;
}

export interface ReceiptLineVM {
  seat: SeatRef;
  /** 'Ochre took Brazil, Peru and Argentina from you · now 15 territories, 41 armies'. ≤ ~90 characters. */
  text: string;
  /** The territories this line is about, pulsed on the board as it writes. */
  territories: TerritoryId[];
  /** true when the reader lost something in this line: the line is set in the seat's pigment, not ivory. */
  stings: boolean;
}

/** The long-press name card: territory, continent + bonus, owner, armies; anchored at the finger. */
export interface NameCardVM {
  territory: string; // 'Siberia'
  continent: string; // 'Asia'
  bonus: number; // the continent's bonus, 7
  owner: SeatRef | null;
  armies: number;
  /** Client px of the finger. */
  x: number;
  y: number;
  /** Bumps on every new press. */
  key: number;
  /**
   * Additive (v5 F5 "long-press a stone"): the stone's history line, shown as the card's second row
   * ('Ural · 19 · held since round 3 · taken from Sage'). Set in answer to a 'stoneHistory' intent. Absent = none.
   */
  history?: string | null;
}

// ---------------------------------------------------------------------------
// Victory
// ---------------------------------------------------------------------------

export interface VictoryVM {
  winner: SeatRef;
  /** Plain case since the ink overhaul: 'John holds the world'. */
  title: string;
  /** 'Round 14 · 31 territories' / 'Round 20 of 20 · 24 territories' / 'Called in round 14 · 22 territories'. */
  subline: string;
  awards: { id: 'nemesis' | 'hotDice' | 'cursedDice' | 'cashIn'; title: string; text: string; seat: SeatRef }[];
  seats: SeatRef[];
  timeline: TimelinePoint[];
  standings: { seat: SeatRef; place: number; territories: number; stats: PlayerStats }[];
  /** Additive (ink overhaul): the game's seed (state.config.seed), so the scroll's ensō is the one drawn all game. */
  seed?: number;
  /**
   * Additive (v5 C "turning points"): the game's three named moments for the recap, plain sentences
   * ('Round 6: Siberia changed hands three times'). Absent = the UI uses the last `ReplayVM.moments` it saw.
   */
  moments?: string[];
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export interface ViewModel {
  screen: Screen;
  overlay: Overlay;
  settings: Settings;
  /** settings.reduceMotion || prefers-reduced-motion. */
  reducedMotion: boolean;
  /** Continue button: null = no save. */
  save: { summary: string; sketch?: SaveSketchVM | null } | null; // 'Round 7 · John vs Sam + 2 AI'
  newGame: NewGameVM;
  game: GameVM | null;
  victory: VictoryVM | null;
  /** Rules sheet, 'This game': the goal, the round limit, card sets, the fortify rule. */
  rulesNotes: string[];
  /** Additive (mobile pass): the board's WebGL context is lost and rebuilding (a quiet `Reloading the board…`). */
  boardLost?: boolean;
}

export type UiIntent =
  // navigation
  | { type: 'nav'; screen: 'title' | 'newGame' }
  | { type: 'overlay'; overlay: Overlay }
  | { type: 'continue' }
  // new game
  | { type: 'seat'; index: number; patch: Partial<SeatDraft> }
  | { type: 'addSeat' }
  | { type: 'removeSeat'; index: number }
  | { type: 'length'; value: LengthPreset }
  | { type: 'setup'; value: SetupPreset }
  | { type: 'house'; patch: Partial<HouseRulesDraft> }
  /** Additive (v3): pick a map pack. */
  | { type: 'map'; id: string }
  /** Additive (v5.1 D, HUD builder): the 'More' word on New game folds the rest open / shut. */
  | { type: 'more'; open: boolean }
  | { type: 'start' }
  // in game
  | { type: 'button'; id: ButtonId }
  /** A Turn Track segment: forward + eligible = go there; locked = the reason in the line. */
  | { type: 'track'; seg: TrackSegId }
  /** The `Reset view` pill: back to the home framing. */
  | { type: 'resetView' }
  | { type: 'setCount'; value: number }
  | { type: 'cardsPanel'; open: boolean }
  | { type: 'handoffAccept' }
  | { type: 'dismissTurnBanner' }
  | { type: 'endGameNow' } // opens the confirm
  | { type: 'restart' } // opens the confirm
  | { type: 'confirm'; yes: boolean }
  | { type: 'saveAndQuit' }
  /** Hand a seat to the AI or back, applied at the next safe point. */
  | { type: 'setController'; player: PlayerId; kind: PlayerKind; difficulty?: AiDifficulty }
  /** Additive (v3 diplomacy): offer `to` a 3-round no-attack truce (a lit seat ring was tapped). */
  | { type: 'proposeTruce'; to: PlayerId }
  /** Additive (v3): the event line's 'Update ready · reload': save and reload onto the new build. */
  | { type: 'reloadForUpdate' }
  /** v4 receipt: line `index` began writing (the board pulses its territories) · any tap dismisses. */
  | { type: 'receiptLine'; index: number }
  | { type: 'dismissReceipt' }
  /** v5 replay: the UI reached round `index` of GameVM.replay (the board re-soaks to it) · any tap skips. */
  | { type: 'replayRound'; index: number }
  | { type: 'skipReplay' }
  /** v5 clickables (board-native, tier 0, never required). */
  | { type: 'tapContinent'; id: ContinentId }
  | { type: 'tapCup' }
  | { type: 'tapEnso' }
  | { type: 'tapLane'; from: TerritoryId; to: TerritoryId }
  | { type: 'hoverSeat'; player: PlayerId | null }
  | { type: 'stoneHistory'; territory: TerritoryId | null }
  /** v5.1 standing: hover / long-press a seat ring for its reason (null on leave); tap → 'Ask X for peace' offered; confirm. */
  | { type: 'seatStanding'; player: PlayerId | null }
  | { type: 'askPeace'; to: PlayerId }
  /**
   * Additive (v5 G): long-press of a seat mark. For the seat whose turn it is (a live human turn, no cover), its
   * secret mission writes on the line for a moment; for anyone else nothing (missions are secret). null = released.
   */
  | { type: 'seatMission'; player: PlayerId | null }
  // victory
  | { type: 'rematch' }
  // settings
  | { type: 'setting'; patch: Partial<Settings> };

/** What the controller hands the UI. Created in src/main.ts. */
export interface ControllerApi {
  getViewModel(): ViewModel;
  /** Called with a fresh ViewModel at most once per animation frame. Unchanged subtrees keep identity. */
  subscribe(fn: (vm: ViewModel) => void): () => void;
  intent(i: UiIntent): void;
  /** The UI reports HUD-covered edges on resize and text-size change (top strip, bottom strip, tray band). */
  setViewportInsets(insets: ViewportInsets): void;
  /** For button/UI sounds: 'uiClick', 'uiHover' (throttled), 'uiError'. */
  audio: AudioEngine;
}

/** The UI's entry point, implemented in src/ui/index.ts. */
export type MountUi = (root: HTMLElement, api: ControllerApi) => { dispose(): void };
