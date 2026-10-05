// Italian Conquest recipe (docs/MAP-AUTHORING.md): Italy by region and every shore that touches it, Provence to
// the Peloponnese. rules.json and topology.json in maps/italian-conquest/ say WHAT the board is; this file says
// WHERE each territory is.
//
// Italy is one Natural Earth feature, so its regions are carved with cutBy: the mainland by the regional
// boundaries (simplified to a few points each, shared junctions so every line ends on another as a T), Sardinia
// and Sicily by one line each. France gives Provence (PACA), Savoy (joined to Aosta across the Alps) and Corsica;
// the rest of France is faint decor. Croatia gives Istria (with Kvarner) and Dalmatia (with Lika); its
// inland north is decor. Greece is cut into its historic regions; Thrace and the Aegean islands are decor.

import { DEFAULT_TUNING, cutBy, type LonLat, type MapRecipe, type Resolved, type Rule } from '../../recipe';

type Pixel = (lon: number, lat: number) => Resolved;
const pixelOf = (r: Rule): Pixel => {
  if (typeof r === 'string' || !r.pixel) throw new Error('italian-conquest: expected a pixel rule');
  return r.pixel;
};

// ---- Mainland Italy --------------------------------------------------------------------------------------
// Junctions (lon, lat), each where three regions meet.
const P1: LonLat = [9.05, 44.58]; // Piedmont / Lombardy / Liguria
const P2: LonLat = [9.3, 44.57]; // Lombardy / Emilia / Liguria
const P3: LonLat = [9.72, 44.42]; // Liguria / Emilia / Tuscany
const P4: LonLat = [11.42, 44.98]; // Lombardy / Emilia / Veneto
const P6: LonLat = [10.82, 45.82]; // Lombardy / Veneto / Trentino (north tip of Garda)
const P7: LonLat = [11.55, 44.15]; // Emilia / Romagna / Tuscany
const P8: LonLat = [12.15, 43.75]; // Romagna / Tuscany / Marche
const P9: LonLat = [12.2, 43.58]; // Tuscany / Marche / Umbria
const P10: LonLat = [11.9, 42.78]; // Tuscany / Umbria / Lazio
const P11: LonLat = [13.17, 42.8]; // Umbria / Marche / Lazio
const P12: LonLat = [13.35, 42.72]; // Lazio / Marche / Abruzzo
const P13: LonLat = [13.95, 41.68]; // Lazio / Abruzzo / Molise
const P14: LonLat = [14.03, 41.47]; // Lazio / Molise / Campania
const P15: LonLat = [15.0, 41.45]; // Molise / Campania / Puglia
const P16: LonLat = [15.6, 40.95]; // Campania / Puglia / Basilicata
const PS_JOIN: LonLat = [17.3, 40.0]; // Basilicata / Puglia / Salento, out in the Gulf of Taranto

const mainland = cutBy(
  [
    // Aosta | Piedmont: Monte Rosa down the Dora to Pont-Saint-Martin, west under Gran Paradiso
    [[7.87, 46.1], [7.87, 45.92], [7.9, 45.65], [7.75, 45.53], [7.45, 45.47], [7.15, 45.45], [6.9, 45.4]],
    // Liguria's Apennine watershed, Ventimiglia to the Magra (Piedmont, Lombardy, Emilia | Liguria; Liguria | Tuscany)
    [[7.4, 44.0], [7.72, 44.07], [8.0, 44.17], [8.2, 44.38], [8.5, 44.5], [8.8, 44.53], P1, P2, [9.5, 44.47], P3, [9.9, 44.25], [10.0, 44.1], [10.03, 44.0], [10.03, 43.8]],
    // Piedmont | Lombardy: the Ticino, Lake Maggiore, the Sesia, down to the Oltrepò
    [[8.6, 46.6], [8.6, 46.1], [8.68, 45.85], [8.62, 45.55], [8.55, 45.3], [8.65, 45.05], [8.9, 44.85], P1],
    // Lombardy | Emilia: the Po
    [P2, [9.3, 44.85], [9.45, 45.08], [9.9, 45.1], [10.3, 44.97], [10.7, 44.98], [11.05, 44.98], [11.3, 44.95], P4],
    // Veneto | Emilia: the Po to its delta
    [P4, [11.75, 44.97], [12.1, 44.93], [12.3, 44.88], [12.55, 44.85]],
    // Lombardy | Veneto: the Mincio and Lake Garda
    [P4, [11.2, 45.15], [10.8, 45.35], [10.7, 45.6], P6],
    // Lombardy | Trentino: up to the Stelvio
    [P6, [10.6, 45.9], [10.5, 46.15], [10.55, 46.35], [10.45, 46.55], [10.45, 46.8]],
    // Trentino | Veneto: the Adige gorge, Asiago, the Dolomites
    [P6, [11.0, 45.72], [11.4, 45.85], [11.7, 46.0], [11.85, 46.2], [12.05, 46.45], [12.2, 46.6], [12.3, 46.85]],
    // Veneto | Friuli: the Livenza, out past the Tagliamento mouth (south-east, clear of Marche)
    [[12.7, 46.9], [12.7, 46.65], [12.5, 46.4], [12.42, 46.1], [12.6, 45.9], [12.85, 45.82], [13.05, 45.7], [13.5, 45.3]],
    // Emilia | Romagna: the Reno, then the Sillaro up to the crest
    [[12.45, 44.62], [12.2, 44.6], [11.85, 44.58], [11.7, 44.45], [11.58, 44.3], P7],
    // Emilia, Romagna | Tuscany: the Apennine crest
    [P3, [10.1, 44.3], [10.45, 44.2], [10.8, 44.13], [11.2, 44.12], P7, [11.75, 44.0], [12.0, 43.85], P8],
    // Romagna | Marche: past San Marino to Gabicce
    [P8, [12.3, 43.82], [12.5, 43.9], [12.65, 43.93], [12.75, 43.98], [12.95, 44.1]],
    // Tuscany | Marche
    [P8, P9],
    // Tuscany | Umbria: Trasimeno's west shore
    [P9, [12.05, 43.45], [11.97, 43.2], [11.92, 42.98], P10],
    // Tuscany | Lazio: down to Chiarone
    [P10, [11.75, 42.65], [11.6, 42.5], [11.45, 42.38], [11.3, 42.25]],
    // Umbria | Marche: the Apennine crest to the Sibillini
    [P9, [12.4, 43.52], [12.6, 43.38], [12.75, 43.2], [12.9, 43.0], [13.05, 42.88], P11],
    // Umbria | Lazio: the Tiber and the Nera
    [P10, [12.1, 42.65], [12.35, 42.5], [12.6, 42.42], [12.85, 42.55], [13.0, 42.65], P11],
    // Lazio | Marche (Amatrice)
    [P11, P12],
    // Marche | Abruzzo: the Tronto
    [P12, [13.55, 42.8], [13.75, 42.83], [13.92, 42.9], [14.1, 43.0]],
    // Lazio | Abruzzo: the Simbruini and the Marsica
    [P12, [13.2, 42.55], [13.1, 42.35], [13.05, 42.15], [13.15, 42.0], [13.45, 41.85], [13.7, 41.75], P13],
    // Abruzzo | Molise: the Trigno
    [P13, [14.15, 41.8], [14.4, 41.92], [14.6, 42.02], [14.78, 42.08], [15.0, 42.2]],
    // Lazio | Molise
    [P13, P14],
    // Lazio | Campania: the Garigliano
    [P14, [13.9, 41.37], [13.78, 41.25], [13.65, 41.15]],
    // Molise | Campania: the Matese
    [P14, [14.3, 41.42], [14.55, 41.38], [14.8, 41.43], P15],
    // Molise | Puglia: the Fortore
    [P15, [14.95, 41.65], [15.05, 41.8], [15.12, 41.93], [15.2, 42.1]],
    // Campania | Puglia: Irpinia
    [P15, [15.15, 41.3], [15.3, 41.15], [15.5, 41.05], P16],
    // Campania | Basilicata: down to Maratea
    [P16, [15.5, 40.8], [15.55, 40.55], [15.7, 40.3], [15.65, 40.07], [15.55, 40.0]],
    // Basilicata | Puglia: the Bradano, then across the gulf to the Salento line
    [P16, [15.9, 40.97], [16.2, 40.9], [16.5, 40.75], [16.65, 40.6], [16.8, 40.45], [16.88, 40.4], [17.0, 40.2], PS_JOIN],
    // Puglia | Salento: Monopoli to Taranto's east, then due south past Capo Colonna
    [[17.6, 41.0], [17.45, 40.7], [17.35, 40.5], [17.3, 40.42], PS_JOIN, [17.3, 39.5]],
    // Basilicata | Calabria: Pollino, out to the south-east past Crotone
    [[15.45, 39.92], [15.78, 39.93], [16.1, 39.95], [16.35, 39.95], [16.6, 40.1], [16.8, 39.95]],
  ],
  {
    aosta_savoy: [7.4, 45.75],
    piedmont: [7.9, 44.9],
    lombardy: [9.8, 45.6],
    trentino: [11.2, 46.3],
    veneto: [11.9, 45.6],
    friuli: [13.0, 46.2],
    liguria: [8.5, 44.2],
    emilia: [10.6, 44.6],
    romagna: [12.0, 44.3],
    tuscany: [11.2, 43.4],
    umbria: [12.5, 42.95],
    marche: [13.2, 43.4],
    lazio: [12.6, 41.9],
    abruzzo: [13.9, 42.25],
    molise: [14.5, 41.65],
    campania: [14.8, 40.9],
    puglia: [16.2, 41.2],
    salento: [18.0, 40.4],
    basilicata: [16.0, 40.5],
    calabria: [16.3, 39.0],
  },
);
const sardinia = pixelOf(cutBy([[[8.2, 40.2], [9.0, 40.15], [9.9, 40.05]]], { sardinia_north: [9.1, 40.8], sardinia_south: [9.0, 39.4] }));
const sicily = pixelOf(cutBy([[[14.05, 38.3], [14.15, 37.7], [14.3, 37.3], [14.4, 36.9]]], { sicily_west: [13.3, 37.7], sicily_east: [14.9, 37.4] }));
const mainlandPx = pixelOf(mainland);
const isSardinia = (lon: number, lat: number) => lon < 10.5 && lat < 41.4;
// Sicily (and the Aeolians) against Calabria across the Strait of Messina (Capo Peloro is at 15.65, 38.27).
const isSicily = (lon: number, lat: number) => lat < 38.9 && lon < 16 && (lon < 15.605 || (lat >= 38.256 && lon < 15.665));

const italy: Rule = {
  pixel: (lon, lat) => {
    if (lat < 37.0 && lon < 12.4) return 'drop'; // Pantelleria: a speck off Tunisia, not Sicily's
    if (isSardinia(lon, lat)) return sardinia(lon, lat);
    if (isSicily(lon, lat)) return sicily(lon, lat);
    return mainlandPx(lon, lat);
  },
};

// ---- France ------------------------------------------------------------------------------------------------
const FJ: LonLat = [6.25, 45.05]; // Provence / Savoy / the rest of France (Galibier)
const franceMain = pixelOf(
  cutBy(
    [
      // the Rhône: Provence | Languedoc
      [[4.6, 43.2], [4.65, 43.7], [4.7, 44.1], [4.65, 44.4]],
      // Provence's north edge (PACA), up the Durance to the Galibier and on into Italy
      [[4.65, 44.4], [5.4, 44.45], [5.7, 44.65], [6.0, 44.85], FJ, [6.7, 45.1]],
      // Savoy's west edge: Isère | Savoie, Lake Bourget, the Rhône to Geneva
      [FJ, [6.0, 45.25], [5.8, 45.45], [5.75, 45.7], [5.8, 46.0], [5.95, 46.3]],
    ],
    { provence: [6.0, 43.8], aosta_savoy: [6.5, 45.7], decor: [4.5, 45.5] },
  ),
);
const corsica = pixelOf(cutBy([[[8.5, 42.3], [9.0, 42.15], [9.6, 41.9]]], { corsica_north: [9.2, 42.5], corsica_south: [8.9, 41.7] }));
const france: Rule = { pixel: (lon, lat) => (lon > 8.3 && lat < 43.2 ? corsica(lon, lat) : lon > 2 && lat > 41 && lat < 52 ? franceMain(lon, lat) : 'drop') };

// ---- Croatia -----------------------------------------------------------------------------------------------
const CJ: LonLat = [15.25, 45.2]; // Istria (Kvarner) / Dalmatia (Lika) / inland Croatia
const croatia = cutBy(
  [
    // Istria | Dalmatia: between Krk and Rab, through the Velebit channel, up to the Kapela
    [[14.6, 44.5], [14.6, 44.72], [14.75, 44.9], [14.95, 45.0], CJ],
    // Istria | inland: Gorski kotar | Karlovac
    [CJ, [15.3, 45.5], [15.35, 45.9]],
    // Dalmatia | inland: Lika | Karlovac, then east along the Bosnian border
    [CJ, [15.5, 45.0], [15.85, 44.7], [16.4, 44.7]],
  ],
  { istria: [14.0, 45.2], dalmatia: [16.0, 43.7], decor: [16.5, 45.6] },
);

// ---- Bosnia and Herzegovina --------------------------------------------------------------------------------
const bosnia = cutBy(
  [[[16.6, 43.95], [17.0, 43.85], [17.4, 43.75], [17.9, 43.68], [18.3, 43.55], [18.7, 43.4], [19.0, 43.3]]],
  { bosnia: [17.8, 44.4], herzegovina: [17.8, 43.3] },
);

// ---- Greece ------------------------------------------------------------------------------------------------
const G1: LonLat = [21.25, 39.9]; // Epirus / Macedonia / Thessaly
const G2: LonLat = [21.4, 39.15]; // Epirus / Thessaly / Attica (Sterea)
const greeceMain = pixelOf(
  cutBy(
    [
      // Epirus | Macedonia: the Grammos and Smolikas
      [[20.6, 40.55], [20.85, 40.35], [21.1, 40.1], G1],
      // Epirus | Thessaly: the Pindus
      [G1, [21.3, 39.6], G2],
      // Epirus | Sterea: Agrafa to the Ambracian Gulf, out west north of Lefkada
      [G2, [21.15, 39.05], [20.95, 39.0], [20.7, 38.95], [20.4, 38.95]],
      // Macedonia | Thessaly: the Kamvounia to Olympus, out east-south-east under Halkidiki
      [G1, [21.6, 39.98], [22.0, 40.03], [22.35, 40.05], [22.6, 39.98], [22.9, 39.85]],
      // Thessaly | Sterea: the Othrys, the Malian Gulf, the Oreoi channel above Euboea
      [G2, [21.7, 39.12], [22.1, 39.0], [22.5, 38.95], [22.8, 38.97], [23.05, 39.1], [23.35, 39.12]],
      // Sterea | Peloponnese: the Gulf of Patras, Rio, the Gulf of Corinth, the isthmus, the Saronic Gulf
      [[20.9, 38.33], [21.2, 38.33], [21.5, 38.28], [21.78, 38.31], [22.1, 38.22], [22.5, 38.12], [22.8, 38.0], [22.96, 37.93], [23.15, 37.85], [23.35, 37.65], [23.55, 37.45]],
    ],
    { epirus: [20.7, 39.6], macedonia: [22.5, 40.6], thessaly: [22.2, 39.5], attica: [22.8, 38.6], peloponnese: [22.3, 37.5] },
  ),
);
const greece: Rule = {
  pixel: (lon, lat) => {
    if (lon > 24.8 || lat < 35.9) return 'decor'; // Thrace, the eastern Aegean, Crete
    if (lon > 24.15 && lat < 38.0) return 'decor'; // the Cyclades
    if (lon > 24.3 && lat > 38.6 && lat < 39.0) return 'decor'; // Skyros
    if (lon < 21.0 && lat > 37.6 && lat < 38.52) return 'decor'; // Kefalonia, Ithaca, Zakynthos
    if (lat > 39.06 && lat < 39.35 && lon > 23.35 && lon < 24.1) return 'thessaly'; // the Sporades
    return greeceMain(lon, lat);
  },
};

export const recipe: MapRecipe = {
  source: 'countries-10m.json',
  // Provence to the Peloponnese.
  frame: { lonLat: [4, 35.8, 25, 47.6] },
  projection: { preset: 'mercatorLike', width: 80 },
  assign: {
    Italy: italy,
    'San Marino': 'romagna',
    Vatican: 'lazio',
    France: france,
    Monaco: 'provence',
    Malta: 'malta',
    Slovenia: 'slovenia',
    Croatia: croatia,
    'Bosnia and Herz.': bosnia,
    Montenegro: 'montenegro',
    Albania: 'albania',
    Greece: greece,
  },
  // Switzerland, Austria, Hungary, Serbia, Kosovo, Macedonia, Bulgaria, Tunisia, Algeria, Libya: faint land
  // that tells you where you are.
  otherLand: 'decor',
  // Malta is too small to hold an army disc at true size; drawn a little larger, as Classic draws its islands.
  islandXform: { malta: { along: 2.6, across: 2.6, angle: -35 } },

  laneHints: {
    'tuscany|corsica_north': { ha: [10.1, 42.8], hb: [9.45, 42.8] },
    'liguria|corsica_north': { ha: [9.6, 44.15], hb: [9.4, 43.0] },
    'corsica_south|sardinia_north': { ha: [9.15, 41.38], hb: [9.2, 41.25] },
    'lazio|sardinia_north': { ha: [11.8, 42.08], hb: [9.75, 40.95] },
    'sardinia_south|sicily_west': { ha: [9.6, 39.15], hb: [12.4, 37.9] },
    'calabria|sicily_east': { ha: [15.64, 38.2], hb: [15.6, 38.26] },
    'sicily_east|malta': { ha: [14.9, 36.72], hb: [14.45, 36.0] },
    'salento|albania': { ha: [18.5, 40.15], hb: [19.4, 40.35] },
    'salento|epirus': { ha: [18.36, 39.82], hb: [19.7, 39.78] },
    'veneto|istria': { ha: [12.4, 45.35], hb: [13.6, 45.2] },
    'marche|dalmatia': { ha: [13.6, 43.6], hb: [15.0, 43.95] },
  },
  protectedIslands: ['malta', 'corsica_north', 'corsica_south'],
  autoFatten: ['liguria', 'molise', 'salento', 'malta'],

  continentLabelHints: {
    alpine_north: [9.5, 47.0],
    po_riviera: [7.0, 43.2],
    centre: [10.6, 41.8],
    south: [17.0, 39.2],
    islands: [11.0, 39.5],
    adriatic_shore: [15.2, 42.7],
    hellas: [21.5, 36.9],
  },
  oceanLabels: [
    { text: 'TYRRHENIAN SEA', hint: [12.0, 40.0], size: 1.0 },
    { text: 'ADRIATIC SEA', hint: [15.0, 42.9], size: 0.9 },
    { text: 'IONIAN SEA', hint: [18.5, 38.0], size: 1.0 },
  ],

  tuning: { ...DEFAULT_TUNING, laneGap: 0.6 },

  previews: [
    { name: 'north', lonLat: [6, 43.5, 14.5, 47], pad: 1, px: 1400 },
    { name: 'south', lonLat: [11.5, 37.5, 19, 42.5], pad: 1, px: 1400 },
    { name: 'islands', lonLat: [7.5, 35.5, 16, 43.5], pad: 1, px: 1400 },
    { name: 'balkans', lonLat: [13, 37, 24.5, 46.5], pad: 1, px: 1400 },
  ],
};
