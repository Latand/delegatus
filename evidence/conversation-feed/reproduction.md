# Conversation feed continuity

Initial reproduction base: `1d0eda9302bfa5c1df7e392f6002091ab0c7c7e9`.
Refreshed reproduction and review base: `bda1137afa4c4e0c889f042fe47ec8670fb1abf0`.
All probes use invented transcripts and explicit isolated `LLV_STATE_DIR`.

| Symptom | Base observation | Repair |
| --- | --- | --- |
| #682: completed answer disappears before its own echo | Its mounted DOM row disappears on completion; a later tool or reconnect does not prove the reply was recorded. | Keep pane-owned replies at their original instant. Their canonical projections adopt the original keyed node. |
| #675: processing failure appears as malformed JSON | A valid tool-use record fails with only a window global; forced processing exceptions become malformed records without diagnostics. | Separate JSON parsing from processing failures, redact and bound diagnostics, and show an attributed en/uk alert. Optional locale DOM globals are guarded. |
| #641: compacted/reseeded launch consumes its delayed echo twice | The tombstone claims an echo while the same submission's recreated queue entry remains visible. | Join representations by submission id and propagate one occurrence claim to both. Distinct same-text successors keep their own ownership. |

The refreshed base returns **113 pass / 3 fail** across the outbox and
processing-error files. The dedicated completion/reconnect DOM regression
returns **0 pass / 1 fail**, because the live reply's node disappears.
The delivered-state TTL part of #641 already works on main and is dropped with
that evidence; the reproduced delayed-echo ownership defect remains in scope.

Additional failing-first regressions cover Codex event-first and response-first
mirrors, timestamp/source-line upgrades, deputy boundaries, source ordering,
parser resets, consumed stream replay across turns, and distinct legacy turns
with identical replies. Real producer/parser regressions also cover a missed
completion whose answer splits into prose/review/citation projections, and
64 KiB clipping that keeps the live buffer's suffix, preserving already observed
completed prefixes, and separate ownership for timestamp-free legacy turns.
Growing clipped deltas retain observed Unicode prefixes and one occurrence,
including restored legacy streams; full event-first echoes hydrate the retained
node. Claude assistant source ids follow the runtime producer precedence. The
five added legacy/clipping checks returned 0 pass / 5 fail before repair.
Same-instant legacy records retain separate echo claims. Reconnect gaps retain
read text and explicitly show unseen characters; a mounted completion proves
the observed opening stays on its node. Completed occurrence retirement
survives 550 subsequent deltas, and undated legacy echoes adopt canonical
chronology and source order. These probes also failed before their fixes.
Transport summary compensation preserves per-message tool omission counts. Each was observed failing
before its repair; split-projection and mounted split-echo probes each returned
0 pass / 2 fail before the fix. No production history-loading behavior changes.

A further mounted probe showed that eight later tool calls could evict a read
reply before its own echo: the two regressions returned 23 pass / 2 fail, then
25 pass after prose was retained in the shared scroller independently of the
eight-row transient tool bound. Idle snapshots now settle the caret without
claiming observed text. Full canonical blob correlation is private, preserving
the public redacted 200,000-character cap. The idle and capped/redacted blob
checks returned 31 pass / 3 fail before repair, then 34 pass; the mounted idle
case likewise failed before repair and now retains its node through echo.

The final product-source verification and exact scratch-merge revisions are in
`compatibility.json`. The focused branch run passes **587 tests across 18 exact
paths**; the combined feed/history run passes **595 tests across 20 exact
paths**. Four pre-existing prepend-anchor cases remain skipped in each run.
Every path runs in a separate isolated process, avoiding DOM mock leakage.

Rendered evidence uses the existing `kanbanBoard.browser.test.tsx` driver and
`issue1695Evidence.fixture.tsx`, cases `conversation feed continuity and errors`
and `conversation feed delayed launch echo`. Both branch and composed scratch
runs pass **2 tests / 72 assertions**, in English and Ukrainian at 1440 and
390 px. The reply retains its node with zero echo displacement, and processing,
turn and delivery failures are readable without horizontal overflow. Actual
answer, error and delayed-echo frames are visually inspected; the committed
JSON records retain their measurements. No new capture driver is introduced.

The current history head is `5c8c46522b87b80140af9cecd6815e4bb346322f`;
the composition keeps both PRs' source and test blocks. Their overlapping
hunks and mechanical resolutions are recorded in `compatibility.json` and the
PR description.

Fresh independent review of the full product diff reports no findings and
494 passing checks across ten exact paths. Current source and composed scratch
TypeScript checks pass. The production
Viewer build and real Viewer runtime probe pass under Bun 1.4.0: **23/23 server
modules load and GET / returns 200**. The earlier main build failure is repaired
by upstream #2488, already included in this branch. The local publication
privacy gate uses `--require-known-values --check-commits` before push.
Hosted CI is not awaited.

## Existing check failures

- Changed-file ESLint reports the same seven ref-access errors and eleven
  warnings on base and head; normalized diagnostics match. New helper and
  regression files pass their focused lint check.
- Historical history head `189a7c09` exceeded its 120 ms desktop frame budget
  in scratch and on the history PR alone. Those failed readings remain pinned
  as historical evidence. Current history head `5c8c4652` explicitly defers
  absolute frame-time targets and records both CPU runs; its unmodified driver
  passes node reuse, reaching the start, find-in-page and selection gates.
  The composed phone driver passes real touch and node-preservation assertions.
  Recorded frame times are measurements, without a claim of smooth scrolling.
- `LogFeed.deliveryUncertainty.dom.test.tsx` has a missing `sessionKey` in its
  runtime fixture and fails on base and head. Its bounded run does not finish;
  it is excluded from the focused pass count.
- `structuredDelivery.integration.test.ts` returns 40 pass / 2 fail on base
  and head because its retry-cancellation and failed-kill cases have invalid
  owned-process fixtures. The native Codex matrices were checked separately:
  1,075 passing tests for each of 0.154.0 and 0.159.0.
- The unchanged `liveTurnStallPath.dom.test.tsx` fails before handoff processing
  because its projected runtime list is empty on both base and head. The
  `issue626Lifecycle.test.ts` idle-journal refresh assertion likewise fails on
  both base and head (5 pass / 1 fail), outside this change's producer code.

The documented hook escape is used for confirmed baseline failures. Privacy,
types, focused tests, rendered acceptance and Viewer checks are run explicitly;
this evidence does not claim a fully green aggregate pre-push hook.
