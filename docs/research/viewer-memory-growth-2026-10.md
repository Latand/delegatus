# Viewer memory investigation, 2026-10-05

Investigation for [#2512](https://github.com/Latand/delegatus/issues/2512).
Source and production build: `ee19907eb0dc9a9e39fc0fd23363d1869eb9b2e3`,
also the freshly fetched main at 15:13:24 UTC. The observed installation ran
`6af2bab08a5213955e900fb4cc5e76e11f0ee1de`. All times below are UTC;
MiB means bytes divided by 1,048,576.

At publication, main had advanced to
`dd6e3d32a0a4a36f8875e1844cf284d970c76a23`. A 15:34 UTC comparison found
no change to the investigated registry, state-store, scanner, resources,
title-projection or MCP server implementations, or the Docker runtime pin.
The updated package manifest still pins Next to 16.3.6.

**Result.** There is a reproducible registry retention defect: a reader's
parsed-row cache retains rows deleted through another connection. Ordinary
fixed-corpus HTTP polling showed modest route warm-up and stable connection
counts. Failed resource collections repeatedly allocate file projections;
their post-GC heap can stabilize while RSS remains elevated. The sampled live
Viewer had successful resource collection, so the earlier issue comment's
collector-failure explanation does not describe this sample. The reported
12 GB magnitude and approximately 20-second cycle remain **unattributed**.
They were reported from another installation, which cannot be inspected here.

The smallest supported product change is pruning externally deleted registry
rows from the reader cache during a complete collection reload. No product
change was made. Connecting this defect to the reported magnitude needs an
affected-process sample. The controller accepted this bounded investigation
with the attribution gap recorded; affected-process identity and polling
history will not be supplied to this stage. No live instrumentation is
authorized. The reader defect is a supported retention cause, with its impact
on the reported installation still unmeasured.

**Live observation and its limits.** This was one existing Viewer PID, with
its kernel start-time identity checked before every sample. Its executable was
resolved through `/proc/$VIEWER_PID/exe` and that executable answered `1.4.0`.
The build's installed Next package answered `16.3.6`. The command used Bun's
`--bun` option. A `nodejs` route declaration and the `next start` label do not
identify the interpreter. The host was Ubuntu 24.04, Linux 6.8.0-139-generic,
x86_64, glibc 2.39. Uptime at identity collection was about 22.1 hours.

The observation ran from **14:48:17 through 14:52:17**, with 121 samples at
two-second intervals. `/proc/$VIEWER_PID/status`, `smaps_rollup`, `stat` and
`fd` supplied these values; no requests or signals were sent to that Viewer.
The measurements cover the single web process. Agent hosts, the runtime host
and scanner/projection processes have separate address spaces.

| Metric | Minimum | Maximum | First | Last |
| --- | ---: | ---: | ---: | ---: |
| RSS, MiB | 1,780.09 | 3,173.82 | 1,784.06 | 2,163.14 |
| RssAnon, MiB | 1,696.98 | 3,090.71 | 1,700.95 | 2,080.03 |
| PSS, MiB | 1,723.22 | 3,088.63 | 1,731.17 | 2,108.83 |
| VmSwap / SwapPss, MiB | 0 | 0 | 0 | 0 |
| State database descriptors | 31 | 31 | 31 | 31 |
| State WAL descriptors | 29 | 30 | 29 | 29 |

The state database descriptor-number set at the endpoints was identical. The
single shared-memory descriptor remained present. Threads ranged from 49 to
51. Thirty-second RSS lower-water marks were 1,780.1, 1,810.7, 1,792.2,
1,787.4, 1,861.7, 1,804.1, 1,906.1 and 1,977.8 MiB. The late increase occurred
under ongoing work; four minutes cannot determine its long-term asymptote.
The trace contains irregular spikes and a late large spike. It does not
establish a regular 20-second oscillator.
An isolated local build overlapped part of this observation. Incoming work and
host pressure were uncontrolled. This window supplies a descriptive observation;
causal before/after effects were not measured.

Read-only context collection found a 32.75 MiB `state.sqlite`, zero-byte state
WAL at that instant, and a 36.11 MiB registry database. The persisted completed
file snapshot contained 308 visible entries and eight catalog projects; this
is a projection count, and does not measure all transcripts or registry rows.
No live database was opened for this investigation. Browser-tab counts,
per-route request counters and live heap/external-memory counters were not
available through the permitted observation surfaces.

The persisted resource observation completed at **14:50:32.622**, generation
343, status `complete`. Its worker build took 74.5 ms. The user service journal
contained no `[resources]` failures in the matching recent window. Reads by
the Viewer PID alone did not find forwarded messages; the service unit journal
was checked as well. The journal check establishes absence only in that
journal. Neither a restart nor cleanup, account/pool change,
heap snapshot, forced GC or debugger attach was performed on the live process.

**Ownership and retained graphs in today's code.**

| Owner | Retained data and lifetime | References |
| --- | --- | --- |
| Registry store | `rowCache` holds both `valueJson` and parsed objects per collection/key. `readOnlyCache` holds the latest assembled snapshot. Unchanged revisions reuse it; foreign changes reload it. | `src/lib/agent/sqliteRegistryStore.ts:392`, `:640`, `:1536` |
| Registry title projection | Two WeakMaps key projections by snapshot identity. They do not independently pin an obsolete snapshot; another strong reference can keep its projection alive. Resource titles use this projection. | `src/lib/session/titleProjection.ts:34`, `:148`, `:247` |
| File-scan coordinator | A global Map retains the completed snapshot; reader copies are made by `structuredClone`. Pinned snapshot/generation maps have an eight-entry limit. | `src/lib/scanner/scanCache.ts:98`, `:120`, `:642`, `:708`, `:772` |
| Scanner metadata | Named global Maps retain head/tail-derived metadata by path. The helper supplies no universal cardinality or byte cap. A fixed corpus can warm up; path churn needs separate measurement. | `src/lib/scanner/caches.ts:15`, `src/lib/scanner/describe.ts:104` |
| Hot-state collection | One parsed collection cache, including serialized row data, parsed records and ordered views. Revision change-log replay updates it; `snapshot()` clones records for callers. | `src/lib/state/sqliteStateStore.ts:919`, `:947`, `:1143`, `:1517` |
| Resource reader | One latest successful observation, bounded diagnostics and in-flight work. Its ten-minute success cache is bypassed when no success exists. | `src/lib/resourceCollector.ts`, `src/lib/resources.ts:51`, `:2406`, `:2494` |
| Files response worker | One resident projection worker handles a burst; it retires after 60 seconds idle or above 1,536 MiB reported RSS. Its memory is outside the web PID. | `src/lib/scanner/filesResponseWorker.ts:12`, `:446` |
| Transcript HTTP reader | Raw bounded chunks, with a 768 KiB tail window and a 4 MiB history ceiling. File handles close in `finally`; the route does not retain a full parsed transcript history. | `src/lib/logRead.ts:9`, `src/lib/scanner/roots.ts:101`, `src/app/api/log/route.ts:39` |

Private synthetic heap snapshots confirmed strong edges from `GlobalObject` to
`__llvFilesRouteScans` and `__llvCaches`, and collection objects to `readDb`
proxies and collection caches. At the 2,048-file board checkpoint, snapshot
shallow sizes included 17.33 MiB of code, 4.36 MiB of strings and 3.35 MiB of
closures. These are shallow sizes; dominator retained sizes were not computed.
String
contents, native allocations and allocator capacity require their own counters.
All four HTTP snapshots had 17 `Database` objects. The snapshots themselves
remain private.

**Confirmed external-deletion retention.** `parseRow` inserts into the store's
strong Map. A full collection load at `sqliteRegistryStore.ts:1259` parses
currently present rows without removing absent cached keys. Local mutation
deletions remove keys at `:1590`; that belongs to the writing store instance.
The reader's cache is cleared on database replacement or its own `replace`
operation, at `:595` and `:1091`. Those events need not happen during ordinary
cross-process traffic. The store therefore retains deleted JSON and parsed
payloads even when its newly assembled public snapshot is empty.

The shared profiler's `--registry-churn` case reproduced this at
**15:12:43.022–15:12:44.012**. It used two real `SqliteAgentRegistryStore`
connections to a private SQLite file and the production normalizer. Each cycle
inserted 200 structurally valid synthetic completed migration-intent rows, with
100 invented request IDs each. The reader loaded them; the writer deleted
them; the reader reloaded; then isolated full GC ran. Controllers and real
accounts were absent. A second connection models a foreign writer; the future
regression should also exercise a separate process.

| Cycle | Current rows returned | Cached deleted rows | Cached JSON bytes | Post-GC heap, MiB |
| --- | ---: | ---: | ---: | ---: |
| 1 | 0 | 200 | 756,290 | 5.15 |
| 2 | 0 | 400 | 1,512,580 | 7.17 |
| 4 | 0 | 800 | 3,025,160 | 11.05 |
| 6 | 0 | 1,200 | 4,537,740 | 14.95 |
| 8 | 0 | 1,600 | 6,050,320 | 18.73 |

The exact cached cardinality and bytes establish retention independently of
the RSS curve. Heap includes both store instances and runtime scaffolding, so
its entire delta is not attributed solely to the reader Map. This case proves
an unbounded historical-key retention path. It does not measure the affected
installation's deleted-row history, frequency of this read path, or bytes
retained there. It also needs no 20-second timer to occur.

**HTTP reproduction and warm-up.** A production Next build was served by a
custom loopback HTTP listener with port zero, following the installed Next
custom-server guide. Every run had a private HOME, config, temp and state root,
disabled account control/structured hosting/reaping, and a Viewer control URL
on closed loopback port 1. No real transcript/state copy was used. The fixtures
contained 64 alternating synthetic message records per transcript, split
between Claude and Codex shapes. The 128-file corpus was 9.81 MiB on disk;
the 2,048-file corpus was 156.97 MiB. They omit the installation's retained
pipeline attempts, receipts, accounts, active hosts and incoming MCP traffic.

The first matrix ran **14:56:15.886–15:03:47.722**, separately booting each
corpus. Phase durations were 25/30/40/65/30/20 seconds. Board-closed replay
polled `/api/files` every two seconds. Board-open added `/api/board`, tasks,
pipelines and flows reads for the selected synthetic project. Resource reads
ran every ten seconds; transcript history reads ran every 250 ms. These are
route-equivalent workloads; no physical browser-tab or rendered-UI result is
claimed. Both runs returned 96 visible file rows: the windowed projection is
distinct from the disk corpus and full catalog. Sampling was every 500 ms.

| Phase | 128 files: post-GC heap / RSS, MiB | 2,048 files: post-GC heap / RSS, MiB |
| --- | ---: | ---: |
| Idle | 25.15 / 246.34 | 28.09 / 255.38 |
| Board closed route mix | 33.02 / 252.19 | 36.51 / 260.72 |
| Board open route mix | 35.29 / 264.95 | 38.53 / 275.11 |
| Resource polling | 36.08 / 275.90 | 39.14 / 285.79 |
| Transcript history | 36.65 / 282.97 | 39.83 / 291.93 |
| Cooldown | 36.87 / 283.20 | 39.91 / 294.36 |

All seven resource reads per corpus returned one successful generation; later
reads were memory-cache hits. The small rises between phases include first
route loading/JIT and retained route state. Increasing the disk corpus 16-fold
added about 3 MiB to the final post-GC heap in this windowed workload. Repeated
history reads did not retain each response's raw transcript body.

The committed shared driver was independently exercised with 30-second phases
and 2,048 files at **15:07:26.414–15:10:29.840**. It ended at 39.35 MiB
post-GC heap and 270.22 MiB RSS, down slightly from the transcript phase's
39.43 MiB / 274.05 MiB. State DB/WAL/SHM descriptors warmed from 10/8/1
to 17/15/1 when more stores loaded, and remained 17/15/1 through resource,
transcript and cooldown phases. This distinguishes lazy store loading from a
per-poll connection leak. These bounded runs do not establish an hours-long
plateau for the live workload.

**Resource failures and allocation cadence.** A normal resource read without
a latest successful observation calls `collector.observe` each time. The
collector coalesces overlapping work; sequential reads after failure retry.
`readResourceFileSnapshot(false)` calls `completedFileScan`, whose completed
reader clones the snapshot, then `resourceWorkerFileHandoff` creates two
file-only projections and applies registry titles. Request validation and
serialization follow. The 10,000-file and transport limits are checked after
this preparatory work (`resources.ts:451`, `:1367`, `:1411`;
`resourceWorkerRequest.ts:22`, `:97`). This is a supported allocation feeder.

The exact failure-path snippet in the reproduction section was run via
`bun run -` under Bun 1.4.0 at **20:44:44.129–20:44:49.587**. Each corpus ran
in a fresh process. Its 512-entry control supplies a malformed host record;
the 12,000-entry case exceeds the file limit. Both are rejected before spawn
and perform 80 handoffs for 80 sequential failed reads. Full GC runs only in
these fixture processes at each checkpoint.

| Polls | 512 entries: post-GC heap / RSS, MiB | 12,000 entries: post-GC heap / RSS, MiB |
| --- | ---: | ---: |
| 20 | 6.10 / 79.98 | 11.19 / 156.66 |
| 40 | 6.26 / 78.98 | 11.23 / 163.55 |
| 60 | 6.26 / 78.98 | 11.28 / 164.04 |
| 80 | 6.26 / 78.98 | 11.28 / 164.43 |

Final JSC heap capacities were 14.77 and 49.35 MiB respectively. The same
snippet then profiles 30 additional handoffs at 100-microsecond intervals:
152 of 173 CPU stack samples were in `structuredClone` for the control,
and 6,931 of 7,081 for the large case. Sampling counts and RSS depend on
execution speed and host pressure; they are measured results, with no exact
cross-machine equality promised. The stable post-GC fixture graph supports
bounded retention for this fixed corpus; RSS remains higher than that graph.

The final `Bun.unsafe.mimallocDump()` in **that same snippet/process**, after
80 reader handoffs plus 30 profiled handoffs, reported 1.0 GiB arena reservation
for both cases and cumulative purging of 122.4 / 314.9 MiB (small / large).
These replace the earlier unpublished-harness numbers (31 MiB post-GC heap,
17,280 profile samples and 2.9 GiB purging), whose generating fixture could
not be reproduced from the former snippet. No conclusion relies on those
withdrawn numbers.

This is CPU stack sampling over an allocating operation. Bun's
`--heap-prof-interval` produces an exit snapshot; allocation evidence here
consists of the clone/projection path, heap/object/capacity counters, private
snapshots and allocator statistics. Per-allocation stack traces were not
collected. [Bun profiling documentation](https://bun.sh/docs/project/benchmarking),
[heap counter semantics](https://bun.sh/reference/bun/jsc/heapStats).

Arena counters and RSS measure different things; reservation and cumulative
purging cannot be treated as resident live objects. Runtime/allocator capacity
is a possible contributor to residual RSS. Its exact native owners remain
unidentified; no SQLite-native or mimalloc allocation stacks were collected.

The footer schedules the next resource poll **30 seconds after completion**
(`ResourcesFooter.tsx:15`, `:154`),
files and board fallback polls use **10 seconds** (`useFiles.ts:29`,
`useBoardState.ts:15`), the active Telegram reports surface schedules its next
poll **20 seconds after completion** (`useTelegramReports.ts:17`, `:80`),
pipeline watchdog reconciliation uses **30
seconds** (`pipelines/controller.ts:87`), and migration inventory uses **60
seconds** (`accounts/migration/controller.ts:34`). Overlapping clients and
background work can generate a different apparent cadence. No route timestamps
were available to identify which of these drove the reported 20-second cycle.
The live successful resource cache also rules out assuming every footer poll
repeated a failed collection in the observed window.

**SQLite lifecycle.** `SqliteStateCollection` opens one read handle per
instance in its constructor and keeps it for that instance's lifetime. It is
an ordinary read/write-capable connection used for reads; its constructor does
not set `readonly:true`. There is no collection `close()` method. Most
stores memoize collections by database path. The legitimate count depends on
loaded store modules, independent bundle instances and dynamic scope keys:

| Construction owners | Legitimate retained handles per loaded module/instance |
| --- | --- |
| `tasks/store.ts:316`, `flows/store.ts:122`, `workflows/store.ts:338`, `accounts/accountsStore.ts:454`, `spawnNotice/store.ts:79`, `boardMaintenance/store.ts:11`, `orchestrator/boardReportStore.ts:43`, `links/boardLinks.ts:13`, `links/tombstones.ts:28`, `links/taskFeed.ts:73`, `bridge/taskChanges.ts:50` | One per opened database path for each owner; task changes also checks file identity. |
| `pipelines/store.ts:1250` | Two per database: active and archive collections. |
| `bridge/store.ts:426` | One per `(database, collection)` pair, including separate report/channel collections. |
| `accounts/migration/provider.ts:761` | One per `(database, migration root)` pair; multiple synthetic or real roots can share a state DB. |
| `state/legacyDocumentStore.ts:97`, `:262` | One per database for each document-store object; attention, dismissals, suggestions and seat settings instantiate this wrapper. |
| `monitor/seatTickAccounting.ts:48`, `:228–239` | One per database filename in each module instance. The module Map memoizes the collection, checks file identity on reuse and shares it across all accounting wrappers. |
| `agent/sqliteRegistryStore.ts:427` | One connection per registry store, normally to a separate `agent-registry.sqlite`; it has `close()`. |

**Accounting connection measurement.** Under Bun 1.4.0 at
20:42:52.594–20:42:52.710, one accounting wrapper and then 200 additional
wrappers on the same private filename held DB/WAL/SHM descriptors at 1/1/1.
All 200 additional wrappers had `collection === first.collection`. This
measures one module instance and one filename; additional module instances or
filenames retain their own collections. The shared collection remains owned by the module Map.
Repeat this Linux probe via `rtk proxy bun run -` from the repository root
under the private environment below:

```ts
import fs from "node:fs";
import { SeatTickAccounting } from "./src/lib/monitor/seatTickAccounting";
const filename = `${process.env.LLV_STATE_DIR}/state.sqlite`;
function descriptors() {
 const counts = {db: 0, wal: 0, shm: 0};
 for (const fd of fs.readdirSync('/proc/self/fd')) {
  let target; try { target=fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { continue; }
  if (target === filename) counts.db++;
  if (target === `${filename}-wal`) counts.wal++;
  if (target === `${filename}-shm`) counts.shm++;
 }
 return counts;
}
const first = new SeatTickAccounting(filename, 'synthetic'); first.row();
console.log(JSON.stringify({objects: 1, descriptors: descriptors()}));
const wrappers = Array.from({length: 200}, () => new SeatTickAccounting(filename, 'synthetic'));
for (const wrapper of wrappers) wrapper.row();
console.log(JSON.stringify({objects: 201, shared: wrappers.every(w => w.collection === first.collection), descriptors: descriptors()}));
```

The production build contains the state collection implementation in three
chunks, with distinct enclosing module IDs: 12002, 20624 and 13117. The deployed
build has the same three implementation chunks. Independent module instances
can each hold their own store Maps. Merely seeing three chunks does not prove
all three are initialized or identify the owner of every live descriptor.
The per-owner rule above is the connection budget; an exact live owner-to-handle
mapping would require instrumentation outside this investigation's live fence.

Scanner and response worker processes have their own module/cache/connection
lifetimes. Their handles belong to their PIDs. The contained resource worker
receives file and host observations and deliberately never opens the registry
(`resources.ts:1368`). Test-server and fixture construction sites were excluded
from the production owner list. Auxiliary search, activity, receipts, team and
runtime-event databases are separate files and cannot be counted as state DB
handles. Their bytes can still contribute to their owner's RSS.

Short-lived state reads, revision reads, imports, schema initialization,
transaction writers and lease cleanup close their connections in `finally`
(`sqliteStateStore.ts:65`, `:249`, `:334`, `:560`, `:635`, `:842`, `:889`,
`:1914`, `:1936`). Setup failure closes the raw writer. The collection
constructor's post-open schema checks and raw readonly PRAGMA setup have no
eager close on failure; this is a lifecycle hardening gap, with no evidence
that repeated setup failure occurred here. A database-file replacement closes
the old handle and reopens the current file through `currentDatabase.ts:73`.

These paths use cached `query()` statements and eager `all/get/run` execution;
no unfinished `iterate()` cursor escapes the state store. Bun documents that
`close()` finalizes its query-cache statements, while separately prepared
statements can defer connection closure. A private 200-open/query/close loop
left a bounded extra DB descriptor while another WAL connection stayed open;
after the last connection closed and isolated GC ran, the DB descriptor count
was zero. SQLite's Unix locking layer can defer physical descriptor closure,
so descriptor counts are not an exact connection census.
[Bun SQLite lifecycle](https://bun.sh/docs/runtime/sqlite),
[SQLite Unix VFS source](https://github.com/sqlite/sqlite/blob/master/src/os_unix.c).

Neither connection pooling nor a 2 MiB default SQLite page-cache arithmetic
establishes the web PID's native footprint. Descriptor counts held within each
short live window. Between windows the DB count changed from 31 to 32 while
the endpoint WAL count stayed 29; physical descriptors are an imperfect
connection census, so no connection-count change or owner is established.
Native allocation growth inside an existing connection remains a separate
hypothesis.

**Related history checked before attribution.**

| History | Present state at the source pin and deployed revision |
| --- | --- |
| [#907](https://github.com/Latand/delegatus/issues/907) | Hot stores moved to SQLite in #956; change-log replay exists in `loadReadonly`. #1991's warm-route/title-projection work is present. Both merges are ancestors of the deployed revision. Registry full snapshot/parsed-row retention still exists; those earlier changes do not prune foreign deletions. |
| [#1814](https://github.com/Latand/delegatus/issues/1814) | #1832's resident response worker is present on main and deployed. A newly forked worker for every ordinary poll is an obsolete default explanation. |
| [#1816](https://github.com/Latand/delegatus/issues/1816) | Its proposed broad thin-client change cannot be assumed shipped. `createProductionViewerMcpService` still dynamically imports domain bindings (`mcp/server.ts:4206`). The issue remains open. MCP RSS belongs to separate processes; Viewer tool traffic may still allocate in the Viewer. |
| [#1805](https://github.com/Latand/delegatus/issues/1805), [#568](https://github.com/Latand/delegatus/issues/568) | These concern host/tree attribution and broader pressure. #2484's finished-stage/orphan retirement work is on main and deployed. No retirement or cleanup action was exercised here. A sum of agent/MCP/worker memory cannot explain a measurement explicitly scoped to the web PID. |

Issue bodies and linked timeline/merge records were read with `gh`; the old
comment was treated as a hypothesis. Prior-context searches included
project-scoped `memory growth sqlite` / `collector-crash`, unscoped `sqlite
descriptors`, and memory-index searches for `memory heap SQLite`, `resources
collector` and `registry rowCache`. They provided no earlier diagnosis of this
cache-deletion defect. A collector-test transcript hit was opened through the
conversation message reader; it concerned test cleanup, and supplied no
production root-cause evidence. Search tokenization ignored some common terms;
empty/weak results therefore are not proof that all historical work is absent.

**Smallest fix and regression plan.** On a successful complete collection
read, collect the currently present keys and remove other keys from that
collection's parsed-row cache. Preserve reuse for unchanged present rows, the
transaction boundary, grant normalization and lazy-read contracts. Do not
erase durable conversations, receipts or transcripts to reduce heap.

The regression should use a reader and independent writer against a private
SQLite database. After each insert/read/delete/read cycle, assert the current
snapshot is empty and the reader has no stale cached keys or serialized bytes.
Exercise two actual processes, full and keyed/lazy reads, unchanged-row parse
reuse, cross-process revision jumps and restoration/inode replacement. Test
deletion of grant-bearing rows as well as metadata rows. Verify this invariant
fails at the investigated base and passes after the future implementation;
avoid machine-dependent RSS assertions as the correctness oracle. The shared
churn profile supplies a longer-run heap/cardinality comparison.

A separate allocation improvement can add bounded retry backoff for resource
failures and avoid deep-cloning the completed scan before making the already
private file-only handoff. Its tests should verify one failed observation for
sequential polls within backoff, recovery after expiry, fresh-read coalescing,
updated system counters on cached failures, early oversized-input rejection,
and an unchanged shared snapshot after title overlays. This addresses the
confirmed failure-path feeder; the live sample supplied no reason to implement
a permanent collector disable. Connection sharing is a larger lifecycle change
and is unnecessary to establish the diagnosed row-retention fix.

**Reproduction and command ledger.** The existing
[`scripts/profileBrowser.ts`](../../scripts/profileBrowser.ts) owns the new
reusable cases. It constructs its own isolated environment, binds port zero,
records owned PIDs and stops owned processes by those PIDs. It never accepts
an operator state directory as its fixture source. `--snapshots` writes only
private synthetic snapshots. The aggregate output contains measurements and
cache cardinalities, with no transcript content or fixture paths.

```sh
RESEARCH_ROOT=$(mktemp -d /var/tmp/delegatus-research.XXXXXX)
mkdir -p "$RESEARCH_ROOT/home" "$RESEARCH_ROOT/tmp" "$RESEARCH_ROOT/state"
export HOME="$RESEARCH_ROOT/home" TMPDIR="$RESEARCH_ROOT/tmp"
export XDG_CONFIG_HOME="$RESEARCH_ROOT/home/.config"
unset DELEGATUS_STATE_DIR DELEGATUS_VIEWER_CONTROL_URL
export LLV_STATE_DIR="$RESEARCH_ROOT/state"
export LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1
export NEXT_TELEMETRY_DISABLED=1 DELEGATUS_TELEMETRY=0
rtk proxy bun install --frozen-lockfile
rtk proxy bash scripts/gate-slot.sh bun --bun node_modules/.bin/next build --webpack
rtk proxy bun scripts/profileBrowser.ts --server-memory --seconds 30 \
  --corpus 128,2048 --out "$RESEARCH_ROOT/http-aggregate.json"
rtk proxy bun scripts/profileBrowser.ts --registry-churn \
  --out "$RESEARCH_ROOT/registry-aggregate.json"
```

The failure-path source probe is independently repeatable with this small
isolated harness, using the same exported production handoff/reader functions.
Run the block from the repository root through `rtk proxy bun run -`, using
the private environment above. Set `RESEARCH_ENTRIES=512` for the control or
`RESEARCH_ENTRIES=12000` for the over-limit case; use a new process per case.
The control supplies a deliberately malformed host record, rejected by request
validation; the large case exceeds the file limit. Both refuse before collector
spawn. `fullGC` and profiling affect this fixture process only. The profile
executes 30 additional handoffs after the 80 reader polls; the allocator dump
therefore covers all 110 handoffs. Checkpoint fields are bytes.

```ts
import { fullGC, heapStats, profile } from "bun:jsc";
import { createResourcesReader, resourceWorkerFileHandoff } from "./src/lib/resources";
const files = Array.from({ length: Number(process.env.RESEARCH_ENTRIES ?? 12000) }, (_, index) => ({
  path: `${process.env.TMPDIR}/fixture/${index}.jsonl`, name: `${index}.jsonl`,
  parent: null, project: "synthetic", root: "claude-projects" as const,
  engine: "claude" as const, fmt: "claude" as const,
  title: `Synthetic ${index} ` + "detail ".repeat(128), activity: "idle" as const,
  mtime: 1, size: 65536, pid: null, proc: null, conversationId: null,
}));
let handoffs = 0;
const reader = createResourcesReader(async () => { throw new Error("unused"); },
  () => null, Date.now, () => null, {
    readFiles: async () => {
      handoffs++;
      return resourceWorkerFileHandoff(structuredClone(files), () => {});
    }, readHostRecords: async () => Number(process.env.RESEARCH_ENTRIES) === 512 ? [{} as never] : [], persist: () => true,
  });
for (let poll = 1; poll <= 80; poll++) {
  await reader.read(false);
  if (poll % 20 === 0) {
    fullGC();
    const { heapSize, heapCapacity } = heapStats();
    console.log({ poll, handoffs, heapSize, heapCapacity, rss: process.memoryUsage().rss });
  }
}
console.log(profile(() => {
  for (let repeat = 0; repeat < 30; repeat++)
    resourceWorkerFileHandoff(structuredClone(files), () => {});
}, 100).functions);
Bun.unsafe.mimallocDump();
```

| UTC bounds on 2026-10-05 | Command/query and purpose |
| --- | --- |
| 14:44–15:13 | `gh issue view 2512 --json number,title,body,comments,url`; `gh issue view` for each related issue; `gh api repos/Latand/delegatus/issues/<number>/timeline --paginate`; `gh pr view 1991/2484 --json mergedAt,mergeCommit`; code-first `rg` and `sed` over the referenced modules. |
| 14:46:56 | `/proc/$VIEWER_PID/exe --version`; `/proc/$VIEWER_PID/{stat,environ,cwd}` and the installed Next package/version; `git -C <observed release> rev-parse HEAD`; aggregate DB file sizes. Environment values were filtered; credentials were never emitted. |
| 14:48:17–14:52:17 | Read-only two-second `/proc/$VIEWER_PID/{stat,status,smaps_rollup,fd}` series, with fixed start-time identity. |
| 14:50–14:54 | `journalctl --user -u delegatus.service --no-pager -o json --since '10 minutes ago'` and PID-filtered queries; aggregate persisted resource observation and completed file-snapshot counts. |
| 14:48–14:56 | Isolated `bun install --frozen-lockfile`; gate-slot production `bun --bun node_modules/.bin/next build --webpack`, exit 0. |
| 14:56:15.886–15:03:47.722 | Private HTTP matrix described above, 128 and 2,048 synthetic files; private heap snapshots and 500 ms counters. |
| 14:58–15:00 | Earlier private handoff probe; its absolute metrics were withdrawn and superseded by the published-snippet measurements at 20:44. The separate 200-iteration SQLite lifecycle probe remains as described above. |
| 15:07:26.414–15:10:29.840 | `bun scripts/profileBrowser.ts --server-memory --seconds 30 --corpus 2048 --out <private aggregate>`; exit 0; owned descendants checked absent. |
| 15:12:43.022–15:12:44.012 | `bun scripts/profileBrowser.ts --registry-churn --out <private aggregate>`; exit 0, eight cycles, two real store connections. |
| 15:13:24 | `git fetch origin main`; `git rev-parse origin/main`; relevant-source `git diff origin/main`; no source drift in the investigated paths. |
| 15:15–15:17 | Earlier private allocator run; its absolute counters were withdrawn and replaced by the published-snippet dump at 20:44. |
| 20:42:52.594–20:42:52.710 | Accounting wrapper probe above, Bun 1.4.0, 201 wrappers, 1/1/1 descriptors, shared collection, exit 0. |
| 20:44:44.129–20:44:49.587 | Exact published failure-path snippet via `bun run -`, separate 512/12,000-entry processes, 80 polls and 30 profiled handoffs each, exit 0. |
| 15:34 | `git rev-parse origin/main`; `git diff ee19907eb..origin/main -- <investigated source paths> Dockerfile package.json`; the relevant implementation and runtime/version pins were unchanged. |

TypeScript and changed-file ESLint were checked. Publication hooks check
privacy, commit attribution, types and changed-file lint in isolation. Hosted
CI is outside this investigation's wait contract. No raw snapshot, transcript,
account/project identity, secret or absolute home path is part of this note.

**Remaining evidence needed.** The affected PID/release/start identity and a
same-window route/cadence series would establish whether this is the reported
installation and which operation drives the cycle. A matching synthetic
registry workload with realistic retained/deleted row counts would quantify
the confirmed reader defect. Separating the live floor into reachable heap,
JSC capacity and native owners needs an already available diagnostic surface
or separately authorized instrumentation. Existing access does not supply
those answers; the current sample and synthetic evidence cannot assign all
reported 12 GB to one cause. Preserve this attribution gap when opening the
follow-up fix.

**Repeat verification, 16:48–16:58 UTC.** The existing draft and first issue
comment were recovered through `gh` and the prior conversation reader. This
repeat extends the evidence on the same branch; the earlier measurements above
retain their original time bounds.

At 16:49:14, fetched main was
`ff4af9a3877edfcdbf8c906412f24a28a1ef1b45`. Comparing the investigated paths
against `ee19907eb` found unchanged registry/state-store, scanner, resource
reader/cache and handoff, title projection and polling implementations. Main's
resource-worker changes handle an exiting namespace member and stdin EPIPE;
its MCP changes concern receipt-lock recovery. Neither change prunes registry
rows or introduces failure backoff. Package publication/patch entries changed;
Next remains 16.3.6 and the Docker Bun pin remains 1.4.0. The main comparison
does not claim a rebuilt main HTTP measurement: the repeated HTTP run serves
the existing production build at the investigation source pin.

At 16:52:25, `git merge-base --is-ancestor` returned 0 for each historical fix
on both this main and the observed release: #956 `dfa7447e89a9`, #1991
`c82045fad2bd`, #1832 `4746038be907`, and #2484 `ee726f70bad2`. The five related
issue bodies were read again with `gh issue view <number> --json
number,title,state,body`. #907 and #1816 remain open. These checks preserve the
distinction between shipped mitigations and work still proposed.

The live repeat read `/proc/$VIEWER_PID/{stat,status,smaps_rollup,fd}` **91
times from 16:51:08.282 through 16:54:13.658**, at roughly two-second intervals.
It checked the same PID/start identity throughout. Resolving its executable,
running that executable with `--version` in an isolated environment, reading
the installed Next package, and `git -C <observed release> rev-parse HEAD`
again confirmed Bun 1.4.0, Next 16.3.6 and release `6af2bab08a52`. Uptime was
24.17 hours. No live HTTP request, signal, GC, snapshot or attach was used.

| Metric | Minimum | Maximum | First | Last |
| --- | ---: | ---: | ---: | ---: |
| RSS, MiB | 2,089.90 | 2,909.24 | 2,101.84 | 2,909.24 |
| RssAnon, MiB | 2,006.79 | 2,826.13 | 2,018.73 | 2,826.13 |
| PSS, MiB | 2,017.46 | 2,875.60 | 2,031.55 | 2,841.36 |
| VmSwap / SwapPss, MiB | 0 | 0 | 0 | 0 |
| State DB / WAL / SHM descriptors | 32 / 29 / 1 | 32 / 29 / 1 | 32 / 29 / 1 | 32 / 29 / 1 |

RSS thirty-second lower-water marks were 2,101.84, 2,092.50, 2,094.84,
2,089.90, 2,097.40 and 2,126.81 MiB. There were irregular short spikes and a
larger burst near the end. A regular 20-second cycle was not established.
Counters from `status` and `smaps_rollup` are sequential reads, so their maxima
need not coincide. The descriptor-number sets were identical at the endpoints.
The earlier window had 31 DB descriptors; the repeat had 32. The entire repeat
window overlapped the isolated HTTP replay at 16:51:13–16:57:21 except its first
five seconds. Shared-host pressure and ongoing work were uncontrolled.
Stability within
each short window cannot rule out intermittent additions across the unobserved
gap, and the extra descriptor has no confirmed owner.

A 16:56:04 read located state through an existing DB descriptor, without opening
the database. The successful persisted resource observation was generation 355,
completed at **16:51:34.198**, with no degradation reason. `journalctl --user
-u delegatus.service --no-pager -o json --since '2026-10-05 16:51:08 UTC'
--until '2026-10-05 16:54:14 UTC'` returned one journal entry and no resource
failure entries. The state DB/WAL/registry file sizes at 16:56:04 were
34.58 / 1.05 / 38.46 MiB. These observations again provide no support for
assigning an always-failing collector to this live window.

`bun scripts/profileBrowser.ts --registry-churn --out <private aggregate>` ran
at **16:51:09.530–16:51:10.104**, exit 0. Its empty current snapshots again
left 200 through 1,600 deleted rows cached, ending at 6,050,320 serialized bytes
and 18.73 MiB post-GC heap, from 5.15 MiB after the first cycle. This repeat
confirms the retention invariant and the proposed absent-key pruning/test plan.

`bun scripts/profileBrowser.ts --server-memory --seconds 30 --corpus 128,2048
--out <private aggregate>` ran at **16:51:13.054–16:57:21.566**, exit 0, under
Bun 1.4.0 and Next 16.3.6 with the same isolation and route mixes described
above. Each transcript phase completed 117 history reads. All routes succeeded.

| Phase | 128 files: post-GC heap / RSS, MiB | 2,048 files: post-GC heap / RSS, MiB |
| --- | ---: | ---: |
| Idle | 25.25 / 245.28 | 28.91 / 246.00 |
| Board closed route mix | 33.99 / 251.49 | 37.02 / 260.66 |
| Board open route mix | 34.57 / 259.75 | 38.58 / 269.71 |
| Resource polling | 35.67 / 257.81 | 38.48 / 268.78 |
| Transcript history | 36.07 / 264.29 | 40.42 / 274.63 |
| Cooldown | 36.89 / 261.73 | 39.78 / 271.96 |

Both corpora warmed state DB/WAL/SHM descriptors from 10/8/1 through 13/11/1
to 17/15/1, then held that count. Final JSC heap capacity was 43.01 / 45.67 MiB;
extra memory was 11.68 / 14.07 MiB for the two corpora. Extra memory is included
in the JSC heap/capacity counters and must not be added to them again. The main
process's named scanner Maps held only three one-entry path/project caches in
each phase; transcript metadata Maps in scanner workers belong to other PIDs.
Thus this counter does not measure all worker caches. Recorded-PID/start-identity
checks at 16:57:50 found no running survivor among the 12 HTTP fixture processes.

At 16:58:28, a source search over API routes, instrumentation, HTTP modules,
process helpers and scan-cache diagnostics found a files-scan request count
exposed in response headers (`src/app/api/files/route.ts:536`). It supplies no
passive timestamped per-route series for the observed window. No live heap or
native-owner diagnostic was found in those surfaces. The missing affected-PID
identity and same-window route evidence still prevent attribution of the 12 GB
footprint or oscillator. The synthetic post-GC results distinguish fixed-corpus
warm-up from the demonstrated historical-key leak; they cannot classify the
live floor's native component. The controller has accepted this bounded result
with that attribution gap. Production remained unchanged.

**Correction verification and longer local observation, 20:42–20:48 UTC.**

The published accounting and failure-path probes above correct the owner
budget and tie heap, RSS, CPU-profile and allocator values to their generating
code. Both snippets were also executed directly from the note via `bun run -`.
All recorded probe PIDs exited on their own; no product source was changed.

The operator recipe below was run for five minutes (151 samples; loop bound
151 and final sleep condition 150), with the same web PID/start identity.
The new read-only series at 20:43:31.080–20:48:31.132 (151 two-second samples, fixed PID/start identity, uptime 28.04 h) measured RSS 2,189.73–2,780.54 MiB, PSS 2,136.42–2,723.23 MiB, anonymous RSS 2,106.62–2,697.43 MiB and zero swap. DB/SHM descriptors stayed 32/1; WAL ranged 29–30. Sampled RSS minima increased 309.81 MiB between the first two windows and another 99.83 MiB by this window (409.64 MiB overall). Thirty-second minima varied during the new window; continuous monotonic growth and an hours-long plateau remain unestablished. Source probes shared the host during its first 79 seconds, and live requests were uncontrolled. No live request, signal, GC, snapshot or attach was used.

Thirty-second RSS minima, MiB: 2,280.30, 2,282.46, 2,281.49, 2,189.73,
2,236.09, 2,203.70, 2,225.77, 2,231.30, 2,208.38 and 2,241.09.
The final sample is outside those ten complete 30-second bins. These are
sampled window minima; unobserved intervals supply no continuous floor trace.
The reviewer's 20:38 short-window minimum was about 2,201 MiB; the new minimum
is slightly lower, which also prevents describing the floor as monotonic.
The 20-second oscillator and native-memory owners remain unattributed.

At 20:45–20:47, fetched main was `3a8822996c12b35d006a8df87502875ca67df118`.
The accounting memoization, registry cache, state store, scan cache, title
projection, handoff/request validation and polling inputs remain unchanged
from the investigated source pin. Resource-worker cleanup/EPIPE changes
already described above remain outside the allocation feeder. The related
issue bodies were reread; #907 and #1816 remain open. The four historical fix
commits again passed ancestry checks on this main and the observed release.

**Accepted completion summary.**

Bounded investigation for #2512; the reported 12 GB footprint and approximately 20-second cycle remain **unattributed**, with the controller-accepted gap preserved.

**Confirmed retention.** The private `--registry-churn` repeat left 1,600 externally deleted rows and 6,050,320 serialized bytes cached while the reader's current snapshot was empty. Complete collection reload (`src/lib/agent/sqliteRegistryStore.ts:1259`) populates the strong parsed-row Map (`:1536`) without pruning absent keys; writer-local deletion (`:1590`) clears only its own cache. The defect's contribution to the affected installation remains unmeasured.

**Corrected SQLite ownership.** `SeatTickAccounting` memoizes one collection per database filename within each module instance, checks file identity and shares it across wrappers (`seatTickAccounting.ts:48`, `:228–239`). The published private probe under Bun 1.4.0 measured 1/1/1 DB/WAL/SHM descriptors after one wrapper and after 200 additional wrappers; all additional wrappers shared the first collection. The former GC-release explanation was removed. Counts held within each live window; 31→32 DB descriptors between windows has no confirmed owner or connection-count attribution.

**Reproducible allocation measurements.** At 20:44:44.129–20:44:49.587 UTC on 2026-10-05, the exact published snippet ran in separate Bun 1.4.0 processes for 512 malformed-host and 12,000 over-limit entries. Each performed 80 failed reads / 80 handoffs before collector spawn. At 20/40/60/80 polls, the large fixture's post-GC heap was 11.19/11.23/11.28/11.28 MiB and RSS 156.66/163.55/164.04/164.43 MiB; final heap capacity was 49.35 MiB. The 512-entry control ended at 6.26 MiB heap / 78.98 MiB RSS, capacity 14.77 MiB. Thirty additional profiled handoffs yielded 6,931/7,081 CPU samples in `structuredClone` for the large fixture (control 152/173). The same processes' dumps after all 110 handoffs reported 1.0 GiB arena reservation and 314.9 / 122.4 MiB cumulative purging (large / small). Earlier unpublished-harness absolute metrics were withdrawn. Sampling and allocator counters are execution-dependent; native ownership remains unclassified.

**Live observation.** Bun 1.4.0, Next 16.3.6, release `6af2bab08a52`. Earlier lower-water RSS was 1,780.09 MiB at 14:48 and 2,089.90 MiB at 16:51. The 16:51:08–16:54:13 window overlaps the isolated 16:51:13–16:57:21 HTTP replay after its first five seconds. The new read-only series at 20:43:31.080–20:48:31.132 (151 two-second samples, fixed PID/start identity, uptime 28.04 h) measured RSS 2,189.73–2,780.54 MiB, PSS 2,136.42–2,723.23 MiB, anonymous RSS 2,106.62–2,697.43 MiB and zero swap. DB/SHM descriptors stayed 32/1; WAL ranged 29–30. Sampled RSS minima increased 309.81 MiB between the first two windows and another 99.83 MiB by this window (409.64 MiB overall). Thirty-second minima varied during the new window; continuous monotonic growth and an hours-long plateau remain unestablished. Source probes shared the host during its first 79 seconds, and live requests were uncontrolled. No live request, signal, GC, snapshot or attach was used.

**Next step and limits.** Propose absent-key pruning only after successful complete registry reload, with a private independent-reader/writer base-red/head-green regression for cache cardinality/bytes, separate processes, unchanged-row reuse, grants, lazy/keyed reads, revision jumps and database replacement. Product implementation stays in a follow-up. Existing same-window route timings and heap/native counters from the affected PID are still needed to attribute its footprint and cycle; the note gives a safe 15-minute observation recipe. Related fixes #907/#1814/#1816/#1805/#568 were rechecked against today's main and deployed ancestry. Source references and prohibited contrast constructions were corrected. Production remained unchanged; hosted CI was not awaited.

**Operator evidence recipe.** The unobserved change from 31 to 32 state DB
descriptors between live windows remains unexplained. No exact owner mapping
or hours-long plateau is claimed.

An operator investigating that installation can collect the following evidence
without changing its running processes. Choose the existing **web-server PID**
from the installation's process metadata, then check it against its parent,
start time, executable, release and installed Next version. A service MainPID
can belong to the runtime host; the process label alone does not establish
which process was measured. Record other worker PIDs separately, and state
whether the original 12 GB meant RSS, PSS, anonymous memory, virtual size or a
process-tree sum.

The Linux command below samples only the chosen PID for **15 minutes at
two-second intervals** (about 45 reported cycles). It prints numeric counters
and version/commit metadata, without command-line arguments, environment
contents, transcript paths or database contents. It reads `stat` before and
after each sample and stops if the PID/start identity changes. Runtime version
is queried by launching the resolved executable in a private environment; the
running process receives no signal or diagnostic request. Keep output private
until its metadata has been reviewed for publication.

```sh
read -r -p 'Existing web-server PID: ' VIEWER_PID
export VIEWER_PID
python3 - <<'PY'
import datetime as dt, json, os, pathlib, re, subprocess, tempfile, time
pid = int(os.environ['VIEWER_PID'])
proc = pathlib.Path(f'/proc/{pid}')
def stat():
    return (proc / 'stat').read_text().rsplit(') ', 1)[1].split()
def utc():
    return dt.datetime.now(dt.timezone.utc).isoformat()
def counters(name, keys):
    result = {}
    for line in (proc / name).read_text().splitlines():
        key, _, value = line.partition(':')
        if key in keys:
            result[key] = int(value.split()[0])
    return result
initial = stat()
start = initial[19]
release_root = (proc / 'cwd').resolve()
executable = (proc / 'exe').resolve().name
with tempfile.TemporaryDirectory(prefix='delegatus-readonly-') as scratch:
    private = pathlib.Path(scratch)
    for name in ('home', 'tmp', 'state'):
        (private / name).mkdir()
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(('LLV_', 'DELEGATUS_', 'GIT_', 'NEXT_', 'XDG_'))}
    env.update(HOME=str(private / 'home'), TMPDIR=str(private / 'tmp'),
               XDG_CONFIG_HOME=str(private / 'home/.config'),
               LLV_STATE_DIR=str(private / 'state'),
               LLV_VIEWER_CONTROL_URL='http://127.0.0.1:1',
               NEXT_TELEMETRY_DISABLED='1', DELEGATUS_TELEMETRY='0')
    version = None
    if executable in ('bun', 'bun-container', 'node', 'nodejs'):
        version = subprocess.check_output([f'/proc/{pid}/exe', '--version'],
            env=env, cwd=scratch, timeout=10, stderr=subprocess.DEVNULL).decode().strip()
    commit = subprocess.run(['git', '-C', str(release_root), 'rev-parse', 'HEAD'],
        env=env, capture_output=True, text=True, timeout=10).stdout.strip()
    if not re.fullmatch(r'[0-9a-f]{40}', commit):
        commit = None
    try:
        next_version = json.loads((release_root / 'node_modules/next/package.json').read_text())['version']
    except (OSError, KeyError, ValueError):
        next_version = None
    print(json.dumps(dict(utc=utc(), pid=pid, ppid=int(initial[1]),
        start_ticks=int(start), clock_ticks_per_second=os.sysconf('SC_CLK_TCK'),
        executable_name=executable, runtime_version=version,
        release_commit=commit, next_version=next_version)), flush=True)
    begun = time.monotonic()
    for sample in range(451):
        before = stat()
        if before[19] != start:
            raise SystemExit('PID/start identity changed; stop this series')
        status = counters('status', {'VmRSS', 'RssAnon', 'RssFile', 'RssShmem', 'VmSwap', 'VmSize', 'Threads'})
        rollup = counters('smaps_rollup', {'Rss', 'Pss', 'Pss_Anon', 'Pss_File', 'Pss_Shmem', 'Anonymous', 'Swap', 'SwapPss'})
        fd_counts = {'total': 0, 'db': 0, 'wal': 0, 'shm': 0}
        for descriptor in (proc / 'fd').iterdir():
            try:
                name = pathlib.Path(os.readlink(descriptor).removesuffix(' (deleted)')).name
            except FileNotFoundError:
                continue
            fd_counts['total'] += 1
            key = {'state.sqlite': 'db', 'state.sqlite-wal': 'wal', 'state.sqlite-shm': 'shm'}.get(name)
            if key:
                fd_counts[key] += 1
        try:
            io = counters('io', {'rchar', 'wchar', 'syscr', 'syscw', 'read_bytes', 'write_bytes'})
        except PermissionError:
            io = None
        after = stat()
        if after[19] != start:
            raise SystemExit('PID/start identity changed; discard this sample')
        print(json.dumps(dict(utc=utc(), sample=sample, pid=pid,
            start_ticks=int(start), uptime_seconds=float((pathlib.Path('/proc/uptime')).read_text().split()[0]) - int(start) / os.sysconf('SC_CLK_TCK'),
            status=status, smaps_rollup_kib=rollup, descriptors=fd_counts,
            io=io, cpu_user_ticks=int(after[11]), cpu_system_ticks=int(after[12]))), flush=True)
        if sample < 450:
            time.sleep(max(0, begun + (sample + 1) * 2 - time.monotonic()))
PY
```

`status` memory fields and all `smaps_rollup_kib` fields are KiB; `Threads`
is a count. CPU values are cumulative clock ticks, I/O values are cumulative
bytes or syscall counts. They help correlate work and supply no allocation
ownership. Descriptor enumeration is a sequential observation, with the same
FD-to-connection limitations described above. If release/version fields are
null, read the installation's existing build/image metadata and package
manifest locally; do not substitute a checkout's version for the running
release. Record OS/architecture with `uname -srmo` and OS release metadata.

Use the **same UTC bounds and PID/start identity** for existing request
telemetry. Required fields are request start/end times (or start plus duration),
method, route template with query values removed, status, response bytes and
overlapping request count. Include all clients/tabs and background/MCP traffic.
Compare each RSS/PSS/anonymous spike and lower-water mark with request counts,
durations and bytes for `/api/files`, `/api/board`, `/api/tasks`,
`/api/pipelines`, `/api/flows`, `/api/resources`, `/api/log` and
`/api/telegram/reports`; include other observed route templates too. Existing
collector generation/status/completion times and its cache hits/failures help
distinguish an actual collection from a cached resource response.

For an installation already using the named user service, an existing journal
can be read for that interval without requesting anything from the Viewer:

```sh
journalctl --user -u delegatus.service --utc --no-pager -o json \
  --since "$RESEARCH_SINCE_UTC" --until "$RESEARCH_UNTIL_UTC" _PID="$VIEWER_PID"
```

Set the two bounds from the counter series. Unit-forwarded messages may carry
another producer PID; read that known unit's same-window journal locally as
well if applicable. A journal is request telemetry only when its existing
entries actually record those request fields. Existing reverse-proxy access
logs need a verified upstream mapping to this web PID; already captured browser
Network/HAR records need every active client's matching window. Preserve raw
logs/HAR privately because they can contain paths, cookies and tokens. Publish
only route-template counts, timing/byte aggregates and numeric memory counters.
If those logs do not exist, the cycle remains unattributed: this decision does
not authorize adding access logging, tracing or a debugger to the live server.

If an **existing** diagnostic surface already exposes them, collect reachable
heap/object count, JSC heap capacity and extra memory, external/ArrayBuffer
bytes, registry cache cardinality/serialized bytes, and SQLite native/cache
bytes at the same cadence from this **web PID**. Respect overlapping counter
semantics. `/proc` cannot supply these owners. A rising post-cycle reachable
heap/cache count supports retention; a stable reachable graph with excess
capacity suggests a different floor component. Without those counters, the
native/allocator component remains unclassified. Heap snapshots, forced GC,
signals, debugger attach and new live instrumentation stay outside this scope.

At 20:21 UTC, `git fetch origin main` again resolved main to `ff4af9a3877edfcdbf8c906412f24a28a1ef1b45`;
the relevant-source diff from the earlier checked main was empty. This final
continuation changes the evidence explanation and acceptance status only.
