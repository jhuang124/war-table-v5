// v5 G: secret missions (classic Risk), a house rule (config.missions, off by default).
// Pure: no DOM, no Date.now()/Math.random() (the deal uses state.rng).
//
// The deck, as in the boxed game: six continent missions, two territory-count missions, and one
// "knock out a colour" card per seat colour at the table. Each seat (never the 2-player neutral) is
// dealt one at createGame. A colour card naming your own colour, or a seat someone else has already
// knocked out, reads as "hold 24 territories" instead.
//
// The rule needs a third seat (3–4 players, or 2 with the neutral seat): two players on 21 territories
// each meet a mission in round 2 or 3, so sanitizeConfig drops config.missions for that table.

import { CONTINENTS, CONTINENT_IDS, TERRITORY_IDS } from './mapData';
import { shuffleInPlace } from './rng';
import type { ContinentId, GameState, PlayerColorId, PlayerId } from './types';

export type MissionId = string;

/** What a mission asks for, before any fallback. */
export type MissionSpec =
  | { kind: 'continents'; continents: ContinentId[]; /** And one more continent of your choice. */ plusOne: boolean }
  | { kind: 'territories'; count: number; /** Armies each counted territory must hold. */ minArmies: number }
  | { kind: 'destroy'; color: Exclude<PlayerColorId, 'neutral'> };

export interface Mission {
  id: MissionId;
  /** The card's own sentence: 'Conquer Asia and Africa'. Plain, no exclamation marks. */
  text: string;
  /** Additive: what the mission asks for (the win check and the AI read this). */
  spec: MissionSpec;
}

/**
 * What a seat must do right now, after the colour card's fallback: the AI plans on this and
 * `missionComplete` checks it.
 */
export type MissionGoal =
  | { kind: 'continents'; continents: ContinentId[]; plusOne: boolean }
  | { kind: 'territories'; count: number; minArmies: number }
  | { kind: 'destroy'; target: PlayerId };

/** Territories for the '24 territories' card and the colour card's fallback. */
export const MISSION_TERRITORIES = 24;
/** The '18 territories with at least 2 armies on each' card. */
export const MISSION_TERRITORIES_HELD = { count: 18, minArmies: 2 };

/** Seat colour names (mirrors src/shared/palette.ts PLAYER_COLORS[].name; the engine keeps no palette). */
const COLOR_NAMES: Record<Exclude<PlayerColorId, 'neutral'>, string> = {
  crimson: 'Vermilion',
  cobalt: 'Slate',
  emerald: 'Sage',
  amber: 'Ochre',
  violet: 'Wisteria',
  rose: 'Plum',
};
const SEAT_COLORS = Object.keys(COLOR_NAMES) as Exclude<PlayerColorId, 'neutral'>[];

const cname = (c: ContinentId): string => CONTINENTS[c].name;

/** 'Asia and Africa' / 'Europe, South America and Africa'. */
function andList(xs: string[]): string {
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

function continentMission(id: string, continents: ContinentId[], plusOne = false): Mission {
  const names = continents.map(cname);
  return {
    id,
    text: `Conquer ${plusOne ? `${names.join(', ')} and one more continent` : andList(names)}`,
    spec: { kind: 'continents', continents, plusOne },
  };
}

/** Every mission the deck can deal. The colour cards in a given game are only the colours at its table. */
export const MISSIONS: readonly Mission[] = [
  continentMission('north-america-africa', ['north_america', 'africa']),
  continentMission('north-america-australia', ['north_america', 'australia']),
  continentMission('asia-south-america', ['asia', 'south_america']),
  continentMission('asia-africa', ['asia', 'africa']),
  continentMission('europe-south-america-plus', ['europe', 'south_america'], true),
  continentMission('europe-australia-plus', ['europe', 'australia'], true),
  {
    id: 'territories-18-two',
    text: `Hold ${MISSION_TERRITORIES_HELD.count} territories with at least ${MISSION_TERRITORIES_HELD.minArmies} armies on each`,
    spec: { kind: 'territories', ...MISSION_TERRITORIES_HELD },
  },
  {
    id: 'territories-24',
    text: `Conquer ${MISSION_TERRITORIES} territories`,
    spec: { kind: 'territories', count: MISSION_TERRITORIES, minArmies: 1 },
  },
  ...SEAT_COLORS.map(
    (color): Mission => ({ id: `destroy-${color}`, text: `Knock out ${COLOR_NAMES[color]}`, spec: { kind: 'destroy', color } }),
  ),
];

const BY_ID = new Map(MISSIONS.map((m) => [m.id, m]));

/** The mission card with this id, or null. */
export function missionById(id: string | undefined): Mission | null {
  return (id && BY_ID.get(id)) || null;
}

/** The ids a table's deck holds: every continent and count card, and the colour cards of its seats. */
export function missionDeckFor(s: GameState): MissionId[] {
  const seats = s.players.filter((p) => !p.neutral);
  return MISSIONS.filter((m) => m.spec.kind !== 'destroy' || seats.some((p) => p.color === (m.spec as { color: string }).color)).map(
    (m) => m.id,
  );
}

/** Deal one mission per seat (not the neutral) with state.rng. Mutates `s` (a draft); setup calls it. */
export function dealMissions(s: GameState): void {
  const deck = shuffleInPlace(s, missionDeckFor(s));
  let i = 0;
  for (const p of s.players) {
    if (p.neutral) continue;
    p.mission = deck[i++ % deck.length];
  }
}

function seatOfColor(s: GameState, color: PlayerColorId): PlayerId {
  return s.players.findIndex((p) => p.color === color && !p.neutral);
}

/** What `player` must do now (with the colour card's fallback applied), or null without a mission. */
export function missionGoal(s: GameState, player: PlayerId): MissionGoal | null {
  const p = s.players[player];
  const m = missionById(p?.mission);
  if (!p || p.neutral || !m) return null;
  const spec = m.spec;
  if (spec.kind === 'continents') return { kind: 'continents', continents: spec.continents, plusOne: spec.plusOne };
  if (spec.kind === 'territories') return { kind: 'territories', count: spec.count, minArmies: spec.minArmies };
  const target = seatOfColor(s, spec.color);
  const t = s.players[target];
  if (target < 0 || target === player || (t.eliminated && t.eliminatedBy !== player))
    return { kind: 'territories', count: MISSION_TERRITORIES, minArmies: 1 };
  return { kind: 'destroy', target };
}

function ownsAll(s: GameState, player: PlayerId, c: ContinentId): boolean {
  return CONTINENTS[c].territories.every((t) => s.territories[t].owner === player);
}

/** Territories `player` holds with at least `minArmies` armies. */
export function missionTerritoryCount(s: GameState, player: PlayerId, minArmies = 1): number {
  let n = 0;
  for (const t of TERRITORY_IDS) {
    const x = s.territories[t];
    if (x.owner === player && x.armies >= minArmies) n++;
  }
  return n;
}

/** True when `player`'s mission is met on the current board. False without a mission or once out. */
export function missionComplete(s: GameState, player: PlayerId): boolean {
  if (!s.config.missions) return false;
  const p = s.players[player];
  if (!p || p.eliminated) return false;
  const g = missionGoal(s, player);
  if (!g) return false;
  switch (g.kind) {
    case 'continents': {
      if (!g.continents.every((c) => ownsAll(s, player, c))) return false;
      return !g.plusOne || CONTINENT_IDS.some((c) => !g.continents.includes(c) && ownsAll(s, player, c));
    }
    case 'territories':
      return missionTerritoryCount(s, player, g.minArmies) >= g.count;
    case 'destroy': {
      const t = s.players[g.target];
      return t.eliminated && t.eliminatedBy === player;
    }
  }
}

function targetName(s: GameState, target: PlayerId): string {
  const t = s.players[target];
  const colour = COLOR_NAMES[t.color as Exclude<PlayerColorId, 'neutral'>] ?? t.name;
  return t.name === colour ? t.name : `${t.name} (${colour})`;
}

/**
 * The mission's sentence for `player`, addressed as a fact: 'Vermilion must hold Asia and Africa'.
 * Null without one (missions off, or the neutral seat). A colour card that fell back says why.
 */
export function missionText(s: GameState, player: PlayerId): string | null {
  const p = s.players[player];
  const m = missionById(p?.mission);
  const g = missionGoal(s, player);
  if (!p || !m || !g || !s.config.missions) return null;
  const who = p.name;
  switch (g.kind) {
    case 'continents': {
      const names = g.continents.map(cname);
      return g.plusOne
        ? `${who} must hold ${names.join(', ')} and one more continent`
        : `${who} must hold ${andList(names)}`;
    }
    case 'territories': {
      if (m.spec.kind === 'destroy') {
        const t = seatOfColor(s, m.spec.color);
        const why = t === player || t < 0 ? '' : `, since ${targetName(s, t)} is out`;
        return `${who} must hold ${g.count} territories${why}`;
      }
      return g.minArmies > 1
        ? `${who} must hold ${g.count} territories with at least ${g.minArmies} armies on each`
        : `${who} must hold ${g.count} territories`;
    }
    case 'destroy':
      return `${who} must knock out ${targetName(s, g.target)}`;
  }
}

/**
 * The mission met, as the recap's headline: 'Vermilion holds Asia and Africa', 'Vermilion knocked out
 * Slate', 'Vermilion holds 24 territories'. Null without a mission.
 */
export function missionHeadline(s: GameState, player: PlayerId): string | null {
  const p = s.players[player];
  const g = missionGoal(s, player);
  if (!p || !g || !s.config.missions) return null;
  const who = p.name;
  switch (g.kind) {
    case 'continents': {
      const held = [...g.continents];
      if (g.plusOne) {
        const third = CONTINENT_IDS.find((c) => !g.continents.includes(c) && ownsAll(s, player, c));
        if (third) held.push(third);
      }
      const names = held.map(cname);
      return g.plusOne && held.length === g.continents.length
        ? `${who} holds ${names.join(', ')} and one more continent`
        : `${who} holds ${andList(names)}`;
    }
    case 'territories':
      return g.minArmies > 1
        ? `${who} holds ${g.count} territories with at least ${g.minArmies} armies on each`
        : `${who} holds ${g.count} territories`;
    case 'destroy':
      return `${who} knocked out ${targetName(s, g.target)}`;
  }
}
