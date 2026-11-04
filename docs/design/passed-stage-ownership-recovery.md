# Passed-stage ownership recovery

Cause on main `6bf8b958d`: `src/lib/pipelines/engine.ts:13494` caps the
preparation retry delay at one minute without bounding elapsed time or rounds.
`src/lib/pipelines/stageBranch.ts:74` refuses a changed authority revision, and
line 76 includes every peer's branch authority in the ownership token.
A peer authority change during settlement cancels adoption
and records another retry. Continuing changes can repeat that cancellation
forever, across controller restarts. The running lane cannot use `retry-stage`
because that action requires a stage awaiting a decision.

The ownership reader already re-reads changed authority. There is no retained
controller-generation token that needs refreshing. The historical lane is no
longer available; the diagnosis concerns the current code path and its
reproducible failure mode. Commit `644ca7c80` (#3529) removed the former
15-minute bound while retaining the first-failure timestamp. Admission retry
work in #3535 bounds a separate wait for a controller job.

Recovery must retain the accepted output and commit, fence stale Git results,
and stop repeated preparation failures at the persisted deadline. An explicit
`retry-stage` must renew that preparation window and settle the same attempt
without resetting the checkout or launching the producer again.

The preparation wait is written by `recordStageSettlementPreparationFailure`,
read by `settlePendingStageGit`, and persisted as `settlementPreparationWait`
on the stage attempt. `retryPassedStageCommit` already clears that wait for
commit-boundary parks. Controller selection, publication admission and the
manual retry dispatcher consume the lane state and committing cursor. The
publication result, delivery owner and epoch remain authoritative; an executing
publisher must never be parked by this recovery path.

After another failed preparation at or beyond 15 minutes, the lane now parks
as `needs_decision`. Its error starts with `committing the passed stage:`,
which routes `retry-stage` through the existing commit recovery path. That
path clears the preparation wait and retains the checkout and attempt.
Parking clears the successful publication's `passedStage` marker so that a
later controller tick cannot automatically dismiss the ownership decision;
the publication identifier, accepted SHA and result remain intact. Pending
reservations stay pending until a fresh settlement can authorize dispatch.
The decision commits before its task note is delivered, so a failed note
cannot restore an endless retry.

`src/lib/pipelines/engine.settlementPreparation.test.ts` exercises both
preparation and post-preparation races through the real SQLite store and Git.
Its replacement-controller cases start a fresh process against the persisted
wait, test the original deadline, and retry without relaunching the producer.
They cover uncommitted output, a pending push and a verified push, alongside
controls for recovery before the deadline and changes that supersede the old
selection. The restart regression fails on main `d8e59e3cb` with the lane still
`running` where `needs_decision` is required.

## Verification

The implementation is committed in `7b156dd8f`. Verification resumed after
merging main `d8e59e3cb` with a merge commit. The task's source diff remains
limited to settlement preparation and its regression tests.
The later merge of main `6bf8b958d` changes only the external relay; the
settlement source and tests are identical across that merge.

- On main `d8e59e3cb`, the focused restart regression reports one passing
  recovery control and one failure: expected `needs_decision`, received
  `running` after the replacement controller reaches the original deadline
  (exit 1, 22 assertions). The same regression was red on main `39f64aec`
  before the refresh.
- `bunx tsc --noEmit` passes after the main merge (exit 0), through
  `scripts/gate-slot.sh` in a fresh export with shared, unchanged dependencies.
- After the merge, `bun test --timeout=60000
  src/lib/pipelines/engine.settlementPreparation.test.ts` passes all 31 tests
  and 543 assertions through the gate in a fresh isolated export (exit 0).
  The file includes replacement-controller processes, retained output, manual
  retry, dispatch refusal and failed task notes.
- The earlier pre-push attempt passed publication privacy but had no complete
  test/typecheck verdict. Recorded-check handoff was refused with
  `recorded check custody capacity is full`. The owned recorder is cancelled;
  its durable exit is 143 and its service close report confirms cleanup.
- The first direct pre-push rehearsal exits 1. Privacy, types and lint pass;
  all 62 head test files run, including a passing settlement-preparation file.
  The comparator cannot complete a baseline rerun of
  `src/lib/pipelines/engine.ports.part3.test.ts` in the remaining confirmation
  budget. Its earlier head and baseline reruns passed. This is an incomplete
  comparison, not a new-failure verdict. The retry uses the documented 600%
  per-scope CPU quota, fresh isolation and unchanged gate budgets and limits.

The continuation authorizes direct, fully isolated checks, one command at a
time through `scripts/gate-slot.sh`, with explicit exit-code records and no
recorded-check handoff. The pre-push rehearsal uses the committed tree in a
scratch checkout with its own Git metadata and shared dependencies. The
pipeline publishes and opens the pull request; the hosted
`privacy-tracker-audit` and `runtime-gate` checks belong to that publication.
No performance improvement is claimed.
