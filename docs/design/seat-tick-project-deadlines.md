# Seat tick project deadlines

The Viewer checks every project in a FIFO queue automatically; no setting or
operator action is required. `SEAT_TICK_CHECK_CONCURRENCY = 1` keeps one project
check active on the saturated main thread. Foreground resumes and owed retries
use the same queue. Each project's preparation, evidence, delivery and one
immediate alarm-source retry share a deadline of one quarter of the configured
check interval (75 seconds with the default five-minute interval). The clock
starts after admission and a macrotask yield. Waiting creates no check record
and counts no failure toward the three consecutive errors that open an alarm.

The timer polls at half the configured interval. A poll during an active pass
logs its age and skips; it creates neither another pass nor a pending pass.
The next poll after completion starts a fresh roster. Every project in the
roster is visited before that pass completes. A stuck check spends its own
budget, then releases the queue; retries join behind projects already waiting.
Under overload, a deployment settlement can therefore wait longer than one
configured check interval. Restart handoff and update drain retain their holds.

For 17 projects the check budgets total at most 17 × 75 = 1,275 seconds
(21m15s). One final curator coordination scope adds at most 75 seconds: a
22m30s budget envelope. Alarm bookkeeping has at most three one-second lock
admissions per project, making the combined budget envelope 23m21s. Discovery,
journal persistence, synchronous callbacks and delayed event-loop turns add
wall-clock time; these budgets cannot impose a hard elapsed-time ceiling while
JavaScript is blocked. The no-overlap guard continues to hold throughout.

Curation retains one recovery and one machine-wide choice per roster. Queued
followers defer an already pending shared recovery. Checks publish their
refreshed wake inputs without waiting at the all-project barrier; the final
bounded scope waits for recovery and chooses after the roster settles. Its
expiry invalidates the authority callback used by late curator continuations.
Coordination expiry is logged separately and adds no project failure records.

A callback during an active project check records one owed check. When the
active check ends, its retry joins the queue with fresh durable state. A callback
for a project still waiting reuses its pending check. Stop invalidates the old timer generation and
cancels its project scopes. Restart checks immediately and reads the existing
wake accounting; it introduces no new wake cursor or retry counter on disk.

Settled deployments attributed to the active seat have a small evidence path
before general history, PR and maintenance work. It carries the settlement and
the seat's paused lanes through the existing admission and delivery accounting.
An outstanding send retains its original key and receipt rules. A transport
answer after a project deadline cannot credit or overwrite its successor.

Every deployment gather reads accepted attribution and its ledger outcomes
before recovering pending request keys. An eligible recorded settlement defers
that recovery until a later check has no recorded settlements to deliver. The
opening priority hint uses the same order. A separate pending lookup with a
120-second transport timeout therefore cannot consume the project's 75-second
default budget before an already recorded settlement wakes its gone seat.
The pending attribution remains durable; when no recorded settlement is ready,
recovery still attaches a matching admission and retains unknown or failed reads.

Immutable pipeline and task publications have a weakly held project index.
Preparation and provenance checks visit the project's rows. Publications in
another project cannot invalidate this project's PR evidence. Alias changes,
seat changes and changes to the project's own evidence still invalidate it.
Mutable source adapters retain their uncached behavior.

Service-journal running-pass lines name pass age and active projects. Project holds,
errors and overflows include project age, phase, time since progress and budget.
An expired project is marked stuck; its overflow is also kept in the tick run
journal. Normal source cancellations retain their phase in that journal and get
one immediate retry within the original deadline.

`seatTickController.queue.test.ts` covers 17 projects with injected five-second
loop stalls, three complete passes, queue callbacks, alarm counts, curator
expiry, generation cancellation and real process restarts. Its unchanged
concurrently started baseline produces 17 errors; the queued run produces one per
pass for the deliberately stuck project.

`seatTickController.scheduling.test.ts` covers an overlong pass with a deploy,
independent project deadlines, alarm-source retry, late transport answers and
recovery in a new process. `seatTickSources.test.ts` covers unrelated publication
churn and replacement of this project's evidence. These tests establish
scheduling and accounting behavior; they provide no production speed measurement.

The earlier deadline implementation's historical file inventory and samples are recorded in
[the verification report](seat-tick-project-deadlines-verification.md).
