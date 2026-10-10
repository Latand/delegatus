# Orchestrator wires: hover, click, and staying on the card while scrolling

## Originating requirement

Operator, 2026-10-10 ~11:10 Kyiv, voice, Russian, verbatim:

> «Вот эта стрелочка к. Минус её. Во-первых, я не могу найти на линию и быстро
> перейти к тому, к той задаче, которую он... которую... на которой он
> указывает. Я бы хотел, чтобы можно было на нелинию навести. На линию навести
> и. Можно было переключиться быстро, перейти к тому. При этом, когда я скроллю,
> то у меня эта линия скачет туда-сюда, и не совсем. Правильно попадает на
> задачи, только с задержкой. Это, наверное, какой-то баг. Тоже исправляй прямо
> зараз.»

In short, the operator asks for two things:

1. Point at a wire, see which task it leads to, and go to that task quickly.
2. While the operator scrolls, the wire jumps back and forth and reaches its
   task late. Fix it.

The pinned acceptance (abridged): a hit area wider than the stroke; hover
highlights the wire and both ends and names the task; a click or a tap brings
the task into view and focuses it **through the board's existing focus path**;
keyboard reachable; the wire stays on its card on every frame of every kind of
scroll; routing, card clicks and chrome otherwise unchanged; DOM and browser
driver tests that fail on main; rendered evidence at 1440 and 390, en and uk,
including a mid-scroll frame.

## 1. How wires are drawn and repositioned today

| What | Where |
|---|---|
| Mounted by the desktop board, one per board | `src/components/kanban/KanbanBoard.tsx:2842` |
| Mounted by the phone board | `src/components/mobile/MobileKanban.tsx:1182` |
| React shell: creates the layer on the first seat action, hands it tones and actions, calls `sync()` after **every** board render | `src/components/kanban/SeatActionWires.tsx:41-64` |
| Imperative layer: `createOrchestratorWires({ root, phone })` | `src/components/kanban/orchestratorWires.ts:99` |
| Layer element: one `div[data-orchestrator-wires]` with an `svg` (wires, seat ports, rings) and an HTML `div` (counts, pulse dots), appended to the board root, `aria-hidden` | `orchestratorWires.ts:187-199` |
| Layer CSS: `position: fixed; inset: 0; z-index: 5; pointer-events: none` | `src/components/kanban/kanbanBoard.css:1883` |
| Repositioning triggers: a capture-phase `scroll` listener on `window` (sees every scroller), `resize`, a `ResizeObserver` on the root, and `sync()` after renders, all funnelled into one `requestAnimationFrame` | `orchestratorWires.ts:162`, `:200-209`, `SeatActionWires.tsx:62-64` |
| One pass: reads the seat, each wired card, its `.col-body` and column with `getBoundingClientRect`, in **viewport** coordinates, then rewrites every path's `d`, every port's `cx/cy`, rings and counts | `orchestratorWires.ts:367-509`, `locate()` `:234-256` |
| Coordinates: "Inside the layer every coordinate is the viewport's" | `orchestratorWires.ts:373-374` |
| Route: fewest bends, then shortest; every route but the straight one ends down the column's gutter (`column.left - 9`, phone `column.left + 5`) into the card's port | `route()` `orchestratorWires.ts:294-365` |
| Scrolled-out cards become a dashed count at the column edge | `orchestratorWires.ts:249-254`, `:456-486` |
| Lifetime: 60 s hold + 1.6 s fade; at rest no element, no listener | `orchestratorArrows.ts:14-16`, `orchestratorWires.ts:585-599` |

The scrollers a wired card sits in (measured in Chromium on the
`orchestrator-arrows` fixture):

| Form | Card's scrollers (inner → outer) | Seat's scrollers |
|---|---|---|
| 1440, seat at the side | `.col-body` (y, `kanbanBoard.css:325`), `.board.scroll` (x, `:207`), `.kb-page` (y) | none |
| 1440, seat on top | `.col-body`, `.board.scroll`, `.kb-page` | `.kb-page` |
| 390 phone | `section[data-phone-kanban-column]` (y, `MobileKanban.tsx:1236-1237`), `[data-phone-kanban-pager]` (x, scroll-snap) | none |

The layer itself is in **none** of them: `position: fixed`, outside every
scroller.

## 2. Root cause of the lag and the jumping

**The cards are moved by the compositor; the wire is moved by script.**

- Every scroller above is a threaded (compositor) scroller. A wheel, trackpad
  or touch scroll moves the cards on the compositor thread and presents that
  frame at once, without waiting for the main thread.
- The wire is a script-drawn overlay outside every scroller
  (`kanbanBoard.css:1883`, `orchestratorWires.ts:189-199`). It moves only when
  the main thread receives the `scroll` event (`orchestratorWires.ts:200`), runs
  the frame callback (`:162`), reads layout (`:127`, `:240-244`) and rewrites
  `d`/`cx`/`cy` (`:440-443`).
- Each frame the compositor presents ahead of the main thread shows the card in
  its new place and the wire in its old one. When the main thread catches up,
  the wire snaps to the card. Then the compositor moves the card again. The
  result is the "jumps back and forth, reaches the task late" that the operator
  describes. The gap is one frame's scroll delta or more: a wheel tick moves a
  column 40–100 px in one or two frames, and a busy main thread (a board render,
  the wire pass itself costs up to 20 ms at CPU ×4) widens it.

The documented design accepted this risk: `docs/design/orchestrator-arrows.md:234-236`
("reads only the scroll offsets of scrolled columns on `scroll`, and draws in
the next animation frame"). It is the scroll-linked-effect pattern that browsers
with asynchronous scrolling cannot keep in sync.

### Measurements (this stage, headless Chromium from an export of `0aae47ee2` under the stage's temporary directory)

The `orchestrator-arrows` fixture, wire to `t-upload` (Assigned), a 1600 px
spacer in its column. A blue 3 px line marks the card's top edge, inside the
scroller. Red is today's port. Green is a twin of the port in the same fixed
layer, moved by a `ScrollTimeline` on the card's column (the mechanism proposed
in §3). The screenshots are taken while a wheel gesture over the column runs.
"Off" counts the samples in which the marker's distance from the card's top
edge differs from its distance at rest by more than 1 px.

| Run | Form, CPU | Samples | Today's port: off / worst | ScrollTimeline twin: off / worst |
|---|---|---|---|---|
| 1 | 1440 ×1 | 30 | 2 / 12 px | 0 / 0 |
| 1 | 1440 ×4 | 12 | 3 / 24 px | 0 / 0 |
| 2 | 1440 ×4 | 8 | 2 / 40 px | 0 / 0 |
| 3 | 1440 ×4 | 17 | 2 / 84 px | 0 / 0 |
| 4 | 1440 ×4 | 22 | 3 / 24 px | 0 / 0 |
| 3–4 | 390 ×1 | 4–44 | 0 / 0 | 0 / 0 |
| 1, 4 | 390 ×4 | 7–33 | 0 / 0 | 1 / 36 px, 1 / 12 px |

The interrupted first attempt measured the same thing on main: 80.5 px from port
to card top mid-scroll against 20.5 px at rest (a 60 px lag), and 30 px on the
phone at ×4.

Two control probes isolate the cause:

- **The main thread is consistent within a frame.** A probe that reads the card
  and the port after every frame callback and layout, before paint (a
  `ResizeObserver` delivery), found 0 frames out of 12 scroll frames in each of
  the 4 configurations (desktop and phone, wheel and per-frame programmatic
  `scrollTop`) in which the port disagreed with the card. The frame callback
  scheduled from the `scroll` event runs in the same frame. The lag therefore
  lies between what the compositor presents and what the main thread has drawn,
  and a faster main-thread pass cannot remove it.
- `--disable-threaded-scrolling` did not remove the gaps in
  `chrome-headless-shell` (one 110 px sample). The headless shell does not
  appear to honour that switch, so the result says nothing either way. The twin
  comparison above, run in the same frames, is the deciding evidence.

Not reproduced: the phone at 390 in headless emulation rarely shows the lag (no
real touch pipeline), and the twin had two outliers there. The browser case in
§6 measures the phone on every run; a real device is the final check (see
Notes).

## 3. Keeping the wire on its card on every frame

### Options

| Option | Card end on every frame | Cost | Verdict |
|---|---|---|---|
| A. Faster main-thread pass (sync in the `scroll` handler, fewer rect reads) | No: the main thread is already same-frame (probe above). The compositor still runs ahead | small | rejected, it does not address the cause |
| B. Hijack scrolling (non-passive `wheel`, scroll by script) | Yes on wheel, breaks trackpad momentum, touch and keyboard | large, regressive | rejected |
| C. Move the wire into the scroll content | The desktop gutter (`column.left - 9`) lies **outside** `.col-body`, which clips with `overflow-x: hidden` (`kanbanBoard.css:325`), so the trunk cannot be drawn there. That works on the phone only | medium, two mechanisms | rejected |
| D. CSS anchor positioning | Scroll compensation covers one anchor per element; a wire has two. Whether the compensation is composited, and whether it holds across nested scrollers, is unverified | medium, uncertain support | rejected |
| **E. Scroll-timeline riders** (recommended) | Yes: the browser applies a `ScrollTimeline`-driven `transform` with the scroll offset of the same frame. Measured 0 desktop samples off (table above) | moderate, contained in `orchestratorWires.ts` | **chosen** |

### Design E: a wire in two pieces, the card's piece rides the scrollers

Split each drawn wire at the top of its column's visible part (the
`.col-body` box; the column section on the phone):

- **Seat piece**: today's full route path, unchanged, in today's fixed SVG,
  with a static clip that removes the column's visible box. It covers the seat's
  port, the bus and the gutter down to the column's top. A column scroll never
  moves any of it, so it cannot lag. Existing route tests keep reading the same
  `d` (§6).
- **Card piece**: the gutter run from the column content's top down to the port,
  the elbow, the port dot and the pulse ring. It sits inside a **clip box**
  (an HTML `div`, `overflow: hidden`) equal to the column's visible box widened
  left over the gutter (for the straight side route, widened to the seat's right
  edge), and inside that a **rider** `div` animated by
  `element.animate([{ transform: "translateY(0)" }, { transform: "translateY(-max)" }], { timeline: new ScrollTimeline({ source: colBody, axis: "block" }), fill: "both" })`,
  where `max = scrollHeight - clientHeight`. The card piece is drawn at
  scroll-zero coordinates (viewport y + the scroller's current `scrollTop`).
  Its trunk starts at the column content's top, so at any offset it reaches up
  past the clip's top edge, and the clip cuts it exactly at the column's top.
- **Outer scrollers**: each scroller that holds the card is wrapped the same way,
  one rider per axis with a non-zero range: `.board.scroll` x, `.kb-page` y, the
  phone pager x. A rider that holds both the seat and the card (`.kb-page` with
  the seat on top) wraps **both** pieces, so the whole wire rides it. Nesting
  order is outer to inner: page, board, then the clip box, then the column rider.
- The riders and clips are HTML `div`s around their own `svg`. Chromium
  composites transforms on boxes, never on elements inside an `svg`.
- **Rebuilt on the main thread as today**: `update()` keeps running on scroll,
  render and resize. It redraws each piece at scroll-zero coordinates, which a
  scroll does not change, and re-keys a rider's keyframes when `max` changed (a
  render added cards). A count (`↑ +N`) still replaces a card that leaves the
  visible part, one main-thread frame after the edge. Until then the clip cuts
  the port at the edge, so nothing is painted over the header.
- **Fallback**: with no `typeof ScrollTimeline === "function"` there are no
  riders and no scroll-zero offset. That is exactly today's drawing. DOM tests
  (happy-dom) run this path.

What stays as it is: `route()` and its choice (fewest bends, then shortest),
the tones, the pulse dot (one 820 ms pass along today's full `d`), the fades,
the hold and the cost at rest (no element, no listener).

**Residual, stated plainly:** a horizontal scroll of `.board.scroll` (or a
phone pager swipe) moves the column's gutter under a seat that stays put. The
card piece follows on the compositor, while the seat piece's bus is redrawn by
the main thread. For the main thread's latency the two can meet a few pixels
apart at the column's top. The card end never lags. Closing that seam too is
deferred (below).

## 4. Hit area, hover, click, keyboard

### Hit area

- Each piece gets one more path per wire: `path.oa-hit`, the same `d`,
  `stroke: transparent; stroke-width: 12px` (desktop and phone),
  `stroke-linecap: butt`, `pointer-events: stroke`, `cursor: pointer`. The layer
  keeps `pointer-events: none`, so only the strokes take the pointer.
- **No card is covered.** The gutter strip spans `column.left - 15` to
  `column.left - 3`. The column gap is 12 px (`kanbanBoard.css:207`) and
  `.col-body` pads 12 px (`:325`), so the nearest card edges are 25 px left and
  13 px right of the gutter. The butt cap ends the stroke at the port's
  `into = card.left - 3.5`, outside the card.
- **No column link or seat control is covered.** The seat piece's static clip
  also removes the boxes of the blocks `update()` already reads (`.tabs-nav`
  buttons and the quiet strip's controls, `orchestratorWires.ts:384`). The
  visible stroke never enters them anyway, since routing keeps 2 px clear
  (`:284-285`).
- Counts (`↑ +N` / `↓ +N`) take the same hit stroke on their dashed wire, and
  the chip itself takes the pointer too. Their target is the nearest hidden card
  in that direction. (As built, the chip does not: see below.)

### Hover (desktop) and focus

- `pointerenter` on a hit path (or `focus` from the keyboard) sets `data-hover`
  on that wire's groups in both pieces and on the seat port its route leaves
  from. CSS: the stroke widens 1.5 → 2.5, the card port 3.5 → 5, the seat port
  4.5 → 6, and every other wire dims to 0.35. This is the "pointer emphasis" of
  Variant 1 (`docs/design/orchestrator-arrows.md:266-268`). No new chrome.
- The task's title shows in the board's existing bubble: `TooltipBubble`
  (`src/components/TooltipBubble.tsx:40`) with the class `Hint` gives it
  (`src/components/Hint.tsx:198`, exported as a constant) and `Hint`'s 150 ms
  delay (`Hint.tsx:8`). `SeatActionWires` renders it. The layer reports
  `onHover(taskId | null, anchor)`, where `anchor` is a zero-size span in the
  layer's HTML part at the pointer (on keyboard focus, at the card's port).
  The text is `taskTitle(task.text)` (`src/components/tasks/taskModel.ts:27`)
  from the `tasks` the component already receives. It is the task's own title
  and needs no translation.
- A wire that fades while hovered fades as today; its bubble closes with it.

### Click, tap and keyboard: the board's existing focus path

- **Desktop**: the layer calls `host.onJump(taskId)`. `KanbanBoard` passes
  `(taskId) => { revealCard(\`task:${taskId}\`); focusCard(\`task:${taskId}\`); }`.
  These are the two calls a pipeline link already makes
  (`KanbanBoard.tsx:2202-2208`). `revealCard` (`:1909`) closes the agent window
  over the board, unfolds the card, clears a filter that hides it and switches
  the tab on a tabbed board. `focusCard` (`:2224`) scrolls the card into view
  (smooth unless reduced motion), focuses it and flashes it (`flash`, `:789`,
  `.card.flash`, `kanbanBoard.css:393`). Nothing new.
- **Phone**: the phone board has no focus-a-card path of its own. A drawn wire
  always leads into the open tab (a card in another tab is "away" and pulses its
  tab, `orchestratorWires.ts:421`), so `MobileKanban` passes
  `(taskId) => { card.scrollIntoView({ block: "nearest" }); card's button.focus({ preventScroll: true }); wires.ring(taskId); }`.
  The highlight is the wire's own existing ring (`pulse()`'s `oa-ring`,
  `orchestratorWires.ts:552-563`), exposed as `ring(taskId)`. On the phone, a
  tap on a count scrolls its hidden card into view.
- **Keyboard**: only the card piece's hit path is focusable (`tabindex="0"`,
  `role="link"`, `aria-label` = new i18n key `kanban.wire.goTo`:
  en "Go to {title}", uk "Перейти до «{title}»"). Enter and Space call
  `onJump`. `aria-hidden` moves from the layer to the visual SVGs, so the
  focusable path is not hidden from assistive technology. The wires come after
  the board's other controls in tab order (the layer is the root's last child),
  where the cards (`KanbanCard.tsx:525`, `tabIndex={0}`) already are. If a
  focused wire ends, focus goes to `.board-frame` (`KanbanBoard.tsx:2914`), the
  board's own fallback.

## 5. The phone at 390 px

- Scrollers: the open tab's column section (y) and the pager (x, snap). The
  seat card is in neither. The card piece rides the column's y timeline inside a
  clip equal to the section's visible box. The gutter (`column.left + 5`) lies
  inside the section, so the clip needs no widening. The pager x rider wraps the
  clip box, so a swipe carries the card piece away with its column until the
  wire turns "away" and pulses the target tab, as today.
- Hit stroke 12 px: x from `column.left - 1` to `column.left + 11`, inside the
  page's 12 px left margin, never over a card. A tap on it calls `onJump`.
- No hover on touch: the title is not shown. The tap leads to the card, which
  shows the title itself.
- Trade-off: while a wire is shown (about a minute after an action), a drag that
  starts on that 12 px strip scrolls the layer's ancestors and leaves the column
  where it is. A drag anywhere else is unaffected.

## 6. Tests that would fail on main

All by path, under isolated state (`HOME`, `XDG_CONFIG_HOME`, `TMPDIR`,
`LLV_STATE_DIR` under the stage's temporary directory,
`LLV_VIEWER_CONTROL_URL` on a closed port), through `scripts/gate-slot.sh`.

### DOM: `src/components/kanban/orchestratorWires.dom.test.ts`

New cases (each red on main because no `.oa-hit`, `onJump`, `onHover` or rider
exists there):

1. *A drawn wire has a hit path wider than its stroke, ending short of the card
   and clear of the column links*: `g[data-wire] path.oa-hit` exists with a
   stroke width of at least 12 and butt caps. Its last point lies at or left of
   the card's left edge minus 3.5. The seat piece's clip excludes each
   `.tabs-nav` button box.
2. *Hover marks the wire and both its ends and names the task*: `pointerenter`
   on the hit path sets `data-hover` on the wire's groups and on its exit seat
   port, dims the others, and calls `host.onHover("t-1", anchor)`;
   `pointerleave` clears it all.
3. *Click, Enter and Space go to the task through the host*: each calls
   `host.onJump("t-1")` once. The hit path has `tabindex="0"` and
   `role="link"`, and the visual SVG is `aria-hidden`.
4. *The card's piece rides its column's scroll*: with a stub global
   `ScrollTimeline` that records `{ source, axis }` and a spy on `animate`, the
   card piece's rider is animated on a timeline whose `source` is the card's
   `.col-body` and whose axis is `block`. With `scrollTop = 120` the port's `cy`
   equals the card's port y + 120. A scrolled board (`.board.scroll`) adds a
   rider with an `inline` timeline around the clip box.
5. *A focused wire that ends returns focus to the board*: advance past
   hold + fade, and `document.activeElement` is `.board-frame`.
6. Guard, green on main and after: *without `ScrollTimeline` the wire is drawn
   in viewport coordinates as today*. All route-geometry cases at `:300-727`
   still pass unchanged, because the seat piece keeps today's full `d`.

### Board wiring: an existing DOM test that renders the board with a seat (for example `src/components/kanban/KanbanAskOrchestrator.dom.test.tsx`'s harness), or a new case in the browser block

7. *A wire's click reveals and focuses the card*: after a seat action, a click
   on the hit path leaves the card with `.flash`, makes it
   `document.activeElement`, and clears a filter that hid it.

### Browser driver: `src/components/kanban/kanbanBoard.browser.test.tsx`, `describe("orchestrator wires after a seat action")` (`:25906`)

8. *A wire stays on its card on every frame of a scroll*: at 1440 (seat at the
   side and on top) and at 390, CPU ×4. A wheel gesture over the card's column
   (desktop), a touch `Input.synthesizeScrollGesture` with integer coordinates
   (phone; fractional ones are refused with "Position out of bounds"), a
   per-frame programmatic `scrollTop`, and `focusCard`'s smooth
   `scrollIntoView`. Screenshots taken during the scroll; in every sample in
   which both are visible, the port's distance from the card's top edge equals
   its distance at rest within 1 px; at least 10 samples measured. Red on main:
   2–3 of 12–22 samples off by 24–84 px at 1440 (table in §2). A second check
   at 1440 scrolls `.board.scroll` sideways and asserts the card end only.
9. *Hover and click a wire* at 1440, en and uk: hovering the trunk's midpoint
   shows a bubble whose text is the task's title and marks the wire
   (`data-hover`). A click flashes the card, puts it inside its `.col-body`'s
   box and focuses it. Tab reaches the wire and Enter does the same. At 390 a
   tap on the wire leaves the card in view, ringed and focused. Red on main: no
   bubble and the click lands on whatever is under the layer.
10. *Wires stay out of card clicks*: `elementFromPoint` at the centre and at 4 px
    inside the left edge of every wired card returns the card, and at the
    trunk's midpoint the hit path. Green on main for the cards, red for the
    trunk.

Rendered evidence through the same block into `.artifacts/orchestrator-wires`:
1440 and 390, en and uk; the wire at rest, hovered with its bubble, after a
click (flash), and **mid-scroll** (a frame taken while case 8's gesture runs).
Close every browser the case opens; the block's case scope already does
(`issue1695BrowserHarness`).

Checks for the implementing lane: `bunx tsc --noEmit`, eslint on the changed
files, the local privacy gate with the fingerprints environment, and the touched
tests above, each by path.

## 7. Scope of the change

`src/components/kanban/orchestratorWires.ts` (pieces, riders, hit paths,
`onHover`/`onJump`/`ring`), `SeatActionWires.tsx` (bubble, callbacks),
`kanbanBoard.css` (the `[data-orchestrator-wires]` rules at `:1883-1899`),
one prop in `KanbanBoard.tsx` and in `MobileKanban.tsx`, one exported class
constant in `Hint.tsx`, one i18n key in `en.ts` and `uk.ts`, and the three test
files. Outside the fences: the voice companion, `pipelines/engine.ts`, the relay
and the Windows terminal tests.

## Validation against the requirement

- "навести на линию… быстро перейти к задаче": a 12 px hit stroke, a title
  bubble on hover, and a click or tap that goes through the board's own
  `revealCard` + `focusCard` (§4).
- "когда я скроллю… линия скачет… попадает на задачи с задержкой": the root
  cause is the compositor moving the cards while script moves the wire (§2,
  measured). The card's piece now rides the same scroll in the same frame (§3).
  The measured twin of the port stayed on the card in every desktop sample.

## As built

Where the implementation differs from the design above, and what it measured:

- **Coordinates.** The pieces are drawn in viewport coordinates as before, inside a
  `[data-oa-shift]` box translated by the scroll offsets the pass read. The riders
  subtract the live offsets, so at the moment of the pass the two cancel and from
  there the piece moves with its scroller. This is the same result as drawing at
  scroll-zero coordinates, and the geometry tests keep reading viewport values.
- **Pieces.** The seat's piece (`g[data-wire]`) keeps the whole route and is cut
  out of the column's box by an even-odd `clipPath`, which also cuts out the
  column links and a strip's controls. The card's piece (`g[data-wire-end]`)
  holds the gutter run from the top of the column's content, the port and the
  hit stroke the keyboard reaches. A flowing wire's dashes and an action's growth
  carry on across the cut.
- **Which boxes scroll** is read once and again only after a render or a resize.
  A scroll changes only offsets and ranges. All rider writes come after every
  read in a pass. On the hundred-card board, a pass cost 9.0 ms on the desktop
  against 10.2 ms for the old layer on the same machine and run, and 1.8 ms on
  the phone against 0.9 ms. With the board's visible part and the tabs read as
  well it measured 8.5 ms and 1.1 ms in a later run, 44 and 33 box reads a pass
  (`evidence/orchestrator-wires/cost.json`).
- **The phone's jump** lives in `SeatActionWires`: with no `onJump` from the
  board it scrolls the card into view, focuses it and calls `ring()`.
  `MobileKanban.tsx` is unchanged.
- **Only inside the board's visible part.** A pass reads the boxes that clip the
  columns (`.board`, `.kb-page`, the phone's pager) and keeps every wire inside
  them. A card whose port the board has scrolled sideways under its left edge
  counts as away, and the boxes of the card's piece, the seat piece's cut and a
  count's dashed wire stop at that edge (at the seat's own edge for a seat at the
  side). A margin that would fall under a scrolled-out first column stays at the
  board's edge. Before this, a board scrolled fully right at 1440 left hit strokes
  over 1295 points of the seat panel (side) and 1211 of the app's sidebar (top) on
  a 2 px grid; now none (`evidence/orchestrator-wires/out-of-the-way.json`).
- **The column tabs.** Routing goes round the tabs only under a seat on top, as
  before. The hit strokes are cut at the tabs in every placement: a 12 px stroke
  along the bus with the seat at the side, or down the phone's margin, took the
  edge of a tab (at 1440 side up to 45 points of a tab, at 390 the left edge of
  Inbox). The drawn wire is not cut there, so nothing moves.
- **A count's chip takes no pointer.** It stands over the column's first visible
  card, so a chip that took the pointer would take that card's clicks. Its dashed
  wire's hit stroke leads to the nearest hidden card.
- **Measured** with case 8 (`evidence/orchestrator-wires/scroll.json`, CPU ×4).
  This branch had 0 frames off in 23–30 measured frames for each of 1440 side (en),
  1440 top (uk), 390 (en) and 390 (uk). The old layer, run through the same case,
  had one frame 75 px off at 1440 with the seat on top, and in an earlier run one
  frame off with the seat at the side. Both runs against the old layer failed.
  The lag shows in roughly one frame of thirty, so the case now measures at least
  30 frames per form.

## Deferred — not currently justified

- **A seamless seat-side junction during a horizontal board scroll or a pager
  swipe.** Each route segment would be assigned to the scroller of its own end,
  and every crossing would be drawn overlong and clipped at the scroller's edge
  or along the seat's edge. That means splitting every route kind in `route()`.
  The operator's complaint is about the card end, and the card end is exact
  without it. Bring it back if the evidence frames of case 8's sideways scroll
  show a visible seam at the column's top.
- **Hover pausing a wire's fade.** The requirement does not ask for it.
- **A hover title on the phone (long-press).** A tap already leads to the card,
  which shows its title.
- **A list of every hidden card's title on a count.** A count leads to the
  nearest hidden card; after that card becomes a wire, it names itself.
- **The keyboard order next to the seat** (inserting the hit paths after the
  seat in the DOM). That would mean inserting foreign nodes among React's
  children, for a small gain in order.

## Notes

- `ScrollTimeline` exists in Chromium 115+ and Safari 26+; Firefox has no
  shipped support. There the fallback is today's behaviour, so nothing gets
  worse.
- The phone was measured only in headless emulation, where the lag is rare and
  the twin had two outliers (36 px and 12 px, at CPU ×4). Case 8 measures it on
  every run. A check on a real phone after the deploy is the final word.
- Probes used for §2 lived only in the stage's temporary export and are not
  part of this change; case 8 is their durable form.
