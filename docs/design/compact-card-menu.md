# A compact task card menu and overflow menus: three numbered variants

Status: design only. Nothing here ships. The prototypes run in the evidence
fixture under `?menus=1|2|3`; the product draws today's menus.

Decided 2026-10-06: the card menu is variant 1 and a separate lane builds it;
see "Operator decision 2026-10-06" and "The header's menu" at the end, which
is the open question of this note now.

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
  state fits on neither side, the menu stands beside the button
  (`menuPlacement` in `compactMenus.prototype.model.ts`).
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

`evidence/compact-card-menu/measurements.json` holds every reading: 706 states
over today and three variants, at 1440×900, 1000×700 and 390×844, light and
dark, en and uk, with the taps, the acted checks, the steadiness and
double-click tallies, the side of the button each card menu opened on and the
per-row sizes of today's menus. The driver is one `describe` block in
`src/components/kanban/kanbanBoard.browser.test.tsx`:

```
CHROME_BIN=<chrome> LLV_KANBAN_BROWSER_TEST=1 LLV_COMPACT_MENUS_OUT=<dir> \
  bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "compact card menu"
```

It writes the frames (each with its variant number in a strip above the
application frame) and four contact sheets to `<dir>`; they are not committed.
It fails when any state of a card's menu is over 300×360 or scrolls; when any
state of a column's, a conversation's, the board's or the header's menu is
over 360 px tall or scrolls; when any state of a phone sheet is taller than
today's sheet or scrolls; when opening a section moves the pressed row or the
edge that faces the ⋯; when any state lies over its own ⋯; when a double
click on a row that opens a page, or on a back row, sends a write or lands on
another row; when a row that opens in place and a row that opens a page carry
the same arrow; when a state leaves the window or cuts a label; and when an
entry is lost without a named home.
`compactMenus.prototype.model.test.ts` holds that no layout loses an entry
without naming where it went, that the resting list does not grow with the
number of pipelines, and that no placement puts the tallest state over the
button, for a button anywhere in either desktop window. `compactMenus.prototype.test.tsx` reads the one state the
fixture cannot reach: no card of the fixture holds the orchestrator's
conversation, so the refused Hide and its reason are read from the rendered
markup.

What the product gains for this, inert outside the fixture: an `id`, a
`group` and a `note` on the board's menu entries, the menu's `kind`, and
`menuPresenter` in `kanbanMenus.tsx`, which nothing in the product sets.

## Operator decision 2026-10-06

The operator's words, verbatim (Ukrainian and Russian, a voice transcript):

> Меню картки: варіант 1. Сайдбар: варіант 1. Будуй. Единственное, что я бы хотел добавить, это... значит, мне нравятся варианты там, где, да, там где иконки, там где оно так выпадает, и по header меню мне нужно переделать там немножко. Там, как бы, тоже нужна иконки, так. Группировка, и переделать название кнопок, потому что там, где налаштування сейчас, там вообще не налаштування. То есть надо подумать, как это переделать, чтобы было более продуктово, правильно.

What follows from it:

- **The card menu is variant 1.** A separate build lane turns it into the
  product from commit `1890bdbb7` of this branch. This branch changes nothing
  more in the card's, the board's, a conversation's, a pipeline's or a stage's
  menu, and leaves variants 2 and 3 as they are; the build lane removes them.
  The review finding about variant 3 hiding the explanations under the project
  switches is moot with it and stays unfixed.
- **The header's menu gets its own round**, below: icons, rows that open in
  place, and a new grouping and naming, because the entry called Settings
  holds no settings.

### The operator's addition, 2026-10-06 about 14:50 Kyiv

Said in the seat chat after the header variants were shown; verbatim
(Russian, a voice transcript):

> у нас там дизайн под старый интерфейс, я так понимаю, а новый — вот эта менюшка, которую мы переделаем, оно затронет его. Но в любом случае, там это должно быть как-то изображено красиво… С точки зрения того, как оно выглядит в презентации… Просто надо объединить потом эти подходы, которые новые переделки, которые сейчас делаются… меню шапки.

He means the shared memory block that merged that morning (#2536) into the
dialog behind the header menu's Settings entry. It was designed for today's
layout, and the regrouping decides where it lives. So each variant below
gives shared memory a deliberate home; see "Shared memory's home".

## The header's menu

The ⋯ in the app header (the project rail's header on the desktop). On the
phone the same entries are rows of the board menu's sheet; the language, the
QR code and the notification bell are three buttons in the header of the
phone's project drawer (`src/components/ProjectRail.tsx:198`) and are in no
menu there.

### Inventory: what is in it today

Desktop lines are in `src/components/ProjectRail.tsx`, phone lines in
`src/components/ProjectDashboard.tsx`. Today the menu is 232×437 with 13
controls and no icon; the phone's sheet is 390×743 and scrolls. "How often" is
read from the code and the interface; there is no click telemetry.

| # | Entry today (uk / en) | Desktop | Phone | What it really does | Kind, and how often |
|---|---|---|---|---|---|
| 1 | Мова: Українська / Language: English | 429 | drawer header | Switches the interface language of this browser | a browser preference; once |
| 2 | Відкрити на телефоні (QR) / Open on phone (QR) | 435 | drawer header | Shows a QR code and a link that sign a phone in to this installation | access; rare, once per phone |
| 3 | Сповіщення: вимкнені / Notifications: off | 439 | drawer header | Turns push notifications on or off for this browser | a browser preference; once |
| 4 | Посібник із налаштування / Setup guide | 445 | 2112 | Reopens the first-run guide | help; rare |
| 5 | Екскурсія інтерфейсом / Interface walk | 453 | 2112 | Starts the guided walk over the interface | help; rare |
| 6 | Призначення агентів / Agent mapping | 461 | 2112 | The table "Who does what": engine, model and effort for each role, read by every pipeline and role-based spawn | an installation setting; weekly for an operator who tunes the engine mix |
| 7 | Диктування / Dictation | 469 | 2112 | Chooses what transcribes dictated speech, a local model or a service | an installation setting; rare |
| 8 | Налаштування / Settings | 477 | 2113 | A dialog titled Settings (`src/components/telemetry/TelemetrySettings.tsx:49`) that holds the six things listed as 8a–8f | see each |
| 8a | The notice about the daily ping, and the switch "Анонімний пінг встановлення / Anonymous install ping" | dialog, `TelemetrySettings.tsx:51` | the same dialog | Turns off the daily ping of a random id, version and OS to delegatus.org | an installation privacy switch; once. The paragraph with its environment variables opens the dialog today, above memory; it belongs behind an entry named for the ping, as that dialog's whole body |
| 8b | "Ключ OpenRouter / OpenRouter key": whether a key is present and from where, a field and "Save key" (`src/components/asks/OpenRouterKeySetting.tsx:39`) | dialog | the same dialog | Stores the one installation key that "Asks you" and shared memory both call the provider with | an installation credential; once, and again when memory reports no key |
| 8c | The switch "Спільна пам’ять для цього проєкту / Shared memory for this project" (`src/components/memory/MemorySetting.tsx:44`) with its one-line explanation | dialog | the same dialog | Lets Jev pick relevant memory for each operator message in this project and hand it to the agent | a per-project rule; once per project |
| 8d | The status line (`MemorySetting.tsx:50`): "Injection can run…", or the reason it cannot: off for this project, no OpenRouter key, the monthly cap reached, another release serves traffic | dialog | the same dialog | Says whether memory is being injected now and what blocks it | a state to read; whenever memory seems silent |
| 8e | The month's counters, one sentence (`MemorySetting.tsx:51`): decisions made, turns that received memory, prepared offers, without candidates, without a match, skipped, failed; for the whole installation | dialog | the same dialog | Shows what memory did this month | a report; weekly while memory is new |
| 8f | "Спільний бюджет Jev / Shared Jev budget": spent of the cap this month (`MemorySetting.tsx:52`) | dialog | the same dialog | The spend that also stops memory at the cap | a report |
| 9 | Пов’язані інсталяції / Linked installs | 479 | 2114 | Pairs this installation with another and chooses the shared projects | an installation setting; rare |
| 10 | Зовнішній ретранслятор / External relay | 482 | 2115 | Lets a relay service bring questions from its chats, each answered by a one-shot agent | an installation setting; rare |
| 11 | Оновлення / Update | 485 | 2116 | The update dialog: automatic updates on or off, check now, apply | an installation action; weekly, and after every merge for an operator who deploys by hand |
| 12 | Активність / Activity | 494 | 2093 | A link to `/activity`: the operator's time and the agents' time per day and per project | a link to a report; weekly |
| 13 | Команда / Team | 502 | 2094 | A link to `/team`: members, who did what, sessions, invitations | people and access; rare |
| 14 | Вийти · name / Sign out · name | 509 | Team page | Ends this browser's member session; drawn only for a signed-in member | a session action that ends access; rare |

The phone's board menu also holds two device rows the desktop keeps in the
board's ⋯ and the header variants group with the rest: "Звукові сповіщення /
Sound alerts" (2100) and "Не гасити екран / Keep screen awake" (2110).

**What sits under "Settings" that is no setting, and where the settings
are.** The entry called Settings opens a privacy choice about a daily ping, a
provider key, and the shared memory of one project with its state and its
month's numbers. A person looking for memory has no word in the menu to find
it by, and a person opening Settings finds none of the things that word
promises. The things a person does call settings stand elsewhere
under other words: the table of roles and models and the choice of the
dictation engine are listed among the guides, between "Setup guide" and
"Interface walk", because the first-run guide happens to own their dialogs;
the language and the notifications lead the menu with no name over them;
linking installs, the relay and the update follow "Settings" as its equals.
The menu has one rule in thirteen rows, and it separates the three controls
that are buttons from the ten that are text.

### Three variants of grouping and naming

The look is the chosen card menu's and is the same in all three: every row
leads with an icon, a group is a row with a count and an arrow, a group opens
in place below its own row (the arrow down, turning up once open), and a group
that would pass 360 px opens as a page with a back row (the arrow to the
right). The panel keeps its 232 px. What differs is which group an entry sits
in and what the group and the entry are called.

**1. Whose it is / Чиє це.** A group is named after what a change in it
touches: this browser, this installation, the people who can get in. What is
opened to read (the time report, an update, help) stays outside the groups.

**2. What I came to do / Що я хочу зробити.** The three places opened most
are icon cells at the top; the rest is grouped by the job at hand: set up the
agents, connect something, tune language and alerts, learn the product. What
the Settings dialog holds becomes a group named for the one thing its
switches share: what leaves this machine.

**3. Settings that are settings / Справжні «Налаштування».** The word
Settings stays and becomes true: one page holds every switch and table of
this browser and this installation, each under a name that says what it sets.
The first level is only places to go: the time report, the team, the phone,
the update, help.

Groups (uk / en) and what each holds:

| Variant | At rest | Groups |
|---|---|---|
| 1 | Активність, Оновлення, Спільна пам’ять (with its state), Ключ OpenRouter | **Цей браузер / This browser** (on the phone **Цей пристрій / This device**): language, notifications; on the phone sound alerts and keep awake. **Ця інсталяція / This installation**: roles table, dictation, linked installs, relay, the ping (opens as a page). **Люди й доступ / People and access**: team, open on phone, sign out. **Довідка / Help**: setup guide, interface walk |
| 2 | cells Активність · Команда · Оновлення; Sign out | **Агенти й голос / Agents and voice**: roles table, dictation. **Підключення / Connections**: open on phone, linked installs, relay. **Мова й сповіщення / Language and alerts** (on the phone **Звук і екран / Sound and screen**). **Що йде назовні / What leaves here** (its row carries memory's state): shared memory, the OpenRouter key, the ping. **Як користуватися / How to use it**: setup guide, interface walk |
| 3 | Звіт про час, Команда й сеанси, Відкрити на телефоні, Оновлення; Sign out | **Налаштування / Settings** (a page): language, notifications, sound alerts and keep awake on the phone, shared memory (with its state), the OpenRouter key, roles table, dictation, linked installs, relay, the ping; its row carries memory's state. **Довідка й навчання / Help and learning**: setup guide, interface walk |

Renamed buttons, old name → new name:

| Entry | 1 | 2 | 3 |
|---|---|---|---|
| Налаштування / Settings (the ping's side of the dialog) | Приватність / Privacy | Анонімний пінг / Install ping | Анонімний пінг / Install ping |
| no entry today (the memory block of the same dialog) | Спільна пам’ять / Shared memory | the same | the same |
| no entry today (the key row of the same dialog) | Ключ OpenRouter / OpenRouter key | the same | the same |
| Призначення агентів / Agent mapping | Агенти для ролей / Agents by role | Хто що робить / Who does what (the dialog's own heading) | Ролі: рушій і модель / Roles: engine and model |
| Диктування / Dictation | Розпізнавання мовлення / Speech recognition | Голосове введення / Voice input | unchanged |
| Пов’язані інсталяції / Linked installs | Пов’язані комп’ютери / Linked machines | Інші інсталяції / Other installs | unchanged |
| Зовнішній ретранслятор / External relay | Питання з чатів / Questions from chats | Зовнішні чати / Outside chats | Ретранслятор чатів / Chat relay |
| Відкрити на телефоні (QR) / Open on phone (QR) | Відкрити на телефоні / Open on phone (the icon is the QR code) | the same | the same |
| Активність / Activity | unchanged | unchanged | Звіт про час / Time report |
| Команда / Team | unchanged | unchanged | Команда й сеанси / Team and sessions |

A build renames the dialog with its entry: the dialog behind "Settings" is
titled Settings today, and its notice says "Turn off in Settings"
(`bin/telemetry-notice.mjs`).

Where every entry is. "rest" is the first level; a name is the group that
holds it. Nothing leaves the menu in any variant, no entry moves to another
surface, and every entry opens the dialog, sheet or page it opens today.

| Entry | Today | 1 | 2 | 3 |
|---|---|---|---|---|
| Language | rest | This browser | Language and alerts | Settings |
| Open on phone | rest | People and access | Connections | rest |
| Notifications | rest | This browser | Language and alerts | Settings |
| Setup guide | rest | Help | How to use it | Help and learning |
| Interface walk | rest | Help | How to use it | Help and learning |
| Roles table (Agent mapping) | rest | This installation | Agents and voice | Settings |
| Dictation | rest | This installation | Agents and voice | Settings |
| The Settings dialog, opened at the ping | rest | This installation | What leaves here | Settings |
| Shared memory (today a block of the Settings dialog) | no entry of its own | rest, with its state; opens its page | What leaves here, with its state | Settings, with its state |
| The OpenRouter key (today a row of the Settings dialog) | no entry of its own | rest, beside memory | What leaves here | Settings |
| Linked installs | rest | This installation | Connections | Settings |
| External relay | rest | This installation | Connections | Settings |
| Update | rest | rest | rest, a cell | rest |
| Activity | rest | rest | rest, a cell | rest |
| Team | rest | People and access (on the phone a row at rest: the group holds one row there) | rest, a cell | rest |
| Sign out | rest, for a member | People and access | rest, last | rest, last |
| Phone: sound alerts, keep awake | rest | This device | Sound and screen | Settings |

Taps from the closed menu: today every entry is two (the ⋯, the row) and the
phone's rows are under a scroll. In each variant an entry at rest is two and
an entry in a group is three.

### Measured

Identical at 1440×900 and 1000×700, in light and dark and in both languages
unless a range is given. No state scrolls, leaves the window or cuts a label,
and opening a group in place moves its own row by 0 px. "page" marks a state
that replaces the list.

Desktop, the header's ⋯ (232 px wide):

| State | Today | 1 | 2 | 3 |
|---|---|---|---|---|
| At rest | 437, 13 controls | 268 | 229 | 211 |
| Tallest group open | | 344 (This browser) | 337 (What leaves here) | page 349 (Settings) |
| Other groups open | | 328–340; page 195 (This installation) | 289–331 | 271 |
| Memory page; with More | | 177–282; 340 at most | the same | the same |
| Key page | | 100–126 | the same | the same |

Phone, the board menu's sheet (390 px wide). Its board rows keep the chosen
variant 1 layout; the header's rows take the header variant.

| State | Today | 1 | 2 | 3 |
|---|---|---|---|---|
| At rest | 743, scrolls, 29 controls | 704 | 632 | 572 |
| Tallest open state | | at rest (every group is a page) | 720 | 660 (Help and learning) |
| Pages | | 208–340 | 229–252 | 537 (Settings) |
| Memory page; key page | | 292–434; 206–232 | the same | the same |

In each variant the driver also presses the entry today called Settings under
its new name and checks that the product's own dialog opens.

### Shared memory's home

A read-only critique of today's memory surfaces arrived after the first round
(its frames and measurements are in the handoff folder `memory-ui`). Its
verdict on the Settings block: "working" and "blocked" differ by one sentence
of plain text, the switch is a browser checkbox that looks the same when
memory is blocked, the counters read as a log line, and on the phone the
reason says "enter it below" while the field is under the fold. What it asks
of this menu is the content of two rows, and all three variants carry it
unchanged; they still differ in where the rows stand and what stands around
them. Nothing here is a new capability: the same switch, state, key and
counters, read from and written to `/api/memory/settings` and
`/api/asks-you/key`.

**The first level: one row, "Спільна пам’ять / Shared memory".** Icon, name,
state. The state is a word beside a coloured dot, never the colour alone:

| State | The row reads |
|---|---|
| Working | green dot · Працює · 61 цього місяця / Working · 61 this month |
| Off | grey dot · Вимкнено / Off |
| No key | amber dot · Потрібен ключ / Key needed |
| At the cap | amber dot · Ліміт до 1 листопада / Cap until November 1 |

On the phone the state stands at the row's right end. The desktop panel is
232 px wide, where the name and "Працює · 61 цього місяця" do not fit one
line, so the state is the row's second line there.

**One step in: the memory page.** The row opens a page of the menu with a
back row. It holds, in this order:

1. the switch "Для цього проєкту / For this project", drawn by the product's
   own `ProjectSettingRow`, the control the board's project rules use; a
   switch that is on while memory is blocked turns amber, so "on but blocked"
   does not look like "on";
2. while blocked, the reason in one sentence with its action beside it:
   "Щоб пам’ять підставлялась, потрібен ключ OpenRouter." with "Ввести ключ /
   Enter the key", which opens the field right there; at the cap, "Ліміт $5
   на місяць використано, відновиться 1 листопада." with no action, because
   the product has no place where the cap is set;
3. three numbers in a row: підставлено / added, перевірено / checked,
   витрачено із $5 / spent of $5, captioned "Повідомлення всієї інсталяції,
   не лише цього проєкту · жовтень". A month of zeros is hidden while memory
   is blocked;
4. "Докладніше / More", which opens the other five counters as a small
   two-column table: дібрано, без кандидатів, без збігу, пропущено, невдалих.

**The OpenRouter key is its own row beside memory**, since "Asks you" and
shared memory both use it. Its state reads Збережено / Saved or Немає /
Missing. Its page says "Для «Питає вас» і спільної пам’яті"; a saved key shows
no empty field until "Замінити / Replace" asks for one, a missing key shows
the field at once, and a key set in the environment says so. The field
itself is the product's own key row (`OpenRouterKeySetting`), of which only
the field, its button and its errors are drawn.

**Wording.** One verb for what happens to a memory: підставлено / added. The
model is "невелика модель через OpenRouter / a small model through
OpenRouter"; "Jev" is gone. No counter is called "decisions": the number is
"перевірено / checked". The month is its name, money has two decimals and
none on a whole amount, and the installation-wide numbers say so under the
per-project switch. The driver fails on "Jev", "decisions", a `2026-10` month
or a three-decimal amount anywhere on the page.

**Where the telemetry paragraph belongs.** The Settings dialog opens today
with a paragraph about the daily ping and its environment variables, and
memory starts 336 px down. In every variant that paragraph and its switch are
the whole dialog, behind the entry named for it ("Приватність" in 1,
"Анонімний пінг" in 2 and 3); the dialog takes that entry's name, and memory
and the key leave it for their rows.

Where the two rows stand:

| | 1 Whose it is | 2 What I came to do | 3 Settings that are settings |
|---|---|---|---|
| Memory and the key | at the first level, after Activity and Update | in the group "Що йде назовні / What leaves here", with the ping | on the Settings page, after language and notifications |
| The state at the first level | on the memory row, in full | on the group's row: "пам’ять: працює / memory: working" | on the Settings row: "пам’ять: працює" |
| Taps to the memory page | 2 | 3 | 3 |
| Why there | memory is this project's and the key is used by two features, so neither belongs to the browser's or the installation's group | memory and the ping both send something out, and the key is what sends it | each is a switch or a credential, and this variant keeps all of them on one page |

**Why a page.** The critique asks for the row to open in place. In place the
memory page would make the desktop menu 430 to 560 px tall, over the 360 px
bound of this family, so it opens as a page with a back row, as every group
does that would pass the bound. The page is 177 to 282 px, 340 px at most
with "More" open; the key page is 100 to 126 px. On the phone the memory page
is 292 to 434 px and the key page 206 to 232 px, with the action and the
field always in view.

Frames: every variant with memory working, off, without a key and at its cap,
in uk and en at 1440×900 in light (the first level, the group, the memory
page, the page with "More" or with the key field open, the key page, the key
page after "Replace", the ping's dialog); the working and keyless states also
in dark and on the phone; today's dialog in the same states. The driver fails
when the first level shows other words than the state served, when the switch,
its blocked look, the reason, the numbers or the key's state disagree with
that state, when "Enter the key" or "Replace" does not open the field where
it was pressed, when "More" does not list the five remaining counters, when a
banned word appears, when the ping's dialog still draws memory or the key, and
when any state is over its bound.

Costs of this part: two rows of two lines make the first level taller than in
the first round (variant 1 rests at 268 px, was 220). Variants 2 and 3 name
the state at the first level only in its short form, on a group's row. The
pages are drawn by the prototype over the product's endpoints and its
`ProjectSettingRow`; a build writes them as components and retires the two
blocks of the dialog. "Asks you" keeps its own switch in the board's ⋯ and
shares the key row with memory. The message-side part of the critique, the
chip under a message, belongs to another lane.

### Costs

- **All three**: ten of thirteen entries go from two taps to three. Memory
  and the key now have their own rows; the per-project switch could also
  stand among the project's rules in the board's ⋯ beside "Asks you", a menu
  this round does not touch.
  The phone's sheet is
  taller at rest than the chosen variant 1 sheet (484 px) because the places
  to go stand at the first level; it stays under today's 743 and never
  scrolls. The prototype draws a renamed row itself and presses the product's
  row under it; a build writes the names and icons into `ProjectRail.tsx` and
  the phone's entries.
- **1**: "This installation" holds five rows and opens as a page, the one
  group here that leaves the list; with memory and the key at rest the first
  level is eight rows, 268 px.
  "Open on phone" sits under "People and access", which is true of what it
  does and may be looked for under the browser.
- **2**: the grouping follows today's habits of one operator; "What leaves
  here" names what the dialog's switches share and leaves out the "Asks you"
  switch, which also sends text out and lives in the board's ⋯. Memory's full
  state is one step in; the first level names it in short on the group's row.
- **3**: the Settings page hides the first level while it is open, and its
  ten rows mix a browser's preferences with the installation's. Three
  entries are renamed beyond the complaint (Activity, Team, the relay).

### Recommendation

**Variant 1.** Its group names answer the question a person brings to this
menu, "where does this change apply"; its first level is well under today's
(268 px against 437); and it is the one variant where shared memory is found
by its name at the first level with its whole state in words, two taps from
its page, which is what a demo shows first. If the operator
wants the word "Налаштування" kept in the menu, variant 3 is the one that
makes it true.

### Evidence

`evidence/compact-card-menu/header-menu.json`: 446 states over today and the
three variants at 1440×900, 1000×700 and 390×844, light and dark, en and uk,
with the entries each state shows and the name each is drawn under. The
driver is a second case of the same `describe` block:

```
CHROME_BIN=<chrome> LLV_KANBAN_BROWSER_TEST=1 LLV_HEADER_MENU_OUT=<dir> \
  bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "header's menu"
```

It writes the single frames, `sheet-compare-uk.png` and `sheet-compare-en.png`
(today and 1, 2, 3 at rest), one sheet per variant with its groups open and
`sheet-memory-uk.png` and `sheet-memory-en.png` (memory and the key in each
state) with one `sheet-memory-<lang>-variant-<n>.png` per variant;
they are not committed. It fails when a desktop state is over 360 px, when a
phone state is taller than today's sheet, when a state scrolls, leaves the
window or cuts a label, when opening a group moves its own row, when an entry
of today's menu is shown in no state, when a renamed entry reads otherwise
than its variant names it, and when the renamed Settings entry does not open
the product's dialog. `headerMenu.prototype.test.ts` holds that every entry
has exactly one home in every variant, Sign out included, which the fixture
cannot draw without a member session, that memory and the key stand at one level with a state and a page each,
that one state is read from the reasons the product reports, and how the
state, the month and the money are worded. The prototype is `headerMenu.prototype.ts` and
`headerMemory.prototype.tsx` over the family prototype, mounted by the
fixture under `?header=1|2|3` with `&memory=working|off|noKey|capped`; the
product is unchanged.
