// legalActionsSummary: everything the UI needs to drive highlights and the action bar, in one cheap call.

import { bonusTerritoryFor, setValueFor, validSets } from './cards';
import { attackSources, attackTargets, fortifySources, fortifyTargets, mapOf } from './rules';
import { UNCLAIMED, type GameState, type PhaseKind, type PlayerId, type TerritoryId } from './types';

export interface TradeOption {
  /** Card ids, ascending. Send as `{ type: 'trade', cardIds }`. */
  cardIds: [number, number, number];
  /** Base armies for this trade (progressive: same for every set; fixed: depends on symbols). */
  value: number;
  /** Territory that would receive the +2 bonus, or null. */
  bonusTerritory: TerritoryId | null;
}

/**
 * What the current player may do right now. All arrays are in canonical territory order (the map's territoryIds).
 * Fields that don't apply to the current phase are empty / 0 / false / null.
 */
export interface LegalSummary {
  /** Player whose move it is (after game over: the winner). */
  player: PlayerId;
  phase: PhaseKind;
  /** The current seat is AI-controlled (UI should not accept board input). */
  isAi: boolean;
  /** setup-claim: unclaimed territories. */
  claimable: TerritoryId[];
  /** setup-place / reinforce: own territories that can receive armies (empty while mustTrade). */
  placeable: TerritoryId[];
  /** reinforce: territories with armies placed this phase that can be taken back (right-click / undo). */
  unplaceable: TerritoryId[];
  /** setup-place: phase.toPlace; reinforce: phase.remaining; else 0. */
  toPlace: number;
  /** reinforce: holding 5+ cards — must trade before placing or ending. */
  mustTrade: boolean;
  /** reinforce: this is the forced mid-turn trade after an elimination (ending it returns to attack). */
  midTurn: boolean;
  /** reinforce: every valid set in the current player's hand, best value first. Empty outside reinforce. */
  tradeSets: TradeOption[];
  /** Valid sets in hand regardless of phase (for the "set available" badge on the card tray). */
  hasSetInHand: boolean;
  canEndReinforce: boolean;
  /** attack: own territories with ≥ 2 armies bordering an enemy. Use `attackTargets(state, from)`. */
  attackSources: TerritoryId[];
  canEndAttack: boolean;
  /** occupy: the pending move-in. */
  occupy: { from: TerritoryId; to: TerritoryId; min: number; max: number } | null;
  /** fortify: own territories with ≥ 2 armies and an owned neighbor. Use `fortifyTargets(state, from)`. */
  fortifySources: TerritoryId[];
  /** attack or fortify: `endTurn` is legal. */
  canEndTurn: boolean;
  gameOver: { winner: PlayerId; reason: 'domination' | 'percent' | 'turnLimit' } | null;
}

export function legalActionsSummary(state: GameState): LegalSummary {
  const ph = state.phase;
  const player = ph.kind === 'game-over' ? ph.winner : state.currentPlayer;
  const me = state.players[player];
  const hand = me?.cards ?? [];
  const sets = hand.length >= 3 ? validSets(hand) : [];
  const out: LegalSummary = {
    player,
    phase: ph.kind,
    isAi: me?.kind === 'ai',
    claimable: [],
    placeable: [],
    unplaceable: [],
    toPlace: 0,
    mustTrade: false,
    midTurn: false,
    tradeSets: [],
    hasSetInHand: sets.length > 0,
    canEndReinforce: false,
    attackSources: [],
    canEndAttack: false,
    occupy: null,
    fortifySources: [],
    canEndTurn: false,
    gameOver: null,
  };
  const ids = mapOf(state).territoryIds;
  const owned = () => ids.filter((t) => state.territories[t].owner === player);
  switch (ph.kind) {
    case 'setup-claim':
      out.claimable = ids.filter((t) => state.territories[t].owner === UNCLAIMED);
      break;
    case 'setup-place':
      out.placeable = owned();
      out.toPlace = ph.toPlace;
      break;
    case 'reinforce': {
      out.toPlace = ph.remaining;
      out.mustTrade = ph.mustTrade;
      out.midTurn = ph.midTurn;
      out.placeable = ph.mustTrade || ph.remaining === 0 ? [] : owned();
      out.unplaceable = ids.filter((t) => (ph.placed[t] ?? 0) > 0);
      out.tradeSets = sets
        .map((ids) => {
          const cards = ids.map((id) => hand.find((c) => c.id === id)!);
          return {
            cardIds: ids,
            value: setValueFor(state.config, state.tradeCount, cards.map((c) => c.symbol)),
            bonusTerritory: bonusTerritoryFor(state, player, cards),
          };
        })
        .sort((a, b) => b.value + (b.bonusTerritory ? 2 : 0) - (a.value + (a.bonusTerritory ? 2 : 0)));
      out.canEndReinforce = ph.remaining === 0 && !ph.mustTrade;
      break;
    }
    case 'attack':
      out.attackSources = attackSources(state, player);
      out.canEndAttack = true;
      out.canEndTurn = true;
      break;
    case 'occupy':
      out.occupy = { from: ph.from, to: ph.to, min: ph.min, max: ph.max };
      break;
    case 'fortify':
      out.fortifySources = fortifySources(state, player);
      out.canEndTurn = true;
      break;
    case 'game-over':
      out.gameOver = { winner: ph.winner, reason: ph.reason };
      break;
  }
  return out;
}

// Re-exported for convenience next to the summary.
export { attackTargets, fortifyTargets };
