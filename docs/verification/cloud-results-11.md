# Cloud result 11: dates in agent instructions

Origin: Codex Cloud (GPT-6.1 Sol), export `11.diff` and its supplied `11.md` report. Verified on 2026-10-23 against main `adce5764927f7e838f20070cd2968128912e861c`, with result 10 already applied separately.

SHA-256 matches `11.meta.json`: `4cb4bb4dff289fe6df984707ec2d0eec3a78de45da166cebbe4644dbb7b9e30a` (21,971 bytes).

Kept: mandate v59 and its fingerprint; the exact-match upgrade for stored v58 mandates; the 17-byte delta and retry-byte checks; the maintainer's continuation rule; owner relay closing rules; and `create_task`/`update_task` descriptions naming dueAt and rescheduling with dueReason.

Adapted/dropped: replaced the assertion that a new task's dueTz defaults to the operator zone with an instruction to pass dueTz alongside dueAt. Current main requires both on creation; the default is part of unmerged slice 3 (#3269). The remaining imported changes are preserved. The Cloud export also omitted the existing handoff-only owner-prompt fingerprint in `src/lib/externalRelay/ownerTier.test.ts`; it is updated to `be74868380e7cb79d46cd8288af5bb48e14b85d834dc046f28ea9305024ecff6`. Removing only the new paragraph about promise dates reproduces the old pinned hash, so the new pin accounts for the intended wording alone. The complete file is rerun after this fix. No task schema, producer, persistence or authorization change is included.

## Mandate budget

The published design in #3256, §7 and slice 4, specifies the 17-byte replacement. The delivered mandate measures **30,129 bytes < 30,150**; the spawn envelope **30,344 < 30,350**. Neither bound is relaxed. Version 59 pins `c47fcd928d937a62b5c0281d911849a45965e48196a1e0d49af7bd33849985b9`. Reconstructing the previous bullet yields the existing v58 fingerprint, proving the default body changes only by that replacement. Tests also cover upgrade idempotence and the retained retry's original bytes.

## Producers and consumers checked

- Default and stored mandates feed seat spawn, adoption, rotation and handoff sizing. New intents upgrade before preflight; pending retries render the recorded body through `orchestratorMandateWithRoleTable`.
- Maintainer defaults feed role resolution and scheduled maintenance; continuation creation carries the new wording without changing task creation.
- MCP descriptions feed tool registration and tools/list. Existing date refusals remain in `taskDuePatch`, pre-receipt admission, and the locked task mutation; `taskDue.integration.test.ts` checks success, refusal, replay and competing-writer paths.
- Owner closing rules feed initial prompts, continuation prompts and static digests, so a continuation refreshes changed rules.

Open diffs inspected before editing: #3251, #3258, #3269, #3263, #3242, #3241, #3212, #3210 and #3200. The receipt, account, memory and relay lifecycle hunks stay outside this change. #3200 independently takes mandate v59 and changes its fingerprint/bounds: whichever lands second must reconcile those fields against its actual base. The pinned current-main task imports none of that PR.

## Base recheck

Main first advanced to `3dffc54e145fcba779e3ec82fdcff53030728da3` with eight unrelated catalog/startup paths. A later integration train advanced it to `3e570adfba80059eaba26a978402a2e73a02978e`, including other hunks in `ownerRun.ts`, `ownerTier.test.ts`, `mcp/server.ts` and `voiceTools/hub.test.ts`. The mandate remains v58 there; the published design still specifies +17 bytes. The cumulative patch applies cleanly to that train. A separate clean export runs the 15 directly affected suites before and after applying the delivery, followed by typecheck; those results appear below. No commits are created in the rehearsal export. The assigned pipeline branch and full importer comparison retain their captured task-start base.

## Commands and exits

`CLOUD_RESULTS` denotes the supplied private export directory. Heavy commands used the pinned installed gate-slot wrapper, one admitted call at a time, and gate-remote. The remote serial loop ran each file through a fresh isolation helper with private HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR and a closed Viewer control endpoint. Each test launch used setsid with stdin from the null device. Typecheck ran after the test loop.

The combined main inventory contains 165 files (6 for result 10 and 160 for result 11, with one overlap). A whole-repository audit added `evals/roles/lifecycle.test.ts` and `evals/roles/manifest.test.ts` to the initial 158-file wording inventory. Its first call hit the wrapper's fifteen-minute execution deadline: exit 124, with 101 complete results saved and no final count. The remaining 62 files, including the incomplete server file, ran in full from a clean export of the same captured main, under a two-hour execution allowance; its final marker was `RAN_COUNT 62 FAILED 23`, exit 1. The interrupted remote processes subsequently ended; a read-only check found none remaining. Partial file results were discarded. The two eval files and a complete member-CLI progress-file repeat then ran on that same main export. All 165 final baseline results reconcile with the inventory. The original 163-file inventory had 60 failing files on unchanged main; the table also records the eval outcomes. The branch ran its initial 158 files, then both eval files, the corrected owner-prompt fingerprint file and the member-CLI progress-file repeat; a second typecheck followed the final test-file change.

| Command | Exit |
|---|---:|
| `sha256sum "$CLOUD_RESULTS/11.diff"`, compared with `11.meta.json` and byte count | 0 |
| `git apply --check "$CLOUD_RESULTS/11.diff"` | 0 |
| `git apply --check "$TMPDIR/11-main.diff"` | 0 |
| `git apply "$TMPDIR/11-main.diff"` (creation-zone wording adapted) | 0 |
| Initial combined main `gate-remote -- bash -c '<serial isolated test loop>'`, through the pinned wrapper | 124 |
| Main continuation: same command for the remaining 62 explicit paths | 1 |
| Main supplement: both eval paths and the complete member-CLI progress file | 1 |
| Branch `gate-remote -- bash -c '<serial isolated test loop, then typecheck>'` for the initial 158 paths | 1 |
| Final branch supplement: both eval paths, the complete corrected owner-prompt file and the member-CLI progress file | 1 |
| `bun x tsc --noEmit --incremental false` after the initial 158 files | 0 |
| `bun x tsc --noEmit --incremental false` after the final supplement | 0 |
| `bun x eslint src/lib/externalRelay/ownerRun.ts src/lib/mcp/server.ts src/lib/orchestrator/prompt.test.ts src/lib/orchestrator/prompt.ts src/lib/roles/defaults.ts` | 0 |
| `bun x eslint src/lib/mcp/server.ts` after final sentence punctuation | 0 |
| `bun x eslint src/lib/externalRelay/ownerTier.test.ts` | 0 |
| `bun x eslint src/lib/externalRelay/ownerRun.ts src/lib/externalRelay/ownerTier.test.ts src/lib/mcp/server.ts src/lib/orchestrator/prompt.test.ts src/lib/orchestrator/prompt.ts src/lib/roles/defaults.ts` on the final source | 0 |
| Isolated scratch-export mandate byte/fingerprint probe, `bun wording-probe.ts` | 0 |
| Initial `bun owner-fingerprint-probe.ts` without a declared test context | 1 |
| Same probe with an inbox override unsupported by this revision | 1 |
| `NODE_ENV=test bun owner-fingerprint-probe.ts` in the private export | 0 |
| SHA-256 comparisons of the five production/imported files and then all six final changed source files with their remote snapshots | 0 |
| `git apply --check` of the cumulative delivery against the integration-train export | 0 |
| Integration-train baseline: serial remote loop over the 15 directly affected files | 1 |
| Patched integration-train: same loop, then typecheck | 1 |
| `bun x tsc --noEmit --incremental false` on the patched integration-train export | 0 |
| `git diff --check` | 0 |
| `bun scripts/privacy-publication-gate.ts --require-known-values --base origin/main` | 0 |

The first branch observation also failed the member-CLI gate-off assertion, which had passed on main. Complete paired file reruns passed that assertion on both revisions and retained the same three other failures. That initial difference was not reproduced; no cause is attributed to the wording.

The initial probe refusals came from state-ownership checks before prompt comparison; the corrected invocation used a private test context and succeeded. ESLint retains the unchanged unused-variable warning at `src/lib/externalRelay/ownerTier.test.ts:244`.

The branch completed all 160 importer files across the two serial phases; 60 return nonzero. Complete per-file failure identities were compared with main before attribution; no new failure remains. The table lists every file exit code. Browser drivers retain their normal opt-in gates; skipped cases establish no rendered result.

| Command | Main exit | Branch exit |
|---|---:|---:|
| `bun test --timeout=60000 evals/roles/lifecycle.test.ts` | 0 | 0 |
| `bun test --timeout=60000 evals/roles/manifest.test.ts` | 0 | 0 |
| `bun test --timeout=60000 scripts/runtime-host-viewer-adapter.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/app/api/pipelines/route.admission.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/app/api/search/memory/route.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/app/api/search/transcripts/route.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/app/api/spawn/route.stageTasks.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/app/api/spawn/route.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/components/LogFeed.startingWindow.dom.test.tsx` | 0 | 0 |
| `bun test --timeout=60000 src/components/feed/MandateCard.dom.test.tsx` | 0 | 0 |
| `bun test --timeout=60000 src/components/feed/mandateMessage.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/components/kanban/kanbanBoard.browser.test.tsx` | 0 | 0 |
| `bun test --timeout=60000 src/components/mobile/MobileOrchestratorSheet.render.test.tsx` | 0 | 0 |
| `bun test --timeout=60000 src/components/mobile/MobileSeatTickSheet.dom.test.tsx` | 1 | 1 |
| `bun test --timeout=60000 src/components/mobile/issue1671Evidence.browser.test.tsx` | 0 | 0 |
| `bun test --timeout=60000 src/components/mobile/mobileOrchestratorControls.dom.test.tsx` | 0 | 0 |
| `bun test --timeout=60000 src/components/mobile/mobileOrchestratorLeaves.dom.test.tsx` | 0 | 0 |
| `bun test --timeout=60000 src/components/mobile/mobileSeatCard.dom.test.tsx` | 0 | 0 |
| `bun test --timeout=60000 src/components/onboarding/OnboardingDialog.dom.test.tsx` | 0 | 0 |
| `bun test --timeout=60000 src/components/orchestrator/OrchestratorPanel.dom.test.tsx` | 0 | 0 |
| `bun test --timeout=60000 src/components/orchestrator/draftPrefill.dom.test.tsx` | 0 | 0 |
| `bun test --timeout=60000 src/components/orchestrator/seatState.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/boardMaintenance/guard.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/externalRelay/conversations.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/externalRelay/hold.runner.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/externalRelay/ownerAnswer.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/externalRelay/ownerAttachment.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/externalRelay/ownerBridgeContext.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/externalRelay/ownerOutboundContext.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/externalRelay/ownerRelayContract.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/externalRelay/ownerStop.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/externalRelay/ownerTier.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/externalRelay/progressSteps.runner.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/externalRelay/prompt.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/externalRelay/requestWindow.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/externalRelay/runner.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/flows/decisions.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/flows/retirement.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/accountProjectBinding.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/agentFleet.binding.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/answerSizes.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/autoUpdates.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/autonomy.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/bindings.deploy.replay.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/bindings.deploy.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/bindings.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/bridgeReportOrigin.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/bridgeReportShape.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/callCost.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/callerIdentification.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/callerResolution.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/coldScan.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/controlPlaneReads.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/conversationAction.integration.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/conversationMigration.integration.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/crossProject.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/curateRules.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/deployAuthority.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/deploymentListPages.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/deploymentReads.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/deputyAttribution.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/dismissAttention.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/http.cancellation.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/http.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/inputLimits.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/interruptedCall.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/issueReport.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/largeReads.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/leaveLesson.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/leaveLessonOperator.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/leaveLessonSeat.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/linkedSeatTools.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/maintainerGuard.integration.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/modelInput.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/nativeWorkMetadata.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/orchestratorSendRecovery.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/orchestratorTools.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/originalKeySendRecovery.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/pageCursors.integration.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/pageCursors.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/pipelineBusyAdmission.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/pipelineRoleFence.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/projectResolution.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/pullRequestReads.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/readLatency.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/relayOwnerHistory.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/relayServiceTools.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/releaseSettings.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/reportTools.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/requestAttention.immediate.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/requestAttention.targets.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/requestAttention.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/retirementStatus.integration.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/retirementStatus.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/retryStageLaunch.integration.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/reviewDispatchFailure.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/rolePresets.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/schemaParity.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/searchMemory.budget.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/searchMemory.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/seatAnswerBudgets.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/selectedContextActions.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/server.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/shortIds.answers.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/spawnAccount.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/spawnDeployer.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/spawnRecovery.integration.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/stdio.integration.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/taskBoardVisibility.integration.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/taskColor.integration.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/taskColorGroupHide.integration.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/taskDetails.integration.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/taskDue.integration.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/taskExecutor.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/taskFinding.integration.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/taskIcon.integration.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/taskLineEdits.integration.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/taskOwnership.integration.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/taskPosition.integration.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/taskPriority.integration.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/mcp/telegramBot.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/toolAllowlist.service.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/toolAllowlist.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/voiceTools.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/voiceUtteranceContext.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/workerLimit.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/worktreeBackfill.integration.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/monitor/report.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/orchestrator/handoffDigest.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/orchestrator/operatorDecisionForms.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/orchestrator/ownerRelay.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/orchestrator/prompt.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/orchestrator/relay.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/orchestrator/rotationAuthority.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/orchestrator/seatCommand.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/pipelines/coldScan.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/pipelines/engine.pauseMetadata.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/pipelines/legacyReviewConversion.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/pipelines/prompts.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/pipelines/resolveDecision.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/pipelines/roles.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/pipelines/stageCompletion.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/projects/shortIds.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/prototypeReview/http.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/prototypeReview/mcpReceipts.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/realtime/voiceCardChain.dom.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/roles/costHints.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/roles/defaults.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/roles/parameters.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/roles/registry.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/roles/workerLimit.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/runtime/agentSignalSandbox.mcp.integration.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/runtime/claudeMessageProvenance.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/runtime/deliveredMessageOccurrences.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/runtime/structuredSpawn.terminalize.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/state/declaredIndexes.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/voiceCompanion/provider.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/voiceCompanion/tools.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/runtime-host/mcpRuntimeCompatibility.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/runtime-host/mcpRuntimeProbe.test.ts` | 1 | 1 |

## Integration-train rehearsal

The following complete files ran on the unchanged train and again with both patches applied; no new failing assertion appeared.

| Command | Train exit | Patched train exit |
|---|---:|---:|
| `bun test --timeout=60000 src/lib/voiceTools/contracts.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/voiceTools/hub.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/voiceTools/store.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/app/api/voice-tools/route.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/components/voiceCompanion/VoiceToolsSetting.dom.test.tsx` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/voiceTools.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/externalRelay/ownerTier.test.ts` | 1 | 1 |
| `bun test --timeout=60000 src/lib/externalRelay/ownerRelayContract.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/externalRelay/prompt.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/server.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/taskDue.integration.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/orchestrator/prompt.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/orchestrator/handoffDigest.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/roles/defaults.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/roles/registry.test.ts` | 0 | 0 |

Self-review: production edits contain instructions and the stored-mandate text upgrade. The default-body fingerprint and byte limits remain pinned. Task write paths and workflows are unchanged. No performance gain is claimed.
