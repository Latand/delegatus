# Creating a new agent: the composer, and the conversation after Send

**Variant 1 was built** (the operator, 2026-10-06, on the reworked frames: «там
где вариант, где только строка компоузера, мне нравится»). «+ Agent» opens it
for every user; the old form, variant 2, the variant switch and the prototype
files are removed. Sections 1 to 9 are the design record as it was written and
still name the prototype's files, line numbers and `?newagent=<n>`; section 10
says what the built form is and where it departs from them.

## Operator verdict 2026-10-06

On looks 1, 2 and 3 of this lane, all three rejected. His words, verbatim
(Russian, voice transcript):

> Хуйня этот дизайн… там все 3 варианта, компоузеры вышли хуёвые. Нет, это
> должно быть минимально… мне даже кажется, что это может быть вот как сейчас
> у нас… нижняя часть компоузера наша сейчас, вот как она сейчас выглядит, её
> нужно без всяких промпт роли, роли там вообще не нужно добавлять. Это должно
> быть максимально быстро создаваться агент, то есть сразу мне должен быть
> инпут, минимальный, то есть я должен голосом там мочь это всё закинуть,
> выбрать модельку аккаунта, как вот у нас сейчас в компоузере это происходит,
> и оно типа поехало. Сразу запускается. Сразу у меня рендерится экран… в
> который подгружается уже разговор, как у нас это обычно делается. Типа того,
> как у нас оркестратор загружается.

On the two points the first brief left open, roles and the working directory,
he answered the same day in the seat chat. His words, verbatim (Russian):

> Да, я думаю, что роли нужны только оркестратору, поэтому они действительно
> не нужны нам здесь. Рабочая папка я тоже не вижу смысла её брать, пусть
> берётся это под этот проект, её не нужно показывать.

What follows from it, and what this note now describes:

1. Creating an agent is the composer. The form is the lower part of today's
   conversation composer as the product draws it, and nothing else.
2. «+ Agent» puts the cursor in the field. The prompt can be dictated. The
   model and the account are chosen the way the composer chooses them today.
   Send launches at once.
3. After Send the pane is the conversation: the first message as a normal row,
   the loading shape a conversation has while it opens, then the transcript.
4. At most two numbered variants, beside today's form (0).
5. Roles belong to the orchestrator only. The form has no role control of any
   kind, and no other place in the UI is owed to them.
6. The working directory is never shown and never asked. It is the directory
   of the project the form was opened in.

The earlier three looks and their frames are kept for the record only (section
9).

## 1. The form

One component, the product's `ComposerBar`
(`src/components/ComposerBar.tsx`), with the same parts it has under the
orchestrator's conversation:

| Part | What it is | Where it comes from |
| --- | --- | --- |
| The field | the composer's own textarea; Enter sends, Shift+Enter breaks the line | `src/components/ComposerBar.tsx:682` |
| The microphone | the composer's dictation; while it records, the send button reads «stop and launch» and sends what was said | `src/components/ComposerBar.tsx:519` |
| Send | the composer's send button, in the accent colour a conversation uses | `src/components/ComposerBar.tsx:428` |
| Attachments | the composer's picker in the row under the field, with its thumbnails | `src/components/ComposerBar.tsx:522` |
| Model, reasoning, speed, account | the runtime pill a conversation's composer carries, with its own popover on the desktop and its own «Next message» sheet on the phone | `RuntimePopover` and `RuntimeSheet`, `src/components/RuntimePill.tsx` |

The form holds no select, no radio group, no text input, no folded section and
no heading. The driver counts them in every frame of variants 1 and 2 and
finds none.

**The engine is chosen with the model.** A conversation's pill never offers an
engine, because a conversation has one. A draft has to pick it, so the pill's
model list names every engine's models («Claude · Opus 5.5», «Codex ·
GPT-6-Astra», «Copilot · Auto») and choosing a model of another engine moves
the draft to that engine. The pill's face says the engine, the model, the
reasoning tier once one is chosen, and the account once one is picked:
«Claude · Fable · High → Account C», the same arrow the conversation's pill
shows for a picked account.

**No tier chosen** means the engine's own default, as today. The face then
says the engine and the model only. The conversation's pill always shows a
tier because a running conversation has one.

**Closing an unsent draft.** The composer has no close button and the form
adds none. Escape in the empty field puts the draft away, as it does for a new
task; the «agents open» rail keeps its «Close all»; the phone keeps its back
button.

**Errors** are the composer's own lines under the field: a refused launch
with the prompt kept in the field, a signed-out account with its sign-in
button, an attachment that cannot be sent.

## 2. Two variants

Both are the form of section 1 and behave the same after Send. They differ in
one thing: how much room the draft takes before the first message is sent.

**Variant 1. Only the composer; the conversation opens on Send.** The draft is
as tall as the composer, about 90 px: a field and the row under it. Opened
from the board's «+ Agent» it is a short card at the top of its column; opened
from a task card's «+ Agent» it is one more row inside that card. On Send the
card grows to the height the board gives a conversation, and the composer
stays in sight with the first message directly above it.

**Variant 2. The conversation's pane from the first frame.** The draft takes
the height the board gives a conversation from the moment it opens, empty
above, with the composer at its foot, the way an empty conversation looks. On
Send nothing moves: the first message and the loading shape appear above the
composer, in a pane that keeps its place and its size (the driver compares the
pane's box before and after Send at 1440 and 1000 px).

On the phone the two are the same screen: the phone's pane is the whole
window either way, with the composer on its bottom edge.

| | Variant 1 | Variant 2 |
| --- | --- | --- |
| Before Send, in a column | about 90 px | the conversation's height (about 620 px at 1440x900, 588 px at 1000x700) |
| Before Send, in a task card | one row in the card | the card grows by the conversation's height at once |
| On Send | the card grows downward; the board below it moves | nothing moves |
| Several drafts open | they stack as short rows | each takes a conversation's height |
| The phone | the same as variant 2 | the same as variant 1 |

## 3. After Send

Today the draft freezes: the prompt becomes a bubble, a sentence says «agent
launched — waiting for the conversation to appear here…», and the form's
strips stay above it until the conversation replaces the pane.

In both variants the pane is the conversation from the press:

- the first message is the feed's own row (`FeedMessageRow`,
  `src/components/conversation/OutboxBubbles.tsx:376`), the component a
  conversation draws the operator's messages with;
- under it stands the feed's loading shape (`FeedSkeleton`,
  `src/components/skeletons.tsx:288`), the one the orchestrator's conversation
  shows while it opens. Only its last block is drawn, the lines where the
  agent's first words will be: the blocks above it stand for earlier history,
  and a new conversation has none;
- the composer stays under them, locked until the launch answers;
- no sentence about the launch is shown. The product's own status line
  appears only when the launch needs the operator (a launch that could not be
  confirmed, or one that failed).

When the launch answers, the product hands the pane over to the real
conversation, as it does today, and the transcript fills in. That hand-over is
untouched product behaviour, and it has one seam worth knowing: the product's
conversation card adds a title row and a runtime row above the feed and draws
the first message at the top of an otherwise empty feed, with the chips
«Starting» and «First message: queued» under it. The first message therefore
moves from the foot of the pane to its top at that moment, in variant 1, in
variant 2 and today alike. Removing that move is a change to the conversation
window and belongs to its own lane.

## 4. What the old form had that this one drops

| The old form had | In this form | Where it stays reachable |
| --- | --- | --- |
| Engine radios (Claude, Codex, Copilot) | dropped as a control | The engine is chosen with the model, in the pill's model list. |
| Model, effort and speed selects | dropped as selects | The pill: reasoning tiers, «Model», «Speed» (Codex). |
| Account select | dropped as a select | The pill: «Account», listing the engine's signed-in accounts. |
| Working directory field, its picker and its list of recent directories | dropped | Working directory: the project's, never shown and never asked, by the operator's decision (section 5). |
| Role select | dropped | Roles: orchestrator only, by the operator's decision. |
| Role parameters (mode, domain, size and the like) | dropped | Roles: orchestrator only, by the operator's decision. |
| Role prompt preview | dropped | Roles: orchestrator only, by the operator's decision. |
| Reviewer's conversation («reviews») | dropped | Gone from the UI. A review of a conversation is started as a review flow or a pipeline's review stage, through an orchestrator. |
| Deployer's confirmation field | dropped | Gone from the UI. A deploy is a Deployer stage of a pipeline, with the operator's approval there. |
| Handoff source in the heading, and its path as a line | dropped as rows | A handoff still opens this form from the conversation it continues. The field arrives filled with the product's own sentence naming the source transcript, which is what the new agent reads. |
| Task the draft belongs to | kept | The card the form sits in; the launch lands on that card. |
| Cancel button | dropped | Escape in the empty field, the «agents open» rail's «Close all», the phone's back button. |
| «new agent» chip under the field, the hint in the blank area, the engine badge, the status dot, the 4 px engine bar, the draft card's own title and foot | dropped | Nowhere; each repeated what the placeholder and the pill say. |
| The engine's colour on the send button | dropped | Send is the accent colour, as in a conversation. |
| Launch-in-flight sentence | dropped while all is well | Shown only when the launch needs the operator. |
| Image capability alert with Retry | kept | Above the field, only when the server could not say whether the engine takes images. |
| Prompt, images, voice, launch, the composer's errors | kept | The composer. |

## 5. Values the launch still needs

| Value | What the form uses | Rule |
| --- | --- | --- |
| Project | the project whose board «+ Agent» was pressed on | unchanged |
| Working directory | the project's canonical root | `initialDraftCwd`, `src/components/ProjectDashboard.tsx:651`; the board seeds it into the draft at `:1387` and `:1405` |
| Working directory of a handoff | the source conversation's own directory | `src/components/ProjectDashboard.tsx:1435`, confirmed by `GET /api/spawn` |
| Task | the card whose «+ Agent» was pressed; none from the board's own button | `setDraftBand`, `src/components/ProjectDashboard.tsx:1404` |
| Engine and model | Claude with its default model; a handoff starts on its source's engine | `useAgentLaunchDraft`, `src/components/draft/AgentLaunchControls.tsx:220` |
| Effort, speed | the engine's defaults | unchanged |
| Account | the engine's active account | `resolveLaunchAccountId`, `src/components/draft/AgentLaunchControls.tsx:104` |
| Role | none | a launch from this form carries no role |

One entry point has no directory to derive today. While a project's root is
unresolved (the board has not yet matched the project to a folder on disk),
`resolvedDraftCwd` is empty and the draft is seeded with `/`
(`src/components/ProjectDashboard.tsx:651`); the board replaces that seed once
the root resolves (`resolveSystemDraftCwd`, `:671`). Today the operator sees
`/` in the folder field and can correct it. In this form he would launch in
`/` unseen, so a shipped version has to hold Send, with the composer's own
blocked-send line, until the project's root is known. The prototype does not
do this; the fixture's project always has a root.

The driver reads the launch request of every walk: one request per Send, the
engine, model, tier and account the pill showed, the directory `/repo` (the
fixture project's root), and no role.

## 6. Where a new agent is drafted, and what today's form holds

| Entry | Where |
| --- | --- |
| Header «+ Agent» | `src/components/ProjectBar.tsx:142`, the board's own button at `src/components/kanban/KanbanBoard.tsx:2777` |
| Header create menu (narrow widths) | `src/components/kanban/KanbanBoard.tsx:1354` |
| A task card's «+ Agent» | `src/components/kanban/KanbanCard.tsx:881` |
| The phone's menu row | `src/components/ProjectDashboard.tsx:2053`, drawn by `src/components/mobile/MobileFocusView.tsx:685` |
| The draft inside a card | `CardDrafts`, `src/components/kanban/KanbanDrafts.tsx:37` |

Every agent draft, whichever entry opened it, is one component:
`DraftAgentPane` (`src/components/DraftAgentPane.tsx`), so a variant applies to
the header button, a card's button and the phone at once. «+ Task» and a
pipeline stage's draft message are other surfaces and stay as they are.

Today's form (0), line numbers in `src/components/DraftAgentPane.tsx` unless a
file is named:

| # | Option | Control today | Where |
| --- | --- | --- | --- |
| 1 | Engine | three radios in the tinted header | `:935` |
| 2 | Account | select at the header's left edge, cut to 112 px | `:933` |
| 3 | Model, effort, speed | three selects in the fourth strip | `:979` |
| 4 | Working folder | picker in the second strip | `:955` |
| 5 | Role, its parameters, its prompt preview | the third strip | `:965`, `RoleSection` `:162` |
| 6 | Reviewer's conversation, deployer's confirmation | appear when the role asks | `:839`, `:859` |
| 7 | Handoff source | the heading | `:909` |
| 8 | Prompt, images, voice, launch | the shared composer at the bottom of a 620 px card | `:1027` |
| 9 | Cancel | a bordered 12 px cross | `:942` |
| 10 | Launch in flight | the prompt as a bubble and a status sentence | `:992` |

What is crooked about it, read from the frames of look 0: a card inside a
card with two titles; four strips with four backgrounds; a fixed 620 px height
around an empty form, with the field as the last thing on it; controls cut and
sized unlike the rest of the board (the 112 px account select, the 12 px
cross, the composer's buttons shrunk to dots by the board's button reset); and
everything the operator did not come for standing between him and the field.

## 7. Costs and recommendation

**Both variants.** `DraftAgentPane`'s render shrinks to the composer and the
opening shape. The runtime pill needs a second source: today `RuntimePill`
reads a conversation and reconfigures it, and a draft has to answer the same
popover and sheet from its own launch parameters (the prototype exports the
pill's two panels and draws the pill's face beside them; a shipped version
gives the pill itself a draft source, so there is one face). The model list
gains the engine's name in front of each model, seventeen rows on the desktop.
The role block, the directory picker and the reviewer and deployer fields
leave the draft; `RoleSection` stays for the pipeline editor. The board's
rules for a draft card lose its title and foot.

**Variant 1** also needs the board to keep the composer in sight when the card
grows on Send (the prototype scrolls it into view itself). The column under
the draft moves once, at the press.

**Variant 2** needs nothing more, and costs room: an empty pane of a
conversation's height for as long as the draft is unsent, in a column or
inside a task card.

**Recommendation: variant 1.** It is the smallest thing that can be on the
board before there is an agent, which is what «минимально» asks for, and from
a task card it reads as one more row of that card. Its one movement happens at
the press that asked for a conversation. Variant 2 is the choice if a pane
that never changes size matters more than the room it holds while empty.

## 8. Evidence

The variants run in the existing kanban driver and fixture: the scenario
`new-agent` in `src/components/kanban/issue1695Evidence.fixture.tsx`, the
block «creating a new agent» in
`src/components/kanban/kanbanBoard.browser.test.tsx`. `?newagent=<n>` draws the
draft in look n, 0 being today's, and the page prints the number and the name
in a strip outside the application's frame. The fixture's launch runs on the
clock the `launch-cls` scenario already had, with the receipt held 1.5 s
longer so the frame between the press and the receipt can be read, and it
answers dictation with a fixed sentence.

```
CHROME_BIN=<chrome> LLV_KANBAN_BROWSER_TEST=1 NEW_AGENT_OUT=<dir> \
  bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "creating a new agent"
```

Each look is walked at 1440x900, 1000x700 and a 390 px phone, light and dark,
in English and Ukrainian, from the board's own button: the empty form, the
runtime pill open on its model list (the phone's sheet), the model and the
account chosen, dictation in progress, the frame after Send, the loaded
conversation. On the desktop the launch is walked again from a task card's own
«+ Agent»: empty, after Send, loaded. Three more states are drawn once per
look, at 1440 in the light theme in English: a refused launch, a handoff
draft, a signed-out account. 285 frames, and one comparison sheet per size
with today, variant 1 and variant 2 side by side in every row. The frames and
sheets are written outside the repository and are not committed.

What the driver asserts for variants 1 and 2
(`evidence/new-agent-redesign/options.json`):

- the form holds one field, one microphone, one image input, one send button
  and one runtime pill, and no select, radio, text input or folded section,
  with at most five buttons in all, and the whole composer is inside the
  window;
- the cursor is in the field when the draft opens, from the board's button and
  from a task card's;
- the pill's popover is inside the window, and after the choice the pill's
  face names the model and the account;
- one Send makes one launch request, carrying the engine, model, tier and
  account that were chosen, the project's root as the directory, and no role;
  a model of another engine launches that engine;
- after Send the pane holds the first message as a row of the feed and the
  loading shape, and no status sentence; the message and the composer are both
  inside the window; in variant 2 the pane's box is the same before and after;
- the loaded conversation shows the first message once and the agent's answer,
  the draft is gone, and a draft opened from a task card ends as a
  conversation on that card;
- a refused launch keeps the prompt in the field and says why; a handoff draft
  arrives with its source in the field; a signed-out account offers its
  sign-in;
- no page error in any walk.

Limits of the prototypes. The pill's face is drawn in the prototype beside
the pill's real panels, class for class. A look overrides the board's rules
for a draft card from a style block of its own. The loading shape is trimmed
to its last block by the same style block. The phone's sheet is headed «Next
message», the conversation's wording, which also fits a first message. In the
frames of the loaded conversation the driver scrolls the product's card into
sight, because that card is taller than the pane it replaced; at 1000x700 the
board's conversation height is taller than the board's visible area, today as
well, so the frames there show the composer end of the pane.

## 9. The rejected looks

Looks 1 to 3 of the first round (the composer as a card with a runtime grid,
a one-line summary that opened groups, a sheet anchored to the button) kept
every option of today's form on the surface and were rejected for that. Their
frames and sheets are kept beside the new ones in a folder named
`rejected-looks-1-3`; their code is removed from the branch and remains in its
history (`abed14684`).

## 10. As built

`DraftAgentPane` (`src/components/DraftAgentPane.tsx`) is the form: the
product's `ComposerBar` with `DraftRuntimePill`
(`src/components/draft/DraftRuntimePill.tsx`) in its left slot, and nothing
else. What differs from sections 1 to 8:

- **One face.** The pill's button is `RuntimePillFace`
  (`src/components/RuntimePill.tsx`), the same component a conversation's pill
  draws. The draft feeds it, the popover and the phone's sheet from its own
  launch parameters, so what the face says is what Send launches.
- **The tier is always on the face.** A conversation's pill always names a
  tier. With none chosen the draft's face says «Default» («Типово»), since the
  launch then sends no tier and the engine picks its own.
- **The phone's sheet is headed «New agent»** («Новий агент»), with the line
  «The agent starts on: …» under it; its account rows carry no «current» and
  «next message» marks, which belong to a running conversation. The phone's
  chip names no account, as a conversation's chip names none; the desktop face
  names a picked account after an arrow. The accessible names say the same:
  the pill, its popover and the sheet are «Model and reasoning the new agent
  starts with», and an account row reads «Start the agent on …», so nothing in
  the draft speaks of a next message.
- **The form stays in the window while it grows.** A draft opened low in its
  column (at 1440x900 under the orchestrator's window, its form at y 784-866)
  grows before Send by the recording panel, the picture's tiles or a refused
  file's line. Each change of its height brings the whole form back into sight
  at the nearest edge, with a margin of its card under it; a form already in
  sight scrolls nothing.
- **Nothing moves when the launch answers.** From the press the pane is laid
  out as the launched card will be: on a card that holds only the draft, the
  task's title, status and description rows; then the conversation window's
  box with its head; then the first message where the feed draws it. The
  driver compares the first message's box before and after the launch reply
  at every size and finds it unchanged. The board lands the opening the way it
  lands a launched card (the card's head at the top of its column), so the
  board's own reveal at the reply has nothing left to scroll. A column holds a
  reader's width from the moment a draft opens in it.
- **The composer after Send** stands where the launched window's composer
  will. At 1440x900 and 1000x700 that is under the window's lower edge, as it
  is on the product's launched card; it is locked until the launch answers.
- **Attachments are images.** A launch carries images and no other file
  (`POST /api/spawn` takes `images`; the conversation composer's documents go
  through `/api/tmux`, which stages them in the inbox of a conversation that
  already exists). The form shows the image picker and refuses another file by
  name. Parity needs the launch command to admit, stage and settle a file
  batch as the message route does, and to count the files in its replay
  digest.
- **A handoff launches in its source's own folder and nowhere else.** The
  board's seed for a handoff is a guess when the source's folder is not in the
  files feed, and nobody sees it any more. The form launches a handoff only in
  a folder the source names: the one `GET /api/spawn?src=` reads from the
  source transcript, or the one the files feed carries for it. Until that
  answer arrives Send is held («Finding the folder of the conversation this
  agent continues…»); when no record names the folder the launch is refused in
  words and no path is asked for.
- **The working directory** of any other draft is the one the board seeded when
  it was opened: the project's root. While the
  project's folder is unresolved the board seeds `/`; the form then holds Send
  with the composer's blocked-send line («This project's folder is not known
  yet…») and launches as soon as the board finds the folder. The suggestions'
  other directories are no longer a fallback: unseen, a guess is not launched
  in.
- **A launch from this form carries no role.** Reviewer and Deployer were
  reachable only through the form's role select and have no entry point here;
  roles stay with the orchestrator's tools.

- **The pill says what the launch carries.** A reasoning level the chosen
  model does not have goes back to the default when the model changes; Codex's
  speed is shown and sent for Codex alone; a Copilot draft chooses its account
  in the pill's Account panel, among the accounts the draft's catalog lists.
- **One press, one launch.** Send is guarded from the press until its request
  answers, so Enter and a click in the same instant make one attempt.

Evidence: the block «creating a new agent» in
`src/components/kanban/kanbanBoard.browser.test.tsx` over
`?scenario=new-agent`, and its readings in
`evidence/new-agent-redesign/built.json`. `NEW_AGENT_TODAY` names the frames of
the old form (shot by the design lane at the last commit that had it) for the
comparison sheets.
