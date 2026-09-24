# Interface polish, round 1 critique and the brief for round 2

Issue #2148. This is the critic's pass over round 1
(`docs/design/interface-polish.md`, patches under
`docs/design/interface-polish/`, renders in
`~/Pictures/delegatus-review/interface-polish/`). It judges each before/after
pair, names the skill rules round 1 applied timidly or skipped, lists what it
never saw, and ends with the ranked brief for round 2. Nothing here changes
product code.

Reviewed at lane HEAD `3045279c5`. Line numbers refer to that commit. The
skills were read from fresh clones of `github.com/jakubkrehel/skills` and
`github.com/jakubkrehel/make-interfaces-feel-better`.

## Verdict on round 1

Round 1 is careful and accurate, and it changes almost nothing a person would
see. The ranking rule, "visible gain per line of code", picked eight nits,
because the cheapest line is always a nit. Every structural finding the audit
did find (the duplicate jump tabs, the doubled chevron and ⋯ on a pipeline
card, concentric radius, press feedback) went to "deferred" as a product
decision. So the brief asked for bold changes and the deliverable held back
everything bold.

Pair by pair, judged at the size the operator sees them side by side:

| Pair | Screen | Change | Verdict |
|---|---|---|---|
| 01 | Board, desktop | Status pill tint → neutral with a dot | **Can't tell them apart at board scale.** You only see it zoomed in on one pill. The pill is still there and still repeats the column name. The cheapest fix under the cited rule ("delete before adding") was to remove it. |
| 02 | Conversation / orchestrator, phone | Boxed copy button → ghost | **Visibly better**, the best of the eight: three heavy squares leave each phone frame. It kept the blank band and the second copy button in the Bash card, and the copy box that floats outside the operator's bubble. |
| 03 | Pipeline + phone prose | `text-wrap: pretty` | **Can't tell them apart.** One word moves per paragraph. The real prose defect on desktop, a line of ~160 characters, was never measured. |
| 04 | Pipeline, desktop + phone | Model names mono → sans | **Barely visible.** The font was the wrong target. The pipeline screen shows each stage's model five times, and that repetition is the problem. |
| 05 | Task screen, phone | Chevron ends the pipeline head row | **Visible, but it fixes the wrong defect.** The row still reads "4m ago › ⋯": the pipeline head has no name, no state and no reason to exist as its own row. |
| 06 | Task card, desktop | "passed · pass" → "passed" | **Can't tell them apart.** |
| 07 | Orchestrator, phone | MCP row: indent dropped, one line | **Small but real.** It saves one line per MCP call. |
| 08 | Conversation, desktop + phone | Sentence case on controls | **Can't tell them apart**, except "down" → "Jump to latest". It left the loudest uppercase alone ("NEEDS YOU", "MCP · VIEWER"). |

Two of eight pairs pass a glance test (02, 05), and one of those fixes a
symptom. None of them changes hierarchy, density, card anatomy or colour load,
and those are what make these screens look busy.

### Rules applied timidly

- **better-interface: "delete, then use the platform, then reuse a token,
  then correct a value, and only then add".** Round 1 quoted it and then
  corrected values everywhere. The status pill in a column (01), the second
  copy button in a Bash card, the "Stage 1 of 3 · 3 in view" line and the
  jump tabs are all deletions it proposed as recolours or deferred.
- **better-writing: "delete every word that does no work".** It was applied
  to two words ("passed · pass"). The waiting Verify column, right beside
  them, says "not started yet" six times (change 3 below).
- **better-writing: one capitalization policy per element type.** It was
  applied to four catalog strings. The uppercase letter-spaced "NEEDS YOU",
  the mono uppercase "MCP · VIEWER" tool label and the "3." ordinal on every
  tool row were left alone.
- **make-interfaces-feel-better #12, scale on press.** Deferred on the
  grounds of "motion restraint on high-frequency interactions". That misreads
  the skill: rule 19 restricts *custom animation* such as row hovers,
  keystrokes and tab switches. A 0.96 press scale on a discrete button is the
  instant tactile feedback that rule recommends. The codebase has no press
  feedback at all (`grep active:scale src` finds nothing).
- **better-colors: fill exactly one action per view, one colour one meaning.**
  Applied to one pill. It never counted the whole frame. The phone composer
  gives its only filled accent shape to the model picker, while Send sits
  grey. The board's orchestrator bar puts an accent outline around a line
  that says "waiting".

### Rules skipped

- **better-typography: cap the measure (60–75 characters).** The desktop
  conversation reader sets agent prose across about 1000 CSS px, roughly 160
  characters a line (`08-before.png`; `FeedItem.tsx:161`, `:180` have no max
  width). This is the most visible typographic defect in the product, and
  round 1 never measured it.
- **better-layout: group with space, not lines; order by importance.** Never
  applied to card anatomy. A board card with a pipeline stacks title → rule →
  "4m ago ›" + ⋯ → chain → past attempts → footer, with two ⋯ menus and two
  chevrons at one trailing edge.
- **better-ui / make-interfaces-feel-better #4 and #6: interruptible
  transitions for open/close, subtle exits.** `KanbanCard.tsx`,
  `PipelineBlock.tsx` and `StagesSheet.tsx` have no transitions at all, so
  card expansion, the past-attempts disclosure and stage folding snap.
  Round 1 read motion from source only and did not list this.
- **better-writing: empty states say what the place is and give one next
  action.** It was not applied to the half-empty phone task and pipeline
  screens or to the waiting stage column.

### What the audit never named

In one line each; the ranked list below turns them into work.
**Hierarchy:** the pipeline sheet draws every stage three times (chip strip,
graph, columns) before any content. **Density:** a pipeline card spends a
whole row on "4m ago". **Spacing rhythm:** phone screens stack separate
rounded cards with equal gaps, so nothing groups. **Card anatomy:** there is
no single head row; the controls are duplicated. **Control weight:** a 44 px
action cluster heads every message, and the model picker outweighs Send.
**Colour load:** in the pipeline view, two gradient role frames, a green
column rule, a red loop chip, a violet Graph button and two violet Send
buttons all compete in one frame. **Empty/loading states:** the waiting
column is six captions, and half of each phone screen is blank. **Motion and
press:** none. **Phone ergonomics:** Send is not at the thumb edge.

## Ranked brief for round 2

P1 means the operator notices the change at a glance in a side-by-side. P2
means they notice it in use. P3 is cleanup that rides along. Cost: S is under
about 30 lines in one or two files, M is a component's markup plus its CSS,
L is a new layout. Each change names a skill rule. None touches screen-reader
semantics.

### P1

**1. Conversation reader, desktop: cap the prose measure.**
- *Now:* agent prose and the user bubble run the reader's full width, about
  1000 CSS px and ~160 characters a line at 1440×900 (`08-before.png`). The
  eye loses its place at every line break, and the message header's time and
  actions sit a screen-width away from the author.
- *Target:* prose blocks (`FeedItem.tsx:161`, `:180`) capped at about 68ch
  and left-aligned. The message header row is capped to the same width, so
  the read-aloud and copy controls end where the text ends. Tool cards and
  diffs keep the full width, because code needs it. Same cap in the
  orchestrator seat when it is unfolded wide.
- *Rule:* better-typography, "Cap the measure: 60–75 characters per line".
- *Cost:* S (two classes plus the header cap).

**2. Pipeline sheet, desktop: draw each stage once.**
- *Now:* before any content, every stage is drawn as a numbered nav chip
  (`StagesSheet.tsx:230-255`), as a graph node (`:263`) and as a column head,
  and each carries engine mark, model and effort bars. Counting the pane
  header and the composer's model control, a stage's model appears five
  times on one screen (`04-before.png`). The graph opens by default at 700 px
  and wider (`StagesSheet.tsx:85`).
- *Target:* while the graph is shown, it is the navigation: a node click does
  what a chip click does now (`reach`), and the chip strip is hidden. The
  strip returns only as the graph's collapsed form. Column heads keep number,
  name and state. The model shows once, in the pane header, plus the
  composer's picker, which is a control. The loop chip moves onto the graph's
  loop edge, where "fail · 0 of 3 used" already is. The screen gains about
  50 px and loses four repetitions per stage.
- *Rule:* better-interface, delete before adding and consolidate one root
  cause into one finding. better-layout, order by importance.
- *Cost:* M (`StagesSheet.tsx` markup, `kanbanBoard.css` nav rules).

**3. Waiting stage column: say "not started yet" once.**
- *Now:* the Verify column says it six ways: "runs when Review passes"
  (`en.ts:3533`), "Starts when Review passes · last stage" (`:3616`),
  "Waiting for stage start · not delivered" (`:3637`), "Nothing has been
  sent. Verify starts when Review passes, and its first turn opens with this
  message." (`:3622`), a composer placeholder "Opens when Verify starts · edit
  the message above" (`:3626`) and "Replies open when the stage starts."
  (`:3627`). The amber warning tint on one of them makes an ordinary wait
  look like a problem.
- *Target:* one line under the column head, "Starts when Review passes". The
  draft message stays as an editable card labelled "First message · not sent
  yet" in secondary text, never amber. The disabled composer and its note are
  removed until the stage starts, since there is nothing to reply to. The
  column goes from eight text blocks to three.
- *Rule:* better-writing, "Delete every word that does no work" and "Empty
  states say what this place is … and offer one clear next action".
  better-colors, one colour one meaning (amber means attention).
- *Cost:* S–M (catalog strings plus removing two nodes in the draft pane).

**4. Pipeline card anatomy, board and phone task screen: one head, one menu.**
- *Now:* when the pipeline title matches the task title it is hidden
  (`PipelineBlock.tsx:494`, `:512`), and "running" is dropped as implied
  (`:496`). The pipeline's head row is then just "4m ago ›", followed by a
  spacer and a second ⋯, under a divider rule. On the board that makes two
  chevrons and two ⋯ at one trailing edge (`01-card-before.png`). On the
  phone the head is a card of its own reading "4m ago … › ⋯" above the chain
  (`05-before.png`).
- *Target:* the stage chain is the pipeline's head: `Build → Review →
  Verify`, with the age trailing on the same row in muted text and the whole
  row opening the stages. There is no divider; 12 px of space separates it
  from the description. The pipeline's ⋯ actions move into the card's single
  ⋯ menu, in a "Pipeline" group. The past-attempts line folds into the chain
  row as a count ("↺ 1"). Each pipeline card gets about 40 px shorter, so an
  Assigned column shows about one more card per screen.
- *Rule:* better-layout, "Group with space, not lines", "Keep controls
  distinct from content", "Order by importance". better-interface, one entry
  point per action.
- *Cost:* M (`PipelineBlock.tsx` head, `KanbanCard.tsx` menu merge,
  `pipelineBlock.css`).

**5. Board column cards: remove the pill that repeats the column.**
- *Now:* round 1 recoloured it (patch 01), and it still reads "● Assigned ⌄"
  inside the Assigned column on every card. Card chrome also shows ⌄ and ⋯
  on every card at all times, which adds up to 2 × N icon controls on the
  board.
- *Target:* in column view the footer is `31m ago · ● 1 working · 2
  conversations · + Agent`, and the status menu moves into the card's ⋯ menu
  (drag between columns still works). Keep the pill in the list view and on
  the phone, where no column names the status. On `(hover: hover)` devices
  the ⌄ and ⋯ stay present but at the muted weight until the card is hovered
  or focused (`:hover, :focus-within`), so a still board stops reading as a
  grid of icons.
- *Rule:* better-interface, delete before adding. better-colors, "Fill
  exactly one action per view". better-accessibility (visible part), hover
  styling gated to `(hover: hover)` and a keyboard path for every pointer
  path.
- *Cost:* S–M (`kanbanBoard.css:285-294`, `KanbanCard.tsx` footer and menu).

**6. Phone conversation: move the message actions to where the message ends.**
- *Now:* every assistant message opens with a 44 px row, "✳ Claude · 20:04 ·
  🔊 · [copy]", with the controls pinned to the far right. The operator's
  bubble has its copy button floating outside its left edge
  (`07-before.png`, `02-orchestrator-before.png`; `FeedItem.tsx:150-210`).
  Controls are the first thing read on each message and weigh as much as the
  text.
- *Target:* the header is a single 20 px line, "✳ Claude · 20:04", in
  caption muted. Read-aloud and copy go to one quiet row after the last
  paragraph, as 16 px icons with 44 px hit areas extended by pseudo-elements.
  The operator bubble's copy goes under the bubble, trailing edge. Each
  message gets ~24 px shorter, and the right edge of the feed clears.
- *Rule:* better-layout, order by importance (content first, actions after).
  make-interfaces-feel-better #16, keep the 44 px hit area and extend the
  small visual with a pseudo-element.
- *Cost:* M (`FeedItem.tsx` message and bubble layout; the read-aloud
  anchoring in `data-tts-*` must keep working).

**7. Phone composer: Send at the thumb edge, the model picker neutral.**
- *Now:* the model pill "Opus 5.5 · low" is the only filled accent shape in
  the composer. Send sits grey in the middle of the row, at about 230–262 CSS
  px of 390 (`02-before.png`, `07-before.png`). `ComposerBar.tsx:435` gives
  the phone Send `ml-auto`, so the row it sits in apparently does not fill
  the width. That is inferred from the frame; round 2 must confirm it in the
  DOM.
- *Target:* Send ends the row at the trailing margin and turns filled accent
  when the field has text (it is the view's one primary action). The model
  picker uses the well background with secondary text, like the other
  composer tools. Attach and mic stay borderless.
- *Rule:* better-colors, "Fill exactly one action per view … one colour, one
  meaning". better-layout, controls in a consistent placement zone; phone
  primary action within thumb reach.
- *Cost:* S.

### P2

**8. Phone Bash card: one copy button, no blank band.**
- *Now:* `ToolCard.tsx:129` and `:149` reserve `min-h-[50px]` on coarse
  pointers for the command's copy button. That leaves an empty band under
  `$ bun test src/refunds`, and a second copy button stacks under the first
  beside the output (`02-before.png`).
- *Target:* one copy button in the card's header row beside the duration. It
  copies the command, and its menu (or a long press) copies the output. The
  command row collapses to its text height.
- *Rule:* better-interface, delete before adding. better-layout, group with
  space.
- *Cost:* S.

**9. Board: the folded orchestrator seat stops shouting.**
- *Now:* the folded seat is a full-width bar with an accent-violet outline,
  a ribbon, an avatar, "waiting", a panel icon and a bordered "Unfold"
  button, about 56 px of the board's top edge (`01-before.png`), saying
  nothing actionable. Below it the jump tabs repeat the column heads
  (`KanbanBoard.tsx:2365`).
- *Target:* when folded and not waiting on the operator, the seat is a 40 px
  quiet row with no outline: avatar, "Orchestrator · waiting", and a
  borderless chevron. The ribbon and accent outline return only when it
  needs the operator or is unfolded. The jump tabs move into the board header
  row beside "harbor-api · 2 working" as a compact segmented control, which
  frees one full row. They are still shown only in scroll mode.
- *Rule:* better-colors, accent means interactive, one colour one meaning.
  better-layout, order by importance. Note: the ribbon frame was approved by
  the operator on 2026-09-23. This keeps it wherever the seat is open or
  needs attention and only drops it from the idle folded bar.
- *Cost:* S–M (`roleFrames.css` seat rules for folded, `KanbanBoard.tsx`
  header).

**10. Pipeline sheet: colour load when three panes stand side by side.**
- *Now:* in one frame (`04-before.png`) there are an orange gradient ribbon
  frame, a blue gradient ribbon frame, a green top rule on the running
  column, green dots, a red loop chip, amber waiting text, a violet Graph
  button and two filled violet Send buttons.
- *Target:* inside the stages sheet only, panes use the approved `rail`
  variant (a 4 px role rail, emblem and name) instead of `ribbon`, and the
  running column's green top rule goes, since the dot and word already carry
  state. Ribbon stays the default everywhere a single conversation is open.
- *Rule:* better-colors, "Several colored backgrounds are fine when they
  encode distinct states … rather than competing as peers". Here they
  compete. make-interfaces-feel-better #3, borders for structure.
- *Cost:* S (a scoped `roleFrames.css` rule under the sheet). It touches an
  approved decision, so the operator should see it as its own pair.

**11. Press feedback and open/close motion.**
- *Now:* no button has press feedback. Card expand, the past-attempts
  disclosure, stage fold and graph toggle snap with no transition
  (`KanbanCard.tsx`, `PipelineBlock.tsx`, `StagesSheet.tsx` contain no
  `transition`).
- *Target:* `active: scale(0.96)` with `transition: scale 120ms ease-out` on
  discrete buttons (Retry/Skip, Send, + Agent, Resume, sheet actions), never
  on cards, rows or tabs. Disclosures animate height through `grid-template-rows:
  0fr → 1fr` in 180 ms `cubic-bezier(0.2, 0, 0, 1)`, interruptible. Sheets
  exit with an 8 px `translateY` and opacity, softer than they enter. All of
  it is off under `prefers-reduced-motion`.
- *Rule:* make-interfaces-feel-better #12 (scale on press, exactly 0.96),
  #4 (interruptible transitions for open/close), #6 (subtle exits), #14 (name
  the properties, no `transition: all`), #19 (motion restraint; row hovers
  and tabs stay instant).
- *Cost:* S–M (one shared class plus three disclosure wrappers). Evidence
  must be a short screen recording; a still cannot show it.

**12. Phone task and pipeline screens: fill the screen with the stages.**
- *Now:* the task screen shows the chain as three chips inside a card headed
  "4m ago", then a Description card, an Agents card and a Past attempts
  card, each a separate rounded block with equal gaps. The bottom 45 % of the
  screen is empty (`05-before.png`). The phone pipeline screen has the
  richer stage list (numbered rows, state, "Open conversation"), and 50 % of
  it is empty too, with "Attach PR or issue…" alone at the trailing edge as
  bare accent text (`04-phone-before.png`; `PipelineBlock.tsx:789`).
- *Target:* the task screen embeds the pipeline screen's stage list in place
  of the chip chain, with the running stage's "Open conversation" row, so the
  common next tap is on the first screen. Description and Agents group under
  one section with 8 px inside and 24 px between groups. "Attach PR or
  issue…" becomes a list row with a link icon at the leading edge.
- *Rule:* better-layout, "Group with space … gaps between groups at least
  twice the gap within one", "Keep controls distinct from content", order by
  importance.
- *Cost:* M (`MobileTaskScreen.tsx` composes `MobilePipelineCard`).

### P3

**13. Finish the capitalization and font pass round 1 started.**
- *Now:* "NEEDS YOU 1" is uppercase and letter-spaced. The MCP tool label is
  mono uppercase "MCP · VIEWER". Tool rows carry an ordinal ("3.") that
  nothing refers to. The pipeline sheet has a "Stage 1 of 3 · 3 in view"
  status line whose information the nav chips already show.
- *Target:* "Needs you · 1", "Delegatus · Listing pipelines" in the UI font,
  no ordinals, and the status line deleted. The role ribbons' small caps are
  part of the approved frame and stay.
- *Rule:* better-writing, one capitalization policy per element type.
  better-typography, fewer fonts (mono is for code).
- *Cost:* S.

**14. Card surfaces: elevation by shadow, concentric corners.**
- *Now:* board cards carry both a 1 px border and `--shadow-1`
  (`kanbanBoard.css:213`), inside a well column of the same 12 px radius
  with about 10 px of inset (`:142`), so the corners are not concentric.
- *Target:* in dark mode the card's border becomes the skill's single 1 px
  white ring at 8 % as a box-shadow. The column's corners follow outer =
  inner + padding (about 22 px). If the two-radius token contract must hold,
  drop the column's own radius and background so the cards alone carry the
  shape.
- *Rule:* make-interfaces-feel-better #1 (concentric radius) and #3 (shadows
  for elevation, borders for structure).
- *Cost:* S; it needs the operator to rule on `tokens.css:38`.

## What round 2 must deliver

- Every P1 gets a side-by-side that passes a glance test at the size the
  operator views it: whole-frame pairs at 1440×900 and 390×844. A crop of
  one pill does not count. A pair that only reads when zoomed in is a failed pair.
- Motion (change 11) gets a short recording, before and after.
- Same capture method as round 1: seeded invented home, production build,
  isolated `HOME`/`TMPDIR`/config root, never port 8898 or live state. Rasters
  only in `~/Pictures/delegatus-review/interface-polish/round2/`.
- Changes 9, 10 and 14 touch decisions already made (the approved ribbon
  frame, the two-radius contract). Present each as its own pair the operator
  can take or leave.
- Not proposed: a web font (brand decision, as round 1 said), and the
  sidebar's permanent RAM/usage meters (information density the operator
  chose; a later `variant` run can test it).
