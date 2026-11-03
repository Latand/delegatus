# Passed-stage ownership recovery

Cause on main `39f64aec`: `src/lib/pipelines/engine.ts:13476` caps the
preparation retry delay at one minute without bounding elapsed time or rounds.
`src/lib/pipelines/stageBranch.ts:74` includes every peer's branch authority in
the ownership token. A peer authority change during settlement cancels adoption
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
selection. The restart regression fails on main `39f64aec` with the lane still
`running` where `needs_decision` is required.
