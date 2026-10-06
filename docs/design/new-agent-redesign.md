# Creating a new agent: today's draft and three numbered looks

Design only. Nothing in this note ships: the three looks are prototypes that
only the kanban evidence fixture can install, and the product draws today's
draft exactly as before.

The operator's verdict (2026-10-06) keeps the orchestrator conversation, the
pipelines interface and the overall layout, and names the form for creating a
new agent as one of the surfaces to redo: "the menu for creating a new agent
looks crooked, especially when you press + Agent and it appears in a card".
This note lists what the form holds today, says what is crooked about it, and
offers three looks that keep every option and are built from the product's own
components.

## 1. Where a new agent is drafted

| Entry | Where |
| --- | --- |
| Header «+ Agent» | `src/components/ProjectBar.tsx:142`, the board's own button at `src/components/kanban/KanbanBoard.tsx:2777` |
| Header create menu (narrow widths) | `src/components/kanban/KanbanBoard.tsx:1354` |
| A task card's «+ Agent» | `src/components/kanban/KanbanCard.tsx:881` |
| The phone's menu row | `src/components/ProjectDashboard.tsx:2053`, drawn by `src/components/mobile/MobileFocusView.tsx:685` |
| The draft inside a card | `CardDrafts`, `src/components/kanban/KanbanDrafts.tsx:37` |
| Header «+ Task» | `src/components/ProjectBar.tsx:137`, composer at `src/components/kanban/KanbanDrafts.tsx:73` |
| A pipeline stage's draft message | `StageDraftMessage`, `src/components/kanban/StageDraft.tsx:70` |

Every agent draft, whichever entry opened it, is one component:
`DraftAgentPane` (`src/components/DraftAgentPane.tsx`). The three looks rearrange
that component, so each of them applies to the header button, a card's button
and the phone at once.

Two neighbours stay as they are. «+ Task» opens a task composer with a title
and a text and no runtime; it launches nothing. A stage draft
(`src/components/kanban/StageDraft.tsx:138` field, `:176` error, `:198` edit)
is a message to a stage whose engine, model and role were set in the pipeline
editor (`src/components/pipelines/StagePlaceholderPane.tsx:56`), and the
pipelines interface is one of the surfaces the operator keeps.

## 2. What the form holds today

Line numbers are for `src/components/DraftAgentPane.tsx` unless a file is named.

| # | Option | Control today | Where |
| --- | --- | --- | --- |
| 1 | Engine | three radios (Claude, Codex, Copilot) in the tinted header | `:935`; `EngineRadioGroup`, `src/components/draft/AgentLaunchControls.tsx:306` |
| 2 | Account | select at the header's left edge, cut to 112 px | `:933`; `LaunchAccountSelect`, `src/components/draft/AgentLaunchControls.tsx:353` |
| 3 | Model | select in the fourth strip | `:979`; `src/components/ReasoningControls.tsx:54` |
| 4 | Effort | select beside the model | `src/components/ReasoningControls.tsx:74` |
| 5 | Speed (Codex) | select beside the effort | `src/components/ReasoningControls.tsx:90` |
| 6 | Working folder | picker in the second strip | `:955`; `src/components/DirectoryPicker.tsx` |
| 7 | Task | the card the draft was opened from; the draft sits in that card | `src/components/kanban/KanbanDrafts.tsx:37` |
| 8 | Role | select in the third strip | `:965`; `RoleSection` `:162`, select `:192` |
| 9 | Role parameters | one select per parameter, each with a helper line | `:208` |
| 10 | Role prompt preview | a folded `details` | `:233` |
| 11 | Reviewer's conversation, deployer's confirmation | appear when the role asks | `:839`, `:859` |
| 12 | Handoff source | the heading says which conversation the draft continues | `:909` |
| 13 | Prompt | the shared composer's field | `:1027`; `src/components/ComposerBar.tsx` |
| 14 | Images | picker in the composer's second row, thumbnails under it | `src/components/ComposerBar.tsx:524`, `:819` |
| 15 | Voice | the composer's microphone | `src/components/ComposerBar.tsx` |
| 16 | Launch | the composer’s send button, tinted by the engine | `:887` |
| 17 | Cancel | a bordered 12 px cross at the header's right edge | `:942` |
| 18 | Errors | refused launch (`src/components/DraftLaunchStatus.tsx:27`), composer status (`src/components/ComposerBar.tsx:873`), a signed-out account with its sign-in route (`src/components/ComposerBar.tsx:829`), the image capability alert with Retry (`:867`) | |
| 19 | Launch in flight | the prompt as the operator's bubble and a status line | `:992` |

## 3. What is crooked

Read from the frames of look 0 (`look0-*.png`) at all three sizes.

1. **A card inside a card.** The pane has its own border, shadow, radius and a
   4 px engine-coloured bar, and it sits inside a kanban card that already has
   a border, a title («Untitled task») and a foot. Two frames, two titles.
2. **A fixed conversation height for an empty form.** The board gives a draft
   `--conv-in-card-h` (`src/components/kanban/kanbanBoard.css:1082`), about
   620 px. At 1440x900 the empty draft fills the column from top to bottom and
   roughly 300 px of it is a blank area with a centred hint. The prompt field,
   the one thing the operator came to fill, is the last thing on the card and
   lands under the fold at 1000x700.
3. **Four strips, four backgrounds.** Tinted header, sunken folder strip,
   bordered role block, sunken reasoning strip, then white. Each strip has its
   own divider and its own 10 px label, so the form reads as a stack of
   unrelated toolbars.
4. **The order follows the code.** Account, then a status dot, then the engine,
   then the title; the folder; the role; and only then the model, two strips
   away from the engine it depends on. The account is the first control and
   the one the operator changes least.
5. **Sizes that match nothing else.** The account select is cut to 112 px and
   shows «Account B · ac». The cancel button is a 12 px cross in a bordered
   box about 22 by 18 px, while the board's own icon buttons are 28 px and
   borderless. Labels are 10 px beside 11 and 12 px controls. Four corner radii
   meet in one card: 10, 8, 7 and 6 px. Inside the board the composer's
   microphone and launch button shrink to dots of about 14 px, a third of the
   size the same composer has in the orchestrator conversation, because the
   board's button reset reaches them.
6. **The engine radios are text on a tinted bar.** Unselected engines have no
   outline, so «Claude Codex Copilot new conversation» reads as one phrase.
7. **The composer repeats the card.** Under the field a chip says «new agent»,
   which the heading, the card title and the rail entry already say.
8. **The narrow column.** At 760 px the reasoning strip wraps, with the speed
   select alone on a second line, and the header truncates both the account
   and the heading. The phone does the same: the speed wraps under the model
   and the heading is cut to «ne…».
9. **A long prompt.** The field grows inside the fixed height and takes the
   room from the blank area, so the card stays 620 px whether the prompt is
   one line or twelve.
10. **A launch error** appears under the composer, at the very bottom of a
    620 px card, far from the folder or account that caused it.

One defect of behaviour, seen while driving the form and left alone in this
lane: pressing the engine that is already chosen leaves the draft's image
negotiation waiting for an answer nothing asks for again, and the image picker
stays disabled. The driver avoids that press. It deserves its own issue.

The 14 px buttons of point 5 have a one-class remedy whichever look is chosen:
the board's reset (`src/components/kanban/kanbanBoard.css:68`) spares whatever
sits inside `.reader-host`, the class a conversation in a card carries and a
draft does not. All three looks carry it.

## 4. Three looks

All three draw the same draft. `DraftAgentPane` keeps the state, the launch and
its recovery, and hands its parts to a layout
(`src/components/draft/draftLayout.ts`). The parts are the product's own:
`ComposerBar`, `EngineRadioGroup`, `LaunchAccountSelect`, `ReasoningControls`,
`DirectoryPicker`, `RoleSection`, `DraftLaunchStatus`. No look draws a control
of its own. Colours, type steps, radii and spacing are the existing tokens.

Three things are shared by every look.

- **The runtime grid.** Model, effort, speed and account are one grid of
  captioned cells of equal width. All cells stand on one row when a cell holds
  the widest chosen value whole, arrow included, and is at least 150 px, with
  the 6 px gaps between cells counted. The width a value needs is the
  browser's own: the grid reads it from a copy of the select that holds that
  one option. Otherwise the grid has two columns, so Codex reads as two rows
  of two and no select is left alone on a row. An odd last cell (Claude with
  an account) takes the whole row. Look 2 at 1000x700 is the case that
  decided this: its open «runtime» group gave each of four cells about 145 px,
  and «Account B · активний» lost its last letter under the arrow. The group
  now stands as two rows of two there.
- **The engine chips at the 32 px step** (`roomy`), the size the orchestrator's
  create panel uses. On the phone each chip's touch area is 44 px tall.
- **A caption over every field**: model, effort, speed, account, directory,
  role. The role block is `RoleSection` without its strip.

### Look 1. The composer is the card

The draft is the composer the orchestrator conversation already uses, as tall
as its content. A heading with a 28 px borderless close button; the prompt
field; the engine in the composer's own row, where the conversation keeps its
runtime; the runtime grid directly under the engine, so the model sits beside
the engine it depends on; then the thumbnails and any message of the composer;
the directory; the role. The card's second title and foot are gone. An empty
draft is about 300 px tall in place of 620.

On the phone the pane adds no heading, because the phone's own header already
says «New agent · draft». The settings gather above the composer, the close
button ends the engine row, and the composer stays on the bottom edge while the
settings scroll.

### Look 2. One line, opened where asked

The prompt field, and under it one row that says in words what the agent will
run on: «Codex · GPT-6-Astra · high · fast · Account B», the folder, the role.
The row never wraps: when it runs out, the runtime is cut with an ellipsis and
the folder and the role keep their words. The row is inside the composer's
frame, so the draft has no gutter of its own. It starts with the close button,
a rule and 24 px apart from the first word, and ends with the image picker,
which keeps the far right as it does in the orchestrator's composer. Closing
clears the draft without asking, so the close button stands away from the
picker, the microphone and the launch. Pressing a word opens that group's controls directly under
the row and nothing else; pressing it again folds them. The runtime group is
the engine chips over the runtime grid. A handoff draft names the conversation
it continues on a line above the field. An operator who accepts the defaults
sees a field and a sentence, about 110 px.

### Look 3. A sheet at the button

No card joins a column until an agent exists. The form opens as a sheet under
the button that was pressed (the header's, or a card's own «+ Agent»), beside
it when there is no room below, and never above the bottom edge of the board's
bar. The button stays marked as open while the sheet is. The sheet's heading
names the draft, and under it the task whose button opened it. Inside, a
captioned column that scrolls on its own: engine, the runtime grid, directory,
role. The composer is the sheet's foot: the prompt (five lines at most, then
it scrolls), the thumbnails, the launch and every error stay in the window
whatever the role adds above. When the column holds more than the window
shows, the foot gives room back (the prompt shows three lines) and the cut
edge says so: the fields fade out under a chip, «More fields below», that
scrolls to them when pressed, and the upper edge fades the same way once
something has scrolled above it. A role's parameters, or the deployer's
required field, are never cut without that sign. On the phone the same column
fills the pane.

## 5. Where each option is

| Option | Today (0) | Look 1 | Look 2 | Look 3 |
| --- | --- | --- | --- | --- |
| Engine | header strip | composer's row | «runtime» group; named in the summary | first field |
| Model | fourth strip | runtime grid, under the engine | «runtime» group; named in the summary | runtime grid |
| Effort | fourth strip | runtime grid | «runtime» group; named in the summary | runtime grid |
| Speed | fourth strip | runtime grid | «runtime» group; named in the summary | runtime grid |
| Account | header's left edge, cut | runtime grid | «runtime» group; named in the summary | runtime grid |
| Working folder | second strip | «Directory» field | «folder» word opens the picker | «Directory» field |
| Task | the card holding the draft | the card holding the draft | the card holding the draft | named under the sheet's heading; its button marked open |
| Role | third strip | «Role» field | «role» word opens the block | «Role» field |
| Role parameters, prompt preview | under the role | under the role | inside the «role» group | under the role |
| Reviewer's conversation, deployer's confirmation | under the role's parameters | the same | inside the «role» group | the same |
| Handoff source | heading | heading | a line above the field | heading |
| Prompt | bottom of the card | top of the card | the card itself | foot of the sheet |
| Images | composer | composer | composer | composer, in the foot |
| Voice | composer | composer | composer | composer |
| Launch | composer | composer | composer | composer, in the foot |
| Cancel | bordered cross, header | 28 px close, heading | 28 px close, start of the summary row, a rule apart from the words | 28 px close, heading |
| Refused launch | under the composer, bottom of the card | under the runtime grid | under the summary row and whatever it opened | foot of the sheet |
| Signed-out account and its sign-in | under the composer | under the runtime grid, next to the account | under the summary row | foot of the sheet |
| Image capability alert with Retry | above the composer | above the field | above the field | foot of the sheet, above the field |
| Launch in flight | bubble and status in the blank area | bubble and status above the field | the same | the same, in the foot |

### What is removed on purpose

| Element today | Where | Looks | Why it can go |
| --- | --- | --- | --- |
| The blank area's hint («Choose an engine and a directory, write the first prompt…») and the engine badge above it | `:1002` to `:1008` | 1, 2, 3 | The field's placeholder says the same in six words, and the blank area is gone with the fixed height. |
| The handoff hint («The new agent will first read the parent conversation's transcript…») | `:1007` | 1, 2, 3 | The seeded prompt of a handoff draft already says which file the agent reads. |
| The handoff source's path as a line of text | `:1009` to `:1013` | 1, 2, 3 | It stays as the tooltip of the line that names the source. |
| The «new agent» chip under the field, whose tooltip says whether the launch is structured or a tmux window | `:898` to `:903` | 1, 2; on the phone 1, 2, 3 | The heading, the rail and the placeholder say «new agent»; the placeholder also differs between the two kinds of launch. Look 3 keeps the chip on the desktop; on the phone it is gone in all three. |
| The card's own title («Untitled task») and foot around the draft | board | 1, 2 | Two titles for one draft. |
| The draft card itself and its fixed conversation height | board | 3 (card), 1 and 2 (height) | Look 3 seats no card; looks 1 and 2 are as tall as their content. |
| The 4 px engine-coloured bar and the status dot of the header | `:931`, `:934` | 1, 2, 3 | The chosen engine chip and the launch button carry the engine's colour. |

Nothing else is dropped. The driver asserts the table. For every look, at
every size, theme and language, it finds three engines, the model, effort,
speed and account selects, the folder picker, the role select with its three
parameters and prompt preview, the prompt field, the image input, the
microphone, the launch button, the cancel button and the refused launch. Once
per look it also finds the handoff source as visible text, the reviewer's
conversation select, the deployer's confirmation field, the signed-out message
with its sign-in button, and the image capability alert with Retry
(`evidence/new-agent-redesign/options.json`).

## 6. Costs

**Look 1.** The smallest change. `DraftAgentPane`'s render is rewritten, about
a hundred lines; the board's fixed height for a draft and the draft card's own
title and foot go; `RoleSection` gains a variant without its strip, which
`StagePlaceholderPane` must keep ignoring. `ComposerBar` gains a slot between
its options row and its thumbnails for the runtime grid (the prototype reorders
the composer's parts from a style block instead). Six short captions are new
strings in both languages. No new interaction. With a role chosen the card is
about 520 px tall, since the role block's helper lines are long; shortening
them is a change to the role catalog's copy.

**Look 2.** Everything look 1 needs, plus a disclosure with three groups: its
focus order, its keyboard handling, and summary strings in both languages. An
option costs one press more than today. A summary is only as good as its
longest value: at 760 px the runtime is cut after the effort, and the full
value is one press away.

**Look 3.** The largest change. A sheet needs placement, a focus trap, and a
rule for a press outside it that never loses a long prompt. The board loses the
draft card, so the «agents open» rail and the draft's persistence across a
reload need new rules. The sheet covers what is under the button while it is
open: under the header's button that is the right column of the orchestrator's
conversation, and beside a card's button it is part of the next column. It
changes nothing in either, and both are back when the sheet closes, but look 1
and look 2 cover nothing at all. At 1000x700 with a role chosen the field
column scrolls inside the sheet, and the sheet has to say so, which is one
more piece of chrome (the chip over the cut edge). In return the columns never move when a draft
opens.

**All three, on the phone at 320 px.** The phone draws its selects at 16 px.
In a two-column grid the account label is cut there: «Account B · active» by
18 to 26 px at 320 px, and «Account B · активний» by 9 to 17 px at 390 px and
by 44 to 52 px at 320 px, where the product's own «швидкість: дефолт» is cut
as well. The driver records each of these under `cut`; at 390 px in English
nothing is cut. One column would show them whole and leave every select alone
on its row.

## 7. Recommendation

Look 1. It answers each point of section 3 with the component the operator
already praised, keeps every option in sight, adds no interaction to learn, and
costs the least to ship. Look 2's summary row is the natural folded state of
look 1 for operators who launch on defaults: the same row the orchestrator's
conversation shows as «Opus 5.5 · Light». Look 3 solves a problem the operator
did not name (columns shifting) at the price of a new surface that lies over
others.

## 8. Evidence

The looks run in the existing kanban driver and fixture: the scenario
`new-agent` in `src/components/kanban/issue1695Evidence.fixture.tsx`, the
block «creating a new agent» in
`src/components/kanban/kanbanBoard.browser.test.tsx`. `?newagent=<n>` draws the
draft in look n, 0 being today's, and the page prints the number and the name
in a strip outside the application's frame.

```
CHROME_BIN=<chrome> LLV_KANBAN_BROWSER_TEST=1 NEW_AGENT_OUT=<dir> \
  bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "creating a new agent"
```

Each look is walked through seven states (empty, engine and model chosen, a
long prompt, an attachment, a refused launch with the long prompt and both
images still in place, the narrowest column, the draft a task card's own button
opens) at 1440x900, 1000x700 and a 390 px phone, light and dark, in English and
Ukrainian. Five more states are drawn once per look, at 1440 in the light
theme in English: a handoff draft, the reviewer's field, the deployer's field,
a signed-out account, and an image capability that could not be read. Look 3
adds one frame wherever its field column is cut (at 1000x700): the column after
the «More fields below» chip was pressed. That is 344 frames, one contact sheet per look beside today's form, and one sheet
comparing all four. The frames and sheets are written outside the repository
and are not committed.

Beside the options, the driver measures what the looks promise
(`geometry` in `evidence/new-agent-redesign/options.json`):

- looks 1 to 3, every size: four runtime selects, none alone on its row; on
  the desktop widths (1440, 1000, 760) no chosen value is cut by its select.
  A value is cut when the select is narrower than the browser draws the same
  select around that one value (`spare` is the smallest difference, in px,
  among the four). The earlier measure compared the text's width with the box
  less 16 px for the arrow, which is less than Chrome's arrow takes, and it
  passed the cut select of look 2 at 1000x700 in Ukrainian;
- look 1: the model starts within 28 px of the engine chips, and the refusal
  starts below the model;
- look 2: the three words of the summary share one row at 1440, 1000, 760 and
  on the phone;
- look 3: the sheet starts at or below the bottom edge of the board's bar and
  lies inside the window, and so do the launch button and the refusal, with
  the Builder role, the long prompt and two images; the sheet opened from a
  card names that card, and the card's button reports `aria-expanded`;
  whenever the field column holds more than it shows, the «More fields below»
  chip stands over the cut edge, above the foot and inside the window, and at
  1000x700 with the Builder role it has to be there; pressing it scrolls the
  column, and the upper edge then carries its own fade;
- looks 1 to 3, the desktop widths: the image picker is the last control of
  the composer's row, and the close button is on another row or at least
  24 px from it; look 2, every size: the close button is at least 24 px from
  the nearest summary word.

Limits of the prototypes: a look overrides the board's rules for a draft card
and the order of the composer's parts from a style block of its own, where a
shipped look would change those rules; the fixture refuses every launch, so
the frames show the refusal and no launch in flight; look 3's sheet has no
focus trap and no outside-press rule, and it reads the task's title from the
card it was opened from.
