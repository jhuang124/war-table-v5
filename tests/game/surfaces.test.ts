// v3 surfaces in the controller: the New game draft's extras (map, personalities, Neutral armies, Truces),
// a game on another map starting through a reload, v5.1 standing in place of the truce protocol, the seat
// strip's personality (hidden until spoken) / grudge / neutral marks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioEngine } from '../../src/audio/types';
import type { BoardView } from '../../src/render/BoardView';
import { createController } from '../../src/game/controller';
import { addSeat, defaultDraft, draftToConfig, patchSeat, removeSeat, sanitizeDraft } from '../../src/game/presets';
import { memoryKV, SAVE_KEY, SETTINGS_KEY, UI_KEY } from '../../src/game/storage';
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

describe('New game draft extras (v3, presets.ts; v5.1 D three decisions)', () => {
  it('a fresh table is one human and three AIs, personalities random (unset), house rules off, standing on, classic', () => {
    const d = defaultDraft();
    expect(d.seats.map((s) => s.kind)).toEqual(['human', 'ai', 'ai', 'ai']);
    expect(d.seats.map((s) => s.personality)).toEqual([undefined, undefined, undefined, undefined]);
    expect(d.seats.every((s) => s.difficulty === 'normal')).toBe(true);
    expect(d.house.neutral).toBe(false);
    expect(d.house.missions).toBe(false);
    expect(d.house.truces).toBe(true);
    expect(d.setup).toBe('quickDeal');
    expect(d.mapId).toBe('classic');
  });

  it('sanitizeDraft keeps a chosen personality and never fills a missing one', () => {
    const d = defaultDraft();
    d.seats[1].personality = 'warlord';
    const raw = JSON.parse(JSON.stringify({ ...d, mapId: 'true-world', house: { ...d.house, neutral: true } }));
    delete raw.house.truces;
    const back = sanitizeDraft(raw);
    expect(back.seats.map((s) => s.personality)).toEqual([undefined, 'warlord', undefined, undefined]);
    expect(back.mapId).toBe('true-world');
    expect(back.house.neutral).toBe(true);
    expect(back.house.truces).toBe(true);
    expect(sanitizeDraft({ ...raw, mapId: 'atlantis' }).mapId).toBe('classic');
  });

  it("a pre-v5.1 draft keeps its table but drops the old auto-filled personalities and house-rule defaults", () => {
    const old = {
      seats: [
        { name: 'John', color: 'crimson', kind: 'human', difficulty: 'normal' },
        { name: 'Sam', color: 'cobalt', kind: 'human', difficulty: 'normal' },
        { name: 'Ochre', color: 'amber', kind: 'ai', difficulty: 'hard', personality: 'turtle' },
      ],
      length: 'quick',
      setup: 'quickDeal',
      house: { draft: false, cardBonus: 'progressive', fortifyRule: 'connected', setupBatch: 'auto', seed: null, neutral: true, truces: true, missions: true },
      mapId: 'classic',
    };
    const back = sanitizeDraft(old);
    expect(back.seats.map((s) => [s.name, s.kind, s.personality])).toEqual([
      ['John', 'human', undefined],
      ['Sam', 'human', undefined],
      ['Ochre', 'ai', undefined],
    ]);
    expect(back.seats[2].difficulty).toBe('hard');
    expect(back.length).toBe('quick');
    expect(back.house.neutral).toBe(false);
    expect(back.house.missions).toBe(false);
    expect(back.v51).toBe(true);
  });

  it('a seat flipped to AI, or added, stays random (no personality picked for it)', () => {
    const d = patchSeat(defaultDraft(), 0, { kind: 'ai' });
    expect(d.seats[0].personality).toBeUndefined();
    const e = addSeat(removeSeat(defaultDraft(), 3));
    expect(e.seats[3].personality).toBeUndefined();
  });

  it('Start draws each AI a personality from the seed (deterministic, no repeats up to three), keeps a chosen one', () => {
    const d = defaultDraft();
    const c = draftToConfig({ ...d, mapId: 'true-world' }, 5);
    expect(c.mapId).toBe('true-world');
    expect(c.diplomacy).toBe(true);
    const picks = c.players.filter((p) => p.kind === 'ai').map((p) => p.personality);
    expect([...picks].sort()).toEqual(['opportunist', 'turtle', 'warlord']);
    expect(draftToConfig(d, 5).players.map((p) => p.personality)).toEqual(c.players.map((p) => p.personality));
    // different seeds deal different tables (some seed in a handful differs)
    const tables = new Set([1, 2, 3, 4, 6, 7, 8, 9].map((seed) => draftToConfig(d, seed).players.map((p) => p.personality).join(',')));
    expect(tables.size).toBeGreaterThan(1);
    const chosen = patchSeat(d, 2, { personality: 'warlord' });
    for (const seed of [1, 2, 3, 4]) expect(draftToConfig(chosen, seed).players[2].personality).toBe('warlord');
    expect(draftToConfig(d, 5).players[0].personality).toBeUndefined();
    expect(draftToConfig({ ...d, house: { ...d.house, truces: false } }, 5).diplomacy).toBeUndefined();
    const allAi = { ...d, seats: d.seats.map((s) => ({ ...s, kind: 'ai' as const })) };
    expect(draftToConfig(allAi, 5).diplomacy).toBeUndefined();
    const two = removeSeat(removeSeat(d, 3), 2);
    expect(draftToConfig(two, 5).neutral).toBeUndefined();
    expect(draftToConfig({ ...two, house: { ...two.house, neutral: true } }, 5).neutral).toBe(true);
  });

  it('the New game view offers both maps and the three personalities, and its More fold survives re-renders', () => {
    const { c } = make();
    const ng = c.getViewModel().newGame;
    expect(ng.maps?.map((m) => m.id).slice(0, 2)).toEqual(['classic', 'true-world']);
    expect(ng.maps?.map((m) => m.id)).not.toContain('test-twelve');
    expect(ng.maps?.[1].seats).toBe('2–4 players');
    expect(ng.mapId).toBe('classic');
    expect(ng.personalities?.map((p) => p.name)).toEqual(['Turtle', 'Opportunist', 'Warlord']);
    expect(ng.advancedOpen).toBe(false);
    c.intent({ type: 'more', open: true });
    expect(c.getViewModel().newGame.advancedOpen).toBe(true);
    c.intent({ type: 'map', id: 'true-world' });
    expect(c.getViewModel().newGame.mapId).toBe('true-world');
    expect(c.getViewModel().newGame.advancedOpen).toBe(true);
    c.intent({ type: 'seat', index: 0, patch: { kind: 'ai' } });
    expect(c.getViewModel().newGame.seats[0].personality).toBeUndefined();
    c.intent({ type: 'more', open: false });
    expect(c.getViewModel().newGame.advancedOpen).toBe(false);
    c.dispose();
  });

  it("the default New game is the last game's table", () => {
    const kv = memoryKV();
    const a = make(kv).c;
    a.intent({ type: 'seat', index: 1, patch: { kind: 'human', name: 'Sam' } });
    a.intent({ type: 'removeSeat', index: 3 });
    a.intent({ type: 'length', value: 'quick' });
    a.dispose();
    const b = make(kv).c;
    const ng = b.getViewModel().newGame;
    expect(ng.seats.map((s) => `${s.name}:${s.kind}`)).toEqual(['Vermilion:human', 'Sam:human', `${ng.seats[2].name}:ai`]);
    expect(ng.length).toBe('quick');
    b.dispose();
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

describe('standing replaces the truce protocol (v5.1 C)', () => {
  it('no offer line, no Accept / Decline, even with an old offer pending in the state', async () => {
    const s = diplomacyBoard((st) => {
      st.diplomacy = { truces: [], offers: [{ from: 2, to: 0, rounds: 3, kind: 'noAttack', turn: 8 }], proposedOn: { 2: 8 }, rebuffs: [] };
    });
    const { c } = await load(s);
    const u = c.hooks.ui();
    expect(u.offer).toBeNull();
    expect(c.getViewModel().game!.strip.offer ?? null).toBeNull();
    expect(u.buttons).not.toContain('Accept');
    expect(u.buttons).not.toContain('Decline');
    c.intent({ type: 'button', id: 'acceptTruce' });
    await settle();
    expect(c.hooks.getState()!.diplomacy?.truces.length ?? 0).toBe(0);
    c.dispose();
  });

  it('no Truce word in Attack; proposeTruce and the truce button do nothing', async () => {
    const { c } = await load(diplomacyBoard());
    expect(c.hooks.ui().buttons).toEqual([]);
    expect(c.hooks.ui().gold).toBe('segment:attack');
    c.intent({ type: 'button', id: 'truce' });
    c.intent({ type: 'proposeTruce', to: 2 });
    await settle();
    expect(c.hooks.ledger().filter((l) => l.kind === 'truce')).toEqual([]);
    expect(c.getViewModel().game!.seats.some((x) => x.truceTarget)).toBe(false);
    c.dispose();
  });

  it('every AI seat carries its standing toward the driver; humans none', async () => {
    const { c } = await load(diplomacyBoard());
    const seats = c.getViewModel().game!.seats;
    expect(['ally', 'even', 'wary', 'hostile']).toContain(seats[2].standing);
    expect(typeof seats[2].canAskPeace).toBe('boolean');
    expect(Array.isArray(seats[2].understandingWith)).toBe(true);
    expect(seats[0].standing).toBeUndefined();
    expect(seats[1].standing).toBeUndefined();
    const hook = c.hooks.standing();
    expect(hook.map((h) => h.kind)).toEqual(['human', 'human', 'ai']);
    expect(hook[2].reader).toBe(0);
    expect(hook[2].standing).toBe(seats[2].standing);
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
  it("an AI seat hides its personality until it has spoken (v5.1 D); its strongest grudge at 2 or more", async () => {
    const s = diplomacyBoard((st) => {
      st.players[2].grudges = { 0: 1.2, 1: 2.5 };
    });
    const { c } = await load(s);
    const priya = c.getViewModel().game!.seats[2];
    expect(priya.personality ?? null).toBeNull();
    expect(c.hooks.standing()[2].personality).toBeNull();
    expect(priya.grudge?.name).toBe('Sam');
    expect(c.getViewModel().game!.seats[0].personality).toBeUndefined();
    c.dispose();
    // A saved game in which Priya has spoken: the label shows.
    const kv = memoryKV();
    kv.set(UI_KEY, JSON.stringify({ v: 1, game: { id: s.id, revealed: [2], log: [], logId: 1 } }));
    const r = await load(s, kv);
    expect(r.c.getViewModel().game!.seats[2].personality?.name).toBe('Turtle');
    r.c.dispose();
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
