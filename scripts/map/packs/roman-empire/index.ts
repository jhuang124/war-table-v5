// Roman Empire recipe (docs/MAP-AUTHORING.md): the Mediterranean as Rome held it, about AD 117.
// Natural Earth 1:10m countries, carved into provinces with cutBy. The frontiers (Rhine, the limes, the
// Danube, the Euphrates, the Antonine Wall, the Sahara) are where a country's cut hands land to 'decor', or
// where the clip ends: beyond them the land is faint context (Caledonia, Hibernia, Germania Magna, Dacia's
// plains, Mesopotamia, Arabia, the desert), and the pipeline's channel between decor and a province reads
// as the frontier river.

import { DEFAULT_TUNING, cutBy as rawCutBy, type LonLat, type MapRecipe, type PolyInfo, type Rule } from '../../recipe';

// Every country's cut below is given its bounding box: the cut lines' loose ends are run out to that box
// here, and the box itself is drawn as two walls, so every piece is closed. (cut.ts runs a loose end to its
// grid edge, which can stop a row short of the last cell and let two seeds meet; see the report's Requests.)
// An end that sits on another line's vertex is a T and is left alone.
type Box = [number, number, number, number];
function cutBy(box: Box, lines: LonLat[][], seeds: Record<string, LonLat>): Rule {
  const [w, s, e, n] = box;
  const isT = (p: LonLat, li: number) => lines.some((l, j) => j !== li && l.some((q) => q[0] === p[0] && q[1] === p[1]));
  const out = (end: LonLat, prev: LonLat): LonLat => {
    const dx = end[0] - prev[0], dy = end[1] - prev[1];
    let t = Infinity;
    if (dx > 0) t = Math.min(t, (e - end[0]) / dx);
    if (dx < 0) t = Math.min(t, (w - end[0]) / dx);
    if (dy > 0) t = Math.min(t, (n - end[1]) / dy);
    if (dy < 0) t = Math.min(t, (s - end[1]) / dy);
    return [end[0] + dx * t, end[1] + dy * t];
  };
  const closed = lines.map((l, li) => {
    const L = [...l];
    if (!isT(l[0], li)) L.unshift(out(l[0], l[1]));
    if (!isT(l[l.length - 1], li)) L.push(out(l[l.length - 1], l[l.length - 2]));
    return L;
  });
  const frame: LonLat[][] = [
    [[w, n], [e, n], [e, s]],
    [[e, s], [w, s], [w, n]],
  ];
  return rawCutBy([...closed, ...frame], seeds);
}

/** A country whose islands are decided by centroid, and whose mainland is cut by lines. */
function islandsThenCut(poly: (c: PolyInfo) => string | undefined, cut: Rule): Rule {
  const pixel = (cut as { pixel: (lon: number, lat: number) => string }).pixel;
  return { poly, pixel };
}

export const recipe: MapRecipe = {
  source: 'countries-10m.json',
  frame: { lonLat: [-12, 24, 42, 57] },
  projection: { preset: 'mercatorLike', width: 96 },

  assign: {
    // ---- Britannia: Hadrian's Wall, and the Mersey–Wash line between the two provinces
    'United Kingdom': cutBy([-8.7, 49.8, 2, 61], 
      [
        [[-4.0, 54.95], [-3.2, 54.97], [-1.5, 55.0], [-1.0, 55.0]],
        [[-4.5, 53.35], [-3.0, 53.3], [-1.5, 53.1], [0.4, 52.95], [1.5, 52.9]],
      ],
      { valentia: [-3.5, 55.5], britannia_inferior: [-1.8, 54.0], britannia_superior: [-1.0, 51.6] },
    ),
    'Isle of Man': 'drop',
    Jersey: 'drop',
    Guernsey: 'drop',

    // ---- Gallia
    France: islandsThenCut(
      (c) => (c.lon > 8.4 && c.lat < 43.2 && c.lat > 41 ? 'sardinia_et_corsica' : undefined),
      cutBy([-5.5, 41.2, 9.8, 51.2], 
        [
          // the Seine–Marne line (Belgica north), on east to Basel
          [[0.1, 49.7], [1.3, 49.25], [2.6, 49.0], [3.8, 48.6], [4.8, 48.3], [5.5, 47.9], [6.2, 47.6], [6.9, 47.45], [7.6, 47.5]],
          // the Vosges: Belgica | Alsace (Germania Superior), ending on the line above
          [[8.2, 49.0], [7.4, 48.95], [7.1, 48.4], [6.95, 47.8], [6.9, 47.45]],
          // the Loire and on to the Rhône: Lugdunensis | Aquitania
          [[-2.3, 47.2], [-0.5, 47.35], [1.5, 47.5], [2.9, 47.0], [3.5, 46.4], [4.0, 45.8], [4.3, 45.4]],
          // the Cévennes: Aquitania | Narbonensis
          [[1.0, 42.7], [1.2, 43.4], [2.2, 43.8], [3.3, 44.1], [4.0, 44.9], [4.3, 45.4]],
          // south of Lyon to Lake Geneva: Lugdunensis | Narbonensis
          [[4.3, 45.4], [5.0, 45.55], [5.8, 45.9], [6.2, 46.3]],
        ],
        {
          belgica: [3.5, 49.6],
          germania_superior: [7.5, 48.4],
          lugdunensis: [0.5, 47.8],
          aquitania: [0.0, 44.5],
          narbonensis: [4.8, 43.9],
        },
      ),
    ),
    Monaco: 'narbonensis',
    // the Tungri (Tongeren) were Germania Inferior's: east of the Meuse
    Belgium: cutBy([2.4, 49.4, 6.5, 51.6], [[[4.6, 51.6], [5.0, 50.6], [5.6, 49.4]]], { belgica: [4.0, 50.6], germania_inferior: [5.6, 50.9] }),
    Luxembourg: 'belgica',
    Netherlands: cutBy([3.2, 50.7, 7.3, 53.7], [[[4.3, 52.25], [5.1, 52.08], [5.9, 51.95], [6.15, 51.88]]], {
      germania_inferior: [5.5, 51.5],
      decor: [5.8, 52.5],
    }),
    Germany: cutBy([5.8, 47.2, 15.1, 55.1], 
      [
        // the lower Rhine, Nijmegen to Koblenz
        [[5.9, 51.9], [6.6, 51.65], [6.75, 51.4], [6.8, 51.2], [6.97, 50.94], [7.15, 50.7], [7.6, 50.35]],
        // Germania Inferior's south edge
        [[7.6, 50.35], [7.0, 50.4], [6.0, 50.35]],
        // the limes, Koblenz to the Danube, then the Danube to Passau
        [[7.6, 50.35], [8.2, 50.3], [8.8, 50.4], [9.0, 50.0], [9.2, 49.5], [9.6, 48.95], [10.4, 49.0], [11.2, 49.05], [11.8, 48.9], [12.1, 49.0], [12.9, 48.8], [13.5, 48.55]],
        // Germania Superior | Raetia, Lorch to Lake Constance
        [[9.6, 48.95], [9.8, 48.4], [9.6, 47.6]],
        // Trier and the Saar (Belgica) | the Palatinate (Germania Superior)
        [[7.0, 50.4], [7.3, 49.8], [7.1, 49.15]],
      ],
      {
        germania_inferior: [6.6, 51.0],
        germania_superior: [8.3, 49.0],
        raetia: [11.0, 48.0],
        belgica: [6.8, 49.8],
        decor: [10.0, 52.0],
      },
    ),
    Switzerland: cutBy([5.9, 45.7, 10.6, 48], [[[9.0, 47.9], [8.9, 47.3], [8.7, 46.6], [8.6, 45.9]]], {
      germania_superior: [7.5, 46.9],
      raetia: [9.6, 46.7],
    }),
    Liechtenstein: 'raetia',

    // ---- Hispania
    Spain: islandsThenCut(
      (c) => (c.lon > 1 && c.lat < 40.3 && c.lat > 38.5 ? 'balearica' : undefined),
      cutBy([-9.4, 35.8, 4.4, 43.9], 
        [
          // the Sierra Morena: Baetica south
          [[-7.3, 38.2], [-5.5, 38.4], [-4.6, 38.35], [-3.5, 38.3], [-2.2, 37.6], [-1.7, 37.2]],
          // Lusitania | Tarraconensis, ending on the line above
          [[-6.9, 41.1], [-5.3, 40.9], [-4.8, 39.5], [-4.6, 38.35]],
        ],
        { tarraconensis: [-1.0, 41.5], lusitania: [-6.0, 39.4], baetica: [-5.0, 37.4] },
      ),
    ),
    Portugal: 'lusitania',
    Andorra: 'tarraconensis',
    Gibraltar: 'baetica',

    // ---- Italia
    Italy: islandsThenCut(
      (c) => {
        if (c.lat < 37 && c.lon < 12.4) return 'drop'; // Pantelleria, the Pelagie
        if (c.lat < 38.9 && c.lon > 12 && c.lon < 15.8) return 'sicilia'; // Sicily, the Aeolians, Egadi
        if (c.lon < 10 && c.lat < 41.5) return 'sardinia_et_corsica';
        return undefined;
      },
      cutBy([6.5, 35.4, 18.6, 47.2], 
        [
          // Liguria | Venetia, the Alps to the Magra
          [[9.4, 46.6], [9.5, 45.0], [9.75, 44.45], [9.9, 44.2], [9.7, 43.8]],
          // the Apennine ridge: Venetia | Etruria
          [[9.9, 44.2], [10.5, 44.2], [11.5, 44.05], [12.3, 43.85], [12.75, 43.85], [13.0, 43.9]],
          // Etruria | Latium
          [[11.6, 42.2], [12.4, 42.6], [12.9, 43.0], [13.5, 43.5], [13.8, 43.6]],
          // Latium | Campania, the Garigliano to the Fortore and out to sea
          [[13.75, 41.25], [14.2, 41.5], [14.6, 41.8], [14.9, 41.95], [14.95, 42.2]],
          // Campania | Apulia
          [[15.6, 42.3], [15.45, 41.9], [15.3, 41.2], [15.9, 40.6], [16.3, 40.1], [16.6, 39.95]],
        ],
        {
          liguria: [8.3, 45.0],
          venetia: [11.5, 45.5],
          etruria: [11.3, 43.3],
          latium: [13.2, 42.0],
          campania: [15.0, 40.8],
          apulia: [16.8, 40.8],
        },
      ),
    ),
    'San Marino': 'venetia',
    Vatican: 'latium',
    Malta: 'sicilia',

    // ---- Illyricum and the Danube
    Austria: cutBy([9.4, 46.3, 17.2, 49.1], 
      [
        // the Danube: the north bank is beyond the frontier
        [[13.3, 48.58], [14.3, 48.3], [15.0, 48.2], [15.6, 48.4], [16.0, 48.3], [16.4, 48.2], [17.1, 48.1]],
        // Raetia | Noricum along the Inn and Ziller
        [[12.3, 47.9], [12.2, 47.0], [12.3, 46.6]],
        // the Wienerwald: Noricum | Pannonia
        [[16.0, 48.3], [16.0, 48.0], [16.1, 47.4], [15.9, 46.6]],
      ],
      { raetia: [10.8, 47.2], noricum: [14.0, 47.3], pannonia: [16.6, 47.8], decor: [15.0, 48.7] },
    ),
    Slovenia: cutBy([13.3, 45.3, 16.7, 47], [[[15.0, 46.9], [15.3, 46.0], [15.4, 45.4]]], { noricum: [14.4, 46.1], pannonia: [15.9, 46.4] }),
    Hungary: cutBy([16, 45.6, 23, 48.7], [[[18.9, 48.3], [19.05, 47.6], [19.0, 46.8], [18.85, 45.8]]], { pannonia: [17.5, 47.0], decor: [20.5, 47.0] }),
    Croatia: cutBy([13.4, 42.3, 19.6, 46.6], [[[14.2, 45.9], [15.2, 45.45], [15.8, 45.2], [16.5, 45.2], [17.5, 45.1], [18.6, 45.05], [19.5, 45.0]]], {
      pannonia: [17.0, 45.7],
      dalmatia: [16.0, 44.0],
    }),
    'Bosnia and Herz.': 'dalmatia',
    Montenegro: 'dalmatia',
    Serbia: cutBy([18.7, 42.1, 23.1, 46.3], 
      [
        // the Sava and the Danube to the Iron Gates
        [[18.9, 44.85], [19.6, 44.8], [20.4, 44.82], [21.0, 44.75], [21.5, 44.7], [22.5, 44.6]],
        // the Tisza
        [[20.1, 46.2], [20.2, 45.6], [20.3, 45.15], [20.4, 44.82]],
      ],
      { moesia: [21.0, 43.5], pannonia: [19.5, 45.3], dacia: [20.8, 45.4] },
    ),
    Kosovo: 'moesia',
    Romania: cutBy([20.1, 43.6, 29.8, 48.4], 
      [
        // Dacia's edge: the eastern Carpathians, then the Olt
        [[23.5, 48.2], [24.5, 47.6], [25.5, 47.3], [25.9, 46.5], [25.8, 45.7], [24.6, 45.4], [24.4, 44.5], [24.5, 43.7]],
        // the Danube round the Dobruja
        [[27.3, 44.1], [27.9, 44.3], [28.0, 45.0], [28.2, 45.3], [29.0, 45.25], [29.7, 45.2]],
      ],
      { dacia: [23.5, 46.2], decor: [26.5, 45.0], moesia: [28.6, 44.3] },
    ),
    Bulgaria: cutBy([22.2, 41.2, 28.7, 44.3], [[[22.3, 42.9], [23.5, 42.85], [25.0, 42.75], [26.5, 42.7], [27.9, 42.75]]], {
      moesia: [25.0, 43.5],
      thracia: [25.0, 42.2],
    }),

    // ---- Graecia & Asia
    Macedonia: 'macedonia',
    Albania: 'macedonia',
    Greece: islandsThenCut(
      (c) => {
        if (c.lat < 35.8) return 'creta';
        if (c.lon > 25.8 && c.lat < 39.6) return 'asia'; // Lesbos, Chios, Samos, the Dodecanese
        return undefined;
      },
      cutBy([19.3, 34.7, 28.3, 41.8], 
        [
          // Thermopylae: Macedonia | Achaea
          [[20.7, 39.1], [21.8, 39.0], [22.6, 38.95], [23.2, 39.15], [24.0, 39.15]],
          // the Nestos: Macedonia | Thracia
          [[24.7, 41.6], [24.8, 40.8]],
        ],
        { macedonia: [22.0, 40.3], achaea: [22.3, 37.6], thracia: [25.5, 41.1] },
      ),
    ),
    Turkey: cutBy([25.6, 35.7, 44.9, 42.2], 
      [
        // the Hellespont, the Propontis, the Bosphorus
        [[26.0, 40.0], [26.35, 40.15], [26.6, 40.35], [26.7, 40.42], [27.5, 40.7], [28.3, 40.84], [28.98, 41.0], [29.05, 41.1], [29.1, 41.23], [29.2, 41.4]],
        // Asia | Bithynia, Galatia, Pamphylia
        [[28.3, 40.84], [28.4, 40.3], [28.9, 39.8], [29.6, 39.2], [30.2, 38.7], [30.5, 37.9], [30.5, 37.3], [30.35, 36.6]],
        // Bithynia et Pontus | the plateau
        [[29.6, 39.2], [30.5, 39.9], [31.5, 40.4], [32.8, 40.7], [34.0, 40.9], [35.3, 40.8], [36.4, 40.9], [37.0, 41.2]],
        // the Taurus: Galatia, Cappadocia | Cilicia
        [[30.5, 37.3], [31.5, 37.4], [32.5, 37.4], [33.5, 37.3], [34.5, 37.6], [35.5, 37.7], [36.0, 37.5]],
        // Galatia | Cappadocia
        [[34.0, 40.9], [34.2, 40.0], [34.0, 39.0], [34.3, 38.0], [34.5, 37.6]],
        // the Amanus: Cilicia | Syria
        [[36.0, 37.5], [36.35, 37.0], [36.2, 36.6], [35.9, 36.4]],
        // Cappadocia | Syria (Commagene)
        [[36.0, 37.5], [37.0, 37.9], [38.0, 38.0], [38.6, 37.7]],
        // the Euphrates
        [[41.4, 41.5], [40.5, 40.8], [40.0, 40.0], [39.5, 39.6], [38.9, 39.0], [38.8, 38.4], [38.6, 37.7], [38.2, 37.2], [37.9, 36.6]],
      ],
      {
        thracia: [27.0, 41.3],
        bithynia: [30.5, 40.6],
        asia: [28.5, 38.5],
        galatia: [32.8, 39.5],
        cappadocia: [36.5, 39.5],
        cilicia: [34.5, 37.0],
        syria: [36.6, 37.0],
        decor: [40.5, 37.8],
      },
    ),

    // ---- Oriens
    Cyprus: 'cilicia',
    'N. Cyprus': 'cilicia',
    'Cyprus U.N. Buffer Zone': 'cilicia',
    Akrotiri: 'cilicia',
    Dhekelia: 'cilicia',
    Syria: cutBy([35.6, 32.2, 42.5, 37.4], [[[38.0, 37.0], [38.1, 36.3], [38.8, 35.6], [38.9, 34.5], [38.6, 33.3], [38.4, 32.5]]], {
      syria: [36.7, 35.0],
      decor: [40.5, 35.5],
    }),
    Lebanon: 'syria',
    Israel: 'judaea',
    Palestine: 'judaea',
    // Peraea, across the Jordan, went with Judaea
    Jordan: cutBy([34.9, 29.1, 39.4, 33.5], [[[35.5, 31.2], [36.0, 31.3], [36.05, 32.0], [36.4, 32.45]]], { judaea: [35.75, 31.9], arabia_petraea: [36.5, 30.5] }),
    Egypt: cutBy([24.6, 21.9, 37, 31.8], [[[32.3, 31.6], [32.55, 29.95]]], { aegyptus: [31.0, 30.5], arabia_petraea: [33.8, 30.0] }),
    Libya: cutBy([9.3, 19.4, 25.3, 33.3], [[[19.0, 31.5], [19.0, 20]]], { africa_proconsularis: [13.0, 32.3], cyrenaica: [21.5, 32.3] }),

    // ---- Africa
    Tunisia: 'africa_proconsularis',
    Algeria: cutBy([-8.7, 18.9, 12, 37.2], [[[5.5, 37.1], [5.5, 30]]], { caesariensis: [2.0, 35.5], numidia: [7.0, 36.0] }),
    Morocco: 'tingitana',
    'W. Sahara': 'drop',
  },

  // Everything else near the empire (Ireland, Scandinavia, the steppe, Persia, Arabia) is faint context.
  otherLand: 'decor',
  // The empire's southern and eastern edge: the desert, the Nile ribbon to Aswan, Sinai, the Hauran.
  // In Europe the frontier rivers are drawn by the cuts above; the clip only cuts Scotland at the
  // Antonine Wall and keeps Hibernia outside.
  clip: [
    [-12, 33.5], [-7, 33.6], [-5, 33.8], [-2, 34.4], [1, 34.6], [4, 34.5], [6.5, 34.2], [8, 33.3], [9.5, 32.0],
    [11, 31.6], [13, 31.5], [15, 31.0], [17, 30.6], [19.5, 30.0], [20.5, 30.8], [22, 31.6], [23.5, 31.4],
    [25, 31.0], [27, 30.8], [29, 30.5], [30.4, 30.2],
    // the Nile, west bank up, east bank down
    [30.55, 29.3], [30.45, 28.3], [30.8, 27.3], [31.4, 26.6], [32.4, 26.0], [32.4, 25.3], [32.6, 24.0],
    [33.2, 24.0], [33.0, 25.3], [33.0, 26.2], [32.0, 26.9], [31.5, 27.5], [31.1, 28.4], [31.4, 29.5],
    // Sinai and Arabia Petraea
    [32.4, 29.9], [32.6, 29.5], [33.5, 28.0], [34.4, 27.6], [35.0, 29.4], [36.5, 29.0], [37.5, 30.5],
    [38.0, 32.0], [38.6, 33.3], [39.0, 34.5], [42.5, 34.5],
    [42.5, 47], [30, 50], [20, 51.5], [10, 54.3], [4, 54.5], [0, 56.2],
    // the Antonine Wall, then down the Irish Sea
    [-1, 56.2], [-2.6, 56.1], [-3.6, 56.05], [-4.4, 55.95], [-4.9, 55.9], [-5.0, 55.4], [-5.35, 54.8],
    [-5.4, 54.0], [-5.3, 53.4], [-5.5, 52.0], [-6.0, 50.5], [-8, 48.5], [-12, 44],
  ],
  clipDrop: 2.5,

  laneHints: {
    'britannia_superior|belgica': { ha: [1.3, 51.1], hb: [1.7, 50.9] },
    'baetica|tingitana': { ha: [-5.6, 36.05], hb: [-5.5, 35.85] },
    'campania|sicilia': { ha: [15.65, 38.2], hb: [15.55, 38.25] },
    'thracia|bithynia': { ha: [29.0, 41.1], hb: [29.1, 41.05] },
    'thracia|asia': { ha: [26.3, 40.2], hb: [26.4, 40.05] },
    'apulia|macedonia': { ha: [18.4, 40.1], hb: [19.4, 40.4] },
    'sicilia|africa_proconsularis': { ha: [12.5, 37.8], hb: [11.0, 37.0] },
    'etruria|sardinia_et_corsica': { ha: [10.5, 42.9], hb: [9.45, 42.6] },
    'tarraconensis|balearica': { ha: [0.2, 38.8], hb: [1.3, 38.95] },
    'achaea|creta': { ha: [23.0, 36.5], hb: [23.6, 35.5] },
    'creta|cyrenaica': { ha: [24.0, 35.2], hb: [23.0, 32.6] },
  },
  protectedIslands: ['balearica', 'creta', 'sicilia', 'sardinia_et_corsica'],
  autoFatten: ['balearica', 'creta', 'valentia'],

  continentLabelHints: {
    britannia: [2.5, 54.5],
    gallia: [-5.0, 46.5],
    hispania: [-10.5, 40.0],
    italia: [11.5, 40.2],
    illyricum: [15.2, 43.0],
    graecia_asia: [34.0, 43.0],
    oriens: [31.5, 33.6],
    africa: [2.0, 37.4],
  },
  oceanLabels: [
    { text: 'MARE NOSTRUM', hint: [18.5, 34.5], size: 1.1 },
    { text: 'OCEANUS', hint: [-9.5, 44.8], size: 0.9 },
    { text: 'PONTUS EUXINUS', hint: [33.0, 42.3], size: 0.9 },
  ],

  tuning: { ...DEFAULT_TUNING, gap: 0.45, laneGap: 0.6 },

  previews: [
    { name: 'west', lonLat: [-10, 34, 12, 52], pad: 1, px: 1600 },
    { name: 'italy-greece', lonLat: [6, 34, 28, 47], pad: 1, px: 1600 },
    { name: 'east', lonLat: [22, 24, 42, 44], pad: 1, px: 1600 },
  ],
};
