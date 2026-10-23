# Already-fixed regression pins: batch D

First drafts came from Codex Cloud. All eight nonempty cloud diffs applied cleanly with `git apply` on captured main `adce5764927f7e838f20070cd2968128912e861c`. Issue bodies and comments were read with `gh issue view`; overlapping open pull request diffs were inspected. All eight issue reads and all five overlapping pull request diff reads returned exit 0. The final `git fetch origin main` returned exit 0 and confirmed main had not moved. Verification date: 2026-10-23.

| Issue | Kept/dropped | Revert check | Scope / reason |
| --- | --- | --- | --- |
| #2695 | Kept | 0 → 1 | Queued wake is written once when an already-idle seat queue drains. Fixed clock and UUID sequence; focused test file. The historical silence evidence issue stays open. |
| #2516 | Dropped | 0 → 0 | Reverting Host matching to the pre-fix literal comparison leaves this draft green. The existing non-default-port proxy test fails under the same revert. |
| #2459 | Kept | 0 → 1 | Warm constructor skips completed receipt backfill and preserves the producer-key index. |
| #2424 | Kept | 0 → 1 | Privacy gate sees the accepted controller-created commit; refusal stays visible and leaves the head unpublished. |
| #2254 | Dropped | 0 → 0 | Removing the actual severity-only finding guard leaves this draft green. The existing bare-severity test fails under the same revert. |
| #2225 | Dropped | 0 → 0 | Reverting the contender callback to end immediately leaves the extracted helper test green; it never executes that callback. The helper extraction was removed. |
| #2218 | Kept | 0 → 1 | Size/mtime-only catalog updates retain relationship and branch-group identities and topology. |
| #2209 | Kept | 0 → 1 | Finish-chain CSS retains wrapping and its 4 px row gap. |

Each arrow gives the test exit on current code, then with the protected behavior removed. Every temporary source change ran in a disposable clone and was restored byte-for-byte. The code diff contains tests and test-fixture changes.

#2695 remains open: this pin exercises admission and explicit queue drains against an idle fake engine host. Scheduler activation, hourly wake cadence, the two historical silence windows, and withheld-wake visibility remain outside its evidence. The journal pin covers the warm-start SQL contract; the dashboard pin covers model reuse; the finish-chain pin covers stylesheet declarations.

Kept references for the pull request body:

- Refs #2695 — already fixed on main, pinned (idle queue-drain path only; evidence issue stays open).
- Refs #2459 — already fixed on main, pinned (warm receipt migration and index retention).
- Refs #2424 — already fixed on main, pinned (accepted-head privacy ordering and refusal).
- Refs #2218 — already fixed on main, pinned (metadata-only model reuse).
- Refs #2209 — already fixed on main, pinned (finish-chain wrapping declarations).

## Commands and exit codes

Tests used Bun 1.4.0, the normal repository preload, and the remote runner’s isolated HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR. They ran one command at a time. The local admission queue was saturated, so the canonical runs used the task’s `gate-remote -- bun test` command.

`PROMOTION` below denotes the task-provided private artifact directory.

| Issue | Command | Exit |
| --- | --- | --- |
| #2695 | `git apply "$PROMOTION/cloud-2695.diff"` | 0 |
| #2516 | `git apply "$PROMOTION/cloud-2516.diff"` | 0 |
| #2459 | `git apply "$PROMOTION/cloud-2459.diff"` | 0 |
| #2424 | `git apply "$PROMOTION/cloud-2424.diff"` | 0 |
| #2254 | `git apply "$PROMOTION/cloud-2254.diff"` | 0 |
| #2225 | `git apply "$PROMOTION/cloud-2225.diff"` | 0 |
| #2218 | `git apply "$PROMOTION/cloud-2218.diff"` | 0 |
| #2209 | `git apply "$PROMOTION/cloud-2209.diff"` | 0 |
| #2516 | `git apply -R "$PROMOTION/cloud-2516.diff"` | 0 |
| #2254 | `git apply -R "$PROMOTION/cloud-2254.diff"` | 0 |
| #2225 | `git apply -R "$PROMOTION/cloud-2225.diff"` | 0 |

| Check / context | Command | Exit |
| --- | --- | --- |
| current 2695-focused | `gate-remote -- bun test src/lib/monitor/seatTickController.idleDelivery.test.ts --timeout=60000` | 0 |
| draft 2516 (before removal) | `gate-remote -- bun test src/lib/links/self.test.ts --timeout=60000` | 0 |
| current 2459 | `gate-remote -- bun test src/runtime-host/journalStartup.test.ts --timeout=60000` | 0 |
| current 2424 | `gate-remote -- bun test src/lib/pipelines/engine.settlement.test.ts --timeout=60000` | 0 |
| draft 2254 (before removal) | `gate-remote -- bun test src/lib/pipelines/verdict.test.ts --timeout=60000` | 0 |
| draft 2225 (before removal) | `gate-remote -- bun test src/runtime-host/fixtures/replyAfterProbe.test.ts --timeout=60000` | 0 |
| current 2218 | `gate-remote -- bun test src/components/projectDashboardDerivation.test.ts --timeout=60000` | 0 |
| current 2209 | `gate-remote -- bun test src/components/pipelines/pipelineBlockModel.test.ts --timeout=60000` | 0 |
| revert 2695 (final test) | `gate-remote -- bun test src/lib/monitor/seatTickController.idleDelivery.test.ts --timeout=60000 --test-name-pattern '#2695'` | 1 |
| revert 2516 | `gate-remote -- bun test src/lib/links/self.test.ts --timeout=60000 --test-name-pattern 'address check accepts the public Host'` | 0 |
| revert 2459 | `gate-remote -- bun test src/runtime-host/journalStartup.test.ts --timeout=60000 --test-name-pattern 'warm startup skips'` | 1 |
| revert 2424 | `gate-remote -- bun test src/lib/pipelines/engine.settlement.test.ts --timeout=60000 --test-name-pattern '#2424'` | 1 |
| revert 2254 | `gate-remote -- bun test src/lib/pipelines/verdict.test.ts --timeout=60000 --test-name-pattern '#2254'` | 0 |
| revert 2225 | `gate-remote -- bun test src/runtime-host/fixtures/replyAfterProbe.test.ts --timeout=60000 --test-name-pattern 'an accepted fence-contender connection'` | 0 |
| revert 2218 | `gate-remote -- bun test src/components/projectDashboardDerivation.test.ts --timeout=60000 --test-name-pattern '#2218'` | 1 |
| revert 2209 | `gate-remote -- bun test src/components/pipelines/pipelineBlockModel.test.ts --timeout=60000 --test-name-pattern '#2209'` | 1 |
| revert-2254-existing | `gate-remote -- bun test src/lib/pipelines/verdict.test.ts --timeout=60000 --test-name-pattern 'a bare severity is not a finding'` | 1 |
| revert-2516-existing | `gate-remote -- bun test src/lib/links/self.test.ts --timeout=60000 --test-name-pattern 'port of its own'` | 1 |

Revert procedures: disable idle queue dispatch (#2695); remove the completed-migration return (#2459); remove committed-head acceptance before publication (#2424); restore unconditional relationship-catalog replacement (#2218); remove the finish-chain wrapping rule (#2209). Dropped-draft controls restore literal Host comparison (#2516), remove the severity-only guard (#2254), and restore the contender’s immediate socket end (#2225).

## Base comparison and final checks

The initial full `seatTickController.delivery.test.ts` run returned exit 1: 29 passed and 23 failed. The new idle-delivery pin passed in that run. The file includes registry-index failures and an existing wait timeout. Its pin was moved into `src/lib/monitor/seatTickController.idleDelivery.test.ts`, which passes independently with deterministic clock and identifiers.

The entire legacy file was rerun from a clean disposable checkout of captured main with the same command and isolation. Base: 28 passed, 23 failed, exit 1; the initial candidate: 29 passed, 23 failed, exit 1. Normalized failing test-title sets are identical (23 titles, SHA-256 `80ba52399e7d195b5f4eb04b4dc134934577cf93d58123b3dd632060c914eff8`). The new pin contributes the extra passing case. The legacy file is unchanged in the final code diff.

| Context | Command | Exit |
| --- | --- | --- |
| Initial candidate legacy file | `gate-remote -- bun test src/lib/monitor/seatTickController.delivery.test.ts --timeout=60000` | 1 |
| Clean captured base, complete legacy file | `gate-remote -- bun test src/lib/monitor/seatTickController.delivery.test.ts --timeout=60000` | 1 |

| Final check | Command | Exit |
| --- | --- | --- |
| Typecheck | `gate-remote -- bun x tsc --noEmit --incremental false` | 0 |
| Whitespace | `git diff --cached --check` | 0 |
| Whole touched-file privacy with committed fingerprints | `bun scripts/privacy-publication-gate.ts --require-known-values --base origin/main` | 0 |

Final retained full-file results: 132 passed, 10 skipped, zero failed across five explicit files. Temporary reverts are excluded from that total.

Admission attempts before the canonical runs: the stage-provided gate-slot wrapper around the verdict remote command passed (exit 0); a redundant nested remote gate admission was canceled before tests (exit 143); the local admission for the original seat-delivery file was canceled before tests (SIGTERM, recorded -15). A revert driver stopped before #2254 because its guard selector matched an older spelling (exit 1); the source was re-read and the remaining seven controls completed. Canceled admissions contributed no test verdicts.

The first `git commit --file "$COMMIT_MESSAGE"` returned exit 1 after whitespace and privacy passed: the checkout had no local dependencies, and an ESLint plugin resolved from a package cache could not find its ESLint peer. An owned dependency checkout was prepared with `bun install --frozen-lockfile --ignore-scripts` (exit 0), followed by `node -e 'require("eslint-plugin-react"); require("eslint/package.json"); process.stdout.write("ESLint plugin peer import passed\n")'` (exit 0). A temporary checkout link supplies these dependencies to the unchanged commit hooks.

## Publication repair: native fixture startup deadline

The publication refusal came from `src/lib/runtime/nativeQueueCompaction.integration.test.ts`: its real app-server was given a one-second RPC deadline. The case now uses the production 30-second RPC deadline, with a 60-second whole-test bound. All recovery, queue, registry and no-engine-write assertions remain active.

The entire file was run in fresh isolated roots on accepted head `5dea4d29` and original base `adce5764`. Both passed three ordinary runs. A wrapper delaying only actual app-server startup by two seconds reproduced `initialize timed out` on both revisions in both trials. Version, feature and schema probes forwarded immediately. The same delayed startup passes with the repair. An unresponsive-start control still fails with `initialize timed out` at the production deadline and exits within the whole-test bound.

Every row runs `NATIVE_CODEX_QUEUE_TEST_BINARY="$CODEX_FIXTURE" bun test src/lib/runtime/nativeQueueCompaction.integration.test.ts --timeout=60000` through `gate-remote`, with a fresh supervised test process per observation. `CODEX_FIXTURE` names the pinned executable or its isolated startup-delay wrapper. Loops start each test with `setsid` and closed stdin and finish with an explicit run count.

| Revision / setup | CLI version | Whole-file exit codes |
| --- | --- | --- |
| Accepted head, ordinary startup | 0.162.1 | 0, 0, 0 |
| Original base, ordinary startup | 0.162.1 | 0, 0, 0 |
| Accepted head, two-second delayed startup | 0.162.1 | 1, 1 (expected reproduction) |
| Original base, two-second delayed startup | 0.162.1 | 1, 1 (expected reproduction) |
| Repaired, ordinary startup | 0.154.0 | 0, 0, 0 |
| Repaired, ordinary startup | 0.159.0 | 0, 0, 0 |
| Repaired, ordinary startup | 0.162.1 | 0, 0, 0 |
| Repaired, ordinary startup | 0.163.0 | 0, 0, 0 |
| Repaired, two-second delayed startup | 0.162.1 | 0, 0, 0 |
| Repaired, unresponsive startup | 0.162.1 | 1 (expected timeout control) |
