// Public AI entry. Always returns a legal action for the current player.

import { validSets } from '../cards';
import { mapOf } from '../rules';
import { validateAction } from '../reducer';
import { UNCLAIMED, type Action, type GameState, type PlayerId } from '../types';
import { decide } from './brain';

export { PERSONAS, type Persona } from './persona';

/**
 * Pick the AI's next action for `player` (normally `state.currentPlayer`). Deterministic for a given
 * state, never mutates it, never throws, and the result always passes `applyAction`.
 * If `player` isn't the one to move (or the game is over) it returns a harmless `setController`
 * that re-affirms the seat's current controller.
 */
export function chooseAiAction(state: GameState, player: PlayerId): Action {
  let action: Action | null = null;
  try {
    if (player === state.currentPlayer && state.phase.kind !== 'game-over') action = decide(state, player);
  } catch {
    action = null;
  }
  if (action && validateAction(state, action) === null) return action;
  return fallbackAction(state, player);
}

/** A guaranteed-legal, boring move for the given state. */
export function fallbackAction(state: GameState, player: PlayerId): Action {
  const pl = state.players[player];
  const noop: Action = {
    type: 'setController',
    player,
    kind: pl?.kind ?? 'ai',
    ...(pl?.difficulty ? { difficulty: pl.difficulty } : {}),
  };
  if (!pl || player !== state.currentPlayer) return noop;
  const ph = state.phase;
  const ids = mapOf(state).territoryIds;
  const firstOwned = ids.find((t) => state.territories[t].owner === player)!;
  switch (ph.kind) {
    case 'setup-claim':
      return { type: 'claim', player, territory: ids.find((t) => state.territories[t].owner === UNCLAIMED)! };
    case 'setup-place':
      return { type: 'placeSetup', player, territory: firstOwned, count: ph.toPlace };
    case 'reinforce': {
      if (ph.mustTrade) return { type: 'trade', player, cardIds: validSets(pl.cards)[0] };
      if (ph.remaining > 0) return { type: 'reinforce', player, territory: firstOwned, count: ph.remaining };
      return { type: 'endReinforce', player };
    }
    case 'attack':
      return { type: 'endTurn', player };
    case 'occupy':
      return { type: 'occupy', player, count: ph.min };
    case 'fortify':
      return { type: 'endTurn', player };
    case 'game-over':
      return noop;
  }
}
