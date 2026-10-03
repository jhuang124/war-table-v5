// Chaining after a conquest on the real board + HUD (review round 1, carried through round 2, where
// board clicks only select and the occupy is committed by `Move N`, docs/ROUND2.md §B).
//   R1-02 during occupy a board click is refused (even an enemy next to your own stack); `Move N` moves
//         the chosen count, and a target-first click then arms from the strongest stack
//   R1-05 the tray header never shows one owner on both sides; a conquest reads `Indonesia captured`
//         for ~1 s, then clears (at once on a new selection / phase change)
//   R1-11 the line never describes a half-moved board after a conquest
//   R1-21 Enter pressed right after a click that changes the brass thing never fires a Blitz the
//         player hasn't seen
//   R1-13 the random deal never shows claim-phase copy
//   R1-14 an Undo after a refused click restores the live line (setup); Done is on the Turn Track
import { applyAction } from '../../src/engine';
import { ART, TWO_HUMANS, check, clickBtn, clickT, finish, idle, loadScenario, open, place, scenario, seg, setCount, state, ui } from './lib';

const results: string[] = [];
const { browser, page, errors } = await open();
const shot = (name: string) => page.screenshot({ path: `${ART}/chain-${name}.png` });

// --- R1-02: Greenland 10 took Ontario; click Iceland (next to Greenland, not to Ontario) -------------
const occ = () =>
  scenario({ greenland: [0, 10], ontario: [0, 0] }, { kind: 'occupy', from: 'greenland', to: 'ontario', min: 3, max: 9, previousOwner: 1 });
{
  const s0 = occ();
  await loadScenario(page, s0);
  const u0 = await ui(page);
  check(u0.line === 'Move into Ontario' && u0.primary === 'Move 9' && u0.trackDisabled, `occupy shows Move 9 (${u0.line} · ${u0.primary}), track disabled`, results);
  const ex = await page.evaluate(() => window.__risk.explain('iceland'));
  check(!ex.ok && ex.code === 'must_occupy_first' && ex.text === 'Finish moving armies into Ontario first', `explain(Iceland): ${ex.code} "${ex.text}"`, results);
  const pos = (await page.evaluate(() => window.__risk.screenPos('iceland')))!;
  await page.mouse.move(pos.x, pos.y);
  await page.waitForTimeout(600);
  check((await page.locator('.tooltip').count()) === 0, 'hovering shows no tooltip (the board names the tile)', results);
  await shot('r1-02-occupy-hover-iceland');
  await clickT(page, 'iceland');
  await page.waitForTimeout(80);
  let s1 = (await page.evaluate(() => window.__risk.getState()))!;
  let u1 = await ui(page);
  check(s1.phase.kind === 'occupy' && s1.territories.ontario.armies === 0 && u1.line === ex.text && u1.lineKind === 'rejection', `board click during occupy refused, nothing moved (Ontario ${s1.territories.ontario.armies}): "${u1.line}"`, results);
  // Choose the minimum with the count control, then Move.
  await setCount(page, 3);
  u1 = await ui(page);
  const hasPreview = await page.evaluate(() => typeof (window.__board as unknown as { setCountPreview?: unknown }).setCountPreview === 'function');
  check(u1.primary === 'Move 3' && (u1.line === 'Greenland 7 · Ontario 3' || (hasPreview && u1.line === 'Move into Ontario')), `count 3: "${u1.line}" · ${u1.primary}`, results);
  await clickBtn(page, 'btn-move');
  await idle(page);
  s1 = (await page.evaluate(() => window.__risk.getState()))!;
  u1 = await ui(page);
  check(s1.territories.ontario.armies === 3 && s1.territories.greenland.armies === 7, `Move 3: Ontario ${s1.territories.ontario.armies}, Greenland ${s1.territories.greenland.armies}`, results);
  check(u1.line === 'Attack from Ontario · click an enemy', `after Move, the conquered tile is the source: ${u1.line}`, results);
  // Target-first: Iceland borders Greenland, not Ontario → armed from the Greenland stack.
  await clickT(page, 'iceland');
  await page.waitForTimeout(80);
  u1 = await ui(page);
  check(/^Greenland → Iceland · \d+%( · .+)?$/.test(u1.line), `armed from the stack: ${u1.line}`, results);
  check(u1.battle?.header === 'GREENLAND 7 vs ICELAND 1', `tray header: ${u1.battle?.header}`, results);
  // Clicking the armed target again does not roll.
  await clickT(page, 'iceland');
  await page.waitForTimeout(300);
  const s2 = (await page.evaluate(() => window.__risk.getState()))!;
  u1 = await ui(page);
  check(s2.territories.iceland.armies === 1 && s2.territories.greenland.armies === 7 && u1.buttons.join(' / ') === 'Roll / Blitz' && /^Greenland → Iceland/.test(u1.line), `clicking the armed target again keeps it armed, no roll (${u1.line})`, results);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(500);
  await shot('r1-02-after-chain-click');
}

// --- R1-21: Enter pressed while the Move march still shows the old brass `Move 9` is spent -------------
// (It never re-fires Move and never fires whatever the brass thing becomes after the click-through.)
{
  await loadScenario(page, occ());
  await clickBtn(page, 'btn-move');
  const during = await ui(page);
  await page.keyboard.press('Enter');
  await idle(page);
  await page.waitForTimeout(400);
  const s = (await page.evaluate(() => window.__risk.getState()))!;
  const u = await ui(page);
  console.log(`   at Enter the strip read "${during.line}" · ${during.primary}`);
  check(s.phase.kind === 'attack' && s.territories.ontario.armies === 9 && s.territories.greenland.armies === 1, `Enter during the march did nothing more (Ontario ${s.territories.ontario.armies}, Greenland ${s.territories.greenland.armies}, ${s.phase.kind})`, results);
  check(u.line === 'Attack from Ontario · click an enemy' && u.primary === null, `settles on the source, nothing armed: ${u.line}`, results);
  // Then the chain click arms and waits for Roll / Blitz.
  await clickT(page, 'alberta');
  await page.waitForTimeout(300);
  const s2 = (await page.evaluate(() => window.__risk.getState()))!;
  const u2 = await ui(page);
  check(s2.territories.alberta.owner !== 0 && u2.primary === 'Blitz' && /^Ontario → Alberta · \d+%( · .+)?$/.test(u2.line), `armed and waiting: ${u2.line} · ${u2.primary}`, results);
}

// --- R1-05 / R1-11: one roll conquers Indonesia from New Guinea 3 (auto-occupy, then chain) ----------
{
  const base = scenario({ new_guinea: [0, 3], western_australia: [0, 1], eastern_australia: [0, 1] }, { kind: 'attack' }, {
    mutate: (s) => {
      s.territories.indonesia = { owner: 1, armies: 1 };
    },
  });
  for (let seed = 1; seed < 500; seed++) {
    base.rng = seed;
    const r = applyAction(base, { type: 'attack', player: 0, from: 'new_guinea', to: 'indonesia', dice: 2 });
    if (r.ok && r.state.territories.indonesia.owner === 0) break;
  }
  await loadScenario(page, base);
  await clickT(page, 'indonesia');
  await page.waitForTimeout(80);
  // Page-side header timeline (every frame), so the screenshots below can't skew the timing.
  await page.evaluate(`(() => {
    const T = (window.__hdr = { log: [], stop: false });
    let last;
    const f = () => {
      const h = window.__risk.ui().battle?.header ?? null;
      if (h !== last) { T.log.push({ t: performance.now(), h }); last = h; }
      if (!T.stop) requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  })()`);
  await clickBtn(page, 'btn-roll'); // roll once
  const t0 = Date.now();
  const samples: { t: number; line: string; header: string | null }[] = [];
  let shots = 0;
  while (Date.now() - t0 < 4200) {
    const u = await ui(page);
    samples.push({ t: Date.now() - t0, line: u.line, header: u.battle?.header ?? null });
    const t = Date.now() - t0;
    if ((shots === 0 && t > 1300) || (shots === 1 && t > 1900) || (shots === 2 && t > 2600)) await shot(`r1-05-conquest-${shots++}`);
    await page.waitForTimeout(40);
  }
  const headers = [...new Set(samples.map((x) => x.header).filter(Boolean))] as string[];
  const lines = [...new Set(samples.map((x) => x.line))];
  console.log('   headers: ' + headers.join(' | '));
  console.log('   lines:   ' + lines.join(' | '));
  check(headers.every((h) => !/^INDONESIA .* vs INDONESIA/.test(h)), `no header pits a tile against itself (${headers.join(' | ')})`, results);
  check(headers.includes('Indonesia captured'), 'the conquest header reads "Indonesia captured"', results);
  check(headers.every((h) => h === 'Indonesia captured' || h === 'NEW GUINEA 3 vs INDONESIA 1' || h === 'NEW GUINEA 3 vs INDONESIA 0'), `the pair header only ever shows the armies before / at the verdict (${headers.join(' | ')})`, results);
  await page.evaluate('window.__hdr.stop = true');
  const hdr = ((await page.evaluate('window.__hdr.log')) as { t: number; h: string | null }[]);
  const iCap = hdr.findIndex((x) => x.h === 'Indonesia captured');
  const heldMs = iCap >= 0 && hdr[iCap + 1] ? Math.round(hdr[iCap + 1].t - hdr[iCap].t) : -1;
  const after = iCap >= 0 ? hdr[iCap + 1]?.h : undefined;
  check(iCap >= 0 && heldMs >= 600 && heldMs <= 1500 && after === null, `"Indonesia captured" held ~1 s (${heldMs} ms), then the header cleared (${after})`, results);
  check(!lines.some((l) => /from New Guinea · 1/.test(l)), 'the line never describes a half-moved board', results);
  check(lines.some((l) => l.startsWith('You took Indonesia')), 'the line says "You took Indonesia…" while the conquest plays', results);
  const last = samples[samples.length - 1];
  check(last.line === 'Attack from Indonesia · click an enemy', `settles on the chained source: ${last.line}`, results);
}

// --- R1-14: setup-place, a refused click after all are placed, then Undo ------------------------------
{
  const s = scenario({ ural: [0, 1], ukraine: [0, 1] }, { kind: 'setup-place', toPlace: 3 }, {
    mutate: (x) => {
      x.round = 0;
      x.turn = 0;
      x.players[0].setupArmies = 3;
    },
  });
  await loadScenario(page, s);
  await place(page, 'ural');
  await clickT(page, 'ural');
  await page.waitForTimeout(100);
  const a = await ui(page);
  check(a.line === 'All 3 placed · click Done' && a.lineKind === 'rejection', `refused click: ${a.line}`, results);
  check(a.track.join(' ') === 'current:setup eligible:done' && a.recommended === 'done' && a.brass.join() === 'Done', `all staged: track ${a.track.join(' ')} · brass [${a.brass.join(', ')}]`, results);
  await clickBtn(page, 'btn-undo');
  await page.waitForTimeout(150);
  const b = await ui(page);
  check(b.line === 'Place 3 armies · click a territory' && b.lineKind === 'normal' && b.track.includes('locked:done') && b.buttons.length === 0, `after Undo: ${b.line} · ${b.track.join(' ')} · ${b.buttons.join(' / ') || 'no buttons'}`, results);
  // Stage again, then Done on the track commits the placement.
  await place(page, 'ural');
  await page.waitForTimeout(100);
  const c = await ui(page);
  check(c.line === 'All 3 placed · click Done' && c.lineKind === 'normal', `all staged again: ${c.line}`, results);
  await seg(page, 'done');
  await idle(page);
  const sd = await state(page);
  check(sd!.territories.ural.armies === 4, `Done committed the placement (Ural ${sd!.territories.ural.armies})`, results);
}

// --- Round 2 §E: the "captured" header clears at once on a phase change (Move) -----------------------
{
  await loadScenario(page, scenario({ ural: [0, 12] }, { kind: 'attack' }));
  await clickT(page, 'siberia');
  await clickBtn(page, 'btn-blitz');
  const got = await page.waitForFunction(() => window.__risk.ui().battle?.header === 'Siberia captured', null, { timeout: 5000 }).then(() => true, () => false);
  check(got, 'blitz conquest: header "Siberia captured"', results);
  const ph = (await state(page))!.phase.kind;
  if (ph === 'occupy') {
    await idle(page);
    await clickBtn(page, 'btn-move');
    await page.waitForTimeout(50);
    const h = (await ui(page)).battle?.header ?? null;
    check(h !== 'Siberia captured', `Move clears the captured header at once (${h})`, results);
  } else check(false, `expected an occupy step after the blitz (${ph})`, results);
}

// --- R1-13: a Place-your-own game with a human first: the deal never says "Claim a territory" --------
{
  await page.evaluate((players) => {
    localStorage.clear();
    window.__risk.newGame({ players: players as never, seed: 4, setupMode: 'random', initialPlacement: 'manual', setupBatch: 10 });
  }, TWO_HUMANS);
  const t0 = Date.now();
  const lines = new Set<string>();
  let shotDone = false;
  while (Date.now() - t0 < 2500) {
    lines.add((await ui(page)).line);
    if (!shotDone && Date.now() - t0 > 500) {
      await shot('r1-13-deal');
      shotDone = true;
    }
    await page.waitForTimeout(40);
  }
  console.log('   deal lines: ' + [...lines].join(' | '));
  check(![...lines].some((l) => /^Claim a territory/.test(l)), 'no claim copy during the random deal', results);
  check([...lines].includes('Dealing territories'), 'line 1 says "Dealing territories"', results);
}

await browser.close();
finish(results, errors);
