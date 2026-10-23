# Publication retry and release metadata verification

The first draft came from Codex Cloud.

The original verification baseline is `95d52f4db9803e9a06d835fb5dbe37bbbd4d2b79`. An earlier fetch observed main at `3dffc54e1` with the target files unchanged. Main at `800a26ebc10ca2db855d12a71320f75c5f2fb955` adds memory-limit and producer-repair changes in `src/lib/pipelines/engine.ts`; its publication queue and skipped-stage functions remain byte-for-byte equal to the pinned base. The authorized continuation merged that main cleanly in `00eed2392`, then merged the tests-only main update `a63e8b717` in `ef9416ebd`. The original 100-file matrix below remains evidence against the pinned baseline; continuation checks on the merged tree are recorded separately. Production changes are in `28462191d`; the publication test wrapper budget is in `0cc3f96b6`.

| Issue | Fix and regression coverage | Reverted-fix result |
| --- | --- | --- |
| #2460 | `src/lib/pipelines/engine.ts:11243` requests a fresh settled-publication check for an explicit skip. `src/lib/pipelines/parkedPublication.test.ts:661` covers repaired and unrepaired hooks, a fresh operation ID and another push. Existing dependency-provisioning cases at `src/lib/pipelines/parkedPublication.test.ts:1016` passed. | Both new cases fail with the production fix removed: exit 1. The repaired case stays parked and the unrepaired case reuses the old operation. |
| #2394 | `scripts/release-verify.ts:160` reads the exact version manifest and the dedicated dist-tags endpoint. `scripts/release-verify.test.ts:42` covers fresh, delayed, missing and scoped metadata. Missing metadata retains the 90-minute retry bound. | All four new cases fail with the production fix removed: exit 1. |

The authorized scope is script-only: #2394 stays open. The publish and macOS workflow jobs still use `npm view` and need a separate maintainer-pushed workflow change; the seat owns that board follow-up. No workflow file was changed. The publication report uses `Fixes #2460` and `Refs #2394`.

The publication queue keeps its existing owner, epoch, running-operation and pending-fence checks. Other queue callers retain their existing defaults; explicit publish already rechecks settled work. Release preflight keeps its exact-version read, and release verification still requires workflow success, integrity, latest and matching image metadata. No performance gain is claimed.

All tests retained `bunfig.toml`, `test-preload.ts` and the owned-runner supervisor. Remote runs used private home, configuration, temporary and state directories. Final confirmations used fresh roots for every file and side. Main ran from a disposable Git clone pinned to the baseline with the same origin configuration. A source archive omitted repository metadata and caused unrelated repository-admission refusals; that comparator was stopped and discarded after the completed branch sweep. Its recorded children were verified gone.

The first parked-publication wrapper hit its 120-second child limit. Two complete owned-runner child-mode runs passed on each tree: branch 108/108 tests, main 106/106 tests. The final ordinary wrapper allows 240 seconds for its child and 245 seconds for its own test, within the five-minute file budget. Final ordinary-wrapper results appear in the confirmation table. `LLV_PARKED_PUBLICATION_CHILD=1` selects the existing whole-file body; the ownership preload stays enabled.

The initial complete sweeps ran 98 files per tree; the final inventory audit added two files on each tree. The combined 100-file matrix has 69 branch files passing and 31 failing or timing out, versus 73 passing and 27 failing or timing out on main. It gives every exit code below. In the original sweep, branch 68 passed and 30 failed or timed out; main 72 passed and 26 failed or timed out. Twenty-five of those original suites reproduced identical failing-test-name counters on both trees. `src/lib/pipelines/remoteActions.test.ts` reached the same supervised five-minute deadline on both. The initial main-only provisioning failure and all initial mismatches are retained below. The five branch-only initial outcomes were checked again with fresh paired whole-file runs. Final confirmation outcomes are recorded without assigning a flaky label. All ten fresh paired file runs passed. The CPU-admission file retained its five existing skipped cases on both trees. The extra mocked route consumer reproduced the same single failing test on both trees.

Selection resolved literal static/dynamic imports and the shared `src/lib/pipelines/engine.fixture.ts` bridge. The final audit also covered the constructed subprocess import in `src/lib/runtime/cpuAdmissionScope.test.ts` and the engine mock consumer in `src/app/api/pipelines/[id]/route.test.ts`. The complete explicit file list follows.

Each command below ran inside `gate-remote -- bash scripts/gate-slot.sh ...`. The batch invoked each file with `setsid`, closed stdin, and `LLV_OWNED_RUN_TIMEOUT_MS=300000`; the final confirmation of `src/lib/pipelines/stagePullRequest.test.ts` used 600000 ms so its complete result could be compared after the initial five-minute interruption. The table gives the exact Bun file command and its exit code on each tree.

| Command | Branch exit | Main exit |
| --- | ---: | ---: |
| `bun test --timeout=60000 ./scripts/release-verify.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/app/api/pipelines/[id]/route.lifecycle.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/app/api/pipelines/route.admission.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/app/api/pipelines/route.busy.test.ts` | 1 | 1 |
| `bun test --timeout=60000 ./src/components/BranchPane.spawn.dom.test.tsx` | 1 | 1 |
| `bun test --timeout=60000 ./src/lib/attention/landing.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/delivery.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/flows/retirement.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/forge/autoMergeStore.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/lifecycle/projector.test.ts` | 1 | 1 |
| `bun test --timeout=60000 ./src/lib/mcp/inputLimits.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/mcp/pipelineBusyAdmission.test.ts` | 1 | 1 |
| `bun test --timeout=60000 ./src/lib/mcp/pipelineRoleFence.test.ts` | 1 | 1 |
| `bun test --timeout=60000 ./src/lib/mcp/retryStageLaunch.integration.test.ts` | 1 | 1 |
| `bun test --timeout=60000 ./src/lib/memory/roleLane.test.ts` | 1 | 1 |
| `bun test --timeout=60000 ./src/lib/orchestrator/seatProjectIdentity.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/adoptionHistory.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/autoRefreshStore.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/backgroundTaskSettlement.test.ts` | 1 | 1 |
| `bun test --timeout=60000 ./src/lib/pipelines/controllerLease.reproduction.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/decisionAuthority.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/deputyLineage.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.accountGuard.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.activation.test.ts` | 1 | 1 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.containment.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.controllerPass.test.ts` | 1 | 1 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.controllerSnapshot.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.cpuAdmissionPolling.test.ts` | 1 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.cpuQueue.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.creation.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.fencedMessage.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.pauseMetadata.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.ports.part2.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.ports.part3.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.ports.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.providerBudget.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.providerBudgetChains.part3.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.providerBudgetKinds.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.providerChains.part2.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.providerChains.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.providerReset.part2.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.providerReset.part3.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.providerReset.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.providerSignals.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.provisioning.test.ts` | 0 | 1 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.publication.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.recoveredPending.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.recovery.part2.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.recovery.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.recoveryAdmission.part2.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.recoveryAdmission.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.recoveryAuthority.part2.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.recoveryAuthority.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.rolePrivacy.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.routing.test.ts` | 1 | 1 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.settlement.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.spawnSilence.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.succession.part2.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.succession.part3.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.succession.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.watchdogRegression.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/engineConnectionRefusal.test.ts` | 1 | 1 |
| `bun test --timeout=60000 ./src/lib/pipelines/git.test.ts` | 1 | 1 |
| `bun test --timeout=60000 ./src/lib/pipelines/graphEdits.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/handLaunch.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/legacyReviewConversion.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/materializationHistory.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/parkedPublication.test.ts` | 1 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/publicationRecovery.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/remoteActions.test.ts` | 124 | 124 |
| `bun test --timeout=60000 ./src/lib/pipelines/repositoryInitialization.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/resolveDecision.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/runtimeReads.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/runtimeSwitch.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/severedStageRetry.test.ts` | 1 | 1 |
| `bun test --timeout=60000 ./src/lib/pipelines/severedTurnResume.test.ts` | 1 | 1 |
| `bun test --timeout=60000 ./src/lib/pipelines/spawnRestartRecovery.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/stageAccountBinding.test.ts` | 1 | 1 |
| `bun test --timeout=60000 ./src/lib/pipelines/stageCommitRepair.test.ts` | 1 | 1 |
| `bun test --timeout=60000 ./src/lib/pipelines/stageCompletion.test.ts` | 1 | 1 |
| `bun test --timeout=60000 ./src/lib/pipelines/stageHostGenerationClose.integration.test.ts` | 1 | 1 |
| `bun test --timeout=60000 ./src/lib/pipelines/stageHostLiveness.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/stageHostTeardown.test.ts` | 1 | 1 |
| `bun test --timeout=60000 ./src/lib/pipelines/stagePublicationRepair.test.ts` | 1 | 1 |
| `bun test --timeout=60000 ./src/lib/pipelines/stagePullRequest.test.ts` | 124 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/stageSizing.test.ts` | 1 | 1 |
| `bun test --timeout=60000 ./src/lib/pipelines/stageVerdictRequest.test.ts` | 1 | 1 |
| `bun test --timeout=60000 ./src/lib/pipelines/taskBinding.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/pipelines/terminalReap.test.ts` | 1 | 0 |
| `bun test --timeout=60000 ./src/lib/projects/succession.test.ts` | 1 | 1 |
| `bun test --timeout=60000 ./src/lib/release/stages.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/runtime/codexSubagentDetection.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/runtime/nativeQueueHost.integration.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/runtime/pipelineStageHostAccess.integration.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/runtime/releaseInterruption.test.ts` | 1 | 0 |
| `bun test --timeout=60000 ./src/lib/runtime/structuredDeliveryQueue.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/scanner/taskExtractionRetirement.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/workflows/engine.cpuAdmission.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/lib/runtime/cpuAdmissionScope.test.ts` | 0 | 0 |
| `bun test --timeout=60000 ./src/app/api/pipelines/[id]/route.test.ts` | 1 | 1 |

The final paired whole-file confirmations used the same Bun commands, fresh state for every invocation, and the ordinary publication wrapper.

| Test file | Branch exit | Main exit |
| --- | ---: | ---: |
| `src/lib/pipelines/engine.cpuAdmissionPolling.test.ts` | 0 | 0 |
| `src/lib/pipelines/parkedPublication.test.ts` | 0 | 0 |
| `src/lib/pipelines/stagePullRequest.test.ts` | 0 | 0 |
| `src/lib/pipelines/terminalReap.test.ts` | 0 | 0 |
| `src/lib/runtime/releaseInterruption.test.ts` | 0 | 0 |

| Additional command or observation | Exit / result |
| --- | --- |
| `gh issue view 2460 --comments` and `gh issue view 2394 --comments` | Each 1, classic-Projects API refusal. |
| `gh issue view 2460 --comments --json number,title,body,comments` | 0; body and comments read. |
| `gh issue view 2394 --comments --json number,title,body,comments` | 0; body and comments read. |
| `git apply --check` for each supplied Cloud patch | Each 0. |
| `git apply` for each supplied Cloud patch | Each 0. |
| Preliminary two-file Cloud-draft smoke run through the remote gate | 0; 14 passing outer tests before expanded coverage. |
| Initial inventory launcher with omitted file arguments | 0 with zero files; discarded. |
| Combined branch/archive batch | 143 after intentional cancellation of the invalid main comparator; all 98 completed branch receipts retained. |
| Git-backed main collector, whole-file publication repeats, revert checks and static checks | 0 for the collector; per-file outcomes are in the tables. |
| Fresh paired confirmation collector and final static checks | 0; 10 complete file runs. |
| Final constructed-import and mocked-consumer audit | 0 for the collector; four per-file exits are in the matrix. |
| `env LLV_PARKED_PUBLICATION_CHILD=1 bun test --timeout=60000 ./src/lib/pipelines/parkedPublication.test.ts` — branch rounds 1 and 2 | 0, 0; 108 tests passed in each round. |
| Same whole-file command — main rounds 1 and 2 | 0, 0; 106 tests passed in each round. |
| With production fix reverted: `env LLV_PARKED_PUBLICATION_CHILD=1 bun test --timeout=60000 ./src/lib/pipelines/parkedPublication.test.ts -t "skip-stage retries a settled publication failure"` | 1; 2 failing regression cases. |
| With production fix reverted: `bun test --timeout=60000 ./scripts/release-verify.test.ts -t "release verification ignores a stale packument"` | 1; 4 failing regression cases. |
| `bun node_modules/typescript/bin/tsc --noEmit --incremental false` | 0, 0, 0 across the staged checks, including the final source state. |
| `bun node_modules/eslint/bin/eslint.js scripts/release-verify.ts scripts/release-verify.test.ts src/lib/pipelines/engine.ts src/lib/pipelines/parkedPublication.test.ts` | 0, 0, 0; four unchanged unused-variable warnings in `src/lib/pipelines/engine.ts:3559`. |
| `git diff --check` | 0. |
| Trusted-fingerprint privacy check on all changed source files | 0. |
| Plain hooks-enabled source commit | 0; staged whitespace, privacy and ESLint passed. |
| Plain hooks-enabled publication-wrapper budget commit | 0; staged whitespace, privacy and ESLint passed. |
| `git fetch origin main` and comparison of the six relevant paths — earlier and final observations | 0, 0; final engine changes are described above. The other five target paths are unchanged. |
| Byte comparison of the publication queue and skipped-stage functions against final main | 0; both unchanged. |
| `git merge-tree --write-tree --messages HEAD origin/main` | 0; clean integration tree, with execution coverage scoped to the pinned baseline. |

The reverted production files and copied regression detectors existed only in disposable verification clones. No revert was committed. No external push, deployment, issue comment or workflow edit was made.

## Authorized continuation on merged main

The continuation retained the script-only scope and merged main with hooks enabled. The open overlapping changes were inspected: regression batch B (#3277) adds a dependency-publication case beside the existing cases; host retirement (#3268), setup recipes (#3265), draft delivery (#3263), package installation (#3260), and settlement recovery (#3248) touch other engine paths. None changes this skip-stage call or the release verifier. Their changes were not imported. A renewed literal-import inventory has 100 files, including the new `src/lib/runtime/agentMemorySettings.test.ts`; the constructed subprocess consumer in `src/lib/runtime/cpuAdmissionScope.test.ts` remains covered by the original audit.

Each continuation test and static check runs through `gate-remote` and `bash scripts/gate-slot.sh`, one command at a time. Tests retain the owned-runner preload and receive fresh private HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR directories. CPU-admission waits are separate from execution. The original matrix above describes the original baseline, while this table describes the merged production tree.

| Command | Exit / result |
| --- | --- |
| `gh issue view 2460 --comments --json number,title,body,comments` | 0; requirement reread, no comments. |
| `gh issue view 2394 --comments --json number,title,body,comments` | 0; requirement reread, no comments. |
| `git fetch origin main` | 0; main remained at `800a26ebc`. |
| `git merge --no-ff origin/main -m 'Merge current main for publication and release verification'` | 0; clean merge with hooks enabled. |
| `bun test --timeout=60000 ./scripts/release-verify.test.ts` | 0; 16 passing tests on the merged tree. |
| `bun test --timeout=60000 ./src/lib/pipelines/parkedPublication.test.ts` | 0; ordinary whole-file wrapper passed on the merged tree. |
| `bun test --timeout=60000 ./scripts/release-verify.test.ts` on current main | 0; 12 passing tests. |
| `bun test --timeout=60000 ./src/lib/runtime/agentMemorySettings.test.ts` on the merged branch | 0; 5 passing tests. |
| `bun test --timeout=60000 ./src/lib/pipelines/parkedPublication.test.ts` on current main | 1; the unchanged 120-second child wrapper reported a child failure. The captured output was truncated, so it does not establish a timeout or identify every failing assertion. The branch's 240-second wrapper passed. Fresh whole-file body confirmations are recorded separately. |
| First continuation comparison collector | 1; its final ran-count confirms all six commands completed. Current main's publication wrapper failed; the release detector failed all four cases as expected. The fresh detector confirmations follow. |
| `env LLV_PARKED_PUBLICATION_CHILD=1 bun test --timeout=60000 ./src/lib/pipelines/parkedPublication.test.ts` on the merged branch | 0; all 108 tests passed with the ownership preload and supervisor enabled. |
| Same whole-file body command on current main | 0; all 106 tests passed. |
| `bun test --timeout=60000 ./src/lib/runtime/agentMemorySettings.test.ts` on current main | 0; all 5 tests passed, matching the branch. |
| With the production fix reverted: `env LLV_PARKED_PUBLICATION_CHILD=1 bun test --timeout=60000 ./src/lib/pipelines/parkedPublication.test.ts -t "skip-stage retries a settled publication failure"` | 1; both repaired and unrepaired hook cases failed, with 106 tests filtered out. |
| With the production fix reverted: `bun test --timeout=60000 ./scripts/release-verify.test.ts -t "release verification ignores a stale packument"` | 1; fresh, delayed, missing and scoped cases failed, with 12 tests filtered out. |
| Final continuation confirmation collector | 0; final ran-count 5. Both complete publication bodies, the main memory-settings suite and both expected-failure detectors completed. |
| `bun node_modules/typescript/bin/tsc --noEmit --incremental false` | 0 on the merged tree. |
| `bun node_modules/eslint/bin/eslint.js scripts/release-verify.ts scripts/release-verify.test.ts src/lib/pipelines/engine.ts src/lib/pipelines/parkedPublication.test.ts` | 0; five existing unused-variable warnings at `src/lib/pipelines/engine.ts:3571`, including the memory field added by main. |
| `bun scripts/privacy-publication-gate.ts --require-known-values --check-commits --base origin/main` with the committed fingerprint file | 0; privacy passed. |
| `git diff --check` | 0. |

Current main and the reverted production files were tested in disposable detached Git clones with the same origin and an explicit `origin/main` ref pinned to `800a26ebc`. No revert was committed. The initial main wrapper failure remains an observation with truncated diagnostics; the fresh complete body run establishes that all of main's assertions pass under the ownership supervisor. No flaky classification is assigned.

Main advanced during those checks to `a63e8b717cab60192caf7bb6ad05d1bdc352d481`, adding only tests in the issue-report approval suites and the existing engine-routing consumer. The second merge changed none of the four verified production or regression files: `git diff --quiet 00eed2392 HEAD -- scripts/release-verify.ts scripts/release-verify.test.ts src/lib/pipelines/engine.ts src/lib/pipelines/parkedPublication.test.ts` exited 0. Thus the completed publication, release, memory-settings and revert checks still exercise the final versions of those files. Typecheck and the changed routing consumer are checked after this last merge.

| Latest-main command | Exit / result |
| --- | --- |
| `git merge --no-ff a63e8b717cab60192caf7bb6ad05d1bdc352d481 -m 'Merge current main regression tests for final verification'` | 0; clean merge with hooks enabled. |
| `bun node_modules/typescript/bin/tsc --noEmit --incremental false` | 0 after the last merge. |
| `bun test --timeout=60000 ./src/lib/pipelines/engine.routing.test.ts` on the final branch | 1; 103 pass, 24 skip, 2 fail. |
| Same complete routing-file command on main at `a63e8b717` | 1; 99 pass, 24 skip, 6 fail. |
| Latest-main collector | 1; final ran-count 3. Typecheck passed; its strict equality comparison refused the differing failure sets. Both branch failures also occur on main; no branch-only failing assertion was observed. |
| `bun scripts/privacy-publication-gate.ts --require-known-values --check-commits --base origin/main --paths docs/acceptance/cloud-publication-release-checks.md` with the committed fingerprint file | 0 before the last merge. |
| Same privacy command with `--base a63e8b717cab60192caf7bb6ad05d1bdc352d481` | 0 for the completed report after the last merge. |

The two shared routing failures are `a stage that keeps working after its turn ended keeps its host through the recovery tick and the deferred cursor write` and `a descendant that outlives the runtime's release is still signalled, and the attempt is replaced`. Main additionally fails `never-started <state> launch becomes terminal and permits a fenced retry (#1972)` for path-pending, starting, closed and closed-pending. No failure is unique to the branch. All added routing cases passed on both trees. These whole-file results are retained without a flaky classification or unrelated test changes.

A read-only registry probe also confirmed HTTP 200 and a string `latest` value for both ordinary and encoded scoped package names. Its exact command exited 0:

```sh
python3 - <<'PY'
import json,urllib.request
for name in ['delegatus-cli','@types/node']:
 encoded=urllib.parse.quote(name,safe='')
 url=f'https://registry.npmjs.org/-/package/{encoded}/dist-tags'
 with urllib.request.urlopen(url,timeout=30) as response:
  tags=json.load(response)
  assert response.status==200 and isinstance(tags.get('latest'),str)
  print(f'{name}: HTTP 200; latest tag is a string')
print('registry shape probe: exit 0')
PY
```
