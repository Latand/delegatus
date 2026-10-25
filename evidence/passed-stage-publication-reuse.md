# Passed stage publication reuse

Origin: Codex Cloud result 49, with declared source base `adce5764`. The pinned patch SHA-256 is `fc79887048f44af87bb22a3832e857b4ea5b1247067d171a0d1cd235be452f27`. `sha256sum -c -` returned **0** and `49.diff: OK`. Application and baseline comparison used main commit `97bdb94ea9dfe32dff8a7bf022eeb2f83d8f02b7`.

`src/lib/pipelines/engine.ts:4384` reuses a settled publication for an unchanged accepted head after the delivery-owner and running-publisher checks. `src/lib/pipelines/publicationEvidence.ts:7` requires this lane's owner, the current delivery epoch, matching operation/result SHAs, successful settlement and a published remote result. Moved heads and invalid evidence follow the existing publication path. Explicit rechecks retain their existing behavior. Reuse preserves the prior operation.

The implementation and settlement regression match the pinned patch. Five additional evidence cases cover unavailable remote state, running publication, mismatched result SHA, missing result and missing delivery. Focused branch results: **111 passes, 10 skips, 0 failures**. The new published-head regression against main's original implementation returned **1**, with that assertion failing.

The publisher in `src/lib/pipelines/git.ts` writes the settled result under operation and epoch fences. Delivery assignment/takeover in `src/lib/pipelines/store.ts` and remote adoption in `src/lib/pipelines/engine.ts` replace the operation when ownership or target changes. PR-number updates preserve the target. The helper reads the existing record directly.

Every test used an explicit file path, fresh private `HOME`, `XDG_CONFIG_HOME`, `LLV_STATE_DIR` and `TMPDIR`, and `LLV_VIEWER_CONTROL_URL` on a closed loopback port. Supplemental checks also used private gate-lock directories. Detached exports used the captured main commit, matching refs and origin metadata, and the same dependencies. Source inputs stayed unchanged. Bun was 1.4.0; Node was 22.16.0.

The remote matrix lost SSH transport with exit **255** and its evidence download failed. The retry probe returned **75** after three attempts. Verification continued through the prescribed local fallback and assigned gate-slot wrapper, one heavy invocation at a time.

## Commands

`GATE_SLOT` denotes the assigned gate-slot wrapper. Each file-table cell records `setsid timeout 330 bun run test ./<file>` inside that admitted invocation, with a 300-second owned file budget and the package's 60-second default per-test timeout. The driver completed **217 file executions**. The absent main-side file is NA. The regression probe and supplemental commands are separate observations.

| Command | Exit | Evidence |
|---|---:|---|
| `sha256sum -c -` for the pinned patch | 0 | Digest above matched |
| `git fetch origin main` | 0 | Captured main revision above |
| `git merge --ff-only origin/main` | 0 | Delivery branch advanced before checks |
| `git apply --reverse --check --exclude=src/lib/pipelines/publicationEvidence.test.ts <pinned patch>` | 0 | Exact pinned implementation and settlement test; evidence test has five added cases |
| `GATE_SLOT gate-remote -- <paired runner>` | 255 | Incomplete remote run |
| `gate-remote -- true` | 75 | Runner unreachable after retries |
| `GATE_SLOT <local paired runner>` | 0 | Final count: 217 |
| `bun x tsc --noEmit --incremental false` | 0 | Complete typecheck |
| `bun x eslint src/lib/pipelines/engine.ts src/lib/pipelines/engine.settlement.test.ts src/lib/pipelines/publicationEvidence.ts src/lib/pipelines/publicationEvidence.test.ts` | 0 | Six warnings on unchanged lines |
| `bun scripts/privacy-publication-gate.ts --require-known-values --paths <four source files>` | 0 | Whole-file source privacy passed |
| `git diff --check` | 0 | Whitespace passed |
| `git diff --quiet <captured main> -- .github/workflows` | 0 | No workflow changes |
| `bun run test ./src/lib/pipelines/engine.settlement.test.ts -t 'a read-only pass reuses only exact settled publication evidence: published'` on main with the new test | 1 | Expected regression failure |
| `GATE_SLOT <whole-file confirmations and extended PR helper>` | 0 | Final count: 8 |
| `GATE_SLOT python3 <final whole-file host confirmation>` | 0 | Final count: 2; no unclassified outlier |

## Paired file results

Shared nonzero outcomes are retained. The original host sample had one additional branch assertion. Whole-file repeats established intermittency, and a second assertion that varied during confirmation recovered in the final whole-file check. `remoteActions.test.ts` completed the same ordered 42 outcomes on both revisions before the owned deadline. The PR helper reached different prefixes under the initial five-minute file budget; complete supplemental runs used a fifteen-minute file budget and both passed.

| Test file | Main exit | Branch exit | Comparison |
|---|---:|---:|---|
| `src/app/api/pipelines/[id]/route.lifecycle.test.ts` | 0 | 0 | Both passed. |
| `src/app/api/pipelines/[id]/route.test.ts` | 1 | 1 | Same named failures. |
| `src/app/api/pipelines/route.admission.test.ts` | 0 | 0 | Both passed. |
| `src/app/api/pipelines/route.busy.test.ts` | 1 | 1 | Same named failures. |
| `src/components/BranchPane.spawn.dom.test.tsx` | 1 | 1 | Same named failures. |
| `src/lib/attention/landing.test.ts` | 0 | 0 | Both passed. |
| `src/lib/delivery.test.ts` | 1 | 1 | Same named failures. |
| `src/lib/flows/retirement.test.ts` | 0 | 0 | Both passed. |
| `src/lib/forge/autoMergeStore.test.ts` | 0 | 0 | Both passed. |
| `src/lib/lifecycle/projector.test.ts` | 1 | 1 | Same named failures. |
| `src/lib/mcp/inputLimits.test.ts` | 0 | 0 | Both passed. |
| `src/lib/mcp/pipelineBusyAdmission.test.ts` | 1 | 1 | Same named failures. |
| `src/lib/mcp/pipelineRoleFence.test.ts` | 1 | 1 | Same named failures. |
| `src/lib/mcp/retryStageLaunch.integration.test.ts` | 1 | 1 | Same named failures. |
| `src/lib/memory/roleLane.test.ts` | 1 | 1 | Same named failures. |
| `src/lib/orchestrator/seatProjectIdentity.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/adoptionHistory.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/autoRefreshStore.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/backgroundTaskSettlement.test.ts` | 1 | 1 | Same named failures. |
| `src/lib/pipelines/controllerLease.reproduction.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/decisionAuthority.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/deputyLineage.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.accountGuard.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.activation.test.ts` | 1 | 1 | Same named failures. |
| `src/lib/pipelines/engine.containment.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.controllerPass.test.ts` | 1 | 1 | Same named failures. |
| `src/lib/pipelines/engine.controllerSnapshot.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.cpuAdmissionPolling.test.ts` | 1 | 1 | Same named failures. |
| `src/lib/pipelines/engine.cpuQueue.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.creation.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.fencedMessage.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.pauseMetadata.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.ports.part2.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.ports.part3.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.ports.test.ts` | 1 | 1 | Same named failures. |
| `src/lib/pipelines/engine.providerBudget.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.providerBudgetChains.part2.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.providerBudgetChains.part3.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.providerBudgetChains.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.providerBudgetKinds.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.providerBudgetOutput.part2.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.providerBudgetOutput.part3.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.providerBudgetOutput.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.providerBudgetPoolOutput.part2.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.providerBudgetPoolOutput.part3.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.providerBudgetPoolOutput.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.providerChains.part2.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.providerChains.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.providerReset.part2.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.providerReset.part3.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.providerReset.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.providerSignals.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.provisioning.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.publication.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.recoveredPending.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.recovery.part2.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.recovery.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.recoveryAdmission.part2.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.recoveryAdmission.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.recoveryAuthority.part2.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.recoveryAuthority.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.rolePrivacy.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.routing.test.ts` | 1 | 1 | Same named failures. |
| `src/lib/pipelines/engine.settlement.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.spawnSilence.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.succession.part2.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.succession.part3.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.succession.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engine.watchdogRegression.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/engineConnectionRefusal.test.ts` | 1 | 1 | Same named failures. |
| `src/lib/pipelines/git.test.ts` | 1 | 1 | Same named failures. |
| `src/lib/pipelines/graphEdits.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/handLaunch.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/legacyReviewConversion.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/materializationHistory.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/parkedPublication.test.ts` | 1 | 1 | Same outer and nested failure; repeated diagnostic echoes excluded. |
| `src/lib/pipelines/publicationEvidence.test.ts` | NA | 0 | New file: 13 branch passes. |
| `src/lib/pipelines/publicationRecovery.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/remoteActions.test.ts` | 124 | 124 | Shared owned deadline; 42 ordered outcomes agree. |
| `src/lib/pipelines/repositoryInitialization.test.ts` | 1 | 1 | Same named failures. |
| `src/lib/pipelines/resolveDecision.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/runtimeReads.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/runtimeSwitch.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/severedStageRetry.test.ts` | 1 | 1 | Same named failures. |
| `src/lib/pipelines/severedTurnResume.test.ts` | 1 | 1 | Same named failures. |
| `src/lib/pipelines/spawnRestartRecovery.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/stageAccountBinding.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/stageCommitRepair.test.ts` | 1 | 1 | Same named failures. |
| `src/lib/pipelines/stageCompletion.test.ts` | 1 | 1 | Same named failures. |
| `src/lib/pipelines/stageHostGenerationClose.integration.test.ts` | 1 | 1 | 13 common failures; intermittent assertions checked separately. |
| `src/lib/pipelines/stageHostLiveness.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/stageHostTeardown.test.ts` | 1 | 1 | Same named failures. |
| `src/lib/pipelines/stagePublicationRepair.test.ts` | 1 | 1 | Same named failures. |
| `src/lib/pipelines/stagePullRequest.test.ts` | 124 | 124 | Complete supplemental runs both pass. |
| `src/lib/pipelines/stageSizing.test.ts` | 1 | 1 | Same named failures. |
| `src/lib/pipelines/stageVerdictRequest.test.ts` | 1 | 1 | Same named failures. |
| `src/lib/pipelines/taskBinding.test.ts` | 0 | 0 | Both passed. |
| `src/lib/pipelines/terminalReap.test.ts` | 0 | 0 | Both passed. |
| `src/lib/projects/succession.test.ts` | 1 | 1 | Same named failures. |
| `src/lib/release/stages.test.ts` | 0 | 0 | Both passed. |
| `src/lib/runtime/agentMemorySettings.test.ts` | 0 | 0 | Both passed. |
| `src/lib/runtime/codexSubagentDetection.test.ts` | 0 | 0 | Both passed. |
| `src/lib/runtime/cpuAdmissionScope.test.ts` | 0 | 0 | Both passed. |
| `src/lib/runtime/nativeQueueHost.integration.test.ts` | 0 | 0 | Both passed. |
| `src/lib/runtime/pipelineStageHostAccess.integration.test.ts` | 1 | 1 | Same named failures. |
| `src/lib/runtime/releaseInterruption.test.ts` | 0 | 0 | Both passed. |
| `src/lib/runtime/structuredDeliveryQueue.test.ts` | 0 | 0 | Both passed. |
| `src/lib/scanner/taskExtractionRetirement.test.ts` | 0 | 0 | Both passed. |
| `src/lib/workflows/engine.cpuAdmission.test.ts` | 0 | 0 | Both passed. |

## Supplemental whole-file commands

The host file retained its 300-second owned budget. The PR helper used 900 seconds (`setsid timeout 930 bun run test ./src/lib/pipelines/stagePullRequest.test.ts`). Each observation had fresh private roots and the captured code. Host repeats included the original shared failures.

| Observation | Explicit test file | Exit |
|---|---|---:|
| main-1 | `src/lib/pipelines/stageHostGenerationClose.integration.test.ts` | 1 |
| branch-1 | `src/lib/pipelines/stageHostGenerationClose.integration.test.ts` | 1 |
| main-2 | `src/lib/pipelines/stageHostGenerationClose.integration.test.ts` | 1 |
| branch-2 | `src/lib/pipelines/stageHostGenerationClose.integration.test.ts` | 1 |
| main-3 | `src/lib/pipelines/stageHostGenerationClose.integration.test.ts` | 1 |
| branch-3 | `src/lib/pipelines/stageHostGenerationClose.integration.test.ts` | 1 |
| main | `src/lib/pipelines/stagePullRequest.test.ts` | 0 |
| branch | `src/lib/pipelines/stagePullRequest.test.ts` | 0 |
| final main-1 | `src/lib/pipelines/stageHostGenerationClose.integration.test.ts` | 1 |
| final branch-1 | `src/lib/pipelines/stageHostGenerationClose.integration.test.ts` | 1 |

Intermittent host assertions:

- authority lost after TERM retains every survivor across HTTP closes and startup (#1501)
- incident: a stage host re-hosted by a successor generation is ended by a close from a socketless process (#1501)

Each assertion passed in complete later observations on unchanged source. The authority-loss fixture schedules membership changes in a zero-delay timer before its check at `src/lib/pipelines/stageHostGenerationClose.integration.test.ts:927`. Its pipeline fixture has no pass verdict. These observations are separate from the publication regression.

Complete PR-helper summaries: main {'pass': 98, 'fail': 0}, branch {'pass': 98, 'fail': 0}.

## Tested source inputs

These four source SHA-256 values were recorded before execution and checked against the export and delivery worktree after the matrix. Final commit hooks provide final whitespace, privacy and staged-lint verdicts.

| Repository-relative file | SHA-256 |
|---|---|
| `src/lib/pipelines/engine.ts` | `e3dc431f8280fafd48173c60266f87ef6a837286b1c2d663d330feb4aaa9651a` |
| `src/lib/pipelines/engine.settlement.test.ts` | `4dfb1e17d610851e1fcc0e5ad4265fea3102823aaa61f1b101690659537e47dc` |
| `src/lib/pipelines/publicationEvidence.ts` | `7e76ad30b3356edca067d3f03b246e91a466d44a148cd040a38ab3b192892eed` |
| `src/lib/pipelines/publicationEvidence.test.ts` | `6004e599f9e98f32cb81384db60cd2448488f796cb6ecc11b687b21cbac7a859` |

Upstream recheck: `origin/main` had advanced to `e92a0ddde58e07ec491e64b96b4ca2c722ebab60`. `git diff --exit-code <captured main>..<upstream> -- <four changed code files> src/lib/pipelines/types.ts src/lib/pipelines/store.ts src/lib/pipelines/git.ts` returned **0**. Verification retains the frozen captured-main exports.
