# Terminal launch operation settlement

First-prompt delivery settlement can fail a launch receipt in the agent
registry before its runtime spawn operation has a terminal outcome.
`failInitialSpawnReceiptForDelivery` is reached by direct and batched delivery
outcomes, migration exclusions, cancellation and held-delivery cleanup. Those
registry transactions cannot also commit the runtime journal.

`reconcileStructuredSpawnReplay` joins the original launch operation, its
first-prompt operation and retained delivery owner, the current registry entry,
the runtime session and transcript evidence. Startup and the periodic stale
spawn pass use that same reconciliation. A failed receipt closes an open
operation under its original launch and idempotency keys, even when its runtime
placeholder has already become unhosted or disappeared.

| Evidence | Spawn operation outcome |
| --- | --- |
| Transcript proves the first prompt arrived | Delivered; recover the launch receipt |
| Failed launch, no live writer, no uncertain delivery evidence | Failed |
| Unverified delivery, active writer, delivering operation, or unavailable session evidence | Uncertain; retain the writer and delivery evidence |
| Operation already terminal, or a concurrent terminal transition wins | Preserve that outcome |
| Operation lookup or terminal write unavailable | Defer and inspect the original key on a later pass |

The uncertainty outcome describes an unsuccessful setup whose execution cannot
be ruled out. It authorizes no retry, host release or process termination. The
existing failed setup receipt and its delivery owner's unverified disposition
remain available; this change introduces no receipt schema or retry key.

Failure reporting and operation settlement have independent completion points.
The periodic pass reads one page of up to 100 active spawn effects and attempts
at most its configured actuation cap, normally 50, before advancing its cursor.
It therefore also finds failed launches whose reporting already completed.
If transcript recovery completed the receipt before a journal write failed,
the same scan finishes its original operation as delivered on the next pass.
The outbox retains unsuccessful settlements across restarts; the process-local
cursor only supplies fair traversal. Registry reads select those launch keys
before loading their rows. Retained terminal history is outside this scan.
This change makes no throughput or latency improvement claim.

`src/lib/runtime/structuredSpawnSettlement.test.ts` reproduces failure through
delivery settlement with real SQLite stores, then checks startup, periodic
repair, process restart, original-key replay, uncertainty, live writers, lost
acknowledgements, unavailable evidence, release withdrawal and late success.
