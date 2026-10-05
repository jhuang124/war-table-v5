// Balance notes for verify:map (docs/MAP-AUTHORING.md, step g): a continent's bonus against how hard it is to
// hold, the board's size against classic's, and the AI soak (`npm run sim 30 -- --map <id>`).
//
// The suggested bonus is round((territories + border territories) / 2 − 1), at least 1: a border territory is
// one with a neighbour in another continent (a door you have to guard). It reproduces classic's North
// America 5, South America 2, Europe 5 and Australia 2 exactly and puts Africa and Asia one above (4, 8;
// classic's 3 and 7 are famously cheap). A bonus two or more away from the suggestion is worth a look.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BoardGeometry } from '../../src/map/types';
import { ROOT, type LoadedPack } from './pack';

export function suggestedBonus(territories: number, borderTerritories: number): number {
  return Math.max(1, Math.round((territories + borderTerritories) / 2 - 1));
}

export function continentStats(p: LoadedPack) {
  const adj = new Map<string, string[]>(p.territoryIds.map((t) => [t, []]));
  for (const [a, b] of p.topology.borders) adj.get(a)?.push(b), adj.get(b)?.push(a);
  return p.rules.continents.map((c) => {
    const ts = p.territoryIds.filter((t) => p.continentOf[t] === c.id);
    const doors = ts.filter((t) => adj.get(t)!.some((u) => p.continentOf[u] !== c.id));
    const exits = ts.reduce((s, t) => s + adj.get(t)!.filter((u) => p.continentOf[u] !== c.id).length, 0);
    return { id: c.id, name: c.name, bonus: c.bonus, territories: ts.length, borders: doors.length, exits, suggested: suggestedBonus(ts.length, doors.length) };
  });
}

const meanArea = (b: BoardGeometry) => {
  const a = Object.values(b.territories).map((t) => t.area);
  return a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
};

export function balanceNotes(p: LoadedPack, board: BoardGeometry): { rows: string[]; notes: string[] } {
  const rows: string[] = [];
  const notes: string[] = [];
  for (const s of continentStats(p)) {
    const off = s.bonus - s.suggested;
    rows.push(
      `  ${s.name.padEnd(18)} +${String(s.bonus).padEnd(2)} ${String(s.territories).padStart(2)} territories, ${s.borders} on its border (${s.exits} ways in)  suggest +${s.suggested}${Math.abs(off) >= 2 ? '  ← look again' : ''}`,
    );
    if (Math.abs(off) >= 2) notes.push(`NOTE: ${s.name} bonus +${s.bonus} is ${off > 0 ? 'high' : 'low'} for ${s.territories} territories with ${s.borders} to guard (suggest +${s.suggested})`);
  }
  const n = p.territoryIds.length, c = p.rules.continents.length;
  if (n < 25 || n > 45) notes.push(`NOTE: ${n} territories; a new board aims for 25–45 (docs/MAP-AUTHORING.md)`);
  if (c < 3 || c > 7) notes.push(`NOTE: ${c} continents; a new board aims for 3–7`);
  if (p.id !== 'classic') {
    try {
      const classic = JSON.parse(readFileSync(resolve(ROOT, 'maps/classic/board.json'), 'utf8')) as BoardGeometry;
      const mine = meanArea(board), theirs = meanArea(classic);
      const ratio = mine / theirs;
      rows.push(`  mean territory area ${mine.toFixed(1)} sq units (classic ${theirs.toFixed(1)}, ×${ratio.toFixed(2)})`);
      if (ratio < 0.6 || ratio > 1.8) notes.push(`NOTE: territories are ×${ratio.toFixed(2)} classic's size on average; adjust the projection width so armies and land read at the same scale`);
    } catch {
      /* no classic board: nothing to compare */
    }
  }
  return { rows, notes };
}

/** `npm run sim <games> -- --map <id>`: must exit 0 and print its rounds line. */
export async function runSim(id: string, games: number): Promise<{ ok: boolean; rounds: string; tail: string; note?: string }> {
  const r = spawnSync('npx', ['tsx', 'scripts/simulate.ts', String(games), '--map', id], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const rounds = /^rounds: .*$/m.exec(out)?.[0] ?? '';
  const supportsMap = /--map/.test(readFileSync(resolve(ROOT, 'scripts/simulate.ts'), 'utf8'));
  return {
    ok: r.status === 0 && !!rounds,
    rounds,
    tail: out.split('\n').slice(-12).join('\n'),
    note: supportsMap ? undefined : `NOTE: scripts/simulate.ts ignores --map today, so the sim above played classic (a request to the game builder)`,
  };
}
