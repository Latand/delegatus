# Required checks and optional failure notes

The merge queue waits for branch protection's required checks. Optional red
checks are saved in `PipelineMerge.optionalFailedChecks` and appear in the
lane detail, compact MCP merge record and the project seat's wake. Optional
check arrivals do not extend settling. A successful empty requirement set is
known; an unreadable requirement set is `null`, which retains the conservative
red-check stop and names the unknown requirement set in the reason. Discovery
still validates classic protection and all active ruleset pages before caching.
No performance improvement is claimed.

## Decision callers

- `src/lib/forge/autoMerge.ts`: `stepLane` calls `decideMerge` after reading
  the PR, reviews and required contexts. Its transient-read Git fallback calls
  the same decision with the current requirement knowledge; it cannot interpret
  an incomplete read as an empty requirement set.
- `src/lib/forge/autoMerge.test.ts`: the direct decision matrix calls it for
  required green, red, pending, known empty and unknown requirements, then calls
  it again to check that recovered optional failures clear.
- `src/lib/pipelines/stagePullRequest.test.ts`: the published-head binding
  regression calls it with an empty set; its head mismatch still blocks first.

## Merge reason readers and copies

- `src/lib/forge/autoMerge.ts`: `block` compares the old reason to preserve
  the first blocking timestamp; `commit` uses `mergeStatus` for status logging.
  `stepLane` compares a failed-check decision with `failedCheckReason` before
  authorizing refresh. Both use `blockingCheck`, so an earlier optional red
  cannot hide a later required red. Its dispatch/capacity reconciliation retains
  plain reasons. `retainQueueReason` preserves capacity suffixes;
  `clearRetiredUpdateWaits` parses update owners. `sweepAutoMerge` reads reasons
  for missing-PR admission, withdrawn owners, refresh admission/progress/stops
  and closed-PR reconciliation, and logs them. None independently classifies an
  optional failure as blocking. Refresh progress and landing copy optional notes.
- `src/lib/pipelines/engine.ts`: `retryMerge` copies a successor's reason and
  optional notes, or requeues a stopped merge and clears its reason, clocks and
  optional snapshot. A legacy `check "X" failed` block needs no migration.
- `src/lib/pipelines/mergeSuccessor.ts`: `withdrawPipelineMerge` compares
  closed/cancelled reasons when deciding whether to update withdrawal state.
- `src/lib/pipelines/store.ts`: `isPipelineMerge` validates the nullable reason
  and optional string-list snapshot. Older records can omit the new field.
- `src/lib/mcp/bindings.ts`: `mergeFields` exposes the reason and optional
  failure names in compact records; full records retain the entire merge.
- `src/lib/attention/seatAgenda.ts`: `mergeStep`, `laneLine` and
  `seatAgendaAsks` read blocked reasons. Retry advice requires green required
  checks and treats optional failures as notes; unknown requirements stay strict.
- `src/components/pipelines/pipelineBlockModel.ts`: `mergeReasonText` handles
  the legacy named-check reason and its new unknown-requirements suffix.
  `src/lib/forge/mergeReasons.ts` owns the shared patterns and reason constants.
- `src/components/pipelines/PipelineBlock.tsx`: `AnswerReport` and
  `MergeStatusNote` render blocked reasons through `mergeReasonText`;
  `MergeNote` renders optional failures separately in both shipped languages.
- `src/components/kanban/cardState.ts`: `laneStopWhy` reads the reason for the
  stopped card state. `src/components/kanban/taskChronologyModel.ts` copies it
  into merge-stopped chronology entries, and `TaskChronology.tsx` translates it.
- `src/lib/monitor/seatTickSources.ts`: `unmergedPullRequests` exposes the
  blocked reason as `mergeBlocked`; `signals` emits optional-failure notes from
  the existing project projection, including after landing and with redaction.
  `src/lib/monitor/types.ts` types that field. `src/lib/monitor/seatTick.ts`
  consumes it in the original and paged unmerged-PR wake reasons and in
  `wakeItems`. Optional notes use existing versioned signal acknowledgements.

## Other named-check gates

- `src/lib/forge/autoMerge.ts`: `decideMerge` uses required names for missing,
  pending, failed and newly registered checks; outstanding updates use the same
  failed-check policy. Draft, review, head, conflict and behind gates retain
  their order. `stepLane` uses the same failed-check identity for refresh work.
- `scripts/merge-batch.ts`: `requiredVerdict`, `traceRequiredFailure` and
  `MergeBatch.land` already select protection's required names. Optional failures
  do not hold batches; unknown or non-strict protection remains refused.
- `src/lib/forge/postMerge.ts`: `green` selects required names, while
  `sweepPostMerge` attributes and recovers required failures only. Log reads
  record red-check evidence without adding an optional merge blocker.
- `src/lib/orchestrator/prompt.ts`: the automatic merge bar and seat guidance
  now require green required checks, retain optional notes and state the
  conservative unknown-requirements rule. Version 71 upgrades the exact shipped
  merge clauses idempotently while preserving bespoke wording and pending replay
  bytes; the existing delivery and envelope tests cover that migration.

## Verification

Focused tests use fake forge ports and frozen clocks. Coverage includes optional
failure before a required failure, late optional arrival, outstanding base
updates, refresh-parent propagation, unknown discovery, a persisted legacy block
through `patchPipeline` retry and real store reload, and versioned seat notes.
The existing kanban browser driver checks the landed note at 1440 pixels in
English and Ukrainian, light and dark. The publication hook selects and compares
its own touched tests on the committed tree against `origin/main`.
