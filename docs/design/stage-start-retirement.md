# Stage start retires earlier lane agents

Start or retry the next stage normally. The controller visits every earlier
settled agent with recorded processes in the lane's worktree before it starts
the new attempt. A confirmed stop lets it continue in the same pass. A surviving
process gets up to three identity-bound stop attempts, five seconds apart.
An admitted stop keeps its original operation key and gets an observation
window of 125 seconds, covering the queue's existing 120-second settlement
window and the termination ladder. Controller ticks observe that operation
without spending another attempt while it is pending. The lane parks with
the survivors and a recorded reason after the bound. Each agent has its own
persisted budget; a restart preserves it. Older single-agent budget records
remain readable and migrate on use.

A stage report records intent while the agent's turn finishes. Once the turn
settles and no accepted delivery, background check or other owner holds it,
the existing terminal-host reaper should end its host. A newer turn or queued
work defers automatic retirement. The stage-start check also handles processes
left by a retirement interrupted during a release change.

An earlier startup delivery barrier held conditional kills until host adoption.
Its existing repair routes kills through normal actuation during deferred
startup. Conditional kills still acquire an exclusive retirement claim,
recheck runtime idle revision, registry writer, pending work, pipeline ownership
and seat protection, then use the existing SIGTERM/SIGKILL ladder.

The later diagnosis found queued acceptance outliving the stage caller's short
observation window. The current controller retains one operation through ticks
and restarts until confirmation or its explicit deadline. Executor phase records
and coded refusals preserve future evidence. The historical automatic requests'
execution outcomes remain unknown.

Process authority comes from the attempt's launch receipt and current registry
generation. Each signal checks a recorded PID, process start identity and boot
identity. Reused PIDs cannot authorize a signal. The launch gate confirms that
every captured identity is gone before proceeding. Tests cover startup without
an adopted host, a host ignoring SIGTERM, two earlier agents, a reused PID,
settlement retirement, and independent budgets across a fresh controller
process. There is no throughput or latency claim.

## Historical obligations and bounded retries

A fenced, versioned startup recovery restores missing controller work for
terminal lanes with outstanding hosts, including settled closes carrying an
inactive optimization flag. Row triggers own queue membership using the durable obligation;
acknowledgement retains outstanding work. Existing queue cursors and deadlines survive
reopening. The existing generation, scope and captured-process proof clears
both outstanding copies only after termination is established.

An exhausted foreground reap retains the existing idle teardown as its retry
owner. One selected host per lane pass may retry, with a persisted 30-second
backoff and the original operation key recorded before admission. The oldest due
obligation in the selected attempt window goes first, so a standing refusal
keeps an idle peer moving across ticks and restarts. Live work,
unavailable idle authority and changed launch custody retain the host with a
reason. A stop receipt alone cannot clear its outstanding reference.

Retirement preparation uses the existing capture receipt and withdrawal path.
If the census expands before the first signal, receipts unwind in reverse order.
A refusal before any effect removes only that preparation's additions. Any
possible signal or runtime release retains the capture for reconciliation.
The first refusing authorization subcondition is recorded with before/after
custody. The shared signal ladder continues to verify process number, start
identity and boot identity immediately before signals.

## Evidence retained for unresolved causes

The existing termination journal records executor claim, first effect, final
tree observation and coded refusals. Per-obligation history retains up to eight
observations independently of general operation-history retention. Persistence
checkpoints record their writer, current owner, target and persisted cursor,
plus the durable tail and bounded error on failure, so an
events-flushed refusal can be traced to its last attempted write. Persistence
still advances through its existing claimed writer and retry path.

The historical automatic requests' executor outcomes and exact descendant
exit times remain unknown. The original missing scheduler entry cannot be
attributed retrospectively to seeding or acknowledgement. The historical stale
event cursor's replay/adoption cause remains unknown; instrumentation supplies
future evidence while its safety guard remains in force. Installed acceptance
belongs to the release owner after deployment and must account for every
remaining host's current standing reason.
