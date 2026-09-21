Source: orchestrator stage assignment, received 2026-09-21 (Europe/Kyiv). Originating requirement, verbatim:

> Runtime host stalls in bursts under six lanes: profile what blocks its event loop and rank the fixes
>
> Read-only diagnosis; the only output is docs/design/runtime-host-stall-profile-2026-09.md.
> Facts from production. The runtime host (one Bun process, src/runtime-host/main.ts) serves RPCs from the Viewer server over a socket with per-request timeouts. Under six concurrent agent lanes its callers log "runtime host request timed out" in bursts: one hour before the latest deploy had 169 append, 39 snapshot, 9 operation-status timeouts; the twelve minutes after deploying "acknowledge engine events after durable publication" (append acknowledgement 500 ms to 1 ms in tests, merged as PR 1946) still had 51 append and 10 snapshot timeouts, 49 of them inside four consecutive minutes while two pipelines were being created and their first agents spawned; the pipeline controller logged "pipelines phase exceeded its deadline" three times in the same minutes and structured delivery logged "host state sync failed". Between bursts the host is quiet; its average CPU is about 18 percent. So the ack path was one wait among several and something blocks the host's event loop or its SQLite for seconds at a time.
> Find it. Work from an isolated copy of a production-sized journal (copy the live journal file read-only into /var/tmp; never open the live file for writing, never signal or attach to the live host process). Drive a local host with a load generator that imitates the burst: several engine streams appending deltas, a snapshot poller, operation-status reads, and spawn of new sessions. Record event-loop delay (perf_hooks monitorEventLoopDelay or Bun's equivalent), per-RPC queue time versus service time, SQLite statement timing, and a CPU profile during a reproduced stall. Name each blocking operation with its file and line, its measured cost on the production-sized journal, and whether it is synchronous CPU, synchronous SQLite, a long transaction, compaction, snapshot rebuild, JSON serialization of large rows, or lock contention with the Viewer server process. Also check the caller side: whether the Viewer server's own event loop stalls (so the timeout fires though the host answered) — measure both sides.
> Deliver a ranked list of fixes with expected gain, file fence and risk for each, written so each can be one lane; mark which are already covered by open work (send latency slice 2: keyed admission read instead of global snapshot; close-before-teardown in the pipeline engine). State plainly what was measured and what is inference.
> Scratch under /var/tmp, removed after. No code changes, no commits except the declared output. Report through stage_report.

# Runtime host burst stall profile

Two sequential isolated burst runs reproduced the failures. The first emitted **9 append timeouts and 1 operation-status timeout**; the repeat emitted **10 append, 1 operation-status and 8 snapshot timeouts**. Thirteen synchronous snapshot rebuilds consumed **4,145 ms inside one 4,705 ms event-loop interval**. Host event-loop delay reached **4,695 ms**. Operation-status service itself stayed below **0.33 ms**: those requests waited behind other work.

A separate reproduction exercised the actual pipeline provisioning functions in the caller process. Two provisions blocked that event loop for **6,527 ms** in the sequential confirmation run. The host answered six operation-status probes promptly; their replies waited approximately **6,536 ms** before the caller consumed them. Synchronous Git therefore supplies a second, independent stall mechanism. Production's late timeout callbacks establish caller delay, although the historical logs cannot associate each timeout with an individual host response.

The next fixes should remove synchronous provisioning, the per-append checkpoint sweep, and unnecessary global snapshots; linear response framing is another small, measured target. PR 1946's acknowledgement change remains useful. It cannot yield an event loop occupied by synchronous SQL, parsing, or child-process waits.

## Evidence boundary and provenance

Measurements were made on 2026-09-21 local time. The worktree and freshly queried remote main both named `b0d1d1fb79c6951141b184f7f525cd31551bd333` at the initial pin. The inspected production host declared revision `c54d7cb73a84f1a0f4a93b87d5d0f903103a7ff5`. Comparing those revisions found **no differences** in `src/runtime-host/`, `src/lib/runtime/client.ts`, or `src/lib/pipelines/`. The interpreter was the production image's copied `bun-container` binary, **Bun 1.4.0**; the machine's default Bun was 1.3.3 and was excluded from the experiments.

The source journal and WAL were opened only as ordinary read-only files. A physical copy was accepted on the second attempt after file size, nanosecond modification time, and inode matched before and after copying both files. The key was copied privately without printing it. SQLite was first opened against the copy; `integrity_check` returned `ok`, and WAL checkpointing occurred only there. Every run started from that same captured database. This preserves a production-sized sample without opening a production SQLite writer or attaching a profiler to a live process.

| Captured population | Value |
| --- | ---: |
| Main database / WAL at capture | 319,971,328 / 8,796,232 bytes |
| Events / consumer checkpoints | 20,000 / 19,997 |
| Sessions / active metadata entries | 5,596 / 898 |
| Session JSON total / largest row | 204,943,770 / 498,261 characters |
| Edges / operations / outbox / producer receipts | 5,095 / 90 / 2,254 / 8,566 |
| Snapshot session count at experiment readiness | 1,026 |
| Full / summary serialized snapshot in the initial microbenchmark | 11,864,871 / 6,955,032 bytes |
| Metadata index ready / auto-vacuum | yes / incremental |

SQLite `length(TEXT)` supplied the character counts above; they are not UTF-8 byte counts. Snapshot sizes use `Buffer.byteLength`.

A fresh, bounded production log read for **2026-09-20 20:50:00–21:02:00 UTC** found 51 append, 10 snapshot, and 1 effect-batch timeout in the Viewer container. Append elapsed times were 3,000–11,622 ms; snapshot elapsed times were 10,000–16,603 ms. That read counted 54 timeouts in the four minute buckets 20:53–20:56, five pipeline deadline messages across the twelve-minute window, and three host-state-sync failures. The originating requirement's 49/four-minute and three-deadline counts remain attributed to its earlier observation; these exact window counts supersede neither its source nor its historical timing. The corresponding host log read contained no timeout lines.

The caller owns these timers (`src/lib/runtime/client.ts:265`). A 3,000 ms timer serviced at 11,622 ms establishes at least **8,622 ms of late callback service**. It supplies no host service-time measurement. The copied event tail covers 19:45:23–21:05:27 UTC. In 20:53–20:57 it contains 1,914 events, including 1,457 deltas and 367 items. Nonempty one-second buckets have p95 30 events and maximum 37. This grounds the rate envelope; it does not preserve RPC arrival order or snapshot requests.

## Prior work checked against this source

Project-scoped transcript searches used “runtime host request timed out,” “keyed admission,” “event loop journal,” and “pipeline synchronous fetch event loop.” Unscoped searches covered “close-before-teardown,” “consumer_checkpoints compaction,” and “byteLength snapshot.” The first guessed project key returned nothing; subsequent searches used the canonical project returned by a hit. Relevant conversations were read through `conversation_messages`.

- The September 20 snapshot-index review, final message at 14:40:35 UTC, reviewed `ab48413708646d08784bf6f22654db1389ea7524`. Current main includes its indexed metadata selection and resumable migration. The captured database's completion flag is set. Rebuilding the old JSON host-selection index would duplicate completed work.
- The September 20 send-latency slice 2 conversation, messages at 20:52:57 and 21:04:15 UTC, reports a keyed socket read at 7.97 ms p95 on its journal copy. That is prior-lane evidence, not a measurement from this experiment. PR **1963**, “Read one conversation during message admission,” was independently confirmed open at head `b3b58af2608936b6b0f82388118b4d48b84d4ed5`. Its source still scans the accumulated response frame with `Buffer.byteLength` and `indexOf`; its UTF-8 repair does not eliminate that cost.
- The open “Pipeline close persists and answers first, host teardown runs after, outside the collection lease” lane was confirmed running. Its review conversation discusses teardown identity and retry deduplication. That work owns closing and teardown; provisioning's synchronous Git pre-pass remains a separate path on this main.
- A July provisioning conversation had already raised synchronous network fetch. Current main adds a 60-second child bound and moves provisioning outside the collection lease. `realExec` still uses `spawnSync`, and `provisionPendingPipelines` still loops synchronously. The earlier warning remains applicable at that narrower event-loop boundary.
- No relevant prior solution for the checkpoint-sweep or accumulated-frame scanning mechanisms was found. Unrelated search matches supplied no basis for a fix.

## Reproduction and timing definitions

The host ran the real `src/runtime-host/main.ts`, journal, consumers, socket server, receipt timer, and metadata code from an exported tree. Deployment listeners and the legacy scheduler were disabled. State, config, home, journal, socket, fence and temp roots were isolated. Consumers saw empty local flow/task stores. The independent Bun caller imported the production `UnixRuntimeHostClient` and, in the provisioning experiment, the production Git provisioning functions. This measures the Viewer's actual caller and provisioning code in a controlled process; a complete Next.js server, browser, provider CLI, and production registry were not reproduced.

Six streams each awaited an engine-shaped delta append, then slept 500 ms in the six-second warm phase and 100 ms in the eighteen-second burst phase. A summary snapshot poller slept 1,000/250 ms after each response; an operation-status poller slept 250 ms. Two concurrent launch sequences each created three sessions through real spawn commands, published hosted status, and read operation status. They read full snapshots around admission. Engine execution was represented by those local session publications; no paid provider turn was started.

The decisive run added twelve alternating append/snapshot pairs once, at burst onset, split over the six session identities and alternating full/summary snapshots. Interleaving mutations invalidates cached snapshots. This is a controlled burst envelope, not a recovered production request trace. It contains more concentrated snapshot traffic than can be established from production logs. An additional eight-identical-summary surge tested cache reuse. A control removed all snapshots after the initial readiness read while retaining deltas, status reads and session creation.

Instrumentation lived exclusively in scratch:

1. `monitorEventLoopDelay({resolution: 10})` in each process, reset every 100 ms, plus actual interval spacing. Reported histogram maxima are event-loop-delay values; interval gaps include the scheduled 100 ms.
2. Request IDs joined caller start/write/finish, host `handle` entry/return, and the call to `socket.end`. Both processes used `performance.timeOrigin + performance.now()` on the same machine.
3. SQLite `get`, `all`, `run`, and `exec`, plus journal method boundaries, were timed synchronously. Aggregates retained every call; detailed spans retained calls over 2 ms. No SQL parameters, event bodies, keys or identities were published.
4. Both processes ran with `--cpu-prof`, using its default 1,000-microsecond sampling interval. Sample summaries below restrict timestamps to readiness through final drain, excluding startup and initial snapshot. Native leaf frames were attributed through their enclosing JavaScript stack.

**Queue definition:** caller socket-write to host `handle` entry measures transport plus waiting for host dispatch. Kernel arrival is uninstrumented, so this is an upper bound on pure host queue time. Caller-start to dispatch additionally includes caller scheduling and connect delay. Host service is `handle` entry to its returned promise settling; it includes any consumer wait. Post-write time begins at the host's call to `socket.end`; it includes socket backpressure, scheduling, decoding and parsing, and does not assert that the kernel had delivered the entire frame. Timed-out requests are excluded from successful post-write statistics.

## Measured results

The interleaved run lasted 28.07 seconds including drain. All times below are milliseconds. Percentiles use sorted index `min(n - 1, floor(p * n))`, with small sample counts shown explicitly; they are descriptive, not confidence intervals.

| RPC | Count | Write-to-dispatch p95 / max | Service p95 / max | Caller elapsed p95 / max | Timeouts |
| --- | ---: | ---: | ---: | ---: | ---: |
| append | 354 | 1,968.9 / 4,587.6 | 26.94 / 41.13 | 1,985.2 / 3,000.3 | 9 |
| operation-status | 52 | 760.0 / 4,599.1 | 0.211 / 0.323 | 760.3 / 3,000.1 | 1 |
| spawn command | 6 | 33.23 / 33.23 | 32.18 / 32.18 | 78.80 / 78.80 | 0 |
| snapshot | 35 | 4,412.2 / 4,696.2 | 454.5 / 676.8 | 9,639.2 / 9,668.3 | 0 |

All six spawn commands in the decisive campaign were admitted with queued receipts. Some mutating calls were dispatched after their callers' deadlines and still committed, consistent with the journal's idempotent completion contract. Retry design must retain their original keys.

Host delay max was **4,694.7 ms**, versus **128.8 ms** in the caller. Within the longest 4,704.7 ms interval, thirteen `snapshotJson` spans account for 4,145.3 ms. The host executed consecutive synchronous callbacks without a timer opportunity between them. An individual snapshot need not take three seconds to produce a three-second append timeout.

The unchanged repeated interleaved workload produced **10 append, 1 operation-status and 8 snapshot timeouts** in 29.39 seconds. Host delay reached **5,533 ms**; caller delay reached **147.6 ms**. Append write-to-dispatch max was **5,593 ms**, versus service max **46.92 ms**. Snapshot p95 reached **10,085.8 ms**. Eight snapshot handlers in the repeat had called `socket.end` **4.55–9.74 seconds before** their callers timed out. That marks the start of response writing; it does not prove full delivery to the caller. Thus the timeout mechanism reproduced twice, including snapshot failures. The shared machine continued running its other workloads; run-to-run variation is expected.

The ordinary mixed run had zero timeouts but append p95 **695.7 ms**, snapshot p95 **5,217.3 ms**, and host delay max **904.7 ms**. The eight-summary surge reached host delay **2,903.5 ms** and snapshot p95 **6,519.4 ms**, also without emitted timeouts. Quiet success therefore does not reject the burst mechanism.

The sequential no-snapshot control completed **960 appends** with p95 **37.36 ms**, operation-status p95 **59.41 ms**, host delay max **88.45 ms**, and caller delay max **16.75 ms**. It delivered more appends because streams were backpressured by acknowledgements. This isolates the substantial snapshot contribution; it is not a fixed-throughput estimate of the gain from PR 1963. An earlier no-snapshot run overlapped an exploratory provisioning run and is excluded from the principal comparison.

### Caller provisioning

`provisionPendingPipelines` calls `provisionPipelineOutsideLease` for every pending lane synchronously (`src/lib/pipelines/engine.ts:3924`, `:3960`, invoked at `:4827`). `resolvePipelineBase` fetches through the synchronous exec port (`src/lib/pipelines/git.ts:86`), and worktree creation follows at `:106`. `realExec` calls `spawnSync` at `src/lib/workflows/provision.ts:30`. Being outside a lease does not create another event loop.

Two disposable Git clones, with public HTTPS fetches and worktrees entirely in scratch, exercised these real functions without creating a pipeline. First fetches took **6,975.6 ms** and **5,233.0 ms**; warm second fetches took **521.0 ms** and **519.5 ms**. Individual worktree additions took **340.3–431.7 ms**. The confirmation run executed alone: caller delay max **6,527.4 ms**, host delay max **651.1 ms**. Six status replies completed in about **6,540 ms** despite host service below **0.41 ms**. Their host-write-to-caller-finish interval was about **6,536 ms**.

Those status probes succeeded: Bun serviced their readable sockets before their expired timer callbacks. Thus the experiment proves blocked caller response handling, and demonstrates why a nominal timeout is not a hard wall-clock bound. It does **not** prove that any particular historical timeout fired after a host answer. The interleaved run's ten actual timeouts occurred before host answers. Production attribution beyond these two proven mechanisms remains inference.

Network fetch duration varies. The measured seconds are wall time synchronously held on the caller's event loop, with the child performing Git/network work; they are not seconds of JavaScript computation. Moving the fetch to a Promise callback alone preserves the block. The controller's `Promise.race` deadline (`src/lib/pipelines/controller.ts:246–269`) cannot preempt synchronous work either.

### Operations responsible for the cost

| Operation and source fence | Classification | Cost on this journal |
| --- | --- | --- |
| `snapshotJson` / `snapshotAt`, `src/runtime-host/journal.ts:1083`, `:1035` | Snapshot rebuild; synchronous SQLite and JavaScript inside a read transaction, then serialization | Interleaved uncached rebuild p50 **381.5**, p95 **454.4**, max **676.7 ms**, 32 spans. In the separate summary surge one rebuild reached **1,546 ms** |
| `snapshotSessionValues`, `journal.ts:2580–2602` | SQLite summary JSON transformation followed by `JSON.parse` of selected large rows | Interleaved p50 **298.6**, p95 **360.3**, max **541.1 ms**. Active summary SQL alone p50 **177.5**, max **301.0 ms** |
| Global cache invalidation, `journal.ts:1085–1097` | Every ordinary database mutation invalidates the serialized representation | 32 expensive rebuilds for 35 snapshot requests in the interleaved run. Already-indexed selection does not avoid rebuilding selected bodies |
| Checkpoint anti-join, `journal.ts:1637`, called by append at `:438` | Synchronous SQLite scan during compaction write transaction | **360 scans**, p50 **9.29**, p95 **14.55**, max **26.98 ms**, **3,625 ms total**. Entire compaction p50 **11.75**, p95 **19.77 ms** |
| Delta projection, `journal.ts:2401`, keyed entity read at `:2571`, stable serialization/write at `:2702` | Synchronous JSON parsing, stable serialization and SQLite entity rewrite, including metadata triggers | Initial 72-append microbenchmark: projection p50 **1.34**, p95 **3.19 ms**; upsert p50 **0.71**, p95 **1.88 ms**. A contributor, with much less measured cost than snapshot and checkpoint work |
| Snapshot frame accumulation, `src/lib/runtime/client.ts:285–290` | Synchronous CPU; repeated whole-frame byte counting, delimiter scanning, final parse | Interleaved per-snapshot accumulated frame work p50 **237.1**, p95 **353.4 ms**; final parse p50 **23.56**, p95 **31.06 ms**. Costs accrue over many callbacks |
| Producer receipt maintenance, `journal.ts:1692`, `:1733`; timer `src/runtime-host/main.ts:271` | Bounded row sweep followed by synchronous incremental vacuum | Initial pass **38.75 ms**. Separate summary surge: largest maintenance call **548.3 ms**, including **415.7 ms** in `PRAGMA incremental_vacuum(2048)` |
| SQLite commit / writer admission | Synchronous SQLite durability and possible writer lock | No measured `BEGIN IMMEDIATE` span exceeded **2 ms** after readiness in the reported campaigns. Maximum observed `COMMIT` in the summary surge **16.84 ms**; no multi-second SQLite busy wait was observed |

Inclusive method spans overlap; do not add the table's totals. A snapshot read transaction remains open through row parsing and projection construction. The expensive compaction scan occurs inside `BEGIN IMMEDIATE`/`COMMIT`. Its repeated cost matters even when each write transaction is short.

The captured database has incremental auto-vacuum enabled. The ten-second receipt timer still invokes synchronous incremental vacuum on the host connection. The separately spawned hourly vacuum in `main.ts` does not remove this call. Its measured 416 ms exposure can amplify a burst; the campaign does not establish that it ran during production's four-minute incident.

### CPU profiles and small counterfactuals

The interleaved host profile contains **17,113 samples** during the measured window. Stack attribution assigns **7,725** to session selection/parsing, **2,726** to the rest of snapshot construction/serialization, **4,228** to compaction, **486** to projection, and **194** to consumer completion. Snapshot stacks account for **61.1%** and compaction for **24.7%** of these samples. Native SQLite `all`/`run` and JavaScript `parse`/`stringify` dominate those stacks. These are sampler shares, not whole-machine CPU percentages.

The caller profile contains **8,067 samples**: **6,117 (75.8%)** are in `Buffer.byteLength`, reached from the response data callback; 831 are in JSON parsing. The provisioning confirmation instead includes 6,228 samples in native `spawnSync` leaves, corroborating the timed synchronous child waits. Sampling can attribute native waiting time and must not be read as CPU utilization.

Two isolated comparisons identify cheaper mechanisms without changing product source:

- On the same 19,997-checkpoint copy, 30 rollback-wrapped trials measured the current orphan sweep at **8.830 ms p50 / 9.356 ms p95**. Deleting checkpoints by event IDs selected from the retiring sequence range, **before deleting those events in the same transaction**, measured **0.0062 / 0.0994 ms** for one retiring event. `EXPLAIN QUERY PLAN` changed from a checkpoint-table scan plus correlated lookups to indexed event-range selection and checkpoint-key lookups. This proves query cost, not complete replacement semantics; existing orphan checkpoints still need bounded cleanup.
- A 14,743,110-byte frame assembled from 350 copied session rows was split into 64 KiB buffers. Ten trials of accumulated-string rescanning measured **1,405 / 1,864 ms p50/p95**. Counting incoming buffer bytes, scanning each buffer once and concatenating once measured **13.41 / 23.93 ms**. This microbenchmark uses a constructed corpus frame, excludes final JSON parsing, and is not a socket latency claim.

A separate SQLite WAL probe used two connections to the copy and thirty real committed metadata updates per condition, confined to its disposable database. Writer p50 was **0.695 ms** without a reader and **0.696 ms** with a read transaction held open; the latter maximum was **0.993 ms**. This probe used Python SQLite. An attempted Bun version of this small lock probe failed with “SQL statements in progress” and supplies no contention verdict; the production Bun host campaigns above did complete normally.

Production inspection found the host's writable journal descriptors. The Viewer root process and a bounded sample of its descendants had no journal descriptors at observation time. Current `deploymentLedger.ts:35–47` opens its journal view read-only; registry writes use a different database. These observations and the WAL probe supply **no evidence of Viewer/host writer-lock contention**. Transient readers, disk contention and an unobserved external writer cannot be ruled out by this sample. No live lock or live event-loop instrumentation was installed.

## Ranked implementation lanes

Expected gains below are scoped to measured work. They overlap and must not be summed into an end-to-end promise.

| Rank and owner boundary | Change and expected gain | File fence | Risk and acceptance |
| --- | --- | --- | --- |
| **1. Make pipeline provisioning asynchronous**; new work, coordinate with close lane | Replace the provisioning path's synchronous fetch/worktree execution with asynchronous child processes. Release **5.2–7.0 s of fetch wait** and **0.34–0.43 s per checkout** from the caller loop in these trials. Keep the existing timeout and exact-base semantics | `src/lib/pipelines/git.ts` provisioning helpers; `src/lib/pipelines/engine.ts` pre-pass/call site; focused tests. Add a provisioning-specific async port; avoid converting every `ExecPort` user | Medium: cancellation, duplicate provisioning, and stale results. Preserve outside-lease execution and revalidate the existing provision fence before applying results. With two delayed Git children, independent status/append RPCs must meet existing deadlines and only the current owner may apply outcomes |
| **2. Bound checkpoint deletion to retiring events**; new work | Delete checkpoints via the retiring event range before deleting events; retain an incremental orphan cleanup path. Remove roughly **9–14 ms per append** from the measured sweep. At 30 appends/s this is about **0.27–0.42 s of loop occupancy per second**, before other costs | `src/runtime-host/journal.ts` compaction and its focused journal/retention tests | Medium: hash-chain anchor, slowest-consumer retention, old orphan rows, projection holds and native-queue holds. Prove identical surviving rows at each boundary; retain crash atomicity. Do not disable durability or skip compaction |
| **3. Land keyed admission reads**; **already owned by send-latency slice 2 / PR 1963** | Remove avoidable global reads from admission and refresh paths. The no-snapshot control reduced append p95 from hundreds of ms to **37.36 ms**, demonstrating direction and capacity benefit. Actual slice gain requires its narrower workload | Existing lane owns `contracts.ts`, `client.ts`, `host.ts`, `journal.ts`, structured delivery/admission and indexed registry access | Medium: target semantics, host compatibility and receipts. Reuse the existing lane; preserve its full/keyed equivalence evidence. Global bootstrap and controller-wide recovery still need snapshots |
| **4. Make response framing linear**; new work after coordinating PR 1963's client change | Count received bytes incrementally, find delimiters only in new bytes, assemble/decode once. Remove repeated scans that consumed **75.8% of caller samples** here. Microbenchmark frame handling fell **1,864 → 23.93 ms p95** | `src/lib/runtime/client.ts` and focused transport tests | Medium: UTF-8 split boundaries, response cap, cancellation, malformed frames and one-response semantics. Preserve PR 1963's UTF-8 correction. Native buffers/decoder suffice; no parsing library is needed. Validate under fragmented multi-MB responses and concurrent small RPCs |
| **5. Reuse unchanged session projections in global snapshots**; new work, sequence after journal lanes | Cache bounded full/summary session projections by durable entity revision and reuse serialization for unchanged rows. Target the measured **299 ms median session projection** and **381 ms median uncached snapshot**. Proceed only if global reads still miss the required latency after ranks 2–4; measure residual assembly cost before promising a bound | `src/runtime-host/journal.ts`, existing snapshot/metadata tests; `journalSessionMetadata.ts` only if its revision facts are insufficient | Medium/high: retained session limits, voice scope, terminal-edge expiry, ordering and an atomic snapshot sequence. Preserve all current wire semantics. Start with in-memory reuse; a persistent extra projection table needs separate evidence. Stress writes between reads and compare full results with uncached behavior |
| **6. Remove synchronous vacuum from receipt ticks**; new work | Route reclamation through the existing maintenance worker or small scheduled chunks after measuring each step. Remove the observed **416 ms** vacuum call from host socket service; retain row deletion independently | `src/runtime-host/journal.ts:1692–1733`, `src/runtime-host/main.ts` maintenance scheduling, `journalVacuum.ts` only as needed | Medium: worker-held writer locks can move the same stall back to `BEGIN IMMEDIATE`. Require nonblocking admission, bounded steps, one owner and foreground RPC measurements during reclamation. Do not introduce a second uncoordinated vacuum scheduler |

**Already covered separately:** close-before-teardown makes close persistence and response independent of host shutdown, outside the collection lease. It can reduce controller/lease delays, but none of these reproductions executed close, so no numerical gain is assigned here. Both that lane and rank 1 touch `engine.ts`; integrate serially around their separate close and provisioning regions. Journal ranks 2, 3 and 5 also need ordered integration. Independent lane scope does not imply conflict-free simultaneous edits.

Each lane should retain one focused behavioral regression and rerun the mixed workload on an isolated journal with the same production deadlines. Report host delay, caller delay, queue proxy, service time and response bytes separately. A quiet all-green run alone does not satisfy the burst regression. For rank 1, native child waits must be present during the check; for ranks 2/5/6, the journal must be at its retention limit with consumers and receipt maintenance active.

## Deferred — not currently justified

- A generic runtime-host worker pool, replacement database, RPC broker, or new profiling framework. The measured source sites support smaller changes first.
- Increasing the 3-second and 10-second deadlines. This preserves the blocking work and prolongs uncertain outcomes.
- Disabling `synchronous=FULL`, moving all writes to a long transaction, or dropping the slow-consumer retention obligation. No durability trade-off is justified by these measurements.
- Another host-selection index migration. That work is already present and ready in the captured database.
- Broad snapshot pagination or a new snapshot wire protocol. Land keyed admission and linear framing, then measure remaining bootstrap cost before changing clients.
- Treating pipeline closing as the cause of this capture. Its open lane addresses a different, legitimate wait; the local stall was reproduced without closing a pipeline.
- Attributing every historical timeout to one mechanism. Production has no joined send/dispatch/reply trace; the requirement prohibits live attachment. The report establishes concrete reproducible blockers and ranks fixes without fabricating historical per-request attribution.

## Requirement check and cleanup

The original requirement is served by a production-sized read-only capture, a real local host, mixed six-stream/session-creation traffic, actual timeout reproduction, host and caller event-loop measurements, per-RPC dispatch/service boundaries, SQL timings, and CPU profiles during the reproduced stall. The caller experiment uses real Viewer modules in an isolated process; full Next.js orchestration and provider execution are outside the measured boundary. All historical attribution and expected production gains are explicitly identified as inference.

No hard-to-reverse decision is selected, so no ADR is needed. The proposed scope is six bounded lanes, two coordinated with existing work; a general concurrency redesign is deferred. This stage makes no product-source change and no commit, staging, push, service restart or production mutation. Only this document is a repository output.

Cleanup verified: every recorded child PID had exited before removal. The private scratch tree, journal/key copies, exported source, disposable Git clones/worktrees, trace files and CPU profiles were removed. Aggregate evidence and reproduction parameters remain in this document. Final worktree inspection showed this document as the only added or modified repository path. No files were staged and HEAD remained at the pinned revision.
