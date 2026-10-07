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
project selector, authentication, quota observations and allowed pool. Dispatch
rechecks the allowed pool; revocation fences continuation with a clear waiting
reason. Continuity preference follows the current native account.

Admission is long over when the conversation's reconfigure executor runs the
queued operation, and that executor knows only the conversation. It therefore
reads the switch record behind its operation id from the pipeline registry
(`runtimeSwitchFence.ts`) and asks the project's allowed accounts again: before
anything is released, before the successor is created and before it is
published. A target revoked after admission launches nothing; the operation
settles failed, a successor already created is discarded, and the attempt
continues on its source runtime through the ordinary rollback, or waits with
the reason when the source is revoked too. The record is durable, so a restart
reads the same answer. A revocation after the successor was published is the
case of any running stage whose account was dropped, and parks the lane.

A profile-only move keeps its account, so nothing migrates: the host is released
and restarted through structured recovery, which resumes a recorded account by
continuity and asks no project pool. Every recovery the operation requests,
the restorations after a failure included, therefore carries the same fence and
asks about the account the host would start on: under the account lease before
the launch is reserved, again before dispatch, and again before publication. An
account dropped while the host was being released starts no host; the operation
settles failed with the reason and the lane waits on the ordinary rollback rule.

The same record names the speed exactly. A reconfigure carries only fast or
standard, and the profile rule keeps a tier that already agrees with it, so a
move from another fast tier to Priority would have kept the old tier and been
reported as applied. The executor writes the tier the record names, the
controller reads the effective tier of the native generation (an explicit tier,
else Priority for a fast profile), and a continuation on a runtime that differs
from the selection is recorded as superseded and never committed as the
selection. A repeated identical request after settlement is therefore already
current and starts nothing.

A request may name the attempt and the conversation it was chosen on
(`expectedAttempt`, `expectedConversationId`). Both are checked inside the
admitting mutation before any runtime or definition is touched; a retry that
started another agent in the meantime answers 409 `STAGE_CHANGED`. An open
switch keeps answering the conversation it started on, so its replays work.

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
cancellation rearms held delivery on the source. A handoff that rolled back owes
nothing to its target launch, which failed or was never reserved: a parked
rollback settles from the source's own delivered continuation, its generation
and its account's place in the allowed pool, with or without a launch receipt. A terminally failed send permits
one replacement key. Atomic cancellation losing to a claim parks the stage until
its outcome is known. Owned handoff stops have deterministic keys so a crash
cannot confuse them with an operator kill admitted at or after the request;
terminal kill wins ties within the clock's millisecond precision. Kill lookup walks every retained
journal page. A retained non-owned boundary whose receipt was compacted
fences continuation with an explicit wait/park reason, because its age cannot
be proved. Continuation evidence starts at the recorded native turn start,
independently persisted on the attempt so history retention cannot reopen old
output. A bounded-memory, identity-checked native-record scan recovers that
witness when tool output pushes it outside the final evidence tail. Completion acceptance checks its previewed runtime boundary again; a
completion before the cut supersedes the request. A reserved handoff successor
may report before its launch acknowledgement. A new transcript retains output
produced before that acknowledgement arrived.

The operator has no separate surface for this. The runtime pill in the composer
of the stage's conversation is the control: while that conversation is the
agent of a running attempt, a model, reasoning or speed row sends
`override-stage` with `applyNow` and the whole runtime the pill shows, and an
account row sends the same request with the account. The request carries the
conversation's own engine, so a next attempt already set to another engine
does not decide how the choice is read, and the attempt and conversation the
pill was opened on. The pill spins while the attempt's switch record is open.
A switch that did not take is the pill's error: its face, its tooltip, a
toast, and the account line of its popover and sheet, worded by the model's
display name and the account's label. The words follow what happened to the
agent: a refusal before the turn was cut says the stage stays on its runtime,
a rollback says it continues there, a stop that is not confirmed says the
switch waits for a decision, and only a kill says the agent stopped. On the
phone the sheet of such a conversation is titled for the running stage and
says the change applies now; any other conversation keeps the next-message
words.
A conversation that is no longer the stage's agent keeps its own reconfigure.
An engine change has no row in the pill and stays with MCP
`pipeline_action override-stage`. A stage that has not started keeps its
stage-settings surface, which applies from the next attempt. The existing
kanban browser driver captures the pill at 1440 and 390 px in English and
Ukrainian, with the conversation's controls counted before and after.
