# Terminal delivery waits

Accepted sends, including account-switch holds, share the settlement controller.
The ordinary deadline is ten minutes from admission. A retained active turn has
an hour ceiling without fresh evidence. Verified current host activity renews
the turn-boundary deadline for ten minutes; working through an account switch
also protects the migration from its separate five-minute no-progress stop.
The reaper repeats that protection check under the registry writer lock.
Ordinary receipt expiry also compares the recipient publication after writer
admission, along with the native transcript's identity, size and write version
captured before reading turn evidence. A changed owner, activity publication or
transcript releases the writer and obtains fresh evidence before deciding;
repeated changes defer to the next sweep. An explicit kill or proven target
death still ends the wait.

A reservation admits at most twelve automatic attempts under the registry writer.
Host recovery also spends at most twelve attempts. The existing delivery progress
ledger records and flushes an attempt before invoking recovery, so replacing
an executor cannot replenish its budget. A refused progress flush dispatches
nothing. If executors exit without a recovery answer until the budget is exhausted,
publication or the settlement deadline decides the wait; verified working
turns keep their renewal. Polling
for a turn boundary spends no recovery attempt. A classified admission wait
(release preparation, orphan grace or a bounded stop-refusal hold) returns its
reserved attempt only while the progress record still belongs to that executor.
An executor that exits before answering keeps the attempt spent.

A kill selects its pending operations before command admission. An unconditional
kill fences that cohort after the kill is accepted. The first journal receipt
retains the cohort across queued kills, original-key replay, lost acknowledgements
and process restarts. The queue restores this fence before a recovered kill can expire or
terminate its host; an unavailable fence leaves the kill owed for another pass.
Later sends retain their own authority.
An automatic idle-only retirement fences its cohort after confirmed termination.
Losing the idle claim or receiving a termination refusal preserves pending sends,
including when the queue recovers the retirement after an acknowledgement loss.
A proven target death also makes settlement due. A never-claimed reservation
is ended under the same registry writer lock its actuator must take. Journal
operations are fenced transactionally. A started or unreadable actuation keeps
its duplicate risk and requires verification before another send.
Receipt reads and background sweeps apply this distinction during a runtime
outage: an unclaimed reservation fails with a safe resend; a claimed reservation
fails with verification required. Both retain the terminal answer when the
registry reopens and prevent a later drain from delivering the expired send.

A send waiting behind a running Codex turn answers with `switch-after-turn`,
a plain explanation and its deadline, through both HTTP and MCP. Arrival is
still unconfirmed. This path preserves the pending account switch.

A queued instruction whose pipeline attempt is replaced can end with the
controller's recovery refusal. Its admitted sender receives a durable failure
notice. A failed notice remains actionable while that sender is unavailable,
including beyond ordinary terminal-row retention and across process restarts.
Only sent or cancelled notices age out. This preserves the sender's opportunity
to inspect the original operation and authorize a replacement instruction.

## Restart cuts and surviving work

Startup retains its first observation of each host owner. Growth in that same
transcript file, containing newer native work dated after the observation,
together with the exact engine process proven alive, disproves a restart cut.
Work recorded before startup retains the existing ledger and cut decision.
Startup revalidates the generation path, endpoint, claim and process after
reading the transcript. It withdraws unsupported cut
proposals and releases the hold. The surviving process keeps its writer and
turn; startup neither replaces nor demotes it and sends no continuation.
Unreadable evidence and unverified processes retain the existing hold policy.

This refines the live-evidence rule in `restart-cut-recognition.md`. It makes
no performance improvement claim and leaves stage un-parking, successor stop
confirmation and terminal delivery collection retention to their own lanes.
