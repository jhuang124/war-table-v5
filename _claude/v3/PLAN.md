# War Table v3 — the physical board (2026-09-30, rewritten after John's answers)

## What John decided (two picker rounds, 2026-09-30)

- **The correction that matters:** "I'm missing the physicality. An animated, beautiful video board game, not a
  standard video game with abstracted UI/UX." The ink look stays; the *ontology* becomes physical.
- **Audience first:** the friend who just looked up from their phone (intermittent attention, couch distance).
- **The one read at rest:** the power map: who holds what, where the big stacks are, continents as regions.
- **Table cues, all four:** stack height = strength · the dice cup = the turn · printed continents · visible water =
  adjacency.
- **Benchmark class:** illustrated board + tactile pieces (the Root / Wingspan digital class): the board is a painted
  object, pieces are tokens, the camera leans in like a person. Steal its structure, not its features.
- **The frame:** full-screen map (no table, no board edge); the marks are what become physical.
- **Leaves the resting board:** figures, territory names. **Stays:** the seat strip (as trays), small numerals.
- **First game:** the host explains, like a real table. No onboarding product work; the board's cues must make it
  teachable for free.
- **Acceptance:** the glance test with friends, not screenshot rubrics.
- **Palette:** back to the reference. **AI scope:** truces + grudges + personalities. **Order:** maps and AI start in
  parallel with the board work (John's call, against my recommendation to sequence).

## Why the build went wrong (kept from the first draft, one paragraph)

The resting board is the sum of every correction (figures added after "flat discs", HUD cut after "overdone",
props cut after "messy") and drifted from the reference John chose. Everything is at equal weight, so nothing can
stand out: whose turn, which continent, where the lanes go. It was designed for one attentive reviewer and
verified with screenshots; it renders state and announces nothing; readability was defined as owner + count only.
Upstream answers above replace those assumptions.

---

## 1. One medium: painted things

John (2026-09-30, on the first build): "the stacks don't look good; I'm questioning that direction; correct with a
more visually coherent approach." The lead's first ontology said *paint vs objects* and named the objects' materials
(lacquer, wood, bone). That produced CG poker chips (specular, gradient lighting, hard shadows, a tilted camera)
on a matte hand-painted board: two rendering languages on one screen. The roles were right; the materials were wrong.

**Corrected rule: one medium. Everything on the board is painted, including the things players own.** A piece is a
thing because it has an edge, a painted shadow and it moves, never because it is lit or three-dimensional. The
map is flat (top-down home pose; no tilt). The cup, the dice tray ring, the stones and the fight figures are all
drawn in the hand that painted the coasts.

**Armies = painted stones, size = strength, with the unit icon standing on the stone** (John, 2026-09-30:
"Bring the icons back." SOUL's touchstone is the ivory brush figure on an owner-coloured blot; the stone is the
blot. Soldier 1–4, rider 5–9, cannon 10+, scaled to the stone, numeral at the stone's edge; never a free-standing
figure beside a badge.) One go-stone shape per territory: an irregular ellipse in the seat's
base wash, a 1 px ink edge in the seat's deep tone, one darker-wash shadow stroke offset lower-right. Diameter is
area-linear in armies (≈14 px for 1, ≈36 px for 30 at 1440×900), capped per territory so a stone never covers
another's numeral or land; the numeral sits inside. Size reads from the couch better than height, needs no tilt,
and needs no occlusion caps. Motion: placing = the stone swells as the wash soaks in; losing = it shrinks with a
puff; conquest = it slides along the stroke; elimination = it dries to paper. Previews are ghost stones.

Rejected, for the record: disc stacks (height = strength; CG; needed a tilt and per-territory height caps), the
purist heatmap (wash deepens with strength: still nothing to hold, and fights colour-blind ΔE), tally strokes
(42 clusters of strokes = noise), free-standing figures at rest beside a badge (the icon now rides the stone).

## 1a. Touchstones for the physical board (real things, not mockups)

John (2026-09-30) asked "what reference?" and the honest answer was: only the moodboard frame (palette and linework)
and his gold-rule image (the HUD's signature). For the new direction the references are real objects, each with a
take/leave line, the way SOUL's Touchstones work. Agents are held to these qualities; John can veto any in a glance.

- **Go stones on a paper board**: take the matte weight and the contact shadow that makes a stone *sit*; leave
  black-and-white.
- **Poker-chip stacks**: take height as count and one thick chip as five; leave casino gloss and edge stripes.
- **A turned-wood dice cup on a table**: take "the object that says whose turn it is" and the pour; leave any felt
  or leather.
- **The printed continent zones on a classic Risk board**: take regions readable from across the room, with the
  bonus printed once; leave its colours and its typography.
- **A portolan chart's sea routes**: take crossings drawn over water from one shore to another; leave the compass
  roses and rhumb-line webs.
- **One Root or Wingspan digital screen**: take a painted board with objects on it and nothing that looks like
  software; leave their palettes and their card-heavy layouts.
- **Still binding**: `_claude/moodboard/chosen-silver-ink-board.png` for paper, coasts, washes and one gold;
  `john-ref-1-gold-rule.png` for the HUD's rule and ring. The current code is not a reference.

If John wants these as images in `_claude/moodboard/`, the lead gathers them with his permission (web images are a
download); until then they bind as words.

## 2. The table cues

- **Stack height = strength**: §1.
- **The dice cup = the turn**: one turn token, the cup, a small turned-wood object that sits on the paper beside the
  current seat's ring in the existing strip (the strip itself is not restyled). Dice roll *out of the cup* into the ink ring on the board and return to it. Turn end = the cup slides to
  the next tray (400 ms), and on 2+ humans the hand-off cover reads "Pass the cup to Sam" with the cup drawn in
  Sam's colour. Whose turn is never a question: find the cup.
- **Printed continents**: one heavy silver outline round each continent plus a faint paper tint per continent (the
  real board's coloured zones, at ink restraint); label with bonus stays. Held continent = outline in the holder's
  colour while held.
- **Visible water = adjacency**: sea lanes drawn as crossings over water you can see (a hairline with a tick at each
  shore), brighter with the selected territory; the map fidelity pass (maps agent) makes the Bering Strait, Central
  America and the Mediterranean recognisable so the crossings feel earned, not arbitrary.

## 3. Announcing, for the friend who looked up

**The HUD carries the table's state** (John, 2026-09-30: the HUD is "a bit too sparse"; keep its aesthetic, fill it).
Fuller, not busier: every mark answers a table question. Under each seat ring: held-continent ticks and a card
count; the cup beside the current seat; the round written by the ensō; the event line persists until the next
event; on desktop the ledger's last two lines sit faintly above the rule. SIMPLIFY's "no totals" is relaxed if one
numeral per seat can carry armies without clutter.

- **Turn banner**: "Sam's turn · round 6 · 7 to place" draws in and dries out over ~2 s as the cup arrives.
- **Event line + ledger**: one plain sentence per event in the line ("Sam took Asia · +7", "John eliminated Theo",
  "Priya ends her turn"); a collapsible ink-scroll ledger by round, two taps away. The ledger later feeds the
  "war in ink" victory.
- **Continent captured**: outline re-inks in the owner's colour (600 ms brush reveal), "+N" brightens, paper cue.
- **Elimination exhale**: the seat's tray dries out, its last pool drains over one breath, one sentence.
- Sound from the existing five materials; nothing inside the dice silence.

## 4. What comes off the resting board

Figures (fight-only), territory names (hover, select, fight line), the count-ring double stroke (replaced by the
pool), the wash lighten pass (palette to reference), default player names printing seat ids.

## 5. The test

- **Glance test with friends** (the gate): at random moments a non-acting player answers in one second from the
  couch: whose turn? who holds Asia? where can Ural attack? what just happened? Every miss is a bug.
- **Squint guard** (internal, not a gate): an automated 30 %-scale check that the five largest pools and the
  continent outlines are the highest-contrast marks on the frame. Cheap insurance that the power map survives
  later changes.
- Existing suites stay; tempo budgets unchanged (Pillar 5).

## 6. v3 in parallel (John's order)

- **Map packs**: `maps/<id>/` (geometry, topology, rules, presentation); Classic byte-identical; **True World**
  (minimal lenses, recognisable straits) as the accuracy answer; format ready for a small 2–3 player original map.
- **AI as a player**: personalities (Turtle, Opportunist, Warlord), grudges with decay, truces as engine events with
  plain sentences, 2-player neutral armies; human-facing proposals gated until the UI exists. Optional: a commander
  piece per AI seat as its persona on the board.
- **The arc**: "war in ink" victory from the ledger; undo for the last placement/fortify.

## 7. SOUL.md amendments (with John, not by an agent)

Audience = a table of intermittently attentive players. Pillar 2 test = owner, count, reach and stakes. New pillar
or Feel line: **physical, not abstract**: strength is mass, the turn is an object, continents are printed, water is
visible. A second moment: "the cup passes to Sam". Misread entry: 2026-09-30, the board became the sum of
corrections; figures everywhere contradicted the reference.

## 8. Fleet, when John says go

Three Opus agents in worktrees, briefs carrying this file and SOUL: **Board** (§1–§4, palette, the `table` and
squint checks), **Maps** (§6 packs + True World), **AI** (§6 engine). Fable reviews Board against mockup A and the
reference before merge. The lead integrates, runs the full suite on a quiet machine, and rebuilds the demo.
Then the glance test: one evening, two friends, a notebook.

## 9. Still John's

1. The mark: A (recommended), D, or a hybrid.
2. Go on the three agents.
