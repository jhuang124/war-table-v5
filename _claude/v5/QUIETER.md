# War Table v5.1 · decide, don't ask (proposal, 2026-10-04)

John's feedback on v5, in his words: "Pass the cup is not really needed, just show something styled correctly
that says whose turn it is, don't need a whole window." "Cup still feels like it's in the wrong style." "Truce
feature doesn't work intuitively; truces need to be rethought as a whole." "New game set-up looks a bit overly
complex, just randomize, I don't want to choose Warlord or Opportunist." And: "figure out the intention of this
feedback and propose across-the-board improvements in this spirit."

## 1. The intention under the four notes

The four notes are one note. Each names a place where the player has to **operate the software instead of
playing the game**: a window to dismiss (the cover), an object to interpret (the cup), a protocol to run (offer,
wait, accept or decline), a form to fill (the setup). v4 and v5 added ceremony in the name of physicality and
presence, and some of it crossed from "a thing on the table" into "a thing the app wants from you."

Two principles fall out, and they should go into SOUL:

- **Decide, don't ask.** The game picks sensible defaults and never presents a window, token or prompt whose only
  purpose is to be dismissed or configured. Anything that is not information or the one thing happening now
  goes. (This is Pillar 2's test, applied to interaction rather than to marks.)
- **One language, no objects as UI.** The board is ink; the HUD is type and the gold rule. A rendered object
  standing in for a UI state (the cup as "whose turn") will always read as a prop, however well it is painted.
  State is shown by colour, weight and the one line. (This sharpens Pillar 3 and, honestly, reverses the
  2026-09-30 call to "bring back all four table cues." Three survive as *information*: stone size, printed
  continents, visible water. The cup was the one that was an object standing in for a sentence.)

A third thing the truce note says: **mechanics that need explaining are the wrong mechanics.** Nobody at the
table asked for a treaty protocol. What they want from AI opponents is to *understand* them ("why is Sage on me?")
and to *influence* them a little ("can I get Sage off my back?"). That is attitude, not paperwork.

## 2. What the research says (sources at the end)

- **Civilization's diplomacy** is the clearest lesson. Civ IV and V made the AI's attitude *visible with
  reasons* (FRIENDLY / NEUTRAL / GUARDED / HOSTILE, and a tooltip listing "things making this leader happy or
  upset"). Civ VI went further: each leader has visible **agendas** that explain their behaviour, because hidden
  personality values "were never expressed to the player except through context, experience, or datamining."
  Our personalities are agendas already; what is missing is making the attitude visible and the reason plain.
- **Risk: Global Domination's alliance mode** is, by its own community's account, mostly a communication channel
  for humans; the AI does not negotiate. Formal offer/accept diplomacy with bots is not a solved pattern anyone
  points to as fun.
- **Setup friction:** the standard advice is a quick path with presets and randomisation first, and advanced
  customisation behind a fold for people who come back for it. "Most of the setup can be done automatically."
- **Pass-and-play hand-off:** the only real job of a hand-off screen is hiding private information before the
  device changes hands. If there is nothing private to hide, there is no reason for a screen.

## 3. The changes

### A · Whose turn: a line, not a window
- **Delete the hand-off cover.** The turn passes with: the one line writing "Sam's turn · 7 armies" in Sam's
  pigment and holding about 1.5 s, Sam's seat ring filling, Sam's name set in pigment, the score's chord
  turning (exists). On 2+ humans the line is the hand-off; nobody taps anything.
- **Private information without a screen.** Cards are only ever shown on demand (the Cards word opens the
  sheet); with 2+ humans the sheet closes itself when the turn passes. A secret mission (if the house rule is on)
  is shown only on a long-press of your own seat mark (exists). The "Hide cards between turns" setting goes.
- **What it is not:** a smaller cover, a toast, a modal of any size.

### B · The cup goes
- Remove the cup object, its slide, tip and pour, the cup tap, and the rattle (a cup sound without a cup).
- Whose turn is the filled seat ring in the seat's pigment and the name in pigment. Nothing else. The ring is
  already the largest HUD mark after the cup; it becomes the largest.
- Keep the *sound* of the turn passing (the wood set-down and the chord change): a sound does not need an object.
- Dice pour in from the attacker's side of the ring, not "from the cup": the fight builder already did this.
- **Hand-off text:** none; see A.

### C · Truces become standing
Replace offers, Accept / Decline, the `Truce` word and the pending-offer line with **standing**: how each AI
seat feels about each other seat, visible, with its reason, and acted on by the AI without any protocol.

- **Four standings:** ally · even · wary · hostile. Computed every turn from recent attacks received (weighted by
  how recent and how much), shared borders, who is leading, and the personality (Turtle forgives, Warlord does
  not). Deterministic from `state` (pure, testable).
- **Visible, with the reason.** Beside each AI's seat ring, one small ink mark for its standing toward the current
  human (a dot that fills from hollow to solid as it hardens; hostile is the seat's deep tone). Hover or long-press
  writes the reason as one plain sentence in the one line: "Sage is wary of you · you took Ural last round" ·
  "Slate is even with you · you share no border" · "Ochre is hostile · you broke the peace in round 4."
- **The AI acts on it.** An ally does not attack you and prefers your attacker; even picks the weakest target;
  wary prefers you when you are weak; hostile pursues you. (The brain already weights targets; standing becomes
  the weight.)
- **One gesture, no protocol.** On your turn, tap an AI's seat ring and the line offers "Ask Sage for peace" as
  a single word to confirm. Sage answers at once, in one sentence, from its standing: "Sage agrees · three
  rounds" or "Sage refuses · you took Ural." Agreed peace pins standing to ally for three rounds. Breaking it
  drops you to hostile for the rest of the game (Pillar 4: the sting). You may ask each seat once per three rounds.
- **AI-to-AI understandings** stay in the engine and surface only as a line when they form or break ("Sage and
  Ochre have an understanding" · "Sage turned on Ochre"), and as a hairline tie between their rings while they
  hold. That is what players actually feel at a Risk table ("they're ganging up on me") and it costs no UI.
- **What it is not:** offers that wait, Accept / Decline, timers, treaty text, a diplomacy screen.

### D · New game: three decisions
- **Who is playing.** Seat names with a Human / AI toggle; colours are assigned (tap the swatch to change if you
  care). Default: the last game's table, or one human and three AI on first run.
- **How long.** Quick · Evening · Full (exists).
- **Start.**
- **Everything else is decided for you and folded away** under one "More" word: map (Classic by default), AI
  difficulty (Normal), personalities (random and hidden: discovering that Sage is a Warlord from how it plays and
  what it says is part of the game), setup (quick deal), house rules (neutral seat, missions). The summary line at
  the bottom stays ("Territories dealt at random · first to 30 territories wins").
- **What it is not:** a wizard, a tutorial, a second screen.

### E · The same spirit, across the board
Each of these removes a decision or a dismissal the game can make itself:
1. **Place → Attack advances by itself** when the last army is placed (End turn stays explicit).
2. **Occupy moves all but one by default**; the stepper appears only if you touch the count.
3. **Settings** show four things (Sound, Score, AI speed, Text size); the rest folds under "More."
4. **The `Truce` word** leaves the Attack strip (C).
5. **The breakdown under the turn line** ("14 territories +4 · Asia +7") stays: it is information once, and it
   dries on its own. The holding dab stays for the same reason.
6. **"Sage goes first"** stays (information). The receipt is already gone.
7. **Confirmations** stay only where the action is destructive (End game now, Restart).
8. **Clickables** stay: none of them is ever required.

### F · SOUL amendments to make with John
- Feel: "Decide, don't ask" as written in §1.
- Pillar 3 sharpened: "no props, and no objects as UI; state is colour, weight and the one line."
- Touchstone note: strike "the dice cup = the turn" from the table cues; keep stones, printed continents, water.
- Misreads: 2026-10-03 · v4/v5 ceremony: "the hand-off cover, the cup, the truce protocol and the personality
  picker asked the player to operate the software." Meant: decide, don't ask.

## 4. Order
1. A + B + D + E1–E4 are small removals and defaults: one builder, one day.
2. C is the real design work: engine standing (pure), brain weights, the seat mark and the one gesture; one engine
   builder and one HUD/controller builder, with the lead writing the standing table first.
3. Gate: John plays one game without reading anything and is never asked a question he did not want to answer.

## Sources
- Civilization AI attitude visibility and reasons: https://forums.civfanatics.com/threads/dealing-with-diplomacy.650899 and https://forums.civfanatics.com/threads/ai-attitude-reference-visuals.244799
- Civilization VI agendas as visible personality: https://www.fandom.com/articles/1281-why-civ-6-leader-agendas-mean-youll-never-play-the
- Risk: Global Domination alliance mode as communication: https://steamcommunity.com/app/1128810/discussions/0/596260689262196998
- Setup friction, quick vs advanced, randomise: https://itch.io/post/16955666 and https://bugnet.io/blog/how-to-make-onboarding-smooth-for-new-players
- Pass-and-play privacy as the hand-off's only job: https://wordimpostor.com/pass-and-play
