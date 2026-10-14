# Keeping Delegatus running and up to date

This page covers updates, automatic updates, running a checkout under a user
service, and the memory and CPU limits for agents. Docker has its own runbook,
[docs/docker.md](../docker.md).

## Updates

**Updates** in the sidebar's ⋯ menu builds the selected green revision in a separate
release directory, then replaces and verifies the launcher, web server and
runtime host together. If verification fails, the launcher restores the previous
release. Running sessions reconnect and interrupted work resumes.

### When the launcher needs a restart

A recovery web server re-adopts its installation's launcher. If an older
launcher needs upgrading, the dialog offers **Restart launcher** for the user
service that runs it, naming that service, or the exact command for its
terminal. Packaged installs download a published npm release into the user's
cache, so global installation permissions are not needed. Docker's runtime-host
profile uses its deployment coordinator.

### Older packaged releases

Packaged releases that predate this updater need one launch of
`bunx delegatus-cli@latest` to load it. The Update dialog installs a published
version that names the commit it was packed from; for a version published
without one (every version up to 1.9.0) it names the version and asks for
`bunx delegatus-cli@latest`.

## Automatic updates

**Automatic updates**, off by default, waits for green checks and a quiet minute.
On a busy machine it holds new launches while the current work finishes, for
at most ten minutes; after two minutes without new starts it applies as soon
as the live turns and stages finish. Only work verified as live counts: a host
silent for ten minutes stops blocking unless a long tool or a running check
shows it is still busy. When the hold runs out, launches reopen for ten
minutes before the next try, and the Update dialog and `auto_updates` show the
reason and the retry time. Your own activity, low memory and failing checks
still block it. A failed automatic apply rolls back and turns the switch off.

Automatic updates are available for a clone or a Docker runtime-host
install. A packaged install updates through the Update dialog instead.

## Running as a user service

A checkout launcher may also run under a user systemd service. The Update dialog
restarts an older launcher through a transient service outside the unit being
restarted. Obsolete `agent-log-viewer` units still produce the migration notice;
[docs/docker.md](../docker.md#moving-off-the-systemd-install) describes retiring
those units.

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
for a decision. See [the design](../design/agent-memory-isolation.md).

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
[the design](../design/cpu-placement.md).

## Docker

The published image, the production instance with its runtime host and the
test profile are in [docs/docker.md](../docker.md). The Docker image uses the
same limits above; memory in Docker is enforced by the watchdog.
