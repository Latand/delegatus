# Phone kanban: a convenient board on mobile (#2072)

Design only. The operator reviews this note and its rendered mockups before any
build starts. Every file:line below is on `origin/main` at `fcf9c0110` (the
merge of #2068) unless it says otherwise; the round-2 pipeline sections cite
`origin/main` at `3322d7bb8`.

**Round 2 (2026-09-23)** revises the pipelines after the operator's verdict and
the critique in `docs/design/phone-kanban-critique.md`. §3.4, §3.5 and the new
§3.13 replace round 1's pipeline presentation, and §10 maps every critique
finding to what changed. The round-2 mockups are in
`/var/tmp/phone-kanban/mockups-r2/` (§6).

## 0. The requirement

Source: issue #2072, filed 2026-09-23 from the operator's phone screenshots and
request. Verbatim:

> ## Outcome
>
> On a phone the board is a convenient kanban: the operator sees where every
> piece of work stands (by status column or equivalent), moves between columns
> and into a task, a pipeline or a conversation with one hand, and acts from
> there. It is one coherent phone surface, combined with what the phone board
> shows today (orchestrator seat, "Needs you", pipelines, working agents, recent
> conversations) rather than a second screen beside it. The operator asked to
> rethink what is wrong with the current phone board, not only to add columns.

> ## Requirements
>
> - Research first: inventory the current phone surfaces and their data
>   sources, the desktop status-column board (#1695, its phone rule "one tabbed
>   column below 768 px"), the messaging-style conversation work (#1680) and the
>   skeleton/transition work (#2071); explain each defect above with file:line.
> - Design the phone kanban: columns (or tabs) matching the desktop task
>   statuses, task cards with their pipelines, running agents and "needs you"
>   state; where the orchestrator, the composer and recent conversations live;
>   navigation and back behaviour; one-hand reach; empty and loading states
>   consistent with #2071.
> - Present the design to the operator with rendered phone mockups (390 px, en
>   and uk) before the build starts.

The stage brief adds a tall 430 px phone and iOS Safari with the bottom URL
bar. The mockups cover both.

The operator's verdict on round 1, 2026-09-23, recorded in the round-2 stage's
specification (paraphrased in English): overall the design is fine, but the
pipelines look bad, and pipelines must be very convenient on the phone. The
desktop board already has something close to right for how a pipeline looks
(the pipeline group header, the stage pills and stage chain, the Stages view,
the PR and issue chips from #2059), and the phone should build on that. The
example given: on the task screen each pipeline was a card with a title, a
status pill, two wide equal stage bars and a meta line, and the needs-decision
block above it repeated the same pipeline with "Open pipeline ›".

History that this reverses: on 2026-09-14, asked whether the #1695 kanban
should change the phone, the operator chose "Телефон не трогать вообще" (leave
the phone alone), so below 640 px the phone kept mobile-v2 (#1439). #2072 is the
operator now asking for the phone kanban.

## 1. The design in one screen

```
┌ live-log-viewer-next ⌄          ⚠ 7   🔍   ⋯ ┐ 52  bar (unchanged)
│ Inbox    │ Assigned  │ Blocked  │ Done      │ 52  column tabs: label, count,
│ 9  ⚠5    │ 51 ●5 ⚠2  │ 3        │ 578       │     ●working ⚠needs-you dots
├──────────────────────────────────────────────┤
│▌Mobile data: stop repeated   needs a decision│     needs-you cards pin first
│▌full-board downloads and hidden-tab traffic  │     (edge + badge)
│▌ (!) Implement → ○ Review             no PR  │     the desktop's stage chain
│▌ Implement failed · 1 finding · 41m  +1 paused│     the reason, amber
│ Restore /favicon.ico with the Delegatus      │
│  ✓ Implement → ◉ Review · 4m          #2070  │     running: one line, no agents line
│ Redesign attachment upload for large files   │
│  ✓3 → ● Build ui → ○ Review ui +3 · 6m #2201 │     long chain folds, current never cut
│ …                                            │     ← swipe → pages columns
├──────────────────────────────────────────────┤
│ 🤖 Tell the orchestrator…        ● 5    🎤   │ 64  orchestrator dock: its state,
│    finished the turn · 5m                    │     the composer door, working
└──────────────────────────────────────────────┘
```

**Decisions for the operator to approve (§9 lists them with the alternatives):**

1. **Four status columns replace today's sections.** The phone board is the
   desktop's kanban (Inbox · Assigned · Blocked · Done), one column at a time,
   with a tab strip and a horizontal swipe. "Needs you" becomes a state of a
   card: those cards pin to the top of their column, the tabs carry a ⚠ dot,
   and the bar's ⚠ badge stays the one queue across columns.
2. **The orchestrator moves into the bottom dock.** Its state line and "Tell the
   orchestrator…" become one unit in thumb reach, with the working-agents
   count beside the mic. The top orchestrator card goes away.
3. **Recent and All conversations leave the board.** A conversation lives on
   its task's card (and on its screen). Conversations with no task sit in Inbox
   under "Not on a task", the way the desktop draws them. The full history moves
   to ⋯ › All conversations. The counts that jumped disappear with them.
4. **One more round from the phone (round 2).** A spent review budget is
   answered on the phone with a one-round grant beside Close lane.

## 2. Research

### 2.1 What the phone shows today, and where each part reads from

The phone is `ProjectDashboard`'s mobile branch (`src/components/ProjectDashboard.tsx:2179-2352`):
`MobileShell` around `MobileBoard` while no conversation is on top of the stack
(`mobileBoardLeaf`, `ProjectDashboard.tsx:1819`).

| Surface | Component | Data source |
| --- | --- | --- |
| Bar: project switcher, ⚠ badge, search, ⋯ | `MobileShell` (`src/components/mobile/MobileShell.tsx:159`) | badge = `mobileBoardModel.attentionCount` |
| Orchestrator card | `MobileSeatCard` (`src/components/mobile/MobileSeatCard.tsx:115`) in the `seat` slot | `useOrchestratorSeat` (`ProjectDashboard.tsx:422`), seat transcript from `files` |
| Needs you | `MobileBoard.tsx:483-495` | conversations whose `mobileRowState` is stalled/limit/waiting, ordered by `buildAttentionQueue`; pipelines in `needs_decision`/`needs_review` (`needsDecisionPipelineRows`, `src/components/mobile/mobileBoardModel.ts:313`) |
| "N pipelines" row | `PipelinesRow` (`MobileBoard.tsx:299`) | `activePipelines` (`ProjectDashboard.tsx:1658`), counted in `buildMobileBoard` (`mobileBoardModel.ts:435-451`) |
| Working | `MobileBoard.tsx:504-507` | conversations with an open turn (`turnIsRunning`, `mobileBoardModel.ts:162`) |
| Recent · N | `MobileBoard.tsx:516-519`, three rows | every other board conversation; N = `recentRows.length` (`mobileBoardModel.ts:450`) |
| All conversations | `MobileBoard.tsx:520-558` | the stored catalog, paged (`useMobileInlineCatalog`, `ProjectDashboard.tsx:452`) |
| "Tell the orchestrator…" | `MobileBoardDock` (`MobileBoard.tsx:400`) | a button that opens the seat conversation (`ProjectDashboard.tsx:2235`) |
| Tasks | `TaskSheet` (`src/components/tasks/TaskSheet.tsx:24`, mounted at `ProjectDashboard.tsx:2423`) | reachable only from ⋯ › Tasks; no presence on the board |
| Pipelines, one pipeline | `MobilePipelinesScreen`, `MobilePipelineScreen` (PR/issue chips at `MobilePipelineScreen.tsx:518`) | `activePipelines` |
| Conversation | `MobileFocusView` + `LogFeed` | transcript stream |

Everything except the seat comes from ONE payload: `useFiles` polling
`/api/files?view=summary` (`src/hooks/useFiles.ts:83`), which carries the scan
window of conversations (`files`), `pipelines`, `tasks`, `flows` and (since
#2068) `workLinks`.

### 2.2 The desktop board and its phone rule (#1695)

- The desktop board is `buildKanbanModel` (`src/components/kanban/kanbanModel.ts:319`)
  over the same task bands the scheme drew, four columns in
  `KANBAN_STATUSES` order (`kanbanModel.ts:33`), cards ordered by the latest
  agent work (`compareCards`, `kanbanModel.ts:289`). Every stored task is a card
  in one column, an off-board task, a hidden group, or a seat task.
- By the board's own width: one tabbed column below 768 px
  (`KanbanBoard.tsx:80`, the tab list at `KanbanBoard.tsx:2375`), a snap
  scroller at 768–1199 px, shelves above. The phone layout starts below 640 px
  wide or 600 px tall (`src/hooks/useIsMobile.ts:10`) and never reaches that
  tabbed column.
- Bands with no task (a pipeline or a conversation nobody filed) are drawn in
  Inbox under "Not on a task · n" (`KanbanBoard.tsx:2575-2658`).
- The inputs already exist on the phone: `pipelineLayout` is computed ungated
  (`ProjectDashboard.tsx:1702`), and the desktop's bands come from a private
  `useBands` (`KanbanBoard.tsx:308`). The phone can build the SAME model by
  exporting that hook.

### 2.3 The four defects, explained

The operator's two board screenshots were taken one minute apart, at 12:23 and
12:24 local time, UTC+3 (09:23 and 09:24 UTC).

**One timeline explains the first three.** The chips lane's review stage
failed at 08:34:23Z and parked the pipeline on `needs_decision`. The 12:24
frame shows it under Needs you with the age "49m 34s", and 08:34:23 + 49:34 is
**09:23:57Z**, so that is when the frame was drawn.

| UTC | Event (read through `list_pipelines`, `deployment_status`, the state directory's mtimes) |
| --- | --- |
| 08:57 | last deploy finishes; no deploy or restart near the screenshots |
| 09:19:17 | last persisted full projection (`files-response-cache.json`): the chips lane is `needs_decision` |
| 09:20–09:21 | three lanes start (favicon, skeletons, review round 2): the 12:23 frame's "started 2m/3m ago" |
| 09:20:51 | the chips lane is **closed** (and hidden) |
| 09:23 | frame 1: Working 3, no chips lane in Needs you, Pipelines 17 (4 active · 12 done), Recent 184 |
| 09:23:57 | frame 2: Needs you = the closed chips lane, Working 0, Pipelines 16 (2 active · 1 needs you · 12 done), Recent 1334 |

Frame 2 is the board **as it stood before 09:20:51**, drawn after frame 1 had
already drawn the board as of 09:23. Replaying `buildMobileBoard` over the
09:19:17 projection at 09:23:57 gives frame 2's content: Needs you = the chips
lane, Working = the seat alone (which the board keeps out of the list, so
"Working 0"), pipelines = 1 needs you · 12 done. The replay passed the
payload's pipelines without the dashboard's `pipelinesForProject` step and
counts 15 pipelines with 1 active, where the frame shows 16 with 2. The board
went back in time by several minutes, and every symptom in frame 2 is what
data from before 09:20 looks like. (The replay was run during this research;
the 09:43 restart has since replaced that persisted projection, so it cannot
be repeated from the state directory.)

How the client can go back in time (all on `origin/main`):

1. **Answers are ordered by the order they were requested, never by the age of
   their data.** `const generation = ++requestedGeneration`
   (`src/hooks/useFiles.ts:518`) and the only guard is
   `generation < appliedGeneration` (`useFiles.ts:546`, `:584`). A newer
   request that returns older data wins.
2. **The server hands out older data on purpose, and labels it with the current
   generation.** While a projection is being rebuilt, a request that carries
   `If-None-Match` gets the previous cached projection with
   `x-llv-files-projection-cache: stale` (`src/app/api/files/route.ts:382-385`),
   and so does one whose rebuild misses its budget (`route.ts:388-391`). Every
   answer, stale ones included, is then stamped with the scan's *current*
   generation (`applyScanHeaders`, `route.ts:495`). The client flags the stale
   answer (`projectionIncomplete`, `useFiles.ts:537`) and paints it anyway
   (`patchFilesData`, `useFiles.ts:595`).
3. **Each request URL keeps its own last representation.** The board polls the
   global URL; opening a conversation from "All conversations", a search result
   or a link pins a second URL (`openCatalogFile`, `src/components/Viewer.tsx:517-521`;
   `filesRequestPin`, `Viewer.tsx:74`, used at `Viewer.tsx:142`).
   Switching between them republishes that URL's last certified
   representation (`useFiles.ts:387`), or a stand-in (`useFiles.ts:354`), and a
   304 restores that URL's own stored data (`useFiles.ts:549`). A scope the
   phone left minutes ago comes back minutes old.

The screenshots cannot say which of 2 or 3 fired at 09:23:57, because the
phone logs no generation per paint. They do prove the regression, and nothing
in the client refuses it. The fix (§3.11) covers both paths, and it records the
generation each paint was built from, so the next regression shows up in a test
and never has to be reconstructed from a timestamp.

- **Defect A, "Working 0 · Nothing is running" while three agents ran.** The
  three lanes started at 09:20–09:21; in the replayed 09:19 data none of them
  is working. Working is computed correctly from what it was given (`mobileBoardModel.ts:162`,
  `MobileBoard.tsx:507`).
- **Defect B, a closed pipeline under Needs you.** Same cause: the old data
  still had the lane on `needs_decision` (`needsDecisionPipelineRows`,
  `mobileBoardModel.ts:313`). The filter that drops closed lanes
  (`boardPipelines`, `mobileBoardModel.ts:277`) never saw the close.
- **Defect C, counts jump (Recent 184 → 1334, Pipelines 17 → 16).** Pipelines
  moved with the regression. Recent is a count of the wrong thing in the first
  place: it is the number of transcripts the scan window happened to carry for
  the project (`recentTotal: recentRows.length`, `mobileBoardModel.ts:450`).
  That window is 80 per project plus every hosted or open-turn transcript
  (`DEFAULT_SCHEME_CARDS_PER_PROJECT`, `src/lib/scanner/schemeWindow.ts:7`;
  `cappedEntries` and `isLiveEntry`, `src/lib/scanner/discover.ts:323`, `:287`)
  plus pin overlays. The same project's Recent reads 516 in the 09:19
  projection, 184 in frame 1 and 1334 in frame 2. It moves when the window
  moves, which says nothing about the operator's work.
- **Defect D, the conversation's "down" button covers text.** The button is
  `absolute bottom-2` centred over the feed's scroller (`pillPos`,
  `src/components/LogFeed.tsx:1292`; the button at `LogFeed.tsx:1331-1337`). It
  appears only while the reader is away from the tail, which is exactly when a
  full-width line of text sits under it, and nothing reserves room for it. The
  desktop live-tail pill (`LogFeed.tsx:1321-1327`) is the same overlay with
  `pointer-events-none`.

### 2.4 The shape of the data

Read on 2026-09-23 through `list_tasks`, `list_pipelines` and `agent_activity`,
and from the task records in the 09:19 projection. "Drawn" applies the board's
own rule: a task is off the board only when its group is hidden, or when it is
marked hidden and holds nothing.

| Tasks | Inbox | Assigned | Blocked | Done |
| --- | --- | --- | --- | --- |
| this repository, stored | 54 | 57 | 14 | 659 |
| this repository, drawn | 9 | 51 | 3 | 578 |
| project B (smaller), drawn | 1 | 1 | 8 | 60 |
| project C (assignment-heavy), drawn | 0 | 73 | 1 | 12 |

| This repository, live at 09:32Z | |
| --- | --- |
| agents with a turn running | 3 (all pipeline stages) |
| orchestrator | waiting, 5 min |
| stalled conversations (no pipeline) | 4 |
| open pipelines | 5: 3 running, 1 paused, 1 `needs_decision` |
| things that need the operator | 1 pipeline decision + 4 stalled conversations |
| project B at the same time | nothing running, no open pipeline |

| Per task (this repository) | median | p90 | max |
| --- | --- | --- | --- |
| pipelines, among the 52 newest open tasks (18 carry any) | 2 | 9 | 13 |
| conversations (assignments), all tasks | 1 | 5 | 43 |
| first-line title length of open tasks, characters | 99 | 687 | 1199 |

What the numbers decide:

- **Done is huge and Assigned is where the work is.** 578 drawn Done cards
  cannot be one scroll. Done shows the newest 20 and loads more on demand; its
  tab shows the full count. The board opens on Assigned the first time.
- **Titles are long.** Half the open tasks carry a first line of 99 characters
  or more, one in ten is a paragraph. Cards clamp the title at two lines; the
  task screen shows it whole.
- **A card carries one pipeline at a glance.** Most tasks have one or two, a
  few have ten. The card shows the newest one that is not finished (else the
  newest), with "+n" when there are more; the task screen lists all.
- **Needs you is a handful, working is a handful.** Both fit as marks on cards
  and dots on tabs. Neither needs its own section.

### 2.5 Has this been solved before?

`search_transcripts`, project-scoped then unscoped, for "phone kanban columns
mobile board tasks", "Nothing is running working zero phone board stale",
"канбан на телефоні колонки" and "files-response-cache persisted projection
stale served": the only hits are #1695's "leave the phone alone" decision and
its prototype, which points the phone at mobile-v2. No earlier phone kanban
design exists, and no earlier diagnosis of the board regression.

### 2.6 What is wrong with the phone board (the rethink)

1. **It lists conversations, and the operator manages tasks.** 51 assigned
   tasks have no phone presence. A pipeline's stage shows up as a bare
   conversation row ("PR and issue chips on pipelines and task cards — revi…")
   with no link to its task.
2. **One piece of work is split over four sections.** A task's pipeline
   decision sits in Needs you, its builder in Working, its previous reviewer in
   Recent, and its pipeline inside "17 pipelines". The operator assembles the
   task in their head.
3. **Half the screen is history.** Recent and All conversations put a
   transcript archive on the work surface.
4. **Its counts measure the scan window.** Recent and Pipelines move when the
   payload changes shape (§2.3, defect C).
5. **The orchestrator takes two places.** A card at the top (about 120 px, out
   of thumb reach) and a dock at the bottom (the part the thumb actually uses).
6. **Nothing keeps the board moving forward in time** (§2.3).

## 3. Design

### 3.1 Information architecture

```
Board (screen)                                       bar: [project ⌄] [⚠ n] [🔍] [⋯]
 ├─ column tabs: Inbox · Assigned · Blocked · Done   (tap, or swipe the column area)
 │   └─ task card ──────────────▸ Task (screen)
 │                                   ├─ needs-you block ─▸ Conversation (a question or a plan only)
 │                                   ├─ pipeline block: Retry / Skip / One more round in place
 │                                   │    ├─ header ─────▸ Pipeline (screen: the Stages view)
 │                                   │    └─ stage pill ─▸ stage conversation
 │                                   ├─ agent row ───────▸ Conversation (screen)
 │                                   └─ bottom bar: [Assigned ▾] sheet · [+ Agent] · receipts with Undo
 │   └─ Inbox › Not on a task: a conversation ─▸ Conversation; a pipeline ─▸ Pipeline
 │   └─ long-press a card ───────▸ Card sheet: Move to… · Hide from board · Open first agent
 └─ dock: Tell the orchestrator… ─▸ orchestrator conversation, keyboard open
          ● n working ───────────▸ Working sheet (the switcher's rows, working only)
          🎤 ────────────────────▸ orchestrator conversation, dictation started
⋯ board menu: New task · New agent · New pipeline · Pipelines · All conversations ·
              Hidden tasks · Orchestrator seat · Accounts & limits · Host details · …
⚠ n: the Needs you sheet (unchanged: conversations and pipelines, Next ›), each row now names its task
```

Where each part of today's board goes:

| Today | In the phone kanban |
| --- | --- |
| Orchestrator card | the dock's state line (§3.6); the seat sheet moves to ⋯ › Orchestrator seat and the orchestrator conversation's ⋯ |
| Needs you section | cards that need you pin to the top of their column with the edge and badge; a ⚠ dot on the tab; the bar's ⚠ badge and sheet unchanged |
| "N pipelines" row | each pipeline on its task's card and screen; a pipeline with no task in Inbox › Not on a task; the full list at ⋯ › Pipelines |
| Working section | "● n working" on each card; dots on the tabs; "● n" in the dock opens the Working sheet |
| Recent (3) · All conversations | a conversation on its task's card and screen; Inbox › Not on a task; ⋯ › All conversations (a screen) |
| "Tell the orchestrator…" | the dock, same door |

### 3.2 Columns and the desktop statuses

The columns are the stored statuses, 1:1 with the desktop, in the desktop's
order and with its labels (`kanban.status.*`). Three shapes were weighed:

| | A. Paged columns + tabs (chosen) | B. One list grouped by status | C. Today's sections + a Tasks section |
| --- | --- | --- | --- |
| "moves between columns" | a swipe or a tab tap | scrolling past sections | no columns |
| one hand | swipe anywhere; tabs are a second path | scroll only | as today |
| Done with 578 cards | its own page, windowed | collapsed section at the end | not shown |
| matches the desktop | the same model and columns, the desktop's own < 768 px form | same model, different form | a second model |
| cost | a scroll-snap pager, native CSS | cheapest | adds a fifth section to a board already too long |

A is the kanban the requirement names and the form the desktop already uses
when it is narrow. B is the fallback if the operator prefers one scroll.

Order inside a column: everything that needs the operator first, oldest ask
first (the attention queue's order, which ⚠ and Next › already walk), task
cards and Not on a task rows alike, so the tab's ⚠n counts exactly the first n
items; then the desktop's order (latest agent work first). The pin is the one deliberate
difference from the desktop: the phone shows five or six cards at a time, and a
decision must not sit under 50 assigned tasks. Seat tasks stay out of the
columns, as on the desktop (the dock owns the seat). Hidden groups leave the
columns and are listed at ⋯ › Hidden tasks with Show.

Column specifics:

- **Inbox** ends with "Not on a task · n" (the desktop's `unlinkedShown`): a
  pipeline or conversation card with no task; a tap opens it directly. A
  pipeline there is the same card as a task's (§3.4), titled by the pipeline.
  A conversation row is titled by its first prompt line (the rule a pipeline
  card already follows), says its state once as the badge, and carries engine,
  model, "not on a task" and age in its meta line.
- **Done** shows the newest 20 cards by completion, then "Show 20 more". The
  tab count is the full count.

### 3.3 Board layout and viewport budget

iOS Safari with the bottom URL bar leaves about 667 px of page at 390 × 844
(47 px status bar, 130 px of Safari chrome) and 735 px at 430 × 932.

| Region | 390 × 844 | 430 × 932 |
| --- | --- | --- |
| bar (unchanged) | 52 | 52 |
| column tabs (sticky) | 52 | 52 |
| cards | 499 (5–6 cards) | 567 (6–7 cards) |
| dock | 64 | 64 |

Today the same 667 px hold the orchestrator card, section headers and a dock,
and the first task never appears.

Tabs: four equal segments (≈ 91 px at 390), each a 44 px target with two
lines: the label (12 px / 600) and a meta line (11 px, tabular): the count, a
green "●n" when cards in it have agents working, an amber "⚠n" when cards need
the operator. The active tab is the card surface with a 2 px accent underline.
The Ukrainian labels ("Заблоковані" is the longest, 11 characters) fit a
segment whole; the gate in §5 refuses a truncated label.

The column area is a horizontal scroll-snap pager (`scroll-snap-type: x
mandatory`, `overscroll-behavior-x: contain`), one column per page, each page
scrolling vertically on its own. The tabs follow the pager and the pager
follows the tabs. Each column keeps its scroll offset.

### 3.4 Task card

```
┌───────────────────────────────────────────────────┐
│▌<title, 13 px / 600, two lines at most>  [badge]  │ badge only when it needs the operator
│▌ (!) Implement → ○ Review                  no PR  │ the pipeline's stage chain · its PR, passive
│▌ Implement failed · 1 finding · 41m     +1 paused │ needs you: the reason, amber; other pipelines
└───────────────────────────────────────────────────┘
┌───────────────────────────────────────────────────┐
│ Restore /favicon.ico with the Delegatus emblem    │
│  ✓ Implement → ◉ Review · 4m              #2070   │ running: chain · age with a unit · PR
└───────────────────────────────────────────────────┘
┌───────────────────────────────────────────────────┐
│ PR and issue chips on pipelines and task cards    │
│  ✓ completed · 20m                        #2068   │ finished: one muted line, no chain
└───────────────────────────────────────────────────┘
```

- **Left edge (3 px):** amber when the card needs the operator, red when a
  member stalled; otherwise the task's colour label when it has one; otherwise
  none. One coloured edge at most (design system rule 7).
- **Title:** two lines, then an ellipsis. A placeholder title reads in muted
  italics, as on the desktop.
- **Badge (needs you only):** the row's reason in the existing words: "a
  question", "plan approval", "needs a decision", "needs review", "stalled",
  "limit". For a pipeline it is the pipeline's state word
  (`pipelineState.*`, the desktop chip's words).
- **Pipeline line (when the task has pipelines):** the pipeline block at card
  density (§3.13): the stage chain, then the age with a unit ("4m", "1h 5m"),
  then the #2059 link on the right as passive text (`pr-issue-chips.md` §6.4: a
  link cannot nest in the card's button). The card shows the pipeline that
  needs the operator if one does, else the newest unfinished one; "+n running",
  "+n paused" name the others.
- **Reason line (needs you only):** what the pipeline needs, in warning ink:
  "Implement failed · 1 finding · 41m" for a decision, "head 9b2e7d4c
  unreviewed · no rounds left · 12m" for a spent review budget (the #1938
  review-heads line, shortened). The card draws one status hue: the chain's
  parked pill, the badge, the edge and the reason are all amber.
- **Finished:** when every pipeline of the task is completed, one muted line
  "✓ completed · 20m" with the merged PR in muted text; no chain, no success or
  accent colour. The card's long-press sheet then lists "Move to Done" first.
- **Agents line:** only for work the pipeline line does not already say: a
  task with no pipeline ("2 working · 5 agents · 12m", "no agents yet"), or
  working agents that are not stages of the shown pipeline. A card whose
  working agents are all its pipeline's stages draws none.
- The whole card is one button (the task screen). A long-press opens the card
  sheet (§3.8). Measured on the round-2 frames at 390 px: 65 px for a running
  pipeline with a one-line title, 82 px with a two-line title, 103 px for a
  needs-you card with a two-line title.

### 3.5 Task screen

Pushed from a card. The bar reads ‹, the task's context on one line
("Assigned · 3 agents · 2 pipelines"), and ⋯ (Rename, Colour, Details, Attach
PR or issue, Hide from board, Copy link). The body owns the title; once it
scrolls out of view the bar takes it.

Body, one scroll:

1. **Title**, whole (15 px / 600). A tap edits it in place
   (`PATCH /api/tasks/:id` with `expectedRevision`, as the desktop's
   `CardInlineText` does).
2. **Pipelines**: one block per pipeline at task density (§3.13), the one that
   needs the operator first, then running, provisioning and paused, newest
   first. A decision is answered inside its block. Completed pipelines fold
   behind one dashed row "✓ 3 completed · #2188 · #2170 · #2150 ⌄".
3. **Needs you** only for what has no block on this screen: a question or a
   plan approval from a conversation, with "Answer ›".
4. **Links**: a row of `WorkLinkChip`s only for links attached by hand, which
   no pipeline owns. Each pipeline's links live in its block.
5. **Description**, one line with ›; a tap opens it whole and editable.
6. **Agents · n**: the members as today's conversation rows (working first),
   which keep their swipe actions here because this screen has no pager.
7. **Details** and **Earlier attempts**: collapsed rows.

Bottom bar, in thumb reach: **[Assigned ▾]**, the desktop's status pill, and
**[+ Agent]**. A tap on the pill opens the four statuses as a sheet; a choice
moves the task through the desktop's optimistic, revision-guarded mutation
(`useTaskMutations`), shows a receipt in flow with Undo for 4 s, and on a
refusal moves it back and says why (mobile-v2 rule 9: no confirmation prompts,
receipts carry the inverse). Nothing in the bottom bar changes the status on
one tap.

Measured on `task-390-en`: the parked pipeline's whole block, answer buttons
included, is 238 px (round 1 spent 231 px on a needs block and a row that
could not answer); Retry stage is 165 × 44 px at y = 301 of the 667 px page
(318 in uk); both blocks, the description row and the Agents header are inside
the first 603 px above the bottom bar.

### 3.6 Orchestrator and composer

The dock is one panel at the page's bottom edge, 64 px with its padding:

```
│ [🤖]  Tell the orchestrator…                 [● 3]  [🎤] │
│       finished the turn · 5m                             │
```

- **Avatar and two lines (one target):** the placeholder in body text, and
  under it the seat's state phrase and its now-fragment (the same reading
  `MobileSeatCard` renders today, from the one seat read the board already
  holds). The avatar ring carries the state tone. A tap opens the orchestrator
  conversation with the keyboard up, as the dock does today.
- **● n (44 × 44):** agents working in this project, the board's own total. A
  tap opens the Working sheet: the switcher sheet's rows filtered to working,
  each opening its conversation. Hidden at 0.
- **Mic (44 × 44):** opens the orchestrator conversation and starts dictation.
- **No seat:** "Create an orchestrator ›" in accent, no mic, no count; a tap
  opens the create draft, as today.
- The seat sheet (status, context, mandate, Rotate) moves to ⋯ › Orchestrator
  seat and stays in the orchestrator conversation's ⋯.

The dock stays a door into the orchestrator's conversation and never sends
from the board, as mobile-v2 designed this footer (README §4.1, §7 Q2; the
comment at `MobileBoard.tsx:390-399`). One composer instance per conversation
keeps drafts, voice and attachments in one place.

### 3.7 Navigation and back

The mobile-v2 stack contract (README §3.3) is unchanged and gains one screen:
Board → **Task** → Pipeline → Conversation, or Board → Task → Conversation, or
Board → Conversation for a card in Not on a task.

- ‹ and the iOS edge swipe pop one screen. Back from a task lands on the board
  at the same column and the same scroll offset.
- Switching columns creates no history entry. The active column and each
  column's offset are kept per project for the session; a fresh load opens on
  the last column used, or Assigned the first time.
- Sheets (card sheet, Working, Needs you, ⋯) open over the current screen and
  never create history.

### 3.8 Gestures and one-hand reach

In the page's bottom 40 % sit the dock (orchestrator, working count, mic), the
lower cards and the task screen's bottom bar ([Assigned ▾], [+ Agent]). The
top holds the bar and the tabs. Every top control has a one-hand path: the
swipe for columns, the pinned card for a decision. A decision's buttons sit in
the upper middle of the task screen (y ≈ 300 of 667 at 390 px), a stretch for
one thumb at 430; repeating them in the bottom bar would bring them into reach
at the price of drawing the pipeline twice, so they stay in the block and the
⚠ sheet's Next › stays the one-handed path across decisions.

| Gesture | Where | Effect |
| --- | --- | --- |
| horizontal swipe | column area | previous / next column (snap); rubber-band at the ends |
| tap | card | push the task screen |
| long-press (500 ms) | card | card sheet: Move to Inbox / Assigned / Blocked / Done, Hide from board, Open first agent |
| tap | tab | jump to that column |
| tap | dock | orchestrator conversation, keyboard up |
| edge swipe / ‹ | any pushed screen | pop |

Today's left swipe on board rows (`MobileSwipeRow`) would fight the column
pager, so on the board its actions move to the long-press sheet. Rows on the
task screen keep the swipe.

### 3.9 Loading, empty and error states (with #2071)

#2071 owns the mechanism: the cached-first store, the skeleton primitives, the
reconnecting state, the motion. Its note was not published when this was
written (lane `bcda9e6d` was still in its design stage). This section specifies
only the phone kanban's shapes and follows the rules #2071 states: skeletons
shaped like what replaces them, the real project name in the header, cached
content first, no layout shift, reduced motion honoured.

- **Cached board:** the last board of the project paints at once, real cards
  and real counts, with the quiet updating line #2071 defines. This is the
  common "loading" state.
- **Cold start, nothing cached:** the bar with the known project name, the tab
  strip with its real labels and dimmed count placeholders, card skeletons
  filling the column in the card's own anatomy (two title bars, a row of pill
  shapes, a link bar), and the dock with the avatar, a dimmed state line and
  placeholders where "● n" and the mic will be, so neither pops in later. The
  pulse stops under `prefers-reduced-motion`.
- **Empty column:** the desktop's own empty copy (`kanban.empty.<status>.title`
  and `.body`, en and uk already exist), centred in the column, plus one action
  where there is a next step: Inbox gets "+ New task", Assigned gets "Tell the
  orchestrator". Under it, one 44 px row opens the nearest column with work
  ("Assigned · 51 tasks · 5 working ›"). The other tabs keep their counts, so
  the operator sees where the work is.
- **Empty project:** Inbox's empty state, with the dock inviting the first
  message.
- **Error:** the catalog failure notice (`CatalogFailureNotice`) inside the
  column area; the tabs and the dock keep the cached board.

### 3.10 Recent and All conversations

Recent leaves the board. A conversation lives on its task (card and screen);
one with no task sits in Inbox › Not on a task, exactly as the desktop draws it.
All conversations becomes a screen at ⋯ › All conversations: the existing
catalog list (`MobileInlineCatalog`) with its paging, newest first. The bar's
search stays the way to find any message.

### 3.11 Defect fixes

- **A, B, C: the board only moves forward.**
  1. The server stamps every projection with the scan generation it was built
     from, and sends that stamp with the body, a stale one included. Today
     `applyScanHeaders` stamps the live scan's generation (`route.ts:495`).
  2. `useFiles` refuses to paint a representation built from an older
     generation than the one on screen, in any scope. A stale answer only
     schedules the next revalidation. On a scope switch the newer rows stay,
     and the pinned scope adds its pin rows on top of them.
  3. Each paint records its built generation, and a test drives the 09:19 →
     09:23 → 09:19 sequence and asserts the board keeps Working 3 and no closed
     lane (§5).
  4. The phone stops showing counts of the scan window: no Recent count, no
     pipelines count. Tab counts come from the task store, which is the whole
     inventory.
- **D: the jump control takes its own room.** "↓ down" / "↓ 3 new" becomes a
  44 px row in flow directly above the composer, holding the 32 px pill with a
  44 px target, shown only while the reader is away from the tail. When it
  appears the feed's viewport ends 44 px higher: the line the operator is
  reading, anchored at the top, does not move, and no text can sit under the
  control. The same change applies wherever
  `LogFeed` renders, the desktop readers included.

### 3.12 Copy (en / uk)

| key | en | uk |
| --- | --- | --- |
| tab labels | Inbox · Assigned · Blocked · Done (existing `kanban.status.*`) | Вхідні · Призначені · Заблоковані · Готові |
| not on a task | Not on a task · {n} (existing `kanban.notOnTask`) | existing uk |
| card working | {n} working | {n} працює |
| card agents | {n} agents | {n} агентів (plural forms) |
| no agents | no agents yet | ще без агентів |
| done window | Show {n} more | Показати ще {n} |
| empty columns | existing `kanban.empty.<status>.title` / `.body` | existing uk |
| empty actions | + New task · Tell the orchestrator | + Нова задача · Сказати оркестратору |
| moved receipt | Moved to {column} · Undo | Переміщено в «{column}» · Скасувати |
| dock working | {n} working (aria) | {n} працює |
| jump strip | ↓ down · ↓ {n} new (existing `feed.down`, `feed.newCount`) | existing uk |
| pipeline state chip and needs-you badge | existing `pipelineState.*` ("needs a decision", "needs review", "stages running", "paused", "completed", "provisioning the worktree") | existing uk ("потребує рішення", "потребує ревʼю", …); the phone's badge uses these words too, so one card never says "потрібне" and "потребує" for one state |
| stage state words | existing `pipelineChipState.*` | existing uk |
| actions | existing `mobile2.pipeline.retry` / `.skip` / `.archive` / `.resume`; new "One more round" | existing uk; new «Ще один раунд» |
| fail edge | existing `kanban.loop`, `kanban.loopRest`, `kanban.loopLive`, `kanban.loopParked` | existing uk |
| spent review budget | existing `pipelineReview.heads` | existing uk |
| passed fold | {n} passed | {n} пройдено |
| card reason | {stage} failed · {count} finding(s) · {age} | {stage} провалено · {count} зауваження · {age} |
| other pipelines | +{n} running · +{n} paused | +{n} виконуються · +{n} на паузі |
| completed fold | existing `mobile2.pipelines.completed` | existing uk |
| stage position | existing `kanban.stages.position` ("Stage {k} of {n}"), lower-cased in a meta line | existing uk |

Stage names are pipeline data and are never translated: a uk frame reads
"Implement", "Review", "Build ui", exactly as the desktop's uk board does
(`desktop-card-t-many-links-open-uk.png`). Round 1 translated them. One
separator, "·", in both languages.

### 3.13 Pipelines on the phone (round 2)

The phone draws a pipeline with the desktop's vocabulary and one component at
three densities. Nothing below is a new visual language; every element names
the desktop piece it comes from.

**The stage pill** is the desktop's `.pchip` (`PipelineSection.tsx:701`,
`kanbanBoard.css:363`): a mark, the stage's display name
(`stageDisplayName`), the review-round count and the fail-edge suffix. The
engine mark and the effort ladder, which cost about 40 px per pill and answer
none of the four questions, stay on the pipeline screen's stage rows. Pills are
joined by `→`.

**One tone map.** The phone imports `STAGE_TONE` (`pipelineGraph.ts:26`) and
the `.pdot` and `.pstate-chip` colours (`kanbanBoard.css:350-354`, `:523-528`)
and restates neither. The mark adds shape so the state reads without colour:

| Stage state | Tone (desktop) | Mark on the phone |
| --- | --- | --- |
| running, committing | active: success with a halo | filled dot with a halo, pulsing |
| reviewing | review: info with a halo | filled dot with a halo, pulsing |
| passed | ok: success | check |
| failed | bad: danger | cross |
| needs_decision | needs: warning with a halo | "!" in a warning disc (today's `StageMark` draws a danger cross; it moves) |
| pending, skipped | idle: hollow | hollow ring; dashed pill when it has no conversation yet |

A pipeline that needs the operator (`needs_decision`, `needs_review`) is amber
throughout on the phone: its edge, badge, chip, parked pill, reason line, and
the spent fail-edge suffix, which the desktop paints danger (the count "↺1/1"
already says the budget is spent). The desktop's `needs_review` chip is grey
today; filed as #2080. A paused pipeline draws no live tone: its held stage is
hollow.

**The fail edge** rides the pill that fails as the suffix the desktop falls
back to when a row wraps (`ReturnSuffix`, `PipelineSection.tsx:630`): "↺ 1/2".
On a screen, the stage's lines spell it in the desktop's loop words
(`kanban.loopLive`: "Implement is running now because Verify failed";
`kanban.loopRest`, `kanban.loopParked`).

**Densities.**

| | Board card | Task screen block | Pipeline screen |
| --- | --- | --- | --- |
| Pipeline title | none (the card is the task) | shown, two lines at most, omitted when it equals the task's title | the body's heading |
| State | badge only when it needs you | the `.pstate-chip` under the title, with the age | the bar: "needs a decision · stage 1 of 2 · 41m" |
| Chain | one line, display-only, 22 px pills | wraps, 30 px pills with 44 px targets that open the stage's conversation | a numbered stage list |
| PR and issue | passive text, right | `WorkLinkChip`s at the end of the chain row; "no PR" as plain text | chips row with "Attach PR or issue…" |
| Needs you | the reason line | the answer inside the block | the answer inside the parked stage |
| Actions | none (the card is one button) | ⋯ opens the pipeline's sheet (Pause, Resume, Close lane, Open conversation) | the bar's ⋯ |

**The card's chain fits one line.** The card tries, in order, until the
chain's `scrollWidth` fits its box: the whole chain; the passed stages before
the current one folded into "✓n"; the current stage, the next and "+m"; the
current stage and "+m"; and if even that does not fit beside the age and the
PR, the chain takes the line alone and the age and PR drop to the line below.
The current stage's name is never truncated. The round-2 board carries a
2-, 3-, 8-stage chain and a 43-character stage name; all four fit at 390 px
(`board-390-*`).

**The block answers in place.** A block whose pipeline needs a decision grows a
panel under its chain: the parked stage's report line ("Implement · Builder
failed · 41m ago"), the first finding as a severity chip and its text (two
lines, then "+n more"), and two 44 px buttons, **Skip stage** and **Retry
stage** (primary), through the same `usePipelineActions` requests the desktop
menu sends. A spent review budget (`needs_review`, #1938) shows the heads line
in warning ink and **Close lane** and **One more round** (primary), which calls
the engine's `continue-review` action with `addRounds: 1` (`PATCH` action checked at `engine.ts:5624-5627`, the grant at `engine.ts:6699`,
admitted unless `LLV_PIPELINE_CONTINUE_REVIEW=0`). Skip and Close keep today's
deferred receipt (`MobilePipelineScreen.tsx:78-91`): the request waits out the
receipt's four seconds and its Undo cancels it. Retry and One more round go at
once and their receipt names what happened.

**The pipeline screen is the phone's Stages view.** It replaces today's
`MobilePipelineScreen` body:

```
‹  needs a decision · stage 1 of 2 · 41m           ⚠7  ⋯
Stop repeated full-board downloads                     heading, the body owns the title
no PR                             Attach PR or issue…
Stages · 2
┌▌1 (!) Implement              needs a decision ┐   the current stage: tone stripe,
│▌      ✳ Opus 5.5 ▂▄▆ · Builder                │   engine, effort, role
│▌   Builder failed · 41m ago · attempt 1       │   its latest report
│▌   P1  The delta chain is rebuilt on the …    │   ranked findings
│▌   [ Skip stage ]  [ Retry stage ]            │   the answer, in the stage
│▌   Open conversation                        › │
│ 2  ○ Review ↺0/2                 pending   ⚙  │   pending: configure, no conversation
│      ✳ Opus 5.5 ▂▄▆ · Reviewer · review loop  │
└───────────────────────────────────────────────┘
↺ Review fails → Implement · up to 2 rounds
Past attempts · 1                                 ›
```

- One row per stage, numbered, with the pill's mark and the stage's state
  word in its tone. A row whose stage has a conversation opens it; a pending
  row offers ⚙ (configure) instead.
- The current stage is expanded: its report, findings, attempt, review round,
  fail-edge lines, the answer when the pipeline is parked on it, and "Open
  conversation ›". Its left stripe takes the stage's tone.
- Passed stages before the current one fold into one row, "1–3 · ✓ 3 passed ·
  Plan · Build api · Review api", which expands in place.
- "Linked tasks" appears only when it names a task other than the one the
  operator came from; "Past attempts · n" stays at the end.
- The graph is not drawn (§8).


## 4. Slices

Each slice is one PR, and each leaves the phone working.

1. **The board only moves forward (A, B, C).** `src/app/api/files/route.ts`
   (stamp the built generation), `src/hooks/useFiles.ts` (refuse older data,
   keep the newer rows on a scope switch). Tests in §5. Independent of the rest
   and first, because every later slice reads the same payload.
2. **The jump strip (D).** `src/components/LogFeed.tsx`. Independent.
3. **One pipeline block and one tone map.** `src/components/pipelines/PipelineBlock.tsx`
   over the desktop's `KanbanPipeline` summary with a `density` of `card`,
   `task` or `screen` (§3.13): the pill with the phone's mark, the card fold,
   the answer panel through `usePipelineActions`, `WorkLinkChip`s. The phone's
   `StageMark` and every phone pipeline colour switch to `STAGE_TONE` and the
   `.pstate-chip` states; needs_decision leaves the danger cross. The block is
   mounted first on today's phone pipeline list and Needs you rows, so it ships
   before the columns do.
4. **Columns.** Move `useBands` out of `KanbanBoard.tsx` into
   `src/components/kanban/useBands.ts`; a pure `src/components/mobile/phoneKanbanModel.ts`
   over `buildKanbanModel` (needs-you pin across the column, Done window, Not on
   a task, seat excluded, which pipeline a card shows); `MobileKanban.tsx`
   (tabs, pager, cards with the block at card density, card sheet); the mobile
   branch of `ProjectDashboard.tsx` renders it in place of `MobileBoard`'s
   sections. The top seat card and the old dock stay for this slice.
5. **Task screen.** `mobileNav` gains `{ kind: "task", id }`;
   `MobileTaskScreen.tsx` with the sections of §3.5: the blocks at task density,
   the completed fold, the bottom bar's status sheet through `useTaskMutations`
   and "+ Agent".
6. **Pipeline screen.** `MobilePipelineScreen` becomes the Stages view of
   §3.13: the numbered stage list with the passed fold, the expanded current
   stage with the answer in it, One more round for `needs_review`.
7. **Dock.** `MobileBoardDock` takes the seat's state line and the working
   count; the Working sheet reuses `MobileSwitchSheet`'s rows; the seat card
   slot is removed; ⋯ gains Orchestrator seat.
8. **History and cleanup.** ⋯ › All conversations as a screen; ⋯ › Hidden
   tasks; remove `buildMobileBoard`'s sections and `MobileBoard`'s Recent and
   catalog code (`mobileRowState` stays: `kanbanModel` reads it).
9. **Loading and empty.** The phone kanban's shapes on #2071's primitives once
   they land. If #2071 is not merged when slice 4 is built, slice 4 ships the
   empty states and a plain skeleton in the card's shape, and this slice
   switches them to #2071's primitives.

## 5. Test plan

Run the files you touch, by path, under an isolated state directory (AGENTS.md).

- **Model (pure):** `phoneKanbanModel.test.ts`: column counts equal the
  desktop model's for the same input; needs-you cards first in attention order;
  Done shows 20 and counts all; Not on a task only in Inbox; the seat's task in
  no column; a hidden group in no column and in the hidden list.
- **Monotonic data:** `useFiles` tests with a fake fetcher: answers built from
  generations 12 → 14 → 12 (stale) leave the snapshot at 14; a scope switch
  from pinned back to global keeps generation 14's rows; a 304 on a scope never
  restores older rows over newer. A route test: a stale projection answer
  carries its own built generation. A board-level test replays the incident:
  the 09:23 payload then the 09:19 payload renders Working 3 and no closed lane.
- **DOM (happy-dom):** the board renders four tabs with counts and dots; the
  active column follows a tab tap; long-press opens the card sheet and Move to
  moves optimistically, shows the receipt, and rolls back on a refused PATCH;
  a card opens the task screen, and ‹ returns to the same column and offset;
  the dock opens the seat conversation, and "● n" opens the Working sheet;
  empty columns show their copy; `LogFeed` renders the jump strip in flow.
- **Rendered (the existing phone driver,
  `src/components/mobile/issue1671Evidence.browser.test.tsx`, gated by
  `LLV_SWIPE_BROWSER_TEST=1` with `CHROME_BIN`, one new `describe` per slice
  and no new driver file):** at 390 × 667 and 430 × 735 (the page Safari leaves
  at 390 × 844 and 430 × 932), en and uk, dark and light, for the board, a task,
  needs-you, an empty column, loading, and a conversation away from its tail.
  Gates: no horizontal overflow; every visible control at least 44 × 44; no two
  controls intersect; **ink overlap**: the union of each text element's client
  rects, clipped by its overflow ancestors, intersects no other text's ink and
  no control (the jump strip included); card titles at most two lines; tab
  labels never truncated; the dock fully inside the page; long real titles (the
  687-character p90) and Ukrainian copy in the fixtures.
- **Pipelines (the critique's R1–R12, over the desktop fixture's pipelines
  reused on the phone: the eight-stage chain, the parked decision, the fired
  and the spent fail edge, the spent review budget, a review loop in round 2,
  paused, provisioning, completed with a merged PR, five pipelines on one task,
  and stage names of 5, 20 and 43 characters):**
  - *Same words as the desktop:* a DOM test renders the block at each density
    and asserts its stage names, state chip words and loop words equal what
    `PipelineSection` renders for the same pipeline.
  - *One tone map:* a table test over every `StageChipState` and pipeline state
    compares the phone's tone class with `STAGE_TONE`'s; a frame gate reads the
    computed colours inside a needs-you card and finds no success, danger,
    accent or info ink or fill outside the PR text.
  - *The card's chain:* one line of pills, `scrollWidth <= clientWidth`, the
    current stage's name untruncated, for every chain length and name length.
  - *Ages:* no card text matches `^\d{1,2}:\d{2}$`; a running card with a
    one-line title is at most 74 px tall.
  - *Answered in place:* on the task frame at 390 × 667 the Retry button is at
    least 44 × 44 and inside the first 667 px; both blocks and the Agents header
    are above the bottom bar; a tap sends the same request the desktop menu
    sends for that pipeline and stage; Skip and Close wait out the receipt.
  - *Once per screen:* each pipeline title and the task title occur once; "no
    PR" occurs only inside a pipeline's block or chips row.
  - *Pipeline screen:* frames for needs_decision, running, needs_review and
    completed; Board → Task → Pipeline → stage conversation → ‹ ends on the
    pipeline; every stage row with a conversation is a 44 px target.
  - *Pin:* in the needs fixture the first five Inbox items are the five the
    tab's ⚠5 counts; the four stalled rows have four distinct titles and say
    "stalled" once each.

## 6. Mockups

Static HTML and CSS with the values of `src/styles/tokens.css`, rendered with
`playwright-core` and `CHROME_BIN=google-chrome-stable`. The frame includes an
iOS status bar and Safari's bottom URL bar so the page area is the real one.
Synthetic data: task titles are public issue titles of this repository or the
desktop evidence fixture's, ages agree across screens (the skeletons lane is
21m on its card and "working 21:05" in its conversation). The PNGs are not
committed.

**Round 2**, in `/var/tmp/phone-kanban/mockups-r2/` (54 frames; source and
render script in `/var/tmp/phone-kanban/mockups-r2-src/`). Each scene at
390 × 844 and 430 × 932, en and uk, dark (`<scene>-<width>-<lang>.png`), plus:

| Scene | What it shows | Extra frames |
| --- | --- | --- |
| `board` | Assigned: a parked decision, a spent review budget, running chains of 2, 3 and 8 stages and a 43-character stage name, two finished tasks | `board-light-390-*` |
| `task` | the round-1 example task: the decision answered in its block, a paused pipeline, description row, Agents, the bottom bar | `task-light-390-*`, `task-390-full-*` |
| `task-many` | one task with seven pipelines: a spent review budget with One more round, a review loop in round 2, a fired fail edge, provisioning, three completed folded | `task-many-390-full-*` |
| `pipeline-decision` | the pipeline screen parked on a decision, answered in the stage | |
| `pipeline-running` | the eight-stage pipeline running stage 4, passed stages folded | `pipeline-running-390-full-*` |
| `pipeline-review` | the pipeline screen with a spent review budget | |
| `pipeline-done` | a completed pipeline with its merged PR | |
| `needs` | Inbox: five needs-you items pinned first, stalled rows named by their prompts, a pipeline under Not on a task | |
| `empty` | Blocked empty, the hint as a 44 px row | |
| `loading` | cold start with pill-shaped skeletons and the dock's placeholders | |
| `jump` | a stage conversation: its stage in the bar, the jump strip | |

The `-full` frames render the whole scroll of the screen at 390 px.

The render script runs the §5 gates on every frame, and round 2 adds the
pipeline gates above (card chain on one line, current stage untruncated, no
clock-like ages on cards, "no PR" only inside a pipeline, one status hue on a
needs-you card, each title once per screen). Final run: 54 frames, 0
findings. Earlier runs caught four real defects that the frames now correct:
the 43-character stage name overflowed the card at every fold level (fixed by
the last two fold levels and the own-line fallback), the spent fail-edge suffix
painted danger on an amber card, PR chips' 44 px targets reached over the
line below them, and the link row's targets reached into the title above.

Round 1's 26 frames stay in `/var/tmp/phone-kanban/mockups/` for comparison.

## 7. Validation against the requirement

| The requirement says | The design |
| --- | --- |
| "sees where every piece of work stands (by status column or equivalent)" | four columns from the task store, every drawn task in one of them, counts on the tabs |
| "moves between columns … with one hand" | a swipe anywhere on the column area; tabs as a second path |
| "and into a task, a pipeline or a conversation" | card → task screen → pipeline or conversation; Not on a task opens directly |
| "and acts from there" | a decision or a spent review budget is answered inside its pipeline's block on the task screen and inside the parked stage on the pipeline screen (§3.13); a question from the needs-you block; the status from the bottom bar's sheet and the card sheet; + Agent |
| "one coherent phone surface, combined with what the phone board shows today" | one board: seat and composer in the dock, Needs you on cards and in ⚠, pipelines and working agents on cards, recent conversations on their tasks (§3.1 table) |
| "rethink what is wrong with the current phone board" | §2.6; the sections that split one task are removed, the history leaves the work surface, the counts of the scan window go, the data stops going back in time |
| "task cards with their pipelines, running agents and 'needs you' state" | §3.4 |
| "where the orchestrator, the composer and recent conversations live" | §3.6, §3.10 |
| "navigation and back behaviour; one-hand reach" | §3.7, §3.8 |
| "empty and loading states consistent with #2071" | §3.9 |
| "explain each defect above with file:line" | §2.3 |
| "rendered phone mockups (390 px, en and uk)" | §6, also 430 px |
| round-1 verdict: "pipelines must be very convenient on the phone" | the chain answers what stage and whether it moves on the card; the reason says what it needs; the answer is two 44 px buttons in the block, one tap after the card (§3.13, §10) |
| round-1 verdict: build on the desktop's group header, stage pills and chain, Stages view, PR and issue chips | every phone pipeline element names its desktop source (§3.13): `.pchip` pills and `→`, `STAGE_TONE`, `.pstate-chip`, `ReturnSuffix`, the loop words, `WorkLinkChip`s per pipeline, and the pipeline screen as the Stages view's numbered navigator |
| round-1 verdict: the task-screen example (equal stage bars, the meta line, the needs block repeating the pipeline) | the bars are pills, the meta line is gone, the needs block for a pipeline is gone and its answer lives in the one block (`task-*`) |

## 8. Deferred — not currently justified

- **Drag and drop between columns.** A long-press sheet and the task screen's
  status sheet move a task in two taps; a drag across a paged pager is fragile and
  nothing asks for it.
- **Search and filters inside a column.** The bar's search finds any message; a
  per-column filter is desktop parity nobody asked for on the phone.
- **A `#t=` deep link to a task.** Links today name conversations and projects.
- **Typing to the orchestrator on the board.** The dock is a door; a second
  composer instance would split drafts and voice (§3.6).
- **Landscape layout.** Mobile-v2 renders 844 × 390; the pager works there, and
  a tuned budget waits for a request.
- **Swipe actions on cards.** They fight the pager; the long-press sheet has them.
- **Pull to refresh.** In Safari it reloads the page, the slow path #2071 is
  shortening; the board is live anyway.
- **The stage graph on the phone.** The desktop's graph toggle and the Stages
  sheet's graph are dropped: the numbered list says the order and the fail edge
  rides its pill. Nothing in the requirement asks for a graph at 390 px.
- **Return arcs drawn as arcs.** The "↺ k/n" suffix carries the same count in a
  form a thumb can read.
- **Stage panes swiped side by side, each with its conversation.** The stage's
  conversation is one tap away on its own screen, with the back stack of §3.7.
- **Engine marks and effort ladders on the card's and block's pills.** They stay
  on the pipeline screen's stage rows, where a stage's runtime is chosen.
- **Deciding from the board card itself.** The card is one button; nesting
  actions in it breaks that. The task screen answers one tap after the card.
- **A grant of more than one review round from the phone.** One more round is
  the common case; a larger grant stays a `pipeline_action` call.

## 9. Decisions for the operator

1. **Columns (§3.2).** A: four swipeable columns with tabs, needs-you cards
   pinned to the top of their column (recommended). B: one scroll grouped by
   status. C: keep today's sections and add tasks.
2. **Orchestrator (§3.6).** Into the bottom dock with its state and the working
   count (recommended), or keep the top card and today's dock.
3. **Recent and All conversations (§3.10).** Off the board, into their tasks,
   Inbox › Not on a task and ⋯ › All conversations (recommended), or keep a
   short Recent list under the columns.

4. **Review rounds from the phone (§3.13).** A spent review budget offers One
   more round beside Close lane, granting exactly one round through
   `continue-review` (recommended). #1938 left the phone with Close only,
   because a grant needs a round count; a fixed count of one answers that. The
   alternative keeps Close only and sends the operator to the desktop or the
   orchestrator to continue.

The data fix (slice 1), the jump strip (slice 2) and the pipeline block
(slice 3) need no decision and can start at once.

## 10. Round 2: what changed and why

Each finding of `docs/design/phone-kanban-critique.md`, with what round 2 did.
"Accepted" means built as the critique recommends; "changed" means accepted
with a different mechanism, and says why; "rejected" says why. Frames are in
`/var/tmp/phone-kanban/mockups-r2/`.

| Finding | Round 2 | Where |
| --- | --- | --- |
| **P1-1** the decision shown twice and answerable nowhere | Accepted. A pipeline appears once per screen; its needs-you state is its own block's state, and Skip stage and Retry stage are 44 px buttons inside it. The needs block remains only for a question or a plan approval. **Changed:** the buttons keep the existing "Retry stage" / "Skip stage" copy instead of naming the stage, because the stage is named once in the report line directly above and "Повторити етап" fits a 165 px button in uk. | §3.5, §3.13; `task-*` |
| **P1-2** the unlabelled 12 × 4 px track | Accepted. The card's second line is the desktop chain: pills with a mark and the display name, `→` between them, folded to one line. **Changed:** the fold gained two last levels (the current stage with "+m", the current stage alone) and an own-line fallback, because the render gate found a 43-character stage name overflowing every fold level the critique listed. | §3.4, §3.13; `board-*` |
| **P1-3** two colour mappings | Accepted. `STAGE_TONE` and the `.pstate-chip` colours, imported; shape added (check, live dot, cross, "!", ring); needs_decision leaves the danger cross. **Changed:** the spent fail-edge suffix is amber on the phone where the desktop paints it danger, so a needs-you card keeps one status hue; the gate checks that hue. The desktop's grey `needs_review` chip is filed as #2080. | §3.13; `board-*`, `task-many-*` |
| **P1-4** the pipeline screen never drawn | Accepted. The pipeline screen is redesigned as the Stages view and drawn for needs_decision, running (eight stages), needs_review and completed. **Changed:** the decision sits inside the parked stage's expanded row instead of a block above the list, so its report and findings are drawn once, next to the attempts and fail edge they belong to. The review loop in round 2, the fired fail edge, provisioning and paused are drawn as task-screen blocks; their pipeline screens are the same layout with the current stage's lines changed and are not drawn separately. | §3.13; `pipeline-*`, `task-many-*` |
| **P2-1** stage bars that look like buttons | Accepted. Pills; on the task screen a pill with a conversation is a 44 px target that opens it, and a pill without one is dashed and not focusable. | §3.13; `task-*` |
| **P2-2** PR attribution contradicting itself | Accepted. Each block carries its own chips at the end of its chain row; "no PR" appears only inside the block that has none; the task-level row only for links attached by hand. | §3.5; `task-*`, `task-many-*` |
| **P2-3** elapsed times read as clock times | Accepted. Ages carry units on cards and blocks ("4m", "41m", "2h"); the live `m:ss` stays in the conversation bar. | §3.4; `board-*`, `jump-*` |
| **P2-4** the agents line repeating the pipeline line | Accepted. No agents line when every working agent is a stage of the shown pipeline; a running card with a one-line title measures 65 px. | §3.4; `board-*` |
| **P2-5** a status bar that looks like the tab strip and writes | Accepted. One "Assigned ▾" pill opens a status sheet; "+ Agent" beside it in the bottom bar. | §3.5; `task-*` |
| **P2-6** the task title drawn twice | Accepted. The bar carries the context and takes the title once the body title scrolls out. The same rule moved to the pipeline screen, whose title was truncated in the bar. | §3.5, §3.13; `task-*`, `pipeline-*` |
| **P2-7** finished work saying nothing | Accepted. One muted line "✓ completed · 20m" with the PR in muted text, no chain; "Move to Done" first in the long-press sheet, which §3.4 specifies and no frame draws. Completed pipelines fold behind "✓ 3 completed" on the task screen. | §3.4, §3.5; `board-*`, `task-many-*` |
| **P2-8** stalled rows identical and said three times | Accepted. Titles are the first prompt line; the state is said once, as the badge; the meta line carries engine, model, "not on a task" and age. The red edge stays as the row's attention edge, the same device needs-you cards use. | §3.2; `needs-*` |
| **P2-9** the pin broken in its own mockup | Accepted. The pin spans the column: the five items ⚠5 counts come first, the stalled rows included. | §3.2; `needs-*` |
| **P3-1** lower-cased stage names | Accepted. Display names; and stage names are no longer translated in uk, matching the desktop's uk board. | §3.12; `*-uk` |
| **P3-2** "P1" as jargon | Accepted. A severity chip beside the finding's text. | §3.13; `task-*`, `pipeline-*` |
| **P3-3** separators differing by language | Accepted. "·" in both. | §3.12 |
| **P3-4** the stage conversation losing its pipeline | Accepted. Its bar reads "working 21:05 · stage 1 of 3 · Design"; the model left the bar because the composer's pill already shows it. | `jump-*` |
| **P3-5** contradicting mockup data | Accepted. One data set across screens: the skeletons lane is 21m on its card and 21:05 in its conversation; the favicon review is 4m. | §6 |
| **P3-6** the loading dock popping its controls in | Accepted. Placeholders for "● n" and the mic. | §3.9; `loading-*` |
| **P3-7** the empty hint neither link nor text | Accepted. A 44 px row that opens Assigned. | §3.9; `empty-*` |
| **OVER-BUILT** (§2 of the critique): the needs block for pipelines, the agents line on stage-only cards, the four-button status bar, the title drawn twice | All four removed (P1-1, P2-4, P2-5, P2-6). Round 2 also dropped the block's "Stages" text link in favour of the header's ›, and the paused block's separate note, which repeated its chip. | — |
| **R12** frames in dark and light | **Partly.** Light frames cover the board and the task screen only (`*-light-390-*`); the pipeline screens were drawn dark only. The tone map is imported from the same tokens in both schemes, so the build's frame gate covers light for every scene (§5). | §6 |

Added beyond the critique: **One more round** for a spent review budget
(decision 4 in §9), because the requirement asks the operator to act from the
phone and #1938 had left only Close there.

## Appendix: other defects met during this research

- `board_snapshot` with `limit: 5` returned about 570 000 characters: the
  board's stored preferences are returned whole regardless of the limit, so a
  bounded read is not bounded. It belongs in its own issue.
- Round 2: #2080, the desktop draws the `needs_review` state chip in the grey of
  an idle pipeline (`kanbanBoard.css:350-354` has no `needs_review` rule).
