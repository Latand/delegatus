# Readable pipeline graph: loops, true node states, one attempt caption

Status: design, 2026-09-28. Grounded in `origin/main` at `58221bd52`.

## Originating requirement

Pinned specification of pipeline `e553146a`, written 2026-09-27 from the
operator's request of 27.09 and the operator's screenshots of 26.09 (board task
`db2505f2`). Quoted verbatim:

> OUTCOME (operator 27.09: do this first): the pipeline graph reads at a glance,
> both the wide graph view and the compact graph on a kanban card / phone.
>
> WHAT IS WRONG TODAY (operator screenshots 26.09, board task db2505f2 details):
> - Pipelines with several loops (Critique -> Critique fix, Review -> Review
>   fix): return edges from fix stages run as long loops under/around the whole
>   graph and cross each other; red fail edges drop from between nodes;
>   "невдача 2/2", "3/3" chips float mid-edge and in the compact card sit on top
>   of node text.
> - Node states lie: on a completed lane Critique/Review show "чекає · наступна
>   спроба" while the header says completed; in a running lane Critique shows
>   waiting while Review already runs attempt 2.
> - A completed stage whose conversation keeps working (direct rework after a
>   parked critique, issue #1744) shows nothing on the graph (task 7c195060).
> - The stage-attempt caption differs between screens; i18n carries several
>   attempt forms (#1892, task 274727ff): one caption everywhere.
> - Loop labels do not decline the round count (kanban.loopRest, #2094, task
>   74f7240e): correct plural forms in uk (and en).
>
> Direction from the task (a suggestion, not a constraint): draw a fix stage as
> a loop badge on its reviewer, round history as dots, no long return wires.
>
> Keep it pragmatic: fix what is visibly wrong, no framework rewrites, no
> speculative gates.

Prior work: five `search_transcripts` queries (loop layout, return edges,
`loopRest`, attempt caption, in English and Russian, project-scoped and
unscoped) found nothing relevant. A sibling lane `c9f29874` for the same task
was closed during its design stage and left no document. The attempt wording
builds on `docs/design/ui-batch-2026-09.md` §1 (#1865), which is on main.

## 1. What the code and the renders show

The graph is `src/components/kanban/pipelineGraph.ts` (topology, layout,
routes, `stageViews`) drawn by `PipelineGraph` in
`src/components/kanban/PipelineSection.tsx`. Two hosts: the lane row of a card
(`GraphSlot` in `PipelineBlock.tsx`, the card's own width) and the Stages sheet
(`StagesSheet.tsx`, left-to-right from 640 px). Chain pills, the card line and
the phone's stage list read the same `stageViews` through `summarizePipeline`.

Real lanes were copied out of this install's state (read-only SQLite) and
drawn from an export of HEAD in a scratch directory, at 1400 and 340 px, en
and uk. Lanes: `84b11cf2` (completed, two loops), the same record cut back to
"Review runs attempt 2", `2b7944ab`, `33efe347` (three returns to the builder),
`5a79f19c` (six fail edges, four of them retries in place). Nothing was
committed from those renders.

| # | Measured | Cause in the code |
|---|---|---|
| 1 | `84b11cf2` at 1400: both return wires run in two lanes under the whole graph and cross the fail wires; chips «невдача 2/2» and «невдача 3/3» overlap the Critique and Review nodes (three label-over-node intersections, uk and en) | `graphTopology` puts a fix stage one layer **after** its reviewer, so it lands under the next main stage; its pass edge back is a back edge and takes a lane under the whole graph |
| 2 | Same lane at 340: two columns of 132 px nodes, graph 374 px wide inside a 340 px card, fail chip on top of the fix node's state row | `layoutGraph` top-to-bottom gives fail-only stages a second column and reserves lanes on the right |
| 3 | Completed `84b11cf2`: Critique and Review read «чекає · наступна спроба · востаннє не пройдено» | `stageViews` marks a stage "again" when any pass predecessor has a newer attempt. A fix stage is a pass predecessor of its reviewer (`next` points back), and the last fix always starts after the last review |
| 4 | Cut lane: Critique reads waiting while Review runs attempt 2 | same rule; it never asks whether the lane will return to the stage |
| 5 | Node caption «спроба 1 · 2 повтори» on a stage that ran once | `kanban.graph.attemptRetries` prints the fail edge's budget as "retries" beside the attempt |
| 6 | Caption «наступна спроба · во…» cut at 176 px | sentence longer than the node |
| 7 | Phone stage list: «до 2 раундів», and «до 1 раундів» for a budget of one | `kanban.loopRest` is a plain string |

The 850 fail edges of the 1 786 stored pipelines, by shape:

| Shape | Share | Example |
|---|---|---|
| **dock**: the target runs only on this fail edge (a dedicated fix stage) | 627 (74 %) | Review → Review fix → Review |
| **return**: the target is an earlier stage of the pass chain | 187 (22 %) | Review → Build |
| **self**: the stage retries itself | 25 (3 %) | Wp2 → Wp2 |
| other (shared fix stage, fix that continues elsewhere) | 11 (1 %) | two reviewers → one fix |

## 2. Options

| Option | Verdict |
|---|---|
| A. Keep every edge a wire, improve routing and label placement | Rejected. Two nested loops still cross, and a 340 px card has no room for lanes |
| **B. Fold each loop into its source node as a strip; wires only for the pass chain** | **Chosen.** One mechanism for wide and compact, follows the operator's direction, removes the lane, legend and label-measuring code |
| C. Fix stage as a small node beside its reviewer with a short connector | Rejected. Needs a second column in compact, which is defect 2 |
| D. Replace the graph with the stage list | Rejected. The requirement asks for a readable graph |

## 3. Design

### 3.1 Loop shapes (pure, in `pipelineGraph.ts`)

`graphTopology` classifies each fail edge `S → T` once:

- **dock** when `T ≠ S`, no stage has `next === T`, `S` is the only stage
  whose fail edge targets `T`, `T` has no fail edge of its own, and `T.next` is
  `S`, `S.next` or null.
- **self** when `T === S`.
- **return** when `S` is reachable from `T` along pass edges.
- **other** for the rest. These keep today's wire and today's short label
  `fail n/m`; nothing else about them changes.

A docked stage takes its source's layer and no column of its own. Layers, rows
and `graphOrder` are computed over the remaining stages; in `graphOrder` a
docked stage follows its source, so the Stages sheet's panes and nav chips list
"Review, Review fix".

### 3.2 The unit: a node and its loop strip

A stage with a dock, return or fired self loop draws a **strip** attached
under its node: same width, 28 px high (44 px under `pointer: coarse`), the
node's bottom corners squared so the two read as one card.

```
┌──────────────────────────┐
│ 👁 Review · 3             │   name row: stage name, muted attempt suffix
│ ✳ Opus 5.5 ▂▃▅▆ high     │   identity row (unchanged)
│ ● failed                 │   state row: state word, caption (§3.4)
├──────────────────────────┤
│ ↺ ✓ Review fix · 3   ●●● │   strip
└──────────────────────────┘
```

| Shape | Strip text | Click |
|---|---|---|
| dock | `↺`, the fix stage's state mark (`StageToneMark`), its name with attempt suffix | opens the fix stage, as its node did |
| return | `↺` and `kanban.loop.backTo`: "back to Build" / «назад до Build» | opens the target stage |
| self | `↺` and `kanban.loop.retry`: "retry" / «повтор» | none |

A self loop that never fired draws no strip; its budget stays in the node's
tooltip and the Stages pane. Dock and return strips draw at rest too, muted,
because the graph is where the lane's shape is read.

A strip whose fix stage is running takes the active tone and a pulsing mark.
A strip whose edge was just travelled takes the existing `live` accent for
2.4 s (`attemptArrivals`, unchanged).

**Round dots**, right-aligned in the strip, never shrinking:

- one position per round of the budget, `failEdgeMaxRounds` (granted rounds
  included);
- a filled danger dot for each round the edge fired (`edgeRoundsUsed`);
- a filled success dot after them when the source's latest attempt passed;
- an accent ring on the next position while the source or its fix runs;
- hollow muted dots for the rounds left.

No hollow dot left means the budget is spent: shape carries it, colour repeats
it. A budget above six rounds draws `n/max` as text in place of dots. The
strip's `title` and `aria-label` are the existing sentences from `arcTitle`
(fired n of max, what a spent budget does, parked here), so every count is
still available in words.

### 3.3 Layout: wide and compact

Direction is chosen as today: left-to-right when it fits, else top-to-bottom;
the Stages sheet forces left-to-right from 640 px.

**Wide (left-to-right).** One row. Nodes are 176 × 76, a unit is 176 × 104,
all top-aligned; wires join at the node's mid-height, so every pass wire is
one straight segment. `84b11cf2` becomes four columns, 944 px wide and 140 px
high (today 1 204 × 300).

```
┌ Design ───┐    ┌ Build ────┐    ┌ Critique · 2 ─┐    ┌ Review · 3 ───┐
│ ● passed  │─①─▶│ ● passed  │─①─▶│ ● failed      │─①─▶│ ● failed      │
└───────────┘    └───────────┘    ├───────────────┤    ├───────────────┤
                                  │↺ ✓ Critique fix · 2 ●●│ │↺ ✓ Review fix · 3 ●●●│
                                  └───────────────┘    └───────────────┘
```

**Compact (top-to-bottom).** One column, always. Node width is
`clamp(available − 24, 132, 268)`, so the graph is never wider than its card
and the box never scrolls sideways. Row pitch is the unit's height plus the
46 px gap that holds the pass count.

```
┌ Build ───────────────┐
│ ● passed             │
└──────────┬───────────┘
           ①
┌ Critique · 2 ────────┐
│ ● failed             │
├──────────────────────┤
│ ↺ ✓ Critique fix · 2 ●● │
└──────────┬───────────┘
           ①
┌ Review · 3 ──────────┐
```

**Wires.** Only pass edges between units (and "other" edges). The wire
leaving a unit counts every attempt of the next stage that a member of the
unit activated: the source's own pass and its docked fix's handoff pass after
a spent budget. Today that wire stays dashed on `84b11cf2` although the lane
travelled it.

A source whose only second exit is a strip no longer branches: one out port,
no «успіх» label.

**Removed with the lanes:** the `legend` label mode, the legend list under the
graph, the measured `long → short → badge` step-down and its layout effect.
"Other" back edges keep `lanes` and the short label.

### 3.4 Node state rules

The state word is the state of the stage's latest own attempt
(`stageChipState`, unchanged), with one derived reading, "waits again", whose
rule changes.

**The path ahead.** Start at the cursor stage and follow the stage the engine
will start next on a pass: `next`, except for a stage whose current attempt
was activated by a fail edge with `budgetSpent`, which goes to the failing
stage's `next` (`passSuccessor` in the engine). Stop at null or at a stage
already visited. A lane with no cursor (completed, closed, waiting for review)
has no path ahead.

| Lane | Stage's latest own attempt | Node reads |
|---|---|---|
| any | none | waiting · not started (unchanged) |
| any | running, reviewing, committing | that state, pulsing (unchanged) |
| waits for a decision on this stage | failed or needs_decision | unchanged: needs you / failed |
| open | settled, stage is on the path ahead | **waiting** · "last failed" / «востаннє не пройдено» |
| open | settled, stage is off the path | its settled state |
| completed or closed | settled | its settled state |

The cursor stage itself counts as on the path when the lane is busy
(`pipelineCursorActive`) and its latest attempt is settled: the engine has
moved onto it and the new attempt is not recorded yet.

Results on the captured lanes: completed `84b11cf2` reads Critique failed,
Review failed, both fix stages passed, which is what the header's "last fix
not reviewed" line already says. The cut lane reads Critique failed (budget
spent, dots `●●`), Review running. While a fix runs inside its budget, its
reviewer reads "waiting · last failed", which is true.

**Rework in a settled stage (#1744).** `summarizePipeline` takes a third
argument, the set of transcript paths and conversation ids whose board row is
working (the same `WORKING_STATES` the card's «N working» counts).
`StageView` gains `rework: boolean`: the latest own attempt is settled and its
conversation is in that set. The node keeps its true state word and adds the
caption "working again" / «знову працює» in active ink, with the active border
and the pulsing dot. A docked fix stage shows the same on its strip. Call
sites without files pass nothing and draw as today.

**State row caption**, first match wins:

1. rework: "working again";
2. waits again: `kanban.graph.lastWas`, "last {state}" / «востаннє {state}»;
3. a review-loop stage with rounds: `RoundsMark` (unchanged);
4. running after a fail edge sent the work here: `kanban.graph.because`,
   "after {stage} failed" / «після невдачі {stage}»;
5. never started: today's words;
6. otherwise empty. The attempt number lives in the name row.

### 3.5 One attempt caption

| Form | Key | en | uk | Used |
|---|---|---|---|---|
| label | `kanban.stageAttempt` | `{stage} · {n}` | `{stage} · {n}` | wherever a stage's attempt is named on its own node, strip, tile, row or header |
| word | `kanban.attemptWord` (new) | `attempt {n}` | `спроба {n}` | only where the stage's name is absent or a bare number would read as a count |
| long | `kanban.stageAttemptOf` | `{stage}, attempt {n} of {total}` | `{stage}, спроба {n} з {total}` | tooltips and `aria-label` |

Rule, from `stageCardLabelParts` (#1865): a stage that ran once reads as its
name alone; from the second own attempt every attempt of it carries its
number. The suffix is a muted, non-shrinking span, so a long name truncates
and the number stays. Lineage-adopted attempts never count.

| Surface | Today | After |
|---|---|---|
| Graph node | «спроба 2 · 2 повтори» in the state row | «Critique · 2» in the name row |
| Loop strip | — | «Review fix · 3» |
| Past attempts | «Critique · attempt 2», «Design · attempt 1» | «Critique · 2», «Design» |
| Stages sheet, attempt tabs | «#2 · failed» | «спроба 2 · failed» (word form: the pane names the stage) |
| Phone stage row | name, then «· спроба 2» in the meta line | «Critique · 2» in the name |
| Phone conversation header | «stage 3/5», no stage name | label form, then the position |
| Progress line | «Review running · attempt 2» | «Review · 2 running» |
| Pipeline hub | «stage 3 of 5 · attempt 2» | «Review · 2» in the stage label |
| Task album | «Critique · attempt 2» | «Critique · спроба 2», composed from `stageDisplayName` and the word form; a bare number beside pictures reads as their count |

Keys removed: `album.stageAttempt`, `kanban.past.attempt`,
`kanban.graph.attempt`, `kanban.graph.attemptRetries`,
`kanban.graph.nextAttempt`, `kanban.progress.attempt`, `pipelineBlock.attempt`,
`pipelineHub.attempt`, `mobile2.pipeline.attempt` (already unused).
`kanban.past.attemptRound` keeps its round part and takes the label form for
the attempt. Sentences that only screen readers hear
(`kanban.stages.attemptAria`) stay.

### 3.6 Plural rules

A count that governs a noun is a plural message keyed on `count`; the number
that governs the noun is the one passed as `count`.

| Key | en | uk |
|---|---|---|
| `kanban.loopRest`, `count` = budget | one: `… · up to {count} round`; other: `… · up to {count} rounds` | one: `… · до {count} раунду`; few, many: `… · до {count} раундів`; other: `… · до {count} раунду` |
| `kanban.loopTitle` | `… Used {fired} of {max}.` | `… Використано {fired} з {max}.` |

`loopTitle` drops its noun: in "1 of 1 times" the noun follows `max`, and one
`count` cannot serve two numbers. Both call sites of `loopRest` pass
`count: max`: `arcTitle` in `PipelineSection.tsx` and `ScreenBlock` in
`PipelineBlock.tsx`. New strings in this design carry no counted noun.

## 4. Build notes

Fence: `src/components/kanban/pipelineGraph.ts`, `PipelineSection.tsx`,
`kanbanModel.ts` (`summarizePipeline` argument), `stagesModel.ts`,
`StagesSheet.tsx`, `kanbanBoard.css`, `src/components/pipelines/PipelineBlock.tsx`,
`pipelineModel.ts`, `PipelineHub.tsx`, `src/components/taskAlbum/TaskAlbum.tsx`,
`src/components/mobile/MobilePipelineScreen.tsx`, `MobilePipelineCard.tsx`,
`MobileTaskScreen.tsx`, the phone conversation header, `src/lib/i18n/en.ts`,
`uk.ts`. No engine, store or API change: every reading comes from the record
the surfaces already hold.

Tests by path, red first:

- `pipelineGraph.test.ts`: the four shapes; a docked stage takes no column; a
  two-dock lane of six stages lays out 944 px wide left-to-right and at most
  `available` wide at 300 and 340; the unit's outgoing wire counts the handoff.
- `pipelineGraph.test.ts`, state table: completed lane with two spent budgets
  has no pending node; the cut lane reads Critique failed and Review running;
  a fix inside its budget leaves its reviewer waiting; a lane parked on a
  decision keeps today's reading; rework sets the flag only on a settled
  attempt.
- `stagesModel.test.ts`: `finishedStageIds` with the new rule.
- i18n: `kanban.loopRest` at 1, 2, 5, 21 in uk and 1, 2 in en.

Rendered evidence, through the drivers that exist: one `describe` block in
`kanbanBoard.browser.test.tsx` over `issue1695Evidence.fixture.tsx`, and one
case in `issue1671Evidence.browser.test.tsx` for the phone. Invented lanes
only: two docks completed with spent budgets; the same lane with Review
running attempt 2; a return over two stages, running; a fired retry in place;
a passed stage whose conversation works; stage names of 40 characters. At 1440
and 390, en and uk. Gates on measured ink: no strip or label rectangle
intersects another node, graph width at most the card's width at 390, no
element with class `back` in the first four lanes, no node reading waiting on
a completed lane.

## Deferred — not currently justified

- The reason a settled stage is working again (who sent the message), the
  pipeline header reading "parked" while a stage conversation works, and the
  "head moved since the stage settled" mark: the rest of #1744. The requirement
  names the missing sign on the graph.
- Moving a fix stage's row under its reviewer in the phone's stage list and
  the chain pills. The states there become true through `stageViews`; the
  order was not reported as wrong, and changing it touches the card-line folds.
- Round dots on the chain pill's `↺ 2/2` suffix.
- A softer tone for a reviewer that failed on a spent budget in a completed
  lane. The state is true and the lane's own note explains it.
- `groupOverride.legacyReview.recommended` («{count} раунд(и)»): same defect
  class, outside the loop labels the requirement names.
- A wide layout for lanes that exceed the width after folding (seven or more
  main stages): they turn top-to-bottom as today.

## Validation against the requirement

| Requirement | Answer |
|---|---|
| Reads at a glance, wide and compact | one row of units (wide), one column of units (compact); both from the same model |
| Return wires cross, fail edges drop between nodes, chips float and cover text | 839 of 850 stored fail edges become strips inside their unit; no wire, no floating chip |
| Completed lane shows waiting; Critique waits while Review runs | "waits again" follows the path ahead of the cursor; an ended lane has none |
| Rework in a completed stage shows nothing | "working again" on the node and the strip, from the board's own working set |
| One attempt caption | label form everywhere, word form in two named places, nine keys removed |
| Round count declined | `kanban.loopRest` plural in en and uk; `loopTitle` reworded |
| Pragmatic, no rewrite, no gates | pure-model change plus one strip element; lane, legend and measuring code removed; no new state, store field or setting |
