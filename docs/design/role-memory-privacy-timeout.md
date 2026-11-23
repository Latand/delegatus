# Role-memory privacy during stage launch

> Stage launch survives a slow privacy worker while reading role memory

Origin: the pinned board requirement, 2026-11-09. The requested behavior is automatic progress through slow filtering and concurrent rule changes while every outgoing input remains filtered. This document retains the diagnosis for acceptance items 1 and 4. The implementation below adds bounded reuse and automatic preparation recovery for items 2 and 3; publication owns the checks in item 5.

## Evidence and limits

Source baseline: `dcf12fdd641f9f80731fb00f16ed355b82303c83`, also the captured `origin/main`. Relevant earlier deliveries are #3678 and #3723. Read `docs/design/role-memory-read-retry.md`, including its deferred work, before implementing this design. Its original twelve-request artifact ladder has already been removed. Its semantic rule revision and fractional-deadline corrections are present here.

The primary reads used `get_pipeline` with the exact stage and historical attempt from the specification, rather than the lane's latest attempt. Times below are the records' `startedAt`, in UTC. Private launch identifiers, account selectors, original prompts and transcript contents are intentionally absent from this document.

| Historical attempt | Started at | Requests / worker interval | Composition | Revision reruns | Refusal |
| --- | --- | --- | --- | --- | --- |
| Review, attempt 3 | 2026-11-09 13:41:56.646 | 9 / 173.1 s | 7.1 s | 3 | window exhausted in worker request |
| Backend review, attempt 1 | 2026-11-09 13:38:08.416 | 10 / 165.1 s | 24.8 s | 5 | store changed; window exhausted in worker request |
| Visual review, attempt 1 | 2026-11-09 13:41:11.517 | 10 / 173.2 s | 12.0 s | 4 | window exhausted in composition |
| Retained-archive verification, attempt 1 | 2026-11-07 23:11:06.222 | 13 / 179.8 s | 0.2 s | 15 | store changed; window exhausted in worker request |
| Maintenance review, attempt 1 | 2026-11-08 11:22:12.234 | Not retained in refusal | Not retained | Not retained | syntax error |
| Recovery fix, attempt 1 | 2026-11-09 13:29:41.398 | Not retained in refusal | Not retained | Not retained | window exhausted |

All four detailed timeout records report zero backoff. All six retain `budgetSpent: false`, null verdict and null completion. The backend-review and archive attempts have reserved launch/conversation identities; the other four have neither. The maintenance syntax refusal predates the specification's fresh-evidence date. A later successful retry does not settle an earlier reserved launch.

The earlier read-only archive audit completed on 2026-11-07; its primary final answer was read again for this diagnosis. It established thirteen requests, fifteen nested revision reruns and a retained initial input of 22,129 UTF-8 bytes. It could not correlate individual privacy requests with before/after revisions and producer writes. Its bounded producer history contained rule/lifecycle changes; it did not establish administrative-only invalidation or curator causality. Those limits still hold. Current backend-review metadata retains task inputs and a frozen stage definition, but does not retain a per-request candidate/revision trace.

Consequently the records establish repeated preparation and its terminal behavior. They do not establish a fixed seventeen-second filter cost, a queue defect, global overload, an underlying writer responsible for each conflict, or a performance improvement. The specification's launch-frequency estimate remains an operator observation; this diagnosis did not count all launches.

## Exact call path

The local pipeline path has three filtering boundaries:

1. `spawnRunStage` in `src/lib/pipelines/engine.ts:8294` selects a text-free memory profile. Its initial `withRoleMemoryRetry` at line 8306 covers stability reads, input revision capture and `composeStageInput` at line 8367. The materialized input is persisted before reservation at lines 8382–8388. This path checks durable activation throughout asynchronous composition through `createStageInputExec`.
2. `composeStageInput` in `src/lib/pipelines/stageInput.ts:70` resolves task context and wraps the entire builder in `withCurrentRoleMemory`. `composeCurrentStageInput` captures a revision, validates tracked skill references, renders the complete prompt, filters either inline text or complete artifacts and complete reference-bearing prompts, then rechecks revision before publishing artifact files. Artifact names, protection, atomic replacement and UTF-8 byte limits belong to this builder.
3. After registry reservation, the production spawn adapter in `engine.ts:1011` calls `preparePrompt`, then filters the whole message again under `withCurrentRoleMemory`. It stamps `roleMemoryRevisionToken`, rechecks reservation/activation and invokes `spawnStructuredConversation`. Immediately before first-message delivery, `src/lib/runtime/structuredSpawn.ts:3087` calls the preparation callback and filters the complete message again. `authorizeDispatch` at line 3096 rechecks authority and the revision. These later callbacks can start separate bounded preparation windows; the launch's entire lifecycle is wider than one 180-second window.

The worker path reached by each `withoutStoredLessonsAsync` is:

```text
memory/privacy.ts: withoutStoredLessonsAsync -> run
  -> withCurrentRoleMemory -> withRoleMemoryRetry -> withPrivacyRetry
  -> withCurrentRevision -> privacyWorkerRequest
links/taskPageWorker.ts: runPrivacyWork -> sharedWorker -> privacy -> submit
  -> leased resident taskPage.worker.ts, one JSON-line request
  -> storedLessonRevision -> withoutStoredLessonsIn(requireComplete: true)
memory/roleStore.ts: storedLessonMatchers -> compileStoredLessonMatchers
  -> readableRows -> lessonTextsOf -> withholdLessons over each string
taskPage.worker.ts: recheck revision -> result(value, privacyRevision)
taskPageWorker.ts: parse/validate response -> recheck authoritative revision
privacy.ts: recheck revision -> return filtered value
stageInput.ts / engine.ts / structuredSpawn.ts: final caller fences
```

`runPrivacyWork` skips the process only when the authoritative collection is absent and its revision is the affirmative empty string (`taskPageWorker.ts:197`). Disabled role injection does not establish that private stored text is safe to export. `learnedRulesForLaunchProfile` in `memory/roleLaunch.ts` selects and records the private rules actually delivered to an engine through a separate path. It does not perform these repeated export-filter requests. Changing that selection or starting without its private rules would not repair the outgoing-input privacy path.

`roleStore.ts:849` reads rule and reason text from every rule row, including archived rules, with the shipped public-rule exemption. `storedLessonMatchers` keeps one compiled matcher cache per revision (`roleStore.ts:868`). `storedLessonRevision` has a separate scalar cache. There is no cache of successful filtered input/output pairs. Every accepted `filter` request still traverses its strings, even with a warm compiled matcher.

The worker is one shared serial lane with sixteen admitted jobs, a two-MiB encoded privacy-request and response bound, a maximum sixty-second request timer and ten-minute idle retirement. The timer starts before the job enters the serial tail (`taskPageWorker.ts:51–67`), so it includes queueing, startup, retirement wait, compilation, matching, transport and caller scheduling. Work remains in a leased child process. No inline matcher runs on the Viewer's main thread.

## Why approximately ten requests accumulate

There is no ten-request launch setting and no seventeen-second timer. `privacyWorkTimeoutMs` caps each submitted request at `min(60 seconds, remaining window)`. Dividing the four recorded worker intervals by their request counts yields approximately 19.2, 16.5, 17.3 and 13.8 seconds per counted request. These are aggregate intervals, with a possibly clipped final request. They do not measure individual successful matches.

For a stable revision, initial composition uses one request for an inline prompt. The ordinary artifact path uses a previous-output filter, an optional specification filter, and a complete candidate filter. Local candidate selection at `stageInput.ts:128` tries four excerpt lengths without contacting the worker. Post-filter growth and the full-prompt-reference fallback can raise initial composition to at most six filter calls. The reservation and first-message boundaries each add one complete-message filter when reached. Their preparation callbacks may also rebuild if revision changed. A whole stable local launch can therefore already use several requests; the current source does not repeat the old eight-candidate worker ladder.

Revision conflicts add requests at multiple levels. `withoutStoredLessonsAsync` itself has a three-iteration revision wrapper. The complete composition and reservation/dispatch callers have their own wrappers. Each mismatch can repeat a worker request; an outer mismatch repeats earlier preparation work as well. Nine requests can arise from three inner passes within each of three outer passes at a single filtering boundary. The aggregate records cannot identify which candidate each historical request filtered. They support this source mechanism and retain nonzero revision-rerun counts; they do not prove a unique nine- or ten-call decomposition for those attempts.

`privacyWorkerRequest` increments the counter at entry. It can count a failed submission and is not a count of child processes or completed worker jobs. Its elapsed phase covers the interval while any request is outstanding in that retry context. `privacyRevisionRerun` increments at every nested failed revision check, including an enclosing check that makes no additional worker request. Thus fifteen reruns and thirteen requests are consistent. Zero backoff is consistent with revision-loop replay inside `withCurrentRevision`, which does not sleep.

The 180-second cutoff is shared through process-global `AsyncLocalStorage` across nested preparation calls (`privacyRetry.ts:16–117`). Transient outer failures use asynchronous backoff of one second, doubling to thirty seconds. Nested wrappers reuse the same cutoff. A successful result is rejected if the cutoff has passed. The timeout clips the last request to the remaining budget, while synchronous composition or a delayed timer callback can finish beyond the nominal cutoff. This explains why summed recorded phase times can exceed 180 seconds. It supplies no basis for raising the deadline.

`window.lastFailure` retains a prior safe failure; therefore an exhausted window can report `store-changed` while its terminal phase is a worker request. The label alone does not identify the final producer write.

## Why a store change discards the work

The current semantic revision is `[database identity, collection import generation, durable rule-write counter]` (`memory/roleViewSource.ts:47`). SQLite triggers at `state/sqliteStateStore.ts:431` advance the counter transactionally for inserts, updates and deletes of rule rows. Request and scope bookkeeping do not advance it. Lifecycle changes and rewrites still invalidate privacy; this design retains that accepted contract. Rule-row metadata updates can advance it too, but the archived incident did not prove such an update was its sole cause. Rewriting revision semantics again is unjustified.

A concurrent rule change can introduce text absent from the old matcher. Both the child and parent reject a response checked under the old revision. In the parent, that rejection enters `fail`, which retires the resident worker (`taskPageWorker.ts:147–163`); its compiled cache disappears with it. A child's `store-changed` error frame follows the same path. A caller-only late revision mismatch can leave the child alive, although its next compilation still needs the new revision.

`withCurrentRevision` (`privacy.ts:32`) retries its original callback up to three times. At the worker boundary this resends the original request. At the composition boundary it invokes `composeCurrentStageInput` again, rebuilding the artifact list and filtering earlier pieces again. After three mismatches it throws `RoleMemoryChanged`. The outer retry owner deliberately passes that typed deferral to the engine, which already persists `roleMemoryWait`, observes two stable revisions, and schedules another tick with bounded backoff (`engine.ts:8013`, `8308`, `8633`).

When the shared deadline wins first, `PrivacyRetryExhausted` is wrapped as an ordinary `RoleMemoryRefusal`. The engine's typed `RoleMemoryChanged` branch no longer matches; its generic exit at `engine.ts:8748` calls `park`. That difference explains why expected revision fencing and a slow worker can end in a human decision even though automatic revision waiting already exists.

## The syntax-error case is separate

The maintenance review's first attempt failed before reservation. Its record has no launch, conversation or execution-runtime identity. A bounded service-journal read for 2026-11-08 11:21:30–11:27:00 UTC found the caller's worker-failure category logged at 11:23:52.168223 and an immediate preparation refusal at 11:23:52.168656. Only timestamps, static categories and counts were extracted; exception messages, worker frames and private data were not emitted.

`privacyFailureOf` maps an exception named `SyntaxError` to `syntax-error` (`memory/privacyFailure.ts:62`). The category is permanent (`failures` in the same file), so a stable-revision failure is refused immediately, with no timeout backoff. `privacy.ts:47` converts it to the safe role-memory refusal; the engine parks through its generic exit. Retrying slow work does not repair malformed data, a protocol frame or an engine compilation failure.

Two concrete paths currently collapse into this category:

- The child catches exceptions from parsing the request and from filtering/report generation and returns the static category (`taskPage.worker.ts:17`, `74`). Batched matcher compilation already catches `SyntaxError`, splits batches and records individually refused patterns; complete filtering then refuses skipped patterns. Thus an ordinary caught batch-size error does not by itself establish this incident's escaping exception. Exact-pattern/report paths and other uncaught syntax exceptions remain possible.
- The parent parses each response line with `JSON.parse` at `taskPageWorker.ts:134`. The surrounding catch calls `privacyFailureOf(error, "worker-invalid-reply")`. An actual JSON `SyntaxError` overrides that fallback and emerges as `syntax-error`. A malformed response therefore loses its protocol origin.

The incident record and journal do not distinguish these paths. No claim is made that the original store was corrupt, that a particular rule failed compilation, or that the source contained invalid TypeScript. The separate defect established from source is ambiguous classification of malformed worker replies. A scratch-only diagnostic exercises both paths through the production `TaskPageWorker`; its result is recorded below. The original exception origin remains unretained. This limitation does not justify retrying permanent syntax failures or bypassing privacy.

The narrow protocol correction is to catch response JSON parse failures at that parser and return `worker-invalid-reply`; continue carrying a validated child `syntax-error` category unchanged. Retain a static origin such as `worker-frame` or `worker-operation` in safe diagnostics if needed. Do not log an exception, frame, pattern or path. This repairs the demonstrated classification defect and makes a future worker-operation syntax refusal independently diagnosable. Repair of an unidentified original matcher/data defect remains deferred.

## Minimal implementation

Choose automatic retry with durable waiting when preparation cannot finish. Every send still requires successful filtering against the current revision. Continuous changes or an indefinitely unavailable worker cannot guarantee finite successful dispatch under that privacy requirement; the stage remains pending with an observable reason and bounded work per scheduled turn. Recovery must survive a Viewer restart and must not consume another review round or require `retry-stage`.

### Reuse successful text filtering

Add a completed-result string cache at the `withoutStoredLessonsAsync` seam in `memory/privacy.ts`. Keep generic object, report, issue and curation requests on their existing paths. An exact string input is the unit of reuse. Key it by the selected state root, authoritative semantic revision, a filter-format version, and exact input bytes. A digest may index entries, but verify exact input equality before reuse. Never treat the filtered output as an approved input alias: filtering need not be idempotent when a stored rule equals or spans a replacement marker.

One process-global owner across route bundles holds at most 128 completed entries and eight MiB total input/output bytes, with a ten-minute TTL and oldest-access eviction. Skip caching a pair larger than 128 KiB. Charge retained key metadata too. Drop the active cache generation on state-root, database-identity or revision change. Process restart starts cold. Retain nothing on disk, return strings by value, and log neither values nor their digests. Share no in-flight promises across callers with different operation leases.

The cache stays inside `withCurrentRoleMemory`: assert the caller's lease and read/recheck authoritative revision on hits and misses. Insert only after a complete successful worker result and the caller's terminal revision fence; verify again before returning a hit. Do not cache failures or an affirmative empty-store result. Final message and artifact checks remain executable on cache hits. Identical text can be reused across launches and repeated preparation within one launch; distinct framing, paths, selectors or text requires a miss.

For the composition wrapper only, add an explicit revision-attempt option to `withCurrentRoleMemory`, defaulting to the existing three. `composeStageInput` uses one complete-composition attempt. A changed revision then returns `RoleMemoryChanged` to the durable stability wait instead of replaying the complete artifact builder inside another three-pass loop. Worker-request and final dispatch wrappers retain their existing three attempts. This is the narrow reconsideration of the earlier deferred flattening: it removes outer composition replay while retaining the reservation-side tolerance that motivated deferral. The original 180-second cutoff and lease checks remain shared.

### Preserve deferral through deadline exhaustion

Keep `PrivacyRetryExhausted`'s safe failure/phase data accessible through the refusal's cause. Add a static, typed preparation-deferral classification for exhaustion caused by the existing retryable categories or by the actual window cutoff. It covers worker timeout, busy store, queue full, retirement timeout and store change. It excludes syntax errors, invalid replies, denied access, corruption, oversized input, shutdown, unknown errors and expired leases. Check the real cause; do not match a human-readable substring.

Before reservation, the engine routes this classification through its existing `roleMemoryWait`/`roleMemoryFailures` schedule. Persist the pending state and next eligible time before scheduling. Preserve the cause/phase separately from the stable receipt reason. Keep failure counts across process restarts and successful stability observations; clear them only after the attempt reaches running, as today. Preparation and unchanged-revision cache hits still recheck activation, membership, account and dispatch authority.

Reserved launches require the same custody discipline as revision deferral. Extend the existing exact, allowlisted privacy-deferral spawn-receipt marker to include preparation exhaustion, using a distinct static reason. Preserve the old marker for retained records. No registry schema change is needed; the new reason uses the existing receipt error field and existing wait fields.

The shared-marker inventory is deliberately narrower than all errors containing the word privacy:

| Path | Producer, consumer or copy | Required treatment |
| --- | --- | --- |
| `privacy.ts:10`, `roleStore.ts:164` | Typed revision error and default static reason | Keep the existing reason; add a distinct preparation-exhaustion variant |
| `privacyRetry.ts:89` | Recognizes typed revision deferral before retry | Preserve immediate typed deferral and safe exhaustion cause |
| `engine.ts:1022`, `1053` | Writes a failed spawn receipt and reconstructs revision errors | Carry the new variant only from typed pre-delivery preparation failure |
| `engine.ts:2029–2040` | Projects `neverBegan` and `roleMemoryRetrySafe` | Extend the exact reason allowlist while retaining all generation/process/message predicates |
| `engine.ts:2111–2196` | `failStoppedStageLaunch`, default `manualRetry` false | Classify both spawn reasons as privacy recovery; keep original receipt comparison, runtime first-message read and stopped-process proof. New preparation failure may have no first-message operation. Its absence still needs the existing recovery evidence |
| `engine.ts:8027–8199` | Reconciliation, default `manualRetry` and `retirementOnly` false; writes delivery evidence, retry claim, retirement row, pending schedule or park | Pass the actual classified spawn reason to stopped proof; retain exact-original identity and repeated evidence checks; confirmed delivery follows the existing adoption path |
| `structuredSpawn.ts:3087`, `3242` | Pre-delivery preparation and spawn cleanup persist failure reason | Carry the typed preparation variant without manufacturing a failed first-message send |
| `structuredSpawn.ts:2348`, `2369`, `2684`, `2778`, `2790` | Existing held-message revision conflicts and first-message recovery | Preserve revision handling; add the preparation variant only where the pre-delivery callback can actually raise it |
| `structuredDeliveryQueue.ts:820`, `1944`, `1973`, `2306`, `2587`, `2674`; `structuredMessageDelivery.ts:2181` | Last-authorize revision checks, first-message receipt mapping and unverified-after-actuation protection | Keep their existing revision-only meaning. The new preparation refusal happens before enqueue/deliver and must never grant this queue a new non-execution proof |

`reconcileRoleMemoryDispatch` does not write role memory or public reports. It mutates the pipeline attempt and can call the registry's stopped-launch failure and retry-claim writes through its ports. It reads native-turn/runtime-operation evidence; every returned pathname must retain the existing allowed-source and generation checks. Its `undefined`, adopted-success, pending-wait and parked-uncertainty exits must remain distinct. Do not reuse its manual override to satisfy automatic recovery.

An accepted marker records only a refusal raised before the delivery call. It does not prove host termination. Reuse `reconcileRoleMemoryDispatch`: require the exact original launch/conversation, terminal receipt, no delivered first message, matching generation, released claim and proven stopped owned processes before retiring it and reserving another launch. A failed cleanup, registry read or uncertain send retains the original identities. Do not issue a fresh launch merely because the caller timed out.

The full failure path matters: the adapter calls `failStructuredSpawnOffLoop`; structured cleanup can send `transitionOperation(..., "failed")`, stop/unbind its owned host, project a dead host, release an adoption claim and fail the receipt (`structuredSpawn.ts:3242`). Lost acknowledgements to those operations require reconciliation. There is no permission here to replay an original UNKNOWN, reset its budget, adopt it or relaunch it. The existing historical UNKNOWNs remain outside this implementation's acceptance fixture.

### Files and per-file checks

| Production file | Intended change | Explicit regression file |
| --- | --- | --- |
| `src/lib/memory/privacy.ts` | Completed string reuse; bounded composition revision option; typed exhaustion deferral | `src/lib/memory/privacy.test.ts`, `src/lib/memory/privacyRetry.test.ts` |
| `src/lib/memory/privacyRetry.ts` | Expose typed safe exhaustion facts if current cause chain is insufficient; retain cutoff/accounting | `src/lib/memory/privacyRetry.test.ts` |
| `src/lib/pipelines/stageInput.ts` | Opt complete composition into one revision pass; preserve all outputs and guards | `src/lib/pipelines/stageInput.test.ts`, `src/lib/pipelines/stageInputRetry.test.ts` |
| `src/lib/memory/roleStore.ts` | Add the static preparation-deferral receipt reason beside the existing revision marker; leave revision computation unchanged | `src/lib/pipelines/engine.roleMemoryDispatch.test.ts` |
| `src/lib/pipelines/engine.ts` | Defer preparation exhaustion; extend exact marker producers/consumers and existing reconciliation | `src/lib/pipelines/stageInputRetry.test.ts`, `src/lib/pipelines/engine.roleMemoryDispatch.test.ts` |
| `src/lib/runtime/structuredSpawn.ts` | Carry only proven pre-delivery preparation deferral through existing cleanup/recovery | `src/lib/runtime/structuredSpawn.memory.test.ts`, `src/lib/runtime/structuredSpawnSettlement.test.ts` |
| `src/lib/links/taskPageWorker.ts` | Classify malformed response JSON at its parser | `src/lib/memory/privacy.test.ts` |

Avoid a new request protocol or cache module unless implementation demonstrates that the listed seams cannot hold this behavior. The generic filter already accepts nested values; batching remains an alternative to the string cache if it removes more code while preserving whole-reference filtering and the two-MiB bound. This design selects string reuse because it also covers identical repeated inputs at later dispatch boundaries.

## Keep-list

- Keep sixty-second maximum worker requests and the original 180-second preparation window, clipped final requests, asynchronous backoff, safe cause/phase accounting and decisive lease cancellation.
- Keep transactional monotonic privacy revision, database replacement/import identity, ABA protection, archive/reason coverage, public shipped-rule validation and request/scope bookkeeping independence.
- Keep `requireComplete`, parent/child authoritative revision fences, final complete-message filters, current authority checks and absence of an inline or unfiltered fallback.
- Keep every producer field: task details, frozen prompt/scaffold, access and branch constraints, prior output, skill references, test guidance, restart framing and scope-review evidence. Filter complete joined text, including complete file references; preserve atomic private artifacts, symlink defenses and post-redaction UTF-8 growth checks.
- Keep existing launch identity, membership, activation, dispatch, lease and stopped-host fences. Cache reuse supplies filtered bytes; it grants no authority. Leave Cloud and direct-spawn recovery policy unchanged unless a shared helper change requires its existing tests.
- Keep known-value publication fingerprints and their checks unchanged. Keep historical uncertain attempts and unrelated capability-startup failures unresolved by this work.

## Regression acceptance

Use the existing production fixtures and builders. Every test below has a behavioral oracle; no assertions inspect instruction wording.

1. Through the `stageInputRetry.test.ts` engine harness and real `composeStageInput`, delay the production worker seam with a deterministic monotonic clock. Seed fixture-owned private rule/reason text and include it in inline and artifact-bearing input. Record worker-call count. Repeated unchanged input uses completed results; changed input misses. A bounded slow transient that exhausts its first window leaves pending state, then a later scheduled turn reaches running and dispatches exactly once. Restore real worker filtering for final success. Removing the deferral makes the existing parked outcome return; removing the cache increases actual worker calls. Artificial clock time is a test mechanism, with no claim about production throughput.
2. Change a rule during a held filter and again after cache lookup. The old result is refused, complete composition is not replayed three times in the same turn, and a later stable scheduled turn reaches running using the new rule set. No prompt or artifact includes either forbidden text. Continuous changes produce bounded worker calls per preparation and an increasing persisted retry count/backoff. Reload the production pipeline state between turns to prove restart behavior. Do not reset the clock/window to obtain a synthetic success in a single invocation.
3. In `privacy.test.ts`, cover exact input and revision hit/miss, cold/warm state roots, database replacement, A→B→A rule text with advancing counter, administrative request writes, deletion/archive/reason changes, TTL, byte/count eviction, oversize bypass, marker-equal rules, and concurrent callers with different leases. A cache miss or eviction must run the real worker. No rejected or stale result may become a cache entry. Keep object/report/issue output equivalent to existing redaction.
4. Retain the artifact tests for post-filter growth, UTF-8 boundaries, complete joined references, full-prompt fallback, tracked skills and symlink refusal in `stageInput.test.ts`. Measure call bounds through the worker seam and final emitted content rather than exact prompt phrases.
5. In `engine.roleMemoryDispatch.test.ts` and the structured spawn memory/settlement tests, exhaust privacy preparation both before reservation and after host setup but before first-message delivery. Prove exactly one eventual delivered input. Fail between durable writes; restart/reconcile before retry. Lose only acknowledgements after a failed-operation transition, dead projection and receipt update. Also lose a delivery acknowledgement after a real first-message effect. The latter must retain/reconcile the original launch without a resend. Failed host cleanup, mismatched identity, expired authority and missing receipt reads remain decisive.
6. Add malformed-response JSON and a valid child `syntax-error` error frame in `privacy.test.ts`. The former becomes `worker-invalid-reply`; the latter remains a permanent worker-operation syntax refusal. Neither returns input, enters transient backoff or leaks the frame/error text. Add permanent error plus simultaneous rule-change coverage so revision replay cannot disguise it as a successful cache hit. The historical incident's original exception remains unclaimed.

The original exhaustion expectation in `stageInputRetry.test.ts` asserted `needs_decision`. The implementation updates the retryable-exhaustion cases to pending/automatic progress and retains permission/corruption/permanent-error refusal checks. Keep existing revision-dispatch recovery tests, and run `roleStore.privacyRevision.test.ts` unchanged because the cache consumes that contract. These checks are required before review; implementation check results are recorded in the pipeline stage report.

## Verification procedure and stage results

Export the captured source into the stage's own scratch directory and use its dependencies without modifying the assigned worktree. For each test file above, allocate a fresh HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR, remove inherited alternate state/registry selectors, set LLV_VIEWER_CONTROL_URL to a closed loopback port, and retain command exit status and log. Remove forge/agent Git shims from the test PATH while preserving ordinary Git and runtime binaries. Never run runtime-directory sweeps or the tests against live state.

Run each explicit file separately through the stage-provided installed `gate-slot.sh`, using `bun run test <file>`. For a recorded long run, use `--record` once and `wait_for_check` once; admission time is not execution time. Treat a missing terminal receipt as unknown. Run no broad typecheck or build in this design stage. Publication of the implementation owes the normal pre-push privacy/types/changed-file lint/touched-tests gate and required CI: `privacy-publication`, `privacy-tracker-audit`, `runtime-gate`, `typecheck`. This document does not certify those future gates.

Completed on the captured source in an isolated scratch export:

- `bun run test src/lib/memory/privacyRetry.test.ts`, through the installed recorded gate: exit 0, 26 passed, 2 skipped, 0 failed, 150 assertions. Runner-reported execution time was 186.07 seconds. This confirms existing deadline, revision-deferral and lease behavior; it does not demonstrate the proposed cache or eventual launch completion.
- Scratch-only `privacyOrigin.diagnostic.test.ts`, through a separate recorded gate: final exit 0, 2 passed, 0 failed, 4 assertions, 573 ms runner-reported execution. Both a malformed worker response and a valid child syntax-error frame emerge as `syntax-error`. An initial control returned `worker-io` before reaching its target (exit 1, 2 failed); it provides no syntax-origin evidence. The final run simplified the fixture's response construction and exposed only its synthetic helper stderr for diagnosis. No production source was changed.
- Document-only publication scan: `bun scripts/privacy-publication-gate.ts --repository <assigned-checkout> --require-known-values --paths docs/design/role-memory-privacy-timeout.md`, with `LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE=scripts/privacy-known-value-fingerprints.json`: PASS, exit 0. The first invocation lacked the fingerprint-file setting and returned `configuration_error`; the configured rerun supplied the committed file without changing gate policy.

The scratch syntax diagnostic is a finite classification control, not a reproduction of the original incident. It constructs a production `TaskPageWorker` with a fixture-owned JSON-line child. For one received request the child either writes an opening brace followed by a newline, or returns a valid frame containing the same request id, `error: "LESSON_PRIVACY_UNAVAILABLE"` and `failure: "syntax-error"`. The observed result for both is `failure: "syntax-error"` and `transientPrivacyFailure("syntax-error") === false`. To reproduce, construct the malformed response source with `JSON.stringify("{\n")` and terminate the valid JSON response with `String.fromCharCode(10)`; await `worker.shutdown()` in `finally`. The implementation adds slow-worker, concurrent-revision and cache regressions to the existing test files; their results belong to the pipeline stage report.

## Implementation

A local stage whose preparation window expires on a retryable failure now persists its wait and retries automatically. The original 180-second window still bounds each preparation. It sends input only after complete filtering under the current revision. Two stable observations and the persisted backoff govern the next preparation; the failure count survives restarts and clears only upon running. Continuous rule changes or an unavailable worker can keep a stage pending indefinitely. The wait retains its safe cause and phase summary.

`memory/privacy.ts` owns one process-wide cache of completed exact string pairs. Its generation includes the selected state directory, authoritative semantic revision and format version. It retains at most 128 pairs and eight MiB, counts key metadata, expires idle entries after ten minutes and skips pairs above 128 KiB. Objects, reports, issue scrubbing and curation use their existing paths. Late completions cannot populate the cache, and terminal cache checks share the original retry window. Cache hits still check the caller lease and authoritative revision; the output is never an input alias. A process restart starts cold. No throughput claim is made.

`pipelines/stageInput.ts` allows one complete composition per revision pass. The individual worker filter and dispatch boundaries keep their existing three-pass tolerance. Permanent failures remain decisive even if the store changes while a failed filter is pending. The final complete-message filters, artifact bounds and authority fences remain in force.

Reserved launches carry a distinct static preparation-exhaustion reason through structured cleanup. A lost cleanup or receipt acknowledgement preserves that typed refusal, which authorizes reconciliation of the original launch only. Retirement still requires the original identities, matching generation, first-message journal evidence, stopped processes and the retry claim. A delivered or uncertain original remains under the existing delivery policy. The new reason is never added to the delivery queue's revision-only retry allowlist.

The shared write-path inventory was checked before extending the wait records: the engine writes the two wait fields, the store validates launch identity/deadline and copies the records, and startup, explicit retry and periodic reconciliation consume them. Optional safe diagnostic text travels with those records without changing the registry schema. Existing records without it remain readable.

The paused worker-correlation branch also touches `links/taskPageWorker.ts` and the engine. Its diff adds job observations and correlation fields. This implementation changes only JSON parsing at that worker seam and the existing launch preparation/reconciliation logic; it adds no competing instrumentation or request protocol.

Malformed response JSON now produces `worker-invalid-reply`. A valid child error frame carrying `syntax-error` remains a permanent operation refusal. The historical exception's origin remains unknown.

### Regression-first evidence

On the captured product source, the new slow-worker fixture reached `needs_decision`, and the concurrent-store fixture made nine worker calls against an expected bound of three. Both failed before implementation (0 passed, 2 failed). The exact-string reuse and malformed-frame tests also failed; the valid child syntax-error control passed (1 passed, 2 failed). These tests use the production stage builder and worker, with synthetic monotonic time for the slow interval. They establish behavior and call bounds rather than production performance.

## Deferred — not currently justified

- Queue priority, a second worker lane, protocol-wide batching and throughput claims. The paused correlation lane owns worker/request attribution; its actual branch diff changes `taskPageWorker.ts`, `taskPage.worker.ts` and engine context. Coordinate the narrow parser edit with that work. Its instrumentation must not be replaced or silently overwritten.
- Global flattening of revision loops. Reservation-side tolerance and retained-launch reconciliation motivated the earlier deferral; only complete composition is narrowed here.
- Narrower rule-row reads during matcher compilation, lifecycle revision relaxation, known-value refresh changes and a cache persisted across restarts. They are unnecessary for the selected string reuse and automatic wait.
- Repair of the original syntax exception without a retained origin or reproducible input. Preserve the permanent refusal and distinguish protocol parsing first; do not invent a corrupt row or uncompilable rule.
- A fresh live canary, retry of historical uncertain launches, capability-startup repair, model/account changes, publication or deploy. These need their own authorized execution and evidence.
