// Fixture ViewModels for ui-gallery.html: every in-game state of docs/ROUND2.md with real copy.

import type {
  BannerVM,
  BattleVM,
  ButtonVM,
  CardsVM,
  GameVM,
  LogLineVM,
  NewGameVM,
  SeatChipVM,
  SeatRef,
  Settings,
  StripVM,
  TrackSegId,
  TrackSegVM,
  TrackVM,
  ViewModel,
  VictoryVM,
} from '../../game/viewModel';
import type { PlayerColorId, PlayerStats, TerritoryId, TimelinePoint } from '../../engine/types';
import { BOARD } from '../../map';

export const JOHN: SeatRef = { id: 0, name: 'John', color: 'crimson', kind: 'human' };
export const COBALT: SeatRef = { id: 1, name: 'Slate', color: 'cobalt', kind: 'ai' };
export const AMBER: SeatRef = { id: 2, name: 'Ochre', color: 'amber', kind: 'ai' };
export const EMERALD: SeatRef = { id: 3, name: 'Sage', color: 'emerald', kind: 'ai' };
export const SAM: SeatRef = { id: 1, name: 'Sam', color: 'cobalt', kind: 'human' };
const SEATS = [JOHN, COBALT, AMBER, EMERALD];

export const SETTINGS: Settings = {
  animationSpeed: 1,
  aiSpeed: 'watch',
  textSize: 'laptop',
  showLabels: false,
  hideCardsBetweenTurns: false,
  sfxVolume: 0.8,
  muted: false,
  music: true,
  musicVolume: 0.7,
  ambient: true,
  reduceMotion: false,
  showWinChance: true,
  autoCamera: true,
};

export const NEW_GAME: NewGameVM = {
  seats: [
    { name: 'John', color: 'crimson', kind: 'human', difficulty: 'normal' },
    { name: 'Sam', color: 'cobalt', kind: 'human', difficulty: 'normal' },
  ],
  length: 'evening',
  setup: 'quickDeal',
  house: { draft: false, cardBonus: 'progressive', fortifyRule: 'connected', setupBatch: 'auto', seed: null },
  lengthOptions: [
    { id: 'quick', label: 'Quick', detail: '75% or 12 rounds', estimate: '~40 min' },
    { id: 'evening', label: 'Evening', detail: '80% of the world', estimate: '~60–90 min' },
    { id: 'full', label: 'Full conquest', detail: 'every territory', estimate: '2–3 h' },
  ],
  setupOptions: [
    { id: 'quickDeal', label: 'Quick deal', detail: 'Armies placed for you' },
    { id: 'placeOwn', label: 'Place your own', detail: 'Two passes · ~3 min' },
  ],
  summary: 'Territories dealt at random · armies placed for you · first to 34 territories wins',
  canStart: true,
  problems: [],
  canAddSeat: true,
  canRemoveSeat: false,
};

export const NEW_GAME_4: NewGameVM = {
  ...NEW_GAME,
  seats: [
    { name: 'John', color: 'crimson', kind: 'human', difficulty: 'normal' },
    { name: 'Slate', color: 'cobalt', kind: 'ai', difficulty: 'normal' },
    { name: 'Ochre', color: 'amber', kind: 'ai', difficulty: 'normal' },
    { name: 'Sage', color: 'emerald', kind: 'ai', difficulty: 'hard' },
  ],
  lengthOptions: [
    { id: 'quick', label: 'Quick', detail: '60% or 12 rounds', estimate: '~40 min' },
    { id: 'evening', label: 'Evening', detail: '70% of the world', estimate: '~60–90 min' },
    { id: 'full', label: 'Full conquest', detail: 'every territory', estimate: '2–3 h' },
  ],
  summary: 'Territories dealt at random · armies placed for you · first to 30 territories wins',
  canAddSeat: false,
  canRemoveSeat: true,
};

export const NEW_GAME_PROBLEMS: NewGameVM = {
  ...NEW_GAME_4,
  seats: [
    { name: 'John', color: 'crimson', kind: 'human', difficulty: 'normal' },
    { name: 'Sam', color: 'cobalt', kind: 'human', difficulty: 'normal' },
    { name: '', color: 'cobalt', kind: 'ai', difficulty: 'easy' },
  ],
  canStart: false,
  canAddSeat: true,
  problems: ['Two seats share Slate', 'Seat 3 needs a name'],
};

// ---- in game --------------------------------------------------------------

const chips = (cur: number, o: Partial<Record<number, Partial<SeatChipVM>>> = {}): SeatChipVM[] =>
  SEATS.map((seat, i) => ({ seat, current: i === cur, eliminated: false, territories: [14, 11, 9, 8][i], ...(o[i] ?? {}) }));

const btn = (id: ButtonVM['id'], label: string, primary = false): ButtonVM => ({ id, label, primary });
type SegStates = Partial<Record<TrackSegId, TrackSegVM['state']>>;
const LABELS: Record<TrackSegId, string> = { place: 'Place', attack: 'Attack', fortify: 'Fortify', endTurn: 'End turn', setup: 'Setup', done: 'Done' };
/** A main-turn track with the marker on `cur`; later segments eligible unless `states` says otherwise. */
const track = (cur: TrackSegId, o: Partial<TrackVM> & { states?: SegStates } = {}): TrackVM => {
  const ids: TrackSegId[] = cur === 'setup' ? ['setup', 'done'] : ['place', 'attack', 'fortify', 'endTurn'];
  const at = ids.indexOf(cur);
  const { states, ...rest } = o;
  return {
    kind: cur === 'setup' ? 'setup' : 'turn',
    seat: JOHN,
    segments: ids.map((id, i) => ({ id, label: LABELS[id], state: states?.[id] ?? (i < at ? 'done' : i === at ? 'current' : 'eligible') })),
    recommended: null,
    primary: false,
    live: true,
    disabled: false,
    turnKey: '5:0',
    ...rest,
  };
};
const LOCKED: SegStates = { attack: 'locked', fortify: 'locked', endTurn: 'locked' };

const strip = (o: Partial<StripVM>): StripVM => ({
  mode: 'place',
  track: track('place', { states: LOCKED }),
  accent: 'crimson',
  line: '',
  lineKind: 'normal',
  lineKey: 1,
  count: null,
  buttons: [],
  ...o,
});

export const STRIPS: Record<string, StripVM> = {
  place: strip({ line: 'Place 9 armies · click a territory', buttons: [btn('cards', 'Cards 3')] }),
  'place-picked': strip({ line: 'Place on Ural', count: { control: 'slider', value: 9, min: 1, max: 9 }, buttons: [btn('cards', 'Cards 3'), btn('place', 'Place 9', true)] }),
  'place-some': strip({ line: 'Place on Ukraine', count: { control: 'stepper', value: 4, min: 1, max: 4 }, buttons: [btn('undo', 'Undo'), btn('place', 'Place 4', true)] }),
  'place-done': strip({ line: 'All placed · Attack is next', track: track('place', { recommended: 'attack', primary: true }), buttons: [btn('cards', 'Cards 3'), btn('undo', 'Undo')] }),
  'place-forced': strip({ line: 'Trade cards first · you hold 5', track: track('place', { states: LOCKED, disabled: true }), buttons: [btn('trade', 'Trade cards +10', true)] }),
  'place-locked': strip({ line: 'Place your 9 armies first', lineKind: 'rejection', lineKey: 3 }),
  'setup-place': strip({ mode: 'setup', track: track('setup', { states: { done: 'locked' } }), line: 'Place on Ural', count: { control: 'stepper', value: 6, min: 1, max: 6 }, buttons: [btn('undo', 'Undo'), btn('place', 'Place 6', true)] }),
  'setup-done': strip({ mode: 'setup', track: track('setup', { recommended: 'done', primary: true }), line: 'All 10 placed · click Done', buttons: [btn('undo', 'Undo')] }),
  attack: strip({ mode: 'attack', track: track('attack'), line: 'Click an enemy territory to attack' }),
  'attack-armed': strip({ mode: 'attack', track: track('attack'), line: 'Ural → Siberia · 82% · likely', buttons: [btn('roll', 'Roll'), btn('blitz', 'Blitz', true)] }),
  'attack-rolling': strip({ mode: 'attack', track: track('attack', { disabled: true }), line: 'Ural → Siberia · 91% · almost sure', buttons: [btn('roll', 'Roll'), btn('blitz', 'Blitz', true)] }),
  'attack-none': strip({ mode: 'attack', track: track('attack', { recommended: 'endTurn', primary: true }), line: 'No attacks left · end your turn' }),
  rejection: strip({ mode: 'attack', track: track('attack'), line: "Peru doesn't border any of yours", lineKind: 'rejection', lineKey: 7 }),
  occupy: strip({ mode: 'occupy', track: track('attack', { states: { fortify: 'locked', endTurn: 'locked' }, disabled: true }), line: 'Move into Siberia', count: { control: 'stepper', value: 8, min: 3, max: 8 }, buttons: [btn('move', 'Move 8', true)] }),
  'occupy-totals': strip({ mode: 'occupy', track: track('attack', { states: { fortify: 'locked', endTurn: 'locked' }, disabled: true }), line: 'Ural 1 · Siberia 14', count: { control: 'slider', value: 14, min: 3, max: 14 }, buttons: [btn('move', 'Move 14', true)] }),
  fortify: strip({ mode: 'fortify', track: track('fortify', { recommended: 'endTurn', primary: true }), line: 'Move armies once, or end your turn' }),
  'fortify-picked': strip({ mode: 'fortify', track: track('fortify', { recommended: 'endTurn' }), line: 'Move from Ural to Siberia', count: { control: 'slider', value: 8, min: 1, max: 8 }, buttons: [btn('move', 'Move 8 · end turn', true)] }),
  'ai-turn': strip({ mode: 'watching', track: track('attack', { seat: COBALT, live: false, turnKey: '6:1' }), accent: 'cobalt', line: 'Slate attacks Siam', lineKind: 'narration' }),
  'humans-out': strip({ mode: 'watching', track: track('fortify', { seat: AMBER, live: false, turnKey: '9:2' }), accent: 'amber', line: 'All humans are out', buttons: [btn('callGame', 'End game'), btn('watchAis', 'Watch to the end', true)] }),
  'sam-turn': strip({ track: track('place', { seat: SAM, turnKey: '6:1' }), accent: 'cobalt', line: 'Place 7 armies · click a territory' }),
  'occupy-collapsed': strip({ mode: 'occupy', track: track('attack', { states: { fortify: 'locked', endTurn: 'locked' }, disabled: true }), line: 'Move into Siberia', count: { control: 'slider', value: 11, min: 3, max: 11, collapsed: true }, buttons: [btn('move', 'Move 11', true)] }),
};

export const ARMED: BattleVM = {
  attacker: { seat: JOHN, territory: 'Ural', armies: 12 },
  defender: { seat: COBALT, territory: 'Siberia', armies: 5 },
  rolling: false,
  captured: null,
};

const CARDS: CardsVM = {
  open: false,
  hand: [
    { id: 4, symbol: 'infantry', territory: 'Ontario', ownedBonus: false, inSet: true },
    { id: 11, symbol: 'cavalry', territory: 'Brazil', ownedBonus: true, inSet: true },
    { id: 30, symbol: 'artillery', territory: 'Mongolia', ownedBonus: false, inSet: true },
  ],
  status: 'Set ready · +8',
  trade: { label: 'Trade for +8' },
};

const LOG: LogLineVM[] = [
  { id: 1, round: 6, seat: AMBER, kind: 'engagement', text: 'Ochre took Siam from India · 9 vs 3 · lost 2' },
  { id: 2, round: 6, seat: AMBER, kind: 'continent', text: 'Ochre holds Australia · +2 a turn' },
  { id: 3, round: 6, seat: EMERALD, kind: 'engagement', text: 'Slate held Ukraine against Sage · 4 vs 2 · Sage lost 3 · an upset (Sage had 76%)' },
  { id: 4, round: 7, seat: JOHN, kind: 'turn', text: "Round 7 · John's turn · +9" },
  { id: 5, round: 7, seat: JOHN, kind: 'recap', text: 'Ochre took Siam and India from you' },
  { id: 6, round: 7, seat: JOHN, kind: 'card', text: 'John traded 3 cards for +8' },
  { id: 7, round: 7, seat: JOHN, kind: 'engagement', text: 'John took Siberia from Ural · 12 vs 5 · lost 3' },
];

export const BASE_GAME: GameVM = {
  seats: chips(0),
  strip: STRIPS.place,
  battle: null,
  cards: CARDS,
  log: LOG,
  banner: null,
  handoff: null,
  confirm: null,
  seatActions: [{ seat: JOHN, label: 'Let the AI play John', intent: { type: 'setController', player: 0, kind: 'ai', difficulty: 'normal' } }],
  viewMoved: false,
};

const banner = (o: Partial<BannerVM>): BannerVM => ({ id: 1, kind: 'turn', line: 'John · 9 armies', title: "JOHN'S TURN", sub: '+9 armies', recap: null, seat: JOHN, holdMs: 1000, ...o });

// ---- victory --------------------------------------------------------------

const series = (vals: number[][]): TimelinePoint[] =>
  vals[0].map((_, i) => ({
    round: i + 1,
    territories: vals.map((v) => v[i]),
    armies: vals.map((v) => v[i] * 3),
  }));
const TL = series([
  [11, 12, 13, 14, 14, 16, 18, 19, 22, 24, 26, 29, 31, 31],
  [10, 11, 11, 10, 12, 11, 10, 9, 8, 8, 7, 6, 5, 5],
  [11, 10, 11, 12, 11, 11, 12, 12, 11, 10, 9, 7, 6, 6],
  [10, 9, 7, 6, 5, 4, 2, 2, 1, 0, 0, 0, 0, 0],
]);
TL[TL.length - 1].round = 13; // the final point repeats the last round

const stats = (a: Partial<PlayerStats>): PlayerStats => ({
  territoriesConquered: 0,
  battlesWon: 0,
  battlesLost: 0,
  armiesDestroyed: 0,
  armiesLost: 0,
  cardsTraded: 0,
  reinforcementsReceived: 0,
  peakTerritories: 0,
  ...a,
});

export const VICTORY: VictoryVM = {
  winner: JOHN,
  title: 'John holds the world',
  subline: 'Round 13 · 31 territories',
  awards: [
    { id: 'nemesis', title: 'Nemesis', text: 'John took 11 territories from Slate', seat: JOHN },
    { id: 'cursedDice', title: 'Cursed dice', text: 'Ochre: −5 armies of pure bad luck', seat: AMBER },
    { id: 'cashIn', title: 'Biggest cash-in', text: '+20 · round 11', seat: COBALT },
  ],
  seats: SEATS,
  timeline: TL,
  standings: [
    { seat: JOHN, place: 1, territories: 31, stats: stats({ territoriesConquered: 29, battlesWon: 61, battlesLost: 38, armiesDestroyed: 142, armiesLost: 97, cardsTraded: 4, reinforcementsReceived: 138, peakTerritories: 31 }) },
    { seat: AMBER, place: 2, territories: 6, stats: stats({ territoriesConquered: 14, battlesWon: 33, battlesLost: 41, armiesDestroyed: 71, armiesLost: 90, cardsTraded: 3, reinforcementsReceived: 96, peakTerritories: 13 }) },
    { seat: COBALT, place: 3, territories: 5, stats: stats({ territoriesConquered: 12, battlesWon: 29, battlesLost: 44, armiesDestroyed: 63, armiesLost: 101, cardsTraded: 3, reinforcementsReceived: 88, peakTerritories: 12 }) },
    { seat: EMERALD, place: 4, territories: 0, stats: stats({ territoriesConquered: 6, battlesWon: 12, battlesLost: 25, armiesDestroyed: 30, armiesLost: 58, cardsTraded: 1, reinforcementsReceived: 51, peakTerritories: 10 }) },
  ],
};

// ---- assemble -------------------------------------------------------------

export interface Fixture {
  id: string;
  group: string;
  label: string;
  vm: ViewModel;
  /** Post-mount pokes at local UI state. */
  after?: 'openHouse' | 'openMore' | 'skipVictoryIntro';
  /** Dice the fake tray shows (attacker, defender). */
  dice?: [number[], number[]] | null;
}

const RULES = ['Goal: first to 30 territories wins.', 'Card sets: 4, 6, 8, 10, 12, 15, then +5 each.', 'Fortify: along any chain of your territories.'];

const root = (o: Partial<ViewModel>): ViewModel => ({
  screen: 'game',
  overlay: null,
  settings: SETTINGS,
  reducedMotion: false,
  save: null,
  newGame: NEW_GAME_4,
  game: BASE_GAME,
  victory: null,
  rulesNotes: RULES,
  ...o,
});
/** GameVM.gold as the controller picks it: the open Cards sheet's trade → the pending commit → the recommended segment → the current one. */
function goldOf(g: GameVM): GameVM['gold'] {
  if (g.cards?.open && g.cards.trade) return { kind: 'cardsTrade' };
  const b = g.strip.buttons.find((x) => x.primary);
  if (b) return { kind: 'button', id: b.id };
  if (g.strip.track.recommended) return { kind: 'segment', seg: g.strip.track.recommended };
  const cur = g.strip.track.segments.find((x) => x.state === 'current');
  return cur ? { kind: 'segment', seg: cur.id } : null;
}
const game = (o: Partial<GameVM>, r: Partial<ViewModel> = {}): ViewModel => {
  const g: GameVM = { ...BASE_GAME, ...o };
  return root({ game: { ...g, gold: o.gold !== undefined ? o.gold : goldOf(g) }, ...r });
};

export function fixtures(_W: number, _H: number): Fixture[] {
  const F: Fixture[] = [];
  const add = (id: string, group: string, label: string, vm: ViewModel, extra: Partial<Fixture> = {}) => F.push({ id, group, label, vm, ...extra });

  // Screens
  add('boot', 'Screens', 'Boot', root({ screen: 'boot', game: null }));
  add('title', 'Screens', 'Title, no save', root({ screen: 'title', game: null }));
  // The Continue thumbnail (v4 §7.13): a board as it was left, coloured by longitude bands, then mixed.
  const owners: Partial<Record<TerritoryId, PlayerColorId>> = {};
  const cols: PlayerColorId[] = ['crimson', 'cobalt', 'amber', 'emerald'];
  Object.entries(BOARD.territories).forEach(([id, t], i) => (owners[id as TerritoryId] = cols[(Math.floor((t.anchor[0] / BOARD.width) * 4) + (i % 5 === 0 ? 1 : 0)) % 4]));
  add('title-save', 'Screens', 'Title with a save', root({ screen: 'title', game: null, save: { summary: 'Round 7 · John vs 3 AI', sketch: { owners } } }));
  add('newgame-2', 'Screens', 'New game, 2 seats', root({ screen: 'newGame', game: null, newGame: NEW_GAME }));
  add('newgame-4', 'Screens', 'New game, 4 seats', root({ screen: 'newGame', game: null, newGame: { ...NEW_GAME_4, setup: 'placeOwn', summary: 'Territories dealt at random · you place your own armies · first to 30 territories wins' } }));
  add('newgame-problems', 'Screens', 'New game, problems', root({ screen: 'newGame', game: null, newGame: NEW_GAME_PROBLEMS }));
  add('newgame-house', 'Screens', 'New game, More open (house rules changed)', root({ screen: 'newGame', game: null, newGame: { ...NEW_GAME_4, house: { draft: true, cardBonus: 'fixed', fortifyRule: 'adjacent', setupBatch: 5, seed: 1234 } } }), { after: 'openHouse' });
  // v5.1 D: three decisions; personalities random and hidden ('Any') unless a player picks one under More.
  const NG51: NewGameVM = {
    ...NEW_GAME_4,
    seats: NEW_GAME_4.seats.map((x, i) => ({ ...x, personality: i === 3 ? 'warlord' : undefined })),
    maps: [
      { id: 'classic', name: 'Classic', description: 'The board you know: six continents, 42 territories', seats: '2–4 players', thumbnail: null, disabled: false },
      { id: 'true-world', name: 'True world', description: 'The same game on a truer map', seats: '2–4 players', thumbnail: null, disabled: false },
    ],
    mapId: 'classic',
    personalities: [
      { id: 'turtle', name: 'Turtle', line: 'Holds what it has and keeps its word' },
      { id: 'opportunist', name: 'Opportunist', line: 'Takes what is loose' },
      { id: 'warlord', name: 'Warlord', line: 'Attacks first and remembers' },
    ],
  };
  add('newgame-51', 'v5.1', 'New game · three decisions (More folded)', root({ screen: 'newGame', game: null, newGame: NG51 }));
  add('newgame-51-more', 'v5.1', 'New game · More open', root({ screen: 'newGame', game: null, newGame: NG51 }), { after: 'openMore' });
  add('victory', 'Screens', 'Victory (intro banner)', root({ screen: 'victory', game: null, victory: VICTORY }));
  add('victory-full', 'Screens', 'Victory: awards + chart', root({ screen: 'victory', game: null, victory: VICTORY }), { after: 'skipVictoryIntro' });

  // Place
  add('place', 'Place', 'Place · nothing picked, set ready', game({}));
  add('place-picked', 'Place', 'Place · Ural picked', game({ strip: STRIPS['place-picked'] }));
  add('place-some', 'Place', 'Place · after a placement', game({ strip: STRIPS['place-some'] }));
  add('place-done', 'Place', 'Place · all placed', game({ strip: STRIPS['place-done'] }));
  add('place-locked', 'Place', 'Place · clicked a locked segment', game({ strip: STRIPS['place-locked'] }));
  add('place-forced', 'Place', 'Place · forced trade', game({ strip: STRIPS['place-forced'] }));
  add('cards', 'Place', 'Cards sheet open', game({ strip: STRIPS.place, cards: { ...CARDS, open: true } }));
  add('cards-none', 'Place', 'Cards sheet · no set', game({
    strip: { ...STRIPS.place, buttons: [btn('cards', 'Cards 2')] },
    cards: {
      open: true,
      hand: [
        { id: 4, symbol: 'infantry', territory: 'Ontario', ownedBonus: false, inSet: false },
        { id: 5, symbol: 'cavalry', territory: 'Quebec', ownedBonus: true, inSet: false },
      ],
      status: 'Need 1 artillery, or a wild',
      trade: null,
    },
  }));
  add('setup-place', 'Place', 'Setup · Ural picked', game({ strip: STRIPS['setup-place'], cards: null }));
  add('setup-done', 'Place', 'Setup · all placed', game({ strip: STRIPS['setup-done'], cards: null }));

  // Attack
  add('attack', 'Attack', 'Attack · nothing armed', game({ strip: STRIPS.attack, cards: null }));
  add('attack-armed', 'Attack', 'Attack · armed', game({ strip: STRIPS['attack-armed'], battle: ARMED, cards: null }), { dice: null });
  add('attack-rolling', 'Attack', 'Attack · rolling', game({ strip: STRIPS['attack-rolling'], battle: { ...ARMED, attacker: { ...ARMED.attacker, armies: 11 }, defender: { ...ARMED.defender, armies: 3 }, rolling: true, tray: true }, cards: null }), { dice: [[6, 5, 2], [4, 3]] });
  add('attack-none', 'Attack', 'Attack · nothing left to attack', game({ strip: STRIPS['attack-none'], cards: null }));
  add('rejection', 'Attack', 'Refused click', game({ strip: STRIPS.rejection, cards: null }));
  add('captured', 'Attack', 'Conquest · tray header', game({ strip: STRIPS.occupy, battle: { ...ARMED, attacker: { ...ARMED.attacker, armies: 9 }, defender: { ...ARMED.defender, armies: 0 }, captured: 'Siberia captured' }, cards: null, seats: chips(0, { 0: { territories: 15 }, 1: { territories: 10 } }) }));
  add('occupy', 'Attack', 'Occupy', game({ strip: STRIPS.occupy, cards: null, seats: chips(0, { 0: { territories: 15 }, 1: { territories: 10 } }) }));
  add('occupy-totals', 'Attack', 'Occupy · totals while choosing', game({ strip: STRIPS['occupy-totals'], cards: null, seats: chips(0, { 0: { territories: 15 }, 1: { territories: 10 } }) }));

  // Fortify
  add('fortify', 'Fortify', 'Fortify · nothing picked', game({ strip: STRIPS.fortify, cards: null }));
  add('fortify-picked', 'Fortify', 'Fortify · Ural → Siberia', game({ strip: STRIPS['fortify-picked'], cards: null }));

  // Watching
  add('ai-turn', 'Watching', 'AI turn · narration', game({ strip: STRIPS['ai-turn'], seats: chips(1), cards: null, battle: { attacker: { seat: COBALT, territory: 'India', armies: 9 }, defender: { seat: AMBER, territory: 'Siam', armies: 3 }, rolling: true, captured: null, tray: true } }), { dice: [[5, 5, 1], [2, 1]] });
  add('humans-out', 'Watching', 'All humans out', game({ strip: STRIPS['humans-out'], seats: chips(2, { 0: { eliminated: true, territories: 0, out: { by: AMBER, round: 11 } } }), cards: null }));


  // Banners
  add('turn-banner', 'Banners', 'Turn banner', game({ banner: banner({}) }));
  add('turn-banner-recap', 'Banners', 'Turn banner with recap', game({ banner: banner({ id: 2, recap: 'Slate took Ural and Siberia from you', holdMs: 1600 }) }));
  add('banner-continent', 'Banners', 'Continent captured', game({ banner: banner({ id: 3, kind: 'continent', line: 'John holds Asia · +7', title: 'JOHN HOLDS ASIA · +7', sub: '', holdMs: 1200 }), strip: STRIPS.attack, cards: null }));
  add('banner-out', 'Banners', 'Elimination', game({ banner: banner({ id: 4, kind: 'elimination', line: 'Sage · taken by John · round 9', title: 'SAGE IS OUT', sub: '', seat: EMERALD, holdMs: 1600 }), seats: chips(0, { 3: { eliminated: true, territories: 0, out: { by: JOHN, round: 9 } } }), strip: STRIPS.attack, cards: null }));

  // Menu
  add('menu', 'Menu', 'Menu', game({ strip: STRIPS.attack, cards: null }, { overlay: 'pause' }));
  add('view-moved', 'Menu', 'Camera moved · Reset view pill', game({ strip: STRIPS.attack, cards: null, viewMoved: true }));
  add('rules', 'Menu', 'Rules', game({ strip: STRIPS.attack, cards: null }, { overlay: 'rules' }));
  add('settings', 'Menu', 'Settings', game({ strip: STRIPS.attack, cards: null }, { overlay: 'settings' }));
  add('log', 'Menu', 'Log', game({ strip: STRIPS.attack, cards: null }, { overlay: 'log' }));
  add('confirm-end', 'Menu', 'Confirm: End game now', game({ confirm: { kind: 'endGame', text: 'End the game now? John wins on territories (14 of 42).' }, strip: STRIPS.attack, cards: null }));
  add('title-rules', 'Menu', 'Rules from the title', root({ screen: 'title', game: null, overlay: 'rules' }));
  // v5 · the war in ink, the turn ritual, details (fixtures to build against before the controller lands)
  const hold = (armies: number, breakdown = '3 territories · Asia +4') => ({ seat: JOHN, armies, breakdown });
  const placeLine = (n: number) => ({ ...STRIPS.place, line: `Place ${n} ${n === 1 ? 'army' : 'armies'} · click a territory` });
  add('holding-7', 'v5', 'Holding dab · 7 to place', game({ strip: placeLine(7), holding: hold(7) }));
  add('holding-2', 'v5', 'Holding dab · 2 left', game({ strip: { ...STRIPS['place-some'], line: 'Place on Ukraine', count: { control: 'stepper', value: 2, min: 1, max: 2 }, buttons: [btn('undo', 'Undo'), btn('place', 'Place 2', true)] }, holding: hold(2) }));
  add('holding-15', 'v5', 'Holding dab · 15 (a numeral)', game({ strip: placeLine(15), holding: hold(15, '9 territories · Asia +7 · cards +8') }));
  add('holding-reduced', 'v5', 'Holding dab · reduced motion', game({ strip: placeLine(7), holding: hold(7) }, { reducedMotion: true, settings: { ...SETTINGS, reduceMotion: true } }));
  const grudgeSeats = chips(0, {
    0: { continents: ['australia'], cards: 3 },
    1: { grudgeTicks: 3, continents: ['europe'], cards: 2, personality: { name: 'Warlord', line: 'Attacks first' }, voiceLine: 'Slate holds Europe · it will keep it' },
    2: { grudgeTicks: 11, cards: 4, personality: { name: 'Turtle', line: 'Keeps its word' } },
    3: { grudgeTicks: 1, continents: ['south_america', 'africa'], personality: { name: 'Opportunist', line: 'Takes what is loose' }, voiceLine: 'Sage remembers that' },
  });
  add('grudge-ticks', 'v5', 'Grudge ticks · voice lines', game({ seats: grudgeSeats, strip: STRIPS.attack, cards: null }));
  const REPLAY_LINES = [
    'The deal: John, Slate, Ochre and Sage take the world',
    'Slate takes Ukraine from Sage',
    'Ochre holds Australia',
    'John takes Ural and Siberia',
    'Sage loses South America',
    'Siberia changes hands three times',
    'John takes Asia',
    'Ochre breaks into Africa',
    'Sage is out · taken by John',
    'Slate is pushed out of Europe',
    'John takes Africa from Ochre',
    'John holds 28 territories',
    'John holds the world',
  ];
  const MOMENTS = ['Round 6: Siberia changed hands three times', 'Round 9: Sage was knocked out by John', 'Round 4: John took Asia and held it to the end'];
  const REPLAY: NonNullable<GameVM['replay']> = {
    key: 1,
    winner: JOHN,
    rounds: REPLAY_LINES.map((line, i) => ({ round: i + 1, owners: {}, line })),
    moments: MOMENTS,
    msPerRound: 1300,
  };
  add('replay', 'v5', 'Replay · the war in ink', root({ screen: 'victory', game: { ...BASE_GAME, cards: null, replay: REPLAY }, victory: VICTORY }));
  add('victory-moments', 'v5', 'Recap · turning points', root({ screen: 'victory', game: null, victory: { ...VICTORY, moments: MOMENTS } }), { after: 'skipVictoryIntro' });
  add('name-card-history', 'v5', 'Name card · a stone\'s history', game({ strip: STRIPS.attack, cards: null, nameCard: { territory: 'Ural', continent: 'Asia', bonus: 7, owner: JOHN, armies: 19, x: Math.round(_W * 0.62), y: Math.round(_H * 0.42), key: 1, history: 'Held since round 3 · taken from Sage' } }));
  // v5.1 · decide, don't ask: whose turn as a filled ring, standing marks, the understanding tie, ask for peace
  const standingSeats = (cur: number, o: Partial<Record<number, Partial<SeatChipVM>>> = {}) =>
    chips(cur, {
      0: { continents: ['australia'], cards: 3, ...(o[0] ?? {}) },
      1: { standing: 'ally', standingReason: 'Slate is your ally · peace for 2 more rounds', grudgeTicks: 0, continents: ['europe'], cards: 2, ...(o[1] ?? {}) },
      2: { standing: 'wary', standingReason: 'Ochre is wary of you · you took Siam last round', canAskPeace: true, grudgeTicks: 2, cards: 4, ...(o[2] ?? {}) },
      3: { standing: 'hostile', standingReason: 'Sage is hostile · you broke the peace in round 4', grudgeTicks: 4, continents: ['south_america'], ...(o[3] ?? {}) },
    });
  add('seats-standing', 'v5.1', 'Seat strip · filled current ring, standing marks', game({ seats: standingSeats(0), strip: STRIPS.attack, cards: null }));
  add('seats-even', 'v5.1', 'Seat strip · all four standings', game({ seats: standingSeats(0, { 1: { standing: 'even', standingReason: 'Slate is even with you · you share no border' }, 2: { standing: 'ally' }, 3: { standing: 'wary' } }), strip: STRIPS.attack, cards: null }));
  add('seats-ai-turn', 'v5.1', 'Seat strip · an AI\'s turn (its ring filled)', game({ seats: standingSeats(2), strip: { ...STRIPS['ai-turn'], track: track('attack', { seat: AMBER, live: false, turnKey: '6:2' }), accent: 'amber', line: 'Ochre attacks Siam' }, cards: null }));
  add('understanding', 'v5.1', 'Understanding tie · Ochre and Sage', game({ seats: standingSeats(0, { 2: { understandingWith: [3] }, 3: { understandingWith: [2] } }), strip: STRIPS.attack, cards: null }));
  add('sam-turn', 'v5.1', 'Two humans · Sam\'s turn (no cover)', game({ seats: [JOHN, SAM, AMBER, EMERALD].map((seat, i) => ({ seat, current: i === 1, eliminated: false, territories: [14, 11, 9, 8][i] })), strip: STRIPS['sam-turn'], cards: null, holding: { seat: SAM, armies: 7, breakdown: '11 territories · Europe +5' } }));
  add('occupy-collapsed', 'v5.1', 'Occupy · all but one, count folded', game({ strip: STRIPS['occupy-collapsed'], cards: null, seats: chips(0, { 0: { territories: 15 }, 1: { territories: 10 } }) }));
  add('settings-folded', 'v5.1', 'Settings · four things, More folded', game({ strip: STRIPS.attack, cards: null }, { overlay: 'settings' }));
  add('reduced', 'Menu', 'Reduced motion on', game({ strip: STRIPS['attack-armed'], battle: ARMED, cards: null }, { reducedMotion: true, settings: { ...SETTINGS, reduceMotion: true } }), { dice: null });
  return F;
}
