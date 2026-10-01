# Drag a card by any part of it, smoothly

The operator found the card's header too small a handle ("you have to hit it
exactly") and decided that the whole card may be the handle, provided it moves
smoothly. The chosen design is variant 1 of the review set: no new element on
the card.

## Behaviour

**Desktop.** A left-button press anywhere on a task card starts a drag after 8 px
of movement: the title (a button), the description, a conversation tile, the
pipeline block, the padding. A press that moves less is a click and does what it
always did. The click a drag leaves behind is swallowed, and the one after it is
not. Nothing is selected while the pointer is down on a card. A text field being
edited, an open reader and a stage's detail pane are not handles. Esc cancels, a
release over no column or over the card's own column moves nothing.

**Phone.** A task card held for 0.35 s without moving 8 px lifts: the card is
copied into a ghost that follows the finger, and a dock with the four columns
appears at the bottom, the card's own column dashed and marked "here". The release
decides: over another column the task moves there with the usual receipt and Undo;
within 8 px of where it lifted, today's card sheet opens; anywhere else nothing
happens. A finger that moves before the hold is up is the column scrolling or the
pager swiping and nothing changes. After the lift the browser's scroll is cancelled
under that finger. Cards no task owns keep today's 450 ms hold and sheet.

## Why the old drag was not smooth

Measured in a Chromium trace (`src/components/kanban/dragFrameMeter.ts`) over a
3 s drag on a board of 48 tasks with long titles, conversations and pipelines
(`scenario=drag-board` in `issue1695Evidence.fixture.tsx`):

1. Every `pointermove` wrote the ghost's `left` and `top` (layout), read the source
   card's `getBoundingClientRect` (a forced layout straight after the write), hid
   the ghost with `display: none`, called `elementFromPoint` (a second forced layout
   and a style recalculation) and showed it again: about two layouts and two style
   recalculations per move, 700 and more in 3 s.
2. Each of those layouts was expensive for a second reason: the board's live glyphs
   (`.mglyph[data-live]`) animate `transform` on SVG children, which Chromium runs
   on the main thread, so every frame already carried a style recalculation and a
   layout for them. On a phone the same animations alone cost a layout and a
   recalculation per frame, four times as long at 4x CPU.
3. The drag hint was React state: starting a drag rendered the whole board once.

## The fix

- The ghost is positioned at `left: 0; top: 0` and moves by `translate3d`, one
  write per frame from a `requestAnimationFrame` that the moves only schedule.
- The card's and the columns' rectangles are read once at the start of the drag
  (again after a scroll or resize), and the column under the pointer is found by
  comparing with them: no hit test, no `display` toggle, no layout read in the
  move path.
- The hint is a node appended by hand; nothing renders in React during a drag.
- While a card is held the board's live animations are paused (`data-card-drag`
  on the board, on `body` on the phone). The selectors name classes: a `*` or an
  attribute-substring subject would restyle every element on the page when the
  attribute is set.
- No inherited property (`user-select`, `pointer-events`) is set on the board for
  the drag. The pointer is captured on the held card, so nothing under the ghost
  takes hover, and `selectstart` is refused for the length of the press.
- Phone: the same move path (`phoneCardLift.ts`), the dock is one small component
  fed by an external store so the lift does not render the board, and the dock's
  highlight is a data attribute written when the tile under the finger changes.

Numbers are in `evidence/whole-card-drag/*.json`; the test driver for each surface
holds the case (`kanbanBoard.browser.test.tsx`, `issue1671Evidence.browser.test.tsx`,
"whole-card drag").
