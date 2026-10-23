Refs #2150

Origin: Codex Cloud (GPT-6.1 Sol), result 06. The 10,382-byte input patch matched `06.meta.json` before application: SHA-256 `d7e4ce68f32761990988097546d92a12bd1c41d8258d1ce1518402b61bf14ac8` (hash/size assertion exit 0); `git apply --check` and `git apply` both exited 0.

`src/lib/agent/spawnCommand.ts:1255` retries transport failures under the existing 30-second admission window and keeps the launch and first-message identities. `src/lib/runtime/startup.ts:653` recognizes busy direct conversations checkpointed as dead or unhosted and uses the existing interruption obligations to resume them once.

Fixes on top of the Cloud patch:

- Stop retries when another writer settles the receipt or releases admission ownership; compare the recorded owner identity before each attempt.
- Recheck authorization after backoff and settle a revoked launch; preserve failures already settled by the launcher.
- Correct the Cloud test's continuation assertion to expect the restart notice for its simulated restart cut.
- Add real admission logic over a fake runtime journal/engine, fixed-clock deadline cases, concurrent-writer and authorization cases, completed/interrupted negative cases, and deduplication across two fresh successor processes (`src/lib/agent/spawnCommand.contention.test.ts:602`, `src/lib/runtime/releaseInterruption.test.ts:3203`).

Verification used fake engines, private HOME/XDG_CONFIG_HOME/LLV_STATE_DIR/TMPDIR roots, explicit files, and serial remote execution through `gate-remote --` and `scripts/gate-slot.sh`. Each manifest file started with `setsid`, stdin closed; both manifests finished with `RAN_COUNT=25`. Baseline main was `adce5764927f7e838f20070cd2968128912e861c`. The branch had 10 failing files versus 13 on main; every remaining failed test name and assertion location matched main. No failing assertion was newly introduced. Both broad runs exited 1 with pre-existing failures. The full cut/release file passed 152 tests (one subprocess-only helper skipped), and the supplemental structured-spawn file passed all 142 tests.

| Test command (`bun test --timeout=60000` + file) | Main exit | Branch exit |
|---|---:|---:|
| `src/app/api/spawn/route.binding.test.ts` | 1 | 1 |
| `src/app/api/spawn/route.launcher.test.ts` | 0 | 0 |
| `src/lib/accounts/accountMutation.callers.test.ts` | 1 | 0 |
| `src/lib/agent/registry.servingWriters.test.ts` | 1 | 0 |
| `src/lib/agent/spawnCommand.contention.test.ts` | 1 | 1 |
| `src/lib/agent/spawnCommand.locale.test.ts` | 0 | 0 |
| `src/lib/agent/spawnCommand.telegram.test.ts` | 1 | 1 |
| `src/lib/agent/spawnDeferral.test.ts` | 1 | 1 |
| `src/lib/mcp/orchestratorTools.test.ts` | 1 | 1 |
| `src/lib/mcp/spawnRecovery.integration.test.ts` | 1 | 1 |
| `src/lib/monitor/seatAutoRotation.spawn.test.ts` | 0 | 0 |
| `src/lib/monitor/seatTickController.reporting.test.ts` | 1 | 1 |
| `src/lib/orchestrator/operatorDecisionForms.test.ts` | 0 | 0 |
| `src/lib/orchestrator/seatRecoveryBusy.test.ts` | 1 | 1 |
| `src/lib/pipelines/engine.containment.test.ts` | 0 | 0 |
| `src/lib/runtime/claudeStreamBrokerHost.test.ts` | 0 | 0 |
| `src/lib/runtime/releaseInterruption.test.ts` | 0 | 0 |
| `src/lib/runtime/retirementReaders.test.ts` | 0 | 0 |
| `src/lib/runtime/startup.handoverRetry.test.ts` | 0 | 0 |
| `src/lib/runtime/startup.quarantine.test.ts` | 0 | 0 |
| `src/lib/runtime/startup.test.ts` | 1 | 1 |
| `src/lib/runtime/startupFinalization.integration.test.ts` | 0 | 0 |
| `src/lib/runtime/structuredDeliveryRebind.test.ts` | 1 | 1 |
| `src/lib/runtime/structuredSpawn.integration.test.ts` | 1 | 0 |
| `src/lib/telegram/reportSpawn.test.ts` | 0 | 0 |

Other verification commands and exits:

- `bun test --timeout=60000 --test-name-pattern 'direct spawn|a direct .*cut checkpointed|a direct .*explicitly interrupted|undated .*completion on a .*row|a direct .*continuation remains' src/lib/agent/spawnCommand.contention.test.ts`: final branch exit 0 (10 cases).
- The same filtered command for `src/lib/runtime/releaseInterruption.test.ts`: final branch exit 0 (22 cases, including four successor subprocess boots).
- `bun x tsc --noEmit --incremental false`: final exit 0.
- `bun x eslint src/lib/agent/spawnCommand.ts src/lib/agent/spawnCommand.contention.test.ts src/lib/runtime/startup.ts src/lib/runtime/releaseInterruption.test.ts`: exit 0.
- `git diff --check`: exit 0.
- `bun scripts/privacy-publication-gate.ts --require-known-values --base origin/main --paths` followed by the four code and test files: exit 0 with committed known-value fingerprints.

The initial focused trial exited 1 for each test file and 2 for typecheck; ESLint exited 0. The incorrect Cloud notice assertion and added fixture setup/type errors were fixed before the final green focused run. A first queued local admission was canceled before any test started (exit 241; child SIGTERM), then execution admission was placed on the remote runner.

Main-source controls used the final tests in a throwaway remote export. `git restore --source=adce5764927f7e838f20070cd2968128912e861c -- src/lib/agent/spawnCommand.ts src/lib/runtime/startup.ts` exited 0 there. The same filtered contention command exited 1 (five expected failures), and the same filtered cut/release command exited 1 (six expected failures). The control batch exited 1 with `RAN_COUNT=3`; the final branch versions of both commands exited 0. These controls prove the missing retry and cut-recovery behavior on the baseline.

The final fetch exited 0. Main advanced to `3dffc54e145fcba779e3ec82fdcff53030728da3` for catalog activation; its diff was inspected and none of the four code and test files changed. `git merge-tree --write-tree --name-only origin/main HEAD` exited 0. The verification diff matched the final committed source; `git status --short` and `git diff --check` exited 0 with no changes after the code commit. The workflow-path diff was empty.

`git add` of the four files and plain `git commit -F` with the prepared message exited 0. Hooks were enabled: whitespace, privacy and ESLint passed. The commit message includes `Refs #2150`, the Codex Cloud origin and machine attribution. The post-commit publication privacy check (`--require-known-values --check-commits --base origin/main`) exited 0. The same publication checker on this public report exited 0. Dependency setup (`bun install --frozen-lockfile --ignore-scripts`) exited 0.

Pre-admission payload persistence across an answering Viewer process exit remains follow-up work for #2150; this patch covers bounded admission retry and recovery of recorded busy conversations. No performance gain is claimed. No deployment or live state was used, no workflow was edited, and no push was performed.

This report is retained in `docs/verification/direct-spawn-handover.md`. The report-only commit also ran the repository hooks; `git diff --check` and the publication privacy check on the report exited 0. The stage summary field accepts 2,000 characters, so it links to this complete command/exit record.
