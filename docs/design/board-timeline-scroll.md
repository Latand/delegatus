# Board timeline scrolling: long finger holds, the wheel under the seat panel, the blank strip

Status: implementation brief, 2026-11-28. Changes `src/components/kanban/BoardTimeline.tsx`,
`src/components/kanban/boardTimeline.css` and the existing gesture and manager cases of
`src/components/kanban/kanbanBoard.browser.test.tsx`. No new driver, no new control.

## Requirement

On 2026-11-13 the operator reported in the seat chat (voice dictation, paraphrased): on the phone,
pressing and holding on the task chart and then scrolling makes it jump up and down. On the same
day they answered a decision form: on the desktop, with the orchestrator panel expanded, the chart
keeps a minimum height and scrolls with the page under the panel, as the kanban does.

A read-only critique of the chart on production (commit 65ee22aa, 2026-11-28, 390×844, 1024×768,
1440×900, uk and en, light and dark) found three scroll defects. Some are still present and some
are new:

- **F1** (phone 390, tasks expanded): an 8.5 s hold followed by a 200 px drag moved the content
  1650 px, in steps of up to 91 px per frame. The list height was rewritten 19 times (446…363 px).
  Holds of 0.7 s and 1.5 s were correct.
- **F2** (desktop, seat panel open): the chart starts at y=735 at 1440×900 with 63 px of rows
  visible, and at y=636 at 1024×768 with 30 px. Eight wheel notches over the rows moved the inner
  list 800 px and the page 0 of its 275 px. The wheel moves the page only over the chart's 58 px
  head.
- **F5** (phone 390): a drag that starts in the 22–80 px blank strip under the last row moves
  nothing. One measurement: collapsed tasks, list at scrollTop 732 of more than 5000, a 120 px
  slow drag over the strip moved 0.
- **P3s**: at 1024, stage rows are 64 px or 81 px when «Календарно: …» wraps. On the phone, the
  due words sit 2 px from the screen edge.

Acceptance (pinned specification):

1. Touch:
   - the content follows the finger 1:1, within 8 px, for holds of 0.7 s, 1.5 s, 8.5 s and 15 s,
     in collapsed and expanded modes;
   - the list height is not rewritten during a gesture;
   - nothing moves after release.
2. With the seat panel open, the wheel or trackpad over the chart scrolls the page until the chart
   is in view, then scrolls the list. Keys and trackpad input that already work keep working.
3. A drag that starts in the blank strip under the last row scrolls the list.
4. Stage rows have an even height at 1024. The phone's due words keep a normal margin from the
   screen edge.
5. Unchanged:
   - the collapsed default;
   - the grouping;
   - everything the critique marked fixed.

   Bars, working time, the look of the expanded view and phone density belong to other work.
6. Evidence comes only from the existing drivers.

## Root causes

### F1: the hold expires after 8 s, and every scroll after that is "corrected"

- `BoardTimeline.tsx:178-183` (`keepGesture`): a gesture stays active while the finger is down,
  but only for 8 s of silence (`state.held ? 8000 : 200`, `:182`). A finger that rests on the
  screen sends no scroll and no touch event. At 8 s, `endGesture` (`:169-175`) clears both
  `active` and `held`, even though the finger is still down.
- `BoardTimeline.tsx:498-505` (`onScroll`): when the finger then moves, each scroll event arrives
  with `active === false`. It is treated as a script move, so `fitRows()` runs (`:504`) on every
  event.
- `fitRows` (`:133-159`) writes the viewport height (`:155-156`) and snaps `scrollTop` to the next
  row edge in the direction of travel (`:139-141`, `:157`). The browser continues the touch scroll
  from the new position, so each frame adds up to one row height (91 px measured). The height
  changes with the rows that fit (446…363 px). That is the 1650 px for a 200 px drag and the 19
  height rewrites.
- `press` (`:184`) runs only on `touchstart`/`pointerdown`. Nothing re-arms the gesture once
  movement starts.

The same failure occurs for any rest of 8 s or more: a hold before the drag, or a pause in the
middle of a drag. The existing gesture case only holds for 0 and 700 ms (`kanbanBoard.browser.test.tsx:1028-1032`),
so it never reached this path.

### F2: the wheel always goes to the innermost scroller, and nothing gives the page priority

- The page under the seat is `.kb-page` (`kanbanBoard.css:991`). The chart's frame keeps 440 px
  and scrolls with the page (`boardTimeline.css:78-79`), as decided on 13.11.
- A wheel over the rows targets `.bt-scroll` (`boardTimeline.css:6`). The browser scrolls the
  innermost scroller under the pointer until that scroller reaches its end. Then
  `overscroll-behavior-y: contain` (`:6`) stops the scroll from passing on to the page.
- `onWheel={keepGesture}` (`BoardTimeline.tsx:497`) only marks the gesture. It does not decide who
  scrolls.
- The page therefore moves only from the chart's head (`.bt-head`, outside the scroller), the
  page's scrollbar or the seat-return strip. Over the rows it never moves.

The critique blamed `contain` alone, and that is incomplete. Without `contain`, the page would
receive the wheel only after the whole list had been scrolled to its end. It would also bring
back upward chaining from the tasks into the orchestrator panel. The operator rejected that
chaining on 2026-10-14 (`docs/design/independent-panel-scroll.md`), and the 13.11 manager-view
design kept it out (`docs/design/board-timeline-manager-view.md` §10).

### F5: the fitted viewport leaves a strip that belongs to no scroller

- `fitRows` shrinks the scroller to the axis plus whole rows (`BoardTimeline.tsx:155-156`:
  `flex: 0 0 auto; height: axis + used + scrollbar`).
- The rest of the section (`available − used`, 22–80 px) is left in `.board-timeline`. That
  element is `overflow: hidden` (`boardTimeline.css:1`) and is not a scroller.
- A touch there targets the section, as the critique's traces show (`hit: "board-timeline"`).
  Native scrolling only starts for a touch inside the scroller, and on the phone the page under
  the chart does not scroll (`MobileShell` clips the body).
- The touch handlers at `:497` are not the cause. Even with handlers on the section, the browser
  would not scroll `.bt-scroll` from a touch that starts outside it.

### P3: stage row heights at 1024, and due words at the phone's edge

- **Stage rows.** On desktop a stage label has three lines:
  - the name;
  - the meta: state, work time and «Календарно: …»;
  - the runtime.

  Only the name and runtime lines are pinned to their own lines (`boardTimeline.css:29-30`). The
  meta line wraps between its spans (`.bt-label > .bt-meta`, `:24`) when its figures get longer.
  At 1024, «… Календарно: 38 хв» fits and «… Календарно: 2 год 39 хв» wraps: 64 px versus 81 px.
- **Due words.** The phone lane is the full screen width (`--bt-phone-width`, `BoardTimeline.tsx:506`).
  - In-window due words hang from the flag at `marginLeft: x`, shifted by
    `anchorShift(x, laneWidth)` percent (`:336-337`, `taskTimelineView.ts:112-114`). Near the
    right edge, the words end at the screen edge, with only their own 2 px padding
    (`boardTimeline.css:57`).
  - Edge words have 3 px (`:59`).

## Mechanism

### 1. A hold lasts as long as the finger (F1)

- `keepGesture` sets no deadline while `state.held` is true. The 200 ms silence timer runs only
  after release, so momentum scrolling keeps the gesture alive as it does today.
- `held` is cleared only by the release events already listened for at `:197-213`:
  - `touchend` with no touches left;
  - `touchcancel`;
  - `pointerup` and `mouseup`;
  - `blur`.

  Add `visibilitychange` to the hidden state as one more release.
- A lost release can only defer a pending fit until the next `press` or release. It never writes
  anything, so the 8 s safety deadline is not needed. Delete it, and update the comment at
  `:176-177`.
- `onScroll` (`:498-505`) stays as it is. A scroll with no gesture (focus moving into view, find in
  page) is still fitted to a row edge. A scroll while a finger is down can no longer reach `:504`.
- `fit` (`:163-168`) and `endGesture` (`:169-175`) keep their deferral. A layout change during the
  gesture (resize, expand, refresh) waits in `pending`, as it does today.

### 2. The list keeps one height, and the strip scrolls it (F1 and F5)

The scroller always fills the section (`flex: 1`, as `boardTimeline.css:6` already says).
`fitRows` no longer writes `style.height` or `style.flex` on it.

- **Curtain.** The part of the viewport that holds no whole row is covered by a curtain. The
  curtain is one element, the last child of the scroller's content (after the group rows,
  `:538`):

  ```html
  <div className="bt-rest" aria-hidden data-timeline-rest="" />
  ```

  ```css
  .bt-rest { position: sticky; bottom: 0; z-index: 7; height: var(--bt-rest, 0px); background: var(--color-canvas); }
  ```

  `z-index: 7` sits above the sticky labels (5) and below the axis (8).
- **Sizing.** `fitRows` sets `--bt-rest` to `available − used`, and to 0 in the
  "everything fits" branch at `:149-153`, on the scroller with `style.setProperty`. This replaces
  the writes at `:150-151` and `:155-156`. It keeps setting `scrollTop` to the first whole row
  (`:157`).
- **Why it works.** While the list is scrolled, the sticky curtain stays at the bottom of the
  viewport and covers the row that does not fit, so no row is cut at rest. At the end of the list
  the curtain is in normal flow after the last row and acts as the spacer that lets the last row
  rise above it. The end alignment at `:143-145` stays correct: with
  `clientHeight = axis + used + rest`, the largest scrollTop is `total − used`.
- **Touch.** The strip is now inside the scroller, so a finger on it scrolls the list natively,
  and `onTouchStart={press}` (`:497`) receives it by bubbling. A tap on the curtain does not reach
  a row hidden underneath it.
- **Height during a gesture.** The scroller's own height changes only when the section is resized.
  The curtain height is written only by `fitRows`, which never runs during a gesture (§1). The
  list height is therefore constant through any gesture by construction.

`measureRows` (`:106-128`) is unchanged: `available` is still the section minus head, axis and
scrollbar. Arrow keys (`keyStep`, `:185-196`) keep stepping one row. PageDown, Space, Home, End
and the scrollbar stay native.

### 3. With the seat open, the page scrolls first, downward only (F2)

A native listener (`wheel`, `{ passive: false }`) is added to `.bt-scroll` in an effect. React
registers its root `onWheel` as passive, so `preventDefault` would not work there. On each event:

1. Leave the event alone, and let the list scroll as today, when any of these holds:
   - `ctrlKey` is set (pinch zoom);
   - `|deltaX| > |deltaY|`;
   - `deltaY <= 0`;
   - no `.kb-page` ancestor exists (phone, seat at the side);
   - the page does not overflow.
2. Convert `deltaY` to pixels:
   - `DOM_DELTA_LINE` × 16;
   - `DOM_DELTA_PAGE` × `page.clientHeight`.
3. `need = root.getBoundingClientRect().bottom − page.getBoundingClientRect().bottom`, then
   `room = page.scrollHeight − page.clientHeight − page.scrollTop`. If `need > 0.5` and
   `room > 0.5`, the chart is not yet fully in view:
   - call `preventDefault()`;
   - move the page by `step = min(delta, need, room)`;
   - carry `delta − step` to the list (`scroll.scrollTop += rest`, inside the active gesture, so
     the existing `onScroll` treats it as the person's movement).
4. Otherwise do nothing. The list scrolls natively.

Scrolling upward never chains from the list to the page. `overscroll-behavior-y: contain` stays,
and the way back up is still the seat's return strip and the chart's head, as decided on 14.10
and 13.11. Keys are unchanged: PageDown on the focused list moves the list. Writing the page's
scrollTop does not resize the chart, because the `:has(> .seat-return)` frame rule depends on the
strip's presence and not on whether it is shown. So no fit is triggered.

### 4. Even stage rows, and due words off the edge (P3)

- **Stage rows.** On desktop the calendar span gets its own line, the same way the name and the
  runtime already do (`boardTimeline.css:30`):
  ```css
  .board-timeline[data-phone="0"] .bt-stage [data-timeline-wall] { flex-basis: 100%; }
  ```
  - Every desktop stage label then has four lines: name, state · work time, calendar span,
    runtime. That is 81 px at every width.
  - Cost: +17 px on rows that are 64 px today, and only on expanded tasks, which are collapsed by
    default.
  - No text is cut, which keeps the 31.10 rule: "compact, without cutting information".
- **Due words.**
  - On the phone, `.bt-due-slot` gets `padding-inline: 12px`, the label's inset.
  - In-window words use `marginLeft: x · (laneWidth − 24) / laneWidth` with the same
    `anchorShift` percentage. Their span then runs from 12 px to `laneWidth − 12` px, and the words
    stay on the flag's side.
  - The flag itself keeps its place (`:338-339`).
  - Desktop is unchanged.

## Driver cases (existing drivers only)

The cases live in `src/components/kanban/kanbanBoard.browser.test.tsx`: the gesture case «chart
follows touch, trackpad, wheel and key scrolling without jumps» (`:849`) and the manager case
(`:1420`). `scripts/capture-board-geometry.ts` has no timeline case, and none is added.

### Helpers to update, because the scroller height is no longer the viewport

These helpers read `scroller.clientHeight` as the bottom of the visible rows. Make them use the
top of `[data-timeline-rest]` instead:

- the text-line clip helper, `:768`;
- `cuts`, `:934-935`;
- `geometry`, `:965-973`;
- the manager first-screen check, `:1548-1551`;
- the seat-open `chartViewport` check, `:1651-1655` (the visible rows are
  `clientHeight − axis − rest`);
- the long-title stepping, `:806-821`.

The two waits for `style.height` (`:784`, `:957`) wait for `[data-timeline-rest]` to have been
sized instead. `install` (`:895-916`) records:
- `--bt-rest` changes as writes;
- the curtain height in each frame, next to `h`.

### Cases to add or extend

All cases run at the phone (390×844) and on desktop, uk, with the 30-task fixture, in collapsed
and expanded modes.

| Case | Input | Must hold |
| --- | --- | --- |
| T1 long holds | `drag200` from `bar` and `label`, with holds `[0, 700, 1500, 8500, 15000]` | moved within 8 px of the plain scroller's `drag200` (`reference`); every leg mark within 8 px; zero script writes (scrollTop, scroller style, `--bt-rest`); one viewport height and one curtain height across all frames; max one-frame jump ≤ 8 px plus the finger's own step; scrollTop unchanged between `touchEnd`+250 ms and +1200 ms |
| T2 pause mid-drag | legs `[0,-100]`, finger held still for 9000 ms, then `[0,-100]` | the same as T1, comparing against the plain scroller given the same legs |
| T3 strip start | new start kind `strip`: a point 6 px inside the curtain, at a fitted rest position that is neither top nor end, chosen so that `--bt-rest ≥ 20px` (fails if no such position exists); `drag200` and `slow60` | `elementFromPoint` is inside `[data-timeline-scroll]` (the curtain); the list moves like the plain scroller, within 8 px; the same write and height checks as T1 |
| T4 wheel with the seat open | desktop 1440×900 and 1024×768 with the seat expanded on top (`openManager(..., seat: true)`), groups open, page and list at 0. The pointer is kept still over the visible rows. Wheel 100 one notch at a time, logging `elementFromPoint` and the page and list scrollTop after each notch; then trackpad steps of 40×6; then the wheel up | down: the page moves first and the list stays at 0 until the chart's bottom is within 1 px of the page's bottom (or the page is at its maximum); in the notch that reaches that point, page plus list movement equals the notch; after it only the list moves, and `elementFromPoint` stays inside `[data-board-timeline]`; up: the list moves back to 0, and further notches move neither list nor page. With the seat folded, the existing wheel 40/100 checks (`:1134-1139`) stay green |
| T5 stage rows | manager case frames at 1024, 1200 and 1440, uk and en; one expanded task whose stages have a short («38 хв») and a long («2 год 39 хв» or longer) calendar span | every desktop `.bt-stage` row without `data-earlier="1"` has the same height ±0.5 px |
| T6 phone due words | 390, uk and en; scales 6 h, 24 h and 72 h; due words in-window near both edges and past both edges | every text-range rect of `[data-timeline-due]` is ≥ 8 px from the left and right viewport edges |

The report JSON records each gesture's hold, start element, the curtain height, the page and list
series for T4, and the `ranToEnd` and `abort` fields already written.

## What must not change

- Collapsed default, remembered expansion, grouping (working on top, «Чекають на вас», «Стоять»
  with the nested «довше 3 днів»), due order, due flags, window axis, return to now, stage rows
  that open their conversation, the header's chart button.
- A row is never cut at rest after open, resize, expand or zoom (`cuts` stays empty). A person's
  own scroll is never corrected. A refresh leaves a scrolled position and writes nothing
  (`:1179-1188`).
- Wheel and trackpad move the list 1:1 when the seat is folded or at the side. Arrow keys step one
  row. PageDown, PageUp, Space, Home, End and the scrollbar are native.
- Short-hold touches behave as today (within 8 px, nothing moves after release).
- No upward chaining from the list into the page. `overscroll-behavior-y: contain` stays.
- The kanban columns, the seat's conversation and the seat-return strip are untouched. The frame
  rule (`boardTimeline.css:79`, `kanbanBoard.css:1239`) is untouched.
- No horizontal scrolling of the chart (`overflow-x: hidden`).

## Overlap with open work

On 2026-11-28, no open pull request touches `BoardTimeline.tsx` or `boardTimeline.css`. Ten open
pull requests touch `kanbanBoard.browser.test.tsx` (#3762, #3805, #4143, #4261, #4268, #4319, #4371,
#4536, #4570, #4571), and none of their diffs touch the timeline blocks (`:415-2300`). No existing
test asserts the 8 s deadline or the scroller's inline height, apart from the two waits and the
geometry helpers listed above.

## Deferred — not currently justified

- **Page-first scrolling for keys** (PageDown over a partly hidden chart). The requirement names
  the wheel and trackpad, and says keys stay as they are.
- **Page-first scrolling for the kanban columns.** That would be a separate request about another
  surface, and it touches the 14.10 decision.
- **Dropping whole-row fitting altogether** (a full-height scroller with cut rows). It would remove
  `fitRows` and the curtain, but it breaks the "no row cut at rest" rule the drivers enforce.
- **Synthetic scroll forwarding from the strip.** It would reimplement touch scrolling, and the
  curtain makes it unnecessary.
- **Physical phone and iOS Safari runs.** Both drivers use Chromium with CDP touch. The critique
  could not check either, and neither can this change.
