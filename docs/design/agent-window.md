# Agent window: a click on the board opens the agent in one window

## The requirement

Operator, 2026-10-07 around 15:00 Kyiv, by voice in Russian, with a screenshot
of a card in «У роботі» whose Build stage had expanded inline into a tall
conversation pane, and a dim panel on the left reading «1 агент відкритий ·
Build · Закрити всі». The key lines, verbatim:

> «я нажал на build … раскрылась вот эта разговор … она сильно-сильно прыгает
> … я передумал … сделать так, что вот теперь на досках невозможно раскрыть
> будет вот так компоузер, как вот оно сейчас раскрывается. Оно сразу
> открывает большое окошко, но в большом окошке мы можем иметь много этих
> компоузеров, и … между ними переключаться. Вот у нас есть вот сбоку вот эта
> штучка, там где пишется «1 агент відкритий», она сейчас … затуманена, и
> вроде бы невозможно ею управлять … Нужно сделать, чтобы … были сразу как
> один режим, где ты просматриваешь ближе. Но на доске … агентов ты раскрыть
> не можешь, ты можешь раскрыть схему … более крупно показать, но именно
> агентов ты раскрыть не можешь … когда кликаешь, … сразу раскрывается
> нормальном виде в этом окошке, … все агенты в карусель становятся, и ты
> между ними можешь … переключаться, и вот эта штучка справа … тоже должна
> быть там … показываться.»

Read as five points, each of which the design below has to meet:

1. An agent on the board (a stage chip such as Build or Review, or a
   conversation tile on a card) never expands inside its card. The card keeps
   its geometry, and a click opens the large window at once with the
   conversation in its normal full view.
2. The window holds every agent the operator opened, and the operator switches
   between them as a carousel (next and previous, the keyboard, a swipe on the
   phone) without closing it.
3. The open-agents list that stands beside the board today («N агент
   відкритий», one row per agent, «Закрити всі») becomes part of the window as
   its switcher, fully interactive.
4. The board can still enlarge the pipeline graph (the Stages sheet) as it does
   today. Agents are the only thing that loses the inline expansion.
5. The window reuses the existing conversation pane, composer and open-agents
   list, adds no chrome beyond what it needs, and uses no liquid glass. The
   orchestrator dock stays as it is.

## What happens today (the before-reference)

Captured on 5a197eeb5 through the kanban browser driver's harness
(`issue1695BrowserHarness.ts`) over `issue1695Evidence.fixture.tsx?scenario=stages`,
clicking the Build chip of «Rework the retry banner until review passes».
Readings are in `evidence/agent-window/before.json`. Frames are under
`~/Pictures/delegatus-review/agent-window/before/`, together with the existing
driver's own open-agents frames (`kanbanBoard.browser.test.tsx`, «the open
agents at the board's side», 1 pass).

| Width | Card grows | Clicked chip moves | Columns | In progress column |
|---|---|---|---|---|
| 1440 | +544 px | 521 px up | every column 200 px right, 37 px up | 96 px wider |
| 1000 | +525 px | 527 px up | in place (tabs mode) | 56 px narrower |

The jump has three causes, and all three are in the code:

- the card hosts the reader (`KanbanCard.tsx:412-413`, `stageReaders` and
  `openTiles`, rendered at `:782-825`), so the card grows by a whole
  conversation;
- `revealCard` scrolls the new reader into view (`KanbanBoard.tsx:1832-1905`),
  so the content moves under the pointer;
- the first open agent brings the rail into its own strip beside the columns
  (`OpenAgentsRail`, `KanbanBoard.tsx:2845`), and the layout reserves that
  strip (`kanbanLayoutModeBeside(…, OPEN_RAIL_WIDTH[tier])`, `:666`), so every
  column moves sideways; a column holding a reader also takes the wider
  «reading» track (`readingStatuses`, `:2468-2497`).

The list itself is fully wired today (a row jumps, × closes, «Закрити всі»
closes every one, Alt+J and Alt+K walk them), but its head is drawn in the
secondary colour (rgb(85, 85, 95) measured), its × buttons show only on hover,
and a row's click scrolls the board to the card. It reads as a passive caption
beside the board, which is what the operator called «затуманена».

At 390 px the phone already does what points 1 and 2 ask for: «Відкрити
агента» opens the conversation full screen (`MobileFocusView`), a swipe across
its bar steps to the next agent, and the title opens the switcher sheet
(`MobileSwitchSheet.tsx`).

## The design

### What opens on a click

A click on a stage chip with a conversation, a node in a card's graph, or a
conversation tile opens that conversation in the agent window and adds it to
the window's list. The card is not touched. It does not grow, the board does
not scroll, and the columns do not move. The chip or tile stays where it was,
marked as open (the chip's existing `aria-pressed` ring, and an accent edge on
the tile). In the prototypes the measured change of both cards' boxes, from the
bare board through every step of every variant at both widths, is 0 px
(`evidence/agent-window/variants-all.json`, `cardDeltaFromBoard`).

The same path serves everything else that opens a conversation: a
`#c=` link, an attention handoff's `open` intent, and a conversation no card
holds, which already opens in this window today (`looseReader`). The handoff's
`show` intent still only reveals the card.

### How the carousel orders agents

Agents stand in the order they were opened, and a new one joins at the end.
Opening one that is already open shows it in place and does not move it. The
order is the one `ReaderMemory` already keeps (`readerMemory.ts`), so a reload
restores the same list. Next and previous go round the ends, the way
`cycleOpenAgent` already does.

### How the window is closed

- **Esc**, the reader header's existing «leave the whole window» button, or a
  click on the dimmed board (variants 1–3; the prototypes do not draw this
  one) closes the window. The agents stay
  open, and the list shrinks to one pill at the foot of the board pane, «N
  агенти відкриті ⤢». A click on it brings the window back on the agent shown
  last. The pill floats over the board and takes no strip, so the columns
  never move.
- **×** on a list row, or the reader header's ×, closes that one agent. The
  window shows its neighbour (the next, or the previous at the end), and
  closing the last agent closes the window.
- **«Закрити всі»** closes every agent and the window, and the pill goes with
  them.

### Keyboard

- Alt+J and Alt+K (by key position, the same chord as today) step to the next
  or previous agent, from inside a composer too. With the window closed, Alt+J
  opens it on the agent shown last.
- Esc closes the window in one press, whether focus is in the list or the
  reader. Inside a composer or an open menu, Esc keeps its own meaning, as the
  whole-window reader's Escape does today.
- A switch puts focus in the reader that was brought in. The list's rows are
  buttons in tab order before the reader.

### Phone

The phone is unchanged in every variant. It already opens an agent full screen
at once, its bar and dock swipe step between agents, and its title opens the
switcher, which is the phone's form of the open-agents list. Every variant's
review carries the same four phone frames, with the variant printed on them.

### The variants

All four are drawn on the real components. The conversation is the product's
reader (`KanbanReaders.tsx`) in the product's whole-window host
(`.reader-full`), and the switcher is the product's `OpenAgentsList` at full
contrast, with a role bar on the agent on screen and its × always visible. They
differ only in where the list stands and how the window sits over the board.

1. **List at the window's left.** The board dims behind one window: the list
   is its left column (248 px at 1440, 212 px at 1000) with ‹ › in its head,
   and the conversation fills the rest. A long list scrolls in its column. It
   is the list as it is today, moved into the window.
2. **Tabs across the window's top.** The same rows laid out as tabs above the
   conversation, with ‹ › in the head and «Закрити всі» at the strip's end. The
   conversation gets the full window width. Past five agents at 1000 px the
   tabs scroll sideways.
3. **Carousel with neighbours.** The agent on screen sits in the middle; the
   previous and the next stand dimmed at the window's sides as the real
   readers, and a click on one brings it to the middle. Large ‹ › sit at the
   window's edges, and the list is one strip under the window. It is the most
   literal «карусель» of the four and the heaviest, because up to three live
   conversations render at once.
4. **Window in the columns' place.** Nothing is dimmed. The window takes
   exactly the columns' frame, and the header, the sidebar and the orchestrator
   seat stay visible and usable beside it. The list is the window's left
   column. The board comes back when the window closes.

### What happens to the inline-expansion code

The change is mostly removal:

- **The card stops hosting readers.** `stageReaders`, `openTiles` and their
  `ReaderSlot`s go from `KanbanCard.tsx` (`:412-413`, `:782-825`), and so do
  `readerKeysByCard` (`KanbanBoard.tsx:630-640`), the `.card.has-reader` rules
  (`kanbanBoard.css:1171`, `:1808-1812`), and the reader-driven «reading»
  column tracks (`readingStatuses` from readers, `kanbanColumnTracks`'s
  `reading`). Drafts and the new-task composer keep their tracks.
- **One window, many agents.** `fullReader` becomes the window's current agent.
  `.reader-full` renders the `OpenAgentsList` beside the `ReaderSlot`, which
  makes it the window. `openReaderFor` sets the window's agent for every
  conversation, so the loose reader stops being a special case.
  `ReaderPlacement` keeps parking readers that are not shown, so a composer's
  draft and a feed's scroll survive a switch, as they survive a move today.
- **The rail stops taking a strip.** The side tier of `OpenAgentsRail`,
  `openRailTier`, `OPEN_RAIL_WIDTH` and the rail's share of
  `kanbanLayoutModeBeside` go. The compact tier's count becomes the pill.
  `jumpToAgent` stops revealing the card and widening its column
  (`widenIfNarrow`); it sets the window's agent.
- **Fold goes.** A reader in the window has no fold, so the fold button and
  `OpenReader.folded` go. Stored readers that carry `folded` are read and
  ignored.
- **Drafts leave the list.** A new-agent draft (`draftAgents`) stays in its
  card as today. The list holds agents, and a draft becomes one when it
  launches.
- **Unchanged.** The Stages sheet and its panes (point 4), a not-started
  stage's first-message panel on its card (a short form with no agent yet, so
  it leaves the card when the stage starts and its agent joins the window's
  list), the orchestrator seat, and the phone.
- **Tests that move.** `KanbanOpenAgents.dom.test.tsx`, `KanbanReaders.dom.test.tsx`,
  and the kanban browser driver's «the open agents at the board's side» and
  «a column widens itself» blocks assert the side strip and the in-card
  readers. They become window assertions, and the driver gains the window's
  case in place of a new file.

## Recommendation

**Variant 1.** It is the operator's list, moved into the window where they
asked for it, as the same rows. It holds seven or more agents without
crowding, because the column scrolls, and it renders one conversation at a
time. Variant 4 is the alternative if the orchestrator seat should stay usable
while the window is open. Variant 3 matches the word «карусель» most literally,
and it costs three live feeds rendered at once.

## Validation against the requirement

- «на доске агентов ты раскрыть не можешь»: the cards' boxes stay unchanged
  (0 px) through every step in all four variants, at 1440 and 1000.
- «сразу открывает большое окошко … в нормальном виде»: one click shows the
  full reader in the window (frame `02-one-stage`).
- «много этих компоузеров … переключаться … карусель»: three agents, switched
  by row, by ‹ › and by Alt+J, wrapping round (frames `04`–`06`, the video).
- «эта штучка … тоже должна быть там»: the list is inside the window, full
  contrast, every row a button with its × (all frames from `02`).
- «ты можешь раскрыть схему»: the Stages sheet is untouched.

## How the prototypes were made

The driver is a stage-scratch script that is not in the tree. It serves the
kanban fixture through `serveEvidenceFixture`, lays a variant's stylesheet over
the production one, and adds a thin click shim: a click on a chip or a tile
puts that agent in the window through the reader's own whole-window toggle,
in-card reader slots are not drawn, and the columns keep the tracks they had
with nothing open. The board, reader, composer and list are the product's
components, with no product file edited. Frames and videos are under
`~/Pictures/delegatus-review/agent-window/<variant>/`, and the readings are in
`evidence/agent-window/`.

## Deferred: not currently justified

- **A first-message panel for a not-started stage in the window.** It is a
  form with no agent yet, it does not cause the jump the operator reported,
  and the window would need a second kind of pane to host it.
- **An «Opened from the board» section in the phone's switcher.** The phone
  has no inline expansion to remove, and its swipe already walks the agents
  the operator works with.
- **Reordering agents by dragging rows.** Nothing in the requirement asks for
  it, and the open order is stable.
- **Arrow-key switching.** Arrow keys already belong to the feed and the
  composer, and Alt+J/K covers switching without a conflict.
