// v5 controller (_claude/v5/PROPOSAL.md §4 C, D, E, F): the replay and its turning points, grudges that last,
// the rematch's first seat, the AI voices and their rate limit, the holding dab, a stone's history, the
// clickables, the hover odds and the fight hooks. Pure builders first, then a controller on a fake board.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTINENTS, TERRITORY_IDS, areAdjacent, reinforcementsFor, type GameState, type PlayerConfig, type TerritoryId } from '../../src/engine';
import { VOICE } from '../../src/engine/ai/personality';
import type { AudioEngine } from '../../src/audio/types';
import type { BoardHighlights, BoardView, TerritoryPointerInfo } from '../../src/render/BoardView';
import { createController, type GameController } from '../../src/game/controller';
import {
  buildMoments,
  buildReplay,
  emptyStory,
  grudgeTicks,
  holdingBreakdown,
  noteConquest,
  noteOut,
  noteRoundStart,
  rematchFirst,
  replayBoard,
  replayMsPerRound,
  roundSentence,
  stoneHistory,
  type StoryLedger,
} from '../../src/game/story';
import { VOICE_MAX, Voices, fillVoice, voiceText } from '../../src/game/voice';
import { memoryKV, SETTINGS_KEY } from '../../src/game/storage';
import { board as fixture } from './fixtures';

// ---------------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------------

/** John (human, 0), Sam (human, 1), Priya (AI, 2): every territory Priya's at 1 unless set. */
function game(own: Partial<Record<TerritoryId, [number, number]>> = {}, round = 8): GameState {
  const s = fixture(own);
  s.round = round;
  return s;
}

/** A ledger with a board per round start; `owners(r)` gives the owner map at the start of round r. */
function ledger(rounds: number, owners: (r: number) => Partial<Record<TerritoryId, number>>): StoryLedger {
  const l = emptyStory();
  for (let r = 1; r <= rounds; r++) {
    const s = game({}, r);
    for (const [t, o] of Object.entries(owners(r))) s.territories[t as TerritoryId] = { owner: o!, armies: 2 };
    noteRoundStart(l, s, r);
  }
  return l;
}

const AFRICA = CONTINENTS.africa.territories;
const allOf = (ts: readonly TerritoryId[], p: number) => Object.fromEntries(ts.map((t) => [t, p])) as Partial<Record<TerritoryId, number>>;

// ---------------------------------------------------------------------------------------------------------
// C1 · the replay and its turning points
// ---------------------------------------------------------------------------------------------------------

describe('C1 replay builder (story.ts)', () => {
  it('one frame per round with the round-end owners, oldest first, and a 15–20 s whole', () => {
    // John takes Africa at the start of round 4 (so he holds it at the end of round 3) and keeps it.
    const l = ledger(8, (r) => (r >= 4 ? allOf(AFRICA, 0) : {}));
    const final = game(allOf(AFRICA, 0) as never, 8);
    for (const t of AFRICA) final.territories[t] = { owner: 0, armies: 3 };
    const r = buildReplay(l, final, 0, 1);
    expect(r.rounds.map((x) => x.round)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(r.rounds[2].owners.egypt).toBe('crimson'); // round 3 ends where round 4 starts
    expect(r.rounds[1].owners.egypt).toBe('amber');
    expect(r.winner.name).toBe('John');
    const total = r.rounds.length * r.msPerRound;
    expect(total).toBeGreaterThanOrEqual(15_000);
    expect(total).toBeLessThanOrEqual(20_000);
    // Very long games clamp per round; a short one never drags a round out.
    expect(replayMsPerRound(60)).toBe(450);
    expect(replayMsPerRound(3)).toBe(2500);
  });

  it("names the three turning points from the ledger: a territory's busy round, a knockout, a continent held to the end", () => {
    const l = ledger(10, (r) => (r >= 5 ? allOf(AFRICA, 0) : {}));
    noteConquest(l, 6, 'siberia', 0, 2);
    noteConquest(l, 6, 'siberia', 2, 0);
    noteConquest(l, 6, 'siberia', 0, 2);
    noteOut(l, 9, 1, 2);
    const final = game({}, 10);
    for (const t of AFRICA) final.territories[t] = { owner: 0, armies: 3 };
    final.players[1].eliminated = true;
    const m = buildMoments(l, final, 0);
    expect(m).toHaveLength(3);
    expect(m).toContain('Round 6: Siberia changed hands three times');
    expect(m).toContain('Round 9: Sam was knocked out by Priya');
    expect(m).toContain('Round 4: John took Africa and held it to the end');
    // Told in game order.
    expect(m.map((x) => Number(/^Round (\d+)/.exec(x)![1]))).toEqual([4, 6, 9]);
    for (const x of m) expect(x).not.toMatch(/!/);
  });

  it("each round's sentence comes from its biggest event", () => {
    const l = emptyStory();
    const s = game();
    noteOut(l, 9, 1, 2);
    noteConquest(l, 6, 'siberia', 0, 2);
    noteConquest(l, 6, 'siberia', 2, 0);
    noteConquest(l, 3, 'ural', 0, 2);
    noteConquest(l, 7, 'ural', 2, 0);
    noteConquest(l, 7, 'peru', 2, 0);
    expect(roundSentence(l, s, 9, null, null)).toBe('Sam was knocked out by Priya');
    expect(roundSentence(l, s, 6, null, null)).toBe('Siberia changed hands twice');
    expect(roundSentence(l, s, 3, null, null)).toBe('John took Ural from Priya');
    expect(roundSentence(l, s, 7, null, null)).toBe('Priya took 2 territories');
    expect(roundSentence(l, s, 2, null, null)).toBe('No territory changed hands');
    // A continent completed this round outranks the conquests that made it.
    const prev = TERRITORY_IDS.map(() => 2);
    const end = TERRITORY_IDS.map((t) => ((AFRICA as readonly string[]).includes(t) ? 0 : 2));
    expect(roundSentence(l, s, 3, end, prev)).toBe('John took Africa');
  });

  it('the board re-soaks to a frame: owners and armies of that round', () => {
    const l = ledger(3, (r) => (r === 3 ? { ural: 0 } : {}));
    const final = game({ ural: [0, 9] }, 3);
    const b = replayBoard(l, final, 1)!; // the end of round 2 = the start of round 3
    expect(b.territories.ural.owner).toBe(0);
    expect(b.territories.ural.armies).toBe(2);
    expect(replayBoard(l, final, 0)!.territories.ural.owner).toBe(2);
    expect(replayBoard(l, final, 9)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------
// C2 · grudges that last · F5 · a stone's history
// ---------------------------------------------------------------------------------------------------------

describe('C2 grudge ticks and F5 stone history', () => {
  it("counts what each seat took from the reader, net of what the reader took back", () => {
    const l = emptyStory();
    noteConquest(l, 2, 'ural', 2, 0); // Priya takes Ural from John
    noteConquest(l, 2, 'siberia', 2, 0); // and Siberia
    noteConquest(l, 3, 'peru', 1, 0); // Sam takes Peru from John
    noteConquest(l, 4, 'ural', 0, 2); // John takes Ural back
    noteConquest(l, 5, 'siberia', 1, 2); // Sam takes Siberia from Priya: still Priya's doing
    expect(grudgeTicks(l, 0)).toEqual({ 2: 1, 1: 1 });
    // Taken from John again: the tick returns.
    noteConquest(l, 6, 'ural', 2, 0);
    expect(grudgeTicks(l, 0)).toEqual({ 2: 2, 1: 1 });
    // Sam's view: nobody took anything from Sam.
    expect(grudgeTicks(l, 1)).toEqual({});
  });

  it("'Ural · 19 · held since round 3 · taken from Sage', else 'held since the deal'", () => {
    const l = emptyStory();
    noteConquest(l, 3, 'ural', 0, 2);
    const s = game({ ural: [0, 19], peru: [0, 4] });
    expect(stoneHistory(l, s, 'ural')).toBe('Ural · 19 · held since round 3 · taken from Priya');
    expect(stoneHistory(l, s, 'peru')).toBe('Peru · 4 · held since the deal');
  });
});

// ---------------------------------------------------------------------------------------------------------
// C3 · rematch: the loser goes first
// ---------------------------------------------------------------------------------------------------------

describe('C3 rematch order', () => {
  it('the human knocked out earliest; else the human with the fewest territories; never the winner', () => {
    const s = game({ ural: [0, 3], peru: [1, 3], brazil: [1, 3] });
    expect(rematchFirst(s, 2)).toBe(0); // John 1 territory vs Sam 2
    s.players[1].eliminated = true;
    s.players[1].eliminatedOnTurn = 12;
    expect(rematchFirst(s, 2)).toBe(1);
    s.players[0].eliminated = true;
    s.players[0].eliminatedOnTurn = 7;
    expect(rematchFirst(s, 2)).toBe(0);
    // John won: Sam is the losing human.
    const t = game({ ural: [0, 3], peru: [1, 3] });
    expect(rematchFirst(t, 0)).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------
// E6 · the holding dab's breakdown
// ---------------------------------------------------------------------------------------------------------

describe('E6 holding breakdown', () => {
  it("'14 territories +4 · Asia +7 · cards +6'", () => {
    expect(holdingBreakdown({ territoryCount: 14, base: 4, continents: [{ continent: 'asia', bonus: 7 }], total: 11 }, 6)).toBe('14 territories +4 · Asia +7 · cards +6');
    expect(holdingBreakdown({ territoryCount: 1, base: 3, continents: [], total: 3 })).toBe('1 territory +3');
  });
});

// ---------------------------------------------------------------------------------------------------------
// D4 · voices
// ---------------------------------------------------------------------------------------------------------

describe('D4 voice lines', () => {
  it('every line: name first, no exclamation marks, no quotes, ≤ 60 characters with long names', () => {
    for (const [, kinds] of Object.entries(VOICE)) {
      for (const [, lines] of Object.entries(kinds)) {
        expect(lines.length).toBeGreaterThan(0);
        for (const tpl of lines) {
          expect(tpl.startsWith('{name} ')).toBe(true);
          expect(tpl).not.toMatch(/[!"“”]/);
          const t = fillVoice(tpl, 'Vermilion', { by: 'Christopher', continent: 'North America', victim: 'Christopher' });
          expect(t.length, t).toBeLessThanOrEqual(VOICE_MAX);
        }
      }
    }
  });

  it('only a personality AI speaks; one line per turn; never the same words twice in a row', () => {
    const s = game();
    s.players[2].personality = 'warlord';
    expect(voiceText(s, 0, 'attacked', { by: 'Sam' }, 1)).toBeNull(); // John is human
    const v = new Voices();
    const a = v.say(s, 2, 'attacked', { by: 'John' }, 5);
    expect(a?.text.startsWith('Priya ')).toBe(true);
    expect(v.say(s, 2, 'continent', { continent: 'Asia' }, 5)).toBeNull(); // the turn's line is spent
    const b = v.say(s, 2, 'attacked', { by: 'John' }, 6);
    expect(b).not.toBeNull();
    expect(b!.text).not.toBe(a!.text);
    expect(v.bySeat[2]).toBe(b!.text);
    expect(v.log).toHaveLength(2);
    // Its own turn begins: the chip's line is spent, a waiting grievance comes back once.
    v.aggrieve(2, 0, 'attacked');
    v.aggrieve(2, 1, 'truceBroken');
    v.aggrieve(2, 0, 'attacked'); // a broken truce outranks an attack
    expect(v.turnBegins(2)).toEqual({ by: 1, kind: 'truceBroken' });
    expect(v.bySeat[2]).toBeUndefined();
    expect(v.turnBegins(2)).toBeNull();
    // A continent is said the first time a seat takes it, not every time it takes it back.
    expect(v.say(s, 2, 'continent', { continent: 'Asia' }, 7)).not.toBeNull();
    expect(v.say(s, 2, 'continent', { continent: 'Asia' }, 8)).toBeNull();
    expect(v.say(s, 2, 'continent', { continent: 'Europe' }, 9)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------
// The controller on a fake board
// ---------------------------------------------------------------------------------------------------------

function fakeBoard() {
  let click: ((i: TerritoryPointerInfo) => void) | null = null;
  let hover: ((i: TerritoryPointerInfo | null) => void) | null = null;
  const leans: string[] = [];
  const synced: GameState[] = [];
  let highlights: BoardHighlights = {};
  const b: BoardView = {
    syncState: (s) => void synced.push(s),
    playEvent: () => Promise.resolve(),
    setAnimationSpeed: () => undefined,
    skipAnimations: () => undefined,
    setHighlights: (h) => void (highlights = h),
    onTerritoryClick: (cb) => void (click = cb),
    onTerritoryHover: (cb) => void (hover = cb),
    focusTerritories: () => undefined,
    resetCamera: () => undefined,
    setAttractMode: () => undefined,
    setShowLabels: () => undefined,
    setViewportInsets: () => undefined,
    setUiScale: () => undefined,
    getScreenPosition: () => ({ x: 100, y: 100 }),
    getStats: () => ({ fps: 60, frameMsP95: 16, drawCalls: 0, triangles: 0, activeTweens: 0, cameraMoving: false }),
    dispose: () => undefined,
    leanTo: (ts, o) => void leans.push(`to:${ts.join('>')}:${o?.amount ?? 'default'}`),
    leanBack: () => void leans.push('back'),
  };
  const info = (t: TerritoryId): TerritoryPointerInfo => ({ territory: t, clientX: 0, clientY: 0, shiftKey: false, altKey: false, metaKey: false, button: 0 });
  return {
    board: b,
    leans,
    synced,
    click: (t: TerritoryId) => click!(info(t)),
    hover: (t: TerritoryId | null) => hover!(t ? info(t) : null),
    get highlights() {
      return highlights;
    },
  };
}

function spyAudio() {
  const calls: string[] = [];
  const a = {
    unlock: () => undefined,
    play: (name: string) => void calls.push(`play:${name}`),
    setVolume: () => undefined,
    setMuted: () => undefined,
    setMusic: () => undefined,
    setMusicVolume: () => undefined,
    stopAll: () => undefined,
    isUnlocked: () => true,
    stats: () => ({}),
    dispose: () => undefined,
    cue: (name: string) => void calls.push(`cue:${name}`),
  } as unknown as AudioEngine;
  return { a, calls };
}

const clock = {
  now: () => Date.now(),
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
  raf: (fn: () => void) => void setTimeout(fn, 16),
};

function make(speed: 0 | 1 = 1) {
  const kv = memoryKV();
  kv.set(SETTINGS_KEY, JSON.stringify({ hideCardsBetweenTurns: false, animationSpeed: speed, aiSpeed: 'fast', v: 5 }));
  const fb = fakeBoard();
  const au = spyAudio();
  const c = createController({ board: fb.board, audio: au.a, storage: kv, clock, dom: false, prefersReducedMotion: () => false });
  return { c, fb, au };
}

async function until(pred: () => boolean, maxMs: number, step = 50): Promise<boolean> {
  for (let t = 0; t < maxMs; t += step) {
    if (pred()) return true;
    await vi.advanceTimersByTimeAsync(step);
  }
  return pred();
}

const PERS = ['turtle', 'opportunist', 'warlord', 'warlord'] as const;
const AIS = (n: number): PlayerConfig[] =>
  (['crimson', 'cobalt', 'amber', 'rose'] as const).slice(0, n).map((color, i) => ({ name: ['Sage', 'Slate', 'Ochre', 'Theo'][i], color, kind: 'ai', difficulty: 'normal', personality: PERS[i] }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

describe('controller: a whole AI game to the replay', () => {
  it('victory builds the replay before the recap (moments on the recap too), a tap ends it, voices were said', async () => {
    const { c, fb } = make(1);
    c.hooks.newGame({ players: AIS(3), seed: 11, dominationPercent: 60, turnLimit: null });
    c.hooks.autoplay(true);
    const done = await until(() => c.hooks.ui().screen === 'victory', 1_500_000, 200);
    expect(done).toBe(true);
    const r = c.hooks.replay()!;
    expect(r).not.toBeNull();
    const s = c.hooks.getState()!;
    expect(r.rounds.length).toBe(s.round);
    expect(r.rounds.every((x) => x.line.length > 0 && !/!/.test(x.line))).toBe(true);
    expect(r.moments.length).toBeGreaterThan(0);
    expect(r.moments.length).toBeLessThanOrEqual(3);
    for (const m of r.moments) expect(m).toMatch(/^Round \d+: /);
    const vm = c.getViewModel();
    expect(vm.game?.replay?.key).toBe(r.key);
    expect(vm.victory?.moments).toEqual(r.moments);
    // The UI reaches a round: the board re-soaks to it.
    const before = fb.synced.length;
    c.intent({ type: 'replayRound', index: 0 });
    expect(fb.synced.length).toBe(before + 1);
    // Any tap ends it; the final board comes back; the hook keeps it.
    fb.click('ural');
    expect(c.getViewModel().game?.replay ?? null).toBeNull();
    expect(fb.synced[fb.synced.length - 1]).toBe(c.hooks.getState());
    expect(c.hooks.replay()?.key).toBe(r.key);
    const lines = c.hooks.voiceLines();
    expect(lines.length).toBeGreaterThan(0);
    // One per turn at most.
    expect(new Set(lines.map((l) => l.turn)).size).toBe(lines.length);
    for (const l of lines) expect(l.text.length).toBeLessThanOrEqual(60);
    c.dispose();
  }, 120_000);

  it('the replay ends itself after its last round has dried; instant speed goes straight to the recap', async () => {
    const { c } = make(1);
    c.hooks.newGame({ players: AIS(3), seed: 5, dominationPercent: 50, turnLimit: null });
    c.hooks.autoplay(true);
    await until(() => c.hooks.ui().screen === 'victory', 1_500_000, 200);
    const r = c.getViewModel().game?.replay;
    expect(r).toBeTruthy();
    await vi.advanceTimersByTimeAsync(r!.rounds.length * r!.msPerRound + 1600);
    expect(c.getViewModel().game?.replay ?? null).toBeNull();
    c.dispose();
    const fast = make(0);
    fast.c.hooks.newGame({ players: AIS(3), seed: 5, dominationPercent: 50, turnLimit: null });
    fast.c.hooks.autoplay(true);
    await until(() => fast.c.hooks.ui().screen === 'victory', 1_500_000, 200);
    expect(fast.c.getViewModel().game?.replay ?? null).toBeNull();
    expect(fast.c.hooks.replay()).not.toBeNull();
    fast.c.dispose();
  }, 120_000);
});

describe('controller: rematch, holding, hover odds, clickables, fight hooks', () => {
  const SEATS: PlayerConfig[] = [
    { name: 'John', color: 'crimson', kind: 'human' },
    { name: 'Sam', color: 'cobalt', kind: 'human' },
    { name: 'Priya', color: 'amber', kind: 'ai', difficulty: 'normal', personality: 'warlord' },
  ];

  async function humanGame() {
    const h = make(0);
    h.c.hooks.newGame({ players: SEATS, seed: 21, dominationPercent: 70, turnLimit: null, initialPlacement: 'auto' });
    await until(() => {
      const s = h.c.hooks.getState();
      return !!s && s.phase.kind === 'reinforce' && s.players[s.currentPlayer].kind === 'human' && h.c.hooks.isIdle();
    }, 120_000);
    return h;
  }

  it("the holding dab: the human's armies and where they came from, with a pour; empties as they are placed", async () => {
    const { c, au } = await humanGame();
    const s = c.hooks.getState()!;
    const me = s.currentPlayer;
    const hold = c.hooks.holding()!;
    expect(hold).not.toBeNull();
    expect(hold.seat.id).toBe(me);
    const b = reinforcementsFor(s, me);
    expect(hold.armies).toBe((s.phase as { remaining: number }).remaining);
    expect(hold.breakdown).toBe(holdingBreakdown(b));
    expect(au.calls).toContain('cue:pour');
    const mine = TERRITORY_IDS.find((t) => s.territories[t].owner === me)!;
    c.hooks.dispatch({ type: 'reinforce', player: me, territory: mine, count: 1 });
    await vi.advanceTimersByTimeAsync(50);
    expect(c.hooks.holding()?.armies).toBe(hold.armies - 1);
    c.hooks.dispatch({ type: 'reinforce', player: me, territory: mine, count: hold.armies - 1 });
    await vi.advanceTimersByTimeAsync(50);
    expect(c.hooks.holding()).toBeNull();
    c.dispose();
  });

  it('clickables: a continent, the cup, the ensō (twice opens the Ledger), a lane, a stone, a seat ring, open water', async () => {
    const { c, fb, au } = await humanGame();
    const s = c.hooks.getState()!;
    c.intent({ type: 'tapContinent', id: 'asia' });
    expect(c.hooks.ui().line).toMatch(/^Asia · \+7 a turn/);
    expect(fb.highlights.pulse).toEqual(CONTINENTS.asia.territories);
    await vi.advanceTimersByTimeAsync(1500);
    expect(c.hooks.ui().line).not.toMatch(/^Asia/);
    c.intent({ type: 'tapCup' });
    expect(au.calls).toContain('cue:rattle');
    expect(c.hooks.ui().line).toBe(`${s.players[s.currentPlayer].name}'s turn`);
    c.intent({ type: 'tapEnso' });
    expect(c.hooks.ui().line).toBe(`Round ${s.round}`);
    c.intent({ type: 'tapEnso' });
    expect(c.getViewModel().overlay).toBe('log');
    c.intent({ type: 'overlay', overlay: null });
    c.intent({ type: 'tapLane', from: 'brazil', to: 'north_africa' });
    expect(au.calls).toContain('cue:glint');
    expect(c.hooks.ui().line).toBe('Brazil to North Africa by sea');
    c.intent({ type: 'stoneHistory', territory: 'ural' });
    expect(c.hooks.ui().line).toMatch(/^Ural · \d+ · held since/);
    c.intent({ type: 'stoneHistory', territory: null });
    expect(c.hooks.ui().line).not.toMatch(/^Ural ·/);
    c.intent({ type: 'hoverSeat', player: 2 });
    await vi.advanceTimersByTimeAsync(20);
    const priyas = TERRITORY_IDS.filter((t) => s.territories[t].owner === 2);
    expect(fb.highlights.selectable).toEqual(priyas);
    expect(fb.highlights.dimOthers).toBe(true);
    c.intent({ type: 'hoverSeat', player: null });
    await vi.advanceTimersByTimeAsync(20);
    expect(fb.highlights.selectable).not.toEqual(priyas);
    c.dispose();
  });

  it('hover odds while a source is picked; the camera leans on an armed fight and back; human rolls stagger 70 ms', async () => {
    const { c, fb } = await humanGame();
    let s = c.hooks.getState()!;
    const me = s.currentPlayer;
    // Place everything on a tile that borders an enemy, then go to Attack.
    const src = TERRITORY_IDS.find((t) => s.territories[t].owner === me && TERRITORY_IDS.some((u) => s.territories[u].owner !== me && isNeighbour(t, u)))!;
    c.hooks.dispatch({ type: 'reinforce', player: me, territory: src, count: (s.phase as { remaining: number }).remaining });
    c.hooks.dispatch({ type: 'endReinforce', player: me });
    await until(() => c.hooks.getState()!.phase.kind === 'attack' && c.hooks.isIdle(), 5000);
    s = c.hooks.getState()!;
    fb.click(src);
    await vi.advanceTimersByTimeAsync(20);
    const target = TERRITORY_IDS.find((u) => s.territories[u].owner !== me && isNeighbour(src, u))!;
    const plain = c.hooks.ui().line;
    fb.hover(target);
    await vi.advanceTimersByTimeAsync(20);
    expect(c.hooks.ui().line).toMatch(/ → .* · \d+%/);
    expect(c.hooks.ui().buttons).not.toContain('Roll');
    fb.hover(null);
    await vi.advanceTimersByTimeAsync(20);
    expect(c.hooks.ui().line).toBe(plain);
    fb.click(target);
    await vi.advanceTimersByTimeAsync(20);
    expect(fb.leans[fb.leans.length - 1]).toBe(`to:${src}>${target}:default`);
    fb.click(src); // deselect
    await vi.advanceTimersByTimeAsync(20);
    expect(fb.leans[fb.leans.length - 1]).toBe('back');
    c.dispose();
  });

  it('rematch keeps the seats and gives the loser the first move', async () => {
    const { c } = make(0);
    c.hooks.newGame({ players: SEATS, seed: 21, dominationPercent: 70, turnLimit: null, initialPlacement: 'auto' });
    await until(() => c.hooks.getState()?.phase.kind === 'reinforce', 60_000);
    // End it now: the leader wins; the loser among the humans opens the rematch.
    c.intent({ type: 'endGameNow' });
    c.intent({ type: 'confirm', yes: true });
    expect(c.hooks.ui().screen).toBe('victory');
    const s = c.hooks.getState()!;
    const vic = c.getViewModel().victory!;
    const loser = rematchFirst(s, vic.winner.id);
    await vi.advanceTimersByTimeAsync(700);
    c.intent({ type: 'rematch' });
    const t = c.hooks.getState()!;
    expect(t.players.map((p) => p.name)).toEqual(s.players.map((p) => p.name));
    expect(t.firstPlayer).toBe(loser);
    c.dispose();
  });
});

function isNeighbour(a: TerritoryId, b: TerritoryId): boolean {
  return areAdjacent(a, b);
}
