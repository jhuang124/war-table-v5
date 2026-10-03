// Review round 1 regressions (controller side): each test reproduces the reviewer's observation with the
// fake board + modelled 1× durations, then checks it's gone.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameEvent, GameState, TerritoryId } from '../../src/engine';
import type { AudioEngine } from '../../src/audio/types';
import type { BoardView, PlayEventOptions, TerritoryPointerInfo } from '../../src/render/BoardView';
import { createController } from '../../src/game/controller';
import { memoryKV, SAVE_KEY } from '../../src/game/storage';
import { eventDurationMs, scaledDuration } from '../../src/game/timingModel';
import { board as fixture } from './fixtures';

function fakeBoard() {
  let speed = 1;
  const pending = new Set<() => void>();
  let click: ((i: TerritoryPointerInfo) => void) | null = null;
  const b: BoardView = {
    syncState: () => undefined,
    playEvent(ev: GameEvent, _after: GameState, opts?: PlayEventOptions) {
      const ms = scaledDuration(eventDurationMs(ev, opts), speed);
      if (ms <= 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const done = () => {
          pending.delete(done);
          clearTimeout(h);
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
    setHighlights: () => undefined,
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
    click: (t: TerritoryId, button = 0) =>
      click!({ territory: t, clientX: 0, clientY: 0, shiftKey: false, altKey: false, metaKey: false, button }),
  };
}

const silentAudio = {
  unlock: () => undefined,
  play: () => undefined,
  setVolume: () => undefined,
  setMuted: () => undefined,
  setMusic: () => undefined,
  setMusicVolume: () => undefined,
  stopAll: () => undefined,
  isUnlocked: () => false,
  stats: () => ({}),
  dispose: () => undefined,
} as unknown as AudioEngine;

const clock = {
  now: () => Date.now(),
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
  raf: (fn: () => void) => void setTimeout(fn, 16),
};

async function until(pred: () => boolean, maxMs: number, step = 20): Promise<boolean> {
  for (let t = 0; t < maxMs; t += step) {
    if (pred()) return true;
    await vi.advanceTimersByTimeAsync(step);
  }
  return pred();
}

/** Resume a hand-set board (John = seat 0, human; Sam human; Priya AI owns the rest). */
async function resume(s: GameState) {
  const kv = memoryKV();
  kv.set(SAVE_KEY, JSON.stringify({ v: 1, savedAt: 0, state: s }));
  const fb = fakeBoard();
  const c = createController({ board: fb.board, audio: silentAudio, storage: kv, clock, dom: false, prefersReducedMotion: () => false });
  c.intent({ type: 'continue' });
  await vi.advanceTimersByTimeAsync(50);
  return { c, fb };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('R1-02 / ROUND2 §B occupy: board clicks never confirm; Move N does, then the chain', () => {
  const occupyBoard = () =>
    fixture({ greenland: [0, 10], ontario: [0, 0] }, { kind: 'occupy', from: 'greenland', to: 'ontario', min: 3, max: 9, previousOwner: 2 });

  it('a board click during occupy is refused with the reason; the state does not move', async () => {
    const { c, fb } = await resume(occupyBoard());
    expect(c.getViewModel().game!.strip.count!.value).toBe(9); // the smart default is max here
    for (const t of ['iceland', 'greenland', 'ontario', 'alberta'] as const) {
      fb.click(t);
      await vi.advanceTimersByTimeAsync(20);
      expect(c.hooks.getState()!.phase.kind).toBe('occupy');
    }
    expect(c.hooks.ui().line).toBe('Finish moving armies into Ontario first');
    c.dispose();
  });

  it('Move 3 keeps the stack home; the chain selects Ontario if it can attack, else Greenland', async () => {
    const { c } = await resume(occupyBoard());
    c.intent({ type: 'setCount', value: 3 });
    c.intent({ type: 'button', id: 'move' });
    await until(() => c.hooks.isIdle(), 4000);
    const s = c.hooks.getState()!;
    expect(s.phase.kind).toBe('attack');
    expect(s.territories.ontario.armies).toBe(3);
    expect(s.territories.greenland.armies).toBe(7);
    expect(c.hooks.ui().line).toBe('Attack from Ontario · click an enemy');
    c.dispose();
  });

  it('Move 9 moves the default count in', async () => {
    const { c } = await resume(occupyBoard());
    c.intent({ type: 'button', id: 'move' });
    await until(() => c.hooks.isIdle(), 4000);
    expect(c.hooks.getState()!.territories.ontario.armies).toBe(9);
    c.dispose();
  });
});

describe('R1-05 / R1-11 the tray header and the line across a conquest', () => {
  it('never shows one owner on both sides, and the line never describes a half-moved board', async () => {
    // New Guinea 3 → Indonesia 1: one roll of 2 dice conquers, min = max = 2 auto-occupies, then chains.
    const s = fixture({ new_guinea: [0, 3], western_australia: [0, 1], eastern_australia: [0, 1] }, { kind: 'attack' });
    let conquered = false;
    for (let seed = 1; seed < 400 && !conquered; seed++) {
      s.rng = seed;
      const { applyAction } = await import('../../src/engine');
      const r = applyAction(s, { type: 'attack', player: 0, from: 'new_guinea', to: 'indonesia', dice: 2 });
      conquered = r.ok && r.state.territories.indonesia.owner === 0;
    }
    expect(conquered).toBe(true);
    const { c, fb } = await resume(s);
    fb.click('indonesia'); // arm
    await vi.advanceTimersByTimeAsync(30);
    expect(c.hooks.ui().line).toMatch(/^New Guinea → Indonesia · \d+% · [a-z ]+( · .+)?$/);
    fb.click('indonesia'); // the armed target again: still armed, nothing rolls
    await vi.advanceTimersByTimeAsync(30);
    expect(c.hooks.getState()!.territories.indonesia.owner).not.toBe(0);
    c.intent({ type: 'button', id: 'roll' }); // roll once
    const headers = new Set<string>();
    const lines = new Set<string>();
    let sameOwner = 0;
    for (let t = 0; t < 4000; t += 20) {
      const u = c.hooks.ui();
      const b = c.getViewModel().game?.battle;
      if (b && b.attacker.seat.id === b.defender.seat.id) sameOwner++;
      if (u.battle) headers.add(u.battle.header);
      lines.add(u.line);
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(sameOwner).toBe(0);
    expect([...headers].some((x) => x === 'NEW GUINEA 3 vs INDONESIA 0' || x === 'Indonesia captured')).toBe(true);
    expect([...headers]).toContain('Indonesia captured');
    expect([...lines].some((l) => /from New Guinea · \d/.test(l) && /New Guinea \(1\)/.test(l))).toBe(false);
    // v4 A5: an auto-occupy says what moved in ('You took Indonesia · 2 armies move in').
    expect([...lines].some((l) => /^You took Indonesia( · (1 army moves|\d+ armies move) in)?$/.test(l))).toBe(true);
    expect(c.hooks.ui().line).toBe('Attack from Indonesia · click an enemy');
    c.dispose();
  });
});

describe('R1-14 a successful input clears a stale rejection (setup: pick · Place · Undo · Done)', () => {
  it('a refused click after "All 3 placed", then Undo restores the live line', async () => {
    const s = fixture({ ural: [0, 1], ukraine: [0, 1] }, { kind: 'setup-place', toPlace: 3 });
    s.round = 0;
    const { c, fb } = await resume(s);
    expect(c.hooks.ui().line).toBe('Place 3 armies · click a territory');
    fb.click('ural');
    await vi.advanceTimersByTimeAsync(20);
    expect(c.hooks.ui().line).toBe('Place on Ural');
    expect(c.hooks.ui().primary).toBe('Place 3');
    c.intent({ type: 'setCount', value: 2 });
    c.intent({ type: 'button', id: 'place' });
    await vi.advanceTimersByTimeAsync(20);
    expect(c.hooks.ui().line).toBe('Place on Ural');
    expect(c.hooks.ui().primary).toBe('Place 1');
    c.intent({ type: 'button', id: 'place' });
    await vi.advanceTimersByTimeAsync(20);
    expect(c.hooks.ui().line).toBe('All 3 placed · click Done');
    expect(c.hooks.ui().buttons).toEqual(['Undo']);
    expect(c.hooks.ui().track).toEqual(['current:setup', 'eligible:done']);
    expect(c.hooks.ui().brass).toEqual(['Done']);
    // Staging never touches the engine.
    expect(c.hooks.getState()!.territories.ural.armies).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    fb.click('ural');
    await vi.advanceTimersByTimeAsync(20);
    expect(c.hooks.ui().line).toBe('All 3 placed · click Done');
    c.intent({ type: 'button', id: 'undo' });
    await vi.advanceTimersByTimeAsync(20);
    expect(c.hooks.ui().line).toBe('Place 1 more · click a territory');
    expect(c.hooks.ui().buttons).toEqual(['Undo']);
    // Done is locked until everything is placed, and says why.
    c.intent({ type: 'track', seg: 'done' });
    await vi.advanceTimersByTimeAsync(20);
    expect(c.hooks.ui().line).toBe('Place your 1 army first');
    fb.click('ukraine');
    c.intent({ type: 'button', id: 'place' });
    c.intent({ type: 'track', seg: 'done' });
    await until(() => c.hooks.isIdle(), 4000);
    // Done commits the staged armies to the engine (then setup moves on).
    expect(c.hooks.getState()!.territories.ural.armies + c.hooks.getState()!.territories.ukraine.armies).toBeGreaterThanOrEqual(5);
    c.dispose();
  });
});

describe('ROUND2 §A Enter is the one brass thing', () => {
  it('occupy: Enter moves; attack with targets left: nothing brass, Enter does nothing; Fortify: Enter ends the turn', async () => {
    const s = fixture({ greenland: [0, 10], ontario: [0, 0] }, { kind: 'occupy', from: 'greenland', to: 'ontario', min: 3, max: 9, previousOwner: 2 });
    const { c } = await resume(s);
    expect(c.hooks.ui().brass).toEqual(['Move 9']);
    c.handleKey('Enter');
    await until(() => c.hooks.isIdle(), 4000);
    expect(c.hooks.getState()!.phase.kind).toBe('attack');
    // Nothing to commit: the one gold falls back to the current segment (INK B2.1), which Enter never presses.
    expect(c.hooks.ui().brass).toEqual(['Attack']);
    expect(c.hooks.ui().recommended).toBeNull();
    c.handleKey('Escape'); // clear the chained source
    c.handleKey('Enter');
    await vi.advanceTimersByTimeAsync(100);
    expect(c.hooks.getState()!.phase.kind).toBe('attack');
    c.intent({ type: 'track', seg: 'fortify' });
    await until(() => c.hooks.isIdle(), 4000);
    expect(c.hooks.getState()!.phase.kind).toBe('fortify');
    expect(c.hooks.ui().brass).toEqual(['End turn']);
    c.handleKey('Enter');
    await until(() => c.hooks.getState()!.currentPlayer !== 0, 4000);
    expect(c.hooks.getState()!.currentPlayer).not.toBe(0);
    c.dispose();
  });
});

describe('R1-23 AI turns mid-game at watch (v4: the readable reel)', () => {
  it('1 human + 3 AI, rounds 4–7: median ≤ 6 s, p95 ≤ 12 s, no AI fight in full', async () => {
    const { chooseAiAction } = await import('../../src/engine');
    const late: number[] = [];
    const all: number[] = [];
    let maxFull = 0;
    for (const seed of [5, 6, 7, 8]) {
      const fb = fakeBoard();
      const played: { ev: GameEvent; opts?: PlayEventOptions }[] = [];
      const inner = fb.board.playEvent.bind(fb.board);
      fb.board.playEvent = (ev, after, opts) => {
        played.push({ ev, opts });
        return inner(ev, after, opts);
      };
      const c = createController({ board: fb.board, audio: silentAudio, storage: memoryKV(), clock, dom: false, prefersReducedMotion: () => false });
      c.hooks.newGame({
        players: [
          { name: 'John', color: 'crimson', kind: 'human' },
          { name: 'A', color: 'cobalt', kind: 'ai', difficulty: 'normal' },
          { name: 'B', color: 'amber', kind: 'ai', difficulty: 'normal' },
          { name: 'C', color: 'rose', kind: 'ai', difficulty: 'normal' },
        ],
        seed,
        dominationPercent: 70,
        turnLimit: null,
      });
      const roundAt: number[] = [];
      let lastTurns = 0;
      for (let t = 0; t < 1_500_000 && (c.hooks.getState()?.round ?? 0) <= 7 && c.hooks.getState()?.phase.kind !== 'game-over'; t += 100) {
        const s = c.hooks.getState();
        if (s && s.phase.kind !== 'game-over' && c.hooks.isIdle() && s.players[s.currentPlayer].kind === 'human') {
          c.hooks.dispatch(chooseAiAction(s, s.currentPlayer));
        }
        const n = c.hooks.metrics().turns.length;
        if (n > lastTurns) {
          for (let i = lastTurns; i < n; i++) roundAt.push(s?.round ?? 0);
          lastTurns = n;
        }
        await vi.advanceTimersByTimeAsync(100);
      }
      const turns = c.hooks.metrics().turns;
      turns.forEach((tt, i) => {
        if (tt.kind !== 'ai') return;
        all.push(tt.ms);
        if ((roundAt[i] ?? 0) >= 4) late.push(tt.ms);
      });
      // Full-dice engagements vs the human per AI turn.
      let cur = 0;
      let lastPair = '';
      for (const p of played) {
        if (p.ev.type === 'turnStarted') {
          cur = 0;
          lastPair = '';
        }
        if (p.ev.type === 'diceRolled' && p.opts?.style === 'full' && p.ev.player !== 0) {
          const key = `${p.ev.from}>${p.ev.to}`;
          if (key !== lastPair) cur++;
          lastPair = key;
          maxFull = Math.max(maxFull, cur);
        }
      }
      c.dispose();
    }
    const q = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
    process.stdout.write(
      `[R1-23] AI turns n=${all.length} median ${q(all, 0.5)} p95 ${q(all, 0.95)} | rounds 4+: n=${late.length} median ${q(late, 0.5)} p95 ${q(late, 0.95)} max ${Math.max(...late)} | max full fights/turn ${maxFull}\n`,
    );
    expect(late.length).toBeGreaterThan(10);
    // v4 A1 (sitting 2026-10-03): no AI fight plays in full; the readable reel stays in the round budget
    // (median ≤ 6 s, p95 ≤ 12 s at Watch; v3 measured median 5.0 s, p95 9.1 s here).
    expect(q(late, 0.5)).toBeLessThanOrEqual(6000);
    expect(q(all, 0.5)).toBeLessThanOrEqual(6000);
    expect(q(all, 0.95)).toBeLessThanOrEqual(12000);
    expect(maxFull).toBe(0);
  }, 180_000);
});

describe('R1-13 the random deal never shows claim copy', () => {
  it('Place your own, human first: line 1 says Dealing while the deal plays, and nothing glows', async () => {
    const fb = fakeBoard();
    let hl: unknown = null;
    fb.board.setHighlights = (h) => void (hl = h);
    const c = createController({ board: fb.board, audio: silentAudio, storage: memoryKV(), clock, dom: false, prefersReducedMotion: () => false });
    c.hooks.newGame({
      players: [
        { name: 'John', color: 'crimson', kind: 'human' },
        { name: 'Sam', color: 'cobalt', kind: 'human' },
      ],
      seed: 4,
      setupMode: 'random',
      initialPlacement: 'manual',
      setupBatch: 10,
    });
    const lines = new Set<string>();
    let glowed = false;
    for (let t = 0; t < 3000 && !c.hooks.isIdle(); t += 20) {
      lines.add(c.hooks.ui().line);
      if (c.hooks.getState() && c.getViewModel().game && (hl as { selectable?: string[] })?.selectable?.length === 42) glowed = true;
      await vi.advanceTimersByTimeAsync(20);
    }
    expect([...lines].some((l) => /^Claim a territory/.test(l))).toBe(false);
    expect([...lines]).toContain('Dealing territories');
    expect(glowed).toBe(false);
    expect(c.hooks.ui().line).toMatch(/^Place 10 armies/);
    c.dispose();
  });
});

describe('R1-15 upsets', () => {
  it('upsets never raise a banner; they note the log line instead', async () => {
    const c = createController({ board: fakeBoard().board, audio: silentAudio, storage: memoryKV(), clock, dom: false, prefersReducedMotion: () => false });
    c.hooks.setSpeed(1, 'fast');
    c.hooks.newGame({
      players: (['crimson', 'cobalt', 'amber', 'rose'] as const).map((color, i) => ({ name: `AI${i}`, color, kind: 'ai' as const, difficulty: 'normal' as const })),
      seed: 31,
      dominationPercent: 60,
      turnLimit: 10,
    });
    const titles = new Set<string>();
    for (let t = 0; t < 1_800_000 && c.getViewModel().screen === 'game'; t += 100) {
      for (const b of c.hooks.ui().banners) titles.add(b);
      await vi.advanceTimersByTimeAsync(100);
    }
    const log = (c.getViewModel().game?.log ?? []).map((l) => l.text);
    expect([...titles].some((b) => /HELD|AGAINST THE ODDS/.test(b))).toBe(false);
    expect(log.some((l) => /an upset \(|against the odds \(/.test(l))).toBe(true);
    c.dispose();
  }, 60_000);
});
