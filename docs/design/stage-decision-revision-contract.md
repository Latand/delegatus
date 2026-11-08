# Stage decision revision contract

Originating requirement: accepted board requirement, 2026-11-03. Public English
paraphrase: accept an answer to an unchanged settled decision after unrelated
pipeline bookkeeping progresses. The original operator turn is unavailable;
the board record is secondary evidence, and no recovered quotation is claimed.

## Source and scope

Design observation: 2026-11-08. Checkout, local main and forge main are
`991c1162824e39c8e1b80df985083bfdb0f7278b`. The complete accepted audit,
`docs/audits/stage-decision-revision.md` at controller commit `aa41a7de`, was read,
including its final amendments. Its three recovered refusals establish the
symptom; their reads occurred at different times. The historical hidden writer
and current serving revision remain UNKNOWN. A retained deployment is historical
evidence. This document records a contract; behavioral acceptance remains pending.

Add one computed `decisionRevision`, with a small pure projection/hash primitive
beside `pipelineRevision`: `pipelineDecisionRevision(Pipeline): string | null`.
It reads no external store and mutates nothing. Submit it through existing `expectedRevision` for
`resolve-decision`. Keep the full-record `revision`, its algorithms in
`store.ts:45` and `mcp/listAnswers.ts:40`, and every other action unchanged.
Persist only the already-supported full matched hash in
`PipelineDecisionAnswer.expectedRevision` (`types.ts:367`). There is no token
ledger, new schema, migration, retry policy or UI.

## Identity and canonical form

All paths compute from one unredacted, unoverlaid pipeline record. Select the
cursor stage and `latestOperationalStageAttempt` (`attemptSelection.ts:3`), with
the selected run's actual array length. An explicit stage/attempt read gets a
token only when it selects that same operational attempt. Historical rows,
another stage, missing cursor/run/attempt and an unsettled or ineligible decision
get no token. Eligibility is the existing settled run decision or recognized
publication/custody park (`engine.ts:5034–5055,16522–16532`); it grants no
exemption from later admission refusals.

Hash UTF-8 `JSON.stringify` of the following explicit projection with domain
`pipeline.resolve-decision` and integer `v:1`, using the existing SHA-256 primitive.
Return 64 lowercase hex characters. Object keys, recursively, use code-point
lexical order; arrays retain source order; absent optional leaves become `null`.
Retain strings byte-for-byte, including empty strings, question/answer whitespace,
paths and timestamps. Retain false and zero. Do not sort histories or normalize
text, paths, identities or timestamp precision. Do not hash undeclared properties,
redacted text, display prefixes or an entire pipeline/attempt spread. Typed
aggregate names below include their declared fields at this source pin.

Here `P` is the record and `A` its selected attempt. This is the
complete v1 keep-list; external authority reads are separately specified below.
The root keys are `domain,v,pipeline,stages,attempt,repairProducer,reviewRuns,custodyRuns`.
Preserve source property names/nesting within each group. Put selected run length
at `attempt.runLength`, and last edit sequence at `pipeline.graphEditSeq`.
`repairProducer` is `{stageId,attempt}`; run projections are `{stageId,attempts}`,
with each custody attempt retaining `n,activation,unresolvedTermination`.

| Projection | Exact source fields | Consumer / reason |
| --- | --- | --- |
| Outcome and requirements | `P.id, project, task, taskIds, finishesTaskIds, spec, inputContext, srcPath, srcConversationId, srcDeputyConversationId, workspace, creationRequest, proactiveTaskIds, decisionAnswers` | `renderStagePrompt`, creator attribution, task/launch membership, prior accepted answers. `inputContext` contains only `taskDetails, skillPaths, handoffDigest`; workspace contains `memberId, workspaceId`. |
| Checkout and accepted heads | `P.repoDir, worktreeDir, branch, baseBranch, baseRef, baseRefPinned, lastPassedCommit, publishedCommit, publication, refreshOf` | Existing input, publication and native-launch targets. No filesystem read is part of hashing. |
| Control and cursor | `P.state, pausedState, pausedAt, pause, resumedAt, controlGeneration, closedAt, hiddenAt, activationCloseRequested, remoteAction`; complete `P.cursor`; last `graphEdits.seq` or null | Pause/close/remote control and graph-edit identity, including an edit that restores old content. Cursor carries `stageId,state,input,activatedBy,launchedBy`. |
| Definitions | In stage-array order, every stage's `id,kind,runtime,role,engine,model,effort,serviceTier,preferredServiceTier,agentMemoryMaxBytes,access,sandbox,outputs,account,prompt,next,onFail,effectiveRole`; selected `A.definition, effectiveRole`; selected run length | Next attempt uses current stage configuration. Bound producer definition stays distinct. `stageDigestInput` alone omits access/sandbox/outputs (`stageDigest.ts:40`), so it cannot replace this row. |
| Decision and producer | `A.n,historical,legacyReview,state,input,output,verdict,report,startedAt,completedAt,error,decisionRequested,decisionAnswerId,launchId,conversationId,sessionId,agentPath,paneId,accountId,hostEpoch,runtimeEvidenceSince,runtimeAccountPin,executionRuntime,cloud,flowId`; setup `command,cwd,hash,state,startedAt,completedAt,code` | Question, report/verdict, completion and producer identity. Retain the typed report, including attribution, sequence, provenance and exclusions; a pending provenance update is relevant evidence. |
| Referenced repair producer | Resolve `publicationRepairWorker` exactly (`engine.ts:5713`), otherwise A; retain its stage id and `n,historical,launchId,conversationId,sessionId,agentPath,paneId,accountId,hostEpoch,startedAt,completedAt,runtimeEvidenceSince,runtimeSwitches,definition,effectiveRole` | An earlier attempt explicitly referenced by the current repair is relevant. Its engine/path/start bound `stageRepairEvidence`; never substitute a different worker. |
| Attempt authority and cut custody | `A.activation,suspension,runtimeSwitches,accountHolds,usageLimitedAccounts,providerWait,restoreContinuation,restartRecovery,restartContext,severedTurn,roleMemoryDelivery,roleMemoryDispatchWait,startupOwnerWait,unresolvedTermination,priorWriterStop,branchAdoption,backgroundWait,verdictRequest,verdictRecovery` | Existing launch/cut, delivery, termination and pending-work evidence. These records can prevent another producer or continuation; they are retained conservatively. |
| Attempt budget and accepted work | `A.activatedBy,launchedBy,budgetSpent,reviewedHead,expectedReviewHeadSha,reviewHeadSha,acceptedForReview,publicationIntegration,providerRecoveryBudget,providerFallbackRetries,spawnAdmissionBudget,spawnCalls,fencedMessageRetries,excludedRecordedChecks,memoryCap,controllerWait,memoryWait,remoteHeadWait,settlementPreparationWait,settlementAdmissionRetry,spawnInterruptionRetry,stageCommitWait,pullRequestInspection,roleMemoryFailures`; review-flow sync `generation,sourceRevision,roundCount,implementerHeadSha,reviewerHeadSha,verdict,relayState,terminalState,hostClaim` | Fixed review lineage and already-spent operational allowances. A changed counter or original cutoff invalidates the token. Sync observation times/lag are excluded. |
| Publication decision | `P.stateDetail` only for a recognized publication/custody park; `A.commitRepair,publicationRepair,publicationRepairAbandonment,publicationRetry,publicationTextRepair,terminalOutputPublication`; `P.publicationAdmission`; delivery projection below; recovery record keyed by `delivery.operation.sha ?? A.publicationRepair.sha ?? P.lastPassedCommit` | Publication question and original repair operation/cutoff. Retain that keyed `P.publicationRecovery` record in full, including failures and history; other heads' histories are excluded. |
| Delivery | `P.delivery.target,disposition,publish,ownerId,epoch,active,releasedAt,settledFailure`; complete typed `delivery.operation`, including reservation/key/fence/deadline, executor identity and both result locations | Target, publisher permission, ownership epoch and successful/unknown operation evidence. Delivery journal prose is excluded. |
| Review budget evidence | `P.reviewPending,reviewGrants,reviewAcceptances,legacyReviewConversions`; for every run in order: `stageId`, and each attempt's `n,historical,legacyReview,activatedBy,budgetSpent,reviewedHead,state,completedAt,verdict,reviewHeadSha,expectedReviewHeadSha,acceptedForReview` | `failEdgeBudget.ts:7,50,75,101,112` derives limits, distinct source activations and terminal rechecks from history. Counts alone lose identity. |
| Outstanding control custody | `P.closeTeardown,unconfirmedHosts,pendingReviewFlowCleanup`; every run/attempt's `activation,unresolvedTermination` paired with stage id and attempt number | Existing activation/survivor refusals remain observable even outside the selected attempt. |

Question text follows the existing consumer exactly: publication/custody uses
`P.stateDetail`; ordinary decisions use `A.output ?? A.report?.summary ?? ""`
(`engine.ts:16549`). The projection retains both candidate sources. A changed
question, definition, attempt, report, requirements, budget, producer or authority
field above changes the token. An absent token never relaxes validation.

Recognized irrelevant changes are `terminalReap` progress alone; `pos`,
`dismissedAt,dismissedNote,dismissedBy,attentionRoute,restored,workLinks`;
`taskFinishes,taskFinishWaits`; delivery journal additions; unrelated attempts'
bodies outside the listed budget/custody/repair-producer projections. These have no input to answer selection, `newAttempt`, or
the guards cited above. In particular `engine.ts:13315–13377` can settle an
earlier host by changing only `terminalReap`; this changes the full revision and
preserves the decision token. A reap that adds unresolved custody changes the
custody row or triggers a fresh refusal. No blanket exclusion of ownership,
budget or all controller-written fields is permitted. Unlisted attempt diagnostics
such as setup stdout/stderr and `providerRecoveries` prose do not
become token payloads; their live admission predicates still run.

## Read, write and replay matrix

| Surface | Required behavior |
| --- | --- |
| MCP compact/stage/full `get_pipeline` (`bindings.ts:6120–6162`) | Add top-level optional `decisionRevision` from the original record before text projection/redaction. All three agree for one snapshot. Full records remain unchanged. Stage reads explicitly select their attempt before adding the token. |
| HTTP detail GET (`route.ts:74–100`) | Same helper and same captured record; return full hash. Queued/absent/ineligible records have no token. Collection/list reads acquire no new answer authority. |
| MCP schema/binding (`server.ts:4388,4416`; `bindings.ts:2659`) | Keep wire fields; describe the resolve-only token choice in schema, type comment and seat hint. Forward all args, attributed actor, authority callback and member scope. Do not select a newer attempt or replace supplied guards. |
| Fresh engine admission (`engine.ts:16490–16574`) | Resolve against the set of current decision hash and current legacy full-record hash, then run existing stage/attempt and all eligibility/custody/budget/producer guards. An unmatched revision returns 409 `STAGE_CHANGED`, field `expectedRevision`; an ambiguous prefix returns `short_id_ambiguous` for that field. Missing/malformed guards remain 400. |
| Canonicalization (`bindings.ts:8681–8704`, `shortIds.ts:23–39`) | Use `resolveShortId` over distinct full candidates. A 7–63 digit prefix must select exactly one; a 64-digit input must match completely. Case is immaterial for hex only. On an accepted key the sole revision candidate is its retained hash; never replace it with today's token. Canonicalize the digest and engine matching with the same rule. |
| Durable answer / MCP receipt | Store the exact matched full hash; decision hash and legacy hash remain distinct logical arguments even if both describe one decision. `requestDigest` keeps all other caller args. Full/displayed forms of one retained hash replay identically; changed answer/stage/attempt/full hash conflicts. Mutating receipts have durable retention (`server.ts:1730–1763,2277`). |
| Replay, join, restart, lost answer | Authorize the original attributed caller against the current target and recorded answer owner before receipt access and again after waits. Exact accepted replay returns its original result, without a second answer/attempt/launch. It need not match the advanced pipeline's new decision token. A stale unaccepted request still fails fresh admission. A reference rebound during the invocation, foreign actor, revoked seat or lost workspace discloses no private result and leaves another owner's receipt intact. |

Retain existing HTTP and MCP error envelopes, answer redaction and changed-fields
acknowledgements. A historical stage read can still return the ordinary full
revision, but it never acquires the current decision token; its historical
stage/attempt guards cannot answer a replacement. There is no automatic stale
retry, latest-token substitution or prefix-first winner selection.

## Action authority and effects

The hash identifies record semantics. It conveys no permission. Before this
action awaits, capture the resolved pipeline id/project/creator/workspace and
original target, plus the server-attributed actor, its authenticated generation
and its actual authorization route. For agents retain conversation, native proof
when present, deputy-to-seat attribution when used, and the selected project
seat's conversation/epoch and applicable revocation evidence. For HTTP retain the
admitted operator session or member id/workspace and its current grant. A new
invocation may use the newly authorized seat; an in-flight invocation cannot
silently switch to it. Existing creator/seat/operator rules remain authoritative.

| Existing seam | Exact recheck / effect rule |
| --- | --- |
| MCP `authorizeReceipt`, scope, claim, join and final output (`server.ts:2912–2955,3521–3560,3621,3734`) | Allow this action's existing `authorizeReceipt` to return its invocation-local synchronous assertion (currently the return type is void). Preserve void for other bindings. Call the returned assertion after each awaited authority/scope/claim/join/completion/recovery read, before canonicalization, replay disclosure, binding invocation and final return. Compose it with the existing trusted `context.assertCaller` and pass that context through the production pipeline binding into `patchPipeline`; never accept it in wire args. Pass it to receipt `beforeClaim`, which runs under the store lock (`729,1732,1975`). Limit behavior to `pipeline_action/resolve-decision`. |
| Fresh authority sources | Re-read original caller generation from current production sources and the original project's seat/revocations; call existing decision authorization for the captured actor and key. `attributionOf`/`authorityOf` are per-call memoized (`bindings.ts:1205`, `callerContext.ts:52`); calling them again is insufficient. Use the existing fresh-source pattern in `recoveryCaller` (`bindings.ts:8058`) without its memoized non-native shortcut. Recheck the captured workspace principal and account permission through current durable grants. Unreadable authority refuses. |
| Receipt refusal/cleanup | Pre-claim authorization writes nothing. After a wait, a changed caller receives a refusal before disclosing/joining/settling/releasing someone else's result. Preserve existing digest/claim ownership CAS. `resolve-decision` is an interrupted-recoverable local action (`server.ts:303`); it currently has no generic recoverable-tool binding and no `localBinding`. Do not invent one or claim that its null local-binding fields establish caller custody. |
| Mutation admission and producer reads (`engine.ts:16844–16860,17123–17172`) | Recheck after the state-lock wait and each producer-evidence await. Keep original stage/attempt/producer, repair key, cutoff and delivery target. Re-read the original target, compare the pre-mutation projection and invocation authority, then evaluate current guards. Refusal writes no answer or successor. HTTP passes the same request-bound assertion into existing `patchPipeline` callback; member scope alone does not revalidate an operator session. |
| `resolveDecision` / `newAttempt` / persistence (`engine.ts:16549–16574,4119,16849`) | Keep an immutable pre-answer snapshot separate from the candidate. Recheck after `newAttempt` and synchronously at the actual durable write, including writer waits. The current wrapper checks before awaiting persistence; narrowly forward this action's assertion through `withPipelineMutation` to existing `SqliteStateCollection.mutate`'s `beforePersist` (`sqliteStateStore.ts:2673,2985,3001,3022`), preserving structural checks. Compare durable original identity with the snapshot, using the matched decision projection or legacy full-record mode, rather than comparing the mutated candidate with its old token. Persist answer, relay and one fresh attempt atomically. A failed guard discards the candidate and never patches a replacement. |
| Activation and native dispatch (`engine.ts:7756,7847,8437,924–1040`) | Resolve the successor's retained `decisionAnswerId` to its original answer/actor; recheck its current authorization. Capture reservation identity and original target before preparation, then retain them through account selection, Git/privacy preparation and activation CAS. Recheck successor identity, owner/epoch/target/publication permission, control and workspace after every await and synchronously before dispatch. Reconstruct checks from existing answer/activation/receipt records after restart; do not persist callbacks or reselect targets. Publication/unknown receipt custody remains lookup-only. |
| Actual engine effect | `defaultStartHost` (`structuredSpawn.ts:2226`) awaits access/memory preparation; each native host also awaits startup work. Add an optional invocation-local `StructuredSpawnInput.assertCurrent: () => void`, composed with existing `authorize`, to carry the captured synchronous assertion to `spawnManagedEngine(..., assertCurrent)` (`agentSignalSandbox.ts:53,446,459`) and send guards. Codex options already expose `assertCurrent`; forward the same optional callback through Claude options to that seam (`claudeStreamBrokerHost.ts:981`). The current missing forwarding is an explicit implementation gap before native proof. Check guarded signal-sandbox fallback and ordinary launch; add no durable field. |

Fresh checks retain terminal-budget, settled-verdict, runtime-switch, activation,
survivor, termination, producer-repair and rollback refusals. Keep successful
publication receipts, producer cutoffs and UNKNOWN dispatch outcomes. Replays
never reopen admission. A post-acceptance revocation can stop the reserved launch;
it cannot undo the original durable answer or authorize another attempt.

## Existing harness mapping and required proof

These are additions to existing files, with production builders and unchanged
producer calls. No runtime check was executed for this design.

| Case | Existing seam and required observation |
| --- | --- |
| Positive recurrence | `resolveDecision.test.ts:169` `parked()` drives create/report/end-turn/tick. Add a real earlier completed stage and deferred terminal reap, using `terminalReap.test.ts:1378,1402` resident/active maps and controller tick. Prove actual earlier-host settlement changes full revision alone; then answer through production binding/service and HTTP. Exactly one fresh attempt reaches a real consumer and one launch. |
| Changed identity / evidence | Same parked fixture; separately replace each projection row, including run length, historical selection, question/report, requirements, budgets, launch and delivery fields. Old guards leave zero answer/successor/send and byte-identical replacement. `decisionAuthority.test.ts:55` designation/alias cases and `resolveDecision.test.ts:429` member cases cover fresh and revoked authority. |
| Receipt awaits and replay | `resolveDecision.test.ts:229` `interruptedAnswer` and `267–351` reopen/concurrency cases; defer scope, claim, join and completion using the existing receipt adapters. Repair its adapter at 236 to forward every patch parameter, including authority callback/member scope. Include same/different keys, changed answers, durable acceptance with response-only loss, before-admission restart, exact replay and foreign/reference replacement; one winner and no second launch, legitimate receipt unchanged by refusals. |
| Real MCP wire and prefixes | Production `viewerMcpBindings` plus `createMcpToolService` in that file; extend `shortIds.answers.test.ts:300,332` with the production canonicalizer. Its present local canonicalizer is insufficient. Add a case to `mcp/callerIdentification.test.ts:408`: SDK Client over its existing port-0 HTTP listener and actual tool service/policy/receipts/schema. Test one-snapshot compact/stage/full agreement, historical absence, full/displayed/legacy replay, ambiguous prefix and distinct full hashes. |
| HTTP attribution and awaits | `app/api/pipelines/[id]/route.test.ts:76,205,290` supplies GET, spoofed-actor and deferred-params seams. It currently mocks patching: retain those adapter checks and add the real engine integration to `resolveDecision.test.ts`'s existing HTTP/member cases. Hold body/params, replace session/principal, then require refusal before mutation. |
| Producer/persistence waits | `publicationRecovery.test.ts:1350` already holds producer reads outside the lease; extend each evidence port and original-identity assertion. `engine.ports.part2.test.ts:1035` holds the mutation lease. Test replacement at `newAttempt`/writer admission using these same ports/store adapters. Preserve every method, argument, callback and caller field in fixtures. |
| Account, Git/privacy, activation | `engine.ports.test.ts:134,1304` exercises default production ports and admission phases; `engine.ports.part2.test.ts:1082` holds account mutation; `engine.fixture.ts:84,219` supplies wrappers. Fix wrappers that drop authority or prompt/phase callbacks. Hold each await and replace original authority before resume. |
| Native effect and configured fallback | `runtime/structuredSpawn.integration.test.ts:961,1309,7041,7789` provides RuntimeJournal, RoundTripHost, real Claude protocol executable and owner cutoff. Connect default pipeline ports through these existing seams to Codex and Claude native `spawnProcess`/send counters. Extend `runtime/agentSignalSandbox.native.test.ts:168`'s missing-dependency fallback with the exec-ack authority guard; the existing case is unguarded and alone proves no such fence. `pipelines/engine.cloud.test.ts:298,951,972` covers configured Cloud-to-local fallback; add revocation before the same local native seam with isolated transport replies. No provider call or inherited real CLI/credential fixture. |
| Crucial-guard control | For each final decision/write/native guard, remove only that guard in a scratch comparison. Its zero-effect test must fail by recording the forbidden write/send/engine exec. Receipt stubs return absent until actual dispatch; an already-delivered stub proves no new dispatch guard. Restore source before ordinary validation. |
| Retained fences | `publicationRecovery.test.ts:287,345,1350` and existing same-head settlement cases preserve success/UNKNOWN and cutoff. `engine.containment.test.ts:88,111` and its budget fixtures retain exhausted terminal FAIL, refused new review grants and failed-head refusal. These cases grant no extra round. |

Before behavioral acceptance, run selected complete existing test files in
separate owned direct gate commands, in scratch exports, with private HOME,
XDG_CONFIG_HOME, LLV_STATE_DIR and TMPDIR, closed control URL and retained logs
under LLV_EVIDENCE_DIR. Use the project's `bun run test <file>` and installed gate
wrapper; no recorded-check custody, unknown-check retries, broad suites, manual
whole-project typecheck or build. Compare only actual relevant failures with the
same base/options. Exactly three review/fix rounds include the native final
terminal recheck; exhaustion parks without budget growth or a substitute lane.

## Overlap and integration constraints

Actual current production diffs were read, rather than inferred from branch names:

| Open work / head | Shared hunk and fence |
| --- | --- |
| #3747 / `9b8f1741` | Adds `refreshExecutionRefusal` before decision handling at base `engine.ts:17148`, and refresh authority at dispatch. Retain its deadline/capacity/continuation checks ahead of answer admission. Its `refreshOf.capacity` and `suspension.capacityYield` require explicit projection coverage if that source lands. Preserve terminal FAIL P1/P2 and max3; this contract repairs none of its separate findings. |
| #3668 / `25783bad` | Schema 5→6 beside `store.ts:45`; `newAttempt` consumes integration repair budget and can return null; `scopedMutation` renews integration requirements/deadline. Direct shared effect hunk. If integrated, include the typed `merge.integration` identity/budgets/binding/batch/deadline and `merge.policyChangedAt`, plus adopted creation keys. Recheck original scope, requirement revision, owner epoch and current merge policy before its existing renewal; token acceptance cannot renew invalid authority. Preserve null/budget refusal and original order. Do not transplant its schema or policy here. |
| #3710 / `edb2bf06` | Shared binding/server imports and claim/replay/release hooks; its changes primarily serve generic recoverable launches. Keep the action-specific assertion in the existing local resolve path, preserve its unknown-launch protocol and owner-bound CAS, and avoid a generic MCP authorization rewrite. |
| Merged #3743 / `5995ba0b` | Keep `engine.ts` same-head successful-publication preservation on undispatched retry, with its separate installed acceptance still owed. |

No shared source hunk is edited in this stage. The shared persistence ordering
with #3668 is a mandatory integration checkpoint before implementation; merging
either open source shape requires re-pinning and explicitly updating this v1
projection/version before tokens are issued for it. No safe composition or test
pass is claimed from reading a diff.

## Deferred — not currently justified

Historical hidden-writer attribution, serving identity, old-lane recovery,
comparison adoption, extra review grants, a new token ledger/schema, automatic
retries, generic authorization infrastructure, new test drivers and UI remain
outside scope. Source implementation is summarized below. Required publication
checks, merge and authorized installed-case acceptance remain pending. The root remains OPEN and the
WORK release/rollout hold remains in force.

## Source implementation

`src/lib/pipelines/decisionRevision.ts` computes v1 from the keep-list above.
The store, MCP projections and HTTP detail route share that primitive. Fresh
resolve admission retains the complete-record compatibility path, stores the
matched full hash and preserves the existing attempt and budget refusals.

Action-specific assertions follow MCP scope, claim, join, binding and reply
boundaries. Receipt completion and release accept optional synchronous callbacks
under their existing locks; other actions retain their previous behavior. A
successful resolve reply must still match the current target's retained durable
answer before replay disclosure or receipt completion. Settling or replaying a
refusal also requires its guarded decision or retained answer to remain current. The pipeline store
forwards the resolve assertion to its existing SQLite persistence boundary.

Decision continuations reconstruct launch authority from the retained answer.
Native recovery pins that record across lazy engine loading, and the synchronous
assertion reaches both native engines, guarded fallback execution and initial
message admission. These additions introduce no persisted token or schema.

Behavioral checks use the existing files in the harness matrix. Review, merge,
installed acceptance and release authorization remain separate requirements;
the root and release/rollout hold remain open.
