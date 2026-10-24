# Start a pipeline from this conversation: prototype

Screens for the flow in `docs/design/pipeline-from-conversation.md`, in three
numbered variants of the one decision that changes what gets built: where the
pipeline works and who does the first stage. No product code changes.

| Variant | What happens | The checkout | Build stage |
|---|---|---|---|
| 1 | Keep this conversation's branch and worktree | `fix/csv-export-retry` in `worktrees/csv-export-retry`; the 3 uncommitted files stay in place; the conversation is read-only while the pipeline holds the checkout | a new agent |
| 2 | A fresh branch from the conversation's last commit | new `pipeline/csv-export-retry` from commit `4e1c9a2`; the 3 uncommitted files stay behind; the conversation keeps working in its own branch | a new agent |
| 3 | The current agent becomes the Build stage | the conversation's own branch and worktree | this agent, in this conversation |

Review and Fix are new agents in every variant. Each variant is one strip of
four screens, with one plain Ukrainian sentence under each:

1. The conversation's ⋯ menu with the new row «Запустити пайплайн» / «Start
   pipeline»; the row's second line already names the variant.
2. The preview while the source agent is still in its turn: it waits, the brief
   is not taken yet, and the button says so.
3. The preview once the turn ended: the editable brief taken from the
   conversation, where the lane works (branch, checkout, uncommitted files),
   the stages Build → Review → Fix with who runs each, and local-only
   publication.
4. The board: the task card's lane, with a line that links it back to the
   conversation and says what became of the conversation.

## What is the product and what is new

Drawn by the product's own components over invented fixture data:

- desktop: `KanbanBoard` with its cards, the agent window and its reader
  (`KanbanReaders.tsx`, `BranchPane`, the real feed and composer), and the
  reader's ⋯ (`BoardMenu`, compact reader layout); screen 1 opens it by
  pressing the reader's own ⋯, screen 4 unfolds the card with its own control;
- phone: `MobileShell`, `BranchPane`, `MobileConversationMenu`, `MobileSheet`
  and `MobileKanban`;
- the lane: `PipelineBlock` inside those cards, from a fixture `Pipeline`.

New, drawn with existing primitives and classes:

- the menu row: the compact menu's tall row with its hint line on the desktop,
  a `MobileSheetRow` on the phone, inserted into the real menu;
- the preview: the pipeline template picker's dialog shell on the desktop
  (`PipelineTemplatePicker.tsx`), wider for the brief; a `MobileSheet` with its
  footer on the phone; stage chips as the template picker draws them;
- the lane's link line under the lane row.

The stage names come from the product (`stageDisplayName`), so the preview and
the board name Build, Review and Fix the same way in both languages. Project,
tasks, conversation, branch, commit and file names are invented.

## Files

- `prototype.fixture.tsx`: the whole prototype. Query string:
  `?variant=1|2|3&screen=1..4&lang=uk|en&theme=light|dark` draws one screen at
  the window's size; `?strip&variant=…&device=desktop|phone&lang=…&theme=…`
  draws the four screens, each in its own frame at its real viewport (1440×900
  or 390×844), with the captions; `&w=820` checks an in-between width.
- `prototype.css`: the product's `globals.css` plus this directory as a
  Tailwind source.
- `frames/`: the rendered strips, ignored by git.

## Building and rendering

The fixture builds with the evidence fixture builder the browser drivers use,
from a checkout with dependencies installed:

```
bun src/components/kanban/buildEvidenceFixture.ts \
  docs/design/pipeline-from-conversation/prototype/prototype.fixture.tsx <out>
```

Compile `prototype.css` with `@tailwindcss/postcss` into `<out>/style.css`, add
an `index.html` that links `style.css`, holds `<div id="root">` and loads
`prototype.fixture.js` as a module, and serve `<out>` over local HTTP. Every
`/api/` read is answered inside the page, so no Viewer runs.

Each frame is a full-page headless Chromium screenshot of a strip URL, with the
viewport as tall as the strip (frames outside the viewport are throttled and
draw half-loaded screens), time zone Europe/Kyiv, reduced motion, colour scheme
matching the theme. Names: `frames/variant-<n>-<desktop|phone>-<uk|en>-<light|dark>.png`.

Before each capture the text of every new element, menu, dialog and sheet was
checked in every screen frame: no text range outside the viewport or cut by a
clipping ancestor, no ellipsis, the brief textarea never scrolls, every new
control at least 24 px (44 px on a coarse pointer) and clear of its
neighbours, and each screen's defining element on its first screen.
