// v6 maps lint: nothing under src/engine reads the classic board's constants any more. Each game reads its own
// board through mapDefOf(state.config) / mapOf(state). The constants stay exported from mapData.ts for callers
// outside the engine (render, game) until they migrate; this test keeps the engine from sliding back.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const ENGINE = join(ROOT, 'src', 'engine');
/** mapData.ts defines them (and MapDef); every other engine file must not use them. */
const DEFINES = join(ENGINE, 'mapData.ts');
const BANNED = ['TERRITORIES', 'CONTINENTS', 'TERRITORY_IDS', 'CONTINENT_IDS', 'ADJACENCY', 'BORDERS', 'CARD_SYMBOLS', 'STARTING_ARMIES', 'areAdjacent'];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** Source without comments or string contents, so a doc line may still mention the old names. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

describe('the engine reads the game\'s map, never the classic constants', () => {
  it('no file under src/engine (but mapData.ts) names them', () => {
    const hits: string[] = [];
    // A bare identifier: not a property (`def.areAdjacent` is the MapDef method, fine) and not part of a longer name.
    const re = new RegExp(`(?<![\\w.$])(${BANNED.join('|')})(?![\\w$])`, 'g');
    for (const f of files(ENGINE)) {
      if (f === DEFINES) continue;
      const lines = code(readFileSync(f, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        for (const m of line.matchAll(re)) hits.push(`${relative(ROOT, f)}:${i + 1} ${m[1]}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('the lint itself catches a use', () => {
    const re = new RegExp(`(?<![\\w.$])(${BANNED.join('|')})(?![\\w$])`, 'g');
    expect(code("import { ADJACENCY } from './mapData';\nfor (const t of TERRITORY_IDS) {}").match(re)).toEqual(['ADJACENCY', 'TERRITORY_IDS']);
    expect(code('// TERRITORY_IDS in a comment\nm.areAdjacent(a, b); MY_TERRITORIES_X;').match(re)).toBeNull();
  });
});
