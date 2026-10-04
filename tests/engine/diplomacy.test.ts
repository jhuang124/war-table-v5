// AI as a player: personalities, grudges, truces (engine events + AI behaviour), save/restore.
import { describe, expect, it } from 'vitest';
import {
  applyAction,
  chooseAiAction,
  cloneState,
  createGame,
  GRUDGE_DECAY,
  grudgesOf,
  PERSONALITIES,
  PERSONAS,
  personaFor,
  sanitizeConfig,
  truceSentence,
  validateAction,
  type AiPersonality,
  type GameEvent,
  type GameState,
  type PlayerId,
} from '../../src/engine';
import { targetValueFor } from '../../src/engine/ai/brain';
import { act, config, passTurn, reject, scenario, types } from './helpers';
import { aiConfig, playAi } from './sim';

const PERS: AiPersonality[] = ['turtle', 'opportunist', 'warlord'];

/** Make seat `p` an AI (optionally with a personality) in a hand-built state. */
function asAi(s: GameState, p: PlayerId, personality?: AiPersonality): void {
  s.players[p] = { ...s.players[p], kind: 'ai', difficulty: 'normal', ...(personality ? { personality } : {}) };
}

/** Play the current seat's actions with the AI until the turn passes; returns every event. */
function aiTurn(state: GameState): { state: GameState; events: GameEvent[] } {
  let s = state;
  const turn = s.turn;
  const events: GameEvent[] = [];
  for (let guard = 0; guard < 400 && s.turn === turn && s.phase.kind !== 'game-over'; guard++) {
    const a = chooseAiAction(s, s.currentPlayer);
    const r = act(s, a);
    s = r.state;
    events.push(...r.events);
  }
  return { state: s, events };
}

describe('personalities', () => {
  it('three named traits with one plain line each, no exclamation marks', () => {
    expect(Object.keys(PERSONALITIES).sort()).toEqual(['opportunist', 'turtle', 'warlord']);
    for (const p of Object.values(PERSONALITIES)) {
      expect(p.name.length).toBeGreaterThan(3);
      expect(p.line.length).toBeGreaterThan(10);
      expect(p.line).not.toContain('!');
    }
  });

  it('no personality = the difficulty persona itself (the classic AI)', () => {
    for (const d of ['easy', 'normal', 'hard'] as const) expect(personaFor(d)).toBe(PERSONAS[d]);
  });

  it('config and state carry the personality; junk is dropped; setController can set it', () => {
    const cfg = aiConfig(['normal', 'hard']);
    cfg.players[0].personality = 'warlord';
    (cfg.players[1] as { personality?: string }).personality = 'pacifist';
    expect(sanitizeConfig(cfg).players[0].personality).toBe('warlord');
    expect(sanitizeConfig(cfg).players[1].personality).toBeUndefined();
    const { state } = createGame(cfg);
    expect(state.players[0].personality).toBe('warlord');
    expect(state.players[1].personality).toBeUndefined();
    const r = act(state, { type: 'setController', player: 1, kind: 'ai', personality: 'turtle' });
    expect(r.state.players[1].personality).toBe('turtle');
    expect(r.events[0]).toMatchObject({ type: 'controllerChanged', personality: 'turtle' });
    reject(state, { type: 'setController', player: 1, kind: 'ai', personality: 'pacifist' as AiPersonality });
  });

  it('every personality × difficulty plays legal, finished, deterministic games', () => {
    let i = 0;
    for (const pers of PERS) {
      for (const d of ['easy', 'normal', 'hard'] as const) {
        const cfg = aiConfig([d, 'normal', 'hard', 'normal'], { seed: 4100 + i, setupMode: i % 2 ? 'draft' : 'random' });
        cfg.players.forEach((p, k) => (p.personality = PERS[(k + i) % 3]));
        cfg.players[0].personality = pers;
        const a = playAi(cfg);
        expect(a.rawIllegal).toEqual([]);
        expect(a.state.phase.kind).toBe('game-over');
        if (i % 3 === 0) expect(playAi(cfg).events).toEqual(a.events);
        i++;
      }
    }
  });

  it('play differs by personality: a Warlord takes an even fight that an Opportunist refuses', () => {
    // Ukraine (7) against Ural (5): p ≈ 0.64. Seat 1 holds five Asian territories, all 5 strong.
    const terr = {
      ukraine: [0, 7],
      ural: [1, 5],
      siberia: [1, 5],
      yakutsk: [1, 5],
      irkutsk: [1, 5],
      kamchatka: [1, 5],
    } as const;
    const base = scenario({ players: 2, fill: 0, terr: terr as never, phase: { kind: 'attack' }, conquered: true });
    const pick = (pers: AiPersonality) => {
      const s = cloneState(base);
      asAi(s, 0, pers);
      return chooseAiAction(s, 0);
    };
    expect(pick('warlord')).toMatchObject({ type: 'blitz', from: 'ukraine', to: 'ural' });
    expect(pick('opportunist').type).not.toBe('blitz');
  });
});

describe('grudges', () => {
  // A (seat 0) takes Yakutsk and Kamchatka from AI B (seat 1). C (seat 2) never touches B.
  function afterTwoConquests(): GameState {
    const s = scenario({
      players: 3,
      fill: 2,
      terr: {
        irkutsk: [0, 30],
        ural: [0, 3],
        mongolia: [0, 1],
        china: [0, 1],
        siam: [0, 1],
        ukraine: [1, 12],
        scandinavia: [1, 1],
        yakutsk: [1, 1],
        kamchatka: [1, 1],
        afghanistan: [2, 3],
      },
      phase: { kind: 'attack' },
    });
    asAi(s, 1, 'warlord');
    s.rng = 7;
    let r = act(s, { type: 'blitz', player: 0, from: 'irkutsk', to: 'yakutsk' });
    expect(types(r.events)).toContain('territoryConquered');
    if (r.state.phase.kind === 'occupy') r = act(r.state, { type: 'occupy', player: 0, count: r.state.phase.min });
    r = act(r.state, { type: 'blitz', player: 0, from: 'irkutsk', to: 'kamchatka' });
    expect(types(r.events)).toContain('territoryConquered');
    if (r.state.phase.kind === 'occupy') r = act(r.state, { type: 'occupy', player: 0, count: r.state.phase.min });
    return r.state;
  }

  it('taking territories builds a grudge in the victim, readable per seat', () => {
    const s = afterTwoConquests();
    expect(s.players[1].grudges).toEqual({ 0: 2 });
    expect(grudgesOf(s, 1)).toEqual([{ seat: 0, value: 2 }]);
    expect(s.players[2].grudges).toBeUndefined();
  });

  it("after A takes two of B's territories, B's attack preference against A rises vs an uninvolved seat", () => {
    const after = afterTwoConquests();
    // B's turn on the same board, once with its memory and once with it wiped.
    const withG = cloneState(after);
    withG.currentPlayer = 1;
    withG.phase = { kind: 'attack' };
    withG.conqueredThisTurn = true;
    const without = cloneState(withG);
    delete without.players[1].grudges;
    const pref = (s: GameState) => targetValueFor(s, 1, 'ural') - targetValueFor(s, 1, 'afghanistan');
    const lift = pref(withG) - pref(without);
    expect(lift).toBeGreaterThan(2); // warlord: 1.6 per grudge point × 2
    expect(targetValueFor(withG, 1, 'afghanistan')).toBeCloseTo(targetValueFor(without, 1, 'afghanistan'), 9);
    // The classic AI keeps the memory but does not act on it.
    const classicG = cloneState(withG);
    const classic = cloneState(without);
    delete classicG.players[1].personality;
    delete classic.players[1].personality;
    expect(pref(classicG)).toBeCloseTo(pref(classic), 9);
  });

  it('grudges decay each new round and are forgotten when small', () => {
    let s = afterTwoConquests();
    for (let k = 0; k < 3; k++) s = passTurn(s).state; // 0 → 1 → 2 → 0: one new round
    expect(s.round).toBe(2);
    expect(s.players[1].grudges![0]).toBeCloseTo(2 * GRUDGE_DECAY, 5);
    for (let k = 0; k < 3 * 12; k++) s = passTurn(s).state;
    expect(s.players[1].grudges).toEqual({});
  });
});

describe('truces', () => {
  // Seat 0 (turtle) faces seat 1 (turtle, strong on the Ural front) and seat 2 (warlord, everywhere else).
  function twoFronts(): GameState {
    const s = scenario({
      players: 3,
      fill: 2,
      terr: { ukraine: [0, 5], scandinavia: [0, 3], ural: [1, 6], afghanistan: [1, 6], siberia: [1, 2] },
      phase: { kind: 'reinforce', remaining: 3, mustTrade: false, placed: {}, midTurn: false },
    });
    asAi(s, 0, 'turtle');
    asAi(s, 1, 'turtle');
    asAi(s, 2, 'warlord');
    return s;
  }

  it('an AI proposes an understanding only to an AI it stands at ally with, and the partner accepts', () => {
    // v5.1: Ann (turtle, Australia) and Ben (turtle, South America) share no border while Cat holds the rest and
    // leads the table: each stands at ally toward the other. (The v4 two-fronts proposal is retired.)
    const terr: Record<string, [number, number]> = {};
    for (const t of ['indonesia', 'new_guinea', 'western_australia', 'eastern_australia']) terr[t] = [0, 3];
    for (const t of ['venezuela', 'peru', 'brazil', 'argentina']) terr[t] = [1, 3];
    const s = scenario({ players: 3, fill: 2, terr: terr as never, phase: { kind: 'reinforce', remaining: 3, mustTrade: false, placed: {}, midTurn: false } });
    asAi(s, 0, 'turtle');
    asAi(s, 1, 'turtle');
    asAi(s, 2, 'warlord');
    const a = chooseAiAction(s, 0);
    expect(a).toEqual({ type: 'proposeTruce', player: 0, to: 1, rounds: 3, kind: 'noAttack' });
    const r = act(s, a);
    expect(types(r.events)).toEqual(['truceProposed', 'truceAccepted']);
    expect(r.state.diplomacy!.truces).toEqual([{ from: 0, to: 1, rounds: 3, kind: 'noAttack', since: 1, until: 5 }]);
    // One offer per turn; the AI carries on with its turn.
    reject(r.state, { type: 'proposeTruce', player: 0, to: 2, rounds: 2, kind: 'noAttack' });
    expect(chooseAiAction(r.state, 0).type).not.toBe('proposeTruce');
    // The neighbour it does not stand at ally with is refused.
    expect(act(s, { type: 'proposeTruce', player: 0, to: 2, rounds: 3, kind: 'noAttack' }).events[1]).toMatchObject({ type: 'truceDeclined' });
  });

  it('a personality AI keeps the truce: no attack on its partner even when it is easy', () => {
    let s = act(twoFronts(), { type: 'proposeTruce', player: 0, to: 1, rounds: 3, kind: 'noAttack' }).state;
    s.territories.ukraine.armies = 25;
    s.territories.ural.armies = 1;
    const turn = aiTurn(s);
    expect(types(turn.events)).not.toContain('truceBroken');
    expect(turn.events.some((e) => e.type === 'diceRolled' && e.defender === 1)).toBe(false);
  });

  it('breaking a truce is legal, announced first, and costs standing with everyone', () => {
    let s = act(twoFronts(), { type: 'proposeTruce', player: 0, to: 1, rounds: 3, kind: 'noAttack' }).state;
    s = cloneState(s);
    s.currentPlayer = 1;
    s.phase = { kind: 'attack' };
    const r = act(s, { type: 'blitz', player: 1, from: 'ural', to: 'ukraine' });
    expect(r.events[0]).toEqual({ type: 'truceBroken', by: 1, against: 0, from: 'ural', to: 'ukraine' });
    expect(r.events[1].type).toBe('diceRolled');
    expect(r.state.diplomacy!.truces).toEqual([]);
    expect(r.state.players[1].truceBreaks).toBe(1);
    expect(r.state.players[0].grudges![1]).toBeGreaterThanOrEqual(3); // betrayed (+ any territory taken)
    expect(r.state.players[2].grudges![1]).toBe(1); // lost standing with the table
  });

  it('expires by round: truceExpired comes before the new turn starts', () => {
    let s = act(twoFronts(), { type: 'proposeTruce', player: 0, to: 1, rounds: 1, kind: 'noAttack' }).state;
    expect(s.diplomacy!.truces[0].until).toBe(3);
    const seen: GameEvent[] = [];
    for (let k = 0; k < 6 && s.round < 3; k++) {
      const r = passTurn(s);
      seen.push(...r.events);
      s = r.state;
    }
    expect(s.round).toBe(3);
    const t = types(seen);
    const i = t.indexOf('truceExpired');
    expect(i).toBeGreaterThan(-1);
    expect(t[i + 1]).toBe('turnStarted');
    expect(seen[i]).toEqual({ type: 'truceExpired', from: 0, to: 1, reason: 'time' });
    expect(s.diplomacy!.truces).toEqual([]);
  });

  it('the classic AI always declines; the refusal is remembered so it is not asked every turn', () => {
    const s = twoFronts();
    delete s.players[1].personality;
    const r = act(s, { type: 'proposeTruce', player: 0, to: 1, rounds: 3, kind: 'noAttack' });
    expect(r.events[1]).toMatchObject({ type: 'truceDeclined', reason: 'declined' });
    expect(r.state.diplomacy!.rebuffs).toEqual([{ from: 0, to: 1, round: 1 }]);
    // And a personality AI never bothers offering one to a classic AI.
    expect(chooseAiAction(s, 0).type).not.toBe('proposeTruce');
  });

  it('v5.1: no AI offers a human a truce (diplomacy on or off); a legacy offer in a save still answers and lapses', () => {
    const off = twoFronts();
    off.players[1] = { ...off.players[1], kind: 'human' };
    delete off.players[1].difficulty;
    reject(off, { type: 'proposeTruce', player: 0, to: 1, rounds: 3, kind: 'noAttack' });
    expect(chooseAiAction(off, 0).type).not.toBe('proposeTruce');
    const on = cloneState(off);
    on.config = { ...on.config, diplomacy: true };
    reject(on, { type: 'proposeTruce', player: 0, to: 1, rounds: 3, kind: 'noAttack' });
    expect(chooseAiAction(on, 0).type).not.toBe('proposeTruce');

    // An offer already waiting in an old save: the human may still answer it, out of turn.
    const saved = cloneState(on);
    saved.diplomacy = { truces: [], offers: [{ from: 0, to: 1, rounds: 3, kind: 'noAttack', turn: saved.turn }], proposedOn: { 0: saved.turn }, rebuffs: [] };
    reject(saved, { type: 'answerTruce', player: 2, from: 0, accept: true });
    const yes = act(saved, { type: 'answerTruce', player: 1, from: 0, accept: true });
    expect(yes.events).toEqual([{ type: 'truceAccepted', from: 0, to: 1, rounds: 3, kind: 'noAttack', until: 5 }]);
    expect(yes.state.diplomacy!.offers).toEqual([]);

    // Unanswered, the offer lapses when the human's next turn ends.
    let s = saved;
    const seen: GameEvent[] = [];
    for (let k = 0; k < 2; k++) {
      const p = passTurn(s);
      seen.push(...p.events);
      s = p.state;
    }
    expect(seen.find((e) => e.type === 'truceDeclined')).toMatchObject({ from: 0, to: 1, reason: 'lapsed' });
    expect(s.diplomacy!.offers).toEqual([]);
  });

  it("eliminating a seat ends its truces and its partners hold it against the conqueror", () => {
    const s = scenario({
      players: 3,
      fill: 2,
      terr: { ukraine: [0, 3], ural: [1, 1], siberia: [2, 10] },
      phase: { kind: 'attack' },
      current: 2,
    });
    s.diplomacy = { truces: [{ from: 0, to: 1, rounds: 3, kind: 'noAttack', since: 1, until: 5 }], offers: [], proposedOn: {}, rebuffs: [] };
    const r = act(s, { type: 'blitz', player: 2, from: 'siberia', to: 'ural' });
    const t = types(r.events);
    expect(t).toContain('playerEliminated');
    expect(r.events.find((e) => e.type === 'truceExpired')).toEqual({ type: 'truceExpired', from: 0, to: 1, reason: 'eliminated' });
    expect(t.indexOf('truceExpired')).toBeGreaterThan(t.indexOf('playerEliminated'));
    expect(r.state.players[0].grudges![2]).toBe(2);
    expect(r.state.diplomacy!.truces).toEqual([]);
  });

  it('validation: no truce with yourself, the neutral seat, the eliminated, or twice', () => {
    const s = twoFronts();
    reject(s, { type: 'proposeTruce', player: 0, to: 0, rounds: 3, kind: 'noAttack' });
    reject(s, { type: 'proposeTruce', player: 0, to: 1, rounds: 0, kind: 'noAttack' });
    reject(s, { type: 'proposeTruce', player: 0, to: 1, rounds: 6, kind: 'noAttack' });
    reject(s, { type: 'proposeTruce', player: 1, to: 0, rounds: 3, kind: 'noAttack' }); // not their turn
    const occ = cloneState(s);
    occ.phase = { kind: 'occupy', from: 'ukraine', to: 'scandinavia', min: 1, max: 2 };
    reject(occ, { type: 'proposeTruce', player: 0, to: 1, rounds: 3, kind: 'noAttack' });
    const n = createGame(config(2, { neutral: true })).state;
    const cur = n.currentPlayer;
    reject(n, { type: 'proposeTruce', player: cur, to: 2, rounds: 3, kind: 'noAttack' });
  });

  it('each diplomacy event has one plain sentence', () => {
    const s = scenario({ players: 3 });
    const line = (e: GameEvent) => truceSentence(s, e);
    expect(line({ type: 'truceProposed', from: 1, to: 0, rounds: 3, kind: 'noAttack' })).toBe('Ben proposes a truce with Ann · 3 rounds');
    expect(line({ type: 'truceAccepted', from: 1, to: 0, rounds: 3, kind: 'noAttack', until: 9 })).toBe("Ann accepts Ben's truce · until round 9");
    expect(line({ type: 'truceDeclined', from: 1, to: 0, rounds: 3, kind: 'noAttack', reason: 'declined' })).toBe("Ann turns down Ben's truce");
    expect(line({ type: 'truceDeclined', from: 1, to: 0, rounds: 3, kind: 'noAttack', reason: 'lapsed' })).toBe("Ben's truce offer to Ann lapses");
    expect(line({ type: 'truceBroken', by: 1, against: 2, from: 'ural', to: 'ukraine' })).toBe('Ben breaks the truce with Cat · attacks Ukraine');
    expect(line({ type: 'truceExpired', from: 1, to: 2, reason: 'time' })).toBe('The truce between Ben and Cat ends');
    expect(line({ type: 'truceProposed', from: 1, to: 0, rounds: 1, kind: 'noAttack' })).toBe('Ben proposes a truce with Ann · 1 round');
    expect(line({ type: 'gameStarted', firstPlayer: 0 })).toBeNull();
  });

  it('truces, offers and grudges survive a save/restore, and play continues identically', () => {
    // v5.1: truces are AI-AI understandings; drive personality games until one holds.
    let s = createGame(aiConfig(['normal', 'normal', 'normal', 'normal'], { seed: 5169 })).state;
    for (let seed = 5169; seed < 5175 && !s.diplomacy?.truces.length; seed++) {
      const cfg = aiConfig(['normal', 'normal', 'normal', 'normal'], { seed });
      cfg.players.forEach((p, k) => (p.personality = PERS[(k + seed) % 3]));
      s = createGame(cfg).state;
      for (let k = 0; k < 4000 && s.phase.kind !== 'game-over'; k++) {
        if (s.diplomacy?.truces.length && Object.values(s.players).some((p) => p.grudges && Object.keys(p.grudges).length)) break;
        s = act(s, chooseAiAction(s, s.currentPlayer)).state;
      }
    }
    expect(s.diplomacy?.truces.length).toBeGreaterThan(0);
    const restored = JSON.parse(JSON.stringify(s)) as GameState;
    expect(restored).toEqual(s);
    let a = s;
    let b = restored;
    for (let k = 0; k < 300 && a.phase.kind !== 'game-over'; k++) {
      const x = chooseAiAction(a, a.currentPlayer);
      expect(chooseAiAction(b, b.currentPlayer)).toEqual(x);
      const ra = applyAction(a, x);
      const rb = applyAction(b, x);
      expect(ra.ok && rb.ok).toBe(true);
      if (!ra.ok || !rb.ok) break;
      expect(rb.events).toEqual(ra.events);
      a = ra.state;
      b = rb.state;
    }
  });

  it('AI↔AI truces happen in personality games without any human input', () => {
    // v5.1: understandings come from standing (two AIs at ally), so they are rarer than v4's offers: about one
    // 4-seat game in ten (npm run sim, Standing section). Seeds 5169–5174 hold the first one.
    let seen = 0;
    for (let seed = 5169; seed < 5175 && seen === 0; seed++) {
      const cfg = aiConfig(['normal', 'normal', 'normal', 'normal'], { seed });
      cfg.players.forEach((p, k) => (p.personality = PERS[(k + seed) % 3]));
      const g = playAi(cfg);
      expect(g.rawIllegal).toEqual([]);
      seen += g.events.filter((e) => e.type === 'truceAccepted').length;
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe('neutral seat (2 players)', () => {
  it('deals a third seat a third of the board; it never takes a turn', () => {
    const { state, events } = createGame(config(2, { neutral: true, seed: 99 }));
    expect(state.players).toHaveLength(3);
    const n = state.players[2];
    expect(n).toMatchObject({ id: 2, name: 'Neutral', neutral: true, eliminated: false, setupArmies: 0 });
    expect(['crimson', 'cobalt']).not.toContain(n.color);
    const count = (p: number) => Object.values(state.territories).filter((t) => t.owner === p).length;
    expect([count(0), count(1), count(2)]).toEqual([14, 14, 14]);
    for (const t of Object.values(state.territories)) if (t.owner === 2) expect(t.armies).toBe(3);
    expect([0, 1]).toContain(state.firstPlayer);
    expect(types(events).slice(0, 2)).toEqual(['gameStarted', 'territoriesDealt']);
  });

  it('is off by default and ignored for 3+ players', () => {
    expect(createGame(config(2)).state.players).toHaveLength(2);
    expect('neutral' in sanitizeConfig(config(2))).toBe(false);
    const three = createGame(config(3, { neutral: true })).state;
    expect(three.players).toHaveLength(3);
    expect(three.players.some((p) => p.neutral)).toBe(false);
    expect(three.config.neutral).toBeUndefined();
  });

  it('AI games finish legally; neutral defends but never attacks, never moves, never wins', () => {
    for (const [i, over] of [
      { seed: 31 },
      { seed: 32, setupMode: 'draft' as const, initialPlacement: 'manual' as const },
      { seed: 33, cardBonus: 'fixed' as const, fortifyRule: 'adjacent' as const },
    ].entries()) {
      const g = playAi(aiConfig(['normal', 'hard'], { neutral: true, ...over }));
      expect(g.rawIllegal, `game ${i}`).toEqual([]);
      expect(g.state.phase.kind).toBe('game-over');
      if (g.state.phase.kind === 'game-over') expect([0, 1]).toContain(g.state.phase.winner);
      expect(g.events.some((e) => (e.type === 'turnStarted' || e.type === 'setupTurn') && e.player === 2)).toBe(false);
      expect(g.events.some((e) => e.type === 'diceRolled' && e.player === 2)).toBe(false);
      expect(g.events.some((e) => e.type === 'diceRolled' && e.defender === 2 && e.defendDice.length >= 1)).toBe(true);
      expect(g.events.some((e) => e.type === 'territoryClaimed' && e.player === 2 && over.setupMode !== 'draft')).toBe(false);
    }
  });

  it('draft claims rotate between the two players only', () => {
    let s = createGame(config(2, { neutral: true, setupMode: 'draft', seed: 5 })).state;
    const claimers = new Set<number>();
    for (let k = 0; k < 6; k++) {
      claimers.add(s.currentPlayer);
      const free = (Object.keys(s.territories) as (keyof typeof s.territories)[]).find((t) => s.territories[t].owner === -1)!;
      s = act(s, { type: 'claim', player: s.currentPlayer, territory: free }).state;
    }
    expect([...claimers].sort()).toEqual([0, 1]);
  });

  it('knocking out the other player wins, even while neutral armies remain', () => {
    const base = createGame(config(2, { neutral: true, seed: 8 })).state;
    const s = scenario({ players: 2, config: { neutral: true, seed: 8 }, fill: 2, terr: { alaska: [0, 6], kamchatka: [1, 1] } });
    expect(s.players).toHaveLength(base.players.length);
    const r = act(s, { type: 'blitz', player: 0, from: 'alaska', to: 'kamchatka' });
    expect(r.state.phase).toMatchObject({ kind: 'game-over', winner: 0, reason: 'domination' });
    expect(validateAction(r.state, { type: 'endTurn', player: 0 })).not.toBeNull();
  });
});
