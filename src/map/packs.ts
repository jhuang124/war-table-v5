// Map packs, the rules half (docs/MAPS.md): every pack's manifest, rules and topology, with no
// geometry and no DOM, so the engine (src/engine/mapData.ts) and Node scripts can read it.
// The geometry half (board.json + boot-time selection) is src/map/registry.ts.
//
// Registration is by discovery (v6): every folder maps/<id>/ with a pack.json is a pack. Vite (the game,
// vitest) bundles them through import.meta.glob; plain Node (tsx scripts such as `npm run sim`) reads the
// folder from disk. Picker order is pack.json `order` (absent = 100), then id; `hidden` packs load by
// `?map=<id>` but are not offered in the picker (src/map/registry.ts listMaps).

import type { MapManifest, MapRules, MapTopology } from './types';

/** The map a game without `config.mapId` is played on (every save from before map packs). */
export const DEFAULT_MAP_ID = 'classic';

/** path ('../../maps/<id>/<file>') → parsed JSON (or, for registry assets, a URL string). */
export type Globbed = Record<string, unknown>;

/**
 * Node fallback for import.meta.glob('../../maps/* /<file>'): the same keys, read from disk. Used only where
 * Vite didn't transform the module (tsx scripts); no static node: imports, so the browser bundle never sees it.
 */
export function readMapsFolder(file: string, parse: (text: string) => unknown = JSON.parse): Globbed {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const fs = proc?.getBuiltinModule?.('node:fs') as typeof import('node:fs') | undefined;
  const path = proc?.getBuiltinModule?.('node:path') as typeof import('node:path') | undefined;
  const url = proc?.getBuiltinModule?.('node:url') as typeof import('node:url') | undefined;
  if (!fs || !path || !url) throw new Error('map packs: no import.meta.glob (not Vite) and no Node fs to read maps/ from');
  const dir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../maps');
  const out: Globbed = {};
  for (const id of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, id, file);
    if (fs.existsSync(p)) out[`../../maps/${id}/${file}`] = parse(fs.readFileSync(p, 'utf8'));
  }
  return out;
}

function globJson(file: 'pack.json' | 'rules.json' | 'topology.json'): Globbed {
  try {
    // Vite rewrites each literal call at build time; in plain Node import.meta.glob is undefined and throws.
    if (file === 'pack.json') return import.meta.glob('../../maps/*/pack.json', { eager: true, import: 'default' });
    if (file === 'rules.json') return import.meta.glob('../../maps/*/rules.json', { eager: true, import: 'default' });
    return import.meta.glob('../../maps/*/topology.json', { eager: true, import: 'default' });
  } catch {
    return readMapsFolder(file);
  }
}

/** '../../maps/<id>/<file>' → id */
export const packIdOfPath = (p: string) => /maps\/([^/]+)\/[^/]+$/.exec(p)?.[1] ?? '';

interface PackFiles {
  manifest: MapManifest;
  rules?: MapRules;
  topology?: MapTopology;
}

const byFolder = (g: Globbed) => new Map(Object.entries(g).map(([p, v]) => [packIdOfPath(p), v]));
const MANIFESTS = byFolder(globJson('pack.json'));
const RULES = byFolder(globJson('rules.json'));
const TOPOLOGIES = byFolder(globJson('topology.json'));

/** Discovered packs in picker order: `order` ascending (absent = 100), then id. */
const PACK_FILES: PackFiles[] = [...MANIFESTS.entries()]
  .filter(([folder, m]) => {
    const ok = (m as MapManifest)?.id === folder;
    if (!ok) console.warn(`[risk] maps/${folder}/pack.json says id "${(m as MapManifest)?.id}"; skipped`);
    return ok;
  })
  .map(([folder, m]) => ({
    manifest: m as MapManifest,
    rules: RULES.get(folder) as MapRules | undefined,
    topology: TOPOLOGIES.get(folder) as MapTopology | undefined,
  }))
  .sort((a, b) => (a.manifest.order ?? 100) - (b.manifest.order ?? 100) || (a.manifest.id < b.manifest.id ? -1 : 1));

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

const PACKS = new Map<string, PackData>();
for (const p of PACK_FILES) {
  try {
    PACKS.set(p.manifest.id, resolvePack(p.manifest.id));
  } catch (e) {
    // A half-written pack (mid-authoring) must not take the game down: skip it, loudly.
    if (p.manifest.id === DEFAULT_MAP_ID) throw e;
    console.warn(`[risk] ${(e as Error).message}; skipped`);
  }
}
if (!PACKS.has(DEFAULT_MAP_ID)) throw new Error(`map packs: maps/${DEFAULT_MAP_ID}/ is missing`);

/** Every registered pack id (hidden ones included), in picker order. */
export function packIds(): string[] {
  return [...PACKS.keys()];
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
