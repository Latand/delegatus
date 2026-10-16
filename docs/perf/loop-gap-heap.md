# Heap signals on loop gaps

Every `[viewer loop-gap]` JSON record includes `gc` and `heap`. The shared
monitor serves Viewer and runtime host; its existing role field distinguishes
them. The GC interval is `lastTick` through `tick`. `gapMs` subtracts the expected
10 ms timer delay from that interval.

| Field | Meaning |
| --- | --- |
| `gc.source` | `performance-observer` when the runtime advertises and admits GC observation; otherwise `unavailable`. |
| `gc.count`, `gc.ms` | Count of observed entries overlapping the interval and the union of their clipped durations in milliseconds. Both are null when observation is unavailable. |
| `gc.reason` | `gc-entry-unsupported`, `gc-observer-refused`, or `monitor-not-started` when unavailable. |
| `gc.coverage`, `gc.dropped`, `gc.late` | Supported observers report `observed-entries`, entries lost to the 128-entry bound, and entries delivered after their interval ended. Observation supplies partial evidence. |
| `heap.source`, `heap.deltaBytes` | `process.memoryUsage.heapUsed` and the signed difference between heap sample readings. A failed reading produces null and `heap.unavailable: heap-read-failed`. |
| `heap.sampleFrom`, `heap.sampleTo` | Monotonic poll timestamps bounding the heap proxy. Regular heap reads are 250 ms apart; every reported gap forces a fresh read. The starting sample can precede `lastTick` by up to 250 ms plus timer scheduling delay. |
| `heap.allocatedBytes`, `heap.freedBytes` | Null, with `allocationUnavailable: no-cheap-cumulative-counters`. The signed delta cannot separate allocations from reclamation or assign all change to the narrower GC interval. |
| `heap.beforeBytes`, `heap.afterBytes` | Heap readings at `heap.sampleFrom` and `heap.sampleTo`, included only when `gapMs > 1000`. An exact one-second gap omits them. |

On Bun, this heap reading describes survivors of the most recent collection,
including their external storage. It misses objects allocated since that
collection. A zero delta can conceal both allocation and collection. A shrinking
heap supplies a proxy for reclamation; it establishes no GC duration or cause
for the stall. Existing unresolved attribution remains unchanged.

The 10 ms timer reads the runtime heap at 250 ms cadence and forces a read
on every reported gap. It allocates a diagnostic object only for a reported gap. It forces no GC,
starts no profiler and takes no snapshot. GC observation starts and stops with
the monitor. It retains only bounded numeric timing records and ignores callbacks
from an earlier monitoring generation. The global monitor already has one owner
across compiled server bundles. Existing operation attribution, log queue bounds
and log parsers continue to use the same record.

## Runtime probe

The isolated probe records the exact Bun version and revision, advertised
performance entry types, GC entries delivered during six explicit collections,
heap readings before allocation and after collection, and the cost of four heap
APIs on two retained object populations. Forced collection belongs to that
standalone capability probe. Timed overhead runs use ordinary automatic GC.

The pinned runtime’s
[`Process_functionMemoryUsage`](https://github.com/oven-sh/bun/blob/34cbb9a40b4bd1bd767d134a7065e66c2432a676/src/jsc/bindings/BunProcess.cpp#L4080)
reads a cached collection result (and uses allocated block capacity until the
first collection). Its
[`functionHeapSize`](https://github.com/oven-sh/bun/blob/34cbb9a40b4bd1bd767d134a7065e66c2432a676/src/jsc/modules/BunJSCModule.h#L195)
calls `heap.size()`, which walks heap blocks. The scalar getter’s cost rises
with retained population in the probe, so it is excluded from the poll. The
[allocation-counter reference](https://bun.sh/reference/node/v8/getHeapStatistics)
describes `total_allocated_bytes` as cumulative; the pinned-build probe checks
that claim directly. Counter resets make subtraction unsuitable for allocation
volume across collections.

## Cost measurement

The accepted protocol alternates baseline and candidate in 200 ms blocks in
one warmed Bun VM on one fixed CPU. Both code paths remain loaded. One owned
watchdog stays alive throughout. A self-scheduled 10 ms timer calls the active
monitor's real `tick`; its heap sampler starts normally. The unchanged
scheduler-history serialization is absent from both arms, while whole-process
CPU includes the resident watchdog and GC helper threads.

Idle waits for ten scheduled 20 ms frames per block. Load performs three JSON
round trips over 10,000 fixed rows per frame. Each arm also receives one 550 ms
and one 1100 ms stall, exercising gap serialization and the heap detail
threshold. Order alternates between pairs. Checksums, frame counts and CPU
affinity must match. There are 600 pairs per workload. Native `process.cpuUsage`
provides user plus system CPU; 100% represents one fully occupied core.

For each pair, subtract baseline CPU/wall from candidate CPU/wall and multiply
by 100. The budget uses the paired mean plus 2.2 standard errors, a conservative
95% t bound for this sample count under the paired-sample model. Both upper
bounds must be below one additional CPU percentage point. Raw block values,
relative CPU changes, dispersion, sample counts and resource limits are retained.
Single-block differences include GC and scheduling noise.

The fresh-process baseline-versus-baseline control produced load differences
as large as 4.34 percentage points in magnitude with identical active code.
Long phases that repeatedly started workers also left a wide confidence bound.
Those controls and rejected protocols stay in `rejected-sampling.json` and
`control.json`; they establish no sampling-cost bound. The accepted protocol
keeps the worker resident and puts the two arms next to each other in time.
These synthetic measurements quantify added monitoring work under the recorded
conditions. Production CPU and stall frequency remain unmeasured.

## Reproduction

Use a scratch export of the candidate and a baseline copy of
`src/lib/viewerLoopMonitor.ts` from the recorded main revision, placed beside
it as `viewerLoopMonitor.baseline.ts` in the export only. Install frozen
dependencies. Give the export private HOME, XDG_CONFIG_HOME, TMPDIR and
LLV_STATE_DIR. Pick one allowed CPU (`BENCHMARK_CPU`; the recorded run uses 8).
Run heavy commands serially through the installed `scripts/gate-slot.sh`:

```sh
bash "$GATE" bun scripts/benchmark-loop-heap.ts --probe
bash "$GATE" taskset -c "$BENCHMARK_CPU" bun scripts/benchmark-loop-heap.ts \
  --blocks src/lib/viewerLoopMonitor.baseline.ts src/lib/viewerLoopMonitor.ts 600 10
bash "$GATE" bun test src/lib/loopHeapSignals.test.ts \
  src/lib/viewerLoopMonitor.test.ts src/lib/performanceSpans.test.ts
```

`--blocks` requires a runtime without GC observer entries. When GC observation
becomes available, retake the capability and cost measurements, including the
observer's background work. The driver also retains `--paired` for long phases
and its default fresh-process comparison; add `--control` to the latter for a
baseline-versus-baseline control with both modules preloaded.

## Verification

The focused tests cover null unavailable counters, signed heap movement,
failed/invalid reads, the exact one-second threshold, sampling cadence and its
window, bounded observer storage, late records, overlapping intervals, stale
callbacks, stop/start and fresh processes. Existing attribution and watchdog
tests remain unchanged.

Local full TypeScript, ESLint and production build checks passed. The local
runtime verifier refused the nested scratch layout's inbox path. A private
mount-namespace retry aborted even for an empty JavaScript program before any
project import. The required CI runtime gate runs the unchanged Viewer and
runtime-host rehearsals in its normal temporary environment; its verdict is
reported on the pull request.

## Recorded results

Completed **2026-10-16T15:14:10.489Z**, Bun **1.4.0**, interpreter revision
`34cbb9a40b4bd1bd767d134a7065e66c2432a676`. CPU affinity was 8; the owned gate's CPU quota was
three cores and its memory cap 8 GiB. The one-core affinity was the tighter
CPU limit. Both bounds passed the one-point budget.

| Workload | Pairs | Mean added CPU points | Conservative 95% upper bound |
| --- | ---: | ---: | ---: |
| idle | 600 | 0.0302 | 0.0742 |
| load | 600 | 0.1338 | 0.6336 |

Aggregate active-time CPU rate differences agree with the paired estimates: +0.0302 points at idle and
+0.1416 points under load. One-lag correlations of the paired differences were
+0.0061 and +0.0106 respectively.

[Accepted measurements](../../evidence/loop-gap-heap/overhead.json) retain every
block as a row, with explicit column names, source hashes, statistics and
resource windows. [Capability probe](../../evidence/loop-gap-heap/probe.json),
[zero-change control](../../evidence/loop-gap-heap/control.json) and
[rejected measurements](../../evidence/loop-gap-heap/rejected-sampling.json)
retain the calibration record. No values are rounded in the JSON.

The baseline source is main revision `02f9301fc32370210a4af533c1204741c6436f52`.
Integration includes main `93bbd3b54`; the intervening monitor changes
add operations to its TypeScript union. Transpiling the measured and
integrated monitors produced identical JavaScript hashes, recorded beside the
original and final source hashes. Both measurement arms include the merged
registry watchdog label. The heap sampler, span recorder and benchmark hashes match
the final source bytes.

The probe advertised no GC entries and delivered none during six explicit
collection calls. Its allocation counter fell from
49,682,109 to 2,017,562 bytes after releasing the retained objects.
This confirms the unavailable-counter fields. The cached process heap read
and the heap-walking alternatives were timed on 10,000 and 500,000 retained
objects; their per-call costs are retained in the probe JSON.
