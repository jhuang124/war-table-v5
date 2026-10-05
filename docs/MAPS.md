# Map packs

A map is a folder, `maps/<id>/`. The game ships two: **classic** (the board War Table has always had)
and **true-world** (the same 42 territories and rules on a truer world map). A game records its map in
`GameConfig.mapId`; a game without one (every save from before map packs) is played on classic.

## The format

| File | Who writes it | What it holds |
|---|---|---|
| `pack.json` | author | Manifest + presentation: `id`, `name`, one-line `description` for the picker, `extends` (take rules + topology from another pack), `thumbnail`, `presentation.anchorClearance` (army disc room, board units), optional `presentation.anchorOverhang` (armies may overhang water), optional `presentation.home` (camera home rectangle; not read by the renderer yet), optional `order` (picker order, ascending; absent = 100; Classic 0, True World 1) and `hidden` (loads by `?map=<id>`, not offered in the picker). |
| `rules.json` | author | Rules: supported `seats` {min, max}, `startingArmies` per seat count (the setup table), `cardSymbols` cycle, `continents` [{id, name, bonus}] in display order, `territories` [{id, name, continent}] grouped by continent in continent order. That order is canonical: card symbols, AI iteration and label numbering follow it. |
| `topology.json` | author | Topology: undirected `borders` [[a, b]], and `seaLanes` [{a, b, wrap?}], the borders that cross water. `wrap: true` = the crossing leaves the west edge from `a` and comes back in from the east edge to `b` (at most one per map). |
| `board.json` | `npm run build:map` | Geometry + placed presentation, the renderer contract `BoardGeometry` (`src/map/types.ts`): territory polygons, bbox, area, army `anchor`, name `labelAnchor`, sea-lane polylines (first point on `a`'s shore, last on `b`'s: the two **shore points** where the crossing's ticks go), continent and ocean label spots, neutral `decorativeLand`, a `projection` note. |
| `thumb.png` | `npm run build:map` | The 480 × 300 picker tile, an ink drawing of the board (indigo paper, ivory coasts, continent washes, no labels) rendered from board.json by `scripts/map/preview.ts` `thumbSvg`; never a screenshot. `verify:map --thumb` rewrites it. |

The four concerns: **geometry** = `board.json` shapes; **topology** = `topology.json` (+ the lane
polylines and shore points in `board.json`); **rules** = `rules.json`; **presentation** = `pack.json`
(+ the placed anchors and labels in `board.json`, and the projection/lenses in the recipe).

A generated pack also has a **recipe**, `scripts/map/packs/<id>/index.ts`, exporting `recipe: MapRecipe`
(`scripts/map/recipe.ts`; recipe v2, all of it in docs/MAP-AUTHORING.md: a local GeoJSON source, a frame +
projection preset, `cutBy` cut lines, `clip`, `otherLand`): the source, the projection and lenses, which country (or
which part of it) becomes which territory, island stretches, lane shore hints (lon/lat), continent and
ocean label hints, tuning (raster resolution, water gaps, smoothing), and the close-ups `verify:map`
renders. Recipes are scripts (typechecked, can hold functions), so they live under `scripts/`, not `maps/`.

## Runtime

- **Registration is discovery** (v6): every folder `maps/<id>/` with a `pack.json` is a pack. Vite bundles
  them with `import.meta.glob` (`maps/*/pack.json`, `rules.json`, `topology.json`, `board.json`,
  `thumb.png`); plain Node (`npm run sim`, tsx scripts) reads the folder. A pack without a board.json yet, or
  with broken files, is skipped with a console warning (Classic is required).
- `src/map/packs.ts` — manifests + rules + topology of every discovered pack, no geometry, no DOM.
  `src/engine/mapData.ts` reads classic's rules and topology through it (same exports as before).
- `src/map/registry.ts` — the one geometry loader: `listMaps()` (the picker's packs, `hidden` ones left out:
  id, name, description, seats, counts, thumbnail URL, rulesFrom), `packIds()` (every pack with a board), `getBoard(id)` (the pack's `board.json` with every lane's `shore` filled),
  `activeMapId()` / `activeBoard()`, `resolveMapId()`.
- `src/map/index.ts` — `BOARD` is `activeBoard()`: the map this page boots on. In order: `?map=<id>`
  (dev server and `VITE_E2E` builds only), else the saved game's `state.config.mapId`, else classic.
  Everything that imported `BOARD` / `seaLaneBetween` from `src/map` gets the active map unchanged.
- `createGame` keeps `config.mapId` (an unknown id becomes `'classic'`), so the save carries it.

Today the board is chosen once per page load, and the engine plays classic's rules and topology for
every pack (true-world `extends` classic, so that is exact). Starting a game on another map than the
page booted on needs the renderer to swap geometry; see "Requests" in the v3 maps report.

## Build and verify

```
npm run new:map -- <id> "<Name>"     # scaffold a pack (docs/MAP-AUTHORING.md)
npm run build:map -- --map <id>      # recipe + rules + topology → maps/<id>/board.json + thumb.png (seconds)
npm run verify:map -- --map <id>     # checks, balance notes, 30-game sim, previews in artifacts/map/<id>/
npm run verify:maps                  # every pack under maps/, no previews, no sim
```

`build:map` without `--map` builds classic. The pipeline (`scripts/map/pipeline.ts`) is deterministic:
the same inputs give the same bytes. **Classic is pinned**: `verify:map` fails if `maps/classic/board.json`
differs by a byte from the pre-pack board (sha256 `a4b77df4…`), and so does
`tests/map/registry.test.ts`. If you change classic on purpose, update both hashes and say so.

`verify:map` checks, and fails on:
- the hand-written files: ids, names, bonuses, seats 2..4 with a starting-army entry per seat count
  (enough to cover every territory), territories grouped by continent, borders naming known
  territories, no duplicates, sea lanes ⊂ borders, at most one wrap, one connected board;
- geometry: every territory present, valid polygons (CCW outers, CW holes, no self-crossings, no
  overlaps), no point-like touches, non-neighbours at least 0.25 apart, decorative land touching nothing;
- adjacency: land contacts ∪ sea lanes = `topology.json` borders exactly, the board's lanes = the
  topology's lanes (same direction, same wrap);
- armies: each anchor inside its main polygon with `anchorClearance` of room (or, with
  `anchorOverhang`, at least `ownLand` of own land and `anchorClearance` from every other territory's
  land, open water allowed under the disc); no two discs overlap; neighbours' anchors at least 1.6
  apart (room for two ~1.3-unit v3 stacks with a gap); it prints each European anchor's distance to
  the nearest other land;
- lanes: shore points on the right coasts, at most 0.3 units over unrelated land, **at least 60 % over
  open water** (visible water = adjacency), wrap lanes run off both edges;
- continent and ocean labels on water.

and, v6: territory names at most 22 characters, continent names at most 18, no exclamation mark in the
description, and (unless `--no-sim`) `npm run sim 30 -- --map <id>` finishing with its rounds line.

It prints NOTEs, not failures: a pack with its own rules (it plays where the engine reads
`mapDefOf(config)`), each continent's bonus against its size and border territories with a suggested value
(round((territories + border territories) / 2 − 1); off by two or more is flagged), a territory count outside
25–45 or a continent count outside 3–7, mean territory area against Classic's, a scaffold TODO description,
and `hidden`.

## Adding a map

Follow docs/MAP-AUTHORING.md: `npm run new:map -- <id> "<Name>"`, then rules, topology, recipe, build,
verify, the real board, balance, the description. Registering is the folder itself; nothing in `src/` changes.
A hand-drawn map (no recipe) writes `board.json` to the `BoardGeometry` contract itself and runs
`verify:map`. Board shots on the real board: a dev server on a free port, then
`npx tsx scripts/map/board-shots.ts --map <id> --url http://127.0.0.1:<port>/` (rest shot, close-ups with a
crossing aimed, phone tap check, home scale), and `npx tsx scripts/map/land-pixels.ts` on the rest shots to
compare how much land a pack puts on screen against classic.

The camera frames the land's outline (convex hull of every territory), not the board rectangle, so
ocean margins don't change the framing; the land outline's aspect against the screen does. A pack
whose land is taller for its width than classic's frames by height, and its armies come out smaller.

### What an author hand-verifies (the checks can't)

- **It reads as the place.** Straits, peninsulas and seas you'd name from across the room are there
  (Gibraltar, the Bosphorus, Italy, the isthmus, the Bering tips). Look at `preview.png` and the
  close-ups, and at the real board with `?map=<id>`.
- **Every border is one a player would guess.** The checker proves geometry = topology; only a person
  can say a land contact looks like a border and a lane looks like a crossing (short, over water you
  can see, ticks on both shores).
- **Armies read.** Overhanging discs sit over water, not over a neighbour's coast; at phone size every
  territory is still tappable (a disc counts as a target) and the numeral is legible.
- **Labels fit.** Continent names + bonuses sit on open water near their continent; territory names
  (shown on hover/select) don't collide at the home zoom.
- **Balance** (a new board only): bonuses match how hard each continent is to hold (count its
  borders), starting armies fit the seat counts, and a few `npm run sim` games finish.
- **The wrap** (if any) looks like one strait continuing off the edge, not two random lines.

## A new board

**The engine reads rules per game (v6).** Everything under `src/engine` (rules, setup, cards, flow, reducer,
summary, missions, standing, diplomacy and the AI) takes the board from the game itself:
`mapDefOf(state.config)` (or `mapOf(state)` in `src/engine/rules.ts`), i.e. the pack named by
`config.mapId`. Nothing in the engine assumes 42 territories or six continents any more, and
`tests/engine/no-classic-constants.test.ts` fails if an engine file names the classic constants
(`TERRITORY_IDS`, `CONTINENTS`, `ADJACENCY`, …). Those constants stay exported from `mapData.ts` for code
outside the engine until it migrates.

What a pack must provide for the engine (its own `rules.json` + `topology.json`; `extends` packs inherit them):

- **`seats`** {min, max} within 2..4. `createGame` rejects a table outside them ("Test Twelve is for 2 to 3
  players.").
- **`startingArmies`**: one entry per supported seat count, each at least ceil(territories / seats).
  `createGame` rejects a seat count without one (unless the config sets `startingArmies`).
- **`cardSymbols`**: the cycle dealt to territories in canonical order. The deck is one card per territory
  plus two wilds (ids `size` and `size + 1`; `wildCardIds(state)`).
- **`continents`** with plain-English names and bonuses; reinforcement, continent events, the AI's continent
  plans, mission cards and the standing lines ("they share a border in Centre") all use them.
- **`territories`** grouped by continent in continent order: the canonical order. AI iteration, card ids,
  `legalActionsSummary` arrays and the setup deal follow it.
- **`borders`** and **`seaLanes`** (a lane is also a border). Adjacency is the borders; the lanes are in
  `MapDef.seaLanes` for "visible water = adjacency".

What scales with the board by itself:

- **Win thresholds**: `dominationPercent` is a share of the board. `targetTerritories(def, percent)` in
  `src/engine/rules.ts` turns a percent into territories (70 % = 30 of classic's 42, 9 of a 12-territory
  board); `territoriesNeeded(state)` uses it.
- **The neutral seat** (2 players) gets a third of the board, rounded (`neutralTerritories(def)`; 14 on classic).
- **Missions**: packs that play classic's rules deal the boxed six continent cards. Any other board builds its
  continent cards from its own continents: every pair whose territories add up to 25–45 % of the board (at
  most six, nearest 35 % first). The two count cards are 57 % and 43 % (with 2 armies on each) of the board,
  which is 24 and 18 on classic; the colour cards are unchanged (`missionsFor(state)`, `missionTerritories`).

**Proving a board before it is drawn.** `maps/test-twelve/` is a synthetic engine-only pack (12 territories,
three continents with bonuses 2 / 3 / 4, two sea lanes, seats 2–3). Its `pack.json` sets `"hidden": true`:
a hidden pack is registered for the engine (`allPackIds()`, `isKnownMap`) but `listMaps()` / `packIds()`
skip it, the page never boots on it (`?map=` and saves fall back to classic), and it needs no `board.json`.
`tests/engine/maps.test.ts` plays it end to end, and `npm run sim [games] -- --map <id>` runs the AI soak on
any pack (tables the pack's seats don't allow are skipped; classic's tuning bands print as NOTEs there).
Do the same for a new board's rules before drawing it: write `rules.json` + `topology.json`, register them
hidden, and run `npm run sim 50 -- --map <id>` until the games finish and the bonuses feel right.

Still outside the engine before an original 20–24-territory map is playable:

1. **Renderer + controller read territories from the board** (`getBoard(id)`, `mapDefOf(config)`), not from
   `TERRITORY_IDS` / `ADJACENCY` / `CONTINENTS` / `TERRITORIES` / `STARTING_ARMIES` (src/render tiles, tokens,
   ink, overlay, continents, index; src/game controller and presets).
2. **Presets**: `src/game/presets.ts` rounds-to-threshold tables are measured on 42 territories and its
   setup batch and `territoriesToWin` use 42 literally; rerun `npm run sim -- --map <id>` per map and use
   `targetTerritories`.
3. **The picker** offers only maps whose `seats` include the table's player count.
4. Geometry (v6, done): a recipe reads Natural Earth or any local GeoJSON (`source: { geojson, nameProperty }`),
   carves countries with `cutBy`, frames with a projection preset; anchors, labels and lanes are placed by the
   pipeline as for Classic. Only a map with no geographic source at all needs a hand-drawn `board.json`.
## True World: what it is

Equal Earth (equal-area) centred on 10.8°E with the Pacific seam at 169.2°W, like every world map; the
meridians eased 30 % toward straight near the sides (Alaska and Chukotka reach the edges instead of
curling away; the far north is at most ~12 % wider than true), 87 % of the equator across the board
(the empty mid-Pacific is cropped), heights ×0.95 (Equal Earth's land is a little tall for a 16:10
screen under the HUD; at 0.95 it frames like classic: armies the same size on screen, slightly more
land). One gentle lens: Europe ×1.3 (classic: ×1.5, plus five more lenses). No stretched or grown
islands: Iceland, Britain, Japan, Madagascar, Indonesia, New Guinea, Scandinavia, Kamchatka and
Alaska are their real size, so their armies may overhang the water around them (`anchorOverhang`,
at least 0.25 units of own land under the anchor, never another territory's land). Water gaps between lane ends are 0.6 units
(classic 0.8), so Gibraltar, the Channel and Bab-el-Mandeb read as straits. The Bering Strait is split
by the seam, as on a real map: the lane leaves Cape Prince of Wales westward and comes back in to
Cape Dezhnev.
