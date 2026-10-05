# War Table v6 · maps (2026-10-04)

John: "build these maps into the game as selectable choices (Roman Empire, Italian Conquest, Modern Boston), make
it easy for me to add more maps, systematize the creation so you can have Opus build more quickly, in my style."

## What "in my style" means here
The three reference cards are Risk: Global Domination's: cartoon parchment on a glowing table. We take the
**content** (the regions, the groupings, the idea of a city board) and none of the look. Every board comes out of
the same pipeline that paints classic: indigo paper, feathered ivory coasts, muted washes, printed region
outlines, visible water for crossings, one gold. Names are plain and real. Descriptions are one line, no
exclamation marks. A map tile on New game is an ink thumbnail, not a 3D card.

## What has to change first (Phase 1, four builders in parallel)
1. **Engine plays any board.** Today the engine plays the classic 42 for every pack (True World only redrew them).
   `TerritoryId`/`ContinentId` are now `string`; `mapDefOf(config)` gives a game its own ids, continents, adjacency,
   card symbols and starting armies. The engine builder migrates rules, setup, cards, flow, reducer, summary, AI,
   missions (generic over the map's continents) and standing, and proves it on a hidden 12-territory test pack.
2. **Game and renderer generic.** Copy, story, presets (thresholds as shares of the board), continent labels and
   tints (N tints by index; classic unchanged), HUD ticks.
3. **Pipeline as a system.** Recipe v2: local GeoJSON sources, a clip region, `cutBy` for carving provinces from a
   country with a few hand-drawn lines, frame/projection presets; `npm run new:map` scaffolder; registration by
   folder discovery; verify adds bonus sanity, balance sim, name lengths; thumbnails rendered in the ink palette;
   **docs/MAP-AUTHORING.md**, the recipe an Opus agent follows in an hour.
4. **New game "Where" row.** Who · Where · How long · Start. Ink tiles, scrolls past five.

## The three boards (Phase 2, one builder each; this is their content brief)

Numbers are targets, not law: the builder tunes bonuses by border count (verify suggests values) and may merge or
split a territory to make a border a player would guess. Every name ≤ 22 characters, plain, real.

### Roman Empire · "The Mediterranean as Rome held it: provinces, straits and the Nile."
Source: world-atlas `countries-10m.json`, clipped to roughly 12°W–42°E, 24°N–57°N; everything outside the
clip is decorative land (Caledonia, Hibernia, Germania Magna, Persia, the Sahara edge). Provinces are carved from
modern countries with `cutBy`. Seats 2–4. About 42 territories in 8 regions:
- **Britannia & Germania** (bonus ≈4): Britannia Superior, Britannia Inferior, Belgica, Germania Inferior,
  Germania Superior, Raetia.
- **Gallia** (≈3): Lugdunensis, Aquitania, Narbonensis, Alpes.
- **Hispania** (≈3): Tarraconensis, Lusitania, Baetica, Balearica (islands).
- **Italia** (≈6): Liguria, Venetia, Etruria, Latium, Campania, Apulia, Sicilia, Sardinia et Corsica.
- **Illyricum & Danube** (≈4): Noricum, Pannonia, Dalmatia, Moesia, Dacia, Thracia.
- **Graecia & Asia** (≈5): Macedonia, Achaea, Creta, Bithynia, Asia, Galatia, Cilicia, Cappadocia.
- **Oriens** (≈4): Syria, Judaea, Arabia Petraea, Aegyptus, Cyrenaica.
- **Africa** (≈3): Africa Proconsularis, Numidia, Mauretania Caesariensis, Mauretania Tingitana.
Sea lanes (short, over water you can see): Tingitana–Baetica (Gibraltar), Sicilia–Africa Proconsularis,
Sardinia et Corsica–Etruria, Sicilia–Campania or Apulia, Creta–Achaea, Creta–Cyrenaica, Thracia–Bithynia
(Bosphorus), Macedonia–Asia (Aegean, one), Balearica–Tarraconensis, Britannia Superior–Belgica (the Channel).

### Italian Conquest · "Italy and every shore that touches it, for the player who likes a crowded board."
Source: world-atlas `countries-10m.json`, frame roughly 4°E–24°E, 36°N–48°N (Provence to the Peloponnese).
Seats 2–4. About 42 territories in 7 regions:
- **Alpine North** (≈4): Piedmont, Aosta & Savoy, Lombardy, Trentino, Veneto, Friuli.
- **Po & Riviera** (≈3): Liguria, Emilia, Romagna, Provence (the one foreign shore to the west).
- **Centre** (≈4): Tuscany, Umbria, Marche, Lazio, Abruzzo.
- **South** (≈4): Campania, Molise, Puglia, Basilicata, Calabria.
- **Islands** (≈4): Corsica North, Corsica South, Sardinia North, Sardinia South, Sicily West, Sicily East, Malta.
- **Adriatic Shore** (≈3): Istria, Dalmatia, Bosnia, Montenegro, Albania.
- **Hellas** (≈4): Epirus, Macedonia, Thessaly, Attica, Peloponnese.
Sea lanes: Liguria–Corsica North, Corsica South–Sardinia North, Sardinia South–Sicily West, Sicily East–Calabria
(Messina), Sicily East–Malta, Lazio–Sardinia North, Puglia–Albania (Otranto), Veneto–Istria, Marche–Dalmatia,
Calabria–Epirus (Ionian), Attica–Peloponnese is land. Keep lanes short enough that each reads as one crossing.

### Modern Boston · "The city by neighbourhood: the harbour is the only border that matters."
Source: `maps/boston/source/boston_neighborhood_boundaries.geojson` (26 features, Analyze Boston, approved
download). Projection preset `local`. Seats 2–4. About 25 territories in 6 regions:
- **Downtown** (≈3): North End, West End, Downtown (with Leather District merged in), Beacon Hill, Chinatown.
- **Back Bay & Fenway** (≈4): Back Bay (with Bay Village), Fenway, Longwood, Mission Hill, South End.
- **Allston–Brighton** (≈2): Allston, Brighton.
- **Roxbury & Dorchester** (≈4): Roxbury, Dorchester North, Dorchester South (Dorchester split along a plain
  line, e.g. Columbia Rd), Mattapan.
- **The Southwest** (≈3): Jamaica Plain, Roslindale, West Roxbury, Hyde Park.
- **The Harbour** (≈4): Charlestown, East Boston, South Boston, Seaport (South Boston Waterfront), Harbor Islands.
Sea lanes: East Boston–North End, Charlestown–North End (the two harbour crossings), Harbor Islands–South
Boston, Harbor Islands–East Boston, Harbor Islands–Dorchester North; Seaport–Downtown is land (Fort Point).
The Charles is a border, not a lane (Allston–Brighton touch Back Bay across it by bridges; treat as land borders).

## Acceptance for every board
- `verify:map` green, previews read as the place from across the room, every border guessable.
- `npm run sim 30 -- --map <id>` finishes; bonuses within one of the suggested values or justified.
- Rest shot at 1440×900 beside classic's: same hand (paper, coast, washes, labels), no new colours.
- John's glance test on the new board: whose turn, who holds a region, where the biggest army is.

## After the boards
- e2e: surfaces/setup/smoke flows learn the Where row and the new ids; a `maps.e2e.ts` boots each pack with
  `?map=<id>` and plays a turn.
- A "Maps" line in the README listing the packs and pointing to MAP-AUTHORING.md.
