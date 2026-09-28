# Model glyphs in place of the stage dot

Status: design and first build, 2026-09-28.

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
the Stages sheet's nav chips, folded pane strips and pane heads, and every
`PipelineBlock` pill and stage row, so the desktop card, the task row and
the phone's task and pipeline screens all draw the same component.

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

The four Claude names are literary forms. Three glyphs are the orange spark
with its rays counted like the form's lines, and Fable, a form with no line
count, is the fable's own animal.

| Glyph | Idea | Drawing |
|---|---|---|
| Opus | the complete work | eight full-length petals round a solid core, the heaviest spark and the family's reference form |
| Sonnet | iambic pentameter, five feet of short-long | ten thin rays alternating short and long round an open centre |
| Haiku | three lines of 5, 7 and 5 syllables | three petals, the upper one longest (7) and the two lower equal (5) |
| Fable | the fox of Aesop and of Krylov's and Hlibov's fables | a fox's head, ears up, chin down, eyes and inner ears cut out |
| Sol | the sun | a yellow disc and eight detached rays |
| Astra | a blue-white star, very bright | four long and four short sharp points with a white-hot core |
| Terra | the Earth | a blue sea disc with green land and a rim |
| Luna | the Moon | a crescent, with the unlit part drawn faint as earthshine |

Silhouettes differ, not only colours, so the eight stay apart for a
colour-blind reader: petals, rays, a trefoil, a head, a rayed disc, a star,
a filled disc, and a crescent.

## Colours per theme

Tokens live in `src/styles/tokens.css` (light block, the dark media block and
`[data-theme="dark"]`). The Claude glyphs reuse the Claude mark token.

| Token | Light | Dark |
|---|---|---|
| `--glyph-claude` | `var(--color-claude-mark)` = `#c96442` | `#e08a6d` |
| `--glyph-sol` (disc fill, glow) | `#f7b500` | `#ffcd38` |
| `--glyph-sol-edge` (rays, disc outline) | `#9b6500` | `#ffcd38` |
| `--glyph-astra` | `#1764e8` | `#63b3ff` |
| `--glyph-astra-core` | `#d9e9ff` | `#f2f8ff` |
| `--glyph-terra-sea` | `#2a78cf` | `#4a9cf0` |
| `--glyph-terra-land` | `#2b9a4f` | `#5ccf80` |
| `--glyph-terra-rim` | `#1d5aa3` | `#8cc2f7` |
| `--glyph-luna` | `#66728f` | `#d3daea` |

Every ink that draws a silhouette clears 3:1 against the card, canvas, well and
sunken surfaces in both themes, which `tokens.contrast.test.ts` pins. Yellow
cannot do that on the light paper (1.8:1 as a fill), so in the light theme
Sol's disc is outlined and its rays are drawn in the deeper amber edge. The
dark theme needs no edge.

## States

The dot's colour used to say the state. The glyph now says the model, so the
state moves to the glyph's treatment and corner:

| Stage state | Reading | Drawn as |
|---|---|---|
| running, committing, reviewing | running | full colour, a halo in the glyph's own tone, and the glyph's motion |
| pending, skipped | waiting | the same glyph at 45% opacity, as a configured node is dashed |
| passed | passed | full colour, still, a green badge with a tick |
| failed | failed | full colour, still, a red badge with a cross |
| needs_decision | needs | full colour, still, an amber badge with a bang |

The badge is 8 px, in the stage's `STAGE_TONE` (the one tone map), with the
shapes the stage mark already used, and it is cut out of the glyph by a ring
of the surface. A settled stage whose conversation works again (#1744) keeps
its badge and moves. The state word, the node's border and the pill's border
carry the tone as they did.

## Animation

Only running glyphs move, each in its own way:

- Opus turns slowly and breathes.
- Sonnet's long and short rays trade lengths in the meter's beat.
- Haiku sways like a blossom.
- Fable tilts its head, telling the tale.
- Sol's rays turn round the disc.
- Astra twinkles: its points pulse and turn a little.
- Terra's land slides round the globe as the planet spins.
- Luna runs through its phases and back.

Behind every running glyph a radial halo in the glyph's tone breathes. All
motion is declared under `prefers-reduced-motion: no-preference` only. Under
reduced motion every figure stands still and the halo stays lit, so running
still reads apart from idle.

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
`?scenario=model-glyphs`:

- nine one-stage lanes, each running one model (a lane runs one stage at a
  time);
- a draft of the same nine stages, all waiting;
- a lane with passed, passed, failed, needs-you and waiting stages;
- a ninth, uncatalogued model (`gpt-5.5`) in each, which must keep its dot.

It draws light and dark:

- on the desktop: the cards, the cards' graphs, and the Stages sheet with its
  graph, pane heads and chips;
- on the phone: the board cards, the task screens and the pipeline screens.

Every frame is taken at a device pixel ratio of 2. There are four frames of
the running card, a reduced-motion pass, and Ukrainian cards and task screens.
It measures each glyph's model, reading, motion, badge, size and box, the
host's accessible text, and that no stage draws the glyph and an engine mark
both. It fails on any mismatch.

Readings are committed at `evidence/model-glyphs/design/readings.json`. The
PNGs are written beside it and stay out of the commit, as
`evidence/**/*.png` is ignored and the publication gate refuses a raster
without a deterministic generator.

## Open for the critique

- Haiku's three petals may read as a propeller more than as a poem.
- Waiting at 45% opacity is faint for Astra in the dark theme.
- The badge covers a quarter of the round glyphs (Terra, Luna, Sol's disc).
