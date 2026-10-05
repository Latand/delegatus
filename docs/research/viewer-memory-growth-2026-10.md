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
12 GB magnitude and approximately 20-second cycle remain unconfirmed.

The smallest supported product change is pruning externally deleted registry
rows from the reader cache during a complete collection reload. No product
change was made. Connecting this defect to the reported magnitude needs an
affected-process sample or additional authorized instrumentation. The decision
is whether to obtain that evidence or accept this bounded investigation with
the attribution gap recorded.

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
host pressure were uncontrolled, so this window supplies an observation rather
than a before/after causal experiment.

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
was checked as well. Thus the absence claim covers that journal, rather than
every conceivable log sink. Neither a restart nor cleanup, account/pool change,
heap snapshot, forced GC or debugger attach was performed on the live process.

**Ownership and retained graphs in today's code.**

| Owner | Retained data and lifetime | References |
| --- | --- | --- |
| Registry store | `rowCache` holds both `valueJson` and parsed objects per collection/key. `readOnlyCache` holds the latest assembled snapshot. Unchanged revisions reuse it; foreign changes reload it. | `src/lib/agent/sqliteRegistryStore.ts:392`, `:640`, `:1536` |
| Registry title projection | Two WeakMaps key projections by snapshot identity. They do not independently pin an obsolete snapshot; another strong reference can keep its projection alive. Resource titles use this projection. | `src/lib/session/titleProjection.ts:32`, `:148`, `:247` |
| File-scan coordinator | A global Map retains the completed snapshot; reader copies are made by `structuredClone`. Pinned snapshot/generation maps have an eight-entry limit. | `src/lib/scanner/scanCache.ts:97`, `:120`, `:642`, `:708`, `:772` |
| Scanner metadata | Named global Maps retain head/tail-derived metadata by path. The helper supplies no universal cardinality or byte cap. A fixed corpus can warm up; path churn needs separate measurement. | `src/lib/scanner/caches.ts:15`, `src/lib/scanner/describe.ts:104` |
| Hot-state collection | One parsed collection cache, including serialized row data, parsed records and ordered views. Revision change-log replay updates it; `snapshot()` clones records for callers. | `src/lib/state/sqliteStateStore.ts:919`, `:947`, `:1143`, `:1517` |
| Resource reader | One latest successful observation, bounded diagnostics and in-flight work. Its ten-minute success cache is bypassed when no success exists. | `src/lib/resourceCollector.ts`, `src/lib/resources.ts:51`, `:2406`, `:2494` |
| Files response worker | One resident projection worker handles a burst; it retires after 60 seconds idle or above 1,536 MiB reported RSS. Its memory is outside the web PID. | `src/lib/scanner/filesResponseWorker.ts:12`, `:446` |
| Transcript HTTP reader | Raw bounded chunks, with a 768 KiB tail window and a 4 MiB history ceiling. File handles close in `finally`; the route does not retain a full parsed transcript history. | `src/lib/logRead.ts:9`, `src/lib/scanner/roots.ts:101`, `src/app/api/log/route.ts:39` |

Private synthetic heap snapshots confirmed strong edges from `GlobalObject` to
`__llvFilesRouteScans` and `__llvCaches`, and collection objects to `readDb`
proxies and collection caches. At the 2,048-file board checkpoint, snapshot
shallow sizes included 17.33 MiB of code, 4.36 MiB of strings and 3.35 MiB of
closures. These are shallow categories, not dominator retained sizes; string
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

A separate isolated source probe used 80 sequential failing observations with
an unchanged invented snapshot. The 512-entry malformed-input control and
12,000-entry over-limit case both performed 80 handoffs. At 20/40/60/80 polls,
the larger case's post-GC heap was 31.77/31.31/30.79/30.81 MiB, while RSS
was 276.25/278.72/279.29/310.55 MiB. JSC heap capacity at the last point
was 61.54 MiB. The payload graph stabilized in this probe, while resident
memory stayed well above it.

A 100-microsecond JSC stack profile of 30 handoff repetitions put
17,123 of 17,280 samples in `structuredClone` for the large case. This is CPU
stack sampling over the allocating operation. Bun's `--heap-prof-interval`
does not provide JSC allocation sampling; the official documentation describes
an exit snapshot instead. Allocation evidence here consists of the actual
clone/projection path, heap/object/capacity counters, private snapshots and
allocator statistics, without pretending to have per-allocation stack traces.
[Bun profiling documentation](https://bun.sh/docs/project/benchmarking),
[heap counter semantics](https://bun.sh/reference/bun/jsc/heapStats).

A second isolated run also exercised `Bun.unsafe.mimallocDump()`. At 80 large
handoffs it reported 1.0 GiB arena reservation and 2.9 GiB cumulative purging.
Arena counters and RSS measure different things; those figures cannot be
treated as resident live objects. The residual RSS is consistent with runtime
and allocator capacity around transient work. Its exact native owners were
not identified, and no SQLite-native or mimalloc allocation stacks were taken.

The footer polls resources every **30 seconds** (`ResourcesFooter.tsx:15`),
files and board fallback polls use **10 seconds** (`useFiles.ts:29`,
`useBoardState.ts:15`), Telegram reports use **20 seconds**
(`useTelegramReports.ts:17`), pipeline watchdog reconciliation uses **30
seconds** (`pipelines/controller.ts:86`), and migration inventory uses **60
seconds** (`accounts/migration/controller.ts:34`). Overlapping clients and
background work can generate a different apparent cadence. No route timestamps
were available to identify which of these drove the reported 20-second cycle.
The live successful resource cache also rules out assuming every footer poll
repeated a failed collection in the observed window.

**SQLite lifecycle.** `SqliteStateCollection` opens one read handle per
instance in its constructor and keeps it for that instance's lifetime. It is
an ordinary read/write-capable connection used for reads, rather than a
`readonly:true` connection. There is no collection `close()` method. Most
stores memoize collections by database path. The legitimate count depends on
loaded store modules, independent bundle instances and dynamic scope keys:

| Construction owners | Legitimate retained handles per loaded module/instance |
| --- | --- |
| `tasks/store.ts:316`, `flows/store.ts:122`, `workflows/store.ts:338`, `accounts/accountsStore.ts:454`, `spawnNotice/store.ts:79`, `boardMaintenance/store.ts:11`, `orchestrator/boardReportStore.ts:43`, `links/boardLinks.ts:13`, `links/tombstones.ts:28`, `links/taskFeed.ts:73`, `bridge/taskChanges.ts:50` | One per opened database path for each owner; task changes also checks file identity. |
| `pipelines/store.ts:1250` | Two per database: active and archive collections. |
| `bridge/store.ts:426` | One per `(database, collection)` pair, including separate report/channel collections. |
| `accounts/migration/provider.ts:761` | One per `(database, migration root)` pair; multiple synthetic or real roots can share a state DB. |
| `state/legacyDocumentStore.ts:97`, `:262` | One per database for each document-store object; attention, dismissals, suggestions and seat settings instantiate this wrapper. |
| `monitor/seatTickAccounting.ts:235` | One per accounting object. Callers create these on reads/writes; these transient objects rely on GC for eventual connection release. |
| `agent/sqliteRegistryStore.ts:427` | One connection per registry store, normally to a separate `agent-registry.sqlite`; it has `close()`. |

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
establishes the web PID's native footprint. Stable handles rule out growth in
the observed descriptor count. They leave native allocation growth inside an
existing connection as a separate hypothesis.

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
Run it under the environment above; `fullGC` and profiling affect this fixture
process only. The intentionally over-limit case never spawns a collector.

```ts
import { fullGC, heapStats, profile } from "bun:jsc";
import { createResourcesReader, resourceWorkerFileHandoff } from "./src/lib/resources";
const files = Array.from({ length: 12000 }, (_, index) => ({
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
    }, readHostRecords: async () => [], persist: () => true,
  });
for (let poll = 1; poll <= 80; poll++) {
  await reader.read(false);
  if (poll % 20 === 0) {
    fullGC();
    const { heapSize, heapCapacity } = heapStats();
    console.log({ poll, handoffs, heapSize, heapCapacity, rss: process.memoryUsage().rss });
  }
}
console.log(profile(() => resourceWorkerFileHandoff(structuredClone(files), () => {}), 100).functions);
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
| 14:58–15:00 | Private source handoff/failed-collection loop, 80 polls per corpus, JSC full-GC checkpoints and 100-microsecond CPU stack profile; 200-iteration SQLite lifecycle probe. |
| 15:07:26.414–15:10:29.840 | `bun scripts/profileBrowser.ts --server-memory --seconds 30 --corpus 2048 --out <private aggregate>`; exit 0; owned descendants checked absent. |
| 15:12:43.022–15:12:44.012 | `bun scripts/profileBrowser.ts --registry-churn --out <private aggregate>`; exit 0, eight cycles, two real store connections. |
| 15:13:24 | `git fetch origin main`; `git rev-parse origin/main`; relevant-source `git diff origin/main`; no source drift in the investigated paths. |
| 15:15–15:17 | A second isolated handoff run with `Bun.unsafe.mimallocDump()`; exit 0. Native allocator counters were aggregated. |
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
