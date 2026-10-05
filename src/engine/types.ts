// THE CONTRACT. Every module (engine, AI, renderer, UI) builds against these shapes.
// Changing a shape here means updating docs/SPEC.md and every consumer. Additive,
// optional fields are fine; renames and removals are not.

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/** v6 maps: any pack's continent id (docs/MAPS.md). Classic: north_america, south_america, europe, africa, asia, australia. */
export type ContinentId = string;

/** v6 maps: any pack's territory id (maps/<id>/rules.json). Classic's 42 are in maps/classic/rules.json. */
export type TerritoryId = string

/** Seat index, 0..players.length-1. */
export type PlayerId = number;

/** Owner value for an unclaimed territory (only during draft setup). */
export const UNCLAIMED = -1;

/** The six a seat picks, plus (v3, additive) 'neutral': the 2-player neutral seat's grey, never a config colour. */
export type PlayerColorId = 'crimson' | 'cobalt' | 'emerald' | 'amber' | 'violet' | 'rose' | 'neutral';

export type PlayerKind = 'human' | 'ai';
export type AiDifficulty = 'easy' | 'normal' | 'hard';
/**
 * How an AI seat plays, on top of its difficulty (additive, optional). Unset = the classic AI, exactly as
 * before: no grudges in its choices, no truces. See `PERSONALITIES` in src/engine/ai/personality.ts.
 */
export type AiPersonality = 'turtle' | 'opportunist' | 'warlord';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface PlayerConfig {
  name: string;
  color: PlayerColorId;
  kind: PlayerKind;
  /** Required when kind === 'ai'. */
  difficulty?: AiDifficulty;
  /** AI seats only (additive): how this seat plays. Unset = the classic AI. */
  personality?: AiPersonality;
}

export interface GameConfig {
  /** 2..4 players, seat order = turn order before the random first-player pick. */
  players: PlayerConfig[];
  /** 'random': territories dealt evenly at random. 'draft': players claim one at a time. */
  setupMode: 'random' | 'draft';
  /** 'manual': players place remaining starting armies in batches. 'auto': engine places them. */
  initialPlacement: 'manual' | 'auto';
  /** Additive (v5 G): secret missions house rule. One mission per seat, dealt at setup (src/engine/missions.ts). */
  missions?: boolean;
  /** Armies placed per setup-place turn (last batch may be smaller). Default 5. */
  setupBatch: number;
  /** Override starting armies per player. Default: from the map's rules (classic: 2p 40, 3p 35, 4p 30). */
  startingArmies?: number;
  /** Card set values. 'progressive': 4,6,8,10,12,15,+5... 'fixed': inf 4, cav 6, art 8, mixed 10. */
  cardBonus: 'progressive' | 'fixed';
  /** Fortify along any chain of your own territories, or only to an adjacent one. */
  fortifyRule: 'connected' | 'adjacent';
  /** Territories needed to win, as a percent of the map's territories (targetTerritories). 100 = world domination (default). */
  dominationPercent: number;
  /** End the game after this many full rounds (most territories, then most armies, wins). null = off. */
  turnLimit: number | null;
  /** Seed for the game's PRNG. Same seed + same actions = same game. */
  seed: number;
  /**
   * Additive: humans may propose and answer truces. Off (default) = truces run only between AI seats
   * with a personality, and AIs never offer one to a human.
   */
  diplomacy?: boolean;
  /**
   * Additive: with exactly 2 players, deal a third, neutral seat (classic 2-player house rule). It holds
   * a third of the board, never takes a turn, never attacks, and defends normally. Ignored for 3–4 players.
   */
  neutral?: boolean;
  /**
   * Optional (additive, v3 map packs): which map pack this game is played on (`maps/<id>/`, see
   * docs/MAPS.md and src/map/registry.ts). Absent = 'classic', so every save written before map packs
   * loads the classic board. Today every playable pack shares the classic rules and topology, so the
   * engine's rules are unchanged by this field; the renderer picks the pack's geometry from it.
   */
  mapId?: string;
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

export type CardSymbol = 'infantry' | 'cavalry' | 'artillery' | 'wild';

export interface Card {
  /** 0..43, stable across the game. */
  id: number;
  /** null for the two wild cards. */
  territory: TerritoryId | null;
  symbol: CardSymbol;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface TerritoryState {
  /** PlayerId, or UNCLAIMED (-1) during draft setup. */
  owner: PlayerId;
  armies: number;
}

export interface PlayerStats {
  territoriesConquered: number;
  battlesWon: number; // dice rolls where the defender lost more armies than the attacker
  battlesLost: number;
  armiesDestroyed: number; // enemy armies this player killed
  armiesLost: number;
  cardsTraded: number; // sets traded
  reinforcementsReceived: number;
  peakTerritories: number;
}

export interface PlayerState {
  id: PlayerId;
  name: string;
  color: PlayerColorId;
  kind: PlayerKind;
  /** Additive (v5 G): this seat's secret mission id (config.missions), see src/engine/missions.ts. */
  mission?: string;
  difficulty?: AiDifficulty;
  cards: Card[];
  eliminated: boolean;
  eliminatedBy?: PlayerId;
  eliminatedOnTurn?: number;
  /** Starting armies still to place during setup. 0 once setup is done. */
  setupArmies: number;
  stats: PlayerStats;
  /** Additive: AI personality (see AiPersonality). */
  personality?: AiPersonality;
  /** Additive: the neutral seat of a 2-player game. Never takes a turn, never wins, holds no cards. */
  neutral?: boolean;
  /**
   * Additive, read-only for the UI: how much this seat wants payback, by seat. Rises when a seat takes
   * its territories, breaks a truce with it, or eliminates a seat it had a truce with; decays each round.
   * Absent until the first grudge. Every seat keeps one (humans too); only personality AIs act on it.
   */
  grudges?: Partial<Record<PlayerId, number>>;
  /** Additive: truces this seat has broken this game. Costs standing with every AI. */
  truceBreaks?: number;
  /**
   * Additive (v5.1 standing): the last territory each seat took from this one, and the round it fell. Feeds
   * `standingReason` ('you took Ural last round') and the AI's 'prefers its ally's attacker'. Absent until the
   * first loss.
   */
  lastTakenBy?: Partial<Record<PlayerId, { territory: TerritoryId; round: number }>>;
}

export type Phase =
  /** Draft setup: current player claims one unclaimed territory. */
  | { kind: 'setup-claim' }
  /** Current player must place `toPlace` more armies on their own territories this setup turn. */
  | { kind: 'setup-place'; toPlace: number }
  /**
   * Reinforce. `remaining` armies still to place. `mustTrade` = holding 5+ cards, trade first.
   * `placed` tracks armies placed this phase per territory, so they can be taken back (unreinforce).
   * `midTurn` = a forced trade after eliminating a player; ending it returns to 'attack'.
   * The phase does NOT auto-advance at remaining 0; the player sends `endReinforce`.
   */
  | {
      kind: 'reinforce';
      remaining: number;
      mustTrade: boolean;
      placed: Partial<Record<TerritoryId, number>>;
      midTurn: boolean;
    }
  | { kind: 'attack' }
  /** A territory was just conquered. Move between `min` and `max` armies from `from` into `to`. */
  | {
      kind: 'occupy';
      from: TerritoryId;
      to: TerritoryId;
      min: number;
      max: number;
      /** Engine bookkeeping (additive): who owned `to` before the conquest, for continent diffing. */
      previousOwner?: PlayerId;
    }
  | { kind: 'fortify' }
  | {
      kind: 'game-over';
      winner: PlayerId;
      reason: 'domination' | 'percent' | 'turnLimit';
      /**
       * Additive (v5 G): 'mission' when the winner met their secret mission (reason is then 'percent', a
       * goal short of the world, so a v4 reader still sees a board win). Absent for every other win.
       */
      by?: 'mission';
      /** Additive (v5 G): with by 'mission', the headline sentence: 'Vermilion holds Asia and Africa'. */
      mission?: string;
    };

export type PhaseKind = Phase['kind'];

// ---------------------------------------------------------------------------
// Diplomacy (additive)
// ---------------------------------------------------------------------------

export type TruceKind = 'noAttack';

/** A truce offer: `from` proposes to `to` that neither attacks the other for `rounds` rounds. */
export interface TruceProposal {
  from: PlayerId;
  to: PlayerId;
  rounds: number;
  kind: TruceKind;
}

/** An agreed truce. It holds from round `since` until round `until` starts (then truceExpired). */
export interface Truce extends TruceProposal {
  since: number;
  until: number;
  /**
   * Additive (v5.1): peace a human asked for (`askPeace`). Pins the AI's standing to ally while it holds;
   * attacking through it is `peaceBroken`. A truce without it between two AIs is an "understanding".
   * (A pre-v5.1 truce with a human in it is read as peace too.)
   */
  peace?: boolean;
}

/** A proposal waiting for a human's answer (only with config.diplomacy). Lapses when `to`'s next turn ends. */
export interface TruceOffer extends TruceProposal {
  /** Turn number the offer was made on. */
  turn: number;
}

export interface DiplomacyState {
  truces: Truce[];
  offers: TruceOffer[];
  /** Last turn number each seat proposed on (one proposal per turn). */
  proposedOn: Partial<Record<PlayerId, number>>;
  /** Recent refusals, so an AI doesn't ask the same seat every turn. Pruned after a few rounds. */
  rebuffs: { from: PlayerId; to: PlayerId; round: number }[];
  /** Additive (v5.1): broken peace. `against` is hostile to `by` for the rest of the game. */
  broken?: { by: PlayerId; against: PlayerId; round: number }[];
  /** Additive (v5.1): the round `human` last asked `ai` for peace, keyed `${human}>${ai}` (once per three rounds). */
  asked?: Partial<Record<string, number>>;
  /**
   * Additive (v5.1): each AI's standing band toward each seat as of the last turn boundary, keyed `${ai}>${toward}`,
   * so `standingChanged` fires only on a change. Engine bookkeeping; read standing with `standingOf`.
   */
  standings?: Partial<Record<string, 'ally' | 'even' | 'wary' | 'hostile'>>;
  /** Additive (v5.1): Warlord pairs `${ai}>${toward}` that have been hostile; that Warlord never returns to ally (peace clears it). */
  hardened?: string[];
}

/** One sample per round start, for the end-of-game chart. */
export interface TimelinePoint {
  round: number;
  territories: number[]; // indexed by PlayerId
  armies: number[];
}

export interface GameState {
  version: 1;
  /** Random id, e.g. 'g_k2j4h1'. */
  id: string;
  config: GameConfig;
  players: PlayerState[];
  territories: Record<TerritoryId, TerritoryState>;
  currentPlayer: PlayerId;
  /** Player who took the first turn; a round ends when play returns to them. */
  firstPlayer: PlayerId;
  /** Increments every time a player's main turn starts. 0 during setup. */
  turn: number;
  /** 1-based round number once main play starts. 0 during setup. */
  round: number;
  phase: Phase;
  /** Draw pile, top = last element. */
  deck: Card[];
  discard: Card[];
  /** Number of sets traded so far (all players), drives progressive values. */
  tradeCount: number;
  /** Current player conquered at least one territory this turn (earns a card at turn end). */
  conqueredThisTurn: boolean;
  /** PRNG state (uint32). Only the engine advances it. */
  rng: number;
  timeline: TimelinePoint[];
  /** Additive: truces and offers. Absent until the first proposal. */
  diplomacy?: DiplomacyState;
}

// ---------------------------------------------------------------------------
// Actions (every action names the acting player; the engine rejects out-of-turn actions)
// ---------------------------------------------------------------------------

export type Action =
  | { type: 'claim'; player: PlayerId; territory: TerritoryId }
  | { type: 'placeSetup'; player: PlayerId; territory: TerritoryId; count: number }
  | { type: 'trade'; player: PlayerId; cardIds: [number, number, number] }
  | { type: 'reinforce'; player: PlayerId; territory: TerritoryId; count: number }
  | { type: 'unreinforce'; player: PlayerId; territory: TerritoryId; count: number }
  | { type: 'endReinforce'; player: PlayerId }
  | { type: 'attack'; player: PlayerId; from: TerritoryId; to: TerritoryId; dice: 1 | 2 | 3 }
  /** Roll repeatedly (max dice) until `to` falls or `from` drops to `stopAt` armies (default 1, min 1). */
  | { type: 'blitz'; player: PlayerId; from: TerritoryId; to: TerritoryId; stopAt?: number }
  | { type: 'occupy'; player: PlayerId; count: number }
  | { type: 'endAttack'; player: PlayerId }
  /** One fortify per turn; performing it ends the turn. */
  | { type: 'fortify'; player: PlayerId; from: TerritoryId; to: TerritoryId; count: number }
  /** Ends the turn from 'attack' or 'fortify' (skips fortifying). */
  | { type: 'endTurn'; player: PlayerId }
  /** Hand a seat to the AI or back to a human (e.g. a friend leaves). Allowed any time, any player. */
  | { type: 'setController'; player: PlayerId; kind: PlayerKind; difficulty?: AiDifficulty; personality?: AiPersonality }
  /**
   * Additive. The current player offers `to` a truce (main turn, one offer per turn). An AI with a
   * personality answers at once; a human answers with `answerTruce` (needs config.diplomacy).
   */
  | { type: 'proposeTruce'; player: PlayerId; to: PlayerId; rounds: number; kind: TruceKind }
  /** Additive. A human answers a pending offer from `from`. Allowed out of turn. */
  | { type: 'answerTruce'; player: PlayerId; from: PlayerId; accept: boolean }
  /**
   * v5.1 (standing): a human asks an AI for peace on its main turn. The engine answers at once from the AI's
   * standing (event `peaceAnswered`); agreed peace pins standing to ally for `rounds`; attacking during it is
   * `peaceBroken` and drops the breaker to hostile for the rest of the game.
   */
  | { type: 'askPeace'; player: PlayerId; to: PlayerId };

export type ActionType = Action['type'];

// ---------------------------------------------------------------------------
// Events — what happened, in order. The renderer animates these one at a time.
// ---------------------------------------------------------------------------

export interface ReinforcementBreakdown {
  territoryCount: number;
  base: number; // max(3, floor(territoryCount / 3))
  continents: { continent: ContinentId; bonus: number }[];
  total: number; // base + continent bonuses (card trades are separate events)
}

export type GameEvent =
  | { type: 'gameStarted'; firstPlayer: PlayerId }
  | { type: 'territoriesDealt'; owners: Record<TerritoryId, PlayerId> }
  | { type: 'territoryClaimed'; player: PlayerId; territory: TerritoryId }
  | {
      type: 'armiesPlaced';
      player: PlayerId;
      territory: TerritoryId;
      count: number; // negative for unreinforce
      source: 'setup' | 'reinforce' | 'cardBonus' | 'undo';
    }
  | { type: 'setupTurn'; player: PlayerId; toPlace: number }
  | {
      type: 'turnStarted';
      player: PlayerId;
      turn: number;
      round: number;
      reinforcements: ReinforcementBreakdown;
    }
  | { type: 'phaseChanged'; player: PlayerId; phase: PhaseKind }
  | {
      type: 'cardsTraded';
      player: PlayerId;
      cards: Card[];
      armies: number;
      bonusTerritory: TerritoryId | null; // +2 placed here (a traded card's territory you own)
      tradeIndex: number; // 1-based count of sets traded so far
    }
  | {
      type: 'diceRolled';
      player: PlayerId;
      defender: PlayerId;
      from: TerritoryId;
      to: TerritoryId;
      attackDice: number[]; // sorted high → low
      defendDice: number[]; // sorted high → low
      attackerLosses: number;
      defenderLosses: number;
      blitz: boolean;
    }
  | { type: 'territoryConquered'; player: PlayerId; from: TerritoryId; to: TerritoryId; previousOwner: PlayerId }
  | {
      type: 'armiesMoved';
      player: PlayerId;
      from: TerritoryId;
      to: TerritoryId;
      count: number;
      reason: 'occupy' | 'fortify';
      path?: TerritoryId[]; // fortify: the owned chain from → to (inclusive)
    }
  | { type: 'continentGained'; player: PlayerId; continent: ContinentId }
  | { type: 'continentLost'; player: PlayerId; continent: ContinentId; to: PlayerId }
  | { type: 'cardDrawn'; player: PlayerId; card: Card }
  | { type: 'cardsCaptured'; player: PlayerId; from: PlayerId; cards: Card[] }
  | { type: 'playerEliminated'; player: PlayerId; by: PlayerId }
  | { type: 'controllerChanged'; player: PlayerId; kind: PlayerKind; difficulty?: AiDifficulty; personality?: AiPersonality }
  // Diplomacy (additive). `truceSentence(state, event)` gives each one plain-English line.
  | { type: 'truceProposed'; from: PlayerId; to: PlayerId; rounds: number; kind: TruceKind }
  /** v5.1: the AI's answer to askPeace, at once, with its reason ('Sage agrees · three rounds' / 'Sage refuses · you took Ural'). */
  | { type: 'peaceAnswered'; from: PlayerId; to: PlayerId; accepted: boolean; rounds: number; reason: string }
  /** v5.1: `by` attacked `against` while at peace; `by` is hostile to `against` for the rest of the game. */
  | { type: 'peaceBroken'; by: PlayerId; against: PlayerId }
  /** v5.1: an AI's standing toward a seat changed (for the seat mark and the one line). */
  | { type: 'standingChanged'; ai: PlayerId; toward: PlayerId; standing: 'ally' | 'even' | 'wary' | 'hostile' }
  | { type: 'truceAccepted'; from: PlayerId; to: PlayerId; rounds: number; kind: TruceKind; until: number }
  | { type: 'truceDeclined'; from: PlayerId; to: PlayerId; rounds: number; kind: TruceKind; reason: 'declined' | 'lapsed' }
  /** `by` attacked `against` while a truce held. Emitted before the attack's first diceRolled. */
  | { type: 'truceBroken'; by: PlayerId; against: PlayerId; from: TerritoryId; to: TerritoryId }
  /**
   * `reason: 'standing'` (additive, v5.1): an AI-AI understanding ended because `from`'s standing toward `to` fell
   * to wary or hostile at a turn boundary ('Sage turned on Ochre').
   */
  | { type: 'truceExpired'; from: PlayerId; to: PlayerId; reason: 'time' | 'eliminated' | 'standing' }
  /** Additive (v5 G): `by: 'mission'` and `mission` (the headline sentence) when a secret mission won it. */
  | { type: 'gameOver'; winner: PlayerId; reason: 'domination' | 'percent' | 'turnLimit'; by?: 'mission'; mission?: string };

export type GameEventType = GameEvent['type'];

export type ActionResult =
  | { ok: true; state: GameState; events: GameEvent[] }
  | { ok: false; error: string };
