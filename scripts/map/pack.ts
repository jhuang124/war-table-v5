// Node-side map-pack loader for the build + verify scripts (docs/MAPS.md). Reads maps/<id>/ from disk,
// so a pack works here before it is registered in src/map/packs.ts. Also the format checks every pack
// must pass (lintPack), shared by build:map and verify:map.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BoardGeometry, MapManifest, MapRules, MapTopology } from '../../src/map/types';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const packDir = (id: string) => resolve(ROOT, 'maps', id);

/** The seat counts the game supports (GameConfig.players: 2..4). */
export const GAME_SEATS = { min: 2, max: 4 };

export interface LoadedPack {
  id: string;
  dir: string;
  manifest: MapManifest;
  rules: MapRules;
  topology: MapTopology;
  /** Which pack the rules + topology came from. */
  rulesFrom: string;
  /** Territory ids in canonical order (continents in order, territories within each). */
  territoryIds: string[];
  names: Record<string, string>;
  continentOf: Record<string, string>;
}

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;

/** `--map <id>` / `--map=<id>` from argv (default classic). */
export function mapArg(argv = process.argv.slice(2)): string {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--map') return argv[i + 1] ?? die('--map needs an id');
    if (argv[i].startsWith('--map=')) return argv[i].slice(6);
  }
  return 'classic';
}

function die(msg: string): never {
  console.error(msg);
  process.exit(2);
}

export function loadPack(id: string, seen: string[] = []): LoadedPack {
  const dir = packDir(id);
  if (!existsSync(resolve(dir, 'pack.json'))) die(`no map pack at maps/${id}/pack.json`);
  const manifest = readJson<MapManifest>(resolve(dir, 'pack.json'));
  if (manifest.id !== id) die(`maps/${id}/pack.json says id "${manifest.id}"`);
  let rules: MapRules, topology: MapTopology, rulesFrom = id;
  if (manifest.extends) {
    if (seen.includes(id)) die(`map pack ${id}: extends cycle`);
    if (existsSync(resolve(dir, 'rules.json')) || existsSync(resolve(dir, 'topology.json')))
      die(`maps/${id} extends ${manifest.extends} but also ships rules.json/topology.json`);
    const base = loadPack(manifest.extends, [...seen, id]);
    ({ rules, topology, rulesFrom } = base);
  } else {
    rules = readJson<MapRules>(resolve(dir, 'rules.json'));
    topology = readJson<MapTopology>(resolve(dir, 'topology.json'));
  }
  const byCont = new Map<string, string[]>();
  for (const c of rules.continents) byCont.set(c.id, []);
  for (const t of rules.territories) byCont.get(t.continent)?.push(t.id);
  const territoryIds = rules.continents.flatMap((c) => byCont.get(c.id)!);
  return {
    id,
    dir,
    manifest,
    rules,
    topology,
    rulesFrom,
    territoryIds,
    names: Object.fromEntries(rules.territories.map((t) => [t.id, t.name])),
    continentOf: Object.fromEntries(rules.territories.map((t) => [t.id, t.continent])),
  };
}

export function readBoard(p: LoadedPack): BoardGeometry {
  return readJson<BoardGeometry>(resolve(p.dir, 'board.json'));
}

export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Longest names the HUD sets without crowding (territory on hover/select, continent + bonus on the water). */
export const MAX_TERRITORY_NAME = 22;
export const MAX_CONTINENT_NAME = 18;

/** Format checks on the hand-written files (no geometry). Returns failure messages. */
export function lintPack(p: LoadedPack): string[] {
  const out: string[] = [];
  const { manifest: m, rules: r, topology: t } = p;
  if (m.format !== 1) out.push(`pack.json: format must be 1`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(m.id)) out.push(`pack.json: id "${m.id}" must be lowercase-kebab`);
  if (!m.name?.trim()) out.push('pack.json: name is empty');
  if (!m.description?.trim()) out.push('pack.json: description is empty');
  else if (m.description.includes('!')) out.push('pack.json: description has an exclamation mark (plain words, docs/MAP-AUTHORING.md step h)');
  if (m.order !== undefined && !Number.isFinite(m.order)) out.push('pack.json: order must be a number');
  if (m.hidden !== undefined && typeof m.hidden !== 'boolean') out.push('pack.json: hidden must be true or false');
  if (!(m.presentation?.anchorClearance > 0)) out.push('pack.json: presentation.anchorClearance must be > 0');
  if (r.format !== 1) out.push('rules.json: format must be 1');
  if (t.format !== 1) out.push('topology.json: format must be 1');
  // seats + setup table
  const { min, max } = r.seats ?? { min: NaN, max: NaN };
  if (!(Number.isInteger(min) && Number.isInteger(max) && min <= max)) out.push('rules.json: seats must be {min, max} integers');
  else {
    if (min < GAME_SEATS.min || max > GAME_SEATS.max) out.push(`rules.json: seats ${min}..${max} outside what the game supports (${GAME_SEATS.min}..${GAME_SEATS.max})`);
    for (let n = min; n <= max; n++) {
      const v = r.startingArmies?.[String(n)];
      if (!(Number.isInteger(v) && v > 0)) out.push(`rules.json: startingArmies has no entry for ${n} seats`);
      else if (v * n < p.territoryIds.length) out.push(`rules.json: ${n} seats × ${v} armies can't cover ${p.territoryIds.length} territories`);
    }
  }
  if (!r.cardSymbols?.length || r.cardSymbols.some((s) => !['infantry', 'cavalry', 'artillery'].includes(s))) out.push('rules.json: cardSymbols must be infantry/cavalry/artillery');
  // continents + territories
  const cids = new Set<string>();
  for (const c of r.continents) {
    if (cids.has(c.id)) out.push(`rules.json: duplicate continent ${c.id}`);
    cids.add(c.id);
    if (!(Number.isInteger(c.bonus) && c.bonus > 0)) out.push(`rules.json: continent ${c.id} bonus must be a positive integer`);
    if (!c.name?.trim()) out.push(`rules.json: continent ${c.id} has no name`);
    else if (c.name.length > MAX_CONTINENT_NAME) out.push(`rules.json: continent name "${c.name}" is ${c.name.length} characters (at most ${MAX_CONTINENT_NAME})`);
  }
  const tids = new Set<string>();
  let lastCont = -1;
  for (const x of r.territories) {
    if (tids.has(x.id)) out.push(`rules.json: duplicate territory ${x.id}`);
    tids.add(x.id);
    if (!/^[a-z0-9_]+$/.test(x.id)) out.push(`rules.json: territory id "${x.id}" must be snake_case`);
    if (!x.name?.trim()) out.push(`rules.json: territory ${x.id} has no name`);
    else if (x.name.length > MAX_TERRITORY_NAME) out.push(`rules.json: territory name "${x.name}" is ${x.name.length} characters (at most ${MAX_TERRITORY_NAME})`);
    const ci = r.continents.findIndex((c) => c.id === x.continent);
    if (ci < 0) out.push(`rules.json: territory ${x.id} is in unknown continent ${x.continent}`);
    else if (ci < lastCont) out.push(`rules.json: territories must be grouped by continent, in continent order (${x.id})`);
    else lastCont = ci;
  }
  for (const c of r.continents) if (!r.territories.some((x) => x.continent === c.id)) out.push(`rules.json: continent ${c.id} is empty`);
  if (tids.size < 6) out.push(`rules.json: only ${tids.size} territories`);
  // topology
  const borders = new Set<string>();
  const adj = new Map<string, string[]>([...tids].map((x) => [x, []]));
  for (const [a, b] of t.borders) {
    if (!tids.has(a) || !tids.has(b)) out.push(`topology.json: border ${a}–${b} names an unknown territory`);
    if (a === b) out.push(`topology.json: border ${a}–${b} is a loop`);
    const k = pairKey(a, b);
    if (borders.has(k)) out.push(`topology.json: duplicate border ${k}`);
    borders.add(k);
    adj.get(a)?.push(b);
    adj.get(b)?.push(a);
  }
  const lanes = new Set<string>();
  let wraps = 0;
  for (const l of t.seaLanes) {
    const k = pairKey(l.a, l.b);
    if (!borders.has(k)) out.push(`topology.json: sea lane ${k} is not in borders`);
    if (lanes.has(k)) out.push(`topology.json: duplicate sea lane ${k}`);
    lanes.add(k);
    if (l.wrap) wraps++;
  }
  if (wraps > 1) out.push('topology.json: at most one sea lane may wrap the board edge');
  // Every territory reachable from every other (one connected board).
  const start = r.territories[0]?.id;
  if (start) {
    const seen = new Set([start]);
    const q = [start];
    while (q.length) for (const n of adj.get(q.pop()!) ?? []) if (!seen.has(n)) (seen.add(n), q.push(n));
    const cut = [...tids].filter((x) => !seen.has(x));
    if (cut.length) out.push(`topology.json: not connected; unreachable from ${start}: ${cut.join(', ')}`);
  }
  for (const [x, n] of adj) if (!n.length) out.push(`topology.json: ${x} has no borders`);
  return out;
}
