# Viewer heap and GC audit

Audit: 2026-10-15 UTC. Production source: `781ecd4c33482d7486683d19d61a8b0bc8c14d38`, Bun 1.4.0. Audit checkout: `45d25ac796d5824713c9fb57d65f57efea61041b`. File:line references below name the production source; scratch instrumentation shifts some lines. This stage changes only this document.

## What the evidence establishes

The Viewer used **5.87–9.79 GiB RSS** during a ten-minute passive sample, with a lifetime high-water mark of **12.36 GiB**. Almost all resident memory was anonymous. Neither RSS nor anonymous memory measures reachable JavaScript objects. Production heap size and production GC pause count remain unmeasured.

On a consistent, read-only copy of production databases, the composite read-path replay retained **584.61 MiB after collection**, peaking at **1,526.66 MiB RSS**. Its largest measured retainers were pipeline collection caches, particularly archived pipelines. Decoding entire pipeline and registry collections repeatedly creates substantial temporary work. A separate source-function probe confirmed that the files delta-history map retains scopes after response-body eviction. These results identify concrete changes and allocation sources; they do not account for the full production footprint.

The current sample does **not establish multi-second GC pauses**. There were 44 logged loop gaps of at least one second, up to 17.469 seconds. The largest gap coincided with 298 MB of main-thread read input. Isolated JSC logs showed maximum pause fragments of 1.72–6.31 ms across the three read workloads. Full registry materialization nevertheless caused a 1.067-second loop gap. Synchronous application work is a demonstrated contributor.

The controller subsequently authorized a disposable writable clone, with the pristine copy preserved. The **compiled Viewer then completed startup and HTTP polling** under PID/network/filesystem containment. Its 60-second diagnostic window used **1,883.77–2,278.31 MiB RSS**, held **1,174.97 MiB of collected heap** afterward, and had zero timer gaps ≥1 s. A validated diagnostic snapshot identifies **two separate pipeline-store maps retaining 562.41 MiB combined**, including **441.14 MiB in archived collections**. This is a larger measured target than the source-only replay exposed.

The bounded copied-data replay supplies actionable heap attribution and allocation-producing callsites for the builder. It does not recreate the full production footprint, long-running history or client mix. This lane performed no production GET, signal, heap snapshot, forced GC, restart, deploy, or mutation. Its continuation made no further production requests; the poll lane's separately authorized single GET remains peer evidence.

## Evidence ledger and isolation

All times in this document are UTC on 2026-10-15. Raw databases, heap dumps, CPU profiles and logs contain private state and remain outside the repository. `$AUDIT_ROOT` denotes the private directory created by `tempfile.mkdtemp(prefix="viewer-heap-audit-", dir="/tmp")`; `$RELEASE` denotes the verified installed release. The local directory suffix is intentionally omitted here. Each command's outputs are named so the operator can inspect the retained artifacts.

| ID | UTC bounds | Exact command/query or probe and evidence |
| --- | --- | --- |
| E1 | 05:08–05:11; rechecked 05:30:55 | `git rev-parse HEAD`; read `/proc/1834964/cwd`, `/proc/1834964/exe`, `/proc/1834964/cmdline`; `$HOME/.bun/bin/bun --version`; compare `bun.lock` with `$RELEASE/bun.lock`. Viewer PID 1834964 ran the named release; runtime host PID 1834890 was a separate process. |
| E2 | 05:10:13.546050–05:20:13.546245 | `python3 "$AUDIT_ROOT/sample.py"`: 3,001 samples of `/proc/1834964/stat`, `/proc/1834964/task/1834964/io` and matching main/HeapHelper task `stat` files at 200 ms; 601 `/proc/1834964/status` reads at 1 s; 61 `/proc/1834964/smaps_rollup` reads at 10 s. Verify process start ticks on every sample. Output `out/live-proc.jsonl`, reduced to `live-summary.json` and `live-cpu-summary.json`. |
| E3 | 05:10:14.691083–05:10:15.703869 | Python `sqlite3.connect(source.as_uri()+"?mode=ro", uri=True)`; `PRAGMA query_only=ON`; `source.backup(destination, pages=1024, sleep=.01)` for each database. Destination files chmod 0400; SHA-256 manifest in `out/copy.json`. No live checkpoint or schema operation. |
| E4 | Window 05:10:13–05:20:14; read after the window | `journalctl --user -u delegatus.service --since "2026-10-15 05:10:13 UTC" --until "2026-10-15 05:20:14 UTC" -o json --no-pager`. Output `out/live-window-journal.jsonl`. The launcher's journal carries Viewer output; filtering by Viewer PID alone incorrectly returns no gaps. |
| E5 | 05:12:05.984–05:13:09.226 | `bun audit-replay.ts baseline 60` through the installed gate and isolated launcher: registry lazy view plus pipeline-health reads; CPU profile and heap snapshots. Timed window 05:12:07.981–05:13:09.105. |
| E6 | 05:15:05.715–05:15:06.401 | `bun audit-compiled.ts`, contained, imports production compiled pipeline/archive/task route handlers with a Next request. All three reads returned 500 with `EROFS` on copied-state chmod. Output `out/compiled2.log`. The preceding attempt needed the Next `AsyncLocalStorage` global; its failure was corrected before this measurement. These failures are excluded from successful replay results. |
| E7 | 05:17:16.598–05:18:22.154 | `bun audit-materialized.ts materialized 60`, contained: enumerate cold registry values; call full `snapshot()` every ten seconds. Timed window 05:17:21.561–05:18:21.843. |
| E8 | 05:18:51.632–05:18:55.623 | `bun audit-alloc.ts`, contained: source-callsite JSON parse/stringify/clone counters over the copied rows. Output `out/allocations.json`; separate from latency runs. |
| E9 | 05:19:33.943–05:20:37.593 | `bun audit-composite.ts composite`, contained: production source read paths with the read-only constructor adapter below. Timed window 05:19:37.351–05:20:37.445. Output `out/composite-metrics.jsonl`, `composite.log`, `composite.heapsnapshot`. |
| E10 | 05:22–05:24 | `bun map-probe.ts`; `bun audit-bridged.ts bridged`; `node "$AUDIT_ROOT/heap-analyze.mjs" <snapshot>`. Minimal Map fixture, then diagnostic strong-edge bridge and dominator analysis. Output `out/map-proof.heapsnapshot`, `bridged.heapsnapshot`, `bridged.heapsnapshot.analysis.json`. Bridge run began 05:23:32.348. |
| E11 | 05:25:26.024–05:25:26.503 | `bun audit-delta.ts`, contained: real `recordDeltaLink`/`rememberProjection` functions exposed by a scratch Bun loader; 80 synthetic scopes, two links per scope. Output `out/delta-retention.json`. |
| E12 | 05:18–05:31 | Read-only SQL census and field aggregation below; `git show 781ecd4c3348:<file>` for original line references; `rg -n` on cache/projection/read paths. Rehashed both copies at 05:30:55: identical to E3. |
| E13 | 05:37:14.869–05:38:33.347 | `bun audit-inspector.ts`, `bun audit-webkit.ts`, `bun audit-map-native.ts`, separately through the gate and containment. Node inspector compatibility probes failed; raw WebKit protocol tracking succeeded against an owned port-0 child. Outputs `out/inspector-probe.json`, `webkit-probe.json`, `map-native.json`. |
| E14, peer evidence | GET 05:37:07.395774–05:37:07.869468; report inspected 05:41–05:42 | Poll-payload audit E9: `rtk proxy python3 "$AUDIT_ROOT/live-get.py"` issued its one authorized authenticated `GET /api/files?view=summary`, requesting gzip, with a 60-second deadline, 128-MiB body cap, no redirects and no retries. This lane read the updated peer report locally; it did not repeat the request. |
| E15 | 05:46:42; resumed 05:49–05:52 | Python `shutil.copyfile` copied each frozen input into `$AUDIT_ROOT/continued/state`; equal source/destination SHA-256 values recorded in `continued/out/clone.json`. A fresh `state2` copy from the same pristine inputs supplied E17. Scratch source is the same archived release; `.next` and dependencies are read-only links to that release. |
| E16 | 05:52:35.742–05:55:12.653 | Required gate → `python3 "$AUDIT_ROOT/continued/launch.py" audit-driver.ts`. Actual compiled Next server, port 0, full startup and 56 polling iterations. HTTP succeeded; `Heap.startTracking` failed to settle within its 60-second deadline. `continued/out/failure.json` preserves that result. The inspector also returned before an asynchronous collection finished; its first 0.301 seconds overlap the polling window. This run is excluded from the clean GC-window table. |
| E17 | 05:56:28.013–05:58:18.113 | Required gate → `python3 "$AUDIT_ROOT/continued/launch-v2.py" audit-driver-v2.ts`; timings 05:57:04.037–05:58:04.344, allocation window 05:58:04.72–05:58:13.160, heap diagnostic 05:58:13.16–05:58:17.953. `continued/out2/` contains HTTP responses' status/size/timing ledger, server metrics, `/proc/self/smaps_rollup`, GC log, callsite counts, snapshot and completion record. |
| E18 | 05:59–06:04 | Required gate → `node "$AUDIT_ROOT/continued/analyze-details.mjs" "$AUDIT_ROOT/continued/out2/server.heapsnapshot"`; dominators, collection identities and global owners saved beside the snapshot. GC reduction selects the main VM between explicit `AUDIT_PHASE timed` / `post-timed` markers and extracts `p=` fragments and `cycle` values separately. Original database hashes rechecked at 05:59:15.858, unchanged. |

Initial heavy commands ran one at a time through the installed `781ecd4c3348/scripts/gate-slot.sh`, with an absolute Bun binary, in a scratch `git archive 781ecd4c3348` export. Dependencies were linked from the installed release only after equal lockfiles were verified. Every child received isolated `HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR` under `$AUDIT_ROOT`, plus:

```sh
LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1
LLV_STRUCTURED_HOSTS=0
LLV_RUNTIME_EVENTS=0
LLV_ACCOUNT_CONTROLLER_DISABLED=1
DELEGATUS_TELEMETRY=0
NEXT_TELEMETRY_DISABLED=1
NODE_ENV=test
BUN_JSC_logGC=1
```

The launcher constructs an environment allowlist; it does not inherit credentials or live state settings. E5 directly exercised read-only store APIs. Subsequent Bun probes additionally used:

```sh
bwrap --ro-bind / / --unshare-pid --unshare-net --proc /proc \
  --dev /dev --tmpfs /run --bind "$AUDIT_ROOT" "$AUDIT_ROOT" \
  --ro-bind "$AUDIT_ROOT/state" "$AUDIT_ROOT/state" -- "$BUN" <probe> <args>
```

Read-only host mounts prevent writes through paths embedded in copied records. Private PID and network namespaces prevent reaching or signaling live workers. Each child PID was recorded by its launcher and waited to completion. No process was stopped by name, pattern or port. No test or profile used live state. The stage's own scope had a 5 GiB memory limit; heavy probes use the installed gate's work scope (configured 8 GiB memory/300% CPU), so these results are not unthrottled production latency estimates. Other lanes shared the host.

E9's scratch adapter changes `openDatabase` to use the existing read-only connector and bypasses initialization only after exact existing collection markers match. It leaves row queries, decoders, cloning and caching unchanged. Diagnostic globals expose existing owners to the snapshot analyzer. This permits component measurements without migration authority; it does not exercise full Viewer startup, scanner, controllers, runtime host, browser traffic or deferred readiness work.

### Authorized compiled continuation

E16/E17 used the controller-specified `fd5a3273a7d2/scripts/gate-slot.sh`, followed by an environment-allowlist launcher. The launcher's `bwrap` gave the child private PID and network namespaces, read-only host mounts, empty `/run` and `/tmp` mounts, and one writable bind for `$AUDIT_ROOT/continued`. It masked the host's config, Codex, Claude and CPU-admission directories. `HOME`, config, temp and state were all under the disposable clone; executable search used an empty directory. The original frozen files were outside the writable bind. The only HTTP traffic was to the assigned port inside the private network namespace; `LLV_VIEWER_CONTROL_URL` still named closed loopback port 1. Real structured hosts and runtime events were disabled. No live registry, runtime host or production Viewer was contacted.

The Next server used the release's unmodified compiled build and its real startup instrumentation. The test server additionally exposed local diagnostic commands inside containment. The parent awaited those commands over its private HTTP connection in E17, avoiding the inspector's asynchronous-evaluation problem in E16. Startup and normal handlers could change the disposable databases. Both runs began from copies of the original input, and their mutated copies remain separate. Scanner inputs included the saved scan snapshot; account homes and live transcripts were absent. Launch/control/network behavior and long-lived external writers therefore differ from production.

E17 recorded 300% CPU and 8 GiB memory limits in its gate service; the tightest ancestor CPU limit was 1,800%. The service had no OOM events at the 05:57:05 observation. Map/Set tracking, GC logging and 100 ms process metrics add diagnostic overhead. Fifteen seconds elapsed after warm HTTP requests before the measured interval. Global-state keys and startup output are retained in `flags.json` and server logs; this does not prove every deferred readiness condition. These are bounded post-warm observations, with no claim of a 30-minute steady state.

### Frozen data

| Copy | Size | SHA-256 |
| --- | ---: | --- |
| `state.sqlite` | 156,934,144 B | `e5b529b2cce2033fff06de8771762e6ffe0b35a6e837f660a4ec36e7496b154c` |
| `agent-registry.sqlite` | 416,051,200 B | `a3adda4516e64741b70dada993b170c14ec6a06e6cddf716d1188b1b36fa3f9f` |

Each database backup is individually consistent; the two captures are not a cross-database transaction. Read-only connections created scratch shared-memory/empty WAL companions before containment. Primary-file hashes remained unchanged. The copied 909,717-byte `files-scan-snapshot.json` is scanner state, not an HTTP response body.

The census query, run on each copy, was:

```sql
SELECT collection, count(*), sum(length(CAST(value_json AS BLOB))),
       max(length(CAST(value_json AS BLOB)))
FROM state_rows GROUP BY collection;
-- Same aggregation over registry_rows in agent-registry.sqlite.
```

| Collection | Rows | Stored JSON UTF-8 bytes |
| --- | ---: | ---: |
| Active pipelines | 257 | 34,872,115 |
| Archived pipelines | 654 | 86,761,075 |
| Both pipeline collections | 911 | 121,633,190 |
| Tasks | 1,805 | 8,644,321 |
| Registry current rows, all collections | 42,177 | 143,397,030 |
| Registry delivery operation owners | 9,124 | 80,982,755 |
| Registry receipts | 5,680 | 34,651,585 |

Registry archive rows can duplicate current versions; their bytes are not added to logical payload totals.

## Production observations

E2, in KiB as reported by Linux:

| Metric | First | Last | Minimum | Maximum |
| --- | ---: | ---: | ---: | ---: |
| `VmRSS` | 6,210,292 | 7,546,164 | 6,156,888 | 10,261,448 |
| `VmHWM` | 12,960,300 | 12,960,300 | 12,960,300 | 12,960,300 |
| `RssAnon` | 6,124,428 | 7,460,300 | 6,071,024 | 10,175,584 |
| rollup `Pss` | 6,162,194 | 7,478,328 | 6,162,194 | 10,183,254 |
| rollup `Anonymous` | 6,129,584 | 7,460,632 | 6,129,584 | 10,150,480 |
| `VmSwap` / rollup `Swap` | 0 | 0 | 0 | 0 |

The ten one-minute RSS floors were 6,156,888; 6,627,220; 6,414,860; 6,589,040; 6,835,780; 6,759,008; 6,688,784; 6,777,968; 6,684,308; 7,075,256 KiB. A rising endpoint over ten minutes cannot establish a leak. The process already had the 12.36 GiB high-water mark when sampling began.

Main-thread CPU increased by 544.25 seconds over 600 seconds, or 90.71% of one core. E4 contained 79 loop-gap messages, 44 at least one second, including three with empty `operations`. It also contained 46 logged runtime-snapshot transfer/parse observations; that count is not a complete request count.

| Gap ending UTC | Logged gap | Inner sampled interval | Main CPU | Main-thread `rchar` increase | Read calls | HeapHelper CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 05:11:23.912371 | 17,469 ms; empty operations | 17.200 s | 17.190 s | 297,995,743 B | 175,070 | 0 s |
| 05:15:41.433330 | 8,473 ms | 8.200 s | 4.350 s | 6,862,825 B | 4,291 | 0 s |
| 05:14:26.793292 | 5,049 ms | 5.000 s | 4.920 s | 8,525,952 B | 3,042 | 0.120 s |
| 05:15:58.549941 | 4,892 ms | 4.800 s | 4.540 s | 7,426,781 B | 4,640 | 0.090 s |

`rchar` counts bytes supplied by read operations, including cached input; it is not disk-I/O volume. Samples cover an inner portion of each gap, with 200 ms resolution. No contiguous interval of at least one second met the chosen historical signature of at least 75% main-thread CPU and zero read calls. This does not exclude GC within mixed work. Empty `operations` establishes an instrumentation gap, not a GC cause.

## Retainers on the copied state

Heap size is read after two explicit collections outside each timed window, separated by event-loop turns. `heapSize` includes `extraMemorySize`; adding those two counters would double-count. See the [Bun heap-stat definitions](https://bun.sh/reference/bun/jsc/HeapStats).

### Snapshot integrity and limits

The stock Bun V8-format snapshot omitted strong Map-entry edges in a minimal sentinel test: the Map's `Cell Butterfly` had no edge to its known value. E13 confirmed the same missing edge in the native JSC snapshot format. Consequently only 533,870 of 1,454,047 nodes were root-reachable in the unmodified composite snapshot, and populated stores appeared to retain about 256 bytes. Those dominator sizes are unusable.

For E10 only, the diagnostic traversed known store owners' own data properties and added non-enumerable arrays of their existing Map/Set entries. It skipped database handles, functions and getters. This exposes already-held strong references to the snapshot exporter. Heap size increased from 613,318,061 to 617,437,034 bytes: **4,118,973 bytes of diagnostic overhead**. Of 1,465,733 snapshot nodes, 1,451,734 then became reachable. Strong-edge dominators exclude weak edges; shared objects are charged to their common dominator. The figures below include bridge overhead and omit edges still absent elsewhere. They rank these warmed component owners. Live production ownership was not measured.

| Owner / retention path | Retained bytes (MiB) | Production source and reason |
| --- | ---: | --- |
| Pipeline stores, total | 362,566,904 (345.77) | `src/lib/pipelines/store.ts:1294`, `:1412`, `:1418`; module map retains collection instances. Includes the next two rows. |
| Archived pipeline collection | 300,346,602 (286.43) | `src/lib/state/sqliteStateStore.ts:1806`, `:1815`, `:1824`; full cache retains serialized `valueJson`, decoded values, order arrays and keys. `loadArchivedPipelines` at `src/lib/pipelines/store.ts:1710` warms it. |
| Active pipeline collection | 62,218,907 (59.34) | Same cache path. Projection objects also have other owners, so this exclusive size understates all memory attributable to active pipelines. |
| Registry store | 104,413,698 (99.58) | `src/lib/agent/sqliteRegistryStore.ts:704` and the lazy-reader path at `:1727`; includes the following registry entries. |
| Registry `coldStableRows` | 80,732,448 (76.99) | `src/lib/agent/sqliteRegistryStore.ts:1744`; normalized rows and pinned grants. Already bounded at `:319`/`:1746` by 48 Mi **JSON code units**; this is not a 48 MiB expanded-heap limit. |
| Registry cold keys / collection order / row projections | 6,382,951 / 4,592,457 / 4,434,963 | Separate store-owned indexes; avoid summing them again with the registry total. |
| Registry `coldReaderRows` | 2,845,013 (2.71) | `src/lib/agent/sqliteRegistryStore.ts:1753`; existing 128-entry eviction. |
| Task collection store | 16,158,977 (15.41) | `src/lib/tasks/store.ts:344`, `:355`, `:560`, and the common state collection cache. Other task/projection objects remain shared. |

Strings account for **525,978,125 bytes** of snapshot self-size. A separate startup probe holding the decoded 911-pipeline array retained **205,053,042 bytes** through ordinary array edges, without the Map bridge. Loading archived pipelines increased collected composite heap from 277,140,368 to 580,769,722 bytes. This makes archive hydration the largest measured persistent increment in this replay.

The frozen pipeline documents contain repeated role scaffolds and repeated reports. A recursive field census sums UTF-8 string lengths; hashing values longer than 1,000 bytes identifies 99,982,072 bytes of large strings, 33,747,443 unique bytes and **66,234,629 duplicate bytes**. This is a payload deduplication opportunity; equivalent heap savings cannot be predicted because engine string representation and sharing differ.

| String field | UTF-8 bytes across 911 documents |
| --- | ---: |
| `runs[].attempts[].effectiveRole.promptScaffold` | 23,158,884 |
| `runs[].attempts[].input` | 16,183,931 |
| `stages[].effectiveRole.promptScaffold` | 14,708,763 |
| `runs[].attempts[].output` | 12,818,407 |
| `stageReports[].summary` | 6,656,111 |
| `runs[].attempts[].report.summary` | 6,528,916 |

### Confirmed unbounded delta scopes

`src/app/api/files/operatorProjection.ts:117` creates entries in the global `__llvFilesDeltaLinks` map. `:127` bounds each scope to 32 links. `:352` limits the separate response-body cache to 32 scopes, but `:359` evicts only its body entry. The outer delta map has neither a scope cap nor a byte cap. The scope key at `:275` includes pinned path and summary/agent visibility.

E11 invoked the existing functions with synthetic data; it did not call the HTTP handler. With 80 scopes and two links per scope, the body cache held 32 scopes while the delta cache retained **80 scopes, 160 links, 13,271,480 UTF-8 bytes**. The first evicted body still had history. Collected heap at 0/40/80 scopes was 18,299,633 / 24,910,052 / 31,657,196 bytes. Thus eviction failed to release history in this probe. Production scope count and retained delta bytes remain unknown. The poll-payload lane owns the correction and contract tests.

### Compiled Viewer: duplicate collection caches

E17 installed diagnostic wrappers around `Map.prototype.set` and `Set.prototype.add` before loading Next. Weak references recorded containers without keeping their contents alive. After the workload and explicit collection, the wrappers were removed; each surviving tracked container received an array of its existing entries. The registration list was then released and collection repeated on later turns. This supplies the strong edges missing from the exporter without introducing a new global root for those contents.

The bridge visited 154 Maps and 1,602 Sets, exposing 441,040 entry slots. The resulting snapshot has **2,458,946 reachable nodes out of 2,467,505 (99.65%)**, with **1,193,787,260 bytes** below the root. Strings contribute 1,066,818,026 bytes of total snapshot self-size. The bridge's 1,753 surviving arrays and their identified Butterfly nodes account for **789,232 snapshot self bytes**. Collected heap moved from 1,236,583,935 to 1,234,931,050 bytes while 76,548 weak-reference registrations were released; that negative net change is not the bridge's allocation cost. Some backing-store/native costs and untracked internal-container edges remain outside this accounting. These numbers carry the exporter limitation and diagnostic overhead. They rank the large owners; exact process-RSS accounting remains incomplete.

| Compiled-process owner | Retained bytes (MiB) | Source attribution / evidence |
| --- | ---: | --- |
| Two pipeline-store maps, combined | 589,727,861 (562.41) | Module-local `pipelineStores` at `src/lib/pipelines/store.ts:1294`; snapshot contains two distinct maps, each holding active/archive collections for the same clone database. Their separate totals are 362,617,743 and 227,110,118 bytes. |
| Two archived collections, combined | 462,570,532 (441.14) | `src/lib/state/sqliteStateStore.ts:1806` / `:1815` / `:1824`, called by `src/lib/pipelines/store.ts:1710`. Individual retained sizes: 300,613,694 and 161,956,838 bytes. Included in the preceding row. |
| Two active collections, combined | 127,150,773 (121.26) | Same full-cache implementation; individual retained sizes 62,002,867 and 65,147,906 bytes. Includes one 3,144,081-byte controller cache. Included in the pipeline total. |
| Registry store | 79,701,747 (76.01) | `src/lib/agent/registry.ts:4586`, `src/lib/agent/sqliteRegistryStore.ts:704`; its `coldStableRows` subtree is 56,858,069 bytes (54.22 MiB). |
| Files response cache | 58,714,274 (55.99) | Global `__llvFilesProjectionCache`, `src/app/api/files/operatorProjection.ts:110` / `:352`. This run uses one summary scope; delta history is only 124,482 bytes here. |
| Two task stores, combined | 32,326,017 (30.83) | Module store ownership at `src/lib/tasks/store.ts:344` / `:355` / `:560`; separate snapshots of the `tasks` collection. |
| Role-memory collection | 18,593,517 (17.73) | `role_memory`, declared at `src/lib/memory/roleStore.ts:36`, using the common full-collection cache above. |

The compiled snapshot labels the duplicated collection classes differently (`aj` and `ak`) and retains them under different lexical environments. Their `options.collection` fields prove the collection identity. This verifies duplicate module-owned caches inside one process; it does not identify which compiled import first hydrated each instance. The sum above excludes additional projection objects shared outside those store dominators. A cache-sharing change must be verified on the compiled application, where these duplicates exist.

## Allocation-producing callsites

E8 wraps JSON and clone operations at source callsites and records calls and UTF-8 payload sizes. It supplies **byte-throughput attribution**, not a complete native or JavaScript allocation profile. Clone sizes are serialization equivalents; extra serialization for counting is excluded from native-call timing but changes the diagnostic process's work. Allocation counters run separately from timing and retention probes.

| Operation and source | Calls per observed invocation | Payload bytes per invocation | Rate under a stated replay cadence |
| --- | ---: | ---: | --- |
| Full registry snapshot parse, `src/lib/agent/sqliteRegistryStore.ts:3319` | 42,177 | 143,397,030 | 820.52 MiB/min at six calls/min |
| Enumerate lazy registry values, `src/lib/agent/sqliteRegistryStore.ts:1727` | 41,664 | 142,347,096 | 814.52 MiB/min at six equivalent cold passes/min; warm cache behavior differs |
| Pipeline health parse, `src/lib/state/sqliteStateStore.ts:943` | 911 | 121,633,190 | 695.99 MiB/min at six calls/min; 6.80 GiB/min at one call/s |
| Pipeline startup decode, same source | 911 | 121,633,190 | Once per startup/adoption invocation; no production rate inferred |
| Registry normalization clone, `src/lib/agent/registry.ts:2013` | 124,992 stringify + 124,992 parse | 8,874,432 for each direction | About 16.93 MiB combined payload per cold materialization |
| Pipeline startup role clones, `src/lib/pipelines/store.ts:1214` / `:1215` | 298 / 298 | 11,155,744 / 544,440 | Startup-only in this probe |

Rates are arithmetic for the named cadence, not measured production traffic. Individual parse operations consumed 182.86 ms for the full registry and 130.76 ms for pipeline health in E8; instrumentation, decoding, normalization and yielding add further work. E5's CPU sampler recorded 17,371 samples: JSON parse 8,463 (48.72%), SQLite iteration 6,253 (36.00%). These are CPU samples, not allocation samples.

At 05:11:23.576, the isolated Bun 1.4.0 inspector returned `Inspector error -32601: 'HeapProfiler.startSampling' wasn't found`. No complete allocation-stack sampling result is claimed. Bun's CPU profiler supplies execution samples and `--heap-prof` supplies a heap snapshot; neither substitutes for allocation totals. See [Bun profiling documentation](https://bun.com/docs/project/benchmarking). A suitable allocation profiler or audited per-operation counters across the full Viewer remain necessary for complete allocation/minute attribution.

E13 checked the alternative transport: raw WebKit `Heap.enable`, `Heap.startTracking` and `Heap.stopTracking` succeeded against an isolated child, while the Node inspector compatibility bridge rejected those commands. Tracking emitted initial/final JSC snapshots and GC events. The snapshot schema contained nodes/classes/edges, with no allocation stacks; the [official protocol definitions](https://github.com/oven-sh/bun/blob/main/packages/bun-inspector-protocol/src/protocol/jsc/index.d.ts) expose tracking snapshots separately from CPU stack samples. This probe verifies a usable snapshot/GC transport without claiming allocation-stack coverage. Its child was terminated only by its recorded owned PID and awaited.

### Compiled HTTP allocation profile

E17's separate 8.438-second diagnostic window made five requests each to the active pipeline list, the closed-inclusive list, files summary and tasks, with a one-second delay after each group. Wrappers counted global JSON operations whose string input/output was at least 1,024 code units, retaining stack locations and Bun's shallow result-size estimate. They observed **1,770 pipeline stringifications**, **256,751,835 UTF-8 bytes** of results and **456,917,410 bytes of cumulative shallow string estimates**. That is **1,741.14 MiB/min of UTF-8 output** and **3,098.54 MiB/min of shallow string-result estimates** at this diagnostic cadence.

All four observed stack groups resolve to compiled `app/api/pipelines/route.js:200:34067`, whose code is the `JSON.stringify(pipelines[index])` call at **`src/app/api/pipelines/route.ts:63`**. The caller groups distinguish the two list branches and continuations after the existing four-millisecond yield. **`:70` additionally joins all parts into the response**; that allocation and response encoding are outside these wrappers. Thus the real HTTP path confirms heavy string creation even with cached decoded rows and cooperative yielding.

The counter does not observe native `Response.json`, worker heaps, small JSON calls, all intermediate strings or every object allocation. Files responses in this interval were cached. No sampled allocation stack profiler is available through the tested Bun inspector methods; the successful per-callsite counts and shallow output sizes have the narrower scope stated here. The earlier component decode profile remains the evidence for cold registry and pipeline-health parsing. None of these rates is a measured production rate.

### Poll payload lane evidence

The separate [board poll payload audit](board-poll-payload.md), initially read at 05:30Z and updated evidence read at 05:41–05:42Z, owns `filesProjection`, `filesDelta`, `useFiles` and their contract. Its E3–E6 measurements use stored production bodies and isolated replay; its continuation E9 records a separately authorized live GET. These remain peer measurements.

Its 05:19:39 body contains 33,532,418 UTF-8 bytes: 1,705 tasks, 238 pipelines and 686 files. Pipelines contribute 23,943,981 bytes (71.4%). The observed A→B delta is 76,259 bytes, or 10,698 gzip bytes, versus 6,765,121 gzip bytes for full B. Existing summary delta v1 and gzip are already deployed.

The peer measured full serialize/hash median 157.63 ms and `diffFilesBodies` median 172.11 ms. Full stringify returns a string with a **62,039,434-byte shallow estimate**; the diff parses **67,061,881 UTF-8 bytes** and makes **16,357 stringify calls**, whose cumulative shallow string-result estimates total **122,986,102 bytes**. Roughly 176.45 MiB of string-result estimates can therefore accompany a changed-scope build before parsed graphs and comparison maps. These are cumulative output estimates; they neither measure simultaneous retained heap nor total allocator traffic. Scope build sharing prevents unconditional multiplication by tab count.

Its Chromium real-client-cache median apply times were 296.40 ms full and 3.60 ms delta. They exclude React/layout/network. The same body exceeds the browser persistence cap after stringify. The peer coordinated that issue with the cold-start lane. Neither lane used a live GET for those original replay measurements.

On continuation the controller authorized the poll lane to make exactly one bounded authenticated production GET, including normal incidental handler writes. It completed at **05:37:07.395774–05:37:07.869468Z**, returning **HTTP 200**, a **full gzip stale projection**, **33,671,784 decoded bytes / 6,802,172 encoded bytes**, **470.49 ms TTFB** and **473.69 ms total**. Pipelines accounted for **71.496%** of decoded bytes; the body was **139,366 bytes (+0.416%)** larger than stored B. The peer reports no retry, credential output or runtime change. Its decoded-body SHA-256 is `ad436bc7f84e137c187d2d0a38396941a29cc9367fe14890e03df12684bf7f88`.

The attached `files-json=119.1ms` is historical cached build timing, including summary preparation and hashing; it cannot measure serialization performed during this GET. A stale answer can schedule a background rebuild, which the peer did not profile or await. The request used no conditional/delta opt-in and therefore establishes neither the open-tab full/delta/304 mix nor current per-request allocation or heap retention. It occurred after this lane's ten-minute `/proc` sample. The later E17 clone replay adds full-process evidence below; this peer request provides no additional heap attribution.

## GC and event-loop evidence from replay

These are three different workloads, **not before/after fixes**. None is a complete production-load reproduction. Warm collection loads and explicit pre/post collections are outside timed windows; automatic collections within the window are counted from JSC logs. Loop gap is a 100 ms timer's delay beyond its expected tick. RSS samples are taken within the process, so a synchronous peak between samples can be missed.

| Timed workload | Duration / iterations | Sampled RSS range, MiB | Collected heap, MiB | GC pause fragments / max ms / total ms | GC cycles / max cycle ms | Loop gaps ≥1 s / max ms |
| --- | --- | ---: | ---: | --- | --- | --- |
| Lazy registry + pipeline health, CPU profiler enabled | 61.120 s / 61 health reads | 243.05–375.28 | 56.79 | 725 / 1.718 / 391.840 | 725 / 1.712 | 0 / 15.238 |
| Materialized registry, full snapshot every 10 s | 60.276 s / 6 snapshots | 379.55–805.98 | 142.81 | 220 / 2.064 / 176.404 | 77 / 52.844 | 1 / 1,066.917 |
| Composite pipeline/task/registry reads | 60.058 s / 56 iterations | 813.38–1,526.66 | 584.61 | 165 / 6.309 / 123.365 | 116 / 54.489 | 0 / 940.853 |

The composite warms active pipelines, archives, tasks and registry values; each one-second iteration loads/serializes active pipelines and tasks, with pipeline health and a full registry snapshot every tenth iteration. Its serialized output totals 38,928,796 code units per iteration. Data is representative in size and contents; cadence is an explicit stress model. Production request mix, scanner reads, concurrent writers, slow clients, scope churn, browser count, and the 95-minute historical runtime-snapshot history were not reproduced.

The successful compiled E17 run adds the following **diagnostic baseline**, with no product fix applied:

| Timed compiled workload | Duration / iterations | RSS range, MiB | Post-window collected heap, MiB | Main-VM pause fragments / max ms / total ms | Main-VM cycles / max ms | Loop gaps ≥1 s / max ms |
| --- | --- | ---: | ---: | --- | --- | --- |
| Concurrent files-summary/tasks each second; closed-inclusive pipelines every tenth iteration | 60.306 s / 58 iterations | 1,883.77–2,278.31 | 1,174.97 | 98 / 9.420 / 366.463 | 74 / 30.317 | 0 / 188.836 |

All 122 timed responses returned 200: 58 files bodies of 31,848,457 bytes, 58 task bodies of 7,088,757 bytes and six closed-inclusive pipeline bodies of 16,582,195 bytes. The pipeline query still hydrates the full archive before applying its list filter/limit (`src/app/api/pipelines/route.ts:85`). Median request durations were 208.75 / 95.85 / 183.82 ms respectively. One files request took 2,555.92 ms despite the absence of a matching one-second loop gap; HTTP duration alone does not establish a GC pause.

The main VM is the first VM in the child log and the one whose logged heap reaches 1,667,488 KiB; two small worker VMs' three additional fragments are excluded. Explicit phase markers separate startup, timing, JSON counters and heap export. Startup had three timer gaps ≥1 s, maximum 2,546.77 ms; it is excluded from the polling row. The post-window collection and heap export are also excluded. E16's completed HTTP window and failed native-tracking attempt remain recorded rather than being counted as successful heap evidence.

Count each logged `p=` fragment once; exclude `tp=` and parenthesized maxima. `cycle` spans a collection, including concurrent work, and must not be reported as a stop-the-world pause. This distinction follows the [JSC heap logging implementation](https://github.com/WebKit/WebKit/blob/75a9d414a4a8b98d26840162d103eb16227eaeb6/Source/JavaScriptCore/heap/Heap.cpp). Counts above describe emitted fragments, not necessarily one pause per collection. All three workloads had zero measured fragments ≥1 s. Log/profile overhead and shared-host scheduling limit absolute latency comparisons.

## Proposed fixes, ranked by expected gain

### Persistent heap

1. **Bound archive hydration and eliminate duplicate compiled collection caches.** E17 retains 441.14 MiB across two archive collections and 562.41 MiB across both active/archive store maps. One duplicated map exclusively retains 216.59 MiB; the task-store duplication adds about 15.41 MiB. Share appropriately keyed read-cache ownership across compiled module instances, with explicit lifetime and database-identity handling, and use bounded list/detail reads and compact projection data. Remove retained raw JSON where revision/identity checks can safely replace it. These opportunities overlap; their retained subtrees are upper opportunities, not additive guaranteed savings. Coordinate state-store changes with the DB-lock lane and evidence reads with #2905. Preserve rejected-record diagnostics, revision invalidation and independent mutable controller copies.
2. **Bound files history globally by scopes and bytes, and evict it with its body.** E11 proves a 12.66 MiB retained payload at only 80 synthetic scopes and growth despite body eviction. Actual production gain is unknown until occupancy is measured; it can grow with scope churn. The poll lane owns this change. Test full-response fallback after eviction, operator/agent scope separation, missed chains and bounded memory after repeated pin changes. Keep existing delta semantics intact.
3. **Reduce duplicated immutable pipeline metadata and large summary copies.** The data contains 63.17 MiB of duplicate large-string UTF-8 payload. Intern immutable role/version references internally or read heavy details lazily, preserving historical effective roles and reports. The board still has consumers of these fields; any wire change belongs to the poll lane. Measure heap savings before changing persisted schema.
4. **Make registry cold-cache policy reflect expanded cost and avoid whole-view enumeration.** `coldStableRows` retains about 77 MiB within its existing serialized-length budget; `Object.values` raises collected registry heap by about 87 MiB. Keep lazy access/indexes for callers that need a subset. A smaller cache trades memory for repeated decode CPU; compare both metrics. The former readonly-closure leak is already fixed and should not be reintroduced as new work.

### Allocation and pause pressure

1. **Coordinate #2905's bounded pipeline evidence path first.** One current health pass parses 116.00 MiB of stored JSON, with payload throughput up to 6.80 GiB/min at the one-second replay cadence. Remove the full decode when only health/evidence summaries are needed. Inspect that PR's actual patch and measure its result; do not duplicate its implementation or assume its current head has already deployed.
2. **Let the poll lane eliminate serialize-full / parse-two-full / stringify-each-row work.** The peer's changed-scope case produces about 176.45 MiB of cumulative string-result estimates. Revision-aware structured projections and serialization of changed records offer substantial per-build gains. Keep full/delta/304 behavior, user-visible details, gzip and rollback compatibility under that lane's tests.
3. **Reduce repeated pipeline response strings, then unnecessary full registry snapshots.** The compiled list path created 435.75 MiB of shallow string results in 8.438 seconds at the diagnostic cadence; chunked yielding leaves that allocation volume intact. Prefer bounded projections and reuse by revision; assess a streaming response only after preserving its contract. Each joined response creates further unmeasured work. **For registry snapshots, use selective or revision-based views.** Each full snapshot decodes 136.75 MiB here; six/minute processes 820.52 MiB. Keep the runtime-snapshot and MCP-writer lane boundaries: those owners must define freshness, transport, acknowledgement and mutation semantics. This audit measures the decode cost without proposing a second protocol.
4. **Remove redundant normalization clones after the large reads are bounded.** Three tiny clone round trips per archived row generated 124,992 stringify/parse pairs in one cold pass. The measured combined input is only about 16.93 MiB, so expected gain is smaller than whole-history reads. Preserve defaults, isolation and legacy decoding; optimize only with a caller-level profile.

Moving JSON work to a worker can reduce main-thread delay, but also creates transfer/copy costs and may increase total heap. Measure worker lifetime and shared copies before selecting it. No Bun pin change is proposed; any future runtime change requires both Viewer and runtime-host rehearsals under that pin.

## Before/after acceptance method

1. Preserve the E3 database hashes and all associated copied input hashes. Run baseline `781ecd4c3348` and candidate against fresh clones of the same snapshot, same Bun binary, CPU/memory limits, seeded clock/revision sequence, scope set and request schedule. Keep cold startup and post-readiness steady state as separate intervals. Wait for deferred indexes/cache initialization and record their flags before starting the steady-state clock.
2. Use the already authorized disposable writable clone design from E17. Keep the pristine copy read-only and retain PID/network/filesystem containment. Disable real launch/adoption/control traffic; bind any local replay server to port 0 inside its network namespace and read back its port. Use owned-PID cleanup. Exercise the current compiled application, including scanner and projection workers against copied inputs, without importing the audit constructor adapter.
3. Obtain passive browser request-kind/cadence evidence or an authorized capture to choose representative load. Replay quiet polling, sustained changes, 1/4/8 visible views, pinned-scope churn, slow clients and the observed runtime snapshot cadence. Include largest report changes and history access. Run each baseline/candidate pair three times, in alternating order, with a 30-minute measured steady interval after warmup. Preserve failures and timeouts.
4. In an **uninstrumented timing run**, collect `/proc` RSS/PSS/anonymous/HWM at the same cadence, JSC pause fragments/count/max/total, cycle counts, and loop-gap count/p95/max with explicit ≥1 s counts. Record CPU quota/throttling, memory pressure, response throughput, queue depth and full/delta/304 mix. Use separate runs for CPU profiles, allocation counters and before/after heap snapshots; force GC only in those isolated diagnostic runs at matched boundaries.
5. Compare collected `heapSize` and `heapCapacity`, all known cache counts/byte budgets, and validated root-retained subtrees. Re-run the Map sentinel for each runtime; document bridge overhead if required. Compare supported allocation profiles where available; for this Bun build, repeat the scoped parse/stringify/clone counters and shallow-result estimates under their own labels, including the compiled list callsite. Keep their coverage limits explicit. No sum of these counters is a complete allocation total.
6. Require lower steady heap/RSS and lower GC pause max/total on identical work, with no growth after repeated scope churn and no new ≥1 s gaps. State numeric measured deltas and uncertainty; no percentage reduction is claimed by this audit. Preserve output/model equality, diagnostics, historical details, freshness and fencing. Run explicit touched tests through the required gate in isolated roots, the local privacy gate, and required CI including Bun runtime checks. A runtime pin change additionally requires `verify-runtime-host.ts --runtime <candidate>` and Viewer verification. This stage changes no executable code and has no touched product tests.

The release's calm **30-minute production window** remains a separate acceptance criterion. This ten-minute sample has 44 ≥1 s gaps and does not demonstrate calm operation or authorize release 1.13.0.

## Prior investigations and remaining gaps

Project-scoped and unscoped `search_transcripts` / `search_memory` queries for Viewer heap/GC, registry retention, snapshot allocation and scanner caching ran during 05:08–05:23. Transcript hits were opened with `conversation_messages` at the returned transcript paths; a relevant memory hit was reopened by id. Private paths and identities are omitted. The historical investigation on `61799bbc` reported 6.5–12 GB RSS, 593 slow runtime snapshots in 95 minutes, and repeated CPU-only holds near HeapHelper bursts. Those observations supplied hypotheses; they are not current-release measurements.

The already-solved closure-chain retention in [the earlier Viewer memory verification](../verification/viewer-memory.md) and `evidence/viewer-memory/heap.json` was checked against current `rememberReadOnly` code. Its synthetic before/after result is not reused as today's result. [The earlier memory-growth research](../research/viewer-memory-growth-2026-10.md) and [hot-path clone investigation](../investigations/viewer-hot-path-clones.md) informed caller inspection. Scanner cache memory described a separate bounded watermark cache. Searches for the missing Map edges found no relevant prior project solution. The actual file list and patch of pipeline-evidence PR #2905 were inspected; its lane remains the owner.

Remaining limits: production reachable heap and cache occupancy, total allocation/minute, exact production GC pauses, and the source of the full multi-GiB production RSS remain unconfirmed. E17 closes the writable-clone/compiled-startup gap and attributes the largest retained subtrees on that clone. The original data and normal route sizes are representative; traffic cadence, absent live transcripts/runtime transport, external writers, process age and deferred initialization differ. No passive RSS command can identify individual production object owners, and tested Bun inspection exposes snapshots rather than sampled allocation stacks. These limits stay attached to the evidence; the controller's continuation directs this bounded audit to pass so the builder can work from the confirmed findings.

The builder's first targets are the duplicated full pipeline caches and archive hydration. Coordinate evidence reads with #2905, files/delta behavior with the poll lane, SQLite lifetime with the lock lane, and registry transport with the runtime/MCP lanes. No executable fix, measured before/after improvement, CI result or release approval is claimed by this audit.
Validation: at 05:36:17, the local privacy gate passed with the committed fingerprints, `--require-known-values --repository "$WORKTREE" --paths docs/perf/viewer-heap-gc.md`, run from the scratch export through the required gate with isolated HOME/config/temp/state. The gate also passed after the profiling addendum. At 05:40:03, `git diff --no-index --check /dev/null docs/perf/viewer-heap-gc.md` had no whitespace diagnostics; direct checks found no trailing whitespace or conflict markers, and `git status --short --ignored --untracked-files=all` showed only this declared document. The final owned probe process had exited. No executable repository files changed, so no touched product tests apply. CI and runtime-host rehearsals were not run; this stage neither changes the Bun pin nor publishes code. The report supplies no deployment approval.

Continuation validation at 06:07–06:10 UTC: the local privacy gate passed on this document using the current checkout's committed fingerprints and a scratch export of its HEAD; dependencies were linked only after byte-identical `bun.lock` verification. The command was the required gate followed by `bun "$CHECK_SOURCE/scripts/privacy-publication-gate.ts" --require-known-values --repository "$WORKTREE" --paths docs/perf/viewer-heap-gc.md`, with isolated HOME/config/temp/state. Both contained Viewer children were stopped by their recorded owned PIDs and awaited; both launch wrappers exited. The two original SQLite hashes still match E3, and the original scan snapshot matches E15. Whitespace/conflict checks pass and the only worktree output is this document. No commit, stage, push or production mutation occurred.
