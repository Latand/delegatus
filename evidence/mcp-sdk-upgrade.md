# MCP SDK upgrade verification

Selected **@modelcontextprotocol/sdk 1.32.0**. The [upstream task-session advisory](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-22jm-h49p-29qw) identifies versions >=1.24.0 and <1.32.0 as affected and 1.32.0 as patched. The [npm registry record](https://registry.npmjs.org/@modelcontextprotocol%2fsdk/1.32.0) confirms that release exists. This is the lowest patched release.

`bun install` updated the exact SDK pin and its `bun.lock` resolution/integrity. A package-record comparison found one changed dependency record, the SDK. All other resolutions and the audit allowlist retain their prior values.

Compared unchanged main at `2132b947` with the same source plus the SDK update, using Bun 1.4.0. Each explicit test file ran in a fresh process with private HOME, XDG config/cache, LLV_STATE_DIR and TMPDIR beneath the OS temporary root, and LLV_VIEWER_CONTROL_URL on closed loopback port 1. Heavy commands ran under the task-provided owned `scripts/gate-slot.sh` wrapper; the test preload also owns each test process and its descendants. The baseline source was checked with `git diff --exit-code HEAD` before comparison. Preliminary runs using a different scratch environment are excluded.

The test command was `bun test ./<file>` for each file below. The complete branch inventory was 101 MCP files, all 23 `bin/*.test.ts` files, and the runtime-host MCP probe. Baseline sampling covers every MCP file and every failing branch file. Existing platform skips are shown. No test source or skip condition was changed.

## Required checks

| Check | Outcome |
| --- | --- |
| Frozen lockfile and `scripts/supply-chain-check.ts --base 2132b947` | PASS; branch audit has no high/critical findings under the existing allowlist |
| Unchanged SDK 1.31.0 audit control | Expected rejection: two SDK high advisories |
| `bun x tsc --noEmit` | PASS |
| `bun run build` (Viewer and production MCP bundle) | PASS |
| `src/lib/mcp/answerSizes.test.ts` | 8 pass before / 8 pass after |
| `scripts/verify-viewer-runtime.ts` | PASS under Bun 1.4.0: 32/32 server modules loaded, GET / returned 200 |
| `scripts/verify-runtime-host.ts` | PASS under Bun 1.4.0: succession completed; listener and socket each answered 27/27, including abandoned-peer traffic |
| `scripts/verify-bun-runtime-controls.ts` | PASS: missing build, unloadable Viewer module and absent runtime host produced named failures |

The runtime commands are the commands used by the pre-push runtime lane. Publication and the complete pre-push hook remain pipeline-owned.

## Every MCP test file: before / after

Counts describe the observed complete file run. FAIL rows retain their observed failures. Full-file stdio runs reached the same five-minute execution limit; the complete complementary runs are listed below.

Every consistent post-upgrade assertion failure matched the same assertion on the baseline. The two intermittent fixture observations passed unchanged focused replays. The eight opt-in native model-input cases remain gated in both versions; the native stdio contract is covered by the 16-case subset below.

| File | Before: SDK 1.31.0 | After: SDK 1.32.0 | Classification |
| --- | --- | --- | --- |
| `bin/mcp-server.test.ts` | 28 pass / 0 fail / 1 skip | 28 pass / 0 fail / 1 skip | Candidate passed |
| `bin/telegram-mcp-server.test.ts` | 1 pass / 0 fail | 1 pass / 0 fail | Candidate passed |
| `src/lib/mcp/accountProjectBinding.test.ts` | 10 pass / 0 fail | 10 pass / 0 fail | Candidate passed |
| `src/lib/mcp/agentFleet.binding.test.ts` | 10 pass / 2 fail | 10 pass / 2 fail | Pre-existing on main |
| `src/lib/mcp/agentFleet.test.ts` | 11 pass / 0 fail | 11 pass / 0 fail | Candidate passed |
| `src/lib/mcp/answerSizes.test.ts` | 8 pass / 0 fail | 8 pass / 0 fail | Candidate passed |
| `src/lib/mcp/autoUpdates.test.ts` | 17 pass / 4 fail | 17 pass / 4 fail | Pre-existing on main |
| `src/lib/mcp/autonomy.test.ts` | 6 pass / 2 fail | 6 pass / 2 fail | Pre-existing on main |
| `src/lib/mcp/bindings.deploy.replay.test.ts` | 2 pass / 0 fail | 2 pass / 0 fail | Candidate passed |
| `src/lib/mcp/bindings.deploy.test.ts` | 14 pass / 0 fail | 14 pass / 0 fail | Candidate passed |
| `src/lib/mcp/bindings.test.ts` | 111 pass / 0 fail | 111 pass / 0 fail | Candidate passed |
| `src/lib/mcp/bridgeDirective.test.ts` | 15 pass / 1 fail | 15 pass / 1 fail | Pre-existing on main |
| `src/lib/mcp/bridgeReportOrigin.test.ts` | 0 pass / 10 fail | 0 pass / 10 fail | Pre-existing on main |
| `src/lib/mcp/bridgeReportShape.test.ts` | 59 pass / 0 fail | 59 pass / 0 fail | Candidate passed |
| `src/lib/mcp/callCost.test.ts` | 15 pass / 1 fail | 15 pass / 1 fail | Pre-existing on main |
| `src/lib/mcp/callerResolution.test.ts` | 13 pass / 0 fail | 13 pass / 0 fail | Candidate passed |
| `src/lib/mcp/coldScan.test.ts` | 12 pass / 0 fail | 12 pass / 0 fail | Candidate passed |
| `src/lib/mcp/compactAnswers.activity.test.ts` | 1 pass / 0 fail | 1 pass / 0 fail | Candidate passed |
| `src/lib/mcp/compactAnswers.test.ts` | 11 pass / 1 fail | 11 pass / 1 fail | Pre-existing on main |
| `src/lib/mcp/controlEndpoint.test.ts` | 15 pass / 0 fail | 15 pass / 0 fail | Candidate passed |
| `src/lib/mcp/controlPlaneReads.test.ts` | 25 pass / 0 fail | 25 pass / 0 fail | Candidate passed |
| `src/lib/mcp/conversationAction.integration.test.ts` | 7 pass / 0 fail | 7 pass / 0 fail | Candidate passed |
| `src/lib/mcp/conversationMigration.integration.test.ts` | 13 pass / 2 fail | 13 pass / 2 fail | Pre-existing on main |
| `src/lib/mcp/crossProject.test.ts` | 8 pass / 1 fail | 8 pass / 1 fail | Pre-existing on main |
| `src/lib/mcp/curateRules.test.ts` | 3 pass / 0 fail | 3 pass / 0 fail | Candidate passed |
| `src/lib/mcp/deployAuthority.test.ts` | 11 pass / 1 fail | 11 pass / 1 fail | Pre-existing on main |
| `src/lib/mcp/deploymentListPages.test.ts` | 12 pass / 1 fail | 12 pass / 1 fail | Pre-existing on main |
| `src/lib/mcp/deploymentReads.test.ts` | 23 pass / 0 fail | 23 pass / 0 fail | Candidate passed |
| `src/lib/mcp/deputyAttribution.test.ts` | 8 pass / 1 fail | 8 pass / 1 fail | Pre-existing on main |
| `src/lib/mcp/dismissAttention.test.ts` | 25 pass / 2 fail | 25 pass / 2 fail | Pre-existing on main |
| `src/lib/mcp/healthProbeAdmission.test.ts` | 1 pass / 0 fail | 1 pass / 0 fail | Candidate passed |
| `src/lib/mcp/http.cancellation.test.ts` | 3 pass / 0 fail | 3 pass / 0 fail | Candidate passed |
| `src/lib/mcp/http.test.ts` | 19 pass / 0 fail | 19 pass / 0 fail | Candidate passed |
| `src/lib/mcp/interruptedCall.test.ts` | 24 pass / 0 fail | 24 pass / 0 fail | Candidate passed |
| `src/lib/mcp/issueReport.test.ts` | 40 pass / 0 fail | 40 pass / 0 fail | Candidate passed |
| `src/lib/mcp/largeReads.test.ts` | 11 pass / 1 fail | 11 pass / 1 fail | Pre-existing on main |
| `src/lib/mcp/leaveLesson.test.ts` | 14 pass / 0 fail | 14 pass / 0 fail | Candidate passed |
| `src/lib/mcp/leaveLessonSeat.test.ts` | 9 pass / 0 fail | 9 pass / 0 fail | Candidate passed |
| `src/lib/mcp/linkedSeatTools.test.ts` | 4 pass / 1 fail | 4 pass / 1 fail | Pre-existing on main |
| `src/lib/mcp/maintainerGuard.integration.test.ts` | 0 pass / 1 fail | 0 pass / 1 fail | Pre-existing on main |
| `src/lib/mcp/managerAuthority.test.ts` | 8 pass / 0 fail | 8 pass / 0 fail | Candidate passed |
| `src/lib/mcp/managerLifecycleSeams.test.ts` | 8 pass / 0 fail | 8 pass / 0 fail | Candidate passed |
| `src/lib/mcp/modelInput.native.test.ts` | 0 pass / 0 fail / 8 skip | 0 pass / 0 fail / 8 skip | Existing opt-in skips |
| `src/lib/mcp/modelInput.test.ts` | 7 pass / 0 fail | 7 pass / 0 fail | Candidate passed |
| `src/lib/mcp/nativeWorkMetadata.test.ts` | 7 pass / 0 fail | 7 pass / 0 fail | Candidate passed |
| `src/lib/mcp/orchestratorSendRecovery.test.ts` | 4 pass / 0 fail | 4 pass / 0 fail | Candidate passed |
| `src/lib/mcp/orchestratorTools.test.ts` | 75 pass / 2 fail | 75 pass / 2 fail | Pre-existing on main |
| `src/lib/mcp/originalKeySendRecovery.test.ts` | 10 pass / 1 fail | 10 pass / 1 fail | Pre-existing on main |
| `src/lib/mcp/ownedFixtureChildren.test.ts` | 2 pass / 0 fail | 1 pass / 1 fail; replay 2 pass / 0 fail | Intermittent fixture; unchanged replay passed |
| `src/lib/mcp/pageCursors.integration.test.ts` | 3 pass / 0 fail | 3 pass / 0 fail | Candidate passed |
| `src/lib/mcp/pageCursors.test.ts` | 28 pass / 0 fail | 28 pass / 0 fail | Candidate passed |
| `src/lib/mcp/pipelineBusyAdmission.test.ts` | 10 pass / 0 fail | 10 pass / 0 fail | Candidate passed |
| `src/lib/mcp/pipelineRoleFence.test.ts` | 5 pass / 1 fail | 5 pass / 1 fail | Pre-existing on main |
| `src/lib/mcp/presentation.test.ts` | 4 pass / 0 fail | 4 pass / 0 fail | Candidate passed |
| `src/lib/mcp/projectResolution.test.ts` | 42 pass / 12 fail | 42 pass / 12 fail | Pre-existing on main |
| `src/lib/mcp/pullRequestReads.test.ts` | 4 pass / 3 fail | 4 pass / 3 fail | Pre-existing on main |
| `src/lib/mcp/readLatency.test.ts` | 2 pass / 0 fail | 2 pass / 0 fail | Candidate passed |
| `src/lib/mcp/relayOwnerHistory.test.ts` | 2 pass / 0 fail | 2 pass / 0 fail | Candidate passed |
| `src/lib/mcp/relayServiceTools.test.ts` | 1 pass / 0 fail | 1 pass / 0 fail | Candidate passed |
| `src/lib/mcp/releaseSettings.test.ts` | 1 pass / 0 fail | 1 pass / 0 fail | Candidate passed |
| `src/lib/mcp/reportTools.test.ts` | 5 pass / 1 fail | 5 pass / 1 fail | Pre-existing on main |
| `src/lib/mcp/requestAttention.immediate.test.ts` | 22 pass / 0 fail | 22 pass / 0 fail | Candidate passed |
| `src/lib/mcp/requestAttention.targets.test.ts` | 5 pass / 0 fail | 5 pass / 0 fail | Candidate passed |
| `src/lib/mcp/requestAttention.test.ts` | 14 pass / 1 fail | 14 pass / 1 fail | Pre-existing on main |
| `src/lib/mcp/retirementStatus.integration.test.ts` | 3 pass / 16 fail | 3 pass / 16 fail | Pre-existing on main |
| `src/lib/mcp/retirementStatus.test.ts` | 5 pass / 0 fail | 5 pass / 0 fail | Candidate passed |
| `src/lib/mcp/retryStageLaunch.integration.test.ts` | 6 pass / 0 fail | 6 pass / 0 fail | Candidate passed |
| `src/lib/mcp/reviewDispatchFailure.test.ts` | 4 pass / 0 fail | 4 pass / 0 fail | Candidate passed |
| `src/lib/mcp/rolePresets.test.ts` | 18 pass / 0 fail | 18 pass / 0 fail | Candidate passed |
| `src/lib/mcp/schemaParity.test.ts` | 36 pass / 1 fail | 36 pass / 1 fail | Pre-existing on main |
| `src/lib/mcp/searchMemory.budget.test.ts` | 5 pass / 0 fail | 5 pass / 0 fail | Candidate passed |
| `src/lib/mcp/searchMemory.test.ts` | 2 pass / 0 fail | 2 pass / 0 fail | Candidate passed |
| `src/lib/mcp/searchTranscripts.test.ts` | 2 pass / 0 fail | 2 pass / 0 fail | Candidate passed |
| `src/lib/mcp/seatAnswerBudgets.test.ts` | 2 pass / 1 fail | 2 pass / 1 fail | Pre-existing on main |
| `src/lib/mcp/selectedContextActions.test.ts` | 15 pass / 0 fail | 15 pass / 0 fail | Candidate passed |
| `src/lib/mcp/server.test.ts` | 100 pass / 0 fail | 100 pass / 0 fail | Candidate passed |
| `src/lib/mcp/shortIds.answers.test.ts` | 7 pass / 0 fail | 7 pass / 0 fail | Candidate passed |
| `src/lib/mcp/spawnAccount.test.ts` | 15 pass / 0 fail | 15 pass / 0 fail | Candidate passed |
| `src/lib/mcp/spawnDeployer.test.ts` | 15 pass / 2 fail | 15 pass / 2 fail | Pre-existing on main |
| `src/lib/mcp/spawnRecovery.integration.test.ts` | 15 pass / 1 fail | 15 pass / 1 fail | Pre-existing on main |
| `src/lib/mcp/stdio.integration.test.ts` | TIMEOUT (300 s) | TIMEOUT (300 s) | Same execution limit; complete coverage below |
| `src/lib/mcp/taskBoardVisibility.integration.test.ts` | 0 pass / 1 fail | 0 pass / 1 fail | Pre-existing on main |
| `src/lib/mcp/taskChannel.test.ts` | 7 pass / 0 fail | 7 pass / 0 fail | Candidate passed |
| `src/lib/mcp/taskColor.integration.test.ts` | 0 pass / 1 fail | 0 pass / 1 fail | Pre-existing on main |
| `src/lib/mcp/taskColorGroupHide.integration.test.ts` | 0 pass / 1 fail | 0 pass / 1 fail | Pre-existing on main |
| `src/lib/mcp/taskDetails.integration.test.ts` | 0 pass / 1 fail | 0 pass / 1 fail | Pre-existing on main |
| `src/lib/mcp/taskExecutor.test.ts` | 29 pass / 0 fail | 29 pass / 0 fail | Candidate passed |
| `src/lib/mcp/taskExecutorLifetime.test.ts` | 4 pass / 0 fail | 4 pass / 0 fail | Candidate passed |
| `src/lib/mcp/taskFinding.integration.test.ts` | 2 pass / 0 fail | 2 pass / 0 fail | Candidate passed |
| `src/lib/mcp/taskIcon.integration.test.ts` | 0 pass / 1 fail | 0 pass / 1 fail | Pre-existing on main |
| `src/lib/mcp/taskLineEdits.integration.test.ts` | 0 pass / 1 fail | 0 pass / 1 fail | Pre-existing on main |
| `src/lib/mcp/taskOwnership.integration.test.ts` | 1 pass / 0 fail | 1 pass / 0 fail | Candidate passed |
| `src/lib/mcp/taskPosition.integration.test.ts` | 0 pass / 1 fail | 0 pass / 1 fail | Pre-existing on main |
| `src/lib/mcp/taskPriority.integration.test.ts` | 0 pass / 1 fail | 0 pass / 1 fail | Pre-existing on main |
| `src/lib/mcp/telegramBot.test.ts` | 23 pass / 0 fail | 23 pass / 0 fail | Candidate passed |
| `src/lib/mcp/toolAllowlist.service.test.ts` | 5 pass / 0 fail | 5 pass / 0 fail | Candidate passed |
| `src/lib/mcp/toolAllowlist.test.ts` | 20 pass / 0 fail | 20 pass / 0 fail | Candidate passed |
| `src/lib/mcp/voiceUtteranceContext.test.ts` | 18 pass / 0 fail | 18 pass / 0 fail | Candidate passed |
| `src/lib/mcp/voiceUtteranceWiring.test.ts` | 8 pass / 0 fail | 8 pass / 0 fail | Candidate passed |
| `src/lib/mcp/workLinks.test.ts` | 2 pass / 0 fail | 2 pass / 0 fail | Candidate passed |
| `src/lib/mcp/workerLimit.test.ts` | 4 pass / 0 fail | 4 pass / 0 fail | Candidate passed |
| `src/lib/mcp/worktreeBackfill.integration.test.ts` | 4 pass / 0 fail | 4 pass / 0 fail | Candidate passed |
| `src/lib/mcp/writerConcurrency.test.ts` | 5 pass / 0 fail / 1 skip | 5 pass / 0 fail / 1 skip | Candidate passed |
| `src/runtime-host/mcpRuntimeProbe.test.ts` | 26 pass / 2 fail | 26 pass / 2 fail | Pre-existing on main |

## Complete stdio coverage and fixture replays

Both full-file stdio runs reached 300 seconds. These disjoint filters completed all 53 named tests on each SDK:

| File / selection | Before | After |
| --- | --- | --- |
| `src/lib/mcp/stdio.integration.test.ts -t "native caller admission"` | 16 pass / 0 fail | 15 pass / 1 fail |
| `src/lib/mcp/stdio.integration.test.ts -t "^(?!.*native caller admission)"` | 25 pass / 12 fail | 25 pass / 12 fail |

The 12 consistent non-native stdio failures reproduce on main, including recovery paths that encounter the existing missing held-delivery registry index. The native subset had one hook-fixture refusal before SDK dispatch; its focused replay passed on both SDKs:

`send_message is attributed to the native caller and caller arguments cannot replace it`: before 1 pass / 0 fail; after 1 pass / 0 fail.

The child-cleanup fixture also failed once after the bump and passed unchanged on replay: before 2 pass / 0 fail; first after 1 pass / 1 fail; after replay 2 pass / 0 fail. Its fixture and helper do not import the SDK. These intermittent observations follow the local gate’s FLAKY classification; no SDK integration fix or test suppression was needed.

The two runtime-host MCP health-policy assertions also fail with unchanged SDK 1.31.0. Production MCP bundles were rebuilt and the complete probe file repeated on both SDKs:

- Before: 26 pass / 2 fail.
- After: 26 pass / 2 fail.

## Remaining bin tests

All remaining bin files were run after the bump. The sole failing file was resampled on unchanged main:

| File | After | Before when required |
| --- | --- | --- |
| `bin/agent-binaries.test.ts` | 7 pass / 0 fail | Not required: candidate passed |
| `bin/bind-guard.test.ts` | 15 pass / 0 fail | Not required: candidate passed |
| `bin/cli.exposure.integration.test.ts` | 21 pass / 0 fail | Not required: candidate passed |
| `bin/cli.selfUpdate.coldRecovery.integration.test.ts` | 36 pass / 0 fail | Not required: candidate passed |
| `bin/cli.selfUpdate.divergedApply.integration.test.ts` | 5 pass / 0 fail | Not required: candidate passed |
| `bin/cli.selfUpdate.integration.test.ts` | 104 pass / 0 fail / 29 skip | Not required: candidate passed |
| `bin/envAlias.test.ts` | 3 pass / 2 fail | 3 pass / 2 fail |
| `bin/forge-app-token.test.ts` | 139 pass / 0 fail | Not required: candidate passed |
| `bin/helper-lease-windows.test.ts` | 6 pass / 0 fail / 1 skip | Not required: candidate passed |
| `bin/install-cpu-placement.test.ts` | 5 pass / 0 fail | Not required: candidate passed |
| `bin/launcher-credentials.test.ts` | 17 pass / 0 fail | Not required: candidate passed |
| `bin/launcher-custody.test.ts` | 6 pass / 0 fail | Not required: candidate passed |
| `bin/launcher-relaunch.custody.test.ts` | 8 pass / 0 fail | Not required: candidate passed |
| `bin/launcher-relaunch.test.ts` | 8 pass / 0 fail | Not required: candidate passed |
| `bin/legacySystemd.test.ts` | 5 pass / 0 fail | Not required: candidate passed |
| `bin/oomPolicy.test.ts` | 4 pass / 0 fail | Not required: candidate passed |
| `bin/self-update-supervisor.test.ts` | 39 pass / 0 fail | Not required: candidate passed |
| `bin/server-runtime.test.ts` | 31 pass / 0 fail | Not required: candidate passed |
| `bin/skillLinks.test.ts` | 3 pass / 0 fail | Not required: candidate passed |
| `bin/telegram-connector-retire.test.ts` | 5 pass / 0 fail | Not required: candidate passed |
| `bin/viewer-helpers-retire.test.ts` | 6 pass / 0 fail | Not required: candidate passed |

## Supporting runtime and SDK-client tests

All eight audit/runtime verdict files passed:

- `scripts/audit-with-retry.test.ts`: 38 pass / 0 fail.
- `scripts/supply-chain-check.test.ts`: 3 pass / 0 fail.
- `scripts/bun-runtime-workflow.test.ts`: 12 pass / 0 fail.
- `scripts/verify-viewer-runtime.test.ts`: 10 pass / 0 fail.
- `src/runtime-host/hostRehearsal.test.ts`: 15 pass / 0 fail.
- `src/runtime-host/hostRehearsalRun.test.ts`: 7 pass / 0 fail.
- `src/runtime-host/journalStartup.test.ts`: 11 pass / 0 fail.
- `src/runtime-host/deploymentProxy.test.ts`: 22 pass / 0 fail.

Additional production SDK HTTP-client consumers were compared on both versions:

| File | Before | After |
| --- | --- | --- |
| `src/lib/telegram/connector.test.ts` | 33 pass / 0 fail | 33 pass / 0 fail |
| `src/lib/telegram/connectorBoot.test.ts` | 4 pass / 0 fail | 4 pass / 0 fail |
| `src/lib/telegram/reportSources.test.ts` | 32 pass / 0 fail | 32 pass / 0 fail |

## Scope and follow-up

Remote main was rechecked at `ac8cce4f`: the two commits since the pinned baseline change UI and unrelated test files, with no SDK/MCP overlap. The fenced local-gate files were not edited.

The fresh baseline audit also reports [GHSA-46jr-4wx8-v453](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-46jr-4wx8-v453), whose registry version floor is also 1.32.0. Its HTTP memory-validation mitigation additionally requires configuring input-element and request-body limits. That configuration is deferred from this dependency bump; a clean version audit does not demonstrate that those opt-in limits are enabled.

Verification record generated 2026-10-20T23:29:48.038068+00:00.
