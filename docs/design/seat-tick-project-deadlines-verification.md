# Seat tick validation

Baseline: `faf571855a09e79f3ba33e6278e48a51404426fb`. Source: `f0cedd0c95444c6b1f73532e745f5152c56203f6` (tree `7dbc08dfb8d2c82dd1b5b75a9caa2ca1998c8370`). The full batch used `1df5af8e573a54cc4783793ed2fa20559d71a239`; the sole later change is the helper stderr assertion in `src/lib/memory/importLifecycle.test.ts`, confirmed in three whole-file runs per side. Production code and the other 189 test files are unchanged.

The final comparison covers 190 files: all 37 monitor test files, direct test importers and sibling tests of the changed modules, and four tests for the scanner change merged during verification. Each file has a fresh process, HOME, XDG configuration/data/cache, TMPDIR, LLV_STATE_DIR and agent configuration roots. The control URL names a closed loopback port. Three file runners share one admitted remote job; each file has a five-minute execution limit and each test a 60-second limit. Files start with at least 4 GiB available RAM.

Result: **0 introduced failures, 204 matching baseline failures, 15 fixed failures, 0 removed/skipped baseline failures**. Named failures include suite and occurrence counts. Import errors are compared per file. Every manifest entry and JUnit total was reconciled; 8 integration files fail during module initialization on both sides. The new scheduling file is absent on the baseline.

Typecheck (`bunx tsc --noEmit --incremental false`) exited 0. ESLint on all 16 changed TypeScript files exited 0 (17 warnings). The scheduling file passed its blocked-preparation, deferred-credit and real-process recovery cases. Both handed publication regressions passed.

The source gate forwards current ports across awaits. A proposal reads the replacement monitor note after issue lookup; settlement sees a seat replacement made during delivery. Deferred memory preparation retains the cold-read gate and durable problem credit.

A helper assertion initially rejected a valid successful SQLite wait diagnostic on stderr. It now validates those diagnostics while preserving exit, payload and durable-state assertions; unknown diagnostics still fail. Its entire file passed three times after the test-only change. One refresh attempt ended with a supervisor watchdog notification failure before any check verdict; the admitted retry completed the batch.

## Reproduction

The remote batch shipped the exact source tree and used a detached clone of the named baseline with the same dependencies. Run each table entry with the following file-selection and supervisor arguments, using fresh isolated roots for every file on each side:

```sh
gate-remote -- env LLV_OWNED_RUN_TIMEOUT_MS=3600000 \
  bash scripts/gate-slot.sh env LLV_OWNED_RUN_TIMEOUT_MS=300000 \
  bun scripts/owned-runner.ts --budget 305000 bun scripts/owned-runner.ts \
  bun test "./$TEST_FILE" --timeout=60000 \
  --reporter=junit --reporter-outfile="$REPORT_FILE"
```

The checkout gate-slot wrapper is byte-identical to the supplied release wrapper. [Structured results](../../evidence/seat-tick-project-deadlines.json) retain every final failure identity, per-file totals, exits and the earlier whole-file samples.

## Earlier whole-file repeats

Before the scanner merge, the 186-file comparison was repeated for agenda, policy, spawn integration and alias state. Spawn samples hit the production 2 GiB RAM admission floor; a later sample passed on both sides. The alias-state assertion also reproduced on main when a valid lock-timing diagnostic reached stderr. Two policy samples had six extra recovery failures; a measured follow-up returned to six matching baseline failures with 16–22 GiB available RAM. Those assertions did not retain their exact refusal reason.

| File | Side | Round | Exit | Failing assertions |
| --- | --- | ---: | ---: | ---: |
| `src/lib/monitor/seatTickController.agenda.test.ts` | main | 2 | 1 | 14 |
| `src/lib/monitor/seatTickController.policy.test.ts` | main | 2 | 1 | 6 |
| `src/lib/runtime/structuredSpawn.integration.test.ts` | main | 2 | 1 | 40 |
| `src/lib/state/slice6.test.ts` | main | 2 | 1 | 1 |
| `src/lib/monitor/seatTickController.agenda.test.ts` | main | 3 | 1 | 14 |
| `src/lib/monitor/seatTickController.policy.test.ts` | main | 3 | 1 | 6 |
| `src/lib/runtime/structuredSpawn.integration.test.ts` | main | 3 | 0 | 0 |
| `src/lib/state/slice6.test.ts` | main | 3 | 0 | 0 |
| `src/lib/monitor/seatTickController.agenda.test.ts` | head | 2 | 1 | 8 |
| `src/lib/monitor/seatTickController.policy.test.ts` | head | 2 | 1 | 12 |
| `src/lib/runtime/structuredSpawn.integration.test.ts` | head | 2 | 1 | 57 |
| `src/lib/state/slice6.test.ts` | head | 2 | 0 | 0 |
| `src/lib/monitor/seatTickController.agenda.test.ts` | head | 3 | 1 | 8 |
| `src/lib/monitor/seatTickController.policy.test.ts` | head | 3 | 1 | 12 |
| `src/lib/runtime/structuredSpawn.integration.test.ts` | head | 3 | 0 | 0 |
| `src/lib/state/slice6.test.ts` | head | 3 | 0 | 0 |
| `src/lib/monitor/seatTickController.policy.test.ts` | main | 4 | 1 | 6 |
| `src/lib/monitor/seatTickController.policy.test.ts` | head | 4 | 1 | 6 |

## Final file list

Cells give `exit / failing assertions / import or runner errors`. Exit 1 is retained when its failures also occur on main.

| File | Main | Head |
| --- | --- | --- |
| `src/app/api/monitor/runs/route.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/app/api/monitor/seat-tick/route.test.ts` | 1 / 1 / 0 | 1 / 1 / 0 |
| `src/app/api/monitor/seat-tick/settings/route.test.ts` | 1 / 3 / 0 | 1 / 3 / 0 |
| `src/app/api/orchestrator/seat/seatFailureRead.test.ts` | 1 / 1 / 0 | 1 / 1 / 0 |
| `src/app/api/search/memory/route.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/app/api/tasks/[id]/spawn/route.binding.test.ts` | 1 / 1 / 0 | 1 / 1 / 0 |
| `src/app/api/team/workspaces.routes.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/accounts/accountOverrides.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/accounts/managerProjectBinding.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/accounts/projectBindings.test.ts` | 1 / 1 / 0 | 1 / 1 / 0 |
| `src/lib/accounts/reseatCommandBinding.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/agent/registry.migrationBinding.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/boardMaintenance/run.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/boardMaintenance/wake.test.ts` | 1 / 2 / 0 | 1 / 2 / 0 |
| `src/lib/done/project.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/externalRelay/ownerStop.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/externalRelay/ownerTier.test.ts` | 1 / 1 / 0 | 1 / 1 / 0 |
| `src/lib/externalRelay/progressSteps.runner.test.ts` | 1 / 3 / 0 | 1 / 3 / 0 |
| `src/lib/links/seatMessages.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/links/taskSync.test.ts` | 1 / 2 / 0 | 1 / 2 / 0 |
| `src/lib/mcp/accountProjectBinding.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/mcp/answerSizes.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/mcp/bindings.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/mcp/bridgeReportShape.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/mcp/coldScan.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/mcp/crossProject.test.ts` | 1 / 1 / 0 | 1 / 1 / 0 |
| `src/lib/mcp/deployAuthority.test.ts` | 1 / 1 / 0 | 1 / 1 / 0 |
| `src/lib/mcp/leaveLesson.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/mcp/linkedSeatTools.test.ts` | 1 / 1 / 0 | 1 / 1 / 0 |
| `src/lib/mcp/orchestratorTools.test.ts` | 1 / 2 / 0 | 1 / 2 / 0 |
| `src/lib/mcp/projectResolution.test.ts` | 1 / 12 / 0 | 1 / 12 / 0 |
| `src/lib/mcp/reportTools.test.ts` | 1 / 1 / 0 | 1 / 1 / 0 |
| `src/lib/mcp/shortIds.answers.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/mcp/spawnRecovery.integration.test.ts` | 1 / 1 / 0 | 1 / 1 / 0 |
| `src/lib/mcp/taskBoardVisibility.integration.test.ts` | 1 / 0 / 1 | 1 / 0 / 1 |
| `src/lib/mcp/taskColor.integration.test.ts` | 1 / 0 / 1 | 1 / 0 / 1 |
| `src/lib/mcp/taskColorGroupHide.integration.test.ts` | 1 / 0 / 1 | 1 / 0 / 1 |
| `src/lib/mcp/taskDetails.integration.test.ts` | 1 / 0 / 1 | 1 / 0 / 1 |
| `src/lib/mcp/taskFinding.integration.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/mcp/taskIcon.integration.test.ts` | 1 / 0 / 1 | 1 / 0 / 1 |
| `src/lib/mcp/taskLineEdits.integration.test.ts` | 1 / 0 / 1 | 1 / 0 / 1 |
| `src/lib/mcp/taskOwnership.integration.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/mcp/taskPosition.integration.test.ts` | 1 / 0 / 1 | 1 / 0 / 1 |
| `src/lib/mcp/taskPriority.integration.test.ts` | 1 / 0 / 1 | 1 / 0 / 1 |
| `src/lib/mcp/workLinks.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/cleanLaunch.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/context.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/controller.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/curation/curation.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/curation/curator.eval.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/curation/reviewLessons.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/curation/seatRules.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/deliveryEvidence.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/deliveryLedger.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/hook.credentials.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/hook.migration.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/hook.native.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/hook.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/importJob.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/importLifecycle.test.ts` | 1 / 1 / 0 | 0 / 0 / 0 |
| `src/lib/memory/importService.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/importSync.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/importWriter.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/index.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/injection.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/native.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/offers.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/operatorMemory.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/privacy.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/profile.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/profileModel.headless.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/profileModel.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/profileService.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/profileStore.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/refreshJob.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/roleCuration.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/roleDelivery.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/roleEgress.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/roleEgressUnreadable.test.ts` | 1 / 1 / 0 | 1 / 1 / 0 |
| `src/lib/memory/roleLane.test.ts` | 1 / 1 / 0 | 1 / 1 / 0 |
| `src/lib/memory/roleLaunch.test.ts` | 1 / 1 / 0 | 1 / 1 / 0 |
| `src/lib/memory/roleMatcher.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/roleProblems.test.ts` | 1 / 1 / 0 | 1 / 1 / 0 |
| `src/lib/memory/roleReviewLessons.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/roleSeatLaunch.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/roleSeatRender.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/roleSelect.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/roleSelection.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/roleSelectionRetention.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/roleStore.test.ts` | 1 / 1 / 0 | 0 / 0 / 0 |
| `src/lib/memory/roleView.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/ruleIds.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/selection.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/service.test.ts` | 1 / 1 / 0 | 1 / 1 / 0 |
| `src/lib/memory/source.import.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/source.launch.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/source.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/sources.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/view.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/memory/weeklyMetrics.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/monitor/autonomy.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/monitor/cards.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/monitor/childFinalMessage.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/monitor/classify.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/monitor/evidence.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/monitor/githubEvidence.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/monitor/journalStore.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/monitor/redact.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/monitor/report.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/monitor/requests.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/monitor/ruleReports.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/monitor/seatAuthIncident.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/monitor/seatAutoRotation.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/monitor/seatHostRecovery.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/monitor/seatMcpHealth.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/monitor/seatTick.activity.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/monitor/seatTick.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/monitor/seatTickAccounting.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/monitor/seatTickChildLedger.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/monitor/seatTickController.agenda.test.ts` | 1 / 14 / 0 | 1 / 8 / 0 |
| `src/lib/monitor/seatTickController.catchUp.test.ts` | 1 / 1 / 0 | 1 / 1 / 0 |
| `src/lib/monitor/seatTickController.delivery.test.ts` | 1 / 23 / 0 | 1 / 22 / 0 |
| `src/lib/monitor/seatTickController.policy.test.ts` | 1 / 6 / 0 | 1 / 6 / 0 |
| `src/lib/monitor/seatTickController.reporting.test.ts` | 1 / 31 / 0 | 1 / 28 / 0 |
| `src/lib/monitor/seatTickController.scheduling.test.ts` | absent | 0 / 0 / 0 |
| `src/lib/monitor/seatTickController.test.ts` | 1 / 63 / 0 | 1 / 63 / 0 |
| `src/lib/monitor/seatTickFence.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/monitor/seatTickRefusal.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/monitor/seatTickReports.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/monitor/seatTickSettings.sqlite.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/monitor/seatTickSettings.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/monitor/seatTickSources.test.ts` | 1 / 2 / 0 | 1 / 2 / 0 |
| `src/lib/monitor/seatTickState.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/monitor/turbo.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/monitor/turboRuntime.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/monitor/turboSweep.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/monitor/workerLimitWake.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/onboarding/healthCheck.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/operator/workerLimit.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/orchestrator/deputySeatBusy.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/orchestrator/ownerRelay.test.ts` | 1 / 3 / 0 | 1 / 3 / 0 |
| `src/lib/orchestrator/relay.test.ts` | 1 / 1 / 0 | 1 / 1 / 0 |
| `src/lib/orchestrator/rotationAccountChoice.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/orchestrator/rotationSettlement.test.ts` | 1 / 10 / 0 | 1 / 10 / 0 |
| `src/lib/orchestrator/seatProjectIdentity.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/orchestrator/seats.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/pipelines/coldScan.test.ts` | 1 / 3 / 0 | 1 / 3 / 0 |
| `src/lib/pipelines/decisionAuthority.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/pipelines/repositoryInitialization.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/pipelines/store.reads.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/pipelines/taskBinding.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/projects/aliases.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/projects/clientAliases.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/projects/curation.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/projects/directorySuggestions.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/projects/durableMigration.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/projects/forgeRename.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/projects/identity.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/projects/reportDestination.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/projects/shortIds.test.ts` | 1 / 1 / 0 | 1 / 1 / 0 |
| `src/lib/projects/succession.test.ts` | 1 / 2 / 0 | 1 / 2 / 0 |
| `src/lib/projects/suggestionRoots.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/projects/worktreeBackfill.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/projects/worktreeRecovery.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/prototypeReview/answerDelivery.integration.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/prototypeReview/answerDelivery.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/reconfigureBinding.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/release/run.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/release/wake.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/runtime/codexSubagentDetection.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/runtime/structuredMessageDelivery.placement.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/runtime/structuredMessageDelivery.sqlite.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/runtime/structuredSpawn.integration.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/runtime/structuredSpawn.terminalize.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/scanner/describe.test.ts` | 1 / 1 / 0 | 0 / 0 / 0 |
| `src/lib/scanner/fileScanWorker.lock.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/scanner/fileScanWorker.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/scanner/scanCache.failure.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/search/projectScope.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/search/transcriptSearch.test.ts` | 1 / 2 / 0 | 1 / 2 / 0 |
| `src/lib/session/titleProjection.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/state/historyProjection.test.ts` | 1 / 3 / 0 | 1 / 3 / 0 |
| `src/lib/state/slice6.test.ts` | 1 / 1 / 0 | 0 / 0 / 0 |
| `src/lib/tasks/finding.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/tasks/proactive.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/team/workspaces.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/view/presenceStore.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/voiceCompanion/admission.test.ts` | 0 / 0 / 0 | 0 / 0 / 0 |
| `src/lib/voiceCompanion/liveSession.test.ts` | 1 / 1 / 0 | 0 / 0 / 0 |
| `src/lib/voiceCompanion/readPaths.test.ts` | 1 / 2 / 0 | 1 / 2 / 0 |

## Changed files

- `docs/design/seat-tick-project-deadlines-verification.md`
- `docs/design/seat-tick-project-deadlines.md`
- `evidence/seat-tick-project-deadlines.json`
- `src/lib/memory/importLifecycle.test.ts`
- `src/lib/memory/roleProblems.ts`
- `src/lib/monitor/seatTick.ts`
- `src/lib/monitor/seatTickAdmissionSources.ts`
- `src/lib/monitor/seatTickController.agenda.test.ts`
- `src/lib/monitor/seatTickController.fixture.ts`
- `src/lib/monitor/seatTickController.policy.test.ts`
- `src/lib/monitor/seatTickController.scheduling.test.ts`
- `src/lib/monitor/seatTickController.ts`
- `src/lib/monitor/seatTickSources.test.ts`
- `src/lib/monitor/seatTickSources.ts`
- `src/lib/monitor/seatTickState.test.ts`
- `src/lib/monitor/seatTickState.ts`
- `src/lib/monitor/seatTickWork.ts`
- `src/lib/monitor/types.ts`
- `src/lib/projects/aliases.ts`
