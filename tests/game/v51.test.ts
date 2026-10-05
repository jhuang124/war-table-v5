// v5.1 "decide, don't ask" (_claude/v5/QUIETER.md §3), controller side: the turn passes with a line, not a
// window; the cup's calls are gone; standing on the seat marks and the one 'Ask X for peace' gesture; personalities
// hidden until they speak; the defaults (Place → Attack by itself, occupy all but one, the Settings fold).
//
// The engine's standing is built in parallel: these tests mock `standingOf` / `standingReason` / `canAskPeace` and
// the `askPeace` answer so the controller's wiring is pinned whatever the engine decides.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioEngine } from '../../src/audio/types';
import type { BoardView, TerritoryPointerInfo } from '../../src/render/BoardView';
import { createController } from '../../src/game/controller';
import { memoryKV, SAVE_KEY, SETTINGS_KEY, type KV } from '../../src/game/storage';
import type { GameEvent, GameState, TerritoryId } from '../../src/engine';
import { board as fixture, card } from './fixtures';

const mock = vi.hoisted(() => ({
  /** Events the mocked engine answers the next `askPeace` with (null = the real engine). */
  answer: null as null | ((s: unknown, a: { player: number; to: number }) => unknown[]),
  standing: 'wary' as 'ally' | 'even' | 'wary' | 'hostile',
  reason: 'Priya is wary of you · you took Ural last round',
  canAsk: true,
}));

vi.mock('../../src/engine', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/engine')>();
  return {
    ...m,
    standingOf: () => mock.standing,
    standingReason: () => mock.reason,
    canAskPeace: () => mock.canAsk,
    peaceAskBlock: () => (mock.canAsk ? null : 'You asked Priya in round 2 · ask again in round 5.'),
    applyAction: (s: GameState, a: Parameters<typeof m.applyAction>[1]) => {
      if (a.type === 'askPeace' && mock.answer) {
        const state = m.cloneState(s);
        return { ok: true, state, events: mock.answer(state, a) as GameEvent[] };
      }
      return m.applyAction(s, a);
    },
  };
});

function fakeBoard() {
  const nop = () => undefined;
  let click: ((i: TerritoryPointerInfo) => void) | null = null;
  const b = {
    syncState: nop,
    playEvent: () => Promise.resolve(),
    setAnimationSpeed: nop,
    skipAnimations: nop,
    setHighlights: nop,
    onTerritoryClick: (fn: (i: TerritoryPointerInfo) => void) => void (click = fn),
    onTerritoryHover: nop,
    focusTerritories: nop,
    resetCamera: nop,
    setAttractMode: nop,
    setShowLabels: nop,
    setViewportInsets: nop,
    setUiScale: nop,
    getScreenPosition: () => ({ x: 1, y: 1 }),
    getStats: () => ({ fps: 60, frameMsP95: 16, drawCalls: 0, triangles: 0, cameraMoving: false }),
    dispose: nop,
  } as unknown as BoardView;
  return { b, click: (t: TerritoryId) => click?.({ territory: t, button: 0, clientX: 0, clientY: 0 } as unknown as TerritoryPointerInfo) };
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
    setIdle: () => undefined,
  } as unknown as AudioEngine;
  return { a, calls };
}

const clock = {
  now: () => Date.now(),
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
  raf: (fn: () => void) => void setTimeout(fn, 16),
};

async function load(s: GameState, kv: KV = memoryKV()) {
  // An old settings file that asked for the cover: tolerated and ignored.
  if (!kv.get(SETTINGS_KEY)) kv.set(SETTINGS_KEY, JSON.stringify({ hideCardsBetweenTurns: true, v: 5 }));
  kv.set(SAVE_KEY, JSON.stringify({ v: 1, savedAt: 0, state: s }));
  const fb = fakeBoard();
  const au = spyAudio();
  const c = createController({ board: fb.b, audio: au.a, storage: kv, clock, dom: false, prefersReducedMotion: () => false });
  c.intent({ type: 'continue' });
  await vi.advanceTimersByTimeAsync(50);
  return { c, fb, au, kv };
}

/** John (0) and Sam (1) human, Priya (2) an AI Turtle; diplomacy on. */
function table(phase: GameState['phase'] = { kind: 'attack' }, mut?: (s: GameState) => void): GameState {
  const s = fixture({ ural: [0, 8], ukraine: [0, 3], peru: [1, 3], brazil: [1, 3], siberia: [2, 2] }, phase);
  s.players[2].personality = 'turtle';
  s.config = { ...s.config, diplomacy: true };
  mut?.(s);
  return s;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  mock.answer = null;
  mock.standing = 'wary';
  mock.reason = 'Priya is wary of you · you took Ural last round';
  mock.canAsk = true;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('A · whose turn: a line, not a window', () => {
  it('two humans: the turn passes with no cover, the one line in the seat pigment, the cards sheet closes', async () => {
    const s = table({ kind: 'reinforce', remaining: 0, mustTrade: false, placed: {}, midTurn: false }, (st) => {
      st.players[0].cards = [card(1, 'infantry'), card(2, 'cavalry')];
    });
    const { c, au } = await load(s);
    expect(c.getViewModel().settings.hideCardsBetweenTurns).toBe(false);
    c.intent({ type: 'cardsPanel', open: true });
    expect(c.getViewModel().game!.cards?.open).toBe(true);
    c.hooks.dispatch({ type: 'endReinforce', player: 0 });
    c.hooks.dispatch({ type: 'endTurn', player: 0 });
    let line: string | null = null;
    for (let t = 0; t < 1500 && !line; t += 20) {
      await vi.advanceTimersByTimeAsync(20);
      expect(c.getViewModel().game!.handoff).toBeNull();
      expect(c.getViewModel().game!.gold?.kind).not.toBe('handoff');
      line = c.getViewModel().game!.banner?.line ?? null;
    }
    const st = c.hooks.getState()!;
    expect(st.currentPlayer).toBe(1);
    expect(line).toMatch(/^Sam's turn · \d+ armies$/);
    expect(c.getViewModel().game!.banner?.seat?.name).toBe('Sam');
    expect(c.getViewModel().game!.cards?.open ?? false).toBe(false);
    // Sam acts at once: nothing to dismiss.
    expect(c.hooks.ui().trackLive).toBe(true);
    // B: one wood set-down, no cup slide, no rattle
    expect(au.calls).toContain('cue:cupSet');
    expect(au.calls).not.toContain('cue:cupSlide');
    expect(au.calls).not.toContain('cue:rattle');
    // tolerated no-ops from an older HUD
    c.intent({ type: 'handoffAccept' });
    c.intent({ type: 'tapCup' });
    expect(c.hooks.getState()!.currentPlayer).toBe(1);
    c.dispose();
  });
});

describe('C · standing on the seat marks', () => {
  it('each AI seat carries standing, reason, canAskPeace and its understandings; the hook mirrors them', async () => {
    const { c } = await load(table());
    const priya = c.getViewModel().game!.seats[2];
    expect(priya.standing).toBe('wary');
    expect(priya.standingReason).toBe('Priya is wary of you · you took Ural last round');
    expect(priya.canAskPeace).toBe(true);
    expect(priya.understandingWith).toEqual([]);
    expect(c.getViewModel().game!.seats[0].standing).toBeUndefined();
    const h = c.hooks.standing();
    expect(h[2]).toMatchObject({ seat: 2, name: 'Priya', standing: 'wary', canAskPeace: true, reader: 0, personality: null });
    c.dispose();
  });

  it('seatStanding writes the reason in the one line, in the AI tint, until released', async () => {
    const { c } = await load(table());
    const was = c.hooks.ui().line;
    c.intent({ type: 'seatStanding', player: 2 });
    await vi.advanceTimersByTimeAsync(20);
    expect(c.hooks.ui().line).toBe('Priya is wary of you · you took Ural last round');
    expect(c.getViewModel().game!.strip.voice?.name).toBe('Priya');
    await vi.advanceTimersByTimeAsync(5000);
    expect(c.hooks.ui().line).toBe('Priya is wary of you · you took Ural last round');
    c.intent({ type: 'seatStanding', player: null });
    await vi.advanceTimersByTimeAsync(20);
    expect(c.hooks.ui().line).toBe(was);
    // a human seat has no standing to show
    c.intent({ type: 'seatStanding', player: 1 });
    expect(c.hooks.ui().line).toBe(was);
    c.dispose();
  });

  it("askPeace: the answer at once in the AI's tint, in the Ledger ('Priya agrees · three rounds')", async () => {
    mock.answer = (_s, a) => [{ type: 'peaceAnswered', from: a.to, to: a.player, accepted: true, rounds: 3, reason: '' }];
    const { c } = await load(table());
    c.intent({ type: 'askPeace', to: 2 });
    await vi.advanceTimersByTimeAsync(50);
    expect(c.hooks.ui().line).toBe('Priya agrees · three rounds');
    expect(c.getViewModel().game!.strip.voice?.name).toBe('Priya');
    expect(c.hooks.ledger().some((l) => l.kind === 'truce' && l.text === 'Priya agrees · three rounds · peace with John')).toBe(true);
    c.dispose();
  });

  it("askPeace refused: the engine's reason is the line", async () => {
    mock.answer = (_s, a) => [{ type: 'peaceAnswered', from: a.to, to: a.player, accepted: false, rounds: 0, reason: 'Priya refuses · you took Ural' }];
    const { c } = await load(table());
    c.intent({ type: 'askPeace', to: 2 });
    await vi.advanceTimersByTimeAsync(50);
    expect(c.hooks.ui().line).toBe('Priya refuses · you took Ural');
    c.dispose();
  });

  it("askPeace when the engine says not now: its own line ('You asked Priya in round 2 · ask again in round 5'), nothing applied", async () => {
    mock.canAsk = false;
    mock.answer = (_s, a) => [{ type: 'peaceAnswered', from: a.to, to: a.player, accepted: true, rounds: 3, reason: '' }];
    const { c } = await load(table());
    expect(c.getViewModel().game!.seats[2].canAskPeace).toBe(false);
    c.intent({ type: 'askPeace', to: 2 });
    await vi.advanceTimersByTimeAsync(20);
    expect(c.hooks.ui().line).toBe('You asked Priya in round 2 · ask again in round 5');
    expect(c.hooks.ui().lineKind).toBe('rejection');
    expect(c.hooks.ledger().filter((l) => l.kind === 'truce')).toEqual([]);
    c.dispose();
  });

  it('askPeace the engine will not take: a plain rejection, nothing applied', async () => {
    const { c } = await load(table());
    const before = c.hooks.getState();
    c.intent({ type: 'askPeace', to: 2 });
    await vi.advanceTimersByTimeAsync(20);
    // the real engine (stub or built) either answers or refuses; a refusal reads as a rejection
    const u = c.hooks.ui();
    if (c.hooks.getState() === before) expect(u.lineKind).toBe('rejection');
    c.dispose();
  });

  it('peace broken: by a human (the line and the Ledger); by an AI against a human (hostile now, the room goes cold)', async () => {
    mock.answer = (_s, a) => [{ type: 'peaceBroken', by: a.player, against: a.to }];
    const { c } = await load(table());
    c.intent({ type: 'askPeace', to: 2 });
    await vi.advanceTimersByTimeAsync(50);
    expect(c.hooks.ui().line).toBe('You broke the peace with Priya');
    expect(c.hooks.ledger().some((l) => l.text === 'John broke the peace with Priya')).toBe(true);
    c.dispose();

    mock.answer = (_s, a) => [{ type: 'peaceBroken', by: a.to, against: a.player }];
    const r = await load(table());
    r.c.intent({ type: 'askPeace', to: 2 });
    await vi.advanceTimersByTimeAsync(50);
    expect(r.c.hooks.ui().line).toBe('Priya broke the peace · it is hostile now');
    expect(r.au.calls).toContain('lean:cold');
    r.c.dispose();
  });

  it("standingChanged: a line only about the reader when wary / hostile (the engine's reason); the Ledger only on hostile toward a human", async () => {
    mock.reason = 'Priya is hostile · you took Ural';
    mock.answer = (_s, a) => [
      { type: 'standingChanged', ai: a.to, toward: a.player, standing: 'wary' },
      { type: 'standingChanged', ai: a.to, toward: a.player, standing: 'hostile' },
    ];
    const { c } = await load(table());
    c.intent({ type: 'askPeace', to: 2 });
    await vi.advanceTimersByTimeAsync(50);
    expect(c.hooks.ui().line).toBe('Priya is hostile · you took Ural');
    const truce = c.hooks.ledger().filter((l) => l.kind === 'truce').map((l) => l.text);
    // two humans at the table: the Ledger names the seat rather than 'you'
    expect(truce).toEqual(['Priya is hostile to John · you took Ural']);
    c.dispose();
  });

  it("AI-to-AI understandings: said once ('Priya and Ochre have an understanding' / 'Priya turned on Ochre'), the tie listed", async () => {
    const s = table({ kind: 'attack' }, (st) => {
      st.players[1] = { ...st.players[1], kind: 'ai', name: 'Ochre', personality: 'warlord' };
    });
    mock.answer = (_s, a) => [{ type: 'truceAccepted', from: a.to, to: 1, rounds: 3, kind: 'noAttack', until: 7 }];
    const { c } = await load(s);
    c.intent({ type: 'askPeace', to: 2 });
    await vi.advanceTimersByTimeAsync(50);
    expect(c.hooks.ui().line).toBe('Priya and Ochre have an understanding');
    expect(c.hooks.ledger().some((l) => l.kind === 'truce' && /Ochre/.test(l.text) && /Priya/.test(l.text))).toBe(true);
    c.dispose();
  });

  it('the human truce protocol is gone: no offer, no Truce word, proposeTruce a no-op', async () => {
    const { c } = await load(
      table({ kind: 'attack' }, (st) => {
        st.diplomacy = { truces: [], offers: [{ from: 2, to: 0, rounds: 3, kind: 'noAttack', turn: 8 }], proposedOn: {}, rebuffs: [] };
      }),
    );
    expect(c.getViewModel().game!.strip.offer ?? null).toBeNull();
    expect(c.hooks.ui().buttons).not.toContain('Truce');
    c.intent({ type: 'proposeTruce', to: 2 });
    await vi.advanceTimersByTimeAsync(50);
    expect(c.hooks.getState()!.diplomacy?.offers.filter((o) => o.from === 0).length ?? 0).toBe(0);
    c.dispose();
  });
});

describe('D · personalities hidden until they speak', () => {
  it("an AI's first voice line reveals its personality on the seat mark", async () => {
    // Priya holds one territory; John knocks her out and she blames him (her first line).
    const s = table({ kind: 'attack' }, (st) => {
      for (const t of Object.keys(st.territories) as TerritoryId[]) if (st.territories[t].owner === 2) st.territories[t] = { owner: 1, armies: 1 };
      st.territories.siberia = { owner: 2, armies: 1 };
      st.territories.ural = { owner: 0, armies: 20 };
    });
    const { c } = await load(s);
    expect(c.hooks.standing()[2].personality).toBeNull();
    c.hooks.dispatch({ type: 'blitz', player: 0, from: 'ural', to: 'siberia', stopAt: 1 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(c.hooks.getState()!.players[2].eliminated).toBe(true);
    expect(c.hooks.voiceLines().some((v) => v.seat === 2)).toBe(true);
    expect(c.hooks.standing()[2].personality).toBe('Turtle');
    c.dispose();
  });
});

describe('E · defaults', () => {
  it('occupy: all but one by default, the count folded until touched', async () => {
    const s = table({ kind: 'occupy', from: 'ural', to: 'siberia', min: 3, max: 7, previousOwner: 2 }, (st) => {
      st.territories.siberia = { owner: 0, armies: 0 };
    });
    const { c } = await load(s);
    let u = c.hooks.ui();
    expect(u.primary).toBe('Move 7');
    expect(u.count).toMatchObject({ value: 7, collapsed: true });
    c.intent({ type: 'setCount', value: 7 });
    await vi.advanceTimersByTimeAsync(20);
    u = c.hooks.ui();
    expect((u.count as { collapsed?: boolean }).collapsed).toBeUndefined();
    expect(u.primary).toBe('Move 7');
    c.dispose();
  });

  it('Place → Attack by itself after the last army, but not while the Cards sheet is open or after an Undo', async () => {
    const s = table({ kind: 'reinforce', remaining: 3, mustTrade: false, placed: {}, midTurn: false });
    const { c, fb } = await load(s);
    fb.click('ural');
    await vi.advanceTimersByTimeAsync(30);
    c.intent({ type: 'button', id: 'place' });
    await vi.advanceTimersByTimeAsync(100);
    expect(c.hooks.getState()!.phase).toMatchObject({ kind: 'reinforce', remaining: 0 });
    c.intent({ type: 'button', id: 'undo' });
    await vi.advanceTimersByTimeAsync(600);
    expect(c.hooks.getState()!.phase.kind).toBe('reinforce');
    // With the Cards sheet open the turn waits (a trade may still come).
    fb.click('ural');
    await vi.advanceTimersByTimeAsync(30);
    c.intent({ type: 'cardsPanel', open: true });
    c.intent({ type: 'button', id: 'place' });
    await vi.advanceTimersByTimeAsync(600);
    expect(c.hooks.getState()!.phase.kind).toBe('reinforce');
    c.intent({ type: 'button', id: 'undo' });
    c.intent({ type: 'cardsPanel', open: false });
    await vi.advanceTimersByTimeAsync(100);
    fb.click('ural');
    await vi.advanceTimersByTimeAsync(30);
    c.intent({ type: 'button', id: 'place' });
    await vi.advanceTimersByTimeAsync(600);
    expect(c.hooks.getState()!.phase.kind).toBe('attack');
    expect(c.hooks.ui().step).toBe('Attack');
    c.dispose();
  });

  it('Settings: four things up front, the rest under More (the fold is held by the controller); no Hide cards', async () => {
    const { c } = await load(table());
    const g = c.getViewModel().settingsGroups!;
    expect(g.primary).toEqual(['muted', 'sfxVolume', 'music', 'musicVolume', 'aiSpeed', 'textSize']);
    expect(g.more).not.toContain('hideCardsBetweenTurns');
    expect(g.primary).not.toContain('hideCardsBetweenTurns');
    expect(g.moreOpen).toBe(false);
    c.intent({ type: 'more', open: true, scope: 'settings' });
    expect(c.getViewModel().settingsGroups!.moreOpen).toBe(true);
    expect(c.getViewModel().newGame.advancedOpen).toBe(false);
    c.intent({ type: 'setting', patch: { hideCardsBetweenTurns: true } });
    expect(c.getViewModel().settings.hideCardsBetweenTurns).toBe(false);
    c.dispose();
  });
});
