# Registry writes and cached writer snapshots

Repeated writer snapshots avoid rereading retained registry payloads. On the
fixed production copy below, a keyed write returning a snapshot reads one
payload row, with median wall time falling from 982.543 ms to 53.071 ms.

## Cause on main

The control is `917189ae562def76980341620987479ab2813cfc`, fetched from main
before implementation and rechecked before publication.

- `src/lib/agent/sqliteRegistryStore.ts:2839` calls `loadLazyInTransaction`
  at line 2855; the lazy loader starts at line 3125. Ordinary keyed mutations
  already use dirty-row persistence. The existing keyed-write test in
  `src/lib/agent/registry.sqlite.test.ts` also proves that behavior.
- `snapshot()` at lines 1185–1187 always calls `loadSnapshot(false)`. Its
  complete loader at lines 3112–3121 materializes every collection. A mutation
  requesting its returned snapshot reaches this path at lines 2918–2920.
- The scoped grant decision at line 3216 requires a nonempty cold-key map.
  Without that map, a keyed granted-row write falls back to an assembled
  decision over unrelated rows.
- Replacement change tracking at line 3573 overwrites the computed delta with
  all current keys and `Object.keys(baseline)`. The baseline is a Map, so this
  also loses deleted keys.

The earlier research generalized the bulk-compaction cost to every mutation.
The ordinary keyed-write control below already reads one payload row on main.
The reproducible failures are returned snapshots, repeated writer snapshots,
the grant decision without cold markers, and collection replacements.

## Red and green checks

`bun test src/lib/agent/sqliteRegistryStore.keyedWrites.test.ts` ran against
an export of the control before source changes. A single-row mutation returning
its snapshot read **258 payloads for 257 stored rows**. A second unchanged
writer snapshot read all 257 again. A single granted receipt edit without cold
markers read 817 payloads in a 1,072-row fixture. Replacement also left its
removed row behind.

The corresponding final counts are **1**, **0**, and **4**. A trigger recording
payload UPDATEs proves that a replacement writes only its changed receipt,
removes its deleted receipt, and preserves row order. Additional checks cover
rollback, no-op writes, peer writes with and without a revision increment,
cold grant revocation/restoration, owner defaults, malformed archived owners,
detached snapshots after
close, numeric watchdog attribution, and asynchronous admission beside a
separate process holding the writer lock.

The cache limit is checked in fresh Bun processes at the exact serialized UTF-8
byte limit, one byte below it, and zero, including escaped and multibyte text.
An eager load through the original loader remains the independent JSON and
ordering oracle for the new writer view.

## Implementation

The store retains one current writer source, bounded to **256 MiB of complete
normalized JSON**, including keys, separators and metadata. An oversized source
is returned without retaining it. A replaced database and close clear the
cache; cooperative preparation transfers its owner to the prepared reader.
The process-wide registry singleton owns the production store, including across
compiled Next server bundles.

The immutable reader already validates revision and store stamp, including
unversioned peer writes. The writer source follows that validated view. It
reuses unchanged row values by hot-row identity or immutable archive version,
pinned grant lists, and the referenced delivery's version for operation owners.
Callers receive independent mutable objects; row copying happens when they read
a returned row. JSON serialization and structuredClone still produce the
complete snapshot. Every returned snapshot pins values independently of the
database and remains usable after close or file replacement.

Grant-bearing mutations use the existing scoped decision in both storage
layouts. Transaction-local attestors, grant fences, optimistic retries, writer
admission and commit ordering keep their existing paths. Collection replacement
keeps the computed payload delta and persists the requested order separately.
When a malformed archived row normalizes away, the writer uses its original
eager loader to preserve legacy owner synthesis. There is no schema change.
`registry.writer-snapshot` is registered in the
static performance site table so the watchdog can attribute this work.

## Method and load

One read-only SQLite backup of production supplied all samples. The backup
contains **46,527 rows**, **162,774,508 stored JSON bytes**, **45,952 cold-marked
rows**, at registry revision **402086**. Its SHA-256 is recorded in
[evidence/registry-keyed-writes.json](../../evidence/registry-keyed-writes.json).
No production process was profiled or snapshotted.

Each workload starts from a fresh copy of that same backup. Before and after
run in separate Bun 1.4.0 processes with private HOME, XDG_CONFIG_HOME,
LLV_STATE_DIR and TMPDIR. One `scripts/gate-slot.sh` admission contains the
sequential process sequence **before, after, after, before, before, after**.
The gate's CPU quota applies to the whole sequence. Source hashes in every
report identify the measured store, registry, performance sites and driver.

The reusable driver is `scripts/registry-write-benchmark.ts`. Each process runs
five workloads. Each workload warms one writer snapshot, forces GC once before
timing, then performs 12 operations with 25 ms before and 15 ms after each.
The bulk control performs two operations. Keyed writes edit the first receipt
in persisted order through `withWriter` and `mutate`; their iteration values are
identical between variants. Snapshot reads return the object; the separate JSON
workload consumes every row. The bulk control runs the real public
`deliveryWrite(compactDeliveryReservations)` with logical time frozen at
`2026-10-16T08:00:00.000Z`; it opens a fresh AgentRegistry alongside the warmed
store and includes constructor work.

Read bytes are deltas of Linux `/proc/self/io` rchar, including SQLite reads
served from the OS cache and the small measurement reads. Payload counts come
from the store's existing observers. Wall time uses performance.now. Observed
peak heap uses Bun's process.memoryUsage().heapUsed after operations, at batch
reads, and every 2,048 parsed rows. Peaks between samples can be missed. The
10 ms independent timer measures excess delay; the real Viewer loop monitor
also runs and records its gaps above 500 ms. This exercises the Viewer's registry
executor and monitor in isolation. Browser and whole-application traffic are
outside this load.

A run from either source export uses the same driver copied from this change:

```sh
mkdir -p "$RUN/home" "$RUN/config" "$RUN/state" "$RUN/tmp"
HOME="$RUN/home" XDG_CONFIG_HOME="$RUN/config" \
  LLV_STATE_DIR="$RUN/state" TMPDIR="$RUN/tmp" \
  bash scripts/gate-slot.sh bun scripts/registry-write-benchmark.ts \
  "$OFFLINE_REGISTRY" "$RUN/result.json" "$LABEL" 12
```

`RUN` is a fresh directory under the stage's owned scratch root and
`OFFLINE_REGISTRY` is the immutable offline backup. Never supply a live database.

## Measured before and after

Wall time, bytes and payload rows are medians of all operations across three
runs per variant. Heap is the largest observed sample across those runs.
MB uses 1,000,000 bytes; MiB uses 1,048,576 bytes. Arrows show before → after.

| Workload | Payload rows/op | Read MB/op | Wall ms/op | Observed peak heap MiB |
| --- | ---: | ---: | ---: | ---: |
| Keyed write, no returned snapshot | 1 → 1 | 0.000137 → 0.000168 | 4.387 → 3.959 | 12.2 → 340.1 |
| Unchanged writer snapshot | 46,527 → 0 | 906.698565 → 0.000132 | 982.409 → 0.387 | 884.1 → 477.0 |
| Writer snapshot plus full JSON | 46,527 → 0 | 906.705156 → 0.031525 | 1429.534 → 1171.631 | 736.8 → 609.3 |
| Keyed write plus returned snapshot | 46,528 → 1 | 907.020523 → 0.001868 | 982.543 → 53.071 | 888.5 → 503.5 |
| Bulk compaction control | 20,765 → 20,765 | 551.641604 → 551.641532 | 1543.640 → 1508.970 | 704.8 → 739.5 |

The compaction payload-count median is 20,765: each pair reads 20,766 then
20,764 payloads. Its read volume is unchanged. The ordinary keyed-write workload retains its original single-row behavior.
Its observed heap sample rises from 12.2 MiB to 340.1 MiB after warming the
writer cache; the table records its operation times separately.

Timer quantiles below are the medians of each run's quantiles. Maximum is the
largest delay in any of the three runs. All values are milliseconds.

| Workload | Gap p50 | Gap p95 | Gap p99 | Gap max |
| --- | ---: | ---: | ---: | ---: |
| Keyed write, no returned snapshot | 0.080 → 0.082 | 5.017 → 4.678 | 5.348 → 5.904 | 12.493 → 6.543 |
| Unchanged writer snapshot | 0.125 → 0.079 | 1099.674 → 0.860 | 1161.455 → 2.382 | 1204.420 → 6.329 |
| Writer snapshot plus full JSON | 0.172 → 0.372 | 1629.491 → 1199.953 | 1986.853 → 1620.902 | 2049.748 → 1722.253 |
| Keyed write plus returned snapshot | 0.368 → 0.097 | 1149.830 → 55.592 | 1341.867 → 221.495 | 1519.546 → 365.870 |
| Bulk compaction control | 6.231 → 1.051 | 1572.853 → 1567.645 | 1572.853 → 1567.645 | 1794.560 → 1692.736 |

The first writer source is more expensive: in the unchanged-snapshot workload,
its cold median rises from **1,215.643 ms / 906.686 MB** to
**2,709.075 ms / 932.292 MB**. Warm reuse pays that initial cost back. Full JSON
serialization still traverses and copies every row, with a 1,171.631 ms median
and a 1,722.253 ms maximum timer gap in the candidate. Bulk compaction retains
its whole-candidate scan. These measurements establish the snapshot and keyed
write behavior above; they do not establish a production-wide CPU reduction.
Cold-row retirement, MCP process placement and remaining synchronous callers
remain separate work.

Raw final samples, completion timestamps, individual operations, source hashes,
pilot samples and failed/partial experiment records are in the evidence JSON.
An initial run exposed the missing watchdog site; a later in-parse JSC heap
census was cancelled because the census itself dominated the control. Both are
excluded from the final table. The final six runs use the lightweight counter
and identical instrumentation.

## Shared hunks and coordination

[PR #2930](https://github.com/Latand/delegatus/pull/2930), at its checked
candidate `97c1a8bc`, changes MCP bindings, the task executor and server
initialization. It changes neither `registry.ts` nor `sqliteRegistryStore.ts`.
This change preserves the mutate, withWriter, snapshot and readOnlySnapshot
signatures. The additional cache-limit option is internal to store construction
and defaults at its existing producer. Its performance site is appended to the
static table; the MCP lane's operation taxonomy is in viewerLoopMonitor.ts.
**Shared hunks: none at the checked revisions.**

The idle-worker lane keeps registry interfaces and both registry source files
unchanged. The form-answer and hook-guard branches had no registry changes when
checked. Their executors, controller scheduling, form delivery and hook setup
are outside this diff.

## Verification

All checks ran in the isolated source export through the gate wrapper.

- Type check: `bun node_modules/typescript/bin/tsc --noEmit --incremental false`.
- ESLint: the six changed TypeScript files, including the benchmark and tests.
- **221 tests passed, zero failures**, across these explicit paths:
  `sqliteRegistryStore.keyedWrites.test.ts`, `performanceSpans.test.ts`,
  `registry.sqlite.test.ts`, `sqliteRegistryStore.readOnlyView.test.ts`,
  `sqliteRegistryStore.refresh.test.ts`, `mcpAllowlist.test.ts`,
  `registry.writerWait.test.ts`, `registryArchive.test.ts`, and
  `sqliteRegistryStore.history.test.ts` (agent paths are under `src/lib/agent`;
  performance spans is under `src/lib`). Commands and group counts are in the
  evidence record.
- Privacy publication gate with committed fingerprints and
  `--require-known-values`: all changed files and the prepared PR body passed.
- Fetched main and ran `git merge --no-edit origin/main`; main remained at the
  recorded control and Git reported already up to date.

The original checkpoint test passed on the control. Its old expectation that a
checkpoint must reload a complete snapshot was updated to require no reload,
18,000 persisted receipts and the current `_sqliteRevision`. Its first updated
assertion used the wrong JSON field; that test-only error was corrected before
the final green run. No runtime-host source or Bun pin changed.
