# Launching an agent without layout jumps

Operator, 2026-10-02: fix the sag in speed and the confusion in what renders when an agent is launched,
and what changes when an orchestrator is created.

A QA run of a launch on the live Viewer read a cumulative layout shift of 0.25 to 0.73 per launch
(Chrome's layout-shift entries, input-explained shifts excluded). This note names the sources and what
each fix does. The numbers come from the kanban rendered-evidence driver
(`kanbanBoard.browser.test.tsx`, "launch layout shift"), which runs the real Viewer over the fixture's
`launch-cls` scenario: a draft opened from the bar, a first prompt sent, and the page left alone until the
turn ends. Records: `evidence/launch-render-polish/cls-before.json` and `cls-after.json`.

## Desktop sources and fixes

1. **The open-agents rail appeared at the launch** and pushed every column 200 px. A draft now stands in
   the rail from the moment it opens ("New agent · not sent yet"), so the strip is already there when
   the launch turns the draft into a conversation. Opening the draft is the operator's own input.
2. **The draft card and the launched card were in different columns.** A draft no task holds was drawn
   under "Not on a task" in Inbox; the launch writes a task in Assigned, so the card hopped columns and
   moved every card in both. The draft is now drawn at the top of Assigned (`holdsOnlyDrafts`).
3. **Two commits at the hand-off.** The draft was removed, and a poll later the task card appeared. The
   draft now stays until the card holding the launched conversation is on the board and is replaced in
   the same commit (`launching` in `KanbanBoard.tsx`, five seconds at most).
4. **The reader grew with every row.** It sized to its content, so its composer and every card below it
   moved on each streamed chunk. A launched reader keeps the height of the draft it came from
   (`launchedConversations.ts`); a reader the operator opens on the board sizes to content as before.

5. **A second draft beside a live agent.** A draft is as tall as a reader, so drawn above an agent being
   read in Assigned it pushed that agent wholly below the window. With a reader open in a card in Assigned
   the draft stays in Inbox, beside it (`openReaders` in `kanbanModel.ts`); otherwise it stands at the top of
   Assigned as above.
6. **The hand-off scrolled the column.** Opening the launched card's reader scrolled Assigned until the
   reader's foot was in view, which put the card's head (and the first-prompt title) under the column header.
   The hand-off now leaves the column where it is while the card's head is in view (`landing` in
   `KanbanBoard.tsx`). The driver records the column's scroll position across the hand-off, since the
   layout-shift metric does not count a scroll.

## Creating an orchestrator

The driver's second case (`?scenario=seat-create-cls`) creates the seat from a new project's draft on the same
clock. Records: `evidence/launch-render-polish/seat-cls-before.json` and `seat-cls-after.json`.

- **The draft came back for a few frames.** Once the seat's reply arrived, the confirm let go of its
  submitting state before the durable read had said where the seat landed, so the panel drew the short draft
  again and then the live seat at 75% of the window: the board jumped up and back down (0.30 at 1440).
  `useSeatConfirm` now keeps the submitting state until that read is in.
- The composer's runtime pill is recorded from its first frame and must read the chosen effort in every
  frame (it read the engine's lowest tier first before the provisional window carried the effort).
- The mandate bubble's own hand-over shifts the phone by 0.096; it is the first-bubble lane's (#2006, #2415)
  and is read apart in the record (`clsWithoutMandate`).

## Phone

The phone swaps the draft screen for the conversation when the launch is adopted. The strip that names the
conversation's task arrives a poll after the pane and pushed the whole feed 53 px down. The pane now holds
that strip's row for a conversation this page launched (`launchedConversations.ts`), so the strip lands in
a place that was already there. The hand-over of the focused pane across the provisional-to-scanned path
change (the phone showing the previous conversation) belongs to the mobile launch focus lane and is not
touched here; the fixture leaves nothing waiting on the operator, so its fallback focus stays on the launch.

## Labels and names

- The model row is labelled "model" ("модель"), not "reasoning".
- The `haiku` alias reads "Haiku 4.5" everywhere, like the resolved id after a reload.
- The provisional launch window carries the chosen model, effort and speed, so the composer pill does not
  read the engine's lowest tier first and jump to the server's value (the "Light" to "High" flip).
- A launch admitted with its first prompt shows that prompt as the card's title at once; the agent's
  refinement still replaces it.
- Markdown `-`, `*` and `+` items draw as bullet rows.

## Not changed here

The orchestrator mandate bubble that vanishes while the card says it needs the operator is the hand-over
of the seat's first message, owned by the #2006 lane (`fix/first-bubble-no-raw-json`).
