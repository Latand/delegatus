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
section names.

**1. A quick row, then sections that open in place.** The four columns are a
segmented row; Rename, Describe, Attach and Hide are four icon cells; Priority,
Appearance (colour and icon), the pipeline and More (waiting reason, collapse)
are named rows showing the current value, and one opens at a time. Rests at
**300×253**. Removes nothing.

**2. One level of drill-in.** Move to, Priority, Appearance and the pipeline
are rows with a chevron; choosing one replaces the list with that page and a
back row. Rename, Describe, Attach, Collapse and Hide stay as rows. Rests at
**300×315** and never passes 360 px. Removes nothing.

**3. Pruned, with inline pickers.** Columns and priorities are two segmented
rows; Appearance opens in place; the pipeline drills in. Rests at **288×339**.
It removes two entries, each to a place that already does the same: Collapse
card (the fold beside the ⋯) and Set waiting reason on a card that does not
wait (it returns when the card is in Waiting, and stays in the status chip's
menu).

| Entry | 1 | 2 | 3 |
|---|---|---|---|
| Four columns | segmented row, at rest | Move to › | segmented row, at rest |
| Set waiting reason | More | Move to › | row, only while waiting |
| Priority | Priority, opens in place | Priority › | segmented row, at rest |
| Colour | Appearance, opens in place | Appearance › | Appearance, opens in place |
| Icon… | Appearance | Appearance › | Appearance |
| Collapse card | More | row | removed: the fold |
| Rename, Describe, Attach | icon cells | rows | rows |
| Pipeline actions (7) | pipeline, opens in place | pipeline › | pipeline › |
| Hide from board | icon cell | last row | last row, with its reason |

### Measured, every state

Identical in light and dark and at 1440×900 and 1000×700 unless a range is
given (the range is en to uk). All states stay inside the window and cut no
label, including the longest Ukrainian ones; the driver fails otherwise.

| State of the card menu | Today | 1 | 2 | 3 |
|---|---|---|---|---|
| At rest | 383–456 × 684–884, scrolls | 300×253 | 300×315 | 288×339 |
| Move to open | | at rest | 300×213 | at rest |
| Priority open | | 300×355 | 300×149 | at rest |
| Appearance open | | 300×337 | 300×131 | 288×423 |
| Pipeline open | | 300×496 | 300×332–358 | 288×400–413 |
| More open | | 300×323 | | |
| Card at the bottom or right edge, at rest | 884, scrolls | 300×253 | 300×315 | 288×326 |
| The same, pipeline open | | 300×496 | 300×319–332 | 288×374–387 |
| A card holding five pipelines, at rest | 423×884, scrolls | 300×389 | 300×360, scrolls | 288×466 |

### Taps to eight frequent actions

Counted from the closed menu, the ⋯ included.

| Action | Today | 1 | 2 | 3 |
|---|---|---|---|---|
| Move to Done | 2 | 2 | 3 | 2 |
| Move to Waiting | 2 | 2 | 3 | 2 |
| Hide from board | 2 + scroll | 2 | 2 | 2 |
| Rename | 2 | 2 | 2 | 2 |
| Description | 2 | 2 | 2 | 2 |
| Priority High | 2 | 3 | 3 | 2 |
| Colour | 2 | 3 | 3 | 3 |
| Pause the pipeline | 2 (2 + scroll at 1000×700) | 3 | 3 | 3 |

On one frame per variant the driver also carries out a colour, a priority, a
move and a hide through the menu and reads each back from the board, then
walks the menu with the arrow keys and checks that Escape returns focus to
the ⋯.

### The family

The same grammar on the other menus, uk at 1440×900 and the phone at 390×844,
at rest:

| Menu | Today | 1 | 2 | 3 |
|---|---|---|---|---|
| Column ⋯ | 215–377 × 78 | 300×88–101 | 300×88–101 | 288×56–69 |
| Conversation ⋯ | 476×277 | 300×107 | 300×187 | 288×251 |
| Board ⋯ | 256×491 | 256×138 | 256×106 | 256×321 |
| Header ⋯ | 232×437 | 232×190 | 232×190 | 232×278 |
| Phone: card sheet | 390×445 | 390×357 | 390×333 | 390×357 |
| Phone: task ⋯ | 390×401 | 390×278 | 390×388 | 390×344 |
| Phone: board menu | 390×743, scrolls | 390×484 | 390×468 | 390×484 |
| Phone: conversation menu | 390×706 | 390×328 | 390×328 | 390×460 |

Variant 3 also removes, by name: a column's "Show hidden" row where the column
has another row (the Hidden pill in the board's header opens the same tray); a
conversation's Unlink while there is no link of the operator's own to take
off; on the phone, Reports and Search from a conversation's menu (both have a
control in the header) and "Board menu" from the task's ⋯ (the board's own ⋯
is one Back away).

## Costs

- **1**: Priority, colour and pipeline actions go from two taps to three. A
  section opening in place makes the menu grow, up to 496 px with the pipeline
  open. Four icon cells need their captions to be read; in Ukrainian the
  captions are short forms ("Назва", "Опис"). On the phone, Interrupt moves
  behind "This turn".
- **2**: every move between columns costs a third tap, and moving is the most
  frequent action in the menu. The page swap hides the other choices. It is
  the only variant that holds 360 px with five pipelines, by scrolling.
- **3**: the widest change in behaviour: two entries leave the menu, and a
  waiting reason appears and disappears with the card's column. It is the
  tallest at rest and passes 360 px with Appearance or a pipeline open.
- **All three**: a card with several pipelines grows by one row per pipeline;
  five pipelines put 1 and 3 over 360 px at rest. The family prototype
  re-orders the product's own rows in place, so it shows layout and reach; a
  build would move the grouping into each menu's own component.

## Recommendation

**Variant 1.** It is the smallest at rest (300×253 against 456×884), keeps the
five most frequent actions at two taps, takes Hide out from under a scroll and
removes nothing, so no habit breaks. From variant 2 take the drill-in for a
card's pipelines once it holds more than one: a single "Pipelines" row keeps
the resting height at 253 px however many lanes a task collects. From variant
3 take the two prunings of the family that have a visible second home (the
column's "Show hidden", the phone task's "Board menu").

## Evidence

`evidence/compact-card-menu/measurements.json` holds every reading: 560 states
over today and three variants, at 1440×900, 1000×700 and 390×844, light and
dark, en and uk, with the taps, the acted checks and the per-row sizes of
today's menus. The driver is one `describe` block in
`src/components/kanban/kanbanBoard.browser.test.tsx`:

```
CHROME_BIN=<chrome> LLV_KANBAN_BROWSER_TEST=1 LLV_COMPACT_MENUS_OUT=<dir> \
  bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "compact card menu"
```

It writes the frames (each with its variant number in a strip above the
application frame) and four contact sheets to `<dir>`; they are not committed.
`compactMenus.prototype.model.test.ts` holds that no layout loses an entry
without naming where it went.

What the product gains for this, inert outside the fixture: an `id` and
`group` on the board's menu entries, the menu's `kind`, and `menuPresenter` in
`kanbanMenus.tsx`, which nothing in the product sets.
