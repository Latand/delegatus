# Model glyphs: design critique

Reviewed commit `d3a9055e8` ("Model glyphs in place of the stage dot"), PR #2311.
**Verdict: fail.** Sol, Terra and the kept green dot are ready to ship. Opus/Sonnet,
Haiku, Astra, Luna, the halo, the waiting state and the motion need another pass.

## How this was rendered

- `frames/`: the 56 frames from the existing driver,
  `src/components/kanban/kanbanBoard.browser.test.tsx -t "model glyphs"`. It was run
  from an export of the reviewed commit, under an isolated `LLV_STATE_DIR`, with
  Chromium headless shell 1243, and it passed. Desktop is 1440×1200 and phone is
  390×844, at a device pixel ratio of 2. There are light and dark, English and
  Ukrainian, and reduced-motion frames. `readings.json` beside them is that run's
  measurements.
- `closeup-*.png` and `motion-strips-*.png`: crops of the same fixture, made with a
  throw-away crop helper in the stage scratch directory (not committed). Each zooms
  the card pills with nearest-neighbour scaling.
  - `closeup-pills-{light,dark}-dpr{1,2}.png`: three rows of pills (running, then
    waiting, then settled).
  - `closeup-glyphs-only-{light,dark}-dpr{1,2}.png`: the same glyphs with the stage
    name hidden. The top row is running and the bottom row is waiting.
  - `motion-strips-{light,dark}.png`: 8 frames 200 ms apart for each running glyph.
    Rows from the top: Opus, Sonnet, Haiku, Fable, Sol, Astra, Terra, Luna.
  - Two densities are shown because a 1× external monitor is as likely as a 2×
    laptop screen, and a 14 px drawing lives or dies at 1×.

## Judged against the operator's words

| Operator asked | Reading | Evidence |
|---|---|---|
| "очевидно понятно, что там за моделька и что там за провайдер" | Provider: yes for Claude (the orange family is unmistakable). For Codex, the sky set works once learned. Model: **no for Opus vs Sonnet**, and Haiku reads as a propeller | `closeup-glyphs-only-light-dpr1.png`, `closeup-glyphs-only-dark-dpr1.png` |
| Claude = "оранжевая [штука]", each with "какая-то ассоциация" | Only Fable (fox) has a visible association. The others' ideas (8 petals = complete work, 10 short/long rays = iambic pentameter, 3 petals = 5-7-5) exist only in the design note and cannot be seen at 14 px | same, plus `frames/desktop-card-running-light.png` |
| Sol: yellow sun | Right, both themes, calm motion. Ship | `motion-strips-light.png` row 5 |
| Astra: "синее солнце ... очень яркое, мощное" | **Wrong**: a thin 4+4-point sparkle, the smallest and faintest glyph of the eight, and the generic "AI sparkle" idiom. In dark at 1× it is a white dot | `closeup-pills-dark-dpr1.png`, `closeup-glyphs-only-dark-dpr1.png` |
| Terra: Earth | Right. Reads as a globe at 1×, and the spin is calm. Ship | `motion-strips-light.png` row 7 |
| Luna: Moon | Right when waiting (a clear crescent). **Wrong when running**: the phase animation spends most of its cycle near a full disc, so it reads as a grey ball | `motion-strips-light.png` row 8, `closeup-glyphs-only-dark-dpr2.png` top row |
| "в тон подсвечивало правильно" | Half. Sol, Terra and Astra glow in tone. In light, the Claude and Luna halos are a blurred stain wider than the glyph. In dark, the Claude halos are almost invisible | `closeup-glyphs-only-light-dpr1.png`, `closeup-pills-dark-dpr1.png` |
| "анимация, когда оно работает" (calm) | Opus, Fable, Sol and Terra are calm. Sonnet and Astra pump in size fast enough to flicker with nine lanes on screen. Haiku's sway makes the rotor reading worse | `motion-strips-light.png` rows 2, 3, 6 |
| Reduced motion | Honoured: every figure stops and the halo stays lit (the driver's gate passes) | `frames/desktop-card-running-reduced-motion-{light,dark}.png` |
| State still readable | Running/waiting/passed/failed/needs: yes on the pill (border and badge) and on the node (word). Waiting glyphs fall far below 3:1. Reviewing and committing were never rendered | `closeup-pills-light-dpr1.png` row 2 |
| "если нету ... ассоциаций ... обычно зелёное" | Done: GPT-5.5 keeps the green dot running and the ring waiting | `closeup-pills-*-dpr1.png` last column |

## Findings, most severe first

### P1. Opus and Sonnet cannot be told apart at chip size, and no Claude idea except Fable's can be seen

`closeup-glyphs-only-light-dpr1.png` and `closeup-glyphs-only-dark-dpr1.png`,
columns 1 and 2: at 1× both are a ~12 px orange asterisk. At 2×
(`closeup-glyphs-only-dark-dpr2.png`), Sonnet's open centre is the only
difference. Mid-animation (`motion-strips-light.png` row 2) Sonnet takes an
irregular 5-pointed star shape that is neither glyph. On the real board, a pill says
"Design" or "Build" and nothing else on it names the model. So the glyph is the whole
answer to "which Claude is this", and for these two it gives none. The literary ideas
(`StageGlyph.tsx:127-133`: petals counted like poetic lines) are invisible without the
design note.

**Fix.** Keep Opus as the family's reference: the heavy, solid 8-ray Claude spark. Give
Sonnet and Haiku a concrete object with its own silhouette, the way Fable got the fox:
- Sonnet: a poet's quill, one diagonal feather with a nib, in the orange.
- Haiku: a single sakura blossom, five round notched petals and a small core.

The orange keeps the provider. The silhouette names the model.

**Acceptance.** In a glyph-only frame at 1× (text hidden), all four Claude glyphs have
pairwise-distinct silhouettes: a spark, a quill, a blossom and a fox.

### P1. Astra is not a "very bright, powerful blue sun"

`StageGlyph.tsx:139` draws `star([7.8, 4.4, …], 1.9)`, which is thin points round a
1.6-unit core. It has the least ink of the eight glyphs:
- In dark at 1× (`closeup-pills-dark-dpr1.png`, Astra column) it is a white dot with a
  faint cross.
- Failed (row 3), the red badge is bigger than the star.
- Waiting (row 2), it is nearly gone.

The operator asked for a blue *sun* that outshines Sol. This one is the weakest mark
on the board, and a 4-point sparkle is the stock icon for "AI", which blurs the
provider.

**Fix.** Draw Astra as a sun:
- a filled blue disc (r ≈ 3.8) with a white-hot centre;
- a corona of 12 sharp, long rays reaching the grid edge (Sol has 8 short, rounded,
  detached rays, so the two differ in silhouette as well as colour);
- the strongest halo of the set.

In dark, use a saturated blue for the disc (for example `#4da3ff`) and keep
`--glyph-astra-core` for the centre, so it does not wash to white.

**Acceptance.** At 1× in both themes, Astra's ink area is at least Sol's and it reads
blue, not white. Its failed badge covers less than a quarter of it.

### P1. Waiting glyphs fall to 1.75–2.0:1 in light, far under the 3:1 the design note claims

`modelGlyph.css:29` dims the whole drawing to 45% opacity. Composited on
`--surface-card`:

| Theme | Claude | Sol edge | Astra | Terra sea | Luna |
|---|---|---|---|---|---|
| Light | 1.75:1 | 1.88:1 | 1.98:1 | 1.84:1 | 1.82:1 |
| Dark | 2.35:1 | 3.33:1 | 2.60:1 | 2.23:1 | 3.52:1 |

At full ink they are 3.8–12:1. `tokens.contrast.test.ts` pins only full-opacity inks,
so the waiting state, which is the default look of every configured lane, is not
covered. You can see it in `closeup-pills-light-dpr1.png` row 2 and
`frames/desktop-sheet-chips-waiting-dark.png` (Astra and Haiku almost vanish).

**Fix.** Mark "waiting" with a treatment that keeps the silhouette at ≥3:1, for
example:
- `filter: saturate(0.35)` with opacity ~0.75; or
- drawing the figure as an outline in `--color-muted`.

Extend `tokens.contrast.test.ts` to check each glyph ink composited at the waiting
treatment.

**Acceptance.** Every waiting glyph is ≥3:1 against card, well and sunken surfaces in
both themes, and is still visibly quieter than running.

### P1. Luna, while running, reads as a grey ball, not a moon

`motion-strips-light.png` row 8 and `closeup-glyphs-only-dark-dpr2.png` top row:
- `mg-phase` (`modelGlyph.css:59`) slides the shadow disc from almost fully covering
  (a full moon) to a crescent.
- The earthshine at 22% (`modelGlyph.css:23`) fills the unlit part.
- The grey halo blurs the edge.

Most sampled frames show a grey disc. The waiting Luna, a still crescent, is the best
drawing in the set, and running makes it worse.

**Fix.**
- Limit the phase animation to thin crescent ↔ fat crescent, so it never passes a
  half moon.
- Drop the earthshine to ~0.1 in light (or remove it).
- Give the halo a cool silver-blue (for example `#9fb3d9` light, `#c9d6f2` dark)
  instead of the slate ink.

**Acceptance.** Every frame of the motion strip shows a crescent.

### P2. Haiku reads as a propeller, and its sway makes it a rotor

`closeup-glyphs-only-*-dpr1.png` column 3: three blades round a hub. The "7 above, 5
and 5 below" difference (7.6 against 5.4 units) is invisible at 14 px. The ±14° sway
at 2.4 s (`modelGlyph.css:50`) reads as a fan starting up. The design note already
flags this.

**Fix.** The blossom from the first finding. Animate it as a slow ±6° sway or a single
petal drifting, not a rotation.

**Acceptance.** Nobody reads it as a fan in the glyph-only frame.

### P2. Sonnet and Astra motion is not calm

`motion-strips-light.png` rows 2 and 6:
- Sonnet's long rays shrink to 0.72 and its short rays grow to 1.42 every 1.1 s
  (`modelGlyph.css:69-70`), so the silhouette flips between shapes.
- Astra pumps between 0.8 and 1.12 scale with ±8° turn every 1.4 s
  (`modelGlyph.css:72`).
- The halo breathes on its own 1.8 s cycle, so every glyph beats against its own halo.

With nine running lanes on a card, the result flickers.

**Fix.**
- Every figure period ≥ 2.4 s.
- Scale change within ±8%.
- Sonnet (if kept): an opacity wave round the rays instead of scaling them.
- Astra: a slow corona rotation plus a gentle core-brightness pulse.
- Run the halo at the figure's period.

**Acceptance.** Consecutive 200 ms frames of every glyph keep the same silhouette.

### P2. The halo is a stain in light and nearly absent in dark

`modelGlyph.css:34-36`: one radial gradient at 60% over a 24 px circle for both
themes:
- In light (`closeup-glyphs-only-light-dpr1.png`), Haiku, Opus and Luna sit in a
  blurry pink or grey blot wider than the drawing, and it runs into the pill border.
- In dark (`closeup-pills-dark-dpr1.png`), the Claude halos barely register.

The operator asked for a glow "в тон ... правильно".

**Fix.** Per-theme halo strength tokens:
- light: a tighter halo (inset −3 px, peak ~35%), or a 2 px `drop-shadow` in the ink;
- dark: a stronger halo (peak ~70%).

**Acceptance.** In light, the halo stays inside the pill's inner edge. In dark, every
running glyph has a visible glow in its own tone.

### P2. The Fable fox reads as a cat or a heart at 1×

`closeup-glyphs-only-light-dpr1.png` column 4: a rounded heart with two ears. The chin
point is short and there is no snout or cheek mask, so at 12 px it is a cat.

**Fix.**
- Narrow and lengthen the muzzle to a clear point.
- Cut the fox's white cheek mask (two light triangles from the eyes to the chin) out
  of the head.
- Drop the eye cuts, which do not survive at 1×.

**Acceptance.** The glyph-only frame reads "fox" before "cat".

### P2. The settled badge swallows the glyph at 1×

`closeup-pills-light-dpr1.png` and `closeup-pills-dark-dpr1.png` row 3, and
`frames/desktop-sheet-settled-light.png` (Astra failed):
- The 8 px badge at right/bottom −3 px (`modelGlyph.css:67-71`) covers the lower-right
  quarter of the glyph.
- On Astra it is larger than the star itself.

On the graph node, the pane head and the phone row, the state word sits right next to
the glyph anyway.

**Fix.**
- Move the badge out to −4 px.
- Keep it on the pill and the Stages chip, where no word is printed.
- On hosts that print the state word, drop the badge and let the word and the node
  border carry the state.

**Acceptance.** No glyph loses more than ~15% of its ink to a badge.

### P2. The evidence cannot answer the operator's first question, and it skips states

`issue1695Evidence.fixture.tsx` (`GLYPH_MODELS`) names every stage after its model
("Opus", "Astra"), so every frame prints the model beside its glyph. In real lanes the
pill says "Design" or "Build".

The fixture also has no `reviewing` or `committing` stage and no reworking settled
stage. It never draws Sonnet, Terra or Luna settled, so the badge on the round glyphs,
the design note's own open question, is never rendered. The old dot said reviewing in
blue. Nothing shows what now says it.

**Fix.**
- Name the fixture's stages by role (Design, Build, Review, …).
- Add lanes in `reviewing`, `committing` and a reworking `passed`.
- Settle every model at least once.
- Add a text-hidden legend frame to the driver's describe block.

**Acceptance.** The driver renders those frames, and each state is distinguishable
without the model name.

### P2. Two components still draw the old per-stage dot

- `src/components/pipelines/StagePlaceholderPane.tsx:253-257`: a tone-coloured
  `h-2 w-2 rounded-full` with `animate-pulse` while running. This is the "green dot
  that glows" itself. It is used by the phone's stage-configuration sheet
  (`MobilePipelineScreen.tsx:507`), `PipelineStrip.tsx:209` and the scheme canvas
  (`scheme/nodes.tsx:1542`).
- `src/components/pipelines/StageCompletedCard.tsx:71`: the same dot on a completed
  stage.

The spec says one glyph component for every place that draws the per-stage dot.

**Fix.** Render `<StageGlyph state={state} model={valuesOf(stage.effectiveRole)} fallback="dot" />`
(or a `fallback` that keeps today's Tailwind dot) in both places.

**Acceptance.** A grep for tone dots in stage headers finds none outside `StageGlyph`.

### P3. The Codex set shares no provider cue

Claude is "the orange ones". The Codex four are yellow, blue, blue-green and grey. They
read as one family only once you know the sky theme. That is acceptable because the
operator chose these images. If a cue is wanted cheaply, give all four the same thin
cool rim or halo hue family. Do not add a vendor mark.

### P3. Every running glyph runs a `drop-shadow` filter over an animated SVG

`modelGlyph.css:37` sets a `drop-shadow` on each live SVG while its paths animate. That
repaints the filter every frame for every running stage on the board.

**Fix.** Drop the filter and let the (composited) `::before` halo carry the glow.

## What should stay

- **Sol**: right in both themes, with the amber edge in light a good call. Its ray
  rotation is the calmest motion in the set.
- **Terra**: a clear globe at 1×, and a lovely spin.
- **The waiting Luna crescent.**
- **The other-model dot**: the green dot and the waiting ring are exactly what the
  operator asked for.
- **Reduced motion**: all figures stop and the halo stays lit. Correctly done, and
  gated by the driver.
- **One mark per stage**: dropping the engine mark beside a glyph removed the double
  orange spark.

## Answers to the design note's open questions

- **Haiku as a propeller:** yes, it reads as a propeller; redraw it (P2 above).
- **Waiting at 45% too faint for Astra in dark:** yes, and for everything in light
  (P1 above).
- **Badge covering round glyphs:** not rendered at all. The fixture never settles
  Terra or Luna (P2 above). On Astra it already covers more than a quarter.
