# MCP interruption and original-key retry

An unfinished MCP claim proves that its result was never recorded. It does
not establish process death or whether the binding committed an effect.

Local bindings now record process custody and a `claimed` stage in the same
receipt insertion. Immediately before invoking the binding, the service
conditionally moves that row to `dispatching`. A competing process may replace
an unfinished local claim only while it is still `claimed` and the kernel
proves that its recorded process identity is dead. The claim transaction
serializes contenders. A living or unverifiable owner keeps custody. Changed
arguments remain an idempotency conflict.

A committed receipt replays its original result. A `dispatching` row without
a receipt, or an older row with no custody information, reports
`outcome_unknown`, `retryable: false`. Task edits name `get_task`; creation
names `list_tasks`. Inspect the affected state and retain the original request
key. An empty result alone cannot authorize another mutation. Tools with their
own durable recovery readers keep using those readers and their dispatch
fences.

The memory, file and SQLite adapters all apply the same replacement rule.
File receipts serialize it under their existing lock; SQLite uses its existing
write transaction and columns. Legacy imports preserve their original unknown
status. Async SQLite admission continues through `waitForStateLock`.

## Process lifetime

A stable launcher's release selection waits for pending protocol requests to
answer before replacing its child. EOF and handled signals stop admission and
drain pending calls under a 35-second shutdown limit. The stdio server waits for calls and receipt completion,
then lets the SDK enqueue the final answer and flushes stdout before exiting.
A request arriving after draining begins gets a retryable `not_executed`
answer without claiming its key.

Cancelling one task-executor request keeps its slot until the worker replies;
it no longer starts a one-second timer that kills the shared worker. Graceful
executor closure ends its input, withdraws private admission and waits for
active work and output. The existing heartbeat watchdog and a 35-second close
limit still contain a worker that cannot drain. Process-owner containment
continues to apply on parent death.

`[mcp lifecycle]` records process PID and role, the reason for shutdown,
signals or child exit status, and fingerprints of active request keys. Parent
records identify the child role and PID; task-executor records distinguish the
guardian from the worker. Fingerprints are SHA-256 over the
receipt key, allowing a local receipt investigation without logging raw keys,
arguments or caller identities. Fatal signals such as SIGKILL cannot run a
child's exit logger; the surviving parent can record their exit status.

## Observation and verification

The three historical unfinished claims examined on 2026-10-20 contained no
owner or dispatch stage. The available service journal did not identify an
attributable exit cause; that historical cause remains unassigned.

Isolated regressions reproduce release replacement interrupting an admitted
launcher call and cancellation retirement killing an unrelated task request.
`bin/mcp-server.test.ts` holds calls across release selection and EOF;
`src/lib/mcp/taskExecutorLifetime.test.ts` holds a peer beyond the former
cancellation kill deadline. `src/lib/mcp/interruptedCall.test.ts` restarts real
processes around claim insertion, binding effects and committed receipts for
both persistent adapters, and exercises real stdio EOF and signal draining
with lifecycle payload checks. These checks claim no performance improvement.
