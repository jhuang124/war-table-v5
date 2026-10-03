// The one place the e2e suite is sorted (read by scripts/e2e.ts and by lib.ts's open()):
//   lane 'logic'  — no assertion on wall-clock tempo, fps or ms budgets under load. Runs in parallel (a
//                   worker pool, one shared Chromium per worker, a fresh context per open()) at INSTANT
//                   speed: animation speed 0 and AI 'instant', pinned by lib.ts.
//                   `realtime: true` keeps a logic flow at real speed (1×, AI watch): its checks need real
//                   animations (a blitz still rolling, an AI marker moving, a header's hold), and any
//                   wall-clock bound in it is a sanity bound with a wide measured margin, not a budget.
//   lane 'timing' — tempo, fps and ms budgets, and bounds with little margin. Runs after the logic lane, one
//                   flow at a time on the otherwise idle machine, at real speed, a fresh Chromium per open()
//                   (a cold GPU process, like a player's first load).
//   quick         — the `npm run test:e2e:quick` tier: smoke + a full human turn, setup, and resume.
// A flow file that isn't listed here runs in the timing lane (when unsure, timing) and the runner says so.

export type Lane = 'logic' | 'timing';

export interface FlowSpec {
  lane: Lane;
  /** Logic lane only: real speed instead of instant (still in parallel). */
  realtime?: boolean;
  /** In the quick tier. */
  quick?: boolean;
  /** Why it's in this lane: the assertions that decide it. */
  why: string;
}

export const FLOWS: Record<string, FlowSpec> = {
  // --- timing (serial; in this order) ------------------------------------------------------------------
  setup: { lane: 'timing', quick: true, why: 'manual setup, 1 human + 3 AIs at watch, ≤ 1 min in total (SPEC §10)' },
  keys: {
    lane: 'timing',
    why: 'AI narration and the marker sampled every 60 ms while watched AI turns run: display lag under load puts the last seat on the track (seen in a loaded run); Space mid-roll skips in < 700 ms',
  },
  budgets: { lane: 'timing', why: 'forced wait 0 on your own turn at 1× and rapid 60 ms stepper presses never dropped: tempo budgets' },
  rematch: { lane: 'timing', why: 'no board event > 3 s in the new game: the deal is designed at ≤ 2.5 s, so the bound has 0.5 s of slack' },
  feel: { lane: 'timing', why: 'worst frame ≤ 50 ms on the first roll after a cold load, click → line ≤ 50 ms, idle board 0 tweens' },
  ink: { lane: 'timing', why: 'one gold per frame over a real turn, plus a single roll ≤ 1.25 s and a blitz ≤ 3.0 s from __risk.metrics() (tempo budgets)' },
  round: { lane: 'timing', why: 'AI turn median ≤ 6 s and p95 ≤ 12 s at watch, a round of 3 AI turns ≤ 25 s, Start → first click ≤ 20 s' },
  game: {
    lane: 'timing',
    why: 'AI turn median/p95 at watch, single roll ≤ 1.26 s (measured 1.26 s), blitz ≤ 3.25 s, brief ≤ 0.86 s, camera ≤ 45°/s, Start → first click ≤ 20 s',
  },

  // --- logic, real speed (parallel) ----------------------------------------------------------------------
  autoplay: { lane: 'logic', realtime: true, why: 'all-AI game at AI fast: the marker must visit Place/Attack/Fortify (instant AI turns never move it)' },
  track: { lane: 'logic', realtime: true, quick: true, why: 'a full human turn on the Turn Track; the AI marker must move through Place → Attack (instant: Place only)' },
  polish: { lane: 'logic', realtime: true, why: 'the battle header never runs ahead of the board, sampled per frame over a real blitz (> 30 frames; 214 measured)' },
  chain: { lane: 'logic', realtime: true, why: '"Indonesia captured" held 600–1500 ms (measured ~850 ms) and the deal lines over 2.5 s need real animations' },
  flow: { lane: 'logic', realtime: true, quick: true, why: 'the blitz still animating at 350 ms, click-through < 700 ms (measured 5–50 ms); then resume by reload' },
  handoff: { lane: 'logic', realtime: true, why: 'zero frames of the next hand, sampled per mutation and frame across the real end-turn transition' },

  // --- logic, instant (parallel; roughly longest first, the pool's order until artifacts/e2e/timings.json exists)
  reasons: { lane: 'logic', why: 'every reason code: explain() and the line after a real click (the 2 s hold is a UI timer)' },
  hotseat: { lane: 'logic', why: 'manual setup, hand-off cover, forced + mid-turn trades, all humans out → watch to victory' },
  'mobile-sheets': { lane: 'logic', why: 'every sheet opens and dismisses, long-press, pinch, haptics' },
  'mobile-turn': { lane: 'logic', why: 'a full turn by taps on phone + tablet: layout, safe areas, target sizes' },
  ink2: { lane: 'logic', why: 'no rounded rectangles on any screen (3 form factors), the ensō over the current word; one real roll (realtime(page)) for the mid-roll count rings' },
  endgame: { lane: 'logic', why: 'menu, log, settings, End game now → victory → rematch (its autoplay only fills the ledgers)' },
  'mobile-flow': { lane: 'logic', why: 'phone screens by taps, rotation, victory, rematch' },
  smoke: { lane: 'logic', quick: true, why: 'title → new game → first turn: screens, seats, the Turn Track' },
  table: {
    lane: 'logic',
    why: 'v3 table cues: stacks drawn with their counts, the cup beside the current seat, one ledger line per event, a held continent inked in its holder, the turn banner ≤ 300 ms after the turn starts (instant speed: a sanity bound, the banner is set in the same frame)',
  },
  v4: { lane: 'logic', realtime: true, why: 'v4 audits: type scale and numeral floor, drift ≥ 1 px / 2 s, tier bands on a real fight, a pending truce never hides Place N' },
  v5: { lane: 'logic', realtime: true, why: 'v5 audits: the holding dab during Place, front lines + evening hooks, a human fight rolls, End game now builds a replay with ≤ 3 moments' },
  squint: { lane: 'logic', why: 'v3 squint guard: at 30 % scale, the five tallest stacks and the continent outlines out-contrast the washes (numbers reported)' },
  pwa: { lane: 'logic', why: 'manifest, service worker, offline boot (its own production build and server)' },
  surfaces: {
    lane: 'logic',
    why: 'v3 surfaces: the map picker and a game started and resumed on True World, AI personalities and grudges in the strip, a scripted AI → human truce offer (Accept / Decline, one gold per sampled frame), the grey neutral seat, "Update ready", True World stones clear of numerals and land',
  },
};

export type Speed = 'instant' | 'real';

/** The speed a flow runs at: the logic lane is instant unless the flow is marked realtime. */
export function speedOf(flow: string): Speed {
  const f = FLOWS[flow];
  return f && f.lane === 'logic' && !f.realtime ? 'instant' : 'real';
}

export function laneOf(flow: string): Lane {
  return FLOWS[flow]?.lane ?? 'timing';
}

export const QUICK = Object.keys(FLOWS).filter((f) => FLOWS[f].quick);
