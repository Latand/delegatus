# Model glyphs: design critique, round 2

Reviewed commit `89503d247` ("Model glyphs: redraw after the first critique"), PR #2311.

**Verdict: fail, and close to shippable.** The redraw fixed every round-1 problem that
mattered. Each Claude glyph now carries an idea you can see (spark, quill, sakura, fox).
Luna stays a crescent in every frame, waiting keeps its ink, the motion is calm, and the
badge leaves the drawing alone. Two things still need a pass before this ships:

- a passed stage lost its green on the graph node and the Stages pane;
- Astra reads as a cog at 1×.

The rest are small.

## How this was rendered

- `frames/`: all 102 frames of the existing driver,
  `src/components/kanban/kanbanBoard.browser.test.tsx -t "model glyphs"`. It ran on an
  export of the reviewed commit under an isolated `LLV_STATE_DIR`, with Chromium headless
  shell 1243 under Bun 1.4.0, and it passed with 0 failures. The frames cover:
  - desktop at 1440×1200 and phone at 390×844, both at device pixel ratio 2;
  - light and dark, English and Ukrainian, and a reduced-motion pass;
  - text-hidden legends at 1× and 2×.

  `readings.json` holds that run's measurements, with paths re-pointed at `frames/`.
- `closeup-*.png`, `truesize-*.png` and `motion-strips-*.png`: made by a throw-away crop
  helper in the stage's scratch export (not committed) over the same fixture:
  - `closeup-glyphs-{light,dark}-dpr{1,2}.png`: each glyph cropped from its card pill
    with its halo, zoomed 8× (1×) or 4× (2×), nearest-neighbour. The rows are running,
    waiting and settled. The columns are the eight models, the uncatalogued `gpt-5.5`,
    then reviewing, committing and a passed stage working again.
  - `closeup-pills-{light,dark}-dpr{1,2}.png`: the same, with the whole pill and its name.
  - `truesize-nameless-{light,dark}-dpr1.png`: the pills at true 1× size with the names
    hidden. This is the honest answer to "can I tell at a glance".
  - `motion-strips-{light,dark}.png`: each running glyph at 13 seeked times, 300 ms
    apart. The figures are exact. The halo column is not reliable (see P3-a), so the
    halo's real curve is sampled numerically in `probe.json`.
- `probe.json`: the halo opacity over one period, the time one card screenshot takes,
  and the check that the builder's "fails on main too" tests fail identically on
  `f7683f109`. They do: 44 pass and 3 fail on both commits.

## Judged against the operator's words

| Operator asked | Reading | Evidence |
|---|---|---|
| "очевидно понятно, что там за моделька и что там за провайдер" | **Yes** at 2×, and mostly at 1×. Claude is the orange family; Codex is the sky set. With names hidden, all eight are pairwise distinct at 2×. At 1× the only weak spot is Astra (see P2-b) | `closeup-glyphs-light-dpr2.png`, `truesize-nameless-light-dpr1.png` |
| Claude: "оранжевая [штука]", and "какая-то ассоциация" for Opus/Fable/Sonnet | **Yes.** Opus is the spark, Sonnet a quill, Haiku a five-petal sakura, Fable a fox with the cheek mask cut out. The fox now reads fox before cat, even at 1× | `closeup-glyphs-{light,dark}-dpr1.png` columns 1–4 |
| Sol: yellow sun | Right in both themes. Ship | column 5 |
| Astra: "синее солнце ... очень яркое, мощное" | At 2×, **yes**: a saturated blue star-sun with a white-hot core and the strongest glow. At 1× it becomes a 12-tooth cog, most visibly waiting and settled in light | `closeup-glyphs-light-dpr1.png` column 6 |
| Terra: Earth | Right. Ship | column 7 |
| Luna: Moon | **Fixed.** A crescent in every running frame, with a silver-blue glow | `motion-strips-{light,dark}.png` last row |
| "в тон подсвечивало правильно" | **Yes.** In light, the halo stays inside the pill. In dark, every running glyph glows in its own hue. The Claude glow in dark is a warm brown, which is acceptable for orange on near-black | `closeup-glyphs-dark-dpr2.png` running row |
| Animation, calm | **Yes.** Periods are 3–5 s, the figures rock, turn or phase within one silhouette, and nothing pumps. The halo eases out on each half-cycle (P3-b) | `motion-strips-*.png`, `probe.json` |
| Reduced motion | Honoured: the driver finds no figure animation and a steady halo at opacity 1 | `frames/desktop-card-*-reduced-motion-*.png` |
| State readable | On pills: yes. Waiting is dashed and drained; passed, failed and needs carry a badge; running is solid with a halo. **Passed lost its green on the graph node and in the Stages pane** (P2-a). Reviewing vs running rests on the border alone (P3-c) | `frames/desktop-card-graphs-waiting-settled-{light,dark}.png`, `frames/desktop-sheet-settled-*.png` |
| "если нету ... ассоциаций ... обычно зелёное" | Done. `gpt-5.5` keeps the green dot when running and the ring when waiting | `closeup-glyphs-*` column "other" |
| Legible at chip size, both themes, phone | Yes on the phone task rows and the phone card (`frames/phone-task-*`, `frames/phone-card-*`). Sonnet is the thinnest mark (P3-d) | as listed |

## Findings, most severe first

### P2-a. A passed stage lost its green on the graph node, the pane head and the folded pane strip

**Where.** `PipelineSection.tsx:596` (graph node), `StagesSheet.tsx:450` (pane head) and
`StagesSheet.tsx:375` (folded pane strip) pass `badge={false}` to the glyph. The rule is
that the state word beside the glyph carries the state there. But `kanbanBoard.css`
colours that word for every tone except `ok`:

- `.pnode .pstate` at `:1197-1202`;
- `.pane-head .pstate` at `:1371-1375`.

A passed word stays `--color-secondary` or `--color-muted`. The old dot was green there
(`kanbanBoard.css:523`, `.tone-ok .pdot { background: var(--stage-tone) }`).

**What it looks like.**

- `frames/desktop-card-graphs-waiting-settled-light.png`: the Design, Build, Docs, Tidy and
  Migrate nodes read "passed" in grey, with no green anywhere on the node.
- `frames/desktop-sheet-settled-light.png`: the pane heads, the same.

A failed node is red and a needs node is amber, so "passed" is now the only settled state
with no colour. The spec says: "do not lose what the dot's colour used to say".

**Fix.** Pick one:

- add `.pnode.tone-ok .pstate` and `.pane.tone-ok .pane-head .pstate` rules with
  `color: var(--color-success)`, the way the phone row already prints "passed" in green
  (`frames/phone-task-waiting-settled-light.png`);
- or keep the badge on those hosts.

The first costs no ink.

**Acceptance.** In both themes, a passed node and a passed pane head show green, and the
driver gates the node word's computed colour for each settled state.

### P2-b. Astra is a cog at 1×

**Where.** `StageGlyph.tsx:209`: `star(12 × 7.9, 4.1)` over a 4.1-unit disc. The geometry
at 14 px:

- 12 equal teeth, each about 3.3 px long and 1.9 px wide at the base;
- together they make the proportions of a gear.

**What it looks like.** `closeup-glyphs-light-dpr1.png`, column astra: the waiting (navy)
and settled rows read as a settings cog. In the running row, the 60% halo turns it into a
blue blob. `truesize-nameless-light-dpr1.png`: at true size, the waiting Astra is a small
dark cog. At 2× (`closeup-glyphs-*-dpr2.png`) it is a fine blue star-sun, so the idea is
right and only the 1× rendering fails. A 1× external monitor is a normal screen for this
operator.

**Fix.** Make the corona read as a sunburst:

- alternate 8 long rays (to 7.9) with 8 short ones (to about 6.2);
- use a narrower inner radius between the points (about 3.6, hidden under the disc), so
  every point is a thin spike;
- keep the white-hot core. Sol keeps its 8 detached, rounded rays, and Astra gets 16
  attached, alternating spikes, so the two still part by shape.

**Acceptance.** In `truesize-nameless-light-dpr1.png` and its dark twin, the waiting and
running Astra read as a star or sun, never a gear. The driver's Astra ≥ Sol ink check
still holds.

### P3-a. The driver's "eight frames 200 ms apart" are not 200 ms apart

**Where.** `kanbanBoard.browser.test.tsx:13226-13232`, and the design note at
`docs/design/model-glyphs.md:227`. The loop schedules frames 200 ms apart, but a
locator screenshot of the running card takes 246–874 ms (`probe.json`,
`cardScreenshotMs`). The real spacing is therefore 250–900 ms and uneven, and the
"keeps its silhouette between consecutive frames" story is told over the wrong interval.
My own first strip hit the same trap and aliased the halo into a blink.

**Fix.** Seek the frames: pause every animation with
`document.getAnimations()`, set `currentTime` to `n × 200`, then shoot. Or rename the
frames by the time actually measured.

**Acceptance.** The frame names and the note state intervals that the frames really have.

### P3-b. The halo breath uses the UI ease-out, so each half-cycle starts with a quick drop

**Where.** `modelGlyph.css:57` animates `mg-halo` with
`var(--ease-standard) = cubic-bezier(0.2, 0, 0, 1)`, which applies to each keyframe half.
`probe.json` shows the result: the opacity falls 1.00 → 0.84 in the first 300 ms, then
creeps; it rises 0.60 → 0.80 in 300 ms, then creeps. It is calm enough, and it reads as a
soft blink at each turn.

**Fix.** Use `ease-in-out` for `mg-halo`, as the figures already do (`:58-66`).

**Acceptance.** The sampled halo curve is symmetric around each extreme.

### P3-c. Reviewing and running differ only by the pill's border hue

**Where.** `readings.json`, `legend-states-light`: running `rgb(116,167,126)` and
reviewing `rgb(110,182,171)`, both solid, both with the same live glyph. At 1×
(`closeup-pills-light-dpr1.png`, the reviewing column next to astra running) that is a
green-grey versus a teal-grey 1 px line. The old dot was a filled 7 px disc in the review
blue. The node and the pane still print "reviewing" in the info colour, so this matters
only on the pill and the Stages chip.

**Fix, optional.** Give `.pb-pill.st-reviewing` (and `.navchip` in review) the info tone
at full strength on the border, or a faint info fill.

**Acceptance.** Running and reviewing pills are told apart at 1× with names hidden.

### P3-d. Sonnet has about 57% of the ink of the other Claude glyphs

`readings.json`, `badge-ink-light`: Sonnet is 45 px of ink, against Opus 78, Fable 79 and
Haiku 86. In `truesize-nameless-light-dpr1.png`, the waiting quill is a faint diagonal
hairline. It is still recognisable.

**Fix, optional.** Widen the vane by about 25% (the `w` values in `StageGlyph.tsx:183-188`).

### P3-e. The fixture shows a raw i18n key in the frames the operator will open

`issue1695Evidence.fixture.tsx:492` gives `p-glyphs-settled-more` the pipeline state
`"failed"`, which is not a `PipelineState` (`src/lib/pipelines/types.ts:525`). Every
waiting and settled frame prints "pipelineState.failed"
(`frames/desktop-card-waiting-settled-light.png`).

**Fix.** Use `"needs_decision"`, or `"closed"` with `closedAt`, as a real failed lane
settles.

### P3-f. Two newly migrated hosts have no rendered evidence

`StagePlaceholderPane.tsx` and `StageCompletedCard.tsx` now draw `StageGlyph` with the
badge on, inside an `h-10` header. They are opened from the phone's stage-configuration
sheet, the pipeline strip and the scheme canvas. No frame shows them, so the badge
against that header's tinted background (`--glyph-cut` falls back to `--surface-card`)
has not been seen.

**Fix.** Add one frame of each to the same describe block. Alternatively, drop the badge
there, since the completed card prints the state in its title.

## What should stay

- The Claude set: spark, quill, sakura and fox. Each is an idea you can see, all in one
  orange, and pairwise distinct at 1×.
- Sol, Terra and the new Luna crescent.
- The waiting treatment: drained colour at full ink. The silhouette stays, and the state
  still reads as quieter.
- The badge sitting out past the corner (at most 8.7% of any glyph's ink covered,
  `readings.json`), and its absence where a word is printed. P2-a only asks that the
  word then carry the green.
- One mark per stage (no engine mark beside a glyph), and the kept green dot for other
  models.
- The reduced-motion handling and the driver's gates for it.
