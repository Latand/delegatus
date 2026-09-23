# Phone kanban: a convenient board on mobile (#2072)

Design only. The operator reviews this note and its rendered mockups before any
build starts. Every file:line below is on `origin/main` at `fcf9c0110` (the
merge of #2068) unless it says otherwise.

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

History that this reverses: on 2026-09-14, asked whether the #1695 kanban
should change the phone, the operator chose "Телефон не трогать вообще" (leave
the phone alone), so below 640 px the phone kept mobile-v2 (#1439). #2072 is the
operator now asking for the phone kanban.

## 1. The design in one screen

```
┌ live-log-viewer-next ⌄          ⚠ 2   🔍   ⋯ ┐ 52  bar (unchanged)
│ Inbox    │ Assigned  │ Blocked  │ Done      │ 52  column tabs: label, count,
│ 9  ⚠1    │ 51 ●3 ⚠1  │ 3        │ 578       │     ●working ⚠needs-you dots
├──────────────────────────────────────────────┤
│▌Mobile data: stop repeated full-board   ⚠   │     needs-you cards pin first
│▌downloads and hidden-tab traffic             │     (edge + badge)
│  ▰▱ stage 1/2 · build · failed       no PR  │     stage track · state · PR
│  2 agents · 41m                               │
│ Restore /favicon.ico with the Delegatus      │
│  ▰▰ review · reviewing 4:12   PR #2070 open  │
│  ✦ 1 working · 2 agents · 3m                 │     running agents on the card
│ …                                            │     ← swipe → pages columns
├──────────────────────────────────────────────┤
│ 🤖 Tell the orchestrator…        ● 3    🎤   │ 64  orchestrator dock: its state,
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
 │                                   ├─ needs-you block ─▸ Conversation | Pipeline
 │                                   ├─ pipeline row ────▸ Pipeline (screen) ─▸ stage conversation
 │                                   ├─ agent row ───────▸ Conversation (screen)
 │                                   └─ bottom bar: status (4 segments) · receipts with Undo
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

Order inside a column: cards that need the operator first, oldest ask first
(the attention queue's order, which ⚠ and Next › already walk), then the
desktop's order (latest agent work first). The pin is the one deliberate
difference from the desktop: the phone shows five or six cards at a time, and a
decision must not sit under 50 assigned tasks. Seat tasks stay out of the
columns, as on the desktop (the dock owns the seat). Hidden groups leave the
columns and are listed at ⋯ › Hidden tasks with Show.

Column specifics:

- **Inbox** ends with "Not on a task · n" (the desktop's `unlinkedShown`): a
  pipeline or conversation card with no task; a tap opens it directly.
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
┌───────────────────────────────────────────────┐
│▌<title, 13 px / 600, two lines at most>   [a question] │ badge only when it needs the operator
│  ▰▰▱ review · reviewing 4:12         PR #2070 open │ newest active pipeline: stage track,
│                                               │ stage · state phrase · age, passive PR text
│  ✦✦ 2 working · 5 agents · 12m               │ engine marks of working agents, counts, last work
└───────────────────────────────────────────────┘
```

- **Left edge (3 px):** amber when the card needs the operator, red when a
  member stalled; otherwise the task's colour label when it has one; otherwise
  none. One coloured edge at most (design system rule 7).
- **Title:** two lines, then an ellipsis. A placeholder title reads in muted
  italics, as on the desktop.
- **Badge (needs you only):** the row's reason in the existing words: "a
  question", "plan approval", "needs a decision", "needs review", "stalled", "limit".
- **Pipeline line (when the task has pipelines):** a stage track, one 12 × 4 px
  segment per stage (passed = success, running/reviewing = accent, failed =
  danger, waiting = border); then `stage · state` in the pipeline words the
  phone already uses (`stageCardLabel`, `pipelineReviewHeads`); "+1" when more
  pipelines are active. On the right, the #2059 link as passive text ("PR #2068
  merged", "no PR"): a link cannot nest inside the card's button, which is the
  rule #2059 §6.4 already set for phone rows. The chips are clickable on the
  task screen.
- **Agents line:** the engine marks (16 px, the shared `EngineMark`) of up to
  three working agents, "n working" in success, "n agents" in total, and the age
  of the latest agent work. With nothing working: "5 agents · done 2h", or "no
  agents yet".
- The whole card is one button (the task screen). A long-press opens the card
  sheet (§3.8). Height: 74 px with a one-line title and no pipeline, 92 px with
  two lines and a pipeline.

A card in "Not on a task" is the conversation row the phone draws today
(`ConversationRow`) or a pipeline row (`MobilePipelineQueueRow`), unchanged.

### 3.5 Task screen

Pushed from a card. The bar reads ‹, the task title on one line and a meta line
("Assigned · 5 agents"), and ⋯ (Rename, Colour, Details, Attach PR or issue,
Hide from board, Copy link).

Body, one scroll:

1. **Title and description**: the title whole (15 px / 600), the description
   clamped to three lines with "More". A tap on either edits it in place
   (`PATCH /api/tasks/:id` with `expectedRevision`, as the desktop's
   `CardInlineText` does).
2. **Links**: the #2059 `WorkLinkChip`s of the task, clickable, or "no PR"
   when the task has none; a pipeline without a PR says so on its own row.
3. **Needs you** (when anything on the task needs the operator): one amber-edged
   block per item, with the reason and the one action that answers it: "Open
   pipeline ›" for a decision, "Answer ›" for a question or a plan.
4. **Pipelines · n**: one row per pipeline, newest active first: title, state
   chip, stage track with stage names, "stage 2/3 · review · reviewing 4:12". A
   tap opens the pipeline screen.
5. **Agents · n** with "+ Agent" on the section header: the members as today's
   conversation rows (working first), which keep their swipe actions here
   because this screen has no pager.
6. **Details** and **Earlier attempts**: collapsed rows.

Bottom bar, in thumb reach: the **status control**, four segments (Inbox ·
Assigned · Blocked · Done) with the current one filled. A tap moves the task at
once through the desktop's optimistic, revision-guarded mutation
(`useTaskMutations`), shows a receipt in flow with Undo for 4 s, and on a
refusal moves it back and says why (mobile-v2 rule 9: no confirmation prompts,
receipts carry the inverse).

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
lower cards and the task screen's status bar. The top holds the bar and the
tabs. Every top control has a one-hand path: the swipe for columns, the pinned
card for a decision.

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
  filling the column in the card's own anatomy (two title bars, a stage track, a meta bar), and the
  dock with the avatar and a dimmed state line. The pulse stops under
  `prefers-reduced-motion`.
- **Empty column:** the desktop's own empty copy (`kanban.empty.<status>.title`
  and `.body`, en and uk already exist), centred in the column, plus one action
  where there is a next step: Inbox gets "+ New task", Assigned gets "Tell the
  orchestrator". Under it, one muted line points at the nearest column with
  work ("← Assigned has 51 tasks · 3 working"). The other tabs keep their
  counts, so the operator sees where the work is.
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

## 4. Slices

Each slice is one PR, and each leaves the phone working.

1. **The board only moves forward (A, B, C).** `src/app/api/files/route.ts`
   (stamp the built generation), `src/hooks/useFiles.ts` (refuse older data,
   keep the newer rows on a scope switch). Tests in §5. Independent of the rest
   and first, because every later slice reads the same payload.
2. **The jump strip (D).** `src/components/LogFeed.tsx`. Independent.
3. **Columns.** Move `useBands` out of `KanbanBoard.tsx` into
   `src/components/kanban/useBands.ts`; a pure `src/components/mobile/phoneKanbanModel.ts`
   over `buildKanbanModel` (needs-you pin, Done window, Not on a task, seat
   excluded); `MobileKanban.tsx` (tabs, pager, cards, card sheet); the mobile
   branch of `ProjectDashboard.tsx` renders it in place of `MobileBoard`'s
   sections. The top seat card and the old dock stay for this slice.
4. **Task screen.** `mobileNav` gains `{ kind: "task", id }`;
   `MobileTaskScreen.tsx` with the sections of §3.5, the status bar through
   `useTaskMutations`, `WorkLinkChip`s, "+ Agent".
5. **Dock.** `MobileBoardDock` takes the seat's state line and the working
   count; the Working sheet reuses `MobileSwitchSheet`'s rows; the seat card
   slot is removed; ⋯ gains Orchestrator seat.
6. **History and cleanup.** ⋯ › All conversations as a screen; ⋯ › Hidden
   tasks; remove `buildMobileBoard`'s sections and `MobileBoard`'s Recent and
   catalog code (`mobileRowState` stays: `kanbanModel` reads it).
7. **Loading and empty.** The phone kanban's shapes on #2071's primitives once
   they land. If #2071 is not merged when slice 3 is built, slice 3 ships the
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

## 6. Mockups

Static HTML and CSS with the values of `src/styles/tokens.css` (dark scheme,
as on the operator's phone, plus a light board), rendered with `playwright-core`
and `CHROME_BIN=google-chrome-stable`. The frame includes an iOS status bar and
Safari's bottom URL bar so the page area is the real one. Synthetic data; task
titles are public issue titles of this repository. The PNGs are not committed.

| Scene | 390 × 844 en | 390 × 844 uk | 430 × 932 en | 430 × 932 uk |
| --- | --- | --- | --- | --- |
| Board, Assigned column | `board-390-en.png` | `board-390-uk.png` | `board-430-en.png` | `board-430-uk.png` |
| Task opened | `task-390-en.png` | `task-390-uk.png` | `task-430-en.png` | `task-430-uk.png` |
| Needs you across columns | `needs-390-en.png` | `needs-390-uk.png` | `needs-430-en.png` | `needs-430-uk.png` |
| Empty column (Blocked) | `empty-390-en.png` | `empty-390-uk.png` | `empty-430-en.png` | `empty-430-uk.png` |
| Loading, cold start | `loading-390-en.png` | `loading-390-uk.png` | `loading-430-en.png` | `loading-430-uk.png` |
| Conversation, jump strip (defect D) | `jump-390-en.png` | `jump-390-uk.png` | `jump-430-en.png` | `jump-430-uk.png` |
| Board, light scheme | `board-light-390-en.png` | `board-light-390-uk.png` | | |

All under `/var/tmp/phone-kanban/mockups/`, with `geometry.json` beside them.
The §5 gates ran on the mockups themselves (page overflow, 44 px targets,
intersecting targets, ink overlap clipped by overflow ancestors, two-line
titles, untruncated tab labels): 26 frames, 0 findings. The first run caught one
real defect, the task screen's "More" link at 41 × 34 px with its target
reaching into the description, which the rendered frames now correct.

## 7. Validation against the requirement

| The requirement says | The design |
| --- | --- |
| "sees where every piece of work stands (by status column or equivalent)" | four columns from the task store, every drawn task in one of them, counts on the tabs |
| "moves between columns … with one hand" | a swipe anywhere on the column area; tabs as a second path |
| "and into a task, a pipeline or a conversation" | card → task screen → pipeline or conversation; Not on a task opens directly |
| "and acts from there" | status move at the bottom of the task screen and in the card sheet; answer a question or a decision from the needs-you block; + Agent; the pipeline screen's actions |
| "one coherent phone surface, combined with what the phone board shows today" | one board: seat and composer in the dock, Needs you on cards and in ⚠, pipelines and working agents on cards, recent conversations on their tasks (§3.1 table) |
| "rethink what is wrong with the current phone board" | §2.6; the sections that split one task are removed, the history leaves the work surface, the counts of the scan window go, the data stops going back in time |
| "task cards with their pipelines, running agents and 'needs you' state" | §3.4 |
| "where the orchestrator, the composer and recent conversations live" | §3.6, §3.10 |
| "navigation and back behaviour; one-hand reach" | §3.7, §3.8 |
| "empty and loading states consistent with #2071" | §3.9 |
| "explain each defect above with file:line" | §2.3 |
| "rendered phone mockups (390 px, en and uk)" | §6, also 430 px |

## 8. Deferred — not currently justified

- **Drag and drop between columns.** A long-press sheet and the task screen's
  status bar move a task in one tap; a drag across a paged pager is fragile and
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
- **A stage graph on the task screen.** The pipeline screen has the stages; the
  card and the task screen carry the track.

## 9. Decisions for the operator

1. **Columns (§3.2).** A: four swipeable columns with tabs, needs-you cards
   pinned to the top of their column (recommended). B: one scroll grouped by
   status. C: keep today's sections and add tasks.
2. **Orchestrator (§3.6).** Into the bottom dock with its state and the working
   count (recommended), or keep the top card and today's dock.
3. **Recent and All conversations (§3.10).** Off the board, into their tasks,
   Inbox › Not on a task and ⋯ › All conversations (recommended), or keep a
   short Recent list under the columns.

The data fix (slice 1) and the jump strip (slice 2) need no decision and can
start at once.

## Appendix: other defects met during this research

- `board_snapshot` with `limit: 5` returned about 570 000 characters: the
  board's stored preferences are returned whole regardless of the limit, so a
  bounded read is not bounded. It belongs in its own issue.
