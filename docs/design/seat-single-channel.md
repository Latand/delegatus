# Revoked orchestrators accept nothing: one channel to the current seat

## Originating requirement

The operator, 2026-10-16 12:25 UTC, dictated in the comment of the decision form
«Відповіді на форми йдуть до старого оркестратора» (a seat-published round), and
pinned to this lane verbatim (excerpt; the rest of the comment is the MCP hash
audit, lane d1bbb135):

> «відповіді йдуть до старого оркестратора, значит, нам нужно сделать так, что
> старый оркестратор вообще недоступен, и вообще старый оркестраторы вообще
> недоступны для взаимодействия, потому что это сильно мешает работе, и нужно
> сделать так, что если через Viewer кто-то пытается им что-то отправить, они не
> должны никак быть, э-э, добавлены, и вообще должен быть какой-то один общий
> канал, который ведёт к оркестратору, и. То есть оттуда только выбирается
> текущий оркестратор, и никакой больше, то есть они напрямую не должны
> общаться с оркестратором»

In English: answers go to the old orchestrator. Old orchestrators must be
entirely unavailable for interaction, because this badly gets in the way of
work. If anyone tries to send them something through the Viewer, it must not be
added at all. There must be one common channel that leads to the orchestrator.
Only the current orchestrator is chosen from it, never another one. Nobody
talks to an orchestrator conversation directly.

The answer on the same form: a lane now, a builder, two review rounds.

The pinned outcome restates this as four acceptance points. Every delivery meant
for a project's orchestrator resolves its target at delivery time to the
current seat. A revoked seat accepts nothing. Its history stays readable. Tests
reproduce the 2026-10-16 case and the direct-send refusal, red on main and green
after.

Every `file:line` below is at `02f9301fc`. That was main when this stage
started, and production has run that build since 11:28:45 UTC on 2026-10-16
(deployment ledger). Main has since moved one commit, to `18096e8f2` (#2966,
mandate text only), which touches none of the files cited here. This stage
wrote nothing but this document.

## Decision in one paragraph

Every path converges on one place: the moment the delivery queue hands a
message to an engine. The single routing point therefore lives in that one
place, and producers do not each carry a copy. One verdict, already used
since #2952 at admission, decides whether a conversation is a revoked seat.
That verdict is now also asked at dispatch, on held and legacy deliveries, and
before any host recovery. A revoked seat's conversation receives no message
from any path, whoever captured its id and whenever. When a seat is revoked,
one rotation pass withdraws every message still queued for it. It does this in
the same journal transition the seat tick and the Telegram replies already use
to take back a wake. It then sorts each withdrawn message by one rule. A
message that meant "the orchestrator" goes to the seat that is current now,
with a one-line note that it was sent before the rotation. A message tied to
the old seat's epoch is dropped, and its failed receipt is the record. Four
producers already re-send on their own when their message fails: form
answers, Telegram replies, voice directives and spawn notices. Each of them
follows the new seat with a small change. A direct send naming a revoked
conversation id is refused with an error naming the current seat. A send
addressed by project (the relay route) is re-routed. Reading a revoked seat
stays untouched, because no read path passes the delivery fence. This reverses
one rule #2952 kept on purpose: "already admitted operations keep their
identity". Two of its tests flip.

## 1. Prior work

- **#2952 (merged 2026-10-16 01:08 UTC), defect D4.** It added
  `orchestratorRecipientRefusal` (`src/lib/orchestrator/seats.ts:1433-1501`).
  That check refuses fresh sends (`src/lib/runtime/structuredMessageDelivery.ts:1365-1399`)
  and explicit retries (`src/lib/runtime/http.ts:821-842`) to a revoked seat.
  The answer is a 409 naming the successor. Its diagnosis brief (pipeline
  56e521fe, 2026-10-15) asked to "keep already-bound operations and
  unknown-delivery fences". So admission is checked and dispatch is not. The
  comment at `seats.ts:1431-1432` states the rule, and two tests pin it
  (§6, test 3). This design builds on the same index and reverses only that carve-out.
- **#2957 (merged 2026-10-16 11:03 UTC)** fenced form-answer recovery across
  seat succession (`src/lib/prototypeReview/decision.ts:349-362`). It also
  carries saved answers into seat wakes. Its succession step fires only when the
  old operation is proven failed. A message still queued at the old seat stays
  there. §2 shows that this is exactly what happened.
- **The seat tick already does redirect-or-drop for its own wakes.** On
  replacement it withdraws a retained wake (`src/lib/monitor/seatTickController.ts:1053-1067`
  via `withdrawRuntimeWake`, `src/lib/monitor/seatTickSources.ts:453-473`). The
  successor's next check then raises its own wake.
- **Telegram report replies already follow the seat.** On rotation they
  withdraw the in-flight reply and re-send it to the current seat
  (`src/lib/telegram/bot/reportReplies.ts:144-150`).
- **The voice companion retargets** a delegation whose seat changed before
  admission (`src/lib/voiceCompanion/admission.ts:457-459`, `:497-511`). It does
  nothing after admission.
- **Spawn notices** resolve a retired launcher seat to the current seat for new
  attempts (`src/lib/spawnNotice/production.ts:62-94`). An attempt already
  handed over is "finished first, exactly as it was written"
  (`src/lib/spawnNotice/sweep.ts:243-247`).
- **#383 supersedence** gives a retired round a successor banner and a disabled
  composer (`src/components/agentCapabilities.ts:431-446`). A seat rotation does
  not set `supersededBy`, by design: "Rotation is authority-only"
  (`seats.ts:1374-1379`). This design keeps that and does not borrow the
  supersedence edge (see Deferred).
- Searches: `search_transcripts` in five phrasings, project-scoped then
  unscoped, in English and Ukrainian ("revoked seat queued delivery rotation
  redirect", "один канал оркестратор відкликаний"…). `search_memory`: "orchestrator
  rotation queued messages old seat". Nothing found beyond #2952's lane and
  this one. No earlier design of a single seat channel exists.

## 2. What happened on 2026-10-16, from the records

Sources: the seat designation store (revocations), the delivery-progress
journal (one row per operation, phases with times), the revoked seat's own
transcript (read with `conversation_messages`), and the deployment ledger. Ids
are shortened to eight characters.

| UTC | Record | What it shows |
| --- | --- | --- |
| 10-15 20:33:49 | seats: epoch 67, seat `f8395a87` activated | the seat that published most of the rounds |
| 10-16 11:28:45 | deployment `02f9301f` succeeded | production carries #2952 and #2957 |
| 11:53:15–11:54:18 | 11 `prototype-decision:*` operations, ingress | answers saved or retried from the Decisions panel; a round's delivery `startedAt` (11:53:55–12:03:24 on five rounds) is written only by an explicit Retry |
| 11:54:51–12:05:02 | same operations: `conversation-busy`, `queued`, `awaiting-turn`; two delivered while `f8395a87` was still the seat (12:00:55, 12:03:11); nine `failed` at 12:04:59–12:05:02 "accepted for delivery but never executed; … fenced" | the seat was mid-turn throughout |
| 12:05:04 | voice directive `voice-5ab74f41`, ingress (the operator by voice: «Проведи ротацию оркестратора») | admitted to `f8395a87` at 12:05:06, the seat then |
| 12:05:06–12:05:21 | nine `retry_*` operations admitted to `f8395a87` | all passed #2952's admission check: `f8395a87` was still the seat |
| **12:06:32** | **seats: `f8395a87` revoked (epoch 67), successor `efb4e487`, triggered by the operator** | the rotation |
| 12:06:02 → 12:13:33 | the nine `retry_*` operations: `awaiting-turn` from 12:06:02, then `dispatching` one per turn at 12:06:55, 12:07:11, 12:07:47, 12:08:06, 12:11:08, 12:12:20, 12:13:08, 12:13:21, 12:13:33 | **every one dispatched to the revoked seat after its revocation** |
| 12:08:39–12:10:53 | the revoked seat creates two tasks, tries two `create_pipeline` (refused: revoked) and one `send_message_to_orchestrator` (refused) | it acted on a 10-14 answer delivered at 12:08:06 |
| 12:14:48 | the voice directive dispatched to `f8395a87` | 9 min 42 s after admission, 8 min 16 s after revocation |
| 12:15:08–12:15:29 | the revoked seat calls `rotate_orchestrator`; seats: `efb4e487` revoked (epoch 75), successor `e0b8b4b1`, triggered by agent `f8395a87` | a stale instruction to a revoked seat ended a 9-minute-old successor |
| 12:18:38 | `e0b8b4b1` files the defect from the handoff notes; 12:25:01 the operator answers the form | the originating requirement |

The five rounds the seat named are voice (`pr_1108f757`), keys (`pr_5fd8a870`,
a task round), pre-push hook (`pr_8ce0aad0`), deploy timing (`pr_417a48cf`)
and git init (`pr_199242c2`, a task round). The journal shows four more answers
in the same wave reaching the revoked seat: `pr_a40b8397`, `pr_6bfcdda2`,
`pr_3156c8ec`, `pr_8c6d0e23`. It also shows the voice directive. The receipts
of two of them (read with `message_receipt`) confirm the shape:
`retry_21515b15` was admitted 12:05:20.839, waited `awaiting-turn` from
12:06:02.314, and dispatched 12:13:08.384. `retry_63412e20` was admitted
12:05:21.733 and dispatched 12:13:33.797.

**Cause.** The check happens at admission and never at dispatch. A message
admitted while seat N is current waits in the Viewer's queue behind N's running
turn (`awaiting-turn`, `src/lib/runtime/structuredDeliveryQueue.ts:1983-1991`).
When that turn ends, the queue hands it to N's engine. The queue's
per-effect cut-off asks `conversationRetired`
(`structuredDeliveryQueue.ts:1689-1694` and `:2153-2157`). That is wired only
to a pipeline runtime-switch fence (`src/lib/runtime/structuredDeliveryController.ts:980`,
`src/lib/pipelines/runtimeSwitchFence.ts:69-80`). Seat revocation is not part
of it. The form-answer worker could not help either. It polls every 3 s
(`src/lib/prototypeReview/deliveryWorker.ts:31`), reads `pending`, and follows
a new seat only on `failed` (`decision.ts:349`).

Live confirmation that fresh direct sends are already refused on main:
`conversation_deliverability` for `f8395a87` answers `superseded` with "orchestrator
seat was rotated; send to conversation_e0b8b4b1-…" (read during this stage, 2026-10-16).

## 3. Every path that delivers to a seat today

"Chooses" names the line where the recipient conversation is decided. "Late"
means it is read from the designation store when that line runs. "Early" means
a conversation id captured before and kept. The last two columns give what a
message still queued at rotation does on main, and what this design does.

| # | Producer | Chooses the seat | When | Queued at rotation, main | Design |
| --- | --- | --- | --- | --- | --- |
| 1 | Form answers, first send | `decision.ts:286` (`world.orchestrator`, `src/lib/prototypeReview/world.ts:42-45`), persisted at `:295` | early (at decision); re-read at `:341`, `:348`, `:372` only while never handed over | delivered to the old seat | owner follows (§4.4) |
| 2 | Form answers, redelivery and Retry | `decision.ts:152-157` (`handleRuntimeRetry` on the old operation's conversation); follows succession at `:349-362` only on `failed` | early | **delivered to the revoked seat (the incident)** | withdrawn at rotation; owner follows |
| 3 | Form answers carried in seat wakes (#2957) | seat tick agenda, `seatTickController.ts:1548-1550` | late | seat tick withdraws and re-raises | unchanged |
| 4 | Seat-tick wakes | `seatTickController.ts:1548-1550`; the outstanding wake is bound to `{conversationId, seatEpoch}` | late, epoch-bound | withdrawn (`:1053-1067`); successor raises its own | unchanged; fence backstops |
| 5 | Worker asks, lane events, child terminals | seat tick agenda (`seatTickSources.ts:709-715`, `src/lib/attention/routeOverlay.ts:80`) | late | as 4 | unchanged |
| 6 | Spawn-completion notices ("Agent finished") | `spawnNotice/production.ts:62-94` (retired seat → current, at attempt creation); retried as written at `sweep.ts:243-247` | late for a new attempt, early after | delivered to the old seat | withdrawn; owner re-attempts to the current seat |
| 7 | Voice companion directives | `voiceCompanion/deliveryPaths.ts:13-20` at proposal (`admission.ts:407`); retargets before admission (`:457`, `:497-511`) | early after admission | **delivered to the revoked seat (12:14:48)** | withdrawn; owner retargets with a note |
| 8 | `bridge_directive` (voice gateway over MCP) | `src/lib/mcp/bindings.ts:4030`, posted at `:4074` | late at call | delivered to the old seat | withdrawn; redirected by the channel |
| 9 | `send_message_to_orchestrator`, owner relay, gateway relay | MCP binding freezes the seat at `bindings.ts:7395`, used at `:5268`; HTTP `src/app/api/orchestrator/message/route.ts:54-70` → `src/lib/orchestrator/relay.ts:147`; a non-current recipient is refused at `relay.ts:153-166` | early at bind, re-checked at admission | delivered to the old seat | fresh: re-routed to the current seat; queued: redirected by the channel |
| 10 | Linked-machine seat messages | `src/lib/links/seatMessageDelivery.ts:23-37` → `resolveOrchestratorRelay(project, undefined, …)` | late at admission | delivered to the old seat | redirected by the channel |
| 11 | Operator composer in the seat panel or any transcript view | the conversation id the browser holds; `src/app/api/conversation-host/handlers.ts` → `enqueueStructuredMessage` (`structuredMessageDelivery.ts:1340`) | early (client) | delivered to the old seat; a fresh send is refused (#2952) | queued: redirected; fresh to a revoked id: refused, naming the current seat |
| 12 | Direct `send_message` from any agent to a seat id | caller-supplied id → `/api/tmux` → same ingress | early (caller) | delivered to the old seat; fresh refused (#2952) | queued: redirected; fresh: refused, naming the current seat |
| 13 | Telegram replies to seat reports | `reportReplies.ts:51-55` | late; follows on rotation (`:144-150`) | withdrawn and re-sent | unchanged (owner) |
| 14 | Deputy (ask-in-parallel) result notes | `deputySweep.ts:108-118` (`seatConversationId` at deputy birth), sent at `:373-377` | early, epoch-bound (rotation kills deputies) | delivered to the old seat | dropped with record |
| 15 | Board-maintenance report for a new seat | `boardReportRun.ts:59-70`, keyed per seat epoch | epoch-bound | delivered to the old seat | dropped with record |
| 16 | Auto-rotation nudge | `src/lib/monitor/seatAutoRotation.ts:235-238`, keyed per seat epoch | epoch-bound | delivered | dropped with record |
| 17 | Rotation mandate to the successor | `src/lib/orchestrator/seatCommand.ts:294-320` | the new seat by construction | n/a | unchanged |
| 18 | Restart continuations of a cut seat turn | `src/lib/runtime/startup.ts:323`, `:368`, `:408`, `:832` (seat-epoch fences) | epoch-bound, already fenced | dropped | unchanged |
| 19 | Task send to assignees | `src/app/api/tasks/[id]/send/route.ts:142` | early (assignment) | delivered | fence refuses a revoked seat |
| 20 | Held deliveries (account switch, runtime sync) | `structuredMessageDelivery.ts:1113`; host recovery at `:1198-1225` behind `authorityFence` (`:1136`, deputy-only) | early (held row) | **a dead revoked seat's host is resumed to drain it** (test at `structuredMessageDelivery.test.ts:5068`) | no recovery; withdrawn; class rule |
| 21 | Legacy (non-structured) delivery | `src/lib/delivery.ts:771`; only `supersededRejection` at `:86-99` | early | delivered | fence added |

Reads that must keep working and pass no delivery gate are listed in §4.7.

## 4. Design

### 4.1 The seat channel: one module

A new module, `src/lib/orchestrator/seatChannel.ts`, is the only place that
answers two questions:

1. **Who is the orchestrator of project P now?** `currentSeat(project)` returns
   the active seat of the canonical project from the designation store (state
   `active`, conversation id set), or `null` while none is active. Producers that
   this design touches read the seat through it: the form-answer world, the
   voice companion recipient, the spawn-notice recipient, the relay fallback and
   the Telegram reply port. It reads the same store `orchestratorSeatFor`
   reads, so the answer does not change. What changes is that there is one name
   for "the current seat".
2. **May this conversation receive a message?** `seatRecipientVerdict(ids,
   resolveAlias)` and its async twin wrap the existing
   `orchestratorRecipientRefusal(Async)` (`seats.ts:1433-1466`). They answer
   `open`, `revoked { project, successor, revokedAt }` or `unknown` (store
   unreadable or index not ready). The index, its epochs, its ABA rule
   ("re-designation mints a strictly newer epoch that lifts it",
   `seats.ts:1366-1372`) and its alias handling stay exactly as #2952 wrote them.

It also owns the rotation pass (§4.3), the disposition table (§4.4) and a small
redirect record (§4.6).

### 4.2 The verdict is asked wherever a message can still leave

| Gate | Today | Change |
| --- | --- | --- |
| Fresh send admission (`structuredMessageDelivery.ts:1365-1399`) | refuses a revoked seat, except a key already admitted to it (`boundRecipient`, `:1375-1377`) | keeps the refusal. A bound key to a revoked seat no longer re-commands its operation. It answers the operation's settled receipt (after the rotation pass, `failed`, or the redirect's receipt). |
| Explicit retry (`http.ts:821-842`) | refuses | unchanged |
| **Dispatch** (`structuredDeliveryQueue.ts:1689-1694` per effect; `:2153-2157` at the engine call; `:1554` native Codex queue adds) | asks `conversationRetired` (pipeline switch only) | the controller (`structuredDeliveryController.ts:973-980`) adds the seat verdict. `revoked` fails the effect with the new reason `SEND_SEAT_REVOKED_REASON` (proven unexecuted: nothing reached the engine). `unknown` holds it. At the drain it notes `evidence-unreadable` ("orchestrator seat authority is not readable") and retries soon. At the engine call it throws a new `StructuredDispatchDeferredError`, which `settleSendOutcome` (`:2215-2233`) puts back to `queued` the way it already handles `steer-refused`. Control effects (stop, kill, compact, answer, reconfigure) are not messages and stay exempt, as they are from `conversationRetired` today, so a revoked seat can still be stopped. |
| Held-delivery drain (`structuredMessageDelivery.ts:1136`, `:1198-1225`) | deputy fence only; resumes a dead host | `authorityFence` also asks the verdict before and after every wait. A revoked seat's host is never recovered; the held row is withdrawn (§4.3). |
| Legacy delivery (`delivery.ts:771`) | `supersededRejection` only | asks the verdict next to it and refuses with the same 409 body. |

Cost: the sync verdict is one `stat` of the designation file plus one `Map`
lookup on an index that `writeSeatFile` (`seats.ts:613-634`) updates in the same
process. The update is synchronous when the previous index is warm; otherwise
the index is rebuilt in the background, and until then `unknown` holds the
message for a moment. The rotation lands in the Viewer, so the dispatch check
normally sees it at once. `unknown` is reached only on a cold index or an
outside write. It already runs once per admission since #2952; this
adds it once per dispatch. No speed claim is made. The candidate performance gate
(`src/runtime-host/candidatePerformanceRun.ts:573` loads this controller) still
runs at promotion.

### 4.3 The rotation pass

`writeSeatFile` (`seats.ts:613-634`) is the single writer of the designation
file. After a write that appends revocations (activation `:1040`, stillborn
rollback `:1229`), or that makes a project's seat active, it schedules
`seatChannel.reconcile(newRevocations)` with `setImmediate`. Listeners are held
on `globalThis`, because compiled bundles duplicate module state. At Viewer
start the channel runs the same pass once for revocations of the last 24 hours,
so a revocation written while the Viewer was down is processed. The pass runs
only in the release that owns traffic (`viewerReleaseOwnsTraffic()`, as the
form-answer worker does).

For each revoked conversation, under `withViewerOperation("orchestrator.seat-channel")`
and the async state admission helper:

1. List its open deliveries through keyed lookups only. Operation owners use
   `registryRowsMatching(snapshot, "deliveryOperationOwners", "conversationId", ids)`,
   as `startup.ts:871` already does. Held rows use the same lookup on
   `heldDeliveries`. There is no whole-store read. The work is bounded by that
   one conversation's open messages, a handful.
2. Withdraw each one with the transitions that already exist:
   `withdrawRuntimeWake` for a journal operation (`queued`/`pending` → `failed`
   with `SEND_SEAT_REVOKED_REASON`; anything in an executor's hands answers
   `too-late`), and `withdrawHeldDelivery` for a held row. The helper moves from
   `seatTickSources.ts` into `seatChannel.ts`; the seat tick imports it from
   there. A Codex seat whose message was already added to its engine-side queue
   gets the native queue's existing `delete` command first. The builder confirms
   that path on a Codex seat (§6, test 9).
3. Apply the disposition rule (§4.4) to every operation whose failure carries
   `SEND_SEAT_REVOKED_REASON`: the ones this pass withdrew, and the ones the
   dispatch gate refused. An operation that had already failed for another
   reason before the rotation is left to its sender, so nothing it may already
   have re-sent is sent twice.
4. `too-late` means the operation was already in an executor's hands. The pass
   re-reads it once it settles. If the engine-call check of §4.2 refused it, it
   carries `SEND_SEAT_REVOKED_REASON` and step 3 applies. If it was delivered,
   dispatch began before the revocation committed, so the message reached N
   while N was the seat; the pass records that and re-sends nothing. `unknown`
   keeps the row open for the next pass. The pass is idempotent: withdrawing an
   operation that already failed answers `withdrawn`, and redirect keys are
   deterministic.

The dispatch gate of §4.2 is the guarantee. The pass is what moves things
promptly, without waiting for the old seat's turn to end (7 minutes on
2026-10-16).

### 4.4 The redirect-or-drop rule

One function, `seatDeliveryDisposition(operation)`, classifies by the
operation's client key namespace. The owner modules mint these keys, and the
classifier imports their builders, never string copies.

| Class | Keys (builder) | At rotation | Why |
| --- | --- | --- | --- |
| **Owner follows** | `prototype-decision:*` (`decision.ts:187`), Telegram reply ids (`bridgeDirectiveId` with a `telegram_` root, `reportReplies.ts:120`; a `bridge_directive` id has a turn root and stays in the channel class), `voice-*` (voice companion), spawn-notice ids (`spawnNoticeMessageId`, `sweep.ts:85`) | withdrawn; the owner sees `failed`, resend safe, and follows `currentSeat` | each already has a durable record and a retry loop; a second mover would deliver twice |
| **Epoch-bound: dropped with a record** | `seat-tick:*`, `board_report_*`, `seat-autorotate-nudge-*`, `deputy_note_*`, interruption continuations (`isInterruptionObligationId`, `isInterruptedCodexContinuationId`), rotation mandate keys | withdrawn; nothing is re-sent; the failed receipt (reason `SEND_SEAT_REVOKED_REASON`) is the record | the content is about that seat's epoch; the successor gets its own wake, report, mandate or handoff |
| **Channel: redirected** | everything else: composer messages, `send_message`, relays (`mcp_orchestrator_*`), `bridge_directive` ids, linked-seat messages | withdrawn, then re-admitted to `currentSeat(project)` (§4.5) | the sender meant "the orchestrator", which is the operator's rule |

New producers default to the channel class. A message is then never lost at a
rotation, and an epoch-bound producer that forgets to register is at worst
re-sent once with the redirect note. The reverse default would silently drop
operator words. A table test pins every builder (§6, test 10).

Owner changes, each small:

- **Form answers** (`decision.ts:349`). Also act when the recovered state is
  `pending` and the seat changed: call the existing `retire` (`:129-146`,
  `pending`/`queued` → `failed`). On `failed` it falls into the existing
  succession at `:354-361`, keeps the same message key and text, and sends to
  the current seat. With the rotation pass, the operation is already failed by
  the time the worker looks, so this is belt and braces for a pass that has not
  run yet.
- **Voice companion** (`admission.ts:492-511`). After admission, a delivery that
  fails because its seat was revoked (`SEND_SEAT_REVOKED_REASON` on the journal
  receipt, read through `receipt()` in `deliveryPaths.ts:24-28`) takes the
  existing `delegation.retargeted` branch. The text then starts with the redirect
  note of §4.5. On 2026-10-16 that note is what would have told seat
  `efb4e487` that «Проведи ротацию оркестратора» was spoken at 12:05:04, before
  the rotation at 12:06:32 that already fulfilled it.
- **Spawn notices** (`sweep.ts:243-247`). An attempt whose operation failed
  with `SEND_SEAT_REVOKED_REASON` is cleared and never retried as written. The next
  pass composes a fresh attempt through `spawnNoticeRecipient`, which already
  maps a retired launcher to the current seat.
- **Telegram replies**: no behaviour change; `seat` reads `currentSeat`.

### 4.5 Redirect and direct sends

**Redirect admission.** The channel re-admits the withdrawn message with
`enqueueStructuredMessage` in-process. It keeps the original origin (author
attribution, including a member author stamped under the new key), the images
and the policy `steer-or-queue`. The key is
`seat-redirect:<first 40 hex of sha256(original operationId)>`, deterministic and
under the 128-character key limit. The text gains one leading line for the
receiving agent:

> `[Delegatus] Redirected to you, the current orchestrator: sent to the previous orchestrator at HH:MM UTC, which was replaced at HH:MM UTC before this reached it. Check it is still needed before acting.`

This line is agent-facing. It is the only added text, and it appears only on
redirected messages. 2026-10-16 is the reason: a stale "rotate the
orchestrator" was acted on and cost a fresh seat. With no current seat (a
project left without one), the record waits as `awaiting-seat`. The next
activation in that project runs the pass again. After 24 hours the record
becomes `dropped`.

**Direct sends to a revoked id stay refused.** This covers the composer on a
previous seat's transcript, `send_message` from any agent, and a task send. An
id names that exact transcript, and the operator asked that old seats take
nothing. The 409 keeps its code and `successorConversationId`. The text names
the current seat in words: "This orchestrator was replaced. The current
orchestrator of «<project display name>» is <conversation id>; send there."
That is today's text at `seats.ts:1494-1497`, rewritten. A seat or the gateway
can also use `send_message_to_orchestrator`, which always reaches the current
seat.

**Sends addressed by project are re-routed.** `relay.ts:153-166` refuses a
recipient that is not current unless an original send authorizes recovery.
Instead, when the recipient is a revoked seat of the same project and no
original send exists under the key, it uses `currentSeat(project)`. Recovery of
an existing original keeps its record (`:106-146`). On the MCP side,
`sendMessageToOrchestrator` (`bindings.ts:5268`) persists the recipient the
route actually used, the way it already persists a created seat
(`context.bindCreatedTarget`). A same-key recovery then reads the right record.
The tool description sentence "The recipient is frozen before the message
dispatch; a later seat rotation never redirects recovery"
(`src/lib/mcp/server.ts:3462`) becomes "A message still queued when the seat
rotates is carried to the new seat; recovery under the same key never sends
twice."

### 4.6 Records and receipts

- `SEND_SEAT_REVOKED_REASON` ("the orchestrator seat was replaced before this
  reached it; it was not delivered there") joins the reasons in
  `src/lib/runtime/sendSettlement.ts:106-125`. `journalVerdict` (`:458-470`)
  keeps it verbatim, as it keeps `SEND_DISCARDED_REASON`, with disposition
  `lost` (resend safe), so the outbox and `message_receipt` say why.
- The redirect record is a `seat-channel` collection in `state.sqlite`, owned by
  `seatChannel.ts` alone, at most 2 000 rows, evicting the oldest settled row
  first. One row per withdrawn operation holds `{ fromOperationId,
  fromConversationId, project, revokedSeatEpoch, class, outcome:
  redirected | dropped | owner | too-late | awaiting-seat | unknown,
  toOperationId?, toConversationId?, at }`. It is written only by the pass,
  which runs a few times a day, never on the send path.
- `resolveSendReceipt` (`sendSettlement.ts:792`) and `lookupOriginalSend`
  (`:1046`) follow a `redirected` row. The answer for the original operation
  carries the redirect's state, with `redirectedTo: { operationId,
  conversationId }`. `message_receipt`, relay recovery and the MCP receipt store
  then report "delivered (redirected)" and never invite a resend of something
  that arrived.

### 4.7 What stays readable

Nothing on a read path asks the delivery verdict. The builder keeps it that
way and a test pins it (§6, test 8):

- `conversation_messages` and `get_conversation` on a revoked seat's
  conversation id or transcript path. The successor's handoff read is a
  `conversation_messages` call on its predecessor
  (`rotation-predecessor-recent-turns-*`, seen at 12:16:31 on 2026-10-16).
- The rotation handoff digest (`src/lib/orchestrator/handoffDigest.ts`) and
  `search_transcripts`.
- The UI transcript view of a previous seat, opened from the Previous seats
  popover (`src/components/orchestrator/PreviousSeats.tsx`).
- `conversation_deliverability` keeps answering `superseded` with the current
  seat (`src/lib/conversation/deliverability.ts:74-83`).
- Seat rounds stay project-scoped (`src/lib/prototypeReview/read.ts:105`). The
  successor reads and answers rounds its predecessor published.

### 4.8 The rule this reverses, said plainly

#2952 deliberately let an operation admitted before a rotation finish at the
old seat, even resuming its dead host (`seats.ts:1431-1432`; tests at
`structuredMessageDelivery.test.ts:5043` and `:5068`). That rule guarded
against redelivering something that may already have arrived. The guard is
kept by a narrower means. Only operations the journal proves unexecuted
(`queued`, `pending`, held) are withdrawn and moved. Anything in an executor's
hands is left as `too-late` or `uncertain` and never sent again automatically.
The two tests flip (§6, test 3), and the comment at `seats.ts:1431-1432`
changes with them.

## 5. Validation against the requirement

| The operator's words | Where it holds |
| --- | --- |
| «старый оркестратор вообще недоступен… недоступны для взаимодействия» | §4.2: no message reaches a revoked seat at admission, dispatch, held drain, legacy delivery or host recovery, whatever id was captured. Controls stay, so it can be stopped. |
| «если через Viewer кто-то пытается им что-то отправить, они не должны никак быть добавлены» | §4.5: a composer, `send_message` or task send to a revoked id is refused before anything is reserved, naming the current seat. |
| «один общий канал, который ведёт к оркестратору… выбирается текущий оркестратор, и никакой больше» | §4.1 and §4.3: one module chooses the current seat. A message admitted while a seat was current, still queued at rotation, is carried to the seat that is current at delivery. Sends addressed by project are re-routed. |
| «они напрямую не должны общаться с оркестратором» | A conversation id stops being a delivery address the moment its seat is revoked. Only the channel reaches the seat that holds the project. |
| (pinned) history stays readable | §4.7 |
| (pinned) tests red on main, green after | §6 |

## 6. Tests

All are run by explicit path through `scripts/gate-slot.sh`. Each run gets a
private HOME, XDG_CONFIG_HOME, TMPDIR and `LLV_STATE_DIR`, with
`LLV_VIEWER_CONTROL_URL` on a closed port. Each is shown red on `02f9301fc`
first, in a scratch export.

1. **The 2026-10-16 case** goes in `src/lib/prototypeReview/answerDelivery.integration.test.ts`.
   It uses the real ingress, journal and queue over the fake engine. The
   fixture `src/lib/runtime/fixtures/composerPayloadRuntime.ts` gains an
   optional second Claude conversation and a switch that holds the first one
   mid-turn. Seat N publishes a seat round. A member answers. The delivery is
   admitted to N and waits `awaiting-turn`. The test rotates N → N+1 through the
   real designation store (`beginOrchestratorSeatIntent` and
   `completeOrchestratorSeatIntent`, as `structuredMessageDelivery.test.ts:4130`
   does), then ends N's turn. It expects N's engine to receive nothing and N+1's
   engine to receive the answer exactly once. It expects `delivery.conversationId`
   to be N+1, `predecessors` to name N, and the original operation's receipt to
   be `failed` with `SEND_SEAT_REVOKED_REASON`. A variant presses Retry before
   the rotation, as the operator did at 11:53–12:03. **Red on main**: N receives
   it at the end of its turn, exactly as at 12:13:08.
2. **Dispatch gate** goes in `src/lib/runtime/structuredDeliveryQueue.test.ts`.
   A queued send to a revoked conversation is failed with the new reason, and
   `host.send` is never called. `unknown` leaves it queued with
   `evidence-unreadable`. A revocation landing between the drain check and the
   engine call (probed after each await) re-queues it, and the next pass fails
   it. `interrupt` and `kill` still pass. A native Codex `add` is refused at its
   `settled` fence. **Red on main.**
3. **The #2952 rule, flipped** in `src/lib/runtime/structuredMessageDelivery.test.ts`.
   The test at `:5043` becomes "a message bound to a rotated seat is never
   re-commanded to it". The test at `:5068` becomes "an admitted delivery to a
   rotated seat never recovers its host and is withdrawn". **Red on main** by
   construction.
4. **Direct-send refusal** in the same file and `src/lib/runtime/http.test.ts`.
   The D4 cases stay green. New cases: the 409 text names the project and the
   current seat; the legacy path (`src/lib/delivery.ts`, in its test file)
   refuses a revoked seat; a task send to an assignee that is a revoked seat is
   refused. The fresh composer and `send_message` refusal is **already green on
   main since #2952**. The new wording and the legacy and task cases are **red**.
5. **Relay re-route** in `src/lib/orchestrator/relay.test.ts`. An HTTP relay
   naming N, and an MCP relay bound to N before a rotation, are admitted to N+1.
   A same-key recovery answers the original. **Red on main**: today it refuses
   `orchestrator_not_designated`.
6. **Channel redirect** in a new `src/lib/orchestrator/seatChannel.test.ts`. An
   operator composer message, a `send_message` from a worker and a
   `bridge_directive`, each queued at N, arrive once at N+1 with the redirect
   line and the original origin, and never at N. `message_receipt` on the
   original reports the redirect's state. With no current seat the record waits
   `awaiting-seat` and moves at the next activation. A stillborn successor
   (provisional N+1 rolled back, N restored with a new epoch) brings the message
   back to N once. **Red on main.**
7. **Voice directive at rotation** (the 12:14:48 case) in the voice companion
   admission test. It is admitted to N, rotated, retargeted to N+1 with the
   note, and never reaches N. **Red on main.**
8. **Reads stay** in the bindings tests for `conversation_messages` and
   `conversation_deliverability`. Against a revoked seat they answer as before,
   and a read never touches the channel. Green on main; kept as a guard.
9. **Owners and epoch-bound producers.** A spawn-notice attempt queued at N goes
   to N+1 on the next sweep (`src/lib/spawnNotice/sweep.test.ts`, **red**). A
   seat-tick wake and a board report queued at N are withdrawn and not
   redirected (existing seat-tick withdraw tests plus one board-report case).
   For a Codex seat with a message already in its native queue, the pass deletes
   it before counting it withdrawn.
10. **Disposition table**, also in `seatChannel.test.ts`. Every key builder named
    in §4.4 maps to its class, and an unknown key maps to the channel class.
11. **Contention**, per the project rule on state-DB waits. The pass's registry
    reads and `seat-channel` writes run while a peer process holds the state
    lock, and an independent timer must keep advancing.

## 7. Build plan, in order

0. Re-read `origin/main` against `02f9301fc`. Read the open diffs of lanes
   d8fbb735 (head `66c180a6`: `spawnCommand.ts`, `spawnDeferral.ts`,
   `reportSpawn.ts`, a seat-tick reporting test, and one hunk in
   `viewerLoopMonitor.ts:6`), 24599543 (merged as #2966 at 13:13 UTC on
   2026-10-16, `prompt.ts` and its test only, none of the files cited here; this
   lane leaves the mandate alone) and d1bbb135 (still in design; it may edit MCP
   tool descriptions and bindings). Touch `server.ts:3462` with that single sentence,
   and `bindings.ts` only in `sendMessageToOrchestrator`.
1. Write tests 1–7 and 9 against the base and record the ones marked red as
   red. Test 4's existing D4 cases and test 8 are green on main and stay so.
2. `seatChannel.ts`: `currentSeat`, the verdict wrapper, the disposition table,
   `SEND_SEAT_REVOKED_REASON` in `sendSettlement.ts` with `journalVerdict`
   keeping it, and the new 409 text in `seats.ts:1494-1497`. Add the operation
   label `orchestrator.seat-channel` to the orchestrator group of
   `viewerLoopMonitor.ts:12`, a different hunk from d8fbb735's.
3. The dispatch gate: the controller port and the queue checks at `:1554`,
   `:1689`, `:2153`, plus `StructuredDispatchDeferredError` (`engineHost.ts`)
   and its settlement. Then the held-drain `authorityFence`, the legacy check
   in `delivery.ts`, and the bound-key change at `structuredMessageDelivery.ts:1375`.
   Tests 2–4 go green.
4. The rotation pass: the hook in `writeSeatFile`, the boot catch-up, the
   withdraw helper moved from `seatTickSources.ts`, the `seat-channel` record,
   redirect admission, and receipt following in `sendSettlement.ts`. Tests 1, 6
   and 11 go green.
5. Owners: `decision.ts:349` (also on `pending`), voice retarget after
   admission, spawn-notice re-attempt, the Telegram port, and the relay
   re-route with MCP recipient persistence. Then the tool sentence and the
   `seats.ts:1431-1432` comment. Tests 5, 7, 9 and 10 go green.
6. Checks: touched test files by path; typecheck; changed-file lint; the
   privacy gate from the merge base. The change touches no `src/runtime-host/**`,
   `bin/**` or `Dockerfile`, so `verify-runtime-host` is not owed; say so in the
   PR. If step 3 turns out to need a runtime-host change (for example the
   native queue delete), stop and say so: AGENTS.md then asks for three review
   rounds, one more than the lane's two.
7. In the PR body, map each table row of §3 to its gate or owner, and each test
   to its red and green runs.

## 8. Observed beside the defect (not in this lane)

- **Some answers travel twice by design.** The 12:05:56 seat wake carried
  `pr_199242c2` as a "saved operator answer" item (#2957's carriage), and the
  same answer arrived again at 12:13:33 as `retry_63412e20`. The revoked seat
  itself described most of the redelivered answers as "a repeat, already done". This design sends
  them to the right seat. Whether an answer should travel both ways is #2957's
  question, and worth its own task.
- **A revoked seat can still act inside the turn it was in.** At 12:08–12:15
  `f8395a87` created tasks and rotated the seat. Each of those actions followed a
  message delivered after its revocation, which this lane stops. What remains is
  the turn running at the moment of revocation (see Deferred).

## Deferred — not currently justified

- **Disable the composer and show a successor banner on a previous seat's
  transcript** by reusing the #383 `superseded` surface. The server refusal
  already keeps anything from being added, and the seat panel always shows the
  current seat. The existing reason string reads "round superseded", which is
  wrong for a seat, and new UI would owe rendered evidence in two languages and
  two themes for a view the operator rarely opens. Revisit if the refusal text
  proves unclear in use.
- **Refuse write tools (`create_task`, `rotate_orchestrator`…) to a revoked
  seat, or interrupt its turn at rotation.** The requirement is about what
  reaches old seats. A seat that rotates itself calls `rotate_orchestrator`
  mid-turn and still has to write its handoff and final report, so an interrupt
  would cut that. Host retirement (#1245) already ends a revoked seat's host
  once its turn ends. Revisit if a revoked seat is seen acting on something it
  did not receive.
- **Self-scheduled wakeups inside a revoked seat's engine.** They never pass
  through Delegatus delivery, and host retirement ends them.
- **A source-scanning guard test** forbidding `orchestratorSeatFor(...).active`
  in delivery producers. The dispatch gate makes the guarantee whatever a
  producer captures, so the scan adds upkeep and no safety.
- **Routing the composer through the project-addressed relay route.** That route
  takes text only (`handlers.ts:284-290`) and would drop attachments. A
  composer send to a revoked id is refused instead, and one still queued is
  redirected.
- **Making the delivery journal itself seat-addressed** (a `seat:<project>`
  target resolved inside the runtime host). It would put the routing point in
  the critical runtime and change its command schema, for no behaviour the
  Viewer-side gate does not already give.
