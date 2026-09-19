# UI design batch, September 2026: five surfaces

**Originating requirement** (pipeline task, 2026-09-19, written by the orchestrator seat for the operator; verbatim): "UI design batch by Fable: stage card labels, seats out of the task columns, kanban undo, accounts chart, account removal dialog." For each item: "the problem in one paragraph; the design precise enough to build without guessing (regions, sizes, type, spacing, colour roles from existing tokens, states incl. empty/error/loading, exact copy in English and Ukrainian, desktop 1440 and 1280, phone 390, light and dark; ASCII wireframes welcome); what is deliberately left out; a build plan with file fences and the rendered evidence the build must produce. Look good, not only tidy: visual quality is a requirement. Keep each design as small as the problem allows."

Each item quotes its own issue where the issue carries the operator's words.

**Prior work.** `search_transcripts`, project-scoped then unscoped: "previous seats orchestrator panel side placement collapse", "burndown sparkline account row", "kanban undo redo Ctrl+Z toast". No earlier design of any of the five exists. The only related hits are the header lane (PR #1855, `docs/design/board-header.md` on its branch), which this document is written to fit, and the removal investigation (`docs/investigations/1857-account-removal.md`), which item 5 builds on.

**How this was grounded.** Every surface below was read in the code on `main` at `72154d4ae`. The production Viewer was left alone: the machine had 7.0 GB available with 13 GB in swap after the day's OOM, one gigabyte over the stated floor, and a headless Chrome was judged a poor trade for facts the code already gave.

**Shared conventions for all five.**

- Tokens only, all existing: surfaces `--surface-card`, `--surface-well`, `--surface-canvas`; borders `--border-default`, `--border-strong`; text `--color-primary`, `--color-muted` (Tailwind `text-secondary` in the accounts panel); signal `--color-accent`, `--color-success`, `--color-warning`, `--color-danger` with `accent-soft` / `danger-soft` fills; engine `--color-claude`, `--color-codex` through `engineTintOf`; shape `--radius-control` (8 px), `--radius-surface`; elevation `--shadow-1`, `--shadow-2`; type `--text-body`, `--text-ui`, `--text-label`, `--text-caption`; motion `--motion-base` with `--ease-standard`. Dark theme is the same tokens; no colour below is written by hand.
- Board controls follow the header's one control style (`board-header.md` §1.2): 32 px tall, 8 px radius, 12 px / 600 text, 15 px icons, variants *outlined*, *pressed*, *quiet icon*. Inside a column head or a seat head, where the row is 46 px or less, the quiet icon is 28 × 28.
- Touch targets on the phone are 44 px, as the accounts panel and the board CSS already enforce.
- Ukrainian copy keeps the existing plural machinery of `src/lib/i18n`; where a count appears, the three Ukrainian forms are given.

---

## 1. Stage cards say which stage they are (#1865)

### Problem

A pipeline stage has an id its author chose (`design`, `critique`) and a role preset from the registry (`architect`, `builder`, `reviewer`). The stage graph and the stage list already name a stage by its id (`stageDisplayName`, `PipelineSection.tsx:136`, from #1765). The conversation surfaces never got that rule: the member tile on a task card (`KanbanCard.tsx:100`, `memberRole`), the reader header (`KanbanReaders.tsx:217`), the phone's queue row (`MobileBoard.tsx:248`), the phone's attention sheet (`MobileAttentionSheet.tsx:145`), the phone's stage row (`MobilePipelineScreen.tsx:302`) and the scheme chip (`scheme/nodes.tsx:1211`) all call `stageChipLabel`, which returns the role name. A design stage and a critique stage that share the `architect` preset therefore draw two tiles reading "Architect", every retry adds a third, and only the age differs. The operator read "architect" as a separate kind of agent.

### Design

**One label function, one wording, every surface.**

```
stageCardLabel(t, stage, attempt) =
    stageDisplayName(t, stage)                      when the stage has one operational attempt
    stageDisplayName(t, stage) + " · " + attempt.n  when it has two or more
```

- `stageDisplayName` keeps its #1765 rule unchanged: the humanized id (`Critique`, `Build ui`), falling back to the role name when the id only repeats the role, is generic (`stage-2`) or is an identifier.
- The number is the attempt's own `n` among `operationalAttempts` (lineage-adopted history never counts). It appears on **every** tile of a stage once that stage has a second attempt, so the first run reads `Critique · 1` beside `Critique · 2`. A stage that ran once reads `Critique`, with no number to decode.
- Capitalisation follows the stage list (`Critique`), so the card and the list match letter for letter. The issue's lower-case `critique · 2` illustrated the shape.

**Where the role preset goes.** It leaves the label. It stays:

| Surface | Role preset |
|---|---|
| Member tile | in the tile's `title` and `aria-label` |
| Reader header | in the header's `title`; the header text becomes `Critique · 2 · <card title>` |
| Pipeline sheet pane | unchanged: `.prole-role` already prints it as secondary text beside the stage name (`StagesSheet.tsx:436`) |
| Phone stage row | moves from the title into the meta line, first segment |
| Phone queue row, attention sheet | dropped; the sentence names the stage |

Where the role name equals the label (a stage called `builder` on the `builder` preset) the tooltip omits it.

**The tile** (`.tile` in `KanbanCard`, 12 px engine mark, then label, then state word; geometry unchanged):

```
before                                  after
┌──────────────────────────────┐        ┌──────────────────────────────┐
│ ✳ Architect          working │        │ ✳ Critique · 2       working │
│   reading the header render… │        │   reading the header render… │
│                       2 min  │        │                       2 min  │
└──────────────────────────────┘        └──────────────────────────────┘
┌──────────────────────────────┐        ┌──────────────────────────────┐
│ ✳ Architect             done │        │ ✳ Critique · 1          done │
└──────────────────────────────┘        └──────────────────────────────┘
┌──────────────────────────────┐        ┌──────────────────────────────┐
│ ✳ Architect             done │        │ ✳ Design                done │
└──────────────────────────────┘        └──────────────────────────────┘
```

- Label: the existing `.role` style (`--text-ui`, 600, `--color-primary`), truncating with an ellipsis. The ` · 2` suffix is a separate `<span class="attempt">`: `--color-muted`, 600, `font-variant-numeric: tabular-nums`, `flex-shrink: 0`, so a long stage name truncates and the number survives.
- No new colour, no badge, no icon. The number is text because the circled-number vocabulary (`CountCircle`) already means "times an edge fired" and may not take a second meaning.

**Copy.**

| Key | en | uk |
|---|---|---|
| `kanban.stageAttempt` (label join) | `{stage} · {n}` | `{stage} · {n}` |
| `kanban.stageTileTitle` (tooltip, several attempts) | `{stage}, attempt {n} of {total} · {role} · {engine}` | `{stage}, спроба {n} з {total} · {role} · {engine}` |
| `kanban.stageTileTitleOnce` (tooltip, one attempt) | `{stage} · {role} · {engine}` | `{stage} · {role} · {engine}` |
| `kanban.openMember` (existing aria) | unchanged; receives the new label as `{role}` | unchanged |
| `mobile2.pipeline.stageTitle` | `{stage}` (was `{role} · {stage}`) | `{stage}` |
| `mobile2.pipeline.stageMetaRole` (new first meta segment) | `{role}` | `{role}` |

**States.** A member that is no stage keeps its conversation title, as today. A stage whose attempt cannot be resolved (a path the pipeline record no longer lists) draws the stage name without a number. There is no loading or error state: the label is derived from the pipeline record the card already holds.

**Viewports.** 1440 and 1280: tiles are 100 % of the card column in the shelves (about 196–208 px of text) and fixed-width in the workspace; `Critique · 2` needs 78 px, and the longest realistic name (`Review plan · 12`) needs 112 px, so nothing truncates in the fixtures. 390: the queue row sentence reads `stage 3/5 · critique · 2 · review failed`; the lower-casing inside the sentence stays as the phone already does it. Light and dark share the tokens.

### Deliberately left out

- A `critic` role preset. The label fix does not depend on it, and a new registry role is a change to spawn policy that deserves its own issue.
- `PipelineStrip` (the Conversations view's strip): its chips sit in chain order with `stage k/n` positions, and `stagePaneTitle` already prints the stage id.
- Renaming stage ids, or letting the operator rename a stage from the card.

### Build plan

Fence: `src/components/pipelines/pipelineModel.ts` (move `stageDisplayName`, its two regexes and `stageNames` here beside `stageChipLabel`, so the phone imports them without pulling a kanban component; add `stageCardLabel`), `src/components/kanban/PipelineSection.tsx` (re-export or import), `src/components/kanban/kanbanModel.ts` (`KanbanMember.stage` gains `attempt: number | null` and `attempts: number`, filled where `stageByPath` is built), `KanbanCard.tsx`, `KanbanReaders.tsx` (`owner.stage` carries the same two numbers), `src/components/mobile/MobileBoard.tsx`, `MobilePipelineScreen.tsx`, `src/components/attention/MobileAttentionSheet.tsx` (label call only; the attention logic stays fenced), `src/components/scheme/nodes.tsx:1211-1213`, `kanbanBoard.css` (`.tile .attempt`), `src/lib/i18n/en.ts`, `uk.ts`.

Tests, red first: `stageDisplayName.test.ts` gains `stageCardLabel` cases (one attempt, two attempts, historical attempts ignored, unresolved attempt); `KanbanStages.dom.test.tsx` renders a lane with `design` and `critique` on `architect`, `critique` attempted twice, and asserts three distinct tile labels equal to the stage list's names.

Rendered evidence: one `describe` block in `kanbanBoard.browser.test.tsx` over `issue1695Evidence.fixture.tsx` with that lane, at 1440 and 1280, en and uk, light and dark, asserting the three labels, that no `.role` is truncated, and that the reader header carries the same label. The phone driver (`issue1671Evidence.browser.test.tsx`) gains one case at 390 × 844 for the queue row and the stage row.

---

## 2. Orchestrator seats get their own place; the panel docks and collapses; columns expand (#1841, with #1801 items 2 and 3)

**Operator, 2026-09-19, as paraphrased in #1841:** "I do not like orchestrators appearing in my list of tasks. An orchestrator has nothing to do with a task. Either do not show it there, or give orchestrators a separate column, if that makes sense given the orchestrator panel at the top. Previous seats should not sit there either. I still need to be able to see them, so they need a special place, outside the other tasks."

**Operator, as paraphrased in #1801:** "show the orchestrator either at the side as before, or sliding out from the top as now, but so that it is convenient to collapse it with a button and not show it, both vertically and horizontally." And: "it is inconvenient to work with done / blocked / inbox because they are constantly collapsed; maybe some way to expand them, and have them shrink back automatically."

### Problem

Every seat launch mints a board task with the seat conversation as its assignment. It draws a band in Assigned beside product work and stays after a rotation, because nothing marks it done; on 2026-09-19 the board carried five. The seat panel above the columns (`KanbanSeat` around `OrchestratorPanel variant="seat"`) already is the seat's home, yet it shows only the current seat, has one placement, and its smallest form is a 46 px head that never goes away. The three shelf columns are fixed at 232 px (220 px under 1400), so their titles wrap to three words a line and nothing widens them.

### Design

Four parts. A and B are #1841; C and D are the parts of #1801 the header lane deferred. They share one owner of `OrchestratorPanel` and one of the column grid, so they ship as two PRs in this order: A+B, then C+D.

#### A. Seat conversations draw no band

Rule, applied in `buildKanbanModel` (`kanbanModel.ts`) where bands become cards:

1. A **seat conversation** is any conversation the project's seat record names: the active seat, a pending intent, or a revocation (`OrchestratorSeatFile.revocations`, already durable in `src/lib/orchestrator/seats.ts`).
2. Seat conversations are removed from every band's members before anything is counted.
3. A band whose task then has no members, no pipeline and no assignment outside the seat set draws **nothing**: no card in any column, no share of a column counter, no share of `totals.working`, no row in the Tasks panel and no share of `Tasks N`. The task row itself stays in the store; it is where the seat keeps its notes (`details`).
4. A band that mixes a seat with real work keeps its card and loses only the seat's tile. Work a seat launches keeps grouping under the outcome's task exactly as now.

The board's `SeatRefs` input (`groupHide.ts`) widens from the current seat to `{ conversationIds, paths, previous: [...] }`, fed by the seat status read the page already polls once. Rotation therefore retires the old seat's card with no write by anyone: the revocation the rotation already records is what moves it.

The phone's board applies the same filter to its Working and Needs-you rows.

#### B. "Previous seats" in the seat head

The seat head loses the `Stays on the board` lock pill (it explained why the seat's card could not be hidden, and that card no longer exists) and gains, in the same position, one outlined 28 px control:

```
┌─ seat head, 46 px ───────────────────────────────────────────────────────────────────────────┐
│ (🤖) Orchestrator  harbor  ● working   [⟲ Previous seats 2]   claude · opus · ▮▮▮▯▯  [Rotate] │
│                                                                    [▤ side]  [⌃ Collapse]     │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

- Icon `History` 14 px, label, count in `tabular-nums`. Hidden at zero and while the seat read is loading or failed (the panel's own loading and error states already cover those).
- It opens a popover (the `KanbanMenu` surface: `--surface-card`, `--border-default`, `--shadow-2`, radius `--radius-surface`), **340 px wide**, max height `min(420px, 60vh)`, scrolling inside, anchored under the control, closed by default, closed by Escape or an outside click.

```
┌ Previous seats ──────────────────────────────────┐   header: --text-label, 600, --color-muted, 12 px 14 px
│ ✳ Manager seat, release week                     │   row: 52 px min, padding 8 px 14 px, hover --surface-well
│   18 Sep 14:02 – 19 Sep 03:10 · 13 h      Notes ›│   line 1: --text-ui 600 primary, truncates
│ ──────────────────────────────────────────────── │   line 2: --text-caption muted, tabular-nums
│ ✦ Orchestrator seat                              │   12 px engine mark in the engine colour
│   17 Sep 09:40 – 18 Sep 14:02 · 28 h      Notes ›│   rows newest first, 1 px --border-default between
└──────────────────────────────────────────────────┘
```

- Clicking a row opens that conversation through the existing `#c=<conversationId>` link the lineage chip uses, and closes the popover.
- `Notes ›` (quiet text button, `--color-accent`, 600) expands that row in place to show the seat task's `details`: `--text-caption`, `white-space: pre-wrap`, `--surface-well` fill, 8 px radius, 10 px padding, max height 220 px with its own scroll. One row is open at a time. A seat with no notes draws no `Notes` button.
- The **current** seat's notes are reached the same way: the popover's first row, under the sub-header `Current`, is the live seat with its `Notes ›`; it shows `since 19 Sep 03:10` for its time. With a live seat and no previous ones the control reads `Seat notes` and opens the same popover with that one row; with neither notes nor previous seats it is hidden.
- Time format: the locale's short date plus 24 h clock; the year appears only when it differs from today's. Duration in the largest sensible unit (`42 min`, `13 h`, `3 d`). A revocation written before this change has no start time; its row shows `until 19 Sep 03:10`.

Data: the seat status answer (`/api/orchestrator/seat`) gains `previous: [{ conversationId, path, title, engine, heldFrom, heldTo, taskId }]`, newest first, at most 20. `heldTo` is `revokedAt`. `heldFrom` comes from a new `activatedAt` copied onto the revocation when it is written; older revocations fall back to the conversation's first message time and otherwise omit it. `taskId` is the task whose assignment names the conversation, for the notes read (`get_task` shape, `details` only).

Phone (390): the orchestrator sheet (`MobileOrchestratorSheet`) gains one 44 px row under the seat, `Previous seats 2 ›`, opening a list screen with the same two-line rows at 56 px and `Notes` as a sub-screen. The phone's board section `Orchestrator` is otherwise unchanged.

**Copy.**

| Key | en | uk |
|---|---|---|
| `orchPanel.previousSeats` | `Previous seats` | `Попередні оркестратори` |
| `orchPanel.previousSeatsAria` | `Previous seats, {count}` | `Попередні оркестратори: {count}` |
| `orchPanel.seatNotesOnly` | `Seat notes` | `Нотатки оркестратора` |
| `orchPanel.seatCurrent` | `Current` | `Поточний` |
| `orchPanel.seatHeld` | `{from} – {to} · {duration}` | `{from} – {to} · {duration}` |
| `orchPanel.seatHeldUntil` | `until {to}` | `до {to}` |
| `orchPanel.seatHeldSince` | `since {from}` | `з {from}` |
| `orchPanel.seatNotes` | `Notes` | `Нотатки` |
| `orchPanel.seatNotesLoading` | `Loading notes…` | `Завантаження нотаток…` |
| `orchPanel.seatNotesFailed` | `Could not load the notes.` + action `Retry` | `Не вдалося завантажити нотатки.` + `Повторити` |
| `orchPanel.seatUntitled` | `Orchestrator seat` | `Оркестратор` |
| durations | `{n} min` / `{n} h` / `{n} d` | `{n} хв` / `{n} год` / `{n} дн` |

Deleted once unused: `orchPanel.seatStays`, `orchPanel.seatStaysTitle`.

#### C. Placement and collapse

**Two placements, remembered per browser** (`kanbanSeatStore`, storage key bumped to `llv:kanban-seat:v2`; v1 height and collapsed flags are read once and carried over):

- **Top** (default, as now): centred above the columns, max 1040 px, height `clamp(160px, 30vh, 360px)` or the dragged value, horizontal grip below.
- **Side**: a column at the **left** of the board region, between the rail and the columns, where `OrchestratorDock` sat before the kanban face. Width 380 px by default, dragged between 320 and 560 px with a vertical grip on its right edge (the same 14 px hit area and 44 × 4 px bar as the top grip, rotated), stored as `width`. Full height of the board region under the 48 px bar. The conversation and composer inside are `OrchestratorPanel variant="seat"` unchanged; only the frame differs.
- The switch is one quiet 28 px icon button in the seat head, left of Collapse: `PanelLeft` when the panel is on top (tooltip `Dock at the side`), `PanelTop` when at the side (`Dock at the top`).

**One collapse state, two shapes.** Collapsed means the conversation is unmounted from view and the board takes the space:

```
top, collapsed: one 40 px strip, same centred 1040 px box
┌──────────────────────────────────────────────────────────────────────────────┐
│ (🤖) Orchestrator  ● working   ● new reply            [⟲ 2]  [▤]  [⌄ Expand] │
└──────────────────────────────────────────────────────────────────────────────┘

side, collapsed: a 44 px rail, full height
┌────┐
│ 🤖 │  26 px avatar in the engine colour, 9 px from the top
│ ●  │  8 px state dot: success = working, warning = needs you, muted = idle, danger = failed
│ ●  │  8 px accent dot while a reply is unread
│    │
│ ⟩  │  28 px expand button, bottom-aligned 9 px from the bottom
└────┘
```

- The strip drops from 46 to 40 px and hides the project name, the incumbent line, Rotate and the host controls; it keeps the state word, the unread marker, Previous seats (count only, icon + number) and the placement switch.
- The whole rail is one button (`aria-expanded="false"`); the dots carry `title`s with the existing state words.
- The header's `Orchestrator` toggle (`board-header.md` group 6) drives this same state: *pressed* means expanded. While collapsed, its icon carries the state dot (6 px, bottom-right of the icon, same colour rule), so the state stays readable even with the strip scrolled away.
- Keyboard: `O` toggles collapse in both placements while the board has focus and no text field, sheet or menu does. The board's key handler binds only `/` and `U` today, so the key is free. Focus moves into the composer on expand and back to the toggle on collapse.
- Motion: height or width animates over `--motion-base` with `--ease-standard`; `prefers-reduced-motion` switches at once.
- A window under 800 px tall still starts collapsed, as `SEAT_SHORT_WINDOW` has it. At 1280 the side placement leaves the columns 652 px, so the board enters its existing `scroll` mode; the default there stays Top, and the operator's choice is respected when they pick Side.

| Key | en | uk |
|---|---|---|
| `orchPanel.dockSide` | `Dock at the side` | `Закріпити збоку` |
| `orchPanel.dockTop` | `Dock at the top` | `Закріпити зверху` |
| `orchPanel.seatResizeWidth` | `Resize the orchestrator panel` | `Змінити ширину панелі оркестратора` |
| `orchPanel.railAria` | `Orchestrator, {state}. Expand` | `Оркестратор, {state}. Розгорнути` |
| existing `orchPanel.seatCollapse` / `seatExpand` | tooltips gain ` (O)` | ` (O)` |

#### D. A column can take the wide share

- Each column head gains, at its right edge, one quiet 28 px icon button: `Maximize2` (`Widen {column}`) on a narrow column, `Minimize2` (`Back to narrow`) on the wide one. On Assigned in the default layout no button draws: it already is the wide one.
- Widening a column swaps the grid shares: that column takes `minmax(var(--work-min), 1fr)` and the dot-grid workspace background; Assigned takes the shelf width (`minmax(232px, var(--shelf-w))`, 220 px under 1400) and the `--surface-well` fill. One wide column at a time; widening another narrows the previous one. The transition animates `grid-template-columns` over `--motion-base`.
- **It gives the space back by itself.** A wide shelf returns to narrow when the operator goes back to work in Assigned: a pointer down or a focus landing on a card inside Assigned. Reading, scrolling or opening a card inside the wide column never narrows it.
- **Pin.** While a shelf is wide its head also shows a quiet `Pin` button (`Keep wide`); *pressed* variant when on. A pinned column stays wide through work in Assigned and across reloads (`llv:kanban-wide:v1`, per browser, one column id or none). Widening another column unpins.
- In `scroll` mode (under 1200 px of board) the same control swaps the 480 px and 280 px flex bases. In `tabs` mode (under 768 px) columns are already full width, so no control draws. The phone has no columns.

```
default, 1440 (board 1192 px)                       Done widened
┌ Inbox 3 ⤢┐┌ Assigned 5 ● 3 working ─────┐┌ Blocked 1 ⤢┐┌ Done 24 ⤢┐      ┌ Inbox 3 ⤢┐┌ Assigned 5 ⤢┐┌ Blocked 1 ⤢┐┌ Done 24  📌 ⤡ ───────────┐
│ 232      ││ 1fr, dot grid               ││ 232        ││ 232       │      │ 232      ││ 232         ││ 232        ││ 1fr, dot grid           │
```

| Key | en | uk |
|---|---|---|
| `kanban.columnWiden` | `Widen {column}` | `Розширити «{column}»` |
| `kanban.columnNarrow` | `Back to narrow` | `Повернути вузьку` |
| `kanban.columnPin` | `Keep wide` | `Тримати широкою` |
| `kanban.columnUnpin` | `Stop keeping wide` | `Не тримати широкою` |

**States across A–D.** Seat read loading: the panel's existing loading state; no Previous seats control. Seat read failed: the existing failure state; bands fall back to today's drawing with the current seat only, since hiding work on an unreadable record would be worse than showing a seat card. No seat at all: the create draft, as now, in either placement; collapse still works. Notes loading and failed: the two strings above, inside the expanded row.

### Deliberately left out

- A fifth "Orchestrators" column. The panel holds the seats in 340 px of popover; a column would spend 232 px of every board on something looked at a few times a week.
- Any change to `TASK_HIDE_PROTECTED` on the server. The seat-only card it protected is no longer drawn, and a mixed band keeps today's lock.
- Stopping the task mint at seat launch. The task row is where the seat's notes live (`details`, #1834), so it stays and only its drawing goes.
- A right-hand side placement, free-floating panels, a per-project placement. One remembered choice per browser answers the request.
- Two wide columns at once, drag-to-resize column borders.
- The attention toast overlapping the Tasks panel header (noted as a follow-up in `board-header.md`).

### Build plan

**PR 1 (A + B).** Fence: `src/lib/orchestrator/seats.ts` (revocation gains `activatedAt`; a reader for a project's previous seats), `src/app/api/orchestrator/seat/route.ts` (the `previous` list), `src/components/orchestrator/useOrchestratorSeat.ts`, `seatState.ts`, `OrchestratorPanel.tsx` (seat head only), a new `src/components/orchestrator/PreviousSeats.tsx`, `src/lib/tasks/groupHide.ts` (`SeatRefs.previous`), `src/components/kanban/kanbanModel.ts`, the Tasks panel's list filter, `src/components/mobile/mobileBoardModel.ts`, `MobileOrchestratorSheet.tsx`, `kanbanBoard.css`, i18n. Off limits: the rotation and designation logic, `src/lib/attention/`, the task store's write paths.

Tests, red first: `kanbanModel.test.ts` with one live seat, two revoked seats and three product tasks yields three cards, zero seat cards, column counts and `totals.working` that ignore the seats, and a mixed band that keeps its card without the seat tile; `seats.test.ts` covers the previous-seat reader, `activatedAt` on new revocations and the fallback on old ones; a DOM test for the popover (closed by default, count, order, row link, one open Notes row, hidden at zero); a DOM test that a rotation in the seat read moves the old seat into the list with no task write.

**PR 2 (C + D), after PR #1855 merges.** Fence: `kanbanSeatStore.ts`, `KanbanSeat.tsx`, `OrchestratorPanel.tsx` (seat head, collapsed shapes), `OrchestratorPanelToggle.tsx` (state dot), `KanbanBoard.tsx` (the `kb-page` layout, the key handler, column heads), a new `kanbanWideStore.ts`, `kanbanBoard.css`, i18n. Tests: `seatFold.dom.test.tsx` extended for both placements, the v1→v2 store migration, `O`; a DOM test for widen, auto-narrow on a card focus in Assigned, pin surviving it, and pin persistence.

**Rendered evidence, once, at the end of each PR**, through `BOARD_CAPTURE_CASE` cases in `scripts/capture-board-geometry.ts` on the seeded home the header case uses:

- `seats` (PR 1): 1440 and 1280, en and uk, light and dark: three bands and zero seat bands, the head control reading 2, the popover open with one Notes row expanded; asserts the popover stays inside the viewport and no head control overlaps another at 1280. Phone driver at 390 × 844: the sheet row and the list.
- `seat-placement` (PR 2): top expanded, top collapsed (strip 40 px), side expanded (380 px), side collapsed (rail 44 px), at 1440 and 1280; asserts the board's width grows by the freed amount, the bar stays 48 px, and the toggle's dot colour matches the seat state.
- `columns-wide` (PR 2): default, Done widened, Blocked pinned wide with Assigned narrow, at 1440 and 1280; asserts the shares, that no card title in the wide column is clipped, and that one wide column exists at a time.

---

## 3. Kanban undo and redo (#1856)

### Problem

The header's Undo and Redo reversed one thing, closing a conversation card, and left with the header lane. What the operator does by hand on the board is move a task between columns, edit its text and hide it. A move and a hide already raise a receipt with Undo, and `U` runs it (`KanbanBoard.tsx:312`, `:1445`), yet that undo lives exactly as long as the receipt: seven seconds. A text edit has no undo at all, nothing can be redone, and the keys every editor uses do nothing.

### Design

**A history that outlives the receipt, built on what is there.**

- One in-memory stack pair per mounted board (per project): `undo` and `redo`, 50 entries, dropped oldest-first, gone on reload. It replaces `latestUndo`.
- Entries, recorded when the operator's own action is sent:
  - `status`: `{ taskId, from, to }`
  - `text`: `{ taskId, before, after }` (title and description are one `text` field; the entry stores the whole value)
  - `details`: `{ taskId, before, after }` (the same edit path, so it rides along at no cost)
  - `hide`: `{ taskIds[] }` (one entry for a bulk hide, as `hideMany` already undoes it as one)
- A new action clears `redo`. A write the server refused removes its own entry. Moves made by agents never enter the stack: it reverses the operator's hands only.
- **Undo writes through the same route the action used** (`controller.move`, `controller.edit`) with the task's current revision as the guard.
- **When another writer got there first, undo refuses and changes nothing.** Before sending, the entry's `after` value is compared with the task's stored value of that field (a fresh `read`, the port the mutation hook already has). A difference means someone changed that field since, so the undo is dropped with the refusal receipt below and the entry leaves the stack. A revision that moved for another field (an agent rewrote `details` while the operator's move stands) lets the undo through, which is how `useTaskMutations` already reads a 409 for every other write; refusing there would make undo fail on a busy board for changes that do not touch what is being undone. This is the one place this design reads #1856's acceptance line ("an undo against a task whose revision moved says so and changes nothing") by its purpose: the undone value is what must be unmoved.
- The board offers no task delete, so none is recorded.

**Keys.** `Ctrl+Z` / `⌘Z` undoes, `Ctrl+Shift+Z` / `⌘⇧Z` and `Ctrl+Y` redo, while focus is inside the board or on `body`, and no `input`, `textarea`, `[contenteditable]`, open sheet, menu or composer holds it (there the browser's own text undo keeps working). `U` stays as an undo alias. Both call `preventDefault` only when they act.

**The receipt is the toast** (`KanbanReceipts`, bottom-centre, unchanged geometry: dark pill, 30 px action, countdown bar, 7 s, 12 s for errors, at most three).

```
┌──────────────────────────────────────────────────────┐
│ Moved «Header bar at 1280» to Done      [Undo]   ✕   │      after an action
└──────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────┐
│ Undone: «Header bar at 1280» is back in Assigned [Redo] ✕ │  after Ctrl+Z
└──────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────┐
│ «Header bar at 1280» was changed since. Nothing was undone.  ✕ │  refusal, danger fill
└──────────────────────────────────────────────────────┘
```

- A text edit now raises a receipt too: `Edited «{title}»` with Undo.
- Undo and redo each replace the receipt they answer, so a run of `Ctrl+Z` never stacks three pills. Focus follows the card: after a status undo the card is focused in the column it returned to (`focusMoved`, already there); after a hide undo the restored card is focused.
- An empty stack answers the key with a short neutral receipt (2.5 s, no action), so the key never feels dead.

**The persistent control lives in the bar's `⋯` menu.** The bar carries no undo button, by the operator's amendment on #1801, and the receipt is gone in seven seconds. The menu gains one group, between "Search your messages" and the account rows, drawn only while a stack holds an entry (the header's rule: a group draws when it has a row):

```
┌───────────────────────────────────────────────┐
│ 🔍 Search your messages                     / │
│ ───────────────────────────────────────────── │
│ ↶ Undo: move «Header bar at 1280»      Ctrl+Z │   row 36 px, icon 15 px, label truncates,
│ ↷ Redo: edit «Accounts chart»    Ctrl+Shift+Z │   shortcut in --color-muted, tabular, right-aligned
│ ───────────────────────────────────────────── │
│ 🔈 Mute sound                                 │
```

A row whose stack is empty is not drawn, so the menu never shows a disabled control. On macOS the shortcuts print as `⌘Z` and `⇧⌘Z`.

**Phone (390).** Unchanged. The phone has no columns to drag between, and its swipe actions already carry their own receipt with Undo (`MobileReceipt`). Its `⋯` menu gets no rows.

**Copy.**

| Key | en | uk |
|---|---|---|
| `kanban.edited` | `Edited «{title}»` | `«{title}» змінено` |
| `kanban.undoneMove` | `Undone: «{title}» is back in {status}` | `Скасовано: «{title}» знову в «{status}»` |
| `kanban.undoneEdit` | `Undone: the text of «{title}» is restored` | `Скасовано: текст «{title}» відновлено` |
| `kanban.undoneHide` | `Undone: «{title}» is back on the board` | `Скасовано: «{title}» знову на дошці` |
| `kanban.undoneHideMany` | `Undone: {count} tasks are back on the board` | `Скасовано: {count} задача / задачі / задач знову на дошці` |
| `kanban.redone` | `Redone: {what}` | `Повторено: {what}` |
| `kanban.redo` | `Redo` | `Повторити` |
| `kanban.undoRefused` | `«{title}» was changed since. Nothing was undone.` | `«{title}» відтоді змінили. Нічого не скасовано.` |
| `kanban.redoRefused` | `«{title}» was changed since. Nothing was redone.` | `«{title}» відтоді змінили. Нічого не повторено.` |
| `kanban.undoGone` | `«{title}» no longer exists. Nothing was undone.` | `«{title}» вже не існує. Нічого не скасовано.` |
| `kanban.undoFailed` | `Could not undo: {error}` + action `Retry` | `Не вдалося скасувати: {error}` + `Повторити` |
| `kanban.nothingToUndo` / `kanban.nothingToRedo` | `Nothing to undo` / `Nothing to redo` | `Нема чого скасовувати` / `Нема чого повторювати` |
| `kanban.menuUndo` / `kanban.menuRedo` | `Undo: {what}` / `Redo: {what}` | `Скасувати: {what}` / `Повторити: {what}` |
| `{what}` fragments | `move «{title}»` · `edit «{title}»` · `hide «{title}»` · `hide {count} tasks` | `перенесення «{title}»` · `зміна «{title}»` · `приховання «{title}»` · `приховання {count} задач` |

Titles inside receipts and menu rows are shortened to 48 characters, as `move` already does. `kanban.undo` (`Undo` / `Скасувати`) is reused.

**States.** In flight: the card moves at once (the optimistic path that exists) and the receipt shows straight away; a second `Ctrl+Z` queues behind the first through the per-task queue. Failed (network, 5xx): `kanban.undoFailed` with Retry, the entry returns to its stack. Refused: above. Task gone: `kanban.undoGone`. 1440 and 1280: receipts are centred on the viewport and at most 520 px wide, clear of the side-docked seat and the Tasks panel. Light and dark: the receipt is the existing inverted pill in both.

### Deliberately left out

- Persistence across reloads, and a history shared between tabs or devices. An undo an hour later against a board agents keep changing would mostly refuse.
- Undo of colour labels, of card collapse, of reader open and close, of anything an agent did, of pipeline actions.
- A visible history list. Two menu rows name the next step in each direction.
- A button in the bar or on the column heads.

### Build plan

Fence: a new `src/components/kanban/boardHistory.ts` (pure: the two stacks, record, take, the value-match check), its test, `KanbanBoard.tsx` (`move`, `hideCard`, `hideMany`, the text and details commit path, the key handler, the `⋯` rows through the `barTrail` node the header lane introduced), `KanbanReceipts.tsx` (a `replace(id, …)` beside `show`), `useTaskMutations.ts` (expose `read` to the board; no change to the guard logic), i18n. Requires PR #1855 merged, since the `⋯` menu is its.

Tests, red first: `boardHistory.test.ts` (cap, redo cleared by a new action, refused entry leaves the stack); `KanbanEditing.dom.test.tsx`: move then `Ctrl+Z` returns the card and `Ctrl+Shift+Z` moves it again; edit then undo restores the previous text; an undo after the stored field changed elsewhere raises the refusal and sends no PATCH; an undo after only `details` changed elsewhere goes through; `Ctrl+Z` inside the title editor is left to the browser; the header and the bar carry no undo button; the `⋯` group is absent with empty stacks.

Rendered evidence: a `describe` block in `kanbanBoard.browser.test.tsx`: the three receipts and the open `⋯` menu with both rows, 1440 and 1280, en and uk, light and dark; asserts the receipt sits inside the viewport, its action is 30 px tall, the menu rows do not truncate the shortcut, and the long Ukrainian refusal wraps to two lines at most.

---

## 4. The week's burndown behind each account row (#1072)

**Operator, as recorded in #1072:** "Render each account row's weekly burndown chart as a dimmed background of that row in the accounts list — subdued enough not to fight the text, but clear enough to read the current burn slope at a glance while scanning accounts."

### Problem

An account row in the accounts panel (`AccountRow` + `AccountLimitsBlock`, `AccountsPanel.tsx`) shows how much is left: `Week 62 % left`, and since #1796 one more row per metered model tier (`Fable 41 % left`). It says nothing about pace. 62 % left on day two is alarming and on day six is comfortable, and the only way to tell is to open the burndown popover, which charts the active account alone. Choosing which account to switch to is exactly the moment the pace of the *other* accounts matters.

### Design

**One SVG behind each row, drawn from the series the popover uses.**

```
┌─────────────────────────────────────────────────────────┐  row: the existing AccountRow box, 400 px panel
│▓▓▓▓▓▓▓▓▓▓▓▓▒▒▒▒▒▒·                                       │  ← area under "week left", engine tint
│ ● Account B            Max 20x        62 %   active      │
│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▒▒▒▒▒▒·  · · ·  ·   ·  .                │  ← dashed even-pace guide, corner to corner
│   checked · 14:32                          ⟳ Refresh     │
│▓▓ 5h    ▬▬▬▬▬▬▬▬▬▬  88 % left · resets in 3 h            │
│▓▓ ─ Week  ▬▬▬▬▬▬▬▬▬▬  62 % left · resets Tue 09:00  ╎    │  ← "now" is where the area ends
│▓▓ ┄ Fable ▬▬▬▬▬▬▬▬▬▬  41 % left · resets Tue 09:00  ╎    │
│   ⌨ Copy CLI command                          🗑 Remove  │
└─────────────────────────────────────────────────────────┘
   window start ───────────────── now ──────────── reset
```

- **Placement.** `position: absolute; inset: 0` inside the row's `relative` box, first child, `z-index: 0`, `pointer-events: none`, `aria-hidden`. The row's content gets `position: relative; z-index: 1`. `viewBox="0 0 100 100"`, `preserveAspectRatio="none"`, every stroke `vector-effect: non-scaling-stroke`. The row's size never changes: the SVG has no intrinsic size and takes the box it is given.
- **Axes.** x runs from the weekly window's start to its reset, across the full row width, the same domain the popover draws (`BurndownPanel.tsx:46-49`). y is 0–100 % remaining, inset 6 px top and bottom so a full line is never glued to the row's edge.
- **Marks**, back to front:
  1. *Even-pace guide*: a straight line from (start, 100 %) to (reset, 0 %). `--color-muted`, 1 px, dash `3 3`, opacity 0.35.
  2. *Week area*: the polygon under the week's samples from the first sample to the latest one, closed down to 0 %. Fill opacity **0.10 light, 0.16 dark**.
  3. *Week line*: the same samples as a 1.25 px line, round joins, opacity 0.45.
  4. *Tier lines*: one 1.25 px line per metered tier, no area, dash `4 2` for the first tier and `1 3` for the second, opacity 0.45. At most two; a third tier stays a meter without a line.
  5. *Now*: nothing is drawn for it. The area ends there, and the empty stretch to its right is the time still left.
- **Colour** comes from the function the meters in the same row already use, `capacityColor(left, engineTint)`: the engine's tint while capacity is healthy, `--color-warning` when it runs low, `--color-danger` near empty. Week marks take the week's colour; each tier line takes its own tier's. The background and the meter in front of it therefore always agree, and no new threshold is invented.
- **Reading it.** Area above the dashed guide: the account is under pace and safe to lean on. Area below it: it is burning ahead of pace. That one comparison is the glance the requirement asks for. The active row's existing 7 % tint wash and 2 px identity bar stay under the chart.
- **Legend, inside the limits block.** Each row label gains a 10 × 2 px swatch before its text: solid for `Week`, the tier's dash pattern for a tier, none for `5h` (which has no line). Same colour and opacity as the line it names, so nobody has to guess which line is Fable's. The label column's widths (`w-8`, `w-[72px]`) grow by 14 px.
- **Contrast.** The strongest composite behind text is the area's 0.16 over `--surface-card` in dark, which moves the background's luminance by under 3 %. The evidence run measures primary and muted text against the painted pixels and requires 4.5 : 1 for primary and the same ratio the row has today for muted, within 0.1.

**Data.** The history store already keeps samples per engine **and account** (`seriesKey(engine, accountId, window)`), written whenever any account's limits are read, so the other accounts' weeks are on disk today. Two small additions:

1. `GET /api/limits/history` gains `accounts: { claude: Record<accountId, AccountBurndown>, codex: … }` with `AccountBurndown = { weekly: BurndownSeries, tiers: Record<tier, BurndownSeries> }`, built by the existing `buildEngineBurndown` path from stored samples. The Codex transcript backfill stays on the active account, as now; other Codex accounts draw their stored samples.
2. `recordLimitSample` also records one series per reported tier (`modelTierWindows(limits)`, window key `tier:<name>`), under the same five-minute gap, eight-day retention and point cap. Tier history starts at deploy, so a tier line appears once two samples exist and grows from there; the general week line is there from the first render.

The panel reads the payload once on open and every 60 s while open.

**States.**

| State | Drawn |
|---|---|
| Loading, request failed | nothing; the row looks exactly as today and nothing shifts when the series arrives |
| Fewer than two samples in the current window, window start or reset unknown | nothing |
| Window reset since the last sample | the series is already cut to the current window; a fresh week draws nothing until its second sample |
| Signed-out or never-read account | nothing |
| Stale limits (`opacity-70` block) | the chart at 60 % of its opacities |
| Tier reported with no history yet | its swatch draws hollow (1 px outline), so the legend is honest about the missing line |

Codex rows get the same chart from their `weekly` series; a Codex plan that reports no weekly window (`windowUnreported`) draws nothing.

**Viewports.** The panel is `min(400px, 100vw − 16px)` on every desktop width, so 1440 and 1280 are one layout. On the phone (390) the same component sits behind the active account's card (`MobileAccountCard`, 358 px) and behind each other account's row; the card's corner figure and meters sit above it. Light and dark differ only in the two area opacities above.

### Deliberately left out

- The 5 h window: it would add a second, faster sawtooth behind the same text.
- Hover tooltips, a crosshair, axis labels, the "0 % by <date>" forecast. They live in the burndown popover, which stays.
- A sparkline in the header's account switches or in the limits footer.
- Backfilling tier history from transcripts.
- A pace sentence for screen readers (outside this lane's audit scope; the meters already say the numbers).

### Build plan

Fence: `src/lib/limitsHistoryStore.ts` (tier series), `src/lib/limits.ts` (`readBurndown` accounts map), `src/lib/types.ts`, `src/app/api/limits/history/route.ts`, a new `src/components/AccountSparkline.tsx` (pure: series in, SVG out; path building shared with `BurndownPanel` by moving its two path helpers into `src/lib/burndown.ts`), `AccountsPanel.tsx` (`AccountRow`, the label swatch in `AccountLimitsBlock`, `MobileAccountCard`), i18n untouched (no new visible words).

Tests, red first: `limitsHistoryStore` records and prunes a tier series; `limitsBurndown.test.ts` returns the per-account map and masks nothing it should show; `AccountsPanel.dom.test.tsx`: a row with a series renders `[data-account-sparkline]` with an area, a guide and one dashed tier line, a row without renders none, `pointer-events` is `none`, and the row's height is identical with and without the series; the mobile DOM test covers the card.

Rendered evidence: the accounts panel has no capture of its own, and the header case of `scripts/capture-board-geometry.ts` already opens it on a seeded home with three Claude accounts and one Codex account. Add `BOARD_CAPTURE_CASE=accounts-chart` there: seed a week of samples per account (one under pace, one over pace and low, one with a Fable tier, one with no history), open the Claude and the Codex panel at 1440 and 1280, en and uk, light and dark, and the phone screen at 390 × 844. It asserts a sparkline on the three rows with history and none on the fourth, row heights equal to the no-chart baseline, the measured text contrast, and that the over-pace row's area lies under its guide at "now".

---

## 5. The account removal dialog says what happened (#1857, slice 2)

**Operator, as paraphrased in #1857:** "Removing an account must work. Conversations must not be lost and should not block the removal." Expected outcome: "remove succeeds for an account with leftover history, the history stays readable in the Viewer, and the dialog says what was moved."

### Problem

Slice 1 (PR #1862) made removal succeed and made `DELETE /api/accounts/<engine>` answer with what moved. The dialog still speaks the old language. Every refusal collapses into two sentences (`accounts.removeBlocked`, `accounts.removeHistoryBlocked`), the second of which describes a history fence that no longer exists; the text sits in a two-line clamped strip at the bottom of the panel, far from the row it is about; a success says nothing at all, the row just vanishes; and the footer still offers `Force remove`, a flag the server accepts and ignores.

### Design

Three places, each for one kind of answer: **the row** says why it could not be removed, **the footer slot** says what a successful removal moved, and **the footer link** cleans up leftovers.

#### 5.1 Arming and in flight (the row's action line)

```
idle        ⌨ Copy CLI command                                   🗑 Remove
armed       Remove Account B? Its files move to the shared archive
            and past conversations stay readable.      [Remove]  Cancel
in flight   ⌨ Copy CLI command                          ◌ Removing…
```

- Armed: the sentence wraps to two lines at `10.5px` / 600 in `text-danger`; `Remove` is the existing filled danger button (28 px desktop, 44 px phone), `Cancel` the quiet one. Escape cancels; the armed state times out after 10 s.
- In flight: spinner + `Removing…` in `text-secondary`, the row at 60 % opacity, every other mutation disabled (as `mutation !== null` does today).

#### 5.2 Refusals: one message each, inside the row

A block under the row's action line, inside the row's box: `danger-soft` fill, 8 px radius, 10 px 12 px padding, left margin 30 px to align with the row's text, `TriangleAlert` 13 px in `text-danger`, body `11px` / 1.45 in `text-primary`, no clamp. Several blockers draw as several lines in one block (at most three). Closing the block is a 20 px quiet ✕; it also leaves when the next attempt starts. Every message ends by saying nothing was changed, except where the server cannot promise that.

```
│ ● Account B            Max 20x        62 %            │
│   … limits …                                           │
│   ⌨ Copy CLI command                        🗑 Remove  │
│   ┌──────────────────────────────────────────────┐    │
│   │ ⚠ An agent is still running on Account B.    ✕│    │
│   │   Stop it or wait for it to finish, then      │    │
│   │   remove the account. Nothing was changed.    │    │
│   └──────────────────────────────────────────────┘    │
```

| Server answer | en | uk |
|---|---|---|
| `blockers: live_sessions` | `An agent is still running on {label}. Stop it or wait for it to finish, then remove the account. Nothing was changed.` | `На {label} ще працює агент. Зупиніть його або дочекайтеся завершення, тоді видаліть акаунт. Нічого не змінено.` |
| `blockers: login_pending` | `A sign-in for {label} is still open. Finish it or cancel it above, then remove the account. Nothing was changed.` | `Вхід для {label} ще не завершено. Завершіть або скасуйте його вище, тоді видаліть акаунт. Нічого не змінено.` |
| `blockers: queued_pin` | `A queued launch is pinned to {label} and starts when the account has capacity. Remove the account after it starts. Nothing was changed.` | `До {label} прив'язано запуск у черзі; він стартує, коли акаунт матиме ресурс. Видаліть акаунт після його старту. Нічого не змінено.` |
| `blockers: current_conversations` | `A conversation on {label} is still in flight: a live host, an unfinished account move or a message waiting to be delivered. Wait for it to settle, then remove the account. Nothing was changed.` | `Розмова на {label} ще триває: живий хост, незавершене перенесення між акаунтами або повідомлення, що чекає доставки. Дочекайтеся завершення, тоді видаліть акаунт. Нічого не змінено.` |
| `unsafe_home` | `The folder of {label} failed a safety check: it is a link, belongs to another user, or others can write to it. Fix its owner and permissions, then remove the account. Nothing was changed.` | `Тека {label} не пройшла перевірку безпеки: це посилання, вона належить іншому користувачеві або доступна іншим для запису. Виправте власника й права, тоді видаліть акаунт. Нічого не змінено.` |
| `archive_unavailable` | `The archive folder for {label} already exists or is on another disk:` + path line + `Move it away, then remove the account. Nothing was changed.` | `Архівна тека для {label} вже існує або лежить на іншому диску:` + шлях + `Приберіть її, тоді видаліть акаунт. Нічого не змінено.` |
| `accounts_locked` | `The accounts registry needs repair before any account can be removed. Nothing was changed.` | `Реєстр акаунтів потребує відновлення, перш ніж видаляти акаунти. Нічого не змінено.` |
| `unknown_account` | `{label} is no longer in the list.` (the list refreshes) | `{label} уже немає у списку.` |
| `removal_failed` (+ `errno`) | `Removing {label} failed at a file step ({errno}). The account was put back as it was.` Without `errno`: `Removing {label} failed. The account was put back as it was.` + action `Try again` | `Видалення {label} зупинилося на кроці з файлами ({errno}). Акаунт повернуто як був.` / `Не вдалося видалити {label}. Акаунт повернуто як був.` + `Спробувати ще раз` |
| no answer (network) | `The Viewer did not answer. Check the list before trying again.` + action `Refresh` | `Viewer не відповів. Перевірте список, перш ніж пробувати знову.` + `Оновити` |

- The path line: `font-mono`, `10.5px`, `text-secondary`, home shown as `~`, truncated in the **middle** so the account id at the end stays visible, with a 20 px copy button.
- `login_pending` points at the cancel control the row already draws for a pending sign-in (`cancelLogin`); no second button.
- **One server addition this slice needs.** A queued pin is reported today as `live_sessions` (`accountLiveness.ts:249-258` returns through `accountHasLiveSessions`), so the dialog cannot tell it from a running agent. `accountRemovalBlockers` gains a third value, `queued_pin`, returned in place of `live_sessions` when the queued pin is the only thing live. Until then the `live_sessions` sentence is what a queued pin shows.

#### 5.3 Success: what moved

The row disappears from the list. The footer slot that today holds the notice strip shows a summary card instead, until the operator closes it or closes the panel; it has no timer, because it carries numbers somebody may want to read twice.

```
┌─────────────────────────────────────────────────────────┐
│ ✓ Account B removed                                   ✕ │   title: 12.5px / 700 primary; ✓ 14 px --color-success
│   Past conversations stay readable.                     │   11px text-secondary
│                                                         │
│   Moved           1 284 files · 2.1 GB                  │   dl, label column 96 px, 10.5px / 600 text-secondary
│   Archive         ~/.config/…/retired/claude-b     ⧉    │   values 11px primary, tabular-nums; path mono, middle-truncated
│   Conversations   37 now read from the archive          │
│   Pins cleared    2                                     │
│   Deliveries      1 undelivered message dropped         │
│   Account moves   1 settled                             │
└─────────────────────────────────────────────────────────┘
```

- Surface: `--surface-card` with a 1 px `--border-default` top rule, 12 px 14 px padding, row gap 4 px. The check is the only colour.
- `Moved` and `Archive` always draw. `Conversations`, `Pins cleared`, `Deliveries` and `Account moves` draw only when their number is above zero, so a clean removal is three quiet lines.
- Bytes format in decimal units (1 GB = 10⁹ bytes) with one decimal from MB up (`812 KB`, `14.2 MB`, `2.1 GB`); file counts use the locale's thousands separator.
- **`cleanupPending: true`** adds one line under the list in `--color-warning` with a button: the account is gone and its sign-in file is still inside the archive. The button runs the existing clean-up call; on success the line becomes `Sign-in file deleted.` in `text-secondary`.

| Key | en | uk |
|---|---|---|
| `accounts.removed.title` | `{label} removed` | `{label} видалено` |
| `accounts.removed.readable` | `Past conversations stay readable.` | `Минулі розмови лишаються доступними.` |
| `accounts.removed.moved` / value | `Moved` / `{files} files · {size}` | `Перенесено` / `{files} файл / файли / файлів · {size}` |
| `accounts.removed.archive` | `Archive` | `Архів` |
| `accounts.removed.copyPath` | `Copy the archive path` | `Скопіювати шлях до архіву` |
| `accounts.removed.conversations` / value | `Conversations` / `{count} now read from the archive` | `Розмови` / `{count} тепер читаються з архіву` |
| `accounts.removed.pins` | `Pins cleared` | `Знято прив'язок` |
| `accounts.removed.deliveries` / value | `Deliveries` / `{count} undelivered message dropped` · `messages` | `Доставки` / `{count} недоставлене повідомлення відкинуто` / `недоставлені повідомлення відкинуто` / `недоставлених повідомлень відкинуто` |
| `accounts.removed.migrations` / value | `Account moves` / `{count} settled` | `Перенесення між акаунтами` / `{count} закрито` |
| `accounts.removed.credentialLeft` | `The sign-in file could not be deleted from the archive.` + `Finish clean-up` | `Файл входу не вдалося видалити з архіву.` + `Завершити очищення` |
| `accounts.removed.credentialDone` | `Sign-in file deleted.` | `Файл входу видалено.` |
| `accounts.removeConfirm` (reworded) | `Remove {label}? Its files move to the shared archive and past conversations stay readable.` | `Видалити {label}? Його файли перейдуть до спільного архіву, а минулі розмови лишаться доступними.` |
| `accounts.removeConfirmCta` (reworded) | `Remove` | `Видалити` |
| `accounts.removing` | `Removing…` | `Видалення…` |

#### 5.4 Clean-up of retired leftovers

The footer link stays where it is, one quiet underlined text button, renamed from `Clean up abandoned homes` to **`Clean up leftovers`** / **`Прибрати залишки`**: it covers failed sign-in folders and accounts that were retired in place before the archive existed. While it runs: spinner + `Cleaning up…` / `Прибирання…`. Its answer takes the same footer slot as the removal summary, in the same card:

```
┌─────────────────────────────────────────────────────────┐
│ ✓ Leftovers cleaned up                                ✕ │
│   Deleted         3 empty folders                       │
│   Archived        2 retired accounts · 412 files · 96 MB│
│   Needs a look    claude-r2.lock                        │   names in mono, one per line, at most 5, then "+N more"
└─────────────────────────────────────────────────────────┘
```

| Key | en | uk |
|---|---|---|
| `accounts.cleanup.title` | `Leftovers cleaned up` | `Залишки прибрано` |
| `accounts.cleanup.titleNothing` | `Nothing to clean up` | `Прибирати нічого` |
| `accounts.cleanup.titlePartial` | `Some leftovers need a look` (warning icon) | `Частина залишків потребує уваги` |
| `accounts.cleanup.deleted` | `Deleted` / `{count} empty folder` · `folders` | `Видалено` / `{count} порожня тека / порожні теки / порожніх тек` |
| `accounts.cleanup.archived` | `Archived` / `{count} retired account` · `accounts` ` · {files} files · {size}` | `Заархівовано` / `{count} видалений акаунт / видалені акаунти / видалених акаунтів · {files} файлів · {size}` |
| `accounts.cleanup.unresolved` | `Needs a look` | `Потребує уваги` |
| `accounts.cleanup.unresolvedHint` | `These failed a safety check and were left untouched. Inspect and remove them by hand.` | `Вони не пройшли перевірку безпеки й лишилися без змін. Перевірте та приберіть їх вручну.` |
| `accounts.cleanup.failed` | `Could not clean up leftovers.` + `Try again` | `Не вдалося прибрати залишки.` + `Спробувати ще раз` |

`Deleted` maps to the answer's `removed[]`, `Needs a look` to `unresolved[]`. **The `Archived` line depends on a server step slice 1 left open:** `cleanupOrphanedClaudeHomes` still runs a retired-in-place home through the old scrub, where the investigation (§6, "Retired archives already on disk") calls for the same move into `shared/<engine>/retired/<id>/`. That step and an `archived: [{ id, files, bytes }]` field in the answer belong to this slice's server part; without them the line simply does not draw and the other two are correct as designed.

**Removed from the dialog:** `Force remove` and its retry kind (`forceRemove`), `accounts.removeBlocked`, `accounts.removeHistoryBlocked`, `accounts.cleanupPending`, `accounts.cleanupManual`. The generic notice strip stays for the operations that are not removal.

**Viewports.** The panel is 400 px at 1440 and 1280 alike; the longest Ukrainian refusal (`current_conversations`) wraps to six lines of 11 px inside the 340 px block, 96 px tall, which the panel's scroll area absorbs. Phone (390): the refusal block sits inside the account's card at full card width with a 44 px ✕; the summary card is the first element of the engine section, above the account cards, since the phone screen has no footer slot. Light and dark: `danger-soft`, `--surface-card` and the text tokens cover both; the success check is `--color-success` in both.

### Deliberately left out

- A modal confirm. The inline arm-then-confirm step already exists and the action is now recoverable: everything lands in an archive.
- Listing which agent or conversation blocks the removal, with links. The answer carries no ids today; the sentence says what to wait for.
- Browsing, restoring or deleting an archive from the dialog.
- A force path. No blocker has a bypass, by slice 1's design.

### Build plan

Fence: `src/hooks/useEngineAccounts.ts` (a `removal` outcome on the snapshot: `{ accountId, refusal }` or `{ summary }`, replacing the three notice keys; `cleanupOrphans` returning its report), `AccountsPanel.tsx` (`AccountRow` block, the footer card, `MobileAccountCard`, `MobileEngineSection`), two small new components beside it (`AccountRemovalRefusal`, `AccountRemovalSummary`), i18n. Server part, kept minimal: `src/lib/accounts/removal.ts` and `src/lib/agent/accountLiveness.ts` (`queued_pin`), `src/lib/accounts/claude.ts` and `codex.ts` (retired-in-place homes move to the archive during clean-up; `archived[]` in the report), the two account routes' tests. Off limits: the removal sequence, the journal and `retireAccount`.

Tests, red first: the hook maps each of the ten answers in §5.2 to its own message key and keeps `archive` and `errno`; a 200 with counts yields the summary with zero-valued lines omitted; `cleanupPending` yields the warning line and the button calls clean-up; `AccountsPanel.dom.test.tsx` renders each refusal inside the refused row, renders the summary after the row is gone, and finds no `Force remove`; route tests cover `queued_pin` and the `archived` report.

Rendered evidence: `BOARD_CAPTURE_CASE=account-removal` in `scripts/capture-board-geometry.ts`, on the seeded home, with the DELETE answers stubbed at the network layer (no account is removed anywhere): armed row, in-flight row, the longest refusal, `archive_unavailable` with its path, the full summary with all six lines, the summary with `cleanupPending`, and the clean-up result with unresolved names; 1440 and 1280, en and uk, light and dark; the phone screen at 390 × 844 for the refusal and the summary. It asserts that no text is clamped or clipped, the middle-truncated path keeps the account id visible, the blocks stay inside the panel, and touch targets on the phone are 44 px.

---

## Deferred — not currently justified

- **A `critic` role preset** (item 1): useful naming in the registry, independent of the label fix.
- **`PipelineStrip` labels** on the Conversations view (item 1): already carries the stage id and position.
- **An Orchestrators column** (item 2): the panel's popover holds the list in less space.
- **Not minting a task per seat** (item 2): the task row is the seat's notes store.
- **Persistent or cross-tab undo history, undo of agent writes, a history list** (item 3).
- **5 h sparkline, chart tooltips, tier backfill from transcripts, a pace sentence for assistive tech** (item 4).
- **Blocking-conversation links, archive browsing, a modal confirm** (item 5).

## Validation against the requirement

| Asked | Where |
|---|---|
| Five designs, in the given order | §1–§5 |
| Problem in one paragraph each | the "Problem" head of each section |
| Regions, sizes, type, spacing, colour roles, states, en + uk copy, 1440 / 1280 / 390, light and dark | the "Design" head of each section; shared tokens at the top |
| What is left out | each section, gathered again under Deferred |
| Build plan with file fences and rendered evidence | each section; every capture is a case on an existing driver, none is a new one-shot script |
| #1841 includes the panel's placement and the columns #1801 deferred, fitted to `board-header.md` | §2 C and D; the `Orchestrator` toggle, the `⋯` menu and the 48 px bar are used as that document defines them |
| #1856 names the shortcut, the toast and the home of a persistent control | §3: `Ctrl+Z` family, the receipt, the `⋯` menu group |
| #1072 includes the per-model tier lines | §4: dashed tier lines, label swatches, the tier series the store must start recording |
| #1857 slice 2: one message per refusal, the success summary, the clean-up action | §5.2, §5.3, §5.4 |

Three facts the builders must carry, stated where they apply: a queued pin has no blocker of its own on the server yet (§5.2); retired-in-place homes are not yet moved by the clean-up (§5.4); tier history does not exist until the store records it (§4). Each has its server change named inside the item's fence, and each design degrades to a correct, smaller surface without it.
