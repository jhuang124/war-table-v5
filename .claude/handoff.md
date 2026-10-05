# Handoff — War Table v2 (INK2): phases 0/A/B/C merged, Phase D integration running (2026-09-30)

## Mission
John (PM, building technical fluency; his taste rules) is building **War Table**, a 3D pass-and-play Risk for
him + up to 3 friends on one laptop/TV/phone, live at https://jhuang124.github.io/war-table/ (repo
`jhuang124/war-table`; push to `main` deploys via Pages). v1 "ink & night" shipped 2026-09-29. v2 takes it
from polished prototype toward production: spec `docs/INK2.md` (written by Fable 5.1, John's answers in §6).

## State
- **Two deploys**: v2 live at https://jhuang124.github.io/war-table/ (repo war-table, main, `d3717cc`; untouched).
  v3 staging at https://jhuang124.github.io/war-table-v3/ (repo war-table-v3; local branch `v3`, remote `v3`;
  `git push v3 v3:main` deploys). All v3 work merges into `v3`, never `main`, until John promotes it.
- **v3 at `9e0273e`** (full e2e 26/26 after one test fix; pushed, deployed, staging smoke clean): AI (personalities, grudges, truces, neutral seat) · map
  packs (Classic hash-pinned, True World) · the physical board: painted stones sized by strength with the unit icon
  standing on the stone (soldier 1–4 / rider 5–9 / cannon 10+), printed continents (shore-band tint), lanes as
  shore-to-shore crossings, the cup as turn token, turn banner, event line + ledger (ink sheet), fuller HUD (round,
  cards, held continents, personality, grudge tick), hand-off cover on by default, palette re-sampled from the
  reference (ΔE ≥ 9.8 incl. neutral) · surfaces: map picker with ink thumbnails, personality picker, truce
  Accept/Decline + Truce word, neutral grey seat, update-ready reload. Numerals 14–17 px desktop with halo (digit
  height ≥ 9 px gated). New e2e flows: table, squint, surfaces. All agent worktrees removed.
- **Rejected on the way** (don't rebuild): disc stacks (CG lit chips on a painted board; John: "the stacks don't
  look good"); free-standing figures beside a badge; a figure-less board (John: "bring the icons back").
- **Known issues**: True World on iphone-land: Ontario/NW Territory, W. Europe/Great Britain, Irkutsk/Yakutsk pieces
  overlap numerals by a few px at the 1-army floor (needs anchor spacing in maps/true-world or a renderer fallback;
  `surfaces` prints them as NOTE). The line area above the dock can stack three texts (last event, banner, offer):
  watch in play. Living-calm drift still subtle (INK F1). 2p neutral saves from before the engine 'neutral' colour
  keep an old seat colour (no migration).
- **Unverified by a human**: everything on a real phone; the sound; a real four-person game (the glance test).

## Decisions (with why)
- v2 = frames `_claude/v2-frames/3-the-fight-v2.png` + `5-ui-dock.png` only (frames 1, 2, 4 not built).
- Map = a texture pass on the existing geometry. Image gen returned the same map twice and can't match `board.json` shapes.
- Ensō slides along the gold rule to the current word; one gold that moves (Blitz ring while a commit is
  pending, else the underline); seat mark = brush dab + name, no number.
- Phone landscape:
  - Keep: the AI camera stays home.
  - Reverted (John): the tray moving between fights. It has one fixed low spot per layout.
  - Reverted (John): crowded names hiding. Names step down to 80 % and search farther out before hiding.
- Counts under the dice mid-roll on landscape phones (10–15 of 42): lead's call is smaller dice; accept the rest.
- Grain: map granulation spread cut by a third (it read as sponge speckle up close).
- Earlier decisions still bind: SOUL.md (calm is the peak, losing stings, tempo fixed but John may nudge it),
  "board clicks select, buttons commit", no kanji/seals/blossoms, Fable for taste and Opus for building.

## Next steps
1. When Phase D reports: read its report, look at `artifacts/ink2/final/` (best 6), commit, push, watch the
   Pages run (`gh run list -R jhuang124/war-table`), live smoke (Playwright, `--mute-audio`, desktop +
   `devices['iPhone 15 Pro landscape']`), then rebuild the demo in `../risk3d-playtest` at the new HEAD.
2. Clean up: remove the merged agent worktrees in `.claude/worktrees/agent-*`, but only after their
   screenshots aren't needed. Phase B's screenshots are in `…/agent-a2d90a89d3a78d4ea/artifacts/ink2/ui/`.
3. John-only:
   - Try the live site on his real iPhone. Safari is untested; the ring uses `Path2D` from an SVG string.
   - Say whether the sound itself is "weird". He heard it from a stray test browser, which is why everything is muted now.
4. Parked taste calls:
   - paper grain up close;
   - the portrait primary ring stretched to 3:1 round "Blitz";
   - crowded Europe "Southern Europe" hides when armed;
   - dissolve wisps read as streaks more than curls.
5. Known, not scheduled: 2p first mover wins ~76 % (neutral army); INK F1 living calm still subtle;
   reduced motion unverified on screen.

## Gotchas
- **Always `--mute-audio`** on headless Chromium. The score is on by default and played through John's speakers.
- Don't demo on a dev server while an agent edits (HMR reloads look like crashes). Use a frozen
  `vite preview` build in `../risk3d-playtest`.
- Worktree agents: base = HEAD at launch. If you commit something they need after launching, tell them. Symlink
  `node_modules` into a worktree; never `npm install`.
- Timing e2e flows flake under parallel load (`track` "two sentences", `mobile-sheets` "no box"). Rerun alone.
- A clone that still has `refs/remotes/origin` keeps purged blobs alive: remove the remote before gc.
- Agents can't delete files outside their brief (a safety check). Stale `artifacts/phone-landscape/ai-labels-after/` is
  gitignored; John can delete it.
- Stale Desktop TCC grant: file cards from ~/Desktop may not open; `open <file>` works. preview_start with a
  `url` works for the Browser pane.
