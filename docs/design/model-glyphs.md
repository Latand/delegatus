# Model glyphs in place of the stage dot

Status: design, first build and the rework after the first critique, 2026-09-28.

## Originating requirement

The operator, 2026-09-28, by voice, over a screenshot of a stage chip
"Design → Build" with a green dot and "1 працює" (excerpts, one word elided):

> вместо вот этих зелёных кружочков, которые свечиваются, я бы хотел, чтобы тут
> было очевидно понятно, что там за моделька и что там за провайдер ... если
> Claude Code, то это вот эта оранжевая [штука], которая у них. Но надо
> придумать, как сделать так, чтобы было понятно, что вот это Opus, а вот это
> Fable, а вот это Sonnet ... какая-то ассоциация ... Такая иконка, и анимация,
> когда оно работает.

> у GPT есть такая линейка Sol, Terra, Luna, Astra. Я бы хотел, чтобы вместо вот
> этого кружочка был, если Sol — это солнце, было бы жёлтое, если это Astra —
> это синее солнце, ну, типа очень яркое, которое мощное. Если Terra — это
> земля, если Luna — это луна ... и красиво, чтобы оно в тон подсвечивало
> правильно.

> если нету никаких ассоциаций интересных с моделькой, то тогда обычно зелёное.

Prior work: `search_transcripts` for the glyph, the stage dot and the model
names, in English and Russian, found only the conversation above.

## One glyph, every place a stage is drawn

`StageGlyph` (`src/components/kanban/StageGlyph.tsx`) replaces the per-stage
dot everywhere it was drawn: the graph node's state row, the docked fix strip,
the Stages sheet's nav chips, folded pane strips and pane heads, every
`PipelineBlock` pill and stage row, and the header of a stage pane
(`StagePlaceholderPane`, which the phone's stage-configuration sheet, the
pipeline strip and the scheme canvas open, and `StageCompletedCard`). So the
desktop card, the task row, the scheme and the phone's task and pipeline
screens all draw the same component. A stage pane's header prints no state
word, so there the glyph is named "{model}: {state}" and keeps the state as
its hover title, as the dot did; the pane's border is in the state's colour, so
the glyph draws no badge there. A model with no glyph keeps the small tone dot
it had (`fallback="tone"`).

One stage, one mark. The node, the Stages chip, the pane and the phone's stage
row used to draw the engine mark in their identity line as well, and beside a
glyph that is the same fact twice (for Claude, two orange sparks). Where the
model has a glyph, `StageIdentity` (with `glyph`) leaves the engine mark out
and keeps the model's name and the effort ladder. Where the model has none,
the engine mark stays, since it is then the only thing naming the engine.

Which glyph a model gets is `modelGlyphKind` (`modelGlyph.ts`):

- Claude reads by family through `normalizeClaudeLaunchModel`, so `opus`,
  `opus-5-5` and `claude-opus-5` all draw Opus.
- Codex reads by the name after the version: `gpt-6-sol` and `gpt-5.6-sol`
  are both Sol, because the operator named the line.
- Anything else (another engine, `gpt-5.5`, Copilot's `claude-sonnet-5`, a
  blank record) has no glyph and keeps exactly the dot or mark its host drew.
  A folded "✓3" count has no model and keeps its check.

## The glyphs

All eight are original drawings on a 16-unit grid, drawn at 14 px. None is a
vendor's file.

The four Claude glyphs share the orange and each is an object its name brings
to mind, so the silhouette names the model where a pill says only "Design" or
"Build". The first round counted the spark's rays like each literary form, and
at 14 px nobody could see the count: Opus and Sonnet were the same asterisk.

| Glyph | Idea | Drawing |
|---|---|---|
| Opus | the Claude spark itself, the family's reference | eight broad petals round a solid core, the heaviest of the four |
| Sonnet | the poet's quill | one feather on the diagonal, the broad vane up, a barb split below, the rachis cut through it, and a nib at the lower left; the vane is wide enough to keep its ink beside the other three at 1× |
| Haiku | the season word of the form: cherry blossom | a sakura, five round petals each notched at its tip |
| Fable | the fox of Aesop's and Krylov's and Hlibov's fables | a fox's head: tall ears, flared cheek tufts, a long muzzle to a clear point, and the white cheek mask cut out; no eye cuts, which did not survive 1× |
| Sol | the sun | a yellow disc and eight detached, rounded rays |
| Astra | a blazing blue star, brighter than Sol | a filled blue disc with a white-hot core and eight pointed rays grown out of it, four long on the cardinals and four shorter between |
| Terra | the Earth | a blue sea disc with green land and a rim |
| Luna | the Moon | a crescent, with the unlit part a faint earthshine |

Silhouettes differ as well as colours, so the eight stay apart for a
colour-blind reader and in the waiting state, where colour drains: a spark, a
quill, a blossom, a head, a sun with detached rays, a star, a filled disc, and
a crescent. Astra and Sol part by shape as well as hue: Sol's eight rays are
rounded, equal and stand off the disc, Astra's eight are pointed, long and
short in turn, and grow out of it. The second round's twelve equal teeth read
as a cog at 1×; alternating the lengths is what makes a star of it. Astra draws
at least as much ink as Sol, which the driver measures.

## Colours per theme

Tokens live in `src/styles/tokens.css` (light block, the dark media block and
`[data-theme="dark"]`). The Claude glyphs reuse the Claude mark token.

| Token | Light | Dark |
|---|---|---|
| `--glyph-claude` | `var(--color-claude-mark)` = `#c96442` | `#e08a6d` |
| `--glyph-sol` (disc fill, glow) | `#f7b500` | `#ffcd38` |
| `--glyph-sol-edge` (rays, disc outline) | `#9b6500` | `#ffcd38` |
| `--glyph-astra` (disc, corona, glow) | `#1764e8` | `#4da3ff` |
| `--glyph-astra-core` | `#d9e9ff` | `#f2f8ff` |
| `--glyph-terra-sea` | `#2a78cf` | `#4a9cf0` |
| `--glyph-terra-land` | `#2b9a4f` | `#5ccf80` |
| `--glyph-terra-rim` | `#1d5aa3` | `#8cc2f7` |
| `--glyph-luna` | `#66728f` | `#d3daea` |
| `--glyph-luna-glow` | `#9fb3d9` | `#c9d6f2` |
| `--glyph-halo-reach` | `3px` | `5px` |
| `--glyph-halo-peak` | `40%` | `45%` |
| `--glyph-halo-peak-strong` (Astra) | `50%` | `55%` |

Astra's dark disc is a saturated blue so the sun does not wash to white, and
only its small core is near white. Luna glows a cool silver-blue: its slate
ink as a halo read as a grey stain.

Every ink that draws a silhouette clears 3:1 against the card, canvas, well and
sunken surfaces in both themes, which `tokens.contrast.test.ts` pins. Yellow
cannot do that on the light paper (1.8:1 as a fill), so in the light theme
Sol's disc is outlined and its rays are drawn in the deeper amber edge. The
dark theme needs no edge.

## States

The dot's colour used to say the state. The glyph now says the model, so the
state moves to the glyph's treatment, its corner and its host:

| Stage state | Reading | Drawn as |
|---|---|---|
| running, committing | running | full colour, a halo in the glyph's own tone, the glyph's motion; the pill's border in the active tone |
| reviewing | running | the same, with the pill's and the Stages chip's border in the full review tone (blue), where running keeps a softened green |
| pending, skipped | waiting | the colour drained (`saturate(0.35)`) at full ink, still, no halo; the pill's border dashed |
| passed | passed | full colour, still, a green badge with a tick, or the state word in green where the word is printed |
| failed | failed | full colour, still, a red badge with a cross |
| needs_decision | needs | full colour, still, an amber badge with a bang |

Waiting keeps the silhouette at full ink because opacity cannot: at the first
round's 45% the Claude orange fell to 1.75:1 on the light card, and even 75%
leaves it at 2.4:1. Drained, every silhouette ink clears 3:1 on the card,
canvas, well and sunken surfaces in both themes (worst: the Claude orange on
the light card at 3.4:1), which `tokens.contrast.test.ts` pins by reading the
treatment out of the CSS rule. It still reads quieter than running: no colour,
no halo, no motion.

Committing reads as running, as it did with the dot, which drew both in the
same tone. With the words hidden every other state reads apart, which the
driver checks pill by pill (border, badge, motion, treatment).

The badge is 8 px, in the stage's `STAGE_TONE` (the one tone map), with the
shapes the stage mark already used, cut out of the glyph by a ring of the
surface and set out past the glyph's corner (−4 px), so it covers at most 7%
of any glyph's ink (the driver measures each one and fails above 15%). It is
drawn only where no state word says the state in its colour: on the pill, the
Stages chip, the docked fix strip and a folded Stages pane strip (whose grey
label holds the word). The graph node, the Stages pane head and the phone's
stage row print the state word beside the glyph in the state's colour (green,
red, amber), and a stage card's border is in it, so there the word and the
border carry the state and the glyph keeps all of its ink. The second round
dropped the badge on the node and the pane head while their word stayed grey
for a passed stage, so passed lost its green; the word is green now, and the
driver compares each settled word's colour with its state's token. A settled
stage whose conversation works again (#1744) keeps its badge and moves.

## Animation

Only running glyphs move, each in its own way, and slowly enough that a card
of nine running lanes does not flicker. Every glyph has one period
(`--mg-period`, 3 to 5 s), its halo breathes on that same period, and no
figure grows or shrinks by more than 8%, so each keeps one silhouette from
frame to frame:

- Opus turns slowly and breathes (to 93%).
- Sonnet's quill writes: it rocks ±4° about its nib.
- Haiku's blossom sways ±6°.
- Fable tilts its head ±5°.
- Sol's rays turn round the disc.
- Astra's star breathes (to 93%) and its white-hot core flares. It does not
  turn: off its axes an eight-point star blurs into a cog at 14 px.
- Terra's land slides round the globe as the planet spins.
- Luna waxes and wanes between a thin crescent and a fat one, and never
  reaches a half moon.

Behind every running glyph a radial halo in the glyph's tone breathes, on an
ease-in-out curve that is symmetric about each extreme (the UI's ease-out
dropped it in the first 300 ms and then crept): tight
on the light paper, where the first round's wide glow was a stain, and wider
on the dark, where it barely registered. It is faint behind the drawing and
strongest just past the glyph's rim, so the glow shows round the glyph while
the silhouette keeps its edge; a strong glow of the glyph's own colour right
behind it turned the quill and the fox into blobs at 1×. The halo is the glyph's
only glow; there is no per-frame filter on the animated drawing. All motion
is declared under `prefers-reduced-motion: no-preference` only. Under reduced
motion every figure stands still and the halo stays lit, so running still
reads apart from idle.

## Accessibility

The glyph is decoration by default, like the dot it replaces, because its
hosts already say the model and the state in their own names:

- The node's label carries the identity sentence ("Claude · Opus 5.5 ·
  reasoning high") and the state word.
- The pill's label and the chip's label carry both too.
- A phone stage row's visible text prints the model and the state word.
- The card's line stays passive, with nothing in it to stop on.
- A folded pane strip is a button named "expand {stage}" inside a region that
  says the engine and the state. The model is in the pane head once it
  opens, which is unchanged from the dot.

The Stages pane head is the one host without such a name. There the glyph is
named "{model}: {state}" (`kanban.modelGlyph.aria`, English and Ukrainian, for
example "GPT-6-Astra: працює"), and the word beside it is hidden from the
reader so the state is not said twice.

## Evidence

The driver is the existing kanban browser test,
`src/components/kanban/kanbanBoard.browser.test.tsx`, with the describe block
"model glyphs in place of the stage dot". It runs over the shared fixture's
`?scenario=model-glyphs`, whose stages are named by the role they play
("Design", "Build", "Docs", "Tidy", "Verify", "Critique", "Migrate", "Test",
"Fix"), as real lanes name them, so no frame prints a model's name beside its
glyph on a pill:

- nine one-stage lanes, each running one model (a lane runs one stage at a
  time);
- a draft of the same nine stages, all waiting;
- two lanes that between them settle every model (passed, failed, needs-you),
  the round glyphs among them;
- a review at work, a commit landing, and a passed stage whose conversation
  works again;
- a ninth, uncatalogued model (`gpt-5.5`) on the "Fix" stage, which must keep
  its dot.

It draws light and dark:

- the legend: the three cards with every word hidden, at 1× and at 2×, and
  the running card in eight frames with every animation paused and seeked to
  0, 200 … 1400 ms, so they are 200 ms apart whatever a screenshot costs;
- on the desktop: the cards, the cards' graphs, and the Stages sheet with its
  graph, pane heads, folded pane strips and chips;
- on the phone: the board cards, the task screens and the pipeline screens.

There is a reduced-motion pass and Ukrainian cards and task screens. It
measures each glyph's model, reading, motion, badge, size and box, the host's
tone and accessible text, and that no stage draws the glyph and an engine mark
both; that with the words hidden no two states look alike; and, with each
settled glyph's badge hidden, how much of its ink the badge covers and that
Astra draws at least as much as Sol; that every passed, failed and
needs-you word on a graph node and a pane head is in its state's colour; and
that each running halo, sampled at tenths of its period, is symmetric about
its extremes. It fails on any mismatch.

Readings are committed at `evidence/model-glyphs/design/readings.json`. The
PNGs are written beside it and stay out of the commit, as
`evidence/**/*.png` is ignored and the publication gate refuses a raster
without a deterministic generator.

## The first critique, answered

`evidence/model-glyphs/critique/critique.md` failed the first build. What
changed for each finding:

- Opus and Sonnet alike, no Claude idea visible: Sonnet is a quill and Haiku
  a sakura; Opus stays the spark, broader.
- Astra a faint sparkle: a blue sun with a twelve-ray corona, the strongest
  halo, and a saturated dark disc.
- Waiting under 3:1: drained colour at full ink, pinned by the contrast test.
- Luna a grey ball while running: the phase stays a crescent, the earthshine
  is 10%, and the halo is silver-blue.
- Haiku a propeller: the blossom, swaying ±6°.
- Restless Sonnet and Astra: one period per glyph of 3 s or more, scale within
  8%, the halo on the same period.
- Halo a stain in light, absent in dark: per-theme reach and strength.
- Fox read as a cat: a long pointed muzzle, the cheek mask cut out, no eyes.
- Badge swallows the glyph: moved out, and dropped where the state word is
  printed.
- Fixture named stages after models, skipped states: role names, the live
  states, every model settled, and the legend frames.
- Two components drew the old dot: both stage panes draw `StageGlyph`.
- Codex set with no shared cue (optional): left as the operator's four images.
  A shared cool rim would muddy Sol's yellow, and the sky theme already ties
  them.
- A drop-shadow repainting every frame: removed.

## The second critique, answered

`evidence/model-glyphs/critique/critique.md` failed the second build on two
P2s and listed six P3s. What changed for each:

- A passed stage lost its green on the graph node, the Stages pane head and
  the folded strip: the node's and the head's word is green for passed, as it
  is red and amber for failed and needs-you; the folded strip draws the badge
  again. The driver checks every settled word's colour.
- Astra a cog at 1×: eight pointed rays, long and short in turn, over a
  larger disc with a smaller white-hot core. Running, the star holds its axes
  and breathes, and its halo is softer (50% light, 55% dark), since the
  turning star and the strong halo made a blob of it at 1×.
- Motion frames not 200 ms apart: every animation is paused and seeked to the
  frame's time before the shot.
- The halo on the UI ease-out: ease-in-out, sampled and checked symmetric.
- Reviewing and running pills alike: reviewing takes the full review tone on
  the pill's and the chip's border.
- A raw i18n key in the fixture: the fourth lane waits on the operator
  (`needs_decision`) after its failed Test stage, a real pipeline state.
- Sonnet faint: the vane is 25% wider.
- The stage cards' badge unrendered: `StageCompletedCard` and
  `StagePlaceholderPane` draw no badge, as a started stage's card has its
  border in the state's colour and the completed card prints its state in its
  body.
