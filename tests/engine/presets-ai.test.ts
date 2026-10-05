// presets.ts hooks for the AI layer: the 2-player neutral seat and seat personalities (read when the
// New game draft carries them; absent = exactly the old config).
import { describe, expect, it } from 'vitest';
import { createGame } from '../../src/engine';
import { defaultDraft, draftToConfig, lengthEstimate, lengthRules, removeSeat, type NewGameDraft } from '../../src/game/presets';

function twoSeats(): NewGameDraft {
  return removeSeat(removeSeat(defaultDraft(), 3), 2);
}

describe('presets: neutral seat and personalities', () => {
  it('with the v3 rules switched off and no personalities, configs are as before (plus the map)', () => {
    const d = twoSeats();
    d.house = { ...d.house, neutral: false, truces: false };
    d.seats = d.seats.map(({ personality: _p, ...s }) => (void _p, s));
    const c = draftToConfig(d, 7);
    expect('neutral' in c).toBe(false);
    expect('diplomacy' in c).toBe(false);
    expect(c.mapId).toBe('classic');
    // v5.1 D: AI seats draw a personality at Start (random from the seed); humans never carry one.
    expect(c.players.filter((p) => p.kind === 'human').some((p) => 'personality' in p)).toBe(false);
    expect(lengthRules('evening', 2)).toEqual({ dominationPercent: 80, turnLimit: null });
  });

  it('2 players with the neutral seat use the 3-player thresholds and their own length row', () => {
    expect(lengthRules('quick', 2, true)).toEqual({ dominationPercent: 60, turnLimit: 12 });
    expect(lengthRules('evening', 2, true)).toEqual({ dominationPercent: 70, turnLimit: null });
    const d = twoSeats();
    (d.house as { neutral?: boolean }).neutral = true;
    const c = draftToConfig(d, 7);
    expect(c).toMatchObject({ neutral: true, dominationPercent: 70 });
    expect(createGame(c).state.players).toHaveLength(3);
    expect(lengthEstimate('evening', d.seats, true)).toMatch(/^~\d/);
    // Ignored for more than two seats.
    const four = defaultDraft();
    (four.house as { neutral?: boolean }).neutral = true;
    expect('neutral' in draftToConfig(four, 7)).toBe(false);
  });

  it("an AI seat's personality passes through; a human's never does", () => {
    const d = defaultDraft();
    (d.seats[1] as { personality?: string }).personality = 'warlord';
    (d.seats[0] as { personality?: string }).personality = 'turtle'; // seat 0 is human
    (d.seats[2] as { personality?: string }).personality = 'pacifist';
    const c = draftToConfig(d, 7);
    expect(c.players[1].personality).toBe('warlord');
    expect(c.players[0].personality).toBeUndefined();
    // an invalid one is dropped and drawn at random instead (v5.1 D)
    expect(['turtle', 'opportunist', 'warlord']).toContain(c.players[2].personality);
  });
});
