// v5 G: secret missions (classic Risk). Contract stub written by the lead; the missions builder fills it in.
// Pure: no DOM, no Date.now()/Math.random() (use state.rng).
import type { GameState, PlayerId } from './types';

export type MissionId = string;

export interface Mission {
  id: MissionId;
  /** The sentence on the hand-off cover / long-press: 'Conquer Asia and Africa'. Plain, no exclamation marks. */
  text: string;
}

/** Every mission the deck can deal (filled in by the missions builder). */
export const MISSIONS: readonly Mission[] = [];

/** The mission's sentence for `player`, addressed as a fact ('Vermilion must hold Asia and Africa'); null without one. */
export function missionText(_s: GameState, _player: PlayerId): string | null {
  return null;
}

/** True when `player`'s mission is met on the current board. */
export function missionComplete(_s: GameState, _player: PlayerId): boolean {
  return false;
}
