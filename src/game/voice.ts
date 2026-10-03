// v5 D "presence of the opponents": an AI seat says one plain line at the right time, in its personality's
// voice (src/engine/ai/personality.ts VOICE). At most one line per turn; the seat chip keeps the last line it
// said until its own next turn. Grievances (a human attacked it, a truce was broken against it) wait for the
// seat's next turn and are said as it begins.

import { VOICE, type VoiceKind } from '../engine/ai/personality';
import type { GameState, PlayerId } from '../engine';

export type { VoiceKind };

export interface VoiceVars {
  by?: string;
  continent?: string;
  victim?: string;
}

export interface VoiceEntry {
  turn: number;
  round: number;
  seat: PlayerId;
  kind: VoiceKind;
  text: string;
}

/** The longest a filled-in line may run (the one line's budget). */
export const VOICE_MAX = 60;

export function fillVoice(tpl: string, name: string, v: VoiceVars): string {
  return tpl
    .replace(/\{name\}/g, name)
    .replace(/\{by\}/g, v.by ?? 'someone')
    .replace(/\{continent\}/g, v.continent ?? 'it')
    .replace(/\{victim\}/g, v.victim ?? 'someone');
}

/**
 * The line `seat` says for `kind`: a variant chosen by the turn (deterministic, no Math.random), never the
 * same words twice in a row, and never over VOICE_MAX (a shorter variant, else the first, which is short).
 */
export function voiceText(s: GameState, seat: PlayerId, kind: VoiceKind, v: VoiceVars, turn: number, last?: string): string | null {
  const p = s.players[seat];
  if (!p || p.kind !== 'ai' || !p.personality || p.neutral) return null;
  const set = VOICE[p.personality]?.[kind];
  if (!set?.length) return null;
  const all = set.map((t) => fillVoice(t, p.name, v));
  const fits = all.filter((t) => t.length <= VOICE_MAX);
  const pool = fits.length ? fits : [all[0]];
  let i = Math.abs(turn * 7 + seat * 3) % pool.length;
  if (pool.length > 1 && pool[i] === last) i = (i + 1) % pool.length;
  return pool[i];
}

export class Voices {
  /** The line each seat said last (SeatChipVM.voiceLine). */
  bySeat: Record<number, string> = {};
  /** Every line said this game, oldest first (the `__risk.voiceLines()` hook). */
  log: VoiceEntry[] = [];
  /** The words each seat said last, kept across turns (never the same words twice in a row). */
  private lastSaid: Record<number, string> = {};
  /** 'seat|continent' pairs already said. */
  private continents = new Set<string>();
  /** The turn a line was last said in: one per turn. */
  private spokenTurn = -1;
  /** Per AI seat, what it will say as its next turn begins. */
  grievance: Record<number, { by: PlayerId; kind: 'attacked' | 'truceBroken' }> = {};

  /** A line was already said this turn. */
  spoken(turn: number): boolean {
    return this.spokenTurn === turn;
  }

  /** Say it (if the seat has a voice and nothing was said this turn). Returns the entry, or null. */
  say(s: GameState, seat: PlayerId, kind: VoiceKind, v: VoiceVars, turn: number): VoiceEntry | null {
    if (this.spoken(turn)) return null;
    // A continent is news the first time a seat takes it; taking it back again is not worth a line.
    const once = kind === 'continent' ? `${seat}|${v.continent ?? ''}` : null;
    if (once && this.continents.has(once)) return null;
    const text = voiceText(s, seat, kind, v, turn, this.lastSaid[seat]);
    if (!text) return null;
    this.spokenTurn = turn;
    if (once) this.continents.add(once);
    this.lastSaid[seat] = text;
    this.bySeat = { ...this.bySeat, [seat]: text };
    const e: VoiceEntry = { turn, round: s.round, seat, kind, text };
    this.log.push(e);
    if (this.log.length > 200) this.log.shift();
    return e;
  }

  /** A grievance against `seat` (a truce broken outranks an attack; the latest offender is the one named). */
  aggrieve(seat: PlayerId, by: PlayerId, kind: 'attacked' | 'truceBroken'): void {
    const g = this.grievance[seat];
    if (g && g.kind === 'truceBroken' && kind === 'attacked') return;
    this.grievance[seat] = { by, kind };
  }

  /** `seat`'s turn begins: its last line is spent; a waiting grievance is returned (and cleared). */
  turnBegins(seat: PlayerId): { by: PlayerId; kind: 'attacked' | 'truceBroken' } | null {
    if (this.bySeat[seat] !== undefined) {
      const next = { ...this.bySeat };
      delete next[seat];
      this.bySeat = next;
    }
    const g = this.grievance[seat];
    if (!g) return null;
    delete this.grievance[seat];
    return { by: g.by, kind: g.kind };
  }
}
