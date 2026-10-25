Merge verification for the memory-source Settings row.

The normal merge combines reviewed slice head `f8ce715679f2c72ab2ba5bb37d7f0ff955b43f2a` with main `adce5764927f7e838f20070cd2968128912e861c`. No conflict occurred. `src/lib/memory/roleStore.ts` retains the reviewed slice unchanged. Git automatically combined both parents in `src/components/kanban/issue1695Evidence.fixture.tsx`, `src/components/kanban/kanbanBoard.browser.test.tsx`, `src/lib/i18n/en.ts` and `src/lib/i18n/uk.ts`; no manual resolution was needed. No workflow file changed.

The staged source matched Git’s independently computed merge tree `13d94eabd3decab8edc9fc399dfcb4dd2c0b8240` (exit 0). The verification report is the only addition to that tree. The merge self-review found no lost parent changes or merge defects. Evidence assembled 2026-10-23T16:16:24+00:00.

An initial campaign ran every selected file separately against main `95d52f4db9803e9a06d835fb5dbe37bbbd4d2b79`. Main advanced during verification, so the pending merge was refreshed before the final campaign. The full inventory was then checked against `d9369c628ae97feae1be614783faa0ab94bb55ae`. Main later advanced to `adce5764927f7e838f20070cd2968128912e861c`, changing only `src/lib/forge/autoRefresh.test.ts`. A tree comparison proved every production module and every inventory test unchanged across that refresh (exit 0). The changed test ran on both sides, and typecheck and lint ran again. The table retains every initial file exit code and the complete inventory failure counts.

The inventory conservatively includes direct importers of the slice’s changed TypeScript modules, embedded subprocess imports, and changed test files. It contains 97 branch files and 96 native-main files. The new memory-row DOM file has no native-main counterpart. All test, typecheck and ESLint commands ran serially through the pinned admission wrapper and `gate-remote`, with isolated HOME, XDG configuration, temporary and state roots.

Initial file command: `gate-remote -- bun test --timeout=60000 <file>`.

Final batch command on each side: `gate-remote -- bun test --parallel=1 --isolate --timeout=60000 --reporter=junit --reporter-outfile=merge-checks.xml <the table’s files present on that side>`. One isolated worker ran at a time. The complete native-main retry prefixes the command with `env LLV_OWNED_RUN_TIMEOUT_MS=3600000` because its preload starts its own supervisor.

| Final check | Exit | Observation |
| --- | ---: | --- |
| Branch test batch | 1 | 2481 cases; 46 failures; 347 skipped |
| Native-main test batch | 1 | 2457 cases; 49 failures; 346 skipped |
| Failure comparison by file, class, name and occurrence count | 0 | No failure occurs only on the branch |
| Native-main first batch (incomplete) | 124 | Default 15-minute preload supervisor expired; no result XML was produced |
| Timed-out worker reconciliation | 0 | The recorded worker was gone before retry |
| `gate-remote -- bunx tsc --noEmit --incremental false` | 0 | Refreshed source |
| `gate-remote -- bun scripts/eslint-changes.ts --base adce5764927f7e838f20070cd2968128912e861c <selected source files>` | 0 | 111 touched source files; no introduced errors, 11 existing errors on main |
| `gate-remote -- bun test --timeout=60000 src/lib/forge/autoRefresh.test.ts` on branch | 0 | Final test-only refresh |
| The same auto-refresh test on native main | 0 | Final test-only refresh |
| Inventory-phase typecheck | 0 | Main snapshot d9369c62 |
| Inventory-phase ESLint comparison | 0 | 110 source files, 11 existing errors |
| Initial typecheck | 0 | Earlier pending merge |
| Initial ESLint comparison | 0 | Earlier pending merge; 92 source files |
| `bun run privacy:check` | 0 | Initial source and committed history |
| `git diff --cached --check` | 0 | All three pending merges |
| `git merge-tree --write-tree HEAD MERGE_HEAD` and staged-tree comparison | 0 | All three pending merges matched |
| Preliminary isolated `src/lib/memory/roleView.test.ts` run | 0 | 16 tests |

The test batches remain red on shared failures. Initial delivery and restart-recovery runs encountered changing memory-admission refusals on both sides; the complete branch and native-main runs have no failures in either file. Earlier resource-limited observations and the incomplete attempt are retained separately. Browser cases keep their normal opt-in flags unset, so these runs provide no new rendered verification.

| Test file | Initial branch exit | Initial main exit | Final branch failures | Final main failures |
| --- | ---: | ---: | ---: | ---: |
| `landing/site/copy.test.ts` | 0 | 0 | 0 | 0 |
| `scripts/memory-selection.test.ts` | 0 | 0 | 0 | 0 |
| `src/app/api/accounts/codex/route.test.ts` | 0 | 0 | 0 | 0 |
| `src/app/api/conversation-host/route.test.ts` | 0 | 0 | 0 | 0 |
| `src/app/api/memory/source/route.test.ts` | 0 | 0 | 0 | 0 |
| `src/app/api/role-memory/curation.test.ts` | 1 | 1 | 1 | 1 |
| `src/app/api/role-memory/route.test.ts` | 0 | 0 | 0 | 0 |
| `src/app/api/routeExports.test.ts` | 0 | 0 | 0 | 0 |
| `src/app/api/runtime/snapshot/route.test.ts` | 0 | 0 | 0 | 0 |
| `src/app/api/search/memory/route.test.ts` | 0 | 0 | 0 | 0 |
| `src/app/api/spawn/route.test.ts` | 1 | 1 | 23 | 24 |
| `src/components/BoardSearchEntry.dom.test.tsx` | 0 | 0 | 0 | 0 |
| `src/components/BootShell.dom.test.tsx` | 0 | 0 | 0 | 0 |
| `src/components/OverviewBoard.catalog.render.test.tsx` | 0 | 0 | 0 | 0 |
| `src/components/OverviewBoard.firstRun.dom.test.tsx` | 0 | 0 | 0 | 0 |
| `src/components/OverviewBoard.kanban.dom.test.tsx` | 1 | 1 | 1 | 1 |
| `src/components/OverviewBoard.loading.dom.test.tsx` | 0 | 0 | 0 | 0 |
| `src/components/OverviewBoard.render.test.tsx` | 0 | 0 | 0 | 0 |
| `src/components/ProjectDashboard.catalogFailure.dom.test.tsx` | 0 | 0 | 0 | 0 |
| `src/components/ProjectDashboard.empty.dom.test.tsx` | 0 | 0 | 0 | 0 |
| `src/components/ProjectDashboard.headerBar.dom.test.tsx` | 0 | 0 | 0 | 0 |
| `src/components/ProjectDashboard.loadingStates.dom.test.tsx` | 0 | 0 | 0 | 0 |
| `src/components/ProjectRail.firstRun.dom.test.tsx` | 0 | 0 | 0 | 0 |
| `src/components/TaskHeader.killConfirm.dom.test.tsx` | 0 | 0 | 0 | 0 |
| `src/components/Viewer.catalogFailure.dom.test.tsx` | 0 | 0 | 0 | 0 |
| `src/components/Viewer.deepLink.dom.test.tsx` | 0 | 0 | 0 | 0 |
| `src/components/Viewer.switching.dom.test.tsx` | 1 | 1 | 2 | 2 |
| `src/components/attention/PermissionActions.dom.test.tsx` | 0 | 0 | 0 | 0 |
| `src/components/feed/FeedItem.mobile.dom.test.tsx` | 0 | 0 | 0 | 0 |
| `src/components/feed/QuestionCard.delivery.dom.test.tsx` | 0 | 0 | 0 | 0 |
| `src/components/feed/QuestionCard.dismiss.dom.test.tsx` | 0 | 0 | 0 | 0 |
| `src/components/feed/QuestionCard.mobile.dom.test.tsx` | 0 | 0 | 0 | 0 |
| `src/components/feed/processingError.test.ts` | 0 | 0 | 0 | 0 |
| `src/components/feed/tools.test.ts` | 0 | 0 | 0 | 0 |
| `src/components/headerMenu/HeaderMenu.dom.test.tsx` | 0 | 0 | 0 | 0 |
| `src/components/headerMenu/headerMenuModel.test.ts` | 0 | 0 | 0 | 0 |
| `src/components/kanban/kanbanBoard.browser.test.tsx` | 0 | 0 | 0 | 0 |
| `src/components/memory/MemorySourceRow.dom.test.tsx` | 0 | absent | 0 | absent |
| `src/components/mobile/issue1671Evidence.browser.test.tsx` | 0 | 0 | 0 | 0 |
| `src/components/resources/AttachControls.render.test.tsx` | 0 | 0 | 0 | 0 |
| `src/components/roleMemory/LearnedRules.render.test.tsx` | 1 | 1 | 1 | 1 |
| `src/components/runtime/AttentionCard.dismiss.dom.test.tsx` | 0 | 0 | 0 | 0 |
| `src/components/runtime/ConversationAttention.dom.test.tsx` | 0 | 0 | 0 | 0 |
| `src/components/skeletons.dom.test.tsx` | 0 | 0 | 0 | 0 |
| `src/hooks/serverReach.dom.test.tsx` | 0 | 0 | 0 | 0 |
| `src/lib/accounts/migration/provider.test.ts` | 0 | 0 | 0 | 0 |
| `src/lib/agent/spawnCommand.contention.test.ts` | 1 | 1 | 3 | 3 |
| `src/lib/i18n/i18n.test.ts` | 0 | 0 | 0 | 0 |
| `src/lib/i18n/spawnCopy.test.ts` | 0 | 0 | 0 | 0 |
| `src/lib/mcp/curateRules.test.ts` | 0 | 0 | 0 | 0 |
| `src/lib/mcp/leaveLesson.test.ts` | 0 | 0 | 0 | 0 |
| `src/lib/mcp/leaveLessonOperator.test.ts` | 0 | 0 | 0 | 0 |
| `src/lib/mcp/leaveLessonSeat.test.ts` | 0 | 0 | 0 | 0 |
| `src/lib/mcp/linkedSeatTools.test.ts` | 1 | 1 | 1 | 1 |
| `src/lib/mcp/searchMemory.budget.test.ts` | 0 | 0 | 0 | 0 |
| `src/lib/memory/context.test.ts` | 0 | 0 | 0 | 0 |
| `src/lib/memory/curation/curation.test.ts` | 0 | 1 | 0 | 0 |
| `src/lib/memory/curation/curator.eval.test.ts` | 0 | 0 | 0 | 0 |
| `src/lib/memory/curation/import.test.ts` | 0 | 0 | 0 | 0 |
| `src/lib/memory/curation/reviewLessons.test.ts` | 0 | 0 | 0 | 0 |
| `src/lib/memory/curation/seatRules.test.ts` | 0 | 0 | 0 | 0 |
| `src/lib/memory/deliveryLedger.test.ts` | 0 | 0 | 0 | 0 |
| `src/lib/memory/importJob.test.ts` | 0 | 0 | 0 | 0 |
| `src/lib/memory/importLifecycle.test.ts` | 0 | 0 | 0 | 0 |
| `src/lib/memory/importSync.test.ts` | 0 | 0 | 0 | 0 |
| `src/lib/memory/operatorMemory.test.ts` | 0 | 0 | 0 | 0 |
| `src/lib/memory/privacy.test.ts` | 0 | 0 | 0 | 0 |
| `src/lib/memory/roleCuration.test.ts` | 0 | 0 | 0 | 0 |
| `src/lib/memory/roleDelivery.test.ts` | 1 | 1 | 0 | 0 |
| `src/lib/memory/roleEgress.test.ts` | 0 | 0 | 0 | 0 |
| `src/lib/memory/roleEgressUnreadable.test.ts` | 1 | 1 | 1 | 1 |
| `src/lib/memory/roleLane.test.ts` | 1 | 1 | 1 | 1 |
| `src/lib/memory/roleLaunch.test.ts` | 1 | 1 | 1 | 1 |
| `src/lib/memory/roleMatcher.test.ts` | 0 | 0 | 0 | 0 |
| `src/lib/memory/roleProblems.test.ts` | 1 | 1 | 1 | 1 |
| `src/lib/memory/roleReviewLessons.test.ts` | 0 | 0 | 0 | 0 |
| `src/lib/memory/roleSelect.test.ts` | 0 | 0 | 0 | 0 |
| `src/lib/memory/roleSelection.test.ts` | 0 | 0 | 0 | 1 |
| `src/lib/memory/roleSelectionRetention.test.ts` | 0 | 0 | 0 | 0 |
| `src/lib/memory/roleStore.test.ts` | 0 | 0 | 0 | 1 |
| `src/lib/memory/roleView.test.ts` | 0 | 0 | 0 | 0 |
| `src/lib/memory/selection.test.ts` | 0 | 0 | 0 | 0 |
| `src/lib/memory/source.import.test.ts` | 0 | 0 | 0 | 0 |
| `src/lib/memory/source.launch.test.ts` | 0 | 0 | 0 | 0 |
| `src/lib/memory/weeklyMetrics.test.ts` | 0 | 0 | 0 | 0 |
| `src/lib/pipelines/engine.rolePrivacy.test.ts` | 0 | 0 | 0 | 0 |
| `src/lib/pipelines/git.test.ts` | 1 | 1 | 1 | 1 |
| `src/lib/pipelines/spawnRestartRecovery.test.ts` | 1 | 1 | 0 | 0 |
| `src/lib/pipelines/stageInput.test.ts` | 1 | 1 | 5 | 5 |
| `src/lib/runtime/startup.test.ts` | 1 | 1 | 4 | 4 |
| `src/lib/runtime/structuredDeliveryQueue.progress.test.ts` | 0 | 0 | 0 | 0 |
| `src/lib/runtime/structuredDeliveryQueue.test.ts` | 0 | 0 | 0 | 0 |
| `src/lib/runtime/structuredMessageDelivery.sqlite.test.ts` | 0 | 0 | 0 | 0 |
| `src/lib/runtime/structuredSpawn.integration.test.ts` | 0 | 0 | 0 | 0 |
| `src/lib/runtime/structuredSpawn.terminalize.test.ts` | 0 | 0 | 0 | 0 |
| `src/lib/voiceCompanion/liveSession.test.ts` | 0 | 0 | 0 | 0 |
| `src/runtime-host/candidateStateDataset.test.ts` | 0 | 0 | 0 | 0 |

The initial curation-suite observation failed only on main. The final batch observations above govern the merge result.
