// applyAction: validate, then execute on a private clone. Never throws, never mutates input.
//
// EVENT ORDERING (what the controller animates, in order). Every phase-kind change emits
// `phaseChanged` at the point it happens.
//
//   createGame (random deal): gameStarted → territoriesDealt
//       → auto:   armiesPlaced(setup) ×N → turnStarted → phaseChanged(reinforce)
//       → manual: phaseChanged(setup-place) → setupTurn
//   createGame (draft): gameStarted → phaseChanged(setup-claim)
//   claim: territoryClaimed  [last claim → (auto) armiesPlaced ×N → turnStarted → phaseChanged(reinforce)
//                                          (manual) phaseChanged(setup-place) → setupTurn]
//   placeSetup: armiesPlaced(setup) → setupTurn (next seat)  |  → turnStarted → phaseChanged(reinforce)
//   trade: cardsTraded → armiesPlaced(cardBonus)?
//   reinforce: armiesPlaced(reinforce)          unreinforce: armiesPlaced(undo, negative count)
//   endReinforce: phaseChanged(attack)
//   attack / blitz: diceRolled ×N (blitz: true for blitz) → on conquest:
//       territoryConquered → playerEliminated? → cardsCaptured?
//         → if the conquest wins the game: armiesMoved(occupy, max) → continentLost? → continentGained? → gameOver
//         → if min === max (auto-occupy): armiesMoved(occupy) → continentLost? → continentGained?
//                                         → phaseChanged(reinforce, midTurn)? (6+ cards after a capture)
//         → otherwise: phaseChanged(occupy)
//   occupy: armiesMoved(occupy) → continentLost? → continentGained?
//           → phaseChanged(reinforce, midTurn) (6+ cards)  |  phaseChanged(attack)  |  gameOver
//   endReinforce (midTurn): phaseChanged(attack)
//   endAttack: phaseChanged(fortify)
//   fortify: armiesMoved(fortify, with path) → [end of turn]
//   endTurn: [end of turn]
//   [end of turn]: cardDrawn? → (turn limit reached: gameOver) | turnStarted → phaseChanged(reinforce)
//
// Missions (v5 G, config.missions): the current player's mission is checked after endReinforce
// (phaseChanged(attack) → gameOver), after a conquest's occupy (in place of the territory win, which is
// checked first), and before fortify/endTurn hand the turn on (armiesMoved(fortify)? → gameOver, no
// card drawn). A conquest that meets the mission marches everyone in like a winning conquest.
// gameOver then carries by: 'mission' and the headline sentence.
//   setController: controllerChanged
//
// Diplomacy (additive; only personality AIs, or humans with config.diplomacy, ever trigger these):
//   proposeTruce: truceProposed → (AI target) truceAccepted | truceDeclined   (v5.1: a human target is rejected)
//   answerTruce:  truceAccepted | truceDeclined   (v5.1: unused, no offer reaches a human; kept for old saves)
//   askPeace (v5.1): peaceAnswered → standingChanged?
//   attack / blitz through peace (v5.1): peaceBroken → standingChanged? → diceRolled ...
//   attack / blitz on a truce partner: truceBroken → diceRolled ...
//   conquest that eliminates a seat with truces: ... cardsCaptured? → truceExpired(eliminated) ×N → ...
//   [end of turn]: cardDrawn? → truceDeclined(lapsed)? → (new round) truceExpired(time) ×N
//                  → (v5.1) truceExpired(standing) ×N → standingChanged ×N → turnStarted
//
// Grudges (PlayerState.grudges) change silently: on every conquest, broken continent, broken truce,
// and elimination of a truce partner; they decay each new round.
//
// Continent events: `continentLost` (previous owner broke) is emitted before `continentGained`.

import { acceptsTruce } from './ai/diplomacy';
import { isPersonality } from './ai/personality';
import { bonusTerritoryFor, setValueFor, isValidSetSymbols } from './cards';
import {
  addGrudge,
  cloneDiplomacy,
  ensureDiplomacy,
  GRUDGE_BETRAYED,
  GRUDGE_CONTINENT,
  GRUDGE_PARTNER_ELIMINATED,
  GRUDGE_STANDING,
  GRUDGE_TAKEN,
  isPeace,
  offerBetween,
  truceBetween,
  trucePartners,
  TRUCE_MAX_ROUNDS,
  TRUCE_MIN_ROUNDS,
} from './diplomacy';
import {
  afterTerritoriesAssigned,
  emit,
  finishTurn,
  gameOver,
  missionWin,
  nextSeat,
  setPhase,
  startMainGame,
  startSetupPlaceTurn,
  updatePeak,
  type Draft,
} from './flow';
import { ADJACENCY, CONTINENTS, TERRITORIES, TERRITORY_IDS } from './mapData';
import { missionComplete } from './missions';
import { random, rollDie } from './rng';
import { clearHardened, noteStanding, peaceAnswer, peaceAskBlock, PEACE_ROUNDS } from './standing';
import {
  checkWinner,
  defendDiceFor,
  fortifyPath,
  isTerritoryId,
  maxAttackDice,
  territoryCount,
  territoryName,
} from './rules';
import {
  UNCLAIMED,
  type Action,
  type ActionResult,
  type GameState,
  type Phase,
  type PlayerId,
  type TerritoryId,
  type TerritoryState,
  type TruceOffer,
  type TruceProposal,
} from './types';

// ---------------------------------------------------------------------------
// Cloning (structural; cards and config are immutable and shared)
// ---------------------------------------------------------------------------

export function cloneState(s: GameState): GameState {
  const territories = {} as Record<TerritoryId, TerritoryState>;
  for (const t of TERRITORY_IDS) {
    const x = s.territories[t];
    territories[t] = { owner: x.owner, armies: x.armies };
  }
  const phase: Phase = s.phase.kind === 'reinforce' ? { ...s.phase, placed: { ...s.phase.placed } } : { ...s.phase };
  const out: GameState = {
    ...s,
    players: s.players.map((p) => {
      const c = { ...p, cards: [...p.cards], stats: { ...p.stats } };
      if (p.grudges) c.grudges = { ...p.grudges };
      if (p.lastTakenBy) c.lastTakenBy = { ...p.lastTakenBy };
      return c;
    }),
    territories,
    phase,
    deck: [...s.deck],
    discard: [...s.discard],
    timeline: [...s.timeline],
  };
  if (s.diplomacy) out.diplomacy = cloneDiplomacy(s.diplomacy);
  return out;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const ACTION_TYPES = new Set([
  'claim',
  'placeSetup',
  'trade',
  'reinforce',
  'unreinforce',
  'endReinforce',
  'attack',
  'blitz',
  'occupy',
  'endAttack',
  'fortify',
  'endTurn',
  'setController',
  'proposeTruce',
  'answerTruce',
  'askPeace',
]);

const isPosInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 1;

function phaseBlurb(state: GameState): string {
  const ph = state.phase;
  switch (ph.kind) {
    case 'setup-claim':
      return 'Claim a territory first.';
    case 'setup-place':
      return `Place your ${ph.toPlace === 1 ? '1 starting army' : `${ph.toPlace} starting armies`} first.`;
    case 'reinforce':
      if (ph.mustTrade) return 'Trade in a card set first.';
      if (ph.remaining > 0) return `Place your ${armies(ph.remaining)} first.`;
      return 'Finish reinforcing first.';
    case 'attack':
      return "You're in the attack step.";
    case 'occupy':
      return `Move armies into ${territoryName(ph.to)} first.`;
    case 'fortify':
      return "You're in the fortify step — fortify or end your turn.";
    case 'game-over':
      return 'The game is over.';
  }
}

function armies(n: number): string {
  return n === 1 ? '1 army' : `${n} armies`;
}

/** Why `action` is illegal right now, or null if it's legal. Cheap; never throws on junk input. */
export function validateAction(state: GameState, action: Action): string | null {
  try {
    return validateInner(state, action);
  } catch {
    return 'That action is malformed.';
  }
}

function validateInner(state: GameState, action: Action): string | null {
  if (!state || typeof state !== 'object' || !state.phase || !Array.isArray(state.players)) return 'No game in progress.';
  if (!action || typeof action !== 'object') return "That action isn't recognized.";
  const a = action as Action & Record<string, unknown>;
  if (typeof a.type !== 'string') return "That action isn't recognized.";
  if (!ACTION_TYPES.has(a.type)) return `Unknown action "${a.type.slice(0, 24)}".`;
  if (typeof a.player !== 'number' || !Number.isInteger(a.player) || !state.players[a.player]) return 'No such player.';
  const me = state.players[a.player];

  if (a.type === 'setController') {
    if (a.kind !== 'human' && a.kind !== 'ai') return 'A seat is either human or AI.';
    if (a.difficulty !== undefined && a.difficulty !== 'easy' && a.difficulty !== 'normal' && a.difficulty !== 'hard')
      return 'AI difficulty must be easy, normal, or hard.';
    if (a.personality !== undefined && !isPersonality(a.personality)) return 'AI personality must be turtle, opportunist, or warlord.';
    return null;
  }

  if (a.type === 'answerTruce') {
    if (state.phase.kind === 'game-over') return 'The game is over.';
    if (typeof a.accept !== 'boolean') return 'Answer the truce with yes or no.';
    const o = state.diplomacy?.offers.find((x) => x.from === a.from && x.to === a.player);
    if (!o) return 'There is no truce offer to answer.';
    return null;
  }

  const ph = state.phase;
  if (ph.kind === 'game-over') return 'The game is over.';
  if (a.player !== state.currentPlayer) {
    const cur = state.players[state.currentPlayer];
    return `It's ${cur?.name ?? 'someone else'}'s turn, not ${me.name}'s.`;
  }

  const t = (x: unknown, label = 'territory'): string | null =>
    isTerritoryId(x) ? null : `Pick a valid ${label}.`;
  const own = (x: TerritoryId): boolean => state.territories[x].owner === a.player;

  switch (a.type) {
    case 'claim': {
      if (ph.kind !== 'setup-claim') return phaseBlurb(state);
      const e = t(a.territory);
      if (e) return e;
      if (state.territories[a.territory].owner !== UNCLAIMED) return `${territoryName(a.territory)} is already claimed.`;
      return null;
    }
    case 'placeSetup': {
      if (ph.kind !== 'setup-place') return phaseBlurb(state);
      const e = t(a.territory);
      if (e) return e;
      if (!own(a.territory)) return `${territoryName(a.territory)} isn't yours.`;
      if (!isPosInt(a.count)) return 'Place at least 1 army.';
      if (a.count > ph.toPlace) return `You have only ${armies(ph.toPlace)} to place this turn.`;
      return null;
    }
    case 'trade': {
      if (ph.kind !== 'reinforce') return 'Cards can only be traded while reinforcing.';
      const ids = a.cardIds;
      if (!Array.isArray(ids) || ids.length !== 3 || !ids.every((x) => typeof x === 'number' && Number.isInteger(x)))
        return 'Pick exactly three cards.';
      if (new Set(ids).size !== 3) return 'Pick three different cards.';
      const cards = ids.map((id) => me.cards.find((c) => c.id === id));
      if (cards.some((c) => !c)) return "You don't hold those cards.";
      if (!isValidSetSymbols(cards.map((c) => c!.symbol)))
        return "Those cards aren't a set: you need three alike, one of each, or any two plus a wild.";
      return null;
    }
    case 'reinforce': {
      if (ph.kind !== 'reinforce') return phaseBlurb(state);
      if (ph.mustTrade) return 'You hold 5 or more cards — trade in a set first.';
      const e = t(a.territory);
      if (e) return e;
      if (!own(a.territory)) return `${territoryName(a.territory)} isn't yours.`;
      if (!isPosInt(a.count)) return 'Place at least 1 army.';
      if (ph.remaining === 0) return 'No armies left to place.';
      if (a.count > ph.remaining) return `Only ${armies(ph.remaining)} left to place.`;
      return null;
    }
    case 'unreinforce': {
      if (ph.kind !== 'reinforce') return 'You can only take back armies while reinforcing.';
      const e = t(a.territory);
      if (e) return e;
      if (!isPosInt(a.count)) return 'Take back at least 1 army.';
      const placed = ph.placed[a.territory] ?? 0;
      if (placed === 0) return `You haven't placed any armies on ${territoryName(a.territory)} this turn.`;
      if (a.count > placed) return `You placed only ${armies(placed)} on ${territoryName(a.territory)} this turn.`;
      return null;
    }
    case 'endReinforce': {
      if (ph.kind !== 'reinforce') return phaseBlurb(state);
      if (ph.mustTrade) return 'You hold 5 or more cards — trade in a set first.';
      if (ph.remaining > 0) return `Place your remaining ${armies(ph.remaining)} first.`;
      return null;
    }
    case 'attack':
    case 'blitz': {
      if (ph.kind !== 'attack') return phaseBlurb(state);
      const e = t(a.from, 'territory to attack from') ?? t(a.to, 'territory to attack');
      if (e) return e;
      if (!own(a.from)) return `${territoryName(a.from)} isn't yours.`;
      if (own(a.to)) return `${territoryName(a.to)} is already yours.`;
      if (!ADJACENCY[a.from].includes(a.to)) return `${territoryName(a.from)} doesn't border ${territoryName(a.to)}.`;
      const fa = state.territories[a.from].armies;
      if (fa < 2) return `${territoryName(a.from)} needs at least 2 armies to attack.`;
      if (a.type === 'attack') {
        if (a.dice !== 1 && a.dice !== 2 && a.dice !== 3) return 'Roll 1, 2, or 3 dice.';
        const m = maxAttackDice(state, a.from);
        if (a.dice > m) return `${territoryName(a.from)} can roll at most ${m === 1 ? '1 die' : `${m} dice`}.`;
      } else {
        const stopAt = a.stopAt ?? 1;
        if (!isPosInt(stopAt)) return 'Blitz must stop at 1 army or more.';
        if (fa <= stopAt) return `${territoryName(a.from)} has only ${armies(fa)} — nothing to blitz with.`;
      }
      return null;
    }
    case 'occupy': {
      if (ph.kind !== 'occupy') return 'There is nothing to move in right now.';
      if (!isPosInt(a.count) || a.count < ph.min || a.count > ph.max)
        return ph.min === ph.max ? `Move exactly ${armies(ph.min)}.` : `Move between ${ph.min} and ${ph.max} armies.`;
      return null;
    }
    case 'endAttack': {
      if (ph.kind !== 'attack') return phaseBlurb(state);
      return null;
    }
    case 'fortify': {
      if (ph.kind !== 'fortify') return ph.kind === 'attack' ? 'End your attack before fortifying.' : phaseBlurb(state);
      const e = t(a.from, 'territory to move from') ?? t(a.to, 'territory to move to');
      if (e) return e;
      if (!own(a.from)) return `${territoryName(a.from)} isn't yours.`;
      if (!own(a.to)) return `${territoryName(a.to)} isn't yours.`;
      if (a.from === a.to) return 'Pick two different territories.';
      if (!isPosInt(a.count)) return 'Move at least 1 army.';
      const fa = state.territories[a.from].armies;
      if (fa < 2) return `${territoryName(a.from)} has no armies to spare — 1 must stay behind.`;
      if (a.count > fa - 1) return `You can move at most ${armies(fa - 1)} — 1 must stay behind.`;
      if (!fortifyPath(state, a.from, a.to)) {
        return state.config.fortifyRule === 'adjacent'
          ? `House rules: fortify only to a neighboring territory, and ${territoryName(a.to)} doesn't border ${territoryName(a.from)}.`
          : `No chain of your territories links ${territoryName(a.from)} and ${territoryName(a.to)}.`;
      }
      return null;
    }
    case 'endTurn': {
      if (ph.kind !== 'attack' && ph.kind !== 'fortify') return phaseBlurb(state);
      return null;
    }
    case 'proposeTruce': {
      if (ph.kind !== 'reinforce' && ph.kind !== 'attack' && ph.kind !== 'fortify')
        return 'Offer a truce during your turn, not in the middle of a move.';
      if (typeof a.to !== 'number' || !Number.isInteger(a.to) || !state.players[a.to]) return 'No such player.';
      if (a.to === a.player) return "You can't make a truce with yourself.";
      const them = state.players[a.to];
      if (them.eliminated) return `${them.name} is out of the game.`;
      if (them.neutral || me.neutral) return 'The neutral armies make no truces.';
      if (a.kind !== 'noAttack') return 'The only truce is a no-attack truce.';
      if (!Number.isInteger(a.rounds) || a.rounds < TRUCE_MIN_ROUNDS || a.rounds > TRUCE_MAX_ROUNDS)
        return `A truce lasts ${TRUCE_MIN_ROUNDS} to ${TRUCE_MAX_ROUNDS} rounds.`;
      // v5.1: nobody offers a person a truce any more; a person asks an AI for peace (askPeace).
      if (them.kind === 'human') return `${them.name} is not offered truces · a person asks for peace instead.`;
      if (me.kind === 'human' && !state.config.diplomacy) return 'Truces with human players are off in this game.';
      if (truceBetween(state, a.player, a.to)) return `${me.name} and ${them.name} already have a truce.`;
      if (offerBetween(state, a.player, a.to)) return `A truce offer between ${me.name} and ${them.name} is already waiting.`;
      if (state.diplomacy?.proposedOn[a.player] === state.turn) return 'One truce offer per turn.';
      return null;
    }
  }
  return "That action isn't recognized.";
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** Apply one action. `{ ok: false, error }` on anything illegal; input state is never touched. */
export function applyAction(state: GameState, action: Action): ActionResult {
  const err = validateAction(state, action);
  if (err) return { ok: false, error: err };
  try {
    const d: Draft = { s: cloneState(state), ev: [] };
    execute(d, action);
    return { ok: true, state: d.s, events: d.ev };
  } catch (e) {
    return { ok: false, error: `Internal error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function execute(d: Draft, a: Action): void {
  const s = d.s;
  switch (a.type) {
    case 'setController': {
      const p = s.players[a.player];
      p.kind = a.kind;
      if (a.kind === 'ai') p.difficulty = a.difficulty ?? p.difficulty ?? 'normal';
      else delete p.difficulty;
      if (a.personality) p.personality = a.personality;
      emit(d, {
        type: 'controllerChanged',
        player: a.player,
        kind: a.kind,
        ...(p.difficulty ? { difficulty: p.difficulty } : {}),
        ...(a.personality ? { personality: a.personality } : {}),
      });
      return;
    }
    case 'proposeTruce':
      return doPropose(d, { from: a.player, to: a.to, rounds: a.rounds, kind: a.kind });
    case 'askPeace':
      return doAskPeace(d, a.player, a.to);
    case 'answerTruce': {
      const dip = ensureDiplomacy(s);
      const i = dip.offers.findIndex((x) => x.from === a.from && x.to === a.player);
      const o = dip.offers[i];
      dip.offers.splice(i, 1);
      resolveOffer(d, o, a.accept);
      return;
    }
    case 'claim': {
      s.territories[a.territory] = { owner: a.player, armies: 1 };
      const p = s.players[a.player];
      p.setupArmies = Math.max(0, p.setupArmies - 1);
      emit(d, { type: 'territoryClaimed', player: a.player, territory: a.territory });
      updatePeak(d, a.player);
      if (TERRITORY_IDS.every((t) => s.territories[t].owner !== UNCLAIMED)) {
        afterTerritoriesAssigned(d);
      } else {
        s.currentPlayer = nextSeat(s, a.player, (p) => !s.players[p].neutral)!.player;
      }
      return;
    }
    case 'placeSetup': {
      const ph = s.phase as Extract<Phase, { kind: 'setup-place' }>;
      s.territories[a.territory].armies += a.count;
      s.players[a.player].setupArmies -= a.count;
      emit(d, { type: 'armiesPlaced', player: a.player, territory: a.territory, count: a.count, source: 'setup' });
      const left = ph.toPlace - a.count;
      if (left > 0) {
        s.phase = { kind: 'setup-place', toPlace: left };
        return;
      }
      const next = nextSeat(s, a.player, (p) => s.players[p].setupArmies > 0);
      if (next) startSetupPlaceTurn(d, next.player);
      else startMainGame(d);
      return;
    }
    case 'trade':
      return doTrade(d, a.player, a.cardIds);
    case 'reinforce': {
      const ph = s.phase as Extract<Phase, { kind: 'reinforce' }>;
      s.territories[a.territory].armies += a.count;
      ph.placed[a.territory] = (ph.placed[a.territory] ?? 0) + a.count;
      ph.remaining -= a.count;
      emit(d, { type: 'armiesPlaced', player: a.player, territory: a.territory, count: a.count, source: 'reinforce' });
      return;
    }
    case 'unreinforce': {
      const ph = s.phase as Extract<Phase, { kind: 'reinforce' }>;
      s.territories[a.territory].armies -= a.count;
      const left = (ph.placed[a.territory] ?? 0) - a.count;
      if (left > 0) ph.placed[a.territory] = left;
      else delete ph.placed[a.territory];
      ph.remaining += a.count;
      emit(d, { type: 'armiesPlaced', player: a.player, territory: a.territory, count: -a.count, source: 'undo' });
      return;
    }
    case 'endReinforce':
      setPhase(d, { kind: 'attack' });
      missionWin(d);
      return;
    case 'attack': {
      breakTruceIfAny(d, a.player, a.from, a.to);
      const dice = rollBattle(d, a.from, a.to, a.dice, false);
      if (s.territories[a.to].armies === 0) conquer(d, a.from, a.to, dice);
      return;
    }
    case 'blitz': {
      const stopAt = a.stopAt ?? 1;
      breakTruceIfAny(d, a.player, a.from, a.to);
      const from = s.territories[a.from];
      const to = s.territories[a.to];
      // Each roll removes at least one army, so this terminates; the guard is belt-and-braces.
      for (let guard = 0; guard < 10000 && from.armies > stopAt && to.armies > 0; guard++) {
        const dice = Math.min(3, from.armies - stopAt);
        rollBattle(d, a.from, a.to, dice, true);
        if (to.armies === 0) {
          conquer(d, a.from, a.to, dice);
          break;
        }
      }
      return;
    }
    case 'occupy': {
      const ph = s.phase as Extract<Phase, { kind: 'occupy' }>;
      completeOccupy(d, ph.from, ph.to, a.count, ph.previousOwner ?? UNCLAIMED, true);
      return;
    }
    case 'endAttack':
      setPhase(d, { kind: 'fortify' });
      return;
    case 'fortify': {
      const path = fortifyPath(s, a.from, a.to)!;
      s.territories[a.from].armies -= a.count;
      s.territories[a.to].armies += a.count;
      emit(d, { type: 'armiesMoved', player: a.player, from: a.from, to: a.to, count: a.count, reason: 'fortify', path });
      if (missionWin(d)) return;
      finishTurn(d);
      return;
    }
    case 'endTurn':
      if (missionWin(d)) return;
      finishTurn(d);
      return;
  }
}

// ---------------------------------------------------------------------------
// Diplomacy
// ---------------------------------------------------------------------------

function doPropose(d: Draft, prop: TruceProposal): void {
  const s = d.s;
  const dip = ensureDiplomacy(s);
  dip.proposedOn = { ...dip.proposedOn, [prop.from]: s.turn };
  emit(d, { type: 'truceProposed', ...prop });
  if (s.players[prop.to].kind === 'ai') {
    resolveOffer(d, prop, acceptsTruce(s, prop));
    return;
  }
  dip.offers.push({ ...prop, turn: s.turn });
}

/** v5.1: the AI answers at once from its standing; agreed peace is a truce pinned to ally for PEACE_ROUNDS. */
function doAskPeace(d: Draft, human: PlayerId, ai: PlayerId): void {
  const s = d.s;
  const ans = peaceAnswer(s, human, ai, () => random(s));
  const dip = ensureDiplomacy(s);
  dip.asked = { ...(dip.asked ?? {}), [`${human}>${ai}`]: s.round };
  if (ans.accepted) {
    dip.truces.push({ from: human, to: ai, rounds: PEACE_ROUNDS, kind: 'noAttack', since: s.round, until: s.round + PEACE_ROUNDS + 1, peace: true });
    clearHardened(s, ai, human);
  }
  emit(d, { type: 'peaceAnswered', from: ai, to: human, accepted: ans.accepted, rounds: PEACE_ROUNDS, reason: ans.reason });
  const ch = noteStanding(s, ai, human);
  if (ch) emit(d, ch);
}

function resolveOffer(d: Draft, prop: TruceProposal, accept: boolean): void {
  const s = d.s;
  const dip = ensureDiplomacy(s);
  const base = { from: prop.from, to: prop.to, rounds: prop.rounds, kind: prop.kind };
  if (accept) {
    const until = s.round + prop.rounds + 1;
    dip.truces.push({ ...base, since: s.round, until });
    emit(d, { type: 'truceAccepted', ...base, until });
  } else {
    dip.rebuffs.push({ from: prop.from, to: prop.to, round: s.round });
    emit(d, { type: 'truceDeclined', ...base, reason: 'declined' });
  }
}

/** Attacking a truce partner is legal; it ends the truce and costs standing with everyone. */
function breakTruceIfAny(d: Draft, by: PlayerId, from: TerritoryId, to: TerritoryId): void {
  const s = d.s;
  if (!s.diplomacy) return;
  const against = s.territories[to].owner;
  const dip = s.diplomacy;
  // An attack withdraws any offer still waiting between the two.
  for (let i = dip.offers.length - 1; i >= 0; i--) {
    const o = dip.offers[i];
    if ((o.from === by && o.to === against) || (o.from === against && o.to === by)) {
      dip.offers.splice(i, 1);
      emit(d, { type: 'truceDeclined', from: o.from, to: o.to, rounds: o.rounds, kind: o.kind, reason: 'lapsed' });
    }
  }
  const t = truceBetween(s, by, against);
  if (!t) return;
  dip.truces = dip.truces.filter((x) => x !== t);
  const p = s.players[by];
  p.truceBreaks = (p.truceBreaks ?? 0) + 1;
  addGrudge(s, against, by, GRUDGE_BETRAYED);
  for (const o of s.players) if (o.id !== by && o.id !== against && !o.eliminated) addGrudge(s, o.id, by, GRUDGE_STANDING);
  if (isPeace(s, t)) {
    // v5.1: broken peace. `against` is hostile to `by` for the rest of the game.
    dip.broken = [...(dip.broken ?? []), { by, against, round: s.round }];
    emit(d, { type: 'peaceBroken', by, against });
    const ch = noteStanding(s, against, by);
    if (ch) emit(d, ch);
    return;
  }
  emit(d, { type: 'truceBroken', by, against, from, to });
}

/** A seat is out: its truce partners hold it against the conqueror, and its truces and offers end. */
function endDiplomacyFor(d: Draft, gone: PlayerId, by: PlayerId): void {
  const s = d.s;
  if (!s.diplomacy) return;
  const dip = s.diplomacy;
  for (const z of trucePartners(s, gone)) if (z !== by) addGrudge(s, z, by, GRUDGE_PARTNER_ELIMINATED);
  const ending = dip.truces.filter((t) => t.from === gone || t.to === gone);
  dip.truces = dip.truces.filter((t) => t.from !== gone && t.to !== gone);
  dip.offers = dip.offers.filter((o) => o.from !== gone && o.to !== gone);
  for (const t of ending) emit(d, { type: 'truceExpired', from: t.from, to: t.to, reason: 'eliminated' });
}

function doTrade(d: Draft, player: PlayerId, cardIds: [number, number, number]): void {
  const s = d.s;
  const ph = s.phase as Extract<Phase, { kind: 'reinforce' }>;
  const p = s.players[player];
  const cards = cardIds.map((id) => p.cards.find((c) => c.id === id)!);
  const value = setValueFor(s.config, s.tradeCount, cards.map((c) => c.symbol));
  s.tradeCount += 1;
  p.cards = p.cards.filter((c) => !cardIds.includes(c.id));
  s.discard = [...s.discard, ...cards];
  p.stats.cardsTraded += 1;
  const bonus = bonusTerritoryFor(s, player, cards);
  ph.remaining += value;
  p.stats.reinforcementsReceived += value + (bonus ? 2 : 0);
  ph.mustTrade = p.cards.length >= 5;
  emit(d, { type: 'cardsTraded', player, cards, armies: value, bonusTerritory: bonus, tradeIndex: s.tradeCount });
  if (bonus) {
    s.territories[bonus].armies += 2;
    emit(d, { type: 'armiesPlaced', player, territory: bonus, count: 2, source: 'cardBonus' });
  }
}

/** One roll. Returns the attacker's dice count. */
function rollBattle(d: Draft, from: TerritoryId, to: TerritoryId, diceCount: number, blitz: boolean): number {
  const s = d.s;
  const attacker = s.currentPlayer;
  const f = s.territories[from];
  const t = s.territories[to];
  const defender = t.owner;
  const k = Math.max(1, Math.min(3, diceCount, f.armies - 1));
  const m = defendDiceFor(t.armies);
  const attackDice: number[] = [];
  const defendDice: number[] = [];
  for (let i = 0; i < k; i++) attackDice.push(rollDie(s));
  for (let i = 0; i < m; i++) defendDice.push(rollDie(s));
  attackDice.sort((x, y) => y - x);
  defendDice.sort((x, y) => y - x);
  let attackerLosses = 0;
  let defenderLosses = 0;
  for (let i = 0; i < Math.min(k, m); i++) {
    if (attackDice[i] > defendDice[i]) defenderLosses++;
    else attackerLosses++; // ties go to the defender
  }
  f.armies -= attackerLosses;
  t.armies -= defenderLosses;
  const as = s.players[attacker].stats;
  const ds = s.players[defender].stats;
  as.armiesDestroyed += defenderLosses;
  as.armiesLost += attackerLosses;
  ds.armiesDestroyed += attackerLosses;
  ds.armiesLost += defenderLosses;
  if (defenderLosses > attackerLosses) {
    as.battlesWon++;
    ds.battlesLost++;
  } else if (attackerLosses > defenderLosses) {
    as.battlesLost++;
    ds.battlesWon++;
  }
  emit(d, {
    type: 'diceRolled',
    player: attacker,
    defender,
    from,
    to,
    attackDice,
    defendDice,
    attackerLosses,
    defenderLosses,
    blitz,
  });
  return k;
}

function conquer(d: Draft, from: TerritoryId, to: TerritoryId, lastDice: number): void {
  const s = d.s;
  const attacker = s.currentPlayer;
  const prev = s.territories[to].owner;
  s.territories[to] = { owner: attacker, armies: 0 };
  s.conqueredThisTurn = true;
  s.players[attacker].stats.territoriesConquered++;
  emit(d, { type: 'territoryConquered', player: attacker, from, to, previousOwner: prev });
  updatePeak(d, attacker);
  if (prev >= 0) {
    addGrudge(s, prev, attacker, GRUDGE_TAKEN);
    // v5.1: what the victim's standing reason names ('you took Ural last round').
    const v = s.players[prev];
    if (!v.neutral) v.lastTakenBy = { ...(v.lastTakenBy ?? {}), [attacker]: { territory: to, round: s.round } };
  }

  if (prev >= 0 && territoryCount(s, prev) === 0) {
    const loser = s.players[prev];
    loser.eliminated = true;
    loser.eliminatedBy = attacker;
    loser.eliminatedOnTurn = s.turn;
    emit(d, { type: 'playerEliminated', player: prev, by: attacker });
    if (loser.cards.length > 0) {
      const captured = loser.cards;
      loser.cards = [];
      s.players[attacker].cards = [...s.players[attacker].cards, ...captured];
      emit(d, { type: 'cardsCaptured', player: attacker, from: prev, cards: captured });
    }
    endDiplomacyFor(d, prev, attacker);
  }

  const max = s.territories[from].armies - 1;
  const min = Math.min(lastDice, max);
  if (checkWinner(s) || missionComplete(s, attacker)) {
    // Winning conquest: no pointless slider before the victory screen — march everyone in.
    completeOccupy(d, from, to, max, prev, false);
    return;
  }
  if (min === max) {
    completeOccupy(d, from, to, min, prev, false);
    return;
  }
  setPhase(d, { kind: 'occupy', from, to, min, max, previousOwner: prev });
}

function completeOccupy(
  d: Draft,
  from: TerritoryId,
  to: TerritoryId,
  count: number,
  prev: PlayerId,
  fromOccupyPhase: boolean,
): void {
  const s = d.s;
  const player = s.currentPlayer;
  s.territories[from].armies -= count;
  s.territories[to].armies += count;
  emit(d, { type: 'armiesMoved', player, from, to, count, reason: 'occupy' });

  const c = TERRITORIES[to].continent;
  const others = CONTINENTS[c].territories.filter((x) => x !== to);
  if (prev >= 0 && others.every((x) => s.territories[x].owner === prev)) {
    emit(d, { type: 'continentLost', player: prev, continent: c, to: player });
    addGrudge(s, prev, player, GRUDGE_CONTINENT);
  }
  if (CONTINENTS[c].territories.every((x) => s.territories[x].owner === player)) {
    emit(d, { type: 'continentGained', player, continent: c });
  }

  const win = checkWinner(s);
  if (win) {
    gameOver(d, win.winner, win.reason);
    return;
  }
  if (missionWin(d)) return;
  if (s.players[player].cards.length >= 6) {
    setPhase(d, { kind: 'reinforce', remaining: 0, mustTrade: true, placed: {}, midTurn: true });
    return;
  }
  if (fromOccupyPhase) setPhase(d, { kind: 'attack' });
}

// ---------------------------------------------------------------------------
// Diplomacy read helpers (for the UI)
// ---------------------------------------------------------------------------

/** Seats `player` may offer a truce to right now (empty when it isn't their move or diplomacy forbids it). */
export function truceTargets(state: GameState, player: PlayerId, rounds = 3): PlayerId[] {
  return state.players
    .filter((p) => validateAction(state, { type: 'proposeTruce', player, to: p.id, rounds, kind: 'noAttack' }) === null)
    .map((p) => p.id);
}

/** Offers waiting for `player`'s answer (send `answerTruce`). */
export function truceOffersTo(state: GameState, player: PlayerId): TruceOffer[] {
  return (state.diplomacy?.offers ?? []).filter((o) => o.to === player);
}
