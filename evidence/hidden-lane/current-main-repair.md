The hidden-lane fix is refreshed onto main with a merge commit.

Tested source: `c2d094d1dbce4c12fe47cba3c077fd006571bae2`. Comparison base: `ce7806df4acef79bbf76221943227e86c59863a9`.
Checked at 2026-11-13T08:16:14.681699+00:00.

Typecheck: exit 0, zero diagnostics. Focused head total: 190 pass, 2 pre-existing failures, 306 gated skips. The two failures match a fresh exact-main run. The enabled browser case passes separately in en/uk and light/dark; all eight frames were inspected at native size.

Publication rehearsal: exit 1; blocked by the 15-minute comparator limit (67/80 head files complete) and runner cleanup refusals. Linux backend and Linux tests were stopped without judgment. Whole-file privacy: exit 0, zero findings. No push was performed.

Every command below ran through the controller-supplied gate wrapper in a scratch export, with fresh HOME, XDG directories, LLV_STATE_DIR and TMPDIR. Test commands select one explicit file.

| Tree | Command | Exit | Pass | Fail | Skip | Assertions |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| head | `bunx tsc --noEmit` | 0 | — | — | — | — |
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
| head | `bun test --timeout=60000 ./src/components/kanban/kanbanBoard.browser.test.tsx` | 0 | 1 | 0 | 306 | 1 |
| head | `bun test --timeout=60000 ./src/components/kanban/kanbanBoard.browser.test.tsx --test-name-pattern 'hidden lane visibility'` | 0 | 1 | 0 | — | 12 |

The split retains all 37 test registration bodies and their parameter lists unchanged. The two baseline failures are `unadopted merge custody survives restart: head-changed` and `review-changed` in `src/lib/pipelines/engine.proactive.part2.test.ts`.

Acceptance evidence: `src/lib/mcp/pipelineVisibility.integration.test.ts` uses the real SDK client, MCP server, tool service and exported HTTP route on loopback port 0; it checks compact, normal, status-only and full lists, Hide, Undo, and base/worktree provisioning re-parks without rounds. `src/lib/pipelines/listProjection.test.ts` checks effective dismissal including stale and invalid timestamps. The existing mobile model and desktop stage-model suites also pass.

The detailed command ledger and publication summary are in `evidence/hidden-lane/current-main-repair.json`. Earlier ledgers record their own historical revisions.

The native hook reported types exit 0 (74 s), changed-file ESLint exit 0 (44 s), and touched-tests exit 1. The exact commands for every hook step are retained in the JSON ledger; stopped Linux steps have no exit status or verdict. All 13 survivor identities reported by the direct rehearsal were absent on reconciliation; its failed cleanup verdict remains unadopted.
