// ui-gallery.html: mounts the real UI over a stand-in board with a fake ControllerApi.
//   ?state=<id>        pick a fixture (default: the index)
//   &text=tv|couch     override the text size
//   &debug=1           outline the reported viewport insets and battle band
//   &bg=render         use artifacts/render/home-WxH.png as the backdrop
//   &bg=stand          the old tilted stand-in slab (default: the chosen moodboard painting)
// The index of every fixture is hidden by default; open it with ?index=1 or the "i" key.

import { createAudio } from '../../audio';
import type { ControllerApi, UiIntent, ViewModel } from '../../game/viewModel';
import type { ViewportInsets } from '../../render/BoardView';
import { BOARD } from '../../map';
import { PLAYER_COLORS } from '../../shared/palette';
import { mountUi, uiDebug } from '../index';
import { effectiveUiScale } from '../uiScale';
import { trayGeometry } from '../../shared/tray';
import { fixtures, type Fixture } from './fixtures';

const params = new URLSearchParams(location.search);
const W = window.innerWidth;
const H = window.innerHeight;
const all = fixtures(W, H);
const byId = new Map(all.map((f) => [f.id, f]));
const stateId = params.get('state');
const text = params.get('text') as ViewModel['settings']['textSize'] | null;
const debug = params.get('debug') === '1';

// ---- stand-in board ------------------------------------------------------
const boardHost = document.getElementById('board')!;
boardHost.innerHTML = '';
const table = document.createElement('div');
table.className = 'g-table';
const stage = document.createElement('div');
stage.className = 'g-stage';
const slab = document.createElement('div');
slab.className = 'g-slab';
const img = document.createElement('img');
img.alt = '';
img.src = '/artifacts/map/preview.png';
slab.append(img);
stage.append(slab);
table.append(stage);
boardHost.append(table);

// &bg=mood: the chosen moodboard painting as the board (its own mock UI cropped off the bottom), for
// judging the ink HUD against the look it is meant to sit on.
if ((params.get('bg') ?? 'mood') === 'mood') {
  table.classList.add('g-shot');
  table.style.background = `#101a30 url(/_claude/moodboard/chosen-silver-ink-board.png) center top / auto ${Math.round(H / 0.83)}px no-repeat`;
  slab.style.display = 'none';
}
// &bg=render: use the renderer's own home-view screenshot as a flat backdrop instead of the stand-in.
if (params.get('bg') === 'render') {
  table.classList.add('g-shot');
  table.style.backgroundImage = `url(/artifacts/render/home-${W}x${H}.png)`;
}

let insets: ViewportInsets = { top: 44, left: 0, right: 0, bottom: 80, trayBand: 180 };
const layoutBoard = () => {
  // The land fills the space between the strips; the tray band overlays it during fights.
  const availW = W - insets.left - insets.right;
  const availH = H - insets.top - insets.bottom;
  const margin = 0.04;
  // A 55° pitch foreshortens the board to ~0.82 of its height in the fake view.
  const aspect = BOARD.width / (BOARD.height * 0.82);
  let w = availW * (1 - margin * 2);
  let h = w / aspect;
  if (h > availH * (1 - margin * 2)) {
    h = availH * (1 - margin * 2);
    w = h * aspect;
  }
  stage.style.left = `${insets.left + (availW - w) / 2}px`;
  stage.style.top = `${insets.top + (availH - h) / 2}px`;
  stage.style.width = `${w}px`;
  stage.style.height = `${h}px`;
  drawDebug();
  drawDice();
};

// ---- fake dice tray, placed like the renderer's ---------------------------
const tray = document.createElement('div');
tray.className = 'g-tray';
document.body.append(tray);
const pip: Record<number, [number, number][]> = {
  1: [[50, 50]],
  2: [[28, 28], [72, 72]],
  3: [[26, 26], [50, 50], [74, 74]],
  4: [[28, 28], [72, 28], [28, 72], [72, 72]],
  5: [[26, 26], [74, 26], [50, 50], [26, 74], [74, 74]],
  6: [[28, 24], [72, 24], [28, 50], [72, 50], [28, 76], [72, 76]],
};
let current: Fixture | null = null;
function drawDice() {
  tray.innerHTML = '';
  const b = current?.vm.game?.battle;
  if (!b || current?.vm.screen !== 'game') return;
  // Mirror src/render/dice.ts layout(): tray centered in the band.
  const band = insets.trayBand;
  const scale = effectiveUiScale(current.vm.settings.textSize, W, H);
  const g = trayGeometry(W, H, band, scale);
  const size = g.die;
  const trayH = g.trayH;
  // The band sits just above the bottom strip; the tray is centred in it (src/render/index.ts).
  tray.style.cssText = `top:${H - insets.bottom - band + (band - trayH) / 2}px;height:${trayH}px;width:${g.trayW}px`;
  const mk = (face: number, color: string, ink: string, dim = false) => {
    const d = document.createElement('div');
    d.className = 'g-die';
    d.style.cssText = `width:${size}px;height:${size}px;background:${color};opacity:${dim ? 0.55 : 1}`;
    for (const [x, y] of pip[face]) {
      const p = document.createElement('i');
      p.style.cssText = `left:${x}%;top:${y}%;background:${ink}`;
      d.append(p);
    }
    return d;
  };
  const att = document.createElement('div');
  att.className = 'g-dice att';
  const def = document.createElement('div');
  def.className = 'g-dice def';
  const [a, d] = current?.dice ?? [[], []];
  const ap = PLAYER_COLORS[b.attacker.seat.color];
  const dp = PLAYER_COLORS[b.defender.seat.color];

  a.forEach((f, i) => att.append(mk(f, ap.base, ap.ink, i < d.length && f <= d[i])));
  d.forEach((f, i) => def.append(mk(f, dp.base, dp.ink, i < a.length && a[i] > f)));
  tray.append(att, def);
}

// ---- debug overlay -------------------------------------------------------
const dbg = document.createElement('div');
dbg.className = 'g-debug';
if (debug) document.body.append(dbg);
function drawDebug() {
  if (!debug) return;
  dbg.innerHTML = `<div style="position:fixed;left:${insets.left}px;top:${insets.top}px;right:${insets.right}px;bottom:${insets.bottom}px;outline:1px dashed #0ff"></div>
  <div style="position:fixed;left:0;right:0;top:${H - insets.bottom - insets.trayBand}px;height:${insets.trayBand}px;outline:1px dashed #f0f"></div>
`;
}

// ---- fake controller -----------------------------------------------------
const listeners = new Set<(vm: ViewModel) => void>();
const intents: UiIntent[] = [];
const audio = createAudio({ volume: 0.6 });
let vm: ViewModel;

const api: ControllerApi = {
  getViewModel: () => vm,
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  intent(i) {
    intents.push(i);
    console.debug('[intent]', JSON.stringify(i));
    react(i);
  },
  setViewportInsets(i) {
    insets = i;
    layoutBoard();
  },
  audio,
};

const push = (next: ViewModel) => {
  vm = next;
  for (const l of listeners) l(vm);
  drawDice();
};

/** A little interactivity so the gallery can be clicked through by hand. */
function react(i: UiIntent) {
  const g = vm.game;
  switch (i.type) {
    case 'overlay':
      return push({ ...vm, overlay: i.overlay });
    case 'setting':
      return push({ ...vm, settings: { ...vm.settings, ...i.patch }, reducedMotion: i.patch.reduceMotion ?? vm.reducedMotion });
    case 'cardsPanel':
      if (g?.cards) push({ ...vm, game: { ...g, cards: { ...g.cards, open: i.open } } });
      return;
    case 'setCount':
      if (g?.strip.count) {
        const c = g.strip.count;
        const v = Math.max(c.min, Math.min(c.max, i.value));
        const buttons = g.strip.buttons.map((b) => (b.id === 'place' || b.id === 'move' ? { ...b, label: b.label.replace(/\d+/, String(v)) } : b));
        push({ ...vm, game: { ...g, strip: { ...g.strip, count: { ...c, value: v }, buttons } } });
      }
      return;
    case 'button':
      if (g && i.id === 'cards' && g.cards) push({ ...vm, game: { ...g, cards: { ...g.cards, open: !g.cards.open } } });
      return;
    case 'confirm':
      if (g) push({ ...vm, game: { ...g, confirm: null } });
      return;
    case 'handoffAccept':
      if (g) push({ ...vm, game: { ...g, handoff: null } });
      return;
    case 'skipReplay':
      if (g?.replay) push({ ...vm, game: { ...g, replay: null } });
      return;
    case 'dismissReceipt':
      if (g?.receipt) push({ ...vm, game: { ...g, receipt: null } });
      return;
    case 'dismissTurnBanner':
      if (g?.banner?.kind === 'turn') push({ ...vm, game: { ...g, banner: null } });
      return;
    case 'nav':
      return push({ ...vm, screen: i.screen, overlay: null });
  }
}

// ---- index ---------------------------------------------------------------
function buildIndex() {
  const idx = document.createElement('nav');
  idx.className = 'g-index';
  const groups = new Map<string, Fixture[]>();
  for (const f of all) groups.set(f.group, [...(groups.get(f.group) ?? []), f]);
  let html = '<h1>UI gallery</h1><p>Every screen and state, rendered by the real UI over a stand-in board. Add <code>&amp;text=tv</code> for TV size, <code>&amp;debug=1</code> for insets.</p>';
  for (const [g, list] of groups) {
    html += `<h2>${g}</h2><ul>`;
    for (const f of list) html += `<li><a href="?state=${f.id}">${f.label}</a> <a class="tv" href="?state=${f.id}&text=tv">TV</a></li>`;
    html += '</ul>';
  }
  idx.innerHTML = html;
  document.body.append(idx);
  return idx;
}

// ---- go ------------------------------------------------------------------
const fx = (stateId && byId.get(stateId)) || byId.get('place')!;
current = fx;
vm = text ? { ...fx.vm, settings: { ...fx.vm.settings, textSize: text } } : fx.vm;
mountUi(document.getElementById('ui')!, api);
layoutBoard();
if (fx.after === 'openHouse') uiDebug().openHouseRules();
if (fx.after === 'skipVictoryIntro') setTimeout(() => uiDebug().skipVictoryIntro(), 50);
const idx = buildIndex();
if (!stateId || params.get('index') === '1') idx.classList.add('open');
window.addEventListener('keydown', (e) => {
  if (e.key === 'i' && !(e.target instanceof HTMLInputElement)) idx.classList.toggle('open');
});
// get/set let a Playwright script drive VM transitions (banner hand-offs, bar reflow) frame by frame.
Object.assign(window, { __gallery: { ids: all.map((f) => f.id), intents, ui: uiDebug, ready: true, get: () => vm, set: (next: ViewModel) => push(next) } });
