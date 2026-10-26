# Historical frontend and Claude-spawn verification

Starting commit: `a9e60a0d55c76c0b6b15b9134506e3feace8eeca`. Bun 1.4.0.

Every historical F→F frontend path was run whole, excluding the three requested files: `LogFeed.deliveryUncertainty`, `TmuxComposer.runtimeSnapshot`, and `Viewer.switching`. This deliberately includes historical rows already repaired by intervening commits. The six related spawn paths and both other test callers of the modified writer fixture were also run whole.

All changes are tests or test fixtures. No application runtime, visual implementation, workflow, commit or remote was changed. The initial checkout was clean. The starting-commit comparison used `git stash push -u` and `git stash pop`; both comparisons use fresh isolated HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR for each file, with a temporary copy of bunfig.toml containing no test preload.

Counts below are **pass / fail / skip**. A file with an unmet prerequisite is not reported green.

## Whole-file comparison

| File | Starting commit | Changed tree | Cause |
| --- | --- | --- | --- |
| `src/components/BranchPane.render.test.tsx` | 7 / 0 / 0 | 9 / 0 / 0 | Already fixed on the starting commit; existing whole-file assertions pass. |
| `src/components/BranchPane.spawn.render.test.tsx` | 3 / 0 / 0 | 3 / 0 / 0 | Already fixed on the starting commit; existing whole-file assertions pass. |
| `src/components/BranchPane.stageTitle.render.test.tsx` | 3 / 0 / 0 | 3 / 0 / 0 | Already fixed on the starting commit; existing whole-file assertions pass. |
| `src/components/BranchPane.superseded.render.test.tsx` | 2 / 0 / 0 | 2 / 0 / 0 | Already fixed on the starting commit; existing whole-file assertions pass. |
| `src/components/EffortPills.slot.dom.test.tsx` | 7 / 0 / 0 | 7 / 0 / 0 | Already fixed on the starting commit; existing whole-file assertions pass. |
| `src/components/LogFeed.launchReceiptChip.dom.test.tsx` | 4 / 0 / 0 | 4 / 0 / 0 | Already fixed on the starting commit; existing whole-file assertions pass. |
| `src/components/LogFeed.liveToolRows.dom.test.tsx` | 37 / 0 / 0 | 37 / 0 / 0 | Already fixed on the starting commit; existing whole-file assertions pass. |
| `src/components/LogFeed.outboxTailOrder.dom.test.tsx` | 10 / 0 / 0 | 10 / 0 / 0 | Already fixed on the starting commit; existing whole-file assertions pass. |
| `src/components/LogFeed.spawnPathFlip.dom.test.tsx` | 4 / 0 / 0 | 4 / 0 / 0 | Already fixed on the starting commit; existing whole-file assertions pass. |
| `src/components/TelegramReports.render.test.tsx` | 18 / 0 / 0 | 18 / 0 / 0 | Already fixed on the starting commit; existing whole-file assertions pass. |
| `src/components/TmuxComposer.liveRefreshFocus.dom.test.tsx` | 3 / 5 / 0 | 8 / 0 / 0 | Cold dormant panes no longer mount editors; structured runtime selections restore only while reconfiguration is pending. The negative control must force an unmount because path changes now preserve conversation identity. |
| `src/components/TmuxComposer.staleKey.dom.test.tsx` | 1 / 1 / 0 | 2 / 0 / 0 | The fixture sent its next message before the bounded receipt reconciliation window ended. Use the timing seam, answer keyed admission reads as unknown, wait with a bound for the composer to release the generation (its durable record drops the reconciling marker and the unconfirmed notice shows) instead of sleeping past the window, and retain fresh-key and late-receipt assertions. |
| `src/components/Viewer.test.ts` | 13 / 0 / 0 | 13 / 0 / 0 | Already fixed on the starting commit; existing whole-file assertions pass. |
| `src/components/attention/MobileAttentionSheet.dom.test.tsx` | 17 / 0 / 0 | 17 / 0 / 0 | Already fixed on the starting commit; existing whole-file assertions pass. |
| `src/components/externalRelay/ExternalRelaySection.dom.test.tsx` | 31 / 0 / 0 | 31 / 0 / 0 | Already fixed on the starting commit; existing whole-file assertions pass. |
| `src/components/feed/senderLine.dom.test.tsx` | 5 / 0 / 0 | 5 / 0 / 0 | Already fixed on the starting commit; existing whole-file assertions pass. |
| `src/components/flows/RoundDeck.strip.dom.test.tsx` | 0 / 3 / 0 | 3 / 0 / 0 | The DOM fixture omitted requestAnimationFrame and cancelAnimationFrame. |
| `src/components/kanban/KanbanBoard.dom.test.tsx` | 18 / 2 / 0 | 20 / 0 / 0 | An earlier test left a pointer-down gesture open. Send pointer-up before remounting; otherwise later clicks are suppressed within the file. |
| `src/components/kanban/KanbanEditing.dom.test.tsx` | 28 / 0 / 0 | 28 / 0 / 0 | Already fixed on the starting commit; existing whole-file assertions pass. |
| `src/components/kanban/KanbanOpenableConversations.dom.test.tsx` | 6 / 1 / 0 | 7 / 0 / 0 | The launch view now exposes a bounded failure explanation; the row still checks the original error verbatim and the view checks its failed first-message state. |
| `src/components/layers.test.ts` | 9 / 0 / 0 | 9 / 0 / 0 | Already fixed on the starting commit; existing whole-file assertions pass. |
| `src/components/mobile/MobileFocusView.keyboardInset.dom.test.tsx` | 4 / 2 / 0 | 6 / 0 / 0 | Bare happy-dom has no IndexedDB or Web Locks, so the composer could not persist the draft and mounted its storage-failure alert, whose region reserve shrank the field. Install the existing composer storage double, keep the 160px ceilings, and assert that no alert renders (corrected in re-verification, below). |
| `src/components/mobile/MobileFocusView.strip.dom.test.tsx` | 0 / 1 / 0 | 1 / 0 / 0 | The DOM fixture omitted animation-frame APIs. |
| `src/components/mobile/mobileHeaderFit.dom.test.tsx` | 1 / 5 / 0 | 6 / 0 / 0 | The old five-button header was replaced by the three-control shell. Exercise the real title switcher, board/catalog menu, search and wake-lock switch; reset navigation and board stores and supply current settings response shapes. |
| `src/components/mobile/phoneKanbanModel.test.ts` | 21 / 0 / 0 | 21 / 0 / 0 | Already fixed on the starting commit; existing whole-file assertions pass. |
| `src/components/orchestrator/OrchestratorPanel.dom.test.tsx` | 78 / 0 / 0 | 78 / 0 / 0 | Already fixed on the starting commit; existing whole-file assertions pass. |
| `src/components/orchestrator/seatState.test.ts` | 69 / 0 / 0 | 69 / 0 / 0 | Already fixed on the starting commit; existing whole-file assertions pass. |
| `src/components/scheme/SchemeOverlay.strip.dom.test.tsx` | 0 / 1 / 0 | 1 / 0 / 0 | The DOM fixture omitted animation-frame APIs. |
| `src/components/scheme/nodes.dom.test.tsx` | 6 / 0 / 0 | 6 / 0 / 0 | Already fixed on the starting commit; existing whole-file assertions pass. |
| `src/components/scheme/nodes.stageRow.dom.test.tsx` | 6 / 1 / 0 | 7 / 0 / 0 | The DOM fixture omitted animation-frame APIs. |
| `src/components/scheme/nodes.strip.dom.test.tsx` | 0 / 3 / 0 | 3 / 0 / 0 | The DOM fixture omitted animation-frame APIs; the root-interrupt explanation moved from visible text into the accessible control label. |
| `src/lib/accounts/claudeProvider.test.ts` | 20 / 0 / 0 | 20 / 0 / 0 | Already fixed on the starting commit; existing whole-file assertions pass. |
| `src/lib/agent/cli.test.ts` | 52 / 1 / 0 | 53 / 0 / 0 | The unsafe-permissions fixture requested mode 0644 at creation, which umask reduced to 0600. Explicit chmod and an exact mode assertion restore the intended security test. Not reproduced on the gate runner, where the starting file passes under umask 022 and 077; the change only makes the precondition explicit. |
| `src/lib/reaperRuntime.test.ts` | 52 / 0 / 10 | 52 / 0 / 10 | Already fixed on the starting commit; existing whole-file assertions pass. |
| `src/lib/telegram/reportRunner.test.ts` | 53 / 0 / 0 | 53 / 0 / 0 | Already fixed on the starting commit; existing whole-file assertions pass. |
| `src/lib/mcp/writerConcurrency.test.ts` | 3 / 2 / 1 | 4 / 1 / 1 | The lease fixture treated a truthy StateLockHolder as acquisition success. Compare explicitly with true and assert that the waiting peer cannot replace the original owner. The pipeline-start case separately requires a real Claude executable. |
| `src/lib/runtime/legacyClaudeRecovery.cleanCi.integration.test.ts` | 0 / 1 / 0 | 2 / 0 / 0 | The fake Claude stream rejected initialize and mcp_status control frames. Discovery before launch dates to `92b2548f9`. A new handshake regression fails first; the fixture now acknowledges discovery without recording a user delivery. |

Primary selection total: **591 / 29 / 11 → 622 / 1 / 11**.

## Cases that were red

| File | Case | Before | After | Cause |
| --- | --- | --- | --- |
| `src/components/TmuxComposer.liveRefreshFocus.dom.test.tsx` | [desktop] a board/feed refresh mid-IME-composition never wipes the composing word or moves the caret (real owner, node identity held) | fail | pass | Cold dormant panes no longer mount editors; structured runtime selections restore only while reconfiguration is pending. The negative control must force an unmount because path changes now preserve conversation identity. |
| `src/components/TmuxComposer.liveRefreshFocus.dom.test.tsx` | [desktop] a mid-string selection, focus, draft, attachments, and runtime choice survive a surface-resolving refresh (real owner) | fail | pass | Cold dormant panes no longer mount editors; structured runtime selections restore only while reconfiguration is pending. The negative control must force an unmount because path changes now preserve conversation identity. |
| `src/components/TmuxComposer.liveRefreshFocus.dom.test.tsx` | [390px mobile] a mid-string selection, focus, draft, attachments, and runtime choice survive a surface-resolving refresh (real owner) | fail | pass | Cold dormant panes no longer mount editors; structured runtime selections restore only while reconfiguration is pending. The negative control must force an unmount because path changes now preserve conversation identity. |
| `src/components/TmuxComposer.liveRefreshFocus.dom.test.tsx` | [desktop] a background board reorder keeps focus, caret, and the textarea node on the typed pane (real NodesLayer keying) | fail | pass | Cold dormant panes no longer mount editors; structured runtime selections restore only while reconfiguration is pending. The negative control must force an unmount because path changes now preserve conversation identity. |
| `src/components/TmuxComposer.liveRefreshFocus.dom.test.tsx` | [negative control] the reenacted historical remount mutation turns the identity assertion RED | fail | pass | Cold dormant panes no longer mount editors; structured runtime selections restore only while reconfiguration is pending. The negative control must force an unmount because path changes now preserve conversation identity. |
| `src/components/TmuxComposer.staleKey.dom.test.tsx` | a remount cannot stamp a stale unresolved generation's key onto the operator's new message | fail | pass | The fixture sent its next message before the bounded receipt reconciliation window ended. Use the timing seam, answer keyed admission reads as unknown, wait with a bound for the composer to release the generation (its durable record drops the reconciling marker and the unconfirmed notice shows) instead of sleeping past the window, and retain fresh-key and late-receipt assertions. |
| `src/components/flows/RoundDeck.strip.dom.test.tsx` | an in-progress round mounts the strip (live-subagent) above a composer | fail | pass | The DOM fixture omitted requestAnimationFrame and cancelAnimationFrame. |
| `src/components/flows/RoundDeck.strip.dom.test.tsx` | a finished round keeps the strip but drops the composer | fail | pass | The DOM fixture omitted requestAnimationFrame and cancelAnimationFrame. |
| `src/components/flows/RoundDeck.strip.dom.test.tsx` | a headless flow drops the composer even for an in-progress round | fail | pass | The DOM fixture omitted requestAnimationFrame and cancelAnimationFrame. |
| `src/components/kanban/KanbanBoard.dom.test.tsx` | the mouse resting in a narrow column widens it after the dwell, with the cue on the way; a menu or a pin holds it | fail | pass | An earlier test left a pointer-down gesture open. Send pointer-up before remounting; otherwise later clicks are suppressed within the file. |
| `src/components/kanban/KanbanBoard.dom.test.tsx` | on a large screen a project board balances its columns; narrow, scroll, tabs and the Overview keep theirs | fail | pass | An earlier test left a pointer-down gesture open. Send pointer-up before remounting; otherwise later clicks are suppressed within the file. |
| `src/components/kanban/KanbanOpenableConversations.dom.test.tsx` | a failed launch shows at once with its error, opens its launch view, and counts as no conversation | fail | pass | The launch view now exposes a bounded failure explanation; the row still checks the original error verbatim and the view checks its failed first-message state. |
| `src/components/mobile/MobileFocusView.keyboardInset.dom.test.tsx` | integrated, portrait keyboard: long draft caps at 160px and the chrome fits (#983 round 2) | fail | pass | Bare happy-dom has no IndexedDB or Web Locks, so the composer could not persist the draft and mounted its storage-failure alert, whose region reserve shrank the field. Install the existing composer storage double, keep the 160px ceilings, and assert that no alert renders (corrected in re-verification, below). |
| `src/components/mobile/MobileFocusView.keyboardInset.dom.test.tsx` | integrated, a 280px visible viewport: the whole composer unit still fits it (#983 round 2, #1483) | fail | pass | Bare happy-dom has no IndexedDB or Web Locks, so the composer could not persist the draft and mounted its storage-failure alert, whose region reserve shrank the field. Install the existing composer storage double, keep the 160px ceilings, and assert that no alert renders (corrected in re-verification, below). |
| `src/components/mobile/MobileFocusView.strip.dom.test.tsx` | the phone renders no inline control strip: every control is a labelled 44 px row in the conversation menu | fail | pass | The DOM fixture omitted animation-frame APIs. |
| `src/components/mobile/mobileHeaderFit.dom.test.tsx` | the 390px header row keeps one elastic cell — the project name — and fixed 44px targets (#613) | fail | pass | The old five-button header was replaced by the three-control shell. Exercise the real title switcher, board/catalog menu, search and wake-lock switch; reset navigation and board stores and supply current settings response shapes. |
| `src/components/mobile/mobileHeaderFit.dom.test.tsx` | both board faces stay one tap away inside the «more» menu and still switch the board (#613) | fail | pass | The old five-button header was replaced by the three-control shell. Exercise the real title switcher, board/catalog menu, search and wake-lock switch; reset navigation and board stores and supply current settings response shapes. |
| `src/components/mobile/mobileHeaderFit.dom.test.tsx` | Undo and Redo are not «⋯» items, even with a close in the device-local log (#1801; kanban undo is #1856) | fail | pass | The old five-button header was replaced by the three-control shell. Exercise the real title switcher, board/catalog menu, search and wake-lock switch; reset navigation and board stores and supply current settings response shapes. |
| `src/components/mobile/mobileHeaderFit.dom.test.tsx` | «Keep screen awake» is on the «⋯» menu's Settings page and holds a real sentinel (#712) | fail | pass | The old five-button header was replaced by the three-control shell. Exercise the real title switcher, board/catalog menu, search and wake-lock switch; reset navigation and board stores and supply current settings response shapes. |
| `src/components/mobile/mobileHeaderFit.dom.test.tsx` | the wake-lock row never becomes a sixth 44px target on the header row (#712) | fail | pass | The old five-button header was replaced by the three-control shell. Exercise the real title switcher, board/catalog menu, search and wake-lock switch; reset navigation and board stores and supply current settings response shapes. |
| `src/components/scheme/SchemeOverlay.strip.dom.test.tsx` | the overlay resolves the node and mounts an expanded strip (live-subagent) with a composer | fail | pass | The DOM fixture omitted animation-frame APIs. |
| `src/components/scheme/nodes.stageRow.dom.test.tsx` | a live stage pane is titled role · stage · position, never the prompt's shared preamble | fail | pass | The DOM fixture omitted animation-frame APIs. |
| `src/components/scheme/nodes.strip.dom.test.tsx` | a scheme node mounts the strip: live-root for the running root | fail | pass | The DOM fixture omitted animation-frame APIs; the root-interrupt explanation moved from visible text into the accessible control label. |
| `src/components/scheme/nodes.strip.dom.test.tsx` | a scheme node classifies a scanner-shaped subagent from its live structured root | fail | pass | The DOM fixture omitted animation-frame APIs; the root-interrupt explanation moved from visible text into the accessible control label. |
| `src/components/scheme/nodes.strip.dom.test.tsx` | dormant far-zoom scheme nodes render no control strip; active nodes restore it | fail | pass | The DOM fixture omitted animation-frame APIs; the root-interrupt explanation moved from visible text into the accessible control label. |
| `src/lib/agent/cli.test.ts` | Telegram grants load the connector token only into granted CLI processes | fail | pass | The unsafe-permissions fixture requested mode 0644 at creation, which umask reduced to 0600. Explicit chmod and an exact mode assertion restore the intended security test. Not reproduced on the gate runner, where the starting file passes under umask 022 and 077; the change only makes the precondition explicit. |
| `src/lib/mcp/writerConcurrency.test.ts` | Viewer HTTP pipeline start and standalone MCP pipeline_action serialize across processes | fail | leave: real Claude executable required | The lease fixture treated a truthy StateLockHolder as acquisition success. Compare explicitly with true and assert that the waiting peer cannot replace the original owner. The pipeline-start case separately requires a real Claude executable. |
| `src/lib/mcp/writerConcurrency.test.ts` | an aged live writer without process identity retains the transaction until release | fail | pass | The lease fixture treated a truthy StateLockHolder as acquisition success. Compare explicitly with true and assert that the waiting peer cannot replace the original owner. The pipeline-start case separately requires a real Claude executable. |
| `src/lib/runtime/legacyClaudeRecovery.cleanCi.integration.test.ts` | production acceptance recovers a lifecycle-busy legacy Fable tail from a stale registering projection through MCP | fail | pass | The fake Claude stream rejected initialize and mcp_status control frames. Discovery before launch dates to `92b2548f9`. A new handshake regression fails first; the fixture now acknowledges discovery without recording a user delivery. |

The new recovery-discovery test was run red before the fixture correction: the whole file had **0 pass / 2 fail**. After correction it has **2 pass / 0 fail**. The writer-owner assertion was added before correcting the lease return-value check; its isolated case failed waiting for the barrier, then passed with the original lease owner still recorded. The SSR pinning cases add two passing tests for the already-fixed null snapshot.

## Other callers and prerequisite limits

| File | Starting commit | Changed tree | Remaining case / interpretation |
| --- | --- | --- | --- |
| `src/lib/mcp/taskExecutor.test.ts` | 29 / 2 / 0 | 29 / 2 / 0 | Both `hard Viewer death ends its actual task executor and guardian within three seconds` variants fail during unguarded process-tree discovery when a descendant exits. These are unchanged caller failures outside the historical selection; no containment-only claim is made. |
| `src/lib/mcp/largeReads.test.ts` | 11 / 1 / 0 | 11 / 1 / 0 | `the stdio entry’s eager imports cannot load Viewer caches or local bindings` reaches the registry import. This unchanged import-contract failure is outside the historical selection. |

The pipeline concurrency case `Viewer HTTP pipeline start and standalone MCP pipeline_action serialize across processes` refuses with `ENGINE_NOT_CONNECTED` / `cli-missing`; it needs a real Claude executable and is left unchanged. Existing reaper and writer skips remain skips.

Additional exploratory whole-file runs, outside the inventory selection, were not silently folded into the totals:

| File | Pass / fail / skip | Observation |
| --- | --- | --- | --- |
| `src/lib/agent/spawnCommand.contention.test.ts` | 9 / 6 / 0 | Six unrelated admission/CLI-fixture failures; no changes to this file. |
| `src/lib/agent/spawnCommand.locale.test.ts` | 1 / 0 / 0 | Passes unchanged. |
| `src/lib/agent/spawnCommand.telegram.test.ts` | 33 / 37 / 0 | Production-builder and CLI-fixture failures in this broader suite; no claim that all are containment-only. |
| `src/lib/runtime/structuredSpawn.integration.test.ts` | 140 / 2 / 0 | The terminal-orphan resume case and partial-kill retry case fail around host ownership/termination. This container lacks the requested owned-runner containment, so these lifecycle cases are left for that runner; this run does not establish a product regression. |

The unchanged structured-spawn file was also repeated on the starting commit: **140 pass / 2 fail** on both runs. The unresolved lifecycle probes are named exactly:

- `a resume ends a terminal-row orphan's detached writer before the new host starts`
- `a partial structured kill retains child identity across a root-dead retry`

Both are left for an owned-runner check. The observed failures concern host claims and process termination; without that check, neither is established as a product regression or as caused only by missing containment.

## Commands and results

Each listed file used `bun --config="$verification_config" test "./$file"`, with the temporary configuration and isolated directories described above. The runner’s own exit is not a test verdict; the table records each Bun process result.

| Command / selection | Exit code(s) | Result |
| --- | --- | --- |
| Whole-file primary selection, starting commit | 0 for passing files; 1 for red files | 591 / 29 / 11 |
| Whole-file primary selection, changed tree | 0 except the real-Claude prerequisite file (1) | 622 / 1 / 11 |
| All 39 comparison files, starting commit | 0 / 1 as recorded above | 631 / 32 / 11 |
| All 39 comparison files, changed tree | 0 / 1 as recorded above | 662 / 4 / 11 |
| `NODE_OPTIONS=--max-old-space-size=8192 bun x tsc --noEmit` | 0 | pass |
| `bun x eslint` on all touched TypeScript files | 0 | no errors or warnings |
| `git diff --check` | 0 | pass |

No browser driver was needed: visual production code was unchanged; the phone assertions were updated to the already-shipped shell and exact current sizing rules. No assertions or timing budgets in production were relaxed.

## Files changed

- `src/components/BranchPane.render.test.tsx`
- `src/components/TmuxComposer.liveRefreshFocus.dom.test.tsx`
- `src/components/TmuxComposer.staleKey.dom.test.tsx`
- `src/components/flows/RoundDeck.strip.dom.test.tsx`
- `src/components/kanban/KanbanBoard.dom.test.tsx`
- `src/components/kanban/KanbanOpenableConversations.dom.test.tsx`
- `src/components/mobile/MobileFocusView.keyboardInset.dom.test.tsx`
- `src/components/mobile/MobileFocusView.strip.dom.test.tsx`
- `src/components/mobile/mobileHeaderFit.dom.test.tsx`
- `src/components/scheme/SchemeOverlay.strip.dom.test.tsx`
- `src/components/scheme/nodes.stageRow.dom.test.tsx`
- `src/components/scheme/nodes.strip.dom.test.tsx`
- `src/lib/agent/cli.test.ts`
- `src/lib/mcp/writerConcurrency.test.ts`
- `src/lib/mcp/writerConcurrencyChild.ts`
- `src/lib/runtime/fixtures/claude-stream-json-recovery.ts`
- `src/lib/runtime/legacyClaudeRecovery.cleanCi.integration.test.ts`

## Re-verification on a later main (2026-10-24)

Both Cloud patches (`45.diff`, the deferred DOM files, and `46.diff`, this
document) were applied unchanged to main at `a3d27b76a`, which differs from the
Cloud starting commit in no touched file. Every touched test file was then run
whole in its own `bun test` process on the gate runner (Bun 1.4.0, the
repository's `bunfig.toml` with its test preload), each run under fresh `HOME`,
`XDG_CONFIG_HOME`, `LLV_STATE_DIR` and `TMPDIR`, three times on main and three
times on the branch. All three runs of each file agreed on both sides.

Two Cloud changes were corrected here:

- `src/components/mobile/MobileFocusView.keyboardInset.dom.test.tsx`: the Cloud
  change replaced the 160px ceilings with 143px and 67px. Those numbers were
  the storage-failure alert's region reserve: zeroing that one surface in the
  composer returned both fields to 160px, while removing the transcript-floor
  budget and the navigation row changed nothing. The fixture now installs
  `src/test-helpers/composerStorage.ts`, keeps the original 160px expectations
  and asserts that no alert renders.
- `src/lib/runtime/legacyClaudeRecovery.cleanCi.integration.test.ts`: the new
  discovery case waited one timer tick before reading the fixture's answers; it
  now waits, bounded, for both answers.

### Commits behind changed expectations

"Parent / commit" runs the test file as it stood at the commit's parent,
filtered to the named case, on both trees. A bisect ran `git bisect run` with
the stated test between the named good commit and `a3d27b76a` on the gate runner.

| File and change | Commit | Evidence |
| --- | --- | --- |
| `mobileHeaderFit.dom.test.tsx`: the five-button header became the three-control bar | `21932da6a` | Parent / commit: 5 / 0 then 0 / 5; the commit removes `mobile-project-header` from the dashboard. |
| `TmuxComposer.liveRefreshFocus.dom.test.tsx`: the fixture renders active panes | `c2007627f` | Parent / commit on the board/feed refresh case: 1 / 0 then 0 / 1; a dormant node no longer mounts its composer. |
| `TmuxComposer.liveRefreshFocus.dom.test.tsx`: the negative control unmounts explicitly | `c2007627f` | Parent / commit on the negative control: 1 / 0 then 0 / 1; `NodeShell` is keyed by conversation identity. |
| `TmuxComposer.liveRefreshFocus.dom.test.tsx`: the stored runtime choice is a pending reconfigure | `71518ab12`, `b6609ca96` | `RuntimePill.tsx` drops a structured pill's stored selection unless an apply is in flight. Without the pending phase the two runtime cases fail; disabling that drop makes all 8 pass. |
| `TmuxComposer.liveRefreshFocus.dom.test.tsx`: the reverted default is `GPT-6.1-Sol` | `311e47fd1` | `defaultModelFor("codex")` returns `gpt-6.1-sol` from this commit. |
| `KanbanOpenableConversations.dom.test.tsx`: the launch view states the failure | `71518ab12` | Bisect of the case from `71eeb57ed`; the commit replaces the raw launch error with one sentence and keeps the reason in `title`. |
| `nodes.strip.dom.test.tsx`: the root-interrupt note is read from the accessible label | `72154d4ae` | Parent / commit: 1 / 0 then 0 / 1; `Hint` renders its bubble only while hovered or focused. |
| `TmuxComposer.staleKey.dom.test.tsx`: the next message leaves after bounded reconciliation | `864a1630e` | Bisect of the starting file from `bf60e71d6`. |
| `writerConcurrencyChild.ts`: a lease is acquired only when the result is `true` | `91e4dd841` | Bisect of the aged-writer case from `a918e6b85`; `tryAcquireLease` returns `true` or a holder object. |
| `fixtures/claude-stream-json-recovery.ts`: the fake stream answers discovery | `92b2548f9` | Parent / commit on the production-acceptance case: 1 / 0 then 0 / 1. |

The other changes add fixtures (animation frames, a closed pointer gesture, an
explicit file mode) or new cases and change no expectation.

### Whole-file runs on `a3d27b76a`

Counts are pass / fail / skip for each of the three runs.

| File | Main | Branch |
| --- | --- | --- |
| `src/components/BranchPane.render.test.tsx` | 7 / 0 / 0 ×3 | 9 / 0 / 0 ×3 |
| `src/components/TmuxComposer.liveRefreshFocus.dom.test.tsx` | 3 / 5 / 0 ×3 | 8 / 0 / 0 ×3 |
| `src/components/TmuxComposer.staleKey.dom.test.tsx` | 1 / 1 / 0 ×3 | 2 / 0 / 0 ×3 |
| `src/components/flows/RoundDeck.strip.dom.test.tsx` | 0 / 3 / 0 ×3 | 3 / 0 / 0 ×3 |
| `src/components/kanban/KanbanBoard.dom.test.tsx` | 18 / 2 / 0 ×3 | 20 / 0 / 0 ×3 |
| `src/components/kanban/KanbanOpenableConversations.dom.test.tsx` | 6 / 1 / 0 ×3 | 7 / 0 / 0 ×3 |
| `src/components/mobile/MobileFocusView.keyboardInset.dom.test.tsx` | 4 / 2 / 0 ×3 | 6 / 0 / 0 ×3 |
| `src/components/mobile/MobileFocusView.strip.dom.test.tsx` | 0 / 1 / 0 ×3 | 1 / 0 / 0 ×3 |
| `src/components/mobile/mobileHeaderFit.dom.test.tsx` | 1 / 5 / 0 ×3 | 6 / 0 / 0 ×3 |
| `src/components/scheme/SchemeOverlay.strip.dom.test.tsx` | 0 / 1 / 0 ×3 | 1 / 0 / 0 ×3 |
| `src/components/scheme/nodes.stageRow.dom.test.tsx` | 6 / 1 / 0 ×3 | 7 / 0 / 0 ×3 |
| `src/components/scheme/nodes.strip.dom.test.tsx` | 0 / 3 / 0 ×3 | 3 / 0 / 0 ×3 |
| `src/lib/agent/cli.test.ts` | 53 / 0 / 0 ×3 | 53 / 0 / 0 ×3 |
| `src/lib/mcp/writerConcurrency.test.ts` | 3 / 2 / 1 ×3 | 4 / 1 / 1 ×3 |
| `src/lib/runtime/legacyClaudeRecovery.cleanCi.integration.test.ts` | 0 / 1 / 0 ×3 | 2 / 0 / 0 ×3 |

The one remaining branch failure is the pipeline-start case in
`writerConcurrency.test.ts`, which refuses with `ENGINE_NOT_CONNECTED` /
`cli-missing` on both trees because the runner has no signed-in Claude
executable. It is neither skipped nor changed.
