# Stage start retires earlier lane agents

Start or retry the next stage normally. The controller visits every earlier
settled agent with recorded processes in the lane's worktree before it starts
the new attempt. A confirmed stop lets it continue in the same pass. A surviving
process gets up to three identity-bound stop attempts, five seconds apart.
The lane parks with the survivors and the stop results after those budgets
expire. Each agent has its own persisted budget; a restart preserves all of
them. Older single-agent budget records remain readable and migrate on use.

A stage report records intent while the agent's turn finishes. Once the turn
settles and no accepted delivery, background check or other owner holds it,
the existing terminal-host reaper should end its host. A newer turn or queued
work defers automatic retirement. The stage-start check also handles processes
left by a retirement interrupted during a release change.

The failure was a startup delivery barrier. The stage controller and the
terminal-host reaper both sent a `kill` with an idle revision and writer claim.
When startup had no adopted transport for an earlier host, the delivery queue
held that conditional kill. An explicit conversation kill passed that barrier.
Repeated controller attempts therefore stayed queued while the earlier
processes survived. An isolated reproduction on the base confirmed three
queued conditional kills followed by a delivered explicit kill.

Kills now enter the normal actuation path during deferred startup. A
conditional kill still acquires its exclusive retirement claim, rechecks the
runtime idle revision, registry writer, pending work, pipeline ownership and
seat protection, then uses the existing SIGTERM/SIGKILL ladder. A new turn or
changed authority refuses it before any further signal. Sends and configuration
changes retain their startup admission rules.

Process authority comes from the attempt's launch receipt and current registry
generation. Each signal checks a recorded PID, process start identity and boot
identity. Reused PIDs cannot authorize a signal. The launch gate confirms that
every captured identity is gone before proceeding. Tests cover startup without
an adopted host, a host ignoring SIGTERM, two earlier agents, a reused PID,
settlement retirement, and independent budgets across a fresh controller
process. There is no throughput or latency claim.
