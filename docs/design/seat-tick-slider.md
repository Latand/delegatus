# Seat tick slider: an activity slider in place of the tick chip

Status: **variant 4 «Перемикач» is built.** The operator chose it in the
prototype review on 2026-10-07 with one comment, verbatim: «щоб аніімація була
плавна і пружиніста коли переміщаєш, але лише трошки, коли відпускаєш». The
other three variants are not built; their descriptions stay below as the record
of what was offered. What the build adds to this design is under
[The build](#the-build).

## Originating requirement

Operator, 2026-10-07 about 11:10 Kyiv, in Russian, pinned to the task with a
screenshot of the kanban seat's header row
(`$HOME/Pictures/delegatus-review/seat-tick-slider/operator-2026-10-07.png`).
Verbatim excerpt:

> мне нужно вот эта штука, там где написано «щогодини», — Это наш тикер. Я бы
> хотел, чтобы это был таким, как, знаешь, ползунком, который я перетягиваю и
> который указывает. На то, насколько активный агент. То есть это как такие
> дефолтные презеты для того, чтобы поменять просто. То, сколько будет этот
> тикер работать, как часто он будет запускаться и будет ли он запускаться
> вообще. … если я нажимаю на него … и не двигаю, … не перетягиваю ползунок,
> то тогда … должно открываться то же самое меню, что и сейчас. То есть
> настройки … чтобы цвет было красиво, чтобы цвета менялись … если я сейчас
> хочу выключить … тикер, то я такой быстренько ползунок, такой чик, перевёл …
> на нулевое положение. А если я хочу, чтобы он очень часто проверял, то я его
> перевожу на максимальное, и тогда он там раз в 10 минут тикает … дефолтный
> презет. Ну и посередине … как у нас сейчас: 1 час 4 часа.

What that asks for, point by point:

1. The tick chip («щогодини» and its dot) becomes a slider of activity presets.
2. Leftmost is off; rightmost is the most active, about every 10 minutes; 1 h
   and 4 h sit between.
3. Dragging, or a quick flick, changes the preset.
4. A press without dragging opens the same settings as today.
5. The colour changes with activity, and it looks good.

The pinned specification adds: it must be obvious that the control is both
draggable and clickable; the health dot keeps its meaning, separate from the
preset; a value set in the settings that is not a preset (15 min, a temporary
setting with an expiry) still reads correctly; and the design says what a
preset change writes as the reason the settings module requires.

## What exists today

- `src/components/orchestrator/SeatTickChip.tsx` draws the chip in the
  orchestrator's incumbent row (`IncumbentHeader.tsx`), which both the dock and
  the kanban seat's header host. The face is a timer glyph, the schedule in one
  word (`seatTickReading().chip`: «hourly», «off», «every 30 min») and a 6 px
  dot. A click toggles a popover portalled to the body that renders
  `SeatTickBody`.
- `seatTickView.ts` keeps the two facts apart, and the slider has to as well:
  the face is the configured schedule and never moves because the tick is
  unhealthy; the dot (`SeatTickDot`, tone `ok | warn | muted | unknown`) is the
  actual state (`healthy | stale | blocked | paused | unknown`) and never moves
  because the schedule changed.
- On the phone the tick is a row in the seat sheet (`MobileSeatTickRow` in
  `MobileSeatTickSheet.tsx`) whose trailing text is the closed summary; a tap
  opens `MobileSeatTickSheet` with the same `SeatTickBody`.
- `src/lib/monitor/seatTickSettings.ts` holds `enabled`,
  `wakeIntervalMinutes` (null is the default, 60 min), `until` and `reason`.
  `applySeatTickSettingsChange` refuses any record off the default schedule
  without a reason («a quiet tick without instructions is indistinguishable
  from a broken one»). The reason is delivered in full on every wake, is shown
  on the board card, and survives a reset to the default and an expiry until
  someone clears it. Restoring the default needs no reason and clears
  `wakeIntervalMinutes` and `until`.
- Checks run every 5 minutes by default (`DEFAULT_SEAT_TICK_POLICY`), so a
  10-minute wake is twice the check cadence and every stop is reachable.

## The design every variant shares

The four variants differ only in how the control is drawn. Stops, colours,
gestures, keyboard, accessibility and writes are one design.

### Stops

| Position | Stop | Face (en / uk) | Writes |
|---|---|---|---|
| 0 | Off | off / вимк. | `enabled: false` |
| 1 | Every 4 h | 4 h / 4 год | `enabled: true, wakeIntervalMinutes: 240` |
| 2 | Every 1 h, the default | 1 h / 1 год | restores the default: `enabled: true, wakeIntervalMinutes: null` |
| 3 | Every 10 min | 10 min / 10 хв | `enabled: true, wakeIntervalMinutes: 10` |

Four stops, exactly the ones the operator named, ordered by activity. The 1 h
stop is the default, so landing on it restores the default (it sends
`wakeIntervalMinutes: null`): the board card goes away and no reason is owed. A project
whose default is ever configured to something other than 60 keeps the stop
meaning «the default» and shows the default's own interval.

The faces are short units: «1 h», «10 min», where today's chip says «hourly»
and «every 10 min». The slider itself now says «how much», so the word only has to
name the number, and the short form keeps the control inside the row's width
(see the measurements below).

### A value that is not a preset

The track is evenly spaced by stop. A configured interval between two stops is
placed on a log scale between them, so 15 min sits most of the way from 1 h
to 10 min, 2 h sits half-way between 4 h and 1 h, and 12 h sits between off
and 4 h. Shorter than 10 min pins to the right end. The face always shows the
exact value («15 min», «12 h»), and the marker is drawn differently from a
preset in every variant: a hollow thumb in variant 1, a dashed fill edge in
variant 2, a partly lit bar in variant 3, a dashed thumb in variant 4. The
aria value text adds «not a preset».

A temporary setting (an `until`) shows an hourglass after the word; the title
and the value text say «until 13:40». The slider never edits an expiry: every
slider move writes `untilMinutes: null`, because a stop is a standing level,
and an expiry is set in the settings as today.

### Colour ramp

One ramp built from the app's own tokens, so the dark theme follows without a
second palette:

| Stop | Token |
|---|---|
| Off | `--effort-empty` (neutral grey) |
| 4 h | `color-mix(in oklch, --color-accent 55%, --color-info)`, a calm blue |
| 1 h | `--color-accent`, the app's indigo |
| 10 min | `color-mix(in oklch, --color-accent 35%, --color-openclaw)`, a warm violet-magenta |

Between stops the colour is mixed in OKLCH, so a drag sweeps the hue
continuously. Green and amber are deliberately absent: they belong to the
health dot (`--color-success`, `--color-warning`), and a ramp that used them
would let «very active» read as «healthy» or «stale». The off stop also swaps
the timer glyph for `TimerOff`.

### The health dot

Unchanged and separate: the same `SeatTickDot`, from the same
`seatTickReading().tone`, drawn at the right end of the control, after the
word. A preset never changes it and it never changes the preset. The
prototype's «10 min, tick stale» state shows the most active preset with the
amber dot.

### Drag or click

One rule, on pointer events, for mouse, pen and touch:

- **Press**: the control takes pointer capture and records where the press
  started. Nothing is drawn yet.
- **Drag** begins once the pointer has moved more than **4 px** horizontally
  for a mouse, **8 px** for touch or pen. From then on the marker follows the
  pointer continuously, relative to where it was pressed (so the whole control
  is the handle, the thumb included), the face previews the nearest stop's
  word and the colour follows the position.
- **Release after a drag** snaps to the nearest stop and writes it, once. A
  flick (faster than 0.4 px/ms, measured over the last 80 ms of movement)
  carries the position a further 90 ms of travel first, so a quick flick
  toward an end lands on that end even on the short desktop track. The speed
  is measured over a window because the browser can deliver a last move with
  no distance just before the release: measured from that one event, the
  prototype's flick from 10 min stopped at 4 h in two variants. Release on the stop already set writes nothing.
- **Release without a drag** is a click: it opens the settings popover, or on
  the phone the tick sheet, exactly as the chip does today. A second click
  closes the popover, as today.
- **Escape** during a drag, or `pointercancel`, puts the marker back and
  writes nothing.

Vertical movement is left to the page (`touch-action: pan-y`), so the seat
sheet on the phone still scrolls under a thumb that lands on the slider.

Making both actions discoverable: the cursor is `grab` (`grabbing` while
dragging), hover tints the border with the current activity colour and wakes
the handle (the thumb grows in variant 1, the fill edge appears in variant 2,
the scale line under the bars appears in variant 3, the thumb's border lights
in variant 4), and the title reads «Drag to change how often the seat wakes ·
click for settings» under the existing summary line.

### Keyboard and screen readers

- The control is `role="slider"`, `tabIndex=0`, `aria-valuemin=0`,
  `aria-valuemax=3`, `aria-valuenow` the position (fractional for a value
  between stops), `aria-haspopup="dialog"`, `aria-expanded` while the
  popover is open, and `aria-label` «Seat tick activity» / «Активність тікера
  оркестратора».
- `aria-valuetext` is the whole reading: the stop in words («every hour, the
  default», «every 10 minutes», «15 min, not a preset», «… until 13:40»)
  followed by the existing closed summary, which already carries the health.
- ← / ↓ / Page Down one stop less active, → / ↑ / Page Up one stop more
  active, Home off, End 10 min. From a value between stops an arrow goes to
  the neighbouring stop in that direction.
- An arrow PREVIEWS; the write happens **0.7 s after the last arrow**, so
  stepping from off to 10 min with three presses writes once. Enter or Space writes a pending step at once; with nothing pending
  they open the settings, as Enter on the chip does today. Escape drops a
  pending step.

### What a preset writes

Through the same route and the same `useSeatTickSettings().save`, so the
optimistic display, the rollback on a refusal and the refusal text all work as
they do for the popover.

| Stop | Change sent |
|---|---|
| Off | `{ enabled: false, untilMinutes: null, reason? }` |
| 4 h | `{ enabled: true, wakeIntervalMinutes: 240, untilMinutes: null, reason? }` |
| 1 h | `{ enabled: true, wakeIntervalMinutes: null, untilMinutes: null, reason: null only if the slider wrote the stored one }` |
| 10 min | `{ enabled: true, wakeIntervalMinutes: 10, untilMinutes: null, reason? }` |

The reason, which the module requires off the default:

- **A reason a person or a seat wrote is never touched.** If the record
  carries one, the slider sends no `reason` and that text keeps standing.
- **With no stored reason, the slider writes its own sentence**, in the
  interface language:
  - off — «Turned off with the activity slider in the orchestrator header.
    Stays off until the operator moves the slider back.» / «Вимкнено
    повзунком активності в шапці оркестратора. Лишається вимкненим, доки
    оператор не пересуне повзунок.»
  - 4 h and 10 min — «The operator set the activity slider to «every 4
    hours».» / «Оператор поставив повзунок активності на «кожні 4 години».»
- **The slider's own sentence is the slider's to replace.** A later move
  rewrites it for the new stop, and landing on the 1 h default clears it
  (`reason: null`). Without this rule the prototype showed the failure: off
  the default and back, the hourly tick kept delivering «set to every 10
  minutes» on every wake, because instructions survive a reset by design. A
  sentence is recognised as the slider's by exact match with one of the
  templates above, in either language.

The board card the module raises off the default carries that sentence, so
the board still says why the tick is quiet.

### The phone

The seat sheet's tick row keeps its label and its own timer icon; the slider
replaces the trailing summary (and its chevron) and drops its own icon, since
the row already has one. It is 36 px tall inside the 44 px row. A tap on the
label opens the tick sheet as today; a tap on the slider without moving opens
it too; a horizontal drag changes the preset.

## The build

`SeatTickSwitch.tsx` is the control, `seatTickStops.ts` its model (stops,
placement, words, what a stop sends, the spring). `SeatTickChip` mounts it in
the incumbent row with the popover it always had; `MobileSeatTickRow` mounts it
as the trailing control of the phone's row, whose label is the button that
opens the tick sheet.

**Motion, from the operator's comment.** The thumb is drawn by a damped spring
toward where it should be, in two settings:

| When | Damping ratio | What it looks like |
|---|---|---|
| held by the pointer | 0.4 | the thumb trails a moving pointer and swings softly past it when the pointer stops: about a quarter of the distance it was behind |
| released, or stepped by a key | 0.65 | it settles on the stop about 7 % of the distance past it, once: roughly a pixel on a move of one stop |

The colour is computed from the drawn position, so the hue travels with the
thumb. At the ends the pill is a wall: the thumb gives against it by the
pill's own 2 px inset and no more. Under `prefers-reduced-motion` there is no
spring at all: the thumb is drawn where the pointer is and on the stop the
frame after the release.

**Geometry.** The travel between the first stop and the last is fixed at
60 px on both surfaces, so a step is the same number of pixels
whatever the word is; the thumb widens for a word longer than six characters
and the pill widens with it. Where the row gives up the word
(`[data-seat-tick-face]`, at the widths `globals.css` already names), the
thumb is an 18 px round knob and the travel halves to 30 px, so the control
is 66 px wide: the side-docked seat's row in Ukrainian had 35 px to spare
with the old chip down to its glyph and dot, and a knob on the full travel
pushed «Зупинити хост» 21 px outside it. The drag reads the travel that is
drawn, so a stop is 10 px there.

**Notches.** A notch marks a stop the thumb is not on. The thumb is wider
than a step, so a notch closer to it than its half, the notch's radius and a
2 px gap is not drawn, and it fades back in over the next 0.3 of a stop as the
thumb moves away. At a stop on the full pill that leaves the notches two and
three stops away; on the knob the same rule leaves those two stops away.

**Off is grey in both themes.** The tint behind the thumb, the hover border
and the drag's halo are mixed in OKLab. In OKLCH Chrome reads the hue of a
grey as missing and takes it as 0°, so grey over the dark pill came out a
faint wine red. The ramp between stops stays in OKLCH, where one side always
has a hue.

**Two readings the build settled.**

- A release on the stop already set writes nothing, an expiry included. The
  prototype cleared an expiry there; a drag that ends where it started is not
  a move, and «a slider move never edits an expiry except clearing it» is kept
  to moves.
- A move the route refuses rolls the thumb back, as every save does, and
  opens the settings on the desktop, where the refusal's text is shown.
- A move released while the previous write is still in flight waits for it,
  drawn where it was released. Only the latest such move is kept, and once
  the write settles it is measured against the record that came back: a move
  back to where that write landed sends nothing. A move queued behind a
  refused write is dropped, and only the route's refusal opens the settings.

Rendered evidence is the «seat tick switch» block of
`kanbanBoard.browser.test.tsx`. Its readings are
`evidence/seat-tick-switch/readings.json`; its frames are written to
`LLV_SEAT_TICK_SWITCH_FRAMES` and are not kept in the tree.

## The variants

Every frame carries its number and name. Frames and videos are under
`$HOME/Pictures/delegatus-review/seat-tick-slider/variant-N/`, named
`variant-N-<width>-<en|uk>-<light|dark>-<caption>`; the published review
holds the same files. Each variant has, at 1440 and at 390, in both languages
and both themes, a sheet of every state in the real header row (off, each
preset, 15 min and 12 h set in the settings, a temporary 10 min, 10 min with a
stale dot, hover, keyboard focus, a pending arrow step and mid-drag), the
popover or sheet opening on a click or tap, and a video at 1440 (English) and
390 (Ukrainian) of a slow drag to 10 min, a flick to off, two arrow steps and
a click opening the settings.

### Variant 1 — Rail («Рейка»)

The chip keeps its border and glyph and gains a small track: a 2 px line with
four notches, a round thumb in the activity colour, and the word after it.
The most literal «ползунок»: it reads as a slider from across the room. A
value between stops is a hollow thumb. Costs the most width of the four.

### Variant 2 — Fill («Заливка»)

The chip stays the size and shape it has now; its background fills from the
left with a soft wash of the activity colour, like a volume pill, and the word
takes a tint of it. Two faint notches at the bottom edge mark 4 h and 1 h. The
fill's edge is the handle: it appears on hover and while dragging (dashed for
a value between stops). The quietest variant and the closest to today's row;
the drag affordance is the least obvious at rest.

### Variant 3 — Bars («Сигнал»)

Three ascending bars, a signal meter: none lit is off, three lit is 10 min. A
value between stops lights the next bar partly. A scale line with a dot
appears under the bars on hover and while dragging. Iconic and narrow; the
number of bars is readable at a glance without the word.

### Variant 4 — Thumb switch («Перемикач»)

A pill track like the popover's own on/off switch, grown to four stops; the
thumb is a small pill that carries the word and slides along it, and the track
behind it tints with the activity colour. At off it reads as a switch turned
off. The most obviously draggable at rest; the dot sits outside the pill.

### Recommendation

Variant 1 or variant 4. Both say «drag me» without a hover, which the
specification asks for, and both keep the word legible at every stop.
Variant 4 is the stronger fit for «я такой быстренько ползунок … чик, перевёл
на нулевое положение»: its off position is unmistakably a switch thrown off.
Variant 2 is the pick if the row's width matters more than the affordance.

## Measurements

Measured in the rendered prototypes, in both languages and both themes:

| Variant | Kanban seat head, 1440 | Dock at its 360 px floor | Phone row, 390 (with an expiry) |
|---|---|---|---|
| 1 Rail | 144 × 24 px, controls on one row | 122 px without the word, 12 px to spare | 138 × 36 px (160) |
| 2 Fill | 104 × 24 px, controls on one row | 104 px without the word, 12 px to spare | 116 × 36 px (116) |
| 3 Bars | 83 × 24 px, controls on one row | 61 px without the word, 12 px to spare | 107 × 36 px (129) |
| 4 Thumb switch | 124 × 24 px, controls on one row | 142 px, 12 px to spare | 138 × 36 px (160) |

- **No page errors** in any frame, and the phone row's label («Seat tick»,
  «Тікер оркестратора») is never truncated, in any state, in either language
  (the 44 px row holds a 36 px control).
- **The dock's floor.** Today `globals.css` hides the chip's word
  (`[data-seat-tick-face]`) below a 379 px `incumbent-host` container, and
  in the kanban seat's inline row below 539 px. The slider's word carries the
  same attribute and gives way the same way; the measured row then keeps
  12 px to spare in every variant. Without that rule, variant 1 with
  «30 хв» and an expiry pushed Rotate past the dock's edge. In variant 4 the
  thumb carries the word, so at the floor it is an empty pill: an
  implementation of variant 4 shrinks the thumb to a round knob there.
- **The writes**, from the prototype's in-memory route, for every variant: a
  drag from the default to 10 min sent `{ enabled: true,
  wakeIntervalMinutes: 10, untilMinutes: null, reason: "The operator set the
  activity slider to «every 10 minutes»." }`; a flick from there to off
  replaced that sentence with the off sentence; two arrow presses back to the
  default sent one write, `{ enabled: true, wakeIntervalMinutes: null,
  untilMinutes: null, reason: null }`; a click without moving sent nothing and
  opened the popover.
- **The 15 min reading** has the value text «15 min, not a preset. every 15
  min · last check 2m ago» («15 хв, не пресет. кожні 15 хв · остання
  перевірка 2 хв тому»).

Defects the rendering caught and the prototypes fixed before publication:
the slider's own sentence outliving a return to the default (above); a flick
measured from one zero-distance event; the bars variant scrubbing over its
13 px of bars, so 14 px of movement crossed every stop, where it now scrubs
over the whole control; and «10 min» with an hourglass truncating in variant
2 and wrapping inside variant 4's thumb.

Evidence: `evidence/seat-tick-slider/measurements.json` holds the measured
widths, whether the row's controls stayed on one line, whether the phone
label truncates, the value text, and the exact change each gesture sent.

## How the prototypes were rendered

The kanban evidence fixture (`issue1695Evidence.fixture.tsx`,
`?scenario=seat-head`) through the shared harness
(`issue1695BrowserHarness.ts`), in a `git archive` export of this commit under
the stage's scratch directory: the real `IncumbentHeader`, the real seat head,
the real popover and `SeatTickBody`, the real phone seat sheet and tick sheet.
The dock at its 360 px floor was measured through the #1681 fixture
(`issue1681Evidence.fixture.tsx`, `?dock=360`) in the same export.
In the export only, `SeatTickChip`'s button and `MobileSeatTickRow`'s trailing
text were swapped for the prototype slider, and the settings route was
answered from memory so a write reads back the way the route would. No driver
and no fixture were added to the repository.

Two limits of the rendering: the phone frames drive the drag with mouse
events in a touch context, so the 8 px touch threshold was not exercised in a
frame (the 4 px mouse one was); and the attention toast that covers the seat
head in that scenario was hidden in the frames.

## Validation against the requirement

| The operator asked | The design |
|---|---|
| a slider that shows how active the agent is | four stops ordered by activity, colour and position say how active |
| default presets to change it simply | off, 4 h, 1 h (default), 10 min |
| how often, and whether at all | the leftmost stop is off |
| press without dragging opens the same menu | a release under 4 px (8 px touch) opens the existing popover or sheet |
| colours change, and look good | grey → blue → indigo → violet-magenta from the app's tokens, swept continuously |
| a quick flick to zero turns it off | relative drag over the whole control, plus a flick carry |
| the maximum ticks every 10 minutes | the rightmost stop writes 10 |
| the middle as now: 1 h, 4 h | stops 1 and 2 |

## Deferred — not currently justified

- **A 30 min stop.** The operator named off, 4 h, 1 h and 10 min. A fifth
  stop would make the 56 px desktop track crowded; 30 min stays reachable in
  the settings and reads as a value between 1 h and 10 min.
- **An undo toast after a flick to off.** New chrome; a flick back, or the
  settings, undo it, and the board card says the tick is off.
- **Labels under the stops.** Would need a second line in a row that has to
  fit the dock's 360 px floor; the word on the control names the current stop
  and the title and value text name all of them.
- **A preset field in the settings record, or exempting presets from the
  reason rule on the server.** Either would let the slider skip writing a
  sentence; both change the module's contract, which the slider does not need
  once its own sentence is replaced and cleared as above.
- **Per-project stop sets.** Nothing asks for them.
- **Haptics on the phone at each stop.** Not available to the web app
  uniformly; the colour and the word already change at each stop.
