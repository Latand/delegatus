# Tasks menu: recent work first, real detail, and recently launched agents

**Originating requirement** (operator, voice message to the orchestrator, 2026-10-12 ~07:55, Russian, verbatim):

> «то меню задач, которое там сейчас, оно очень старое, оно, по-моему, даже не все правильно задачи показывает, не все правильно отсортировано. То есть я бы хотел видеть все недавние задачи, которые работали, выше. И чтобы там была более детальная информация … нужно подумать тоже прототип сделать.»

> «я хочу иметь возможность смотреть список всех агентов, которые были недавно собраны [запущены]. Каким-то образом.»

The pinned acceptance adds: recency is the last real work on the task (its newest stage attempt, assignment, agent activity or PR event), never `updatedAt`; done and long-idle tasks fall to the bottom or behind a filter; nothing is silently dropped; each row shows title with colour or icon, status, what runs now, its PR and merge state, its hold and the last-activity time, and expands or opens to the full card; a view of recently launched agents is reachable from the same menu; 2–3 numbered variants at 1440, 1000 and 390 px in uk and en, light and dark, against the current menu.

Prior work: `search_transcripts` («tasks menu header Задачі panel sort recent tasks») found the board-header design lanes (#1801, and the open round-2 lane on the header) and nothing on this panel's order or content. `docs/design/board-header.md` §2 places the `Tasks N` toggle in the bar's panels group; this design keeps that toggle and changes only what it opens.

## 1. Audit of today's «Задачі»

The control is `BarPanelToggles` (`src/components/ProjectBar.tsx:178-229`, the Tasks button at 211-226): `Tasks N`, where N is `openTaskCount` (`src/components/ProjectDashboard.tsx:1037`). It toggles `TaskPanel` (`src/components/tasks/TaskPanel.tsx`), mounted at `ProjectDashboard.tsx:2254-2265` with `panelTasks` (`ProjectDashboard.tsx:2184`). The phone opens `TaskSheet` (`src/components/tasks/TaskSheet.tsx`) from ⋯ › Tasks with `faceTasks` (`ProjectDashboard.tsx:2655-2668`).

### What it shows and why tasks look missing

The data is complete: `/api/files` returns every stored task (`src/app/api/files/response.ts:731-838`, no filter), and the panel lists all of them except the orchestrator seat's own tasks (`ProjectDashboard.tsx:1022-1027`, `2184`), which is intended. Tasks look missing for four reasons, measured read-only from the live Delegatus board's state store on 2026-10-12 around 08:30 UTC (471 tasks: 135 open, 336 done):

1. **Freshly finished work is buried.** Done tasks sink below every open task, so the 23 tasks finished in the last 24 hours sit at ranks 136–193. Of the 20 tasks with the most recent real work, 5 are at ranks 136–140 (7 of 20 at a first read 30 minutes earlier). An original row is about 92 px tall under the favourites, so rank 136 is about 12 500 px down a 280 px column.
2. **Never-started tasks crowd the top.** 77 open tasks never had an agent, a stage or a PR; with `updatedAt` order they interleave with live work: 4 of the panel's first 20 rows never ran anything, and at the first read an inbox task edited at 06:40 ranked above a build that ran at 06:19.
3. **The phone has no «all» scope.** `TaskSheet` gets only this project's tasks (`ProjectDashboard.tsx:2659`), so work in another project is absent there.
4. **`updatedAt` is not work.** 109 of 379 tasks with known work have an `updatedAt` more than 6 h newer than their last work; bulk writes stamp many rows in the same minute (49 rows at 2026-10-08 07:15, 37 rows between 2026-10-11 11:35 and 11:38).

### How it sorts

`panelOrder` (`TaskPanel.tsx:89-93`) and the sheet's copy (`TaskSheet.tsx:144-151`): not-done first, then `updatedAt` descending. Every row prints `fmtAge(updatedAt)` (`TaskPanel.tsx:267`, `TaskSheet.tsx:214`), so the age it shows is the last write, not the last work.

The board already has the right recency and state: `buildKanbanModel` computes `lastAgentWorkAtMs` from conversations, mirrors, every pipeline attempt and review decks (`src/components/kanban/kanbanModel.ts:759-764`), and `motion` from `taskMotion` (`src/lib/tasks/motion.ts`). The board's columns order by them (`compareCards`, `kanbanModel.ts:400-408`) and the phone kanban uses them (`MobileKanban.tsx:396`, `phoneKanbanModel.ts:219`). The panel ignores both.

### Defects

| # | Defect | Where |
|---|---|---|
| D1 | Sorted by `updatedAt`, which bulk writes refresh; recent work lands below unrelated rows | `TaskPanel.tsx:89-93`, `TaskSheet.tsx:144-151` |
| D2 | Done tasks sink below every open one regardless of when they finished; today's merges sit at rank 134+ | `TaskPanel.tsx:91` |
| D3 | Age printed is `updatedAt`, not last work | `TaskPanel.tsx:267`, `TaskSheet.tsx:214` |
| D4 | A row shows no stage, no agent state, no PR or merge state and no hold; only a count of assignments (`⤷ N`) | `TaskPanel.tsx:240-268`, `TaskSheet.tsx:189-215` |
| D5 | Every row carries an amber «unplaced» chip with nothing to act on: the dashboard never passes `onPlaceOnMap`, and all 471 live tasks are unplaced | `TaskPanel.tsx:312-325`, `ProjectDashboard.tsx:2255-2264` |
| D6 | Every row carries the board-band preference button (`remove from board` / `show on board`); a per-task setting repeated on each row doubles the row height | `TaskPanel.tsx:279-311` |
| D7 | The «all» scope prints the raw project key (`repo-9312…`) instead of the project name | `TaskPanel.tsx:253` |
| D8 | The phone sheet has no project scope and no detail beyond status and age | `ProjectDashboard.tsx:2659`, `TaskSheet.tsx:189-215` |
| D9 | No list of launched agents anywhere in the menu; the closest is the crowned favourites section | `TaskPanel.tsx:31-87` |
| D10 | The bar's `Tasks N` counts every open task, including 77 that never started | `ProjectDashboard.tsx:1037` |

Notes outside this menu: the kanban card's own age reads `updatedAtMs` too (`src/components/kanban/KanbanCard.tsx:861`, `892`); 15 done tasks are stored under legacy bare project keys (`live-log-viewer-next` and similar) and appear only under «all» if `projectRemap` does not fold them (not verified).

## 2. Decisions common to every variant

1. **One recency: the board's.** The menu reads the cards `buildKanbanModel` already produces (cross-project through the same path `OverviewKanban` uses) and sorts by `lastAgentWorkAtMs`; a task nothing ever ran on sorts by `createdAt`. `updatedAt` leaves the menu entirely. PR events join the recency by keeping the PR's `updatedAt`, which the forge sweep reads today and drops when it stores the row (`src/lib/forge/sweep.ts:238`).
2. **Folds, never drops.** A task with no work for 3 days and the done tasks older than 24 hours fold at the bottom under a header with their count; opening a fold lists every one. Tasks finished within 24 hours stay in the recent list, where the operator looks for them.
3. **The row** (prototype `menu.tsx`, one `TaskRow` for all three variants). Line 1: `TaskIcon` in the task's colour beside the colour edge, the title (wrapped, never cut), the last-work age, and the open mark in a column of its own at the right edge. Line 2: the status as a dot in the status tone (`TASK_TONES`) under the icon, with its name in a short popover on hover or tap; then what runs now as `StageGlyph` (the model glyph in the stage's state) + the stage id + the agent's state in one to three words (working 22m / waiting on checks / idle / finished), and a state or question that wraps continues under the stage id, never under the glyph; then the PR as `WorkLinkText` in the chip's tone with its merge state. When the agent asks the operator, the state is the question itself in the attention colour («asks you: pick a menu variant»). Line 3, only for a hold that is not a question: `TaskMotionLine` over `taskMotion`, the board's own sentence, without its age. A row prints one time, the last work; «working 22m» is a duration of a different fact and stays. Under «all projects» the project name sits right under the age, at one right edge in every row; under «this project» its place stays empty, so switching the scope never rewraps a title. Line 2 starts under the title, so once the title takes two lines the project does not narrow it, and a row is as tall in either scope. A running stage reads «working», the agent's own word, on the row, in the stage list and on the agent line alike. No status is a text pill and no stage is a chip.
4. **Agents** = stage agents and spawned agents of the scope, newest launch first. A row is the model glyph in the agent's state, the name (`roleCopy.<role>.name` and the stage id, or the agent's own title) with its state beside it, and the launch age the list is ordered by; under it the task with its icon, wrapped and never cut. Only a spawned agent is marked («spawned»); a stage agent is the rule and carries no label. One time per agent. Source: pipeline attempts and the files catalogue the board already polls. The crowned favourites are a fold at the top of the Agents list in every variant; they are conversations.
5. **Moved elsewhere:** the band preference (D6) moves into the opened card's actions («Show on the board»); «unplaced» (D5) goes, since nothing can act on it; «+ new task» stays at the top of the Tasks tab; the project scope toggle stays and the phone gains it.
6. **One count.** The bar's `Tasks N` becomes open tasks with work inside the fold window (not idle). The tabs carry no number; each fold and group prints its own count, and the Agents list its own in its heading.
7. **One head.** Every variant opens with the same head: the `Tasks | Agents` tabs with the close button, then the scope toggle and, on Tasks only, «+ new task». The tabs are the panel's heading, so no title is printed above them.
8. No liquid glass: solid `bg-card`, hairline borders, the bar's pressed style for the selected tab, tokens only; the status popover and the pane of variant 3 use `shadow-2`, the raised token.

## 3. Variants

Frames: `original-*` is today's `TaskPanel` and `TaskSheet` rendered from the same fixture; each variant has `-tasks`, `-agents` and an opened task (`-expanded` for variants 1 and 2; variant 3 shows its pane in every desktop frame and has `-detail` on the phone); `-all` at 1440 shows the «all projects» scope; `-status` at 1440 shows the status popover open on the first row of each variant.

### Variant 1 — One list by recency (recommended)

The dock widens from 280 to 380 px (340 at 1000). Under the head, one list ordered by last work; then «No work for 3+ days · N» (open) and «Done · N» (folded). A row is two lines (title and age; status dot, what runs now, PR) plus the hold when one is set; a click on the row (the chevron at its right edge turns) expands it in place to the whole card: description, every stage as glyph, name and state word, the task's agents, «Open the card», «Show on the board». Phone: the same list full screen, 56 px rows, 44 px targets.

It answers the quote most directly: the newest work is the first row whatever its status, and every fact the operator asked for is on the row.

### Variant 2 — Grouped by what the task needs

420 px (360 at 1000). The same head and the same row, grouped: Needs you · Working now · Waiting (checks, holds, queue) · Not started · Finished today · No work for 3+ days (folded) · Done earlier (folded); recency inside each group. The group heading names what the work needs; the row keeps the task's status dot with its popover, as in the other two, so a blocked task among the waiting ones reads as blocked. Under «Needs you» the row prints the question alone. A row expands in place exactly as in variant 1. The agents are the Agents tab, as in the other two.

It repeats the board's own columns by motion, so it is a second kanban in a side panel.

### Variant 3 — Two panes

The list is a 340 px dock (320 at 1000) in day buckets (Today, Yesterday, This week, Older) with the Done fold. The selected row is highlighted, and its whole card hangs off the list's left edge over the board: 380 px wide (360 at 1000), as tall as its content, with its own close button. The card adds the recent activity (stage started/passed, PR opened/merged, agent launched). On the Agents tab the selected agent is highlighted in the list and the pane shows what the list does not: the agent's model, then its task's card. Phone: the list with a chevron on every task and agent row, then a pushed screen with Back: the task's whole card, or the agent (model, state, launch age) above its task's card.

The richest detail, at the cost of covering part of the board while a card is open and the most new code.

## 4. Rendered evidence

`capture.ts` serves `fixture.tsx` through the kanban driver's harness (`serveEvidenceFixture`, `openFixture`, `caseChromium` from `src/components/kanban/issue1695BrowserHarness.ts`) with the production stylesheet plus one `@source` line for this folder, in Chromium at 1440 × 900, 1000 × 760 and 390 × 844 (touch), uk and en, light and dark. Today's menu is drawn by the real `TaskPanel`, `TaskSheet`, `DashboardBar` and `BarPanelToggles` over the same fixture, so each variant frame has an original at the same width, language and theme.

`geometry.json` holds each frame's measurements. Geometry: sideways scroll of the page and of every scroller (scrollLeft pushed and read back), facts cut by their box (a Range over the text against the box), title/age overlap, phone buttons under 44 px, the panel width, and the titles visible without scrolling, in order. The visual critic's findings, each as a number under `critic`: passive text on a fill or inside a border (a pill or a chip), the gap between a stage's glyph and its name, the right edges of the open marks and of the project names, the gap between a title and the line under it, a duration printed twice in one row, the times per agent, «asks you» under «Needs you», a count in a tab, what the list opens on, whether the opened task is in view, the pane's width, the board it leaves and the empty space under its content, the selected row, the favourites fold, and whether the status popover is inside the viewport and on top. Round 2 adds: a status dot on every task row of every variant, the project right under the age, each «all projects» row's height against the same task's row in «this project» (a check across the two frames, run after the matrix), a wrapped state or question that starts left of the stage id, the word «running» anywhere in a row or a stage list, an age printed as 60 seconds or more, an open mark on every agent row of variant 3 on the phone, and the parts of the phone's pushed screens (Back, the agent's head, the task's card). `problems` names what a frame still fails; a clean frame has an empty list.

The frames are kept out of the tree (the hosted privacy gate refuses rasters); a later stage publishes them on the task's prototype review after the visual critic has judged them again.

Frame names: `original-<width>-<lang>-<theme>[-all].png`; `variant-<n>-<width>-<lang>-<theme>-<state>.png` with state `tasks`, `agents`, `expanded` (variants 1 and 2), `detail` and `agent-detail` (variant 3, phone), `all` (1440 only) and `status` (1440 only). The `tasks` and `all` frames pair with the original of the same width, language and theme.

## 5. Questions for the operator

1. **Which variant should be built?** 1, one list by recency (recommended) · 2, grouped by what it needs · 3, two panes.
2. **When does an open task with no work fold to the bottom as idle?** after 3 days (recommended) · after 7 days · after 1 day.
3. **How far back does the Agents list go?** the last 24 hours plus every agent still running (recommended) · the last 7 days · only agents running now.

Decided here without asking: a task finished within the last 24 hours stays in the recent list where its work put it, and folds into Done after that.

## 6. Measurements

All 144 frames (16 original, 128 variant) measure clean: no sideways scroll of the page or of any scroller, no fact cut by its box, no title/age overlap, no page error, every variant button on the phone at least 44 px, and an empty `problems` list in every frame.

What the critic's findings measure now, over the 128 variant frames:

| Check | Reading |
|---|---|
| Passive text on a fill or inside a border (pill, chip) | 0 in every frame |
| Gap from a stage's glyph to its name | 8 px everywhere |
| Right edge of the open mark | one value per frame: 1430, 990 and 380 px at the three widths |
| Gap from a title to the line under it | one value per frame (5 px on the desktop, 6 px on the phone) |
| Right edge of the project name («all projects») | one value per frame, right under the age in every task row |
| Row height under «all projects» against «this project», same task | equal in all 12 pairs |
| Status dot | on every visible task row of all three variants |
| Wrapped state or question starting left of the stage id; «running» in a row or stage list; an age of 60 s or more | 0 |
| Open mark on variant 3's phone agent rows | every row |
| A duration printed twice in a row, an agent line, or a row with its opened card | 0 |
| Times printed per agent | 1 at most |
| «asks you» or «Needs you» inside a row under the «Needs you» heading | 0 |
| A number in a tab | 0 |
| First block of variant 2 | «Needs you» in every `tasks`, `all` and `expanded` frame |
| Agent row height | 54 to 56 px for two lines, 70 to 73 px when the task title wraps (was about 90 px) |
| Agents visible without scrolling (uk, light) | 12, 13 and 11 at 1440 for variants 1, 2 and 3; 9, 9 and 8 at 1000; 11 on the phone |
| Variant 3 pane | 380 px wide at 1440 and 360 px at 1000; the board keeps 721 px and 321 px beside it; the pane ends 1 px under its content (297 to 551 px tall) |
| Variant 3 selection | exactly one highlighted row in the list, on Tasks and on Agents; one close button on the pane |
| Status popover (`-status`) | inside the viewport and on top in all 12 frames |
| Phone pushed screens (`-detail`, `-agent-detail`) | Back, the card, and on the agent screen the agent's head, in all 8 frames |

Panel width and the rows whose titles are visible without scrolling (uk, light, tasks):

| width | original | variant 1 | variant 2 | variant 3 |
|---|---|---|---|---|
| 1440 | 280 px / 9 | 380 px / 10 | 420 px / 9 | 340 px / 10 |
| 1000 | 280 px / 8 | 340 px / 8 | 360 px / 7 | 320 px / 8 |
| 390 | 390 px / 13 | 390 px / 10 | 390 px / 8 | 390 px / 10 |

The original's 1440 and 1000 counts include the two crowned favourites above the tasks. Every variant shows about as many rows as today while each row now carries the stage, the agent's state, the PR and the hold. Variant 3's width is its list; the card beside it adds 380 px (360 at 1000) over the board while a task is selected.

The first rows also answer the quote: today's panel opens on the favourites and then the most recently written rows; every variant opens on the tasks with the newest real work (variant 2 on «Needs you» first, by design).

The prototype sources type-check against the root configuration (`tsc --noEmit` over this folder's files in an export of the lane's base commit).

## 7. Visual critic, round 1: findings and what changed

The critic judged the first 116 frames and passed no variant. Every finding is fixed in `menu.tsx`, `data.ts`, `strings.ts` and `fixture.tsx`, and `capture.ts` now measures each one so a later change cannot bring it back unseen.

| Finding | Fix |
|---|---|
| P1, variants 1 and 3: status is a text pill on every row | The pill is gone. A dot in the status tone under the task icon, with the status name in a popover (`-status` frames). The detail header of variant 3 uses the same dot. |
| P1, variants 1 and 3: stages are bordered chips and the glyph collides with the name | A stage is its glyph, its name and its state word in the state's colour, one per line, no border and no fill. The glyph drops its corner badge (the word says the state) and stands 8 px from the name. |
| P2, variant 1: the expand chevron floats | The chevron has its own 14 px column at the row's right edge, on the title line; its right edge is the same pixel in every row. |
| P2, variants 1 and 2: the needs-you row says it twice, with two ages, in its palest text | One line in the attention colour: «asks you: <question>» (variant 1 and 3), the question alone under the «Needs you» heading (variant 2). No hold sentence and no second age on that row; other holds keep the board's sentence without its age. |
| P2, variant 1, all projects: the project name has no fixed place | The project sits under the age, on line 2, right-aligned to one edge in every row, in all three variants and in the Agents list. It adds no line. |
| P2, variant 1: a one-line title leaves an empty band | The title no longer reserves two lines; the gap from a title to the line under it is one value in every row. |
| P2, Agents list: one fact twice, «stage» on every row, 90 px rows | One time per agent (the launch age); the state sits beside the name; only a spawned agent is marked. A row is two lines when the task title fits and three when it wraps. In a card the agent's facts stand side by side (name, model, state), and the launch age is printed only for an agent that is not working, since the row already says how long a working one has worked. |
| P2, variant 2: the Tasks menu opens on agents | The agents strip is cut. Variant 2 has the same `Tasks | Agents` tabs as the others; the first block under the head is «Needs you». |
| P2, variant 2: the agents view is titled and equipped as Tasks | The tabs are the heading; «+ new task» is absent on the Agents tab; the way back is the Tasks tab. |
| P2, variant 2 and variant 3 on the phone: nothing shows that a row opens | Variant 2 rows carry the chevron and expand in place (`variant-2-*-expanded`, every width, language and theme). Variant 3's phone rows carry a right chevron. |
| P2, variant 3: the detail pane is half empty, facts stretched, 120 px of board left at 1000 | The pane is as wide as a card (380 px, 360 at 1000) and as tall as its content; the board keeps 720 px at 1440 and 320 px at 1000, plus everything under the card. The agent's facts stand side by side. |
| P2, variant 3, Agents tab: no selection, the agent drawn twice, favourites missing | The selected agent is highlighted in the list; the pane shows the agent's model and its task's card, without repeating the list row or the agents section; the favourites fold is there. |
| P3, variants 1 and 3: two task counts in one view | The tabs carry no number. |
| P3, variant 2, all projects: PR and project read as one string, the age floats | The project is under the age; the age is aligned to the title's first line in every row. |
| P3, variant 3: the activity list contradicts the agent line | The fixture's newest event of a working agent is a pushed commit; an asking agent's is its question; the failed refresh is failed in the task, the stage and the agent alike. |

## 8. Visual critic, round 2: findings and what changed

The critic judged all 136 frames of round 1 and raised two P2 and three P3 findings. Each is fixed in every variant it named, and `capture.ts` measures each one in every frame.

| Finding | Fix |
|---|---|
| P2, variant 2: no status dot, so a blocked task in «Waiting» reads like the rest | Every variant-2 row carries the same dot under the icon with the same popover as variants 1 and 3; `variant-2-1440-*-status` frames show it open. The driver fails a `tasks`, `all`, `expanded` or `status` frame where any visible row lacks its dot. |
| P2, variant 3 on the phone: agent rows have no open mark, and the agent's screen was never rendered | Agent rows carry the chevron in a column of their own, as task rows do; a tap pushes the agent's screen: Back, the agent (model, state, launch age), then its task's card (`variant-3-390-*-agent-detail`). |
| P3, «all projects» in Ukrainian: the project narrows line 2 and pushes the PR or the question onto a third line | The project sits right under the age, and «this project» keeps its place empty so a title wraps the same in both scopes; line 2 starts under the title and takes the row's full width once the title has two lines. A wrapped state or question continues under the stage id. The driver compares every «all projects» row with the same task's row in «this project». |
| P3, English: the same state is «running» on the stage and «working» on the row and the agent | A running stage reads «working» in the stage list, on the row and on the agent line (Ukrainian already said «працює» everywhere). |
| P3, the first row's age reads «60 s ago» above «2m ago» | The fixture's newest work is 40 seconds old; the driver fails an age printed as 60 seconds or more. |

## Deferred — not currently justified

- **A strip of the four newest agents above the tasks** (variant 2, first round). The critic found it pushed the first task 150 px down (220 px on the phone) in a menu named Tasks; the Agents tab holds the same list.
- **A count on each tab.** Two numbers for tasks a few pixels apart (the bar's and the tab's) read as a contradiction; folds and groups carry the counts.
- **PR checks state on the row** («checks running / passed / failed»). The client never receives it: `checkRollup` is read only by auto-merge and self-update at the moment they act. Showing it would add a per-PR forge read on every poll. The agent's «waiting on checks» state carries the part the operator acts on.
- **Search and filters inside the menu.** The bar already has the one task search (`board-header.md` decision 4); a second one in the menu is not asked for.
- **Live «what happened» timeline beyond the last five events** (variant 3): needs an event store per task; the last stage and PR events are derivable from what the board holds.
- **Sorting controls** (by created, by priority). The quote asks for one order: recent work first.
- **Agents grouped by account or engine.** Not asked; the model glyph already names the engine.
- **Place on the map** (D5). The board is the kanban; no surface places an unplaced task any more.
