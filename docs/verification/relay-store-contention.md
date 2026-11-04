# Owner relay store contention

An owner request keeps its execution and answer while local relay persistence
waits for a busy store. Owner custody writes allow 60 seconds of asynchronous
lock acquisition. Admission retains the service request's absolute deadline.
A service lease lost during execution moves the answer to the existing durable,
keyed owner delivery path. It does not start another agent. Service tools still
close when their lease is lost, and delivery still checks current owner authority.

## Incident observation

Read the local journal for 2026-11-04 06:27–06:41 UTC with `journalctl`, filtering
binary-marked records with `grep -a`. The serving source was `3c617726`.
The retained request ledger was inspected read-only, selecting its lifecycle
fields rather than its message content or destination.

| UTC | Primary observation |
| --- | --- |
| 06:28:13.443 | Request execution reservation started. |
| 06:28:54.749 | Owner cancellation cutoff; the journal reports an exception containing `RelayStoreBusy`. |
| 06:28:57 onward | Stop remains pending and retains custody; subsequent attempts back off. |
| 06:37:59 | Last acknowledged service heartbeat, HTTP 200. |
| 06:38:03.993553 | Persisted service request deadline. |
| 06:38:08 | Heartbeat receives HTTP 409, `lease_lost`. |
| 06:39:56.216 | Stop is quarantined with `stop_unconfirmed`; reservation released, failure diagnostic retained. |

The busy exception preceded lease loss by over nine minutes. Heartbeat HTTP
traffic has a separate helper and does not renew a local file-store lease
(`src/lib/externalRelay/relayLeaseTransport.ts`, `InlineRelayLeaseTransport.beat`).
Its later rejection is not evidence that a local heartbeat-store write timed out.
The rejection arrived about four seconds after the fixed service deadline,
following successful renewals throughout the pending stop. This supports service
window expiry as the cause of that rejection.

The typed exception comes from asynchronous file-lock acquisition
(`src/lib/externalRelay/store.ts`, `withFileLockAsync`). The synchronous lock at
the old line 287 throws an ordinary `Error`. The answer record has chain metadata
but no bound conversation, while local launch custody knows the conversation.
`onConversation` therefore failed before `recorder.bindConversation`, at one of
its two asynchronous persistence operations: launch attribution in the run ledger
or chain attribution. At the serving revision these are `runner.ts:929` and
`runner.ts:936`, each with a 5,000 ms deadline. The journal stores no stack or
operation label to distinguish the two. The later admission-confirmation write
at `ownerRun.ts:926` follows this callback and was not reached. The known
conversation, `cancel=kill` and missing first-message proof support the inference
that launch custody failed before successful prompt delivery. The retained
ledger's later `admissionComplete=true` is also written by cancellation.

The owner-run exception handler diagnosed the error and entered stop recovery
(`ownerRun.ts`, `runOwnerAgent`). The ten-minute stop-pending limit then permitted
quarantine (`confirmOwnerStop`, `releaseOwnerStop`). Independently, the runner's
heartbeat failure handler cancelled execution and returned no answer on lease
loss. `ownerFailureAnswer` interpolated the internal diagnostic into the chat
reply. All three mechanisms needed attention.

## Regression procedure

Run each pre-push touched file separately through `scripts/gate-slot.sh`, using
`checkEnvironment` and `isolatedEnvironment(createGateSandbox(), env)` from the
local gate. Keep source exports separate from the checkout and state roots
outside the installation. No live store is used by a test.

`src/lib/externalRelay/runner.contention.test.ts` holds the real ledger lock for
6,100 ms of controlled request time under a live process identity during
launch/renewal, stop confirmation and answer persistence. It requires continuing
heartbeat acknowledgements, one execution, one delivered answer or localized failure, and no leaked internal
exception text. A fourth case loses the service lease during execution, delivers
one keyed answer, then replays the same request in a fresh process without
another send. The four cases fail against the starting main source.

Existing runner cases retain diagnostic, revocation, stop custody, attachment
and receipt checks. Their reply expectations now require short human copy;
diagnostic reasons remain asserted in records and journals.

This change makes no performance claim. It increases tolerance for contention
and removes synchronous waiting from stop confirmation. It changes no runtime
pin or runtime-host input. Hosted tracker audit and runtime check contexts are
observed by publication after the pipeline creates its pull request.
