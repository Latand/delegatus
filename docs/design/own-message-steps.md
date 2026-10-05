# Stepping between my own messages

The operator moves between the messages they typed in a conversation and reads
what the agent answered to each, without stopping at the replies to seat wakes,
agent notices and other machine-sent turns.

Two design rounds came before the build (draft PRs #2497 and #2514). Every
variant of the first round put its controls on top of something: message text,
the scrollbar, the header's corner. The second round's rule was that a control
lives in space that is its own, and the operator chose its variant 2: a row
between the feed and the composer.

## The row

"Previous mine", a count, "Next mine", in the same place at every width, with
words on the buttons. It sits straight above the composer, under the feed's
way-back row, the status line and the control strip.

- **Cost.** Feed height and nothing else: 37 px on the desktop (36 and the top
  border), 45 px on the phone (44 and the border). Nothing else in the pane
  changes size; the rows between the feed and the step row ride up by the
  row's height.
- **One row on the phone.** Away from the tail the phone also needs the way
  back ("to latest"). The pill moves into the step row's right-hand cell, so
  the feed gives up 45 px where the way-back row alone took 44. The cell is
  kept at the tail too, and an empty one balances it on the left, so the step
  buttons never move under the thumb.
- **Absent** when the conversation has fewer than two own messages.
- **`Alt+↑` / `Alt+↓`** step as well. The composer keeps the bare arrows for
  its own history, and nothing else takes Alt with an arrow. Several
  conversations can be on screen, so the keys go to the pane that holds the
  focus, or to the only one there is.

## What a step is

A message the operator typed or dictated into this conversation: a row the feed
renders as the operator's bubble. The feed marks those rows `data-own-message`
from its own verdict, the same one that picks the bubble (delivery evidence,
`resolveDeliveredItem`). Seat wakes, agent-finished notices, pipeline and
orchestrator relays, harness rows and attachment rows are never steps.

## What a step does

- It puts the own message at the top of the feed with its reply under it. From
  the middle of a reply, a step back goes to the message that reply answers.
  At the tail there is no next.
- The desktop keeps 8 px above a landed message. The phone lands it exactly on
  the feed's top edge: the phone feed rests with a row starting there (#1978)
  and moves itself after a reader's scroll, so a landing on that boundary
  leaves it nothing to correct.
- Rows off screen are laid out at an estimated height, so a landing is held
  for half a second while the rows around it take their real one, and let go
  the moment the reader scrolls.
- A step is the reader's scroll. It tells the feed so the way a wheel does,
  which releases the tail and keeps the feed's reading anchor on the landed
  message.

## The count

`5 / 7`: which own message is being read, of how many. `5 / 7+` while older
history is unloaded or not yet revealed. A step back from the oldest message on
the page asks the feed for the history before it and finishes on the message it
brings; a page with no own message in it is skipped. The walk ends on the
conversation's first own message with the step back disabled.

## Known limits

- **A machine delivery without evidence.** A paste through a terminal, or a
  record from before the delivery ledger, renders as an operator bubble and is
  a step. The row inherits the feed's reading.
- **A team member's message.** On an installation with a team, a message
  another member typed is also an operator bubble. "Mine" then means "a
  person's".
- **The late sender on a Claude conversation.** A delivered Claude record is a
  system row until the ledger names its sender. While any such row is
  unanswered the count is not final, so the row keeps showing the last count
  that was, and a conversation with none yet shows no row until the answer
  arrives. The ledger's reads are bounded, so the wait ends.

## Where it lives

- `src/components/conversation/ownMessageStepModel.ts`: the arithmetic.
- `src/components/conversation/OwnMessageSteps.tsx`: the hook that reads the
  feed and lands a step, the key routing and the row.
- `LogFeed` takes `stepsMount`, the slot its pane keeps above the composer,
  and draws the row into it. `BranchPane` (the board, the phone, the kanban
  reader) and `OrchestratorConversation` (the dock) each keep that slot. A
  feed with no slot, such as a background task's, has no row.

## Evidence

`conversationWindow.browser.test.tsx`, block "own-message step row", over the
fixture's `own-message-steps` case: the production pane at 1440, 1000, a
440 px board pane, the orchestrator's conversation at 440 px and the phone at
390, in English and Ukrainian, at rest, after steps back, with a six-line
draft, with the phone's keyboard inset and on the oldest own message. Each
moment is measured beside the same pane without the row. The readings are in
`evidence/own-message-steps/row.json`.

```
LLV_CONVERSATION_BROWSER_TEST=1 CHROME_BIN=<chrome> \
  bun test src/components/conversation/conversationWindow.browser.test.tsx -t "own-message step row"
```
