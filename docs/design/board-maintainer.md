# Board maintainer: a built-in agent on the seat tick

Status: design. Written against `main` at `ec82292a1` (2026-09-30). File and
line references are to that commit. This stage wrote only this document: no
code, no test, no state, no issue. Tracking issue: #2162 (built-in board
maintenance); #746 names the same routine as its phase A.

## Originating requirement

Operator, 2026-09-30, voice-dictated in Russian into the Delegatus project's
orchestrator seat chat. The seat pinned it to this lane verbatim, with its own
elisions:

> Нам нужно сделать так, что. У нас время от времени запускается агент на
> GPT-6.1 Sol, наверное, на Medium Reasoning, раз. [...] это должно работать
> вместе с тикером [...] должен вместе с ним [...] сполниться, с тем как тикер
> в то время, когда тик срабатывает. Но при этом [...] Нужно срабатывать не
> чаще, чем раз на, например, 3 часа [...] должен сполниться агент,
> создаваться и убираться потом задача [...] по поддержке доски, то есть по
> maintenance. [...] было уже какой-то skill или что-то уже подобное было,
> вот, но теперь это нужно закрепить на уровне [...] как тикер срабатывает,
> чтобы вот оно запускалось и автоматически всё создавалось и убиралось. В
> плане карточка про очистку. И чтобы там тоже иконка, и описание было, и всё
> такое. Но пайплайна там не будет, там будет просто один агент, который
> будет, скорее всего, GPT вот этот 6.1 Sol на Medium Reasoning, у него промпт
> что нужно сделать [...] он должен разобраться в каждой задаче, какой там
> статус, у пайплайна, у агентов, была ли сделана задача, была ли смерджена
> задача [...] сначала нужно разобрать назначения, потом [...] перетянуть их
> куда-то, потом посмотреть заблокированные, если есть какое-то обновление в
> задаче, то желательно это описать, добавить это в описание, что если там
> есть какая-то информация, которую нужно знать человеку [...] Есть задачи,
> которые наполовину выполнены, и можно, например, пометить всю задачу как
> выполненную и создать новую задачу, которая [...] создаётся продолжением
> предыдущей. [...] что мы перетягиваем с входящих, может быть, нужно [...]
> посмотреть входящие по приоритетам, что там есть, и вообще по описанию, что
> есть смысл [...] акцентировать внимание для оператора.

In English, condensed: when the seat tick fires, and at most once every three
hours or so, Delegatus itself starts one agent (GPT-6.1-Sol, medium effort, no
pipeline) that creates its own board-maintenance card with an icon and a
description and removes it afterwards. The agent goes through every task: the
status of its pipelines and agents, whether the work was done and merged. It
fixes assignments first, then blocked tasks, writing into the description what
a person needs to know. It closes half-done tasks and creates a continuation
for the rest. It reviews the inbox by priority and description and points the
operator at what deserves attention.

## Amendment 2026-10-01

Operator, 2026-10-01, sent to this design stage by the seat as a spec
amendment. It overrides the pinned specification where the two differ, and
the later stages of this lane receive the same amendment in their prompts.
Verbatim:

> A1. No per-run write cap. Drop the cap from spec item 6; the maintainer
> makes every change the board needs. The other guard rails stay (no done on
> a task with an open pipeline or live agent, no delete, no spawn/stop).
>
> A2. Continuity. Each run reads the previous run's record (its card summary
> plus a durable per-run log of what it changed, asked and left alone) before
> it starts, so it does not redo or contradict it. It still decides
> everything from the real current state and never trusts the log or a
> stored status on its own.
>
> A3. Worker liveness by evidence. For every agent or pipeline stage a task
> relies on, check whether it is really working: recent transcript activity,
> new commits or diff on its branch, stage attempts progressing. The status
> field alone is not enough. A "running" worker with no activity for a long
> time, or a finished worker whose task still reads as in progress, is a
> finding: correct the task and flag it to the operator.
>
> A4. The maintenance timer is configured in the same UI where the seat tick
> is configured today: on/off, interval, last run (time, result, link to its
> card), next run. Split the plan: the backend stage (Codex) exposes the
> setting and run records via API and MCP; a separate UI stage (Claude)
> builds the UI. Name the UI files and the API shape the UI will use.
>
> A5. After the UI is built and reviewed, a critique stage (Claude Opus)
> critiques the whole seat-tick settings UI as it looks: what is worth
> showing the user, what is not, what to add, remove, reorder or restyle. It
> produces proposals only.

How this design applies each item:

| Item | Where | What it changes |
| --- | --- | --- |
| A1 | §7, §5.2 | No write cap in code or in the prompt. The guard counts nothing and refuses nothing for volume; the remaining refusals are done on a task with an open pipeline or a live agent, deletes (and hides and details overwrites, which delete content), and every start, stop or send. The run log keeps every change, and its storage bound (§8) never refuses a write. |
| A2 | §8, §5.2 step 1, §5.3 | Every run keeps a durable log: changes recorded server-side by the guard as they happen, questions and left-alone tasks parsed from the final message. The next run's brief carries the previous run's card summary and log. The prompt's first step reads it and says the record is history, so every decision rests on what the run checks now. |
| A3 | §9, §5.2 step 4 | A pure evidence helper measures, for each open task, transcript activity, branch commits and stage attempts, and names a quiet "running" worker and a finished worker under an in-progress task. The brief hands the result over as a claim to confirm; prompt step 4 makes liveness by evidence the maintainer's rule, with correction and an attention line as the outcome. |
| A4 | §4.2–§4.6 | The backend stage exposes the setting and the run records through `seat_tick_settings` and `GET/PUT /api/monitor/seat-tick/settings` in one shape, `BoardMaintenanceAnswer` (§4.2). The UI stage's brief (§4.6) names its files, the fields it reads and writes, its states, its strings and its rendered evidence. |
| A5 | §4.7 | The critique stage's scope and outputs; it changes no code. |

The pinned spec's item 6 cap and its cap test are dropped by A1. Everything
else in the pinned specification stands.

## Decision in one paragraph

Maintenance is a new phase of the existing seat tick check
(`src/lib/monitor/seatTickController.ts`). Before the gather, the check settles
the project's live maintenance run, if there is one. After the wake is sent,
it launches a new run when the project's setting is on, the project has an
active seat, no run is live, no Delegatus deployment is running, and a durable
SQLite claim admits the interval slot. The claim is one compare-and-set
transaction on a per-project row, so a restart, a repeated check or a second
process can never launch twice in one interval. The run is one agent of a new
registry role `maintainer` (codex, `gpt-6.1-sol`, medium, read-only fences),
started through the same in-process `executeSpawnRequest` lane the Telegram
Daily Report uses, with `taskId` pointing at a card the tick created a moment
earlier (icon `brush-cleaning`, colour `slate`, operator-locale title and
three sentences). The Viewer watches the run through the spawn receipt and the
registry's liveness verdict. On success it writes a summary into the card,
marks it done, hides it and archives the run's conversation card. On failure
it leaves the card blocked and visible with the reason. The guard rails sit at
the MCP boundary: a caller whose durable `agentRole` is `maintainer` may write
the board only through `create_task` and `update_task`, and those two refuse a
delete, a hide, a whole-field `details` overwrite, a write outside the run's
project and `done` on a task with an open pipeline or a live agent. Every
accepted write is logged against the run. The seat's next wake carries one
`maintenance` item per ended run, announced exactly once, like a settled
deploy.

## 1. What exists today

### 1.1 The seat tick

- One in-process clock, `startSeatTick` (`seatTickController.ts:1865`),
  started by the release that owns traffic. Every 5 minutes
  (`DEFAULT_SEAT_TICK_POLICY.checkIntervalMs`, `seatTick.ts:136`) it calls
  `reconcileSeatTick` (`:1793`), which re-asks traffic authority, then runs
  `runSeatTickCheck` (`:1202`) for each project from `seatTickProjects`
  (`seatTickSources.ts:1371`): projects with an active seat, an open pipeline,
  or an inbox/assigned task. A sweep is skipped while the self-update restart
  gate is held (`:1913`), and a sweep never overlaps the previous one.
- `check()` (`:1236`) runs in phases with `yieldToRuntime` between them:
  provisional-seat reconcile, retired and outstanding wake reconcile (`:1302`),
  `gatherSeatTickInput` (`:1319`), MCP health card, deploy snapshots,
  `seatTickDecision` (`:1350`), cards, the wake send, `writeState` (`:1594`),
  the standing card, and one journal record (`:1605`) whose `detail` is a
  `; `-joined list of clauses (`:1616`).
- `onboarding/healthCheck.ts:775` also calls `runSeatTickCheck`, against a
  scratch seat and scratch tick state. Anything this design adds to the check
  must stay out of that call (§3.6).

### 1.2 The tick's settings and its UI

- `seatTickSettings.ts` stores one row per project in the `seat_tick_settings`
  SQLite collection: `enabled`, `wakeIntervalMinutes`, `reason`,
  `monitorPrompt`, `until`, `updatedAt`, `setBy`. `seatTickSettingsAreDefault`
  (`:173`) deliberately ignores `monitorPrompt`: a field that changes what a
  wake says, and never whether one is sent, needs no reason, raises no board
  card and survives a lapse (`seatTickSettingsAfterLapse`, `:379`).
- The MCP tool is `seatTickSettingsTool` (`mcp/bindings.ts:3575`), schema at
  `mcp/server.ts:3871`. The browser reads and writes the same record through
  `GET/PUT /api/monitor/seat-tick/settings`
  (`src/app/api/monitor/seat-tick/settings/route.ts`), answered by
  `seatTickSettingsAnswer` (`monitor/seatTickSettingsAnswer.ts`).
- The UI is the seat-tick chip in the orchestrator's incumbent row
  (`components/orchestrator/SeatTickChip.tsx`), whose popover renders
  `SeatTickBody.tsx`, and the phone sheet `components/mobile/MobileSeatTickSheet.tsx`,
  which renders the same body. A board task for the tick exists only while the
  schedule departs from the default (the `tick-settings` card).

### 1.3 A Viewer-timer spawn already exists

`src/lib/telegram/reportSpawn.ts` runs a spawn from a timer with nobody at the
keyboard: `launchReportConversation` (`:103`) builds a same-origin request with
the operator capability (`reportSpawnHeaders`, `:87`) and calls
`executeSpawnRequest` (`agent/spawnCommand.ts:285`) in process, replacing
Next's `after()` with `startDeferredSpawnWork` (`:52`), because `after()` is
illegal outside a request scope. Everything else is the ordinary lane:
admission, the project's account bindings (`resolveHealthySpawnAccount`,
`spawnCommand.ts:834`), the durable receipt keyed by `clientAttemptId`, and
the `taskId` binding.

Account refusals come back as HTTP answers: `ProjectAccountRefusedError` is a
409 with only `{ error }` (`:849`), an engine nobody is signed in to is a 409
with `code: ENGINE_NOT_CONNECTED`, a missing Codex tier is a 409 with
`code: "service_tier_unavailable"`.

### 1.4 Roles

The role registry is `src/lib/roles/`: `types.ts` (`ROLE_IDS`), `defaults.ts`
(`ROLE_DEFAULTS`, the scaffolds and fences), `registry.ts` (`resolveRole`,
`roleSpawnPrompt`, which appends `SPAWN_COMPLETION` to every non-orchestrator
spawn), `store.ts` (install overrides). `src/lib/pipelines/roles.ts`, which the
brief names, is the pipeline-stage adapter: it keeps its own
`PIPELINE_ROLE_IDS`, so a role absent from that list can never be a stage.

Three tests pin every scaffold (`roles/registry.test.ts`): `listRoles()` has
exactly 8 entries (`:136`); every scaffold renders the process-cleanup rule;
every non-orchestrator scaffold carries the shared rules (search, human in the
loop with "finish with needs_decision", missing access, project rules) and
names no stack word, no `/Ukrainian/`, and none of `VERDICT`, `APPROVE`,
`COMMENT` (`:286`). The delivered orchestrator mandate renders one role-table
row per registry role (`orchestrator/prompt.ts:465`).

`agent/spawnAdmission.ts:14` holds the hardcoded `SPAWN_DENIED_ROLE_IDS`
(`reviewer`, `verifier`): such a conversation launches with native subagents
disabled, and admission and `/api/pipelines` refuse child spawns and pipelines
whose origin has that role.

### 1.5 MCP caller identity and the B+ policy

- The caller is resolved server-side by `attentionCallerAuthority`
  (`attention/callerAuthority.ts`) from this process's ancestry, the host pids
  the registry recorded, and the spawn capability injected at admission. For
  the shared HTTP endpoint the capability travels with the request
  (`mcp/callerContext.ts`). Two chains that disagree identify nobody.
- `attributionOf` (`bindings.ts:922`) folds that into
  `{ kind, conversationId, role }`.
- The registry's durable role is `RegistryConversation.agentRole`, "copied
  from the launch receipt at admission (#393), never re-derived", read by
  `conversationAgentRole` (`spawnAdmission.ts:275`), which `/api/pipelines`
  already uses to refuse reviewer-origin pipelines.
- `toolAllowlist.ts` states the B+ rule: every session holds the whole
  surface, and identity decides only operation contracts (origin labels,
  deploy execution, archiving). `viewerMcpToolPolicy` (`bindings.ts:5954`) is
  the per-call fence the service consults before any binding
  (`server.ts:2361`), and its refusal code reaches the caller verbatim.

### 1.6 Board task writes and visibility

- `createBoardTask` (`bindings.ts:1584`) and `updateBoardTask` (`:1639`) run
  `createTask` / `patchTask` (`tasks/commands.ts`) inside one task-store
  transaction. Neither binding receives the call context today.
- A task's pipelines are the pipelines whose `taskIds` include it.
- `taskShowsOnBoard` (`tasks/boardVisibility.ts:100`) honours
  `board: "hidden"` only while the task's band holds no conversation:
  `task.board !== "hidden" || hasMembers`. A done task within its three-day
  retention falls through to the same test.
- Archiving a conversation card is a board-prefs `hidden` patch applied by
  `writeArchivePlacement` (`bindings.ts:5108`) through `applyBoardCommand`.

### 1.7 Once-only claims and once-only wake items

- `claimBoardReport` (`orchestrator/boardReportStore.ts:74`) is a
  compare-and-set in one `SqliteStateCollection.boundedPatch` transaction on a
  `p:<project>` row of a collection in `state.sqlite`: exactly one caller per
  seat epoch gets `true`, across processes.
- A settled deploy the seat started reaches its wake exactly once: the gather
  lists settled deployments not in `state.announcedDeploys`
  (`seatTickSources.ts:917`); the decision adds a `deploy-settled` reason and
  `deploy` items (`seatTick.ts:1259`); the commit plan names them
  (`:1901`), and only a landed wake records them (`:1991`). The field is
  validated in `seatTickAccounting.ts:108` and normalized in
  `seatTickState.ts:77`, `:256`.

### 1.8 The deployment ledger

`runtime/deploymentLedger.ts` reads this install's Delegatus deployments
(`latestLedgerDeployment`, `:143`). A record carries `phase`, `terminal` and
`revision`, and no project: the ledger only ever holds deploys of Delegatus
itself.

### 1.9 The manual runs 1–3

Prior work, found through `search_transcripts` and board task 873efe90: three
runs by hand on 24–25.09 (Claude Opus, high effort), each spawned by the seat
with a prompt of its own (v1, v2, v3), each writing a report file outside the
repository. No earlier attempt at a built-in form exists. What they taught,
all kept by §5:

- Run 1 set blocked on work the operator had already authorized, set blocked
  on a pipeline waiting on the seat's own decision, and claimed a queued lane
  could start.
- The seat's card must be found through `get_orchestrator`: a title match
  picked a retired seat card in run 2.
- A compact pipeline row's `"#N open"` can be stale; only `gh` tells a PR's
  state. Work shipped from lanes the task no longer linked, found by searching
  PR head branches for the lane id.
- `updatedAt` misleads the age rule, because bulk writes refresh it; the
  newest assignment, stage attempt or PR activity is the age.
- The unfiltered `list_tasks` was 17 pages and useless; `openOnly` plus done
  tasks updated since the last run is the working set.
- Whole-field `details` writes are where truncation lives; `appendLine` and
  `replaceLine` replace them.
- Monitor alert cards are the seat tick's to open and close.
- Partly shipped multi-slice tasks fitted no rule. The operator's newer rule
  (close with what shipped, continue in a new task) settles it.

## 2. Where the code and the specification disagree

Each entry names the spec's words, what the code does, and the option this
design takes.

1. **"no deploy is running for the project".** The deployment ledger records
   only Delegatus's own deployments and has no project field (§1.8); other
   projects have no deploy Delegatus can see. **Recommended:** defer while the
   newest ledger deployment is not terminal, for every project. A Delegatus
   deploy replaces the Viewer and can cut a running agent's MCP link, and
   deploys take minutes. The self-update restart gate already skips whole
   sweeps (§1.1). An unreadable ledger does not defer: some installs have no
   runtime journal, and failing closed there would disable maintenance for
   good.
2. **"shown on the board's seat-tick card beside the tick".** No board card
   shows the tick in its default state; the tick's surface is the chip popover
   and the phone sheet, both rendering `SeatTickBody` (§1.2).
   **Recommended:** the setting and the run records live in that body, the
   place A4 names. No new board task.
3. **"moved to done and taken off the board (board hidden)".** `board: hidden`
   is ignored while the band holds a conversation (§1.6), and the run's own
   conversation card keeps it there. **Recommended:** on success the Viewer
   also archives the run's conversation card with the same board-prefs patch
   `conversation_action archive` applies. The conversation stays in the
   registry and the transcript stays on disk.
4. **"cwd = the project's repository, no product file edits".** A spawned
   agent has no code that enforces read-only files today. A pipeline stage's
   read-only access is checked when the stage settles
   (`pipelines/engine.ts:568`), and a spawn never settles that way; the Codex
   `--sandbox read-only` flag (`cli.ts:420`) is reachable from flows, and it
   cuts `gh`'s network, which the maintainer needs. **Recommended:** the
   maintainer gets the same prompt-level fence as a reviewer spawned outside
   a pipeline, plus the MCP guard on the one write surface Delegatus controls
   (§7). Enforcing file immutability is deferred (§14).
5. **The role registry is `src/lib/roles/`**, and `pipelines/roles.ts` is the
   stage adapter (§1.4). The maintainer joins `ROLE_IDS` and stays out of
   `PIPELINE_ROLE_IDS`, which is what "no pipeline" needs.
6. **"guard rails at the MCP boundary for a maintainer-role run".** The B+
   header in `toolAllowlist.ts` says role decides nothing about availability.
   The maintainer guard is an operation contract of the kind it already lists
   (deploy execution, archiving): every tool stays callable for reads, and
   only the maintainer's writes are fenced. The header gains a fourth bullet.
   Its identity rests on the durable `agentRole` (§7.1). A role string is safe
   in this direction: claiming `maintainer` can only restrict the claimant.
7. **"Default for projects that never set it: off"** alongside
   `seatTickSettingsAreDefault`, which decides whether the tick-settings card
   stands and whether a reason is owed. **Recommended:** the maintenance
   setting sits outside that predicate, exactly like `monitorPrompt`: turning
   it on needs no reason, raises no card and survives a schedule lapse.
8. **Wake switch.** The spec evaluates maintenance "on the project's seat
   tick". A project whose wakes are off (`enabled: false`) still has its check
   run every five minutes. **Recommended:** maintenance runs on every check of
   a seated project whatever the wake switch says, since the operator turns
   maintenance on separately; its wake item waits until wakes resume (within
   the three-day backlog bound).
9. **Scaffold tests versus the role's verdict.** Every non-orchestrator
   scaffold must carry the shared human-in-the-loop rule ("finish with
   needs_decision"). For the maintainer, questions about tasks are its normal
   output. **Recommended:** keep the shared rules and narrow the meaning in
   the scaffold's own last step: a completed pass is `pass` with questions;
   `needs_decision` is for a run that cannot go on.
10. **The design brief asks for a write cap; A1 drops it.** The amendment
    wins (§7).

## 3. Trigger and the durable launch key

### 3.1 Where it hooks into the check

Two calls in `check()`, each in its own `try`, so a maintenance failure
becomes a journal clause and the check goes on:

1. **Reconcile, before the gather.** After `reconcileOutstandingWake`
   (`seatTickController.ts:1302`) and its `yieldToRuntime`, and before
   `gatherSeatTickInput` (`:1319`):
   `const maintenanceSettled = await maintenance?.reconcile(canonical)`.
   It settles the project's live run when that run has ended (§6.4), so the
   gather of this same check already sees the settled run and the wake this
   check sends can carry its item.
2. **Launch, after the wake.** After `writeState(input.project, state)`
   (`:1594`) and the standing card, before the journal record:
   `const maintenanceLaunch = await maintenance?.launchIfDue({ project, seat: input.seat, setting: input.settings.maintenance, now: input.now })`.
   Launching last keeps a spawn's latency off the wake's path.

Both return a clause (`string | null`) appended to the record's `detail` list
at `:1616`, for example `maintenance: launched run maint_3f9a… (card 1a2b3c4d)`,
`maintenance: waits, a deployment is running`, `maintenance: run maint_… succeeded`.
A check that decides nothing about maintenance adds nothing.

`SeatTickControllerDependencies` gains
`maintenance?: BoardMaintenanceController | null`. `runSeatTickCheck` treats an
absent value as `null` (no maintenance). `reconcileSeatTick`, the production
sweep, supplies `productionBoardMaintenanceController(sources)` unless a
dependency overrides it. So only the real sweep ever launches, and every
existing controller test is untouched by default.

### 3.2 When a launch is due

`launchBoardMaintenanceIfDue` (`src/lib/boardMaintenance/run.ts`) checks, in
this order, stopping at the first that fails:

1. The effective setting is on (§4.1). Off answers with no clause.
2. `input.seat` is non-null (an active seat). Otherwise
   `maintenance: waits for a seat`.
3. No run of the project is live (`claimed`, `launching`, `running`). A live
   run is the reconcile's business; no clause.
4. No Delegatus deployment is running: `latestLedgerDeployment()` answers
   none, a terminal deployment, or unreadable (§2.1). A running one answers
   `maintenance: waits, a deployment is running`. This is checked
   before the claim, so a deferral never spends the slot.
5. `claimMaintenanceRun` (§3.3) admits the slot. A refusal for `interval`
   answers with no clause.
6. Card, then spawn (§6.1–§6.2).

### 3.3 The claim

Store: a new collection `board_maintenance_runs` in `state.sqlite`, module
`src/lib/boardMaintenance/store.ts`, built exactly like `boardReportStore.ts`
(`initializeStateCollections` on first write, `SqliteStateCollection`,
`statePath("state.sqlite")` resolved per call and never at module load, as the
state-ownership rules require). Rows:

```ts
/** p:<project> — one per project that ever claimed a run. */
interface MaintenanceProject {
  kind: "project";
  project: string;               // canonical project key
  lastClaimAt: string | null;    // ISO, the last launch
  lastSlotKey: string | null;    // `${intervalHours}:${slot}`
  currentRunId: string | null;   // set while a run is live
  runIds: string[];              // newest last, MAINTENANCE_RUN_RETENTION (10)
}
/** r:<runId> — MaintenanceRun, §6.3. */
/** c:<canonical conversationId> — index the guard reads. */
interface MaintenanceConversationIndex { kind: "conversation"; conversationId: string; runId: string }
```

The key:

```ts
const intervalMs = intervalHours * 3_600_000;
const slot = Math.floor(nowMs / intervalMs);
const slotKey = `${intervalHours}:${slot}`;
const runId = `maint_${sha256(`${project}:${slotKey}`).slice(0, 24)}`;   // 30 chars, URL-safe
```

`claimMaintenanceRun({ project, now, intervalHours, seat, repoDir })` is one
`boundedPatch` transaction:

1. Read `p:<project>`. If `currentRunId` names a run whose state is live,
   answer `{ claimed: false, reason: "live" }`.
2. If `lastClaimAt` is less than `intervalMs` ago, answer
   `{ claimed: false, reason: "interval" }`.
3. If `r:<runId>` already exists, answer `{ claimed: false, reason: "slot-taken" }`.
4. Put the run row (`state: "claimed"`) and the project row
   (`lastClaimAt: now`, `lastSlotKey`, `currentRunId: runId`, `runIds` with
   the new id; ids past the retention bound are deleted with their `c:` rows).

Why this holds:

- **Restart:** the row is on disk, so a restarted Viewer reads the same
  `lastClaimAt` and the same live run.
- **Repeated checks:** step 2 refuses every check inside the interval; step 1
  refuses every check while a run lives.
- **Two concurrent checks** (a promoted release beside its predecessor for a
  moment): `boundedPatch` runs under `BEGIN IMMEDIATE`, so the second
  transaction reads the first one's `lastClaimAt` and is refused.
- **The interval since the last launch implies a new slot:** if
  `now - lastClaimAt >= intervalMs` then `floor(now / intervalMs) >
  floor(lastClaimAt / intervalMs)`. So the per-slot key is unique per launch,
  and step 3 catches a replayed claim.
- **A crash after the claim:** the run is `claimed`, with no card or no
  launch yet. The next check's reconcile resumes it with the same keys: the
  card create replays by `clientRequestId` and the spawn replays by
  `clientAttemptId === runId` (§6.1–§6.2). No second run is created.
- A failed launch (no account) still counts as the interval's launch, so "the
  next slot tries again" is exactly `lastClaimAt + interval`.
- An interval change applies at the next check: lowering 3 h to 1 h admits a
  claim once an hour has passed since `lastClaimAt`.

### 3.4 Timing bounds

| Constant | Value | Meaning |
| --- | --- | --- |
| `MAINTENANCE_LAUNCH_TIMEOUT_MS` | 30 s | How long `launchIfDue` awaits `executeSpawnRequest` before moving on. The run stays `launching` and the receipt resolves it later. |
| `MAINTENANCE_LAUNCH_GRACE_MS` | 15 min | A run still `claimed`/`launching` with no host after this fails with `launch-failed`. |
| `MAINTENANCE_RUN_TIMEOUT_MS` | 90 min | A run whose turn is still open after this fails with `timed-out`. The manual runs took 5–10 minutes. |

### 3.5 Settlement latency

Checks run every 5 minutes, so a run is settled at most 5 minutes after its
turn ends, and its wake item follows on the settled-child bound (§10).

### 3.6 The onboarding health check

`healthCheck.ts:775` builds its own dependencies and never passes
`maintenance`, so it launches and settles nothing (§3.1). Its `sources`
spread from `defaultSeatTickSources()`, which gains `maintenanceRuns` (§10);
the health check overrides it with `() => []` so its scratch seat is never
handed a real run's item.

## 4. The setting and its exposure

### 4.1 Where it lives

On the existing seat-tick settings row, `seatTickSettings.ts`:

```ts
export interface BoardMaintenanceSetting {
  enabled: boolean;
  intervalHours: number;              // 1..168, integer
  updatedAt: string;
  setBy: SeatTickSettingsActor;       // server-derived, as for the row
}
export interface SeatTickSettings {
  // ...existing fields...
  /** Board maintenance (#2162). Absent or null: off, every 3 h. */
  maintenance?: BoardMaintenanceSetting | null;
}
export interface SeatTickSettingsChange {
  // ...existing fields...
  maintenance?: { enabled?: boolean; intervalHours?: number | null };
}
export interface EffectiveSeatTickSettings {
  // ...existing fields...
  maintenance: { enabled: boolean; intervalHours: number; intervalMs: number };
}
```

Rules, all in `seatTickSettings.ts`:

- `normalizeRow` parses `maintenance`; anything malformed reads as absent.
- `effectiveSeatTickSettings` reads it on both branches (lapsed or not), like
  `monitorPrompt`. `until` never applies to it.
- `seatTickSettingsAreDefault` ignores it (§2.7). `seatTickSettingsAfterLapse`
  keeps it.
- `applySeatTickSettingsChange` adds `"maintenance"` to the touched keys. A
  change carrying only `maintenance` needs no reason. `intervalHours: null`
  restores 3. Following the project's clamp-over-reject rule for agent inputs,
  a number under 1 is stored as 1, over 168 as 168, a fraction is rounded, a
  numeric string is read as its number, and each adjustment returns a note;
  a value that is no number keeps the stored interval with a note.
  `enabled` must be a boolean, as it is for the tick.
- A write stamps `maintenance.updatedAt` and `maintenance.setBy`. The row's
  own `updatedAt`/`setBy` move too, as for any change.

Rollback: a release older than this one drops `maintenance` from a row when it
rewrites that row, which turns maintenance off. That is the safe direction.

### 4.2 The answer both surfaces share

`src/lib/boardMaintenance/answer.ts`:

```ts
export interface BoardMaintenanceRunSummary {
  runId: string;
  taskId: string | null;             // the run's card, for the UI's card link
  conversationId: string | null;
  state: "claimed" | "launching" | "running" | "succeeded" | "failed";
  claimedAt: string;
  launchedAt: string | null;
  endedAt: string | null;
  failure: { kind: MaintenanceFailureKind; detail: string } | null;
  counts: MaintenanceCounts;          // §8.1
  attentionCount: number;
}
export interface BoardMaintenanceAnswer {
  enabled: boolean;
  intervalHours: number;
  defaultIntervalHours: 3;
  minIntervalHours: 1;
  maxIntervalHours: 168;
  updatedAt: string | null;
  setBy: SeatTickSettingsActor | null;
  live: BoardMaintenanceRunSummary | null;
  lastRun: BoardMaintenanceRunSummary | null;       // newest ended run
  /** Earliest instant the trigger admits: lastClaimAt + interval, or the next
      check when nothing ever ran; null while off or while a run is live. */
  nextEligibleAt: string | null;
  /** The "next run" the UI shows: the first tick check at or after
      nextEligibleAt, estimated from the tick's last check and its cadence;
      null when off, while a run is live, or when checks are off. */
  nextRunAt: string | null;
  /** Why the next check would not launch, when it would not. */
  waitingOn: "off" | "live-run" | "interval" | "deployment" | "no-seat" | null;
  /** Verbose reads only (MCP verbose/full): the ended run's log, §8. */
  lastRunLog?: MaintenanceRunLog;
  /** Set when the run store could not be read; the setting still answers. */
  runsError: string | null;
}
export function boardMaintenanceAnswer(project: string, settings: EffectiveSeatTickSettings, ports?: …): BoardMaintenanceAnswer
```

`nextRunAt` is computed on the server from `state.lastCheckAt` and
`policy.checkIntervalMinutes`, both already read for `SeatTickSettingsAnswer`,
so the UI renders it without arithmetic of its own.

### 4.3 MCP: `seat_tick_settings`

- Schema (`server.ts:3871`) gains
  `maintenance: z.object({ enabled: z.boolean().optional(), intervalHours: z.union([z.number(), z.string()]).nullable().optional() }).optional()`
  with the description: "Board maintenance for this project (#2162): a
  built-in agent Delegatus starts on the seat tick at most once per interval
  to keep the board current. enabled turns it on or off; intervalHours is the
  minimum gap between runs (1–168, default 3; null restores 3). Off until
  someone turns it on. Needs no reason."
- `seatTickSettingsTool` maps `args.maintenance` into the change.
- A write acknowledges as today; `changedFields` includes `"maintenance"`.
- A read adds `maintenance: BoardMaintenanceAnswer` without `lastRunLog`;
  `verbose: true` or `full: true` adds `lastRunLog`. The compact block is about
  400 bytes, so `answerSizes.test.ts` and `seatAnswerBudgets.test.ts`
  fixtures move by that much.
- The tool description gains one sentence naming `maintenance`.

### 4.4 HTTP: `/api/monitor/seat-tick/settings`

- `SeatTickSettingsAnswer` gains `maintenance: BoardMaintenanceAnswer`
  (`lastRunLog` omitted).
- `PUT` passes `body.maintenance` through to `applySeatTickSettingsChange`
  untouched, as it does every other field, and answers with a read.

### 4.5 The stage split (A4)

| Stage | Engine | Delivers | Leaves out |
| --- | --- | --- | --- |
| build, review, review-fix | Codex | everything in §3–§10 and the files of §11 except the timer UI: the store, the tick hooks, the role, the guard, the wake item, the setting, and `BoardMaintenanceAnswer` on `seat_tick_settings` and on `GET/PUT /api/monitor/seat-tick/settings` | the timer section of the tick UI and its strings |
| ui, ui-review, ui-fix | Claude | the timer section in the tick UI, its strings, its component tests and its rendered evidence (§4.6) | backend changes; the rest of the tick panel |
| critique | Claude Opus | the proposals of §4.7 | any code |

The backend stage does touch four UI files, because adding a role id makes the
type system require them: `RoleFrameMark.tsx`, `roleFrames.css`,
`AgentMappingTable.tsx` and the role-name keys in `i18n/en.ts` and `uk.ts`
(§11). None of them is the timer.

The contract between the two stages is the `maintenance` block of
`SeatTickSettingsAnswer` (§4.2) and the `maintenance` field of the `PUT` body
(§4.4). The backend review checks that both exist and carry real run records;
the UI stages build only against them.

### 4.6 The UI stage's brief

**Where.** The tick is configured today in one component rendered on two
surfaces: `SeatTickBody.tsx`, inside the desktop popover of `SeatTickChip.tsx`
(incumbent row: the dock and the kanban seat header) and inside the phone
sheet `MobileSeatTickSheet.tsx`. The timer goes into `SeatTickBody.tsx`, so
both surfaces get it from one change. Its body has three groups today:
configured (`seatTick.configuredHead`: on/off, interval, expiry, reason),
actual (`seatTick.actualHead`) and a closed Details. The timer is one new
group between actual and Details, headed «Обслуговування дошки» / "Board
maintenance", with its own controls and its own status lines. The existing
groups stay as they are (the critique stage judges the whole panel).

**Files.**

| File | Change |
| --- | --- |
| `src/components/orchestrator/SeatTickBody.tsx` | the new group: a switch, an interval control, the status lines and the card link; its own draft fields beside `useSeatTickDraft`'s |
| `src/components/orchestrator/useSeatTickSettings.ts` | `SeatTickChange` gains `maintenance?: { enabled?: boolean; intervalHours?: number \| string \| null }`, handed to the server as typed like `wakeIntervalMinutes`; the optimistic overlay covers it |
| `src/components/orchestrator/seatTickView.ts` | a pure `maintenanceReading(answer.maintenance, now, t)` returning the state word, the last-run line, the next-run line and the tone, so the component holds no rules |
| `src/components/mobile/MobileSeatTickSheet.tsx` | only if its footer Save must also send the maintenance change (the draft lives above both surfaces) |
| `src/lib/i18n/en.ts`, `src/lib/i18n/uk.ts` | `seatTick.maintenance.*` keys |
| `src/components/orchestrator/seatTickView.test.ts`, `SeatTickChip.dom.test.tsx`, `src/components/mobile/MobileSeatTickSheet.dom.test.tsx` | the states below |
| `src/components/orchestrator/issue1681Evidence.fixture.tsx` and `issue1681Evidence.browser.test.tsx` | a desktop case: the popover with the timer, 1440 px, light and dark |
| `src/components/mobile/issue1671Evidence.fixture.tsx` and `issue1671Evidence.browser.test.tsx` | a phone case: the sheet with the timer, 390 px, light and dark |

**The API the UI uses.**

- Read: `GET /api/monitor/seat-tick/settings?project=<key>`, the existing call
  in `fetchSeatTickSettings`, polled every `SEAT_TICK_POLL_MS`. The answer's
  `maintenance: BoardMaintenanceAnswer` (§4.2) carries everything:
  - on/off and interval: `enabled`, `intervalHours`, with `defaultIntervalHours`,
    `minIntervalHours`, `maxIntervalHours` for the control;
  - last run: `lastRun.endedAt` (time), `lastRun.state` and `lastRun.failure`
    (result), `lastRun.counts` and `lastRun.attentionCount` (what it did),
    `lastRun.taskId` (the card link);
  - a run in progress: `live.state`, `live.launchedAt`, `live.taskId`;
  - next run: `nextRunAt`, with `waitingOn` saying why a launch is held
    (`deployment`, `no-seat`) and `runsError` when the run store could not be
    read;
  - who changed it: `setBy`, `updatedAt`.
- Write: `PUT /api/monitor/seat-tick/settings` with
  `{ project, maintenance: { enabled?, intervalHours? } }`, through the
  existing `save`. A maintenance-only change needs no reason, and the answer
  is the read-back record. The server clamps an interval outside 1–168 and
  says so; the form shows the stored value from the read-back.

**States to render and test.**

| State | Data | What the group says |
| --- | --- | --- |
| off, never run | `enabled: false`, `lastRun: null` | off; interval control shows 3 h |
| on, never run | `enabled: true`, `lastRun: null`, `nextRunAt` set | on; "first run at the next check" with its time |
| running | `live` set | "running since HH:MM", link to the live card |
| last run succeeded | `lastRun.state: "succeeded"` | time, "done", counts, attention count, card link; next run time |
| last run failed | `lastRun.state: "failed"` | time, the failure reason by kind (the uk/en words of §6.5), card link; next run time |
| held | `waitingOn: "deployment"` or `"no-seat"` | why the next run waits |
| store unreadable | `runsError` set | the setting still editable; a warning line |

The card link opens the task through the board's existing task-open
callback, the one `TaskRelationStrip` receives as `onOpenTask`. A hidden done
card must still open from it.

**Strings.** `seatTick.maintenance.head`, `.enabledLabel`, `.intervalLabel`,
`.intervalHint`, `.never`, `.firstRun`, `.running`, `.lastSucceeded`,
`.lastFailed`, `.counts`, `.attention`, `.openCard`, `.next`,
`.waitingDeployment`, `.waitingNoSeat`, `.runsUnreadable`, and one key per
failure kind (`.failure.noAccount` … `.failure.timedOut`), in en and uk.

**Evidence.** Through the drivers that exist, per the project's one-driver
rule: the two browser cases above write the PNGs the UI stage prompt asks for
into `docs/design/board-maintainer-ui/` (390 px and 1440 px, light and dark)
under `LLV_SEAT_TICK_BROWSER_TEST=1` and `LLV_SWIPE_BROWSER_TEST=1` with
`CHROME_BIN` set. No new capture script.

### 4.7 The critique stage (A5)

After the UI stage and its review, a Claude Opus stage renders the whole
seat-tick settings UI on the lane's head, on every surface it appears on (the
desktop popover in the dock and in the kanban seat header, the phone sheet,
and the tick-settings board card when the schedule departs from the default),
at 390 px and 1440 px, light and dark, in realistic states: tick on and off,
a custom interval with a reason and an expiry, maintenance on with a past
run, a failed run, a live run, and a wake held back by an outstanding
attempt. The fixtures of §4.6 already hold most of these states; the stage
adds the rest to the same drivers.

It writes `docs/design/seat-tick-ui-critique.md` with its images under
`docs/design/seat-tick-ui-critique/`: for each element, whether the user
needs it there and why; what to remove or hide behind Details; what is
missing; what to reorder, regroup or restyle; wording in en and uk; visual
problems (spacing, hierarchy, overflow, contrast); then a ranked list of
concrete proposals (what changes, why, effort S/M/L) and one recommended
layout. It changes no product code. The seat brings the proposals to the
operator.

## 5. The maintainer role and its prompt

### 5.1 The role row

`src/lib/roles/defaults.ts`, appended to `ROLE_DEFAULTS`; `"maintainer"`
appended to `ROLE_IDS` in `types.ts`:

```ts
{
  id: "maintainer",
  name: "Maintainer",
  description: "Keeps one project's board current: statuses, blocked reasons, half-done tasks, inbox attention. Delegatus starts it on the seat tick.",
  config: { engine: "codex", model: CODEX_GPT61_SOL_MODEL, effort: "medium" },
  parameters: [],
  promptScaffold: `${MAINTAINER_BODY} ${SHARED_RULES}`,
  safetyFences: [
    "Files stay untouched: no edits, staging, commits or pushes in any repository; git and gh are for reading.",
    "The board is written only through create_task and update_task. Delegatus refuses every other write from a maintenance run, and every task write that deletes, hides, overwrites details or marks done a task with an open pipeline or a live agent.",
  ],
  capabilities: ["read-only"],
}
```

`CODEX_GPT61_SOL_MODEL` is `"gpt-6.1-sol"` (`agent/models.ts:12`). The
scaffold with the shared rules and its fences measures about 9 300
characters, under `MAX_SCAFFOLD_LENGTH` (12 000). No parameters, so `roleParams` is `{}`.

`"maintainer"` also joins `SPAWN_DENIED_ROLE_IDS` (`spawnAdmission.ts:14`):
native subagents are disabled on its launch, and admission and
`/api/pipelines` refuse a child or a pipeline it originates. That duplicates
the MCP guard (§7) at the admission layer. `reviewerOriginSpawnGuidance`
gains a maintainer sentence: "A board maintenance run starts no agents and no
pipelines; put what needs one on your attention list."

### 5.2 The scaffold text (final)

`MAINTAINER_BODY`, a plain string constant in `defaults.ts` (no backticks, no
`${`), followed by one space and `SHARED_RULES`:

```text
You are the board Maintainer for one Delegatus project. Delegatus started you from the project's seat tick. The brief below names the project, the repository, your run's card, the previous run's record and the work evidence Delegatus measured. Your job this run: make the project's board tell the truth, write into each task what a person needs to know, and give the operator a short list of what needs their attention.

How you work. You change the board with the Delegatus MCP tools create_task and update_task, and with nothing else. Read with the other Delegatus tools, git and gh in the repository the brief names; gh needs the network, so retry a call that fails on DNS a few times. Delegatus refuses these writes from a maintenance run, so do not attempt them: editing, staging, committing or pushing files; starting, messaging, stopping or archiving an agent; creating a pipeline or acting on one or on a flow; deleting anything, clearing details, removing a details line, detaching a link or taking a task off the board; marking done a task that has an open pipeline or a live agent. A refusal is an answer: record it and move on.

1. Previous run. Read the previous run's record in the brief first: what it changed, asked and left alone. Do not repeat or reverse its changes without new evidence, and do not ask again what it asked unless something has changed since. The record is history. Every decision below rests on what you check now.
2. Inventory. Call list_tasks with this project and openOnly: true and follow nextCursor to the end. Then call list_tasks with this project, status done and updatedSince set to the previous run's start, to catch a task closed by mistake. For each open task read get_task, its pipelines (list_pipelines with ids and includeClosed: true reads many at once; get_pipeline with stageId reads one stage), the state of its pull requests and issues through gh (a compact row's "#N open" can be stale), and the agents on it (agent_activity). For every lane id a task's details name, search pull request head branches for it with gh, because work can ship from a lane the task no longer links.
3. Leave alone: the orchestrator seat's own card, which you find through get_orchestrator as the task holding the seat's conversation and never by its title; every card whose details begin with "Delegatus board maintenance run"; every card whose text carries a "monitor-ref:" line, which the seat tick opens and closes itself; every task whose card says it runs on another machine; every task with an open pipeline, except to correct a status that is plainly wrong.
4. Liveness by evidence. A status is a claim. For every agent and pipeline stage a task relies on, look for real work: recent transcript activity (agent_activity lastRecordAt and silentForMs), new commits on its branch (git log), stage attempts that started or settled recently (get_pipeline). Start from the work evidence in the brief and confirm it. A worker that reads as running with no activity for hours, or a finished worker whose task still reads as in progress, is a finding: correct the task and put it on your attention list.
5. Then work through the open tasks in this order.
a. Assignment and status. Work that really runs is assigned; a task with nothing running is inbox. Never set blocked on work the operator has already authorized or on a pipeline that waits for the seat's own decision, and never claim that a queued lane can start.
b. Blocked and news. Blocked is only for a wait outside Delegatus (an operator decision nobody has asked for yet, an account limit, an outside fact), with "Blocked: <reason> — unblocks when <what>" as the first details line. When a task has news a person needs (a merge, a failure, a decision waiting), write it into the task's text in the operator's interface language, as one or two plain sentences under the title.
c. Half done. When part of a task's outcome shipped and the rest did not, mark it done with a sentence saying what shipped, then create_task a continuation in the same project with the same icon and colour: its text names what remains, and its details name the predecessor's task id. Append a line to the predecessor's details naming the continuation's id.
d. Inbox. Review inbox tasks by priority and description. Change a priority only where it is clearly wrong, and put the tasks the operator should look at first on your attention list.
e. Titles and looks. Retitle placeholders, role names, stage ids and prompt excerpts with a human title of 3 to 10 words in the operator's interface language. Fill a missing icon or colour by the colour rule in create_task's description.
6. Done means shipped: the task's pull request is merged and running in production (the brief says what production runs, or how to tell), or the task says no deploy is needed, and nothing it promised is still open. A task that is merged and not deployed stays open, and its text says so.
7. Nothing closes to tidy up. A task that is old (no work for 7 days, judged by its newest assignment, stage attempt or pull request activity and never by updatedAt, which bulk writes refresh), empty, duplicated or unclear goes on your attention list with 2 or 3 options, and stays open. A pipeline its details name that no longer exists is a note on that task.
8. Writing. Send each task's changes in one update_task call where you can. Change details only with appendLine or replaceLine, and give every change one appended line: "Maintenance <date>: <what changed> — <evidence>". Task text is for a person: a title, then at most a few plain sentences. When create_task answers TASK_BOARD_FULL, create the task with board: "hidden" and say so on your attention list.
9. Finish. Before the last line of your final message, write one line per fact in exactly this form:
attention: <task id> | <what the operator should decide or look at, in the operator's interface language> | <option> | <option>
left: <task id> | <why you left it alone>
An attention line carries two or three options when it asks a question and none when it only points at something. Write no attention line when nothing needs the operator. Questions about tasks are the normal result of a completed run, so such a run finishes with pass. Finish with fail only when you could not complete the pass, for example because the board or the forge could not be read, and say what stopped you. Use needs_decision only when the run itself cannot go on without the operator.
```

Checked against the invariants in §1.4: it names no stack, no language, no
`VERDICT`/`APPROVE`/`COMMENT` marker, and the shared rules follow it.
`roleSpawnPrompt` appends the brief and then `SPAWN_COMPLETION`, whose
`Verdict:` line is the last line of the final message.

Every guard from prompt v3 is here: no file edits, no start or stop, no
delete (step "How you work"); `openOnly` and `nextCursor` (2); the seat card
through `get_orchestrator` (3); skip open pipelines except for an obviously
wrong status (3); done means merged and deployed or no deploy needed, nothing
promised open (6); blocked only for outside waits with the `Blocked:` line,
never on authorized work, never on the seat's own decision, no claim that a
queued lane can start (5a, 5b); age by assignment or PR activity (7); old,
empty, duplicate, unclear become questions with options (7); vanished
pipelines noted (7); `appendLine` (8); `gh` over stale compact rows and the
lane-id branch search (2); icon and colour by the colour rule (5e). The
40-write limit of v3 is gone (A1).

### 5.3 The per-run brief

Composed by `maintenanceBrief(input)` in `src/lib/boardMaintenance/text.ts`
and sent as the spawn's `prompt`. English, agent-facing. Template:

```text
Board maintenance run {runId} for project {project}.
Repository: {repoDir}
Your run's card: {taskId}. Delegatus manages it.
The orchestrator seat's card: {seatTaskIds, or "none found; confirm with get_orchestrator"}.
Production: {productionLine}
This run started {claimedAt}. The previous run started {previous.claimedAt or "never"}; use it as updatedSince for the done-task check.

Previous run {previous.runId}: {state}, ended {endedAt}, card {taskId}.
Card summary: {first 600 characters of that card's text}
Changed ({n}):
- {taskId} {change}          e.g. "status assigned → inbox", "closed", "created, continues 1a2b3c4d", "title “…” → “…”", "details +1 line", "icon, colour"
Asked ({n}):
- {taskId} | {question} | {options}
Left alone ({n}):
- {taskId} | {reason}
{or: "No earlier run for this project."}

Work evidence Delegatus measured at {now}, for {k} of {openCount} open tasks (tasks with nothing claiming to run are omitted). Confirm before you act:
- {taskId} {status}: {verdict}, {basis}
```

- `seatTaskIds`: the project's open tasks that hold the active seat's
  conversation, by the predicate `taskSeatHoldingSnapshot()`
  (`tasks/seatHolding.ts:11`) returns, the same test the task commands use.
- `productionLine`: for Delegatus's own project keys (the set
  `viewerOwnProjectKeys()` already computes in `seatTickSources.ts`, exported
  for this), "Delegatus runs {revision} (deployment {id}, succeeded {time}); a
  merge commit is in production when git merge-base --is-ancestor {sha}
  {revision} holds." For every other project: "Delegatus records no
  deployments for this project. Read its instruction files for how it ships;
  when they name none, a merged pull request is shipped."
- Bounds: the previous-run section at most 6 000 characters (each list cut
  with "and N more"), the evidence section at most 80 lines.

## 6. A run's lifecycle

### 6.1 The card

Created by the Viewer right after the claim, through `mutateTasksFile` and
`createTask` with the file resolved per call (the pattern of
`ensureSeatTickCard`, `seatTickController.ts:279`):

```ts
createTask(state.tasks, {
  project,                                   // canonical
  text: maintenanceCardText(locale, "running", …),
  details: maintenanceCardDetails(run),
  icon: "brush-cleaning",
  color: "slate",
  placement: "unplaced",
  clientRequestId: `board-maintenance:${runId}`,
}, state.recentCreates)
```

`createTask` always creates a task in `inbox` (`tasks/commands.ts:381`). The
spawn's task binding adds the run's conversation as an assignment, and adding
an assignment moves an inbox task to `assigned` (`tasks/membership.ts:150`),
so running work reads as assigned without a second write.

When it answers `TASK_BOARD_FULL`, the same create is repeated with
`board: "hidden"`; the run goes on and the UI and the seat still reach the
card. The task id is written to the run (`taskId`) before the spawn. A
store-busy failure leaves the run `claimed` for the next check, up to
`MAINTENANCE_LAUNCH_GRACE_MS`.

Text, by `operatorLocale()` (`uk` or `en`), time in `operatorTimeZone()`
(falling back to the host zone), `DD.MM HH:mm`:

```text
Обслуговування дошки — 30.09 21:00
Delegatus запустив агента, який перевіряє відкриті задачі проєкту: їхні пайплайни, агентів, PR і те, чи робота справді йде. Він виправляє статуси, дописує в описи новини для людини, закриває наполовину виконані задачі й створює для них продовження. Коли він закінчить, тут з'явиться підсумок зі списком того, що потребує вашої уваги, і картка зникне з дошки.
```

```text
Board maintenance — 30.09 21:00
Delegatus started an agent that checks this project's open tasks: their pipelines, agents, pull requests and whether work is really moving. It corrects statuses, writes the news a person needs into descriptions, and closes half-done tasks with a continuation. When it finishes, a summary of what needs your attention appears here and the card leaves the board.
```

Details (agent-facing; its first line is the marker the prompt's step 3
names):

```text
Delegatus board maintenance run {runId}.
Started by the seat tick of {project} at {claimedAt}; interval {N} h. Delegatus manages this card: it is closed and hidden when the run succeeds, and left blocked with the reason when it fails. The run's log: seat_tick_settings verbose, maintenance.lastRunLog.
```

### 6.2 The launch and the binding

`launchMaintenanceConversation(body)` in `run.ts` does what
`launchReportConversation` does: the same-origin operator-capability request
(reusing the exported `reportSpawnHeaders` and `startDeferredSpawnWork`) and
`executeSpawnRequest(request, { ...productionSpawnCommandDependencies, defer: startDeferredSpawnWork })`.
No `internalGrant`: the role spawn's baseline MCP grant is what the run
needs. Body:

```ts
{
  role: "maintainer",                // engine, model and effort from the role row
  roleParams: {},
  cwd: repoDir,
  project,                           // explicit, allowed on the operator lane
  "prompt": maintenanceBrief(…),     // quoted key: the privacy gate reads a bare one as a transcript line
  title: firstLine(cardText),        // "Обслуговування дошки — 30.09 21:00"
  taskId,                            // binds the conversation to the card
  clientAttemptId: runId,
  mcpServers: ["viewer"],
  notifyLauncher: false,
}
```

`repoDir` is `repoDirForProject(project, sources)` (`seatTickSources.ts:1294`),
falling back to the active seat's `launchProfile.cwd` from the registry. With
neither, the run fails at once with `no-repository`.

Answers:

- 2xx: `launchId`, `conversationId`, `path` go to the run
  (`bindMaintenanceConversation` writes `r:` and the `c:` index in one
  transaction), `launchedAt = now`, state `running`, or `launching` while the
  answer's state is `starting`.
- 409 with `code: "project_account_refused"`, `ENGINE_NOT_CONNECTED` or
  `"service_tier_unavailable"`: fail with `no-account`, detail = the answer's
  `error`. The first code is new: the `ProjectAccountRefusedError` branch at
  `spawnCommand.ts:849` gains `code: "project_account_refused"` so this can be
  told apart from other 409s.
- Any other non-2xx: fail with `launch-refused`, detail = the answer's `error`.
- No answer inside `MAINTENANCE_LAUNCH_TIMEOUT_MS`: stay `launching`; the
  receipt found by `spawnReceiptForClientAttempt(runId)` settles it later.

The binding itself is the spawn route's existing `taskId` path: the card gets
the conversation as its assignment, as every `spawn_agent` with `taskId` does.

### 6.3 The run record

```ts
type MaintenanceRunState = "claimed" | "launching" | "running" | "succeeded" | "failed";
type MaintenanceFailureKind =
  | "no-account" | "no-repository" | "launch-refused" | "launch-failed"
  | "host-died" | "turn-error" | "agent-fail" | "timed-out";

interface MaintenanceRun {
  kind: "run";
  runId: string;
  project: string;
  slot: number;
  intervalHours: number;
  claimedAt: string;
  seat: { seatEpoch: number; conversationId: string };
  repoDir: string | null;
  taskId: string | null;
  clientAttemptId: string;            // === runId
  launchId: string | null;
  conversationId: string | null;      // canonical
  transcriptPath: string | null;
  launchedAt: string | null;
  state: MaintenanceRunState;
  endedAt: string | null;
  failure: { kind: MaintenanceFailureKind; detail: string } | null;   // detail redacted, ≤ 300 chars
  log: MaintenanceRunLog;             // §8
  counts: MaintenanceCounts;          // §8.1
  supersededTaskIds: string[];        // earlier blocked cards this run closed (§6.5)
}
```

### 6.4 Observing a live run and detecting failure

`reconcileBoardMaintenance(project)` reads `p:<project>`; with no live
`currentRunId` it returns `null` at the cost of one row read. Otherwise:

- `claimed`: resume the card and the launch (§6.1–§6.2) with the same keys.
- Otherwise `observeMaintenanceRun(run)` (a port) reads:
  1. the spawn receipt, `registry.spawnReceiptForClientAttempt(runId)`;
  2. the registry's liveness verdict for the run's conversation,
     `sources.liveness({ conversationId, stallAfterMs: 30 min, limit: 1 })`,
     the same answer `agent_activity` gives.

| Observation | Condition | Outcome |
| --- | --- | --- |
| failed launch | receipt `rejection`, or state `failed` / `conflicted` | fail `launch-failed`, detail = receipt `error` or rejection guidance |
| failed launch | lifecycle `stalled`/`gone` with reason `launch_unproven_expired`, or still no host past `MAINTENANCE_LAUNCH_GRACE_MS` | fail `launch-failed` |
| dead host | lifecycle `stalled`, reason `host_gone_turn_open` | fail `host-died` |
| running | lifecycle `starting`/`running`, or `waiting` with `permission_request`/`provider_throttled`, or `stalled` with `host_alive_transcript_silent` | none; past `MAINTENANCE_RUN_TIMEOUT_MS` from `launchedAt`, fail `timed-out` |
| turn ended | receipt `completed`, and turn `idle` on a live host (`host_alive_turn_idle`) or host gone with the turn settled (`host_gone_turn_settled`), and `lastRecordAt` after `launchedAt` | read the final message (below) |
| no account | set at launch (§6.2) | already failed |

A turn that ended is judged from `spawnNoticeFinalMessage(conversationId)`
(`spawnNotice/production.ts:104`), which returns the last assistant message
and any engine error from one bounded tail read:

- an engine `error` and no text: fail `turn-error`;
- `detectedVerdict(text)` (`spawnNotice/sweep.ts:90`) is `fail`: fail
  `agent-fail`, detail = the last 300 characters before the verdict line;
- otherwise (`pass`, `needs_decision`, or no verdict line): succeed. A missing
  verdict line is noted in the card's result line.

The attention and left-alone lines are parsed from the same text (§8.2).

A run that failed or timed out stays in the `c:` index, and the guard refuses
its further writes (§7.4). So a zombie run cannot keep writing next to the
next slot's run. Its idle host is reclaimed by the structured-host retirement
sweep (#747); this feature stops no process.

### 6.5 Settling

Card writes come first and the store's state last, so a crash between them
repeats idempotent card writes at the next check.

**Success**, by `settleMaintenanceSuccess(run, final)`:

1. One `patchTask` on the card: `text` = the summary (below),
   `status: "done"`, `board: "hidden"`, `appendLine` = the result line
   (`Result: succeeded {endedAt}; {writes} writes on {tasks} tasks; conversation {id}{; no verdict line}`).
2. Archive the run's conversation card: the board-prefs `hidden` patch for
   `transcriptPath` (resolved from the registry when the launch answered
   none). The loop moves out of `bindings.ts` into
   `src/lib/board/archivePlacement.ts` as
   `archiveConversationPaths(project, action, paths, snapshot, ports)`, and
   both `archiveConversationAction` and the maintenance settle call it.
3. Supersede: every earlier run of the project whose card is still `blocked`
   gets `status: "done"`, `board: "hidden"` and
   `appendLine: "Superseded by maintenance run {runId} (card {taskId})."`.
   Its ids go to `supersededTaskIds`.
4. Store: `state: "succeeded"`, `endedAt`, the parsed log, the counts; clear
   `p.currentRunId`.

Summary text (`uk`; `en` mirrors it):

```text
Обслуговування дошки — 30.09 21:00
Готово о 21:14: змінено 9 задач, 14 записів (статуси — 4, закрито — 2, нових — 1, описи — 5, іконки й кольори — 2).
Потребує вашої уваги (3):
— 1a2b3c4d: Закрити як не потрібне? (так / залишити у вхідних)
— 5e6f7a8b: Лейн працює 6 год без активності — перезапустити?
— 9c0d1e2f: Вирішити пріоритет релізу
```

With nothing for the operator, the last block reads «Нічого не потребує вашої
уваги.» At most 12 attention lines, each cut at 200 characters; the full list
is in the run log.

**Failure**, by `settleMaintenanceFailure(run, failure)`:

1. One `patchTask` on the card: `text` = the failure text (below),
   `status: "blocked"`, the board membership untouched (shown),
   `appendLine: "Result: failed {endedAt}; {kind}: {detail}. The next run starts after {nextEligibleAt}."`.
   The details marker stays the first line; the `Blocked:` first-line
   convention belongs to tasks the maintainer blocks, and this card's reason
   is in its text.
2. Supersede earlier blocked maintenance cards exactly as on success, so at
   most one blocked maintenance card stands per project. Without this a day
   with no account would leave eight blocked cards, the flood #1594 already
   paid for once.
3. Store: `state: "failed"`, `endedAt`, `failure`, whatever log it has; clear
   `p.currentRunId`.
4. No card (its creation never succeeded): only the store settles; the UI's
   `lastRun` and the wake item still say what failed.

Failure text, `uk` (`en` mirrors it):

```text
Обслуговування дошки — 30.09 21:00
Не вдалося: немає доступного акаунта Codex для цього проєкту.
Дошку цей запуск не змінював. Наступна спроба — не раніше 00:00.
```

Reasons by kind: `no-account` «немає доступного акаунта Codex для цього
проєкту», `no-repository` «не знайдено теку репозиторію проєкту»,
`launch-refused` «Delegatus відмовив у запуску», `launch-failed` «агент не
запустився», `host-died` «процес агента зупинився посеред роботи»,
`turn-error` «агент завершився з помилкою», `agent-fail` «агент не зміг
завершити перевірку», `timed-out` «агент не завершив роботу за 90 хвилин».
The engine's own words go into the details line. The second line becomes
«Встиг змінити N задач.» when the log holds changes.

## 7. Guard rails at the MCP boundary

### 7.1 Who is a maintainer

`maintainerCallerOf(dependencies)` in `src/lib/boardMaintenance/guard.ts`:

1. `attribution = attributionOf(dependencies)`: the server-derived caller
   (§1.5). Unidentified: not a maintainer.
2. `conversationId = canonicalConversationId(attribution.conversationId)`
   over the registry snapshot the call already reads.
3. `role = conversationAgentRole(snapshot, conversationId)`: the durable
   `agentRole` the launch receipt stamped. A tick run's launch has
   `role: "maintainer"`, so its conversation carries it for good, through
   resumes and account migrations.
4. `run = maintenanceRunForConversation(conversationId)`: the `c:` index,
   then `r:`. When the collection has never been created, `null`.
5. The caller is a maintainer when `role === "maintainer"` or `run !== null`:
   `{ conversationId, run, project: run?.project ?? projectOf(conversation) }`.

Both transports resolve the same way: a stdio MCP process by its ancestry and
its inherited capability, the shared HTTP endpoint by the capability bound to
the request. A conversation launched with the maintainer role by hand
(`spawn_agent role: "maintainer"`) is guarded the same way; it has no run, so
nothing is logged and no card lifecycle applies (§14).

Residual: a caller no evidence identifies is unguarded. A Viewer-launched run
always carries its admission capability, which identifies it even when its
host pids were never recorded.

### 7.2 Tool-level refusal

In `viewerMcpToolPolicy.permit` (`bindings.ts:5954`), before the existing
archive check: when the tool mutates (`isMutatingMcpTool(tool)`, a new export
over `server.ts`'s `MUTATING_MCP_TOOL_NAMES`), resolve `maintainerCallerOf`
once and, for a maintainer, return `permitMaintainerTool(tool, args)` from
`toolAllowlist.ts` when it refuses:

- allowed: `create_task`, `update_task`, and `agent_activity` and
  `lifecycle_events` (mutating only because their receipts outlive the
  process);
- allowed as reads: `seat_tick_settings`, `account_project_binding`,
  `role_presets` and `auto_updates` when the call carries no change field;
- refused: every other mutating tool, and those four when they carry a
  change. Today that is `spawn_agent`, `send_message`, `create_pipeline`,
  `pipeline_action`, `stage_report`, `link_task_to_pipeline`,
  `deploy_exact_sha`, `flow_action`, `conversation_action`,
  `conversation_migration`, `request_attention`, `suggest_replies`,
  `dismiss_attention`, `bridge_report`, `bridge_directive`,
  `create_orchestrator`, `send_message_to_orchestrator`,
  `ask_orchestrator_in_parallel`, `rotate_orchestrator` and the three
  `telegram_bot_send*` tools. A mutating tool added later is refused to
  maintainers until someone classifies it, and a test pins that every
  mutating tool is classified.

`McpToolVerdict`'s code union gains `"maintainer_tool_refused"`. Error text:
"A board maintenance run writes the board only through create_task and
update_task; {tool} would start, stop, send or change something else, so
Delegatus refused it. Put what you wanted done on your attention list." The
service surfaces the code and the text as it does for `tool_not_permitted`.
Reads are untouched: the policy resolves identity only for mutating calls.

### 7.3 Task-level refusal

`createBoardTask` and `updateBoardTask` call `maintainerCallerOf` and, for a
maintainer, `maintainerTaskWriteRefusal(input)` (pure, in `guard.ts`) before
the task-store transaction. The done check re-reads pipelines inside it.
Refusals are `McpToolRefusal`s with `status: 403` and these codes:

| Code | When | Text (agent-facing) |
| --- | --- | --- |
| `maintainer_run_ended` | the caller's run is `succeeded` or `failed` | "This maintenance run has ended; Delegatus accepts no more board writes from it." |
| `maintainer_project_refused` | `create_task.project`, or the task's project, folds to another project than the run's | "This run maintains {project}; task {id} belongs to {other}." |
| `maintainer_done_refused` | `update_task` sets `status: "done"` on a task with an open pipeline (a pipeline whose `taskIds` include it, with no `closedAt` or `hiddenAt` and a state other than `completed` or `closed`) or a live agent (an assignment conversation whose liveness is `starting`, or whose host is alive with a turn that is not idle) | "Task {id} has {an open pipeline {pid} ({state}) / a live agent {cid} ({lifecycle})}. A maintenance run never marks such a task done; correct only a plainly wrong status, or put it on your attention list." |
| `maintainer_delete_refused` | `details: null` or `""`; `removeLine`; `detachLinks`; `board: "hidden"`; `hide: true` | "A maintenance run deletes nothing and takes nothing off the board; {field} was refused. Use appendLine or replaceLine, or put it on your attention list." |
| `maintainer_details_overwrite_refused` | `details` as a whole string on a task this run did not create | "details as a whole field would replace what the task holds. Send appendLine or replaceLine." |

The live-agent read is the same liveness `agent_activity` answers
(`agentLivenessSnapshot` over `productionLivenessSources`), scoped to the
task's assignment conversations, and it runs only for a maintainer's `done`.
`create_task` with `board: "hidden"` is allowed: it records a new task off a
full board and hides nothing.

There is no write cap (A1).

### 7.4 Logging accepted writes

After a maintainer's `create_task`/`update_task` succeeds and the caller has a
live run, `recordMaintenanceChange(runId, change)` appends to the run's log
(§8.1) from the binding's own before/after values: `changedFields`,
`statusFrom`/`statusTo`, first lines before and after, and the whole previous
text when `text` changed. The log write comes after the task write and is
best-effort: a busy store increments `log.logGaps` and never fails the call
that already succeeded. A replayed `clientRequestId` answers from its receipt
without entering the binding, so nothing is logged twice.

### 7.5 Defence in depth

`SPAWN_DENIED_ROLE_IDS` (§5.1) refuses a maintainer-origin child spawn at
admission and a maintainer-origin pipeline in `/api/pipelines`, and disables
native subagents on its launch, independently of the MCP guard.

## 8. Continuity (A2)

### 8.1 The per-run log

```ts
interface MaintenanceChange {
  at: string;
  taskId: string;
  tool: "create_task" | "update_task";
  fields: string[];                  // changedFields
  statusFrom?: TaskStatus;
  statusTo?: TaskStatus;
  titleFrom?: string;                // ≤ 120 chars
  titleTo?: string;
  textBefore?: string;               // the whole previous text, when text changed
}
interface MaintenanceAttention { taskId: string; text: string; options: string[] }
interface MaintenanceLeftAlone { taskId: string; reason: string }
interface MaintenanceRunLog {
  changes: MaintenanceChange[];       // newest last
  omittedChanges: number;             // past MAINTENANCE_LOG_ENTRY_LIMIT (400)
  logGaps: number;
  attention: MaintenanceAttention[];  // ≤ 40
  leftAlone: MaintenanceLeftAlone[];  // ≤ 200
  verdict: "pass" | "fail" | "needs_decision" | null;
}
interface MaintenanceCounts {
  writes: number;    // accepted create/update calls
  tasks: number;     // distinct task ids written
  status: number;    // status changes other than to done
  closed: number;    // changes to done
  created: number;   // create_task
  text: number;
  details: number;   // details, appendLine, replaceLine
  looks: number;     // icon, color, priority
}
```

`MAINTENANCE_LOG_ENTRY_LIMIT` bounds the stored log. A write past it succeeds
and is counted in `omittedChanges`; the log never refuses a write. Run rows
past the newest 10 per project are deleted at the next claim.

What the log holds comes from two sources, and neither is the agent's claim
about its own writes: the changes are recorded by the server as they happen
(§7.4); the questions and the tasks left alone come from the final message
(§8.2).

### 8.2 Parsing the final message

`parseMaintenanceReport(text)` in `text.ts` reads the lines of the final
message that match `/^\s*(attention|left):\s*(.+)$/i`, splits each on `" | "`,
trims, and keeps a line whose first field is a full task id or an id prefix
of at least 8 hex characters. `attention` keeps up to 3 options. Bounds as in
§8.1, each field cut at 300 characters, everything redacted with
`redactMonitorText`.

### 8.3 Reading the previous run

`previousMaintenanceRun(project, beforeRunId)`: the newest run in `runIds`
before the current one whose state is `succeeded` or `failed`.
`maintenanceBrief` renders it (§5.3) with that run's card text, its changes
summarised one line per entry, its attention and its left-alone lines. The
prompt's step 1 tells the agent to read it first and to decide from what it
checks now. The same log is readable through `seat_tick_settings` with
`verbose: true` (`maintenance.lastRunLog`).

## 9. Liveness by evidence (A3)

`src/lib/boardMaintenance/evidence.ts`, pure:

```ts
export const WORK_QUIET_AFTER_MS = 2 * 60 * 60_000;

export interface WorkerEvidence {
  conversationId: string;
  via: "assignment" | "stage";
  pipelineId?: string;
  stageId?: string;
  lifecycle: LifecycleState | "unknown";
  lastRecordAt: string | null;
}
export interface LaneEvidence {
  pipelineId: string;
  state: PipelineState;
  movedAt: string | null;             // pipelineSummary(pipeline).activityAt newest
  branch: string;
  branchCommitAt: string | null;      // committer date of refs/heads/<branch>
}
export type WorkVerdict = "working" | "quiet" | "finished-open" | "idle";
export interface TaskWorkEvidence {
  taskId: string;
  status: TaskStatus;
  verdict: WorkVerdict;
  lastWorkAt: string | null;          // newest of lastRecordAt, movedAt, branchCommitAt
  workers: WorkerEvidence[];
  lanes: LaneEvidence[];
}

export function taskWorkEvidence(task: BoardTask, workers: WorkerEvidence[], lanes: LaneEvidence[], now: number): TaskWorkEvidence;
export function workEvidenceLines(evidence: readonly TaskWorkEvidence[], now: number, limit = 80): string[];
```

Verdict rules:

- Something claims to run: a worker whose lifecycle is `starting`, `running`
  or `stalled`, or a lane that is open (§7.3's test). Then `working` when
  `lastWorkAt` is within `WORK_QUIET_AFTER_MS`, else `quiet` ("running with no
  activity for long").
- Nothing claims to run, the task is `assigned`, and it has workers or lanes:
  `finished-open` ("a finished worker whose task still reads in progress").
- Otherwise `idle`, which the brief omits.

A line reads, for example,
`1a2b3c4d assigned: quiet, lane 5e6f7a8b running with the last attempt 5 h ago, branch commit 6 h ago, agent 9c0d… silent 5 h`.

Production gathering, `maintenanceWorkEvidence(project, now, sources)` in
`run.ts`, runs once per launch: the project's open tasks; their lanes by
`taskIds`; one `sources.liveness({ project, stallAfterMs: 30 min, limit: 200 })`
read, matched to assignment and stage-attempt conversations; one
`git for-each-ref --format='%(refname:short) %(committerdate:unix)' refs/heads/<branch>…`
in the repository, 5-second timeout. A failed read leaves that field null,
and the line says it was unread. `pipelineSummary` and `viewerOwnProjectKeys`
are exported from `seatTickSources.ts` for this.

The brief hands the result over as a claim to confirm, and the prompt's step
4 makes the rule the maintainer's own.

## 10. The seat wake item

Mirrors `deploy-settled` (§1.7), with one difference: a maintenance run
belongs to the project, so the announcement survives a rotation.

- `types.ts`: `SeatTickWakeReasonKind` and `SEAT_TICK_WAKE_REASON_KINDS` gain
  `"maintenance-settled"`. `SeatTickItem.kind` gains `"maintenance"` and an
  optional `maintenance?: { runId: string }`. `SeatTickCheckInput` gains
  `settledMaintenance?: readonly SeatTickMaintenanceInput[]`:

  ```ts
  interface SeatTickMaintenanceInput {
    runId: string;
    taskId: string | null;
    state: "succeeded" | "failed";
    endedAt: string;
    failure: { kind: MaintenanceFailureKind; detail: string } | null;
    counts: MaintenanceCounts;
    attention: MaintenanceAttention[];     // first 5
    attentionCount: number;
    nextEligibleAt: string | null;
  }
  ```

  `SeatTickWakeCommit` and `SeatTickProjectState` gain
  `announcedMaintenance?: string[]`, bounded by
  `SEAT_TICK_ANNOUNCED_MAINTENANCE_LIMIT = 64`.
- `seatTickSources.ts`: `SeatTickSources` gains the optional port
  `maintenanceRuns?: (project: string) => readonly MaintenanceRun[]`, absent
  reading as none; production reads the store. The gather keeps runs that
  ended within `policy.backlogAfterMs` and are missing from
  `state.announcedMaintenance`, newest last, at most 3. `changeFingerprint`
  gains `m:{runId}:{state}` tokens.
- `seatTick.ts`, `seatTickDecision`: settled maintenance joins the set that
  shortens the bound to `SEAT_TICK_SETTLED_CHILD_WAKE_INTERVAL_MS` (5 min),
  and when a wake is due it adds, right after `deploy-settled`:
  `{ kind: "maintenance-settled", detail: "board maintenance finished: 9 task(s) changed, 3 item(s) for the operator" }`,
  or `"board maintenance failed: {reason}"`, with "and N more" beyond one.
  One item per run leads the items after the deploy lines:

  ```text
  - [maintenance] 1a2b3c4d — board maintenance run finished 21:14Z; 9 task(s) changed in 14 write(s) (status 4, closed 2, created 1, text 5, details 6, looks 2); for the operator (3): 1) 5e6f7a8b: Закрити як не потрібне? [так / залишити у вхідних] 2) … Bring these to the operator with suggest_replies; the card's details and seat_tick_settings verbose hold the full list.
  - [maintenance] 1a2b3c4d — board maintenance run failed 21:14Z: no Codex account this project allows is available. The card stays blocked; the next run starts after 00:00Z.
  ```

  The label is bounded to 1 200 characters. `seatTickWakeCommitPlan` adds
  `announcedMaintenance = items.filter(kind === "maintenance").map(item => item.maintenance.runId)`,
  and `seatTickWakeCommit` records it through `announced(…, LIMIT)`. The
  proactive plan carries an empty list.
- `seatTickState.ts`: normalize the field in both readers (`:77`, `:256`),
  and carry it in `seatTickStateForEpoch` next to `harvestedChildren`, so a
  successor seat is never handed an item its predecessor already received.
- `seatTickAccounting.ts:108`, `:124`: validate the field as the deploy field
  is validated.

A wake that never lands records nothing, so the item stays offerable, as for
every other obligation. While wakes are off for the project the item waits,
within the backlog bound.

## 11. Files

New:

| File | Contents |
| --- | --- |
| `src/lib/boardMaintenance/types.ts` | constants of §3.4 and §8.1, `MaintenanceRun`, `MaintenanceRunLog`, `MaintenanceCounts`, failure kinds |
| `src/lib/boardMaintenance/store.ts` | the `board_maintenance_runs` collection; `claimMaintenanceRun`, `bindMaintenanceConversation`, `patchMaintenanceRun`, `settleMaintenanceRun`, `readMaintenanceProject`, `readMaintenanceRun`, `maintenanceRunForConversation`, `maintenanceRuns`, `previousMaintenanceRun`, `recordMaintenanceChange` |
| `src/lib/boardMaintenance/run.ts` | `BoardMaintenanceController`, `productionBoardMaintenanceController(sources)`, `launchBoardMaintenanceIfDue`, `reconcileBoardMaintenance`, `observeMaintenanceRun`, `launchMaintenanceConversation`, `maintenanceWorkEvidence`, the settle functions |
| `src/lib/boardMaintenance/text.ts` | `maintenanceCardText` (uk/en, running/succeeded/failed), `maintenanceCardDetails`, `maintenanceBrief`, `parseMaintenanceReport`, `maintenanceCounts`, `maintenanceItemLabel` |
| `src/lib/boardMaintenance/evidence.ts` | §9 |
| `src/lib/boardMaintenance/guard.ts` | `maintainerCallerOf`, `maintainerTaskWriteRefusal`, change-entry builders |
| `src/lib/boardMaintenance/answer.ts` | `BoardMaintenanceAnswer`, `boardMaintenanceAnswer` |
| `src/lib/board/archivePlacement.ts` | the archive loop lifted out of `bindings.ts` |

Modified:

| File | Change |
| --- | --- |
| `src/lib/roles/types.ts` | `"maintainer"` in `ROLE_IDS` |
| `src/lib/roles/defaults.ts` | `MAINTAINER_BODY`, the role row |
| `src/lib/roles/equivalents.ts` | Claude target for the row: `{ engine: "claude", model: "opus", effort: "medium" }` |
| `src/lib/agent/spawnAdmission.ts` | `SPAWN_DENIED_ROLE_IDS` + maintainer; guidance sentence |
| `src/lib/agent/spawnCommand.ts` | `code: "project_account_refused"` on the `ProjectAccountRefusedError` answer |
| `src/lib/displayNames.ts` | `KNOWN_ROLE_WORDS` + maintainer |
| `src/components/RoleFrameMark.tsx` | `EMBLEM.maintainer = BrushCleaning` (a `Record<FrameRole, …>`, so the type requires it) |
| `src/styles/roleFrames.css` | `--rf-maintainer*` in the three theme blocks and a `[data-role="maintainer"]` rule, slate tones |
| `src/components/onboarding/AgentMappingTable.tsx` | the row label key (a `Record<RoleId, …>`) |
| `src/lib/i18n/en.ts`, `src/lib/i18n/uk.ts` | `roleCopy.maintainer.name`, `.description`, `onboarding.agents.role.maintainer`; the timer's keys come with the UI stage |
| `src/lib/mcp/server.ts` | `seat_tick_settings.maintenance` schema and description sentence; `role_presets` description lists maintainer; `isMutatingMcpTool` export |
| `src/lib/mcp/toolAllowlist.ts` | `permitMaintainerTool`, the verdict code, a fourth "What identity still decides" bullet |
| `src/lib/mcp/bindings.ts` | the policy hook (§7.2), the task guards and logging (§7.3–§7.4), `seatTickSettingsTool` maintenance, the archive call moved |
| `src/lib/monitor/seatTickSettings.ts` | §4.1 |
| `src/lib/monitor/seatTickSettingsAnswer.ts` | `maintenance` block |
| `src/app/api/monitor/seat-tick/settings/route.ts` | `PUT` passes `maintenance` |
| `src/lib/monitor/seatTickController.ts` | the two hooks, the dependency, the journal clauses |
| `src/lib/monitor/seatTickSources.ts` | `maintenanceRuns` port, gather, fingerprint, exports of `viewerOwnProjectKeys` and `pipelineSummary` |
| `src/lib/monitor/seatTick.ts` | reason, items, interval, commit plan, commit |
| `src/lib/monitor/types.ts` | the types of §10 |
| `src/lib/monitor/seatTickState.ts` | normalize and carry `announcedMaintenance` |
| `src/lib/monitor/seatTickAccounting.ts` | validate `announcedMaintenance` |
| `src/lib/onboarding/healthCheck.ts` | `maintenanceRuns: () => []` in its sources |

UI stage (A4): the files of §4.6. Critique stage (A5): only
`docs/design/seat-tick-ui-critique.md` and its images (§4.7).

Fences held: no telemetry file, no Settings telemetry toggle, no README, no
`AGENTS.md`/`CLAUDE.md`. `i18n/en.ts` and `uk.ts` are also edited by the open
install-ping lane (8ad423ea); expect a text conflict there and resolve it by
keeping both sets of keys.

## 12. Tests

Run each file by path with an isolated state directory (AGENTS.md: a
directory sweep reaches the operator's live registry):
`LLV_STATE_DIR=$(mktemp -d) bun test <file>`. Heavy gates run under the
project lock:
`flock /var/tmp/llv-heavy-gate.lock bunx tsc --noEmit -p . > "$TMPDIR/tsc.log" 2>&1; echo "exit $?" >> "$TMPDIR/tsc.log"`.
CI runs no unit suite, so this list is the evidence. The lists below are the
backend stage's; the UI stage's follow them.

New:

- `src/lib/boardMaintenance/store.test.ts`
  - once per interval: a claim admits; a second claim at the same instant, at
    +1 min and at +2 h 59 min answers `interval`; at +3 h it admits a new
    run id;
  - across a restart: a claim, then the module cache cleared and a new
    collection opened on the same file, answers `interval`;
  - concurrent: two claims in two processes (a child script beside the test,
    after the `tasks/store.sqliteChild.ts` pattern) on one file at one
    instant, exactly one `claimed: true`;
  - a live run refuses a claim even past the interval; a settled one does not;
  - the key is deterministic per project, interval and slot, and a replayed
    claim of an existing run answers `slot-taken`;
  - retention deletes the eleventh-oldest run and its `c:` row;
  - `recordMaintenanceChange` past the log bound counts `omittedChanges` and
    accepts the write.
- `src/lib/boardMaintenance/run.test.ts` (ports faked; tasks through a temp
  task store):
  - no launch when the setting is off, with no seat, with a live run, or with
    a non-terminal deployment, and the deferred slot is still admissible
    afterwards;
  - a due launch creates the card with `icon: "brush-cleaning"`,
    `color: "slate"`, the uk title "Обслуговування дошки — DD.MM HH:mm",
    three sentences and the details marker; the spawn body carries
    `role: "maintainer"`, `taskId` = the card, `clientAttemptId` = the run id,
    the repository `cwd` and the project; through the real spawn route's
    binding (the harness `route.binding.test.ts` uses), the card holds the
    run's conversation as its assignment and reads `assigned`;
  - `TASK_BOARD_FULL` retries the card with `board: "hidden"`;
  - 409 `project_account_refused` fails the run with `no-account`, the card
    `blocked`, board shown, reason in its text;
  - a crash after the claim (run left `claimed`): the next reconcile creates
    no second card and replays the spawn under the same key;
  - success: the card is `done`, `board: "hidden"`, summary with counts and
    attention lines, the conversation archived, earlier blocked maintenance
    cards superseded;
  - failure kinds `launch-failed` (receipt failed), `host-died`
    (`host_gone_turn_open`), `turn-error`, `agent-fail` (`Verdict: fail`),
    `timed-out`: the card is `blocked` and visible with its reason;
  - a second settle of an ended run writes nothing.
- `src/lib/boardMaintenance/text.test.ts`: card texts in uk and en for the
  three states; `parseMaintenanceReport` (valid, malformed, bounded,
  redacted); `maintenanceBrief` with a previous run renders its card
  summary, changes, questions and left-alone lines (A2), and without one says
  "No earlier run"; the item label stays within 1 200 characters.
- `src/lib/boardMaintenance/evidence.test.ts` (A3): `working` for recent
  transcript, attempt or branch activity; `quiet` for a running claim with
  every signal older than 2 h; `finished-open` for an assigned task whose
  workers all settled and lanes all closed; `idle` omitted from the lines; a
  null field renders as unread.
- `src/lib/boardMaintenance/guard.test.ts` (pure): each refusal of §7.2 and
  §7.3 with its code: a refused tool, a config tool read allowed and its
  change refused, `done` with an open pipeline, `done` with a live agent,
  `details: null`, `details: ""`, `removeLine`, `detachLinks`,
  `board: "hidden"`, `hide: true`, a whole-field `details` on an existing
  task, another project, an ended run; a `create_task` with `board: "hidden"`
  allowed; a caller without the role and without a run passes everything;
  every tool in `MUTATING_MCP_TOOL_NAMES` is classified.
- `src/lib/boardMaintenance/answer.test.ts`: off by default with 3 h;
  `nextEligibleAt` and `waitingOn` for never-ran, live, interval, deployment,
  no-seat; an unreadable store answers `runsError` beside the setting.
- `src/lib/mcp/maintainerGuard.integration.test.ts`: through
  `createMcpToolService` with `viewerMcpBindings` over a temp state
  directory, a caller whose registry `agentRole` is `maintainer` gets each
  refusal code on the wire, its accepted `update_task` appears in the run
  log, and the same calls from a builder succeed.

Modified:

- `src/lib/monitor/seatTickSettings.test.ts` and `.sqlite.test.ts`: absent
  maintenance reads off/3 h; a maintenance-only change needs no reason and
  raises no card; clamping with notes; it survives a lapse and a restore of
  the default schedule.
- `src/lib/monitor/seatTick.test.ts`: the reason and the item appear for a
  settled run, lead after deploy lines, shorten the bound, go into the commit
  plan, are recorded by a landing and never offered again.
- `src/lib/monitor/seatTickController.test.ts`: with a maintenance
  controller injected, the reconcile runs before the gather (this check's
  wake carries a run that ended since the last check), the launch runs after
  the send, both leave journal clauses, a thrown maintenance error adds a
  clause and the check completes; without one, nothing changes.
- `src/lib/monitor/seatTickState.test.ts`: `announcedMaintenance` normalized,
  bounded, carried across a seat epoch.
- `src/lib/monitor/seatTickAccounting.test.ts`: the field validated.
- `src/lib/monitor/seatTickSources.test.ts`: the gather filters announced,
  aged and live runs; the fingerprint moves with a settled run.
- `src/app/api/monitor/seat-tick/settings/route.test.ts`: `GET` carries
  `maintenance`; `PUT` with `maintenance` writes it and needs no reason.
- `src/lib/mcp/answerSizes.test.ts`, `seatAnswerBudgets.test.ts`,
  `schemaParity.test.ts`: the new field and its size.
- `src/lib/roles/registry.test.ts`: 9 roles; the maintainer's rendered
  prompt contains the v3 guards named in §5.2 and the A2/A3 steps.
- `src/app/api/roles/route.test.ts`: 9 roles. `src/lib/roles/equivalents.test.ts`:
  the new row. `src/lib/mcp/rolePresets.test.ts`: the row reads and writes.
- `src/lib/orchestrator/prompt.test.ts`: the role table follows
  `ROLE_DEFAULTS.length` already; add the maintainer row's text.
- `src/lib/agent/spawnAdmission.test.ts`: the denied set includes the
  maintainer.
- `src/app/api/spawn/route.binding.test.ts`: the account refusal carries
  `code: "project_account_refused"`.
- `src/lib/roleFrames.test.ts`: the new frame role.

Neighbours to run unchanged: `src/lib/monitor/seatTickReports.test.ts`,
`src/lib/monitor/seatTickFence.test.ts`, `src/lib/monitor/report.test.ts`,
`src/lib/mcp/taskDetails.integration.test.ts`,
`src/lib/mcp/taskBoardVisibility.integration.test.ts`,
`src/lib/mcp/toolAllowlist.test.ts`, `src/lib/telegram/reportSpawn.test.ts`,
`src/lib/orchestrator/boardReport.test.ts`.

UI stage (A4), each by path:
`src/components/orchestrator/seatTickView.test.ts` (`maintenanceReading` for
every state of §4.6), `src/components/orchestrator/SeatTickChip.dom.test.tsx`
and `src/components/mobile/MobileSeatTickSheet.dom.test.tsx` (the group
renders from the answer, a toggle and an interval change send
`{ maintenance: … }` through `save`, a refusal rolls the display back, the
card link calls the task-open callback), and the two browser drivers of §4.6
under their environment gates. The critique stage runs no tests.

## 13. Rollout and rollback

- Default off everywhere. After the merge and the deploy, the seat turns it on
  for the Delegatus project with
  `seat_tick_settings { maintenance: { enabled: true } }`, as its note already
  plans, and removes any maintenance routine from its monitor note.
- The shipped row is the runtime the operator asked for, so no role override
  is needed. A role override stored for `maintainer` makes an older release
  refuse the whole `role-presets.json` (`store.ts` throws on an unknown role
  id), which leaves spawns without the operator's mapping after a rollback.
  Set one only once a rollback past this release is off the table.
- A rollback leaves the `board_maintenance_runs` collection unread and drops
  `maintenance` from any settings row the older release rewrites (off).
- No change to the runtime host or to a Bun pin.

## 14. Deferred — not currently justified

- **A write cap, per run or per project.** A1 removed it.
- **Undo of maintainer changes from the card**, and a grouped decision UI for
  its questions: out of scope by the specification. The log keeps the
  previous text of every rewritten task, which is what a later undo would
  need.
- **Guarding the HTTP task routes.** An agent could write tasks through the
  Viewer's HTTP routes with its capability and skip MCP. The spec asks for
  the MCP boundary, which is the one the prompt and the tools lead to.
- **Enforcing "no file edits" in code**, through a Codex read-only sandbox or
  a worktree without write access: the sandbox cuts `gh`'s network (§2.4).
- **A card lifecycle and log for a maintainer launched by hand.** The guard
  applies to it; only tick runs get a card and a log.
- **A dedicated MCP tool for the maintainer's report.** Two line forms in the
  final message carry it.
- **Moving the Viewer-timer spawn helper out of the Telegram module.** The two
  exported helpers are reused as they are.
- **A "run now" action** in MCP or the UI.
- **Stopping a timed-out run's host.** Its writes are refused, and the
  retirement sweep reclaims idle hosts.
- **A seat mandate change.** The wake item says what to do with it.
- **Evidence for every open task on very large boards**, beyond 80 lines.
- **Before-values of fields other than status and text.**

## 15. Validation against the requirement

| Requirement | Where it holds |
| --- | --- |
| An agent on GPT-6.1-Sol, medium | §5.1 role row |
| Works together with the ticker, when the tick fires | §3.1: a phase of the tick check |
| At most once per 3 h | §3.2–§3.3: interval claim, default 3, minimum 1, durable across restart and concurrent checks |
| Launched, and its card created and removed automatically | §6.1 card at launch, §6.5 done + hidden + archived on success |
| Card with an icon and a description | §6.1: `brush-cleaning`, `slate`, operator-locale title and three sentences |
| No pipeline, one agent | §6.2: one `executeSpawnRequest`; the role is absent from `PIPELINE_ROLE_IDS` |
| Goes through every task: pipeline, agents, done, merged | §5.2 steps 2, 4, 6 |
| Assignments first | §5.2 step 5a |
| Blocked, and news written into the description | §5.2 step 5b |
| Half-done tasks closed with a continuation | §5.2 step 5c |
| Inbox by priority and description, attention for the operator | §5.2 step 5d, final lines, §10 wake item |
| Pinned spec 1 (trigger, no deploy, durable key) | §3, §2.1 |
| Pinned spec 2 (setting in seat_tick_settings and the tick card, default off) | §4, §2.2, §2.7 |
| Pinned spec 3 (role, runtime, allowed accounts, no-account failure) | §5.1, §6.2, §6.5 |
| Pinned spec 4 (card lifecycle) | §6 |
| Pinned spec 5 (what the maintainer does) | §5.2 |
| Pinned spec 6 (guard rails in code; cap dropped by A1) | §7 |
| Pinned spec 7 (seat wake item) | §10 |
| A1 no write cap | §7: no cap in code or prompt; the other guard rails stay |
| A2 continuity | §8, §5.2 step 1, §5.3 |
| A3 liveness by evidence | §9, §5.2 step 4 |
| A4 timer in the tick UI, backend and UI split | §4.2–§4.6 |
| A5 critique of the whole tick UI | §4.7 |

## 16. Operator decisions

None is needed. The choices this design makes on its own, each settled by the
code: deferral on any running Delegatus deployment (§2.1); the tick surface as
the popover and the phone sheet (§2.2); archiving the run's conversation so
the hidden card actually leaves the board (§2.3); maintenance independent of
the wake switch (§2.8); at most one blocked maintenance card per project
(§6.5); the maintainer's writes limited to create and update, with deletes,
hides and details overwrites refused (§7).
