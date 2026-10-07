# Delivery: one rule for every accepted send

Status: design, 2026-10-07. Branch `pipeline/delivery-records-why-it-waits-drains-per-e2f1d249`
(PR #2572), head `dc8769080`. Every `file:line` below is at that head.

## Originating requirement

Board task 7a677014, written 2026-10-06 for the operator (Ukrainian, verbatim):

> Тестові процеси не лишаються сиротами і не душать доставку повідомлень.
> 6 жовтня дванадцять покинутих тестових процесів дві-три доби з'їдали 17–18 із
> 24 ядер, а повідомлення оператора в цей час зависали в черзі. Процеси прибрано
> вручну; це відновлення. Задача закрита, коли тести гарантовано прибирають за
> собою, тестове навантаження не може забрати процесор у продакшену і з'ясовано,
> чому затримувалась доставка.

Acceptance item (6) of the incident handoff received in the seat chat on
2026-10-06 (verbatim): "original-key delivery delays traced, and bounded
visible recovery without duplicate sends."

This pipeline's pinned task (2026-10-07, verbatim, abridged to its outcome):

> Delivery (#2572): one rule for every accepted send — recorded wait,
> per-conversation drain, off-loop writes — then finish on it. … (a) the
> original-key progress record is created the moment the durable reservation
> exists and every later step updates that same record with a reason from the
> shared vocabulary; (b) every drain schedules conversations independently with
> a bounded pass, so one stuck conversation never delays another, while keeping
> each conversation's original-key claim and actuation ownership; (c) every
> registry write on these paths is off the event loop with operation
> correlation, and a refused acquisition leaves the reservation eligible for a
> later pass. … at most one host input per original operation across retries,
> crashes, succession and late acks.

The symptom behind all three: on 2026-10-06 the operator's messages sat behind
a spinner for minutes (409 s and 515 s before host dispatch) and nothing
recorded why. The operator reported the same symptom again from their own
machine the following night.

## Verdict

Lane e2f1d249 fixed each reviewed path where it was found, so each review found
the next one. Six rounds left three open defects at this head, and this design
found five more of the same three kinds (listed in "Paths this design adds").
The design closes the class with one mechanism per rule:

- **(a)** One function opens the original-key record at every reservation
  write and every later step updates it; the background settlement sweep, which
  already reads the registry every 15 s, re-opens a record that is missing (a
  write owed at a crash, a send another process claimed).
- **(b)** The account-migration coordinator, the one drain still awaiting
  conversations one after another, gets the delivery queue's lane model: one
  lane per conversation, a bounded pass, the lane keeps its conversation until
  it ends. Migration advancement stays one at a time.
- **(c)** One generic off-loop registry write (`deliveryWrite`, the existing
  `whenWriterHeld` made public) replaces every remaining synchronous delivery
  write on these paths. Each site has a stated refusal that leaves its
  reservation eligible for a later pass.

The three fences that make a host input happen at most once (journal
operation-id dedup, the `delivering` transition from `pending`/`queued` only,
the registry claim) are unchanged. No new wait reason, no UI change.

## Terms

- **Accepted send**: a message whose durable reservation (`heldDeliveries` row)
  exists, or a retry attempt whose `deliveryOperationOwners` row exists. Before
  that the request has refused or is still admitting, and the composer shows
  its own `transmitting` phase.
- **Original key / original operation**: the client message id and the
  operation id the reservation was admitted under. Every retry of the same
  operation, every reconciliation and every settlement use them.
- **Record**: the `DeliveryProgressRecord` keyed by operation id
  (`src/lib/runtime/deliveryProgress.ts`), written by the Viewer process only,
  write-behind (20 ms), in its own SQLite file beside the registry and the
  journal.
- **Lane**: one conversation's in-flight drain work. It holds that conversation
  until it ends; a pass skips a conversation whose lane is running.
- **Pass**: one run of a drain over all conversations. It waits for its lanes
  only up to a budget, then ends; lanes still running request the next pass
  when they end.
- **Off-loop write**: a registry mutation whose write lock is waited for with
  `SqliteAgentRegistryStore.withWriter` (`src/lib/agent/sqliteRegistryStore.ts:1089`):
  non-blocking `BEGIN IMMEDIATE` probes every 5 ms, a 5 s deadline, the lock kept
  through the one mutation's commit, `{ acquired: false }` when refused.

## The three rules, stated so a test can decide them

**(a) Recorded wait.** For every accepted send, a record keyed by its original
operation exists in the Viewer's store from the synchronous step after the
reservation write returns. It carries the original key, admission time, kind,
settlement deadline and a reason from `DELIVERY_WAIT_REASONS`
(`src/lib/runtime/deliveryWaitReason.ts`). Every later step that changes what
the send waits on updates that same record; nothing creates a second one. A
terminal record changes only by `uncertain → delivered` on proof of arrival, or
by an explicit operator retry that the journal re-armed under the same
operation. Writers take turns:

1. Until the runtime journal holds the operation, the admitting request and
   the account-migration drain write it.
2. Once the journal lists it, the delivery queue writes it.
3. Settlement writes the ending.
4. A writer that may race the queue (any write after a command was sent) writes
   only while the record is still the object it wrote last.

**(b) Per-conversation drain.** Every drain that acts for more than one
conversation (the delivery queue, the background settlement, the
account-migration coordinator) starts each conversation's work independently,
waits for it no longer than its pass budget, and leaves a conversation whose
work is still running to that work. Inside one conversation, order is kept:
claims and journal admissions run in its actuation section
(`src/lib/deliveryActuation.ts`), one held delivery after another.

**(c) Off-loop writes.** Every registry write that creates, claims, re-arms,
requeues, binds or settles a delivery for an accepted send, made by the Viewer
on these paths, waits for the lock off the event loop and carries
`{ label, operationId }` into `blockingWaits`. A refused acquisition writes
nothing, and the site's stated refusal leaves the reservation in a state a
later pass acts on (table in "Rule (c)").

**At most one host input per original operation.** Decided by the fences in
"At most one host input", which this design does not change.

## Every path

"holds" means the rule is met at `dc8769080`, "gap" marks where it is unmet,
and each change (A1–A5, B1, C1–C3) is defined below. "—" means the rule has
nothing to decide on that path.

| # | Path | Entry | (a) recorded wait | (b) drain | (c) writes |
|---|---|---|---|---|---|
| P1 | HTTP admission, live structured host | `enqueueStructuredMessage` `structuredMessageDelivery.ts:1058`; reservation at `:1480`, claim `:1549`, command `:1555` | today: first record only after the journal acknowledges (`noteAdmitted` `:1616`); change A1 | actuation section per conversation; — | hold and claim off-loop; `retryUncertainDelivery` `:1483`, `requeueHeldDelivery` `:1578`, `recordDeliveryOutcome` `:1596` `:1610`, `terminalizeHeldDelivery` `:1490`, `requestConversationMigrationToActiveAccount` `:1201` synchronous; change C2 |
| P2 | Outage / synchronization hold (no client, session read failed, no session) | `holdDuringRuntimeSynchronization` `:462`, reservation `:583` | holds: `noteHeldWait` `:633` right after the reservation (round 5) | migration drain owns it (P9) | hold off-loop; `requestConversationMigrationToActiveAccount` `:578` synchronous; change C2 |
| P3 | Reclaimed host | `recoverReclaimedMessage` `:793` | holds at reservation; recovery failure noted `:846` | migration drain (P9) | `terminalizeHeldDelivery` `:836` `:861` synchronous; change C2 |
| P4 | Dead-host recovery inside P1 | `recoveryRequired` branch, reservation `:1373` | **gap**: no record while `recover` runs; a recovery that throws returns `held` with no record (`:1409`–`:1417`); change A1 | migration drain (P9) | `terminalizeHeldDelivery` `:1399` `:1423` `:1458` synchronous; change C2 |
| P5 | Account-switch hold (held state, successor awaiting its host, forced switch) | `:1486`–`:1529` | holds at reservation (`switching-accounts` / `switch-after-turn` / `awaiting-host`); a switch that fails later is never re-derived; change A4 | migration drain (P9) | see P1 |
| P6 | Deferred claim (lock refused, or claim refused while an earlier admission waits) | `:1575`–`:1590` | holds (round 5) | migration drain (P9) | `requeueHeldDelivery` `:1578` synchronous; change C2 |
| P7 | Lost admission acknowledgement (command threw after the claim) | `:1636`–`:1647` | **gap (R6-1)**: no record at all; change A1 | the reservation is `delivery-uncertain`: migration reconcile (P9), queue if the journal holds it (P8) | — |
| P8 | Runtime-journal delivery queue | `StructuredDeliveryQueue.drainPass` `structuredDeliveryQueue.ts:904` | holds: `noteWait` on every phase, `checking` steps, `noteUnlisted` `:1076` on a failed listing (round 4) | holds: lanes, `passBudgetMs` race `:1030`, `releaseSettledLanes` `:1136`, detached repairs `:2359` | holds: transition, bind-generation off-loop; `holdForFailedSwitch` controller `:864` synchronous; change C3 |
| P9 | Account-migration coordinator held drain (Viewer fast controller and the inventory sidecar) | `reconcileMigrations` `coordinator.ts:1175` → `drainHeldDeliveries` `:1122` → `deliverHeldStructuredMessage` `structuredMessageDelivery.ts:927` | partial: `heldDrainProgress` `:889` writes drain attempts in the Viewer; a reconcile writes nothing, even when the runtime cannot be read; change A1, A5 | **gap (R6-2)**: `forEachCooperatively` `coordinator.ts:1212` awaits each conversation, and `:1143`–`:1151` awaits the delivery inside it; change B1 | **gap (R6-3)**: `beginDeliveryAttempt` `:1144`, `recordDeliveryOutcome` `:1136` `:1162` `:1166` `:1168`, `requeueUnactuatedDelivery` `:1163`, `terminalizeHeldDelivery` `:1243`, `terminalizeRolledBackMigrationDelivery` `:1259` synchronous; change C1 |
| P10 | Watchdog | `queue.tick` `structuredDeliveryQueue.ts:1288` every 1 s; `unlistedWakeDue` controller `:839` | holds for listed sends; for pre-journal sends it writes `wake-lost` while the drain's lane may still be working, and never re-derives a failed switch; change A4 | holds: marking synchronous, reconciliation detached | — |
| P11 | Background settlement | `settleDueSends` `sendSettlement.ts:644` every 15 s, `mirrorSettledReceipts` `:783` | holds when a record exists; `deadline`/`settle` ignore a missing record (`deliveryProgress.ts:233` `:240`); change A3 | holds: per conversation with `running` | holds: `settleProjection` off-loop |
| P12 | Late acknowledgement | `resolveSendReceipt` `:742` → `mirrorReceiptProgress` `:758`; sweep mirror | holds when the record exists (round 4); P7 had none to correct; A1 closes it | — | holds |
| P13 | Operator's unknown-fate retry (same operation re-armed) | `handleRuntimeRetry` `http.ts:791` | **gap**: the record is terminal `uncertain` and `note` ignores a terminal record (`deliveryProgress.ts:194`), so the re-armed send waits with an ended record and no stall can show; change A2 | actuation section | `retryUncertainDeliveryForOperation` `:819`, `beginDeliveryAttempt` `:833` synchronous; change C2 |
| P14 | Terminal retry (new attempt under the retry key) | `http.ts:931` `recordRetryAttempt` | **gap**: record only from the queue's first note, so a failed listing leaves none (the round-4 class); change A2 | — | `recordDeliveryRetryAttempt` synchronous; change C2 |
| P15 | Succession: executor rebind, Viewer release, startup projection, runtime-host restart | `bindStructuredDeliveryQueue`; `reconcileTerminalDeliveries` controller `:423` | holds for listed sends (successor continues the record); a record owed at a crash is lost (write-behind); change A3 | holds | `recordDeliveryOutcomesForOperations` `:435` synchronous; change C3 |
| P16 | Same-key resend of an accepted send | `preflightDeliveryReservation` replay inside `admitDurably` `:1317` | the replay continues the same record (same operation) | — | `retryUncertainDelivery` `:1483`; change C2 |
| P17 | Legacy pane admission | `lib/delivery.ts:826` | held legacy reservations get a record from A3 | its held reservations drain in P9 | Deferred |
| P18 | Native Codex queue entries | `NativeQueueExecutor`, controller `:766` | Deferred | per conversation already | Deferred |

Every other sender (the composer route, seat commands, pipeline stage
follow-ups, spawn first messages, startup interruption continuations, Telegram
replies, deputies) calls `enqueueStructuredMessage` and is P1–P7.

### Paths this design adds to the review findings

The rounds found P7, P9 (drain and writes), P2/P6 and the P8 listing. Reading
every path against the three rules found five more:

1. **P4** — a dead-host recovery that throws answers `held` with no record
   (`structuredMessageDelivery.ts:1409`–`:1417`), and none exists while the
   resume runs.
2. **P13** — an operator's unknown-fate retry re-arms the same operation in the
   journal while its record stays terminal; the stall mark (`stalled`, `:225`)
   and every queue note skip a terminal record.
3. **P14** — a terminal retry's new attempt has no record until the queue lists
   it.
4. **P10** — a held send whose drain is still inside `deliver` is called
   `wake-lost` after 62 s (60 s wake plus 2 s grace), the round-1 class on the
   drain side; and a send held behind a switch that later fails keeps
   `switching-accounts`.
5. **P1, P13, P15, P9** — the synchronous writes listed in the (c) column.

## Rule (a): one record from the reservation on

### A1. Open at the reservation, update at every step

Generalize `noteHeldWait` (`structuredMessageDelivery.ts:180`) into the one
writer the admission path and the drain use (`recordWait(progress, registry,
reservation, wait)`). It creates the record when missing (original key,
admission time, kind and deadline read off the reservation) or updates its
reason, and returns the record it wrote. `held` reservations keep their switch
reason. It is called in the synchronous step after every reservation write:
both `holdDeliveryOffLoop` sites (`:583`, `:1342`), the P4 recovery reservation
(`:1373`), and the P16 re-arm.

The live path (P1) then writes this sequence on the same record:

| Step | Reason, detail | Next wake |
|---|---|---|
| reservation `assigned`, live host | `checking`, "claiming the delivery record" | none: the request is acting |
| the conversation's actuation section is held | `conversation-busy`, "an earlier send on this conversation is being admitted" | none |
| claim refused for the lock | `checking`, "the writer claim waited past its lock deadline" (exists) | migration pass (60 s) |
| claim returned nothing (a switch took it, an earlier admission waits) | `conversation-busy` (exists) | migration pass |
| claimed, before `client.command` | `checking`, "admitting to the runtime journal" | none |
| answered `queued`/`pending` | `queued`, guarded by rule (a) step 4 | `retryMs` |
| answered `delivered` / `rejected` / `failed` / `uncertain` | settled from the receipt | — |
| command threw after the claim (P7) | `evidence-unreadable`, "the runtime journal did not acknowledge the admission: …", attempt counted; the queue is kicked | `retryMs` |
| P4 resume running | `recovering-host`, "the conversation's host is being resumed" | none |
| P4 resume threw | `awaiting-host`, the error | migration pass |
| reservation terminalized by the request (refused payload, unpublished resume) | settled `failed` with the reason | — |

A step with no next wake is an in-request wait. The watchdog never calls it a
lost wake (`tick` skips a record without `nextWakeAt`). The stall mark still
applies: `checking`, `evidence-unreadable` and `recovering-host` are active
phases (`ACTIVE_DELIVERY_PHASES`), marked after 4 s without progress, so
the visible stall line comes within the ten-second bound. Every step's own
wait is bounded: lock 5 s, socket call 3 s, the section by the earlier holder's
bounds.

`conversation-busy` needs one read, `conversationActuationBusy(id)`, exported
beside `tryConversationActuation` (it reads `tails.has(id)`).

The P7 kick matters: the request threw before its usual kick, so a journal that
did admit the command has nobody waking the queue for up to the 5 s safety
pass. With the kick, the queue lists it and continues the record within one
pass. When the journal never received it, the record keeps
`evidence-unreadable` and the drain reconciles it under its original key (P9,
A5).

### A2. Retries reopen or open the record

- **P13**: `DeliveryProgressStore.rearm(operationId, conversationId, note)`
  reopens a terminal record (terminal cleared, attempt + 1, phase and progress
  dated now, `stalledSince` cleared, `wakeLostAt` kept as evidence) and creates
  one when missing. Only the retry route calls it, in the step after
  `retryUncertainDeliveryForOperation` returns a live reservation, which the
  route reaches only once the journal's `retry` action claim has won
  (`http.ts:813`). The reopened record says `checking` for the claim and the
  journal's re-arm (`client.retryOperation`), then `queued` on its answer. A
  later refusal leaves the record open, and the sweep or the operator's next
  retry decides it. The deadline is re-read from the re-armed reservation.
- **P14**: after `recordRetryAttempt` succeeds, the route opens the replacement
  operation's record (`queued`, the retry key as original key, the attempt
  row's admission time).

### A3. The sweep re-opens a missing record

The settlement sweep timer (`structuredDeliveryController.ts:1902`) already
reads the registry snapshot every 15 s. Before it starts settlement, it walks
the open reservations (`held`, `assigned`, `delivery-uncertain`) and the open
retry-attempt rows, and opens the record of any that has none: reason from the
reservation (`held` → its switch reason through `recordWait`, `assigned` →
`checking`, `delivery-uncertain` → `evidence-unreadable`, a retry-attempt row →
`queued`), detail "recorded from the delivery record", dated from the admission
time so an active phase shows its stall at once. `held` is listed on purpose:
it is outside the settleable set (`sendSettlement.ts:535`), so `onDeadline`
never hears of it. This covers what A1 cannot: a record owed when the Viewer
died (the store writes 20 ms behind), a held legacy reservation (P17), and a
send claimed by the inventory sidecar, which owns no store. Its bound is the
sweep interval; A1 is the primary and gives the moment.

### A4. The watchdog asks the reservation before calling a wake lost

`unlistedWakeDue` (controller `:839`) handles overdue records the journal does
not list. For each one it now reads the reservation:

- the conversation has a running coordinator lane (B1): skip it; that lane's
  own phase stands and its stall shows (the queue already applies this rule to
  its own lanes in `noteLostWakes`, `structuredDeliveryQueue.ts:1176`);
- the reservation is `held`: write it through `recordWait`, which derives
  `switching-accounts`, `switch-after-turn` or `switch-failed` from the
  conversation's migration phase;
- otherwise: `wake-lost` and a migration tick, as today.

### A5. The drain records a reconcile that cannot read the runtime

`heldDrainProgress` skips every write while reconciling an uncertain row
(`structuredMessageDelivery.ts:899`), because the queue may own the record. A
reconcile whose runtime read fails (`heldOutcomeDuringRuntimeSynchronization`
returns `delivery-uncertain`) knows the queue cannot list the journal either,
so that outcome writes `evidence-unreadable` with its cause. The drain also
reports the waits it decides itself through an optional port method,
`HeldDeliveryPort.wait(delivery, reason, detail)`, implemented in
`deliveryPort.ts` with `recordWait`: a claim refused for the lock (`checking`),
a section held by another actuator (`conversation-busy`), a conversation
skipped because its lane is still running (`conversation-busy`).

## Rule (b): the coordinator drains per conversation

### What already satisfies (b)

- Delivery queue: one lane per conversation, the pass races
  `passBudgetMs` (5 s), a lane that outlives it keeps its conversation, its end
  runs another pass, a lane whose operation settled elsewhere is released.
- Watchdog: marking is synchronous; evidence reads are detached and bounded by
  `reconcileReadMs`; the safety pass is the bounded queue pass.
- Settlement: due sends start per conversation, `running` stops a second sweep
  from settling the same conversation, reads bounded by 10 s.
- Terminal projection repairs and native-queue reconciliation are detached per
  operation and per conversation.

### B1. Lanes in `reconcileMigrations`

The per-conversation callback of the loop at `coordinator.ts:1212` becomes a
lane, started and not awaited:

1. The loop keeps today's synchronous snapshot filters (pending, uncertain,
   parked, active migration). A conversation whose lane is running is skipped,
   marked for a rerun, and its pending deliveries get `conversation-busy`
   through `HeldDeliveryPort.wait`.
2. The lane runs today's body for that conversation in today's order:
   successor cleanups owed for it (moved here from the sequential loop at
   `:1184`, which ran before every drain), uncertain reconciliation, orphan and
   rollback cancellations, advancement, post-commit drain, parked-switch drain.
3. `advanceConversationMigration` runs inside one process-wide serial section,
   so advancements stay one at a time as today. A conversation waiting for that
   section holds only its own lane; its sends are held behind its own switch.
4. After the loop the pass waits for its lanes until
   `HELD_DRAIN_PASS_BUDGET_MS` (5 s, beside `ACCOUNT_MIGRATION_PASS_INTERVAL_MS`
   in `controllerSignal.ts`; `options.passBudgetMs` for tests), then runs the
   board repair and intent completion on what has finished.
5. A lane that outlived its pass, or was marked for a rerun, calls
   `requestAccountMigrationTick()` when it ends. The sidecar has no tick
   registered and keeps its 60 s poll.
6. Lanes live on `process` (the same reason as the actuation sections: Next
   evaluates instrumentation and routes in separate bundle realms), and
   `heldDrainBusy(conversationId)` reads them for A4.

`drainHeldDeliveries` keeps its signature and its per-item order. Each item is
still claimed and delivered inside `tryConversationActuation`, so a claim and
its journal admission stay ordered within the conversation (#1709), and a
section held by an HTTP send is left for the tick its release requests.

Ownership across processes is unchanged: lanes and sections are per process;
the registry claim (`assigned` → `delivery-uncertain`) decides which process
actuates a reservation, and the journal's operation id decides that the host
gets it once.

The controller's `running` promise now waits at most one pass budget plus the
cycle's other bounded steps (quota probes have their own timeout), so a tick
requested for conversation B is served while A's lane is still held.

## Rule (c): every delivery write off the loop

### C0. One generic write

`AgentRegistry.whenWriterHeld` (`registry.ts:5192`) becomes public as
`deliveryWrite(correlation, write)`. Its contract is the existing one: `write`
makes exactly one registry mutation and reads no snapshot first. Every method
below goes straight to `this.mutate` (checked for each one).
`requestConversationMigrationToActiveAccount` reads the account-project
bindings file before its mutation, which is outside the registry database and
allowed. The existing named wrappers (`holdDeliveryOffLoop`,
`beginDeliveryAttemptOffLoop`, `recordDeliveryOutcomeOffLoop`, …) stay.

### Every write, its label and its refusal

| Site | Write | Label | A refused acquisition |
|---|---|---|---|
| C1 `coordinator.ts:1144` | `beginDeliveryAttempt` | `delivery.claim` | nothing claimed; reservation stays `assigned`; `checking` noted; next pass |
| C1 `:1136` | request-local `failed` | `delivery.settle` | stays; next pass (request-local payloads are never actuated by the drain) |
| C1 `:1162` `:1166` `:1168` | `recordDeliveryOutcome` | `delivery.settle` | stays `delivery-uncertain`; the next pass reconciles under the original key; the journal replays the same operation |
| C1 `:1163` | `requeueUnactuatedDelivery` | `delivery.requeue` | stays claimed (`delivery-uncertain`) and is reconciled under its original key; see note 1 |
| C1 `:1243` | orphan `terminalizeHeldDelivery` | `delivery.cancel` | stays; **the lane ends without draining that conversation this pass**, so an ownerless reservation is never delivered |
| C1 `:1259` | `terminalizeRolledBackMigrationDelivery` | `delivery.cancel` | same: no drain this pass |
| C2 `structuredMessageDelivery.ts:578` `:1201` | `requestConversationMigrationToActiveAccount` | `migration.reseat-request` | before any reservation: refused as `REGISTRY_WRITER_BUSY` with `admission: "refused"`, exactly as a refused hold is today |
| C2 `:1483` | `retryUncertainDelivery` | `delivery.rearm` | stays `delivery-uncertain`; answered with `uncertainReservationFailure` (the existing answer for an uncertain reservation) |
| C2 `:1578` | `requeueHeldDelivery` | `delivery.requeue` | stays as it was (`assigned`, unclaimed); answered `held`; `checking` noted |
| C2 `:1596` `:1610` | `recordDeliveryOutcome` | `delivery.settle` | stays `delivery-uncertain`; the answer and the record follow the journal's receipt; the drain's reconcile or the sweep projects it |
| C2 `:836` `:861` `:1399` `:1423` `:1458` | `terminalizeHeldDelivery` | `delivery.terminalize` | answered `held` (accepted) and recorded with the refused write named; the drain ends it (capability check, the unactuated bound, or a resume that now works); see note 2 |
| C2 `:1490` | held injection `terminalizeHeldDelivery` | `delivery.terminalize` | answered with the existing 409; the drain fails a held injection itself (new guard, note 2) |
| C2 `http.ts:819` | `retryUncertainDeliveryForOperation` | `delivery.rearm` | nothing re-armed; 503 `retryable` (the route's existing ownership answer) |
| C2 `http.ts:833` | `beginDeliveryAttempt` | `delivery.claim` | the route's existing 503 `retryable` for a claim that did not happen; the journal has not re-armed the operation yet, and the operator's next retry repeats both under the same operation |
| C2 `http.ts:88` | `recordDeliveryRetryAttempt` | `delivery.retry-attempt` | the existing `retryRecordUnavailable` answer; the attempt converges on the same leaf when retried |
| C3 controller `:864` | `holdForFailedSwitch` | `delivery.switch-hold` | the lane throws; the effect is still listed; next pass |
| C3 controller `:435` | startup `recordDeliveryOutcomesForOperations` (one batch) | `delivery.startup-settle`, first operation id | outcomes stay owed; acknowledgement to the journal is sent only after a durable write, so its retention keeps them; the drain's reconcile and the sweep project them |

Note 1: leaving a never-dispatched send claimed (a refused requeue at `:1163`,
or a refused `lost` failure at `:1162`) changes how it can end. With the host
back, the reconcile admits it and it is delivered once. With the host
still unreachable at its deadline, it ends `unverified` (resend behind
verification) where a requeue would have ended it `lost`. That answer is
conservative and needs a refused lock and an outage together.

Note 2: today these sites answer `failed` after a synchronous terminalize. An
answer of `failed` over a reservation that is still live would invite a resend
under a new key while the drain may still deliver the first, so a refused
terminalize answers `held`. The drain ends every such reservation: a payload the
host cannot take fails at its capability check (`structuredMessageDelivery.ts:1018`);
a host that stays unrecoverable fails at the unactuated bound (`unactuatedFailure`);
a held injection is failed by a new guard in `deliverHeldAttempt` with the
#1560 reason, so it is never replayed into the successor's thread.

## At most one host input

| Scenario | The fence that decides it (unchanged) |
|---|---|
| Two actuators claim one reservation (two passes, Viewer and sidecar, HTTP and drain) | registry claim `assigned` → `delivery-uncertain`, one winner |
| A resend, a reconcile or a lost-ack retry commands the same operation | journal admission is idempotent per operation id and key; a replay adds no effect |
| Two executors read the same operation as `queued` (succession, rebind) | `delivering` written only from `pending`/`queued` (`fromStatuses`); a retired lane acts on nothing |
| A send settled while unreachable | `settled` fence read before actuation; settlement fences the journal first |
| Late evidence or a late acknowledgement | settles the same operation; never writes input |
| Operator's unknown-fate retry | journal `claimDeliveryAction("retry")` must win; same operation re-armed, never automatically |
| Terminal retry | a new operation with its own key, only on a terminal `failed`/`rejected` original |

What this design adds touches none of them: records are observational, lanes
add scheduling within the existing sections and claims, and an off-loop write
commits the same mutation in the same transaction it waited for.

## Findings map

| Round | Finding | Path | Rule | At `dc8769080` | This design |
|---|---|---|---|---|---|
| 4 | P1 accepted send unexplained when the effect listing fails | P8, P1 | (a) | fixed: `noteAdmitted` after the journal acknowledgement, `noteUnlisted` | A1 opens it at the reservation; A3 backstop |
| 4 | P1 writer-lock wait on the shared loop at admission, no correlation | P1, P2 | (c) | fixed for hold and claim | C2 covers the remaining P1/P2 writes |
| 4 | P2 late acknowledgement leaves progress `uncertain` | P12 | (a) | fixed: `settle` promotion, `mirrorSettledReceipts` | kept |
| 5 | P1 outage / deferred-claim admission without a record | P2, P6 | (a) | fixed: `noteHeldWait` | folded into A1's single writer |
| 6 | P1 lost admission acknowledgement has no record | P7 | (a) | **open** | A1 |
| 6 | P1 held-send recovery serializes conversations | P9, P10 | (b) | **open** | B1, A4 |
| 6 | P2 held-delivery writes take the synchronous lock | P9 | (c) | **open** | C1 |

Earlier rounds, all fixed at this head and kept: round 1 (async probe followed
by a synchronous write → `withWriter`; one stalled conversation stopped the
watchdog → detached reconciliation; the stall hidden behind interaction → the
resting stall line; a read/write wait recorded as a lost wake → `checking`
steps); round 2 (an injection repeated after executor change →
`fromStatuses`; settlement on the synchronous lock → off-loop `settleProjection`;
one conversation stopped every settlement → per-conversation sweep; a hung steer
observation called a lost wake → `activeSteers`); round 3 (a hung terminal
repair blocked the pass → detached repairs; an unbounded interrupt evidence
read → `reconcileReadMs`; waits outliving a lane never stalled → stall marked
from the record).

## Test map

### Tests added on this branch

`structuredDeliveryQueue.progress.test.ts`:

| Test | Path | Rule |
|---|---|---|
| every wait reason has a sentence in both interface languages | vocabulary | (a) |
| a hanging target holds only its own conversation … never repeated | P8 | (b), once |
| a lost admission wake is replaced by the watchdog … | P10 | (a) |
| an overdue wake of a send the journal does not hold yet goes to the drain that holds it … | P10 → P9 | (a), (b) |
| a lost turn-end wake costs one safety interval … | P10, P8 | (b) |
| a lock delay on one conversation's delivery write leaves the other's pass alone … | P8 | (b), (c) |
| a late acknowledgement after the background deadline fenced the send is refused … | P12, P11 | once |
| a lost acknowledgement of the delivered transition never brings the send back | P8 | once |
| across executor succession the original operation reaches the host at most once | P15 | once |
| a crash at the transport and confirmation boundary leaves one input … | P15, P11 | once |
| an interrupt-active send whose interrupt makes no progress for thirty seconds reconciles … | P8 | (a), (b) |
| a lane whose host call does not answer is reconciled from host evidence and then let go | P8 | (b) |
| an operation that ended where this executor did not see it closes its open record … | P8, P11 | (a) |
| two executors that both read the operation as queued hand it over once | P15 | once |
| an evidence read that never answers holds nobody else … | P10 | (b) |
| evidence that answers after its bound still settles … | P12 | once |
| a `${step}` step that does not answer is recorded as the step it is … | P8 | (a) |
| a delivery write refused for a busy record lock defers the message … | P8 | (c) |
| a steer whose observation never answers shows a truthful stall … | P8 | (a), once |
| an injection whose first executor is replaced while its host read hangs … | P15 | once |
| two live executors that both read an injection as queued insert it once | P15 | once |
| a lost terminal acknowledgement whose repair hangs holds no other conversation's delivery … | P8 | (b) |
| an interrupt reconciliation whose evidence read never answers lets its lane go … | P8 | (b), once |
| an acknowledged interrupt whose turn keeps running shows a truthful stall … | P8 | (a) |
| an inherited delivering fence shows a truthful stall under the successor … | P15 | (a), once |

`sendSettlement.test.ts`: "with no reader asking, the background deadline ends
a dropped send …" (P11, once); "background settlement waits out another
process's long write off the event loop …" (P11, (c)); "a settlement whose write
lock stays held past its deadline writes nothing …" (P11, (c) refusal); "a
conversation whose journal read never answers holds nobody …" (P11, (b)); "the
background deadline ends a send an executor took as unverified …" (P11, once);
"a late canonical acknowledgement corrects the progress record that ended
uncertain …" (P12, (a)).

`structuredDelivery.integration.test.ts`: "with nobody draining, the bound
controller's watchdog delivers an admitted send once …" (P1, P10; (a), (b));
"an accepted send whose queue cannot list the journal records why it waits …"
(P8, round 4; (a)); "a send held because the runtime socket is missing records
why it waits from admission …" (P2, round 5; (a)); "a send held through a
runtime outage is ended by the background settlement …" (P2, P11, round 5;
(a)); "a send ended by the delivery record alone closes its progress record …"
(P11; (a)); "a send whose writer claim waits past its lock deadline records
that wait …" (P6, round 5; (a), (c)).

`structuredMessageDelivery.sqlite.test.ts`: "a send admitted while another
process holds the registry write lock waits off the event loop …" (P1, round 4;
(c)). `registry.writerWait.test.ts` (6 tests): the off-loop write itself, its
refusal, the synchronous wait measured ((c) mechanism).
`deliveryProgress.test.ts` (3 tests): records survive restart, terminal
retention, a busy file never blocks ((a) store). `journalSnapshotTiming.test.ts`:
snapshot timing diagnostics (incident evidence; none of the three rules).
`messageRow.test.ts` (2), `deliveryWait.dom.test.tsx`,
`OutboxBubbles.delivery.dom.test.tsx`, and the browser case "a stalled hand-over
says so on its message": the record shown at rest, both languages ((a),
visible).

### Existing delivery test files

| File (tests) | Path | Rule or fence it decides |
|---|---|---|
| `structuredDeliveryQueue.test.ts` (77) | P8 | ordering, turn waits, interrupts, `delivering` fence; once |
| `structuredDeliveryQueue.inject.test.ts` (10) | P8 inject | once |
| `structuredDeliveryQueue.recoveryContention.test.ts` (8) | P8 host recovery | (a) `recovery-contended` |
| `structuredDeliveryQueue.copilot.test.ts` (9) | P8, Copilot host | once |
| `structuredDelivery.integration.test.ts` (43 earlier) | P1, P8, P9, P15 end to end | once (crash boundary, executor kill) |
| `structuredMessageDelivery.test.ts` (78) | P1–P7 admission contracts | refusal before reservation; holds; recovery |
| `structuredMessageDelivery.keyed.test.ts` (1) | P16 | same-key replay |
| `structuredMessageDelivery.placement.test.ts` (3) | P1 | reservation placement |
| `structuredMessageDelivery.accountReseat.test.ts` (26) | P5 | switch hold, forced switch |
| `structuredDeliveryController.test.ts` (4), `.migration.test.ts` (7) | P15, P5 | bind, switch hand-off |
| `structuredDeliveryController.nativeSwitch.test.ts` (14) | P18 | native queue across a switch |
| `structuredDeliveryRebind.test.ts` (14) | P15 | rebind, realms, startup drain |
| `structuredSwitchCancelQueue.test.ts` (2) | P5 | cancelled switch releases the send |
| `structuredDeliveryLegacyVerdict.integration.test.ts` (1) | P17 | legacy verdict |
| `structuredDeliverySignal.test.ts` (1) | P8 | kick signal |
| `structuredCompactDelivery.test.ts` (17) | compaction controls | none: controls carry no reservation |
| `codexSteerDelivery.integration.test.ts` (1, real binary) | P8 steer | once |
| `sendSettlement.test.ts` (45 earlier) | P11–P14 | receipts, deadlines, retry rows |
| `http.test.ts` (33) | P13, P14, discard | retry authority; once |
| `http.refusedDelivery.test.ts` (5) | before acceptance | none: nothing reserved |
| `deliveryDedup.test.ts` (2) | host dedup token | once |
| `hostlessSessionSettlement.test.ts` (12) | dead-host turn closing | none: no send |
| `accounts/migration/coordinator.test.ts` (103, about 22 on deliveries) | P9, P5 | claim once, cancellation, rollback, #1709 order; (b) after B1 |
| `coordinatorDeadTurn` (2), `coordinatorNeverStarted` (4), `coordinatorTurnAuthority` (12) | P5 | advancement and held input |
| `accounts/migration/controller.test.ts` (10), `controllerSignal.test.ts` (2), `controller.performance.test.ts` | P9 controller | tick coalescing, pass cost |
| `deliveryActuation.test.ts` (6) | P1, P9 | per-conversation actuation ownership |
| `delivery.test.ts` (50), `deliveryInterrupt.test.ts` (5) | P17, interrupt control | legacy; none |
| `runtime-host/journal*.test.ts` | P8, P13, P14 | operation-id dedup, `fromStatuses`, retry, retention |
| `nativeCodexQueue*`, `nativeQueue*` | P18 | native queue |

## What stays

The record store and its write-behind file; the wait vocabulary (no new
reason); the queue's lanes, pass budget, watchdog, `checking` steps and
record-based stall marks; per-conversation settlement and its off-loop
`settleProjection`; the late-acknowledgement promotion and mirror; `withWriter`
and the existing named off-loop methods; actuation sections; every
at-most-once fence; the rendered stall line and its strings.

## What changes

| File | Change |
|---|---|
| `src/lib/agent/registry.ts` | `whenWriterHeld` public as `deliveryWrite` (C0) |
| `src/lib/deliveryActuation.ts` | `conversationActuationBusy(id)` read (A1) |
| `src/lib/runtime/deliveryProgress.ts` | `rearm` (A2) |
| `src/lib/runtime/structuredMessageDelivery.ts` | `recordWait` at every reservation write and the P1/P4/P7 steps (A1); reconcile-unreadable note (A5); held-injection guard in the drain; C2 writes |
| `src/lib/accounts/migration/coordinator.ts` | lanes, pass budget, serial advancement, cleanups per lane, cancellation-refused-no-drain, `HeldDeliveryPort.wait`, `heldDrainBusy` (B1, A5); C1 writes |
| `src/lib/accounts/migration/controllerSignal.ts` | `HELD_DRAIN_PASS_BUDGET_MS` |
| `src/lib/accounts/migration/deliveryPort.ts` | `wait` through `recordWait` |
| `src/lib/runtime/structuredDeliveryController.ts` | `unlistedWakeDue` asks the reservation (A4); sweep opens a missing record (A3); C3 writes. Edits stay in these four functions; lane bc8e99e8 edits host registration and publication |
| `src/lib/runtime/http.ts` | retry route `rearm`/open (A2); C2 writes |

Registry read paths (lane c64e30e9) are untouched; `runtime-host/journal.ts` is
untouched.

## Build plan

Each step lands with its test written first and seen red at `dc8769080`, in the
real seam (real `AgentRegistry`, real `RuntimeJournal`, the bound controller
where the path runs through it). Order is chosen so each step is reviewable on
its own.

1. **C0 + C1 + B1 (round-6 P1 #2 and P2).**
   - `coordinator.test.ts`: "a held drain that never answers on one
     conversation leaves another's delivered within the pass budget, a later
     pass serves that conversation again, and the late answer adds no input".
     Two idle structured conversations in one registry, an assigned send each,
     `reconcileMigrations` with A's `deliver` held open. Red: B is never
     entered while A waits.
   - Same file: "advancements of two switching conversations never overlap
     while a third conversation's assigned send is delivered" (max concurrent
     `advance` = 1).
   - Same file: "an orphan cancellation the lock refused leaves its
     conversation undrained for that pass".
   - New `src/lib/accounts/migration/coordinator.writerWait.test.ts` (the
     child-process lock holder from `registry.writerWait.test.ts`): "a held
     drain claims and settles with the lock waited off the loop, correlated
     with the original operation, and delivers once". A separate process holds
     `BEGIN IMMEDIATE` 600 ms; 5 ms heartbeat. Red: 613 ms gap, synchronous
     anonymous sample. Plus "a claim refused for the lock leaves the
     reservation assigned with its reason, and the next pass delivers it once".
2. **A1 (round-6 P1 #1) and P4.**
   - `structuredDelivery.integration.test.ts`: "a lost admission
     acknowledgement keeps the original-key record from the reservation: its
     wait at once, its stall within ten seconds with the journal unavailable,
     its ending from the sweep, its correction from a late acknowledgement, one
     input". `idleHostedConversation`, real journal, `client.command` runs
     `journal.executeOperation` then throws `RuntimeHostUnavailableError`. Red:
     `progress.get(operationId)` is null, and still null after
     `settleDueSends` at +11 min.
   - Same file: "a send behind an earlier admission on its conversation records
     conversation-busy then queued, and a journal admission that does not
     answer is a checking step that stalls and is never a lost wake".
   - `structuredMessageDelivery.test.ts`: "a dead-host resume that throws
     leaves the accepted send recorded as awaiting-host with its deadline". Red:
     no record.
   - C2 writes in this file; `structuredMessageDelivery.sqlite.test.ts`: "a
     rejected admission's settle and a refused requeue wait off the loop and
     leave the reservation for a later pass".
3. **A2 (P13, P14).** `sendSettlement.test.ts`, on its retry-uncertain
   fixture: "an unknown-fate retry reopens the operation's ended record, counts
   the attempt, and reaches the host once" (red: the record stays terminal
   while the journal holds the operation queued); "a terminal retry's attempt
   is recorded from the moment its row is written, with a failing listing"
   (red: no record). C2 writes in `http.ts`.
4. **A3, A4, A5, C3.** `structuredDelivery.integration.test.ts`: "a held send
   whose drain lane is still inside its delivery is never called a lost wake
   and shows its stall" (red: `wake-lost` after 62 s); "a send held behind a
   switch that fails says switch-failed at its next overdue wake" (red: keeps
   `switching-accounts`); "a reservation whose record was owed at a crash gets
   it back from the next sweep, dated from its admission" (red: no record).
   `structuredDeliveryRebind.test.ts`: "startup projection waits for the lock
   off the loop and leaves refused outcomes owed to the journal".
5. **Rendered evidence.** In `conversationWindow.browser.test.tsx`, the
   existing case "a stalled hand-over says so on its message" takes the reason
   as a parameter and adds `evidence-unreadable` (what P7 shows) beside
   `dispatching`, at 390 and 1440, en and uk. No new driver.

Gates for the build: touched tests by path, one file per process, with a
private `HOME`, `TMPDIR` and `LLV_STATE_DIR` under the OS temp root and
`LLV_VIEWER_CONTROL_URL` on a closed port; never a sweep of `src/lib/agent` or
`src/app/api/runtime`. `tsc`, changed-file `eslint`, the conversation browser
case above, the local privacy gate from the merge base. Merge `origin/main`
before the push. `coordinator.test.ts` and `controller.performance.test.ts`
run in full because B1 changes when a pass returns.

## Options considered

**(a)** *Per-site recording*, today's approach: each review found the next
site, so it is the cause of six rounds. *A registry observer* that opens the
record inside `holdDelivery`: one place, but it couples the registry to a store
only the Viewer owns, and it fires in every process that writes the registry.
*Chosen*: one writer called at the reservation writes in the admission module,
plus the sweep backstop over the durable list that already exists.
*Write-through records* (a synchronous store write at admission): would close
the 20 ms crash window and put a SQLite wait back on the admission path, the
thing (c) removes; the backstop closes the window within 15 s.

**(b)** *Lanes for the drain calls only*, advancement left in the loop: an
uncertain reconcile has to finish before its conversation advances, so the loop
would have to await it again, or skip advancement while it runs, and a row
that stays uncertain would then starve its switch. *Fully concurrent lanes*:
an engine-wide switch would start every successor at once, a memory risk on
a host that has already had out-of-memory stops. *Chosen*: whole
conversation step in a lane, advancement serialized, deliveries independent.

**(c)** *Named `…OffLoop` wrapper per method*: about ten more wrappers for one
pattern. *Registry writes on a worker thread*: removes the wait from the loop
for every caller, at the cost of a second registry connection model; heavier
than the problem. *Chosen*: the existing acquisition, public, called with the
method.

No ADR: every choice here is reversible within the module that owns it.

## Validation against the requirement

"Original-key delivery delays traced": every accepted send has its original-key
record from the reservation on, with a reason from one vocabulary at each step,
on every path except the deferred native queue (P18); held legacy reservations
and sends claimed by the sidecar get theirs from the backstop. "Bounded visible recovery": each drain gives a conversation at most
its pass budget before the next conversation is served, every wait is bounded
by its own deadline, a stall shows on the resting message within ten seconds,
and the settlement deadline ends what nothing else ended. "Without duplicate
sends": the three fences are untouched, and every refused write leaves its
reservation where those fences still apply. The board task's own goal ("з'ясовано,
чому затримувалась доставка") is answered by the record plus the correlated
lock waits; the CPU-isolation and orphan-process parts of 7a677014 belong to
lanes b49993f7 and b3a827ad.

## Deferred — not currently justified

- **Concurrent migration advancement.** Advancement stays one at a time. A
  send held behind its own switch says so; nothing in the incident waited on
  another conversation's advancement. Revisit if a record shows
  `switching-accounts` stalled behind an unrelated switch.
- **Reserving before a forced switch** (`structuredMessageDelivery.ts:1246`–`:1279`).
  An idle-host send forces a pending switch before it reserves, so that wait is
  pre-acceptance and the composer shows `transmitting`. Moving the reservation
  first would change the #1028 ordering contract. Revisit if a receipt shows
  admission waiting on a forced switch.
- **Native Codex queue entries (P18) in the progress record**, and their
  synchronous settle write (controller `:767`). The operator watches their
  position in Codex's own queue; the executor's `settled` callback is
  synchronous by contract.
- **Legacy pane admission (P17) writes.** The pane send is actuated inside the
  request; its held reservations drain through B1 and get a record from A3.
- **Migration-state writes** (advance, commit, rollback, successor cleanup
  bookkeeping) and `compactDeliveryReservations`. They are not delivery writes
  for an accepted send; making them off-loop is a coordinator-wide change.
- **Progress records written by the inventory sidecar.** It owns no store; A3
  and the queue record what it drains.
- **Pre-acceptance waits** (the account mutation lock and the image admission
  lock in `admitDurably`): nothing is accepted yet, so the three rules do not
  apply; the composer's own row covers them.

## Notes

- B1 changes when `reconcileMigrations` returns: a test that awaits it and then
  asserts on a delivery that takes longer than the pass budget would need to
  wait for the lane. Tests with immediate ports are unaffected.
- `evidence-unreadable`'s comment in `deliveryWaitReason.ts` says "nothing was
  sent". For P7 that holds for the agent: the journal may hold the operation,
  and the queue's next note replaces the reason as soon as it lists it.
- A record an in-request step left without a next wake (the Viewer died
  mid-request) keeps its stall mark and its deadline; the restarted Viewer's
  first migration pass drains the reservation and writes the record again.
- The inventory sidecar drains held deliveries every 60 s in its own process,
  with its own actuation sections. The registry claim keeps it and the Viewer
  from actuating one reservation twice. That is existing behavior; the design
  relies on it and does not change it.
