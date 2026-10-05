// v5 G: secret missions (classic Risk), a house rule (config.missions, off by default).
// Pure: no DOM, no Date.now()/Math.random() (the deal uses state.rng).
//
// The deck, per map (v6): continent missions, two territory-count missions, and one "knock out a colour"
// card per seat colour at the table. Each seat (never the 2-player neutral) is dealt one at createGame.
// A colour card naming your own colour, or a seat someone else has already knocked out, reads as "hold
// N territories" instead (24 on classic).
//
// Classic (and every pack that plays classic's rules, e.g. true-world) deals the boxed game's six
// continent cards. Any other map builds its continent cards from its own continents: every pair whose
// combined territory count is 25-45 % of the board (at most six, the ones nearest 35 %). The count cards
// scale with the board: 43 % with 2 armies on each, and 57 % (classic: 18 and 24 of 42).
//
// The rule needs a third seat (3–4 players, or 2 with the neutral seat): two players on half the board
// each meet a mission in round 2 or 3, so sanitizeConfig drops config.missions for that table.

import type { MapDef } from './mapData';
import { packData } from '../map/packs';
import { continentName, mapOf, type MapRef } from './rules';
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

/** Shares of the board the two count cards ask for (classic: 24 and 18 of 42). */
const CONQUER_SHARE = 0.57;
const HOLD_SHARE = 0.43;
/** Continent-pair cards on a non-classic map: combined size within this share of the board. */
const PAIR_MIN_SHARE = 0.25;
const PAIR_MAX_SHARE = 0.45;
const PAIR_TARGET_SHARE = 0.35;
const MAX_PAIR_CARDS = 6;

/** The count cards on a map: 'Conquer N territories' (and the colour card's fallback), and 'Hold M with 2 on each'. */
export function missionTerritories(map?: MapRef): { count: number; held: { count: number; minArmies: number } } {
  const size = mapOf(map).size;
  return { count: Math.round(size * CONQUER_SHARE), held: { count: Math.round(size * HOLD_SHARE), minArmies: 2 } };
}

/** Classic's '24 territories' card and colour-card fallback. A game on another map: `missionTerritories(state)`. */
export const MISSION_TERRITORIES = missionTerritories().count;
/** Classic's '18 territories with at least 2 armies on each' card. */
export const MISSION_TERRITORIES_HELD = missionTerritories().held;

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

const cname = (c: ContinentId, map: MapRef): string => continentName(c, map);

/** 'Asia and Africa' / 'Europe, South America and Africa'. */
function andList(xs: string[]): string {
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

function continentMission(def: MapDef, id: string, continents: ContinentId[], plusOne = false): Mission {
  const names = continents.map((c) => cname(c, def));
  return {
    id,
    text: `Conquer ${plusOne ? `${names.join(', ')} and one more continent` : andList(names)}`,
    spec: { kind: 'continents', continents, plusOne },
  };
}

/** The boxed game's six continent cards, for classic's continents (packs that play classic's rules). */
const BOXED: [string, ContinentId[], boolean][] = [
  ['north-america-africa', ['north_america', 'africa'], false],
  ['north-america-australia', ['north_america', 'australia'], false],
  ['asia-south-america', ['asia', 'south_america'], false],
  ['asia-africa', ['asia', 'africa'], false],
  ['europe-south-america-plus', ['europe', 'south_america'], true],
  ['europe-australia-plus', ['europe', 'australia'], true],
];

const slug = (c: ContinentId) => c.replace(/_/g, '-');

/** A non-classic map's continent cards: pairs at 25-45 % of the board, at most six, nearest 35 % first. */
function pairCards(def: MapDef): Mission[] {
  const lo = def.size * PAIR_MIN_SHARE;
  const hi = def.size * PAIR_MAX_SHARE;
  const pairs: { a: ContinentId; b: ContinentId; n: number; i: number }[] = [];
  const ids = def.continentIds;
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const n = def.continents[ids[i]].territories.length + def.continents[ids[j]].territories.length;
      if (n >= lo && n <= hi) pairs.push({ a: ids[i], b: ids[j], n, i: pairs.length });
    }
  const target = def.size * PAIR_TARGET_SHARE;
  const kept = [...pairs]
    .sort((x, y) => Math.abs(x.n - target) - Math.abs(y.n - target) || x.i - y.i)
    .slice(0, MAX_PAIR_CARDS)
    .sort((x, y) => x.i - y.i);
  return kept.map((p) => continentMission(def, `${slug(p.a)}-${slug(p.b)}`, [p.a, p.b]));
}

function buildMissions(def: MapDef): Mission[] {
  const boxed = packData(def.id).rulesFrom === 'classic';
  const { count, held } = missionTerritories(def);
  return [
    ...(boxed ? BOXED.map(([id, cs, plus]) => continentMission(def, id, cs, plus)) : pairCards(def)),
    {
      id: `territories-${held.count}-two`,
      text: `Hold ${held.count} territories with at least ${held.minArmies} armies on each`,
      spec: { kind: 'territories', ...held },
    },
    {
      id: `territories-${count}`,
      text: `Conquer ${count} territories`,
      spec: { kind: 'territories', count, minArmies: 1 },
    },
    ...SEAT_COLORS.map(
      (color): Mission => ({ id: `destroy-${color}`, text: `Knock out ${COLOR_NAMES[color]}`, spec: { kind: 'destroy', color } }),
    ),
  ];
}

const DECKS = new Map<string, { list: readonly Mission[]; byId: Map<string, Mission> }>();

function deckOf(map?: MapRef): { list: readonly Mission[]; byId: Map<string, Mission> } {
  const def = mapOf(map);
  let d = DECKS.get(def.id);
  if (!d) {
    const list = buildMissions(def);
    d = { list, byId: new Map(list.map((m) => [m.id, m])) };
    DECKS.set(def.id, d);
  }
  return d;
}

/** Every mission a map's deck can deal. The colour cards in a given game are only the colours at its table. */
export function missionsFor(map?: MapRef): readonly Mission[] {
  return deckOf(map).list;
}

/** Classic's deck (the boxed game). A game on another map: `missionsFor(state)`. */
export const MISSIONS: readonly Mission[] = missionsFor();

/** The mission card with this id on the game's map (absent map = classic), or null. */
export function missionById(id: string | undefined, map?: MapRef): Mission | null {
  return (id && deckOf(map).byId.get(id)) || null;
}

/** The ids a table's deck holds: every continent and count card, and the colour cards of its seats. */
export function missionDeckFor(s: GameState): MissionId[] {
  const seats = s.players.filter((p) => !p.neutral);
  return missionsFor(s).filter((m) => m.spec.kind !== 'destroy' || seats.some((p) => p.color === (m.spec as { color: string }).color)).map(
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
  const m = missionById(p?.mission, s);
  if (!p || p.neutral || !m) return null;
  const spec = m.spec;
  if (spec.kind === 'continents') return { kind: 'continents', continents: spec.continents, plusOne: spec.plusOne };
  if (spec.kind === 'territories') return { kind: 'territories', count: spec.count, minArmies: spec.minArmies };
  const target = seatOfColor(s, spec.color);
  const t = s.players[target];
  if (target < 0 || target === player || (t.eliminated && t.eliminatedBy !== player))
    return { kind: 'territories', count: missionTerritories(s).count, minArmies: 1 };
  return { kind: 'destroy', target };
}

function ownsAll(s: GameState, player: PlayerId, c: ContinentId): boolean {
  return mapOf(s).continents[c].territories.every((t) => s.territories[t].owner === player);
}

/** Territories `player` holds with at least `minArmies` armies. */
export function missionTerritoryCount(s: GameState, player: PlayerId, minArmies = 1): number {
  let n = 0;
  for (const t of mapOf(s).territoryIds) {
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
      return !g.plusOne || mapOf(s).continentIds.some((c) => !g.continents.includes(c) && ownsAll(s, player, c));
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
  const m = missionById(p?.mission, s);
  const g = missionGoal(s, player);
  if (!p || !m || !g || !s.config.missions) return null;
  const who = p.name;
  switch (g.kind) {
    case 'continents': {
      const names = g.continents.map((c) => cname(c, s));
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
        const third = mapOf(s).continentIds.find((c) => !g.continents.includes(c) && ownsAll(s, player, c));
        if (third) held.push(third);
      }
      const names = held.map((c) => cname(c, s));
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
