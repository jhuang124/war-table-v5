// The bottom strip (docs/ROUND2.md §A–B): the Turn Track at the left, one line that says the one thing
// to do now, then the action zone (at most one count control and at most two buttons, one brass).
// Board clicks only select; buttons commit; the track is the only way to change phase (plus the
// fortify `Move N · end turn`, which says so). Pure: built from the displayed state + the selection.

import {
  CONTINENTS,
  TERRITORIES,
  attackSources,
  attackTargets,
  fortifySources,
  fortifyTargets,
  territoryCount,
  winProbability,
  type GameState,
  type TerritoryId,
} from '../engine';
import { Click, SEP, armies, cName, click, movesIn, pName, pct, poss, seatRef, tName } from './copy';
import { bestSet, oddsWord } from './helpers';
import type { ButtonId, ButtonVM, CountVM, StripVM, TrackSegId, TrackSegVM, TrackVM } from './viewModel';

export interface Placement {
  t: TerritoryId;
  n: number;
}

export interface Sel {
  /** Place: the picked territory. Attack / fortify: the source. */
  selected: TerritoryId | null;
  /** Armed attack target / chosen fortify destination. */
  target: TerritoryId | null;
  /** Place count; null = all remaining. */
  placeCount: number | null;
  occupyCount: number | null;
  fortifyCount: number | null;
  /** The player moved the occupy / fortify count: the line shows the resulting totals. */
  countTouched?: boolean;
  /** Manual setup: armies staged locally this setup turn (committed on Done). */
  staged: Partial<Record<TerritoryId, number>>;
  /** Placements this step, newest last, for Undo (reinforce and setup). */
  placements: Placement[];
}

export function emptySel(): Sel {
  return { selected: null, target: null, placeCount: null, occupyCount: null, fortifyCount: null, staged: {}, placements: [] };
}

export function stagedTotal(sel: Sel): number {
  let n = 0;
  for (const v of Object.values(sel.staged)) n += v ?? 0;
  return n;
}

/** Armies still to place in this Place / setup step (0 outside them). */
export function placeLeft(s: GameState, sel: Sel): number {
  const ph = s.phase;
  if (ph.kind === 'setup-place') return Math.max(0, ph.toPlace - stagedTotal(sel));
  if (ph.kind === 'reinforce' && !ph.mustTrade) return ph.remaining;
  return 0;
}

/** The Place count's value: the picked count, clamped, or all remaining. */
export function placeValue(s: GameState, sel: Sel): number {
  const left = placeLeft(s, sel);
  return Math.max(1, Math.min(left, sel.placeCount ?? left));
}

/** The count control for a min…max range: a stepper for ≤ 6 options, a slider for more. */
export function countVM(value: number, min: number, max: number): CountVM {
  return { control: max - min + 1 <= 6 ? 'stepper' : 'slider', value, min, max };
}

/** Line while the opening deal plays (a random deal: nothing to click, a click only skips it). */
export function dealingLine(): string {
  return 'Dealing territories';
}

export function canFortifyAny(s: GameState): boolean {
  return fortifySources(s, s.currentPlayer).some((t) => fortifyTargets(s, t).length > 0);
}

// ---------------------------------------------------------------------------
// The Turn Track
// ---------------------------------------------------------------------------

const LABEL: Record<TrackSegId, string> = {
  place: 'Place',
  attack: 'Attack',
  fortify: 'Fortify',
  endTurn: 'End turn',
  setup: 'Setup',
  done: 'Done',
};
const TURN: TrackSegId[] = ['place', 'attack', 'fortify', 'endTurn'];

/** Why a track segment can't be reached now, or null if it can (or it isn't forward of the marker). */
export function trackLockReason(s: GameState, sel: Sel, seg: TrackSegId): string | null {
  const ph = s.phase;
  switch (ph.kind) {
    case 'setup-claim':
      return seg === 'done' ? `Claim a territory first${SEP}${click()} an open tile` : null;
    case 'setup-place': {
      if (seg !== 'done') return null;
      const left = placeLeft(s, sel);
      return left > 0 ? `Place your ${armies(left)} first` : null;
    }
    case 'reinforce':
      if (seg === 'place') return null;
      if (ph.mustTrade) return 'Trade cards first';
      return ph.remaining > 0 ? `Place your ${armies(ph.remaining)} first` : null;
    case 'occupy':
      return seg === 'fortify' || seg === 'endTurn' ? 'Finish moving armies in first' : null;
    default:
      return null;
  }
}

/** The segment the marker is on, for the phase on the board. */
function currentSeg(s: GameState): TrackSegId | null {
  switch (s.phase.kind) {
    case 'setup-claim':
    case 'setup-place':
      return 'setup';
    case 'reinforce':
      return 'place';
    case 'attack':
    case 'occupy':
      return 'attack';
    case 'fortify':
      return 'fortify';
    case 'game-over':
      return null;
  }
}

/** The recommended next step: all placed → Attack (End turn if nothing can attack); in Fortify → End turn. */
export function recommendedSeg(s: GameState, sel: Sel): TrackSegId | null {
  const ph = s.phase;
  const me = s.currentPlayer;
  switch (ph.kind) {
    case 'setup-place':
      return placeLeft(s, sel) === 0 ? 'done' : null;
    case 'reinforce':
      if (ph.mustTrade || ph.remaining > 0) return null;
      return attackSources(s, me).length > 0 ? 'attack' : 'endTurn';
    case 'attack':
      return attackSources(s, me).length === 0 ? 'endTurn' : null;
    case 'fortify':
      return 'endTurn';
    default:
      return null;
  }
}

export interface TrackInput {
  s: GameState;
  sel: Sel;
  /** The driver can click it. */
  live: boolean;
  /** A roll is playing. */
  rolling: boolean;
}

export function buildTrack(inp: TrackInput): TrackVM {
  const { s, sel } = inp;
  const me = s.currentPlayer;
  const seat = seatRef(s, me);
  const ph = s.phase;
  const setup = ph.kind === 'setup-claim' || ph.kind === 'setup-place';
  const ids: TrackSegId[] = setup ? ['setup', 'done'] : TURN;
  const cur = currentSeg(s);
  const at = cur ? ids.indexOf(cur) : ids.length;
  const segments: TrackSegVM[] = ids.map((id, i) => {
    let state: TrackSegVM['state'];
    if (i < at) state = 'done';
    else if (i === at) state = 'current';
    else state = trackLockReason(s, sel, id) ? 'locked' : 'eligible';
    return { id, label: LABEL[id], state };
  });
  const disabled = inp.live && (inp.rolling || ph.kind === 'occupy' || (ph.kind === 'reinforce' && ph.mustTrade));
  const recommended = inp.live && !disabled ? recommendedSeg(s, sel) : null;
  return {
    kind: setup ? 'setup' : 'turn',
    seat,
    segments,
    recommended,
    primary: false,
    live: inp.live,
    disabled,
    turnKey: `${s.turn}:${me}`,
  };
}

// ---------------------------------------------------------------------------
// The strip
// ---------------------------------------------------------------------------

export interface StripInput {
  s: GameState;
  sel: Sel;
  /** The driver may act (a human's own turn, no cover). */
  interactive: boolean;
  /** Watching line (AI turns). */
  narration: string | null;
  /** The hand-off cover is up for this seat. */
  handoff: number | null;
  /** Every human is out: offer to watch to the end or call it. */
  humansOut: boolean;
  /** Idle line (game over, etc.). */
  idleLine: string | null;
  rejection: { text: string; key: number } | null;
  showWinChance: boolean;
  lineKey: number;
  /** A roll is playing (the track is disabled). */
  rolling?: boolean;
  /** The board draws the resulting totals on the pieces itself: the line needn't. */
  boardPreview?: boolean;
  /**
   * A conquest is on screen but the selection that armed it hasn't caught up (the flood and march are
   * still playing): the line says what happened instead of describing a half-moved board.
   */
  took?: TerritoryId | null;
  /**
   * v4 (PLAN §3 A5): the engine moved the armies in itself after that conquest (no choice to make): the
   * line says how many ('You took Brazil · 3 armies move in'). null = a count was (or will be) chosen.
   */
  tookMoved?: number | null;
}

/**
 * v4 (PLAN §3 A5, the review's truce bug): a truce offer to the driver. It never takes the primary slot,
 * the line, the count or the buttons; it rides under them as a secondary line with 'Accept' / 'Decline'
 * as small words. `Place N` stays the one gold.
 */
export function withOffer(strip: StripVM, text: string): StripVM {
  return { ...strip, offer: { text, buttons: [btn('declineTruce', 'Decline'), btn('acceptTruce', 'Accept')] } };
}

const btn = (id: ButtonId, label: string, primary = false): ButtonVM => ({ id, label, primary });

/** The armed line's hard cap (docs/INK.md B2.11): a stake that doesn't fit is dropped, never truncated. */
export const ATTACK_LINE_MAX = 60;

/**
 * What taking `to` would mean, at most one stake, biggest first: 'knocks out Sam' (their last territory),
 * 'takes North America' (completes a continent), "breaks Sam's Asia" (ends their bonus). null = none.
 */
export function attackStake(s: GameState, from: TerritoryId, to: TerritoryId): string | null {
  const me = s.territories[from].owner;
  const them = s.territories[to].owner;
  if (me < 0 || them < 0 || me === them) return null;
  if (territoryCount(s, them) === 1) return `knocks out ${pName(s, them)}`;
  const c = TERRITORIES[to].continent;
  const others = CONTINENTS[c].territories.filter((t) => t !== to);
  if (others.every((t) => s.territories[t].owner === me)) return `takes ${cName(c)}`;
  if (others.every((t) => s.territories[t].owner === them)) return `breaks ${poss(pName(s, them))} ${cName(c)}`;
  return null;
}

/**
 * The armed line (docs/INK.md B2.11): 'Kamchatka → Alaska · 64% · likely', plus at most one stake
 * ('· takes North America', '· knocks out Sam'); '· likely' alone when the win chance is hidden. ≤ 60
 * characters: with long names the word gives way first (the number says it), then the stake.
 */
export function attackLine(s: GameState, from: TerritoryId, to: TerritoryId, showWinChance: boolean): string {
  const head = `${tName(from)} → ${tName(to)}`;
  const a = s.territories[from].armies;
  const d = s.territories[to].armies;
  if (a < 2 || d < 1) return head;
  const p = winProbability(a, d);
  const num = showWinChance ? `${head}${SEP}${pct(p)}%` : head;
  const odds = `${num}${SEP}${oddsWord(p)}`;
  const stake = attackStake(s, from, to);
  // Too long for everything: the stake outranks the word (the number already says the odds).
  const tries = stake ? [`${odds}${SEP}${stake}`, ...(showWinChance ? [`${num}${SEP}${stake}`] : []), odds, num] : [odds, num];
  return tries.find((x) => x.length <= ATTACK_LINE_MAX) ?? head;
}

/** 'You took Brazil', and when the engine moved the armies in itself, '· 3 armies move in'. */
export function tookLine(t: TerritoryId, moved: number | null): string {
  return moved ? `You took ${tName(t)}${SEP}${movesIn(moved)}` : `You took ${tName(t)}`;
}

/** 'Ural 1 · Siberia 15': the two totals after moving `n` (the board-less preview). */
export function totalsLine(s: GameState, from: TerritoryId, to: TerritoryId, n: number): string {
  const a = s.territories[from].armies - n;
  const b = (s.territories[to].owner === s.territories[from].owner ? s.territories[to].armies : 0) + n;
  return `${tName(from)} ${a}${SEP}${tName(to)} ${b}`;
}

export function buildStrip(inp: StripInput): StripVM {
  const { s, sel } = inp;
  const me = s.currentPlayer;
  const accent = s.players[me].color;
  const track = buildTrack({ s, sel, live: inp.interactive, rolling: !!inp.rolling });
  const make = (mode: StripVM['mode'], line: string, extra: { count?: CountVM | null; buttons?: ButtonVM[] } = {}): StripVM => {
    const buttons = extra.buttons ?? [];
    return {
      mode,
      track: { ...track, primary: !!track.recommended && !buttons.some((b) => b.primary) },
      accent,
      line: inp.rejection ? inp.rejection.text : line,
      lineKind: inp.rejection ? 'rejection' : 'normal',
      lineKey: inp.rejection ? inp.rejection.key : inp.lineKey,
      count: extra.count ?? null,
      buttons,
    };
  };

  if (!inp.interactive) {
    if (inp.humansOut) {
      return {
        mode: 'watching',
        track,
        accent,
        line: 'All humans are out',
        lineKind: 'normal',
        lineKey: inp.lineKey,
        count: null,
        buttons: [btn('callGame', 'End game'), btn('watchAis', 'Watch to the end', true)],
      };
    }
    const who = inp.handoff ?? me;
    // Behind the hand-off cover the track already belongs to the seat being handed the laptop.
    const shownTrack: TrackVM =
      inp.handoff !== null && s.players[inp.handoff]
        ? {
            ...track,
            kind: 'turn',
            seat: seatRef(s, inp.handoff),
            segments: TURN.map((id, i) => ({ id, label: LABEL[id], state: i === 0 ? 'current' : 'locked' })),
            recommended: null,
            turnKey: `handoff:${inp.handoff}`,
          }
        : track;
    const line = inp.handoff !== null ? `Pass the cup to ${pName(s, inp.handoff)}` : (inp.narration ?? inp.idleLine ?? `${poss(pName(s, me))} turn`);
    return {
      mode: inp.idleLine && !inp.narration ? 'idle' : 'watching',
      track: shownTrack,
      accent: s.players[who]?.color ?? accent,
      line,
      lineKind: inp.narration && inp.handoff === null ? 'narration' : 'normal',
      lineKey: inp.lineKey,
      count: null,
      buttons: [],
    };
  }

  const ph = s.phase;
  switch (ph.kind) {
    case 'setup-claim':
      if (s.config.setupMode !== 'draft') return make('setup', dealingLine());
      return make('setup', `Claim a territory${SEP}${click()} an open tile`);
    case 'setup-place': {
      const staged = stagedTotal(sel);
      const left = Math.max(0, ph.toPlace - staged);
      const undo = sel.placements.length > 0 ? [btn('undo', 'Undo')] : [];
      if (left === 0) return make('setup', `All ${ph.toPlace} placed${SEP}${click()} Done`, { buttons: undo });
      if (sel.selected && s.territories[sel.selected].owner === me) {
        const n = placeValue(s, sel);
        return make('setup', `Place on ${tName(sel.selected)}`, {
          count: countVM(n, 1, left),
          buttons: [...undo, btn('place', `Place ${n}`, true)],
        });
      }
      const line = staged > 0 ? `Place ${left} more${SEP}${click()} a territory` : `Place ${armies(left)}${SEP}${click()} a territory`;
      return make('setup', line, { buttons: undo });
    }
    case 'reinforce': {
      const hand = s.players[me].cards;
      const best = bestSet(s, me);
      if (ph.mustTrade) {
        return make('place', `Trade cards first${SEP}you hold ${hand.length}`, {
          buttons: best ? [btn('trade', `Trade cards +${best.value}`, true)] : [],
        });
      }
      const placedAny = Object.values(ph.placed).some((v) => (v ?? 0) > 0);
      const undo = placedAny ? btn('undo', 'Undo') : null;
      const cards = hand.length > 0 ? btn('cards', `Cards ${hand.length}`) : null;
      const secondaries = [...(cards ? [cards] : []), ...(undo ? [undo] : [])];
      if (ph.remaining === 0) {
        const next = attackSources(s, me).length > 0 ? (ph.midTurn ? 'keep attacking' : 'Attack is next') : 'end your turn';
        return make('place', `All placed${SEP}${next}`, { buttons: secondaries });
      }
      if (sel.selected && s.territories[sel.selected].owner === me) {
        const n = placeValue(s, sel);
        const second = undo ?? cards;
        return make('place', `Place on ${tName(sel.selected)}`, {
          count: countVM(n, 1, ph.remaining),
          buttons: [...(second ? [second] : []), btn('place', `Place ${n}`, true)],
        });
      }
      const line = placedAny ? `Place ${ph.remaining} more${SEP}${click()} a territory` : `Place ${armies(ph.remaining)}${SEP}${click()} a territory`;
      return make('place', line, { buttons: secondaries });
    }
    case 'attack': {
      if (inp.took && s.territories[inp.took].owner === me) return make('attack', tookLine(inp.took, inp.tookMoved ?? null));
      const armed = sel.selected && sel.target && s.territories[sel.selected].owner === me && s.territories[sel.target].owner !== me;
      if (armed) {
        return make('attack', attackLine(s, sel.selected!, sel.target!, inp.showWinChance), {
          buttons: [btn('roll', 'Roll'), btn('blitz', 'Blitz', true)],
        });
      }
      if (sel.selected && s.territories[sel.selected].owner === me) return make('attack', `Attack from ${tName(sel.selected)}${SEP}${click()} an enemy`);
      if (attackSources(s, me).length === 0) return make('attack', `No attacks left${SEP}end your turn`);
      return make('attack', `${Click()} an enemy territory to attack`);
    }
    case 'occupy': {
      const value = Math.min(ph.max, Math.max(ph.min, sel.occupyCount ?? ph.max));
      const line = sel.countTouched && !inp.boardPreview ? totalsLine(s, ph.from, ph.to, value) : `Move into ${tName(ph.to)}`;
      return make('occupy', line, {
        count: ph.max > ph.min ? countVM(value, ph.min, ph.max) : null,
        buttons: [btn('move', `Move ${value}`, true)],
      });
    }
    case 'fortify': {
      if (sel.selected && sel.target && s.territories[sel.selected].owner === me) {
        const max = Math.max(1, s.territories[sel.selected].armies - 1);
        const value = Math.min(max, Math.max(1, sel.fortifyCount ?? max));
        const line = sel.countTouched && !inp.boardPreview ? totalsLine(s, sel.selected, sel.target, value) : `Move from ${tName(sel.selected)} to ${tName(sel.target)}`;
        return make('fortify', line, {
          count: max > 1 ? countVM(value, 1, max) : null,
          buttons: [btn('move', `Move ${value}${SEP}end turn`, true)],
        });
      }
      if (sel.selected && s.territories[sel.selected].owner === me) return make('fortify', `Move from ${tName(sel.selected)}${SEP}${click()} where to`);
      if (!canFortifyAny(s)) return make('fortify', `Nothing to move${SEP}end your turn`);
      return make('fortify', 'Move armies once, or end your turn');
    }
    case 'game-over':
      return {
        mode: 'idle',
        track,
        accent,
        line: inp.idleLine ?? 'The game is over',
        lineKind: 'normal',
        lineKey: inp.lineKey,
        count: null,
        buttons: [],
      };
  }
}

/** Territories to pulse for the current selection (exported for highlights). */
export function selectionTargets(s: GameState, sel: Sel): TerritoryId[] {
  if (!sel.selected) return [];
  if (s.phase.kind === 'attack') return attackTargets(s, sel.selected);
  if (s.phase.kind === 'fortify') return fortifyTargets(s, sel.selected);
  return [];
}
