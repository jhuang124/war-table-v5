// AI personalities: how a seat plays on top of its difficulty. A personality bends the difficulty's
// Persona (src/engine/ai/persona.ts) and adds the table-talk knobs: grudges and truces. A seat with no
// personality is the classic AI, byte for byte (the brain skips every branch below).

import type { AiDifficulty, AiPersonality } from '../types';
import { PERSONAS, type Persona } from './persona';

export interface PersonalityInfo {
  id: AiPersonality;
  name: string;
  /** One plain line for the seat picker. */
  line: string;
}

export const PERSONALITY_IDS: AiPersonality[] = ['turtle', 'opportunist', 'warlord'];

export const PERSONALITIES: Record<AiPersonality, PersonalityInfo> = {
  turtle: { id: 'turtle', name: 'Turtle', line: 'Builds and holds continents. Keeps its word.' },
  opportunist: { id: 'opportunist', name: 'Opportunist', line: 'Hits weak neighbours and avoids fair fights.' },
  warlord: { id: 'warlord', name: 'Warlord', line: 'Presses attacks and chases eliminations. Remembers who hurt it.' },
};

export function isPersonality(x: unknown): x is AiPersonality {
  return x === 'turtle' || x === 'opportunist' || x === 'warlord';
}

/** The table-talk knobs a personality adds (the classic AI has none of these). */
export interface Temperament {
  /** Target value added per point of grudge against the territory's owner (grudge capped at 4). */
  grudgeWeight: number;
  /** Opportunist: bonus for lopsided attacks (attacker ≥ 3× defender), scaled by this. */
  weakBias: number;
  /** Opportunist: penalty for near-even fights (attacker < 1.6× defender). */
  fairFightPenalty: number;
  /** Turtle: penalty for attacks outside the continents it is building. */
  homeBias: number;
  /** Warlord: bonus for attacking real stacks (not just empty land), scaled by the defender's size. */
  pressBias: number;
  /** How much of a truce partner's border stack still counts as a threat (0..1). */
  trust: number;
  /** Baseline willingness to accept an offer (added to the offer score). */
  acceptBias: number;
  /** Willingness to propose (multiplies the proposal score). 0 = never proposes. */
  proposeBias: number;
  /** Attack score needed to break a truce. Infinity = never breaks. */
  breakBar: number;
  /** Truce length it proposes, in rounds. */
  truceRounds: number;
}

export const TEMPERAMENTS: Record<AiPersonality, Temperament> = {
  turtle: {
    grudgeWeight: 0.8,
    weakBias: 0,
    fairFightPenalty: 0,
    homeBias: 1.6,
    pressBias: 0,
    trust: 0.35,
    acceptBias: 0.1,
    proposeBias: 0.8,
    breakBar: Infinity,
    truceRounds: 3,
  },
  opportunist: {
    grudgeWeight: 0.5,
    weakBias: 1.4,
    fairFightPenalty: 1.1,
    homeBias: 0,
    pressBias: 0,
    trust: 0.5,
    acceptBias: 0.5,
    proposeBias: 1,
    breakBar: 7,
    truceRounds: 3,
  },
  warlord: {
    grudgeWeight: 1.6,
    weakBias: 0,
    fairFightPenalty: 0,
    homeBias: 0,
    pressBias: 1.2,
    trust: 0.6,
    acceptBias: 0.2,
    proposeBias: 0.8,
    breakBar: 8,
    truceRounds: 2,
  },
};

/** The difficulty's Persona, bent by the personality. Unset personality = the difficulty's Persona as is. */
export function personaFor(difficulty: AiDifficulty, personality?: AiPersonality): Persona {
  const p = PERSONAS[difficulty];
  if (!personality) return p;
  switch (personality) {
    case 'turtle':
      return {
        ...p,
        attackThreshold: Math.min(0.92, p.attackThreshold + 0.1),
        goalWeight: p.goalWeight * 1.4,
        completeWeight: p.completeWeight * 1.3,
        breakWeight: p.breakWeight * 0.7,
        elimWeight: p.elimWeight * 0.6,
        leaderWeight: p.leaderWeight * 0.6,
        defenseShare: p.concentrate ? Math.min(0.7, p.defenseShare + 0.15) : 0,
        overextendCare: p.overextendCare + 0.6,
        keepReserve: p.concentrate ? true : p.keepReserve,
        deter: p.concentrate ? Math.max(p.deter, 0.3) : 0,
      };
    case 'opportunist':
      return {
        ...p,
        attackThreshold: Math.min(0.92, p.attackThreshold + 0.08),
        cardGrabThreshold: Math.min(0.95, p.cardGrabThreshold + 0.08),
        elimWeight: p.elimWeight * 1.6,
        leaderWeight: 0,
        hunt: p.concentrate ? true : p.hunt,
      };
    case 'warlord':
      return {
        ...p,
        attackThreshold: Math.max(0.5, p.attackThreshold - 0.06),
        cardGrabThreshold: Math.max(0.5, p.cardGrabThreshold - 0.04),
        elimWeight: p.elimWeight * 2.5,
        leaderWeight: p.leaderWeight + 0.4,
        defenseShare: p.defenseShare * 0.6,
        overextendCare: p.overextendCare * 0.4,
        hunt: p.concentrate ? true : p.hunt,
        lookahead: p.concentrate ? Math.max(p.lookahead, 2) : p.lookahead,
      };
  }
}

// ---------------------------------------------------------------------------
// v5 D "presence of the opponents": each personality's few plain lines. Name first, no exclamation marks,
// no quotes, ≤ 60 characters once filled in. {name} the speaker, {by} who did it, {continent}, {victim}.
// The controller picks one per AI turn at most (src/game/voice.ts).
// ---------------------------------------------------------------------------

export type VoiceKind = 'attacked' | 'continent' | 'truceBroken' | 'out' | 'eliminates';

export const VOICE: Record<AiPersonality, Record<VoiceKind, readonly string[]>> = {
  turtle: {
    attacked: ['{name} remembers that', '{name} will not forget {by}', '{name} digs in against {by}'],
    continent: ['{name} holds {continent} · it will keep it', '{name} has {continent} · it is staying'],
    truceBroken: ['{name} kept its word · {by} did not', '{name} trusted {by} · never again'],
    out: ['{name} is out · it blames {by}', '{name} is out · {by} did that'],
    eliminates: ['{name} has put {victim} out', '{name} took the last of {victim}'],
  },
  opportunist: {
    attacked: ['{name} remembers that', '{name} will wait for {by} to slip', '{name} saw that, {by}'],
    continent: ['{name} holds {continent} · nobody was watching', '{name} holds {continent} · it came cheap'],
    truceBroken: ['{name} expected that from {by}', '{name} will remember the truce {by} broke'],
    out: ['{name} is out · it blames {by}', '{name} is out · {by} got lucky'],
    eliminates: ['{name} finishes {victim}', '{name} saw {victim} was weak'],
  },
  warlord: {
    attacked: ['{name} remembers that', '{name} is coming for {by}', '{name} will answer {by}'],
    continent: ['{name} holds {continent} · come and take it', '{name} holds {continent} · it will keep it'],
    truceBroken: ['{name} will make {by} pay for that', '{name} remembers the truce {by} broke'],
    out: ['{name} is out · it blames {by}', '{name} is out · {by} took everything'],
    eliminates: ['{name} has knocked out {victim}', '{name} is done with {victim}'],
  },
};
