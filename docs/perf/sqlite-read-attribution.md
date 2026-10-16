# SQLite read attribution

The isolated synthetic scenario attributes at least 99.10% of each measured
pause to named synchronous work with byte counters. In the full-registry
window, `registry.deliveryOperationOwners.all` reads 460.6 MB and
`registry.receipts.all` reads 328.1 MB. These are local workload findings.
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
gap, and requires at least 80% attribution plus positive read and decoded-byte
counters. The operation envelope uses the existing `withViewerOperation`
entry point. The registry-owner case opens a fresh read-only store so an
already-decoded view cannot erase the workload.

## Recorded result

Recorded on 2026-10-16 at 15:47:14 UTC, Linux, Bun 1.4.0. MB means 1,000,000 bytes.
The read column is sampled main-thread `rchar`, including cached reads.

| Workload | Repetitions | Pause ms | Attributed time | Read MB | Decoded JSON MB |
| --- | ---: | ---: | ---: | ---: | ---: |
| pipelines | 27 | 756 | 100.00% | 814.2 | 810.2 |
| pipelines_archive | 8 | 773 | 100.00% | 731.3 | 720.2 |
| registry.snapshot | 1 | 958 | 99.10% | 913.9 | 212.7 |
| deliveryOperationOwners | 1 | 754 | 99.80% | 486.7 | 45.3 |

All four gaps report zero dropped reader records. The registry window reads
913.9 MB for 212.7 MB of decoded JSON: repeated SQLite page access can exceed
payload size. The owner-only case also reads receipt and conversation
attestors; its largest aggregate reader is `registry.all` (310.2 MB), followed
by `registry.receipts.all` (92.0 MB). Full archive and pipeline reads appear as
`state.pipelines_archive.all` and `state.pipelines.all`.

The owner-only case records 22,998 calls without an I/O sample. Byte values
are observed lower bounds; they are never extrapolated from sampled calls.
Decoded JSON bytes count attempted UTF-8 input, including a failed parse.

Three alternating enabled/disabled pairs per case retain the same data and
load. Median disabled/enabled wall times in ms are 34.27/35.98 (pipelines),
86.61/86.67 (archive), 857.27/864.28 (registry), and 776.66/710.86 (owners).
This comparison measures incremental counter cost with the connection
decorators present in both modes. It gives no production CPU estimate or
speedup claim.

## Accounting contract and bounds

`operations` gains `readBytes` and `decodedJsonBytes`. The additive `reads`
object reports per-operation totals and the top 16 readers, with synchronous
time, byte counters, sampled/unsampled/unavailable calls, failures, and bounded
connection-id samples. Each connection also owns lifetime counters, exposed by
`sqliteReadCounters`, in a shared WeakMap. Reopening a replaced database binds
decoders to the new connection. Neither statements nor connections acquire a
new lifetime owner.

Byte sampling starts at most 32 paired `/proc/self/task/<main-thread>/io`
measurements per 10 ms sampling window. The observer removes its own proc-file
bytes. `rchar` measures bytes returned by read/pread, including cache hits;
physical disk reads are a different quantity. Unsupported platforms, worker
threads, refused proc reads and regressing counters expose unavailable counts.
No page counts are inferred from returned JSON size.

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

`reads.namedSyncMs` sums exclusive synchronous frames within the timer window;
`reads.attributedFraction` divides that by the full window and caps it at one.
The scenario additionally clips attributed time to the reported pause duration.
Long awaited `operations.durationMs` remains separate. A GC inside a named
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

Focused tests cover real SQLite statements and iteration, transaction rollback,
failed SQL/JSON, file replacement, async interleaving, proc failure, counter
regression, overflow, process restart, and diagnostic privacy. The store suites,
type checker, changed-file lint, production Next.js/MCP build and privacy gate are run with
isolated roots and a closed control URL. Hosted checks follow pipeline
publication.

The final focused campaign covers 29 explicit test files. Two retain exactly
the same failures on the starting commit: `src/lib/reviewHistory/reader.test.ts`
(one unowned-import case) and `src/lib/externalRelay/ownerBridgeContext.test.ts`
(ten bridge-log admission cases). Changed-file lint retains three existing
errors and introduces none. The baseline and final case identities are recorded
in `evidence/read-attribution/checks.json`.

Transaction decoders receive the connection that supplied their row, including
controller selections, bounded writes, atomic moves and preserved-row checks.
A regression test first fails on the previous implementation and passes after
that connection is forwarded. Mixed collection reads and later bind slots keep
a generic reader label, avoiding a false attribution to the first argument.
