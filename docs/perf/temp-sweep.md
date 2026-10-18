# Temp sweep and disk-pressure scans (L6)

`runTempSweep` and `readDiskPressure` now use the existing leased
`worktree-sweep` helper. The helper owns process scans, worktree-root volume
probes, disk report transactions and consumer measurements. Its existing
30-second observation cache remains there. MCP keeps reading the authoritative
report without probing volumes. Provisioning still checks its bounded set of
write destinations; the host namespace comes from the same PID 1 anchor that
already determines those destinations, without enumerating processes.

The deletion policy in `sweepStaleTempDirs` is unchanged. Root discovery,
fresh process checks before deletion, namespace validation, young-directory
holds, Git preservation, quarantine recovery and report persistence all run
in the helper. Explicit inspection ports keep the existing policy tests local.

## Helper contract

The timer in `startTempSweep`, the resources reader and the seat disk-pressure
reader use the shared helper client. The existing worktree producer also uses
that client; the source worker and its test fixture consume the three request
kinds. The production defaults dispatch to the helper. MCP and callers with
explicit test ports retain their existing local reader behavior. The pipeline
engine's synchronous admission interface is unchanged.

There is one process-global helper, one active request and at most one job for
each of worktrees, temp and disk pressure. Repeated temp calls and disk refreshes
join their pending job. Jobs serialize, including report writes. A validated
disk-pressure reply is retained by the Viewer client for its 30-second
observation window and returned immediately during a sweep. A stale or missing
observation during an active temp/worktree sweep fails immediately without
queueing; the next idle read can refresh it through the helper under a 10-second
request deadline, capped by the worker's configured timeout. Closing the worker invalidates queued jobs and ends its leased
process group before returning. Replies retain the 8 MiB limit and are checked
against the requested report kind. Only the two temp-policy settings cross the
request protocol; filesystem inputs are resolved in the helper.

## Measurement

[evidence/perf/temp-sweep.json](../../evidence/perf/temp-sweep.json) records
all samples, load, measured revision and hashes of the measured sources.
The recorded rerun uses `scripts/measure-temp-sweep.ts` with `--before` and
`--after` under `scripts/gate-slot.sh`, with independent HOME, XDG_CONFIG_HOME,
LLV_STATE_DIR and TMPDIR roots. Runtime: Bun 1.4.0; CPU quota: 300%.

The synthetic procfs has 340 processes and exactly 44,000 path references;
932 empty worktree roots share one volume. Before mode executes the original
scan/probe operations. After mode exercises the production dispatch functions
and leased client against the fixture helper, which runs the production temp
function in dry-run mode against controlled roots. T2 makes a helper request on
every sample. H3 run 0 refreshes through the helper; runs 1–3 hit the Viewer
client's fresh 30-second cache and bypass the helper. Each sample records its
execution path, source revision and load. No operator temp directory is swept.

The repeated before/after samples all ran at load 3.70 / 6.26 / 6.63. The
table separates H3's helper refresh from its three client-cache reads:

| Case | Parent CPU before → after | Largest loop interval before → after | Wall time before → after |
| --- | --- | --- | --- |
| T2 helper request (4 samples) | 17.2–26.7 → 1.0–1.2 ms | 17.1–21.4 → 1.1–2.1 ms | 15.4–19.7 → 20.8–24.2 ms warm |
| H3 helper refresh (1 sample) | 22.9 → 1.7 ms | 20.6 → 2.0 ms | 18.9 → 21.1 ms |
| H3 Viewer cache hit (3 samples) | 18.2–33.4 → 0.09–0.14 ms | 17.9–30.5 → 1.1–1.8 ms | 17.2–28.8 → 0.09–0.14 ms |

The first helper launch (T2 run 0) took 154.1 ms wall time and 34.1 ms parent
CPU, with an 8.9 ms largest loop interval. Every after interval is below
50 ms; the H3 helper refresh used 1.7 ms parent CPU, and cache reads used
0.09–0.14 ms. CPU includes timer callbacks while awaiting the helper. These
are synthetic costs; the audit's production H3 replay measured 57.2–80.7 ms
before. This fixture has fewer filesystem calls per reference than that
installation, so it does not reproduce that magnitude.

## Verification

Run explicit files with fresh isolated state through the gate wrapper:

```sh
bash scripts/gate-slot.sh bun test src/lib/pipelines/worktreeSweepWorker.test.ts src/lib/tempSweep.test.ts src/lib/state/diskPressure.test.ts
```

The latest isolated run passed 143 tests. `src/lib/tempSweep.test.ts` is unchanged. Added
checks cover shared dispatch, poll coalescing, report-kind validation,
malformed/oversized responses, process exit, deadline containment, queued
cancellation after readiness, helper restart, production reader caching and
absence of parent process scans/volume probes. Admission still detects a
critical host destination without a process scan.

Reusing an earlier run's isolated disk-pressure report caused two existing
state-dependent tests to fail; both also failed on the base with a copy of
that state. The final run used fresh state and passed.

Full `tsc --noEmit`, ESLint on the changed code and the privacy publication
gate passed locally. Hosted `typecheck`, `privacy-publication`,
`privacy-tracker-audit` and `runtime-gate` were not run: this stage does not
publish the branch.
