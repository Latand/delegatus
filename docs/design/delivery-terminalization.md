# Delivery terminalization

`RuntimeJournal.claimDeliveryAction` arbitrates retry and discard inside one
`BEGIN IMMEDIATE` transaction. A discard winner commits the failed receipt
with `delivery-discarded`, completes its effect, and retains the receipt until
the Viewer acknowledges its reservation projection. Queued discards retain that
obligation even when their caller did not request it. The discard route
acknowledges only after its registry projection is durable. A repeated claim returns
the same winner and repairs a claim-only discard left by an older release.
An operation already handing input to the engine refuses discard. The original
operation remains the delivery identity throughout recovery.

The socket's action, receipt-transition and projection-acknowledgement handlers acquire the SQLite writer
through `waitForStateLock`, with a single five-second deadline and the request's
abort signal. `stateLockAttempt` covers only `BEGIN IMMEDIATE`; the admitted
transaction commits or rolls back without yielding and its body is never
retried. The loop monitor names the RPC and the admission origins
`runtime.delivery-action`, `runtime.delivery-transition` and `runtime.delivery-projection`.

The action's producers are `handleRuntimeDiscard`, `handleRuntimeRetry`, and
the journal's retry path. `RuntimeHost` and `UnixRuntimeHostClient` carry that
decision across the socket. The queue's delivering transition checks the
durable receipt before engine dispatch. Receipt queries, startup reconciliation,
and lost-acknowledgement repair project its outcome into the delivery registry.
A recovered discard retains duplicate risk because an uncertain attempt may
already have reached the recipient. Registry discard remains absorbing through
later acknowledgements.

Canonical transcript evidence uses the `operation-confirm-delivery` socket
method before projecting delivery. Its `confirmedDelivery` transition option
allows a message's uncertain receipt to become delivered inside the same
transaction that refuses a committed discard. Startup reconciliation and
receipt queries share `confirmJournalDelivery`; both preserve the journal's
winner, including when a transition acknowledgement is lost. A host that lacks
this method receives no fallback write. An unavailable arbitration keeps the
existing receipt. Offline receipt readers retain their existing canonical
evidence behavior.

The files response projects the oldest owed operator message under its
canonical conversation. `blockingStuckDelivery` raises its existing attention
identity once eligible, and removes eligibility at 24 hours from original
admission, including for a cached response. Retry preserves that clock. Any
terminal reservation removes the owed-delivery projection on the next poll;
an unrelated transcript message clears nothing. The receipt remains available
after attention expires. Agent-originated messages raise no operator entry.

Malformed queue payloads remain preserved for repair and refuse dispatch with
`RUNTIME_DATA_CORRUPTION`. Journal integrity faults use the same category.
The runtime-host socket also preserves the allowlisted SQLite corruption codes.
Startup emits one repair diagnostic and schedules no retry for those failures;
socket outages keep their bounded asynchronous backoff. These changes add no
synchronous waits or background loops and claim no performance improvement.

Verification lives in `src/runtime-host/deliveryTerminalization.test.ts`,
`src/lib/runtime/structuredDeliveryRebind.test.ts`,
`src/app/api/files/deliveryAttention.integration.test.ts`, and
`src/components/attention.test.ts`. The race uses barriers at queue health and
engine acknowledgement. The restart fixture exits after the action commit,
before projection. Separate compiled controller bundles are loaded in each of
two real processes; they share one controller and host within a process and
drain the original operation once across restart. All checks use private state.
