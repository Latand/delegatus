# Optimistic UI audit: every action in the Viewer

> **Operator requirement, 2026-10-16 (voice, relayed; quoted from the pinned
> specification of this lane):** "actions and UI changes are applied
> optimistically and fast by default; non-optimistic behaviour is allowed only
> for errors or edge cases that do not fit; this is a standing rule for the
> project's UI."
>
> **Decision form answered 2026-10-16 (12:26 UTC):** «Сначала аудит всех
> действий в UI, потом общая линия по исправлению».
>
> **Standing project rule:** `r_4dccc4825132f0f9`.

This document is the audit the decision asked for. It changes no product code.
The fix line it proposes is section 8.

## 1. The requirement as the operator said it

The specification quotes the voice gateway's rendering. The operator's own
words are in the call journal (the voice companion's
`voice-companion/transcripts/<session>.jsonl` under the installation state
directory; the call began 12:06 UTC). They are paraphrased here because the
call is private:

- The trigger was one button the operator pressed that stayed on screen for a
  long time afterwards. The gateway rendered its name as an unclear
  transcription; a minute later in the same call the operator said that the
  name is Ukrainian and means «Надіслати» (Send). Section 7 identifies the
  button.
- The rule itself matches the gateway's rendering: every action is optimistic
  and fast by default; something else only when an error or an edge case does
  not fit that logic.

**Difference between the rendering and the words.** The rendering asked to
"handle the rollback or the exceptional case correctly" for that one button and
called its name unclear. The operator's words name the button by its label and
make no further scope change. This audit designs from the words: the default is
optimism everywhere, and every remaining wait in section 5 names its reason.

**Validation against the quote.** Every action that writes to the server is in
section 5 with its class, each control row carrying its own reason rather than
inheriting a neighbour's exemption; every class B entry in section 6 says what changes at
once, what rolls back and where the error shows; every class C entry names
irreversible, server-computed or conflict. Section 8 is one fix line, as the
decision asked.

## 2. Summary

- **Inventory:** 136 rows in section 5. 128 of them reach the server (a row
  groups presses that share one handler and one outcome); 8 are local actions
  on the same surfaces, kept for completeness. They come from 329 reachable
  components with about 1,350 event-handler attributes. A verifier pass found
  rows that had been folded into a neighbour's exemption (the external-relay
  controls, Copilot account selection, the linked-install sharing switches,
  provider key saves, team profile edits, the Telegram Off choice, the update
  check); each now has its own row and class. Handlers not in the tables
  change only browser state and are immediate by construction (section 5.9).
  Fourteen mutation-bearing component files are unreachable from any page and
  are excluded (section 5.10).
- **Classes:** 43 rows **A** (already optimistic, or local), 44 rows **B**
  (should become optimistic; 36 changes, B1–B36), 48 rows **C** (legitimately
  wait, reason named), and one row (L5) that takes the class of the lane action
  it sends. The counts are computed from the section 5 tables by the script in
  section 11.
- **The busiest surfaces mostly conform already.** Kanban card moves, edits,
  colour, priority, icon, hide and dismiss; the Waiting-for-you dismissals and
  Done acceptance; the «Рішення» column's answers; composer sends; account and
  model switches; most project toggles. They use the overlays listed in
  section 4.
- **What waits today and should not:** the voice companion's
  «Надіслати» on a proposal (the likely trigger, section 7), answers to agent
  questions in the feed («Надіслати», up to 10 s of "Sending…"), permission
  Allow/Deny, the prototype review window's save, lane pause/resume and the
  "finishes the task" check, link/unlink, show-on-board, launch-row dismissal,
  new tasks, conversation rename, Undo of an edit still being written, and
  about twenty settings, account, team and relay rows.
- **Why it matters here:** the production Viewer logged 9,830 event-loop
  gaps of 0.5 s or more, 4,792 longer than 1 s and 2,913 longer than 3 s
  (max 19.2 s) between 2026-10-15 21:00 UTC and 2026-10-16 12:44 UTC
  (section 3). Any button that
  waits for an answer waits through those gaps.
- **Mechanism:** reuse the existing overlays; add one small primitive
  (`revertTaskSnapshot`) and an optional predicted record on the kanban
  pipeline port. No new optimistic library (section 8).

## 3. Method, sources and limits

**Revision.** Source read at `02f9301fc32370210a4af533c1204741c6436f52`
(`main`, the pipeline's start). Every `file:line` below is at that revision.

**What counts as an action.** A press, drag, swipe, toggle, menu item, form
submit or keyboard command an operator makes in the Viewer UI. Background
traffic (presence beacons, log and host-target polls, the board-presence `HEAD`,
the task album's "seen" bookkeeping, the setup guide's initial marker) is not an
action and is listed only in section 5.9.

**How the inventory was built.**

1. Every client `fetch(` with a write method in `src/components`, `src/hooks`
   and `src/app` (outside `src/app/api`): 114 sites, plus every wrapper that
   issues writes through its own fetcher (`taskApi.ts` `request`,
   `useEngineAccounts.ts` `fetcher`, `useBoardState.ts`, `dismissalOverlay.ts`,
   `kanbanAssignments.ts`, `useRuntime.ts` `postCommand`, `relayUi.tsx` `call`,
   `team/ui.tsx` `teamRequest`, the voice companion adapter).
2. Every component that sets a busy, saving, pending, sending or submitting
   state (66 files), to catch waits that sit behind a wrapper.
3. Each write site was traced to the handler the operator triggers and read in
   full: what the UI shows before the request, during it, after success and
   after failure.
4. Reachability: an import-graph walk from every `src/app/**/page.tsx`,
   `layout.tsx` and `route.ts`, `src/instrumentation.ts` and `src/proxy.ts`.
   Reachable means imported by a page; a reachable component that no current
   view renders would still be listed.

**Latency.** "Measured" cites a committed measurement or the production log;
"est." is derived from the route's code path and has no timing of its own. The
Viewer logs no per-request durations, so route latencies in production cannot be
measured without a new instrument (deferred, section 10). The common context:

| Evidence | Value | Source |
|---|---:|---|
| Viewer loop gaps ≥ 0.5 s (17 of them exactly 500 ms), 2026-10-15 21:00:03Z – 2026-10-16 12:44:35Z (three Viewer processes across deploys) | 9,830 | `journalctl --user -u delegatus.service --since "2026-10-15 21:00:03 UTC" --until "2026-10-16 12:44:35 UTC" -g "viewer loop-gap" -o cat`, each JSON record decoded, filtered to `role:"viewer"` and counted by `gapMs`; read-only (9,813 are > 500 ms) |
| … of which > 1 s / > 3 s | 4,792 / 2,913 | same |
| Longest gap in that window | 19,220 ms | same |
| Gaps > 1 s in the 2026-10-14 production window; longest | 147; 37,306 ms | `docs/design/viewer-stalls-2026-10-14.md` |
| A synchronous `state.sqlite` lock wait blocking the loop (replayed) | 30,600 ms | `docs/perf/state-db-lock-waits.md` |
| Composer: click → optimistic message row, p50 / p95 | 29 / 33 ms | `docs/design/send-latency-and-message-states.md`, 2026-10-15 isolated runs |
| Composer: click → canonical row, p50 / p95 | 92–93 / 111–123 ms | same |
| Voice companion, the call in which the button was pressed (section 7): an auto-sent request `sending` → `queued` / `queued` → `delivered` | 2.58 s / 13.3 s | call journal `request.states`, 2026-10-16 ~11:48 UTC |
| `/api/answer` confirmation wait | up to 10,000 ms, polled every 500 ms | `src/app/api/answer/route.ts:19`, `:20`, `:105` |

**Not done.** No browser was driven and nothing was rendered: the audit changes
no UI. No request was sent to the operator's running Delegatus. Where behaviour
is unclear from code, section 9 says so.

## 4. Optimistic mechanisms that exist today

| # | Mechanism | Where | What it does | Used by |
|---|---|---|---|---|
| M1 | Task mutation controller | `src/components/kanban/useTaskMutations.ts` (header :12–:60; per-field `drawnTasks` :174) | Draws a status move or field edit at once, writes it with the task's revision as a guard, one write per task in flight, reads the stored row on 409 and settles, retries, rebases text, or reports a conflict; undo/redo fenced on the board's own revision | Kanban and phone card moves, title/description/details, colour, priority, icon, group hide |
| M2 | Pipeline snapshot overlay | `src/hooks/useFiles.ts:1192` `applyPipelineSnapshot(p, false)`, `:1220` `revertPipelineSnapshot`; `src/components/pipelines/pipelineModel.ts:1698` `patchPipeline(…, optimistic)` | Applies a predicted pipeline record to the client cache before the PATCH, confirms with the echo, reverts on failure | Stage remove/reorder, edge wiring, phone "show lane again"; **not** the kanban lane actions, which use `pipelinePorts.ts:57` without a prediction |
| M3 | Attention dismissal layer | `src/components/attention/dismissalOverlay.ts:231` `sendDismissal`; Done layer `doneItems.ts:70` | Layers the dismissal over the polled lists at once (30 s bound), replaces it with the server's instant, removes it and returns the error on refusal | Needs-you dismiss/undo, card flag dismiss, report-log resolve, prototype hide, Done accept |
| M4 | Board-preferences outbox | `src/hooks/useBoardState.ts:739` `mutate` | Applies board mutations locally, drains an outbox with backoff and conflict replay | Close/restore conversation on the board, favourites, view mode, engine tray folds |
| M5 | Composer outbox | `src/components/TmuxComposer.tsx:3441` `queueSubmit` → `enqueueOutbox` `:3517` | Places the message bubble at once; the bubble carries delivery state, failure and Retry | Every composer send, quick acknowledgement, outbox Retry |
| M6 | Decision answers leave at once | `src/components/decisions/useOperatorDecisions.ts:68`, drafts `:21` | Hides the answered form while its POST runs; a refusal brings it back from the kept draft with the server's reason | «Рішення» column answers |
| M7 | Inline setting toggle | `src/components/MergeOnReviewRow.tsx:64`, `asksYouSetting.ts:78`, `reportLog/bridgeReportsSetting.ts:86` | Publishes the new value, writes, restores the old value and marks the row failed on refusal | Three project toggles |

#2747 added a server-side counterpart: the decision route answers once the
decision is durably recorded and delivers it to the seat in the background. The
client of the review window still waits for that durable write
(`src/hooks/usePrototypeReview.ts:77`; the comment above
`optimisticPrototypeRead` at `:42` records the reason chosen then).

## 5. Inventory

Columns: **Now** is what the operator sees between the press and the answer.
**Fail** is what happens on refusal or a lost request. **Lat.** is latency.
**Cl.** is the class: A conforms, B should become optimistic (detail in
section 6), C waits with the reason named.

### 5.1 Board cards (desktop kanban and phone)

| # | Action | Handler | Now | Fail | Lat. | Cl. |
|---|---|---|---|---|---|---|
| K1 | Move a card to a column (drag, status menu, `[`/`]`, phone sheet) | `kanban/KanbanBoard.tsx:949` (drag `:1849`, menu `:1412`, keys `:993`); `mobile/MobileKanban.tsx:1030`; `mobile/MobileTaskScreen.tsx:658` | Card moves at once (M1); receipt with Undo | Card returns or goes to the server's column; flash; error receipt with Retry or "Move anyway" | est. one task PATCH | A |
| K2 | Save a hold (blocked reason) | `KanbanBoard.tsx:2725` → move with `hold` | Same as K1 | Same as K1 | est. | A |
| K3 | Undo / Redo (Ctrl+Z, U, receipt) of an edit whose write has been answered | `KanbanBoard.tsx:930` (`applyEntry` at `:941`) | Applied at once, fenced write | Refused task flashes; receipt says why | est. | A |
| K3b | Undo / Redo of an edit whose write is still in flight | `KanbanBoard.tsx:944` (`entry.settled`; `applyEntry` runs at `:941` only after it resolves) | **Waits**: nothing is applied until the original write answers (`if (entry.saved === undefined) void entry.settled.then(answered)`); the card stays in the optimistic destination. A write that did not save is skipped for the next entry | After the answer, as K3 | stalls last as long as the original write (section 3) | **B28** |
| K4 | Rename title, edit description or details inline | `KanbanBoard.tsx:1037` (commit `:1113`); `MobileTaskScreen.tsx:613`, `:621` | New text at once (M1) | Draft kept with Retry/Discard in the card (`kanban/KanbanCard.tsx:782`); a conflict shows theirs and mine (`:803`) | est. | A |
| K5 | Colour, priority, icon | `KanbanBoard.tsx:1185`, `:1203`, `:1221`; `MobileTaskScreen.tsx:676`, `:683` | At once (M1) | Flash + error receipt with Retry | est. | A |
| K6 | Hide a group; hide idle; hide finished; show a hidden group | `KanbanBoard.tsx:1269`, `:1327` (menu `:1434`, `:1442`, divider `:3330`), `:1241`; `MobileKanban.tsx:1051`, `:1059`; `MobileTaskScreen.tsx:699` | At once (M1) | Group comes back; per-task receipt | est. | A |
| K7 | Dismiss a card's flag; Undo | `KanbanBoard.tsx:1300` (`:1321`, `:1322`); `MobileKanban.tsx:1075`; `mobile/MobileRowActions.tsx:51` | At once (M3) | Layer removed; error receipt | est. | A |
| K8 | Show an off-board task on the board | `KanbanBoard.tsx:2534` (tray `kanban/HiddenTray.tsx:75`); `MobileKanban.tsx:1109` | Tray closes; the card appears after the PATCH and the task refetch; receipt after the answer | Error receipt; no card | est. one PATCH + refetch | **B4** |
| K9 | Restore a conversation closed on the board | `KanbanBoard.tsx:2527` (tray `HiddenTray.tsx:90`) → M4 | At once | Outbox retries | est. | A |
| K10 | Close a conversation on the board (reader ⋯) | `KanbanBoard.tsx:1745` → `ProjectDashboard.tsx:1429` (M4) | At once; receipt with Undo | Outbox retries | est. | A |
| K11 | Dismiss a launch that did not start (one / all) | `KanbanBoard.tsx:794` (buttons `KanbanCard.tsx:335`, `:367`) → `kanban/kanbanAssignments.ts:91`, `:102` | Nothing changes until the PATCH and the refetch | Card flashes; **no words** | est. one PATCH per launch, sequential | **B5** |
| K12 | Link a conversation to a task | `KanbanBoard.tsx:1770` (menu `:1716`) → `kanbanAssignments.ts:28` | Nothing moves until the POST and the refetch; receipt after | Error receipt | est. | **B6** |
| K13 | Unlink | `KanbanBoard.tsx:1727` | Same as K12 | 409 explained in a receipt | est. | **B6** |
| K14 | Stop host (two-step confirm) | `kanban/KanbanReaders.tsx:467` (menu `KanbanBoard.tsx:1760`) | Button disabled until the signal answers | Message in the popover | est. | C — irreversible |
| K15 | New task (+ Task in Inbox) | `kanban/KanbanDrafts.tsx:87` → `tasks/useTaskCreateDraft.ts:32` → `tasks/taskApi.ts:88` | Composer busy; the card appears after the answer | Draft kept; error in the composer | est. one store write | **B7** |
| K16 | Account for a conversation or an unstarted stage (account chip) | `kanban/AccountPicker.tsx:517` → `kanban/accountChoice.ts:435`, `:140`; cancel `:386` | Chip shows "→ target, saving" at once | Refusal in the picker; an unanswered write locks the picker (no double send) | est. | A |
| K17 | Ask the orchestrator about this task | `KanbanCard.tsx:1004` → `kanban/askOrchestrator.ts` | Chip attached to the seat composer (local) | — | — | A (local) |
| K18 | Copy link, hand off to composer, add agent, open project/review/seat panel/stages, collapse, open graph | `KanbanBoard.tsx:1699`, `:1708`; `KanbanCard.tsx:960`, `:561`, `:390`, `:620`; `PipelineBlock.tsx:669`, `:686` | Local | — | — | A (local) |

Lane actions in the card menu are in 5.4.

### 5.2 Waiting-for-you

| # | Action | Handler | Now | Fail | Lat. | Cl. |
|---|---|---|---|---|---|---|
| W1 | Dismiss a row, a project section, all; Undo (desktop panel) | `attention/AttentionPanel.tsx:145` (`:188`, `:241`, `:253`), undo `:159` | At once (M3) | Error line in the panel head | est. | A |
| W2 | Dismiss on the phone sheet | `attention/MobileAttentionSheet.tsx:149` (`:194`, `:231`, `:287`) | At once (M3) | Error receipt | est. | A |
| W3 | Done: accept one, a group, all; Undo | `attention/DoneSection.tsx:204` (`:278`, `:344`, `:396`, `:446`; undo `:271`) → `doneItems.ts:70` | At once | Items return; error line | est. | A |
| W4 | Dismiss the arrival toast | `Viewer.tsx:1647` | Local | — | — | A (local) |
| W5 | Allow once / Deny a tool permission | `attention/PermissionActions.tsx:25` (`:62`, `:72`) | Spinner on the pressed button, both disabled; the row leaves only when the host reports the request answered | Error line in the row | est. runtime-host command (3 s RPC deadline) + files poll | **B3** |
| W6 | Answer a decision form («Відповісти», reject) in «Рішення» | `decisions/DecisionCard.tsx:155` (button `:213`) → M6 | Form leaves at once | Form returns with the draft and the reason (`:220`) | est. one durable write | A |
| W7 | Retry delivery / Revoke native access on a decided record in «Рішення» | `decisions/DecisionColumn.tsx:85`, `:87` → `useOperatorDecisions.ts:68` | **The whole record disappears** while the request runs (`useOperatorDecisions.ts:93` hides every id being answered, decided or not), then comes back | Record returns with the error | est. | **B13** |
| W8 | Retry delivery from a decision pointer in a seat conversation | `decisions/DecisionPointer.tsx:59` | Button disabled until the answer | Error under the record | est. | **B14** |
| W9 | Update decision: Deploy now | `selfUpdate/AutoDrainDecision.tsx:17` | Pending until the answer | "Superseded" / "failed" in place | est. | C — irreversible (starts the release switch) |
| W10 | Update decision: Keep waiting | same | Pending until the answer | same | est. | **B15** |
| W11 | Resolve a seat's question in the report log; undo | `orchestrator/reportLog/ReportLog.tsx:164` | At once (M3) | Layer removed | est. | A |
| W12 | Open a prototype notice or a card's review button | `prototypeReview/PrototypeNoticeRow.tsx:33`; `PrototypeReviewButton.tsx:53` | Navigation | — | — | A (local) |
| W13 | Return from a followed attention request | `attention/AttentionHost.tsx:355` | Viewport restored first; the record is written after | Control stays for a second press | est. | A |

### 5.3 Composer and conversation

| # | Action | Handler | Now | Fail | Lat. | Cl. |
|---|---|---|---|---|---|---|
| C1 | Send a message (Enter, button, quick "yes, continue", steer while running) | `TmuxComposer.tsx:3441` (M5; quick ack `:5932`) | Bubble at once | Bubble shows the failure with Retry (`conversation/OutboxBubbles.tsx:217`) | measured 29 ms to the optimistic row | A |
| C2 | Outbox bubble: Retry, Edit, Check | `OutboxBubbles.tsx:217`, `:239`, `:248` | Bubble back to delivering at once / text back in composer | On the bubble | est. | A |
| C3 | Retry a failed or uncertain runtime delivery | `TmuxComposer.tsx:4579`, `:4600` (`:4615`) | Composer busy until the answer | Status line | est. | C — conflict (the original key replays; the journal decides) |
| C4 | Discard an undelivered receipt | `TmuxComposer.tsx:4642` | Busy | 409 "delivery unconfirmed" in the status line | est. | C — conflict (it may have been delivered) |
| C5 | Retry an admitted payload | `TmuxComposer.tsx:3711` | Busy | Status line | est. | C — conflict |
| C6 | Stop the turn (composer, control strip, pane header) | `TmuxComposer.tsx:5434`; `hooks/useConversationControl.ts:65` (strip `AgentControlStrip.tsx:421`, header `TaskHeader.tsx:59`) | Slot busy / pending receipt | Status line | est. | C — irreversible; the engine ends the turn |
| C7 | Respawn; resume here; resume from a question card | `TmuxComposer.tsx:5461`; `runtime/DeadHostBanner.tsx:118`; `runtime/SupersededBanner.tsx:101`; `feed/QuestionCard.tsx:403` | Busy | Error in the banner | est. | C — server-computed (new host) |
| C8 | Ask in parallel (deputy); deputy retry | `TmuxComposer.tsx:5269`; `conversation/DeputyBlock.tsx:149` | Pending chip at once | Status line / block | est. | C — server-computed (spawns a deputy) |
| C9 | Compact (structured) | `AgentControlStrip.tsx:514` | Busy | Status | est. | C — server-computed |
| C10 | Answer an agent question in the feed: option, several questions + «Надіслати», typed answer, plan approve / reject | `feed/QuestionCard.tsx:343` (buttons `:626`–`:699`, phone `:730`–`:800`) | "Sending…" spinner, every control disabled until `/api/answer` answers | Alert in the card with the failed picks marked; 409 shows the recorded answer | est. pane driving + up to 10 s transcript confirmation | **B2** |
| C11 | Answer a terminal menu (1–9, Esc) | `QuestionCard.tsx:215` (`:277`, `:303`) | Same | Same | est. | **B2** |
| C12 | Dismiss a question card | `QuestionCard.tsx:326` | Local | — | — | A (local) |
| C13 | Answer a structured question / approval / permission card in a conversation | `runtime/ConversationAttention.tsx:108` | Card busy until the command answers; it leaves when the host projects the resolution | Error line on the card | est. | **B3** |
| C14 | Rename a conversation | `session/SessionTitle.tsx:182` (commit `:239`) | **Old title stays** until the PATCH answers; the overlay is set only on success (`:203`) | "Rename failed" with Retry | est. | **B16** |
| C15 | Next message's account (pane header badge) | `AccountBadge.tsx:152` | At once; rollback | Toast | est. | A |
| C16 | Model, effort, speed, account (runtime pill), live or running stage | `RuntimePill.tsx:337`, `:385`, `:650` | Face changes at once (browser-profile rollback) | Error in the pill; toast | est. | A |
| C17 | Keep the current account during a held switch | `RuntimePill.tsx:970` | At once | Restored + alert | est. | A |
| C18 | Codex native queue: start, move, edit, delete | `NativeQueuePanel.tsx:250`, `:361`, `:510`, `:529`, `:545` → `hooks/useNativeQueue.ts:262` | Row marked in flight at once; result after the receipt | Failure line | est. | C — conflict (the engine drains the queue; writes carry `expectedRevision`) |
| C19 | Add images to a task draft | `hooks/useTaskDraft.ts:132` | Upload per file before the tray shows it | Refusal named per file | est. | C — server-computed (content-addressed ref) |
| C20 | Dictate (mic) | `hooks/useDictation.ts:340` | Recording at once; text after transcription | Error | est. | C — server-computed (text) |
| C21 | Read aloud | `feed/ttsSession.ts:209`; `feed/ttsPcmSession.ts:56` | Loading | Error | est. | C — server-computed (audio) |
| C22 | Open a viewer pane / attach terminal | `AttachTerminalDialog.tsx:240` | Busy | Error | est. | C — server-computed (pane) |
| C23 | Kill a process (pane header, phone host sheet, resources footer) | `TaskHeader.tsx:61`; `mobile/MobileHostSheet.tsx:77`; `ResourcesFooter.tsx:344` | Busy | Error, then SIGKILL offered | est. | C — irreversible |
| C24 | Delete a transcript; delete an inbox image | `DeleteFileButton.tsx:31`; `feed/InboxImage.tsx:38` | Two-step confirm, busy | Error | est. | C — irreversible |
| C25 | Launch a new agent from a draft | `DraftAgentPane.tsx:626` | Launch status at once; the window attaches after the receipt | Draft restored with the reason | est. | C — server-computed (identity, admission, preflight) |
| C26 | Launch a workflow | `workflows/WorkflowDraftPane.tsx:105` | Busy | Error | est. | C — server-computed |

### 5.4 Lane controls

| # | Action | Handler | Now | Fail | Lat. | Cl. |
|---|---|---|---|---|---|---|
| L1 | Pause / Resume a lane | `KanbanBoard.tsx:1589` → `kanban/usePipelineActions.ts:175` → `:89` → `kanban/pipelinePorts.ts:57`; phone `MobilePipelineScreen.tsx:260` | Menu items disabled with a "busy" note; the lane changes after the echo; receipt | Error receipt with Retry; no answer → "not confirmed, Check again" | est. one record write; 503 `store_busy` under lock contention | **B8** |
| L2 | Retry / Skip a stage | same, stage-bound | Same | 409 `STAGE_CHANGED` explained from a fresh read | est. | C — conflict (stage and attempt guard) |
| L3 | Skip / Close from a lane row (held 4 s with Undo) | `usePipelineActions.ts:175`; phone `MobilePipelineScreen.tsx:274`, `:287`; `MobileRowActions.tsx:125` | Receipt with Undo at once; sent when the window closes | Error receipt | est. | C — irreversible (the Undo window is the immediate part) |
| L4 | One more review round / Accept as is | `usePipelineActions.ts:89` (revision-bound) | Read, then guarded write | Refusal explained | est. two round trips | C — conflict (`expectedRevision`) |
| L5 | Lane answers on a decision stop (menu and timeline links) | `KanbanBoard.tsx:1648`, `:2175`; `kanban/TaskChronology.tsx:162` | As L1–L4 by action | As L1–L4 | est. | as L1–L4 |
| L6 | "This lane finishes the task" check | `pipelines/finishesTask.ts:29` (`KanbanBoard.tsx:1667`; `MobileTaskScreen.tsx:911`) | Check flips after the echo; receipt | Error receipt | est. | **B9** |
| L7 | Show a lane on the board again (phone) | `MobilePipelineScreen.tsx:488` (M2) | At once | Reverted; receipt | est. | A |
| L8 | Save a stage's first message | `kanban/StageDraft.tsx:186` → `kanban/stageDrafts.ts:109` | "Saving" through a read and a guarded PATCH | Kept with "changed", "started" or the error | est. two round trips | **B10** |
| L9 | Configure an unstarted stage (engine, model, effort, role) | `pipelines/StagePlaceholderPane.tsx:125`, `:150` | Form shows the choice; the record overlay is not applied; controls disabled | Error in the pane; the form keeps the refused value | est. | **B11** |
| L10 | Remove / reorder an unstarted stage | `StagePlaceholderPane.tsx:198`, `:223` (M2) | At once | Reverted | est. | A |
| L11 | Wire pass / fail edges | `pipelines/StageEdgeControls.tsx:48` → `setPipelineEdge` (M2) | At once (controls locked while writing) | Reverted; error | est. | A |
| L12 | New lane from a template | `pipelines/PipelineTemplatePicker.tsx:70` → `pipelineModel.ts:1266` | "Creating" at once | Blocked with the reason | est. | C — server-computed (preflight, id, worktree) |
| L13 | Work links: attach | `workLinks/WorkLinkChips.tsx:162` → `workLinks/workLinksContext.tsx:34` | Busy | Refusal | est. | C — server-computed (the server parses and validates the reference) |
| L14 | Work links: detach | same | Busy; chip stays until the answer | Refusal | est. | **B17** |

### 5.5 Prototype review answers (the review window)

| # | Action | Handler | Now | Fail | Lat. | Cl. |
|---|---|---|---|---|---|---|
| P1 | Pick variants, answer questions, write a comment | `prototypeReview/PrototypeReview.tsx:429`, `:400`; `DecisionQuestions.tsx:75` | Local draft | — | — | A (local) |
| P2 | Save choice / Answer / Reject and redo / Skip | `PrototypeReview.tsx:336` (buttons `:647`, `:648`) → `usePrototypeReview.ts:121` → `:77` | Spinner on the button, every control disabled until the durable save answers; then the window collapses into the saved decision | Banner `PrototypeReview.tsx:372`; a refused save keeps choice, words and reason for the next opening | est. one durable write | **B12** |
| P3 | Retry delivery of a saved decision | `PrototypeReview.tsx:537` → `usePrototypeReview.ts:101` | "On its way" at once (`optimisticPrototypeRead`) | Restored + banner | est. | A |
| P4 | Hide / Undo hide | `PrototypeReview.tsx:646`, `:603` → `usePrototypeReview.ts:122` | Card, notices and count change at once (M3) | Layer removed; banner | est. | A |
| P5 | Resend to Telegram | `PrototypeTelegramActions.tsx:20`; `usePrototypeReview.ts:103` | Busy | Error | est. | C — server-computed (the Telegram message) |
| P6 | Close guard: keep / discard | `PrototypeReview.tsx:674`, `:675` | Local | — | — | A (local) |

### 5.6 Settings

| # | Action | Handler | Now | Fail | Lat. | Cl. |
|---|---|---|---|---|---|---|
| S1 | Asks-you on/off | `asksYouSetting.ts:78` (M7) | At once | Restored; row marked failed | est. | A |
| S2 | Bridge reports on/off | `reportLog/bridgeReportsSetting.ts:86` (M7) | At once | Same | est. | A |
| S3 | Merge on review | `MergeOnReviewRow.tsx:64` (M7) | At once | Same | est. | A |
| S4 | Share the project with linked installations (project menu and sheet) | `links/ShareProjectRow.tsx:28` | Switch disabled until the answer | `failed` hint | est. | **B18** |
| S4b | Linked-install dialog: "Share all" and the per-project sharing checkboxes | `links/LinkedSettingsDialog.tsx:366` (all), `:368` (project) → `share` `:204` → `linkedAction` `:160` | `PATCH /api/links/shared` then a refresh; the checkbox keeps the old value and every dialog control is disabled (`busy`) until both answer | Alert at the top of the dialog (`linkError`, `:232`) | est. one local store write + refresh (`src/app/api/links/shared/route.ts:19`–`:24` only persists the chosen flags) | **B18** |
| S5 | Agent memory on/off | `memory/MemoryPage.tsx:71` | Busy until the answer | "save" error | est. | **B19** |
| S6 | Seat tick settings (auto-rotate, cadence, monitor note) | `orchestrator/useSeatTickSettings.ts:255`; `SeatTickSwitch.tsx:252`, `:345` | Pending value shown at once | Restored + error | est. | A |
| S7 | Worker limit set / reset (project, machine) | `orchestrator/WorkerLimitChip.tsx:32`, `:119` | Field keeps the typed value; chip and popover locked until the answer | Restored + "save" error | est. | **B20** |
| S8 | Maintainer runtime | `orchestrator/useMaintainerRole.ts:102` | Waits | 409 shows the current value; error | est. | **B21** |
| S9 | Role mapping (engine/model per role) | `onboarding/AgentMappingTable.tsx:402` | At once | Restored + error | est. | A |
| S10 | Dictation backend (mic menu) | `MicButton.tsx:157` | Saving until the answer | Error | est. | **B22** |
| S11 | Dictation backend (setup guide) | `onboarding/VoiceStep.tsx:218` | At once | Restored + error | est. | A |
| S12 | Read-aloud backend / voice | `feed/SpeakButton.tsx:425` | Waits | Error | est. | **B23** |
| S13a | OpenRouter key (Asks-you and shared memory) | `asks/OpenRouterKeyField.tsx:15` → `PUT /api/asks-you/key` | Field emptied at once, input and button disabled until the answer, then "saved" | "Invalid key" / failed alert under the field | est. one local file write; the route checks the key's syntax and writes it (`src/app/api/asks-you/key/route.ts:36`–`:38`), no provider request | **B31** |
| S13b | Dictation provider key (setup guide) | `onboarding/VoiceStep.tsx:112` → `PUT /api/transcribe/key` | Saving until the answer; field emptied only after success | Note with the reason; 409 when the key comes from the environment | est. one local file write; the route checks shape and environment ownership (`src/app/api/transcribe/key/route.ts:31`–`:44`) | **B31** |
| S13c | Voice companion key | `hooks/useVoiceCompanionSettings.ts:23` (`key`) → `PUT /api/voice-companion/key` | Busy until the answer | Error code under the field | est. one local file write; `saveKey` validates syntax and writes (`src/lib/voiceCompanion/storage.ts:360`–`:363`) | **B31** |
| S14 | Voice companion settings (other than the key) | `useVoiceCompanionSettings.ts:23` (`settings`) | Busy | Error | est. | **B24** |
| S15 | Delete call memory | `voiceCompanion/CallMemorySetting.tsx:15` | Writing | Retry | est. | C — irreversible |
| S16 | Telemetry | `telemetry/TelemetrySettings.tsx:30` | Busy | Error | est. | **B25** |
| S17a | Seat reports: turn Telegram reports Off ("Log only") | `orchestrator/SeatReports.tsx:155` → `save(null)` `:74`; `ProjectReportsOverview.tsx:81` | The stored choice changes only after the PUT answers; `reset()` follows | Error line under the control | est. one local write: the route handles `null` with `setReportTelegram(project, null)` and resolves no chat or link (`src/app/api/projects/settings/route.ts:157`–`:158`) | **B30** |
| S17 | Seat reports: choose a chat or paste a link | `SeatReports.tsx:74`; `ProjectReportsOverview.tsx:81`; `onboarding/TelegramReportsStep.tsx:118` | Saving | Error with the server's message | est. Telegram lookup for a pasted link | C — server-computed (the server resolves the link and checks the bot is in the chat, `route.ts:124`–`:155`) |
| S18 | Telegram sign-in, bot, report groups | `hooks/useTelegramConnection.ts:111`; `useTelegramBot.ts:63`; `useTelegramReports.ts:92` | Busy | Failure code | est. | C — server-computed (external service) |
| S19 | Push notifications | `PushBell.tsx:35` | Browser permission prompt, then subscribe | — | est. | C — server-computed (permission, subscription) |
| S20 | Learned rules: delete, restore, revert | `roleMemory/LearnedRules.tsx:146` | Waits | "save" error | est. | **B26** |
| S21 | Summarise the memory profile | `roleMemory/useMemoryProfile.ts:62` | Streams | Error | est. | C — server-computed (summary) |
| S22 | Linked installations: key, connect, code, remove | `links/LinkedSettingsDialog.tsx:149`, `:160`, `:174`, `:187` | Busy | Error | est. | C — server-computed (codes, peers) |
| S23 | Language, sound, keep-awake, context mode | `LanguageToggle.tsx:19`; `SoundToggle.tsx:137`; `KeepAwakeControl.tsx:107`; `ContextToggle.tsx:36` | Local | — | — | A (local) |
| S24 | Automatic updates on/off (self-update dialog) | `selfUpdate/SelfUpdateDialog.tsx:136` → `:70` | Button pending until the answer; the label flips with the returned snapshot | Error in the dialog | est. | **B27** |

### 5.7 Voice companion

| # | Action | Handler | Now | Fail | Lat. | Cl. |
|---|---|---|---|---|---|---|
| V1 | «Надіслати» / Cancel on a proposal | `voiceCompanion/VoiceCompanion.tsx:1099` (buttons `:1229`, `:1230`) | Both buttons disabled; the card keeps its awaiting-confirmation head («Надіслати оркестратору …?»), body and the disabled «Надіслати» until an event read brings the new stage | Card stays; notice "Delivery is not confirmed" (`VoiceCompanion.tsx:1216`) | measured 2.58 s `sending`→`queued` in the call where the button was pressed; the tap's POST returns only after delivery admission | **B1** |
| V2 | Start a call | `VoiceCompanion.tsx:1083` | Connecting | Error event | est. | C — server-computed (provider session) |
| V3 | End a call; mute | `VoiceCompanion.tsx:1097`, `:1098` | At once | — | — | A |

### 5.8 Everything else

| # | Action | Handler | Now | Fail | Lat. | Cl. |
|---|---|---|---|---|---|---|
| R1 | Switch the active account | `hooks/useEngineAccounts.ts:859` | At once, rollback with a notice (the whole panel is locked while it writes) | Restored + notice | est. | A |
| R2 | Add an account, sign in, submit a login code («Надіслати код»), cancel a login | `useEngineAccounts.ts:781`, `:903`, `:930`, `:947`; `AccountsPanel.tsx:1130`, `:1152` | Busy | Notice | est. | C — server-computed (external auth) |
| R3 | Remove / restore an account; clean up orphans | `useEngineAccounts.ts:1008`, `:1042`, `:1175` | Removing | Refusal names what holds it | est. | C — conflict (refused while in use) |
| R4 | Refresh limits; reset credits; copy terminal command | `useEngineAccounts.ts:1109`, `:1137`, `:1073` | Busy | Notice | est. | C — server-computed (credit reset is irreversible) |
| R5a | Claude provider editor: save an existing provider account | `AccountsPanel.tsx:804` (`request("save")`, PATCH) | Busy until the answer; the form stays open | Error line in the editor | est. one local write: `updateProviderClaudeAccount` (`src/lib/accounts/claude.ts:551`–`:584`) persists, no provider request | **B32** |
| R5 | Claude provider editor: add a new provider account; "list models" | `AccountsPanel.tsx:804` (`request("save")` POST, `request("provider-models")`) | Busy | Error | est. one provider request: the route lists the provider's models before creating (`src/app/api/accounts/claude/route.ts:65`–`:86`) | C — server-computed (remote model list and token check) |
| R6a | Copilot: use another account | `CopilotFooterRow.tsx:168` → `post` `:71`–`:90` | **No pending state**: the old "active" badge stays and the old row's button stays pressable until the POST answers, then `setBody` redraws | Alert at the foot of the row (`:263`) | est. one local write | **B33** |
| R6 | Copilot: add an account, restore a hidden one, sign in, cancel a sign-in, choose plaintext storage | `CopilotFooterRow.tsx:238`, `:259`, `:174`, `:181`, `:188`, `:195`, `:196` → `post` | No busy state; the row changes when the answer redraws it | Alert at the foot of the row | est. | C — server-computed (a managed home and its sign-in supervisor are created or advanced on the server; the sign-in itself is external auth) |
| R6c | Copilot: remove an account | `CopilotFooterRow.tsx:95` (confirm `:215`) | Confirm closes; no busy state until the answer | Refusal block under the row, with Retry (`:229`) | est. | C — conflict (refused while live sessions, conversations or a sign-in hold the account: `src/app/api/accounts/copilot/route.ts:119`–`:127`) |
| R7 | Crown a project; favourite; archive a project or a switchboard card | `hooks/useProjectCuration.ts:75`; `ProjectDashboard.tsx:485` (M4); `hooks/useArchivedProjects.ts`, `hooks/useArchivedPaths.ts` (local storage) | At once | Crown restored on failure | est. | A |
| R8 | Create a project | `ProjectRail.tsx:767`; `mobile/MobileProjectSheet.tsx:198` → `useProjectCuration.ts:97` | Busy | Error | est. | C — server-computed (directory, key) |
| R9 | Delete a project's transcripts | `ProjectTrash.tsx:234` | Confirm, busy | Count of failures | est. | C — irreversible |
| R10 | Designate / confirm an orchestrator seat | `orchestrator/useSeatConfirm.ts:149`; `MobileSeatCard.tsx:281` | Submitting | Failure | est. | C — server-computed (spawns the seat) |
| R11b | Team member: rename, pick a colour (self or owner) | `team/MembersTab.tsx:422`, `:440` → `patch` `:330` | `busy`; the heading, avatar and selected colour radio (`aria-checked` from `member.color`, `:438`) change only after the PATCH and `refreshTeamView` | Error line in the member dialog | est. one local write; the route authorizes the caller and persists the operator's value (`src/app/api/team/members/[id]/route.ts:27`–`:34`) | **B34** |
| R11 | Team: sign in, join, approve requests and sessions, invites, revoke or restore members, passkeys, sign out | `team/MembersTab.tsx:63`, `:69`, `:257`, `:333`, `:401`, `:412`; `team/SessionsTab.tsx:49`–`:57`; `team/TeamPage.tsx:37`, `:106`; `team/SignInCard.tsx:279`; `team/JoinCard.tsx:93`; `headerMenu/HeaderMenu.tsx:49` | Busy | Error | est. | C — server-computed (authorization and credentials) |
| R12 | Phone access QR | `AccessQrButton.tsx:107` | Loading | Error | est. | C — server-computed (one-time URL) |
| R13 | Self-update: update, retry, install action, restart | `selfUpdate/SelfUpdateDialog.tsx:70` (`:129`–`:131`) | Pending | Error | est. | C — irreversible |
| R13b | Self-update: "Check now" / "Retry check" / "Check again" | `selfUpdate/SelfUpdateView.tsx:203`–`:208`, `:392` → `actions.check` `selfUpdate/SelfUpdateDialog.tsx:137` → `act` `:70` → `POST /api/self-update/check` | The button is disabled while `pending` holds `check`; the "checking" status line comes from the server snapshot (`SelfUpdateView.tsx:308`), not from the press | Error in the dialog | est. one remote revision lookup | C — server-computed (the result is the remote's current revision) |
| R14 | External relay: pair a relay; create a voice clone | `externalRelay/ExternalRelaySection.tsx:262`, `:284`, `:293`; `CloneCreate.tsx:144` | Busy | Error | est. | C — server-computed (external service) |
| R14b | External relay: "answered here" switch of a target | `externalRelay/ExternalRelaySection.tsx:487` → `act` `:574` (`actions.route` `:585`–`:586`) → `PATCH …/targets/[targetId]` | `busy` disables every relay control; the switch keeps its old position until the request and `onChanged` finish | Error line of the relay card | est. one round trip to the external relay: the route stores the relay's own answer (`src/app/api/external-relay/relays/[id]/targets/[targetId]/route.ts:37`–`:67`) | C — server-computed (the external relay confirms who answers) |
| R14c | External relay: target engine, model, effort | `ExternalRelaySection.tsx:494`, `:498`, `:503` → `patchTarget` `:585` | Same lock; old values stay until the answer | Error line of the relay card | est. one local store write (`src/app/api/external-relay/relays/[id]/route.ts:61`–`:103`) | **B35** |
| R14d | External relay: concurrency, member limit, owner tier | `ExternalRelaySection.tsx:511`, `:405`–`:419` (limit field), `:522` → `patchTarget` | Same | Same | est. | **B35** |
| R14e | External relay: pause / resume | `ExternalRelaySection.tsx:605` → `act` `:574` | Menu item disabled while busy; the state line changes after the answer | Error line of the relay card | est. one local write; the route also revokes the relay's running owner runs afterwards (`route.ts:111`) | **B36** |
| R14f | External relay: disconnect | `ExternalRelaySection.tsx:609` | Busy | Error | est. | C — irreversible (unpairs the relay; pairing needs a new code from the external service) |
| R15 | Setup guide: mark a step done / skipped | `onboarding/OnboardingDialog.tsx:253` (`mark`; `putOnboarding` result discarded, `onboarding/useOnboarding.ts:56`–`:66` returns `null` on refusal or network failure) | The step changes at once | **Silent**: the check stays changed, nothing is restored, no error | est. | **B29** |
| R16 | Setup guide: health check start/stop; phone access on/off | `onboarding/CheckStep.tsx:128`, `:139`; `PhoneStep.tsx:96` | Busy | Error | est. | C — server-computed |
| R17 | Task sheet: create (and send to agents) | `tasks/TaskSheet.tsx:43` | Busy through create and send | Error in the composer; send outcome toast | est. | **B7** (create); send C — server-computed per target |

### 5.9 Local-only interactions and background traffic

Of the about 1,350 handler attributes in reachable components, every one not
listed above is meant to change only browser state (open/close, fold, select, navigate,
search, filter, zoom, scroll, draft text) and is immediate: class A by
construction. The verifier pass showed that this claim needs a per-file check:
a handler can sit in a file already named in a row and still write to the
server. The write-site list of section 11 is therefore matched against the
tables by file, and the controls of every file with a write site were re-read
after the pass (the relay, Copilot, linked-install, team, update and key rows). Background requests that are not operator actions:
`hooks/useViewPresence.ts:214`, `hooks/logBus.ts:92`,
`hooks/hostTargetBus.ts:75`, `hooks/useFiles.ts:1318`,
`taskAlbum/TaskAlbum.tsx:135`, `onboarding/useOnboarding.ts:122`.

### 5.10 Unreachable code (excluded)

No page imports these, so no operator can press them:
`scheme/SchemeBoard.tsx`, `scheme/TaskCard.tsx`, `scheme/BulkActionBar.tsx`,
`scheme/TaskStickyComposer.tsx`, `scheme/GroupOverridePanel.tsx`,
`scheme/nodes.tsx`, `pipelines/PipelineEditor.tsx`, `pipelines/PipelineHub.tsx`,
`pipelines/PipelineStrip.tsx`, `pipelines/VerdictPopover.tsx`,
`flows/FlowDialog.tsx`, `flows/FlowHub.tsx`, `flows/FlowStrip.tsx`,
`workflows/WorkflowStrip.tsx`. The fix line does not touch them (section 10).

## 6. Class B: the exact change for each

"Error in place" below means the surface the operator pressed, unless it no
longer exists, in which case the nearest surface that still shows the subject.

| # | Action | Show at once | Roll back | Error shows |
|---|---|---|---|---|
| B1 | Voice proposal «Надіслати» / Cancel (V1) | On «Надіслати», draw the card in its `sending` stage: head, instruction and track, buttons gone. On Cancel, draw `cancelled`. Kept as a local stage keyed by `proposalId` until an event read carries a later stage | The existing catch in `decide` (`VoiceCompanion.tsx:1106`) drops the local stage, so the card returns to awaiting confirmation; a server `refused`/`cancelled` stage replaces the local one | The existing notice at the top of the card body (`VoiceCompanion.tsx:1216`), "Delivery is not confirmed. Tap Send again" |
| B2 | Feed question answers and terminal-menu keys (C10, C11) | Set the card to `answered` with the optimistic text, the time and the picks; announce it to the reply chips | On failure, reopen the card with `failedAnswers` marking the picks (existing `QuestionCard.tsx:365`) and announce the failure; on 409 show the recorded answer (existing) | The existing alert in the card (`QuestionCard.tsx:589`) |
| B3 | Permission Allow / Deny (W5) and structured attention answers (C13) | Replace the buttons with the chosen answer ("Allowed once", "Denied", or the chosen option); the row also leaves the needs-you count through a local layer keyed by the request id, bounded like M3's, until the host's projection agrees | Remove the layer and restore the buttons | The existing error line in the row / card |
| B4 | Show an off-board task on the board (K8) | The card appears in its column at once: add `board` as a field of M1 (`fieldValue`, `rowHolds`, `drawnTasks`, the patch body), the same way `hide` is | M1's failure path takes the card off again | Error receipt with Retry, as `showGroup` does (`KanbanBoard.tsx:1241`) |
| B5 | Dismiss a launch that did not start (K11) | Take the launch row(s) off the card at once through a task overlay (`applyTaskSnapshot`, `useFiles.ts:1203`) with the launches marked failed | Revert the overlay (new `revertTaskSnapshot`, section 8) | Flash plus an error receipt with the route's words (today the flash says nothing) |
| B6 | Link / Unlink (K12, K13) | Move the reader under the target card, or off the card, through the same task overlay with the assignment added or removed | Revert the overlay | Error receipt with the route's words; 409 keeps today's explanation |
| B7 | New task (K15, R17 create) | Reset the composer and draw a provisional Inbox card from the text, keyed by the draft's `clientRequestId`, marked as saving; replace it with the server's task when the answer comes (a `matched` answer replaces it with the matched task) | Remove the card and put the text, deadline and attachments back into the composer | The composer's status line, as today |
| B8 | Pause / Resume (L1) | Apply the predicted record (`state` paused or running) through M2 before the PATCH | `revertPipelineSnapshot` on refusal; on no answer revert and keep today's "not confirmed, Check again" | Today's error receipt with Retry |
| B9 | "Finishes the task" check (L6) | Predicted record with the task link's `finishes` flipped, through M2 | Revert | Today's receipt |
| B10 | Stage first-message save (L8) | Close the editor and show the new words in the stage panel through M2 while the read and the guarded write run | Revert, reopen the editor with the draft in its `changed`, `started` or `failed` phase | The editor's existing phase line |
| B11 | Unstarted stage configuration (L9) | Pass the predicted stage to `patchPipeline`'s existing `optimistic` argument so every surface shows it; drop the control lock | `patchPipeline` reverts; also put the form back to the stored value | The pane's existing error line |
| B12 | Review window save / answer / reject / skip (P2) | Collapse into the saved-decision reading at once, as the «Рішення» column does; Close works at once | Keep the draft in a module store (the column's `drafts`, `useOperatorDecisions.ts:21`, or the review's `refusedSaves`); on refusal reopen the round with choice, words and reason | The window's banner (`PrototypeReview.tsx:372`) when open; otherwise the round stays waiting on the card and in Waiting-for-you, and opens with the reason |
| B13 | «Рішення» record Retry / Revoke (W7) | Keep the record in place showing "on its way" (Retry) or "revoking" (Revoke); apply the `answering` filter only to undecided forms | Restore the record's previous delivery state | `retryError` / `revokeError` on the record (props exist) |
| B14 | Decision pointer Retry (W8) | Show the delivery as on its way | Restore | `retryError` under the record |
| B15 | Update decision: Keep waiting (W10) | The row leaves Waiting-for-you | Row returns | The row's existing error line |
| B16 | Conversation rename (C14) | Set the overlay to the typed title before the PATCH | Restore the previous overlay | Today's "Rename failed" with Retry |
| B17 | Work link detach (L14) | Remove the chip | Put it back | The chip row's refusal line |
| B18–B27 | Settings rows S4, S4b, S5, S7, S8, S10, S12, S14, S16, S20, S24 | The new value, as M7 does (`MergeOnReviewRow.tsx:64`); drop the busy lock. For S4b the checkbox and, for "Share all", every project's derived checked/disabled state flip from one local copy of `shared`; the dialog's `busy` lock stays only for the unrelated key, connect and code actions | Restore the previous `shared` copy (both entry points, S4 and S4b, read the same store) | The row's existing failure hint (S4); the dialog's top alert, `linkError` (S4b) |
| B28 | Undo / Redo of an edit still being written (K3b) | Draw the reversed value at once through M1's per-field overlay (`drawnTasks`), as for a saved edit; queue the fenced write behind the original one in the task's existing write queue | The fence needs the revision and lineage the original write returns (`useTaskMutations.ts` header), so the write still leaves after the original answers. If the original is refused or conflicts, drop the queued reversal and show the server's value, as K3 does for a refused entry (`KanbanBoard.tsx:889`–`:892`); if the reversal itself is refused, redraw the pre-undo value | The existing error receipt of K3 (`undoFailed` / `undoRefused`) |
| B29 | Setup guide step mark (R15) | Unchanged: the step changes at once | Keep the prior step state in `mark` (`OnboardingDialog.tsx:253`); when `putOnboarding` returns `null`, restore it | An error line at the guide step that was marked, with Retry; the next read still corrects stale state |
| B30 | Seat reports Off (S17a) | Show "Log only" at once: set the displayed choice to `null` in `useProjectReports` (`SeatReports.tsx:53`, `save` at `:74`) before the PUT and run `reset()` | Restore the previous `reportTelegram` and chosen chat | The existing failure line under the control (`failed`) |
| B31 | Key saves S13a–S13c (OpenRouter, dictation, voice companion) | Show the key as stored ("saved" status, key-present state) at once and keep the field emptied | Restore the typed key to the field (kept in a ref until the answer, never in logs or a stored draft) and clear the "saved" status; a 409 `KEY_FROM_ENV` (dictation, voice companion) restores the field and shows the environment source | The existing alert under each field (`providerKey.invalid` / `providerKey.failed`, the setup-guide note, the voice companion error code) |
| B32 | Claude provider editor, existing account (R5a) | Close the editor and show the new label, base URL and model on the account row at once, with the token field cleared | Reopen the editor with the typed values (token included, held in component state until the answer) | The editor's error line (`AccountsPanel.tsx:843`) when open; otherwise a notice on the account row. New accounts and "list models" stay C (R5) |
| B33 | Copilot: use another account (R6a) | Move the "active" badge to the pressed row at once and disable repeat presses on both rows | Restore the previous active row | The alert at the foot of the Copilot row (`CopilotFooterRow.tsx:263`) |
| B34 | Team member name and colour (R11b) | Heading, avatar and the selected colour radio use a local overlay of the typed name / picked colour until `refreshTeamView` shows the stored one | Restore the previous name and colour; the form reverts to the stored name | The error line in the member dialog (existing `setError`, `errorText`) |
| B35 | External relay target settings (R14c, R14d) | Draw the predicted target (engine with its default model and no effort, model with its kept effort, effort, concurrency, member limit, owner tier) in the relay card at once; the controls of other targets stay usable | Restore the stored target; the member-limit field returns its stored text | The relay card's error line. "Answered here" (R14b) stays C: the external relay confirms it |
| B36 | External relay pause / resume (R14e) | The state line shows paused or resumed and the menu label flips at once | Restore the previous state | The relay card's error line |

## 7. The «Надіслати» button that triggered the rule

The operator skipped the clarifying question as already decided, so this is
not asked again. From the evidence:

- Only three buttons read exactly «Надіслати» in the Ukrainian UI:
  `voiceCompanion.send` (the voice companion proposal, V1), `common.send`
  (multi-question and typed answers in the feed question card, C10), and the
  Telegram password submit (settings row S18, `telegram.passwordSubmit`).
- The complaint came at 12:06:57 UTC inside a voice call. In the call that
  preceded it, the companion proposed a request at 12:04:47 UTC that required a
  confirmation; the card waited in `awaiting_confirmation`, the call ended at
  its cap at 12:05:41 UTC, and the request reached `queued` only at 12:10:06
  UTC (call journal `request.states`, `session_end`).
- In code, a tap on that «Надіслати» disables the buttons and leaves the
  awaiting-confirmation card on screen until an event read brings the next
  stage; the POST itself returns only after delivery admission
  (`src/lib/voiceCompanion/liveSession.ts:831` → `src/lib/voiceCompanion/admission.ts:438` →
  `deliver`).

The most likely button is the voice companion proposal's «Надіслати» (B1). The
press itself is not journaled, so the time between the press and the card
changing cannot be measured. B2 covers the other candidate; both are in the
first slice of the fix line.

## 8. Shared mechanism and the fix line

**Reuse, no new library.** Each domain already owns an overlay that shows a
predicted value and rolls it back (section 4). The fix line extends those:

1. **Pipelines (B8–B11):** give `pipelinePorts.patch`
   (`kanban/pipelinePorts.ts:57`) an optional predicted record, applied with
   `applyPipelineSnapshot(predicted, false)` before the request and reverted
   with `revertPipelineSnapshot` on refusal or no answer, exactly as
   `patchPipeline` does (`pipelineModel.ts:1698`). `usePipelineActions` passes
   it for pause and resume only.
2. **Tasks (B4–B7, B28):** `board` joins M1 as a field (B4), and B28 draws the reversal through M1's overlay while its fenced write queues behind the original. For assignments and the
   provisional card (B5–B7), add `revertTaskSnapshot(id)` beside
   `revertPipelineSnapshot` (`useFiles.ts:1220`) so `applyTaskSnapshot`
   (`:1203`) can be taken back; this is the one new primitive.
3. **Decisions (B12–B14):** one draft store for both the column and the review
   window (the column's `drafts` map), so a refused save always comes back with
   its words wherever it was made; fix the column's `answering` filter.
4. **Everything else (B1–B3, B15–B27, B29–B36):** component state, switched before the
   request, using the failure branches those components already have. The
   template is M7. A shared hook for these rows is heavier than the rows
   themselves.

The #2747 server split (answer after the durable record, deliver in the
background) is not needed for the client to be optimistic here: B1 and B2 show
the result at once while the routes still wait, and roll back when they refuse.

**One fix line, five slices, in this order.** Each slice is one commit with
failing-first DOM tests: the press shows the new state while the request is
held open by a deferred fetch; a refusal restores the prior state and shows the
error text in place; a second press during the request sends nothing twice.

| Slice | Items | Files | Risk | Tests to extend or add |
|---|---|---|---|---|
| 1. The reported button and the answers | B1, B2, B3 | `voiceCompanion/VoiceCompanion.tsx`, `feed/QuestionCard.tsx`, `attention/PermissionActions.tsx`, `runtime/ConversationAttention.tsx` | Low: client only, existing failure paths | `voiceCompanion/voiceCompanionProduct.dom.test.tsx`, `feed/QuestionCard.delivery.dom.test.tsx`, a new `PermissionActions.dom.test.tsx` |
| 2. Board cards and lanes | B4–B11, B17, B28 | `kanban/useTaskMutations.ts`, `kanban/KanbanBoard.tsx`, `mobile/MobileKanban.tsx`, `kanban/kanbanAssignments.ts`, `hooks/useFiles.ts`, `kanban/pipelinePorts.ts`, `kanban/usePipelineActions.ts`, `pipelines/finishesTask.ts`, `kanban/stageDrafts.ts`, `pipelines/StagePlaceholderPane.tsx`, `tasks/useTaskCreateDraft.ts`, `tasks/TaskSheet.tsx`, `workLinks/*` | Medium: shared task and pipeline caches; the provisional card must be replaced exactly once | `kanban/KanbanBoard.dom.test.tsx`, `mobile/MobileKanban.dom.test.tsx`, `kanban/KanbanDrafts.dom.test.tsx`, `tasks/TaskSheet.dom.test.tsx`, `pipelines/StagePlaceholderPane.dom.test.tsx`, new tests beside `pipelinePorts.ts` and `useFiles.ts` |
| 3. Decisions | B12–B15 | `hooks/usePrototypeReview.ts`, `prototypeReview/PrototypeReview.tsx`, `decisions/useOperatorDecisions.ts`, `decisions/DecisionColumn.tsx`, `decisions/DecisionCard.tsx`, `decisions/DecisionPointer.tsx`, `selfUpdate/AutoDrainDecision.tsx` | Medium: reverses the review window's wait chosen in #2747's fix round; the kept draft must survive a close and another task's review opening | `prototypeReview/PrototypeReview.dom.test.tsx`, `decisions/DecisionColumn.dom.test.tsx`, a new `DecisionPointer` test |
| 4. Rename and settings | B16, B18–B27, B29, B30 | `session/SessionTitle.tsx`, `links/ShareProjectRow.tsx`, `links/LinkedSettingsDialog.tsx`, `onboarding/OnboardingDialog.tsx`, `orchestrator/SeatReports.tsx`, `memory/MemoryPage.tsx`, `orchestrator/WorkerLimitChip.tsx`, `orchestrator/useMaintainerRole.ts`, `MicButton.tsx`, `feed/SpeakButton.tsx`, `hooks/useVoiceCompanionSettings.ts`, `telemetry/TelemetrySettings.tsx`, `roleMemory/LearnedRules.tsx`, `selfUpdate/SelfUpdateDialog.tsx` | Low | `session/SessionTitle.dom.test.tsx`, `memory/MemoryPage.dom.test.tsx`, `orchestrator/WorkerLimitChip.dom.test.tsx`, `feed/SpeakButton.dom.test.tsx`, `MicButton.keyboard.dom.test.tsx`, `roleMemory/LearnedRules.render.test.tsx`, new tests for the rest |
| 5. Keys, accounts, team and relay | B31–B36 | `asks/OpenRouterKeyField.tsx`, `onboarding/VoiceStep.tsx`, `hooks/useVoiceCompanionSettings.ts`, `AccountsPanel.tsx`, `CopilotFooterRow.tsx`, `team/MembersTab.tsx`, `externalRelay/ExternalRelaySection.tsx` | Medium for the key rows (a failed save must hand the typed secret back to the field and nowhere else); low for the rest | `asks/OpenRouterKeyField.dom.test.tsx`, existing `CopilotFooterRow`, team and relay DOM tests, new tests for the provider editor and the voice step |

The line touches no runtime-host code, no Bun pin and no deploy path. Every UI
change still owes rendered evidence through the existing drivers (kanban board
driver, conversation-window driver, phone driver) in en and uk, light and dark.

The fix line is complete when every B row of section 5 maps to a B entry here
and every entry appears in one slice: B1–B3 slice 1; B4–B11, B17, B28 slice 2;
B12–B15 slice 3; B16, B18–B27, B29, B30 slice 4; B31–B36 slice 5.

**Open work on the same files, to recheck when the line starts:** PR #2962
changes `pipelines/pipelineModel.ts` and `PipelineTemplatePicker.tsx`; the open
settings lane for API keys may change the provider-key rows next to S13a–S13c
and S14; the open lane routing decisions to the current orchestrator may change
decision delivery next to B12–B14. None of them was changing these handlers at
the audit's revision.

## 9. Unclear from code

- Which «Надіслати» the operator pressed: strong evidence for V1 (section 7);
  the press time is not recorded anywhere this audit could read.
- How long an event read can be held: the voice companion's `events()` awaits
  `active?.processing` before answering (`liveSession.ts`, after `command`);
  its duration is not visible from code.
- A board-preferences mutation shed by bisection after a 4xx
  (`useBoardState.ts:589`) rolls back, and no operator-visible message for it
  was found in `useBoardState.ts`.
- Whether the task route accepts `board` together with M1's revision guard:
  `board` is a permitted field (`src/app/api/tasks/[id]/route.ts:26`); the
  guard's behaviour with it was not traced.
- How quickly a permission row leaves after success depends on the files poll;
  not measured.
- Reachability is by imports; a reachable component that no current view
  renders would be over-counted.

## 10. Deferred — not currently justified

- **A generic optimistic-mutation library or hook** across domains: the
  overlays exist per domain, and the settings rows are a few lines each.
- **#2747-style server splits** for `/api/answer` and the voice confirmation:
  client optimism meets the rule; revisit if the 10 s confirmation wait causes
  late rollbacks the operator notices.
- **Optimism for class C:** kills, deletes and resets (irreversible); retry,
  skip, accept-head and one more round (conflict-guarded); native Codex queue
  edits (conflict); external sign-ins and links (server-computed).
- **Accounts panel lock:** the active-account switch is optimistic, but every
  row is disabled while any account write runs (`AccountsPanel.tsx:539`).
- **Edge-control lock** while an edge write runs (`StageEdgeControls.tsx:68`).
- **Local thumbnails while task-draft images upload** (C19).
- **Deleting the unreachable components** in 5.10: a cleanup, outside this
  rule.
- **Request-duration logging** in the Viewer, which would let a later audit
  measure route latency directly.

## 11. Evidence and how to repeat it

- Write sites: a script over `src/components`, `src/hooks`, `src/app` listing
  every `fetch(` with its method and route (114 non-GET sites; 110 reachable).
  Cross-check: every file with a write method that is not under `src/app/api`
  and is not a test appears by name in this document; the files not named
  are `overlay/useAttentionOffers.ts` (the attention-request client: its
  accept runs as an automatic follow with no press, its return is W13, and its
  decline, dismiss and preview have no caller), `session/sessionTitleApi.ts` (the rename client of C14),
  `hooks/useBridgeReportRelay.ts` (background cursor acknowledgement, not an
  action), and `workflows/workflowModel.ts` and `flows/flowModel.ts`
  (reachable only from the unreachable strips of 5.10).
- Waits: `grep -rlE "set(Busy|Saving|Pending|Sending|Submitting|…)\(true"` over
  the same trees (66 files).
- Reachability: an import-graph walk from the app entry points (329 reachable
  components, 28 unreachable, of which two are Next.js icon routes).
- Loop gaps: `journalctl --user -u delegatus.service --since "2026-10-15
  21:00:03 UTC" --until "2026-10-16 12:44:35 UTC" -g "viewer loop-gap" -o cat`;
  strip the `[viewer loop-gap] ` prefix, decode each JSON record, keep
  `role == "viewer"`, count `gapMs`. Result: 9,830 records; 9,813 above 500 ms
  and 17 at exactly 500 ms; 4,792 above 1,000 ms; 2,913 above 3,000 ms; maximum
  19,220 ms. Read-only.
- Class counts: parse every row of the tables in sections 5.1–5.8 (a first
  cell of the form `K3b`), take the last cell's leading class (`A`, `**B…**`,
  `C`, `as L1–L4`) and count the distinct `**B<n>**` ids. At this revision:
  136 rows (43 A, 44 B, 48 C, 1 inherited) and 36 B ids; 8 rows are marked
  `(local)`.
- Call journal: the two voice sessions of 2026-10-16 between 11:47 and 12:26
  UTC, read for `utterance`, `request` and `session_end` records. Read-only;
  nothing quoted.
- Earlier work searched: transcripts for "optimistic UI audit rollback",
  "optimistic prototype review decisions 2747", the decision form's wording and
  the voice directive id; memory for "optimistic UI rollback error in place".
  The relevant earlier answer is #2747 and its fix round, cited in sections 4
  and 8; no earlier audit of all actions exists.
