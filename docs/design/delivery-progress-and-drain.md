# Delivery: one rule for every accepted send

Status: design, 2026-10-07, revised the same day for the critique round that
handed eight findings (three P1, five P2). Branch
`pipeline/delivery-records-why-it-waits-drains-per-e2f1d249` (PR #2572), product
code at `dc8769080`. Every `file:line` below is at that commit.

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
the next one. Six rounds left three open defects at `dc8769080`. The first
revision of this design found five more, and its critique found eight places
where the design itself still exempted a path or broke one of its own rules.
This revision closes the class with one mechanism per rule and applies it to
every path in the table below, the native and legacy transports and the startup
continuations included:

- **(a)** One function opens the original-key record at every reservation
  write, before any command that could accept the send leaves the process, and
  every later step updates that record. A writer that did not act on an
  operation never touches its record's phase. The background settlement sweep,
  which already reads the registry every 15 s, re-opens a missing open record
  and restores a missing ending that a crash or another process left behind.
  The watchdog keeps marking stalls while startup is still seating hosts.
- **(b)** The account-migration coordinator gets the delivery queue's lane
  model: one lane per conversation, a bounded pass. Migration advancement keeps
  a single permit, and the permit is leased: a holder that does not finish
  within the pass budget lets the next conversation start. Startup
  continuations are admitted per conversation, all at once.
- **(c)** One generic off-loop registry write (`deliveryWrite`, the existing
  `whenWriterHeld` made public) replaces every synchronous write that creates,
  claims, re-arms, requeues, binds or settles a delivery on these paths, in the
  Viewer and in the inventory sidecar. Each site has a stated refusal that
  leaves its reservation for a later pass, and a refused ending never lets a
  drain deliver what admission had rejected.

The fences that make a host input happen at most once (journal operation-id
dedup, the `delivering` and native `prepared` transitions from
`pending`/`queued` only, the registry claim, the migration revision) are
unchanged. No new wait reason. No UI change.

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
- **Active phase**: a reason in `ACTIVE_DELIVERY_PHASES`
  (`deliveryWaitReason.ts:66`): `queued`, `evidence-unreadable`, `checking`,
  `dispatching`, `interrupting`, `interrupt-reconciling`, `recovering-host`.
  The watchdog marks one that made no progress for 4 s as stalled. Every other
  reason is passive.
- **Acting operation**: the operation a conversation's actuation section
  holder or drain lane is working on now. Its writer is that holder or lane.
- **Observer**: a writer that did not act on an operation: a pass that finds a
  conversation's lane running, a drain refused the section, the watchdog.
- **Lane**: one conversation's in-flight drain work. It holds that conversation
  until it ends; a pass skips a conversation whose lane is running.
- **Pass**: one run of a drain over all conversations. It waits for its lanes
  only up to a budget, then ends; lanes still running request the next pass
  when they end.
- **Advancement permit**: the single, leased right to run
  `advanceConversationMigration` from a coordinator lane (B1).
- **Off-loop write**: a registry mutation whose write lock is waited for with
  `SqliteAgentRegistryStore.withWriter` (`src/lib/agent/sqliteRegistryStore.ts:1089`):
  non-blocking `BEGIN IMMEDIATE` probes every 5 ms, a 5 s deadline, the lock kept
  through the one mutation's commit, `{ acquired: false }` when refused.

## The three rules, stated so a test can decide them

**(a) Recorded wait.** For every accepted send, a record keyed by its original
operation exists in the Viewer's store from the synchronous step after the
reservation write returns, and in every case before a command that could make
the runtime journal accept it leaves the process. It carries the original key,
admission time, kind, settlement deadline and a reason from
`DELIVERY_WAIT_REASONS` (`src/lib/runtime/deliveryWaitReason.ts`). Every later
step that changes what the send waits on updates that same record; nothing
creates a second one. A terminal record changes only by `uncertain → delivered`
on proof of arrival, or by an explicit operator retry that the journal re-armed
under the same operation. Writers take turns:

1. Until the runtime journal holds the operation, the admitting request (or
   startup, for its continuations) and the account-migration drain write it.
2. Once the journal lists it, the delivery queue writes it, with the native
   queue executor's answers for a native entry.
3. Settlement writes the ending; the sweep restores an ending the record
   missed.
4. A writer that may race the queue (any write after a command was sent) writes
   only while the record is still the object it wrote last.
5. An observer never writes the acting operation's record and never replaces
   an active phase. It writes `conversation-busy` only to that conversation's
   `assigned` reservations other than the acting one, whose record is missing
   or shows a passive reason. `held` keeps its switch reason;
   `delivery-uncertain` belongs to the reconcile or the queue. A repeated
   `conversation-busy` note keeps the reason, so it neither counts as progress
   nor clears a stall (`deliveryProgress.ts:194`–`:219` advance only on a
   reason change, an attempt or explicit progress).

**(b) Per-conversation drain.** Every drain that acts for more than one
conversation (the delivery queue, the background settlement, the
account-migration coordinator, startup's continuation admission) starts each
conversation's work independently, waits for it no longer than its pass budget
or its calls' own deadlines, and leaves a conversation whose work is still
running to that work. Work that several conversations share (successor
creation, under the advancement permit) holds any conversation for at most one
lease per conversation ahead of it. Inside one conversation, order is kept:
claims and journal admissions run in its actuation section
(`src/lib/deliveryActuation.ts`), one held delivery after another.

**(c) Off-loop writes.** Every registry write that creates, claims, re-arms,
requeues, binds or settles a delivery for an accepted send, made on these paths
by the Viewer or by the inventory sidecar, waits for the lock off its event loop
and carries `{ label, operationId }` into `blockingWaits`. A refused acquisition
writes nothing, and the site's stated refusal leaves the reservation in a state
a later pass acts on, under the same fences that applied before the refusal
(inventory in "Rule (c)").

**At most one host input per original operation.** Decided by the fences in
"At most one host input", which this design does not change.

## Every path

"holds" means the rule is met at `dc8769080`, "gap" marks where it is unmet,
and each change (A1–A7, B1–B2, C0–C4) is defined below. "—" means the rule has
nothing to decide on that path.

| # | Path | Entry | (a) recorded wait | (b) drain | (c) writes |
|---|---|---|---|---|---|
| P1 | Admission, live structured host (composer route, seat commands, pipeline follow-ups, spawn first messages, Telegram replies, deputies, startup obligations) | `enqueueStructuredMessage` `structuredMessageDelivery.ts:1058`; reservation `:1480`, claim `:1549`, command `:1555` | **gap**: first record only after the journal acknowledges (`noteAdmitted` `:1616`); A1 | actuation section per conversation | hold and claim off-loop; the rest synchronous; C2 |
| P2 | Outage / synchronization hold | `holdDuringRuntimeSynchronization` `:462`, reservation `:583` | holds (`noteHeldWait` `:633`, round 5) | coordinator owns it (P9) | `requestConversationMigrationToActiveAccount` `:578` synchronous; C2 |
| P3 | Reclaimed host | `recoverReclaimedMessage` `:793` | holds at reservation | coordinator (P9) | `terminalizeHeldDelivery` `:836` `:861` synchronous; C2 |
| P4 | Dead-host recovery inside P1 | reservation `:1373`, recovery `:1389` | **gap**: none while `recover` runs; a recovery that throws answers `held` with no record (`:1409`–`:1417`); A1 | coordinator (P9) | `terminalizeHeldDelivery` `:1399` `:1423` `:1458` synchronous; a refusal must never let the drain deliver what admission rejected; C2, Note 2 |
| P5 | Account-switch hold | `:1486`–`:1532` | holds at reservation; a switch that fails later is never re-derived; A4 | coordinator (P9) | `:1490` synchronous; C2 |
| P6 | Deferred claim | `:1576`–`:1590` | holds (round 5) | coordinator (P9) | `requeueHeldDelivery` `:1578` synchronous; C2 |
| P7 | Lost admission acknowledgement | `:1636`–`:1647` | **gap (R6-1)**: no record; A1 | queue (P8) when the journal holds it, else coordinator reconcile | — |
| P8 | Runtime-journal delivery queue | `StructuredDeliveryQueue.drainPass` `structuredDeliveryQueue.ts:904` | holds for sends (`noteWait`, `checking` steps, `noteUnlisted` `:1076`); native effects see P18 | holds: lanes, `passBudgetMs` race `:1030`, detached repairs | `holdForFailedSwitch` controller `:864`, reconfigure claim/settle `structuredReconfigure.ts:106` `:121` synchronous; C3 |
| P9 | Account-migration coordinator (Viewer fast controller and inventory sidecar): held drain, advancement, commit, rollback, intent completion | `reconcileMigrations` `coordinator.ts:1175` → `drainHeldDeliveries` `:1122` → `deliverHeldStructuredMessage` `structuredMessageDelivery.ts:927` | partial: `heldDrainProgress` writes drain attempts; a reconcile writes nothing even when the runtime cannot be read; A1, A5 | **gap (R6-2)**: `forEachCooperatively` `:1212` awaits each conversation and `:1143`–`:1151` the delivery inside it; advancement awaits `create` `:990`, `verify` `:1011`, `publishHost` `:1042`; B1 | **gap (R6-3)**: `:1136` `:1144` `:1162`–`:1168` `:1243` `:1259`, `commitSuccessor` `:1064` (`settleDeliveriesAtCommit`, `registry.ts:8733`, `:1458`–`:1488`), `rollbackConversationMigration` `:956` `:1288`, `setMigrationIntentState` `:1320`, compaction `controller.ts:45`; C1 |
| P10 | Watchdog | `queue.tick` `structuredDeliveryQueue.ts:1288` every 1 s; `unlistedWakeDue` controller `:839` | **gap**: paused for the whole controller while startup is pending (`:1889`); calls a held send `wake-lost` while its lane works; A4, A7 | holds: marking synchronous, reconciliation detached | — |
| P11 | Background settlement | `settleDueSends` `sendSettlement.ts:644`, `mirrorSettledReceipts` `:783` | holds when a record exists; a missing open record is ignored (`deliveryProgress.ts:233` `:240`), a missing ending is never restored (`:783`–`:795` iterate existing records only); A3 | holds: per conversation with `running` | holds: `settleProjection` off-loop |
| P12 | Late acknowledgement | `resolveSendReceipt` `:742` → `mirrorReceiptProgress` `:758`; sweep mirror | holds when the record exists (round 4); A1 and A3 make it exist | — | holds |
| P13 | Operator's unknown-fate retry (same operation re-armed) | `handleRuntimeRetry` `http.ts:791` | **gap**: the record stays terminal and `note` ignores a terminal record; A2 | actuation section | `:819` `:833` synchronous; C2 |
| P14 | Terminal retry (new attempt) | command `http.ts:894`–`:899`, row `:930`; a replayed leaf writes its row at `:864` | **gap**: the row and any record come after the retry command, so a lost reply leaves neither; A2 | — | `recordDeliveryRetryAttempt` `:88` synchronous; C2 |
| P15 | Succession: executor rebind, Viewer release, startup projection, runtime-host restart | `bindStructuredDeliveryQueue`; `reconcileTerminalDeliveries` controller `:423`; `startup.ts:1335` | holds for listed sends; a record owed at a crash is lost, open or ended; A3 | holds | `recordDeliveryOutcomesForOperations` controller `:435`, `drainDeadSupersededHeldDeliveries` `startup.ts:1335` synchronous; C3 |
| P16 | Same-key resend | `preflightDeliveryReservation` replay `:1317` | continues the same record | — | `retryUncertainDelivery` `:1483`; C2 |
| P17 | Legacy pane admission and legacy drain | `lib/delivery.ts:808`; hold `:826`, claim `:868`, actuation `:871`; drain `deliveryPort.ts:20` | **gap**: no record from the reservation; a pane actuation that hangs has none, and a sweep can miss a send that settles inside its interval; A1 | per conversation (actuation section `:808`) | `:826` `:858` `:865` `:868` `:882` `:885` `:954` `:955` `:982` `:1093` synchronous; C2 |
| P18 | Native Codex queue: an ordinary queue send on a capable Codex host | `runtime-host/journal.ts:576`–`:585` converts it to `runtime.native-queue`; queue `:1466`, `:1681`; `NativeQueueExecutor.execute` `nativeQueueExecutor.ts:34` | **gap**: the P1 record stays `queued` while the executor waits for a successor (`:53`, `:68`), an unreadable health (`:81`) or an unreadable status (queue `:1521`–`:1527`), with no note; A1, A6 | per conversation already | native `settled` → `recordDeliveryOutcomeForOperation` controller `:767` synchronous; C3 |
| P19 | Startup continuations: (a) the one an interruption obligation is owed (#1835); (b) the interrupted-Codex continuation and its one retry | (a) `deliverInterruptionContinuations` `startup.ts:491` → `enqueueStructuredMessage` `:509`; (b) `enqueueInterruptedCodexContinuations` `:655`: `client.retryOperation` `:675`, `client.command` `:687`; caller `:1656`–`:1667` | (a) as P1; (b) **gap**: journal only, no reservation, no owner row, no record, no deadline; A1, A2 | **gap**: both `for` loops await each admission (`:499`, `:663`); a throw in (b) stops the hosts after it; B2 | (b) none written; after A1 as P1; C2 |
| P20 | Operator discard | `handleRuntimeDiscard` `http.ts:580`–`:692` | ending mirrored by the queue and sweep; A3 restores a lost one | — | `recordDeliveryOutcomeForOperation` `:601`, `discardDeliveryForOperation` `:662` synchronous; C2 |
| P21 | Operator switch and intent controls: Stop, retry failed, cancel switch, rollback, retry migration, pipeline reseat | `account-migrations/[intentId]/action.ts:22` `:37`; `conversationCommand.ts:305` `:322` `:345`; `pipelines/engine.ts:1544` | held sends keep their switch reason; endings mirrored | per conversation (the command drains its own conversation, `conversationCommand.ts:316` `:323` `:347`) | all synchronous; C2 |
| P22 | Hygiene in the inventory sidecar | `runReaperCycle` `reaperRuntime.ts:944` (runs only in the sidecar, `migration/controller.ts:149`–`:153`, `:335`–`:337`): `:870` `:893` `:925` `:928` `:935` `:972` | endings mirrored; A3 restores a lost one | sidecar cycle | all synchronous in the sidecar's loop; C4 |
| P23 | Withdrawals: seat wake, Telegram reply | `seatTickSources.ts:603`–`:620`, `:674`; `telegram/bot/reportReplies.ts:71` | endings mirrored | — | synchronous; C2 |
| P24 | Spawn first message bookkeeping | `structuredSpawn.ts:399` (delivered), `:407` (initial message timed out) | the first message's record is P1's | — | synchronous; C2 |

Not sends, so outside the three rules: the spawn command's launch prompt (its
launch receipt has its own lifecycle and recovery, #334/#926; the message
itself is admitted by `enqueueStructuredMessage`, `structuredSpawn.ts:616`
`:1475` `:1790` `:2063`); answer, interrupt, compact and reconfigure controls
(`structuredControls.ts:177` and the queue's control effects, each with its own
receipt and no reservation); native queue panel controls on an existing entry
(their own operations; the entry's add operation keeps the record, P18).

### Paths found after round 6

The rounds found P7, P9 (drain and writes), P2/P6 and the P8 listing. The first
revision of this design found five more (P4; P13; P14; the P10 lost-wake on a
working lane and the stale switch reason; the P1/P13/P15/P9 synchronous
writes). Its critique found the rest:

1. **P19**: startup's interrupted-Codex continuation and its retry bypass the
   reservation entirely, and both continuation loops serialize hosts.
2. **P17, P18**: the native and legacy transports carry ordinary accepted
   sends; the first revision exempted both. Its claim that the native
   executor's `settled` callback is synchronous by contract was false: the
   executor awaits it (`nativeQueueExecutor.ts:108`, `:183`, `:215`).
3. **P9**: a single advancement section still let one conversation's
   unanswered provider call hold another conversation's switch and its sends.
4. **P20–P24, P9 commit/rollback/stop, P8 reconfigure**: settle and bind writes
   missing from the (c) inventory.
5. **P9, P10**: an observer's `conversation-busy` erased the acting
   operation's stall.
6. **P11, P15**: an ending owed at a crash, or settled by the sidecar while the
   record was owed, is never restored.
7. **P4**: a refused ending of a rejected payload could let the drain deliver
   it, because the drain's capability check skips the encoded-size limit.
8. **P10, P15**: the watchdog stops for every conversation while startup is
   pending.

## Rule (a): one record from the reservation on

### A1. Open at the reservation, update at every step

Generalize `noteHeldWait` (`structuredMessageDelivery.ts:180`) into the one
writer the admission paths and the drain use (`recordWait(progress, registry,
reservation, wait)`). It creates the record when missing (original key,
admission time, kind and deadline read off the reservation) or updates its
reason, and returns the record it wrote. `held` reservations keep their switch
reason. It is called in the synchronous step after every reservation write:
both `holdDeliveryOffLoop` sites (`:583`, `:1342`), the P4 recovery reservation
(`:1373`), the P16 re-arm, and the legacy hold (`delivery.ts:826`).

The structured live path (P1) then writes this sequence on the same record:

| Step | Reason, detail | Next wake |
|---|---|---|
| reservation `assigned`, live host | `checking`, "claiming the delivery record" | none: the request is acting |
| the conversation's actuation section is held by another operation | `conversation-busy`, "an earlier send on this conversation is being admitted" | none |
| claim refused for the lock | `checking`, "the writer claim waited past its lock deadline" (exists) | migration pass (60 s) |
| claim returned nothing (a switch took it, an earlier admission waits) | `conversation-busy` (exists) | migration pass |
| claimed, before `client.command` | `checking`, "admitting to the runtime journal" | none |
| answered `queued`/`pending` | `queued`, guarded by rule (a) step 4 | `retryMs` |
| answered `delivered` / `rejected` / `failed` / `uncertain` | settled from the receipt | — |
| command threw after the claim (P7) | `evidence-unreadable`, "the runtime journal did not acknowledge the admission: …", attempt counted; the queue is kicked | `retryMs` |
| P4 resume running | `recovering-host`, "the conversation's host is being resumed" | none |
| P4 resume threw | `awaiting-host`, the error | migration pass |
| reservation ended by the request (rejected payload, unpublished resume) | settled `failed` with the reason | — |
| an ending the request could not write (C2 refusal) | `awaiting-host` or `checking`, naming the refused write | migration pass |

The legacy path (P17) writes on its record: `checking` "claiming the delivery
record" after the hold; `dispatching` "typing into the conversation's pane"
once claimed; settled `delivered` on success, `failed` when nothing was typed,
and `uncertain` when typing started and nothing came back (the reservation stays
absorbing, `delivery.ts:938`–`:955`, and the sweep later ends it unverified,
which the mirror leaves as it is). A legacy reservation drained by the
coordinator gets the same `dispatching` note from the drain.

A step with no next wake is an in-request wait. The watchdog never calls it a
lost wake (`tick` skips a record without `nextWakeAt`). The stall mark still
applies: `checking`, `evidence-unreadable`, `dispatching` and `recovering-host`
are active phases, marked after 4 s without progress, so the visible stall line
comes within the ten-second bound. Every step's own wait is bounded: lock 5 s,
socket call 3 s (`client.ts:153`), the section by the earlier holder's bounds.

The section holder declares the operation it acts on when it enters, so
observers can leave that record alone: `withConversationActuation` and
`tryConversationActuation` hand the lease an `act(operationId)` call, and
`actingOperation(conversationId)` beside them answers the holder's operation or
null. The structured admission declares its reservation's operation as it
enters; the legacy send declares right after its hold; the drain declares the
item it is about to claim.

The P7 kick matters: the request threw before its usual kick, so a journal that
did admit the command has nobody waking the queue for up to the 5 s safety
pass. With the kick, the queue lists it and continues the record within one
pass. When the journal never received it, the record keeps
`evidence-unreadable` and the drain reconciles it under its original key (P9,
A5).

**P19 through A1.** The interrupted-Codex continuation is admitted the way the
#1835 continuation beside it already is (`startup.ts:509`): through
`enqueueStructuredMessage`, with `operationId` and `clientMessageId` both set to
its deterministic id (`interruptedCodexContinuationOperationId`, `:623`),
`policy: "queue"`, `turnId: null`, its recovery origin, and startup's own
`client`, `registry` and `interruptionContinuation: true`. The deputy exemption
(`structuredMessageDelivery.ts:1067`–`:1072`) accepts that id beside an
obligation id, still only with the dependency set, so a deputy's cut turn is
continued exactly as today. The continuation then has a reservation, an owner
row, a deadline and a record before the command leaves the process. A lost
reply leaves the reservation `delivery-uncertain` with `evidence-unreadable`;
the admission answers `transportUncertain`; the startup pass collects it as a
failure and throws after every host was tried (B2), and its retry either finds
the operation in the journal (`existingByKey`, `:671`) or re-admits under the
same key, where `admitDurably` re-arms the reservation and the command carries
the same operation id, which the journal deduplicates. A `queue` send on a
capable Codex host becomes a native entry at the journal (P18) exactly as the
direct command did.

### A2. Retries: reopen the record, or write the row and the record first

- **P13**: `DeliveryProgressStore.rearm(operationId, conversationId, note)`
  reopens a terminal record (terminal cleared, attempt + 1, phase and progress
  dated now, `stalledSince` cleared, `wakeLostAt` kept as evidence) and creates
  one when missing. Only the retry route calls it, in the step after
  `retryUncertainDeliveryForOperation` returns a live reservation, which the
  route reaches only once the journal's `retry` action claim has won
  (`http.ts:813`). The reopened record says `checking` for the claim and the
  journal's re-arm, then `queued` on its answer. The deadline is re-read from
  the re-armed reservation.
- **P14 and P19(b)'s retry**: a terminal retry's operation id is deterministic,
  `retry_<sha256(previous operation id)>` (`runtime-host/journal.ts:190`,
  `:964`). It is exported once from `contracts.ts` as
  `terminalRetryOperationId`, with a test pinning it to the id the journal's
  `retryOperation` returns; `journal.ts` keeps its own copy and is not edited.
  Both callers then write the retry-attempt row for
  `terminalRetryOperationId(<the operation being retried>)`, related to the
  send's presentation operation as today (`http.ts:931`), off-loop, and open
  its record (`checking`, "admitting the retry to the
  runtime journal", the original key from the row) **before**
  `client.retryOperation`. The answer moves the record to `queued` (step 4
  guard); a thrown call leaves `evidence-unreadable` and kicks the queue; a
  definitive refusal (the route's existing 409 family) settles the row (`failed`,
  `lost`, the refusal) and the record. A refused row write answers the route's
  existing `retryRecordUnavailable` 503 before anything is sent; startup counts
  it as a failure for its retry. A previous continuation admitted by older code
  has no owner row, so `recordDeliveryRetryAttempt` answers false: the record is
  still opened, and the retry proceeds as today with no deadline (old data only,
  Notes).

### A3. The sweep restores what the record missed

The settlement sweep timer (`structuredDeliveryController.ts:1902`) already
reads the registry snapshot every 15 s. In that order:

1. **Open reservations without a record.** It walks the open reservations
   (`held`, `assigned`, `delivery-uncertain`) and the open retry-attempt rows,
   and opens the record of any that has none: reason from the reservation
   (`held` → its switch reason through `recordWait`, `assigned` → `checking`,
   `delivery-uncertain` → `evidence-unreadable`, a retry-attempt row →
   `queued`), detail "recorded from the delivery record", dated from the
   admission time so an active phase shows its stall at once. `held` is listed
   on purpose: it is outside the settleable set (`sendSettlement.ts:535`).
2. `mirrorSettledReceipts` as today.
3. **Recent endings without a record.** It walks `deliveryOperationOwners` rows
   whose `terminalState` is set and whose `settledAt` is at or after the
   store's completeness mark, and for each operation the store holds in neither
   memory nor its file, writes a terminal record: original key
   `clientMessageId`, kind, admission time `createdAt`, the conversation, the
   ending's time `settledAt`, and the state and reason
   `mirrorReceiptProgress` derives from `sendReceiptFor` (delivered;
   `uncertain` where a duplicate is possible; `failed` otherwise). Owner rows
   cover every ending this design needs: a delivered, rejected or cancelled
   reservation (its row is synced at the ending, `registry.ts:2489`–`:2511`),
   a discard (`discardDeliveryForOperation`), and a retry leaf (its own row).
   The store method (`backfillEnded`) writes the record with the existing
   retention and nothing else: no rearm, no wake, no dispatch.
4. `settleDueSends` as today.

The completeness mark is the newest `updated_at` the store read from its file
when it loaded (its load time when the file held no row), and after each sweep
that sweep's snapshot time minus one sweep interval. Everything the Viewer
recorded before the mark reached the file, because a flush writes every owed
record at once; everything after it is checked. A first deployment has no file,
so nothing older than the Viewer's start is backfilled.

This covers what A1 cannot: a record owed when the Viewer died (the store
writes 20 ms behind, longer while its file is busy), open or already ended; a
send claimed or ended by the inventory sidecar, which owns no store. Its bound
is the sweep interval; A1 is the primary and gives the moment.

### A4. The watchdog asks the reservation before calling a wake lost

`unlistedWakeDue` (controller `:839`) handles overdue records the journal does
not list. For each one it now reads the reservation:

- the operation is the acting operation of its conversation's lane or section:
  skip it; its own phase and stall stand (the queue already applies this rule
  to its own lanes, `structuredDeliveryQueue.ts:1324`);
- the conversation has a running lane or held section, and this is another of
  its `assigned` reservations: observer rule (a) step 5;
- the reservation is `held`: write it through `recordWait`, which derives
  `switching-accounts`, `switch-after-turn` or `switch-failed` from the
  conversation's migration phase;
- otherwise: `wake-lost` and a migration tick, as today.

### A5. The drain records what it decides, and leaves the acting record alone

`heldDrainProgress` skips every write while reconciling an uncertain row
(`structuredMessageDelivery.ts:899`), because the queue may own the record. A
reconcile whose runtime read fails (`heldOutcomeDuringRuntimeSynchronization`
returns `delivery-uncertain`) knows the queue cannot list the journal either,
so that outcome writes `evidence-unreadable` with its cause. The drain reports
the waits it decides itself through an optional port method,
`HeldDeliveryPort.wait(delivery, reason, detail)`, implemented in
`deliveryPort.ts` with `recordWait`: a claim refused for the lock (`checking`,
on the drain's own item), and a section held by another actuator or a lane
already running for the conversation (`conversation-busy`, through the
observer rule only, so the holder's acting record is never rewritten).

### A6. The native queue records its waits

The P1 record carries the native entry from admission (`queued` once the
journal answers). From the queue's listing on:

- the status read is a `checking` step like any other; an unreadable status
  (queue `:1521`–`:1527`, today `continue` with no note) writes
  `evidence-unreadable`, "delivery journal status is unavailable";
- `NativeQueueExecutor.execute` takes a third argument, `note(reason, detail)`,
  passed through `nativeQueueExecute`, and reports each wait it answers `false`
  for: the switch the entry follows has not committed (`:53`,
  `switching-accounts`); the switch's successor has no host yet (`:68`, `:82`,
  `awaiting-host`); the host's health cannot be read (`:81`,
  `evidence-unreadable`); and `dispatching` just before the `prepared`
  transition (`:90`). The queue writes each with its retry wake. Any other
  `false` (`:83`) keeps the last reason and sets the retry wake, so the
  watchdog still sees a due wake;
- after the acknowledgement the journal answers `queued` while Codex holds the
  entry in its own queue (`journal.ts:596`): the record says `awaiting-turn`,
  "held in Codex's own queue", a passive phase, until the proof settles it
  `delivered` (`journal.ts:597`) or a removal settles it `failed`.

### A7. The watchdog runs through startup

The watchdog timer returns while startup is pending (controller `:1889`), so
for the minutes a startup can take nothing marks a stall or replaces a lost
wake on any conversation, registered or not. The guard drops `startupPending`.
What keeps an unregistered host safe is already there: the safety pass reaches
targets through the same drain that registration events already request during
startup, and `deferTarget` (controller `:861`) defers an unregistered host's
target and notes `startup` on its records (queue `:1014`–`:1015`). Stall
marking and lost-wake detection only write records; lane reconciliation reads
host evidence for lanes that exist, which only registered hosts have.

## Rule (b): drains per conversation

### What already satisfies (b)

- Delivery queue: one lane per conversation, the pass races `passBudgetMs`
  (5 s), a lane that outlives it keeps its conversation, its end runs another
  pass, a lane whose operation settled elsewhere is released.
- Watchdog: marking is synchronous; evidence reads are detached and bounded by
  `reconcileReadMs`; the safety pass is the bounded queue pass.
- Settlement: due sends start per conversation, `running` stops a second sweep
  from settling the same conversation, reads bounded by 10 s.
- Terminal projection repairs and native-queue reconciliation are detached per
  operation and per conversation.

### B1. Lanes and a leased advancement permit in `reconcileMigrations`

The per-conversation callback of the loop at `coordinator.ts:1212` becomes a
lane, started and not awaited:

1. The loop keeps today's synchronous snapshot filters (pending, uncertain,
   parked, active migration). A conversation whose lane is running is skipped
   and marked for a rerun; its other `assigned` reservations get
   `conversation-busy` through the observer rule, and its acting operation is
   left alone.
2. The lane runs today's body for that conversation in today's order:
   successor cleanups owed for it (moved here from the sequential loop at
   `:1184`, which ran before every drain), uncertain reconciliation, orphan and
   rollback cancellations, advancement, post-commit drain, parked-switch drain.
3. **Advancement permit.** `advanceConversationMigration` runs under one
   process-wide permit, handed over in arrival order. The permit passes to the
   next waiting lane when the holder's call returns, or when the holder has
   kept it for `ADVANCEMENT_LEASE_MS` (equal to `HELD_DRAIN_PASS_BUDGET_MS`),
   whichever comes first. A holder whose lease ran out keeps running in its own
   lane and keeps its own conversation; it holds no other lane. Advancements
   that end within the lease run one at a time, as today. When one hangs (A's
   provider `create`, `verify` or `publishHost` never answers), the next lane
   starts within the lease, and at most one more starts per lease interval
   while earlier ones still run.
   - A late answer stays safe. A's lane is the only actor advancing A in this
     process, since a pass skips a conversation whose lane runs. Every
     advancement write is fenced by the migration's revision and operation id
     (`transitionConversationMigration`, the creation owner in
     `persistMigrationProviderReceipt` `:1001`, `ownsPublication` `:1016`, and
     `commitSuccessor` with revision, operation and receipt `:1064`); the
     provider's publication is idempotent per operation
     (`provider.ts:1468`–`:1483`). A's held sends stay `held` until A's commit
     carries them to the successor (`registry.ts:1470`–`:1478`) and A's own
     lane drains them, claimed once each. So a late A publishes once, commits
     once and delivers each input once.
   - The admission's forced switch (`structuredMessageDelivery.ts:1257`) and
     the operator retry command's advancement (`conversationCommand.ts:346`)
     stay outside the permit: each advances one conversation inside its own
     request, as today.
4. After the loop the pass waits for its lanes until
   `HELD_DRAIN_PASS_BUDGET_MS` (5 s, beside `ACCOUNT_MIGRATION_PASS_INTERVAL_MS`
   in `controllerSignal.ts`; `options.passBudgetMs` for tests), then runs the
   board repair and intent completion on what has finished.
5. A lane that outlived its pass, or was marked for a rerun, calls
   `requestAccountMigrationTick()` when it ends. The sidecar has no tick
   registered and keeps its 60 s poll.
6. Lanes and the permit live on `process` (the same reason as the actuation
   sections: Next evaluates instrumentation and routes in separate bundle
   realms); `heldDrainBusy(conversationId)` answers a running lane's acting
   operation for A4 and A5.

`drainHeldDeliveries` keeps its signature and its per-item order. Each item is
still claimed and delivered inside `tryConversationActuation`, so a claim and
its journal admission stay ordered within the conversation (#1709), and a
section held by an HTTP send is left for the tick its release requests.

Ownership across processes is unchanged: lanes, sections and the permit are per
process; the registry claim (`assigned` → `delivery-uncertain`) decides which
process actuates a reservation, and the journal's operation id decides that the
host gets it once.

The controller's `running` promise now waits at most one pass budget plus the
cycle's other bounded steps, so a tick requested for conversation B is served
while A's lane is still held.

### B2. Startup admits its continuations per conversation

Both continuation loops in startup (`startup.ts:499`, `:663`) start every
conversation's admission at once and wait for all of them; continuations of
one conversation stay one after another. Each admission is bounded by its own
calls' deadlines (3 s per socket call). The bookkeeping after each result is
unchanged (`:522`–`:546`), and the failures are collected and thrown after
every host was tried (`:1672`–`:1676`), so one host's unanswered or failed
admission neither delays nor skips another's. At most one host input per
continuation comes from its deterministic operation id and the journal's
operation-id dedup, unchanged.

## Rule (c): every delivery write off the loop

### C0. One generic write

`AgentRegistry.whenWriterHeld` (`registry.ts:5192`) becomes public as
`deliveryWrite(correlation, write)`. Its contract is the existing one: `write`
makes exactly one registry mutation and reads no snapshot first. Two methods
read a snapshot to decide whether to mutate (`terminalizeFailedSpawnDeliveries`
`:6541`, `drainDeadSupersededHeldDeliveries` `:9163`); each is split into a
read-only candidate check and its mutation, which re-checks inside the
transaction as it does today. Every other method below goes straight to
`this.mutate` (checked for each). The existing named wrappers
(`holdDeliveryOffLoop`, `beginDeliveryAttemptOffLoop`,
`recordDeliveryOutcomeOffLoop`, `recordDeliveryOutcomeForOperationOffLoop`, …)
stay. A call site that was synchronous becomes `await`ed; the functions that
gain an `await` are listed in "What changes".

### Every write, its effect, its label and its refusal

Grouped by where it runs. "Viewer" is the Next process; "sidecar" is the
inventory worker. Effects: **create**, **claim**, **rearm** (re-arm or
requeue), **settle** (an ending), **bind** (moves a row to another generation
or migration, or holds a conversation's sends).

**C1. Account-migration coordinator (Viewer fast controller and sidecar)**

| Site | Write | Effect | Label | A refused acquisition |
|---|---|---|---|---|
| `coordinator.ts:1144` | `beginDeliveryAttempt` | claim | `delivery.claim` | nothing claimed; stays `assigned`; `checking` noted; next pass |
| `:1136` | request-local `failed` | settle | `delivery.settle` | stays; next pass |
| `:1162` | `recordDeliveryOutcome` failed `lost` (unactuated bound) | settle | `delivery.settle` | stays `delivery-uncertain`; Note 1 |
| `:1163` | `requeueUnactuatedDelivery` | rearm | `delivery.requeue` | stays `delivery-uncertain`, reconciled under its original key; Note 1 |
| `:1166` `:1168` | `recordDeliveryOutcome` | settle | `delivery.settle` | stays `delivery-uncertain`; the next pass reconciles; the journal replays the same operation |
| new (Note 2) | `recordDeliveryOutcome` failed `lost` with the payload's rejection | settle | `delivery.reject` | stays `delivery-uncertain`; the next pass reaches the same rejection before any command |
| `:1243` | orphan `terminalizeHeldDelivery` | settle | `delivery.cancel` | stays; **the lane ends without draining that conversation this pass** |
| `:1259` | `terminalizeRolledBackMigrationDelivery` | settle | `delivery.cancel` | same: no drain this pass |
| `:956` `:1288` | `rollbackConversationMigration` | bind | `migration.rollback` | the migration and its rows stay as they were; the lane ends; next pass |
| `:1064` | `commitSuccessor` (`settleDeliveriesAtCommit`) | bind, settle | `migration.commit` | stays `verifying`, held rows stay held; the next pass publishes again (idempotent per operation) and commits |
| `:1320` | `setMigrationIntentState` `complete` | none on rows | `migration.intent` | the intent stays `draining`; next pass |
| `migration/controller.ts:45` | `compactDeliveryReservations` | removes ended rows, writes owner rows | `delivery.compact` | skipped this cycle; the next one compacts |

**C2. Admission and request routes (Viewer)**

| Site | Write | Effect | Label | A refused acquisition |
|---|---|---|---|---|
| `structuredMessageDelivery.ts:578` `:1201` | `requestConversationMigrationToActiveAccount` | bind | `migration.reseat-request` | before any reservation: refused as `REGISTRY_WRITER_BUSY` with `admission: "refused"`, as a refused hold is today |
| `:1483` | `retryUncertainDelivery` | rearm | `delivery.rearm` | stays `delivery-uncertain`; answered with `uncertainReservationFailure` |
| `:1578` | `requeueHeldDelivery` | rearm | `delivery.requeue` | stays `assigned`, unclaimed; answered `held`; `checking` noted |
| `:1596` `:1610` | `recordDeliveryOutcome` | settle | `delivery.settle` | stays `delivery-uncertain`; the answer follows the journal's receipt; the drain or the sweep projects it |
| `:836` `:861` `:1399` `:1423` `:1458` | `terminalizeHeldDelivery` | settle | `delivery.terminalize` | answered `held` (accepted) and recorded with the refused write named; Note 2 decides how it ends |
| `:1490` | held injection `terminalizeHeldDelivery` | settle | `delivery.terminalize` | answered `held`; the switch's commit fails it with the injection reason (`registry.ts:1446`), or a rollback returns it to the same thread |
| `delivery.ts:826` | `holdDelivery` → `holdDeliveryOffLoop` | create | `delivery.hold` | refused before any reservation (`REGISTRY_WRITER_BUSY`, `admission: "refused"`) |
| `delivery.ts:868` | `beginDeliveryAttempt` → off-loop | claim | `delivery.claim` | stays `assigned`; answered `held`; the drain delivers a text payload and fails a request-local one (`coordinator.ts:1136`) |
| `delivery.ts:858` `:865` `:882` | `discardDelivery` (request-local) | settle | `delivery.discard` | stays; the existing 409 answer; the drain fails it as request-local |
| `delivery.ts:885` | `requeueHeldDelivery` | rearm | `delivery.requeue` | stays as it was; answered `held` |
| `delivery.ts:982` | `recordDeliveryArtifacts` | records paths before typing | `delivery.artifacts` | nothing is typed: the send fails before actuation, its images are deleted and the reservation discarded through the same path as `:1093` (refusal of that discard: stays, the drain fails it) |
| `delivery.ts:954` | `recordDeliveryOutcome` delivered | settle | `delivery.settle` | stays `delivery-uncertain` (absorbing; a replay answers verify-first); the sweep ends it unverified at its deadline; Note 3 |
| `delivery.ts:955` `:1093` | `discardDelivery` after nothing was typed | settle | `delivery.discard` | stays; the drain or the sweep ends it |
| `http.ts:601` | `recordDeliveryOutcomeForOperation` delivered | settle | `delivery.settle` | the answer still reports the journal's delivery; the queue's projection or the sweep writes it |
| `http.ts:662` | `discardDeliveryForOperation` | settle | `delivery.discard` | the existing 503 `retryable` (`:669`–`:673`); the journal already holds the discard, so the sweep projects it, and a repeated discard converges (`claimDeliveryAction` answers discard as the winner) |
| `http.ts:819` | `retryUncertainDeliveryForOperation` | rearm | `delivery.rearm` | nothing re-armed; 503 `retryable` |
| `http.ts:833` | `beginDeliveryAttempt` | claim | `delivery.claim` | the existing 503 `retryable`; the journal has not re-armed the operation yet |
| `http.ts:88` (moved before the command, A2) | `recordDeliveryRetryAttempt` | create | `delivery.retry-attempt` | the existing `retryRecordUnavailable` 503, now before anything is sent |
| `action.ts:22` | `setMigrationIntentState` `stopped` (Stop) | settle | `migration.stop` | 503 `retryable`, "the stop could not be recorded; nothing changed"; the intent keeps draining |
| `action.ts:37`, `conversationCommand.ts:345`, `engine.ts:1544` | `retryConversationMigration` | bind | `migration.retry` | routes: 503 `retryable`; engine: throws, and the engine waits and asks again (`engine.ts:2060`–`:2061`) |
| `conversationCommand.ts:305` | `cancelConversationSwitch` | bind | `migration.cancel` | 503 `retryable`; nothing cancelled |
| `conversationCommand.ts:322` | `rollbackConversationMigration` | bind | `migration.rollback` | 503 `retryable`; nothing rolled back |
| `seatTickSources.ts:614` `:616` | `recordDeliveryOutcomeForOperation`, `recordDeliveryOutcome` | settle | `delivery.settle` | answers null (not settled), as for an undecidable verdict; the next tick reads it again |
| `seatTickSources.ts:674` | `terminalizeHeldDelivery` (wake withdrawal) | settle | `delivery.withdraw` | answers `unknown`, the existing answer for an undecided withdrawal |
| `reportReplies.ts:71` | `terminalizeHeldDelivery` (reply withdrawal) | settle | `delivery.withdraw` | answers not withdrawn; the caller's existing fallback runs |
| `structuredSpawn.ts:399` | `recordDeliveryOutcome` delivered (first message) | settle | `delivery.settle` | stays; the queue's terminal projection or the sweep settles it from the journal |
| `structuredSpawn.ts:407` | `recordDeliveryOutcome` delivery-uncertain (first message timed out) | settle | `delivery.settle` | stays as it was: a claimed first message is already `delivery-uncertain`; an unclaimed one is delivered by the drain under its key |
| startup P19 | through `enqueueStructuredMessage` and the retry row | as above | as above | as above; startup counts the refusal as a failure and its retry repeats under the same key |

**C3. Delivery queue, controller and startup (Viewer)**

| Site | Write | Effect | Label | A refused acquisition |
|---|---|---|---|---|
| controller `:864` | `holdForFailedSwitch` | bind | `delivery.switch-hold` | the lane throws; the effect is still listed; next pass |
| `structuredReconfigure.ts:106` `:121` | `claimConversationReconfigure`, `settleConversationReconfigure` (release kept deliveries) | bind | `delivery.reconfigure` | the executor throws `REGISTRY_WRITER_BUSY`; the effect is still listed; next pass |
| controller `:767` | native `settled` → `recordDeliveryOutcomeForOperationOffLoop` | settle | `delivery.native-settle` | stays `delivery-uncertain`; the sweep settles it from the journal, which already holds the entry's ending |
| controller `:435` | startup `recordDeliveryOutcomesForOperations` (one batch) | settle | `delivery.startup-settle`, first operation id | outcomes stay owed; the acknowledgement to the journal is sent only after a durable write, so the journal's retention keeps them; the drain and the sweep project them |
| `startup.ts:1335` | `drainDeadSupersededHeldDeliveries` (split, C0) | settle | `delivery.superseded` | skipped this pass; the next startup pass runs it |

**C4. Hygiene (inventory sidecar)**

| Site | Write | Effect | Label | A refused acquisition |
|---|---|---|---|---|
| `reaperRuntime.ts:870` | `recordDeliveryOutcome` (#652) | settle | `delivery.hygiene` | stays; next cycle |
| `:893` | `terminalizeRolledBackMigrationDelivery` | settle | `delivery.hygiene` | stays; next cycle |
| `:925` + `:928` | `terminalizeHeldDelivery` then `rollbackConversationMigration` | settle, bind | `delivery.hygiene`, `migration.rollback` | a refused ending skips that conversation's rollback this cycle, so the pair stays together; next cycle |
| `:935` | `setMigrationIntentState` `stopped` (no progress) | settle | `migration.stop` | the intent stays `draining`; next cycle |
| `:972` | `terminalizeFailedSpawnDeliveries` (split, C0) | settle | `delivery.hygiene` | next cycle |

The hygiene sites run only in the sidecar (`migration/controller.ts:149`–`:153`,
`:335`–`:337`), so a synchronous wait there blocks the sidecar's loop and with it
the sidecar's own drain lanes, never the Viewer's. The rule applies all the
same: the sidecar drains accepted sends too. `runReaperCycle` already awaits;
`terminalizeStaleUndeliverableHeldDeliveries` becomes async.

Note 1: leaving a never-dispatched send claimed (a refused requeue at `:1163`,
or a refused `lost` failure at `:1162`) changes how it can end. With the host
back, the reconcile admits it and it is delivered once. With the host still
unreachable at its deadline, it ends `unverified` (resend behind verification)
where a requeue would have ended it `lost`. That answer is conservative and
needs a refused lock and an outage together.

Note 2: today the C2 terminalize sites answer `failed` after a synchronous
write. An answer of `failed` over a reservation that is still live would invite
a resend under a new key while the drain may still deliver the first, so a
refused terminalize answers `held`, and the reservation must still end the way
admission decided. Each reason admission can reach after the reservation now
has its ending outside the request:

- **Payload the recovered host cannot take** (`:1463`–`:1469`). One predicate,
  `payloadRefusal(capability, engine, refs)`, decides unsupported images and the
  encoded-size limit, and both admission and `deliverHeldAttempt` call it, the
  drain just before `progress.wait("dispatching")` and the command
  (`structuredMessageDelivery.ts:1015`–`:1026`). The drain cannot see the
  upload's base64, so both compute the encoded size from the stored refs
  (`4 · ⌈bytes / 3⌉` per image); admission's figure changes only for an upload
  whose base64 carried whitespace or no padding. The drain answers
  `{ outcome: "rejected", cause }` and the coordinator records `failed` with that
  cause and the `lost` disposition (C1 `delivery.reject`). Today's capability
  check at `:1018` tests support only; the size limit is new to the drain.
- **Held injection** (`:1490`): the commit fails a held injection with the
  injection reason (`registry.ts:1446`, `NOT_CARRIED_DELIVERY_REASONS`), and a
  rollback returns it to its own thread, so it is never replayed into the
  successor's. The first revision's extra drain guard for this case is cut: it
  duplicated the commit's decision.
- **Unpublished or failed resume** (`:836`, `:861`, `:1399`, `:1423`): the
  reservation is an accepted send whose host could not be raised; the drain
  retries the resume, delivers once it works, and fails it at the unactuated
  bound (`unactuatedFailure`) otherwise.

Note 3: a legacy send that was typed and whose `delivered` write was refused
stays absorbing and ends unverified at its deadline. The legacy path has no
journal to prove arrival later, so the answer is conservative and needs a
refused lock at that moment.

## At most one host input

| Scenario | The fence that decides it (unchanged) |
|---|---|
| Two actuators claim one reservation (two passes, Viewer and sidecar, HTTP and drain, legacy and drain) | registry claim `assigned` → `delivery-uncertain`, one winner |
| A resend, a reconcile, a lost-ack retry or a startup retry commands the same operation | journal admission is idempotent per operation id and key; a replay adds no effect |
| Two executors read the same operation as `queued` (succession, rebind) | `delivering` written only from `pending`/`queued` (`fromStatuses`); a retired lane acts on nothing |
| A native entry read by two executors | `prepared` written only from `pending`/`queued` (`journal.ts:602`), and the entry's mutation identity |
| A send settled while unreachable | `settled` fence read before actuation; settlement fences the journal first |
| Late evidence or a late acknowledgement | settles the same operation; never writes input |
| Operator's unknown-fate retry | journal `claimDeliveryAction("retry")` must win; same operation re-armed, never automatically |
| Terminal retry, from the route or from startup | a new operation with a deterministic id, only on a terminal `failed`/`rejected` original; startup retries once (`!existing.receipt.retryOfOperationId`, `startup.ts:674`) |
| A late advancement answer after its lease ran out | migration revision and operation fences; the commit carries each held row once |
| A legacy send typed with no answer | the reservation stays absorbing; a replay answers verify-first (`delivery.ts:853`) |
| A payload admission rejected, whose ending was refused | `payloadRefusal` runs before the drain's command |

What this design adds touches none of them: records are observational, lanes
and the permit add scheduling within the existing sections, claims and
revision fences, and an off-loop write commits the same mutation in the same
transaction it waited for.

## Findings map

| Round | Finding | Path | Rule | At `dc8769080` | This design |
|---|---|---|---|---|---|
| 4 | P1 accepted send unexplained when the effect listing fails | P8, P1 | (a) | fixed: `noteAdmitted`, `noteUnlisted` | A1 opens it at the reservation; A3 backstop |
| 4 | P1 writer-lock wait on the shared loop at admission | P1, P2 | (c) | fixed for hold and claim | C2 covers the rest |
| 4 | P2 late acknowledgement leaves progress `uncertain` | P12 | (a) | fixed: `settle` promotion, mirror | kept |
| 5 | P1 outage / deferred-claim admission without a record | P2, P6 | (a) | fixed: `noteHeldWait` | folded into A1's single writer |
| 6 | P1 lost admission acknowledgement has no record | P7 | (a) | **open** | A1 |
| 6 | P1 held-send recovery serializes conversations | P9, P10 | (b) | **open** | B1, A4 |
| 6 | P2 held-delivery writes take the synchronous lock | P9 | (c) | **open** | C1 |
| critique | P1 startup continuation admission and retry bypass the reservation; loops serialize hosts | P19 | (a), (b), (c) | **open** | A1 (through `enqueueStructuredMessage`), A2 (row and record before the retry command), B2 |
| critique | P1 WRONG-PREMISE native and legacy accepted sends exempted | P17, P18 | (a), (c) | **open** | A1 legacy steps, A6, C2 legacy rows, C3 native settle |
| critique | P1 one stuck advancement holds another conversation's switch and sends | P9 | (b) | **open** (and in B1 of the first revision) | B1 leased permit |
| critique | P2 (c) inventory missed discard, commit, rollback, Stop, hygiene, failed-spawn cleanup | P9, P20–P24, P8 | (c) | **open** | C1–C4 inventory; premise correction: hygiene runs in the sidecar |
| critique | P2 `conversation-busy` from a later pass erases the acting operation's stall | P9, P10 | (a) | first revision only | rule (a) step 5, `actingOperation`, A4, A5 |
| critique | P2 an ending lost at a crash is never restored | P11, P15 | (a) | **open** | A3 step 3 |
| critique | P2 refused terminalize lets the drain deliver an over-limit image | P4 | (c) refusal | first revision only | Note 2: shared `payloadRefusal` |
| critique | P2 watchdog paused for every conversation during startup | P10, P15 | (a) | **open** | A7 |

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
| `structuredMessageDelivery.test.ts` (78) | P1–P7 admission contracts | refusal before reservation; holds; recovery; `:818` over-limit before storage (Note 2 keeps it green) |
| `structuredMessageDelivery.keyed.test.ts` (1) | P16 | same-key replay |
| `structuredMessageDelivery.placement.test.ts` (3) | P1 | reservation placement |
| `structuredMessageDelivery.accountReseat.test.ts` (26) | P5 | switch hold, forced switch |
| `structuredDeliveryController.test.ts` (4), `.migration.test.ts` (7) | P15, P5 | bind, switch hand-off |
| `structuredDeliveryController.nativeSwitch.test.ts` (14) | P18 | native entry across a switch ("pending native add follows the replacement host …"); (a) after A6 |
| `nativeQueueRuntime.test.ts` (31), `nativeCodexQueue.test.ts` (23), `nativeQueueHttp.*` (22), `nativeQueueCompaction.integration.test.ts` (1) | P18 | ordinary queue send handed to native (`nativeQueueRuntime.test.ts:327`); `prepared` fence; once; (a), (c) after A6/C3 |
| `structuredDeliveryRebind.test.ts` (14) | P15, P10 | rebind, realms, startup drain (`:203`); (a) after A7 |
| `startup.test.ts` (73), `startupFinalization.integration.test.ts` (14) | P19, P15 | continuation admission (`:888` retained continuation); once; (a), (b) after A1/B2 |
| `structuredSwitchCancelQueue.test.ts` (2) | P5, P21 | cancelled switch releases the send |
| `structuredReconfigure.test.ts` (26) | P8 reconfigure | kept deliveries; (c) after C3 |
| `structuredDeliveryLegacyVerdict.integration.test.ts` (1) | P17 | legacy verdict |
| `structuredDeliverySignal.test.ts` (1) | P8 | kick signal |
| `structuredCompactDelivery.test.ts` (17) | compaction controls | none: controls carry no reservation |
| `codexSteerDelivery.integration.test.ts` (1, real binary) | P8 steer | once |
| `sendSettlement.test.ts` (51) | P11–P14 | receipts, deadlines, retry rows; (a) A3 |
| `http.test.ts` (33) | P13, P14, P20 | retry authority; discard (`:1190`); once; (c) after C2 |
| `TmuxComposer.operationReadBack.dom.test.tsx` (12) | P20 | discard read-back (`:273`); unchanged answers |
| `http.refusedDelivery.test.ts` (5) | before acceptance | none: nothing reserved |
| `deliveryDedup.test.ts` (2) | host dedup token | once |
| `hostlessSessionSettlement.test.ts` (12) | dead-host turn closing | none: no send |
| `accounts/migration/coordinator.test.ts` (103, about 22 on deliveries) | P9, P5 | claim once, cancellation, rollback, #1709 order; (b) after B1 |
| `coordinatorDeadTurn` (2), `coordinatorNeverStarted` (4), `coordinatorTurnAuthority` (12) | P5, P9 | advancement and held input |
| `accounts/migration/controller.test.ts` (10), `controllerSignal.test.ts` (2), `controller.performance.test.ts` | P9 controller | tick coalescing, pass cost |
| `account-migrations/[intentId]/action.test.ts` (2) | P21 | Stop and retry answers |
| `deliveryActuation.test.ts` (6) | P1, P9, P17 | per-conversation actuation ownership; `actingOperation` |
| `delivery.test.ts` (50), `deliveryInterrupt.test.ts` (5) | P17, interrupt control | legacy section order (`:783`); absorbing uncertainty; (a), (c) after A1/C2 |
| `reaperRuntime.test.ts` (54), `reaperRuntime.performance.test.ts` (2) | P22 | #652 convergence, no-progress stop (`:125`); (c) after C4 |
| `agent/failedSpawnDelivery.test.ts` (7) | P22, launch transactions | failed-spawn convergence (`:198`); (c) after C4 |
| `structuredSpawn.terminalize.test.ts` (16), `structuredSpawn.integration.test.ts` (80) | P24, P1 spawn | first message reservation; once |
| `monitor/seatTickSources.test.ts` (107, the wake settlement and withdrawal cases) | P23 | settle from journal, withdraw held wake |
| `telegram/bot/reportReplies.test.ts` (18) | P23 | reply withdrawal |
| `runtime-host/journal*.test.ts` | P8, P13, P14, P18 | operation-id dedup, `fromStatuses`, retry, retention; retry id pinned (A2) |

## What stays

The record store and its write-behind file; the wait vocabulary (no new
reason); the queue's lanes, pass budget, watchdog, `checking` steps and
record-based stall marks; per-conversation settlement and its off-loop
`settleProjection`; the late-acknowledgement promotion and mirror; `withWriter`
and the existing named off-loop methods; actuation sections; the native
executor's transitions and fences; the legacy absorbing reservation; every
at-most-once fence; the rendered stall line and its strings.

## What changes

| File | Change |
|---|---|
| `src/lib/agent/registry.ts` | `whenWriterHeld` public as `deliveryWrite` (C0); the two read-then-mutate methods split into a candidate read and a mutation |
| `src/lib/deliveryActuation.ts` | `lease.act(operationId)` and `actingOperation(conversationId)` (A1, observer rule) |
| `src/lib/runtime/deliveryProgress.ts` | `rearm` (A2); `backfillEnded` and the completeness mark (A3) |
| `src/lib/runtime/deliveryWaitReason.ts` | none |
| `src/lib/runtime/contracts.ts` | `terminalRetryOperationId` (A2) |
| `src/lib/runtime/structuredMessageDelivery.ts` | `recordWait` at every reservation write and the P1/P4/P7 steps (A1); acting operation declared; deputy exemption for the Codex continuation id; `payloadRefusal` shared with the drain and the `rejected` outcome (Note 2); reconcile-unreadable note and observer rule in `heldDrainProgress` (A5); C2 writes |
| `src/lib/accounts/migration/coordinator.ts` | lanes, pass budget, leased advancement permit, cleanups per lane, cancellation-refused-no-drain, `rejected` outcome, `HeldDeliveryPort.wait`, `heldDrainBusy` (B1, A5); C1 writes, commit and rollback included |
| `src/lib/accounts/migration/controllerSignal.ts` | `HELD_DRAIN_PASS_BUDGET_MS`, `ADVANCEMENT_LEASE_MS` |
| `src/lib/accounts/migration/controller.ts` | compaction off-loop |
| `src/lib/accounts/migration/deliveryPort.ts` | `wait` through `recordWait` |
| `src/lib/accounts/migration/conversationCommand.ts`, `src/app/api/account-migrations/[intentId]/action.ts`, `src/lib/pipelines/engine.ts` (`requestConversationReseat` only) | C2 writes and their refusals |
| `src/lib/runtime/structuredDeliveryController.ts` | A4 in `unlistedWakeDue`; A3 in the sweep timer; A7 in the watchdog guard; native `settled` off-loop and the native `note` port; C3 writes. Edits stay in these functions and the native executor's construction; lane bc8e99e8 edits host registration and publication |
| `src/lib/runtime/structuredDeliveryQueue.ts` | native notes: unreadable status, executor waits, acknowledged entry (A6) |
| `src/lib/runtime/nativeQueueExecutor.ts` | the `note` argument at its waits and before `prepared` (A6) |
| `src/lib/runtime/structuredReconfigure.ts` | claim and settle off-loop (C3) |
| `src/lib/runtime/startup.ts` | B2 in both continuation loops; P19(b) through `enqueueStructuredMessage`; retry row and record before the retry command (A2); superseded drain off-loop (C3) |
| `src/lib/runtime/sendSettlement.ts` | `restoreEndedRecords` beside `mirrorSettledReceipts` (A3) |
| `src/lib/runtime/http.ts` | retry route `rearm`; terminal retry row and record before the command (A2); discard writes; C2 writes |
| `src/lib/delivery.ts` | legacy records (A1); C2 writes |
| `src/lib/reaperRuntime.ts` | hygiene off-loop, `terminalizeStaleUndeliverableHeldDeliveries` async (C4) |
| `src/lib/monitor/seatTickSources.ts`, `src/lib/telegram/bot/reportReplies.ts`, `src/lib/runtime/structuredSpawn.ts` (`:399`, `:407` only) | C2 writes |

Registry read paths (lane c64e30e9) are untouched; `runtime-host/journal.ts` is
untouched.

## Build plan

Each step lands with its tests written first and seen red at `dc8769080`, in
the real seam (real `AgentRegistry`, real `RuntimeJournal`, the bound
controller where the path runs through it, the child-process lock holder from
`registry.writerWait.test.ts` for every (c) case). Order is chosen so each step
is reviewable on its own. Every writer-wait case asserts the same three things:
a 5 ms heartbeat on the loop that made the write never gaps past 50 ms while a
separate process holds `BEGIN IMMEDIATE` for 600 ms; the wait is sampled with
its label and operation id; after a refusal (lock held past 5 s) the original
fence converges on the next pass with at most one input.

1. **C0 + C1 + B1 (round-6 P1 #2 and P2; critique P1 #3, P2 #4 coordinator
   part, P2 #5).**
   - `coordinator.test.ts`: "a held drain that never answers on one
     conversation leaves another's delivered within the pass budget, a later
     pass serves that conversation again, and the late answer adds no input"
     (red: B never entered while A waits).
   - Same file: "a switching conversation whose provider never answers holds
     another switching conversation for at most one lease". Two idle
     conversations A and B, each with an active switch and an already held
     send; A's `create` held open, B's provider answering at once;
     `passBudgetMs` and the lease at 50 ms. B commits and its send is
     delivered within the lease plus B's own work while A's `create` is still
     pending; then A's `create` resolves late, and A publishes once, commits
     once and its send is delivered once (provider calls for A: one each).
     Red: B never advances while A's `create` is pending.
   - Same file: "advancements that end within the lease never overlap" (max
     concurrent `advance` = 1).
   - Same file: "repeated passes during an unanswered drain neither erase its
     stall nor mark progress, and its followers show their own wait". A's
     drain inside `deliver` with its record `dispatching` and stalled; three
     passes and three watchdog ticks; the acting record keeps `dispatching`,
     `stalledSince` and `lastProgressAt`; a second `assigned` send of A shows
     `conversation-busy`. Red: the acting record becomes `conversation-busy`
     with `stalledSince: null`.
   - Same file: "an orphan cancellation the lock refused leaves its
     conversation undrained for that pass".
   - New `coordinator.writerWait.test.ts`: the drain's claim and settle, a
     commit, a rollback and the intent completion, each waited off the loop
     and correlated; "a commit refused for the lock leaves the switch verifying
     and the next pass commits it once, carrying the held send once".
2. **A1 + C2 admission + Note 2 (round-6 P1 #1; critique P2 #7).**
   - `structuredDelivery.integration.test.ts`: "a lost admission
     acknowledgement keeps the original-key record from the reservation: its
     wait at once, its stall within ten seconds with the journal unavailable,
     its ending from the sweep, its correction from a late acknowledgement, one
     input". `client.command` runs `journal.executeOperation` then throws
     `RuntimeHostUnavailableError`. Red: no record, still none after
     `settleDueSends` at +11 min.
   - Same file: "a send behind an earlier admission on its conversation records
     conversation-busy then queued, and a journal admission that does not
     answer is a checking step that stalls and is never a lost wake".
   - `structuredMessageDelivery.test.ts`: "a dead-host resume that throws
     leaves the accepted send recorded as awaiting-host with its deadline". Red:
     no record.
   - `structuredMessageDelivery.sqlite.test.ts`: "an image reserved before a
     dead host recovers, whose rejection the lock refused, ends with the
     payload's rejection and reaches no host". A 67-byte image reserved; the
     recovered host advertises image support with a one-byte encoded limit; the
     terminalize write is refused (child holds the lock); then the lock clears
     and the drain runs. The reservation ends `failed` with "runtime image
     request encoding is too large", disposition `lost`; `client.command` is
     never called. Red: delivered with one command.
   - Same file: "a rejected admission's settle and a refused requeue wait off
     the loop and leave the reservation for a later pass".
3. **Startup continuations (critique P1 #1).** `startup.test.ts`, on the
   retained-continuation fixture (`:888`):
   - "a continuation whose admission reply is lost is recorded at once, stalls
     within the bound, recovers under its original key and reaches the host
     once". The journal executes the admission, the reply is lost, status and
     effect reads stay unavailable for a while. The original key's record exists
     immediately with `evidence-unreadable`, is stalled within the stall bound,
     has its deadline; after reads return, the next startup pass finds the
     operation and the queue delivers it; one input in the ledger. Red: no
     record, no reservation.
   - "one host's unanswered continuation admission holds no other host's":
     two adopted Codex hosts, A's `client.command` never answers; B's
     continuation is reserved, recorded and admitted while A's is pending.
     Red: B is never admitted while A waits.
   - "a continuation retry has its row and record before the retry command,
     and a lost retry reply converges on the same leaf once".
   - Same for `deliverInterruptionContinuations` with two obligations.
4. **A2 (P13, P14) and the routes (critique P2 #4 route part).**
   `sendSettlement.test.ts`: "an unknown-fate retry reopens the operation's
   ended record, counts the attempt, and reaches the host once"; "a terminal
   retry has its row and record before the retry command, so a lost reply with
   a failing listing still leaves both". `runtime-host/journal.test.ts`: "the
   terminal retry id is the one the Viewer computes". `http.test.ts` with the
   lock holder: "a discard whose registry write is refused answers retryable,
   keeps the loop responsive, and the sweep ends the send discarded once the
   lock clears"; `action.test.ts`: "a Stop refused for the lock changes nothing
   and a repeated Stop cancels the held sends once"; cancel, rollback and retry
   commands the same way in their tests.
5. **Native and legacy (critique P1 #2).** `nativeQueueRuntime.test.ts`, on the
   ordinary-queue-send fixture (`:327`): "a native entry's record shows the
   switch it follows, the successor it waits for and an unreadable health,
   then awaiting-turn once acknowledged and delivered on proof; its settlement
   waits for the lock off the loop and a refused settle is ended by the sweep;
   the entry is added once". Red: the record stays `queued` throughout; the
   settle blocks the loop. `delivery.test.ts`, on the section fixture (`:783`):
   "a legacy send is recorded from its reservation, dispatching while the pane
   actuation hangs, and its hold, claim and settle wait off the loop". Red: no
   record; synchronous waits.
6. **A3, A4, A7, C3 (critique P2 #6, #8).**
   - `structuredDelivery.integration.test.ts`: "a held send whose drain lane is
     still inside its delivery is never called a lost wake and shows its stall";
     "a send held behind a switch that fails says switch-failed at its next
     overdue wake"; "a reservation whose record was owed at a crash gets it back
     from the next sweep, dated from its admission".
   - `deliveryProgress.test.ts` with a real registry: "an ending owed at a crash
     is restored by the next sweep with its original key and terminal state,
     and nothing is sent". Four cases: delivered, rejected, discarded, and a
     retry leaf's ending; each reserves, ends, drops the store without a flush,
     then a fresh store and one sweep. A fifth case: the inventory sidecar's
     registry ends the send while the Viewer's file is held busy, then the
     Viewer restarts. Red: `progress.get` is null after the sweep.
   - `structuredDeliveryRebind.test.ts`, extending `:203`: startup kept pending
     past the stall and safety bounds (`stallMs` 20, watchdog 5 ms, no manual
     kick); the admitted send on the registered conversation, left `checking`
     with its evidence unreadable, is marked stalled and recovers once; the
     unregistered host's send shows `startup` and receives no input until
     startup completes. Red: no stall until
     `completeStructuredDeliveryQueueStartup`.
   - Same file: "startup projection waits for the lock off the loop and leaves
     refused outcomes owed to the journal".
7. **C4 and the remaining C2/C3 rows.** `reaperRuntime.test.ts` (`:125`),
   `failedSpawnDelivery.test.ts` (`:198`), `seatTickSources.test.ts`,
   `reportReplies.test.ts`, `structuredReconfigure.test.ts`,
   `structuredSpawn.terminalize.test.ts`: one writer-wait case each, through
   the shared lock-holder helper; the hygiene cases measure the heartbeat of
   the process that runs them, as the sidecar would.
8. **Rendered evidence.** In `conversationWindow.browser.test.tsx`, the
   existing case "a stalled hand-over says so on its message" takes the reason
   as a parameter and adds `evidence-unreadable` (what P7 and P19 show) and
   `awaiting-turn` (an acknowledged native entry) beside `dispatching`, at 390
   and 1440, en and uk. No new driver.

Gates for the build: touched tests by path, one file per process, with a
private `HOME`, `TMPDIR` and `LLV_STATE_DIR` under the OS temp root and
`LLV_VIEWER_CONTROL_URL` on a closed port; never a sweep of `src/lib/agent` or
`src/app/api/runtime`. `tsc`, changed-file `eslint`, the conversation browser
case above, the local privacy gate from the merge base. Merge `origin/main`
before the push. `coordinator.test.ts`, `startup.test.ts` and
`controller.performance.test.ts` run in full because B1 and B2 change when a
pass returns.

## Options considered

**(a)** *Per-site recording*, today's approach: each review found the next
site, so it is the cause of six rounds. *A registry observer* that opens the
record inside `holdDelivery`: one place, but it couples the registry to a store
only the Viewer owns, and it fires in every process that writes the registry.
*Chosen*: one writer called at the reservation writes, plus the sweep backstop
over the durable rows that already exist. *Write-through records* (a
synchronous store write at admission): would close the 20 ms crash window and
put a SQLite wait back on the admission path, the thing (c) removes; A3 closes
the window within 15 s for open and ended sends alike.

*Startup continuation (P19b)*: *a record before the direct journal command*
gives the moment but no owner: nothing would end a continuation the journal
never received once the turn stopped needing it, and its record would stay open
until pruned. *Chosen*: the same admission as the #1835 continuation beside it,
which gives the reservation, the owner row, the deadline and the record.

*Ending restoration (A3 step 3)*: *every ended owner row within the record
retention* would backfill fourteen days of history on first deployment and
re-check thousands of rows after every restart. *Only the last settlement
window* would miss a crash followed by a long outage. *Chosen*: the
completeness mark, which checks exactly what the file may be missing.

**(b)** *Lanes for the drain calls only*, advancement left in the loop: an
uncertain reconcile has to finish before its conversation advances, so the loop
would have to await it again. *Fully concurrent advancement*: an engine-wide
switch would start every successor's Codex app-servers and hosts at once
(`provider.ts:1448`, `:1496`), a memory risk on a host that has had
out-of-memory stops. *A plain serial section*: one hung provider call holds
every other conversation's switch and sends (the critique's P1). *A bounded
pool of N*: N hung calls do the same. *Chosen*: one permit with a lease, which
keeps today's one-at-a-time when providers answer and bounds a hang's cost to
one lease per conversation.

**(c)** *Named `…OffLoop` wrapper per method*: about thirty more wrappers for
one pattern. *Registry writes on a worker thread*: removes the wait from the
loop for every caller, at the cost of a second registry connection model;
heavier than the problem. *Making the synchronous `mutate` refuse at once*:
every one of its hundreds of callers would need a refusal it does not have.
*Chosen*: the existing acquisition, public, called with the method, and a
stated refusal per site.

No ADR: every choice here is reversible within the module that owns it.

## Validation against the requirement

"Original-key delivery delays traced": every accepted send, on every path in
the table including the native, legacy and startup ones, has its original-key
record from the reservation on, written before any command that could accept
it leaves the process, with a reason from one vocabulary at each step; an
observer never rewrites the step an actor is in; the sweep restores an open or
ended record a crash or the sidecar left missing. "Bounded visible recovery":
each drain gives a conversation at most its pass budget before the next
conversation is served, shared advancement holds a conversation for at most
one lease per conversation ahead of it, startup admits continuations side by
side, every wait is bounded by its own deadline, a stall shows on the resting
message within ten seconds even while startup is pending, and the settlement
deadline ends what nothing else ended. "Without duplicate sends": the fences
are untouched, every refused write leaves its reservation where those fences
still apply, and a refused rejection is enforced again before the drain's
command. The board task's own goal ("з'ясовано, чому затримувалась доставка")
is answered by the record plus the correlated lock waits; the CPU-isolation and
orphan-process parts of 7a677014 belong to lanes b49993f7 and b3a827ad.

## Deferred — not currently justified

- **Advancement without a permit.** The lease already bounds what one hang
  costs; removing the permit would trade that for a burst of successor
  processes. Revisit if a record shows `switching-accounts` stalled for more
  than a few leases behind unrelated switches.
- **Reserving before a forced switch** (`structuredMessageDelivery.ts:1246`–`:1279`).
  An idle-host send forces a pending switch before it reserves, so that wait is
  pre-acceptance and the composer shows `transmitting`. Moving the reservation
  first would change the #1028 ordering contract. Revisit if a receipt shows
  admission waiting on a forced switch.
- **Launch-failure transactions** (`failSpawn`, `failStructuredSpawn` and the
  rest of the spawn executors' registry writes, about thirty call sites). Their
  delivery effect is to end a never-attempted first message as `lost`, inside a
  launch transaction on a path that writes the registry synchronously
  throughout; converting that one write would not take the spawn path off the
  loop. The failed-spawn convergence (C4, off-loop) reaches the same rows, and
  the first message's own admission, drain and settlement are covered (P1,
  P24).
- **Account retirement** (`retireAccount`, `accounts/removal.ts:758`, `:834`).
  An operator-confirmed removal that ends the retired account's held sends in
  the same transaction as the account change; rare, and a removal of its own.
- **Progress records written by the inventory sidecar.** It owns no store; A3
  and the queue record what it drains.
- **Pre-acceptance waits** (the account mutation lock and the image admission
  lock in `admitDurably`): nothing is accepted yet, so the three rules do not
  apply; the composer's own row covers them.

## Notes

- B1 changes when `reconcileMigrations` returns, and B2 when startup's
  continuation step returns: a test that awaits either and then asserts on work
  that takes longer than the budget would need to wait for the lane. Tests with
  immediate ports are unaffected.
- `evidence-unreadable`'s comment in `deliveryWaitReason.ts` says "nothing was
  sent". For P7 and P19 that holds for the agent: the journal may hold the
  operation, and the queue's next note replaces the reason as soon as it lists
  it.
- A record an in-request step left without a next wake (the Viewer died
  mid-request) keeps its stall mark and its deadline; the restarted Viewer's
  first migration pass drains the reservation and writes the record again.
- The inventory sidecar drains held deliveries every 60 s in its own process,
  with its own actuation sections, lanes and permit. The registry claim keeps
  it and the Viewer from actuating one reservation twice, and the migration
  revision keeps them from advancing one switch twice. That is existing
  behavior; the design relies on it and does not change it.
- A continuation retry whose original was admitted by code older than this
  design has no owner row to relate to; its record is opened, and it has no
  settlement deadline. That shape exists only for continuations admitted
  before the build lands.
- Critique premise correction: the hygiene sites named by the critique run in
  the inventory sidecar, so their contention blocks the sidecar's loop. They
  are in C4 all the same, with the acceptance measured in the process that
  runs them.
