# War Table

**Play: https://jhuang124.github.io/war-table/**

The classic game of world conquest for 2 to 4 players around one screen — a laptop on the coffee table, a TV, or
one phone or tablet passed around the table. Any seat can be an AI. The board is an ink painting on indigo paper:
ivory coastlines, muted washes for each player, brush-drawn soldiers, riders and cannons, bone dice in a
lacquer tray, and one line of plain English that always says what to do next. At rest the board drifts
and breathes; a soft ambient score plays underneath. No accounts, no server, no online play: everything
runs in the browser and saves to it.

## Start

```sh
npm install
npm run dev
```

Open **http://127.0.0.1:5273** in Chrome, Edge, Safari or Firefox (any browser with WebGL 2).
Plug the laptop into the TV if you have one, and pick **Text size · TV** on the title screen.

For a production build: `npm run build`, then `npm run preview` (http://127.0.0.1:5274).

## On a phone or tablet

Open the link in Safari (iPhone, iPad) or Chrome (Android). **Share → Add to Home Screen** (Safari) or
**Install app** (Chrome) makes it a full-screen app with its own icon, and after the first visit it
plays offline.

- **Landscape is best on a phone** (the map is wide); portrait works too — the first time, a pill
  suggests rotating.
- **Tap** a territory to select it, **drag** to pan, **pinch** to zoom (**Reset view** brings the map
  home). **Touch and hold** a territory for its name card: continent and bonus, owner, armies.
- **Draw to attack**: in your Attack step, put a finger on one of your territories that can attack and
  drag to an enemy next to it. A gold brush stroke follows your finger; let go on the enemy to arm the
  attack (the same as tapping it), anywhere else to cancel. The stroke never rolls: **Roll** or
  **Blitz** does. A drag that starts anywhere else pans the map as usual.
- The bottom **dock** is the Turn Track (Place · Attack · Fortify · End), the line, and the buttons,
  in thumb reach, under the gold rule. In portrait it stacks in rows. **Cards N** is your hand.
- Menu, Settings, Rules, Log, your cards and the hand-off cover open as **sheets from the bottom**:
  pull one down by its handle (or tap outside it) to close it.
- **Hide cards between turns** is on by default on phones and tablets: with 2+ humans, the next
  player sees a "Pass to …" cover before their cards show (pull it down or press the button).
- Android phones buzz lightly on a select, the dice landing, and a conquest.

## Playing

**New game.** Name the seats (2–4), pick Human/AI (Easy · Normal · Hard), and click a seat's colour
emblem to pick from the six colours (Vermilion, Slate, Ochre, Sage, Wisteria, Plum; the first four
are the defaults, chosen to stay apart for colour-blind players). Pick a length and a
setup, then **Start**. The line above Start says exactly what you picked.

| Length | Goal | Estimate |
|---|---|---|
| Quick | 60% of the world, or most territories after 12 rounds (2 players: 75%) | shown on the button, from your seats |
| Evening (default) | 70% of the world (2 players: 80%) | ″ |
| Full conquest | every territory | ″ |

The estimates come from 200 simulated games (`npm run sim`) times the measured length of an AI turn
(about 5 s) and about 80 s per human turn, so a table of four humans sees longer numbers than one human
against three AIs.

| Setup | What happens |
|---|---|
| Quick deal (default) | Territories dealt at random, armies placed for you. You're playing in seconds. |
| Place your own | Territories dealt at random; you place your starting armies in two passes. Pick a territory, choose how many, **Place**; **Done** on the track commits the pass. |

**A turn.** The board fills the screen; the HUD floats on it. At the top, one ring per player (how many
territories they hold) and the ensō menu. At the bottom: one line saying what to do, the gold rule, and
under it the **Turn Track** (**Place · Attack · Fortify · End turn**), centred and never moving, with the
action buttons to its right (at most one count control and two buttons). Gold marks the one thing that
matters now: the button to press, the step you're on, or the stroke and the dice while a fight plays.

The track is how you move through a turn: click the next segment you want. It never goes back; a
segment you can't reach yet tells you why in the line ("Place your 3 armies first"); the one that's
recommended next is outlined in gold. A click on the board only ever selects; buttons (or a finished
brush stroke, which only arms) commit.

1. **Place.** Click one of your territories, pick how many armies (defaults to all; − N + for a few, a
   slider for more), press **Place N**. **Undo** takes back the last placement. **Cards N** shows your
   hand and trades your best set (at 5 cards you must trade first). Then click **Attack** on the track.
2. **Attack.** Click an enemy next to you; your strongest neighbour attacks (click another of yours to
   switch). Or **draw it**: press on one of your territories and drag to the enemy; a gold brush stroke
   follows and arms the attack when you let go on it (let go anywhere else to cancel). The line shows
   the odds in numbers and a word, plus what's at stake when something is:
   `Ural → Siberia · 82% · likely · takes Asia`. **Blitz** keeps rolling until it falls;
   **Roll** rolls once. After a win, pick how many to move in (the line shows what each side keeps)
   and press **Move N**; the new territory is then ready to keep attacking. Clicking the ocean or Esc
   clears a selection. Conquer at least one territory to earn a card.
3. **Fortify.** One move through your own territories: pick where from, where to, how many, then
   **Move N · end turn**. Or click **End turn** on the track (from Attack it skips fortifying).

Pieces show army size like the board game: a soldier for 1–4, a rider for 5–9, a cannon for 10+; the
number in the ring beside it is the exact count. If you pan, tilt or zoom away, **Reset view** appears
next to the menu.

When you lose a territory, its edge tears as the other colour soaks in, and your ring dims for a
moment; when you're knocked out, the line names who did it (`Sam · taken by John · round 9`). From
round 2, your turn line says who took what from you since your last turn.

AI turns play as a short highlight reel at the same pace as before: the AI's marker moves along the
same track and the line says what it did ("Cobalt takes Siam"). Change their pace in Settings. A click during an AI turn skips the
current fight; a click during your own animation finishes it (the track waits while dice roll).

**Ending.** First to the goal wins, or the menu (the ensō at the top right, or Esc) → **End game now**
calls it for whoever holds the most territories. The other colours dry back to paper and the victory
scroll rises: `John holds the world`, the round and territories, up to three award lines (Nemesis,
Hot/Cursed dice, Biggest cash-in), one ink line per player for the territories they held, and
**Rematch** (same seats, new dice).

The game autosaves after every action. Close the tab, come back, press **Continue**.

## Controls

Everything works with the mouse: the board to select, the buttons and the Turn Track to act. A few
hidden keys speed things up:

| Input | Does |
|---|---|
| Click a tile | Selects (what the bottom line says); never commits |
| Left-drag from one of your territories (Attack step) | Draws the attack: let go on an enemy next to it to arm it; anywhere else cancels |
| Click the ocean | Clears the selection |
| Left-drag (elsewhere) / right-drag / wheel | Pan / tilt a little (70–85°, ±10°) / zoom (**Reset view**, or the camera returns home at your next turn) |
| Enter | The gold thing: the gold button, or the gold-outlined track segment |
| Space | Blitz, or confirm a move / placement (never changes phase) |
| Esc | Back out one step, then the menu |

## Maps (New game → the Where row)

Five boards, all drawn by the same pipeline in the same ink: **Classic** (the board you know), **True World** (the
same 42 on a truer world), **Roman Empire** (45 provinces in 8 regions, from Britannia to the Nile), **Italian
Conquest** (40 territories around Italy and every shore that touches it) and **Modern Boston** (25 neighbourhoods;
the harbour is the only border that matters). Each pack is a folder under `maps/<id>/`; dropping a new folder in
registers it. To add one, follow `docs/MAP-AUTHORING.md` (about an hour for an agent).

## House rules (New game → More)

- **Draft territories**: take turns claiming territories instead of a random deal (adds ~10 min).
- **Card sets**: Growing (4, 6, 8, 10, 12, 15, then +5; the default) or Fixed (4 / 6 / 8 / 10).
- **Fortify**: along any connected chain of yours (default) or to a neighbour only.
- **Armies per setup turn** (Place your own): two passes (default), or 3 / 5 / 8 per turn.
- **Seed**: the same seed gives the same deal and dice.

## Settings (title screen or Pause → Settings)

Text size (Laptop · Couch · TV), animation speed for your own turns (1× · 2× · Instant), AI speed
(Watch · Fast · Skip), sound volume, mute, **ambient score** (a soft generative score under the game,
on by default at about a third of the effects' level, seeded by each game; switch and volume in
Settings), **living board** (the slow drift of mist and ink at rest, on by default; reduce motion turns
it off too), territory names on the board, show win chance, **Hide cards between turns** (a pass-the-device cover between two
humans; off by default on a laptop or TV, where everyone can see anyway, and on by default on phones and
tablets, which get passed around), return camera home each turn, and reduce motion (also follows the
system setting). On a phone, Text size steps are smaller (1.0 · 1.1 · 1.2) and live in Settings only.

## Troubleshooting

- **Blank or black screen**: the board needs WebGL. Check `chrome://gpu` (or try another browser);
  on some machines hardware acceleration is turned off in the browser's settings. As a fallback,
  `http://127.0.0.1:5273/?stub` plays on a flat 2D board.
- **No sound**: browsers only start audio after the first click or key press. Check mute
  and the volume in Settings.
- **Port 5273 is busy**: another dev server is running. Stop it, or run `npx vite --port 5280`.
- **Everything is tiny on the TV**: Text size → TV on the title screen (or Settings).
- **The camera got lost**: click **Reset view** (top right); it also returns home when your next turn starts.
- **Start over**: Pause → Restart, or clear the site's storage (`risk3d.*` keys in localStorage).
- **The installed app shows an old version**: it updates itself whenever it's opened online (the page is
  always fetched fresh first); close and reopen it once.
- **"Reloading the board…"**: the phone reclaimed the graphics memory; the board rebuilds itself and
  the game carries on where it was.

## For developers

| Command | What it does |
|---|---|
| `npm run dev` | Dev server, http://127.0.0.1:5273 |
| `npm test` | Unit tests (engine rules, AI, controller, pure helpers) |
| `npm run test:e2e` | Every Playwright flow in `tests/e2e/` against the real board and HUD (starts its own server on :5290; logs in `artifacts/e2e/`) |
| `npm run typecheck` | TypeScript |
| `npm run build` | Production build to `dist/` |
| `npm run sim -- 200` | AI-vs-AI soak: every game must finish legally; prints win rates and rounds-to-threshold |
| `npm run verify:map` | Checks board geometry against the classic borders and writes `artifacts/map/preview.png` |
| `npm run verify:audio` | Offline + live checks of the synthesized sound effects |
| `npm run gallery` | The HUD fixture gallery (`ui-gallery.html`) |
| `npx tsx tests/e2e/screens.ts [out] [targets]` | The ink screenshot sweep (desktop sizes and phones: title → victory, a drawn stroke, the verdict, the smoke and flood, 4 idle frames; server on `RISK_URL`) into `artifacts/ink/final/` |
| `npx tsx tests/e2e/mobile-screens.ts [out] [devices]` | Screenshot sweep of every state on emulated phones / tablets (server on `RISK_URL`) |
| `npx tsx scripts/units.ts` | Re-pack the unit sprites (`_claude/sprites/*-1.png`) into `public/units/atlas.webp` |
| `npx tsx tests/e2e/pwa-icons.ts` | Re-render the app icons in `public/icons/` from `icon.svg` |

Mobile: layouts are chosen by capability, never the user agent (`src/ui/layout.ts`): a phone-sized
viewport gets the phone layout (dock, sheets, one-column screens; `src/ui/mobile.css`), a touch screen
with room gets the desktop layout with 44 px targets, everything else is the desktop layout unchanged.
The mobile e2e flows (`mobile-turn`, `mobile-sheets`, `mobile-flow`, `pwa`) run on Playwright device
emulation (iPhone 15 Pro, Pixel 7, iPad Pro 11) with touch. The service worker (`public/sw.js`) is
stamped with a version and its precache list by `vite.config.ts` at build time and only registers in
production builds.

Dev pages: `render-sandbox.html` (the board alone, with an AI game and every animation on buttons),
`audio.html` (every sound), `ui-gallery.html` (every HUD state). `window.__risk` is the test API
(SPEC §9). Start with `SOUL.md` (what War Table is and how it should feel; it outranks every spec).
The build spec for the look, motion and sound is `docs/INK.md`; the rules and flows are in
`docs/SPEC.md`, with `docs/ROUND2.md` (the Turn Track, board clicks select / buttons commit) and
`docs/MOBILE.md` (touch devices) still binding where INK.md doesn't change them.
