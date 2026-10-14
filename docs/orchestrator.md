# The orchestrator

Every project in Delegatus can designate one agent as its **orchestrator**.
You tell it what you want shipped, in the orchestrator panel above the board;
it opens a task for each piece of work, runs each as a pipeline, merges
according to the project's merge setting, and reports back. It works through
Delegatus's own HTTP API and MCP tools, so everything it starts is a card you
can open, read, interrupt or take over.

![A project's orchestrator: its chat with you, its worker count against the limit, and beside it a task's three-question decision form waiting for your answer, already sent to Telegram with a link to send it again](media/readme/orchestrator.svg)

This page is the technical contract of the seat: designation, the mandate and
its versions, how work runs, rotation and where each surface lives. The
operator's walk-through (creating the orchestrator, the tick panel, reports,
the worker limit) is [The orchestrator in depth](guide/orchestrator.md) in the
guide.

## Before you start

1. **Run Delegatus.** `bunx delegatus-cli` serves it on `127.0.0.1:8898` and
   supervises the structured runtime host that agents launch through; see
   [Getting started](guide/getting-started.md). Neither Docker nor tmux is
   required for this flow.
2. **The Delegatus MCP server needs no step.** Every agent Delegatus launches,
   the orchestrator included, gets the `viewer` server on its own when its
   account registers none (`src/lib/agent/spawnPolicy.ts`). Registration is
   only for your own Claude Code or Codex sessions; see
   [The MCP server](guide/mcp.md).
3. **Open the project you want driven.** A project is a repository Delegatus
   has seen an agent working in, or one you add with **Create project**. The
   orchestrator runs its pipelines as git worktrees of that checkout.

## Designation and the mandate

Select the project in the left sidebar and press **Orchestrator** in the
project header. The button shows or hides the orchestrator panel. The panel
sits above the columns by default; its dock control (**Dock at the side** or
**Dock at the top**) moves it. The height is kept on this device and the width
per project. A phone reaches the same seat through the **Orchestrator** card
on the phone board.

Until a project has an orchestrator, the panel shows the create draft, already
filled in:

- **The mandate is written for you.** It is the versioned default in
  `src/lib/orchestrator/prompt.ts`, delivered as the first message of the new
  conversation: how work runs as a pipeline on its task, the stage contract,
  the merge bar, the report channels, when the seat may move your screen and
  how it asks you for decisions. The text is editable and the summary line says
  which mandate you are on, the built-in version or your own rules. Version 16
  removed the deploy protocol from the default, and delivery strips it from
  stored copies; the seat deploys only when you ask, through `spawn_agent`.
- **Engine, model, effort and account** open on the orchestrator role's own
  default from the role registry (`src/lib/roles/defaults.ts`). Change any of
  it before you create the seat. Which model each role uses is decided there,
  shown under **Roles: engine and model** in **Settings** and read with the
  `role_presets` tool; the mandate carries the current table, rendered at
  delivery.
- **Create the orchestrator** designates the seat and delivers the mandate
  exactly once. The designation is recorded before anything is spawned, so a
  lost reply or a reloaded page converges on the one orchestrator; no second
  seat is created.

One seat per project. It is durable state on the machine, so every window you
open that project in finds the same orchestrator.

A fresh seat greets you in two lines and stops:

```
Ready in <project>.
Tell me what you want done here. I'll turn it into tasks on the board, have
agents build and review it, keep it moving and report back. New work starts
when you ask; I'll suggest what could come next.
```

## How the seat runs work

Every piece of accepted work is a pipeline on its board task: the seat finds
or creates the task, composes the stages from the role table and calls
`create_pipeline` with the task ids. A pipeline has up to eight stages. A
review is a read-only reviewer stage whose fail edge leads to a fix stage that
returns to the reviewer, so every round is a fresh reviewer; verdicts are
`pass`, `fail` and `needs_decision`, reported through `stage_report`. The
contract is in [docs/pipelines.md](pipelines.md) and the review rounds in
[docs/review-loop.md](review-loop.md). The seat keeps no more workers running
than the worker limit.

**The merge bar.** A pull request is ready when the reviews passed its final
head or the budget's last fix passed, the required checks are green and its
body is read. The project's **Merge when the review passes** setting, on the
**Merging and syncing** page of the board's ⋯ menu, decides who merges it. Off
(the default), the seat reports "PR ready" and merges only when you ask. On,
Delegatus merges completed lanes itself once their checks are settled green;
the seat leaves those alone and acts on a merge that stopped. A red check holds
the merge either way. When two or more ready pull requests are authorized to
merge, the seat sends one `merger` stage their `N@reviewedHead` pairs and
excludes every pull request whose live `merge.state` Delegatus holds. The
merger lands clean patches as one batch; `needs-review` sends a conflict
resolution to an independent review before a later batch, and `culprit` returns
to its lane as a finding. See [the merger procedure](merge-batch.md).

**Merge wakes.** A recorded lane merge wakes the project's designated
orchestrator, including when the lane's completion was already announced or
another conversation launched it. The wake names the lane, the pull request
number and the merged head. Standing instructions can name what to do on that
merge, including starting a release. Delivery announces each merge once; an
undelivered wake leaves it owed. Several merges share one wake within the item
bound, with the remainder owed for later wakes. Merges obey the project's wake
interval and expire at the backlog bound; an idle seat is woken within that
interval plus one check interval after the merge is recorded. Merged lanes
reach the seat as journal events (`src/lib/monitor/seatTickSources.ts`).

**A pipeline that finishes its task.** The seat marks the pipeline whose pull
request delivers the whole task, and that task moves to Done when the pipeline
completes (setting off) or its pull request merges (on), once every other
started pipeline on the task has ended.

Everything the seat starts shows up on the project board as task cards, so the
board answers "what is running right now" without asking anyone.

## When a decision needs you

Four surfaces name the same decision from one queue: the **Needs you** control
in the board header (the count of what waits, opening the panel by project), a
toast titled with the decision itself, the panel's own badge, and the card or
the **Decisions** tab, where a blocked question renders with clickable options
and the answer is delivered back to the agent. `N` and `Shift+N` walk the
project on screen and `F` toggles the **Needs you** filter. A decision form
from the seat shows in **Decisions**.

When the seat files a `blocked` or `question` report, the report enters
**Needs you** as a hard block on its own conversation, so a manager waiting on
you looks exactly like an agent waiting on you. The report ages out after two
hours if it stops mattering (`src/lib/attention/needsYouRead.ts`).

## Rotation

The panel head says who holds the seat: engine badge, model, effort, account
and its context reading, a percentage of the model's window when the seat's
launch profile names one and the token count when it does not. At the rotation
threshold (half the window, `src/lib/orchestrator/contextPolicy.ts`) the panel
recommends rotating and carries the server's own reasons. Only that context
reading and a gone host add a reason; the recommendation itself changes
nothing (`src/lib/orchestrator/health.ts`).

Two things rotate a seat without you. **Auto-rotation** in the seat tick panel,
off by default and set between 50 and 90 percent, hands over to a fresh seat at
the next idle point once the context reaches the percentage
(`src/lib/monitor/seatAutoRotation.ts`). An expired login moves the seat to
another allowed account, or pauses its wakes when none has room
(`src/lib/monitor/seatAuthRecovery.ts`).

**Rotate** in the panel head is one way to rotate by hand. The draft opens
prefilled with the incumbent's own parameters. The mandate box starts from the
current built-in default when the incumbent's mandate is based on an older
version, and the summary line says so; **Keep the incumbent's mandate** carries
its text forward instead. A seat already on the current version, or on your own
rules, keeps its text. The seat row flags a stale seat as "mandate vN, default
vM", and `rotate_orchestrator` defaults identically, with
`keepIncumbentMandate: true` as the explicit carry-forward.

The successor receives the mandate plus a handoff the server composes: the
predecessor's identity and exact `conversation_messages` call, the project's
open board tasks, your notes, and one compact **Rotation history** section
standing in for every earlier handoff, so a seat that has rotated a dozen times
costs what a fresh one costs. The predecessor keeps its conversation, its card
and ordinary Delegatus access; only its manager authority moves. Both cards
stay linked, and the successor's header links back. The mandate lands in the
feed as a single folded **Mandate** card with the delivery's line count, and a
rotation handoff as its second section.

`rotate_orchestrator` performs the same rotation from any session, including
the seat rotating itself when you say so from a phone, because the tool and
`POST /api/orchestrator/rotate` share one authority contract: whatever actor
reaches one reaches the other. What replaces a prohibition is a name. Every
rotation records who triggered it (operator or agent, the triggering
conversation and the seat epoch it held) on the successor's designation and on
the predecessor's revocation, so the lineage `get_orchestrator` reports carries
both which seat replaced which and on whose word. Retrying the same idempotency
key replays that record verbatim, so the name it answers with is always the one
the rotation was recorded under, whoever sends the retry.

## What lives where

| Surface | Where | What it is for |
| --- | --- | --- |
| Orchestrator panel | Above the board by default, or at the side, per project | The seat's conversation: who holds it, its context reading, **Rotate**, the **Decisions** tab, the **Reports** log and the composer you talk to it in. |
| Board | The project's canvas | Four columns of task cards, with the agents and pipelines working each one. |
| Pipelines | A row on the task card | A declared chain of stages in one worktree, opened as the stage graph; skip, retry and close are in the card's ⋯ ([docs/pipelines.md](pipelines.md)). |
| Needs you | The board header, toasts and the panel's badge | One queue of everything waiting on you, across every project. |
| Telegram | The sidebar's system block | Connect a bot or your own account; independent of the orchestrator's own channels ([Telegram](guide/telegram.md)). |
| Phone | The **Orchestrator** card on the phone board | The same seat, the same composer, the same queue ([From your phone](guide/phone.md)). |

Review flows, the older way to run implement and review rounds by hand, are
retired; [docs/review-loop.md](review-loop.md#retired-review-flows) says what
remains.

## Which model does which job

The seat is one agent; the agents it spawns are picked per job, by role. The
role registry decides the engine, model and effort of each role, and the
mandate tells the seat to spawn "per the role table". The registry's table is
the single source: read it under **Roles: engine and model**, with
`role_presets`, or in `src/lib/roles/defaults.ts`, and the table rendered into
the mandate at delivery is the one the seat follows. A pipeline stage or a role
reference resolves through the registry, and an explicit `engine`, `model` or
`effort` on the stage overrides it. Every launch surface offers the same effort
scale: `low`, `medium`, `high`, `xhigh`, plus `max` and `ultra` where the model
has them.

## Where to read more

- [The orchestrator in depth](guide/orchestrator.md): the operator's
  walk-through.
- [README](../README.md): install and the picture tour.
- [docs/review-loop.md](review-loop.md): how a review round runs in a
  pipeline.
- [docs/pipelines.md](pipelines.md): stage contracts, verdicts, worktrees,
  recovery.
- [docs/media/readme/provenance.json](media/readme/provenance.json): where the
  pictures on this page come from.
