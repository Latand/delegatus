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
| 2 | The composer: the operator types the brief as a message and the Send button's own menu (`ComposerMenu`) offers «Run as a pipeline». | A chain of stage pills over the composer (`PipelineBlock`'s pills): a pill opens its role (the board's popover on the desktop, a sheet on the phone), «+» adds a stage, Enter starts. The typed message becomes the pinned task. |
| 3 | The task card's ⋯ menu: a row «Pipeline from conversation…» naming the conversation and its branch. Desktop: the card's compact menu; phone: the task screen's menu sheet. | A draft lane lands on the card (`PipelineBlock` at task density with dashed waiting pills) and Build's stage draft panel (`StageDraftPanel`) shows the brief from the conversation as the first message, editable in place; «Start» launches it. Phone: the pipeline screen (the stage list with roles, ⚙ opening Build's first message) with «Start pipeline» at its foot. |

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
template picker with the conversation in place of the repository field, the
strip over the composer with the block's own pills, the role rows in the
popover and the sheet, and the «Start» button (`btn primary`, the brand fill
on the phone). Stage names come from `stageDisplayName`, role names from
`roleNameById`, so both languages read the product's own words.

## Files

- `prototype.fixture.tsx`: the whole prototype. Query string:
  `?variant=1|2|3&frame=a|b&lang=uk|en&theme=light|dark`; the device follows
  the viewport width.
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
  (44 px under a finger, 24 under a pointer), the caption's height and the
  page errors.

```
LLV_CONVERSATION_BROWSER_TEST=1 CHROME_BIN=<chromium> \
  bun test src/components/conversation/conversationWindow.browser.test.tsx \
  -t "start pipeline from conversation prototype v2"
```

Run it in isolated state (private HOME, TMPDIR and `LLV_STATE_DIR`, the Viewer
control URL on a closed port) and through `scripts/gate-slot.sh`. Rendered
frames are not committed.
