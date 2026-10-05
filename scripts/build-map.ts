// Builds a map pack's board from Natural Earth (world-atlas): maps/<id>/board.json.
//   npm run build:map                     (classic)
//   npm run build:map -- --map true-world
// Reads maps/<id>/pack.json, rules.json, topology.json (or the pack it extends) and the recipe in
// scripts/map/packs/<id>/index.ts; the pipeline itself is scripts/map/pipeline.ts. docs/MAPS.md has
// the format. Also renders maps/<id>/thumb.png (the picker tile; --no-thumb skips it).
// Then run `npm run verify:map -- --map <id>`.

import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, lintPack, loadPack, mapArg } from './map/pack';
import { buildBoard } from './map/pipeline';
import type { MapRecipe } from './map/recipe';
import { renderThumb } from './map/preview';

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const id = mapArg();
const pack = loadPack(id);
const problems = lintPack(pack);
if (problems.length) {
  console.log(`maps/${id}: fix these first`);
  for (const p of problems) console.log(`  ✗ ${p}`);
  process.exit(1);
}
const recipePath = resolve(ROOT, 'scripts/map/packs', id, 'index.ts');
if (!existsSync(recipePath)) {
  console.log(`maps/${id} has no recipe at scripts/map/packs/${id}/index.ts (a hand-drawn pack ships board.json itself)`);
  process.exit(1);
}
const { recipe } = (await import(pathToFileURL(recipePath).href)) as { recipe: MapRecipe };
log(`map ${id}: ${pack.territoryIds.length} territories, ${pack.rules.continents.length} continents, ${pack.topology.borders.length} borders (${pack.topology.seaLanes.length} by sea)${pack.rulesFrom !== id ? `, rules from ${pack.rulesFrom}` : ''}`);

const board = buildBoard(pack, recipe, log);
const out = resolve(pack.dir, 'board.json');
const json = JSON.stringify(board);
writeFileSync(out, json);
const verts = Object.values(board.territories).reduce(
  (s, t) => s + t.polygons.reduce((q, pg) => q + pg.outer.length + pg.holes.reduce((u, h) => u + h.length, 0), 0), 0);
log(`wrote ${out} (${(json.length / 1024).toFixed(0)} KB, ${verts} territory vertices)`);
if (pack.manifest.thumbnail && !process.argv.includes('--no-thumb')) {
  await renderThumb(board, pack, resolve(pack.dir, pack.manifest.thumbnail));
  log(`wrote maps/${id}/${pack.manifest.thumbnail} (480 × 300)`);
}
