// Contract between the 3D renderer (src/render/**) and the game controller (src/game/**).
// The renderer implements `createBoardView` in src/render/index.ts. The controller only talks
// to the board through this interface.

import type { PlayerColorId, GameEvent, GameState, PlayerId, TerritoryId } from '../engine/types';
import type { BoardGeometry } from '../map/types';
import type { AudioEngine } from '../audio/types';

export interface BoardViewOptions {
  /** Element the WebGL canvas fills (position: absolute; inset: 0). */
  container: HTMLElement;
  geometry: BoardGeometry;
}

export interface BoardHighlights {
  /** Territories the player may click right now (subtle lift/glow). Others may dim if `dimOthers`. */
  selectable?: TerritoryId[];
  /** The chosen source territory (strong rim glow, raised). */
  selected?: TerritoryId | null;
  /** Valid targets for the selected source (pulsing outline). */
  targets?: TerritoryId[];
  /** A committed source → target pairing (attack arrow or fortify route). */
  arrow?: { from: TerritoryId; to: TerritoryId; kind: 'attack' | 'fortify'; path?: TerritoryId[] } | null;
  /** Staged/preview counts drawn as "+N" beside the token (only while a placement is staged). */
  pending?: Partial<Record<TerritoryId, number>>;
  dimOthers?: boolean;
  /**
   * Additive (v4, PLAN §3 A4 "losing leaves a mark"): territories a human seat lost since its last turn, each
   * with the loser's colour. The renderer draws a thin ring (edge ladder: Hair weight, the seat's pigment)
   * around the stone; the controller clears an entry when that loser's next turn ends.
   */
  loserRings?: { territory: TerritoryId; color: PlayerColorId }[];
  /**
   * Additive (v4, PLAN §3 A3 the receipt): territories to pulse once (a tier-0 swell of the stone and a brief
   * lift of the wash), as a receipt line writes. The renderer plays the pulse when the array changes and
   * does not hold any state for it.
   */
  pulse?: TerritoryId[];
  /**
   * Additive (v5 B "front lines"): draw borders between two different owners at medium weight as a split stroke
   * in both pigments; borders inside one owner's land stay hairlines. Default on when absent in v5 builds.
   */
  frontLines?: boolean;
}

export interface TerritoryPointerInfo {
  territory: TerritoryId;
  /** Client-space pixel position of the pointer. */
  clientX: number;
  clientY: number;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  /** 0 = primary, 2 = secondary (context menu is suppressed on the canvas). */
  button: number;
}

export interface BoardStats {
  fps: number;
  frameMsP95: number;
  drawCalls: number;
  triangles: number;
  activeTweens?: number;
  cameraMoving?: boolean;
  particles?: number;
  /**
   * Additive (controller builder): the fastest automatic camera rotation seen so far, in °/s (SPEC §10:
   * ≤ 45). Read by __risk.metrics().maxCameraDegPerSec.
   */
  maxCameraDegPerSec?: number;
  /**
   * Additive (renderer, mobile pass): frames actually drawn per second. The board renders on demand
   * (docs/MOBILE.md §7): 0 while nothing animates or moves; `fps` is still the rAF rate.
   */
  drawnFps?: number;
  /** Additive (renderer, mobile pass): the canvas pixel ratio in use (capped at 2; 1.5 on a struggling touch GPU). */
  pixelRatio?: number;
  /** Additive (renderer, mobile pass): the WebGL context is lost and the board is rebuilding. */
  contextLost?: boolean;
  /**
   * Additive (renderer, ink overhaul; docs/INK.md A1): the living-calm layer is running (setAmbient on and
   * not reduced motion). It runs off its own clock, never as tweens: `activeTweens` counts gameplay only.
   */
  ambientOn?: boolean;
  /** Additive (renderer, ink overhaul): the calm's current amplitude — 1 at rest, 0.5 yielding to gameplay, 0 off. */
  ambientLevel?: number;
}

export interface PlayEventOptions {
  /**
   * 'full' (default): dice tray + full timings. 'brief': AI-vs-AI; no dice, <= 0.8 s per engagement.
   * 'readable' (v4, _claude/v4/PLAN.md §8a Q7): every AI engagement, never the dice show. One steady beat a
   * person can follow: the stroke draws, a short bone click stands in for the roll, the verdict flood, the
   * sentence completes. No snapping, no wall-clock stall. Target ≈ 900 ms per engagement at 1×.
   */
  style?: 'full' | 'brief' | 'readable';
  /**
   * Additive (v4, PLAN §5b E5 "one motion ladder"): the stakes tier the controller assigned this event.
   * 0 tick (160–290 ms) · 1 stroke (400–650) · 2 soak (650–1200) · 3 breath (1600–2400). The renderer keeps
   * the event's motion inside the tier's band; the audit in tests/e2e checks it. Absent = the renderer's
   * own default for the event type (the v3 numbers).
   */
  tier?: 0 | 1 | 2 | 3;
  /**
   * Additive (v5 A "the fight is a moment"): ms between dice landing in a full roll (60–90). The renderer
   * lands them one at a time, each with its own bone click, inside the existing roll budget. Absent = at once.
   */
  stagger?: number;
  /**
   * For consecutive diceRolled events of one engagement (blitz or repeated rolls): 0-based index and
   * total count, so the renderer can compress to the blitz cap and slow the final roll.
   */
  seq?: { index: number; count: number };
  /**
   * Additive (controller builder): set on an `armiesMoved` (reason 'occupy') that follows its conquest
   * with no human choice in between (the AI's occupy, or an engine auto-occupy). It IS the conquest's
   * march (UX.md §6.1, §8.2 "Conquest ~650 ms … march starting at +150"), not a separate 400 ms move:
   * fold it into the running conquest animation and resolve as soon as the token lands.
   */
  inlineMarch?: boolean;
  /**
   * Additive (controller, ink overhaul; docs/INK.md A5 "losing stings"): set on a `territoryConquered` whose
   * previous owner is a human seat at the table, and on a `playerEliminated` of a human seat. The renderer
   * plays the sting there: the torn, dark flood rim and the brush snap on contact (the elimination sweep for
   * a knockout). Absent = an AI lost it: the plain flood.
   */
  sting?: boolean;
}

/**
 * HUD-covered edges in CSS px. The home view frames the land inside the rest (docs/SIMPLIFY.md §1).
 * `bottom` is the bottom strip only. The dice tray shows during fights in a band of height `trayBand`
 * just above it, centred in the band (0 = the board's own default band); the home view does NOT
 * reserve that band — it only lifts the land if a token would sit under the tray. (A `bottom` that
 * already includes the band, the round-1 convention, is recognised when bottom ≥ trayBand + 40.)
 */
export interface ViewportInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
  trayBand: number;
  /**
   * Additive (renderer, round 2): the floating HUD's persistent rectangles in container px (seat chips,
   * `≡`, the bottom strip — not transient pills like `Reset view`, which only shows away from home).
   * When given, the home view fits the land and every piece around these rectangles (12 px clear) instead
   * of full-width top/bottom bands, so the board can run up between the corner pills. `top`/`bottom` are
   * still used for the principal point, the dice tray's position (`bottom` = the strip's top edge) and the
   * AI's on-screen checks.
   */
  rects?: { x: number; y: number; w: number; h: number }[];
}

export interface BoardView {
  /** Snap the whole board to `state` with no animation (load, resume, after a skip). */
  syncState(state: GameState): void;
  /**
   * Animate one event. Resolves when its animation finishes (immediately at speed 0).
   * The renderer keeps its own displayed owners/armies and updates them as the event plays,
   * so after the promise resolves the board matches the state right after this event.
   * `stateAfter` is the final state of the whole action batch, for reference only.
   */
  playEvent(event: GameEvent, stateAfter: GameState, opts?: PlayEventOptions): Promise<void>;
  /** 1 = normal, 2 = fast, 0 = instant (no tweens; resolve at once). */
  setAnimationSpeed(multiplier: number): void;
  /** Finish every running animation immediately. */
  skipAnimations(): void;

  setHighlights(h: BoardHighlights): void;
  onTerritoryClick(cb: (info: TerritoryPointerInfo) => void): void;
  onTerritoryHover(cb: (info: TerritoryPointerInfo | null) => void): void;

  /** Ease the camera to frame these territories. Empty array = whole board. */
  focusTerritories(ids: TerritoryId[], opts?: { durationMs?: number }): void;
  resetCamera(): void;
  /** Slow cinematic orbit for the title screen / victory. */
  setAttractMode(on: boolean): void;
  /**
   * Settings "Territory names": every name on. Off (the default) still shows the hovered tile's name
   * and the picked source / armed target's (`selected`, `arrow.from`, `arrow.to`).
   */
  setShowLabels(on: boolean): void;
  /** Tell the board which screen edges the HUD covers (re-sent on resize / text-size change). */
  setViewportInsets(insets: ViewportInsets): void;
  /** UI text-size multiplier (1, 1.25, 1.5) for the army tokens (softened), the dice tray and DOM names. */
  setUiScale(scale: number): void;

  /**
   * Additive (renderer builder): effective reduced-motion flag (settings.reduceMotion ||
   * prefers-reduced-motion). Steady outlines instead of pulses, no automatic camera moves (200 ms
   * crossfade cuts instead), dice fade in on their faces, the flood becomes a 250 ms crossfade.
   * Defaults to the `prefers-reduced-motion` media query until called.
   */
  setReducedMotion?(on: boolean): void;
  /**
   * Additive (renderer builder): hand the board the audio engine so motion-bound SFX land on their
   * contact frames. When set, the BOARD plays: place, unplace, diceShake, diceLand, hit, conquer,
   * march, whoosh (and calls audio.stopAll() inside skipAnimations). The controller must NOT play
   * those; it keeps turnStart, cardDraw, cardTrade, continent, eliminated, victory and UI sounds.
   * null = the board stays silent.
   */
  setAudio?(audio: AudioEngine | null): void;
  /** Additive (renderer builder): settings.autoCamera — return home at turn start if displaced. Default true. */
  setAutoCamera?(on: boolean): void;

  /**
   * Additive (renderer, round 2): true while the player has orbited / panned / zoomed away from the home
   * view (drives the HUD's `Reset view` pill; resetCamera() returns home and clears it). Automatic camera
   * moves (AI framing, the attract orbit) never count.
   */
  isViewDisplaced?(): boolean;
  /** Additive (renderer, round 2): called whenever isViewDisplaced() changes. */
  onViewDisplacedChange?(cb: (displaced: boolean) => void): void;
  /**
   * Additive (renderer, round 2): the board answers a phase change, no camera move (docs/ROUND2.md §A):
   * 'attack' — the player's tiles that can attack lift slightly and their rims sweep west → east (~0.9 s);
   * 'fortify' — every other player's tiles dim ~20 % until 'end' / 'attack' / the next turnStarted;
   * 'end' — clears all of it. Every call also fades out the battle tray (unless a roll is running).
   * `player` defaults to the current player of the last state; `territories` overrides the attack set.
   */
  pulsePhase?(phase: 'attack' | 'fortify' | 'end', opts?: { player?: PlayerId; territories?: TerritoryId[] }): void;
  /**
   * Additive (renderer, round 2): the battle tray became visible (true) or started its fade-out (false),
   * so the HUD's battle header can fade in lockstep (tray fades 300 ms, ~1 s after a decided fight).
   */
  /**
   * The dice tray showed / hid. Additive (v4): when visible on desktop the ring sits beside the fight, and `rect`
   * is its box in container CSS px so the HUD's fight header can ride on it; absent = the fixed band.
   */
  onTrayChange?(cb: (visible: boolean, rect?: { x: number; y: number; w: number; h: number; header?: 'above' | 'below' }) => void): void;
  /**
   * Additive (v5 A): lean the camera toward `territories` (eased, at most `amount` board widths, default 0.15,
   * never a cut) and cool the paper around them a shade for the fight; `leanBack()` returns both over ~600 ms.
   * No-ops when the user has moved the camera. Reduced motion: the paper cools, the camera stays.
   */
  leanTo?(territories: TerritoryId[], o?: { amount?: number }): void;
  leanBack?(): void;
  /**
   * Additive (v5 A, fight builder): `rect.header` on onTrayChange is the side of the ring the fight header should
   * ride ('above' | 'below'), chosen with the ring so neither covers a name, numeral or stone; absent = the HUD's
   * own rule. And `onFightCount`: the fight's counts as each compared pair's verdict lands in a full roll (and
   * once at a blitz roll's verdict), so the header can tick down with the dice instead of at the roll's end.
   */
  onFightCount?(cb: (c: { from: TerritoryId; to: TerritoryId; attackerArmies: number; defenderArmies: number }) => void): void;

  /**
   * Additive (renderer, mobile pass; docs/MOBILE.md §3): a touch long-press (400 ms, one finger, not moved)
   * on a territory — or on open water within ~22 px of one — calls `cb` with that territory and the
   * finger's client position, so the HUD can show the name card above the finger. Sliding the held finger
   * calls it again for each tile it moves onto; lifting (or a second finger / a cancel) calls `cb(null)`.
   * A long-press never selects (no onTerritoryClick). Mouse input never fires it.
   */
  onTerritoryLongPress?(cb: (info: TerritoryPointerInfo | null) => void): void;
  /**
   * Additive (renderer, mobile pass; docs/MOBILE.md §7): the WebGL context was lost (`true`: show a quiet
   * `Reloading the board…`) or the board has been rebuilt and has drawn again (`false`: hide it). The
   * canvas shows the far-ocean colour meanwhile, never white. Game state, pending playEvent promises and
   * highlights are unaffected.
   */
  onContextLoss?(cb: (lost: boolean) => void): void;

  /**
   * Additive (lead, ink overhaul; docs/INK.md A2) — draw-to-attack. The controller says which territories
   * may start a stroke right now (empty array = strokes off) and, for each, which territories it may end on.
   * A pointer-down on a source followed by a drag draws a live brush stroke that follows the pointer (and
   * takes precedence over pan for that gesture); other drags pan as before; taps are unaffected.
   */
  setStrokeSources?(sources: TerritoryId[], targetsOf: (source: TerritoryId) => TerritoryId[]): void;
  /**
   * Additive (lead, ink overhaul): stroke lifecycle. `to` is the eligible target currently under the pointer
   * (null if none). `done: false` while dragging; `done: true` once on release — then `to` non-null means
   * "arm this attack" (the controller arms it exactly like a target-first tap; the stroke settles into the
   * attack arrow) and `to` null means cancelled (the stroke dries out). A stroke never commits a roll.
   */
  onStroke?(cb: (s: { from: TerritoryId; to: TerritoryId | null; done: boolean }) => void): void;
  /** Additive (lead, ink overhaul; docs/INK.md A1): ambient "living calm" layer on/off (off under reduced motion). */
  setAmbient?(on: boolean): void;
  /**
   * Additive (renderer, v3 physical board; _claude/v3/PLAN.md §1 "occupy preview = a ghost stack"): the totals
   * a count being chosen would leave (occupy / fortify: source and target), drawn as ghost stacks at that
   * height; null clears them. The controller already sends it when the board has it (PreviewBoard).
   */
  setCountPreview?(totals: Partial<Record<TerritoryId, number>> | null): void;
  /**
   * Additive (renderer, v4 board paper; _claude/v4/PLAN.md §5 "drift you can see"), a test hook: waits `ms`
   * (default 2000) of real time and reports how far the paper drifted over that window at the home view, in CSS
   * px: `mistPx` = the median displacement of points on the sea veils' edges, `glowPx` = the median drift of the
   * coast glow; `clockS` = the ambient seconds that passed (half speed after 3 min idle, 0 under reduced motion).
   */
  paperDrift?(ms?: number): Promise<{ mistPx: number; glowPx: number; clockS: number; pxPerUnit: number; samples: number; driftPx?: number }>;
  /**
   * Additive (v5 B "the evening deepens"): the game's clock, 0 = dusk … 1 = night. By default the board takes it
   * from `state.round` (round 1 → 0, round 12+ → 1) and never steps back within a game; a number here overrides
   * that, `null` hands it back to the round. (paperDrift's `driftPx`, additive: the idle camera drift, CSS px.)
   */
  setEvening?(t: number | null): void;
  /**
   * Additive (v5 B "water that remembers"): a fight's first roll crossed the sea lane `from`–`to` and it glinted.
   * The board already plays `audio.cue('glint')` when it has the audio engine; this is for anything else.
   */
  onLaneGlint?(cb: (from: TerritoryId, to: TerritoryId) => void): void;

  /**
   * Screen position (client px) of a territory's army piece — the top centre of its base, which is always
   * on the territory's own tile (click it to select) — or null if off-screen.
   */
  getScreenPosition(t: TerritoryId): { x: number; y: number } | null;
  getStats(): BoardStats;
  dispose(): void;
}

export type CreateBoardView = (opts: BoardViewOptions) => Promise<BoardView>;
