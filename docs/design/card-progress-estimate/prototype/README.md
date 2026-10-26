# Agent progress estimate on the task card: prototype

On 2026-10-24 the operator asked to see the progress bar from
`docs/design/card-progress-estimate.md` as a prototype. A text question about
it did not show them enough. This prototype draws the design's three
placements as numbered variants on the product's own board. It changes no
product code.

| Variant | Where the bar sits | The design's name |
|---|---|---|
| 1 | a 5 px track in the card's bottom padding, inset by the card's own horizontal padding | A (recommended) |
| 2 | the same track under the title, centred between the title's last line and the state line | B |
| 3 | a short 36 × 8 px capsule in the state line, between the status dot and its words | C |

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
| Search filters reset after going back from a product page | ≈65%, 12 min ago | waiting for PR #418 checks | two thirds; **its dot's words are shown** (desktop: the popover open; phone: a caption under the card) |
| Orders page is slow on phones | ≈50%, 2 days ago | waiting: paused | half, in diagonal stripes |

The desktop also draws a finished task in «Done» / «Готові»: «Receipts by email»,
≈100%, merged. It shows the bar on the narrow 280 px shelf card. On the phone
that card is in the Done tab, off the frame.

The dot's words keep the product's own first («Waiting for 40m» / «Чекає вже
40 хв»). A second line adds the estimate and its age: «Agent estimate ≈65% ·
12m ago» / «Оцінка агента ≈65% · 12 хв тому». The age never splits across
lines, so a narrow bubble wraps after the «·». A report older than a
day says «Last agent estimate» / «Остання оцінка агента». A card with no report
says «No agent estimate yet» / «Агент ще не оцінив».

## The bar's look

The bar uses the product's tokens and adds no colour:

- the track is a 1 px outline in `--color-muted` mixed 78% with the card's
  surface, rounded at both ends;
- inside the outline lies `--border-default`;
- the fill is `--color-secondary`;
- an estimate older than 24 hours fills with diagonal stripes of
  `--color-muted`, 2 px wide with 2 px gaps that show the inside of the track,
  so it differs from a fresh estimate by its form and not only its tone;
- an absent estimate is the same outline, dashed, with nothing inside.

Measured in the rendered pages (WCAG relative luminance, light / dark):

| Pair | Light | Dark |
|---|---|---|
| track outline against the card | 3.28:1 | 3.63:1 |
| fill against the inside of the track | 5.56:1 | 5.51:1 |
| stale stripes against the inside of the track | 3.90:1 | 4.14:1 |
| fill against the card | 7.25:1 | 6.80:1 |
| stale stripes against the card | 5.10:1 | 5.11:1 |

The design asks for a solid 2 px track. A solid track under a solid fill
cannot clear 3:1 at both steps while the stale fill stays softer. In light
theme, a track at 3:1 against the card leaves too little range for a fill
that is softer than the secondary text tone and still 3:1 against the track.
The outline marks the track's extent at 3:1 against the card. The fill then
sits on the light inside of the track, and every fill clears 3:1 there. So 0%
reads as an empty capsule and the stale estimate as a striped fill. The
stripes' ratios are sampled from the rendered frames (the darkest and lightest
pixel along the stale fill), at 1× and 2×. The
track is 5 px tall in variants 1 and 2, and 8 px in variant 3, where a 2 px
track read as a dash.

Status colours stay on the dot. The bar has no tab stop and no pointer
handler. A known estimate is a `progressbar` (0–100) named for its task, with
the value text «Agent estimate, approximately 65%». The dashed track is hidden
from assistive technology.

## What the frames show about each variant

- **Variant 1** never shares a row with text. The card's bottom padding grows
  by 4 px, so the bar keeps a gap of at least 5 px below the last row. On the
  phone, a card with a row under its face (the «Answer» button) is drawn as a
  frame. There the bar runs along the frame's bottom edge, 10 px under the
  button's border, which stays whole.
- **Variant 2** sits under the whole title row, badge included, centred
  between the title's last line and the state line (equal gaps within 1 px).
  Every card's bar ends at the same right edge. On the phone, a card with a
  dismissal beside its face runs its bar on under the dismissal. The bar adds
  about 11 px to each card.
- **Variant 3** keeps the bar next to the dot. On a card whose state line
  wraps (the phone's «Needs your answer» card), the words start 42 px further
  right (the capsule plus the line's gap). The extra width wraps that line
  sooner than in variants 1 and 2.

## Where the desktop popover opens

Today the dot's popover opens above the dot. It covers the start of the
card's own title, and in variant 2 the start of the bar it explains. The
prototype opens the product's bubble beside the state line instead, so the
operator can tell which card it explains. Its top is level with the state
line, 4 px above it. It starts 12 px after the words of every row it spans,
and covers no title, no bar and no words of any card. It stays inside its own
card: its right edge at least 4 px inside the card's, so at 820 px its words
wrap there, and its bottom at least 4 px above the card's. Where the space
under the state line is too short, it rises (in variant 2 never over the bar
above the state line). In variant 1 it also rises until its shadow ends at
least 6 px above the bar along the card's bottom edge. The checks record all
of this in every desktop frame, as measured:

| Frames | Bubble's right edge inside the card | Shadow above the bar |
|---|---|---|
| 1440, every variant | 440–470 px | 7.8 px in variant 1 |
| 820, variants 1 and 2 | uk 4 px, en 23 px | 7.8 px in variant 1 |
| 820, variant 3 | uk 4 px (three lines), en 7 px | — |

The product would place it the same way in every variant:

- **Variant 1**: beside the state line. The bar is at the bottom edge,
  below the rows the bubble spans.
- **Variant 2**: beside the state line, never above it, since the bar lies
  between the title and the state line.
- **Variant 3**: beside the state line, after its words; the bar is before
  them.

`TooltipBubble` today opens only above or below its anchor, so this needs a
side placement there.

## The phone

The phone's card is one button, so its dot is passive and the product draws no
popover there. The design puts the same words into the card's accessible
description and the opened task. Each phone frame prints those words as a
caption under the 65% card, outside it, so the card's title and bar stay in
view. The product would not show the caption. In variant 1, and in variant 2
in Ukrainian, the caption pushes the last card's bar 9–43 px below the first
844 px screen; without it, that bar would be on the first screen.

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
  bubble, opened by a mouse hover on the 65% card and then moved beside its
  state line. Phone: `MobileKanban` with
  its own cards.
- New: the bar (inserted into the real card at each variant's place), the
  popover's second line and its place beside the state line, and on the
  phone the caption under the card. All of them use the product's existing
  classes and tokens. No new colour, font or card shape.
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
- the bar's offset from the card's bottom edge, its width and its right edge;
- in variant 2, the gaps above and below the bar;
- in variant 1 on the phone, the gap between the «Answer» button and the bar;
- the contrast of the track and the fills, from their computed colours;
- that the popover lies inside the viewport, and which cards, bars and words
  it covers;
- how far the popover's right and bottom edges lie inside its card, and in
  variant 1 the gap between its shadow and the bar;
- on the phone, in a 390 × 844 viewport before it grows, that every
  In-progress card's bar is on the first screen.

The popover opens only after every bar is in place and two frames have
painted. It is then placed beside the state line, and placed again on every
resize.
