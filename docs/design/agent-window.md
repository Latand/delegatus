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

### What the window shows when an agent comes in

An agent that was already open comes in with its last rendered feed and
toolbar, in the frame the switch happens. Every open agent's reader stays laid
out at the size the window gives its reader while it waits: the park that
holds the readers not on screen sits off screen at that width and height with
`visibility: hidden`, where today it is `hidden` and lays nothing out. A
reader parked at zero width is what made the composer toolbar fold its third
button into ⋯ and unfold it again on every switch.

A first open is held back until its feed has content and its toolbar has kept
one layout for two frames, then fades in over 140 ms; the list and the
window's frame show at once. The feed's skeleton (`FeedSkeleton`, `LogFeed.tsx`)
therefore never appears in the window, and a slow read past 1.2 s shows the
reader with its skeleton, so the window is never left empty.

The prototypes trace every frame of every open and switch
(`variants-all.json`, `transitions`): across 96 transitions (8 per run, three
variants, two widths, two languages) no frame showed a skeleton, and every
incoming agent kept one toolbar layout from its first visible frame. The
first revision showed a skeleton for 3–4 frames on each first open and a second
toolbar layout on each switch.

### How the carousel orders agents

Agents stand in the order they were opened, and a new one joins at the end.
Opening one that is already open shows it in place and does not move it. The
order is the one `ReaderMemory` already keeps (`readerMemory.ts`), so a reload
restores the same list. Next and previous go round the ends, the way
`cycleOpenAgent` already does.

### How the window is closed

- **× in the window's corner**, or **Esc**, closes the window. Its label says
  so («Закрити вікно (Esc) — агенти лишаються відкритими»). The agents stay
  open, and focus goes to the pill that brings the window back. The reader
  header's ⤡ («leave the whole window») and its fold button are not drawn in
  the window, so the corner holds one close.
- **× on a list row or a tab** closes that one agent, and nothing else does.
  The window shows its neighbour (the next, or the previous at the end), and
  closing the last agent closes the window.
- **«Закрити всі»** closes every agent and the window, and the pill goes with
  them.
- In variants 1 and 2 a click on the dimmed area also closes the window (the
  prototypes do not draw it).

With the window closed and agents still open, the list is one labelled pill in
the board's header, right after the working count: «1 агент ⤢», «3 агенти ⤢»,
«5 агентів ⤢» (en «1 agent ⤢», «3 agents ⤢»). The search field gives up the
pill's width, so the pill covers no card and stands in the same place at 1440
and at 1000. A click, or Enter on it, brings the window back on the agent shown
last. The first revision floated the pill over the board's foot, where at
1000 px it was a bare «1» lying on a card and at 1440 it covered a card's
button.

The open agent's card shows nothing more than the chip's ring. The × and the
graph icon the critic saw on that card in frame `03` were the card's own hover
controls (`.tools .icon-btn.hide`, `kanbanBoard.css:1316-1323`), revealed
because the pointer rested on the card and focus had returned into it. With
focus going to the pill they stay hidden; the frames move the pointer off the
card, as a hand leaves the window.

### Keyboard

- Alt+J and Alt+K (by key position, the same chord as today) step to the next
  or previous agent, from inside a composer too. With the window closed, Alt+J
  opens it on the agent shown last.
- Esc closes the window in one press, whether focus is in the list or the
  reader. Inside a composer or an open menu, Esc keeps its own meaning, as the
  whole-window reader's Escape does today.
- A switch puts focus in the reader that was brought in. The list's rows are
  buttons in tab order before the reader. Closing the window puts focus on the
  pill.

### Phone

The phone is unchanged in every variant. It already opens an agent full screen
at once, its bar and dock swipe step between agents, and its title opens the
switcher, which is the phone's form of the open-agents list. Every variant's
review carries the same four phone frames.

One difference the operator should know about: the phone's swipe walks every
agent of the project, while the desktop window walks only the agents the
operator opened. In frame `p3` a swipe from the retry banner's Review lands on
an agent of another task. This design leaves the phone's order as it is (see
Deferred).

### The variants

All three are drawn on the real components. The conversation is the product's
reader (`KanbanReaders.tsx`) in the product's whole-window host
(`.reader-full`), and the switcher is the product's `OpenAgentsList` at full
contrast, with a role bar on the agent on screen and its × always visible in a
column of its own, so a name ends in an ellipsis before the ×. They differ in
where the list stands and how the window sits over the board.

1. **List at the window's left.** One modal window over a board dimmed to
   about half. At 1100 px and wider the window covers the board's pane below
   the header row with even 8 px margins, so the header, the sidebar and the
   seat are dimmed whole and no text row is sliced. Narrower, it covers the
   viewport. The list is its left column (248 px at 1440, 220 px at 1000) with
   ‹ › in its head, and the conversation fills the rest. A long list scrolls
   in its column. It is the list as it is today, moved into the window.
2. **Tabs across the window's top.** The same frame as variant 1, with the
   rows laid out as tabs above the conversation, ‹ › in the head and «Закрити
   всі» at the strip's end. The tab on screen is filled; the reader header
   drops the title the tab already shows and keeps its state, model and
   actions on one line. Past five agents at 1000 px the tabs scroll sideways.
4. **Window in the columns' place.** Nothing is dimmed. One frame wraps the
   list and the conversation, starting 12 px below the lowest thing above the
   columns (the header, the seat, the attention banner), with the columns not
   drawn behind it. The header, the sidebar and the orchestrator seat stay
   visible and usable beside it, and the board comes back when the window
   closes. A click on the header's column tabs would close the window and go to
   that column.

Variant 3 (the carousel with its neighbours dimmed at the sides) is dropped:
the neighbours were clipped by the viewport, board fragments showed between
the panes, and three composers rendered at once. It is kept under Deferred.
The surviving variants keep their numbers, so 4 is still 4.

### What happens to the inline-expansion code

The change is mostly removal:

- **The card stops hosting readers.** `stageReaders`, `openTiles` and their
  `ReaderSlot`s go from `KanbanCard.tsx` (`:412-413`, `:782-825`), and so do
  `readerKeysByCard` (`KanbanBoard.tsx:630-640`), the `.card.has-reader` rules
  (`kanbanBoard.css:1171`, `:1808-1812`), and the reader-driven «reading»
  column tracks (`readingStatuses` from readers, `kanbanColumnTracks`'s
  `reading`). Drafts and the new-task composer keep their tracks.
- **Opening stops revealing the card.** `openReaderFor` calls `revealCard`,
  whose layout effect scrolls the reader's slot into view
  (`KanbanBoard.tsx:1858-1898`). For an agent that opens in the window that
  scroll goes; in the prototypes it moved both cards 54 px until it was
  disabled. `jumpToAgent` stops revealing the card and widening its column
  (`widenIfNarrow`) for the same reason; both set the window's agent.
- **One window, many agents.** `fullReader` becomes the window's current agent.
  `.reader-full` renders the `OpenAgentsList` beside the `ReaderSlot`, which
  makes it the window. `openReaderFor` sets the window's agent for every
  conversation, so the loose reader stops being a special case.
- **The park lays readers out.** `ReaderPlacement`'s park (`.reader-park`,
  `KanbanBoard.tsx:2911`) stops being `hidden`: it sits off screen at the
  window reader's size with `visibility: hidden`, so a parked composer keeps
  its draft and toolbar layout and a parked feed keeps its scroll and content.
  The first open's hold-and-fade lives in the window.
- **The window's corner.** In the window the reader header's ⤡ and fold
  buttons are not rendered, and its × closes the window. Fold goes with it:
  `OpenReader.folded` is read and ignored.
- **The rail stops taking a strip.** The side tier of `OpenAgentsRail`,
  `openRailTier`, `OPEN_RAIL_WIDTH` and the rail's share of
  `kanbanLayoutModeBeside` go. The list's head becomes the header pill, one
  form at every width. The row's × moves out of its absolute position into its
  own column (`kanbanBoard.css:947-952`) and is always visible.
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
  case in place of a new file, including the per-frame transition trace
  (no skeleton, one toolbar layout).

## Recommendation

**Variant 1.** It is the operator's list, moved into the window where they
asked for it, as the same rows. It holds seven or more agents without
crowding, because the column scrolls, and it renders one conversation at a
time. Variant 4 is the alternative if the orchestrator seat should stay usable
while the window is open. Variant 2 gives the conversation the full width and
crowds past five agents.

## Validation against the requirement

- «на доске агентов ты раскрыть не можешь»: the cards' boxes stay unchanged
  (0 px) through every step in all three variants, at 1440 and 1000.
- «сразу открывает большое окошко … в нормальном виде»: one click shows the
  full reader in the window (frame `02-one-stage`), with no skeleton and no
  second toolbar layout.
- «много этих компоузеров … переключаться … карусель»: three agents, switched
  by row, by ‹ › and by Alt+J, wrapping round (frames `04`–`06`, the video),
  each switch showing the agent as it was last seen.
- «эта штучка … тоже должна быть там»: the list is inside the window, full
  contrast, every row a button with its × (all frames from `02`), and the
  header pill brings it back when the window is closed.
- «ты можешь раскрыть схему»: the Stages sheet is untouched.

## How the prototypes were made

The driver is a stage-scratch script that is not in the tree. It serves the
kanban fixture through `serveEvidenceFixture`, lays a variant's stylesheet over
the production one, and adds a thin shim: a click on a chip or a tile puts that
agent in the window through the reader's own whole-window toggle, in-card
reader slots and the park lay out off screen at the window reader's size, the
reveal's scroll to a reader slot is a no-op, the window's corner × closes the
window, and the columns keep the tracks they had with nothing open. A
per-frame trace records whether the window shows a skeleton and the toolbar's
layout on every open and switch. The board, reader, composer and list are the
product's components, with no product file edited. Each frame carries its
variant label in a 30 px strip above the screenshot, so the label hides no
content. Frames and videos are under
`~/Pictures/delegatus-review/agent-window/<variant>/`, and the readings are in
`evidence/agent-window/`. The frames are in the light theme only; the
specification names no dark theme.

## Built: Variant 1

The operator chose Variant 1, «Список ліворуч у вікні», on 2026-10-07 around
22:00 Kyiv, with no comment. What was built differs from the prototype text
above where the critique of the prototypes (lane 23485fd0, attempt 2) asked:

- **The header's pill has a slot of its own.** The slot keeps one width and
  height (104 × 32 px) whether or not anything is open, so the first open and
  the last close move nothing in the header, on one row or wrapped at 1000 px.
  The search field does not give up width. The pill has one form at every
  width: it names what it counts («2 агенти ⤢», «2 agents ⤢») and is as tall
  as the header's other buttons. The pill never reads «0»: it is
  drawn only with an agent open. While the window is open the pill stays in
  its slot under the dimmed header, pressed (`aria-expanded`).
- **A first open waits for the conversation.** The agent coming in reads in
  a slot of its own inside the window, laid out on screen and not drawn
  (`visibility: hidden`, so the pane's IntersectionObserver lets its feed
  load). A first open lays the whole window out the same way and draws it
  once the feed has rows (or its empty or error state) on two frames running,
  or after 1.2 s whatever it holds. A switch keeps the agent on screen until
  the next one is ready. There is no fade. The slots are keyed by agent, so
  the incoming slot becomes the shown one without moving the conversation.
- **Closing one agent never takes the window off the screen.** The agent
  closed leaves the list at once. A neighbour that has read (it waited laid
  out in the park) takes the reader in the same commit, so no frame shows the
  board. One that has not (never shown, or its saved tail gone) reads first,
  the way a switch does: the agent closed stays in the reader until then, so
  no frame shows a reader still loading either.
- **An agent's composer is the same whatever brought it in.** With the
  window open, the board's selected conversation is the one in the reader, on
  an open, a row, ‹ ›, Alt+J and a close alike and wherever focus stands, so
  the composer's selected-context line («👁 …») neither drops after a close
  nor pops back when focus enters the reader.
- **A link followed again opens its agent again.** The Viewer holds a
  conversation it opened as its focus for a moment afterwards; each request
  carries a count of its own, and the board opens the agent on every one.
- **‹ › only with two or more agents,** at the right end of the list's head at
  every width.
- **The margins hold no board text.** The board region under the window is a
  flat field in the canvas colour, and the scrim over the whole page dims it,
  the header and the sidebar the same.
- **The focus ring is the keyboard's.** The reader takes focus with
  `:focus-visible` only, and closing the window with the mouse leaves the pill
  focused without a ring.
- **Opening a stage from the Stages sheet, a `#c=` link, a handoff `open`, a
  launched draft and a conversation no card holds** all open the window. A
  handoff `show`, a pipeline link and anything else that goes to a card close
  it. A project switch leaves the window behind.
- **The phone names the other task.** The phone's swipe still walks every
  agent of the project. A swipe that lands on another task's agent shows
  «Інша задача: …» («Another task: …») in the bar's meta line for three
  seconds, the way the reconnecting line takes that place.

Rendered evidence: the kanban driver's «the agent window» block
(`evidence/agent-window/built.json`, `edges.json`) and the phone driver's
«agent window on the phone» case (`evidence/agent-window/phone.json`), with
frames and a frame-by-frame video per face under
`~/Pictures/delegatus-review/agent-window/variant-1-built/`.

## Deferred: not currently justified

- **Variant 3, the carousel with neighbours.** Dropped after review: its
  neighbour readers were clipped by the viewport (56 px slivers at 1000), board
  fragments showed between the panes, a side button sat on a board button,
  and three composers rendered at once. Variant 1 covers the same need.
- **A first-message panel for a not-started stage in the window.** It is a
  form with no agent yet, it does not cause the jump the operator reported,
  and the window would need a second kind of pane to host it.
- **Making the phone's swipe walk only the open agents.** The phone has no
  inline expansion to remove, and its swipe already walks the agents the
  operator works with; the difference from the desktop is named under Phone.
- **An «Opened from the board» section in the phone's switcher.** Same reason.
- **Reordering agents by dragging rows.** Nothing in the requirement asks for
  it, and the open order is stable.
- **Arrow-key switching.** Arrow keys already belong to the feed and the
  composer, and Alt+J/K covers switching without a conflict.
- **Dark-theme frames.** The specification does not ask for them; the
  variants use the product's theme tokens throughout.
