# SQLite read attribution

The isolated synthetic scenario attributes 98.9–99.7% of each measured pause
to named operations with read or decoded bytes. In the full-registry window,
`registry.deliveryOperationOwners.all` reads 452.7 MB and
`registry.receipts.all` reads 315.1 MB. These are local workload findings.
Production confirmation follows deployment.

## Reproduce

Use an empty scratch directory and give HOME, XDG_CONFIG_HOME, TMPDIR and
LLV_STATE_DIR separate subdirectories inside it. Set
LLV_VIEWER_CONTROL_URL to a closed loopback port. Install frozen dependencies,
then run through the installation's admitted gate wrapper:

```sh
scenario_root="$(mktemp -d "${TMPDIR:?}/read-attribution.XXXXXX")"
mkdir -p "$scenario_root"/{home,config,state,tmp}
HOME="$scenario_root/home" XDG_CONFIG_HOME="$scenario_root/config" \
LLV_STATE_DIR="$scenario_root/state" TMPDIR="$scenario_root/tmp" \
LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1 \
bash scripts/gate-slot.sh bun scripts/benchmark-read-attribution.ts \
  evidence/read-attribution/local.json
```

The command requires explicit isolation and refuses an operator-owned state
root. It creates new synthetic SQLite files below a fresh fixture directory;
it reads no production state. The fixture remains available for inspection.
Each run records UTC, Bun version, its command, shape and SHA-256 hashes of the
measured sources. The checked-in result is
[evidence/read-attribution/local.json](../../evidence/read-attribution/local.json).

The state database has 262 pipelines with about 30 MB of JSON and 796 archive
rows with about 90 MB. The existing registry performance dataset supplies
53,299 retained rows and 212,738,843 JSON bytes. Each case repeatedly reads the
real store APIs for at least 750 ms, lets the monitor's real timer report its
gap, and requires at least 80% byte-backed operation coverage plus positive
read or decoded-byte evidence. Unproven read intervals remain unavailable and
their byte totals are lower bounds. The operation envelope uses the existing `withViewerOperation`
entry point. The registry-owner case opens a fresh read-only store so an
already-decoded view cannot erase the workload.

## Recorded result

Recorded on 2026-10-16 at 18:53 UTC, Linux, Bun 1.4.0. MB means 1,000,000
bytes. The read column is sampled thread `rchar`, including cached reads;
procfs collection for the serving thread runs in an independent worker.

| Workload | Repetitions | Pause ms | Attributed time | Read MB | Decoded JSON MB |
| --- | ---: | ---: | ---: | ---: | ---: |
| pipelines | 22 | 753 | 99.58% | 109.8 | 660.2 |
| pipelines_archive | 8 | 753 | 99.65% | 604.1 | 720.2 |
| registry.snapshot | 1 | 1,402 | 98.96% | 847.5 | 212.7 |
| deliveryOperationOwners | 1 | 1,256 | 100.00% | 0.0 | 45.3 |

All four windows exceed the 80% threshold. The byte totals are observed lower
bounds; unavailable reader intervals stay visible in the call counts. The full
registry window reads 847.5 MB for 212.7 MB of decoded JSON. Its largest
measured readers are `registry.deliveryOperationOwners.all` (452.7 MB),
`registry.receipts.all` (315.1 MB), `registry.conversations.all` (40.9 MB), and
`registry.entries.all` (38.7 MB). In the owner-only window, 463 `registry.all`
calls have unavailable byte intervals; 45.3 MB of JSON was decoded, while no
read interval was proven. Full archive and pipeline reads appear as
`state.pipelines_archive.all` and `state.pipelines.all`.

The owner-only case records 463 `registry.all` calls without a proven I/O
interval. A zero read total on a row is accompanied by unavailable-call
counts; it is not a measured zero. Byte values are never extrapolated from
sampled calls. Decoded JSON bytes count attempted UTF-8 input, including a
failed parse.

Three alternating enabled/disabled pairs per case retain the same data and
load. Median disabled/enabled wall times in ms are 33.83/41.28 (pipelines),
80.74/97.30 (archive), 1,474.48/1,485.76 (registry), and 986.28/1,426.30
(owners). Median paired enabled-minus-disabled differences range from +2.91
to +261.81 ms and vary by workload. The sampler reports 4.56–7.96 ms of observer time per
measured gap. These local figures describe this synthetic workload and do not
estimate production CPU use.

## Accounting contract and bounds

`operations` gains `readBytes` and `decodedJsonBytes`. The additive `reads`
object reports per-operation totals and the top 16 readers, with synchronous
time, byte counters, sampled/unsampled/unavailable calls, failures, and bounded
connection-id samples. `byteAttributedSyncMs` counts main-thread synchronous
time for operation names that carry measured read or decoded bytes;
`workerSyncMs` stays separate. Each connection also owns lifetime counters,
exposed by `sqliteReadCounters`, in a shared WeakMap. Reopening a replaced
database binds decoders to the new connection. Neither statements nor
connections acquire a new lifetime owner.

The serving and worker threads read only atomics from their own sampler worker;
neither opens procfs inside a measured callback. A sampler polls its target
thread's `/proc/<pid>/task/<tid>/io` counter every 10 ms and stops after a read
takes over 10 ms or three consecutive failures. Its time is reported as
`observerMs`, and a stopped or unavailable sampler is visible through
`samplerDegraded` and unavailable-call counts. Each synchronous frame gets a
temporary owner token. The sampler keeps a byte delta only across consecutive
samples with the same token; a reader receives it only when those samples fall
inside that frame. Stale snapshots, unowned intervals and frames with nested
readers count as unavailable, never as a measured zero or bytes for a later
reader. At most 32 byte observations are attempted per 10 ms window. `rchar`
measures bytes returned by read/pread, including cache hits; physical disk reads
are a different quantity. No page counts are inferred from returned JSON size.

Worker threads collect their own thread-counter deltas off-loop and send compact
batches to the parent through `attachReadAttributionWorker`. Worker durations
are reported as `workerSyncMs` with bounded start/end intervals and do not enter
main-loop `namedSyncMs` or `attributedFraction`. Each worker has at most one
unacknowledged batch and 256 queued reader events; parent retention is also
capped at 128 aggregates. `workerBatches`, `workerTransportDropped`, and the
regular dropped-record counters expose transport and retention overflow.
Worker intervals use epoch-millisecond endpoints so the parent can place late
batches on the same timeline as its own gaps. Worker identity and connection
samples stay on each aggregated reader row.

Synchronous frames subtract nested time and I/O. AsyncLocalStorage carries
only the static operation name across awaits. A peer's reads during an await
cannot enter the suspended operation's counters. Unscoped SQLite work uses
the fixed store/reader name. JSON decoding is measured at row parsers; the
existing runtime-frame parse span also supplies its input byte count.

There are at most 128 operation/reader aggregates per timer interval, eight
connection-id samples per aggregate and 16 emitted readers. Different
short-lived connections share an aggregate. Dropped records, time and bytes,
omitted readers and discarded connection-id observations are explicit.
Per-connection counters keep scalar values; WeakMap keys disappear with their
connections. Ordinary ticks clear the interval aggregates. There is no
per-read logging, row retention, SQL text or binding content in a diagnostic.

`reads.namedSyncMs` sums exclusive main-thread synchronous frames within the
timer window. `reads.byteAttributedSyncMs` sums those frames for operation names
that also carry measured read or decoded bytes; `reads.attributedFraction`
divides that value by the full window and caps it at one. The scenario
additionally clips attributed time to the reported pause duration. Long awaited
`operations.durationMs` remains separate. A GC inside a named
synchronous frame still belongs to that frame's elapsed interval; GC signals
can explain it independently.

## Connection and parser inventory

The constructor decorators cover the Viewer connection producers below. The
current-database proxy forwards their identity after replacement. Shared
consumers include query/prepare, cached statements, all/get/run/values,
iterator next/return, transaction callbacks, serialize and close. Write paths,
options, lock budgets and cleanup ownership are preserved.

| Producer | Reader label |
| --- | --- |
| `src/lib/state/sqliteStateStore.ts` (346, 364) | `state` |
| `src/lib/agent/sqliteRegistryStore.ts` (857, 875, 3832) | `registry` |
| `src/lib/team/store.ts` (238) | `team` |
| `src/lib/activity/store.ts` (210, 304) | `activity` |
| `src/lib/runtime/runtimeImageStore.ts` (284) | `runtime-image` |
| `src/lib/runtime/cpuAdmission.ts` (120) | `cpu-admission` |
| `src/lib/runtime/handoffQueueStore.ts` (33) | `handoff-queue` |
| `src/lib/runtime/deliveryProgress.ts` (609, 749) | `delivery-progress` |
| `src/lib/runtime/deploymentLedger.ts` (47) | `deployment-ledger` |
| `src/lib/search/transcriptSearch.ts` (264, 351) | `transcript-search` |
| `src/lib/telegram/bot/store.ts` (227) | `telegram` |
| `src/lib/telegram/bot/outbound.ts` (33) | `telegram-outbound` |
| `src/lib/state/durability.ts` (144, 163, 508, 606, 617) | `state-durability` |
| `src/lib/memory/index.ts` (128) | `memory-index` |
| `src/lib/mcp/boardSelection.ts` (32, 74, 105, 114, 126) | `board-selection` |
| `src/lib/mcp/server.ts` (1758) | `mcp-receipts` |
| `src/lib/externalRelay/ownerBridgeContext.ts` (28) | `owner-bridge` |
| `src/lib/reviewHistory/reader.ts` (43) | `review-history` |

SQL JSON parsing is routed through the connection-aware helper in stores that
materialize JSON. Transcript search and durability inspect SQLite scalar
columns; their other JSON parsers handle cursors, transcript files or worker
messages. Native SQLite JSON expressions remain inside the measured statement.

Remaining raw constructors outside the serving Viewer graph are explicit:
`src/lib/activity/pull.ts:58,69` (one-shot pull CLI),
`src/lib/agent/registryPerformanceDataset.ts:418,434` (synthetic fixture),
`src/lib/links/testServer.ts:178` (test server), and
`src/lib/agent/registryLockHolderFixture.ts:34` (lock fixture).
Runtime-host-only constructors are `src/runtime-host/journal.ts:433` and
`src/runtime-host/journalVacuum.ts:45,72`; candidatePerformanceRun constructors
belong to the isolated release rehearsal. This lane changes the Viewer and
its shared store helpers; it makes no runtime-host coverage claim.

## Integration and verification

The GC lane's current monitor diff was read before implementation. Its heap
signal hook and this additive read object merge cleanly in a three-way file
check. The MCP lane already conflicts with this lane's starting main in its
operation-name union and server capability block; this change adds no conflict
at either site. Its connection-lifetime policy remains outside this patch.
A final three-way comparison against current main is clean for all four overlapping source files; no merge was needed.

The corrected path-based run covers two touched test files and 24 tests,
including SQLite statements and iteration, worker reads, stale samples, nested
observer costs, overflow, process restart and diagnostic privacy. Typecheck,
changed-file lint and publication privacy use isolated roots and a closed
control URL. The broader pre-review campaign is retained in
`evidence/read-attribution/checks.json`; hosted checks follow pipeline
publication.

Transaction decoders receive the connection that supplied their row, including
controller selections, bounded writes, atomic moves and preserved-row checks.
A regression test first fails on the previous implementation and passes after
that connection is forwarded. Mixed collection reads and later bind slots keep
a generic reader label, avoiding a false attribution to the first argument.
