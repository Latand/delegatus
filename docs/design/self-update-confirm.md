# The update confirmation as a Delegatus modal

## The requirement

The operator, 2026-10-11 at about 15:35 Kyiv time, in the orchestrator seat's
conversation. They attached a screenshot of the browser's native `confirm()`
that opens on «Оновити до e7893bc (1.11.0)» in the Оновлення dialog:

> «Некрасиво вот эта хуйня выглядит, вот этот алерт, алерт, нужно его
> переделать. Визуально как-то, чтобы это была модал какая-то и красивая, и
> чтобы было понятно, написано. Что это за задача. Работают. А то так
> непонятно.»

What it asks for: replace the native alert with a modal that looks like the
app, and make it say in plain words which tasks are running.

The lane's brief adds these constraints. Reuse a dialog the app already has
and its buttons. Show the work at desktop 1440 and phone 390, light and dark,
uk and en. Name every running item by its card title, its role in words and
its project's display name, never by a raw `dir-`/`repo-` key or a
conversation hash, and say that it resumes after the restart. Give it a clear
title, one sentence of consequence, «Оновити зараз» and «Скасувати». The
design lane built prototypes only; the build is recorded under
[Decisions](#decisions) and [The build](#the-build).

## Decisions

The operator's answers in the prototype reviews, 2026-10-11:

- **Variant 1, «Список за проєктами».** The running work is listed at once,
  grouped by project, with the project's name as the group heading. Each row
  is the card's title and the role in words. One chip, «усе продовжиться
  після перезапуску», is said once for the list.
- **The second native alert waits.** `SupersededBanner`'s `window.confirm`
  moves onto the same modal in a separate, later change, never in this one.
- **Pending work does not block.** While the work is still being read,
  «Оновити зараз» stays enabled and the modal says «ще читаю».
- **The phone gets a bottom sheet** with the buttons at its bottom.
- **«Оновити зараз» closes the modal**, and the update's progress shows in the
  «Оновлення» card.

## What happened before the build

Before the build, `SelfUpdateDialog.tsx:95` `confirmApply()` joined lines and handed them to
`window.confirm` (`:107`). The three apply actions use it: `update` (`:114`),
`retry` (`:115`) and `installAction` (`:111`). The lines are:

- `selfUpdate.applyConfirm`: «Застосувати оновлення зараз? Веб, runtime host
  і лаунчер перезапустяться. Поточна робота відновиться, а сесія
  перепідключиться.»
- `workEvidence.state === "pending"`: `selfUpdate.work.pendingConfirm`.
  `unavailable`, or `resumeWork.unreadable`: `selfUpdate.auto.block.unreadable`
  with the error.
- When the work was read: two counts («Працюють ходи агентів: 3», «Працюють
  етапи пайплайна: 1»). Then one raw line per stage,
  `${stage.stageId} · ${stage.task}` (for example «review · #3553 повтор
  видалення: …»). Then one raw line per turn outside a stage,
  `${turn.engine} · ${turn.project ?? <12 characters of the conversation id>}`,
  for example «claude · dir-…» and «codex · repo-…» followed by a hash.

Two things there are new to this design. The Update surface already has a
helper that names turns: `blockerRows` / `turnLabel` in `blockerNames.ts:43,57`
does it for the auto-update block and the Needs-you lists. The confirmation
never calls it, so it prints keys. And the Viewer publishes conversation titles
only for `auto.blockers.turnList` and `auto.decision.blockers.turnList`
(`Viewer.tsx:990`), never for `resumeWork.turnList`, so even `blockerRows`
would find no titles for the work this confirmation lists.

## Where each name comes from

The payload is `Snapshot.resumeWork` (`types.ts:179`, a pick of
`QuietBlockers`), built by `quiet.ts`. Its lists are capped at 20 each.

### A running pipeline stage (`BlockingStage`, `quiet.ts:22`)

| Shown as | Today | Source for the human name | Gap |
| --- | --- | --- | --- |
| What the work is | `task`: the first line of `pipeline.task`, cut at 80 characters (`quiet.ts:387`). It often starts with an issue number («#3553 повтор видалення: …») and stops mid-word. | The board card's first line, `BoardTask.text`, for `pipeline.taskIds[0]` (`pipelines/types.ts:997`). The client already holds every stored task through `/api/files`: `reconcileTasks` does not filter by scope. | **The API adds `taskId`** (from `pipeline.taskIds[0]`, which `quiet.ts` already has in hand at `:387`). The client maps it to the card title and falls back to `task` for a legacy lane with no card. |
| Who does it | `stageId` («review», «implement»), which is an id and not a word | The stage's role: `pipeline.stages[id].role.roleId` → `roleNameById` (`builderCopy.ts:28`), the same name the board's stage chip shows («Рев'юер», «Білдер», «Архітектор») | **The API adds `roleId`**. The client cannot look it up itself: `/api/files` sends only the pipelines its current scan can see (`filterPipelinesForFileScan`), so a lane in another project is often missing. With no role, show `stageDisplayName`'s rule over the id. |
| Where | nothing | `pipeline.project` → `projectTitle(key, projectDisplayNames[key], cachedProjectName(key))` (`displayNames.ts:61`). The display-name map covers the whole catalog, and the browser's cache covers a cold start. | **The API adds `project`**, for the same reason as `roleId`. |

A review flow with no parent pipeline is listed as `pipelineId: "flow:<id>"`
(`quiet.ts:404`). It has no card and no role, so it shows its `task` text, the
words «цикл ревью» (`pipelineStrip.reviewStage`) and «Проєкт без назви» unless
the flow names a project.

### A running agent turn outside a stage (`BlockingTurn`, `quiet.ts:17`)

| Shown as | Today | Source for the human name | Gap |
| --- | --- | --- | --- |
| What the work is | The engine, or 12 characters of the conversation id | (1) The card the conversation works for: the task whose `assignments[].conversationId` (`tasks/types.ts:233`) names it. The client has every task. (2) Else the conversation's own title from the Viewer's files (`cleanTitle(file.title)`). (3) Else «Агент Claude». | **Client only:** add `resumeWork.turnList` to the set `Viewer.tsx:990` publishes titles for, and publish the card titles as well. A conversation outside the current scan has no title on the client and falls to (3). `title` from the server would close that last gap. It is optional, and this design does not ask for it. |
| Who does it | the engine key | `seat: true` → «Оркестратор» (`selfUpdate.auto.block.seatUnnamed`). Otherwise «Агент {engine}» (`selfUpdate.auto.block.agent`). Both keys exist. | none |
| Where | the project key | `project` (resolved from the cwd by `projectInfoFromCwd`, `quiet.ts:452`) → `projectTitle(…)`. This is null when the cwd is unknown, and also for a `dir-` key that the catalog gives no name. | Both read as «Проєкт без назви» / «Unnamed project», muted. The key itself is never shown. |

A turn that belongs to a listed stage (`turn.stage` set) is folded into that
stage's row, as it is today.

### Whether the work is known

`workEvidence.state` (`types.ts:208`):

- `pending`: no reading has landed yet. The modal says it is still reading and
  lists nothing. «Оновити зараз» stays available, as it is today.
- `unavailable`, or `resumeWork.unreadable`: the reason is shown in the app's
  danger line.
- Neither state is ever drawn as "no work".

### What it would take

- **Server:** three fields on `BlockingStage` (`project`, `roleId`, `taskId`),
  all read from the `pipeline` object `quiet.ts` already loops over. There are
  no new reads and no change to what blocks a restart.
- **Client:** extend `BlockerNames` with card titles by task id and by
  conversation, and publish names for `resumeWork`. Write one row resolver
  beside `blockerRows`; the prototype's `rows.ts` is that resolver.

## The variants

Every variant uses the same rows. Each running item shows:

- its title: the card's, else the conversation's;
- who does it: the role, «Оркестратор» or the engine's agent;
- its project's display name.

Every variant says that the work continues after the restart. The copy is in
`prototypes/self-update-confirm/copy.ts`. The title is «Оновити до e7893bc
(1.11.0)?», and «Повторити оновлення?» for a retry, whose target moves into the
body («Повторна спроба оновлення до …») so the title fits one line at 390 px.
The consequence
sentence is «Delegatus перезапуститься, а ця сторінка перепідключиться сама.
Робота, що зараз іде, продовжиться після перезапуску.» The buttons are
«Оновити зараз» and «Скасувати».

### 1 — Список за проєктами (the list, grouped by project)

The window is `TeamDialog` (`team/ui.tsx:110`): centred and 480 px wide on the
desktop, a bottom sheet on the phone. It has the app's `BUTTON.primary` /
`BUTTON.secondary` (`team/ui.tsx:17`).

- Below the sentence: «Зараз працює 6» with one green «↻ усе продовжиться
  після перезапуску» chip beside it, then the rows grouped under each
  project's name. An unnamed project's heading is muted and italic.
- Each row: a kind icon (stage, orchestrator, agent), the title in at most two
  lines, and the role underneath. Every item resumes the same way, so the
  chip is said once for the list. The critic pass removed an earlier chip on
  every row: it repeated the sentence six times and cut phone titles short.
- The dialog has one scroller. The buttons are pinned to its bottom edge, so a
  list of 20 or more scrolls under them and never pushes them off.

It answers the requirement head-on: the reader sees which tasks run, in which
project, and that each one comes back.

### 2 — Підсумок і «Показати» (one line, the list on request)

The same window and buttons.

- Below the sentence there is one line: «↻ 6 робіт продовжаться після
  перезапуску», with «Показати ⌄».
- Opened, it lists the rows flat, with «role · project» under each title and no
  chips.
- This is the quietest variant: the confirmation stays one sentence and one
  line. But the names the operator asked for are one tap away instead of on
  screen.

### 3 — У картці «Оновлення» (the card asks in place)

No second window. «Оновити» in the Update card arms a confirmation inside the
card, the way «Перезапустити runtime host» already asks (`SelfUpdateView.tsx:634`).

- The confirmation is an accent panel. It holds «Оновити зараз?», the
  sentence, a compact list (one line per row on the desktop, two on the phone)
  and the Update surface's own buttons.
- «Оновити» is disabled while the panel is open.
- The card has no scroller of its own, so the panel names five rows and counts
  the rest («і ще 18»), the way the card's changelog counts («ще 3»).
- It adds the least chrome. It is not the modal the operator asked for, and it
  shows only the first five items of a long list.

## The frames

The prototype (`prototypes/self-update-confirm/`: `variants.tsx`, `copy.ts`,
`fixture.ts`, `rows.ts` and the harness `render.ts`) stayed in the design
lane's worktree and is not committed: it was the visual reference for the
build, and the build's evidence runs through the kanban driver (see
[The build](#the-build)). Its harness, `bun prototypes/self-update-confirm/render.ts`,
did the following:

1. Exports the committed tree into a scratch directory under `$TMPDIR`.
2. Copies the prototype beside it and links the dependencies of the main
   checkout.
3. Gives the export's `SelfUpdateView` one slot for variant 3.
4. Bundles `main.tsx` with Bun and compiles the app's Tailwind tokens.
5. Drives headless Chromium. `CHROME_BIN` overrides the browser, and the
   newest Playwright headless shell is the default.

Every frame renders the real Update dialog (`SelfUpdateView` over the fixture
snapshot) behind or around the variant. A band above the app prints the
variant number and name, the viewport, the theme, the language and the state.

The PNGs are written to `prototypes/self-update-confirm/frames/`, which is
ignored by Git. The publication gate admits a raster only with a deterministic
generator, and a browser capture is not one. `frames.json` recorded each
frame's measured geometry.

A frame fails the run when any of these happens:

- a button is not fully inside the screen (for variant 3, inside the Update
  dialog's scroller);
- the title is cut;
- the confirmation overflows sideways;
- a `dir-`/`repo-` key or a `conversation_` id appears in its text;
- the page throws.

All 29 frames pass.

The fixture is built to be ugly:

- three stages, one with a 120-character card title;
- a seat turn;
- a turn in a `dir-` folder with no catalog name;
- a Codex turn with no conversation title;
- a turn inside a stage, which must not be listed twice;
- `pending` and `unavailable` evidence;
- a long-list frame: 20 stages, each with its own card title and role, plus
  the turns, 23 rows.

Rows column: the rows fully visible without scrolling, out of the rows
rendered. Buttons column: the top and bottom of the buttons, in px from the
top of the viewport.

| Frame | Confirmation | Rows | Buttons (y) |
| --- | --- | --- | --- |
| v1 desktop light uk ready | 480×612 | 6/6 | 703–743 |
| v1 desktop dark en ready | 480×612 | 6/6 | 703–743 |
| v1 desktop light uk pending | 480×259 | — | 527–567 |
| v1 desktop light en unavailable | 480×241 | — | 518–558 |
| v1 phone light uk ready | 390×697 | 6/6 | 727–831 |
| v1 phone dark en ready | 390×697 | 6/6 | 727–831 |
| v1 phone dark uk pending | 390×327 | — | 727–831 |
| v1 phone light uk unavailable | 390×327 | — | 727–831 |
| v1 phone light uk long list | 390×743 | 7/23, scrolls under the buttons | 727–831 |
| v2 desktop light uk ready, closed | 480×249 | — | 522–562 |
| v2 desktop dark en ready, open | 480×566 | 6/6 | 680–720 |
| v2 desktop light uk ready, open | 480×566 | 6/6 | 680–720 |
| v2 desktop light uk pending | 480×259 | — | 527–567 |
| v2 desktop light en unavailable | 480×241 | — | 518–558 |
| v2 phone light uk ready, closed | 390×329 | — | 727–831 |
| v2 phone dark en ready, open | 390×658 | 6/6 | 727–831 |
| v2 phone light uk ready, open | 390×662 | 6/6 | 727–831 |
| v2 phone dark uk pending | 390×327 | — | 727–831 |
| v2 phone light uk unavailable | 390×327 | — | 727–831 |
| v2 phone light uk long list, open | 390×743 | 7/23, scrolls under the buttons | 727–831 |
| v3 desktop light uk ready | 669×337 | 6/6 | 600–632 |
| v3 desktop dark en ready | 669×319 | 6/6 | 591–623 |
| v3 desktop light uk pending | 669×178 | — | 479–511 |
| v3 desktop light en unavailable | 669×160 | — | 461–493 |
| v3 phone light uk ready | 328×566 | 6/6 | 622–718 |
| v3 phone dark en ready | 328×548 | 6/6 | 613–709 |
| v3 phone dark uk pending | 328×278 | — | 478–574 |
| v3 phone light uk unavailable | 328×278 | — | 478–574 |
| v3 phone light uk long list | 328×566 | 5 + «і ще 18» | 622–718 |

Phone buttons are 48 px tall (`max-sm:h-12`) in variants 1–2 and 44 px in
variant 3 (the Update surface's `max-sm:h-11`).

## Recommendation

**Variant 1.** It is the only one that puts what the operator asked for on
screen without a tap: which task, in which project, by whom, and that it comes
back. It reuses an existing dialog and its buttons with no new chrome. And with
one pinned footer it stays usable at the server's 20-item cap.

- Variant 2 hides the names the operator complained were missing.
- Variant 3 is lighter, but the operator asked for a modal, and its long list
  shows only the first five items.

## What the build must also handle

- **Keyboard ownership.** `SelfUpdateDialog` listens on `window` in the
  capture phase and stops Escape itself (`SelfUpdateDialog.tsx:153,185`). A
  `TeamDialog` opened over it would see Escape close the whole Update dialog
  instead of the confirmation. The build has two ways to fix this, and either
  works. One: move the Update dialog onto `useModalLayer`, the stack
  `TeamDialog` already uses, so only the top layer answers. Two: give the
  confirmation the role `armed` plays today, so Escape cancels it first.
  Variant 3 inherits the second for free.
- **`TeamDialog` lives in `components/team`.** Using it from `selfUpdate` is
  fine, but the build may lift it to a shared place under the same name if a
  reviewer objects to the import path. Its markup must not change.
- **One confirmation for three actions.** `update`, `retry` and
  `installAction` open the same modal. Only the title changes, and the
  primary button runs the action that opened it, in that action's words:
  «Оновити зараз» for update and retry, «Перезапустити лаунчер» (the title's
  own verb) for the install action, which restarts the launcher and updates
  nothing. The action stays exactly as it is
  now: the server still reads its own fresh drain admission, and the list is
  display only (`types.ts:177`).
- **No new strings where keys exist.** «Оркестратор», «Агент {engine}», the
  role names and «Скасувати» are existing keys. The new keys go under
  `selfUpdate.confirmApply.*`, in uk and en, with Ukrainian plurals for the
  count in variant 2.
- **Rendered evidence.** It belongs in the existing drivers; the brief forbids
  a new one-shot driver. This prototype's `render.ts` is a design harness, not
  a product driver, and is not meant to outlive the build.

## Questions for the operator

Both are answered under [Decisions](#decisions).

1. **Which variant?** 1, 2 or 3. Recommended: 1. Chosen: 1.
2. **The second native alert.** `SupersededBanner.tsx:106` also uses
   `window.confirm` (`superseded.resumeConfirm`). Should the build move it onto
   the same modal? Recommended: yes, as a separate small change after this one,
   so this build stays one surface. Chosen: yes, separately.

## Deferred — not currently justified

- Per-item controls in the confirmation (pause this one, wait for that one).
  The auto-update drain already waits for quiet, and nobody asked for this.
- A countdown or an estimated restart time. No measured restart duration
  exists to quote honestly.
- A server-side conversation title on `BlockingTurn`. The client can name
  every conversation in its scan. A turn outside the scan falls back to
  «Агент Claude», which is honest. Add the title only if that fallback shows up
  in practice.
- Waiting in the modal until a `pending` reading lands. Today the reading
  lands within seconds and the operator may update anyway. The modal says it is
  still reading.

## The build

- **Server.** `BlockingStage` (`src/lib/selfUpdate/quiet.ts`) carries
  `project`, `roleId` and `taskId`, read from the pipeline record the probe
  already loops over. A review flow inherits them from its parent pipeline
  and carries null without one. Nothing about what blocks a restart changed.
- **Names.** `workRows` and `groupWorkRows` in
  `src/components/selfUpdate/blockerNames.ts` resolve each row: a stage by its
  card's title (else the lane's text), its role (else a review flow's «цикл
  ревью», else its stage id when that is a word); a turn by the card it
  works for, else its conversation's title, else its agent; a seat as
  «Оркестратор». A project with no readable name is grouped last under
  «Проєкт без назви». The Updates dialog's feed carries the work and the
  Viewer's feed does not, so the confirmation asks the Viewer for the names it
  needs (`wantBlockerNames`), and the Viewer publishes card titles by task id
  and by conversation beside the names it published before.
- **The modal.** `SelfUpdateConfirm.tsx` is `TeamDialog` with `BUTTON.primary`
  / `BUTTON.secondary`, unchanged. `update`, `retry` and `installAction` open
  it; only the title changes («Оновити до …?», «Повторити оновлення?»,
  or the install action's own words). The buttons are pinned to the bottom of
  the dialog's one scroller. A reading that counted more than the server's
  20-item lists says «і ще N»; a reading with counts and no list says the
  counts. If something else starts updating while it is open, it closes.
- **Escape.** `SelfUpdateDialog` still listens on `window` in the capture
  phase. While the confirmation is open, its Escape cancels the confirmation
  only, and it leaves Tab to the confirmation's own modal layer.
- **Closing into progress.** «Оновити зараз» closes the modal and runs the
  action exactly as before. Focus stays in the Updates dialog, which scrolls
  its Update card into view, where the running update shows its steps.
- **Evidence.** The `self-update confirmation modal` block in
  `src/components/kanban/kanbanBoard.browser.test.tsx` frames the modal at
  1440 and 390, light and dark, uk and en, over the evidence fixture's own
  cards: ready, pending, unavailable, a 20-stage list and the progress after
  «Оновити зараз». It fails a frame whose button is off screen, whose title is
  cut, which overflows sideways, which shows a project key or a conversation
  id, or whose phone sheet is not a bottom sheet.
