# Independent panel scroll: the orchestrator's conversation and the task columns

Status: design, 2026-10-14. One CSS change on the desktop board, no new controls.

## Requirement

The operator, to the orchestrator in the Delegatus chat, 2026-10-14 09:01Z, verbatim:

> Есть один ещё очень неприятный момент: в работе делегатуса побыстрее бы исправить. Сейчас, когда я
> делаю скролл в разговоре оркестратора и оркестратор находится выше, то меня скроллит на задаче, а я
> не хочу. Я хочу, чтобы я, если нахожусь в задачах, оно мне не поднимало... не, подожди, сейчас я
> подумаю. Да, у нас есть отдельный скролл для задач, и отдельный скролл для секции текста внутри
> оркестратора. И получается, что когда я нахожусь внутри того скролл-момента, ну, где у нас элементы
> чата или элементы, то есть задачи, которые в работе, то если я внутри этого, то там скролл работает
> только на локальном. А если я хочу проскроллить весь экран, то я как бы должен выйти оттуда каким-то
> образом. Вот. Ну и мне, наверное, необходима какая-то штука... то есть у меня нет места, где мне...
> ну, короче, нужна какая-то, я не знаю, вот я, например, нахожусь среди задач, и. Я хочу вверх
> подняться, то мне нужно найти место, где у меня нет ни одной задачи, и только на меня. Да, на меня
> скрутит вверх. А сейчас получается, я когда на задачах, оно крутит только задачи. И если я иду... я
> докрутил до верха задач, то оно меня крутит всю страничку вверх. А я бы не хотел, чтобы оно меня
> крутило на оркестратора. То есть это условно как две разные панели, условные, которые... на которых
> должен быть разный скролл. Но при этом нужна какая-то общая полоса или где-то, чтобы я мог всё-таки
> скроллить всю страничку. Вот подумаю, как это сделать, и сделаю. Сделай.

Read as: the conversation and the task list are two panels; a scroll inside either stays inside it
at both ends; the whole page scrolls from one shared bar or place that is neither a task nor a
message.

## Surface

The desktop board (`KanbanBoard`, every width from 640 px) with the orchestrator's seat on top. Its
scroll containers, outermost first:

| Container | Where | Scrolls |
| --- | --- | --- |
| `.kb-page`, the page | `src/components/kanban/KanbanBoard.tsx:2963`, `kanbanBoard.css:901` | vertical; holds the seat and the board frame |
| `.seat` on top | `KanbanBoard.tsx:2964` → `KanbanSeat.tsx:298`, `kanbanBoard.css:1011` | no; 75dvh by default (`kanbanBoard.css:890`) |
| the seat's conversation, `[data-log-feed-scroller]` | `src/components/LogFeed.tsx:1980` (classes at `:1988`), seat rule `kanbanBoard.css:1047` | vertical |
| `.board-frame` | `KanbanBoard.tsx:2965`, `kanbanBoard.css:909` | no; as tall as the page (`max(440px, 100%)`) |
| `.board.scroll` (768–1199 px of board width) | `kanbanBoard.css:215` | horizontal |
| `.col-body`, one per column | `KanbanBoard.tsx:3300`, `kanbanBoard.css:333` | vertical |

The page is the seat plus a full page of board, so it always overflows by about the seat's height
(687 px at 1440×900). Neither inner scroller sets `overscroll-behavior`, so when one reaches an end
the browser hands the rest of the scroll to `.kb-page` (scroll chaining). That is the whole defect.
With the seat at the side (`.seat.side`, outside `.kb-page`) the page does not overflow and nothing
chains; a folded seat still leaves about 52 px of page to chain into (its 40 px strip and 12 px margin).

The phone at 390 px has no such surface. `MobileShell` clips its body (`src/components/mobile/MobileShell.tsx:283`),
and `MobileKanban` is a fixed column: the seat card (58 px, a summary with no scroller,
`MobileKanban.tsx:1229`), the tabs, the pager, and the dock. The only vertical scrollers are the
column pages, already `overscroll-y-contain` (`MobileKanban.tsx:1283`). The orchestrator's
conversation opens as its own screen.

## Reproduction

Chrome for Testing 153, the kanban fixture, readings of `.kb-page.scrollTop` (range 0–687) at
1440×900 with the project rail open (the board is in its scroll mode there). Measured with throwaway
probes against an export of the base commit; the driver case below repeats every row.

| Input, with the panel at the named end | Today | `overscroll-behavior-y: contain` |
| --- | --- | --- |
| Column 120 px from its top, three wheel notches up (`?scenario=drag-board`) | 687 → 687 → 447 → 207 | 687 throughout |
| Column 100 px from its end, three notches down (default fixture) | 0 → 0 → 240 → 480 | 0 throughout |
| Column at its top, one trackpad-like gesture of 600 px | 687 → 87 | 687 |
| Focused card at the column's top, PageUp | 687 → 0 | 687 |
| Column that does not overflow (Inbox, default fixture), one notch up | 687 → 447 | 687 |
| Conversation 60 px from its end, three notches down (`?scenario=agent-report`) | 0 → 0 → 240 → 480 | 0 throughout |
| Conversation 80 px from its top, three notches up | 160 → 160 → 0 → 0 | 160 throughout |
| Conversation at its end, one trackpad-like gesture | 0 → 600 | 0 |
| Click in the conversation at its end, PageDown and End | 0 → 687 | 0 |

In the rows with three notches the first one finishes the panel and the next ones go to the page. The same fix
leaves these as they are:

| Input | Today and with the fix |
| --- | --- |
| Column head, one notch up / down | page −240 / +240 |
| Seat head, one notch down | page +240 |
| Page scrollbar with scrollbars drawn (measured with the fix), one notch over it; thumb dragged 300 px | page +240; 0 → 510, no text selected |
| Column head, a finger dragged down 250 px (CDP touch) | page 687 → 398 |
| `focus()` on a card below the window | page 0 → 687 |
| Sideways wheel and trackpad over a column (scroll mode) | board `scrollLeft` 0 → 211 |

Two controls settle the details. The shorthand `overscroll-behavior: contain` on the same elements
stops the sideways rows (`scrollLeft` stays 0), so only the vertical axis may be contained; the
horizontal chain also carries the browser's back and forward swipe. A finger dragged down from a
column at its top moves nothing today (687 → 687), so touch on the desktop board has no chain to
remove. Phone, 390×844 and touch, default and `drag-board` fixtures: the document does not
overflow, the four column pages are the only vertical scrollers, and a finger down at a column's top or up
at its end moves no other scroller.

## Fix

Two declarations in `src/components/kanban/kanbanBoard.css`:

1. `.kb .col-body` (`:333`): add `overscroll-behavior-y: contain;`.
2. `.kb .seat [data-orchestrator-conversation] [data-log-feed-scroller]` (`:1047`): add
   `overscroll-behavior-y: contain;`.

Both are scoped under `.kb`, which only the desktop board mounts, and the seat rule reaches only the
seat's own conversation. `LogFeed` keeps its classes, so the phone's conversation screen, the agent
window and the readers inside cards are untouched. A reader inside a card keeps chaining into its own
column, inside the task panel, and stops there. Use the `-y` longhand only. No `touch-action` change
and no wheel handler: Chromium honours the property for wheel, trackpad and keyboard chains
(measured above) and for touch by specification.

## Whole-page scroll: the page's own scrollbar

The page scrolls from its own vertical scrollbar, and from the strips that belong to neither panel:
the seat's head, the row of column heads (with the jump strip above it in scroll mode) and the
gaps. All of it exists today; nothing is added.

- **Placement, desktop.** `.kb-page`'s scrollbar: 15 px wide at the right edge of the window, from
  under the header bar (y = 48) to the window's bottom, at every desktop width, in both resting
  positions (seat in view, board in view). The column scrollbars are 10 px (`scrollbar-width: thin`)
  and drawn inside each column under its head; the full-height bar at the window edge is the page's.
  At 1440 with the rail hidden, Done's own bar ends 21 px left of it.
- **Wheel, trackpad and touch.** Once the panels stop chaining, the heads and gaps are the only
  places a wheel moves the page. The column-head row is on screen in both resting positions at
  1440×900 with the rail open (y 788–836 with the seat in view, y 101–149 with the board in view).
- **Keyboard.** Unchanged: Skip to the board, or a mouse click on the board (a card included),
  leaves focus on `.board-frame`, and PageUp/PageDown then scroll the page (687 → 0 measured,
  before and after the fix). Keys scroll a column when a card in it has focus by Tab, and that
  scroll is now contained.
- **Phone, 390 px.** No page scroll exists, so there is nothing to reach for: the seat card, the tabs
  and the dock never leave the screen, and the column page is the one thing a thumb scrolls.

Why this one: the operator asked for «общая полоса», and a scrollbar is the bar every desktop page
already offers; it is always there, and neither a task nor a message sits on it. The alternatives
were heavier: a new grip or "to the orchestrator / to the board" buttons duplicate the scrollbar,
scroll-snap between the seat and the board changes every resting position the operator has today, and
JavaScript wheel routing does by hand what one CSS property does.

## The way back: a strip pinned to the page

The lock traps the page once it is low. One wheel notch from a column head moves the page, the
conversation slides under the pointer, and the contained feed takes every later notch (687 → 447 at
1440 px). The bar's Orchestrator button and `O` fold the seat from there, so neither returns to it.

`KanbanSeat` draws one strip as the first child of `.kb-page`, only for the seat on top and open. It
is `position: sticky; top: 0` with no height of its own and a 32 px button, so it belongs to the
page scroller and stays under the pointer while the page scrolls up. It is visible only while the
seat's head is above it (an `IntersectionObserver` rooted at the page, no per-scroll work). A wheel,
a trackpad or a finger over it scrolls the page to the top. A click, Enter or Space scrolls to the
top and moves focus to the composer (the fold button when the seat shows no composer). The board
is 32 px shorter so the strip covers none of its rows at the page's end.

The lock on the panels is unchanged. The folded seat, the seat at the side and a window under 800 px
tall draw no strip; the phone draws none because its document does not scroll and the seat card
never leaves the screen. Driver case: "a strip pinned to the page returns it to the seat"; readings
in `evidence/panel-scroll/return.json`.

## States to cover

- Desktop 1440×900 with the rail open (scroll mode) and hidden (wide grid), and 1000×800 with the
  rail open (the board's tabs mode).
- Seat on top at its default height, seat on top folded, seat at the side (the page must not scroll).
- A long conversation (`?scenario=agent-report`) and a short one; a long column (`drag-board`) and
  one that does not overflow.
- Both ends of both panels, by wheel notches, a trackpad gesture (`Input.synthesizeScrollGesture`,
  `gestureSourceType: "mouse"`), keys (focused card; a click in the conversation) and CDP touch.
- Phone 390×844 and 430×932, touch.

## What must not change

- The conversation's stick-to-bottom: after the down notches at its end it is still at its end, and
  a streamed message keeps it there.
- Card drag-and-drop on the desktop board; the column's sideways scroll in scroll mode; the browser's
  back and forward swipe.
- Focus scrolling: a focused card below the window is still brought into view by the page.
- Phone: the pager's sideways swipe, a column scrolling alone, pull-to-refresh and back gestures.
  No rule reaches the phone.
- The board's compositor scrolling (`will-change: scroll-position`, `kanbanBoard.css:917`) and the
  columns' scroll anchoring.

## Tests and driver cases

happy-dom has no scrolling, so the proof is a browser case; a stylesheet test guards the rule.

1. **`src/components/kanban/boardScrollers.test.ts`**, beside the compositor test: `.kb .col-body`
   and the seat's `[data-log-feed-scroller]` rule declare `overscroll-behavior-y: contain`, and no
   rule in `kanbanBoard.css` sets the `overscroll-behavior` shorthand or `overscroll-behavior-x` on
   either.
2. **`src/components/kanban/kanbanBoard.browser.test.tsx`**, one new `describe`, one `browserTest`,
   launched with `ignoreDefaultArgs: ["--hide-scrollbars"]` (as at `:183`) so the page scrollbar
   exists. For every state above: each inner-end input leaves `.kb-page.scrollTop` within 1 px; the
   page scrollbar (wheel and a thumb drag with no text selected), a column head (wheel and CDP
   touch) and the seat head move the page; the "must not change" rows hold (sideways `scrollLeft`
   grows, a focused card is brought into view, the conversation stays at its end). Then the same
   inner-end inputs run with `.kb .col-body, .kb .seat [data-log-feed-scroller] {
   overscroll-behavior-y: auto !important }` injected and every one of them must move the page, so
   the case is proven able to fail. Readings go to `evidence/panel-scroll/desktop.json`; frames at
   1440 with the page at its top and at its end.
3. **`src/components/mobile/issue1671Evidence.browser.test.tsx`**, one `browserTest` beside "#2072
   slice 4 touch" (`:3359`): at 390×844 and 430×932 with touch, the document does not scroll, the
   only overflowing vertical scrollers are `[data-phone-kanban-column]` with computed
   `overscroll-behavior-y: contain`, and a finger at either end of a column moves no other scroller
   and leaves the seat card and tabs where they were. Readings go to `evidence/panel-scroll/phone.json`.

Existing cases to rerun by name after the change, because they scroll the same elements: "the board
holds still under a scroll" (`kanbanBoard.browser.test.tsx:25064`; its open-seat drive used to carry
the page at a column's end, so commit its readings if they change), "the page and every overflowing
column scroll without the main thread" (`:13153`), "whole-card drag rendered evidence" (`:19779`),
"blocks pin at their heads, stream beside the seat, and collapse to one line" (`:14667`), "a wire
stays on its card on every frame of a scroll" (`:27216`); on the phone "#2072 slice 4 touch"
(`issue1671Evidence.browser.test.tsx:3359`) and "whole-card drag on the phone" (`:8167`).

## Deferred — not currently justified

- **The seat's create and rotate draft** (`OrchestratorPanel.tsx:1088`) has its own scroller and
  would chain the same way; it is rare and holds no tasks. Add it to the seat rule if it is seen
  pulling the page.
- **Forcing the page scrollbar visible on overlay-scrollbar desktops** (macOS "show scroll bars when
  scrolling"): not measured here, where scrollbars are classic. Revisit if the operator does not see
  the bar.
- **A distinct colour for the page scrollbar.** `scrollbar-color` inherits into every scroller below
  it; revisit only if the page bar and Done's bar are confused.
- **Jump buttons or scroll-snap** between the seat and the board.
- **Keys after a mouse click in a column.** A click leaves focus on `.board-frame`, so keys then
  scroll the page, as they do today. Handing the click's column the keyboard is a focus change
  nobody asked for.
- **Firefox and Safari keyboard chaining:** only Chromium was measured; the property is supported
  for wheel and touch in both.

## Validation against the requirement

- "отдельный скролл для задач, и отдельный скролл для секции текста внутри оркестратора": both
  panels keep their own scroll, and the table shows each end of each panel now stops (wheel,
  trackpad, keys).
- "докрутил до верха задач, то оно меня крутит всю страничку вверх. А я бы не хотел": the first
  row, 687 → 207 today and 687 with the fix.
- "когда я делаю скролл в разговоре оркестратора … меня скроллит на задаче": the conversation rows,
  0 → 480 today and 0 with the fix.
- "нужна какая-то общая полоса или где-то, чтобы я мог всё-таки скроллить всю страничку": the page's
  own scrollbar at the window edge, plus the heads and gaps, none of which is a task or a message.
- On the phone nothing chains today and nothing is added; the phone case keeps it that way.
