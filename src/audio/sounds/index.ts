// The sound registry: every SfxName → how it's built, how loud it sits, and how it behaves under load.
// Ink bank (docs/INK.md §6, A4, A5): five materials, nothing else.
//   paper  uiClick (the pitchless tick), uiError, cardDraw, cardTrade, turnStart, sheet, tick
//   brush  whoosh, place, unplace, march, hit (the breath of smoke), conquer (the flood; somber = snap)
//   wood   diceShake (dice in the cup), cupSlide (the cup passes), cupSet (the cup set down)
//   bone   diceLand (one die in the tray), bone (the AI's readable roll: one click)
//   bowl   continent, eliminated, victory
// uiHover is silent (no hover sounds). `trimDb` values are measured, not guessed: run the lab's
// "Analyze" (or `npm run verify:audio`), which suggests the trim that lands each sound on its tier.
//
// v4 (PLAN §4):
//  B1 one room: `wet` is a send into the score's hall (same impulse, shorter tap). Dice and paper
//     ticks stay mostly dry; bowls and the turn breath are wetter.
//  B2 effects are notes: `key` re-pitches a whole sound (the bowls) to a chord tone; `tone` adds a
//     tuned layer under paper/wood (turnStart, cardTrade, cupSet) at the chord's pitch.
//  B4 attacks: every voice fades in over `attack` (default 15 ms); 0 only for diceLand, bone and
//     the two bowls (continent, eliminated): the one sharp family.

import type { SfxMeta, SfxName, ToneLayer } from '../types';
import { bone, diceLand } from './bone';
import { continent, eliminated, victory } from './bowl';
import { conquer, hit, march, place, unplace, whoosh } from './brush';
import { cardDraw, cardTrade, sheet, tick, turnStart, uiClick, uiError, uiHover } from './paper';
import { cupSet, cupSlide, diceShake } from './wood';

/** A felt note (the score's piano colour, softened): fundamental and two soft overtones. */
const FELT: [number, number, number][] = [
  [1, 1, 0.45],
  [2, 0.32, 0.22],
  [3, 0.1, 0.12],
];
/** Turned wood: the cup's hollow ring (inharmonic, short). */
const WOOD: [number, number, number][] = [
  [1, 1, 0.2],
  [2.71, 0.28, 0.07],
  [4.6, 0.08, 0.035],
];

const TURN_TONE: ToneLayer[] = [
  // the sheet lifts and the room hears the chord: root or fifth near D4
  { role: 'bright', ref: 62, at: 0.1, amp: 0.085, partials: FELT, attack: 0.04 },
  // after AI turns, a second, higher note: the sheet lifts higher
  { role: 'bright', ref: 69, at: 0.2, amp: 0.05, partials: FELT, attack: 0.04, variants: ['bright'] },
];
const TRADE_TONE: ToneLayer[] = [{ role: 'bright', ref: 64, at: 0.3, amp: 0.07, partials: FELT, attack: 0.02 }];
const CUP_TONE: ToneLayer[] = [{ role: 'root', ref: 62, at: 0.004, amp: 0.12, partials: WOOD, attack: 0.015 }];

export const SFX: Record<SfxName, SfxMeta> = {
  uiHover: {
    fn: uiHover, label: 'Hover (silent)', group: 'UI', tier: 'micro', trimDb: -18, wet: 0,
    maxDur: 0.06, maxVoices: 1, minGapMs: 90, priority: 0, silent: true,
  },
  uiClick: {
    fn: uiClick, label: 'Paper tick (button)', group: 'UI', tier: 'tick', trimDb: -3.3, wet: 0.03,
    maxDur: 0.1, maxVoices: 2, minGapMs: 40, priority: 1, densityDb: 2, densityMaxDb: 4,
  },
  tick: {
    fn: tick, label: 'Paper tick (board)', group: 'UI', tier: 'tick', trimDb: -2.6, wet: 0.04,
    maxDur: 0.1, maxVoices: 3, minGapMs: 30, priority: 1, densityDb: 1.5, densityMaxDb: 5,
  },
  uiError: {
    fn: uiError, label: 'Refused (two pats)', group: 'UI', tier: 'ui', trimDb: -10.7, wet: 0.04,
    maxDur: 0.31, maxVoices: 1, minGapMs: 200, priority: 3,
  },
  whoosh: {
    fn: whoosh, label: 'Brush sweep (camera, arrow)', group: 'UI', tier: 'ui', trimDb: -6.5, wet: 0.1,
    maxDur: 0.67, maxVoices: 2, minGapMs: 150, priority: 1, duration: [0.2, 1.5, 0.6],
  },
  sheet: {
    fn: sheet, label: 'Sheet laid on (lift: off)', group: 'UI', tier: 'ui', trimDb: -2.7, wet: 0.06,
    maxDur: 0.5, maxVoices: 1, minGapMs: 150, priority: 2,
  },
  place: {
    fn: place, label: 'Ink dab (place)', group: 'Board', tier: 'board', trimDb: 8.4, wet: 0.06,
    maxDur: 0.21, maxVoices: 4, minGapMs: 40, priority: 2, densityDb: 1.5, densityMaxDb: 5,
  },
  unplace: {
    fn: unplace, label: 'Brush lift (take back)', group: 'Board', tier: 'board', trimDb: 8.3, wet: 0.06,
    maxDur: 0.17, maxVoices: 2, minGapMs: 40, priority: 2, densityDb: 1.5, densityMaxDb: 4,
  },
  march: {
    fn: march, label: 'Brush route (march)', group: 'Board', tier: 'board', trimDb: 4.1, wet: 0.08,
    maxDur: 0.63, maxVoices: 2, minGapMs: 80, priority: 2, densityDb: 2, densityMaxDb: 4,
    duration: [0.12, 1.2, 0.5],
  },
  cupSlide: {
    fn: cupSlide, label: 'Cup slides (turn passes)', group: 'Board', tier: 'ui', trimDb: -6.7, wet: 0.08,
    maxDur: 0.47, maxVoices: 1, minGapMs: 200, priority: 3, duration: [0.2, 1.0, 0.4],
  },
  cupSet: {
    fn: cupSet, label: 'Cup set down (in key)', group: 'Board', tier: 'board', trimDb: 1.6, wet: 0.16,
    maxDur: 1.45, maxVoices: 1, minGapMs: 300, priority: 4, tone: CUP_TONE,
  },
  diceShake: {
    fn: diceShake, label: 'Wood cup shake', group: 'Battle', tier: 'board', trimDb: -4.0, wet: 0.06,
    maxDur: 0.25, maxVoices: 1, minGapMs: 80, priority: 3, duration: [0.06, 1.5, 0.15], duckDb: 3,
  },
  diceLand: {
    fn: diceLand, label: 'Bone die lands', group: 'Battle', tier: 'die', trimDb: -0.5, wet: 0.06,
    maxDur: 0.17, maxVoices: 6, minGapMs: 12, priority: 3, densityDb: 0.8, densityMaxDb: 3,
    duckDb: 3, texture: true, attack: 0,
  },
  bone: {
    fn: bone, label: 'One bone click (AI roll)', group: 'Battle', tier: 'die', trimDb: -0.2, wet: 0.08,
    maxDur: 0.15, maxVoices: 2, minGapMs: 60, priority: 3, duckDb: 2, attack: 0,
  },
  hit: {
    fn: hit, label: 'Breath of smoke (a figure falls)', group: 'Battle', tier: 'board', trimDb: -10.7, wet: 0.12,
    maxDur: 0.45, maxVoices: 2, minGapMs: 70, priority: 3, densityDb: 2.5, densityMaxDb: 6, duckDb: 4,
  },
  conquer: {
    fn: conquer, label: 'Ink flood (somber: the snap)', group: 'Stingers', tier: 'cue', trimDb: -1.1, wet: 0.12,
    maxDur: 0.79, maxVoices: 2, minGapMs: 150, priority: 4, duckDb: 5, densityDb: 3, densityMaxDb: 6,
  },
  cardDraw: {
    fn: cardDraw, label: 'Sheet drawn', group: 'Cards', tier: 'board', trimDb: -0.2, wet: 0.05,
    maxDur: 0.31, maxVoices: 3, minGapMs: 70, priority: 2, densityDb: 1.5, densityMaxDb: 4,
  },
  cardTrade: {
    fn: cardTrade, label: 'Sheets fanned (trade, in key)', group: 'Cards', tier: 'cue', trimDb: 4.2, wet: 0.1,
    maxDur: 3.6, maxVoices: 1, minGapMs: 250, priority: 4, duckDb: 3, tone: TRADE_TONE,
  },
  turnStart: {
    fn: turnStart, label: 'Turn breath (sheet, in key)', group: 'Stingers', tier: 'board', trimDb: -2.6, wet: 0.2,
    maxDur: 3.4, maxVoices: 1, minGapMs: 400, priority: 4, duckDb: 2, tone: TURN_TONE,
  },
  continent: {
    fn: continent, label: 'Bowl · continent (in key)', group: 'Stingers', tier: 'swing', trimDb: 0.3, wet: 0.3,
    maxDur: 4.61, maxVoices: 1, minGapMs: 400, priority: 5, duckDb: 7, musical: true, attack: 0,
    key: { role: 'bright', ref: 69, somberRole: 'somber' },
  },
  eliminated: {
    fn: eliminated, label: 'Bowl · elimination (in key)', group: 'Stingers', tier: 'drama', trimDb: 0.3, wet: 0.32,
    maxDur: 5.01, maxVoices: 1, minGapMs: 600, priority: 6, duckDb: 12, musical: true, attack: 0,
    key: { role: 'somber', ref: 50 },
  },
  victory: {
    fn: victory, label: 'Bowl · victory (in key)', group: 'Stingers', tier: 'finale', trimDb: -0.4, wet: 0.32,
    maxDur: 6.61, maxVoices: 1, minGapMs: 2000, priority: 7, duckDb: 14, musical: true,
    key: { role: 'bright', ref: 74 },
  },
};
