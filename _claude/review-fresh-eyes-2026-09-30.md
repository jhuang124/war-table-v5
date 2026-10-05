# War Table, fresh eyes · 2026-09-30

**What I looked at.** The v3 staging build at https://jhuang124.github.io/war-table-v3/ on a 1440×900 viewport, played as Vermilion against three AIs through round 2, then ended the game, started a two-human game to see the hand-off, and loaded the saved game in a 375×812 phone portrait. I compared against the v2 deploy at https://jhuang124.github.io/war-table/. High-resolution captures are in `artifacts/review-shots/` (`v3-board.png`, `v3-board-europe.png`, `v3-board-hud-*.png`, `v2-board.png`). Sound was muted, so this says nothing about the score or the dice click.

**Not covered.** Phone landscape, True World map, card trading, elimination, a natural win, more than two rounds.

---

## Verdict in one paragraph

It is a beautiful object that is hard to play from the couch. The first thirty seconds (title, New game, the deal) are the strongest thing here and the copy voice is a real asset. After that, the friend who just looked up fails the glance test on the three questions that matter: how strong is that stack, whose turn is it, and what just happened. The turn loop also has one friction bug a first game with friends will hit in minute one: a pending truce offer removes the Place button. The fix is not another pieces rebuild. It is a scale law for the stones, a "turn changes hands" moment, and a mark that losing leaves on the board.

| Axis (SOUL / UX rubric) | Today | Ship bar |
|---|---|---|
| Beauty of the resting board | 8 | 8 |
| Clarity from the couch | 5 | 9 |
| Flow of a human turn | 6 | 9 |
| Physicality (pieces feel like things) | 6 | 8 |
| Rivalry (losing stings, grudges visible) | 4 | 8 |

---

## What is good. Keep it and protect it.

- **Title and New game.** One gold, confident serif, the ensō on the rule. New game is dense but every row reads; the personality one-liners ("Hits weak neighbours and avoids fair fights") are better product writing than most shipped games.
- **The ink world.** Indigo paper, feathered ivory coasts, four muted washes that stay distinguishable (vermilion, slate, ochre, sage). The palette is coherent and the board is something you would leave on a screen. Pillar 1 holds.
- **The copy voice.** "Vermilion turns down Sage's truce." "Ochre took 5 of yours." "Ochre holds the world." The recap awards (Nemesis, Hot dice, Cursed dice) are dry and personal. No exclamation marks anywhere. This is the game's personality; do not let a future pass flatten it.
- **The hand-off cover.** Cup drawn in the seat colour, "Pass the cup to Vermilion · +4 armies waiting · 0 cards", one button. Exactly the right amount.
- **The recap.** Headline, three awards, a standings sparkline, Rematch as the primary. Solid end to a game.
- **The armed attack line.** "Venezuela → Brazil · 92% · almost sure" teaches the odds without a tutorial.
- **Phone portrait pieces.** At phone zoom the stone + figure + numeral finally reads as a piece. That is the look the desktop should have.

---

## What is weak, ranked by how much it hurts

### 1. The power map does not read at desktop or couch scale
This is the one read at rest John asked for and it is not there. In `v3-board.png` a 1-army stone and a 10-army cannon stone differ by maybe 30% in diameter. Numerals are 14–17 px at 1440 wide: fine at a laptop sixty centimetres away, gone from a couch. The soldier/rider/cannon figures are the only strength cue and they are ivory ghosts about 20 px tall. Compare `v2-board.png`: the badges read across a room but John rightly called the whole thing busy. The answer is not a midpoint. It is a steeper scale law. PLAN §1 specified area-linear 14 → 36 px; what shipped looks closer to 20 → 28. A 1 should be a small dab, a 10 a stone that visibly dominates its territory, a 20+ one that overlaps borders. Once the stone carries the read, the territory tint under it is doing less work and can calm down further.

### 2. "What just happened" is a transcript, not an announcement
The three stacked lines above the rule (two faded, one current) are a chat log in 11 pt grey. I ended my turn, looked away for seventeen seconds, and three AI turns later I had lost five territories. The only trace was one line: "Ochre took 5 of yours." The board itself said nothing. No lingering mark on the five lost territories, no colour that stays long enough to notice. Pillar 4 (losing stings) is only built for elimination today. The normal case, the one that happens every round, is silent.

### 3. AI turns are too fast to follow and too slow to skip
At Watch speed three AI turns ran about seventeen seconds with strokes and dice but no beat between events. I could not tell who took what from whom until I opened the Ledger. Two honest options: a highlight reel with a one-second hold per event ("Ochre takes Brazil", then the next), or a "While you were away" card at hand-back that lists gains and losses in seat colours. The existing line "Ochre took 5 of yours" is the seed of the second option. Make it the moment, not a line.

### 4. A truce offer hijacks the turn (bug)
With a pending offer, selecting your territory shows the +3 preview but no stepper and no `Place N` button. Clicking `Place` in the track does nothing. Nothing says "answer the truce first." I was stuck until I guessed Decline. Also: every AI at the table proposed a truce with me within two rounds (three offers). That is spam, and it devalues the one diplomatic act the game has. Offers should never take the primary slot, and the AI should offer at most once in several rounds and only with a visible reason.

### 5. A third of the desktop frame is empty ocean
On 1440×900 the map ends around 52% down the frame and the rest is paper, a dice tray in the South Atlantic, and the strip. Phone portrait has the same dead band. The board should fill the height (crop polar ocean) or the strip and ledger should move up into that band so the map can grow.

### 6. Two rendering languages are still on screen
The dice are 3D-lit red lacquer cubes with specular highlights on a matte painted board, the exact mismatch PLAN §1 banned for the stones. The cup icon is a shaded 3D object too. Either paint them (bone dice with ink pips, flat with a painted shadow) or write into SOUL that the fight is the one place where things are real. Right now it is an accident, not a choice.

### 7. HUD detail is below the legibility floor
The card count glyph is about 9 px. The personality labels under seat names are 10 px small caps and are decoration at that size. The seat ring shows territory count, but Risk players ask "who is winning" in armies. The cup beside the active seat is the right idea and it is tiny; the turn token should be the largest thing in the HUD, not the smallest.

### 8. Copy and flow nits inside a human turn
- "Vermilion took Brazil from Venezuela · 4 vs 1 · lost 0" reads as if Venezuela was the owner. Say "took Brazil from Ochre" and leave the origin to the arrow.
- After a win the game moved one army and left three behind with no choice offered. If that is the min-move house rule, fine, but a Risk player expects to pick.
- "All placed · Attack is next" still needs a click on Attack. Consider auto-advancing when placing is done and nothing else is pending.
- The first AI took a full turn before I ever saw the board. A one-beat "Sage goes first" would orient a new table.

### 9. The two deploys share one save
Both sites live on the same origin, so v2's title offered "Continue · Round 2 · Vermilion vs 3 AI" for my v3 game. Harmless until a friend opens the wrong URL mid-game. Namespace the save key by build, or promote v3 and retire the v2 URL.

---

## How I would iterate: three passes, not thirty tweaks

**Pass 1 · Make the board announce.** Gate: the glance test with two friends on the TV.
1. Stone scale law: roughly 10 px for 1, 22 for 5, 32 for 10, 44 for 20+, overlap of borders allowed, numeral never under 18 px at 1440, figure scales with the stone.
2. "Turn changes hands" as a moment: the cup slides, a banner "Ochre's turn · round 3" holds about 1.5 s, the transcript clears. When a human gets the cup back after AI turns, a "While you were away" card lists losses and gains in seat colours and dismisses on tap.
3. Losing leaves a mark: a territory taken from a human keeps a thin ring in the loser's colour until that loser's next turn ends. That is the grudge made visible, and it costs nothing at rest.
4. Truce offers leave the primary slot and the AI offers rarely.

**Pass 2 · Fill the frame.** Board scaled to the viewport height, strip and ledger into the southern band, dice tray under the fight rather than in the Atlantic. Phone portrait already does most of this; desktop should match it.

**Pass 3 · One medium, finished.** Paint the dice and the cup. Then ask whether the three-line transcript is needed at all once the board announces. My bet is it shrinks to one line.

**What I would not do.** Rebuild the pieces a fourth time. Add HUD rows. Add onboarding. Change the copy voice.

---

## The glance test I would run before Pass 2

Four questions, asked of the non-acting player at random moments, answered in one second from the couch:
1. Whose turn is it?
2. Who holds Asia?
3. Where is the biggest army on the board?
4. What just happened?

Every miss is a bug. Today I would expect misses on 3 and 4 nearly every time, and on 1 whenever the cup is not noticed.
