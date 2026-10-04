// v4 controller (_claude/v4/PLAN.md §3 A1–A5, §5b E5): the readable reel's tiers and pacing, the receipt,
// the loser's rings, the truce fixes and the copy fixes. A fake board plays the modelled 1× durations
// (src/game/timingModel.ts) under fake timers.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAction, chooseAiAction, chooseTruceProposal, type GameEvent, type GameState, type PlayerConfig, type TerritoryId } from '../../src/engine';
import { lastOfferRound, truceReason } from '../../src/engine/ai/diplomacy';
import type { AudioEngine } from '../../src/audio/types';
import type { BoardHighlights, BoardView, PlayEventOptions, TerritoryPointerInfo } from '../../src/render/BoardView';
import { createController, type GameController } from '../../src/game/controller';
import { attackBegins, attackTakes, attackThrownBack, goesFirst, movesIn } from '../../src/game/copy';
import { buildReceipt, emptyReceipts, noteTurnStart, recordReceipt, RECEIPT_LINE_MAX } from '../../src/game/recap';
import { memoryKV, SAVE_KEY, SETTINGS_KEY, type KV } from '../../src/game/storage';
import { EVENT_TIERS, TIER_BANDS, eventDurationMs, eventTier, scaledDuration } from '../../src/game/timingModel';
import { board as fixture } from './fixtures';

interface Played {
  ev: GameEvent;
  opts?: PlayEventOptions;
  start: number;
  end: number;
  speed: number;
}

function fakeBoard() {
  let speed = 1;
  const pending = new Set<() => void>();
  let click: ((i: TerritoryPointerInfo) => void) | null = null;
  const played: Played[] = [];
  let highlights: BoardHighlights = {};
  const b: BoardView = {
    syncState: () => undefined,
    playEvent(ev, _after, opts) {
      const rec: Played = { ev, opts, start: Date.now(), end: Date.now(), speed };
      played.push(rec);
      const ms = scaledDuration(eventDurationMs(ev, opts), speed);
      if (ms <= 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const done = () => {
          pending.delete(done);
          clearTimeout(h);
          rec.end = Date.now();
          resolve();
        };
        const h = setTimeout(done, ms);
        pending.add(done);
      });
    },
    setAnimationSpeed: (m) => void (speed = m),
    skipAnimations: () => {
      for (const d of [...pending]) d();
    },
    setHighlights: (h) => void (highlights = h),
    onTerritoryClick: (cb) => void (click = cb),
    onTerritoryHover: () => undefined,
    focusTerritories: () => undefined,
    resetCamera: () => undefined,
    setAttractMode: () => undefined,
    setShowLabels: () => undefined,
    setViewportInsets: () => undefined,
    setUiScale: () => undefined,
    getScreenPosition: () => ({ x: 100, y: 100 }),
    getStats: () => ({ fps: 60, frameMsP95: 16, drawCalls: 0, triangles: 0, activeTweens: pending.size, cameraMoving: false }),
    dispose: () => undefined,
  };
  return {
    board: b,
    played,
    click: (t: TerritoryId) => click!({ territory: t, clientX: 0, clientY: 0, shiftKey: false, altKey: false, metaKey: false, button: 0 }),
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
    turnPassed: (h: boolean) => void calls.push(`turnPassed:${h}`),
    lean: (c: string) => void calls.push(`lean:${c}`),
    setIdle: (on: boolean) => void calls.push(`idle:${on}`),
  } as unknown as AudioEngine;
  return { a, calls };
}

const clock = {
  now: () => Date.now(),
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
  raf: (fn: () => void) => void setTimeout(fn, 16),
};

function make(opts: { kv?: KV; cover?: boolean } = {}) {
  const kv = opts.kv ?? memoryKV();
  if (!kv.get(SETTINGS_KEY)) kv.set(SETTINGS_KEY, JSON.stringify({ hideCardsBetweenTurns: !!opts.cover, v: 5 }));
  const fb = fakeBoard();
  const au = spyAudio();
  const c = createController({ board: fb.board, audio: au.a, storage: kv, clock, dom: false, prefersReducedMotion: () => false });
  return { c, fb, kv, au };
}

async function until(pred: () => boolean, maxMs: number, step = 50): Promise<boolean> {
  for (let t = 0; t < maxMs; t += step) {
    if (pred()) return true;
    await vi.advanceTimersByTimeAsync(step);
  }
  return pred();
}

const AIS = (n: number): PlayerConfig[] =>
  (['crimson', 'cobalt', 'amber', 'rose'] as const).slice(0, n).map((color, i) => ({ name: `AI${i}`, color, kind: 'ai', difficulty: 'normal' }));

const humanTurn = (c: GameController) => {
  const s = c.hooks.getState();
  return !!s && s.phase.kind !== 'game-over' && s.players[s.currentPlayer].kind === 'human' && c.hooks.isIdle();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

// ---------------------------------------------------------------------------------------------------------
// E5 tiers and the readable beat
// ---------------------------------------------------------------------------------------------------------

describe('E5 tiers (timingModel)', () => {
  it('the tier table follows PLAN §5b E5', () => {
    expect(EVENT_TIERS).toMatchObject({
      armiesPlaced: 0,
      territoryClaimed: 0,
      cardsCaptured: 0,
      cardDrawn: 0,
      turnStarted: 0,
      diceRolled: 1,
      armiesMoved: 1,
      territoryConquered: 2,
      continentGained: 2,
      continentLost: 2,
      playerEliminated: 3,
      gameOver: 3,
      territoriesDealt: 3,
    });
    expect(eventTier({ type: 'phaseChanged', player: 0, phase: 'attack' })).toBe(0);
  });

  it('a tiered event stays in its band; the human dice show keeps its own timing; a readable engagement is one beat', () => {
    const inBand = (ms: number, t: 0 | 1 | 2 | 3) => ms >= TIER_BANDS[t][0] && ms <= TIER_BANDS[t][1];
    const conq: GameEvent = { type: 'territoryConquered', player: 1, from: 'ural', to: 'siberia', previousOwner: 0 };
    expect(inBand(eventDurationMs(conq, { style: 'readable', tier: 2 }), 2)).toBe(true);
    // continentLost was 300 ms in v3: a tier-2 soak now.
    expect(eventDurationMs({ type: 'continentLost', player: 0, continent: 'asia', to: 1 }, { tier: 2 })).toBe(650);
    expect(eventDurationMs({ type: 'territoriesDealt', owners: {} as Record<TerritoryId, number> }, { tier: 3 })).toBe(2400);
    const fort: GameEvent = { type: 'armiesMoved', player: 0, from: 'ural', to: 'kamchatka', count: 3, reason: 'fortify', path: ['ural', 'siberia', 'yakutsk', 'kamchatka', 'alaska', 'kamchatka'] };
    expect(inBand(eventDurationMs(fort, { tier: 1 }), 1)).toBe(true);
    const roll = { type: 'diceRolled', player: 1, defender: 0, from: 'ural', to: 'siberia', attackDice: [6, 5, 1], defendDice: [3, 2], attackerLosses: 0, defenderLosses: 2, blitz: true } as GameEvent;
    // The dice show (a human's full roll) is theatre: never squeezed into tier 1.
    expect(eventDurationMs(roll, { style: 'full', tier: 1 })).toBe(1200);
    // Readable: one tier-1 beat for the whole engagement, however many rolls.
    expect(inBand(eventDurationMs(roll, { style: 'readable', tier: 1, seq: { index: 0, count: 4 } }), 1)).toBe(true);
    expect(eventDurationMs(roll, { style: 'readable', tier: 1, seq: { index: 2, count: 4 } })).toBe(0);
    // No motion of its own stays 0 (turnStarted, an inline march).
    expect(eventDurationMs({ type: 'turnStarted', player: 0, turn: 3, round: 1, reinforcements: { base: 3, continents: 0, total: 3 } } as unknown as GameEvent, { tier: 0 })).toBe(0);
  });
});

describe('A1 the readable reel (stub board pacing)', () => {
  it('every AI event is tagged with its tier; every AI fight is readable; the line completes with the verdict', async () => {
    const { c, fb } = make();
    c.hooks.newGame({ players: AIS(4), seed: 9, dominationPercent: 70, turnLimit: null });
    const lines = new Set<string>();
    for (let t = 0; t < 400_000 && (c.hooks.getState()?.round ?? 0) <= 3; t += 50) {
      lines.add(c.hooks.ui().line);
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(fb.played.length).toBeGreaterThan(50);
    for (const p of fb.played) expect(p.opts?.tier).toBe(eventTier(p.ev));
    const dice = fb.played.filter((p) => p.ev.type === 'diceRolled');
    expect(dice.length).toBeGreaterThan(5);
    expect(dice.every((p) => p.opts?.style === 'readable')).toBe(true);
    const all = [...lines];
    expect(all.some((l) => /^AI\d attacks [A-Z][\w .]+…$/.test(l))).toBe(true);
    expect(all.some((l) => /^AI\d attacks [A-Z][\w .]+… and takes it$/.test(l))).toBe(true);
    // No snapped fights and no wall-clock cap lines.
    expect(all.some((l) => /finishes the turn/.test(l))).toBe(false);
    c.dispose();
  }, 60_000);

  it('even pace: a turn of ≤ 5 beats plays at 1× (Watch) or 2× (Fast); a longer one compresses every beat, never snaps', async () => {
    for (const ai of ['watch', 'fast'] as const) {
      const { c, fb } = make();
      c.hooks.setSpeed(1, ai);
      c.hooks.newGame({ players: AIS(4), seed: 12, dominationPercent: 70, turnLimit: null });
      await until(() => (c.hooks.getState()?.round ?? 0) > 5 || c.hooks.getState()?.phase.kind === 'game-over', 600_000, 100);
      const base = ai === 'fast' ? 2 : 1;
      // Group by turn: the engagements' first rolls and the board speed they played at.
      const turns: { beats: number; speeds: number[] }[] = [];
      let cur: { beats: number; speeds: number[] } | null = null;
      let pair = '';
      for (const p of fb.played) {
        if (p.ev.type === 'turnStarted') {
          cur = { beats: 0, speeds: [] };
          turns.push(cur);
          pair = '';
        }
        if (!cur) continue;
        if (p.ev.type === 'diceRolled') {
          const k = `${p.ev.from}>${p.ev.to}`;
          if (k !== pair) {
            cur.beats++;
            cur.speeds.push(p.speed);
          }
          pair = k;
        }
        if (p.ev.type === 'territoryConquered') expect(p.speed).toBeGreaterThan(0);
      }
      const short = turns.filter((t) => t.beats > 0 && t.beats <= 4);
      const long = turns.filter((t) => t.beats >= 7);
      expect(short.length).toBeGreaterThan(0);
      for (const t of short) for (const sp of t.speeds) expect(sp).toBe(base);
      for (const t of long) for (const sp of t.speeds) expect(sp).toBeGreaterThan(base);
      // One pace per turn.
      for (const t of turns) expect(new Set(t.speeds).size).toBeLessThanOrEqual(1);
      c.dispose();
    }
  }, 120_000);

  it("A5: the opening AI says 'Sage goes first' before it moves", async () => {
    const { c } = make();
    c.hooks.newGame({ players: AIS(3), seed: 5, dominationPercent: 70, turnLimit: null, initialPlacement: 'manual', setupBatch: 5 });
    const lines: string[] = [];
    for (let t = 0; t < 8000; t += 50) {
      const l = c.hooks.ui().line;
      if (lines[lines.length - 1] !== l) lines.push(l);
      await vi.advanceTimersByTimeAsync(50);
    }
    const i = lines.findIndex((l) => /^AI\d goes first$/.test(l));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(lines.slice(i + 1).some((l) => /^AI\d places \d+ arm/.test(l))).toBe(true);
    expect(lines.filter((l) => /goes first/.test(l)).length).toBe(1);
    c.dispose();
  }, 30_000);

  it('A2 / v5.1 B: every turn passes with one wood set-down (cupSet) and turnPassed, no cup slide or rattle; AI-vs-AI plays at distance, never at half volume', async () => {
    const { c, au } = make();
    const plays: { name: string; opts?: Record<string, unknown> }[] = [];
    (au.a as { play: (n: string, o?: Record<string, unknown>) => void }).play = (name, opts) => void plays.push({ name, opts });
    c.hooks.newGame({ players: AIS(3), seed: 4, dominationPercent: 70, turnLimit: null });
    await until(() => (c.hooks.getState()?.round ?? 0) > 2, 200_000, 100);
    const turns = c.hooks.metrics().turns.length;
    expect(au.calls.filter((x) => x === 'cue:cupSet').length).toBeGreaterThanOrEqual(turns);
    expect(au.calls.filter((x) => x === 'cue:cupSlide')).toEqual([]);
    expect(au.calls.filter((x) => x === 'cue:rattle')).toEqual([]);
    expect(au.calls.filter((x) => x === 'turnPassed:false').length).toBeGreaterThanOrEqual(turns);
    expect(plays.some((p) => p.opts?.volume === 0.5)).toBe(false);
    expect(plays.some((p) => p.opts?.distance === 0.6)).toBe(true);
    c.dispose();
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------
// A3 the receipt
// ---------------------------------------------------------------------------------------------------------

describe('A3 buildReceipt (pure)', () => {
  // John (0, human), Sam (1, human), Priya (2, AI). Priya holds everything John and Sam don't.
  const s = fixture({ ural: [2, 6], siberia: [2, 4], peru: [2, 3], ukraine: [0, 5], brazil: [1, 2] });
  const tookFromJohn = () => {
    const l = emptyReceipts();
    l.last[0] = 5;
    l.aiTurns.push([6, 2]);
    l.items.push(
      { turn: 6, seat: 2, k: 'placed', n: 5 },
      { turn: 6, seat: 2, k: 'took', t: 'ural', from: 0 },
      { turn: 6, seat: 2, k: 'took', t: 'siberia', from: 0 },
      { turn: 6, seat: 2, k: 'took', t: 'peru', from: 1 },
      { turn: 6, seat: 2, k: 'broke', c: 'asia', from: 0 },
    );
    return l;
  };

  it('names what was taken and from whom, the continent broken, what the seat holds now; stings; the summary', () => {
    const r = buildReceipt(tookFromJohn(), s, 0, 5, 'While you were away', 1)!;
    expect(r.title).toBe('While you were away');
    expect(r.lines).toHaveLength(1);
    const [line] = r.lines;
    expect(line.seat.name).toBe('Priya');
    expect(line.text).toMatch(/^Priya took (Ural and Siberia|2) from you, 1 from Sam · broke your Asia · now 40 territories, \d+ armies$/);
    expect(line.text.length).toBeLessThanOrEqual(RECEIPT_LINE_MAX);
    expect(line.stings).toBe(true);
    expect(line.territories).toEqual(['ural', 'siberia', 'peru']);
    expect(r.summary).toBe('You lost 2 territories and Asia · you hold 1');
  });

  it("Sam reads the same turn from his side: his loss first, John's named", () => {
    const r = buildReceipt(tookFromJohn(), s, 1, 5, 'While you were away', 2)!;
    expect(r.lines[0].text).toMatch(/^Priya took Peru from you, (Ural and Siberia|2) from John · broke John's Asia · now/);
    expect(r.summary).toBe('You lost 1 territory · you hold 1');
  });

  it('a seat that only placed: one plain line, no sting; nothing since the last turn: no receipt', () => {
    const l = emptyReceipts();
    l.last[0] = 5;
    l.aiTurns.push([6, 2]);
    l.items.push({ turn: 6, seat: 2, k: 'placed', n: 3 }, { turn: 6, seat: 2, k: 'placed', n: 2 });
    const r = buildReceipt(l, s, 0, 5, 'While you were away', 1)!;
    expect(r.lines[0].text).toMatch(/^Priya placed 5 armies · now 40 territories, \d+ armies$/);
    expect(r.lines[0].stings).toBe(false);
    expect(r.summary).toBe('You lost nothing · you hold 1');
    expect(buildReceipt(l, s, 0, 6, 'While you were away', 2)).toBeNull();
  });

  it('a long rampage: names give way to counts, the line stays ≤ 90 characters', () => {
    const l = emptyReceipts();
    l.last[0] = 5;
    l.aiTurns.push([6, 2]);
    for (const t of ['alaska', 'alberta', 'ontario', 'quebec', 'greenland', 'northwest_territory', 'western_us'] as TerritoryId[]) l.items.push({ turn: 6, seat: 2, k: 'took', t, from: 0 });
    l.items.push({ turn: 6, seat: 2, k: 'gained', c: 'north_america' }, { turn: 6, seat: 2, k: 'out', p: 1 });
    const r = buildReceipt(l, s, 0, 5, 'While you were away', 1)!;
    expect(r.lines[0].text.length).toBeLessThanOrEqual(RECEIPT_LINE_MAX);
    expect(r.lines[0].text).toMatch(/^Priya took 7 from you · knocked out Sam/);
    expect(r.lines[0].territories).toHaveLength(7);
  });

  it('recordReceipt + noteTurnStart: only AI turns since the reader last played; pruned once every human has read past', () => {
    const l = emptyReceipts();
    const st: GameState = { ...s, turn: 6 };
    noteTurnStart(l, st, 0, 5, false);
    noteTurnStart(l, st, 2, 6, true);
    recordReceipt(l, st, { type: 'territoryConquered', player: 2, from: 'ural', to: 'ukraine', previousOwner: 0 });
    recordReceipt(l, st, { type: 'truceProposed', from: 2, to: 0, rounds: 3, kind: 'noAttack' });
    const r = buildReceipt(l, st, 0, 5, 'While you were away', 1)!;
    expect(r.lines[0].text).toMatch(/^Priya took Ukraine from you · offers you a truce · now/);
    noteTurnStart(l, st, 1, 7, false);
    noteTurnStart(l, st, 0, 8, false);
    // Still there while John's turn-8 receipt may be read again (a resume)…
    expect(l.items).toHaveLength(2);
    noteTurnStart(l, st, 1, 9, false);
    noteTurnStart(l, st, 0, 10, false);
    // …gone once both humans have played past them.
    expect(l.items).toHaveLength(0);
  });
});

/** John (human) + two AIs, everything instant: the controller's receipt flow without waiting. */
async function playToReceipt(c: GameController, seed: number): Promise<boolean> {
  c.hooks.setSpeed(0, 'instant');
  c.hooks.newGame({ players: [{ name: 'John', color: 'crimson', kind: 'human' }, ...AIS(3).slice(1)], seed, dominationPercent: 70, turnLimit: null });
  for (let t = 0; t < 120_000; t += 50) {
    if (c.hooks.receipt()) return true;
    if (humanTurn(c)) {
      const s = c.hooks.getState()!;
      c.hooks.dispatch(chooseAiAction(s, s.currentPlayer));
    }
    await vi.advanceTimersByTimeAsync(50);
  }
  return false;
}

describe('HUD asks: the desktop name card and the Continue sketch', () => {
  it('a desktop click that selects sets the name card at the pointer; the title save carries the owners', async () => {
    const kv = memoryKV();
    kv.set(SAVE_KEY, JSON.stringify({ v: 1, savedAt: 0, state: fixture({ ural: [0, 5] }, { kind: 'reinforce', remaining: 3, mustTrade: false, placed: {}, midTurn: false }) }));
    const { c, fb } = make({ kv });
    const save = c.getViewModel().save!;
    expect(save.sketch?.owners.ural).toBe('crimson');
    expect(save.sketch?.owners.siberia).toBe('amber');
    c.intent({ type: 'continue' });
    await vi.advanceTimersByTimeAsync(50);
    fb.click('ural');
    const card = c.getViewModel().game!.nameCard!;
    expect(card).toMatchObject({ territory: 'Ural', owner: { name: 'John' }, armies: 5 });
    expect(card.key).toBeGreaterThan(0);
    c.dispose();
  });
});

describe('B3 idle and the sheet cue', () => {
  it("a minute untouched on a human's turn thins the score; any input brings it back; a sheet opening is heard", async () => {
    const kv = memoryKV();
    kv.set(SAVE_KEY, JSON.stringify({ v: 1, savedAt: 0, state: fixture({ ural: [0, 5] }, { kind: 'reinforce', remaining: 3, mustTrade: false, placed: {}, midTurn: false }) }));
    const { c, fb, au } = make({ kv });
    c.intent({ type: 'continue' });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(au.calls).not.toContain('idle:true');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(au.calls).toContain('idle:true');
    fb.click('ural');
    expect(au.calls[au.calls.length - 1 - au.calls.slice().reverse().findIndex((x) => x.startsWith('idle:'))]).toBe('idle:false');
    expect(au.calls).toContain('cue:tick');
    c.intent({ type: 'overlay', overlay: 'pause' });
    expect(au.calls[au.calls.length - 1]).toBe('cue:sheet');
    c.dispose();
  });
});

// ---------------------------------------------------------------------------------------------------------
// A4 the loser's rings
// ---------------------------------------------------------------------------------------------------------

describe("A4 the loser's rings", () => {
  it("a territory taken from a human keeps a ring in the loser's colour until that loser's next turn ends", async () => {
    // Priya (AI) to move in Attack with 30 on Siberia next to John's 1 on Ural; Sam (human) plays after John.
    const s = fixture({ siberia: [2, 30], ural: [0, 1], ukraine: [0, 30], peru: [1, 3] }, { kind: 'attack' });
    s.currentPlayer = 2;
    const kv = memoryKV();
    kv.set(SAVE_KEY, JSON.stringify({ v: 1, savedAt: 0, state: s }));
    const { c, fb } = make({ kv });
    c.intent({ type: 'continue' });
    expect(await until(() => humanTurn(c) && c.hooks.getState()!.currentPlayer === 0, 60_000)).toBe(true);
    const st = c.hooks.getState()!;
    expect(st.territories.ural.owner).toBe(2);
    expect(c.hooks.loserRings()).toEqual([{ territory: 'ural', color: 'crimson' }]);
    expect(fb.highlights.loserRings).toEqual([{ territory: 'ural', color: 'crimson' }]);
    // Through John's whole turn…
    for (let i = 0; i < 40 && c.hooks.getState()!.currentPlayer === 0; i++) {
      const cur = c.hooks.getState()!;
      if (cur.phase.kind === 'attack') c.hooks.dispatch({ type: 'endAttack', player: 0 });
      else if (cur.phase.kind === 'fortify') c.hooks.dispatch({ type: 'endTurn', player: 0 });
      else c.hooks.dispatch(chooseAiAction(cur, 0));
      if (c.hooks.getState()!.currentPlayer === 0) expect(c.hooks.loserRings().some((r) => r.territory === 'ural')).toBe(true);
      await vi.advanceTimersByTimeAsync(400);
    }
    // …and gone when it ends.
    await until(() => c.hooks.getState()!.currentPlayer === 1 && c.hooks.isIdle(), 10_000);
    expect(c.hooks.loserRings()).toEqual([]);
    expect(fb.highlights.loserRings).toBeUndefined();
    c.dispose();
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------
// A5 truces, copy
// ---------------------------------------------------------------------------------------------------------

function truceBoard(mut?: (s: GameState) => void): GameState {
  const s = fixture({ ural: [0, 8], siberia: [2, 2], ukraine: [0, 3], peru: [1, 3] }, { kind: 'reinforce', remaining: 3, mustTrade: false, placed: {}, midTurn: false });
  s.players[2].personality = 'turtle';
  s.config = { ...s.config, diplomacy: true };
  mut?.(s);
  return s;
}

describe('A5 / v5.1 C a pending offer in the state shows nothing', () => {
  it('with an old offer in the state: no offer line; pick a territory → the stepper and `Place N` (the one gold)', async () => {
    const s = truceBoard((st) => {
      st.diplomacy = { truces: [], offers: [{ from: 2, to: 0, rounds: 3, kind: 'noAttack', turn: 8 }], proposedOn: { 2: 8 }, rebuffs: [] };
    });
    const kv = memoryKV();
    kv.set(SAVE_KEY, JSON.stringify({ v: 1, savedAt: 0, state: s }));
    const { c, fb } = make({ kv });
    c.intent({ type: 'continue' });
    await vi.advanceTimersByTimeAsync(50);
    expect(c.hooks.ui().offer).toBeNull();
    fb.click('ural');
    await vi.advanceTimersByTimeAsync(30);
    const u = c.hooks.ui();
    expect(u.count).toMatchObject({ value: 3, min: 1, max: 3 });
    expect(u.primary).toBe('Place 3');
    expect(u.gold).toBe('button:place');
    expect(u.line).toBe('Place on Ural');
    expect(u.offer).toBeNull();
    c.intent({ type: 'button', id: 'place' });
    await vi.advanceTimersByTimeAsync(400);
    expect(c.hooks.getState()!.territories.ural.armies).toBe(11);
    c.dispose();
  });
});

describe('A5 the AI proposes rarely, and says why', () => {
  // Priya (turtle) on her own turn, facing John's big border (and Sam's): she would ask John.
  const base = () => {
    const s = fixture({ ural: [0, 8], ukraine: [0, 6], peru: [1, 3] }, { kind: 'reinforce', remaining: 5, mustTrade: false, placed: {}, midTurn: false });
    s.players[2].personality = 'turtle';
    s.config = { ...s.config, diplomacy: true };
    s.currentPlayer = 2;
    return s;
  };

  it('a fresh pair: an offer, with a reason it can state', () => {
    const s = base();
    const p = chooseTruceProposal(s, 2);
    expect(p).toMatchObject({ from: 2, to: 0 });
    expect(truceReason(s, 2, 0)).toMatch(/^you share a border in (Asia|Europe)$/);
    expect(truceReason(s, 0, 2)).toMatch(/^they share a border in /);
  });

  it('at most once per 3 rounds from a seat (so per pair), whatever came of it', () => {
    const s = base();
    const seats = s.players.length;
    s.diplomacy = { truces: [], offers: [], proposedOn: { 2: s.turn - 2 * seats }, rebuffs: [] };
    expect(chooseTruceProposal(s, 2)).toBeNull();
    s.diplomacy.proposedOn = { 2: s.turn - 3 * seats };
    expect(chooseTruceProposal(s, 2)).not.toBeNull();
  });

  it('a human hears one offer at a time, and none the round after one', () => {
    const s = base();
    s.diplomacy = { truces: [], offers: [{ from: 1, to: 0, rounds: 3, kind: 'noAttack', turn: s.turn - 1 }], proposedOn: {}, rebuffs: [] };
    expect(chooseTruceProposal(s, 2)?.to).not.toBe(0);
    s.diplomacy = { truces: [], offers: [], proposedOn: {}, rebuffs: [{ from: 1, to: 0, round: s.round - 1 }] };
    expect(chooseTruceProposal(s, 2)?.to).not.toBe(0);
    expect(lastOfferRound(s, 1, 0)).toBe(s.round - 1);
  });

  it('a whole game: no AI asks the same human twice within 3 rounds', async () => {
    const { c } = make();
    c.hooks.setSpeed(0, 'instant');
    c.hooks.newGame({
      players: [
        { name: 'John', color: 'crimson', kind: 'human' },
        { name: 'T', color: 'cobalt', kind: 'ai', difficulty: 'normal', personality: 'turtle' },
        { name: 'O', color: 'amber', kind: 'ai', difficulty: 'normal', personality: 'opportunist' },
        { name: 'W', color: 'rose', kind: 'ai', difficulty: 'normal', personality: 'warlord' },
      ],
      seed: 77,
      dominationPercent: 70,
      turnLimit: null,
      diplomacy: true,
    });
    for (let t = 0; t < 300_000 && (c.hooks.getState()?.round ?? 0) <= 12 && c.hooks.getState()?.phase.kind !== 'game-over'; t += 50) {
      if (humanTurn(c)) {
        if (c.hooks.receipt()) c.hooks.dismissReceipt();
        const s = c.hooks.getState()!;
        c.hooks.dispatch(chooseAiAction(s, s.currentPlayer));
      }
      await vi.advanceTimersByTimeAsync(50);
    }
    const offers = c.hooks.ledger().filter((l) => /proposes a truce with John/.test(l.text));
    console.log(`[truce] offers to John in 12 rounds: ${offers.map((o) => `r${o.round} ${o.text}`).join(" | ")}`);
    for (const o of offers) expect(o.text).toMatch(/ · (you|they) share a border in /);
    const byRound: Record<string, number[]> = {};
    for (const o of offers) (byRound[o.text.split(' ')[0]] ??= []).push(o.round);
    for (const rounds of Object.values(byRound)) for (let i = 1; i < rounds.length; i++) expect(rounds[i] - rounds[i - 1]).toBeGreaterThanOrEqual(3);
    // Never two offers to John in one round.
    const perRound = offers.map((o) => o.round);
    expect(new Set(perRound).size).toBe(perRound.length);
    c.dispose();
  }, 120_000);
});

describe('A5 copy', () => {
  it('the readable line and the auto-move words', () => {
    const b = attackBegins('Sage', 'Northern Europe');
    expect(b).toBe('Sage attacks Northern Europe…');
    expect(attackTakes(b)).toBe('Sage attacks Northern Europe… and takes it');
    expect(attackThrownBack(b)).toBe('Sage attacks Northern Europe… and is thrown back');
    expect(goesFirst('Sage')).toBe('Sage goes first');
    expect(movesIn(1)).toBe('1 army moves in');
    expect(movesIn(3)).toBe('3 armies move in');
  });

  it("'Vermilion took Brazil from Ochre': the owner in the line, the origin in the Ledger's detail", async () => {
    const s = fixture({ new_guinea: [0, 6], indonesia: [2, 1] }, { kind: 'attack' });
    let conquered = false;
    for (let seed = 1; seed < 400 && !conquered; seed++) {
      s.rng = seed;
      const r = applyAction(s, { type: 'blitz', player: 0, from: 'new_guinea', to: 'indonesia' });
      conquered = r.ok && r.state.territories.indonesia.owner === 0;
    }
    const kv = memoryKV();
    kv.set(SAVE_KEY, JSON.stringify({ v: 1, savedAt: 0, state: s }));
    const { c } = make({ kv });
    c.intent({ type: 'continue' });
    await vi.advanceTimersByTimeAsync(50);
    c.hooks.dispatch({ type: 'blitz', player: 0, from: 'new_guinea', to: 'indonesia' });
    await until(() => c.hooks.isIdle(), 10_000);
    const line = c.getViewModel().game!.log.filter((l) => l.kind === 'engagement').pop()!;
    expect(line.text).toMatch(/^John took Indonesia from Priya · 6 vs 1 · lost \d+$/);
    expect(line.detail).toBe('from New Guinea');
    c.dispose();
  });
});
