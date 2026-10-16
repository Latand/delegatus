# Optimistic UI audit: every action in the Viewer

> **Requirement (2026-10-16, paraphrased from the pinned specification of this
> lane):** the Viewer applies actions and UI changes optimistically and fast by
> default. A non-optimistic behaviour is allowed only for errors or edge cases
> that do not fit that logic. The rule is standing for the project's UI.
>
> **Decision (2026-10-16):** audit every action in the UI first, then agree one
> common fix line.
>
> **Standing project rule:** `r_4dccc4825132f0f9`.

This document is the audit the decision asked for. It changes no product code.
The fix line it proposes is section 8.

## 1. The requirement

The pinned specification relays a voice request, paraphrased here because the
call is private:

- The trigger was one button that stayed on screen for a long time after it was
  pressed. The call's transcription rendered the button's name unclearly; later
  in the same call the name was given as the Ukrainian label «Надіслати»
  (Send). Section 7 identifies the button.
- The rule itself: every action is optimistic and fast by default; something
  else only when an error or an edge case does not fit that logic.

**Difference between the rendering and the request.** The transcription
rendered the request as handling the rollback or the exceptional case for that
one button. The request itself names the button by its label and makes no
further scope change. This audit designs from the request: the default is
optimism everywhere, and every remaining wait in section 5 names its reason.

**Validation against the requirement.** Every action that writes to the server is in
section 5 with its class, each control row carrying its own reason rather than
inheriting a neighbour's exemption; every class B entry in section 6 says what changes at
once, what rolls back and where the error shows; every class C entry names
irreversible, server-computed or conflict. Section 8 is one fix line, as the
decision asked.

## 2. Summary

- **Inventory:** 166 rows in section 5. 156 of them reach the server (a row
  groups presses that share one handler and one outcome); 10 are local actions
  on the same surfaces, kept for completeness. They come from 329 reachable
  components with about 1,350 event-handler attributes. Two verifier
  passes found rows that had been folded into a neighbour's exemption (the
  external-relay controls, Copilot account selection, the linked-install sharing
  switches, provider key saves, team profile edits, the Telegram Off choice, the
  update check; then the restore of a hidden account, the local Telegram
  settings, the known-chat choice, the board outbox's silent refusal, session
  and passkey removal, the health-check controls, avatar generation, clone
  cancel and Sync now) and explicit read controls the write scan could not see;
  each now has its own row and class. Handlers not in the tables
  change only browser state and are immediate; section 5.9 lists the explicit
  read and retry controls and bounds that claim (section 5.10).
  Fourteen mutation-bearing component files are unreachable from any page and
  are excluded (section 5.11).
- **Classes:** 42 rows **A** (already optimistic, or local), 56 rows **B**
  (should become optimistic; 45 changes, B1–B45), 67 rows **C** (legitimately
  wait, reason named; three repairs F1–F3 add the pending state or error line
  some of them lack), and one row (L5) that takes the class of the lane action
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
  new tasks, conversation rename, Undo of an edit still being written, the
  restore of a hidden account, the local Telegram settings and the known-chat
  choice, and about twenty more settings, account, team and relay rows. Two
  failures are silent today: a permanent refusal of a board close, restore or
  star (B44) and a failed Resolve or Undo in the report log (B43).
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
action and is listed only in section 5.10.

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
5. Explicit reads and retries (added after the second verifier pass): every
   press handler whose callee reads from the server (`retry`, `reload`,
   `refresh`, `recheck`, `load*`, `older`, `more`, `sync`), found by `grep -rnE`
   over the `onClick` attributes of `src/components` and `src/app`, and every
   file that holds a `fetch(` and is named nowhere in the first version.
   Section 5.9 lists the result.
6. Per-control re-read (second verifier pass): the account restore, Telegram,
   team, health-check, external-relay, linked-install and report-log controls
   were read control by control against their handlers and routes. A grouped
   row states the handler of each control it covers. Other grouped rows were
   not re-read control by control in this pass; section 9 says so.

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
no UI, and every "held response" behaviour in sections 5 and 6 is read from
the handler and the route, not observed. No request was sent to the operator's
running Delegatus. Where behaviour is unclear from code, section 9 says so.

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
| K9 | Restore a conversation closed on the board | `KanbanBoard.tsx:2527` (tray `HiddenTray.tsx:90`) → M4 | At once | Outbox retries a lost or throttled write; a **permanent refusal** (`INVALID_REQUEST`, `PAYLOAD_TOO_LARGE`) sheds the single mutation and the card silently goes back to the tray (`useBoardState.ts:704`, `:850`–`:866`); the snapshot reads `sync: "current"` again once the outbox is empty (`:612`) and carries no failure | est. | **B44** |
| K10 | Close a conversation on the board (reader ⋯) | `KanbanBoard.tsx:1745` → `ProjectDashboard.tsx:1429` (M4) | At once; receipt with Undo | Same as K9: retries a lost write; on a permanent refusal the conversation silently reappears on the board | est. | **B44** |
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
| W11 | Resolve a seat's question in the report log; undo | `orchestrator/reportLog/ReportLog.tsx:164` (`resolve`; buttons `:194`, `:237`; the call `void dismiss(…)` at `:167` discards its result) → `sendDismissal` (`attention/dismissalOverlay.ts:231`) | At once (M3) | **Silent rollback**: a network error or a non-OK answer removes the layer and `sendDismissal` returns `{ ok: false, error }` (`dismissalOverlay.ts:247`, `:257`), and `resolve` drops that value; the question returns to «open» with no words, for both Resolve and Undo. A held 400 answer reproduces it | est. | **B43** |
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
| S17b | Seat reports: choose a chat the bot already lists (pick, then Save) | `orchestrator/SeatReports.tsx:161` (`reports.save` `:164`; hook `:74`); `ProjectReportsOverview.tsx:81` (`write`, picked at `:108`, `:140`); `onboarding/TelegramReportsStep.tsx:118` | The stored choice, the chip face and the one-line reading change only after the PUT answers; the control reads «saving» | Error line under the control | est. one local write: for a chat that `service.listChats()` already knows (`src/app/api/projects/settings/route.ts:134`–`:139`) the route skips `addChat` (its guard is `:141`, the call `:143`) and goes straight to `setReportTelegram` (`:155`); only `CHAT_NOT_ALLOWED` (409, `:153`) can still refuse it | **B42** |
| S17 | Seat reports: paste a Telegram link, or name a chat the bot does not list | `SeatReports.tsx:161`; `ProjectReportsOverview.tsx:128`; `TelegramReportsStep.tsx:118` | Saving | Error with the server's message | est. one Telegram lookup | C — server-computed (the remote branch is `service.addChat` at `route.ts:141`–`:143`: `getChat` and `getChatMember` prove the chat exists and the bot is in it; the result names the chat) |
| S18a | Telegram sign-in, connect the bot with a token, refresh the bot's chats, add a chat by reference, test post, disconnect the bot | `hooks/useTelegramConnection.ts:111`; `hooks/useTelegramBot.ts:63` (`connect` `:99`, `refresh` `:98`, `addChat` `:101`, `testPost` `:106`, `remove` `:108`); `TelegramBot.tsx:192`, `:240`, `:375`, `:444`, `:448` | Busy | Failure code | est. one Telegram request | C — server-computed (external service: `getMe`, `getChat`, a test message); the disconnect is C — irreversible (it deletes the stored token and the chat store) |
| S18b | Telegram bot: let agents post in a chat (switch) and rename its alias | `TelegramBot.tsx:119` (`toggle` `:100`–`:101`), alias blur `:153` → `useTelegramBot.ts:100` `setChat` → `src/app/api/telegram/bot/route.ts:58` | Every switch and alias field is disabled while `busy` (`useTelegramBot.ts:63`); the switch keeps its old position until the POST answers | Failure code line under the card | est. one local store write: `service.setChat` validates the id and alias and persists (`src/lib/telegram/bot/service.ts:575`–`:587`), no Telegram request | **B38** |
| S18c | Telegram bot: save the document roots | `TelegramBot.tsx:271` → `useTelegramBot.ts:107` `setDocumentRoots` → `route.ts:68` | Form disabled while `busy`; the draft closes only after the answer | Failure code line | est. one local write: `service.setDocumentRoots` normalizes the paths and persists (`service.ts:475`–`:487`) | **B39** |
| S18d | Daily report: enable, disable, time, source group modes | `TelegramReports.tsx:296`, `:306`, `:317`, `:157` (`setMode` `:154`) → `useTelegramReports.ts:123` `saveSettings` → `act` `:92` → `src/app/api/telegram/reports/route.ts:75` | All report controls are disabled while `busy`; each switch or time keeps its old value until the answer | `FailureNote` in the section | est. one local write: the branch only validates, sanitizes and updates the stored settings (`route.ts:75`–`:102`) | **B40** |
| S18e | Daily report: save the prompt | `TelegramReports.tsx:226` → `useTelegramReports.ts:145` `savePrompt` → `route.ts:75` (`prompt`) | Editor and buttons disabled; the editor closes only after the answer | `FailureNote` above the textarea, text kept | est. one local write | **B41** |
| S18f | Daily report: Run now; load the group list; open the prompt editor | `TelegramReports.tsx:345`, `:163`, `:339` → `useTelegramReports.ts:152`, `:153`, `:124` → `route.ts:104`, `:115`, `?prompt=1` | Busy; Run now becomes the `running` row after the 202 | `FailureNote` | est. `run-now` is durable at once, the source pass takes tens of seconds; `groups` is a bounded connector read | C — server-computed (the run, the connector's group list and the stored prompt text come from the server) |
| S19 | Push notifications | `PushBell.tsx:35` | Browser permission prompt, then subscribe | — | est. | C — server-computed (permission, subscription) |
| S20 | Learned rules: delete, restore, revert | `roleMemory/LearnedRules.tsx:146` | Waits | "save" error | est. | **B26** |
| S21 | Summarise the memory profile | `roleMemory/useMemoryProfile.ts:62` | Streams | Error | est. | C — server-computed (summary) |
| S22 | Linked installations: key, connect, code, remove | `links/LinkedSettingsDialog.tsx:149`, `:160`, `:174`, `:187` | Busy | Error | est. | C — server-computed (codes, peers) |
| S22b | Linked installations: Sync now | `links/LinkedSettingsDialog.tsx:240` → `linkedAction` `:160` → `POST /api/links/peers/[id]` → `syncPeer` (`src/lib/links/client.ts:124`) | Every dialog control is disabled (`busy`) until the peer answers and the list is refreshed; no label of its own | `linkError` at the top of the dialog (`:232`) and the peer's error line | est. one call to the peer machine | C — server-computed (the sync contacts the peer; its outcome is the content) |
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
| R3 | Remove an account (every engine); clean up orphans | `hooks/useEngineAccounts.ts:1008`, `:1175` | Removing | Refusal names what holds it | est. | C — conflict (refused while in use) |
| R3b | Restore a hidden default account (Main, Default) from account setup or from the removal summary, every engine | `useEngineAccounts.ts:1041` `restore` (offers `AccountsPanel.tsx:758`, summary `:772`) → `POST /api/accounts/{codex,claude}` `restore` (`src/app/api/accounts/codex/route.ts:22`, `claude/route.ts:99`) | `runMutation("restore")` locks the panel (`busy`); the hidden row stays absent until the POST **and** a refresh both answer | Summary marked `restored: failed`, or the panel notice `accounts.removed.restoreFailed` | est. one local registry write. The routes only call `restoreLegacyCodexAccount` (`src/lib/accounts/codex.ts:722`) and `restoreLegacyClaudeAccount` (`claude.ts:787`), which delete `legacyHidden` from the registry; no sign-in, no new home, no live-work guard (an "already listed" 404 is harmless) | **B37** |
| R4 | Refresh limits; reset credits; copy terminal command | `useEngineAccounts.ts:1109`, `:1137`, `:1073` | Busy | Notice | est. | C — server-computed (credit reset is irreversible) |
| R5a | Claude provider editor: save an existing provider account | `AccountsPanel.tsx:804` (`request("save")`, PATCH) | Busy until the answer; the form stays open | Error line in the editor | est. one local write: `updateProviderClaudeAccount` (`src/lib/accounts/claude.ts:551`–`:584`) persists, no provider request | **B32** |
| R5 | Claude provider editor: add a new provider account; "list models" | `AccountsPanel.tsx:804` (`request("save")` POST, `request("provider-models")`) | Busy | Error | est. one provider request: the route lists the provider's models before creating (`src/app/api/accounts/claude/route.ts:65`–`:86`) | C — server-computed (remote model list and token check) |
| R6a | Copilot: use another account | `CopilotFooterRow.tsx:168` → `post` `:71`–`:90` | **No pending state**: the old "active" badge stays and the old row's button stays pressable until the POST answers, then `setBody` redraws | Alert at the foot of the row (`:263`) | est. one local write | **B33** |
| R6 | Copilot: add an account, sign in, cancel a sign-in, choose plaintext storage | `CopilotFooterRow.tsx:238`, `:174`, `:181`, `:188`, `:195`, `:196` → `post` | No busy state; the row changes when the answer redraws it | Alert at the foot of the row | est. | C — server-computed (a managed home and its sign-in supervisor are created or advanced on the server; the sign-in itself is external auth) |
| R6b | Copilot: restore the hidden Default account | `CopilotFooterRow.tsx:257` (`HiddenAccountOffer`, `restoring` flag) → `post` → `src/app/api/accounts/copilot/route.ts:83` | The offer is disabled; the account row appears only when `post` redraws the list | Alert at the foot of the row (`:263`) | est. one local registry write: `restoreLegacyCopilotAccount` (`src/lib/accounts/copilot.ts:302`) removes `legacyHidden` and writes the registry, nothing else | **B37** |
| R6c | Copilot: remove an account | `CopilotFooterRow.tsx:95` (confirm `:215`) | Confirm closes; no busy state until the answer | Refusal block under the row, with Retry (`:229`) | est. | C — conflict (refused while live sessions, conversations or a sign-in hold the account: `src/app/api/accounts/copilot/route.ts:119`–`:127`) |
| R7a | Crown a project | `hooks/useProjectCuration.ts:75` | At once | Crown restored on failure | est. | A |
| R7b | Favourite a conversation (the star) | `ProjectDashboard.tsx:485` → `useBoardState.ts:1197` `setFavorite` (M4) | At once | Outbox retries a lost write; a permanent refusal sheds the mutation and the star silently flips back (same path as K9) | est. | **B44** |
| R7c | Archive a project or a switchboard card | `hooks/useArchivedProjects.ts`, `hooks/useArchivedPaths.ts` (local storage) | At once | — | — | A (local) |
| R8 | Create a project | `ProjectRail.tsx:767`; `mobile/MobileProjectSheet.tsx:198` → `useProjectCuration.ts:97` | Busy | Error | est. | C — server-computed (directory, key) |
| R9 | Delete a project's transcripts | `ProjectTrash.tsx:234` | Confirm, busy | Count of failures | est. | C — irreversible |
| R10 | Designate / confirm an orchestrator seat | `orchestrator/useSeatConfirm.ts:149`; `MobileSeatCard.tsx:281` | Submitting | Failure | est. | C — server-computed (spawns the seat) |
| R11b | Team member: rename, pick a colour (self or owner) | `team/MembersTab.tsx:422`, `:440` → `patch` `:330` | `busy`; the heading, avatar and selected colour radio (`aria-checked` from `member.color`, `:438`) change only after the PATCH and `refreshTeamView` | Error line in the member dialog | est. one local write; the route authorizes the caller and persists the operator's value (`src/app/api/team/members/[id]/route.ts:27`–`:34`) | **B34** |
| R11 | Team: sign in, join, approve requests, invites, revoke or restore members, own Telegram link, add a passkey, header sign-out | `team/MembersTab.tsx:63`, `:69`, `:257`, `:333`, `:401`; `team/TeamPage.tsx:37`, `:106`; `team/SignInCard.tsx:279`; `team/JoinCard.tsx:93`; `headerMenu/HeaderMenu.tsx:49` | Where the handler sets `busy` (join, approve a sign-in, member PATCH, add a passkey, claim, sign-in steps) the form is disabled; `answerRequest` (`MembersTab.tsx:63`), `withdraw` (`:69`) and the "not me" step set none | `answerRequest` and the forms show `errorText` (`team/ui.tsx:42` returns the error as a value); `withdraw` (`:69`), the "not me" step (`SignInCard.tsx:279`), `TeamPage.tsx:37` and `HeaderMenu.tsx:49` ignore the answer and reload, change screen or redirect | est. | C — server-computed (authorization and credentials) |
| R11c | Team: end another session, "sign out everywhere else", sign out this session | `team/SessionsTab.tsx:47`–`:58` (`signOut`, `signOutElsewhere`; buttons `:77`, `:102`) | **No pending state** (no `busy`, the button stays pressable) and the answers of `teamRequest` are not read: the row disappears only after the next `load()`; the current-session branch redirects to `/sign-in` even when the request was refused | **None**: a refused or lost DELETE ends in a reload with the session still listed, nothing said | est. one local write | C — irreversible (an ended session cannot be brought back; the credential is cleared on the server, so the redirect for the current session waits for it) with **F2** (pending state, error line, no redirect on a refusal) |
| R11d | Team: remove a passkey | `team/MembersTab.tsx:411` `removePasskey` (button `:483`) | **No pending state**; the DELETE answer is ignored, then `loadPasskeys` and `refreshTeamView` reload | **None**: a 403 or network failure leaves the key listed with no words | est. one local write | C — irreversible (the registered credential is deleted and can only be registered again) with **F2** |
| R12 | Phone access QR | `AccessQrButton.tsx:107` | Loading | Error | est. | C — server-computed (one-time URL) |
| R13 | Self-update: update, retry, install action, restart | `selfUpdate/SelfUpdateDialog.tsx:70` (`:129`–`:131`) | Pending | Error | est. | C — irreversible |
| R13b | Self-update: "Check now" / "Retry check" / "Check again" | `selfUpdate/SelfUpdateView.tsx:203`–`:208`, `:392` → `actions.check` `selfUpdate/SelfUpdateDialog.tsx:137` → `act` `:70` → `POST /api/self-update/check` | The button is disabled while `pending` holds `check`; the "checking" status line comes from the server snapshot (`SelfUpdateView.tsx:308`), not from the press | Error in the dialog | est. one remote revision lookup | C — server-computed (the result is the remote's current revision) |
| R14 | External relay: pair a relay; create a voice clone | `externalRelay/ExternalRelaySection.tsx:262`, `:284`, `:293`; `CloneCreate.tsx:144` | Busy | Error | est. | C — server-computed (external service) |
| R14g | External relay: generate avatar candidates for a voice clone | `externalRelay/CloneCreate.tsx:132` `generate` (button `:357`) → `POST …/clone-avatars` | The button reads "generating" and is disabled; the form stays usable | `setError` with the relay's code | est. an image generation at the external service, seconds to tens of seconds, not measured | C — server-computed (the candidates are generated images; there is nothing to draw) |
| R14h | External relay: cancel a pending clone request | `CloneCreate.tsx:210` `cancel` (button `:457`) → `DELETE …/clone-requests/[id]` | `busy` disables the Cancel button; the card stays "waiting" until the answer, then returns to the form | `setError` in the waiting card; `not_found` counts as cancelled | est. one round trip to the external relay | C — conflict (the creation may have finished at the external service while the cancel travelled; its answer decides between the form and the created card) |
| R14b | External relay: "answered here" switch of a target | `externalRelay/ExternalRelaySection.tsx:487` → `act` `:574` (`actions.route` `:585`–`:586`) → `PATCH …/targets/[targetId]` | `busy` disables every relay control; the switch keeps its old position until the request and `onChanged` finish | Error line of the relay card | est. one round trip to the external relay: the route stores the relay's own answer (`src/app/api/external-relay/relays/[id]/targets/[targetId]/route.ts:37`–`:67`) | C — server-computed (the external relay confirms who answers) |
| R14c | External relay: target engine, model, effort | `ExternalRelaySection.tsx:494`, `:498`, `:503` → `patchTarget` `:585` | Same lock; old values stay until the answer | Error line of the relay card | est. one local store write (`src/app/api/external-relay/relays/[id]/route.ts:61`–`:103`) | **B35** |
| R14d | External relay: concurrency, member limit, owner tier | `ExternalRelaySection.tsx:511`, `:405`–`:419` (limit field), `:522` → `patchTarget` | Same | Same | est. | **B35** |
| R14e | External relay: pause / resume | `ExternalRelaySection.tsx:605` → `act` `:574` | Menu item disabled while busy; the state line changes after the answer | Error line of the relay card | est. one local write; the route also revokes the relay's running owner runs afterwards (`route.ts:111`) | **B36** |
| R14f | External relay: disconnect | `ExternalRelaySection.tsx:609` | Busy | Error | est. | C — irreversible (unpairs the relay; pairing needs a new code from the external service) |
| R15 | Setup guide: mark a step done / skipped | `onboarding/OnboardingDialog.tsx:253` (`mark`; `putOnboarding` result discarded, `onboarding/useOnboarding.ts:56`–`:66` returns `null` on refusal or network failure) | The step changes at once | **Silent**: the check stays changed, nothing is restored, no error | est. | **B29** |
| R16a | Setup guide: health check Start / Check again | `onboarding/CheckStep.tsx:128` (`start`; button `:332`) | **No in-flight state**: the button stays enabled and nothing changes until the POST answers with a run; a second press sends a second POST | Error line `data-health-start-failed` (`:328`) with the server's reason | est. one run admission (the run's rows are then polled once a second) | C — server-computed (the run id, the engine it uses and the row list are chosen by the server; `NO_ENGINE` is a common refusal) with **F3** (pending state at once, no double POST) |
| R16b | Setup guide: health check Stop | `CheckStep.tsx:139` (`stop`; button `:331`) | **No pending state and no `response.ok` check**: the button stays enabled until the poll shows `stopped` | **None**: a refusal or a network error is swallowed (`:145`, "the poll shows whatever the server did") | est. one cancel plus cleanup | **B45** |
| R16c | Setup guide: phone access on / off | `onboarding/PhoneStep.tsx:96` (`act`) | `busy` set at once; the buttons wait for the answer | `failure` line with the code and detail | est. a Tailscale install or sign-in step | C — server-computed (the access state is the server's) |
| R17 | Task sheet: create (and send to agents) | `tasks/TaskSheet.tsx:43` | Busy through create and send | Error in the composer; send outcome toast | est. | **B7** (create); send C — server-computed per target |

### 5.9 Explicit read, reload and retry controls

The write-site scan of section 3 does not see a press that only reads. The
verifier showed that these are operator actions with a wait of their own, so
the scan was extended: every `onClick`, `onChange` or `onSubmit` in
`src/components` and `src/app` whose callee name reads like a server read
(`retry`, `reload`, `refresh`, `recheck`, `load*`, `older`, `more`, `sync`,
`check`) was listed with `grep -rnE` and each hit read to its fetch. The
content behind a read is the server's, so it cannot be drawn ahead of the
answer: class C, reason **server-computed** unless the row says otherwise. What
a row can still owe is the failure line, and those gaps are the repairs of
section 6 (**F1**).

| # | Action | Handler | Now | Fail | Lat. | Cl. |
|---|---|---|---|---|---|---|
| X1 | Conversation lists: Load more; Retry | `ConversationList.tsx:102`, `:84`; `DesktopConversations.tsx:106`, `:91`; `Switchboard.tsx:216`, `:202`; `mobile/MobileInlineCatalog.tsx:109` → `hooks/useConversationCatalog.ts:247`, `:254` | The next page is requested; the list stays | The catalog's error row with Retry | est. one catalog page | C — server-computed (the catalog page) |
| X2 | Global search: Load more; Retry; "mine" filter | `search/GlobalSearch.tsx:342`, `:382`, `:177` → `search/useTranscriptSearch.ts:271`, `:276` | `loading` while the page comes | `data-search-error` row with Retry | est. one search page | C — server-computed (search results) |
| X3 | Task album: Load more; Retry | `taskAlbum/TaskAlbum.tsx:290`, `:247` → `load` `:106` | Button shows a spinner and is disabled | Error block with Retry only while the album is empty (`:244`); **Load more that fails with pictures on screen says nothing** | est. one album page | C — server-computed (indexed pictures) with **F1** |
| X4 | Team activity: Load more | `team/ActivityTab.tsx:198` → `load` `:91` | Button disabled | `failed` is shown only while there is no data (`:144`); **a failed Load more says nothing** | est. one events page | C — server-computed with **F1** |
| X5 | Report log: Older | `orchestrator/reportLog/ReportLog.tsx:144` → `useReportLog.ts:150` `loadOlder` | Button reads "loading" (`loadingOlder`) | **Silent**: `fetchPage` returns `null`, the flag clears and the button returns | est. one cursor page | C — server-computed with **F1** |
| X6 | File preview: Load more (text); Reload after a failure | `preview/TextPane.tsx:288` → `loadMore` `:86`; `preview/ArtifactPreviewHost.tsx:273` → `reload` | Button disabled, "Loading" until the ranged bytes arrive; Reload restarts the read | The pane is replaced by the failure card with the path and Reload (`ArtifactPreviewHost.tsx:261`) | est. one ranged read | C — server-computed (file bytes) |
| X7 | Previous seats: open the notes; Retry | `orchestrator/PreviousSeats.tsx:300`, `:311`, `:442` → `useSeatNotes` `:113` | Notes area in a loading state when the notes are not already on the board | "Failed" line with Retry | est. one task list read | C — server-computed (the notes text) |
| X8 | Read-aloud voice list: Retry | `feed/SpeakMenu.tsx:455` (effect `:263`) | Loading row | The list error with Retry | est. one provider voice list | C — server-computed (the provider's voices) |
| X9 | Re-read after a failure: setup guide engines and voices, role mapping, orchestrator "Recheck", activity page, native queue, attach panes | `onboarding/EnginesStep.tsx:142`; `onboarding/VoiceStep.tsx:259`; `onboarding/AgentMappingTable.tsx:439`; `orchestrator/OrchestratorPanel.tsx:704`; `activity/ActivityDesktop.tsx:134` (`ActivityDashboard.tsx:830`); `NativeQueuePanel.tsx:205`; `resources/AttachControls.tsx:118` | Loading state in place of the failure | The same surface shows the next failure | est. one read each | C — server-computed (status of engines, mappings, seat, queue, panes) |
| X10 | Conversation migration: Retry; Keep the current engine (rollback) | `MigrationRibbon.tsx:102` and its sibling button → `BranchPane.tsx:260` `recover` → `postConversationMigration` | Ribbon shows the migration state; the call is made in the background | `setRecoveryError` under the ribbon | est. one recovery request | C — conflict (the call carries the migration's revision; the server decides whether the retry still applies) |
| X11 | Retry a failed launch chip | `conversation/LaunchChips.tsx:107` → `ProjectDashboard.tsx:1387` `retryLaunch` | A lane launch re-runs the stage (`retryPipelineLaunch`, the L2 guard) and toasts a refusal; any other launch opens a new draft with the old goal at once | Toast with the reason | est. one lane write | A (local) for the draft; the lane retry is L2 (C — conflict) |
| X12 | Receipt chip Retry on a failed or uncertain delivery | `runtime/ReceiptChip.tsx:126` → `TmuxComposer.tsx:5978` | As C3 | As C3 | est. | C — conflict, as C3 |
| X13 | Telegram connect: Retry | `TelegramConnect.tsx:369` | As S18a | As S18a | est. | C — server-computed, as S18a |

**What bounds the claim of section 5.10.** A handler not named in sections
5.1–5.9 was either matched by this cross-check as a local state change or is
not a press (an effect, a poll, a timer, a scroll prefetch such as the older
log page, `hooks/useLogTail.ts:413`, which `LogFeed.tsx:1079` starts from the
scroll position). The 34 files that hold a `fetch(` and were named nowhere in
the first version were read at their fetch sites and in the controls that reach them: the press-driven ones are X1–X13
(`useConversationCatalog` and `useTranscriptSearch` through their callers, the
preview, seat-notes, voice-list and report-log reads); the rest load from an
effect, a poll or a scroll position, and are listed in section 5.10 when they
are not shown by a view's own mount.

### 5.10 Local-only interactions and background traffic

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
`taskAlbum/TaskAlbum.tsx:135`, `onboarding/useOnboarding.ts:122`, and the
loaders that run from an effect on mount or a timer: `hooks/runtimeBus.ts:241`,
`hooks/useCodexRealtime.ts:212`, `hooks/useDeliveryProgress.ts:47`,
`hooks/useTimeline.ts:21`, `components/ProjectAccounts.tsx:94`,
`components/BurndownPanel.tsx:118`, `components/runtime/DeploymentStatusPill.tsx:28`,
`components/StagingBadge.tsx:25`, `feed/messageProvenance.tsx:568`,
`feed/cards/ImageCard.tsx:25`, `kanban/remoteFeed.ts:50`,
`selfUpdate/useSelfUpdateFeed.ts:120`, `team/teamClient.ts:40`,
`tasks/taskIconLoader.ts:38`, `taskAlbum/albumSummaries.ts:51`.

### 5.11 Unreachable code (excluded)

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
| B37 | Restore a hidden default account (R3b, R6b) | Put the account's row back in the list at once (its id and label come from the offer or from the removal summary; the sign-in state reads "checking" until the refresh), mark the summary `restored: done` and drop the offer | Remove the row, bring the offer and the summary back with `restored: failed`; an "already listed" 404 counts as done | Existing: the summary's failed line or the panel notice `accounts.removed.restoreFailed` (Codex, Claude); the footer alert `CopilotFooterRow.tsx:263` (Copilot) |
| B38 | Telegram bot: posting switch and alias (S18b) | Flip the switch (or the alias) in the chat row at once from a local copy of the chat; lock only the row, not every chat, while its write is in flight | Restore the chat's stored `postAllowed` and alias; an `alias_taken` or `alias_invalid` answer puts the field back to the stored text | The existing failure line under the bot card (`ERROR_KEYS`) |
| B39 | Telegram bot: document roots (S18c) | Close the form and list the saved roots at once | Reopen the form with the typed paths | The existing failure line; `document_roots_invalid` is explained as today |
| B40 | Daily report settings (S18d) | Show the new switch state, time or source mode from a local copy of `settings`; the other report controls stay usable | Restore the stored settings copy | `FailureNote` in the report section |
| B41 | Daily report prompt (S18e) | Close the editor and show "edited by you" at once | Reopen the editor with the typed text (kept in state until the answer) | `FailureNote` above the textarea |
| B42 | Choose a chat the bot already lists (S17b) | Show the chosen chat and name as the stored destination at once, drawn from the listed chat's title; `reset()` runs | Restore the previous `reportTelegram`, chosen chat and typed name; `CHAT_NOT_ALLOWED` (the bot left meanwhile) lands here | The existing failure line (`failed`) under the control; links and unknown chats keep today's wait (S17) |
| B43 | Report-log Resolve / Undo (W11) | Unchanged: the question moves to resolved (or back) through M3 | The layer is already taken back by `sendDismissal`; additionally keep its `{ ok: false, error }` instead of discarding it in `resolve` (`ReportLog.tsx:164`) | A line beside the report question that was pressed, with the server's words, for both Resolve and Undo; cleared by the next press or after a poll that agrees |
| B44 | Board outbox: permanent refusal (K9, K10, R7b) | Unchanged: close, restore and star apply at once | When `drain` sheds a single rejected mutation (`useBoardState.ts:860`), also publish it on the snapshot as a bounded list `rejections` (kind, target path or id, code, time; at most five, cleared when read); the optimistic board reverts as today | `ProjectDashboard.tsx` reads `rejections` and raises `pushTaskToast("err", …)` naming the conversation and the code; the star and the tray read the same list. Nothing else in the outbox changes |
| B45 | Health check Stop (R16b) | Show "stopping" at once and disable the button (the poll replaces it with the stopped row) | On a refusal or a lost request, put Stop back | A new line under the controls, beside the existing start error (`data-health-start-failed`) |

**Repairs to retained waits.** These rows stay class C because the server owns
the content or the effect is irreversible, but they lack the feedback the rule
asks of a wait: a pending state at once and an error in place. They are in the
fix line without a class change.

| # | Rows | Missing now | Repair | Error shows |
|---|---|---|---|---|
| F1 | X3, X4, X5 (Load more, Older) | A failed page request is swallowed while content is on screen | Keep the `failed` flag next to the button and clear it on the next press | A line beside the button ("Could not load more") with the button doubling as Retry |
| F2 | R11c, R11d (sessions, passkeys) | No pending state; the DELETE answer is not read; the current-session branch redirects after a refusal | Pending state on the pressed row (the button disabled, "Ending…" / "Removing…"); read `teamRequest`'s answer; redirect only after `ok` | An error line in the tab or dialog (`errorText`, as the neighbouring forms) |
| F3 | R16a (health Start) | The button stays enabled; a second press sends a second POST | Disable at once and show "starting" until the run appears or the request fails | The existing `data-health-start-failed` line |

## 7. The «Надіслати» button that triggered the rule

The operator skipped the clarifying question as already decided, so this is
not asked again. From the evidence:

- Only three buttons read exactly «Надіслати» in the Ukrainian UI:
  `voiceCompanion.send` (the voice companion proposal, V1), `common.send`
  (multi-question and typed answers in the feed question card, C10), and the
  Telegram password submit (settings row S18a, `telegram.passwordSubmit`).
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
4. **Board preferences (B44):** the outbox already applies close, restore and
   star at once; the missing piece is publication. `useBoardState`'s shed of a
   single rejected mutation (`:860`) records it on a bounded `rejections` list
   in the snapshot, and `ProjectDashboard` turns each entry into the board's
   existing error toast (`pushTaskToast`). No new surface, no new library.
5. **Everything else (B1–B3, B15–B27, B29–B43, B45) and the repairs F1–F3:**
   component state, switched before the request, using the failure branches
   those components already have. The
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
| 2. Board cards and lanes | B4–B11, B17, B28, B44 | `kanban/useTaskMutations.ts`, `kanban/KanbanBoard.tsx`, `mobile/MobileKanban.tsx`, `kanban/kanbanAssignments.ts`, `hooks/useFiles.ts`, `kanban/pipelinePorts.ts`, `kanban/usePipelineActions.ts`, `pipelines/finishesTask.ts`, `kanban/stageDrafts.ts`, `pipelines/StagePlaceholderPane.tsx`, `tasks/useTaskCreateDraft.ts`, `tasks/TaskSheet.tsx`, `workLinks/*`, `hooks/useBoardState.ts`, `ProjectDashboard.tsx` | Medium: shared task and pipeline caches and the board outbox every device uses; the provisional card must be replaced exactly once | `kanban/KanbanBoard.dom.test.tsx`, `mobile/MobileKanban.dom.test.tsx`, `kanban/KanbanDrafts.dom.test.tsx`, `tasks/TaskSheet.dom.test.tsx`, `pipelines/StagePlaceholderPane.dom.test.tsx`, new tests beside `pipelinePorts.ts` and `useFiles.ts`, `hooks/useBoardState.test.ts` (a held 400 `INVALID_REQUEST` for one queued close, restore and star: the rejection is published) |
| 3. Decisions | B12–B15, B43 | `hooks/usePrototypeReview.ts`, `prototypeReview/PrototypeReview.tsx`, `decisions/useOperatorDecisions.ts`, `decisions/DecisionColumn.tsx`, `decisions/DecisionCard.tsx`, `decisions/DecisionPointer.tsx`, `selfUpdate/AutoDrainDecision.tsx`, `orchestrator/reportLog/ReportLog.tsx` | Medium: reverses the review window's wait chosen in #2747's fix round; the kept draft must survive a close and another task's review opening | `prototypeReview/PrototypeReview.dom.test.tsx`, `decisions/DecisionColumn.dom.test.tsx`, a new `DecisionPointer` test, `orchestrator/reportLog/ReportLog.dom.test.tsx` (a rejected dismissal shows its words and Undo does too) |
| 4. Rename and settings | B16, B18–B27, B29, B30, B38–B42, B45, F1, F3 | `session/SessionTitle.tsx`, `links/ShareProjectRow.tsx`, `links/LinkedSettingsDialog.tsx`, `onboarding/OnboardingDialog.tsx`, `orchestrator/SeatReports.tsx`, `memory/MemoryPage.tsx`, `orchestrator/WorkerLimitChip.tsx`, `orchestrator/useMaintainerRole.ts`, `MicButton.tsx`, `feed/SpeakButton.tsx`, `hooks/useVoiceCompanionSettings.ts`, `telemetry/TelemetrySettings.tsx`, `roleMemory/LearnedRules.tsx`, `selfUpdate/SelfUpdateDialog.tsx`, `TelegramBot.tsx`, `hooks/useTelegramBot.ts`, `TelegramReports.tsx`, `hooks/useTelegramReports.ts`, `ProjectReportsOverview.tsx`, `onboarding/TelegramReportsStep.tsx`, `onboarding/CheckStep.tsx`, `taskAlbum/TaskAlbum.tsx`, `team/ActivityTab.tsx`, `orchestrator/reportLog/useReportLog.ts` | Low | `session/SessionTitle.dom.test.tsx`, `memory/MemoryPage.dom.test.tsx`, `orchestrator/WorkerLimitChip.dom.test.tsx`, `feed/SpeakButton.dom.test.tsx`, `MicButton.keyboard.dom.test.tsx`, `roleMemory/LearnedRules.render.test.tsx`, `TelegramBot.dom.test.tsx`, `hooks/useTelegramReports.dom.test.tsx`, `onboarding/CheckStep.dom.test.tsx`, `taskAlbum/TaskAlbum.dom.test.tsx`, new tests for the rest |
| 5. Keys, accounts, team and relay | B31–B37, F2 | `asks/OpenRouterKeyField.tsx`, `onboarding/VoiceStep.tsx`, `hooks/useVoiceCompanionSettings.ts`, `AccountsPanel.tsx`, `CopilotFooterRow.tsx`, `team/MembersTab.tsx`, `team/SessionsTab.tsx`, `externalRelay/ExternalRelaySection.tsx`, `hooks/useEngineAccounts.ts` | Medium for the key rows (a failed save must hand the typed secret back to the field and nowhere else); low for the rest | `asks/OpenRouterKeyField.dom.test.tsx`, existing `AccountsPanel.dom.test.tsx`, `hooks/useEngineAccounts.test.ts` (a held restore shows the row at once, a refusal removes it), `CopilotFooterRow`, team and relay DOM tests, new tests for the provider editor and the voice step |

The line touches no runtime-host code, no Bun pin and no deploy path. Every UI
change still owes rendered evidence through the existing drivers (kanban board
driver, conversation-window driver, phone driver) in en and uk, light and dark.

The fix line is complete when every B row of section 5 maps to a B entry here
and every entry appears in one slice: B1–B3 slice 1; B4–B11, B17, B28, B44
slice 2; B12–B15, B43 slice 3; B16, B18–B27, B29, B30, B38–B42, B45 and the
repairs F1, F3 slice 4; B31–B37 and the repair F2 slice 5.

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
- Which permanent refusals a real board write can meet: the shed path of
  `useBoardState.ts:850`–`:866` is read in code and reproduced on paper with a
  `400 {error:"INVALID_REQUEST"}`; no production refusal was seen. B44
  publishes it either way.
- Whether the task route accepts `board` together with M1's revision guard:
  `board` is a permitted field (`src/app/api/tasks/[id]/route.ts:26`); the
  guard's behaviour with it was not traced.
- How quickly a permission row leaves after success depends on the files poll;
  not measured.
- Grouped rows outside the controls listed in section 3, item 6, rest on the
  first pass's reading of each group's shared handler. A later verifier pass
  found several such groups hiding a different control; more may remain.
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
- **Optimism for explicit reads** (section 5.9: Load more, Older, Reload,
  Retry, search pages): the content is the server's, so nothing can be drawn
  ahead of it. Only their missing failure lines are in the fix line (F1).
- **Accounts panel lock:** the active-account switch is optimistic, but every
  row is disabled while any account write runs (`AccountsPanel.tsx:539`).
- **Edge-control lock** while an edge write runs (`StageEdgeControls.tsx:68`).
- **Local thumbnails while task-draft images upload** (C19).
- **Deleting the unreachable components** in 5.11: a cleanup, outside this
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
  (reachable only from the unreachable strips of 5.11).
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
- Class counts: parse every row of the tables in sections 5.1–5.9 (a first
  cell of the form `K3b`), take the last cell's leading class (`A`, `**B…**`,
  `C`, `as L1–L4`) and count the distinct `**B<n>**` ids. At this revision:
  166 rows (42 A, 56 B, 67 C, 1 inherited) and 45 B ids; 10 rows are marked
  `(local)`.
- Call journal: the two voice sessions of 2026-10-16 between 11:47 and 12:26
  UTC, read for `utterance`, `request` and `session_end` records. Read-only;
  nothing quoted.
- Earlier work searched: transcripts for "optimistic UI audit rollback",
  "optimistic prototype review decisions 2747", the decision form's wording and
  the voice directive id; memory for "optimistic UI rollback error in place".
  The relevant earlier answer is #2747 and its fix round, cited in sections 4
  and 8; no earlier audit of all actions exists.
