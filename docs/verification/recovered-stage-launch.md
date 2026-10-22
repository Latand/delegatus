# Recovered stages without a launch (#2996)

## Main confirmation

On 2026-10-22, main `6b5d8509d` still refused every outstanding
activation at `src/lib/pipelines/engine.ts:14223` and required an already
launched running attempt at `src/lib/pipelines/engine.ts:14305`.
The publication repair in #3186 changes another path. Main `7d3b2d7e3`
retains both conditions. Its PR-summary changes were merged into this branch
with a merge commit.

`src/lib/orchestrator/boardReportRun.ts:195` selected a failed predecessor
by timestamp even when its replacement had no start timestamp.
`src/lib/orchestrator/boardReport.ts:430` consequently listed that failure
as current. HTTP error status preservation already exists in
`src/lib/mcp/largeReads.ts`; this change leaves that path alone.

## Ownership and recovery

The activation producers are `tickRunStage` and the launch checkpoints in
`spawnRunStage`. Pause marks outstanding activations cancelled; resume changes
their control fence. The activation drain owns dispatch, stale checkpoint
settlement and close obligations. Registry admission produces a receipt under
the activation's client attempt key; the reservation callback normally copies
its launch and conversation identity into the attempt. Account and controller
recovery consume that identity through the existing receipt reader.

Retry now wakes an unstarted pending attempt through the same controller. It
preserves its attempt number, activation owner, downstream key and booked
backoff. A paused pipeline remains paused. Stage, attempt, explicit launch,
survivor and other-activation guards remain in force. Any retained launch,
conversation, transcript, pane, start, completion, verdict or report excludes
this recovery path.

A stale pre-dispatch checkpoint checks registry admission before releasing
custody. An existing receipt binds its launch and conversation to the original
attempt for normal receipt recovery. It grants no new dispatch permission.
Without an admitted receipt the existing stale-activation reconciliation
returns the same attempt to pending.

The board report uses the current stage's latest own attempt for failures.
Its transient `wait` projection names launch admission, delivery-controller
publication, retained activation or receipt custody, and booked retry times.
No persisted schema changes are involved. The composer consumes that optional
field; report fixtures without it preserve their existing output.

## Reproduction and checks

Commands run through `gate-remote -- bash scripts/gate-slot.sh`, with the
remote runner's private home, config, temp and state roots and a closed Viewer
control URL. Each test command names explicit files.

On unchanged main, the new pause/resume regression failed with
“the original stage activation is still reconciling”. A second regression
proved that stale reservation cleanup discarded an already admitted receipt.

Focused command:

```sh
bun run test src/lib/pipelines/engine.recoveredPending.test.ts src/lib/orchestrator/boardReportRun.test.ts src/lib/orchestrator/boardReport.test.ts
```

The focused run passed all 41 tests. They exercise one launch after pause/resume, replay after a real process
restart, admitted-receipt custody, request guards, retained evidence refusals,
controller publication waits, backoff preservation and board text. This is a
correctness change; no performance improvement is claimed.
