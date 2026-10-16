# Keyed registry writes, snapshots and compaction

This change addresses the archived-owner freshness defect and the registry
workload measured for PR #2958. It keeps the write transaction, revision,
ordering, durability and lock fences intact.

## Changes

An archived operation-owner accessor is reused only while the cold delivery
signature it depends on remains the same. When a delivery changes and is
archived again, a current snapshot rebuilds that owner against the delivery
pinned by the current reader. A snapshot already held by a caller keeps its old
delivery and owner values. The writer and prepared-reader paths share this
behavior.

The writer snapshot cache is built on the second call. The first call follows
the existing reader path. The cache retains at most 8,192 hot rows; cold rows
remain behind `mergedArchiveReader`. One store owns one cache. A changed
revision, changed storage stamp or database replacement refreshes or clears it.
If the hot-row count exceeds the bound, the store returns a detached snapshot
without retaining a writer cache.

Global delivery compaction tracks changes in `heldDeliveries`,
`deliveryOperationOwners` and `conversationAliases`. A collection and sequence
index supports the cursor. A delivery or owner change selects only the
associated conversation rows through the existing registry index; an unchanged
cursor skips the mutation. The first pass, a trimmed journal, an alias change
and a due retention expiry keep the full reconciliation path. Compaction
semantics, retention order and fences remain unchanged.

Production `sqlite` writes call `mutate(..., false)` at
`src/lib/agent/registry.ts:5377`. The writer-snapshot measurements quantify
the snapshot API and its other callers; the compaction measurements cover the
production tick path.

## Before and after

Measurements used the same offline SQLite copy for all six processes: 46,909
rows, 164,805,759 stored JSON bytes, 46,268 cold rows, revision 405906. Bun
1.4.0 ran the current main export at `02f9301fc323` and the reviewed candidate
in the alternating order `main-1, candidate-1, main-2, candidate-2, main-3,
candidate-3`, under one `scripts/gate-slot.sh` admission. Each process used
private HOME, XDG_CONFIG_HOME, LLV_STATE_DIR and TMPDIR. The identical driver
ran five workloads from fresh copies, with three writer operations per
workload, and performed three unchanged compaction ticks plus three ticks
after one new delivery per conversation. Each workload forced GC before
sampling.

The first-snapshot row reports the median of the three first calls in the
`writer-snapshot` workload. Startup includes opening the store. Peak heap is
the maximum sampled `process.memoryUsage().heapUsed` over all five workloads
and all three runs. MB is decimal. Reads are Linux `/proc/self/io` rchar,
including cached reads and measurement overhead.

| Measure | Main | Candidate |
| --- | ---: | ---: |
| Store open, ms | 265.205 | 286.079 |
| Store open plus first snapshot, ms | 3,054.783 | 916.807 |
| First snapshot, ms | 2,792.847 | 614.405 |
| First snapshot read MB | 908.110 | 683.708 |
| First snapshot payload rows | 46,909 | 719 |
| Subsequent writer snapshot operation p50, ms | 3,203.087 | 23.972 |
| Single keyed write p50, ms | 8.720 | 13.995 |
| Single keyed write read MB | 0.000559 | 0.014408 |
| Keyed write with snapshot p50, ms | 3,399.763 | 108.672 |
| Keyed write with snapshot read MB | 908.536 | 0.389 |
| Full JSON serialization p50, ms | 4,083.772 | 10,794.511 |
| Full JSON serialization read MB | 908.200 | 247.754 |
| Maximum sampled JS heap across all five workloads, MB | 1,168.531 | 637.700 |

Each paired candidate run had lower store-open-plus-first-snapshot time,
first-snapshot time and sampled peak heap than its main run. This copy had 641
hot rows; cold rows stayed lazy. The full JSON serialization workload was
slower on the candidate (10.795 s versus 4.084 s median) while reading fewer
bytes. Production SQLite writes call `mutate(..., false)`, so this serialization
path and the writer snapshot API are not used by the production write path.
The one-row keyed write was 5.3 ms slower at the median, with about 14 KB of
read traffic instead of 559 bytes; its payload-row count remained one.

### Delivery compaction per tick

Each value is the median of the three run-level medians. The initial pass is a
full reconciliation. The unchanged and one-change rows use three ticks per
run. The sampled heap-growth column is the peak live JavaScriptCore heap growth
over the pre-operation `heapSize` baseline. It records concurrent heap
pressure at sample points; cumulative object allocations remain unmeasured.

| Tick | Wall ms | Read MB | Payload rows | Sampled heap growth MB |
| --- | ---: | ---: | ---: | ---: |
| Initial full reconciliation, main | 2,560.473 | 546.922 | 20,940 | 351.896 |
| Initial full reconciliation, candidate | 2,281.512 | 546.954 | 20,940 | 378.117 |
| No relevant changes, main | 3,571.473 | 547.172 | 20,940 | 235.408 |
| No relevant changes, candidate | 42.668 | 0.002145 | 0 | 0 |
| One changed conversation, main | 3,452.429 | 547.255 | 20,946 | 388.485 |
| One changed conversation, candidate | 63.996 | 0.071777 | 8 | 0.000472 |

The candidate's initial full pass read and decoded the same rows as main; its
sampled heap-growth proxy rose by 26.2 MB while median wall time fell by 279 ms.
The steady ticks avoid the whole-history owner walk: unchanged ticks read no
row payloads, and one-conversation ticks read eight in this workload.

| Loop-gap measure during compaction load | Main | Candidate |
| --- | ---: | ---: |
| Independent 10 ms timer p50 gap, ms | 1.186 | 0.103 |
| Independent 10 ms timer p95 gap, ms | 3,898.787 | 415.262 |
| Independent 10 ms timer p99 gap, ms | 5,486.571 | 2,300.223 |
| Viewer monitor gaps above 500 ms, median count | 7 | 1 |
| Viewer monitor p95 gap, ms | 5,485 | 2,300 |
| Viewer monitor p99 gap, ms | 5,485 | 2,300 |

The timer p95/p99 and Viewer monitor distributions include the initial full
pass, which remains the largest candidate gap. The allocation column above is
sampled live heap growth, not cumulative allocation volume.

## Driver and verification evidence

The reusable driver is
[`scripts/registry-write-benchmark.ts`](../../scripts/registry-write-benchmark.ts).
The six raw reports, load description, input digest, source hashes and derived
medians are in
[`evidence/registry-keyed-writes-review-rerun.json`](../../evidence/registry-keyed-writes-review-rerun.json).
The database was an offline copy; no live process or state was profiled or
snapshotted.

Focused checks cover delivery re-archive with and without a prepared reader,
held snapshot values, lazy hot/cold writer snapshots and the row-count bound,
keyed replacement behavior, and compaction's one-conversation reads, no-op
skip, expiry wake and cursor rebuild after a real process restart. The related
registry SQLite and registry test files exercise the burn-in checkpoint,
ordering, revision and fence paths.

PR #2930 was checked at head `8f2f1e1f`; its files were MCP bindings, the task
executor and server initialization. It touched neither `registry.ts` nor
`sqliteRegistryStore.ts`; its `viewerLoopMonitor.ts` operation label is outside
this patch's diff. Shared hunks were absent. This change keeps the existing
mutation, writer admission, snapshot and reader interfaces.

The branch incorporates the clean advance of `origin/main` to
`02f9301f`. PR #2957's `prototype.delivery` and PR #2963's
`controller.account-migration` labels in `viewerLoopMonitor.ts` are part of
that base. This patch leaves the monitor unchanged and includes its source
hash in the repeated measurement. Open PR #2926 adds structured-host
signal-domain fields in `registry.ts` and startup triggers in
`sqliteRegistryStore.ts`; its hunks are separate from the delivery compaction,
owner-reader and writer-cache changes here. Open PR #2962 adds another
ViewerOperation label in `viewerLoopMonitor.ts`, which this patch leaves
unchanged. Shared hunks with these checked changes: none.

Cold-row retirement, MCP process placement and remaining synchronous registry
callers remain outside this change.
