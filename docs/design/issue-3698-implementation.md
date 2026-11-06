# Implementation plan: pipeline source changes through MCP

> Declare the supported source field and replacement guard in the MCP schema. Forward the documented field to the lineage resolver consistently.

Origin: [issue #3698](https://github.com/Latand/delegatus/issues/3698), opened and last updated **2026-11-05 17:45:00 UTC**. This is the public originating requirement verbatim. Its remaining acceptance requires errors to identify the missing field and replacement permission, with a protocol-to-handler regression for forwarding, replacement and unchanged lineage after refusal.

## Evidence and decision

Read the complete issue body and paginated comments on 2026-11-06, then repeated both reads before drafting: **zero comments**, issue still open. The assigned source and remote main were both `423bf964ed98d9dde744ad0f2c4f2dbf92ae146b`. The earlier intake at `b728d185`, `docs/audits/recent-issue-intake-2026-11-06.md`, and its primary follow-through matrix at **2026-11-06 20:32:26.657 UTC** were read as investigation leads. Current source and the isolated observations below establish this plan independently.

Build this narrow repair. Use **`src` as the single public MCP field** and retain **`srcPath` in the existing internal setter and stored record**. Creation already advertises `src`; the shared lineage resolver's missing-field error also names `src`. Translate once in the `set-src` binding. No storage migration or alias registry is needed.

Observed on the unchanged base through the actual SDK client, MCP server, service, binding, `patchPipeline`, and SQLite store:

| Input or boundary | Observed result |
| --- | --- |
| `tools/list` for `pipeline_action` | None of `src`, `srcPath`, `overwrite` is declared. |
| `set-src` with `src` | `tool_failed`, retryable, “pipeline creator lineage is required; pass src”; serialized pipeline state unchanged. |
| Same source with internal `srcPath` | Success; stored path and creator conversation change. |
| Identical successful request and key | `replayed: true`; serialized pipeline state unchanged. |
| Binding given a throwing `context.assertCaller` | Callback invoked zero times; action succeeds. |
| Injected SQLite commit error | Error and rollback; source remains absent. This does not establish writer-wait safety. |
| Real second SQLite connection holds `BEGIN IMMEDIATE` before persistence; authority changes before it releases | Setter succeeds and stores the new creator after authority has become invalid. Six earlier guard calls do not prevent this write. |

The final observation ran at **20:52:40 UTC**, Bun **1.4.0**: three characterization tests, eight assertions, exit **0**. Passing characterization means the defects were observed; it does not mean the desired behavior passes. A first fixture run failed before dispatch because an empty graph used the default provisioning state. The corrected fixture uses the production builder's explicit draft state.

The harness uses controlled transcript eligibility, conversation lookup and deputy lookup ports. It exercises the real resolver, protocol, persistence and SQLite contention. Production transcript-root recognition, native authentication and a deployed installation were not tested here. Preserve the private harness, launch script, all four logs and manifest under `$LLV_EVIDENCE_DIR/source-contract-probe/`. The assigned checkout has no probe files.

## Contract and exact scope

Public call: `pipeline_action` with `pipelineId`, `action: "set-src"`, `clientRequestId`, a nonblank string `src`, and optional boolean `overwrite`. Existing response options remain available. `overwrite` defaults to false. A missing or invalid `src` identifies `src`; a replacement without `overwrite: true` retains the existing conflict. Neither flag nor source text grants caller authority.

Add optional typed `src` and `overwrite` properties to the existing tool object because other actions do not require them. Validate the action-specific combination in the binding as well, so direct service calls cannot bypass it. For `set-src`, admit only its operation fields and the existing response options (`full`, `compact`, `includeHints`); transport-owned native proof is consumed by the existing transport. Reject unknown operation keys, including supplied lineage identifiers and MCP `srcPath`, before invoking the setter. Reject both spellings together without choosing one. The error for `srcPath` directs the caller to `src`. Other actions retain their existing argument handling.

The internal `PatchPipelineRequest.srcPath` remains valid for the controller, HTTP route and direct engine callers. This deliberately closes an undeclared MCP spelling demonstrated by the probe. It leaves the established internal API intact. There is no guessed rename of persisted fields and no automatic adoption from the current caller when `src` is missing.

### Producer and consumer inventory

| Boundary | Current contract and planned treatment |
| --- | --- |
| MCP schema, `server.ts:4380` | Advertise `src` and `overwrite`; retain the tool object's existing action enum and unrelated properties. |
| `pipelineAction`, `bindings.ts:2658`, and registration near `8678` | Check the action's input; construct internal `{action: "set-src", srcPath: src, overwrite}`; keep the receipt key and response options in their existing layers. Pass a current-authority callback through the existing fifth `patchPipeline` argument. |
| `resolvePipelineCreatorLineage`, `engine.ts:15310` | Preserve accepted roots, native Claude mirror normalization, conversation lookup and deputy-to-seat conversion. No new resolver. |
| `patchPipeline`, `engine.ts:16816`, current setter near `17184` | Restrict the transactional repair below to `set-src`. Preserve all other actions. |
| `types.ts:1556`, HTTP `api/pipelines/[id]/route.ts` | Keep the internal `srcPath` request and existing HTTP admission. No edits planned. |
| `store.ts`, `buildPipeline`, decoding and cloning | Retain `srcPath`, `srcConversationId`, optional `srcDeputyConversationId`, and null/absent conventions. No schema or history rewrite. |
| Other producers | `create_pipeline`, task assignment lineage, creator-path refresh after conversation movement and deputy attribution keep their behavior. |
| Readers | Creator checks for decisions/conversions, stage source selection and spawning, source-target matching, projections, pipeline reads and delivery attribution continue reading the same fields. Historical attempts, journals and creator references already copied into them are untouched. |

## Smallest mechanism

### Binding authority

Keep workspace checks and the revoked-seat check. The general MCP dispatcher does **not** construct `assertCaller` for ordinary `pipeline_action` requests: its automatic session callback belongs to recoverable tools. Forwarding the optional context alone therefore cannot meet this requirement.

For `set-src` only, capture a server-derived caller snapshot at binding entry and make a synchronous assertion closure. Use the current `attentionAuthority()` result directly for revalidation, together with the existing read-only registry lookup for that conversation's latest generation. Pin authority kind, conversation, native proof when present, generation id/path, project ownership and workspace principal; refuse an unidentified, superseded or archived caller. At each assertion compare against the pinned caller, call the existing workspace assertion and recheck seat revocation. Also call `context.assertCaller` when supplied. Do not accept identity fields from arguments and do not turn this into a creator-only permission rule: current authorized workers keep their existing permissions.

Add a `set-src` branch to the binding's existing `authorizeReceipt` hook so malformed requests, unidentified callers and revoked seats are refused before a cached answer is returned. Repeat the fresh snapshot check in the dispatch binding; preserve existing receipt keys, digest rules and retention. Keep this closure local to source editing. The richer `recoveryCaller` in the overlapping #3710 change already reads equivalent generation/workspace evidence. If that accepted implementation is present at integration, reuse its fresh snapshot mode without predecessor discovery. Do not copy its admission, recovery, receipt indexing or launch machinery into this change. The required behavior and compared identity fields are the same in either integration order.

### Setter transaction

The existing `scopedMutation` invokes its assertion before `persist()`. `SqliteStateCollection.mutate` then awaits writer admission in `stateTransactionAsync`; the real contention probe demonstrated that its later retry can commit without another caller check.

Move only the `set-src` branch onto the already imported `withDeliveryMutationAsync` primitive. Its `boundedPatchAsync` waits before entering a synchronous transaction. Use a budget of **two row operations**: `tx.get(id)` and at most one `tx.put(pipeline)`. Its helper and transaction body were inspected: this use writes only the pipeline collection; no delivery claim, relay or API is created by calling the helper.

Inside that callback, check target existence, the existing retired-definition refusal and applicable request-shape guard. Resolve the source using the existing synchronous resolver. Check boolean overwrite and the existing `hasLineage`/`sameLineage` rule against the freshly read row. Immediately before modifying the three lineage fields and calling `tx.put`, assert authority again. There is no await between that check and the write/commit. Delete a stale deputy field exactly as the current setter does.

Assign this action's result to the existing `patched` result path so the existing post-action controller notification remains intact. Remove its old branch from the generic mutation callback. Leave the shared `scopedMutation`, store implementation and every other action unchanged. Preserve the existing no-overwrite success for an identical lineage; do not add a different equality or ownership policy.

This avoids extending the shared store API or moving every pipeline mutation. It makes no performance claim. The two-operation budget counts target-row operations, not all internal validation reads.

## Keep-list and overlaps

The forge inventory contained 23 open PRs when read. Actual changed-file records identified four published PRs touching these three source files. Local worktree diffs were also inspected, including unpublished work.

| Owner/change observed | Actual functions or hunks | Integration recommendation |
| --- | --- | --- |
| #3720, lane `3aa23777`, base `423bf964`, design document only | Board read project-name resolution and schemas; its final observed design requests a decision for board-only response/replay and workspace extensions. No product source diff or `pipelineAction` edit exists yet. | Preserve its pending scope decision. Integrate accepted board-read changes first as requested, then re-read its final diff. This plan grants no extension to that lane. |
| Published PR #3710, head `edb2bf06`, local checkout clean | `createPipeline`, launch recovery/binding helpers, `recoveryCaller`, `createMcpToolService`, receipt stores, response authority and `createViewerMcpServer`; engine changes are creation/admission. Current diff does not alter the `set-src` branch or its schema properties. | Preserve that owner's hold and recovery budget. Integrate accepted shared identity functions through its owner; recheck the source-action closure against the final caller snapshot. Do not edit its admission/recovery functions. |
| #3715, lane `828da1d1`, final observed local commit `ece4cc79`, unpublished at recheck | Engine import plus `passedPublicationParkDetail`, `retryRefusedPublication`, `recordSettledPublicationFailure`, `requestStagePublicationRepair`; publication history and types elsewhere. | The move from `09dd2aaf` to `ece4cc79` adds settlement-test alignment and inherited hold changes, with no change to these shared source hunks. Preserve publication classification; recheck the published head when it exists. |
| Published PR #3585, head `d58c4c0a` | `TOOL_DESCRIPTIONS.telegram_bot_send_document` only in shared `server.ts`. | Preserve Office document description; no textual setter conflict. |
| Published PR #3668, head `25783bad` | Integration lifecycle, `startPipelineIntegration`, and `renewIntegrationDecision` within `patchPipeline`'s shared persistence wrapper. | Preserve shared wrapper; route only `set-src` to its own bounded transaction. |
| Published PR #3663, head `0f920233` | `spawnRunStage` worktree recovery. | No setter overlap; preserve recovery. |
| Unpublished refresh checkout for PR #3637 | Creation schema, publication inspection and start/retry/publish arms of `patchPipeline`; also an account-limit binding. | Re-read at integration; preserve those arms. No current source-setter hunk. |

A retained local checkout also showed all three files deleted. This was recorded as local checkout state, with no inference that a source-editing owner intended those deletions. Do not recover, clean or import that checkout.

Sequence functions, not entire filenames: accepted #3720 board reads; compatible integration with #3710 caller authority; this lane's source schema and `pipelineAction`; this lane's setter transaction; independent publication and Telegram description hunks. Re-read current issue/comments, main and these owner diffs before the builder edits and before final review. A moved overlapping implementation requires a fresh comparison.

Keep pipeline id, task links, branch/worktree, delivery owner/epoch, graph, cursor, attempt history, review budgets, publication classification, recovery/admission and seat history unchanged. No UI, deployment, restart, production source adoption, board mutation or message replay belongs to this lane.

## Acceptance and per-file checks

Add `src/lib/mcp/pipelineSource.integration.test.ts` as a durable protocol regression suite, using existing SDK transport and HTTP fixture patterns. It is a test suite, not a capture driver. Start from production pipeline builders and registry builders; adapters must forward every `patchPipeline` argument, especially actor, authority assertion and workspace identity. Use SQLite receipts and real pipeline persistence. Exercise the real MCP HTTP route on port zero with admitted fixture identities, plus direct binding/controller calls where the boundary itself is under test. No live installation or model call is needed.

| Required check | Observable acceptance |
| --- | --- |
| Advertised contract | `tools/list` declares the public source and boolean replacement flag; SDK calls actually consume them. Test schema shape and behavior, not description phrases. |
| Successful adoption | Empty-lineage draft and retained closed lane adopt a registered source; path/conversation/deputy match resolver output after reopening the store. Other row fields remain equal. |
| Replacement | Different source without overwrite, false overwrite and malformed overwrite leave the entire row and revision unchanged; explicit true replaces it. Same lineage succeeds without true. |
| Invalid input | Missing, blank, wrong-type source; forbidden root; unknown conversation; unknown pipeline/action; unsupported source spelling, conflicting spellings, arbitrary extra key and fabricated lineage ids all refuse without pipeline changes. |
| Identity and permission | Current authorized native Codex and Claude fixtures succeed. Unidentified/revoked callers and forbidden workspace/target/source refuse. `overwrite: true` never overrides authority. Preserve the current worker/seat permission matrix. |
| Final await | Hold a real SQLite writer lock, start the request, replace caller generation or revoke its workspace/seat authority, then release the lock. It refuses and stores nothing. A fresh authorized request then succeeds. In a separate control, change the caller during the final synchronous source-lookup callback; remove the assertion immediately before `tx.put` in a scratch export and require that control to fail. The writer-wait case must also fail if the transaction assertion is omitted. |
| Replay and concurrency | Identical key/arguments replay before and after receipt-store reopen; count setter dispatches and persisted revisions to prove one effect. Concurrent duplicate keys also have one dispatch. Changed arguments with the same key conflict. Two different source requests without overwrite cannot both replace one existing lineage. |
| Normalization | Registered Codex source, accepted Claude native/shared mirror and deputy source resolve through production lookup; deputy adoption and later ordinary-source replacement retain/remove the deputy field correctly. |
| Compatibility | Direct controller and HTTP calls retain internal `srcPath`; unknown/malformed direct inputs leave state unchanged. Neighboring pipeline actions and creation keep their prior contracts. |
| No false recovery promise | A lost response after a completed durable receipt can replay. An interrupted unsettled `set-src` remains governed by existing uncertainty behavior; this lane adds no redispatch/recovery mode. |

Per-file implementation checks, each in a separate owned invocation:

- `src/lib/mcp/pipelineSource.integration.test.ts`: all protocol, persistence, identity, concurrency and writer-wait cases above.
- `src/lib/pipelines/engine.creation.test.ts`: retain existing direct `set-src` closed-history/overwrite coverage; add direct controller contention and unchanged-row refusal cases here when they do not belong to the protocol suite.
- `src/lib/mcp/bindings.test.ts`: only extend if needed for direct argument adaptation coverage that the integration suite cannot observe; run the complete file if modified.
- `src/lib/mcp/server.test.ts`: run for the schema edit; add no prose-presence assertions. Add a behavioral case only if the integration suite cannot cover the schema boundary.
- `src/lib/mcp/pipelineRoleFence.test.ts` and `src/lib/mcp/workspaceFence.test.ts`: focused neighboring authorization checks; verify their current fixture coverage before running. Both files exist at the observed base; retain the exact authorization cases that cover this action.

Use a fresh tracked-source export with dependencies linked read-only. Use `checkEnvironment` and `isolatedEnvironment` with the stage-owned scratch root, isolated HOME/config/state/temp roots, absent runtime sockets and control URL on port 1. Run `bash <assigned-gate-slot> bun test <one-explicit-test-file>` with one log and actual exit per invocation. Use the direct gate policy: no recorded-check handoff or unknown verdict adoption. Preserve failed base observations separately from corrected fixture runs. Run no broad directory suite, standalone typecheck or build in this stage. Normal publication hooks remain required later.

Architecture validation: the existing privacy publication checker passed for this document with committed known-value fingerprints, and the whitespace check was clean. The final assigned source and remote main remain `423bf964`; only this declared document is added to the worktree. Implementation must establish failing desired-behavior tests on the base and passing tests on the final integrated head; the architecture probe supplies only base characterization. Retain the prescribed three independent review rounds and terminal recheck policy. Source merge readiness and installed acceptance remain separate; this stage supplies neither a deployment nor task completion.

## Risks and alternatives

- Advertising `srcPath` instead would preserve the undeclared successful input but leave the shared creation vocabulary and error guidance inconsistent. The public `src` mapping is smaller and follows the reported call.
- Forwarding only `context.assertCaller` misses ordinary action calls and the measured SQLite wait. The binding snapshot plus transaction-local check addresses both observed boundaries.
- Adding a shared store callback or a general action alias/recovery framework would expand this repair across unrelated writers. The existing bounded transaction confines it to one case.
- Authority snapshot reuse must follow the final #3710 implementation; no cached caller result can stand in for fresh generation evidence. A field or authority-source mismatch is a review finding.
- Closed retained pipelines remain editable as before. Archived storage remains outside this setter. The transaction must retain current missing/retired-target refusals and normal store validation, including terminal delivery normalization.
- Existing receipt replay proves completed-call idempotency. It does not establish exactly-once recovery after an unreceipted commit, and this plan makes no such claim.

## Deferred — not currently justified

General action-schema redesign; public aliases; stored source-field renames; source inference for `set-src`; new creator-only authorization; migration of historical attempts or seat lineage; admission/recovery/classification redesign; new uncertain-call recovery; UI/prototype work; performance claims; live-state correction; deployment and installed acceptance.
