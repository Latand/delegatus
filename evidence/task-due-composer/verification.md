Slice 3 requires a future date for every new task created through `create_task`. The operator route supplies a date 72 hours ahead, rounded up to the hour. The composer shows that default before submission.

This implements §9 slice 3 of `docs/design/task-due-dates.md` at `9435c6fd607f8884cf897feafdbca78f827630e6`, against base `bf1c00247`.

| Acceptance item | Evidence | Result |
| --- | --- | --- |
| Missing agent date refuses before any task or receipt | `src/lib/mcp/taskFinding.integration.test.ts:118` and `:154`; `src/lib/tasks/taskCreate.test.ts:292`. Tests call the protocol, service, binding and command directly; check unchanged rows and create receipts; count zero receipt claims; reuse the refused key successfully. | Passed |
| A date alone uses the operator zone | The binding test stores `Asia/Tokyo` when only `dueAt` is supplied. Command tests also preserve an explicit zone and refuse invalid dates, invalid zones and past agent dates. | Passed |
| Operator default uses the creation clock | `src/app/api/tasks/route.test.ts:181`: `2026-10-23T10:12:34.567Z` produces `2026-10-26T11:00:00.000Z`; a later fresh request receives a fresh default, while replay retains the first date. Command tests cover an exact hour and daylight-saving transition. | Passed |
| Composer default, picked date and reset | Both existing browser drivers run `new task default deadline` in en/uk and light/dark. They verify the date text, full visibility and hit testing, picked-date persistence, reset, a draft kept across days, and omission of the default from the submitted body. | Passed; 24 frames inspected |
| System producers remain undated | Explicit assertions in `src/lib/monitor/seatTickController.test.ts`, `src/lib/boardMaintenance/run.test.ts`, `src/lib/release/production.test.ts`, `src/lib/state/durability.test.ts`, `src/lib/runtime/startup.quarantine.test.ts`, `src/lib/tasks/systemRun.test.ts`, `src/lib/tasks/curator.test.ts`, `src/lib/tasks/membership.test.ts`, `src/lib/links/taskSync.test.ts`, and `src/lib/tasks/proactive.test.ts`. The relevant producer cases pass, including cases in files with unrelated baseline failures. | Passed |
| Old undated tasks remain usable and never show overdue | Legacy loading and undated updates in `src/lib/tasks/taskCreate.test.ts`; `src/components/kanban/TaskMeta.test.ts:46` renders an undated task 1,000 days later without an overdue badge. | Passed |
| All 47 test files mentioning `create_task` audited | One helper, `src/lib/tasks/taskDue.fixture.ts`, supplies create dates. The 38 files containing create payloads use it, including generated child scripts. The other nine mention names, receipts or policy metadata. The concurrency child and benchmark also use it. Missing-date, invalid-date and past-date refusal cases supply their deliberate invalid values. | Passed |
| Existing project admission remains intact | `requireTaskCreateDue` composes the previous admission callback. The binding regression verifies that an unknown project reserves no receipt and the corrected request can reuse its key. | Passed |

Frames are in `$TMPDIR/slice3-verified/task-due-composer/desktop/` and `phone/`. Contact sheets are alongside those directories. The 12 readings per surface, capture time, fixed clock and source digests are committed in `evidence/task-due-composer/desktop.json` and `phone.json`. The source digests were checked against this worktree. Desktop is 1440 × 900; phone is 390 × 844.

Manual heavy checks ran sequentially through `gate-remote`. Each test file ran in a separate process with private HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR, and a closed Viewer control URL.

| Check | Exit | Evidence |
| --- | --- | --- |
| `bunx tsc --noEmit` | 0 | `$TMPDIR/slice3-privacy-final/task-due-privacy-final/typecheck.log` |
| `bun scripts/eslint-changes.ts --base bf1c00247 <touched TypeScript files>` | 0 | Same directory, `eslint.log`: zero introduced errors; 27 existing errors in the base. Raw ESLint returned 1 for those existing errors. |
| `bun run test <explicit file>` across 65 unique files | Individual codes below | Full logs in `$TMPDIR/slice3-checks/task-due-checks/`, with fresh observations in `slice3-final/task-due-final/`, `slice3-verified/task-due-verified/` and `slice3-last/task-due-last/`. |
| Complete base comparisons for failing files | 0 introduced failures | `$TMPDIR/slice3-logs/comparison-final.json`; 22 files retain matching baseline failures, including nine test-load errors. |
| New command, binding and route regressions against the old implementation | 1 each, expected | `$TMPDIR/slice3-final/task-due-final/red-command-*`, `red-binding-*`, `red-route-*`. |
| Enabled kanban and phone deadline cases | 0 each | `$TMPDIR/slice3-verified/task-due-verified/browser-desktop-*` and `browser-phone-*`. The broad file sweep loads browser files with their rendered cases gated off. |
| Interrupted-call fixtures after their date migration | 0 | `$TMPDIR/slice3-last/task-due-last/interruptedCall.log` |
| Parser fixtures after privacy cleanup | 0 | `$TMPDIR/slice3-privacy-final/task-due-privacy-final/parse.log`: 253 passed; the export hash matches the final fixture. |
| Local privacy check of the updated parser fixture | 0 | `$TMPDIR/slice3-logs/privacy-fixture.log`: `PRIVACY GATE: PASS`. |
| `git diff --check` | 0 | Final whitespace check. |

Earlier corrected probes remain under `$TMPDIR/slice3-logs/`: compiler exits 2, 2 and 2; one combined compiler/lint process ended with signal exit 143 and no verdict; the first focused test run exited 1; browser probes exited 1, 1, 0 and 1 before the final successful capture. The broad test invocation exited 1 for the failures compared below. The first normal commit attempt exited 1 because privacy refused an existing resource identifier and voice-payload literals in the touched parser fixture. Those values now use invented fixture content. The final payload passed privacy, all 253 parser tests, typecheck and the ESLint comparator. The stage summary records the normal commit-hook outcome.

The final per-file outcomes follow. Counts are pass / fail / skip / test-load error. An n/a means that a green file needed no baseline run.

| Test file | Exit | Final counts | Base exit and counts |
| --- | ---: | --- | --- |
| `src/app/api/tasks/route.test.ts` | 0 | 7 / 0 / 0 / 0 | n/a |
| `src/components/conversation/DeputyBlock.dom.test.tsx` | 0 | 19 / 0 / 0 / 0 | n/a |
| `src/components/feed/parse.test.ts` | 0 | 253 / 0 / 0 / 0 | n/a |
| `src/components/kanban/TaskMeta.test.tsx` | 0 | 4 / 0 / 0 / 0 | n/a |
| `src/components/kanban/kanbanBoard.browser.test.tsx` | 0 | 1 / 0 / 248 / 0 | n/a |
| `src/components/mobile/issue1671Evidence.browser.test.tsx` | 0 | 0 / 0 / 98 / 0 | n/a |
| `src/components/runtime/McpCallCard.dom.test.tsx` | 0 | 8 / 0 / 0 / 0 | n/a |
| `src/components/selfUpdate/SelfUpdateView.dom.test.tsx` | 0 | 140 / 0 / 0 / 0 | n/a |
| `src/components/tasks/TaskSheet.dom.test.tsx` | 0 | 4 / 0 / 0 / 0 | n/a |
| `src/hooks/useTaskDraft.refusals.dom.test.tsx` | 0 | 3 / 0 / 0 / 0 | n/a |
| `src/lib/boardMaintenance/guard.test.ts` | 1 | 1 / 2 / 0 / 0 | 1: 1 / 2 / 0 / 0 |
| `src/lib/boardMaintenance/run.test.ts` | 0 | 32 / 0 / 0 / 0 | n/a |
| `src/lib/boardMaintenance/store.test.ts` | 1 | 5 / 2 / 0 / 0 | 1: 5 / 2 / 0 / 0 |
| `src/lib/externalRelay/progressSteps.test.ts` | 0 | 9 / 0 / 0 / 0 | n/a |
| `src/lib/links/taskSync.test.ts` | 1 | 20 / 2 / 1 / 0 | 1: 20 / 2 / 1 / 0 |
| `src/lib/mcp/answerSizes.test.ts` | 0 | 8 / 0 / 0 / 0 | n/a |
| `src/lib/mcp/bindings.test.ts` | 0 | 113 / 0 / 0 / 0 | n/a |
| `src/lib/mcp/crossProject.test.ts` | 1 | 8 / 1 / 0 / 0 | 1: 8 / 1 / 0 / 0 |
| `src/lib/mcp/curateRules.test.ts` | 0 | 3 / 0 / 0 / 0 | n/a |
| `src/lib/mcp/http.test.ts` | 0 | 19 / 0 / 3 / 0 | n/a |
| `src/lib/mcp/interruptedCall.test.ts` | 0 | 24 / 0 / 0 / 0 | n/a |
| `src/lib/mcp/largeReads.test.ts` | 1 | 10 / 2 / 0 / 0 | 1: 10 / 2 / 0 / 0 |
| `src/lib/mcp/leaveLessonSeat.test.ts` | 0 | 9 / 0 / 0 / 0 | n/a |
| `src/lib/mcp/maintainerGuard.integration.test.ts` | 1 | 0 / 1 / 0 / 1 | 1: 0 / 1 / 0 / 1 |
| `src/lib/mcp/modelInput.test.ts` | 0 | 7 / 0 / 0 / 0 | n/a |
| `src/lib/mcp/pipelineBusyAdmission.test.ts` | 1 | 9 / 1 / 0 / 0 | 1: 9 / 1 / 0 / 0 |
| `src/lib/mcp/presentation.test.ts` | 0 | 4 / 0 / 0 / 0 | n/a |
| `src/lib/mcp/projectResolution.test.ts` | 1 | 43 / 12 / 0 / 0 | 1: 43 / 12 / 0 / 0 |
| `src/lib/mcp/reportTools.test.ts` | 1 | 5 / 1 / 0 / 0 | 1: 5 / 1 / 0 / 0 |
| `src/lib/mcp/schemaParity.test.ts` | 1 | 36 / 1 / 0 / 0 | 1: 36 / 1 / 0 / 0 |
| `src/lib/mcp/server.test.ts` | 0 | 101 / 0 / 0 / 0 | n/a |
| `src/lib/mcp/shortIds.answers.test.ts` | 0 | 7 / 0 / 0 / 0 | n/a |
| `src/lib/mcp/taskBoardVisibility.integration.test.ts` | 1 | 0 / 1 / 0 / 1 | 1: 0 / 1 / 0 / 1 |
| `src/lib/mcp/taskColor.integration.test.ts` | 1 | 0 / 1 / 0 / 1 | 1: 0 / 1 / 0 / 1 |
| `src/lib/mcp/taskColorGroupHide.integration.test.ts` | 1 | 0 / 1 / 0 / 1 | 1: 0 / 1 / 0 / 1 |
| `src/lib/mcp/taskDetails.integration.test.ts` | 1 | 0 / 1 / 0 / 1 | 1: 0 / 1 / 0 / 1 |
| `src/lib/mcp/taskExecutor.test.ts` | 0 | 31 / 0 / 0 / 0 | 0: 31 / 0 / 0 / 0 |
| `src/lib/mcp/taskFinding.integration.test.ts` | 0 | 4 / 0 / 0 / 0 | n/a |
| `src/lib/mcp/taskIcon.integration.test.ts` | 1 | 0 / 1 / 0 / 1 | 1: 0 / 1 / 0 / 1 |
| `src/lib/mcp/taskLineEdits.integration.test.ts` | 1 | 0 / 1 / 0 / 1 | 1: 0 / 1 / 0 / 1 |
| `src/lib/mcp/taskOwnership.integration.test.ts` | 0 | 1 / 0 / 0 / 0 | n/a |
| `src/lib/mcp/taskPosition.integration.test.ts` | 1 | 0 / 1 / 0 / 1 | 1: 0 / 1 / 0 / 1 |
| `src/lib/mcp/taskPriority.integration.test.ts` | 1 | 0 / 1 / 0 / 1 | 1: 0 / 1 / 0 / 1 |
| `src/lib/mcp/workLinks.test.ts` | 0 | 2 / 0 / 0 / 0 | n/a |
| `src/lib/mcp/writerConcurrency.test.ts` | 1 | 3 / 2 / 1 / 0 | 1: 3 / 2 / 1 / 0 |
| `src/lib/memory/curation/curation.test.ts` | 0 | 92 / 0 / 0 / 0 | n/a |
| `src/lib/memory/operatorMemory.test.ts` | 0 | 18 / 0 / 0 / 0 | n/a |
| `src/lib/memory/roleDelivery.test.ts` | 0 | 34 / 0 / 0 / 0 | n/a |
| `src/lib/memory/roleSeatRender.test.ts` | 0 | 3 / 0 / 0 / 0 | n/a |
| `src/lib/monitor/seatTickController.test.ts` | 1 | 43 / 63 / 0 / 0 | 1: 43 / 63 / 0 / 0 |
| `src/lib/orchestrator/deputySweep.test.ts` | 0 | 14 / 0 / 0 / 0 | n/a |
| `src/lib/orchestrator/ownerRelay.test.ts` | 1 | 22 / 3 / 0 / 0 | 1: 22 / 3 / 0 / 0 |
| `src/lib/orchestrator/prompt.test.ts` | 0 | 67 / 0 / 0 / 0 | n/a |
| `src/lib/projects/shortIds.test.ts` | 1 | 6 / 1 / 0 / 0 | 1: 6 / 1 / 0 / 0 |
| `src/lib/release/production.test.ts` | 0 | 10 / 0 / 0 / 0 | n/a |
| `src/lib/runtime/startup.quarantine.test.ts` | 0 | 14 / 0 / 0 / 0 | n/a |
| `src/lib/session/messagesPage.test.ts` | 0 | 12 / 0 / 0 / 0 | n/a |
| `src/lib/state/durability.test.ts` | 0 | 38 / 0 / 0 / 0 | n/a |
| `src/lib/tasks/curator.test.ts` | 0 | 4 / 0 / 0 / 0 | n/a |
| `src/lib/tasks/membership.test.ts` | 0 | 22 / 0 / 0 / 0 | n/a |
| `src/lib/tasks/proactive.test.ts` | 0 | 23 / 0 / 0 / 0 | n/a |
| `src/lib/tasks/systemRun.test.ts` | 0 | 6 / 0 / 0 / 0 | n/a |
| `src/lib/tasks/taskCreate.test.ts` | 0 | 27 / 0 / 0 / 0 | n/a |
| `src/lib/voiceCompanion/boardReads.test.ts` | 0 | 5 / 0 / 0 / 0 | n/a |
| `src/lib/voiceCompanion/liveSession.test.ts` | 0 | 127 / 0 / 0 / 0 | n/a |

Slices 1 and 2 also change imports in `src/lib/tasks/commands.ts` and append helpers in `src/lib/tasks/helpers.ts`. Integration must retain both slices’ imports and helper functions. Slice 4 and the separate callback-cause fix remain outside this change. The pinned base and `origin/main` remained `bf1c00247` at the final base check.

The change contains 69 files:

- `evidence/task-due-composer/desktop.json`
- `evidence/task-due-composer/phone.json`
- `evidence/task-due-composer/verification.md`
- `scripts/mcp-state-writer-benchmark.ts`
- `src/app/api/tasks/route.test.ts`
- `src/app/api/tasks/route.ts`
- `src/components/conversation/DeputyBlock.dom.test.tsx`
- `src/components/feed/parse.test.ts`
- `src/components/kanban/TaskMeta.test.tsx`
- `src/components/kanban/issue1695BrowserHarness.ts`
- `src/components/kanban/kanbanBoard.browser.test.tsx`
- `src/components/mobile/issue1671Evidence.browser.test.tsx`
- `src/components/runtime/McpCallCard.dom.test.tsx`
- `src/components/tasks/TaskComposer.tsx`
- `src/hooks/useTaskDraft.ts`
- `src/lib/boardMaintenance/run.test.ts`
- `src/lib/i18n/en.ts`
- `src/lib/i18n/uk.ts`
- `src/lib/links/taskSync.test.ts`
- `src/lib/mcp/answerSizes.test.ts`
- `src/lib/mcp/bindings.test.ts`
- `src/lib/mcp/bindings.ts`
- `src/lib/mcp/crossProject.test.ts`
- `src/lib/mcp/curateRules.test.ts`
- `src/lib/mcp/http.test.ts`
- `src/lib/mcp/interruptedCall.test.ts`
- `src/lib/mcp/largeReads.test.ts`
- `src/lib/mcp/maintainerGuard.integration.test.ts`
- `src/lib/mcp/modelInput.test.ts`
- `src/lib/mcp/pipelineBusyAdmission.test.ts`
- `src/lib/mcp/presentation.test.ts`
- `src/lib/mcp/projectResolution.test.ts`
- `src/lib/mcp/reportTools.test.ts`
- `src/lib/mcp/schemaParity.test.ts`
- `src/lib/mcp/server.test.ts`
- `src/lib/mcp/server.ts`
- `src/lib/mcp/shortIds.answers.test.ts`
- `src/lib/mcp/taskBoardVisibility.integration.test.ts`
- `src/lib/mcp/taskColor.integration.test.ts`
- `src/lib/mcp/taskColorGroupHide.integration.test.ts`
- `src/lib/mcp/taskDetails.integration.test.ts`
- `src/lib/mcp/taskExecutor.test.ts`
- `src/lib/mcp/taskFinding.integration.test.ts`
- `src/lib/mcp/taskIcon.integration.test.ts`
- `src/lib/mcp/taskLineEdits.integration.test.ts`
- `src/lib/mcp/taskOwnership.integration.test.ts`
- `src/lib/mcp/taskPosition.integration.test.ts`
- `src/lib/mcp/taskPriority.integration.test.ts`
- `src/lib/mcp/workLinks.test.ts`
- `src/lib/mcp/writerConcurrencyChild.ts`
- `src/lib/memory/curation/curation.test.ts`
- `src/lib/monitor/seatTickController.test.ts`
- `src/lib/orchestrator/deputySweep.test.ts`
- `src/lib/orchestrator/ownerRelay.test.ts`
- `src/lib/projects/shortIds.test.ts`
- `src/lib/release/production.test.ts`
- `src/lib/runtime/startup.quarantine.test.ts`
- `src/lib/session/messagesPage.test.ts`
- `src/lib/state/durability.test.ts`
- `src/lib/tasks/commands.ts`
- `src/lib/tasks/curator.test.ts`
- `src/lib/tasks/helpers.ts`
- `src/lib/tasks/membership.test.ts`
- `src/lib/tasks/proactive.test.ts`
- `src/lib/tasks/systemRun.test.ts`
- `src/lib/tasks/taskCreate.test.ts`
- `src/lib/tasks/taskDue.fixture.ts`
- `src/lib/voiceCompanion/boardReads.test.ts`
- `src/lib/voiceCompanion/liveSession.test.ts`
