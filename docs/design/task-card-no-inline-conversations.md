# Task card without inline conversations; «Граф» opens the full-screen graph; wide stage columns

Status: UI brief, 2026-11-03. Grounded in `main` at `7da984802` (the lane's
base). Board task `73568213`, lane `4b62810d`. Claude designs and builds this
lane.

## The requirement

The operator, 2026-11-03 20:05:07Z, by voice in Russian in the seat
conversation. The message came with three screenshots of the work install:
(1) the card «Агенти не крутять sleep…» with a not-started Audit stage open
inside it («Audit · … чекає старту етапу», its first message and «Змінити»);
(2) a card of the #3613 successor lane with the large Fix → Verify → Refix
graph inside it; (3) the full-screen pipeline view «Новий урок у пам'яті
зупиняє запуск етапу» with three narrow conversation columns. Verbatim, from
the seat transcript:

> «Я давным-давно просил тебя сделать так, чтобы в карточках задач не было вот
> этой фигни, разворачиваемой разговора, который можно развернуть. Разговоров
> тут не должно быть, в самой карточке. Почему они остались? Я понимаю, что это
> темплейт, но зачем он нужен, вообще непонятно. То есть оно должно
> открываться как обычный разговор, пусть открывается обычная форма, обычного
> разговора, и там будет вот темплейт того, что будет отправлено. Но на полный
> экран, как вот у нас. Разговора открываются. Также вот этот укрупнённый граф
> я тоже думаю, есть смысл его выпалить, потому что, ну, он не укрупнённый, а
> более крупный граф, потому что он дублирует ничего особенного, не добавляет,
> только ещё, возможно, есть другое представление графа тоже где-то, вот я не
> могу открыть. А, нашёл. Нашёл. Вот, да. И тут все разговоры в одном месте. И
> тоже неудобно, что его разговоры очень тонкие, разговоры, то есть. Очень
> тонкая плашка. Я бы хотел, чтобы у них было более широкое, широкий экран,
> чтобы был горизонтальный скролл, и. Чтобы этот граф открывался по маленькой
> кнопочке. Потому что сейчас граф, он раскрывает кнопочка коротко, он она
> закрывает, он сворачивает, но если я раскрываю граф и нажимаю на агента, то
> тогда он уже открывает вот этот полный экран агента. Каким-то образом. А,
> нет, я должен на пайплайн. Короче, мне очень очевидно, как туда попасть.
> Давай, если там есть кнопочка граф, то она открывает вот этот укрупнённый
> граф, не в карточке задачи, а на весь экран. И вот эти изменения нужно
> сделать, чтобы, как я сказал,»

Two readings of the dictation, both from the sentence around them:
«выпалить» is «выпилить» (remove), and «мне очень очевидно, как туда
попасть» says that the way into the full-screen view was not obvious: the
operator first expected the graph's node to lead there and then found it
behind the lane's title («А, нет, я должен на пайплайн»). The message ends
mid-sentence. The seat asked for the rest at 20:06Z; up to this brief the
operator sent nothing more on this subject.

The seat pinned it as six acceptance criteria (desktop and the 390 px
phone): (1) no inline or expandable conversation and no pending-stage preview
in a card, and a click on a stage, started or not, opens the normal
full-screen conversation view, where an unstarted stage shows the message that
will be sent, still editable; (2) the enlarged node graph leaves the card and
the compact stage strip stays; (3) the existing small «Граф» control opens the
enlarged graph full-screen, and a node there opens that stage's conversation
full-screen; (4) in the full-screen pipeline view («Розгорнути всі») the
conversation columns are substantially wider, each readable like a normal
conversation pane, with horizontal scroll across them; (5) nothing else
changes, no new labels, badges or chrome, no card in a card; (6) rendered
evidence only through the existing kanban and phone drivers. Fence:
`src/components/pipelines/PipelineTemplatePicker.tsx` belongs to #3263 and is
not edited.

## Earlier requests, pinned as requirements

Searches run for this brief (project-scoped, then unscoped): «#2612
розгортання розмови в картці», «граф пайплайна картка задачі», «Розгорнути
всі», «горизонтальный скролл разговоры узкие колонки», «укрупнённый граф
карточке задачи», «схему более крупно показать агентов раскрыть не можешь»,
«пайплайн на весь экран все разговоры этапов рядом колонки», and an English
query on the waiting stage's first-message panel; memory searches on phone
parity, the sheet's pane width and «no new UI». The hits that bear on this
work, with what each still pins:

| # | Date and source | What was asked or decided | What it pins now |
|---|---|---|---|
| R1 | 2026-10-07 11:55Z, the operator by voice (quoted in `docs/design/agent-window.md`); variant 1 chosen at 18:54Z; built as #2612, merged 2026-10-09 | «сделать так, что вот теперь на досках невозможно раскрыть будет вот так компоузер … Оно сразу открывает большое окошко, но в большом окошке мы можем иметь много этих компоузеров, и … между ними переключаться … на доске … агентов ты раскрыть не можешь, ты можешь раскрыть схему … более крупно показать, но именно агентов ты раскрыть не можешь … когда кликаешь, … сразу раскрывается нормальном виде в этом окошке» | An agent never opens inside its card; a click opens the agent window and the card keeps its geometry; the pipeline graph can still be enlarged. #2612 left one thing in the card on purpose: its Deferred list holds «A first-message panel for a not-started stage in the window … the window would need a second kind of pane to host it». That panel is the one in screenshot 1. This brief builds that deferred item. |
| R2 | 2026-11-03 20:05Z, the operator (above) | No conversation or template in the card; the template opens in the normal full-screen conversation; the card's big graph goes; «Граф» opens the graph full-screen; wide columns with horizontal scroll | The whole of this brief. It is the latest word and governs where it meets R3, R4 and R7. |
| R3 | 2026-09-27, the operator's request as pinned for #2277 (`docs/design/pipeline-graph-loops.md`), merged 2026-09-28 | «the pipeline graph reads at a glance, both the wide graph view and the compact graph on a kanban card / phone» | The wide graph (in the full-screen view) keeps the #2277 layout and node states untouched. Its card half is superseded by R2: the card keeps the compact stage strip only. |
| R4 | 2026-09-15, #1702 (K5a) | «Each card starts on the compact pipeline summary (binding correction 4), with a remembered toggle to the stage graph» | The compact summary stays the card's only form. The toggle stops toggling and opens the full-screen view instead (R2). |
| R5 | 2026-09-15, #1703 (K5b) | The Stages sheet; «A waiting stage opens from its node as the conversation it will become. Its first message is marked not delivered and edited in place», with Save, Use theirs / Keep mine, the 409 for a stage that already started, and the panel turning into the stage's reader once it starts | Every draft behaviour stays exactly as it is, including its words and states. Only where it is shown changes: the agent window instead of the card. |
| R6 | 2026-09-25, #2148 round 2 (`docs/design/interface-polish-critique.md` §2; a critic's brief, not the operator's) | In the sheet each stage is drawn once: while the graph is shown it is the navigation, a node reaches its pane, and the chip strip is the graph's collapsed form | Kept: a node and a chip still bring their pane into view. Acceptance 3 adds that they also open the stage in the agent window (Design §4). |
| R7 | 2026-10-27 00:27Z, the operator chose variant 3 «Меню картки → чернетка на картці» for «start a pipeline from a conversation» (`docs/design/start-pipeline-from-conversation/implementation.md`); shipped the same day (`459d2d7ea`) | The task menu creates a draft lane on that card: dashed Builder/Reviewer pills, Start in the lane's tail, and the Builder's open first-message panel with Edit | The draft lane, its pills, its Start and its notes stay on the card. The Builder's first-message panel is the same in-card panel R2 removes; R2 is later and names this exact thing («я понимаю, что это темплейт»), so it opens in the agent window like every other not-started stage (Design §7). |
| R8 | 2026-10-05, the operator (seat memory «no new UI when an existing control fits», after PR #2511); project rule against a card inside a card | A capability goes into the control already used for it; no new buttons, popovers or explanatory paragraphs; no bordered card nested in another | «Граф» is the existing control; the agent window, its list, its rows and the stage menu are reused; the draft in the window draws no bordered box of its own. |

Nothing else relevant turned up: an Oct 27 hit on «граф які агенти працювали»
is a team member's comment on the Gantt timeline prototype, not on cards.

## What renders each item today

Line numbers are at `7da984802`.

| Acceptance | What the operator sees | Rendered by |
|---|---|---|
| 1 | A not-started stage's first message inside the card (screenshot 1) | `StageDraftPanel` (`src/components/kanban/StageDraft.tsx:304-388`), mounted in the card's `.readers` block (`src/components/kanban/KanbanCard.tsx:940-967`) for each entry of `stagePanels`. The board opens a panel in `openStage` (`src/components/kanban/KanbanBoard.tsx:2147-2160`) whenever the clicked stage has no attempt, and reveals and focuses the card; it folds, closes and opens the stage menu through `foldStagePanel` / `closeStagePanel` / `openStagePanelMenu` (`:2185-2199`), promotes a started stage's panel to its reader (`:2209-2237`), opens the card for a panel (`formCards`, `:2249-2256`) and marks the pill selected (`selectedStages`, `KanbanCard.tsx:119-127`). A panel also sets the card's `has-reader` class (`KanbanCard.tsx:483`), which swaps the card's task note to its full form. A draft lane made from a conversation opens its Builder here (`openConversationDraft`, `KanbanBoard.tsx:2171-2183`). |
| 1 | A started stage's conversation | Already the agent window (#2612): `AgentWindow` (`src/components/kanban/AgentWindow.tsx`), its list from `openAgents` (`src/components/kanban/openAgents.ts`) over `ReaderMemory`, its reader a `ReaderSlot` (`KanbanBoard.tsx:3268-3281`). No change needed for started stages. |
| 2 | The Fix → Verify → Refix graph inside the card (screenshot 2) | `PipelineBlock` task density (`src/components/pipelines/PipelineBlock.tsx`): with `graphOpen` it draws `GraphSlot` (`:499-521`, a `PipelineGraph` measured to the row) in place of the chain (`:778-783`). `graphOpen` comes from the board's in-memory `graphChoices` (`KanbanBoard.tsx:443-447`) through `KanbanCard.tsx:554-557`. |
| 3 | The small «Граф» control | The lane row's `pb-graph-toggle` button (`PipelineBlock.tsx:731-743`): `aria-pressed`, the graph glyph, or the list glyph while the graph is open; today it only toggles the in-card graph. The full-screen view opens from the lane title (`pb-open`, `onOpenStages`, `:712-726`) and the lane menu's «Розгорнути етапи»; both call `openSheet` (`KanbanBoard.tsx:2258-2264`). |
| 3 | The enlarged graph full-screen | `StagesSheet` (`src/components/kanban/StagesSheet.tsx`): the graph is shown by default from 700 px (`:93`), toggled by the sheet's own «Граф» button (`:229-232`) and drawn with `navigate`, so a node only reaches its pane (`:280-297`). |
| 4 | Narrow conversation columns (screenshot 3) | The sheet's lane of `StagePane`s (`StagesSheet.tsx:301-334`, `:348-535`); a pane's width is `--pane-w: clamp(340px, 30vw, 440px)` (`src/components/kanban/kanbanBoard.css:1752`) inside a sheet capped at `min(1480px, 100%)` (`:1717`). By that rule a pane is 432 px at 1440 px, so three stages fit side by side and the lane does not scroll. A normal conversation sets the agent's prose at no less than 68ch (`READING_MEASURE`, `src/components/feed/measure.ts`); a 432 px pane leaves roughly 400 px for it, near 55 characters of the 13 px body font. That figure is an estimate from the CSS; the driver measures it. |

The 390 px phone is a different shell (`useIsMobile`, either axis under
640 × 600). Its card (`MobileKanban.tsx` `CardView`) holds the chain only and
no reader, panel or graph; a started stage opens `MobileFocusView` full
screen. A not-started stage's pill on the board's card is not a target of its
own (the tap opens the task); on the task screen it opens the pipeline screen,
whose ⚙ sheet (`StagePlaceholderPane`) edits the first message and previews
the full text that will be sent. The phone never mounts `StagesSheet`,
`GraphSlot` or `StageDraftPanel`.

## Design

### 1. The card holds no conversation and no draft panel

`KanbanCard` stops rendering `.readers` and `StageDraftPanel`, and stops
taking `stagePanels`, `onStagePanelFold`, `onStagePanelClose` and
`onStagePanelMenu`. `reading` counts agent drafts only, so opening a stage no
longer switches the card's task note to its full form: the card keeps its
geometry, as #2612 measured for started stages (0 px change of every card box).
A stage whose first message is open in the window keeps its pill marked as
open, the same ring a stage open as a conversation gets: `selectedStages` takes
the board's open draft keys in place of the parsed panels.

The board no longer opens the card or scrolls to it for a draft (`formCards`
counts agent drafts only; `openStage` calls no `revealCard`).

### 2. A not-started stage opens in the agent window

A click on a stage with no attempt, while its pipeline is still going
(`stageDraftable`), opens the agent window on that stage's first message,
exactly as a click on a started stage opens its conversation.

- **The window holds it as one more agent.** The board keeps its open drafts
  where `stagePanels` keeps them today (in memory only, as today, so a reload
  does not bring them back). The window's list is the open conversations
  followed by the open drafts, each in the order opened, so ‹ ›, Alt+J /
  Alt+K, a row's ×, «Закрити всі» and the header pill all take them. A draft
  key carries a prefix no conversation identity can have, so it never collides
  with a reader key.
- **Its row reuses what the list already draws:** the stage's role emblem, the
  stage's name with the card's title, a neutral dot that is not live, and the
  state words the panel already uses (`kanban.draft.state` «чекає старту
  етапу», `stateStarted`, `stateEnded`). `OpenAgent` gains an optional state
  word to carry them; no new string is added.
- **Its reader is the panel's own content.** The window's reader column
  renders the existing `StageDraftPanel` head and `StageDraftFeed` (the line
  saying when it starts, the first message as the operator's bubble marked
  «Перше повідомлення · ще не надіслано», «Змінити», the editor with its Save,
  Cancel, conflict, unconfirmed and failed states, and the folded «Додається
  на старті: …» line with the full text the controller will send). In the
  window its fold button is not drawn and its × closes the window, as for a
  conversation reader; its ⋯ keeps «Змінити перше повідомлення», the account
  choice, Retry and Skip, and «Показати в етапах», which now leaves the window
  and brings the full-screen view to that stage. It fills the reader's height
  and scrolls inside; no border, radius or shadow of its own inside the
  window's frame (the dashed `.stage-detail.conv.draft` rule at
  `kanbanBoard.css:1815` loses its only user and goes).
- **It comes in at once.** A draft has no feed to read, so the window shows it
  in the commit it is opened, with no held first frame; focus goes to the
  draft's region, and to the editor when editing starts, as today.
- **When the stage starts**, the existing promotion (`KanbanBoard.tsx:2209`)
  replaces the draft with the attempt's conversation in the window's list; if
  the draft was on screen, the conversation comes on screen through the
  window's normal incoming path. A draft its stage did not take
  (`undelivered`, `ended-before-start`) stays in the window showing the
  existing `DraftLeftover`, until the operator lets it go.
- **No second editor of the same draft.** While the window shows a stage's
  draft, that stage's pane in the full-screen view shows the existing
  «in the full pane» note with «Показати тут» (`kanban.stages.inFullPane`,
  `showHere`), as a pane whose conversation is in the window already does.
- **The selected context** of the composer stays where it was: a draft is no
  conversation.

A stage with no attempt on a pipeline that already ended is not draftable; it
stays as it is today (not openable from the card; its pane in the full-screen
view shows the message it never sent).

### 3. The card's graph goes; «Граф» opens the full-screen view with its graph

- `PipelineBlock` loses `GraphSlot`, the `graphOpen` branch and the
  `graphOpen` / `onToggleGraph` props; the board loses `graphChoices` and
  `toggleGraph`. The card always draws the compact chain
  (`ChainPills` / `chainHead`), so the lane row's layout no longer depends on
  a graph choice (`chainHead = !showTitle && !props.onMenu`).
- The same `pb-graph-toggle` button stays where it is, with the graph glyph,
  `title` «Граф» and `aria-label` «Показати граф етапів» (existing
  `kanban.graph.graph`, `kanban.graph.showGraph`). It is no longer a toggle:
  no `aria-pressed`, no list glyph. It calls a new `onOpenGraph(pipeline)`,
  which the card wires to `openSheet(card, pipeline, { graph: true })`.
- `StagesSheet` takes an `initialGraph` flag; the board passes it from the
  sheet target. Opened from «Граф» the sheet starts with its graph shown at any
  desktop width (today it starts hidden from 640 to 699 px); opened from the
  title or the menu it keeps today's default. The sheet's own «Граф» toggle,
  zoom, «Згорнути завершені», «Розгорнути всі», ‹ › and the chip strip are
  unchanged.
- The keys left unused go from `en.ts` and `uk.ts`:
  `kanban.graph.showSummary`, `kanban.graph.summary`, and the panel's
  `kanban.draft.panelAriaFolded`, `expandPanel`, `collapsePanel`,
  `foldedLine` if nothing else reads them (check with `rg` first). `ListGlyph`
  goes if no other caller remains.

### 4. A node in the full-screen graph opens its stage full-screen

A click on a node in the sheet's graph (or on a chip of the strip, its
collapsed form) does two things, in this order: it brings that stage's pane
into view as it does today (#2148), and, when the stage has a conversation or
a draftable first message, it opens the stage in the agent window through the
board's `openStage`, with the sheet's card. The window stands over the sheet
(its layer is above the sheet's), so closing it (×, Escape, the scrim) returns
the operator to the full-screen view standing on the stage they clicked. A
node whose stage has nothing to open only reaches its pane, as today. The
node's accessible name says which of the two it does (the existing
`kanban.graph.openConversation` / `openDraft`, else
`kanban.stages.showPane`).

### 5. Wide columns with horizontal scroll

Inside the sheet, from 700 px wide, a pane takes the width of a normal
conversation column instead of a third of the screen:

```css
.kb .gsheet .lane .pane { --pane-w: clamp(600px, 44vw, 700px); }
```

At 1440 px a pane is 634 px and at 1920 px it is 700 px: two whole columns
stand side by side and the rest are reached by scrolling the lane sideways,
which it already does (`overflow-x: auto`, snap to a pane's start,
`scrollbar-width: thin`). At 1000 px a pane is 600 px. A folded pane stays a
56 px strip; the rule under 700 px (`calc(100vw - 56px)`) is unchanged. The
numbers are a starting point; the acceptance is the measurement: at every
desktop width an unfolded pane holds the agent's prose at no less than 68ch,
the conversation's own floor, and with three or more unfolded stages the lane
scrolls horizontally. The sheet keeps its 1480 px cap, its header and its
graph band.

### 6. The phone

At 390 px nothing changes, and the evidence shows it. The phone's card has
never had an inline conversation, a draft panel or a graph (#2612 recorded
the same: «The phone has no inline expansion to remove»); a started stage
already opens full screen in `MobileFocusView`; a not-started stage leads to
the pipeline screen (from the task screen), whose ⚙ sheet shows and edits the
first message and previews the full text that will be sent. A conversation-shaped phone screen for a
not-started stage would be a new phone screen kind with its own navigation
entry; it is under Deferred.

### 7. A pipeline started from a conversation (variant 3)

The task menu still creates the draft lane on its card, with its dashed pills,
Start in the lane's tail and its notes, and the board still opens the card for
it. Its Builder's first message now opens in the agent window (Design §2)
instead of the card's panel. Start, the account picker, append-stage and the
configure toggle in the sheet's pane work as they do.

### Decisions taken here, and how to reverse each

- **Node and chip in the sheet: reach the pane, then open the window**
  (acceptance 3 with R6). If the operator wants the sheet's graph to stay pure
  navigation, drop the `openStage` call from the sheet's node handler; nothing
  else depends on it.
- **The draft lane from a conversation shows its first message in the window**
  (R2 over R7). Reversing it would bring back an in-card panel for that one
  lane kind; R2 asks for none.
- **Phone unchanged** (§6). The phone screen is the deferred item below.

## States to render

Through the existing drivers only (acceptance 6), in en and uk, light and
dark, in isolated state (private HOME, TMPDIR, `LLV_STATE_DIR`, the control
URL on a closed port, a short Chrome TMPDIR), each driver through
`scripts/gate-slot.sh`:

- **Desktop**, `src/components/kanban/kanbanBoard.browser.test.tsx` over
  `issue1695Evidence.fixture.tsx?scenario=stages`, gated by
  `LLV_KANBAN_BROWSER_TEST=1` and `CHROME_BIN`, one new `describe` block for
  this change, at 1920 × 1080, 1440 × 900, 1000 × 800 and 820 × 1000 (the
  width between the desktop and the phone). Scrollbars on: launch without
  `--hide-scrollbars` and check the lane's gutter.
- **Phone**, `src/components/mobile/issue1671Evidence.browser.test.tsx`
  (`LLV_SWIPE_BROWSER_TEST=1`), the same fixture at 390 × 844 with a touch
  screen.

Readings go to `evidence/task-card-no-inline-conversations/*.json`; frames stay
outside the tree.

| Surface | State | Defining element, checked as visible text on the first screen |
|---|---|---|
| Card | a lane with a started (passed) stage, a running stage and a not-started next stage | the chain's pills; no `[data-stage-detail]`, `.readers`, `[data-graph]` or `.pgraph-box` anywhere in any card |
| Card | a parked lane (the simple chain parked on a decision) and a completed lane | the same; the lane's reason line and merge word unchanged |
| Card | after clicking a passed pill, a running pill and a not-started pill, and after «Граф» | every card box changes by 0 px; the clicked pill is marked open |
| Agent window | a passed stage, a running stage | the stage's conversation, as today |
| Agent window | a not-started stage | «чекає старту етапу» in the head, the first message bubble with «Змінити», «Перше повідомлення · ще не надіслано», the «Додається на старті» line; then the editor open, then «Перевіряємо етап, потім зберігаємо…», then saved («змінено о …») |
| Agent window | the draft's stage starts while it is on screen | the conversation replaces the draft in the same list position |
| Agent window | a draft its stage did not take | the not-delivered notice with the kept words |
| Agent window | two drafts and two conversations open | the list in open order, ‹ › walks all four, a row's × and «Закрити всі» |
| Full-screen view | opened from «Граф» on a running lane, a parked lane and a completed lane | the graph band and the panes; at 820 the graph is shown |
| Full-screen view | a node clicked | the window over the sheet on that stage; after closing it, the sheet with that pane in view |
| Full-screen view | «Розгорнути всі» with every pane unfolded | panes ≥ 600 px; agent prose ≥ 68ch per line; lane `scrollWidth > clientWidth`; the operator's bubble at its own measure; a not-started pane's draft at the same width |
| Phone 390 | the board's card, the task screen, a started stage opened, a not-started stage tapped | unchanged from main: no conversation, panel or graph on the card; `MobileFocusView` for the started stage; the pipeline screen for the not-started one |

Every frame is opened and looked at; text ranges are measured against the
window and each clipping ancestor (no cut row, no control over foreign text);
targets keep 24 px on desktop and 44 px on the phone; the window stays modal
for Tab with a draft on screen; Escape in the draft's editor cancels the edit
and does not close the window.

## What must not be touched

- `src/components/pipelines/PipelineTemplatePicker.tsx` (#3263 fence).
- The draft's behaviour and words: `StageDraftFeed`, `StageDraftMessage`,
  `AddedAtStart`, `DraftLeftover`, `stageDrafts.ts` (save, digest check,
  conflict, unconfirmed, 409 handling). They move, they do not change.
- The engine, the pipeline routes and every server path: no API change.
- `ReaderMemory`'s stored shape (`llv:kanban-readers:v1:`): drafts are not
  written into it.
- The agent window's frame, geometry (`agentWindowGeometry.ts`), list styling
  and the conversation reader; the orchestrator seat.
- `PipelineGraph` layout and node rendering (`pipelineGraph.ts`,
  `PipelineSection.tsx`), apart from the sheet's click handler.
- The sheet's header controls, zoom, chip strip, panes' content
  (`StagePane`), and its rules under 700 px.
- Agent drafts on a card (`CardDrafts`, «+ Агент»), conversation tiles, Past
  attempts, the timeline, the draft lane's Start and notes.
- Every phone component (`MobileKanban`, `MobileTaskScreen`,
  `MobilePipelineScreen`, `MobileFocusView`, `StagePlaceholderPane`) and
  `PipelineBlock`'s `card` and `screen` densities.

## Tests that move, and tests to add

Behaviour tests move with the behaviour; none asserts copy.

- `src/components/kanban/KanbanStages.dom.test.tsx`: the panel cases
  (`[data-stage-detail]` in the card: open, fold, menu, Save, conflict,
  started-during-save, promotion) run against the window, plus: a card holds no
  panel; a draft row's × and «Закрити всі»; the sheet pane shows the
  «in the full pane» note while the window shows its draft.
- `src/components/kanban/KanbanOpenAgents.dom.test.tsx`: drafts in the list
  order, stepping and closing.
- `src/components/kanban/KanbanPipelines.dom.test.tsx`,
  `src/components/pipelines/PipelineBlock.dom.test.tsx` (the toggle cases):
  «Граф» opens the sheet with its graph and has no pressed state; the row never
  draws a graph.
- Driver blocks that open the in-card graph read the graph in the full-screen
  view instead, keeping their assertions: «where a stage ran»
  (`kanbanBoard.browser.test.tsx` ~`:973`), «#1695 K5a» (~`:5455-5609`),
  «#1695 K5b» stage-details frames (~`:5923-6237`), «the agent window» folded
  panel case (~`:13165`), «readable pipeline graph» (~`:18680`), «model glyphs»
  (~`:19326`), «start a pipeline from a conversation» (~`:42037`), and
  `modelGlyphMotion.fixture.tsx` (`OPEN_PRESSES` presses the card toggle).
  `conversationWindowEvidence.fixture.tsx` mounts `StagesSheet` and takes the
  new props.
- New in the driver: the block above. New in the DOM tests: a sheet node opens
  the window and reaches its pane; a not-started node opens the window on the
  draft. Shown red on main first (the card shows a panel; the toggle is pressed;
  the pane's prose is under 68ch at 1440).

## Checks

Touched test files by path through `scripts/gate-slot.sh bun test <file>` with
isolated HOME, XDG_CONFIG_HOME, TMPDIR and `LLV_STATE_DIR` and the control URL
on a closed port; the two drivers as above. Required before publication:
typecheck, privacy-publication, privacy-tracker-audit, runtime-gate and the
pre-push hook. No full suite, build or `tsc` outside what the hook runs.

## Open changes on the same files

Read on 2026-11-03 against the 20 open pull requests: #3263 and #3612 both add
to `issue1695Evidence.fixture.tsx` and `kanbanBoard.browser.test.tsx`; #3263
also edits the fenced `PipelineTemplatePicker`. Add the new block and fixture
cases at the end of their files and merge `origin/main` before publication.
#3396 (start-from-conversation prototype redo) touches only its docs and the
conversation-window driver. No open change touches `KanbanCard.tsx`,
`KanbanBoard.tsx`, `StagesSheet.tsx`, `StageDraft.tsx`, `AgentWindow.tsx`,
`PipelineBlock.tsx` or `kanbanBoard.css`.

## Deferred — not currently justified

- **A phone screen for a not-started stage shaped like its conversation.** The
  phone has no in-card conversation to remove, and its ⚙ sheet already shows
  and edits the message and the text that will be sent; a new screen kind
  needs its own navigation entry and an operator's variant choice.
- **A graph-only full-screen surface.** The full-screen view already is the
  enlarged graph with the conversations under it (R1, R2); a second one is new
  chrome.
- **Lifting the sheet's 1480 px cap or letting the operator drag a column's
  width.** Wider panes and the scroll meet acceptance 4 without it.
- **Keeping open drafts across a reload.** The in-card panels never were.
- **Moving agent drafts («+ Агент») out of the card.** They are a launch form,
  not a conversation, and the operator did not name them.
- **Role and runtime configuration inside the window's draft.** It stays in
  the sheet's pane, as today.

## Validation against the requirement

- «в карточках задач не было … разворачиваемой разговора» → §1: no reader and
  no draft panel in any card; the evidence checks every card at every width.
- «пусть открывается обычная форма обычного разговора, и там будет вот
  темплейт … на полный экран» → §2: a not-started stage opens in the agent
  window, the same window as a conversation, with its first message editable
  and the full text it will send.
- «укрупнённый граф … выпилить» → §3: no graph in the card; the chain stays.
- «если там есть кнопочка граф, то она открывает вот этот укрупнённый граф …
  на весь экран» → §3–§4: «Граф» opens the full-screen view with its graph; a
  node opens its stage full-screen.
- «разговоры очень тонкие … более широкий экран … горизонтальный скролл» → §5.
- No new label, badge or control (R8): every control and word used exists
  today; the one prop added carries an existing state word.
