// The Turn Track and the action zone (docs/ROUND2.md §A–B): segment states, locked reasons, the
// recommended segment, exactly one brass thing, the count control by range, and the occupy totals.
import { describe, expect, it } from 'vitest';
import { buildStrip, buildTrack, countVM, emptySel, trackLockReason, type Sel, type StripInput } from '../../src/game/strip';
import { board, card } from './fixtures';
import type { GameState, Phase } from '../../src/engine';

const reinforce = (remaining: number, o: Partial<Extract<Phase, { kind: 'reinforce' }>> = {}): Phase => ({ kind: 'reinforce', remaining, mustTrade: false, placed: {}, midTurn: false, ...o });
const strip = (s: GameState, sel: Sel = emptySel(), o: Partial<StripInput> = {}) =>
  buildStrip({ s, sel, interactive: true, narration: null, handoff: null, humansOut: false, idleLine: null, rejection: null, showWinChance: true, lineKey: 0, ...o });
const states = (s: GameState, sel: Sel = emptySel(), rolling = false) => buildTrack({ s, sel, live: true, rolling }).segments.map((x) => `${x.state}:${x.id}`);
/** Every brass fill on the strip: primary buttons plus the track's recommended segment when it's primary. */
const brass = (v: ReturnType<typeof strip>) => [...v.buttons.filter((b) => b.primary).map((b) => b.label), ...(v.track.primary ? [v.track.recommended] : [])];

describe('Turn Track states', () => {
  it('Place with armies left: forward segments locked, each with its reason', () => {
    const s = board({ ural: [0, 5] }, reinforce(3));
    expect(states(s)).toEqual(['current:place', 'locked:attack', 'locked:fortify', 'locked:endTurn']);
    expect(trackLockReason(s, emptySel(), 'attack')).toBe('Place your 3 armies first');
    expect(trackLockReason(s, emptySel(), 'endTurn')).toBe('Place your 3 armies first');
    expect(trackLockReason(board({ ural: [0, 5] }, reinforce(1)), emptySel(), 'fortify')).toBe('Place your 1 army first');
  });
  it('forced trade: locked and disabled; Trade cards +N is the only action', () => {
    const s = board({ ural: [0, 5] }, reinforce(3, { mustTrade: true }));
    s.players[0].cards = [card(0, 'infantry'), card(1, 'infantry'), card(2, 'infantry'), card(3, 'cavalry'), card(4, 'cavalry')];
    expect(trackLockReason(s, emptySel(), 'attack')).toBe('Trade cards first');
    const v = strip(s);
    expect(v.track.disabled).toBe(true);
    expect(v.buttons.map((b) => b.label)).toEqual(['Trade cards +4']);
    expect(brass(v)).toEqual(['Trade cards +4']);
  });
  it('all placed: Attack is recommended and the one brass thing (End turn when nothing can attack)', () => {
    const s = board({ ural: [0, 5] }, reinforce(0, { placed: { ural: 3 } }));
    const v = strip(s);
    expect(states(s)).toEqual(['current:place', 'eligible:attack', 'eligible:fortify', 'eligible:endTurn']);
    expect(v.track.recommended).toBe('attack');
    expect(brass(v)).toEqual(['attack']);
    expect(v.buttons.map((b) => b.label)).toEqual(['Undo']);
    const lonely = board({ ural: [0, 1] }, reinforce(0));
    expect(strip(lonely).track.recommended).toBe('endTurn');
    expect(strip(lonely).line).toBe('All placed · end your turn');
  });
  it('Attack: nothing is brass while fights remain; armed = Roll + brass Blitz; no attacks left → End turn', () => {
    const s = board({ ural: [0, 5] });
    expect(states(s)).toEqual(['done:place', 'current:attack', 'eligible:fortify', 'eligible:endTurn']);
    expect(brass(strip(s))).toEqual([]);
    const armed = strip(s, { ...emptySel(), selected: 'ural', target: 'siberia' });
    expect(armed.line).toMatch(/^Ural → Siberia · \d+% · (almost sure|likely|coin flip|long shot)$/);
    expect(armed.buttons.map((b) => b.label)).toEqual(['Roll', 'Blitz']);
    expect(brass(armed)).toEqual(['Blitz']);
    // At most one stake, biggest first, and never past 60 characters (docs/INK.md B2.11).
    const armedLine = (st: GameState, from: string, to: string, win = true) =>
      strip(st, { ...emptySel(), selected: from as never, target: to as never }, { showWinChance: win }).line;
    const ko = board({ kamchatka: [0, 6], alaska: [1, 1] });
    expect(armedLine(ko, 'kamchatka', 'alaska')).toMatch(/^Kamchatka → Alaska · \d+% · almost sure · knocks out Sam$/);
    const oz = board({ indonesia: [0, 6], new_guinea: [0, 1], western_australia: [0, 1] });
    // Long names: the word gives way to the stake (the number already says the odds)…
    expect(armedLine(oz, 'indonesia', 'eastern_australia')).toMatch(/^Indonesia → Eastern Australia · \d+% · takes Australia$/);
    // …but with the number hidden the word is the odds, so the stake goes instead.
    expect(armedLine(oz, 'indonesia', 'eastern_australia', false)).toBe('Indonesia → Eastern Australia · almost sure');
    expect(armedLine(ko, 'kamchatka', 'alaska', false)).toBe('Kamchatka → Alaska · almost sure · knocks out Sam');
    const brk = board({ siam: [0, 6], indonesia: [1, 1], new_guinea: [1, 1], western_australia: [1, 1], eastern_australia: [1, 1] });
    expect(armedLine(brk, 'siam', 'indonesia')).toMatch(/ · breaks Sam's Australia$/);
    for (const st of [ko, oz, brk]) for (const t of ['alaska', 'eastern_australia', 'indonesia']) expect(armedLine(st, 'kamchatka', t).length).toBeLessThanOrEqual(60);
    // Armed: the track is still all there, same words.
    expect(armed.track.segments.map((x) => x.label)).toEqual(['Place', 'Attack', 'Fortify', 'End turn']);
    const done = board({ ural: [0, 1] });
    expect(strip(done).track.recommended).toBe('endTurn');
    expect(brass(strip(done))).toEqual(['endTurn']);
  });
  it('a roll disables the track; recommending waits', () => {
    const s = board({ ural: [0, 1] });
    const v = buildTrack({ s, sel: emptySel(), live: true, rolling: true });
    expect(v.disabled).toBe(true);
    expect(v.recommended).toBeNull();
  });
  it('occupy: disabled, forward segments locked with the reason; Move N; totals once the count moves', () => {
    const s = board({ ural: [0, 16], siberia: [0, 0] }, { kind: 'occupy', from: 'ural', to: 'siberia', min: 3, max: 15, previousOwner: 2 });
    expect(states(s)).toEqual(['done:place', 'current:attack', 'locked:fortify', 'locked:endTurn']);
    expect(trackLockReason(s, emptySel(), 'endTurn')).toBe('Finish moving armies in first');
    const v = strip(s);
    expect(v.track.disabled).toBe(true);
    expect(v.line).toBe('Move into Siberia');
    expect(v.count).toEqual({ control: 'slider', value: 15, min: 3, max: 15, collapsed: true });
    expect(strip(s, { ...emptySel(), occupyCount: 15, countTouched: true }).count?.collapsed).toBeUndefined();
    const touched = strip(s, { ...emptySel(), occupyCount: 9, countTouched: true });
    expect(touched.line).toBe('Ural 7 · Siberia 9');
    expect(touched.buttons.map((b) => b.label)).toEqual(['Move 9']);
    // A board that draws the totals on the pieces keeps the instruction.
    expect(strip(s, { ...emptySel(), occupyCount: 9, countTouched: true }, { boardPreview: true }).line).toBe('Move into Siberia');
  });
  it('Fortify: End turn recommended; a pending move is the brass one, End turn only glows', () => {
    const s = board({ ural: [0, 5], ukraine: [0, 1] }, { kind: 'fortify' });
    expect(states(s)).toEqual(['done:place', 'done:attack', 'current:fortify', 'eligible:endTurn']);
    expect(brass(strip(s))).toEqual(['endTurn']);
    const pending = strip(s, { ...emptySel(), selected: 'ural', target: 'ukraine', fortifyCount: 4 });
    expect(pending.track.recommended).toBe('endTurn');
    expect(brass(pending)).toEqual(['Move 4 · end turn']);
    expect(pending.count).toEqual({ control: 'stepper', value: 4, min: 1, max: 4 });
  });
  it('setup: Setup · Done; Done locked until everything is staged, then recommended', () => {
    const s = board({ ural: [0, 1] }, { kind: 'setup-place', toPlace: 3 });
    s.round = 0;
    expect(states(s)).toEqual(['current:setup', 'locked:done']);
    expect(trackLockReason(s, emptySel(), 'done')).toBe('Place your 3 armies first');
    const staged: Sel = { ...emptySel(), staged: { ural: 3 }, placements: [{ t: 'ural', n: 3 }] };
    const v = strip(s, staged);
    expect(states(s, staged)).toEqual(['current:setup', 'eligible:done']);
    expect(v.line).toBe('All 3 placed · click Done');
    expect(brass(v)).toEqual(['done']);
  });
  it('watching: not live, the seat’s marker, no recommendation', () => {
    const s = board({ ural: [0, 5] });
    const v = strip(s, emptySel(), { interactive: false, narration: 'Priya attacks Siam' });
    expect(v.track.live).toBe(false);
    expect(v.track.recommended).toBeNull();
    expect(v.track.seat.name).toBe('John');
    expect(v.line).toBe('Priya attacks Siam');
  });
});

describe('count control by range', () => {
  it('≤ 6 options: stepper; more: slider', () => {
    expect(countVM(3, 3, 8).control).toBe('stepper');
    expect(countVM(3, 3, 9).control).toBe('slider');
    expect(countVM(1, 1, 6).control).toBe('stepper');
    expect(countVM(9, 1, 9).control).toBe('slider');
  });
});
