# Board timeline as a manager's view: working tasks on top, due dates, long tasks within the window, room beside the seat panel

Status: build brief, 2026-11-13. Covers acceptance A to F of the lane's pinned
specification. Builds on the board timeline (`docs/design/board-timeline/data.md`,
PR #3545, #3627) and on the scroll fix lane a6c199d8.

## 1. Requirement

On 2026-11-13, about 08:00Z, the operator wrote in the seat chat (voice dictation,
paraphrased here) that the task chart does not show when each task is expected to
finish as of now; that tasks running for days take far too much room and should be
shown approximately; and that the chart should be reviewed on this server's own
production by someone who uses it as a project manager, then fixed.

A read-only critique of production followed (release ce7806df, 2026-11-13
08:05–08:30Z). Its findings, with the numbers this brief relies on:

- At «1 день» 19 of 28 task bars are identical and full width; the canvas is 10.1
  screens wide at 1440 px and 14.5 on the phone.
- A bar runs from the first work to now (`src/lib/board/taskTimeline.ts:249-250`), so
  idle time reads as work: one task shows 14 days solid for a single 7 min 48 s stage.
- Rows sort oldest first (`taskTimeline.ts:252`), so the 8 tasks with a live agent sit
  at rows 17–28.
- The header «У роботі: 28» counts 16 tasks of the «Очікують» column; the kanban tab
  on the same screen says 26.
- The chart reads no due date, slip count, progress or hold reason, although all 28
  tasks have a due date, 2 are about four days overdue and 16 were moved, up to nine
  times. Durations read «340 год».
- With the seat panel expanded, 49 px of chart remain at 1440×900 and 27 px at
  1024×768 (`src/components/kanban/boardTimeline.css:39`), while the kanban in the same
  place scrolls with the page.
- Measured density (seat folded, 1 day, tasks collapsed): 13 task rows per screen at
  1440, 9 at 1024, 6 at 390; task rows 49–67 px on desktop and 72–91 px on the phone;
  chart head 45, 60 and 95 px.

The operator then answered a decision form (2026-11-13, about 10:45Z), choosing the
recommended option each time:

1. Long tasks: an axis within the selected window, a thin line while the task idles
   and thick segments where work ran, and a collapsed «Стоять довше 3 днів» line.
2. Expected finish: first the due date from the board (a flag, red when overdue, the
   number of moves); a computed forecast comes later.
3. In work: only tasks with a live agent on top; below them collapsed groups «Чекають
   на вас» and «Стоять».
4. Desktop with the seat panel expanded: like the kanban, a minimum chart height and
   the page scrolling under the panel.

Earlier requirement on the same chart, 2026-10-31: very compact vertically, by using
space better and never by cutting information.

The chart's first build was chosen from a prototype on 2026-10-27 as a hybrid: one
collapsed row per task with a bar over its time and a thin strip of agent colours
along the bar's bottom; expansion into one row per agent or stage; the task in work
expanded by default; expansion remembered; a «now» line; vertical scroll; − / + zoom.
This brief keeps every element of that choice that the 2026-11-13 decisions did not
replace (§9 lists each field). The operator replaced «expanded by default» on
2026-11-14: every task is collapsed by default (§19).

## 2. What the code does today

| Piece | Where | Behaviour that matters here |
| --- | --- | --- |
| Projection | `src/lib/board/taskTimeline.ts:151-254` | Tasks with an open lane or a working resolved member; attempts carry `startedAtMs`, `endAtMs` (completion or confirmed stop, or now for the operational attempt; `:19-20`, `:100`), `observedTurn` (`:65-74`), `live` (`:97`). Task span = first work to now (`:249-250`); sort oldest first (`:252`). |
| Component | `src/components/kanban/BoardTimeline.tsx` | Header «У роботі: N» (`:183`) and legend (`:184`); canvas from the earliest start to now + 22 % of the window (`:116-120`), positioned by writing `scrollLeft` whenever its key changes, data refresh included (`:121-128`); summary bar with tone fill, bracket and observed-turn strips (`:230-238`); stage rows (`:240-258`); the «‹ date» control that scrolls back to an earlier stage (`:254-255`); default expansion from the projection's `live` (`:212`). |
| Row fitting | `BoardTimeline.tsx:61-103`, `:191-192` | Fits the viewport height to whole rows on every scroll event. Lane a6c199d8 restricts this to layout changes and adds a gesture guard (§11). |
| Stylesheet | `src/components/kanban/boardTimeline.css` | `.bt-scroll` scrolls both axes with `overscroll-behavior: contain` (`:6`); `.kb .board-frame:has(> .board-timeline)` makes the frame flexible with `min-height: 0` (`:39`). |
| Expansion store | `src/components/kanban/boardTimelineStore.ts` | One localStorage record per project: `view`, `hours` (6, 12, 24, 72, 168), `expanded: Record<string, boolean>`; `parseTimelinePreference` keeps every boolean entry (`:18`); default expansion from a flag (`:55-57`). |
| Kanban «working» | `src/components/workingAgents.ts:29-38`; `src/components/kanban/kanbanModel.ts:931`, `:1056` | `isWorkingAgent` is the one rule; a card's `working` counts its members working now; a column's `working` sums its cards; the desktop column head shows it as `.live[data-count]` (`KanbanBoard.tsx:3593`), the phone tab as `[data-phone-tab-working]` (`MobileKanban.tsx:692`). |
| Kanban motion and quiet | `src/lib/tasks/motion.ts:24-52`; `kanbanModel.ts:418-443` | `taskMotion` gives `needs-you` first; `workedRecently` is «work in flight, or agent or lane movement within `DONE_TASK_BOARD_RETENTION_MS`» (3 days, `src/lib/tasks/boardVisibility.ts:5`); `parkedCard` puts quiet stopped cards under the column's «Без руху · N» divider (`KanbanBoard.tsx:3647`). |
| Due date | `src/lib/tasks/types.ts:253-261`; `src/lib/tasks/helpers.ts:22-39`; `src/components/kanban/TaskMeta.tsx` | `dueAt`, `dueTz`, `dueHistory.slips`; `formatDue` and `isOverdue`; the card shows «⏰ date · прострочено» in danger ink. Nothing renders `slips` today. |
| Page scroll on desktop | `src/components/kanban/kanbanBoard.css:983`, `:991`, `:1230`; `docs/design/independent-panel-scroll.md` | `.kb-page` scrolls vertically and holds the seat and the board frame; `.board-frame` is `height: max(440px, 100%)` (32 px less while the seat's return strip shows); columns contain their own vertical overscroll and the page scrolls from its scrollbar and the heads. |
| Mounts | `KanbanBoard.tsx:574-577`, `:3259-3262`; `MobileKanban.tsx:946-949`, `:1340-1341` | Both build `tasks` from the shown cards of every column and `members` from their working members plus resolved workflow references. |

## 3. One definition of a live agent (A)

**Decision.** A task belongs to the top of the chart when its kanban card has
`working > 0`, the count `kanbanModel.ts:931` takes with `isWorkingAgent`. The chart
reads this from the card; the projection's `live` flag no longer decides it.

- Both mounts pass the shown cards that hold a task (`cards: readonly KanbanCard[]`)
  in place of `tasks`; the component derives `tasks` from them for the projection.
- The header's working number is the sum of `card.working` over those cards. It
  counts agents, as every green number of the kanban does: a task with two working
  agents adds 2, as it does on its card. With no search narrowing the board, the
  number equals the sum of the green counts of the «Вхідні», «У роботі» and
  «Очікують» columns (`.live[data-count]` on desktop, `[data-phone-tab-working]` on
  the phone). In the fixture, shaped like production, one live task sits in
  «Очікують»: the chart says 8 and the tabs say ●7 and ●1. Done tasks never enter the
  chart, as today.
- Each working card of this project gets a row even if the projection returned no row
  for it (no open lane and its member filtered out): the row shows its label and «Час
  невідомий», with no bar. This keeps the agreement by construction. A finished task
  and another project's task never get one, whatever they hold; the header's number
  sums the cards of the rows drawn.
- The conversation of a stage that completed and was resumed counts as working only
  when the card counts it (a member of the card); the chart follows the kanban here
  and does not lift such a task.
- Default expansion no longer depends on the group (§19): a task is collapsed until the
  person opens it (`timelineExpanded(preference, taskId)`). The projection's
  attempt-level `live` stays for stage glyphs and stage state words.

## 4. Groups and the three-day line: one grouping (A, C)

**Decision.** One function, beside `parkedCard` in `kanbanModel.ts`, assigns each
chart card a group, first match wins:

```
timelineGroup(card, nowMs):
  card.working > 0                   → "working"     top, no group row
  card.motion.key === "needs-you"    → "needs-you"   «Чекають на вас · N»
  workedRecently(card, nowMs)        → "still"       «Стоять · N», recent part
  otherwise                          → "still-long"  «Стоять довше 3 днів · N», inside «Стоять»
```

`workedRecently` is exported from `kanbanModel.ts` and used unchanged, so the chart's
three days are the kanban's three days (`DONE_TASK_BOARD_RETENTION_MS`) and a task
counts as moving on the same evidence that keeps a card above the «Без руху» divider.

The «Стоять» group is one group with one count. Expanded, it lists its recent tasks
and ends with one nested collapsed line «Стоять довше 3 днів · N» holding the rest.
Collapsed, its row already says how many of its tasks are quiet for longer than three
days. So the operator's two decisions read as one structure:

```
closed (default)
● 8 працюють · ● 6 чекають на вас · ● 14 стоять            header
[8 task rows, live agents]                                  top
› Чекають на вас · 6                                        group row
› Стоять · 14      довше 3 днів: 8 · прострочено: 2         group row, meta while closed

«Стоять» open
⌄ Стоять · 14
  [6 task rows quiet up to 3 days]
  › Стоять довше 3 днів · 8      прострочено: 1             nested line, closed by default
    (open) [8 task rows]
```

- A task that needs the operator stays in «Чекають на вас» however long it has been
  quiet. That group is the operator's own queue; folding it into the three-day line
  would hide exactly the tasks only he can move. The three-day line is the tail of
  «Стоять».
- A task with a live agent that also needs the operator stays on top (decision 3 puts
  live agents first). Its row states the stage's need in the state words it already
  shows («Build 3 · потрібні ви»).
- A task whose lane runs between turns, or is provisioning, with no agent working now
  goes to «Стоять» (recent part); its stage state words already say so (for example
  «зараз не працює»).
- A closed group row (and the closed nested line) shows its overdue count in danger
  ink when it is above 0, so a closed group never hides that a task in it is late. The
  closed «Стоять» row also shows «довше 3 днів: N». Both meta parts disappear while
  the group is open, because the rows and the nested line then show those facts
  themselves.
- The header's split and the group rows both carry the group counts, as acceptance A
  asks: the header keeps the split visible when the group rows are scrolled away.
- Expansion lives in the same `expanded` record as task expansion, under the keys
  `group:needs-you`, `group:still` and `group:still-long` (task ids are UUIDs, so the
  prefix cannot collide). Groups default to closed. No store schema change:
  `parseTimelinePreference` already keeps these entries.
- Order inside every group, the top included: due date ascending (overdue first), tasks
  without a due date last, then task start, then id. A manager reads it as «what is
  late, what finishes next»; due dates change rarely, so rows do not move while a turn
  starts or ends.
- An empty group has no row. With no working task the header still says «0 працюють».

## 5. Window axis and paging back (C)

**Decision.** The lane is exactly one window wide and fits the screen; older time is
reached by paging the window back on purpose.

```
W        = hours × 1 h                         (6 h, 12 h, 1 day, 3 days, 1 week)
liveEnd  = ceil to the hour (now + 0.22 W)      today's right margin, unchanged
viewEnd  = pagedEnd ?? liveEnd
viewStart= viewEnd − W
laneWidth= scroller.clientWidth − labelWidth    (phone: scroller.clientWidth)
```

- The canvas is `laneWidth` wide; `.bt-scroll` gets `overflow-x: hidden` and the
  `scrollLeft` positioning effect (`BoardTimeline.tsx:121-128`) is deleted. Measuring
  the scroller's `clientWidth` replaces the hard-coded 17 px gutter, so nothing
  overflows by a scrollbar's width on any platform.
- Every lane gets `overflow: hidden`; bars, segments and lines are clipped at both
  edges.
- `pagedEnd` is component state, never persisted. It resets to live on a scale
  change, on a project change and from the return control.
- Paging back uses the existing stage-row control «‹ 30 жовт. 05:58»
  (`BoardTimeline.tsx:254-255`): its click, which wrote `scrollLeft`, now sets
  `pagedEnd = min(liveEnd, stageStart − 0.05 W + W)`, putting the stage's start 5 %
  from the left edge. It still appears exactly when a stage ended before the visible
  window (`hiddenBefore`, with the left edge at x = 0).
- While paged back, the axis's «Зараз 08:10» label becomes a button at the axis's
  right edge, «Зараз 08:10 ›» (aria «Повернутися до поточного часу»), which clears
  `pagedEnd`. It is the existing now label given an action; no other control is
  added.
- Zooming out to «1 тиждень» widens the window as today.
- Ticks and day labels keep their algorithm with the view's start as `from` and a
  horizontal offset of 0.

Paging changes lane content only. Row heights do not depend on the window: the start
text lives in the label and is the same at every scale (§8), so the existing
frozen-label paint check keeps holding.

## 6. Bar anatomy and where its times come from (C)

The lane of a task row has two tracks: a text track (11 px label text, 14 px line) on
top and a bar track below it, anchored to the lane's bottom.

| Element | Extent | Look |
| --- | --- | --- |
| Thin line (`.bt-bracket`, restyled) | task start → now, clipped to the window | 2 px `--color-secondary` line through the middle of the bar track, with 10 px end ticks at the start and at now; the start tick is absent when the start is clipped. The chosen summary bracket becomes this line; its soft tone fill is removed by decision 1. |
| Clipped start (`[data-timeline-clipped]`) | task started before `viewStart` | a «‹» glyph at x = 0 in the bar track, decorative (`aria-hidden`); the start date is in the label. |
| Thick segments (`[data-timeline-segment]`) | each attempt of each linked lane, and each standalone agent row | solid stage tone (`STAGE_TONES[chipState(attempt)].color`), 10 px tall on desktop, 8 px on the phone, at least 3 px wide, radius 2 px; `data-start-ms` and `data-end-ms` carry the unclipped times. |
| Observed-turn strip (`[data-timeline-strip]`) | the matching member's latest native turn, as today | unchanged: 4 px, engine colour, along the bottom of the bar track, with today's tooltip. |
| Now line | now | unchanged. |
| Due flag and its words | §7 | §7. |

Times, all from records the board already reads (`/api/files?view=summary`, which
keeps every attempt timestamp; nothing new is fetched):

| Case | Source | Drawn |
| --- | --- | --- |
| Task start | `TaskTimeline.startedAtMs`: first attempt start, else first lane creation, else a standalone agent's turn or launch time (`taskTimeline.ts:205-207`, `:234-249`) | the thin line from there; when null, no thin line and the label says «Час невідомий» |
| Attempt with start and end | `PipelineRun.attempts[].startedAt`; end = `completedAt` or confirmed `suspension.stoppedAt`, whichever is first, or now for the cursor stage's operational attempt (`TimelineAttempt.endAtMs`) | a segment [start, min(end, now)] |
| Attempt with a start and no end (not completed, not stopped, not operational) | `startedAtMs` only | a 3 px tick at the start, tooltip «кінець невідомий»; the stage row keeps «Минуло: Час невідомий» and draws the same tick |
| Attempt without a start (pending, never started) | none | nothing; the stage row keeps its state words |
| Standalone working agent | its open turn's start, else launch admission, prompt or delivery time; end = now | a segment from start to now |
| Lane with no attempts yet | lane creation only | the thin line alone; state «Очікує на агента» |

An attempt's span is its lifecycle, waits inside the attempt included
(`taskTimeline.ts:19-20`). That is what «where its stages actually ran» can say from
the records; time spent inside a turn stays the strip's job, and its data gap is a
deferred step (§14).

## 7. Due date, edge marker and the words for them (B)

For every task row whose task has a parseable `dueAt`:

- **Flag.** A 2 px pole across the bar track at `x = (dueAt − viewStart) × pxPerMs`
  with a 6×5 px head at its top; `--color-secondary`, or `--color-danger` when
  `isOverdue(dueAt, now)`. `[data-timeline-due="due"|"overdue"]`. Desktop hover
  shows a tooltip with the zone (`cardState.dueTitle`) and the full words.
- **Words, in the text track.** «до 13 лист., 14:00 · переносили 6 разів»; overdue:
  «прострочено на 4 д · переносили 2 рази» in danger ink, weight 600 (the card's
  overdue style). The date is `formatDue(dueAt, dueTz, locale)`, the zone the task was
  set in (the viewer's zone when `dueTz` is missing). The slip part is omitted at 0.
- **In-window placement without measuring.** The words sit in the lane's own flow, above
  the bar track, with `margin-left: x` and `transform: translateX(−p %)`, where
  `p = 100 × x / laneWidth`. The text's left edge is then `x(1 − w/L) ≥ 0` and its right
  edge `≤ L` for any text narrower than the lane, and the pole always stays under the
  text. The longest strings (about 230 px at 11 px) fit the narrowest lane the named
  widths give (390 px phone, 410 px at 1024). A lane narrower than its words (a desktop
  of 720 px has a lane of about 250 px) wraps them (`max-width: 100%`) and grows by a
  line, so no word is cut; the phone lane is fixed and never needs it.
- **Edge marker.** When the due instant lies before `viewStart`: «‹ ⚑ прострочено на
  4 д · переносили 2 рази» at the text track's left edge. After `viewEnd`: «⚑ до 16
  лист., 12:00 · переносили 2 рази ›» at its right edge.
  `[data-timeline-due-edge="left"|"right"]`. The arrow says the direction, the words
  say when.
- **Phone.** The same text track runs the full 390 px under the label, so the facts
  are written in the row on the phone too, once.
- **No due date.** No flag, no words, no change in row height (the text track has a
  fixed height).
- **Lateness and every other duration** use one rule: two days or more in whole days
  («14 д», `mobile2.kanban.ageDays`), otherwise `humanizeDuration` («3 год 48 хв»).
  This covers the task elapsed, stage elapsed, last turn and lateness words.

No forecast is computed in this lane.

## 8. Row anatomy at 1440, 1024 and 390

Widths come from the critique's measurements: the chart is 1192 px wide at 1440
(label 380 px, lane 795 px) and 776 px at 1024 (label 349 px, lane 410 px); on the
phone the label and the lane are each 390 px, stacked.

Sketch notation: `─` thin line, `█` thick segment, `┊` now line, `⚑` due flag (pole
across the bar track, head at its top), `‹` clipped start. Text right above a bar
track is that lane's text track.

### 1440 × 900, uk, «1 день», tasks collapsed, groups closed

```
┌─ head 45 px ───────────────────────────────────────────────────────────────────────────────────────────┐
│ ● 8 працюють · ● 6 чекають на вас · ● 14 стоять                                      −    1 день    +   │
│ Лінія — задача відкрита; відрізки — працювали етапи; колір знизу — останній відомий хід; ⚑ — строк.    │
├─ axis 44 px ─────────────────────────────┬───────────────────────────────────────────────────────────────┤
│ Задача                                   │ 12 лист.                13 лист.                              │
│                                          │  14:00   17:00   20:00   23:00   02:00   05:00  Зараз 08:10   │
├─ task row 49 px ─────────────────────────┼───────────────────────────────────────────────────────────────┤
│ › Тимчасові файли накопичуються  з 11.11 │                                         до 13 лист., 16:10    │
│   · 40 год  Етапів: 13  Fix · працює     │‹─█──█─██────█─────█─██████████████████┊           ⚑           │
├──────────────────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ › Одне джерело правди про стан агента    │                                      ⚑ до 15 лист., 18:10 ›   │
│   з 07:04 · 1 год 6 хв  Етапів: 1  …     │                                   ─█████┊                     │
├──────────────────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ › Чекають на вас · 6                     │                                                               │  group row 34 px
├──────────────────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ › Стоять · 14  довше 3 днів: 8 ·         │                                                               │  group row 34 px
│   прострочено: 2                         │                                                               │
└──────────────────────────────────────────┴───────────────────────────────────────────────────────────────┘
```

- Label: as today, title (13 px, 600) and meta (11 px) in one flow, wrapping. Meta
  order: «з 11.11 · 40 год» (start in words and elapsed; replaces «Минуло: 40 год 13
  хв»), «Етапів: N», «N агентів» when there are standalone agents, then the current
  stage and its state when collapsed. The start is the time («з 07:04») for a task
  started today, the date («з 30.10») otherwise, so it never depends on the window.
- Lane: at least 34 px (today 32); it takes the label's height, 49 px for a two-line
  label. Text track above, bar track 10 px tall with its bottom 8 px above the row's
  bottom border.
- Group row: the disclosure button and «Чекають на вас · 6» (13 px, 600) with its
  meta (11 px). At 1440 the longest group label («Стоять · 14 довше 3 днів: 8 ·
  прострочено: 2», about 290 px) fits the 356 px text column on one line (the sketch
  wraps it only for lack of columns); at 1024 and 390 it may wrap to a second line.
  The lane cell stays empty grid. The nested «Стоять довше 3 днів» line indents its
  label 16 px.

A still-long task opened inside its group, 14 days old, one 8-minute stage long ago,
due in 4 hours, moved 6 times, and an overdue one:

```
│ › Нові рушії керування    з 30.10 · 14 д │                      до 13 лист., 12:10 · переносили 6 разів │
│   Етапів: 1  Build · не пройдено         │‹──────────────────────────────────────┊        ⚑             │
├──────────────────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ › Проєкт і робота одним викликом         │‹ ⚑ прострочено на 3 д                                         │
│   з 08.11 · 4 д  Етапів: 2  Build · …    │‹──────────────────────────────────────┊                       │
```

Paged back from a stage row's «‹ 30 жовт. 05:58»:

```
│ Задача                                   │ 29 жовт.               30 жовт.                Зараз 08:10 › │
│                                          │  08:00   11:00   14:00   17:00   20:00   23:00   02:00       │
```

### 1024 × 768

The same anatomy with a 349 px label and a 410 px lane. Meta wraps to a second line
for long titles exactly as today (task rows 49–67 px). The words of the longest due
text (about 230 px) fit the 410 px lane by the proportional anchor.

```
│ › Баланс і витрати в API-режимі   │                 ⚑ до 14 лист., 16:10 · переносили 3 рази ›│
│   з 05.11 · 7 д  Етапів: 4        │‹─────────█──────────────────────────────┊                   │
│   Build 3 · потрібні ви           │                                                            │
```

### 390 × 844 (phone)

```
┌─ head ≤ 95 px (today 95) ────────────────┐
│ ● 8 працюють · ● 6 чекають   − 1 день +  │
│ на вас · ● 14 стоять                     │
│ Лінія — задача відкрита; відрізки —      │
│ працювали етапи; колір знизу —           │
│ останній відомий хід; ⚑ — строк.         │
├─ axis 44 px ─────────────────────────────┤
│ 12 лист.            13 лист.             │
│ 20:00  23:00  02:00  05:00 Зараз 08:10   │
├─ task row 72–91 px, as today ────────────┤
│ › Тимчасові файли накопичуються          │  title 13 px / 600 (44 px disclosure)
│   з 11.11 · 40 год  Етапів: 13           │  meta 11 px: one line on a real 390 px row,
│   Fix · працює                           │  wrapped here for the sketch's width
│                    до 13 лист., 16:10    │  lane 26 px: text track 14 px
│‹─█─█─██───█───█─████████████┊    ⚑       │  bar track, 8 px band
├──────────────────────────────────────────┤
│ › Чекають на вас · 6                     │  group row 44 px, no lane
├──────────────────────────────────────────┤
│ › Стоять · 14  довше 3 днів: 8 ·         │  closed: meta wraps
│   прострочено: 2                         │
└──────────────────────────────────────────┘
```

- The phone lane stays 26 px: text track from 1 to 15 px, band from 17 to 25 px, thin
  line through the band's middle, flag pole from 14 to 26 px.
- Group rows have no lane on the phone; the disclosure is the 44 px target.
- Stage rows keep today's phone anatomy, including the 44 px lane while their «‹
  date» control shows.
- The meta line loses about 45 px («Минуло: 340 год 14 хв» becomes «з 30.10 · 14 д»),
  so a label never gains a line from this change.

### The header

«● N працюють · ● N чекають на вас · ● N стоять»: 6 px dots in `--color-success`,
`--color-warning` and `--color-muted` (aria-hidden; the words carry the meaning),
then the counts with `kanban.columnWorking`, `kanban.columnNeeds` and a new
`timeline.stillCount`. The legend is rewritten for the new bar and is shorter than
today's in both languages (uk 99 against 124 characters, en 88 against 107), so the
phone head does not grow although the split line can wrap to two lines.

## 9. Every field stays reachable (E)

| Today | After |
| --- | --- |
| Task title, disclosure | unchanged |
| «Минуло: 340 год 12 хв» | «з 30.10 · 14 д» (start and elapsed; days from 2 d) |
| «Етапів: N», «N агентів» | unchanged |
| Current stage · state, or «Очікує на агента» (collapsed) | unchanged |
| Summary bar with the current stage's soft tone | thin line with end ticks plus thick segments, each in its own stage tone; the current stage's state stays in words |
| Summary bracket | the thin line's end ticks |
| Agent-colour strip with tooltip (the chosen hybrid's strip) | unchanged |
| Bar tooltip «title: Минуло: …» | on the thin line, same words |
| Stage row: glyph, name, state, «Минуло», last turn or «Час роботи невідомий», engine · model, outline bar, work fill | unchanged; durations from 2 d in days; bars clipped to the window |
| Stage row «‹ date» control | same control; its click pages the window |
| Header «У роботі: N» | the split counts |
| Legend | rewritten for the new bar (§13) |
| − / + zoom, scale word | unchanged; a zoom returns the window to live |
| Axis days, ticks, now label | unchanged; the now label is the return button while paged |
| Persisted task expansion | unchanged; a stored choice, open or closed, is kept |
| Default expansion of the task in work | collapsed by default (§19), replacing the expanded default |

New controls: the group disclosures (the existing `.bt-disclosure`) and the now
label's return action. No pill: states are dots with words in the header, flags and
words in lanes.

## 10. Beside the seat panel (D)

**Decision.** Replace `.kb .board-frame:has(> .board-timeline) { flex: 1 1 auto;
height: auto; min-height: 0; }` (`boardTimeline.css:39`) with the same rule at
`min-height: 440px`, and keep it ahead of the return-strip height rule
(`kanbanBoard.css:1230`). The frame is the kanban's own `max(440px, 100%)` only in
effect: with the seat folded it takes exactly what the seat leaves of the page (so no
row is cut by the window at rest, which a plain `height: max(440px, 100%)` would do,
because the seat's strip sits above it), and with the seat expanded it keeps 440 px:

- the page (`.kb-page`) scrolls under the expanded seat; the frame is at least 440 px
  and, scrolled down, as tall as the page; the return strip appears as on the kanban;
- `.bt-scroll` becomes `overflow-x: hidden; overflow-y: auto; overscroll-behavior-y:
  contain`, the columns' rule: a wheel or a finger inside the rows stays in the chart
  at both ends, the page scrolls from its scrollbar, the seat's head, the chart's head and the
  return strip (`docs/design/independent-panel-scroll.md`);
- `fitRows` measures the timeline root, which fills the 440 px or taller frame, so it
  fits whole rows into that height as it does with the seat folded.

At 1440×900 (page ≈ 852 px) and 1024×768 (≈ 720 px) the chart is then at least 440 px
tall, and scrolled to the page's end it fills the page under the 32 px strip. Every
row is reached by scrolling the page, then the chart. The phone has no seat panel
here and is unchanged.

## 11. Lane a6c199d8 (fence)

That lane (still building; its branch was not on the remote at 2026-11-13 11:41Z,
when `origin/main` was 4931ed1d)
changes `BoardTimeline.tsx` lines 53–113, 159–162 and 189–192: a gesture guard,
`fit(force)` on layout changes, `fit(false)` on data refresh, arrow keys by row. It
also adds the case «chart follows touch, trackpad, wheel and key scrolling without
jumps» to the kanban driver.

- At build start: if its change is on `origin/main`, build on it. Otherwise merge its
  published branch with a merge commit first. If it is still unpublished, build on
  `origin/main` and say so in the report; whichever lane lands second resolves the
  overlap above. At build time the branch was published and was merged (merge commit)
  before any change here.
- This design writes no `scrollTop`, no `scrollLeft` and no height during a gesture or
  on refresh. It deletes the only remaining refresh-time `scrollLeft` write (the
  positioning effect). Group expansion is a change of `preference.expanded`, which
  that lane already treats as a layout change (`fit(true)`). A group membership change
  on refresh is a data refresh (`fit(false)`).
- Its case needs ≥ 28 task rows from 30 tasks without working agents. Under §4 those
  tasks sit in closed groups, so the case's stored preference gets
  `"group:needs-you": true, "group:still": true, "group:still-long": true` beside the
  task keys. Its assertions stay unchanged and green.

## 12. Files

| File | Change |
| --- | --- |
| `src/components/kanban/kanbanModel.ts` | export `workedRecently`; add `timelineGroup(card, nowMs)` beside `parkedCard`. |
| `src/lib/board/taskTimelineView.ts` (new, pure) | `timelineWindow`, `pageTo`, `attemptSegment` and `clipSpan` (the table in §6), `dueMark` (place, x, overdue ms), `anchorShift`, `timelineDuration`, `startWords` and `compareTimelineRows` (the due order). |
| `src/components/kanban/BoardTimeline.tsx` | `cards` prop; groups and nested line; header split; window and paging; thin line, segments, clipped glyph, due flag, words and edge marker; start words in the label; day durations; default expansion from the working group. |
| `src/components/kanban/boardTimeline.css` | delete `:39`; `.bt-scroll` axes; lane tracks and `overflow: hidden`; new classes; phone group rows without lane. |
| `src/components/kanban/boardTimelineStore.ts` | a `groupKey()` helper; no schema change. |
| `src/components/kanban/KanbanBoard.tsx`, `src/components/mobile/MobileKanban.tsx` | pass `cards` in place of `tasks`. |
| `src/lib/i18n/en.ts`, `uk.ts` | §13. |
| Tests | `kanbanModel.test.ts` (grouping and the 3-day boundary), `taskTimelineView.test.ts` (new), `boardTimelineStore.test.ts` (group keys survive a write and a parse), the driver (§16). |

`src/lib/board/taskTimeline.ts` and its tests stay unchanged: the projection keeps
its order and fields; the component orders within groups.

## 13. Strings

| Key | uk | en |
| --- | --- | --- |
| `timeline.legend` (rewritten) | Лінія — задача відкрита; відрізки — працювали етапи; колір знизу — останній відомий хід; ⚑ — строк. | Line: task open. Blocks: stages ran. Colour underneath: last observed turn. ⚑: due date. |
| `timeline.since` | з {start} · {duration} | since {start} · {duration} |
| `timeline.due` | до {date} | due {date} |
| `timeline.overdueBy` | прострочено на {duration} | overdue by {duration} |
| `timeline.slips` | one: переносили {count} раз; few: … {count} рази; many: … {count} разів; other: … {count} разу | one: moved once; other: moved {count} times |
| `timeline.stillCount` | one: {count} стоїть; few/many/other: {count} стоять | {count} stopped |
| `timeline.group.needs` | Чекають на вас · {count} | Waiting for you · {count} |
| `timeline.group.still` | Стоять · {count} | Stopped · {count} |
| `timeline.group.stillLong` | Стоять довше {days} днів · {count} | Stopped over {days} days · {count} |
| `timeline.group.longCount` | довше {days} днів: {count} | over {days} days: {count} |
| `timeline.group.overdue` | прострочено: {count} | overdue: {count} |
| `timeline.backToNow` | Повернутися до поточного часу | Back to now |
| `timeline.endUnknown` | кінець невідомий | end unknown |

Reused: `kanban.columnWorking`, `kanban.columnNeeds`, `timeline.now`, `timeline.expand`, `timeline.collapse`, `timeline.elapsed`,
`timeline.unknownTime`, `mobile2.kanban.ageDays`, `cardState.dueTitle`. Removed:
`timeline.tasks`. `{days}` is `DONE_TASK_BOARD_RETENTION_MS` in days.

## 14. Deferred — not currently justified

- A computed forecast range (decision 2, second step).
- Showing who works now and for how long on collapsed bars: the observed-turn data
  defect behind «Час роботи невідомий» on every stage row.
- Phone density beyond «no worse than today», tapping a bar to open its card, pinned
  task titles over expanded stages.
- Legend wording beyond the bar it explains.
- Progress, hold reason and steps in chart rows; an overdue count in the header.
- Native horizontal scrolling or swipe paging of the window (it would reopen the
  gesture fence); paging buttons on task rows (they would grow phone rows to 44 px).
- Flagging an operator hold on a task that has a live agent (it stays on top with its
  stage words).
- Changing «the task in work is expanded by default» when many tasks are live: no
  decision of 2026-11-13 touched it. The operator replaced it on 2026-11-14 (§19).

## 15. Options considered

| Question | Chosen | Not chosen, and why |
| --- | --- | --- |
| Where the three-day line goes | nested tail of «Стоять» | three sibling rows: the «Стоять» row would show a count different from the header's and from the group decision 3 names |
| Which tasks the three-day line takes | only those not working and not needing the operator | needs-you tasks too: hides the operator's queue |
| Working number | agents, summed from cards | task count: disagrees with every green number on the kanban |
| Order in groups | due date | kanban working-since order: moves rows on every turn |
| Older time | paging with the existing stage control | a wide canvas (the critique's 10 screens); gesture paging (gesture fence, phone scroll conflict) |
| Due words | lane text track with a proportional anchor | label meta: +1 line per row at 390 and 1024, density worse |
| Segment colour | stage tone, solid | engine colour: the strip already carries engine identity; the strip's legend stays valid |

## 16. Rendered evidence and checks (E, F)

### Fixture

One new `describe("board timeline manager view")` in
`src/components/kanban/kanbanBoard.browser.test.tsx`, served like the existing
timeline cases (`serveEvidenceFixture` answering `/api/files` and `/api/tasks`,
`?scenario=board-timeline`), with its records built in the block. No new file. Clock
fixed at `2026-11-13T08:10:00Z`, browser timezone UTC (pass `now` to `openFixture`),
`dueTz: "UTC"`. Neutral synthetic titles in each language, three of them long enough
to wrap at 390 px. Times are hours before the clock; due is hours after it.

| # | Status | Group | Start | Attempts (lanes) | Last end | Due | Slips | Hold / lane | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | blocked | still-long | 340 | 1 × 8 min | 340 | +4 | 6 | pr; paused@build, failed | 14 days, one short stage |
| 2 | blocked | still-long | lane 287 | 0 | — | +8 | 4 | postponed (until passed); paused | thin line only |
| 3 | blocked | needs-you | 183 | 4 × 10–25 min | 91 | +32 | 3 | operator; needs_decision@build | |
| 4 | blocked | needs-you | 183 | 5 | 90 | +74 | 2 | operator; needs_decision@baselines | due beyond 1 week |
| 5 | blocked | needs-you | 179 | 6 | 178 | +32 | 2 | external; needs_decision@fix | |
| 6 | assigned | still | 178 | 12 (3) | 40 | +8 | 6 | paused@build | |
| 7 | assigned | still-long | 177 | 14 (2) | 84 | +32 | 4 | paused; one attempt with `suspension.stoppedAt` | «зупинено» |
| 8 | blocked | still | 155 | 23 (2) | 60 | −96 | 2 | postponed (until tomorrow); paused | overdue ≈ 4 d |
| 9 | blocked | needs-you | 155 | 2 | 91 | +8 | 4 | pr; needs_decision@build | |
| 10 | blocked | needs-you | 143 | 3 | 120 | +74 | 2 | operator; paused@build | |
| 11 | blocked | still-long | 119 | 2 | 118 | −92 | 0 | postponed (until tomorrow); paused | overdue ≈ 3.8 d, no slips |
| 12 | blocked | still-long | 118 | 3, one with a start and no end | 117.5 | +8 | 1 | external; paused | end-unknown tick |
| 13 | blocked | still-long | 87 | 4, one never started | 83 | +8 | 4 | worker; paused@fix | start-unknown case |
| 14 | assigned | still-long | 87 | 4 | 83 | +8 | 3 | paused@fix | |
| 15 | blocked | still-long | 84 | 2 | 83 | +4 | 9 | task; paused@review | most slips |
| 16 | blocked | still | 83 | 12 (3) | 40 | +10 | 2 | resource; paused@build | |
| 17 | assigned | working | 40 | 13 (4), fix running | now | +8 | 0 | running@fix | working agent with an observed turn (strip) |
| 18 | blocked | working | 22 | 3, refresh running | now | +8 | 4 | resource; running@refresh | live task in «Очікують» |
| 19 | blocked | still | 19 | 2 | 14.5 | +10 | 0 | task; paused@build | |
| 20 | assigned | still | 18.6 | 9 (2) | 12.5 | +4 | 0 | paused@fix | |
| 21 | assigned | working | 16 | 1 (lane completed) + standalone agent | now | +28 | 0 | — | |
| 22 | blocked | needs-you | 11.5 | 1 × 3 min | 11.5 | +32 | 0 | external; needs_decision@build | |
| 23 | assigned | still | 11 | 7 (2), rework attempt running, its turn ended 12 min ago | 0.2 | +1 | 0 | running@rework | lane in flight without a live agent |
| 24 | assigned | working | 1.1 | 1 running | now | +58 | 0 | running@rework | observed turn (strip) |
| 25 | assigned | working | 0.8 | 1 running | now | +10 | 0 | running@publish | |
| 26 | assigned | working | 0.5 | standalone agent only | now | +32 | 0 | — | |
| 27 | assigned | working | 2 | standalone agent only | now | +32 | 0 | — | |
| 28 | assigned | working | 0.3 | standalone agent only | now | +32 | 0 | — | |

Totals: 28 tasks; 8 working (7 «У роботі», 1 «Очікують»); 6 needs-you; 14 «Стоять»
(6 recent, 8 longer than 3 days); 16 «Очікують»; 2 overdue; slips up to 9. Attempts
spread evenly between the task's start and its last end, each 5–25 min long, unless
the row says otherwise. Working agents are `FileEntry` rows with `proc: "running"`, an
open `lastTurn` and live activity, linked through assignments or attempt
`conversationId`; non-working attempts carry no file, or a file whose turn ended, with
`lastAgentWorkAt` at the attempt's end.

### Frames

Under `$LLV_EVIDENCE_DIR/board-timeline-manager/<width>-<lang>-<theme>-<state>.png`
with one `readings.json`. Widths 390×844, 720×900, 1024×768, 1200×800, 1440×900 (the
named three and one between each pair); en and uk; light and dark.

| State | Widths | Shows |
| --- | --- | --- |
| `board` | all | kanban columns (desktop) or tabs (phone) with their green counts |
| `default` | all | fresh storage: every working task collapsed, groups closed: the manager's summary |
| `expanded`, `expanded-reload` | all | one working task opened, then the same frame after a reload: the open task is kept |
| `groups-open-top`, `-middle`, `-end` | all | tasks collapsed, «Чекають на вас», «Стоять» and its nested line open: all 28 rows, scrolled to start, middle and end |
| `zoom-6h`, `zoom-1w` | all | groups open: clipping, both edge markers, in-window flags |
| `paged` | all | row 1 expanded, its stage's «‹ date» pressed: window paged back, «Зараз ›» shown |
| `seat-top`, `seat-page-end`, `seat-chart-end` | 720, 1024, 1200, 1440 | seat expanded on top at its default height, groups open: page at top; page scrolled to its end; chart scrolled to its last row |

Every frame is looked at by eye; the visual check judges them.

### Assertions in the case

- **A.** 8 task rows with `data-timeline-group="working"` above every group row; group
  rows `needs-you` 6, `still` 14 and nested `still-long` 8; the header's working
  number equals the sum of the rendered green counts of the inbox, assigned and
  blocked columns (desktop `.live[data-count]`, phone `[data-phone-tab-working]`);
  order inside each group is due ascending; opening a group, reloading, and finding
  it open; groups closed on fresh storage.
- **B.** With all groups open, each of the 28 task rows has exactly one
  `[data-timeline-due]` or `[data-timeline-due-edge]`; exactly 2 are overdue and their
  words carry the fixture's lateness in days; slip words appear exactly on the 16 rows
  with slips; the edge direction matches the due instant against the window at 6 h, 1
  day and 1 week.
- **C.** `scrollWidth ≤ clientWidth + 1` on `[data-timeline-scroll]` at every width
  and scale; row 1 has `[data-timeline-clipped]` and a label start «з 30.10 · 14 д»
  (en «since 30/10 · 14d»); segments per row equal its attempts with a known start;
  rows 12 and 13 draw the end-unknown tick and nothing respectively; no duration of 48
  h or more is written in hours; paging moves the first axis tick earlier, and «Зараз
  ›» returns it.
- **D.** At 1440×900 and 1024×768 with the seat expanded: `.board-frame` ≥ 440 px;
  `.kb-page` scrolls; after scrolling the page and the chart to their ends, the last
  row's text ranges lie inside the viewport and below the return strip.
- **E.** The existing timeline `frame()` geometry check (text ranges cut by a scroll
  edge, a pinned bar or the window; control hit tests; 24 px desktop and 44 px phone
  targets), shared within the file; no lane text overlapping another lane text in the
  same row.

### Density, before and after (E)

Measure with the same fixture on identical conditions (seat folded, 1 day, uk and en,
light): the whole `.bt-row` elements in the chart's first screen, the median and
maximum task-row heights, and the head height, at 390, 1024 and 1440.

- After: groups open and tasks collapsed (all 28 tasks listed, as on main).
- Before: the same describe block run once in a scratch export of `origin/main` under
  `LLV_TIMELINE_DENSITY_ONLY=1`, a switch that records these readings and skips every
  assertion about new behaviour.

Both readings go to `$LLV_EVIDENCE_DIR/board-timeline-manager/density-{before,after}.json`.
Acceptance: rows in the first screen after ≥ before, task-row median and maximum
after ≤ before + 0.5 px, head after ≤ before + 0.5 px, at each width. The case also
asserts the critique's production bounds as a guard: desktop task rows ≤ 67 px, phone
≤ 91 px; head ≤ 45, 60 and 95 px.

### Existing tests this changes

- «board timeline hybrid» (same driver): in its `unknown`, `pending`, `waiting` and
  `empty` modes the task without a live agent sits in a closed group, so the case
  stores the three group keys open before those reloads. The `.bt-earlier` step
  asserts paging (first axis tick earlier, «Зараз ›» shown) in place of a smaller
  `scrollLeft`. The long stage's words become «Минуло: 3 д» (en «Elapsed: 3d»). The
  known-work fraction compares durations (`data-start-ms`, `data-end-ms`, or the
  attempt's own times), since clipped pixel widths no longer measure 72 h. The
  `pan-edge` frame is dropped. Everything else stays: task rows keep exactly one
  button, strips keep their count, height and colours.
- «chart follows touch, trackpad, wheel and key scrolling without jumps» (lane
  a6c199d8): group keys open in its stored preference (§11); no assertion changes.
- `KanbanBoard.dom.test.tsx` and `MobileKanban.dom.test.tsx` timeline tests: their
  tasks are working or absent, so they pass as written; run them.

### Checks (one command at a time through `scripts/gate-slot.sh`)

Each runs with a private `HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR` under
the stage scratch, `LLV_VIEWER_CONTROL_URL` on a closed local port, a short Chrome
`TMPDIR`, and `PLAYWRIGHT_BROWSERS_PATH` at the shared browser cache:

- `bun test` by path: `src/components/kanban/kanbanModel.test.ts`,
  `src/lib/board/taskTimelineView.test.ts`, `src/components/kanban/boardTimelineStore.test.ts`,
  `src/components/kanban/boardScrollers.test.ts`, `src/lib/i18n/i18n.test.ts`,
  `src/components/kanban/KanbanBoard.dom.test.tsx`, `src/components/mobile/MobileKanban.dom.test.tsx`,
  `src/lib/board/taskTimeline.test.ts`;
- the driver with `LLV_KANBAN_BROWSER_TEST=1` and `CHROME_BIN`, filtered to the three
  timeline cases;
- `bunx tsc --noEmit`, eslint on the changed files, and the privacy check on the
  branch.

Close every browser the run opens.

## 17. Validation against the requirement

- «What is late, when does it finish as of now»: every row carries its board due date
  as a flag and in words, red with the lateness when overdue, with the number of
  moves; dates outside the window are announced at its edge (decision 2, first step).
- «Long tasks take too much room»: the canvas is one window; a 14-day task with one
  8-minute stage reads as a clipped thin line with «з 30.10 · 14 д», its stage a
  block where it ran; long-quiet tasks fold into one line (decision 1).
- «What is in work»: the top holds the tasks with a live agent by the kanban's own
  rule, its number matches the kanban's green numbers, and the rest sit in two
  closed groups (decision 3).
- «Seat panel»: the chart keeps 440 px and the page scrolls under the panel as the
  kanban does (decision 4).
- 31.10: no field is removed (§9), labels do not gain lines, and the density readings
  must show no loss at 390, 1024 and 1440.

## 18. Changes after the visual check

- **Earlier stages fold.** An expanded task draws a row for each stage that ran in
  the window or is live. Stages that ended before the window's left edge are one line
  under the task, «ще N етапів до 12 лист. 08:42» / «N more stages until 12 Nov, 08:42»,
  closed until its own chevron opens it; the open state is kept per task in the same
  record as the other folds (`earlier:<task id>`). Opened, the line lists them with
  their «‹ date time» paging controls. The line depends on the window, so its count
  changes with the scale. With the expanded default, a first screen held fewer than
  eight working tasks at 1024 and 390 on the fixture; §19 replaces that default.
- **Overdue in the header and on a closed group.** The header carries
  «прострочено: N · до 4 д» / «overdue: N · up to 4d» beside the three counts, and a
  closed group row carries the same words for its own rows, so the count and the
  greatest lateness are on the first screen whatever is folded.
- **The return control has a row.** While the window is paged back the axis grows a
  row (24 px, 44 px on the phone) for «Зараз 08:10 ›»; no time label gives way to it.
- **One name for the waiting group in English.** The header reads «6 waiting for you»,
  as the group row does; «Needs you» stays the top bar button's.

## 19. Working tasks are collapsed by default (2026-11-14)

Decision of the operator, replacing the choice of 2026-10-27 and the earlier
«keep expanded» resolution: every task on the chart, working or not, is one collapsed
row until the person opens it, and opening or closing it is remembered.

- Fresh storage: each working task is a single row that names its live stage and
  state, as the collapsed row already does. `timelineExpanded` reads only the stored
  record, `expanded[taskId] === true`.
- A stored choice is kept whichever way it points. A record that holds an explicit
  `false` or `true` for a task reads the same as before; a task with no entry, which
  used to open because it was working, is now closed. The record, its key and its
  parser are unchanged.
- Nothing else moves: the order, the header counts, the due flags, the «Стоять» group
  and the scroll behaviour are as in §3 to §18.
- First screen on the fixture (28 tasks, 8 with a live agent), fresh storage, seat
  folded: expanded by default showed 3 of the 8 working tasks at 1440, 2 at 1024 and 1
  at 390, with both groups below the fold; collapsed, all 8 working tasks and both
  groups fit at 1440 and 1024 and five working tasks at 390. The kanban browser case
  asserts these floors, then opens one task, reloads and checks that it is still open
  (`default`, `expanded` and `expanded-reload` frames).
