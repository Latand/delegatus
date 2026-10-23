Retained fixes for #2231, #2210 and #2203; dropped the #2226 draft.

Base: `adce5764927f7e838f20070cd2968128912e861c`. Retained diff SHA-256, excluding this record: `759a27d84ca3cdcc5e3601e9d545cfd0747de17376cf8ffeca916fd631c1436e`. Generated 2026-10-23T19:03:58+00:00.

Refreshed main: `800a26ebc10ca2db855d12a71320f75c5f2fb955`. The retained patch applied cleanly through a private index (exit 0), producing scratch tree `a8de879d849308e9d167763c36489a43edb6fd4b`. Every retained file in that export was compared byte-for-byte with the tree. The assigned branch keeps its original base; this is an additional integration check. All twelve focused main/integrated file runs, the integrated typecheck, touched-file ESLint and the real-CLI cancellation case pass.

First drafts came from Codex Cloud. They were reviewed and corrected locally. All executed tests used the repository ownership preload and private home, configuration, state and temporary directories. The remote runner showed load 43.34 on 16 CPUs; its current pair finished naturally before the remaining checks moved to the pinned local gate wrapper.

| Issue | Decision and final change | Revert or mutation check |
| --- | --- | --- |
| #2231 | Kept, corrected. Count byte scans, hold provider completion after the CLI receives a chunk, and freeze snapshot age. Wait for durable native records. The other five reported files already had their elapsed verdicts removed on main. | Fixed cases pass. Induced quadratic scans, a poisoned registry read and suppressed cancellation each fail. These are test-only changes; the mutations establish that the detectors retain their meaning. |
| #2226 | Dropped. Recomputing the projection key after building a response can stamp an old body with a concurrent writer's new revision. No projection product change is retained. | A held-build/write/next-read probe passes on main (0) and fails with the cloud draft (1). Restoring the product file is byte-exact. |
| #2210 | Kept, corrected in `src/lib/pipelines/store.ts:2144`. Completed lanes with unresolved linked finish marks stay hot. Every linked receipt releases retention; unlinked marks and cancelled lanes do not hold archival. The guide and both locale introductions already resolve the wording follow-up. | New test (`src/lib/pipelines/store.test.ts:906`): fixed source 0; main product source with the new test 1. Receipt and cancelled-lane controls pass. |
| #2203 | Kept the requested-ID fix in `src/lib/mcp/bindings.ts:5966`. Both indexed and fallback paths use the same hot-or-archive resolver as get_pipeline, with project, state, closed, missing-ID and cursor checks. The draft's unfiltered archive expansion was dropped because it replaces indexed paging with whole-archive materialization. | Two new cases (`src/lib/mcp/bindings.test.ts:1731`): fixed source 0; main product source with the new cases 1. |

Fixes #2231
Fixes #2210
Fixes #2203

No latency or throughput improvement is claimed. Product reversions and induced faults ran only in scratch exports.

Changed production paths: `src/lib/pipelines/store.ts` and `src/lib/mcp/bindings.ts`. Test changes are in the adjacent store/bindings suites, `src/lib/accounts/codexAppServer.test.ts`, `src/app/api/agent/snapshot/route.test.ts`, and `src/lib/runtime/copilotAcpHost.integration.test.ts`; the linked Copilot design description is updated.

The task-finish contract was traced through pipeline creation and mark edits in `src/lib/pipelines/engine.ts`, validation and archival in `src/lib/pipelines/store.ts`, the receipt/wait sweep in `src/lib/forge/autoMerge.ts`, the board reader in `src/lib/pipelines/taskFinish.ts`, and copies in `src/lib/forge/autoRefresh.ts`. The archive guard uses the sweep’s linked-mark and receipt rule. Cancelled lanes cannot finish tasks, so they retain their normal archival eligibility.

The archived-ID read path is `listPipelines` → `readPipelineRecord` → `getPipeline` → `findPipelineRecord` → active-or-archive keyed read. Both paging paths still apply the existing project authority and row filters. Tests mix allowed, foreign, missing and duplicate selectors and reject an explicit foreign project. General lists keep their existing source and paging.

The dropped cache draft was tested by exposing only its private projection function in a scratch export. A mocked response builder captures revision 1 and waits; the key provider advances to revision 2 before the response is released. The first body contains 1. After the in-flight job clears, a second request must contain 2. Main rebuilds it; the draft returns the cached body containing 1.

Test selection scanned tracked test files for alias, relative and dynamic imports of the two changed production modules, including embedded subprocess programs. The table below is the complete explicit-file manifest; additional source-reference checks and the named timing files were included conservatively. Each file gets its own process and isolated state.

The final comparison covers 218 selected files on both main and branch, including subprocess imports and source-reference checks. Four additional named #2231 files also ran on both revisions. No unexplained failure difference remains. The dependent Git fixture failure is detailed below. Files red on both revisions are recorded below.

The real Copilot CLI is pinned to 1.0.87 and uses a loopback provider stub. Real-login cases remain gated. The stdio MCP attachment assertion is red on both revisions. The changed cancellation case passes twice on the final fixture and fails when its cancel notification is suppressed.

The adapter suite needs the MCP bundle first: both built reruns pass. The first combined run exposed an invalid cancelled-lane control fixture, which was corrected. A local harness attempt failed before test startup because its namespace-specific temporary aliases could not be read by the supervisor; it was replaced with shared filesystem aliases into the same owned scratch area. Two early cache-probe commands used a hidden-directory name filter; the corrected explicit-path probe is authoritative. An intermediate Copilot fixture lacked a received-stream readiness gate and timed out on native record ordering; the final gate and full-file reruns replace it.

Each command below is the actual inner check. Remote rows ran under gate-remote; local rows ran through the pinned installed gate wrapper supplied by the stage. Shell setup and routine read-only inspection are omitted. Exit 1 in a reverted or induced-fault row is expected. Earlier attempts remain in this record.

The Git file has a dependent head-only failure in `a real stale dirty checkout provisions from the freshly fetched origin/main tip`. Its shell tries to open a deleted `fixture/bin/git`. Two earlier publication fixtures time out after 30 seconds on both revisions, then continue their finally blocks, restoring PATH and deleting their fake Git directories while later tests run. The Git test file itself is unchanged. Three complete runs per side retain the following results (failed tests / asynchronous errors):

| Whole-file observation | Main | Branch |
| --- | ---: | ---: |
| 1 | 32 / 1 | 33 / 2 |
| 2 | 32 / 2 | 33 / 2 |
| 3 | 32 / 1 | 33 / 2 |

The stale-checkout case passes on both revisions when only those two publication fixtures are excluded; the rest of that file still runs and retains its other baseline failures. A separate instrumented complete head run reaches neither changed production branch: neither the archive predicate nor the explicit-ID selection branch is invoked. This identifies existing fixture cleanup ordering as the source of the dependent failure. The command record retains the failure and the red file verdicts.

The initial remote-action runs reached the five-minute owned-runner deadline on both revisions. Repeating with a six-minute owned budget allowed all 43 tests to finish. The per-test timeout stayed unchanged. The final file verdicts and legacy-fixture failures appear below.

Final file comparison:

| Command | Main exit | Branch exit |
| --- | ---: | ---: |
| `bun test bin/server-runtime.test.ts --timeout=60000` | 0 | 0 |
| `bun test scripts/eslintServerArchive.test.ts --timeout=60000` | 0 | 0 |
| `bun test scripts/runtime-host-viewer-adapter.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/app/api/agent/snapshot/route.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/app/api/conversations/route.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/app/api/files/route.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/app/api/monitor/seat-tick/settings/route.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/app/api/orchestrator/seat/route.test.ts --timeout=60000` | 0 | 0 |
| `bun test 'src/app/api/pipelines/[id]/route.lifecycle.test.ts' --timeout=60000` | 1 | 1 |
| `bun test 'src/app/api/pipelines/[id]/route.test.ts' --timeout=60000` | 1 | 1 |
| `bun test src/app/api/pipelines/route.admission.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/app/api/pipelines/route.busy.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/app/api/pipelines/route.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/app/api/search/memory/route.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/app/api/search/transcripts/route.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/app/api/spawn/route.stageTasks.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/app/api/tasks/route.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/components/attention/AttentionHost.dom.test.tsx --timeout=60000` | 1 | 1 |
| `bun test src/components/pipelines/PipelineStrip.render.test.tsx --timeout=60000` | 0 | 0 |
| `bun test src/components/pipelines/remoteLaneSummary.dom.test.tsx --timeout=60000` | 0 | 0 |
| `bun test src/lib/accounts/claudeProvider.smoke.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/accounts/codexAppServer.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/agent/cli.integration.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/attention/finishedWorkCleanup.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/attention/landing.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/attention/service.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/externalRelay/ownerServiceTools.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/externalRelay/runner.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/flows/decisions.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/flows/retirement.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/forge/autoMerge.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/forge/autoMergeStore.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/forge/autoRefresh.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/forge/taskFinish.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/lifecycle/liveness.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/lifecycle/projector.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/links/laneFeed.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mainThreadInstrumentation.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/accountProjectBinding.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/agentFleet.binding.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/answerSizes.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/autoUpdates.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/autonomy.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/bindings.deploy.replay.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/bindings.deploy.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/bindings.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/bridgeDirective.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/bridgeReportOrigin.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/bridgeReportShape.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/callCost.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/callerResolution.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/coldScan.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/compactAnswers.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/controlEndpoint.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/controlPlaneReads.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/conversationAction.integration.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/conversationMigration.integration.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/crossProject.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/curateRules.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/deployAuthority.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/deploymentListPages.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/deploymentReads.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/deputyAttribution.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/dismissAttention.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/http.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/issueReport.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/largeReads.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/leaveLesson.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/leaveLessonOperator.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/leaveLessonSeat.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/linkedSeatTools.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/maintainerGuard.integration.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/managerAuthority.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/managerLifecycleSeams.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/orchestratorSendRecovery.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/orchestratorTools.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/originalKeySendRecovery.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/pageCursors.integration.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/pipelineBusyAdmission.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/pipelineRoleFence.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/projectResolution.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/pullRequestReads.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/readLatency.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/relayOwnerHistory.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/releaseSettings.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/reportTools.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/requestAttention.immediate.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/requestAttention.targets.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/requestAttention.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/retirementStatus.integration.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/retirementStatus.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/retryStageLaunch.integration.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/rolePresets.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/searchMemory.budget.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/searchMemory.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/searchTranscripts.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/seatAnswerBudgets.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/selectedContextActions.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/shortIds.answers.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/spawnAccount.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/spawnDeployer.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/spawnRecovery.integration.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/stdio.integration.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/taskBoardVisibility.integration.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/taskColor.integration.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/taskColorGroupHide.integration.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/taskDetails.integration.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/taskDue.integration.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/taskFinding.integration.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/taskIcon.integration.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/taskLineEdits.integration.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/taskOwnership.integration.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/taskPosition.integration.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/taskPriority.integration.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/mcp/telegramBot.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/voiceTools.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/voiceUtteranceContext.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/voiceUtteranceWiring.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/workLinks.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/workerLimit.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/mcp/worktreeBackfill.integration.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/memory/curation/curation.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/memory/curation/curator.eval.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/memory/roleEgressUnreadable.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/memory/roleLane.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/memory/roleLaunch.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/memory/roleSelection.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/memory/roleSelectionRetention.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/monitor/seatHostRecovery.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/monitor/seatTickController.reporting.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/monitor/seatTickSources.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/orchestrator/ownerRelay.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/orchestrator/relay.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/orchestrator/rotationAuthority.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/orchestrator/seatChannel.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/pipelines/autoRefreshStore.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/pipelines/backgroundTaskSettlement.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/pipelines/coldScan.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/pipelines/controllerArtifacts.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/pipelines/controllerLease.reproduction.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/pipelines/controllerLease.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/pipelines/decisionAuthority.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/pipelines/deputyLineage.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/pipelines/engine.controllerPass.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/pipelines/engine.controllerSnapshot.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/pipelines/engine.cpuAdmissionPolling.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/pipelines/engine.cpuQueue.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/pipelines/engine.creation.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/pipelines/engine.pauseMetadata.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/pipelines/engine.ports.part2.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/pipelines/engine.ports.part3.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/pipelines/engine.ports.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/pipelines/engine.publication.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/pipelines/engine.recovery.part2.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/pipelines/engine.routing.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/pipelines/engine.settlement.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/pipelines/engine.watchdogRegression.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/pipelines/engineConnectionRefusal.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/pipelines/git.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/pipelines/graphEdits.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/pipelines/handLaunch.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/pipelines/legacyReviewConversion.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/pipelines/legacyReviewStore.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/pipelines/parkedPublication.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/pipelines/prompts.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/pipelines/registryCompatibility.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/pipelines/remoteActions.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/pipelines/resolveDecision.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/pipelines/retirementEvidence.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/pipelines/revalidation.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/pipelines/runtimeSwitch.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/pipelines/severedStageRetry.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/pipelines/severedTurnResume.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/pipelines/spawnRestartRecovery.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/pipelines/stageAccountBinding.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/pipelines/stageCommitRepair.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/pipelines/stageCompletion.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/pipelines/stageHostGenerationClose.integration.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/pipelines/stageInput.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/pipelines/stagePublicationRepair.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/pipelines/stagePullRequest.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/pipelines/stageSizing.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/pipelines/stageVerdictRequest.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/pipelines/startupResponsiveness.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/pipelines/store.reads.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/pipelines/store.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/pipelines/taskBinding.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/pipelines/terminalReap.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/projects/durableMigration.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/projects/shortIds.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/prototypeReview/http.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/prototypeReview/mcpReceipts.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/realtime/voiceCardChain.dom.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/runtime/agentRecordAuthors.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/runtime/attemptTempProduction.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/runtime/claudeStreamBrokerHost.integration.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/runtime/codexAppServerHost.integration.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/runtime/copilotAcpHost.integration.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/runtime/legacyClaudeRecovery.cleanCi.integration.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/runtime/permissionGuard.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/runtime/pipelineStageHostAccess.integration.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/runtime/sendSettlement.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/runtime/startup.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/runtime/startupFinalization.integration.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/runtime/structuredRecovery.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/scanner/filesResponseWorker.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/scanner/scanCache.catalogFreshness.test.tsx --timeout=60000` | 0 | 0 |
| `bun test src/lib/selfUpdate/workEvidence.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/state/historyProjection.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/state/hotStateStores.benchmark.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/state/hotStateStores.sqlite.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/state/registryRecords.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/tasks/launchMembership.registry.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/lib/tasks/seatRecoveryCleanup.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/voiceCompanion/liveSession.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/lib/voiceCompanion/readPaths.test.ts --timeout=60000` | 1 | 1 |
| `bun test src/proxy.team.test.ts --timeout=60000` | 0 | 0 |
| `bun test src/runtime-host/candidateStateDataset.test.ts --timeout=60000` | 0 | 0 |

Remote attempt:

| Variant | Command | Exit |
| --- | --- | ---: |
| main | `bun test bin/server-runtime.test.ts --timeout=60000` | 0 |
| branch | `bun test bin/server-runtime.test.ts --timeout=60000` | 0 |
| main | `bun test scripts/runtime-host-viewer-adapter.test.ts --timeout=60000` | 1 |
| branch | `bun test scripts/runtime-host-viewer-adapter.test.ts --timeout=60000` | 1 |
| main | `bun test src/app/api/agent/snapshot/route.test.ts --timeout=60000` | 0 |
| branch | `bun test src/app/api/agent/snapshot/route.test.ts --timeout=60000` | 0 |
| main | `bun test src/app/api/conversations/route.test.ts --timeout=60000` | 1 |
| branch | `bun test src/app/api/conversations/route.test.ts --timeout=60000` | 1 |
| main | `bun test src/app/api/files/route.test.ts --timeout=60000` | 1 |
| branch | `bun test src/app/api/files/route.test.ts --timeout=60000` | 1 |
| main | `bun test src/app/api/monitor/seat-tick/settings/route.test.ts --timeout=60000` | 1 |
| branch | `bun test src/app/api/monitor/seat-tick/settings/route.test.ts --timeout=60000` | 1 |
| main | `bun test src/app/api/orchestrator/seat/route.test.ts --timeout=60000` | 0 |
| branch | `bun test src/app/api/orchestrator/seat/route.test.ts --timeout=60000` | 0 |
| main | `bun test src/app/api/pipelines/[id]/route.lifecycle.test.ts --timeout=60000` | 1 |
| branch | `bun test src/app/api/pipelines/[id]/route.lifecycle.test.ts --timeout=60000` | 1 |
| main | `bun test src/app/api/pipelines/[id]/route.test.ts --timeout=60000` | 1 |
| branch | `bun test src/app/api/pipelines/[id]/route.test.ts --timeout=60000` | 1 |
| main | `bun test src/app/api/pipelines/route.admission.test.ts --timeout=60000` | 1 |
| branch | `bun test src/app/api/pipelines/route.admission.test.ts --timeout=60000` | 1 |
| main | `bun test src/app/api/pipelines/route.busy.test.ts --timeout=60000` | 1 |
| branch | `bun test src/app/api/pipelines/route.busy.test.ts --timeout=60000` | 1 |
| main | `bun test src/app/api/pipelines/route.test.ts --timeout=60000` | 1 |
| branch | `bun test src/app/api/pipelines/route.test.ts --timeout=60000` | 1 |
| main | `bun test src/app/api/search/memory/route.test.ts --timeout=60000` | 0 |
| branch | `bun test src/app/api/search/memory/route.test.ts --timeout=60000` | 0 |
| main | `bun test src/app/api/search/transcripts/route.test.ts --timeout=60000` | 0 |
| branch | `bun test src/app/api/search/transcripts/route.test.ts --timeout=60000` | 0 |
| main | `bun test src/app/api/spawn/route.stageTasks.test.ts --timeout=60000` | 1 |
| branch | `bun test src/app/api/spawn/route.stageTasks.test.ts --timeout=60000` | 1 |
| main | `bun test src/app/api/tasks/route.test.ts --timeout=60000` | 0 |
| branch | `bun test src/app/api/tasks/route.test.ts --timeout=60000` | 0 |
| main | `bun test src/components/attention/AttentionHost.dom.test.tsx --timeout=60000` | 1 |
| branch | `bun test src/components/attention/AttentionHost.dom.test.tsx --timeout=60000` | 1 |
| main | `bun test src/components/pipelines/PipelineStrip.render.test.tsx --timeout=60000` | 0 |
| branch | `bun test src/components/pipelines/PipelineStrip.render.test.tsx --timeout=60000` | 0 |
| main | `bun test src/components/pipelines/remoteLaneSummary.dom.test.tsx --timeout=60000` | 0 |
| branch | `bun test src/components/pipelines/remoteLaneSummary.dom.test.tsx --timeout=60000` | 0 |
| main | `bun test src/lib/accounts/claudeProvider.smoke.test.ts --timeout=60000` | 0 |
| branch | `bun test src/lib/accounts/claudeProvider.smoke.test.ts --timeout=60000` | 0 |
| main | `bun test src/lib/accounts/codexAppServer.test.ts --timeout=60000` | 0 |
| branch | `bun test src/lib/accounts/codexAppServer.test.ts --timeout=60000` | 0 |
| main | `bun test src/lib/agent/cli.integration.test.ts --timeout=60000` | 0 |
| branch | `bun test src/lib/agent/cli.integration.test.ts --timeout=60000` | 0 |
| main | `bun test src/lib/attention/finishedWorkCleanup.test.ts --timeout=60000` | 0 |
| branch | `bun test src/lib/attention/finishedWorkCleanup.test.ts --timeout=60000` | 0 |
| main | `bun test src/lib/attention/landing.test.ts --timeout=60000` | 0 |
| branch | `bun test src/lib/attention/landing.test.ts --timeout=60000` | 0 |
| main | `bun test src/lib/attention/service.test.ts --timeout=60000` | 0 |
| branch | `bun test src/lib/attention/service.test.ts --timeout=60000` | 0 |
| main | `bun test src/lib/externalRelay/ownerServiceTools.test.ts --timeout=60000` | 0 |
| branch | `bun test src/lib/externalRelay/ownerServiceTools.test.ts --timeout=60000` | 0 |
| main | `bun test src/lib/externalRelay/runner.test.ts --timeout=60000` | 1 |
| branch | `bun test src/lib/externalRelay/runner.test.ts --timeout=60000` | 1 |

Local supervisor attempt; no tests started:

| Variant | Command | Exit |
| --- | --- | ---: |
| store-positive | `bun test src/lib/pipelines/store.test.ts --test-name-pattern 'marked task stays hot' --timeout=60000` | 1 |
| store-reverted | `bun test src/lib/pipelines/store.test.ts --test-name-pattern 'marked task stays hot' --timeout=60000` | 1 |
| bindings-positive | `bun test src/lib/mcp/bindings.test.ts --test-name-pattern 'resolves archived ids' --timeout=60000` | 1 |
| bindings-reverted | `bun test src/lib/mcp/bindings.test.ts --test-name-pattern 'resolves archived ids' --timeout=60000` | 1 |
| codex-positive | `bun test src/lib/accounts/codexAppServer.test.ts --test-name-pattern 'fragmented 25 MB' --timeout=60000` | 1 |
| codex-quadratic | `bun test src/lib/accounts/codexAppServer.test.ts --test-name-pattern 'fragmented 25 MB' --timeout=60000` | 1 |
| snapshot-positive | `bun test src/app/api/agent/snapshot/route.test.ts --test-name-pattern 'transcript-only snapshot serves' --timeout=60000` | 1 |
| snapshot-registry | `bun test src/app/api/agent/snapshot/route.test.ts --test-name-pattern 'transcript-only snapshot serves' --timeout=60000` | 1 |
| projection-main-race | `bun test .verification/projectionRace.test.ts --timeout=60000` | 1 |
| projection-cloud-race | `bun test .verification/projectionRace.test.ts --timeout=60000` | 1 |
| extra-main-src_lib_accounts_claudeLoginIdentity.test.ts | `bun test src/lib/accounts/claudeLoginIdentity.test.ts --timeout=60000` | 1 |
| extra-branch-src_lib_accounts_claudeLoginIdentity.test.ts | `bun test src/lib/accounts/claudeLoginIdentity.test.ts --timeout=60000` | 1 |
| extra-main-src_lib_state_durability.test.ts | `bun test src/lib/state/durability.test.ts --timeout=60000` | 1 |
| extra-branch-src_lib_state_durability.test.ts | `bun test src/lib/state/durability.test.ts --timeout=60000` | 1 |
| extra-main-src_runtime-host_journal.test.ts | `bun test src/runtime-host/journal.test.ts --timeout=60000` | 1 |
| extra-branch-src_runtime-host_journal.test.ts | `bun test src/runtime-host/journal.test.ts --timeout=60000` | 1 |
| extra-main-src_lib_accounts_migration_controller.routing.test.ts | `bun test src/lib/accounts/migration/controller.routing.test.ts --timeout=60000` | 1 |
| extra-branch-src_lib_accounts_migration_controller.routing.test.ts | `bun test src/lib/accounts/migration/controller.routing.test.ts --timeout=60000` | 1 |
| types-main | `bun x tsc --noEmit --incremental false` | 1 |
| eslint-main | `bun x eslint src/lib/pipelines/store.ts src/lib/pipelines/store.test.ts src/lib/mcp/bindings.ts src/lib/mcp/bindings.test.ts src/lib/accounts/codexAppServer.test.ts src/app/api/agent/snapshot/route.test.ts src/lib/runtime/copilotAcpHost.integration.test.ts` | 1 |
| types-branch | `bun x tsc --noEmit --incremental false` | 1 |
| eslint-branch | `bun x eslint src/lib/pipelines/store.ts src/lib/pipelines/store.test.ts src/lib/mcp/bindings.ts src/lib/mcp/bindings.test.ts src/lib/accounts/codexAppServer.test.ts src/app/api/agent/snapshot/route.test.ts src/lib/runtime/copilotAcpHost.integration.test.ts` | 1 |
| copilot-install | `bun install` | 1 |
| copilot-build-main | `bun scripts/build-mcp.ts` | 1 |
| adapter-built-main | `bun test scripts/runtime-host-viewer-adapter.test.ts --timeout=60000` | 1 |
| copilot-stub-main | `bun test src/lib/runtime/copilotAcpHost.integration.test.ts --timeout=60000` | 1 |
| copilot-build-branch | `bun scripts/build-mcp.ts` | 1 |
| adapter-built-branch | `bun test scripts/runtime-host-viewer-adapter.test.ts --timeout=60000` | 1 |
| copilot-stub-branch | `bun test src/lib/runtime/copilotAcpHost.integration.test.ts --timeout=60000` | 1 |
| copilot-no-cancel | `bun test src/lib/runtime/copilotAcpHost.integration.test.ts --test-name-pattern 'spawn, send, interrupt-and-resend, interrupt, resume, render and account isolation' --timeout=60000` | 1 |

Focused checks before the final native fixture:

| Variant | Command | Exit |
| --- | --- | ---: |
| store-positive | `bun test src/lib/pipelines/store.test.ts --test-name-pattern 'marked task stays hot' --timeout=60000` | 0 |
| store-reverted | `bun test src/lib/pipelines/store.test.ts --test-name-pattern 'marked task stays hot' --timeout=60000` | 1 |
| bindings-positive | `bun test src/lib/mcp/bindings.test.ts --test-name-pattern 'resolves archived ids' --timeout=60000` | 0 |
| bindings-reverted | `bun test src/lib/mcp/bindings.test.ts --test-name-pattern 'resolves archived ids' --timeout=60000` | 1 |
| codex-positive | `bun test src/lib/accounts/codexAppServer.test.ts --test-name-pattern 'fragmented 25 MB' --timeout=60000` | 0 |
| codex-quadratic | `bun test src/lib/accounts/codexAppServer.test.ts --test-name-pattern 'fragmented 25 MB' --timeout=60000` | 1 |
| snapshot-positive | `bun test src/app/api/agent/snapshot/route.test.ts --test-name-pattern 'transcript-only snapshot serves' --timeout=60000` | 0 |
| snapshot-registry | `bun test src/app/api/agent/snapshot/route.test.ts --test-name-pattern 'transcript-only snapshot serves' --timeout=60000` | 1 |
| projection-main-race | `bun test .verification/projectionRace.test.ts --timeout=60000` | 1 |
| projection-cloud-race | `bun test .verification/projectionRace.test.ts --timeout=60000` | 1 |
| extra-main-src_lib_accounts_claudeLoginIdentity.test.ts | `bun test src/lib/accounts/claudeLoginIdentity.test.ts --timeout=60000` | 0 |
| extra-branch-src_lib_accounts_claudeLoginIdentity.test.ts | `bun test src/lib/accounts/claudeLoginIdentity.test.ts --timeout=60000` | 0 |
| extra-main-src_lib_state_durability.test.ts | `bun test src/lib/state/durability.test.ts --timeout=60000` | 0 |
| extra-branch-src_lib_state_durability.test.ts | `bun test src/lib/state/durability.test.ts --timeout=60000` | 0 |
| extra-main-src_runtime-host_journal.test.ts | `bun test src/runtime-host/journal.test.ts --timeout=60000` | 0 |
| extra-branch-src_runtime-host_journal.test.ts | `bun test src/runtime-host/journal.test.ts --timeout=60000` | 0 |
| extra-main-src_lib_accounts_migration_controller.routing.test.ts | `bun test src/lib/accounts/migration/controller.routing.test.ts --timeout=60000` | 0 |
| extra-branch-src_lib_accounts_migration_controller.routing.test.ts | `bun test src/lib/accounts/migration/controller.routing.test.ts --timeout=60000` | 0 |
| types-main | `bun x tsc --noEmit --incremental false` | 0 |
| eslint-main | `bun x eslint src/lib/pipelines/store.ts src/lib/pipelines/store.test.ts src/lib/mcp/bindings.ts src/lib/mcp/bindings.test.ts src/lib/accounts/codexAppServer.test.ts src/app/api/agent/snapshot/route.test.ts src/lib/runtime/copilotAcpHost.integration.test.ts` | 0 |
| types-branch | `bun x tsc --noEmit --incremental false` | 0 |
| eslint-branch | `bun x eslint src/lib/pipelines/store.ts src/lib/pipelines/store.test.ts src/lib/mcp/bindings.ts src/lib/mcp/bindings.test.ts src/lib/accounts/codexAppServer.test.ts src/app/api/agent/snapshot/route.test.ts src/lib/runtime/copilotAcpHost.integration.test.ts` | 0 |
| copilot-install | `bun install` | 0 |
| copilot-build-main | `bun scripts/build-mcp.ts` | 0 |
| adapter-built-main | `bun test scripts/runtime-host-viewer-adapter.test.ts --timeout=60000` | 0 |
| copilot-stub-main | `bun test src/lib/runtime/copilotAcpHost.integration.test.ts --timeout=60000` | 1 |
| copilot-build-branch | `bun scripts/build-mcp.ts` | 0 |
| adapter-built-branch | `bun test scripts/runtime-host-viewer-adapter.test.ts --timeout=60000` | 0 |
| copilot-stub-branch | `bun test src/lib/runtime/copilotAcpHost.integration.test.ts --timeout=60000` | 1 |
| copilot-no-cancel | `bun test src/lib/runtime/copilotAcpHost.integration.test.ts --test-name-pattern 'spawn, send, interrupt-and-resend, interrupt, resume, render and account isolation' --timeout=60000` | 1 |

Corrected cache race probe:

| Variant | Command | Exit |
| --- | --- | ---: |
| projection-main-race | `bun test ./.verification/projectionRace.test.ts --timeout=60000` | 0 |
| projection-cloud-race | `bun test ./.verification/projectionRace.test.ts --timeout=60000` | 1 |

Earlier native positive check:

| Variant | Command | Exit |
| --- | --- | ---: |
| copilot-positive | `bun test src/lib/runtime/copilotAcpHost.integration.test.ts --test-name-pattern 'spawn, send, interrupt-and-resend, interrupt, resume, render and account isolation' --timeout=60000` | 0 |

Local importer campaign:

| Variant | Command | Exit |
| --- | --- | ---: |
| build-main | `bun scripts/build-mcp.ts` | 0 |
| build-branch | `bun scripts/build-mcp.ts` | 0 |
| final-types-branch | `bun x tsc --noEmit --incremental false` | 0 |
| final-eslint-copilot | `bun x eslint src/lib/runtime/copilotAcpHost.integration.test.ts` | 0 |
| final-copilot-positive | `bun test src/lib/runtime/copilotAcpHost.integration.test.ts --test-name-pattern 'spawn, send, interrupt-and-resend, interrupt, resume, render and account isolation' --timeout=60000` | 1 |
| final-copilot-no-cancel | `bun test src/lib/runtime/copilotAcpHost.integration.test.ts --test-name-pattern 'spawn, send, interrupt-and-resend, interrupt, resume, render and account isolation' --timeout=60000` | 1 |
| main-src_lib_flows_decisions.test.ts | `bun test src/lib/flows/decisions.test.ts --timeout=60000` | 0 |
| branch-src_lib_flows_decisions.test.ts | `bun test src/lib/flows/decisions.test.ts --timeout=60000` | 0 |
| main-src_lib_flows_retirement.test.ts | `bun test src/lib/flows/retirement.test.ts --timeout=60000` | 0 |
| branch-src_lib_flows_retirement.test.ts | `bun test src/lib/flows/retirement.test.ts --timeout=60000` | 0 |
| main-src_lib_forge_autoMerge.test.ts | `bun test src/lib/forge/autoMerge.test.ts --timeout=60000` | 0 |
| branch-src_lib_forge_autoMerge.test.ts | `bun test src/lib/forge/autoMerge.test.ts --timeout=60000` | 0 |
| main-src_lib_forge_autoMergeStore.test.ts | `bun test src/lib/forge/autoMergeStore.test.ts --timeout=60000` | 0 |
| branch-src_lib_forge_autoMergeStore.test.ts | `bun test src/lib/forge/autoMergeStore.test.ts --timeout=60000` | 0 |
| main-src_lib_forge_autoRefresh.test.ts | `bun test src/lib/forge/autoRefresh.test.ts --timeout=60000` | 0 |
| branch-src_lib_forge_autoRefresh.test.ts | `bun test src/lib/forge/autoRefresh.test.ts --timeout=60000` | 0 |
| main-src_lib_forge_taskFinish.test.ts | `bun test src/lib/forge/taskFinish.test.ts --timeout=60000` | 0 |
| branch-src_lib_forge_taskFinish.test.ts | `bun test src/lib/forge/taskFinish.test.ts --timeout=60000` | 0 |
| main-src_lib_lifecycle_liveness.test.ts | `bun test src/lib/lifecycle/liveness.test.ts --timeout=60000` | 0 |
| branch-src_lib_lifecycle_liveness.test.ts | `bun test src/lib/lifecycle/liveness.test.ts --timeout=60000` | 0 |
| main-src_lib_lifecycle_projector.test.ts | `bun test src/lib/lifecycle/projector.test.ts --timeout=60000` | 1 |
| branch-src_lib_lifecycle_projector.test.ts | `bun test src/lib/lifecycle/projector.test.ts --timeout=60000` | 1 |
| main-src_lib_links_laneFeed.test.ts | `bun test src/lib/links/laneFeed.test.ts --timeout=60000` | 0 |
| branch-src_lib_links_laneFeed.test.ts | `bun test src/lib/links/laneFeed.test.ts --timeout=60000` | 0 |
| main-src_lib_mainThreadInstrumentation.test.ts | `bun test src/lib/mainThreadInstrumentation.test.ts --timeout=60000` | 1 |
| branch-src_lib_mainThreadInstrumentation.test.ts | `bun test src/lib/mainThreadInstrumentation.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_accountProjectBinding.test.ts | `bun test src/lib/mcp/accountProjectBinding.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_accountProjectBinding.test.ts | `bun test src/lib/mcp/accountProjectBinding.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_agentFleet.binding.test.ts | `bun test src/lib/mcp/agentFleet.binding.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_agentFleet.binding.test.ts | `bun test src/lib/mcp/agentFleet.binding.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_answerSizes.test.ts | `bun test src/lib/mcp/answerSizes.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_answerSizes.test.ts | `bun test src/lib/mcp/answerSizes.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_autoUpdates.test.ts | `bun test src/lib/mcp/autoUpdates.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_autoUpdates.test.ts | `bun test src/lib/mcp/autoUpdates.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_autonomy.test.ts | `bun test src/lib/mcp/autonomy.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_autonomy.test.ts | `bun test src/lib/mcp/autonomy.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_bindings.deploy.replay.test.ts | `bun test src/lib/mcp/bindings.deploy.replay.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_bindings.deploy.replay.test.ts | `bun test src/lib/mcp/bindings.deploy.replay.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_bindings.deploy.test.ts | `bun test src/lib/mcp/bindings.deploy.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_bindings.deploy.test.ts | `bun test src/lib/mcp/bindings.deploy.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_bindings.test.ts | `bun test src/lib/mcp/bindings.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_bindings.test.ts | `bun test src/lib/mcp/bindings.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_bridgeDirective.test.ts | `bun test src/lib/mcp/bridgeDirective.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_bridgeDirective.test.ts | `bun test src/lib/mcp/bridgeDirective.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_bridgeReportOrigin.test.ts | `bun test src/lib/mcp/bridgeReportOrigin.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_bridgeReportOrigin.test.ts | `bun test src/lib/mcp/bridgeReportOrigin.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_bridgeReportShape.test.ts | `bun test src/lib/mcp/bridgeReportShape.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_bridgeReportShape.test.ts | `bun test src/lib/mcp/bridgeReportShape.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_callCost.test.ts | `bun test src/lib/mcp/callCost.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_callCost.test.ts | `bun test src/lib/mcp/callCost.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_callerResolution.test.ts | `bun test src/lib/mcp/callerResolution.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_callerResolution.test.ts | `bun test src/lib/mcp/callerResolution.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_coldScan.test.ts | `bun test src/lib/mcp/coldScan.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_coldScan.test.ts | `bun test src/lib/mcp/coldScan.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_compactAnswers.test.ts | `bun test src/lib/mcp/compactAnswers.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_compactAnswers.test.ts | `bun test src/lib/mcp/compactAnswers.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_controlEndpoint.test.ts | `bun test src/lib/mcp/controlEndpoint.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_controlEndpoint.test.ts | `bun test src/lib/mcp/controlEndpoint.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_controlPlaneReads.test.ts | `bun test src/lib/mcp/controlPlaneReads.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_controlPlaneReads.test.ts | `bun test src/lib/mcp/controlPlaneReads.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_conversationAction.integration.test.ts | `bun test src/lib/mcp/conversationAction.integration.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_conversationAction.integration.test.ts | `bun test src/lib/mcp/conversationAction.integration.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_conversationMigration.integration.test.ts | `bun test src/lib/mcp/conversationMigration.integration.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_conversationMigration.integration.test.ts | `bun test src/lib/mcp/conversationMigration.integration.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_crossProject.test.ts | `bun test src/lib/mcp/crossProject.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_crossProject.test.ts | `bun test src/lib/mcp/crossProject.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_curateRules.test.ts | `bun test src/lib/mcp/curateRules.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_curateRules.test.ts | `bun test src/lib/mcp/curateRules.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_deployAuthority.test.ts | `bun test src/lib/mcp/deployAuthority.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_deployAuthority.test.ts | `bun test src/lib/mcp/deployAuthority.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_deploymentListPages.test.ts | `bun test src/lib/mcp/deploymentListPages.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_deploymentListPages.test.ts | `bun test src/lib/mcp/deploymentListPages.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_deploymentReads.test.ts | `bun test src/lib/mcp/deploymentReads.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_deploymentReads.test.ts | `bun test src/lib/mcp/deploymentReads.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_deputyAttribution.test.ts | `bun test src/lib/mcp/deputyAttribution.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_deputyAttribution.test.ts | `bun test src/lib/mcp/deputyAttribution.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_dismissAttention.test.ts | `bun test src/lib/mcp/dismissAttention.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_dismissAttention.test.ts | `bun test src/lib/mcp/dismissAttention.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_http.test.ts | `bun test src/lib/mcp/http.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_http.test.ts | `bun test src/lib/mcp/http.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_issueReport.test.ts | `bun test src/lib/mcp/issueReport.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_issueReport.test.ts | `bun test src/lib/mcp/issueReport.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_leaveLesson.test.ts | `bun test src/lib/mcp/leaveLesson.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_leaveLesson.test.ts | `bun test src/lib/mcp/leaveLesson.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_leaveLessonOperator.test.ts | `bun test src/lib/mcp/leaveLessonOperator.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_leaveLessonOperator.test.ts | `bun test src/lib/mcp/leaveLessonOperator.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_leaveLessonSeat.test.ts | `bun test src/lib/mcp/leaveLessonSeat.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_leaveLessonSeat.test.ts | `bun test src/lib/mcp/leaveLessonSeat.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_linkedSeatTools.test.ts | `bun test src/lib/mcp/linkedSeatTools.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_linkedSeatTools.test.ts | `bun test src/lib/mcp/linkedSeatTools.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_maintainerGuard.integration.test.ts | `bun test src/lib/mcp/maintainerGuard.integration.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_maintainerGuard.integration.test.ts | `bun test src/lib/mcp/maintainerGuard.integration.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_managerAuthority.test.ts | `bun test src/lib/mcp/managerAuthority.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_managerAuthority.test.ts | `bun test src/lib/mcp/managerAuthority.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_managerLifecycleSeams.test.ts | `bun test src/lib/mcp/managerLifecycleSeams.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_managerLifecycleSeams.test.ts | `bun test src/lib/mcp/managerLifecycleSeams.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_orchestratorSendRecovery.test.ts | `bun test src/lib/mcp/orchestratorSendRecovery.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_orchestratorSendRecovery.test.ts | `bun test src/lib/mcp/orchestratorSendRecovery.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_orchestratorTools.test.ts | `bun test src/lib/mcp/orchestratorTools.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_orchestratorTools.test.ts | `bun test src/lib/mcp/orchestratorTools.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_originalKeySendRecovery.test.ts | `bun test src/lib/mcp/originalKeySendRecovery.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_originalKeySendRecovery.test.ts | `bun test src/lib/mcp/originalKeySendRecovery.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_pageCursors.integration.test.ts | `bun test src/lib/mcp/pageCursors.integration.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_pageCursors.integration.test.ts | `bun test src/lib/mcp/pageCursors.integration.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_pipelineBusyAdmission.test.ts | `bun test src/lib/mcp/pipelineBusyAdmission.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_pipelineBusyAdmission.test.ts | `bun test src/lib/mcp/pipelineBusyAdmission.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_pipelineRoleFence.test.ts | `bun test src/lib/mcp/pipelineRoleFence.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_pipelineRoleFence.test.ts | `bun test src/lib/mcp/pipelineRoleFence.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_projectResolution.test.ts | `bun test src/lib/mcp/projectResolution.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_projectResolution.test.ts | `bun test src/lib/mcp/projectResolution.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_pullRequestReads.test.ts | `bun test src/lib/mcp/pullRequestReads.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_pullRequestReads.test.ts | `bun test src/lib/mcp/pullRequestReads.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_readLatency.test.ts | `bun test src/lib/mcp/readLatency.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_readLatency.test.ts | `bun test src/lib/mcp/readLatency.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_relayOwnerHistory.test.ts | `bun test src/lib/mcp/relayOwnerHistory.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_relayOwnerHistory.test.ts | `bun test src/lib/mcp/relayOwnerHistory.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_releaseSettings.test.ts | `bun test src/lib/mcp/releaseSettings.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_releaseSettings.test.ts | `bun test src/lib/mcp/releaseSettings.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_reportTools.test.ts | `bun test src/lib/mcp/reportTools.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_reportTools.test.ts | `bun test src/lib/mcp/reportTools.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_requestAttention.immediate.test.ts | `bun test src/lib/mcp/requestAttention.immediate.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_requestAttention.immediate.test.ts | `bun test src/lib/mcp/requestAttention.immediate.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_requestAttention.targets.test.ts | `bun test src/lib/mcp/requestAttention.targets.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_requestAttention.targets.test.ts | `bun test src/lib/mcp/requestAttention.targets.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_requestAttention.test.ts | `bun test src/lib/mcp/requestAttention.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_requestAttention.test.ts | `bun test src/lib/mcp/requestAttention.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_retirementStatus.integration.test.ts | `bun test src/lib/mcp/retirementStatus.integration.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_retirementStatus.integration.test.ts | `bun test src/lib/mcp/retirementStatus.integration.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_retirementStatus.test.ts | `bun test src/lib/mcp/retirementStatus.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_retirementStatus.test.ts | `bun test src/lib/mcp/retirementStatus.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_retryStageLaunch.integration.test.ts | `bun test src/lib/mcp/retryStageLaunch.integration.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_retryStageLaunch.integration.test.ts | `bun test src/lib/mcp/retryStageLaunch.integration.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_rolePresets.test.ts | `bun test src/lib/mcp/rolePresets.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_rolePresets.test.ts | `bun test src/lib/mcp/rolePresets.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_searchMemory.budget.test.ts | `bun test src/lib/mcp/searchMemory.budget.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_searchMemory.budget.test.ts | `bun test src/lib/mcp/searchMemory.budget.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_searchMemory.test.ts | `bun test src/lib/mcp/searchMemory.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_searchMemory.test.ts | `bun test src/lib/mcp/searchMemory.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_searchTranscripts.test.ts | `bun test src/lib/mcp/searchTranscripts.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_searchTranscripts.test.ts | `bun test src/lib/mcp/searchTranscripts.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_seatAnswerBudgets.test.ts | `bun test src/lib/mcp/seatAnswerBudgets.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_seatAnswerBudgets.test.ts | `bun test src/lib/mcp/seatAnswerBudgets.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_selectedContextActions.test.ts | `bun test src/lib/mcp/selectedContextActions.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_selectedContextActions.test.ts | `bun test src/lib/mcp/selectedContextActions.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_shortIds.answers.test.ts | `bun test src/lib/mcp/shortIds.answers.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_shortIds.answers.test.ts | `bun test src/lib/mcp/shortIds.answers.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_spawnAccount.test.ts | `bun test src/lib/mcp/spawnAccount.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_spawnAccount.test.ts | `bun test src/lib/mcp/spawnAccount.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_spawnDeployer.test.ts | `bun test src/lib/mcp/spawnDeployer.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_spawnDeployer.test.ts | `bun test src/lib/mcp/spawnDeployer.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_spawnRecovery.integration.test.ts | `bun test src/lib/mcp/spawnRecovery.integration.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_spawnRecovery.integration.test.ts | `bun test src/lib/mcp/spawnRecovery.integration.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_taskBoardVisibility.integration.test.ts | `bun test src/lib/mcp/taskBoardVisibility.integration.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_taskBoardVisibility.integration.test.ts | `bun test src/lib/mcp/taskBoardVisibility.integration.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_taskColor.integration.test.ts | `bun test src/lib/mcp/taskColor.integration.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_taskColor.integration.test.ts | `bun test src/lib/mcp/taskColor.integration.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_taskColorGroupHide.integration.test.ts | `bun test src/lib/mcp/taskColorGroupHide.integration.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_taskColorGroupHide.integration.test.ts | `bun test src/lib/mcp/taskColorGroupHide.integration.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_taskDetails.integration.test.ts | `bun test src/lib/mcp/taskDetails.integration.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_taskDetails.integration.test.ts | `bun test src/lib/mcp/taskDetails.integration.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_taskDue.integration.test.ts | `bun test src/lib/mcp/taskDue.integration.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_taskDue.integration.test.ts | `bun test src/lib/mcp/taskDue.integration.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_taskFinding.integration.test.ts | `bun test src/lib/mcp/taskFinding.integration.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_taskFinding.integration.test.ts | `bun test src/lib/mcp/taskFinding.integration.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_taskIcon.integration.test.ts | `bun test src/lib/mcp/taskIcon.integration.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_taskIcon.integration.test.ts | `bun test src/lib/mcp/taskIcon.integration.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_taskLineEdits.integration.test.ts | `bun test src/lib/mcp/taskLineEdits.integration.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_taskLineEdits.integration.test.ts | `bun test src/lib/mcp/taskLineEdits.integration.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_taskOwnership.integration.test.ts | `bun test src/lib/mcp/taskOwnership.integration.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_taskOwnership.integration.test.ts | `bun test src/lib/mcp/taskOwnership.integration.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_taskPosition.integration.test.ts | `bun test src/lib/mcp/taskPosition.integration.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_taskPosition.integration.test.ts | `bun test src/lib/mcp/taskPosition.integration.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_taskPriority.integration.test.ts | `bun test src/lib/mcp/taskPriority.integration.test.ts --timeout=60000` | 1 |
| branch-src_lib_mcp_taskPriority.integration.test.ts | `bun test src/lib/mcp/taskPriority.integration.test.ts --timeout=60000` | 1 |
| main-src_lib_mcp_telegramBot.test.ts | `bun test src/lib/mcp/telegramBot.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_telegramBot.test.ts | `bun test src/lib/mcp/telegramBot.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_voiceTools.test.ts | `bun test src/lib/mcp/voiceTools.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_voiceTools.test.ts | `bun test src/lib/mcp/voiceTools.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_voiceUtteranceContext.test.ts | `bun test src/lib/mcp/voiceUtteranceContext.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_voiceUtteranceContext.test.ts | `bun test src/lib/mcp/voiceUtteranceContext.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_voiceUtteranceWiring.test.ts | `bun test src/lib/mcp/voiceUtteranceWiring.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_voiceUtteranceWiring.test.ts | `bun test src/lib/mcp/voiceUtteranceWiring.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_workLinks.test.ts | `bun test src/lib/mcp/workLinks.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_workLinks.test.ts | `bun test src/lib/mcp/workLinks.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_workerLimit.test.ts | `bun test src/lib/mcp/workerLimit.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_workerLimit.test.ts | `bun test src/lib/mcp/workerLimit.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_worktreeBackfill.integration.test.ts | `bun test src/lib/mcp/worktreeBackfill.integration.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_worktreeBackfill.integration.test.ts | `bun test src/lib/mcp/worktreeBackfill.integration.test.ts --timeout=60000` | 0 |
| main-src_lib_memory_curation_curation.test.ts | `bun test src/lib/memory/curation/curation.test.ts --timeout=60000` | 0 |
| branch-src_lib_memory_curation_curation.test.ts | `bun test src/lib/memory/curation/curation.test.ts --timeout=60000` | 0 |
| main-src_lib_memory_curation_curator.eval.test.ts | `bun test src/lib/memory/curation/curator.eval.test.ts --timeout=60000` | 0 |
| branch-src_lib_memory_curation_curator.eval.test.ts | `bun test src/lib/memory/curation/curator.eval.test.ts --timeout=60000` | 0 |
| main-src_lib_memory_roleLane.test.ts | `bun test src/lib/memory/roleLane.test.ts --timeout=60000` | 1 |
| branch-src_lib_memory_roleLane.test.ts | `bun test src/lib/memory/roleLane.test.ts --timeout=60000` | 1 |
| main-src_lib_memory_roleLaunch.test.ts | `bun test src/lib/memory/roleLaunch.test.ts --timeout=60000` | 1 |
| branch-src_lib_memory_roleLaunch.test.ts | `bun test src/lib/memory/roleLaunch.test.ts --timeout=60000` | 1 |
| main-src_lib_memory_roleSelection.test.ts | `bun test src/lib/memory/roleSelection.test.ts --timeout=60000` | 0 |
| branch-src_lib_memory_roleSelection.test.ts | `bun test src/lib/memory/roleSelection.test.ts --timeout=60000` | 0 |
| main-src_lib_memory_roleSelectionRetention.test.ts | `bun test src/lib/memory/roleSelectionRetention.test.ts --timeout=60000` | 0 |
| branch-src_lib_memory_roleSelectionRetention.test.ts | `bun test src/lib/memory/roleSelectionRetention.test.ts --timeout=60000` | 0 |
| main-src_lib_monitor_seatHostRecovery.test.ts | `bun test src/lib/monitor/seatHostRecovery.test.ts --timeout=60000` | 0 |
| branch-src_lib_monitor_seatHostRecovery.test.ts | `bun test src/lib/monitor/seatHostRecovery.test.ts --timeout=60000` | 0 |
| main-src_lib_monitor_seatTickController.reporting.test.ts | `bun test src/lib/monitor/seatTickController.reporting.test.ts --timeout=60000` | 1 |
| branch-src_lib_monitor_seatTickController.reporting.test.ts | `bun test src/lib/monitor/seatTickController.reporting.test.ts --timeout=60000` | 1 |
| main-src_lib_monitor_seatTickSources.test.ts | `bun test src/lib/monitor/seatTickSources.test.ts --timeout=60000` | 1 |
| branch-src_lib_monitor_seatTickSources.test.ts | `bun test src/lib/monitor/seatTickSources.test.ts --timeout=60000` | 1 |
| main-src_lib_orchestrator_ownerRelay.test.ts | `bun test src/lib/orchestrator/ownerRelay.test.ts --timeout=60000` | 1 |
| branch-src_lib_orchestrator_ownerRelay.test.ts | `bun test src/lib/orchestrator/ownerRelay.test.ts --timeout=60000` | 1 |
| main-src_lib_orchestrator_relay.test.ts | `bun test src/lib/orchestrator/relay.test.ts --timeout=60000` | 1 |
| branch-src_lib_orchestrator_relay.test.ts | `bun test src/lib/orchestrator/relay.test.ts --timeout=60000` | 1 |
| main-src_lib_orchestrator_rotationAuthority.test.ts | `bun test src/lib/orchestrator/rotationAuthority.test.ts --timeout=60000` | 1 |
| branch-src_lib_orchestrator_rotationAuthority.test.ts | `bun test src/lib/orchestrator/rotationAuthority.test.ts --timeout=60000` | 1 |
| main-src_lib_orchestrator_seatChannel.test.ts | `bun test src/lib/orchestrator/seatChannel.test.ts --timeout=60000` | 0 |
| branch-src_lib_orchestrator_seatChannel.test.ts | `bun test src/lib/orchestrator/seatChannel.test.ts --timeout=60000` | 0 |
| main-src_lib_pipelines_autoRefreshStore.test.ts | `bun test src/lib/pipelines/autoRefreshStore.test.ts --timeout=60000` | 0 |
| branch-src_lib_pipelines_autoRefreshStore.test.ts | `bun test src/lib/pipelines/autoRefreshStore.test.ts --timeout=60000` | 0 |
| main-src_lib_pipelines_backgroundTaskSettlement.test.ts | `bun test src/lib/pipelines/backgroundTaskSettlement.test.ts --timeout=60000` | 1 |
| branch-src_lib_pipelines_backgroundTaskSettlement.test.ts | `bun test src/lib/pipelines/backgroundTaskSettlement.test.ts --timeout=60000` | 1 |
| main-src_lib_pipelines_coldScan.test.ts | `bun test src/lib/pipelines/coldScan.test.ts --timeout=60000` | 1 |
| branch-src_lib_pipelines_coldScan.test.ts | `bun test src/lib/pipelines/coldScan.test.ts --timeout=60000` | 1 |
| main-src_lib_pipelines_controllerArtifacts.test.ts | `bun test src/lib/pipelines/controllerArtifacts.test.ts --timeout=60000` | 0 |
| branch-src_lib_pipelines_controllerArtifacts.test.ts | `bun test src/lib/pipelines/controllerArtifacts.test.ts --timeout=60000` | 0 |
| main-src_lib_pipelines_controllerLease.reproduction.test.ts | `bun test src/lib/pipelines/controllerLease.reproduction.test.ts --timeout=60000` | 0 |
| branch-src_lib_pipelines_controllerLease.reproduction.test.ts | `bun test src/lib/pipelines/controllerLease.reproduction.test.ts --timeout=60000` | 0 |
| main-src_lib_pipelines_controllerLease.test.ts | `bun test src/lib/pipelines/controllerLease.test.ts --timeout=60000` | 0 |
| branch-src_lib_pipelines_controllerLease.test.ts | `bun test src/lib/pipelines/controllerLease.test.ts --timeout=60000` | 0 |
| main-src_lib_pipelines_decisionAuthority.test.ts | `bun test src/lib/pipelines/decisionAuthority.test.ts --timeout=60000` | 0 |
| branch-src_lib_pipelines_decisionAuthority.test.ts | `bun test src/lib/pipelines/decisionAuthority.test.ts --timeout=60000` | 0 |
| main-src_lib_pipelines_deputyLineage.test.ts | `bun test src/lib/pipelines/deputyLineage.test.ts --timeout=60000` | 0 |
| branch-src_lib_pipelines_deputyLineage.test.ts | `bun test src/lib/pipelines/deputyLineage.test.ts --timeout=60000` | 0 |
| main-src_lib_pipelines_engine.controllerPass.test.ts | `bun test src/lib/pipelines/engine.controllerPass.test.ts --timeout=60000` | 0 |
| branch-src_lib_pipelines_engine.controllerPass.test.ts | `bun test src/lib/pipelines/engine.controllerPass.test.ts --timeout=60000` | 0 |
| main-src_lib_pipelines_engine.controllerSnapshot.test.ts | `bun test src/lib/pipelines/engine.controllerSnapshot.test.ts --timeout=60000` | 0 |
| branch-src_lib_pipelines_engine.controllerSnapshot.test.ts | `bun test src/lib/pipelines/engine.controllerSnapshot.test.ts --timeout=60000` | 0 |
| main-src_lib_pipelines_engine.cpuAdmissionPolling.test.ts | `bun test src/lib/pipelines/engine.cpuAdmissionPolling.test.ts --timeout=60000` | 0 |
| branch-src_lib_pipelines_engine.cpuAdmissionPolling.test.ts | `bun test src/lib/pipelines/engine.cpuAdmissionPolling.test.ts --timeout=60000` | 0 |
| main-src_lib_pipelines_engine.cpuQueue.test.ts | `bun test src/lib/pipelines/engine.cpuQueue.test.ts --timeout=60000` | 0 |
| branch-src_lib_pipelines_engine.cpuQueue.test.ts | `bun test src/lib/pipelines/engine.cpuQueue.test.ts --timeout=60000` | 0 |
| main-src_lib_pipelines_engine.creation.test.ts | `bun test src/lib/pipelines/engine.creation.test.ts --timeout=60000` | 1 |
| branch-src_lib_pipelines_engine.creation.test.ts | `bun test src/lib/pipelines/engine.creation.test.ts --timeout=60000` | 1 |
| main-src_lib_pipelines_engine.pauseMetadata.test.ts | `bun test src/lib/pipelines/engine.pauseMetadata.test.ts --timeout=60000` | 0 |
| branch-src_lib_pipelines_engine.pauseMetadata.test.ts | `bun test src/lib/pipelines/engine.pauseMetadata.test.ts --timeout=60000` | 0 |
| main-src_lib_pipelines_engine.ports.part2.test.ts | `bun test src/lib/pipelines/engine.ports.part2.test.ts --timeout=60000` | 0 |
| branch-src_lib_pipelines_engine.ports.part2.test.ts | `bun test src/lib/pipelines/engine.ports.part2.test.ts --timeout=60000` | 0 |
| main-src_lib_pipelines_engine.ports.part3.test.ts | `bun test src/lib/pipelines/engine.ports.part3.test.ts --timeout=60000` | 0 |
| branch-src_lib_pipelines_engine.ports.part3.test.ts | `bun test src/lib/pipelines/engine.ports.part3.test.ts --timeout=60000` | 0 |
| main-src_lib_pipelines_engine.ports.test.ts | `bun test src/lib/pipelines/engine.ports.test.ts --timeout=60000` | 0 |
| branch-src_lib_pipelines_engine.ports.test.ts | `bun test src/lib/pipelines/engine.ports.test.ts --timeout=60000` | 0 |
| main-src_lib_pipelines_engine.publication.test.ts | `bun test src/lib/pipelines/engine.publication.test.ts --timeout=60000` | 0 |
| branch-src_lib_pipelines_engine.publication.test.ts | `bun test src/lib/pipelines/engine.publication.test.ts --timeout=60000` | 0 |
| main-src_lib_pipelines_engine.recovery.part2.test.ts | `bun test src/lib/pipelines/engine.recovery.part2.test.ts --timeout=60000` | 0 |
| branch-src_lib_pipelines_engine.recovery.part2.test.ts | `bun test src/lib/pipelines/engine.recovery.part2.test.ts --timeout=60000` | 0 |
| main-src_lib_pipelines_engine.routing.test.ts | `bun test src/lib/pipelines/engine.routing.test.ts --timeout=60000` | 1 |
| branch-src_lib_pipelines_engine.routing.test.ts | `bun test src/lib/pipelines/engine.routing.test.ts --timeout=60000` | 1 |
| main-src_lib_pipelines_engine.watchdogRegression.test.ts | `bun test src/lib/pipelines/engine.watchdogRegression.test.ts --timeout=60000` | 0 |
| branch-src_lib_pipelines_engine.watchdogRegression.test.ts | `bun test src/lib/pipelines/engine.watchdogRegression.test.ts --timeout=60000` | 0 |
| main-src_lib_pipelines_engineConnectionRefusal.test.ts | `bun test src/lib/pipelines/engineConnectionRefusal.test.ts --timeout=60000` | 1 |
| branch-src_lib_pipelines_engineConnectionRefusal.test.ts | `bun test src/lib/pipelines/engineConnectionRefusal.test.ts --timeout=60000` | 1 |
| main-src_lib_pipelines_git.test.ts | `bun test src/lib/pipelines/git.test.ts --timeout=60000` | 1 |
| branch-src_lib_pipelines_git.test.ts | `bun test src/lib/pipelines/git.test.ts --timeout=60000` | 1 |
| main-src_lib_pipelines_graphEdits.test.ts | `bun test src/lib/pipelines/graphEdits.test.ts --timeout=60000` | 0 |
| branch-src_lib_pipelines_graphEdits.test.ts | `bun test src/lib/pipelines/graphEdits.test.ts --timeout=60000` | 0 |
| main-src_lib_pipelines_handLaunch.test.ts | `bun test src/lib/pipelines/handLaunch.test.ts --timeout=60000` | 0 |
| branch-src_lib_pipelines_handLaunch.test.ts | `bun test src/lib/pipelines/handLaunch.test.ts --timeout=60000` | 0 |
| main-src_lib_pipelines_legacyReviewConversion.test.ts | `bun test src/lib/pipelines/legacyReviewConversion.test.ts --timeout=60000` | 0 |
| branch-src_lib_pipelines_legacyReviewConversion.test.ts | `bun test src/lib/pipelines/legacyReviewConversion.test.ts --timeout=60000` | 0 |
| main-src_lib_pipelines_legacyReviewStore.test.ts | `bun test src/lib/pipelines/legacyReviewStore.test.ts --timeout=60000` | 0 |
| branch-src_lib_pipelines_legacyReviewStore.test.ts | `bun test src/lib/pipelines/legacyReviewStore.test.ts --timeout=60000` | 0 |
| main-src_lib_pipelines_parkedPublication.test.ts | `bun test src/lib/pipelines/parkedPublication.test.ts --timeout=60000` | 1 |
| branch-src_lib_pipelines_parkedPublication.test.ts | `bun test src/lib/pipelines/parkedPublication.test.ts --timeout=60000` | 1 |
| main-src_lib_pipelines_prompts.test.ts | `bun test src/lib/pipelines/prompts.test.ts --timeout=60000` | 0 |
| branch-src_lib_pipelines_prompts.test.ts | `bun test src/lib/pipelines/prompts.test.ts --timeout=60000` | 0 |
| main-src_lib_pipelines_registryCompatibility.test.ts | `bun test src/lib/pipelines/registryCompatibility.test.ts --timeout=60000` | 0 |
| branch-src_lib_pipelines_registryCompatibility.test.ts | `bun test src/lib/pipelines/registryCompatibility.test.ts --timeout=60000` | 0 |
| main-src_lib_pipelines_remoteActions.test.ts | `bun test src/lib/pipelines/remoteActions.test.ts --timeout=60000` | 124 |
| branch-src_lib_pipelines_remoteActions.test.ts | `bun test src/lib/pipelines/remoteActions.test.ts --timeout=60000` | 124 |
| main-src_lib_pipelines_resolveDecision.test.ts | `bun test src/lib/pipelines/resolveDecision.test.ts --timeout=60000` | 0 |
| branch-src_lib_pipelines_resolveDecision.test.ts | `bun test src/lib/pipelines/resolveDecision.test.ts --timeout=60000` | 0 |
| main-src_lib_pipelines_retirementEvidence.test.ts | `bun test src/lib/pipelines/retirementEvidence.test.ts --timeout=60000` | 0 |
| branch-src_lib_pipelines_retirementEvidence.test.ts | `bun test src/lib/pipelines/retirementEvidence.test.ts --timeout=60000` | 0 |
| main-src_lib_pipelines_revalidation.test.ts | `bun test src/lib/pipelines/revalidation.test.ts --timeout=60000` | 0 |
| branch-src_lib_pipelines_revalidation.test.ts | `bun test src/lib/pipelines/revalidation.test.ts --timeout=60000` | 0 |
| main-src_lib_pipelines_runtimeSwitch.test.ts | `bun test src/lib/pipelines/runtimeSwitch.test.ts --timeout=60000` | 1 |
| branch-src_lib_pipelines_runtimeSwitch.test.ts | `bun test src/lib/pipelines/runtimeSwitch.test.ts --timeout=60000` | 1 |
| main-src_lib_pipelines_severedStageRetry.test.ts | `bun test src/lib/pipelines/severedStageRetry.test.ts --timeout=60000` | 1 |
| branch-src_lib_pipelines_severedStageRetry.test.ts | `bun test src/lib/pipelines/severedStageRetry.test.ts --timeout=60000` | 1 |
| main-src_lib_pipelines_severedTurnResume.test.ts | `bun test src/lib/pipelines/severedTurnResume.test.ts --timeout=60000` | 1 |
| branch-src_lib_pipelines_severedTurnResume.test.ts | `bun test src/lib/pipelines/severedTurnResume.test.ts --timeout=60000` | 1 |
| main-src_lib_pipelines_spawnRestartRecovery.test.ts | `bun test src/lib/pipelines/spawnRestartRecovery.test.ts --timeout=60000` | 0 |
| branch-src_lib_pipelines_spawnRestartRecovery.test.ts | `bun test src/lib/pipelines/spawnRestartRecovery.test.ts --timeout=60000` | 0 |
| main-src_lib_pipelines_stageAccountBinding.test.ts | `bun test src/lib/pipelines/stageAccountBinding.test.ts --timeout=60000` | 0 |
| branch-src_lib_pipelines_stageAccountBinding.test.ts | `bun test src/lib/pipelines/stageAccountBinding.test.ts --timeout=60000` | 0 |
| main-src_lib_pipelines_stageCommitRepair.test.ts | `bun test src/lib/pipelines/stageCommitRepair.test.ts --timeout=60000` | 1 |
| branch-src_lib_pipelines_stageCommitRepair.test.ts | `bun test src/lib/pipelines/stageCommitRepair.test.ts --timeout=60000` | 1 |
| main-src_lib_pipelines_stageCompletion.test.ts | `bun test src/lib/pipelines/stageCompletion.test.ts --timeout=60000` | 1 |
| branch-src_lib_pipelines_stageCompletion.test.ts | `bun test src/lib/pipelines/stageCompletion.test.ts --timeout=60000` | 1 |
| main-src_lib_pipelines_stageHostGenerationClose.integration.test.ts | `bun test src/lib/pipelines/stageHostGenerationClose.integration.test.ts --timeout=60000` | 1 |
| branch-src_lib_pipelines_stageHostGenerationClose.integration.test.ts | `bun test src/lib/pipelines/stageHostGenerationClose.integration.test.ts --timeout=60000` | 1 |
| main-src_lib_pipelines_stageInput.test.ts | `bun test src/lib/pipelines/stageInput.test.ts --timeout=60000` | 1 |
| branch-src_lib_pipelines_stageInput.test.ts | `bun test src/lib/pipelines/stageInput.test.ts --timeout=60000` | 1 |
| main-src_lib_pipelines_stagePublicationRepair.test.ts | `bun test src/lib/pipelines/stagePublicationRepair.test.ts --timeout=60000` | 1 |
| branch-src_lib_pipelines_stagePublicationRepair.test.ts | `bun test src/lib/pipelines/stagePublicationRepair.test.ts --timeout=60000` | 1 |
| main-src_lib_pipelines_stagePullRequest.test.ts | `bun test src/lib/pipelines/stagePullRequest.test.ts --timeout=60000` | 1 |
| branch-src_lib_pipelines_stagePullRequest.test.ts | `bun test src/lib/pipelines/stagePullRequest.test.ts --timeout=60000` | 1 |
| main-src_lib_pipelines_stageSizing.test.ts | `bun test src/lib/pipelines/stageSizing.test.ts --timeout=60000` | 1 |
| branch-src_lib_pipelines_stageSizing.test.ts | `bun test src/lib/pipelines/stageSizing.test.ts --timeout=60000` | 1 |
| main-src_lib_pipelines_stageVerdictRequest.test.ts | `bun test src/lib/pipelines/stageVerdictRequest.test.ts --timeout=60000` | 1 |
| branch-src_lib_pipelines_stageVerdictRequest.test.ts | `bun test src/lib/pipelines/stageVerdictRequest.test.ts --timeout=60000` | 1 |
| main-src_lib_pipelines_startupResponsiveness.test.ts | `bun test src/lib/pipelines/startupResponsiveness.test.ts --timeout=60000` | 0 |
| branch-src_lib_pipelines_startupResponsiveness.test.ts | `bun test src/lib/pipelines/startupResponsiveness.test.ts --timeout=60000` | 0 |
| main-src_lib_pipelines_store.reads.test.ts | `bun test src/lib/pipelines/store.reads.test.ts --timeout=60000` | 0 |
| branch-src_lib_pipelines_store.reads.test.ts | `bun test src/lib/pipelines/store.reads.test.ts --timeout=60000` | 0 |
| main-src_lib_pipelines_store.test.ts | `bun test src/lib/pipelines/store.test.ts --timeout=60000` | 0 |
| branch-src_lib_pipelines_store.test.ts | `bun test src/lib/pipelines/store.test.ts --timeout=60000` | 0 |
| main-src_lib_pipelines_taskBinding.test.ts | `bun test src/lib/pipelines/taskBinding.test.ts --timeout=60000` | 0 |
| branch-src_lib_pipelines_taskBinding.test.ts | `bun test src/lib/pipelines/taskBinding.test.ts --timeout=60000` | 0 |
| main-src_lib_pipelines_terminalReap.test.ts | `bun test src/lib/pipelines/terminalReap.test.ts --timeout=60000` | 0 |
| branch-src_lib_pipelines_terminalReap.test.ts | `bun test src/lib/pipelines/terminalReap.test.ts --timeout=60000` | 0 |
| main-src_lib_projects_durableMigration.test.ts | `bun test src/lib/projects/durableMigration.test.ts --timeout=60000` | 0 |
| branch-src_lib_projects_durableMigration.test.ts | `bun test src/lib/projects/durableMigration.test.ts --timeout=60000` | 0 |
| main-src_lib_projects_shortIds.test.ts | `bun test src/lib/projects/shortIds.test.ts --timeout=60000` | 1 |
| branch-src_lib_projects_shortIds.test.ts | `bun test src/lib/projects/shortIds.test.ts --timeout=60000` | 1 |
| main-src_lib_prototypeReview_http.test.ts | `bun test src/lib/prototypeReview/http.test.ts --timeout=60000` | 1 |
| branch-src_lib_prototypeReview_http.test.ts | `bun test src/lib/prototypeReview/http.test.ts --timeout=60000` | 1 |
| main-src_lib_prototypeReview_mcpReceipts.test.ts | `bun test src/lib/prototypeReview/mcpReceipts.test.ts --timeout=60000` | 1 |
| branch-src_lib_prototypeReview_mcpReceipts.test.ts | `bun test src/lib/prototypeReview/mcpReceipts.test.ts --timeout=60000` | 1 |
| main-src_lib_realtime_voiceCardChain.dom.test.ts | `bun test src/lib/realtime/voiceCardChain.dom.test.ts --timeout=60000` | 0 |
| branch-src_lib_realtime_voiceCardChain.dom.test.ts | `bun test src/lib/realtime/voiceCardChain.dom.test.ts --timeout=60000` | 0 |
| main-src_lib_runtime_agentRecordAuthors.test.ts | `bun test src/lib/runtime/agentRecordAuthors.test.ts --timeout=60000` | 0 |
| branch-src_lib_runtime_agentRecordAuthors.test.ts | `bun test src/lib/runtime/agentRecordAuthors.test.ts --timeout=60000` | 0 |
| main-src_lib_runtime_attemptTempProduction.test.ts | `bun test src/lib/runtime/attemptTempProduction.test.ts --timeout=60000` | 0 |
| branch-src_lib_runtime_attemptTempProduction.test.ts | `bun test src/lib/runtime/attemptTempProduction.test.ts --timeout=60000` | 0 |
| main-src_lib_runtime_claudeStreamBrokerHost.integration.test.ts | `bun test src/lib/runtime/claudeStreamBrokerHost.integration.test.ts --timeout=60000` | 0 |
| branch-src_lib_runtime_claudeStreamBrokerHost.integration.test.ts | `bun test src/lib/runtime/claudeStreamBrokerHost.integration.test.ts --timeout=60000` | 0 |
| main-src_lib_runtime_codexAppServerHost.integration.test.ts | `bun test src/lib/runtime/codexAppServerHost.integration.test.ts --timeout=60000` | 0 |
| branch-src_lib_runtime_codexAppServerHost.integration.test.ts | `bun test src/lib/runtime/codexAppServerHost.integration.test.ts --timeout=60000` | 0 |
| main-src_lib_runtime_copilotAcpHost.integration.test.ts | `bun test src/lib/runtime/copilotAcpHost.integration.test.ts --timeout=60000` | 1 |
| branch-src_lib_runtime_copilotAcpHost.integration.test.ts | `bun test src/lib/runtime/copilotAcpHost.integration.test.ts --timeout=60000` | 1 |
| main-src_lib_runtime_legacyClaudeRecovery.cleanCi.integration.test.ts | `bun test src/lib/runtime/legacyClaudeRecovery.cleanCi.integration.test.ts --timeout=60000` | 1 |
| branch-src_lib_runtime_legacyClaudeRecovery.cleanCi.integration.test.ts | `bun test src/lib/runtime/legacyClaudeRecovery.cleanCi.integration.test.ts --timeout=60000` | 1 |
| main-src_lib_runtime_permissionGuard.test.ts | `bun test src/lib/runtime/permissionGuard.test.ts --timeout=60000` | 0 |
| branch-src_lib_runtime_permissionGuard.test.ts | `bun test src/lib/runtime/permissionGuard.test.ts --timeout=60000` | 0 |
| main-src_lib_runtime_pipelineStageHostAccess.integration.test.ts | `bun test src/lib/runtime/pipelineStageHostAccess.integration.test.ts --timeout=60000` | 0 |
| branch-src_lib_runtime_pipelineStageHostAccess.integration.test.ts | `bun test src/lib/runtime/pipelineStageHostAccess.integration.test.ts --timeout=60000` | 0 |
| main-src_lib_runtime_sendSettlement.test.ts | `bun test src/lib/runtime/sendSettlement.test.ts --timeout=60000` | 0 |
| branch-src_lib_runtime_sendSettlement.test.ts | `bun test src/lib/runtime/sendSettlement.test.ts --timeout=60000` | 0 |
| main-src_lib_runtime_startup.test.ts | `bun test src/lib/runtime/startup.test.ts --timeout=60000` | 1 |
| branch-src_lib_runtime_startup.test.ts | `bun test src/lib/runtime/startup.test.ts --timeout=60000` | 1 |
| main-src_lib_runtime_startupFinalization.integration.test.ts | `bun test src/lib/runtime/startupFinalization.integration.test.ts --timeout=60000` | 1 |
| branch-src_lib_runtime_startupFinalization.integration.test.ts | `bun test src/lib/runtime/startupFinalization.integration.test.ts --timeout=60000` | 1 |
| main-src_lib_runtime_structuredRecovery.test.ts | `bun test src/lib/runtime/structuredRecovery.test.ts --timeout=60000` | 0 |
| branch-src_lib_runtime_structuredRecovery.test.ts | `bun test src/lib/runtime/structuredRecovery.test.ts --timeout=60000` | 0 |
| main-src_lib_scanner_filesResponseWorker.test.ts | `bun test src/lib/scanner/filesResponseWorker.test.ts --timeout=60000` | 0 |
| branch-src_lib_scanner_filesResponseWorker.test.ts | `bun test src/lib/scanner/filesResponseWorker.test.ts --timeout=60000` | 0 |
| main-src_lib_scanner_scanCache.catalogFreshness.test.tsx | `bun test src/lib/scanner/scanCache.catalogFreshness.test.tsx --timeout=60000` | 0 |
| branch-src_lib_scanner_scanCache.catalogFreshness.test.tsx | `bun test src/lib/scanner/scanCache.catalogFreshness.test.tsx --timeout=60000` | 0 |
| main-src_lib_selfUpdate_workEvidence.test.ts | `bun test src/lib/selfUpdate/workEvidence.test.ts --timeout=60000` | 1 |
| branch-src_lib_selfUpdate_workEvidence.test.ts | `bun test src/lib/selfUpdate/workEvidence.test.ts --timeout=60000` | 1 |
| main-src_lib_state_historyProjection.test.ts | `bun test src/lib/state/historyProjection.test.ts --timeout=60000` | 1 |
| branch-src_lib_state_historyProjection.test.ts | `bun test src/lib/state/historyProjection.test.ts --timeout=60000` | 1 |
| main-src_lib_state_hotStateStores.benchmark.test.ts | `bun test src/lib/state/hotStateStores.benchmark.test.ts --timeout=60000` | 0 |
| branch-src_lib_state_hotStateStores.benchmark.test.ts | `bun test src/lib/state/hotStateStores.benchmark.test.ts --timeout=60000` | 0 |
| main-src_lib_state_hotStateStores.sqlite.test.ts | `bun test src/lib/state/hotStateStores.sqlite.test.ts --timeout=60000` | 0 |
| branch-src_lib_state_hotStateStores.sqlite.test.ts | `bun test src/lib/state/hotStateStores.sqlite.test.ts --timeout=60000` | 0 |
| main-src_lib_state_registryRecords.test.ts | `bun test src/lib/state/registryRecords.test.ts --timeout=60000` | 0 |
| branch-src_lib_state_registryRecords.test.ts | `bun test src/lib/state/registryRecords.test.ts --timeout=60000` | 0 |
| main-src_lib_tasks_launchMembership.registry.test.ts | `bun test src/lib/tasks/launchMembership.registry.test.ts --timeout=60000` | 1 |
| branch-src_lib_tasks_launchMembership.registry.test.ts | `bun test src/lib/tasks/launchMembership.registry.test.ts --timeout=60000` | 1 |
| main-src_lib_tasks_seatRecoveryCleanup.test.ts | `bun test src/lib/tasks/seatRecoveryCleanup.test.ts --timeout=60000` | 0 |
| branch-src_lib_tasks_seatRecoveryCleanup.test.ts | `bun test src/lib/tasks/seatRecoveryCleanup.test.ts --timeout=60000` | 0 |
| main-src_lib_voiceCompanion_liveSession.test.ts | `bun test src/lib/voiceCompanion/liveSession.test.ts --timeout=60000` | 0 |
| branch-src_lib_voiceCompanion_liveSession.test.ts | `bun test src/lib/voiceCompanion/liveSession.test.ts --timeout=60000` | 0 |
| main-src_lib_voiceCompanion_readPaths.test.ts | `bun test src/lib/voiceCompanion/readPaths.test.ts --timeout=60000` | 1 |
| branch-src_lib_voiceCompanion_readPaths.test.ts | `bun test src/lib/voiceCompanion/readPaths.test.ts --timeout=60000` | 1 |
| main-src_proxy.team.test.ts | `bun test src/proxy.team.test.ts --timeout=60000` | 0 |
| branch-src_proxy.team.test.ts | `bun test src/proxy.team.test.ts --timeout=60000` | 0 |
| main-src_runtime-host_candidateStateDataset.test.ts | `bun test src/runtime-host/candidateStateDataset.test.ts --timeout=60000` | 0 |
| branch-src_runtime-host_candidateStateDataset.test.ts | `bun test src/runtime-host/candidateStateDataset.test.ts --timeout=60000` | 0 |
| main-src_lib_externalRelay_runner.test.ts | `bun test src/lib/externalRelay/runner.test.ts --timeout=60000` | 1 |
| branch-src_lib_externalRelay_runner.test.ts | `bun test src/lib/externalRelay/runner.test.ts --timeout=60000` | 1 |

Final native fixture, additional importers and whole-file repeats:

| Variant | Command | Exit |
| --- | --- | ---: |
| copilot-readiness-probe | `bun test src/lib/runtime/copilotAcpHost.integration.test.ts --test-name-pattern 'spawn, send, interrupt-and-resend, interrupt, resume, render and account isolation' --timeout=60000` | 0 |
| types-branch | `bun x tsc --noEmit --incremental false` | 0 |
| eslint-branch | `bun x eslint src/lib/runtime/copilotAcpHost.integration.test.ts` | 0 |
| build-main | `bun scripts/build-mcp.ts` | 0 |
| copilot-file-main | `bun test src/lib/runtime/copilotAcpHost.integration.test.ts --timeout=60000` | 1 |
| build-branch | `bun scripts/build-mcp.ts` | 0 |
| copilot-file-branch | `bun test src/lib/runtime/copilotAcpHost.integration.test.ts --timeout=60000` | 1 |
| copilot-positive-a | `bun test src/lib/runtime/copilotAcpHost.integration.test.ts --test-name-pattern 'spawn, send, interrupt-and-resend, interrupt, resume, render and account isolation' --timeout=60000` | 0 |
| copilot-no-cancel | `bun test src/lib/runtime/copilotAcpHost.integration.test.ts --test-name-pattern 'spawn, send, interrupt-and-resend, interrupt, resume, render and account isolation' --timeout=60000` | 1 |
| copilot-positive-b | `bun test src/lib/runtime/copilotAcpHost.integration.test.ts --test-name-pattern 'spawn, send, interrupt-and-resend, interrupt, resume, render and account isolation' --timeout=60000` | 0 |
| extra-main-scripts_eslintServerArchive.test.ts | `bun test scripts/eslintServerArchive.test.ts --timeout=60000` | 0 |
| extra-branch-scripts_eslintServerArchive.test.ts | `bun test scripts/eslintServerArchive.test.ts --timeout=60000` | 0 |
| extra-main-src_lib_mcp_largeReads.test.ts | `bun test src/lib/mcp/largeReads.test.ts --timeout=60000` | 1 |
| extra-branch-src_lib_mcp_largeReads.test.ts | `bun test src/lib/mcp/largeReads.test.ts --timeout=60000` | 1 |
| extra-main-src_lib_mcp_stdio.integration.test.ts | `bun test src/lib/mcp/stdio.integration.test.ts --timeout=60000` | 1 |
| extra-branch-src_lib_mcp_stdio.integration.test.ts | `bun test src/lib/mcp/stdio.integration.test.ts --timeout=60000` | 1 |
| extra-main-src_lib_memory_roleEgressUnreadable.test.ts | `bun test src/lib/memory/roleEgressUnreadable.test.ts --timeout=60000` | 1 |
| extra-branch-src_lib_memory_roleEgressUnreadable.test.ts | `bun test src/lib/memory/roleEgressUnreadable.test.ts --timeout=60000` | 1 |
| extra-main-src_lib_pipelines_engine.settlement.test.ts | `bun test src/lib/pipelines/engine.settlement.test.ts --timeout=60000` | 0 |
| extra-branch-src_lib_pipelines_engine.settlement.test.ts | `bun test src/lib/pipelines/engine.settlement.test.ts --timeout=60000` | 0 |
| git-repeat-1-main | `bun test src/lib/pipelines/git.test.ts --timeout=60000` | 1 |
| git-repeat-1-branch | `bun test src/lib/pipelines/git.test.ts --timeout=60000` | 1 |
| git-repeat-2-main | `bun test src/lib/pipelines/git.test.ts --timeout=60000` | 1 |
| git-repeat-2-branch | `bun test src/lib/pipelines/git.test.ts --timeout=60000` | 1 |

Refreshed-main scratch integration:

| Variant | Command | Exit |
| --- | --- | ---: |
| main-src_lib_pipelines_store.test.ts | `bun test src/lib/pipelines/store.test.ts --timeout=60000` | 0 |
| main-src_lib_mcp_bindings.test.ts | `bun test src/lib/mcp/bindings.test.ts --timeout=60000` | 0 |
| main-src_lib_accounts_codexAppServer.test.ts | `bun test src/lib/accounts/codexAppServer.test.ts --timeout=60000` | 0 |
| main-src_app_api_agent_snapshot_route.test.ts | `bun test src/app/api/agent/snapshot/route.test.ts --timeout=60000` | 0 |
| main-src_lib_runtime_copilotAcpHost.test.ts | `bun test src/lib/runtime/copilotAcpHost.test.ts --timeout=60000` | 0 |
| main-src_lib_forge_taskFinish.test.ts | `bun test src/lib/forge/taskFinish.test.ts --timeout=60000` | 0 |
| branch-src_lib_pipelines_store.test.ts | `bun test src/lib/pipelines/store.test.ts --timeout=60000` | 0 |
| branch-src_lib_mcp_bindings.test.ts | `bun test src/lib/mcp/bindings.test.ts --timeout=60000` | 0 |
| branch-src_lib_accounts_codexAppServer.test.ts | `bun test src/lib/accounts/codexAppServer.test.ts --timeout=60000` | 0 |
| branch-src_app_api_agent_snapshot_route.test.ts | `bun test src/app/api/agent/snapshot/route.test.ts --timeout=60000` | 0 |
| branch-src_lib_runtime_copilotAcpHost.test.ts | `bun test src/lib/runtime/copilotAcpHost.test.ts --timeout=60000` | 0 |
| branch-src_lib_forge_taskFinish.test.ts | `bun test src/lib/forge/taskFinish.test.ts --timeout=60000` | 0 |
| types-integrated | `bun x tsc --noEmit --incremental false` | 0 |
| eslint-integrated | `bun x eslint src/lib/pipelines/store.ts src/lib/pipelines/store.test.ts src/lib/mcp/bindings.ts src/lib/mcp/bindings.test.ts src/lib/accounts/codexAppServer.test.ts src/app/api/agent/snapshot/route.test.ts src/lib/runtime/copilotAcpHost.integration.test.ts` | 0 |
| copilot-integrated | `bun test src/lib/runtime/copilotAcpHost.integration.test.ts --test-name-pattern 'spawn, send, interrupt-and-resend, interrupt, resume, render and account isolation' --timeout=60000` | 0 |
| git-order-control-main | `bun test src/lib/pipelines/git.test.ts --test-name-pattern '^(?!.*closing a lane during a real publication)' --timeout=60000` | 1 |
| git-order-control-branch | `bun test src/lib/pipelines/git.test.ts --test-name-pattern '^(?!.*closing a lane during a real publication)' --timeout=60000` | 1 |
| git-changed-branch-probe | `bun test src/lib/pipelines/git.test.ts --timeout=60000` | 1 |
| remote-actions-long-main | `bun test src/lib/pipelines/remoteActions.test.ts --timeout=60000` | 1 |
| remote-actions-long-branch | `bun test src/lib/pipelines/remoteActions.test.ts --timeout=60000` | 1 |

The initial combined command was `gate-remote -- bun test src/lib/pipelines/store.test.ts src/lib/mcp/bindings.test.ts src/lib/accounts/codexAppServer.test.ts src/app/api/agent/snapshot/route.test.ts --timeout=60000`: exit 1. Its new control-fixture failure is corrected; the final store and bindings file results above supersede that attempt.

All four `git apply --check cloud-N.diff` and `git apply cloud-N.diff` calls returned 0. The #2226 and #2203 reverse-application calls returned 0 before the unsafe draft was dropped and the ID fix rewritten. `bun install --frozen-lockfile` returned 0. Commits use the repository’s standard whitespace, privacy and ESLint hooks.


Decision and publication commands:

| Command | Exit |
| --- | ---: |
| `gh issue view 2231 --comments` | 1 |
| `gh issue view 2231 --comments --json number,title,body,comments` | 0 |
| `git apply --check cloud-2231.diff` | 0 |
| `git apply cloud-2231.diff` | 0 |
| `gh issue view 2226 --comments` | 1 |
| `gh issue view 2226 --comments --json number,title,body,comments` | 0 |
| `git apply --check cloud-2226.diff` | 0 |
| `git apply cloud-2226.diff` | 0 |
| `gh issue view 2210 --comments` | 1 |
| `gh issue view 2210 --comments --json number,title,body,comments` | 0 |
| `git apply --check cloud-2210.diff` | 0 |
| `git apply cloud-2210.diff` | 0 |
| `gh issue view 2203 --comments` | 1 |
| `gh issue view 2203 --comments --json number,title,body,comments` | 0 |
| `git apply --check cloud-2203.diff` | 0 |
| `git apply cloud-2203.diff` | 0 |
| `git apply -R cloud-2226.diff` | 0 |
| `git apply -R cloud-2203.diff` | 0 |
| `git commit (issue 2210)` | 0 |
| `git commit (issue 2231 initial)` | 0 |
| `git commit --amend --no-edit (issue 2231 final)` | 0 |
| `git diff --check` | 0 |
| `git read-tree 800a26ebc10ca2db855d12a71320f75c5f2fb955 (private index)` | 0 |
| `git apply --cached --3way retained.patch (private index)` | 0 |
| `bun scripts/privacy-publication-gate.ts --require-known-values --paths src/lib/mcp/bindings.ts src/lib/mcp/bindings.test.ts` | 0 |
| `git diff --quiet adce5764927f7e838f20070cd2968128912e861c -- src/app/api/files/operatorProjection.ts` | 0 |
| `git diff --numstat adce5764927f7e838f20070cd2968128912e861c -- .github/workflows` | 0 |
| `literal import inventory cross-check (214 references within the 218-file manifest)` | 0 |
| `git apply --cached --3way retained.patch (final private index; all eight exported files match)` | 0 |
| `git commit --file <issue-2203-message>` | 0 |
| `git diff --check adce5764927f7e838f20070cd2968128912e861c HEAD` | 0 |
| `bun run privacy:check` | 0 |
| `git rev-parse --is-shallow-repository (returned false)` | 0 |
| `three-commit issue/provenance and scope verification` | 0 |
| `git diff --check` | 0 |
| `verification report generation and public-path scan` | 0 |

The plain issue-view commands hit the forge client’s retired classic-projects field; their explicit JSON reruns above read each issue and all comments successfully.
