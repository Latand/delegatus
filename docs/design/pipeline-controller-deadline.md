# Pipeline controller deadlines

The controller keeps its existing 15 second phase bound and 45 second request
bound. At a pipeline phase deadline it logs the names and ages of pending
operations, revokes that pass's authority, and releases the phase, scheduler and engine
slots. A later tick can poll CPU tickets and advance stages immediately.

Each pass carries an async operation lease. Its descendants retain that lease
even after the caller abandons their promises. Port calls check it before
dispatch and after an awaited result. Git commands receive its cancellation
signal alongside any caller signal. SQLite checks it at lease acquisition,
transaction admission and snapshot checkpoints. A mutation callback that never
returns is abandoned and its logical write lease is released; its late
checkpoint remains refused. An old engine pass can clear only its own slot.

Publication, provisioning and settlement jobs have separate durable ownership.
They leave the pass lease when admitted and keep their existing recovery and
effect fences. Expiring a scheduler pass does not revoke those executors.
Already dispatched external effects retain their downstream reservation keys;
the next pass reconciles those receipts before another dispatch.

The deadline log includes pending Viewer operations, performance span sites and
individual engine port names, with a cap of 256 open records per pass and an
explicit omitted count. Loop-gap reports carry the same pending pass records
separately from their sixteen longest operation labels. A responsive loop can
still have a hung await, so the deadline log is emitted independently of gaps.
These records contain static operation names and durations.

The October 31 incident establishes that the deadline fired while the original
promise retained both controller guards. The retained journal cannot identify
the inner await: it aggregated operation names and counted open performance
spans without naming them. Delivery-mirror errors that completed near the hang
do not establish its origin. The added telemetry supplies that missing evidence
for a future occurrence; this change makes no throughput improvement claim.

An exact deploy of an already healthy serving revision remains a no-op. Its
persisted deployment status says “Already serving the requested revision;
nothing was restarted.” The rebuild command prints that status. Restarting the
Viewer still requires the existing restart operation.
