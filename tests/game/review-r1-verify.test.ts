// Review round 1, verifier, carried through the simplify pass: the seat hand-off (R1-22, now in
// Settings → Seats), Esc backing out one level at a time, and the occupy strip.

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

describe('R1-22 seat hand-off (Settings → Seats)', () => {
  it('offers a human seat to the AI, plays it, and gives it back', async () => {
    const s = fixture({ ural: [0, 5], ukraine: [0, 3], alaska: [1, 2] }, { kind: 'attack' });
    const { c } = await resume(s);
    const action = (id: number) => c.getViewModel().game!.seatActions.find((a) => a.seat.id === id) ?? null;
    expect(action(0)?.label).toBe('Let the AI play John');
    expect(action(2)).toBeNull(); // started as AI
    c.intent({ type: 'overlay', overlay: 'settings' });
    c.intent(action(0)!.intent);
    await vi.advanceTimersByTimeAsync(100);
    expect(c.hooks.getState()!.players[0].kind).toBe('ai');
    expect(action(0)?.label).toBe('John takes the seat back');
    // A sheet is open: the AI waits. Close it and it plays John's turn to the next seat.
    expect(c.hooks.getState()!.currentPlayer).toBe(0);
    c.intent({ type: 'overlay', overlay: null });
    expect(await until(() => c.hooks.getState()!.currentPlayer !== 0, 30000)).toBe(true);
    c.intent(action(0)!.intent);
    await until(() => c.hooks.getState()!.players[0].kind === 'human', 30000);
    expect(c.hooks.getState()!.players[0].kind).toBe('human');
    c.dispose();
  });
});

describe('Esc backs out one level at a time, then opens the menu', () => {
  it('target → source → nothing → menu', async () => {
    const s = fixture({ ural: [0, 5], ukraine: [0, 1] }, { kind: 'attack' });
    const { c, fb } = await resume(s);
    fb.click('siberia'); // target-first: armed from Ural
    await vi.advanceTimersByTimeAsync(30);
    expect(c.hooks.ui().buttons).toEqual(['Roll', 'Blitz']);
    c.handleKey('Escape');
    expect(c.hooks.ui().line).toBe('Attack from Ural · click an enemy');
    c.handleKey('Escape');
    expect(c.hooks.ui().line).toBe('Click an enemy territory to attack');
    // Nothing armed: the action zone is empty; the track carries Fortify and End turn.
    expect(c.hooks.ui().buttons).toEqual([]);
    expect(c.hooks.ui().track).toEqual(['done:place', 'current:attack', 'eligible:fortify', 'eligible:endTurn']);
    c.handleKey('Escape');
    expect(c.getViewModel().overlay).toBe('pause');
    c.dispose();
  });
});

describe('occupy: one count control and Move N, nothing else', () => {
  it('the strip has the slider (> 6 options), the one button; the line shows the totals once the count moves', async () => {
    const s = fixture({ greenland: [0, 10], ontario: [0, 0] }, { kind: 'occupy', from: 'greenland', to: 'ontario', min: 3, max: 9, previousOwner: 2 });
    s.conqueredThisTurn = true;
    const { c } = await resume(s);
    const strip = c.getViewModel().game!.strip;
    expect(strip.line).toBe('Move into Ontario');
    expect(strip.count).toEqual({ control: 'slider', value: 9, min: 3, max: 9, collapsed: true });
    expect(strip.buttons).toEqual([{ id: 'move', label: 'Move 9', primary: true }]);
    // Mandatory: the track is visibly disabled and explains itself.
    expect(strip.track.disabled).toBe(true);
    c.intent({ type: 'track', seg: 'endTurn' });
    expect(c.hooks.ui().line).toBe('Finish moving armies in first');
    c.intent({ type: 'setCount', value: 4 });
    await vi.advanceTimersByTimeAsync(20);
    expect(c.hooks.ui().primary).toBe('Move 4');
    expect(c.hooks.ui().line).toBe('Greenland 6 · Ontario 4');
    c.dispose();
  });
});
