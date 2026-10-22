# Agent memory and CPU limits: mechanism

This page holds the mechanism behind the limits that keep agents from starving
the Viewer. [Keeping Delegatus running](guide/operations.md#agent-memory-and-cpu)
is the operator's view; the designs are
[agent-memory-isolation](design/agent-memory-isolation.md) and
[cpu-placement](design/cpu-placement.md).

## Agent memory

Before a structured, terminal or headless agent launch, Delegatus requires
at least 2 GiB of available RAM. This floor leaves 1 GiB of headroom above
the exhaustion observed in [#1211](https://github.com/Latand/delegatus/issues/1211).
The check uses reclaimable RAM (`MemAvailable` on Linux), independently of
lane count, swap usage and the memory-limit mode, including `off`. An
unavailable reading permits the launch. A refusal reports the measured RAM
and required floor; structured and terminal launch receipts retain that reason
as a failed launch, which the board and pipeline failure handling display.
This is a point-in-time check: later tool allocations remain governed by
memory ceilings and the shared gate runner.

Each agent gets a ceiling computed at launch from RAM and the number of live
hosts. Delegatus reserves at least 4 GiB (15% of RAM) for the core and OS;
`delegatus-agents.slice` caps the combined agent budget. Supported systemd user
installs run agents in separate transient scopes with `MemoryMax`, no swap and
`OOMPolicy=continue`, bound to the Viewer service. Agent descendants inherit a
higher OOM score than the Viewer. No address-space limit is applied.

A heavy command an agent runs through `scripts/gate-slot.sh` leaves the agent's
ceiling: it runs in its own gate service with `MemoryMax=8G` (`LLV_GATE_MEM`),
including from inside an agent's signal domain, where it stays in the agent's
namespaces. Without a reachable user manager a domain's gate runs under the
agent's ceiling instead, and says so.

An existing user-service install needs this drop-in to survive a kill of a
process that still shares the service (workers, builds or watchdog-mode agents):

```sh
mkdir -p "$HOME/.config/systemd/user/delegatus.service.d"
cat > "$HOME/.config/systemd/user/delegatus.service.d/oom.conf" <<'EOF'
[Service]
OOMPolicy=continue
OOMScoreAdjust=100
EOF
systemctl --user daemon-reload
# Run only at a quiet moment, after hosted agents finish:
systemctl --user restart delegatus.service
systemctl --user show delegatus.service -p OOMPolicy -p OOMScoreAdjust
```

Use your service's name if it differs. Expected results are `OOMPolicy=continue`
and `OOMScoreAdjust=100`. The launcher prints a notice when the service still
uses `stop` or `kill`; it never edits the unit. Update the application before
applying the drop-in: the new launcher exits nonzero on Viewer SIGKILL or crash,
so `Restart=on-failure` recovers the Viewer.

Docker and macOS use an RSS watchdog with a shared two-second sampling interval.
On Linux it kills the largest process in an over-budget agent tree after checking
its current ancestry and start identity. On macOS it records the over-limit
descendant as evidence and stops only the identity-verified agent child; surviving
tools may keep running, because cached ancestry cannot authorize descendant kills.
New macOS descendants enroll on their second observation, so first enforcement
can take up to four seconds. Later samples can overshoot by one two-second interval.
The watchdog misses descendants that double-fork out of the tree, does not cap
swap, and cannot attribute a kernel OOM kill. Native
Windows leaves memory isolation off. `DELEGATUS_AGENT_MEMORY=off` is the escape
hatch; forced `scope` fails the launch when the user manager cannot admit it.

A recorded OOM raises a **Needs you** item naming its stage and limit for 24
hours. A fatal stage OOM retries once after memory recovers, retaining its
worktree. A second consecutive OOM, or a 30-minute wait without recovery, stops
for a decision. See [the design](design/agent-memory-isolation.md).

## Agent CPU

On Linux with a systemd user manager, hosts the operator talks to run in
`delegatus-agents.slice` with `CPUWeight=1000`, tmux panes included. Pipeline
and flow hosts, workflow stage and pane-reviewer tmux panes, headless reviews,
gates from `scripts/gate-slot.sh` (the merger's included), workflow setup,
pipeline publication and release installs and builds run in
`delegatus-agents-work.slice`: `CPUWeight=100`, 300% of a CPU per scope and 75%
of the logical CPUs for the whole slice. This placement is independent of the
memory mode. Where it should work and cannot, work is refused with the reason,
a release build included; operator hosts still run.

A pipeline stage, workflow setup or stage, publication install, release install
or build, or gate waits while CPU pressure (`some avg10`) is at or above 30%
and starts once it has stayed below 20% for ten seconds; the wait shows in the
pipeline's or workflow's detail line and in the update step's log. Operator
messages never wait on it. Waiting work starts in turn from one queue for
the machine. A stage that stopped checking its place for a minute lets the
next one pass, and a queue that has started nothing for too long says so on
the card, for example "CPU queue is stalled · 7th · nothing started for
62 min". A Delegatus run on its own state directory keeps its own queue.

| Variable | Effect |
|---|---|
| `DELEGATUS_AGENT_CPU` | `off` turns CPU placement off. |
| `DELEGATUS_WORK_SCOPE_CPU_QUOTA`, `DELEGATUS_WORK_CPU_QUOTA` | Percent of one CPU per work scope (default `300`) and for the work slice (default 75% of the CPUs). |
| `DELEGATUS_CPU_PRESSURE` | `off` turns the pressure wait off; `DELEGATUS_CPU_PRESSURE_HOLD` and `DELEGATUS_CPU_PRESSURE_RELEASE` set the thresholds (`30`, `20`). |

To give the service itself `CPUWeight=1000` beside the agents, run
`node bin/install-cpu-placement.mjs`. It writes three files under
`$HOME/.config/systemd/user` and prints the reload, stop and start that apply
them; run them at a quiet moment. A plain restart can leave the service in its
old cgroup. Dedicated CPUs for production need root; see
[the design](design/cpu-placement.md).
