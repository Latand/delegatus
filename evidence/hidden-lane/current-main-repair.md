The hidden-lane publication checks now pass.

Tested source: `835af1127058a87487426f49e0668bae091521c0`. Comparison base: `ce7806df4acef79bbf76221943227e86c59863a9`.
Checked at 2026-11-13T09:21:09.319263+00:00.

A fresh fetch confirmed that the inherited merge already contains current main. `git merge --no-ff origin/main` returned exit 0 and “Already up to date.” The product fix and all test partitions are preserved.

Typecheck passes with zero diagnostics. Focused tests: 189 pass, 2 pre-existing failures, 306 gated browser skips, 2480 assertions. A fresh exact-main run reproduces both failures.

The native pre-push rehearsal returns exit 0: types, changed-file ESLint, touched tests, Linux backend and Linux tests pass. It completed all 80 touched head files and all 18 Linux head files, with zero cleanup refusals and no reused head files. The touched comparator reports 0 new failures, 12 pre-existing failures, 0 removed/skipped and 1 flaky occurrence.

Every heavy command ran through the controller-supplied gate wrapper in scratch with private HOME, XDG directories, LLV_STATE_DIR and TMPDIR. Its wrapper blob matches `scripts/gate-slot.sh` at this source. Focused test processes select one explicit file and run sequentially. The native hook controls its own lanes.

| Tree | Command | Exit | Pass | Fail | Skip | Assertions |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| head | `bunx tsc --noEmit` | 137 | — | — | — | — |
| head | `bun test --timeout=60000 ./src/components/kanban/kanbanBoard.browser.test.tsx` | 0 | 1 | 0 | 306 | 1 |
| head | `bun test --timeout=60000 ./src/lib/mcp/pipelineVisibility.integration.test.ts` | 0 | 5 | 0 | — | 227 |
| head | `bun test --timeout=60000 ./src/lib/pipelines/engine.attemptGitCustody.test.ts` | 0 | 14 | 0 | — | 123 |
| head | `bun test --timeout=60000 ./src/lib/pipelines/engine.mechanicalRecovery.authority.test.ts` | 0 | 9 | 0 | — | 323 |
| head | `bun test --timeout=60000 ./src/lib/pipelines/engine.mechanicalRecovery.launch.test.ts` | 0 | 25 | 0 | — | 217 |
| head | `bun test --timeout=60000 ./src/lib/pipelines/engine.mechanicalRecovery.test.ts` | 0 | 8 | 0 | — | 282 |
| head | `bun test --timeout=60000 ./src/lib/pipelines/engine.ports.part3.test.ts` | 0 | 2 | 0 | — | 521 |
| head | `bun test --timeout=60000 ./src/lib/pipelines/engine.proactive.part2.test.ts` | 1 | 21 | 2 | — | 182 |
| main | `bun test --timeout=60000 ./src/lib/pipelines/engine.proactive.part2.test.ts` | 1 | 50 | 2 | — | 445 |
| head | `bun test --timeout=60000 ./src/lib/pipelines/engine.proactive.pending.test.ts` | 0 | 6 | 0 | — | 48 |
| head | `bun test --timeout=60000 ./src/lib/pipelines/engine.proactive.workerCapacity.test.ts` | 0 | 23 | 0 | — | 215 |
| head | `bun test --timeout=60000 ./src/lib/pipelines/engine.refreshCompletion.test.ts` | 0 | 2 | 0 | — | 14 |
| head | `bun test --timeout=60000 ./src/lib/pipelines/listProjection.test.ts` | 0 | 28 | 0 | — | 90 |
| head | `bun test --timeout=60000 ./src/components/mobile/mobileBoardModel.test.ts` | 0 | 18 | 0 | — | 114 |
| head | `bun test --timeout=60000 ./src/components/kanban/stagesModel.test.ts` | 0 | 22 | 0 | — | 106 |
| head | `bun test --timeout=60000 ./src/lib/pipelines/engine.watchdogRegression.test.ts` | 0 | 5 | 0 | — | 17 |
| head | `bunx tsc --noEmit` | 0 | — | — | — | — |

The first typecheck used an insufficient 4 GiB Node heap and exited 137 with an explicit V8 heap-exhaustion error. Its unsuccessful result is retained above. The retry uses the project-default 11264 MiB heap in the bounded gate service.

The matching focused failures are `unadopted merge custody survives restart: head-changed` and `review-changed` in `src/lib/pipelines/engine.proactive.part2.test.ts`.

Acceptance: `src/lib/mcp/pipelineVisibility.integration.test.ts` passes all five cases with the real SDK client, MCP server, tool service and exported HTTP route on loopback port 0. It covers Hide, Undo, all list views, unchanged closed/draft records, and base/worktree re-parks without rounds. Desktop and mobile model suites pass.

All eight retained en/uk, light/dark browser frames were inspected at native size: the hidden attention count is zero; Undo restores one decision row. No visible account identities or hostnames were found. These frames retain the earlier rendered run; product source has not changed.

Whole-file and commit-message privacy passed with zero findings. The detailed ledger, native step commands, per-file completion counts and baseline notes are in `evidence/hidden-lane/current-main-repair.json`. Raw logs and terminal receipts are retained with the pipeline evidence. Publication and PR creation remain with the pipeline.
