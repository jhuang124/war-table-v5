// Modern Boston recipe (docs/MAP-AUTHORING.md, worked example 2). The city's 26 BPDA neighbourhoods
// (maps/modern-boston/source/, Analyze Boston, public domain) on the `local` preset. The file holds Boston
// only, so Cambridge, Brookline and Chelsea are blank paper: the Charles and the harbour read as water and
// the city as an island. A lens magnifies the old peninsula so its small neighbourhoods fit an army.
// rules.json and topology.json in maps/modern-boston/ say WHAT the board is; this file says WHERE.

import { DEFAULT_TUNING, cutBy, type MapRecipe } from '../../recipe';

export const recipe: MapRecipe = {
  source: { geojson: 'maps/modern-boston/source/boston_neighborhood_boundaries.geojson', nameProperty: 'name' },

  // The city plus the inner harbour, so the islands sit on water you can see.
  frame: { lonLat: [-71.2, 42.222, -70.915, 42.402] },
  projection: {
    preset: 'local',
    width: 80,
    lenses: [
      // The old peninsula: North End to Chinatown, so its small neighbourhoods each hold an army.
      { name: 'Peninsula', lon: -71.063, lat: 42.353, r0: 4, R: 20, m: 1.8 },
      // Chinatown, the smallest neighbourhood left after the merges.
      { name: 'Chinatown', lon: -71.062, lat: 42.3495, r0: 1.2, R: 5, m: 1.35 },
      // Longwood and Mission Hill, squeezed between the Fens and Brookline.
      { name: 'Longwood', lon: -71.104, lat: 42.337, r0: 1.6, R: 7, m: 1.7 },
      // Long Island and its neighbours, so the Harbor Islands army sits on an island.
      { name: 'Islands', lon: -70.965, lat: 42.322, r0: 2, R: 8, m: 1.5 },
    ],
  },

  assign: {
    'North End': 'north_end',
    'West End': 'west_end',
    'Beacon Hill': 'beacon_hill',
    Downtown: 'downtown',
    'Leather District': 'downtown',
    Chinatown: 'chinatown',
    'Back Bay': 'back_bay',
    'Bay Village': 'back_bay',
    'South End': 'south_end',
    Fenway: 'fenway',
    Longwood: 'longwood',
    'Mission Hill': 'mission_hill',
    Allston: 'allston',
    Brighton: 'brighton',
    Roxbury: 'roxbury',
    // Columbia Road / Freeport Street, roughly: Uphams Corner, Savin Hill and Columbia Point to the north.
    Dorchester: cutBy([[[-71.1, 42.303], [-71.06, 42.301], [-71.02, 42.301]]], {
      dorchester_north: [-71.055, 42.318],
      dorchester_south: [-71.07, 42.285],
    }),
    Mattapan: 'mattapan',
    'Jamaica Plain': 'jamaica_plain',
    Roslindale: 'roslindale',
    'West Roxbury': 'west_roxbury',
    'Hyde Park': 'hyde_park',
    Charlestown: 'charlestown',
    'East Boston': 'east_boston',
    'South Boston': 'south_boston',
    'South Boston Waterfront': 'seaport',
    'Harbor Islands': 'harbor_islands',
  },
  otherLand: 'drop',

  laneHints: {
    'east_boston|north_end': { ha: [-71.04, 42.365], hb: [-71.05, 42.366] },
    'charlestown|north_end': { ha: [-71.058, 42.372], hb: [-71.056, 42.369] },
    // Fort Point Channel, by the Congress Street bridge.
    'downtown|seaport': { ha: [-71.053, 42.353], hb: [-71.05, 42.352] },
  },
  protectedIslands: ['harbor_islands'],
  autoFatten: ['harbor_islands', 'dorchester_north'],

  continentLabelHints: {
    downtown: [-71.07, 42.375],
    back_bay_fenway: [-71.125, 42.322],
    allston_brighton: [-71.185, 42.335],
    roxbury_dorchester: [-71.02, 42.29],
    southwest: [-71.17, 42.232],
    harbour: [-70.98, 42.38],
  },
  oceanLabels: [
    { text: 'BOSTON HARBOR', hint: [-70.98, 42.33], size: 1.0 },
    { text: 'CHARLES RIVER', hint: [-71.09, 42.362], size: 0.7 },
  ],

  tuning: DEFAULT_TUNING,

  previews: [{ name: 'peninsula', lonLat: [-71.1, 42.33, -71.02, 42.38], pad: 1, px: 1400 }],
};
