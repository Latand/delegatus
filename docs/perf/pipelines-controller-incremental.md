# Incremental pipeline controller pass

The controller selects at most four lanes from the durable dirty/due queue and
fair cursor. Each lane selects sixteen retained attempts plus its current
attempt. The engine now completes each lane independently. A snapshot conflict
or refused evidence keeps that lane pending without acknowledging its window;
the other selected lanes continue. A deferred lane advances the durable fair
walk while retaining its attempt window, so repeated refusals cannot starve
later lanes, including after a process restart. Preparation checks selected row revisions
and decoder authority before entering its callback. An unrelated row write
cannot invalidate that preparation.

CPU admission treats a changed snapshot as a deferred observation. It keeps
existing tickets and their FIFO age until a complete observation is available.
Other queue errors retain their diagnostics. Existing port, row, delivery and
publication authority checks still guard actuation after awaited evidence.

Controller selectors, synchronous collection reads used by aliases, and
synchronous import-marker reads share one read-only connection across the
controller’s compiled modules. It has one slot; changing
the database closes the previous handle. The current-database wrapper reopens
replaced files. Shared statements finish synchronously and carry no transaction
or live iterator over an await. Unscoped callers that require pinned snapshots
keep their private transaction. Decoded controller candidates retain the
existing revision/authority cache bounds of 64 pipeline rows and 16 MiB.

The archive sweep selects sixteen source rows per transaction and reads target
rows only by the selected keys. Each page moves its source and destination rows
atomically, releases both leases, then yields. A failed page rolls back that
page; previously completed pages remain valid and the next sweep resumes by
scanning the remaining source rows. A captured row-order ceiling bounds a sweep
against concurrent additions. The existing schema and persisted record format support these changes.

All controller work reuses the existing loop-monitor operation labels:
`pipelines.controller-schedule`, `pipelines.controller-read`,
`pipelines.controller-select`, `pipelines.controller-decode`,
`pipelines.controller-mutation` and `pipelines.controller-checkpoint`.

## Reproduction

Run the existing `scripts/measure-pipeline-controller.ts` with `AUDIT_SEEDED=1`
in a clean source export through the project's supplied `gate-slot.sh`. Set
`AUDIT_RUN` to a fresh run directory, `LLV_STATE_DIR` to its `state` child,
`TMPDIR` to its `tmp` child, HOME and XDG_CONFIG_HOME beneath that temp root,
and `LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`. The driver refuses other roots
and guards network, spawn, signal and filesystem mutations before importing the
production controller. It writes `seeded-result.json` inside the run directory.

```sh
run=$(mktemp -d "$TMPDIR/controller-load.XXXXXX")
mkdir -p "$run/state" "$run/tmp/home" "$run/tmp/config"
bash scripts/gate-slot.sh env AUDIT_SEEDED=1 AUDIT_RUN="$run" \
  LLV_STATE_DIR="$run/state" TMPDIR="$run/tmp" HOME="$run/tmp/home" \
  XDG_CONFIG_HOME="$run/tmp/config" LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1 \
  bun scripts/measure-pipeline-controller.ts
```

The deterministic fixture has thirty open paused lanes with a current running
attempt, 232 settled rows in the active collection and 796 archived rows.
Each row retains sixteen attempts with synthetic output. Every simulated second
writes progress to one open lane, rotating through all thirty, then calls the
real bounded controller. Six hundred ticks represent ten simulated minutes.
This is a saturated polling workload; it does not sleep between simulated ticks.
External Git/runtime evidence is supplied through inert ports, and no agent is
launched. The measured interval excludes seed creation and its archive sweep.

Use identical drivers on the captured base and candidate source, alternate three
before/after pairs in fresh processes, and compare `seedSha256` before comparing
numbers. Each result records the corpus, all tick observations, load averages,
CPU count and available ancestor cgroup limits. Main-thread CPU uses Linux
`/proc/self/task/<pid>/stat` at 100 ticks/s. Read bytes use that thread's `rchar`,
which counts logical syscall traffic, including reads served by the operating
system page cache and counter sampling. CPU deltas are quantized to ten milliseconds; compare their
sum and mean across the full run. Tick wall time includes yielding.

## Measurements

Three alternating pairs ran on 2026-10-16 from 2026-10-16T16:53:34.752Z
to 2026-10-16T16:56:24.306Z. All six seed payload digests match. All 1,058 final authoritative payloads also
match within each pair, using sorted JSON keys and SHA-256. The
active collection contains 262 rows / 32,661,084 bytes; the archive contains
796 rows / 99,863,772 bytes. The tightest recorded CPU quota is three cores,
and the process memory limit is 8 GiB. Host load averages and all ancestor
limits are retained per run in the numeric evidence.

| Measurement | Before | After |
| --- | ---: | ---: |
| Main-thread CPU per 600-tick run, median | 28.49 s | 13.43 s |
| Mean main-thread CPU per tick, median | 47.48 ms | 22.38 ms |
| Tick wall time p50, median | 46.21 ms | 22.35 ms |
| Tick wall time p90, median | 66.42 ms | 32.72 ms |
| Maximum tick wall time, all 1,800 ticks | 157.40 ms | 71.41 ms |
| Logical main-thread read bytes per run, median | 1,901,502,052 | 869,478,490 |
| Read connections opened during the measured run, median | 11,960 | 0 |
| Deadline overruns above 15 seconds, all ticks | 0 / 1,800 | 0 / 1,800 |

Main-thread CPU falls by 52.9% and logical reads by
54.3% in this workload. The candidate opens its one shared reader
during seed preparation and reuses it throughout the measured ticks. The
evidence records source hashes for every changed runtime input and both common driver
files; those hashes identify the measured code independently of report edits.
An initial 600-tick baseline captured before runtime edits is retained separately
as `initialBeforeWitness`; comparative statistics use the six final paired runs.

Full numeric observations are in `evidence/perf/pipelines-controller-incremental.json`.

The baseline already meets the fifteen-second deadline on this synthetic
workload. This experiment judges reduced controller CPU/reading and preserves
that deadline result. It does not establish production latency, performance
while launching thirty agents, or a bound on arbitrary remote RPC latency.
The separate regression suite exercises stale replies, peer progress, CPU
queue observations, archive failure recovery and process restart custody.

## Verification

All checks use source exports with private HOME, XDG_CONFIG_HOME, TMPDIR and
LLV_STATE_DIR, a closed Viewer control URL, and the supplied gate-slot wrapper.
Each explicit test file runs in its own process. No live state is sampled.

The focused files pass: controller pass 40, CPU admission 20, controller lease 9,
pipeline store 52, bounded SQLite 11 and SQLite lifecycle 3 tests. TypeScript
passes; changed-file ESLint has zero errors and six existing warnings.

They cover independent lane retry and peer progress, durable fair
walking after restart, scoped decoder authority after an await, CPU ticket
custody, paged archive rollback and retry, and shared-reader replacement,
module duplication and fresh-process startup. The broader engine checks also
exercise provider budgets and release succession.

Baseline comparisons preserve seven existing failures: three update-custody
assertions in `engine.creation.test.ts` and `engine.ports.test.ts`, and four
repository-setup failures in `engineConnectionRefusal.test.ts`. The same cases
fail on the captured base under the same isolation. Tests that install hooks
need a private hooks directory with a placeholder file in the isolated Git template; supplying
that fixture prerequisite clears the hook-setup errors on both revisions.
No runtime custody or repository-admission change is included here.
