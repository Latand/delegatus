# Viewer read-path allocation diagnosis

Diagnosis only, 2026-10-07 Kyiv (measurements below use UTC). Source: `d2fba8b76bca3789d31ac46ecb82d9cbd0897f62`, Bun 1.4.0, installed Next 16.3.6. No implementation, deployment, source deadline change, or live service request was made.

The isolated runtime summary and full snapshot take **1.03 ms and 2.40 ms** when the Viewer event loop is available. Their route performs zero registry/task-store reads. An unchanged full registry snapshot takes **100.14 ms**, and a project task GET clones **all 676 task-store rows** before returning 72 tasks. Six competing pairs of these readers raise summary/full RPC latency to **1,094.79/1,100.96 ms** in the paired control run. Substituting existing shared list readers in the diagnostic driver lowers those latencies to **7.66/10.86 ms**; this is a causal control, not an implemented fix or an acceptance result.

The smallest useful change is an enforced immutable reader view plus selective replacement of read-only consumers. The existing reader caches permit mutations, and freezing the current registry object alone leaves its accessor setters writable. A read-side registry reload also repeats normalization, grant indexing and delivery hashing across unchanged records. These must be addressed without changing the writer owned by concurrent lane #2572.

## Earlier evidence checked first

Before constructing the fixture, read `gh pr view 2529 --json title,body,files,url,headRefOid`, then the complete investigation at PR head `eec245750454c9ec9d75d34420f1eb4380b49fb7` using:

```sh
gh api 'repos/{owner}/{repo}/contents/docs/research/viewer-memory-growth-2026-10.md?ref=eec245750454c9ec9d75d34420f1eb4380b49fb7' --jq .content | base64 -d
```

PR #2529 proves retained deleted rows in the registry parsed-row cache: eight synthetic create/delete cycles leave 1,600 absent rows and 6,050,320 cached JSON bytes. Its accounting wrappers ultimately share one collection, so wrapper count does not establish duplicate ownership. The resource-failure allocation profile there was a separate fixture; it did not attribute the current runtime-summary incident. Its proposed pruning after a complete successful load or a keyed miss remains relevant. Current code was checked before reusing that conclusion.

Historical MCP queries included project-scoped `search_transcripts("structuredClone registry")`, `search_transcripts("runtime summary snapshot clone")`, unscoped `search_transcripts("structuredClone cache retention")`, and scoped/unscoped `search_memory` queries for `registry structuredClone`, `sqliteRegistryStore`, `Viewer memory growth`, and `readOnlySnapshot normalization`. Relevant PR #2529 reviewer/author transcripts were opened through `conversation_messages`; no memory result supplied an existing hot-reader fix. Some transcript terms were ignored by the tokenizer, so broad matches were not treated as evidence. A later `reconcileEmbeddedReviewFlows` search and opened historical review explain the provenance overlay's correctness purpose; they provide no performance fix.

## Read-only sizing and isolation

Production sizing used Python's `sqlite3` only, opened with `file:…?mode=ro` and `PRAGMA query_only=ON`. It selected aggregate counts; no production record, transcript, title, body, account, or identifier was copied into the fixture or this report. Database names were `agent-registry.sqlite` and `state.sqlite` under the existing state directory. No production application module, migration, HTTP handler, process enumerator, or runtime control command was invoked for sizing.

Exact aggregate queries, UTC **2026-10-06 23:33:17.566761–23:33:17.619603**:

```sql
SELECT collection, COUNT(*)
FROM registry_rows GROUP BY collection ORDER BY collection;

SELECT collection, COUNT(*)
FROM state_rows GROUP BY collection ORDER BY collection;

SELECT r.collection, COUNT(*)
FROM state_rows r, json_tree(r.value_json) j
WHERE r.collection IN ('pipelines', 'pipelines_archive')
  AND j.type = 'object' AND j.path LIKE '%.attempts'
GROUP BY r.collection;
```

Task row-kind count, UTC **2026-10-06 23:34:06.465650**:

```sql
SELECT substr(row_key, 1, 2), COUNT(*)
FROM state_rows WHERE collection = 'tasks'
GROUP BY substr(row_key, 1, 2);
```

| Collection | Count used in the synthetic fixture |
| --- | ---: |
| Registry conversations | 2,918 |
| Registry entries | 1,999 |
| Registry spawn receipts | 2,038 |
| Registry held deliveries | 3,043 |
| Registry delivery operation owners | 3,139 |
| Registry lineage edges | 2,643 |
| Registry memberships | 1,698 |
| Registry migration intents | 26 |
| **Registry total** | **17,504** |
| Task-store rows | 676: 575 tasks, 100 create receipts, 1 migration marker |
| Active pipelines / attempts | 150 / 881 |
| Archived pipelines / attempts | 194 / 827 |
| Board project rows | 8 |

Synthetic bodies use repeated innocuous text, production constructors and the repository's pipeline corpus. The recorded baseline fixture was seeded twice across first-boot initialization; the reproducer repeats that preparation for matching normalized constructor envelopes. Serialized registry size in the recorded seed is 32,219,217 bytes (constructor-generated envelopes may vary slightly between fresh runs); active-plus-archived pipeline corpus is 57,575,602 bytes. Tasks span eight projects; 72 belong to the selected project. Boards have default preferences and empty placement arrays. These body lengths, board geometry, host activity distribution, and transcript window are explicit fixture assumptions: counts alone cannot establish the operator's byte size or record shape.

The private journal contains 2,918 synthetic session entities, 32 marked alive and the rest dead, plus 575 task entities. The production journal's session retention selects 32 active plus 128 inactive sessions. Voice response bodies contain repeated synthetic text. An attempted direct count of `runtime-events.sqlite` at the state root failed to open at 23:35 UTC; the journal assumptions therefore derive from the fixture and production retention rules, not a claim about live journal activity.

Every application import, seed, request, counter and profile ran against an archived copy of the pinned source outside the worktree. `HOME`, `TMPDIR`, `LLV_STATE_DIR`, all XDG roots and the runtime Unix socket point at private temporary directories. `LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1` is the closed-port guard. Account controllers, reaper and structured hosts are disabled. The minimal synthetic RuntimeHost has no consumers. It binds a private Unix socket; there is no live Viewer or stable runtime listener involved. The parent records each started PID and stops only that child with SIGTERM. Heavy measurement commands use `scripts/gate-slot.sh`.

## Method and before measurements

The appendix preserves the complete diagnostic harness in this single declared output. It calls actual production handlers using `NextRequest`, and the runtime handlers call the real Unix RPC client/server and journal. `/api/files` uses its real response builder with an injected completed scanner result. This measures the store/projection/serialization phase; transcript discovery and a Next HTTP server are outside the timed region.

Each timing case has two warmups and nine measured calls. Wall time ends when the handler's Response is constructed; consumption of its body verifies status and byte length outside that timed region. CPU is process user plus system time over that same interval, including worker/GC activity; it can exceed wall time. p95 is nearest-rank over nine samples (the maximum), not a load-test percentile. All responses below were 200. Row/AST instrumentation and scoped CPU sampling run separately and their slower timings are excluded. The original baseline also enabled CLI sampling; the final unsampled baseline below supersedes its timing values.

Baseline command `python3 runner.py baseline` (the measurement child is `bash scripts/gate-slot.sh bun probe-measure.ts`), UTC **23:57:19.126421–23:57:47.528792**:

| Operation | Median wall ms | p95 ms | Median Viewer CPU ms | Returned bytes |
| --- | ---: | ---: | ---: | ---: |
| `AgentRegistry.snapshot()` | 100.140 | 165.800 | 172.220 | object |
| Unchanged `readOnlySnapshot()` | 0.020 | 0.029 | 0.021 | shared view |
| `readOnlySnapshot()` after one foreign entry update | 103.976 | 124.929 | 122.323 | shared view |
| `loadTasks()` | 4.283 | 5.298 | 4.573 | 575 tasks |
| Unchanged `loadTasksForList()` | 0.013 | 0.025 | 0.013 | shared list |
| `loadPipelines()` | 0.534 | 0.586 | 0.546 | 150 active |
| Unchanged `loadPipelinesForList()` | 0.004 | 0.005 | 0.005 | shared list |
| `GET /api/tasks` | 7.891 | 9.710 | 10.253 | 2,803,050 |
| `GET /api/tasks?project=viewer` | 6.210 | 9.478 | 6.186 | 350,811 |
| `buildFilesResponse`, completed empty scan | 11.815 | 14.033 | 17.423 | 2,792,280 |
| `GET /api/runtime/snapshot?view=summary` | 1.028 | 2.850 | 1.047 | 171,533 |
| `GET /api/runtime/snapshot` | 2.400 | 5.489 | 2.265 | 838,093 |
| Private journal append, then summary | 7.299 | 9.016 | 1.917 | 171,534 |
| Summary with six competing full-registry/task GET pairs | 1,094.792 | 1,245.156 | 1,340.256 | 171,534 |

The single foreign entry transaction is outside the timed registry read. The changed-summary case includes the private append RPC as well as the subsequent snapshot RPC; it is an invalidation control, not a pure cache-miss latency. The final baseline also checks the populated board (0.047 ms median, 0.072 ms p95) and 96-file window (17.252 ms median, 22.275 ms p95); the earlier dedicated window run below is an independent unprofiled observation.

Eight populated board rows and a 96-entry completed file window, `python3 runner.py window`, UTC **23:47:18.864723–23:47:20.066988**:

| Operation | Median wall ms | p95 ms | Median CPU ms | Bytes |
| --- | ---: | ---: | ---: | ---: |
| `GET /api/board?project=viewer` | 0.070 | 0.101 | 0.082 | 365 |
| `/api/files?project=viewer&view=summary` response builder, 96 files | 17.477 | 19.369 | 22.493 | 2,871,655 |

The two unsampled populated-window runs agree at about 17 ms. The final empty-window response takes about 12 ms. The measured summary-view files response still includes the full task/projection payload.

### Causal controls

The four burst cases in `python3 runner.py baseline`, UTC **23:57:19.126421–23:57:47.528792**, use the same counts, bodies, real RPC and six pairs of competing readers. Each request starts the runtime GET, runs the bounded competing readers on the Viewer event loop, and awaits the GET. The substituted task control uses the existing project pipeline projection and serializes the selected tasks. It is a diagnostic consumer substitution; it does not change repository code or establish complete route equivalence.

| Competing reader implementation | Summary median / p95 ms | Full median / p95 ms | Summary / full CPU ms |
| --- | ---: | ---: | ---: |
| Six `registry.snapshot()` + project task GET pairs | 1,094.792 / 1,245.156 | 1,100.956 / 1,756.295 | 1,340.256 / 1,460.969 |
| Six existing shared registry/task/pipeline reader pairs | 7.665 / 22.007 | 10.856 / 22.112 | 7.533 / 11.547 |

Within the final paired run, summary/full wall time improves about 143×/101× and Viewer CPU about 178×/126×. The six-reader burst is an explicit interference experiment, not a claim that a runtime GET calls `snapshot()` six times. An earlier unsampled paired run (`python3 runner.py controls`, 23:41:50.058198–23:42:05.895982) measured 602.908/760.866 ms with full readers and 3.819/4.819 ms with shared readers. That between-run variation shows process warmup and scheduling sensitivity; both independent controls eliminate the hundreds of milliseconds of synchronous reader contention. Real production frequency remains unmeasured.

## CPU profiles and exact per-request work

`bun:jsc.profile(work, 100)` sampled forty warmed calls per Viewer case, separately from timings. Source counters instrumented AST function entries and relevant native calls in the archived source, preserving original file line numbers. Native stack strings may report an inlined caller (for example task clone at `loadTasksFile:499`); the AST identifies its actual call at `tasks/store.ts:327`. Per-request numbers below come from one instrumented request after two warmups, never from dividing samples by requests. JIT stack samples are statistical and percentages for the short runtime cases have low precision.

The tables name every production hot family at or above 1% of a captured profile, with additional important allocations/counts. Native allocation, array and transport frames are attributed to the production source that invokes them. External request setup, driver body consumption and native transport lifecycle are identified separately below. Source lines refer to the pinned source.

### Registry full snapshots and foreign-write reloads

Profile columns: full snapshot / one-row foreign-write reload. Sample totals: 23,415 / 17,530. One public registry reader invocation is the unit of every count.

| Sampled hot frame and source | CPU samples % full / reload | Invocations per read |
| --- | ---: | --- |
| Collection SQL `all`, `src/lib/agent/sqliteRegistryStore.ts:1263` | 29.59 / 34.64 | 12 queries, 17,504 rows |
| JSON parse, `src/lib/agent/sqliteRegistryStore.ts:1544`, `:1553`; metadata `:1487`; registry JSON clone `src/lib/agent/registry.ts:1901` | 26.82 / below 1 | Full: 17,504 row parses + 7 metadata + 60 clone parses. Reload: 1 changed-row parse + 7 metadata + 60 clone parses |
| `parseRow`, `src/lib/agent/sqliteRegistryStore.ts:1536` (sampled cache-hit work at `:1551`) | below 1 / 9.91 | 17,504 both; unchanged raw rows avoid parsing, still undergo cache/owner checks |
| Lazy collection `load`, `src/lib/agent/sqliteRegistryStore.ts:1255` (sampled `:1267`) | 3.76 / 6.38 | 15,777 calls across repeatedly accessed collection getters; only 12 perform their full SELECT |
| Delivery hash `update`, Hash constructor and JSON stringify, `src/lib/agent/registry.ts:2379`, function `:2371` | 5.69 + 1.82 + most of 4.04 / 6.90 + 2.30 + most of 3.79 | 6,086 digest serializations/hash constructions/updates/digests each, for 3,043 held deliveries |
| Registry normalization and `Object.entries`/`fromEntries`, `src/lib/agent/registry.ts:3887`, `:3907`, `:3911`, `:3912`, `:3914`, `:3923`, `:3926` | entries 3.75 / 5.29; fromEntries below 1 / 1.65 | 20 normalizations; entries/fromEntries: 2 at :3907, 20 each at :3911/:3912, 1 each at :3914/:3923/:3926 |
| `normalizeDeliveryOperationOwners`, `src/lib/agent/registry.ts:2767` (sampled `:2851`) | 1.41 / below 1 | 20; its full `Object.values` passes at :2845 and :3802 also run 20 times each |
| `indexGrantSource`, `src/lib/agent/sqliteRegistryStore.ts:167` | 3.01 / 3.49 | 5,561 |
| `addIndexedTarget`, `src/lib/agent/sqliteRegistryStore.ts:143` | 1.96 / 2.07 | 13,949 |
| `recordGrantDecisions`, `src/lib/agent/sqliteRegistryStore.ts:114`; entries at `:128` | below 1 / 1.96 | 1 function call, 3 entries loops |
| `storedGrantOwnership`, `src/lib/agent/mcpAllowlist.ts:396`; `reboundGrants`, `:601` | 1.78 / 2.61 (ownership) | 10 each; their entries loops at :405/:499/:504/:603/:614 each run 10 times |
| Array filters, `src/lib/agent/registry.ts:2451`, `src/lib/agent/mcpAllowlist.ts:254`, `:127`, `src/lib/agent/pluginAllowlist.ts:139` | 1.97 / below 1 | 6,086 delivery filters; 4,956 calls at each allowlist filter site |
| Metadata mutation-baseline `structuredClone`, `src/lib/agent/sqliteRegistryStore.ts:1490` | below 1 / below 1 | 7 both, even with `trackMutations=false` |

Additional body work: `normalizeConversation`, `registry.ts:2228`, runs 2,918 times; `normalizeHeldDelivery`, `:2418`, runs 6,086 times; `emptyLaunchProfile`, `src/lib/accounts/migration/contracts.ts:102`, runs 4,956 times. Native JSON totals are **17,571 parses / 6,146 stringifies / 7 structured clones** for a full snapshot and **68 / 6,146 / 7** for a one-row reload.

Call chain: `AgentRegistry.snapshot` (`registry.ts:5171`) → `loadSnapshot` (`sqliteRegistryStore.ts:609`) → `loadInTransaction` (`:1124`) → collection getters → all row SELECTs, parsing and assembly. The unchanged shared-reader path (`registry.ts:5180`, `sqliteRegistryStore.ts:640`) performs one store-stamp query (`:1750`) plus storage identity checks; it has zero normalization, JSON parses or structured clones. A foreign write invalidates that view correctly but rebuilds normalization and grant-derived work for the entire returned registry. Parsing each changed raw row is already cached; the repeated derived work remains the problem.

### Task reads, files/board projection, and pipeline revival

Profile columns: project task GET / files with empty scan / files with 96 entries. Sample totals: 1,448 / 3,718 / 5,026. Counts are per actual request, with window differences stated.

| Hot frame and source | CPU samples % task / empty / window | Per-request work |
| --- | ---: | --- |
| `structuredClone`, `src/lib/tasks/store.ts:327` | 49.31 / 17.19 / 15.52 | **676 clones** every time, including 100 receipt rows and the migration row, even when only 72 tasks are selected |
| Alias `statSync` and `readSnapshot`, `src/lib/projects/aliases.ts:69`, `:65` | stat 20.30 / 9.60 / 9.81; reader 2.42 / below 1 / below 1 | 725 / 726 / 822 alias stat/read calls; other state-file identity checks are smaller contributors |
| Native path `join`, `src/lib/configDir.ts:223`, through alias `readSnapshot:66` | 2.90 / below 1 / below 1 | 725 alias joins in task GET; 736 / 832 total statePath joins in empty/window files |
| `coerceTask`, `src/lib/tasks/store.ts:170`; callback `:287`; native copy/spread at `:196`, `:202`, `:204` | coerce 1.86, anonymous 1.45, copyDataProperties 2.76 / below 1 / below 1 | 575 coercions/map callbacks and task record reconstruction before project filtering |
| Native cloneObject/map; `reviveLoadedPipeline`, `src/lib/pipelines/store.ts:1052`, its stage/run/attempt maps `:1084`, `:1097`, `:1124` | cloneObject 1.86, map 1.52 / below 1 / below 1 | 150 active pipeline revivals, 881 attempt projections. This fixture has zero pipeline `structuredClone` calls; no closed-custody records were seeded |
| `resolveAlias`, `src/lib/projects/aliases.ts:94` | 1.10 / below 1 / below 1 | 725 / 725 / 821 calls |
| Native/Next JSON response, `src/app/api/tasks/route.ts:54` | 2.49 + 1.80 / — / — | 1 response encoding; 72 selected tasks (575 for the unfiltered route) |
| `snapshotConversationLookup`, `src/lib/agent/registry.ts:3373`, sampled loop `:3380`; values `:3378` | — / 8.18 / 6.09 | 4 index builds and 4 complete passes over 2,918 conversations = 11,672 conversation visits |
| Liveness map callback, `src/lib/runtime/livenessProjection.ts:26`, sampled `:29`, `:31` | — / 7.64 / 6.09 | 2,918 calls despite a 0/96-entry supplied file window |
| `buildFilesResponse`, `src/app/api/files/response.ts:236`, sampled `:666`, `:398`, `:418` | — / 5.27 / 5.87 | 1; receipt/held-delivery/owner/tasks maps are global projection passes |
| `projectRateLimitReadModel`, `src/lib/rateLimit.ts:277`, sampled `:290`, `:303` | — / 2.58 / 4.24 | 1; scans entries/conversations before mapping the requested files |
| Native `Object.values`, `registry.ts:3378`; `files/response.ts:398`, `:418`, `:665`; `rateLimit.ts:285`, `:302` | — / 2.31 / 2.39 | 4 at lookup; 1 at each other listed site |
| SQLite prepare, `src/lib/state/sqliteStateStore.ts:897` | — / 1.59 / 1.39 | 3 collection-revision queries |
| `resolveConversationAlias`, `src/lib/agent/registry.ts:3151` | — / 1.16 / 1.29 | 2,038 / 2,326 calls in empty/window files |
| Files JSON stringify, `src/app/api/files/response.ts:921` | — / 8.36 / 9.85 (includes small overlay serializations below) | 1 output encoding; response size 2.79/2.87 MB |
| Files ETag hash `update`, `src/app/api/files/response.ts:950` | — / 12.51 / 7.90 | 1 hash over the encoded response |
| Close-host identity JSON stringify, `src/lib/pipelines/engine.ts:8556`, function `:8553` | part of stringify above | 881 calls in `reconcileEmbeddedReviewFlows` (`:2750`), once per attempt |

`loadTasks` (`tasks/store.ts:239`) → `loadTasksFile` (`:496`) → clone every stored row → reconstruct/validate 575 tasks → canonicalize every project. `loadTasksForList` reuses the revision-keyed list and avoids this work on a hit. The route then calls `projectTaskPipelineIds` (`src/lib/pipelines/taskBinding.ts:37`); its filter at `:43` runs 72 times over 150 pipelines (10,800 checks), or 575 times for the full route (86,250 checks). The selected-result binding still scans the pipeline list; keep a task-to-pipeline-id lookup keyed by pipeline revision if the final profile shows this dominating. It does not require cloning pipeline histories.

The populated board GET uses `boardFor` (`src/lib/board/store.ts:455`) → keyed SQL get (`src/lib/state/sqliteStateStore.ts:955`) → one JSON parse (`:1469`) → **one selected-board clone** (`board/store.ts:219`). Its 0.07 ms read already scales with the returned board. Retain that ownership boundary.

### Runtime RPC, journal cache and transport

Viewer sample totals: summary 160 / full 488 / append+summary 267. Counts are one ordinary snapshot request, or two RPCs in the append+summary control.

| Hot frame and production attribution | Samples % summary / full / changed | Calls per snapshot request |
| --- | ---: | --- |
| JSON parse and final frame slice, `src/lib/runtime/client.ts:335` | parse 39.38 / 33.40 / 40.07; slice 1.25 / 9.63 / below 1 | 1 parse and 1 slice of the **returned RPC frame**; 2 for append+summary |
| Response JSON stringify, `src/app/api/runtime/snapshot/route.ts:28` | 19.38 / 23.98 / 12.36 | 1 |
| Native socket write/writeBuffered, invoked at `src/lib/runtime/client.ts:342` | write 3.75 / 8.40 / 5.99; buffered below 1 / below 1 / 1.50 | 1 small request write/stringify; 2 for append+summary |
| Socket/EventEmitter/doConnect, construction `src/lib/runtime/client.ts:296` | socket 1.25 / 1.02 / 3.00; connect below 1 / below 1 / 5.24; emitter 1.25 / below 1 / below 1 | 1 socket construction/connect; 2 for append+summary |
| Native close/destroy, `src/lib/runtime/client.ts:314`, finish `:309`; abort removeEventListener `:313` | destroy 1.25 / below 1 / below 1; close below 1 / below 1 / 2.25; remove listener 1.25 / below 1 / below 1 | 1 completion/close/listener removal; 2 for append+summary |
| Data callback, `src/lib/runtime/client.ts:323` | included in parse/slice | 2 summary / 4 full deliveries in the original counted samples, 5 / 3 in the fresh repeat; chunk count is transport-dependent |
| Native Response construction, `src/app/api/runtime/snapshot/route.ts:41` | below 1 / below 1 / 1.50 | 1 |

The snapshot GET (`snapshot/route.ts:11`) invokes **zero** `AgentRegistry.snapshot`, `readOnlySnapshot`, `loadTasks`, or task-store clones. The host returns a cached encoded snapshot. Host-local profiles, captured separately under the same private journal, show where its cache misses spend CPU:

| Host frame | Host samples % | Calls on cache hit / cache miss |
| --- | ---: | --- |
| `snapshotJson`, `src/runtime-host/journal.ts:1158`; scope stringify `:1159`; stamp SQL `:1171` | small | 1 / 1 each |
| Active/inactive session SQL all, `src/runtime-host/journal.ts:2713`, `:2716` | 9.45 / 32.62 | 0 / 1 each; returns 32 + 128 sessions |
| Session JSON parse, `src/runtime-host/journal.ts:2717`; `presentSession:3007` | 6.40 (parse) | 0 / 160 each |
| Edge SQL, `src/runtime-host/journal.ts:2745`; edge Map `:2755` | 10.37 / 3.05 | 0 / 1 each |
| Scoped entity SQL/parse, `src/runtime-host/journal.ts:2817` | 6.10 / 5.79 | 0 / 3 scoped collection SQL calls, 575 task parses in this fixture |
| Other entity SQL, `src/runtime-host/journal.ts:2696` | 1.52 | 0 / 2 |
| Snapshot JSON encode, `src/runtime-host/journal.ts:1164` | 5.49 | 0 / 1 |

A changed journal snapshot invokes `snapshotAt` (`journal.ts:1119`) once, parses 735 returned records (160 sessions + 575 tasks), and encodes once. An unchanged journal snapshot invokes it zero times. Host sample total is 328, combining initial scope-cache misses, dirty snapshots and warm hits; the percentages describe that mix, while the hit/miss counts come from instrumentation. This cache already invalidates on local database changes and session/edge validity.

External/harness hot frames have no registry/store ownership: `Response.arrayBuffer` at `probe-measure.ts:42` occurs once per measured response in profiling only (files 5.49/3.72%, summary/full/changed 5.62/8.40/1.87%). `NextRequest`/native Request setup at `probe-measure.ts:17` occurs once per request (summary 1.25%, changed Request 1.50%); these setup allocations are included in route timings. Native stream `emit` (summary 1.25%) is the internal socket event corresponding to data/completion callbacks above; Bun's internal `analyze` (changed 1.12%) and profile setup Promise `resolve` (host 8.54%) expose no stable product source frame or independently countable product invocation. They are outside the proposed store change; their visible product boundaries/counts are recorded rather than inventing file lines for native executables.

## Correctness observations and smallest fix plan

The private contract probe, UTC **23:48:06.566–23:48:07.163**, repeated successfully at **23:58:50.011649–23:58:50.982054**, confirmed:

- Mutating a registry conversation returned by `readOnlySnapshot()` changes the next cached read, while a detached durable snapshot remains unchanged. Mutating a task returned by `loadTasksForList()` similarly corrupts subsequent cached reads.
- Recursively freezing the existing view rejects nested generation/assignment pushes and still permits the pure `projectTaskPipelineIds` projection of 72 selected tasks.
- **Even a frozen registry root accepts `cached.receipts = {}`.** Its collection setter is installed at `sqliteRegistryStore.ts:1468`; the metadata setter at `:1500` has the same form. A frozen accessor still invokes its setter. A plain data facade is required to enforce root ownership.
- A foreign registry transaction becomes visible on the next shared read; production registry `upsert` and `mutateTasks` also become visible. Earlier held/frozen views remain stable in those tested cases. This establishes existing invalidation behavior to preserve, not immutable-reader implementation correctness.

Implement these read-side changes in this order:

1. **Enforce immutable reader ownership at the cache boundary.** Provide a plain data registry facade after normalization and grant decisions, with frozen data properties instead of lazy writable accessors. Freeze owned nested records/arrays/extension fields once per changed cache generation; reuse unchanged frozen records where valid. Give task/list readers an equally enforced immutable cache. Keep detached copies for mutation APIs and callers that mutate. A TypeScript readonly annotation alone is insufficient. Do not freeze values that the grant assembly is still modifying.
2. **Replace only observed pure consumers.** In `/api/tasks/route.ts:52` use the immutable task list before filtering, and at `:54` use the pipeline list reader; the binding projection already creates selected task overlays. In `/api/files/dependencies.ts`, supply the immutable task list to the pure copy-on-change `reconcileTasks` and supersedence projection. In `src/lib/selfUpdate/instance.ts:194`, `quiet.dispatchVersion` only reads admission records/receipt ownership: use the immutable view or a bounded entries/receipts read projection. For project/status-scoped list requests, reuse revision-keyed selector results or a small project/status index so repeated narrow reads do not rebuild a full list; copy only returned overlays. That source inspection identifies a deployment-path full snapshot, but its live frequency and effect on the failed adoption were not measured. Existing MCP bindings (`src/lib/mcp/bindings.ts:1261`, `:1264`) already select shared list readers; this is consistent with the incident's fast targeted reads.
3. **Eliminate repeated read-side derived work.** `parseRow` already parses changed raw JSON once. Cache normalized records and delivery digests by raw value plus relevant normalization/grant dependencies, and reuse the unchanged grant-source indexes. Skip metadata mutation baselines at `sqliteRegistryStore.ts:1490` for read-only loads, just as the other baselines already respect `trackMutations`. Avoid normalizing the same collection twenty times. Preserve the complete grant decision/rebinding semantics, storage identity/data-version checks, and replacement handling. Prune absent parsed-row cache keys only after a complete successful read or a confirmed keyed miss, following PR #2529. The existing grant change journal is not a general registry journal; do not introduce a new writer protocol or change #2572's writer path. A full registry view may still scan its complete returned rows after a foreign write; targeted readers must select only the records they return, and unchanged records must avoid repeated parsing/derived allocations.

Keep `/api/files`' pipeline projection mutable: `reconcileEmbeddedReviewFlows` changes attempt state, and `attachReviewFlowAttempt` (`src/lib/pipelines/engine.ts:2589`, `:2591`, `:2595`) changes nested `effectiveRole` tier fields. The partial pipeline revival currently shares some configuration leaves. An immutable list must therefore use detached copies of the precise mutated leaves when passed to such consumers. Preserve this ownership behavior before switching or freezing a pipeline cache. This is why the task route can use the list directly but the files route needs its mutation projection.

After those changes, profile again. If significant files CPU remains, reuse the four duplicate conversation lookup indexes by immutable snapshot identity (a WeakMap is sufficient) and take one request-local alias snapshot instead of statting it for every task/pipeline. These are bounded read-side follow-ups; do not add an entire query/index framework before the allocation fix is measured. Response JSON encoding and ETag hashing scale with returned bytes and belong in the final cost. Avoid a runtime transport rewrite: the measured runtime path already encodes/parses its returned frame once and has a functioning journal cache.

### Build-stage proof and acceptance

Use focused tests by actual existing path: `src/lib/agent/registry.sqlite.test.ts`, `src/lib/agent/registry.deliveryRead.test.ts`, `src/lib/agent/mcpAllowlist.test.ts`, `src/lib/tasks/store.sqlite.test.ts`, `src/lib/pipelines/listProjection.test.ts`, `src/app/api/tasks/route.test.ts`, `src/app/api/files/response.perf.test.ts`, and the deployment snapshot-identity tests if that consumer changes. Run only touched/relevant files, each under private state through the repository gate. Do not sweep runtime/agent directories.

Tests must reject root collection replacement as well as nested mutations (including arrays and nested pipeline roles), retain a mutable projection where required, show two readers cannot corrupt each other, and show every local/foreign add/update/delete/meta write is visible to the next read while previous views remain stable. Cover foreign writes without a revision increment, database replacement, grants dependent on another changed record, deletion/pruning, legacy fallback, and mutation-transaction isolation. Existing invalidation stamps and grant rules must survive. The frozen current-object probe is specifically a failing regression case for accessor setters.

Repeat the unchanged/one-row-change readers, selected and full task GETs, populated board and 96-file response, quiet and changed runtime snapshots, and the identical six-reader interference benchmark. Record before/after wall and CPU in the eventual PR body. Require the **actual implemented handlers** under that loaded benchmark to improve summary and full snapshot by at least 5×, with no output/behavior change; retain quiet-route and cache-miss regressions. The driver-only control is evidence of headroom, not the after result. If “5×” is interpreted to require an isolated already-1-ms runtime GET to get five times faster, removal of other readers cannot establish it; the proposed fix addresses the measured loaded-server incident mechanism.

Keep ordinary RPC deadlines at 3 seconds (`src/lib/runtime/client.ts:156`) and snapshot at 10 seconds (`:20`). Both are met with margin here; do not extend them to hide contention. This diagnosis did not reproduce the exact reported 8.1-second production response, 190% CPU, 5.7-GiB RSS, mixed release, or stalled adoption on the other machine. It proves an allocation/CPU mechanism and a read-side fix direction at this machine's counted size; it does not assert production incident causality or retention-growth magnitude.

Release remains outside this stage. Record in the eventual PR body: the operator-side worker deploys the merged SHA on the incident machine with `scripts/rebuild.sh <sha>` after its incident work reaches a safe boundary so Viewer and runtime host converge. Before promotion, run `bun scripts/verify-runtime-host.ts --runtime "$(which bun)"` under private state. Coordinate read-side changes with #2572; use the existing pipeline branch. The later publication step merges `origin/main`, runs privacy-publication from the merge base, and does not wait for hosted checks. This stage changes only this investigation and makes no git publication mutation.

## After the build

The build implemented plan steps 1 and 2 and the low-risk part of step 3:

- `loadTasksForList` deep-freezes each task when its row changes and freezes the list. `GET /api/tasks` filters that list and binds it against `loadPipelinesForList`. The files response reads the same list: `reconcileTasks` and `projectSupersededTaskHandoffs` already copy only the tasks they change.
- `readOnlySnapshot()` of the SQLite registry store hands out a plain data view that is frozen all the way down: its root, every collection record, every row with everything nested in it, and every meta value. That closes the accessor-setter route (`view.receipts = {}`) and the direct one (`view.receipts[id].error = …`). The view is built from the store's own frozen copies, never from its working objects: the parse cache and the loaded rows the assembled grant decision rewrites in place stay private and mutable. A copy is made only for a row whose decided JSON changed. A view patched after a local commit keeps the previous view's frozen rows, and a reload stringifies each decided row and reuses the copy with the same JSON. A copy is never changed, so a view a reader already holds stays as it was. The keyed and path readers of the loaded file still serve the view.
- A write may be built from that view: `upsert({ ...view.entries[id], status })` carries the view's frozen nested objects into the mutation. Before the view was frozen, a later edit inside the same mutation changed the shared rows; frozen, the mutation's tracking proxy cannot wrap them. Every value that enters a mutation (a row, a nested field, a replaced collection or meta value) has each frozen object in it replaced by a mutable copy, which loses no write because nobody could have changed a frozen object.
- `quiet.dispatchVersion` reads that shared view through `registryAdmissionEvidence` (`src/lib/selfUpdate/quiet.ts`) instead of `agentRegistry().snapshot()`. It produces the same hash.
- A complete read-only load drops parse-cache rows that it proved deleted (PR #2529). A read-only load no longer takes the metadata mutation baselines.

The writer path that #2572 changes (`mutate`, `withWriter`) is untouched. Normalized-row caching and the duplicate held-delivery normalization on a foreign-write reload were not built. The foreign-write reload still costs about 85–105 ms per changed generation, and that is the next step if a profile shows it dominating.

The same harness ran twice per side, alternating before (`d2fba8b`) and after, from fresh seeds of identical size: 32,219,217 registry bytes, 575 tasks, 150 + 194 pipelines and 881 + 827 attempts. Four cases were added to `probe-measure.ts` so that the bursts run the production handlers instead of a direct `registry.snapshot()`:

```typescript
 // Build stage additions: the production handlers that read the registry and the task store.
 dispatchVersion:async()=>{const {quietDispatchVersion}=await import("./src/lib/selfUpdate/quiet");const {productionDeps}=await import("./src/lib/selfUpdate/instance");return quietDispatchVersion(productionDeps().quiet,Date.now());},
 burstHandlersSummary:async()=>{const {quietDispatchVersion}=await import("./src/lib/selfUpdate/quiet");const {productionDeps}=await import("./src/lib/selfUpdate/instance");const quiet=productionDeps().quiet;const pending=runtimeGET(req("/api/runtime/snapshot?view=summary"));for(let i=0;i<6;i++){quietDispatchVersion(quiet,Date.now());await tasksGET(req("/api/tasks?project=viewer"));}return pending;},
 burstHandlersFull:async()=>{const {quietDispatchVersion}=await import("./src/lib/selfUpdate/quiet");const {productionDeps}=await import("./src/lib/selfUpdate/instance");const quiet=productionDeps().quiet;const pending=runtimeGET(req("/api/runtime/snapshot"));for(let i=0;i<6;i++){quietDispatchVersion(quiet,Date.now());await tasksGET(req("/api/tasks?project=viewer"));}return pending;},
 burstFilesSummary:async()=>{const pending=runtimeGET(req("/api/runtime/snapshot?view=summary"));for(let i=0;i<6;i++){const out=await buildFilesResponse(req("/api/files?project=viewer"),{listFilesWithProjectCatalog:async()=>({files:[],projectCatalog:[]})});await out.arrayBuffer();}return pending;},
```

Medians in ms (wall / Viewer CPU), runs 1 and 2. Every response was 200 with the same byte count on both sides:

| Operation | Before | After |
| --- | ---: | ---: |
| Summary under six fence + project-task GET pairs (`burstHandlersSummary`) | 634.8 / 863.9; 608.6 / 826.5 | 14.4 / 18.2; 12.6 / 13.5 |
| Full snapshot under the same load (`burstHandlersFull`) | 595.3 / 805.9; 639.8 / 835.6 | 14.7 / 14.9; 18.4 / 18.2 |
| Quiet fence `quietDispatchVersion` (`dispatchVersion`) | 97.1 / 121.1; 105.7 / 139.4 | 1.71 / 2.04; 1.56 / 1.64 |
| `GET /api/tasks?project=viewer` | 5.50 / 5.73; 5.11 / 5.15 | 0.32 / 0.33; 0.32 / 0.36 |
| `GET /api/tasks` | 7.94 / 11.17; 8.05 / 12.03 | 2.59 / 3.12; 2.24 / 2.81 |
| Files response, empty scan | 14.82 / 26.67; 15.04 / 18.53 | 10.68 / 16.84; 12.11 / 14.67 |
| Files response, 96 files | 17.83 / 27.06; 19.09 / 24.29 | 15.17 / 27.56; 13.06 / 19.54 |
| Summary under six files responses (`burstFilesSummary`) | 86.6 / 104.5; 98.1 / 118.5 | 77.0 / 122.9; 55.7 / 74.6 |
| Quiet runtime summary / full | 1.33 / 3.18; 0.92 / 2.43 | 1.40 / 2.69; 1.16 / 2.17 |
| Original burst, direct `registry.snapshot()` (`burstSummary`) | 604.2 / 798.6; 657.0 / 853.5 | 754.0 / 887.6; 626.3 / 811.3 |

Under the production handlers, summary and full snapshot are about 35–48 times faster, and Viewer CPU drops by the same order. The original identical burst does not improve, because it calls `registry.snapshot()` directly. That API stays a detached full load for callers that mutate. After this change no Viewer request path calls it: `dispatchVersion` was the only production caller. Quiet runtime routes are unchanged, as expected, because they never read the stores.

Per-request source counters (`runner.py counts`, restricted to these cases):

- Task-store clones fall from 676 to 0 on both task GETs and on the files response.
- Alias stats fall from 733 to 7 on the task GETs and from 776 to 202 on the files response.
- `dispatchVersion` falls from 17,571 JSON parses, 6,148 stringifies and 12 collection SELECTs to 0, 2 and 0.

Inside one after-state, every case compared byte for byte with the replaced computation: `projectTaskPipelineIds(loadTasks().filter(…), loadPipelines())` for `/api/tasks`, `?project=viewer` and `?status=inbox&project=project-1`, and a files response built with `loadTasks()` (tasks, pipelines, workLinks and flows). The `dispatchVersion` hash is the same before and after. Client deadlines in `src/lib/runtime/client.ts` are unchanged.

## Evidence command ledger

All times below are **2026-10-06 UTC**, except rows explicitly dated 2026-10-07; start/end brackets cover the complete local command, including sandbox host startup/cleanup where applicable. Profiles/counters are in isolated state. Read-only history retrieval preceded the first production sizing command. Its exact PR/document commands were rechecked at 23:57:40.227289–23:57:41.657392, confirming the same head and 54,896-byte investigation; the bounds below distinguish that recheck from the earlier read.

| Command / observation | UTC bounds | Result |
| --- | --- | --- |
| Aggregate SQLite queries above | 23:33:17.566761–23:33:17.619603 | count-only fixture sizing |
| Task row-kind aggregate above | 23:34:06.465650 | 575 / 100 / 1 |
| Original CLI-sampled baseline | 23:38:01.522488–23:38:21.656757 | timing values superseded by the final unsampled baseline |
| Initial long CLI CPU-profile experiment | 23:39:24–23:40:46 | Bun memory-usage measurement failed (`errno 4`); all numbers from this run discarded |
| `python3 runner.py controls` | 23:41:50.058198–23:42:05.895982 | paired interference controls |
| `python3 runner.py jsc` | 23:42:45.801063–23:42:56.413240 | 40 calls/case, 100 µs scoped Viewer CPU profiles |
| `python3 runner.py hostjsc` | 23:46:07.621–23:46:08.409 | private host CPU profiles |
| `python3 runner.py window` | 23:47:18.864723–23:47:20.066988 | populated board and 96-file response |
| `python3 runner.py windowcounts` | 23:47:42.190740–23:47:45.514930 | per-request counts for populated board/window |
| `bash scripts/gate-slot.sh bun probe-contract.ts` | 23:48:06.566–23:48:07.163 | mutation, accessor-freeze, local/foreign visibility controls |
| `python3 runner.py windowjsc` | 23:48:26.821227–23:48:28.879148 | 40 calls, window CPU profile |
| `python3 runner.py counts` | 23:48:49.307–23:48:53.682 | original-source AST/native per-request counts |
| Fresh extraction/seed and `python3 runner.py baseline` | 23:57:19.126421–23:57:47.528792 (measurement runner) | final unsampled baseline and paired controls; all 200 |
| Fresh `python3 runner.py counts` | 23:57:47.584235–23:57:56.186579 | independent source-counter confirmation |
| Fresh contract probe | 23:58:50.011649–23:58:50.982054 | same ownership/invalidation results |
| Empty-state extraction/seed and window smoke check | 2026-10-07 00:00:09.063737–00:00:17.248426 | all six embedded files extracted; first seed and both handlers succeeded; cold-window median 42.732 ms versus 17.252 ms after baseline warmup |
| PR #2529/document recheck, exact commands above | 23:57:40.227289–23:57:41.657392 | same prior investigation verified |

No production service access is needed to complete this diagnosis. Exact incident-host frequency/latency/heap and deploy causality remain explicitly unconfirmed. Validation uses whitespace/content checks, extraction into fresh isolated state, and the local privacy-publication gate with committed fingerprints from the actual merge base. No implementation suites or runtime-host promotion rehearsal were run for this documentation-only stage; they belong to the implementation/promotion checks above.

## Reproducer preserved in the declared output

Extract the six named code blocks below into a private archive checkout. The seed and contract scripts write **synthetic private state only**. Run from the existing pipeline worktree without changing its branch:

```sh
python3 - <<'PY_SETUP'
from pathlib import Path
import subprocess, tempfile, json, os, re
repo = Path.cwd()
p = Path(tempfile.mkdtemp(prefix='delegatus-hot-clones-', dir='/var/tmp'))
for name in ['source', 'home', 'tmp', 'state', 'config', 'cache', 'runtime', 'profiles']:
    (p / name).mkdir()
archive = subprocess.Popen(['git', 'archive', 'HEAD'], stdout=subprocess.PIPE)
subprocess.run(['tar', '-xf', '-', '-C', str(p / 'source')], stdin=archive.stdout, check=True)
archive.stdout.close()
assert archive.wait() == 0
common = Path(subprocess.check_output(['git', 'rev-parse', '--git-common-dir'], text=True).strip()).resolve()
(p / 'source' / 'node_modules').symlink_to(common.parent / 'node_modules', target_is_directory=True)
text = (repo / 'docs/investigations/viewer-hot-path-clones.md').read_text()
for name, language, content in re.findall(r'^### ([\w-]+\.(?:ts|py))\n\n```(typescript|python)\n(.*?)\n```', text, re.M | re.S):
    (p / name if name == 'runner.py' else p / 'source' / name).write_text(content + '\n')
env = {'PATH': os.environ['PATH'], 'LANG': 'C.UTF-8', 'HOME': str(p / 'home'),
       'TMPDIR': str(p / 'tmp'), 'LLV_STATE_DIR': str(p / 'state'),
       'XDG_CONFIG_HOME': str(p / 'config'), 'XDG_CACHE_HOME': str(p / 'cache'),
       'XDG_RUNTIME_DIR': str(p / 'runtime'), 'LLV_RUNTIME_HOST_SOCKET': str(p / 'runtime' / 'host.sock'),
       'LLV_VIEWER_CONTROL_URL': 'http://127.0.0.1:1', 'LLV_AGENT_REGISTRY_SQLITE': 'sqlite',
       'LLV_ACCOUNT_CONTROLLER_DISABLED': '1', 'LLV_REAPER_ENABLED': '0', 'LLV_STRUCTURED_HOSTS': '0',
       'DELEGATUS_TELEMETRY': '0', 'NEXT_TELEMETRY_DISABLED': '1'}
(p / 'env.json').write_text(json.dumps(env)); (p / 'env.json').chmod(0o600)
# Second seed uses the normalized synthetic constructor envelope after first-boot imports, matching the recorded baseline.
for seed_pass in range(2):
    subprocess.run(['bash', 'scripts/gate-slot.sh', 'bun', 'probe-seed.ts'], cwd=p / 'source', env=env, check=True)
for mode in ['baseline', 'controls', 'counts', 'window', 'windowcounts', 'jsc', 'windowjsc', 'hostjsc']:
    subprocess.run(['python3', 'runner.py', mode], cwd=p, check=True)
subprocess.run(['bash', 'scripts/gate-slot.sh', 'bun', 'probe-contract.ts'], cwd=p / 'source', env=env, check=True)
print('Private artifacts:', p)
PY_SETUP
```

For an after measurement, archive the reviewed implementation into another private checkout and repeat with the same dependency runtime, seed and measurement harness. Baseline/control values may vary with machine load; compare before/after in the same environment, retain raw nine-call distributions, and distinguish handler CPU from the separately profiled host. Each runner retains numeric JSON results, source counters, profiles and recorded owned PIDs in its private directory. After inspecting results, remove only that newly created directory once its recorded children have exited.

### probe-seed.ts

```typescript
import fs from "node:fs";
import path from "node:path";
import { AgentRegistry, normalizeRegistry } from "./src/lib/agent/registry";
import { SqliteAgentRegistryStore } from "./src/lib/agent/sqliteRegistryStore";
import { pipelineCorpus } from "./src/lib/pipelines/fixtures/corpus";
import { mutateTasksFile, loadTasksFile } from "./src/lib/tasks/store";
import { savePipelines, loadArchivedPipelines, archiveSettledPipelines } from "./src/lib/pipelines/store";
import { SqliteStateCollection } from "./src/lib/state/sqliteStateStore";
import { boardFor } from "./src/lib/board/store";
const root=process.env.LLV_STATE_DIR!;
const seed=new AgentRegistry(path.join(root,"seed.json"),undefined,undefined,{sqliteMode:"off"});
const conversation=seed.ensureConversation("codex","/fixture/session.jsonl","default");
const delivery=seed.holdDelivery(conversation.id,"Synthetic delivery "+"body ".repeat(200),"fixture-delivery");
seed.recordDeliveryOutcome(delivery.id,"failed","synthetic","unverified");
const receipt=seed.beginSpawn("codex","/repo",{title:"Synthetic spawn"});
const initial=seed.snapshot();seed.close();
const owner=initial.deliveryOperationOwners[delivery.command.operationId];
for(const key of ["entries","receipts","conversations","heldDeliveries","deliveryOperationOwners","lineageEdges","memberships","migrationIntents"])initial[key]={};
const sizes={conversations:2918,entries:1999,receipts:2038,heldDeliveries:3043,deliveryOperationOwners:3139,lineageEdges:2643,memberships:1698,migrationIntents:26};
for(const [collection,n] of Object.entries(sizes))for(let i=0;i<n;i++){
 const id=`conversation_fixture_${i%2918}`,sid=`fixture-session-${i%2918}`;
 const detail="synthetic detail ".repeat(64);
 let row:any,key:string;
 if(collection==="conversations"){key=id;row={...structuredClone(conversation),id,title:`Fixture ${i}`,generations:[{...conversation.generations[0],id:sid,path:`/fixture/${i}.jsonl`}],fixtureDetail:detail};}
 if(collection==="entries"){key=`codex:${sid}`;row={key:{engine:"codex",sessionId:sid},conversationId:id,artifactPath:`/fixture/${i}.jsonl`,status:"dead",accountId:"default",host:null,updatedAt:"2026-10-01T00:00:00Z",fixtureDetail:detail};}
 if(collection==="receipts"){key=`launch-${i}`;row={...structuredClone(receipt),launchId:key,state:"completed",conversationId:id,title:`Fixture ${i}`,fixtureDetail:detail};}
 if(collection==="heldDeliveries"){key=`delivery-${i}`;row={...structuredClone(delivery),id:key,conversationId:id,command:{...delivery.command,operationId:`operation-${i}`},fixtureDetail:detail};}
 if(collection==="deliveryOperationOwners"){key=`operation-${i}`;row={...structuredClone(owner),conversationId:id,command:{...owner.command,operationId:key},fixtureDetail:detail};}
 if(collection==="lineageEdges"){key=id;row={childConversationId:id,parentConversationId:"conversation_fixture_0",createdAt:"2026-10-01T00:00:00Z",kind:"spawn",role:"builder",fixtureDetail:detail};}
 if(collection==="memberships"){key=id;row=[{kind:"pipeline",containerId:`pipeline-${i%344}`,role:"builder",slot:"build",createdAt:"2026-10-01T00:00:00Z"}];}
 if(collection==="migrationIntents"){key=`migration-${i}`;row={id:key,engine:"codex",state:"completed",scope:"conversation",requestIds:[],fixtureDetail:detail};}
 initial[collection][key]=row;
}
const store=new SqliteAgentRegistryStore(path.join(root,"agent-registry.sqlite"),{initialSnapshot:initial,normalize:normalizeRegistry});
store.replace(initial);console.log(JSON.stringify({registry:Object.fromEntries(Object.keys(sizes).map(k=>[k,Object.keys(store.readOnlySnapshot().file[k]).length])),registryJsonBytes:Buffer.byteLength(JSON.stringify(store.snapshot().file))}));store.close();
mutateTasksFile(()=>({state:{tasks:Array.from({length:575},(_,i)=>({id:`task-${i}`,project:i%8===0?"viewer":`project-${i%7}`,status:"inbox",text:`Task ${i}`,details:"synthetic task details ".repeat(200),placement:"unplaced",assignments:[],createdAt:"2026-10-01T00:00:00Z",updatedAt:"2026-10-01T00:00:00Z"})),recentCreates:Array.from({length:100},(_,i)=>({clientRequestId:`request-${i}`,taskId:`task-${i}`})),migrations:{"fixture-v1":"2026-10-01T00:00:00Z"}}, result:true}));
console.log(JSON.stringify({tasks:loadTasksFile().tasks.length}));
const corpus=pipelineCorpus(344,1);let activeLeft=881,archiveLeft=827;
for(let i=0;i<344;i++){
 const pipeline=corpus[i];const left=i<150?activeLeft:archiveLeft;const remain=i<150?150-i:344-i;const count=Math.ceil(left/remain);if(i<150)activeLeft-=count;else archiveLeft-=count;
 const template=pipeline.runs[0].attempts[0];pipeline.runs=pipeline.stages.map((stage,j)=>({stageId:stage.id,attempts:Array.from({length:j===0?count:0},(_,n)=>({...template,n:n+1,effectiveRole:stage.effectiveRole}))}));
 pipeline.taskIds=[`task-${i%575}`];pipeline.state=i<150?"running":"closed";pipeline.cursor=i<150?{stageId:"build",state:"pending",input:null,activatedBy:null}:null;
}
for(const row of corpus.slice(150))row.closedAt="2026-10-01T00:00:00Z";
savePipelines(corpus); await archiveSettledPipelines(Date.parse("2026-10-07T00:00:00Z"));console.log(JSON.stringify({pipelines:150,archive:loadArchivedPipelines().length,attempts:[881,827],pipelineBytes:Buffer.byteLength(JSON.stringify(corpus))}));
boardFor("fixture-missing");
const boards=new SqliteStateCollection<any>(path.join(root,"state.sqlite"),{collection:"board",schemaVersion:1,key:r=>`p:${r.project}`,decode:v=>v,clone:structuredClone,busyMessage:"fixture board busy"});boards.replaceSync(Array.from({length:8},(_,i)=>({project:i===0?"viewer":`project-${i-1}`,state:boardFor("fixture-missing")})));console.log(JSON.stringify({boardRows:8,board:boardFor("viewer").revision}));
```

### probe-instrument.ts

```typescript
import fs from "node:fs";
import ts from "typescript";
const frames:Record<string,number>={};let active=false;
(globalThis as any).__probeFrame=(key:string)=>{if(active)frames[key]=(frames[key]??0)+1};
export function reset(){for(const key of Object.keys(frames))delete frames[key];active=true;}
export function finish(){active=false;return {...frames};}
if(process.env.PROBE_COUNTS==="1"){
 for(const [owner,key] of [[globalThis,"structuredClone"],[JSON,"parse"],[JSON,"stringify"]] as any){const original=owner[key];owner[key]=function(...args:any[]){if(active){const stack=new Error().stack?.split("\n").slice(2,5).join(" | ").replaceAll(import.meta.dir+"/","");const label=`native:${key} ${stack}`;frames[label]=(frames[label]??0)+1;}return original.apply(this,args);};}
 Bun.plugin({name:"private-frame-counts",setup(build){build.onLoad({filter:/[/]src[/].*\.ts$/},args=>{
  const source=fs.readFileSync(args.path,"utf8");const parsed=ts.createSourceFile(args.path,source,ts.ScriptTarget.Latest,true);const edits:{at:number,text:string}[]=[];
  function visit(node:any){if((ts.isFunctionLike(node))&&node.body&&ts.isBlock(node.body)){const line=parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line+1;const file=args.path.slice(import.meta.dir.length+1);let name=node.name?.getText(parsed)??node.parent?.name?.getText(parsed)??"callback";edits.push({at:node.body.getStart(parsed)+1,text:`globalThis.__probeFrame(${JSON.stringify(file+":"+line+" "+name)});`});}if(ts.isCallExpression(node)){const expression=node.expression.getText(parsed);let label=["JSON.parse","JSON.stringify","structuredClone","Object.entries","Object.fromEntries","Object.values","fs.statSync","path.join","crypto.createHash"].includes(expression)?expression:null;if(ts.isPropertyAccessExpression(node.expression)){const receiver=node.expression.expression.getText(parsed);const method=node.expression.name.text;if(["filter","map","slice"].includes(method))label="Array."+method;if(["all","get","run"].includes(method)&&ts.isCallExpression(node.expression.expression)&&ts.isPropertyAccessExpression(node.expression.expression.expression)&&node.expression.expression.expression.name.text==="query")label="SQL."+method;if(method==="exec"&&["db","this.db","this.readDb"].includes(receiver))label="SQL.exec";}if(label){const line=parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line+1;const file=args.path.slice(import.meta.dir.length+1);edits.push({at:node.getStart(parsed),text:`(globalThis.__probeFrame(${JSON.stringify(file+":"+line+" "+label)}),`},{at:node.end,text:")"});}}ts.forEachChild(node,visit);}visit(parsed);
  let text=source;for(const edit of edits.sort((a,b)=>b.at-a.at))text=text.slice(0,edit.at)+edit.text+text.slice(edit.at);return {contents:text,loader:"ts"};
 });}});
}
```

### probe-host.ts

```typescript
import fs from "node:fs";
import path from "node:path";
import { reset,finish } from "./probe-instrument";
const { RuntimeJournal }=await import("./src/runtime-host/journal");
const { RuntimeHost }=await import("./src/runtime-host/host");
const { serveRuntimeHost }=await import("./src/runtime-host/socket");
const root=process.env.LLV_STATE_DIR!;
const journal=new RuntimeJournal(path.join(root,"probe-events.sqlite"),{structuredHosts:false});
const template=journal.append({scope:{type:"session",id:"fixture-0"},kind:"turn-started",payload:{turnId:"turn-0"}});
const db=(journal as any).db;
const session=JSON.parse(db.query("SELECT state_json FROM entities WHERE kind='session'").get().state_json);
db.exec("BEGIN");db.exec("DELETE FROM entities");
const put=db.query("INSERT INTO entities(kind,id,revision,state_json,checkpoint_seq,updated_at) VALUES(?,?,?,?,?,?)");
for(let i=0;i<2918;i++){const id=`fixture-${i}`;put.run("session",id,1,JSON.stringify({...session,conversationId:id,host:i<32?"alive":"dead",turn:"idle",voiceDeliveries:[{id:`voice-${i}`,responses:[{text:"synthetic voice body ".repeat(200)}]}]}),i+1,Date.now());}
for(let i=0;i<575;i++)put.run("task",`task-${i}`,1,JSON.stringify({id:`task-${i}`,status:"inbox"}),1,Date.now());
db.exec("COMMIT");
const host=new RuntimeHost(journal,undefined,undefined,false);
let n=0;const server=serveRuntimeHost(process.env.LLV_RUNTIME_HOST_SOCKET!,{async handle(request:any,options:any){
 reset();const began=performance.now();const startUs=(performance.timeOrigin+began)*1000;const cpu=process.cpuUsage();let result:any;if(process.env.PROBE_HOST_JSC==="1"&&request.method==="snapshot"){const {profile}=await import("bun:jsc");const prof=await profile(async()=>{result=await host.handle(request,options)},100);fs.appendFileSync(path.join(root,"host-jsc.jsonl"),JSON.stringify({scope:request.params?.voiceBodiesFor===undefined?"full":"summary",prof})+"\n");}else result=await host.handle(request,options);const usage=process.cpuUsage(cpu);const counts=finish();
 fs.appendFileSync(path.join(root,"host-service.jsonl"),JSON.stringify({n:++n,startUs,endUs:(performance.timeOrigin+performance.now())*1000,method:request.method,scope:request.params?.voiceBodiesFor===undefined?"full":"summary",ms:performance.now()-began,cpuMs:(usage.user+usage.system)/1000,counts})+"\n");return result;
}});
await new Promise<void>(resolve=>server.once("listening",resolve));console.log("READY");
process.on("SIGTERM",()=>{server.close(()=>{journal.close();process.exit(0);});});
```

### probe-measure.ts

```typescript
import fs from "node:fs";
import path from "node:path";
import { reset,finish } from "./probe-instrument";
const { NextRequest }=await import("next/server");
const { agentRegistry }=await import("./src/lib/agent/registry");
const tasks=await import("./src/lib/tasks/store");
const pipelines=await import("./src/lib/pipelines/store");
const {GET:runtimeGET}=await import("./src/app/api/runtime/snapshot/route");
const {GET:tasksGET}=await import("./src/app/api/tasks/route");
const {GET:boardGET}=await import("./src/app/api/board/route");
const {buildFilesResponse}=await import("./src/app/api/files/response");
const {UnixRuntimeHostClient}=await import("./src/lib/runtime/client");
const {Database}=await import("bun:sqlite");
const registry=agentRegistry();
const writer=new Database(path.join(process.env.LLV_STATE_DIR!,"agent-registry.sqlite"));
const update=()=>{writer.exec("BEGIN");writer.query("UPDATE registry_rows SET value_json=json_set(value_json,'$.updatedAt',?) WHERE collection='entries' AND row_key='codex:fixture-session-0'").run(new Date().toISOString());writer.exec("UPDATE registry_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'");writer.exec("COMMIT");};
const client=new UnixRuntimeHostClient(process.env.LLV_RUNTIME_HOST_SOCKET!);
const req=(url:string)=>new NextRequest(`http://127.0.0.1${url}`,{headers:{host:"127.0.0.1",origin:"http://127.0.0.1"}});
const scanFiles=()=>Array.from({length:96},(_,i)=>({path:`/fixture/${i}.jsonl`,name:`${i}.jsonl`,parent:null,project:"viewer",root:"codex-sessions",engine:"codex",fmt:"codex",title:`Fixture ${i}`,activity:"idle",mtime:0,size:65536,pid:null,proc:null,conversationId:null}));
const cases:Record<string,()=>any>={
 registrySnapshot:()=>registry.snapshot(),registryReadonly:()=>registry.readOnlySnapshot(),
 registryForeignWrite:()=>registry.readOnlySnapshot(),tasksLoad:()=>tasks.loadTasks(),tasksList:()=>tasks.loadTasksForList(),
 pipelinesLoad:()=>pipelines.loadPipelines(),pipelinesList:()=>pipelines.loadPipelinesForList(),
 tasksAll:()=>tasksGET(req("/api/tasks")),tasksProject:()=>tasksGET(req("/api/tasks?project=viewer")),
 board:()=>boardGET(req("/api/board?project=viewer")),
 filesWindow:()=>buildFilesResponse(req("/api/files?project=viewer&view=summary"),{listFilesWithProjectCatalog:async()=>({files:scanFiles() as any,projectCatalog:[]})}),
 filesBoard:()=>buildFilesResponse(req("/api/files?project=viewer"),{listFilesWithProjectCatalog:async()=>({files:[],projectCatalog:[]})}),
 runtimeSummary:()=>runtimeGET(req("/api/runtime/snapshot?view=summary")),runtimeFull:()=>runtimeGET(req("/api/runtime/snapshot")),
 runtimeChanged:async()=>{await client.append({scope:{type:"task",id:"probe-task"},kind:"task.updated",payload:{tick:Date.now()}});return runtimeGET(req("/api/runtime/snapshot?view=summary"));},
 burstSummary:async()=>{const pending=runtimeGET(req("/api/runtime/snapshot?view=summary"));for(let i=0;i<6;i++){registry.snapshot();await tasksGET(req("/api/tasks?project=viewer"));}return pending;},
 burstFull:async()=>{const pending=runtimeGET(req("/api/runtime/snapshot"));for(let i=0;i<6;i++){registry.snapshot();await tasksGET(req("/api/tasks?project=viewer"));}return pending;},
 burstReadonlySummary:async()=>{const pending=runtimeGET(req("/api/runtime/snapshot?view=summary"));for(let i=0;i<6;i++){registry.readOnlySnapshot();const selected=tasks.loadTasksForList().filter(t=>t.project==="viewer");const {projectTaskPipelineIds}=await import("./src/lib/pipelines/taskBinding");Response.json({tasks:projectTaskPipelineIds(selected,pipelines.loadPipelinesForList())});}return pending;},
 burstReadonlyFull:async()=>{const pending=runtimeGET(req("/api/runtime/snapshot"));for(let i=0;i<6;i++){registry.readOnlySnapshot();const selected=tasks.loadTasksForList().filter(t=>t.project==="viewer");const {projectTaskPipelineIds}=await import("./src/lib/pipelines/taskBinding");Response.json({tasks:projectTaskPipelineIds(selected,pipelines.loadPipelinesForList())});}return pending;},

};
const selected=process.env.PROBE_CASE?process.env.PROBE_CASE.split(","):Object.keys(cases);
const n=Number(process.env.PROBE_N??9);const results:any[]=[];
for(const name of selected){const call=cases[name];let size=0,status:number|undefined;
 const execute=async()=>{if(name==="registryForeignWrite")update();const cpu=process.cpuUsage();const start=performance.now();const out=await call();const elapsed=performance.now()-start;const usage=process.cpuUsage(cpu);if(out instanceof Response){status=out.status;const bytes=await out.arrayBuffer();size=bytes.byteLength;if(status!==200)throw new Error(`${name} status=${status} ${new TextDecoder().decode(bytes).slice(0,200)}`);}return {elapsed,cpuMs:(usage.user+usage.system)/1000};};
 if(process.env.PROBE_JSC==="1"){
  for(let i=0;i<2;i++){if(name==="registryForeignWrite")update();const out=await call();if(out instanceof Response)await out.arrayBuffer();}
  const {profile}=await import("bun:jsc");const prof=await profile(async()=>{for(let i=0;i<n;i++){if(name==="registryForeignWrite")update();const out=await call();if(out instanceof Response){if(out.status!==200)throw new Error(`${name} status ${out.status}`);await out.arrayBuffer();}}},100);
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!,`jsc-${name}.json`),JSON.stringify(prof));console.log(JSON.stringify({name,functions:prof.functions}));continue;
 }
 await execute();await execute();const windowStartUs=(performance.timeOrigin+performance.now())*1000;const wall:number[]=[],cpu:number[]=[];let counts={};
 for(let i=0;i<n;i++){reset();const value=await execute();counts=finish();wall.push(value.elapsed);cpu.push(value.cpuMs);}
 const percentile=(values:number[],q:number)=>[...values].sort((a,b)=>a-b)[Math.ceil(q*values.length)-1];
 const windowEndUs=(performance.timeOrigin+performance.now())*1000;const row={name,n,windowStartUs,windowEndUs,medianMs:percentile(wall,.5),p95Ms:percentile(wall,.95),cpuMedianMs:percentile(cpu,.5),responseBytes:size,status,counts,wall,cpu};results.push(row);console.log(JSON.stringify(row));
}
fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!,`result-${process.env.PROBE_LABEL??"baseline"}.json`),JSON.stringify({utc:new Date().toISOString(),results,rss:0}));writer.close();registry.close();
```

### probe-contract.ts

```typescript
import { agentRegistry } from "./src/lib/agent/registry";
import { loadTasks,loadTasksForList,mutateTasks } from "./src/lib/tasks/store";
import { loadPipelinesForList } from "./src/lib/pipelines/store";
import { projectTaskPipelineIds } from "./src/lib/pipelines/taskBinding";
import { Database } from "bun:sqlite";
const registry=agentRegistry();const id="conversation_fixture_0";const cached=registry.readOnlySnapshot();const old=cached.conversations[id].title;
cached.conversations[id].title="mutated cached title";console.log(JSON.stringify({registryCacheMutable:registry.readOnlySnapshot().conversations[id].title==="mutated cached title",durableUnchanged:registry.snapshot().conversations[id].title===old}));cached.conversations[id].title=old;
const tasks=loadTasksForList();const oldText=tasks[0].text;tasks[0].text="mutated cached task";console.log(JSON.stringify({taskCacheMutable:loadTasksForList()[0].text==="mutated cached task",durableUnchanged:loadTasks()[0].text===oldText}));tasks[0].text=oldText;
function freeze(value:any,seen=new WeakSet<object>()){if(value&&typeof value==="object"&&!seen.has(value)){seen.add(value);for(const item of Object.values(value))freeze(item,seen);Object.freeze(value);}return value;}
freeze(cached);freeze(tasks);freeze(loadPipelinesForList());
const oldReceipts=cached.receipts;cached.receipts={};console.log(JSON.stringify({frozenAccessorStillWritable:Object.keys(registry.readOnlySnapshot().receipts).length===0}));cached.receipts=oldReceipts;
let caught=0;try{cached.conversations[id].generations.push({} as never);}catch{caught++;}try{tasks[0].assignments.push({} as never);}catch{caught++;}
console.log(JSON.stringify({deepFreezeRejectsNested:caught===2,readonlyProjectionWorks:projectTaskPipelineIds(tasks.filter(t=>t.project==="viewer"),loadPipelinesForList()).length===72}));
const db=new Database(`${process.env.LLV_STATE_DIR}/agent-registry.sqlite`);db.exec("BEGIN");db.query("UPDATE registry_rows SET value_json=json_set(value_json,'$.title',?) WHERE collection='conversations' AND row_key=?").run("visible foreign write",id);db.exec("UPDATE registry_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'");db.exec("COMMIT");console.log(JSON.stringify({registryForeignWriteVisible:registry.readOnlySnapshot().conversations[id].title==="visible foreign write",oldRegistryViewStable:cached.conversations[id].title===old}));db.close();
mutateTasks(current=>({tasks:current.map((task,i)=>i===0?{...task,text:"visible local write"}:task),result:true}));
console.log(JSON.stringify({taskLocalWriteVisible:loadTasksForList()[0].text==="visible local write",oldTaskViewStable:tasks[0].text===oldText}));
registry.upsert({...registry.readOnlySnapshot().entries["codex:fixture-session-0"],artifactPath:"/fixture/visible-local-write.jsonl"});
console.log(JSON.stringify({registryLocalWriteVisible:registry.readOnlySnapshot().entries["codex:fixture-session-0"].artifactPath==="/fixture/visible-local-write.jsonl",oldRegistryEntryStable:cached.entries["codex:fixture-session-0"].artifactPath==="/fixture/0.jsonl"}));registry.close();
```

### runner.py

```python
from pathlib import Path
import subprocess,json,time,datetime,signal,sys
p=Path(__file__).parent;env=json.loads((p/'env.json').read_text());mode=sys.argv[1];env.update(PROBE_LABEL=mode,PROBE_N='1' if mode=='counts' else '9')
if mode=='window':env.update(PROBE_CASE='board,filesWindow',PROBE_N='9')
if mode=='windowcounts':env.update(PROBE_COUNTS='1',PROBE_CASE='board,filesWindow',PROBE_N='1')
if mode=='windowjsc':env.update(PROBE_JSC='1',PROBE_CASE='filesWindow',PROBE_N='40')
if mode=='hostjsc':env.update(PROBE_HOST_JSC='1',PROBE_CASE='runtimeSummary,runtimeFull,runtimeChanged',PROBE_N='9')
if mode=='controls':env.update(PROBE_CASE='burstSummary,burstFull,burstReadonlySummary,burstReadonlyFull')
if mode=='jsc':env.update(PROBE_JSC='1',PROBE_CASE='registrySnapshot,registryForeignWrite,tasksProject,filesBoard,runtimeSummary,runtimeFull,runtimeChanged',PROBE_N='40')
if mode=='counts':env.update(PROBE_COUNTS='1',PROBE_CASE='registrySnapshot,registryReadonly,registryForeignWrite,tasksLoad,tasksList,pipelinesLoad,pipelinesList,tasksAll,tasksProject,board,filesBoard,runtimeSummary,runtimeFull,runtimeChanged')
print('UTC_START',datetime.datetime.now(datetime.timezone.utc).isoformat(),flush=True)
with (p/('host-'+mode+'.log')).open('w') as log:
 hostcmd=['bun']+([] if mode != 'cli-profile' else ['--cpu-prof','--cpu-prof-dir='+str(p/'profiles'),'--cpu-prof-name=host-'+mode+'.cpuprofile','--cpu-prof-interval=100'])+['probe-host.ts']
 host=subprocess.Popen(hostcmd,cwd=p/'source',env=env,stdout=log,stderr=log);(p/('host-'+mode+'.pid')).write_text(str(host.pid))
 try:
  for _ in range(600):
   if 'READY' in (p/('host-'+mode+'.log')).read_text():break
   if host.poll() is not None:raise Exception((p/('host-'+mode+'.log')).read_text())
   time.sleep(.1)
  else:raise Exception('private host startup timed out')
  cmd=['bash','scripts/gate-slot.sh','bun']+([] if mode != 'cli-profile' else ['--cpu-prof','--cpu-prof-dir='+str(p/'profiles'),'--cpu-prof-name=viewer-'+mode+'.cpuprofile','--cpu-prof-interval=100'])+['probe-measure.ts']
  r=subprocess.run(cmd,cwd=p/'source',env=env,capture_output=True,text=True,timeout=240);(p/(mode+'.log')).write_text(r.stdout+r.stderr)
  for line in r.stdout.splitlines():
   try:
    row=json.loads(line)
    for key in ['counts','wall','cpu','windowStartUs','windowEndUs']:row.pop(key,None)
    print(json.dumps(row),flush=True)
   except:print(line)
  print(r.stderr[-2200:]);print('exit',r.returncode)
 finally:
  if host.poll() is None:host.send_signal(signal.SIGTERM)
  host.wait(timeout=15)
print('UTC_END',datetime.datetime.now(datetime.timezone.utc).isoformat())
if r.returncode:raise SystemExit(r.returncode)
```

### Numeric unsampled baseline

Nine-call wall/CPU arrays (milliseconds), from the final unsampled run above. These values contain only synthetic measurements; CPU profiles and instrumented timings are excluded.

```json
[{"name":"registrySnapshot","n":9,"medianMs":100.14015000000006,"p95Ms":165.7997009999999,"cpuMedianMs":172.22,"responseBytes":0,"wall":[101.13451899999995,165.7997009999999,112.88405599999999,100.14015000000006,109.93955800000003,91.02185400000008,99.89497100000017,91.35000200000013,87.95368899999994],"cpu":[184.645,252.387,188.337,155.686,224.192,142.321,172.22,138.506,122.995]},{"name":"registryReadonly","n":9,"medianMs":0.019741000000067288,"p95Ms":0.028868999999986045,"cpuMedianMs":0.021,"responseBytes":0,"wall":[0.014993000000004031,0.01756599999998798,0.028868999999986045,0.025797000000011394,0.019741000000067288,0.018389999999953943,0.019551999999976033,0.020975999999791384,0.026540999999951964],"cpu":[0.016,0.02,0.031,0.028,0.021,0.077,0.021,0.021,0.026]},{"name":"registryForeignWrite","n":9,"medianMs":103.97586999999976,"p95Ms":124.92894399999977,"cpuMedianMs":122.323,"responseBytes":0,"wall":[107.58268999999996,70.3118730000001,79.71034600000007,103.97586999999976,84.76490100000001,80.71340999999984,110.61438099999987,111.24919399999999,124.92894399999977],"cpu":[140.451,73.356,108.643,175.223,106.496,81.046,134.098,176.101,122.323]},{"name":"tasksLoad","n":9,"medianMs":4.282891000000291,"p95Ms":5.298389000000043,"cpuMedianMs":4.573,"responseBytes":0,"wall":[4.378077999999732,4.282891000000291,3.9303140000001804,4.028601999999864,3.9557669999999234,5.298389000000043,5.034683999999743,4.368927999999869,3.9266679999996086],"cpu":[6.717,6.824,4.573,4.034,4.02,5.821,5.644,4.427,3.934]},{"name":"tasksList","n":9,"medianMs":0.012570000000323489,"p95Ms":0.024611999999706313,"cpuMedianMs":0.013,"responseBytes":0,"wall":[0.024611999999706313,0.017370000000028085,0.012507999999797903,0.012570000000323489,0.012904000000162341,0.01241600000003018,0.013257999999950698,0.011750000000120053,0.01215200000024197],"cpu":[0.026,0.018,0.014,0.013,0.013,0.013,0.014,0.013,0.013]},{"name":"pipelinesLoad","n":9,"medianMs":0.534099999999853,"p95Ms":0.5861500000000888,"cpuMedianMs":0.546,"responseBytes":0,"wall":[0.5349240000000464,0.5291849999998703,0.5278469999998379,0.5434770000001663,0.5638290000001689,0.5861500000000888,0.534099999999853,0.49201700000003257,0.5163640000000669],"cpu":[0.561,0.532,0.53,0.546,0.567,1.65,0.537,0.494,1.054]},{"name":"pipelinesList","n":9,"medianMs":0.004175000000032014,"p95Ms":0.004754999999931897,"cpuMedianMs":0.005,"responseBytes":0,"wall":[0.004376000000320346,0.004175000000032014,0.004067000000304688,0.003967999999986205,0.004754999999931897,0.004058999999870139,0.004527999999936583,0.003867999999783933,0.0047479999998358835],"cpu":[0.005,0.005,0.005,0.004,0.006,0.004,0.005,0.005,0.005]},{"name":"tasksAll","n":9,"medianMs":7.8906779999997525,"p95Ms":9.710190000000239,"cpuMedianMs":10.253,"responseBytes":2803050,"wall":[9.710190000000239,8.49648900000011,7.246278999999959,8.26489300000003,7.133445999999822,6.8739029999997,7.8906779999997525,7.642718999999943,8.953330000000278],"cpu":[13.324,11.9,7.528,9.131,7.182,7.529,11.719,10.253,34.506]},{"name":"tasksProject","n":9,"medianMs":6.210239000000001,"p95Ms":9.478453000000172,"cpuMedianMs":6.186,"responseBytes":350811,"wall":[9.242229999999836,9.478453000000172,5.496724999999969,5.0864150000002155,4.663096999999652,6.210239000000001,9.134041999999681,8.868778999999904,5.611484000000019],"cpu":[9.217,9.485,5.487,5.219,4.724,6.186,9.143,8.856,5.573]},{"name":"board","n":9,"medianMs":0.04663799999980256,"p95Ms":0.07188799999994444,"cpuMedianMs":0.05,"responseBytes":365,"wall":[0.07188799999994444,0.04663799999980256,0.04521500000009837,0.05306699999982811,0.042734999999993306,0.04927300000008472,0.047133000000030734,0.0386289999996734,0.038246000000071945],"cpu":[0.073,0.049,0.046,0.086,0.123,0.05,0.049,0.04,0.066]},{"name":"filesWindow","n":9,"medianMs":17.252154000000246,"p95Ms":22.275268000000324,"cpuMedianMs":23.385,"responseBytes":2871658,"wall":[17.47673500000019,22.275268000000324,14.995002999999997,20.396614999999656,15.757407000000057,16.84737300000006,18.05691200000001,17.252154000000246,15.53115200000002],"cpu":[39.096,36.486,22.963,41.375,23.385,18.457,23.446,18.354,16.679]},{"name":"filesBoard","n":9,"medianMs":11.815266999999949,"p95Ms":14.03316599999971,"cpuMedianMs":17.423,"responseBytes":2792280,"wall":[14.03316599999971,11.456323999999768,11.711493000000246,10.859623000000283,10.293717000000015,12.096035000000029,11.815266999999949,12.75079599999981,12.761418000000049],"cpu":[18.402,17.423,13.445,12.103,11.635,23.277,29.004,27.87,17.052]},{"name":"runtimeSummary","n":9,"medianMs":1.0282430000002023,"p95Ms":2.849557999999888,"cpuMedianMs":1.047,"responseBytes":171533,"wall":[2.849557999999888,1.260240000000067,1.040770000000066,1.0411549999998897,0.9616250000003674,1.0282430000002023,0.9774379999998928,0.880181999999877,0.8524680000000444],"cpu":[2.718,1.235,1.003,1.15,1.787,0.84,0.932,1.047,0.865]},{"name":"runtimeFull","n":9,"medianMs":2.3998380000002726,"p95Ms":5.489262000000053,"cpuMedianMs":2.265,"responseBytes":838093,"wall":[1.7818649999999252,1.8785980000002382,2.383074000000306,2.608408000000054,3.662069999999858,2.3998380000002726,2.93672800000013,2.2798499999998967,5.489262000000053],"cpu":[1.398,2.265,2.129,2.911,2.185,2.503,2.873,2.016,6.716]},{"name":"runtimeChanged","n":9,"medianMs":7.299078999999892,"p95Ms":9.016276000000289,"cpuMedianMs":1.917,"responseBytes":171534,"wall":[5.678350000000137,5.998586000000159,7.299078999999892,9.016276000000289,7.537600000000111,5.242145000000164,7.9051369999997405,8.663399000000027,5.559571000000233],"cpu":[1.932,1.675,9.158,13.08,2.734,1.533,1.917,1.892,1.546]},{"name":"burstSummary","n":9,"medianMs":1094.7920720000002,"p95Ms":1245.155906,"cpuMedianMs":1340.256,"responseBytes":171534,"wall":[815.3182369999995,791.7675880000006,1245.155906,1061.9579990000002,1125.2588050000013,1164.8640770000002,928.518446,1094.7920720000002,1109.8258880000012],"cpu":[1029.388,1063.84,1667.317,1340.256,1331.203,1456.1,1110.325,1348.4,1389.497]},{"name":"burstFull","n":9,"medianMs":1100.9556759999978,"p95Ms":1756.2954309999986,"cpuMedianMs":1460.969,"responseBytes":838094,"wall":[947.9806420000023,1100.9556759999978,1203.1680400000005,949.1975490000004,1032.144903999997,869.1604090000001,1276.2326969999995,1756.2954309999986,1352.0800670000026],"cpu":[1156.613,1460.969,1472.035,1226.267,1355.2,1122.454,1490.856,1968.98,1612.529]},{"name":"burstReadonlySummary","n":9,"medianMs":7.664574000002176,"p95Ms":22.00674799999979,"cpuMedianMs":7.533,"responseBytes":171534,"wall":[7.074542999998812,8.1355309999999,6.687681999999768,7.664574000002176,18.555098000000726,7.277723000002879,6.389732999999978,8.56087000000116,22.00674799999979],"cpu":[7.533,7.715,6.362,6.853,8.076,6.869,5.905,8.24,16.21]},{"name":"burstReadonlyFull","n":9,"medianMs":10.855548999999883,"p95Ms":22.1116320000001,"cpuMedianMs":11.547,"responseBytes":838094,"wall":[10.855548999999883,15.785678000000189,12.893965999999637,9.828997000000527,13.467837000000145,22.1116320000001,10.571114999998827,10.052784999999858,7.599947999999131],"cpu":[9.502,15.489,11.803,11.5,13.093,21.272,11.547,8.554,8.164]}]
```

Final documentation validation: `git diff --check`, embedded harness extraction and source-line/content checks passed. The local gate `bash scripts/gate-slot.sh bun scripts/privacy-publication-gate.ts --require-known-values --check-commits --base d2fba8b76bca3789d31ac46ecb82d9cbd0897f62` passed with committed fingerprints under private state, UTC 2026-10-07T00:02:25.186188+00:00–2026-10-07T00:02:27.960188+00:00. Only this declared output is present in the worktree diff.
