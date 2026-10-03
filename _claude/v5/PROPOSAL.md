# War Table v5 · a place, a fight, a story (proposal, 2026-10-03)

John's question: "What does v5 need? What's still missing against prod polished fun interactive apps? Is it
polish? A different visual language? Better experience, more visual interest?" And then: build it, separately,
with an Opus fleet. This document answers the question, then becomes the brief.

## 1. The honest read of v4

I played the live v4 for two rounds as a user before writing this. What v4 is: a calm, legible, coherent table.
The power map reads, bot turns are followable, the receipt tells you what you missed, the HUD is one hand, the
sound is one room. What v4 is not yet: a game anyone *wants* to come back to. Three things are missing, and none
of them is polish in the sense of "more finish on what exists," and none of them is a different visual language.

**It is not the language.** The ink-on-indigo language is the most distinctive thing about War Table. Every
reference John chose and every correction he made points at it. Swapping it would throw away the only asset that
makes this not look like Risk: Global Domination. The gap is depth and drama *inside* the language.

**It is not polish either.** Polish is finishing what is there. The things below are things that are not there.

### What is missing, in order of how much it costs us

1. **The fight is not a moment.** Risk's whole drama is the dice, and v4's roll is a few painted squares that land
   in about a second with the header colliding with the ring. No anticipation, no verdict beat you can feel, no
   aftermath. Balatro's lesson is that the climax of the loop gets the sensory budget ("the scoring panel erupts");
   Swink's is that feel comes from anticipation, action, and follow-through, with the reaction proportional to
   the stakes. Our fight has action only.
2. **The board is a picture, not a place.** Nothing about it changes over a game. No depth, no light that moves
   except a vignette breath, no sense of where the war is. Production boards (Hearthstone's is the canonical case)
   are "alive" because they respond and because they have idle life. Ours drifts mist and that is all.
3. **The game has no memory.** SOUL's moment ends with "someone demands a rematch because of Siberia." Nothing
   in v4 remembers Siberia. The recap has three awards and a sparkline. There is no story of the war, no named
   turning point, no grudge that lasts past one turn, no reason to say "again."
4. **The opponents are rules, not characters.** Three personalities exist as behaviour and one-line descriptions.
   They never speak, react, or show intent. Root's digital edition is remembered for how its factions *feel*
   ("the Woodland Alliance has a little mouse with a megaphone that gets laid out").
5. **Your own turn has no ritual.** Seven armies appear as a number. A continent captured is a line. A card trade
   is a sheet. Each of these is a small ceremony in the physical game and a non-event here.
6. **No details that reward attention.** Hearthstone's board "clickables" exist to give the waiting player
   something to touch and to prove the board is alive. We have none, and we can have them inside SOUL (no props:
   water, labels, the cup, the ensō, the stones themselves).
7. **One way to play.** Two maps, three lengths. Risk's own best variant, secret missions, gives every player a
   private goal and the AIs a reason to act the way they do. It is the cheapest large increase in replay value
   available to us.

### What is fine and should not be touched
The language, the type, the one line, the receipt, the readable bot beats, the HUD structure, the engine, the
tests. v5 adds to v4; it does not re-paint it.

## 2. What the research says (sources at the end)

- Swink's game feel: "real-time control of virtual objects… with interactions emphasised by polish"; the
  animation principles that matter are anticipation and follow-through. Our fight has neither.
- "Juice it or lose it" (Jonasson and Purho): a functional prototype comes alive when every action gets a
  visible and audible reaction. The caveat for us: juice in the ink medium is brush, flood, paper and bone, never
  screen shake and particles.
- Hearthstone's boards: interactive elements "produce fun animations and sound effects when clicked" and act "as a
  distraction in the event that the game is going slowly," for the player during the opponent's turn. That is
  exactly our friend on the couch.
- Balatro: the climax gets the sensory budget and the music is a bed that never tires. v4 did the bed; v5 does
  the climax.
- Root: faction character through small specific animations, not more animation.
- Wingspan: ambient first, effects inside it (done in v4). Its end-of-game screen is still just a scoreboard,
  which is the gap every digital board game leaves open and the one we can take.

## 3. SOUL check before anything is built

- **The moment:** v5 serves it directly. "Bone dice click into the tray, and a breath later John's figure
  dissolves into ink smoke" is the fight workstream. "Someone demands a rematch because of Siberia" is the memory
  workstream. Nothing here works against the moment.
- **Pillar 1 (calm is the experience):** the risk. Everything in §4 that happens at rest is slow, low-contrast
  and reversible on input. The fight is sharp because it is punctuation; it lasts seconds and the room settles.
  SOUL already says "cozy at rest, sharp in the moment."
- **Pillar 3 (no props):** clickables are board-native only: water, continent labels, the cup, the ensō, stones.
  No ships, no animals, no seals, no flourishes.
- **Pillar 5 (tempo):** no new waits. Every ceremony below fits inside a beat that already exists or is
  skippable by a tap. Measured in the timing lane.
- **Misread nearest:** 2026-09-27 ("overdone and confusing"). Guard: each workstream has a "what it is not" line,
  and the lead's taste gate sends back anything that reads as decoration.
- **Inherited choices questioned:** the fight as "dice in a ring" (kept, but made a moment); the recap as a
  scoreboard (changed); AIs as silent (changed); the board as static paper (changed within limits).

## 4. The v5 workstreams

### A · The fight is a moment
Anticipation, action, verdict, aftermath, in the ink medium, inside the existing budgets (single roll ≤ 1.25 s
including the verdict silence, blitz ≤ 3 s).
- **Anticipation (≈ 250 ms):** the cup tips at the attacker's seat; the camera leans toward the fight (eased,
  at most 0.15 board widths, never a cut); the paper around the fight cools a shade (the vignette tightens) for
  the fight's duration: "the room goes cold for a breath."
- **Action:** dice pour from the cup along an arc into the ring, tumble as painted faces, and land one at a time
  (60–90 ms apart) with a bone click each, in the shared hall, panned to the side they belong to. The ring sits
  beside the fight and never under a label, a stone or the header (v4 bug).
- **Verdict (the existing 250 ms hush, then):** matched pairs connect with a gold hairline that draws in 120 ms;
  the losing die of each pair takes an ink splash and dims; the loser's stone recoils (tier 1). On conquest the
  flood soaks across the border from the attacker's side with the dry-brush snap; the defender's figure dissolves
  to ink smoke (the moment's own words). On a repulse, the attacker's stroke dries back toward home.
- **Aftermath:** the camera returns, the paper warms back, the sentence completes ("…and takes it").
- **Blitz:** a drum of bone clicks that accelerates, dice stacking their verdicts, then one final roll played in
  full. Never over 3 s.
- **Header:** rides on the ring's rim, above or below, never over the board's labels; the two names in their
  pigments, the counts ticking down as dice land.
- **What it is not:** screen shake, particles, slow motion, speed lines, exclamation marks.
- **Acceptance:** John and a friend each roll five fights and say what they felt. The ink flow's budgets hold.

### B · A place, not a picture
Depth, light and the shape of the war, all slow, all at rest.
- **Two mist layers** with parallax on the camera lean, so the lean reads as depth.
- **The evening deepens:** the paper's warmth and the vignette drift over a game from dusk (round 1) toward night
  (round 12+): a few points of lightness, a slower score. The table gets later. Reversible by nothing; it is the
  game's clock.
- **Front lines:** a border between two different owners draws at medium weight in both pigments (a split
  stroke) so the shape of the war reads from the couch; borders inside one owner's land stay hairlines. This is
  the biggest single gain in "where is the war" and it is pure information.
- **Water that remembers:** a sea lane a fight just crossed glints once; a lane you have used this game is a
  shade brighter than one you have not.
- **Idle:** after 60 s the camera drifts a few pixels (parallax) and the mist thickens (exists); any input
  returns it over 2 s.
- **What it is not:** weather, day/night cycles with a sun, animated water, ships.
- **Acceptance:** the drift and front-line measures in the e2e ink flow; the squint guard still passes.

### C · The war in ink (memory and story)
- **Replay at the end:** on victory, before the scoreboard, the board replays the game as a 15–20 s time-lapse:
  owners re-soak round by round, the round numeral re-inks, the score plays underneath; one sentence per round
  from the ledger writes and dries. Tap to skip. Then the recap.
- **Turning points:** the recap names the game's three moments in plain sentences, derived from the ledger:
  "Round 6: Siberia changed hands three times." "Round 9: Theo was knocked out by Priya." "Round 4: John took
  Africa and held it to the end."
- **Grudges that last:** the receipt's "took from you" lines accumulate per seat across the game; the seat ring
  shows a small tick per territory that seat has taken from you (the grudge made visible, SOUL Pillar 4). Taking
  one back clears a tick.
- **Rematch pull:** "Rematch" keeps the seats and gives the loser first move; the title's Continue thumbnail
  shows the last board (exists).
- **What it is not:** achievements, XP, streak counters, confetti.
- **Acceptance:** after one full game, a friend asked "what happened in that game?" answers with one of the
  named moments.

### D · Presence of the opponents
- **One sentence at the right time, in their voice.** Each personality gets a small set of plain lines (no
  exclamation marks, no quotes around them, their name first): when attacked by a human ("Sage remembers that"),
  when they take a continent ("Slate holds Europe · it will keep it"), when a truce is broken against them, when
  they are knocked out ("Ochre is out · it blames Vermilion"). Shown as the one line, in the seat's light tint,
  never more than one per AI turn.
- **Intent you can see:** before an AI's first attack, its cup rattles once (bone, 300 ms) and its seat name
  brightens: the anticipation beat the AI turn lacks.
- **Grudge target in the ring:** exists as a tick; make it legible (the target's emblem beside the tick).
- **What it is not:** portraits, avatars, speech bubbles, taunts.
- **Acceptance:** John can name which AI is which from their lines alone after one game.

### E · The turn ritual
- **Reinforcements arrive:** "Vermilion · 7 armies" writes, then the breakdown dries in underneath for a second
  ("3 territories · Asia +4"); the seven arrive as a small pour of stones from the cup into a holding dab beside
  the seat mark in the strip, and the dab empties as you place. The number becomes a thing you spend.
- **Continent moment:** when you complete a continent, the outline re-inks in your pigment (exists), the bowl
  rings in key (exists), and "+7 next turn" writes on the label for a breath (new).
- **Cards:** the hand fans in as a paper sheet (exists); a complete set brightens; a trade pours its stones into
  the holding dab with cardTrade in key (exists), so trading and placing are one gesture.
- **Hover odds on desktop:** hovering an enemy neighbour while a source is selected writes the odds line before
  you click, so the decision is made on the board.
- **What it is not:** tutorials, tooltips, coach marks.
- **Acceptance:** a first-time friend places their first armies without the host explaining where the number
  came from.

### F · Details that reward attention (board-native clickables)
Each: trigger → body + sound + word, tier 0, never required.
1. Tap open water → an ink ripple spreads and dries; a paper tick.
2. Tap a continent label → its outline brightens for a second; the bonus writes "+5" beside it.
3. Tap the cup → it rattles (bone) and the current seat's name writes.
4. Tap the ensō → the round writes large for a second; a second tap opens the Ledger.
5. Long-press a stone → its line: "Ural · 19 · held since round 3 · taken from Sage."
6. Tap a sea lane → it glints end to end and the two shores write their names.
7. Hover a seat ring (desktop) → that seat's territories lift a shade; the rest rest.
- **What it is not:** anything that is not already on the board.
- **Acceptance:** a friend finds two of these unprompted in ten minutes.

### G · Missions (replay variety)
- Classic secret missions as a house rule (off by default): conquer two named continents; conquer 18 territories
  with at least two armies each; conquer 24 territories; destroy a named colour (or 24 territories if it is you
  or already out). One mission per seat, dealt at setup, shown on the hand-off cover and on long-press of your
  own seat mark; the AIs pursue theirs (the personalities bias how).
- Completion: the game ends at the moment the mission is met on your turn, with the mission's sentence as the
  headline ("Vermilion holds Asia and Africa").
- **What it is not:** capitals, fog of war, new maps (later).
- **Acceptance:** engine tests for every mission; a full AI-vs-AI soak ends by mission at least a third of the
  time at Evening length.

## 5. Order and fleet

Build on `v5` (branched from `v4`), staging at a new repo so v4 stays as is. Six Opus 5.5 builders in parallel
worktrees, one per file-ownership area, the lead integrating:

| Agent | Workstream | Owns |
|---|---|---|
| fight | A | src/render/dice.ts, fx.ts, anim.ts, camera lean API; fight parts of index.ts; src/ui/hud/battle.ts |
| place | B | src/render/ink*.ts, scene.ts, tiles.ts, lanes.ts, continents.ts, textures; paper/camera parts of index.ts |
| voice | C + D + E (controller side) | src/game/* (controller, recap, copy, strip), src/engine/ai/* lines |
| hud | C + E + F (UI side) | src/ui/* (replay screen, holding dab, clickables' words, grudge ticks) |
| missions | G | src/engine/* (missions.ts, win check, events), src/ui/screens/newgame.ts mission toggle |
| audio | A + D + F cues | src/audio/* (dice stagger, rattle, ripple, splash, glint) |

Contracts the lead writes first (additive): `BoardView.leanTo/leanBack`, `BoardHighlights.frontLines?`,
`PlayEventOptions.stagger?`, `GameVM.replay?`, `GameVM.holding?`, `SeatChipVM.grudgeTicks?`, `UiIntent` for the
clickables and the replay skip, engine `missions.ts` stub (`missionText`, `missionComplete`), audio `V5Cue`.

Gates: the lead's taste pass on each branch (the fight gets a video, not a screenshot), the full e2e suite, and
John's two tests: five fights felt, and "what happened in that game?"

## 6. What v5 is not
A new palette. A new HUD. A new map. Online. Onboarding. A different game.

## Sources
- Steve Swink, game feel (summary): https://www.gamedeveloper.com/design/principles-of-virtual-sensation and
  https://Www.wikipedia.org/wiki/Game_feel ("Juice it or lose it", Jonasson and Purho, Nordic Game Jam 2012)
- Hearthstone board clickables: https://outof.games/hearthstone/341-hearthstone-hypothesis-why-do-the-game-board-interactions-exist and https://hearthstone.wiki.gg/wiki/Board
- Balatro's sensory design: https://mechanicsofmagic.com/2025/05/22/critical-play-games-of-chance-addiction-jack-ryan/
- Root digital's faction animation: https://www.boardgamequest.com/root-digital-board-game-review/
- Wingspan digital's soundscape: https://www.pcgamer.com/wingspan-review/
- Risk: Global Domination (SMG Studio), the market comparison: https://store.steampowered.com/app/1128810/RISK_Global_Domination/
