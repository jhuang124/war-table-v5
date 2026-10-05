// Scaffolds a new map pack (docs/MAP-AUTHORING.md):
//   npm run new:map -- <id> "<Name>"
// writes maps/<id>/{pack.json, rules.json, topology.json, README.md} and scripts/map/packs/<id>/index.ts.
// The templates are a small working board (the western Mediterranean: 8 territories, 3 continents, one
// country carved with cutBy, two sea lanes) so `npm run build:map -- --map <id>` works before you change a
// line; then replace it with your map, step by step, following maps/<id>/README.md.
// The pack starts `hidden` (playable by ?map=<id>, not in the picker) until the checklist is done.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './pack';

const [id, name] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const force = process.argv.includes('--force');
if (!id || !name) {
  console.error('usage: npm run new:map -- <id> "<Name>"   (id lowercase-kebab, e.g. roman-empire)');
  process.exit(2);
}
if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) {
  console.error(`map id "${id}" must be lowercase-kebab (letters, digits, single hyphens), e.g. roman-empire`);
  process.exit(2);
}
if (name.length > 24 || name.includes('!')) {
  console.error(`map name "${name}": keep it short (≤ 24 characters) and plain (no exclamation mark)`);
  process.exit(2);
}
const mapDir = resolve(ROOT, 'maps', id);
const recipeDir = resolve(ROOT, 'scripts/map/packs', id);
if (!force && (existsSync(mapDir) || existsSync(recipeDir))) {
  console.error(`maps/${id} or scripts/map/packs/${id} already exists (--force overwrites the templates)`);
  process.exit(1);
}

const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

const pack = {
  format: 1,
  id,
  name,
  description: 'TODO: one plain line in John\'s voice saying what is different about this board.',
  thumbnail: 'thumb.png',
  hidden: true,
  presentation: { anchorClearance: 1.3 },
};

const rules = {
  format: 1,
  seats: { min: 2, max: 4 },
  startingArmies: { '2': 8, '3': 7, '4': 6 },
  cardSymbols: ['infantry', 'cavalry', 'artillery'],
  continents: [
    { id: 'iberia', name: 'Iberia', bonus: 1 },
    { id: 'france_italy', name: 'France and Italy', bonus: 1 },
    { id: 'maghreb', name: 'Maghreb', bonus: 2 },
  ],
  territories: [
    { id: 'portugal', name: 'Portugal', continent: 'iberia' },
    { id: 'spain', name: 'Spain', continent: 'iberia' },
    { id: 'france', name: 'France', continent: 'france_italy' },
    { id: 'italy', name: 'Italy', continent: 'france_italy' },
    { id: 'morocco', name: 'Morocco', continent: 'maghreb' },
    { id: 'oran', name: 'Oran', continent: 'maghreb' },
    { id: 'constantine', name: 'Constantine', continent: 'maghreb' },
    { id: 'tunisia', name: 'Tunisia', continent: 'maghreb' },
  ],
};

const topology = {
  format: 1,
  borders: [
    ['portugal', 'spain'],
    ['spain', 'france'],
    ['france', 'italy'],
    ['spain', 'morocco'],
    ['morocco', 'oran'],
    ['oran', 'constantine'],
    ['constantine', 'tunisia'],
    ['italy', 'tunisia'],
  ],
  seaLanes: [
    { a: 'spain', b: 'morocco' },
    { a: 'italy', b: 'tunisia' },
  ],
};

const recipe = `// ${name} recipe (docs/MAP-AUTHORING.md). Scaffolded by \`npm run new:map\`: the template below is a small
// working board (the western Mediterranean) so the build runs before you change a line. Replace it step by
// step: source → frame + projection → assign (+ cutBy) → lane hints → label hints → previews.
// rules.json and topology.json in maps/${id}/ say WHAT the board is; this file says WHERE each territory is.

import { DEFAULT_TUNING, cutBy, type MapRecipe } from '../../recipe';

export const recipe: MapRecipe = {
  // (d1) Source: Natural Earth countries ('countries-50m.json'; '-10m' for small islands and coasts), or a
  // local GeoJSON file you added under maps/${id}/source/ with a README saying where it came from:
  //   source: { geojson: 'maps/${id}/source/<file>.geojson', nameProperty: 'name' },
  source: 'countries-50m.json',

  // (d2) The frame [west, south, east, north] (degrees) and a projection preset:
  //   mercatorLike (a continent or a sea), equalEarth (half the world or more), local (a city).
  // width: board units across. Aim for territories about classic's size (verify:map prints the ratio).
  frame: { lonLat: [-11, 30, 19, 51.5] },
  projection: { preset: 'mercatorLike', width: 70 },

  // (d3) Source feature name → territory id (rules.json), 'decor' (faint neutral land) or 'drop'.
  // A rule can also be { poly(c) } (per island, from its centroid) or { pixel(lon, lat) }.
  // cutBy(lines, seeds) carves one country with hand-drawn lon/lat polylines: each line runs past the
  // country's edge on both ends; each seed point sits inside the piece it names.
  assign: {
    Portugal: 'portugal',
    Spain: 'spain',
    Andorra: 'spain',
    France: 'france',
    Monaco: 'france',
    Italy: 'italy',
    'San Marino': 'italy',
    Vatican: 'italy',
    Morocco: 'morocco',
    Algeria: cutBy([[[3.4, 38], [3.0, 33], [2.5, 28]]], { oran: [-0.6, 35.2], constantine: [6.6, 36.3] }),
    Tunisia: 'tunisia',
  },
  // Everything else in the frame (Switzerland, Libya, Malta...) is drawn as faint decorative land.
  otherLand: 'decor',
  // clip: [[lon, lat], ...] — land outside this polygon becomes decor (or is dropped beyond clipDrop
  // degrees). Use it to show only the world your map is about (a Roman board: the Mediterranean rim).

  // (d4) Where a sea lane meets each coast, lon/lat hints keyed 'a|b' as topology.json lists the lane.
  laneHints: {
    'spain|morocco': { ha: [-5.6, 36.0], hb: [-5.5, 35.8] },
    'italy|tunisia': { ha: [12.4, 37.8], hb: [11.0, 37.0] },
  },
  // Islands the water-gap carving must not eat (small territories next to bigger land).
  protectedIslands: [],
  // Territories allowed to grow a little into the sea to fit an army disc.
  autoFatten: [],

  // (d5) Labels: where each continent's name + bonus sits (open water near it), and the seas' names.
  continentLabelHints: {
    iberia: [-10, 39],
    france_italy: [7.5, 41.5],
    maghreb: [-2, 31.5],
  },
  oceanLabels: [{ text: 'MEDITERRANEAN SEA', hint: [5, 38.5], size: 1.0 }],

  tuning: { ...DEFAULT_TUNING, laneGap: 0.6 },

  // (e) Close-ups verify:map renders into artifacts/map/${id}/ besides the whole board.
  previews: [{ name: 'straits', lonLat: [-7, 35, 13, 39], pad: 1, px: 1400 }],
};
`;

const readme = `# ${name} (map pack \`${id}\`)

Scaffolded by \`npm run new:map\`. The files start as a small working board (the western Mediterranean);
replace them following **docs/MAP-AUTHORING.md**, ticking the list below. The pack is \`hidden\` (playable by
\`?map=${id}\` on a dev server, not offered in the picker) until every box is ticked.

| File | What |
|---|---|
| \`pack.json\` | name, one-line description, \`hidden\`, \`order\`, army room |
| \`rules.json\` | seats, starting armies, continents + bonuses, territories |
| \`topology.json\` | borders, and which of them cross water |
| \`scripts/map/packs/${id}/index.ts\` | the recipe: source, frame, projection, assign, lanes, labels |
| \`board.json\`, \`thumb.png\` | generated by \`npm run build:map -- --map ${id}\` |

## Author checklist

- [ ] (a) Region chosen; 25–45 territories a player could name.
- [ ] (b) rules.json: 3–7 continents; bonuses by border count (verify prints a suggestion); names plain,
      real, English, territory ≤ 22 characters, continent ≤ 18.
- [ ] (c) topology.json: borders a player would guess from the map; sea lanes short, over water you can see.
- [ ] (d) Recipe: source (+ source README and licence if local), frame, projection, assign (cutBy for
      splits), lane hints, continent and ocean label hints.
- [ ] (e) \`npm run build:map -- --map ${id}\` and \`npm run verify:map -- --map ${id}\` pass; every preview in
      artifacts/map/${id}/ read.
- [ ] (f) On a dev server with \`?map=${id}\`; board shots taken (\`npx tsx scripts/map/board-shots.ts --map ${id} --url ...\`).
- [ ] (g) Balance: the sim in verify:map finishes; the taste checks in docs/MAPS.md "What an author
      hand-verifies" done (reads as the place, borders guessable, armies read, labels fit).
- [ ] (h) Description: one plain line, no exclamation mark, says what is different about this board.
- [ ] \`hidden\` removed from pack.json and \`order\` set; \`npm run typecheck\`, \`npx vitest run\`, \`npm run verify:maps\`.
`;

mkdirSync(mapDir, { recursive: true });
mkdirSync(recipeDir, { recursive: true });
const files: [string, string][] = [
  [resolve(mapDir, 'pack.json'), json(pack)],
  [resolve(mapDir, 'rules.json'), json(rules)],
  [resolve(mapDir, 'topology.json'), json(topology)],
  [resolve(mapDir, 'README.md'), readme],
  [resolve(recipeDir, 'index.ts'), recipe],
];
for (const [p, text] of files) writeFileSync(p, text);
console.log(`new map pack ${id} ("${name}"):`);
for (const [p] of files) console.log(`  ${p.replace(ROOT + '/', '')}`);
console.log(`
next:
  npm run build:map -- --map ${id}      # the template builds as is
  npm run verify:map -- --map ${id}     # checks, balance notes, previews in artifacts/map/${id}/
  then follow maps/${id}/README.md and docs/MAP-AUTHORING.md`);
