# Board maintenance report for the orchestrator at rotation and start

Status: design, operator decisions recorded 2026-09-27 (§12). Written against
`main` at `803296a6`; file and line references are to that commit. Rechecked
against `main` at `70ab3aa0` on 2026-09-28: the cited lines in `seatCommand.ts`,
`prompt.ts`, `handoffDigest.ts`, `report.ts` and `githubEvidence.ts` are
unchanged, and the three changes that touch this design (#2293, #2283, #2287)
are noted where they apply (§1.3, §5.6, §8, §9). Only this document was written
by this stage: no code, no test, no state, no issue.

## Originating requirement

Operator, 2026-09-27 19:47 UTC, voice-dictated in Russian into the Delegatus
project's orchestrator seat chat. The seat pinned four excerpts to this lane;
the whole message is quoted here verbatim, since it holds all four:

> Я ещё вот что думаю: надо, наверное, в мандат добавить, что когда
> оркестратор стартует, что если есть GitHub и есть GitHub issue, и он может
> посмотреть по приоритетам, э-э, предложить, какие есть смысл начинать
> работать сразу. То есть если на доске есть задачи, то сначала он смотрит на
> доску и делает, смотрит, какая работа ведётся, э-э, и. Статус. Где кто не
> завис. То есть ему нужно сделать, скажем так, давай так: даже когда вот
> каждый раз, когда происходит ротация, пусть оркестратор действительно
> проходит по доске, проходится по задачам, э-э, и. Не-не-не, это не должен
> делать оркестратор, это должен делать, это должно делаться автоматическим
> maintenance. Maintenance доски. А оркестратор тогда должен просто получить
> какой-то отчёт от этого maintenance. Тогда оркестратор может что-то одно
> взять, например, посмотреть предыдущую переписку, компакт, handoff, вот
> этот, э-э, и, может быть, всё, а параллельно должны запуститься какая-то
> слабенькая нейронка, например, не-не-не, слабенькая она может сделать
> ошибки. Э-э, ну, короче, тогда слабенькая нейронка пусть просто пройдётся
> по задачам, и посмотрит, и даст отчёт. А оркестратор тогда уже пройдёт по
> задачам и он уже посмотрит тогда, какие задачи, то есть он как project
> manager, он управляет бордом. Другие, получается, не должны управлять
> бордом. И выходит, что он должен получить отчёт, а потом имея этот отчёт,
> просто быстро приоритизоваться, куда сначала посмотреть и что действительно
> позакрывать, не позакрывать. И вот это он должен как бы после, после
> ротации, наверное, вот как-то так делать.

In English, condensed: when an orchestrator starts, and after every rotation,
an automatic board maintenance pass (the operator first thought of a weak
model, then worried it would make mistakes) walks the board in parallel with
the orchestrator reading its handoff, and hands the orchestrator a report:
what work is going on, its status, who is stuck and, when the project has
GitHub issues, which of them are worth starting by priority. The orchestrator
alone manages the board; it uses the report to decide quickly where to look
first and what to close.

## Decision in one paragraph

Build the pass as **Viewer code with no model and no agent**. Every fact the
requirement names is already durable state that the seat tick reads on every
check: open lanes and their states, agent liveness and stalls, lanes that
finished with a pull request open, assigned tasks nothing started, and open
GitHub issues. So the report is a pure function of that state, rendered as one
bounded message of at most 6 000 bytes. It runs once for every new seat epoch
(a fresh seat, an adopted conversation, a rotation), started from the seat
command's one activation point and never awaited, so rotation is exactly as
fast as it is today. It reaches the orchestrator as a **queued message**, the
channel the deputy note already uses: it lands as the turn after the one in
which the successor reads its handoff, it never interrupts that turn, and it
arrives whether the seat tick is on or off. What the rotation envelope
carries shrinks: the handoff's own open-task list (up to about 2.4 KB) is
replaced by one line pointing at the report, and that pays for the 1.3 KB
mandate section that tells the orchestrator to verify before acting. GitHub
is read only when the project's origin remote is on `github.com`, with one
GraphQL query that ranks open issues by the Project `Priority`/`Urgency`
fields, priority labels and milestones, and states the evidence behind each
rank; with no priority signal it says so in one neutral line, lists the
newest few and ranks nothing. A model is not needed for anything the report
states. The only judgement left (which issue to start, what to close) is the
one the requirement gives to the orchestrator, and it asks the operator
before closing a card that only the operator's own sessions hold. The
operator settled all three open choices this way on 2026-09-27 (§12): no
model, rank only by recorded priority, ask before closing the operator's
cards.

## 1. What exists today

### 1.1 Rotation and its handoff

`executeOrchestratorRotation` (`src/lib/orchestrator/seatCommand.ts:1257`)
composes the successor's mandate as core + one `## Rotation history` section +
one fresh handoff (#1067, `docs/design/orchestrator-handoff-compaction.md`).
The fresh handoff (`seatCommand.ts:1326-1345`) carries a header naming the
predecessor and the exact `conversation_messages` call that reads its turns,
the caller's notes (at most 2 000 characters), and **the project's open board
tasks**: at most 12 (`HANDOFF_TASK_CAP`, `:1183`), each `[status] text (id)`
with the text cut at 140 characters (`:1184`, `:1342`). Status and title are
all it says; nothing about whether anything is running.

The whole delivered mandate must fit `MAX_STRUCTURED_TEXT_BYTES` = 32 000
(`src/lib/runtime/structuredContent.ts:40`). Measured at `803296a6` in a
sandboxed state directory:

| Piece | Bytes |
| --- | --- |
| Default core mandate (v29) | 21 562 |
| Core as delivered, with directives and the default role table | 24 253 |
| Spawn-mode role scaffold (`launchOverheadBytes`) | 1 201 |
| **Left for rotation history + fresh handoff** | **6 546** |
| Rotation history budget (`HISTORY_BUDGET_BYTES`, `handoffDigest.ts:41`) | up to 4 096 |
| Handoff header (predecessor line and read call) | about 700 to 900 |
| Handoff task list (12 × about 200) | up to about 2 400 |
| Caller notes | up to about 2 000 |

A rotation with notes and a full task list already exceeds the 6 546 bytes,
and `composeSuccessorMandate` drops the history first. Every byte added to the
core or the handoff comes out of the rotation history.

The last rotation of this project's seat (2026-09-27 19:24 UTC, read through
`get_orchestrator`) shows what the task list is worth. It listed six open
tasks: two cards of earlier, revoked manager seats, one leftover reviewer
card still carrying its launch placeholder title, two monitor notices in the
inbox, and one real piece of work. Nothing in it said which of them had
anything running.

### 1.2 The one model in rotation today

`summarizeHandoffsHeadless` (`handoffDigest.ts:537`) compacts earlier
handoffs into the history section: one headless Codex turn on the light
general model (`CODEX_LUNA_MODEL`, effort `low`, `:49`), read-only sandbox,
empty working directory, no MCP servers, 75 s timeout (`:47`), identity and
credential redaction on the way in and out, and a deterministic verbatim
fallback on every unhappy path. Rotation never blocks on it beyond that one
bounded try. It was the precedent for the model variant the operator
declined (§9).

### 1.3 The seat tick already derives most of the report

The seat tick (#1245, `src/lib/monitor/seatTickController.ts`) is the
Viewer's clock: every 5 minutes it gathers durable state per project
(`gatherSeatTickInput`, `src/lib/monitor/seatTickSources.ts:2054`) and wakes
the seat when something is owed. What a wake already derives, as reason kinds
(`src/lib/monitor/types.ts:182-210`): `own-lane-settled`, `lane-event`,
`unmerged-pr` (a lane finished and left a pull request open), `stalled` (a
parked or non-progressing lane or child, seen at two checks), `unstarted-task`
(an assigned task nothing started), `child-terminal`, `deploy-settled`,
`permission-request`, `interval`. Its sources are the pipeline store, the task
store, the agent registry, the liveness snapshot behind `agent_activity`, the
lifecycle journal and `gh pr list` (`openPullRequestsForRepo`,
`src/lib/monitor/githubEvidence.ts:232`).

Three of its fences make a wake the wrong carrier for this report:

- A seat whose turn is progressing is skipped and the check dropped
  (`src/lib/monitor/seatTick.ts:1084`). Right after a rotation the successor
  is busy with its first turn, which is exactly when the report is needed.
  Since #2293 a wake that is sent goes with delivery policy `queue`, so it
  waits for the seat to go idle; the check that finds the seat busy still
  sends nothing (`seatTick.ts:1096` on `70ab3aa0`).
- A project whose tick is off gets no wake at all (`seatTick.ts:1213`). This
  project's tick was off on 2026-09-27, with the reason "1", and the board
  showed the notice card for it.
- A wake is bounded at 4 000 characters (`src/lib/monitor/report.ts:111`) and
  shares them with its agenda.

The tick also has a **proposal slot**: when no lane is open and no task
waits, once per 24 hours (`seatTick.ts:1433`), it lists up to 40 open issues
with their labels (`openIssuesForProposal`, `githubEvidence.ts:249`) and asks
the seat to rank them onto one inbox card (`seatTickProposalMessage`,
`report.ts:322`). That is the nearest existing answer to the GitHub half of
the requirement; it reads labels only and runs only on an idle board.

### 1.4 The mandate today

- The initial status directive (`src/lib/orchestrator/prompt.ts:112`): a
  fresh seat greets in two lines; a rotated seat inventories its missions
  and states its plan in its first turn.
- The clock contract (`prompt.ts:140`): after the items a wake lists, "make
  ONE bounded pass over this project's whole board": `list_pipelines`,
  `list_flows`, `agent_activity` with `liveOnly`, open tasks with nothing
  running. This is the board walk the operator now wants taken off the
  orchestrator at start.
- Task ownership (`prompt.ts:294`): "Never close containers in bulk to tidy
  the board."
- Start-by-default applies when the operator asks for work; the greeting
  promises "Nothing starts until you ask."
- The role table rule (`prompt.ts:424`, enforced by
  `src/lib/roles/sizing.test.ts:32`): "Sonnet and Haiku never run
  orchestrator, architect, reviewer or verifier, nor a hand-set builder."

### 1.5 Deputies

A deputy (`docs/design/ghost-seat.md`, `src/lib/orchestrator/deputies.ts`)
is a byte-for-byte fork of the seat's transcript that answers one side ask
under the seat's attribution: its MCP calls count as the manager's. Two
pieces matter here:

- The fork is the wrong vehicle. A rotation exists to give the seat a fresh
  context, so there is nothing useful to fork at that moment, and a deputy
  acts with the seat's authority, which the requirement reserves for the
  orchestrator alone.
- Its **seat note** is the right channel. When a deputy ends, the sweep sends
  the seat a bounded note with delivery policy `queue`
  (`src/lib/orchestrator/deputySweep.ts:102-112`), so it lands as the seat's
  next turn, after the running one, and never interrupts it. The origin is a
  Delegatus controller (`delegatusMessageOrigin`,
  `src/lib/runtime/agentMessageAuthor.ts:55`), so the feed never draws it as
  the operator's turn. When the target has no live host yet, the delivery
  layer holds the message and delivers it once the host exists
  (`enqueueStructuredMessage`, `src/lib/runtime/structuredMessageDelivery.ts:817`).

### 1.6 The MCP reads

The orchestrator's own reads for the same facts are `list_tasks` (openOnly),
`list_pipelines` (`state: "open"`, compact), `list_flows`, `agent_activity`
(`liveOnly`), `board_snapshot`, `get_orchestrator` and `deployment_status`.
Each is a thin wrapper over an in-process store the pass can call directly.
`agent_activity` is classed as a writing tool (`src/lib/mcp/server.ts:127`)
because it appends the stalls it finds to the lifecycle journal; the pass
reads liveness through the same snapshot function the tick uses
(`agentLivenessSnapshot`, via `defaultSeatTickSources`).

### 1.7 GitHub, observed

The origin remote is read from local git metadata without a subprocess
(`repositoryForProjectRoot`, `src/lib/projects/git.ts:80`; `github.com`
only, `githubRepositoryFromRemote`, `:4`). Observations with `gh` 2.99 on two
projects on this machine, read-only, 2026-09-27:

| | This repository | Project B (a service repository) |
| --- | --- | --- |
| Open issues | 298 | 198 |
| Unlabelled | 214 | few |
| Priority label | 2 (`priority: urgent`, both untouched since July) | none |
| Milestones | none | none |
| On a GitHub Project | none | all 198 |
| Project fields | | `Priority` (Critical/High/Medium/Low), `Urgency`, `Impact`, `Size`, `Status` (Backlog, Discovery, Ready, In Progress, In Review, Blocked, On Hold, Cancelled) |

`gh issue list --json projectItems` returns the Project's `Status` and none
of its custom fields. `gh project item-list` returns them, took 20 s, stops at
500 items and includes closed ones. One `gh api graphql` query over
`repository.issues(states: OPEN, first: 100)` with labels, milestone and the
single-select field values of each project item answered in 2.1 s with
63 KB for 100 issues, which covers both projects in at most two pages.

So priority lives in different places per project, and in this repository it
barely exists. A ranking must say which signal it used, and say plainly when
there is none.

### 1.8 Boards, observed

This project: 9 open tasks, 3 open lanes, 3 open pull requests. Project B:
95 open tasks, no open lane; about 30 of the tasks are cards titled
"Codex session" that still carry their placeholder title, hold one ended
session each, and were hidden from the board by the operator; several more
are cards of earlier seats and duplicate monitor notices. A report that
lists every open task would be 13 KB for project B, so it has to group.

### 1.9 Prior work

`search_transcripts` in six phrasings, project-scoped then unscoped
("board maintenance report rotation", "maintenance доски отчёт оркестратор",
"слабенькая нейронка пройдётся по задачам", "proposal slot open issues ranked
seat tick", "successor first wake after rotation board inventory", "GitHub
issues priority labels project fields milestone rank"): the only hits are
the operator's message above and this lane's own brief. No earlier design of
a board report exists. The nearest shipped pieces are the ones in §1.1 to
§1.5: the handoff task list, the tick's proposal slot and the deputy note.

## 2. Options considered

| Option | What it is | Verdict |
| --- | --- | --- |
| A. Spawned light-model reporter | A Sonnet/Haiku or Luna agent launched at rotation with the MCP read tools, told to walk the board and write a report. The operator's first idea. | Rejected. It needs an account with capacity at rotation time, a conversation, and a board card (every launch mints or joins one). It takes minutes. "Read-only" would be a prompt instruction, and the MCP surface it holds includes writers. And a model reading 95 tasks can drop or invent rows, which is the failure the operator named. |
| B. Headless one-shot model over gathered facts | The Viewer gathers state and a light model writes the report, like the handoff digest. | Rejected for the facts. The gathering is the whole work; the model would only rephrase rows the code already has, at up to 75 s and with the same risk of dropping or inventing one. Its narrow form, labelled notes after the facts, was offered as D1 (b) and declined (§9). |
| C. Deterministic Viewer pass | The Viewer computes the report from durable state and renders it. | **Chosen.** Zero model error on facts, a few seconds, no account, no card, no authority. |
| D. Deputy fork | A fork of the seat does the board walk. | Rejected (§1.5): nothing to fork at rotation, and it acts as the seat. |

## 3. Decision 1: what is deterministic, and what would need a model

Everything the report states is deterministic. Each section is a rule over
stores the tick already reads; nothing is inferred from prose.

| Report item | Source | Rule |
| --- | --- | --- |
| Decisions waiting | pipeline store; permission requests the tick reads | lane in `needs_decision`, or a pending tool permission request on a lane stage or child (`permission-request`) |
| Ready to finish | pipeline store; `openPullRequestsForRepo`; task store | lane `completed` with its head's pull request open (the tick's `unmerged-pr`, with `mergeBlocked` and `lastFixUnreviewed`); lane in `needs_review`; a task whose every linked lane completed and whose pull request merged, still open |
| Stuck | liveness snapshot; pipeline store; seat lineage children | a stage or child agent `stalled` (silent past `stallAfterMs` under a live host, or a dead host over an open turn); lane failed or failed to spawn; each with the agent's last 160 characters of assistant text, quoted and redacted (the `childFinalMessage` reader) |
| Running | pipeline store; liveness | open lane with a live, progressing stage agent: id, title, stage, attempt, age |
| Tasks with nothing running | task store; lane membership; liveness | `assigned` task with no open lane and no live agent among its assignments (never started, or its last agent ended); `blocked` tasks with their age |
| Close candidates | task store; seat file; liveness | see the rule list below |
| Open pull requests no lane carries | `openPullRequestsForRepo` | open pull request whose head branch belongs to no lane on this machine |
| GitHub issues | one GraphQL query (§7) | ranked by explicit signals only |
| Header facts | seat tick settings; board counts; monitor cards | tick on or off with its reason; counts; open Delegatus notices |

Close candidate rules, each named on its line so the orchestrator can check
the rule as well as the row:

- `seat-card`: an open task whose only assignments are revoked orchestrator
  seats of this project. The current seat's own card is never listed.
- `placeholder`: an open task still carrying its launch placeholder title
  (`origin.refinement: "pending"`), with no open lane, no live agent, idle
  for more than 24 hours.
- `finished`: every lane on the task completed and its pull request merged
  or closed, and the task is still open.
- `superseded-pr`: a pull request left open by a finished lane whose task
  already has a newer lane running.
- `duplicate-notice`: two open Delegatus notice cards with the same monitor
  reference; the older one is the candidate.

Two exclusions keep the list inside the orchestrator's remit. Task groups the
operator hid are counted in one line and never listed. A candidate held only
by the operator's own session (a conversation with no spawn lineage from a
seat, a lane or an agent) is marked `operator's own session, ask first`: the
orchestrator closes it only after the operator agrees, while an agent-started
candidate it has verified itself it may close on its own (decision D3, §12).

**What would genuinely need a model**, and why none of it is in the report:

1. Ranking issues that carry no priority signal (214 of 298 here are not
   even labelled).
2. Spotting that a board task and an open issue, or two tasks, describe the
   same work in different words.
3. Reading what a stuck agent's last words mean.

All three are judgement, and the requirement gives judgement to the
orchestrator: "он как project manager ... имея этот отчёт, просто быстро
приоритизоваться, куда сначала посмотреть и что действительно позакрывать".
The report hands the orchestrator the evidence for each (the unranked
issues, the task titles, the quoted last words) and the orchestrator, an
Opus-class seat, decides. A light model placed in front of that decision
would add a second opinion the orchestrator must still verify, at the risk
the operator named. The operator chose the deterministic report alone
(D1 (a), §12).

## 4. Decision 2: runtime and role

The report has **no runtime and no role**. It is code running in the Viewer
process of the release that owns traffic, the same process that runs the
seat command and the seat tick. It holds no account, starts no conversation,
mints no board card and holds no MCP client, so it cannot write the board by
construction, and a failure of any part leaves the rotation untouched.

With no model in the pass (D1 (a)), the rule that Sonnet and Haiku never run
orchestrator, architect, reviewer or verifier work is not engaged: no role
is assigned and no agent is spawned. The declined model-notes variant, and
how it would have respected that rule, is kept in §9.

## 5. Decision 3: when it runs and how it reaches the orchestrator

### 5.1 Trigger

Once per **new seat epoch**, whatever produced it: `create_orchestrator`
spawning a fresh seat, adoption of an existing conversation, or
`rotate_orchestrator`. All three go through `activate()` in
`src/lib/orchestrator/seatCommand.ts:473`, the one step that completes a seat
intent. After it returns an active seat, the command calls
`startBoardReport({ project, seatEpoch, conversationId, path })` and does not
await it. The rotation answer, its timing and its failure modes are
unchanged.

`startBoardReport` first **claims** the epoch: one row per project in a new
`state.sqlite` collection (`orchestratorBoardReports`, through
`SqliteStateCollection`, as `docs/design/state-sqlite-migration.md` §1
requires of new durable stores), written only when the row's epoch is lower
than this one. A second activation of the same epoch (a reconciled launch, a
retried request) finds the claim and returns. The row records
`{ project, seatEpoch, clientMessageId, claimedAt, sentAt, outcome, bytes,
counts, gaps }`; the text itself lives in the seat's transcript once
delivered.

No on-demand trigger and no retry sweep in the first slice (§9).

### 5.2 Composition

1. Gather with the tick's own ports (`defaultSeatTickSources()`): pipelines,
   tasks, registry, liveness, the seat's children, tick settings. The pass
   reads; it advances no tick cursor, writes no stall memory, raises no card
   and records no wake. The tick's state is left exactly as it was.
2. In parallel, when the project resolves to a `github.com` repository: the
   open pull requests (`openPullRequestsForRepo`) and the ranked issues query
   (§7), 20 s timeout each.
3. Render (§6). A source that failed or timed out becomes a named gap in the
   header, and the sections that rest on it say "unavailable".
4. Whole budget 30 s from the claim. Whatever has not answered by then is a
   gap; the report goes out with what stands.

### 5.3 Delivery

Before sending, re-read the project's active seat. If its epoch or
conversation moved (a second rotation in the meantime), record
`superseded` and send nothing. If every section is empty and GitHub is not
configured, record `empty` and send nothing: a fresh seat on an empty board
already greets, and a turn that says nothing costs a turn.

Otherwise `enqueueStructuredMessage` with:

- `policy: "queue"`: the report lands after the running turn, which is the
  successor's first turn reading its handoff. Seat wakes use the same policy
  since #2293, so the two controller messages wait for idle in the same way
  and the report, queued first, lands first;
- `origin: delegatusMessageOrigin("board-maintenance", project)`: the feed
  draws it as a Delegatus controller message;
- `clientMessageId: "board_report_" + sha256(project + ":" + seatEpoch)[0:40]`:
  a replay of the same epoch is the same message to the delivery layer.

A host that does not exist yet (a spawn still booting) is covered by the
delivery layer's existing hold (§1.5). The row records `sentAt` and the
layer's answer.

The resulting order, for a rotation:

```
rotate_orchestrator ──► compose mandate ──► spawn successor ──► activate()
                                                                  │
                         successor turn 1: read handoff,          ├─► startBoardReport (not awaited)
                         status line                              │     gather ‖ gh (≤ 30 s)
                              │                                   │     render ≤ 6 000 B
                              │                                   │     enqueue, policy queue
                              ▼                                   ▼
                         successor turn 2: the report ◄── queued message lands after turn 1
```

The successor's first turn takes about a minute (the seat's turn p50 was
54 s in `docs/design/ghost-seat.md` §1); the report takes a few seconds, so
it is normally queued before turn 1 ends. When turn 1 ended first, the queued
message simply starts turn 2.

### 5.4 Why not inside the handoff, and why not as a wake

- **Inside the handoff.** It would put up to 6 KB into an envelope that has
  6.5 KB left and already drops history (§1.1). It would also make the
  rotation wait for the pass, and a fresh seat has no handoff to carry it.
- **As the first wake.** A wake is skipped while the seat is busy, which it
  is right after rotation; it is never sent while the tick is off, as it is
  on this project today; and it has 4 000 characters shared with its agenda.
- **As a report the first turn reads through a tool.** The first turn would
  wait on, or race with, a pass it cannot see, and a new read tool would
  repeat reads the orchestrator already has.

### 5.5 The envelope gets smaller

The handoff's open-task list is superseded by the report, which lists every
open task by state. The list becomes one fixed line in the handoff header:

> The board maintenance report, a separate message Delegatus sends after this
> mandate, lists this project's open tasks and their state.

and the branch for a lineage with no readable turns says "reconstruct state
from the board maintenance report and from the notes in this mandate". That
removes up to about 2 400 bytes and adds 133, which pays for the mandate
section in §8 (1 274 bytes) with about 1 KB left over for rotation history.
`HANDOFF_TASK_CAP`, `HANDOFF_TASK_TEXT_CAP` and the
`projectTasks` dependency go.

### 5.6 Interaction with the seat tick

None by design. The pass touches no tick state, and the tick skips the seat
while the report's turn runs. A wake after that may name an item the report
already covered (an unmerged pull request, a stall); the orchestrator reads
the current state either way, and the tick's interval and retry guard bound
the repeat. Since #2293 the tick remembers the stalls a landed wake named
(`reportedStalls`) and lists an unmoved one after the unstarted tasks; a
rotation starts that memory empty, so the successor's first wake may list a
stall the report already quoted ahead of those tasks, once. Writing the
report's stalls into that memory is deferred (§9).

## 6. Decision 4: the report's shape and bound

Plain text, English (agent-facing, as the deputy note is), at most
**6 000 bytes** in UTF-8, the same bound as the predecessor report a
rotation reads (`PREDECESSOR_REPORT_CAP_BYTES`, `handoffDigest.ts:44`).
Credentials are removed with `redactMonitorText` before bounding, as a wake's
text is. Titles are cut at 80 characters, lines at 200. Ids are the full ids
the tools accept.

```
[Delegatus] Board maintenance report — <project name>, seat epoch <n>, as of <YYYY-MM-DD HH:MM> UTC
Read-only: computed by Delegatus from the board, lanes, agent liveness and GitHub at that time. Nothing was changed. Verify each item before you act on it.
Seat tick: <on, every <m> min | off since <date>: "<reason>">. Evidence unavailable: <none | <source>: <reason>; …>.
Counts: <t> open tasks (<a> assigned, <b> blocked, <i> inbox), <l> open lanes, <p> open pull requests, <g> agents live, <s> stalled.
Notices on the board: <titles of open Delegatus notice cards | none>.

1. Decisions waiting on the operator (<n>) | : none.
- lane <id> «<title>» needs_decision at <stage> for <age>: <first line of the question>
- permission request in <lane <id> stage <stage> | conversation <id> «<title>»>, waiting <age>
2. Ready to finish (<n>) | : none.
- lane <id> «<title>» completed <age> ago, pull request #<n> open; merge <state>[; last fix not re-reviewed][; its task has a newer lane <id> running]
- lane <id> «<title>» needs_review: review budget spent at <stage>
- task <id> [<status>] «<title>»: every lane completed, pull request #<n> merged <age> ago
3. Stuck (<n>) | : none.
- lane <id> stage <stage>: agent silent <age>, host <alive|dead>; last words: «<≤160 chars>»
- lane <id> «<title>» failed at <stage>: <reason ≤100 chars>
- conversation <id> «<title>», spawned by <this seat | an earlier seat>: stalled <age>
4. Running (<n>) | : none.
- lane <id> «<title>» at <stage>, attempt <k>, <age>
5. Tasks with nothing running (<n>) | : none.
- task <id> [assigned] «<title>», idle <age>: <never started | its last agent ended <age> ago>
- task <id> [blocked] «<title>», blocked <age>
6. Close candidates (<n>), each with the rule that matched          (omitted when none)
- task <id> [<status>] «<title>»: <rule>, <evidence>[; operator's own session, ask first]
- pull request #<n> «<title>»: superseded-pr, <evidence>
(<k> task groups hidden by the operator are not listed.)
7. Open pull requests no lane here carries (<n>)                   (omitted when none)
- pull request #<n> «<title>», updated <age> ago
8. GitHub issues (<open count> open) | GitHub: not configured for this project. | GitHub: unavailable (<reason>).
[Ranked by <signals used>. ][No recorded priority on <n> of them (read: Project Priority and Urgency fields, priority labels, milestones).][ <k> are already on the board, have an open pull request or are not open for work.]
<Worth starting now | Highest ranked>:                             (omitted when nothing is ranked)
- #<n> «<title>» — <Priority High · Urgency Soon · Status Ready · milestone <title> due <date>> · open <age>[, never updated]
Next by rank: #<a>, #<b>, #<c>.                                    (omitted when none)
Newest without a recorded priority: #<x>, #<y>, #<z>.              (omitted when none)
```

In the template, square brackets around a clause mark it optional: it is
left out when it has nothing to say. The `[<status>]` after a task id is
printed as is.

The "No recorded priority" sentence is the only thing the report says about
issues nobody prioritised: it names what was read, so the orchestrator can
check it, and it asks nobody to label anything.

Caps, in rows: 8 per section for 1 to 3 and 5, 10 for 4 and 6, 5 for 7,
3 suggestions and 5 "next" numbers for 8. A capped section ends with
"(<k> more)". When the rendered text is still over 6 000 bytes, sections are
cut from the bottom of their own row lists in this order: 4, 7, 6, 8 "next",
5. The header, the gaps line and sections 1 to 3 are never cut; with their
caps they cannot exceed about 3 500 bytes.

Rendered by hand from this project's board at 20:00 UTC on 2026-09-27, as if
the seat had rotated then (ids shortened with `…` here only), 2 476 bytes:

```
[Delegatus] Board maintenance report — live-log-viewer-next, seat epoch 16, as of 2026-09-27 20:00 UTC
Read-only: computed by Delegatus from the board, lanes, agent liveness and GitHub at that time. Nothing was changed. Verify each item before you act on it.
Seat tick: off since 2026-09-26: "1". Evidence unavailable: none.
Counts: 8 open tasks (6 assigned, 0 blocked, 2 inbox), 3 open lanes, 3 open pull requests, 3 agents live, 0 stalled.
Notices on the board: «Orchestrator seat cannot use its Viewer MCP», «This project's seat tick is not on its default settings».

1. Decisions waiting on the operator: none.
2. Ready to finish (1)
- lane f6cdfe4e «MCP launcher follows the installed self-update release» completed, pull request #2258 open; its task has a newer lane 8fe84695 running
3. Stuck: none.
4. Running (3)
- lane d774ba3f «Design: board maintenance report handed to the orchestrator at rotation» at design, attempt 1, 12 min
- lane cc8016b5 «One consistent, stack-neutral prompt contract for every Delegatus agent» at audit, attempt 1, 15 min
- lane 8fe84695 «MCP launcher follows the installed self-update release (on current main)» at build, attempt 1, 15 min
5. Tasks with nothing running: none.
6. Close candidates (3), each with the rule that matched
- task 4e5f2721… [assigned] «Manager seat for live-log-viewer-next (Delegatus)»: seat-card, held only by a revoked seat
- task 302e4be9… [assigned] «Manager seat for live-log-viewer-next (rotation)»: seat-card, held only by a revoked seat
- task 8b5edc96… [assigned] «You are the reviewer in an implement-review loop. Working directory: …»: placeholder, no lane, no live agent, idle 27 h
7. Open pull requests no lane here carries (2)
- pull request #2270 «Count Activity by team member and limit remote pulls», updated 4 min ago
- pull request #2269 «MCP launcher follows installed self-update release», updated 8 min ago
8. GitHub issues (298 open)
Ranked by priority label. No recorded priority on 296 of them (read: Project Priority and Urgency fields, priority labels, milestones).
Worth starting now:
- #300 «Codex runtime: pin generated app-server protocol and negotiate capabilities» — label priority: urgent · no status · open 74 days, never updated
- #302 «Codex runtime: typed approval router with restart-safe request replay» — label priority: urgent · no status · open 74 days, never updated
Newest without a recorded priority: #2261, #2259, #2257.
```

What the orchestrator gets from it in one read: nothing is stuck and nothing
waits on the operator; one finished lane left a pull request that is probably
superseded; three cards can likely be closed once checked; the tick is off;
GitHub's only recorded priority is two urgent-labelled issues nobody has
touched since July. Today's handoff gave it six task titles.

## 7. Decision 5: GitHub, optional

**Detection.** The project root is the seat's launch working directory
resolved to its repository root (`repositoryRootForPath`,
`src/lib/projects/identity.ts:91`), else the folder the project was recorded
at (`recordedProjectRoot`, `seatCommand.ts:217`), else the newest lane's
`repoDir` (`repoDirForProject`, `seatTickSources.ts:1260`). "GitHub is
configured" means `repositoryForProjectRoot(root)` names an `owner/name` on
`github.com`: a read of local git metadata, no subprocess. Anything else
(no remote, another forge, no root) renders `GitHub: not configured for this
project.` and runs no `gh` at all. A configured project whose `gh` is missing,
unauthenticated, rate-limited, slow or malformed renders `GitHub:
unavailable (<timed-out | command-failed | malformed-output>)`, the same
coarse classes `githubUnavailableFromError` already uses, and the rest of the
report stands.

**Query.** One `gh api graphql` call with `-F owner -F name`:
`repository.issues(states: OPEN, first: 100, orderBy: {field: UPDATED_AT,
direction: DESC})` with `number title createdAt updatedAt`, `labels(first:
10)`, `milestone { title dueOn }`, `issueType { name }`, `blockedBy(first:
1) { totalCount }`, `closedByPullRequestsReferences(first: 1,
includeClosedPrs: false) { totalCount }`, and `projectItems(first: 3)` with
the single-select field values (`name` and `field.name`). This exact query
answered in 0.74 s (38 KB) on this repository and the narrower one in §1.7 in
2.1 s on project B. A second page only when
`totalCount` exceeds 100 and the first page ranked nothing above
`medium`, so the cost is one call, about 2 s, in the common case. If the
answer carries errors for `projectItems` (a token without Project scope), the
call is repeated once without `projectItems` and the ranking line says
"Project fields unreadable". Nothing is ever written to GitHub.

**Excluded before ranking**: issues already on the board (the number appears
as `#<n>` in an open task's text or details, in an open lane's title, or in
its branch name), issues with an open pull request that closes them, issues
with open `blockedBy` issues, and issues whose Project `Status` reads as
done, cancelled, blocked, on hold, in progress or in review (matched on the
option name with emoji and punctuation removed, lower-cased, against a short
synonym list). They are counted in one line.

**Rank key**, each part taken only where present, and printed on every
suggested row:

1. Tier from the first signal found: a Project single-select field named
   `Priority`, then one named `Urgency`, then a label matching
   `priority[:/ -]<level>`, `p0`–`p3`, `critical` or `urgent`. Levels map by
   name: critical, urgent, blocker, p0 → 0; high, soon, p1 → 1; medium,
   normal, p2 → 2; low, whenever, p3 → 3. An option name outside the list
   ranks as 2 and is printed as found.
2. Readiness: Project `Status` reading as ready or todo, or a label reading
   `ready` or `ready-for-agent`, before backlog, discovery and no status.
3. Milestone due date, soonest first; an issue with a milestone and no date
   after dated ones.
4. Age: the oldest created first, the one that has waited longest.

Only an issue that carries a tier or a milestone is ranked; one with a
milestone and no tier sorts after every tiered issue. Readiness orders
ranked issues and never ranks one by itself, since it records state and
says nothing about priority. Every other issue is unranked (decision D2,
§12).

**Suggestion.** "Worth starting now" is the top three of tier 0 or 1 that
are ready or have no status. When nothing reaches tier 1, the section lists
the top three with their tier printed and heads them "Highest ranked" in
place of "Worth starting now". Unranked issues get the one neutral line of
§6 and the newest three by update, in that order and under that name. The
section invents no order and suggests no labelling scheme.

What the orchestrator does with it is the mandate's business (§8): it offers
the suggestions to the operator and starts none unasked.

## 8. Decision 6: the mandate section

For the concurrent prompt-contract lane (`cc8016b5`, rewriting the mandate
toward v30) to absorb as written or reword. It names no stack, no product
internals and no forge beyond "GitHub", and it states four rules the rest of
the mandate already implies, so the lane can merge it with those without
contradiction: verify before acting, the orchestrator alone changes the
board, no bulk closing, nothing starts unasked. It also carries the
operator's decisions D2 and D3 (§12) as two sentences. 1 274 bytes.

```
## Board maintenance report — read it, verify, then act
When you are seated, fresh or by rotation, Delegatus makes one read-only pass over this project's board and sends you the result as a separate message headed "[Delegatus] Board maintenance report". It lists decisions waiting on the operator, work ready to finish, stuck agents, tasks with nothing running, close candidates and, when the project uses GitHub, the open issues most worth starting.
In your first turn read the handoff and give your status; leave the board walk to the report. When it arrives, take its sections in order. It is a snapshot of the moment it names: re-read each item (get_task, get_pipeline, agent_activity) before you change it, and act only on what you confirmed.
You alone change this board; the report changes nothing. Close items one by one, each with its reason. A card marked "ask first" is held only by the operator's own sessions: close it only when the operator agrees. Suggested issues are proposals: offer them to the operator with suggest_replies and start none unasked. Where the report finds no recorded priority, say so once and do not ask the operator to label issues or add fields. A section marked unavailable, or a report that never came, you cover with your own reads.
```

Consistency notes for that lane:

- **Initial status.** The rotated seat's first-turn inventory stays; this
  section only moves the board walk from turn 1 to the report's turn. A fresh
  seat still greets in its two lines first.
- **Clock contract.** Its "ONE bounded pass" after a wake's items is
  unchanged in this slice: steady-state wakes are the tick's business, and
  replacing that pass with the report is deferred (§9).
- **Task ownership.** "Never close containers in bulk to tidy the board"
  stands; "one by one, each with its reason" is its application to the
  report's close candidates.
- **Start-by-default.** Unchanged: it governs work the operator asks for. An
  issue the report suggests is a question to the operator until they answer.
- **Operator's own work (D3).** The "ask first" sentence narrows the task
  ownership rule for close candidates only: a card held solely by the
  operator's own sessions is the operator's to close, and a verified
  agent-started card is the orchestrator's. The lane can fold it into
  whatever the rewritten mandate says about the operator's own agents.
- **No labelling advice (D2).** The priority sentence stops the orchestrator
  from turning "no recorded priority" into a request that the operator
  label issues or add fields. If the rewritten mandate already bars
  unrequested process advice, this sentence can merge into that rule.
- **Version.** The section is a new delivered directive in
  `DELIVERED_DIRECTIVES` keyed by its heading, so seats on older or bespoke
  mandates receive it at their next spawn, adoption or rotation; the default
  version bumps with it. Since #2283 a rotation that names no mandate keeps
  the incumbent's core even when its version is older, so for a running seat
  the delivered directive is the only path by which this section arrives. The
  handoff pointer line in §5.5 is rotation text, outside the core.

## 9. Deferred — not currently justified

- **Model notes (D1 (b), declined by the operator 2026-09-27).** A
  `Model notes (unverified)` section appended after the deterministic report,
  grouping related rows and flagging possible duplicates, deciding nothing.
  Had it been chosen, it would have run exactly as the handoff digest does:
  `runHeadlessCodexOnce` with `CODEX_LUNA_MODEL`, effort `low`, read-only
  sandbox, an empty working directory, no MCP servers, a 60 s timeout, one
  account and one attempt under the project's binding; its input the
  finished report and nothing else; its output at most 1 500 bytes, redacted,
  dropped whole on any failure, and sent only after the facts were queued.
  It would have run as no role and no spawned agent, so the rule that Sonnet
  and Haiku never run orchestrator, architect, reviewer or verifier work
  would not have been touched. Revisit only if the report's record shows the
  orchestrator repeatedly re-deriving the same grouping by hand.
- **A light model writing the whole report (D1 (c), options A and B;
  declined).** The operator's first idea, withdrawn in the same message for
  the error risk it named. Every fact is computable; nothing observed calls
  for it.
- **A heuristic order for issues with no recorded priority (D2 (b),
  declined).** Ordering unsignalled issues by a bug label, then recent
  activity. It would present an order nobody set as if it were a priority.
  The report lists the newest few under a name that says they carry none.
- **Advice on recording priority.** The report and the mandate carry no
  suggestion that the operator label issues or add Project fields (D2). The
  report's one neutral line names the signals it read and stops there.
- **Closing the operator's own cards without asking (D3 (b), declined).**
  The orchestrator may close any card it verified, the operator's included.
  Declined: a card only the operator's own sessions hold waits for the
  operator's word.
- **On-demand report** (a tool or a button). The requirement asks for start
  and rotation; the orchestrator already has every read. Revisit if seats
  are seen walking the board by hand at other moments.
- **Retry sweep.** A Viewer restart inside the pass's few seconds loses that
  report; the claim row shows it (`claimedAt` with no `sentAt`), and the
  mandate tells the orchestrator to cover a missing report with its own
  reads. Add a sweep in the seat tick controller only if the rows show this
  happening.
- **Replacing the wake's bounded board pass with the report** on interval
  wakes. It touches the tick contract and its retry-guard fingerprint, and
  steady state is outside the requirement; the prompt-contract lane may
  propose it with evidence.
- **Feeding the proposal slot from the ranked issues source.** The slot
  (`openIssuesForProposal`) reads labels only. Switching it to §7's ranking
  is one line once §7 exists; left for after, to keep this slice to one
  behaviour change.
- **Project fields beyond Priority, Urgency and Status** (Impact, Size, RICE
  scores), **pinned issues**, **other forges**. None was needed on the two
  boards observed.
- **Recording the report's stalls in the tick's stall memory** (§5.6). It
  would spare one repeated stall line on the successor's first wake, at the
  cost of the pass writing tick state. Revisit if that repeat is seen to push
  unstarted tasks out of a wake.
- **Cards and agents of a linked install.** Linked boards M1 (#2287) shares
  project lists only; task and agent sync are later slices. When those land,
  the close-candidate rules must leave out cards and agents another install
  holds, since this orchestrator cannot verify or close them.
- **A board surface for the report.** It is a message in the seat's own
  feed, drawn as a Delegatus controller message; a card or panel would show
  the same text twice.

## 10. Implementation slice and tests

One lane, builder `size=normal`, touching:

- `src/lib/orchestrator/boardReport.ts`: pure `composeBoardReport(input)`
  over the gathered facts and the GitHub result, with the caps and the
  6 000-byte trimming order of §6; the close-candidate rules of §3.
- `src/lib/orchestrator/boardReportRun.ts`: `startBoardReport` (claim,
  gather through `defaultSeatTickSources`, GitHub, 30 s budget, seat re-read,
  enqueue), with ports for tests.
- `src/lib/monitor/githubEvidence.ts`: `openIssuesRanked` beside
  `openIssuesForProposal`, through the same `githubRunner` seam.
- `src/lib/orchestrator/seatCommand.ts`: the call after `activate()`; the
  handoff pointer line in place of the task list; `projectTasks` removed.
- `src/lib/orchestrator/prompt.ts`: the §8 section, after the
  prompt-contract lane merges, since both edit the mandate.
- The `orchestratorBoardReports` collection.

Tests, each run by its own path (`AGENTS.md` forbids directory sweeps against
live state):

- `boardReport.test.ts`: the example in §6 from a fixture; each close rule
  firing and not firing; operator-hidden cards counted and not listed; a
  candidate held only by operator sessions carries "ask first"; a
  150-task fixture stays under 6 000 bytes and keeps sections 1 to 3 whole;
  gaps render as "unavailable"; an empty board and no GitHub compose to
  `empty`.
- `githubEvidence.test.ts`: ranking by Project field, by label, by
  milestone; readiness alone ranks nothing; the no-signal case ranks nothing,
  prints the neutral line and the newest three, and contains no wording
  about adding labels or fields; Project-scope error retries
  without `projectItems`; non-GitHub remote runs no `gh`.
- `boardReportRun.test.ts`: the claim makes a second activation a no-op; an
  epoch that moved before sending records `superseded` and sends nothing; the
  message carries `policy: "queue"`, the Delegatus origin and the epoch key.
- `seatCommand.test.ts`: rotation answers before the report completes (a
  port that never resolves); the handoff carries the pointer line and no task
  list; a full rotation with notes keeps its history section where the old
  composition dropped it.
- `prompt.test.ts`: the section is delivered once to a bespoke mandate and
  recognized by its heading.

## 11. Validation against the originating requirement

| The operator said | This design |
| --- | --- |
| «когда оркестратор стартует ... если есть GitHub и есть GitHub issue ... посмотреть по приоритетам, предложить, какие есть смысл начинать работать сразу» | §7: on start and rotation, when the project's remote is on GitHub, open issues ranked by the priority the project actually records, with "worth starting now"; §8: the orchestrator proposes them to the operator. |
| «сначала он смотрит на доску ... какая работа ведётся, статус, где кто не завис» | §6 sections 1 to 5: decisions waiting, ready to finish, stuck (with the agent's last words), running, nothing running. |
| «это не должен делать оркестратор ... это должно делаться автоматическим maintenance» | §5: the Viewer runs the pass automatically at every new seat epoch; §8 takes the board walk out of the first turn. |
| «оркестратор может что-то одно взять ... handoff ... а параллельно ...» | §5.3: the pass runs beside the successor's first turn and its report is queued behind it. |
| «слабенькая она может сделать ошибки ... пусть просто пройдётся по задачам ... и даст отчёт» | §3: the walk is code, which cannot misread a row; the operator chose no model at all (D1 (a), §12). |
| «он как project manager, он управляет бордом. Другие ... не должны управлять бордом» | §4: the pass has no authority and no MCP client; §8: "You alone change this board; the report changes nothing." |
| «получить отчёт ... быстро приоритизоваться, куда сначала посмотреть и что ... позакрывать, не позакрывать» | §6 orders the sections by urgency; §3 close candidates name their rule; §8: verify, then close one by one. |
| «после ротации» | §5.1: every rotation, and fresh seats and adoptions as "starts". |

Constraints from the pinned task: project-agnostic agent-facing text (§6,
§8: no stack, no product internals); GitHub optional (§7); fits the envelope
and handoff composition (§5.5 shrinks it); no self-scheduling (the Viewer
sends the report; the seat schedules nothing); no identities or absolute
paths in this document.

## 12. Operator decisions

The three choices this design left open were put to the operator, who
answered on 2026-09-27 in the Delegatus project's orchestrator seat chat,
in Ukrainian, verbatim:

> По дошці все як радить архітектор: без моделі, ранжувати тільки за
> реальними пріоритетами, мої картки без мене не закривати.

("For the board, everything as the architect advises: no model, rank only by
real priorities, do not close my cards without me.")

- **D1. Should a light model take part? Decided: (a), no model.** The report
  is deterministic only (§3, §4). Declined: (b) a `Model notes (unverified)`
  section on the light Codex model, and (c) a light model writing the whole
  report; both are in §9.
- **D2. The GitHub part when priority is barely recorded. Decided: (a).**
  Rank only by the priority signals a project actually records (a Project
  `Priority` or `Urgency` field, a priority label, a milestone); otherwise
  say in one neutral line that there is no recorded priority and list the
  newest few (§6, §7). Neither the report nor the orchestrator suggests
  labelling issues or adding fields (§8). Declined: (b) a heuristic order
  for unsignalled issues (§9).
- **D3. Cards of the operator's own sessions. Decided: (a).** The
  orchestrator asks the operator before closing any card held only by the
  operator's own sessions, and closes agent-started cards it has verified
  itself (§3, §8). Declined: (b) closing any verified card, the operator's
  included (§9).

No operator choice remains open.

The deputy note and board report now join a running turn by steering when the
host supports it, and fall back to the next turn on the durable queue.
