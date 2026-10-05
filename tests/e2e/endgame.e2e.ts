// The menu (the ≡ pill; Esc is its hidden accelerator): Resume · Rules · Settings · Ledger · Save & quit · End game now · Restart. The Log is
// read-only, newest first; AI speed lives in Settings. Then End game now → confirm → Victory (called in
// round N) with award cards, the territories chart and standings → Rematch (same seats, new seed, one
// click). The AIs play a few rounds first (autoplay at fast) so the ledgers have something to say.
import { ART, check, clearStorage, clickBtn, finish, open, rendered, state, ui } from './lib';

const results: string[] = [];
const { browser, page, errors } = await open();
await clearStorage(page);
await page.reload();
await page.waitForFunction(() => window.__risk?.ui().screen === 'title');
await clickBtn(page, 'title-new');
await page.locator('[data-testid="seat-name-0"]').fill('John');
await page.locator('[data-testid="seat-name-0"]').press('Enter');
await clickBtn(page, 'ng-more'); // v5.1 D: the seed is folded under More
await page.locator('[data-testid="house-seed"]').fill('777');
await page.locator('[data-testid="house-seed"]').press('Enter');
await clickBtn(page, 'ng-start');
await page.waitForFunction(() => window.__risk.getState()?.phase.kind === 'reinforce', null, { timeout: 30_000 });
await page.evaluate(() => {
  window.__risk.setSpeed(2, 'fast');
  window.__risk.autoplay(true);
});
await page.waitForFunction(() => (window.__risk.getState()?.round ?? 0) >= 5 || window.__risk.ui().screen === 'victory', null, { timeout: 240_000, polling: 200 });
await page.evaluate(() => window.__risk.autoplay(false));
const early = (await ui(page)).screen === 'victory';
if (!early) {
  await page.waitForFunction(
    () => {
      const s = window.__risk.getState();
      return !s || window.__risk.ui().screen !== 'game' || (s.currentPlayer === 0 && window.__risk.isIdle()) || s.players[0].eliminated;
    },
    null,
    { timeout: 120_000, polling: 100 },
  );
}
const s0 = (await state(page))!;
const round = s0.round;
if (!early) {
  await rendered(page);
  // The ≡ pill in the top HUD opens the menu.
  await clickBtn(page, 'menu');
  await page.waitForSelector('[data-testid="pause"]', { timeout: 3000 });
  const items = await page.locator('[data-testid="pause"] .menu-item .btn-label').allTextContents();
  check(items.join(' · ') === 'Resume · How to play · Settings · Ledger · Save & quit · End game now · Restart', `≡ → the menu: ${items.join(' · ')}`, results);
  await page.screenshot({ path: `${ART}/endgame-pause.png` });
  // The ledger (v3): read-only, by round, newest round first and open; the round headings fold.
  await clickBtn(page, 'pause-log');
  await page.waitForSelector('[data-testid="log"]', { timeout: 3000 });
  const rounds = await page.locator('[data-testid="log"] .lg-round').evaluateAll((els) => els.map((e) => Number((e as HTMLElement).dataset.round)));
  const lines = await page.locator('[data-testid="log"] .lg-round:not(.closed) .log-line').count();
  check(rounds.length > 2 && rounds.every((n, i) => i === 0 || n < rounds[i - 1]) && lines > 0, `ledger: ${rounds.length} rounds, newest first (R${rounds[0]} … R${rounds[rounds.length - 1]}), ${lines} lines open`, results);
  const clickable = await page.locator('[data-testid="log"] button:not([data-testid="log-close"]):not(.lg-head)').count();
  check(clickable === 0, 'ledger lines are read-only (only the round headings fold)', results);
  await clickBtn(page, 'log-close');
  await page.waitForSelector('[data-testid="pause"]', { timeout: 3000 });
  // Settings has AI speed.
  await clickBtn(page, 'pause-settings');
  await page.waitForSelector('[data-testid="settings"] [data-testid="ai-watch"]', { state: 'visible', timeout: 3000 }).catch(() => {});
  check((await page.locator('[data-testid="settings"] [data-testid="ai-watch"]').count()) === 1, 'AI speed lives in Settings', results);
  await clickBtn(page, 'settings-done');
  await page.waitForSelector('[data-testid="pause"]', { timeout: 3000 });
  await clickBtn(page, 'pause-endgame');
  await page.waitForSelector('[data-testid="confirm-yes"]', { state: 'visible', timeout: 3000 });
  const text = await page.locator('.confirm-text').textContent();
  check(/^End the game now\? \w+ wins on territories \(\d+ of 42\)\.$/.test(text ?? ''), `confirm: ${text}`, results);
  await clickBtn(page, 'confirm-yes');
  await page.waitForFunction(() => window.__risk.ui().screen === 'victory', null, { timeout: 10_000 });
  const save = await page.evaluate(() => localStorage.getItem('risk3d.save.v1'));
  check(!save, 'the save is cleared', results);
}
await page.screenshot({ path: `${ART}/endgame-banner.png` });
await page.waitForTimeout(3600); // 2.5 s banner + awards dealt 250 ms apart
const v = await page.evaluate(() => {
  const root = document.querySelector('[data-testid="victory"]');
  return {
    text: root?.textContent ?? '',
    awards: root ? root.querySelectorAll('.award').length : 0,
    chart: root ? root.querySelectorAll('.chart svg path, .chart svg polyline').length : 0,
    standings: root ? root.querySelectorAll('.standings li').length : 0,
  };
});
check(early || new RegExp(`Called in round ${round}`).test(v.text), `subline: ${early ? 'won outright' : `Called in round ${round}`}`, results);
check(v.awards >= 1, `${v.awards} award card(s)`, results);
check(v.chart >= 4, `territories chart drawn (${v.chart} series paths)`, results);
check(v.standings === 4, `standings: ${v.standings} seats`, results);
await page.screenshot({ path: `${ART}/endgame-victory.png` });
const seed0 = s0.config.seed;
await clickBtn(page, 'rematch');
await page.waitForFunction(() => window.__risk.ui().screen === 'game');
const r = (await state(page))!;
check(r.players.map((p) => `${p.name}:${p.kind}`).join(',') === s0.players.map((p) => `${p.name}:${p.kind}`).join(','), `Rematch: same seats (${r.players.map((p) => p.name).join(', ')})`, results);
check(r.config.seed !== seed0 && r.round <= 1, `Rematch: new seed (${seed0} → ${r.config.seed}), fresh game`, results);
await browser.close();
finish(results, errors);
