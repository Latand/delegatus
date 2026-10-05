# Stepping between my own messages, second round

Design lane. It delivers four numbered variants as a working prototype in the
production conversation pane, their frames and an overlap measurement. It ships
nothing. The operator answers with a number and the build follows in a
successor lane.

## The ask, and why there is a second round

The operator wants to move quickly between the messages they typed in a
conversation and read what the agent answered to each, without stopping at the
replies to seat wakes, agent notices and other machine-sent turns.

The first round (draft PR #2497, `docs/design/own-message-navigation.md` on its
branch) offered four variants. All four were rejected for one reason: in every
one of them the controls lie on top of something. This round keeps the job and
changes the rule: a control lives in space that is its own.

## What each first-round variant covered

The first-round prototype drew its own rows and its own header, so some of
what it covered only shows once the control is put into the real pane. Both
are listed. Positions are from its source (`ownMessages.prototype.tsx` on the
#2497 branch) and its frames.

| First-round variant | Where the control was | What it covered |
| --- | --- | --- |
| 1 · Arrows with a counter | a pill, `absolute bottom right` of the feed | Message text: on the phone frame the pill hides the end of a wake card's sentence. On the desktop it sits on the feed's bottom right corner, over the scrollbar's track and the last line that reaches it. |
| 2 · "Mine" mode | phone: a pill, then a full-width bar, `absolute` at the bottom of the feed; desktop: a switch in the header's right corner | Phone: the lower lines of the message at the bottom of the feed (an own message's second line is cut in the frame). Desktop: the corner where the real header keeps its process chip, host control, read-aloud, expand and close buttons. |
| 3 · Rail with ticks | a rail along the feed's right edge, with a preview card `absolute` beside it | The scrollbar's place for the whole height of the feed, and message text under the preview card (a paragraph of a reply in both frames). On the phone the rail also takes 45 px from every line. |
| 4 · Table of contents | desktop: a button in the header's right corner and a side panel; phone: a pill `absolute` at the bottom right of the feed, then a sheet over 74% of the screen | Phone: message text under the pill; with the sheet open, the feed, the composer and, under the scrim, the bar. Desktop: the same header corner as variant 2 for the button; the panel itself pushes and covers nothing. |

None of the four covered the phone's bottom dock: the conversation screen does
not draw one. None was measured against the way-back ("to latest") control,
because the first-round prototype did not draw one.

## What counts as "my message"

The same in every variant: **a message the operator typed (or dictated) into
this conversation.** Seat wakes, "agent finished" notices, pipeline and
orchestrator relays, harness rows (environment context, system reminders,
compaction summaries) and attachment rows are never steps.

**How the prototype tells them apart.** It reads the feed's own verdict and
adds no rule of its own: a row the feed renders as the operator's bubble
carries `data-feed-kind="user"`, and those rows are the steps. The feed gets
that verdict from delivery evidence (`src/components/feed/parse.ts`): on a
Codex conversation the structured-user marker each delivery writes
(`origin=operator` or `origin=agent` with the sender's role), on a Claude
conversation the delivery ledger joined by the engine's message id. A
machine-sent turn becomes an internal relay card (`tmsg`), a harness row
becomes a system row.

The fixture is a Codex transcript of an orchestrator's day: 9 own messages
among 37 machine-sent turns (wakes, finished-agent notices, a pipeline
message) and one harness row, each turn answered. The driver asserts the
count: 7 steps in the loaded window beside its relay cards (28 of them), 9
after the older page loads, the harness row in neither.

**Where it could be wrong.**

- A machine delivery that left no evidence (a paste through a terminal, a
  record from before the delivery ledger) renders as an operator bubble today
  and would be a step. The build inherits the feed's reading; it gets no worse.
- On an installation with a team, a message another member typed is also a
  `user` row. "Mine" then means "a person's", unless the build filters on the
  member author, which exists only where there is a team.
- On a Claude conversation the sender arrives from the ledger after the row is
  drawn. The parser's own note says such a row is a system row until the
  evidence answers, so an own message can be missing from the count for a
  moment. The fixture is a Codex conversation and did not exercise this.
- A system reminder pasted inside a message the operator sent is part of that
  message, and the message is a step.
- Only rows the feed has loaded and revealed are counted. The count says so:
  `5 / 7+` while older history is unloaded.

## What every variant shares

- **A step** puts the own message at the top of the feed, with its reply under
  it. From the middle of a reply, a step back goes to the message that reply
  answers. At the tail there is no next; the way-back row already covers that.
- **The count** `5 / 7` (`5 / 7+` with older history unloaded) says which own
  message is being read.
- **Older history.** The feed loads the page before the loaded window on the
  reader's way up, so walking back simply continues into it (7 becomes 9 in the
  fixture) and ends on the conversation's first own message with the step back
  disabled.
- **`Alt+↑` / `Alt+↓`** step in every variant. The composer keeps the bare
  arrows for its own history and nothing else in the product takes Alt with an
  arrow.
- **The phone's resting rule.** The phone feed comes to rest with a row starting
  exactly at its top edge (#1978) and moves itself there after a reader's
  scroll. A step lands on that boundary (0 px above the message on the phone,
  8 px on the desktop), so the feed has nothing to correct. The first build of
  this prototype landed 8 px above on the phone and the feed pulled the message
  up to 243 px down the screen half a second later; the build has to keep this.

## The variants

Each is mounted by the conversation evidence fixture:
`?case=own-message-steps&variant=1|2|3|4` (`variant=0` is the pane as it is
today, the baseline the measurements compare against), with the number printed
in a band above the pane.

### 1 · In the header

Desktop: previous, count, next straight after the title in the pane header's
first row. Phone: two 44 px buttons in the 52 px bar, before the report-log
button.

**What it costs.** No height at all. The width comes out of the title, the one
flexible cell: 96 to 102 px on the desktop, which nobody notices in a wide pane
(1132 px of title at 1440) and which nearly erases the title in a
board-node-sized pane (440 px wide: 156 to 53 px in English, 127 to 25 px in
Ukrainian, one letter and an ellipsis). On the phone the title cell goes from
244 to 154 px on the orchestrator's conversation, under the 190 px the bar's
own layout rule keeps for it, and there is no room for the count. The desktop
controls are header-sized (26 x 18 px) and easy to miss. On the phone they are
at the top of the screen, the far end from the thumb, for an action the
operator repeats several times in a row.

### 2 · A row above the composer

A row of its own between the feed and the composer, at every width: "Previous
mine", the count, "Next mine". It pushes the feed; nothing floats.

**What it costs.** Height, always: 37 px on the desktop, 45 px on the phone,
taken from the feed and from nothing else (the way-back row, the status line
and the control strip ride up by the same amount, unchanged). Away from the
tail the phone then has two rows under the feed, the way-back row and this one,
89 px together; with a six-line draft and the keyboard up the feed is still
there and the stepped-to message is still on it. It is the only variant with
words on its buttons, so it needs no explaining, and the only one where the
controls sit at thumb height on the phone and in the same place at every width.

### 3 · In the composer's own row

Desktop: previous, count, next in the composer's options row, after the model
and context chips, where that row is empty. Phone: the tools row inside the
composer box has one free cell at 390 px, so it takes the step back; the step
forward sits in the feed's way-back row, which exists exactly while there is
something below to step to (an empty cell of the same width on the other side
keeps that row's pill where it was).

**What it costs.** On the desktop, nothing measurable: no element moves or
shrinks. On the phone the one cell comes out of the runtime chip, which goes
from 88 to 42 px and loses its label (the model and effort it names), leaving
a dot and a caret. The two directions end up in two different rows 100 px
apart with the composer between them, there is no count, and both are icons
without words. Thumb reach is the best of the four. A composer row is also the
place for things about the message being written, and these controls are about
the conversation above it.

### 4 · Shortcut and menu rows

Nothing new on screen but the count. Desktop: `Alt+↑` / `Alt+↓`, and the count
after the header's title. Phone: "Previous message of mine" and "Next message
of mine" as the first two rows of the conversation's existing `⋯` sheet, and
the count on the bar's second line beside the state phrase.

**What it costs.** The least space: 50 to 56 px of the desktop title (156 to
99 px in a 440 px pane), nothing on the phone. The most effort: on the phone a
step is two taps with a sheet opening and closing between them, and while the
sheet is open it lies over the feed like every row of that sheet does, so the
operator sees where they landed only after it closes. On the desktop nothing
says the shortcut exists except a tooltip on a 10 px count; an operator who
has not been told will not find it.

## Overlap, measured

`conversationWindow.browser.test.tsx`, block "own-message steps, second-round
design variants". For every variant, at four widths, in English and Ukrainian,
in each of these moments: at rest at the tail; after three steps back, with the
way-back row on screen; the same with a six-line draft in the composer; on the
phone the same again with a 336 px keyboard inset; on the conversation's oldest
own message; and, for variant 4 on the phone, with the `⋯` sheet open.

Per control: a hit-test at its centre and four corners (the corner points sit
just inside the rounding) has to answer with the control itself; its box may
intersect no other interactive element on the page (a row scrolled out of the
feed counts for the part the feed shows); its box may not intersect the feed's
viewport; it has to be inside the window; on the phone a button has to be at
least 44 x 44 px. Per pane: every structural box and every interactive element
outside the feed is compared with the same pane mounted with no controls, and
any change the variant did not declare fails the case. The page may not scroll
sideways.

The conversation is 6 000 to 17 000 px tall depending on width. "1000 / 440"
is a 440 px pane in a 1000 px window, the size of a board node.

| Variant | Width | Control readings | Hit-test passes | Intersections | Over the feed | Changed against the pane without controls |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1440 | 24 | 24 | 0 | 0 | title 96–102 px narrower |
| 1 | 1000 | 24 | 24 | 0 | 0 | title 96–102 px narrower |
| 1 | 1000 / 440 | 24 | 24 | 0 | 0 | title 96–102 px narrower (156 → 53 en, 127 → 25 uk) |
| 1 | 390 | 20 | 20 | 0 | 0 | title cell 90 px narrower (244 → 154) |
| 2 | 1440 | 24 | 24 | 0 | 0 | feed 37 px shorter; way-back row, status line and control strip 37 px higher |
| 2 | 1000 | 24 | 24 | 0 | 0 | the same |
| 2 | 1000 / 440 | 24 | 24 | 0 | 0 | the same |
| 2 | 390 | 30 | 30 | 0 | 0 | feed 45 px shorter; way-back row 45 px higher |
| 3 | 1440 | 24 | 24 | 0 | 0 | nothing |
| 3 | 1000 | 24 | 24 | 0 | 0 | nothing |
| 3 | 1000 / 440 | 24 | 24 | 0 | 0 | nothing |
| 3 | 390 | 18 | 18 | 0 | 0 | runtime chip 46 px narrower and 46 px to the right (88 → 42, label gone) |
| 4 | 1440 | 8 | 8 | 0 | 0 | title 50–56 px narrower |
| 4 | 1000 | 8 | 8 | 0 | 0 | title 50–56 px narrower |
| 4 | 1000 / 440 | 8 | 8 | 0 | 0 | title 50–56 px narrower (156 → 99 en, 127 → 71 uk) |
| 4 | 390 | 14 | 14 | 0 | 4 | nothing; the 4 are the two menu rows in both languages, inside the open `⋯` sheet |

Every reading is in `evidence/own-message-steps/overlap.json`. The case also
checks that a step lands the message at the feed's top (within 2 px), that the
first line of its reply is on screen, that a step forward returns, and that the
walk back ends at 1 of 9.

## Recommendation: variant 2

The rejection was about controls lying on things, and variant 2 states its
price openly: one row of the feed, 37 px on the
desktop and 45 px on the phone, and nothing else in the pane changes size or
place. For that it is the only variant with words on its buttons, the only one
with the count on the phone next to the buttons, and the only one that is in
the same place, at thumb height, at every width. Variant 1 erases the title in
a board-sized pane and puts a repeated action at the top of the phone. Variant
3 is free on the desktop and on the phone strips the label off the runtime chip
and splits the pair across two rows. Variant 4 costs no space and costs two
taps a step on the phone and a shortcut nobody is told about on the desktop.

`Alt+↑` / `Alt+↓` stay whichever number is chosen.

One thing left for the build (this lane did not prototype it): away from the tail the phone
shows the way-back row and the step row one above the other. The way-back pill
could move into the step row while both are needed, which gives 44 px back to
the feed; that changes the feed's own row and should be measured the same way.

## What is here

- `src/components/conversation/ownMessageSteps.prototype.tsx` and
  `ownMessageSteps.prototype.model.ts` with its test: the prototype and the
  arithmetic every variant shares. The pane is the production `BranchPane`,
  inside `MobileShell` with the real `⋯` menu on the phone. No product file
  imports the prototype and no product file changed. Variant 2 and variant 1
  on the phone use slots the pane already has (`composerMount`, `barAction`);
  the other placements have no slot today, so the prototype inserts a host
  node there, which the build replaces with a prop.
- The `own-message-steps` case in `conversationWindowEvidence.fixture.tsx`.
- The driver block in `conversationWindow.browser.test.tsx` (no new driver).
- `evidence/own-message-steps/overlap.json`.

Frames go to `.artifacts/own-message-steps/` and are not committed. To write
them again:

```
LLV_CONVERSATION_BROWSER_TEST=1 CHROME_BIN=<chrome> \
  bun test src/components/conversation/conversationWindow.browser.test.tsx -t "own-message steps"
```
