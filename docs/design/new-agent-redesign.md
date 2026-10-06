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
| 1 | Engine | three radios (Claude, Codex, Copilot) in the tinted header | `:936`; `EngineRadioGroup`, `src/components/draft/AgentLaunchControls.tsx:306` |
| 2 | Account | select at the header's left edge, cut to 112 px | `:934`; `LaunchAccountSelect`, `src/components/draft/AgentLaunchControls.tsx:353` |
| 3 | Model | select in the fourth strip | `:980`; `src/components/ReasoningControls.tsx:54` |
| 4 | Effort | select beside the model | `src/components/ReasoningControls.tsx:74` |
| 5 | Speed (Codex) | select beside the effort | `src/components/ReasoningControls.tsx:90` |
| 6 | Working folder | picker in the second strip | `:956`; `src/components/DirectoryPicker.tsx` |
| 7 | Task | the card the draft was opened from; the draft sits in that card | `src/components/kanban/KanbanDrafts.tsx:37` |
| 8 | Role | select in the third strip | `:966`; `RoleSection` `:162`, select `:192` |
| 9 | Role parameters | one select per parameter, each with a helper line | `:208` |
| 10 | Role prompt preview | a folded `details` | `:233` |
| 11 | Reviewer's conversation, deployer's confirmation | appear when the role asks | `:837`, `:862` |
| 12 | Handoff source | the heading says which conversation the draft continues | `:909` |
| 13 | Prompt | the shared composer's field | `:1028`; `src/components/ComposerBar.tsx` |
| 14 | Images | picker in the composer's second row, thumbnails under it | `src/components/ComposerBar.tsx:524`, `:819` |
| 15 | Voice | the composer's microphone | `src/components/ComposerBar.tsx` |
| 16 | Launch | the composer’s send button, tinted by the engine | `:887` |
| 17 | Cancel | a bordered 12 px cross at the header's right edge | `:945` |
| 18 | Errors | refused launch (`src/components/DraftLaunchStatus.tsx:27`), composer status (`src/components/ComposerBar.tsx:873`), a signed-out account with its sign-in route (`src/components/ComposerBar.tsx:829`), the image capability alert with Retry (`:867`) | |
| 19 | Launch in flight | the prompt as the operator's bubble and a status line | `:993` |

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

### Look 1. The composer is the card

The draft is the composer the orchestrator conversation already uses, as tall
as its content. A heading with a 28 px borderless close button; the prompt
field first; the engine and its account in the composer's own row, where the
conversation keeps its runtime; then model, effort and speed tiling one row
edge to edge; the folder; the role. The card's second title and foot are gone,
and so is the «new agent» chip. An empty draft is about 190 px tall in place
of 620.

### Look 2. One line, opened where asked

The prompt field, and under it one row that says in words what the agent will
run on: «Codex · GPT-6-Astra · high · fast · Account B», the folder, the role.
Pressing a word opens that group's controls under the composer and nothing
else; pressing it again folds them. An operator who accepts the defaults sees
a field and a sentence, about 90 px.

### Look 3. A sheet at the button

No card joins a column until an agent exists. The form opens as a sheet under
the button that was pressed (the header's, or a card's own «+ Agent»), beside
it when there is no room below. Inside, a labelled column in the manner of the
orchestrator's create panel: engine, account, reasoning, folder, role, then the
composer at the foot. On the phone the same column fills the pane.

## 5. Where each option is

| Option | Today (0) | Look 1 | Look 2 | Look 3 |
| --- | --- | --- | --- | --- |
| Engine | header strip | composer's row | «runtime» group; named in the summary | first field |
| Account | header's left edge, cut | beside the engine | «runtime» group; named in the summary | second field, full width |
| Model | fourth strip | row under the composer | «runtime» group; named in the summary | «Reasoning» field |
| Effort | fourth strip | same row | «runtime» group; named in the summary | «Reasoning» field |
| Speed | fourth strip | same row | «runtime» group; named in the summary | «Reasoning» field |
| Working folder | second strip | its own row, folder icon | «folder» word opens the picker | «Directory» field |
| Task | the card holding the draft | the card holding the draft | the card holding the draft | the button the sheet hangs from |
| Role | third strip | row under the folder | «role» word opens the block | «Role» field |
| Role parameters, prompt preview, reviewer and deployer fields | under the role | under the role | inside the «role» group | under the role |
| Handoff source | heading | heading | heading on the phone; the pane’s tooltip on the desktop | heading |
| Prompt | bottom of the card | top of the card | the card itself | foot of the sheet |
| Images | composer | composer | composer | composer |
| Voice | composer | composer | composer | composer |
| Launch | composer | composer | composer | composer |
| Cancel | bordered cross, header | 28 px close, heading | 28 px close beside the field | 28 px close, heading |
| Errors | under the composer, bottom of the card | under the composer, above the settings | under the composer | under the composer |
| Launch in flight | bubble and status in the blank area | bubble and status above the field | the same | the same, above the composer |

The driver asserts this table. For every look, at every size, theme and
language, it finds three engines, the model, effort, speed and account
selects, the folder picker, the role select with its three parameters and
prompt preview, the prompt field, the image input, the microphone, the launch
button, the cancel button and the launch error
(`evidence/new-agent-redesign/options.json`).

## 6. Costs

**Look 1.** The smallest change. `DraftAgentPane`'s render is rewritten, about
a hundred lines; the board's fixed height for a draft and the draft card's own
title and foot go; `RoleSection` gains a variant without its strip, which
`StagePlaceholderPane` must keep ignoring. No new interaction, no new strings.
Its weak spot: thumbnails and a launch error appear between the engine row and
the model row, because both belong to the composer. With a role chosen the
card is still about 500 px tall, since the role block's helper lines are long;
shortening them is a change to the role catalog's copy.

**Look 2.** Everything look 1 needs, plus a disclosure with three groups: its
focus order, its keyboard handling, and summary strings in both languages. An
option costs one press more than today. A summary is only as good as its
longest value: a long account label or folder path truncates. The desktop
heading is gone, so a handoff draft names its source only in a tooltip, which
a shipped version would have to fix.

**Look 3.** The largest change. A sheet needs placement, a focus trap, and a
rule for a press outside it that never loses a long prompt. The board loses the
draft card, so the «agents open» rail and the draft's persistence across a
reload need new rules. The sheet covers part of the board, and a draft opened
from a card is tied to it only by position. In return the columns never move
when a draft opens.

## 7. Recommendation

Look 1. It answers each point of section 3 with the component the operator
already praised, keeps every option in sight, adds no interaction to learn, and
costs the least to ship. Look 2's summary row is worth keeping in mind as a
later folded state of look 1 for operators who launch on defaults. Look 3
solves a problem the operator did not name (columns shifting) at the price of
a new surface.

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
long prompt, an attachment, a refused launch, the narrowest column, the draft a
task card's own button opens) at 1440x900, 1000x700 and a 390 px phone, light
and dark, in English and Ukrainian: 320 frames, one contact sheet per look
beside today's form, and one sheet comparing all four. The frames and sheets
are written outside the repository and are not committed.

Limits of the prototypes: a look overrides the board's rules for a draft card
from a style block of its own, where a shipped look would change those rules;
the fixture refuses every launch, so the frames show the refusal and no launch
in flight; look 3's sheet has no focus trap and no outside-press rule.
