# Orchestrator arrows and action animation

The operator asked on 2026-09-14 and again on 2026-09-15 (marked critical) for
arrows from the orchestrator to the tasks it runs, a short animation when it
moves a task or creates a pipeline, and graphs that read like n8n. Epic #1695
lists "manager arrows and operations feed" as not done. This document reads the
board as it is, defines what an arrow connects, and puts three working
prototypes side by side. It ends with a recommendation and numbered questions
for the operator.

**Decided 2026-10-06, and built: §9.** The operator chose the look of Variant 2,
drawn only for about a minute after the orchestrator acts and then faded. §1 to
§8 are the design as it was put to the operator, kept as the record of the three
variants; the prototype layer, its fixture switch (`&arrows=N`) and the frames
they name stayed on the design branch (draft PR #2467) and are not in the
product. What is in the product:

- The seat's actions and the link rule: `src/components/kanban/orchestratorArrows.ts`
- The wires: `src/components/kanban/orchestratorWires.ts`, fed by
  `src/components/kanban/SeatActionWires.tsx` on the desktop board and the phone
- Who moved a task: `statusBy` on the task row (`src/lib/tasks/types.ts`)
- Fixture: `?scenario=orchestrator-arrows` (`&many=1` for about a hundred cards)
  in `src/components/kanban/issue1695Evidence.fixture.tsx`
- Driver: the `orchestrator wires after a seat action` block in
  `src/components/kanban/kanbanBoard.browser.test.tsx`
- Readings: `evidence/orchestrator-wires/`

## 1. The board today

**Desktop.** `KanbanBoard.tsx` draws four columns, each a
`section.column[data-status]` with its own `.col-body` scroller. A card is
`.card[data-id="task:<id>"]` (`KanbanCard.tsx`); its pipelines render inside it
as `PipelineBlock` (`[data-pipeline="<id>"]`). The seat (`KanbanSeat.tsx`) is the
project's orchestrator conversation in one of three shapes: centred above the
columns, folded to a 40 px strip, or a full-height column on the left.

**Phone.** `MobileKanban.tsx` shows one column at a time under four tabs
(`[data-phone-kanban-tab]`); a card is `[data-phone-card="task:<id>"]`. The seat
is a card above the tabs (`MobileSeatCard.tsx`) with a one-line status
(`[data-mobile2-seat-now]`).

**How a task, a lane and the seat link.** A pipeline names its tasks in
`Pipeline.taskIds` and its owner in `Pipeline.srcConversationId`: the seat that
created the lane, which stays the owner when the seat's deputy made it
(`srcDeputyConversationId`, docs/design/ghost-seat.md). A task names its
conversations in `assignments`, and a conversation the seat spawned carries the
seat in `FileEntry.durableLineage.parentConversationId`. All three records
travel in `/api/files`.

**How changes arrive.** `useFiles` reloads `/api/files` on the runtime bus's
`files.revision` event (400 ms debounce) as a row-level delta
(`src/lib/filesDelta.ts`: changed tasks and pipelines only), on the local
`llv:tasks-changed` / `llv:pipelines-changed` events, and every 10 s when the
bus is down. Every action the seat takes reaches every open board through that
one path.

**Motion that already exists.** When a card's column changes, the board flies a
clone of it from the old place to the new one (`fly()` in `KanbanBoard.tsx`,
420 ms) and rings it on landing (`.card.landed`). It does this for every move,
whoever made it, and draws a static outline instead when more than six cards
move at once or motion is reduced. The pipeline graph inside a card already has
a wire vocabulary in `kanbanBoard.css`: dashed is drawn but not travelled
(`.pedge`), solid is travelled, and a live edge flows in the accent colour
(`.pedge.live`, `kb-edge-flow`). The phone has no move motion.

**What is missing.** Nothing on the board connects the seat to its cards, and
the board cannot say who moved a card: a task row records its status and
`updatedAt` and nothing about the writer.

## 2. What an arrow connects

One wire per card, from the seat to the task card. A card gets a wire when the
seat runs it:

1. a pipeline on the task whose `srcConversationId` (or
   `srcDeputyConversationId`) is the seat, the lane neither closed, hidden nor a
   draft; or
2. a conversation on the task whose `durableLineage.parentConversationId` is the
   seat.

Done tasks get no wire; the seat has let go of them. A card carries one wire
however many lanes and agents the seat has on it, and its tone is the most
urgent of them: **needs** (a lane in `needs_decision` / `needs_review`, or a
spawned agent waiting on input) in the warning colour, **live** (a running or
provisioning lane, a working agent) in the accent colour, **idle** (everything
else) in the muted edge colour. A wire never points at an agent or a stage: the
card already draws its stages, and a second graph inside the card would compete
with it.

`orchestratorLinks()` in the prototype is this rule, and its tests pin it. It
reads only what `/api/files` already carries. On the hundred-card board it takes
under 0.05 ms per pass (§6).

## 3. The three variants

Every frame below is a real board in Chromium over the fixture, captured by the
driver. The band above each frame prints the variant number and what the frame
shows. Action frames are frozen 0.7 s into the motion.

### Variant 1: on demand

Nothing is drawn at rest except a small port on the left edge of each card the
seat runs. Pointing at the seat (or giving it focus) draws a curved arrow from
the seat's mark to every port; pointing at one card draws only its arrow. The
wires pass behind the cards they do not end at (an SVG mask cut from the card
boxes), so a crowded column stays readable. When the seat acts, the arrow to
that card draws itself, a dot runs along it, and the card (or, for a lane
action, the lane block) is ringed with a caption: *Orchestrator: Assigned →
Blocked*, *Orchestrator started a pipeline*, *Orchestrator launched Review ui*.
On the phone the ports stay and the arrows appear only while the seat acts; a
card in another tab is reached through its tab, which pulses.

| Frame | Desktop | Phone |
| --- | --- | --- |
| At rest | `orchestrator-arrows/v1-desktop-rest.png` (pointer on the seat) | `orchestrator-arrows/v1-phone-rest.png` |
| Moves a task | `orchestrator-arrows/v1-desktop-move.png` | `orchestrator-arrows/v1-phone-move.png` |
| Starts a pipeline | `orchestrator-arrows/v1-desktop-pipeline.png` | `orchestrator-arrows/v1-phone-pipeline.png` |
| Launches a stage | `orchestrator-arrows/v1-desktop-stage.png` | `orchestrator-arrows/v1-phone-stage.png` |
| ~100 cards | `orchestrator-arrows/v1-desktop-many.png` | — |

### Variant 2: live graph

The n8n reading. The seat is a node on the left (its side placement) with one
output port; wires are always drawn. They run along a bus in the gap above the
columns, down the gutter left of each column, and into a port on each card, with
rounded corners. A column holds one trunk however many of its cards the seat
runs, so wires never cross a card. Wires to running lanes flow the way the
card's own live edge does. On a move the old branch fades as a dashed ghost and
a pulse runs down the new one; a new pipeline grows its branch from the trunk; a
launched stage sends a pulse down the existing wire to the ringed lane. On the
phone the gutter is the left margin: a spine runs down from the seat card and
branches into each card of the open tab. When the seat sits on top, each trunk
drops straight from the seat strip.

| Frame | Desktop | Phone |
| --- | --- | --- |
| At rest | `orchestrator-arrows/v2-desktop-rest.png` | `orchestrator-arrows/v2-phone-rest.png` |
| Moves a task | `orchestrator-arrows/v2-desktop-move.png` | `orchestrator-arrows/v2-phone-move.png` |
| Starts a pipeline | `orchestrator-arrows/v2-desktop-pipeline.png` | `orchestrator-arrows/v2-phone-pipeline.png` |
| Launches a stage | `orchestrator-arrows/v2-desktop-stage.png` | `orchestrator-arrows/v2-phone-stage.png` |
| ~100 cards | `orchestrator-arrows/v2-desktop-many.png` | `orchestrator-arrows/v2-phone-many.png` |

### Variant 3: action trails

Nothing is drawn at rest. Each action draws a one-shot arc from the seat to the
card over everything, rings the card and captions it; a move also leaves a
dashed ghost where the card stood and a dashed trail from the ghost to the new
place. Every action is written into an operations line beside the folded seat
(the newest first, three entries; hovering one draws its arc again). On the
phone the newest action replaces the seat card's status line for as long as it
is the newest.

| Frame | Desktop | Phone |
| --- | --- | --- |
| At rest | `orchestrator-arrows/v3-desktop-rest.png` (after three actions, pointer on the oldest entry) | `orchestrator-arrows/v3-phone-rest.png` |
| Moves a task | `orchestrator-arrows/v3-desktop-move.png` | `orchestrator-arrows/v3-phone-move.png` |
| Starts a pipeline | `orchestrator-arrows/v3-desktop-pipeline.png` | `orchestrator-arrows/v3-phone-pipeline.png` |
| Launches a stage | `orchestrator-arrows/v3-desktop-stage.png` | `orchestrator-arrows/v3-phone-stage.png` |

## 4. Many tasks and the phone

All three variants share the same rules for a full board:

- **Scrolled out of a column.** Cards the column body has scrolled past are not
  wired one by one. Their count sits at the column's top or bottom edge
  (`↑ +3`, `↓ +24`), and one dashed wire goes to the count. On the hundred-card
  board the desktop draws 7 to 11 wires and 2 or 3 counts for 34 linked cards
  (`rendered.json`).
- **A column out of view** (the board scrolled sideways, another phone tab)
  draws nothing; an action aimed at it goes to the column's tab or edge.
- **A hidden group** draws nothing; the seat's card is never hidden.
- **Bursts.** The board's own flight already switches to a static outline above
  six simultaneous moves. The seat's motion takes the same rule (the prototype
  plays one action at a time and does not draw this case): above six actions in
  one delta, as in a board sweep, nothing travels, the cards get the static
  outline, and the operations line says *moved 9 tasks* once.
- **Reduced motion.** No dot travels and nothing flows; wires and rings appear
  and fade.
- **Phone.** One column is visible, so the phone shows the seat's links inside
  the open tab only. Variant 1 keeps ports, Variant 2 the left-margin spine,
  Variant 3 the status-line feed. An action on a card in another tab goes to
  that tab, which pulses, with the caption below it.

## 5. Which actions animate, and where their events come from

| Action | What changes in `/api/files` | Who did it, today | What a product slice adds |
| --- | --- | --- | --- |
| Starts a pipeline | a new `pipelines` row with `srcConversationId` = the seat and a fresh `createdAt` | known: the row names the seat | nothing |
| Launches a stage | a new attempt in `pipeline.runs[].attempts` with `startedAt`, the `cursor` moves (the lifecycle journal also projects `stage_started`) | partly: an attempt with `activatedBy` was started by the engine following a pass or fail edge; one without it was started by whoever created or acted on the lane | the actor on a `pipeline_action` relaunch, in the `PauseResumeActor` shape the lane already uses for pause, resume and graph edits |
| Moves a task | the task row's `status` and `updatedAt` | **unknown**: the row records no writer | a `statusBy: { actor: PauseResumeActor, from, at }` on the task, written where the status changes: `update_task` (which already resolves its caller, `caller.kind === "manager"`, for the note author), the task routes (operator), and a pipeline finishing its task |
| Creates a task (optional) | a new `tasks` row | partly: `origin` says why, without a writer | the same `statusBy`, written on create |

**Where the client detects them.** In the board's existing layout pass, which
already compares every card's previous column with its current one to fly moved
cards (`previousRects` in `KanbanBoard.tsx`). The same pass diffs the previous
and the next `pipelines` and `tasks` rows: a new seat-owned lane, a new attempt
on a seat-owned lane, a status change whose `statusBy` names the seat. A move
the operator made in this tab is skipped (the optimistic queue in
`useTaskMutations` already knows it), and so is a move whose writer is anyone
other than the seat. Without `statusBy` the client would have to credit every
remote move to the seat, and moves from another tab, a stage agent or the merge
runner would be drawn as the orchestrator's. The prototype changes the record
the way the seat's write would and lets the board reload it, so the fixture
stands in for `statusBy`.

**Timing.** A move waits for the board's own flight (420 ms) and starts as the
card lands. From there, every variant uses one clock: the wire or pulse reaches
the card at about 0.6 s, the ring and the caption follow, and everything has
faded by 3.4 s.

## 6. Cost on a board of about a hundred cards

Measured by the driver on the `&many=1` board (101 cards, 34 of them the seat's)
in headless Chromium, 30 scroll frames of the busiest column
(`orchestrator-arrows/rendered.json`, `cost`):

| | Desktop, Variant 1 (pointer on the seat) | Desktop, Variant 2 | Phone, Variant 2 |
| --- | --- | --- | --- |
| Deriving the links | 0.03 ms | 0.01 ms | 0.04 ms |
| Rect reads per geometry pass | 205 | 104 | 104 |
| Geometry pass, mean / max | 5.3 ms / 9.2 ms | 4.2 ms / 5.8 ms | 1.0 ms / 4.0 ms |
| Wires / edge counts drawn | 10 / 3 | 11 / 3 | 9 / 2 |

The timings move by a few milliseconds from run to run; the shape (the desktop
pass dominated by layout, the phone near 1 ms) holds.

- **Events and requests: none added.** Every action rides the `files.revision`
  delta the board already reads. The server change is one small field on a task
  row (`statusBy`), written only when the status changes.
- **Geometry.** Most of the desktop pass is the layout its first rect read
  forces after a scroll; the phone, with one column, pays about 1 ms. The prototype
  reads its own rects on every frame and watches the whole DOM. A product slice
  takes the card rects from the board's existing per-render pass (it already
  reads every card), reads only the scroll offsets of scrolled columns on
  `scroll`, and draws in the next animation frame. That removes the second
  forced layout and the mutation observer; the remaining work is a few dozen
  path updates.
- **Drawing.** One SVG layer above the board with keyed paths: a scroll updates
  `d` attributes and creates nothing. Variant 1 adds a mask with one rectangle
  per visible card, rebuilt on each pass while wires show.
- **Continuous motion.** Variant 2's flowing dashes animate `stroke-dashoffset`,
  which the compositor cannot take over, so the layer repaints every frame while
  any running lane is on screen. The cards' own `.pedge.live` edges already do
  the same. A product slice pauses the flow in a hidden tab and under reduced
  motion, and flows only visible wires.
- **Actions.** At most five short-lived elements per action, gone after 3.4 s;
  a burst above six actions draws none.

## 7. Recommendation

**Variant 2, with the pointer emphasis of Variant 1 and the operations line of
Variant 3.**

- It answers the ask as written. The seat is a node with wires to everything it
  runs, they flow while lanes run, and its span of control can be read at a
  glance without pointing at anything. Variants 1 and 3 both hide that until
  the operator acts or the seat does.
- It stays readable at a hundred cards. Gutter routing gives each column a
  single trunk and never crosses a card. Scrolled-out cards collapse into one
  count, so the wire count stays near the number of visible linked cards (11 on
  the full board). Variant 1's fan, masked or not, leaves wire fragments in
  every gap between cards (`v1-desktop-many.png`).
- It speaks the board's existing language. The wire is the card's own pipeline
  edge (`.pedge`, `.pedge.live`), and an action is a pulse along a wire that is
  already there. Nothing new has to be learned.
- The two borrowed pieces cover its gaps. Pointer emphasis (dim every other
  wire while a card or the seat is under the pointer) answers "which card is
  this wire", and the operations line is the epic's "operations feed". It is
  also the only record of an action that outlives the 3.4 s motion, and the
  only one the phone can show for a card in another tab.
- Cost is acceptable once geometry comes from the board's existing pass (§6).
  The one continuous cost, flowing dashes, already exists in every running
  card's own graph.

Delivery order, each slice useful alone:

1. Link rule and Variant 2's still wires, ports and counts, from the board's own
   layout pass. No server change.
2. Motion for a started pipeline and a launched stage. The data is already
   there.
3. `statusBy` on the task row, move motion, and the operations line, desktop and
   phone.

## 8. Questions for the operator

1. Which variant: 2 as recommended (with the pointer emphasis of 1 and the
   operations line of 3), or 1 or 3 as drawn?
2. Wires go to open tasks only. Should a task the seat just finished keep a
   faint wire for a while (say an hour) after it reaches Done?
3. Variant 2 reads best with the seat at the side. With the seat on top, the
   trunks drop straight from the seat strip. Keep both placements as they are,
   or move the seat to the side when the wires are on?
4. Moves can only be credited to the orchestrator if the server records who
   moved a task. Add `statusBy` (the writer, the previous column and the time)
   to the task row?
5. Most stage starts are the engine following a pass or fail edge, without the
   seat acting. Should those also send a pulse down the seat's wire, captioned
   *Review started* without "Orchestrator", or should only the seat's own
   launches move?
6. On the phone: the left-margin spine of Variant 2, or only the action motion
   and the status-line feed?
7. Flowing dashes repaint while any lane runs. Keep them (paused in hidden tabs
   and under reduced motion), or draw still wires and move only on actions?

## 9. What was built

**The rule.** At rest nothing is drawn: no wire, no port, no count, and no
layer in the document. When the seat acts on a card, that card's wire appears
in Variant 2's shape and stays for `ORCHESTRATOR_WIRE_HOLD_MS` (one minute),
then fades over `ORCHESTRATOR_WIRE_FADE_MS`. A new action on the same card
starts its minute again, including during the fade. Several recent actions show
several wires at once. More than `ORCHESTRATOR_BURST_LIMIT` (six) actions in one
board update draw nothing, the rule §4 gives for a sweep.

**The look.** The seat is the source node. At the side its port sits on its
right edge at the height of the bus, the gap above the columns; the wire runs
along the bus, down the gutter left of the card's column and into a port on the
card, with rounded corners. With the seat on top the wire leaves the foot of the
seat's left edge, runs down the board's left margin (clear of the row of column
links under the seat) and joins the same bus. On the phone the left margin is
the gutter of the open tab: a spine from the seat card into each acted-on card
of that tab. A wire to a card with a running lane flows the way the card's own
live edge does; a card that needs the operator takes the warning colour. A card
the column has scrolled past is counted at the column's edge (`↓ +3`) with one
dashed wire; a card in another phone tab, a column out of view or a hidden group
draws nothing, and its wire is there when the card comes into view within the
minute.

**The pulse.** A started pipeline and a created task grow the wire from the
seat; every action sends a dot down the wire and rings the lane (or the card).
A moved card is ringed by the board's own landing, and its wire waits for the
card's flight. On the phone an action in another tab pulses that tab.

**Which changes are the seat's actions.** All of them are read from rows the
board already holds, by comparing each read with the one before it; the first
read is where the board stands and holds no action.

| Action | Read from | The seat's when |
| --- | --- | --- |
| Starts a pipeline | a `pipelines` row that was not there, or the first attempt of a draft that started | the link rule of §2 holds for the new lane (`srcConversationId` or the deputy is the seat); for a draft, the attempt's `launchedBy.actor` is the seat |
| Launches a stage | a newly started attempt | the attempt's `launchedBy.actor` is the seat's conversation |
| Moves a task | the task row's `statusBy` changed | `statusBy.actor` is the seat's conversation |
| Creates a task | a `tasks` row that was not there, `statusBy.from` null | `statusBy.actor` is the seat's conversation |

**`launchedBy`.** `{ actor, at }`, written by the engine where a hand puts the
cursor on a stage to launch: `start`, `retry-stage` (local, and a review-loop
retry once its remote check settles), `resolve-decision`, `continue-review`,
`accept-head` and `skip-stage`. It rides the cursor, and the next attempt the
engine makes takes it and clears it, so it names exactly one attempt. A cursor
that moves along a pass or fail edge is a fresh record without it, and the
engine's own relaunches (a cut host, memory, an interrupted turn) come after
the hand's attempt has taken it: an attempt the engine started has no
`launchedBy`, its launcher is unknown and nothing is drawn.

**When.** An action's minute runs from its record: `statusBy.at` for a move or
a create, `createdAt` for a new lane and the attempt's `startedAt` for a launch.
A delta the board reads late keeps only the rest of that minute, one older than
the minute draws nothing, and a time ahead of the board's clock reads as now.
A newer action on a card restarts its minute; an older one read after it
changes nothing.

**`statusBy`.** `{ actor, from, at }` on the task row, `actor` in the
`PauseResumeActor` shape. `update_task` and `create_task` write the caller (the
seat's parallel self is attributed to the seat, as everywhere else), the task
routes write the operator. Every other writer of a status names nobody, and the
store then drops the earlier record in the same commit, so a later move never
reads as an earlier writer's. The field stays on this machine: the linked-board
wire format does not carry it.

**Cost.** No request and no event stream was added. At rest there is no
element, no listener, no observer and no geometry read. While a wire is shown,
a geometry pass runs on scroll, on resize and after a board render, in the next
animation frame; it reads the seat, the acted-on cards and their columns and
nothing else. `evidence/orchestrator-wires/cost.json` holds the readings on the
hundred-card board with twelve cards wired. The flow pauses in a hidden tab,
and a wire whose minute ends there goes without a fade. Under reduced motion a
wire appears and goes with no motion at all; switched on while a wire shows,
the dot, the ring and any fade stop at once and the wire stays still. That
preference is listened to only while the layer exists.

**Scrolled cards.** A card whose port (its top plus 22 px, 20 on the phone)
the column has scrolled out of the scroller's visible part is counted at that
edge, so no port is painted over a column header or past the column's foot. A
pulse ring is clipped to the scroller's visible part.

**Left out.** The pointer emphasis of Variant 1 and the operations line of
Variant 3, which §7 recommended beside Variant 2: the decision asked for
neither, and the second would be new chrome. Captions on an action
(*Orchestrator launched Review*): the wire and the ring say it, and the card
already shows the stage.

## Reproducing the frames

```
LLV_KANBAN_BROWSER_TEST=1 CHROME_BIN=<chrome> bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "orchestrator wires"
```

A Chromium whose singleton socket path is too long for `TMPDIR` aborts at
launch; point `TMPDIR` at a short directory for the run. The frames are written
to `.artifacts/orchestrator-wires/` and stay on the machine that ran the driver;
the readings in `evidence/orchestrator-wires/` are committed. The command that
wrote the three variants' frames is on the design branch with the prototypes.
