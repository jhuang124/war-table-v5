// Internal state-machine transitions shared by setup and the reducer. Every function here
// mutates a *draft* (a private clone) and appends events; nothing here is exported publicly.

import { decayGrudges, REBUFF_ROUNDS } from './diplomacy';
import { ADJACENCY, TERRITORY_IDS } from './mapData';
import { missionComplete, missionHeadline, missionText } from './missions';
import { random, shuffleInPlace } from './rng';
import { refreshStandings } from './standing';
import { reinforcementsFor, territoryCount, totalArmies, turnLimitWinner } from './rules';
import type { GameEvent, GameState, Phase, PlayerId, TerritoryId, TruceOffer } from './types';

export interface Draft {
  s: GameState;
  ev: GameEvent[];
}

export function emit(d: Draft, e: GameEvent): void {
  d.ev.push(e);
}

export function setPhase(d: Draft, phase: Phase): void {
  d.s.phase = phase;
  emit(d, { type: 'phaseChanged', player: d.s.currentPlayer, phase: phase.kind });
}

export function updatePeak(d: Draft, player: PlayerId): void {
  const p = d.s.players[player];
  if (!p) return;
  const n = territoryCount(d.s, player);
  if (n > p.stats.peakTerritories) p.stats.peakTerritories = n;
}

export function recordTimeline(d: Draft): void {
  const s = d.s;
  s.timeline = [
    ...s.timeline,
    {
      round: s.round,
      territories: s.players.map((p) => territoryCount(s, p.id)),
      armies: s.players.map((p) => totalArmies(s, p.id)),
    },
  ];
}

export function gameOver(
  d: Draft,
  winner: PlayerId,
  reason: 'domination' | 'percent' | 'turnLimit',
  mission?: string,
): void {
  const extra = mission !== undefined ? { by: 'mission' as const, mission } : {};
  d.s.phase = { kind: 'game-over', winner, reason, ...extra };
  recordTimeline(d); // final sample so the victory chart ends on the final board
  emit(d, { type: 'gameOver', winner, reason, ...extra });
}

/**
 * v5 G: the current player's secret mission is met → the game ends (reason 'percent', by 'mission').
 * Called at the end of the current player's own actions only (endReinforce, after a conquest's occupy,
 * fortify, endTurn), so nobody wins on someone else's turn. True when the game ended.
 */
export function missionWin(d: Draft): boolean {
  const s = d.s;
  if (!s.config.missions || s.phase.kind === 'game-over') return false;
  const p = s.currentPlayer;
  if (!missionComplete(s, p)) return false;
  gameOver(d, p, 'percent', missionHeadline(s, p) ?? missionText(s, p) ?? '');
  return true;
}

/** Next seat after `from` (cyclic) matching `pred`, or null. `wrapped` = the walk passed firstPlayer. */
export function nextSeat(
  s: GameState,
  from: PlayerId,
  pred: (p: PlayerId) => boolean,
): { player: PlayerId; wrapped: boolean } | null {
  const n = s.players.length;
  let wrapped = false;
  for (let step = 1; step <= n; step++) {
    const i = (from + step) % n;
    if (i === s.firstPlayer) wrapped = true;
    if (pred(i)) return { player: i, wrapped };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/**
 * Called once every territory has an owner. Auto placement: distribute and start play.
 * Manual: begin setup-place with the first player who still has armies.
 */
export function afterTerritoriesAssigned(d: Draft): void {
  const s = d.s;
  if (s.config.initialPlacement === 'auto') {
    autoPlace(d);
    startMainGame(d);
    return;
  }
  const first = s.players[s.firstPlayer].setupArmies > 0
    ? s.firstPlayer
    : nextSeat(s, s.firstPlayer, (p) => s.players[p].setupArmies > 0)?.player;
  if (first === undefined) {
    startMainGame(d);
    return;
  }
  startSetupPlaceTurn(d, first);
}

export function startSetupPlaceTurn(d: Draft, player: PlayerId): void {
  const s = d.s;
  s.currentPlayer = player;
  const toPlace = Math.min(s.config.setupBatch, s.players[player].setupArmies);
  const wasPlacing = s.phase.kind === 'setup-place';
  s.phase = { kind: 'setup-place', toPlace };
  if (!wasPlacing) emit(d, { type: 'phaseChanged', player, phase: 'setup-place' });
  emit(d, { type: 'setupTurn', player, toPlace });
}

/** Engine placement: favors border territories (more enemy neighbors = more weight), some randomness. */
export function autoPlace(d: Draft): void {
  const s = d.s;
  const n = s.players.length;
  for (let k = 0; k < n; k++) {
    const pid = (s.firstPlayer + k) % n;
    const p = s.players[pid];
    let left = p.setupArmies;
    if (left <= 0) continue;
    const owned = TERRITORY_IDS.filter((t) => s.territories[t].owner === pid);
    if (owned.length === 0) continue;
    const weights = owned.map((t) => {
      let enemies = 0;
      for (const nb of ADJACENCY[t]) if (s.territories[nb].owner !== pid) enemies++;
      return enemies === 0 ? 0.2 : 1 + enemies;
    });
    const totalW = weights.reduce((a, b) => a + b, 0);
    const add = new Map<TerritoryId, number>();
    while (left > 0) {
      let r = random(s) * totalW;
      let idx = 0;
      while (idx < owned.length - 1 && r >= weights[idx]) {
        r -= weights[idx];
        idx++;
      }
      // Place in small clumps (1–3) so stacks form instead of an even smear.
      const chunk = Math.min(left, 1 + Math.floor(random(s) * 3));
      add.set(owned[idx], (add.get(owned[idx]) ?? 0) + chunk);
      left -= chunk;
    }
    for (const t of owned) {
      const c = add.get(t);
      if (!c) continue;
      s.territories[t].armies += c;
      emit(d, { type: 'armiesPlaced', player: pid, territory: t, count: c, source: 'setup' });
    }
    p.setupArmies = 0;
  }
}

// ---------------------------------------------------------------------------
// Main play
// ---------------------------------------------------------------------------

export function startMainGame(d: Draft): void {
  const s = d.s;
  for (const p of s.players) p.setupArmies = 0;
  s.round = 1;
  s.turn = 0;
  recordTimeline(d);
  refreshStandings(s, true); // v5.1: the baseline bands, without events
  startTurn(d, s.firstPlayer);
}

export function startTurn(d: Draft, player: PlayerId): void {
  const s = d.s;
  s.currentPlayer = player;
  s.turn += 1;
  s.conqueredThisTurn = false;
  const r = reinforcementsFor(s, player);
  const p = s.players[player];
  p.stats.reinforcementsReceived += r.total;
  emit(d, { type: 'turnStarted', player, turn: s.turn, round: s.round, reinforcements: r });
  setPhase(d, { kind: 'reinforce', remaining: r.total, mustTrade: p.cards.length >= 5, placed: {}, midTurn: false });
}

/** Card draw (if earned), pass to the next living player, round/timeline/turn-limit bookkeeping. */
export function finishTurn(d: Draft): void {
  const s = d.s;
  const cur = s.currentPlayer;
  if (s.conqueredThisTurn) {
    if (s.deck.length === 0 && s.discard.length > 0) {
      s.deck = shuffleInPlace(s, [...s.discard]);
      s.discard = [];
    }
    const card = s.deck.length > 0 ? s.deck[s.deck.length - 1] : undefined;
    if (card) {
      s.deck = s.deck.slice(0, -1);
      s.players[cur].cards = [...s.players[cur].cards, card];
      emit(d, { type: 'cardDrawn', player: cur, card });
    }
  }
  s.conqueredThisTurn = false;
  lapseOffers(d, cur);
  const next = nextSeat(s, cur, (p) => !s.players[p].eliminated && !s.players[p].neutral);
  if (!next) return; // cannot happen: the current player is alive
  if (next.wrapped) {
    if (s.config.turnLimit !== null && s.round >= s.config.turnLimit) {
      gameOver(d, turnLimitWinner(s), 'turnLimit');
      return;
    }
    s.round += 1;
    newRoundDiplomacy(d);
    recordTimeline(d);
  }
  // v5.1: understandings that turned break, and bands that moved are announced (truceExpired 'standing' → standingChanged).
  for (const e of refreshStandings(s)) emit(d, e);
  startTurn(d, next.player);
}

/** Offers to `cur` that were made before this turn lapse as `cur`'s turn ends. */
function lapseOffers(d: Draft, cur: PlayerId): void {
  const dip = d.s.diplomacy;
  if (!dip || dip.offers.length === 0) return;
  const keep: TruceOffer[] = [];
  for (const o of dip.offers) {
    if (o.to === cur && o.turn < d.s.turn) {
      dip.rebuffs.push({ from: o.from, to: o.to, round: d.s.round });
      emit(d, { type: 'truceDeclined', from: o.from, to: o.to, rounds: o.rounds, kind: o.kind, reason: 'lapsed' });
    } else keep.push(o);
  }
  dip.offers = keep;
}

/** Grudges fade; truces whose time is up end; old refusals are forgotten. */
function newRoundDiplomacy(d: Draft): void {
  const s = d.s;
  decayGrudges(s);
  const dip = s.diplomacy;
  if (!dip) return;
  const ending = dip.truces.filter((t) => t.until <= s.round);
  if (ending.length) dip.truces = dip.truces.filter((t) => t.until > s.round);
  for (const t of ending) emit(d, { type: 'truceExpired', from: t.from, to: t.to, reason: 'time' });
  dip.rebuffs = dip.rebuffs.filter((r) => s.round - r.round < REBUFF_ROUNDS);
}
