# War Table v4 · the cared-for table (plan, 2026-10-03)

Builds on v3 (`v3` branch, staging at https://jhuang124.github.io/war-table-v3/). Nothing here replaces v3's
board; it finishes it. Companion: `_claude/review-fresh-eyes-2026-09-30.md` (the play review this plan absorbs).

## 0. What John asked for, in his words

- The review's findings, all of them.
- "v3 also shows some sound design issues where bots' turns don't provide enough audio and other cues, so it's
  disorienting when it's not your turn to follow the action."
- "I'd like the vibe to be a bit cozier, the sonic experience to be a bit more smooth and integrated."
- "There is an intentionality that feels missing from this game. It's an ineffable touch to show that someone
  cared about the experience. I want to test if you can add that."

The last line is the brief. The others are how we get there.

## 1. What "someone cared" is made of

The best digital board games are not better-looking; they are more *consistent*. I looked at how reviewers describe
Wingspan, Root, Dorfromantik and Balatro, and the praise is always the same handful of properties. These are the
properties v4 is held to. Each one is checkable.

1. **One soundscape, not cues over silence.** Wingspan is remembered for "a lovely ambient soundscape of birdsong,
   nature sounds, and classical guitar": the room is always sounding, and effects live inside it. v3 has a score
   and seventeen separate effects that sit on top of it. v4 puts them in the same room (§4).
2. **The most-repeated action is the most satisfying one.** Toukana's rule for Dorfromantik: "the interaction
   players do most must feel as satisfying as possible." Here that is placing an army and a die landing. Everything
   else is tuned relative to those two.
3. **Exactly one sharp sound.** Dorfromantik lets only the perfect-tile chime cut through. Ours is the bowl for a
   continent taken (and the elimination bowl, which is its dark twin). Nothing else gets a hard onset.
4. **Every event has a body.** Root's fights "erupt in little clouds of dust", structures burn, a mouse with a
   megaphone gets laid out. Motion, sound and the sentence land on the same frame. v3 often has the sentence alone.
5. **The opponent's turn is legible without reading.** Root's one consistent criticism was "the quickness of the AI
   turns"; the Board Game Arena tracker has an open bug asking for "better identification for turns that happen on
   other players' turns." This is the exact complaint John has (§3).
6. **Idle has life.** Wingspan's birds call when you click them; the board is never a screenshot. v3's drift was
   measured sub-perceptual on 2026-09-28 and still is.
7. **Nothing cuts.** Transitions are drawn in and dried out; sounds have attacks; the camera leans, it never jumps.
8. **One motion grammar.** One easing family, one duration ladder, one origin (things come from the cup and the
   seat). The eye learns it in a minute and stops noticing it.
9. **Details that reward attention.** Click a bird, hear its call. Our equivalents are listed in §6. None is
   required to play; each is a small proof that someone was here.
10. **Nothing software-shaped.** No toasts, no grey log, no dialog boxes. Paper, ink, cup, stone.

## 2. SOUL amendments to make with John (not made here)

SOUL.md outranks this plan, and this plan leans on four things SOUL does not yet say. These are proposed wording
for a sitting with John; until he agrees they bind nobody.

- **Audience line (Intent):** "Built for the friend who just looked up from their phone: intermittent attention,
  couch distance. The host explains the rules; the board explains the state."
- **Pillar 2, rewritten:** "Readable from the couch, not decorated. Test: a non-acting player answers in one second:
  whose turn, who holds Asia, where the biggest army is, what just happened."
- **New Feel line, cozy:** "Cozy at rest, sharp in the moment. The room is warm (paper, lamp-light gold, a score
  in warm colours, slow drift you can see). The fights are the one place the room goes cold for a breath. Cozy
  never means polite: see Pillar 4." *Cozy is a new word in this project. It needs a touchstone John picks (§8 Q1).*
- **New Feel line, sound:** "One room. The score is the air; every effect is a thing happening in that air, in its
  key and its hall. Nothing is a notification."
- **The moment, extended:** add "the cup slides to Sam, the score leans warmer, and Sam knows it is his turn before
  anyone says so."
- **Physicality (already decided 2026-09-30, not yet in SOUL):** "Everything on the board is a painted thing; a piece
  is a thing because it has an edge, a shadow and it moves. Never lit, never 3D."

**Misread guard.** The Misread this plan is closest to repeating is 2026-09-28: "both proposed pure stillness… both
made elimination purely gentle." *Cozy* is a straight road back there. Every cozy change below has a sting it must
not soften, named next to it.

## 3. Workstream A · the spectator turn

The problem, observed: three AI turns ran in seventeen seconds. Strokes drew, dice landed (quietly, at half volume
because no human was involved), fights past six seconds snapped, and the only durable trace was one grey line.
John's words: "disorienting when it's not your turn."

**Principle.** When it is not your turn, the game *narrates*: one beat per event, with body, sound and sentence
together, at a pace a person can follow, and it ends with a receipt.

### A1. A beat grammar for AI events
Today `style: 'brief'` is 150 ms of arrow plus ticks, and the turn is capped by wall-clock (6 s headline, 10 s
turn). Replace time caps with **count caps**: at Watch, an AI turn shows up to N fights in full beats (N = 2, or 3
when a human is the defender), and the rest *snap but are listed* in the receipt. Each shown beat:

| Beat | Body | Sound | Words |
|---|---|---|---|
| Turn arrives | cup slides to the seat (exists) | wood slide + soft set-down | banner "Sage · 7 armies", 1.5 s |
| Places | stones swell, one per 120 ms | `place`, panned to each | strip count ticks down |
| Attacks | camera *leans* (never cuts), stroke draws | stroke sound (exists for drag; reuse) | "Sage attacks Northern Europe…" |
| Dice | pour from cup, land in the ring | diceShake, diceLand ×n, hush 250 | (the ellipsis holds) |
| Verdict | flood or recoil | hit, conquer / somber conquer | "…and takes it" completes the line |
| Fortify | pieces travel the lane | march | "Sage moves 4 to Ural" |
| Turn ends | cup lifts | wood lift | line dries |

Pace at Watch is the human tempo from UX.md §8.2, not 2×. Fast = fewer beats shown (N = 1), not faster beats.
Skip = receipt only. Pillar 5 guard: a full AI turn at Watch stays within v3's envelope (≈ 10–12 s) because the
count cap replaces the time cap; measured in the timing lane.

### A2. The AI's sound is distance, not silence
The rule "AI-vs-AI plays at volume 0.5" is why bot turns feel absent. Replace volume with **space**: AI events play
at 0.8 with a longer send to the shared hall and a pan toward where they happen on the board. Far, not quiet.
`turnStart` currently fires for human seats only; every seat's turn start gets the cup set-down, and a human's gets
the bright variant on top.

### A3. The receipt
When a human gets the cup back after one or more AI turns, a card (paper, not a dialog) brushes in over the cover
or the strip: **"While you were away"** — one line per AI seat in its colour ("Ochre took Brazil, Peru and
Argentina from you · Sage took Northern Europe from Slate"), and as each line writes, the territories named pulse
once on the board. Tap anywhere dismisses. The three-line grey transcript above the rule goes (§8 Q4); the Ledger
stays for the record.

### A4. Losing leaves a mark
A territory taken from a human keeps a thin ring in the loser's colour until that loser's next turn ends. This is
the grudge made visible and the cheapest fix for Pillar 4 in the normal case. Cozy guard: this ring is the sting;
it never softens.

### A5. Fixes from the review that live here
- A pending truce offer never takes the primary slot and never hides the Place stepper (bug). Offers sit on the
  secondary line with Accept / Decline as small words; the AI proposes at most once per three rounds and only with a
  reason it can state ("Sage proposes a truce · you share a border in Asia").
- "Vermilion took Brazil from Venezuela" → "Vermilion took Brazil from Ochre".
- "Sage goes first" beat before the first AI setup turn.

## 4. Workstream B · the sonic fabric (smooth, integrated)

John: "the sonic experience to be a bit more smooth and integrated." Today the music has its own hall
(`createMusicHall`) and the effects are synthesized dry with per-cue levels. They are two products.

### B1. One room
All effects get a send to the score's hall (a second, shorter tap on the same impulse), so a die and a pad note
decay in the same space. Measured: the hall tail of `diceLand` and of a pad note share the same RT60 ±20 %.

### B2. Effects are notes in the music
`music.ts` already knows the chord sounding at time *t*. The pitched effects (`turnStart`, `continent`, `cardTrade`,
`victory`, `eliminated`) take their pitch from that chord: root or fifth for the bright ones, the minor third for
the somber ones. This is the Wingspan/Balatro trick and it is the single biggest "integrated" win. Unpitched
materials (paper, wood, bone) are untouched.

### B3. The score breathes with the table
Tempo stays (Pillar 5). What moves:
- **Turn passes:** the score's next chord change is *triggered* by the cup slide rather than the timer (the walk
  keeps its weights; only the moment moves). The room changes when the turn does.
- **A human's turn begins:** +2 dB swell over 2 s (exists as `bright` variant; make it a swell too).
- **A human loses a continent or a seat is eliminated:** the walk is biased to the open/minor voicings for one chord,
  then returns. The sting, in the music, once.
- **Idle 60 s:** the score thins to pad only and the mist thickens a touch; the table waiting.

### B4. Attacks and silences
- Nothing starts from zero except `diceLand` and the two bowls (property 3). Everything else gets ≥ 15 ms attack.
- The 70 ms arbitration and the verdict hush stay as they are; they are good.
- A faint room-tone bed under the score (paper, air) so silence never has a hard floor and the score's fade-in on
  load is not "sound appears".
- `uiClick` becomes a paper tick with no pitch; it stops competing with the music.

### B5. Someone has to listen
Memory says the score has never been heard by a human. B is not done until John plays two rounds with sound on and
can name five things he heard and what each meant. That is the acceptance test, not an analyzer.

## 5. Workstream C · cozy (new feel) and the frame

"Cozy" is defined here so it cannot drift into cute or polite.

- **Warmth in the paper.** The indigo stays; its edges warm toward a lamp-lit vignette (a few points toward
  umber at the frame's margins, nothing at the centre). The one gold goes a touch warmer (candle, not brass).
  Washes re-sampled from the reference with the lightness pass John rejected removed.
- **Drift you can see.** Pillar 1 says "never static." Define it: a point on a mist edge moves at least 1 px every
  2 s at 1440 wide, measured in the ink e2e flow. Today it fails.
- **Fewer, softer words.** One line above the rule, not three. The receipt and the Ledger carry the record.
- **Fill the frame.** Board scaled to viewport height (crop polar ocean), the strip and the one line into the
  southern band, the dice ring under the fight rather than in the South Atlantic. Phone portrait already fills;
  desktop matches it.
- **One medium, finished.** Dice painted as bone with ink pips (flat, painted shadow); the cup painted in the same
  hand. The 3D-lit cubes are the last object from the rejected direction.
- **Sting guard.** The cold breath in a fight (darker flood, dry snap, somber bowl, the loser's ring) is kept at
  full strength. Cozy makes the sting land harder by contrast; it never trades against it.

## 5b. Workstream E · the visual system (one hand)

John: "what about the visuals? how can they be improved in this integrated way?" The honest diagnosis of v3 at
rest is not that any one mark is wrong. It is that the screen was painted by several hands: the paper by one, the
stones by another, the dice by a 3D renderer, the HUD by a UI designer. Integration means one hand. Seven rules,
each with an audit that can fail.

### E1. One light
Today there are three light models on screen: the paper is unlit, the stones carry a painted lower-right shadow,
the dice and cup are lit from somewhere else with specular highlights, and the HUD rings have no shadow at all.
**Rule: one soft lamp, upper-left, expressed only as painted shadow** (offset lower-right, soft edge, a darker
wash of whatever is underneath). It falls on stones, the cup, the dice, the paper sheets (menus, receipt), the seat
trays. Nothing is ever specular; nothing is ever lit from a second direction. *Audit: list every shadow on a frame;
all point the same way, all are the same softness.*

### E2. One edge ladder
Coasts are double-stroked (ivory glow plus hairline), territory borders are thin dark lines, continent outlines
heavy silver, stones have a 1 px edge, HUD rings are brush strokes, the rule is a gold hairline. Six edges, six
hands. **Rule: four weights, each with one job, all drawn with the same brush texture (the same alpha jitter):**

| Weight | Role | Colour |
|---|---|---|
| Heavy (≈2.0) | coast: where land meets water | ivory |
| Medium (≈1.4) | continent outline (holder's colour while held) | silver / seat |
| Light (≈0.6) | territory border, stone edge | the seat's deep tone / paper's deep tone |
| Hair (≈0.4) | sea lanes, the gold rule, HUD rings | silver / one gold |

*Audit: every stroke on screen maps to one row.*

### E3. Three layers of contrast
At rest everything is at equal weight, so nothing can stand out. **Rule: every mark belongs to one of three layers
with a contrast budget against its local paper:**

- **Layer 1 · the couch** (reads at three metres): stones by size, continent outlines and their bonus, the cup.
  Contrast ≥ 60 %.
- **Layer 2 · the laptop**: numerals, figures, coast detail, seat names, the one line. Contrast 30–60 %.
- **Layer 3 · leaning in**: territory names on tap, granulation, wave marks, lane ticks. Contrast ≤ 15 %.

*Audit: the squint guard from v3's plan, automated: at 30 % scale the five largest stones and the continent outlines
are the highest-contrast marks on the frame. It runs in the e2e timing lane and fails the build.*

### E4. Colour in two intensities
The wash and the stone share a hue at nearly the same saturation, so a vermilion stone on vermilion land is the
lowest-contrast pair on the board, and 42 saturated washes are what John called busy. **Rule: the wash is the
territory's *tint* (about 35 % desaturated, lighter); the stone is the seat's *pigment* (full saturation, the deep
tone at the edge).** Ownership reads twice, as region and as object, without the two competing. The paper warms at
the frame's margins (the cozy vignette, §5), never at the centre. **The one gold is one:** at rest in v3 I counted
gold on the ensō, the Accept ring and the cup's shadow at once. *Audit: a frame never has more than one gold mark;
the stone/wash luminance gap is ≥ 25 % for every seat.*

### E5. One motion grammar
Strokes draw, floods soak, banners brush in and dry, the cup slides. The dice tumble under 3D physics, which is a
different world. **Rule: everything is drawn in and dries out.** One easing family (`EASE_BRUSH`, which exists), one
duration ladder, one origin.

| Tier | Motion | Duration | Sound (§4) | Words |
|---|---|---|---|---|
| 0 · tick | a dab, a stone swell | 160–290 ms | paper, place | count ticks |
| 1 · stroke | the attack stroke, the lane march | 400–650 ms | brush, march | the line begins |
| 2 · soak | conquest flood, continent re-ink | 650–1200 ms | conquer, the bowl | the line completes |
| 3 · breath | elimination dry-to-paper, victory, hand-off | 1600–2400 ms | stopAll, the dark bowl | the epitaph |

This ladder is the integration: one stakes ladder, three channels. A tier-2 event never gets tier-0 motion with
tier-3 sound. The dice join it as painted things: poured from the cup, a flat tumble with ink pips, landing with a
squash and a painted shadow. The camera leans (eased, at most 0.3 board widths) and never cuts. *Audit: every
`playEvent` is tagged with a tier, and its motion, sound and line durations fall in that tier's band.*

### E6. One type system
Cormorant Garamond digits at about 0.63 em were the legibility bug, and a leftover squash made it worse. Three
faces are in the bundle. **Rule: one family for words and numerals, one scale, lining figures for counts.** Scale:
11 (Layer 3 only), 14, 18 (numeral floor on desktop), 24, 40. Small caps for continent labels at 14 with the bonus
printed once. Personality labels under seat names reach 12 px or go. Every numeral gets the ivory halo already
shipped in v3. *Audit: no text on screen outside the scale; no numeral under 18 px at 1440 (12 on phones).*

### E7. Figures that read on every wash
The ivory brush figures are about 20 px and vanish on sage and ochre. **Rule: the figure stands on the stone, scales
with it, and carries a hairline of the seat's deep tone along its underside** so it reads on any wash. It is a
Layer 2 mark; the stone it stands on is Layer 1. *Audit: figure/stone contrast ≥ 30 % for all four seats.*

### E8. Sheets, not dialogs
Menu, Settings, Ledger, How to play, New game and the recap are flat navy panels: software-shaped, and the one place
the game stops looking like a table. **Rule: every overlay is a sheet of paper laid on the board,** with the paper
texture, the one lamp's shadow (E1), the type scale (E6), sliding in from the top edge (never fading in from
nowhere), with the paper sound (§7.12). Same hand as the board.

### E9. Water as adjacency, finished
The ocean is the one surface that is pure decoration today (wave squiggles) while carrying the game's most useful
hidden information (which shores touch). Sea lanes become portolan crossings: a hairline with a tick at each shore,
brightening to Layer 2 when either shore is selected, Layer 3 otherwise. The wave marks stay as Layer 3 texture
and never sit under a lane.

### E10. What stays still
Board game pieces do not breathe. Stones, figures and numerals are still at rest. What drifts is the mist, the coast
glow and, at idle, the vignette (§5). This is how cozy stays a table and not a screensaver.

**Acceptance for E.** The audits above run where they can be automated (E3, E4, E5, E6) and are checked by eye
where they cannot (E1, E2, E8). The human gate is the side-by-side at rest from Phase 3: v3 and v4 on the TV, John
says which he would leave on screen.

## 6. Workstream D · the board announces (from the review, carried over)

Stone scale law to the spec'd range (≈ 10 px for 1 → 32 for 10 → 44 for 20+ at 1440; overlapping borders allowed;
numeral floor 18 px desktop; figure scales with the stone). Cup becomes the largest HUD mark, not the smallest.
Card glyph and personality labels either reach 12 px or go. Seat rings show armies as well as territories (one
numeral each, or armies only; §8 Q6). Full detail in the review's §1, §5, §7.

## 7. The intentional details (the "ineffable touch", made effable)

Each is trigger → body + sound + word, built in the same hand. None is required to play. Together they are what a
friend means when they say "oh, this is nice."

1. **The deal.** Tiles flip from the cup's position outward, each with a paper tick panned to its place; the last
   lands and the first seat's banner writes. (Today: the deal is 2.5 s of flips with thinned ticks; make it radiate.)
2. **Hand-off.** The cover's cup is already in the next seat's colour; add the wood set-down and the +2 dB swell when
   that seat is human.
3. **Tap any territory.** Its name and count brush in large for one second with a paper tick, then dry. Right now
   tapping an enemy territory on your Place step does nothing you can feel.
4. **The stroke.** Drag-to-attack already has a stroke sound; the AI's stroke should use the same one, so the room
   learns one sound for "someone is attacking."
5. **The pour.** Dice leave the cup and land in the ring in the shared hall; the verdict hush; the hit panned toward
   the loser. Mostly exists; finish it.
6. **The soak.** Conquest colour crosses the border (exists); against a human, the dry snap and the loser's ring.
7. **Continent taken.** The outline re-inks in the holder's colour over 600 ms as the one sharp bowl rings in key.
8. **Turn passes.** Cup slides, wood slide, the chord changes. Three channels, one instant.
9. **Round ends.** The round numeral beside the ensō re-inks with a sheet-of-paper sound.
10. **Elimination.** The room goes quiet for a breath (exists), the epitaph writes, the dead seat's territories dry to
    paper over one breath rather than recolouring instantly.
11. **Victory.** "Ochre holds the world" and the Ledger offered as a scroll: the war in ink.
12. **Menu and Settings.** A sheet laid on the table with a paper sound; it slides from the top edge, never fades in
    from nowhere.
13. **Continue.** The title's Continue card shows a small ink thumbnail of the board as it was left.
14. **Idle.** After a minute untouched, the mist thickens slightly and the score thins; the table waits. Any input
    brings it back over 2 s.
15. **Reduce motion / mute.** Honoured in one place each, and the game still has body: the sentence still completes,
    the cup still moves (instantly), the receipt still writes.

## 8a. Decisions from the sitting (2026-10-03) — these bind the build

- **Q1 Cozy touchstone:** Wingspan's evening. Take: one continuous soundscape, warm light, nothing abrupt. Leave: its
  light palette and card UI. (Goes into SOUL Touchstones with John.)
- **Q2 Palette:** warm vignette at the margins + candle gold. Centre untouched; indigo stays.
- **Q5 Score:** reacts gently. Chord change on the cup slide; +2 dB swell on a human's turn; one cold chord when a
  human loses a continent or a seat. Tempo never changes.
- **Q8/Q11 Dice and cup:** painted. Bone dice with ink pips, flat tumble poured from the cup, painted shadow.
- **Q3 Bot turns, primary channel:** **receipt only.** The "While you were away" card is the record, always.
- **Q7 AI fights, John's words:** "I don't want any of them to play in full. I'd prefer if they just felt a bit more
  readable and clear and better paced as a whole." **So A1 changes:** no AI fight ever gets the dice show. Every AI
  event plays as a *readable beat* of the same shape (stroke draws → short bone click → verdict flood → the sentence
  completes), at one steady pace a person can follow, with no snapping and no wall-clock stalls. Dice theatre is for
  human fights only. The AI turn is a clear, even reel of outcomes; the receipt is its summary.
- **Q4 The line:** one line that writes and dries. The three-line transcript goes.
- **Q10 Sheets:** paper sheets sliding from the top edge with the lamp's shadow and the paper sound.
- **Defaults taken without asking (John may veto):** Q6 seat rings keep territories (it is the win condition) and the
  receipt carries armies; Q9 a 20+ stone may cross a neighbour's border.

## 8. Questions as asked (kept for the record)

1. **Cozy touchstone.** Wingspan's evening soundscape · Dorfromantik's calm · the Komorebi feel · a lamp-lit
   table photograph John supplies. Pick one; it goes into SOUL as a Touchstone with a take/leave line.
2. **Does cozy touch the palette** (warm vignette, candle gold) or only sound and motion?
3. **The spectator turn's primary channel:** the beat reel at Watch *and* the receipt always (my recommendation),
   receipt only, or reel only.
4. **The transcript above the rule:** one line (recommended), keep three, or none (receipt + Ledger only).
5. **The score reacting to the game** (chord changes on the cup slide; a cold chord on a human's loss): yes, or keep
   the score indifferent. Some players find reactive music gimmicky; done gently it is the Wingspan effect.
6. **Seat rings:** territories (today), armies, or both as two small numerals.
7. **AI-vs-AI fights shown per AI turn at Watch:** 1, 2 (recommended), or all.
8. **Dice:** painted bone (recommended, one medium) or keep the 3D cubes as "the one real thing" and say so in SOUL.
9. **Stone overlap:** may a 20+ stone cross a neighbour's border (recommended) or must it stay inside?
10. **Sheets (E8):** overlays as paper sheets sliding from the top edge (recommended), or keep the current panels and
    only fix their type.
11. **Dice as painted things (E5):** a flat ink tumble poured from the cup (recommended, one medium), or keep the 3D
    cubes. Same question as Q8, asked once; answering Q8 answers this.

## 9. SOUL "Before you plan" check (run on this plan)

- **Against the moment.** Serves it: cup slide + score change (the moment's "nobody had to ask what happened"),
  the receipt, the loser's ring. Works against nothing in it. Ignores: "mist drifting" is only served if C's drift
  measure passes.
- **Against the pillars.** P1 served (drift measurable, idle life). P2 served (scale law, receipt, cup). P3 neutral
  (no props added; the painted dice remove the last non-ink object). P4 served (ring, cold chord, somber variants
  kept at full). P5 held by the count cap replacing the time cap, measured.
- **Five inherited choices this plan leans on, and whether a clean-room build from SOUL would arrive there:**
  1. Watch / Fast / Skip as *speed* settings → no; a clean room would pace by *beats shown*. Changed (A1).
  2. AI-vs-AI at half volume → no; SOUL says "a soft ambient score always underneath; paper, brush, wood and bone when
     something happens", with no exception for bots. Changed (A2).
  3. Three stacked lines above the rule → no; "plain English with real names" says one sentence, not a log. Changed.
  4. Separate halls for music and effects → no; "a soft score underneath" implies one room. Changed (B1).
  5. Dice as lit 3D cubes → no; the 2026-09-30 one-medium rule. Changed (C, E5).
  6. (A sixth, because it is the biggest.) Wash and stone at the same saturation, six edge weights, three light
     models, three typefaces → no; "ink linework as structure" and "readable, not decorated" describe one hand.
     Changed (E1–E6).
  Kept and defensible from SOUL: the Turn Track, board-clicks-select, the cup as turn token, stones + figures.
- **Guesses.** None binding: every taste call is in §8.
- **Misread nearest.** 2026-09-28 (stillness, politeness). Guarded in §2, §4.B3, §5.

## 10. Sequencing (on top of v3; branch `v4` from `v3`, staging stays at war-table-v3 until John promotes)

| Phase | Scope | Gate |
|---|---|---|
| 1 · Announce | D (scale law, numeral floor, cup size) · A4 ring · A5 fixes · receipt card (A3) · turn banner | John's glance test, four questions, from the couch |
| 2 · Spectate + fabric | A1 beat grammar + count caps · A2 distance · B1 one room · B2 effects in key · B3 breathing | John's listen test (B5) |
| 3 · One hand | E1–E10 (light, edge ladder, layers, two-intensity colour, motion ladder, type, figures, sheets, water) · C: warmth, drift measure, fill the frame · one line | Audits E3–E6 green; side-by-side with v3 at rest on the TV; John says which he would leave on |
| 4 · Details | §7, in order of how often each fires | A friend plays ten minutes and, asked "what did you notice?", names one of §7 unprompted |

Phase 1 can start before the §8 sitting (none of its items depend on an answer except Q6 and Q9, which have
defaults in the review). Phases 2–4 wait for the sitting. Per the 2026-09-30 note, no agent launch without John's go.

**Suggested routing when it is a go:** Opus 5.5 builders in parallel worktrees (board, controller/audio, HUD), one
per workstream; Codex gpt-6-astra for the audio-engine review (cross-family ears on the hall and key-lock);
Fable for the taste pass on each phase's gate. The lead owns SOUL edits, contract files, and the §8 sitting.

## 11. What v4 is not

Not a pieces rebuild (fourth time). Not onboarding. Not more HUD rows. Not a new palette. Not online. Not a new
voice: every sentence in the game stays plain, named, numbered, and free of exclamation marks.
