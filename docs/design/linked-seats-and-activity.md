# Linked installs: seat-to-seat messages and agent activity across machines

Status: implemented, 2026-10-09. The observation below records the earlier
read-only design stage. Its code claims were checked against `origin/main` at `08e85880b`. The
orchestrator project resolution lane (`b462ead0`) had not landed on `main`
when this was written; §10 says how this design sits on top of it.

The two machines are called **A** and **B**, as in
[linked-installs.md](linked-installs.md) §2.1: A is the machine this stage ran
on, which typed the pairing code and makes every call; B is the machine with
the public HTTPS address, which granted the link and never calls out. A third
install that appears in the observation is called **C**. The project both
machines already link is called **project P**; it is a private repository and
its name stays out of this public document.

## Originating requirement

Operator, 2026-10-09 about 03:00 Kyiv, in the seat chat, verbatim (Russian;
the address of B is replaced by a placeholder):

> Слышишь, вот я вот подключился к пов'язаній із— На вот этом адресе у меня
> вроде бы всё, синхронизация доски есть, всё есть. Но почему-то оркестратор не
> может получается общаться с другим оркестратором. И не синхронизируется
> активность по этим... по одинаковым проектам. `<B's public address>`

In English: the board sync works, but one orchestrator cannot talk to the
other, and activity of the same projects does not sync.

What happened the same night, from the pinned task: the operator told the
orchestrator of a shared project on B to run a production release, while that
project's orchestrator on A had its own deployer holding the release lock; the
two nearly released the same production at once, and A's orchestrator could
only ask the operator for a token or ssh to read the other Delegatus.

The pinned outcomes, verbatim:

> 1. The orchestrator of a project on one linked machine can send a message to
>    the orchestrator of the same project on the other machine, and receives the
>    answer, through the existing link and its authentication: the same
>    send_message_to_orchestrator a seat already uses, with the target machine
>    named when the project is shared, delivered exactly once, attributed to the
>    sending machine and seat, carrying no operator authority (the same rule as
>    a local seat-to-seat relay). It works only for projects both sides share; a
>    revoked or unreachable link is a plain refusal.
> 2. Each orchestrator knows the other exists: the seat's own reads
>    (get_orchestrator, or what its mandate points at) name the other machine's
>    seat for a shared project, so a seat never has to ask the operator whether
>    another orchestrator is working on the same project.
> 3. Agent activity of shared projects is visible on both machines: whatever the
>    observation shows missing (the agent feed for the same project under two
>    keys, the activity records slice, or both) is built or fixed, so the
>    operator sees on each board what agents of the other machine are doing on
>    the shared project.
> 4. Nothing beyond what linked-installs.md §5 allows leaves a host: no
>    transcripts, no remote control, no dispatch.

Validation against these quotes is in [§13](#13-validation-against-the-requirement).

## Prior art

- [linked-installs.md](linked-installs.md), the MVP section: one exchange
  `POST /api/peer/v1/boards/sync` carries tasks, shared lists and agent
  summaries both ways; "no cross-orchestrator messaging in MVP" (M.12). This
  design adds to that exchange and changes none of its rules.
- [synced-task-card.md](synced-task-card.md) §1.2 and §12 found, a week ago,
  that agent rows reach the other machine with no pipeline and almost never a
  task, because the feed reads the raw scan cache. §12 says it "needs its own
  issue". It was never fixed; the observation below meets the same defect.
- [rename-delegatus.md](rename-delegatus.md) §6.7: after the repository rename
  "existing checkouts need no action. `git remote set-url` is optional". True
  for one machine; the observation shows what it does to a link.
- The seat conversation of project P on A, 2026-10-09 about 02:45 Kyiv: "Access
  to the other Delegatus, if you want me to read its messages myself. That
  means a token … in a file under `~/.secrets/`, or an ssh alias for that
  server." Its deployer then released the lock by hand after the operator said
  the other orchestrator deploys.
- `search_transcripts` for "orchestrator on the other linked machine message
  relay", "cross-orchestrator messages linked boards" (project, then
  unscoped) and "deployer release lock other machine orchestrator" found only
  the conversations above; `search_memory` for "linked installs orchestrator
  messaging other machine" found nothing. No earlier design of seat messages
  across machines exists. The `relay.md` design is the external relay service,
  unrelated despite the name.

## 1. Step one: what was observed

Observed on A, 2026-10-09 between 03:00 and 03:10 Kyiv, read-only. Method:
the link files read with every token stripped before printing; `state.sqlite`
and `activity/records.sqlite` opened read-only; the local Viewer's
`GET /api/links/peers`, `GET /api/links/agents` and `GET /api/activity` with
the access key (never printed); the MCP reads `get_orchestrator`,
`list_tasks`, `get_task` and `board_snapshot`; and one
`GET /api/peer/v1/info` to B with the credential A already holds. No POST was
made and no sync was started by hand.

### 1.1 The link

| Fact | Value |
|---|---|
| Links A holds | one, to B, over HTTPS; state `active`, no error, last successful call within a minute of the reading |
| Grants A holds | none (no `links/grants.json`): B never calls A, as M.1 designs |
| B's `GET /api/peer/v1/info` | `200 {v:1, version:1, scopes:["board:sync"], feeds:{boards:1}}`; it names no build and offers no other feed |
| Task cursor on A for B | pull `[7214]`, pushed `[9979]`, both directions covered for project P, B's task wire version 5 |

### 1.2 Which projects are shared, under which keys

A shares one project (`links/shared.json`: `all:false`, one key). B announces
two (the `board_links` row `peer:<B>` on A). Settings on A reads them as:

| Repository | Key on A | Shared on A | Key on B, as B announces it | Shared on B | Link state on A |
|---|---|---|---|---|---|
| project P | P_KEY | yes | P_KEY | yes | `linked` |
| Delegatus | NEW_KEY (A's remote ends in `/delegatus`) | **no** | **OLD_KEY**, named `live-log-viewer-next` | yes | `only-there` |

Two separate things keep Delegatus apart:

1. **A does not share it.** That is the operator's toggle (§12, question 1).
2. **B's clone still points at the pre-rename name.** A key is the SHA-256 of
   the canonical remote (`repositoryProjectIdentity`,
   `src/lib/projects/identity.ts:165`; `canonicalRemote`, `:130`), and B
   announces `live-log-viewer-next`, the last path segment of its recorded
   remote (`sharedProjects`, `src/lib/links/state.ts:88-95`). GitHub
   redirects the old name, so B's clone works and nothing ever told it to
   move. A's alias map holds no entry for OLD_KEY: A never saw that remote. So
   even with both toggles on, A would show `delegatus · Shared here` and
   `live-log-viewer-next · Only on B`, and nothing of that repository would
   sync in either direction.

### 1.3 What the board sync carries for project P

Tasks of project P on A, by the machine that runs them (`machine`, M.4):

| Owner | Tasks | Open |
|---|---|---|
| A, stamped since the project was linked | 3 | 3 |
| A, no `machine` field (written before linking and not since; M.4 "absent means this machine") | 86 | 18 |
| B | 134 | 66 |
| C, an install A is not linked to | 192 | 16 |

C's tasks arrive because B is linked to C and a row relays through B (M.5,
"with three machines a row relays"); A shows them as "runs on <8 hex> (not
linked)". C was active that night: one of its tasks changed at 03:01.

A's seat tried to reach B's seat through the board: it wrote the note
"Оператор: деплоїш ти. Наш замок знімається…" on B's release task. Notes are
local (`GROUP_KEYS`, `src/lib/links/taskWire.ts:97`), so B's seat never saw it.

### 1.4 What the agent feed carries for project P

`GET /api/links/agents?project=P_KEY` on A, the rows received from B:

| | Count |
|---|---|
| agent rows | 45: 42 `done`, 3 `working` |
| rows with `task` | 0 |
| rows with `pl` (pipeline and stage) | 0 |
| titles | 40 "codex agent", 5 "claude agent" |
| lane rows | 24: 13 completed, 8 closed, 3 waiting on a decision |

`get_task` of B's release task answers `remoteAgents: []`. B's three working
agents (a Claude agent, presumably its seat, and two Codex agents, one of them
presumably the release deployer) are indistinguishable on A's board: the row has no role field, no
task and no stage, so the operator reads "On B: 45 agents · 3 working" and
nothing else.

The cause is in the sender, and A runs the same code. `rowFor`
(`src/lib/links/agentFeed.ts:30-53`) reads `file.conversationId` and
`file.durableLineage` from `lastScannedFiles()` (`agentFeed.ts:81`,
`src/lib/scanner/scanCache.ts:1054-1056`). The scan cache carries neither:
both are attached only while a files response is built
(`src/app/api/files/response.ts:439`, `:536-558`). So the stage membership is
never found, the task match falls back to `assignment.path === file.path`,
and the title falls back to "{engine} agent" (`agentFeed.ts:46-47`). The unit
tests hand `rowFor` entries that already carry `conversationId`
(`src/lib/links/agentFeed.test.ts:10-14`), which is why they pass. The rows A
sends to B are anonymous for the same reason (inferred from the code; B's side
cannot be read through the link, §1.7).

### 1.5 Seats

A's seat for project P is designated (epoch 23, active, waiting). Nothing on A
names B's seat: `get_orchestrator` has no field for it, the agent rows carry no
role, and the only trace is B's seat placeholder task ("orchestrator · You are
this project's orchestrator…", owner B), which crossed as an ordinary task.

### 1.6 What /activity shows for B

Nothing. `GET /api/activity` lists one host, this machine; `activity/hosts.json`
does not exist; `records.sqlite` holds rows for host `''` only (873 inputs,
8 419 turns). The peer API has no activity feed (`/info` lists `boards` only),
so the activity slices of linked-installs.md §4 (slices 2–4) are not built.

### 1.7 What could not be observed

B's own view: its seat, the rows it receives from A, its build. B's peer API
answers `info` and `boards/sync`; `boards/sync` is a write exchange and was
not called. Nothing below depends on B's view: every defect found is in code
both machines share, and the fixes are judged by tests with two isolated
installs (§9).

## 2. What is missing, and why

| Symptom the operator named | Cause found | Fixed in |
|---|---|---|
| one orchestrator cannot talk to the other | no message crosses a link; the MVP left it out (M.12) | §3 |
| a seat had to ask whether another orchestrator works on the project | no seat presence on the wire; `get_orchestrator` cannot name a remote seat | §4 |
| activity of project P looks absent | agent rows from B are anonymous: built from the raw scan cache (§1.4) | §5.1 |
| activity of Delegatus does not sync | one repository under two keys (§1.2), and not shared on A | §5.2; the toggle is §12 |
| /activity has no row for B | the activity-records slices are not built | deferred (§11), question 2 in §12 |

## 3. Outcome 1: seat messages over the link

### 3.1 The tool

`send_message_to_orchestrator` (schema `src/lib/mcp/server.ts:4100-4105`) gains
one optional argument:

```
machine?: string   // a linked machine: its label here, its install id, or the 8-hex prefix
```

Absent, nothing changes: the local seat receives the message as today
(`sendMessageToOrchestrator`, `src/lib/mcp/bindings.ts:4774-4831`). Present, the
message goes over the link to the seat of the same project on that machine.
The answer is the same closed outcome vocabulary the tool already has.

Resolution, before any claim is made (the same place `b462ead0` resolves the
project, §10):

1. The project resolves as it does today.
2. `machine` resolves against `linkedContext().links`
   (`src/lib/links/linked.ts:34-61`): a live link whose label matches
   (case-insensitive), whose install id equals it, or whose install prefix
   equals it. This machine's own label or `here` means the local path.
3. The project must be in that link's `projects`, the intersection both sides
   share (`linkedPeer`, `linked.ts:63-65`).

Refusals, each `not-executed` with `nextAction: new-request-permitted`:

| Code | When | Words |
|---|---|---|
| `machine_unknown` | no live link matches | "{machine} is not linked to this machine." |
| `machine_ambiguous` | two links match | the candidates' labels |
| `project_not_linked` | the project is not shared by both | "{project} is not shared with {machine}; both machines must share it." |
| `link_revoked` | the link or grant is revoked | "The link to {machine} was revoked." |
| `peer_unreachable` | A: the link is `failing`. B: A has not called for 15 minutes, the same threshold that greys remote agents (`agentFeed.ts:210`) | "{machine} has not been reachable since {time}." |
| `peer_cannot_relay` | the other side has not advertised seat messages (§7) | "{machine} runs a Delegatus without seat messages; update it." |
| `message_backlog` | 20 messages to that machine are still unacknowledged | "{n} messages to {machine} are still waiting." |
| `message_too_long` | text above 8 000 UTF-16 units | the bound |

### 3.2 Who may send

The same rule as a local relay, applied by the same code:

- only a designated orchestrator seat (`requireOrchestratorRelayCaller`,
  `bindings.ts:6665-6676`; on the HTTP side the seat lookup in
  `admitOrchestratorRelay`, `src/lib/orchestrator/relay.ts:46-56`). Workers,
  pipeline stages and deputies are refused `orchestrator_relay_refused`. The
  voice gateway and the operator have no remote path: a message from them to
  another machine's seat would be the operator steering that machine, which
  §6 rules out;
- the text may not carry Delegatus authority markers or bridge trailers
  (`relay_reserved_metadata`, `relay.ts:59-61`), checked on the sending
  machine and again on the receiving one;
- text only, no attachments (`src/app/api/orchestrator/message/route.ts:29-33`).

The MCP binding (`bindOrchestratorSend`, `bindings.ts:6635-6661`) binds the
target as `{ project, identity: "machine:<installId>" }` and keeps the
downstream key it already derives (`orchestratorSendDownstreamKey`,
`bindings.ts:6631-6633`). The dispatch posts to the Viewer's
`/api/orchestrator/message` (`route.ts:15-50`) with `machine` and
`clientMessageId`. With `machine`, that route authenticates the seat exactly
as now and writes an outbound row (§3.3) where it would call
`conversationHostPOST`. It answers
`{ outcome: "accepted", operationId: "seatmsg_<id>", machine, state: "queued" }`.
A missing remote seat is never created: the receiving machine refuses
(§3.5), and the sending machine creates no local seat either.

Recovery under the original `clientRequestId` reads the outbound row by its
downstream key and never posts again, as the tool's contract requires. The
MCP process reads it from `state.sqlite` read-only, the way
`src/lib/projects/aliases.ts:141` reads collections.

### 3.3 Storage

One new collection, `link_messages`, in `state.sqlite`, opened like
`board_links` (`src/lib/links/boardLinks.ts:12-29`). A separate collection
keeps rollback releases readable, as M.3 reasoned for `task_tombstones`.

```
out:<install>:<id>  { id, link: <install>, key: <downstream key>, p, t, k, at,
                      sentAt?, ack?: { st, code?, at } }
in:<install>:<id>   { id, link: <install>, p, at, receivedAt, k,
                      prelude: { project, text }, t?, st: "received" | "delivering"
                      | "accepted" | "refused", code?, operationId?, lease? }
```

- `id` is a fresh UUID per message; `key` is the downstream key, unique per
  link, so the same logical call finds the same row.
- `k` is 16 hex of SHA-256 over the sending seat's conversation id, the same
  key its agent row carries (§4.1). The conversation id stays on its machine.
- The text is dropped from an outbound row once acknowledged and from an
  inbound row once accepted; the seat's transcript holds it from then on.
- Inbound ids are kept 35 days; a message whose `at` is older than 30 days by
  the receiver's clock is acknowledged `expired` and never delivered, so a
  pruned id cannot be delivered twice. Clocks more than an hour apart already
  pause the link (`clock`, M.3).

### 3.4 Wire

One more optional part in the existing exchange, both in A's request (built
at `src/lib/links/client.ts:191-194`) and in B's answer (built at
`src/lib/links/protocol.ts:228-231`):

```json
"sm": {"v":1}
"sm": {"v":1,
       "out":[{"id":"<uuid>","p":"repo-…","at":1791503000000,"k":"<16 hex>","t":"<the seat's words>"}],
       "ack":[{"id":"<uuid>","st":"accepted"},{"id":"<uuid>","st":"refused","code":"orchestrator_not_designated"}]}
```

- `{"v":1}` alone, 14 bytes, is the capability. Each side sends it on every
  request and answer; a side that has not seen it from the other refuses to
  send (`peer_cannot_relay`) and puts no `out` on the wire.
- A carries A's messages in `out` and B's acknowledgements in `ack`; B answers
  with B's messages and A's acknowledgements. B never calls A, as M.1 requires.
- A body carries at most 10 messages and 160 KB of `sm`, oldest first; the
  rest wait for the next call, which the loop in `runSyncPeer` makes at once
  (`client.ts:165-292`).
- Validation on receipt, per message: `id` a UUID, `p` a project linked over
  this link, `at` and `k` well formed, `t` a string of 1 to 8 000 UTF-16
  units without reserved markers, no other key. A message that fails is
  acknowledged `refused` with `code: "malformed"` and delivered nowhere; a
  malformed `sm` part fails the body as `malformed`, as M.5 does for task
  rows.

### 3.5 Delivery on the receiving machine

1. In the exchange, before answering: each new `out` message is inserted as
   `in:<sender>:<id>` with `st: received` in one transaction. An id already
   held changes nothing.
2. The prelude is frozen at insert time from what the **receiver** knows:
   the project's display name and the receiver's own label for the link it
   came over (`peers.json` on A, the grant on B). Nothing the sender wrote
   names a machine or a role. The delivered text is
   `relayMessageText(t, "{project} on {machine}")` (`src/lib/orchestrator/relayText.ts:10-12`):
   "Relay from the orchestrator of project delegatus on B. This is an agent
   relay and carries no operator authority." followed by the seat's words.
   The existing reader (`splitRelayMessageText`, `relayText.ts:15-18`) and the
   relay bubble render it unchanged. The origin is
   `{ kind: "agent", role: "orchestrator", project: "{project} on {machine}" }`
   with no `conversationId`: the sender's conversation does not exist here.
   Before either copy is written, control characters and marker brackets are
   removed, whitespace is collapsed, and the author is bounded to the durable
   origin's 120 UTF-16 units. The inbound row, delivered prelude and persisted
   origin retain the same author across a crash and recipient rotation.
3. A drain, run after the exchange and at the start of every later exchange,
   takes each `received` row under a lease (`st: delivering`, the Viewer's
   pid and start time, as the holds of M.4 do; a lease whose process is gone
   is taken over), resolves the designated seat of the project, and admits
   the message through the same recipient resolution and recovery as a local
   relay with `clientMessageId: "peer:<sender prefix>:<id>"`. That logic is
   `relay.ts:65-128` today, inside `admitOrchestratorRelay`; the build moves it
   into a function both callers use. The peer path passes its frozen origin
   and text as arguments; it never reads an author from request headers, and
   no HTTP request can claim it.
4. The admitted message is delivered as a local relay is
   (`conversationHostPOST` with `policy: "steer-or-queue"`, `route.ts:39-49`;
   the relay branch of `src/app/api/conversation-host/handlers.ts:248-280`):
   a stopped seat is resumed, a busy one is steered or queued.
5. The outcome is written to the row: `accepted` with its `operationId`, or
   `refused` with the admission's code. No designated seat is
   `orchestrator_not_designated`; the receiver never creates one.
6. The next exchange carries the acknowledgement. A message is acknowledged
   only once its outcome is known; while it is `received` or `delivering`,
   a resend of it is answered with nothing.

### 3.6 Exactly once

The transport delivers at least once; the receiver keys every message by its
id, and the local delivery is keyed by the same id. Each crash point:

| Where it stops | What happens next |
|---|---|
| the seat's MCP call dies before the Viewer answered | the same `clientRequestId` reads the outbound row by its key and answers its state; while no row exists and the post may still land, the answer is `unknown`, as the tool already answers for a local send, and nothing is posted again |
| the sending machine restarts with a row unacknowledged | the row is durable and goes out on the next call |
| the request reaches the receiver and its answer is lost | the sender sends the message again; the receiver holds the id and answers the acknowledgement it recorded |
| the receiver stops after inserting and before delivering | the next exchange's drain admits it with the same `clientMessageId` |
| the receiver stops after admitting and before writing the outcome | the drain admits it again; the existing recovery finds the original send by `clientMessageId` and returns its `operationId` (`lookupOriginalSend`, `relay.ts:101`) |
| two Viewer generations overlap in a succession | the lease lets one drain a row; both may send the same `out`, which the receiver's id check absorbs |
| an acknowledgement in B's answer is lost | A sends the message again and B answers the same acknowledgement |

A new `clientRequestId` with the same words is a new message, as it is for a
local relay.

### 3.7 Receipt and the answer

`message_receipt("seatmsg_<id>")` (`bindings.ts:1662-1672`, through
`resolveSendReceipt`, `src/lib/runtime/sendSettlement.ts:618`) answers from the
outbound row: `queued`, `accepted` (the other machine admitted it to its
seat), `refused` with the code, or `unknown` (the link was removed or the
message expired after it had been sent at least once; `not-delivered` when it
never left). The answer is a separate message: the other seat calls
`send_message_to_orchestrator` with `machine` set to the name in the prelude.

### 3.8 Cadence

- A's schedule calls within one tick when a message to B waits: a new port
  `messagesPending(id)` beside `hasPush` (`src/lib/links/schedule.ts:60`).
- A call that carried a message or an acknowledgement in either direction
  counts as one that moved data, and its burst lasts 10 minutes (`BURST_MS`
  is 2 minutes today, `schedule.ts:17-18`): calls every 10 s while a
  conversation is likely under way.
- A message from B waits for A's next call: within 10 s during a burst, at
  most 5 minutes on an idle link (M.5's interval, unchanged). §12 question 4
  records this default.

### 3.9 Bounds and footprint

| What | Bound |
|---|---|
| idle call | 14 bytes more each way; no row read or written |
| one message | its row once each way (about 200 bytes plus the text), one row write on each side, one update at acknowledgement |
| text | 8 000 UTF-16 units; at most about 48 KB encoded |
| backlog | 20 unacknowledged messages per link direction |
| daily | 200 messages per link direction; beyond it `quota`, shown on the link row |
| disk | ids kept 35 days; text dropped at acknowledgement or acceptance |

## 4. Outcome 2: each seat knows the other exists

### 4.1 Seat presence rides in the agent rows

The agent row (`AgentRow`, `agentFeed.ts:13`) gains two optional fields:

| Field | Value |
|---|---|
| `ro` | the role the registry records for the conversation (`agentRole`, else the lineage edge's role), an ASCII id of at most 64 characters: `orchestrator`, `deployer`, `reviewer`, a preset id |
| `seat` | `1` on the row of the project's designated seat (`orchestratorSeatFor`, `src/lib/orchestrator/seats.ts:546`) |

The seat's row is always published while it is designated: it is exempt from
the 24-hour rule (`agentFeed.ts:41`) and taken first in its project's 50
(`agentFeed.ts:111-120`). Its title is "orchestrator". Both fields need the
registry join of §5.1. A receiver at an older build drops both, because
`decodeAgentRow` rebuilds only known fields (`agentFeed.ts:55-66`).

### 4.2 The seat's own read

`get_orchestrator` (`bindings.ts:3944`) answers, compact and full:

```json
"linkedSeats": [
  {"machine": "B", "install": "<linked install id>", "seat": {"engine": "claude", "model": "claude-opus-5-5", "state": "working",
                            "lastActivity": "2026-10-09T00:01:39Z", "stale": false}}
]
```

one entry per live link that shares the project. The receiver attaches
`install` from its link and joins seat rows by that id, so duplicate machine
labels retain distinct seats. Pass that id as `machine` to address either one.
`seat` is `null` when that
machine advertises seat messages (§3.4) and publishes no seat row for the
project, and `"unknown"` when it runs an older build. The rows come through
`readRemoteAgentRows` (`bindings.ts:5229-5240`), which already reads the
Viewer's `/api/links/agents` (`src/app/api/links/agents/route.ts:14-36`);
that route's `hosts` entries gain `seatMessages: true | false`.

### 4.3 What the mandate points at

- One sentence beside the cross-project line of the default mandate
  (`src/lib/orchestrator/prompt.ts:279`): "A project shared with a linked
  machine has its own seat there; get_orchestrator lists it under
  linkedSeats. Agree with that seat, through send_message_to_orchestrator
  with machine named, before anything both machines touch: a release,
  production, a shared lock." `ORCHESTRATOR_PROMPT_VERSION` moves from 41 to
  42 (`prompt.ts:95`).
- The tool description of `send_message_to_orchestrator`
  (`server.ts:3280`) names `machine` and the refusals.
- A seat running the old mandate gets `linkedSeats` at once and the sentence
  at its next rotation; `get_orchestrator` already reports a stale prompt
  version.

## 5. Outcome 3: activity of shared projects on both boards

### 5.1 Agent rows built from the registry

`rowFor` resolves each scanned transcript to its registry conversation the
way `board_snapshot` already does (`bindings.ts:4991-4995` builds the
path-to-conversation map from every generation and continuity path;
`:5004-5023` reads role and memberships). From the conversation it takes:

- the conversation id, for the task match on `assignment.conversationId`,
  compared only when both sides are strings (today an assignment whose
  `conversationId` is undefined, `src/lib/tasks/types.ts:117`, matches every
  file that has none);
- the pipeline membership (`snapshot.memberships[id]`), for `pl` and for the
  task through the pipeline's `taskIds`;
- the role, for `ro` and for the title of an agent bound to no task, such as
  "deployer agent";
- the designated seat, for `seat`.

`p` passes through `canonicalProject`, so a transcript scanned under an alias
source (§5.2) files under the key the link uses. The registry snapshot is read
only when the feed refreshes, which happens when the scan generation, tasks or
pipelines moved (`agentFeed.ts:87-131`); an idle call reads nothing more.

The existing collapsed rows render the result with no change: `RemoteAgents`
shows the title, `engine · model` and `stage (state)` from `pl`
(`src/components/kanban/RemoteAgents.tsx:14-19`), and a row with `task` sits
under that task's band. On A, B's deployer reads "deployer agent ·
codex · gpt-6.1-sol", under B's release task when B's seat bound it to that
task, and B's seat reads "orchestrator".

### 5.2 One GitHub repository, one key on every machine

**The rule.** A clone whose recorded remote is a GitHub repository that GitHub
now answers under another name (a rename, a transfer, a different letter case)
records a succession from its key to the key of the current name, proven by
the same numeric repository id. That is the proof
`src/lib/projects/forgeRename.ts:18-37` already requires for a re-pointed
origin; this applies it to a clone that was never re-pointed, which
rename-delegatus.md §6.7 allowed.

**The mechanism**, all in existing code paths:

1. `ForgeRepositoryLookup` returns `fullName` beside `id`: `gh api` asks for
   `{id, full_name}` (`forgeRename.ts:110`) and the REST fallback reads
   `full_name` (`:123-139`).
2. A new candidate source, for each key this machine **shares**: the
   recorded remote is `github.com/<owner>/<name>`; one lookup answers the
   current full name; when it differs, the candidate is
   `{ source: key, target: <key of github.com/<current name>> }`.
   `decideForgeRename` (`:161-176`) then asks for both names and records a
   proof only on equal ids; `recordForgeRenames` (`:184-198`) writes the
   succession (`recordProjectSuccessions`,
   `src/lib/projects/succession.ts:107`), which migrates the board, writes the
   alias and one `project_moved` line. The new key's remote is recorded
   (`recordProjectRemote`) so `shareable` (`state.ts:63-68`) accepts it.
3. The check runs detached through `scheduleForgeRenames` (`:205`), once per
   shared key per process and again after 24 hours, when the shared list is
   built for an exchange and when the operator shares a project. Never under a
   pipeline lease. A lookup that cannot be answered decides nothing and is
   asked again later.
4. `sharedProjects()` and `knownProjects()` (`state.ts:88-99`) map each key
   through `canonicalProject` and drop duplicates, so B announces NEW_KEY from
   then on. Tasks under OLD_KEY already read as NEW_KEY
   (`src/lib/tasks/store.ts:44`, `:210`), and so do the seat, the board and
   the scan grouping, which is what the alias is for.

**What it costs and refuses.** At most three GitHub requests per shared key
per boot: one for the current name, then the two the existing rename check
makes. A fork, an unrelated repository, a
missing old name or a non-GitHub remote records nothing, and the two keys stay
apart as today. Once the link exchanges shared lists, B's NEW_KEY meets A's
NEW_KEY, the project starts with a resync like any newly linked project (M.5),
and tasks, lanes and agent rows cross.

**Why at the source.** The alternative, a per-link table that translates keys
at every wire seam (task rows, tombstones, stubs, watermarks, agent rows,
lanes, messages), would touch every part of M.5 and leave the stale key in
every other store on B. One alias on the machine that holds the stale clone
fixes the cause, and its board stops splitting the repository in two as well.

### 5.3 What the operator sees afterwards

| Where | Today | After |
|---|---|---|
| A's board, project P, "On B" | 45 rows, "codex agent" or "claude agent", no stage | rows titled by task, stage or role; stage agents under their task with `stage (state)`; B's seat as "orchestrator" |
| A's board, B's release task | no remote agents | the agents bound to it on B, when B bound them |
| B's board, project P | the same anonymous rows from A (by the code) | the same improvement, from A's build |
| Settings → Linked installs, Delegatus | `delegatus · Shared here` (if shared) and `live-log-viewer-next · Only on B` | one row, `delegatus`, `Linked` once both share it |
| /activity | this machine only | unchanged (§11) |

## 6. Outcome 4: what leaves a host

Added to the fields of linked-installs.md §5.1 and M.6:

| Field | Content | Can it reveal text? |
|---|---|---|
| agent row `ro` | a role id, ASCII, at most 64 characters | no; role ids already cross in activity turns (linked-installs.md §5.1) |
| agent row `seat` | `1` | no |
| message `id`, `at` | a random UUID and a time | no |
| message `p` | a project key both sides share | no |
| message `k` | 16 hex of SHA-256 over the sending seat's conversation id, as on its agent row | no |
| message `t` | the words the sending seat wrote into the tool call, at most 8 000 units | yes, by design: like task text (M.3 amendment), it is written to be read on the other machine |
| `sm.v`, acknowledgements | capability, ids, a state and a refusal code | no |

Still never: transcripts, titles taken from prompts, file paths, cwd,
conversation ids, account names, tokens.

- **No transcript.** A message is the seat's own words from one tool call;
  no code path copies a transcript, a tool result or a file into `t`.
- **No remote control.** A message reaches only the designated seat of the
  same project, as a relay without operator authority: the prelude says so,
  the origin is an agent, and markers are refused on both machines. The
  receiving seat decides what to do. The operator's own messages and the
  voice gateway have no remote path. Nothing stops, steers or starts a
  remote worker. Resuming a stopped seat to deliver the message is what a
  local relay does today.
- **No dispatch.** The receiving Delegatus starts no pipeline, agent or task
  because of a message; a seat that acts on one does so under its own
  mandate and the M.4 guard.
- **One hop.** A message never travels on to a third install. C's seat cannot
  reach A through B, as linked-installs.md §4.2 keeps rows one hop.

Threat, added to linked-installs.md §2.7 and M.8:

| Threat | What happens | Mitigation |
|---|---|---|
| stolen `board:sync` token sends messages | the seat of a shared project reads words attributed to the token's machine | the same reach as task text the token can already write (M.8); no authority; 200 a day; the link row counts them; revoke |
| a message tries to pass as the operator | the receiver builds origin and prelude itself; no wire field sets them | markers refused on both sides; the origin kind is always `agent` |
| a peer claims another machine | attribution is the link the message came over (`peers.json` on A, the grant on B) | the body names no machine |
| prompt injection through `t` | the receiving seat reads it as an agent relay | the mandate's standing rule for relays; nothing executes on arrival |

## 7. Version skew

Each machine runs its own build. Every new field is optional and every new
behaviour waits for the other side's capability:

- an older side ignores unknown request and answer fields: `incomingSync`
  reads named fields only (`protocol.ts:176-232`), `serveTasks` validates only
  `tasks` and `push` (`src/lib/links/taskServe.ts:24-33`), and the client
  reads named answer fields (`client.ts:195-292`);
- an older receiver drops `ro` and `seat` and keeps the row
  (`agentFeed.ts:55-66`);
- the capability `sm.v` gates every message; nothing waits for an
  acknowledgement that cannot come.

| A | B | Messages | Agent rows on A's board | Agent rows on B's board | Delegatus keys |
|---|---|---|---|---|---|
| new | new | both ways | bound, titled, staged; B's seat named | the same from A | linked once both share |
| new | old | refused on A with `peer_cannot_relay`; B cannot send | still anonymous (B builds them) | bound and staged; `ro` and `seat` dropped by B | B keeps OLD_KEY: as today |
| old | new | refused on B with `peer_cannot_relay`; A cannot send | bound and staged from B; `ro` and `seat` dropped by A | still anonymous (A builds them) | B announces NEW_KEY; links if A shares it |

**Which side needs which build.** The operator's visible problems sit on B: its
anonymous rows and its stale key. So B first: after B updates alone, A's board
shows B's agents with their tasks and stages, and the Delegatus repository can
link. Messages need both. Either side updated alone degrades to today's
behaviour with clear refusals, and a rollback finds `link_messages` as an
unknown collection it never opens.

## 8. UI

No component changes and no new chrome. The changes reach the operator
through surfaces that exist:

- the collapsed remote agents under a task band and the "On {peer}" group
  (`RemoteAgents.tsx`, M.7) show the titles, stages and bindings §5.1 fills;
- the receiving seat's conversation shows a message as the existing relay
  bubble, with the project and the sending machine in its first line;
- Settings → Linked installs → Shared projects shows `Linked` for the
  Delegatus repository once both machines share it.

Rendered evidence for the first: one `describe` block in the existing kanban
driver (`src/components/kanban/kanbanBoard.browser.test.tsx`, over
`issue1695Evidence.fixture.tsx`) with a remote deployer row under a task band
and a seat row in the "On {peer}" group, at 390 px and desktop. No variants are
published: there is no design choice to make on screen.

## 9. Failing-first tests

All run by path, with two isolated installs started by
`src/lib/links/boardSync.test.ts` through `src/lib/links/testServer.ts`
(their own `LLV_STATE_DIR`, `HOME` and `TMPDIR` under the OS temp root, ports
bound to `0`, `LLV_VIEWER_CONTROL_URL` on a closed port). None reads the
operator's state, peers or tokens. Fixture names are neutral
(`code.example.test/acme/…`).

The test server gains fixture routes: designate a seat in its isolated seat
store, record a registry conversation with a role and a pipeline membership,
set the forge lookup (`setForgeLookupForTests`), drop the answer after the
receiver committed, and stop after a message was stored. Deliveries go
through the real admission into an isolated registry; a route lists what was
admitted with its `clientMessageId` and origin.

| Seam | Test | Red on `main` because |
|---|---|---|
| message, both ways | A's seat sends to B's seat, B's seat answers: each seat receives exactly one message, its first line names the project and the sending machine by the receiver's label, its origin is an agent with role `orchestrator` and no conversation id | `machine` does not exist; no `sm` part |
| retry | B's answer is dropped after B committed: A sends again, B answers the same acknowledgement, one delivery; the same with A's acknowledgement in its next request lost | no `sm` part |
| restart | B stops after storing and before delivering, then starts: the next exchange delivers once; B stops after admitting and before writing the outcome: one delivery, the original `operationId`; A stops with a message queued: it goes out once after the start | no `sm` part |
| unshared project | project shared on A only: `project_not_linked`, and no captured body carries `sm.out` | no refusal exists |
| revoked link | B revokes the grant: A refuses `link_revoked`; A removes the link: B's seat refuses `link_revoked`; a queued message settles `unknown` or `not-delivered` | no refusal exists |
| unreachable peer | B stopped and A's link `failing`: `peer_unreachable`; on B with the clock moved 16 minutes past A's last call: `peer_unreachable` | no refusal exists |
| authority | text with `<!-- llv:` refused on A; a raw body sent with A's token whose message carries an extra `origin` key, or a reserved marker, is acknowledged `refused`/`malformed` and delivers nothing; a worker and a pipeline stage calling with `machine` get `orchestrator_relay_refused`; the voice gateway gets the same | no remote path exists |
| no seat there | B has no designated seat: acknowledged `refused` with `orchestrator_not_designated`; B creates no seat; A's receipt reads `refused` | no remote path exists |
| older peer | B at `c18ab355` (the existing `oldSource()`, `boardSync.test.ts:117-127`): A refuses `peer_cannot_relay`, tasks and agents keep syncing, no `sm.out` on the wire | `machine` does not exist |
| idle footprint | the idle-call test (`boardSync.test.ts:1057`) holds with the `sm` capability: at most 14 bytes more each way, no row read, no write | the bound is new |
| agent rows | on B, from a real scan (`/test/scan`): a pipeline stage agent, an unbound agent with role `deployer`, and the designated seat. After one call A holds the first with `pl` and its task, the second titled "deployer agent" with `ro`, the third with `seat: 1` titled "orchestrator"; the same from A to B | `rowFor` reads the raw scan cache: no `pl`, no task, "{engine} agent" (§1.4) |
| two keys | A records `github.com/acme/new`, B records `github.com/acme/old`, both share; the forge stub answers both names with id 7 and the full name `acme/new`: after B's next exchange both read `Linked`, and a task and an agent row created on B's old checkout arrive on A under NEW_KEY. The stub answering two ids (a fork): nothing is aliased and the states stay `only-here` and `only-there` | B keeps announcing OLD_KEY |
| `get_orchestrator` | in `src/lib/mcp/orchestratorTools.test.ts`: a received seat row from B names B under `linkedSeats`; a capable peer with no seat row gives `seat: null`; an old peer gives `"unknown"` | the field does not exist |
| recovery | in `src/lib/mcp/orchestratorSendRecovery.test.ts`: the same `clientRequestId` with `machine` reads the outbound row and never posts twice; changed words under the same key are `idempotency_conflict` | `machine` does not exist |
| admission | in `src/lib/orchestrator/relay.test.ts`: the shared recipient and recovery logic gives a local relay and a peer message the same answers; a request with any headers cannot reach the peer path | the shared function does not exist |

The project's own checks then apply: types, ESLint, the touched tests on head
and on the merge base through the pre-push hook, and the privacy gate locally
before every push.

## 10. Fences and coordination

- **Orchestrator project resolution (`b462ead0`).** It resolves the project of
  `send_message_to_orchestrator` before any claim
  (`resolveOrchestratorToolProject` and `orchestratorProjectBinding` on its
  branch). It was not on `main` at `08e85880b`. The build merges `origin/main`
  before review; when the lane has landed, `machine` resolves in the same
  pre-claim step, after the project, and the remote path never reaches the
  local seat creation. Its candidate set should include
  `linkedContext().all` when `machine` is named.
- **Seat auto-rotation (#2577).** If it also moves
  `ORCHESTRATOR_PROMPT_VERSION`, the lane that lands second takes the next
  number.
- **Seat wake and tick (#2346), review budget (`3c2b56d1`), board cleanup
  (`64e94078`).** Untouched: this design reads nothing from and writes nothing
  to the seat tick, the review budget or board maintenance.
- AGENTS.md, the paragraph on keys changing over time, gains one sentence for
  §5.2: a shared GitHub key whose repository GitHub answers under another name
  is aliased to that name's key on the same proof.

## 11. Deferred — not currently justified

| Item | Why deferred |
|---|---|
| The activity-records slices (linked-installs.md §4, slices 2–4: HTTP pull and push of `records.sqlite`, host ids, takeover) | the requirement is to see on each board what the other machine's agents do, which the agent rows carry once §5.1 fixes them; /activity counts hours and inputs, a separate question for the operator (§12, question 2) |
| Syncing task notes | a seat that wants to tell the other seat something now sends a message; notes stay the local agent-facing field |
| Messages to a third install through a link | one hop keeps attribution provable by the link; link C directly if needed |
| The operator or the voice gateway messaging a remote seat | that is steering the other machine from here, which outcome 4 excludes |
| A delivered-to-transcript settlement from the other machine | `accepted` says the other seat's queue holds it; its own delivery guarantee does the rest, and an answer arrives as a message |
| Instant delivery from B to A | B cannot reach A (M.1); a push channel would need A reachable or a relay service, both excluded by linked-installs.md |
| A dedicated peer route for A's messages | the exchange already runs within a tick when something waits; one mechanism serves both directions |
| A per-link key translation table | §5.2: canonicalizing at the source fixes the cause with existing code |
| A Settings control to declare two keys the same project | new chrome; the forge proof covers GitHub, the only forge in use |
| Forge proof for non-GitHub hosts and SSH host aliases (a remote host such as `github-work`) | the remotes observed are plain GitHub; rename-delegatus.md already defers other forges |
| Labels for installs relayed through a peer (C shows as 8 hex) | A cannot act on C's tasks either way; linking C directly gives it a label |
| A message feed on the board | the seat's conversation shows the messages it received; the board shows work |

## 12. Open questions

None of these changes the design; each has a recommended answer and nothing is
built for them.

1. **Share the Delegatus repository on A too?** B shares it, A does not
   (§1.2). After §5.2 ships on B, ticking it in Settings → Linked installs on
   A links it, and its tasks, lanes and agents cross. Recommendation: yes,
   once B runs the new build.
2. **Should /activity count the other machine's hours and inputs?** That is
   the activity half of linked-installs.md (slices 2–4), a larger build than
   everything here. Recommendation: not now; the board shows what the other
   machine's agents do.
3. **Link A to C?** 192 tasks of project P belong to C and reach A through B
   as "not linked"; C's agents and seat stay invisible on A, and A's seat
   cannot message C. Recommendation: link C only if work on project P that
   you need to watch from A runs there.
4. **Decided by default, open to the operator: how long a message from B may
   wait.** On an idle link B's message waits for A's next call, up to 5
   minutes (M.5's interval, set under the footprint rule); within 10 minutes
   of any message, about 10 s. The alternative is a shorter idle interval for
   every linked pair: 10 s means up to 360 calls an hour, where M.9 budgets 12
   for an idle link.

## 13. Validation against the requirement

| Requirement | Where met |
|---|---|
| "оркестратор не может … общаться с другим оркестратором" | §3: the seat's own tool with `machine`, over the existing link and its credential |
| the same `send_message_to_orchestrator`, target machine named when shared | §3.1 |
| delivered exactly once | §3.5, §3.6; tests "retry" and "restart" |
| attributed to the sending machine and seat | §3.5 step 2 (the machine is the link the message came over; the body names none), `k` matching the seat's agent row (§3.3, §4.1) |
| no operator authority, same rule as a local relay | §3.2, §3.5, §6; test "authority" |
| only projects both sides share; revoked or unreachable is a plain refusal | §3.1 refusals; tests "unshared project", "revoked link", "unreachable peer" |
| receives the answer | §3.7: the other seat answers with the same tool; test "message, both ways" |
| each orchestrator knows the other exists | §4: `seat` on the agent row, `linkedSeats` in `get_orchestrator`, one mandate sentence |
| "не синхронизируется активность по … одинаковым проектам" | §5.1 (rows of project P carry task, stage and role), §5.2 (the Delegatus repository under one key); test "agent rows", "two keys" |
| the activity records slice | observed missing (§1.6); deferred with its reason (§11), asked in §12 |
| nothing beyond §5 leaves a host | §6 |
| which side needs which version; does one side alone degrade safely | §7 |
| failing-first tests at the link seams with two isolated installs | §9 |
| no UI chrome | §8 |


## 14. Implementation and verification

Seat messages use the existing authenticated board exchange. Durable inbound
and outbound rows fence retry and process restart; local delivery admission
recovers the original reservation after a receiving seat rotates. Failed
terminal reservations receive a refusal. A queued row also remembers its
connection, so removing and re-pairing an install cannot revive old words.
Revoked-link tombstones contain only the install id and the local label.

The raw scan feed joins registry generations and continuity paths, task
assignments, pipeline membership and designated seats. A designated seat is
published even before its transcript reaches the scan cache. The receiver
retains its seat row within the existing fifty-row project bound. Repository
rename discovery proves both names against the same numeric forge id before
aliasing; fork identities remain separate. Existing board surfaces render
these rows, and the existing browser driver records desktop and phone geometry
in [the evidence record](../../evidence/linked-seats-and-activity/geometry.json).

Failing-first checks cover bidirectional relay, lost answers, sender and
receiver restart, crash before and after delivery admission, truthful terminal
failure, shared-project refusals, revoked and unreachable links, authority,
version downgrade, bounds, registry joins and forge identity. Each install
uses a private state root, home and temporary directory. MCP recovery reads the
original outbound row and never submits another send.

Both installs need this release for messages. Update the granting machine
first, then the calling machine. Either side updated alone continues board
sync and refuses seat messages until the other advertises support. Rich agent
summaries require the sending side's update; optional role and seat fields are
safe for older receivers. Per-host activity records remain deferred as §11
describes; this slice exposes agents of shared projects through the boards.


## 15. Delivery-await and author recovery regressions

The peer response checks the grant and fresh shared-project intersection after
runtime delivery returns. A changed sharing boundary discards the response's
old task, agent and shared-list pages and starts a fresh list handshake. The
caller confirms the current sharing lists before draining received messages
and checks the current link before constructing its next outbound page. When the intersection becomes empty, a waiting
task exchange no longer keeps the handshake running indefinitely.

`src/lib/links/seatMessages.http.test.ts` holds delivery in each direction while
removing sharing or revoking the link. It captures the real peer exchange and
requires queued plaintext, task text and agent project keys to stay off the
wire. Separate cases use legal 100-unit machine labels, including marker
brackets, crash after durable admission before saving the inbound outcome,
restart the receiver, and rotate its seat. Recovery must keep exactly one
reservation with the original operation id and matching author/prelude.

The sharing and author cases failed against the earlier implementation before
the fixes were written. These protections belong on both installs: each host
must check its own export boundary and normalize the messages it receives.
The wire version is unchanged; one upgraded side retains compatibility while
the older host still needs the fixes to protect its own boundary.


## 16. Sharing agreement and fresh local delivery admission

Each sync confirms the current sharing lists before the caller sends queued
message text. The granting side exports messages only when the complete lists
agree; an authorization change during runtime delivery clears that agreement
and starts another handshake. Intermediate shared-list pages contain no
queued words. Pending received messages also wait for the fresh agreement
before reaching local admission, including after a receiver restart. Projects
that remain shared resume once both lists agree.

A received message carries an in-process authorization check into local
delivery. The check reads the current connection and shared-project intersection
after runtime reads and admission-lock waits, immediately before a fresh durable
reservation. Unsharing refuses with `project_not_linked`; revoking or replacing
the connection refuses with `link_revoked`. The check stays outside the durable
command, so an operation already admitted retains its original receipt and
recovery binding. Refusal acknowledgements remain scheduled after unsharing.

The two-install HTTP tests pause the runtime client's session read with zero
local reservations, remove sharing or revoke the link, and release the read.
Both directions require zero new reservations and runtime commands, plus the
corresponding durable refusal. Pagination cases change a 102-project list to
101, assert that removed-project text stays off every page in both directions,
and require remaining-project messages to resume. These cases failed before
the corresponding fixes.

Both installs need these fixes to protect both directions. Update the granting
side first, then the caller. The wire remains compatible with earlier builds;
a host still running the earlier seat-message implementation retains the races
in its own export and admission paths. An installation predating seat messages
continues board sync and refuses unsupported messaging as described in §14.


The HTTP seat-message cases run in `seatMessages.http.test.ts`, with the same
`testInstalls.ts` fixture factory used by `boardSync.test.ts`. Each suite owns
its isolated roots and recorded child processes. Separating the functional
message seam from the large board growth fixtures keeps those regressions
inside the publication gate's per-file time budget without changing that budget.

## 17. Explicit recovery after a temporary authentication refusal

A 401 keeps the saved link revoked for scheduled exchanges, new seat sends and
pending local message admission. The operator's **Read now** can retry its
existing credential with a body-free authenticated `GET /api/peer/v1/info`.
Recovery requires the same installation, the board feed and `board:sync` scope.
A genuine revocation, missing scope or malformed answer leaves the link fenced.

After successful authentication, the caller exchanges fresh sharing lists while
the link remains revoked. That handshake exports no tasks, agent rows or queued
message text. Once both lists agree, the link becomes active and pending messages
are admitted against the current intersection. Outstanding task pages replay
from durable cursors, so a missed acknowledgement from the refused exchange
cannot break recovery when a project was unshared meanwhile.

The existing temporary-denial test failed with HTTP 409 before this fix. Four
new two-install HTTP cases also failed before it: shared recovery, removed
sharing, revoked grant and removed scope. They retain inbound words across a
receiver restart with zero reservations, queue outbound words and verify the
authentication-only probe, initial sharing-only exchange, refusal boundaries,
single delivery on recovery, and resumed task and agent feeds.

This recovery fix is needed on the calling install (A). Its probe uses the
existing peer info API, so B requires no new protocol for recovery. Both installs
still need this branch's seat relay and export/admission fixes for both directions
as described in §16; one updated install interoperates with an older board-only
peer and refuses unsupported seat messaging.
