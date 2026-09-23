# Phone kanban: critique of the round-1 mockups, pipelines first (#2072)

Design review only. It judges the round-1 note (`docs/design/phone-kanban.md`)
and its 26 rendered mockups, compares their pipelines with the desktop board's
pipeline presentation as it renders on `main` today, and ends with the
recommendations the revision is built and tested against. Code references are
to `origin/main` at `3322d7bb8` unless they say otherwise.

## 0. The requirement

Source: issue #2072, filed 2026-09-23. Its outcome, verbatim:

> On a phone the board is a convenient kanban: the operator sees where every
> piece of work stands (by status column or equivalent), moves between columns
> and into a task, a pipeline or a conversation with one hand, and acts from
> there. It is one coherent phone surface, combined with what the phone board
> shows today (orchestrator seat, "Needs you", pipelines, working agents, recent
> conversations) rather than a second screen beside it. The operator asked to
> rethink what is wrong with the current phone board, not only to add columns.

The operator's verdict on round 1, 2026-09-23, as recorded in this stage's
specification (paraphrased in English): overall the design is fine, but the
pipelines look bad. Pipelines must be very convenient on the phone. The desktop
board already has something close to right for how a pipeline looks: the
pipeline group header, the stage pills and stage chain, the Stages view
("Етапи" in the Ukrainian UI) and the PR and issue chips from #2059. The phone
should build on that, after this critique. The example given is the task
screen: each pipeline is a card with a title, a status pill, two wide equal
stage bars ("збірка" in red, "рев'ю" empty) and a meta line
"етап 1/2 · збірка — збій · 41 хв · без PR", and the needs-decision block above
it repeats the same pipeline with "Відкрити конвеєр ›".

This stage's brief asks for severity-ranked findings tied to a named mockup and
region, covering hierarchy, density, tap targets and one-hand reach,
redundancy, status colour semantics, what a pipeline row must answer at a
glance (what stage, is it moving, what does it need from me, which PR), and how
the desktop pipeline presentation should translate to 390 px; pipelines first,
then anything else that is weak; and concrete, testable recommendations.

## 1. What was looked at

- **All 26 round-1 frames** in `/var/tmp/phone-kanban/mockups/`: board, task,
  needs, empty, loading and jump, each at 390 × 844 and 430 × 932 in en and uk,
  plus the board in the light scheme at 390 in en and uk. Every frame was
  opened and read. The mockup page was measured a second time for this
  critique (element boxes at 390 × 667 and 430 × 735, the page iOS Safari leaves
  with its bottom URL bar), because the round-1 `geometry.json` gates targets
  and overlap and records nothing about the pipeline elements.
- **The operator's three phone screenshots** of today's board and conversation
  in `/var/tmp/seat-mobile-kanban-refs/`.
- **The desktop pipeline presentation, rendered for this critique** into
  `/var/tmp/phone-kanban/desktop-ref/`. This worktree's HEAD predates the merge
  of #2068 (the PR and issue chips the operator names), so the render is from an
  export of `origin/main` at `3322d7bb8`, with its own `bun install`. The driver
  is the repository's kanban evidence harness
  (`serveEvidenceFixture` and `openFixture` in
  `src/components/kanban/issue1695BrowserHarness.ts` over
  `issue1695Evidence.fixture.tsx`): the real components bundled by the
  repository's evidence builder with `NODE_ENV=production`, the production
  stylesheet compiled from `globals.css`, a loopback server on port 0, and
  Chromium through `playwright-core` with `CHROME_BIN=google-chrome-stable`.
  `XDG_CONFIG_HOME` and `LLV_STATE_DIR` pointed at an empty directory beside the
  frames; the fixture answers every request itself. Memory before the run:
  13.2 GB free. The browser and script PIDs were recorded at start and both
  were confirmed exited afterwards. Frames, dark scheme, en and uk:

  | Frame | What it shows |
  | --- | --- |
  | `desktop-board-1440-*.png` | the board at 1440 × 900 |
  | `desktop-card-t-links-*.png` | a pipeline parked on a decision: header, state chip, two-stage chain |
  | `desktop-card-t-search-*.png`, `…-graph-*.png` | a four-stage chain with a review loop and a fail edge that fired; the same card with the graph open |
  | `desktop-card-t-upload-*.png` | an eight-stage chain that wraps to three lines |
  | `desktop-card-t-many-links-*.png`, `…-open-*.png` | five pipelines on one task with #2059 chips; the completed ones folded, then opened |
  | `desktop-stages-sheet-t-upload-*.png`, `…-t-links-*.png` | the Stages sheet: numbered stage navigator, graph, one pane per stage |
  | `desktop-issue1798-card-en.png`, `desktop-issue1938-card-en.png` | fail edges as return arcs; a spent review budget with both heads |
  | `desktop-narrow-700-*.png`, `…-card-t-many-en.png` | the desktop's own narrow form: one tabbed column, board 452 px wide |
  | `phone-board-390-*.png`, `phone-pipeline-390-*.png` | today's phone board and today's phone pipeline screen, the one every pipeline tap in round 1 lands on |

  Measurements are in `measures.json` and `head-measure.json` beside them.
- **Has this been solved before?** `search_transcripts` for "phone pipeline
  stage chain 390 critique", "MobilePipelineScreen stage list needs decision
  red cross", "mobile pipeline screen stages swipe pane phone", "stage track
  segments card phone kanban" and a Ukrainian phrasing, project-scoped and
  unscoped, found no earlier critique of the phone's pipeline presentation. The
  relevant prior design is mobile-v2: its README §4.7 designed today's phone
  pipeline screen (findings, Skip and Retry as 44 px buttons, a stage list), and
  its critique (P1-2) put pipeline decisions into the Needs you queue. Both
  still hold on `main` and this critique builds on them.

## 2. Verdict

The board's direction holds, as the operator said: status columns with tabs and
a swipe, needs-you cards pinned first, the orchestrator in the dock, history off
the work surface. Nothing in that part is WRONG-PREMISE.

The pipelines fail the verdict for three reasons, and each is structural:

1. **Round 1 invented a third pipeline vocabulary.** The desktop draws a
   pipeline as a header (title, state chip, stage note) over a chain of named
   stage pills in `STAGE_TONE` colours, with PR chips per pipeline and a Stages
   view. Today's phone pipeline screen draws a stage list with its own marks.
   Round 1 draws neither: a 12 × 4 px unlabelled track and a prose line on the
   card, two equal-width labelled boxes on the task screen, and it extends the
   phone's stage colours, which contradict the desktop's and the design
   system's.
2. **The decision is shown twice and can be taken nowhere on the screens
   drawn.** The task screen spends 35 % of the page on one pipeline (its
   needs block and its row), names the three possible answers in prose, and
   offers only "Open pipeline ›".
3. **The screen where a pipeline is decided is not drawn.** Every pipeline tap
   lands on today's `MobilePipelineScreen`, which round 1 never rendered and
   which carries its own colour contradiction.

OVER-BUILT, each a removal: the separate needs block for pipeline items, the
agents line on cards whose only agents are their pipeline's stages, the
four-button status bar, and the task title drawn twice. A revision that only
removes these and reuses the desktop's pieces would already be most of the fix.

## 3. What a pipeline row must answer at a glance

| Question | Board card, round 1 | Task screen, round 1 | Desktop today | Required on the phone |
| --- | --- | --- | --- | --- |
| **What stage** | only in prose ("stage 1/2 · build"); the track has no names | four times: needs heading, prose answer, stage bar, meta line | the chain of named pills; the header note (collapsed to 0–11 px, #2077) | the chain, with the current stage named once, never truncated |
| **Is it moving** | "working 18:40" beside a 12:24 status-bar clock reads as a time of day; the agents line repeats it with a second timer ("1 working · now") | a paused pipeline paints its stage in the running colour (task-*, second row) | halo on the running pill; "stages running" chip | a live pulse on the running pill plus an elapsed age with a unit ("18m"); paused and parked read as stopped |
| **What it needs from me** | a badge "needs a decision", no options; a finished pipeline with a merged PR in Assigned says nothing | the answers named in prose ("Retry the build, skip it, or close the lane"), one button that opens another screen | amber state chip; actions behind ⋯; the review-heads line for a spent budget | the reason in one line and, on the task and pipeline screens, the answering actions as 44 px buttons in place |
| **Which PR** | passive text at the far right ("PR #2070 open", "no PR") | "PR #1996" as a task chip and "no PR" on the first pipeline row, one screen apart | chips per pipeline; the task's union with "+n" | chips per pipeline; "no PR" only on the pipeline that has none |

### 3.1 Where one thing is drawn twice

| Surface | Drawn twice | Finding |
| --- | --- | --- |
| `task-*` | the parked pipeline: the needs block and its own row | P1-1 |
| `task-*` | the task's links: "PR #1996" above, "no PR" on a pipeline row | P2-2 |
| `task-*` | the task title: bar and body | P2-6 |
| `board-*` | the stage position: the track and "stage k/n" in the prose | P1-2 |
| `board-*` | liveness: the pipeline line's state and timer, the agents line's "1 working · now" | P2-4 |
| today's pipeline screen | the task: the bar title and the one "Linked tasks" row | P1-4, R6 |
| desktop card (`desktop-card-t-links-*`) | a pipeline created from its task carries the task's title again | §4, header row |

## 4. How the desktop presentation translates to 390 px

The desktop's own narrow form is the best evidence of what does not survive a
phone. At a 700 px window the board is one tabbed column 452 px wide, and the
pipeline header gives the title 92–114 px (about 12 to 15 characters of titles
that need 183–275 px) and the stage note 0 px, in en and uk
(`desktop-narrow-700-*`, `head-measure.json`). A phone card is 366 px wide, so
the header row cannot be copied as it is.

| Desktop element (where) | On the phone | Why |
| --- | --- | --- |
| Header row: title · state chip · note · graph toggle · Stages · ⋯ (`PipelineSection.tsx:226-272`) | Split. The title takes its own line and is omitted where it equals the task title. The note joins the state chip ("needs a decision · Build"). Stages becomes the tap into the pipeline screen, ⋯ its actions sheet; the graph toggle is dropped. | Six things on one line leave the title 92 px at 452 px; the note already vanishes on desktop cards (#2077). |
| Stage pill: tone dot, engine mark, name, effort ladder, rounds count (`PipelineChips`, `PipelineSection.tsx:649`) | Dot, name and the rounds count on the card; the engine mark and effort ladder only on the pipeline screen. A pill that opens a conversation is a 44 px target on the task and pipeline screens (the desktop's own coarse rule, `kanbanBoard.css:607`); on the board card the chain is display-only inside the card's one button. | At 12 px the engine mark and ladder cost about 40 px per pill and answer none of the four questions. |
| `→` between pills | Kept. | It is what makes the pills read as a chain. |
| Tones (`STAGE_TONE`, `pipelineGraph.ts:26`; `.pdot` tones, `kanbanBoard.css:524-528`) | Used verbatim, imported, never restated: running success with a halo, reviewing info, passed success, failed danger, needs_decision warning, pending hollow. Shape as today's phone already does it (check, cross, spinner), with needs_decision moved from the danger cross to a warning mark. | One stage, one colour on every surface. |
| State chip (`.pstate-chip`, `kanbanBoard.css:350-354`) | Kept with its words and colours: running success, needs_decision warning on its soft fill, provisioning dashed accent, completed secondary. | Already the vocabulary the operator reads on the desktop. |
| Fail edge as a return arc (#1798) | The suffix form the desktop itself falls back to when a row wraps (`ReturnSuffix`, `PipelineSection.tsx:630`): "↺ 1/2" on the failing pill, danger when the budget is spent. | A 1 px dashed arc and a 10 px counter are unreadable and untappable on a phone. |
| PR and issue chips per pipeline (#2059) | Kept per pipeline. Passive text on the board card (a link cannot nest in the card's button, `pr-issue-chips.md` §6.4); clickable `WorkLinkRow` on the task and pipeline screens. | They answer "which PR" for the pipeline that owns it. |
| "n completed" fold on a card (`KanbanCard.tsx:502`) | Kept: finished pipelines fold behind their count on the task screen; the board card shows the newest unfinished one. | Done work stays quiet. |
| Review heads line (#1938, `pipelineReviewHeads`, `pipelineModel.ts:147`) | Kept, on the card and the task screen, as the reason line. | It is exactly what the pipeline needs from the operator. |
| Stage report and ranked findings (`StageReportLine`) | Kept on the task screen's decision and on the pipeline screen: severity chip plus the finding's text. | It is what the decision is about. |
| Stages sheet: numbered navigator, graph, one pane per stage (`StagesSheet.tsx`) | The pipeline screen becomes the phone's Stages view: the navigator becomes a numbered stage list with the desktop's pills and tones, the current stage expanded (its latest report, attempts, review rounds, fail edge and "Open conversation ›"); the graph is dropped. | The numbered list is the navigator's natural phone form, and the stage's conversation already has a screen. |
| Card footer status pill "Assigned ⌄" | Adopted on the task screen in place of the four-button status bar. | One control; a tap opens a choice and never moves the task by itself. |

## 5. Findings

Ranked by severity. Each names the mockup and the region; `task-*` means all
four task frames, and so on.

### P1 — changes the design

#### P1-1 · The decision is shown twice and can be answered nowhere on the task screen

**Where.** `task-*`: the needs block ("Build failed · P1 · 1 finding",
"needs a decision", "Open pipeline ›") and the first row under "Pipelines · 2".

**Evidence.** At 390 × 667 the needs block is 142 px tall at y = 267 and the
first pipeline row 89 px at y = 453: 231 px, 35 % of the page, for one
pipeline. The stage's name is printed four times (the heading, the prose "Retry
the build", the stage bar, the meta line; "збірка" four times in uk), and
"needs a decision" twice. The three answers are named in prose, and the only
control is "Open pipeline ›", which pushes a third screen. Today's phone already
answers on the pipeline screen with Skip stage and Retry stage as 44 px buttons
(`phone-pipeline-390-*`, `mobilePipelineActions`, `MobilePipelineScreen.tsx:250-256`),
so round 1 adds a step
where the requirement asks to act from the task.

**Why it hurts.** The operator's most frequent blocking event costs three taps
and a screen of repetition, and the block that looks actionable is a signpost.

**Fix.** A pipeline appears once per screen. Its needs-you state is that
block's own state: amber edge, the reason with the finding's text, and the
actions as buttons in the block (Retry *stage*, Skip *stage*; Pause and Close
under its ⋯), through the same pipeline actions the desktop menu calls
(`usePipelineActions.ts`). The separate needs block stays only for items that
have no other home on the screen: a question or a plan approval from a
conversation.

#### P1-2 · The stage chain is replaced by an unlabelled 12 × 4 px track

**Where.** `board-*`, the second line of every card with a pipeline.

**Evidence.** Each stage is a 12 × 4 px bar with a 2 px gap: 26 px for two
stages and 40 px for three, 7 to 11 % of the 366 px card. No stage has a name,
so the track can only be read through the prose beside it ("stage 1/3 ·
design · working 21:05"), which repeats the count the track draws. In the light
scheme a pending segment is beige on a cream card (`board-light-*`). The
desktop's chain names every stage and colours it by state
(`desktop-card-t-search-*`), and the operator named that chain as what the phone
should build on.

**Why it hurts.** "What stage" is the first question, and the only visual
answer on the card is too small to read and carries no names.

**Fix.** The card's second line is the desktop chain in miniature (§4, R2).
The prose line loses "stage k/n · name", because the chain says both.

#### P1-3 · Two colour mappings for one stage state, and round 1 spreads the wrong one

**Where.** `board-*` tracks and `task-*` stage bars; today's pipeline screen.

**Evidence.**

| State | Desktop pill (`STAGE_TONE`) | Round-1 mockups | Today's phone pipeline screen (`StageMark`, `MobilePipelineScreen.tsx:297-302`) |
| --- | --- | --- | --- |
| running | success with a halo | accent (violet) | accent spinner |
| reviewing | info | accent | accent spinner |
| passed | success | success | success check |
| needs_decision | warning | danger (red "build", red prose) | danger cross, beside an amber "needs a decision" in its own header |

The design system maps `live → success · waiting → warning · returned → accent
· stalled → danger · done → muted` and gives the emphasis to whatever needs
the operator (`docs/design/viewer-design-system.md:203-205`); mobile-v2's
visual language says the same and gives accent to the current stage's edge. On
the round-1 board card green means "passed" in the track and "alive" in
"1 working" on the next line (`board-390-en`, second card). Card 1 carries an
amber edge and badge and a red stage line at once. On `task-*` the paused
pipeline's stage is filled in the running accent.

Round 1 copies today's phone mapping onto the board card and the task screen,
so the contradiction now covers every pipeline surface on the phone.

**Why it hurts.** An operator who moves between the desktop and the phone reads
the same pixel two ways, and the one state that needs them (amber) is
outshouted by red on the same card.

**Fix.** One mapping, `STAGE_TONE`, imported by the phone. A card that needs
the operator is amber throughout; "failed" is a word in its reason. A paused
pipeline draws no stage in a live tone. Today's `StageMark` moves
needs_decision from the danger cross to a warning mark.

#### P1-4 · The pipeline screen is not in the mockups

**Where.** Every pipeline tap in round 1: "Open pipeline ›" and the pipeline
rows of `task-*`, pipeline items under Not on a task, ⋯ › Pipelines.

**Evidence.** The round-1 note routes every pipeline tap to the existing
pipeline screen and does not redesign it, and the 26 frames never draw it.
Today's screen (`phone-pipeline-390-*`) marks the needs_decision stage with a
red cross under an amber header, repeats the pipeline's title as its one
"Linked tasks" row, and shows no chain and no fail-edge budget; findings appear
only when a review verdict failed (`MobilePipelineScreen.tsx:451`). The Stages
view the operator singled out has no phone counterpart.

**Why it hurts.** It is the screen where a pipeline is decided, retried,
skipped and read, which is the operator's reason to open a pipeline.

**Fix.** Redesign it as the phone's Stages view (§4, R6) and mock it in every
pipeline state.

### P2 — should change before the build

#### P2-1 · The stage bars look like buttons and are not

**Where.** `task-*`, the two boxes on each pipeline row ("build" / "review",
"accept" / "review").

**Evidence.** Each is 169 × 22 px, outlined, with a centred label: the form of
a segmented control. Neither is a target; the whole row is one button. Equal
widths say nothing about progress, and at five stages each box would be about
64 px with truncated names. On the desktop a pill with a conversation is a real
button that opens that stage (`PipelineChips`).

**Fix.** Pills, as on the desktop. On the task and pipeline screens a pill with
a conversation is a 44 px target that opens it; a pill without one is drawn
hollow and is not focusable.

#### P2-2 · PR attribution contradicts itself on one screen

**Where.** `task-*`: the link chips "PR #1996 · #1994" under the description,
"no PR" on the first pipeline row, and (visible at 430) "PR #1996" on the second.

**Evidence.** The task-level chips are the union of both pipelines' links; the
pipeline rows show their own. The operator reads "no PR" and "PR #1996" for
the same task without being told which pipeline owns what. The desktop puts
each pipeline's chips in its own section and the union above with "+n"
(`desktop-card-t-many-links-open-*`).

**Fix.** Each pipeline block carries its own chips. The union row appears only
when the task has links no pipeline owns (links attached by hand), and "no PR"
appears only inside the block of the pipeline that has none.

#### P2-3 · Elapsed times read as clock times

**Where.** `board-*`: "working 18:40", "working 21:05", "reviewing 4:12".

**Evidence.** The status bar reads 12:24; "18:40" beside it reads as twenty to
seven. The same cards use "41m" and "done 20m" for other ages.

**Fix.** Card and block ages carry a unit ("18m", "1h 5m"), the form the same
cards already use for "41m" and "done 20m". The running `m:ss` timer stays
where a turn is watched live: the conversation bar.

#### P2-4 · The agents line repeats the pipeline line

**Where.** `board-*`, cards 2 to 4: "stage 2/2 · review · reviewing 4:12"
over "1 working · 2 agents · now".

**Evidence.** The one working agent is the reviewing stage. Each card carries
two timers ("4:12" elapsed, "now" last work) and two liveness signals. The line
costs about 24 px per card; across the three cards that carry it, that is most
of one more card above the dock.

**Fix.** A card whose working agents are all stages of the pipeline it shows
draws no agents line. The line appears for work outside the pipeline, or on a
task with no pipeline.

#### P2-5 · The task screen's status bar looks like the board's tab strip, and it writes

**Where.** `task-*`, the four 89 × 44 px buttons at y = 612.

**Evidence.** On `board-*` the same four labels at the top of the screen are
navigation. On the task screen, in the thumb's resting zone, the same labels
move the task on one tap. The desktop draws a task's status as one pill,
"Assigned ⌄", in the card footer (`desktop-card-*`).

**Why it hurts.** A mode error in the most-tapped zone of the screen, and 64 px
of a 667 px page spent on a control used once per task.

**Fix.** One control in the bottom bar, "Assigned ▾", beside "+ Agent". A tap
opens the four statuses as a sheet; a choice moves the task with the receipt
and Undo round 1 already specifies. The board's long-press sheet keeps Move to.

#### P2-6 · The task title is drawn twice

**Where.** `task-*`: the bar title (truncated) and the body title directly
under it.

**Evidence.** Design-system rule 3, "A title appears once"
(`viewer-design-system.md:245`). The body copy starts directly under the bar's.

**Fix.** The body owns the title; the bar shows the task's context
("Assigned · 3 agents") until the body title scrolls out, then takes the title.
"+ Agent" moves from the Agents header to the bottom bar (P2-5), so it too is
drawn once.

#### P2-7 · Finished work says nothing about what it needs

**Where.** `board-*`, "PR and issue chips…" and "Seat wakes after its own
deploy…" (visible at 430): pipeline completed, PR merged, card still in
Assigned.

**Evidence.** Two of the seven Assigned cards are finished. They draw three
full-green segments and a violet "merged" chip, the brightest marks on their
cards, while needing nothing from any agent. The desktop folds completed
pipelines behind a count and colours the completed chip secondary.

**Fix.** A completed pipeline is one muted line ("✓ completed · #2068 merged ·
20m"), no chain. When every pipeline of a task not in Done is completed, the
card's long-press sheet lists "Move to Done" first.

#### P2-8 · Stalled rows say one state three ways and cannot be told apart

**Where.** `needs-*`, the four rows under "Not on a task · 4".

**Evidence.** Each row is "Codex session" with a red edge, red "stalled 37m"
and a red "stalled" badge, the pattern the mobile-v2 critique ranked P2-2. The
four titles are identical, so the operator cannot tell which to open.

**Fix.** A row's title is its conversation's first prompt line (the rule a
pipeline card already follows); the state is said once, as the badge; the meta
line carries age and model in secondary text.

#### P2-9 · The needs-you pin rule is broken in its own mockup

**Where.** `needs-*`, Inbox.

**Evidence.** The Inbox tab reads ⚠5. One needs-you task card is pinned first;
the other four needs-you items (the stalled conversations) sit below two task
cards that need nothing ("Spend quota before its window resets", "request_attention…"),
because Not on a task is drawn last.

**Fix.** Pinning spans the column: every item that needs the operator, task
card or Not on a task row, comes first in attention order.

### P3 — worth doing in the same pass

- **P3-1 · Stage names are lower-cased** on the card ("build", "review",
  "design") while the desktop and today's phone use the stage's display name
  ("Implement", "Review", `stageDisplayName`). Use the display name.
- **P3-2 · "P1" is jargon without its text** in the task screen's heading
  ("Build failed · P1 · 1 finding"). Use the desktop's findings form: a
  severity chip next to the finding's text.
- **P3-3 · Separators differ by language**: "build · failed" in en,
  "збірка — збій" in uk. Use one separator in both.
- **P3-4 · The stage conversation loses its pipeline** (`jump-*`): the bar
  reads "working 4:12 · Opus 5.5 · xhigh" with no "stage 1/3", which mobile-v2
  §3.2 puts on the meta line of a pipeline's current stage.
- **P3-5 · The mockup data contradicts itself**: the skeletons lane is
  "working 21:05" on the board and "working 4:12" in its own conversation, and
  "4:12" is also the favicon review. A revision reviewed on consistent data is
  reviewed faster.
- **P3-6 · Loading pops in the dock's controls** (`loading-*`): the skeleton
  dock has no "● n" and no mic, so both appear later. Draw their placeholders.
- **P3-7 · The empty column's hint is neither a link nor plain text**
  (`empty-*`, "← Assigned has 51 tasks · 3 working"): make it a 44 px row that
  opens Assigned, or drop the arrow.

## 6. What is right and must stay

- Four status columns, the tab strip with counts and ⚠ and ● marks, the swipe,
  per-column scroll memory.
- Needs-you cards pinned first; the bar's ⚠ as the one queue across columns.
- The orchestrator in the bottom dock with its state line and working count.
- History off the board; Done windowed.
- Titles clamped at two lines on the card, whole on the task screen.
- The card as one button with passive PR text (`pr-issue-chips.md` §6.4), and
  44 px targets everywhere.
- The jump strip in its own row above the composer (`jump-*`): no text can sit
  under it.
- The data fix and the jump strip slices, which need no redesign.

## 7. Recommendations for the revision

Each is a change with a test that proves it. "Frames" means the phone driver
(`src/components/mobile/issue1671Evidence.browser.test.tsx`, gated by
`LLV_SWIPE_BROWSER_TEST=1`) at 390 × 667 and 430 × 735, en and uk, dark and
light, as round 1 §5 already plans; "the pipeline fixture" means the desktop
fixture's pipelines reused on the phone: the eight-stage chain, the parked
decision, the fired and the spent fail edge, the spent review budget, a paused
pipeline, a completed one with a merged PR, five pipelines on one task, and
stage names of 5, 20 and 40 characters (the `balance` scenario).

The shapes, at 390 px:

```
Board card
┌──────────────────────────────────────────────────┐
│▌Mobile data: stop repeated full-board  needs a   │  title ≤ 2 lines; badge only when it needs you
│▌downloads and hidden-tab traffic       decision  │
│▌ (!) Build → ○ Review                     no PR  │  the chain: tone dot + name; PR passive, right
│▌ Build failed · 1 finding · 41m                  │  the reason; age with a unit
├──────────────────────────────────────────────────┤
│ Restore /favicon.ico with the Delegatus emblem   │
│ ✓ Build → ● Review · 4m              #2070 open  │  running: one line, no agents line
├──────────────────────────────────────────────────┤
│ Redesign attachment upload for large files       │
│ ✓3 → ● Build ui · 6m → ○ Review ui +3  #2201 open│  long chain: done count, current, next, +rest
├──────────────────────────────────────────────────┤
│ PR and issue chips on pipelines and task cards   │
│ ✓ completed · 20m                   #2068 merged │  finished: one muted line
└──────────────────────────────────────────────────┘

Task screen, one pipeline parked on a decision
‹  Assigned · 3 agents                          ⋯
Mobile data: stop repeated full-board downloads
and hidden-tab traffic
┌ Stop repeated full-board downloads · needs a decision ┐
│ (!) Build → ○ Review                          no PR   │  pills are 44 px targets here
│ P1  The delta chain is rebuilt on the request thread; │
│     the worker must own it.                           │
│ [ Retry Build ]  [ Skip Build ]  [ ⋯ ]                │  answered in place
└───────────────────────────────────────────────────────┘
┌ Finish mobile traffic acceptance · paused ────────────┐
│ ‖ Accept → ○ Review                       #1996 open  │
└───────────────────────────────────────────────────────┘
Agents · 3
…
[ Assigned ▾ ]                                 [ + Agent ]   bottom bar, thumb reach

Pipeline screen (the phone's Stages view)
‹  Stop repeated full-board downloads          ⚠  ⋯
   needs a decision · stage 1 of 2 · 41m
#1996 · #1994                         Attach PR or issue
(decision block with Retry Build · Skip Build, as above)
Stages · 2
│1 (!) Build    Builder · Opus 5.5 ▂▄▆    needs a decision │  current stage: accent edge, expanded
│      Builder failed · 41m · 1 finding                     │
│      attempts 1 · 2      ↺ Review fails → Build · 1 of 2  │
│      Open conversation ›                                  │
│2  ○  Review   Reviewer · review loop       waiting     ⚙  │
Past attempts · 3 ›
```

**R1 · One pipeline block, used on the card, the task screen and the pipeline
screen.** A component over the desktop's `KanbanPipeline` summary with a
density prop, so the phone reads the same model and words.
*Test:* a DOM test renders the block from the pipeline fixture at each density
and asserts the stage names, the state chip words and the note equal what
`PipelineSection` renders for the same pipeline.

**R2 · The chain on the card.** Tone dot and display name per stage, `→`
between, the rounds count and the "↺ k/n" fail-edge suffix on their pills. When
the chain does not fit one line, finished stages fold into "✓n", then the
current stage, the next stage and "+m" for the rest. The current stage's name
is never truncated.
*Test:* frames with 2-, 4- and 8-stage chains and 40-character names: the chain
is one line, the current stage's text has `scrollWidth <= clientWidth`, and no
text leaves the card.

**R3 · One colour mapping.** The phone imports `STAGE_TONE` and the
`.pstate-chip` states and restates neither. needs_decision is warning on every
phone surface, including today's `StageMark`. A card that needs the operator
draws one status hue; a paused pipeline draws no live tone.
*Test:* a table test over every `StageChipState` and pipeline state compares
the phone's rendered tone class with the desktop's for the same input; a frame
gate reads the computed colours of a needs-you card and finds one status hue.

**R4 · The decision is answered where it is shown.** A pipeline in
needs_decision draws its reason (the latest stage report's first finding with
its severity) and Retry *stage* and Skip *stage* as 44 px buttons inside its
block on the task screen and the pipeline screen, through
`usePipelineActions`. Skip and Close keep today's deferred receipt
(`MobilePipelineScreen.tsx:78-91`): the tap hands the request to the receipt's
four seconds, and its inverse cancels it. No separate needs block exists for a
pipeline item.
The buttons stay inside the block that owns them, so two parked pipelines on
one task each answer in place. In the sketch they sit about 230–275 px down the
667 px page: the upper-middle, a stretch for one thumb at 430. Repeating them in
the bottom bar would bring them into reach at the price of the duplication
P1-1 removes; the ⚠ sheet's Next › stays the one-handed path across decisions.
*Test:* on the task frame the pipeline's title occurs once, the Retry button is
at least 44 × 44 and inside the first 667 px, and a tap sends the same request
the desktop's menu sends for that pipeline and stage.

**R5 · Each pipeline carries its own PR chips.** Passive text on the card,
`WorkLinkRow` on the task and pipeline screens; "no PR" only inside a block
whose pipeline has none; a task-level row only for links attached by hand.
*Test:* over the five-pipeline fixture no screen shows "no PR" outside a
pipeline block, and each block's chips equal that pipeline's resolved links.

**R6 · The pipeline screen is the phone's Stages view.** Bar with the title and
"state · stage k of n · age"; chips; the decision block when there is one; a
numbered stage list in the desktop's pills and tones, the current stage
expanded with its latest report, attempts, review rounds, fail edge (in the
desktop's loop-chip words) and "Open conversation ›"; past attempts collapsed;
"Linked tasks" only when it names a task other than the one the operator came
from. Mocked for needs_decision, running, a review loop with rounds, a fired
fail edge, a spent review budget, paused and completed.
*Test:* frames for each state; the back stack Board → Task → Pipeline → stage
conversation → ‹ ends on the pipeline; every stage row with a conversation is a
44 px target.

**R7 · Finished pipelines are quiet.** A completed pipeline is one muted line
with its merged PR; completed pipelines on the task screen fold behind "n
completed"; the card shows the newest unfinished pipeline and "+n" for other
unfinished ones.
*Test:* a card whose pipelines are all completed draws no chain and no success
or accent colour; a task with three completed and one running pipeline shows the
running one.

**R8 · Cards carry no second liveness line.** No agents line when every working
agent is a stage of the shown pipeline; ages carry units on cards and blocks.
*Test:* the card for a single running pipeline is at most 74 px tall with a
one-line title; no card text matches `^\d{1,2}:\d{2}$` as an age.

**R9 · The task screen's order and controls.** Title once (bar context until
the title scrolls out); the pipeline blocks right after the title, the
description collapsed under them; one "Assigned ▾" control and "+ Agent" in
the bottom bar.
*Test:* at 390 × 667 with the reference task (a decision, a paused pipeline,
three agents) the decision's buttons, both pipeline blocks and the Agents header
are in the first 667 px; the title's text node is visible once; no bottom-bar
tap changes the task's status without a sheet choice.

**R10 · The pin spans the column.** Everything that needs the operator comes
first in attention order, task cards and Not on a task rows alike.
*Test:* in the needs fixture the first five Inbox items are the five the tab's
⚠5 counts.

**R11 · Rows name themselves.** Conversation rows title themselves with their
first prompt line and say their state once.
*Test:* the four stalled fixture rows have four distinct titles; each row
contains the word "stalled" once.

**R12 · The revision is reviewed on realistic data.** The mockups and the
frames use the pipeline fixture above, with ages consistent across screens.
*Test:* the revision's frame list covers every state in R6 and every chain
length in R2, en and uk, dark and light.

## 8. Deferred — not currently justified

- **The stage graph on the phone.** The desktop's graph toggle and the Stages
  sheet's graph are dropped; the numbered list says the order, and the fail
  edge rides its pill. Nothing in the requirement asks for a graph at 390 px.
- **Return arcs drawn as arcs.** The suffix carries the same count in a form a
  thumb can read.
- **Stage panes swiped side by side, each holding its conversation.** The
  desktop sheet does this at 1440 px; on the phone the stage's conversation is
  one tap away on its own screen, with the back stack already specified.
- **Engine marks and effort ladders on the card's chain.** They stay on the
  pipeline screen, where the operator chooses a stage's runtime.
- **A new shape for a passed stage on the desktop.** The phone's check mark
  already exists in today's `StageMark`; changing the desktop's dot is a
  separate question nobody has asked.
- **Deciding a pipeline from the board card itself.** The card is one button,
  and nesting actions in it breaks that rule; the task screen answers in one
  tap after the card, the same count as today's queue row.

## 9. Validation against the requirement

| The requirement and the verdict say | This critique |
| --- | --- |
| "Pipelines must be very convenient on the phone" | P1-1 to P1-4; R1 to R7: one block, answered in place, the chain readable, one colour mapping, the pipeline screen redesigned |
| "build on the desktop: group header, stage pills and chain, the Stages view, PR and issue chips" | §4 maps each desktop element to its phone form, with what is kept, changed and dropped and why |
| the task-screen example: equal stage bars, the meta line, the needs block repeating the pipeline | P1-1, P2-1, P2-2; R4, R5 |
| "what stage, is it moving, what does it need from me, which PR" | §3, answered per surface; R2, R3, R4, R5, R8 |
| "sees where every piece of work stands … acts from there … with one hand" | R4 answers a decision where it is shown, two taps from the board (its reach trade-off is stated there); R9 puts the status and "+ Agent" in the bottom bar; R10 keeps what needs the operator on top |
| "also cover anything else that is weak" | P2-3 to P2-9, P3-1 to P3-7 |
| "concrete, testable recommendations" | §7, each with its test |

## Appendix: defects filed while doing this

- #2077 — the desktop pipeline header's stage note is 0–11 px wide on every
  normal card at 1440 px (needs 13–52 px) and 0 px at the 452 px tabbed
  board, where titles get 92–114 px (`kanbanBoard.css:334`, `flex: 0 4 auto`).
  The phone's split header (§4) avoids it; the desktop needs its own fix.
- #2078 — the Delegatus MCP server tells every agent its conversation is linked
  to a board task, and a pipeline stage that follows the instruction is refused
  with "the calling conversation is not linked to a task".
