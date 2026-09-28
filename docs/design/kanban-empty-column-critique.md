# Kanban desktop, empty column strip and open-agent minimum: design critique

Design review only, second round. It judges the rendered board of the pull
request head `f89772f59` (product code as of `8a0d138c2`) against the
operator's requirement, with the merge base `70ab3aa03` rendered beside it for
the before. No product source was edited.

Verdict: **REQUEST_CHANGES**. Both halves of the requirement hold at rest, in
both languages, at all three desktop widths, and the phone is unchanged. Both
findings of the first round are closed. Two defects remain, and both appear
only once the operator acts on the board: the opened strip folds under its own
menu, which is left hanging over the neighbouring column, and a search folds
columns that hold cards.

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

- The head and the merge base were exported with `git archive` into a scratch
  directory under the temp root. Every render ran from those exports with an
  isolated config root and state directory. The live worktree stayed clean.
- The pull request's own case in `kanbanBoard.browser.test.tsx` ("folds to a
  strip") ran from the head export: 1 pass, 24 frames, and the readings it
  wrote are identical to the committed
  `evidence/empty-column-strip/readings.json`.
- A scratch driver over the same harness (`serveEvidenceFixture`,
  `openFixture`, the `stages` scenario, with and without `&empty=blocked`)
  added what the case leaves out: a search typed key by key, the Overview, an
  agent open in a shelf column (Inbox and Done), the opened strip's menu under
  a mouse and under the keyboard, a drag at 1280 and 1600, 3× crops of the
  strip in the light and the dark scheme, and the phone on the merge base. The
  merge base ran with the head's fixture file, so the only difference between
  the two renders is product code.
- Prior work: `search_transcripts` for the strip and the agent minimum
  returned this pipeline's own conversations only. Nothing earlier existed.
- I looked at the frames: the case's 24, and the scratch driver's frames named
  in the findings below.

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
crops the strip reads top to bottom as the count `0` and the column name set
vertically, in English («Blocked», 46 px tall) and Ukrainian («Заблоковані»,
76 px tall), on the column's own background, in the light and the dark scheme.
Nothing is clipped, and no menu glyph is drawn.

A card dragged over the strip opens it with the drop outline (280 px at 1280
and 1440, 220 px at 1600), and the card dropped there lands in Blocked, which
then stays a full column with the count `1`. Inbox, Assigned and Done, which
hold cards, never fold at rest.

### 2.2 The open agent keeps its minimum

`--agent-min` is `clamp(520px, 40vw, 760px)`: 520 px at 1280, 576 px at 1440,
640 px at 1600. The base column is the first round's measurement of the same
merge base.

| Viewport | Agent in | Rail | Column, base | Column, head | Reader, head |
| --- | --- | --- | --- | --- | --- |
| 1280 | Assigned | full | 480 | 520 | 468 |
| 1280 | Inbox | full | 460 | 520 | 468 |
| 1280 | Done | full | 460 | 520 | 468 |
| 1280 | Assigned, Inbox widened | full | — | 520 | 468 |
| 1440 | Assigned | full | 480 | 576 | 524 |
| 1440 | Inbox | full | 460 | 576 | 524 |
| 1440 | Done | full | 460 | 576 | 524 |
| 1600 | Assigned | compact | 548 | 720 | 668 |
| 1600 | Inbox | compact | 420 | 640 | 588 |
| 1600 | Done | compact | 420 | 640 | 588 |

Every column that holds the open agent is at or above the minimum, in both
languages, with the rail shown and the strip beside it. Where the columns no
longer fit, the board scrolls sideways (1440 with the agent in Done: scroll
width 1452 px over a 992 px client), which is what the requirement asks for.
With no agent open there is no rail, and those frames are the rail-off half.

### 2.3 Non-empty columns are unchanged at rest

With the fixture as it is (no column emptied, nothing open, no search), every
column has the same left edge and width on the base and on the head at 1280,
1440 and 1600: 280/480/280/280 in the scroll mode and 220/604/220/220 in the
narrow mode.

### 2.4 The phone is unchanged

390×844 with touch, English and Ukrainian, with and without the emptied
column: four frame pairs of the board, base against head.

- Three pairs are identical pixel for pixel.
- One Ukrainian pair differs in a 6×7 px box at (212, 75), which is the last
  digit of the seat's running timer.
- No strip and no agent rule is drawn on the phone (`.column.strip` and
  `.column.agent` count 0).

The Blocked tab of the phone was compared in the first round and came out
identical. The change since then touches the desktop strip only, and this
round did not retake those frames.

## 3. The first round's findings are closed

| First round | State on this head | Measured |
| --- | --- | --- |
| The strip opens under a passing pointer | closed | 1440: a pointer moved from Assigned to the first Done card ends on Done, Blocked stays 48 px. The strip opens after the mouse rests on it (280 px at 1440, 220 px at 1600) |
| The strip's menu cannot be pressed where it is drawn | closed | the strip draws no menu button (1×1 px, clipped); on the opened strip the button is pressed and its menu opens |

## 4. Findings

### F1 (P2). The opened strip folds under its own menu, and the menu hangs over the next column

The strip is open while the mouse rests in it or focus is inside it. Its menu
is drawn outside the column, so the pointer reaching the menu's row leaves the
column, and focus moving into the menu leaves it too. The strip folds, the
columns beside it slide back, and the menu stays where it opened.

| Viewport | Input | Blocked, menu just opened | Blocked, pointer or focus in the menu | Menu's box | What the menu now covers |
| --- | --- | --- | --- | --- | --- |
| 1440 | mouse | 1048–1328 (280 px) | 1048–1096 (48 px) | 1115–1315 × 201–247 | Done's first card, right under Done's header (Done moved 1340 → 1108) |
| 1600 | mouse | 1124–1344 (220 px) | 1296–1344 (48 px) | 1131–1331 × 161–207 | Assigned's right edge and the strip's own name; the strip is 165 px to the right of the menu's left edge |
| 1440 | keyboard, Enter on the focused button | 280 px | 48 px | the same box | the same |
| 1600 | keyboard, Enter on the focused button | 220 px | 48 px | the same box | the same |

Frames: `head-menu-1440-uk-opened.png` beside `head-menu-1440-uk-on-row.png`,
`head-menu-1600-en-on-row.png`, `head-focus2-1440-menu.png`.

In the 1440 frame «Показати приховані задачі (1)» sits directly under the
heading «Готові 7» and reads as Done's menu. It is Blocked's. A column whose
tasks are all hidden is empty, so this menu is the way back to them, and the
strip is where the operator will open it.

The pull request's case presses the button and checks that a menu opens. It
never moves the pointer into the menu, so it passes.

**Fix.** Keep the strip open while its own menu is open.

1. In `KanbanBoard.tsx`, where `KanbanColumnView` is rendered, pass
   `menuOpen={menu.open?.value.kind === "column" && menu.open.value.status === status}`
   and declare `menuOpen: boolean` in the view's props.
2. In the section's class list, write the open class as
   `${strip && (stripOpen || menuOpen) ? " open" : ""}`.
3. Nothing changes in the stylesheet: `.open` already holds the track and the
   header. When the menu closes, the strip folds unless the mouse or focus is
   back inside it.
4. Gate it in the existing "folds to a strip" case at 1440 and 1600: after the
   opened strip's menu opens, move the pointer to the menu's first row, then
   require that Blocked is at least 200 px wide and that the menu's left edge
   lies inside Blocked's box. Repeat with focus on the button and Enter.

### F2 (P2). A search folds columns that hold cards, and the board moves with each key

The strip rule reads the cards a column shows after filtering
(`model.columns[status].shown`). Under a search, a column that holds cards and
matches none of them folds. The requirement describes an empty column as one
"with 0 cards", the pull request's description says "a column with no cards",
and the widths of non-empty columns are out of scope.

Typed key by key on the fixture as it is (no column emptied), Ukrainian:

| Viewport | Typed | Inbox | Assigned | Blocked | Done | First Assigned card |
| --- | --- | --- | --- | --- | --- | --- |
| 1440 | `Re` | 280 px, «2 з 3» | x 556 | 280 px, «2 з 2» | 280 px, «2 з 5» | x 569, 454 px wide |
| 1440 | `Res` | 48 px, «0 з 3» | x 324 | 280 px, «1 з 2» | 280 px, «2 з 5» | x 337 (232 px to the left) |
| 1440 | `Rest` | 48 px, «0 з 3» | x 324 | 48 px, «0 з 2» | 48 px, «0 з 5» | x 337 |
| 1600 | `Re` | 220 px | 604 px | 220 px | 220 px | 578 px wide |
| 1600 | `Res` | 48 px, «0 з 3» | 776 px | 220 px | 220 px | 750 px wide |
| 1600 | `Rest` | 48 px, «0 з 3» | 1120 px | 48 px, «0 з 2» | 48 px, «0 з 5» | 1094 px wide |

1280 behaves as 1440 does. English reads «0 of 3» and folds the same way.

Frames: `head-keys-1440-Re.png`, `head-keys-1440-Res.png`,
`head-keys-1440-Rest.png`, `head-keys-1600-Rest.png`.

What the operator sees: the third key moves the column they are reading 232 px
to the left, and at 1600 the matching card grows from 578 px to 1094 px over
two keys and its text re-wraps. Three columns that hold 3, 2 and 5 cards turn
into strips. The advice those columns gave on the merge base («Тут нічого не
знайдено. Спробуйте коротший запит.») is no longer shown. The same rule folds
an Overview column that holds cards none of which is working.

**Fix.** Fold a column only when it holds no cards at all. In
`KanbanBoard.tsx`, in the loop that fills `stripStatuses`, read the unfiltered
lists:

```ts
if (model.columns[status].cards.length || (status === "inbox" && (model.unlinked.length || composingTask))) continue;
```

A column that reads `0` stays a strip under a search (it reads «0 з 0»). A
column whose tasks are all hidden still reads `0` and still folds. Gate it in
the same case: on the fixture without `&empty`, type `Rest` at 1440 and
require that no column is a strip and that Assigned's left edge has not moved.

## 5. Over-engineering pass

Nothing to cut. The change is two custom properties, one track rule in
`kanbanLayout.ts`, three class names, one timer and about twenty-five lines of
CSS. The `--kb-track-*` / `--kb-open-*` pair is the lightest way to let the
stylesheet open a grid track. F1 adds one prop, and F2 changes one condition.

## 6. Evidence coverage

The pull request's evidence reaches every surface the requirement names: 1280,
1440 and 1600, with no agent (no rail) and with an open agent (rail shown), the
empty column, English and Ukrainian, and the phone at 390. It gates the pointer
in motion, which the first round asked for. It does not gate the opened
strip's menu past the press, nor a search; the fixes above add both to the
same `describe` block.

## Deferred — not currently justified

- At 1280 the opened strip ends 48 px past the right edge of the screen
  (1048–1328 in a 1280 px window), so its menu and widen buttons are reached
  by scrolling the board. The merge base draws Blocked in the same place at
  that width, so this is the scroll mode as it was.
- Bringing an open agent's column fully into view after the operator widens
  another column (1280, Inbox widened: the agent's column keeps 520 px and its
  right part sits past the screen edge until the board is scrolled). The
  requirement asks for the minimum and the sideways scroll, and both hold.
- A transition on the strip's width in the scroll mode. The grid modes already
  animate their tracks; the scroll mode changes at once.
- The count under a filter in a strip: «0 of 3» is 30 px wide and «0 з 3» is
  25 px in the 48 px strip, so totals up to three digits fit. With F2 fixed a
  strip under a filter only ever reads «0 of 0».
