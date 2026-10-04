# Runtime switches continue a live attempt

Status: accepted

Amends [0002](0002-mutations-under-a-live-attempt.md) for runtime fields only.

A running structured run stage may accept `override-stage` with `applyNow: true`.
Its bound definition, inputs, output policy, access and sandbox remain intact.
Engine, model, effort, speed and account describe a new runtime for the same
attempt. Ordinary overrides continue to affect the next attempt.

Each attempt retains up to eight switch records. One open record owns recovery
until its continuation or rollback has a durable witness. Its sequence generates
stable interrupt, reconfigure, stop, launch and delivery keys. An identical open
request replays; a different target conflicts. Account admission uses the existing
project selector, authentication, quota observations and allowed pool.

Same-engine switching uses the conversation reconfigure executor, preserving the
Delegatus conversation id. Codex account moves fork and resume a native thread;
Claude account moves use its existing forked transcript and resume machinery.
Profile-only moves resume the same native identity with the new settings.
Admission observes the current native generation, and receipt-free reconfigure
success is a durable no-op checkpoint rather than an owed journal result. A keyed
engagement follows reconfigure so account moves can leave their waiting state.

An engine change confirms termination first, then uses the ordinary structured
spawn path with a deterministic client attempt id, the original membership slot
and a predecessor link. It carries the bound brief, private handoff artifact,
redacted transcript tail and bounded Git observations. Transport framing is
limited to 32000 bytes; a large brief is referenced from a private artifact.
The executor holds a per-switch kernel fence while slow native setup and Git
observations run outside the shared collection lease. Every dispatch and durable
checkpoint checks the live attempt and operator control fence. Reservations
persist before dispatch; uncertain launches reconcile their receipt
and prove termination before any rollback.

A failed or cancelled move reconciles the original continuation, because migration
cancellation rearms held delivery on the source. A terminally failed send permits
one replacement key. Atomic cancellation losing to a claim parks the stage until
its outcome is known. Owned handoff stops have deterministic keys so a crash
cannot confuse them with a newer operator kill. Kill lookup walks every retained
journal page. A retained non-owned boundary whose receipt was compacted
fences continuation with an explicit wait/park reason, because its age cannot
be proved. Verdict evidence from before the continuation is fenced; a new
transcript retains output produced before its launch acknowledgement arrived.

The control reads a fresh stage digest before sending runtime fields, offers both
application times, and names switching, continuation and rollback. Geometry and
localized status evidence are captured by the existing kanban browser driver at
1440 and 390 px in English and Ukrainian.
