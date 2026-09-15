# Kanban board: update stalls and scroll overhead

Issue #1546 (related #1444). Base: `94215638792ea00e5c7cd2a8a309bb98960b1023`.
Measurements: [`issue-1546-kanban-board.json`](./issue-1546-kanban-board.json),
produced by `scripts/profile-kanban-board.ts`.

## What was costing the time

A CPU-sampled profile of a settled board — nobody touching it, data still
arriving — named one function above every other: `flowMembership`, at **685–711 ms
of self time in a 35 s window**, a tenth of all the script the page ran. It is
the board's "which flow does this transcript belong to" answer, and it was a
scan of every flow and every round for each file, from three call sites. The
earlier investigation could only call that attribution plausible, because the
traces it had carried no CPU sampling; this names it.

`directReviewFlows` had the same shape one level up: the reviewed conversation
of each group was found by scanning the whole file corpus, and the flows list
was scanned again for each anchor.

Scrolling cost something different. The presence measurement — what the board
reports the operator can see — read **every card's rect on every scroll frame**
and wrote the result into React state, so a gesture re-rendered the board and
all four columns for a value no card draws.

## What changed

- **One membership index per (flows projection, claim resolver) pair**, held
  weakly beside the existing `conversationFileIndex`, so a superseded revision
  leaves memory with its last consumer. The index reproduces the scan's answers
  exactly, including its order: a reviewer match still beats an implementer
  match in an earlier flow, the first flow claiming a path still wins, durable
  membership still outranks the path match, and recorded paths are still
  rewritten onto the projected corpus before they are compared.
- **`directReviewFlows` answers both per-group lookups from one pass**: the
  conversation index for the anchor's current generation, one set for active
  managed-flow ownership.
- **The presence measurement leaves React state**. It lives in a ref and calls
  the presence report directly, so a scroll re-renders nothing. The scan is
  throttled to 100 ms while a gesture runs and always settles with a final
  measurement 120 ms after the last scroll event, so presence is exact at rest
  and at worst one throttle window behind while the board is moving. An
  `IntersectionObserver` cannot express this predicate — visibility here is the
  intersection of a card with its column body, the board and the viewport, and
  an observer carries one root.

Grouping, identity, project attribution, activity sorting, focus handoff,
drag/drop and keyboard navigation are untouched.

## Measured, before and after

A populated board, entirely invented: 864 files, 284 flows, 619 tasks, 359
cards, 9,958 DOM nodes. Headless Chrome at 1440x900, devicePixelRatio 1. Three
repetitions per side, run alternately on one idle machine; the ranges below are
every run, not a best one.

**Idle — 35 s, a catalog update every 500 ms, no input**

| | before | after |
| --- | --- | --- |
| `flowMembership` self time | 685–711 ms | **3–5 ms** |
| JavaScript (sampled, excluding V8 `(program)`) | 6,630–6,845 ms | **5,909–6,132 ms** |
| frames over 25 ms (of ~2,095) | 5–9 | **2–3** |
| longest frame | 33–50 ms | 33–50 ms |
| tasks over 50 ms | 0 | 0 |

**Scroll — 80 wheel events down the Assigned column, data frozen**

A 2.7 s control window with no input is subtracted where a row says "gesture",
because polling keeps working while the operator scrolls; that control measured
19–24 ms of JavaScript and 8 commits on both sides.

| | before | after |
| --- | --- | --- |
| JavaScript (gesture) | 129–165 ms | **17–24 ms** |
| `getBoundingClientRect` self time | 71–90 ms | **12–19 ms** |
| React commits (gesture) | 25–27 | **4–5** |
| 95th-percentile frame | 16.7–16.8 ms | 16.7–16.8 ms |
| cards on screen but not reported, after the gesture | 0 of 285 | 0 of 285 |

The scroll profile also shows `renderCard` and `shallowEqual` leaving the sample
entirely: the gesture no longer renders cards.

## Residuals, stated as measured

- **The idle window's remaining ~6 s of script is not the grouping scan.** What
  is left is spread across `translate`, `getBoundingClientRect`, `fetch`,
  response construction and `buildSchemeLayout`; none of it exceeds 450 ms in
  35 s, and no single task reaches 50 ms in this harness. The 50 ms target is
  met here, but this harness answers its own fetches — it does not carry the
  real route's payload or JSON parse cost, so it cannot stand in for the long
  tasks the issue reported on the deployed board.
- **The longest idle frame did not move.** It is 33–50 ms on both sides across
  all six runs, one frame in roughly two thousand. Whatever produces it is not
  the grouping scan and was not identified.
- **Four to five React commits during the gesture are unexplained.** Eight
  commits occur in the same span with no input at all, so the gesture is
  answerable for about five; what schedules them was not identified. They render
  no cards.
- **One of the three "after" scroll runs had a single 83 ms frame**; the other
  five runs across both sides had none over 17 ms. It was not reproduced and is
  recorded rather than explained.
- **The gesture's total sampled non-idle time is ~485 ms, of which ~445 ms is
  V8's own `(program)` bookkeeping** — parse, compile and input plumbing that
  moves independently of this change (the before runs spent the same there).
  Only the JavaScript row above is attributable to the board.
- **Nothing here was measured on a physical touchpad, a high-density display, or
  above 60 Hz.**

## Reproducing it

Both halves run with private homes, provider roots, state and temporary paths:

```sh
python3 scripts/run-isolated-performance.py bun scripts/profile-kanban-board.ts <checkout> <out-dir> 35
```

Point it at a checkout of the base commit and at this branch; nothing else
differs between the two runs. The regression guards are
`src/components/scheme/workerCollapse.test.ts` (the index reproduces the scan,
and never answers a new projection from a stale one),
`src/components/flows/directReviewGroups.test.ts` (anchor generation ranking and
managed-flow ownership) and `src/components/kanban/KanbanPresence.dom.test.tsx`
(presence is exact once a gesture settles, and a gesture costs a bounded number
of scans — that second case fails at the base commit with one scan per frame).
