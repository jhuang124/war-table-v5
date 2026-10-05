// Map packs, the geometry half (docs/MAPS.md): the one loader the game reads boards through.
//   listMaps()        — what the New-game picker offers (id, name, seats, one line, thumbnail)
//   getBoard(id)      — a pack's BoardGeometry (unknown / absent id = classic), sea-lane shores filled
//   activeMapId()     — the map this page boots on: ?map=<id> (dev + e2e builds), else the saved game's
//                       config.mapId, else classic. src/map/index.ts exports its board as BOARD.
// Rules and topology (no geometry) live in src/map/packs.ts, which the engine reads.

import type { BoardGeometry, SeaLaneGeom, Vec2 } from './types';
import { DEFAULT_MAP_ID, mapIdOf, packData, packIdOfPath, packIds as allPackIds, readMapsFolder, type Globbed } from './packs';

export { DEFAULT_MAP_ID, mapIdOf, isKnownMap } from './packs';

// Discovery (v6): every maps/<id>/board.json and thumb.png, bundled by Vite (import.meta.glob); plain Node
// reads the folder (boards only; no thumbnail URLs outside a bundle).
function globBoards(): Globbed {
  try {
    return import.meta.glob('../../maps/*/board.json', { eager: true, import: 'default' });
  } catch {
    return readMapsFolder('board.json');
  }
}
function globThumbs(): Globbed {
  try {
    return import.meta.glob('../../maps/*/thumb.png', { eager: true, query: '?url', import: 'default' });
  } catch {
    return {};
  }
}

/** The generated board.json of every pack, exactly as written by `npm run build:map`. */
const RAW_BOARDS: Record<string, unknown> = Object.fromEntries(Object.entries(globBoards()).map(([p, v]) => [packIdOfPath(p), v]));

/** Thumbnails beside each pack.json (written by build:map / verify:map --thumb); bundled as assets. */
const THUMBS: Record<string, string> = Object.fromEntries(Object.entries(globThumbs()).map(([p, v]) => [packIdOfPath(p), String(v)]));

/** A pack is playable once it has a board (between `npm run new:map` and the first build it has none). */
const PLAYABLE = allPackIds().filter((id) => {
  if (RAW_BOARDS[id]) return true;
  if (id === DEFAULT_MAP_ID) throw new Error('maps/classic/board.json is missing');
  console.warn(`[risk] maps/${id} has no board.json yet (npm run build:map -- --map ${id}); skipped`);
  return false;
});

/** mapIdOf, narrowed to packs that have a board (anything else loads classic). */
function boardIdOf(x?: { mapId?: string } | string | null): string {
  const id = mapIdOf(x);
  return PLAYABLE.includes(id) ? id : DEFAULT_MAP_ID;
}

/** Every pack with a board (hidden ones included), in picker order. */
export function packIds(): string[] {
  return [...PLAYABLE];
}

export interface MapInfo {
  id: string;
  name: string;
  /** One plain-English line for the picker. */
  description: string;
  /** Supported seat counts, inclusive. */
  seats: { min: number; max: number };
  territories: number;
  continents: number;
  /** URL of a small preview image, or null. */
  thumbnail: string | null;
  /** The pack whose rules + topology this one plays by ('classic' for true-world). */
  rulesFrom: string;
}

/** Every playable map the picker offers, in picker order (classic first; `hidden` packs left out). */
export function listMaps(): MapInfo[] {
  return packIds().filter((id) => !packData(id).manifest.hidden).map((id) => {
    const p = packData(id);
    return {
      id,
      name: p.manifest.name,
      description: p.manifest.description,
      seats: { ...p.rules.seats },
      territories: p.rules.territories.length,
      continents: p.rules.continents.length,
      thumbnail: p.manifest.thumbnail ? (THUMBS[id] ?? null) : null,
      rulesFrom: p.rulesFrom,
    };
  });
}

/** The raw generated file for a pack (tests prove classic's is byte-identical to the pre-pack board). */
export function rawBoard(id: string): BoardGeometry {
  return RAW_BOARDS[boardIdOf(id)] as BoardGeometry;
}

/** [on a's coast, on b's coast]: the lane's own `shore`, else its first and last points. */
export function laneShores(lane: SeaLaneGeom): [Vec2, Vec2] {
  if (lane.shore) return lane.shore;
  const last = lane.segments[lane.segments.length - 1];
  return [lane.segments[0][0], last[last.length - 1]];
}

const loaded = new Map<string, BoardGeometry>();

/**
 * A pack's board as the renderer should read it: the generated file, with every sea lane's `shore`
 * filled (additive field; nothing else differs). Unknown or absent ids load classic.
 */
export function getBoard(id?: string | null): BoardGeometry {
  const key = boardIdOf(id);
  let b = loaded.get(key);
  if (!b) {
    const raw = rawBoard(key);
    b = { ...raw, seaLanes: raw.seaLanes.map((l) => ({ ...l, shore: laneShores(l) })) };
    loaded.set(key, b);
  }
  return b;
}

/** Anchor clearance the pack's build guarantees (board units). */
export function anchorClearanceOf(id?: string | null): number {
  return packData(mapIdOf(id)).manifest.presentation.anchorClearance;
}

/**
 * Which map to boot on, as a pure function (tests call it directly):
 *   1. `?map=<id>` when `allowUrl` (dev server and VITE_E2E builds only) and the pack exists;
 *   2. else the saved game's `state.config.mapId` (a save without one = classic);
 *   3. else classic.
 * `save` is the raw risk3d.save.v1 string (src/game/storage.ts), or null.
 */
export function resolveMapId(opts: { search?: string; save?: string | null; allowUrl?: boolean }): string {
  if (opts.allowUrl && opts.search) {
    const want = new URLSearchParams(opts.search).get('map');
    if (want) {
      if (PLAYABLE.includes(want)) return want;
      console.warn(`[risk] ?map=${want}: no such map pack; using ${DEFAULT_MAP_ID}`);
    }
  }
  if (opts.save) {
    try {
      const f = JSON.parse(opts.save) as { state?: { config?: { mapId?: string } } };
      return boardIdOf(f?.state?.config);
    } catch {
      /* unreadable save: the controller discards it too */
    }
  }
  return DEFAULT_MAP_ID;
}

/** Same key as src/game/storage.ts SAVE_KEY (not imported: src/map stays free of game code). */
const SAVE_KEY = 'risk3d.save.v1';

let active: string | null = null;

/** The map this page boots on (see resolveMapId). Resolved once per page load. */
export function activeMapId(): string {
  if (active) return active;
  let search = '';
  let save: string | null = null;
  try {
    search = typeof location !== 'undefined' ? location.search : '';
    save = typeof localStorage !== 'undefined' ? localStorage.getItem(SAVE_KEY) : null;
  } catch {
    /* private mode / no storage */
  }
  const allowUrl = !!(import.meta.env?.DEV || import.meta.env?.VITE_E2E);
  active = resolveMapId({ search, save, allowUrl });
  return active;
}

/** The board this page boots on. */
export function activeBoard(): BoardGeometry {
  return getBoard(activeMapId());
}
