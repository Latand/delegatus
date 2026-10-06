# A compact task card menu and overflow menus: three numbered variants

Status: design only. Nothing here ships. The prototypes run in the evidence
fixture under `?menus=1|2|3`; the product draws today's menus.

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

Each one lays out the entries the board builds today, with their own labels
and handlers (`compactMenus.prototype.model.ts`). New words are only the
section names. Three rules hold in all three:

- **No state is taller than 360 px**, on a card with one pipeline, a waiting
  card and a card holding five pipelines. The tallest state measured is
  342 px.
- **Opening a section moves nothing.** The menu is placed once, for its
  tallest state, so its top edge and its side stay where they opened and the
  row under the pointer stays under it. Where the tallest state has no room
  below the ⋯, the menu opens above it and low enough to grow down.
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

**Steadiness.** On every card of the fixture (32 to 34 cards, each where it
stands and scrolled to the bottom of the window), at 1440×900 and 1000×700,
the driver opens every section and compares the menu's corner and the pressed
row before and after: 164 openings in variant 1, 220 in variant 2 and 28 in
variant 3 at each size, the largest shift 0 px.

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

The same grammar on the other menus, uk at 1440×900 and the phone at 390×844,
at rest:

| Menu | Today | 1 | 2 | 3 |
|---|---|---|---|---|
| Column ⋯ | 215–377 × 78 | 300×56–69 | 300×88–101 | 300×56–69 |
| Conversation ⋯ | 476×277 | 300×162 | 300×187 | 300×251 |
| Board ⋯ | 256×491 | 256×138 | 256×106 | 256×321 |
| Header ⋯ | 232×437 | 232×190 | 232×190 | 232×278 |
| Phone: card sheet | 390×445 | 390×357 | 390×333 | 390×357 |
| Phone: task ⋯ | 390×401 | 390×234 | 390×388 | 390×344 |
| Phone: board menu | 390×743, scrolls | 390×484 | 390×468 | 390×484 |
| Phone: conversation menu | 390×706 | 390×372 | 390×372 | 390×460 |

In a conversation's ⋯, variant 1 keeps Full pane, Copy link and To task as
icon cells and draws "Remove from the board" as a full row with its
explanation: as a fourth cell with a cross it sat under the pane's own close
button and read as it. On the phone, "Interrupt the current turn" stays at
rest in every variant; "This turn" holds only Compact and Recheck.

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
  menu that opens above its ⋯ rests up to 85 px away from it, the room its
  tallest state needs. On the phone the sheets rise from the bottom edge, so
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

`evidence/compact-card-menu/measurements.json` holds every reading: 696 states
over today and three variants, at 1440×900, 1000×700 and 390×844, light and
dark, en and uk, with the taps, the acted checks, the steadiness tallies and
the per-row sizes of today's menus. The driver is one `describe` block in
`src/components/kanban/kanbanBoard.browser.test.tsx`:

```
CHROME_BIN=<chrome> LLV_KANBAN_BROWSER_TEST=1 LLV_COMPACT_MENUS_OUT=<dir> \
  bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "compact card menu"
```

It writes the frames (each with its variant number in a strip above the
application frame) and four contact sheets to `<dir>`; they are not committed.
It fails when any state of a card's menu is over 300×360 or scrolls, when
opening a section moves the menu or the pressed row, when a state leaves the
window or cuts a label, and when an entry is lost without a named home.
`compactMenus.prototype.model.test.ts` holds that no layout loses an entry
without naming where it went and that the resting list does not grow with the
number of pipelines. `compactMenus.prototype.test.tsx` reads the one state the
fixture cannot reach: no card of the fixture holds the orchestrator's
conversation, so the refused Hide and its reason are read from the rendered
markup.

What the product gains for this, inert outside the fixture: an `id`, a
`group` and a `note` on the board's menu entries, the menu's `kind`, and
`menuPresenter` in `kanbanMenus.tsx`, which nothing in the product sets.
