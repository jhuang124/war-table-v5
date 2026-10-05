// Territory cards: the deck (one card per territory of the game's map + 2 wilds), set validation, and set
// values. Classic: 42 + 2 = 44 cards.

import { mapOf, type MapRef } from './rules';
import type { Card, CardSymbol, GameConfig, GameState, PlayerId, TerritoryId } from './types';

/** The two wild cards' ids on a map: right after its territory cards (size, size + 1). */
export function wildCardIds(map?: MapRef): [number, number] {
  const n = mapOf(map).size;
  return [n, n + 1];
}

/** Classic's wild card ids (42, 43). A game on another map: `wildCardIds(state)`. */
export const WILD_CARD_IDS = wildCardIds() as readonly [number, number];

/**
 * One card per territory (ids 0..size-1 in the map's canonical territory order, symbols from the pack's
 * cycle) + 2 wilds (size, size + 1). Unshuffled. Absent map = the default (classic).
 */
export function buildDeck(map?: MapRef): Card[] {
  const m = mapOf(map);
  const deck: Card[] = m.territoryIds.map((t, i) => ({ id: i, territory: t, symbol: m.cardSymbols[t] }));
  const [w1, w2] = wildCardIds(m);
  deck.push({ id: w1, territory: null, symbol: 'wild' });
  deck.push({ id: w2, territory: null, symbol: 'wild' });
  return deck;
}

/** Progressive value of the n-th set traded in the game (1-based): 4, 6, 8, 10, 12, 15, 20, 25, … */
export function progressiveValue(tradeIndex: number): number {
  const seq = [4, 6, 8, 10, 12, 15];
  if (tradeIndex <= 0) return seq[0];
  if (tradeIndex <= seq.length) return seq[tradeIndex - 1];
  return 15 + 5 * (tradeIndex - seq.length);
}

const FIXED_VALUE: Record<Exclude<CardSymbol, 'wild'>, number> = { infantry: 4, cavalry: 6, artillery: 8 };
const MIXED_VALUE = 10;
const REAL: Exclude<CardSymbol, 'wild'>[] = ['infantry', 'cavalry', 'artillery'];

/**
 * Fixed value of three symbols, 0 if not a valid set. Wilds take whichever symbol gives the best value.
 */
export function fixedSetValue(symbols: CardSymbol[]): number {
  if (symbols.length !== 3) return 0;
  const real = symbols.filter((s) => s !== 'wild') as Exclude<CardSymbol, 'wild'>[];
  const wilds = 3 - real.length;
  let best = 0;
  // Enumerate every substitution of the wilds.
  const assign = (acc: Exclude<CardSymbol, 'wild'>[], left: number) => {
    if (left === 0) {
      const [a, b, c] = acc;
      if (a === b && b === c) best = Math.max(best, FIXED_VALUE[a]);
      else if (a !== b && b !== c && a !== c) best = Math.max(best, MIXED_VALUE);
      return;
    }
    for (const s of REAL) assign([...acc, s], left - 1);
  };
  assign(real, wilds);
  return best;
}

/** True if three symbols form a set: three alike, one of each, or any two + a wild. */
export function isValidSetSymbols(symbols: CardSymbol[]): boolean {
  return fixedSetValue(symbols) > 0;
}

/** Every valid set (card id triples, ascending ids within a triple) in a hand. */
export function validSets(cards: Card[]): [number, number, number][] {
  const out: [number, number, number][] = [];
  const n = cards.length;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      for (let k = j + 1; k < n; k++) {
        if (isValidSetSymbols([cards[i].symbol, cards[j].symbol, cards[k].symbol])) {
          const ids = [cards[i].id, cards[j].id, cards[k].id].sort((x, y) => x - y) as [number, number, number];
          out.push(ids);
        }
      }
  return out;
}

/** Base armies a set would give for the next trade under the given rules (no +2 territory bonus). */
export function setValueFor(config: Pick<GameConfig, 'cardBonus'>, tradeCount: number, symbols: CardSymbol[]): number {
  const fixed = fixedSetValue(symbols);
  if (fixed === 0) return 0;
  return config.cardBonus === 'fixed' ? fixed : progressiveValue(tradeCount + 1);
}

function findCard(state: GameState, id: number): Card | undefined {
  for (const p of state.players) for (const c of p.cards) if (c.id === id) return c;
  return undefined;
}

/**
 * Armies the next trade of these cards would give (base value, no +2 territory bonus).
 * 0 if the ids don't form a valid set. Cards are looked up in any player's hand.
 */
export function setValue(state: GameState, cardIds: number[]): number {
  if (!Array.isArray(cardIds) || cardIds.length !== 3) return 0;
  const cards = cardIds.map((id) => findCard(state, id));
  if (cards.some((c) => !c)) return 0;
  if (new Set(cardIds).size !== 3) return 0;
  return setValueFor(state.config, state.tradeCount, cards.map((c) => c!.symbol));
}

/** The territory that would get the +2 bonus for this trade (first owned card territory in order), or null. */
export function bonusTerritoryFor(state: GameState, player: PlayerId, cards: Card[]): TerritoryId | null {
  for (const c of cards) {
    if (c.territory && state.territories[c.territory].owner === player) return c.territory;
  }
  return null;
}

/** Progressive values of the next `n` trades (for "Next set +8 · then +10"). Empty in fixed mode. */
export function upcomingSetValues(state: GameState, n = 2): number[] {
  if (state.config.cardBonus === 'fixed') return [];
  return Array.from({ length: n }, (_, i) => progressiveValue(state.tradeCount + 1 + i));
}
