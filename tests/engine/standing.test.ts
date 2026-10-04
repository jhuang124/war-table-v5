// v5.1 standing (docs/SPEC.md §11.8): bands, reasons, asking for peace, pins, AI-AI understandings.
import { describe, expect, it } from 'vitest';
import {
  canAskPeace,
  chooseAiAction,
  chooseTruceProposal,
  cloneState,
  standingOf,
  standingReason,
  truceSentence,
  type AiPersonality,
  type GameEvent,
  type GameState,
  type PlayerId,
  type TerritoryId,
} from '../../src/engine';
import { peaceAskBlock, refreshStandings, tableLeader } from '../../src/engine/standing';
import { act, passTurn, reject, scenario, types, withRng } from './helpers';

const ANN = 0; // the AI under test
const BEN = 1;
const DAN = 3; // a human

function asAi(s: GameState, p: PlayerId, personality?: AiPersonality): void {
  s.players[p] = { ...s.players[p], kind: 'ai', difficulty: 'normal', ...(personality ? { personality } : {}) };
}

const SA_AF: TerritoryId[] = ['venezuela', 'peru', 'brazil', 'argentina', 'north_africa', 'egypt', 'east_africa', 'congo', 'south_africa', 'madagascar'];
const AUS_ASIA: TerritoryId[] = ['indonesia', 'new_guinea', 'western_australia', 'eastern_australia', 'siam', 'india', 'china', 'mongolia', 'japan', 'irkutsk', 'kamchatka'];
const EU_PLUS: TerritoryId[] = ['iceland', 'scandinavia', 'great_britain', 'northern_europe', 'western_europe', 'southern_europe', 'ukraine', 'ural', 'afghanistan', 'middle_east'];

/**
 * A level 4-seat table (10 / 11 / 11 / 10, nobody leads). Ann (South America + Africa) borders Cat (North America)
 * and Dan (Europe, Middle East), not Ben (Australia + south Asia). `lead` hands Dan four more territories so he
 * leads the table. Every seat 1 army; Dan (seat 3) is human and to move unless `current` says otherwise.
 */
function table(personality: AiPersonality, opts: { lead?: boolean; current?: PlayerId; phase?: GameState['phase'] } = {}): GameState {
  const terr: Partial<Record<TerritoryId, [PlayerId, number]>> = {};
  for (const t of SA_AF) terr[t] = [ANN, 1];
  for (const t of AUS_ASIA) terr[t] = [BEN, 1];
  for (const t of EU_PLUS) terr[t] = [DAN, 1];
  if (opts.lead) for (const t of ['yakutsk', 'siberia', 'greenland', 'alaska'] as TerritoryId[]) terr[t] = [DAN, 1];
  const s = scenario({ players: 4, fill: 2, terr, current: opts.current ?? DAN, phase: opts.phase ?? { kind: 'attack' } });
  asAi(s, ANN, personality);
  asAi(s, BEN, 'turtle');
  asAi(s, 2, 'opportunist');
  refreshStandings(s, true); // the last boundary's bands, as a game in progress has them
  return s;
}

/** Ann lost `n` territories to Dan, the last one (Egypt) in round `round`. */
function hurt(s: GameState, n: number, round = s.round - 1): GameState {
  s.round = Math.max(s.round, 2);
  s.players[ANN].grudges = { [DAN]: n };
  s.players[ANN].lastTakenBy = { [DAN]: { territory: 'egypt', round: round < 1 ? s.round - 1 : round } };
  return s;
}

describe('standingOf: the bands', () => {
  it('a level table: no leader; neighbours are even, a Turtle is ally with a seat it does not touch, others even', () => {
    expect(tableLeader(table('turtle'))).toBe(-1);
    expect(standingOf(table('turtle'), ANN, BEN)).toBe('ally');
    expect(standingOf(table('opportunist'), ANN, BEN)).toBe('even');
    expect(standingOf(table('warlord'), ANN, BEN)).toBe('even');
    for (const p of ['turtle', 'opportunist', 'warlord'] as AiPersonality[]) expect(standingOf(table(p), ANN, DAN)).toBe('even');
  });

  it('losses harden it, the Warlord fastest and the Turtle slowest', () => {
    const one = (p: AiPersonality, n: number) => standingOf(hurt(table(p), n), ANN, DAN);
    expect([one('turtle', 1), one('opportunist', 1), one('warlord', 1)]).toEqual(['even', 'wary', 'wary']);
    expect([one('turtle', 2), one('opportunist', 2), one('warlord', 2)]).toEqual(['wary', 'wary', 'hostile']);
    expect([one('turtle', 3), one('opportunist', 3), one('warlord', 3)]).toEqual(['wary', 'hostile', 'hostile']);
    // Saturated: past three territories, more losses add nothing (the Turtle never turns hostile on losses alone).
    expect(one('turtle', 9)).toBe('wary');
  });

  it('grudges decay, so standing softens round by round (wary → even)', () => {
    let s = hurt(table('opportunist', { current: DAN }), 1);
    expect(standingOf(s, ANN, DAN)).toBe('wary');
    const seen: GameEvent[] = [];
    let turns = 0;
    for (; turns < 40 && standingOf(s, ANN, DAN) !== 'even'; turns++) {
      const r = passTurn(s);
      seen.push(...r.events);
      s = r.state;
    }
    expect(standingOf(s, ANN, DAN)).toBe('even');
    expect(turns).toBeGreaterThan(4); // it holds a few rounds (decay, then the hysteresis edge)
    expect(turns).toBeLessThanOrEqual(20);
    expect(seen).toContainEqual({ type: 'standingChanged', ai: ANN, toward: DAN, standing: 'even' });
  });

  it('armies massed on the shared border make a neighbour wary', () => {
    const s = table('opportunist');
    s.territories.western_europe.armies = 8;
    expect(standingOf(s, ANN, DAN)).toBe('wary');
    expect(standingReason(s, ANN, DAN)).toBe('Ann is wary of you · you have 10 armies on its border');
  });

  it('the leader is wary at least, from everyone; a shared rival draws the others to ally', () => {
    for (const p of ['turtle', 'opportunist', 'warlord'] as AiPersonality[]) {
      const s = table(p, { lead: true });
      expect(tableLeader(s)).toBe(DAN);
      expect(standingOf(s, ANN, DAN)).toBe('wary');
      expect(standingReason(s, ANN, DAN)).toBe('Ann is wary of you · you lead the table');
    }
    expect(standingOf(table('opportunist', { lead: true }), ANN, BEN)).toBe('ally');
    expect(standingReason(table('opportunist', { lead: true }), ANN, BEN)).toBe("Ann is Ben's ally · Dan leads the table");
    // The Opportunist turns on the leader hardest: one loss and it is hostile.
    expect(standingOf(hurt(table('opportunist', { lead: true }), 1), ANN, DAN)).toBe('hostile');
  });

  it('a Warlord that went hostile never returns to ally (until peace)', () => {
    const s = table('warlord', { lead: true });
    expect(standingOf(s, ANN, BEN)).toBe('ally');
    s.diplomacy = { ...(s.diplomacy ?? { truces: [], offers: [], proposedOn: {}, rebuffs: [] }), hardened: ['0>1'] };
    expect(standingOf(s, ANN, BEN)).toBe('even');
  });

  it('the Warlord is marked hardened at the turn boundary where it reads hostile', () => {
    const s = hurt(table('warlord'), 3);
    const r = passTurn(s);
    expect(r.state.diplomacy?.hardened).toContain('0>3');
    expect(r.events).toContainEqual({ type: 'standingChanged', ai: ANN, toward: DAN, standing: 'hostile' });
  });
});

describe('standingReason', () => {
  it('one sentence, the strongest factor, addressed to the reader when toward is human', () => {
    expect(standingReason(table('opportunist'), ANN, BEN)).toBe('Ann is even with Ben · they share no border');
    expect(standingReason(table('opportunist'), ANN, DAN)).toBe('Ann is even with you · you share a border');
    expect(standingReason(table('turtle'), ANN, BEN)).toBe("Ann is Ben's ally · they share no border");
    expect(standingReason(hurt(table('opportunist'), 1), ANN, DAN)).toBe('Ann is wary of you · you took Egypt last round');
    expect(standingReason(hurt(table('warlord'), 2), ANN, DAN)).toBe('Ann is hostile · you took Egypt last round');
    const s = hurt(table('opportunist'), 3, 1);
    s.round = 4;
    expect(standingReason(s, ANN, DAN)).toBe('Ann is hostile · you took Egypt in round 1');
    // An AI toward an AI: by name.
    const t = table('opportunist');
    t.players[ANN].grudges = { 2: 2 };
    t.players[ANN].lastTakenBy = { 2: { territory: 'venezuela', round: 1 } };
    expect(standingReason(t, ANN, 2)).toBe('Ann is wary of Cat · Cat took Venezuela this round');
  });

  it('≤ 70 characters with the default seat names, even for the longest territory', () => {
    const s = hurt(table('warlord'), 2);
    s.players[ANN].name = 'Vermilion';
    s.players[DAN].name = 'Wisteria';
    s.players[ANN].lastTakenBy = { [DAN]: { territory: 'northwest_territory', round: 1 } };
    const asHuman = standingReason(s, ANN, DAN);
    expect(asHuman).toBe('Vermilion is hostile · you took Northwest Territory last round');
    s.players[DAN] = { ...s.players[DAN], kind: 'ai', difficulty: 'normal' };
    const asAiSeat = standingReason(s, ANN, DAN);
    expect(asAiSeat).toBe('Vermilion is hostile to Wisteria · Wisteria took Northwest Territory');
    for (const line of [asHuman, asAiSeat]) {
      expect(line.length).toBeLessThanOrEqual(70);
      expect(line).not.toContain('!');
    }
  });
});

describe('canAskPeace and askPeace', () => {
  it('on the human’s main turn only, toward a living AI seat', () => {
    for (const phase of [{ kind: 'attack' }, { kind: 'fortify' }, { kind: 'reinforce', remaining: 0, mustTrade: false, placed: {}, midTurn: false }] as GameState['phase'][])
      expect(canAskPeace(table('turtle', { phase }), DAN, ANN)).toBe(true);
    expect(canAskPeace(table('turtle', { phase: { kind: 'occupy', from: 'ukraine', to: 'ural', min: 1, max: 1 } }), DAN, ANN)).toBe(false);
    expect(canAskPeace(table('turtle', { current: 2 }), DAN, ANN)).toBe(false);
    const humanTarget = table('turtle');
    humanTarget.players[2] = { ...humanTarget.players[2], kind: 'human' };
    expect(canAskPeace(humanTarget, DAN, 2)).toBe(false);
    expect(canAskPeace(table('turtle'), DAN, DAN)).toBe(false);
    // An AI does not ask.
    const aiAsks = table('turtle', { current: ANN });
    expect(canAskPeace(aiAsks, ANN, BEN)).toBe(false);
    reject(aiAsks, { type: 'askPeace', player: ANN, to: BEN });
    reject(table('turtle'), { type: 'askPeace', player: DAN, to: 99 });
  });

  it('even agrees at once: peace for three rounds, standing pinned to ally', () => {
    const s = table('opportunist');
    const r = act(s, { type: 'askPeace', player: DAN, to: ANN });
    expect(r.events[0]).toEqual({ type: 'peaceAnswered', from: ANN, to: DAN, accepted: true, rounds: 3, reason: 'Ann agrees · three rounds' });
    expect(r.events).toContainEqual({ type: 'standingChanged', ai: ANN, toward: DAN, standing: 'ally' });
    expect(r.state.diplomacy!.truces).toEqual([{ from: DAN, to: ANN, rounds: 3, kind: 'noAttack', since: 1, until: 5, peace: true }]);
    expect(standingOf(r.state, ANN, DAN)).toBe('ally');
    expect(standingReason(r.state, ANN, DAN)).toBe('Ann is your ally · peace until round 5');
    expect(truceSentence(r.state, r.events[0])).toBe('Ann agrees · three rounds');
    // Pinned: even a fresh loss does not move it.
    r.state.players[ANN].grudges = { [DAN]: 6 };
    expect(standingOf(r.state, ANN, DAN)).toBe('ally');
    // Not again while it holds.
    expect(canAskPeace(r.state, DAN, ANN)).toBe(false);
    expect(peaceAskBlock(r.state, DAN, ANN)).toBe('Ann is already at peace with you · until round 5');
  });

  it('ally agrees; hostile refuses with its reason; once per three rounds per seat', () => {
    expect(act(table('turtle', { lead: true }), { type: 'askPeace', player: DAN, to: BEN }).events[0]).toMatchObject({ accepted: true });
    const s = hurt(table('warlord'), 2);
    const r = act(s, { type: 'askPeace', player: DAN, to: ANN });
    expect(r.events).toEqual([{ type: 'peaceAnswered', from: ANN, to: DAN, accepted: false, rounds: 3, reason: 'Ann refuses · you took Egypt' }]);
    expect(r.state.rng).toBe(s.rng); // no draw: hostile always refuses
    expect(canAskPeace(r.state, DAN, ANN)).toBe(false);
    expect(peaceAskBlock(r.state, DAN, ANN)).toBe(`You asked Ann in round ${s.round} · ask again in round ${s.round + 3}`);
    const later = cloneState(r.state);
    later.round += 2;
    expect(canAskPeace(later, DAN, ANN)).toBe(false);
    later.round += 1;
    expect(canAskPeace(later, DAN, ANN)).toBe(true);
    // The leader is refused for leading.
    const lead = act(withRng(table('warlord', { lead: true }), 3), { type: 'askPeace', player: DAN, to: ANN });
    if (!(lead.events[0] as { accepted: boolean }).accepted) expect(lead.events[0]).toMatchObject({ reason: 'Ann refuses · you lead the table' });
  });

  it('wary agrees by personality: Turtle 0.7, Opportunist 0.4, Warlord 0.15 (state.rng)', () => {
    for (const [p, want] of [['turtle', 0.7], ['opportunist', 0.4], ['warlord', 0.15]] as [AiPersonality, number][]) {
      const base = table(p, { lead: true });
      expect(standingOf(base, ANN, DAN)).toBe('wary');
      let yes = 0;
      const N = 600;
      for (let k = 1; k <= N; k++) {
        const r = act(withRng(base, k * 7919), { type: 'askPeace', player: DAN, to: ANN });
        expect(r.state.rng).not.toBe(k * 7919); // one draw
        if ((r.events[0] as { accepted: boolean }).accepted) yes++;
      }
      expect(Math.abs(yes / N - want)).toBeLessThan(0.06);
    }
  });

  it('the AI keeps the peace: no attack on the human even when it would be easy', () => {
    let s = act(table('warlord', { lead: true }), { type: 'askPeace', player: DAN, to: BEN }).state;
    s = cloneState(s);
    s.currentPlayer = BEN;
    s.phase = { kind: 'attack' };
    s.territories.middle_east.armies = 1;
    s.territories.india.armies = 30;
    s.territories.afghanistan.armies = 1;
    s.territories.ural.armies = 1;
    s.conqueredThisTurn = false;
    for (let k = 0; k < 50 && s.currentPlayer === BEN && s.phase.kind !== 'game-over'; k++) {
      const a = chooseAiAction(s, BEN);
      if (a.type === 'blitz' || a.type === 'attack') expect(s.territories[a.to].owner).not.toBe(DAN);
      s = act(s, a).state;
    }
  });

  it('breaking the peace: peaceBroken first, hostile toward the breaker for the rest of the game, asking refused forever', () => {
    let s = act(table('opportunist'), { type: 'askPeace', player: DAN, to: ANN }).state;
    s.territories.southern_europe.armies = 20;
    const r = act(s, { type: 'blitz', player: DAN, from: 'southern_europe', to: 'egypt' });
    expect(types(r.events).slice(0, 3)).toEqual(['peaceBroken', 'standingChanged', 'diceRolled']);
    expect(r.events[0]).toEqual({ type: 'peaceBroken', by: DAN, against: ANN });
    expect(r.events[1]).toEqual({ type: 'standingChanged', ai: ANN, toward: DAN, standing: 'hostile' });
    expect(truceSentence(r.state, r.events[0])).toBe('Dan broke the peace with Ann');
    expect(r.state.diplomacy!.truces).toEqual([]);
    expect(r.state.diplomacy!.broken).toEqual([{ by: DAN, against: ANN, round: 1 }]);
    expect(types(r.events)).not.toContain('truceBroken');
    s = r.state;
    if (s.phase.kind === 'occupy') s = act(s, { type: 'occupy', player: DAN, count: s.phase.min }).state;
    s = act(s, { type: 'endTurn', player: DAN }).state;
    for (let k = 0; k < 40; k++) s = passTurn(s).state; // ten rounds: every grudge has faded
    expect(s.players[ANN].grudges?.[DAN] ?? 0).toBeLessThan(0.5);
    expect(standingOf(s, ANN, DAN)).toBe('hostile');
    expect(standingReason(s, ANN, DAN)).toBe('Ann is hostile · you broke the peace in round 1');
    while (s.currentPlayer !== DAN) s = passTurn(s).state;
    expect(canAskPeace(s, DAN, ANN)).toBe(false);
    expect(peaceAskBlock(s, DAN, ANN)).toBe('Ann is hostile · you broke the peace in round 1');
    reject(s, { type: 'askPeace', player: DAN, to: ANN });
  });

  it('peace runs out with time (truceExpired), and standing is read afresh', () => {
    let s = act(table('opportunist'), { type: 'askPeace', player: DAN, to: ANN }).state;
    s = act(s, { type: 'endTurn', player: DAN }).state;
    const seen: GameEvent[] = [];
    for (let k = 0; k < 20 && s.round < 5; k++) {
      const r = passTurn(s);
      seen.push(...r.events);
      s = r.state;
    }
    expect(seen).toContainEqual({ type: 'truceExpired', from: DAN, to: ANN, reason: 'time' });
    expect(standingOf(s, ANN, DAN)).toBe('even');
  });
});

describe('no truce offers to people; AI-AI understandings from standing', () => {
  it('an AI never proposes to a human, and the engine rejects it (config.diplomacy or not)', () => {
    for (const diplomacy of [false, true]) {
      const s = table('turtle', { current: ANN, lead: true, phase: { kind: 'reinforce', remaining: 3, mustTrade: false, placed: {}, midTurn: false } });
      s.config = { ...s.config, diplomacy };
      s.players[BEN] = { ...s.players[BEN], kind: 'human' };
      delete s.players[BEN].personality;
      expect(standingOf(s, ANN, BEN)).toBe('ally');
      expect(chooseTruceProposal(s, ANN)?.to).not.toBe(BEN);
      const a = chooseAiAction(s, ANN);
      if (a.type === 'proposeTruce') expect(a.to).not.toBe(BEN);
      reject(s, { type: 'proposeTruce', player: ANN, to: BEN, rounds: 3, kind: 'noAttack' });
    }
  });

  it('two AIs at ally toward each other form an understanding on their turn', () => {
    const s = table('turtle', { current: ANN, lead: true, phase: { kind: 'reinforce', remaining: 3, mustTrade: false, placed: {}, midTurn: false } });
    expect([standingOf(s, ANN, BEN), standingOf(s, BEN, ANN)]).toEqual(['ally', 'ally']);
    const a = chooseAiAction(s, ANN);
    expect(a).toEqual({ type: 'proposeTruce', player: ANN, to: BEN, rounds: 3, kind: 'noAttack' });
    const r = act(s, a);
    expect(types(r.events)).toEqual(['truceProposed', 'truceAccepted']);
    expect(truceSentence(r.state, r.events[1])).toBe('Ann and Ben have an understanding');
    // Not with a seat that is only even.
    const lvl = table('opportunist', { current: ANN, phase: { kind: 'reinforce', remaining: 3, mustTrade: false, placed: {}, midTurn: false } });
    expect(chooseTruceProposal(lvl, ANN)).toBeNull();
  });

  it('an understanding holds through even and ends at a turn boundary when a side turns wary', () => {
    let s = table('opportunist', { current: ANN, lead: true, phase: { kind: 'reinforce', remaining: 3, mustTrade: false, placed: {}, midTurn: false } });
    expect([standingOf(s, ANN, BEN), standingOf(s, BEN, ANN)]).toEqual(['ally', 'ally']);
    s = act(s, { type: 'proposeTruce', player: ANN, to: BEN, rounds: 3, kind: 'noAttack' }).state;
    expect(s.diplomacy!.truces).toHaveLength(1);
    // Ben took three of Ann's: Ann (Opportunist) is wary of Ben now.
    s.players[ANN].grudges = { [BEN]: 3 };
    s.players[ANN].lastTakenBy = { [BEN]: { territory: 'brazil', round: 1 } };
    expect(standingOf(s, ANN, BEN)).toBe('wary');
    const r = passTurn(s);
    const e = r.events.find((x) => x.type === 'truceExpired');
    expect(e).toEqual({ type: 'truceExpired', from: ANN, to: BEN, reason: 'standing' });
    expect(truceSentence(r.state, e!)).toBe('Ann turned on Ben');
    expect(r.state.diplomacy!.truces).toEqual([]);
    const t = types(r.events);
    expect(t.indexOf('truceExpired')).toBeLessThan(t.indexOf('turnStarted'));
  });

  it('standingChanged fires once per pair per change, at the turn boundary, and not for a steady band', () => {
    const s = table('opportunist');
    let r = passTurn(s);
    expect(r.events.filter((e) => e.type === 'standingChanged')).toEqual([]);
    const t = cloneState(r.state);
    t.players[ANN].grudges = { [DAN]: 4 };
    r = passTurn(t);
    expect(r.events.filter((e) => e.type === 'standingChanged' && e.ai === ANN)).toEqual([{ type: 'standingChanged', ai: ANN, toward: DAN, standing: 'hostile' }]);
    expect(passTurn(r.state).events.filter((e) => e.type === 'standingChanged' && e.ai === ANN && e.toward === DAN)).toEqual([]);
  });
});
