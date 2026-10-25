# Agent progress estimate on the task card: prototype

On 2026-10-24 the operator asked to see the progress bar from
`docs/design/card-progress-estimate.md` as a prototype. A text question about
it did not show them enough. This prototype draws the design's three
placements as numbered variants on the product's own board. It changes no
product code.

| Variant | Where the bar sits | The design's name |
|---|---|---|
| 1 | a 2 px track inside the card's bottom padding, inset by the card's own horizontal padding | A (recommended) |
| 2 | the same track under the title, inside the gap that already follows the title row | B |
| 3 | a short 32 px track in the state line, between the status dot and its words | C |

Each frame prints its variant number and name in a band above the board, in
the frame's language. The band also has a legend that lists each card's
estimate in the order the board drew them. The cards print no number, as the
design asks, so the legend is the prototype's own; the product would not have
it. The board sorts working cards first, while the phone puts the card that
waits for the operator first. The legend reads the drawn order, so it is
correct on both.

## The cards

Every variant draws the same cards in «In progress» / «У роботі»:

| Card | Estimate | State line (the product's own) | Bar |
|---|---|---|---|
| Quarterly sales report | none reported | working | dashed empty track |
| Import contacts from Google | ≈0%, 6 min ago | working | solid empty track |
| Card payments: 3-D Secure | ≈35%, 18 min ago | working | a third filled |
| Dark theme in settings | ≈100%, 9 min ago | needs your answer: the deploy stage asked a question | full, though the task is not done |
| Search filters reset after going back from a product page | ≈65%, 12 min ago | waiting for PR #418 checks | two thirds; **its dot's popover is open** |
| Orders page is slow on phones | ≈50%, 2 days ago | waiting: paused | half, in the softened tone |

The desktop also draws a finished task in «Done» / «Готові»: «Receipts by email»,
≈100%, merged. It shows the bar on the narrow 280 px shelf card. On the phone
that card is in the Done tab, off the frame.

The popover keeps the product's words first («Waiting for 40m» / «Чекає вже
40 хв»). A second line adds the estimate and its age: «Agent estimate ≈65% ·
reported 12m ago» / «Оцінка агента ≈65% · 12 хв тому». A report older than a
day says «Last agent estimate» / «Остання оцінка агента». A card with no report
says «No agent estimate yet» / «Агент ще не оцінив».

## The bar's look

The bar uses the product's tokens and adds no colour:

- the track is `--border-strong`;
- the fill is `--color-secondary`;
- an estimate older than 24 hours fills in `--color-muted` mixed with the track
  tone, which is softer in both themes;
- an absent estimate is the same track tone, dashed (4 px on, 4 px off), with no
  fill.

Status colours stay on the dot. The bar has no tab stop and no pointer
handler. A known estimate is a `progressbar` (0–100) named for its task, with
the value text «Agent estimate, approximately 65%». The dashed track is hidden
from assistive technology.

## What the frames show about each variant

- **Variant 1** never shares a row with text. The open popover covers no bar,
  because the dot sits above the bottom edge. On the phone, a card with a row
  under its face (the «Answer» button) is drawn as a frame, so the bar runs
  along the frame's bottom edge, under the button.
- **Variant 2** sits between the title and the state line, where it reads
  like a rule under the title. The dot's popover opens upward over the title,
  so it covers the start of the bar on the very card whose estimate it
  explains: on the phone, most of the 65% fill. The checks
  record this (`popCoversBar: t-65` in every variant 2 frame).
- **Variant 3** keeps the bar next to the dot. At 32 px, 0% and an absent
  estimate differ only by dashes, and 35% is an 11 px fill. On a card whose
  state line wraps (the phone's «Needs your answer» card), the words start
  37 px further right (the track plus the line's gap).

The popover opens upward over its own card's title in every variant. This is
the product's hover popover as it is today; the prototype does not change
where it opens.

## The phone

The phone's card is one button, so its dot is passive and the product draws no
popover there. The design puts the same words into the card's accessible
description and the opened task. Each phone frame draws the desktop's bubble
with the same words, anchored to the passive dot, so the operator can read them
at 390 px. The product would not show it there.

## Files

- `prototype.fixture.tsx`: the whole prototype. Query string:
  `?variant=1|2|3&device=desktop|phone&lang=uk|en&theme=light|dark`. The
  window's size decides the width.
- `prototype.css`: the product's `globals.css` plus this directory as a
  Tailwind source.
- `*.png`: the rendered frames, ignored by git.

## Drawn by the product, and what is new

- Desktop: `KanbanBoard` with closed `KanbanCard`s and their real
  `CardStateLine`. The open popover is the product's own `CardStateDot`
  bubble, opened by a mouse hover on the 65% card. Phone: `MobileKanban` with
  its own cards.
- New: the bar (inserted into the real card at each variant's place), the
  popover's second line, and on the phone a `TooltipBubble` anchored to the
  passive dot. All of them use the product's existing classes and tokens. No
  new colour, font or card shape.
- The fixture's tasks, lanes, PR numbers and times are invented. The clock is
  frozen at 16:30 Kyiv time on 2026-10-24.

## Building and rendering

From a scratch export with dependencies installed (`bun install
--frozen-lockfile`):

```
bun src/components/kanban/buildEvidenceFixture.ts \
  docs/design/card-progress-estimate/prototype/prototype.fixture.tsx <out>
```

Compile `prototype.css` with `@tailwindcss/postcss` into `<out>/style.css`.
Add an `index.html` that links `style.css`, holds `<div id="root">` and loads
`prototype.fixture.js` as a module. Serve `<out>` over local HTTP. Every
`/api/` read is answered inside the page, so no Viewer runs.

Each frame is a full-page headless Chromium screenshot:

- desktop at 1440 px and, as the width between, 820 px;
- phone at 390 px (2× scale, touch);
- time zone Europe/Kyiv, motion reduced, colour scheme matching the theme;
- after the first-screen checks, the viewport grows to the page's full height.

Names: `variant-<n>-<width>-<lang>.png` for the light theme, plus
`-dark` for the dark one. At 820 px the board scrolls sideways, as the product
does at that width, so the Done column runs past the right edge.

Before each capture, the checks measured:

- every bar's text ranges in its card: no bar overlaps text;
- the bar's offset from the card's bottom edge and its width;
- that the popover lies inside the viewport, which cards and bars it covers,
  and that it covers no other card;
- on the phone, in a 390 × 844 viewport before it grows, that every
  In-progress card's bar is on the first screen.

The popover opens only after every bar is in place and two frames have
painted. Its added line then makes the bubble measure itself again, so it sits
where a hover on a settled board would put it.
