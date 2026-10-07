# Orchestrator wires: shorter routes with no needless turns

> «не дуже продумана повністью лінія тут. бажано дослідити подібні різні кейси і
> щоб лінія була коротшою і не робила багато поворотів там де не треба.»
>
> — the operator, 2026-10-07 about 11:05 Kyiv, in chat, with a screenshot of the
> board (`$HOME/Pictures/delegatus-review/wire-routing/operator-2026-10-07.png`).
> In English: the wire here is badly thought out; study similar different cases;
> the wire should be shorter and should not make many turns where it does not
> need to.

The wires are the ones #2565 shipped (`docs/design/orchestrator-arrows.md` §9,
Variant 2, shown for about a minute after a seat action and then faded). This
document measures the route they take on every seat and card layout the board
produces, states one routing rule, gives the route that rule draws in each
case, and names the code and the tests that change. The look stays as it is:
stroke, colours, ports, the pulse, the ring, the hold and the fade, and the
phone's tab pulse. Only the path of the wire changes.

## 1. The operator's case, reproduced

The screenshot shows the seat on top, open, centred over the board. Its wire
leaves the bottom-left corner of the seat panel, runs left to the board's left
margin, drops, runs right along the strip above Inbox, drops down the gutter
left of «У роботі» and enters a card that sits almost directly under the seat.

The fixture draws the same board at 1920 × 1080 (`?scenario=orchestrator-arrows`,
seat on top and open, the wide board mode): the seat spans x 564–1604 and ends at
y 870; the «In progress» column starts at x 639, so its gutter (x 630) lies under
the seat.

| | Bends | Length | Route |
| --- | --- | --- | --- |
| Now | 4 | 786 px | left 305 px from the foot of the seat's left edge to the margin, down 17, right 371 along the bus, down 84 the gutter, right 18 into the port |
| The rule | 1 | 103 px | down 87 px from the seat's bottom edge at the gutter, right 18 into the port |

Frames, before and after, desktop and phone, English and Ukrainian, are under
`$HOME/Pictures/delegatus-review/wire-routing/current/` and `…/rule/` (named
`<width>-<seat>-<lang>-<target>.png`; the operator's case is
`1920-top-en-assigned-first.png` and `1920-top-uk-assigned-first.png`). The
same pairs are published for review on the task.

## 2. Why the wire takes that route today

`gutter()` in `src/components/kanban/orchestratorWires.ts` draws every wire from
one template a placement:

- **Seat at the side.** Out of the seat's right edge at the bus (9 px above the
  columns), along the bus, down the gutter left of the card's column, into the
  card's port: two bends.
- **Seat on top, and the phone.** Out of the foot of the seat's left edge, down
  the board's left margin, along the bus, down the column's gutter: four bends,
  two when the column is the first one. The margin exists to clear the row of
  column links that the scrolling board draws between a seat on top and the
  columns. The same detour is taken on the wide board, which draws no such row,
  and for a column directly under the seat.

Three smaller defects showed up in the measurements:

- **Side seat on the wide board.** The columns start 12 px below the seat's top,
  so the bus (9 px above the columns) lies 9 px above the seat's port, which
  `seatPort()` keeps 12 px below the seat's top. Every wire hooks right, up and
  back left before it runs along the bus: four bends, and the Inbox wire runs
  back over the others' hook outside their common start (cases 16–23).
- **A column that shows only its header.** At 1280 × 800 with the seat open on
  top, the columns begin 53 px above the window's foot and their scrollers show
  6 px. A seat action on a card there draws its count chip (`↓ +1`) and its wire
  over the column header (case 47: 8 px of the wire on the header text).
- **The phone's last corner.** The phone's gutter is 3.5 px from the port, less
  than the 6 px corner, so the corner ends past the port and the path runs 2.5 px
  back to it. It cannot be seen at 1×, and it adds 4 px to every phone wire.

## 3. How the cases were measured

One `describe` block in the kanban browser driver,
`orchestrator wire routing across the board's layouts`
(draft: `evidence/orchestrator-wire-routing/draft/browser-block.tsx.txt`), opens
the fixture once a case, makes the seat start a pipeline on the target cards
(`orchestratorAct`, the product's own layer reads the change), lets the pulse
end, freezes the layer's clock and reads every drawn path in Chromium:

- **bends**: the path's rounded corners (`Q`);
- **length**: `getTotalLength()`;
- **through**: path length inside a painted card (its box clipped to its
  column's scroller), inside the seat, or inside a line of text (a column
  header, the row of column links or tabs, a count chip), sampled every 2 px;
- **overlap**: path length lying within 2 px of another wire anywhere other than
  a common start. A shared start is the trunk of a tree, which reads as one wire
  branching; a shared run anywhere else hides which wire goes where.

The cases are every placement the seat has (on top and open, on top and folded
to its strip, on top and narrowed with its width grip, at the side in its own
column), every board mode the desktop has (wide at 1920 × 1080, scroll at
1440 × 900 and 1280 × 800 beside the sidebar, tabs at 1000 × 700) and the phone
at 390 × 844. The targets are the first card of Inbox, of In progress and of
Waiting (left of the seat, under it, right of it, far from it), the lowest card
still visible, a card the column has scrolled above or below its scroller (the
`&many=1` board, which fills In progress with thirty-odd cards), a deep card in
a scrolled column, several cards at once in different columns and in one
column, and on the phone a card in another tab. Each case ran in English and in
Ukrainian, on main (`2fda8a4e`) and on main with this rule applied in a scratch
export (`evidence/orchestrator-wire-routing/draft/orchestratorWires.prototype.diff.txt`).

All 212 readings, with each path's `d`, the seat's box, the columns and the row
of links, are in `evidence/orchestrator-wire-routing/routes.json`. The table
below lists the English cases; Ukrainian gives the same bends in every case, and
lengths 4–5 px longer in the 17 cases that go round the scrolling board's row of
column links, whose Ukrainian labels are wider. Cases the layout does not
produce are left out: with the seat open on top at 1280 × 800 the columns start
below the window, so only the scrolled cases there have a target; Done gets no
wire; the tabs board shows one column.

## 4. Case study

"Now" is main, "rule" is §5. Each cell is bends / length in px for each wire of
the case; `↓ +1` / `↑ +1` is the count drawn for a card the column has scrolled
past (its dashed wire is the one measured). No wire in either build runs through
a card or the seat; the two defects measured are marked in bold.

| # | Viewport, board mode | Seat | Target | Now: bends / px | Rule: bends / px | Rule's route |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1920×1080, wide | on top, open | Inbox, first card | 2 / 420 | 2 / 420 | side exit |
| 2 | 1920×1080, wide | on top, open | In progress, first card | 4 / 786 | 1 / 103 | drop |
| 3 | 1920×1080, wide | on top, open | In progress, lowest visible card | 4 / 786 | 1 / 103 | drop |
| 4 | 1920×1080, wide | on top, open | Waiting, first card | 4 / 1322 | 1 / 103 | drop |
| 5 | 1920×1080, wide | on top, open | several at once | 2 / 420; 4 / 786; 4 / 1322 | 2 / 420; 1 / 103; 1 / 103 | side exit; drop; drop |
| 6 | 1920×1080, wide | on top, open | In progress, card below the scroller | 4 / 894 ↓ +1 | 1 / 211 ↓ +1 | drop |
| 7 | 1920×1080, wide | on top, open | In progress, card scrolled above | 4 / 777 ↑ +1 | 1 / 94 ↑ +1 | drop |
| 8 | 1920×1080, wide | on top, folded strip | Inbox, first card | 2 / 124 | 2 / 132 | side exit from the avatar |
| 9 | 1920×1080, wide | on top, folded strip | In progress, first card | 4 / 490 | 2 / 301 | side exit past the title |
| 10 | 1920×1080, wide | on top, folded strip | In progress, lowest visible card | 4 / 772 | 2 / 583 | side exit past the title |
| 11 | 1920×1080, wide | on top, folded strip | Waiting, first card | 4 / 1026 | 2 / 837 | side exit past the title |
| 12 | 1920×1080, wide | on top, folded strip | several at once | 2 / 124; 4 / 490; 4 / 812; 4 / 1026 | 2 / 132; 2 / 301; 2 / 623; 2 / 837 | side exit from the avatar; side exit past the title; side exit past the title; side exit past the title |
| 13 | 1920×1080, wide | on top, folded strip | In progress, card below the scroller (the action lifted it into view) | 4 / 772 | 2 / 583 | side exit past the title |
| 14 | 1920×1080, wide | on top, folded strip | In progress, card scrolled above | 4 / 481 ↑ +1 | 2 / 291 ↑ +1 | side exit past the title |
| 15 | 1920×1080, wide | on top, folded strip | In progress, deep card, column scrolled | 4 / 772 | 2 / 583 | side exit past the title |
| 16 | 1920×1080, wide | own column at the side | Inbox, first card | 4 / 141 | 0 / 30 | straight |
| 17 | 1920×1080, wide | own column at the side | In progress, first card | 4 / 435 | 2 / 421 | bus |
| 18 | 1920×1080, wide | own column at the side | In progress, lowest visible card | 4 / 717 | 2 / 703 | bus |
| 19 | 1920×1080, wide | own column at the side | Waiting, first card | 4 / 971 | 2 / 957 | bus |
| 20 | 1920×1080, wide | own column at the side | several at once | 4 / 141 **overlap**; 4 / 435; 4 / 757; 4 / 971 | 0 / 30; 2 / 421; 2 / 743; 2 / 957 | straight; bus; bus; bus |
| 21 | 1920×1080, wide | own column at the side | In progress, card below the scroller (the action lifted it into view) | 4 / 717 | 2 / 703 | bus |
| 22 | 1920×1080, wide | own column at the side | In progress, card scrolled above | 4 / 425 ↑ +1 | 2 / 412 ↑ +1 | bus |
| 23 | 1920×1080, wide | own column at the side | In progress, deep card, column scrolled | 4 / 717 | 2 / 703 | bus |
| 24 | 1440×900, scroll | on top, open | Inbox, first card | 2 / 224 | 2 / 224 | side exit |
| 25 | 1440×900, scroll | on top, open | In progress, first card | 4 / 511 | 3 / 178 | round the link row |
| 26 | 1440×900, scroll | on top, open | In progress, lowest visible card | 4 / 511 | 3 / 178 | round the link row |
| 27 | 1440×900, scroll | on top, open | Waiting, first card | 4 / 1003 | 1 / 143 | drop |
| 28 | 1440×900, scroll | on top, open | several at once | 2 / 224; 4 / 511; 4 / 1003 | 2 / 224; 3 / 178; 1 / 143 | side exit; round the link row; drop |
| 29 | 1440×900, scroll | on top, open | In progress, card below the scroller | 4 / 534 ↓ +1 | 3 / 227 ↓ +1 | round the link row |
| 30 | 1440×900, scroll | on top, open | In progress, card scrolled above | 4 / 502 ↑ +1 | 3 / 195 ↑ +1 | round the link row |
| 31 | 1440×900, scroll | on top, folded strip | Inbox, first card | 2 / 164 | 2 / 172 | side exit from the avatar |
| 32 | 1440×900, scroll | on top, folded strip | In progress, first card | 4 / 451 | 4 / 336 | past the title, round the row's end |
| 33 | 1440×900, scroll | on top, folded strip | In progress, lowest visible card | 4 / 733 | 4 / 618 | past the title, round the row's end |
| 34 | 1440×900, scroll | on top, folded strip | Waiting, first card | 4 / 943 | 2 / 754 | side exit past the title |
| 35 | 1440×900, scroll | on top, folded strip | several at once | 2 / 164; 4 / 451; 4 / 773; 4 / 943 | 2 / 172; 4 / 336; 4 / 658; 2 / 754 | side exit from the avatar; past the title, round the row's end; past the title, round the row's end; side exit past the title |
| 36 | 1440×900, scroll | on top, folded strip | In progress, card below the scroller (the action lifted it into view) | 4 / 733 | 4 / 672 | past the title, round the row's end |
| 37 | 1440×900, scroll | on top, folded strip | In progress, card scrolled above | 4 / 442 ↑ +1 | 4 / 380 ↑ +1 | past the title, round the row's end |
| 38 | 1440×900, scroll | on top, folded strip | In progress, deep card, column scrolled | 4 / 733 | 4 / 672 | past the title, round the row's end |
| 39 | 1440×900, scroll | own column at the side | Inbox, first card | 2 / 105 | 0 / 26 | straight |
| 40 | 1440×900, scroll | own column at the side | In progress, first card | 2 / 397 | 2 / 397 | bus |
| 41 | 1440×900, scroll | own column at the side | In progress, lowest visible card | 2 / 679 | 2 / 679 | bus |
| 42 | 1440×900, scroll | own column at the side | Waiting, first card | 2 / 889 | 2 / 889 | bus |
| 43 | 1440×900, scroll | own column at the side | several at once | 2 / 105; 2 / 397; 2 / 719; 2 / 889 | 0 / 26; 2 / 397; 2 / 719; 2 / 889 | straight; bus; bus; bus |
| 44 | 1440×900, scroll | own column at the side | In progress, card below the scroller (the action lifted it into view) | 2 / 679 | 2 / 679 | bus |
| 45 | 1440×900, scroll | own column at the side | In progress, card scrolled above | 2 / 387 ↑ +1 | 2 / 387 ↑ +1 | bus |
| 46 | 1440×900, scroll | own column at the side | In progress, deep card, column scrolled | 2 / 679 | 2 / 679 | bus |
| 47 | 1280×800, scroll | on top, open | In progress, card below the scroller | 4 / 414 **text 8px** ↓ +1 | nothing drawn | — |
| 48 | 1280×800, scroll | on top, open | In progress, card scrolled above | 4 / 442 ↑ +1 | nothing drawn | — |
| 49 | 1280×800, scroll | on top, folded strip | Inbox, first card | 2 / 164 | 2 / 172 | side exit from the avatar |
| 50 | 1280×800, scroll | on top, folded strip | In progress, first card | 4 / 451 | 4 / 336 | past the title, round the row's end |
| 51 | 1280×800, scroll | on top, folded strip | In progress, lowest visible card | 4 / 733 | 4 / 618 | past the title, round the row's end |
| 52 | 1280×800, scroll | on top, folded strip | Waiting, first card | 4 / 943 | 2 / 754 | side exit past the title |
| 53 | 1280×800, scroll | on top, folded strip | several at once | 2 / 164; 4 / 451; 4 / 943 | 2 / 172; 4 / 336; 2 / 754 | side exit from the avatar; past the title, round the row's end; side exit past the title |
| 54 | 1280×800, scroll | on top, folded strip | In progress, card below the scroller (the action lifted it into view) | 4 / 733 | 4 / 672 | past the title, round the row's end |
| 55 | 1280×800, scroll | on top, folded strip | In progress, card scrolled above | 4 / 442 ↑ +1 | 4 / 380 ↑ +1 | past the title, round the row's end |
| 56 | 1280×800, scroll | on top, folded strip | In progress, deep card, column scrolled | 4 / 733 | 4 / 672 | past the title, round the row's end |
| 57 | 1280×800, scroll | own column at the side | Inbox, first card | 2 / 105 | 0 / 26 | straight |
| 58 | 1280×800, scroll | own column at the side | In progress, first card | 2 / 397 | 2 / 397 | bus |
| 59 | 1280×800, scroll | own column at the side | In progress, lowest visible card | 2 / 679 | 2 / 679 | bus |
| 60 | 1280×800, scroll | own column at the side | Waiting, first card | 2 / 889 | 2 / 889 | bus |
| 61 | 1280×800, scroll | own column at the side | several at once | 2 / 105; 2 / 397; 2 / 719; 2 / 889 | 0 / 26; 2 / 397; 2 / 719; 2 / 889 | straight; bus; bus; bus |
| 62 | 1280×800, scroll | own column at the side | In progress, card below the scroller (the action lifted it into view) | 2 / 679 | 2 / 679 | bus |
| 63 | 1280×800, scroll | own column at the side | In progress, card scrolled above | 2 / 387 ↑ +1 | 2 / 387 ↑ +1 | bus |
| 64 | 1280×800, scroll | own column at the side | In progress, deep card, column scrolled | 2 / 679 | 2 / 679 | bus |
| 65 | 1000×700, tabs | on top, open | In progress, first card | 2 / 172 | 2 / 180 | margin (tabs row) |
| 66 | 1000×700, tabs | on top, open | In progress, lowest visible card | 2 / 430 | 2 / 438 | margin (tabs row) |
| 67 | 1000×700, tabs | on top, open | several at once | 2 / 172 | 2 / 180 | margin (tabs row) |
| 68 | 1000×700, tabs | on top, open | In progress, card below the scroller (the action lifted it into view) | 2 / 430 | 2 / 438 | margin (tabs row) |
| 69 | 1000×700, tabs | on top, open | In progress, card scrolled above | 2 / 162 ↑ +1 | 2 / 170 ↑ +1 | margin (tabs row) |
| 70 | 1000×700, tabs | on top, open | In progress, deep card, column scrolled | 2 / 430 | 2 / 438 | margin (tabs row) |
| 71 | 1000×700, tabs | on top, folded strip | In progress, first card | 2 / 172 | 2 / 180 | margin (tabs row) |
| 72 | 1000×700, tabs | on top, folded strip | In progress, lowest visible card | 2 / 430 | 2 / 438 | margin (tabs row) |
| 73 | 1000×700, tabs | on top, folded strip | several at once | 2 / 172 | 2 / 180 | margin (tabs row) |
| 74 | 1000×700, tabs | on top, folded strip | In progress, card below the scroller (the action lifted it into view) | 2 / 430 | 2 / 438 | margin (tabs row) |
| 75 | 1000×700, tabs | on top, folded strip | In progress, card scrolled above | 2 / 162 ↑ +1 | 2 / 170 ↑ +1 | margin (tabs row) |
| 76 | 1000×700, tabs | on top, folded strip | In progress, deep card, column scrolled | 2 / 430 | 2 / 438 | margin (tabs row) |
| 77 | 1000×700, scroll | own column at the side | Inbox, first card | 2 / 105 | 0 / 26 | straight |
| 78 | 1000×700, scroll | own column at the side | In progress, first card | 2 / 397 | 2 / 397 | bus |
| 79 | 1000×700, scroll | own column at the side | In progress, lowest visible card | 2 / 679 | 2 / 679 | bus |
| 80 | 1000×700, scroll | own column at the side | Waiting, first card | 2 / 889 | 2 / 889 | bus |
| 81 | 1000×700, scroll | own column at the side | several at once | 2 / 105; 2 / 397; 2 / 889 | 0 / 26; 2 / 397; 2 / 889 | straight; bus; bus |
| 82 | 1000×700, scroll | own column at the side | In progress, card below the scroller (the action lifted it into view) | 2 / 679 | 2 / 679 | bus |
| 83 | 1000×700, scroll | own column at the side | In progress, card scrolled above | 2 / 387 ↑ +1 | 2 / 387 ↑ +1 | bus |
| 84 | 1000×700, scroll | own column at the side | In progress, deep card, column scrolled | 2 / 679 | 2 / 679 | bus |
| 85 | 1920×1080, wide | on top, narrowed to 640 px | Inbox, first card | 2 / 620 | 2 / 620 | side exit |
| 86 | 1920×1080, wide | on top, narrowed to 640 px | In progress, first card | 4 / 986 | 2 / 249 | side exit |
| 87 | 1920×1080, wide | on top, narrowed to 640 px | Waiting, first card | 4 / 1522 | 1 / 103 | drop |
| 88 | 1920×1080, wide | on top, narrowed to 640 px | several at once | 2 / 620; 4 / 986; 4 / 1522 | 2 / 620; 2 / 249; 1 / 103 | side exit; side exit; drop |
| 89 | 390×844, phone | card above the tabs | In progress, first card | 2 / 106 | 2 / 102 | phone margin |
| 90 | 390×844, phone | card above the tabs | In progress, lowest visible card | 2 / 257 | 2 / 253 | phone margin |
| 91 | 390×844, phone | card above the tabs | Inbox, first card | 2 / 106 | 2 / 102 | phone margin |
| 92 | 390×844, phone | card above the tabs | several at once | 2 / 106; 2 / 257; 2 / 372 | 2 / 102; 2 / 253; 2 / 368 | phone margin; phone margin; phone margin |
| 93 | 390×844, phone | card above the tabs | In progress, card below the scroller (the action lifted it into view) | 2 / 257 | 2 / 253 | phone margin |
| 94 | 390×844, phone | card above the tabs | card in another tab | nothing drawn | nothing drawn | — |

**Totals over all 212 readings.** Now: 240 wires, 708 bends, 134 720 px. The
rule: 236 wires (cases 47–48, in both languages, draw nothing), 480
bends, 97 384 px. On the seat on top at 1920 the mean wire falls from 3.5 bends
and 795 px to 1.65 bends and 342 px; at 1440 from 3.6 bends and 578 px to 2.85
bends and 362 px. The folded strip's rows (8–15, 31–38, 49–56, 65–76; the
1000 × 700 board folds the seat by itself, so 65–70 are the strip too) are the
built layer's readings after the fix of §5, "The folded strip"; before it they
read 1 bend for each drop and 3 round the link row, from ports on the strip's
empty foot (428 bends, 82 102 px in all). Nothing in either build runs through a card or the seat; the
rule's paths run through no text and overlap nowhere outside a shared trunk.

## 5. The routing rule

> **A wire takes the route with the fewest bends, and of those the shortest,
> that leaves the seat, as the operator sees it, from its edge, enters the card's port from its column's
> gutter, and crosses no column but its own, nothing of the seat panel, and no
> line of text. Wires that leave the seat at the same point share their run
> from it as one trunk, each until it turns down its own column's gutter, and
> wires to cards of one column share that gutter too; no two wires share a run
> anywhere else.**

"Text" is a column header, the row of column links or tabs, and a count chip.
A column is out of bounds as a whole, its empty part too: a card can land there
at any time, and a wire across a column reads as pointing into it. The card's
port, the 22 px port height, the 9 px gutter and bus offsets, the 6 px rounded
corner and the counts at the scroller's edge are unchanged.

The seat as the operator sees it is the seat panel, open or folded, on top or
at the side, with one exception: folded on top with nothing for the operator,
the strip has no fill and no frame, and the seat is its avatar and title (see
"The folded strip" below).

On this board the rule resolves to one of six shapes, tried in this order; the
first that is clear is drawn. Each shape leaves the seat at the point of its
edge nearest the gutter, so each is the shortest of its bend count.

| Shape | Bends | When it is clear | Path |
| --- | --- | --- | --- |
| Straight | 0 | the seat at the side, the card in the column beside it (gap ≤ 24 px), its port within the seat's height | out of the seat's right edge at the port's height, straight into the port |
| Drop | 1 | the seat on top spans the column's gutter, and no column link stands between its bottom edge and the port | down from the seat's bottom edge at the gutter, into the port |
| Side exit | 2 | the seat on top: the gutter lies beyond one of its sides. The seat at the side: any farther column | seat on top: out of the facing side at the seat's foot (14 px above its bottom), across to the gutter, down, into the port. Seat at the side: out of the right edge at the bus, along the bus, down the gutter, into the port |
| Round the link row | 3 | the seat on top over the gutter, with a column link below it | down from the seat's bottom at the nearest point clear of the links, along the bus under them, down the gutter, into the port |
| Round the link row from the side | 4 | nothing above is clear, the seat's bottom cannot reach the bus past the links (a folded strip whose row of links starts under its avatar), and the route is shorter than the margin one | out of the facing side at the seat's foot, 12 px past the end of the row of links, down to the bus under them, back along it to the gutter, down, into the port |
| Margin | 2 to 4 | nothing above is clear: the tabs board, whose row of tabs spans the whole width | today's route: out of the foot of the seat's left edge, down the board's left margin, along the bus when the column is not the first, down the gutter |

The phone's seat card sits above a row of tabs as wide as the screen, so every
phone wire takes the margin shape: out of the seat card's left edge, down the
open tab's left margin (2 bends), as today.

Two details complete the rule:

- **The bus beside a seat at the side** runs 9 px above the columns, and no
  higher than 6 px under the seat's top: on the wide board, whose columns start
  12 px under the seat's top, it runs at the seat's top plus 6 px, so the wire
  leaves the seat level with the bus and never hooks back.
- **The last corner never passes the port.** The corner into the port is 6 px or
  the distance from the gutter to the port, whichever is less.

And one change to where a count is drawn, because otherwise the rule cannot be
kept: **a column whose scroller shows less than 38 px** (the 26 px count chip
and its 6 px margins) is treated as out of view, like a column scrolled out
sideways. It draws no count and no wire, and its wire appears when the column
comes into view within the minute.

**Several wires at once.** The rule makes them trees rooted at the seat, one
for each point a route leaves it. A drop leaves the seat's bottom edge at its
own column's gutter, so each column reached by a drop has its own exit and its
own trunk. A side exit leaves the foot of the facing side, whichever column it
goes to, so every column on that side of a seat on top shares the one exit: the
wires run together from it and each turns down at its own gutter, the nearest
first (`1920-top-narrow-*-several`: Inbox and In progress share 128 px from the
seat's left side). The bus beside a seat at the side is the same tree: every
farther column leaves the seat's one bus exit and branches down its gutter
(`1440-side-*-several`). Within a column the wires share its gutter and branch
into each card at its port. A shared run is always the start of both wires,
which reads as one wire branching; under the rule no case has a run shared
anywhere else, and the near-parallel length (within 6 px of another wire) is at
most 6 px, at the branch corners. The seat gets a port dot at each exit point
it has, drawn and faded as the one seat port is today.

**The folded strip.** Folded on top and at rest, the seat's strip has no
background and no border: the avatar and the title at its left, two buttons at
its right, and nothing between. A route that left the strip's box would start
in that empty space: the first build dropped from the strip's invisible bottom
edge at each gutter, and its port dots hung on the background with nothing to
say where the wire came from (the review of `023dba9d`, frames
`<width>-top-folded-<lang>-*` at 1920, 1440 and 1280). So for this strip the
seat is its avatar and title, and their ports are on what the operator sees: a
wire to a column on the avatar's left leaves the avatar's left edge, and every
other wire leaves 8 px past the title's last letter, level with the avatar's
middle, so the dot covers no letter. The two buttons at the strip's right are
text in a route's way, as the column links are. On the wide board that costs
the drops one bend (2 for 1); on the scrolling board the row of column links
starts under the avatar, so a column whose gutter lies under the row goes out
past the title and round the row's end in four bends, which is about 115 px
shorter than the margin route out of the avatar with as many. A strip that
needs the operator, failed or holds an unread reply has its frame back, and its
box is the seat as before. On the tabs board the strip's wires take the margin
route as before, now out of the avatar's edge.

## 6. What the builder changes

All of it is in `src/components/kanban/orchestratorWires.ts`; the prototype diff
(`evidence/orchestrator-wire-routing/draft/orchestratorWires.prototype.diff.txt`)
is a working sketch of it that the readings above were taken from.

- **`gutter()` becomes `route()`**, returning `{ d, exit }`: the shapes of
  §5 in order, each checked against the row of links (`crosses()`, a box test
  on its straight runs with a 2 px margin). The margin shape is today's code.
  The last-corner radius is `min(6, into − trunk)`.
- **`seatPort()`**: at the side, the exit's height is the bus's, clamped to no
  higher than the seat's top plus 6 px (today plus 12). On top, it keeps the
  foot of the left edge for the margin shape; the side exit uses the foot of the
  facing side.
- **`update()`**: for a seat on top, read the row of links once a pass
  (`root.querySelectorAll(".tabs-nav button")`, four boxes at most) and hand it
  to `route()`; collect each route's exit; draw a seat port at each distinct
  exit in place of the single `seatDot`, all of them fading with the last wire
  as `seatDot` does now. The counts' dashed wires go through `route()` too.
- **`locate()`**: a column whose visible scroller is under 38 px tall returns
  `hidden: "away"`.

Nothing changes in `SeatActionWires.tsx`, `orchestratorArrows.ts` or the
stylesheet. `docs/design/orchestrator-arrows.md` §9 ("The look") still
describes the margin route for a seat on top; the builder points it here.

**Cost.** At rest nothing changes: no layer, no read. While a wire shows, a pass
on a board with the seat on top reads up to four more boxes (the link row) and
tries at most six shapes a wire; a folded strip with no frame reads its avatar,
its title and the controls of its head instead of its own box (the folded frame
of `orchestrator wires after a seat action` goes from 140 to 145 reads over
its 15 passes); the side seat and the phone read nothing new.
The builder re-runs the existing cost case (`evidence/orchestrator-wires/cost.json`)
to show it.

## 7. Tests the builder adds

**DOM tests**, in `src/components/kanban/orchestratorWires.dom.test.ts` (draft:
`evidence/orchestrator-wire-routing/draft/orchestratorWires.routing.dom.test.ts.txt`).
Each places the seat, the columns, the cards and the row of links at a case's
measured boxes, acts, and checks the bends, the start where it matters, and
that no straight run of the path passes through a card, the seat or a link
(`through()` over the path's corners). Run against main they are red where
marked; against the prototype the thirteen of the study pass. The six below
the line were added in review, for the cases the thirteen left to the browser
block alone: they pass on the built rule and are red on main where marked.

| Test | Case | On main |
| --- | --- | --- |
| seat on top over the target's gutter (the operator's case): one elbow down from the seat's foot, through nothing | 2 | red (4 bends) |
| seat on top, target column left of it: two elbows out of the seat's left side | 1 | green, pins it |
| seat on top narrowed by its width grip, target column right of it: two elbows out of the seat's right side | 85–88 geometry | red |
| a row of column links under the gutter: round it along the bus, three elbows, never through a link | 25 | red (4) |
| a row of column links clear of the gutter: one elbow | 27 | red (4) |
| seat at the side, card in the column beside it: a straight wire | 39 | red (2) |
| seat at the side, card in a farther column: two elbows along the bus, over no card | 40 | green, pins it |
| seat at the side with the columns flush with its top (1920, wide): two elbows, no hook back above the seat | 16–20 | red (4, runs back left) |
| several wires at once: two cards of one column share their trunk from the seat, a drop to another column shares nothing | 5 | red |
| a card scrolled out below its column: the count's wire takes the same one-elbow route | 6 | red (4) |
| a column whose scroller shows a few pixels under its header draws no count over the header | 47 | red (count drawn) |
| a full-width row of tabs under the seat: no route through it, the margin route stays | 65 | green, pins it |
| the phone: the last corner never runs past the card's port | 89 | red |
| *added in review* | | |
| seat on top narrowed, two target columns on its left: one exit, a shared run from it as their trunk, each down its own gutter | 88 | red (4 bends, three wires on one margin) |
| seat at the side, several columns: every bus wire leaves the one exit and shares the bus as its trunk, nothing after its gutter | 43 | red (the Inbox wire: 2 bends, on the bus) |
| a card scrolled out above its column: the count sits at the scroller's top, one elbow down from the seat's foot | 7 | red (4) |
| a card scrolled out above its column in the other layouts: the count's wire takes the layout's own route | 14, 30, 37, 45, 69 | red (4 for 3 at 1440, 4 for 2 on the strip) |
| *changed in the fix stage, for the folded strip's ports (§5)* | | |
| the folded strip on the wide board: out of its avatar to the column left of it, out past its title to the others, no port on empty space | 8–12 | red (4); red on `023dba9d` (ports on the strip's empty foot) |
| the folded strip over the row of column links: out past its title, round the row's end in four elbows where the margin route is longer | 31–35 | red (4 for 4, 451 px); red on `023dba9d` (ports on the empty foot) |
| a folded strip that needs the operator has its frame back: its box is the seat, and a drop leaves its bottom edge | 9 with the frame | green, pins it |

The folded and side cases at 1280 × 800 and the side cases at 1000 × 700
(49–64, 77–84) have the boxes of their 1440 × 900 counterparts moved as a
whole, and on the tabs board the seat's box is the same open and folded
(65–76), so the same tests stand for them. The tests that take several wires
also measure what each pair shares (`shared()`): a run within 2 px counts as
trunk only along the two wires' common start, and anywhere else it must be 0.

**Browser block**, `orchestrator wire routing across the board's layouts` in
`src/components/kanban/kanbanBoard.browser.test.tsx`: the draft in
`evidence/orchestrator-wire-routing/draft/browser-block.tsx.txt`, which the
builder turns from a reading into a gate: for every case, no length through a
card, the seat or text, no overlap outside a trunk, the bends this table
gives, and every seat port within 9 px of the seat as drawn (the folded strip
with no frame: its avatar and title, its buttons counted as text). The expected bends are the `rule` readings in
`evidence/orchestrator-wire-routing/routes.json`, which stays the study's
record; a full run writes the built layer's readings to
`evidence/orchestrator-wire-routing/rendered.json` and the frames to
`.artifacts/orchestrator-wire-routing/<label>/`. `WIRE_ROUTING_LABEL=current`
only reads, for the frames of a build without the rule. Lane 344a7704 owns the other cases
of that file and its fixtures: the builder adds this one block and touches
nothing else there; the fixture needs nothing new (the narrowed seat is the
seat store's `topWidths`, set in the block's init script).

Run it as the existing block is run:

```
LLV_KANBAN_BROWSER_TEST=1 CHROME_BIN=<chrome> bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "orchestrator wire routing"
```

with isolated `HOME`, state and `TMPDIR`, a short `TMPDIR` for Chromium, and
`LLV_VIEWER_CONTROL_URL` on a closed port. The 212 cases take about eight
minutes.

**Three expectations of the existing block change.** `orchestrator wires after a
seat action` in the same file was written for one seat port and a bend in every
wire. Under the rule its desktop action frame draws a straight wire into the
Inbox card beside the side seat, and two seat ports (the straight exit and the
bus exit), and its seat-on-top frame draws two ports (a side exit and a drop).
Run against the prototype, that block fails on these lines and on nothing else;
with them changed it passes (3 of 3 tests):

- `expect(wire.corners).toBeGreaterThanOrEqual(1)` goes (the `crossed === 0`
  check beside it stays);
- `expect(state.seatPort).toBe(phone ? 0 : 1)` becomes `phone ? 0 : 2`;
- `expect(state.seatPort).toBe(1)` in the seat-on-top frame becomes `2`.

That block is this feature's own evidence from #2565, in the file lane 344a7704
is working in. The fence lets this lane add its own block there; these three
lines are the one exception it needs, and the builder touches nothing else of
that file.

## 8. Deferred — not currently justified

- **A general orthogonal router** (a search over a grid or a visibility graph
  of the board). Six shapes cover every layout the board produces, and each
  is the shortest of its bend count; a search would add code and a per-pass
  cost for no route it would draw differently.
- **Separate lanes for wires that share a gutter** (each wire offset a few px).
  The gutter is 12–16 px wide; a tree with one trunk reads as one wire
  branching, and the measurements show no shared run outside a trunk.
- **Ports on the card's top edge**, which would let a drop end without its last
  corner. The port on the card's left edge is part of the Variant 2 look the
  spec keeps.
- **A one-bend phone wire** through the row of tabs: the tabs are text.
- **Hiding the row of column links while a wire shows**, which would let every
  drop on the scrolling board take one bend: that is a change to the board, out
  of this work's scope (route geometry only).

## 9. Decisions taken here

- The operator chose Variant 1, «Fewest bends, then shortest», in the prototype
  review on 2026-10-07; that is the rule of §5.
- The seat's box is the seat element's box in every placement except the
  folded strip with no frame, whose seat is its avatar and title (§5, "The
  folded strip"). The first build kept the strip's box; its review found the
  ports of the drops hanging on the empty background, and the fix stage
  changed it.
- A column that shows under 38 px of its scroller counts as out of view (§5).
- Done gets no wire, as before; acting on a Done card was not measured.

## Reproducing

The rule is built: the block of §7 runs as a gate on any checkout that has
it. For the frames of the route before the rule, append the block to a
scratch export of `2fda8a4e` and run it there with `WIRE_ROUTING_LABEL=current`;
`WR_ONLY=<regex>` limits either run to the matching case ids. The drafts the
study was measured with stay under `evidence/orchestrator-wire-routing/draft/`.
