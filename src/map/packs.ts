// Map packs, the rules half (docs/MAPS.md): every pack's manifest, rules and topology, with no
// geometry and no DOM, so the engine (src/engine/mapData.ts) and Node scripts can read it.
// The geometry half (board.json + boot-time selection) is src/map/registry.ts.
//
// Adding a pack: create maps/<id>/ (docs/MAPS.md), then add its JSON imports to PACK_FILES here and its
// board.json to src/map/registry.ts. Static imports on purpose: the game works offline and in Node.

import type { MapManifest, MapRules, MapTopology } from './types';

import classicManifest from '../../maps/classic/pack.json';
import classicRules from '../../maps/classic/rules.json';
import classicTopology from '../../maps/classic/topology.json';
import trueWorldManifest from '../../maps/true-world/pack.json';
import testTwelveManifest from '../../maps/test-twelve/pack.json';
import testTwelveRules from '../../maps/test-twelve/rules.json';
import testTwelveTopology from '../../maps/test-twelve/topology.json';

/** The map a game without `config.mapId` is played on (every save from before map packs). */
export const DEFAULT_MAP_ID = 'classic';

interface PackFiles {
  manifest: MapManifest;
  rules?: MapRules;
  topology?: MapTopology;
}

/** Registration order = the order listMaps() shows them in. */
const PACK_FILES: PackFiles[] = [
  {
    manifest: classicManifest as MapManifest,
    rules: classicRules as unknown as MapRules,
    topology: classicTopology as unknown as MapTopology,
  },
  { manifest: trueWorldManifest as MapManifest },
  // v6: the engine's synthetic test board (12 territories, 3 continents, seats 2-3). Hidden: never in the
  // picker, never booted; the engine plays it so its rules-per-game path is proven before real maps exist.
  {
    manifest: testTwelveManifest as MapManifest,
    rules: testTwelveRules as unknown as MapRules,
    topology: testTwelveTopology as unknown as MapTopology,
  },
];

export interface PackData {
  manifest: MapManifest;
  /** Own or inherited (`manifest.extends`). */
  rules: MapRules;
  topology: MapTopology;
  /** The pack the rules + topology come from (itself unless it extends another). */
  rulesFrom: string;
}

const byId = new Map<string, PackFiles>(PACK_FILES.map((p) => [p.manifest.id, p]));

function resolvePack(id: string, seen: string[] = []): PackData {
  const p = byId.get(id);
  if (!p) throw new Error(`map pack ${id} is not registered`);
  if (p.manifest.extends) {
    if (seen.includes(id)) throw new Error(`map pack ${id}: extends cycle`);
    if (p.rules || p.topology) throw new Error(`map pack ${id}: extends ${p.manifest.extends} and ships its own rules/topology`);
    const base = resolvePack(p.manifest.extends, [...seen, id]);
    return { manifest: p.manifest, rules: base.rules, topology: base.topology, rulesFrom: base.rulesFrom };
  }
  if (!p.rules || !p.topology) throw new Error(`map pack ${id}: missing rules.json or topology.json`);
  return { manifest: p.manifest, rules: p.rules, topology: p.topology, rulesFrom: id };
}

const PACKS = new Map<string, PackData>(PACK_FILES.map((p) => [p.manifest.id, resolvePack(p.manifest.id)]));

/** Every visible pack id (manifest not `hidden`), in picker order. Each has a board.json. */
export function packIds(): string[] {
  return [...PACKS.values()].filter((p) => !p.manifest.hidden).map((p) => p.manifest.id);
}

/** Every registered pack id, hidden ones included (the engine may play any of them). */
export function allPackIds(): string[] {
  return [...PACKS.keys()];
}

/** True for a registered pack the picker and boot never offer (`manifest.hidden`). */
export function isHiddenMap(id: string | null | undefined): boolean {
  return typeof id === 'string' && !!PACKS.get(id)?.manifest.hidden;
}

export function isKnownMap(id: string | null | undefined): id is string {
  return typeof id === 'string' && PACKS.has(id);
}

/**
 * The map id a config (or a raw id) means: its `mapId` when that pack exists, else 'classic'. A save
 * written before map packs has no mapId, so it loads classic.
 */
export function mapIdOf(x?: { mapId?: string } | string | null): string {
  const id = typeof x === 'string' ? x : x?.mapId;
  return isKnownMap(id) ? id : DEFAULT_MAP_ID;
}

/** A pack's manifest + (own or inherited) rules and topology. Unknown ids fall back to classic. */
export function packData(id?: string | null): PackData {
  return PACKS.get(mapIdOf(id))!;
}
