# Production gets CPU priority over tests and pipeline work

On 2026-10-06 test fixtures and agent command trees shared the CPU with the
production service with no weights and no ceilings. Two operator messages waited
409 s and 515 s before dispatch while CPU pressure (`some avg10`) read 60%.
Memory had its own placement since the October 2 incident
(`agent-memory-isolation.md`); CPU had none. This document describes the CPU
counterpart: where every process tree runs, the quotas that bound heavy work,
the admission that holds heavy work under CPU pressure, and the files that move
the production service under a common parent with the agents.

## The tree

```text
user@<uid>.service
├─ app.slice
│  └─ delegatus.service              production (until the installation files below are applied)
└─ delegatus.slice
   ├─ delegatus.service              production, CPUWeight=1000 (after the installation files)
   └─ delegatus-agents.slice         memory budget for every agent (MemoryMax set at runtime)
      ├─ delegatus-agent-*.scope     operator hosts: CPUWeight=1000, no CPU ceiling
      └─ delegatus-agents-work.slice CPUWeight=100, CPUQuota=75% of the logical CPUs
         ├─ delegatus-agent-*.scope  pipeline and flow hosts, headless runs: CPUWeight=100, CPUQuota=300%
         ├─ delegatus-work-*.scope   publication install and push, release install and build
         └─ run-*.scope              gates from scripts/gate-slot.sh
```

The quota period is 20 ms throughout. On a 24-CPU machine the kernel reads a
work scope as `cpu.max 60000 20000` and the work slice as `cpu.max 360000 20000`.
Weights decide who runs when CPUs are contended; quotas are ceilings on average
bandwidth. Neither bounds delivery latency on its own.

The work slice is a child of `delegatus-agents.slice`, so the aggregate agent
memory ceiling keeps covering work. Inside the agents branch one bounded work
slice competes with operator scopes that weigh ten times more, however many
pipeline scopes there are.

## Every launch path and the cgroup it lands in

| Launch path | Code | cgroup | CPU controls |
|---|---|---|---|
| Operator Claude, Codex and Copilot hosts (fresh, resumed, migration and recovery successors) | `defaultStartHost` in `src/lib/runtime/structuredSpawn.ts`, wrapped by `AgentMemoryCell.wrapSpawn` | `delegatus-agents.slice/delegatus-agent-<engine>-<id>.scope` | weight 1000 |
| Pipeline stage hosts and flow members (any engine, fresh or resumed) | same; `workloadForMemberships` reads the conversation's `pipeline`/`flow` membership | `delegatus-agents-work.slice/delegatus-agent-<engine>-<id>.scope` | weight 100, 300% per scope |
| Headless runs: flow reviewers, the external relay agent, the handoff digest | `launchDetached` in `src/lib/agent/headless.ts` | `delegatus-agents-work.slice/delegatus-agent-headless-<id>.scope` | weight 100, 300% |
| Every command an agent runs: tools, MCP servers, subagents, test runs, detached and orphaned children | descendants of the host process | the host's scope (cgroup membership survives reparenting) | the host's |
| Gates: hook steps marked capped, `scripts/local-gate.ts`, anything an agent runs through `scripts/gate-slot.sh` (and `scripts/merge-batch.ts` once the parallel test-child lane moves it off `/var/tmp/llv-gate`) | `scripts/gate-slot.sh` | `delegatus-agents-work.slice/run-<id>.scope` | weight 100, 300%, `MemoryMax=8G` |
| Pipeline publication: `bun install --frozen-lockfile` and `git push` with every pre-push hook | `fencedExec` in `src/lib/pipelines/git.ts` | `delegatus-agents-work.slice/delegatus-work-publish-{install,push}-<id>.scope` | weight 100, 300% |
| Self-update install and build of a new release | `realPorts().run` in `src/lib/selfUpdate/steps.ts` | `delegatus-agents-work.slice/delegatus-work-update-{install,build}-<id>.scope` | weight 100, 300% |
| Viewer, runtime host, launcher, scan and search workers, recovery controller, self-update git fetch and checkout, pipeline provisioning git | production | `delegatus.service` | the service's (weight 1000 after the installation files) |
| The installed `/var/tmp/llv-gate` | outside the repository | `app.slice/run-<id>.scope` | none; it shares the gate slots (below) |
| Legacy tmux panes | the tmux server | the tmux server's scope | none |
| Docker image builds and rehearsals (`deploy-staging`, `verify-candidate`) | the Docker daemon | the daemon's cgroups | none (see "Not covered") |

`systemd-run --scope` executes the command in place, so the PID, process group
and inherited descriptors of every wrapped command stay the caller's: kill
paths, identity checks and the publication lock descriptor work unchanged.

## Classification

A structured host is work when its conversation holds a `pipeline` or `flow`
membership; every other host serves the operator, orchestrator seats included.
Headless runs are always work. The membership is written with the spawn receipt,
before the host starts, and a resumed host reads the same canonical
conversation, so a stage keeps its class across restarts.

## Independent of the memory mode, explicit when missing

`planAgentCpu` (`src/lib/runtime/cpuPlacement.ts`) decides placement apart from
`DELEGATUS_AGENT_MEMORY`. A host in memory mode `watchdog` or `off` still gets a
CPU scope; with memory off the scope carries no memory properties.

Where the mechanism should exist (Linux outside a container) and cannot be used
(no reachable user manager, the cpu controller not delegated, systemd older than
242, a refused probe scope, a refused work slice quota), work is refused with
the reason and the setting that opts out:

> CPU containment for agent work is unavailable: the systemd user manager does
> not delegate the cpu controller. Set DELEGATUS_AGENT_CPU=off to run work
> without CPU placement.

A pipeline stage start fails with that message; a publication fails with it as
its recorded cause and pushes nothing; a gate exits 69. Operator hosts never
wait on CPU placement and run without it, with a one-time warning. A release
build reports the message in the update log and runs in the service's CPU
domain, so production can always update itself. On macOS and inside a container
CPU placement does not apply and nothing is refused.

| Setting | Default | Effect |
|---|---|---|
| `DELEGATUS_AGENT_CPU` | `auto` | `off` turns CPU placement off everywhere, including gates |
| `DELEGATUS_WORK_SCOPE_CPU_QUOTA` | `300` | percent of one CPU per work scope |
| `DELEGATUS_WORK_CPU_QUOTA` | 75% of logical CPUs, in whole CPUs | percent for the whole work slice |

The Viewer sets the work slice's aggregate quota at runtime
(`systemctl --user set-property --runtime`) the first time it places work, and
every gate sets the same values, so the ceiling holds before the installation
files exist.

## CPU-pressure admission

Heavy work starts only when the machine's CPU pressure allows it
(`src/lib/runtime/cpuPressure.ts`, `scripts/gate-slot.sh`):

- held once `/proc/pressure/cpu` `some avg10` reaches 20%;
- released after it has stayed below 10% for ten seconds;
- after 120 s of holding, the reason changes to "deferred" and stays visible;
- a failed sample admits: the scope quotas still bound the work.

A pipeline stage start is held before its spawn reservation, so a stage starts
exactly once after admission and a stage that already launched is never held.
The pipeline shows the reason in its detail line, for example
`stage start held for CPU pressure since 2026-10-06T12:00:00.000Z (avg10 45% ≥ 20%)`,
and wakes itself every five seconds to check again. A gate prints
`gate-slot: held for CPU pressure: …` before it waits and
`gate-slot: deferred by CPU pressure for 120s …` once the budget is spent.

Operator sends, receipt reconciliation, staged-launch recovery and the delivery
queue never consult admission. `DELEGATUS_CPU_PRESSURE=off` turns it off;
`DELEGATUS_CPU_PRESSURE_HOLD` and `DELEGATUS_CPU_PRESSURE_RELEASE` tune the
thresholds. Tune them from measurements: while this change was built, the
incident machine read 14–24% with dozens of agents and no incident.

## One gate lock namespace

`scripts/gate-slot.sh` locks `/var/tmp/llv-heavy-gate.slot<N>.lock`, the files
the installed `/var/tmp/llv-gate` uses, so both gates count against the same six
slots. `LLV_GATE_LOCK_DIR` still overrides the directory, and the hooks pass the
shared directory into their isolated environment.

## Installation files (written by the operator, applied at a quiet moment)

`bin/install-cpu-placement.mjs` writes three files into
`${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user`. It writes files only and
prints the steps that apply them:

`delegatus.service.d/cpu.conf`

```ini
[Service]
Slice=delegatus.slice
CPUAccounting=yes
CPUWeight=1000
```

`delegatus-agents.slice.d/cpu.conf`

```ini
[Slice]
CPUAccounting=yes
CPUWeight=100
```

`delegatus-agents-work.slice` (the quota is computed from the CPU count)

```ini
[Unit]
Description=Delegatus test and pipeline workloads

[Slice]
CPUAccounting=yes
CPUWeight=100
CPUQuota=1800%
CPUQuotaPeriodSec=20ms
```

```sh
node bin/install-cpu-placement.mjs            # --unit NAME.service if the service has another name
systemctl --user daemon-reload
# Moving the service into delegatus.slice takes a restart; run it after hosted agents finish:
systemctl --user restart delegatus.service
systemctl --user show delegatus.service -p Slice -p CPUWeight
systemctl --user show delegatus-agents-work.slice -p CPUWeight -p CPUQuotaPerSecUSec -p CPUQuotaPeriodUSec
systemd-cgls --user-unit delegatus.slice
cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/delegatus.slice/cgroup.subtree_control
```

Production and the agents branch then share `delegatus.slice`, which makes the
1000:100 weights a real comparison. No root is needed. None of this has been
applied on the incident machine; moving the running service waits for the
operator.

## Optional, root only: dedicated CPUs for production

Weights and quotas need no root. Keeping work off a set of CPUs entirely needs
the cpuset controller, which the system manager must delegate first. Check the
topology, then pick whole SMT sibling pairs for production (on the incident
machine CPUs 0–5 are three complete pairs):

```sh
lscpu -e=CPU,CORE,SOCKET
sudo mkdir -p /etc/systemd/system/user@.service.d
sudo tee /etc/systemd/system/user@.service.d/cpuset.conf <<'EOF'
[Service]
Delegate=cpu cpuset memory pids
AllowedCPUs=0-23
EOF
sudo systemctl daemon-reload
# The delegation takes effect when the user manager restarts (log out every session, or reboot).
```

Then, as the user:

```sh
mkdir -p "$HOME/.config/systemd/user/delegatus.service.d" "$HOME/.config/systemd/user/delegatus-agents-work.slice.d"
printf '[Service]\nAllowedCPUs=0-5\n' > "$HOME/.config/systemd/user/delegatus.service.d/cpuset.conf"
printf '[Slice]\nAllowedCPUs=6-23\n' > "$HOME/.config/systemd/user/delegatus-agents-work.slice.d/cpuset.conf"
systemctl --user daemon-reload
systemctl --user restart delegatus.service      # at a quiet moment
cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/cgroup.subtree_control
grep Cpus_allowed_list /proc/$(systemctl --user show -p MainPID --value delegatus.service)/status
```

Verify the effective `cpuset.cpus.effective` at every ancestor and the allowed
CPU list of a sample process in each scope.

## Not covered

- **Docker.** Image builds and the release rehearsal run in the Docker daemon,
  outside every user scope. Covering them needs CPU flags on those containers or
  a constrained build worker, and a host-wide guarantee has to count
  daemon-executed work. No evidence ties Docker to the incident.
- **The installed `/var/tmp/llv-gate`.** It lives outside the repository and
  places its scopes in `app.slice` without CPU controls. It shares the slots;
  first-party callers move to `scripts/gate-slot.sh`.
- **Owned test runners** (the parallel test-child lane runs each test file in a
  transient `delegatus-gate-<uuid>.service`). When both changes are on main,
  that unit takes `--slice=delegatus-agents-work.slice` and
  `cpuScopeProperties` from `src/lib/runtime/cpuPlacement.ts`, the same
  properties `gate-slot.sh` passes today.

## Verification

All tests run by path with isolated state; the real-cgroup tests create private
`llvcputest…` slices and scopes and remove them, and never touch
`delegatus.slice`, the live agent slices or a service unit.

- `src/lib/runtime/cpuPlacement.scope.test.ts`: real transient scopes. An
  operator scope reads `cpu.weight 1000` and `cpu.max max 100000`; a work scope
  reads `cpu.max 60000 20000` under a slice reading `360000 20000`, with its
  memory ceiling and `memory.swap.max 0`; an ordinary descendant and an
  intentionally orphaned `setsid` child keep the work cgroup, and stopping the
  unit by its recorded name ends all of them; memory mode off still gets the
  quota; publication, release build, a headless run and `gate-slot.sh` land in
  the work slice with the same controls.
- `src/lib/runtime/structuredSpawn.cpuPlacement.test.ts`: the real
  `defaultStartHost` gives pipeline and flow members the work placement and
  operator hosts the agents slice, and refuses a pipeline host when the
  mechanism is missing.
- `src/lib/pipelines/git.test.ts`: publication runs install and push in work
  scopes and pushes nothing when the mechanism is missing.
- `src/lib/pipelines/engine.test.ts`: CPU pressure holds a stage start with a
  visible reason, defers after 120 s, releases one launch after ten seconds
  below 10%, never holds a launched stage, and admits on a failed sample.
- `scripts/gate-slot.test.ts`: work slice and quotas, the explicit refusals,
  the hold, deferral and single start, and admission on a failed sample.
- `src/lib/runtime/cpuPlacement.test.ts`, `cpuPressure.test.ts`,
  `agentMemory.test.ts`, `bin/install-cpu-placement.test.ts`,
  `src/lib/selfUpdate/steps.test.ts`, `scripts/local-gate.test.ts`.
