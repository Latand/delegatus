# Everyday workflows

This page covers what an operator does day to day: asking for work, reading
the board, answering decisions, reviewing prototypes, watching pipelines,
merging, deploying and releasing. [Core concepts](concepts.md) explains the
terms.

## Ask the orchestrator for work

Do this whenever you want something done in a project.

1. Open the project and write in the orchestrator's chat, typed or dictated
   with the microphone button.
2. Write the way you would message a colleague: "take issues 12 and 14", "fix
   the flaky test in the scanner", "review PR 30". One request per message
   reads best, and issues and pull requests are best named by number.
3. To ask about a task already on the board, press **Ask** on its card. The
   task goes above the composer as a chip, so your next message is about it.

What comes back: the orchestrator answers in its chat, a task card appears on
the board, and a pipeline row appears on the card. When the orchestrator
starts a pipeline or moves a card, a wire runs from it to that card for about
a minute.

While the orchestrator is busy with a turn, **Ask in parallel** in its
composer sends a side question to a copy of it, which answers in its own
block in the same chat. Work for another project goes to that project's
orchestrator.

To give it a standing rule, such as "deploy after every merge" or "always
add a test", write it in the tick panel's text: click the tick chip in the
orchestrator's header. That text reaches it on every wake.

On a phone, the project's **Orchestrator** card opens the same chat, and
**Ask** is on the task's screen.

## Read the board

Read the board to see what is moving, what is stuck and what waits on you.

- The columns: **Inbox** holds new tasks, **In progress** the
  ones being worked on, **Waiting** the ones waiting on something, and
  **Done** the finished ones. Inside a column, cards with the newest agent
  work come first.
- The state line under a card's title says whether the task is moving,
  waiting or stopped, and why it waits. When it needs you it shows
  **Answer**.
- The status note says what is happening now, in up to 280 characters.
- The pipeline row shows the stages as a chain, the pipeline's state, its
  pull request and the issues that pull request closes.
- **Needs you** at the top counts what waits on you across all projects. Its
  filter beside the search, or the F key, dims every card that does not wait
  on you.
- **Images** on a card opens every screenshot and render its agents made.

A card's ⋯ holds the four columns in one row, icon actions to rename,
describe, attach a pull request or issue, or hide the task, the three
priorities, **Appearance** (colour and icon), **Pipeline actions** and
**More**. Hidden tasks are under **Hidden** in the board's ⋯ menu. Ctrl+Z
undoes your own moves, edits and hides on the board; Ctrl+Shift+Z redoes
them.

The Overview board shows every project. The sidebar's system block shows free
memory, every account with what is left of its weekly limit, Copilot and
Telegram.

On a phone the columns become tabs you swipe between. Hold a card to move it
to another column, or let go in place for its menu.

## Answer a decision form

A decision the orchestrator cannot make alone reaches you as a form. It waits
in the **Decisions** tab beside the orchestrator's chat and counts in **Needs
you**.

A form has one to seven questions; a form that belongs to a task has three to
seven. Each question has two to six options, and exactly one of them is
marked **recommended**.

1. Pick an option for each question. **Choose any** marks a question that
   takes several options.
2. **Other — write it below** lets you write your own answer in the comment
   field.
3. Press **Answer**. **Skip** takes the recommended answer for every
   question at once.

Your answer goes to the orchestrator once, as your own message. The form then
shows whether it was **delivered**, is **sending**, was **not delivered**, or
has **delivery unconfirmed**.

## Review a prototype

When an agent has screens for you to judge, it publishes a prototype review:
a few numbered variants, each with a name and a short description. The card
gets a **Prototype** button, and the round waits in the **Decisions** tab.

1. Open the review. Each frame is a captioned tile that opens enlarged; an
   original can stand beside its change, and a video plays in place.
2. Choose one variant or several by number. The number keys work too.
3. Add a comment, typed or dictated, and press **Save choice**. The review
   then reads **Decision saved · delivered to the orchestrator**. Your choice goes to the
   project's orchestrator once, as your own message, and the card shows the
   numbers you chose.

If none of the variants fits, press **None fits**, write what to redo, and
press **Reject and redo** to ask for the next round. **Hide** takes a round
off the waiting lists without a choice, and can be undone. If the review was
also posted to Telegram, **Send to Telegram again** resends it.

A review is published after a visual critic has passed it. Before work on a
request with important choices open, a review can instead hold three to seven
questions; answer them in one message or skip to the recommended answers.

On a phone the review fills the screen, and a tap opens a frame full screen, where two fingers zoom, one pans and a sideways
swipe steps to the next frame (the
[image viewer](interface.md#conversations) works the same way).

## Watch a pipeline

A running stage needs nothing from you. Look in when the card's state line
says the pipeline stopped, or when you are curious.

- The card's pipeline row shows the stage chain and the pipeline's state.
  Open it to see the stage graph beside each stage's conversation.
- Agents you open appear in one window over the board. Its left column lists
  every open agent; Alt+J and Alt+K step between them, Esc closes the window,
  and a pill in the header brings it back.
- In a running stage's conversation, the runtime pill in the composer
  switches that stage to another model, effort, speed or account.
- When a stage hits a usage limit, Delegatus moves it to another allowed
  account by itself.

When a pipeline stops, its card says why. Press **Answer** for a decision, or
use **Pipeline actions** in the card's ⋯:

- **Retry {stage}** runs the named stage again, for example "Retry Build";
- **Skip {stage}** moves past it;
- **Pause** stops the pipeline after its current stage, and **Resume**
  continues it;
- **Accept as is** takes the fixed head when a pipeline waits after its last
  review fix;
- **Close the pipeline** ends it.

[Pipelines in depth](pipelines.md) covers the stages, verdicts and review
budget; [docs/pipelines.md](../pipelines.md) covers stage definitions, verdicts and
recovery.

## Merge and deploy

How a finished pipeline lands depends on the project's merge setting.

With merging off (the default), the orchestrator reports that the pull
request is ready. Merge it on GitHub, or ask the orchestrator to.

To have Delegatus merge for you, turn on **Merge when the review passes** on
the **Merging and syncing** page of the board's ⋯ menu. The pipeline row then
shows **waiting for checks**, **merging**, **merged** or **merge stopped**. A
stopped merge names its reason, appears under **Needs you**, and offers **Try
the merge again** or **Leave the PR open**. The orchestrator can also land
several reviewed pull requests as one batch through a merger stage;
[docs/merge-batch.md](../merge-batch.md) has the procedure, and
[Merging](pipelines.md#merging) in the pipelines page covers the rest.

To deploy your project, ask the orchestrator. No pipeline stage deploys, and
only the orchestrator or your own session can start a deployer agent. To make
deploys routine, write what should happen after a merge in the tick panel's
text.

To update Delegatus itself, open the sidebar's ⋯ menu → **Updates**, which
opens the **Update** dialog; **Check now** looks for a newer release. The update builds
and verifies the launcher, web server and runtime host together and restores
the previous release if verification fails. Running sessions reconnect.

- **Automatic updates**, off by default, waits for green checks and a quiet
  minute before it applies an update. It works for an install run from a
  clone and is unavailable for a packaged install.
  [Operations](operations.md#automatic-updates) has the details.
- A packaged install updates through the dialog or with
  `bunx delegatus-cli@latest`.
- A Docker production instance deploys with `scripts/rebuild.sh`; see
  [docs/docker.md](../docker.md).

## Releases

Releasing your own project is work like any other: ask the orchestrator for
a release, or put your release rule in the tick panel's text.

The tick panel also has a **Releases** switch, shown only on the board of
the Delegatus repository itself, for people who develop Delegatus with
Delegatus. It is off by default. Switched on, it prepares a release once 30
visible changes have gathered and twelve hours have passed since the last
one, from a revision production has served for six hours. With **Ask before
publishing** on, it asks you before it publishes.
[docs/RELEASING.md](../RELEASING.md) has the procedure, and
[the tick panel](orchestrator.md#releases) is where the switch lives.
