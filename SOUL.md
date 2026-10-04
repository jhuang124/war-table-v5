# Soul: War Table

## Intent
A world-conquest board game in the classic Risk mold, for John and up to three friends playing locally on one
laptop, TV or phone: "ready for me to play with my friends." It should feel like sitting inside a quiet
ink painting that the table fights over. The calm is the point, and the fights are punctuation. The board
stays easy to read, so the room supplies the noise.
Built for the friend who just looked up from their phone: intermittent attention, couch distance. The host
explains the rules; the board explains the state. (Added 2026-10-03, from the v4 sitting.)

## The moment
Round 6, on the couch. Indigo paper fills the screen, silver ink coastlines faintly breathing, mist drifting
over the ocean, and a soft score somewhere underneath. Sam drags from Ural toward Siberia; a gold brush stroke
follows his finger. Bone dice click into the tray, and a breath later John's figure dissolves into ink smoke.
Sam's color soaks across the border. John says "you'll pay for that". Then the board settles back into
its slow drift, and nobody had to ask what happened. The cup slides to Priya, the score leans a shade warmer,
and Priya knows it is her turn before anyone says so.
**And after:** someone demands a rematch because of Siberia.

## Pillars
1. **The calm is the experience, not a pause between action.** John's words: "the calm itself" is the peak. Test:
   an idle board is something you'd leave on screen; it drifts and breathes like clouds, never static, never busy.
2. **Readable from the couch, not decorated.** "Game UI benefits from a more minimalist aesthetic given how much
   information is shown." Test: a non-acting player answers in one second from the couch: whose turn, who holds
   Asia, where the biggest army is, what just happened. Nothing on screen that isn't information or the one
   thing happening now. (Rewritten 2026-10-03; the four questions are the glance test.)
3. **Ink linework as structure, not Japan-shop props, and no objects as UI.** The linework must be honored ("doesn't honor the
   japanese ink linework style"), but the prop-heavy sumi-e board was "a bit of a mess". Test: brush strokes
   are the board's own lines; no kanji, seals, blossoms, Fuji, or proverbs anywhere.
4. **Losing stings; the rivalry is real, not polite.** Test: when you lose a territory or get knocked out, you
   feel it and you know exactly who did it, and the game keeps that grudge visible without shouting.
5. **Change the feel of the tempo, not the tempo.** "Don't substantially change the tempo of the game, just
   the feel of that tempo." Test: a turn and an AI turn take about as long as before; nothing new makes you wait.

## Touchstones
- **`_claude/moodboard/chosen-silver-ink-board.png`**: take the indigo paper, the feathered ivory coasts, the
  muted washes, and one gold; leave the image model's invented taglines and details.
- **`_claude/moodboard/units-place.png`**: take the pale ivory brush figures on an owner-colored blot; leave
  the dark silhouettes of `units-board.png`.
- **John's gold-rule reference (`john-ref-1-gold-rule.png`)**: take the hairline gold rule with its ring,
  the UI's signature.
- **Komorebi**: take how simple and beautiful it is; leave its UI patterns ("definitely not great for a game").
- **John's portrait-site reference (`john-ref-2-portrait-site.webp`)**: take the elegant serif and the soft
  ink-and-wash warmth; leave the light theme.
- **Wingspan's evening** (the digital edition, chosen 2026-10-03 as the touchstone for *cozy*): take one
  continuous soundscape with the effects living inside it, warm light, nothing abrupt; leave its light palette
  and its card-heavy UI.

## Feel
- Look: deep indigo paper, silver-ivory ink, muted pigment washes, a single gold for what's happening now.
- Motion: beautiful, sleek, and coherent. Things are drawn in and dry out; slow cloud-like drift at rest,
  quick sure strokes in action.
- Hands: tapping the board only picks; a button or a finished brush stroke commits. Nothing new makes you
  wait, and a tap during motion finishes it.
- Sound: a soft ambient score always underneath; paper, brush, wood and bone when something happens. One room:
  the score is the air, every effect is a thing happening in that air, in its key and its hall. Nothing is a
  notification. (2026-10-03)
- Cozy at rest, sharp in the moment (2026-10-03): the room is warm (paper, a candle gold, a warm vignette at the
  margins, a score in warm colours, slow drift you can see). The fights are the one place the room goes cold for
  a breath. Cozy never means polite: see Pillar 4.
- Decide, don't ask (2026-10-04): the game picks sensible defaults and never presents a window, token or prompt
  whose only purpose is to be dismissed or configured. Anything on screen that is not information or the one
  thing happening now goes. Whose turn, what happened and what you may do are carried by colour, weight and the
  one line, never by a screen.
- No objects as UI (2026-10-04): the board is ink and the HUD is type and the gold rule. A rendered object that
  stands in for a state (a cup for "whose turn") reads as a prop however well it is painted. Of the table cues,
  three survive as information: stone size, printed continents, visible water. The cup does not.
- Physicality (2026-09-30): everything on the board is a painted thing; a piece is a thing because it has an
  edge, a painted shadow and it moves. Never lit, never 3D. Armies are painted stones sized by strength with the
  unit figure standing on them; the figures never leave the board again.
- Words: plain English with real names and numbers; no poetry, no proverbs, no exclamation marks.

## Open
Three.js, the current renderer and HUD structure, the dice tray, how unit figures are made (drawn or
generated), the camera angle, and exact timings are how this build works, not what War Table is. The rules,
the Turn Track, and "board clicks select, buttons commit" are in docs/ROUND2.md and still bind.

## Misreads
- 2026-09-27 · Opus fleet: built a dark walnut war room with a brass HUD, panels, hints and chips. Missed
  "readable, not decorated". Meant "the board is the UI"; John called it "overdone and confusing".
- 2026-09-27 · simplify pass: armies as flat numbered discs. Missed the board-game read. Meant "stylize units
  with icons like a real game board".
- 2026-09-28 · sumi-e mood image: cherry blossom, Fuji, a sun, ships and fake seals. Missed "linework, not props".
  Meant restraint: "not cohesive and aesthetically a bit of a mess".
- 2026-09-28 · Claude and Fable plans: both proposed pure stillness; John wants slow, cloud-like motion. Both
  kept a ghost of the old owner's color, which muddies reading. Claude's generated haiku wasn't wanted. Both
  made elimination purely gentle; John wants losing to sting. Both had music off; John wants a soft score.
- 2026-09-30 · v3 disc stacks: lacquered chips with specular light and a tilted camera on a matte painted board.
  Missed "one medium". Meant: painted things, one light, flat board ("the stacks don't look good").
- 2026-09-30 · v3 first stones: figures removed to make the stone the mark. Missed the touchstone (ivory figure
  on an owner-coloured blot). John: "Bring the icons back."
- 2026-09-30 · v3 at rest: 42 equal-weight marks, three light models, six edge weights, a grey transcript. Read as
  "fundamentally very busy and ugly" and "a standard video game with abstracted UI". Meant: one hand, three
  layers of contrast, the board announces (v4).
- 2026-10-03 · v4/v5 ceremony: the hand-off cover, the cup, the truce offer protocol and the personality picker
  asked the player to operate the software ("don't need a whole window", "cup still feels in the wrong style",
  "truces don't work intuitively", "just randomize"). Meant: decide, don't ask; no objects as UI.

## Before you plan, delegate, or call it done
1. Hold the plan or build against the moment and each pillar: serves it,
   ignores it, or works against it. Cite the plan line or the screen.
2. Name the five inherited choices it leans on most: things kept because the
   code already does them. Would a clean-room build from this file alone
   arrive there? If yes, cite the line. If not, the choice is open.
3. A (guess) binds nobody. If the plan turns on one, ask John first.
4. Name the Misread the plan comes closest to repeating.
5. Comparing several plans or builds: rank them this way first; technical
   merit breaks ties.
6. Delegating: paste Intent, the moment, and the pillars into the brief.
