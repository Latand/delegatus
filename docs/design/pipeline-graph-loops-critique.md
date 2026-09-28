# Design critique: readable pipeline graph

Status: critique, 2026-09-28. Rendered from an export of `f0abfab16`
(merge base `58221bd52`). Verdict: **fail**, one P1 and two P3.

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
> Critique looks at the rendered result at 1440 and 390 px, en and uk, with long
> titles, completed lanes, active rework and multi-loop lanes.

## What was rendered

Everything below was drawn from a `git archive` export of the reviewed commit
in a scratch directory, under the Bun the image pins, in headless Chrome. The
worktree was clean before and after, and the commit did not move.

| Run | Surfaces | Frames |
|---|---|---|
| The lane's own case in `kanbanBoard.browser.test.tsx` (`?scenario=graph-loops`) | card graph and Stages sheet graph at 1440, phone task and pipeline screens at 390, en and uk, six lanes | 48, all opened and read |
| Scratch driver over the same fixture | card and sheet at 1440 dark, 1024, 1024 with a coarse pointer, 700 | 95 |
| Scratch driver over older scenarios (`issue1798`, `issue1743`, `pipelines`) | every lane that has a graph, card and sheet, uk and en | 60 |
| Scratch driver over the phone's pipeline screen | the bar at 390 and 360, en and uk, at rest and with the list scrolled, at the merge base and at the reviewed commit | 56 |

The lane's case passed and its readings reproduce the committed
`evidence/pipeline-graph-loops/geometry.json`.

One gap in the lane's evidence: the phone pipeline screen is captured only
with the list at rest, and nothing measures its bar. Finding 1 lives there.

## What holds

| Requirement | Seen in the renders |
|---|---|
| No long return wires, no crossings, no floating chips | 0 back wires and 0 box intersections in every graph measured (89 card readings and 64 sheet readings in the scratch runs, beside the lane's own 24); every loop is a strip under its source |
| Compact graph fits its card | one column everywhere; graph 292 px in a 436 and a 384 px box, 228 px in a 236 px box; no box scrolls sideways |
| Wide graph | one row, 944 × 140 for the two-loop lane, straight pass wires with their counts |
| Completed lane tells the truth | `p-loops-done`: Critique · 2 and Review · 3 read failed with spent dots, both fix strips read passed, no node waits |
| Running lane tells the truth | `p-loops-review`: Critique failed, Review · 2 running, its strip shows one round used and one under way |
| Rework in a settled stage | `p-loops-rework`: Build reads «пройдено · знову працює» with the active frame on the card, the sheet, the phone pill and the phone row |
| Long names | 40-character names truncate inside the node and the strip; the attempt number and the dots stay |
| Plurals | «до 1 раунду», «до 2 раундів», «до 3 раундів» on the phone |
| Coarse pointer | strips measure 44 px, the layout follows, nothing overlaps |
| Dark theme | strips, dots and frames keep their contrast |

## Findings

### 1. P1 — The phone's pipeline bar no longer holds its own text

Surface: phone pipeline screen, 390 and 360 px, en and uk, every lane that
stands on a stage. Introduced by this lane: the stage label was added to
`PipelineStateLine`.

The bar is 52 px high and its title cell is 44 px. Measured, y from the top of
the screen:

| Lane, 390 px | State | Merge base | Reviewed commit |
|---|---|---|---|
| `p-search`, en and uk | at rest | state line 17–35, one row | state line 8–44, two rows |
| `p-search`, en and uk | list scrolled | title 7–26, state line 26–44 | title **−2**–17, state line 17–**53** |
| `p-loops-long`, en and uk | at rest | — | state line **−1**–**53**, three rows |
| `p-loops-long`, en and uk | list scrolled | — | title **−11**–8, state line 8–**62** |

What the operator sees:

- Ordinary stage names (Review, Build, Verify), list scrolled: three rows in
  the bar, the title's top edge off the screen, the last row («· етап 4 з 6 ·
  2 год») against the banner below.
- A long stage name, list scrolled: the title is cut through the middle of its
  letters and the last row is cut in half by the banner. Neither can be read.
- In every case a wrapped row opens with an orphan «·».

Cause: `.pb-stateline` wraps, and the new stage part takes a row. The bar's
`[&_.pb-stateline]:flex-nowrap` and `[&_.pb-stateline]:text-label` utilities
never applied: `pipelineBlock.css` is imported unlayered, so its
`flex-wrap: wrap` outranks a layered Tailwind utility. At the merge base the
line was short enough that nobody noticed.

Fix:

1. `PipelineStateLine` (`src/components/pipelines/PipelineBlock.tsx`) draws
   two explicit rows when the lane stands on a stage. Row one: the state word,
   the merge word, the stage label. Row two: the position and the age. A lane
   with no stage keeps its single row.
2. `pipelineBlock.css`: `.pb-staterow { display: flex; flex-wrap: nowrap;
   align-items: baseline; column-gap: 5px; min-width: 0; }`, the stage part
   `flex: 0 1 auto; min-width: 0` so the name truncates and the number stays,
   and `.pb-staterow > .pb-statepart:first-child > .pb-sep { display: none; }`
   so no row opens with a separator.
3. `MobilePipelineScreen.tsx`: drop the two dead utilities, mark the cell
   `data-title-away` while the title is in the bar, and hide row two there with
   an unlayered rule in `pipelineBlock.css`
   (`[data-mobile2-meta][data-title-away] .pb-staterow + .pb-staterow { display: none; }`).
   The bar then holds two rows at most in either state: 36 or 37 px of 44.
4. Gate, inside the lane's existing phone case: for each lane at a 560 px high
   viewport, at rest and after `scrollTop = 260` on
   `[data-mobile2-pipeline-body]`, the rectangles of `.pb-stateline` and
   `[data-mobile2-title-text]` lie inside `[data-mobile2-bar]`.

### 2. P3 — «після невдачі Critique» is cut on the wide graph

Surface: Stages sheet, 176 px nodes, uk. Render: `issue1743` scenario, lane
`p-marks`, Build · 3.

The caption needs 98 px and has 96, so the node reads «після невдачі
Critiq…». Every stage name of eight letters or more is cut; en «after Critique
failed» fits. The string is new in this lane, and the design lists a cut
caption at 176 px as defect 6.

Fix: shorten `kanban.graph.because` in `uk.ts` to «через {stage}». It saves
about 25 px and holds names up to 13 letters; the tooltip keeps the sentence.

### 3. P3 — Older cut text next to the graph

Unchanged from the merge base, listed because they sit on the surfaces this
lane makes readable. Neither decides the verdict.

- Wide graph, a reviewer that has not started: «перевіряє попередній запуск»
  needs 134 px of 107, en «reviews the run before it» needs 107 of 99. Shorter
  strings («перевіряє запуск», «reviews prior run») fit.
- Card footer, `p-loops-long`: the last-attempt line ends mid-word at the
  card's edge («· провале») with no ellipsis. `.history summary` is
  `inline-flex` with no `max-width`, so the label's own ellipsis never engages;
  `max-width: 100%` on the summary fixes it.

## Over-engineering pass

Nothing to cut. The lane removed the lane routing, the legend and the
label-measuring effect, and added one strip element.

## Validation against the requirement

| Requirement | Verdict |
|---|---|
| Graph reads at a glance, wide and compact | holds |
| Loops, crossings, floating chips | holds |
| Node states | holds |
| Rework in a settled stage | holds |
| One attempt caption | holds in the graph, the card and the phone rows; the phone bar that carries it is broken by it (finding 1) |
| Plural forms | holds |
