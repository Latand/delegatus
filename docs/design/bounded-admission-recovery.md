> Невизначений запуск має обмежене й безпечне відновлення

Accepted task title, reaffirmed in the design brief on 2026-11-05 (2026-11-06 local date). The original incident task was recorded on 2026-11-01. Acceptance follows the standing bug-repair instruction of 2026-10-19; there is no new defect-specific operator quotation. Private incident messages are paraphrased below. Their exact records stay in the stage's private evidence.

# Bounded admission recovery

Status: implementation prepared for independent review. The original design inspected source `2e0c507d24db6b3110e446c73aacce91f23cff8f`, tree `e51e7c7d701ecc0688813d8fe98c0058fbc928e7`. The observations and source citations below describe that baseline. No live claim or request key has been changed.

## Caller flow and required outcome

After this repair, a caller retains the original tool, arguments and `clientRequestId`. It uses `recoveryOnly: true` to recover that operation. A current project seat can discover its unresolved launch claims through a bounded MCP read, including claims made by a proven predecessor seat. A new logical launch becomes safe only after recovery returns a durable negative fence. A concrete launch, conversation or queued pipeline is followed through its existing disposition.

The contract requires three changes: a deadline for unresolved admission, recovery through actual seat succession, and a supported project-scoped read. It requires no new user interface. Ambiguity continues to mean `outcome_unknown` while a previous effect remains possible or the enforcing store cannot be inspected.

The current claimless pipeline incident has an additional evidence gap. The available records cannot establish where its generic HTTP 403 originated. This design does not declare that original safe to repeat or close. That restriction applies separately from the repair of recorded claims.

## Observations and their limits

| Evidence | Established fact | Limit |
| --- | --- | --- |
| Primary relay, 2026-11-01 11:38:45.131 UTC | A project seat reported a verifier key returning unknown repeatedly and a predecessor key returning `recovery_not_permitted` after rotation. | A report of another project's observations; no new launch or receipt lookup was performed on that project. The relay carries no operator authority. |
| Existing diagnostic final, 2026-11-05 22:09:25.378 UTC, and its retained report | Two relay refusals reached a named lower HTTP authority guard. The research creation's generic 403 could not be reconstructed. Privacy-worker timeouts have separate evidence. | These three symptoms have no established common cause. |
| Retained research transcript metadata and exact receipt lookup | Two tool-output records at 21:53:08.992 and 21:53:59.844 UTC contain the generic 403. The retained 22:04:27.145 UTC lookup has zero MCP receipt rows for the exact creation key. | This is a historical bounded lookup, not a current census or a proof of nonexecution. The diagnostic scanned a two-MiB transcript tail within a named time window. |
| Fresh supported read of this project's seat, 2026-11-05 | The active seat names the earlier research caller as its immediate predecessor. | Confirms that stored succession edge. It establishes neither the original request's fate nor all historical authorization checks. No recovery invocation was made. An initial read returned a starting-child error; the subsequent read supplied this observation. |
| Isolated probe on the captured source | A valid verifier dispatch was held before reservation. After the owned fixture's claim timestamps were aged three days, three real MCP recoveries returned unknown with no fence. Releasing the original produced one writer and a concrete launch; original-key recovery then returned settled. | Clock ageing was injected into the fixture database. The writer was a controlled local fixture. No model, vendor success reply or production launch was involved. This reproduces the admission recurrence, without identifying the historical 403 cause. |

The final probe exercised the SDK stdio client, packaged MCP launcher, real HTTP MCP handler, production bindings and recovery builders, real spawn/validation handlers, and SQLite stores. The fixture added routing for the production validation handler and a barrier before the spawn handler. Validation answered 200 three times; the late spawn answered 202. The desired bounded-settlement assertion failed with actual exit 1: expected `not-executed`, received `unknown`. The log and raw observations were retained before the assertion. An earlier fixture preparation incorrectly supplied `reviews` to a verifier; its early failure is retained separately and supplies no defect proof.

No production claim was retried, fenced, adopted, cleared or rewritten during this stage. No conclusion about a currently running research agent follows from this probe.

## Current boundaries

| Boundary | Current producer, consumer and relevant behavior |
| --- | --- |
| Adapter to HTTP | `src/lib/mcp/largeReads.ts:18` builds one RPC envelope and forwards native work metadata. Its non-success branch at line 86 cancels the response body and retains only HTTP status. `src/lib/mcp/http.ts:143` authenticates capability or native peer before tool execution. Several independent early guards can return 403. |
| Caller binding | `launchRecoveryBinding` and `bindSpawn` in `src/lib/mcp/bindings.ts:4716` and line 8236 resolve server-owned identity and target. Fresh admission may await project naming. An existing receipt retains its target and downstream key. |
| MCP claim | `createMcpToolService` in `src/lib/mcp/server.ts:2960` authorizes lookup, compares the request digest and records a durable binding. `recoveryOnly` is excluded from the digest. An absent recovery lookup writes nothing and returns unknown at line 3263. |
| Dispatch | The MCP store changes `claimed` to `dispatching` before calling the binding (`server.ts:3306`). `dispatchViewerControl` checks `context.assertCaller` before sending (`bindings.ts:719`). A dispatch marker means the request may already have left the process. |
| Spawn reservation | `beginSpawnRequestAsync` in `src/lib/agent/registry.ts:6653` calls its guard under account admission. `spawnCommand.ts:1141` checks current authority, account binding and the admission fence before reservation. Both reservation and `recordSpawnAdmissionRejection` use the account mutation lock. |
| Spawn recovery | `recoverSpawn` in `bindings.ts:8360` reads launch receipts by downstream key. With no receipt, it reads an existing exact-body fence or invokes validation. Validation can fence a current admission refusal; an admissible request produces no fence. No age rule ends that branch. |
| MCP closure | `fenceUndispatched` (`server.ts:2092`) conditionally closes a still-claimed row. `recoverRecord` currently invokes it for a dead claim owner. `markDispatching` then fails, preventing late dispatch. It cannot close a request already marked dispatching. |
| Pipeline creation | `createPipeline` (`bindings.ts:2554`) checks caller authority before entering `createPipelineFromRequest`. That function (`src/lib/pipelines/engine.ts:15388`) awaits preflight and Git reads before persistence. `createPipelineWithDelivery` (`store.ts:2164`) rechecks workspace authority inside its mutation. Busy admission can instead write `creationQueue.ts:46`; its drain at line 128 can create the pipeline later. Original-key MCP recovery currently consults the pipeline row, omitting a queued creation without a row. |
| Terminal result | MCP `settle` preserves the first terminal answer, including stronger recovery beside an ordinary acceptance. An HTTP error or a missing downstream record alone supplies no negative proof. Durable mutation receipts are excluded from bounded-read receipt pruning (`server.ts:2277`). |

There are three distinct digests. The MCP digest covers normalized tool arguments; the spawn admission digest covers the exact serialized dispatch body; the registry's spawn digest covers its canonical launch identity. Pipeline creation has its existing `creationRequest` digest. Each continues to serve its present boundary. A recovered request must keep the original values even when role defaults, aliases or the current seat have changed.

### Existing seat succession

`completeOrchestratorSeatIntent` (`src/lib/orchestrator/seats.ts:1140`) atomically records the new active seat and the predecessor's revocation, including epoch and successor. `authorizedManagerSeats` (`authority.ts:87`) rejects revoked epochs, conflicting project designations, missing generations and superseded conversations.

`productionRecoveryPredecessors` (`bindings.ts:1142`) already walks the active seat's immediate predecessor and historical revocations. `sameCaller` (`server.ts:2663`) already permits a recorded caller in that ancestry for tools other than orchestrator relay sends. Therefore the historical refusal does not establish that this feature is wholly missing today.

The remaining limitations are observable in code: recovery copies at most 32 predecessor IDs; the production helper scans revocations before that cap; and `sessionRefusal` compares the current conversation and native proof only when the invocation has such a proof. It does not freeze and revalidate the active seat epoch or recompute successor entitlement after each awaited receipt/evidence read. Existing lineage tests separately exercise stored seat builders and a service with supplied predecessor arrays. Acceptance needs the combined real-client path and replacement races.

## Chosen repair

Reuse the MCP receipt, existing spawn admission fence, seat designation/revocation records, and existing page cursor store. Add only the narrow data and guards needed at the two launch admission paths. Keep relay sends on their current ownership policy.

A lookup-only repair would leave unattended claims unresolved until another call. A general recovery ledger would duplicate the receipt and admission stores and require new ownership rules. The proposed fence extension plus one bounded Viewer pass covers unattended recorded claims through the existing stores. Its admission cutoff can cancel valid work delayed before reservation; a committed fence makes a later deliberate launch safe. Automatic relaunch remains outside scope.

### 1. Freeze admission identity before dispatch

Extend a new launch binding with a versioned admission snapshot: original canonical caller and target, authenticated generation identity, any current seat epoch, the digest of the exact downstream envelope, its resolved attribution/default fields, and `settleAfter`. Pipeline bindings also retain the candidate pipeline ID before preflight, so the existing queue status file can be read directly after an interrupted create. Generating that ID does not create a pipeline or launch an agent.

Use 120 seconds from durable claim as the proposed internal admission cutoff. This is a cancellation policy for work still lacking downstream admission, selected above the current 30-second adapter and registry admission windows. It does not bound model execution or time after a launch receipt exists. A first implementation must test the exact boundary and late-success ordering before adopting this constant. No setting is added.

Preserve the current argument digest and downstream keys. Compute and freeze the downstream digest from the body that the original dispatcher will actually emit. Freeze its server-added launcher/source/default fields at that point. Avoid a second durable copy of prompt, spec or image payloads. Expiry needs the stored digest; receipt lookup needs the stored key. Original-key replay reads those records and sends no reconstructed body. Existing validation recovery can use matching original arguments and frozen adaptations, while a successor's launcher identity or today's defaults cannot replace them. Persist no raw capability or transport credential. Original native approval and generation evidence must be represented by a server-verifiable identity reference, never by a client assertion.

For older bound rows, use their original request arguments only when the request digest matches and their original envelope can be reconstructed without changing attribution or defaults. A missing fact keeps that row unknown. A legacy unbound row or missing MCP claim gains no invented owner, timestamp or tombstone.

### 2. Make expiry an enforceable negative result

| Durable state at resolution | Required action |
| --- | --- |
| No MCP claim | Return unknown without writing. The request may still arrive; the resolver lacks durable ownership of it. |
| `claimed`, before cutoff | Retain the claim. |
| `claimed`, cutoff reached | CAS to `not-executed` under the receipt writer, even if the process is still alive. The original's `markDispatching` must then fail. |
| `dispatching`, matching downstream receipt or queued pipeline | Return its concrete identity and current disposition. Never dispatch a replacement. |
| `dispatching`, no downstream admission, cutoff reached | Commit the downstream fence against the frozen envelope, then store the terminal MCP result. |
| Missing, conflicting, corrupt or unreadable ownership/effect evidence | Return unknown with a bounded diagnostic. Preserve the original key. |
| Existing terminal result | Replay that result; late responses cannot replace it. |

For a spawn, extend the existing rejection-fence operation to allow admission expiry independently of current role validity. Under the same account mutation lock, recheck authority, read the exact launch receipt and the fence, then write one exact-body fence only if no receipt won. If reservation wins, recover its launch ID. If the fence wins, the original reservation guard rejects before creating a receipt or writer. Read the fence back before publishing `not-executed`.

The negative decision must also exclude a past effect whose current receipt disappeared. The registry's indexed hot/cold view and immutable archive are relevant here: `registryArchive.ts:29` retains launch idempotency without time expiry. Retain an immutable initial receipt version in the registry's existing archive transaction before a new reservation can actuate, and include that exact-key version in recovery. Losing the hot mapping after an actual launch then yields its real admission identity or uncertainty. It cannot license negative closure. A missing import, archive-continuity failure, restored/changed store identity or known receipt deletion leaves unknown. Apply the same rule to pipeline creation: the narrow creation record retains an admitted witness as well as a negative tombstone before row/queue actuation. An admitted witness without its expected row/status is damaged evidence and remains unknown. These witnesses carry keys, digests and actual reserved identities; they require no separate job ledger. Legacy history without retained admission continuity cannot acquire that proof from absence.

The existing account store already stores each spawn fence as a separate `fence:` row (`accountsStore.ts:261`, line 372). Its compatibility body reader and writer currently reconstruct the whole source (`accountsStore.ts:517`, line 663). Add narrow access to those existing keyed rows for this path, retaining the source's gap/import checks and damaged-key refusal. Expiry processing must not decode every account or fence.

Pipeline creation needs its own small per-key tombstone in `state.sqlite`, because a spawn fence cannot prevent a pipeline write. Keep it a typed creation record, without introducing a general recovery ledger. Use the existing account mutation lock as the common serialization point for the final MCP pipeline admission, queue-file write and negative decision. Acquire it asynchronously with one finite deadline. Perform Git/project preparation before taking it. A pipeline mutation started under that lock must read the fence in its synchronous admission callback before persistence; queue fallback and queue drain must consume that same guard. Establish one lock order, account mutation before pipeline writer, and release both before retrying contention. `createPipelineWithDelivery` already exposes preparation and synchronous admission callbacks for this split.

Under that lock, recovery first checks the exact creation key in the active/archive pipeline lookup and the exact queued/refused status for the retained candidate ID. A queued creation is concrete accepted work. If neither admission exists, recovery records the tombstone. Queue writes and subsequent drains then refuse that original. Recheck any proactive reservation made before pipeline persistence and release only a matching unused reservation when negative closure succeeds. Generic HTTP errors remain insufficient proof.

The account lock supplies serialization across the MCP receipt database, pipeline state and queue file. Commit the downstream tombstone before completing the MCP receipt. A crash between those commits is recoverable by reading the tombstone. A failure to obtain either writer leaves unknown. The implementation must not hold a pipeline lease and then wait for the account lock. Direct non-MCP creation keeps its existing behavior; every continuation of an MCP creation carries the immutable admission identity.

Enable negative closure only where every possible old dispatcher consumes the fence. Existing spawn reservations already check their admission fence; verify archived/legacy dispatch variants before including them. New pipeline bindings record the fence protocol and receiving writer generation before dispatch. Older pipeline calls and retained queue entries that can still reach an unguarded writer stay unknown. Neither a current version number nor the absence of an old process grants this eligibility. Activation, demotion and rollback tests must demonstrate that a delayed original cannot use an older writer or queue drain to bypass a committed fence. Tombstones and admitted witnesses survive rollback and have no automatic expiry.

### 3. Revalidate the current invocation and proven lineage

Keep exact-owner recovery. Successor recovery additionally requires a currently authorized seat in the original caller's canonical project, a verified historical seat designation for the original claim, and an unbroken forward succession path to the current epoch. A new binding records its seat epoch. For old bindings, historical designation intervals must establish that the caller held that seat when the claim was made. Contradictory or missing records grant no successor entitlement. Caller arguments, matching project names, worker roles and deputy attribution supply no lineage proof.

Use the existing seat authority projection to index predecessor edges when the seat file changes. Resolve an exact recorded owner from that graph; do not authorize from a request-scoped copied predecessor array. Detect cycles, conflicting edges and epoch reuse. Deep valid ancestry must remain recoverable: replace the silent 32-owner truncation with a targeted ancestry decision and bounded lineage enumeration for the read surface. Keep the index owned by the existing seat projection and invalidate it with that projection's durable revision.

An invocation guard pins caller identity, generation, project and, when using successor authority, active seat epoch. Run it after every awaited binding, claim, evidence read, writer acquisition and result write, inside each conditional mutation, and synchronously before dispatch, reservation, queue insertion or result disclosure. A cached `authorityOf` answer cannot satisfy this live check. Refresh workspace access as well. The guard preserves the original target and envelope.

`context.assertCaller` currently reaches the outgoing HTTP send; it does not serialize a closure across HTTP. For the spawn route, authenticate the existing MCP service transport, locate the durable binding by its indexed downstream key, verify its frozen envelope digest, and construct the receiving guard from its server-recorded generation and seat evidence. Native generations must be checked through the existing native admission sources; a conversation ID alone is insufficient. No caller-provided header or launcher string grants this authority. Pipeline creation can carry the live guard in process. Restart recovery can fence an expired original using release authority; it never inherits permission to launch as that caller.

Replacement means refusal for the stale invocation, including a replacement after the final evidence lookup. A fresh successor invocation can then recover the original. The exact-owner branch still needs a current authenticated session and workspace access. Relay-send recovery remains bound to its exact sender.

### 4. Resolve persisted due work with bounded effort

The serving Viewer owns one reconciliation pass, started from `startCurrentReleaseControllers` in `viewerInstrumentation.ts:391`. Task-executor children and MCP adapters start no clocks. Each pass checks the release fence, selects at most 50 due launch claims, uses an overall five-second asynchronous budget, and schedules the next pass five seconds after completion. It yields between claims. Startup resumes from persisted due fields and a persisted traversal position; demotion aborts the pass before further mutations. Log the bounded operation as `mcp.admission-recovery` with counts and a safe failure code, excluding envelopes and credentials.

At or after the cutoff, an exact-key recovery bypasses background backlog and attempts the same resolution within a five-second budget. A successful due pass must turn an unresolved admitted key into concrete admission or a negative fence. Store unavailability, contradictory evidence and process suspension remain explicit unknown outcomes. The cutoff is enforced again at original admission, so a delayed dispatcher cannot gain a late launch simply because reconciliation was delayed.

A global wall-clock settlement bound during outages or arbitrarily large backlog is not established. Report the cutoff, overdue age and last bounded failure in the supported read. Measure the final backlog case before claiming a scheduling bound; with N eligible claims and 50 visits per pass, at least ceiling(N/50) passes are needed. Failed claims advance the traversal cursor and retain their next attempt time, preventing one corrupt row from starving later work. No performance improvement is claimed by this design.

### 5. Add one bounded MCP read

Add `list_unknown_launch_claims` with `limit` (default 25, maximum 50) and an opaque cursor. Derive the project from the authenticated current seat. An optional project selector must equal that canonical project. The result contains the original tool/key, claim time, cutoff, stage, safe evidence classification and next action. It omits prompts, original envelopes, credentials and foreign targets. Successful downstream admission removes an entry from the unknown set.

Add scalar receipt columns for caller project, target project, owner conversation, tool, unresolved admission status and due time. Populate them in the same transaction as each claim/transition. Index project, target project, owner, tool/status and sequence for this read; use a separate due-work index for reconciliation. Backfill old rows in bounded startup batches. Missing binding information remains unclassified and undisclosed. Add readiness checks so a worker cannot silently fall back to a full receipt scan while preparation is incomplete. SQLite statements must compile on 3.39.

Each page verifies a bounded segment of seat lineage and performs indexed owner seeks before JSON decoding. Cap candidate visits at 100, decoded receipt metadata at 100 rows and answer size at 24 KiB. Skip foreign targets, rows concurrently settled and unprovable owners without returning their details. Advance from the last inspected candidate even if every row is suppressed. Continue lineage enumeration in the cursor when older verified owners remain. Order pages by lineage position and receipt sequence with a fixed sequence watermark; no global newest-first sort is required.

Reuse `McpPageCursorStore`: five-minute TTL, 2,048 entries and eight-MiB cap (`pageCursors.ts:7`). Bind continuation to the authenticated caller, generation, project, current seat epoch, filters and watermark. Rotation or changed access invalidates it and requires a new page. Add the tool to the catalog, read binding, cursor wrapper and project/collection workspace allowlists. The server checks authority before selection and again before returning the page. This read performs no recovery mutations.

## Shared paths and overlap boundaries

| Area | Producers, copies and consumers that must agree | Scope separation |
| --- | --- | --- |
| MCP binding/schema | `McpRequestBinding`, validation/serialization, memory/file/SQLite stores, legacy import, service dispatch, task executor and HTTP/stdio wrappers | Preserve all existing digest and replay semantics. New metadata is additive and versioned. |
| Spawn fence | Route validation, pre-reservation refusals, recovery validation, account-row import/gap handling and reservation callback | Reuse the existing fence decision. No structured-host or runtime-host lifecycle repair. |
| Pipeline admission | MCP create, awaited preflight, final store callback, busy queue fallback, queue status reader and queue drain, proactive reservation | Carry the original creation identity through every deferred writer. No producer replacement, publication retry or ticker changes. |
| Authority | Capability/native authentication, caller memoization, workspace wrapper, active seats, historical revocations, replay and late result return | Refresh authorization through existing sources. No new role mapping or account grant. |
| Read and reconciliation | Scalar writers, migration/import, indexed selector, cursor owner binding, serving-release startup/demotion | Keep unknown history intact; never delete tombstones on a timer. |

Actual concurrent diffs were read from their worktrees against their own merge bases. The native relay repair changes MCP send bindings, relay handoff, the relay HTTP route and conversation reservation guards. It owns that handoff. The producer repair changes publication-repair evidence and retry guards, with an MCP activity annotation. The privacy-worker correlation work changes worker framing/diagnostics and pipeline stage composition. The ticker continuation changes curator cancellation/reconciliation and tick reads; it retains an unknown launch. The launcher deadline work changes CLI/supervisor startup and relaunch deadlines. Their inspected heads and diff hashes are retained privately.

This design touches the shared bindings file only at launch recovery, and the pipeline engine only at creation admission. It excludes those other implementations. If final shared-file changes cannot be separated at those functions, stop the dependent slice for owner coordination. Generic research 403, native relay 403 and privacy-worker timeout remain separate investigations.

## Minimal falsifiable acceptance plan

Run each explicit file in its own DIRECT owned gate runner from a fresh source export, with private HOME, config, temporary and state roots, a closed default control URL and ephemeral fixture listeners. Preserve actual logs and exit records. Keep the source revision, fixture patch and generated client command unchanged between the captured base and repaired head. Use production MCP builders and real durable admissions; a controlled local writer records actual effects. No provider calls or hand-written success envelopes supply acceptance evidence.

| Case | Failing behavior to expose | Required repaired behavior |
| --- | --- | --- |
| Late original | Hold before reservation, reach cutoff, recover, then release old dispatcher. Include deadline minus one, exact deadline and plus one. | Before cutoff remains unknown; fence winner gives not-executed and zero writer effects. Reservation winner returns its one actual launch. |
| Claim crashes | Crash before claim, after claim and after dispatch marker; repeat with owner alive but suspended. | Absent claim stays unknown and writes nothing; expired claimed row closes by CAS; dispatched row needs downstream evidence/fence. Resume the old owner and prove it cannot dispatch after closure. |
| Lost downstream answer | Lose only the answer after real reservation and again after writer execution; restart MCP and Viewer fixtures. | Recover the original IDs; one reservation and writer; repeated and concurrent recovery never creates a replacement. |
| Missing or damaged receipt | Exercise missing, malformed and contradictory MCP/launch/fence records, including loss of a receipt after a real effect. | Missing records alone never yield not-executed. Unreadable or contradictory retained effect evidence keeps uncertainty. |
| Pipeline continuation | Delay preflight and final writer, lose an actual create answer, and hold the busy queue/drain across restart. | Row or queue admission returns its actual pipeline ID. Fence winner blocks both late create and drain. Matching proactive reservations converge without touching another request. |
| Mixed writers | Hold an original in the previous release and a retained queue entry across activation and rollback. | Protocol eligibility follows the original writer; an unguarded possible dispatcher prevents negative closure. Fence-aware continuations remain blocked after replacement or restart. |
| Seat succession | Produce seat activation/revocation through real builders, rotate twice, recover the original through the SDK client; include ancestry beyond 32 rotations. | Only the current proven successor can use predecessor authority. Same-project unrelated worker, wrong project, forged caller fields, broken links and revoked/ABA epochs are refused without leaking IDs. |
| Replacement after await | Place a barrier at each binding/lookup/write/lock wait and replace caller generation or active seat before continuation. Cover original, ordinary replay, explicit recovery, cached terminal return, HTTP reservation and queue drain. | The stale invocation performs no newly unauthorized effect and discloses no result. A fresh authorized successor recovers the original. Removing each final guard must make its replacement case fail. |
| Bounded read | Mix eligible, foreign, terminal, corrupt and suppressed rows; test 0, 1, 50, 100 and 101 candidates, older lineage, concurrent settlement, restart and cursor expiry. | Inspect/decode/byte caps hold; empty suppressed pages advance; every eligible row can be reached; changed caller/project/epoch cannot reuse a cursor. Unrelated history growth adds no row decoding. |
| Largest accepted envelope | Use the eight-MiB HTTP limit, 8,192-element input limit and multibyte content; separately test source-specific prompt/spec caps. | Original digests remain equal; new metadata contains no copied prompt/spec/image body. List and reconciliation select metadata without decoding payloads. Oversize input follows existing admission behavior. |

Extend existing tests first: `src/lib/mcp/stdio.integration.test.ts`, `spawnRecovery.integration.test.ts`, `server.test.ts`, `callerResolution.test.ts`, `pageCursors.integration.test.ts`, `workspaceFence.test.ts`, `src/lib/agent/spawnAdmission.test.ts`, `src/lib/pipelines/engine.creation.test.ts`, and the direct account-store tests for narrowed fence access. Add cases only to files the implementation actually touches; execute only those explicit files. Production schema changes also require the minimum-SQLite test. Record query plans and counted visits/decodes for the read, including a fully excluded dataset.

Implementation finishes with the normal privacy, type, changed-file lint and touched-test checks on the final source/head, followed by the required three review rounds for this risk class. The original design stage ran the isolated recurrence probe and document checks only.

## Source gaps and implementation stops

The historical generic 403 body and request-to-guard correlation were not retained. The exact research original therefore remains unknown; there is no supported authorization to repeat or settle it here. Recovering that live incident depends on an already-retained authoritative request/dispatch record or a separately accepted repair for claimless history. Preserve the current blocker until that evidence exists. A new admission protocol can prevent future recorded claims from sticking without proving the fate of this older request.

At design acceptance, the isolated probe established the spawn admission recurrence and valid recovery. The receiving native-generation reference, successor races and pipeline continuations still required implementation proofs. The receiving route must verify that reference using existing admission evidence; copying relay code or weakening identity is outside this design.

The shared `origin/main` reference advanced during this stage to `fd63c39cef2d015c87b11031e2a5240bf8384a71`. Its added change concerns memory-profile reads and components; it changes none of the claim, dispatch, recovery, seat or queue boundaries cited here. The assigned source stayed at the captured revision. Source citations refer to that revision.

## Deferred — not currently justified

- A new UI, settings, general job ledger, role mapping or external recovery service.
- Automatic resubmission under a different key, cancellation of live writers, runtime/account changes or rewriting historical receipts.
- A shared-cause fix for generic HTTP 403, relay authority loss and privacy-worker timeout.
- Sweeping other projects' history or resolving their live claims from this task.
- Lifetime wall-clock promises through unavailable storage, arbitrary backlog or suspended processes; latency claims await the isolated final measurements.
- A claimless-history closure based on absence alone. Historical ownership and an enforceable effect barrier are prerequisites for a separate design.

## Implementation for review

New eligible claims freeze a two-minute admission cutoff, the original downstream digest and server-derived caller references. Prompt-derived role defaults are retained as selectors into the original input. The binding contains no duplicate prompt, specification, image or arbitrary role-parameter payload. Existing logical request digests and downstream keys remain unchanged.

`src/lib/mcp/launchAdmission.ts` resolves these bindings at `/api/spawn/admission`. The route consumes the existing reservation fence and passes a synchronous caller check through reservation and deferred writer authorization. A previous release without this receiver cannot consume a guarded request. The registry's existing archive retains the first MCP reservation in the reservation transaction, so losing the current receipt cannot turn a past admission into a negative answer.

`src/lib/pipelines/creationAdmission.ts` records immutable admission witnesses and negative fences in `state.sqlite`. SQL guards also reject an older writer that attempts to insert a fenced key. New queued creations use the `.admission` suffix; an older drain that enumerates `.json` cannot execute them. Current queue writers and drains check the original caller under the account-before-pipeline lock order. Recovery releases only the negative claim's matching, unused proactive reservation.

`src/lib/mcp/admissionRecovery.ts` runs under serving-release authority, with a five-second pass budget and at most fifty scalar candidates. Its cursor and retry state survive process restarts. Legacy claims without an enforcing downstream protocol retain their existing uncertainty.

`list_unknown_launch_claims` is an MCP-only read. It derives the project and seat from current authority, returns at most fifty items and 24 KiB, and spends at most one hundred candidate and verification visits. It reads scalar receipt metadata without decoding receipt payloads. Suppressed and concurrently settled rows advance the cursor. Receipt preparation, caller/generation changes and cursor expiry never widen the read into a full-store fallback.

Launch recovery uses the existing revisioned seat projection. It follows proven lineage beyond thirty-two rotations, supports native-to-managed succession, and refuses a revoked designation or reuse of the same conversation under another recorded epoch. Original, recovery and cached-result paths pin current authority; receipt mutations recheck it inside their actual writer. Call-local checks survive the public service and SDK awaits and run synchronously before response serialization, including current workspace grants. The seat projection is keyed by its file revision and the durable alias sources; unchanged reads reuse its current designation without rereading retained seat history.

The production-boundary recurrence is in `src/lib/mcp/stdio.integration.test.ts`. The captured source exits with failure on `unknown` instead of the required negative result and then records one late reservation and writer. The repaired path retains the original key, commits the fence and releases the old dispatcher with zero effects. Adjacent cases cover the receiving native identity, deferred writer, succession, unsupported receiver and maximum-size multibyte envelope. The queue/read proofs are in `src/lib/mcp/unknownLaunchClaims.test.ts`; bounded reconciliation restarts are in `src/lib/mcp/admissionRecovery.test.ts`. Exact commands, source exports, logs and actual exits remain in private stage evidence.

The generic research 403 and the fate of its claimless original remain unresolved. This implementation changes no live claim and makes no performance-gain claim. Publication and the three required review rounds remain subsequent pipeline stages. Existing failures in the full stdio, spawn-recovery, registry-archive, busy-admission and spawn-route files were also reproduced on the captured source; their logs retain the matching assertions and diagnostics. Focused acceptance cases, receipt-store guards, creation, minimum SQLite, type and lint checks are recorded separately.

## Requirement check

Bounded recovery is served by a persisted admission cutoff and the downstream reservation/queue fence. Actual succession records authorize the current project's successor, with live checks at effects and disclosure. The bounded MCP read exposes only provable project claims and continues past suppressed candidates. The historical claimless original remains an explicitly named dependent blocker. No hard-to-reverse platform choice needs an ADR; the changes extend existing stores and authority boundaries.
