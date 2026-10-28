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
      ├─ delegatus-release-*.scope   release preparation: CPUWeight=1000, no CPU ceiling
      └─ delegatus-agents-work.slice CPUWeight=100, CPUQuota=75% of the online CPUs
         ├─ delegatus-agent-*.scope  pipeline and flow hosts, headless runs, work tmux panes: CPUWeight=100, CPUQuota=300%
         ├─ delegatus-work-*.scope   publication install and push, workflow setup
         └─ delegatus-gate-*.service  gates: CPUWeight=10, IOWeight=10
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
| Gates: hook steps marked capped, `scripts/local-gate.ts`, anything an agent runs through `scripts/gate-slot.sh` | `scripts/gate-slot.sh` | `delegatus-agents-work.slice/delegatus-gate-<id>.service`, also for an agent in a signal domain, whose command enters the agent's namespaces | CPU weight 10, I/O weight 10, 300%, `MemoryMax=14G` |
| Merger gates: every local gate, the bisect runs and the trusted privacy checks of `scripts/merge-batch.ts` | `gateCommand` and `trustedPrivacy`, through the `gate-slot.sh` beside the script | `delegatus-agents-work.slice/delegatus-gate-<id>.service`, also for an agent in a signal domain, whose command enters the agent's namespaces | CPU weight 10, I/O weight 10, 300%, `MemoryMax=14G` |
| Workflow setup (`bun install` in the built-in template, any command a template names) | `startSetup` in `src/lib/workflows/provision.ts` | `delegatus-agents-work.slice/delegatus-work-workflow-setup-<id>.scope` | weight 100, 300% |
| Pipeline publication: `bun install --frozen-lockfile` and `git push` with every pre-push hook | `fencedExec` in `src/lib/pipelines/git.ts` | `delegatus-agents-work.slice/delegatus-work-publish-{install,push}-<id>.scope` | weight 100, 300% |
| Package install of a packaged release | `realPorts().run` in `src/lib/selfUpdate/steps.ts` | `delegatus-agents-work.slice/delegatus-work-update-package-<id>.scope` | weight 100, 300% |
| Self-update dependency install and compilation | `realPorts().run` / `wrapReleaseCommand` | `delegatus-agents.slice/delegatus-release-<id>.scope` | weight 1000, no CPU ceiling; immediate admission |
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
| `DELEGATUS_WORK_CPU_QUOTA` | 75% of the machine's online CPUs, in whole CPUs | percent for the whole work slice |

The Viewer sets the work slice's aggregate quota at runtime
(`systemctl --user set-property --runtime`) the first time it places work, and
every gate sets the same values, so the ceiling holds before the installation
files exist. The Viewer, the gates and the installer all count the machine's
online CPUs (`os.cpus()`, `getconf _NPROCESSORS_ONLN`) and ignore the caller's
CPU affinity, so a service pinned with `AllowedCPUs=` sets the same ceiling a
gate does.

## CPU-pressure admission

Pipeline stage starts and heavy commands share one durable priority queue file
(`src/lib/runtime/cpuAdmission.ts`, `scripts/cpu-admission.ts`) and wait in
two lanes inside it: ownerless start tickets (stages, workflows) and owned
command tickets (gate-slot checks, publication installs, release steps). A
ticket's position counts only tickets of its own lane. Within a lane tickets
sort by effective class, then by their original insertion sequence. The
effective class starts at the task priority (high, normal, low) and rises one
level for every ten minutes the ticket has waited ("Bounded turn for old work"
below). A lane uses the highest priority among its linked board tasks;
unlinked work is normal. Each admission refreshes waiting bindings with indexed
lookups of those task rows' priority fields. Priority changes retain the ticket's
sequence and age. Stage agents, publication installs, commit hooks and push gates
carry the installation's task binding across sandboxed child environments.
The binding and priority persist alongside the ticket for restart recovery.
After gate admission, the test preload drops that binding before fixtures run,
so their priority reads stay inside their own state roots.
Per-stage urgency remains a follow-up.

Stage and workflow admission retains its ten-minute fairness bound. A local
heavy check requires a permissive measured sample at readiness and again when
it claims a free slot, even after ten minutes and after its helper restarts.
Its ticket records that rule (`low_pressure`). A ticket past its own bound that
does not need low pressure passes such tickets in its lane, so a check held by
pressure never holds a publication install beyond the install's bound. A stage
never waits on a check at all, because the two sit in different lanes. Checks
keep FIFO within their effective class.
The gate samples PSI asynchronously; if PSI is unreadable or malformed, it
requires the one-minute load divided by online CPUs to be below 0.75. If both
metrics are unavailable, it waits. `DELEGATUS_CPU_PRESSURE=off` explicitly
disables sampling. A stable reason is logged once per hold; polling yields
the event loop. Nested commands retain their validated parent's slot.
Admissions remain separated by two seconds.

Every local `delegatus-gate-*.service` starts with `CPUWeight=10` and
`IOWeight=10`, including commands launched directly through `owned-runner.ts`,
CPU-placement opt-outs and namespace handoffs. These properties are independent
of the work slice's existing weight 100 and quotas. The serving unit's installed
weight stays 1000; a runtime host owned by that unit shares its weight.
`scripts/gate-properties.test.ts` passes the produced arguments to the real
user manager and checks the unit's reported properties, or skips if no manager
is reachable. Kernel enforcement still requires delegated controllers, as
described above.
The stage/workflow pressure sensor holds at `some avg10` of 30% and releases
after ten seconds below 20%; its failed sample permits the head. Heavy checks
use the stricter measurement policy above. CPU quotas still bound admitted work.
The displayed time is the time already waited, measured from the ticket's
durable `since`; no estimate of the remaining wait is shown, because neither
the slots nor the pressure promise one.

SQLite writer transactions preserve queue order, original wait timestamps and
the last admission across Viewer restarts and across processes. Stage tickets
use the pipeline, stage and attempt; controller ticks remove tickets for stages
that paused, closed or moved on. Workflow tickets use a separate state-directory
namespace with one key for setup and one per stage. Paused workflows and
automatic starts held by an update keep their queue order and wait age while
their tickets are suspended; eligible callers can pass them. Closing a workflow
or leaving a phase removes its ticket. Workflow ticks and control changes
reconcile these durable records, including after restart. Command tickets carry the waiting shell's
kernel start identity; dead callers lose their tickets. The queue lives under
the operating-system user's `$HOME/.cache/delegatus-cpu`, shared with the
Viewer container even when a child sandboxes HOME. `LLV_GATE_LOCK_DIR` puts a
private queue alongside private slot locks for tests.

Only the live installation waits in that machine queue: the instance whose
state directory is `$HOME/.config/delegatus/state` of the operating-system
user (or its `agent-log-viewer` spelling, or a link to either). Every other
instance keeps its queue in `<state>/cpu-gate`, whatever started it and
whatever owner token it carries (`src/lib/runtime/cpuAdmissionScope.ts`): a
test's `LLV_STATE_DIR`, a staging instance on `state-staging`, a fixture state
nested inside the live one, a driver's own `HOME` or `XDG_CONFIG_HOME` wherever
it sits, a spawned agent's sandbox, any test or build process. A place under
the operator's config root earns nothing by itself. `scripts/gate-slot.sh`
stays on the machine queue from any environment: its command tickets end with
their owner. An installation that keeps its real state anywhere else gets its
own queue too; `LLV_GATE_LOCK_DIR` set to one directory for the Viewer and for
gate-slot joins them again.

A stage ticket has no process behind it, so every check records its poll. An
ownerless ticket nobody has polled for 60 seconds is passed over by every
checker. Its row stays, so an instance that was only restarting returns to its
sequence and age with its next check, and the spacing between admissions still
holds. After 24 hours without a poll, a ticket no fence holds is removed.

A release that predates polls shares the file for as long as it serves, and
its statements are fixed, so the queue keeps this state where that release
already looks. A passed-over ticket gets a row in `suspended`, which every
release skips, and one in `unpolled`, which tells it from a fence's hold and
lets the 24-hour removal reach it. Triggers in the file record the rest for
every connection: the insert each check repeats records the poll and ends the
passing over; a fence's hold replaces the passing over, and its release gives
the ticket one fresh 60-second bound; a reconcile leaves the passing over in
place and the ticket's own check ends it; a removed ticket takes its rows along. The
column, the table, the triggers and the first bound of the tickets already
queued commit in one writer transaction that reads the schema under its lock,
so two releases opening the file together never see part of it. On
2026-10-13 two stage tickets left by a test's child processes held the head of
the machine queue for 1 h 45 min; nothing reconciled them, because each
release reconciles only its own namespace.

A command ticket ends with its owner, but only an owner the kernel can judge.
One recorded in another PID namespace, such as a sandboxed gate that lost its
signal-sandbox marker, reads as unverified forever: no PID lookup here can
prove it alive or dead, and a head ticket left that way held the machine queue
for more than six hours while lanes read "stalled". Its polls now stand for
it as for a stage ticket. The poll trigger stamps owned tickets too, so a
release that predates this records them as well. An unverified owner that has
not checked in for 60 seconds is passed over, and after 24 hours removed. A
dead owner is removed as before. Each of these writes one line naming the
ticket and the reason. An owner the kernel shows alive keeps its place however
long it stays silent. Passing a ticket over changes only the order: a start
still needs its slot lock and the spacing.

When the head of a ticket's lane is past its ten-minute bound and nothing has
been admitted on the machine for a minute since, the wait no longer promises minutes: the state detail reads
`Waiting for the CPU queue · 7th · stalled for 62 min · high priority`, the card says the
queue is stalled, and gate-slot prints the same line.

A stage waits before its spawn reservation and wakes every five seconds. Its
state detail and board card name the queue position, what holds it, and the
whole minutes already waited:
`Waiting for the CPU queue · 2nd · waited 7 min · high priority`, or
`Waiting for the CPU queue · 1st · held by CPU pressure · waited 4 min · high priority`
(the card: `Чекає черги CPU · 2-й · чекає 7 хв · Високий`). A waiting card
suppresses the generic working caption. A launched stage continues
reconciliation without asking for admission.

Heavy checks retain their ticket until a slot is locked and their admission is
committed, so a younger check in the same effective class cannot overtake one
waiting for a slot. Waiting uses no heavy slot, and a check waiting for a slot
holds back only other commands, never a stage start. The owned runner's execution deadline starts after admission.
On Linux, nested work continues its parent's existing admission only while the
kernel proves the owner's start identity, lock inode and exclusive descriptor
lock. The owned runner carries that proof through service handoff. This keeps
dependent work from waiting for the slot its own parent holds; fresh jobs still
join the priority queue, and every command retains owned process cleanup.
Nested waits report heartbeat intervals to private ledgers owned by bounded
callers; concurrent intervals count once. The Git executor, hook plan and owned
runner exclude those intervals from their finite execution budgets. Per-file
test comparisons keep an independent execution guard with the existing cleanup
allowance, and exclude waits from batch and flaky-retry clocks. Cancellation
still stops waiting immediately. The Linux service uses a kernel watchdog to
bound an unresponsive supervisor while its execution timer excludes queue time.
The stage-output commit retry policy belongs to the separate settlement change.

Publication installs and release steps using `waitForCpuPressure` also take
command tickets and show the same queue reason. Closing their operation aborts
the wait. Their own operation-level limits remain in effect; gate-slot command
and hook budgets exclude admission waits.

Operator sends, receipt reconciliation, staged-launch recovery, the delivery
queue, publication reconciliation, update observation and setup and stage
observation never consult admission. `DELEGATUS_CPU_PRESSURE=off` bypasses the pressure hold;
`DELEGATUS_CPU_PRESSURE_HOLD` and `DELEGATUS_CPU_PRESSURE_RELEASE` tune the
thresholds. Tune them from measurements: while this change was built, the
incident machine read 14–24% with dozens of agents and no incident.

## Bounded turn for old work, independent stage starts, truthful waits

Originating requirement (operator, 2026-10-11, seat chat; paraphrased from
Russian, because the verbatim chat text stays out of public files): some tasks
look as if they are in progress, but they stopped working long ago. The
accepted outcome of that requirement is bounded CPU admission with visible
progress. It was reopened on 2026-10-25 after a read-only audit reproduced
long waits on the current code.

### What the audit found, and what it did not

The audit observed the shared queue for six minutes on 2026-10-25. Its figures
are sanitized aggregates; the raw census stays outside the repository.

- Every owner was alive and verifiable, so the dead-owner and
  unverifiable-owner fixes (#3325) did not apply.
- All six heavy slots were held by working checks. CPU pressure (`some avg10`
  10.5–14.8) stayed below the 30% hold threshold.
- The queue kept moving, but every freed slot went to a high ticket. The oldest
  normal ticket, a stage start, waited 90 → 95 minutes. The oldest high ticket
  waited at most 7.0 minutes in any snapshot.
- Stage starts, which need no slot, sat behind command tickets that were at the
  head waiting for a slot.
- Card and gate text said `up to 11 min` during a 50-minute wait. The number is
  the pressure bound at the head; it does not estimate the queue.

The audit's fake-clock seam drives `CpuAdmissionQueue` on a private file. It
was rerun for this design on the pipeline base `dcf07a26` (identical in these
files to `origin/main` `6b84d8ad`). It still shows both defects: (a) a normal
ticket queued first is never admitted in 120 simulated minutes, with one high
arrival and one admission per minute; (b) a high stage ticket reads
`position: 2` behind a high command whose readiness check (`consume=false`)
answered "ready" but that has no slot. The builder reruns the same seam on the
final head and on this base and records both outputs in the private evidence
folder.

Three causes, three changes:

1. Strict priority has no age bound → **the effective class rises with age**.
2. Stages and slot-waiting commands share one order → **two lanes in the same file**.
3. The only number shown is a bound nobody enforces → **show the waited time and the cause**.

The 6-slot limit, the PSI thresholds, the worker limits, the spacing and the
pressure policies stay exactly as they are.

### 1. The age rule

```text
T = CPU_QUEUE_MAX_WAIT_MS            (10 minutes, the queue's existing fairness bound)
rank(t)  = 0 high, 1 normal, 2 low   (refreshed from the board on every check, as today)
aging(t) = 1 after this ticket's owner checks with V3; 0 for legacy owners
class(t) = max(0, rank(t) − aging(t) · ⌊max(0, now − since(t)) / T⌋)
order within a lane = (class, fifo_seq)
```

An aging-aware ticket's effective class rises by one level for every full `T`
it has waited. Normal reaches high after 10 minutes. Low reaches normal after 10 and
high after 20. Inside a class the order stays the durable insertion sequence
(`fifo_seq`), so an aged ticket lines up behind every ticket that was queued
before it and ahead of every ticket queued after it.

**Guarantee.** Among aging-aware callers, let X be a ticket with rank `r` that
entered lane L at `t0`, with its rank staying at `r` or a smaller number during the interval.
From `t0 + r·T` on, every ticket counted ahead of X in L was queued before X.
New arrivals of any priority land behind X, and so do priority raises of
younger tickets. X's position therefore never grows from arrivals after
`t0 + r·T`. X is admitted no later than the (k+1)-th admission in L after that
instant among callers using the same pressure policy, where k is the number
of earlier tickets of L still waiting then. The existing escape for a bounded
publication command can pass low-pressure-only checks; those bypass admissions
do not count toward a heavy check's admission bound. This holds as long as X
keeps checking (stages every 5 s, gate helpers every 2 s)
and L's own admission conditions hold that many times:

- Start lane: the CPU-pressure gate allows a start, or the head is past its own
  10-minute bound (the existing stage rule, unchanged), plus spacing.
- Command lane: a slot is free, and measured pressure is low at readiness and
  at claim, plus spacing.

There is no wall-clock promise for heavy checks. Occupied slots or a
nonpermissive measured pressure sample can hold them indefinitely, and the
waiting text names that cause (§3). The start lane retains its existing escape
at the head's ten-minute bound, with spacing and worker limits still applying.

**Before aging, urgent work keeps its preference.** A high ticket that arrives
while X is still younger than `r·T` is ordered ahead of X. So for one full
`T` per level, a new urgent ticket keeps exactly the preference #3129 gave it.
Board priority changes still take effect at the next check: raising X to high
makes its class 0 at once, and lowering an aged ticket recomputes its class
from the new rank and the same age. A priority decrease can postpone reaching
class 0, but every ticket reaches it by `2T` whatever its task rank becomes.

**Why 10 minutes.** It is the bound the queue already promises stages
(`CPU_QUEUE_MAX_WAIT_MS`, also the stall reference), so one number keeps one
meaning and no setting is added. In the audit, high work was admitted within
7.0 minutes at most, under its own load, so a 10-minute step keeps high's
preference in the observed regime and caps the extra wait of normal work at
one step plus the earlier queue. A smaller step, such as 2–5 minutes, would
erase high's preference under ordinary load. A larger one, such as 30 minutes,
would leave the observed 90-minute waits at 30 minutes plus the queue. Aging
by level reuses the accepted priority mechanism. Simpler alternatives fail:
counter-based schemes (every n-th admission reserved for lower levels) need new
durable state that older clients cannot see, and pure deadline sorting
(`since + rank·T`) could reorder tickets of one level when the clock steps
back. `class` keeps FIFO on `fifo_seq` exactly.

Age is measured from `since`, which only the first insert of a key writes
(`INSERT OR IGNORE`). A priority change, a fence's suspension, a pass-over and
a restart all keep it. A cancelled ticket that queues again gets a new `since`.
A stage retry is a new attempt key. So no ticket inherits another's age. A
stage suspended by a fence (update drain, memory wait) keeps aging while it is
held, as it keeps its order today. When it returns it may be ahead of younger
tickets, but never ahead of older ones: it is one of the "earlier tickets"
the guarantee already counts.

### 2. Two lanes in one file

`lane(t) = start` when `owner IS NULL` (stage and workflow keys), otherwise
`command`. The rule needs nothing new on disk. Every release since the queue
existed writes stage and workflow tickets without an owner, and every command
ticket with its owner's identity. It is already the distinction the queue uses
for polls, pass-overs and `stage_admissions`.

- A ticket's `position`, its `head` (for stall detection) and the low-pressure
  passing rule count only tickets of its own lane.
- The spacing row (`admission.last`) stays shared. No two admissions of any
  lane or any release are closer than 2 s, so a stage start and a check claim
  still never land together. Stall detection keeps reading that same row; the
  stalled text reads "nothing started" for the machine.
- Pressure is checked per caller, as today. A stage start uses the stage
  sensor and its 10-minute rule. A gate check uses the strict measured policy at
  readiness and claim. Separating the lanes skips neither.
- Slots stay kernel locks. A gate command runs only after `flock -n` on a slot
  descriptor and a committed `--claim`. The queue never grants a slot, so the
  6-slot limit holds whatever order any version computes.

Effect on the audit's case: a stage behind a high command that is waiting for a
slot now starts once the stage's own pressure check and spacing allow. Checks
behave as before: they wait for a slot, and FIFO holds within their effective
class.

Publication installs and release steps (`waitForCpuPressure`) keep owned
`command:` keys, so they stay in the command lane. They can wait behind a check
that is waiting for a slot, but never longer than their own 10-minute bound,
because the existing passing rule lets them pass `low_pressure` tickets. That
is the behaviour they have today; moving them is deferred.

An operator-visible consequence of the existing rule follows. The start lane's
head, once past its own 10-minute bound, starts even under pressure. Before
this change that rule was often masked, because high commands sat ahead of
stages. After it, the stages that have waited longer than 10 minutes start one
at a time, at most one admission per spacing interval and one per
pipeline-controller tick. The rule itself, and the PSI thresholds, are fenced
and unchanged; a test pins it (§6).

### 3. Waiting text

`CpuQueueWait` loses `remainingMs`. It gains `waitedMs = now − since` and
`heldBy`:

- `"queue"`: position > 1, or the head is waiting out the spacing.
- `"pressure"`: the head, with spacing clear, refused by the caller's pressure check.

`priority` (the task rank; the aged class is never shown) and `stalledMs` stay.
`remainingMs` has two consumers, `cpuQueueDetail` and the frozen
`cpuAdmission.prePoll.fixture.ts`. The fixture declares its own local return
type and stops importing `CpuQueueWait`.

Stage and workflow state detail (wire text; English, parsed by the board):

```text
Waiting for the CPU queue · 3rd · waited 12 min · normal priority
Waiting for the CPU queue · 1st · held by CPU pressure · waited 4 min · normal priority
Waiting for the CPU queue · 7th · stalled for 62 min · high priority          (unchanged)
```

Minutes are whole and rounded down, so 0 is shown as 0. The prefix is
unchanged, so `CPU_PRESSURE_DETAIL_PREFIXES`, `isCpuPressureDetail` and the
optional ` · Viewer publication: …` suffix keep working. `parseCpuQueueDetail`
returns `{ position, minutes, heldBy, stalled?, priority? }`. The old
`up to N min` form is not parsed: every waiting stage rewrites its detail at
its next 5-second tick after the deploy.

Card captions (`src/lib/i18n/en.ts`, `uk.ts`, chosen in
`src/components/kanban/PipelineSection.tsx`):

| key | en | uk |
|---|---|---|
| `kanban.progress.cpuQueue` (changed) | `Waiting for the CPU queue · {ordinal} · waited {minutes} min · {priority}` | `Чекає черги CPU · {position}-й · чекає {minutes} хв · {priority}` |
| `kanban.progress.cpuPressure` (new) | `Held by CPU pressure · {ordinal} in the CPU queue · waited {minutes} min · {priority}` | `Стримує навантаження CPU · {position}-й у черзі CPU · чекає {minutes} хв · {priority}` |
| `kanban.progress.cpuQueueStalled` | unchanged | unchanged |

Gate-slot stderr (`scripts/cpu-admission.ts`). A line is printed only when its
text changes, as today, so at most once a minute:

```text
gate-slot: Waiting for the CPU queue · 3rd · waited 12 min · normal priority
gate-slot: <pressure reason from GateCpuPressure> · 1st in CPU queue · waited 4 min
gate-slot: Waiting for a heavy command slot · all 6 busy · waited 8 min
```

The slot case is the one where the queue answers "ready" (`null`) and so
carries no `since`. `gate-slot.sh` records `queued_at=$(date +%s)` once, before
its admission loop, and passes it as a fourth argument to `--wait`. A helper
called without it counts from its own start. The shell and the helper always
come from the same checkout, so the argument needs no compatibility handling.

### 4. Mixed versions on one file

Three code versions write the machine queue today:

- **V1**, the deployed release. It serves stage checks, and stage agents use
  its gate-slot by absolute path. It orders by `(priority, seq)` over all
  tickets and knows nothing of `low_pressure`.
- **V2**, current main. It runs in merger checkouts and in lane worktrees on
  recent bases. It orders the same way and adds the `low_pressure` passing
  rule.
- **V3**, this design.

V1 and V2 keep running until the normal deploy, and until every lane
worktree's hooks come from a base containing V3.

**V3 adds one capability column.** `tickets.aging INTEGER NOT NULL DEFAULT 0`
is added under the constructor's existing writer transaction. Old rows and
inserts from old helpers leave it 0. Only the ticket's own V3 check stamps it 1,
inside the same transaction that computes and claims its turn. Opening a file,
refreshing another ticket's priority and the shared poll triggers never opt
another owner into aging. A cold row retains its age and FIFO; its first check
from an upgraded owner enables aging immediately. Cancellation deletes the
marker with the ticket, so a reused key starts with the inserting client's
capability.

`priority` keeps holding the task rank. V3 never writes an aged class into it:
V1 and V2 refresh that rank from the board on every check. V3 keeps maintaining
the legacy `seq` view (`tickets_fifo`, `orderLegacyTicketsByPriority`) unchanged.
It computes `class` and `lane` inside its own queries. Unmarked rows use their
stored task rank, so a V3 caller never waits behind a legacy row solely because
of age the legacy checker cannot act on. Without this capability, an old normal
and a new high can each put the other first after ten minutes and deadlock.

What holds with all three versions at once:

- **Slot count.** At most `LLV_GATE_SLOTS` commands hold slots. The kernel lock
  enforces it, and no version can claim without its descriptor.
- **Spacing.** Every version reads and writes `admission.last` inside an
  IMMEDIATE transaction, so admissions stay ≥ 2 s apart.
- **One owner per ticket.** Keys are unchanged. V3 never rewrites an old row's
  owner, key, `since` or `fifo_seq`.

What does not hold yet during the transition is fairness. A V1 or V2 checker
still orders by task rank. It can claim ahead of a V3 ticket that has aged into
its class, and a V1 Viewer still holds stages behind commands. Both versions
have only these powers today, and they end as their processes are replaced.
When an aged V3 ticket and a V2 ticket both see themselves at the head of the
command lane, the free slot goes to whichever takes the `flock` first. The
spacing then separates the two claims.

**Overlap with #3315.** That open change adds SQLite busy retry under one
deadline. It is based before #3338 and already conflicts with main on its own.
It restructures the `CpuAdmissionQueue` constructor and adds a seventh
parameter, `busyTimeoutMs`. It wraps the helper's checks in `admissionLockWait`
and adds `claim()` to `gate-slot.sh`. This design adds the capability column
in the constructor's existing schema transaction and changes `check()` and
`cpuQueueText.ts`; in the helper it changes the text expression and the argv
read; in the shell it changes the `--wait` line. It adds no constructor
parameter: the age step is the existing `maxWaitMs`. Whichever lands second merges main append-only, keeps the
other's wrapper and claim function, and reruns `scripts/gate-slot.queue.test.ts`.
Draft #2926 is stale (last updated 2026-10-15), and its queue edits are already
on main.

### 5. Invariants the builder keeps

1. The command lane admits only position 1 of that lane, only while a slot
   descriptor is locked, and only after a permissive measured sample at
   readiness and at claim (`requireLowPressure`).
2. The start lane admits only position 1 of that lane, when the stage pressure
   check allows it or the ticket is past its own bound. A stage admission
   remains recoverable through `stage_admissions` until its checkpoint.
3. No two admissions in the file are closer than `spacingMs`.
4. Position counts only same-lane, unsuspended tickets that are not already
   admitted, ordered by `(class, fifo_seq)`. The low-pressure passing rule
   applies only within the lane.
5. Only a ticket's first insert sets `since`. Nothing makes a ticket older than
   its own wait.
6. The additive capability column defaults to legacy ordering. Existing
   columns, triggers, indexes and the legacy `seq` view retain V2 semantics.
7. Cancellation, dead-owner removal, the unverified and unpolled pass-overs,
   suspension, reconcile and the 24-hour removal are unchanged.
8. Waiting text never shows a remaining-time estimate. It shows the cause and
   the time already waited.

### 6. Code areas and tests

Code: `src/lib/runtime/cpuAdmission.ts` (schema capability, `check()`,
the `CpuQueueWait` type),
`src/lib/runtime/cpuQueueText.ts`, `src/lib/runtime/cpuPressure.ts`
(`cpuPressureHoldDetail`), `scripts/cpu-admission.ts`, `scripts/gate-slot.sh`
(the `--wait` line), `src/components/kanban/PipelineSection.tsx`,
`src/lib/i18n/en.ts` and `uk.ts`, `src/lib/runtime/cpuAdmission.prePoll.fixture.ts`
(its return type). The engines need no change: they pass the hold through
`cpuPressureHoldDetail`. The per-check cost stays a scan of the waiting tickets
inside the transaction that already scans them for owners and priorities. No speed claim is made.

Every case below uses a fake clock and a private queue file. All of them are
behavioural. Existing cases whose expectations encode the old order or text
are rewritten in place. "A stage and a heavy check share FIFO" becomes the
lane-independence case below. The `remainingMs` expectations become `waitedMs`
and `heldBy`.

`src/lib/runtime/cpuAdmission.fairness.test.ts` and
`src/lib/runtime/cpuAdmission.test.ts`:

- **Sustained high arrivals.** A normal and a low ticket are queued first. One
  owned high ticket arrives per simulated minute, one admission is allowed per
  minute, and pressure is permissive. New highs are admitted ahead of both
  until the normal ticket reaches `T`. The normal is admitted at the first
  admission after it reaches class 0 and the highs queued before it are gone.
  The low is admitted after it reaches `2T` in the same way. This is the
  audit's case (a) inverted.
- **Preference before aging.** A high arriving while a normal is 9 minutes old
  is admitted first. A high arriving after the normal is 10 minutes old waits
  behind it. A high queued before the normal stays ahead of it.
- **FIFO within the effective class.** Two normals and two lows age into
  class 0 among high tickets. Admission order equals `fifo_seq` order within
  class 0, including with checks run in reverse order.
- **Dynamic priority.** A 5-minute-old normal raised to high is at once class 0
  in FIFO place. A 15-minute-old low competes with normals in FIFO. A
  12-minute-old normal lowered to low falls to class 1. `since` and
  `fifo_seq` never change.
- **No wall-clock promise.** Under continuous pressure, an aged command ticket
  with `requireLowPressure` is never admitted (`heldBy: "pressure"`). A stage
  under its bound is held. A stage past its bound at the head of the start lane
  is admitted. That pins the existing rule.
- **Lane independence.** The audit's case (b): an owned high command checks
  with `consume=false`, answers ready and holds no slot. A normal stage then
  checks and is admitted after spacing. An owned command never counts a stage,
  and a stage never counts an owned command. A stage admission followed by a
  command claim within `spacingMs` is refused.
- **Mixed versions.** A frozen copy of the V2 class, `cpuAdmission.v2.fixture.ts`
  (the class at `dcf07a26`, only its name changed, like the existing pre-poll
  fixture), and V3 share one file:
  - V3 adds only the capability column, leaving legacy triggers and indexes
    unchanged; V2 can reopen the upgraded file;
  - after V3 checks, every row's `priority` still equals its task rank;
  - V2's positions for its own command tickets match strict
    `(priority, fifo_seq)`;
  - spacing holds across a V2 claim and a V3 stage admission;
  - each version checks and claims only its own tickets across both aging
    steps, in either poll order; old normal/new high and old low/new normal
    both drain immediately when slots free, with shared spacing;
  - neither version removes or rewrites the other's live ticket.
- **Cold start.** V3 opens a file that the pre-poll fixture or V2 created, with
  rows whose `since` is 25 minutes old. Legacy rows keep task rank until their
  own upgraded checker polls, then their full durable age applies.
- **Fencing.**
  - Cancelling an aged ticket and checking the same key again gives a fresh
    `since`.
  - A dead owner's aged ticket is removed with its one reason line.
  - An unpolled aged stage is passed over, then returns to its place, behind
    earlier tickets and ahead of later ones.
  - A suspended stage keeps its age.
- **Text.** `cpuQueueDetail` and `parseCpuQueueDetail` round-trip the queue,
  pressure and stalled forms, with and without the Viewer-publication suffix.
  The old `up to` form and an unknown suffix parse to `null`.

Other tests:

- `scripts/gate-slot.queue.test.ts`, with the real `gate-slot.sh` and helper on
  a private `LLV_GATE_LOCK_DIR`, `LLV_GATE_SLOTS=1` and a fake PSI file:
  - a first command holds the slot, and a second prints
    `Waiting for a heavy command slot · all 1 busy · waited 0 min`;
  - a V3 stage check on the same queue file is admitted meanwhile;
  - a holder count sampled from the lock files never exceeds 1;
  - under high fake pressure an aged command stays held, and its line names the
    pressure reason.
- `src/lib/pipelines/engine.cpuQueue.test.ts`: a pending stage behind an owned
  command ticket waiting for a slot launches. A held stage's `stateDetail`
  shows the queue and pressure forms with waited minutes.
- `src/components/pipelines/cpuQueue.test.ts`: the queue and pressure captions
  in en and uk.
- Rendered evidence, through the existing kanban driver only
  (`src/components/kanban/kanbanBoard.browser.test.tsx` over
  `issue1695Evidence.fixture.tsx`): update the `cpu-queue` scenario's text and
  add a `cpu-pressure` scenario, in en and uk, light and dark. No new driver.

Checks: each touched test file by path through `scripts/gate-slot.sh`, one at
a time. Each run isolates `HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and
`LLV_STATE_DIR`, with `LLV_VIEWER_CONTROL_URL` on a closed port. Then
typecheck, lint on changed files, the privacy-publication gate, and the
audit's seam on the final head and on `dcf07a26`, with outputs kept privately.
Expected seam output on the final head: (a) the normal ticket is admitted near
minute 10; (b) the stage check returns `null`.

### Deferred — not currently justified

- **Teaching V1 and V2 the age rule.** That would mean writing aged classes
  into `priority`, which those clients overwrite with the task rank on every
  check. The transition ends as their processes are replaced.
- **Per-lane spacing or per-lane stall detection.** That needs a second
  admission row that older clients cannot read. Machine-wide "nothing started"
  is still true as worded.
- **Moving publication installs and release-step waits into the start lane.**
  No evidence shows them waiting, and the existing passing rule already bounds
  their wait behind slot-waiting checks at 10 minutes.
- **A remaining-time estimate.** Neither slot turnover nor pressure gives one
  that is honest.
- **Raising `LLV_GATE_SLOTS`.** The audit lists it as a hypothesis, and it is
  fenced here; it needs its own before/after measurement.
- **Admission history in the queue file.** The audit could not tell admitted
  tickets from cancelled ones, but nothing in this fix needs it.

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
# Moving the service into delegatus.slice takes a stop and a start after hosted agents
# finish. A restart is not enough: while any process the stop spared stays in the old
# cgroup, systemd reuses that path and the service never moves (2026-10-10, 2026-10-11).
# A checkout installation runs scripts/deploy-checkout.py (docs/deploy-checkout.md),
# which also retires proven leftovers. By hand, exit cleanup submits start on
# success, stop/wait errors (including under errexit), and HUP/INT/TERM:
(
  trap 'status=$?; trap - EXIT HUP INT TERM; systemctl --user start "delegatus.service" || exit $?; exit "$status"' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  systemctl --user stop delegatus.service || exit $?
  for _ in $(seq 60); do
    group=$(systemctl --user show delegatus.service -p ControlGroup --value) || exit $?
    [ -z "$group" ] && break
    sleep 1 || exit $?
  done
)
# ControlGroup must end in delegatus.slice/delegatus.service. Slice alone reads the
# configuration.
systemctl --user show delegatus.service -p Slice -p ControlGroup -p CPUWeight
systemctl --user show delegatus-agents-work.slice -p CPUWeight -p CPUQuotaPerSecUSec -p CPUQuotaPeriodUSec
systemd-cgls --user-unit delegatus.slice
cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/delegatus.slice/cgroup.subtree_control
```

Production and the agents branch then share `delegatus.slice`, which makes the
1000:100 weights a real comparison. No root is needed. None of these files has
been applied on the incident machine; moving the running service waits for the
operator.

Runtime values are a separate matter. Once a checkout carries this change, every
gate it runs creates `delegatus-agents-work.slice` at runtime and sets
`CPUWeight=100`, the aggregate `CPUQuota` and `CPUQuotaPeriodSec=20ms` as
drop-ins under `$XDG_RUNTIME_DIR/systemd/user.control`; they last until the
user manager restarts, and production stays where it is. While this change was
built, pre-push gates of its own lane set those values on the incident
machine's live work slice, the last time on 2026-10-07 at 00:26 UTC. The slice
held no process; the three drop-ins were removed with
`systemctl --user revert delegatus-agents-work.slice` and the empty slice was
stopped. The production unit was not touched.

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

Until this change is merged, a gate run for it (a hook, a test run through
`gate-slot.sh`) takes a private slice, which every nested gate inherits, and
removes it afterwards:

```sh
export LLV_GATE_SLICE=llvcputestgate$$.slice
bash scripts/gate-slot.sh bun test ./scripts/gate-slot.test.ts   # and git push, which runs the hooks
systemctl --user revert "$LLV_GATE_SLICE"; systemctl --user stop "$LLV_GATE_SLICE"
# The live work slice must still read inactive with no drop-ins:
systemctl --user show delegatus-agents-work.slice -p ActiveState -p CPUWeight -p CPUQuotaPerSecUSec -p CPUQuotaPeriodUSec -p DropInPaths
```

The affinity regressions pin to the first CPU in the test's own
`Cpus_allowed_list`, so they run under a cpuset that leaves CPU 0 out.

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
  build step with the reason and no child; package pressure starts no child,
  a recovered window starts the step once, a failed sample starts it with the
  quotas, and abort ends a held start. Install and compilation bypass the pressure hold
  in its high-weight scope; progress, silence and total deadlines, process
  restart and TERM-resistant child cleanup have regression coverage.
- `src/lib/runtime/cpuPlacement.scope.test.ts`: real transient scopes. An
  operator scope reads `cpu.weight 1000` and `cpu.max max 100000`; a work scope
  reads `cpu.max 60000 20000` under a slice reading `360000 20000`, with its
  memory ceiling and `memory.swap.max 0`; an ordinary descendant and an
  intentionally orphaned `setsid` child keep the work cgroup, and stopping the
  unit by its recorded name ends all of them; memory mode off still gets the
  quota; publication, a headless run and `gate-slot.sh` land in
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
  below 20%, never holds a launched stage, and admits on a failed sample.
- `scripts/gate-slot.test.ts`: work slice and quotas, the explicit refusals
  (a scope or a work slice the kernel shows no quota for included),
  the hold, deferral and single start, admission on a failed sample, and
  pressure that rises while the gate waits for a slot.
- `src/lib/runtime/cpuPlacement.test.ts`, `cpuPressure.test.ts`,
  `agentMemory.test.ts`, `bin/install-cpu-placement.test.ts`,
  `src/lib/selfUpdate/steps.test.ts`, `scripts/local-gate.test.ts`.

## Release build admission and deadlines

Checkout self-updates install and compile with immediate admission in the release scope above.
Its weight competes with the entire low-weight agent work slice, outside that
slice's aggregate quota. Automatic release preparation keeps normal scheduling priority.
Package updates retain pressure admission and work quotas. CPU placement
still refuses a missing Linux mechanism; the explicit opt-out and platforms where
placement does not apply retain their existing behavior.

`UpdateRunner` renews a 30-minute silence deadline on nonempty command output.
Separate total deadlines (one hour for install, two hours for compilation) bound
a command that keeps printing without finishing. Each starts with its step;
release preparation has no CPU queue wait.
Expiry stops the exact generated release scope, including descendants whose
leader has exited. Its control-group kill policy allows two seconds before KILL.
The asynchronous stop call has a five-second bound; a failed stop gets one
five-second LoadState read to recognize an already collected empty scope.
Without scopes, cleanup sends TERM, waits up to two seconds, then checks the
recorded identity before KILL and another two-second exit wait.
Cleanup failure retains the original timeout cause in the deployment error. A restored running update fails
as interrupted and cannot acquire a fresh budget by restarting the Viewer.
Fetch, checkout and ready deadlines are unchanged.

The failed step and cause travel through the apply intent into the durable
checkout deployment record. A build timeout records elapsed minutes, whether
silence or the total bound expired, and the one-minute load and logical CPU count
at expiry. Older records with only timeout minutes remain readable.
`scripts/deploy-checkout.py` switches an already built and verified release;
it creates no build child and sets no build deadline.
