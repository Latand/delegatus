# A spawned agent tells its launcher when it finishes

## Originating requirement

Operator, in the orchestrator seat's chat, 2026-09-29 10:45 UTC (Ukrainian, verbatim):

> Зроби це в самому Delegatus: кожен запущений агент сам повідомляє того, хто його запустив

Translation: "Build it into Delegatus itself: every launched agent notifies
whoever launched it." It answered the seat's proposal at 10:42 UTC, which
followed the operator's 10:41 request that agents message the seat back when
they finish. The trigger case: the seat spawned a reviewer for PR #2315. The
reviewer finished at 22:23 UTC and the seat noticed about two hours later.

## What exists today, and the premise that does not hold

- **Pipeline stages already report.** The pipeline controller settles a stage
  when its turn ends, and the seat tick wakes the seat with `own-lane-settled`
  (`src/lib/monitor/types.ts:197-199`).
- **The seat tick already harvests its children's turn outcomes**
  (`child-terminal`, #1465, `src/lib/monitor/types.ts:194-196`). It finds
  children through lineage edges whose `parentConversationId` is the seat
  (`src/lib/agent/sqliteRegistryStore.ts:771-783`).
- **The spec says the launcher is known from lineage. For the case that
  matters, it is not.** `spawn_agent` reaches `/api/spawn` with the operator
  capability (`src/lib/mcp/bindings.ts:3273-3278`), so the route never records
  the caller as parent. A parent exists only when the call names
  `parentConversationId`, `src` or `parent`
  (`src/lib/mcp/server.ts:3283`, `src/lib/orchestrator/prompt.ts:285-290`).
  A reviewer that names no parent is parented on the conversation it
  **reviews** (`src/lib/agent/spawnParent.ts:99-101`), which is the wrong
  recipient. The same launch records `origin: operator` and depth 0
  (`src/lib/agent/spawnCommand.ts:706-711`). The seat's transcript holds six
  `spawn_agent` calls, including both #2315 reviewers, and none names a
  parent. That is why `child-terminal` never saw the reviewer.
- **The MCP server already knows the caller.** Its caller attribution comes
  from the server, never from arguments (`src/lib/mcp/bindings.ts:900-920`).
  `send_message` already uses it to author messages
  (`mcpSenderOrigin`, `bindings.ts:939-967`).

So the design records a **launcher** separately from the lineage parent.

## Decisions

### 1. Who the launcher is

- `spawn_agent` stamps `launcherConversationId` from caller attribution:
  `via.deputy ?? conversationId`, for callers of kind `agent` or `manager`.
  It never reads this value from the arguments; `spawnDispatchBody`
  (`bindings.ts:1330-1341`) drops any caller-supplied value.
- `/api/spawn` accepts that body field only on a request that carries a valid
  `mcp` internal service claim (`internalServiceClaim`,
  `src/lib/agent/callerClaims.ts:90`). Without one, it refuses the request.
- For the agent-capability lane, the route sets the launcher to
  `authenticatedCaller.conversationId` (`spawnCommand.ts:709`).
- The launcher and `notifyLauncher` (default `true`) go on `SpawnRequest` →
  receipt → conversation. They are copied at admission the way `agentRole` and
  `delegationDepth` are (`src/lib/agent/registry.ts:5393-5428`). They change
  nothing else: grants, depth, task inheritance and lineage stay as they are.
- The following get no launcher, so they get no notice:
  - UI and operator launches (there is no caller);
  - pipeline stages (the engine launches them);
  - `gateway` callers (the operator's own unmanaged root session; see
    Deferred);
  - unidentified callers.
- The spawn answer adds `launcherNotice: "on" | "off" | "unavailable"`, so the
  caller knows whether its brief still needs a "report back" line.

### 2. What "finished" means (the trigger)

Every `turn-ended` runtime event of a conversation that has a launcher and has
notifications on. The event carries `{conversationId, turnId, outcome}`, where
`outcome` is `completed | interrupted | error`
(`src/lib/runtime/engineHostEvents.ts:334-335`). All three structured engines
emit it:

- Claude: `src/lib/runtime/claudeStreamBrokerHost.ts:1413-1416`, including
  the crash path at `:1182`;
- Copilot: `src/lib/runtime/copilotAcpHost.ts:704-707,989`;
- Codex: `src/lib/runtime/codex.ts:29-34`.

It covers every settled turn, whoever started it.

A turn cannot end with an engine question pending: the broker retires every
open attention at `result` (`claudeStreamBrokerHost.ts:1417-1432`). The
spec's "has not asked a pending question" clause therefore holds by
construction, so the design adds no separate check for it.

The consumer is the runtime host's **orchestration consumer**
(`src/runtime-host/host.ts:64-86`). It handles each event exactly once under a
durable completion mark and replays unconsumed events at boot
(`src/runtime-host/main.ts:277`). A new `turn-ended` branch in
`consumeRuntimeEvent` (`src/lib/runtime/consumers.ts:34-38`) calls a port,
`spawnTurnEnded`. The port does one keyed registry read of the child. If the
child has a launcher, has notifications on and holds no pipeline membership,
the port inserts an **obligation row** keyed `child:turnId` into a new
`spawn-notices` `SqliteStateCollection`, and ignores the insert when the row
already exists. Each row records:

- `endedAt`: the event time;
- `outcome`;
- `startedAt`: the `admittedAt` of the receipt in the child's session
  `recentReceipts` whose `turnId` matches (`src/lib/runtime/contracts.ts:211-240`).

The port must stay cheap. `turn-ended` sits outside
`DURABLE_ENGINE_PUBLICATIONS`, so the host's append waits for this consumer
(`host.ts:15-20,127-131`). The port does no transcript read and no delivery.

### 3. Delivery and idempotency

The Viewer's flow-pipeline controller gains a fire-and-forget port,
`sweepSpawnNotices`, shaped like `sweepAutoMerge`
(`src/lib/pipelines/controller.ts:55-59`). Two things already trigger that
controller: the runtime host's signal on every newly published `turn-ended`
(`host.ts:117-119`), and the 30-second watchdog (`controller.ts:81`).

For each child with pending rows, the sweep works in this order:

1. **Hold** while the child's turn is busy and its host is alive. The turn
   that is running will end and cover these rows. When the child's host is
   gone, the sweep does not hold.
2. **Hold** until 30 s have passed since the last notice sent for this child
   (see coalescing below).
3. **Resolve the recipient**, which is the launcher, with these exceptions:
   - The launcher is a retired seat (it is in `previousOrchestratorSeats`,
     `src/lib/orchestrator/seats.ts:576`). The recipient is the project's
     current seat (`orchestratorSeatFor`, `seats.ts:501`). With no current
     seat, the rows are marked `skipped: no-seat`.
   - The launcher is gone: it is unknown to the registry or has `supersededBy`
     set. The rows are marked `skipped: launcher-gone`.
   - The launcher is closed: it is archived, meaning hidden on its project's
     board (`bindings.ts:4834-4870`). The rows are marked
     `skipped: launcher-closed`.

   A launcher whose host was retired while idle is **not** closed. Retirement
   is routine, and a send resumes the host from its transcript
   (`src/lib/runtime/structuredHostRetirement.ts:42`). This is why the check
   comes before delivery: `deliverConversationMessage` would otherwise resume
   a launcher the operator archived (`src/lib/delivery.ts:733-741`).
4. **Deliver** with `deliverConversationMessage` and these fields:
   - `conversationId`: the recipient;
   - `clientMessageId`: `spawn_notice_<sha256(child:newestTurnId)>`, hashed
     like `sendDownstreamKey` (`bindings.ts:1455`);
   - `origin`: `agentMessageOrigin(snapshot, child)`, which attributes the
     message to the child (#2265, `src/lib/runtime/agentMessageAuthor.ts:29-51`),
     so it never renders as the operator's turn;
   - `policy: "queue"`: a busy launcher gets the message queued, the way
     `send_message` and seat wakes queue (`delivery.ts:692-699`).
5. **Record** the result on the rows: `sent` with the `operationId`, or
   `failed` with the reason. An uncertain result keeps the rows pending, and
   the next sweep retries under the **same** key.

**Exactly once per child turn** rests on three layers:

- the journal's consumer mark;
- the insert-if-absent row;
- the delivery layer's reservation under `clientMessageId`, which answers a
  repeated key from its record instead of sending again.

A Viewer restart between the deliver call and the row update replays the same
key. A runtime-host restart replays the event, and the row insert ignores it.

### 4. Content

```
Agent finished: <title> (<child conversationId>)
Verdict: fail                                     ← first, when detected
Turn completed · ran 12m 04s · 3 turns since the last notice
— or — Turn ended with an error: <reason> · ran 40s
Final message:
<last assistant message, ≤ 4 KB, newlines kept>
[… cut: 9 812 bytes more — conversation_messages conversationId=<child>]
```

- **Verdict:** the last line matching `^Verdict:\s*(pass|fail|needs_decision)\b`
  in the final message.
- **Final message:** read with the same bounded tail read the seat tick uses
  (`src/lib/monitor/childFinalMessage.ts:21-33`), with the limit made a
  parameter and whitespace kept. The cut backs off to a UTF-8 character
  boundary.
- **Error reason:** the outcome word, plus the engine's error text when the
  last assistant or system record carries one. Otherwise it says
  "no reason recorded".
- **Redaction:** the text passes `redactBounded` like every seat-tick excerpt.

### 5. Scope, opt-out, loops, rate

- **Opt-out:** `spawn_agent` accepts `notifyLauncher: false`
  (schema at `src/lib/mcp/server.ts:3267-3300`).
- **No loops, by structure.** A notice goes only to the child's launcher,
  which is fixed at birth and existed before the child. Recipients therefore
  form a tree that notices only climb, so no cycle is possible. A guard also
  refuses a recipient equal to the child.
- **Departure from the pinned spec.** The spec says "a notification never
  triggers a notification". Read literally, that would silence the case the
  requirement is about:
  1. the seat spawns worker W;
  2. W spawns reviewer R and ends its turn;
  3. R's notice starts W's turn, in which W fixes the findings and finishes.

  The literal rule would stop W's notice to the seat. The quote asks that
  "every launched agent notifies whoever launched it", so W's turn notifies
  the seat. What the spec guards against, a notice that bounces back down or
  sideways, cannot happen.
- **Coalescing:** a child gets at most one notice per 30 s. Rows for turns
  that end inside that window, or while the child is busy, fold into the next
  notice. It carries the newest final message, the count of turns it covers,
  and any outcome that was not `completed`.

### 6. The designated orchestrator seat

- **A notice is an ordinary queued agent message and not a tick wake.** The
  tick's fence is held under the tick's own `clientMessageId`
  (`src/lib/monitor/seatTickFence.ts:1-22,48-52`). A notice's different key
  neither holds that fence nor releases it.
- **A notice turn delays the tick, and the delay is bounded.** While the
  notice turn runs, the tick skips as `seat-busy`
  (`src/lib/monitor/seatTick.ts:1093-1097`). A tick wake queued behind a
  notice lands after it. The fence floor is 60 minutes
  (`seatTickFence.ts:41`), far longer than a notice turn, so the wake is not
  retired as unresolved.
- **No double report.** When the seat names itself as parent, the child also
  has a lineage edge, and `child-terminal` would report the same turn. A new
  `childFactsSkipReason` clause (`seatTick.ts:657-667`) skips a child whose
  launcher is that seat and whose notifications are on: the notice owns it.
  Opted-out children keep the tick path.
- **Rotation:** a notice addressed to a retired seat goes to the current seat
  (§3.3). This covers the reviewer that outlives the seat that launched it.

### 7. Tool description

Append to `TOOL_DESCRIPTIONS.spawn_agent` (`src/lib/mcp/server.ts:2950-2954`):

> "When a turn of the new agent ends, Delegatus sends you, the caller, one
> message from it: its title and id, how long it ran, its Verdict line first,
> and its final message (up to 4 KB). Briefs need no 'report back' line. Pass
> `notifyLauncher: false` to turn this off."

After this ships, the seat's standing monitor note should drop its
"send_message_to_orchestrator" brief rule. Otherwise the seat receives each
result twice. That note is operator-owned text; the lane changes no code for
it.

## Tests

Each file below sits beside the code it covers. Run each by path, with
`LLV_STATE_DIR=$(mktemp -d /tmp/llv-notify.XXXX)`. Never sweep
`src/lib/agent/` or `src/app/api/runtime/`.

| Case | File |
|---|---|
| `turn-ended` for an armed child calls the port; an unarmed child, a pipeline stage and an opted-out child do not | `src/lib/runtime/consumers.test.ts` |
| Notice on settle: one deliver call with the hashed key, the child origin and `policy: "queue"`; the verdict line comes first; a 4 KB cut carries the marker | `src/lib/spawnNotice/sweep.test.ts` (new) |
| Error or crash outcome: the reason is in the text | same |
| Restart replay: the same event is consumed twice and a crash falls between deliver and mark; one row and one delivered operation result | same, plus `src/lib/delivery.test.ts` for the key dedup |
| Gone launcher (unknown, superseded, archived): skipped with the reason and deliver never called; an idle launcher with a retired host is delivered | same |
| Retired seat → current seat; no seat → `skipped: no-seat` | same |
| No loop: a notice-started turn of L notifies only L's launcher, and a root L sends nothing | same |
| Coalescing: three turns within 30 s → one notice covering 3; a busy child holds | same |
| `spawn_agent` stamps the launcher from attribution, drops a caller-supplied `launcherConversationId`, forwards `notifyLauncher: false`, and answers `launcherNotice` | `src/lib/mcp/bindings.test.ts` |
| The route accepts the launcher only with the `mcp` claim; the agent lane sets its caller | `src/app/api/spawn/route.test.ts` |
| The seat tick skips `child-terminal` for a notified child of that seat | `src/lib/monitor/seatTick.test.ts` |
| Attribution rendering: the notice row renders as the child's message, never the operator's | `src/components/feed/structuredUserProvenance.test.tsx` |

## Implementation notes

Where the build differs from the text above, and why:

- **Redaction keeps paths.** The notice text passes the secret redactor
  (`hardenedRedact`) and not `redactBounded`. The monitor's redactor also
  collapses every absolute path to `…/name`, because its cards are pasted
  outside Delegatus. A notice is a message between two local conversations,
  the same channel `send_message` uses unredacted, and agents are told to hand
  over files by absolute path, so collapsing them would make the notice less
  useful than reading the transcript.
- **A notice in flight is kept whole.** The sweep writes the exact text, key
  and recipient to the child's row before it calls the delivery layer. A
  restart or an uncertain answer resends that record, so a turn that ends in
  between cannot change the key of a send that may already have landed. An
  uncertain or 5xx answer is retried under the same key for up to 20 passes,
  then the rows are marked `failed`. A 4xx refusal fails them at once.
- **Containers are all memberships.** The consumer skips a child with any
  durable membership (pipeline, flow or orchestrator), matching the seat
  tick's container rule. A `turn-ended` that carries a flow id goes only to
  the flow, as before.
- **The seat tick skip is narrower.** It skips only a `terminal`/`finished`
  child whose launcher is the seat. A launch that failed before it ran ends no
  turn, and a child whose host died over an open turn is a stall, so both stay
  on the tick's own path.
- **Run time** is the newest turn's: its `turn-ended` time minus the admission
  time of the receipt that ran it. Without a receipt the line omits it.
- **Retention:** settled rows are pruned after 14 days, at most once an hour.
- **Only a structured launch records a launcher.** The registry stamps the
  launcher on a receipt only when its transport is `structured`, because only
  a structured child ends its turns in the runtime journal. A tmux child (the
  `LLV_SPAWN_TRANSPORT=tmux` rollback, or no runtime host) records none, so
  the seat tick keeps harvesting it, and `spawn_agent` answers
  `launcherNotice: "unavailable"` unless the route reports
  `transport: "structured"`. The seat tick's skip also requires a structured
  receipt.
- **A fenced obligation write is deferred.** During a release handoff the
  runtime host carries no release revision, so the hot-state store refuses
  its writes (`FileTransactionBusyError`) until the new Viewer activates.
  `consumeRuntimeEvent` turns that refusal from the notice port into
  `RuntimeConsumerDeferredError`. The host leaves the event owed, does not
  count it toward the three-failure quarantine, stops the recovery pass
  without rejecting it (so boot recovery resolves), and retries every owed
  event on one timer until the write is admitted. The other consumers keep
  their existing failure handling.

## Deferred — not currently justified

- **Notices for tmux children.** They emit no journal `turn-ended`, so they
  record no launcher (see Implementation notes) and stay the seat tick's.
  Spawns default to structured wherever a runtime host exists
  (`src/lib/runtime/spawnTransport.ts:32-34`).
- **Gateway (operator root session) launchers.** A notice would be typed into
  a terminal Delegatus does not manage.
- **Counting only turns that the launch or the launcher started.** This needs
  the starting message's origin joined onto the turn. Build it only if turns
  driven by operator chat prove noisy.
- **Marking an open `request_attention` in the notice.**
- **Redirecting notices from a superseded launcher that is not a seat.**
- **A per-launcher mute, and a UI for notices beyond the feed row.**
