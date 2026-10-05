// AI-vs-AI soak: `npm run sim [games] [-- --map <id>]` (default 200 games on classic). Exits non-zero on any failure.
//
// v6 maps: `--map <id>` plays every table on that pack's rules and topology (a hidden pack such as test-twelve
// too). Tables whose seat count the pack does not support are skipped and say so. The tuning bands below
// (truces proposed, understandings formed, missions' share of endings) were set on classic; on another map
// they print as NOTE lines instead of failing. Every game must still finish legally on any map.
//
// Every game must end in gameOver, with every AI action legal on the first try (no fallback),
// under 500 rounds, with the invariants below holding after every action.
//
// After the classic sections: personalities (4p pair tables and a free-for-all), diplomacy counts, standing
// (v5.1: rounds per table, AI-AI understandings formed / broken / turned, the spread of bands),
// the 2-player first-mover rate with and without the neutral seat (plus its rounds table for
// presets.ts), and AI decision time per turn.

import { performance } from 'node:perf_hooks';
import {
  applyAction,
  chooseAiAction,
  createGame,
  missionComplete,
  missionGoal,
  missionHeadline,
  standingOf,
  mapDefOf,
  targetTerritories,
  UNCLAIMED,
  validateAction,
  type AiDifficulty,
  type AiPersonality,
  type GameConfig,
  type GameEventType,
  type GameState,
  type PlayerConfig,
  type Standing,
} from '../src/engine';
import { decide } from '../src/engine/ai/brain';
import { isKnownMap } from '../src/map/packs';
import { hashInts, random, type RngHolder } from '../src/engine/rng';

const COLORS = ['crimson', 'cobalt', 'emerald', 'amber'] as const;

// --- Arguments: [games] [--map <id>] -------------------------------------------------------------------
const argv = process.argv.slice(2);
const mapAt = argv.indexOf('--map');
const MAP_ID = mapAt >= 0 ? argv[mapAt + 1] : 'classic';
if (!MAP_ID || !isKnownMap(MAP_ID)) {
  console.error(`--map ${MAP_ID ?? ''}: no such map pack`);
  process.exit(2);
}
const MAP = mapDefOf({ mapId: MAP_ID });
const CLASSIC = MAP_ID === 'classic';
const SEATS = MAP.rules.seats;
const positional = argv.filter((a, i) => !a.startsWith('--') && !(mapAt >= 0 && i === mapAt + 1));
/** Seat counts the map plays. */
const seatOk = (n: number) => n >= SEATS.min && n <= SEATS.max;
const skipped = new Set<string>();
const DIFFS: AiDifficulty[] = ['easy', 'normal', 'hard'];
const MAX_ROUNDS = 500;
const MAX_ACTIONS = 200_000;

interface GameResult {
  winner: number;
  reason: string;
  rounds: number;
  actions: number;
  players: PlayerConfig[];
  /** Round in which some player first held ≥ 60 / 70 / 100 % of the board. */
  reach: Record<number, number>;
  firstPlayer: number;
  /** Diplomacy event counts. */
  dip: Partial<Record<GameEventType, number>>;
  /** Per seat: main turns, conquests, eliminations made, truces broken, turns started holding a continent. */
  seatStats: SeatStats[];
  /** v5 G: 'mission' when a secret mission ended it, with the winner's goal kind and the headline. */
  by?: 'mission';
  missionKind?: string;
  headline?: string;
}

interface SeatStats {
  turns: number;
  conq: number;
  elim: number;
  breaks: number;
  contTurns: number;
  fights: number;
  /** Fights started with under 1.6× the defender's armies / with 3× or more. */
  even: number;
  lopsided: number;
  /** Armies lost while attacking. */
  spent: number;
}
/** Per-seat play style is measured over the opening, while every seat is still in. */
const OPENING_ROUNDS = 6;
const emptySeat = (): SeatStats => ({ turns: 0, conq: 0, elim: 0, breaks: 0, contTurns: 0, fights: 0, even: 0, lopsided: 0, spent: 0 });

/** Decision time summed over each main turn (ms), bucketed by label. */
const turnTimes: Record<string, number[]> = {};
/** Fights (attack/blitz actions) per main turn, same buckets: the on-screen length of an AI turn. */
const fightsPerTurn: Record<string, number[]> = {};
let turnBucket = 'soak';

/** Win thresholds the New game presets use (3–4p: 60 / 70 / 100; 2p: 75 / 80 / 100). */
const THRESHOLDS = [60, 70, 75, 80, 100];

/** SPEC §11.4: how the AI shapes its actions (bulk placements, blitz over single rolls). */
const shape = { reinforceActions: 0, reinforceArmies: 0, attack: 0, blitz: 0 };

const decisionTimes: number[] = [];

/** v5.1 standing: understandings ended because a side turned (truceExpired 'standing'), and band samples. */
let standingTurned = 0;
let sampleBands = false;
const bandCount: Record<Standing, number> = { ally: 0, even: 0, wary: 0, hostile: 0 };
function sampleStandings(s: GameState): void {
  for (const a of s.players) {
    if (a.kind !== 'ai' || a.eliminated || a.neutral) continue;
    for (const b of s.players) if (b.id !== a.id && !b.eliminated && !b.neutral) bandCount[standingOf(s, a.id, b.id)]++;
  }
}
const failures: string[] = [];
const notes: string[] = [];
/** A tuning band measured on classic: a failure there, a NOTE on any other map. */
const band = (msg: string) => (CLASSIC ? failures : notes).push(msg);

function check(s: GameState, label: string): void {
  const cards = s.deck.length + s.discard.length + s.players.reduce((a, p) => a + p.cards.length, 0);
  if (cards !== MAP.size + 2) throw new Error(`${label}: card count ${cards} != ${MAP.size + 2}`);
  const ids = new Set<number>();
  for (const c of [...s.deck, ...s.discard, ...s.players.flatMap((p) => p.cards)]) {
    if (ids.has(c.id)) throw new Error(`${label}: duplicate card ${c.id}`);
    ids.add(c.id);
  }
  if (!s.phase.kind.startsWith('setup')) {
    for (const t of MAP.territoryIds) {
      const x = s.territories[t];
      if (x.owner === UNCLAIMED) throw new Error(`${label}: ${t} unclaimed in main play`);
      if (x.armies < 1 && s.phase.kind !== 'occupy') throw new Error(`${label}: ${t} has ${x.armies} armies`);
      if (s.players[x.owner].eliminated) throw new Error(`${label}: ${t} owned by eliminated player`);
    }
    if (s.players[s.currentPlayer].eliminated && s.phase.kind !== 'game-over')
      throw new Error(`${label}: current player is eliminated`);
  }
}

function playGame(config: GameConfig, label: string): GameResult {
  let { state } = createGame(config);
  check(state, label);
  let actions = 0;
  const reach: Record<number, number> = {};
  const track = () => {
    if (state.round === 0) return;
    const counts = new Array<number>(state.players.length).fill(0);
    for (const t of MAP.territoryIds) counts[state.territories[t].owner]++;
    const top = Math.max(...counts.filter((_, i) => !state.players[i].neutral));
    for (const pct of THRESHOLDS) if (reach[pct] === undefined && top >= targetTerritories(MAP, pct)) reach[pct] = state.round;
  };
  const dip: Partial<Record<GameEventType, number>> = {};
  const seatStats = state.players.map(emptySeat);
  let turnAcc = 0;
  let turnNo = state.turn;
  const bucket = (turnTimes[turnBucket] ??= []);
  const fBucket = (fightsPerTurn[turnBucket] ??= []);
  let turnFights = 0;
  while (state.phase.kind !== 'game-over') {
    if (++actions > MAX_ACTIONS) throw new Error(`${label}: stuck (${MAX_ACTIONS} actions, round ${state.round})`);
    if (state.round > MAX_ROUNDS) throw new Error(`${label}: exceeded ${MAX_ROUNDS} rounds`);
    const me = state.currentPlayer;
    const raw = decide(state, me);
    const rawErr = validateAction(state, raw);
    if (rawErr) throw new Error(`${label}: AI chose illegal ${JSON.stringify(raw)} in ${state.phase.kind}: ${rawErr}`);
    const t0 = performance.now();
    const action = chooseAiAction(state, me);
    const dt = performance.now() - t0;
    decisionTimes.push(dt);
    turnAcc += dt;
    if (action.type === 'reinforce') {
      shape.reinforceActions++;
      shape.reinforceArmies += action.count ?? 1;
    } else if (action.type === 'attack') shape.attack++;
    else if (action.type === 'blitz') shape.blitz++;
    if ((action.type === 'blitz' || action.type === 'attack') && state.round <= OPENING_ROUNDS) {
      const st = seatStats[me];
      st.fights++;
      const ratio = state.territories[action.from].armies / Math.max(1, state.territories[action.to].armies);
      if (ratio < 1.6) st.even++;
      else if (ratio >= 3) st.lopsided++;
    }
    const res = applyAction(state, action);
    if (!res.ok) throw new Error(`${label}: applyAction rejected ${JSON.stringify(action)}: ${res.error}`);
    if (res.events.length === 0) throw new Error(`${label}: action produced no events ${JSON.stringify(action)}`);
    state = res.state;
    const opening = state.round >= 1 && state.round <= OPENING_ROUNDS;
    for (const e of res.events) {
      if (e.type.startsWith('truce') || e.type.startsWith('peace') || e.type === 'standingChanged') dip[e.type] = (dip[e.type] ?? 0) + 1;
      if (e.type === 'truceExpired' && e.reason === 'standing') standingTurned++;
      if (e.type === 'turnStarted' && sampleBands) sampleStandings(state);
      if (e.type === 'playerEliminated') seatStats[e.by].elim++;
      else if (e.type === 'truceBroken') seatStats[e.by].breaks++;
      if (!opening) continue;
      if (e.type === 'turnStarted') {
        seatStats[e.player].turns++;
        if (e.reinforcements.continents.length) seatStats[e.player].contTurns++;
      } else if (e.type === 'territoryConquered') seatStats[e.player].conq++;
      else if (e.type === 'diceRolled') seatStats[e.player].spent += e.attackerLosses;
    }
    if (action.type === 'blitz' || action.type === 'attack') turnFights++;
    if (state.turn !== turnNo) {
      if (turnNo > 0) {
        bucket.push(turnAcc);
        fBucket.push(turnFights);
      }
      turnFights = 0;
      turnAcc = 0;
      turnNo = state.turn;
    }
    check(state, label);
    track();
  }
  if (state.phase.kind !== 'game-over') throw new Error('unreachable');
  const ph = state.phase;
  if (ph.by === 'mission') {
    // Nobody wins by a mission they do not hold, and only by one that is met.
    if (!missionComplete(state, ph.winner)) throw new Error(`${label}: mission win by ${ph.winner} with the mission unmet`);
    if (ph.mission !== missionHeadline(state, ph.winner)) throw new Error(`${label}: mission headline mismatch`);
  }
  const mk = ph.by === 'mission' ? missionGoal(state, ph.winner)?.kind : undefined;
  return {
    ...(ph.by ? { by: ph.by, headline: ph.mission, missionKind: mk } : {}),
    winner: state.phase.winner,
    reason: state.phase.reason,
    rounds: state.round,
    actions,
    players: config.players,
    reach,
    firstPlayer: state.firstPlayer,
    dip,
    seatStats,
  };
}

function makeConfig(i: number, players: PlayerConfig[], overrides: Partial<GameConfig> = {}): GameConfig {
  return {
    players,
    setupMode: i % 2 === 0 ? 'random' : 'draft',
    initialPlacement: Math.floor(i / 2) % 2 === 0 ? 'auto' : 'manual',
    setupBatch: 5,
    cardBonus: Math.floor(i / 4) % 2 === 0 ? 'progressive' : 'fixed',
    fortifyRule: Math.floor(i / 8) % 2 === 0 ? 'connected' : 'adjacent',
    dominationPercent: i % 10 === 7 ? 70 : 100,
    turnLimit: i % 10 === 9 ? 25 : null,
    seed: hashInts(0xc0ffee, i),
    ...(CLASSIC ? {} : { mapId: MAP_ID }),
    ...overrides,
  };
}

function seats(diffs: AiDifficulty[]): PlayerConfig[] {
  return diffs.map((d, k) => ({ name: `${d[0].toUpperCase()}${d.slice(1)} ${k + 1}`, color: COLORS[k], kind: 'ai', difficulty: d }));
}

function pct(n: number, d: number): string {
  return d ? `${((100 * n) / d).toFixed(1)}%` : '—';
}

function p90(xs: number[]): number {
  return [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.9)] ?? 0;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

function run(label: string, n: number, mk: (i: number) => GameConfig): GameResult[] {
  const out: GameResult[] = [];
  for (let i = 0; i < n; i++) {
    const cfg = mk(i);
    if (!seatOk(cfg.players.length)) {
      if (!skipped.has(label)) console.log(`  (${label}: skipped, ${MAP_ID} seats ${SEATS.min}–${SEATS.max})`);
      skipped.add(label);
      return out;
    }
    try {
      out.push(playGame(cfg, `${label} #${i} (seed ${cfg.seed})`));
    } catch (e) {
      failures.push(e instanceof Error ? e.message : String(e));
    }
  }
  return out;
}

const t0 = performance.now();
const N = Math.max(1, Number(positional[0] ?? 200) || 200);
console.log(`map: ${MAP_ID} (${MAP.size} territories, ${MAP.continentIds.length} continents, seats ${SEATS.min}–${SEATS.max})`);

// --- Main soak: every rule variant, 2/3/4 players, mixed difficulties -------------------------
const rng: RngHolder = { rng: 12345 };
const soak = run('soak', N, (i) => {
  const n = SEATS.min + (i % (SEATS.max - SEATS.min + 1));
  const diffs = Array.from({ length: n }, () => DIFFS[Math.floor(random(rng) * 3)]);
  return makeConfig(Math.floor(i / 3) + i, seats(diffs));
});

const seatsBy: Record<string, number> = { easy: 0, normal: 0, hard: 0 };
const winsBy: Record<string, number> = { easy: 0, normal: 0, hard: 0 };
const fairBy: Record<string, number> = { easy: 0, normal: 0, hard: 0 };
const reasons: Record<string, number> = {};
for (const g of soak) {
  for (const p of g.players) {
    seatsBy[p.difficulty!]++;
    fairBy[p.difficulty!] += 1 / g.players.length;
  }
  winsBy[g.players[g.winner].difficulty!]++;
  reasons[g.reason] = (reasons[g.reason] ?? 0) + 1;
}

console.log(`\n=== Soak: ${soak.length}/${N} games finished ===`);
console.log(`end reasons: ${Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(
  `rounds: avg ${(soak.reduce((a, g) => a + g.rounds, 0) / Math.max(1, soak.length)).toFixed(1)}, median ${median(soak.map((g) => g.rounds))}, max ${Math.max(0, ...soak.map((g) => g.rounds))}`,
);
for (const d of DIFFS) {
  console.log(
    `  ${d.padEnd(6)} seats ${String(seatsBy[d]).padStart(3)}  wins ${String(winsBy[d]).padStart(3)}  win/seat ${pct(winsBy[d], seatsBy[d]).padStart(6)}  vs fair share ${(winsBy[d] / Math.max(1e-9, fairBy[d])).toFixed(2)}×`,
  );
}

// --- Head-to-head matchups ------------------------------------------------------------------------
const M = Math.max(10, Math.round(N / 5));
function h2h(a: AiDifficulty, b: AiDifficulty): void {
  const res = run(`${a}-v-${b}`, M, (i) => makeConfig(i, seats(i % 2 === 0 ? [a, b] : [b, a])));
  const aw = res.filter((g) => g.players[g.winner].difficulty === a).length;
  console.log(
    `  2p ${a} vs ${b}: ${a} wins ${aw}/${res.length} (${pct(aw, res.length)}), avg rounds ${(res.reduce((s, g) => s + g.rounds, 0) / Math.max(1, res.length)).toFixed(1)}`,
  );
}
console.log(`\n=== Head-to-head (${M} games each, alternating seats, all rule variants) ===`);
h2h('hard', 'easy');
h2h('hard', 'normal');
h2h('normal', 'easy');

turnBucket = 'classic 4p';
const four = run('4p-normal', M, (i) => makeConfig(i, seats(['normal', 'normal', 'normal', 'normal']), { turnLimit: null, dominationPercent: 100 }));
turnBucket = 'soak';
const r4 = four.map((g) => g.rounds);
if (four.length) console.log(
  `  4p normal×4 (domination): avg rounds ${(r4.reduce((a, b) => a + b, 0) / Math.max(1, r4.length)).toFixed(1)}, median ${median(r4)}, range ${Math.min(...r4)}–${Math.max(...r4)}, in 15–60: ${r4.filter((r) => r >= 15 && r <= 60).length}/${r4.length}`,
);
const mixed = run('4p-hard+3normal', M, (i) => {
  const d: AiDifficulty[] = ['normal', 'normal', 'normal', 'normal'];
  d[i % 4] = 'hard';
  return makeConfig(i, seats(d), { turnLimit: null, dominationPercent: 100 });
});
const hw = mixed.filter((g) => g.players[g.winner].difficulty === 'hard').length;
if (mixed.length) console.log(`  4p 1 hard + 3 normal: hard wins ${hw}/${mixed.length} (${pct(hw, mixed.length)}; fair share 25%)`);

// --- Game length by win condition (SPEC §11.1; normal AIs, full-conquest games) ----------------
// The New game length estimates (src/game/presets.ts ROUNDS) are these numbers × measured seconds per
// round. Humans are slower and less eager than the sim's AIs; presets.ts scales for that.
const L = Math.max(40, Math.round(N / 2));
console.log(`\n=== Rounds until someone first holds X% (normal AIs, ${L} games each; mean / median / p90) ===`);
for (const n of [2, 3, 4]) {
  const res = run(`len-${n}p`, L, (i) =>
    makeConfig(i, seats(Array.from({ length: n }, () => 'normal' as AiDifficulty)), {
      turnLimit: null,
      dominationPercent: 100,
      setupMode: 'random',
    }),
  );
  if (!res.length) continue;
  const cells = THRESHOLDS.map((pct) => {
    const xs = res.map((g) => g.reach[pct]).filter((x): x is number => x !== undefined).sort((a, b) => a - b);
    const mean = xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    return `${pct}%: ${mean.toFixed(1)} / ${median(xs)} / ${xs[Math.floor(xs.length * 0.9)] ?? '—'}`;
  });
  console.log(`  ${n}p  ${cells.join('   ')}`);
}

console.log(
  `\n=== AI action shape (SPEC §11.4): ${shape.reinforceActions} reinforce actions, ${(shape.reinforceArmies / Math.max(1, shape.reinforceActions)).toFixed(1)} armies each; attacks: ${shape.blitz} blitz vs ${shape.attack} single rolls ===`,
);
if (shape.attack > shape.blitz * 0.05) failures.push(`AI rolled single attacks ${shape.attack} times vs ${shape.blitz} blitzes (SPEC §11.4 wants blitz)`);

// --- Personalities ------------------------------------------------------------------------------
// Normal difficulty throughout, full-conquest games. "default" = the classic AI (no personality).
type Kind = AiPersonality | 'default';
const KINDS: Kind[] = ['turtle', 'opportunist', 'warlord', 'default'];
function pSeats(kinds: Kind[]): PlayerConfig[] {
  return kinds.map((k, i) => ({
    name: `${k[0].toUpperCase()}${k.slice(1)} ${i + 1}`,
    color: COLORS[i],
    kind: 'ai',
    difficulty: 'normal',
    ...(k === 'default' ? {} : { personality: k }),
  }));
}
const kindOf = (p: PlayerConfig): Kind => p.personality ?? 'default';
const P = N;
const full = { turnLimit: null, dominationPercent: 100 } as const;
const allDip: Partial<Record<GameEventType, number>> = {};
let dipGames = 0;
const addDip = (gs: GameResult[]) => {
  for (const g of gs) {
    dipGames++;
    for (const [k, v] of Object.entries(g.dip)) allDip[k as GameEventType] = (allDip[k as GameEventType] ?? 0) + (v ?? 0);
  }
};

console.log(`\n=== Personalities: 4p pairs, two seats each (X Y X Y, flipped every other game), ${P} games per pair; X's win share (fair 50%) ===`);
turnBucket = 'persona 4p';
for (let a = 0; a < KINDS.length; a++) {
  for (let b = a + 1; b < KINDS.length; b++) {
    const X = KINDS[a];
    const Y = KINDS[b];
    const res = run(`${X}-v-${Y}`, P, (i) => makeConfig(i, pSeats(i % 2 === 0 ? [X, Y, X, Y] : [Y, X, Y, X]), full));
    if (!res.length) continue;
    if (X !== 'default' || Y !== 'default') addDip(res);
    const xw = res.filter((g) => kindOf(g.players[g.winner]) === X).length;
    const rounds = res.reduce((s2, g) => s2 + g.rounds, 0) / Math.max(1, res.length);
    console.log(`  ${X.padEnd(11)} vs ${Y.padEnd(11)} ${X} wins ${String(xw).padStart(3)}/${res.length} (${pct(xw, res.length).padStart(6)}), avg rounds ${rounds.toFixed(1)}`);
  }
}

console.log(`\n=== Personalities: 4p free-for-all (turtle, opportunist, warlord, default; seats rotated), ${P} games; fair share 25% ===`);
const ffa = run('ffa', P, (i) => {
  const order = KINDS.map((_, k) => KINDS[(k + i) % 4]);
  return makeConfig(i, pSeats(order), full);
});
addDip(ffa);
for (const k of ffa.length ? KINDS : []) {
  const w = ffa.filter((g) => kindOf(g.players[g.winner]) === k).length;
  console.log(`  ${k.padEnd(11)} wins ${String(w).padStart(3)}/${ffa.length} (${pct(w, ffa.length)})`);
}
if (ffa.length) console.log(
  `  avg rounds ${(ffa.reduce((a, g) => a + g.rounds, 0) / Math.max(1, ffa.length)).toFixed(1)} (4p normal×4 classic above: ${(r4.reduce((a, b) => a + b, 0) / Math.max(1, r4.length)).toFixed(1)})`,
);

console.log(`\n=== How each plays (free-for-all above, per seat; rounds 1–${OPENING_ROUNDS} except eliminations and breaks, which are whole-game) ===`);
for (const k of ffa.length ? KINDS : []) {
  const agg = emptySeat();
  let seatsN = 0;
  for (const g of ffa) {
    g.players.forEach((p, i) => {
      if (kindOf(p) !== k) return;
      seatsN++;
      for (const key of Object.keys(agg) as (keyof typeof agg)[]) agg[key] += g.seatStats[i][key];
    });
  }
  const per = (x: number) => (x / Math.max(1, agg.turns)).toFixed(2);
  console.log(
    `  ${k.padEnd(11)} fights/turn ${per(agg.fights)}  armies spent/turn ${per(agg.spent)}  even fights ${pct(agg.even, agg.fights).padStart(6)}  lopsided ${pct(agg.lopsided, agg.fights).padStart(6)}  turns holding a continent ${pct(agg.contTurns, agg.turns).padStart(6)}  eliminations/game ${(agg.elim / Math.max(1, seatsN)).toFixed(2)}  truces broken/game ${(agg.breaks / Math.max(1, seatsN)).toFixed(2)}`,
  );
}

const perGame = (k: GameEventType) => ((allDip[k] ?? 0) / Math.max(1, dipGames)).toFixed(2);
console.log(`\n=== Diplomacy, per game with personalities (${dipGames} games; v5.1: AI-AI understandings only) ===`);
console.log(
  `  proposed ${perGame('truceProposed')}  accepted ${perGame('truceAccepted')}  declined ${perGame('truceDeclined')}  broken ${perGame('truceBroken')}  expired ${perGame('truceExpired')}  standing changes ${perGame('standingChanged')}`,
);
if ((allDip.truceProposed ?? 0) === 0) band('no truce was ever proposed in personality games');

// --- Standing (v5.1): rounds per table, understandings, bands ------------------------------------------
// Full-conquest games, normal AIs, every seat a personality (the v5.1 New game randomises them): how long the
// tables run now that standing steers targets, how often AI-AI understandings form, break and turn, and how the
// bands spread (sampled at every turn start, every AI toward every seat).
console.log(`\n=== Standing (v5.1): ${P} games per table, full conquest; rounds median / p90, per game: understandings formed / broken by attack / turned / expired, standing changes ===`);
turnBucket = 'standing';
sampleBands = true;
const PERS3: Kind[] = ['turtle', 'opportunist', 'warlord'];
const sTables: { label: string; seats: (i: number) => PlayerConfig[]; over: Partial<GameConfig> }[] = [
  { label: '4p', seats: (i) => pSeats([0, 1, 2, 3].map((k) => PERS3[hashInts(i, k, 77) % 3])), over: full },
  { label: '3p', seats: (i) => pSeats(PERS3.map((_, k, a) => a[(k + i) % 3])), over: full },
  { label: '2p+neutral', seats: (i) => pSeats(PERS3.slice(0, 2).map((_, k) => PERS3[hashInts(i, k, 78) % 3])), over: { ...full, neutral: true } },
];
let formedAll = 0;
for (const t of sTables) {
  const turned0 = standingTurned;
  const res = run(`standing-${t.label}`, P, (i) => makeConfig(i, t.seats(i), t.over));
  if (!res.length) continue;
  const r = res.map((g) => g.rounds);
  const sum = (k: GameEventType) => res.reduce((a, g) => a + (g.dip[k] ?? 0), 0);
  const per = (n: number) => (n / Math.max(1, res.length)).toFixed(2);
  const formed = sum('truceAccepted');
  formedAll += formed;
  const withOne = res.filter((g) => (g.dip.truceAccepted ?? 0) > 0).length;
  console.log(
    `  ${t.label.padEnd(10)} rounds ${median(r)} / ${p90(r)}   understandings ${per(formed)} (in ${pct(withOne, res.length)} of games)  broken ${per(sum('truceBroken'))}  turned ${per(standingTurned - turned0)}  expired ${per(sum('truceExpired') - (standingTurned - turned0))}   standing changes ${per(sum('standingChanged'))}`,
  );
}
sampleBands = false;
const bandTotal = Object.values(bandCount).reduce((a, b) => a + b, 0);
console.log(`  bands at turn start (every AI toward every seat): ${(['ally', 'even', 'wary', 'hostile'] as Standing[]).map((b) => `${b} ${pct(bandCount[b], bandTotal)}`).join('  ')}`);
if (formedAll === 0) band('no AI-AI understanding ever formed in the standing tables');

// --- 2 players: first-mover win rate, with and without the neutral seat ---------------------------
turnBucket = '2p classic';
const F = N;
console.log(`\n=== 2p first mover (normal vs normal, ${F} games each, all rule variants) ===`);
function firstMover(label: string, neutral: boolean): GameResult[] {
  const res = run(label, F, (i) => makeConfig(i, seats(['normal', 'normal']), neutral ? { neutral: true } : {}));
  const fw = res.filter((g) => g.winner === g.firstPlayer).length;
  const rounds = res.reduce((a, g) => a + g.rounds, 0) / Math.max(1, res.length);
  console.log(`  ${neutral ? 'neutral seat' : 'no neutral  '}: first mover wins ${fw}/${res.length} (${pct(fw, res.length)}), avg rounds ${rounds.toFixed(1)}, median ${median(res.map((g) => g.rounds))}`);
  return res;
}
firstMover('2p-first', false);
turnBucket = '2p neutral';
firstMover('2p-first-neutral', true);
const len2n = run('len-2p-neutral', L, (i) =>
  makeConfig(i, seats(['normal', 'normal']), { turnLimit: null, dominationPercent: 100, setupMode: 'random', neutral: true }),
);
const cells2n = THRESHOLDS.map((pc) => {
  const xs = len2n.map((g) => g.reach[pc]).filter((x): x is number => x !== undefined).sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  return `${pc}%: ${mean.toFixed(1)} / ${median(xs)} / ${xs[Math.floor(xs.length * 0.9)] ?? '—'}`;
});
console.log(`  2p+neutral rounds until X% (mean / median / p90, ${L} games): ${cells2n.join('   ')}`);

// --- Missions (v5 G): Evening-length tables, with and without the house rule -----------------------
// Normal AIs with the default table's personalities (4p: turtle, opportunist, warlord + one classic,
// rotated; 3p: the three personalities, rotated; 2p+neutral). Evening = 70%. (A 2-player table without the
// neutral seat plays without missions: sanitizeConfig drops the rule.)
const MS = Math.max(40, N);
console.log(`\n=== Missions: Evening length, ${MS} games per table; share ending by mission, rounds (median / p90) with vs without ===`);
turnBucket = 'missions';
const evening = (neutral = false) => ({ turnLimit: null, dominationPercent: 70, ...(neutral ? { neutral: true } : {}) });
const tables: { label: string; seats: (i: number) => PlayerConfig[]; over: Partial<GameConfig> }[] = [
  { label: '4p', seats: (i) => pSeats(KINDS.map((_, k) => KINDS[(k + i) % 4])), over: evening() },
  { label: '3p', seats: (i) => pSeats((['turtle', 'opportunist', 'warlord'] as Kind[]).map((_, k, a) => a[(k + i) % 3])), over: evening() },
  { label: '2p+neutral', seats: (i) => pSeats((['turtle', 'warlord'] as Kind[]).map((_, k, a) => a[(k + i) % 2])), over: evening(true) },
];
let mAll = 0;
let mByMission = 0;
for (const t of tables) {
  const on = run(`missions-${t.label}`, MS, (i) => makeConfig(i, t.seats(i), { ...t.over, missions: true }));
  const off = run(`nomissions-${t.label}`, MS, (i) => makeConfig(i, t.seats(i), t.over));
  if (!on.length) continue;
  const byM = on.filter((g) => g.by === 'mission');
  mAll += on.length;
  mByMission += byM.length;
  const kinds: Record<string, number> = {};
  for (const g of byM) kinds[g.missionKind ?? '?'] = (kinds[g.missionKind ?? '?'] ?? 0) + 1;
  const ron = on.map((g) => g.rounds);
  const roff = off.map((g) => g.rounds);
  console.log(
    `  ${t.label.padEnd(10)} by mission ${String(byM.length).padStart(3)}/${on.length} (${pct(byM.length, on.length).padStart(6)}; ${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(', ') || '—'})  rounds ${median(ron)} / ${p90(ron)}  (without: ${median(roff)} / ${p90(roff)})`,
  );
  if (t.label === '4p' && byM[0]) console.log(`    e.g. "${byM[0].headline}"`);
}
if (mByMission * 3 < mAll) band(`missions ended only ${pct(mByMission, mAll)} of Evening games (target ≥ 33%)`);
console.log(`  all tables together: ${pct(mByMission, mAll)} end by mission (target ≥ 33%)`);

// --- Timing ---------------------------------------------------------------------------------------
const sorted = [...decisionTimes].sort((a, b) => a - b);
const q = (f: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))] ?? 0;
console.log(
  `\n=== AI decision time over ${sorted.length} decisions: mean ${(sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length)).toFixed(3)} ms, p99 ${q(0.99).toFixed(3)} ms, max ${q(1).toFixed(2)} ms ===`,
);
for (const [k, fs] of Object.entries(fightsPerTurn)) {
  const tot = fs.reduce((a, b) => a + b, 0);
  console.log(`  fights per main turn, ${k.padEnd(11)} AIs: mean ${(tot / Math.max(1, fs.length)).toFixed(2)} (each fight is one dice beat on screen)`);
}
for (const [k, xs] of Object.entries(turnTimes)) {
  const ts = [...xs].sort((a, b) => a - b);
  const tq = (f: number) => ts[Math.min(ts.length - 1, Math.floor(ts.length * f))] ?? 0;
  console.log(`  per turn, ${k.padEnd(11)} AIs: p50 ${tq(0.5).toFixed(3)} ms, p95 ${tq(0.95).toFixed(3)} ms over ${ts.length} turns`);
}
console.log(`total ${((performance.now() - t0) / 1000).toFixed(1)} s`);

for (const n of notes) console.log(`NOTE (${MAP_ID}; classic band): ${n}`);
if (q(0.99) > 5) failures.push(`AI p99 decision time ${q(0.99).toFixed(2)} ms exceeds 5 ms`);
if (failures.length) {
  console.error(`\nFAILED (${failures.length}):`);
  for (const f of failures.slice(0, 20)) console.error('  ' + f);
  process.exit(1);
}
console.log('\nPASS');
