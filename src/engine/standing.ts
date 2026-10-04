// v5.1 C "truces become standing" (_claude/v5/QUIETER.md §3 C). Contract stub written by the lead; the
// standing builder fills it in. Pure: no DOM, no Date.now()/Math.random() (use state.rng).
import type { GameState, PlayerId } from './types';

/** How an AI seat feels about another seat. Hardens from ally → even → wary → hostile. */
export type Standing = 'ally' | 'even' | 'wary' | 'hostile';

/** `ai`'s standing toward `toward`, from recent attacks received, shared borders, who leads, and its personality. */
export function standingOf(_s: GameState, _ai: PlayerId, _toward: PlayerId): Standing {
  return 'even';
}

/** One plain sentence: 'Sage is wary of you · you took Ural last round'. Addressed to the reader when `toward` is human. */
export function standingReason(_s: GameState, _ai: PlayerId, _toward: PlayerId): string {
  return '';
}

/** True when `human` may ask `ai` for peace now (its main turn; once per three rounds per seat; no peace already held). */
export function canAskPeace(_s: GameState, _human: PlayerId, _ai: PlayerId): boolean {
  return false;
}
