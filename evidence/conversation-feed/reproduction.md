# Conversation feed continuity

Initial reproduction base: `1d0eda9302bfa5c1df7e392f6002091ab0c7c7e9`.
Continuation base: `28a9cd01ee0d3f747a7e59c42fbc47912b9235e0` (fetched main).
All probes use invented transcripts and explicit isolated `LLV_STATE_DIR`.

| Symptom | Base observation | Repair |
| --- | --- | --- |
| #682: completed answer vanishes before its own echo | Completed live item at T, later tool at T+5, no matching source id: zero live rows for running, idle and reconnecting turns. The DOM row disappears on completion. | Keep pane-owned answers through missing runtime snapshots; splice them into the common keyed row list at their original instant. Their own canonical echoes take the same node and position. Identity claims and idless stream retirement prevent resurrection after eviction. |
| #675: processing failure reads as malformed JSON | Valid tool-use record fails under a window-only DOM. A forced tool-card exception produces `malformed_record` with no diagnostic. | Separate JSON parsing from record processing; retain a bounded, redacted diagnostic with record type and source line. Show an en/uk alert in the conversation. Guard optional DOM locale globals. |
| #641: compacted/reseeded launch consumes its delayed echo twice | Tombstone claims the launch echo while its recreated queue entry remains visible. Main already preserves delivered state and its TTL; the indefinitely-delivering part is already repaired. | One submission id owns one occurrence across tombstone and queue. Canonical text upgrades and distinct same-text successors retain their own semantics. |

The continuation regressions on the fetched base return 120 pass / 4 fail
across outbox, handoff and processing-error files, plus the dedicated DOM
continuity regression fails because its live node disappears. The #641 failure
is the missing retirement assertion. Processing tests fail on the DOM-only case
and swallowed error. Handoff fails on absent reply. No symptom was dropped
except the already-repaired delivered-TTL part of #641.

Head verification uses exact paths. The six unit suites cover outbox,
assistant-row projection, live handoff, processing errors, parser and transcript
ordering. The DOM live-tool suite covers tool/prose interleaving, same-node
completion/reconnect/echo, composer follow-up ordering and omission labels.
Additional regressions prove single-occurrence matching of idless replies,
retirement after eviction, source order for multi-row canonical echoes, the
shared eight-row live bound, incremental markdown, and seat speaker continuity
after a deputy on both desktop and phone.

Rendered evidence uses the existing `kanbanBoard.browser.test.tsx` driver and
`issue1695Evidence.fixture.tsx`, cases `conversation feed delayed launch echo`
and `conversation feed continuity and errors`. The JSON records cover English
and Ukrainian at 1440 and 390 px. Frames are written beneath
`.artifacts/conversation-feed/` for visual inspection. Failure evidence exercises
the real parser, turn-error card and failed-delivery row; a fixture-only throwing
tool argument drives the processing exception without changing production code.

No history-loading behavior changes. Compatibility with the current #2448 head
is rehearsed separately in a scratch merge; its results are recorded in
`compatibility.json` and the pull request description.

Focused verification (also repeated after the main merge): 529 passing tests across 17 exact paths. The mounted
LogFeed suite contributes 15 tests, including completion, reconnect, delayed
echo, source ordering, markdown and deputy boundaries. A fresh independent
review of the full diff reported no findings and passed 197 checks.

Before the latest main merge, local checks passed the production Viewer build, its 23 server
modules and real HTTP root, MCP size budgets, runtime-host succession and
negative controls. Native Codex checks pass 1,075 tests for each of 0.154.0 and
0.159.0 after separating the pre-existing failing delivery fixture suite below.
The publication privacy gate is run with `--require-known-values` and
`--check-commits` before push. Hosted CI is not awaited.

## Existing check failures, reproduced independently of this change

- ESLint reports the same seven ref-access errors and eleven warnings on base
  and head. Diagnostics match after removing file locations and shifted line
  numbers. The new helper and regression files introduce no lint errors.
- `LogFeed.deliveryUncertainty.dom.test.tsx` uses a runtime session without
  `sessionKey`; polling reaches `retainedSettledTurnId` and fails on both base
  and head. The complete old suite does not finish within the isolated runner's
  bound. It is excluded from the 529-pass count.
- `structuredDelivery.integration.test.ts` returns 40 pass / 2 fail on both
  base and head: the automatic delivery retry cancellation and failed kill
  projection cases have invalid owned-process fixtures. This entire file was
  checked separately from the two native-version matrices, without changing
  product code or weakening its ownership guard.
- The independent review also confirmed the unchanged
  `liveTurnStallPath.dom.test.tsx` fails before handoff processing because its
  projected runtime list is empty on both base and head.

The documented hook escape is used for these reproduced baseline failures;
privacy, type checking, rendered checks and the remaining local gates are run
explicitly, with the later main-merge results separated below. These are not reported as a fully green aggregate pre-push hook.

## Main-merge recheck and outstanding scope decision

After merging main `27e3583a9`, the 529 focused tests and both feed browser
cases still pass. The scratch merge with #2448 still passes 440 unit and 76 DOM
tests. The only main-merge conflict was the fixture's `STRUCTURED` initializer;
both `STREAMING` and `FEED_CONTINUITY` flags are retained.

The production build and TypeScript check now stop at
`src/lib/pipelines/engine.ts:3158`: upstream omitted the required fifth `persist`
argument to `commitPassedStage`. Fetched main `afe93fa58` still has that omission.
A scratch-only one-line repair passes TypeScript and 38 fixer-path tests. It has
not been applied to this branch because pipeline-engine source is outside the
authorized conversation-feed scope. Full current-head acceptance is incomplete.

A repeated unmodified desktop history driver records a 200 ms frame against its
120 ms limit. The earlier passing run remains recorded against its original
source and scratch heads; the new run is not counted as passing.

The same unmodified desktop history test on #2448 alone also fails its frame
limit (167 ms; 86 ms longest task), retaining all 300 marked nodes and all 2,800
rows. The merged phone history and both feed browser cases pass. These browser
reruns used the scratch-only engine repair; their fixture bundle does not import
the pipeline engine. The missing-argument repair already has a separate PR,
#2488, so the feed branch records the dependency without duplicating that change.
