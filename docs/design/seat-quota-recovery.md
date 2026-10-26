# Authoritative seat quota recovery

The pipeline provider-reset recovery selects stage attempts with a retained
provider wait. A standalone orchestrator seat has no such attempt. Its input
can already have a delivered receipt when Claude closes the turn with a quota
error, leaving no queued delivery to wake after reset. Stage account-guard
recovery also operates on attempts and cannot recover this seat turn.

`src/lib/monitor/seatQuotaRecovery.ts` runs through the existing seat ticker,
before ordinary agenda delivery. It accepts native Claude usage-limit evidence
for the active designation and joins it to the delivered request whose native
turn started before that failure. Without that join, recovery grants no send.
Pipeline members keep their existing stage recovery.

The store keeps one obligation and one operator-control marker per project
under `seat-quota-recovery/`. The obligation binds the designation epoch,
conversation, account, provider cut and original operation/submission identities.
It survives a Viewer restart and retains a terminal tombstone until a later
logical request replaces it. Its continuation is authored by Delegatus and asks
the seat to continue the request already in its transcript.
Reads resolve the project's verified alias family, including predecessor
control markers. Updates retain the obligation's original project and delivery
identity; a project succession cannot discard an operator cancellation.

An obligation becomes due at its recorded provider reset, or after a fresh live
eligible sample newer than its exhaustion evidence. A newer exhausted sample
updates the durable hold, including an unknown reset. Aging that sample cannot
restore an earlier reset, even when the first recovery check reads the durable
sample after it has aged. Positive capacity still requires a fresh live sample.
No account is selected or changed by this recovery.
Dispatch preparation persists newer exhaustion through the same update as the
ticker, so a restart between the refusal and the next tick preserves the hold.

Intent is persisted before delivery. Lost acknowledgements replay the same
delivery key, using the existing registry and runtime-journal receipts. Unknown
delivery outcomes keep their identity. A native continuation that was positively
refused before execution uses the delivery layer's existing fenced retry path.
The seat obligation grants no new turn for another failure of its own follow-up.
A distinct delivered request establishes its own native turn boundary. It can
replace a cancelled obligation even when both requests ended in quota errors
without assistant output between them. Recovery follow-ups cannot establish
that boundary because their delivery origin is excluded from the request join.

Rotation, revocation, a reply, replacement input and account/binding changes
withdraw recovery. Operator controls persist cancellation before native work,
including failed controls and controls arriving before the tick detects a cut.
Existing retained stop intents cover earlier controls. Their cursor persists on
the obligation and advances at most one 100-row page per check. An unreadable or
incomplete history withholds dispatch and leaves a diagnostic in the tick log.

The existing idle revision/writer fence remains required. The delivery queue
also prepares the seat guard after claiming the effect and passes its synchronous
authority check into the host's pre-write callback. Dead-host recovery receives
the same authority fence before publication. Transcript evidence is cached for
at most 64 identities and reused only while its file signature agrees; quota,
account bindings and designation are read again at the effect boundary.

Focused checks are `src/lib/monitor/seatQuotaRecovery.test.ts`,
`src/lib/monitor/seatTickController.delivery.test.ts`,
`src/lib/runtime/structuredDeliveryQueue.test.ts`,
`src/lib/runtime/structuredMessageDelivery.test.ts` and
`src/lib/runtime/structuredControls.test.ts`. Run them by explicit path in
isolated state through the gate wrapper. The recovery tests include separate
processes replaying the durable obligation, journal acknowledgement loss and
control-history cursor. No performance improvement is claimed.
