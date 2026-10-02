# Interrupted stages after a restart

The 2026-10-02 00:25 UTC OOM restart restored structured hosts while their
interrupted stage attempts remained running. An idle host returned unknown
agent activity, and a busy transcript then kept its attempt open indefinitely.
The existing continuation path required a runtime-host epoch change; a Viewer
restart with the same host epoch did not qualify. Provider limit/auth recovery
and terminal verdict settlement remain on their existing paths.

The seat scheduler did restart and continued checking every five minutes.
The persisted journal records 51 wake candidates withheld by
`seat-mcp-unavailable` between 00:30 and 04:40 UTC. Its stdio MCP launcher had
no heartbeat record. An uncertain pre-restart wake was also retained until
its existing fence expired. Stall detection and trigger generation were working;
delivery admission prevented the seat from receiving those wakes.

A running structured attempt now receives one durable continuation reservation
per Viewer/runtime-host boot when a readable open-turn artifact agrees with
positive idle, dead, or confirmed stalled runtime evidence. Stalled hosts must
confirm termination before delivery. Pending deliveries, deploy continuations,
permission requests, terminal turns and unknown evidence retain their
existing authority. A recorded report remains authoritative when its resumed turn ends. A failed admission or a second interruption after ten minutes
parks with an explicit reason. Retry requires the caller's stage and attempt,
positive stalled evidence, and confirmed host termination; it preserves the
checkout. Surviving process identities continue to fence replacement attempts.

The seat clock checks immediately at boot. A newly confirmed lane stall can
attempt ordinary wake delivery despite a missing MCP heartbeat, so the delivery
layer can restore the conversation. Existing seat authority, pending-wake fences,
interval limits and delivery accounting still apply. Successful arrival records
the stall token; an unchanged stall cannot repeatedly bypass the heartbeat gate.
When a lane is already represented by an own-lane agenda item, that same item
now carries its stall token and reason, preserving delivery dedupe.

Regression tests use isolated state and reconstruct controllers from the stored
attempts and stall observations. They cover both engines with idle, dead and
stalled hosts, bounded continuation, guarded running retry, unresolved host
termination, missing heartbeat wake admission, and the first boot check.
