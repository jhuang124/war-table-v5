// Pure game-side helpers (SPEC §7 Controller): all derived from state + mapData + engine helpers.
// bestSet, occupyDefault, autoSource, autoChain, oddsWord, plus the card-status line.

import {
  bonusTerritoryFor,
  mapDefOf,
  setValue,
  validSets,
  type Card,
  type CardSymbol,
  type GameState,
  type PlayerId,
  type TerritoryId,
} from '../engine';
import { SEP, pct } from './copy';

// ---------------------------------------------------------------------------
// Odds
// ---------------------------------------------------------------------------

export type OddsWord = 'almost sure' | 'likely' | 'coin flip' | 'long shot';

/** UX.md §5.1 bands on the displayed (rounded) percent: ≥85 almost sure, 60–84 likely, 40–59 coin flip, <40 long shot. */
export function oddsWord(p: number): OddsWord {
  const v = pct(p);
  if (v >= 85) return 'almost sure';
  if (v >= 60) return 'likely';
  if (v >= 40) return 'coin flip';
  return 'long shot';
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

export interface BestSet {
  cardIds: [number, number, number];
  value: number;
  bonusTerritory: TerritoryId | null;
}

/** Best trade in `player`'s hand: max setValue, then the +2 territory bonus, then keep wilds. */
export function bestSet(state: GameState, player: PlayerId): BestSet | null {
  const hand = state.players[player]?.cards ?? [];
  if (hand.length < 3) return null;
  let best: (BestSet & { wilds: number }) | null = null;
  for (const ids of validSets(hand)) {
    const cards = ids.map((id) => hand.find((c) => c.id === id)!) as Card[];
    const value = setValue(state, ids);
    const bonusTerritory = bonusTerritoryFor(state, player, cards);
    const wilds = cards.filter((c) => c.symbol === 'wild').length;
    const better =
      !best ||
      value > best.value ||
      (value === best.value && !!bonusTerritory && !best.bonusTerritory) ||
      (value === best.value && !!bonusTerritory === !!best.bonusTerritory && wilds < best.wilds);
    if (better) best = { cardIds: ids, value, bonusTerritory, wilds };
  }
  if (!best) return null;
  return { cardIds: best.cardIds, value: best.value, bonusTerritory: best.bonusTerritory };
}

const KIND_NAMES: Record<Exclude<CardSymbol, 'wild'>, string> = {
  infantry: 'infantry',
  cavalry: 'cavalry',
  artillery: 'artillery',
};

/** Card status when there's no valid set (UX.md §7.5), e.g. 'Need 1 artillery, or a third match'. */
export function noSetStatus(hand: Card[]): string {
  const n = hand.length;
  if (n === 0) return `No cards yet${SEP}conquer a territory to earn one`;
  if (n === 1) return 'Need 2 more cards';
  const counts: Record<string, number> = { infantry: 0, cavalry: 0, artillery: 0 };
  for (const c of hand) if (c.symbol !== 'wild') counts[c.symbol]++;
  const kinds = (Object.keys(KIND_NAMES) as Exclude<CardSymbol, 'wild'>[]).filter((k) => counts[k] > 0);
  const missing = (Object.keys(KIND_NAMES) as Exclude<CardSymbol, 'wild'>[]).filter((k) => counts[k] === 0);
  if (n === 2) {
    if (kinds.length === 1) return `Need a third ${KIND_NAMES[kinds[0]]}, or a wild`;
    return `Need 1 ${KIND_NAMES[missing[0]]}, or a wild`;
  }
  // 3+ cards and no set: exactly two kinds, at most two of each, no wild.
  const pairs = kinds.filter((k) => counts[k] === 2);
  const third = pairs.length === 1 ? `a third ${KIND_NAMES[pairs[0]]}` : 'a third match';
  return missing.length ? `Need 1 ${KIND_NAMES[missing[0]]}, or ${third}` : `Need 1 more of any kind, or ${third}`;
}

// ---------------------------------------------------------------------------
// Occupy default (UX.md §3.3)
// ---------------------------------------------------------------------------

function enemyNeighbors(state: GameState, t: TerritoryId, owner: PlayerId): TerritoryId[] {
  return mapDefOf(state.config).adjacency[t].filter((n) => state.territories[n].owner !== owner && state.territories[n].owner >= 0);
}

/**
 * Smart occupy default, a pure function of adjacency. `state` is the occupy-phase state (`to` already
 * belongs to the attacker). The front moves forward (max) unless `to` is safe and `from` still borders
 * enemies, in which case the stack stays home (min).
 */
export function occupyDefault(state: GameState, from: TerritoryId, to: TerritoryId, min: number, max: number): number {
  const me = state.territories[from].owner;
  const toEnemies = enemyNeighbors(state, to, me);
  const fromEnemies = enemyNeighbors(state, from, me);
  return toEnemies.length === 0 && fromEnemies.length > 0 ? min : max;
}

// ---------------------------------------------------------------------------
// Target-first attack source (UX.md §3.3)
// ---------------------------------------------------------------------------

/**
 * The attacker's adjacent territory with the most armies (≥ 2) that can hit `target`. Ties go to the
 * one with more enemy-free sides (fewer enemy neighbors), then TERRITORY_IDS order. null if none.
 */
export function autoSource(state: GameState, target: TerritoryId, player: PlayerId = state.currentPlayer): TerritoryId | null {
  const tOwner = state.territories[target]?.owner;
  if (tOwner === undefined || tOwner === player || tOwner < 0) return null;
  let best: TerritoryId | null = null;
  let bestArmies = -1;
  let bestSafe = -1;
  for (const n of mapDefOf(state.config).adjacency[target]) {
    const ts = state.territories[n];
    if (ts.owner !== player || ts.armies < 2) continue;
    const safe = mapDefOf(state.config).adjacency[n].length - enemyNeighbors(state, n, player).length;
    const better =
      ts.armies > bestArmies ||
      (ts.armies === bestArmies && safe > bestSafe) ||
      (ts.armies === bestArmies && safe === bestSafe && best !== null && mapDefOf(state.config).territoryIds.indexOf(n) < mapDefOf(state.config).territoryIds.indexOf(best));
    if (better) {
      best = n;
      bestArmies = ts.armies;
      bestSafe = safe;
    }
  }
  return best;
}

/** True if `t` can attack right now (own, ≥ 2 armies, an enemy next door). */
export function canAttackFrom(state: GameState, t: TerritoryId, player: PlayerId = state.currentPlayer): boolean {
  const ts = state.territories[t];
  return ts.owner === player && ts.armies >= 2 && enemyNeighbors(state, t, player).length > 0;
}

/**
 * Auto-chain after an occupy (UX.md §3.3): select `to` if it can attack, else keep `from` if it still
 * can, else nothing. `state` is the state after the occupy move.
 */
export function autoChain(state: GameState, from: TerritoryId, to: TerritoryId): TerritoryId | null {
  const p = state.territories[to].owner;
  if (canAttackFrom(state, to, p)) return to;
  if (canAttackFrom(state, from, p)) return from;
  return null;
}

/** Own territories bordering `t`, any army count. */
export function ownNeighbors(state: GameState, t: TerritoryId, player: PlayerId): TerritoryId[] {
  return mapDefOf(state.config).adjacency[t].filter((n) => state.territories[n].owner === player);
}
