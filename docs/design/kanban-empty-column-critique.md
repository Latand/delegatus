# Kanban desktop, empty column strip and open-agent minimum: design critique

Design review only. It judges the rendered board of the pull request head
`97f11dd69` against the operator's requirement, with the merge base
`70ab3aa03` rendered beside it for the before. No product source was edited.

Verdict: **REQUEST_CHANGES**. Both halves of the requirement hold at rest, and
the phone is unchanged. Two defects show as soon as the pointer moves: the
strip opens the instant the pointer touches it, so the controls beside it move
out from under the pointer, and the strip's own menu button cannot be pressed
where it is drawn.

## 0. The requirement

Source: the operator, 2026-09-28, as recorded in this stage's specification
(paraphrased in English, with two screenshots of the live board):

> On the desktop kanban (1) an EMPTY column (e.g. «Заблоковані» with 0 cards
> and its "Nothing blocked / drag a task here" placeholder) still takes a full
> column width — it should collapse to a very narrow strip (header count
> visible, still a drop target when dragging a card, expands when it gets a
> card or on hover/drag); (2) when an agent conversation is opened inside a
> column card (e.g. in «Призначені») and the left side rail "1 агент
> відкритий" is also shown, the opened agent gets squeezed — the currently
> opened agent must keep a minimum width that depends on the screen (never
> compressed below it; the board scrolls horizontally instead).
>
> NOT in scope: phone layout (must stay unchanged — verify at 390), other
> columns' widths when non-empty, the graph.

## 1. How it was rendered

- Both commits were exported with `git archive` into a scratch directory under
  the temp root, and every render ran from those exports with an isolated
  config root. The live worktree stayed clean from start to end.
- The pull request's own case in `kanbanBoard.browser.test.tsx` ("folds to a
  strip") ran from the head export: 1 pass, 24 frames, readings identical to
  the committed `evidence/empty-column-strip/readings.json`.
- A scratch driver over the same harness (`serveEvidenceFixture`,
  `openFixture`, the `stages` scenario, `&empty=blocked`) added what the case
  leaves out: the same frames on the merge base, an agent open in a shelf
  column (Inbox and Done), the phone's Blocked tab, and a pointer travelling
  across the strip. The merge base ran with the head's fixture file, so the
  only difference between the two renders is product code.
- Prior work: `search_transcripts` for the strip and the agent minimum
  returned this pipeline's own conversations only. Nothing earlier existed.
- I looked at the frames: all 24 of the case's, the head and base frames of
  the scratch driver, and 3× crops of the strip at 1440 and 1600.

Fixture chrome in every desktop frame: the project sidebar takes 248 px, so
the board gets 1032 px at 1280, 1192 px at 1440 and 1352 px at 1600.

## 2. What holds

### 2.1 The empty column is a strip

| Viewport | Layout mode | Blocked, base | Blocked, head | Done's left edge, base → head |
| --- | --- | --- | --- | --- |
| 1280×900 | scroll | 280 px | 48 px | 1340 → 1108 |
| 1440×900 | scroll | 280 px | 48 px | 1340 → 1108 |
| 1600×900 | narrow | 220 px | 48 px | 1360 → 1360 (Assigned takes the room: 604 → 776) |

At 1440 the strip is what makes the four columns fit: the board's scroll width
drops from 1388 px to 1192 px, which is exactly its client width. In the 3×
crops the strip reads top to bottom as the count `0`, the column name set
vertically, and the menu glyph, in English («Blocked») and Ukrainian
(«Заблоковані»), with the column's own background. Nothing is clipped.

A card dragged over the strip opens it to a 280 px column with the drop
outline, and the card dropped there lands in Blocked, which then stays a full
column with the count `1` (frames `1440x900-none-{en,uk}-drag` and
`-dropped`). Inbox, Assigned and Done, which hold cards, never fold.

### 2.2 The open agent keeps its minimum

`--agent-min` is `clamp(520px, 40vw, 760px)`: 520 px at 1280, 576 px at 1440,
640 px at 1600.

| Viewport | Agent in | Rail | Column, base | Column, head | Reader, base → head |
| --- | --- | --- | --- | --- | --- |
| 1280 | Assigned | full | 480 | 520 | 428 → 468 |
| 1280 | Inbox | full | 460 | 520 | 408 → 468 |
| 1280 | Done | full | 460 | 520 | 408 → 468 |
| 1280 | Assigned, Inbox widened | full | — | 520 | 468 |
| 1440 | Assigned | full | 480 | 576 | 428 → 524 |
| 1440 | Inbox | full | 460 | 576 | 408 → 524 |
| 1440 | Done | full | 460 | 576 | 408 → 524 |
| 1600 | Assigned | compact | 548 | 720 | 496 → 668 |
| 1600 | Inbox | compact | 420 | 640 | 368 → 588 |
| 1600 | Done | compact | 420 | 640 | 368 → 588 |

Every column that holds the open agent is at or above the minimum, in both
languages, with the rail shown. Where the columns no longer fit, the board
scrolls sideways (for example 1440 with the agent in Done: scroll width
1452 px over a 992 px client), which is what the requirement asks for. With no
agent open there is no rail, and those frames are the rail-off half.

### 2.3 Non-empty columns are unchanged

With the fixture as it is (no column emptied, nothing open), every column has
the same left edge and width on the base and on the head at 1280, 1440 and
1600: 280/480/280/280 in the scroll mode and 220/604/220/220 in the narrow
mode.

### 2.4 The phone is unchanged

390×844 with touch, English and Ukrainian, with and without the emptied
column, on the board and on its Blocked tab: eight frame pairs, base against
head.

- The five English frames and the Ukrainian Blocked-tab frame with the emptied
  column are identical pixel for pixel.
- Two Ukrainian frames differ in a 6×7 px box at (212, 75), which is the last
  digit of the seat's running timer. One differs by a fraction of one pixel
  inside the relative-time labels. Both are the clock.
- No strip is drawn on the phone (`.column.strip` count 0).

## 3. Findings

### F1 (P1). The strip opens under a passing pointer, and the controls beside it move away

The strip opens on `:hover` with no delay. A pointer on its way from Assigned
to Done has to cross the strip, the strip opens to a full column under it, and
what the operator was aiming at is no longer there.

Measured on the head, with the pointer travelling at 600, 1500 and 3000 px/s
(the same result at every speed):

| Viewport | Path | Aimed at | Where the pointer lands | How far the target moved |
| --- | --- | --- | --- | --- |
| 1440 | Assigned → Done | first Done card, 53 px inside Done | Blocked's "Nothing blocked" placeholder; Blocked stays open at 280 px | Done 1108 → 1340, 232 px right, its right part off the screen |
| 1600 | Done → Assigned | Assigned's column menu | Blocked's header | menu 1239 → 1067, 172 px left |
| 1280 | Done → Assigned | Assigned's column menu | Blocked's header | menu 871 → 703, 168 px left |

Frame: `head-sweep-1440-1500-end.png`. The pointer rests where the first Done
card was drawn; the frame shows an open, empty Blocked column there and Done
cut off at the right edge.

A target further than a column's width past the strip is still reached (Done's
menu at 1440), and the board shifts 232 px and back while the pointer travels.

Blocked is empty most of the time, and Assigned → Done is the path the pointer
takes most, so this is the everyday case.

The board already has the rule for this. `useColumnDwell.ts` waits
`DWELL_CUE_MS` (350 ms) before it draws anything, "so a pointer passing
through draws nothing".

**Fix.** Open the strip when the pointer rests in it. The requirement's
"expands on hover" still holds; a pointer that only passes through opens
nothing.

1. In `KanbanColumnView`, for a column with `strip`: start a timer of
   `DWELL_CUE_MS` on `pointerenter` from a mouse, set an `open` state when it
   fires, and clear both the timer and the state on `pointerleave`. Add
   ` open` to the section's class list while the state is set.
2. In `kanbanBoard.css`, replace `:hover` with `.open` in every strip
   selector, so the lists read `:is(.open, :focus-within, .drop)` and
   `:not(.open, :focus-within, .drop)`.
3. `.drop` and `:focus-within` stay as they are, so a dragged card and the
   keyboard open the strip at once.
4. Gate it in the existing "folds to a strip" case: at 1440, move the pointer
   from Assigned to the first Done card in steps, and require that the element
   under the pointer at the end belongs to Done and that Blocked is 48 px wide.

### F2 (P2). The strip's menu button cannot be pressed where it is drawn

The strip draws the column's `⋯` button under the name. The pointer reaching
it opens the strip, the header turns horizontal, and the button moves to the
header's far end before the press.

| Viewport | Button as drawn | Button when the pointer arrives | Under the pointer | Menu opened by the press |
| --- | --- | --- | --- | --- |
| 1280 | (934, 247) | (995, 167) | Blocked's placeholder text | no |
| 1440 | (1058, 247) | (1287, 167) | Blocked's placeholder | no |
| 1600 | (1306, 207) | (1303, 127) | Blocked's placeholder | no |

Frame: `head-stripmenu-1440.png`.

The fix for F1 leaves this in place for anyone who pauses on the button for
350 ms, so it needs its own change.

**Fix.** The strip shows its count and its name, and the menu stays in the
open column. In `kanbanBoard.css`:

```css
.kb .column.strip:not(.open, :focus-within, .drop) > .col-head > :not(h2, .n) { display: none; }
```

That drops `[data-colmenu]` from the kept children. The `--strip-w` comment
("its count, its name on end and its menu") loses "and its menu". The menu of
an empty column has nothing to act on, and it remains one rest or one Tab
away.

## 4. Over-engineering pass

Nothing to cut. The change is two custom properties, one track rule in
`kanbanLayout.ts`, two class names and about twenty lines of CSS. The
`--kb-track-*` / `--kb-open-*` pair is the lightest way to let the stylesheet
open a grid track, and both fixes above keep it.

## 5. Evidence coverage

The pull request's evidence reaches every surface the requirement names: 1280,
1440 and 1600, with no agent (no rail) and with an open agent (rail shown), the
empty column, English and Ukrainian, and the phone at 390. What it does not
gate is a pointer in motion, which is where both findings are; step 4 of the
F1 fix adds that case to the same `describe` block.

## Deferred — not currently justified

- Bringing an open agent's column fully into view after the operator widens
  another column (1280, Inbox widened: the agent's column keeps 520 px and its
  right part sits past the screen edge until the board is scrolled). The
  requirement asks for the minimum and the sideways scroll, and both hold.
- A transition on the strip's width in the scroll mode. The grid modes already
  animate their tracks; the scroll mode changes at once. Not a defect on its
  own once F1 is fixed.
- Dark scheme frames. The strip uses the column's own tokens and adds no
  colour of its own.
