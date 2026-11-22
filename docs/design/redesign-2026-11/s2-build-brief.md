# S2 build brief: the Stages window as tabs (variant 3)

## Originating requirement

On 2026-11-20 the operator chose how to rebuild **S2, the pipeline's Stages
window**, in the decision-form round on the redesign task, after the prototype's
third round passed the visual critic: build **variant 3, "stages as tabs over
one stage"**, as drawn. In the same answer the operator added a voice comment.
Paraphrased: a little more is wanted. Consider the visual critic's fix stage.
When a lane has a review and a fix, the fix is not a mandatory step, yet the
window shows it beside the review as if it were the next one. There may be some
branching, though the operator doubts lanes have much of it. Think through the
other cases the lanes have actually had. Otherwise the design is fine.

The pinned outcome for this lane says the following. The real Stages window, on
the desktop and the phone with one design, shows the lane's stages as tabs as in
variant 3. It is built on the product's own components with real pipeline data.
It must render every graph shape real lanes have:

- an optional fix stage reached only on a review's fail edge, shown as
  conditional and not as a mandatory step;
- review/fix loops with their round counts and budget;
- a visual-critic gate with its fix stage;
- the prototype lane (prototype → critic → proto-fix → publish);
- the terminal re-check;
- skipped and parked stages;
- single-stage successor lanes;
- lanes of eight or more stages;
- which stage and which agent the lane waits on.

Every function the window offers today stays reachable. The operator's standing
design rules apply: no liquid glass; a status is a small dot with a short
popover; no new chrome where an existing control fits; no rows of identical
cards; one obvious primary action. Rendered evidence comes only from the
existing drivers.

Source: the prototype at commit `c521b9fc` (`docs/design/redesign-2026-11/prototype/s2.tsx`,
`prototype.css`, `README.md`, `names.ts` on the prototype lane's branch) and its
round-3 frames and `manifest-round3.json` in that lane's evidence directory.

## 1. What variant 3 is (prototype `c521b9fc`)

The prototype draws the product's real `KanbanBoard` → `StagesSheet` and
rearranges it with stylesheet rules scoped by `body[data-s2-variant="3"]`. It
adds three new pieces of markup: the waits-on line, the neutral loop rule and
the phone's ⋯ sheet. Read from the source and from the frames `s2-v3-*`
(1440 × 900, 820 × 900, 390 × 844):

| Prototype element | Where in `c521b9fc` | What it does |
|---|---|---|
| Head: «Пайплайн» badge, title that wraps | `prototype.css` rule on `header h2` (`white-space: normal`) | The title is never cut |
| Waits-on line: dot + «Етап 4 з 8 · чекає на Білдера (Build ui)» | `s2.tsx` `WaitsOn`, `.s2-waits`, `.s2-waits-dot` | Replaces the head's `.pstate-chip` and `.progress` (both hidden). It is a button: tap or click opens the popover, Escape closes it |
| Popover row: «Етапи виконуються. Білдер працює над Build ui 1 год 4 хв; далі — Review ui.» | `.s2-pop` (`order: 30; flex: 1 0 100%`) | Takes a row of its own in the head, so the tabs move down and nothing is covered |
| Tabs: number, model glyph, name; the open tab has the accent underline and weight 700; finished tabs keep the check badge; waiting tabs are lighter | `prototype.css` variant-3 block over `.gs-nav .navchip` | The product's chip strip restyled as tabs. Model words (`.imodel`) and the effort ladder (`[data-effort-pills]`) are hidden |
| Below 1100 px: a grid of 4 columns | `@media (max-width: 1099px)` | All eight tabs are whole at 820 and 390 |
| Below 700 px: two-line tabs (`✓1` / name, `●4` / name) | `@media (max-width: 699px)` | ✓ = passed, ● = current |
| Loop rule under the tabs: «↺ Якщо Verify не пройде → назад до Build ui · 0 з 2» | `s2.tsx` `LoopNote`, `.s2-loop` | Replaces the red `LoopChip` (hidden): no failure is reported before Verify has run |
| One stage under the tabs, full width | `.lane > .pane:not(.focus) { display: none }`, `.pane { --pane-w: auto; flex: 1 }` | The other panes and the connectors are hidden |
| «Згорнути завершені», «Розгорнути всі», each pane's fold | hidden | They only ever saved width (README) |
| ‹ ›, «Граф», ×, pane ⋯, «Відкрити агента», the reader with its composer, waiting stages' first messages | unchanged | Kept |
| Graph | pressed off on the desktop at open | Tabs are the default navigation at every width |
| Phone | the same sheet at 390 px; ⋯ in the head opens a bottom sheet: Пауза, Закрити конвеєр, Змінені файли, Перевірки, Меню дошки, then Прикріпити PR або issue…, Пов'язані задачі 1, Попередні спроби 3, caption «Налаштування етапу: відкрийте етап і його меню ⋯.» | `s2.tsx` `MoreMenu`, made of the product's `MobileSheetRow`s | Today's phone screen functions, reached from one ⋯ |

The prototype lane has one loop only, a return from Verify to Build ui. It has
no docked fix stage, no visual critic, no skipped, parked or single stage, so
the frames do not show the cases the operator asked about. §3 and §4 cover them.

## 2. Mapping onto the real components

| Prototype piece | Real component today | Build change |
|---|---|---|
| Sheet shell, scrim, dialog, Esc, focus return | `src/components/kanban/StagesSheet.tsx` `StagesSheet` (lines 205–347), mounted by `KanbanBoard.tsx` (lines 3054–3083) | Unchanged on the desktop. A new prop `presentation: "sheet" \| "screen"` lets the phone render the same component without scrim, dialog role, title or × (the phone bar carries them) |
| Head title | `<h2>` in `StagesSheet` line 229, `.gsheet header h2` in `kanbanBoard.css:1726` (nowrap + ellipsis) | Wraps (`white-space: normal`), as the prototype rule did |
| Head state pill + progress | `.pstate-chip` + `.progress` (`pipelineProgress`, `PipelineSection.tsx:145`) | Replaced in the sheet by the waits-on line (§5). `pipelineProgress` stays for the card |
| Waits-on dot + popover | new in the prototype | Reuse the dot of `CardStateDot` (`CardStateLine.tsx:117`, `.card-state-dot[data-owner]`) and its owner model `laneState` (`cardState.ts:57`). The popover is an in-flow row of the head, as in the prototype. It does not use the floating `TooltipBubble`, so it covers nothing |
| Lane bar | `.lane-bar` with Collapse finished, Expand all, ‹, › (`StagesSheet.tsx:235–240`) | Keeps ‹ › only |
| Graph toggle + zoom | `[data-sheet-graph]`, `.zoom` | Unchanged. The default becomes off at every width (today it is on at ≥ 700 px, line 99), except when the sheet is opened from a lane's «Граф» (`initialGraph`) |
| Tab strip | `<nav className="gs-nav">` of `.navchip` buttons (lines 260–287) with `LoopChip`s | `role="tablist"` of `role="tab"` buttons, in the order of the new pure `stageTabs()` (§3.2), not `graphOrder`. Conditional stages are drawn as subordinate tabs (§3.3). `LoopChip` leaves the sheet; rule lines take its place (§3.4) |
| Panes | `.lane` of every `StagePane` with `PaneSlot` connectors (lines 313–344) | One `role="tabpanel"`: the selected stage's `StagePane` only. `PaneSlot`, `.lane-conn`, the folded branch of `StagePane` (lines 400–411) and `data-pane-fold` are removed |
| Selection | internal `focus` state; a chip calls `open(stage)`, which scrolls and then `onOpenStage`, opening the agent window over the sheet (line 139) | `selected` is lifted to the board (`SheetTarget`). A tab, a graph node, ‹ › and the arrow keys select only. The agent window stays one press away through the pane's «Відкрити агента» (`data-open-conversation`) |
| Readers in panes | `KanbanBoard.tsx:654–665` computes a `readerKey` for every unfolded pane, and `readerViews` mounts a reader for each | A `readerKey` only for the selected stage's pane. `paneFolds`, `foldPanes`, `onFold` and `onFoldMany` are removed |
| Pane | `StagePane` | Kept: head, ⋯, sub line, place line, question, «Відкрити агента» or cloud link, attempts, rounds, setup, memory cap, body. Added: `AnswerReport` (exported from `PipelineBlock.tsx:406`) on the stage the lane stopped on; a «повторна перевірка» label on an attempt activated by `budgetRecheck` |
| Phone screen | `src/components/mobile/MobilePipelineScreen.tsx` (`PipelineBlock density="screen"` + sections) | Body becomes `StagesSheet presentation="screen"`. The bar meta line becomes the waits-on line. The bar's existing ⋯ sheet gains the prototype's rows (§6). The selected pane mounts its conversation through a `ReaderPlacement` owned by this screen with one `ReaderPortals` entry |
| Prototype stylesheet rules | `prototype.css` variant-3 block | Become product classes in `kanbanBoard.css` (`.gs-tabs`, `.stab`, `.stab-cond`, `.gs-rule`, `.gs-waits`, `.gs-waits-pop`), not body-scoped overrides |

## 3. Survey of real lane graphs

### 3.1 Method and what it found

- I took a read-only snapshot of every lane record in this installation: 3,930
  lanes (open, completed and closed) at 2026-11-20 17:37 UTC. I opened the state
  database read-only from a scratch script, because the compact
  `list_pipelines` / `get_pipeline` rows carry no `next` or `onFail` edges. I
  confirmed every lane cited below through `get_pipeline` / `list_pipelines`
  compact reads (stage ids, roles, latest attempt states).
- I ran the product's real pure functions (`graphTopology`, `graphOrder`,
  `summarizePipeline`) on the snapshot's stage graphs in a scratch export of
  `22d316fb`.

| Shape | Lanes | Notes |
|---|---:|---|
| Single stage | 581 | successor lanes (integrate, fix, verify, review, design, audit…) |
| Linear, no fail edge | 153 | 2–5 stages |
| Docked fix: a stage reached only by one fail edge, which passes back to its source, on, or nowhere (`loopShapes` = `dock`) | 2,671 | the dominant shape: build → review ⤳ fix → review |
| Return to an earlier stage of the pass chain | 589 | verify ⤳ build, critique ⤳ design, review ⤳ audit3 |
| Fail-only stage that is **not** docked (shared by several fail edges, or passing to a stage other than its source) | 247 | review ⤳ fix and visual ⤳ fix with one fix; visual ⤳ visual-fix → review |
| Retry in place (self loop) | 3 | 2026-10-01 only |
| A stage unreachable from the first stage | 38 | graph-edit leftovers |
| Two or more fail edges in one lane | 492 | up to 4 |
| Eight or more stages | 47 | the maximum in this installation is 8 |
| Lanes by exhaustion mode of their fail edges | — | an `advance` edge (explicit or default) 3,039, a `park` edge 273, a `stop-after-fix` edge 19 |
| Attempts: skipped 183 lanes, needs_decision 1,214, failed 2,049; a budget-spent handoff 1,033; a terminal re-check 368 | — | |

**The operator's branching question, answered from the records.** A stage has
exactly one `next`, so the pass graph never forks. Every non-linear part of a
real lane is one of these:

1. a fail edge (docked fix, return, shared fix, retry in place);
2. a stage left unreachable by a graph edit;
3. a conditional chain of two stages behind a fail edge (`fix-api → fix-web`
   in b9121379 and four more; `backend-fix → ui-fix` in 0c3d0ae7;
   `ci-fix → ci-review` with its own loop back to ci-fix in a95383b5).

Two stages share one `next` outside a fail-only stage in 19 lanes. In 12 of
them one of the two is an orphan a graph edit added (`opus-fix → review` in
fe0ae55e, `opus-prototype → critic` in b8bd7405). In the other 7 it is the
tail of one of those conditional chains.

**A defect the tab strip would expose.** `graphOrder` lays the stages out by
graph layer. A fail-only stage that is not docked has no incoming pass wire, so
it becomes a root at layer 0 and sorts before the stage whose failure reaches
it. In c953029d the order is `brief > fix > build > review > visual`. In
7e84548f it is `brief > visual-fix > build > review > fix > visual`. In
cb6d341d it is `build > fix > slice-fix > operator-amend > …`. 231 lanes have a
fail-only stage ordered before every one of its sources. Today's chip strip
already draws this order. Tabs read as a sequence, so the tab strip must not
use `graphOrder` (§3.2).

### 3.2 Tab order: `stageTabs()` (new, pure)

`src/components/kanban/stageTabs.ts` (new) turns a `KanbanPipeline` into the
tab model. It reads only the record and the summary the board already
computes.

1. **Steps.** Walk `next` from `pipeline.stages[0]`, where the engine starts a
   lane (`store.ts:1581`, `engine.ts:15250`), until a stage repeats. These
   stages are numbered 1…k in that order.
2. **Conditional stages.** These are stages reached from a step only through a
   fail edge, followed by their own pass edges while those stay off the steps
   (this covers fix chains). Each one is anchored to the earliest step, in step
   order, among the steps whose fail edge reaches it. It is unnumbered.
3. **Detached stages.** All other stages, in declared order, unnumbered, after
   the last step.
4. **Units.** A unit is one step followed by the conditional stages anchored to
   it, in chain order. The tab order is units in step order, then the detached
   stages.
5. **Rules.** `stageTabs()` returns one entry per fail edge: source, target,
   shape (`loopShapes`), fired and max (`edgeRoundsUsed`, `failEdgeMaxRounds`),
   exhaustion mode (`failEdgeExhaustion`), and whether the edge is carried by a
   conditional tab. An edge is carried by a tab when its target is a
   conditional stage reached by that one edge only.

Numbers in the waits-on line («Етап n з m») count steps. A conditional stage
the lane stands on reads as its unit's number.

### 3.3 How a conditional stage looks

A conditional stage is a **subordinate tab inside its source's unit**. It is
the same rule the graph already applies to a docked fix: a strip under its
source with no column of its own (`docs/design/pipeline-graph-loops.md` §3.1–3.2).

- **One line (while it fits):** right after its step tab, in the same row:
  `↺ Fix` in caption size, weight 500, muted ink, no number, followed by the
  fix's own `RoundDots` (`PipelineSection.tsx`). Selected, it takes the accent
  underline like any tab. The sheet measures the one line and turns it into the
  grid below only when it would overflow, at any width from 700 px up.
- **Grid (a line that would overflow, and every phone):** a grid cell is a unit, not a stage. The
  step tab is the cell's first line; each conditional tab is a second line in
  the same cell (min 28 px, or 44 px under `pointer: coarse`). A lane with
  build, review + fix, visual + vfix therefore takes one row of four cells, not
  two rows of six.
- **Words** (visible in the tab's `title`, `aria-label` and the pane; the dots
  carry the count):
  - The lane can still reach it and it never ran: «за потреби» / "if needed".
    It never reads «чекає», which would imply a mandatory next step.
  - The lane ended and it never ran: «не знадобився» / "not needed".
  - It ran: its own state word (`graphStateWord`).
  - The title sentence is the existing `arcTitle` (rest, fired, spent, parked
    here, running now).
- A shared or chained conditional stage names every source:
  «лише якщо Review або Visual не пройде». It shows no dots. The rule lines
  under the tabs carry each edge's budget (§3.4).

### 3.4 Rule lines (the prototype's neutral loop line)

There is one line per fail edge **not** carried by a conditional tab, and one
for a carried edge whose budget is spent (no dot says in words where the lane
went), under the tabs, in muted label text with a leading `↺`. Every state
reads in one grammar, «Якщо Review не пройде → Fix api · 1 з 2» (`ruleRest`,
`ruleOn`, `ruleRetry`). The technical sentence of the graph strip's tooltip
(`kanban.loopTitle`, «Ребро невдачі: …») never reaches a rule line, and who is
running now is said by the waits-on line and the pane, not repeated here.

| Edge state | Line |
|---|---|
| At rest, fired | the grammar above, with fired and max |
| Spent | the grammar, then a short clause for what the budget did (`ruleEnd`: the lane goes on, waits for you after the fix, one more failure stops it, or stopped here) |

One rule for the rounds of a fail edge, on every surface. The failing stage's
own tab wears the card's `↺ n/max` once its edge has fired (`ReturnSuffix`), in
every lane. The fix's tab, and the graph row under its source, draw only the
fix's own rounds (`fixRoundMarks`): one mark for each round of the budget, ✓ a
round whose fix passed, ✕ one whose fix failed, ● the fix at work, ○ a round
left; the tab adds the count in digits, so a round reads without its colour. A
tab and a graph row of one edge therefore show the same marks, and no ✕ stands on
the name of a stage at work.

When the source stage's pane shows such a line, the pane drops the
`kanban.stages.onFail` clause from its sub-line, so the fact is said once. A
docked edge keeps the clause in its source pane, because its tab shows only
dots.

## 4. Every shape and how the window shows it

Lane ids are records in this installation. Stage names are the lanes' stage ids
as `stageNames` renders them. «n/max» below are fired/max of the fail edge.

### 4.1 Optional fix on a review's fail edge (docked)

- **Not taken:** 2b3e7241 (completed: build ✓, review ✓ on the first attempt,
  fix never ran; the merge waits for checks).
- **Taken once:** 151999a6 (running: review failed, fix passed, the head is
  publishing).

Tabs: `1 Build  2 Review ↺ Fix ○○`. In 2b3e7241 the subordinate tab reads
«Fix · не знадобився» and its marks stay hollow. In 151999a6 it reads
«Fix · пройдено» with one ✓ and one ○ (1 of 2 rounds used; Review has not passed
since) and Review's tab wears `↺ 1/2`. No rule
line, because the tab carries the edge. The default selection follows
`currentStageId`: the live or decision stage, else the last started.

### 4.2 Review/fix loops with rounds and budget

- 7c2a7b9d: review fail, decision, fail, pass; fix pass, pass; budget 3.
- b5153269: the critic failed twice and spent its budget of 2; the second
  proto-fix attempt was the `budgetSpent` handoff, and the lane advanced to
  publish.
- 4cefc543: park; the critic failed three times and publish never ran.
- 375adbfb: stop-after-fix; the lane waited in `needs_review` (2026-10-22).

The step tab's glyph badge shows the source's latest state, and `stageViews`
already folds a failed source the lane will re-run into pending-again; the
source's tab wears `↺ n/max` from its first failure. The subordinate fix tab
carries `RoundDots` of its own rounds: ✓ for a round whose fix passed, ✕ for a
failed one, ● for the fix at work, ○ for rounds left, one mark per round of the
budget. No hollow mark left means the budget is spent. Above six rounds it
shows `n/max` as text, as the graph strip does. The attempts row in each pane
keeps every attempt («Спроба 1 · не пройдено» …).

### 4.3 Visual-critic gate with its fix

- df09d323 (this lane): review ⤳ fix → review, review → visual ⤳ vfix → visual,
  both advance. The tabs are
  `1 Brief  2 Build  3 Review ↺ Fix ○○  4 Visual ↺ Vfix ○○`, four cells and one
  grid row on the phone.
- 12450964: review ⤳ fix with budget 2 and visual ⤳ ui-fix with budget 1, park.
  Both fixes ran; the visual critic failed twice and the lane was closed.
- 7e84548f: visual ⤳ visual-fix → **review**, so it is not docked. It is
  anchored after Visual: `… 4 Visual ↺ Visual fix`. Its title reads «лише
  якщо Visual не пройде; далі знову Review», and a rule line carries the
  budget. Today's `graphOrder` puts visual-fix second, which is the defect
  in §3.1.

### 4.4 Prototype lane

- b5153269: prototype → critic ⤳ proto-fix → critic, critic → publish, budget 2,
  advance. Completed after the spent handoff.
- 4cefc543: the same graph with park; publish never ran.
- b0c63c07: a successor that starts at critic, budget 1.

Tabs: `1 Prototype  2 Critic ↺ Proto-fix ●●  3 Publish`. In 4cefc543 Publish
reads «чекає» while open; once closed, Publish has no attempt and reads by the
lane's end.

### 4.5 Terminal re-check

- 2b4facd9: review is the last stage with budget 1. Fix ran on the spent
  handoff, review's second attempt was the `budgetRecheck` and passed. Completed
  and merged.
- e6e9e858: the re-check failed twice and `reviewPending.terminalRecheck` was
  set. Closed.
- fc67aa57: open, `needs_decision` («budget spent … failed terminal re-check»).

Tabs as in §4.1. The review pane's attempt activated by `budgetRecheck` is
labelled «Спроба 2 · повторна перевірка · пройдено». Today it is a plain
attempt, so the re-check is invisible. When it failed, the waits-on line says
«чекає на вас: рев'ю «Review» вичерпало раунди» (`cardState.why.review`), and
the review pane shows the `ReviewStopReport` through `AnswerReport`.

### 4.6 Skipped stages

- 8c8a6012: the last stage, deliver, was skipped.
- cb6d341d: build and review were skipped.
- f089ed22: review's second attempt was skipped.
- b00c3b23: final-fix was skipped after the spent handoff.

Today skipped draws exactly like waiting: `STAGE_MARK.skipped = "ring"`,
`GLYPH_STATE.skipped = "waiting"`, `STAGE_TONE.skipped = "idle"`. The tab adds
a visible `↷` mark before the number at every width, and the word «пропущено»
in its `aria-label` and in the pane head. A conditional tab whose stage was
skipped (b00c3b23 final-fix) shows `↷` too.

### 4.7 Parked and needs_decision

- 9fcd797e and c953029d: the build attempt is `needs_decision` after a launch
  failure; the cursor is spawning. The build tab gets the `!` badge and is
  selected at open.
- 14b37d65 (single stage) and daaf2d8d: the stage **passed**, but the lane is
  `needs_decision` because publication was refused. The tab shows ✓. The
  waits-on line names the stop («чекає на вас: гілку не вдалося опублікувати»,
  `laneStopWhy` → `cardState.why.publish`). A line derived from the chips
  alone would say «готово», which is the broken branch the test must catch.
- cb6d341d: park after an exhausted budget at slice-critic. The rule line leads
  with «Раундів не лишилося · Slice-critic знову не пройшов, і пайплайн
  зупинився тут».
- 375adbfb: `needs_review` after stop-after-fix; Verify carries the `!` badge
  (`stageChipState`).
- 7e84548f: paused while waiting for host termination.

The parked stage's pane shows `AnswerReport` (the stop's reason and findings,
which the phone shows today in `PipelineBlock`'s current-stage row) in place of
the bare question paragraph. Retry and Skip stay in the pane's ⋯ for that stage
(`KanbanBoard.tsx:1743`). Answers that apply to the whole lane (accept as is,
retry merge, leave open) stay in the card's ⋯ on the desktop and in the bar's ⋯
on the phone. A parked pane offers its one primary action as a visible control
and nothing more: a Retry button for a stop that needs a retry (the same
`retry-stage` request its ⋯ sends, in the stop's own words for a review stop), and
for a stage that asked a question a pointer to the conversation's composer, whose
placeholder reads as an answer's. Skip stays in the pane's ⋯.

### 4.8 Single-stage successor lanes

- 45307ccb: integrate; waits in the CPU queue.
- 10f27897: integrate; attempt 2 running.
- 407f67c9: fix; six attempts, the sixth starting after a restart.
- 14b37d65: §4.7.

There is no tab strip: one tab would repeat the pane head. ‹ › are hidden.
«Граф» stays. The waits-on line drops «Етап 1 з 1» and says the rest, for
example «Integrate · чекає черги CPU · 1-й · …». The pane's attempts row wraps
six attempts in 407f67c9.

### 4.9 Eight-stage lanes (the maximum observed)

| Lane | Steps | Conditional | Detached | Cells |
|---|---|---|---|---|
| aef6dba5 | rewrite, check, deliver, pk-refresh, pk-check, pk-deliver | ↺ fix (check), ↺ pk-fix (pk-check) | — | 6 |
| 3f714a03 | brief, api, web, integrate, review, visual, recheck (declared order differs: integrate is declared after visual) | ↺ fix after Review, sources Review, Visual, Recheck (3 rule lines) | — | 7 |
| cb6d341d | build, operator-amend, review, integrate, slice-critic, publish | ↺ slice-fix (slice-critic, publish) | fix | 7 |
| b00c3b23 | b1-transcription, b2-codex, review, b3-caller-audio, final-review | ↺ fix, ↺ final-fix | rate-fix | 6 |

At ≥ 1100 px the units stay in one row and wrap to a second row rather than
scroll or cut a name. Below 1100 px there are 4 columns and 2 rows. A name
longer than its cell («B3 caller audio») wraps inside the cell and is never
ellipsized. More than 8 units would wrap to a third grid row. This installation
has none (§8).

### 4.10 Shapes found beyond the brief's list

| Shape | Example | Tabs |
|---|---|---|
| Return to an earlier step | f089ed22 (review ⤳ audit3, park); a01b3c1c (fix → review ⤳ fix, fix is step 1); the prototype's Verify ⤳ Build ui | No extra tab. A rule line; once fired, the source tab shows `↺ n/max` as the card's `ReturnSuffix` does |
| Shared fix | c953029d, 3f714a03, cb6d341d | §3.3: anchored after the first source, every source named, one rule line per edge |
| Conditional chain | b9121379 (fix-api → fix-web, fix-web also visual's target); a95383b5 (verify-ci ⤳ ci-fix → ci-review → verify-ci, ci-review ⤳ ci-fix) | All subordinate in the first source's unit, in chain order; an edge between two conditional stages gets a rule line |
| Detached stage | b4ce18d7 (recheck), b00c3b23 (rate-fix), 6ebc867d (review2 → review3), ff0a777b (critic → deliver unreachable after a last build) | Unnumbered tabs after the steps, title «поза ланцюжком» / "off the chain", the word «не запускався» once the lane ended |
| Retry in place | 26fd3958 (dev-upgrade ⤳ itself, budget 2) | Rule line «… → повтор · 0 з 2» |
| Cloud stage | 7f45243c (claude-cloud, single stage) | The pane's existing «Відкрити хмарну задачу» link |
| Paused | 7e84548f, 9286c742 (paused while provisioning) | The cursor stage keeps its live tone (`pipelineCursorActive`); the waits-on line says why (§5) |
| Provisioning, no attempt yet | 854dacfe | All tabs pending; waits-on «готується робоче дерево · жоден етап не почався» |
| Draft made from a conversation | none in the snapshot; code path `conversationDraftLane` | `AddStageControl` stays after the tab strip; the first stage's pane holds its editable first message (`StageDraftFeed`); the phone keeps its Start dock |
| Legacy `review-loop` stages, adopted helper attempts | 0 lanes in the snapshot | Code paths kept (`rounds`, `operationalAttempts`); no evidence case |

### 4.11 Stage states on a tab

| State (`StageChipState` / view) | Tab at ≥ 700 px | Tab below 700 px | Word (aria, pane) |
|---|---|---|---|
| pending | glyph, lighter ink | number | чекає |
| pending again (`view.again`) | as pending | as pending | чекає · востаннє … (`kanban.graph.lastWas`) |
| running / reviewing / committing | glyph in motion (`stageGlyphMotion`), weight 600 | `●` | працює / рев'ю / фіксує |
| passed | check badge | `✓` | пройдено |
| failed | cross badge | `✕` | не пройдено |
| needs_decision | `!` badge, warning ink | `!` | потрібні ви |
| skipped | `↷` before the number | `↷` | пропущено |
| conditional, not reached | `↺` subordinate, muted | `↺` | за потреби |
| conditional, lane ended unused | `↺` subordinate, muted | `↺ –` | не знадобився |
| detached | unnumbered, muted | unnumbered | поза ланцюжком |
| selected (any) | accent underline, weight 700 | accent underline | `aria-selected="true"` |

Colour is never the only difference: each state has a distinct mark or word,
and the badge shapes come from the existing `STAGE_MARK`.

## 5. Whom the lane waits on

`laneWaitsOn(t, summary, nowMs)` lives in `stageTabs.ts`. It returns
`{ owner, words, detail, stageId }`. The owner comes from the existing
`laneState` (`cardState.ts:57`): you, seat, working, waiting or done, which also
selects the dot colour. The stage is `screenCurrentStageId`, else the cursor
stage. The words reuse the existing phrases:

| Situation (lanes open at the snapshot) | Owner | Words | Popover |
|---|---|---|---|
| A stage agent works: 10f27897, 0814d849 (fresh attempt after a restart) | working | «Етап n з m · чекає на {роль у знахідному} ({stage})» — new role-accusative keys (Білдера, Рев'юера, Архітектора, Верифікатора, Критика вигляду, Мерджера, Прод-аудитора, Клінера, Деплоєра), falling back to «на агента етапу» | «Етапи виконуються. {Роль} працює над {stage} {тривалість}; далі — {next step}.» (the prototype's sentence) |
| The passed stage is publishing: 151999a6, e6afb984 (automatic retry 2/3 at a time) | working, or waiting with `retryAtMs` | «Етап n з m · публікується результат {stage}», or `cardState.waiting.retry` | the `stateDetail`'s first sentence |
| CPU queue: 45307ccb | working | `kanban.progress.cpuQueue` / `cpuPressure` / `cpuQueueStalled` (`parseCpuQueueDetail`) | the same, with the priority |
| Provisioning: 854dacfe | working | `kanban.progress.provisioning` | — |
| Provider wait | waiting | `pipelineReason` provider sentences (`pipelineBlock.provider.*`) | the resume time |
| Decision for the operator: 9fcd797e, 14b37d65, cb6d341d | you | `cardState.you.lane` with `laneStopWhy` | `cardState.popover.you` + age |
| Decision the seat handles (`route.owner === "seat"`) | seat | `cardState.seat.lane` | `cardState.popover.seat` |
| Escalated to a decision form | you | `cardState.you.form` | — |
| Unreviewed fix (`needs_review`): 375adbfb | you | `cardState.why.unreviewed` | `pipelineBlock.reason.review` (heads) |
| Failed terminal re-check: fc67aa57 | you | `cardState.why.review` | `ReviewStopReport` sentence |
| Paused: 7e84548f, 21f1083b | waiting | «На паузі · {reason from `pipeline.pause` / `stateDetail`}» | who paused it and when |
| Completed, merge waits for checks: 2b3e7241 | waiting | `cardState.waiting.checks` | — |
| Completed or closed: 2b4facd9 | done | `cardState.done.*` | the unreviewed-fix note (`pipelineCompletedUnreviewed`) and the finish flag when they apply; both live in today's phone `PipelineBlock` |

## 6. Every current function, and where it is after the change

**Desktop sheet**

| Today | After |
|---|---|
| Title, «Пайплайн» badge, ×, Esc, scrim click, focus return | unchanged; title wraps |
| State pill + progress words | waits-on dot + line + popover (§5) |
| «Згорнути завершені», «Розгорнути всі», pane fold, folded spines | removed; one stage at a time leaves nothing to fold. The operator chose them away with variant 3 (prototype README: "Variants 2 and 3 … drop «Згорнути завершені», «Розгорнути всі» and each pane's fold, which only ever saved width") |
| ‹ ›, arrow keys on the lane | ‹ › and Left/Right/Home/End on the tab list step through the tab order |
| Chip opens the stage in the agent window over the sheet | a tab selects the stage in place, at full width; «Відкрити агента» in the pane still opens the window |
| Chip engine mark + effort ladder (#1743) | hidden on tabs as drawn; the selected pane's reader header and every tab's `title` (`identityTitle`) still say who runs each stage |
| `LoopChip`s | rule lines (§3.4) and conditional-tab dots (§3.3) |
| Graph, zoom, node opens the stage | graph off by default; a node selects its tab's stage |
| `AddStageControl` (conversation drafts) | unchanged, under the tab strip |
| Pane: ⋯, sub line, place line, question, «Відкрити агента» or cloud link, attempts, rounds, draft leftover, setup, memory cap, body (reader / draft feed / away note / recorded open) | unchanged; plus `AnswerReport` on the stopped stage and the re-check label |
| Window's stage menu «Показати в етапах» | opens the sheet with that stage selected |

**Phone pipeline screen** (`MobilePipelineScreen`)

| Today | After |
|---|---|
| Bar ‹, title, `PipelineStateLine` meta | bar ‹ and title (wraps to two lines); the waits-on line is the meta |
| ⋯ sheet: lane actions, `LaneAnswerRows`, Змінені файли, Перевірки (+ its face), Меню дошки | unchanged |
| «Показати на дошці» button (hidden lane) | a row of the ⋯ sheet |
| `PipelineBlock` stage rows (state, latest message, open conversation, configure gear, current stage's answer report) | the tab grid + the selected pane with its conversation inline (approved frame `s2-v3-phone-sheet`); the report in the stopped stage's pane |
| Work-links row | ⋯ row «Прикріпити PR або issue…» → the existing `links` sheet |
| «Пов'язані задачі N» section | ⋯ row with the count → a `tasks` face listing the same rows; a row opens the task |
| «Попередні спроби · N» section | ⋯ row with the count → a `past` face with `PastAttemptsSection`'s rows |
| Stage configuration sheet (gear, or `takeRequestedStage`) | the pane's ⋯ → the existing `stage` sheet (`StagePlaceholderPane`), with Retry / Skip this stage under the same refusals as the desktop pane menu; a requested stage opens its tab and its sheet |
| `StageSetupResult(latestSetup)` | the selected pane's setup (the attempt it shows) |
| First message of a conversation draft + Start dock | the first stage's pane (`StageDraftFeed`) + the unchanged dock |
| Scroll memory | kept, plus the selected tab per lane in `useMobileScreenState` |
| Graph | «Граф» icon beside ‹ › under the bar |

The ⋯ sheet ends with the prototype's caption «Налаштування етапу: відкрийте
етап і його меню ⋯.».

## 7. Files to change

| File | Change |
|---|---|
| `src/components/kanban/stageTabs.ts` (new) | `stageTabs()` (§3.2) and `laneWaitsOn()` (§5); pure, no React |
| `src/components/kanban/stageTabs.test.ts` (new) | §9.1 |
| `src/components/kanban/StagesSheet.tsx` | waits-on head, tab list, rule lines, one tab panel, `presentation`, `selected`/`onSelect`; remove fold paths, `PaneSlot`, `LoopChip` use; `AnswerReport` and the re-check label in `StagePane` |
| `src/components/kanban/KanbanBoard.tsx` | `SheetTarget.selected`, reader only for the selected pane; remove `paneFolds`/`foldPanes`; `openSheet` and «Показати в етапах» set the selection |
| `src/components/kanban/kanbanBoard.css` | tab, conditional-tab, rule, waits-on and popover classes from `prototype.css` variant 3; remove `.pane.folded`, `.pane-strip`, `.lane-conn` and side-by-side lane rules the sheet no longer uses |
| `src/components/kanban/PipelineSection.tsx` | drop the sheet's `LoopChip` import (keep or delete `LoopChip` by whether anything else uses it; nothing else does at `22d316fb`) |
| `src/components/pipelines/PipelineBlock.tsx` | export `AnswerReport` (and `FindingList` if the pane needs it) |
| `src/components/mobile/MobilePipelineScreen.tsx` | body = `StagesSheet presentation="screen"` with its own `ReaderPlacement` + `ReaderPortals` for the selected pane; bar meta; ⋯ rows and the `tasks` / `past` faces; pane ⋯ → stage sheet |
| `src/lib/i18n/uk.ts`, `src/lib/i18n/en.ts` | role-accusative waits-on keys, conditional words («за потреби», «не знадобився», «поза ланцюжком»), the re-check attempt label, tab aria, phone ⋯ caption, the rule line in the prototype's words |
| `src/components/conversation/conversationWindowEvidence.fixture.tsx` | `StagesSheet` props (it mounts the sheet directly at lines 2330 and 2451) |
| `src/components/kanban/issue1695Evidence.fixture.tsx` | scenario `stageshapes`: one lane per shape of §4, with neutral stage ids and invented text (no lane titles from this installation) |
| `src/components/mobile/issue1671Evidence.fixture.tsx` | the same lanes on the phone pipeline screen |
| `src/components/kanban/kanbanBoard.browser.test.tsx`, `src/components/mobile/issue1671Evidence.browser.test.tsx` | §9.3 |
| `src/components/kanban/KanbanStages.dom.test.tsx`, `src/components/mobile/MobilePipelineScreen.dom.test.tsx`, `src/components/mobile/MobilePipelineScreen.actions.dom.test.tsx` | §9.2 |

No engine, store, route or schema change. `graphOrder`, `currentStageId` and the
graph's own layout stay as they are; only the sheet's order changes.

## 8. Risks

- **The phone's inline reader.** The phone has never hosted the board's
  `KanbanReader`. Inside `MobileShell` its composer, keyboard inset and scroll
  memory must behave as on the phone's conversation screen. The phone driver
  case in §9.3 gates the composer whole above the bar edge at 390 × 844. If the
  reader cannot be hosted, the fallback is the selected pane with the stage's
  latest message and «Відкрити розмову». That differs from the approved frame,
  so it needs the operator's word before it ships.
- **One mounted reader instead of one per pane.** Composer text in a pane the
  operator leaves must survive. `ReaderPlacement` keeps an open reader in the
  park while its conversation is open elsewhere. A pane-only reader unmounts on
  tab change, as a folded pane's reader does today (`KanbanStages.dom.test.tsx`
  line 525: «lets their readers go»). A DOM case checks that an unsent pane
  draft is either kept or never lost silently. No speed claim is made.
- **Evidence record.** The K5b block writes `evidence/issue-1695/k5b.json`. Its
  gates change (no folds, one pane), so the committed record is regenerated by
  the driver in the build.
- **Overlap with open lanes.** The S7 lane (25d3f016, at its brief stage at the
  snapshot) is likely to add its case to the same driver,
  `kanbanBoard.browser.test.tsx`. Before merging, the builder runs
  `git merge-file` on the base and both heads.

## 9. Test cases

Run each touched test file by path in isolated state (`HOME`,
`XDG_CONFIG_HOME`, `TMPDIR`, `LLV_STATE_DIR`, and `LLV_VIEWER_CONTROL_URL` on a
closed port) through `scripts/gate-slot.sh`. Never run a whole directory.
Publication runs the pre-push hook and the hosted required checks.

### 9.1 `stageTabs.test.ts` (pure)

Each case builds the graph of the cited lane with neutral ids. **Must fail on
today's code** marks the branch that fails if the sheet keeps `graphOrder`,
`STAGE_MARK`, or chip-only waits words.

1. Single stage (45307ccb shape): one unit, `showStrip === false`, words without «Етап 1 з 1».
2. Linear apply → verify: steps 1–2, no rules.
3. Docked fix, not taken, lane completed (2b3e7241 shape): units `[build]`, `[review, ↺fix]`; fix word `notNeeded`; the edge is carried by the tab, so there is no rule line.
4. Docked fix taken, lane running (151999a6 shape): fix word is its state; dots 1 fired, source not passed.
5. Dock to the end and dock onward (2b4facd9, d257b842 shapes): same unit, the title sentence names what follows.
6. Return loop (f089ed22, prototype Verify ⤳ Build ui): no conditional; one rule line with fired/max; a fired edge yields the source suffix.
7. **Shared fix (c953029d shape): tab order `brief, build, review, ↺fix, visual`. Must fail on today's code, where `graphOrder` gives `brief, fix, build, review, visual`.** Two rule lines.
8. **Returning visual fix (7e84548f shape): visual-fix anchored after visual. Must fail on today's code.**
9. Fix chain (b9121379 shape): fix-api then fix-web in Review's unit.
10. First stage as fail target (a01b3c1c shape): fix is step 1; the rule line names «назад до Fix».
11. Detached stages (b4ce18d7, b00c3b23, 6ebc867d, ff0a777b shapes): unnumbered, after the steps; an orphan pointing into the chain (fe0ae55e `opus-fix → review`) stays detached.
12. Eight-stage lanes (aef6dba5, 3f714a03, cb6d341d, b00c3b23 shapes): cell counts 6, 7, 7, 6 (units plus detached tabs) as in §4.9; 3f714a03's declared order (integrate after visual) does not change the steps.
13. Conditional chain with its own loop (a95383b5 shape): ci-fix and ci-review sit in Verify-ci's unit; the ci-review ⤳ ci-fix edge gets a rule line.
14. Retry in place (26fd3958 shape): one rule line, `kanban.loop.retry` words.
15. **Skipped (8c8a6012, cb6d341d shapes): the tab's own mark is `skip`, distinct from pending. Must fail if the tab reuses today's `STAGE_MARK`, where skipped and pending are both `ring`.**
16. Re-check attempt: the attempt with `activatedBy.budgetRecheck` is flagged (2b4facd9, e6e9e858 shapes).
17. `laneWaitsOn`, one case per row of §5. **The publication park (14b37d65 shape: passed stage, lane `needs_decision`) must say «гілку не вдалося опублікувати». It fails if derived from chips.** Seat-routed versus operator-owned decisions differ in owner and words. A working builder gives «чекає на Білдера (…)» in uk and "waiting on the Builder (…)" in en.

### 9.2 DOM tests

`KanbanStages.dom.test.tsx`. Rewrite the cases at lines 391, 488, 525 and 1409:

1. The sheet opens with tabs and the graph off at every width; the live stage's tab is selected; exactly one `[role=tabpanel]` and one pane reader are mounted.
2. A tab press selects without opening the agent window. «Відкрити агента» opens it. ‹ ›, Left/Right, Home and End walk the tab order, conditional tabs included.
3. A graph node selects its stage; hiding the graph restores the tabs.
4. No `[data-collapse-finished]`, `[data-expand-all]`, `[data-pane-fold]` or `.ploop` exists in the sheet.
5. The waits-on line and popover: a click opens it in-flow, Escape closes it and returns focus to the line.
6. The stopped stage's pane shows `AnswerReport`, and its ⋯ still offers Retry and Skip under their refusals.
7. Conditional-tab words, `RoundDots` and rule-line texts for the shapes of §9.1 cases 3, 6 and 7.
8. Draft-lane cases (lines 651–989) keep passing: the first message is edited in the pane, and `AddStageControl` stays under the tabs.
9. A pane draft is never silently lost on tab change (§8).

`MobilePipelineScreen.dom.test.tsx` / `.actions.dom.test.tsx`:

1. The bar meta is the waits-on line; the body has the tab grid and one pane.
2. The ⋯ sheet has every row of §6, in order, with counts; the `tasks` and `past` faces open and a row opens its task or attempt.
3. A hidden lane shows «Показати на дошці» in ⋯ and undismisses.
4. The pane ⋯ opens the stage sheet; a requested stage opens its tab and sheet.
5. Answer rows for `needs_decision`, `needs_review` and a stopped merge stay in ⋯.
6. The draft Start dock is unchanged.

### 9.3 Rendered evidence (existing drivers only)

- `kanbanBoard.browser.test.tsx`:
  - Update the K5b block's gates (tabs, one pane).
  - Add a describe block over `issue1695Evidence.fixture.tsx?scenario=stageshapes` that opens the sheet for each §4 lane at 1440, 1100, 1099, 820 and 700 px wide, in uk and en, light and dark. States: sheet, popover open, graph shown, a conditional tab selected, a detached tab selected.
  - Gates measured on text ranges:
    - every tab name whole, never cut or ellipsized;
    - no horizontal scroller in the tab strip;
    - the waits-on line whole on the first screen;
    - the popover inside the head, over no text;
    - the rule lines whole;
    - a conditional tab's word differs from the pending word;
    - a skipped tab's mark differs from a pending tab's;
    - the pane spans the sheet's width;
    - one reader mounted.
- `issue1671Evidence.browser.test.tsx`: the phone pipeline screen at 390 × 844 for the same lanes. States: screen, popover, ⋯ sheet, `tasks` face, `past` face, stage sheet, graph. Gates: the 4-column grid whole, the bar title wrapping without a cut, the composer whole above the screen's bottom edge, the ⋯ sheet with its background inert.
- Frames and manifests go under `$LLV_EVIDENCE_DIR`, never into the tree. Run the drivers in isolated state with a short Chrome `TMPDIR`, through `scripts/gate-slot.sh`.

## 10. Deferred — not currently justified

- A skipped badge on `StageGlyph` and the `skip` shape in `STAGE_MARK` for every
  surface (graph node, card pills). The window needs only its own tab mark;
  widening it changes surfaces the requirement does not name.
- A dot on the tab the lane waits on. The waits-on line names the stage and its
  number once; a second marker repeats the fact.
- An overflow menu or horizontal scrolling for more than 8 units. No lane in this
  installation has more than 8 stages; the grid wraps a third row if one ever does.
- Reordering the graph's own columns for shared fixes (`graphOrder`, `layoutGraph`).
  The graph draws wires and strips, not a sequence. Only the tab strip reads as
  one.
- Cleaning up detached stages left by graph edits. That is an engine and
  graph-edit concern; the window only draws them honestly.
- Evidence for legacy `review-loop` rounds and adopted helper attempts: neither
  exists in the snapshot. Their code paths stay.
- Any change to the card's lane row, the task screen's `PipelineBlock` or the
  phone pipelines list.

## 11. Validation against the requirement

| Requirement (2026-11-20) | Where it is met |
|---|---|
| Variant 3 as drawn: tabs over one stage, full width, desktop and phone | §1, §2: the prototype's rules become product classes; the phone renders the same `StagesSheet` |
| The fix is not shown as a mandatory step | §3.3: a subordinate `↺` tab in its source's unit, «за потреби» / «не знадобився», dots for the budget |
| The visual critic's fix | §4.3: df09d323, 12450964, 7e84548f |
| "Maybe some branching": think through real cases | §3.1: no pass fork exists. Fail edges, detached stages and fix chains are the whole set, each drawn in §4 |
| Loops with rounds and budget | §3.4, §4.2: rule lines in the prototype's neutral words, `RoundDots`, exhaustion sentences |
| Prototype lane, terminal re-check, skipped, parked, single stage, 8+ stages | §4.4–§4.9 with lane ids |
| Whom the lane waits on | §5, from `laneState` and the existing stop words |
| Every current function reachable | §6 |
| Dot with a short popover; no new chrome; one primary action | §5 reuses the card's dot; the phone ⋯ is the bar's existing ⋯; a parked pane's one primary action is a visible Retry (or the composer, for a question) and Skip stays in the ⋯ (§4.7) |
| Real components, real data; evidence from existing drivers only | §2, §9.3 |

## 12. Decisions

None are open for the operator. The operator's choice of variant 3 settles
three things: removing the fold controls, selecting a tab without opening the
agent window, and giving the phone the same sheet. The only path that would
need a new decision is the phone fallback in §8, and only if the inline reader
fails its driver gate.

## 13. What the second visual-critic round changed

The critic read the rendered frames of every lane shape (desktop 1440 to 700 px,
the phone at 390 px, both languages and themes) and the build changed the
following. Each item has a gate in the two evidence drivers.

| Finding | Change |
|---|---|
| A graph node's status line was cut mid-word in Ukrainian | `kanban.graph.lastWas` reads «було не пройдено» in Ukrainian; the drivers fail on any ellipsized node or row text |
| A shared or returning fix was drawn behind another stage and called «back» | `graphTopology` places a stage only a failure reaches (`conditional`) on the layer before the stage it re-enters, so its wire is short and ends there; a fix off the pass chain is drawn as a docked fix, not as «back to»; an unreached conditional node says «if needed» as its tab does; the drivers fail on a wire behind a foreign node |
| Round marks disagreed between tab, graph and phone | one rule, §3.4: the failing source wears `↺ n/max`, the fix shows its own rounds from `fixRoundMarks`, one mark per round of the budget |
| A returning fix stated two contradicting facts | the fixture spends both rounds of the return the park reason names; tab, rule line and graph row read 2 of 2 |
| A parked pane had no obvious primary action | Retry is a button in the pane; a question points to the composer, whose placeholder is an answer's; skip stays in the ⋯ and the hint says which ⋯ |
| A parked pane was framed three times | the pane's rule carries the attention colour; the conversation's orbiting ring and the pane's focus ring are not drawn inside it |
| A skipped pane was an empty full-height box that said «skipped» twice | the status says it once, the sub-line says what the lane did, the pane is as tall as its content |
| Role and loop name ran together | a «·» separates them |
| Two Ukrainian grammars for a rule line | `ruleOn` reads «Якщо X не пройде → Y» like English |
| One stage's time shown twice with different values | the popover's age is whole minutes; the evidence fixture starts a running attempt when its conversation's turn started |
| The 1099 px tab row became the phone's grid although one line fit | the sheet measures the one line and turns it into the grid only where it would overflow (a phone is always the grid) |
