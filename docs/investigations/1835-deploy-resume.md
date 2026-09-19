# Deploy interruption and automatic resumption

Originating requirement, 2026-09-19, [issue #1835, acceptance comment](https://github.com/Latand/live-log-viewer-next/issues/1835#issuecomment-5741524260):

> Expected: after a deploy the Viewer resumes every conversation it cut (seat, builders, reviewers) with one continue turn, keeps their stage attempts open for stage_report, and re-runs a cut review stage.

This quotes the published English acceptance statement. No private operator conversation is quoted. The [issue body](https://github.com/Latand/live-log-viewer-next/issues/1835) additionally requires useful worktree evidence when re-hosting fails and acceptance of the latest owner's report when deployment alone settled its attempt.

## Scope and evidence

Read-only investigation on 2026-09-19. Code references below are at `ee1cc3cddd1513b8e9a3dee9a028bfd1e4d38fbe`, both worktree HEAD and local `origin/main` at inspection, and the deployment's verified revision. A read of GitHub's current main ref returned the same SHA. Only this document is changed. No reproduction deploy, process signal, production mutation, or test against live state was performed.

The observed failure is sufficient to justify recovery work. The design reuses the existing registry, startup adoption and durable delivery machinery. A new service or independent scheduler is unnecessary.

## Timeline (UTC)

Sources are `deployment_status`, stage-specific `get_pipeline`, `conversation_messages`, `lifecycle_events`, and the durable `state/seat-tick/runs.ndjson` journal. Conversation UUIDs identify machine records; transcript paths are deliberately omitted from this public document.

| Time, 2026-09-19 | Evidence |
| --- | --- |
| 10:42:23.909 | Earlier lane `3d9d92ab`, build attempt 3, conversation `conversation_119e083c`, tool-result record 1311455: `stage_report` returned 409 `STAGE_REPORT_SETTLED`, because the attempt had already failed. It was subsequently skipped at 10:53:36.335. This is the observed late-report refusal, separate from the later deploy. |
| 11:11:28.409 | Account-switch lane `4a6cd090`, build attempt 2 starts. |
| 11:12:26.744 | Deployment `deploy_e6acc85c` starts. The shortened ID initially returned 404; listing deployments resolved the full ID. |
| 11:12:35.357 | Header lane `14b93cd8`, critique attempt 1 starts, conversation `conversation_5743fb14`. |
| 11:15:58.210 | Deployment records activation publication of the candidate and MCP runtime. |
| 11:16:00.832–11:16:07.226 | Critic's last assistant message says it is rerunning its render after a refused capture directory. Its last transcript record is 11:16:07.226; no stage verdict follows. |
| 11:16:22.663 | Incumbent Viewer container log: demotion cleanup failed to release three structured hosts. At 11:16:03 it had already logged hot-state writes fenced during release handoff; runtime append calls timed out at 11:16:07. |
| 11:16:58.677 | Seat `conversation_1a043bdd` has a synthetic continuation/no-response pair (records 970295 and 970910). This is evidence that a resume-related transcript side effect occurred; it is not evidence of useful resumed work or a controller-delivered recovery prompt. |
| 11:18:39.704–11:18:58.337 | Candidate Viewer log reaches orchestrator-delivery recovery, interrupted-delivery recovery and queue kick, then startup ready. No “resuming an orchestrator seat whose turn was severed” entry was found in its bounded 11:15–11:22 log. The recovery phase running did not guarantee a seat target existed. |
| 11:19:00.852 | Promoted Viewer health passes at the stable endpoint. This does not establish that its conversations resumed. |
| 11:20:21.087 | Critique attempt 1 becomes failed, verdict null, findings empty, error `historical attempt completed without a valid final JSON verdict`. Lifecycle sequence 22242 marks build repair ready; 22243 records stage failure. |
| 11:20:25.655 | Header build attempt 2 starts and blocks (sequences 22244–22245). Error: `pipeline structured runtime host is unavailable`, followed by the staged-session/read-write reset refusal. It retains a staged conversation identity. |
| 11:20:32.895 | Candidate log reports a conversation drain failure for the cut critic: runtime host unavailable. Further queue/terminal-acknowledgement reads fail through 11:20:35.267. This independently confirms the handoff transport gap. |
| 11:20:33.368–11:20:35.823 | Runtime-host successor acquires its fence, opens journal, recovers consumers and becomes ready, epoch 1040. **Runtime-host succession is later than the approximately 11:16 conversation cut and even later than the critique's failure.** |
| 11:20:37.629 | Deployment becomes succeeded. |
| 11:20:42.662 | Account-switch build attempt 2 becomes failed with the same historical-verdict error; lane remains `needs_decision`. Its conversation is `conversation_21c51abf`. |
| 11:21:07.482, 11:26:07.164, 11:31:07.126 | Seat-tick journal, seat epoch 177: each check is skipped because the seat is classified as progressing; `delivery: null`, unchanged event cursor 21312. No wake was queued. |
| 11:35:40.686–11:35:43.935 | Human message reaches the seat; lifecycle sequence 22248 records delivery. The seat subsequently performs recovery work. Its previous recorded delivery was 10:52:30.265. |
| 11:36:47.890 onward | Header lane is manually recovered into build attempt 3, then critique attempt 2. Later genuine critique findings and build attempt 4 must not be confused with the empty deploy-cut failure. |
| 11:41:37.724 | A real interval seat-tick message finally appears; delivery completes at 11:41:41.602. |

## Causal paths in current code

### Two succession boundaries

The runtime-host callback drains its socket server, closes the journal, releases the singleton fence and exits, with a 30-second forced-exit bound (`src/runtime-host/main.ts:342–375`). Its comment says engine hosts live in Viewer processes: that is ownership, while the actual engine processes run outside the Viewer container namespace. The deployment coordinator calls `retainOnly` after promoted health and then enters host handoff (`src/runtime-host/deployment.ts:395–438`). Retention stops the previous Viewer container (`scripts/runtime-host-viewer-adapter.ts:347–372`).

The earlier engine cut has an explicit path: `completeViewerReleaseDemotion` releases structured hosts, checkpoints and exits even if cleanup fails (`src/lib/viewerInstrumentation.ts:274–301`). `releaseStructuredDeliveryHostsForDemotion` marks active hosts for handoff, then invokes every registered host's release concurrently (`src/lib/runtime/structuredDeliveryController.ts:1419–1445`). Claude release rejects pending calls and terminates/reaps its child (`src/lib/runtime/claudeStreamBrokerHost.ts:1348–1377`). The incumbent's three-host cleanup failure is direct evidence that this path ran. Container exit alone would leave those external engines behind.

Successor adoption claims the registry row and may terminate a verified orphan before retrying the claim (`src/lib/runtime/registry.ts:587–611`); Claude adoption starts the CLI with `--resume` (`src/lib/runtime/claudeStreamBrokerHost.ts:670–672`, `:724`). Its `activeTurnId` starts null (`:589`). Restoring transcript context therefore does not itself submit the missing work turn. Listener continuity, Viewer replacement, engine adoption and turn resumption are separate obligations.

An in-flight tool or engine process cannot be presumed to survive replacement of its owner. A persisted conversation and a re-hosted CLI also do not prove that the original turn continues. The observed cut precedes runtime-host epoch 1040; using only that epoch cannot identify the first interruption boundary.

### Why a cut attempt is settled

`conversationHostUnavailableSince` checks registry status and `conversationTurnLiveness`; a live registry row with a severed turn can still yield an unavailable timestamp (`src/lib/pipelines/engine.ts:1084–1111`). The grace is three minutes (`:1215`). Reconciliation first tries the epoch-based continuation (`:2961–2966`), then evaluates host unavailability (`:2967–2972`).

Once unavailable past grace, `tickRunStage` asks `stopStageAgent` to retire the identity. After a confirmed stop it sets `state = "failed"`, writes the historical-verdict error and passes that same string as both failure and output to `routeFailedAttempt`; without a fail edge it parks (`:3031–3057`). This explains both the critique-to-build transition with no findings and the builder's parked lane. **The error wording alone does not establish that an attempt was historical.** A separate historical-adoption path emits the same string when a terminal transcript has no parsed verdict (`:1835–1870`).

Neither retirement nor missing JSON proves a failed review. The controller currently lets infrastructure recovery manufacture the semantic input for the fail edge. A later continuation can still produce useful work under the conversation, but pipeline completion rights were already removed.

`stage_report` filters reportable attempt states and returns `STAGE_REPORT_SETTLED` when none remain (`src/lib/pipelines/engine.ts:6278–6287`). The fence is correct for genuine settled or superseded work. The earlier misclassification makes it reject an otherwise valid latest-owner completion. The concrete refusal above confirms this mechanism on lane `3d9d92ab`; a later refusal on `4a6cd090` was not required or induced.

### Why #1747/#1750 did not cover this

Lane `077b87b7` completed the previous fix and review. Its fix summary claims one continuation per runtime-host succession, projection invalidation after spawn failure, a deploy-length contention budget, and transcript-gated unverified-delivery retry. These mechanisms remain in current code:

- `reconcileSeveredStageTurn` only handles a running, structured attempt with a conversation and transcript (`src/lib/pipelines/engine.ts:2429–2438`). It needs a changed runtime-host epoch; absent/same epochs are adopted without intervention (`:2444–2452`). A non-busy durable turn is also adopted (`:2464–2467`).
- The transcript must already have been silent for three minutes at the first changed-epoch observation. Otherwise the new epoch is adopted permanently (`:2471–2494`). If armed, it waits another three minutes, then queues one stable-key continuation; any record movement cancels the witness (`:2500–2534`). A ten-minute post-send timeout parks it.
- This is incompatible with the three-minute unavailable-host retirement path: the critique actually fails before the successor epoch exists. A continuation check returning `continue` also does not reserve recovery ownership against subsequent retirement.
- The old prompt asks for a fenced JSON verdict (`:2414–2423`), whereas the current contract uses `stage_report` as primary completion. The replacement prompt must follow that contract.
- The spawn adapter invalidates its cached runtime projection on both success and failure (`:996`). Transient runtime-host/account errors enter a persisted controller wait (`:2787–2850`). However, a failed receipt with `staged === true` and read-write access is refused as unsafe (`:3958`), producing exactly the header build's reset message. Increasing a timeout cannot remove that gate safely.

The adapter reserves a launch before checking for a runtime client. Missing client fails that receipt and throws the public unavailable error; transport failures are mapped to the same error (`src/lib/pipelines/engine.ts:516–540`). Therefore the error text alone cannot distinguish pre-actuation refusal from a lost response after actuation. The deeper spawn path also refuses a missing client (`src/lib/runtime/structuredSpawn.ts:794–797`).

Prior-work search: project-scoped searches for deploy cuts and resume-after-deploy initially used a path-style project key and returned no hits; subsequent searches used canonical project `repo-d8378326ece61ec4d5b81d4b5bd7fe74`, plus unscoped `historical attempt` and `resume deploy`. The canonical `"cut turn" "resumes"` query found the review of lane `077b87b7`. Reading that hit with `conversation_messages` found review transcript basename `d61f84ad.jsonl`, assistant record 1142061, 2026-09-18 21:57:56.385Z: review of [PR #1782](https://github.com/Latand/live-log-viewer-next/pull/1782), head `7d6ffa60`, merge base `c03e1926`. It reports controller-port tests, including the recent-transcript refusal, and isolated green checks. Those tests cover the intended epoch heuristic; they do not establish survival across both live deployment boundaries. The same transcript contains a 21:36:04 no-response message during its own review. Current code was checked directly rather than accepting the old approval as proof.

### Seat recovery and the missing wake

Startup already has orchestrator recovery. `orchestratorRestartRecoveryTargets` requires a structured row with `entry.host === null`, a `severed` liveness verdict and a busy transcript (`src/lib/runtime/startup.ts:224–251`). It captures the evidence before adoption, then sends a recovery message only for still-current, published targets (`:322–350`). Its key includes an in-memory boot UUID (`:166`, `:331`), so it is not a durable interruption identity shared by every recovery producer.

Startup finalizes delivery publication, enqueues seat recoveries, enqueues generic **Codex** interrupted continuations, then kicks the delivery queue (`src/lib/runtime/startup.ts:1185–1210`). Queue draining can deliver admitted work; it cannot manufacture a missing recovery obligation. Generic Claude recovery does not run through the Codex continuation loop.

The queue reads outstanding delivery effects and returns immediately if there are none (`src/lib/runtime/structuredDeliveryQueue.ts:705–736`). The synthetic recovery-tail distinction is already modeled for migration (`src/lib/accounts/migration/turnState.ts:93–120`); reuse that evidence rather than inventing another textual heuristic. Its terminal-boundary requirement matters: a no-response record by itself does not establish a settled original turn.

Seat tick drops work if `seat.turn` is busy and activity is running/starting, or waiting with a busy activity turn (`src/lib/monitor/seatTick.ts:280–291`, `:954`). The journal proves this was the selected branch throughout the first 15 minutes. It proves the absence of tick delivery, without proving which individual activity field supplied the stale progressing verdict. The synthetic no-response pair is especially important: transcript movement from boot is not proof that useful work resumed.

## Fix design

### One owner of the continuation

Extend Viewer structured-host startup/recovery to own a durable interruption obligation for **all** conversations actually cut by deployment, including seats and pipeline workers on both engines. Capture it at Viewer release handover before relinquishing the owner, and reconcile it after successor adoption. Use the existing registry/journal and delivery queue; key it by canonical conversation, interrupted owner generation/turn and deployment boundary. Runtime-host epoch is supporting evidence, not the sole trigger.

Record the obligation before owner termination, with original transcript checkpoint, seat epoch or stage/attempt identity when present, and reason. On adoption, verify the old owner no longer owns the turn, canonical identity remains current, no terminal stage result exists and no newer human/controller delivery already resumed it. Submit exactly one logical continuation through the existing durable idempotency key. Retry admission and recover unknown outcomes with that same key. A process restart must not mint another key. Tick and pipeline recovery observe that obligation and do not independently send competing prompts.

The prompt says deployment interrupted the turn, asks the agent to inspect its transcript and preserved work, re-run interrupted operations as needed, and finish with `stage_report` when it owns a stage. Do not assert that every background operation died: escaped or external work requires inspection. Recognize provider-generated recovery/no-response records as bookkeeping, preserving the obligation until the intended continuation is delivered or superseded by demonstrated new work. Delivery acceptance, actual arrival and agent progress remain distinct states.

### Preserve attempts; re-run read-only work

Keep the same attempt `running` with explicit interruption/recovery metadata while recovery is owed. Make that state fence unavailable-host retirement and verdict-missing checks. No `failed` state, fail-edge traversal, repair prompt, review round consumption or fake findings may arise solely from a deployment cut.

For a read-write builder, resume the existing conversation and preserve dirty/staged files and commits. For a read-only critique or reviewer, the continuation instructs it to rerun the interrupted review against the same bound stage definition and reviewed revision, discarding incomplete render/test conclusions. This is a new execution turn within the same open attempt, satisfying both the continuation and rerun requirements. If its conversation cannot be recovered, a replacement read-only execution may be created only after old-owner retirement is confirmed; explicitly fence the old completion authority before activating the replacement. A new semantic review result is the only input that may traverse the fail edge.

Prefer preventing bad settlement to weakening the settled fence. For already damaged attempts, allow a narrow recovery only when durable evidence proves deployment-only settlement, the reporting conversation still owns the latest attempt, no successor/edge result has been consumed and no real verdict exists. Otherwise retain the refusal and show reconciliation required; never accept an old report over a newer attempt. A free-text historical-error match alone is insufficient authority.

If re-hosting ultimately fails, retain interruption cause and recovery receipts, expose the host failure plus read-only worktree status (dirty/staged paths and ahead commits), and require a successor decision. Do not reset the worktree. Bound automatic recovery by elapsed time and explicit non-delivery/owner evidence; expose a diagnostic failure rather than fabricating a review verdict.

### Spawn during handover

Before reserving/actuating a new engine, recognize an active handover or unavailable structured control surface and persist a waiting activation on the same attempt. Retry through the existing controller budget after readiness returns. Do not hold pipeline locks across network waits.

A reservation or staged session is not proof a prompt ran. Extend spawn receipt evidence to distinguish reserved, host started, prompt accepted and delivery outcome unknown. Reuse the same launch and payload while its outcome is pending; adopt a completed receipt. Retire and retry only after proof of non-delivery and no surviving owner. A staged read-write launch with possible work remains protected; recover its existing conversation instead of silently resetting or launching a second writer. Preserve bounded backoff and a visible deadline for permanent failures.

## Failure-inducing tests and delivery order

Use isolated HOME/XDG/provider state, ephemeral ports and only the named suites. No new one-off deployment driver. Every case must fail on the original implementation at the actual behavior assertion, then pass on the fix; a fixture setup failure is insufficient.

| Slice, order, file fence | Tests that must induce the failure |
| --- | --- |
| **1. Durable conversation recovery**, first. `src/lib/viewerInstrumentation.ts`, `src/lib/runtime/startup.ts`, `registry.ts`, `structuredDeliveryController.ts`, `structuredDeliveryQueue.ts`, shared runtime contracts and registry persistence; `scripts/runtime-host-viewer-adapter.ts` only if its existing release-handover seam needs coordination; associated startup/adoption/delivery tests. Own shared interruption types here. | Replace the Viewer while runtime-host epoch stays unchanged; delay host succession beyond three minutes; cut Claude and Codex mid-tool; fail demotion cleanup with a verified survivor and enforce ownership before adoption; emit synthetic continuation/no-response records; crash after enqueue but before receipt persistence; restart twice and race a human message/seat rotation. Assert one logical continuation, arrival and subsequent useful output, no dormant-seat wake, no duplicate prompt and no second owner. Simulate non-rehostable owner and verify preserved worktree evidence. |
| **2. Pipeline semantics**, after slice 1. `src/lib/pipelines/engine.ts`, `types.ts`/store serialization as needed, `severedTurnResume.test.ts`, `engine.test.ts`, `stageCompletion.test.ts`; review-flow recovery callers only if their tests prove required. | Reproduce critique cut at 11:16 and controller check at 11:20 before runtime-host epoch changes. Assert attempt stays open, zero fail-edge activation and zero review-budget use; same-bound read-only review reruns and produces its own verdict. Resume builder and accept latest-owner report. Reject genuine settled, superseded, cancelled, removed-stage and conflicting reports. Exercise narrowly recoverable legacy settlement separately from a fail edge already consumed. Remove competing pipeline continuation emission. |
| **3. Handover spawn admission and integrated qualification**, last. `src/lib/runtime/structuredSpawn.ts`, spawn receipt implementation under `src/lib/agent/registry*`, `src/lib/pipelines/engine.ts` spawn adapter/wait branch and existing receipt/controller tests; extend `src/lib/runtime/startup.test.ts` handover cases and existing deployment verification harnesses. | Make host unavailable before reservation, after reservation, after process start and after prompt acceptance before acknowledgement. Assert same attempt waits, known nondelivery safely retries, unknown delivery keeps its key, successful late receipt is adopted, dirty work survives, no second writer and bounded permanent-failure diagnostics. Run a real isolated successor rehearsal with a busy seat, builder and read-only reviewer plus a spawn during handover; assert all resume without human input and seat tick cannot suppress owed interruption recovery. |

Slices 2 and 3 both touch `engine.ts`; implement in order to avoid shared-file races. No UI redesign is required. Existing diagnostic surfaces can show recovery metadata; any subsequent UI change needs the repository's existing rendered-evidence harness.

## Limits and deferred work

Confirmed: deployment identity/revision and successor timing; exact failed attempts and empty critique findings; real settled-report refusal; seat-tick suppression through 11:31; current code paths and previous fix's scope.

Not yet confirmed: the precise syscall/process exit and outcome for each of the three failed demotion releases around 11:16; the per-check registry/activity inputs that produced the seat's progressing classification; which startup eligibility guard excluded its durable recovery message; the launch receipt's exact prompt-delivery phase for header build attempt 2. Bounded incumbent/candidate logs were read and establish demotion failure and startup phases, but do not resolve these per-conversation details. They require receipt-level evidence or the isolated failure-inducing tests above. The plan does not presume a safe resend, process death, or prompt nondelivery in any of these cases. No live failure was induced to fill these gaps.

Deferred — not currently justified: a general scheduler rewrite, globally accepting reports on failed attempts, automatically resetting dirty worktrees, replacing the delivery system, generic CPU/silence heuristics as sole interruption proof, and retrying every failed review. The existing issue's broad “pipeline state is busy” symptom is not separately diagnosed here; this report addresses the pinned deploy, cut attempts, seat and spawn path.

Validation against the originating requirement: the shared recovery owner covers seat/builders/reviewers; one stable delivery identity limits continuation to once per real cut; attempts retain completion authority; read-only work reruns without a fabricated failed review. Runtime availability or a green deployment alone is not the acceptance test. The integrated rehearsal must demonstrate resumed work from all three participants.
