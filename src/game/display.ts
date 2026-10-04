// The HUD follows the board, not the state (SPEC §1, UX.md §8.1): the controller keeps a *displayed*
// GameState that advances one event at a time as each playEvent resolves. This module holds the
// per-event delta and the blocking classification.

import { cloneState, type GameEvent, type GameEventType, type GameState, type Phase } from '../engine';

/** Not awaited before the next input; they overlap freely (UX.md §8.1). */
export const NON_BLOCKING: ReadonlySet<GameEventType> = new Set<GameEventType>([
  'armiesPlaced',
  'territoryClaimed',
  'setupTurn',
  'phaseChanged',
  'cardDrawn',
  'controllerChanged',
  'gameStarted',
  // v3 diplomacy: a sentence in the line and the ledger, nothing on the board to wait for
  'truceProposed',
  'truceAccepted',
  'truceDeclined',
  'truceBroken',
  'truceExpired',
  // v5.1 standing: words and a seat mark only
  'peaceAnswered',
  'peaceBroken',
  'standingChanged',
]);

export function isBlocking(e: GameEvent): boolean {
  return !NON_BLOCKING.has(e.type);
}

function placeholderPhase(e: Extract<GameEvent, { type: 'phaseChanged' }>, d: GameState): Phase {
  switch (e.phase) {
    case 'setup-claim':
      return { kind: 'setup-claim' };
    case 'setup-place':
      return { kind: 'setup-place', toPlace: 0 };
    case 'reinforce':
      return { kind: 'reinforce', remaining: 0, mustTrade: d.players[e.player].cards.length >= 5, placed: {}, midTurn: false };
    case 'attack':
      return { kind: 'attack' };
    case 'fortify':
      return { kind: 'fortify' };
    case 'occupy':
    case 'game-over':
      return d.phase;
  }
}

/**
 * Apply one event to the displayed state (mutates `d`). `after` is the state right after the action
 * that produced the event; `endOfAction` = this is that action's last event, so the display can snap
 * to `after` exactly (phase details, stats, deck) — which it returns as a fresh clone.
 */
export function applyEventToDisplay(d: GameState, e: GameEvent, after: GameState | null, endOfAction: boolean): GameState {
  switch (e.type) {
    case 'territoriesDealt':
      for (const [t, owner] of Object.entries(e.owners)) {
        const ts = d.territories[t as keyof typeof d.territories];
        ts.owner = owner;
        ts.armies = Math.max(1, ts.armies);
      }
      break;
    case 'territoryClaimed':
      d.territories[e.territory] = { owner: e.player, armies: 1 };
      break;
    case 'armiesPlaced': {
      d.territories[e.territory].armies += e.count;
      const ph = d.phase;
      if (ph.kind === 'reinforce' && (e.source === 'reinforce' || e.source === 'undo')) {
        ph.remaining -= e.count;
        const left = (ph.placed[e.territory] ?? 0) + e.count;
        if (left > 0) ph.placed[e.territory] = left;
        else delete ph.placed[e.territory];
      } else if (ph.kind === 'setup-place' && e.source === 'setup') {
        ph.toPlace = Math.max(0, ph.toPlace - e.count);
        d.players[e.player].setupArmies = Math.max(0, d.players[e.player].setupArmies - e.count);
      }
      break;
    }
    case 'setupTurn':
      d.currentPlayer = e.player;
      d.phase = { kind: 'setup-place', toPlace: e.toPlace };
      break;
    case 'turnStarted':
      d.currentPlayer = e.player;
      d.turn = e.turn;
      d.round = e.round;
      d.conqueredThisTurn = false;
      d.phase = {
        kind: 'reinforce',
        remaining: e.reinforcements.total,
        mustTrade: d.players[e.player].cards.length >= 5,
        placed: {},
        midTurn: false,
      };
      break;
    case 'phaseChanged':
      d.phase = placeholderPhase(e, d);
      break;
    case 'cardsTraded': {
      const ids = new Set(e.cards.map((c) => c.id));
      const p = d.players[e.player];
      p.cards = p.cards.filter((c) => !ids.has(c.id));
      d.tradeCount = e.tradeIndex;
      if (d.phase.kind === 'reinforce') {
        d.phase.remaining += e.armies;
        d.phase.mustTrade = p.cards.length >= 5;
      }
      break;
    }
    case 'diceRolled':
      d.territories[e.from].armies -= e.attackerLosses;
      d.territories[e.to].armies -= e.defenderLosses;
      break;
    case 'territoryConquered':
      d.territories[e.to] = { owner: e.player, armies: 0 };
      d.conqueredThisTurn = true;
      break;
    case 'armiesMoved':
      d.territories[e.from].armies -= e.count;
      d.territories[e.to].armies += e.count;
      break;
    case 'cardDrawn':
      d.players[e.player].cards = [...d.players[e.player].cards, e.card];
      break;
    case 'cardsCaptured': {
      const ids = new Set(e.cards.map((c) => c.id));
      d.players[e.from].cards = d.players[e.from].cards.filter((c) => !ids.has(c.id));
      d.players[e.player].cards = [...d.players[e.player].cards, ...e.cards];
      break;
    }
    case 'playerEliminated':
      d.players[e.player].eliminated = true;
      d.players[e.player].eliminatedBy = e.by;
      break;
    case 'controllerChanged':
      d.players[e.player].kind = e.kind;
      break;
    case 'gameOver':
      d.phase = { kind: 'game-over', winner: e.winner, reason: e.reason };
      break;
    case 'gameStarted':
    case 'continentGained':
    case 'continentLost':
      break;
  }
  if (endOfAction && after) return cloneState(after);
  return d;
}
