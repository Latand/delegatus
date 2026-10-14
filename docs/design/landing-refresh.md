# Landing refresh: what is stale on delegatus.org, why, and the builder's plan

## Originating requirement

Operator, 2026-10-14 about 08:55Z, in Russian, as pinned on the lane's task
(«Landing shows the current Delegatus interface: refresh every stale product
picture and demo»), verbatim:

> «…фотки обновить на лендинге, потому что там старые. И на лендинге можно.»

In English: "…update the pictures on the landing, because they are old. And on
the landing one can." The pinned outcome: every picture of the product on the
landing (delegatus.org, source `landing/site/`) shows the current Delegatus
interface: the hand-drawn hero (`landing/site/boardDemo.js`) and the real
product bundled into the frames below it (`landing/site/demo/*`), in en and uk,
at 1440 and 390.

This document is step one of the pinned specification: the observation, the
cause of each stale picture, and a file-by-file plan for the builder. Nothing
here deploys; publication to delegatus.org is a seat step after merge.

## The answer in short

1. **delegatus.org is a build of main at `aaf82e179`** (#2775, 2026-10-12
   07:27Z), byte for byte. All nine files the page serves match a fresh build
   of that commit; a build of today's head differs only in the product bundle
   (`demo/demo.js`, `demo/viewer.css`). Thirty commits touching the product's
   components, styles or words landed on main after it; the ones a visitor
   sees in the frames are listed in §3.2.
2. **The frames are stale because of publication age, and a rebuild alone
   cannot refresh them**: on today's head the run frame never loads. Its two
   desktop views press a control that #2800 (calm task cards, 2026-10-13)
   took off the closed card. A one-step change in `demo/demo.tsx` fixes it;
   it is proven on a scratch copy (§3.1).
3. **The hero is stale in the source**, on the live site and at head alike.
   It copies the board as it looked before 2026-10-12: a `Board` view pill and
   `+ Task` in the header, a status pill, cards with a description and a
   footer line, three columns, an arrow-up send button, an orange dot for
   Claude, and a phone layout (three narrow columns under the chat) that the
   product never had (§4).
4. **The demo world shows broken-looking states** on every build: three cards
   read «Stopped, no reason given» and a builder feed reads «Worked for 0s»
   (§3.3).
5. **One caption names what the picture no longer shows**: «with the finding
   and both ways forward» (§3.4).

The plan (§6) redraws the hero to the current product look element by element,
each element named against the product file it copies, fixes the run frame's
navigation, corrects the world data and the one caption, and changes nothing
under `src/`.

## 1. How it was observed

All work ran on a `git archive` export of the head (`cfe9ae97b`, which is
also remote `main` at the time of writing) in the stage's own `$TMPDIR`, with
`HOME`, `XDG_*`, `LLV_STATE_DIR` and `TMPDIR` isolated, under
`scripts/gate-slot.sh` and `/var/tmp/llv-heavy-gate.lock`. Renders are kept
outside the tree under `~/Pictures/delegatus-review/landing-refresh/` and are
never committed.

| What | How | Where the frames are |
| --- | --- | --- |
| The live site | Downloaded every file delegatus.org serves (`/`, `styles.css`, `copy.js`, `boardDemo.js`, `main.js`, `mascot.js`, `brand/delegatus-mark.svg`, `demo/`, `demo/demo.js`, `demo/viewer.css`) and compared them with builds. Rendered with the existing driver, `capture.ts` (default run), over that byte-for-byte copy served locally, so the capture's beacons wrote nothing to the production analytics. | `live/` (85 files: first screen, sections, the hero at its six steps, every tab of every frame, full page, `report.json`; en/uk × 1440/390) |
| Which commit is live | Rebuilt `aaf82e179` from an export with the same `build.ts` | md5 of `demo/demo.js` `78ed32d32b…` and `demo/viewer.css` `01217fc8b6…` equal the live files; the seven page files equal head's too |
| The landing at head | `bun landing/site/build.ts`, then `capture.ts` | `head/`: only `en-1440-first-screen.png`; the run stopped with `TimeoutError: waitForSelector .live-run[data-loaded]` |
| The landing at head with the S1 fix | The same build with the one-step navigation fix on a scratch copy, then `capture.ts` and `capture.ts --check-conversation` | `head-navfix/` (85 files, no page errors, no sideways overflow in any of the four runs), `head-navfix-checks/` |
| The current product | The real `Viewer` at head, i.e. the landing's own demo bundle over the invented world, opened view by view (`?step=5&view=…`) in a 1440×900 and a 390×844 frame, en and uk, by a scratch probe that records `dlg:viewed` / `dlg:view-error` | `product-head/` (board, orchestrator docked on top, folded, pipeline, decision, conversation, search, accounts, overview; phone board, orchestrator, reports, decision, pipeline, conversation; `probe-report.json`) |
| The current product with no orchestrator | The same probe over a scratch copy that answers an empty seat and no tasks (`?noseat=1`) | `product-head-noseat/`: the seat's creation draft and the empty board, desktop and phone, en and uk |
| The S1 fix in the product views | The same probe, pipeline and decision views | `product-head-navfix/` |
| The hero's holds today | `capture.ts --check-demo --no-frames` on the head build | `check-demo-head/demo-check.json` (baseline in §7) |
| Landing tests today | `bun test landing/site/copy.test.ts landing/worker.test.ts` | 111 pass, 0 fail |

The probe and the scratch patch are kept beside the frames in `harness/`
(`zz-probe.ts`, `demo-noseat-and-navfix.patch`, `README.txt`) so a later stage
can repeat any frame. They are observation tools and stay out of the tree; the
builder renders with `capture.ts`, the landing's one driver.

## 2. What differs between the live site and a fresh build

| File | Live = build of `aaf82e179` | Build of head |
| --- | --- | --- |
| `index.html`, `styles.css`, `copy.js`, `boardDemo.js`, `main.js`, `mascot.js`, `demo/index.html`, `brand/*` | identical | identical |
| `demo/demo.js` | 4 776 320 B | 4 978 942 B |
| `demo/viewer.css` | 330 462 B | 341 190 B |

So nothing in the page itself changed since publication; the hero is the same
picture on the live site and at head. Every difference a visitor can see in the
frames comes from the product components bundled into `demo.js`.

## 3. Stale pictures in the frames, and their causes

### 3.1 S1 — the run frame does not load on today's head (blocks any republish)

- **Seen:** `head/` (capture timeout on `.live-run[data-loaded]`);
  `product-head/probe-report.json`: `pipeline` and `decision` answer
  `dlg:view-error "Demo view did not become ready"` at 1440 in en and uk; every
  other view answers `dlg:viewed`. The phone reaches both through
  `#pipeline=` and is unaffected.
- **Cause:** #2800 made cards closed by default. A closed card draws its lane
  at card density (`src/components/pipelines/PipelineBlock.tsx:553`), which has
  no `[data-open-stages]` opener; the opener lives in the lane row of an open
  card (`PipelineBlock.tsx:620-627`). `landing/site/demo/demo.tsx:587` presses
  `.card[data-id="task:…"] [data-open-stages]` on the closed card and waits 4 s
  for it.
- **Fix (proven):** open the card through its own fold button
  (`src/components/kanban/KanbanCard.tsx:614-621`, `.icon-btn.fold` with
  `aria-expanded="false"`) and then press the opener. With that step the views
  answer `dlg:viewed` in en and uk (`product-head-navfix/`), and the whole
  `capture.ts` run completes (`head-navfix/`).
- **Consequence for publication:** a republish from main before this lane
  merges would put a spinner, then a retry control, in place of the run
  section on delegatus.org.

### 3.2 S2 — every frame shows the product as of 2026-10-12 07:27Z

- **Seen:** `live/*-2-run*.png`, `live/*-3-open*.png`, `live/*-4-reach*.png`
  against `head-navfix/` with the same names.
- **Cause:** publication age. The commits below landed on main after
  `aaf82e179` and change what the frames draw:

| PR | What a visitor sees change in the frames |
| --- | --- |
| #2800 calm task cards | closed cards: head, a state dot with one sentence, the lane chain; «Answer» only where an answer is owed; Skip and Retry leave the card face and the phone's decision screen (`live/en-1440-4-reach-decision.png` shows «Skip stage / Retry stage», `product-head/en-390-decision.png` has none) |
| #2754 role avatars | Delegatus in the role's costume on feed answers and conversation headers (builder, reviewer, verifier, orchestrator) |
| #2782 one-row board header, #2799 Tasks panel removed | the board's header, behind the Search tab's dialog (`head-navfix/en-1440-3-open-search.png`) and on any frame opened full screen; the Activity frame keeps the Overview's own bar |
| #2744 finished work stays in Done until accepted, #2794 columns order by newest work | Done and In progress card order and faces |
| #2758 decisions as forms in the seat's «Рішення» column, #2769 needs-you keeps real decisions | the seat docked on top has «Decisions · Reports» tabs; the needs-you counts |
| #2797 phone voice head | the phone conversation's ⋯ menu |
| #2783, #2837, #2815 activity truth | working dots and counts |

  The full first-parent list touching `src/components`, `src/styles`,
  `src/app/globals.css` or `src/lib/i18n` since `aaf82e179` has 30 commits
  (`git log --first-parent aaf82e179..cfe9ae97b -- …`).
- **Fix:** none in source beyond S1 and S3: the frames are the product, so the
  lane's build carries the current interface, and the seat's publication after
  merge puts it on delegatus.org.

### 3.3 S3 — the demo world draws broken-looking states (live and head)

| Where | What reads wrong | Cause in `landing/site/demo/world.ts` |
| --- | --- | --- |
| Board, Waiting column; phone Waiting tab | both cards read «Stopped, no reason given» / «Без руху, причину не вказано», and the column head counts «▪2» without a reason (`product-head/en-1440-board.png`) | `t-ledger` (`:341`) and `t-v1` (`:347`) are `blocked` with no `hold`; the product reads the reason from `BoardTask.hold` (`src/lib/tasks/types.ts:1-12`, words in `kanban.hold.*`) and says «no reason» without it |
| Board In progress, phone In progress | «Email a receipt for each refund» sits under a «Stopped · 1» band and reads «Stopped, no reason given»; the column head reads «1 stopped» | `t-receipts` (`:346`) is `assigned` with one idle conversation, no lane and no hold |
| Run frame, phone conversation | «Worked for 0s» under the builder's and reviewer's first answers (`product-head-navfix/en-1440-pipeline.png`, `product-head/en-390-conversation.png`) | the operator's line and the agent's first reply carry the same timestamp (`since(2)` at `:212`/`:216`, `since(3)` at `:246`/`:250`) |
| Overview, Waiting | `t-import` (quarry) | same as the first row; it waits on a choice, which the product calls an `operator` hold |

### 3.4 S4 — a caption that no longer matches its picture

`reach.c2` (`landing/site/copy.js:84`, uk `:218`): «A decision waits on its
card, with the finding and both ways forward.» Since #2800 the card face and the
phone's decision screen show the finding and one «Answer» / «Відповісти» row;
the two ways forward are rows of the card's ⋯ and of the phone's lane sheet.

No other caption names a retired control: `run.*`, `open.*`, `reach.c1`,
`reach.c3`, the tab labels, the alt texts and `demo.c1`–`demo.c6` still describe
what the current frames and the hero's story show.

## 4. The hero, element by element

The hero is drawn in the product's own tokens, and those tokens are current
(`landing/site/styles.css:5-21` and the hero's literals match the dark block of
`src/styles/tokens.css`: canvas `#111218`, card `#191b23`, sunken `#14151b`,
borders `#292c36`/`#3c404c`, accent `#8f88ff`/`#262347`, success `#4fc36f`,
warning `#e0ae45`, text `#e8e8ec`/`#a2a2ae`/`#8b8b98`, Claude `#e08a6d`). What
is stale is the anatomy of each surface. Frames: `live/*-demo-1…6.png` (the
hero, identical at head) against `product-head/` and `product-head-noseat/`.

### 4.1 Desktop (stage 1280×384)

| # | Hero today (`boardDemo.js` / `styles.css`) | Current product, as rendered | Product files the drawing must match | Since |
| --- | --- | --- | --- | --- |
| H1 | Top bar: live dot + `harbor-api`, a 260 px «Find a task» field left beside the name, then pills `Board` (pressed), `+ Task`, `Orchestrator` with the bird mark (`boardDemo.js:96-104`, `styles.css:216-232`) | One 48 px row of 32 px controls: name · `● N` working (dot and count) · spacer · [search «Find a task» │ filter funnel] · `+` · [`Orchestrator` with the lucide `Bot` icon, pressed while the seat is open │ recent agents (history icon)] · `⋯` · «Needs you N» chip, outlined at 0 (`product-head-noseat/en-1440-board.png`), filled amber when something waits (`product-head/en-1440-board.png`) | `src/components/ProjectBar.tsx:12-24` (groups, variants), `src/components/kanban/KanbanBoard.tsx` (the bar's middle groups), `docs/design/board-header.md` §«The Tasks control and its panel left the bar» (the row as built), `src/components/kanban/kanbanBoard.css` | #2782, #2799 (2026-10-12) |
| H2 | Seat before creation: a dashed card in the seat's place with the bird mark, «Create its orchestrator», one line, an engine pill «● Claude · Opus 5.5», an accent «Create orchestrator» button (`boardDemo.js:107-113`, `styles.css:239-250`) | The seat pane itself: head «Orchestrator ● none yet» with the costume avatar; «Create the orchestrator for harbor-api»; the intro paragraph; a «Runs on ✳ Claude · Opus 5.5 · high effort · account Main / Change» box; «Its instructions (vN) (edit)»; at the pane's foot a full-width cream primary button with the `Bot` icon, «Create the orchestrator» (`product-head-noseat/en-1440-board.png`) | `src/components/orchestrator/OrchestratorPanel.tsx:1110-1260` (draft), `src/components/orchestrator/RunsOnRow.tsx`, `--color-brand`/`--color-on-brand` in `src/styles/tokens.css` | the draft predates the hero; the hero drew its own card |
| H3 | Seat head: brand mark in a rounded square, «Orchestrator» over «● Claude · Opus 5.5», a bordered status pill «waiting» / «working» (`boardDemo.js:115-119`, `styles.css:252-266`) | Row 1: costume avatar (role `orchestrator`), «Orchestrator», a quiet dot and word «waiting» / «working», head icons (report log, dock, open in the agent window, collapse ‹). Row 2: engine chip «✳ Claude», «Opus 5.5 · High», account «Main», a context meter «6%». Row 3: Reports, the tick switch, Rotate, Stop host. The pane wears the accent border and the orchestrator's role tab (⚡) at its top-left corner | `OrchestratorPanel.tsx:570-680` (head), `:1286` (badge tones), `src/components/orchestrator/IncumbentHeader.tsx`, `src/components/brand/RoleAvatar.tsx` + `roleCostumes.ts` (`costumeSvg("orchestrator")`), `src/styles/roleFrames.css` | role avatars #2754 (2026-10-12); dot-and-word status, operator rule of 2026-10-12 |
| H4 | Chat: user bubble; a «● Claude» label; the answer with three task chips; report lines with a green check (`boardDemo.js:120-132`) | User bubble (right, with its copy icon); assistant rows with the costume avatar and «✳ Claude · 12:05:34»; the orchestrator creating work shows as tool rows «MCP · VIEWER  Creating task: Idempotent refunds ✓» and «Creating pipeline: …»; «Worked for 40s» under a turn; the amber line «finished the turn — waiting for a reply» (`product-head/en-1440-orchestrator.png`) | `src/components/feed/FeedItem.tsx` (assistant row, avatar), `src/components/feed/UserMessageRow.tsx`, `src/components/feed/cards/ToolCard.tsx` (tool row), `src/lib/mcp/presentation.ts:140,163` (tool row titles) | #2754; tool rows long before the hero |
| H5 | Composer: placeholder «What should get done in harbor-api?», accent send square with an arrow-up (`boardDemo.js:133-139`, `styles.css:285-293`) | Input row: «what should get done in harbor-api?» (lowercase, `composer.placeholderOrchestrator`), mic, send square with the `Play` triangle, ⌄. Footer row: «⚡ Opus 5.5 · Light ⌄», attach, ⋯ | `src/components/TmuxComposer.tsx` (send uses `Play` from `@/components/icons`), `src/components/orchestrator/OrchestratorConversation.tsx` | #2756 (2026-10-12) |
| H6 | Three equal columns Inbox / In progress / Done, each «Nothing here yet» (`boardDemo.js:142-148`, `styles.css:295-299`) | Four columns: Inbox, In progress, Waiting, Done. In progress is the wide work column with the dot grid; the others are shelves; an empty shelf is a 48 px strip with its count and vertical name. Heads: name, count, widen ⤢, ⋯; In progress adds «● N working · N needs you · N stopped». An empty work column shows a dashed box «Nothing in progress / A task moves here when the orchestrator starts an agent on it.» | `src/components/kanban/KanbanBoard.tsx:2585-2593` (strips), `:3304-3305` (empty box), `src/components/kanban/kanbanLayout.ts` (tracks: shelf 264, work ≥ 520, strip 48), `kanbanBoard.css` | Waiting existed before the hero; strips and the wide work column predate it too |
| H7 | Card: icon + title, a description line, stage pills «✓ Build — ◌ Review — ○ Verify», a footer «Claude builds · Codex reviews» or «PR #128 merged»; card b «● Claude · working» (`boardDemo.js:73-91`, `styles.css:300-332`) | Closed card: the task colour as a stripe on its left edge; head (task icon, title clamped to two lines, › fold, ⋯); one state line (an 8 px dot in the owner's tone + «Working · 1» / «Needs your answer: …» / «PR #128 merged», then the age); the lane chain: stage chips with the model glyph and a state badge (Opus spark, Codex Sol sun, Sonnet quill), «→» between them, the age, the PR at the end. An Inbox card shows its head only. No description on a closed card | `src/components/kanban/KanbanCard.tsx`, `CardStateLine.tsx` + `cardState.ts` (sentences, dot tones at `kanbanBoard.css:1919-1924`), `src/components/kanban/TaskMotionLine.tsx`, `src/components/pipelines/PipelineBlock.tsx:553-591` (card density chain, ended line), `src/components/kanban/StageGlyph.tsx` + `modelGlyph.ts` (glyphs), `docs/design/calm-task-cards-build.md` §5–6 | #2800 (2026-10-13); model glyphs 2026-09-29 |
| H8 | Engine identity: an orange dot for Claude (`.d-claude`) | The engine chip «✳ Claude» and the model glyphs (H7); Codex blue `#6ba2e8` | `StageGlyph.tsx`, `IncumbentHeader.tsx` | 2026-09-29 |
| H9 | Wires: square bends built from separate segments, 7 px ports, an 8 px pulse (`boardDemo.js:350-412`, `styles.css:334-341`) | 1.5 px accent stroke with rounded bends (radius 6), a filled seat port, card ports in card colour with an accent ring, the 8 px dot with its 3 px halo, dashes flowing while the seat acts | `src/components/kanban/orchestratorWires.ts` (`CORNER = 6`, routing), `kanbanBoard.css:1888-1910` (`.oa-*`) | #2601 (2026-10-08) |
| H10 | Pointer and click ring | unchanged: the hero's own device | — | — |

### 4.2 Phone (stage 360×606)

The phone hero draws the chat panel over three narrow side-by-side columns with
a fingertip (`styles.css:354-394`, `live/en-390-demo-1…6.png`). The product's
phone has never laid the board out that way. What it draws
(`product-head/en-390-board.png`, `product-head-noseat/en-390-board.png`,
`product-head/en-390-conversation.png`):

| # | Phone product element | Files |
| --- | --- | --- |
| P1 | A 52 px bar: «harbor-api ⌄», the needs-you chip when something waits, search, ⋯ | `src/components/mobile/MobileShell.tsx:286` |
| P2 | The seat row: a `Bot` icon in an accent-soft circle; «No orchestrator / Create an orchestrator ›» before creation, «Orchestrator» with its state after | `src/components/mobile/MobileSeatCard.tsx:560-575` |
| P3 | Column tabs «Inbox / In progress / Waiting / Done» with counts and an underline on the open tab; one column of full-width calm cards under them | `src/components/mobile/MobileKanban.tsx:1231` (tabs), `CardView` in the same file |
| P4 | An empty tab: a round icon, «Nothing in progress», its body, an accent «Tell the orchestrator» button, a chip naming the other tabs' counts | `src/components/mobile/MobileBoard.tsx` |
| P5 | The bottom dock: «Create an orchestrator to talk to…» before creation, «Tell the orchestrator…» with a mic after | `MobileBoard.tsx:395` |
| P6 | The orchestrator's chat is its own screen: a header with ‹, the costume avatar, the title and a status line; the feed (H4's rows); the composer at the bottom with its footer row | `src/components/mobile/MobileFocusView.tsx` |
| P7 | Wires on the phone run down the open tab's left margin into the card ports | `orchestratorWires.ts` header comment |

## 5. Decisions

### D1. The hero stays hand-drawn and is redrawn to the current look

- **(a) Redraw by hand, each element named against its product file
  (recommended).** Keeps the operator's 2026-10-09 choice (a demo that plays by
  itself, smooth under a slow CPU, compositor-only) and the measured budget
  (§7). Cost: the drawing goes stale again when the product changes; §6.8 makes
  the product file of every element part of the landing README so the next
  refresh has a checklist.
- (b) Put the real `Viewer` in the hero. The operator's 2026-10-09 review
  turned this down for smoothness; the bundle is 4.9 MB at head and re-renders
  the board per step. Rejected.
- (c) Render product components to static markup at build time and animate
  that. **OVER-BUILT:** the components need providers and hooks, and their
  classes need the 333 KB product stylesheet on the first screen; the drawn
  hero weighs 30 KB. Rejected.

### D2. The phone hero follows the product's phone layout

The acceptance names the phone layout, and the three-columns phone picture
matches no product screen. The phone hero becomes the product's own screens:
P1–P5 for the board and P6 for the chat. It keeps the six steps, the captions
and the 24 s loop. Choreography (all of it transforms and opacity on layers
laid out once):

1. Board, no orchestrator: P2 «No orchestrator», P4 empty In progress tab, P5
   «Create an orchestrator to talk to…».
2. The finger taps «Create an orchestrator»; P2 becomes «Orchestrator ● waiting»
   and P5 «Tell the orchestrator…».
3. The finger taps the dock; the chat screen (P6) slides in; the request types
   into its composer; send.
4. The answer arrives with three «Creating task» rows; the chat slides away; the
   Inbox tab opens and its count goes 0 → 3 as the three cards land.
5. The finger taps In progress; two cards are there (count 2, «● 2 working»);
   the wires run down the tab's left margin; Build, Review and Verify pass on
   card a's chain.
6. Card a leaves for Done (Done 0 → 1); the finger taps Done; the card reads
   «PR #128 merged». The board holds, then resets.

Tab switches cross-fade the column layers and slide the underline; counts
cross-fade stacked digits, the way the rail's captions do today.

### D3. Columns on the desktop stage

Four columns, as the product draws them: Inbox shelf, In progress as the work
column (widest, with the dot grid), Waiting as the product's 48 px empty strip
(it holds nothing in the loop, which is exactly when the product draws a
strip), Done shelf. With the seat at 360 px the board has about 888 px:
shelves of about 232 px, the strip 48 px, the work column the rest (about
330 px).

**Departure, named:** in the product's wide grid an empty Inbox or Done is also
a strip and opens when a card arrives, which resizes the other columns. The
hero keeps Inbox and Done open from the first frame and fills them with the
product's own empty box words (`kanban.empty.inbox.*`, `kanban.empty.done.*`;
the product draws that box in its tabbed and work-column modes). Animating
column widths would lay out on the main thread during the loop and break the
compositor-only hold (§7).

### D4. What the hero may draw

Every control the hero draws exists in the product at that place, with that
look, and with the product's words in each language. Where the stage has no
room, the hero leaves a control out and never draws a stand-in. Named
omissions, to be listed in the landing README:

- the seat head's third row (Reports, the tick switch, Rotate, Stop host): the
  384 px desktop stage cannot hold it with a readable chat;
- the composer's footer row on the desktop stage if the chat drops below two
  readable messages (the builder measures; the phone keeps it);
- the draft's intro paragraph and «Its instructions» row on the desktop stage
  (the title, the Runs on box and the button stay);
- the column jump strip and the column widen controls' hover states.

The product's exact strings for the drawn words, en / uk:

| Element | en | uk | Product key |
| --- | --- | --- | --- |
| draft title | Create the orchestrator for harbor-api | Створіть оркестратора для harbor-api | `orchPanel.draftTitle` |
| Runs on | Runs on · ✳ Claude · Opus 5.5 · high effort · account Main · Change | Працює на · ✳ Claude · Opus 5.5 · зусилля high · акаунт Основний · Змінити | `orchPanel.runsOn*`, composed in `RunsOnRow.tsx:19-20` (the effort is the raw value; the account label is the world's, `demo.tsx:189`); seen in `product-head-noseat/{en,uk}-1440-board.png` |
| create button | Create the orchestrator | Створити оркестратора | `orchPanel.confirm` |
| seat status | none yet · waiting · working | ще немає · чекає · працює | `orchPanel.badge*` |
| composer | what should get done in harbor-api? | що зробити в harbor-api? | `composer.placeholderOrchestrator` |
| find | Find a task | Знайти задачу | `kanban.find` |
| needs-you chip | Needs you | Потрібні ви | `attention.chip` |
| columns | Inbox · In progress · Waiting · Done | Вхідні · У роботі · Очікують · Готові | `kanban.status.*` |
| empty Inbox | No tasks yet / The orchestrator adds a task here for each thing you ask. | Задач ще немає / Оркестратор додає сюди задачу на кожне ваше прохання. | `kanban.empty.inbox.*` |
| empty In progress | Nothing in progress / A task moves here when the orchestrator starts an agent on it. | Нічого в роботі / Задача переходить сюди, коли оркестратор запускає на ній агента. | `kanban.empty.assigned.*` |
| empty Done | Nothing finished yet / Finished tasks keep their history here. | Ще нічого не завершено / Завершені задачі зберігають тут свою історію. | `kanban.empty.done.*` |
| working line | Working · 1 | Працюють · 1 | `kanban.motion.workingN` |
| merged line | PR #128 merged | PR #128 змерджено | `cardState.done.merged` |
| worked for | Worked for 40s | Працював 40 с | `turn.worked` |
| phone seat row | No orchestrator / Create an orchestrator | Немає оркестратора / Створити оркестратора | `mobile2.seat.none`, `mobile2.seat.create` |
| phone dock | Create an orchestrator to talk to… / Tell the orchestrator… | Створіть оркестратора, щоб спілкуватися… / Скажіть оркестратору… | `mobile2.seat.createDock`, `mobile2.board.tellOrchestrator` |

The product's uk interface addresses the reader formally («Створіть»); the
landing's own copy says «ти». Inside the hero the product's words win, because
the hero is a picture of the product.

**Departure, named:** the product prints the tool rows' titles in English in
both languages (`src/lib/mcp/presentation.ts:140,163` builds «Creating task: …»
with no translation; see `product-head/uk-1440-board.png`). The hero's uk tool
rows say «Створюю задачу: …» / «Створюю пайплайн: …» with the row's anatomy
unchanged; an English line inside the uk hero would read as a landing defect.
The product gap is outside this lane's fence (Deferred).

### D5. Product drawings inside the hero

- Lucide icons stay copied as paths in `boardDemo.js`, as today, each with the
  name of the icon the product imports (`Bot`, `History`, `Filter`, `Plus`,
  `MoreHorizontal`, `Play`, `Mic`, `ChevronDown`, `ChevronRight`, `Search`,
  `Maximize2`, `ScrollText`, the task icons the world already names).
- The three model glyphs the story needs (Opus spark, Sol sun, Sonnet quill) and
  their passed/running/waiting badges are copied from
  `src/components/kanban/StageGlyph.tsx`, with that file named beside them.
- The orchestrator's costume avatar is written by `build.ts` from
  `costumeSvg("orchestrator")` (`src/components/brand/roleCostumes.ts:177`, a
  pure function) into `dist/brand/`, the way `build.ts` already writes the task
  icons from `taskIconNodes`. The avatar then follows the product on every
  build, and no copy of a 180-line drawing goes stale in the landing.

### D6. What stays

The 24 s loop, `STEPS`, `HOLD`, the six captions and their timing, the
compositor-only rule (one Web Animation per moving element, `transform` and
`opacity` only, positions read once per build), the reduced-motion still, the
play-only-in-view logic, the pause button, `window.DLG.demo`, the stage sizes
(1280×384 and 360×606) and the class hooks `capture.ts` reads: `.demo-stage`,
`.d-card`, `.d-msg`, `.d-fly`, `.d-pulse`, `.d-cursor`, `.d-typed span`,
`.d-comp` (`capture.ts:838-1219`). A card is still a `.d-card`, every chat row a
`.d-msg`, the typed words `.d-typed span` inside `.d-comp`. If a hook has to
move, `capture.ts` moves with it in the same change.

## 6. File-by-file plan for the builder

Fences: nothing under `src/`, `docs/**`, the root `README.md` or
`CHANGELOG.md` changes. The landing imports product modules at build time only
(`build.ts`) and copies product looks by hand into the hero.

### 6.1 `landing/site/demo/demo.tsx`

- **S1** (`:585-588`): before pressing the opener, open the card:
  click `.card[data-id="task:${card}"] .icon-btn.fold[aria-expanded="false"]`
  when present, then `press(…[data-open-stages])` as today. The tested form is
  in `harness/demo-noseat-and-navfix.patch`. Acceptance: `capture.ts` (default)
  completes in en/uk at 1440 and 390; `.live-run` loads both tabs; no
  `.demo-retry` anywhere.
- Nothing else changes here. The `frameFill` overrides still hold at head
  (`capture.ts --check-conversation` passes: plain border, no ribbon, no ring).

### 6.2 `landing/site/demo/world.ts`

- **S3a:** give `t-ledger` and `t-v1` a `hold` (`kind: "external"` with a note
  naming finance, and `kind: "external"` or `"task"` for the v2 move), `by:
  "agent"`, `since` from `ago(…)`; give `t-import` (quarry) `kind: "operator"`
  with the choice as its note. Words come from `kanban.hold.*` in both
  languages. Acceptance: no «no reason» anywhere in `head` renders; the Waiting
  head drops its «▪2».
- **S3b:** `t-receipts`: a calm state. Recommended: `hold: { kind: "pr", ref:
  "131" }` so the card reads «Waiting for PR #131» (its conversation already
  says «Ready for review»). Acceptance: no «Stopped · N» band in In progress on
  either layout; the column head drops «1 stopped».
- **S3c:** date each agent's first reply at least 20 s after the line it answers
  (`:212-219`, `:246-250`, and the verifier's tool row), so «Worked for» reads a
  real duration.
- **Optional, small:** give one Done task (`t-charges`) a completed lane with its
  merged PR (fields per `Pipeline` in `src/lib/pipelines/types.ts`) so its card
  reads «PR #… merged» in the frames, which is the face H7 copies for the hero's
  last step.
- Keep every name invented; the privacy gate and the README's «no private
  data» rule apply as before.

### 6.3 `landing/site/copy.js` (en and uk together)

- **S4** `reach.c2`: en «A decision waits on its card with the finding and an
  Answer button.»; uk «Рішення чекає на картці разом із зауваженням і кнопкою
  «Відповісти».»
- Hero keys: remove `d.board`, `d.task`, `d.engines`, `d.empty`,
  `d.draft.line`; rewrite `d.draft.title`, `d.draft.create`, `d.placeholder`,
  `d.status.*` and `d.draft.engine` to the product strings of the D4 table; add
  keys for `Waiting`, the three empty boxes, «Needs you», «none yet», the Runs on
  row, «Working · 1», «Worked for …», the tool-row titles and the phone's seat
  row and dock. `d.merged`, `d.find`, `d.orch`, `d.col.*`, `d.prompt`,
  `d.answer*`, `d.r*` and `d.t*` stay unless the drawing drops them.
- `landing/site/copy.test.ts` keeps both languages complete (it checks every
  key the page and the demo name).

### 6.4 `landing/site/boardDemo.js`

- `build()` (`:93-153`): H1 header with the D1 groups; H2 draft as the seat
  pane's draft; H3 seat head rows 1–2 with the role tab and the costume avatar
  (`brand/role-orchestrator.svg` from §6.6); H4 chat rows (`.d-msg`) with the
  avatar, «✳ Claude · time», tool rows, the amber turn line; H5 composer input
  row (and footer row if it fits); H6 four columns with the strip; H7 calm
  cards: stripe in the task colour, head with › and ⋯, `.d-state` line with the
  owner-tone dot, chain chips with model glyphs; H9 wires as one SVG path per
  wire with rounded bends (or the existing segments plus corner pieces), drawn
  with `stroke-dashoffset` or the existing `scale` reveal, transforms and
  opacity only.
- `script()` (`:212-469`): same `AT` moments. The «fly» leaves from each tool
  row's icon (today from each chip's icon). Card faces change by layer opacity
  as today: Inbox face (head only) → In progress face (state line + chain) →
  Done face («PR #128 merged» + the ended chain line). The seat status dot and
  word cross-fade between «none yet», «waiting» and «working». The header's
  `● N` count and the In progress head's summary cross-fade with the state.
- Phone (`mode === "phone"`): the D2 screens and steps, built as layers; the
  finger taps the seat row, the dock, the tabs.
- `ICON` (`:53-63`) and `MARK` (`:64`): replace the bird mark in the header and
  seat with `Bot` and the costume avatar; add the D5 icons and glyphs with their
  source names in comments.

### 6.5 `landing/site/styles.css`

- Rewrite the hero block (`:197-394`) to the product's metrics: 48 px header,
  32 px controls, 8 px control radius and 12 px surface radius
  (`--radius-control`, `--radius-surface` in `tokens.css`), the 8 px state dot
  tones of `kanbanBoard.css:1919-1924`, the card stripe, the strip, the dot grid
  of the work column, the wire styles of `kanbanBoard.css:1888-1910`, and the
  cream primary button (`--color-brand` `#fbebdd`, text `--color-on-brand`
  `#262a36`); add `--d-codex: #6ba2e8` beside `--d-claude`.
- The phone rules (`:354-394`) become the D2 screens.
- `.demo[data-paused] .demo-stage *` keeps pausing the ambient motion.

### 6.6 `landing/site/build.ts`

- Write `dist/brand/role-orchestrator.svg` from `costumeSvg("orchestrator")`
  next to the existing brand copy (`:85-92`). One import, one write.
- Nothing else.

### 6.7 `landing/site/capture.ts`

- No new driver and no new mode. Update a selector only where the hero's hooks
  move (D6). The default run, `--check-demo`, `--check-conversation`,
  `--check-fullscreen` and `--check-swipe=after` are the evidence.

### 6.8 `landing/site/README.md`

- «How the hero's demo works»: four columns, the seat pane, calm cards, the
  phone's screens; the D3 and D4 departures and omissions; and a table of each
  drawn element with the product file it copies (§4.1 H1–H9, §4.2 P1–P7), so
  the next refresh starts from a checklist.

## 7. Acceptance for the build

From the pinned specification, made concrete:

- **Look and controls.** Each hero element H1–H9 and P1–P7 matches its product
  reference in `product-head/`, `product-head-noseat/` and
  `product-head-navfix/` (or the builder's fresh renders of the same views), en
  and uk, 1440 and 390; no drawn control is missing from the product; the D3
  and D4 departures are the only differences, and the README lists them.
- **Frames.** `capture.ts` (default) runs to the end in all four
  language/width runs, with no page errors and `overflowX` 0 in `report.json`;
  the run frame loads both tabs; no frame shows «no reason given», «Stopped ·
  N» or «Worked for 0s».
- **Holds.** `capture.ts --check-demo` passes: no long task during the loop, at
  most 1% dropped frames, plays only in view, stops on pause, in a hidden tab
  and off screen, still under reduced motion with all six captions, the
  pointer inside the stage, an empty board at 0 and nothing flying at `HOLD`.
  Baseline of today's hero on this machine (4× CPU throttle, under
  `gate-slot.sh`; the check passed): 1440×900, 1453 frames presented, 0
  dropped, 0 long tasks, longest task 6.2 ms, 0 layouts during the loop, cold
  load LCP median 220 ms; 390×844, 1453 presented, 0 dropped, 0 long tasks,
  longest task 10.5 ms, 0 layouts, LCP median 200 ms; 279.7 KB over 14
  requests at both widths. The redraw stays within the 1% and long-task
  bounds; more DOM is fine while the loop does no layout.
- **Tests.** `bun test landing/site/copy.test.ts landing/worker.test.ts` green
  (111 pass today).
- **Privacy.** The world and the hero carry invented names only; the hosted
  privacy gate passes; no media in the tree.
- **Required checks** green on the pull request.

## 8. Publication

The lane does not deploy. After merge the seat builds and publishes
(`landing/site/README.md`, «Worker configuration and publication»). Until this
lane merges, a republish from main would break the run section (S1), so the
seat should hold any landing publication until then.

## 9. Validation against the requirement

«фотки обновить на лендинге, потому что там старые»: every picture of the
product on the page is covered.

| Picture | Old because | After the plan |
| --- | --- | --- |
| The hero (desktop and phone) | drawn in the board's look before 2026-10-12, with a phone layout the product never had | redrawn to the current header, seat, chat, composer, columns, cards and phone screens (§4, §6.4–6.5) |
| Run frame (two tabs) | product of 2026-10-12; broken on head | current product; loads (S1, S2) |
| Open frame (four tabs) | product of 2026-10-12 | current product (S2) |
| Phone frame (three tabs) | product of 2026-10-12; a caption names buttons that left | current product; caption corrected (S2, S4) |
| States inside every frame | the world draws stalled cards and zero-second turns | calm, readable states (S3) |

Nothing in the plan adds a control, a page section or a driver.

## Deferred — not currently justified

- **The decision as a form in the seat's «Рішення» column** (#2758). The card
  still carries the decision and its «Answer», so the current story is true;
  showing the form would add a new scripted view to the frames.
- **Translating the tool-row titles in the product**
  (`src/lib/mcp/presentation.ts`). A real product gap, outside this lane's
  fence (`src/`); a task for the seat.
- **Answering the two endpoints the head bundle now asks for**
  (`GET /api/attention/done`, `GET /api/voice-companion/settings` on the phone).
  They show up in `report.json` and change nothing on screen.
- **Removing retired board prefs from the demo** (`taskPanelOpen`,
  `viewMode` at `demo.tsx:219`). The schema still accepts them and nothing
  reads them.
- **A check that delegatus.org matches main's build.** Publication is a seat
  step; §1 shows how to compare by hand in a minute.
- **Changing the stage sizes or the loop length.** The first-screen hold at
  1440×900 depends on them.
- **The real `Viewer` in the hero, or product components rendered to markup at
  build time** (D1 b, c).

## Notes

- The live site's own beacon writes were avoided by rendering a byte-for-byte
  local copy; the identity is proven by the md5 of every served file and by a
  rebuild of `aaf82e179`.
- At the time of writing remote `main` equals the lane's base `cfe9ae97b`; every
  line anchor above is at that commit.
