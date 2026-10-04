// The HTML UI (docs/SIMPLIFY.md): renders the ViewModel, sends UiIntents, never imports the engine.
//
// In game the only chrome is ink on the paper (docs/INK.md B5): the seat rings + the ensō menu at the
// top; at the bottom the one line, the gold rule with the game's ensō, and the Turn Track pill with the
// action pills; during a fight, the dice tray's header words. The breath line, the cards sheet, the
// hand-off cover and the menu sheets come and go.
// v5: on victory the replay strip (the war re-soaked round by round) comes first and the recap waits for it;
// the holding dab sits beside the seat mark; grudge ticks and voice lines live on the seat rings.
//
// Rendering: each component keeps its elements and patches them; every level short-circuits on
// ViewModel identity (the controller keeps unchanged subtrees identical), so an idle frame costs a few
// reference compares and no DOM writes.

// One family (INK B3). index.html preloads the same files with font-display: block; this import also
// covers pages without that head (the UI gallery).
import '@fontsource-variable/cormorant-garamond/wght.css';
import '@fontsource-variable/cormorant-garamond/wght-italic.css';
import './styles.css';
import './mobile.css';
import type { GameVM, MountUi, Screen, SeatChipVM, StripVM, UiIntent, ViewModel } from '../game/viewModel';
import type { ViewportInsets } from '../render/BoardView';
import { h, hashSeed, motion, setAttr, toggle } from './dom';
import { boardTrayGeometry as trayGeometry, inkTrayTop } from '../shared/tray';
import { Announcements } from './hud/announce';
import { BattleHeader } from './hud/battle';
import { CardsSheet } from './hud/cards';
import { BottomStrip } from './hud/strip';
import { TopStrip } from './hud/topstrip';
import { Confirm, Handoff, Overlays } from './overlays';
import { NewGameScreen } from './screens/newgame';
import { TitleScreen } from './screens/title';
import { VictoryScreen } from './screens/victory';
import { effectiveUiScale, isFitted } from './uiScale';
import { installLayout, layout, onLayout } from './layout';
import { NameCard, RotatePill } from './hud/mobile';
import { Replay } from './hud/replay';
import { resetSheet, sheetDrop, sheetLift } from './sheet';

/**
 * Dice-tray band, just above the bottom strip. The renderer centres its tray in the band
 * (src/shared/tray.ts). Only the header line sits above the tray (nothing below it), so the band is the
 * tray plus the header's height and a small gap, split evenly; the header's bottom sits on the tray's top
 * edge and may rise a few px above the band. Returns the band, the header height (`strip`) and the
 * distance from the band's bottom to the tray's top (`trayTop`), in CSS px.
 */
export function solveBand(H: number, scale: number, W = typeof window !== 'undefined' ? window.innerWidth : 1440): { band: number; strip: number; trayTop: number } {
  const rem = 16 * scale;
  const need = Math.ceil(Math.max(0.022 * H, 1.0625 * rem) * 1.6);
  const cap = Math.round(H * 0.34);
  let band = 96;
  for (; band <= cap; band += 2) if (band - trayGeometry(W, H, band, scale).trayH >= need + 8) break;
  band = Math.min(band, cap);
  const trayH = trayGeometry(W, H, band, scale).trayH;
  const margin = Math.floor((band - trayH) / 2);
  return { band, strip: need, trayTop: margin + trayH };
}

/** A line arriving over a visible one waits this long: the old one dries (160 ms), then the paper is still. */
const SLOT_CLEAR_MS = 250;

/**
 * The one seat still holding ground once every other is gone: the world is held, the victory beat is
 * playing (the displayed board already shows it; the scroll hasn't risen yet). Null otherwise, and
 * always null in setup, where empty seats are just waiting for their first pick.
 */
function worldHolder(g: GameVM): SeatChipVM | null {
  if (g.strip.track.kind !== 'turn' || g.seats.length < 2) return null;
  let holder: SeatChipVM | null = null;
  for (const c of g.seats) {
    if (c.territories <= 0) continue;
    if (holder) return null;
    holder = c;
  }
  return holder;
}

interface Instance {
  newGame: NewGameScreen;
  victory: VictoryScreen;
}
let current: Instance | null = null;

/** Gallery / test hook: poke local-only UI state (house rules drawer, victory intro). */
export function uiDebug() {
  const c = current;
  return {
    openHouseRules: () => c?.newGame.setHouseOpen(true),
    skipVictoryIntro: () => c?.victory.showFull(),
  };
}

export const mountUi: MountUi = (host, api) => {
  const boot = host.querySelector('#boot-splash') as HTMLElement | null;
  const root = h('div', 'ui-root');
  // The sheets' paper is the board's own paper fibre (public/tex), resolved against the build's base.
  // Absolute: a relative url() inside a custom property resolves against the stylesheet that uses it
  // (assets/…css in a build), not the page.
  root.style.setProperty('--paper-tex', `url("${new URL(`${import.meta.env.BASE_URL}tex/paper-512.webp`, document.baseURI).href}")`);
  host.append(root);
  const send = (i: UiIntent) => api.intent(i);

  // ---- components ---------------------------------------------------------
  const hud = h('div', 'hud');
  const top = new TopStrip(send);
  const strip = new BottomStrip(send);
  const battle = new BattleHeader();
  const announce = new Announcements();
  const cards = new CardsSheet(send);
  // Always-laid-out twin of the tray band, so the insets are right while the header is hidden.
  const bandProbe = h('div', 'band-probe');
  bandProbe.setAttribute('aria-hidden', 'true');
  // Phones only (docs/MOBILE.md): the one-time rotate hint and the long-press name card.
  const rotate = new RotatePill();
  const nameCard = new NameCard();
  hud.append(top.el, battle.el, strip.el, cards.scrim, cards.el, bandProbe, nameCard.el);
  // The breath line and the rotate hint sit on the paper exactly where the strip's line does.
  strip.el.querySelector('.st-say')!.append(announce.el, rotate.el);
  // One line in the slot, ever (INK B4: one thing moves at a time). While a breath / epitaph line or the
  // rotate hint is on the paper, the strip's own line steps aside (it dries in 160 ms, easeInQuad); a
  // line arriving over a visible one brushes in only after that has gone and the paper has been still.
  const say = { announce: false, hint: false };
  // Phone landscape floats the breath line above the dock instead (mobile.css), so nothing to clear.
  const sayInSlot = () => !(layout.form === 'phone' && !layout.portrait);
  const syncSay = () => {
    toggle(root, 'has-say', say.announce || say.hint);
    strip.setLineAside((say.announce || say.hint) && sayInSlot());
  };
  const slotShowing = () => sayInSlot() && (!root.classList.contains('has-say') || rotate.busy);
  announce.onShow = (on) => {
    const wait = on && !say.announce && slotShowing() ? SLOT_CLEAR_MS : 0;
    say.announce = on;
    syncSay();
    return wait;
  };
  rotate.onShow = (on) => {
    say.hint = on;
    syncSay();
  };
  // The hint only speaks into a quiet moment of a human's own turn: never over a turn line, a fight,
  // a hand-off, a sheet or a moved view, and never once the game is decided.
  const hintQuiet = (v: ViewModel) => {
    const g = v.game;
    return v.screen === 'game' && !v.overlay && !!g && !g.banner && !g.receipt && !g.handoff && !g.confirm && !g.viewMoved && !g.battle && !g.cards?.open && g.strip.track.live && !worldHolder(g);
  };
  installLayout();

  const title = new TitleScreen(send);
  const newGame = new NewGameScreen(send);
  const victory = new VictoryScreen(send);
  const handoff = new Handoff(send);
  const overlays = new Overlays(send);
  const confirm = new Confirm(send);
  // "While you were away" (v4 A3): a paper sheet on the board over the HUD (and over a hand-off cover).
  // The war in ink (v5 C): the end-of-game time-lapse's paper strip; the recap is held back while it plays.
  const replay = new Replay(send);
  // A lost WebGL context (mobile GPUs drop it under memory pressure): a quiet pill while the board rebuilds.
  const lost = h('div', 'board-lost hidden', 'Reloading the board…');
  lost.setAttribute('role', 'status');
  lost.dataset.testid = 'board-lost';
  root.append(hud, title.el, newGame.el, victory.el, handoff.el, replay.el, overlays.el, confirm.el, lost);
  current = { newGame, victory };

  const screens: Partial<Record<Screen, HTMLElement>> = { title: title.el, newGame: newGame.el, victory: victory.el };
  for (const el of Object.values(screens)) el!.classList.add('off');
  hud.classList.add('off');

  // ---- screens: the old one dries (240 ms), the new one is brushed in -------
  let screen: Screen | null = null;
  const showScreen = (next: Screen) => {
    if (next === screen) return;
    const prev = screen;
    screen = next;
    const outEl = prev === 'game' ? hud : prev ? screens[prev] : null;
    const inEl = next === 'game' ? hud : screens[next];
    if (outEl && outEl !== inEl) {
      outEl.getAnimations().forEach((a) => a.cancel());
      if (motion.reduced || prev === 'boot') outEl.classList.add('off');
      else {
        outEl.classList.add('leaving');
        const a = outEl.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 240, easing: 'cubic-bezier(0.11, 0, 0.5, 0)', fill: 'forwards' });
        a.onfinish = () => {
          if (screen !== prev) outEl.classList.add('off');
          outEl.classList.remove('leaving');
          a.cancel();
        };
      }
    }
    if (inEl) {
      inEl.getAnimations().forEach((a) => a.cancel());
      inEl.classList.remove('off', 'leaving');
      if (!motion.reduced && prev) inEl.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, delay: 80, easing: 'cubic-bezier(0.2, 0.9, 0.2, 1)', fill: 'backwards' });
    }
    // New game is a sheet of paper laid on the board from the top edge, and lifted off it again (v4 E8).
    const ng = newGame.el.querySelector<HTMLElement>('.ng-sheet');
    if (ng && layout.form !== 'phone') {
      if (next === 'newGame' && prev && prev !== 'boot') sheetDrop(ng);
      else if (prev === 'newGame') sheetLift(ng, null, () => resetSheet(ng));
    }
    if (next === 'newGame') requestAnimationFrame(() => screen === 'newGame' && !vm?.overlay && newGame.focusFirstName());
    if (next !== 'boot' && boot) {
      const b = boot;
      b.animate([{ opacity: getComputedStyle(b).opacity }, { opacity: 0 }], { duration: 240, fill: 'forwards' }).onfinish = () => b.remove();
    }
  };

  // ---- viewport insets: the top strip, the bottom strip, the tray band above it ---------------------
  let lastInsets = '';
  let scale = 1;
  const measure = () => {
    const H = window.innerHeight;
    const W = window.innerWidth;
    const solved = solveBand(H, scale, W);
    let { band, trayTop } = solved;
    const headerStrip = solved.strip;
    // Portrait phones fold the dock's action row away when there's nothing to press; the board keeps
    // the room for it anyway, so the home view never jumps as buttons come and go.
    const zone = strip.el.querySelector<HTMLElement>('.st-zone');
    const folded = layout.stacked && !!zone?.classList.contains('is-empty');
    const reserve = folded ? Math.round((layout.form === 'phone' ? 3 : 3.125) * 16 * scale + (layout.form === 'phone' ? 6 : 8)) : 0;
    const st0 = strip.el.getBoundingClientRect();
    const dockTop = st0.top - reserve;
    const bottomEdge = Math.round(H - dockTop + 4);
    // The board reads a `bottom` of ≥ band + 40 as the round-1 convention (band folded into bottom) and
    // subtracts the band. The portrait phone dock is that tall on its own, so the band grows to stay
    // clear of that rule; the tray stays centred in it and the header follows (same geometry).
    if (bottomEdge >= band + 40) band = bottomEdge - 39;
    // The header rests on the tray the board draws (src/shared/tray.ts places it; the renderer uses the same rule).
    trayTop = inkTrayTop(W, H, band, scale);
    root.style.setProperty('--tray', `${band}px`);
    root.style.setProperty('--strip', `${headerStrip}px`);
    root.style.setProperty('--tray-top', `${trayTop}px`);
    // The real HUD edges: the bottom of the top pills, the top of the floating strip.
    let topEdge = 0;
    for (const el of top.el.querySelectorAll<HTMLElement>('.seat-chip, .ts-menu')) {
      if (el.offsetParent === null) continue;
      topEdge = Math.max(topEdge, el.getBoundingClientRect().bottom);
    }
    if (!topEdge) topEdge = top.el.getBoundingClientRect().bottom;
    const st = strip.el.getBoundingClientRect();
    // Phones: the dock's height varies (two rows in portrait), so the tray band and its header sit on
    // its measured top edge rather than the desktop constant.
    root.style.setProperty('--dock-clear', `${Math.max(0, Math.round(H - dockTop))}px`);
    // The persistent floating HUD as rectangles (seat pills, ≡, the strip; not the transient Reset view
    // pill), so the home view can run the board up between the corner pills.
    const rects: { x: number; y: number; w: number; h: number }[] = [];
    const rectOf = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) rects.push({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
    };
    const seatsRow = top.el.querySelector('.ts-seats');
    const menuPill = top.el.querySelector('.ts-menu');
    if (layout.form === 'phone') {
      // Phones: the pills and ≡ go in as one full-width top band. On a 343 px landscape screen the board's
      // fit between the corner pills put Alaska and Greenland under them (and their taps on the pills).
      rects.push({ x: 0, y: 0, w: Math.round(W), h: Math.round(topEdge) });
    } else {
      if (seatsRow) rectOf(seatsRow);
      if (menuPill) rectOf(menuPill);
    }
    if (reserve) rects.push({ x: Math.round(st.left), y: Math.round(dockTop), w: Math.round(st.width), h: Math.round(st.height + reserve) });
    else rectOf(strip.el);
    const insets: ViewportInsets = {
      top: Math.round(topEdge),
      left: 0,
      right: 0,
      bottom: bottomEdge,
      trayBand: band,
      rects,
    };
    const key = JSON.stringify(insets);
    if (key !== lastInsets) {
      lastInsets = key;
      api.setViewportInsets(insets);
    }
  };
  let measureQueued = false;
  const queueMeasure = () => {
    if (measureQueued) return;
    measureQueued = true;
    requestAnimationFrame(() => {
      measureQueued = false;
      measure();
    });
  };
  const unLayout = onLayout(() => {
    applyScale(true);
    queueMeasure();
    syncSay();
    if (vm) rotate.update(hintQuiet(vm), layout.form === 'phone' && layout.portrait);
  });
  const ro = new ResizeObserver(queueMeasure);
  for (const el of [top.el, strip.el, bandProbe, top.el.querySelector('.ts-seats')!]) ro.observe(el);
  window.addEventListener('resize', queueMeasure);

  // ---- text size, fitted to the screen (src/ui/uiScale.ts) ------------------
  let fitted = false;
  const applyScale = (relayout: boolean) => {
    const size = vm?.settings.textSize ?? 'laptop';
    const W = window.innerWidth;
    const H = window.innerHeight;
    const nextScale = effectiveUiScale(size, W, H);
    const nextFitted = isFitted(size, W, H);
    const fitChanged = nextFitted !== fitted;
    fitted = nextFitted;
    if (fitChanged && vm) {
      title.setFitted(fitted);
      overlays.setFitted(fitted);
    }
    if (nextScale === scale && document.documentElement.style.fontSize) return;
    scale = nextScale;
    document.documentElement.style.fontSize = `${scale * 100}%`;
    queueMeasure();
    if (relayout) requestAnimationFrame(() => victory.refreshChart());
  };
  const onResizeScale = () => applyScale(true);
  window.addEventListener('resize', onResizeScale);

  // ---- render -------------------------------------------------------------
  // The victory beat (INK F7): once the world is held, the one line says so instead of a stale
  // 'John's turn' until the scroll rises. Memoised so the strip's identity short-circuit still holds.
  // Before that, while the deciding fight still plays on the displayed board, the turn has already
  // stopped being live (the real state is over) and the strip would fall back to 'John's turn': the
  // armed line the fight started from stays on the paper instead, so the line never goes stale.
  let heldFrom: StripVM | null = null;
  let heldVm: StripVM | null = null;
  let lastLive: StripVM | null = null;
  let fightLine: StripVM | null = null;
  const stripFor = (g: GameVM): StripVM => {
    const s = g.strip;
    const holder = worldHolder(g);
    if (holder) {
      // The memo may still hold the deciding fight's line for this same strip object: re-key it.
      if (fightLine) heldVm = null;
      fightLine = null;
      if (heldFrom !== s || !heldVm) {
        heldFrom = s;
        heldVm = { ...s, line: `${holder.seat.name} holds the world`, lineKind: 'normal', buttons: [], count: null };
      }
      return heldVm;
    }
    if (s.track.live || !g.battle || s.mode !== 'watching') {
      fightLine = null;
      lastLive = s.track.live && g.battle ? s : null;
      return s;
    }
    // A live turn's fight went un-live mid-roll (only the game ending does that): hold its line.
    const from = fightLine ?? lastLive;
    if (!from) return s;
    if (!fightLine || heldFrom !== s) {
      heldFrom = s;
      fightLine = from;
      heldVm = { ...s, line: from.line, lineKind: from.lineKind, lineKey: from.lineKey, buttons: [], count: null };
    }
    return heldVm!;
  };

  let vm: ViewModel | null = null;
  let gameSeed = -1;
  // The game's turning points, kept from the replay for the recap when VictoryVM doesn't carry its own.
  let lastMoments: string[] | null = null;
  /** The recap waits while the replay plays: it is laid on the board once the replay ends or is skipped. */
  const syncVictory = (v: ViewModel) => {
    const playing = replay.active;
    toggle(root, 'is-replay', playing);
    const shown = v.screen === 'victory' && !playing;
    toggle(victory.el, 'replay-hold', v.screen === 'victory' && playing);
    victory.update(v.victory, shown, lastMoments);
    setAttr(victory.el, 'data-testid', shown ? 'victory' : null);
  };
  replay.onChange = () => vm && syncVictory(vm);
  const render = (next: ViewModel) => {
    const prev = vm;
    vm = next;
    if (prev === next) return;
    motion.reduced = next.reducedMotion;
    toggle(root, 'rm', next.reducedMotion);
    if (!prev || prev.settings.textSize !== next.settings.textSize) applyScale(!!prev);
    showScreen(next.screen);
    toggle(root, 'in-game', next.screen === 'game');
    // After the turn line (never over it); panning / zooming answers it too.
    rotate.update(hintQuiet(next), layout.form === 'phone' && layout.portrait);
    nameCard.update(next.screen === 'game' ? next.game?.nameCard : null);
    toggle(lost, 'hidden', !next.boardLost);

    if (next.screen === 'title' || next.overlay || prev?.screen === 'title') title.update(next);
    if (next.screen === 'newGame') newGame.update(next.newGame);
    const rp = next.game?.replay ?? null;
    if (rp) lastMoments = rp.moments;
    else if (next.screen !== 'victory' && prev?.screen === 'victory') lastMoments = null;
    replay.update(rp);
    syncVictory(next);

    const g = next.game;
    if (g && (!prev || prev.game !== g)) {
      // The game's ensō (seed = the game's seed; a stable stand-in until the controller sends it).
      const seed = g.seed ?? hashSeed(g.seats.map((c) => `${c.seat.name}:${c.seat.color}`).join('|'));
      if (seed !== gameSeed) {
        gameSeed = seed;
        top.setSeed(seed);
        strip.setSeed(seed);
      }
      top.update(g.seats);
      top.setViewMoved(g.viewMoved);
      // A breath line arriving in this very render (a turn start): the strip's line keeps its words
      // while it dries, rather than swapping to the new turn's line and drying that (INK F6).
      if (g.banner && g.banner.id !== prev?.game?.banner?.id && sayInSlot()) strip.setLineAside(true);
      // Once the world is held nothing on the track is 'now': the gold leaves it for the victory beat.
      strip.update(stripFor(g), worldHolder(g) ? null : g.gold);
      strip.setEvents(g.events, g.round, !!g.updateReady);
      strip.setHolding(g.holding);
      // Ambient motion yields to the strike (INK A1): the rule's glint and breath rest while dice roll.
      toggle(root, 'is-striking', !!g.battle?.rolling);
      // The cup pours as the dice leave it (PLAN §2): toward the ink ring, under the fight header.
      if (g.battle?.rolling && !prev?.game?.battle?.rolling) {
        const hb = document.querySelector<HTMLElement>('[data-testid="battle"]')?.getBoundingClientRect();
        top.pour(hb && hb.width > 0 ? { x: hb.left + hb.width / 2, y: hb.bottom + 36 } : { x: innerWidth / 2, y: innerHeight * 0.72 });
      }
      battle.update(g.battle);
      announce.update(g.banner);
      syncSay();
      cards.update(g.cards);
      handoff.update(g.handoff);
      confirm.update(g.confirm);
    } else if (!g && prev?.game) {
      strip.setHolding(null);
      battle.update(null);
      announce.update(null);
      cards.update(null);
      handoff.update(null);
      confirm.update(null);
    }
    if (!prev || prev.overlay !== next.overlay || prev.settings !== next.settings || prev.screen !== next.screen || prev.rulesNotes !== next.rulesNotes || (next.overlay && prev.game !== next.game))
      overlays.update(next);
    toggle(root, 'overlay-open', !!next.overlay || !!g?.confirm);
  };

  // ---- delegated input behavior -------------------------------------------
  let lastHover: Element | null = null;
  let lastHoverAt = 0;
  const isBtn = (t: EventTarget | null) => (t instanceof Element ? t.closest<HTMLElement>('button, [role="slider"]') : null);
  const onPointerDown = (e: PointerEvent) => {
    const b = isBtn(e.target);
    if (b && b.getAttribute('aria-disabled') !== 'true') b.classList.add('is-down');
    // Any press on the UI dismisses the turn banner (board clicks are the controller's).
    if (vm?.game?.banner?.kind === 'turn') send({ type: 'dismissTurnBanner' });
  };
  const clearDown = () => root.querySelectorAll('.is-down').forEach((el) => el.classList.remove('is-down'));
  const onMouseDown = (e: MouseEvent) => {
    // No mouse focus on buttons: the keyboard stays with the game, and focus rings stay keyboard-only.
    if (isBtn(e.target)?.tagName === 'BUTTON') e.preventDefault();
  };
  const onClick = (e: MouseEvent) => {
    const b = isBtn(e.target);
    if (!b || b.tagName !== 'BUTTON' || b.getAttribute('aria-disabled') === 'true') return;
    // The Turn Track's advance is a wooden clack (the controller plays it), not a UI tick.
    if (b.classList.contains('tr-seg')) return;
    api.audio.play('uiClick');
  };
  const onOver = (e: PointerEvent) => {
    // Touch has no hover: a tap would tick twice (hover + click).
    if (e.pointerType === 'touch') return;
    const t = e.target instanceof Element ? e.target : null;
    const b = t?.closest<HTMLElement>('button');
    if (b && b !== lastHover) {
      lastHover = b;
      if (b.classList.contains('tr-seg') && b.getAttribute('aria-disabled') === 'true') return;
      const now = performance.now();
      if (b.getAttribute('aria-disabled') !== 'true' && now - lastHoverAt > 90) {
        lastHoverAt = now;
        api.audio.play('uiHover');
      }
    } else if (!b) lastHover = null;
  };
  const onContext = (e: MouseEvent) => e.preventDefault();

  // Keyboard: the controller owns game keys. The UI only handles keys for its own layers (menus,
  // dialogs, text fields) and stops them there so nothing fires twice.
  const onKey = (e: KeyboardEvent) => {
    const v = vm;
    if (!v) return;
    const t = e.target as HTMLElement | null;
    const inField = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
    if (inField) {
      // An open colour popover closes first (the name field keeps focus while the emblem is clicked).
      if (e.key === 'Escape' && v.screen === 'newGame' && newGame.closeSwatches()) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // Typing a name must never trigger game shortcuts. Enter / Esc finish the edit.
      if (e.key === 'Escape' || e.key === 'Enter') t!.blur();
      e.stopPropagation();
      return;
    }
    const focusedCtl = !!t && t !== document.body && root.contains(t) && (t.tagName === 'BUTTON' || t.getAttribute('role') === 'slider');
    const g = v.game;
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.repeat && (e.key === 'Enter' || e.key === ' ')) return stop();
    // The replay: any key skips it (and does nothing else).
    if (replay.active && !v.overlay && !['Shift', 'Control', 'Alt', 'Meta', 'Tab', 'CapsLock'].includes(e.key)) return void (stop(), replay.skip());
    if (g?.confirm && v.screen === 'game') {
      if (e.key === 'Escape') (stop(), send({ type: 'confirm', yes: false }));
      else if (e.key === 'Enter' && !focusedCtl) (stop(), send({ type: 'confirm', yes: true }));
      else if (focusedCtl && (e.key === 'Enter' || e.key === ' ')) e.stopPropagation();
      else if (e.key !== 'Tab') stop();
      return;
    }
    if (v.overlay) {
      if (e.key === 'Escape') {
        stop();
        send({ type: 'overlay', overlay: v.overlay !== 'pause' ? overlays.backTarget() : null });
      } else if (e.key === 'Enter' && !focusedCtl && v.overlay === 'pause') (stop(), send({ type: 'overlay', overlay: null }));
      else if (focusedCtl && (e.key === 'Enter' || e.key === ' ')) e.stopPropagation();
      else if (e.key !== 'Tab' && !e.key.startsWith('Arrow')) stop();
      return;
    }
    if (v.screen === 'game') {
      if (g?.handoff && (e.key === 'Enter' || e.key === ' ')) (stop(), send({ type: 'handoffAccept' }));
      else if (focusedCtl && (e.key === 'Enter' || e.key === ' ')) e.stopPropagation();
      return;
    }
    // Menu screens.
    if (focusedCtl && (e.key === 'Enter' || e.key === ' ')) return void e.stopPropagation();
    if (v.screen === 'title') {
      if (e.key === 'Enter') (stop(), send(v.save ? { type: 'continue' } : { type: 'nav', screen: 'newGame' }));
    } else if (v.screen === 'newGame') {
      if (e.key === 'Enter') (stop(), v.newGame.canStart && send({ type: 'start' }));
      else if (e.key === 'Escape') (stop(), newGame.closeSwatches() || send({ type: 'nav', screen: 'title' }));
    } else if (v.screen === 'victory') {
      if (e.key === 'Enter') {
        stop();
        if (victory.phase === 'full') send({ type: 'rematch' });
        else victory.showFull();
      }
    }
  };

  // INK A1: after 3 minutes without input the ambient layer (here: the rule's glint and the ensō's breath)
  // runs at half speed; any input wakes it.
  const DOZE_MS = 180_000;
  let dozeT = 0;
  const wake = () => {
    toggle(root, 'is-dozing', false);
    window.clearTimeout(dozeT);
    dozeT = window.setTimeout(() => toggle(root, 'is-dozing', true), DOZE_MS);
  };
  const wakeEvents = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
  for (const ev of wakeEvents) window.addEventListener(ev, wake, { passive: true, capture: true });
  wake();

  root.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointerup', clearDown);
  window.addEventListener('pointercancel', clearDown);
  root.addEventListener('pointerleave', clearDown);
  root.addEventListener('mousedown', onMouseDown);
  root.addEventListener('click', onClick);
  root.addEventListener('pointerover', onOver);
  root.addEventListener('contextmenu', onContext);
  window.addEventListener('keydown', onKey, true);

  render(api.getViewModel());
  measure();
  document.fonts?.ready.then(queueMeasure);
  const unsub = api.subscribe(render);

  return {
    dispose() {
      unsub();
      unLayout();
      window.clearTimeout(dozeT);
      for (const ev of wakeEvents) window.removeEventListener(ev, wake, { capture: true });
      ro.disconnect();
      window.removeEventListener('resize', queueMeasure);
      window.removeEventListener('resize', onResizeScale);
      window.removeEventListener('pointerup', clearDown);
      window.removeEventListener('pointercancel', clearDown);
      window.removeEventListener('keydown', onKey, true);
      root.remove();
      if (current?.newGame === newGame) current = null;
    },
  };
};

export default mountUi;
