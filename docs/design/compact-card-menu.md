# A compact task card menu and overflow menus

Status: **variant 1 is built** and is the product's menu for every user. The
operator chose it on 2026-10-06. Variants 2 and 3, the `?menus=1|2|3` switch
and the prototype files are gone from the product; the comparison of the three
stays below as the record. The header's ⋯ is pending its own design and is
drawn as it was.

## What was built

| Menu | Built | Where |
|---|---|---|
| A card's ⋯ | variant 1 | `src/components/kanban/compactMenu.tsx`, laid out by `compactMenuModel.ts` |
| A column's ⋯ | variant 1 | the same |
| A conversation's ⋯ | variant 1 | the same |
| The board's ⋯ | variant 1 | `BarMenuSection` in `src/components/ProjectBar.tsx` |
| Phone: the card's long-press sheet | variant 1 | `CardSheet` in `src/components/mobile/MobileKanban.tsx` |
| Phone: the task's ⋯ | variant 1 | `src/components/mobile/MobileTaskScreen.tsx` |
| A pipeline's and a stage's menu | as they were | `compactLayout` returns `null` for them, held by a test |
| The header's ⋯ | as it was | pending its own design (icons, grouping, names) |
| Phone: a conversation's menu | variant 1 | `src/components/mobile/MobileConversationMenu.tsx`, its sections drawn by `MobileSheetFold` |
| Phone: the board menu | as it was | it holds the header's entries, so it follows the header's design |

Five things differ from variant 1 as it was drawn, each to close a note a
critic left open on it:

- **A section always opens under its own row.** A menu with no room below its
  button no longer stands above it and grows upward. It stands beside the
  button, hung from its top edge like every other state, so the rows of a
  section appear under the row that opened them wherever the card is, and a
  closed row always points down. Placement is below, else beside
  (`menuPlacement`); "above" is gone. At 1000×700, where the board is one
  column, most cards open beside.
- **What Hide leaves running is written under the cells**: "Hide: 2 agents keep
  working", or "Hide: nothing stops", or the reason a Hide is refused. What the
  ends of the priority row do is written under them: "Top of the Inbox" under
  High, "Bottom of the Inbox" under Low. In a conversation's ⋯ the line
  "To task: nothing is sent to the agent" stands under its cells. None of
  them is only a tooltip now.
- **The keys stay on the menu.** Enter, E and H are drawn in the corner of
  their cells (Enter as ↵) and named to a screen reader; I stays on the Icon
  row.
- **On the phone the cells stand at one inset from both edges** of the sheet,
  and the line about Hide is under them there too.
- **The refused Hide fits with its whole reason.** The card that holds the
  orchestrator's conversation says why it stays on the board on two lines
  under the cells. So that Appearance still opens inside 360 px there, the
  rows of a section opened in place are 28 px, as a page's are, and a swatch
  is a 22 px circle; it used to be drawn as tall as a row.

The two lines of words make the card's menu 300×280 at rest, against 300×257
as drawn; the separator between the cells and the priority row was taken out
to stay inside 360 px. With Appearance open it is 300×342 and with More open
300×340. On the card that holds the orchestrator's conversation, where the
reason takes a second line, it is 300×293 at rest and 300×355 at its tallest
(Appearance open). A pipeline's page is 300×290–342. The board's ⋯ rests at
256×192 against 256×491, and its two pages are 256×218 and 256×238. On the
phone the card's sheet is 390×376 against 390×445, the task's ⋯ is 390×270
against 390×401, and a conversation's menu rests at 390×372 against 390×706:
390×460 with "This turn" or "Close or stop" open and 390×636 with
"Conversation" open. The built measurements are in
`evidence/compact-card-menu/built.json`: 272 states, with 166 section openings
on 32 cards at each desktop size that moved nothing and covered no ⋯, and 92
double clicks that sent no write.

## The request

The operator's verdict on the interface (2026-10-06) keeps the orchestrator
conversation and the pipelines interface with its menu, and asks for the task
card's menu to become compact: it "takes the whole screen". Earlier the
operator also said the burger and three-dots menus hold too many buttons. This
lane redesigns the card's ⋯ and carries each variant's grammar to the column,
conversation, board and header menus, on desktop and phone. A pipeline's own
menu and a stage's menu stay exactly as they are (`compactLayout` returns
`null` for them, held by a test).

## Today's card menu, measured

Opened from a card holding one pipeline, at 1440×900:

| Language | Width | Height | Scrolls | Controls |
|---|---|---|---|---|
| uk | 456 px | 884 px (the window minus 16) | yes | 30 |
| en | 383 px | 884 px | yes | 30 |

At 1000×700 it is the same width and 684 px tall, again the whole window. A
card holding five pipelines has 58 controls in the same 884 px. On the phone
the card's long-press sheet is 390×445 and the task's ⋯ is 390×401; neither
scrolls.

Every entry, in order. Rows are the full menu width (442 px uk, 369 px en at
1440×900). Lines are in `src/components/kanban/KanbanBoard.tsx` on this
branch. "How often" is a judgement from the usage audit's classes
(`docs/design/interface-redesign-usage-audit.md` on its own branch, entries
W2, W3, W8, W13) and the operator's own words; there is no click telemetry.

| # | Entry | Line | Height | On the phone | How often |
|---|---|---|---|---|---|
| 1 | "Move to" heading | 1445 | 20.5 | | |
| 2–5 | Inbox, In progress, Waiting, Done | 1342 | 32 each | long-press sheet, 56 each (the three other columns) | daily |
| 6 | Set waiting reason | 1348 | 32 | task screen | weekly, only for a waiting card |
| 7 | "Priority" heading | 1423 | 20.5 | | |
| 8–10 | High, Normal, Low | 1424 | 32 each | task ⋯ → Priority, 44 | weekly |
| 11 | "Colour" heading | 1449 | 20.5 | | |
| 12 | Nine swatches | 1410 | 44 | task ⋯ → Colour, 44 | rare |
| 13 | Icon… | 1466 | 32 | none | rare; the card's own icon opens the same picker |
| 14 | Collapse card | 1453 | 32 | none | rare; the fold beside the ⋯ does the same (`KanbanCard.tsx:595`) |
| 15 | Rename | 1454 | 32 | task ⋯, 44 | weekly |
| 16 | Add or edit description | 1455 | 32 | task ⋯ → Details, 44 | weekly |
| 17 | Attach PR or issue… | 1479 | 32 | task ⋯, 44 | weekly |
| 18 | Pipeline heading (one group per pipeline) | 1435 | 20.5 | | |
| 19 | Expand stages | 1573 | 32 | pipeline screen | weekly |
| 20 | Attach PR or issue to the pipeline… | 1575 | 32 | pipeline screen | rare |
| 21 | Pause or Resume | 1576 | 32 | pipeline ⋯ | weekly |
| 22 | Retry stage | 1577 | 32 | stage controls | weekly, when a stage needs a decision |
| 23 | Skip stage | 1578 | 32 | stage controls | rare |
| 24 | Finishes the task (toggle) | 1561 | 42.4 | none | rare |
| 25 | Close pipeline | 1581 | 32 | pipeline ⋯ | rare |
| 26 | Hide from board | 1459 | 32 | sheet 70.5, task ⋯ 44 | daily |

The audit's inventory (W3) matches the code with one addition: it predates the
"Finishes the task" toggle (#2187). Previous and Next column belong to the
status chip's menu (`:1404`), which this lane leaves alone.

The other menus today, uk at 1440×900: a column's ⋯ 377×78 (In progress) and
215×78 (Done), 2 controls; a conversation's ⋯ 476×277, 7 rows of 32; the
board's ⋯ 256×491, 8 controls; the header's ⋯ 232×437, 13 controls. On the
phone: the board menu 390×743, scrolling, 29 controls; a conversation's menu
390×706, 14 controls.

## The three variants

The rest of this note is the design as it was compared, before the build. Each
variant laid out the entries the board builds, with their own labels and
handlers. New words are only the
section names. Six rules hold in all three:

- **No state is taller than 360 px**, on a card with one pipeline, a waiting
  card and a card holding five pipelines. The tallest state measured is
  342 px.
- **Opening a section moves nothing under the pointer.** The menu is placed
  once, for its tallest state, and the edge that faces its ⋯ never moves, so
  the row that was pressed stays where it was.
- **No state covers the menu's own ⋯.** Below the button while the tallest
  state fits there. Otherwise above it, with the bottom edge held: the
  resting list sits right over the button, a page grows upward, and a section
  that opens in place puts its rows above its own row. Where the tallest
  state fits on neither side, the menu stands beside the button. (The build
  replaced this rule: see "What was built".)
- **The arrow says what a row will do.** A row that replaces the list with a
  page carries the arrow to the right. A row that opens in place carries the
  arrow down (up in a menu that grows upward), and it turns over once open.
- **A double click reaches nothing.** A press that swaps the whole list for a
  page, or a page for the list, leaves another row under the pointer: "Skip
  stage" where "Pipeline actions" stood, a column where "Back" stood. A press
  on that same spot is dropped until the pointer has moved 4 px or a second
  has passed, inside the menu and outside it. A press from the keyboard is
  never dropped.
- **A card's pipelines are one row**, however many it holds. One pipeline
  opens its actions as a page; several open their list first, each row with
  the pipeline mark, its whole title and its state. A page keeps every
  action's second line, so what Close and Pause stop is read before it is
  chosen.

**1. A quick row, segments, then sections (recommended).** The four columns
are a segmented row; Rename, Describe, Attach and Hide are four icon cells;
the three priorities are a second segmented row; Appearance (colour and icon)
and More (waiting reason, collapse) open in place, one at a time; the
pipelines row opens a page. A Hide that is refused says why in a line under
the cells. Rests at **300×257**. Removes nothing from the card's menu.

**2. Drill-in pages.** Move to, Priority, Appearance and the pipelines are
rows with a chevron; choosing one replaces the list with that page and a back
row. Rename, Describe, Attach, Collapse and Hide stay as rows. Rests at
**300×315**. Removes nothing.

**3. Pruned, with the pickers in the row.** Columns and priorities are two
segmented rows; the nine colours and the icon button are one row with no
expansion; the pipelines row opens a page. Rests at **300×337**, and the page
is its only other state. It removes two entries, each to a place that already
does the same: Collapse card (the fold beside the ⋯) and Set waiting reason
(the status chip's menu, where a waiting card sets it today).

| Entry | 1 | 2 | 3 |
|---|---|---|---|
| Four columns | segmented row, at rest | Move to › | segmented row, at rest |
| Set waiting reason | More | Move to › | removed: the status chip's menu |
| Priority | segmented row, at rest | Priority › | segmented row, at rest |
| Colour | Appearance, opens in place | Appearance › | swatches in the row, at rest |
| Icon… | Appearance | Appearance › | icon button in the same row |
| Collapse card | More | row | removed: the fold |
| Rename, Describe, Attach | icon cells | rows | rows |
| Pipeline actions (7 per pipeline) | pipelines › page | pipelines › page | pipelines › page |
| Hide from board | icon cell, a refusal in words | last row | last row, with its reason |

### Measured, every state

Identical in light and dark and at 1440×900 and 1000×700; a range is en to
uk. All states stay inside the window, none scrolls and none cuts a label,
including the longest Ukrainian ones; the driver fails otherwise.

A card holding one pipeline (`t-links`); a waiting card with a pipeline
(`t-limits`) measures the same in every cell:

| State | Today | 1 | 2 | 3 |
|---|---|---|---|---|
| At rest | 383–456 × 684–884, scrolls | 300×257 | 300×315 | 300×337 |
| Move to open | | at rest | 300×187 | at rest |
| Priority open | | at rest | 300×131 | at rest |
| Appearance open | | 300×341 | 300×117 | at rest |
| Pipeline page | | 300×303–328 | 300×303–328 | 300×303–328 |
| More open | | 300×327 | | |
| Card at the bottom or right edge, at rest | 884, scrolls | 300×257 | 300×315 | 300×324 |
| The same, pipeline page | | 300×290–303 | 300×290–303 | 300×290–303 |

A card holding five pipelines (`t-many`):

| State | Today | 1 | 2 | 3 |
|---|---|---|---|---|
| At rest | 383–423 × 684–884, scrolls | 300×257 | 300×315 | 300×324 |
| Appearance open | | 300×341 | 300×117 | at rest |
| More open | | 300×327 | | |
| The list of pipelines | | 300×286 | 300×286 | 300×286 |
| One pipeline's page (five read) | | 300×303–342 | 300×303–342 | 300×303–342 |

**Steadiness and the ⋯.** On every card of the fixture (32 to 34 cards, each
where it stands and scrolled to the bottom of the window), at 1440×900 and
1000×700, the driver opens every section, and every pipeline of a card that
holds several, and compares the pressed row and the edge of the menu that
faces the ⋯ before and after: 174 and 170 openings in variant 1, 230 and 230
in variant 2, 38 and 38 in variant 3, the largest shift 0 px. In each of
those states and at rest it also checks that the menu does not lie over its
own ⋯: 0 cases. At 1440×900 about two menus in three open below the button
and one in three above it; at 1000×700, where the board is one column, all of
them open above it.

**Double clicks.** On every card of the fixture at both sizes the driver
double-clicks each row that opens a page and each page's back row with a real
pointer: 38 double clicks in variants 1 and 3 and 230 in variant 2 at each
size, 14 of the cards holding a pipeline. Every second press was dropped, the
menu stayed on the page the first press opened, and the fixture's server
received no write: no pipeline action, no task change, no board move. With
the guard switched off the same pass fails on the first card: a pipeline write
goes out for `t-links`. The board's and the header's pages get the same pass
(16, 48 and 8 double clicks in variants 1, 2 and 3; no switch flipped).

### Taps to eight frequent actions

Counted from the closed menu, the ⋯ included.

| Action | Today | 1 | 2 | 3 |
|---|---|---|---|---|
| Move to Done | 2 | 2 | 3 | 2 |
| Move to Waiting | 2 | 2 | 3 | 2 |
| Hide from board | 2 + scroll | 2 | 2 | 2 |
| Rename | 2 | 2 | 2 | 2 |
| Description | 2 | 2 | 2 | 2 |
| Priority High | 2 | 2 | 3 | 2 |
| Colour | 2 | 3 | 3 | 2 |
| Pause the pipeline | 2 (2 + scroll at 1000×700) | 3 | 3 | 3 |

On a card with several pipelines, Pause is four taps in every variant: the ⋯,
the pipelines row, the pipeline, Pause. The pipeline's own ⋯ on the card is
unchanged and stays at two.

On one frame per variant the driver also carries out a colour, a priority, a
move and a hide through the menu and reads each back from the board, then
walks the menu with the arrow keys and checks that Escape returns focus to
the ⋯.

### The family

The same grammar on the other menus. A section opens in place where the menu
then stays inside its bound, and as a page where it would not; variant 2 opens
every section as a page. The bound is 360 px on the desktop, and on the phone
today's height of the same sheet, with nothing scrolling. The driver fails on
either. Sizes are identical at 1440×900 and 1000×700 and in light and dark; a
range is en to uk. "page" marks a state that replaces the list.

Desktop:

| Menu | State | Today | 1 | 2 | 3 |
|---|---|---|---|---|---|
| Column ⋯ | In progress | 346–376×78 | 300×69 | 300×101 | 300×69 |
| | Done | 215–218×78 | 300×56 | 300×88 | 300×56 |
| Conversation ⋯ | at rest | 428–476×277 | 300×162 | 300×187 | 300×251 |
| | More | | 300×335 | | |
| | Task link | | | page 300×127 | |
| | Close or stop | | | page 300×127–140 | |
| Board ⋯ | at rest | 256×440–491 | 256×170 | 256×138 | 256×300–321 |
| | Sound | | at rest | page 256×110 | at rest |
| | Merging and syncing | | page 256×178–214 | page 256×178–214 | at rest |
| | Orchestrator | | page 256×221–236 | page 256×221–236 | at rest |
| | Rarely used | | | | 256×332–353 |
| Header ⋯ | at rest | 232×437 | 232×190 | 232×190 | 232×278 |
| | This device | | 232×308 | page 232×163 | at rest |
| | Guides | | 232×310 | page 232×165 | |
| | Installation | | 232×280 | page 232×135 | |
| | Rarely used | | | | page 232×225 |

The board's four project switches with their explanations were one section,
"Project rules", 444–495 px tall once open in variant 1 and 403 px as a page
in variant 2. They are two sections now: "Merging and syncing" (merge when
review passes, share with linked machines) and "Orchestrator" (its reports,
"Asks you"). In variant 3 the header's "Rarely used" was 458 px open in
place and is a page.

Phone, 390×844:

| Sheet | State | Today | 1 | 2 | 3 |
|---|---|---|---|---|---|
| Card, long press | at rest | 390×445 | 390×343–357 | 390×333 | 390×343–357 |
| | Move to | | at rest | page 390×308 | at rest |
| Task ⋯ | at rest | 390×401 | 390×234 | 390×388 | 390×344 |
| Board menu | at rest | 390×743, scrolls | 390×484 | 390×468 | 390×528 |
| | New… | | at rest | page 390×252 | at rest |
| | View and places | | page 390×384 | page 390×384 | at rest |
| | This device | | 390×593 | page 390×229 | at rest |
| | Project rules | | page 390×451–466 | page 390×451–466 | page 390×369–384 |
| | Guides | | 390×660 | page 390×296 | |
| | Installation | | 390×660 | page 390×296 | |
| | Rarely used | | | | page 390×669 |
| Conversation menu | at rest | 390×706 | 390×372 | 390×372 | 390×460 |
| | This turn | | 390×460 | page 390×244 | at rest |
| | Conversation | | 390×636 | page 390×420 | |
| | Close or stop | | 390×460 | page 390×244 | |
| | Rarely used | | | | page 390×420 |

No phone state scrolls. In variant 3 the board menu's "Rarely used" held
nineteen rows and scrolled; the project's switches and its archive rows are
their own page, "Project rules", and the rest is the "Rarely used" page.

In a conversation's ⋯, variant 1 keeps Full pane, Copy link and To task as
icon cells and draws "Remove from the board" as a full row with its
explanation: as a fourth cell with a cross it sat under the pane's own close
button and read as it. On the phone, "Interrupt the current turn" stays at
rest in every variant; "This turn" holds only Compact and Recheck. As built,
the rows at rest keep the order they had (the pinned message, the background
tasks, the seat, the pipeline, what needs the operator, Reports, Interrupt),
"Conversation" holds Rename, Crown, Hand off, the earlier round, Details and
host, Open in terminal and the project's menu, "Close or stop" holds Close
card and Stop host, and a conversation's subagents are one more row that opens
in place and says how many it holds.

Removed by name in the family:

| Entry | Variants | Its other home |
|---|---|---|
| A column's "Show hidden", where the column has another row | 1, 3 | the Hidden pill in the board's header opens the same tray |
| Phone task ⋯: "Board menu" | 1, 3 | the ⋯ on the board itself, one Back away |
| A conversation's Unlink, while there is no link of the operator's own | 3 | it returns with the link |
| Phone conversation menu: Reports | 3 | the Reports control in the conversation's header |

Search is not removed anywhere. The phone's conversation menu has a Search
row in its component (`MobileConversationMenu.tsx:353`), and the one place
that mounts the conversation screen passes it no search handler
(`ProjectDashboard.tsx:2483`), so the product does not draw that row today and
no frame can show it; all three variants keep it at rest for the day it is
drawn.

## Costs

- **1**: colour and a pipeline's actions go from two taps to three.
  Appearance and More still grow the menu in place, to 341 px at most. Four
  icon cells need their captions to be read; in Ukrainian the captions are
  short forms ("Назва", "Опис"), and the keys Enter, E and H move into the
  cells' tooltips.
- **2**: every move between columns costs a third tap, and moving is the most
  frequent action in the menu. The page swap hides the other choices.
- **3**: the widest change in behaviour: two entries leave the menu. It is the
  tallest at rest. The colours are 20 px targets with no label beside them.
- **All three**: a pipeline's page is the densest state, its rows closer than
  the board's own so seven actions keep their second lines inside 360 px. A
  menu that opens above its ⋯ grows upward, so a section opened in place
  there shows its rows above its own row, the reverse of the same menu
  opened below a button. A deliberate second press on the very spot of a row
  that just opened a page waits out one second. A family menu mixes rows that
  open in place with rows that open a page, told apart by the arrow. On the
  phone the sheets rise from the bottom edge, so
  a section opened in place still lifts the rows above it; only the desktop
  menus are held still. The family prototype re-orders the product's own rows
  in place, so it shows layout and reach; a build would move the grouping
  into each menu's own component.

## Recommendation

**Variant 1, as drawn.** It is the smallest at rest (300×257 against
456×884), keeps six of the eight frequent actions at two taps, takes Hide out
from under a scroll and removes nothing from the card's menu, so no habit
breaks. It already holds what the first round of this note recommended taking
from the others: priorities as segments (from 3), one pipelines row that opens
a page (from 2), and the two prunings of the family with a visible second home
(the column's "Show hidden", the phone task's "Board menu").

## Evidence

`evidence/compact-card-menu/measurements.json` is the design's record: 706
states over the menus as they were and the three variants, at 1440×900,
1000×700 and 390×844, light and dark, en and uk, with the taps, the acted
checks, the steadiness and double-click tallies and the per-row sizes of the
old menus. The prototype that produced it is no longer in the tree.

`evidence/compact-card-menu/built.json` is the build's record, written by one
`describe` block in `src/components/kanban/kanbanBoard.browser.test.tsx`:

```
CHROME_BIN=<chrome> LLV_KANBAN_BROWSER_TEST=1 LLV_COMPACT_MENUS_OUT=<dir> \
  bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "compact card menu"
```

It writes the frames and two comparison sheets to `<dir>`; they are not
committed. For the menus as they were, the same block runs first over an
export of the merge base with `LLV_COMPACT_MENUS_SIDE=today` and the same
`<dir>`; the built run then compares against those readings and lays both on
the sheets.

It fails when any state of a card's menu is over 300×360 or scrolls; when any
state of a column's, a conversation's or the board's menu is over 360 px tall
or scrolls; when the card's sheet or the task's menu on the phone is taller
than it was or scrolls; when opening a section moves the pressed row or the
menu's top edge; when any state lies over its own ⋯; when the rows of a
section opened in place are not under its row, or a closed row carries the
arrow of an open one; when the line under the Hide cell or the two under the
priority row are missing or cut; when the phone's cells stand at different
insets; when a double click on a row that opens a page, or on a back row,
sends a write or lands on another row; when a state leaves the window or cuts
a label; when an entry of the old card or conversation menu is not in the
built one; when the card that holds the orchestrator's conversation does not
say in full why its Hide is refused, or any state of its menu is over 300×360
or scrolls; when a state of the phone's conversation menu is taller than the
sheet was, scrolls, cuts a label, hides Interrupt behind a section or loses a
row the sheet had; and when the header's ⋯ or the phone's board menu measures
differently from before.

`compactMenuModel.test.ts` holds that the layout loses no entry, that the
resting list does not grow with the number of pipelines, and that no placement
puts the tallest state over the button or outside the window, for a button
anywhere in either desktop window. `compactMenu.test.tsx` reads the first
render as markup: the line under the cells, the keys, the arrows.
