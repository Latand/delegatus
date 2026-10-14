# Viewer stall attribution

Audit: 2026-10-14 UTC (2026-10-15 in the operator's timezone). Read-only production investigation; no implementation, commit, restart, deployment or live profiling.

**The 17.840-second gap remains causally unattributed.** The available journal names overlapping asynchronous work, but contains no stack, CPU/scheduling trace, or GC boundary for that interval. Private replays establish costly full-history evidence preparation and synchronous cold registry construction. They do not reproduce the historical 17.840-second gap or 15-second pipelines deadline. The instrumentation contract below is the required next step for those gaps.

The release condition still fails on **61799bbcc819cde4e4e312d96c418182fd0cb74e**: the newer complete 30-minute window has 107 gaps of at least one second, seven pipelines deadlines and a maximum gap of 9.631 seconds. This document completes the investigation/design contract; the parent task's fixes and post-deploy quiet window remain outstanding.

## Sources, identity and reproducibility boundaries

All timestamps in this document are UTC on **2026-10-14**. Source locations refer to main at **92406b7bde4f6354f8f156483a281b6c3f97ee06**, unless explicitly stated otherwise. `git ls-remote origin refs/heads/main` confirmed that revision during this audit. The local branch named `main` is stale, so it was not used as the source authority. `git archive` exported the two compared revisions into private scratch directories; the assigned branch was unchanged.

Production is this machine's checkout installation under `delegatus.service`. `deployment_status({compact:true,limit:5})` returned the successful deployment of `61799bbc`, finished **21:54:19.608**. At **23:24:32** and **23:28:35**, reads of the stored launcher identity and its recorded children's `/proc/PID/{cwd,stat}` still identified that release. The runtime start identity matched its stored receipt; the Viewer identity is checked again in the closing observation. The systemd journal PID is the forwarding launcher, so it does not identify the child executing a callback. No production HTTP request was made.

Git's first-parent history corrects a detail in the brief: **#2876 and #2882 are already ancestors of serving `61799bbc`**, as is #2877. Main adds #2892 and #2900; #2899 is absent from the audited main revision. Do not credit the next deployment with an undeployed #2882 improvement. At **23:33:49**, remote main advanced to **8a61dabe9b183b85ea05913878e562ff3f75eac1** (#2898). A read-only fetch into a separate scratch object database and `git diff 92406b7b 8a61dabe -- bin/cli.mjs src/lib/agent/spawnPolicy.ts src/lib/codexHeadlessConfig.ts src/lib/mcp/bindings.ts` confirmed control-endpoint inheritance and spawn-receipt recovery changes. All profiled store, loop-monitor, controller, runtime-journal and files code remains byte-identical; the cited locations still apply. Those fenced files were inspected only. #2899 is also absent from this closing main revision.

These facts come from `git log -30 --first-parent --oneline` and `git diff 61799bbc 92406b7b -- src/lib/pipelines src/lib/viewerLoopMonitor.ts src/app/api/files src/lib/agent/sqliteRegistryStore.ts`; the latter changes only the registry store among those paths.

| ID | Exact read / execution and time bounds |
| --- | --- |
| J1 | `journalctl --user -u delegatus.service --utc --since '2026-10-14 16:50:30 UTC' --until '2026-10-14 17:20:30 UTC' --output=json --no-pager` |
| J2 | Same command with `--since '2026-10-14 21:56:00 UTC' --until '2026-10-14 22:26:00 UTC'` |
| J3 | Same command with `--since '2026-10-14 22:54:00 UTC' --until '2026-10-14 23:24:00 UTC'` |
| J1–J3 recount | Executed together, completed **23:24:32.351**; JSON retained privately. Later analysis reads these same captured files. Parse each `MESSAGE` after `[viewer loop-gap] `, select `gapMs >= 1000`, and count each diagnostic once. Count pipeline deadline messages independently. |
| C1 | `conversation_messages({transcriptPath:AUDITOR_TRANSCRIPT,roles:["assistant"],limit:1,maxChars:15000})`: recovered the requested auditor's full identity from transcript search and read its final message, timestamp **22:27:43.809**. The abbreviated conversation ID did not resolve. |
| C2 | `conversation_messages` at the identity auditor's transcript: final message **22:53:34.270**. Its separate Docker installation remains outside scope. Read the supplied handoff as contextual evidence only. The abbreviated task ID did not resolve. |
| C3 | Prior component audit, final message **22:47:42.432**, and its private document `docs/perf/stalls-after-2877.md`; reopened raw results and CPU profiles during **23:24–23:29**. Its historical profiles are explicitly labelled below. |
| B1 | Reused C3's unchanged read-only online backups made **22:31:59.368–22:32:01.510**. Copied into this audit's private baseline at **23:25** and verified SHA-256 equality. No database was copied by reading a live SQLite file without its WAL. |
| R1 | Serving-source mixed replay: **23:26:15.469–23:26:32.938**. Main mixed replay: **23:27:55.238–23:28:11.573**. Each has three repeated workload rounds per mode in one process per source; processes run sequentially through the prescribed gate. An earlier exploratory main run at **23:25:44.487–23:26:02.155** is retained as partial terminal evidence and excluded from the comparison table. |
| R2 | Separate CPU-profiled main mixed replay, **23:28:56.389–23:29:12.750**; results and resource counters are described below. Profiled timings are excluded from R1. |

The prior-answer search used project-scoped `search_transcripts` queries `17.840 pipelines` and `21:56 22:26`, then unscoped `controller-mutation profile` and `76 gaps 61799`. Search ignored `61799` in the last query; it supplies no SHA proof. Opened the relevant hits through `conversation_messages` at their returned transcript paths. Memory searches `Viewer stalls pipelines` scoped to the project, then unscoped `lease event loop performance` and `sqlite synchronous`, returned no hits. Imported and native memory files supplied no incident-specific causal stack. The earlier controller audit predates #2877; its removed whole-history paths were checked against current code and are not assigned to these gaps.

## Production observations

| Serving SHA / window | Journal records | Gaps >=1 s | Maximum ms | Empty operation lists | Gaps including controller mutation | Pipelines deadlines | RPC timeout lines | State lease-hold lines |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `3050c102`, 16:50:30–17:20:30 (J1) | 1,614 | 110 | 14,351 | 11 | 56 | 4 | 0 | 0 |
| `61799bbc`, 21:56–22:26 (J2) | 1,900 | 76 | 17,840 | 5 | 21 | 4 | 3 | 0 |
| `61799bbc`, 22:54–23:24 (J3) | 610 | 107 | 9,631 | 11 | 44 | 7 | 0 | 0 |

These are observation windows with different concurrent activity, not an identical-load before/after experiment. J3 ends before this lane's private replays. Other machine workloads were not controlled. J2 has two `SQLITE_BUSY` occurrences, independently grouped by C1 into the account-migration incidents at **21:59:52.315962** and **21:59:54.061827**. J3 has one occurrence at **22:55:09.328412**, whose stack reaches registry `beginMutationWrite`; that occurrence is not assigned to a migration without a caller trace. #2900 is still absent from the serving SHA.

J2 deadlines occur at **21:56:45.242639, 21:57:16.095700, 22:07:36.356409, 22:07:53.540696**. J3 adds **22:54:29.591818, 22:55:05.866480, 22:56:32.563623, 23:09:41.704568, 23:19:51.307798, 23:21:56.643002, 23:22:55.218917**.

Zero emitted lease-hold warnings does not prove zero contention. `src/lib/state/sqliteStateStore.ts:2208` starts the durable-hold clock immediately after successful lease COMMIT; `:54` finishes it on release. Only pipeline holds above one second emit that warning. J3 separately contains synchronous registry-lock waits up to **1,147.3 ms** and revision-retry intervals up to **1,142.6 ms**. These are distinct measurements.

## A. Empty-operation gap and coincident RPC/files timeouts

**Evidence.** J2 logs `{gapMs:17840,operations:[]}` at **22:05:15.874269**. Caller-side RPC logs follow at **22:05:16.013473** (`append`, 17,988 ms), **22:05:16.023005** (`wait`, 17,997 ms), and **22:05:16.023549** (`wait`, 17,998 ms). C1's external `curl --max-time 5 -sS -o /dev/null -w 'http=%{http_code} total_seconds=%{time_total}\n' http://127.0.0.1:8898/api/files`, executed **22:05:00.494532–22:05:05.501892**, received no bytes and expired after 5.003038 seconds. This lane did not repeat that request: the ordinary GET has write side effects described in section D.

Subtracting the reported gap and nominal 10 ms poll interval gives an approximate previous timer opportunity at **22:04:58.024**. RPC elapsed-time subtraction places their starts near **22:04:58.025–58.026**. These are inferred boundaries; journald delivery and timeout logging are not stack samples.

**Path.** `src/lib/viewerLoopMonitor.ts:19` measures timer lateness. `:26` records whole operation lifetimes, `:34` retains only sixteen labels, `:49` limits active tracking to 128 entries, and completed tracking also caps at 128. There are no overflow counters, generic synchronous-call spans, main-thread CPU deltas, native samples or GC events. Empty labels therefore leave unwrapped work, GC/native runtime execution, synchronous blocking and scheduling delay unresolved.

`src/lib/runtime/client.ts:323` dispatches an RPC and `:336` schedules its timeout on the caller's own loop. Delayed execution of that timer cannot locate the host's stall. Snapshot transfer at `:405` measures first byte to complete frame, including delayed callbacks; parse at `:407` is measured separately. Host snapshot collection runs in **the runtime host**, through `src/runtime-host/host.ts:146` and `journal.ts:1416`.

J2 contains 122 logged host collection samples, maximum **480.2 ms**, and 192 asynchronous Viewer snapshot-transfer samples, maximum **11,540 ms**. No snapshot parse/serialization sample reaches the logger's 250 ms threshold (`src/lib/blockingWaits.ts:77`). The nearby host collection at **22:05:17.276** takes 250.3 ms; transfer at **22:05:23.181** takes 426.2 ms. Neither spans the empty gap. J3's transfer maximum is **14,085.4 ms**, while host collection tops out at 452 ms. Transfer latency alone cannot attribute the delay to SQL, network, or Viewer CPU.

The B1 runtime-event query below, independently rerun at **23:32**, returns one `limits` event at **22:04:58.026**, then silence inside the interval:

```sql
SELECT kind, count(*) FROM events
WHERE recorded_at >= '2026-10-14T22:04:58.024Z'
  AND recorded_at < '2026-10-14T22:05:15.874Z'
GROUP BY kind;
```

Committed-event silence supplies no RPC arrival timing. No available additional read can recover the missing historical stack or arrival schedule.

**Proposed fix and expected gain.** Implement the bounded attribution records in section F first. Then replace the measured synchronous offender with indexed reads, bounded slices or an owned reader worker. Keep authorization/freshness checks and request deadlines. Instrumentation itself has **no claimed latency gain**; there is no evidence-backed numerical prediction for removing the 17.840 seconds. Cold registry work in section E is a proven candidate component, not this event's established cause.

**Replay.** Use the frozen databases with both isolated processes and an external HTTP/RPC driver. Preserve caller dispatch, host receive/commit/send and caller decode timestamps. Replay the same input schedule against old/candidate builds three times, including disconnected peers. The historical arrival schedule was never recorded, so this would be a controlled workload replay rather than an exact reconstruction. Include induced sync CPU, synchronous sleep/I/O, unrelated pending RPC, tracker overflow and GC controls to validate attribution.

## B. Startup admission/evidence and pipelines-phase deadlines

**Evidence.** At **21:57:15.501511** J2 reports a 5,143 ms loop gap while `controller.pipelines` has been pending 16,018 ms, startup admission 14,614 ms and evidence 14,613 ms. A deadline follows at **21:57:16.095700**. These are overlapping promise lifetimes, not additive CPU or lease times. C3 counted 42 startup budget warnings: 41 reconciliation holds of 119–335 ms and one pending-spawn recovery hold of 138 ms. That record does not establish a 14.6-second held lease.

**Path.** `src/lib/viewerInstrumentation.ts:969` starts host adoption; `runtime/startup.ts:1841` defines `admitState`, with initial evidence at `:1952`. `pipelines/store.ts:1539` enters startup admission, prepares evidence at `:1547` before the lease, then checks the signature again inside `store.admit` at `:1553`. `preparePipelineEvidence` at `:1084` shares only an in-flight read; `:1118` removes the completed cache entry. It validates identities across both hot and archived collections. `loadPipelinesForStartupAsync` at `:1122` makes independent revived copies for each caller.

`src/lib/state/sqliteStateStore.ts:925` reads both collections in one read-only transaction. The ordered SQL iterator at `:938` materializes payload strings, `:943` parses JSON, and `:946` yields after approximately 4 ms of work. A single large row can exceed that budget; timer resumption can also be delayed by other callbacks.

Separately, `src/lib/pipelines/controller.ts:206` invokes the pipelines phase. `:312` wraps it, `:322` races the 15-second deadline (`:85`), and `:315` retains the active phase until its original promise settles. Host startup and controller reconciliation are distinct activities sharing the loop. A deadline does not identify the work executing on that loop.

B1 census, independently rechecked during this audit:

```sql
SELECT collection,count(*),sum(length(CAST(value_json AS BLOB))),
       max(length(CAST(value_json AS BLOB))),sum(controller_active)
FROM state_rows WHERE collection IN ('pipelines','pipelines_archive')
GROUP BY collection;
```

| Collection | Rows | Payload bytes | Largest row bytes | controller_active sum |
| --- | ---: | ---: | ---: | ---: |
| pipelines | 265 | 36,360,785 | 917,268 | 16 |
| pipelines_archive | 633 | 83,228,680 | 1,409,364 | 633 |

Every fresh evidence preparation considers **898 rows / 119,589,465 bytes**. Archive flags do not represent the hot controller's selected set.

C3's retained unsampled probes, verified by reopening their JSONL results, ran serving code **22:33:39–22:33:47** and then-main `083158989` **22:34:25–22:34:31**. The evidence/store paths are unchanged between that main and this audit's `92406b7b`.

| Inclusive component | Serving code ms | C3 main ms |
| --- | --- | --- |
| SQL payload iteration, no yielding | 110.31 | 91.90 |
| SQL + JSON, yielded visitor | 340.97 | 273.53 |
| SQL + JSON + shape validation | 458.40 | 381.33 |
| SQL + JSON + validation + revival | 484.51 | 475.02 |
| Actual health, three calls | 444.76 / 500.82 / 473.11 | 403.85 / 366.67 / 339.33 |
| Actual startup admission, three calls | 554.26 / 535.46 / 767.01 | 460.89 / 428.84 / 444.59 |

All returned the expected 898 records or zero health issues, without errors. These are separate inclusive experiments, so subtraction is not an exclusive CPU breakdown. Maximum timer lateness for yielded health was 4.52 ms; startup admission reached 24 ms. They establish substantial recurring work, without reproducing the deadline.

**Proposed fix.** Build a compact, revision-aware ownership/health witness incrementally, retaining duplicate detection, opaque/unknown owners and both collections. Validate changed rows and invalidate on schema/authority change, database replacement, missing change history and untracked writes. Collection revisions alone are insufficient: existing corruption tests deliberately modify JSON without incrementing the revision. A proposed cache must retain that detection contract or prove an equally strong storage identity mechanism. Perform necessary full rebuilds against a consistent snapshot in bounded slices or an owned read worker. Health remains unresolved while evidence is unresolved. Bound the independent per-admission copy as well; retain isolation between callers and compare current authority at admission.

**Expected gain.** A valid unchanged-state reuse can avoid a measured roughly 0.34–0.50-second complete health/evidence read. There is no supported estimate that this alone removes the 14.6-second production lifetime. Three R1 rounds show 32 admissions plus eight joined health calls completing in 1.72–1.86 seconds on serving code and 1.76–2.28 seconds on main. All 32 callbacks each received 898 records. Preserving those results is the correctness criterion.

**Replay.** Run the same SQL/JSON/validation/copy phases and 32-caller burst on B1, then one changed row, cross-collection identity collision, unknown owner, corrupt JSON with unchanged revision, database replacement and truncated change history. Record fresh/shared evidence counts, bytes, synchronous slice maxima, yielded-wait time, signature refusals and durable holds. Keep partial failures. Use `startupResponsiveness.test.ts` as the existing race/isolation test seam. Compare old/candidate under concurrent health polls and registry traffic, then under identical captured startup host observations; never adopt production hosts.

## C. pipelines.controller-mutation

**Evidence.** All 21 J2 gaps carrying this label report one still-pending mutation (`completed:false`); none reports a completed synchronous mutation of that duration. Their pending lifetimes range **1,270–6,225 ms**. Completed decode/checkpoint maxima across J2 are **3/5 ms**. J3 has 44 such gaps; at **23:15:14.205574**, an 8,084 ms gap overlaps an 8,790 ms pending mutation and 8,894 ms pipelines phase.

**Path.** `src/lib/pipelines/store.ts:1521` wraps `reconcileSnapshot`. There are two engine entry sites: initial admissions at `src/lib/pipelines/engine.ts:9691` and main reconciliation at `:9813`. The latter performs per-lane recovery, history, liveness and stage work, with asynchronous ports and short revision-checked checkpoints. The common operation name cannot distinguish these sites or an await from synchronous work.

C3's no-op callback preparation returns 16 selected rows in **19.37 / 7.30 / 5.61 ms** on serving code and **11.96 / 4.56 / 6.65 ms** on its main. R1 demonstrates interference: the same no-op preparation takes **17–31 ms** alone on serving code, but **1,684–1,813 ms elapsed** when independent cold registry reads run during its yields. The introduced registry operations take **530–620 ms each**. Main shows the same mechanism, with preparation elapsed up to 1,880 ms. This is a controlled demonstration of misleading outer duration; the real production callback remains unmeasured.

**Proposed fix.** Separate admission and reconciliation site IDs, measure each synchronous lane slice and each awaited dependency, then bound the measured offender. Prepare external observations before checkpoints, retaining the row-revision/current-owner check immediately before persistence or actuation. Resume durable incomplete obligations on later turns where the protocol permits it. Preserve active-phase exclusion after timeout. Extending the deadline would supply no evidence of improved responsiveness.

**Expected gain.** The observed selected-row/checkpoint component is already small. No measured production saving can be assigned to changing it. Eliminating the reproduced cold registry interference removes approximately 1–2 seconds of additional outer elapsed work in this controlled burst; section E identifies its component stacks. That is not a forecast for all 21 historical gaps.

**Replay.** Exercise both entry sites using existing controller/engine fixture ports and the frozen data. Stub CPU admission, CLI, spawn, signal, publication and runtime effects; return fixed captured observations and delays. Compare durable reservations, checkpoints, conflicting operator mutations, abandoned/unknown outcomes and eventual obligations. Record per-lane sync/await/queue times independently. The no-op replay is a preparation control and cannot validate full engine progress. `controllerLease.test.ts` and `controllerLease.reproduction.test.ts` provide existing seams; the reproduction must run only in an isolated namespace with all actuation contained.

## D. files.get and files.health

**Evidence.** At **21:57:32.070829**, J2's 4,964 ms gap overlaps `files.get`/`files.health` at **8,880 ms**, evidence at 8,879 ms and startup admission at 5,231 ms. At **23:14:29.926221**, J3's largest gap (**9,631 ms**) overlaps health/evidence at **13,324 ms**. The matching lifetimes locate a health request awaiting pipeline evidence. They do not establish that its decoder blocked the loop throughout. J2's separate external GET timeout during the empty gap is covered in section A.

**Path.** `src/app/api/files/route.ts:3` exports `operatorProjection.ts:619` GET, which wraps `files.get`. The storage-health branch at `:630` calls `pipelineRegistryHealthAsync`; this takes the complete evidence path in section B. It returns before scanning and worker transport. Ordinary GET calls `markBoardViewed` at `:633`, scans at `:635`, may migrate task visibility at `:652`, and constructs/caches/persists a projection through `:441`. It is not a production read-only probe.

Main and serving code already pass `{copySnapshot:false}` at `operatorProjection.ts:641`; `src/lib/scanner/scanCache.ts:723` borrows the cache when requested. Worker builds are queued at `operatorProjection.ts:488`; inline fallback explicitly clones at `:470`. The worker is a separate process (`src/lib/scanner/filesResponseWorker.ts:121`, `:146`), with a 60-second bound at `:11`. Request lifetime cannot allocate cost between Viewer queueing, worker CPU, returned-body processing and unrelated loop work. The recorded health case bypasses that worker entirely.

**Proposed fix and expected gain.** Apply section B's correct reusable health witness and section E's scoped registry reads. Add scan/signature/queue/worker/inline-clone/delta/serialization/response-write timings to ordinary GET. Preserve cache generation, ETag/delta-base and visibility semantics. The measured health work offers the component saving in B; no full-route latency gain has been measured. Reapplying #2882 would not change the serving implementation.

**Replay.** In a private full instance, freeze the scan snapshot and all required stores together as closely as possible, identify separately sampled databases, and replay eight board scopes with the same HTTP schedule. Measure cold/warm/invalidated projection, joined requests, persisted-body start, summary/full, conditional/delta/gzip, storage-health and disk-full fallback separately. Capture worker lifecycle and external first byte as well as internal phases. This lane did not execute a complete normal-GET/browser load replay: historical scan generations, query/header mix and request arrivals are absent. Component timings must not be presented as HTTP timings.

## E. Profile-backed components and mixed-load replay

B1 fingerprints, retained unchanged:

- State: `6b2b20c0790ce1b03f49b362f7862f51d1297d2ba4c0e05d6009b6ea7a064b2c`.
- Runtime events: `4ca69ff04dbb9b2935980c5ac8aba20d3a8785209934389ea5a6a9820663ae56`.
- Registry: `c6f1068d23bd2b28d05a5eda80e5f0e982d6b0fab7012b2dbdbb2710be87bb4b`.

The backups are three separate online snapshots made after the incident. They are production-sized retained data, not an atomic historical system image. Keep them read-only and create fresh writable derivatives for store initialization/lease operations. The direct registry probe opens its derivative with `readOnly:true` and uses the real `normalizeRegistry`.

R1 concurrently executes 32 `withPipelineStartupAdmission` calls (each loads the complete admitted evidence), eight health calls and one controller preparation with a no-op callback. The interference mode schedules three fresh registry readers at 10, 500 and 1,000 ms after burst start, each calling `readOnlySnapshot` then `Object.keys(file.entries)`. A 10 ms independent interval records timer lateness; outer wall and process CPU are recorded separately. Every round returns 898 pipelines, zero health issues, 16 controller rows and, where requested, 5,430 registry keys. There are no refused admissions or errors. Record counts were checked; complete returned-value and actuation equivalence were not established. Startup calls are dispatched before health calls, so health joins startup evidence; replaying health-first and mixed arrival orders remains necessary. This is controlled overlapping load on real data; the three-reader rate is not a measured production arrival rate. `Object.keys` measures snapshot/key construction, not full entry-payload enumeration.

| R1 mode | Serving wall ms, rounds 1/2/3 | Main wall ms, rounds 1/2/3 | Maximum timer lateness, serving / main ms |
| --- | --- | --- | --- |
| Admission + health + preparation | 1,715.76 / 1,864.53 / 1,760.75 | 2,282.96 / 2,235.11 / 1,761.10 | 58.68 / 62.38 |
| Same + three cold registry reads | 4,036.35 / 3,785.66 / 3,943.35 | 2,958.36 / 2,916.05 / 3,896.23 | 622.08 / 640.77 |

These runs neither reproduce a >=1-second gap nor show a reliable main improvement: environment/JIT/cache variation is visible and the ranges overlap. All three rounds are retained. No fix was applied in this lane. Process CPU includes runtime helper/GC threads; it is not a main-thread exclusive CPU counter.

**New profile R2.** `main-mixed.cpuprofile` contains **13,381 samples over 16.131 seconds**. Reopening its node tree and parent links gives the following leaf samples; these counts describe sampled stacks, not exclusive elapsed milliseconds:

| Leaf / parent path on main | Samples | Source |
| --- | ---: | --- |
| `structuredClone → reviveLoadedPipeline → loadPipelinesForStartupAsync` | 2,331 | `src/lib/pipelines/store.ts:1205`, `:1121` |
| SQLite `.all → rememberColdProjections → rememberReadOnly → loadSnapshot` | 1,159 | `src/lib/agent/sqliteRegistryStore.ts:1604`, `:1772`, `:1140` |
| `JSON.parse → visitStateCollectionsRows` | 1,135 | `src/lib/state/sqliteStateStore.ts:943` |
| SQLite iterator → evidence visitor | 964 | `src/lib/state/sqliteStateStore.ts:938` |
| SQLite `.all → loadHotInTransaction` | 653 | `src/lib/agent/sqliteRegistryStore.ts:1222` |
| SQLite `.all → orderedKeys` | 565 | `src/lib/agent/sqliteRegistryStore.ts:1259` |
| SQLite `.all → rememberReadOnly` | 535 | `src/lib/agent/sqliteRegistryStore.ts:1772` |
| `statSync → readLegacySnapshot → canonicalProject → reviveLoadedPipeline` | 488 | `src/lib/projects/aliases.ts:68`, `:123`; `src/lib/pipelines/store.ts:1216` |
| `statSync → stateDatabaseSignature → readWorktreeRecoveries → canonicalProject` | 402 | `src/lib/state/sqliteStateStore.ts:862`; `src/lib/projects/worktreeRecoveryStore.ts:40` |

This identifies copying/decoding/SQL and repeated alias-authority filesystem checks as concrete costs of the replay. The baseline includes the three databases, but ancillary alias JSON and transcript trees were not frozen; the legacy alias lookup sees the isolated missing-file path. Its sample cost cannot be promoted to a complete production alias projection measurement. A follow-up can capture immutable alias authority once per evidence version and revalidate at admission, keeping each caller's mutable copy independent. The 32-caller burst performs 28,736 record revivals after preparation; eliminating required copies indiscriminately would weaken its isolation contract.

Profiled rounds are preserved separately by their timestamp boundary: wall times **2,027.05 / 1,843.28 / 2,002.43 ms** without added readers and **3,247.27 / 3,233.83 / 3,470.87 ms** with them. Maximum timer lateness is 535.60 ms. These samples remain excluded from the R1 table. No stack in R2 is a historical production stack.

**Registry stacks.** C3's reopened `registry-main.cpuprofile` has 1,330 samples: SQLite `.all` under `rememberColdProjections` has 318, hot-row loading 164, `rememberReadOnly` header loading 135, and `orderedKeys` 135. Source: `src/lib/agent/sqliteRegistryStore.ts:1175` → `:1140` → `:1772`, with cold claims queried in batches of 500 at `:1604`. These are synchronous batches without a yield between batches. Its three cold snapshots cost 390–500 ms across the two revisions; full entry-value enumeration adds 95–175 ms. Cold key enumeration and full payload enumeration are separate experiments.

#2892 defers cold collection assembly, but fresh authority/grant projections and broad consumers still cost time. Prefer existing indexed/keyed readers for narrow consumers; prepare unavoidable full reads in a bounded owned worker against an immutable snapshot. Preserve grant revocation, ownership, cold row ordering, store replacement and lost-journal invalidation. Expected component improvement is removal or relocation of a measured roughly 0.37–0.64-second cold read from the Viewer loop in R1. A <=10 ms slice target is an acceptance target, not an achieved result. Replay fresh, warm, dirty-one-row, grant-revoked, missing-history and full-enumeration modes with identical returned records.

**Runtime-host boundary.** C3's reopened `runtime-main.cpuprofile` has 4,876 samples; fallback SQLite `.all` under `snapshotSessionValues` accounts for 2,130 direct samples plus 577 rebuild samples, and `snapshotEdgeValues` for 832 plus 283. It was taken immediately after `RuntimeJournal.open`, before the scheduled metadata readiness callback. Those 1.05–1.09-second serving-code collections are a startup fallback measurement. After a 50 ms timer opportunity explicitly confirms readiness, the same frozen state collects in **175–196 ms** on serving code; JSON serialization is 23–35 ms and parse 10–17 ms, for 8,865,474 bytes and 813 sessions. Snapshot code is unchanged in this audit's main. The relevant indexed/fallback choice is `src/runtime-host/journal.ts:3065`, `:3109`, and `journalSessionMetadata.ts:54`.

Record readiness on slow snapshots; recognize an already completed durable metadata initialization before admitting an immediate fallback request, while preserving bounded backfill and authoritative fallback for incomplete state. Replay immediate-post-open, ready, dirty rebuild and cache-hit modes separately. The possible startup collection saving is approximately 0.85 seconds on this data. It supplies no evidence that a ready host caused the Viewer gap at 22:05.

## F. Minimal continuous attribution contract

Implement this in a later write-authorized stage. Static labels and numeric counters keep the first layer cheap; arbitrary stack strings, contents and identities must not enter the public journal.

1. **Loop record.** Retain the 10 ms loop check. For every gap >=1 s emit process role, serving SHA/build ID, process start identity, sequence, monotonic last/current tick, UTC correlation, timer lateness, pending request/phase counts, and tracker dropped/overwritten counts. Store start/end for synchronous slices and intersect their intervals with the delayed-tick interval. Preserve an enclosing async span's wall time separately. Completed work must survive until the next tick. Avoid summing nested or overlapping intervals as exclusive CPU.
2. **Bounded synchronous records.** Use an interned site table mapping numeric IDs to source file/line at the build SHA; a fixed ring of 1,024 records with sequence, span/parent IDs, start/end, kind, rows, bytes, outcome and queue depth. Aggregate tiny adjacent slices by site; keep count/sum/max and dropped duration. Do not retain row contents, SQL parameters, paths, account IDs, request URLs or headers. Flush only gap-triggered records and a bounded periodic summary. A ring overflow marks attribution incomplete, and cannot silently count as covered.
3. **Required sites.** Add spans around SQL iterator advances, JSON parse, `isPipeline`, revival/copy, evidence identity checks, lease acquisition COMMIT and successful release, checkpoint encoding/write, registry snapshot/header/claim/lazy-row reads, synchronous filesystem reads, runtime collection/stringify/parse, files scan-key construction, inline clone, delta construction and response encoding. Distinguish the two controller entry sites and per-lane callback categories. For every `await`, record wait category and resumption; measure time yielded to the loop separately from time spent executing a slice. Record preparation revision changed/refused and shared-read counts.
4. **Cross-process request boundaries.** Reuse the existing opaque RPC request ID at `client.ts:325` in a bounded diagnostic ring. Record method enum, caller dispatch/connect/send, host receive/handler/commit/serialize/send, caller first-byte/frame/decode, deadline expected/fired, byte counts and outcome. Use local monotonic clocks per process plus clock-correlation anchors; never subtract uncalibrated cross-process clocks. HTTP gets an ephemeral correlation ID with route class, queue admission, worker dispatch/completion, response start and finish. Keep worker identity separate from Viewer identity. Capture metadata for all calls in the ring so an unpredicted timeout still has its start.
5. **CPU versus waiting.** An independently serviced watchdog samples the Viewer's main-thread scheduler counters and current synchronous site from shared memory every 100 ms, retaining 60 seconds. On Linux, record per-thread run time/run-queue delay and cgroup CPU throttle deltas, plus counter-availability flags; process-wide `cpuUsage` alone is insufficient. The watchdog must also report its own sampling lateness. This can distinguish measured off-CPU time from running time but cannot assign unsampled JSC/GC work to a JS path.
6. **Remaining native/GC hole.** A post-gap JS stack is too late. Validate a bounded rolling native/main-thread sample stream and exact GC start/end events under pinned Bun 1.4.0 on the private replay first. The successful `--cpu-prof` runs prove offline CPU sampling only; they do not prove a supported cheap rolling profiler or GC API. If the runtime offers no verified bounded facility, keep the category explicitly `unknown-runtime-or-native` and the coverage count incomplete. Do not label a heap decrease, high process CPU or timer delay as GC. No proposed cheap JS wrapper guarantees attribution of every runtime pause.

Resource/overhead acceptance: cap records and outstanding correlations (for example 1,024 each), cap retained metadata to 2 MiB per process, emit at most 64 KiB per gap with truncation counters, and measure median/p95 throughput and loop-lateness overhead with telemetry on/off on identical replay data. Target less than 1% CPU overhead; this target has not been measured. Use bounded asynchronous logging; log backpressure itself needs dropped-record counters. Preserve the longest synchronous samples when rotating. A sample unavailable due to overflow, watchdog starvation or unsupported tracing stays unresolved in the report.

Validate wrapped and unwrapped CPU blocks, returned synchronous work, delayed async continuation, synchronous lock sleep, timer-yield wait, tracker overflow, worker stall, host-only stall, Viewer-only stall, cancellation, and GC controls. A pending unrelated `files.health` must not be named as the exclusive cause of a synthetic registry block. Keep the existing request/deadline and lease bounds unchanged. Report coverage as attributable gaps / all gaps, with unknowns listed individually; do not claim 100% coverage until the native/GC cases pass.

## Replay and validation handover

Private artifacts include `baseline/`, source exports `production/` and `main/`, `pinned.jsonl`, `new.jsonl`, their extracted gap lists, complete mixed-run JSONL, CPU profiles and resource-counter snapshots. They contain production data and stay private. `$PRIVATE` denotes this audit's recorded scratch root; `$GATE` denotes the installed gate path prescribed by the stage. No artifact is a publication fixture.

The scratch driver is `run.py`; it creates a fresh derivative for each source/case and runs the following equivalent command through `$GATE`:

```sh
rtk proxy env HOME="$PRIVATE/home" XDG_CONFIG_HOME="$PRIVATE/config" \
  TMPDIR="$PRIVATE/tmp" LLV_STATE_DIR="$PRIVATE/derived-state" \
  LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1 \
  LLV_RUNTIME_HOST_SOCKET="$PRIVATE/absent.sock" \
  bash "$GATE" bwrap --unshare-pid --unshare-net --ro-bind / / \
    --proc /proc --dev /dev --tmpfs /run --bind "$PRIVATE" "$PRIVATE" \
    --chdir "$PRIVATE/main" bun scripts/audit-mixed.ts
```

The driver also disables runtime consumers/structured hosts and observers and strips inherited product settings. It imports only library components, never launches engines, performs no network calls and opens no listener. Its PID namespace prevents copied process identities from reaching production. Only the scratch root is writable inside the replay. Dependencies are borrowed from the installed release after byte-identical `bun.lock` comparison. The only scratch source change exposes the existing validator/reviver for phase ablations; their implementations remain unchanged. No imports, installs or tests run in the assigned worktree.

The main mixed profile adds `--cpu-prof --cpu-prof-dir="$PRIVATE" --cpu-prof-name=main-mixed.cpuprofile`. Keep profiled timings separate from unprofiled latency comparisons. Gate admission time is separate from execution time. R2 recorded a three-CPU/8-GiB own limit inside the aggregate work slice's 18-CPU cap. Its own throttling increased by only 2.357 ms, with no additional ancestor throttle time or OOM kills during the profile. R1's own scopes had already exited when inspected, so only their shared ancestor limits were recovered. The serving processes' inspected ancestors have no finite CPU cap. Current caps cannot reconstruct historical contention; shared co-tenants and page-cache state remain uncontrolled.

For implementation acceptance, run each old/candidate case three times with identical source-independent baseline hashes, input schedule and boundaries. Record SQL/decoder/store/HTTP/worker phases separately, memory/CPU limits, per-thread scheduling, error/refusal counts, byte/row counts and all partial times. Prove result equality and durable progress before claiming latency gains. A missing recorded arrival schedule remains a limitation, even when retained events can be replayed.

After deployment by the owning seat, identify both serving SHAs and the deployment completion time. Start a fresh **30-minute** window for that SHA; count lease holds over about one second, busy incidents, RPC/phase timeouts and all >=1-second loop gaps. Recount the journal after the window closes and retain attribution coverage. A changed SHA resets the window. This read-only stage does not deploy or satisfy that downstream release condition.

The focused check ran from the scratch main export, with a fresh state directory, isolated HOME/config/temp and a closed control endpoint:

```sh
rtk proxy env HOME="$PRIVATE/home" XDG_CONFIG_HOME="$PRIVATE/config" \
  TMPDIR="$PRIVATE/tmp" LLV_STATE_DIR="$PRIVATE/check-tests" \
  LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1 \
  bash "$GATE" bun test src/lib/pipelines/startupResponsiveness.test.ts
```

At **23:33:04.886–23:33:09.321**, it passed **10 tests / 558 assertions**, zero failures. It verifies yields between leases, completed-operation retention, durable timing before an await continuation, freshness refusal, unknown/corrupt records and independent returned copies. These are the existing tests; no new test or source file was added to the worktree.

The first check at **23:32:46.517–23:32:46.820** failed before running assertions: the test preloader attempted to re-enter its owned runner from inside a private PID/network namespace and could not reach the user bus. Retained that failure. The corrected invocation lets the prescribed gate own the test runner directly, retaining all isolated state roots; `test-preload.ts` then disables CPU placement/admission inside test fixtures. No lifecycle suite or production-state fixture ran.

At **23:33:49.585**, the recorded Viewer and runtime-host start identities both matched `/proc/PID/stat`, and both remained on serving `61799bbc`; `deployment_status({compact:true,limit:2})` still showed no newer deployment. Baseline hashes were rechecked unchanged at the same observation. `git diff --check` passed, and `git status --short --ignored` showed only the declared document directory, without ignored build/test output. The initial and closing remote-main checks are recorded above. The path-scoped privacy check uses the trusted committed fingerprint file and this exact command from the scratch export, under the same isolated roots and prescribed gate:

```sh
bun scripts/privacy-publication-gate.ts --repository "$WORKTREE" \
  --require-known-values --paths docs/perf/viewer-stalls-attribution.md
```

The path-scoped privacy gate passed at **23:35:13.524–23:35:13.990**.

No source/runtime pin changed; types, broad runtime/native suites and CI publication gates were not run for this document-only stage. They remain required for a later implementation/publication. The runtime-host rehearsal would additionally be required for a Bun pin change.
