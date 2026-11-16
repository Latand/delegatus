# Worktree sweep completion and bounded retention

The sweep repeated repository and registration discovery in every slice. After
checking one repository, discovery of the remaining repositories spent the same
clock as candidate checks. Its fair scan also revisited unchanged kept paths.
Pressure observations could advance the idle timer repeatedly, while observations
using the busy retirement helper failed instead of measuring volumes.

The helper now owns one bounded registration inventory for a full pass. Source
repository membership, registration membership and metadata, HEAD/lock files,
loose refs and packed refs invalidate it. Discovery finishes before the slice
clock starts. Each slice checks at most 16 candidates and guarantees four when
that many remain. A failed inventory is never reused. A restarted helper
rediscovers registrations and resumes the persisted queue and verdict deadlines.

Unchanged kept paths wait for their next observation interval or verdict deadline.
Changed live guards and ownership enqueue them again. Nested registrations remain
removal guards. Every removal still refreshes registration, HEAD, contents,
activity, retention and preservation proofs. Candidate caching supplies no removal
authority. Protected roots and dry-run removals retain their pass scheduling clock
without recreating deferred rows during later slices.

A separate leased helper owns pressure observations. Polls coalesce and retain the
existing observation TTL and deadline. A full pass that actually freed zero bytes
holds pressure requests until the normal interval, including after a scheduler
restart. Pressure cannot advance a continuation or repeatedly replace an already
advanced timer.

Candidate inventories observe only checkout roots, expire within an hour and
retain at most 512 native directory observers. Allocation inventories have a
separate 2048-file-observer cap and bound capture before building oversized
snapshots. Discovery retains at most 16384 entries and 4 MiB of inventory; its
metadata stamp streams into a digest under a byte budget. Completing a full pass
ends the retirement helper lease before queued work can start, releasing decoded
history, native observers and allocator memory during the hourly idle period.

The report includes cumulative discovery time, per-slice discovery/check/accounting
time, full-pass elapsed time, slice count, visited worktrees per slice, actual
freed bytes across slices and completion time. These fields also reach resources.

## Fixture measurements

Two fresh isolated runs per tree used the same recorded driver and fixture:
495 worktrees across 33 repositories, 70 subdirectories each, simulated 1 ms Git
discovery calls and 1 ms candidate work, a 2 ms slice budget and a 160-slice limit.
Continuations ran immediately for measurement; their production scheduling delay
is excluded. All sweeps used injected fixture ports. No real repository or live
state was swept. Machine-readable values and measured source blobs are in
`evidence/perf/worktree-sweep.json`.

| Observation | Base, two runs | Changed, two runs |
| --- | --- | --- |
| Slice count | 160, 160; incomplete | 124, 124; complete |
| Checked worktrees | 320, 319 | 495, 495 |
| Remaining queue | 175, 176 | 0, 0 |
| Discovery calls | 10560, 10560 | 66, 66 |
| Discovery time | 11430, 11439 ms | 73, 73 ms |
| Total measured time | 12986, 12906 ms | 1986, 2205 ms |
| Pressure while sweep held | stale/busy refusal | observation in 218, 305 ms |
| Native directory observers | 32731, 32731 | 495, 495 |
| RSS after candidate inventory | 186.7, 189.7 MiB | 131.5, 128.4 MiB |
| Inventory RSS increase | 78.8, 76.4 MiB | 12.0, 13.3 MiB |

The serialized reports and inventories were below 0.5 MiB each. Native observers
held substantially more memory than those payloads on this fixture. The reported
multi-gigabyte live RSS was not reproduced or profiled; production remeasurement
remains with the release owner.

## Verification procedure

Run from a scratch export of the selected revision. Each command receives a
fresh `mktemp` root beneath the stage scratch directory, private HOME and all XDG
directories, `LLV_STATE_DIR` and TMPDIR. Unset `LLV_STATE_OWNER`, set `NODE_ENV=test`
and `LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`, and put verified native Git first
in PATH. Set `LLV_GATE_RUNNER=off` for comparable local measurements.

Commands run through the project gate wrapper, one explicit test file per owned
command, with separate recorded logs and terminal exit statuses:

- `bun scripts/measure-worktree-sweep.ts --phases`: exit 0 for both runs on each tree.
- `bun test ./src/lib/pipelines/worktreeSweepDiscovery.test.ts`: exit 0, 15 tests.
- `bun test ./src/lib/pipelines/worktreeSweepCache.test.ts`: exit 0, 15 tests.
- `bun test ./src/lib/pipelines/worktreeSweepWorker.test.ts`: exit 0, 39 lifecycle and protocol tests.
- `bun test ./src/lib/pipelines/worktreeSweep.test.ts`: exit 1, 406 passing and one matching failure on the base.

The base has a failing assertion in `an interrupted trim leaves a trash name the
next sweep finishes`. Its first assertion expects quarantine before the existing
interrupted-removal refusal. This lane preserves the refusal and relies on the
pre-push comparator to distinguish that existing failure from introduced failures.

The committed-tree pre-push hook is the final publication check. Its touched-test
selection runs the four sweep test files separately and compares red results with
main. Publication and three review rounds belong to the pipeline; deployment and
production remeasurement belong to the release owner.
