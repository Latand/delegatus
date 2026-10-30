# Fresh admission delivery

## Lane-base trace

Base: `f41fdc45` (the fetched main revision at the start of the lane).

`src/lib/runtime/structuredMessageDelivery.ts:2203` kicks a newly committed
pending operation with `true`. `src/lib/runtime/structuredDeliveryController.ts:2111`
passes that flag to `drainWithRetry`, which calls `drainAfterAdmission` at
`:1499`. In `src/lib/runtime/structuredDeliveryQueue.ts:981`, admission waits
for the preceding general drain. Its replacement drain reaches the mandatory
`await this.port.nativeQueueReconcile?.()` at `:1012`, before listing effects
and starting the recipient's delivery lane.

The sweep implementation at
`src/lib/runtime/structuredDeliveryController.ts:1026` enumerates registered
hosts and starts native reconciliation for each eligible conversation. The
evidence promises are detached (`:1078`–`:1091`). The awaited dependency covers
the sweep setup and the preceding general pass. These two source files match
the measured serving
revision `9bd47eaa` at these seams. This establishes the dependency to remove;
it does not attribute all of the historical delay to it.

Adjacent open changes inspected before implementation: native consumption
proof in #3523, mid-turn settlement in #3524, spawn receipts in #3519 and
legacy native replay in #3355. Their production changes are outside the
fresh-admission dispatch seam; retain the existing replay parser.

## Change and contracts

The admitting message path supplies the journal's recipient id as an optional
second kick argument. The controller uses it to start a scoped pass; legacy
boolean kicks and observer kicks retain their previous general-pass behavior.
The process-wide signal forwards both arguments across bundle realms. Custom
kick callbacks may continue to ignore the optional argument.
Keyed kicks preserve the general retry timer and its failure backoff: a
recipient's pass cannot replace maintenance owed to other recipients.

The scoped pass uses the same target lane and `drainTarget` as a general pass.
It reads all pending effects and retained boundaries for that recipient, so
earlier messages and controls keep their existing order and priority. It does
not update whole-queue absence or retry bookkeeping. A competing pass marks
the recipient's wake owed; the lane owner restarts it after releasing the lane.
The watchdog uses this path for due queued sends to bound recipients, including
an unreadable keyed listing, while retaining the existing migration wake for
work the general listing proved was not yet in the runtime journal.

General absence cleanup considers only lanes that existed before the listing
started. A stale cached fallback cannot release an in-flight lane or replace
the validated listing used to recognize pre-journal work. Fresh native
handoffs schedule the existing general maintenance after their target pass.
Recipient
revocation, host binding, durable settlement and journal dispatch claims stay
in the shared target drain; native adds retain their prepared claim and
binding checks in `NativeQueueExecutor`.

`StructuredDeliveryQueuePort.effectsForConversation` supplies the optional
recipient reader; `effects` keeps its general interface. The production
controller routes scoped reads directly through
`RuntimeHostClient.effectBatch`; general reads keep `DeliveryEffectPages` and
its fallback behavior. The recovery-read proxy preserves the optional key and
the abort signal. The socket handler validates the key; `RuntimeJournal` uses
an additive partial index over recipient and event sequence. Existing readers
and writers retain their defaults and record formats. A listener predating
the optional key may return global pages: the queue advances the original
cursor and filters each page locally before draining.

No composer, spawn, engine-host delivery evidence or settlement code changes.
