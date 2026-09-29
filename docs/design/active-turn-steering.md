# Active-turn steering for agent and seat deliveries

> **Originating requirement — operator, 2026-09-29, Russian, verbatim as pinned on the task:**
>
> «Нужно сделать, чтобы вот эта хуйня, которая пишется у черзі до кодекс, я так понимаю, что это, э-э, live vlog viewer вот это, delegatus, это надо ему передать оркестратору, что он должен, если он использует кодекс, то вот там есть способ отправки добавления в контекст. Если это вот можно использовать для тех моделей, которые мы используем, кхм. То чтобы оно отправлялось приоритетно туда, а потом уже тра в чергу. Потому что если в контекст, то оно сразу, и, ну, ему не нужно, его не сбивает.»
>
> Meaning, as pinned: messages that land in «У черзі до Codex» while a Codex
> conversation's turn is running (operator and directive messages, agent-finished
> and manager notices sent through `send_message` and the seat's delivery paths)
> go into the active turn's context first when Codex supports it, and fall back
> to the queue only when it does not. Observed case: a seat on Codex
> `gpt-6.1-sol`/high held two queued messages, one of them an
> "Agent finished: … Verdict: pass" notice, while its turn ran.

**Result.** The installed Codex app-server supports this. `turn/steer` adds
input to the running turn without interrupting it, answers a definite JSON-RPC
error when it cannot, and the steered input reaches the model at the turn's
next model request (§2, observed on the installed CLI). The design below
changes which policy five call sites use, adds one policy value, and gives the
existing steer path a detached observation, reusing the pattern that injection
already uses. It needs no operator decision.

Contents: §1 today's paths (acceptance 1) · §2 the transport's contract
(acceptance 2) · §3 the design (acceptance 3–5) · §4 tests (acceptance 6) ·
§5 checks · §6 deferred · §7 validation against the quote · §8 notes.

Prior work checked: `search_transcripts` for "turn/steer active turn steering
queue" and "steer-if-active" returned nothing. The closest record is
`docs/design/codex-api-update/README.md`, which pins `turn/steer` at codex
0.153.4 (`:54`: refuses without an active turn, requires a matching
`expectedTurnId`). §2 re-establishes it at the installed version.

## 1. What happens to these messages today (acceptance 1)

### 1.1 Every delivery path and its policy

| # | Path | Entry and hand-off | Policy today | Codex conversation with a running turn |
|---|---|---|---|---|
| 1 | `send_message` (MCP) | `src/lib/mcp/bindings.ts:1468-1490` posts `/api/tmux` with no policy → `src/app/api/conversation-host/handlers.ts:509-517` → `enqueueStructuredMessage`, which fills `policy: request.policy ?? "interrupt-active"` (`src/lib/runtime/structuredMessageDelivery.ts:1275`) | `interrupt-active` | Admitted `queued` (`src/runtime-host/journal.ts:1954-1976`). The drain interrupts the running turn, including one blocked on an approval, then starts a new turn with the message (`src/lib/runtime/structuredDeliveryQueue.ts:1139-1145`, `:1203-1246`). |
| 2 | `send_message_to_orchestrator` | `bindings.ts:4005-4046` resolves the seat and calls `sendMessage` | `interrupt-active` | Same as 1: the seat's turn is interrupted. |
| 3 | `bridge_directive` (operator directive relayed to the seat) | `bindings.ts:3146`, posts `/api/tmux` at `:3221-3231` with no policy | `interrupt-active` | Same as 1. |
| 4 | Spawn completion notice (#2339, "Agent finished: …") | `src/lib/spawnNotice/sweep.ts:160-171` → `src/lib/spawnNotice/production.ts:150` `deliverConversationMessage` → `src/lib/delivery.ts:745-753` | `queue` | `nativeCommandAtAdmission` (`journal.ts:552-561`) turns it into a native-queue add because the session is `codex-app-server` and advertises `nativeQueue`. `src/lib/runtime/nativeQueueExecutor.ts:67-70` calls `thread/queue/add`. Codex holds it and starts a turn with it after the running turn ends. |
| 5 | Board maintenance report | `src/lib/orchestrator/boardReportRun.ts:60-70`, delivered at `:435` | `queue` | Same as 4. |
| 6 | Deputy end note | `src/lib/orchestrator/deputySweep.ts:103-114`, enqueued at `:323` | `queue` | Same as 4. |
| 7 | Seat-tick wake | `src/lib/monitor/seatTickController.ts:1044-1045`, `:1555-1556` | `queue` | Same as 4. The tick sends a wake only to a seat whose turn is not progressing (`src/lib/monitor/seatTick.ts:1100`). |
| 8 | Continuation of a turn a release cut | `src/lib/runtime/startup.ts:686-694` | `queue` with `turnId: null` | Same as 4, fenced to an idle thread. |
| — | Operator composer, for contrast | `src/components/TmuxComposer.tsx:4215-4227` | Default `interrupt-active`; the Steer action sends `steer-if-active` | Unchanged by this design. The default interrupt is the operator's stated preference for their own messages (#1629). |

One document says otherwise: `docs/design/spawn-completion-notice.md:147-148`
states that `send_message` queues. The code above interrupts.

### 1.2 Where «У черзі до Codex» comes from

- The label is `queue.title` (`src/lib/i18n/uk.ts:3050`; English "Queued for
  Codex", `en.ts:3131`), the header of `src/components/NativeQueuePanel.tsx:233`.
- Its rows are the runtime host's native-queue records
  (`src/components/nativeQueueView.ts:185-250` over `journal.nativeQueueRead`),
  one per entry in **Codex's own queue** (`thread/queue/*`, #1629). Codex
  decides when to dispatch them (`NativeQueuePanel.tsx:24-44`).
- An entry exists only for a `send` with `policy: "queue"` to a
  `codex-app-server` session that advertises `nativeQueue`
  (`journal.ts:552-561`). So the observed notice (path 4), and whatever sat
  beside it (paths 5–8), were held by Codex's native queue.
- The Viewer's durable outbox holds a `queue` send only on a host without the
  native queue: the journal row stays `queued` and the drain waits at
  `structuredDeliveryQueue.ts:1154`. Those rows show in the target's composer
  delivery disclosure (`TmuxComposer.tsx:1896`, `src/hooks/useRuntime.ts:231-236`,
  `docs/design/delivery-state.md`), never in this panel.
- Paths 1–3 never reach the panel: they interrupt.

### 1.3 The steering machinery that exists

- `CodexAppServerHost.send` steers when its host has an active turn:
  `turn/steer` with `expectedTurnId` and `clientUserMessageId`
  (`src/lib/runtime/codexAppServerHost.ts:1750-1768`). It then waits for the
  user item carrying that client id (`awaitDeliveryConfirmation`, `:3160-3194`,
  resolved from `item/completed` at `:3762` through `:3210-3240`).
- The drain reaches that branch only for `kind: "steer"` or
  `policy: "steer-if-active"` (`structuredDeliveryQueue.ts:1122-1146`). Their
  refusals end `failed` (`:1260-1262`, `:1306-1316`). A host that declares no
  steer fails `steer-if-active` with `unsupported-steering` (`:1135-1137`,
  pinned by `structuredDeliveryQueue.test.ts:2629`).
- Native-queue "send now" withdraws the native entry, then steers
  (`nativeQueueExecutor.ts:99-108`, `codexAppServerHost.ts:1645-1657`). A steer
  that does not land leaves the entry `withdrawn`, which only an explicit idle
  start can move (`nativeQueueView.ts:170-180`).
- Injection (`thread/inject_items`, #1560) is a separate operation. It
  acknowledges, then observes its item out of band
  (`structuredDeliveryQueue.ts:1650-1760`, `codexAppServerHost.ts:1941-2081`).

### 1.4 Three defects in today's steer path

They are latent while only the operator's explicit Steer uses the path. They
become frequent once agent notices steer, so the design fixes them.

- **D1. One steer holds every conversation's deliveries.** `send` awaits the
  steered item (`codexAppServerHost.ts:1759-1762`). Codex emits that item only
  when the running model request and its tool calls finish (§2.3). The drain
  pass awaits every conversation's target (`structuredDeliveryQueue.ts:830-852`),
  and a new admission joins the running pass (`drain()`, `:696-705`;
  `drainAfterAdmission`, `:713-719`). So a steer into a turn that is running a
  long tool call delays every delivery on the machine until that tool call
  ends, or until the D2 timer fires.
  The injection path names and avoids exactly this hazard (`:1708-1720`).
- **D2. After five minutes the steer restarts the conversation.** The
  confirmation timer (`DEFAULT_DELIVERY_CONFIRMATION_TIMEOUT_MS`, `:307`) calls
  `fail()` (`:3180-3183`). `fail()` marks the host dead and releases it
  (`:3833-3852`, `:3876-3884`), and `release()` signals the Codex child's
  process group (`:2711`, `:2848-2861`). The running turn and its tools die.
  Acceptance 3 forbids this.
- **D3. No fallback.** A refused steer ends `failed`, including a refusal that
  says nothing more than "this turn cannot take input now"
  ("cannot steer a compact turn").

## 2. The installed Codex transport (acceptance 2)

### 2.1 Version and evidence

- Installed: `codex --version` → `codex-cli 0.159.0` (`@openai/codex` 0.159.0,
  the Linux x64 musl binary). Upstream tag `rust-v0.159.0`, commit
  `687a119f0fcaace47e1f1abcc77cec6c813fd6da`, published 2026-09-29.
- CI pins `@openai/codex@0.154.0` as its fixture CLI
  (`.github/workflows/bun-runtime.yml:205-209`).
- Evidence classes used below:
  - **T**: types generated from the installed binary with
    `codex app-server generate-ts` (and `--experimental`).
  - **S**: upstream source at the tag (paths are repository paths in
    `openai/codex`).
  - **B**: strings present in the installed binary. Every refusal message
    quoted in §2.2 is present.
  - **P**: a bounded isolated probe. One `codex app-server` child was started by
    the probe with private `HOME`, `CODEX_HOME`, `XDG_*` and `TMPDIR` under a
    temporary directory, talking to a loopback Responses server that holds
    each response open until the probe releases it. No credentials, no
    external service, no live conversation. The probe stopped its child and
    removed its directory. The script is not part of this change.

### 2.2 Protocol and answers

T: `TurnSteerParams = { threadId, clientUserMessageId?, input, expectedTurnId }`
(`expectedTurnId` is required: "The request fails when it does not match the
currently active turn"). `TurnSteerResponse = { turnId }`.
`CodexErrorInfo` includes `{ activeTurnNotSteerable: { turnKind: "review" | "compact" } }`.

| Situation | Codex answer | Evidence |
|---|---|---|
| Idle thread, no turn | error `-32600` "no active turn to steer" | P (case A); S `codex-rs/app-server/src/request_processors/turn_processor.rs:1087-1093` |
| The turn has just finished | error `-32600` "no active turn to steer" | P (case E). S: `steer_input` requires `active_turn.task` (`codex-rs/core/src/session/turn_input.rs:632-650`), and `on_task_finished` takes the task under the same lock (`codex-rs/core/src/tasks/mod.rs:659-666`) |
| A different turn is active | error `-32600` "expected active turn id \`X\` but found \`Y\`" | P (case B); S `turn_processor.rs:1094-1100` |
| The active turn is a compaction or a review | error `-32600` "cannot steer a compact turn", `data.codexErrorInfo.activeTurnNotSteerable.turnKind: "compact"` | P (case G); S `turn_processor.rs:1101-1136` |
| Host draining | the server-draining error | S `turn_processor.rs:1084-1086` |
| Accepted | `{ turnId }` of the running turn. The input is appended to that turn's pending input. No new turn, no interrupt. | P (case C); S `turn_input.rs:521-563`, `:632-719` |

Every refusal is decided before the input is stored
(`turn_processor.rs:1024-1162`). The one step after storing,
`apply_steered`, does nothing when the request carries no thread settings
(`codex-rs/core/src/session/turn_input.rs:195-198`), and `turn/steer` carries
none. So **any JSON-RPC error reply to `turn/steer` means "not submitted"**.
The host already decodes such a reply as `NativeQueueProtocolRefusal`
(`codexAppServerHost.ts:3588-3594`), and already treats exactly that class as a
proven refusal for injection (`injectionRefusalIsProven`, `:336-354`). A
timeout or a closed pipe proves nothing and stays unknown.

### 2.3 What happens after Codex accepts a steer

1. **Drained at the next model request (the normal case).** The steered item
   appears only after the model request that was running when the steer
   arrived has finished, together with its tool calls. Then Codex records it
   (`item/completed`, `userMessage`, `clientId` = our id) inside the same turn
   and makes another model request that includes it.
   P (case C): no item while the provider held the first response;
   after release, `item/completed userMessage` for the steered client id in
   the same turn, a second provider request whose newest user text was the
   steered text, then `turn/completed`; no `turn/started` for another turn.
   S: "Pending input is drained into history before building the next model
   request" (`codex-rs/core/src/session/turn.rs:417`, `:564`).
2. **Accepted at the very end of the turn.** Input accepted after the task's
   last pending-input check (`codex-rs/core/src/tasks/regular.rs:120`) is
   recorded into the finishing turn by `on_task_finished`
   (`tasks/mod.rs:670-697`; the item is emitted by
   `codex-rs/core/src/hook_runtime.rs:730`, `:762`) before `turn/completed`.
   No further model request follows in that turn. The message is in context
   from the next turn on. S only; the window is too narrow to hit on purpose.
3. **The turn is aborted before the drain** (interrupt, budget limit). Codex
   clears the pending input (`tasks/mod.rs:604-627` → `clear_pending`,
   `codex-rs/core/src/session/input_queue.rs:269-273`). No item is emitted,
   `turn/completed` reports `interrupted`, and the message is absent from
   history. P (case D): steer accepted, `turn/interrupt`, no item for the
   steered id, and `thread/read` listed only the turn's opening message.

In every case, the item for recorded input is emitted before `turn/completed`
on the same ordered stream (P cases C and D; S `tasks/mod.rs:670-697`, `:843`).

### 2.4 Models and capability

`steer_input` checks the turn kind, the output schema and empty input
(`turn_input.rs:632-719`). It never checks the model. Support for
`gpt-6.1-sol` and `gpt-6-luna` therefore follows from the transport, and the
design decides each message from the answer to its own `turn/steer`. The only
static gate is the engine's declaration: `runtimeSteerCapability`
(`src/lib/runtime/contracts.ts:49-53`) and `supportsSteer = true` on the Codex
host (`codexAppServerHost.ts:1280`). No model names appear anywhere.

### 2.5 How Codex's own client uses it

At the tag, the TUI steers first. On "no active turn to steer" it starts a turn
with the same `clientUserMessageId`. On a turn-id mismatch it retries once with
the reported turn. On `activeTurnNotSteerable` it queues the message
(`codex-rs/tui/src/app/thread_routing.rs:751-826`,
`codex-rs/tui/src/app.rs:739-780`). It treats a successful steer as done
(`thread_routing.rs:765-772`), so it has the same end-of-turn window as case 2.
The design below follows the same rule. A mismatch waits for the next drain
pass.

## 3. Design (acceptance 3–5)

### 3.1 One policy value: `steer-or-queue`

**Meaning.** When the target host declares steering and a turn is running,
steer into that turn. If Codex accepts and the input is recorded, the message
is delivered. When the host cannot steer, no turn is running, Codex refuses,
or Codex drops the accepted input, behave exactly as `queue` does on the
Viewer's durable outbox: wait for the running turn to end, then start the next
turn with the message. An outcome nobody can establish ends `uncertain`, as
every unverified send does today. `steer-or-queue` never interrupts, never
becomes a native-queue entry, and takes no turn fence.

Options considered:

| Option | Why it loses |
|---|---|
| Redefine `queue` as steer-first. Every `queue` caller is Delegatus-authored, so no type edits. | `queue` would stop meaning queue. The idle-fenced continuation (path 8) and the seat-tick wake (path 7) would change meaning too. The native-queue conversion at admission would have to be switched off for a value whose name still says queue. |
| Reuse `steer-if-active`. | It is the operator's explicit Steer. It fails `unsupported-steering` on a Claude broker, so agent messages to Claude agents would start failing. |
| Decide from the message's `origin`. | It couples authorship to delivery. It would silently change every Delegatus-origin send, including the idle-fenced continuation. |
| Keep native entries and "send now" them automatically. | Two engine writes per message, and a race with Codex dispatching the entry at turn end (named at `nativeQueueExecutor.ts:99-100`). A failed steer leaves the entry `withdrawn`, which only the operator can move. |

### 3.2 Call sites that change policy

| Call site | Today | After |
|---|---|---|
| `bindings.ts:1480-1490` (`send_message`; `send_message_to_orchestrator` goes through it) | no policy → `interrupt-active` | `policy: "steer-or-queue"` in the `/api/tmux` body |
| `bindings.ts:3221-3231` (`bridge_directive`) | no policy → `interrupt-active` | `policy: "steer-or-queue"` |
| `spawnNotice/sweep.ts:58`, `:170` | `queue` | `steer-or-queue` |
| `boardReportRun.ts:57`, `:69` | `queue` | `steer-or-queue` |
| `deputySweep.ts:108` | `queue` | `steer-or-queue` |

Unchanged, with reasons in §6: the seat-tick wake, the startup continuation,
the operator composer, spawn prompts, the pipeline's resume of a severed turn,
the seat mandate and the deputy's ask.

`docs/design/ghost-seat.md` §4 ("lands as the seat's next turn") and
`docs/design/board-maintenance-report.md` gain one sentence each: the note and
the report now join a running turn by steering, and fall back to the next turn.

### 3.3 Accepting the value where the policy set is listed

Each of these is a one-token or one-line edit:

- Types: `contracts.ts:347` (command), `structuredMessageDelivery.ts:56`
  (request), `structuredDeliveryQueue.ts:148` (effect) and its parse at
  `:308-312`, `src/lib/accounts/migration/contracts.ts:321` (held command),
  `delivery.ts:699` (`ConversationMessage.policy`).
- `src/lib/runtime/commands.ts:168-171`: accept it, and refuse a `turnId`
  beside it ("steer-or-queue follows the live turn and takes no fence").
  Structured admission already stores `turnId: null` and stamps no fence into
  the effect (`journal.ts:1972-1975`, `:519-523`), so the effect never carries
  one. That matters: a fenced message whose turn ended would be refused
  `stale-turn` on every pass.
- `src/lib/agent/registry.ts:2294-2301` `canonicalHeldDeliveryCommand`: keep
  `steer-or-queue`. Today any other value normalizes to `interrupt-active`, so a
  message held across an account switch would replay as an interrupt.
- `structuredMessageDelivery.ts:197-211` (`requiresStructuredCommand`,
  `requiresStructuredHeldCommand`): treat `steer-or-queue` like the default.
  Otherwise a conversation still owned by a legacy pane answers 409
  "legacy delivery cannot preserve structured command semantics"
  (`:170-178`), and `send_message` to it would break. The legacy ladder types
  the text into the pane, as it does today.
- `conversation-host/handlers.ts:219-241`, `:509-537`: read `body.policy`,
  accept only `"steer-or-queue"` (400 for any other value), and forward it to
  `enqueueStructuredMessage` and `deliverConversationMessage`.
- No journal change. `nativeCommandAtAdmission` converts only `queue`
  (`journal.ts:554`), and the structured send branch admits every send as
  `queued` (`:1954-1976`).

### 3.4 Host: a two-phase steer

Add an optional capability to `EngineHost` in the shape of
`CompactCapableHost` (`src/lib/runtime/engineHost.ts:145-162`):

```ts
steer(entry: QueueEntry, firstDispatch?: FirstDispatchEvidence): Promise<{
  turnId: string;
  observe(): Promise<"landed" | "dropped" | "unknown">;
}>;
```

`CodexAppServerHost` implements it. The Claude broker, the Copilot host and the
test fakes do not.

**Phase 1, acceptance: one RPC, inside the drain pass.**

1. The same preflight as `send` (`codexAppServerHost.ts:1703-1729`): a dead
   host or a lost writer fence is refused, images are checked, and
   `confirmedDelivery(entry, firstDispatch)` runs first. A replay whose item is
   already in canonical history gets an acceptance whose `observe()` answers
   `landed` without a second write.
2. Refused before the RPC (`StructuredSendRefusedError`): no active turn on the
   host; `entry.expectedTurnId` set and different from the active turn;
   blocking attention.
3. `turn/steer { threadId, expectedTurnId: <active turn>, clientUserMessageId: entry.id, input }`.
   The input is built exactly as `send` builds it (`:1734-1749`): the
   structured-user marker with the admitted `origin`, the selected card and the
   dedup key.
4. An error reply (`NativeQueueProtocolRefusal`) is a refusal carrying Codex's
   words (§2.2). Anything else is unknown. A timeout still fails the host,
   because `turn/steer` is in `MUTATING_RPC_METHODS` (`:433-437`,
   `:3383-3387`). That existing rule is kept: Codex answers `turn/steer` after
   taking one lock and appending to a list (§2.2), so thirty seconds of silence
   means the app-server itself is wedged, the condition in which every other
   mutating request already fails the host.
5. On success, register the pending confirmation under `entry.id`, recording
   the accepted turn id and **arming no timer**, and return.

**Phase 2, observation: detached, bounded by the turn and the host.**

- `landed`: the `item/completed` user item with this client id arrives (the
  existing `rememberConfirmedDelivery`, `:3210-3240`).
- When `turn/completed` for the accepted turn arrives (`:3796`) and no item was
  seen: one scan with `rolloutConfirmedDelivery`, which `observeInjectedItem`
  already runs after its turn ends (`:2058-2072`). Found → `landed`. Absent →
  `dropped`. Unreadable → `unknown`.
- The host fails, is released, or loses its writer fence → `unknown` (the
  existing `rejectPendingDeliveries`, `:3896-3902`).
- There is no wall-clock deadline and no `fail()`. The turn is the bound. The
  five-minute timer in `awaitDeliveryConfirmation` stays for `turn/start`,
  whose item appears when the turn starts.

`send` keeps its own steer branch for callers outside the queue. Whenever the
queue steers into a Codex turn, it calls `steer`.

### 3.5 Queue: dispatch and adjudication on the original receipt

In `drainTarget` (`structuredDeliveryQueue.ts:1122-1334`):

- `steerRequested` gains
  `effect.policy === "steer-or-queue" && host.supportsSteer === true && refusedTurn(effect) !== health.activeTurnRef`.
  A host that declares no steer (the Claude broker; Copilot, whose steer is an
  interrupt) never takes the steer branch, so `steerByInterrupt` never applies.
  The existing wait at `:1154` holds the message until the host is idle: that
  is the durable queue.
- `refusedTurn` is an in-memory `Map<operationId, turnRef>` beside
  `interruptAcknowledged` (`:640`). It records the turn that refused the
  message. The message does not steer into that turn again; it waits for idle
  or for a different turn. The map is lost on restart, which costs at most one
  more refused RPC.
- To steer on a host that has `steer`, the queue transitions to `delivering`
  as today (`:1190-1198`), consumes its first-dispatch evidence before the
  host call as it does for `send` (`:1254-1256`), then calls
  `host.steer(entry, firstDispatch)`. The
  pass does not wait for `observe()`: it stores the settling promise in an
  `activeSteers` map, exactly as `activeInjections` does (`:668`,
  `:1705-1727`). The pass skips an operation that has an active observation,
  as it does for injections (`:1071`).
- Order barrier (§3.7): while a conversation has an unsettled steer, a later
  send to that conversation may steer into the same turn. A send that would
  start a turn waits. An `interrupt-active` send proceeds.

Adjudication. Every row writes to the admission's own operation id; no new
operation is ever minted.

| Outcome | `steer-or-queue` | Explicit `steer`, `steer-if-active` |
|---|---|---|
| Refused (before the RPC, or a Codex error reply) | `queued`, reason `steer-refused: <Codex's words>`; the turn is remembered | `failed`, as today |
| Unknown (no reply, broken pipe) | `uncertain` through `terminalizeUnverified`, as today (`:1283-1304`) | same |
| Accepted, then `landed` | `delivered`, with `turnId` = the steered turn | same |
| Accepted, then `dropped` | `queued`, reason `steer-dropped` | `failed`, reason `steer-dropped` (today: the host is killed after five minutes, then `uncertain`) |
| Accepted, then `unknown` | `uncertain` | same |

On the idle path a `stale-turn` receipt from `send` already requeues any
`send` other than `steer-if-active` (`:1310-1313`), which covers this policy.

### 3.6 Exactly once, and the one queue entry

- The message is one journal operation with one outbox row from admission to
  its terminal state. This policy never produces a native-queue entry (there is
  no `thread/queue/add` for it), so a steered message cannot also sit in
  «У черзі до Codex», and nothing has to be withdrawn from Codex.
- The row leaves the durable queue exactly once. The terminal transition
  (`delivered`, `failed` or `uncertain`) completes the outbox row inside the
  same journal transaction (`src/lib/runtime/sendSettlement.ts:68-75`), and
  `delivering` is a compare-and-set that a second executor cannot pass
  (`structuredDeliveryQueue.ts:1051-1076`). A `queued` fallback keeps the same
  row, so the waiting message is the same entry.
- A message sent back to `queued` (refused or dropped) is dispatched again under
  the same operation id and the same `clientUserMessageId`. Its revision is past
  1, so it is not a first dispatch, and the host reads canonical history before
  it writes (`codexAppServerHost.ts:3133-3160`). A message that did land is
  confirmed without a second write.
- `dropped` is sound. Codex discards accepted but undrained input on abort
  (§2.3 case 3), and it emits a recorded item before `turn/completed` on the
  same ordered stream. The history read at redispatch covers the one gap left:
  the item notification and the final scan both missing a recorded message.
- `unknown` is absorbing (`uncertain`). `message_receipt` answers it from the
  original receipt with `resend: "verify-first"`, and nothing re-admits it
  under a new key. The spawn-notice sweep retries an uncertain answer under the
  same key (`sweep.ts:185-188`), which the journal answers as a replay.

### 3.7 Order, authorship and receipts

- **Order among agent messages.** The pass drains a conversation in `eventSeq`
  order and stops at the first message that must wait (`:1154` returns true).
  Two steers into one turn keep their order, because Codex stamps each accepted
  input with an acceptance order (`turn_input.rs:632-719`). The barrier closes
  the one reordering that a detached observation opens: M1 is accepted, the
  turn is aborted before the drain, and M2 starts a fresh turn before M1's
  observation settles.
- **One stated exception.** An operator's `interrupt-active` send is never held.
  If it interrupts a turn that holds an accepted agent steer, Codex drops that
  steer, the queue requeues it, and it lands in the operator's new turn after
  the operator's message. The operator chose to cut the turn, so their message
  leads.
- **Authorship (#2265).** The steered text carries the same structured-user
  marker and admitted `origin` as a new turn (`codexAppServerHost.ts:1734-1749`),
  so the feed attributes it to the agent or the Delegatus role, never to the
  operator.
- **Receipts.** The MCP answer is unchanged (`queued` at admission,
  `bindings.ts:1491-1523`), and `message_receipt` reads the one operation. A
  steer waiting behind a long tool call stays `delivering`. The settlement's
  in-turn exemption keeps it open for up to 60 minutes
  (`sendSettlement.ts:137`, `:541-552`).

### 3.8 What the operator sees

- **Landed:** the message appears inside the running turn in the target's
  feed, under its author. No chip; resolved receipts render nothing
  (`delivery-state.md`).
- **Waiting for the turn's next model request:** one `delivering` row in the
  target's composer delivery disclosure.
- **Fell back:** a `queued` row with the reason (for example
  `steer-refused: cannot steer a compact turn`, or `steer-dropped`). It clears
  when the next turn starts with the message.
- **Unknown:** the disclosure's problem row, which asks to verify first.
- **«У черзі до Codex»** no longer receives agent and seat notices. It keeps
  the operator's own native-queue entries and the `queue` paths this design
  leaves alone (the tick wake and the startup continuation). Entries already in
  a native queue at deploy stay there and dispatch at turn end.

### 3.9 Remaining risk: a steer recorded at the very end of a turn

Codex accepts a steer until `on_task_finished` takes the task. Input accepted
after the task's last pending-input check is recorded into the finishing turn
with no further model request (§2.3 case 2). The message is in the model's
context from the next turn on, but nothing starts that turn. The window runs
from the end of the turn's last model request to its `turn/completed`. Codex's
own TUI has the same window (§2.5). The only remedies are a synthetic turn or a
second delivery, and the requirement rules out both. The receipt says
`delivered`, which is true. The case is listed in §6.

## 4. Tests (acceptance 6)

Every test drives the real dispatcher (`StructuredDeliveryQueue`), the real
adjudication, and the real journal or host. None mirrors a helper, and none
names a model.

**A. The real Codex app-server, run on CI.** A new file,
`src/lib/runtime/codexSteerDelivery.integration.test.ts`, guarded by
`test.skipIf(!process.env.NATIVE_CODEX_QUEUE_TEST_BINARY)` and added to the
file list in `scripts/verify-native-codex-runtime.ts`, so the `bun-runtime` job
runs it against its pinned CLI. It is built like
`nativeQueueHost.integration.test.ts:21-162`: a real `CodexAppServerHost`,
`RuntimeJournal` and `StructuredDeliveryQueue`, the loopback Responses server
that holds each response, and the interposing `spawnProcess` wrapper
(`:80-142`). Admission goes through `journal.executeOperation` with
`policy: "steer-or-queue"`.

- **A1, lands during sampling.** Hold response 1 and admit the message. Assert
  one `turn/steer`, no `turn/start` and no `turn/interrupt`. Release response 1.
  Assert that provider request 2 carries the text, that the turn id did not
  change, and that the receipt is `delivered` with that turn id. Assert exactly
  one `userMessage` with this client id in history and no native-queue record.
- **A2, the turn ends before the steer lands.** Hold response 1. The wrapper
  holds `turn/completed` for turn 1 until the `turn/steer` reply has been
  produced, then passes both through in the order Codex produced them. This
  barrier follows protocol frames and uses no sleep. Release response 1 and
  admit the message while the host still reports turn 1 active. Assert that
  Codex answers "no active turn to steer", that the receipt goes `queued`
  (`steer-refused`), and that a `turn/start` with the same `clientUserMessageId`
  follows. The operation ends `delivered` with exactly one `userMessage`.
- **A3, the turn ends after the steer is accepted.** Hold response 1 and admit
  the message. Once it is accepted, admit a runtime interrupt control. Assert
  `turn/completed` interrupted with no item for the message, `queued`
  (`steer-dropped`), then a `turn/start` under the same operation id, `delivered`,
  and exactly one `userMessage` with this client id.
- **A4, idle.** With no turn running, assert `turn/start` and no `turn/steer`.
- **A5, a turn that cannot be steered.** Start `thread/compact/start` on the
  host directly while the provider holds the compaction request. (The queue's
  own compact control already holds messages behind its barrier,
  `structuredDeliveryQueue.ts:1346-1349`, so it would never try the steer.)
  Assert one refused `turn/steer` whose reason carries "cannot steer a compact
  turn", no second `turn/steer` into that turn across two passes, and delivery
  as the next turn.

**B. Host adjudication against a scripted app-server** (`FakeAppServer` in
`codexAppServerHost.test.ts`):

- **B1, the end-of-turn case.** Accepted, then the item, then `turn/completed`
  with no model item after it → `landed`.
- **B2.** `turn/completed` with no item: a rollout that holds the item →
  `landed`; a rollout without it → `dropped`.
- **B3.** No item for longer than `deliveryConfirmationTimeoutMs` (set small)
  while the turn runs → the host is still alive. `turn/start` past its timer
  still fails the host, as today.
- **B4.** Error replies (`-32601`, and `-32600` with `data`) → refused. No
  reply → unknown, and the host fails (existing rule).
- **B5.** The `turn/steer` input carries the origin marker and the dedup key.

**C. The dispatcher with fake hosts** (`structuredDeliveryQueue.test.ts`):

- **C1.** Claude broker (`supportsSteer: false`) with a running turn → no write
  and no interrupt; delivered after idle. Contrast: `:2629` keeps failing
  `steer-if-active`.
- **C2.** Copilot (`steerFallback: "interrupt"`) → no interrupt; delivered after
  idle.
- **C3.** A refused turn is not steered again: two passes, one steer.
- **C4.** The pass is not held: while conversation A's steer is accepted and
  still unobserved, conversation B's send is delivered.
- **C5.** The barrier: M1 is observing and its turn ends `dropped`. M2 on the
  idle path waits. After M1 settles, M1 starts the turn and M2 steers into it.
- **C6.** An `interrupt-active` send is not held by the barrier.
- **C7.** A dying host (extend `:1380` to this policy) → `uncertain`, and no
  second write when the host returns.
- **C8.** An explicit `steer-if-active` that is `dropped` → `failed`, and the
  host is not failed.

**D. Journal and receipt path** (`structuredDelivery.integration.test.ts` with a
real journal):

- **D1.** One operation id goes `queued → delivering → queued (steer-refused) →
  delivering → delivered`. One outbox row is completed once,
  `resolveSendReceipt` answers `delivered`, and no native-queue record exists.
- **D2.** Held across an account switch: `canonicalHeldDeliveryCommand` keeps
  `steer-or-queue` (`registry.test.ts`), and the migration drain replays it as
  a steer.

**E. Call sites:**

- **E1.** `bindings.test.ts`: `send_message`, `send_message_to_orchestrator` and
  `bridge_directive` post `policy: "steer-or-queue"`.
- **E2.** The conversation-host route test: the policy is forwarded; any other
  value gets 400; a legacy-owned target is still delivered through the ladder.
- **E3.** `spawnNotice/sweep.test.ts:99`, the board-report test, and the deputy
  test (`structuredDeliveryQueue.test.ts:2654`, rewritten as "joins the running
  turn by steer and never interrupts it").
- **E4.** `commands.test.ts`: the value parses, and `turnId` beside it is refused.

## 5. Checks for the implementing stage

- Run only the touched test files, by path, with `LLV_STATE_DIR`,
  `XDG_CONFIG_HOME` and `TMPDIR` each set to a fresh `mktemp -d /tmp/...`. Never
  sweep `src/lib/agent/` or `src/app/api/runtime/`.
- Run group A through `bun scripts/verify-native-codex-runtime.ts <absolute codex binary>`
  (private roots). Run it once with the CI pin and once with the CLI installed
  on this host.
- Run `bunx tsc --noEmit`, `bunx eslint <touched files>`, and
  `bun scripts/privacy-publication-gate.ts --base <merge-base>`.
- Claim nothing about installed behaviour until it is deployed and observed.
  After deploy: one agent notice to a busy Codex seat appears in the seat's
  feed inside the running turn, and «У черзі до Codex» stays empty.

## 6. Deferred — not currently justified

- **A follow-up turn for a steer recorded at the very end of a turn** (§3.9).
  It could be detected: the item arrives, then `turn/completed` with no model
  item after it. Any remedy starts a turn nobody asked for or delivers the
  message a second time. Codex's own client accepts the same window.
- **The seat-tick wake.** The tick wakes only a seat whose turn is not
  progressing (`seatTick.ts:1100`). A stalled turn drains steered input no
  sooner than a queued wake would start. The wake's fence has its own delivery
  accounting (`seatTickFence.ts`, #1746, #1672), which this change would put at
  risk for no gain.
- **The startup continuation** (`startup.ts:692`). It is fenced to an idle
  thread by design.
- **The operator composer.** Its default interrupt and its explicit Steer are
  the operator's own choices (#1629). Only the Steer's `dropped` outcome
  changes, because it shares the fixed path: it becomes an honest `failed`
  where today the host is killed.
- **Remembering "unsupported" on `-32601`**, as the host does for injection
  (`codexAppServerHost.ts:2022-2025`). Without it, each message costs one
  refused RPC on an app-server that has no `turn/steer`.
- **Retrying a turn-id mismatch at once** with the reported turn, as the TUI
  does. The next drain pass reaches the same result.
- **Re-attaching an observation after a Viewer restart.** A `delivering` steer
  row follows the existing `delivering` rules and ends `uncertain` unless proven.
- **A detached observation for `turn/start`.** If the host believes the thread
  is idle while a turn runs, `turn/start` steers into that turn (earlier
  research, `codex-api-update/README.md:53`), and the five-minute timer can
  still fail the host. This predates the change and is a separate issue.
- **Mid-turn delivery on Claude and Copilot.** They keep the durable queue.
- **A marker in the UI distinguishing "went into the running turn" from
  "started a turn".** The message's place in the feed already shows it.

## 7. Checked against the requirement

| The operator's words | Where the design meets them |
|---|---|
| «чтобы оно отправлялось приоритетно туда» (send it there first) | Agent notices and the `send_message` family steer into the running turn (§3.2, §3.5). |
| «а потом уже в чергу» (and only then into the queue) | A refusal, a dropped steer, or a host without steering falls back to the durable queue on the same operation (§3.5, §3.6). |
| «если в контекст, то оно сразу» (into context means right away) | The message reaches the model at the turn's next model request, with no new turn (§2.3 case 1, probe case C). |
| «его не сбивает» (it doesn't knock it off) | Nothing on this path interrupts. D2 no longer restarts the conversation. `send_message` stops interrupting (§1.1, §3.4). |
| «если это можно использовать для тех моделей, которые мы используем» (if this works for the models we use) | Each message is decided by Codex's answer to its own `turn/steer`. Codex's steer has no model condition. No model list anywhere (§2.4). |
| The observed notice in «У черзі до Codex» | The spawn completion notice is path 4, which now steers (§3.2). |

## 8. Notes

- **`send_message` to a busy Claude or Copilot agent** interrupts it today.
  After the change it waits for the turn to end, as acceptance 4 asks. An
  orchestrator that must stop a worker uses `conversation_action` with
  `interrupt`.
- **`send_message` to a busy Codex agent** interrupts it today. After the
  change it is steered, and the agent reads it at its next model request. That
  can come after a long tool call.
- **Replays across the deploy.** The journal's request hash includes the
  policy. A `send_message` whose first attempt was admitted before the deploy
  and whose answer was lost, replayed afterwards under the same key, gets an
  idempotency conflict. The MCP receipt store answers most replays before they
  reach the journal, so the exposure is small.
