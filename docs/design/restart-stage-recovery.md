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

A running structured attempt gets at most one automatic fresh attempt per
Viewer/runtime-host boot when a readable open-turn artifact agrees with positive
idle, dead, or confirmed stalled runtime evidence. Recovery confirms termination
through the existing process identity fence, records the interrupted attempt as
failed, and launches a new conversation on the same checkout with the same bound
stage definition and input. The new prompt includes a short restart note and the
previous transcript path for reference. Pending deliveries, deploy continuations,
permission requests, terminal turns and unknown evidence retain their existing
authority. Newer transcript progress or terminal evidence withdraws a stale
recovery decision before a replacement is reserved. A second interruption of
the replacement during the same boot parks with an explicit reason and wakes the
seat. Retry requires the caller's stage and attempt, positive stalled evidence,
and confirmed host termination; it preserves the checkout. Surviving process
identities continue to fence replacement attempts.

The seat clock checks immediately at boot. A newly confirmed lane stall can
attempt ordinary wake delivery despite a missing MCP heartbeat, so the delivery
layer can restore the conversation. Existing seat authority, pending-wake fences,
interval limits and delivery accounting still apply. Successful arrival records
the stall token; an unchanged stall cannot repeatedly bypass the heartbeat gate.
When a lane is already represented by an own-lane agenda item, that same item
now carries its stall token and reason, preserving delivery dedupe.
A new own-lane decision announcement also qualifies after parking, even if the
interrupted turn wrote no newer record. Arrival records that announcement once.

Regression tests use isolated state and reconstruct controllers from the stored
attempts and stall observations. They cover both engines with idle, dead and
stalled hosts, bounded continuation, guarded running retry, unresolved host
termination, missing heartbeat wake admission, and the first boot check.
