# Recovered stages without a launch (#2996)

## Main confirmation

On 2026-10-22, main `6b5d8509d` still refused every outstanding
activation at `src/lib/pipelines/engine.ts:14223` and required an already
launched running attempt at `src/lib/pipelines/engine.ts:14305`.
The publication repair in #3186 changes another path. Main `7d3b2d7e3`
retains both conditions. Its PR-summary changes were merged into this branch
with a merge commit.
The final main probe at `46637e4c7` found the engine, both board report files
and the MCP error reader unchanged from `6b5d8509d`.

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
backoff. A paused pipeline remains paused. Stage, attempt, explicit launch and
survivor guards remain in force. Earlier activations hold the replacement until
the drain reconciles them. Any retained launch,
conversation, transcript, pane, start, completion, verdict or report excludes
this recovery path.

A stale pre-dispatch checkpoint checks registry admission, runtime, worktree
and the original stage membership before releasing custody. A receipt without
that binding retains activation custody and states the membership wait.
A matching receipt binds its launch and conversation to the original
attempt for normal receipt recovery. It grants no new dispatch permission.
An earlier attempt's admitted receipt retains activation custody until its
outcome settles, including across a controller restart. Without an admitted
receipt the stale activation is released; a settled predecessor keeps its
history and the pending replacement keeps its cursor.

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
bun scripts/local-gate-tests.ts --base 1771da2aa69a9420d96c304307168795539c1ae3 src/lib/pipelines/engine.recoveredPending.test.ts src/lib/pipelines/engine.provisioning.test.ts src/lib/orchestrator/boardReportRun.test.ts src/lib/orchestrator/boardReport.test.ts
```

The tests exercise one launch after pause/resume, replay after a real process
restart, admitted-receipt custody, request guards, retained evidence refusals,
controller publication waits, backoff preservation and board text. This is a
correctness change; no performance improvement is claimed.
