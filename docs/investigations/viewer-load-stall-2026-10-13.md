# Viewer load stalls, 2026-10-13: step-one investigation

The [build verification](#build-verification-2026-10-13) below records the
subsequent implementation and its remaining cold-cache acceptance question.

The continuation reproduced a concrete 10–30 second stall mechanism in the pinned Viewer: repeated synchronous `readStateCollectionsRows()` SQL snapshots and `JSON.parse()` of the complete pipeline stores, entered through `withPipelineStartupAdmission()`. With 96 simultaneous admissions at production size, the longest loop gap was **20,513.248 ms**, the first caller's pipelines lease lasted **20,294.309 ms**, and a concurrent page's measured curl time-to-first-byte was **20,684.226 ms**. A 64-caller ordinary mutation control had a 146.931 ms gap and a 136.401 ms longest lease. E8.

The first admission acquires its durable lease before its `await` continuation runs. Competing admissions then perform their synchronous pre-admission integrity reads. Those reads delay the first owner's continuation and release. The trace records 95 full reads while that first lease is held. A second case, with 32 callbacks that also perform the two full evidence reads used by startup, delays page TTFB to 27,067.730 ms. The isolated cause is repeated complete-store decoding without an event-loop opportunity, including work by competing callers while another caller owns the lease. This establishes a reproducible blocker and supports the build stage.

Historical attribution remains limited. The incident's request sequence, callback stack and lease operation name were never recorded. The synthetic admission counts are stress inputs; the journal does not establish that 96 such callers arrived together during 11:30–11:50Z. The completed mixed workload also reproduced shorter gaps in files-response parsing and delta construction. The controller accepted this historical gap and authorized removal of the proven full-archive blocker plus operation attribution for the next occurrence. Step one passes on that decision; this document makes no claim that the recurring production outage has been fixed.

This stage changed only this document in the worktree. Production reads used the journal, `/proc`, retained evidence and SQLite handles opened with `mode=ro` and `PRAGMA query_only=ON`. Profilers ran exclusively in private instances. The stage sent no live HTTP requests and never signalled a live process. It performed no live debugger attachment, restart, deployment or agent operation. All recorded probe PIDs are absent after cleanup; E9 includes a partial run stopped by the private gate's memory limit. Nothing is committed or staged.

The checkout and deployment status both name `f275413eecffd19a699ecce2d57a2f8900491ccf`. The serving Viewer and runtime host have different PIDs and run from that release's installation. Deployment status records 11:09:18.538–11:12:40.563Z, with success at the latter timestamp. Journal output is collected under a launcher PID that forwards child output; that journal PID alone cannot identify the process executing a line. `/proc` identifies the serving processes independently. All dates and times below are UTC on 2026-10-13.

The evidence commands use redacted variables: `LIVE_STATE` is the existing installation's state directory, `RELEASE` is its deployed checkout, `WEB_PID` and `RUNTIME_PID` are the recorded process identities, and `PRIVATE` is the unique scratch directory recorded when created. Their actual values and raw database copies remain outside this public document. Commands and queries below retain the actual arguments apart from those substitutions.

The investigation read `AGENTS.md`, the relevant isolation/publication sections of `CONTRIBUTING.md`, and the installation/runtime sections of `README.md`. It left `src/lib/mcp/bindings.ts` untouched.

The timeline combines the handoff with independently retrieved evidence:

| UTC interval or instant | Observation and evidence |
| --- | --- |
| 11:09:18.538–11:12:40.563 | Deployment of the pinned release succeeded. `deployment_status({compact:true,limit:6})`, read at about 12:09Z. |
| 11:10–11:20 | Seven journal lines match timeout/busy/deadline expressions. Startup emits 148 lease-budget warnings in this window; 123 concern structured-host reconciliation. Their held durations are 414–878 ms, with reconciliation totaling 57,653 ms across distinct admissions. These are startup costs; they do not explain the later recurrence by themselves. E1. |
| 11:20–11:30 | Matching lines rise to 21. The first `StoreBusyBeforeAdmissionError` is at 11:27:26.221; the first scan-phase deadline warning is at 11:28:02.775. E1. |
| 11:30–11:40 | 113 matching lines; 34 runtime RPC timeout lines, including 19 appends. E1. |
| 11:40–11:50 | 107 matching lines; 59 runtime RPC timeout lines, including 30 appends and 17 snapshots. At 11:43:22.476 the logged synchronous registry writer wait is 756.7 ms, and its enclosing revision retry is 759.0 ms. E1. |
| About 11:43–11:53 | Handoff reports public and forwarded-origin page requests timing out after 10–15 seconds with zero response bytes, followed by a shell displaying “Loading board.” It reports functioning DNS/TCP/TLS/SSH. These transport observations were supplied by the operator's handoff and were not independently replayed against production in this stage. E0. |
| Backup named 11:50:44.751 | The state backup contains a `pipelines` lease owned by the serving Viewer, acquired at 11:50:27.540. Acquisition precedes the backup name's timestamp by 17.211 seconds. This confirms an aged lease in the retained snapshot; the filename is not a sampled release boundary or a continuous holding-duration trace. E5. |
| 11:50–12:00 | Fifty matching lines. Snapshot transfer peaks at 5,812.8 ms for 7,294,324 bytes at 11:50:50.250. At 11:58:43.137 a pipeline acquisition wait finishes after 66,483.1 ms. Both measurements explicitly have `synchronous:false`. E1. |
| 12:00–12:10 | Twenty-three matching lines. Handoff reports spontaneous recovery and another API timeout during triage. There was no recovery action by this stage. E0/E1. |
| 12:10–12:19 | Nine matching lines remain. Pipeline-phase deadline warnings recur at 12:18:20.325, 12:18:38.021 and 12:18:59.070. Recovery therefore does not establish that the cause disappeared. E1b. |
| 12:13:17.535–12:13:23.550 | A fresh `/proc` sample gives the Viewer 88.9% CPU across 5.514 measured seconds; its main thread accounts for 71.5%. RSS moves from 5.23 to 4.92 GiB. This sample describes the later interval; peak incident CPU was not sampled here. E2. |
| 12:14:20.371–12:14:30.378 | A 250 ms read-only lease sampler sees frequent short acquisitions by the same Viewer, interspersed with empty lease reads. It does not reproduce the incident's prolonged lease. E4. |
| 12:15:25.039–12:15:29.775 | An isolated source Viewer probe measures the production-size store operations and captures a CPU profile. E6. |
| 12:19:20.502–12:19:28.866 | Initial isolated production-build probe is refused for board reads because its private release target lacks required authority fields. These 500 responses are a harness refusal. They are excluded from successful board timings. E7. |
| 12:20:52.843–12:20:59.028 | Corrected private production build returns page and board responses over a synthetic catalog. First files headers arrive after 3,365.5 ms; its main event-loop maximum is 130.2 ms over the measured request window. The page keeps responding. E7. |
| 12:44:15–12:45:27 | First bounded replay combines a production-sized pipeline archive with the synthetic catalog. A 64-admission burst gives a 14,291.122 ms gap and 14,322.112 ms page header delay. The following 25-second mixed run gives a 2,218.781 ms gap, with a CPU profile naming files-response parsing and delta construction. E8/E9. |
| 12:48:09.285–12:48:23.876 | Repeated 64-admission burst, now timing durable lease acquisition and release: 14,150.964 ms gap, 13,856.288 ms hold, 14,286.073 ms page TTFB. E8. |
| 12:48:23.907–12:48:44.665 | A 96-admission burst gives 20,513.248 ms gap, 20,294.309 ms hold and 20,684.226 ms page TTFB. E8. |
| 12:48:44.696–12:49:11.908 | Thirty-two startup-evidence callbacks perform 96 full reads. Longest gap 18,619.975 ms; longest hold 8,220.479 ms; page TTFB 27,067.730 ms. E8. |
| 12:49:12–12:49:37 | Completed 25-second mixed run: 40 rounds of task-finish sweeps, CPU polling admissions, controller phases and runtime traffic; maximum gap 1,121.714 ms, hold 173.560 ms. E9. |
| 12:49:56.325 | The following health variant ends with the private gate service reporting `oom-kill` under its 8 GiB cap. Its incomplete result and missing CPU profile are excluded. E9. |
| 12:53:33–12:53:45.985 | Fresh Viewer, private gate limit 12 GiB, fewer parallel HTTP requests: 24 mixed rounds including health reads complete. Maximum gap 528.364 ms, hold 302.146 ms. E9. |
| 12:56:58.378 | All 18 recorded probe/launcher/curl identities are absent. All six assigned private listeners and the deferred control port are closed. E9. |

The matching-line count uses `timeout|timed out|busy|exceeded.*deadline`, case insensitive. Each line is counted once. A printed exception can occupy several journal records, so the counts are diagnostic volume rather than distinct outages. Windows are half-open, beginning at 11:10, 11:20, and so on; the first includes late deployment/startup. The supplied “after deployment” counts are numerically reproduced under these explicit boundaries.

**What made 11:30–11:50 worse remains unestablished.** Timeout and admission failures clearly concentrated there, but the retained runtime journal contains fewer recorded events in those windows than in 11:20–11:30. That can reflect reduced admission under a stall; it cannot recover the incoming HTTP rate or establish a workload trigger.

| Runtime journal window | Recorded events | `item` payload bytes | Runtime timeout lines |
| --- | ---: | ---: | ---: |
| 11:10–11:20 | 1,701 | 1,070,728 | 5 |
| 11:20–11:30 | 1,926 | 2,046,548 | 0 |
| 11:30–11:40 | 279 | 220,447 | 34 |
| 11:40–11:50 | 1,135 | 1,194,940 | 59 |
| 11:50–12:00 | 1,267 | 1,359,271 | 21 |
| 12:00–12:10 | 1,839 | 1,294,897 | 23 |

These counts measure committed journal events selected by `created_at`. They exclude attempted requests and browser traffic. Journal `recorded_at` and `occurred_at` coincide on this retained data; they provide no independent queue-arrival clock. The largest interval between retained appends is 98,173 ms, but idle producers, delayed producers, and host dispatch delays cannot be distinguished by that interval. E3.

The 11:50 backups already contain 305 hot pipelines totaling 34,125,185 JSON characters and 499 archived pipelines totaling 61,216,839. Only ten hot records are controller-active, totaling 1,557,122 characters. The later private copy contains 306 hot pipelines and 499 archived pipelines; the live aggregate read nearby finds 308 hot records, thirteen controller-active. Pipeline/archive size is thus already substantial at the incident boundary and changes little afterward. No earlier retained backup in the inspected directory establishes what changed at 11:30. E3/E5.

The exact observed admission stack in the live journal is:

```text
FileTransactionBusyError: pipeline state is busy
  acquireLease (.next/server/chunks/734.js:210:1303)
  async mutate (.next/server/chunks/734.js:159:2055)
  async n (.next/server/chunks/734.js:211:5730)
StoreBusyBeforeAdmissionError
  n (.next/server/chunks/734.js:211:5800)
```

The running source maps that path to `SqliteStateCollection.acquireLease()` (`src/lib/state/sqliteStateStore.ts:1973`), `mutate()` (`:1430`), and `refuseBusyBeforeAdmission()` (`src/lib/state/fileTransaction.ts:63`). `acquireLease()` retries with `setTimeout`, then throws before the mutation callback runs. This stack identifies a waiter. It contains no frame from the callback owning the lease. The journal's synchronous lease-acquisition marker did not appear in E1; the long markers are asynchronous acquisition waits. Source inspection therefore rules out interpreting those markers as measurements of a synchronous lease wait or of the owner's callback duration.

The isolated source probe called actual production readers against SQLite backups created from read-only production handles. It served a private minimal HTTP listener; it did not run Next page rendering, runtime startup, controller actions, or agent discovery/adoption. Each operation is separated by 30 ms timer opportunities. Its ten-millisecond timer measures timer lateness, including scheduling and profiler overhead. The CPU profiler samples only that private process.

| Operation | First / second / third wall time, ms | Largest observed timer lateness, ms |
| --- | --- | ---: |
| `AgentRegistry.readOnlySnapshot()` | 316.090 / 0.138 / 0.156 | 315.576 |
| `loadPipelinesForStartup()` | 302.540 / 224.012 / 226.225 | 302.773 |
| `pipelineRegistryHealth()` | 220.426 / 238.760 / 227.369 | 238.521 |
| `withPipelineStartupAdmission(async () => null)` | 274.938 / 249.985 / 244.850 | 272.507 |
| `loadPipelines()` | 119.721 / 7.574 / 7.507 | 119.090 |
| `loadPipelinesForProjection()` | 8.029 / 7.032 / 7.305 | 7.534 |
| `loadTasks()` | 72.670 / 45.643 / 42.370 | 73.123 |
| `procBackend.listProcesses()` | 9.104 / 8.971 / 8.436 | 8.863 |
| `procBackend.ppidMap()` | 5.788 / 8.407 / 4.933 | 8.156 |
| `procBackend.scanFdTargetsUnder()` | 11.494 / 11.404 / 10.901 | 11.350 |

The first `processList` timer reading is 8.168 ms; the displayed maximum covers all three calls. Counts at that point are 807 complete pipeline records, 306 hot records, 1,485 visible tasks, and about 635 processes. The underlying private database retains 1,587 tasks; `loadTasks()` applies production visibility rules.

The profile contains 2,729 samples. Its exact source stacks for the measured complete reads are:

```text
JSON.parse
  readStateCollectionsRows (src/lib/state/sqliteStateStore.ts:856)
  readCompletePipelineRecords (src/lib/pipelines/store.ts:1051)
  loadPipelinesForStartup (src/lib/pipelines/store.ts:1067)
  withPipelineStartupAdmission (src/lib/pipelines/store.ts:1454)

SQLite statement .all
  readStateCollectionsRows (src/lib/state/sqliteStateStore.ts:856)
  pipelineRegistryHealth (src/lib/pipelines/store.ts:1262)

SQLite statement .all
  rememberColdProjections (src/lib/agent/sqliteRegistryStore.ts:1599)
  rememberReadOnly (src/lib/agent/sqliteRegistryStore.ts:1767)
  loadSnapshot (src/lib/agent/sqliteRegistryStore.ts:1135)
  readOnlySnapshot (src/lib/agent/registry.ts:5492)
```

`readStateCollectionsRows()` executes one complete SQL snapshot and `JSON.parse()` for every returned value. Startup reads both active and archive collections on every call. `pipelineRegistryHealth()` also reads both collections. Its request caller is `/api/files?view=storage-health` (`src/app/api/files/operatorProjection.ts:612`), which invokes it synchronously before scanner/projection work. The measured reads exceed the proposed 200 ms maximum. The no-op admission case includes an integrity read before taking the lease; its total duration must not be reported as the lease's hold time. That callback did no work and persisted nothing.

The separate Next experiment served a copied production build from the pinned release, with the installed Bun 1.4.0. Its catalog was generated through `buildRegistryPerformanceDataset()`, using the later production aggregate counts as shape inputs. The constructor reports 37,488 normalized rows, 121,719,490 payload bytes and 4,813 synthetic transcript files. Its second seed reports 37,299 cold rows. Normalization means those row counts are not a byte-identical reproduction of the production registry. The HTTP experiment has empty pipeline/task stores, no runtime host, no concurrent registry writers, and deferred lifecycle controllers. It isolates catalog/first-response behavior and leaves the production lease workload untested.

| Corrected private HTTP phase | Page header time, ms | Files first headers / complete body, ms | Files body bytes |
| --- | --- | --- | ---: |
| First page before board requests | 556.915 | — | — |
| Cold catalog, concurrent page and board reads | 2.894 and 134.996 | 3,365.472 / 3,367.345 | 1,692,871 |
| Warm batch 1 | 8.145 and 17.381 | 131.152 / 133.253 | 1,692,871 |
| Warm batch 2 | 9.085 and 11.906 | 28.101 / 29.916 | 1,692,871 |

Page responses are HTTP 200 and 34,896 bytes. `/api/board?project=repo-synthetic` returns HTTP 200 in 127.888, 15.367 and 4.429 ms. The files route is `/api/files?view=summary`, HTTP 200 in all three corrected batches. Two attempted pipelines query shapes returned 400 because they named unsupported parameters; they yield no pipelines HTTP performance claim. The existing `candidateServerLoopProbe.ts` observed the actual Next PID: 402 samples, p95 lateness 3.6 ms, maximum 130.2 ms during the request window. Python's header timings are `urllib.request.urlopen()` return times, an upper bound on first response byte; these are not `curl time_starttransfer` measurements. This distinction must be retained if the data is compared later.

The cold files latency violates the requested one-second first-data outcome in this isolated catalog. Its concurrent page success and short main-loop gap show that this particular slow first-data result differs from the reported zero-byte page timeouts. Its 1.69 MB response also differs from the handoff's 38,900,181-byte response. Neither observation identifies the incident operation.

The continuation seeded 305 hot and 499 archived pipelines, matching the incident's 34,125,185 and 61,216,839 JSON-character totals. The copied later store was trimmed to the incident counts and a small inert padding field restored the JSON total; it preserves production-size parsing, with a different record distribution. During the real controller pass, one settled pipeline moves to the archive. Total pipeline record count remains 804. The private first-boot paths also add three local tasks to the initial 1,583. These are synthetic/isolated state changes.

The catalog generator used the retained incident dimensions of 5,730 conversations, 4,810 entries and 7,922 delivery-operation owners. Other collections use the earlier private-copy counts because the prior incident-backup reading retained no aggregate for them: 4,906 receipts, 5,283 held deliveries, 5,112 lineage edges, 4,032 memberships and 43 migration intents. The generator reports 37,471 normalized rows, 121,520,975 payload bytes and 4,810 transcript files. This is a production-sized catalog with synthetic content. The incident backups had rotated out by the continuation; their original sizing query and result were recovered through `conversation_messages` and checked against the existing private copy.

Every child inherits a private HOME, TMPDIR, XDG config/cache, `LLV_STATE_DIR` and `LLV_GATE_LOCK_DIR`. `LLV_VIEWER_CONTROL_URL` points to closed loopback port 1; the private release target also defers lifecycle activation there. `LLV_RUNTIME_HOST_SOCKET` names the independent private socket. Structured hosts, account controllers, the reaper and runtime event emission are disabled. `DELEGATUS_AGENT_CPU=off` avoids changing shared placement properties; admission tickets and lock files stay in the private gate directory. The owned runner bounds each run and owns descendant cleanup. Initial resource checks found no CPU quota and a 5.5 GiB agent-scope memory cap; the runner places the workload in its separate private gate service, initially capped at 8 GiB and at 12 GiB for the fresh retry. The parent and workload are serialized with no browser processes.

Each burst runs the actual store entry points in the main thread of the copied Next production build. Timing hooks exist only in the private source export: complete-read exit, lease acquisition immediately after its successful SQLite COMMIT, and successful lease deletion. They introduce no deliberate delay. A ten-millisecond timer measures lateness independently of the CPU profile. The HTTP driver runs outside that process. Curl measures actual `time_starttransfer`; Python's `urlopen()` return measures receipt of response headers. Only the curl column below is an exact TTFB measurement.

| Sequential old-code case | Full reads | Longest loop gap, ms | Longest durable lease hold, ms | Page curl TTFB, ms | Files header delay, ms | Board header delay, ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 64 ordinary `withPipelineMutation()` calls | 0 | 146.931 | 136.401 | 263.050 | 397.526 | 264.350 |
| 64 `withPipelineStartupAdmission()` calls, no-op callbacks | 64 | 14,150.964 | 13,856.288 | 14,286.073 | 14,560.154 | 14,288.781 |
| 96 startup admissions, no-op callbacks | 96 | 20,513.248 | 20,294.309 | 20,684.226 | 20,726.256 | 20,687.341 |
| 32 startup admissions, evidence-reading callbacks | 96 | 18,619.975 | 8,220.479 | 27,067.730 | 27,159.731 | 26,603.729 |

All listed page, files, pipelines and board requests return HTTP 200. Files bodies are about 34.0 MB and pipeline bodies about 38.0 MB. The board query selects the synthetic project and returns a small 365-byte membership response; first substantive board data is the files response. These dimensions are close to the handoff's large files response, unlike the earlier catalog-only experiment's 1.69 MB response. Every burst completed with zero rejected admission promises. No thirty-second runtime timeout is claimed for these burst cases, which did not issue runtime requests.

The 96-caller trace names the actual owner and the work delaying it:

```text
12:48:24.095Z  first startup-noop admission commits its pipelines lease
              acquisition stack (original source locations):
                tryAcquireLease                 state/sqliteStateStore.ts:1913
                acquireLease                    state/sqliteStateStore.ts:1973
                mutate                          state/sqliteStateStore.ts:1429
                refuseBusyBeforeAdmission       state/fileTransaction.ts:63
                withPipelineMutation            pipelines/store.ts:1423
                withPipelineStartupAdmission    pipelines/store.ts:1450
12:48:24.095Z through 12:48:44.346Z
              95 complete SQL + JSON reads by competing admissions
              while the first admission still owns the lease
              reader-only sum 16,571.879 ms; each read 146.385–207.968 ms
              outer read also validates and revives pipeline records
12:48:44.346Z  competing caller's final complete read returns
12:48:44.390Z  first owner deletes its lease: hold 20,294.309 ms
              existing post-await mutation observer reports only 0.888 ms
12:48:44.403Z  next caller deletes its lease after a 1.223 ms hold
```

The acquisition stack's private instrumentation frames are omitted. Its timing is measured at the durable acquire/release boundaries. The existing `mutate()` observer begins after `await acquireLease()`, so it misses the first owner's delayed continuation. That explains why a callback-only hold log can report less than a millisecond while SQLite retains a lease for twenty seconds. The CPU profile from the first burst run contains `JSON.parse → readStateCollectionsRows → readCompletePipelineRecords → loadPipelinesForStartup → withPipelineStartupAdmission`, consistent with the original E6 profile.

The evidence-callback case follows the existing `pipelineStartupEvidence()` read pattern in `src/lib/runtime/startup.ts:1624`: `loadPipelinesForStartup()` and `pipelineRegistryHealth()` both run after admission. Thirty-two callbacks issue 64 additional complete reads after their 32 pre-admission reads. Back-to-back callback work produces an 18.620-second loop gap and a 27.068-second page TTFB. This case measures a second mechanism for combining subsecond reads into seconds of unresponsiveness.

The mixed-load driver runs two concurrent actual `sweepTaskFinishes()` calls, two ordinary CPU-admission lease callbacks, the real `FlowPipelineController` scheduling and scanner phase, four runtime request kinds, and overlapping page/files/pipelines/board loads. New synthetic transcript files arrive every 500 ms. Provider, Git, launch and destructive host operations are stubbed; the controller's pipelines callback exercises real controller-store admission. The complete production engine is outside this replay. The independent Unix runtime socket uses the actual socket server and client with a synthetic six-megabyte snapshot and inert append/session/effect answers. It isolates caller scheduling and transport. It does not reproduce production journal/consumer work or establish host-side cause.

| Completed mixed case | Rounds / HTTP concurrency | Loop gap, ms | Durable hold, ms | Longest page headers, ms | Longest files headers, ms |
| --- | --- | ---: | ---: | ---: | ---: |
| First 25-second run, without health reads | 36 / 8 | 2,218.781 | unmeasured | 3,241.328 | 3,671.039 |
| Repeated 25-second run, without health reads | 40 / 8 | 1,121.714 | 173.560 | unavailable after later gate kill | unavailable after later gate kill |
| Fresh 12-second run, with health reads | 24 / 4 | 528.364 | 302.146 | 461.090 | 1,015.203 |

The fresh health run records 24 requests each for `append`, `snapshot`, `session-read` and `effect-batch`, and no runtime timeout line. Completed results do not reproduce the thirty-second runtime timeout. The unfinished intervening health run hit the private gate's 8 GiB memory limit; its figures are excluded. The successful retry used a fresh Viewer and 12 GiB gate limit, so it is a resource/concurrency variant, not a before/after code comparison.

The first mixed run's largest gap covers approximately 12:45:20.966–12:45:23.194Z. Its CPU profile has 1,409 samples in that interval: 483 in parsing under compiled `r`, 291 in parsing under `bu`, and 259 in stringification under `r`. The deployed chunk's expressions map `r` to `diffFilesBodies()` (`src/lib/filesDelta.ts:154`) and `bu` to `withCurrentWriteHealth()` (`src/app/api/files/operatorProjection.ts:572`). The former parses both complete files-response bodies, compares values with `JSON.stringify()`, and serializes a delta; the latter parses a complete response for its storage-health overlay. These are additional measured main-thread costs during files reads. The 528 ms health-run gap likewise samples both complete pipeline health decoding and files delta construction. A sampled stack identifies work in an interval; the sample count is not an individual callback wall-time measurement.

The following explanations were tested or bounded:

- A browser-only failure is inconsistent with the independent HTTP timeouts in the handoff. This stage has no browser HAR or renderer trace and makes no browser-causality claim.
- DNS/TCP/TLS and SSH failure were excluded by the handoff's successful connection checks. The forwarded origin timeout also weakens an explanation confined to the public front door. Production transport was not retested here.
- Memory exhaustion lacks supporting evidence: the handoff reports about 100 GiB available memory. `/proc/meminfo` at 12:31:02Z reports 109,386,036 KiB available (104.32 GiB), while later measurements show lower Viewer RSS. The stage's own cgroup had no OOM events. This does not exclude garbage-collection or allocation cost inside the Viewer.
- Single cached registry/pipeline readers and individual process/fd scans did not reproduce seconds-long blocking at the copied size. The continuation establishes repeated full reads without a timer opportunity as one concrete seconds-long mechanism. Dirty refreshes and other controller callbacks remain possible historical contributors.
- Complete pipeline integrity/health reads are measured synchronous blockers, with exact stacks and a burst reproduction. Ordinary cached mutation waiters do not independently reread the complete archive: the 64-caller control finishes in 0.298 seconds. The full-read callers are essential to the reproduced long hold. Their incident-time frequency is absent.
- The 5.8-second snapshot-transfer metric includes asynchronous transport and caller scheduling. The live journal contains no corresponding multi-second `snapshot-parse` marker. That absence does not exclude uninstrumented serialization, allocation or combinations of callbacks.
- Synchronous Git provisioning had a prior measured stall and was made asynchronous afterward. The pinned `pipelines/engine.ts` and `pipelines/git.ts` have no `spawnSync` or `execSync` sites. Other synchronous locks and SQLite busy waits exist elsewhere and remain untested as incident triggers.
- Runtime-host delay remains possible. A timeout emitted by the Viewer does not distinguish a busy caller, a busy host, transport backpressure, or contention. The host's lower average CPU does not answer its incident-time longest gap. Its profiler was not attached.

The missing historical observation is a time-correlated callback/request trace covering the stalled Viewer and its lease owner. Retained backups give dimensions and acquisition timestamps, but cannot recover JavaScript stacks or in-flight promises. The later live `/proc/syscall` reading was refused with `EPERM` at 12:19:48Z. Even a successful reading then would have described a later instant. No historical request recording exists. The journal's 11:28:00–11:56:00Z text has 22 task-finish failure lines and six CPU-admission failure lines; it names blocked callers, while the owner operation and incoming HTTP rate remain unknown. Startup diagnostic absence is inconclusive because `LLV_QUIET_DIAGNOSTICS` can suppress that channel. The workload that made 11:30–11:50 worse remains a stated gap.

The build intent is concrete:

1. Remove synchronous complete pipeline/archive decoding from admitted request/startup evidence paths. Compute expensive evidence outside the web loop and outside admission, then validate the relevant revisions and authority in a short lease. Handle foreign writes, corrupt/opaque rows, file replacement and unsupported vocabulary without discarding ownership evidence. Ordinary request health reads also need to meet the loop budget. Preserve delivery keys, uncertain outcomes, ownership and grant revocation semantics.
2. Add a short-timer lateness monitor in the web process. For each gap over 500 ms, log the request or controller operation that ran during the interval, including completed operations whose work delayed the next tick. Retain bounded operation names and durations; emit no payload, user stack or identity. A shared histogram and a current-phase field that resets before the delayed tick cannot provide that attribution.
3. Log the operation name and duration for every pipelines lease held over one second. Measure from successful durable acquisition to release, including the pre-continuation interval demonstrated above. Callback-only timing is insufficient.

The measured files-body parsing/delta work remains a separate acceptance risk. If it keeps the mixed case above the 200 ms loop bound after archive removal, move that work to the existing owned projection worker or divide it with actual event-loop yields while preserving incremental files behavior. The monitor should identify it accurately. Deadline increases and recovery alone provide no prevention evidence.

Acceptance for the build stage is:

1. Reuse the measured admission-burst pattern (64 and 96 no-op startup admissions, 32 evidence callbacks) and the completed mixed-load case on the actual old and fixed code. Preserve the record dimensions, same machine/session, runtime, resource limits, request order and concurrency for each paired comparison. Record cold and warm behavior separately. The red old baseline already has a 20.513-second loop gap, a 20.294-second durable hold and a 20.684-second page TTFB.
2. Report before/after longest timer gap, longest durable lease hold, curl page TTFB and files/first-board-data TTFB. Target page and first data under one second, and no loop gap or pipelines hold above approximately 200 ms at production size. Preserve partial results and refused runs. Do not use the changed concurrency/memory variant as fixed-code evidence.
3. Test that the loop monitor names a deliberately blocking phase over 500 ms, including a phase that has returned before the delayed tick runs. Test that the lease monitor names an owner delayed before its `await` continuation and logs a hold over one second. Logs must contain bounded operation names and durations without payloads, user stacks or identities.
4. Drive runtime requests concurrently with the reproducing operation; distinguish caller-loop delay from host service time. Demonstrate that Viewer busyness in the fixed case cannot induce a thirty-second runtime timeout. This diagnosis has not yet reproduced such a timeout or established its historical host/caller split.
5. Preserve today's #2813 incremental Overview behavior, #2814 bounded MCP large-read retention, #2816 superseded-view/reader cleanup, and #2812 incremental grant redecision semantics. Those changes are in the pinned first-parent history; earlier reports cannot supply a before measurement for this task.
6. Run project checks for eventual touched files by explicit path using `bash scripts/gate-slot.sh bun test <file>` under private HOME, XDG, TMPDIR, state and gate locks. Retain rejection controls when candidate-gate paths change. Keep `src/lib/mcp/bindings.ts` untouched. UI changes need the existing rendered driver. Live agents, pending deliveries and user state remain protected; this handoff gives no rollout authority.

This documentation-only stage has a measured red isolated stall case. It has no fixed-code comparison, implementation test result, regression verdict for the four earlier changes, or production prevention verdict. No implementation/test file changed. Publication privacy and whitespace checks apply to the declared document.

For reproducibility, the evidence collection commands and bounds are:

```text
E0 — about 12:09–12:18Z, read-only history
  deployment_status({compact:true,limit:6})
  search_transcripts({query:'"event loop" "pipeline"',project:'delegatus',limit:3})
  search_transcripts({query:'"FileTransactionBusyError"',limit:3})
  search_transcripts({query:'"blocking" "pipeline state"',project:'delegatus',limit:3})
  search_transcripts({query:'"event loop" "proc"',limit:3})
  search_memory({query:'viewer hot path clones',project:<project key>,limit:3})
  search_memory({query:'pipeline stall',limit:3})
  search_memory({query:'registry synchronous delivery cache blocking',limit:3})
  conversation_messages({transcriptPath:<matched transcript>,limit:8,maxChars:2800})
  conversation_messages({transcriptPath:<handoff transcript>,since:'2026-10-13T11:40:00Z',limit:10,maxChars:1700})

E1 — captured 12:10:22.676–12:10:22.778Z; half-open journal range below
  journalctl --user -u delegatus.service \
    --since '2026-10-13 11:10:00 UTC' --until '2026-10-13 12:10:00 UTC' \
    -o json --no-pager
  Parse __REALTIME_TIMESTAMP; count each MESSAGE matching
    re.search('timeout|timed out|busy|exceeded.*deadline', message, re.I)
  Parse JSON after '[blocking-wait] '; group by site and synchronous.

E1b — captured about 12:19:48Z
  journalctl --user -u delegatus.service \
    --since '2026-10-13 12:10:00 UTC' --until '2026-10-13 12:19:00 UTC' \
    -o json --no-pager

E2 — initial reads 12:09:47–12:10:22Z; sampled 12:13:17.535–12:13:23.550Z
  systemctl --user show delegatus.service \
    -p MainPID -p ActiveState -p ControlGroup -p ExecMainStartTimestamp
  ps -eo pid,ppid,comm,pcpu,rss --sort=-pcpu
  readlink /proc/$WEB_PID/cwd; readlink /proc/$WEB_PID/exe
  Read /proc/$WEB_PID/{stat,status,io,cgroup,wchan}; same for $RUNTIME_PID.
  Enumerate /proc/$WEB_PID/fd and readlink its database descriptors.
  Whitelist only HOME, PORT, LLV_STATE_DIR, LLV_STATE_OWNER and runtime socket
    from /proc/$WEB_PID/environ; never emit its credential fields.
  Sample process stat and every task stat at 0.5-second intervals, twelve
    samples; compute utime+stime deltas with sysconf('SC_CLK_TCK').
  Read the current process and ancestor cpu.max/memory.max/memory.events.
  At 12:31:02Z: bun --version; read MemAvailable from /proc/meminfo.

E3 — sizing 12:11:46.342–12:11:46.692Z; private copies below
  sqlite3.connect('file:'+LIVE_STATE+'/state.sqlite?mode=ro',uri=True)
  execute('PRAGMA query_only=ON')
  SELECT collection,count(*),sum(length(value_json)),max(length(value_json))
    FROM state_rows GROUP BY collection;
  SELECT controller_active,count(*),sum(length(value_json))
    FROM state_rows WHERE collection='pipelines' GROUP BY 1;
  Same collection aggregate on registry_rows in agent-registry.sqlite.
  Source handles for both databases stay mode=ro/query_only.
  source.backup(private_destination,pages=128,sleep=.005)
    at 12:13:17.542–12:13:18.929Z, including git archive export.
  Read-only runtime-events source.backup(private_destination,pages=256,sleep=.01)
    at 12:16:54.459–12:16:55.206Z.
  Run the following on that one private runtime backup, with query_only=ON:
    SELECT ((created_at-:start)/600000),kind,count(*),sum(length(payload_json))
      FROM events WHERE created_at>=:start AND created_at<:end
      GROUP BY 1,2 ORDER BY 1,3 DESC;
    SELECT ((created_at-:start)/600000),count(*),
      round(avg((julianday(recorded_at)-julianday(occurred_at))*86400000),1),
      round(max((julianday(recorded_at)-julianday(occurred_at))*86400000),1)
      FROM events WHERE created_at>=:start AND created_at<:end GROUP BY 1;
    start=UTC epoch milliseconds of 11:10:00; end=UTC epoch milliseconds of 12:10:00.

E4 — 12:14:20.371–12:14:30.378Z, one read-only handle
  SELECT owner_pid,acquired_at FROM state_leases WHERE collection='pipelines';
  Repeat forty times at 250 ms; record wall timestamp with each answer.

E5 — 12:24:06.823–12:24:07.133Z
  Open backups/sqlite/state-2026-10-13T11-50-44-751Z.sqlite and
    agent-registry-2026-10-13T11-50-44-997Z.sqlite with mode=ro/query_only.
  SELECT collection,owner_pid,acquired_at FROM state_leases;
  Repeat the E3 size/controller aggregates on these retained backups.
  Inventory only the backups/sqlite directory to date retained generations.

E6 — isolated process 12:15:25.039–12:15:29.775Z
  Export source: git archive HEAD, extract into $PRIVATE/source.
  Resolve dependencies from $RELEASE/node_modules, used read-only.
  Delete leases only in the disposable copy, never in LIVE_STATE.
  With the private environment described above:
    bash scripts/gate-slot.sh bun --cpu-prof \
      --cpu-prof-name=reads.cpuprofile --cpu-prof-dir="$PRIVATE" audit-reads.ts

E7 — production-build runs 12:19:20.502–12:19:28.866Z and
  12:20:52.843–12:20:59.028Z, sequentially
  Copy $RELEASE/.next to a scratch build, excluding cache/trace/diagnostics.
  Generate the catalog with buildRegistryPerformanceDataset() at the counts above.
  Bind an independent socket to 127.0.0.1:0, read getsockname()[1], close it;
    start Next on that recorded free port. No existing listener is displaced.
  Defer lifecycle activation by a private viewer-release.json aimed at port 1.
  Initial run lacks release authority and fails board reads; corrected run uses
    LLV_VIEWER_DEPLOY_TARGET=$PRIVATE/absent-release-target.json, an absent private
    path, so scratch stores can initialize while lifecycle activation is deferred.
  Start through the owned gate runner:
    bun --cpu-prof --cpu-prof-name=next.cpuprofile --cpu-prof-dir="$PRIVATE" \
      --preload "$PRIVATE/source/src/runtime-host/candidateServerLoopProbe.ts" \
      --bun node_modules/.bin/next start --hostname 127.0.0.1 --port "$PORT"
  Use five concurrent Python urllib requests to '/', files summary, board,
    the unsupported pipelines query, and '/'; run cold then two warm batches.
  Ask the existing probe for its exact request-window readings by private files.

E8 — continuation setup 12:40:23.945Z; bursts at timeline bounds above
  deployment_status({compact:true,limit:3}) confirms the same deployed release.
  search_transcripts({project:'delegatus',query:'pipelines archive JSON.parse',limit:3})
  search_transcripts({query:'"pipeline state is busy" stall',order:'newest',limit:3})
  search_memory({project:'delegatus',query:'pipeline lease event loop',limit:3})
  search_memory({query:'pipeline startup starvation',limit:3})
  search_memory({query:'readStateCollectionsRows archive',limit:2})
  Open prior diagnosis with conversation_messages, then its tool-result page
    since 2026-10-13T12:24:00Z. All three memory searches returned no hits.
  Check earlier lease/starvation context against current acquireLease/mutate code.
  Read /proc/<serving PID>/environ for whitelisted state/port/home fields and
    readlink its database fd; inventory retained backup names only.
  Use the existing private read-only backup; trim/pad only its new private copy.
  Export HEAD with git archive into a new private source directory; copy the
    existing pinned .next build and use release dependencies read-only.
  Launch the driver under the private environment through:
    bash scripts/gate-slot.sh python3 "$PRIVATE/runner-v2.py"
  The driver records each Popen PID before proceeding. Each server port is
    bound at port 0 and read back; Next uses the recorded free port.
  Main web process:
    bun --cpu-prof --cpu-prof-name=replay.cpuprofile --cpu-prof-dir="$PRIVATE"       --preload "$PRIVATE/preload.ts"       --preload "$PRIVATE/source/src/runtime-host/candidateServerLoopProbe.ts"       --bun "$PRIVATE/built/node_modules/.bin/next" start "$PRIVATE/built"       --hostname 127.0.0.1 --port "$PORT"
  Each burst, in one control callback:
    await Promise.allSettled(Array.from({length:N}, () =>
      withPipelineStartupAdmission(async () => true)))
  Evidence-callback variant substitutes:
    async available => {
      if (available) { loadPipelinesForStartup(); pipelineRegistryHealth(); }
    }
  Concurrent probes: '/', '/api/files?view=summary', '/api/pipelines',
    '/api/board?project=repo-synthetic'. Curl measures:
    curl -sS --max-time 80 -o /dev/null       -w '%{http_code} %{time_starttransfer} %{time_total}' "$PRIVATE_URL/"
  Query loop and acquire/release traces after each burst; retain all timed reads.

E9 — mixed windows and cleanup bounded in the timeline
  Repeat every 250 ms when the loop permits, without waiting for prior work:
    two sweepTaskFinishes(), two withPipelineMutation() CPU polling callbacks,
    FlowPipelineController.tick() with private ports and real scanner,
    client.append(), client.snapshot(), client.readSession(), client.effectBatch().
  Run page/files/pipelines/board request batches with 8 concurrent requests;
    health retry uses 4. Write a new private transcript every 500 ms.
  Initial control listener's default idle timeout closes the 25-second answer;
    the workload trace still reaches completion. Repeat with idleTimeout:120.
  At 12:50:41Z, read-only journal confirms the second run's private gate OOM:
    journalctl --user --since '2026-10-13 12:49:20 UTC'       --until '2026-10-13 12:50:20 UTC' -o json --no-pager
  Successful fresh retry: LLV_GATE_MEM=12G, 12-second mixed window.
  Join CPU profile samples to the loop window using the recorded wall/monotonic
    clock pairs; inspect compiled expressions and corresponding pinned source.
  Stop only recorded owned PIDs, SIGTERM then bounded wait, SIGKILL if needed.
    The owned gate runner also ends its recorded descendants on gate failure.
  At 12:56:58.378Z, read /proc/<each recorded PID>/stat and check closed private
    sockets. All recorded identities are absent; all private ports are closed.
  Final document checks (after the last text edit):
    bun scripts/privacy-publication-gate.ts --require-known-values       --paths docs/investigations/viewer-load-stall-2026-10-13.md
    git diff --no-index --check /dev/null <declared document>
```


The source probe's executable body is reproduced below. It must only run in the private source export and private copied state described in E6:

```ts
const { agentRegistry } = await import("./src/lib/agent/registry");
const pipelines = await import("./src/lib/pipelines/store");
const { loadTasks } = await import("./src/lib/tasks/store");
const { procBackend } = await import("./src/lib/proc");
const registry = agentRegistry();
let gaps: number[] = [];
let last = performance.now();
const clock = setInterval(() => {
  const now = performance.now();
  gaps.push(now - last - 10);
  last = now;
}, 10);
const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
  fetch: () => new Response("private observation viewer") });
console.log(JSON.stringify({ pid: process.pid, port: server.port, at: new Date().toISOString() }));
const operations = {
  registry: () => registry.readOnlySnapshot(),
  pipelineStartup: () => pipelines.loadPipelinesForStartup(),
  pipelineSnapshot: () => pipelines.loadPipelines(),
  pipelineProjection: () => pipelines.loadPipelinesForProjection(),
  pipelineHealth: () => pipelines.pipelineRegistryHealth(),
  tasks: () => loadTasks(),
  processList: () => procBackend.listProcesses(),
  processParents: () => procBackend.ppidMap(),
  fdScan: () => {
    let count = 0;
    procBackend.scanFdTargetsUnder(process.env.HOME!, () => count++);
    return count;
  },
  pipelineAdmission: () => pipelines.withPipelineStartupAdmission(async () => null),
};
for (let round = 0; round < 3; round++) {
  for (const [name, operation] of Object.entries(operations)) {
    await Bun.sleep(30);
    const started = performance.now();
    await operation();
    const ms = performance.now() - started;
    await Bun.sleep(30);
    console.log(JSON.stringify({ name, round, ms, maxGap: Math.max(0, ...gaps),
      at: new Date().toISOString() }));
    gaps = [];
  }
}
clearInterval(clock);
server.stop(true);
process.exit(0);
```

For each probe, the launching environment was rebuilt from a whitelist of PATH, LANG, TZ and the systemd manager connection. HOME, TMPDIR, XDG_CONFIG_HOME, XDG_CACHE_HOME, LLV_STATE_DIR and LLV_GATE_LOCK_DIR all point into the recorded private root. Runtime socket paths are private and absent; LLV_VIEWER_CONTROL_URL is `http://127.0.0.1:1`, a closed endpoint. The Next seed has its own private home/state/config/temp/locks. Runtime events, the account controller and the reaper are disabled. The corrected Next seed contains invented identities and transcripts exclusively. Lifecycle activation stays deferred throughout that HTTP probe.

Each launch records its PID before waiting. The source probe exits normally and stops its port-0 listener. The two Next processes receive TERM only at their recorded PIDs; both are reaped. Each seed and gate wrapper is reaped. The owned runner contains and cleans up application worker descendants. At 12:22:53Z all recorded launch PIDs were absent from `/proc`; at 12:26:26Z a read-only process inventory found no remaining process with its working directory inside the recorded scratch root. No cleanup used a port, process name or matching command pattern. Scratch artifacts were retained under an owned private directory for local inspection.

Prior-context searches opened the handoff transcript and #2812's review discussion. They found earlier synchronous Git provisioning and registry snapshot investigations, which were checked against the pinned source. The registry review discussion records earlier measured warm bounds and a pre-existing grant edge-case; those historical results were not reused as this incident's measurements. The related report is [registry-snapshot-refresh.md](../verification/registry-snapshot-refresh.md), with [reproduction instructions](../verification/registry-snapshot-refresh-reproduction.md). Earlier source/handler profiling is in [viewer-hot-path-clones.md](viewer-hot-path-clones.md), and the provisioning investigation is [runtime-host-stall-profile-2026-09.md](../design/runtime-host-stall-profile-2026-09.md). No prior answer established this incident's exact blocking operation.

Decision requested: supply an incident workload/request capture for isolated replay, or accept that the cause remains unknown and leave the fix stage stopped. Isolated replay is recommended. This stage grants no deployment or restart authority.

Validation at 12:31:53Z: the required local privacy gate with committed known-value fingerprints passed for this explicit document path. A no-index whitespace check passed, and worktree status showed only this declared untracked output. No identity/home-path literal was found in a supplemental scan; a broad hostname substring probe matched the ordinary word “work.” and was checked manually. After factual rounding edits, these document checks were repeated before reporting the stage.


## Build verification, 2026-10-13

The build removes the reproduced admission burst by preparing a fresh SQLite
snapshot in short slices before taking the pipelines lease. Concurrent startup
callers share only an in-flight read. Admission checks both collection revisions
and database identity; changed evidence defers the callback. Each local startup
admission yields before acquiring its lease. Admitted readers receive independent
record copies, and the evidence cell is cleared on completion so inherited async
resources cannot retain or reuse an archive snapshot. Health reads retain issues;
healthy historical payloads are released after validation.

The existing files worker now returns write-health metadata and computes deltas
against the parent's certified base. This preserves delta continuity through a
discarded worker build and removes duplicate body parsing and comparison from the
web process. Result-file reads are asynchronous. Pipeline collection GET encodes
records in short slices with its original response shape and filters.

A further isolated profile traced a residual 391 ms gap to activity ingest:
`recordActivityFromIndexFeed → conversationResolver → AgentRegistry.readOnlySnapshot
→ rememberReadOnly → rememberColdProjections → SQLite .all`. This occurs when the
index encounters new transcript facts. A scoped activity reader now loads that
conversation's roles, aliases, receipts and delivery custody in one read-only
transaction. Provenance reads remain fresh. The original complete-snapshot
resolver remains available to its other callers. This change leaves stored
registry data and grant decisions untouched.

The Viewer logs overlapping named operations when its ten-millisecond timer is
more than 500 ms late, including operations completed before the delayed tick.
Names are grouped and bounded. Pipelines holds over one second are logged from
successful durable acquisition to successful release, including delay before the
first await continuation and a retried release. Induced tests exercise a returned
600 ms operation and a 1.1-second delay immediately after acquisition.

The final comparison used the pinned old implementation and the candidate in the
same session, on the same machine and Bun 1.4.0, sequentially. Both served a real
Next production build and its normal compiled projection worker. Each began from
the same private state seed and fresh synthetic transcript root. The pipeline
seed contains 304 hot and 500 archived records totaling 95,343,381 JSON characters;
these are the 804 incident-sized records after the diagnosis's settled-row move.
The catalog generator reports 37,471 rows, 121,702,694 payload bytes and 4,810
transcripts on both runs. Resource limits are identical: a private owned gate with
24 GiB memory, isolated HOME, XDG, TMPDIR, state and gate locks. No heavy checks ran
alongside either measured sample.

The driver retains the diagnosis's four bursts, then two 25-second mixed windows
with four concurrent HTTP requests. Each burst also issues snapshot, session-read,
effect-batch and append through the real Unix runtime client with its unchanged
30-second deadline. The independent socket server returns a six-megabyte snapshot
and inert answers. Curl measures `time_starttransfer` for the page and substantive
board data, `/api/files?view=summary`; the small membership-only board endpoint is
excluded from the first-data claim. Timer lateness and successful durable
acquire/delete boundaries are observed inside the web process. Diagnostic hooks
add no intentional delay. Values below are milliseconds, old → candidate.

| Workload | Longest loop gap | Longest durable hold | Page TTFB | Files TTFB | Runtime batch round trip |
| --- | ---: | ---: | ---: | ---: | ---: |
| 64 ordinary mutations | 135.230 → 119.760 | 131.790 → 125.227 | 158.139 → 165.837 | 392.051 → 325.776 | 300.503 → 248.405 |
| 64 startup admissions | 14,403.703 → 51.580 | 14,152.537 → 0.921 | 14,527.890 → 27.172 | 14,776.073 → 73.249 | 14,842.904 → 139.234 |
| 96 startup admissions | 20,487.717 → 51.638 | 20,251.873 → 0.846 | 20,632.501 → 25.369 | 20,664.677 → 73.278 | 20,712.959 → 267.559 |
| 32 evidence callbacks | 12,661.432 → 49.433 | 6,623.309 → 20.697 | 19,370.823 → 20.906 | 19,503.441 → 65.785 | 19,559.953 → 149.125 |
| Mixed, without health | 371.279 → 132.636 | 82.298 → 94.149 | 228.702 → 96.176 | 685.113 → 259.871 | See runtime counts below |
| Mixed, with health | 587.420 → 115.007 | 307.147 → 50.063 | 461.654 → 86.146 | 933.373 → 289.826 | See runtime counts below |

Every workload HTTP response is 200. An initial connection refusal during each
server's readiness polling is retained separately. Each burst observes its full
64, 96 or 32 durable acquisitions, with zero rejected admission promises. There
are 576 old and 740 candidate runtime requests, with zero runtime failures. Mixed
windows complete 87/53 old and 90/91 candidate rounds with unchanged scheduling
and concurrency. These bounded stress cases use synthetic concurrency. The
historical incoming request sequence remains unknown.

The old 96-admission case delays the first server-side runtime receipt by 20,565
ms after the caller's runtime phase starts; the candidate delays it by 25 ms.
Runtime handler callbacks themselves take under 0.012 ms in both samples. Those
callback timings exclude JSON serialization and socket I/O. The round-trip column
includes scheduling, transport and decoding. This separates the reproduced
caller-loop delay from handler execution without claiming a complete host service
time. The old replay does not induce a thirty-second timeout; the candidate's
longest burst runtime batch is 268 ms under the real thirty-second deadline.
Historical host/caller attribution remains unknown.

The failing-first startup test uses 305 hot and 499 archived synthetic records at
the incident's exact JSON-character totals. It fails on the old source with a
3,685.924 ms timer gap and passes on the candidate for 64/96 admissions and 32
evidence callbacks. The activity reproduction uses the production registry shape:
the old new-transcript path gives a 383.446 ms gap; the scoped path gives
11.266–25.398 ms in completed runs. Context/provenance comparisons cover registered
conversations and their delivery identities. Additional tests cover a new owner
committed while admission waits, fresh corruption without a revision bump,
unsupported ownership vocabulary, callback non-replay, independent copies,
inherited-context revocation, zero-wait admission, reader descriptor release and a
discarded worker delta base.

The fully uncached first files request remains **4,166.999 ms**, compared with
4,393.728 ms on the old code. Candidate Server-Timing reports 1,677.1 ms for the
initial scan and 2,102.9 ms for worker construction; these are sequential cold
costs outside the reproduced archive burst. The cold page answers in 253.107 ms
and storage health in 694.893 ms. Warm first-data and all measured workload loop
and lease budgets pass. The one-second requirement for a completely uncached
first-data miss remains an explicit acceptance question; this report does not
claim that criterion passes.

Earlier samples are retained as diagnosis and intermediate evidence. One 12 GiB
replay ended before completing its health window and is excluded from paired
results. A profiled intermediate candidate still had 564 ms admission-batch gaps
and 391–401 ms activity gaps; the final comparison includes the fixes for both.
All recorded parents in the completed paired runs were reaped by the owned
runner. Production received no test traffic, debugger, signal, restart or deploy.
Live agents, pending deliveries and user state remain untouched.

Production builds and MCP packaging pass. Explicit-path isolated checks cover the
pipeline store and compatibility suites, startup responsiveness, files worker and
route/delta behavior, activity ingest and cross-host provenance, SQLite reader
lifecycle, controller behavior, and the earlier #2812/#2814/#2816 registry and MCP
retention suites. The #2813 Overview model suites pass. Three assertions in the
startup suite fail on both the candidate and a fresh pinned baseline: delivered
Claude spawn recovery, delivered pipeline retry recovery, and deferred pipeline
receipt settlement. Their classifications and raw outputs are retained. They are
not new failures from this change. The cold-cache decision remains separate from
these baseline test failures.
