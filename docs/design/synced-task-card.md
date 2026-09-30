# Synced task card: the other machine's pipeline, marked as managed there

## Originating requirement

Operator, 2026-09-30, in Russian, verbatim, spoken to this project's
orchestrator chat:

> "Я бы ещё хотел увидеть. Когда вот мне показывается синхронизованная задача с
> другого делегатуса, я не вижу схемы пайплайна, я не вижу, как там и какой
> этап. И также я, э-э, хотел бы, чтобы визуально оно было как-то размечено
> красиво, может быть, какой-то фон, узор там или что, чтобы было понятно, что
> это синхронизированная задача, и типа ей надо управлять на другом этом".

In English: "I'd also like to see this. When a synced task from another
Delegatus shows here, I don't see its pipeline scheme, or how it's going and
which stage it is on. I'd also like it marked visually, nicely, maybe a
background or a pattern, so it's clear that this is a synced task and that it
has to be managed on that other machine."

The brief that carried the quote set three outcomes. (1) A remote task's card
shows its stages, the current stage and each stage's state or verdict, drawn by
the same stage chain a local task uses, and it updates as the peer syncs. (2)
The card is visibly different at a glance, in light and dark and on the phone
and the desktop, with the host named. Controls that work only on the executing
machine are hidden or disabled with a short "managed on {host}" note. (3) First
observe what the peer sends today, and add what is missing in a compact,
bounded form, within the existing budgets and compatibility rules. The stage at
`c18ab355` must keep syncing.

**Not in scope:** driving the remote task from here ("Run here", handover,
"Copy here", M.4 and M.7 of `linked-installs.md`), opening remote stage
conversations, the graph view of a remote lane, PR chips on remote lanes, and
anything in `CHANGELOG.md` or the version pins, which the 1.8.0 release lane
owns.

Code claims below were checked against `4051c4a12` (main at the start of this
stage). The live observation was made read-only on 2026-09-30 against this
install (A, which dialed the pairing) and the stage install (B, serving
`c18ab355`), linked over two shared projects: live-log-viewer-next and
CelestiaCompose.

## 1. What crosses today

### 1.1 The task row carries no pipeline

`WireTask` (`src/lib/links/taskWire.ts:15-20`) is the whole task on the wire:
text, details, status, board, look, placement, work links, `machine`,
`handover`, times and stamps. `validateWireTask` refuses any other key
(`taskWire.ts:77`, `:81`), and a v2 peer rejects unknown row fields
(`taskWire.ts:25`). `pipelineIds` is a local projection of this machine's
pipeline records. So a stage-owned task arrives here with its text, its column
and its owner, and with `pipelineIds: []`.

Observed through `list_tasks` (the newest 51 open tasks): every one the stage
owns reads `machine: "Stage"`, `runsHere: false`, `pipelineIds: []`. The stage's own
registry, read through its loopback API, holds lanes for those same tasks: a
4-stage lane parked on a decision (brief, build, review_ui, fix) for a
CelestiaCompose task, and 3- and 4-stage completed lanes (build, review, fix)
for live-log-viewer-next tasks. 107 lanes in all: 54 completed, 52 closed and 1
needs decision.

### 1.2 The agent feed has a pipeline field that never fills

M.6 agent rows (`src/lib/links/agentFeed.ts:11`) carry an optional
`pl: { id, state, stage, stageState }`: the one stage an agent runs, per
agent. The shape has four limits for this requirement:

- A row exists only while its agent runs or ended within 24 hours
  (`agentFeed.ts:34`). A lane parked on a decision for two days has no rows.
- It names one stage. It carries no stage list, no order, no branch, no loop
  and no other stage's state.
- A feed holds at most 50 rows a project and 200 in all (`agentFeed.ts:95-97`).
  Both shared projects already sit at 50.
- Every receiver, `c18ab355` included, drops a row over 1 536 bytes whole
  (`decodeAgentRow`, `agentFeed.ts:48-58`), so a chain added into `pl` would
  lose the agent itself on those peers.

And in practice the field is empty. `GET /api/links/agents` on this machine
answered 100 rows from the stage (50 per shared project). **No row carried
`pl`**, only 3 carried `task`, and the rest were titled "claude agent" or "codex
agent", the fallback `rowFor` uses when it finds neither a bound task nor a
stage (`agentFeed.ts:39-40`). The cause is in `rowFor`: it reads pipeline
membership from `file.durableLineage` (`agentFeed.ts:28`) on the scan cache's
entries (`lastScannedFiles`, `src/lib/scanner/scanCache.ts:947`). Scanned
transcripts get `durableLineage` only inside the files response: the registry
stamp (`src/app/api/files/response.ts:533`) and the spawn projection it calls
(`response.ts:301` → `src/lib/agent/spawnProjection.ts:595`). Production builds
that response in a worker from the persisted snapshot
(`src/app/api/files/route.ts:364-383`; `filesResponseWorkerEnabled`,
`src/lib/scanner/filesResponseWorker.ts:134-140`, on by default), so the scan
cache the feed reads never carries it. The task match then falls back to
`assignment.path === file.path`, which matched 3 of 100. §12 files this
separately. The design below does not depend on it.

### 1.3 The card today

- No host label. M.7's machine chip is not built: no component reads
  `task.machine`. The card looks exactly like a local one.
- The foot offers "+ Agent" (`src/components/kanban/KanbanCard.tsx:833`). It
  drafts an agent on the card, and the server refuses the launch
  (`runsElsewhere`, `src/app/api/tasks/[id]/spawn/route.ts:219`), so the
  button leads to an error.
- Under the card, one collapsed line "On Stage: n agents · m working"
  (`RemoteAgents`, `KanbanCard.tsx:774`). It lists no stage, because `pl` is
  empty.
- No lane row, on the desktop or the phone.

### 1.4 What follows

The scheme has to come from the owner's pipeline records. The file scan cannot
supply it, the agent rows cannot hold it, and the task row may not carry it.

## 2. The design in one paragraph

The machine that runs a task publishes each of that task's lanes as one small
**lane row**: the stages in the owner's own chip order, each with the state its
board draws. Lane rows travel as a second row kind inside the existing M.6
agents part of `boards/sync`, keyed `l:<pipeline id>`, under the same cursor,
epoch, markers and reset pages. The idle call does not grow by a byte, and old
peers drop the rows as agent rows their decoder rejects. The receiver keeps
them in memory beside the agent rows. It turns each one into the summary
`PipelineBlock` already draws, so a remote lane is the same chain, vertical
under 380 px (#2363). A new `managedOn` mode removes every control from it. The
card of a task that runs elsewhere gets a pinstripe in the info hue and an
info-tinted border, and its "+ Agent" is replaced by a "Managed on {host}"
chip. Nothing about a lane is written to disk, and no text an agent or a
prompt wrote crosses.

## 3. Wire: lane rows in the agents part

### 3.1 The row

```json
{"k":"l:5e0a41c2","p":"repo-0123456789abcdef0123456789abcdef","tk":["00000000-0000-0000-0000-000000000001"],
 "s":"completed","at":1790000000000,
 "g":[{"id":"build","ro":"builder","st":"passed","n":1,"e":"codex","m":"gpt-6.1-sol"},
      {"id":"review","ro":"reviewer","f":{"to":"fix","max":2,"u":2},"st":"failed","n":2,"fc":2,"e":"claude","m":"opus"},
      {"id":"fix","ro":"builder","st":"passed","n":2,"b":1,"e":"codex","m":"gpt-6.1-sol"}]}
```

| Key | Meaning | Bound, checked by sender and receiver |
|---|---|---|
| `k` | `l:` + the pipeline id | `^l:[0-9a-f]{8}$` (ids are `randomUUID().slice(0, 8)`, `src/lib/pipelines/engine.ts:6753`) |
| `p` | the linked project the row belongs to | `repo-` key, linked over the link it travels on (M.6 rule) |
| `tk` | the tasks of `p` the lane serves | 1–4 UUIDs |
| `s` | pipeline state | `provisioning`, `running`, `needs_decision`, `needs_review`, `paused`, `completed`, `closed` (drafts are not published) |
| `at` | when the lane last moved, ms (`pipelineMovedAtMs`) | safe integer ≥ 0 |
| `g` | stages in the owner's chip order: pass path, other stages, fail-only branches (`summarizePipeline`, `src/components/kanban/kanbanModel.ts:344`) | 1–8 entries (`MAX_PIPELINE_STAGES`, `src/lib/pipelines/limits.ts:16`) |
| `g[].id` | stage id | `^[A-Za-z0-9_-]{1,64}$`, unique in the row |
| `g[].ro` | role id, optional; the receiver names the stage from id and role as `stageDisplayName` does (`src/components/pipelines/pipelineModel.ts:804`) | same pattern |
| `g[].lp` | `1` for a legacy `review-loop` stage | literal 1 |
| `g[].st` | the chip state the owner's board draws (`StageChipState`, `pipelineModel.ts:176`) | 8 values |
| `g[].n` | operational attempts; absent means none yet, and the pill draws as waiting | 1–999 |
| `g[].r` | review rounds of a legacy review-loop stage | 1–999 |
| `g[].b` | `1` when the stage sits off the pass path (a fail-only branch) | literal 1 |
| `g[].f` | fail edge: target, its round limit and the rounds it fired (`KanbanLoop`, `kanbanModel.ts:73`) | `to` names a stage of `g`; `max` 1–99 (continue-review grants raise it past 9); `u` 0–99 |
| `g[].fc` | how many findings the latest verdict carried, a count only | 1–50, clamped by the sender (`MAX_STAGE_REPORT_FINDINGS`) |
| `g[].e`, `g[].m` | engine and model of the stage's effective role, for the model glyph; the same identifiers agent rows already carry | `^[a-zA-Z0-9._-]{1,64}$` |

A lane that leaves the feed becomes `{"k":"l:…","gone":true}`, 30 bytes.

**Size.** Encoded, a row is at most **4 096 bytes**: 3 783 with every string
at 64 characters, 8 stages, every optional key and 4 tasks. Rows built from the
stage's real lanes measure **427 bytes** for the 3-stage lane above and **511
bytes** for the 4-stage parked one. The sender refuses to encode a row above
4 096 bytes and the receiver drops one.

**Forward compatibility.** The receiver projects a row onto the keys above and
drops the rest, as `decodeAgentRow` does, so a later version may add optional
keys without a version bump. An unknown `s` or `st` value, a count out of bounds
or a malformed key drops that row alone. The page stays valid, as it does for a
bad agent row today (`agentFeed.ts:190`).

### 3.2 What the sender publishes

Source: the hot pipeline registry (`loadPipelinesForList`,
`src/lib/pipelines/store.ts:1144`, cached against the collection revision,
`:1104-1111`) and the task list the feed already loads (`loadTasksForList`).
Archived lanes are left out.

A lane is published over a link when it is not a draft and at least one of its
`taskIds` names a task that is in a project linked over that link and that
**runs here** (`runsHere`, `src/lib/links/linked.ts:68`). Only the owner
publishes, and only for the tasks it owns. A task handed to the peer stops
publishing its old lanes from here, and the peer holds no record of them.

Chip states come from `summarizePipeline(pipeline, flowsById)`, the function
the owner's own board calls, with the flows it reads and no working set. The
receiver therefore draws what the owner's board draws. The one difference is
`rework`, which needs the owner's file scan and stays out (Deferred). `fc` is
`stageFindings(pipeline, stage.id).length`. The findings themselves stay home.

**Caps.** At most 3 lanes a task and **200 lane rows a link direction**,
separate from the 200 agent rows. Rank: open lanes before ended ones
(`completed`, `closed`), then the newest `at`, then the id. A lane is kept
while one of its tasks has fewer than 3 kept lanes. The stage's whole registry
held 107 lanes on 2026-09-30, so the cap binds only on a much busier machine.

### 3.3 Delta, pages and reset

The lane rows live in the same versioned map as the agent rows, in the same
`AgentFeed` (`agentFeed.ts:60-161`), with the same epoch, version counter,
markers and reset snapshot. What changes:

- **Rebuild trigger.** `refresh` rebuilds today when the scan generation moved
  (`agentFeed.ts:77`). It also rebuilds when `loadPipelinesForList()` or the
  task list returns a new array. Only rows whose JSON changed take a new
  version (`agentFeed.ts:107`), so a pipeline write that changes nothing a
  card draws (a heartbeat, a reap receipt) sends nothing.
- **Selection.** Agent rows keep their caps (50 a project, 200 in all). Lane
  rows keep theirs (3 a task, 200 in all). The two never evict each other.
- **Pages.** A page stops at 50 entries, as today and as old receivers enforce
  (`acceptAgents` refuses more, `agentFeed.ts:181` at `c18ab355`). It also
  stops before an entry that would take the part past **80 KB** encoded. 50
  agent rows are at most 75 KB, so a page of agents alone pages exactly as it
  does today.
- **Reset** carries both kinds, at most 400 rows. The offset check on B
  (`incomingSync`, `src/lib/links/protocol.ts:192`: `agentPage` ≤ 200 and a
  multiple of 50) becomes an integer 0–400, because a byte cut can end a page
  before 50. An old B never receives such an offset: its own snapshot holds
  agent rows only and pages at 50. An old A adds up every row it received
  (`src/lib/links/client.ts:246`), lane rows included, which is the offset the
  new B expects.
- **Markers** share the list of 200 kept for an hour (`agentFeed.ts:113`).
  Lanes leave the feed rarely: when they rank out, their task unlinks or their
  owner changes.

### 3.4 The receiver

`acceptAgents` dispatches on the key prefix: `a:` rows and markers go to the
agent decoder as today, `l:` rows go to `decodeLaneRow`, and `l:` markers remove
a lane. Lane rows sit in the same per-link
record as the agent rows (`received`, `agentFeed.ts:21`), in a second map that
swaps in at the end of a reset with them. It is trimmed to 200, filtered to the
projects linked over the link, dropped with `dropAgents` on revoke or remove,
and greyed after 15 minutes without a successful call (the record's `at`). It
is never written to disk: after a restart the receiver has no lanes until the
next successful call.

**A lane draws only on a task its sender owns.** The receiver shows a lane row
on a card when the card's task is in `tk`, the task does not run here, and the
task's `machine` is the install of the link the row came over. A peer can
therefore paint lanes only on its own tasks. A local card never shows a remote
lane.

### 3.5 Compatibility

| Sender → receiver | What happens | Why, in code |
|---|---|---|
| new → new | lanes cross both ways (B's answer, A's `push.agents`) | this design |
| new → old (`c18ab355`), either side | tasks and agents sync as today; lane rows are ignored | old `acceptAgents` treats `{k:"l:…"}` as an agent row, and `decodeAgentRow` returns `null` at its first test (`/^a:[0-9a-f]{16}$/`); an `l:` marker fails the same test on the `gone` branch; pages stay ≤ 50 entries |
| old → new | no lane rows arrive; the card draws the remote look without a chain | nothing to decode |
| new A ↔ old B offsets | old B pages at 50 and gets offsets that are multiples of 50 | §3.3 |
| old A ↔ new B offsets | old A sends the count of rows it received; new B accepts 0–400 | §3.3 |

No top-level request or answer key is added, `TASK_WIRE_VERSION` stays 3, and
no capability is negotiated. The price is that a new peer sends lane rows to an
old one, which drops them: one reset of at most 200 rows (about 100 KB on
measured shapes) per sender start, then about 0.5 KB per stage change, until
the old peer updates. §10 weighs this against the alternatives.

### 3.6 Budgets

| What | Budget | Held by |
|---|---|---|
| Idle call | **+0 B** in request and answer: no new key; the agents cursor already travels (M.9: ≤ 200 B each) | the existing idle-bytes assertions in `boardSync.test.ts` stay unchanged and green |
| Per task, task wire | **+0 B** | `TASK_WIRE_VERSION` unchanged |
| Per task, lanes | ≤ 3 rows: typically 0.43–0.51 KB each (≈ 1.5 KB a task), at most 4 096 B each (≤ 12 KB a task); sent once per feed reset and again only when the row changes | row bound test; a stage flip test |
| A stage change | the changed lane row plus ≤ 300 B over all the calls it causes (the M.9 "changed task" rule applied to a lane) | measured-transport test |
| Per link direction | ≤ 200 lane rows: ≈ 100 KB for a reset on measured shapes, ≤ 800 KB at the bounds, in pages of ≤ 50 entries and ≤ 80 KB | reset test |
| One body | agents part ≤ 80 KB (was ≤ 75 KB); worst body ≈ 734 KB, under the 1 MiB refusal | page bound test |
| Receiver memory | ≤ 200 rows a link: ≈ 100 KB measured shape, ≤ 800 KB bound | the M.9 memory test runs with 200 lanes a side and lane churn; heap growth < 256 KB still gates |
| Disk, both sides | **0 B** | M.9 "remote agents on disk" check extended to lanes |
| Idle CPU | unchanged: an unchanged registry array skips the rebuild | M.9 CPU test |

### 3.7 What never crosses

Stage prompts, the pipeline's spec and task text, cursor input (a decision's
question and answer), findings, summaries, stage reports, graph-edit notes,
conversation ids, transcript paths, accounts, efforts, worktrees, branches,
heads and PR numbers. Every string in a lane row is an identifier of at most 64
ASCII characters, or a key already public between the pair. The receiver's
fixed key set enforces that, and a test drives it (§11).

## 4. The Viewer's own API

`GET /api/links/agents?project=<key>` (`src/app/api/links/agents/route.ts`)
answers:

```json
{ "agents": [ … as today … ],
  "lanes": [ { …row, "peer": "Stage", "install": "<uuid>", "stale": false, "asOf": 1790000015000 } ],
  "self": "<this install's id, or null>",
  "hosts": { "<installId>": { "label": "Stage", "linked": true } } }
```

`hosts` comes from `linkedContext().labels` and the live links (`machineLabel`,
`linked.ts:72-76`), a handful of entries. With `self` and `hosts` the client
tells a remote task from a local one using the `machine` the task list already
carries, and names its host. Without `project`, the route answers every linked
project, which the cross-project Overview needs. Its bounds are the maps' own:
≤ 200 agents and ≤ 200 lanes a link. The desktop board and the phone board
already poll this route every 15 s (`src/components/kanban/KanbanBoard.tsx:302-321`,
`src/components/mobile/MobileKanban.tsx:707-724`). The Overview gains the same
poll. So a lane that reached this machine shows within 15 s.

## 5. The card treatment

### 5.1 Which card

A card is **remote** when its task has a `machine` other than `self`. It takes
the treatment whether or not any lane arrived: `machine` has crossed on every
task row since M2, `c18ab355` included. Local cards do not change by a pixel.

### 5.2 Surface: a pinstripe in the info hue

`--color-info` is the token set aside for links and handoffs
(`src/styles/tokens.css:113`), which is what a linked machine is. The mock
renders in `~/Pictures/delegatus-review/synced-task/design-variants-{light,dark}.png`
compared three treatments. A stripe of `--color-info-soft` reads in light and
nearly disappears in dark. The chosen one reads in both:

```css
/* tokens.css, declared once beside --color-info-soft: it resolves through
   --color-info, which the dark blocks override, so it serves both schemes */
--remote-stripe: color-mix(in srgb, var(--color-info) 6%, transparent);

/* one class, shared by the desktop card, the phone card and the phone lane frame */
.remote-surface {
  background-image: repeating-linear-gradient(135deg, var(--remote-stripe) 0 3px, transparent 3px 10px);
}
.kb .card.remote { border-color: color-mix(in srgb, var(--color-info) 40%, var(--border-default)); }
.kb .card.remote:hover { border-color: color-mix(in srgb, var(--color-info) 60%, var(--border-default)); }
```

The stripe is translucent, so it composes over whatever the card's surface is:
`--surface-card`, or `--surface-quiet` on a done card
(`kanbanBoard.css:290`). It never sets `background-color`, so the utility
classes the phone card uses keep their fill. On the phone, which draws no
borders, the tinted line joins the card's existing box-shadow list as
`inset 0 0 0 1px <the same mix>`, beside the colour edge the card already
writes inline (`MobileKanban.tsx:383`). The task's colour label, the amber
attention edge and the focus outline keep their places.

Contrast, text over the darkest stripe pixel (computed with the contrast test's
own formula):

| | on card | on quiet |
|---|---|---|
| light, `--color-muted` | 4.76 : 1 | 4.56 : 1 |
| light, `--color-secondary` | 6.77 : 1 | 6.49 : 1 |
| dark, `--color-muted` | 4.60 : 1 | 4.78 : 1 |
| dark, `--color-secondary` | 6.13 : 1 | 6.36 : 1 |

Every state text role keeps its 4.5 : 1 floor. 7% would put dark muted text on
the card at exactly 4.50 and 8% below it, so 6% is the ceiling with margin.
`tokens.contrast.test.ts` gains a case that composes the stripe over card and
quiet in both schemes and holds these four floors.

### 5.3 The host chip is the note

The foot's "+ Agent" becomes a passive chip in the same place: the spot where
work would start here now says where it starts.

- `<span class="host-chip" data-remote-host="<install>">`, with the lucide
  `ArrowLeftRight` icon at 12 px in `--color-info` (3.69 : 1 light, 9.23 : 1
  dark, above the 3 : 1 floor for a graphical mark), then the label in
  `--color-secondary`, `--text-label`, weight 600.
- A solid `--surface-card` fill, 1 px `--border-default`,
  `--radius-control`, 20 px high, 0 6 px padding, so it sits clear of the
  stripe.
- The label clamps to one line with an ellipsis. Host labels run up to 100
  characters (`protocol.ts`, `label.slice(0, 100)`).
- `.foot` gains `flex-wrap: wrap`, the age stays `nowrap`, and the chip takes
  `margin-left: auto`. The 196 px shelf mock showed why: at that width, age
  plus chip do not fit one line, so the chip drops to its own line, right
  aligned. The age never breaks as "2m / ago".
- Tooltip, and the end of the card's `aria-label`: "Runs on {host}. Start its
  agents and answer its pipeline's questions there."

| Key | English | Українською |
|---|---|---|
| `kanban.remote.managedOn` | Managed on {host} | Керується на {host} |
| `kanban.remote.notLinked` | Runs on {host} (not linked) | Виконується на {host} (не під'єднана) |
| `kanban.remote.hint` | Runs on {host}. Start its agents and answer its pipeline's questions there. | Виконується на {host}. Запускайте її агентів і відповідайте на питання її пайплайна там. |
| `pipelineBlock.remote.decision` | Waiting for a decision on {stage} · answer it on {host} | Чекає рішення на етапі {stage} · відповісти можна на {host} |
| `pipelineBlock.remote.review` | Review rounds used up on {stage} · decide on {host} | Раунди рев'ю на етапі {stage} вичерпано · вирішити можна на {host} |
| `pipelineBlock.remote.paused` | Paused on {stage} · resume it on {host} | Призупинено на етапі {stage} · відновити можна на {host} |
| `pipelineBlock.remote.asOf` | as of {time} | станом на {time} |

The findings count reuses `pipelineVerdict.findings`.

### 5.4 Which controls go

| Control | On a remote card | Why |
|---|---|---|
| "+ Agent" (desktop foot, phone task screen bar) | hidden; the host chip stands there | it starts work, and the server refuses it anyway |
| Lane ⋯, answer buttons, retry/skip/close/continue-review, stage draft panels, graph toggle, the Stages sheet chevron, stage pills as buttons | absent: a remote lane is drawn in `managedOn` mode (§6) | pipeline actions exist only on the owner |
| Card ⋯: move to a column, priority, colour, icon, rename, description, details, attach links | kept | these are the task's own synced groups (M.3); editing them here is designed to sync back |
| Hide from board, collapse | kept | local preferences |
| Drag between columns | kept | status syncs |
| Remote agents line | kept as today | M.7 |

The controls are hidden. Disabling them was the alternative: a greyed
"+ Agent" still reads as something this machine might do later, and the chip
already says what to do instead. The server guards (`runsElsewhere` at the
five M.4 seams) stay the enforcement. Hiding is presentation.

## 6. The stage chain of a remote lane

**One summary builder, one component.**
`remoteLaneSummary(row, taskTitle): KanbanPipeline`, a pure module beside
`pipelineBlockModel.ts`, builds what `PipelineBlock` reads:

- `chips` straight from `g`: the stage, `state = st`, `rounds = r`,
  `branch = b`, `rework = false`. They come from the row, so the receiver draws
  the owner's states and never recomputes them.
- `loops` from each `f`: from, to, `fired = u`, `max`.
- `views` from `st`. `waiting` is the stages with no `n`.
- `pipeline`: a presentation-only record built once from a frozen base value
  typed `Pipeline`. It holds `id`, `state = s`, `task = taskTitle` (so
  `sameTitle` hides the lane title and the chain becomes the head), `createdAt`
  from `at`, and `stages` with id, `kind` from `lp`, `role` from `ro`,
  `onFail` from `f`, an `effectiveRole` carrying engine and model for the
  glyph, and an empty prompt. `runs` hold one attempt per stage that has `n`,
  so `latestAttempt` answers and the dashed "waiting" pill follows. There are
  no conversation ids, reports, edits, cursor, delivery or links. The record is
  never stored or sent to any API.

**`PipelineBlock` gains one prop,** `managedOn?: { host: string; asOf: number | null }`.
With it set:

- **Task density** (desktop card, phone task screen): the chain as today.
  `ChainPills` draws pills as text, and the narrow container query
  (`pipelineBlock.css:211-217`) stands them vertically under 380 px exactly as
  on a local card. The head keeps the state word and the age; the opener
  becomes text with no chevron. Skipped: graph toggle, menu, acting line,
  `FinishFlag`, `WorkLinkRow` (it would claim "no PR"), the answer panel,
  decision report and review heads, and the finish, unreviewed, merge, stage
  report and graph-edit notes. One muted `pb-note` line, `data-managed-on`,
  follows the chain when the lane waits on a person: the §5.3 decision, review
  or paused sentence, with "· {n} findings" from the parked stage's `fc`, and
  "· as of {time}" when stale. Lanes that are moving on their own add no line;
  the foot chip already names the host.
- **Card density** (phone board card): `CardLine` as today. The reason line is
  the same sentence without the host part, because the phone card names the
  host on its own line.
- No `<button>` renders inside a `managedOn` block.

Remote lanes are passed to the card in their own prop (`remoteLanes`). They
never enter `card.pipelines`, so nothing that reads that list sees them: the
card and lane menus, answers, stage panels, readers, the album, `FinishWaitLine`,
`groupHideState`, `cardHasLiveWork`, Past attempts. A card that holds both
(local ended lanes from before a handover, and the new owner's lanes) draws its
local lanes as today and the remote ones after them.

## 7. States

| State | Lane on the card | Note under the chain | Card |
|---|---|---|---|
| `provisioning`, `running` | chain; the running stage's pill live, with the glyph's halo; age | none | stripe, tinted border, chip |
| `needs_decision` | the parked stage in warning ink; state word "needs decision" | "Waiting for a decision on {stage} · {n} findings · answer it on {host}" | no amber attention edge, no Needs-you entry: nothing here can answer it |
| `needs_review` | the review stage in warning ink | "Review rounds used up on {stage} · decide on {host}" | as above |
| `paused` | state word "paused" | "Paused on {stage} · resume it on {host}" | as above |
| `completed`, `closed` | state word; passed and failed pills; loop suffix "↺ u/max" | none | done cards keep `--surface-quiet` under the stripe |
| No lane data: an old peer, no lane yet, drafts only, ranked out, or this Viewer restarted and has not synced | no lane block, no error | — | stripe, border and chip still, from `machine` |
| Stale: no successful call for 15 min | chain as last received | "as of 10:31" ends the note; a lane with no note gets that note alone | — |
| Owner not linked (revoked, removed, reinstalled) | none: the rows went with the link | — | chip reads "Runs on {host} (not linked)" |

## 8. The phone at 390 px

- **Board card** (`MobileKanban.tsx:363-481`, about 358 px wide): the
  `.remote-surface` stripe and the inset tinted line; the card-density lane
  line (`:425`) from the remote summary; then a passive host line
  `data-phone-card-host` with the 12 px icon in `text-info` and "Managed on
  {host}" in `text-label font-semibold text-secondary`, clamped to one line.
  The card stays one button (#699): nothing new inside it is a control. The
  remote agents line below it (`:479`) is unchanged.
- **Task screen** (`MobileTaskScreen.tsx`): every remote lane uses the frame
  finished lanes use (`phone-lane`, `:677-699`), with `.remote-surface`, in
  task density, and `managedOn`. The lane is the 342 px lane the narrow chain
  was built for, so it stands vertical. There is no lane sheet. The bottom bar
  keeps the status picker, and in place of "+ Agent" (`:944-955`) holds a
  passive pill `data-phone-task-host`: 44 px high, rounded, `border-border`,
  `text-secondary`, reading "Managed on {host}". Status plus pill measure about
  320 px of the 358 px bar. A long host label truncates inside the pill.
- Long-press quick actions on the board card stay: they are the synced groups
  of §5.4.

## 9. What must not change

1. The task wire: `WireTask`, its bounds, its LWW groups, `TASK_WIRE_VERSION`
   3. No pipeline data rides a task row, and `pipelineIds` stays local.
2. The sync envelope: no new request or answer key; idle request and answer ≤
   200 B; the 1 MiB refusal; agents-part pages ≤ 50 entries; agent row shape,
   `a:` keys, the 1.5 KB row bound and the agent caps (50 a project, 200 in
   all).
3. A peer at `c18ab355` keeps syncing tasks and agents in both directions,
   with either side old.
4. Nothing about a remote lane is written to disk on either side. No
   transcript bytes, prompts, findings, summaries or paths cross (§3.7).
5. Local cards, local lanes and local phone screens render exactly as before.
   The before and after renders of a local card in the evidence must match.
6. Needs-you counts, attention edges, the seat tick, a column's "working"
   count, hide rules and `cardHasLiveWork` count local work only. Remote lanes
   never enter `card.pipelines`.
7. The narrow vertical chain of #2363 works as specified there; remote lanes
   reach it through the same container query, with no remote branch in the CSS.
8. The ownership guard at the five M.4 seams stays the enforcement.
9. `RemoteAgents` rows and where they sit.
10. `CHANGELOG.md` and the version pins (the 1.8.0 lane's fence).

## 10. Decision record: where the lanes ride

A wire choice is expensive to reverse once two versions depend on it, so the
options are kept here.

| Option | Idle cost | Old peers | Verdict |
|---|---|---|---|
| **A. Lane rows as a second kind in the agents part** | +0 B | ignore them through the decoder they already run; bounded bytes sent to them until they update | **chosen** |
| B. A separate `lanes` part with its own cursor | a cursor each way: +30 B in the request and +41 B in the answer, over idle bodies of ≈ 184 B and ≈ 178 B (computed from today's idle shapes), which breaks the 200 B budget | never asked, so never sent | cleaner name; fails "within the existing budgets" |
| C. Stage chain inside the agent row's `pl` | +0 B | drop the whole agent row once it passes 1.5 KB | lanes vanish 24 h after their last agent, compete for the 50-a-project slots already full, and repeat per agent |
| D. New fields on the task row | +0 B idle, but every stage move becomes a task write with an LWW stamp | v2 peers reject unknown row fields; would need task wire v4 and a replay | persists on disk, churns revisions, mixes owner-only state into a two-way merge |

Option A keeps the idle call identical and reuses a delta machine that is
already tested (epoch, versions, markers, reset pages). Its costs are a naming
wart (the part called `agents` also carries lanes, which the code names
`AgentFeed` rows of kind `l:`) and bytes sent to an old peer that drops them.
Both are bounded, and the second ends when the peer updates.

## 11. Tests and evidence the build owes

Run touched test files by path, never whole directories against live state
(AGENTS.md). Heavy gates (`tsc`, `bun run build`, the browser drivers) go under
`flock /var/tmp/llv-heavy-gate.lock` with an isolated config root.

1. **Two-install harness** (`src/lib/links/boardSync.test.ts` over
   `testServer.ts`, which gains a test-only way to write a pipeline record for
   a task). B holds a linked task with a running 3-stage lane. After one
   `sync`, A's `GET /api/links/agents` lists the lane with its stages, order,
   states and current stage. B moves the lane to its next stage; after the next
   `sync` A shows the new states. The same from A to B, over `push.agents`.
2. **Mixed versions**, with the harness's real `c18ab355` source
   (`oldSource()`, `boardSync.test.ts:108`) as client and as server. Tasks and
   agents keep syncing both ways. The old side accepts every page carrying
   lane rows. The new side receives no lanes from the old one, and its card
   model builds without a lane and without an error.
3. **Bytes.** Idle request and answer stay ≤ 200 B with lanes present on both
   sides. One stage flip costs its row plus ≤ 300 B on the measured transport.
   A reset of 200 agents and 200 lanes arrives in pages of ≤ 50 entries and
   ≤ 80 KB.
4. **Bounds.** A sender with 300 eligible lanes publishes 200, ranked open
   first, ≤ 3 a task; drafts and archived lanes never appear. A 9-stage row, a
   4 097-byte row, an `f.to` naming no stage and an unknown `st` are each
   dropped alone.
5. **Nothing private crosses.** A lane whose prompts, spec, cursor input,
   findings, summaries and stage reports all contain a sentinel string. The
   sentinel appears in no captured sync body (the harness keeps every body
   since its last reset).
6. **No disk.** Lanes on both sides write no file and no row (the M.9 check
   for remote agents, extended).
7. **Receiver projection** (a DOM test beside `PipelineBlock`). For each state
   of §7, `remoteLaneSummary` → `PipelineBlock` in task and card density
   renders without throwing, draws one pill per stage with the row's states,
   contains no `<button>`, and carries the note where §7 says. A round trip on
   the sender side: `summarizePipeline(p).chips` order, states and branches
   equal the chips `remoteLaneSummary(encode(p))` returns.
8. **Contrast** (`src/styles/tokens.contrast.test.ts`): the §5.2 floors.
9. **Rendered evidence**, through the drivers that exist, one `describe` block
   each: `src/components/kanban/kanbanBoard.browser.test.tsx` over
   `issue1695Evidence.fixture.tsx` for 1440 (narrow shelf and wide), and
   `src/components/mobile/issue1671Evidence.browser.test.tsx` for the phone
   board card and task screen at 390, all in light and dark. Before and after
   PNGs go to `~/Pictures/delegatus-review/synced-task/`, named in the PR. The
   driver measures and fails on: the chip label clipped by anything other than
   its own ellipsis, the foot age on more than one line, ink overlap between
   the chip and the age, a remote card with no `repeating-linear-gradient` in
   its computed background, any button inside `[data-managed-on]`, and a local
   card that differs between before and after.

The design mocks this stage rendered to settle the stripe
(`design-mock-{1440-shelf,1440-wide,390-phone}-{light,dark}.png` and
`design-variants-{light,dark}.png` in the same folder) are sketches in the real
token values. They are not the evidence above.

## 12. Found while observing: agent rows lose their pipeline and task

§1.2: the stage's agent rows reach this machine with no `pl` and, for 97 of
100, no `task`. The stage's pipeline agents therefore sit in the unbound "On
Stage" group, titled "claude agent" or "codex agent", and the stage text in
`RemoteAgents` never shows. The fix is to resolve a scanned conversation's
pipeline attempt from the pipeline records in `rowFor`, by attempt
`conversationId` or `agentPath`, where `durableLineage` is absent. Its test
must build the rows from a real scan snapshot: a test that hands `rowFor` a
`FileEntry` with `durableLineage` already set passes today and proves nothing.
The lanes above do not need this. It is its own defect and needs its own issue.

## Deferred — not currently justified

- **Opening a remote stage, the graph view, the Stages sheet.** Each needs the
  stage's conversation or the full record, and transcripts never cross. The
  chain answers "which stage, how it is going".
- **PR and issue chips, the merge word on a completed remote lane.** Pipeline
  work links are local. The task's own links already sync.
- **"Run here", "Copy here", the handover UI, and M.7's owner-side chip on
  local cards** ("this machine", muted, with the move menu). They drive the
  task, which the quote hands to the other machine.
- **A call within 2 s when A's own lanes move.** B's lanes reach A within
  15 s while A's board is open. A's lanes reach B at A's next call, up to
  5 minutes when A's board is closed. The acceptance asks for "after the next
  sync". Add the trigger when someone watches a laptop-run lane from the
  server's board and finds it late.
- **Capability negotiation to spare old peers the lane rows.** It saves one
  bounded reset per sender start on a peer that auto-updates.
- **`rework` on remote pills.** It needs the owner's file scan.
- **Lanes in MCP `get_task` / `list_tasks`.** Orchestrators on each machine
  read their own lanes; nobody asked for the other's.
- **An "update {peer} to see its stages" hint** for old peers. The card
  without a chain is the requested behaviour.

## Validation against the requirement

- "я не вижу схемы пайплайна" (I don't see the pipeline scheme): every lane of
  a remote task, drawn by the same `PipelineBlock` chain, vertical on narrow
  cards (§6).
- "как там и какой этап" (how it's going, which stage): each stage's state
  from the owner's own board, the live pill on the current stage, the loop
  count, the age, and one sentence when it waits on a person (§6, §7).
- "размечено красиво … фон, узор" (marked nicely, a background, a pattern): a
  6% info-hue pinstripe and an info-tinted border, legible at 4.5 : 1 or better
  in both schemes, on the desktop and the phone (§5.2, §8).
- "понятно, что это синхронизированная задача" (clear that it is a synced
  task): the host chip on every remote card, with or without lane data (§5.3,
  §7).
- "ей надо управлять на другом" (it has to be managed on the other machine):
  "Managed on {host}" where "+ Agent" was, no control inside a remote lane, and
  "answer it on {host}" where a local lane would offer its answer buttons
  (§5.4, §6).
- Observation first, compact and bounded, old peers keep syncing: §1, §3.1,
  §3.5, §3.6.
