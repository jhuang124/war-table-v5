// v5 G: the Missions house rule on the New game draft → GameConfig.missions, and the summary line.
import { describe, expect, it } from 'vitest';
import { buildNewGameVM, defaultDraft, draftSummary, draftToConfig, removeSeat, sanitizeDraft, type NewGameDraft } from '../../src/game/presets';

describe('Missions on the New game screen', () => {
  it('is off by default and leaves the config without it', () => {
    const d = defaultDraft();
    expect(d.house.missions).toBe(false);
    expect(draftToConfig(d, 1).missions).toBeUndefined();
    expect(draftSummary(d)).not.toMatch(/mission/);
    expect(sanitizeDraft({}).house.missions).toBe(false);
  });

  it('switched on, it reaches the config and the summary line names it', () => {
    const d = { ...defaultDraft(), house: { ...defaultDraft().house, missions: true } };
    expect(draftToConfig(d, 1).missions).toBe(true);
    expect(draftSummary(d)).toBe('Territories dealt at random · armies placed for you · first to 30 territories or a secret mission wins');
    expect(buildNewGameVM(d).missionsApply).toBe(true);
    expect(sanitizeDraft(JSON.parse(JSON.stringify(d))).house.missions).toBe(true);
  });

  it('needs a third seat: two players apply it only with neutral armies', () => {
    let d: NewGameDraft = { ...defaultDraft(), house: { ...defaultDraft().house, missions: true, neutral: true } };
    d = removeSeat(removeSeat(d, 3), 2);
    expect(buildNewGameVM(d).missionsApply).toBe(true); // neutral armies switched on (off by default since v5.1)
    expect(draftToConfig(d, 1).missions).toBe(true);
    const bare = { ...d, house: { ...d.house, neutral: false } };
    expect(buildNewGameVM(bare).missionsApply).toBe(false);
    expect(draftToConfig(bare, 1).missions).toBeUndefined();
    expect(draftSummary(bare)).not.toMatch(/mission/);
  });
});
