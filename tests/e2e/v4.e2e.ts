// v4 audits (_claude/v4/PLAN.md §5b): the checks that can be automated for "one hand".
//   E6 type scale   every font-size on the game screen is on the scale 11 / 14 / 18 / 24 / 40 px
//   E6 numerals     every stone numeral ≥ 18 px on desktop
//   P1 drift        a mist edge moves ≥ 1 px over 2 s, the coast glow ≥ 1 px (BoardView.paperDrift hook)
//   E5 tier bands   every board event that carries a tier keeps its motion inside the tier's band at 1×
//   A5 truce        an old save with a pending truce offer never hides the Place count control (the v3 bug);
//                   v5.1 C: nothing asks the player to answer it (no Accept / Decline)
// Logic lane, realtime (drift and motion need real time). Numbers are always printed.
import { check, clickT, finish, loadScenario, open, ui } from './lib';
import { restBoard } from './board-lib';

const results: string[] = [];
const { browser, page, errors } = await open(undefined, { width: 1440, height: 900 });
await loadScenario(page, restBoard({ kind: 'attack' }));
await page.waitForTimeout(1200);

// --- E6 type scale -------------------------------------------------------------------------------------
const SCALE = [11, 14, 18, 24, 40];
const fonts = await page.evaluate(() => {
  const out: { sel: string; px: number; text: string }[] = [];
  const seen = new Map<number, number>();
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('#ui *'))) {
    if (!el.textContent?.trim() || el.children.length) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const px = parseFloat(cs.fontSize);
    seen.set(Math.round(px * 10) / 10, (seen.get(Math.round(px * 10) / 10) ?? 0) + 1);
    const cls = el.className && typeof el.className === 'string' ? '.' + el.className.split(/\s+/).slice(0, 2).join('.') : el.tagName.toLowerCase();
    out.push({ sel: cls, px, text: el.textContent.trim().slice(0, 24) });
  }
  return { out, seen: Array.from(seen.entries()).sort((a, b) => a[0] - b[0]) };
});
const offScale = fonts.out.filter((f) => !SCALE.some((s) => Math.abs(f.px - s) <= 0.75) && !/wordmark|title-word/.test(f.sel));
results.push(`type sizes on screen: ${fonts.seen.map(([px, n]) => `${px}px×${n}`).join(', ')}`);
check(offScale.length === 0, `E6 every font-size on the game screen is on the scale (${offScale.length} off: ${[...new Set(offScale.map((f) => `${f.sel} ${f.px.toFixed(1)}px "${f.text}"`))].slice(0, 6).join('; ')})`, results);

// --- E6 numerals ---------------------------------------------------------------------------------------
const nums = await page.evaluate(() =>
  Array.from(document.querySelectorAll<HTMLElement>('.rb-badge .n'))
    .filter((el) => el.getBoundingClientRect().width > 0 && getComputedStyle(el).opacity !== '0')
    .map((el) => parseFloat(getComputedStyle(el).fontSize)),
);
const minNum = nums.length ? Math.min(...nums) : 0;
results.push(`numerals: ${nums.length} visible, ${minNum.toFixed(1)}–${(nums.length ? Math.max(...nums) : 0).toFixed(1)} px`);
check(nums.length > 0 && minNum >= 17.5, `E6 every stone numeral ≥ 18 px on desktop (min ${minNum.toFixed(1)})`, results);

// --- P1 drift ------------------------------------------------------------------------------------------
const drift = await page.evaluate(async () => {
  const b = (window as unknown as { __board?: { paperDrift?: (ms?: number) => Promise<{ mistPx: number; glowPx: number }> } }).__board;
  if (!b?.paperDrift) return null;
  return await b.paperDrift(2000);
});
if (!drift) check(false, 'P1 drift hook (BoardView.paperDrift) present', results);
else {
  results.push(`drift over 2 s: mist ${drift.mistPx.toFixed(1)} px, glow ${drift.glowPx.toFixed(1)} px`);
  check(drift.mistPx >= 1 && drift.glowPx >= 1, 'P1 a mist edge and the coast glow each move ≥ 1 px over 2 s', results);
}

// --- E5 tier bands: one human fight --------------------------------------------------------------------
const BANDS: Record<number, [number, number]> = { 0: [160, 290], 1: [400, 650], 2: [650, 1200], 3: [1600, 2400] };
await clickT(page, 'ural');
await clickT(page, 'siberia');
const u = await ui(page);
const rollId = u.buttons.find((b: string) => /roll/i.test(b)) ?? u.buttons.find((b: string) => /blitz/i.test(b));
if (rollId) {
  await page.locator(`[data-testid="btn-${rollId.toLowerCase()}"]`).first().click().catch(() => page.getByText(/^Roll$/).first().click());
  await page.waitForTimeout(3500);
}
const raw = await page.evaluate(() => {
  const d = (window as unknown as { __board?: { __debug?: { motionLog?: { type: string; tier?: number | null; ms: number; motionMs?: number | null; speed: number; style?: string }[] } } }).__board?.__debug;
  return d?.motionLog ?? [];
});
const log = raw.map((e) => ({ ...e, ms: e.motionMs ?? e.ms }));
results.push(`motion log sample: ${log.slice(-8).map((e) => `${e.type}/${e.style ?? '-'}/t${e.tier ?? '-'}/${e.ms}ms/×${e.speed}`).join(', ')}`);
const tiered = log.filter((e) => e.tier !== undefined && e.tier !== null && e.speed === 1);
const tieredBand = tiered.filter((e) => !(e.type === 'diceRolled' && e.style !== 'readable'));
results.push(`motion log: ${log.length} events, ${tiered.length} with a tier${rollId ? '' : ' (no roll button found)'}`);
const outOfBand = tieredBand.filter((e) => {
  const [lo, hi] = BANDS[e.tier as number] ?? [0, Infinity];
  return e.ms < lo * 0.85 || e.ms > hi * 1.15;
});
check(tiered.length > 0, 'E5 the controller tags board events with a tier', results);
check(outOfBand.length === 0, `E5 every tiered event stays inside its band ±15 % (${outOfBand.length} out: ${outOfBand.slice(0, 4).map((e) => `${e.type} t${e.tier} ${e.ms}ms`).join(', ')})`, results);

// --- A5 truce never hides the Place control -------------------------------------------------------------
await loadScenario(
  page,
  restBoard({ kind: 'reinforce', remaining: 3, mustTrade: false, placed: {}, midTurn: false }, (s) => {
    const st = s as unknown as { config: Record<string, unknown>; diplomacy?: unknown; turn: number };
    st.config = { ...st.config, diplomacy: true };
    st.diplomacy = { truces: [], offers: [{ from: 1, to: 0, rounds: 3, kind: 'noAttack', turn: st.turn }], proposedOn: { 1: st.turn }, rebuffs: [] };
  }),
);
await clickT(page, 'ural');
const hasCount = await page.waitForFunction(() => !!window.__risk.ui().count, null, { timeout: 2500 }).then(() => true, () => false);
const u2 = await ui(page);
results.push(`with a pending truce offer in the save: buttons ${u2.buttons.join('/')}, count control ${hasCount ? 'present' : 'missing'}`);
check(hasCount, 'A5 a pending truce offer (an old save) does not hide the Place count control', results);
const answer = await page.locator('[data-testid="btn-acceptTruce"], [data-testid="btn-declineTruce"]').count();
check(u2.offer === null && answer === 0 && u2.gold !== 'button:acceptTruce', `A5 v5.1: no offer to answer while placing (offer ${JSON.stringify(u2.offer)}, Accept/Decline ${answer}, gold ${u2.gold})`, results);

await browser.close();
finish(results, errors);
