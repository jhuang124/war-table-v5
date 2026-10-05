// Roman Empire recipe (docs/MAP-AUTHORING.md). Scaffolded by `npm run new:map`: the template below is a small
// working board (the western Mediterranean) so the build runs before you change a line. Replace it step by
// step: source → frame + projection → assign (+ cutBy) → lane hints → label hints → previews.
// rules.json and topology.json in maps/roman-empire/ say WHAT the board is; this file says WHERE each territory is.

import { DEFAULT_TUNING, cutBy, type MapRecipe } from '../../recipe';

export const recipe: MapRecipe = {
  // (d1) Source: Natural Earth countries ('countries-50m.json'; '-10m' for small islands and coasts), or a
  // local GeoJSON file you added under maps/roman-empire/source/ with a README saying where it came from:
  //   source: { geojson: 'maps/roman-empire/source/<file>.geojson', nameProperty: 'name' },
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

  // (e) Close-ups verify:map renders into artifacts/map/roman-empire/ besides the whole board.
  previews: [{ name: 'straits', lonLat: [-7, 35, 13, 39], pad: 1, px: 1400 }],
};
