// One reasoner: what a click on a territory does right now, or why it can't. Built only from engine
// helpers + mapData. The refused-click line and the controller's click handler both read from it, so
// they can never disagree. Board clicks only select (docs/ROUND2.md §B): a claim in a draft is the one
// click that commits; rolling, placing, occupying and changing phase are buttons and the Turn Track.

import {
  UNCLAIMED,
  mapDefOf,
  fortifySources,
  fortifyTargets,
  winProbability,
  type GameState,
  type TerritoryId,
} from '../engine';
import { SEP, click, pName, poss, tName } from './copy';
import { autoSource, canAttackFrom, oddsWord, ownNeighbors } from './helpers';
import { pct } from './copy';

export type ReasonCode =
  | 'not_yours'
  | 'one_army'
  | 'no_source_for_target'
  | 'no_enemy_neighbors'
  | 'not_adjacent'
  | 'own_as_target'
  | 'must_trade_first'
  | 'must_occupy_first'
  | 'none_left'
  | 'fortify_unreachable'
  | 'fortify_not_adjacent'
  | 'fortify_one_army'
  | 'already_claimed';

export const REASON_CODES: ReasonCode[] = [
  'not_yours',
  'one_army',
  'no_source_for_target',
  'no_enemy_neighbors',
  'not_adjacent',
  'own_as_target',
  'must_trade_first',
  'must_occupy_first',
  'none_left',
  'fortify_unreachable',
  'fortify_not_adjacent',
  'fortify_one_army',
  'already_claimed',
];

/** What a successful click does. The controller executes exactly this. */
export type ClickPlan =
  | { kind: 'claim'; t: TerritoryId }
  /** Place / setup: pick the territory the count places on. */
  | { kind: 'pick'; t: TerritoryId }
  | { kind: 'selectSource'; t: TerritoryId }
  | { kind: 'deselect' }
  /** Select a fight (Roll / Blitz commit it). */
  | { kind: 'arm'; from: TerritoryId; to: TerritoryId }
  | { kind: 'fortifySource'; t: TerritoryId }
  | { kind: 'fortifyDest'; from: TerritoryId; to: TerritoryId };

export interface ExplainUi {
  /** Selected source (attack or fortify). */
  selected: TerritoryId | null;
  /** Armed attack target / chosen fortify destination. */
  target: TerritoryId | null;
  /** Manual setup: armies staged locally this setup turn. */
  staged?: Partial<Record<TerritoryId, number>>;
  /** False during watched turns (AI, or another human behind the hand-off cover). */
  interactive: boolean;
  showWinChance?: boolean;
}

export interface Explanation {
  ok: boolean;
  /** What the click does when ok ('Place here', 'Attack · 82% · likely', 'Move troops here'). */
  verb?: string;
  code?: ReasonCode;
  /** The verb when ok, the refused-click reason when not. */
  text: string;
  plan?: ClickPlan;
}

const ok = (verb: string, plan: ClickPlan): Explanation => ({ ok: true, verb, text: verb, plan });
const no = (code: ReasonCode, text: string): Explanation => ({ ok: false, code, text });

function oddsVerb(state: GameState, from: TerritoryId, to: TerritoryId, ui: ExplainUi, prefix: string): string {
  const p = winProbability(state.territories[from].armies, state.territories[to].armies);
  return ui.showWinChance === false ? `${prefix}${SEP}${oddsWord(p)}` : `${prefix}${SEP}${pct(p)}%${SEP}${oddsWord(p)}`;
}

function stagedTotal(ui: ExplainUi): number {
  let n = 0;
  for (const v of Object.values(ui.staged ?? {})) n += v ?? 0;
  return n;
}

/** Attack-step click with the given selection. Clicking the armed target again keeps it armed. */
function explainAttack(state: GameState, ui: ExplainUi, t: TerritoryId): Explanation {
  const me = state.currentPlayer;
  const ts = state.territories[t];
  const sel = ui.selected;
  if (ts.owner !== me) {
    if (sel && mapDefOf(state.config).adjacency[sel].includes(t) && state.territories[sel].armies >= 2 && state.territories[sel].owner === me) {
      return ok(oddsVerb(state, sel, t, ui, 'Attack'), { kind: 'arm', from: sel, to: t });
    }
    const src = autoSource(state, t, me);
    if (src) return ok(oddsVerb(state, src, t, ui, 'Attack'), { kind: 'arm', from: src, to: t });
    if (ownNeighbors(state, t, me).length === 0) {
      return no(
        'not_adjacent',
        `${tName(t)} doesn't border any of yours`,
      );
    }
    return no('no_source_for_target', `Nothing of yours next to ${tName(t)} has 2+ armies`);
  }
  // Own tile.
  if (sel === t) return ok('Deselect', { kind: 'deselect' });
  if (canAttackFrom(state, t, me)) {
    const n = state.territories[t] && mapDefOf(state.config).adjacency[t].filter((x) => state.territories[x].owner !== me && state.territories[x].owner >= 0).length;
    const verb = `Attack from here${SEP}${n === 1 ? '1 target' : `${n} targets`}`;
    if (ui.target && mapDefOf(state.config).adjacency[t].includes(ui.target) && state.territories[ui.target].owner !== me) {
      return ok(verb, { kind: 'arm', from: t, to: ui.target });
    }
    return ok(verb, { kind: 'selectSource', t });
  }
  if (sel) return no('own_as_target', `That's yours${SEP}${click()} an enemy next to ${tName(sel)}`);
  if (ts.armies < 2) return no('one_army', `${tName(t)} has 1 army${SEP}you need 2 to attack`);
  return no('no_enemy_neighbors', `Everything next to ${tName(t)} is already yours`);
}

/**
 * explainTerritory(state, ui, t): what clicking `t` does now ({ ok, verb, plan }), or why it can't
 * ({ ok: false, code, text }). Pure.
 */
export function explainTerritory(state: GameState, ui: ExplainUi, t: TerritoryId): Explanation {
  const ph = state.phase;
  if (ph.kind === 'game-over') return { ok: false, text: 'The game is over' };
  const me = state.currentPlayer;
  if (!ui.interactive) return { ok: false, text: `${poss(pName(state, me))} turn` };
  const ts = state.territories[t];
  if (!ts) return { ok: false, text: '' };
  const enemyName = ts.owner >= 0 ? pName(state, ts.owner) : '';
  const notYours = () => no('not_yours', `That's ${poss(enemyName)}${SEP}${click()} one of your territories`);

  switch (ph.kind) {
    case 'setup-claim': {
      if (ts.owner === UNCLAIMED) return ok('Claim it', { kind: 'claim', t });
      return no(
        'already_claimed',
        ts.owner === me ? `You already claimed that${SEP}pick an open tile` : `${enemyName} already claimed that${SEP}pick an open tile`,
      );
    }
    case 'setup-place': {
      if (ts.owner !== me) return notYours();
      if (stagedTotal(ui) >= ph.toPlace) return no('none_left', `All ${ph.toPlace} placed${SEP}${click()} Done`);
      return ok('Place here', { kind: 'pick', t });
    }
    case 'reinforce': {
      if (ph.mustTrade) {
        const n = state.players[me].cards.length;
        return no('must_trade_first', `You hold ${n} cards${SEP}trade a set first`);
      }
      if (ph.remaining > 0) {
        if (ts.owner !== me) return notYours();
        return ok('Place here', { kind: 'pick', t });
      }
      // All placed: the track moves on, never a board click.
      return no('none_left', `All armies placed${SEP}${click()} Attack to go on`);
    }
    case 'attack':
      return explainAttack(state, ui, t);
    case 'occupy':
      return no('must_occupy_first', `Finish moving armies into ${tName(ph.to)} first`);
    case 'fortify': {
      if (ts.owner !== me) return notYours();
      const sel = ui.selected;
      if (sel === t) return ok('Deselect', { kind: 'deselect' });
      if (sel) {
        if (fortifyTargets(state, sel).includes(t)) return ok('Move troops here', { kind: 'fortifyDest', from: sel, to: t });
        if (fortifySources(state, me).includes(t) && fortifyTargets(state, t).length > 0) {
          return ok('Move troops from here', { kind: 'fortifySource', t });
        }
        if (state.config.fortifyRule === 'adjacent') return no('fortify_not_adjacent', 'House rule: fortify only to a neighbor');
        return no('fortify_unreachable', `Can't reach ${tName(t)}${SEP}only through your own land`);
      }
      if (ts.armies < 2) return no('fortify_one_army', `${tName(t)} has 1 army${SEP}1 has to stay to hold it`);
      if (fortifyTargets(state, t).length === 0) return no('fortify_unreachable', `Nowhere to go from ${tName(t)}`);
      return ok('Move troops from here', { kind: 'fortifySource', t });
    }
  }
  return { ok: false, text: '' };
}
