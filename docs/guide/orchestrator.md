# The orchestrator in depth

The orchestrator is the agent you talk to about a project. This page covers
creating it, what it does with your requests, the tick panel that sets how
often it wakes, rotation, the worker limit, reports, bug reports and work for
other projects. The seat's technical contract (designation, mandate versions,
rotation authority, the HTTP and MCP surfaces) is in
[docs/orchestrator.md](../orchestrator.md).

![A project's orchestrator: its chat with you, its worker count against the limit, and beside it a task's three-question decision form waiting for your answer, already sent to Telegram with a link to send it again](../media/readme/orchestrator.svg)

## Create the orchestrator

A new install creates it in the setup guide, which has four numbered steps:
Engines, Project, Telegram (optional) and Orchestrator. Until a project has
one, the Overview offers **Start with an orchestrator**. On another project,
unfold the orchestrator bar at the top of its board and press **Create the
orchestrator** (on a phone, **Create an orchestrator**). The draft shows the
engine, model, effort and account it will run on, and you can change each.
If that account is signed out, the draft asks you to sign in first. Its
standing instructions come prewritten, and you can edit them before you
confirm. A three-stop walk then points at its composer, the board and
**Needs you**. **Interface walk**, under **Help and learning** in the
sidebar's ⋯ menu, shows it again.

One seat per project. It is durable state on the machine, so every window you
open that project in finds the same orchestrator. The designation is recorded
before anything is spawned, so a lost reply or a reloaded page converges on the
one orchestrator and no second seat is created.

Three parts of the draft are worth knowing:

- **The mandate is written for you.** It is the versioned default in
  `src/lib/orchestrator/prompt.ts`, delivered once as the first message of the
  new conversation: how work runs as a pipeline on a task, the stage contract,
  the merge bar, the report channels, when it may move your screen and how it
  asks you for decisions. You never type "you are an orchestrator" anywhere.
  The text is editable, and the summary line says which mandate you are on,
  the built-in version or your own rules. The orchestrator deploys only when
  you ask.
- **Engine, model, effort and account** open on the orchestrator role's own
  default from the role table (see [Accounts, limits and roles](accounts-and-roles.md#roles)).
  Change any of it before you create the seat.
- **Create the orchestrator** designates the seat and delivers the mandate
  exactly once.

A fresh seat greets you and stops:

```
Ready in <project>.
Tell me what you want done here. I'll turn it into tasks on the board, have
agents build and review it, keep it moving and report back. New work starts
when you ask; I'll suggest what could come next.
```

## What it does for you

Write to it the way you would message a colleague: "take issues 12 and 14",
"fix the flaky test in the scanner", "review PR 30". For each piece of work
it opens a task, starts a pipeline in a worktree of its own and keeps the
task's card up to date. Delegatus wakes it whenever something is owed: a new
pipeline event, a stage waiting on a decision, a task nobody started. It
answers in its chat and can move your screen to the card where something
landed. A decision it cannot make alone reaches you as a form in the
**Decisions** tab beside its chat, with a recommended answer for each
question, and counts in the board's **Needs you**. While it is busy with a turn, **Ask in
parallel** in its composer sends a side question to a copy of it, which
answers in its own block inside the same chat.

Every piece of work it accepts is a pipeline on that work's task. A review is a
read-only reviewer stage whose fail edge leads to a fix stage, a fresh reviewer
checks every round, and a pipeline has up to eight stages; see
[Pipelines in depth](pipelines.md) and [docs/review-loop.md](../review-loop.md).
Merges follow the project's **Merge when the review passes** setting: off, the
orchestrator tells you a pull request is ready and merges only when you ask; on,
Delegatus merges it once its required checks are green, and the orchestrator
acts only on a merge that stopped. A recorded merge wakes the project's
orchestrator, and standing instructions can name what to do then, including
starting a release. Everything it starts shows up on the board as cards, so the
board answers "what is running right now" without asking anyone.
[Everyday workflows](workflows.md) covers asking for work, answering forms and
the **Ask** chip.

## Each time it takes its seat

Each time an orchestrator takes its seat, including after a rotation, it
first gets a report on its board: what waits on you, stuck agents, tasks
nothing works on, cards that look safe to close and, for a GitHub project,
open issues ranked by their recorded priority.

## The tick panel

In the seat tick panel, **Board maintenance** can also start one maintainer
agent per project on a timer, every 3 hours by default and off until you
switch it on. The panel's text reaches the orchestrator on every wake as
your standing instructions. The tick chip in the orchestrator's header is a
switch with four stops, off, every 4 hours, every hour and every 10
minutes: drag it to change how often Delegatus wakes the orchestrator, or

### Releases

**Releases** in the same panel is off by default and is offered only on the
Delegatus repository's own project. Switched on, it prepares a release once 30
visible changes have gathered and twelve hours have passed since the last one,
and asks you before it publishes. It validates a release and asks before it
pushes a tag; it never deploys production. [docs/RELEASING.md](../RELEASING.md)
has the procedure.

## Rotation

The orchestrator's header says who holds the seat: engine badge, model,
effort, account, and its context reading, a percentage of the model's window
when the seat's launch profile names one and the token count when it does not.
Past the rotation threshold, half the model's window, the panel recommends
rotating and carries the server's own reasons. A gone host adds a reason of its
own. The recommendation itself changes nothing.

Two things rotate a seat without you. With **Auto-rotation** on in the tick
panel, from 50 to 90 percent and off by default, the orchestrator hands over to
a fresh one with a handoff once its context reaches the percentage you set, at
its next idle moment. When its turns fail because its login expired, Delegatus
tells you once and moves it to another allowed account with room, or pauses its
wakes.

To rotate it yourself, press **Rotate** in the panel head. The draft opens
prefilled with the incumbent's own parameters. The mandate box starts from the
current built-in default when the incumbent's mandate is based on an older
version, and the summary line says so; **Keep the incumbent's mandate** carries
its text forward instead. A seat already on the current version, or on your own
rules, keeps its text. The seat row flags a stale seat the same way, as
"mandate vN, default vM". The successor receives the mandate plus a handoff:
the predecessor's identity and the exact `conversation_messages` call, the
project's open board tasks, your notes and one compact **Rotation history**
section standing in for every earlier handoff, so a seat that has rotated a
dozen times costs what a fresh one costs. The predecessor keeps its conversation,
its card and ordinary Delegatus access; only its manager authority moves. Both
cards stay linked, and the successor's header links back. The mandate itself
lands in the feed as a single folded **Mandate** card.

## The worker limit

How many workers an orchestrator keeps running at once is one number for the
whole machine: **Workers per project** under **Settings** in the sidebar's ⋯
menu, from 1 to 64, 3 until you change it. The orchestrator's header shows
it beside the running count, as "workers 2 / 5"; click it to give that
project its own limit or to go back to the machine's. The orchestrator reads
the current number on every wake, so a change needs no rotation. It can read
and change the limit through `role_presets` too, with a reason that is kept
in the limit's history.

[Core concepts](concepts.md#the-worker-limit) keeps the definition.

## Reports

The **Reports** log beside its chat lists what it reported, newest first: a
stage that passed or failed, a review verdict, a blocked pipeline, a
question. Each entry shows its time and kind, and the issue numbers, pull
requests and cards in it are links. New reports arrive live. A toggle in the
orchestrator bar's header hides the log; on a phone the log opens from the
orchestrator chat's bar. Reports can also go to a Telegram chat or forum
topic. Only a project you turn on posts there: use the setup guide's
Telegram step or the **Reports** section in the orchestrator's own row. The
**Bridge reports** switch, on the **Orchestrator** page of the board's ⋯
menu, turns reports off for a project.

## Bug reports from a failed tool

When a Delegatus tool fails, the orchestrator offers in its chat to prepare a
bug report. If you agree, a reporter agent gathers the evidence, writes the
report and checks it for private details. The chat then shows the exact
title and body with the agent's privacy judgment, and nothing is filed until

## Work for another project

Work for another project goes to that project's orchestrator, so each board stays with its own seat.

## Where each part lives

| Part | Where | What it is for |
| --- | --- | --- |
| Orchestrator panel | Above the board by default, or at the side | The seat's conversation: who holds it, its context reading, **Rotate**, the **Decisions** tab, the **Reports** log and the composer you talk to it in. The **Orchestrator** button in the board header shows or hides it, and the panel's dock control moves it between the top and the side. |
| Board | The project's canvas | Four columns of task cards, with the agents and pipelines working each one. |
| Pipelines | A row on the task card | A chain of stages in one worktree, opened as the stage graph ([Pipelines in depth](pipelines.md)). |
| Needs you | The board header, toasts and the panel's badge | One queue of everything waiting on you, across every project. |
| Telegram | The sidebar's system block | Connect a bot or your own account ([Telegram](telegram.md)); independent of the orchestrator's own channels. |
| Phone | The **Orchestrator** card on the phone board | The same seat, the same composer, the same queue ([From your phone](phone.md)). |

An orchestrator that cannot proceed escalates the same way. A `blocked` or
`question` report enters **Needs you** as a hard block on its own conversation,
so a manager waiting on you looks exactly like an agent waiting on you, and the
report ages out after two hours if it stops mattering.

## When you do not need an orchestrator

Three tasks a week does not need an orchestrator. Press **+** in the board's
header, choose **New conversation with an agent**, and talk to it directly: read
its transcript and answer its blocked questions. The create draft says as much
on its own face. For a change that deserves a review, ask for a pipeline.

The seat starts paying off when several things run at once while you are
somewhere else: when you would otherwise be the one remembering which task
needs a reviewer, which pull request is green, and which agent has been sitting
on a question for twenty minutes.
