# Start a pipeline from this conversation: prototype v2

Screens for the flow in `docs/design/pipeline-from-conversation.md`, redone
after the first prototype (`docs/design/pipeline-from-conversation/prototype/`)
was rejected on 2026-10-26. Three numbered variants of the one decision that
changes what gets built: **where the action lives** and **how the stages are
chosen**. Each is drawn by the product's own components over invented data
and carries its numbered caption inside the frame. No product code changes.

| Variant | Where the action lives | How the stages are chosen |
|---|---|---|
| 1 | The conversation's ⋯ menu: a row «Start pipeline» whose hint says the brief and the branch come from this conversation. Desktop: the reader's compact menu; phone: the conversation's sheet. | The existing «New pipeline» template picker (`PipelineTemplatePicker.tsx`): the conversation and its branch stand where the repository field was, the status line says what was taken from it, and a template row (Plan → Build → Review, Build → Review, Build → Verify, blank canvas) drops the lane on the card. |
| 2 | The composer: the operator types the brief as a message and the Send button's own menu (`ComposerMenu`) offers «Run as a pipeline». | A chain of stage pills over the composer (`PipelineBlock`'s pills): a pill opens its role (the board's popover on the desktop; on the phone the composer's own menu, the one its Send button opens, standing above the strip so the chain and the Send button stay in view), «+» adds a stage, and the Send button now reads «Start pipeline» (Enter on the desktop). The typed message becomes the pinned task. |
| 3 | The task card's ⋯ menu: a row «Pipeline from conversation…» naming the conversation and its branch. Desktop: the card's compact menu; phone: the task screen's menu sheet. | A draft lane lands on the card (`PipelineBlock` at task density with dashed waiting pills) and the builder stage's draft panel (`StageDraftPanel`) shows the brief from the conversation as the first message, editable in place; «Start» launches it. Phone: the pipeline screen (the stage list with roles, then the first message with Edit) with «Start pipeline» at its foot. |

Each variant is two frames: **a**, where the action lives; **b**, how the
stages are chosen. Every frame is one viewport (1440×900 or 390×844), in en
and uk, light and dark.

## What is the product and what is new

Drawn by the product's own components: `KanbanBoard` with its cards, agent
window and reader, the reader's and the card's ⋯ (`BoardMenu`, compact
layout), `MobileShell`, `BranchPane`, `MobileConversationMenu`,
`MobileTaskScreen`, `MobilePipelineScreen`, `ComposerMenu`, `KanbanPopover`,
`MobileSheet`, `PipelineBlock` and `StageDraftPanel` (reached by pressing the
real stage pill of a draft lane).

New, drawn with existing primitives and classes: one tall row in each compact
menu (`cm-tall` with its hint), one `MobileSheetRow` in each phone sheet, the
template picker with the conversation in place of the repository field (its
state dot and word come from the helper the header behind it reads:
`mobileRowState` on the desktop, `chatStateBits` on the phone), the strip over
the composer with the block's own pills, the role rows in the popover and in
the composer's menu (the menu's rows are its checkbox kind; the implementation
gives it a radio kind, as the desktop popover's rows are), the words «Start
pipeline» beside the Send button's arrow, the phone's first-message section
under the stage list, and the «Start» button (`btn primary`, the brand fill
on the phone).

The chain is the «Build → Review» template as the product creates it: each
stage id is its role id (`deriveStageId`), so `stageDisplayName` names the
stages by role in the operator's language («Білдер → Рев'юер»), and the
review's fail edge returns to the builder stage. The product's own conversion
of a review loop adds a third stage whose id (`reviewer-fix`) it can only
humanize in English; a lane created from a conversation should name that
stage in the operator's language, or draw the loop as this prototype does.

Four rules in `prototype.css` are product fixes the implementation carries
into `kanbanBoard.css` and `ComposerBar.tsx`: the draft bubble reserves room for its Edit pill on
the first line only (the product's 64 px gutter on every line covers the
first line of a Ukrainian brief under «Змінити» and wraps every other line
about 100 px early), the board's popover gets a destructive row colour, and
the board's filled primary button takes the accent with a canvas label in the
dark theme, as every other filled primary action does (`darkControls.css`),
instead of the cream brand slab, and the composer menu's rows keep the 44 px
floor under a finger (a one-line hint leaves them 43.6 px).

Two things the product does today and this prototype leaves: the phone
conversation sheet offers «Interrupt current turn» whenever the host is alive,
a finished turn included (the row is the product's `MobileConversationMenu`,
unchanged); and the Send menu opened over the desktop composer stands over the
transcript's last lines, as every menu over a transcript does. On the phone
the prototype opens that menu over the composer's top edge, so the typed brief
stays readable while the operator chooses.

## Files

- `prototype.fixture.tsx`: the whole prototype. Query string:
  `?variant=1|2|3&frame=a|b&lang=uk|en&theme=light|dark`; the device follows
  the viewport width. The product's controls a frame opens (a ⋯, a fold, a
  stage pill) are pressed by the driver with a real pointer; opened by hand,
  add `&press=self` and the fixture presses them itself.
- `prototype.css`: the product's `globals.css` plus this directory as a
  Tailwind source.

## Rendering

The conversation-window driver renders it, in the block «start pipeline from
conversation prototype v2» of
`src/components/conversation/conversationWindow.browser.test.tsx`: it compiles
`prototype.css`, serves the fixture through the shared evidence harness and
writes to `.artifacts/start-pipeline-from-conversation-v2/`:

- `variant-<n><a|b>-<desktop|phone>-<uk|en>-<light|dark>.png`: one frame each;
- `review/variant-<n>-<desktop|phone>-<uk|en>-<light|dark>.png`: the two
  frames of a variant in one image (phone side by side, desktop stacked);
- `readings.json`: for every frame, the text of every new element checked
  against the viewport and its clipping ancestors, the new controls' sizes
  (44 px under a finger, 24 under a pointer), whether anything covers the
  strip's words, whether the composer shows the whole brief, whether a
  dialog's scrim stands over the window, whether any line or drawn leaf of
  the transcript is cut under the window header (and how the fixture aligned
  the transcript: the tail trimmed by the cut, or extended by a spacer that
  pushes the cut row out when the feed's bottom room was short; the feed pins
  itself to its tail, so it is never scrolled against), the dialog's state
  dot tone, the caption's height and the page errors.

```
LLV_CONVERSATION_BROWSER_TEST=1 CHROME_BIN=<chromium> \
  bun test src/components/conversation/conversationWindow.browser.test.tsx \
  -t "start pipeline from conversation prototype v2"
```

Run it in isolated state (private HOME, TMPDIR and `LLV_STATE_DIR`, the Viewer
control URL on a closed port) and through `scripts/gate-slot.sh`.
`LLV_PROTO_FRAMES=2b-phone-uk,3b-desktop` renders only the frames whose name
contains one of the terms and keeps the rest of the directory. Rendered
frames are not committed.
