# Automatic recovery from model capacity refusals

## Diagnosis

At baseline `308ba22a`, lane `44b4c852`, build attempt 2, retained a
`model at capacity` cut, zero recovery tries and a next-try time of
2026-10-29T02:59:56.534Z. Its recorded definition pinned its account. The
recovery history included an earlier successful continuation. The operator
later changed the account and retried the stage at 08:14Z.

Three code paths explain the stop:

- `recoverProviderCut` (`src/lib/pipelines/engine.ts:3276` at the baseline) selected an alternate
  account only for quota and authentication failures. Model capacity was
  classified as a transient failure and continued on its source account.
- Both `recoverProviderCut` (`engine.ts:3291`) and
  `recoverPipelineProviderTurn` (`engine.ts:12637`) parked transient
  failures after three tries. A capacity refusal therefore had a finite
  continuation budget even when the operator had pinned its account.
- `parkExpiredProviderObservation` (`engine.ts:12557`) parked a saved, uncontinued terminal cut
  when the independent observer reached its 15-second deadline. The affected
  attempt retained zero tries: this deadline caused its decision state before
  the continuation budget ran out. The saved record does not identify which
  awaited observation remained unresolved. The expiry itself required no new
  provider failure and no operator input.

The observer checkpoints the transient wait and then calls `tickRunStage`.
That path reads host activity before `recoverProviderCut` checks the next-try
time. Consequently, an observation can expire during the saved backoff, before
any continuation is due.

The earlier independent-observer, checkpoint, active-turn protection and
Cloud fallback changes retained these three policies.

## Recovery

An unpinned capacity cut uses the existing reset-aware project selector,
excluding the source for the alternate-account pick. Project policy and
ordinary quota exclusions remain authoritative. A successor keeps the
checkout, earlier attempt receipts and the configured runtime. Existing launch
admission checks the selected account and service tier again before dispatch.

The first eligible alternate account can run immediately. Further cuts retain
their persisted exponential delay, capped at 15 minutes. Capacity failovers
do not permanently mark accounts as quota-exhausted. Quota and authentication
exclusions retain their existing meaning.

An explicit pin keeps the same account and continues retrying. An exhausted
allowed pool stays running with its reason and next-try time; it schedules
another selection. A read timeout releases observer admission, preserves the
cut and schedules another observation through a fresh, fenced snapshot. A
late result from the expired observer cannot dispatch or overwrite state.

## State and callers

No record shape changes. `openProviderWait`, continuation and relaunch write
the existing `providerWait`, `providerRecoveryBudget` and `providerRecoveries`
fields. The store replays them; ordinary controller ticks and the independent
observer consume them. The watchdog uses `resumeAt` after a restart, and the
lane/card/stage projections display the existing wait and recovery records.
Operator controls retain their cancellation and generation fences.

`engine.capacity.test.ts` exercises real pipeline creation and account
selection. `providerRecovery.test.ts` covers both independent recovery and
fresh-process replay, including a real observation deadline with a saved cut.
`engine.succession.part2.test.ts` covers the ordinary controller path and its
idle-only retirement fence. No performance improvement is claimed.
