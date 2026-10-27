# Already-fixed regression pins: batch D

First drafts came from Codex Cloud. All eight nonempty cloud diffs applied cleanly with `git apply` on captured main `adce5764927f7e838f20070cd2968128912e861c`. Issue bodies and comments were read with `gh issue view`; overlapping open pull request diffs were inspected. All eight issue reads and all five overlapping pull request diff reads returned exit 0. The final `git fetch origin main` returned exit 0 and confirmed main had not moved. Intake verification date: 2026-10-23. Refresh verification date: 2026-10-26.

| Issue | Kept/dropped | Revert check | Scope / reason |
| --- | --- | --- | --- |
| #2695 | Kept | 0 → 1 | Queued wake is written once when an already-idle seat queue drains. Fixed clock and UUID sequence; focused test file. The historical silence evidence issue stays open. |
| #2516 | Dropped | 0 → 0 | Reverting Host matching to the pre-fix literal comparison leaves this draft green. The existing non-default-port proxy test fails under the same revert. |
| #2459 | Kept | 0 → 1 | Warm constructor skips completed receipt backfill and preserves the producer-key index. |
| #2424 | Kept | 0 → 1 | Privacy gate sees the accepted controller-created commit; refusal stays visible and leaves the head unpublished. |
| #2254 | Dropped | 0 → 0 | Removing the actual severity-only finding guard leaves this draft green. The existing bare-severity test fails under the same revert. |
| #2225 | Dropped | 0 → 0 | Reverting the contender callback to end immediately leaves the extracted helper test green; it never executes that callback. The helper extraction was removed. |
| #2218 | Kept | 0 → 1 | Size/mtime-only catalog updates retain relationship and branch-group identities and topology. |
| #2209 | Dropped | Invalid control | The draft checks finish-flag wrapping, which the issue explicitly says already works. Its assertions also hold for the pre-issue stylesheet at `8399068aa`. It never checks the reported ordinary narrow row or its container rules. |

Each arrow gives the test exit on current code, then with the protected behavior removed. Every temporary source change ran in a disposable clone and was restored byte-for-byte. The earlier #2209 control removed an unrelated, pre-existing finish-flag rule; its failure does not establish coverage of the reported defect. The code diff contains tests and test-fixture changes.

#2695 remains open: this pin exercises admission and explicit queue drains against an idle fake engine host. Scheduler activation, hourly wake cadence, the two historical silence windows, and withheld-wake visibility remain outside its evidence. The journal pin covers the warm-start SQL contract; the dashboard pin covers model reuse. #2209 is dropped without an already-fixed claim for ordinary narrow rows.

Kept references for the pull request body:

- Refs #2695 — already fixed on main, pinned (idle queue-drain path only; evidence issue stays open).
- Refs #2459 — already fixed on main, pinned (warm receipt migration and index retention).
- Refs #2424 — already fixed on main, pinned (accepted-head privacy ordering and refusal).
- Refs #2218 — already fixed on main, pinned (metadata-only model reuse).

## Refresh and paired verification (2026-10-26)

Captured main: `0728b67c411f29e65b446cf6f4fd591a0c0bb819`. The unfinished older merge was preserved as a private snapshot and recreated against this revision. The only conflict was the native-compaction fixture's overlapping timeout repair: main already contains the broader repair, so the resolved file matches main exactly. There were no semantic conflicts. A final fetch confirmed main had not moved.

Before the #2209 review correction below, the refresh diff contained five pin tests, publication-test fixture support, and this report. No workflow changes were authored. Those five files were exactly the hook's touched-test selection. Their identical assertions were run against main using an overlay containing only those test files and their fixture support; production source on main was unchanged. Both sides passed 142 tests, with 10 skips and no failures. The branch typecheck passed. That superseded source snapshot was exported from merged tree `486a8fe5e73edd9298ccd0237a964aa48c0bf177`. The final diff retains four pins.

Every heavy command ran locally under the stage-provided `gate-slot.sh`, sequentially. Each child used `checkEnvironment` then `isolatedEnvironment`, with fresh HOME, XDG_CONFIG_HOME, XDG_CACHE_HOME, XDG_DATA_HOME, TMPDIR, LLV_STATE_DIR and engine roots; the Viewer control URL was a closed loopback port. Tests used `bun run test` (60-second default) and the repository preload. Each file ran under `setsid --wait` with closed stdin. The first batch completed all 26 commands; its only unexpected exits were the two native-launcher selection errors below. The corrected native batch adds two whole-file observations.

The initial native invocation selected the npm launcher. The fixture intentionally restricts PATH to `/usr/bin:/bin`, where its `node` interpreter is absent. The real-Codex case therefore failed before startup on both revisions with `cannot identify executable version with --version`. A minimal reproduction returned 127 for that launcher and 0 for the direct native executable. The final observations use the direct cached Codex 0.162.1 executable and pass both tests on each revision (144 passed and 10 skipped per side when combined with the retained files). This required no product or fixture edit.

The `current` and `revert` draft rows reintroduce dropped drafts only in scratch. The three drafts still pass after removal of the relevant fix. Existing non-default-port Host and bare-severity tests fail under the same respective reverts. The contender helper draft never executes the changed contender callback.

| Context | Command (inside the admitted wrapper) | Exit |
| --- | --- | --- |
| head-tsc | `bun x tsc --noEmit --incremental false` | 0 |
| head-full-2695 | `bun run test src/lib/monitor/seatTickController.idleDelivery.test.ts` | 0 |
| head-full-2459 | `bun run test src/runtime-host/journalStartup.test.ts` | 0 |
| head-full-2424 | `bun run test src/lib/pipelines/engine.settlement.test.ts` | 0 |
| head-full-2218 | `bun run test src/components/projectDashboardDerivation.test.ts` | 0 |
| head-full-2209 | `bun run test src/components/pipelines/pipelineBlockModel.test.ts` | 0 |
| head-native | `NATIVE_CODEX_QUEUE_TEST_BINARY="$CODEX_LAUNCHER" bun run test src/lib/runtime/nativeQueueCompaction.integration.test.ts` | 1 |
| base-full-2695 | `bun run test src/lib/monitor/seatTickController.idleDelivery.test.ts` | 0 |
| base-full-2459 | `bun run test src/runtime-host/journalStartup.test.ts` | 0 |
| base-full-2424 | `bun run test src/lib/pipelines/engine.settlement.test.ts` | 0 |
| base-full-2218 | `bun run test src/components/projectDashboardDerivation.test.ts` | 0 |
| base-full-2209 | `bun run test src/components/pipelines/pipelineBlockModel.test.ts` | 0 |
| base-native | `NATIVE_CODEX_QUEUE_TEST_BINARY="$CODEX_LAUNCHER" bun run test src/lib/runtime/nativeQueueCompaction.integration.test.ts` | 1 |
| revert-2695 | `bun run test src/lib/monitor/seatTickController.idleDelivery.test.ts --test-name-pattern '#2695'` | 1 |
| revert-2459 | `bun run test src/runtime-host/journalStartup.test.ts --test-name-pattern 'warm startup skips'` | 1 |
| revert-2424 | `bun run test src/lib/pipelines/engine.settlement.test.ts --test-name-pattern '#2424'` | 1 |
| revert-2218 | `bun run test src/components/projectDashboardDerivation.test.ts --test-name-pattern '#2218'` | 1 |
| rejected-control-2209 | `bun run test src/components/pipelines/pipelineBlockModel.test.ts --test-name-pattern '#2209'` | 1 (unrelated finish-flag rule removed; invalid issue evidence) |
| draft-current-2516 | `bun run test src/lib/links/self.test.ts --test-name-pattern 'address check accepts the public Host'` | 0 |
| draft-revert-2516 | `bun run test src/lib/links/self.test.ts --test-name-pattern 'address check accepts the public Host'` | 0 |
| existing-revert-2516 | `bun run test src/lib/links/self.test.ts --test-name-pattern 'port of its own'` | 1 |
| draft-current-2254 | `bun run test src/lib/pipelines/verdict.test.ts --test-name-pattern '#2254'` | 0 |
| draft-revert-2254 | `bun run test src/lib/pipelines/verdict.test.ts --test-name-pattern '#2254'` | 0 |
| existing-revert-2254 | `bun run test src/lib/pipelines/verdict.test.ts --test-name-pattern 'a bare severity is not a finding'` | 1 |
| draft-current-2225 | `bun run test src/runtime-host/fixtures/replyAfterProbe.test.ts --test-name-pattern 'an accepted fence-contender connection'` | 0 |
| draft-revert-2225 | `bun run test src/runtime-host/fixtures/replyAfterProbe.test.ts --test-name-pattern 'an accepted fence-contender connection'` | 0 |
| head-native-direct | `NATIVE_CODEX_QUEUE_TEST_BINARY="$CODEX_NATIVE" bun run test src/lib/runtime/nativeQueueCompaction.integration.test.ts` | 0 |
| base-native-direct | `NATIVE_CODEX_QUEUE_TEST_BINARY="$CODEX_NATIVE" bun run test src/lib/runtime/nativeQueueCompaction.integration.test.ts` | 0 |

`CODEX_LAUNCHER` and `CODEX_NATIVE` denote the cached package launcher and direct native executable for Codex 0.162.1. The four retained revert exits of 1 name their added assertions. The rejected #2209 control provides no issue-specific regression evidence. No temporary source mutation remains.

## Intake and administrative commands

All eight cloud diffs were nonempty. These intake results were retained from the first accepted stage:

| Context | Command | Exit |
| --- | --- | --- |
| #2695 intake | `git apply "$PROMOTION/cloud-2695.diff"` | 0 |
| #2516 intake | `git apply "$PROMOTION/cloud-2516.diff"` | 0 |
| #2459 intake | `git apply "$PROMOTION/cloud-2459.diff"` | 0 |
| #2424 intake | `git apply "$PROMOTION/cloud-2424.diff"` | 0 |
| #2254 intake | `git apply "$PROMOTION/cloud-2254.diff"` | 0 |
| #2225 intake | `git apply "$PROMOTION/cloud-2225.diff"` | 0 |
| #2218 intake | `git apply "$PROMOTION/cloud-2218.diff"` | 0 |
| #2209 intake | `git apply "$PROMOTION/cloud-2209.diff"` | 0 |
| #2516 drop | `git apply -R "$PROMOTION/cloud-2516.diff"` | 0 |
| #2254 drop | `git apply -R "$PROMOTION/cloud-2254.diff"` | 0 |
| #2225 drop | `git apply -R "$PROMOTION/cloud-2225.diff"` | 0 |

`PROMOTION` denotes the task-provided private artifact directory. The prior report also recorded all eight issue reads and five overlapping PR diff reads at exit 0.

| Refresh command / check | Exit |
| --- | --- |
| `git fetch origin main` (initial and final) | 0, 0 |
| `git merge --abort` (unfinished older merge, after private snapshot) | 0 |
| `git merge --no-commit --no-ff origin/main` | 1 (one mechanical conflict, resolved to main's native fixture) |
| `bun install --frozen-lockfile --ignore-scripts` (before and after refresh) | 0, 0 |
| `gh issue view <n> --json number,title,body,state` (each of the eight issues) | 0 each |
| `gh pr list --state open --limit 100 --json number,title,headRefName,files` | 0 |
| `gh pr diff 3314`; `gh pr diff 3260` (overlapping fixtures inspected) | 0, 0 |
| Superseded-tree typecheck admission (canceled before execution) | 1 from supervisor; child SIGTERM, no test verdict |
| `git diff --cached --check` | 0 |
| `git diff --exit-code` in the tested branch export after every revert was restored | 0 |

The superseded-tree admission was canceled by its recorded process identity after the merge target changed; its queued wrapper exited and left no test verdict. No push or issue comment was made.

The completion report records the hook verdicts and final ancestor/clean-tree checks.

## Review correction: drop #2209 (2026-10-26)

The issue reports ordinary chain rows on narrow desktop cards and explicitly identifies finish-flag wrapping as existing behavior. The Cloud draft asserts only the finish-flag selector. The pre-issue stylesheet at `8399068aa` already contains both declarations it requires, so deleting that selector is an invalid revert control for this issue.

Removed the eight-line draft from `src/components/pipelines/pipelineBlockModel.test.ts`; the file now matches captured main `0728b67c411f29e65b446cf6f4fd591a0c0bb819` exactly. Four pins remain: #2695, #2459, #2424 and #2218. Four drafts are dropped: #2516, #2254, #2225 and #2209. The drop makes no claim that the ordinary-row defect is fixed.

Fresh verification used a detached clone of starting revision `c7e8acda346f47989412aabf04a59769d57aafd8` with the draft removed. Commands ran sequentially through the stage-provided local `gate-slot.sh`, using `checkEnvironment` then `isolatedEnvironment` for each child, `setsid --wait`, closed stdin and a closed Viewer control URL. The saved draft and pre-issue CSS were restored only for the rejected-draft control, then replaced byte-for-byte by the final files. All tested source and fixture bytes match the assigned checkout; subsequent edits affect this report only.

| Check | Command inside the admitted wrapper | Result |
| --- | --- | --- |
| Rejected draft with CSS from `8399068aa` | `bun run test src/components/pipelines/pipelineBlockModel.test.ts --test-name-pattern '#2209'` | Exit 0, 1 pass: confirms the draft accepts the pre-issue stylesheet. |
| Final model file | `bun run test src/components/pipelines/pipelineBlockModel.test.ts` | Exit 0, 9 pass. |
| Retained #2695 | `bun run test src/lib/monitor/seatTickController.idleDelivery.test.ts` | Exit 0, 1 pass. |
| Retained #2459 | `bun run test src/runtime-host/journalStartup.test.ts` | Exit 0, 12 pass. |
| Retained #2424 | `bun run test src/lib/pipelines/engine.settlement.test.ts` | Exit 0, 102 pass, 10 existing skips. |
| Retained #2218 | `bun run test src/components/projectDashboardDerivation.test.ts` | Exit 0, 17 pass. |
| Types | `bun x tsc --noEmit --incremental false` | Exit 0. |

All seven commands completed with exit 0. The five final test files total 141 passes, 10 existing skips and no failures; the rejected-draft control adds one separate pass. A final fetch confirmed captured main was unchanged and remained an ancestor of the branch. Whitespace checks passed. The commit uses the launch-provided hooks, with their privacy and lint verdicts recorded in the completion report.
