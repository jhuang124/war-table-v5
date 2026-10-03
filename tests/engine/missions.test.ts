import { describe, expect, it } from 'vitest';
import {
  applyAction,
  chooseAiAction,
  cloneState,
  CONTINENTS,
  createGame,
  MISSIONS,
  missionById,
  missionComplete,
  missionDeckFor,
  missionGoal,
  missionHeadline,
  missionText,
  TERRITORY_IDS,
  type GameEvent,
  type GameState,
  type PlayerId,
  type TerritoryId,
} from '../../src/engine';
import { targetValueFor } from '../../src/engine/ai/brain';
import { act, config, findOutcome, scenario, seats } from './helpers';

type Over = Extract<GameEvent, { type: 'gameOver' }>;
const over = (evs: GameEvent[]) => evs.find((e): e is Over => e.type === 'gameOver');

/** A hand-built missions game: `missions` overrides each seat's dealt card. */
function mscenario(o: Parameters<typeof scenario>[0] & { missions: Partial<Record<PlayerId, string>> }): GameState {
  const s = scenario({ ...o, config: { ...o.config, missions: true } });
  for (const [pid, id] of Object.entries(o.missions)) s.players[Number(pid)].mission = id;
  return s;
}

/** Every territory of `continents` → owner. */
function own(owner: PlayerId, ...continents: (keyof typeof CONTINENTS)[]): Partial<Record<TerritoryId, [PlayerId, number]>> {
  const out: Partial<Record<TerritoryId, [PlayerId, number]>> = {};
  for (const c of continents) for (const t of CONTINENTS[c].territories) out[t] = [owner, 2];
  return out;
}

/** Blitz `from` → `to` with a seed that conquers it. */
function conquer(s: GameState, from: TerritoryId, to: TerritoryId) {
  return findOutcome(s, { type: 'blitz', player: s.currentPlayer, from, to }, (r) =>
    r.events.some((e) => e.type === 'territoryConquered'),
  );
}

describe('the missions deck', () => {
  it('holds the classic cards: six continent pairs, two territory counts, one colour card per seat colour', () => {
    expect(MISSIONS).toHaveLength(14);
    expect(MISSIONS.filter((m) => m.spec.kind === 'continents')).toHaveLength(6);
    expect(MISSIONS.filter((m) => m.spec.kind === 'territories')).toHaveLength(2);
    expect(MISSIONS.filter((m) => m.spec.kind === 'destroy')).toHaveLength(6);
    for (const m of MISSIONS) {
      expect(m.text).not.toMatch(/!/);
      expect(missionById(m.id)).toBe(m);
    }
    expect(missionById('asia-africa')!.text).toBe('Conquer Asia and Africa');
  });

  it('deals one mission per seat with state.rng, only naming colours at the table', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 60; seed++) {
      const { state } = createGame(config(3, { missions: true, seed }));
      const ids = state.players.map((p) => p.mission);
      expect(ids.every((id) => missionById(id))).toBe(true);
      expect(new Set(ids).size).toBe(3); // dealt without replacement
      for (const id of ids) seen.add(id!);
      // Same seed, same deal.
      expect(createGame(config(3, { missions: true, seed })).state.players.map((p) => p.mission)).toEqual(ids);
    }
    const colourCards = [...seen].filter((id) => id.startsWith('destroy-'));
    expect(colourCards.length).toBeGreaterThan(0);
    for (const id of colourCards) expect(['destroy-crimson', 'destroy-cobalt', 'destroy-emerald']).toContain(id);
  });

  it('leaves the board and first turn exactly as the same seed without missions', () => {
    for (const seed of [7, 99, 4242]) {
      const a = createGame(config(4, { seed })).state;
      const b = createGame(config(4, { seed, missions: true })).state;
      expect(b.territories).toEqual(a.territories);
      expect(b.firstPlayer).toBe(a.firstPlayer);
      expect(a.players.some((p) => p.mission)).toBe(false);
    }
  });

  it('is off by default and stays off through sanitizing', () => {
    const { state } = createGame(config(3));
    expect(state.config.missions).toBeUndefined();
    expect(state.players.every((p) => p.mission === undefined)).toBe(true);
    expect(missionText(state, 0)).toBeNull();
  });

  it('never deals the 2-player neutral seat a mission', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { state } = createGame(config(2, { missions: true, neutral: true, seed }));
      expect(state.players).toHaveLength(3);
      expect(state.players[2].neutral).toBe(true);
      expect(state.players[2].mission).toBeUndefined();
      expect(missionText(state, 2)).toBeNull();
      expect(missionById(state.players[0].mission)).not.toBeNull();
      for (const id of missionDeckFor(state)) expect(id).not.toBe('destroy-neutral');
    }
  });

  it('needs a third seat: a 2-player table without the neutral seat plays without missions', () => {
    const { state } = createGame(config(2, { missions: true }));
    expect(state.config.missions).toBeUndefined();
    expect(state.players.every((p) => p.mission === undefined)).toBe(true);
    const n = createGame(config(2, { missions: true, neutral: true })).state;
    expect(n.config.missions).toBe(true);
    expect(missionDeckFor(n)).toHaveLength(6 + 2 + 2);
  });

  it('works for draft setup too', () => {
    const { state } = createGame(config(4, { missions: true, setupMode: 'draft' }));
    expect(state.phase.kind).toBe('setup-claim');
    expect(state.players.every((p) => missionById(p.mission))).toBe(true);
  });
});

describe('mission sentences', () => {
  it('reads as plain facts about the seat', () => {
    const s = mscenario({
      players: 4,
      missions: { 0: 'asia-africa', 1: 'europe-south-america-plus', 2: 'territories-18-two', 3: 'destroy-crimson' },
      terr: { japan: [1, 1], peru: [2, 1], iceland: [3, 1] },
    });
    expect(missionText(s, 0)).toBe('Ann must hold Asia and Africa');
    expect(missionText(s, 1)).toBe('Ben must hold Europe, South America and one more continent');
    expect(missionText(s, 2)).toBe('Cat must hold 18 territories with at least 2 armies on each');
    expect(missionText(s, 3)).toBe('Dan must knock out Ann (Vermilion)');
    for (const p of s.players) expect(missionText(s, p.id)).not.toMatch(/!/);
  });

  it('names a seat by its colour alone when the seat is called by its colour', () => {
    const s = mscenario({ players: 3, missions: { 0: 'destroy-cobalt' }, terr: { japan: [1, 1], peru: [2, 1] } });
    s.players[1].name = 'Slate';
    expect(missionText(s, 0)).toBe('Ann must knock out Slate');
  });
});

describe('completing a mission wins the game', () => {
  it('two named continents: the conquest that completes them ends the game, everyone marched in', () => {
    const s = mscenario({
      players: 3,
      missions: { 0: 'asia-africa' },
      terr: { south_africa: [0, 10], madagascar: [1, 1], brazil: [1, 3], alaska: [2, 2] },
    });
    expect(missionComplete(s, 0)).toBe(false);
    const r = conquer(s, 'south_africa', 'madagascar');
    const e = over(r.events)!;
    expect(e).toMatchObject({ winner: 0, reason: 'percent', by: 'mission', mission: 'Ann holds Asia and Africa' });
    expect(r.state.phase).toMatchObject({ kind: 'game-over', winner: 0, by: 'mission', mission: 'Ann holds Asia and Africa' });
    expect(r.events.some((x) => x.type === 'phaseChanged' && x.phase === 'occupy')).toBe(false);
    expect(r.state.territories.south_africa.armies).toBe(1);
  });

  it('nobody wins by a mission they do not hold', () => {
    // Ann completes Asia + Africa, but her card is North America + Africa; Ben holds the Asia + Africa card.
    const s = mscenario({
      players: 3,
      missions: { 0: 'north-america-africa', 1: 'asia-africa' },
      terr: { south_africa: [0, 10], madagascar: [1, 1], brazil: [1, 3], alaska: [2, 2] },
    });
    const r = conquer(s, 'south_africa', 'madagascar');
    expect(over(r.events)).toBeUndefined();
    expect(r.state.phase.kind).not.toBe('game-over');
    expect(missionComplete(r.state, 1)).toBe(false);
  });

  it("is only checked on the owner's own turn", () => {
    // Ben already holds 24 territories (his card), but it is Ann's turn: her endTurn hands the turn on.
    const terr: Partial<Record<TerritoryId, [PlayerId, number]>> = {};
    TERRITORY_IDS.slice(0, 24).forEach((t) => (terr[t] = [1, 2]));
    const s = mscenario({ players: 3, missions: { 0: 'asia-africa', 1: 'territories-24' }, terr: { ...terr, japan: [2, 2] } });
    expect(missionComplete(s, 1)).toBe(true);
    const r = act(s, { type: 'endTurn', player: 0 });
    expect(over(r.events)).toBeUndefined();
    expect(r.state.currentPlayer).toBe(1);
    // Ben's own first action that ends a step: endReinforce.
    const ph = r.state.phase as Extract<GameState['phase'], { kind: 'reinforce' }>;
    const placed = act(r.state, { type: 'reinforce', player: 1, territory: TERRITORY_IDS[0], count: ph.remaining });
    const w = act(placed.state, { type: 'endReinforce', player: 1 });
    expect(over(w.events)).toMatchObject({ winner: 1, by: 'mission', mission: 'Ben holds 24 territories' });
  });

  it('two continents plus one more: needs a third continent, and the headline names it', () => {
    const base = { ...own(0, 'europe', 'south_america'), alaska: [1, 2] as [number, number], japan: [2, 2] as [number, number] };
    const s = mscenario({ players: 3, fill: 1, missions: { 0: 'europe-south-america-plus' }, terr: base });
    expect(missionComplete(s, 0)).toBe(false);
    const s2 = mscenario({ players: 3, fill: 1, missions: { 0: 'europe-south-america-plus' }, terr: { ...base, ...own(0, 'australia') } });
    expect(missionComplete(s2, 0)).toBe(true);
    expect(missionHeadline(s2, 0)).toBe('Ann holds Europe, South America and Australia');
    const r = act(s2, { type: 'endTurn', player: 0 });
    expect(over(r.events)).toMatchObject({ winner: 0, by: 'mission', mission: 'Ann holds Europe, South America and Australia' });
  });

  it('18 territories with 2 armies on each: a territory with 1 army does not count', () => {
    const terr: Partial<Record<TerritoryId, [PlayerId, number]>> = {};
    TERRITORY_IDS.forEach((t, i) => (terr[t] = i < 18 ? [0, 2] : [1 + (i % 2), 3]));
    terr[TERRITORY_IDS[0]] = [0, 1];
    const s = mscenario({ players: 3, missions: { 0: 'territories-18-two' }, terr });
    expect(missionComplete(s, 0)).toBe(false);
    const r = act(s, { type: 'endTurn', player: 0 });
    expect(over(r.events)).toBeUndefined();
    // With 2 on the thin one too, ending the turn wins.
    const s2 = cloneState(s);
    s2.territories[TERRITORY_IDS[0]].armies = 2;
    expect(missionComplete(s2, 0)).toBe(true);
    const w = act(s2, { type: 'endTurn', player: 0 });
    expect(over(w.events)).toMatchObject({ winner: 0, by: 'mission', mission: 'Ann holds 18 territories with at least 2 armies on each' });
    expect(w.events.some((e) => e.type === 'cardDrawn' || e.type === 'turnStarted')).toBe(false);
  });

  it('18 territories with 2 armies on each: a fortify that fills the last one wins', () => {
    const terr: Partial<Record<TerritoryId, [PlayerId, number]>> = {};
    for (const t of TERRITORY_IDS) terr[t] = [1, 3];
    const mine = CONTINENTS.asia.territories.concat(CONTINENTS.australia.territories, ['middle_east'] as TerritoryId[]);
    const eighteen = [...new Set(mine)].concat(['east_africa', 'egypt'] as TerritoryId[]).slice(0, 18);
    for (const t of eighteen) terr[t] = [0, 2];
    terr.siam = [0, 1];
    terr.china = [0, 5];
    const s = mscenario({ players: 3, missions: { 0: 'territories-18-two' }, terr, phase: { kind: 'fortify' } });
    expect(missionComplete(s, 0)).toBe(false);
    const w = act(s, { type: 'fortify', player: 0, from: 'china', to: 'siam', count: 1 });
    expect(over(w.events)).toMatchObject({ winner: 0, by: 'mission' });
  });

  it('24 territories: counts any armies', () => {
    const terr: Partial<Record<TerritoryId, [PlayerId, number]>> = {};
    TERRITORY_IDS.forEach((t, i) => (terr[t] = i < 24 ? [0, 1] : [1 + (i % 2), 2]));
    const s = mscenario({ players: 3, missions: { 0: 'territories-24' }, terr, phase: { kind: 'reinforce', remaining: 0, mustTrade: false, placed: {}, midTurn: false } });
    const w = act(s, { type: 'endReinforce', player: 0 });
    expect(over(w.events)).toMatchObject({ winner: 0, by: 'mission', mission: 'Ann holds 24 territories' });
    expect(w.state.phase).toMatchObject({ kind: 'game-over', by: 'mission' });
  });

  it('knock out a colour: eliminating that seat wins', () => {
    const s = mscenario({
      players: 3,
      missions: { 0: 'destroy-cobalt' },
      terr: { peru: [0, 10], argentina: [1, 1], japan: [2, 3], kamchatka: [2, 3] },
    });
    expect(missionText(s, 0)).toBe('Ann must knock out Ben (Slate)');
    const r = conquer(s, 'peru', 'argentina');
    expect(r.events.some((e) => e.type === 'playerEliminated')).toBe(true);
    expect(over(r.events)).toMatchObject({ winner: 0, by: 'mission', mission: 'Ann knocked out Ben (Slate)' });
  });

  it('knock out a colour: your own colour reads as 24 territories', () => {
    const s = mscenario({ players: 3, missions: { 0: 'destroy-crimson' }, terr: { japan: [1, 1], peru: [2, 1] } });
    expect(missionGoal(s, 0)).toEqual({ kind: 'territories', count: 24, minArmies: 1 });
    expect(missionText(s, 0)).toBe('Ann must hold 24 territories');
  });

  it('knock out a colour: if someone else knocks them out first, it becomes 24 territories', () => {
    const s = mscenario({
      players: 3,
      missions: { 0: 'destroy-cobalt' },
      terr: { peru: [2, 10], argentina: [1, 1], japan: [2, 3] },
      current: 2,
    });
    const r = conquer(s, 'peru', 'argentina'); // Cat knocks Ben out
    expect(r.state.players[1].eliminated).toBe(true);
    expect(over(r.events)).toBeUndefined();
    expect(missionGoal(r.state, 0)).toEqual({ kind: 'territories', count: 24, minArmies: 1 });
    expect(missionText(r.state, 0)).toBe('Ann must hold 24 territories, since Ben (Slate) is out');
    expect(missionComplete(r.state, 0)).toBe(true); // Ann holds nearly the whole board here
  });

  it('the territory win still comes first, and missions off means no mission wins', () => {
    const s = mscenario({
      players: 3,
      missions: { 0: 'asia-africa' },
      terr: { south_africa: [0, 10], madagascar: [1, 1], brazil: [1, 3], alaska: [2, 2] },
      config: { dominationPercent: 90 },
    });
    const r = conquer(s, 'south_africa', 'madagascar');
    expect(over(r.events)).toMatchObject({ winner: 0, reason: 'percent' });
    expect(over(r.events)!.by).toBeUndefined();

    const off = cloneState(s);
    off.config = { ...off.config, missions: undefined, dominationPercent: 100 };
    expect(missionComplete(off, 0)).toBe(false);
    expect(missionText(off, 0)).toBeNull();
    expect(over(conquer(off, 'south_africa', 'madagascar').events)).toBeUndefined();
  });
});

describe('save and restore', () => {
  it('missions live in state: a JSON round trip keeps them and plays on identically', () => {
    let { state } = createGame({ ...config(4, { missions: true, seed: 31337 }), players: seats(4, 'ai') });
    for (let i = 0; i < 120 && state.phase.kind !== 'game-over'; i++) {
      const r = applyAction(state, chooseAiAction(state, state.currentPlayer));
      if (!r.ok) throw new Error(r.error);
      state = r.state;
    }
    const restored = JSON.parse(JSON.stringify(state)) as GameState;
    for (const p of state.players) {
      expect(restored.players[p.id].mission).toBe(p.mission);
      expect(missionText(restored, p.id)).toBe(missionText(state, p.id));
    }
    let a = state;
    let b = restored;
    for (let i = 0; i < 60 && a.phase.kind !== 'game-over'; i++) {
      const ra = applyAction(a, chooseAiAction(a, a.currentPlayer));
      const rb = applyAction(b, chooseAiAction(b, b.currentPlayer));
      if (!ra.ok || !rb.ok) throw new Error('rejected');
      expect(rb.events).toEqual(ra.events);
      a = ra.state;
      b = rb.state;
    }
  });
});

describe('the AIs pursue their missions', () => {
  const ai = (s: GameState, personality?: 'turtle' | 'opportunist' | 'warlord') => {
    for (const p of s.players) {
      p.kind = 'ai';
      p.difficulty = 'normal';
      if (personality) p.personality = personality;
    }
    return s;
  };

  it('a continent mission raises the named continents', () => {
    const terr = { ...own(1, 'asia', 'africa'), ...own(2, 'north_america'), ural: [1, 2] as [number, number] };
    const mk = (mission: string) =>
      ai(mscenario({ players: 3, fill: 0, missions: { 0: mission }, terr: { ...terr, ukraine: [0, 6], egypt: [1, 2], southern_europe: [0, 6] } }));
    const want = mk('asia-africa');
    const other = mk('north-america-australia');
    expect(targetValueFor(want, 0, 'egypt')).toBeGreaterThan(targetValueFor(other, 0, 'egypt'));
    expect(targetValueFor(want, 0, 'ural')).toBeGreaterThan(targetValueFor(other, 0, 'ural'));
  });

  it('a colour mission pulls toward that seat, the Warlord hardest', () => {
    const terr = { ukraine: [0, 8] as [number, number], ural: [1, 2] as [number, number], middle_east: [2, 2] as [number, number], ...own(1, 'asia'), ...own(2, 'africa') };
    terr.ural = [1, 2];
    const mk = (personality: 'turtle' | 'warlord', mission: string) =>
      ai(mscenario({ players: 3, missions: { 0: mission }, terr: { ...terr, middle_east: [2, 2] } }), personality);
    for (const p of ['turtle', 'warlord'] as const) {
      expect(targetValueFor(mk(p, 'destroy-cobalt'), 0, 'ural')).toBeGreaterThan(targetValueFor(mk(p, 'destroy-emerald'), 0, 'ural'));
    }
    const pull = (p: 'turtle' | 'warlord') =>
      targetValueFor(mk(p, 'destroy-cobalt'), 0, 'ural') - targetValueFor(mk(p, 'destroy-emerald'), 0, 'ural');
    expect(pull('warlord')).toBeGreaterThan(pull('turtle'));
  });

  it('AI-vs-AI games with missions end, and every mission win is real', () => {
    let byMission = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const players = seats(4, 'ai').map((p, i) => ({ ...p, ...(i < 3 ? { personality: (['turtle', 'opportunist', 'warlord'] as const)[i] } : {}) }));
      let { state } = createGame({ ...config(4, { missions: true, seed, dominationPercent: 70 }), players });
      for (let i = 0; i < 40000 && state.phase.kind !== 'game-over'; i++) {
        const r = applyAction(state, chooseAiAction(state, state.currentPlayer));
        if (!r.ok) throw new Error(r.error);
        state = r.state;
      }
      expect(state.phase.kind).toBe('game-over');
      const ph = state.phase as Extract<GameState['phase'], { kind: 'game-over' }>;
      if (ph.by === 'mission') {
        byMission++;
        expect(missionComplete(state, ph.winner)).toBe(true);
        expect(ph.mission).toBe(missionHeadline(state, ph.winner));
      }
    }
    expect(byMission).toBeGreaterThan(0);
  });
});
