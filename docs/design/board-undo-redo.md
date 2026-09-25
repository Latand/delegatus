# Board undo/redo: task status, text and hide (#1856)

Design for the desktop kanban board. Written 2026-09-26 against main at
`fe57869e3`. Product source is untouched; this document is the lane's only
output.

## Originating requirement

Issue #1856, "Kanban undo/redo: reverse task edits on the board", operator
request paraphrased in English by the issue's author (2026-09), step 2:

> Undo/redo that matches what the operator really does on the kanban board:
> a task's status change (column move), a task's text edit, a task's hide,
> and a delete if the board offers one. Each entry reverses through the same
> task mutation route the action used, with the task revision as the guard,
> so an undo after an agent changed the task refuses plainly. Ctrl+Z /
> Ctrl+Shift+Z while the board has focus and no text field does; a small
> toast after each reversible action offers Undo.
>
> Acceptance: moving a card to another column and pressing Ctrl+Z puts it
> back; redo moves it again. Editing a task's text and undoing restores the
> previous text. An undo against a task whose revision moved says so and
> changes nothing. The header carries no undo/redo buttons.

The pipeline's pinned specification (2026-09-26) narrows this to the three
edits, sets Cmd equivalents and Ctrl+Y, asks for a toast in en and uk with a
"Скасувати / Undo" action, a bounded in-memory history per board session
cleared on project switch, a keyboard guard for text fields, composers and
dialogs, and lists as out of scope: agent and pipeline actions, priority,
colour and icon changes, scheme-board position drags, persistence across
reloads, the phone layout, and the old header Undo/Redo buttons (removed in
PR #1855).

## Was this designed before

`docs/design/ui-batch-2026-09.md` §3 (merged in #1891) designed this issue
once. Checked against current main, three of its assumptions no longer hold
or are overruled by the pinned specification:

- It refused an undo only when the undone *field* changed elsewhere and let a
  revision moved by another field through. The pinned specification says a
  task someone else changed in between refuses, through the fenced write.
  This document follows the specification: the fence is the revision, not
  the field.
- It added two rows to the header's ⋯ menu as a persistent control. The
  specification asks for no persistent control and names the header buttons
  as out of scope; the rows are deferred below.
- It added `details` edits and a "nothing to undo" receipt. Both are cut:
  the specification names title/description only, and a key that does
  nothing is what every editor does at the bottom of its stack.

Its receipt geometry, entry shapes and key guard are kept where they still
match the code.

## What exists today

Every write the board makes already goes through one revision-guarded queue,
and two of the three edits already carry an Undo that lives as long as a
receipt.

- **Write queue.** `src/components/kanban/useTaskMutations.ts` holds
  `TaskStatusMutations`: `move(task, to)` at
  `useTaskMutations.ts:414` and `edit(task, change)` at
  `useTaskMutations.ts:295`. Both apply the change optimistically, chain
  writes per task (`chains`, `:425-430`), and build the PATCH body with
  `expectedProject` and `expectedRevision` (`bodyFor`, `:339-347`; status
  at `:477`). The guard comes from `guardFor` (`:446-451`), which prefers
  the `known` map, and `known` adopts a newer revision from a poll
  (`reconcile`, `:245-257`) as well as from this device's own saves
  (`remember`, `:434-444`).
- **409 recovery.** After a 409 both paths read the stored row and recover:
  a status move retries when the stored status is still `from`
  (`:489-492`), a hide retries unconditionally (`:392-395`), a text edit
  rebases or retries (`:397-408`). Only a text edit whose edited part moved
  answers `conflict` (`:409-410`), and a move whose status moved elsewhere
  answers `conflict` (`:494-496`). This recovery is right for a fresh edit
  and wrong for an undo: an undo must not retry over a foreign revision.
- **PATCH route.** `src/app/api/tasks/[id]/route.ts:45-58` runs `patchTask`
  and forwards the store's refusal with its code. The fence is in
  `src/lib/tasks/commands.ts:438-449`: a mismatched `expectedProject`
  answers 409 `TASK_PROJECT_MISMATCH`, a stale `expectedRevision` answers
  409 `TASK_REVISION_MISMATCH`. Every successful write stamps a new
  `task-v1:` revision (`src/lib/tasks/revision.ts:34-40`). The browser
  ports at `useTaskMutations.ts:533-552` carry the code back.
- **Board call sites.** `move` at `KanbanBoard.tsx:665-706` shows the
  `kanban.moved` receipt with an Undo whose `run` is another `move` back
  (`:672-675`), records it in `latestUndo` (`:679`) and withdraws it on
  `failed` or `conflict` (`:683-684`, `:693-695`). `hideCard` at
  `:977-996` does the same with `showGroup` (`:949-960`) as its Undo;
  `hideMany` at `:1031-1077` hides a column's worth with one Undo. Text
  edits commit in `saveText` at `:761-825` and `commitEdit` at `:821`,
  through `controller.edit` with a `rebase`; they show no receipt and offer
  no Undo.
- **Receipts.** `src/components/kanban/KanbanReceipts.tsx` is the board's
  toast system: `useReceipts` (`:26-38`) keeps at most three (`:24`), `show`
  returns an id and `dismiss` removes one; a receipt lives 7 s, an error
  12 s (`:31`), and the countdown pauses under the pointer or focus
  (`:48-65`). Geometry is in `kanbanBoard.css:553-569`: fixed,
  bottom-centre, 20 px up, z 80, 8 px gaps, primary fill, 560 px cap, a
  30 px action button, a 2 px draining bar. Mounted once at
  `KanbanBoard.tsx:2672`. `src/components/tasks/taskToast.tsx` is a second,
  older stack for task sends; the board does not use it and this design does
  not either.
- **Keys.** The board's document listener at `KanbanBoard.tsx:1588-1626`
  returns on any Ctrl/Cmd/Alt chord (`:1590`), skips fields (`:1592`), and
  binds `/`, `O` and `U`; `U` runs `latestUndo` only while its receipt is
  still on screen (`:1613-1623`). The Viewer's window listener at
  `Viewer.tsx:1211-1235` also returns on chords, so Ctrl+Z is free.
- **Lifetime.** `useTaskMutations` makes one controller per board mount
  (`useTaskMutations.ts:554-566`). `ProjectDashboard` renders the board
  without a project key (`ProjectDashboard.tsx:2490`), so nothing may
  assume a remount on project switch.

## Design

### 1. Where the history lives

A new pure module, `src/components/kanban/boardHistory.ts`, holding one
`BoardHistory` instance per board and project: two arrays, `undo` and
`redo`, capped at 50 entries oldest-first, no persistence. The board creates
it with `useMemo(() => new BoardHistory(), [props.project])`, so a project
switch drops the old instance whether or not the board remounts, and a reload
starts empty. `latestUndo` (`KanbanBoard.tsx:299-306`) is deleted; the
history replaces it.

An entry is one of:

- `{ kind: "status", taskId, title, from, to }`
- `{ kind: "text", taskId, title, before, after }` — the whole `text` field,
  since title and description are stored as one field and `saveText`
  already writes the whole value.
- `{ kind: "hide", tasks: [{ taskId, title }] }` — one entry for a single
  hide or a column's bulk hide, because `hideMany` already reverses the
  bulk as one Undo, and a Ctrl+Z that skipped past a bulk hide to an older
  move would be a trap.

Every entry carries `settled: Promise<boolean>`, the action's own write,
resolved true on `saved` and false otherwise. Recording happens when the
action is sent, so Ctrl+Z pressed while a write is still out queues behind
it through the existing per-task chain. A write that ends `failed`,
`conflict` or `settled` removes its entry; only what this board actually
wrote is undoable. Recording a new action clears `redo`, and counts in the
history's `epoch`: an undo or a redo still being written when a new action
is recorded does not push its entry back onto either stack when it lands,
so the cleared `redo` stays empty and Ctrl+Shift+Z does nothing.

### 2. How each edit records its inverse

The inverse is the entry itself read backwards. The board applies an entry
in one direction with the same two controller methods the action used:

| Entry | Undo | Redo |
|---|---|---|
| status | `controller.move(task, from, { fenced: true })` | `controller.move(task, to, { fenced: true })` |
| text | `controller.edit(task, { field: "text", value: before }, { fenced: true })`, no `rebase` | same with `after` |
| hide | `controller.edit(task, { field: "hide", value: false }, { fenced: true })` per task, chained with `after` as `hideMany`'s Undo does | `{ field: "hide", value: true, replaces }` per task |

Call sites that record:

- `move` (`KanbanBoard.tsx:665`): records a `status` entry beside the
  receipt; the receipt's Undo action becomes `history.undo()` instead of a
  bare `move` back, so a click and Ctrl+Z run the same code.
- `saveText` (`:761`), text branch only: `before` is the text the edit
  started from (`effectiveById`, `:387-388`), `after` is
  `outcome.task.text` from the `saved` outcome, which is the rebased value
  when the controller rebased. A `details` save records nothing.
- `hideCard` (`:977`) and `hideMany` (`:1031`): a `hide` entry; their
  receipt Undo runs `history.undo()`. A task the server refused in a bulk
  hide is removed from the entry, as `hideMany`'s `refused` set already
  tracks.

### 3. The fence: undo through the fenced PATCH

The undo's guard is the revision this board's own writes last produced for
the task, never the revision a poll adopted. `TaskStatusMutations` gains a
map `own: Map<taskId, revision>`, written in `saved` (`:499`) and
`savedField` (`:369`) only, and a reader `ownRevision(id)`. Every operator
write from this board, including colour and priority and an undo itself,
refreshes it, so a chain of the operator's own actions keeps every entry for
that task valid, and an undo after a redo is fenced on the redo's revision.

The fence alone misses one case. A write of this board that is not fenced (a
move or a colour change guarded by a revision the poll brought, or sent again
after a 409) can save on top of someone else's revision, and then `own` moves
past their change. So the controller also keeps a per-task `lineage`: a save
of this board whose guard was not `own` starts a new one, and every `saved`
answer names the lineage it belongs to. An entry keeps the lineage of each of
its tasks' saves, and its undo or redo passes it as `lineage`. A fenced write
from an older lineage is refused the way a missing fence is: nothing is
PATCHed, the stored row is read, and the answer is `conflict`. A chain made
only of the operator's own writes never leaves its lineage.

`move` and `edit` gain one option, `fenced: true`. The fence is read from
`own` when the write leaves the per-task queue, never when the key is
pressed: a colour change still in flight when Ctrl+Z is pressed would
otherwise leave the undo fenced on the revision before it. With it:

- the body's `expectedRevision` is the fence, and `expectedProject` the
  task's stored project as `known` holds it;
- a 409 with `TASK_REVISION_MISMATCH` or `TASK_PROJECT_MISMATCH` reads the
  stored row once, settles the optimistic value to what the row holds
  (`settleField` / `settle`, as the conflict branches do today at `:409`
  and `:494`), and returns `conflict`. No retry, no rebase, no
  "already holds the value" shortcut: the specification says a task someone
  else changed refuses, and a coincidentally matching value was still
  someone else's change.
- a 404 on the read returns `failed` with status 404, as today.

The route and the store do not change. The fence is the same
`expectedRevision` every write already carries; the only new server-side
fact this design relies on is the 409 code, which the route already
forwards.

Undo flow, in `history.undo()` on the board:

1. Pop the top `undo` entry; await its `settled`. If false, drop it and take
   the next one.
2. With no own revision for the task (the controller was remade, which
   happens only on remount, and the history with it) nothing is sent and
   the undo answers `conflict`.
3. Apply the inverse optimistically through the controller. Show the
   "undone" receipt with a Redo action at once, dismissing the receipt of the
   action it reverses.
4. On `saved`: push the entry onto `redo`.
5. On `conflict`: `flash` the card (`:598`), replace the receipt with the
   refusal (error, 12 s, no action), and drop every entry of that task from
   both stacks, since all of them are fenced on a revision that is now
   stale.
6. On `failed` (network, 5xx, 404): replace the receipt with the failure
   receipt whose Retry runs the same undo again; the entry goes back onto
   `undo`.

Redo mirrors it with the stacks swapped. Bulk hide undoes one task at a time
through the chain; a per-task conflict counts, the rest go through, and the
refusal receipt carries the count.

### 4. Conflict path, what the operator sees

The card moves back at once, the write meets the foreign revision, the card
returns to the server's column (or its text to the stored text) with the
existing flash, and one error receipt says so. Nothing is overwritten and
nothing offers to force it.

### 5. Toast design

The receipt is the toast. Its timing and cap do not change: at most three,
7 s for an action receipt, 12 s for an error, paused under the pointer,
560 px wide at most, 30 px action button. Its place does: the design review
found the viewport-centred stack left of the board beside an open project
rail and over the cards at a column's foot, and undo makes a receipt and a
refusal under it an ordinary pair. The stack now stands over the foot of
the board's pane (`.kb-pane` in `KanbanBoard.tsx`), centred on the pane, and
changes the size of no column: a first round that gave the stack a strip of
its own shrank every column by the stack's height whenever a receipt came
and grew them back when it went. While the stack shows, its height pads the
foot of every card list (`--kb-receipts-inset`, set by `KanbanReceipts`), so
a list scrolled to its end brings its last card above the stack; a list
scrolled into that inset keeps the padding after the stack shrinks until the
reader scrolls out of it, so its cards do not jump when a receipt leaves.
`useReceipts` gains nothing; the
board dismisses the receipt it answers before showing the next, so a run of
Ctrl+Z shows one pill that changes, never three stacked. An action receipt
and an error receipt can coexist (an undo that refused while another move's
receipt still counts down), which the existing cap of three already handles.

Copy, with the existing `kanban.undo` reused as the Undo label:

| Key | en | uk | Action |
|---|---|---|---|
| `kanban.moved` (exists) | Moved «{title}» to {status} | «{title}» перенесено до «{status}» | Undo |
| `kanban.movedBack` (exists, gains an action) | «{title}» is back in {status} | «{title}» знову в «{status}» | Redo |
| `kanban.hiddenReceipt` (exists) | Hidden «{title}» | «{title}» сховано | Undo |
| `kanban.restoredReceipt` (exists, gains an action) | «{title}» is back on the board | «{title}» знову на дошці | Redo |
| `kanban.backOnBoardMany` (exists, gains an action) | {count} tasks are back on the board | {count} задач знову на дошці | Redo |
| `kanban.edited` (new) | Edited «{title}» | «{title}» змінено | Undo |
| `kanban.textRestored` (new) | Restored the previous text of «{title}» | Попередній текст «{title}» відновлено | Redo |
| `kanban.redo` (new) | Redo | Повторити | — |
| `kanban.undoRefused` (new, error) | Someone else changed «{title}» in the meantime, so nothing was undone | Хтось інший тим часом змінив «{title}», тому нічого не скасовано | none |
| `kanban.redoRefused` (new, error) | Someone else changed «{title}» in the meantime, so nothing was redone | Хтось інший тим часом змінив «{title}», тому нічого не повторено | none |
| `kanban.undoRefusedMany` (new, error, plural) | Someone else changed {count} tasks in the meantime, so they stay as they are | Хтось інший тим часом змінив {count} задач, тому вони лишаються як є | none |
| `kanban.retry` (exists, reworded in uk) | Retry | Спробувати ще раз (was «Повторити», which is now Redo) | — |
| `kanban.undoFailed` (new, error) | Couldn't undo: {error} | Не вдалося скасувати: {error} | Retry |
| `kanban.redoFailed` (new, error) | Couldn't redo: {error} | Не вдалося повторити: {error} | Retry |

A redo of a move shows `kanban.moved` with Undo, a redo of a hide shows
`kanban.hiddenReceipt` with Undo, a redo of a text edit shows
`kanban.edited` with Undo: after a redo the board looks exactly as it did
after the action. A title longer than 48 characters is cut by `clipTitle`
(`taskText.ts`) back to the last space before the 46th character and ends
in "…", so a Ukrainian title, about a third longer than its English one, is
never cut inside a word; a single word longer than half that is still cut
where the limit falls. Every receipt that quotes a title uses it. `kanban.retry` is reused for Retry. `kanban.undoGone` and
`kanban.nothingToUndo` from the earlier design are not added: a deleted task
is a task changed elsewhere, and an empty stack answers the key with nothing.

The uk refusal is the longest string; at 560 px in `--text-ui` it fits two
clamped lines (`kanban.css:560`) with a 48-character title, which the
rendered evidence must show.

### 6. Keyboard guard

The board's document listener at `KanbanBoard.tsx:1588` gains one branch
placed before the early return on chords (`:1590`):

- Undo: `Ctrl+Z` or `Cmd+Z` without Shift. Redo: `Ctrl+Shift+Z`,
  `Cmd+Shift+Z`, or `Ctrl+Y` (Ctrl only; `Cmd+Y` is the browser's history).
  Alt never matches. The letter is `event.key`; when that is not a Latin
  letter (the Ukrainian layout reports «я» and «н» on some platforms) it is
  the physical key, `event.code` `KeyZ` or `KeyY`, as the J/K chord reads it.
- The chord is left alone, no `preventDefault`, when `event.target` is inside
  `input, textarea, select, [contenteditable='true'], [role='dialog'],
  [role='menu']`, which covers the inline editors (`CardInlineText.tsx:93-95`
  are textareas), the seat's composer (`ComposerBar.tsx:625` is a textarea),
  the Stages sheet (`StagesSheet.tsx:194`, `role="dialog"`) and every board
  popover (`kanbanMenus.tsx:185`). Also when `sheetOpen.current` or
  `menuOpenRef.current` is set, the same rule the `O` key applies (`:1611`).
- Otherwise the chord acts when the target is inside the board and not in a
  Viewer-owned slot (`inBoard`, `:1596`) or is `document.body`, exactly as
  `U` does today (`:1615`). It calls `preventDefault` only when it acts on
  a non-empty stack, so an empty stack leaves the browser's own behaviour.
- `U` becomes an alias for undo of the top entry, no longer bound to a
  visible receipt. The test "U undoes only while the move's receipt is on
  screen" (`KanbanBoard.dom.test.tsx:265`) changes to "U undoes the last
  edit after its receipt has closed".

The Viewer's own listener needs no change: it returns on chords
(`Viewer.tsx:1213`).

### 7. Phone

Out of scope by the specification. The phone's swipe receipts keep their own
Undo. `boardHistory.ts` and the fence option are inert there because no
phone surface records entries.

## Files the build will touch

- `src/components/kanban/boardHistory.ts` — new: entries, two stacks,
  cap 50, record, take for undo and redo, drop by task.
- `src/components/kanban/boardHistory.test.ts` — new.
- `src/components/kanban/useTaskMutations.ts` — `own` map and
  `ownRevision(id)`; the `fence` option on `move` and `edit`, with the
  no-recovery 409 branch.
- `src/components/kanban/useTaskMutations.test.ts` — the fence: guard equals
  the fence, a 409 answers `conflict` without a second PATCH, the stored
  value is what the board shows afterwards.
- `src/components/kanban/KanbanBoard.tsx` — `move`, `saveText`, `hideCard`,
  `hideMany` record entries and route their receipt Undo through the
  history; `latestUndo` removed; `history.undo()` and `history.redo()` with
  the receipt and conflict handling; the key branch.
- `src/components/kanban/KanbanUndo.dom.test.tsx` — new, on
  `KanbanEditing.dom.test.tsx`'s `scripted` ports (`:97-126`), which already
  script a 409 answer: undo and redo of a move, a text edit and a hide; the
  conflict refusal sending exactly one PATCH and changing nothing; the
  receipt's Undo and Redo actions; Ctrl+Z inside a textarea, a composer and
  an open dialog sending nothing; the history emptied on project switch;
  the cap.
- `src/components/kanban/KanbanBoard.dom.test.tsx` — the `U` test above.
- `src/lib/i18n/en.ts`, `src/lib/i18n/uk.ts` — the keys in §5.
- `src/components/kanban/kanbanBoard.browser.test.tsx` — one `describe`
  block for #1856 over `issue1695Evidence.fixture.tsx`: a move, Ctrl+Z, and
  a refusal driven by the fixture's `agentWritesDescriptionQuietly`
  (`issue1695Evidence.fixture.tsx:1393-1399`), which bumps the revision
  where the page cannot see it so the fenced undo meets 409 at
  `:1749`. Screenshots at 1440 in en and uk go to the driver's
  `.artifacts` output (gitignored); the builder copies them to
  `~/Pictures/delegatus-review/board-undo-redo/`.

No route, store, CSS or phone file changes.

## Validation against the requirement

- Move then Ctrl+Z puts the card back, redo moves it again: §2, §6.
- Text edit then undo restores the previous text: `text` entry with the
  whole field, §2.
- Undo against a moved revision says so and changes nothing: the fence and
  the no-recovery 409, §3, and the refusal receipt, §5.
- The header carries no undo/redo buttons: nothing is added to the bar or
  its menu.
- Toast after every edit with Undo, in en and uk: §5 adds the missing text
  receipt and the copy.
- Keys silent in fields, composer and dialogs: §6.
- History per board session, bounded, cleared per project: §1.

## Deferred — not currently justified

- Two ⋯-menu rows naming the next undo and redo (earlier design §3). The
  specification asks for no persistent control.
- A neutral "nothing to undo" receipt on an empty stack.
- Undo of `details` edits, colour, priority, icon, scheme positions, card
  dismissals, reader open/close, agent and pipeline actions.
- "Undo anyway" on a refusal, mirroring `kanban.moveAnyway`. Refusal is
  what the requirement asks for; a force path can be added to the same
  receipt later without touching the fence.
- Persistence across reloads or between tabs, and a visible history list.
- A `replace(id, …)` on `useReceipts`; dismiss-then-show does the same with
  no new API.
