// The turn banner's one recap line (docs/SIMPLIFY.md §5; v4: the ledger keeps it, the banner no longer
// shows it), the award ledger (victory screen) and the v4 receipt ('While you were away'), all built from
// the event stream as the board plays it. Plain data so they can be saved alongside the game.

import { expectedRollLosses, territoryCount, totalArmies, type ContinentId, type GameEvent, type GameState, type PlayerId, type TerritoryId } from '../engine';
import { SEP, cName, pName, poss, seatRef, signed, tName } from './copy';
import type { ReceiptLineVM, ReceiptVM } from './viewModel';

// ---------------------------------------------------------------------------
// Recap
// ---------------------------------------------------------------------------

export interface RecapEntry {
  /** lost[attacker] = territories this seat lost to them since its last turn, in order. */
  lost: Record<number, TerritoryId[]>;
}

export type RecapLedger = Record<number, RecapEntry>;

/** Record one played event into every human seat's ledger. `disp` is the displayed state after it. */
export function recordRecap(ledger: RecapLedger, disp: GameState, e: GameEvent): void {
  if (e.type !== 'territoryConquered') return;
  const victim = disp.players[e.previousOwner];
  if (!victim || victim.kind !== 'human') return;
  const entry = (ledger[victim.id] ??= { lost: {} });
  (entry.lost[e.player] ??= []).push(e.to);
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The grudge line's cap: past it, names give way to counts. */
export const RECAP_MAX = 60;

/**
 * The grudge line (docs/INK.md A5), only if the seat lost territory since its last turn, naming who and
 * what: 'Sam took Ural and Siberia from you' · 'Sam took Ural, Priya took Peru' · when names don't fit in
 * 60 characters, 'Sam took 4 of yours' / 'Sam and Priya took 5 of yours'. null when nothing was lost.
 */
export function buildRecap(entry: RecapEntry | undefined, state: GameState): string | null {
  if (!entry) return null;
  const attackers = Object.entries(entry.lost)
    .map(([a, ts]) => ({ a: Number(a), ts: [...new Set(ts)] }))
    .filter((x) => x.ts.length > 0)
    .sort((x, y) => y.ts.length - x.ts.length || x.a - y.a);
  if (!attackers.length) return null;
  const total = attackers.reduce((n, x) => n + x.ts.length, 0);
  const named =
    attackers.length === 1
      ? `${pName(state, attackers[0].a)} took ${joinNames(attackers[0].ts.map(tName))} from you`
      : attackers.map((x) => `${pName(state, x.a)} took ${joinNames(x.ts.map(tName))}`).join(', ');
  if (named.length <= RECAP_MAX) return named;
  const who = joinNames(attackers.map((x) => pName(state, x.a)));
  return `${who} took ${total} of yours`;
}

// ---------------------------------------------------------------------------
// Awards
// ---------------------------------------------------------------------------

export interface AwardLedger {
  /** taken["attacker>victim"] = territories taken. */
  taken: Record<string, number>;
  /** Actual − expected defender losses over each player's attack rolls, and the roll count. */
  luck: Record<number, { sum: number; rolls: number }>;
  trades: { player: PlayerId; armies: number; round: number }[];
  upsets: { player: PlayerId; kind: 'held' | 'odds'; pct: number; round: number }[];
}

export function emptyAwards(): AwardLedger {
  return { taken: {}, luck: {}, trades: [], upsets: [] };
}

export function recordAward(ledger: AwardLedger, disp: GameState, e: GameEvent): void {
  switch (e.type) {
    case 'diceRolled': {
      if (e.defender < 0) break;
      const exp = expectedRollLosses(e.attackDice.length, e.defendDice.length).defender;
      const l = (ledger.luck[e.player] ??= { sum: 0, rolls: 0 });
      l.sum += e.defenderLosses - exp;
      l.rolls += 1;
      break;
    }
    case 'territoryConquered':
      if (e.previousOwner >= 0) {
        const k = `${e.player}>${e.previousOwner}`;
        ledger.taken[k] = (ledger.taken[k] ?? 0) + 1;
      }
      break;
    case 'cardsTraded':
      ledger.trades.push({ player: e.player, armies: e.armies + (e.bonusTerritory ? 2 : 0), round: disp.round });
      break;
  }
}

export interface AwardCard {
  id: 'nemesis' | 'hotDice' | 'cursedDice' | 'cashIn';
  title: string;
  text: string;
  player: PlayerId;
}

/** ≤ 3 award cards, only awards with ≥ 3 supporting events (UX.md §4.6). */
export function buildAwards(ledger: AwardLedger, state: GameState): AwardCard[] {
  const out: AwardCard[] = [];
  let nem: { a: number; v: number; n: number } | null = null;
  for (const [k, n] of Object.entries(ledger.taken)) {
    const [a, v] = k.split('>').map(Number);
    if (n >= 3 && (!nem || n > nem.n)) nem = { a, v, n };
  }
  if (nem) {
    out.push({
      id: 'nemesis',
      title: 'Nemesis',
      text: `${pName(state, nem.a)} took ${nem.n} territories from ${pName(state, nem.v)}`,
      player: nem.a,
    });
  }
  const lucky = Object.entries(ledger.luck)
    .map(([p, l]) => ({ p: Number(p), sum: l.sum, rolls: l.rolls }))
    .filter((x) => x.rolls >= 3);
  const hot = [...lucky].sort((a, b) => b.sum - a.sum)[0];
  if (hot && Math.round(hot.sum) >= 1) {
    out.push({
      id: 'hotDice',
      title: 'Hot dice',
      text: `${pName(state, hot.p)}: ${signed(Math.round(hot.sum))} armies of pure luck`,
      player: hot.p,
    });
  }
  const cold = [...lucky].sort((a, b) => a.sum - b.sum)[0];
  if (cold && Math.round(cold.sum) <= -1 && cold.p !== hot?.p) {
    out.push({
      id: 'cursedDice',
      title: 'Cursed dice',
      text: `${pName(state, cold.p)}: ${signed(Math.round(cold.sum))} armies the dice took back`,
      player: cold.p,
    });
  }
  if (ledger.trades.length >= 3) {
    const big = [...ledger.trades].sort((a, b) => b.armies - a.armies || a.round - b.round)[0];
    out.push({
      id: 'cashIn',
      title: 'Biggest cash-in',
      text: `${pName(state, big.player)}: +${big.armies}${SEP}round ${big.round}`,
      player: big.player,
    });
  }
  // Keep at most 3; prefer nemesis, hot dice, cash-in over cursed dice.
  if (out.length > 3) {
    const i = out.findIndex((a) => a.id === 'cursedDice');
    if (i >= 0) out.splice(i, 1);
  }
  return out.slice(0, 3);
}

// ---------------------------------------------------------------------------
// The receipt (v4, _claude/v4/PLAN.md §3 A3; sitting 2026-10-03: the receipt is THE channel for bot turns)
// ---------------------------------------------------------------------------

/** One thing an AI seat did on its own turn, tagged with that turn's number. */
export type ReceiptItem = { turn: number; seat: PlayerId } & (
  | { k: 'took'; t: TerritoryId; from: PlayerId }
  | { k: 'placed'; n: number }
  | { k: 'gained'; c: ContinentId }
  | { k: 'broke'; c: ContinentId; from: PlayerId }
  | { k: 'out'; p: PlayerId }
  | { k: 'truce'; with: PlayerId; what: 'proposed' | 'agreed' | 'broke' }
);

export interface ReceiptLedger {
  /** What AI seats did on their turns, oldest first (pruned once every human has read past it). */
  items: ReceiptItem[];
  /** AI main turns played, as [turn, seat]. */
  aiTurns: [number, PlayerId][];
  /** Human seat → the number of its last main turn (set as that turn starts). */
  last: Record<number, number>;
  /** The receipt showing now (a resume shows it again until it is dismissed). */
  pending?: { seat: PlayerId; turn: number; since: number } | null;
  /** The last receipt dismissed, so one turn never shows it twice (the hand-off cover, then the turn). */
  done?: { seat: PlayerId; turn: number } | null;
}

export function emptyReceipts(): ReceiptLedger {
  return { items: [], aiTurns: [], last: {}, pending: null, done: null };
}

const RECEIPT_ITEMS_CAP = 600;

/**
 * Record one played event of an AI's main turn. `disp` is the displayed state after it (its turn number
 * tags the item). Only what the reader needs: conquests, placements, continents, knockouts, truces an AI
 * made or broke, and offers that wait for a human.
 */
export function recordReceipt(l: ReceiptLedger, disp: GameState, e: GameEvent): void {
  const turn = disp.turn;
  if (turn <= 0) return;
  const push = (it: ReceiptItem) => {
    l.items.push(it);
    if (l.items.length > RECEIPT_ITEMS_CAP) l.items.splice(0, l.items.length - RECEIPT_ITEMS_CAP);
  };
  switch (e.type) {
    case 'territoryConquered':
      if (e.previousOwner >= 0) push({ turn, seat: e.player, k: 'took', t: e.to, from: e.previousOwner });
      break;
    case 'armiesPlaced':
      if (e.count > 0 && e.source !== 'undo') push({ turn, seat: e.player, k: 'placed', n: e.count });
      break;
    case 'continentGained':
      push({ turn, seat: e.player, k: 'gained', c: e.continent });
      break;
    case 'continentLost':
      push({ turn, seat: e.to, k: 'broke', c: e.continent, from: e.player });
      break;
    case 'playerEliminated':
      push({ turn, seat: e.by, k: 'out', p: e.player });
      break;
    case 'truceProposed':
      // Only an offer that waits for a human's answer (an AI answers at once: truceAccepted says it).
      if (disp.players[e.to]?.kind === 'human') push({ turn, seat: e.from, k: 'truce', with: e.to, what: 'proposed' });
      break;
    case 'truceAccepted':
      push({ turn, seat: e.from, k: 'truce', with: e.to, what: 'agreed' });
      break;
    case 'truceBroken':
      push({ turn, seat: e.by, k: 'truce', with: e.against, what: 'broke' });
      break;
    default:
      break;
  }
}

/** A main turn starts: an AI's is counted; a human's becomes that seat's "last turn" (and old items go). */
export function noteTurnStart(l: ReceiptLedger, s: GameState, player: PlayerId, turn: number, ai: boolean): void {
  if (ai) {
    l.aiTurns.push([turn, player]);
    return;
  }
  // Items older than every human's last turn are never read again. (Taken before this turn moves the
  // seat's mark: the receipt opening now, or again on a resume, still reads since the previous one.)
  const lasts = s.players.filter((p) => p.kind === 'human' && !p.eliminated && l.last[p.id] !== undefined).map((p) => l.last[p.id]);
  l.last[player] = turn;
  if (!lasts.length) return;
  const floor = Math.min(...lasts);
  l.items = l.items.filter((it) => it.turn > floor);
  l.aiTurns = l.aiTurns.filter(([t]) => t > floor);
}

/** The turn after which `reader`'s receipt begins, or null when the seat has never had a turn. */
export function receiptSince(l: ReceiptLedger, reader: PlayerId): number | null {
  const v = l.last[reader];
  return typeof v === 'number' ? v : null;
}

/** The receipt line's cap (ReceiptLineVM.text). */
export const RECEIPT_LINE_MAX = 90;

function terrWord(n: number): string {
  return `${n} ${n === 1 ? 'territory' : 'territories'}`;
}

/**
 * 'Brazil, Peru and Argentina from you, Ural from Sage'. `level` 1 counts the other seats' losses ('…from
 * you, 1 from Sage'), 2 counts everything ('3 from you, 1 from Sage').
 */
function tookPhrase(state: GameState, reader: PlayerId, took: { t: TerritoryId; from: PlayerId }[], level: 0 | 1 | 2): string {
  const byVictim: { from: PlayerId; ts: TerritoryId[] }[] = [];
  for (const x of took) {
    let g = byVictim.find((v) => v.from === x.from);
    if (!g) byVictim.push((g = { from: x.from, ts: [] }));
    if (!g.ts.includes(x.t)) g.ts.push(x.t);
  }
  // The reader's losses first: that is what they came back to read.
  byVictim.sort((a, b) => Number(b.from === reader) - Number(a.from === reader));
  return byVictim
    .map((g) => {
      const who = g.from === reader ? 'you' : pName(state, g.from);
      const counts = level === 2 || (level === 1 && g.from !== reader);
      return counts ? `${g.ts.length} from ${who}` : `${joinNames(g.ts.map(tName))} from ${who}`;
    })
    .join(', ');
}

/**
 * The receipt for `reader`: one line per AI seat that played since the reader's last turn (in the order
 * they played), what it took and from whom, its continents and knockouts, its truces, and what it holds
 * now; then the one line about the reader. `state` is the board as the reader gets the cup. null when no
 * AI turn was played after turn `since`.
 */
export function buildReceipt(l: ReceiptLedger, state: GameState, reader: PlayerId, since: number, title: string, key: number): ReceiptVM | null {
  const turns = l.aiTurns.filter(([t]) => t > since);
  if (!turns.length) return null;
  const order: PlayerId[] = [];
  for (const [, seat] of turns) if (!order.includes(seat) && state.players[seat]) order.push(seat);
  const items = l.items.filter((it) => it.turn > since);
  const lines: ReceiptLineVM[] = [];
  let lostT = 0;
  const lostC: ContinentId[] = [];
  for (const seat of order) {
    const mine = items.filter((it) => it.seat === seat);
    const took = mine.flatMap((it) => (it.k === 'took' ? [{ t: it.t, from: it.from }] : []));
    const placed = mine.reduce((n, it) => n + (it.k === 'placed' ? it.n : 0), 0);
    // Extras in the order they matter to the reader: what stings them first, then knockouts, then the rest.
    const yours: string[] = [];
    const extras: string[] = [];
    let stings = took.some((x) => x.from === reader);
    lostT += new Set(took.filter((x) => x.from === reader).map((x) => x.t)).size;
    for (const it of mine) {
      if (it.k !== 'broke') continue;
      if (it.from === reader) {
        stings = true;
        if (!lostC.includes(it.c)) lostC.push(it.c);
        yours.push(`broke your ${cName(it.c)}`);
      }
    }
    for (const it of mine) if (it.k === 'truce' && it.what === 'broke' && it.with === reader) {
      stings = true;
      yours.push('broke the truce with you');
    }
    for (const it of mine) if (it.k === 'out') extras.push(`knocked out ${pName(state, it.p)}`);
    for (const it of mine) if (it.k === 'broke' && it.from !== reader) extras.push(`broke ${poss(pName(state, it.from))} ${cName(it.c)}`);
    for (const it of mine) if (it.k === 'gained') extras.push(`took ${cName(it.c)}`);
    for (const it of mine) {
      if (it.k !== 'truce' || (it.what === 'broke' && it.with === reader)) continue;
      const w = it.with === reader ? 'you' : pName(state, it.with);
      if (it.what === 'broke') extras.push(`broke the truce with ${w}`);
      else if (it.what === 'agreed') extras.push(`made a truce with ${w}`);
      else extras.push(`offers ${w} a truce`);
    }
    extras.unshift(...yours);
    const name = pName(state, seat);
    const tail = state.players[seat].eliminated ? 'now out' : `now ${terrWord(territoryCount(state, seat))}, ${totalArmies(state, seat)} armies`;
    const head = (level: 0 | 1 | 2) =>
      took.length ? `${name} took ${tookPhrase(state, reader, took, level)}` : placed > 0 ? `${name} placed ${placed} ${placed === 1 ? 'army' : 'armies'}` : `${name} held`;
    // Everything with names first; when the line runs long, other seats' names give way to counts, then
    // the reader's, then the extras drop from the end (what stings the reader drops last).
    // Ladder: all names → other seats counted → the non-sting extras drop (the reader's own names stay)
    // → the reader's names counted too, extras dropping down to none.
    const tries: [0 | 1 | 2, number][] = [];
    for (let keep = extras.length; keep >= yours.length; keep--) tries.push([0, keep], [1, keep]);
    for (let keep = extras.length; keep >= 0; keep--) tries.push([2, keep]);
    let text = '';
    for (const [level, keep] of tries) {
      const t = [head(level), ...extras.slice(0, keep), tail].join(SEP);
      if (t.length <= RECEIPT_LINE_MAX) {
        text = t;
        break;
      }
    }
    if (!text) text = [head(2), tail].join(SEP);
    lines.push({ seat: seatRef(state, seat), text, territories: [...new Set(took.map((x) => x.t))], stings });
  }
  const me = state.players[reader];
  let summary: string | null = null;
  if (me && !me.eliminated) {
    const lost =
      lostT === 0 && lostC.length === 0
        ? 'You lost nothing'
        : `You lost ${[lostT ? terrWord(lostT) : null, lostC.length ? joinNames(lostC.map(cName)) : null].filter(Boolean).join(' and ')}`;
    summary = `${lost}${SEP}you hold ${territoryCount(state, reader)}`;
  }
  return { key, title, lines, summary };
}
