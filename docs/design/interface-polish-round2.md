# Interface polish, round 2: bolder changes, prototyped and rendered

Issue #2148, round 2. This document ranks twelve prototyped changes. Each one
is a patch under `docs/design/interface-polish-round2/` with a before/after
render. The brief for round 2 is the critique of round 1
(`docs/design/interface-polish-critique.md`). Nothing here changes product
code: the operator picks what gets built.

**Status (2026-09-25): built.** The operator took all twelve changes for the
1.5.0 release, including the four decisions listed below. They are product
code now, with the pipeline-screen half of critique #12. "Built" at the end of
this document says where the build departs from the patches, which stay here
as the prototype record.

## Originating requirement

Pinned specification of this lane (pipeline 2520afe0, recorded 2026-09-24;
the operator's verdict on round 1 is recorded there as a paraphrase):

> Issue #2148, round 2. Round 1 (lane 5ca29571, this branch) read the eleven
> skills of github.com/jakubkrehel/skills and make-interfaces-feel-better,
> audited the board, task card, conversation, pipeline and orchestrator panel,
> and delivered docs/design/interface-polish.md with 8 ranked changes as
> patches under docs/design/interface-polish/ and before/after pairs in
> ~/Pictures/delegatus-review/interface-polish/. Operator verdict, paraphrased:
> it made far too few changes (each is a 1-8 line CSS or copy tweak: pill
> tint, ghost copy button, text-wrap, mono font on model names, one alignment,
> capitalization, one chevron, one repeated word); run another critic on those
> changes.
>
> Round 2 must produce a visibly better interface, not nits: the difference
> must be obvious in a side-by-side at a glance. Changes may be structural
> (layout, hierarchy, density, component shape, motion and interaction feel
> per make-interfaces-feel-better), still grounded in a named skill rule each,
> still only visible interaction (no screen-reader work). Same capture method
> as round 1 (seeded demo home with invented data, production build, isolated
> HOME/TMPDIR/config root, never port 8898 or live state). Rasters only in
> ~/Pictures/delegatus-review/interface-polish/round2/, never in the repo; the
> repo gets docs/design/interface-polish-round2.md and
> docs/design/interface-polish-round2/*.patch (plus a README). No product
> change on the branch: the operator picks what gets built.

This stage's assignment (same date, same lane):

> Take its P1 items and the strongest P2 items (8-12 changes), prototype each
> as a patch in a scratch copy, and capture before/after at 1440x900 and
> 390x844 into ~/Pictures/delegatus-review/interface-polish/round2/
> (NN-before.png, NN-after.png, NN-pair.png). Also capture one combined 'all
> changes applied' before/after for the board and the conversation. Read every
> render yourself; drop or redo any change whose after is not obviously
> better. Write docs/design/interface-polish-round2.md (ranked table: what,
> rule, cost, files, patch) and the patches. No product code on the branch.

## Prior work

- Round 1 (`docs/design/interface-polish.md`) and its critique
  (`docs/design/interface-polish-critique.md`) are the direct inputs. The
  critique's numbering (1–14) is kept here, so patch `NN` is critique change
  `NN`.
- `search_transcripts` found nothing earlier on a reading measure for the
  reader, on the role-frame rail inside the Stages sheet, or on the card's
  status pill. The only hit was the kanban port's side-by-side check against
  the prototype, which did not decide the pill.
- `docs/design/desktop-flat-cards.md` (variant B, the card this board draws)
  kept "the footer's status pill" and a visible pipeline ⋯. Changes 04 and 05
  below reverse those two, so they are listed as decisions for the operator.
- The labelled Fold/Unfold button on the orchestrator seat is a decision of
  #1802 ("the operator must find it without hunting"). Change 09 keeps the
  label and only drops its border while the seat is folded and quiet.
- The ribbon role frame was approved on 2026-09-23. Change 10 keeps it
  everywhere except inside the Stages sheet.

## How the renders were made

The method is round 1's. Its scratch export and capture driver were still on
disk and were reused unchanged:

- The scratch export under `/var/tmp` is byte-identical to this lane's product
  code. `git ls-tree` of every path outside `docs/` matches lane HEAD.
- The capture driver (never committed) seeds the README demo home
  (`scripts/readme-demo-state.ts`) plus an invented `harbor-api` orchestrator
  seat. It serves a production build (`next build --webpack`) on an OS-assigned
  port with `HOME`, `TMPDIR`, `XDG_CONFIG_HOME` and `LLV_STATE_DIR` all under
  `/var/tmp`, and captures with Chrome through playwright-core at device scale
  2 in the dark scheme. Port 8898 and the operator's state were never touched.
- Each change has its own scratch branch: lane HEAD plus exactly that one
  patch, built on its own. Its "after" frames come from that build. The
  "before" frames come from the untouched base build. Each run seeds a fresh
  home, so relative ages ("31m ago") match between the two frames, while clock
  times ("21:28") and live timers differ by the minutes between runs. Those
  differences come from timing alone.
- "All changes applied" is lane HEAD plus every patch in numeric order, built
  once. All twelve patches stack without conflict.
- Change 11 is motion, and a still cannot show it. Its evidence is a 1440×900
  screen recording, before and after, from the same seeded home.

## The ranked changes

Ranked by how much the operator sees change in a side-by-side at the size the
pair is viewed, then by cost. P1 and P2 are the critique's labels. Cost is the
critique's scale: S is under about 30 lines in one or two files, M is a
component's markup plus its CSS. Line counts are added and removed lines of
the patch. Every patch applies to lane HEAD on its own, and all twelve apply
in numeric order.

| Rank | # | What | Rule | Cost | Files | Patch |
|---|---|---|---|---|---|---|
| 1 | 12 | **Phone task screen: the stages are on it.** A live pipeline shows its numbered stage list: who runs each stage, the current stage's report and **Open conversation**. Before, it was a card headed only by "4m ago" over three chips, and the lower third of the screen was empty. The "Stages 3 · 4m ›" line opens the pipeline screen and carries the lane's ⋯. A finished pipeline keeps its one-row chain. | better-layout: order by importance; keep controls distinct from content (P2 #12) | M, 59+ 6− | `PipelineBlock.tsx`, `pipelineBlock.css`, `MobileTaskScreen.tsx` | `12-phone-task-screen-stage-list.patch` |
| 2 | 02 | **Stages sheet: each stage is drawn once.** While the graph is shown it is the navigation (a node reaches its column, as a chip did). The chip strip and its loop chip return only when the graph is hidden. The column heads drop engine, model and effort, which the conversation header right under them already shows. "Stage 1 of 3 · 3 in view" goes, and Collapse finished, Expand all and ‹ › move into the sheet's head row. The stage columns start about 77 CSS px higher. | better-interface: delete before adding, one root cause one fix; better-layout: order by importance (P1 #2) | M, 24+ 13− | `StagesSheet.tsx`, `kanbanBoard.css` | `02-each-stage-drawn-once.patch` |
| 3 | 05 | **Board: no status pill inside a column, quiet card icons.** A card in the Assigned column no longer says "Assigned ⌄". Its menu is the card's ⋯ ("Move to"), the S key opens it there, and dragging still moves the card. On a device with hover, the fold ⌄ and ⋯ rest at 35 % and come up on hover or focus. The list view and the phone keep their pills. | better-interface: delete before adding; better-colors: fill one action per view, one colour one meaning; better-accessibility: hover styling gated to `(hover: hover)` with a keyboard path (P1 #5) | S, 14+ 2− | `kanbanBoard.css`, `KanbanBoard.tsx` | `05-no-status-pill-in-columns.patch` |
| 4 | 01 | **Desktop reader: prose at a reading measure.** Agent answers are capped at 68ch (about 60–78 characters a line, down from about 160), and the header row sits inside the cap, so the time, read-aloud and copy end where the text ends. The operator's bubble is capped the same way. Tool calls and diffs keep the full width. | better-typography: cap the measure at 60–75 characters (P1 #1) | S, 9+ 3− | `FeedItem.tsx`, `UserMessageRow.tsx` | `01-prose-measure.patch` |
| 5 | 10 | **Stages sheet: the rail frame on its conversations.** Inside the sheet only, the orange and blue gradient rings and ribbon labels become the approved `rail` variant: a neutral border with a 4 px role rail on the left and the role's name in its ink. The running column's green top rule goes; its dot and word say "running". Amber and red top rules stay. | better-colors: colours that compete as peers; make-interfaces-feel-better #3: borders for structure (P2 #10) | S, 20+ | `roleFrames.css`, `kanbanBoard.css` | `10-rail-inside-stages-sheet.patch` |
| 6 | 03 | **A waiting stage says it once.** The Verify column loses the disabled composer ("Opens when Verify starts · edit the message above"), its note ("Replies open when the stage starts.") and the paragraph under the message ("Nothing has been sent…"). The column's "runs when Review passes" line gives way to the draft's fuller "Starts when Review passes · last stage". The amber "Waiting for stage start · not delivered" becomes a muted "First message · not sent yet". | better-writing: delete every word that does no work, an empty state says what the place is; better-colors: amber means attention (P1 #3) | S, 10+ 17− | `StageDraft.tsx`, `StagesSheet.tsx`, `kanbanBoard.css`, `en.ts`, `uk.ts` | `03-waiting-stage-says-it-once.patch` |
| 7 | 09 | **Board: the folded orchestrator strip goes quiet.** Folded, with no answer owed and no unread reply, the strip drops its fill, its accent ring and its ribbon, and aligns with the board's edge. The labelled Unfold button stays (#1802) without its border. The frame comes back the moment the seat needs the operator or opens. The jump tabs become one light row of text tabs. | better-colors: accent means interactive, one colour one meaning; better-layout: order by importance (P2 #9) | S, 16+ 1− | `kanbanBoard.css` | `09-quiet-folded-seat.patch` |
| 8 | 04 | **Board card: the stage chain is the pipeline's head.** The "4m ago ›" row, its second ⋯ and the rule above it go. The age and the way into the stages trail the chain on the same row, and the pipeline's actions become a group in the card's single ⋯. The card is 31 CSS px shorter. On the phone the lane keeps its own row and menu (see "Redone"). | better-layout: "Group with space, not lines", keep controls distinct; better-interface: one entry point per action (P1 #4) | M, 82+ 48− (mostly moved markup) | `PipelineBlock.tsx`, `pipelineBlock.css`, `KanbanCard.tsx`, `KanbanBoard.tsx` | `04-lane-head-is-the-chain.patch` |
| 9 | 06 | **Phone messages: content first, controls after.** The 44 px header row with the time and two targets becomes a one-line caption, "✳ Claude · 20:10". Read-aloud and copy follow the text as quiet 44 px targets. The operator's copy moves under the bubble. The copy button loses its border, fill and shadow (round 1's patch 02, folded in here because the moved row depends on it). Cost: each agent message is about 20 CSS px taller and each operator message about 32 px taller, measured on the seeded orchestrator (the critique expected shorter). | better-layout: order by importance, content before actions; make-interfaces-feel-better #16: 44 px targets (P1 #6) | M, 23+ 17− | `FeedItem.tsx`, `UserMessageRow.tsx`, `CopyButton.tsx` | `06-phone-message-actions-after-text.patch` |
| 10 | 07 | **Phone composer: Send at the thumb edge, the model chip neutral.** Send ends the tools row. Its `ml-auto` sat on the button inside a shrink-wrapped span, so it had no space to take; the span now carries it (read from source and confirmed in the render). The model chip drops the accent fill for the card surface and secondary text, like the other tools. | better-colors: fill one action per view; better-layout: a consistent placement zone within thumb reach (P1 #7) | S, 6+ 2− | `ComposerBar.tsx`, `RuntimePill.tsx` | `07-phone-send-at-thumb-edge.patch` |
| 11 | 11 | **Press feedback and open/close motion.** Discrete buttons (Retry, Skip, board buttons, + Agent, Send) scale to 0.96 while pressed. Past attempts and "Added when it starts" open and close by height in 200 ms, interruptibly. The Stages sheet rises 8 px and fades in. All of it is off under reduced motion. Cards, rows, tabs and chips stay still. | make-interfaces-feel-better #12 (0.96 on press), #4 (interruptible), #14 (named properties), #19 (restraint on frequent targets) (P2 #11) | S, 39+ 5− | `kanbanBoard.css`, `pipelineBlock.css`, `globals.css`, `ComposerBar.tsx` | `11-press-and-open-close-motion.patch` |
| 12 | 08 | **Phone Bash card: no blank band.** On a coarse pointer the command's copy target moves to the end of the meta row ("✓ exit 0 · 22:15:28–22:15:49 · copy"), and the command block shrinks to its text: the 50 px band #1978 reserved is gone. The output keeps its own copy target, so the card still has two; one control with a menu was not built (see Deferred). | better-interface: delete before adding; better-layout: group with space (P2 #8) | S, 13+ 5− | `ToolCard.tsx` | `08-phone-bash-card-one-copy-row.patch` |

Critique P1 #1–#7 are all here (01–07), and so are P2 #8–#12 (08–12). P3 #13
and #14 are deferred below.

### Decisions this puts in front of the operator

- **04 and 05 reverse two choices of `desktop-flat-cards.md` variant B**, the
  card the board draws: variant B kept "the footer's status pill" and a visible
  pipeline ⋯.
- **10 replaces the approved ribbon** inside the Stages sheet only. The ribbon
  stays on every single open conversation, the seat and the phone.
- **09 hides the ribbon and ring on the folded seat** while it is quiet. The
  #1802 label on the fold button is kept.
- **06 trades phone density for reading order**: about 20 CSS px per agent
  message. Taking 06 without its operator-bubble half saves 32 px per operator
  message and keeps the copy target beside the bubble.

## The renders

Everything is in `~/Pictures/delegatus-review/interface-polish/round2/`. For
change `NN`, `NN-before.png` and `NN-after.png` are full frames of its primary
screen (2880×1800 for 1440×900, 780×1688 for 390×844). `NN-pair.png` is the
two side by side, desktop pairs at half scale so a pair fits one screen. A
second screen uses a screen infix. Every frame and pair named here was opened
and read.

| # | Primary pair | Also | Viewport(s) the change touches |
|---|---|---|---|
| 01 | reader, desktop | `01-orchestrator-*` (seat) | desktop only (the phone branch is untouched) |
| 02 | Stages sheet, desktop | | desktop (the phone has its own pipeline screen) |
| 03 | Stages sheet, desktop | `03-column-pair.png` (the Verify column, full resolution) | desktop |
| 04 | board, desktop | `04-card-*` (the card alone) | desktop; the phone is unchanged by 04 |
| 05 | board, desktop | `05-card-*` | desktop |
| 06 | conversation, phone | `06-orchestrator-*` (seat, phone) | phone |
| 07 | conversation, phone | `07-orchestrator-*` | phone |
| 08 | conversation, phone | | phone |
| 09 | board, desktop | | desktop |
| 10 | Stages sheet, desktop | | desktop |
| 11 | `11-pair.mp4` (both recordings side by side), `11-before.webm`, `11-after.webm`, and `11-pair.png`, a frame strip of Past attempts opening at 40 ms a frame | | desktop |
| 12 | task screen, phone | | phone |

**All changes applied.** `all-<screen>-{before,after,pair}.png` is lane HEAD
against HEAD plus all twelve patches, captured back to back, for every screen:
`all-board` and `all-conversation` (desktop), `all-board-phone` and
`all-conversation-phone`, plus `all-pipeline`, `all-orchestrator`,
`all-orchestrator-phone`, `all-task-phone`, `all-card` and
`all-pipeline-phone`. The phone board list (`all-board-phone`) is identical
before and after, because no patch touches it. The phone's board change is the
task screen one tap away (`all-task-phone`).

What each pair shows, in one line, read at the size of the pair:

- **12:** a screen that was half empty now carries the three stages, the
  running stage's report and "Open conversation".
- **02:** two strips (the chip strip and the "Stage 1 of 3" bar) are gone. The
  columns start under the graph, and their heads read "1. Build · Builder ·
  passed".
- **05:** four tinted pills (amber, violet, red, green) leave the board, and
  the ⌄/⋯ grid fades.
- **01:** two 160-character lines become a readable column.
- **10:** the two heavy gradient boxes become thin role rails.
- **03:** the Verify column drops a composer box and two notes, and nothing in
  it is amber.
- **09:** the violet-framed strip becomes a quiet line, and the tabs lighten.
- **04:** the card loses its "4m ago › ⋯" row and a rule. Visible in the card
  pair, smaller on the whole board.
- **06:** the message starts with its text, and three boxed copy buttons are
  gone. The feed is taller.
- **07:** the violet chip goes grey, and Send moves to the right edge.
- **11:** only the recording shows it (numbers under Verification).
- **08:** the blank band under the command is gone. The smallest of the twelve.

## Redone after reading the renders

Nothing was dropped. Four changes were redone because the first render was not
clearly better, and the renders above are of the redone versions:

- **02.** The first version removed the chip strip, but the lane bar still
  spent a whole row on "Collapse finished · Expand all · ‹ ›". Those moved into
  the sheet's head. Under 700 px the head wraps them onto a second line.
- **04.** The first render had the age stop short of the card's edge, because
  a hover-only graph toggle (invisible, 26 px) followed it. The toggle now
  comes first, so the chevron ends the row. The second render showed the phone
  worse: the chain, the age and the phone lane's 44 px ⋯ did not fit 390 px, and
  "Verify" wrapped onto its own line. The chain now becomes the head only where
  the lane's actions have moved into the card's ⋯ (the desktop board). On the
  phone the lane keeps its row, and change 12 replaces that block for live
  pipelines anyway.
- **09.** The quiet strip first stayed centred at the seat's 1040 px maximum
  while the board spans the full width. It now aligns with the board's edge.
- **11.** The first recording showed Past attempts still opening in a single
  frame. A minimal page in the capture Chrome (151) showed why: it animates
  `::details-content` height on a block `<details>` and not on a flex one, and
  the history `<details>` was flex. The column and its 4 px gap moved into the
  content box, and the second recording animates. Side effect: a closed Past
  attempts is 4 CSS px shorter, since the empty flex gap under its summary is
  gone.
- Also found while rendering: captures of the phone task screen showed its
  agent count and list vary ("1 agent" or "2 agents") between runs of the same
  build, depending on whether the finished Build conversation had loaded. The
  12 pair was recaptured until both frames agreed. The seeded home loads that
  conversation late on some runs, with or without a patch.

## What the patches change that tests pin

The unit and DOM suites were not run. This stage only writes patches, and the
lane that builds a change runs its suite. These are the tests that read the
old markup or text, found by searching the test files:

- 02: `KanbanStages.dom.test.tsx` and `kanbanBoard.browser.test.tsx` click
  `[data-nav-stage]` chips and read `.gs-nav .ploop`. The chips exist only with
  the graph hidden now, and happy-dom's default width opens the graph.
- 03: `KanbanStages.dom.test.tsx:369–370, 482` and the browser test read the
  old status text and the disabled `.composer2`.
- 04: `KanbanStages.dom.test.tsx` opens the pipeline menu through
  `[data-pipeline-menu]` on the card, and `KanbanPipelines.dom.test.tsx` reads
  `.pb-head` and `.pb-open`. On the board both now live in the card's ⋯ and the
  chain row.
- 05: `KanbanBoard.dom.test.tsx:142, 186` click the card's `.pill`. It is still
  in the DOM, hidden by CSS, which happy-dom does not apply. The focus-after-move
  fallback reads `getClientRects()`, which is empty in happy-dom, so a test that
  expects focus on the pill after a move will see the card focused.
- 06: `FeedItem.mobile.dom.test.tsx` reads `[data-mobile-message-header]` and
  the controls inside it.
- 07: `ComposerBar.mobileUnit.dom.test.tsx` reads `[data-mobile2-send]` (the
  button is unchanged; its wrapper moved).
- 08: `issue1671Evidence.browser.test.tsx` (#1978) measures the copy target
  against the command block at 390×844.
- 12: `MobileTaskScreen.dom.test.tsx` and `MobileTaskScreen.entry.dom.test.tsx`
  read `[data-phone-task-lane]` and its `.pb-*` children, which are now the
  screen-density list for a live lane.

## Deferred: not currently justified

- **Critique P3 #13, the capitalization and font pass** ("NEEDS YOU", mono
  "MCP · VIEWER", tool ordinals). Round 1's patch 08 covers part of it. None of
  it passes a glance test.
- **Critique P3 #14, elevation by shadow and concentric corners.** It needs a
  ruling on the two-radius contract (`tokens.css:38`) first.
- **Jump tabs inside the board's header bar** (critique #9, second half). The
  header's responsive rules (`docs/design/board-header.md`) make that a
  layout change of its own. 09 only restyles the tabs.
- **Past attempts folded into the chain row as "↺ 1"** (critique #4). Past
  attempts belongs to the card and spans its pipelines, so it cannot become one
  lane's count without a model change.
- **One copy control with a menu for the output** (critique #8). That is a new
  control. 08 only removes the blank band.
- **Seen in the renders and left for later:** with 01, an MCP call row in the seat
  still runs to the full width, so its time sits far right of the capped text.
  The graph canvas in the Stages sheet keeps a blank band under its nodes. The
  sheet has no exit animation, because it unmounts on close. Card expand and
  collapse snap, because they mount and unmount.

## Verification

- **Builds.** Each change was built on its own (lane HEAD plus that patch) and
  the combined tree once, with `next build --webpack`, which includes the
  TypeScript check. All passed. The "after" frames of 02, 04, 11 and 12 come
  from their final builds, after the redos above.
- **Patches.** `git apply --check` passes for each patch against lane HEAD.
  All twelve applied in order to an export of lane HEAD give a `src/` tree
  byte-identical to the combined tree that was built and captured.
- **Change 11 in numbers,** from the 25 fps recordings. The Retry button is
  210–212 px wide in every frame before. After, it passes 206 px and holds
  200–202 px while pressed (0.96 of 210 is 202). Past attempts moves the card
  below it in one frame before, and over four frames (about 160 ms) after,
  410 → 423 → 435 → 438 → 441 px. A second click mid-way reverses from where it
  is. The sheet's entrance is in the recording and was not measured.
- **Change 07.** The phone Send's `ml-auto` is on the `<button>`, and the
  button's parent is the `inline-flex shrink-0` anchor span (`ComposerBar.tsx`
  sendControl). The span is the tools row's flex item, so the margin had no free
  space to take. This was read from source. The after frame shows Send at the
  trailing edge.
- **Not verified.** The suites (see above). The light scheme. Hover and focus
  states in a browser: 05's quiet icons were seen at rest, never hovered. The
  S-key and focus fallback of 05 in a browser. The sheet head wrapping under
  700 px (02), which was not rendered. The read-aloud highlight on the phone
  (06): from source, the old phone control sat outside its message's
  `data-tts-message` anchor, so `karaokeRoots` found no text, and the patch puts
  it inside. That was not exercised with audio.

## Built

All twelve changes are product code, reconciled with main as it stood after
the board order (#2156) and task colour (#2155) changes. Main moved under two
of the patched files (`FeedItem.tsx`, `ToolCard.tsx`), and every patch still
applied. The build departs from the patches where main or a closer reading
asked for it.

### Where the build differs from the patch

- **01.** The measure is one class (`src/components/feed/measure.ts`), used by
  the settled answer, the live answer row and the operator's typed and voice
  bubbles. The patch left the live row at full width, so an answer would have
  narrowed the moment its transcript echo replaced it.
- **02.** The head's second line starts below 1024 px, not 700 px. The desktop
  layout runs down to 640 px, and at 820 px the one-row head left the title
  40 px (rendered, see Evidence). Below 1024 px only the lane's controls take
  the second line. The title and the progress keep the first line, grow to at
  most their own width and ellipsize, so the state chip stays beside the
  title.
- **03.** The build also removes what 03 and 02 left without a caller. That
  is seven i18n keys in both languages (`kanban.draft.noteAfter`, `noteFirst`,
  `composerAria`, `composerPlaceholder`, `composerNote`, `send`, and
  `kanban.stages.inView`), plus the closed composer's CSS (`.composer2`), the
  lane bar's `.pos` and `.lane-count` rules and the sheet's `firstInView`
  state (critique-2's note).
- **04.** A pipeline on no task has no card menu, so its lane keeps its own ⋯
  and its head row. The patch would have left it with no way to its actions.
  The card's menu also keys its items by position, because each lane repeats
  "Expand stages", "Pause" and the rest.
- **05.** The pill is gone from the card's markup, and `kanban.statusAria`
  went with it. The patch had only hidden it with CSS. After a move, focus
  lands on the moved card, so `[`, `]`, S and M keep working. S opens the
  status menu at the card's ⋯.
- **06.** The ghost copy control keeps a transparent 1 px border, because the
  22 px fine-pointer size the gutters are cut to counts it. The outbox's
  pending spinner holds the same slot until the message is confirmed. It takes
  the same ghost look and the same place under the bubble, so nothing moves
  when the copy control replaces it. The voice turn's bubble follows the
  typed one.
- **07.** The `ml-auto` on the phone's Send button, which never took any
  space, is gone; its span carries it.
- **08.** One command copy control, placed by the pointer query
  (`useCoarsePointer`, which the gutters already follow). The patch drew two
  controls and hid one with CSS. On a finger the meta row's bottom margin grows
  by the target's overhang, so the 44 px target ends where the command begins.
  On a mouse, a command with no status or time draws no empty meta row.
- **09.** A failed seat counts as needing the operator, the folded side rail
  keeps its frame, and the quiet Unfold keeps a hover state.
- **10.** A folded conversation in the sheet keeps the ribbon's content box.
- **11.** All of the motion lives inside `prefers-reduced-motion:
  no-preference`, beside the rules it moves. The patch added it and then
  switched it off in `globals.css`. The Past attempts layout moves into
  `::details-content` only where the browser supports that pseudo-element.
  While a button is held at 0.96, an invisible layer keeps its whole unpressed
  box. Without it, a held press 1 px inside the edge of a 212 px Retry lands
  beside the button (measured, see Evidence). Desktop Send uses the same rule
  through a `.press-scale` class.
- **12.** The embedded lane draws no empty links row, which had left a blank
  band under the task's title.

### Critique #12, the pipeline-screen half

Critique-2 noted that this half was left undone and not deferred. It is built:

- The phone pipeline screen's "Attach PR or issue…" is a list row after the
  stages, with a link at its leading edge and a chevron at its end, shaped like
  the screen's Past attempts row. It used to be bare accent text beside the
  heading. The link chips stay under the heading, and with no link there is no
  empty row.
- The phone task screen groups what it holds. The stages, what agents ask,
  the task (links, description, agents) and its history (details, Past
  attempts) sit 24 px apart, with 8 px between the rows inside each group.
  The title stays 12 px above the first group.

### Tests

- `KanbanBoard.dom`: no pill on a column's card; S opens the status menu from
  the card's ⋯; a move from the ⋯ writes with the guard and focus follows the
  card. `OverviewBoard.kanban.dom` reads "Move to" from the ⋯.
- `KanbanStages.dom`: the lane's actions are a group in the card's ⋯, and the
  lane draws no ⋯. With the graph shown there is no chip strip and a node
  reaches a folded pane; with it hidden the chips return. The lane's controls
  sit in the head, the column heads draw no identity, and a waiting stage has
  no sub-line, composer or note, with the new status words.
- `PipelineBlock.dom`: the chain is the head where the card's ⋯ holds the
  actions; a lane with its own ⋯ or title keeps its head row.
- `FeedItem.mobile.dom`, `FeedItem.actions.render`: caption, text, then
  controls on the phone. The read-aloud control still finds its text there.
  The operator's copy sits under the bubble. The desktop sets prose at the
  measure.
- `actionGeometry.dom`: one command copy control, in the gutter for a mouse,
  and at the end of the meta row and 44 px for a finger.
- `MobileTaskScreen.dom`, `MobileTaskScreen.entry.dom`: a live lane is its
  numbered stage list with "Open conversation", its Stages line opens the
  pipeline screen and its ⋯ the lane sheet, a finished lane keeps its chain,
  and the groups sit 24 px apart and 8 px inside.
  `MobilePipelineScreen.dom`: Attach is a row after the stages and opens the
  links sheet.
- The kanban browser driver (`kanbanBoard.browser.test.tsx`) gains the
  "interface polish round 2" case, run in Chrome. It covers the press near
  the edge with its red path, reduced motion, Past attempts by height and its
  mid-way reversal, the sheet's entrance, the status menu at the ⋯, the quiet
  tools on hover and focus, and the sheet head at 640, 820 and 1100 px.
  Readings are in `evidence/interface-polish/readings.json`. The driver's
  older cases that read the pill, the lane's ⋯, the chip strip, the draft
  composer and the pane-head identity are updated to the new markup.

### Evidence

Everything is in `~/Pictures/delegatus-review/interface-polish/build/`. The
"before" frames come from main at the branch point, the "after" frames from
the branch head. Both are production builds (`bun run build`, isolated config
and state roots) served over the same seeded demo home by round 2's capture
driver, which is a scratch script and not committed. Each `NN` pair shows its
change's primary screen with every change applied, so pairs that share a
screen share frames: 02, 03 and 10 are the Stages sheet, 04, 05 and 09 the
board, 06, 07 and 08 the phone conversation. Every pair was opened and read.

- `02-660-pair.png` and `02-820-pair.png` are the sheet head under 1024 px
  (critique-2's note). At 660 px the graph starts hidden, so the chips are the
  navigation.
- `03-column-pair.png` is the Verify column at full resolution.
- `12-pipeline-pair.png` is the phone pipeline screen with the Attach row.
- `11-before.webm`, `11-after.webm` and `11-pair.mp4` are the recordings.
  `11-pair.png` is Past attempts opening at 40 ms a frame: in one frame
  before, and over about 120 ms after.
- The after frames match round 2's after, with one difference: main's board
  order (#2156) now puts the card whose stage is running first in Assigned.

The browser case measured the motion in Chrome. Past attempts goes 22, 38,
88, 121, 141, 155, … 185 px, one frame at a time; clicked again at 80 ms, it
turns at 141 px and settles closed. The sheet's opacity runs 0, 0, 0.1, 0.41,
0.82 … 1 over its first frames. Under reduced motion, both are whole in the
first frame and nothing scales.

