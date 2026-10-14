# Core concepts

This page explains the ideas Delegatus is built from, one short section each,
and then how they fit together. Bold text is a label as the interface shows
it.

## Project

A project is a folder with your code, usually a git repository. Each project
has its own board and at most one orchestrator.

Agents often work in a git worktree, a second checkout of the same
repository. Work done in a worktree is grouped under its repository's
project, and it stays there after the worktree is deleted.

In the left sidebar a project takes one row: its name, how many items wait on
you, how many agents are working and how long ago something last happened.
**Archive or delete** in the board's ⋯ menu archives or removes a project.

## Board and tasks

The board shows every task in a project and what it is waiting for. A task is
the record of one piece of work; its card is how the board draws it.

The board has four columns: **Inbox**, **In progress**, **Waiting** and
**Done**. On each card:

- the state line under the title says whether the task is moving, waiting or
  stopped, and for a wait, why;
- a status note of up to 280 characters, written by an agent, the
  orchestrator or a stopped pipeline, says what is happening now;
- each pipeline on the task takes one row with its stages.

A task has a priority: **High**, **Normal** or **Low**.

**Needs you**, at the top of the board, counts what waits on you across all
projects: a question, a plan to approve, a permission prompt, a decision.
The Overview board shows every project at once.

## Agents and conversations

An agent is one Claude Code, Codex or GitHub Copilot session, running on one
of your accounts. Its conversation is its transcript, which Delegatus shows
as a chat.

Delegatus shows every agent conversation on your machine, including the ones
it did not start. Agents reach the board, tasks, pipelines and each other
through Delegatus's MCP server, registered under the name `viewer`.

## The orchestrator and its tick

The orchestrator is the agent you talk to about a project. It turns your
requests into tasks and pipelines, watches them and reports back. Its
standing instructions come prewritten, and you can edit them when you create
it.

Delegatus wakes the orchestrator whenever something is owed: a pipeline
event, a stage waiting on a decision, a task nobody started. It also wakes it
on a schedule, the tick. The tick chip in the orchestrator's header is a
switch with four stops: off, every 4 hours, every hour (the default) and
every 10 minutes. Click the chip for the tick panel; the panel's text reaches
the orchestrator on every wake as your standing instructions.

Tools and the technical documents call the orchestrator's position in a
project its "seat". It is the same thing.

## Pipelines and stages

A pipeline runs one task through a fixed set of agent stages, such as build,
review and verify. It has up to eight stages and works in its own git
worktree and branch, so your own checkout is left alone. Some messages call a
pipeline a "lane".

Each stage has a role, such as builder, reviewer, verifier, architect or
visual critic. The role sets the engine, model and effort the stage runs on,
and whether it may change the repository. Which engine and model each role
uses is set in the sidebar's ⋯ menu → **Settings** → **Roles: engine and
model**.

Each stage ends with a verdict:

- **pass** moves to the next stage;
- **fail** follows the stage's fail edge, usually back to the builder;
- **needs decision** stops and asks you.

The next stage receives everything the previous agent wrote before it
reported. No stage can deploy: deploys stay outside pipelines.

Mark a pipeline **Finishes the task** and its task moves to **Done** when the
pipeline finishes, or, with merging on, when its pull request merges.

## The review loop and its budget

A review is a read-only reviewer stage whose fail edge leads to a fix stage,
and the fix stage leads back to the reviewer. Every round therefore starts a
fresh reviewer, with no memory of the builder's conversation, on the new
head.

The review budget is fixed when the pipeline is created: three rounds unless
its creator chose more, and at most nine. N rounds are N reviews plus one fix
of the last review's findings. After that fix the pipeline moves on and marks
the fix as not re-reviewed. A pipeline can also be created to wait for you
after that fix; it then stops on the fixed head and offers **Accept as is**.
The budget is spent either way, so there is no extra review to ask for.

## The merge setting

**Merge when the review passes** is a per-project switch on the **Merging and
syncing** page of the board's ⋯ menu. It is off by default.

- Off: a pipeline ends with its pull request open, and the orchestrator
  tells you it is ready.
- On: Delegatus merges each pipeline whose reviews passed, one at a time
  per repository, once the required checks on its head are green. It updates
  a branch that fell behind, and on a conflict with the base branch it starts
  a refresh that merges the base and has it reviewed.

The setting needs a GitHub pull request. Without one, pipelines in that
project end without a merge.

## Accounts and limits

You can add several accounts per engine, each with its own login. Every
account has usage windows: five-hour and weekly for Claude and Codex, and a
monthly allowance for Copilot.

The sidebar's system block shows each account with what is left of its
weekly limit, and **All windows** in its header lists every window with its
reset time. A project can be limited to some of your accounts on the
**Accounts** page of the board's ⋯ menu.

When a pipeline stage hits a usage limit, Delegatus moves it to another
allowed account of the same engine. When none has room, the stage waits and
carries on once one does.

## The worker limit

The worker limit is how many workers the orchestrator keeps running in one
project. A worker is a running pipeline, or an agent the orchestrator started
directly.

The machine default is 3, and you can set it from 1 to 64 in the sidebar's ⋯
menu → **Settings** → **Workers per project**. A project can have its own
limit: the chip in the orchestrator's header reads `workers N / M`, and
clicking it sets the limit for that project.

The orchestrator reads the limit at every wake and plans within it. It limits
what the orchestrator starts; agents you start yourself are never refused by
it.

## Learned rules

When a pipeline stage reports, its agent may leave one short rule for later
agents, or sharpen a rule it was given. A rule has one of three levels:

- the agents of its role in this project;
- every role in this project;
- every project on this machine.

Agents of that level read those rules each time they start. Review and
verification stages read none and leave none. **Learned rules** in the
board's ⋯ menu shows a project's rules and lets you remove one.

Shared memory is a separate feature: it lets Claude and Codex agents look up
what either engine remembered. The README's
[Agents and accounts](../../README.md#agents-and-accounts) section explains
it.

## Reports

The orchestrator files a short report when something happens: a stage that
passed or failed, a review verdict, a blocked pipeline, a question, or a
status. Reports appear in the **Reports** log beside its chat and, if you
chose a chat, in Telegram.

Reports are written in your interface language and carry no private details,
because a Telegram group may be public. The **Bridge reports** switch on the
**Orchestrator** page of the board's ⋯ menu turns reports off for a project;
the voice then has nothing to read out either.

## The voice gateway

**Voice Delegatus** is a floating character you talk to by voice. Switch it
on in the sidebar's ⋯ menu → **Settings** → **Voice Delegatus** → **Show the
voice**.

It answers questions about the board itself, reads out the orchestrator's new
reports once, and passes work you ask for to the project's orchestrator as
your instruction. It asks you first only when the request is critical or it
is unsure what you meant. It talks either through the API with your OpenAI
key and a monthly spend cap, or through a Codex subscription.

## How they fit together

One request travels through all of these:

```text
you ── write to ──▶ orchestrator
                       │ opens a task on the board
                       │ starts a pipeline, within the worker limit
                       ▼
                    pipeline ── stages run as agents on your accounts,
                       │        each one a conversation
                       │ review loop spends its budget
                       ▼
                    merge setting decides: PR left open, or merged
                       │
                       ▼
orchestrator ── files a report ──▶ Reports log (and Telegram, voice)
             ── a decision only you can make ──▶ a form under Needs you
stages ── leave learned rules ──▶ the next agents of their level
```

1. You write to the orchestrator.
2. It opens a task on the board and starts a pipeline within the worker
   limit.
3. The pipeline's stages run as agents on your accounts, each one a
   conversation.
4. The review loop spends its budget.
5. The merge setting decides whether the pipeline ends with its pull request
   open or merged.
6. The orchestrator files a report, and a decision only you can make reaches
   you as a form counted in **Needs you**.
7. Stages leave learned rules that the next agents start with.

[Everyday workflows](workflows.md) shows what you do at each of these points.
