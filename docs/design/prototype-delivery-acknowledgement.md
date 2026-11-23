# Acknowledge an answer carried out elsewhere

1. Read the decided round with `read_prototype_review` and verify the separate
   action's durable evidence.
2. As the project's designated seat or the operator, call `dismiss_attention`
   with its prototype target (`taskId: null` for a taskless form) and
   `acknowledge: { evidence: "Description of the completed action and its proof" }`.
   Evidence must contain 1–2000 characters after trimming. Omit `undo`, `reason`
   and `escalate`.
3. Read the round again to inspect `decision.delivery.acknowledgement`: its
   evidence, server-attributed acknowledger and time. The task can now move to
   `done` through `update_task`.

The delivery becomes `acknowledged`. Its original answer, recipient, message key
and operation receipt remain available. The delivery attention row disappears
and the seat tick stops generating that round's delivery-verification signal.
Neither acknowledgement nor subsequent delivery-worker attempts send a message.
This operation is available through MCP; there is no dedicated acknowledgement
button.

Undecided rounds, successful deliveries and pending deliveries refuse with a
reason before writing. Other callers are refused. Ordinary dismissals and
pending/retrying delivery retain their existing behavior. Reusing the same MCP
request replays its receipt; submitting the same evidence under a fresh request
returns `replay: true` from the stored round. Different evidence conflicts with
the first acknowledgement. Acknowledgement cannot be undone through dismissal.

The write shares the delivery worker's per-round decision lock. Caller and
project authority are checked before receipt replay and again against the
current round immediately before the mutation. If the answer changes while
acknowledgement waits for the lock, the call refuses; read the new answer and
verify the evidence before making a fresh request. Delivery completion, retry
scheduling and wake signals all consume `prototypeDeliverySettled`; attention
reads classify acknowledged deliveries as retired. Local review reads retain
the acknowledgement evidence. Replicas carry the acknowledged state, while
acknowledger identity and evidence remain local.

The delivery writers are decision creation/revision, receipt refresh, delivery
attempts (including automatic retirement), and this acknowledgement. Consumers
include task completion and placeholder settlement, delivery-worker scans and
backoff, local summaries and notices, seat-tick signals, review reads, and linked
replica validation. A new decision revision keeps the existing decision-edit
behavior and starts its own delivery obligation.
