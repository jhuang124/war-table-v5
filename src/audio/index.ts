// Public surface of the audio module (docs/SPEC.md §8; ink bank: docs/INK.md §6, A4, A5).
//
//   import { createAudio } from './audio';
//   const audio = createAudio({ volume: settings.sfxVolume, music: settings.music });
//   audio.play('place', { pan: -0.2, delay: 0.2 });
//
// Unlocks itself on the first pointerdown/keydown; play() before that is a silent no-op, never throws.
// After unlock a background bank pre-renders variations (~2 s), so play() costs ~0.1–0.3 ms.
// Levels are normalised inside the engine (tiers follow the stakes ladder): call play() at volume 1.
// v4 (PLAN §3 A2, "distance, not silence"): never turn the AI down with volume. Pass
// { distance: 0.6 } on every event no human is acting in (AI turns, AI-vs-AI): it sounds across the
// room (−2.4 dB, more of the shared hall, a softer top), still clearly there.
//
// Five materials: paper (ticks, sheets, the turn breath), brush (dab, sweep, route, flood, the snap,
// the breath of smoke), wood (the dice cup, the turn cup), bone (dice landing), bowl (continent,
// elimination, victory). The ambient score is ON by default at ~35% of the effects level and ducks by
// itself under dice, the verdict beat and conquests.
//
// v4 one soundscape (PLAN §4): every effect sends into the score's own hall (B1: one room, one RT60);
// the pitched effects (turnStart, cardTrade, cupSet, continent, eliminated, victory) take their note
// from the chord sounding right now (B2; D minor when the score is off); a faint room tone sits under
// the score; nothing starts from zero except dice, the AI's bone click and the two bowls (B4).
//
// Silence rules the engine enforces: uiHover never sounds (no hover sounds); at most one cue starts
// per 70 ms (the more important one wins; dice landings, splashes and hit · pair are one texture and
// exempt); nothing new starts inside a hush() window (the verdict beat).
//
// v5 (_claude/v5/PROPOSAL.md §4 A, B, D, F; SOUL: cozy at rest, sharp in the moment, the fight is the one
// place the room goes cold for a breath). Five cues (cue(name) ≡ play(name)): splash, rattle, ripple,
// glint, pour; hit gains variant 'pair'; the engine gains fightCold?(on) and setEvening?(t). The dice
// pour: landings within 200 ms of the last are one sequence: each die takes the next of three bone
// timbres, ±4 % rate, the first a touch louder (later ones −1 dB), each later one a little wetter.
//
// Recommended event → sound mapping (1× timings; at 2× halve the delays/durations, floor 80 ms, and
// never use `rate` for speed: "2× compresses the spacing, never the pitch"):
//   button press, selection, dice-count toggle → uiClick (a pitchless paper tick)   rejected → uiError
//   tap a territory (its name brushes in), the deal's flips, the round numeral → audio.cue?.('tick')
//   overlay / menu / settings / receipt sheet opens → cue('sheet'); closes → cue('sheet', { variant: 'lift' })
//   armiesPlaced count > 0 → place at contact: { delay: 0.2 }; rapid clicks rate 1 + 0.03·streak (≤ 1.15)
//   armiesPlaced count < 0 (undo) → unplace                     territoryClaimed → place
//   territoriesDealt flips → cue('tick', { pan }) per flip, panned to its place (the engine thins bursts)
//   the turn passes (every seat) → cue('cupSlide', { duration: slideMs / 1000 }) as the cup slides, and
//       audio.turnPassed?.(nextIsHuman) on the same frame (the score's chord changes now; +2 dB swell
//       over 2 s when the next seat is human); cue('cupSet') as it lands (pitched to the new chord's root);
//       AI seats: both with { distance: 0.6 }
//   turnStarted (human seats) → turnStart as the line brushes in (in key); { variant: 'bright' } after AI turns
//   AI attack, 'readable' style (PLAN §8a Q7: no dice show) → whoosh as the stroke draws, then
//       cue('bone') once as the roll resolves (never diceShake/diceLand), hit, conquer: all { distance: 0.6 }
//   a human loses a continent or a seat is eliminated → audio.lean?.('cold') with the bowl (one cold chord)
//   no input for 60 s → audio.setIdle?.(true) (score thins to drone + pads); any input → setIdle(false)
//   drag-to-attack (A2) → const s = audio.stroke?.({ pan }); s?.move(speed, pan) on pointermove
//       (speed 1 ≈ one board width per second); s?.end(true) when it arms, s?.end(false) otherwise
//   attack arrow drawing itself / camera move > 0.3 board widths → whoosh { duration: ms / 1000 }
//   the fight begins (the camera leans toward it) → audio.fightCold?.(true); the camera returns → fightCold?.(false)
//       (the score's top dips 2 dB and the room tone thins in ~0.3 s; back over ~1 s; tempo untouched)
//   diceRolled, single roll → diceShake { duration } as the cup shakes (not on repeat rolls within 3 s);
//       v5: diceLand per die AS EACH DIE LANDS (60–90 ms apart) { pan: attacker −0.3 / defender +0.3 };
//       never pass `rate` on a single roll (the engine spreads each die ±4 % itself and picks its timbre);
//       as the last die settles → audio.hush?.(250) (the verdict beat: 250 ms of nothing, score dips);
//       after the beat, per matched pair as its gold hairline draws: play('hit', { variant: 'pair', pan:
//       toward the pair's loser }) and cue('splash', { pan: the losing die }) (pairs may share a frame or
//       follow ~100 ms apart; both are exempt from the 70 ms rule). A pair the defender wins still plays
//       hit · pair (the attacker's figure falls). No plain 'hit' when pairs are played.
//   blitz → one diceShake { duration: 0.1 }; per middle roll one diceLand { rate: min(1.4, 1 + 0.08·k) } + hit
//       { volume 0.5 } (the drum); the final roll as a single roll above (pour, beat, pairs + splashes)
//   an AI's first attack of its turn → cue('rattle', { pan: its seat }) ~0.4 s before the stroke (no distance:
//       the rattle's own default is 0.3, slightly across the table, nearer than the AI's other events);
//       tap the cup → cue('rattle', { pan })
//   reinforcements arrive → cue('pour', { duration: min(0.6, max(0.25, 0.085·armies)), pan: the holding dab })
//       as the stones pour into the dab (3–7 dabs; root then fifth); a card trade's stones → the same, after cardTrade
//   tap open water → cue('ripple', { pan })      tap a sea lane → cue('glint', { pan: shore A, panTo: shore B,
//       duration: the glint's travel in s (0.15–1.2) }) (a tiny note on the chord's fifth that travels)
//   the round changes → audio.setEvening?.(min(1, (round − 1) / 11)) (dusk at round 1, night from round 12)
//   territoryConquered → conquer as the flood starts; { variant: 'somber' } whenever the previous
//       owner is human (A5: the dry brush snap, a darker flood); march { duration: 0.5, delay: 0.15 }
//   armiesMoved occupy → march { duration: 0.4 }; fortify → march { duration: min(0.9, 0.22·hops) }
//   continentGained → continent; a human's continent broken → continent { variant: 'somber' } (damped)
//   cardDrawn → cardDraw;  cardsCaptured → cardDraw × min(n, 3), 90 ms apart
//   cardsTraded → cardTrade; rate 1.0 at 4 → 0.75 at 20+ (slows the sheets; its note stays on the chord); volume 1.26 above 10
//   playerEliminated → stopAll(), then eliminated { delay: 0.15 } (low bowl, hard onset)
//   gameOver → stopAll(), then victory (the score ducks under it on its own)
//   new game / continue → audio.setMusicSeed?.(gameSeed) (the score is seeded per game; crossfades)
//   board.skipAnimations() → audio.stopAll()
//   settings: SFX volume → setVolume, score → setMusic / setMusicVolume, M key → setMuted

export { createAudio } from './engine';
export { SFX_NAMES, TIER_TARGET_LUFS, V4_CUES, V5_CUES } from './types';
export type { AudioEngine, AudioStats, CreateAudioOptions, PlayOptions, SfxName, SfxVariant, StrokeHandle, V4Cue, V5Cue } from './types';
