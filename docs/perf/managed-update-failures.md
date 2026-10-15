> Operator-authorized request 2026-10-15 ~11:10Z (SSH + API handoff, marker codex-remote-artifact-and-local-update-20261015-v1): the operator's LOCAL desktop managed Docker installation cannot complete its update; the local session handles that machine's recovery itself. This lane owns the product bug investigation and fix, working only in this repository and isolated environments on this machine. No deployment from this lane, no contact with the operator's local installation, no credential or global-update changes; preserve existing performance gates (do not loosen a gate to pass).

Source: originating requirement supplied in the pinned specification, 2026-10-15. The diagnosis below records the initial read-only stage. The implementation and verification section records the subsequent fix on this branch. Historical file:line references remain tied to the audited revision.

Additional source: operator-local evidence relay `local-adoption-census-20261015-v1`, received during this stage. Its new authorized deployment targets the audited main revision; this lane performs no deployment. Its capabilities response remains HTTP 503, startup failed in “recovering pending spawns”, 2/2 hosts, category timeout; phase began at 10:36:56Z and failure was reported at 10:44:38Z. These are supplied observations, without a local CPU trace.

Later relay, 2026-10-15 11:28Z: the local deployment to audited main passed candidate runtime-host, MCP and performance gates at unchanged thresholds, and promoted its web at 11:28:24Z. Post-promotion verification was then in “refreshing transcripts”; pending-spawn adoption and runtime-host handoff had not finished. This is one passing candidate run under the then-current load. It establishes neither durable first-boot margin nor completed adoption, rollback or handoff. Those post-promotion paths remain the primary unresolved local outcome.

# Managed Docker update failures

Audited main: `b1fa2f91a22ad9785239eee372bf4fe9b5780f8c`. Remote main matched at the initial check. File:line references below name that revision.

The four symptoms have connected causes. Startup still does work proportional to retained launch history. Rollback joins that startup before acknowledging a fence. The first-boot performance check measures a separate, synchronous registry initialization path. Update status combines durable intentions, cached checks and process observations, with two places where intentions are presented as outcomes.

## Evidence and prior work

The desktop facts below come from the originating handoff. This lane neither contacted that installation nor inspected its state.

| Supplied observation | What it establishes |
| --- | --- |
| Serving web `8f2db43e`, runtime host `d4777236` | Component revisions differ. A single installation revision would conceal that state. |
| First attempt: 300 s at “adoption 2 of 2 - recovering pending spawns”; rollback acknowledgement missed 30,000 ms | The host-adoption count had completed; the larger startup pass had not. The subsequent rollback lacked a checkpoint acknowledgement. |
| Second attempt: first-boot loop maximum 1048 ms against 1000 ms; other gates passed | A correctly enforced first-boot rejection. The aggregate maximum alone does not identify its stack or interval. |
| Runtime RPC p95 21.7 ms, maximum 361 ms, zero failures; 4/4 workers preserved; adoption 3025 ms; browser server loop maximum 328.5 ms; no SQLite busy | These concern other measured windows. They do not explain or invalidate the first-boot breach. |
| About 6.9 GiB free of 31 GiB | Supplied capacity context. There is no evidence here of an OOM or a storage-bandwidth cause. |
| Later census: registry file 335,949,824 bytes; 10,971 receipts, 11,870 conversations, 8,428 entries, 14,218 delivery owners and 666 held-delivery rows | The desktop's retained history exceeds the existing default gate fixture. Receipt mix: 8,796 completed structured, 1,008 completed legacy, 892 failed structured, 122 failed legacy, 133 conflicted and 20 other receipts. The last 20 states were not individually counted in the relay. |

Prior work was searched through Delegatus `search_transcripts` using project-scoped adoption/quiescence, the exact pending-spawns phase, and quoted first-boot terms, then unscoped rollback/quiescence and deployment terms. Relevant hits were opened with `conversation_messages`. Some search terms were ignored by the index; those broad matches were treated as pointers. Memory searches for deployment/adoption/quiescence returned nothing relevant; an opened older runtime-performance memory concerned summary projections and established no cause for these failures. Private transcript locations and incident identities are omitted.

The following public work was read through `gh` and checked against current code:

- [Startup recovery and rollback, #1556](https://github.com/Latand/delegatus/pull/1556): bounded concurrency and joining startup before retirement addressed real races. Its final qualification explicitly left incumbent rollback broken. Its title is not evidence of successful rollback.
- [Settled-handoff startup and promoted verification, #1975](https://github.com/Latand/delegatus/pull/1975): fixed inconsistent host eligibility and introduced a 300 s promoted-verification bound. Current code additionally extends genuinely new phases, with a 20-minute overall ceiling.
- [Foreground spawn recovery fence, #2688](https://github.com/Latand/delegatus/pull/2688): a prior transcript, dated 2026-10-10 17:06Z, reproduced recovery failing a launch after foreground publication. Current `structuredSpawn.ts:1453` rereads the receipt and `:1500` crosses the atomic recovery fence. Preserve this protection.
- [Retained owner/adoption reads, #2831](https://github.com/Latand/delegatus/pull/2831): narrows owner discovery and pipeline adoption projections. It does not remove the separate failed-receipt reconciliation at `structuredSpawn.ts:1418`.
- [State lock waits, #2916](https://github.com/Latand/delegatus/pull/2916), merged as `f4dc29d2`, and [saved board startup, #2919](https://github.com/Latand/delegatus/pull/2919), merged as `50ff530f`, are already ancestors of both audited main and the supplied serving web `8f2db43e`.
- [Pipeline watchdog cloning, #2929](https://github.com/Latand/delegatus/issues/2929) is a separate open defect assigned to lane `1f53cb2f`. Its recurring 50 ms mutable pipeline snapshot can starve Viewer timers and sockets. This lane must leave its call sites to that owner.

Open PR files were inventoried before choosing changes. [#2930](https://github.com/Latand/delegatus/pull/2930) changes MCP transport metadata in `structuredSpawn.ts`; [#2931](https://github.com/Latand/delegatus/pull/2931) replaces the failed-notice repair block at the beginning of `terminalizeStaleStructuredSpawns`. Their actual patches were read. That repair block belongs to lane `e8711245`; use its reporting obligation instead of redesigning it here. [#2922](https://github.com/Latand/delegatus/pull/2922) owns approval recovery and touches startup/controller code; [#2921](https://github.com/Latand/delegatus/pull/2921) also changes startup for account recovery. Reconcile shared interfaces without absorbing those features.

## 1. Post-promotion adoption stalls in pending-spawn recovery

### Cause on main

`src/lib/runtime/startup.ts:2405` obtains pipeline evidence, checks fenced pending receipts, and at `:2410` awaits `recoverPendingStructuredSpawns`. Counts were advanced by the Codex/Claude adopters at `:2162` and `:2218`. “2 of 2” counts hosts, and says nothing about the remaining receipt work.

`src/lib/runtime/structuredSpawn.ts:1376` does all of the following before returning:

1. Runs the stale-launch reaper (`:1385`). Its actuation cap is 50 (`:763`, `:1006`), but that cap does not apply to the following recovery loops.
2. Reads pending spawn outbox effects from sequence zero in pages of 100 (`:1387`). The cursor must advance, but there is no fixed upper watermark, page budget or overall deadline. These are pending effects, not a scan of every delivered effect: `src/runtime-host/journal.ts:1952` applies that filter.
3. Materializes every receipt, including cold history, and groups every structured failed receipt by conversation (`structuredSpawn.ts:1417`). `forEachStartupBatch` runs 16 groups concurrently, then yields; receipts within one conversation remain serial (`:1426`, `src/lib/runtime/startupWork.ts:3`).
4. Reconciles each failed receipt with two operation reads and a session read (`structuredSpawn.ts:602`), followed by another registering-session check (`:1439`). It then loops over all receipts again (`:1453`); supersedence checks can enumerate the collection again (`:1360`). Historical snapshot fallback is shared where used, but current keyed clients still pay the repeated per-receipt RPCs.

Ordinary RPC deadlines are 10 s; snapshot deadlines are 30 s (`src/lib/runtime/deadlines.ts:9`, `:13`). They bound individual calls when the event loop can run timers. They do not bound this complete pass. For illustration, 256 independent failed receipts in 16 groups can consume roughly 16 × 20 s when the initial RPC group and the subsequent session read each consume 10 s. This is a worst-case budget calculation, not an observed desktop duration. Concentrated history in one conversation is even more serial.

The startup abort is checked at boundaries; it is not passed to these RPCs. `client.ts:255` and operation reads expose no abort parameter. Individual client timers also run on the loaded Viewer loop (`:362`).

The relay's proposed O(receipts × snapshot-rebuild) cause needs qualification. `registry.ts:5504` delegates to the cached SQLite view, and `sqliteRegistryStore.ts:1180` returns it while revision/stamp stand. A census-sized profile below made 11,866 snapshot calls but only one complete snapshot load. Repeated calls add per-receipt revision/stamp/read overhead; writes or replacement can invalidate that view. Do not label every iteration a full collection copy. A separate demonstrated copy path exists when a superseded launch reaches the atomic recovery fence: `structuredSpawn.ts:1471` calls `supersededQueuedSpawnReason` inside the mutation, whose `Object.values` at `:1360` reaches mutable proxy `keys`/`loadAllRows` (`sqliteRegistryStore.ts:3150`, `:3176`) and clones receipt rows. Both paths should use narrow indexed authority reads.

The readiness dependency is real: `src/app/api/runtime/deployments/capabilities/v1/route.ts:51` combines completed startup with controller readiness. `scripts/runtime-host-viewer-adapter.ts:674` allows promoted readiness probes to retry until the host action stops them. The action has a 300 s no-new-phase window and a 20-minute hard ceiling (`src/runtime-host/deploymentAdapter.ts:59`, `:69`). There is no receipt-level progress publication inside the recovery phase. A loaded pass can therefore exhaust the full stall window after its host count reaches 2/2.

This is a separate use of retained collections from #2929. That issue repeatedly clones pipelines during outstanding Git operations. Here the startup path traverses registry receipts and performs recovery I/O. #2929 can aggravate this wait by starving the same loop; its fix cannot eliminate the historical receipt work.

### Fix design

Keep adoption safety and spawn-replay semantics. Split current ownership/admission recovery from terminal-history reconciliation.

- Select pending launch identities and unresolved recovery obligations through narrow registry queries. Capture a finite start-of-pass work set or watermark. Keyed reads then revalidate each receipt after awaits, including foreground ownership, supersedence, claim epoch and pipeline fences.
- Replace supersedence's full receipt enumeration with keyed explicit-supersedes/request-digest lookups, both before and inside its atomic mutation. Preserve the relation and timestamp predicates. The mutable transaction must not enumerate unrelated receipt payloads while proving one replacement.
- Recover the pending work needed to publish live delivery ownership and maintain the existing durable queue. Do not wait for terminal-history repair, or for a queued launch's entire five-minute transcript-publication contract, before completing an otherwise sound ownership pass.
- Process failed historical receipts through bounded continuation work after activation, using the existing reaper/controller owner. Reuse the failure-report cursor/obligation from #2931. A terminal row without an unresolved obligation must produce zero recovery RPCs.
- Retain a bounded cursor across background slices; visit at most 16 identities or a 16 ms processing slice before yielding, whichever comes first. Bound queued work and keep one process-owned runner. A new process resumes from durable unresolved obligations, rather than replaying all history.
- Propagate the release abort and remaining phase deadline into recovery reads. Stop scheduling work on abort; join every call already issued. A deadline refusal records the specific unresolved obligation and progress and preserves it for retry. It must never settle a launch as failed merely to finish startup.
- Publish numeric examined/completed/deferred counts and the current bounded subphase through the existing startup diagnostics and loop monitor. Extend the diagnostic parser compatibly if fields are added. Repeated empty progress must not restart the adapter stall window.

Readiness remains contingent on actual delivery ownership and recoverable durable queues. Unresolved evidence that prevents safe ownership continues to refuse readiness. Successful completion cannot be manufactured by moving that evidence out of the count.

## 2. Rollback cannot acknowledge hot-state quiescence

### Cause on main

The rollback adapter starts and checks the previous Viewer before requesting the candidate's fence (`scripts/runtime-host-viewer-adapter.ts:1496`). `:1199` publishes fencing authority, preserving the candidate's activation-owner process identity (`src/lib/state/hotStateAuthority.ts:223`).

Acknowledgement depends on the retiring Viewer's loop:

- `src/lib/viewerInstrumentation.ts:228` polls release/fence state with a timer. A loaded loop delays the poll.
- Its fence callback at `:1028` first aborts and joins startup, then releases structured hosts, checkpoints rollback mirrors and acknowledges the exact epoch.
- The startup barrier's `quiesce` uses `Promise.allSettled` without a deadline (`:867`). The pending-spawns RPCs described above do not observe its abort until they return.
- Host release has additional health/transcript/runtime work and records interruption obligations before releasing engines (`src/lib/runtime/structuredDeliveryController.ts:2387`, `:2442`). Skipping that step could lose continuation work.
- Mirror acquisition is asynchronous, but mirror materialization and writing still execute synchronously after acquisition (`src/lib/state/sqliteStateStore.ts:1895`, `:1912`; pipeline writers at `src/lib/pipelines/store.ts:1837`). “Async” in that API does not mean the whole checkpoint runs off the Viewer loop.

Meanwhile `checkpointHotStateFence` waits 25 ms between reads and gives the live owner 30 s (`scripts/runtime-host-viewer-adapter.ts:1145`). It may checkpoint independently only after positive owner death. An unreadable identity remains unknown. `hotStateAuthority.ts:284` enforces the same rule at acknowledgement.

The barrier and checkpoint chain explain why 30 s can be missed even after the fence callback runs. #2929 adds timer starvation; #2916 yields lock waits but cannot cancel this pending work or make mirror serialization incremental. The handoff does not contain the phase timings needed to assign the desktop's entire 30 s to one member of this chain.

### Fix design

Use cooperative retirement first, with a managed-container fallback owned by the adapter. Reuse the existing positive-death checkpoint path; do not grant an arbitrary worker permission to acknowledge for a live Viewer.

1. On fencing, close new startup/controller admission immediately and abort read/recovery work. Join admitted mutations, release all published and unpublished hosts through the existing durable interruption protocol, then checkpoint. Give each step a named span and one shared deadline.
2. Read and encode large mirrors in bounded pages outside the Viewer loop, with atomic publication and revision validation. Reuse the existing store/mirror format. Authority remains fencing until the checkpoint for that epoch is durable.
3. Reserve part of the existing 30 s acknowledgement window for fallback. Suggested allocation for implementation tests: cooperative acknowledgement until 10 s; up to 10 s to stop and establish death of the deployment's exact managed candidate web container; the remaining 10 s for independent checkpoint/acknowledgement. Keep the enclosing 90 s rollback action and all performance bounds unchanged. Fit the full rollback sequence, including the previous-release precheck, inside that enclosing deadline.
4. Before forced retirement, durably record a restart boundary for this candidate's registered host keys and outstanding operation keys using the existing interruption/restart-cut records. Bind it to deployment, release, activation-owner identity and fence epoch. Derive continuations only through the existing evidence checks. Preserve unknown rows and externally running engines; never invent an idle verdict.
5. Reinspect exact container identity and its recorded activation-owner identity immediately before stopping it. Stop only the candidate web container owned by this deployment. Native engines run outside its namespace (`structuredDeliveryController.ts:2444`); preserve their identities, queued operations and original message keys for successor recovery. Never stop the stable runtime host, external workers, a PID reused by another process, or a container merely selected by name prefix.
6. After positive owner death, call the existing independent checkpoint path (`runtime-host-viewer-adapter.ts:1159`), reread the same authority epoch, acknowledge, and restore the previous target through the existing durable switch intent (`:1041`). A checkpoint from a previous epoch cannot authorize restoration. Verify the restored endpoint and retained work before recording rolled-back.

The fallback must not depend on an HTTP response, timer or in-memory list from the wedged Viewer. Docker inspection/stop and checkpoint execution each need deadlines; no synchronous polling on the host loop. Failed infrastructure or unprovable identity must produce a bounded, explicit containment failure, with the candidate still fenced. No safe design can promise successful restoration after Docker refuses control or durable storage fails. The required success case is a busy or unresponsive managed web process with working Docker/storage.

This design adds no acknowledgement bypass to the live-owner rule. The implementation must prove restart-boundary preservation and background-worker continuity before enabling forced retirement; a mock “stop succeeded” is insufficient.

## 3. The 1000 ms first-boot gate rejects a 1048 ms maximum

### Measured path and cause

The bound remains `src/runtime-host/candidatePerformance.ts:58`, enforced at `:249`. `candidatePerformanceRun.ts:500` starts its 10 ms lateness sampler before registry import/open, takes the first snapshot, loads the source projection and consumes the first board body. It records the maximum after letting due timers run (`:531`).

Structured startup is imported later (`:562`) and executed in the activation window (`:613`). The watchdog in #2929 is absent from this first-boot window. Its production CPU effect is relevant to update recovery, but cannot directly explain this synthetic first-boot sample.

Current synchronous work includes:

- Registry schema and generation-identity index preparation (`src/lib/agent/sqliteRegistryStore.ts:803`, `:1037`). The gate deliberately removes the prior-release index before boot (`candidatePerformanceRun.ts:771`).
- The cold read-only snapshot: one read transaction, hot-row SQL reads and parsing, normalization and grant decisions (`sqliteRegistryStore.ts:1141`, `:1227`), then cold headers/projections/grant metadata and immutable view construction (`:1781`).
- Module loading immediately around those steps. Awaiting an already resolved value or import is not a timer/I/O yield. Consecutive synchronous steps can therefore contribute to one late tick.

A disposable probe executed that exact first-boot sequence through the existing dataset and source projection, with no adoption, controllers, real runtime socket or production state. It restored the same old schema and ran three fresh children under Bun 1.4.0. Dataset: 30,036 rows, 27,836 cold, 96,409,303 payload bytes; four synthetic worker records, with worker processes intentionally unstarted in this boot-only probe.

| Run | Registry module | Constructor | First snapshot | Projection module | First board request | Maximum timer lateness |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 36.7 ms | 45.9 ms | 279.0 ms | 134.8 ms | 2384.5 ms | 353.4 ms |
| 2 | 37.6 ms | 51.1 ms | 295.0 ms | 139.8 ms | 4070.5 ms | 375.9 ms |
| 3 | 62.1 ms | 96.5 ms | 604.3 ms | 329.3 ms | 4384.7 ms | 754.8 ms |

The first snapshot dominated individually measured synchronous steps; the longest late tick followed the accumulated registry initialization. The board request's wall time mostly awaited worker/I/O work. These measurements do not identify a function inside the snapshot as its dominant CPU consumer. Add subphase spans/profile sampling before choosing a deeper optimization.

All three original-default samples stayed below 1000 ms. After the census relay, a second series used the 53,299-row synthetic SQLite fixture described below and the same old-schema/first-snapshot/source-projection sequence, with no prior summary artifact:

| Census run | Constructor | First snapshot | Projection module | First board request | Maximum timer lateness |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 119.8 ms | 849.1 ms | 168.1 ms | 4268.8 ms | 970.8 ms |
| 2 | 136.4 ms | 880.5 ms | 169.0 ms | 4419.2 ms | 1017.1 ms |
| 3 | 115.8 ms | 839.4 ms | 160.6 ms | 4571.6 ms | 954.8 ms |

All three returned HTTP 200. This second probe used an unused pinned path rather than the gate's live-worker transcript scope; it establishes cold registry/summary cost and is not a complete gate run. Its second sample breaches the unchanged 1000 ms limit. The largest late interval follows constructor plus first-view work before a real task yield. Thus the threshold-crossing failure class reproduces at the relayed size, while the exact desktop 1048 ms sample remains unattributed. Its supplied report lacks the late-tick/subphase trace and candidate revision. Do not assign that particular maximum to SQL contention, GC or a specific migration without that trace.

#2916 was already present and addresses lock acquisition, while the supplied gate saw no SQLite busy. #2919 was already present and supplies a validated persisted board response (`src/lib/scanner/summaryBootstrap.ts:93`, `src/lib/viewerInstrumentation.ts:919`). The gate explicitly pays a first registry snapshot before the board request, and its synthetic first boot has no prior compatible board artifact. Neither change removes that cost. #2919's production route prewarming also occurs in instrumentation, which this source-level first-boot cell does not execute.

### Fix design

Introduce an asynchronous preparation path for the first registry view, while keeping existing synchronous readers for prepared/keyed use. Reuse `src/lib/cooperative.ts:11` and the existing process-wide registry owner (`src/lib/agent/registry.ts:10863`).

- Measure SQL, hot-row parse/normalize, grant preparation, cold-header/projection preparation and immutable-view assembly separately. Keep a bounded slow-slice record containing phase/count/elapsed time, without row payloads.
- Prepare hot rows and cold metadata in bounded pages and cooperative slices. An initial target of 16 ms per slice leaves margin under the 50 ms main-loop rule. A single oversized row must be measured separately rather than hidden by a batch count.
- Pin one database identity, revision and read snapshot on a dedicated preparation connection. Yield between bounded local reads/CPU slices; close it on completion, cancellation or deadline. Install the prepared view/cache atomically only if its identity/revision still stands, otherwise retry boundedly under the same deadline and refuse with a cause. Never expose half-prepared grants or mix revisions.
- Keep cold payloads lazy and reuse narrow identity/projection indexes. Avoid a second complete serialized registry or a new general-purpose worker/cache service. Keyed authority lookups remain available while nonessential view preparation proceeds.
- Insert real task yields between coarse boot phases to prevent their synchronous costs accumulating in a single tick. Internal slicing remains necessary when one snapshot alone exceeds the budget.
- Production startup and the candidate cell must use the same preparation path. The gate's first-snapshot timing must include preparation, and its loop sampler must still begin before registry open and run through the first board body. Keep cold projection sequence 1 and every current bound/refusal intact. Serving the persisted board response must continue before background refinement where that artifact exists.

Schema-upgrade work should remain in the measured window. Move a demonstrated oversized migration statement to an isolated, fenced initialization worker only if subphase measurements show it is required; current evidence makes the initial snapshot the first target. A blanket migration subsystem or a new persisted registry format is unwarranted.

## 4. Stale target/check information and mixed component revisions

### Cause on main

Mixed revisions are a real possible deployment outcome. The coordinator promotes the web before post-promotion health (`src/runtime-host/deployment.ts:382`) and advances to runtime-host handoff only after that health passes (`:417`). If verification and rollback fail, it records terminal failure without completing host succession (`:513`). The supplied web/host split is consistent with this ordering. The record does not prove which deployment originally introduced the older host revision.

The display has additional correctness defects:

- `src/lib/selfUpdate/service.ts:2163` describes the durable release target and `:2194` calls that revision “serving.web”. `:2172` labels the responding web process healthy and attaches that target's revision. The target is an intention; the process can still be the previous endpoint, or the pointer can be ahead of an incomplete switch. `ServiceDeps.web` has no immutable revision (`:123`); production wiring provides only PID, port and start time (`src/lib/selfUpdate/instance.ts:637`).
- Runtime-host health provides a full generation revision, but `service.ts:2184` truncates it and `:2195` attempts to describe the abbreviation again. Preserve the full observed identity.
- Cached check/available state survives Viewer replacement (`service.ts:219`). Only a successful deployment triggers a new check (`:1928`). Failure leaves the old target and comparison until the normal poll, which defaults to 60 minutes (`src/lib/selfUpdate/instance.ts:45`). Check freshness is based on age, rather than a changed serving component identity (`service.ts:1386`).
- A deployment admitted directly through the runtime deployment API is not the dialog's `managed.json` request. The dialog writes that record only through `service.ts:1828`; its snapshot reads only that record at `:2166`, and `refreshManaged` stops refreshing terminal records at `:1917`. Thus a later API-initiated deployment can be active while the dialog still describes an older failed attempt. This matters for the new deployment in the local relay. The runtime ledger already has bounded list and keyed-read APIs.
- The header already separates differing web/host short revisions (`src/components/selfUpdate/SelfUpdateView.tsx:191`). Its data source is unreliable for the web, and collapsing on short equality can mask distinct full identities.
- With a newer checked target, the managed failed state enters the available-update branch (`SelfUpdateView.tsx:301`) and hides the failed target's outcome/error. Also `src/lib/selfUpdate/managed.ts:202` treats rolling-back as rolledBack before restoration is proved; failure copy at `SelfUpdateView.tsx:380` can claim the previous release serves again during an unfinished rollback.

### Fix design

Keep intended target, attempted target and observed serving identities separate.

- Add immutable process revision to the existing web identity dependency, from the release's build/launch metadata, never from the mutable target pointer or a forge request. Preserve full runtime-host generation revision. Match the observed endpoint/process with the stable target when determining whether it serves traffic. If it cannot be confirmed, show unknown/last observed with its timestamp; do not infer a successful switch.
- Retain `update.target` as the attempt's pinned target and show it with deployment phase, error and rollback outcome. Use the durable release target only for desired routing/admission. `serving.web` and `serving.runtimeHost` represent independently observed components.
- Observe the latest runtime-ledger deployment using its bounded compact head page, and select the currently active/latest attempt for display even if another caller admitted it. Keep the dialog's own request/idempotency record for custody; observing someone else's deployment must not replace it or admit a new one. Retain the preceding failed target and cause beside the new attempt. Use bounded reads/single-flight refresh, without a whole-ledger poll or another persistent history store.
- Preserve compatibility with current Snapshot consumers: the browser uses a TypeScript cast of parsed JSON (`src/components/selfUpdate/useSelfUpdateFeed.ts:96`, `:129`), not a strict stripping/validation schema. Prefer additive optional desired-target/observation metadata; retain existing Revision fields and provide full SHA where known. Read legacy cached records with unknown observation fields. No runtime-host wire change is required for its existing full generation revision.
- Invalidate the comparison when a deployment terminates or confirmed serving identity changes. Schedule one background check through the existing single-flight `check()`. Keep prior available metadata explicitly last checked until the check returns; snapshots must not fetch the forge on every poll. A delayed older check must not overwrite a comparison for a newer serving identity.
- Render both component rows in managed mode, the failed attempted target and the newly checked target together. Keep the failed outcome visible when a newer target appears. Represent rolling-back separately; only a journalled rolled-back outcome plus confirmed restored serving evidence can say restoration completed. If evidence later changes, show the current observation.

Update both English and Ukrainian copy. Use the existing update card, process rows and error area; no new dashboard or update history subsystem is needed.

## Isolated reproductions and acceptance tests

### What ran in this stage

Source was exported with `scripts/review-export.ts`. Dependencies were borrowed read-only from a sibling only after package manifest, Bun lockfile and vendored patch bytes matched. There was no dependency install or product-source change. Each executable check used the required owned gate wrapper, isolated HOME/config/temp/state and a Viewer control URL on closed loopback port 1.

The first probe setup refused a missing semantic fixture title; it was corrected before collecting the results below. An initial stage-scratch config classification warning caused state ownership to choose a throwaway directory. Final probes used owned roots under the OS temp directory.

| Check on audited main | Result |
| --- | --- |
| Diagnostic: recover 48 terminal failed structured receipts, all RPCs returning no active evidence after a 20 ms fixture delay | 96 operation reads and 96 session reads; 176 ms recovery wall time, despite zero pending launch work. Demonstrates the unbounded history factor. |
| Diagnostic: hold the recovery effect-read promise, abort through the real startup barrier, then release the promise | Abort was set; acknowledgement remained incomplete after 60 ms and completed only after releasing the read. No production RPC was stalled. |
| Diagnostic: fail a managed attempt after a successful check and change the selected target | Check count stayed 1; available and failed target remained B, while the service presented pointer D as serving web and independently reported host C. |
| First-boot source-path probe, three fresh full-shape processes | Three HTTP 200 bodies; timings above; exact 1048 ms rejection not reproduced. |
| Census-sized recovery and three census-sized source boot processes | All pending/held/uncertain bytes retained by recovery; one boot sample crossed the existing 1000 ms limit. Detailed measurements below and in section 3. |
| `src/runtime-host/deploymentHotState.test.ts` | 15 passed |
| `src/runtime-host/deploymentAdapter.test.ts` | 25 passed, including stall window, progress ceiling and adapter process cleanup |
| `src/runtime-host/candidatePerformance.test.ts` | 20 passed, including cold-boot refusal and missing/induced-evidence refusal |
| `src/instrumentation.test.ts` | 45 passed |
| `scripts/verify-runtime-host.ts` under Bun 1.4.0 | Passed: succession 506 ms; stable listener and runtime socket each answered 27/27 over 15 s. This is host-level succession, not the busy-Viewer rollback case. |

The diagnostic tests assert observed current behavior; they are not green regressions for the proposed fixes. The first-boot probes omit the full browser/runtime/adoption rehearsal and make no release-performance claim. Source export/probes are disposable and do not introduce another committed browser driver.

### Census-sized recovery profile

The local relay prompted a separate SQLite recovery probe through the unmodified `recoverPendingStructuredSpawns`, including the default reaper actuation cap. It used `buildRegistryPerformanceDataset` with conversations=11,870, entries=8,428, receipts=10,971, delivery owners=14,218, held deliveries=666 and outstanding receipts=20; other default lineage/membership settings remained. This creates 53,299 rows, 51,099 cold, with about 214.6 MB of generated JSON payloads before the state-mix adjustment. It is a synthetic size/shape comparison, rather than a byte-identical copy of the desktop's 335.9 MB SQLite file.

After seeding, receipt states/transports were assigned exactly to the relayed terminal counts; the remaining 20 were modeled as recent path-pending structured receipts. Each request received a distinct digest. The existing delivery fixture retained 16 held and eight uncertain records among its 666 rows. All 666 delivery JSON records and all 20 pending receipt JSON records were compared byte-for-byte before/after recovery. No provider process, external installation or live runtime socket was involved. Runtime methods returned immediate empty/absent evidence, so RPC transport latency was deliberately excluded.

Instrument the actual registry instance's `readOnlySnapshot` calls/time, plus `onSqliteSnapshotLoad`, `onSqliteRowPayloadRead` and `onSqliteRowPayloadParse`; count client methods and a 10 ms timer's lateness. Run the fresh recovery child under `bun run --cpu-prof --cpu-prof-dir="$PROFILE_DIR" --cpu-prof-name=recovery.cpuprofile "$PROBE"` inside the owned gate. The CPU profile covers module initialization, the probe's small preservation census and recovery; its inclusive stacks establish call attribution, not exclusive additive percentages.

| Census probe result | Observation |
| --- | ---: |
| Recovery wall time / constructor time | 1813.4 ms / 24.0 ms |
| Snapshot calls / complete snapshot loads | 11,866 / 1 |
| Cumulative snapshot-call wall time | 1288.0 ms |
| Parsed payloads / payload-read observer count | 16,016 / 21,088 |
| Operation reads / session reads / effect pages | 1804 / 1784 / 1 |
| Maximum timer lateness during recovery | 1269.9 ms |
| Every pending receipt and every delivery preserved | Yes |

The 1763-sample CPU profile places 1072 inclusive samples under the initial `loadSnapshot` (`sqliteRegistryStore.ts:1141`), 718 under its `rememberReadOnly` (`:1781`), 422 under immutable view assembly (`:156`), and 354 under `loadHotInTransaction` (`:1227`). These nested sample counts overlap. Native `structuredClone` also appears prominently. This proves a substantial initial snapshot/immutable-view cost and redundant history RPCs at the relayed size. It does not reproduce the desktop's 300 s timeout or establish repeated full snapshot rebuilding without writers. The 1269.9 ms late tick was measured in recovery, not in the first-boot gate window.

An earlier exploratory version reused the default dataset's common request digest. Production correctly identified 16 launches as superseded, so the pending-byte preservation assertion failed. Its profile additionally exposed full mutable receipt cloning inside the atomic supersedence fence (8177 of 9863 inclusive samples under `failStructuredSpawnOffLoop`). This is a deliberate-replacement performance case to retain in regressions, not evidence that unrelated uncertain launches should be failed. After assigning distinct digests, the preservation assertion passed. A profiler command that printed usage instead of running was discarded and its result assertion was strengthened.

The profiling result narrows the fix: eliminate terminal-history work and repeated receipt/supersedence enumeration, prepare the first view cooperatively, and preserve keyed atomic revalidation. Do not remove freshness reads merely because the quiescent fixture shares a cached view. Repeat with real Unix-socket replies and an independent writer before assigning the live timeout to cache invalidation or RPC delay.

The launcher reported 24 logical CPUs, no CPU quota on its own/ancestor cgroups, and a 13 GiB per-agent memory ceiling. The owned gate applies its separate execution placement; no child-cgroup quota trace was retained. Neighboring work and OS caches were uncontrolled, so the three runs establish local attribution and variability, not a desktop-equivalent latency comparison.

### Implementation regression matrix

| Failure | Isolated red case | Required green result |
| --- | --- | --- |
| Adoption | Extend `src/lib/runtime/structuredSpawn.terminalize.test.ts` / existing structured-spawn integration tests with thousands of failed cold receipts, 12 pending launches, multiple receipts for one conversation and delayed keyed RPCs. Run through real startup/finalization. Also keep pending effects arriving while recovery reads. | Terminal history produces no boot RPCs; pending work progresses within the existing adoption gates. A finite watermark ends the pass; background slices advance fairly and survive restart. Original foreground/supersedence and pipeline-survivor cases remain correct. |
| Cancellation | Hold an actual ephemeral runtime socket response while startup recovers, then fence the release. | Issued reads cancel/join within the shared retirement deadline; no orphan socket, late mutation or duplicate initial message. Changing current owner/epoch while a read is held prevents settlement. |
| Rollback | Extend `scripts/runtime-host-viewer-adapter.test.ts` and the existing packaged startup rehearsal: (a) pending recovery RPC, (b) Viewer main-loop stall past the cooperative budget, (c) large mirror, (d) a stale/unreadable/reused owner identity. | Cooperative or exact-container fallback restores and verifies the previous release inside the unchanged 90 s action. The acknowledgement binds the current epoch. All original operation keys, prompts, independent workers and interruption obligations survive; unknown ownership refuses a destructive action. |
| Cold boot | Extend the existing candidate performance runner's subphase diagnostics; old-schema registry, cold first view, census-sized retained shape below, identical data and CPU/memory quota before/after, at least three fresh-process runs per head. Include concurrent writers in the full gate. | First-boot loop maximum ≤1000 ms in every qualifying run, existing open/snapshot/usable-board bounds intact, no grant/identity changes, no empty board or unbounded cache. Record phase timings and actual quota/load beside results. |
| Display | Extend `src/lib/selfUpdate/routes.test.ts` and `src/components/selfUpdate/SelfUpdateView.dom.test.tsx`: web A/host C/desired D/failed B, failure before promotion, rollback in progress, rollback failed, successful restore, newer checked target, unavailable component, reload/SSE reconnect and late check response. | Independently confirmed revisions remain correct; failed B and its cause remain visible beside new D. Rolling-back never claims restored. Checks refresh once without per-snapshot forge traffic. Missing observations remain unknown. |

Upgrade the existing shared `REGISTRY_PERFORMANCE_SHAPE` and dataset builder in `src/lib/agent/registryPerformanceDataset.ts:58` / `:261`, rather than introducing another gate driver: at least the relayed 11,870 conversations, 8,428 entries, 10,971 receipts, 14,218 owners and 666 delivery rows; explicitly exercise 892 failed structured, 122 failed legacy and 133 conflicted receipts. Include distinct requests, multiple historical receipts per conversation and a separate legitimate supersedence case. Keep all existing grant, old-schema, four-live-worker, writer, browser and induced-failure controls. The present default already seeds roughly 30,000 total rows and 3870 receipts, including failures; four live workers and 16 pending deliveries are its active workload, not its total registry size. The gap is the larger retained receipt population and state mix.

The full-size gate must run this upgraded shape through cold boot, activation, promotion verification and rollback, with bounded runtime RPCs and concurrent writers. Preserve every seeded pending/uncertain payload and original operation key, and compare their outcomes through the real journal. Never delete or automatically settle uncertain receipts to meet a time bound. Keep all current threshold numbers. Add a gate assertion that the census-sized retained history and failure mix were actually exercised, so a small fixture cannot report release qualification.

Run the existing lifecycle rehearsal on both frozen baseline and implementation, then extend that rehearsal for a promoted Viewer that cannot cooperate. `scripts/verify-runtime-host.ts` alone rehearses host succession/listener ownership with Docker stubs; a pass does not prove Viewer hot-state rollback. The packaged rehearsal must execute the actual incumbent adapter and the candidate, rather than replacing the incumbent's rollback code with the candidate's code.

For rendered implementation evidence, add cases to the existing shared capture driver and fixture. Cover Update at desktop and 390 px phone widths, English/Ukrainian, failed target beside newer available target, pending/failed rollback, mixed revisions, unknown component and reconnect. Inspect real frames for clipping, overlap, readable errors and accessible retry/check controls. Capture from the scratch export with fake endpoints and production toolbar behavior. This design stage changes no rendered product surface.

### Commands and release checks

Use the exact gate-wrapper executable supplied by the pipeline as `$GATE`; do not substitute a live installation's test state. The controller provides the absolute wrapper path outside this public document. Create owned isolation directories first, then use this pattern, one heavy command at a time:

```sh
env HOME="$ISOLATION/home" XDG_CONFIG_HOME="$ISOLATION/config" \
  TMPDIR="$ISOLATION/temp" LLV_STATE_DIR="$ISOLATION/state" \
  LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1 \
  bash "$GATE" bun test src/runtime-host/deploymentAdapter.test.ts
```

Repeat by explicit file for each touched test, with fresh isolation. Run `bun scripts/verify-runtime-host.ts --runtime "$BUN_BIN"` through the same wrapper. After an isolated production build, run `bun scripts/verify-viewer-runtime.ts --performance` with `CHROME_BIN` and the existing full-shape candidate gate. Inside images, use `bun-container`, never the host nsenter shim.

Keep privacy, types, changed-file lint, touched tests, scoped runtime/native gates and required CI including `bun-runtime`/`runtime-gate`. This stage owes document privacy and whitespace checks; source/build/CI qualification belongs to implementation. No Bun pin change is proposed. No gate threshold, induced-failure control or measured window may be weakened.

At the end of the diagnosis stage there was no product fix or before/after fix result; the later implementation evidence follows below. Implementation acceptance requires the same data/limits on baseline and candidate, an actual failing regression on baseline, all relevant green regressions on candidate, and full candidate gate evidence. A future authorized deployment also requires the normal 30–60 minute journal audit with active-agent count and comparable load recorded. That deployment belongs to the installation's authorized recovery/release owner.

## Deferred — not currently justified

- Recovery, deployment, SSH/API contact or investigation of credentials on the operator's desktop. The originating requirement assigns that to its local session.
- #2929 watchdog call-site changes, MCP transport/writer work, Codex approval replay and old-launch notice policy owned by the named neighboring lanes.
- Raising the 1000 ms gate, resetting progress on repeated phases, removing full-history fixtures, or treating a source probe as the full candidate performance gate.
- A new general scheduler, migration framework, registry serialization format, cache service or per-issue browser driver.
- Global update policy, automatic-update preferences, credential changes, cleanup of retained user data, or broad process/container restarts.
- A claim that this machine reproduced the exact 1048 ms sample, or that the supplied aggregate identifies that desktop sample's dominant function.

The proposed work serves the originating requirement: bounded active adoption, a rollback path independent of a responsive Viewer, less synchronous cold-start work under unchanged gates, and an update view that retains the failed target while identifying both serving components. No operator decision is needed to implement and verify that scope.


## Implementation and verification — 2026-10-15

The implementation includes main through `d6f3669e`, including the watchdog fix (#2933), failed-receipt reporting policy (#2931) and approval callback recovery (#2922). Their controller call sites and reporting policy remain with their original changes. The numeric thresholds in the candidate gate remain unchanged.

A later supplied observation (`local-update-completed-b1fa-20261015-v1`) reports successful external deployment of `b1fa2f91` at 11:38:51Z: web and runtime host agreed, readiness was ready and adoption was 2/2. Its first-boot maximum was 932 ms. Reported startup took about 9m39s, including several minutes recovering pending spawns. That success confirms that the earlier refusal was intermittent. It also supplies the stale-target regression: the dialog still tracked an older failed deployment and offered its older revision to retry. These are operator observations, separate from the paired measurements below.

The supplied startup profile files were verified by their exact local paths. The 462 samples and reported 3.9% direct structured-clone share are an unpaired profile; allocation, JSON parsing and string/GC work account for much of the remaining samples. They do not establish a before/after gain or identify the exact desktop 1048 ms interval.

### Recovery and cold preparation

`recoverPendingStructuredSpawns` selects open receipts, pending runtime effects up to a fixed watermark, and failed receipts supported by current runtime sessions. Keyed reads revalidate each receipt and replacement under its existing recovery fence. It retains a 20 s phase deadline, propagates cancellation to issued socket reads, yields between receipts and publishes examined/completed/deferred counts. Numeric counts do not renew the adapter's stall window. An admitted first message keeps its original durable queue operation while its controller completes transcript delivery. Terminal history repair stays with the bounded reporting/backfill owner from #2931.

Receipt replacement queries use hot and archive indexes and confirm archive versions through their current mappings. Damaged mappings keep the conserving view. Cold registry preparation pins one read transaction on an owned read connection, materializes bounded slices, then applies committed journal deltas. It completes while writers continue committing. The previous full view is released when the prepared reader becomes the snapshot owner.

Receipt replacement and structured-host indexes are installed in separate asynchronously admitted transactions with yields between them. Building receipt indexes together in the constructor still produced 1016–1026 ms cold ticks in an intermediate implementation. Requiring a quiet revision throughout preparation also failed the first full concurrent-writer rehearsal. Both failed controls are retained in the evidence; neither qualifies a release.

The paired probe uses main `5a8e7de5` and implementation `b59f03ac3`, the same 53,299-row SQLite file, fresh processes, old-schema migration inputs and a real isolated Unix runtime host. Its fixture contains 10,971 receipts with the supplied failure mix, 11,870 conversations, 8428 entries, 14,218 delivery owners, 666 retained deliveries and 20 pending receipts. Recovery time is pinned to the fixture's pending receipt timestamp so fixture aging cannot turn preservation into timeout settlement. No artificial RPC latency is injected. Runs share the machine and its CPU admission queue; unrelated host load is uncontrolled.

| Sample | Baseline recovery | Fixed recovery | Baseline cold-loop max | Fixed cold-loop max |
| --- | ---: | ---: | ---: | ---: |
| 1 | 10965 ms | 336 ms | 1172 ms | 383 ms |
| 2 | 9493 ms | 290 ms | 960 ms | 521 ms |
| 3 | 11761 ms | 308 ms | 1145 ms | 523 ms |

Baseline recovery made 3589 RPCs per sample: one effect page, 1804 operation reads and 1784 session reads. Fixed recovery made 22: one effect page, one narrow activity snapshot and 20 operation reads. Baseline and fixed recovery each loaded one complete initial view. The counts expose repeated recovery RPCs and keyed authority reads. Every sample preserved all 686 pending/retained records byte for byte. The raw pairs and fixture digest are in [managed-update.json](../../evidence/perf/managed-update.json).

### Rollback ownership

Cooperative retirement aborts startup reads and checkpoints rollback mirrors in the existing leased backup worker. A newer adapter reserves fallback time inside the existing 30 s acknowledgement window, holds the Viewer, preserves its native processes, records original host/message identities, reinspects the exact managed container and fence, stops that container and requires positive owner death before checkpointing. Unknown identity, a changed fence, failed containment or a failed checkpoint keeps the candidate fenced.

The first upgrade still runs the retiring host's older adapter. The new candidate therefore arms a leased retirement guard before activation reads history. This helper verifies its actual Viewer ancestry and kernel cgroup membership. After eight seconds on an unchanged legacy fence, it durably records the selected restart evidence and signals only its own Viewer. It holds the authority transaction for the final identity/fence check and signal. Docker's private cgroup namespace can expose only `/`; equal membership plus the real parent chain still proves the helper's own Viewer. A newer adapter declares `retirementOwner`, which keeps the guard from competing with its Docker stop. The existing positive-death rule controls acknowledgement in both versions.

The Docker regression launches a detached native worker from the busy candidate through the production CLI namespace shim, verifies their equal cgroups, then requires the same native process identity to survive retirement. It executes the actual baseline adapter for the legacy case, with the candidate Viewer as container init. It also holds a newer adapter's containment ownership beyond the guard grace period and checks that the web remains alive. Container labels, image/id changes, unreadable owners, fence changes, surviving owners and command refusal are covered by isolated refusal tests. No uncertain receipt is deleted or closed to complete rollback.

Review correction, 2026-10-15: the earlier survival fixture created its worker outside Docker. Namespace entry alone leaves candidate-created engines inside Docker's cgroup, where stopping the container or killing its init destroys them. Both retirement paths now stop the verified Viewer's threads, move the remaining container cohort into a sibling cgroup through the host's privileged namespace bridge, and verify that only the held Viewer remains before terminating it. The sibling retains the container's parent and explicit CPU/memory/process limits. A refused move prevents termination and resumes the Viewer. The existing positive-death checkpoint rule remains in force. This fallback requires the managed installation's privileged host bridge and cgroup v2.

Startup also leaves due queued launches untouched for the existing controller reaper. Full host setup has its own five-minute lifetime and cannot belong to the twenty-second recovery phase. Cancellation and release-authority checks run again after account admission and through structured launch publication; deferred receipts retain their original launch and request keys. The regressions hold setup across startup completion and cancel at admission/publication boundaries.

The full census rehearsal also exposed a second demotion scan: `recordDemotionInterruption` found its conversation by enumerating the entire archived collection, although its caller had already used the generation index. Two full runs refused the intermediate implementation: incumbent handoff records failed while transcript evidence kept moving, and successor adoption exceeded the existing 15 s bound. A focused regression decoded 366 unrelated conversation payloads when recording one cut. Interruption recording now uses the existing generation index and retains the same current-generation predicate and durable continuation protocol.

The next full run completed adoption in 8.7 s and demotion exited cleanly, but refused a 3.14 s warm projection and a 2.064 s runtime call. Projection tracing then showed small worker steps while the calling release was entering startup. Adoption and dead-host reconciliation still materialized all entry and conversation payloads there. They now select all structured host kinds through hot/archive indexes, including released hosts, and resolve only their current conversations. An empty pipeline deferral set reads no conversation payloads. Per-host claim, process and transcript checks remain in place.

A subsequent source CPU profile identified retained-receipt enumeration inside diagnostic attribution: `spawnDiagnosticErrorForRegistry`, reached while recording demotion, held 1633 of 8087 inclusive samples in one Viewer and 1227 of 6859 in the other. The profile came from a diagnostic run with an induced worker stall. Diagnostic attribution now reads scalar client identities through existing indexes and preserves the same ordinary/owner, unattributed and unreadable privacy decisions. A regression fails on the baseline's complete snapshot load and passes without materializing a receipt payload. Its peer updates also exercise removal of the last owner attribution.

### Update reconciliation

The service observes one compact latest-deployment ledger row with one bounded, shared refresh. A newer external deployment supersedes the displayed attempt while the original failed receipt remains byte-for-byte unchanged in custody/history. The ledger head also resolves equal request timestamps. Serving web identity comes from the running release, and runtime-host identity comes from live health. Retry rechecks both, the release pointer and the ledger after proving forward ancestry. Unknown, older and unrelated targets are refused. A new external failure can still be retried forward after identical ledger refreshes.

The dialog displays Web and Runtime host independently, keeps the failed target and cause beside a newer check, distinguishes rollback in progress from a verified restore, and retains the previous failed attempt after a newer success. Route and DOM regressions cover English and Ukrainian, unknown component revisions, late checks, stale retry and forward retry. The stale external-success regression fails against the baseline service.

Serving identities retain complete commit ids; process-status revisions keep the short form the existing UI helpers compare. The regression passes a real service snapshot through the same completion-copy helper: matching healthy processes report agreement. A completed deployment with an unconfirmed component reports completion separately from the currently observed revisions.

The supplied desktop's complete 300 s adoption timeout and exact 1048 ms sample remain unpaired observations. These isolated reproductions establish the retained-history cost, cold-loop breach, busy-web rollback failure and stale-target regression without assigning every desktop second to those mechanisms. Deployment and its subsequent production pause audit remain with the authorized release owner.

### Full qualification

The final unprofiled production-build gate passed at the complete census with two writers, four live workers and eight Chromium views, under a 1200% CPU scope and 8 GiB memory limit. The raw report and all intermediate refusals remain in the evidence JSON.

| Measurement | Final result | Existing bound |
| --- | ---: | ---: |
| First-boot event-loop maximum | 367 ms | 1000 ms |
| Warm projection maximum | 761 ms | 2000 ms |
| Runtime RPC p95 / maximum | 14.5 / 1469 ms | 250 / 2000 ms |
| Successor adoption | 1800 ms | 15,000 ms |
| Browser server boot / warm loop maximum | 715 / 146 ms | 1000 / 500 ms |
| Preserved workers / pending launches / retained deliveries | 4 / 20 / 666 | All |

Both Docker rollback cases also used the complete retained census. The new adapter restored the prior release in 15.9 s and the actual baseline adapter did so in 9.6 s with the candidate guard. Each preserved all 687 protected rows, including its added uncertain message, and the independent native worker remained alive. The runtime-host rehearsal passed under Bun 1.4.0: succession completed in 512 ms, and both endpoints answered 27/27 callers during the 15 s abandonment window.

Explicit isolated lifecycle, archive, adoption, cancellation and DOM tests passed. The test comparator reproduced an existing checkout-route runner diagnostic and an existing truncated-credential assertion on the baseline; neither is introduced by this change. The local publication privacy gate passed.

The existing `scripts/capture-board-geometry.ts` driver has a `managed-update` case: seven states at 390, 1000 and 1440 pixels in English and Ukrainian, in both themes. It checks component identities, unknown revisions, failed targets and causes, control geometry, and preservation of failed history without a stale retry after polling and reload. The shared browser fixture uses polling. Its 84 cases and 168 frames are recorded in [managed-update-ui.json](../../evidence/perf/managed-update-ui.json). Raw frames stay local under the repository's existing evidence ignore policy.
