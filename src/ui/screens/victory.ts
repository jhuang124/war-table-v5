// Victory (docs/INK.md B2.8, B5): a scroll, not fireworks. On the dimmed board one paper sheet rises
// with the game's ensō in the winner's wash drawing itself, `John holds the world`, `Round 14 · 31
// territories`, three award lines (Nemesis first), one ink timeline per player with no grid, a quiet
// standings line, then Rematch (the one gold: the word in a gold brush ring) · New setup · Title as bare
// words, and Full stats folded away (fitted to the sheet: no sideways scroll).
// Nothing makes anyone wait: Enter / a click finishes the drawing at once.
// v5 C (turning points): above the awards, the game's three named moments in the serif, one plain sentence
// each ('Round 6: Siberia changed hands three times'), the round in a quieter ink.

import type { PlayerStats } from '../../engine/types';
import type { UiIntent, VictoryVM } from '../../game/viewModel';
import { PLAYER_COLORS } from '../../shared/palette';
import { uiButton } from '../controls';
import { drawEnso, drawIn, EASE_BRUSH, emblem, ensoEl, h, hashSeed, minus, motion, setEnso, setStyle, svg, toggle } from '../dom';
import { isPhone } from '../layout';
import { sheetDrop, sheetIn } from '../sheet';

type Send = (i: UiIntent) => void;

/** The full-stats rows, in reading order. */
const STAT_COLS: { key: keyof PlayerStats; label: string }[] = [
  { key: 'territoriesConquered', label: 'Conquered' },
  { key: 'battlesWon', label: 'Rolls won' },
  { key: 'battlesLost', label: 'Rolls lost' },
  { key: 'armiesDestroyed', label: 'Armies destroyed' },
  { key: 'armiesLost', label: 'Armies lost' },
  { key: 'cardsTraded', label: 'Sets traded' },
  { key: 'reinforcementsReceived', label: 'Reinforcements' },
  { key: 'peakTerritories', label: 'Peak territories' },
];

function ordinal(n: number): string {
  return n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;
}

/** 'CRIMSON RULES THE WORLD' (older controllers) → 'Crimson rules the world'. */
function plain(s: string): string {
  if (s !== s.toUpperCase()) return s;
  const t = s.toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * The timeline: one ink line per player, in turn order, all on one scale (territories over rounds), no
 * grid and no axes — just the rise and fall, the final count at the right, and where a player went out.
 */
export class TerritoryChart {
  readonly el: HTMLDivElement;
  private last: VictoryVM | null = null;

  constructor() {
    this.el = h('div', 'chart');
  }

  refresh(): void {
    if (this.last) this.render(this.last, false);
  }

  render(vm: VictoryVM, animate = true): void {
    this.last = vm;
    this.el.textContent = '';
    const pts = vm.timeline;
    if (!pts.length) {
      this.el.append(h('p', 'dim', 'No rounds recorded'));
      return;
    }
    const n = pts.length;
    let peak = 1;
    for (const p of pts) for (const v of Object.values(p.territories)) peak = Math.max(peak, v as number);
    const rounds = h('div', 'tl-rounds num');
    rounds.append(h('span', '', `Round ${pts[0].round}`), h('span', '', n > 1 ? `Round ${pts[n - 1].round}` : ''));
    vm.seats.forEach((seat, si) => {
      const col = PLAYER_COLORS[seat.color];
      const row = h('div', `tl-row${seat.id === vm.winner.id ? ' winner' : ''}`);
      setStyle(row, '--seat-light', col.light);
      const name = h('span', 'tl-name');
      name.append(emblem(seat.color), h('span', '', seat.name));
      const plot = h('div', 'tl-plot');
      const W = 600;
      const H = 40;
      const x = (i: number) => (n === 1 ? 0 : (i / (n - 1)) * W);
      const y = (v: number) => H - 3 - (v / peak) * (H - 6);
      // The line stops where the player went out (the first zero after holding land).
      let end = n - 1;
      for (let i = 1; i < n; i++) if ((pts[i].territories[seat.id] ?? 0) === 0 && (pts[i - 1].territories[seat.id] ?? 0) > 0) {
        end = i;
        break;
      }
      const d = pts
        .slice(0, end + 1)
        .map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.territories[seat.id] ?? 0).toFixed(1)}`)
        .join('');
      const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'tl-svg' });
      s.setAttribute('aria-hidden', 'true');
      const base = svg('line', { x1: 0, x2: W, y1: H - 3, y2: H - 3, class: 'tl-base' });
      const path = svg('path', { d, class: 'tl-line' });
      s.append(base, path);
      plot.append(s);
      const final = pts[n - 1].territories[seat.id] ?? 0;
      const out = final === 0 && end < n - 1;
      const val = h('span', 'tl-val num', out ? 'out' : String(final));
      if (out) val.append(h('span', 'tl-when', ` · round ${pts[end].round}`));
      row.append(name, plot, val);
      this.el.append(row);
      if (animate && !motion.reduced && typeof path.animate === 'function') {
        const len = W * 2.5;
        path.style.strokeDasharray = `${len}`;
        path.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 900, delay: 500 + si * 90, easing: EASE_BRUSH, fill: 'backwards' });
      }
    });
    this.el.append(rounds);
  }
}

export class VictoryScreen {
  readonly el: HTMLElement;
  private vm: VictoryVM | null = null;
  private scroll: HTMLDivElement;
  private mark: SVGSVGElement;
  private title: HTMLHeadingElement;
  private sub: HTMLParagraphElement;
  private awards: HTMLDivElement;
  private moments: HTMLDivElement;
  private chart = new TerritoryChart();
  private standings: HTMLOListElement;
  private stats: HTMLDivElement;
  private statsBtn: HTMLButtonElement;
  private statsOpen = false;
  private timers: number[] = [];
  private shownAt = 0;
  phase: 'intro' | 'full' = 'intro';

  constructor(send: Send) {
    this.el = h('section', 'screen victory-screen');
    this.scroll = h('div', 'v-scroll sheet');
    const head = h('div', 'v-head');
    this.mark = ensoEl(1, 'enso v-enso', { drawable: true });
    this.title = h('h1', 'v-title');
    this.sub = h('p', 'v-sub num');
    head.append(this.mark, this.title, this.sub);
    this.awards = h('div', 'v-awards');
    this.moments = h('div', 'v-moments hidden');
    this.moments.dataset.testid = 'moments';
    const mid = h('div', 'v-mid');
    const chartWrap = h('div', 'v-chart');
    chartWrap.append(this.chart.el);
    this.standings = h('ol', 'standings');
    mid.append(chartWrap, this.standings);
    this.stats = h('div', 'v-stats hidden');
    const actions = h('div', 'v-actions');
    this.statsBtn = uiButton('Full stats', 'role-exit', () => this.setStats(!this.statsOpen), undefined, 'victory-stats');
    actions.append(
      uiButton('Rematch', 'brass role-primary big', () => send({ type: 'rematch' }), undefined, 'rematch'),
      uiButton('New setup', 'role-secondary', () => send({ type: 'nav', screen: 'newGame' }), undefined, 'victory-newsetup'),
      uiButton('Title', 'role-secondary', () => send({ type: 'nav', screen: 'title' }), undefined, 'victory-title'),
      h('span', 'v-spacer'),
      this.statsBtn,
    );
    this.scroll.append(head, this.moments, this.awards, mid, actions, this.stats);
    this.el.append(h('div', 'v-scrim'), this.scroll);
    let rt = 0;
    window.addEventListener('resize', () => {
      window.clearTimeout(rt);
      rt = window.setTimeout(() => {
        if (this.el.isConnected && this.vm) this.chart.refresh();
      }, 120);
    });
    // A press during the drawing finishes it (never a wait).
    this.el.addEventListener('pointerdown', () => {
      if (this.phase === 'intro' && performance.now() - this.shownAt > 250) this.showFull();
    });
  }

  private setStats(on: boolean): void {
    this.statsOpen = on;
    toggle(this.stats, 'hidden', !on);
    toggle(this.scroll, 'stats-open', on);
    this.statsBtn.querySelector('.btn-label')!.textContent = on ? 'Hide stats' : 'Full stats';
    if (on) {
      drawIn(this.stats, 240);
      this.stats.scrollIntoView({ block: 'nearest', behavior: motion.reduced ? 'auto' : 'smooth' });
    }
  }

  update(vm: VictoryVM | null, active: boolean, moments?: string[] | null): void {
    if (!active || !vm) {
      if (!active && this.vm) {
        this.timers.forEach((t) => clearTimeout(t));
        this.timers = [];
        this.vm = null;
      }
      return;
    }
    if (vm === this.vm) return;
    this.vm = vm;
    this.shownAt = performance.now();
    this.phase = 'intro';
    const pal = PLAYER_COLORS[vm.winner.color];
    setStyle(this.el, '--seat', pal.base);
    setStyle(this.el, '--seat-light', pal.light);
    const seed = vm.seed ?? hashSeed(vm.seats.map((s) => `${s.name}:${s.color}`).join('|'));
    setEnso(this.mark, seed, { drawable: true });
    this.title.textContent = minus(plain(vm.title));
    this.sub.textContent = minus(vm.subline);

    // Turning points (v5 C): the story of the war in three sentences, above the awards.
    this.moments.textContent = '';
    const told = (vm.moments ?? moments ?? []).filter(Boolean).slice(0, 3);
    for (const m of told) {
      const line = h('p', 'mo-line num');
      const t = minus(m);
      const at = /^(Round \d+)(:\s*)(.*)$/.exec(t);
      if (at) line.append(h('span', 'mo-round', `${at[1]}:`), document.createTextNode(` ${at[3]}`));
      else line.textContent = t;
      this.moments.append(line);
    }
    toggle(this.moments, 'hidden', told.length === 0);

    // Awards: three lines. Nemesis first — the grudge is the story of the evening.
    this.awards.textContent = '';
    const order = [...vm.awards].sort((a, b) => (a.id === 'nemesis' ? -1 : 0) - (b.id === 'nemesis' ? -1 : 0)).slice(0, 3);
    for (const a of order) {
      const c = h('div', `award award-${a.id}`);
      setStyle(c, '--seat-light', PLAYER_COLORS[a.seat.color].light);
      const txt = h('span', 'aw-line num');
      const t = minus(a.text);
      // The winner of the award's name in their wash where it leads the line.
      if (t.startsWith(a.seat.name)) txt.append(h('span', 'aw-who', a.seat.name), document.createTextNode(t.slice(a.seat.name.length)));
      else txt.append(document.createTextNode(`${t} · `), h('span', 'aw-who', a.seat.name));
      c.append(h('span', 'aw-title', a.title), txt);
      this.awards.append(c);
    }
    toggle(this.awards, 'hidden', vm.awards.length === 0);

    // Standings: one quiet line.
    this.standings.textContent = '';
    for (const st of [...vm.standings].sort((a, b) => a.place - b.place)) {
      const li = h('li', `st-row${st.place === 1 ? ' first' : ''}`);
      setStyle(li, '--seat-light', PLAYER_COLORS[st.seat.color].light);
      li.append(h('span', 'st-place num', ordinal(st.place)), h('span', 'st-name', st.seat.name), h('span', 'st-terr num', `${st.territories}`));
      this.standings.append(li);
    }
    // Two seats: the title already names the winner and the timeline ends on both counts, so the
    // standings line would only repeat them (SOUL pillar 2). Three or more: it carries the ranking.
    toggle(this.standings, 'hidden', vm.standings.length <= 2);

    // Full stats: one row per stat, one column per player (winner first), so it fits the sheet with
    // up to six seats; territories live in the timeline and the standings, not here too.
    this.stats.textContent = '';
    const ranked = [...vm.standings].sort((a, b) => a.place - b.place);
    // Five or six seats on a phone: the header keeps each seat's emblem and lets the names go.
    const table = h('table', `stats-table${ranked.length >= 5 ? ' many' : ''}`);
    const thead = h('thead');
    const hr = h('tr');
    hr.append(h('th', 'sx-label'));
    for (const st of ranked) {
      const th = h('th', `sx-seat${st.place === 1 ? ' first' : ''}`);
      setStyle(th, '--seat-light', PLAYER_COLORS[st.seat.color].light);
      th.title = st.seat.name;
      th.append(emblem(st.seat.color), h('span', 'sx-name', st.seat.name));
      hr.append(th);
    }
    thead.append(hr);
    const tb = h('tbody');
    for (const c of STAT_COLS) {
      const tr = h('tr');
      tr.append(h('th', 'sx-label', c.label));
      for (const st of ranked) tr.append(h('td', 'num', String(st.stats[c.key])));
      tb.append(tr);
    }
    table.append(thead, tb);
    this.stats.append(table);
    this.setStats(false);
    this.scroll.scrollTop = 0;
    this.el.scrollTop = 0;

    // The recap is a sheet of paper laid on the board (v4 E8): it comes down from the top edge (phones:
    // it rises), the ensō draws itself, the words are brushed on after it.
    this.chart.render(vm, !motion.reduced);
    if (!motion.reduced) this.el.querySelector('.v-scrim')!.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 600, easing: 'ease-out' });
    if (isPhone()) sheetIn(this.scroll);
    else sheetDrop(this.scroll, null, 480);
    drawEnso(this.mark, 900, 120);
    drawIn(this.title, 360, 420);
    drawIn(this.sub, 280, 620);
    [...this.moments.children].forEach((c, i) => drawIn(c as HTMLElement, 300, 700 + i * 140));
    const after = told.length ? 700 + told.length * 140 + 120 : 760;
    [...this.awards.children].forEach((c, i) => drawIn(c as HTMLElement, 260, after + i * 120));
    for (const el of this.scroll.querySelectorAll<HTMLElement>('.v-mid, .v-actions'))
      if (!motion.reduced) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: 900, easing: 'ease-out', fill: 'backwards' });
    this.timers.forEach((t) => clearTimeout(t));
    this.timers = [window.setTimeout(() => (this.phase = 'full'), 1400)];
  }

  refreshChart(): void {
    this.chart.refresh();
  }

  /** Finish the drawing now (Enter / a press / the gallery). */
  showFull(): void {
    if (!this.vm || this.phase === 'full') return;
    this.phase = 'full';
    this.timers.forEach((t) => clearTimeout(t));
    this.timers = [];
    for (const a of this.el.getAnimations({ subtree: true })) {
      try {
        a.finish();
      } catch {
        a.cancel();
      }
    }
    this.el.querySelectorAll('.ink-in').forEach((e) => e.classList.remove('ink-in'));
  }
}

