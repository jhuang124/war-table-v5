// Controller integration in Node with a fake board whose playEvent takes the modelled 1× durations
// (src/game/timingModel.ts) under fake timers. Proves the highlight reel's scheduling, click-through,
// input rules and resume without a browser.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAction, chooseAiAction, type GameEvent, type GameState, type PlayerConfig, type TerritoryId } from '../../src/engine';
import type { AudioEngine } from '../../src/audio/types';
import type { BoardHighlights, BoardView, PlayEventOptions, TerritoryPointerInfo } from '../../src/render/BoardView';
import { createController, type GameController } from '../../src/game/controller';
import { memoryKV, SAVE_KEY, SETTINGS_KEY } from '../../src/game/storage';
import { eventDurationMs, scaledDuration } from '../../src/game/timingModel';
import { board as fixture } from './fixtures';

interface Played {
  ev: GameEvent;
  opts?: PlayEventOptions;
  start: number;
  end: number;
}

function fakeBoard() {
  let speed = 1;
  const pending = new Set<() => void>();
  let click: ((i: TerritoryPointerInfo) => void) | null = null;
  const played: Played[] = [];
  let skips = 0;
  let highlights: BoardHighlights = {};
  let syncs = 0;
  const b: BoardView = {
    syncState: () => void syncs++,
    playEvent(ev, _after, opts) {
      const rec: Played = { ev, opts, start: Date.now(), end: Date.now() };
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
      skips++;
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
    click: (t: TerritoryId, button = 0, mods: Partial<TerritoryPointerInfo> = {}) =>
      click!({ territory: t, clientX: 0, clientY: 0, shiftKey: false, altKey: false, metaKey: false, button, ...mods }),
    get skips() {
      return skips;
    },
    get highlights() {
      return highlights;
    },
    get syncs() {
      return syncs;
    },
  };
}

const silentAudio: AudioEngine = {
  unlock: () => undefined,
  play: () => undefined,
  setVolume: () => undefined,
  setMuted: () => undefined,
  setMusic: () => undefined,
  setMusicVolume: () => undefined,
  stopAll: () => undefined,
  isUnlocked: () => false,
  stats: () => ({ state: 'locked', voices: 0, voicesByName: {}, played: 0, dropped: 0, stolen: 0, music: false }) as unknown as ReturnType<AudioEngine['stats']>,
  dispose: () => undefined,
};

const clock = {
  now: () => Date.now(),
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
  raf: (fn: () => void) => void setTimeout(fn, 16),
};

function make(kv = memoryKV()) {
  // These flows hand the device between two humans without the pass-the-cup cover (on by default since
  // settings v5): switched off, as a player can.
  if (!kv.get(SETTINGS_KEY)) kv.set(SETTINGS_KEY, JSON.stringify({ hideCardsBetweenTurns: false, v: 5 }));
  const fb = fakeBoard();
  const c = createController({ board: fb.board, audio: silentAudio, storage: kv, clock, dom: false, prefersReducedMotion: () => false });
  return { c, fb, kv };
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

const pctl = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

/** While it's a human's turn and everything is idle, play the AI's move for them through the hooks. */
function driveHumans(c: GameController): void {
  const s = c.hooks.getState();
  if (!s || s.phase.kind === 'game-over' || !c.hooks.isIdle()) return;
  if (s.players[s.currentPlayer].kind !== 'human') return;
  c.hooks.dispatch(chooseAiAction(s, s.currentPlayer));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('AI highlight reel (UX.md §6.1)', () => {
  it('4 AIs at watch: median turn ≤ 6 s, p95 ≤ 12 s, over several seeds', async () => {
    const all: number[] = [];
    for (const seed of [11, 22, 33]) {
      const { c } = make();
      c.hooks.newGame({ players: AIS(4), seed, dominationPercent: 70, turnLimit: null });
      await until(() => (c.hooks.getState()?.round ?? 0) > 5 || c.hooks.getState()?.phase.kind === 'game-over', 600_000, 100);
      const turns = c.hooks.metrics().turns.filter((t) => t.kind === 'ai');
      expect(turns.length).toBeGreaterThan(8);
      all.push(...turns.map((t) => t.ms));
      c.dispose();
    }
    const med = pctl(all, 0.5);
    const p95 = pctl(all, 0.95);
    console.log(`[reel] all-AI turns n=${all.length} median ${med} ms p95 ${p95} ms max ${Math.max(...all)} ms`);
    expect(med).toBeLessThanOrEqual(6000);
    expect(p95).toBeLessThanOrEqual(12000);
  }, 60_000);

  it('1 human + 3 AI (v4 A1): every AI fight is a readable beat, never the dice show; turns stay in budget', async () => {
    const all: number[] = [];
    let fullRolls = 0;
    let readableRolls = 0;
    for (const seed of [5, 6, 7]) {
      const { c, fb } = make();
      c.hooks.newGame({
        players: [{ name: 'John', color: 'crimson', kind: 'human' }, ...AIS(4).slice(1)],
        seed,
        dominationPercent: 70,
        turnLimit: null,
      });
      for (let t = 0; t < 900_000 && (c.hooks.getState()?.round ?? 0) <= 6 && c.hooks.getState()?.phase.kind !== 'game-over'; t += 100) {
        driveHumans(c);
        await vi.advanceTimersByTimeAsync(100);
      }
      all.push(...c.hooks.metrics().turns.filter((t) => t.kind === 'ai').map((t) => t.ms));
      const aiRolls = fb.played.filter((p) => p.ev.type === 'diceRolled' && (p.ev as { player: number }).player !== 0);
      fullRolls += aiRolls.filter((p) => p.opts?.style !== 'readable').length;
      readableRolls += aiRolls.filter((p) => p.opts?.style === 'readable' && p.opts.tier === 1).length;
      c.dispose();
    }
    const med = pctl(all, 0.5);
    const p95 = pctl(all, 0.95);
    console.log(`[reel] 1h+3AI: AI turns n=${all.length} median ${med} ms p95 ${p95} ms max ${Math.max(...all)} ms, readable AI rolls ${readableRolls}`);
    expect(fullRolls).toBe(0);
    expect(readableRolls).toBeGreaterThan(0);
    expect(med).toBeLessThanOrEqual(6000);
    expect(p95).toBeLessThanOrEqual(12000);
  }, 120_000);

  it('think time only at decision points: a breath at turn start and between engagements (× the turn compression), 0 inside', async () => {
    const { c, fb } = make();
    c.hooks.newGame({ players: AIS(3), seed: 3, dominationPercent: 70, turnLimit: null });
    await until(() => (c.hooks.getState()?.round ?? 0) > 3, 300_000, 100);
    const ev = fb.played;
    let checkedStart = 0;
    let checkedBetween = 0;
    for (let i = 0; i < ev.length; i++) {
      if (ev[i].ev.type !== 'turnStarted') continue;
      const firstPlace = ev.slice(i + 1).find((p) => p.ev.type === 'armiesPlaced' || p.ev.type === 'cardsTraded');
      if (firstPlace) {
        // v4: 300 ms at 1×, shortened with every other beat on a long turn (≥ 4× compression floor). v5 D5: a turn
        // that attacks gives 140 ms of it to the cup's rattle before its first attack (160 ms at 1×, same total).
        const gap = firstPlace.start - ev[i].end;
        expect(gap).toBeGreaterThanOrEqual(39);
        expect(gap).toBeLessThan(700);
        checkedStart++;
      }
    }
    // Consecutive diceRolled of one engagement are back to back.
    for (let i = 1; i < ev.length; i++) {
      const a = ev[i - 1].ev;
      const b = ev[i].ev;
      if (a.type === 'diceRolled' && b.type === 'diceRolled' && a.from === b.from && a.to === b.to) {
        expect(ev[i].start - ev[i - 1].end).toBeLessThanOrEqual(20);
      }
      if (b.type === 'diceRolled' && (b as { blitz: boolean }).blitz) {
        // First roll of a new engagement after another in the same turn: a 160 ms breath at 1× (× the
        // turn's compression, floor 4×), never none.
        const prev = [...ev.slice(0, i)].reverse().find((p) => p.ev.type === 'diceRolled');
        if (prev && prev.ev.type === 'diceRolled' && (prev.ev.from !== b.from || prev.ev.to !== b.to) && prev.ev.player === b.player) {
          const lastOfPrev = ev.slice(0, i).reverse().find((p) => p.start >= prev.start && p.ev.type !== 'phaseChanged');
          expect(ev[i].start - (lastOfPrev?.end ?? prev.end)).toBeGreaterThanOrEqual(39);
          checkedBetween++;
        }
      }
    }
    expect(checkedStart).toBeGreaterThan(3);
    expect(checkedBetween).toBeGreaterThan(0);
    c.dispose();
  }, 60_000);

  it('readable style for every AI engagement (v4 A1): one tier-1 beat for the dice, ≤ 0.65 s, never snapped', async () => {
    const { c, fb } = make();
    c.hooks.newGame({ players: AIS(4), seed: 9, dominationPercent: 70, turnLimit: null });
    await until(() => (c.hooks.getState()?.round ?? 0) > 3, 300_000, 100);
    const rolls = c.hooks.metrics().rolls;
    expect(rolls.length).toBeGreaterThan(3);
    for (const r of rolls) expect(r.style).toBe('readable');
    for (const r of rolls) expect(r.ms).toBeLessThanOrEqual(650);
    const dice = fb.played.filter((p) => p.ev.type === 'diceRolled');
    expect(dice.every((p) => p.opts?.style === 'readable' && p.opts.tier === 1)).toBe(true);
    // Never snapped: every conquest floods at its tier-2 beat (≥ 650 ms / 4× compression floor).
    const floods = fb.played.filter((p) => p.ev.type === 'territoryConquered');
    expect(floods.length).toBeGreaterThan(0);
    for (const f of floods) expect(f.end - f.start).toBeGreaterThanOrEqual(160);
    c.dispose();
  }, 60_000);

  it('instant: each AI turn snaps with a ~300 ms beat, and AI turns get no turn banner', async () => {
    const { c, fb } = make();
    c.hooks.setSpeed(1, 'instant');
    c.hooks.newGame({ players: AIS(3), seed: 4, dominationPercent: 70, turnLimit: null });
    let banners = 0;
    for (let t = 0; t < 60_000 && (c.hooks.getState()?.round ?? 0) <= 4; t += 50) {
      if (c.getViewModel().game?.banner?.kind === 'turn') banners++;
      await vi.advanceTimersByTimeAsync(50);
    }
    const turns = c.hooks.metrics().turns.filter((t) => t.kind === 'ai');
    expect(turns.length).toBeGreaterThan(6);
    for (const t of turns.slice(1)) expect(t.ms).toBeLessThan(700);
    // The turn banner is for the humans at the table; the step indicator names an AI's turn.
    expect(banners).toBe(0);
    // No board animations during instant AI turns (the deal before the first turn aside).
    const afterDeal = fb.played.filter((p) => p.ev.type === 'diceRolled');
    expect(afterDeal.length).toBe(0);
    c.dispose();
  }, 60_000);
});

describe('human input', () => {
  async function humanReinforce(seed = 21) {
    const kit = make();
    const { c } = kit;
    c.hooks.newGame({ players: [{ name: 'John', color: 'crimson', kind: 'human' }, { name: 'Sam', color: 'cobalt', kind: 'human' }], seed, dominationPercent: 80, turnLimit: null });
    await until(() => c.hooks.isIdle(), 20_000);
    return kit;
  }

  it('Place: a click picks, the count defaults to all, Place N commits, Undo takes it back whole, the track moves on', async () => {
    const { c, fb } = await humanReinforce();
    const s = c.hooks.getState()!;
    expect(s.phase.kind).toBe('reinforce');
    const me = s.currentPlayer;
    const own = (Object.keys(s.territories) as TerritoryId[]).filter((x) => s.territories[x].owner === me);
    const [a, b] = own;
    const before = { a: s.territories[a].armies, b: s.territories[b].armies };
    const remaining = (s.phase as { remaining: number }).remaining;
    expect(c.hooks.ui().line).toBe(`Place ${remaining} armies · click a territory`);
    fb.click(a);
    await vi.advanceTimersByTimeAsync(500);
    let u = c.hooks.ui();
    expect(u.line).toMatch(/^Place on /);
    // ≤ 6 options: a stepper; more: a slider.
    expect(u.count).toEqual({ control: remaining <= 6 ? 'stepper' : 'slider', value: remaining, min: 1, max: remaining });
    expect(u.track).toEqual(['current:place', 'locked:attack', 'locked:fortify', 'locked:endTurn']);
    expect(u.primary).toBe(`Place ${remaining}`);
    // Nothing is committed until Place.
    expect(c.hooks.getState()!.territories[a].armies).toBe(before.a);
    c.intent({ type: 'setCount', value: 2 });
    await vi.advanceTimersByTimeAsync(20);
    expect(c.hooks.ui().primary).toBe('Place 2');
    c.intent({ type: 'button', id: 'place' });
    await vi.advanceTimersByTimeAsync(400);
    expect(c.hooks.getState()!.territories[a].armies).toBe(before.a + 2);
    // The pick stays; the stepper resets to all that's left; Undo appears.
    u = c.hooks.ui();
    expect(u.primary).toBe(`Place ${remaining - 2}`);
    expect(u.buttons).toContain('Undo');
    // Another of yours moves the pick; Undo takes back the whole last placement.
    fb.click(b);
    await vi.advanceTimersByTimeAsync(500);
    c.intent({ type: 'button', id: 'undo' });
    await vi.advanceTimersByTimeAsync(400);
    expect(c.hooks.getState()!.territories[a].armies).toBe(before.a);
    expect((c.hooks.getState()!.phase as { remaining: number }).remaining).toBe(remaining);
    // A double-click is just two picks (no place-all accelerator): Place N commits.
    fb.click(b);
    await vi.advanceTimersByTimeAsync(120);
    fb.click(b);
    await vi.advanceTimersByTimeAsync(400);
    expect(c.hooks.getState()!.territories[b].armies).toBe(before.b);
    // A locked segment explains itself.
    c.intent({ type: 'track', seg: 'attack' });
    expect(c.hooks.ui().line).toBe(`Place your ${remaining} armies first`);
    c.intent({ type: 'button', id: 'place' });
    await vi.advanceTimersByTimeAsync(400);
    expect(c.hooks.getState()!.territories[b].armies).toBe(before.b + remaining);
    u = c.hooks.ui();
    expect(u.line).toMatch(/^All placed · (Attack is next|end your turn)$/);
    expect(u.buttons).toEqual(['Undo']);
    expect(u.brass).toEqual([u.recommended === 'attack' ? 'Attack' : 'End turn']);
    // Board clicks don't leave Place; the track does.
    fb.click(a);
    await vi.advanceTimersByTimeAsync(20);
    expect(c.hooks.getState()!.phase.kind).toBe('reinforce');
    c.intent({ type: 'track', seg: 'attack' });
    await vi.advanceTimersByTimeAsync(400);
    expect(c.hooks.getState()!.phase.kind).toBe('attack');
    expect(c.hooks.ui().track).toEqual(['done:place', 'current:attack', 'eligible:fortify', 'eligible:endTurn']);
    // Past segments are inert.
    c.intent({ type: 'track', seg: 'place' });
    expect(c.hooks.getState()!.phase.kind).toBe('attack');
    expect(c.hooks.metrics().inputDropped).toBe(0);
    c.dispose();
  });

  it('click-through: a click during your own blitz skips it and then performs the click', async () => {
    const { c, fb } = await humanReinforce(8);
    const s = c.hooks.getState()!;
    const me = s.currentPlayer;
    // Put everything on the biggest border tile, then attack its weakest neighbor.
    const own = (Object.keys(s.territories) as TerritoryId[]).filter((x) => s.territories[x].owner === me);
    const r = (s.phase as { remaining: number }).remaining;
    let src: TerritoryId | null = null;
    let tgt: TerritoryId | null = null;
    for (const t of own) {
      const e = (await import('../../src/engine')).attackTargets({ ...s, territories: { ...s.territories, [t]: { owner: me, armies: 9 } } }, t);
      if (e.length) {
        src = t;
        tgt = e[0];
        break;
      }
    }
    expect(src && tgt).toBeTruthy();
    c.hooks.dispatch({ type: 'reinforce', player: me, territory: src!, count: r });
    c.hooks.dispatch({ type: 'endReinforce', player: me });
    await until(() => c.hooks.isIdle(), 5000);
    fb.click(tgt!); // target-first: arms
    await vi.advanceTimersByTimeAsync(20);
    expect(c.hooks.ui().primary).toBe('Blitz');
    c.intent({ type: 'button', id: 'blitz' });
    await vi.advanceTimersByTimeAsync(300); // dice rolling
    const skipsBefore = fb.skips;
    // The track is visibly disabled while the dice roll: End turn does nothing (it never queues).
    expect(c.getViewModel().game!.strip.track.disabled).toBe(true);
    c.intent({ type: 'track', seg: 'endTurn' });
    expect(fb.skips).toBe(skipsBefore);
    const t0 = Date.now();
    fb.click(src!); // click-through: skip the blitz, then do this click
    await until(() => c.hooks.isIdle(), 4000, 10);
    expect(fb.skips).toBeGreaterThan(skipsBefore);
    const after = c.hooks.getState()!;
    expect(after.currentPlayer).toBe(me);
    expect(Date.now() - t0).toBeLessThan(800);
    c.dispose();
  });

  it('250 ms guard after a human→human turn change drops board clicks', async () => {
    const { c, fb } = await humanReinforce(12);
    const s = c.hooks.getState()!;
    const me = s.currentPlayer;
    c.hooks.dispatch({ type: 'reinforce', player: me, territory: (Object.keys(s.territories) as TerritoryId[]).find((x) => s.territories[x].owner === me)!, count: (s.phase as { remaining: number }).remaining });
    c.hooks.dispatch({ type: 'endReinforce', player: me });
    c.hooks.dispatch({ type: 'endTurn', player: me });
    await until(() => !!c.getViewModel().game?.seats.find((x) => x.current && x.seat.id !== me), 3000, 10);
    const s2 = c.hooks.getState()!;
    const t = (Object.keys(s2.territories) as TerritoryId[]).find((x) => s2.territories[x].owner === s2.currentPlayer)!;
    fb.click(t);
    expect(c.hooks.metrics().inputDropped).toBe(1);
    await vi.advanceTimersByTimeAsync(300);
    fb.click(t);
    await vi.advanceTimersByTimeAsync(20);
    expect(c.hooks.ui().line).toMatch(/^Place on /);
    c.dispose();
  });

  it('a refused click swaps its plain reason into the line for 2 s, then the line comes back', async () => {
    const { c, fb } = await humanReinforce(13);
    const s = c.hooks.getState()!;
    const enemy = (Object.keys(s.territories) as TerritoryId[]).find((x) => s.territories[x].owner !== s.currentPlayer)!;
    const normal = c.hooks.ui().line;
    fb.click(enemy);
    await vi.advanceTimersByTimeAsync(20);
    expect(c.hooks.ui().line).toMatch(/^That's .+'s · click one of your territories$/);
    expect(c.hooks.ui().lineKind).toBe('rejection');
    await vi.advanceTimersByTimeAsync(1900);
    expect(c.hooks.ui().lineKind).toBe('rejection');
    await vi.advanceTimersByTimeAsync(200);
    expect(c.hooks.ui().line).toBe(normal);
    // The same reason every time: no escalating copy.
    fb.click(enemy);
    fb.click(enemy);
    fb.click(enemy);
    await vi.advanceTimersByTimeAsync(20);
    expect(c.hooks.ui().line).toMatch(/^That's .+'s · click one of your territories$/);
    c.dispose();
  });
});

describe('resume', () => {
  function saveWith(kv: ReturnType<typeof memoryKV>, s: GameState) {
    kv.set(SAVE_KEY, JSON.stringify({ v: 1, savedAt: 0, state: s }));
  }

  it('mid-occupy restores the step, the smart default and line 1', async () => {
    const kv = memoryKV();
    const s = fixture({ ural: [0, 8], siberia: [0, 0] }, { kind: 'occupy', from: 'ural', to: 'siberia', min: 3, max: 7, previousOwner: 2 });
    s.territories.afghanistan.armies = 5;
    saveWith(kv, s);
    const { c, fb } = make(kv);
    expect(c.getViewModel().save).not.toBeNull();
    c.intent({ type: 'continue' });
    await vi.advanceTimersByTimeAsync(50);
    const strip = c.getViewModel().game!.strip;
    expect(strip.mode).toBe('occupy');
    expect(strip.line).toBe('Move into Siberia');
    expect(strip.count).toEqual({ control: 'stepper', value: 7, min: 3, max: 7 });
    expect(strip.buttons.map((b) => b.label)).toEqual(['Move 7']);
    expect(strip.track.disabled).toBe(true);
    expect(fb.highlights.arrow).toEqual({ from: 'ural', to: 'siberia', kind: 'attack' });
    // A board click never confirms: Move N does, and the new territory is the source.
    fb.click('yakutsk');
    await vi.advanceTimersByTimeAsync(50);
    expect(c.hooks.getState()!.phase.kind).toBe('occupy');
    c.intent({ type: 'button', id: 'move' });
    await until(() => c.hooks.isIdle(), 3000);
    const after = c.hooks.getState()!;
    expect(after.phase.kind).toBe('attack');
    expect(after.territories.siberia.armies).toBe(7);
    expect(c.hooks.ui().line).toBe('Attack from Siberia · click an enemy');
    c.dispose();
  });

  it('mid-reinforce restores the count and Undo (a whole placement back)', async () => {
    const kv = memoryKV();
    const s = fixture({ ural: [0, 6], ukraine: [0, 1] }, { kind: 'reinforce', remaining: 4, mustTrade: false, placed: { ural: 3 }, midTurn: false });
    saveWith(kv, s);
    const { c, fb } = make(kv);
    c.intent({ type: 'continue' });
    await vi.advanceTimersByTimeAsync(50);
    const g = c.getViewModel().game!;
    expect(g.strip.line).toBe('Place 4 more · click a territory');
    // Committed armies are in the counts already: no ghosts until something is picked.
    expect(fb.highlights.pending ?? {}).toEqual({});
    expect(g.strip.buttons.map((b) => b.id)).toEqual(['undo']);
    c.intent({ type: 'button', id: 'undo' });
    await vi.advanceTimersByTimeAsync(400);
    expect(c.hooks.getState()!.territories.ural.armies).toBe(3);
    c.dispose();
  });
});

describe('banners', () => {
  it('≤ 1 banner, only continent and elimination banners in an all-AI game, the line never empty', async () => {
    const { c } = make();
    c.hooks.setSpeed(1, 'fast');
    c.hooks.newGame({ players: AIS(4), seed: 77, dominationPercent: 60, turnLimit: 12 });
    let maxBanners = 0;
    let empty = 0;
    let samples = 0;
    const kinds = new Set<string>();
    const epitaphs = new Set<string>();
    for (let t = 0; t < 1_800_000 && c.getViewModel().screen === 'game'; t += 100) {
      const u = c.hooks.ui();
      maxBanners = Math.max(maxBanners, u.banners.length);
      const b = c.getViewModel().game?.banner;
      if (b) kinds.add(b.kind);
      if (b?.kind === 'elimination') epitaphs.add(b.line ?? '');
      if (!u.line) empty++;
      samples++;
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(c.getViewModel().screen).toBe('victory');
    expect(samples).toBeGreaterThan(50);
    expect(maxBanners).toBeLessThanOrEqual(1);
    // No humans: no turn banners, and continent captures (AI vs AI) only flare on the board.
    expect([...kinds].every((k) => k === 'elimination')).toBe(true);
    expect(empty).toBe(0);
    const v = c.getViewModel().victory!;
    expect(v.title).toMatch(/ holds the world$/);
    expect(v.subline).toMatch(/^Round \d+( of 12)? · \d+ territories$/);
    // The epitaph names who did it: 'AI2 · taken by AI1 · round 9'.
    for (const e of epitaphs) expect(e).toMatch(/^\S+ · taken by \S+ · round \d+$/);
    const out = c.getViewModel().game?.seats.filter((x) => x.eliminated) ?? [];
    for (const x of out) expect(x.out?.round).toBeGreaterThan(0);
    expect(v.standings[0].seat.id).toBe(v.winner.id);
    c.dispose();
  }, 60_000);
});

describe('end game now', () => {
  it('confirms with the leader, goes to Victory "Called in round N", clears the save', async () => {
    const { c, kv } = make();
    c.hooks.newGame({ players: [{ name: 'John', color: 'crimson', kind: 'human' }, ...AIS(3).slice(1)], seed: 3, dominationPercent: 70, turnLimit: null });
    await until(() => c.hooks.isIdle(), 60_000, 100);
    expect(kv.get(SAVE_KEY)).not.toBeNull();
    c.intent({ type: 'endGameNow' });
    const conf = c.getViewModel().game!.confirm!;
    expect(conf.text).toMatch(/^End the game now\? .+ wins on territories \(\d+ of 42\)\.$/);
    c.intent({ type: 'confirm', yes: true });
    const vm = c.getViewModel();
    expect(vm.screen).toBe('victory');
    expect(vm.victory!.subline).toMatch(/^Called in round \d+ · \d+ territories$/);
    expect(kv.get(SAVE_KEY)).toBeNull();
    c.dispose();
  });
});

// Keep the engine import used (the dynamic import above is for a helper).
void applyAction;
