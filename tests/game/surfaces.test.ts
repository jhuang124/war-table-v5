// v3 surfaces in the controller: the New game draft's extras (map, personalities, Neutral armies, Truces),
// a game on another map starting through a reload, diplomacy in the dock (an offer's Accept / Decline, the
// driver's own Truce), the seat strip's personality / grudge / neutral marks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioEngine } from '../../src/audio/types';
import type { BoardView } from '../../src/render/BoardView';
import { createController } from '../../src/game/controller';
import { addSeat, defaultDraft, draftToConfig, patchSeat, removeSeat, sanitizeDraft } from '../../src/game/presets';
import { memoryKV, SAVE_KEY, SETTINGS_KEY } from '../../src/game/storage';
import type { GameState } from '../../src/engine';
import { board as fixture } from './fixtures';

function quietBoard(): BoardView {
  const nop = () => undefined;
  return {
    syncState: nop,
    playEvent: () => Promise.resolve(),
    setAnimationSpeed: nop,
    skipAnimations: nop,
    setHighlights: nop,
    onTerritoryClick: nop,
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
  } as BoardView;
}

const audio = {
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

function make(kv = memoryKV(), extra: { bootMap?: string; reload?: () => void } = {}) {
  if (!kv.get(SETTINGS_KEY)) kv.set(SETTINGS_KEY, JSON.stringify({ hideCardsBetweenTurns: false, v: 5 }));
  const c = createController({ board: quietBoard(), audio, storage: kv, clock, dom: false, prefersReducedMotion: () => false, ...extra });
  return { c, kv };
}

async function settle(ms = 400): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

/** John (human) attacking; Priya (seat 2) an AI Turtle; diplomacy on. */
function diplomacyBoard(mut?: (s: GameState) => void): GameState {
  const s = fixture({ ural: [0, 8], siberia: [2, 2], ukraine: [0, 3], peru: [1, 3] }, { kind: 'attack' });
  s.players[2].personality = 'turtle';
  s.config = { ...s.config, diplomacy: true };
  mut?.(s);
  return s;
}

async function load(s: GameState, kv = memoryKV()) {
  kv.set(SAVE_KEY, JSON.stringify({ v: 1, savedAt: 0, state: s }));
  const m = make(kv);
  m.c.intent({ type: 'continue' });
  await settle();
  return m;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('New game draft extras (v3, presets.ts)', () => {
  it('a fresh table has three different AIs, Neutral armies and Truces on, classic', () => {
    const d = defaultDraft();
    expect(d.seats.map((s) => s.personality)).toEqual([undefined, 'turtle', 'opportunist', 'warlord']);
    expect(d.house.neutral).toBe(true);
    expect(d.house.truces).toBe(true);
    expect(d.mapId).toBe('classic');
  });

  it('sanitizeDraft keeps them (and fills a missing personality)', () => {
    const d = defaultDraft();
    d.seats[1].personality = 'warlord';
    const raw = JSON.parse(JSON.stringify({ ...d, mapId: 'true-world', house: { ...d.house, neutral: false } }));
    delete raw.seats[2].personality;
    delete raw.house.truces;
    const back = sanitizeDraft(raw);
    // seat 2 lost its personality: it takes the least used (Turtle; Warlord is used twice)
    expect(back.seats.map((s) => s.personality)).toEqual([undefined, 'warlord', 'turtle', 'warlord']);
    expect(back.mapId).toBe('true-world');
    expect(back.house.neutral).toBe(false);
    expect(back.house.truces).toBe(true);
    expect(sanitizeDraft({ ...raw, mapId: 'atlantis' }).mapId).toBe('classic');
  });

  it('a seat flipped to AI, or added, gets the least-used personality', () => {
    const d = patchSeat(defaultDraft(), 0, { kind: 'ai' });
    expect(d.seats[0].personality).toBe('turtle');
    const e = addSeat(removeSeat(defaultDraft(), 3));
    expect(e.seats[3].personality).toBe('warlord');
  });

  it('the config carries the map, diplomacy only with a human and a personality AI, neutral for two', () => {
    const d = defaultDraft();
    const c = draftToConfig({ ...d, mapId: 'true-world' }, 5);
    expect(c.mapId).toBe('true-world');
    expect(c.diplomacy).toBe(true);
    expect(c.players.filter((p) => p.kind === 'ai').map((p) => p.personality)).toEqual(['turtle', 'opportunist', 'warlord']);
    expect(draftToConfig({ ...d, house: { ...d.house, truces: false } }, 5).diplomacy).toBeUndefined();
    const allAi = { ...d, seats: d.seats.map((s) => ({ ...s, kind: 'ai' as const })) };
    expect(draftToConfig(allAi, 5).diplomacy).toBeUndefined();
    const two = removeSeat(removeSeat(d, 3), 2);
    expect(draftToConfig(two, 5).neutral).toBe(true);
    expect(draftToConfig({ ...two, house: { ...two.house, neutral: false } }, 5).neutral).toBeUndefined();
  });

  it('the New game view offers both maps and the three personalities', () => {
    const { c } = make();
    const ng = c.getViewModel().newGame;
    expect(ng.maps?.map((m) => m.id)).toEqual(['classic', 'true-world']);
    expect(ng.maps?.[1].seats).toBe('2–4 players');
    expect(ng.mapId).toBe('classic');
    expect(ng.personalities?.map((p) => p.name)).toEqual(['Turtle', 'Opportunist', 'Warlord']);
    c.intent({ type: 'map', id: 'true-world' });
    expect(c.getViewModel().newGame.mapId).toBe('true-world');
    c.intent({ type: 'seat', index: 0, patch: { kind: 'ai' } });
    // a fourth AI takes the least-used personality (all three are used once: the first, Turtle)
    expect(c.getViewModel().newGame.seats[0].personality).toBe('turtle');
    c.dispose();
  });
});

describe('a game on another map (v3)', () => {
  it('saves the new game and reloads onto its map; the reloaded page deals it', async () => {
    const kv = memoryKV();
    const reload = vi.fn();
    const a = make(kv, { bootMap: 'classic', reload });
    a.c.intent({ type: 'nav', screen: 'newGame' });
    a.c.intent({ type: 'map', id: 'true-world' });
    a.c.intent({ type: 'start' });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(a.c.hooks.getState()).toBeNull();
    const saved = JSON.parse(kv.get(SAVE_KEY)!);
    expect(saved.state.config.mapId).toBe('true-world');
    a.c.dispose();
    // the page comes back booted on True World (registry.activeMapId reads the save)
    const b = make(kv, { bootMap: 'true-world', reload });
    await settle(100);
    const s = b.c.hooks.getState();
    expect(s?.config.mapId).toBe('true-world');
    expect(b.c.getViewModel().screen).toBe('game');
    expect(reload).toHaveBeenCalledTimes(1);
    b.c.dispose();
  });

  it('a game on the booted map starts at once', () => {
    const reload = vi.fn();
    const { c } = make(memoryKV(), { bootMap: 'classic', reload });
    c.intent({ type: 'start' });
    expect(reload).not.toHaveBeenCalled();
    expect(c.hooks.getState()?.config.mapId).toBe('classic');
    c.dispose();
  });
});

describe('diplomacy in the dock (v3)', () => {
  it("an AI's offer (v4 A5): a secondary line with its reason and Decline / Accept as small words; it never takes the line or the gold; Accept answers", async () => {
    const s = diplomacyBoard((st) => {
      st.diplomacy = { truces: [], offers: [{ from: 2, to: 0, rounds: 3, kind: 'noAttack', turn: 8 }], proposedOn: { 2: 8 }, rebuffs: [] };
    });
    const { c } = await load(s);
    const u = c.hooks.ui();
    expect(u.offer?.text).toMatch(/^Priya proposes a truce with John · 3 rounds · you share a border in [A-Z][a-z]+( [A-Z][a-z]+)?$/);
    expect(u.offer?.buttons).toEqual(['Decline', 'Accept']);
    expect(u.line).not.toMatch(/truce/);
    expect(u.buttons).not.toContain('Accept');
    expect(u.gold).not.toBe('button:acceptTruce');
    expect(u.brass).not.toContain('Accept');
    c.intent({ type: 'button', id: 'acceptTruce' });
    await settle();
    const after = c.hooks.getState()!;
    expect(after.diplomacy?.offers.length).toBe(0);
    expect(after.diplomacy?.truces.map((t) => [t.from, t.to])).toEqual([[2, 0]]);
    expect(c.hooks.ledger().some((l) => l.kind === 'truce' && /^John accepts Priya's truce · until round \d+$/.test(l.text))).toBe(true);
    expect(c.hooks.ui().offer).toBeNull();
    c.dispose();
  });

  it('Decline turns it down', async () => {
    const s = diplomacyBoard((st) => {
      st.diplomacy = { truces: [], offers: [{ from: 2, to: 0, rounds: 3, kind: 'noAttack', turn: 8 }], proposedOn: {}, rebuffs: [] };
    });
    const { c } = await load(s);
    c.intent({ type: 'button', id: 'declineTruce' });
    await settle();
    expect(c.hooks.getState()!.diplomacy?.truces.length).toBe(0);
    expect(c.hooks.ledger().some((l) => l.text === "John turns down Priya's truce")).toBe(true);
    c.dispose();
  });

  it('Truce in Attack lights the seats that can take one; a lit ring proposes 3 rounds', async () => {
    const { c } = await load(diplomacyBoard());
    expect(c.hooks.ui().buttons).toEqual(['Truce']);
    expect(c.hooks.ui().gold).toBe('segment:attack');
    c.intent({ type: 'button', id: 'truce' });
    await settle(50);
    const seats = c.getViewModel().game!.seats;
    expect(seats.filter((x) => x.truceTarget).map((x) => x.seat.name)).toEqual(['Sam', 'Priya']);
    expect(c.hooks.ui().line).toBe('Offer a 3-round truce · click a seat');
    c.intent({ type: 'proposeTruce', to: 2 });
    await settle();
    const log = c.hooks.ledger().filter((l) => l.kind === 'truce').map((l) => l.text);
    expect(log[0]).toBe('John proposes a truce with Priya · 3 rounds');
    expect(log.length).toBe(2); // Priya answers at once (accepts or turns it down)
    expect(c.getViewModel().game!.seats.some((x) => x.truceTarget)).toBe(false);
    // one offer per turn: the word goes
    expect(c.hooks.ui().buttons).not.toContain('Truce');
    c.dispose();
  });

  it('no Truce word without diplomacy', async () => {
    const { c } = await load(diplomacyBoard((st) => (st.config = { ...st.config, diplomacy: false })));
    expect(c.hooks.ui().buttons).toEqual([]);
    c.dispose();
  });

  it('a seat handed to the AI keeps (or gets) a personality', async () => {
    const { c } = await load(diplomacyBoard());
    c.intent({ type: 'setController', player: 1, kind: 'ai', difficulty: 'normal' });
    await settle();
    const p = c.hooks.getState()!.players[1];
    expect(p.kind).toBe('ai');
    expect(['opportunist', 'warlord']).toContain(p.personality);
    c.dispose();
  });
});

describe('the seat strip (v3)', () => {
  it("an AI seat shows its personality and, at 2 or more, its strongest grudge", async () => {
    const { c } = await load(
      diplomacyBoard((st) => {
        st.players[2].grudges = { 0: 1.2, 1: 2.5 };
      }),
    );
    const priya = c.getViewModel().game!.seats[2];
    expect(priya.personality?.name).toBe('Turtle');
    expect(priya.grudge?.name).toBe('Sam');
    expect(c.getViewModel().game!.seats[0].personality).toBeUndefined();
    c.dispose();
  });

  it('a grudge under 2 stays hidden', async () => {
    const { c } = await load(diplomacyBoard((st) => (st.players[2].grudges = { 0: 1.9 })));
    expect(c.getViewModel().game!.seats[2].grudge ?? null).toBeNull();
    c.dispose();
  });

  it('the 2-player neutral seat is grey, flagged, never current, never ranked', async () => {
    const { c } = make();
    c.hooks.newGame({
      players: [
        { name: 'John', color: 'crimson', kind: 'human' },
        { name: 'Sam', color: 'cobalt', kind: 'human' },
      ],
      neutral: true,
      seed: 3,
    });
    await settle(3000);
    const s = c.hooks.getState()!;
    expect(s.players.length).toBe(3);
    expect(s.players[2].neutral).toBe(true);
    expect(s.players[2].color).toBe('neutral');
    const n = c.getViewModel().game!.seats[2];
    expect(n.neutral).toBe(true);
    expect(n.current).toBe(false);
    expect(n.seat.name).toBe('Neutral');
    c.dispose();
  });
});
