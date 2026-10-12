# Agent fleet summary: running agents by engine, model, effort, account and pipeline

## Originating requirement

Operator request via the voice relay, 2026-10-12 ~15:00Z (verbatim):

> «Add a way for Delegatus to inspect agent and pipeline resource usage,
> including which agents are running on which pipeline, each agent's
> model/reasoning level/account, and make it easy to get a compact summary
> first and detailed information on demand (for example, counts of agents
> running on Claude/Fable). Account for the existing information-access
> limitations and keep token usage low.»

The seat's pinned task adds the motivating question: «are agents stuck after
the main Claude account hit its five-hour limit?», which today takes about a
dozen calls and tens of kilobytes for a few numbers.

## Verdict in one paragraph

Add one read tool, `agent_fleet`, served by the Viewer. Called with no
arguments it answers a compact summary of about 1 KB: live agents counted by
engine, model, effort and account as `[live, running]` pairs, where they sit
(pipeline stage, seat, other), how many are stalled, waiting on an account
limit, throttled or held on a permission, and per account its session window
and weekly use. `detail: true` or a filter (pipeline, conversation, engine,
model, effort, account, state) adds one compact row per agent, with memory
figures where the Viewer already measures them. The account, model and effort
come from the runtime host's registry entry, with the conversation's
generation and the launch receipt as fallbacks, and read `unknown` when none
records them. A seat and a worker see their own project, and the operator's
root sees every project. Nothing is parsed out of a transcript path, and no
transcript body leaves the tool.

## 1. What the existing tools answer today (measured)

Measured on the live machine on 2026-10-12 at 15:04–15:07Z. The fleet held
58–60 live agent hosts across six projects; 22 of them (12 with an open turn)
belonged to the Delegatus project. Sizes are the bytes of the JSON each tool
returned, read back from the stored MCP receipt (`result_json`), without the
MCP framing.

| Call | Bytes | What it gives for the question | What it lacks |
|---|---:|---|---|
| `agent_activity` compact, `liveOnly` | 15,597 | 60 rows: conversation id, title, turn state, lifecycle, silent-for, pipeline `{id, stage, attempt}` | engine, model, effort, account, project; no counts |
| `agent_activity` full, `liveOnly`, limit 2 | 2,474 | adds engine, project, transcript path, host pid, reason | same gaps; the account is visible only inside the transcript path |
| `agent_activity` full, `liveOnly`, limit 200 | 40,779 | 58 full rows | as above; the compact 24 KB budget does not apply to full answers |
| `resources` (default) | 4,009 | machine memory, Delegatus's own processes, session totals (55 sessions) | no per-agent rows |
| `resources` `full: true` | 45,602 | per host: conversation id, engine, model, role, stage, seat, busy, RSS, process count | effort, account; carries absolute transcript paths and working directories; no CPU |
| `operator_snapshot` | 1,055 | what the operator's view shows (here: nothing focused) | nothing about the fleet |
| `account_limits` | 2,010 | 7 accounts: session and weekly windows, tiers, active flag | how many agents run on each |
| `list_pipelines` open, compact, 3 rows | 3,033 | state, cursor, `stateDetail` | per-agent runtime |
| `list_pipelines` open, compact, `statusOnly` | 23,523 | 31 of 40 rows before the page budget; limit waits only as prose in `stateDetail` («waiting for claude session limit on account <label> …») | counts; the other 9 rows need a second page |
| `get_pipeline` with `stageId` | 1,177 | one stage: engine, model, effort from the definition, attempt and its conversation | the account; the actual runtime after a switch |

Answering «are agents stuck after the main Claude account hit its limit?»
today: `agent_activity` compact (15.6 KB) plus `account_limits` (2.0 KB) plus
two `list_pipelines` pages (about 30 KB) plus one `get_pipeline` per running
stage (about 1.2 KB × 23) plus `resources full` for the model (45.6 KB): about
120 KB over roughly 30 calls. Even then the effort of an agent outside a
pipeline and every agent's account are missing unless the reader parses
transcript paths, which the requirement forbids.

The proposed summary for the same fleet measures **1,042 bytes** (58 agents,
every project) and **1,004 bytes** (22 agents, one project). A detail row
measures about **323 bytes**. The answer to the motivating question was
visible in it: the default Claude account at 100 % of its session window, 9
agents on it with none running, and 5 pipeline stages waiting on its reset.

## 2. Where account, model and effort are durably recorded

| Record | Fields | Notes |
|---|---|---|
| Runtime host registry entry, `entries` rows (`AgentRegistryEntry`, `src/lib/agent/registry.ts:190`) | `accountId`, `launchProfile.model`, `launchProfile.effort`, `structuredHost.memory` (`limitBytes`, `kills`, `src/lib/runtime/agentMemoryState.ts:3`) | The host that runs the transcript, matched on `artifactPath`. A live reconfigure rewrites the entry's and the generation's launch profile together (`registry.ts:2418`–`2421`), so the entry carries the current model and effort. On the live machine all 78 live or idle entries had a non-null account (45 `default`, 33 named), a model and an effort. |
| Registry conversation, latest generation (`NativeGeneration`, `src/lib/accounts/migration/contracts.ts:174`; `RegistryConversation`, `registry.ts:611`) | `accountId`, `launchProfile` | Survives host death; an account migration adds a generation with the new account. |
| Launch receipt (`SpawnReceipt`, `registry.ts:237`) | `accountId` (`:275`), `accountPin`, `launchProfile`, `queuedPinnedSpawn` | What the launch asked for; the last fallback. |
| Pipeline attempt (`pipeline.runs[].attempts[]`, `src/lib/pipelines/types.ts:367`) | `accountId`, `usageLimitedAccounts`, `providerWait` (`:423`: condition, `accountId`, `resetsAt`, `resumeAt`, `actionAt`) | Stage definitions carry engine, model, effort and a pinned account. On the live machine the attempt's account agreed with the registry entry for 23 of 23 live pipeline agents. `providerWait` without `actionAt` is an open limit wait; `stateDetail` is its prose rendering (`src/lib/pipelines/engine.ts:2584`). |
| Viewer resource collector (`ResourceSession`, `src/lib/types.ts:818`) | `rssBytes`, `swapBytes`, `procCount` per host, keyed by `conversationId` | Cached by the Viewer with `sessionsCapturedAt`. No per-agent CPU is measured anywhere; the only CPU figure is the machine's pressure `avg10` used for admission (`src/lib/runtime/cpuPressure.ts`). |
| Transcript path | the account home directory | Not a source. Requirement 3 forbids it. |

## 3. Which tool, and why

**Decision: a new read tool, `agent_fleet`.** The pinned specification allows
a new tool only when no existing one fits, with the reason stated. Each
candidate has a default answer that callers already depend on, and the
requirement needs a default answer that is the summary:

- `agent_activity`. Its default compact answer is one row per conversation.
  The seat mandate (`src/lib/orchestrator/prompt.ts:162`, `:181`), the MCP
  server instructions (`src/lib/mcp/server.ts:4461`), the board maintainer's
  liveness pass (`src/lib/roles/defaults.ts:113`–`116`) and the voice
  companion (`src/lib/voiceCompanion/boardReads.ts`, which maps
  `conversations`) all read those rows. Making the summary its default breaks
  every one of them; leaving rows as the default fails requirement 1.
  Choosing the shape from which arguments happen to be present would be an
  implicit rule nobody can read off the call. It is also classified as
  mutating (it journals stalls, `server.ts:145`–`149`) and runs inside each
  agent's MCP process, while the memory figures live in the Viewer.
- `resources`. Its default is machine memory and Delegatus's own processes;
  its per-host rows carry absolute paths and no effort or account.
- `account_limits`. Account windows only. Adding pipeline, model and effort
  counts to it mixes two subjects in one answer.
- `operator_snapshot`. The operator's current view, not the fleet.

The cost of a new tool is one description in every session's tool catalog,
about 600 bytes. `agent_activity`'s description gains one sentence pointing to
it, so a reader who reaches for rows learns the summary exists.

`agent_fleet` is a pure read: no journal writes, listed in
`OPTIONAL_READ_KEY_TOOLS`, bounded receipt retention. It joins
`VIEWER_LARGE_READS` (`src/lib/mcp/largeReads.ts:11`), so an agent's stdio
MCP process forwards the call to the Viewer, which already holds the scanner
catalog, the registry mirror, the pipelines and the resource cache. The
Viewer answers in under a second from those; it never starts a resource
collection (`fresh` is not offered) and never reads a transcript tail beyond
what the liveness snapshot reads.

## 4. Compact answer (the default)

Called with no arguments. Exact shape, with the live example scoped to one
project and placeholders for account names:

```json
{
  "observedAt": "2026-10-12T15:06:23.787Z",
  "scope": { "project": "<project>" },
  "counts": "[live, running]",
  "agents": { "live": 22, "running": 12, "waiting": 10, "stalled": 0, "limitWait": 0, "throttled": 0, "permission": 0 },
  "where": { "pipeline": 13, "seat": 1, "other": 8 },
  "byEngine": { "claude": [12, 5], "codex": [10, 7] },
  "byModel": { "opus": [7, 5], "gpt-6.1-sol": [6, 3], "gpt-6-luna": [4, 4], "claude-sonnet-5-5": [4, 0], "fable": [1, 0] },
  "byEffort": { "high": [18, 11], "xhigh": [4, 1] },
  "accounts": [
    { "engine": "claude", "account": "account-B", "agents": [7, 5], "session": [9, "2026-10-12T19:30Z"], "weekly": 41 },
    { "engine": "codex", "account": "account-C", "agents": [7, 6], "session": null, "weekly": 47 },
    { "engine": "claude", "account": "default", "agents": [3, 0], "session": [100, "2026-10-12T16:10Z"], "weekly": 26, "active": true },
    { "engine": "claude", "account": "account-A", "agents": [2, 0], "session": [24, "2026-10-12T15:10Z"], "weekly": 43 },
    { "engine": "codex", "account": "account-D", "agents": [2, 1], "session": null, "weekly": 49 },
    { "engine": "codex", "account": "default", "agents": [1, 0], "session": null, "weekly": 51, "active": true }
  ],
  "coverage": { "catalog": "stale" }
}
```

Field rules:

- `counts` names the pair order once. Every `[a, b]` is `[live, running]`.
- `agents.live` counts the liveness rows `agent_activity` with `liveOnly`
  returns for the scope. `running` is lifecycle `running` (an open turn
  under a live host); `waiting` is lifecycle `waiting` (a settled turn
  awaiting input); `stalled` is lifecycle `stalled`. `limitWait` counts
  agents whose pipeline attempt holds an open `providerWait` (stage parked
  for an account reset). `throttled` counts reason `provider_throttled` (the
  engine retrying inside a turn). `permission` counts reason
  `permission_request`.
- When lane 23790aa4 (#2783) is on main, rows carry `activity.state`
  (`working`, `checking`, `idle`) for open turns, and the summary adds
  `"activity": {"working": n, "checking": n, "idle": n}` under `agents`. Its
  words are reused as they are; `idle` there means an open turn silent for
  ten minutes, which this answer keeps apart from `waiting`.
- `where.pipeline` counts rows with a pipeline reference; `seat` counts
  designated orchestrator seats without one; `other` is the rest.
- `byModel` and `byEffort` use the recorded alias (`opus`, `fable`,
  `gpt-6.1-sol`, `high`, …). A launch that pinned no model or effort reads
  `default` (the engine's own default at launch). A row with no registry
  record at all reads `unknown`.
- `accounts` lists every account with at least one agent in scope, plus each
  engine's active account (`"active": true`) even with none, sorted by
  active, limit wait, running, then live. `session` is `[usedPercent, resetsAt]`
  from the same
  durable observations `account_limits` reads, or `null` when the engine
  reports no session window; `weekly` is its used percent. An account whose
  observation is older than the automatic switch accepts adds
  `"fresh": false`. `limitWait` on an account counts the parked stages waiting
  for it. An agent whose account is unknown is counted under
  `"account": "unknown"`.
- `coverage` appears only when the liveness snapshot was partial (`catalog`
  `pending` or `stale`, `evidence: "pending"` with `unverifiedCount`), with
  the same words `agent_activity` uses.
- `scope` is `"all"` for the operator root and `{ "project": "<key>" }`
  otherwise.

**Byte budget.** The compact payload is capped at 2,048 bytes. Measured with
this shape: 1,004 bytes for 22 agents and 1,042 bytes for 58 agents; the
receipt envelope (`ok`, `toolName`, `clientRequestId`, `replayed`) adds about
90. The bulk is account rows, so the cap is kept by folding: past 8 entries
`byModel` folds the smallest into `"other"`, and past 8 accounts the
lowest-priority rows fold into `"moreAccounts": n`
with their total pairs in `moreAccountAgents` and wait count in `moreAccountLimitWait`.
Active accounts and accounts waiting for a reset are retained first; busy
accounts can also fold when necessary to enforce the cap. A unit test pins the cap
at 20 and at 200 agents.

## 5. Detailed answer (on demand)

`detail: true` returns `{summary, agents, nextCursor}`: the summary of the
filtered set plus `agents`, one row per agent. `conversationId` or `pipelineId` imply `detail: true`, since a
summary of one agent or one lane says nothing the rows do not.

Filters, all optional and combinable: `conversationId`, `pipelineId`,
`engine`, `model`, `effort`, `account`, `state`
(`running` | `waiting` | `stalled` | `limitWait` | `throttled` | `permission`),
and `project` (within the access fence). Rows are ordered running first, then
by silence. `limit` 1..200 (default 50); the page is budgeted at 24 KB like
`agent_activity`, with `nextCursor` for the rest.

Row shape (placeholders for ids and account names):

```json
{
  "conversationId": "conversation_<id-1>",
  "title": "<task title, at most 60 characters>",
  "pipeline": { "id": "<pipeline-1>", "stage": "visual", "attempt": 1 },
  "engine": "claude", "model": "opus", "effort": "xhigh", "account": "default",
  "turn": "waiting", "silentForMs": 1312475,
  "limitWait": { "account": "default", "resetsAt": "2026-10-12T16:10:00Z", "resumeAt": "2026-10-12T16:11:00Z" },
  "rssMB": 1398, "procs": 3, "memLimitMB": 4096, "memKills": 0
}
```

```json
{
  "conversationId": "conversation_<id-2>",
  "title": "<task title>",
  "pipeline": { "id": "<pipeline-2>", "stage": "design", "attempt": 1 },
  "engine": "claude", "model": "opus", "effort": "high", "account": "account-B",
  "turn": "running", "silentForMs": 0,
  "rssMB": 1663, "procs": 3, "memLimitMB": 4096, "memKills": 0
}
```

- `title` is the liveness title clamped to 60 characters and passed through
  the caller's redaction projection and `redactPayload`, as `agent_activity`
  does. No transcript path, working directory or transcript text is included.
- `project` is added to each row only when `scope` is `"all"`.
- `turn` is the lifecycle word; with #2783 on main, `activity` and `check`
  ride along exactly as its compact row carries them.
- `stalledForMs`, `retryAt` (throttled) and `permission {tool, reason, since}`
  appear only when set.
- `rssMB` and `procs` come from the Viewer's cached session table and appear
  only when it holds the host; a stale table adds `"memStale": true`.
  `memLimitMB` and `memKills` come from the host's registry record.
- CPU per agent is not measured by the runtime host, so no CPU field exists;
  see Deferred.

## 6. Where each field comes from

| Field | Source | Code |
|---|---|---|
| live set, title, lifecycle, turn, silent/stalled, reason, permission, engine, project, pipeline `{id, stage, attempt}` | `agentLivenessSnapshot` with `liveOnly`, the same call `agent_activity` makes, without `refreshLifecycleJournal` | `src/lib/lifecycle/liveness.ts:977`, `src/lib/mcp/bindings.ts:6227` |
| `activity`, `check` (after #2783) | `row.activity` on the liveness record | lane 23790aa4 |
| account, model, effort | registry entry for the transcript (`registryRowsMatching(file, "entries", "artifactPath", paths)`; a `live`, then `idle` entry wins, then the newest, as `entryForPath` prefers a live host); else the conversation's latest generation; else the newest launch receipt for the conversation id; else `unknown` | `src/lib/agent/sqliteRegistryStore.ts:158`, `registry.ts:3475`, `liveness.ts:467` |
| seat | designated seats from `authorizedManagerSeats` | `bindings.ts:841` |
| limitWait | latest attempt of each open pipeline run whose `providerWait` has no `actionAt`, matched by `attempt.conversationId` | `src/lib/pipelines/types.ts:423` |
| account windows, active, fresh | `accountLimitRows`, the projection behind `account_limits` | `src/lib/mcp/compactAnswers.ts:319`, `bindings.ts:4883` |
| rssMB, procs | Viewer resource cache, `readCachedResourceSessions()`, rows keyed by `conversationId` | `bindings.ts:5810`, `src/lib/types.ts:818` |
| memLimitMB, memKills | `entry.structuredHost.memory` | `src/lib/runtime/agentMemoryState.ts:3` |

## 7. Access fence

The scope follows the server-derived caller (`CallerAttribution`,
`bindings.ts:994`), never an argument:

| Caller | Scope | `project` argument |
|---|---|---|
| operator root (`gateway`: the voice relay and the operator's root session) | every project, `scope: "all"` | narrows to any one project |
| designated seat or its deputy (`manager`) | the seat's own project | another project is refused with `project_out_of_scope`, naming `send_message_to_orchestrator` |
| any other agent (`agent`) | its own project (`callerProjectFromSnapshot`, `bindings.ts:956`) | another project is refused the same way |
| `unidentified` | none until `project` is given | required; answers that one project only |

The in-Viewer voice companion calls the read tools without an attribution and
already fences every read to the session's project before calling
(`src/lib/voiceCompanion/boardReads.ts`), so it lands on the `unidentified`
row with its own project and gets the same compact shape.

What this fence is and is not: today's read tools carry no per-project fence
(the B+ policy in `src/lib/mcp/toolAllowlist.ts` keeps the whole surface open
to every session), so a seat can still list other projects' rows through
`agent_activity`. The fence here scopes this answer as requirement 4 asks and
keeps a seat's summary about its own work; it does not close the older paths,
and changing them is out of scope.

Account names: the answer names account ids to the seat and the operator, as
`account_limits` already does. Bridge reports keep their own scrub: every item
passes `publicSafe`, whose deny list holds every account id and label and a
usage class (`src/lib/bridge/publicSafe.ts:48`, `:61`, `:178`), so a report
that copies an account row is dropped item by item with a warning to the seat.
The tool description says to name accounts as «account A / account B» in a
report. Nothing new is needed there; one test pins it.

## 8. Overlap with other lanes

- **Lane 23790aa4 (#2783, true agent activity).** It adds `activity`
  (`working` / `checking` / `idle`) and `verified` to the liveness record and
  changes the compact `agent_activity` row in `compactAnswers.ts`, plus
  `liveness.ts`, `agentActivity.ts` and the seat tick. This design touches
  none of those files. The new module reads `row.activity` and `row.verified`
  when present and builds on its words; until #2783 merges the `running`
  breakdown is simply absent. Build after #2783 lands, or read the two fields
  structurally so the order does not matter; name the overlap in the PR.
- **Lane 443238cf (#2784, machine-wide worker limit).** Not touched. It edits
  `server.ts` (the `role_presets` description, schema and a bounded numeric
  entry) and `bindings.ts` (spawn role parameters, `getOrchestrator`, the
  seat tick fence); this design adds a separate tool name, description,
  schema and binding, with no shared hunk. Its `workerLimit` read reports
  running counts per project for admission; the fleet summary does not
  duplicate or read that setting.

## 9. Files to change

| File | Change |
|---|---|
| `src/lib/mcp/agentFleet.ts` (new) | Pure projection: `fleetAgents(rows, runtimeFor, seats, limitWaits, sessions)`, `fleetSummary(agents, accountRows, scope)` with the 2,048-byte folding, `fleetDetailRows(agents, filters)`. No I/O. |
| `src/lib/mcp/bindings.ts` | `agentFleet` binding: resolve the scope from the caller, scope receipt replay by the current caller and project before reading a receipt, run `agentLivenessSnapshot` with `liveOnly` and the project, build `runtimeFor` with keyed registry reads for only the selected paths and ids, collect open `providerWait`s from `getPipelines()`, read `accountLimitRows` inputs and the cached sessions, call the module, apply `projectReadText` and `redactPayload`. Register it in `viewerReadTools` with `budgeted("agent_fleet", args, 24_000, …)`. |
| `src/lib/mcp/server.ts` | `agent_fleet` in `MCP_TOOL_NAMES` and `OPTIONAL_READ_KEY_TOOLS`; its description; its input schema (`detail`, the filters, `limit` via `boundedNumericInput`, `cursor`); one sentence in `agent_activity`'s description; in `VIEWER_MCP_BASE_INSTRUCTIONS` the board-reading sentence names `agent_fleet` first for counts by engine, model, effort and account. |
| `src/lib/resources.ts` | Expose the existing durable resource session table without starting or persisting a collection. `readResourcesWithDiagnostic(false, {waitMs: 0})` can start a background collection, so it cannot serve this read. |
| `src/lib/voiceCompanion/readPaths.ts` | Keep voice detail pages within 3,200 bytes before the speech projection. |
| `src/lib/mcp/largeReads.ts` | Add `agent_fleet` to `VIEWER_LARGE_READS`. |
| `src/lib/voiceCompanion/boardReads.ts`, `readSchemas.ts`, `tools.ts` | Add `agent_fleet` to `READ_TOOL_NAMES` with a schema (`detail`, `engine`, `model`, `account`, `state`), a capability line, and a speech projection of the summary (it already fits the 4,000-byte page). |

Requirement 5 is met through the tool description and the server
instructions every session receives. The seat mandate is left alone: its
contract sections are versioned (`prompt.ts:159`–`185`), delivery recognizes
each version, and the delivered mandate sits a few bytes under its envelope
budget, so a sentence there costs a version bump for what the instructions
already say.

## 10. Tests

Each runs by path through `scripts/gate-slot.sh bun test <file>` with an
isolated `HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR`, and
`LLV_VIEWER_CONTROL_URL` on a closed port.

- `src/lib/mcp/agentFleet.test.ts` (new, pure):
  counts by engine, model, effort and account as `[live, running]`;
  `where` split; `limitWait` counts an open `providerWait` and ignores one
  with `actionAt`; `throttled` and `permission`; account `unknown` when the
  entry, generation and receipt all lack it, and the fallback order when only
  the generation or only the receipt has it; model and effort `default` for
  a launch that pinned none; the active account listed with zero agents;
  `fresh: false` passes through; the `activity` breakdown present with
  `activity` and absent without; the compact payload stays under 2,048 bytes
  for 20 and for 200 agents with 12 accounts and 10 models (folding
  applied); detail filters by pipeline, conversation, engine, model, effort,
  account and state; detail rows carry no `transcriptPath`, no `cwd` and no
  message text; paging under the 24 KB budget with a cursor.
- `src/lib/mcp/agentFleet.binding.test.ts` (new, the access fence, with an
  injected registry snapshot, liveness sources, pipelines and account
  observations in a sandbox): the operator root sees two projects and
  narrows to one; a seat sees only its project and is refused another with
  `project_out_of_scope`; a deputy answers as its seat; a worker sees its own
  project; an unidentified caller without `project` is refused and with one
  is answered; titles pass through `redactText`; the call writes nothing to
  the lifecycle journal; a forwarded call (`VIEWER_LARGE_READS`) keeps the
  caller's scope.
- `src/lib/mcp/schemaParity.test.ts`, `src/lib/mcp/largeReads.test.ts`,
  `src/lib/mcp/toolAllowlist.test.ts`: the new name, its schema, its
  forwarding and its read classification.
- `src/lib/voiceCompanion/boardReads.test.ts`: the companion reads
  `agent_fleet` for its own project, refuses another, and speaks the summary.
- `src/lib/bridge/publicSafe.test.ts`: an item quoting a summary account row
  is dropped as class `account`.

The PR body records one compact and one detailed answer from the live
machine with ids and account names replaced by placeholders, and states the
measured byte count.

## 11. Validation against the requirement

| Requirement | Met by |
|---|---|
| which agents run on which pipeline | `where`, and detail rows with `pipeline {id, stage, attempt}`, filter `pipelineId` |
| each agent's model, reasoning level and account | `byModel`, `byEffort`, `accounts`; detail rows; sources in §6, never a transcript path |
| compact summary first, detail on demand | the default answer is the summary (§4); `detail` or a filter adds rows (§5) |
| counts of agents on Claude/Fable | `byEngine` and `byModel` pairs |
| agent and pipeline resource usage | memory per agent where the Viewer measures it; account window use per account; limit waits per account and per stage. CPU per agent is not measured today (Deferred) |
| existing access limitations | §7 |
| keep token usage low | about 1 KB for the motivating question against about 120 KB over 30 calls today |

## Deferred — not currently justified

- **CPU per agent.** The runtime host measures no per-agent CPU; the process
  layer can read a pid's CPU time (`src/lib/proc/types.ts:71`) but nothing
  samples it per host. Adding a sampler is a new collector for a figure the
  request names only in passing; the machine's CPU pressure already gates
  stage starts.
- **Changing `agent_activity`'s default or fencing the older read tools by
  project.** Both are behaviour changes for every existing caller and are not
  needed to answer the request.
- **A seat mandate sentence.** The tool description and server instructions
  carry it without a mandate version bump.
- **Queued pinned launches waiting on a reset** (`receipt.queuedPinnedSpawn`)
  and **flow reviewer waits.** Neither is a running agent; add a count if the
  seat finds it asks for them.
- **Counts of other projects' agents on the same account for a seat.** The
  seat's question is about its own work; the operator root sees all.
- **A feed presentation card for the tool call and a board panel.** The
  request asks for a read the seat and the voice use.
- **Project display names in all-scope rows.** Rows carry the project key
  other tools accept.
