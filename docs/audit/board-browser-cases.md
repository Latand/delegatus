# Board browser case triage

Audit date: 2026-10-29. Tested revision: `83973ce6e054ab5ee2ca6247468b57d21141aa05`. The assigned checkout, its recorded `origin/main`, and the remote `refs/heads/main` agreed before testing. Browser: Google Chrome for Testing 156.0.8078.4, headless; Bun 1.4.0. Product and test sources were unchanged.

This report judges the historical failure hypotheses. **CONFIRMED** means the stated observation reproduced; **WRONG** means the historical failure no longer describes this revision. A red test can have a confirmed stale expectation. Completion of this triage is independent of whether those tests are green.

**Issue identity and scope.** Every inventory number below was read with `gh issue view NUMBER --json number,title,state,body,closedAt` before its case ran. A separate issue API read checked whether the number denotes an issue or a pull request.

| Inventory number | Current identity/state | Browser scope audited |
| --- | --- | --- |
| #2060 | Issue, open | #1802, #1731, the separate #1681 driver and the real seat-header case |
| #2069 | Issue, open | #1765 header counters and named pipelines |
| #2091 | Issue, open | K5a graphs, rounds, labels and attempt history |
| #2165 | Issue, open | K4b seat task and lock |
| #2103 | Issue, open | The requested `columns balanced` case; **WRONG association:** this issue actually describes two DOM/API suites, with no column-balance browser case |
| #2161 | Issue, open | All its browser entries: K1+K2, K3, K5a, K5b, #1938, retired #1743, balanced columns and both #2072 cases; #1731/#1802 also covered |
| #2201 | Issue, open | Part 2 only: both #2072 browser cases |
| #1722 | Issue, open | K1+K2 presence sanity guard |
| #1853 | Issue, open | K6a conversation picker |
| #1992 | Issue, open | K1+K2 and K3 |
| #1989 | Issue, open | Production-build `columns-wide` capture |

#2592 is a **closed pull request**. `gh pr view 2592 --json number,state,mergedAt,mergeCommit` returns `state: CLOSED`, `mergedAt: null`, `mergeCommit: null`. Its earlier case-by-case decisions were read, and main contains ancestor `8e466a5d6`, whose subject references #2592. Neither the PR's closed state nor its old green measurements substitute for this audit's runs. Earlier transcript searches also found prior graph/column runs; current source and fresh browser observations decide the verdicts below.

During the audit the remote main head advanced to `308ba22a3203bf2851ee6f7613c43c5fe8742bbf`. The complete comparison was read through the forge API: one commit, #3490, changes only `src/lib/runtime/codexAppServerHost.test.ts`. Production browser inputs, both browser drivers, fixtures, stylesheets and the capture script are identical between those revisions. The tested export remains pinned to the full revision above.

Open PRs #3427 and #3399 touch the shared board driver. Their driver diffs add conversation-draft and task-summary coverage; those changes were excluded. The historical cases were run from the named main revision.

**Procedure and command notation.** All browser cases ran sequentially, with one selected test per invocation. Tests, bundles, generated measurements and the production build ran in a scratch archive of the revision. Each invocation had private `HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `TMPDIR`, `LLV_STATE_DIR`, `LLV_CLAUDE_HOME` and `LLV_CODEX_HOME`; the Viewer control URL pointed to a closed loopback port. `LLV_GATE_RUNNER=off` kept the runs on this host. No running installation supplied fixture data. Prototype comparison was disabled; the current production assertions ran. The prototype-comparison fields in the generated records are therefore false.

The commands use variables in place of machine-specific locations: `$GATE` is the supplied gate-slot wrapper, `$BROWSER` the Chrome launch wrapper, `$RUN` the fresh run directory, and `$EXPORT` the scratch archive. The launch wrapper uses an inherited directory descriptor for Chrome's temporary files because the stage root exceeds Chrome's socket-path limit. This changes no test or product source. The initial #1802 launch failed before rendering for that path-limit reason; its successful rerun is the evidence below.

```sh
cd "$EXPORT"
export HOME="$RUN/home" XDG_CONFIG_HOME="$RUN/config"
export XDG_CACHE_HOME="$RUN/cache" TMPDIR="$RUN/tmp"
export LLV_STATE_DIR="$RUN/state" LLV_CLAUDE_HOME="$RUN/claude"
export LLV_CODEX_HOME="$RUN/codex" LLV_VIEWER_CONTROL_URL="$CLOSED_CONTROL_URL"
export LLV_GATE_RUNNER=off CHROME_BIN="$BROWSER" LLV_KANBAN_BROWSER_TEST=1
export PIPELINE_BLOCK_PNG_DIR="$EXPORT/.artifacts/pipeline-block-frames"
export PIPELINE_SCREEN_PNG_DIR="$EXPORT/.artifacts/pipeline-screen-frames"
export LOOPS_PNG_DIR="$EXPORT/.artifacts/pipeline-graph-loop-frames"
export SEAT_HEAD_PNG_DIR="$EXPORT/.artifacts/seat-head-frames"

# Use a fresh RUN and log for each invocation.
B() {
  pattern="$1"; shift
  bash "$GATE" --record "$RUN/check.log" bun run test "$@" \
    src/components/kanban/kanbanBoard.browser.test.tsx --test-name-pattern "$pattern"
  bash "$GATE" --wait "$RUN/check.log"
}
T() {
  LLV_SEAT_TICK_BROWSER_TEST=1 bash "$GATE" --record "$RUN/check.log" \
    bun run test src/components/orchestrator/issue1681Evidence.browser.test.tsx \
    --test-name-pattern '^#1681 rendered'
  bash "$GATE" --wait "$RUN/check.log"
}
```

`bun run test` expands to `bun test --timeout=60000`; explicit browser-case deadlines still apply. Record/wait logs preserve each process exit. Three first captures used the driver's legacy screenshot defaults; the #2072 and graph-loop evidence used for the final report was repeated with the explicit scratch overrides above. Generated JSON paths below identify the driver's output **inside the scratch export**; committed historical JSON was not used as a fresh result.

| Case and inventory coverage | Hypothesis label; verdict now | Command, exit and observed evidence | Follow-up; touches UI? |
| --- | --- | --- | --- |
| #1802 folding (#2060, #2161) | **WRONG** historical failure; **passes now** | `B '#1802'`, exit **0**, 1 pass/0 fail. The fold clicks complete in light and dark; `evidence/issue-1802/fold.json` has no failures. | Close this browser symptom. The case already dismisses the attention toast before using the seat controls (`kanbanBoard.browser.test.tsx:7190`). No UI change. |
| #1731 grip and anchoring (#2060, #2161) | **WRONG** historical failure; **passes now** | `B '#1731'`, exit **0**, 1 pass/0 fail. At 1440×900 the grip changes 675→425 px; at 1100×800, 600→350 px. All four anchoring runs have zero board swings; the deliberately re-enabled anchoring control has 12 swings each. `evidence/issue-1731/seat-anchor.json`: `failures: []`. | The seat starts at its maximum; the current case drags upward (`kanbanBoard.browser.test.tsx:6540`). Close the symptom. No UI change. |
| #1681 hand-built header (#2060) | **CONFIRMED** obsolete fixture/expectations; **stale test expectation** | `T`, exit **1**, 1 fail. It now stops earlier in `phone()` at `issue1681Evidence.browser.test.tsx:529`: `TypeError: Cannot read properties of null (reading 'getBoundingClientRect')`. The missing legacy summary node is read at line 552. The historical `sweepFirstPaintEn` assertion is not reached. The real-header replacement passes separately below. | Replace/retire the hand-built header (`issue1681Evidence.fixture.tsx:344`) and align the phone measurement with the button plus switch drawn by `MobileSeatTickSheet.tsx:91`. Do not cite this aborted run's old JSON as new evidence. No UI change. |
| Real seat header, replacement coverage for #2060 | **CONFIRMED** current header; **passes now** | `B 'orchestrator seat.s header'`, exit **0**, 1 pass/0 fail. Fifteen readings cover 390/768/1080/1440, en/uk, top/side and role-frame variants; `evidence/seat-head/geometry.json`: `failures: []`. | Retain this real-header coverage when removing synthetic-header checks. No UI change. |
| #1765 counters (#2069) | **WRONG** historical failure; **passes now** | `B '#1765'`, exit **0**, 1 pass/0 fail. The 1280 px header has one counter; two running rows become five after opening the three completed rows. The 390 px task screen draws named lanes. `evidence/issue-1765/board.json`: no failures. | The single-counter assertion is already present at `kanbanBoard.browser.test.tsx:6742`. Close #2069. No UI change. |
| K5a graphs/history (#2091, #2161) | **WRONG** historical failures; **passes now** | `B '#1695 K5a'`, exit **0**, 1 pass/0 fail. Review detail is `1 ✓`; the return is a fired strip with budget 1/2; the three pass wires have dashed/solid/dashed states and the sole wire label is `1`. The two-stage graph is LR with 176×76 px nodes. Five rounds render `5` and `✓`. Attempt history includes the failed Build; timeline attempts/rounds and the helper open correctly. `evidence/issue-1695/k5a.json`: `failures: []`. | Keep current strips, attempt captions, stage names and timeline assertions. Earlier return-wire labels, role-name rows and round-chip shapes are obsolete. Close #2091. No UI change. |
| K4b hidden seat task (#2165) | **WRONG** missing-lock hypothesis; **stale test expectation** elsewhere in the case | `B '#1695 K4b'`, exit **1**. Sole assertion: `seat read: {"reads":4,"panel":true,"lock":true}` at `kanbanBoard.browser.test.tsx:4717`. `flows.protectedSeat` confirms the Assigned card, lock, no hide button, disabled Hide menu, resurface explanation and zero hide writes. The seat-card screenshot visibly shows the lock. | The original #2165 symptom can close. Count project and cross-project polling separately; the request observer below confirms two reads of each scope. No UI change. |
| Balanced columns/pill names (#2103 as requested; #2161) | **WRONG** historical selector failure; **passes now** | `B 'columns balanced'`, exit **0**, 1 pass/0 fail, en/uk at 1440/1500/1648/1680/1920/2560. At 1920: board 1672 px, Assigned 520 px, three equal 354.7 px shelves. `src/components/kanban/evidence/column-balance/branch.json`: `failures: []`. | `.pb-name` is measured and stage names may wrap whole inside their pills (`kanbanBoard.browser.test.tsx:9557`, `:9647`). `branch` is this case's positive-run label, including when the product is main. The unrelated suites in #2103 remain outside this audit. No UI change. |
| K1+K2, including presence, links and creation (#1722, #1992, #2161) | **WRONG** historical failures; **passes now** | `B '#1695 K1\+K2'`, exit **0**, 1 pass/0 fail. Presence has two visible and two off-screen tiles, with no reported/visible mismatch at either reading. Conversation links change the selected conversation with zero presentation writes. The header's create menu produces a new Inbox task and card drafts. `evidence/issue-1695/geometry.json`: `failures: []`. | Keep the non-vacuous presence guard and current header menu. Close #1722 and the K1+K2 part of #1992. No UI change. |
| K3 conversations/reranking (#1992, #2161) | **CONFIRMED** current red; **stale test expectation** | `B '#1695 K3'`, exit **1**: `waitForFunction: Timeout 15000ms exceeded` at `kanbanBoard.browser.test.tsx:4011`. After `askDecision`, the case expects the upload card before the search card. Current `compareCards` orders active work by `workingSinceMs` (`kanbanModel.ts:415`); a decision request does not change either running start. A read-only observation rerun also exits 1: the search card stays immediately above the upload card, whose visible state changes to `Needs your answer: permission prompt`. This follows `docs/design/kanban-recent-first.md:180`. | Trigger an actual work-start/attempt change to test a reorder, then retain the reader identity and scroll checks. The later seat/Stop-host/failed-read assertions are skipped by this timeout; this run supplies no verdict on them. No UI change. |
| K5b stage actions (#2161) | **CONFIRMED** current red; **stale test expectation** | `B '#1695 K5b'`, exit **1**. Sole collected failure: `pipeline actions: waitForSelector: Timeout 2000ms exceeded.` The obsolete wait is `[data-pipeline-acting="pause"]` at `kanbanBoard.browser.test.tsx:5520`. An observation rerun exits 1 with the same failure and records the upload lane as `paused` plus its pause receipt, while the requested marker remains absent. Pause/resume now predict their state immediately and intentionally omit the busy marker (`usePipelineActions.ts:40`, `:102`). | Assert the immediate paused state while the request is pending, then its receipt, refusal rollback and lost-answer reconciliation. Preserve guarded Skip coverage. No UI change. |
| #1938 spent review budget (#2161) | **CONFIRMED** current red; **stale test expectation** | `B '#1938'`, exit **1**. Sole failure: `390: the card's reason does not say the fix is unreviewed: ""`. At `kanbanBoard.browser.test.tsx:6879` the test reads a nested `[data-pipeline-reason]`; its assertion is at `:6896`. The rendered card visibly says `Needs your answer: the last fix is unreviewed` and carries the spent-review badge. Desktop state, stop reason and both-head checks pass. | Read the card's state line. `MobileKanban.tsx:579` draws it, and `:587` suppresses the duplicate pipeline reason with `reasonLine={!state}`. No UI change. |
| #1743 engine/effort/edge presentation (#2161) | **CONFIRMED** retired case; **stale test expectation** | `B '#1743'`, exit **1**: `regex "#1743" matched 0 tests ... skipping 272 tests`. The filter confirms the case is absent. The two replacement cases below exercise the current presentation. | Retain the graph-strip and model-glyph coverage. Restoring the old legend, circled edge counts and effort ladders would reinstate retired expectations. No UI change. |
| Graph-loop replacement for #1743 | **CONFIRMED** replacement coverage; **passes now** | `B 'readable pipeline graph'`, exit **0**, 1 pass/0 fail. Six lane shapes, compact cards and wide sheets at 1440, phone task/pipeline screens at 390/360, en/uk. `evidence/pipeline-graph-loops/geometry.json`: no failures. | No fix; no UI change. |
| Model-glyph replacement for #1743 | **CONFIRMED** replacement coverage; **passes now** | `B 'model glyphs'`, exit **0**, 1 pass/0 fail. Desktop/phone, light/dark, en/uk, reduced motion and 1×/2× legend samples; `evidence/model-glyphs/design/readings.json`: no failures. | No fix; no UI change. |
| #2072 pipeline ink/phone rows (#2201 part 2, #2161) | **WRONG** historical timeout; **passes now** | `B 'no text of a pipeline block'`, exit **0**, 1 pass/0 fail, at 390/1080/1440, en/uk, light/dark. Current phone status cards and the task/pipeline navigation complete. `evidence/pipeline-block/geometry.json`: no failures. | Close this browser symptom in #2201. Keep current phone navigation. No UI change. |
| #2072 phone pipeline screen (#2201 part 2, #2161) | **WRONG** historical timeout; **passes now** | `B 'the phone.s pipeline screen'`, exit **0**, 1 pass/0 fail, at 390/430, en/uk, light/dark. The geometry, names, 44 px controls and paused-stage checks complete. `evidence/pipeline-block/pipeline-screen.json`: no failures. | Close this browser symptom in #2201. No UI change. |
| K6a picker head (#1853) | **WRONG** historical failure; **passes now** | `B '#1695 K6a'`, exit **0**, 1 pass/0 fail. The conversation picker uses stage name `Verify`; the stage picker uses `Review`. `evidence/issue-1695/k6.json`: `failures: []`. | Keep stage-name assertions; close #1853. No UI change. |
| #1989 pinned shelf at 1920 | **CONFIRMED** obsolete cap and tile setup; **stale test expectation** | `G` below, exit **1**, 16 collected failures across all 12 viewport/locale/theme combinations: four `Assigned kept 354.5px beside a pinned shelf (wide)` failures at 1920, and twelve `the wide Done's tiles are px` failures. At 1920, pinned Blocked is 520 px; Assigned, Inbox and Done are each 354.5 px (half-pixel-rounded). At 1440/1280 those shelves are 280 px and the widened track is 480 px. The capture's `columns-wide.json` names the tested full revision. | Replace the obsolete 264.5 px cap at `scripts/capture-board-geometry.ts:4412` with equality to the two other shelves within 1 px; retain the scroll-mode 280.5 px cap. At `:4397`, expand the Done card before requiring member rows, and assert their containment using the current row layout. No UI change. |

**K4b polling observation — CONFIRMED stale aggregation.** A read-only preload observed the existing case without editing its fixture or product. After the case reset its counter, project requests arrived at +4.722 s and +10.721 s, and cross-project requests at +5.128 s and +11.128 s. Thus the four requests are two of each scope in the 12.5 s window. Both pollers use `SEAT_POLL_MS = 6000` (`src/components/orchestrator/useOrchestratorSeat.ts:14`, `:167`, `:311`); the cross-project read serves retirement detection (`src/components/orchestrator/RetiredOrchestratorBanner.tsx:38`). The fixture counts every seat-route request together (`issue1695Evidence.fixture.tsx:4957`), while the test limits their total to three. The unchanged case and the observed rerun both exit 1 with the same sole assertion. Change the fixture counter to record each query scope, then check one shared poll per scope and retain the visible panel/lock assertions.

The observation reruns used `B '#1695 K4b' --preload "$READ_ONLY_PROBE"`, `B '#1695 K3' --preload "$READ_ONLY_PROBE"` and `B '#1695 K5b' --preload "$READ_ONLY_PROBE"`, one at a time; each exits 1 with the original failure. The temporary observer logs seat request scopes and captures the DOM/screenshot on timeout. It changes no response or assertion. All 4,926 compared source files in the export still match the assigned checkout.

**Production capture procedure and cause — CONFIRMED.** The Next.js production build ran through the supplied gate wrapper with the same isolated roots and exited 0. It emitted one CSS optimizer warning for `::highlight(tts-karaoke)`. The capture then ran through that wrapper:

```sh
bash "$GATE" --record "$RUN/build.log" \
  bun --bun node_modules/.bin/next build --webpack
bash "$GATE" --wait "$RUN/build.log"

# G: the existing production-build geometry driver.
BOARD_CAPTURE_COMMIT=83973ce6e054ab5ee2ca6247468b57d21141aa05 \
BOARD_CAPTURE_CASE=columns-wide \
  bash "$GATE" --record "$RUN/geometry.log" \
  bun --preload "$CAPTURE_ENV" scripts/capture-board-geometry.ts
bash "$GATE" --wait "$RUN/geometry.log"
```

`$CAPTURE_ENV` applies the fixture-only Git environment cleanup already used by `test-preload.ts:55`, so inherited stage hooks do not reach the driver's invented repository. The driver allocates its capture directory beneath the private `TMPDIR`; its default directory allocator was used. Two preliminary setup attempts stopped before rendering: an invalid capture-directory override and inherited Git hooks on the synthetic seed commit. Their exit-1 results are setup diagnostics. The final run rendered all 12 combinations and produced 36 frames plus its JSON, then closed its owned browser and server.

The four wide-cap failures agree with the board's balanced-shelf formula (`src/components/kanban/kanbanBoard.css:27`) and the passing independent balanced-columns case. The twelve empty-tile failures have a second stale premise: the capture widens Done but never opens its card. Cards now start closed (`src/components/kanban/KanbanBoard.tsx:405`; `docs/design/calm-task-cards-build.md:48`), and `KanbanCard.tsx:894` mounts members only when open. The screenshot shows the closed Done card; all twelve `doneWide` readings contain an empty tile array. The old 200 px tile-grid assertion also predates the full-width member rows now defined by `kanbanBoard.css:604`. Preserve a nonempty measurement after opening the card and check the current row bounds.

**Summary.** Triage is complete: 19 verdict rows cover 18 active cases and the retired #1743 case. Twelve active cases pass; six active cases have stale expectations. **Confirmed product defects: none in this inventory.** The remaining test work is #1681's synthetic header/phone structure, K4b's combined polling count, K3's motion-based rerank trigger, K5b's pending pause marker, #1938's nested phone reason selector, and #1989's wide shelf cap plus unopened/obsolete tile-grid measurement. #1743 is retired, with both replacement cases passing. All proposed changes affect tests or capture setup; none requires a product UI change.

**Notes:** #1722, #1853, #2069 and #2091 can close on this evidence; #2165's missing-lock symptom is resolved. #2060 still has the stale #1681 case. #1992 still has K3 test drift. #2161 still has the listed stale browser expectations, and its DOM suites were outside this audit. Only #2201 part 2 was checked; its other suites remain outside scope. The requested balanced-columns case passes, but #2103's actual DOM/API issues need their own verification. No forge state was changed.

**Final checks — CONFIRMED.** The source recheck at 10:02 UTC found zero differences across all 4,926 compared source files. The remote head remains `308ba22a3203bf2851ee6f7613c43c5fe8742bbf`, with only the reviewed unrelated test change since the tested revision. The assigned checkout has no tracked changes; its only new file is this report. The explicit-file publication scan, run with isolated roots and the committed known-value fingerprints, exits 0:

```sh
LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE=scripts/privacy-known-value-fingerprints.json \
  bun scripts/privacy-publication-gate.ts --require-known-values \
  --paths docs/audit/board-browser-cases.md
# PRIVACY GATE: PASS
```

Only this report is a retained output. The rendered frames, raw logs, probes and generated JSON belong to stage scratch; the assertion excerpts and measurements above preserve the audit evidence without publishing machine paths or fixture account names.

## Repair verification

Repair date: 2026-10-29. **All 18 active Chrome cases now pass**, including the six repaired cases and all twelve controls from the original audit. The audit above is retained as the historical diagnosis.

Merged source revision: `6c46a95470da4c9c456a873f39438203d7acf0ab`; its second parent is current `origin/main`, `e317e8d5775978607a98e5faa256f030825783ee`. Main was already an ancestor, so the explicit merge records that parent without changing production inputs. Only the existing test drivers, their fixtures, and this report change. The production build, geometry capture, and full-project typecheck used a clean export of that merged revision. The three corrected browser reruns used identical committed driver bytes.

Chrome for Testing 156.0.8078.4 and Bun 1.4.0 ran locally. Every case ran separately and sequentially, through the supplied gate wrapper, with private HOME, XDG configuration/cache, TMPDIR, state and agent homes; the Viewer control URL was closed. Environment preparation used `checkEnvironment` followed by `isolatedEnvironment`. Chrome used a short descriptor-backed temporary path and visible scrollbars. Prototype comparison remained disabled.

| Case | Repair | Fresh result |
| --- | --- | --- |
| #1681 | Retire the obsolete synthetic header and its sweeps; retain the separate real-header case. Measure the phone's opening button and schedule switch. Expect the compact desktop schedule word. | Exit 0; 111 assertions. Dock checks and en/uk stale/blocked phone checks pass, including the keyboard-safe Save. The real-header control also passes. |
| K4b | Count project and all-project seat polls separately. | Exit 0; two reads per scope over 12.5 seconds. Panel and lock present; protected Hide remains disabled with zero hide writes. |
| K3 | Start a new running attempt at the fixture's seed clock, ahead of the existing turns. Require both cards to exist before comparing their order. | Exit 0; upload moves from after search to before it. The same reader remains mounted; scrollTop is 826 before, immediately after and after settling. Later Stop-host and failed-read checks also complete. |
| K5b | Hold the Pause response while asserting the predicted paused state and absence of an early confirmation. Release it and await its receipt. Assert refused Resume rolls back; wait for confirmed Resume before the next action. | Exit 0; pending state is paused, refusal rolls back, lost-answer reconciliation performs one read. Four expected writes; guarded Skip checks retained. |
| #1938 | Read the phone card's state line for the unreviewed-fix reason. | Exit 0; desktop states, both heads, spent-review badge and phone reason all pass. |
| #1989 | Open Done before reading its member rows. Check row containment; compare the grid shelves within 1 px and retain the scrolling 280.5 px cap. | Exit 0; 12 viewport/locale/theme combinations, 36 frames, empty failures. Six nonempty, contained member rows per combination. |

Driver locations: `src/components/orchestrator/issue1681Evidence.browser.test.tsx:274`; `src/components/kanban/kanbanBoard.browser.test.tsx:4013` (K3), `:4715` (K4b), `:5526` (K5b), `:6898` (#1938); `scripts/capture-board-geometry.ts:4393` and `:4418` (#1989). Fixture support stays in `src/components/kanban/issue1695Evidence.fixture.tsx` and `src/components/orchestrator/issue1681Evidence.fixture.tsx`.

The twelve controls each report one pass and zero failures: #1802, #1731, the real seat header, #1765, K5a, balanced columns, K1+K2, graph-loop replacement, model-glyph replacement, both #2072 cases, and K6a. The retired #1743 case remains retired.

The first candidate campaign completed all 17 selected Bun cases: 14 passed and three failed. Those failures exposed remaining driver assumptions: #1681 still expected “every 30 min” on the compact switch; K3's first replacement timestamp predated the live turns; K5b advanced after optimistic Resume before its confirmation. After correcting those assumptions, each of those three complete cases passed in a fresh invocation. Together with the successful production geometry capture, all 18 distinct cases have a passing final observation. No product defect was identified.

Commands follow the original isolation and B/T procedure above, with a fresh run/log per invocation:

```sh
T
B '#1695 K4b'
B '#1695 K3'
B '#1695 K5b'
B '#1938'
# The twelve control filters are listed in the original audit table.

# In a separate clean export of the merged source, using isolated roots:
NODE_ENV=production bash "$GATE" bun --bun node_modules/.bin/next build --webpack
BOARD_CAPTURE_CASE=columns-wide BOARD_CAPTURE_COMMIT="$MERGED_REVISION" \
  bash "$GATE" bun --preload "$CAPTURE_ENV" scripts/capture-board-geometry.ts
bash "$GATE" bunx tsc --noEmit
```

The production Viewer build and **full-project `bunx tsc --noEmit` both exit 0**. Both TypeScript configuration files match the committed inputs. The build emits the previously recorded CSS optimizer warning for `::highlight(tts-karaoke)`.

Fresh `columns-wide.json` records the merged revision and no failures. At 1920 px, Inbox, Assigned and Done are each 349.5 px beside pinned Blocked at 520 px. At 1440 and 1280, they are each 280 px beside Blocked at 480 px. Opened Done member rows measure 476 px at 1920 and 436 px at the smaller widths; every row stays within its card and column. Existing pin persistence, title and Overview assertions also pass. Rendered frames and the generated measurements were inspected; only this report retains the new evidence.

The code commits passed the existing pre-commit whitespace, publication privacy and scoped ESLint checks. Hooks remain enabled. Nothing was pushed and no pull request was opened by this stage.

Final publication check: `bun run privacy:check`, with isolated roots and committed fingerprints, exits 0: `PRIVACY GATE: PASS`. This includes commit identities/messages and all changed publication paths.
