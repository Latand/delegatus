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
      ├─ delegatus-agent-*.scope     operator hosts and tmux panes: CPUWeight=1000, no CPU ceiling
      └─ delegatus-agents-work.slice CPUWeight=100, CPUQuota=75% of the logical CPUs
         ├─ delegatus-agent-*.scope  pipeline and flow hosts, headless runs, work tmux panes: CPUWeight=100, CPUQuota=300%
         ├─ delegatus-work-*.scope   publication install and push, release install and build, workflow setup
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
| Operator Claude, Codex and Copilot hosts (fresh, resumed and recovery successors) | `defaultStartHost` in `src/lib/runtime/structuredSpawn.ts`, through `structuredHostCell`, wrapped by `AgentMemoryCell.wrapSpawn` | `delegatus-agents.slice/delegatus-agent-<engine>-<id>.scope` | weight 1000 |
| Pipeline stage hosts and flow members (any engine, fresh or resumed) | same; `workloadForMemberships` reads the conversation's `pipeline`/`flow` membership | `delegatus-agents-work.slice/delegatus-agent-<engine>-<id>.scope` | weight 100, 300% per scope |
| Boot adoption of Codex and Claude hosts after a Viewer restart | `adoptStructuredHostsAtStartup` in `src/lib/runtime/startup.ts`, through `structuredHostCell` | by the conversation's membership, as above | as above |
| Account-migration successors (Codex and Claude) | `publishCodexSuccessorHost` and `publishClaudeSuccessorHost` in `src/lib/accounts/migration/provider.ts`, through `structuredHostCell` | by the conversation's membership, as above | as above |
| Headless runs: flow reviewers, the external relay agent, the handoff digest | `launchDetached` in `src/lib/agent/headless.ts` | `delegatus-agents-work.slice/delegatus-agent-headless-<id>.scope` | weight 100, 300% |
| Every command an agent runs: tools, MCP servers, subagents, test runs, detached and orphaned children | descendants of the host process | the host's scope (cgroup membership survives reparenting) | the host's |
| Gates: hook steps marked capped, `scripts/local-gate.ts`, anything an agent runs through `scripts/gate-slot.sh` | `scripts/gate-slot.sh` | `delegatus-agents-work.slice/run-<id>.scope` | weight 100, 300%, `MemoryMax=8G` |
| Merger gates: every local gate, the bisect runs and the trusted privacy checks of `scripts/merge-batch.ts` | `gateCommand` and `trustedPrivacy`, through the `gate-slot.sh` beside the script | `delegatus-agents-work.slice/run-<id>.scope` | weight 100, 300%, `MemoryMax=8G` |
| Workflow setup (`bun install` in the built-in template, any command a template names) | `startSetup` in `src/lib/workflows/provision.ts` | `delegatus-agents-work.slice/delegatus-work-workflow-setup-<id>.scope` | weight 100, 300% |
| Pipeline publication: `bun install --frozen-lockfile` and `git push` with every pre-push hook | `fencedExec` in `src/lib/pipelines/git.ts` | `delegatus-agents-work.slice/delegatus-work-publish-{install,push}-<id>.scope` | weight 100, 300% |
| Self-update install and build of a new release; the package install of a packaged release | `realPorts().run` in `src/lib/selfUpdate/steps.ts` | `delegatus-agents-work.slice/delegatus-work-update-{install,build,package}-<id>.scope` | weight 100, 300% |
| Viewer, runtime host, launcher, scan and search workers, recovery controller, self-update git fetch and checkout, pipeline and workflow provisioning git, observation of a running setup | production | `delegatus.service` | the service's (weight 1000 after the installation files) |
| Operator tmux panes: board task spawns (`src/app/api/tasks/[id]/spawn/route.ts`), sibling agents (`src/lib/view/siblings.ts`), resumed terminal agents (`src/lib/agent/transcriptHost.ts`) and the tmux transport of `spawn_agent` (`src/lib/agent/spawnCommand.ts`, `src/lib/runtime/structuredSpawn.ts`), whenever the conversation holds no `pipeline` or `flow` membership | `spawnAgentWithPrompt` in `src/lib/tmux.ts`, through `placePaneInCpuScope` | `delegatus-agents.slice/delegatus-agent-<engine>-pane-<id>.scope` | weight 1000 |
| Work tmux panes: workflow stage agents and fixers (`src/lib/workflows/engine.ts`), pane reviewers of a flow (`src/lib/flows/engine.ts`), any tmux launch whose conversation holds a `pipeline` or `flow` membership | same | `delegatus-agents-work.slice/delegatus-agent-<engine>-pane-<id>.scope` | weight 100, 300% |
| Transcript view windows (`tail -F` of a structured host's transcript) | `spawnCommandWindow` in `src/lib/tmux.ts` | the scope tmux gives the pane | none; it only reads a file |
| The installed `/var/tmp/llv-gate`, run by hand | outside the repository; no first-party code calls it | `app.slice/run-<id>.scope` | none; it shares the gate slots (below) |
| Docker image builds and rehearsals (`deploy-staging`, `verify-candidate`) | the Docker daemon | the daemon's cgroups | none (see "Not covered") |

`systemd-run --scope` executes the command in place, so the PID, process group
and inherited descriptors of every wrapped command stay the caller's: kill
paths, identity checks and the publication lock descriptor work unchanged.

A tmux pane is placed after `new-window` returns: tmux built with systemd moves
every new pane into its own `tmux-spawn-<uuid>.scope` before it answers, and a
scope started inside the pane earlier can lose that race. The pane's shell then
runs `exec systemd-run --scope … -- <default-shell> -l`, which keeps the pane's
PID, and the agent command is typed only once `/proc/<pane>/cgroup` names the
new scope and the pane is back at a shell. Everything the agent starts,
detached and orphaned children included, inherits that scope. A recovered pane
already in a pane scope of its own is left as it is. Until tmux's own move lands
(or when it fails, for a server that cannot reach the user bus) a new pane sits
in the tmux server's cgroup, which is an agent's scope when an agent started the
server; a pane sharing the server's cgroup is always placed.

## Classification

A structured host or a tmux pane is work when its conversation holds a
`pipeline` or `flow` membership; every other host serves the operator,
orchestrator seats included. Headless runs and workflow stage agents are always
work; a workflow names the class itself because its stages carry no membership. The membership is written with the spawn receipt,
before the host starts, and a resumed host reads the same canonical
conversation, so a stage keeps its class across restarts.

## Independent of the memory mode, explicit when missing

`planAgentCpu` (`src/lib/runtime/cpuPlacement.ts`) decides placement apart from
`DELEGATUS_AGENT_MEMORY`. A host in memory mode `watchdog` or `off` still gets a
CPU scope; with memory off the scope carries no memory properties.

Where the mechanism should exist (Linux outside a container) and cannot be used
(no reachable user manager, the cpu controller not delegated, systemd older than
242, a refused probe scope, a refused work slice quota, a scope the kernel gives
no CPU controls), work is refused with the reason and the setting that opts out:

> CPU containment for agent work is unavailable: the systemd user manager does
> not delegate the cpu controller. Set DELEGATUS_AGENT_CPU=off to run work
> without CPU placement.

The user manager accepts `CPUWeight=` and `CPUQuota=` even where an ancestor
keeps the cpu controller off (`DisableControllers=cpu`, a slice that never got
the controller); the scope then runs with no `cpu.max` at all. So the check
reads the kernel. `planAgentCpu` runs one probe scope in the agents slice that
must read `cpu.weight 1000`, and, once per work slice and quota, one probe
scope with the work properties that must read a numeric `cpu.max` for itself
and for the work slice. `gate-slot.sh` checks the scope it runs the gate in:
the command runs through the script once more inside the new scope, which
refuses with exit 69 unless the scope and the work slice above it both show a
quota. A caller already in a work scope is checked the same way.

A pipeline stage start and a work tmux pane fail with that message before any
window exists; a boot-adopted or migrated work host is left stopped with the
message in the log, and its next message relaunches it; a publication fails with it as
its recorded cause and pushes nothing; a gate exits 69; a workflow parks with
it before its setup starts; a release install or build fails its update step
with it as the step's last line and starts no child. Operator hosts never wait
on CPU placement and run without it, with a one-time warning. On macOS and
inside a container CPU placement does not apply and nothing is refused.

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
and wakes itself every five seconds to check again.

A workflow's setup and each of its stage agents are held the same way before
their first launch, with `setup held for CPU pressure since …` or
`stage start held for CPU pressure since …` in the workflow's detail line. A
held stage stamps no start, so it launches exactly once after admission; a
setup or stage that already started is observed and recovered whatever the
pressure reads.

A pipeline publication's `bun install --frozen-lockfile` waits before its child
is created, inside the publication fence. The lane's detail line shows
`publication install held for CPU pressure since …` while it waits and gets its
previous detail back once the install starts. Closing the lane or taking over
its delivery aborts the wait, and no install starts. The push that follows is
not held: its gates take slots through `gate-slot.sh`, which applies its own
admission. Remote observation and reconciliation never ask. A release install
or build waits before its child is created and writes
`update-build held for CPU pressure since …` (then `… deferred by CPU pressure …`)
into the update step's visible tail and log. The wait counts against the step's
time limit, and stopping the update ends it.

A gate samples pressure in the same pass that takes a slot: a gate that waited
behind busy slots starts on a fresh sample, and a held gate occupies no slot.
It prints `gate-slot: held for CPU pressure: …` when the hold begins and
`gate-slot: deferred by CPU pressure for 120s …` once the budget is spent.

Operator sends, receipt reconciliation, staged-launch recovery, the delivery
queue, publication reconciliation, update observation and setup and stage
observation never consult admission. `DELEGATUS_CPU_PRESSURE=off` turns it off;
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
  places its scopes in `app.slice` without CPU controls. It shares the slots.
  No first-party code calls it: the merger and its role prompt use
  `scripts/gate-slot.sh`. A command typed by hand through it stays uncovered.
- **Owned test runners** (the parallel test-child lane runs each test file in a
  transient `delegatus-gate-<uuid>.service`). When both changes are on main,
  that unit takes `--slice=delegatus-agents-work.slice` and
  `cpuScopeProperties` from `src/lib/runtime/cpuPlacement.ts`, the same
  properties `gate-slot.sh` passes today.

## Verification

All tests run by path with isolated state; the real-cgroup tests create private
`llvcputest…` slices and scopes and remove them, and never touch
`delegatus.slice`, the live agent slices or a service unit.

- `src/lib/runtime/cpuPlacement.scope.test.ts` also runs a workflow setup with
  memory mode off and its orphaned `setsid` child in a private
  `delegatus-work-workflow-setup-…` scope, and a merger gate through
  `MergeBatch` that starts no child under high pressure, then lands in the
  private work slice on the shared slot.
- `src/lib/runtime/cpuPlacement.scope.test.ts` drives `spawnAgentWithPrompt`
  on a private tmux server with a fake CLI: a workflow stage, a flow pane
  reviewer and a tmux pipeline stage land in
  `delegatus-agents-work.slice/delegatus-agent-codex-pane-…` reading
  `cpu.max 60000 20000` under `360000 20000`, with memory mode off; an operator
  pane reads weight 1000 and no ceiling; the agent's ordinary descendant and its
  orphaned `setsid` child keep the pane's scope; work refused for a missing
  mechanism opens no window.
- `src/lib/workflows/provision.test.ts` and `engine.test.ts`: a missing
  mechanism refuses the setup without a child; pressure holds the first setup
  launch and every stage-agent start with a visible reason, stamps no start,
  launches each once after ten seconds below the release threshold, never holds
  a launched setup or stage, and admits on a failed sample.
- `src/lib/selfUpdate/steps.test.ts`: a missing mechanism fails the install or
  build step with the reason and no child; sustained pressure starts no child,
  a recovered window starts the step once, a failed sample starts it with the
  quotas, and abort ends a held start.
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
  mechanism is missing. Boot adoption of both engines, with memory off and on,
  hands every host the cell of its class without sampling CPU pressure, refuses
  a work host it cannot contain, and the real adopter leaves that row dead with
  the reason logged.
- `src/lib/runtime/cpuPlacement.scope.test.ts`: boot adoption of Codex and
  Claude hosts, operator, pipeline and flow, with memory off and on, spawns
  through the adopted cell into real scopes (work `60000 20000` under
  `360000 20000`, operator weight 1000); a private slice with
  `DisableControllers=cpu` makes `planAgentCpu`, boot adoption and
  `gate-slot.sh` refuse work before it runs; the tmux case runs its private
  server inside an agent scope that cannot reach the user bus, so every pane
  starts in the server's agent scope and is still placed.
- `src/lib/accounts/migration/provider.test.ts`: a Codex or Claude migration
  successor gets the cell of its conversation's class and is refused before it
  starts when work cannot be contained.
- `src/lib/pipelines/git.test.ts`: publication runs install and push in work
  scopes and pushes nothing when the mechanism is missing; sustained pressure
  starts no install, a recovered window starts it once, a failed sample starts
  it in its scope, and closing the lane ends the wait with no install or push.
- `src/lib/pipelines/engine.test.ts`: CPU pressure holds a stage start with a
  visible reason, defers after 120 s, releases one launch after ten seconds
  below 10%, never holds a launched stage, and admits on a failed sample.
- `scripts/gate-slot.test.ts`: work slice and quotas, the explicit refusals
  (a scope or a work slice the kernel shows no quota for included),
  the hold, deferral and single start, admission on a failed sample, and
  pressure that rises while the gate waits for a slot.
- `src/lib/runtime/cpuPlacement.test.ts`, `cpuPressure.test.ts`,
  `agentMemory.test.ts`, `bin/install-cpu-placement.test.ts`,
  `src/lib/selfUpdate/steps.test.ts`, `scripts/local-gate.test.ts`.
