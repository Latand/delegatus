# Maintenance window verification

Origin: Codex Cloud (GPT-6.1 Sol), result 03. The supplied patch changes 13
files. It was applied after advancing the owned branch to main at
`800a26ebc10ca2db855d12a71320f75c5f2fb955`.

Verification date: 2026-10-23 (UTC). A final fetch observed main at
`62235181a310ad5783cb0fc0342721772efa7b54`; its intervening changes touch none
of this slice’s files or maintenance implementation. The command table identifies
the exact native main revision tested above.

## Input and fixes

The supplied `03.diff` is 29,703 bytes. Its SHA-256 matches `03.meta.json`:
`1827bc97eb312ca267b7fd39e0045a065849a23a414106d2f3714a22e6671f27`.

Fixes and coverage added during verification:

- Include the following weekly opening when DST removes the first one. Both
  the opening search and controller-check estimate use the same 15-day bound.
- Validate persisted windows on SQLite reads as well as legacy JSON import.
  Malformed windows leave maintenance off. The curation timer retains its
  independent defaults and validation. Read validation leaves unrelated stored
  rows unchanged.
- Share the dispatch window check, including the check after asynchronous
  evidence preparation. Disabled or malformed maintenance settings hold undispatched claims. Already
  submitted receipts remain recoverable.
- Preserve the compact MCP byte budget and existing fields by omitting empty
  new window metadata on unrestricted compact reads. Configured compact reads
  include the window and policy; HTTP and verbose reads expose an explicit null
  when unrestricted.
- Cover real controller process restarts, durable cooldown and coalescing,
  clock and settings changes during preparation, fractional UTC offsets,
  repeated hours, HTTP/MCP invalid-write refusal without settings changes,
  expiry preservation, and explicit message delivery outside the window.

## Contract boundaries

HTTP settings writes and MCP `seat_tick_settings` both reach
`applySeatTickSettingsChange`; MCP also publishes the optional window schema.
`writeSeatTickSettings` persists the validated value. Legacy JSON parsing and
SQLite decoding validate the window on reads. Partial edits preserve it, null
removes it, and `seatTickSettingsAfterLapse` preserves it when the wake overlay
expires. The existing interval editor submits partial maintenance changes, so
its edits preserve the window. Its status view formats the supplied next-run
instant. Maintenance and its window restriction remain off until configured.

The scheduled launch path checks the effective window before claiming work.
Recovered undispatched work checks the current settings and clock before
preparation and again before dispatch. Existing receipt and conversation
identities allow submitted work to reconcile. The durable run store continues
owning cooldown, interval claims and duplicate prevention.

`boardMaintenanceAnswer` supplies the same window, skip-and-coalesce policy and
next controller-check estimate to HTTP and MCP. Explicit-message delivery and
active-pipeline wake decisions retain their own paths. No performance gain is
claimed. Product workflow files are unchanged.

## Commands and results

Verification uses private HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR roots.
Heavy commands run through the project's installed gate-slot wrapper and
`gate-remote`, one campaign at a time. Each test file runs in a separate process
with fresh private roots, `setsid` and stdin from `/dev/null`.

The importer inventory resolves static, dynamic, type-only and embedded child
imports of the five changed production modules. It covers every configured
JavaScript/TypeScript test filename form. The inventory has 151 existing
importers, plus the new window test; the maintenance store and wake tests are
included as adjacent regressions.

The native main campaign ran 153 files; the branch full run covered all 154 files, including the new window test. A final whole-file parity recheck verifies the last test-only update. Each campaign printed its expected final ran-count. Browser and environment-gated cases retain their normal skips.

| Phase | Test files | Exit-zero files | Nonzero files | Campaign exit |
| --- | ---: | ---: | ---: | ---: |
| Native main | 153 | 98 | 55 | 1 |
| Initial focused checks | 8 | 4 | 4 | 1 |
| Importer comparison before size fix | 148 | 94 | 54 | 1 |
| Full run on corrected production code | 154 | 98 | 56 | 1 |
| Full HTTP/MCP parity recheck | 1 | 1 | 0 | 0 |

Latest branch observations: 99 files exited zero and 55 retained native-main failures. No new failing assertion labels or diagnostic classes were found after normalizing only per-run process IDs, temporary paths and request IDs. This is a baseline comparison; the complete suite is not green.

Two touched files retain native-main failures: `src/lib/mcp/schemaParity.test.ts` (the existing pipeline stage-contract description assertion) and `src/lib/mcp/originalKeySendRecovery.test.ts` (the existing oversized-send refusal assertion). Their new window and delivery cases pass.


The initial focused checks exposed two fixture mistakes: a settled run was looked up through a live-run pointer, and the MCP validation fixture had no authorized project seat. Both were corrected. The importer comparison then exposed a real compact-response regression: 1,746 bytes exceeded the existing limit of less than 1,700 bytes. The final size test passes with empty new metadata omitted on unrestricted compact reads. Existing compact fields remain available. The existing full HTTP/MCP parity comparison now requests verbose MCP data; compact metadata has its own contract test.

Heavy campaign invocation (the supplied installed wrapper is `$GATE_SLOT`; `$CAMPAIGN` expands to the explicit per-file commands below):

```sh
bash "$GATE_SLOT" gate-remote --get verification-results --out "$EVIDENCE" -- bash -c "$CAMPAIGN"
```

Each test row below records this command on the indicated source version, with a new `$CASE` directory per invocation:

```sh
HOME="$CASE/home" XDG_CONFIG_HOME="$CASE/config" \
  LLV_STATE_DIR="$CASE/state" TMPDIR="$CASE/tmp" \
  setsid bun test --timeout=60000 <file> </dev/null
```

| Other command | Initial focused | Importer comparison | Full branch run | Parity recheck |
| --- | ---: | ---: | ---: | ---: |
| `bun x tsc --noEmit --incremental false` | 0 | 0 | 0 | 0 |
| `bun x eslint` with all 13 TypeScript paths in the source-input table | 0 | 0 | 0 | 0 |

| Input / publication check | Exit |
| --- | ---: |
| `sha256sum` on the supplied `03.diff` | 0 |
| Python SHA-256 and byte-count equality assertions against `03.meta.json` | 0 |
| `git fetch origin main` | 0 |
| `git merge --ff-only origin/main` before applying the patch | 0 |
| `git apply --check` for `03.diff` | 0 |
| `git apply` for `03.diff` | 0 |
| `bun install --frozen-lockfile` | 0 |
| Initial `git diff --check` on tracked files | 0 |
| Initial `git diff --cached --check` (extra report EOF line) | 2 |
| Initial `git commit -F` attempt, refused by the whitespace hook | 1 |
| `git diff --cached --check` after removing the report EOF line | 0 |
| Python baseline/branch assertion and diagnostic comparison | 0 |
| Python final-source SHA-256 equality assertions | 0 |
| `bun scripts/privacy-publication-gate.ts --require-known-values --base` with the tested main revision and all 15 touched paths | 0 |


### Every test command exit

A dash means that phase did not run that file. The Latest column takes the full branch run, with the corrected parity file replaced by its final whole-file recheck; the new window file has no native main counterpart.

| File passed to `bun test --timeout=60000` | Main | Initial focused | Before size fix | Full branch run | Parity recheck | Latest |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `evals/roles/lifecycle.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `evals/roles/manifest.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `scripts/runtime-host-viewer-adapter.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/app/api/monitor/seat-tick/settings/route.test.ts` | 0 | 1 | 0 | 1 | 0 | 0 |
| `src/app/api/pipelines/route.admission.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/app/api/search/memory/route.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/app/api/search/transcripts/route.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/app/api/spawn/route.stageTasks.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/components/kanban/kanbanBoard.browser.test.tsx` | 0 | — | 0 | 0 | — | 0 |
| `src/components/orchestrator/seatTickView.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/accounts/managerProjectBinding.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/boardMaintenance/answer.test.ts` | 0 | 0 | — | 0 | — | 0 |
| `src/lib/boardMaintenance/guard.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/boardMaintenance/run.test.ts` | 0 | 1 | 0 | 0 | — | 0 |
| `src/lib/boardMaintenance/store.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/boardMaintenance/wake.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/boardMaintenance/window.test.ts` | — | 0 | — | 0 | — | 0 |
| `src/lib/flows/decisions.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/flows/retirement.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/accountProjectBinding.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/agentFleet.binding.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/mcp/answerSizes.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/autoUpdates.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/mcp/autonomy.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/bindings.deploy.replay.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/bindings.deploy.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/bindings.test.ts` | 0 | — | 1 | 0 | — | 0 |
| `src/lib/mcp/bridgeReportOrigin.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/mcp/bridgeReportShape.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/callCost.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/mcp/callerIdentification.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/callerResolution.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/coldScan.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/controlPlaneReads.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/conversationAction.integration.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/conversationMigration.integration.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/mcp/crossProject.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/mcp/curateRules.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/deployAuthority.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/mcp/deploymentListPages.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/mcp/deploymentReads.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/deputyAttribution.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/mcp/dismissAttention.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/mcp/http.cancellation.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/http.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/inputLimits.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/interruptedCall.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/issueReport.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/largeReads.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/mcp/leaveLesson.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/leaveLessonOperator.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/leaveLessonSeat.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/linkedSeatTools.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/mcp/maintainerGuard.integration.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/mcp/modelInput.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/nativeWorkMetadata.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/orchestratorSendRecovery.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/orchestratorTools.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/mcp/originalKeySendRecovery.test.ts` | 1 | 1 | — | 1 | — | 1 |
| `src/lib/mcp/pageCursors.integration.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/pageCursors.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/pipelineBusyAdmission.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/mcp/pipelineRoleFence.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/mcp/projectResolution.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/mcp/pullRequestReads.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/mcp/readLatency.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/receiptsStartup.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/relayOwnerHistory.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/relayServiceTools.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/releaseSettings.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/reportTools.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/mcp/requestAttention.immediate.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/requestAttention.targets.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/requestAttention.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/mcp/retirementStatus.integration.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/mcp/retirementStatus.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/retryStageLaunch.integration.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/mcp/reviewDispatchFailure.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/rolePresets.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/schemaParity.test.ts` | 1 | 1 | — | 1 | — | 1 |
| `src/lib/mcp/searchMemory.budget.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/searchMemory.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/seatAnswerBudgets.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/mcp/selectedContextActions.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/server.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/shortIds.answers.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/spawnAccount.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/spawnDeployer.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/mcp/spawnRecovery.integration.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/mcp/stdio.integration.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/mcp/taskBoardVisibility.integration.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/mcp/taskColor.integration.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/mcp/taskColorGroupHide.integration.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/mcp/taskDetails.integration.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/mcp/taskDue.integration.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/taskExecutor.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/taskFinding.integration.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/taskIcon.integration.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/mcp/taskLineEdits.integration.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/mcp/taskOwnership.integration.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/taskPosition.integration.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/mcp/taskPriority.integration.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/mcp/telegramBot.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/toolAllowlist.service.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/toolAllowlist.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/voiceTools.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/voiceUtteranceContext.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/workerLimit.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/mcp/worktreeBackfill.integration.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/memory/curation/curation.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/memory/importSync.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/memory/roleView.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/monitor/autonomy.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/monitor/seatAutoRotation.spawn.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/monitor/seatAutoRotation.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/monitor/seatTick.activity.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/monitor/seatTick.test.ts` | 0 | 0 | — | 0 | — | 0 |
| `src/lib/monitor/seatTickController.policy.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/monitor/seatTickController.reporting.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/monitor/seatTickController.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/monitor/seatTickReports.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/monitor/seatTickSettings.sqlite.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/monitor/seatTickSettings.test.ts` | 0 | 0 | — | 0 | — | 0 |
| `src/lib/monitor/seatTickSources.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/monitor/turbo.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/monitor/turboSweep.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/onboarding/healthCheck.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/orchestrator/ownerRelay.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/orchestrator/relay.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/orchestrator/rotationAuthority.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/orchestrator/rotationSettlement.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/orchestrator/seatProjectIdentity.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/pipelines/coldScan.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/pipelines/engine.pauseMetadata.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/pipelines/legacyReviewConversion.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/pipelines/resolveDecision.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/pipelines/stageCompletion.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/projects/shortIds.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/prototypeReview/answerDelivery.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/prototypeReview/http.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/prototypeReview/mcpReceipts.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/lib/realtime/voiceCardChain.dom.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/release/run.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/release/settings.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/release/wake.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/runtime/agentSignalSandbox.mcp.integration.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/runtime/codexSubagentDetection.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/runtime/structuredSpawn.integration.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/runtime/structuredSpawn.terminalize.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/state/declaredIndexes.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/state/legacyCollections.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/lib/voiceCompanion/tools.test.ts` | 1 | — | 1 | 1 | — | 1 |
| `src/runtime-host/mcpRuntimeCompatibility.test.ts` | 0 | — | 0 | 0 | — | 0 |
| `src/runtime-host/mcpRuntimeProbe.test.ts` | 1 | — | 1 | 1 | — | 1 |

### Verified source inputs

Final verification used main at the revision above plus these 13 changed TypeScript files. The last change only makes the parity test request a full MCP projection; production code was unchanged after the full-run snapshot. The input digest hashes the sorted `path`, tab, file SHA-256 and newline records below. Final documentation updates do not change these inputs.

Source-input SHA-256: `c2e591a5c2c675712ce9bc9269156b458d2bd3b1bed6f5cb5e135168f6c01a15`.

| Path | File SHA-256 |
| --- | --- |
| `src/app/api/monitor/seat-tick/settings/route.test.ts` | `7e9ad6654a0ec26b298043c43e37f40595f0829be9ad3799a09776dae2dc810f` |
| `src/lib/boardMaintenance/answer.test.ts` | `143ffa88bb9560f420d49ac75b4f6c824163504261448922ed5bec41d04d0ab1` |
| `src/lib/boardMaintenance/answer.ts` | `d83aa3a7d216aef12e5687b86a0913accc14c74ff04c487275fe999241a28f76` |
| `src/lib/boardMaintenance/run.test.ts` | `26b910c705936f1c1c10e9ec1057dd1723de9bc1a3dcd706a56621f774217c51` |
| `src/lib/boardMaintenance/run.ts` | `4324cd64de2e11a23bb069438044d2363a68c631671cb91c527933571d5d29e2` |
| `src/lib/boardMaintenance/window.test.ts` | `4d319ee0ed6bbaefbed99ab6f7f2eb09f4706d1f2139fc400931903f2ca947ca` |
| `src/lib/boardMaintenance/window.ts` | `71229450468c3a70775b58fa24d43d4f4a1971af4ab2c5b13da1ece958e86b09` |
| `src/lib/mcp/originalKeySendRecovery.test.ts` | `8ccec6e5fa0695113b4e459efbbfab9f30757c36040494ab59c5ab6afc66522f` |
| `src/lib/mcp/schemaParity.test.ts` | `3c711adb47cb73c946d20163a8df21b4ef32fad399bc147793b429804dbc5e72` |
| `src/lib/mcp/server.ts` | `79f72a06c6889c997603290cdb1c816c697475c4cbf93f9de90abd23ce2e19e0` |
| `src/lib/monitor/seatTick.test.ts` | `be97c40e54595c22cdefd8f972e1bcae54252a71dd24a0f7a3f0b34d58ed2665` |
| `src/lib/monitor/seatTickSettings.test.ts` | `cec4962160ea3e3aafdf6be630a41c26ffcd17174c034b0f510d121b7990c4d9` |
| `src/lib/monitor/seatTickSettings.ts` | `6f84c1ef5fb092bfb1a7780b4e7b7fb9bb40a1ea55880be79a661b7cebcf3066` |
