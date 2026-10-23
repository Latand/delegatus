# Seat tick project deadlines

The Viewer checks projects independently. The timer polls at half the configured
check interval. Each project's preparation, evidence, delivery and one immediate
alarm-source retry share a deadline of one quarter
of that interval (75 seconds with the default five-minute interval). A settlement just after a poll therefore has room for its
project check before the next full interval, while the Viewer owns traffic and
delivery is available. Restart handoff and update drain retain their holds.

A callback during an active project check records one owed check. When the
active check ends, that check starts with fresh durable state. Other projects
start without waiting for it. Stop invalidates the old timer generation and
cancels its project scopes. Restart checks immediately and reads the existing
wake accounting; it introduces no new wake cursor or retry counter on disk.

Settled deployments attributed to the active seat have a small evidence path
before general history, PR and maintenance work. It carries the settlement and
the seat's paused lanes through the existing admission and delivery accounting.
An outstanding send retains its original key and receipt rules. A transport
answer after a project deadline cannot credit or overwrite its successor.

Immutable pipeline and task publications have a weakly held project index.
Preparation and provenance checks visit the project's rows. Publications in
another project cannot invalidate this project's PR evidence. Alias changes,
seat changes and changes to the project's own evidence still invalidate it.
Mutable source adapters retain their uncached behavior.

Service-journal overlap lines name pass age and active projects. Project holds,
errors and overflows include project age, phase, time since progress and budget.
An expired project is marked stuck; its overflow is also kept in the tick run
journal. Normal source cancellations retain their phase in that journal and get
one immediate retry within the original deadline.

`seatTickController.scheduling.test.ts` covers an overlong pass with a deploy,
independent project deadlines, alarm-source retry, late transport answers and
recovery in a new process. `seatTickSources.test.ts` covers unrelated publication
churn and replacement of this project's evidence. These tests establish
scheduling and accounting behavior; they provide no production speed measurement.
