# Authoring a map

The recipe an agent follows, start to finish, to add a board to War Table: about an hour for a generated map.
The format and the checks are in docs/MAPS.md; this is the order of work.

**What a map is for (SOUL.md, pasted per its rule 6).** A world-conquest board game in the classic Risk mold,
for John and up to three friends on one laptop, TV or phone. It should feel like sitting inside a quiet ink
painting that the table fights over: indigo paper, feathered ivory coasts, muted washes, one gold. Readable
from the couch, not decorated: a player who just looked up answers in one second whose turn it is, who
holds which continent, where the biggest army is, what just happened. Ink linework as structure, no props
(no kanji, seals, blossoms, mascots, pictures of the place). Losing stings; the rivalry is real. A new map
must come out of the pipeline looking painted by the same hand as Classic: the pipeline draws it, you choose
the place, the pieces and the borders.

## The steps at a glance

```
npm run new:map -- <id> "<Name>"        # (0) scaffold: a small working board to replace
#   (a) choose the region + territories   (b) rules.json   (c) topology.json   (d) the recipe
npm run build:map -- --map <id>         # (e) board.json + thumb.png
npm run verify:map -- --map <id>        # (e) checks, balance notes, 30-game sim, previews
#   (f) ?map=<id> on a dev server + board shots   (g) balance + taste   (h) the description
#   then remove "hidden" from pack.json; npm run typecheck && npx vitest run && npm run verify:maps
```

`new:map` writes `maps/<id>/{pack.json, rules.json, topology.json, README.md}` and
`scripts/map/packs/<id>/index.ts`. The README holds the checklist; tick it as you go. The templates are a
working 8-territory western Mediterranean, so the build runs before you change a line. The pack starts
`"hidden": true`: it loads with `?map=<id>` but the picker doesn't offer it. Registration is the folder
itself (src/map discovers `maps/*/pack.json`); there is nothing to add anywhere else.

## (a) Choose the region and the territories

- 25–45 territories, 3–7 continents. Fewer than 25 plays out in a few rounds; more than 45 crowds a phone.
- A territory is a place a player could name: a country, a province, a neighbourhood. Prefer real units of
  the source data; split a big one (step d, `cutBy`) rather than inventing a shape.
- Similar sizes on the board. A territory needs room for an army disc (radius 1.3 board units) and its
  name; tiny ones (Monaco, the Leather District) merge into a neighbour.
- Continents are regions a player would name too ("Iberia", "the Maghreb", "South Boston"), each 3–9
  territories, each with few doors (territories that border another continent).

## (b) rules.json

```json
{
  "format": 1,
  "seats": { "min": 2, "max": 4 },
  "startingArmies": { "2": 26, "3": 23, "4": 20 },
  "cardSymbols": ["infantry", "cavalry", "artillery"],
  "continents": [{ "id": "iberia", "name": "Iberia", "bonus": 2 }],
  "territories": [{ "id": "lusitania", "name": "Lusitania", "continent": "iberia" }]
}
```

- **Ids** snake_case, stable (saves hold them). **Names** plain, real, English, a territory at most 22
  characters, a continent at most 18 (build and verify fail longer ones). No poetry, no "Kingdom of".
- **Territories** grouped by continent, continents in display order: that order deals the cards and numbers
  the AI's iteration.
- **Bonuses by border count.** verify prints, per continent, its territories, how many of them are on its
  border, and a suggested bonus, round((territories + border territories) / 2 − 1): Classic's North America
  5, South America 2, Europe 5, Australia 2 come out exactly. Two or more off the suggestion is a note to
  look again, not a failure.
- **Starting armies**: Classic is 40/35/30 for 2/3/4 seats on 42 territories; scale by your count
  (round(classic × territories / 42)). Every seat count from `seats.min` to `seats.max` needs an entry, and
  armies × seats must cover the territories.

## (c) topology.json

```json
{ "format": 1, "borders": [["a", "b"]], "seaLanes": [{ "a": "a", "b": "b" }] }
```

- A border is one a player would guess from the board: a land contact longer than a point, or a short
  crossing over water you can see (a strait, a ferry, a bridge in a city).
- Every sea lane is also in `borders`. Lanes are short (≤ 14 units, aim for ≤ 6), at least 60 % over open
  water, with nothing in between. At most one lane may `wrap` off the board edge; a regional map has none.
- verify proves geometry = topology both ways: every land contact the pipeline draws must be a border, and
  every border must be a contact or a lane. When it reports an "extra land contact" or "missing border",
  decide which is true of the place and fix the topology or the recipe (a cut line, a lane), not the checker.

## (d) The recipe: scripts/map/packs/<id>/index.ts

Exports `recipe: MapRecipe` (scripts/map/recipe.ts). Recipe v2 at a glance:

| Field / helper | What it does |
|---|---|
| `source` | `'countries-50m.json'` / `'countries-10m.json'` (Natural Earth, keys are its short names, e.g. `'W. Sahara'`), or `{ geojson: 'maps/<id>/source/<file>.geojson', nameProperty: 'name' }` (a local FeatureCollection; keys are that property). |
| `frame: { lonLat: [w, s, e, n] }` | The board's extent in degrees. Required with a preset. |
| `projection` | A preset `{ preset: 'mercatorLike' \| 'equalEarth' \| 'local', width?, margin?, yScale?, lenses? }`, or a built `BoardProjection` (Classic, True World). |
| `assign` | Feature name → territory id, `'decor'`, `'drop'`, or a rule `{ poly(c) }` / `{ pixel(lon, lat) }` / `cutBy(...)`. |
| `cutBy(lines, seeds)` | Carves one feature with hand-drawn lon/lat polylines; a seed point names each piece. |
| `splits` | The same as data: `{ Name: { lines, labels } }`. |
| `otherLand` | Features with no rule: `'drop'` (default) or `'decor'` (faint neutral land). |
| `clip`, `clipDrop` | Land outside a lon/lat polygon becomes decor; beyond `clipDrop` degrees it is dropped. |
| `laneHints` | `'a\|b'` → `{ ha, hb }`: the lon/lat near where the crossing leaves a and lands on b. |
| `continentLabelHints`, `oceanLabels` | Where each continent's name + bonus and each sea's name go (open water). |
| `protectedIslands`, `autoFatten`, `islandXform`, `aliases`, `tuning` | Fine control, as Classic uses them; most maps leave them empty / default. |
| `describe()`, `previews` | The board.json note (default is written for you); close-ups verify renders. |

**Source.** Natural Earth countries for anything country-sized. A local GeoJSON for anything else (a city, a
historical map someone has drawn): put it in `maps/<id>/source/` with a README saying where it came from and
under what licence, and only with John's go-ahead.

**Frame and projection.** Pick the preset by scale: `mercatorLike` (Miller cylindrical, the familiar wall
map) for a continent or a sea; `equalEarth` for half the world or more; `local` (flat, true scale at the
frame's middle latitude) for a city or a small country. `width` is the board's width in units (default 80;
Classic is 100 for the world). verify prints your mean territory area against Classic's; aim for ×0.8–1.5 so
armies and land read at the same scale (Classic's is about 35 square units). The camera frames the land, not
the board, so a wide frame of sea costs nothing.

**Assign.** Every territory needs at least one feature or one piece of a cut. Merge tiny features into a
neighbour; send everything else in the frame to `otherLand: 'decor'` (faint land that tells you where you are)
or leave it dropped. Decor never touches a territory: where they meet the pipeline carves a thin channel, so a
neighbour that shares a long land border with your map reads better dropped, or clipped away.

**Splitting a country with `cutBy`.** Draw each cut as a lon/lat polyline. A line's loose ends run on
straight to the edge of the cut's grid, so a line only has to cross the country; an end that stops on another
line makes a T. Give one seed point inside each piece. A seed whose piece leaks into another seed's throws
("a line doesn't close between them"). Lon/lat are as the board unwraps them, which for any frame that doesn't
cross the antimeridian is plain longitude.

**Lane hints** pin where a crossing leaves and lands; without one the pipeline takes the two closest coast
points. **Label hints** go on open water near the continent; verify fails a label on land.

### Worked example 1: Gaul from Natural Earth with cutBy and a clip

Part of a Roman Mediterranean board. France becomes three provinces; Germany and Switzerland are faint context
land; everything far from the Mediterranean world is dropped.

```ts
import { DEFAULT_TUNING, cutBy, type MapRecipe } from '../../recipe';

export const recipe: MapRecipe = {
  source: 'countries-50m.json',
  frame: { lonLat: [-11, 24, 42, 52] },
  projection: { preset: 'mercatorLike', width: 100 },
  assign: {
    France: cutBy(
      [
        // the Loire, then east past Lake Geneva: Belgica (north) | the south
        [[-1.8, 47.2], [2.0, 47.0], [4.8, 46.3], [7.0, 46.4]],
        // the Rhône, up from the coast, ending on the line above (a T): Aquitania | Narbonensis
        [[2.9, 42.4], [3.6, 43.9], [4.8, 45.6], [4.8, 46.3]],
      ],
      { belgica: [2.5, 49.0], aquitania: [0.5, 44.5], narbonensis: [5.5, 44.0] },
    ),
    Monaco: 'narbonensis',
    Belgium: 'belgica',
    Luxembourg: 'belgica',
    // ...the rest of the empire...
  },
  otherLand: 'decor',
  // The Roman world and its near neighbours; land beyond 4° outside is dropped, not drawn.
  clip: [[-10, 30], [-10, 52], [10, 54], [30, 50], [42, 44], [42, 28], [10, 25]],
  clipDrop: 4,
  laneHints: { 'britannia|belgica': { ha: [1.3, 51.1], hb: [1.8, 50.9] } },
  protectedIslands: [],
  autoFatten: [],
  continentLabelHints: { gaul: [-6, 46] },
  oceanLabels: [{ text: 'MARE NOSTRUM', hint: [18, 35], size: 1.1 }],
  tuning: DEFAULT_TUNING,
};
```

### Worked example 2: Boston from the city's GeoJSON

`maps/boston/source/` holds the city's 26 neighbourhoods (Analyze Boston, public domain). The frame covers the
city; `local` is the right preset at this scale. Tiny downtown neighbourhoods merge; Dorchester, the biggest,
is cut in two along Columbia Road.

```ts
export const recipe: MapRecipe = {
  source: { geojson: 'maps/boston/source/boston_neighborhood_boundaries.geojson', nameProperty: 'name' },
  frame: { lonLat: [-71.195, 42.225, -70.92, 42.4] },
  projection: { preset: 'local', width: 90 },
  assign: {
    Allston: 'allston',
    Brighton: 'brighton',
    'Back Bay': 'back_bay',
    'Bay Village': 'back_bay',
    'Beacon Hill': 'beacon_hill',
    'West End': 'beacon_hill',
    Downtown: 'downtown',
    Chinatown: 'downtown',
    'Leather District': 'downtown',
    'North End': 'north_end',
    Charlestown: 'charlestown',
    'East Boston': 'east_boston',
    'South End': 'south_end',
    'South Boston': 'south_boston',
    'South Boston Waterfront': 'seaport',
    Fenway: 'fenway',
    Longwood: 'fenway',
    'Mission Hill': 'mission_hill',
    Roxbury: 'roxbury',
    'Jamaica Plain': 'jamaica_plain',
    Roslindale: 'roslindale',
    'West Roxbury': 'west_roxbury',
    'Hyde Park': 'hyde_park',
    Mattapan: 'mattapan',
    Dorchester: cutBy([[[-71.085, 42.318], [-71.06, 42.315], [-71.035, 42.31]]], {
      north_dorchester: [-71.06, 42.322],
      dorchester: [-71.06, 42.29],
    }),
    'Harbor Islands': 'drop',
  },
  protectedIslands: [],
  autoFatten: [],
  continentLabelHints: {},
  oceanLabels: [{ text: 'BOSTON HARBOR', hint: [-70.99, 42.33], size: 1.0 }],
  tuning: DEFAULT_TUNING,
};
```

Two things a city source teaches. Its water is wherever the data has no land: this file holds Boston only, so
Cambridge and Brookline are blank, the Charles reads as open sea and the city as an island (fine for a board;
say so in the description if it matters). And neighbourhoods share long land borders, so most borders are land
contacts; the harbour crossings (East Boston ↔ North End, Charlestown ↔ North End) are lanes with hints.

## (e) Build, verify, read every preview

```
npm run build:map -- --map <id>      # seconds; also writes maps/<id>/thumb.png
npm run verify:map -- --map <id>     # ~30 s with the sim; --no-sim to skip it while iterating
```

verify fails on: the files (ids, names and their lengths, a description with an exclamation mark, seats,
starting armies, connectivity), the geometry (valid polygons, no overlaps, no point touches, gaps between
non-neighbours), adjacency ≠ topology, armies without room, lanes that are long, over other land or less than
60 % over water, labels on land. It notes (doesn't fail): bonuses against the suggestion, territory and
continent counts, size against Classic, a TODO description, `hidden`.

Then **read** `artifacts/map/<id>/preview.png` and every close-up with the Read tool: badge circles at the
army's room, names, lanes with their shore ticks, continent labels. The checker can't see whether a shape is
the place. Iterate on the recipe (frame, cuts, hints) and rebuild; it takes seconds.

## (f) On the real board

A dev server on a free port (`npx vite --port <p> --strictPort`, in the background), then
`http://127.0.0.1:<p>/?map=<id>`, and
`npx tsx scripts/map/board-shots.ts --map <id> --url http://127.0.0.1:<p>/` (rest shot, close-ups with a
crossing aimed, the phone tap check). Look at the shots with Read. Stop the server when done.

## (g) Balance and taste

- The sim in verify (30 AI games, `npm run sim 30 -- --map <id>`) must finish and print its rounds line.
- Bonuses near the suggestion unless you can say why a continent is easier or harder to hold.
- docs/MAPS.md "What an author hand-verifies": it reads as the place (the straits, peninsulas and landmarks
  you'd name across the room), every border is one a player would guess, armies read at phone size, labels
  fit, the wrap (if any) looks like one strait.
- Against SOUL: nothing on the board that isn't information; no decorative pictures of the place; names plain.

## (h) The description

One line in John's voice for the picker: plain, no exclamation marks, says what is different about this board
and what you'd fight over. "The Mediterranean as Rome held it: provinces, straits and the Nile." Not "Conquer
the ancient world!", not a sentence about the data source.

## Done

Remove `"hidden": true` from pack.json and set `"order"` (Classic 0, True World 1; new maps after). Run
`npm run typecheck`, `npx vitest run`, `npm run verify:maps`. The picker tile is `thumb.png`, rendered by the
build from your board in the same ink as every other tile; never replace it with a screenshot.
