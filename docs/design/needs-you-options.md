# The needs-you chip: three directions for the operator to pick

## Originating requirement

Pinned task of pipeline `6fbb9603`, 2026-09-26, written by the orchestrator
from the operator's words:

> The operator dislikes the board header's needs-you chip ("ЧЕКАЮТЬ N | Далі ›",
> amber, top right): both how it looks and that "Далі/Next" jumps them from
> project to project. They want 2-3 genuinely different options to choose
> from, as renders. Take into account the new "Asks you" signal being built
> (an agent whose last turn asks the operator gets an "Asks you" needs-you
> reason and a reports-log line with a jump link), the reports log beside the
> orchestrator, and the existing needs-you reasons (decisions, parked lanes,
> permission prompts).

Two complaints, one ask. The look, the cross-project jump, and a choice of
renders. This document is the "ideas" stage: three directions, each with what
the operator sees and does on desktop and phone, why it is better, and what it
costs. The "render" stage builds each as a mockup on the product's real
components and tokens. Nothing here is code.

Should this be built at all: yes. The requirement names a control the operator
uses many times a day and says it is wrong twice over. Two of the three
directions below are cheap. What the requirement does not demand is deferred
at the end.

## Prior work

`search_transcripts` in three phrasings ("needs-you chip Next jumps project
header island", "Asks you needs-you reason reports log jump link", "attention
inbox grouped by project waiting for you panel") found nothing older than this
week. The only hits are this pipeline and the parallel "Asks you" lane
(pipeline `3ad9f75d`, branch `pipeline/asks-you-jev-flags-agents-that-ask-the-o-3ad9f75d`),
whose research doc (`docs/research/attention-classifier.md` on that branch)
fixes the shape the new signal will have. Section 1.4 below reads it.

## 1. How it works today

### 1.1 The chip

`src/components/attention/AttentionIsland.tsx`. One pill, drawn `fixed` at the
top-right of the viewport (`Viewer.tsx:1552`, `right-4 top-[10px]`) and
portaled into the last slot of the board bar (`ProjectBar.tsx:46`
`BarIslandSlot`) so the tab order reads it after ⋯. The bar reserves 252 px for
it (`ProjectBar.tsx:53`).

Anatomy, left to right, all in the warning tone (`border-warning/45
bg-warning-soft`, text `text-warning` 12 px bold):

1. `ЧЕКАЮТЬ 5` — uppercase, `tracking-[0.08em]`. Click toggles the popover.
2. a vertical divider
3. `Далі ›` — click advances the global cycle; Shift-click goes back.
4. a divider and a funnel (`Filter`) when at least one conversation waits: the
   "show only who waits for me" board filter (F).

At zero it stays on screen as a muted outlined pill reading `ЧЕКАЮТЬ 0`
(the onboarding walk anchors on it, `data-walk-anchor="needs"`).

### 1.2 The count and the popover

`needsYou` (`Viewer.tsx:858`) is `buildNeedsYouQueue(files, pipelines, clock,
closing)` (`attentionQueue.ts:48`): every project's waiting conversations
(`buildAttentionQueue`, blocked first, oldest first) followed by every
project's parked lanes (`overviewPipelineRows`). It is global. The same number
goes into the document title `(5) Delegatus`.

The popover (`Viewer.tsx:1333-1383`) is a 340 px sheet under the pill: the
current project's crowned favourites, the heading «Чекають на тебе», then the
flat global list. A conversation row (`AttentionQueueRow`) shows the title, a
project chip, the age and the decision line; a permission row carries
«Дозволити раз / Відхилити» inline (#2215). A lane row (`AttentionLaneRow`)
shows the task, project chip, age and the lane's need in the card's words
(`needLabel`). Rows are in queue order, so projects interleave.

### 1.3 Two "Next"s that disagree

- The **button** `Далі ›` calls `advanceGlobalAttention` (`Viewer.tsx:1278`):
  it walks `needsYou`, the global list, and switches project when the next
  item lives elsewhere. The comment says so on purpose: "a deliberate act like
  a popover click, so it advances over the GLOBAL queue and may switch the
  project".
- The **key** N walks `projectEntries` (`Viewer.tsx:1140`), the same list
  filtered to the current project, and "never leaves the current project
  (D4)".

Both move one `cycleRef`, so pressing N after clicking Далі continues a
sequence the operator did not see. The phone already settled this question
the other way: its ⚠ badge and sheet are scoped to the project behind the bar
(`shellEntries`, `Viewer.tsx:1159`: "counting every project's rows made the
badge promise items that screen could not reach"), and only the Overview
shows the whole queue. The desktop chip is the one surface left promising
items the board under it cannot show.

### 1.4 What is beside it

- **Project rail** (`ProjectRail.tsx:842`): each project row carries `⏸ N`
  in the warning tone. Its membership (`projectModel.ts:208-234`) differs
  from the chip's: it counts `paused` lanes and workflows, which the chip does
  not. Two amber numbers that can disagree.
- **Overview bar** (`KanbanBoard.tsx:2561`): «N працюють · N чекають · N
  задач» as plain text with a warning dot. Quiet, and already the right idiom.
- **Orchestrator seat**: the dock badge «потребує тебе» in the same warning
  tone (`OrchestratorPanel.tsx:1206`), and the **report log** (#2146,
  `reportLog/ReportLog.tsx`) as a column beside the seat's chat from 720 px of
  seat width, per project, newest first, each entry a time, a class word and
  the body with `#123` and card ids linked. It lives only inside the
  orchestrator panel; a project without a seat has no log on screen.
- **"Asks you"** (lane `3ad9f75d`, in implementation): a new conversation
  reason kind `ask` beside `question` and `plan`, label "Asks you · ‹role›",
  header = the agent's last sentence, one open ask per conversation, cleared
  when the operator writes, the agent speaks again, or on Dismiss. Plus one
  Viewer-authored report-log line per ask, "‹agent› needs you: ‹last
  sentence›", with a jump link. It joins `attentionReason`, so every option
  below inherits it through `buildNeedsYouQueue` with no extra work. The
  research expects about 17 such asks a day across projects, which will make
  the queue two or three times longer than today.
- **`request_attention`** notices: on the phone, rows above the queue in the
  sheet; on the desktop, a move plus a Back chip.

### 1.5 Reasons a render has to show

From `dismissalTypes.ts` and the Asks-you lane, with the Ukrainian words the
surfaces use today (`src/lib/i18n/uk.ts`):

| Kind | Label on a row | Inline action |
|---|---|---|
| `decision` (orchestrator's bridge ask) | «Рішення · оркестратор» (`status.awaitingDecision`) | open |
| `question` (`AskUserQuestion`) | the question's own header, else «питання» | open |
| `plan` | «затвердження плану» | open |
| `permission` | «дозвіл: ‹request›» | «Дозволити раз» / «Відхилити» |
| `ask` (new) | «Просить вас · ‹роль›» with the last sentence | open |
| `delivery` | «повідомлення не доставлено» | open |
| `launch` | «запуск не вдався: ‹reason›» | open |
| `lane-decision` | «потрібне рішення · ‹stage›» | open the card |
| `lane-review` | «бюджет ревʼю вичерпано · ‹stage›» | open the card |
| `lane-merge` | «мердж зупинено» | open the card |

Every row also has «Зняти» (Dismiss, `needs.dismiss`) on its card today; a
list surface may carry it too, since a dismissal is one route for the click
and the agent (needs-attention.md §5).

## 2. What is wrong, in one paragraph each

**The look.** Four controls in one pill, all in the loudest tone the palette
has, with uppercase tracked text, sitting in a bar whose every other control
is a quiet outlined `h-8` button (`BAR_CONTROL`, `BAR_OUTLINED`). Amber says
"something is wrong", yet most rows are routine: a lane parked for review, a
plan to approve. The pill is on screen at zero too. It is the one element in
the header that does not look like the header.

**The jump.** The count and Next are global while the board is one project.
Clicking Далі on project A can land the operator on project C with the board
rebuilt underneath, and the next N key continues a walk they did not choose.
The phone fixed this in #1439; the desktop kept the old rule.

## 3. Three directions

Each one changes the structure: where the list lives, whether "Next" exists,
and what the header shows. The styling follows from that. The renders show each in its closed
and open state on the same data (section 4).

### Option A — Here first: the chip counts this project, walks this project, and names the rest quietly

The phone's rule brought to the desktop, with the pill restyled as a bar
control.

**Desktop, closed.** In the bar's island slot, one outlined control in the bar's
own style (`BAR_CONTROL` + `BAR_OUTLINED`, `h-8`, `rounded-control`):

```
[ ● 2 чекають   +4 в інших ]  [ › ]
```

- `●` is the warning dot the Overview bar already uses (`.dot.warn`); the text
  is `text-primary` semibold, no uppercase, no tracking, no amber fill.
- `2` counts **this project's** entries (`projectEntries`).
- `+4 в інших` is `text-muted`, present only when other projects hold
  entries. It is the only cross-project signal, and it is a quiet one.
- `›` is a separate icon control with the tooltip «Наступний у цьому проєкті
  (N, Shift-N назад)». It walks `projectEntries`, the same list the N key
  walks, so the button and the key are one sequence at last.
- Zero here, some elsewhere: `[ +4 в інших ]` alone, muted, no dot, no `›`.
- Zero everywhere: a muted `0 чекають` without a border, kept for the walk
  anchor; on the Overview the control counts everything and `›` walks
  everything, because there the board *is* every project.
- The funnel (F) stays as an icon control after `›`, outlined like the rest,
  pressed state in the accent tone as the bar's other toggles (`BAR_PRESSED`).

**Desktop, open.** Clicking the count opens the same popover, grouped by
project: this project's section first and expanded, then each other project
as a section header with its count, expanded too (the whole list is rarely
over ten rows). Rows keep `AttentionQueueRow`/`AttentionLaneRow` as they are,
minus the project chip inside a section that already names it. Crowned
favourites stay on top. Clicking a row in another project switches project,
exactly as today: that click is the operator's choice.

**Phone.** No change to the bar: `⚠ 2` is already project-scoped and the
sheet's «Next ›» already stays in the project. The Overview's sheet takes the
same section headers per project.

**Why it is better.** Both complaints are answered directly: the pill stops
shouting, and Далі stops moving the operator between projects, while the
information that other projects wait is still one glance away. The key and
the button agree. It is the rule the phone has used for months, so the two
platforms finally say the same thing.

**What it costs.** One lane, one PR. `AttentionIsland.tsx` restyled and given
`hereCount`/`elsewhereCount`; `Viewer.tsx` passes `projectEntries` to the
button and groups the popover with a pure `needsYouByProject(queue, current)`
(new, ~30 lines, tested); five or six `attention.*` strings in `en`/`uk`;
`AttentionIsland.dom.test.tsx` and the Viewer's attention tests updated. While
there, the rail's `⏸ N` should read the same grouped function so the tail,
the rail and the popover sections carry one number per project (drops the
rail's `paused` and workflow counts; the doc needs-attention.md §3 already
retired `paused` as a reason).

### Option B — "Чекають на вас": a panel grouped by project, the operator chooses; no Next

The list becomes a place, and the walk goes away.

**Desktop, closed.** In the island slot, one quiet outlined toggle:

```
[ ● Чекають 5 ]
```

The count is global (the panel behind it is global too, so the number promises
nothing the click cannot show). Pressed state in the accent tone. Zero: the
control reads `Чекають 0`, muted, no dot.

**Desktop, open.** A right-hand panel, 320 px, beside the board the way the
report log sits beside the seat's chat (`data-report-log-layout="beside"`)
and the open-agents rail stands beside the columns: it takes its width from
the columns, and its open state persists per operator (`localStorage`, like `llvReportLogBeside`). Below 1280 px of board
width it drops to the popover placement it has today. Contents:

- Heading «Чекають на вас · 5».
- One section per project, the current project first and expanded, the others
  collapsed to `‹project› · 2` and expanded on click; a section remembers its
  fold.
- Rows as today, each with the reason word, the title, the age, and its
  actions inline: «Дозволити раз / Відхилити» on a permission, «Зняти» on
  every row (the same dismissal the card makes), the agent's last sentence on
  an ask.
- The row the operator is looking at (the open conversation, the focused
  card) is marked with the accent ring the board uses for focus; nothing
  advances by itself. When a row clears, it leaves the list; the panel never
  scrolls or refocuses on its own.
- No «Далі». The N key stays for keyboard users, project-scoped as it is.

**Phone.** The `⚠ n` badge opens the same sheet as today, with the sections.
Its «Next ›» is dropped for the same reason; rows are the way in. On the
Overview the sheet lists every project's sections.

**Why it is better.** The operator asked to stop being jumped. This direction
removes the mechanism that jumps: there is no cycle to follow, only a list to
read and pick from, and it stays open while they work through it. With
"Asks you" adding a dozen or more prose asks a day, a persistent list that can
be scanned and cleared beats a pill that has to be reopened per item. The
inline «Зняти» turns the panel into the place a false ask is cleared.

**What it costs.** One or two lanes. A new `AttentionPanel` component over the
existing rows and `PermissionActions`; a layout seam in `KanbanBoard` beside
`kb-body` (the seat-side branch is the template); persisted open and fold
state; `needsYouByProject` as in A; the phone sheet loses Next and gains
sections (`MobileAttentionSheet.tsx`, its test); the DOM test for the panel.
The cross-project "Next" behaviour disappears entirely, so the keyboard walk
tests lose their global cases. Width is the risk: at 1440 with the seat beside
the board and the panel open, the columns are narrow; the render should show
that state, and the panel should overlay (today's popover placement) when the
seat is beside.

### Option C — One inbox: needs-you folded into the reports log

The report log beside the orchestrator becomes the project's inbox, and the
header carries one unread count for it.

**Desktop, closed.** The island slot holds one quiet toggle that names the
inbox:

```
[ ✉ Вхідні 5 ]
```

The number is this project's open needs-you rows plus unseen report-log
entries (the log already tracks "seen" by `seq`). Zero: muted, no count.

**Desktop, open.** The toggle opens the report-log column (`ReportLog`,
`variant="column"`) whether or not the seat is open, docked to the right of
the board as in B. The column gains a pinned section on top, «Чекають · 3»:
the project's live needs-you rows (from `needsYou`, never stored), each with
its reason word, inline actions and «Зняти». Under it, the log as it is: the
orchestrator's reports and the Viewer-authored "‹agent› просить вас: ‹last
sentence›" lines the Asks-you lane adds, each with its jump link, newest
first, «нове» on what arrived since the last look. An open ask appears once,
in the pinned section, and its log line stays below as history. Other projects
are reached through the rail, whose `⏸ N` becomes the per-project inbox count;
the Overview's inbox stacks every project's pinned section.

**Phone.** The `⚠ n` badge opens the report-log screen (`variant="screen"`,
which exists) with the pinned section on top; the separate Needs-you sheet is
retired. «Next ›» goes away.

**Why it is better.** There is one place to look, and it answers "what needs
me" and "what happened" together, which is what the Asks-you lane already
half-builds by writing asks into the log. The header's amber pill becomes a
plain unread count. No cross-project jump exists because the inbox is
per-project by construction.

**What it costs.** The most. The report log has to leave the orchestrator
panel (it is mounted only inside it today, keyed by the seat's presence);
a project without a seat needs a home for the column; the log's data path is
bridge reports plus the Asks-you line kind, and the pinned section is a second
data source with different lifetimes, so the component grows two models; the
phone loses its sheet and the notices row («From your agents») has to move
into the screen; the rail count changes meaning. Two or three lanes, and it
depends on the Asks-you lane's line shape landing first. It also mixes an
action list with a history, and the operator has said nothing about wanting
the log itself changed.

## 4. Fixture for the renders

Three projects with invented names, seven rows, so both the "this project"
and the "elsewhere" states are visible and the sections are uneven. Ukrainian,
ages relative to a pinned clock.

Current project **delegatus** (3):

| Row | Kind | Title | Reason line | Age |
|---|---|---|---|---|
| 1 | `ask` | Будівельник · «Чип Чекають: 2–3 варіанти» | Просить вас · будівельник — «Скажи «го», і я змерджу #2246.» | 4 хв |
| 2 | `permission` | Оглядач · «Аудит задач дошки» | дозвіл: `Bash rm -rf .next` — Дозволити раз / Відхилити | 11 хв |
| 3 | `lane-decision` | лейн «Ліміт видимих задач» | потрібне рішення · review | 32 хв |

**shop-web** (2):

| Row | Kind | Title | Reason line | Age |
|---|---|---|---|---|
| 4 | `decision` | Оркестратор | Рішення · оркестратор — «Підняти ліміт вкладень до 100 МБ чи лишити 25?» | 1 год |
| 5 | `plan` | Будівельник · «Пошук по каталогу» | затвердження плану | 18 хв |

**tg-bot** (2):

| Row | Kind | Title | Reason line | Age |
|---|---|---|---|---|
| 6 | `lane-review` | лейн «Щоденний дайджест» | бюджет ревʼю вичерпано · implement | 2 год |
| 7 | `delivery` | Оглядач · «Мердж #88» | повідомлення не доставлено | 41 хв |

For Option C the log under the pinned section shows four entries: a `status`
report, the Viewer line for row 1 («Будівельник просить вас: Скажи «го», і я
змерджу #2246.» with its jump link), a `review_verdict`, and a `blocked` that
is row 4's ask.

States to render per option, at 1440×900 and 390×844, `uk`:

- desktop closed (board of `delegatus`, seat collapsed);
- desktop open (popover for A, panel for B, inbox column for C);
- phone closed (board of `delegatus`, the bar);
- phone open (the sheet for A and B, the screen for C).

For B, one extra desktop frame with the seat beside the board and the panel
open, to show the width question. For A, one extra desktop frame on the
Overview, where the control counts everything.

Rules for the render stage: the product's tokens only (`--color-warning`,
`--color-accent`, `--color-card`, `--color-border`, the `BAR_*` classes), no
new colour or shape, the rows drawn with `AttentionQueueRow`,
`AttentionLaneRow` and `PermissionActions` as they exist, and the bar drawn
with `ProjectBar`. A scratch route inside the repo is fine; renders go to
`~/Pictures/delegatus-review/needs-you-options/<option>/<viewport>-<state>.png`
and are never committed.

## 5. Recommendation

Build **A**. It answers both complaints with one small change, it makes the
button and the key agree, and it gives the desktop the rule the phone already
runs. Its popover grouping is what B's panel would show, so if the operator
later wants the list to stay open, B is a layout change on top of A rather
than a rewrite.

Pick **B** if the operator's real wish is to stop being walked at all and to
work from a list that stays open. It removes «Далі» altogether.

**C** is the one to choose only if the operator wants a single inbox and is
willing to change the report log's job; it is the costliest and it depends on
another lane. It is described so the render shows what "fold it into the
log" would look like, since the task named it.

Whichever is picked, two fixes ride along: the rail's `⏸ N` reads the same
per-project grouping as the header, and the document title keeps the global
count (it is the only cross-project number a background tab can show).

## 6. Checked against the requirement

- "how it looks": every option replaces the amber uppercase pill with the
  bar's own control style; the renders show it closed and open.
- "Далі/Next jumps them from project to project": A scopes it, B and C remove
  it; none moves the operator without a click on a row that names its project.
- "2-3 genuinely different options": three, each with its own answer to
  where the list lives and whether a walk exists.
- "as renders": section 4 gives the render stage its fixture, states,
  viewports and rules.
- "Asks you", "the reports log", "existing reasons": the fixture carries an
  ask, a permission, a decision, a plan, a delivery and three lane reasons;
  C is the direction that uses the log; A and B inherit the ask through the
  queue.

## Deferred — not currently justified

- **Retiring the N/Shift-N keys.** The requirement names the button and the
  jump. N is already project-scoped and stays in every option.
- **A per-project "seen" state for needs-you rows** (rows the operator has
  looked at but not cleared). Dismiss («Зняти») already exists and is the
  cleaner primitive; a second, weaker mark would be two ways to say "later".
- **Sorting the panel by reason kind** (asks, then permissions, then lanes).
  The queue's order (blocked first, oldest first) is what the card and the
  phone use; a second order for the panel is a drift waiting to happen.
- **Cross-project «Далі» on the Overview in B and C.** The Overview shows
  every project, so a walk there would not jump; it is left out only because
  B and C remove the walk everywhere and one exception is not worth its
  tests. A can keep it, since A keeps the walk.
- **Changing the report log's contents beyond what the Asks-you lane adds.**
  Only C touches the log, and only by pinning a live section above it.

## Built: option B

The operator picked B. What shipped, and where it differs from the sketch
above:

- **The control.** «● Waiting N» (`attention.chip`) in the bar's outlined
  style, pressed while the panel shows; the funnel (F) stays beside it as its
  own bar control. The count is every project's, and so is the tab title. No
  «Next» anywhere: the N key still walks the project on screen.
- **The panel.** `AttentionPanel.tsx` over the one queue, cut by
  `needsYouSections` (the project on screen first and open, the others folded
  to their count and remembered). It docks beside the board while the board's
  own pane keeps 760 px next to it (a seat open beside the board and the Tasks
  panel take their width out of that pane, which the kanban board hands the
  Viewer), and floats under the control otherwise, or when the operator picks
  floating. Open state and placement are kept per device.
- **Rows.** Each carries the role of the agent behind it (`RoleTag`: the
  open-agents rail's emblem tile and the role's name in its ink, from the
  existing `--rf-*` palette), its age, its title, the wait in the shared
  vocabulary, «Dismiss», and a permission's «Allow once / Deny».
- **Dismissal.** «Dismiss», a section's «Dismiss all», the head's «Dismiss
  all» and Undo of the last one all go through the one needs-you dismissal
  (`sendDismissal`, `POST /api/attention/dismissals`), so a row leaves the
  header, the panel, the rail, the tab title and the phone at once and the
  record is durable. A row whose cause is gone (the question answered, the
  permission decided, the lane moved on) leaves on the next poll with no
  dismissal.
- **The orchestrator's questions.** Every open `question`/`blocked` report is
  its own row, the question its title and the seat's role on it; the report
  log shows each with a tick. A tick, «Dismiss» on the row and «Dismiss» on
  the seat's card are one action (a `report` dismissal subject) on one record
  (`resolvedAsks` in the bridge log): resolved in one place is resolved in
  every place. The log dims resolved questions with a check and adds a bar:
  the open count, prev/next between open questions, «Resolve all», and «Clear
  resolved», which takes resolved rows out of this device's view. A question
  also stops asking when a directive answers it, when the operator writes to
  the seat after it, on a rotation, or after two hours; the manager filing
  another report no longer retires it, since that allowed one open question
  per project. The seat tick counts an operator's resolution as their answer
  to an owed ask.
- **Ride-alongs.** The rail's ⏸, the Overview's rows and the phone's project
  sheet count `needsYouCounts` over the same queue, so a dismissed or paused
  lane no longer counts there; the tab title keeps the global count.
- **Phone.** The ⚠ sheet drops «Next ›», gains the role tag, «Dismiss» per
  row with the receipt's Undo, «Dismiss all», and a section per project where
  it lists more than one.
- **"Asks you".** An agent that asks the operator in prose is an `ask` row.
  On the panel it carries the conversation's role (`conversationFrameRole`,
  the same tag as any other row), and its line is «asks you: ‹sentence›»,
  the agent's own sentence. On the phone that sentence gets a truncated line
  of its own above the age. «Dismiss» clears the row by its reason id, like
  any other conversation reason. An ask row offers no Allow/Deny: those
  answer only a `permission` row.
