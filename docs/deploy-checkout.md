# Checkout switch and verdict

For a Linux checkout supervised by a user systemd service, run the committed
`scripts/deploy-checkout.py`. Python 3, Bun, Git, systemd and `ss` are required.
The procedure publishes a prepared release, then stops and starts one
explicitly named service. It observes protected pipeline stages through read-only MCP tools.

Build the exact approved target in its release directory first. Use private
state for the build and both rehearsals described in AGENTS.md. Save a private
verification JSON file containing the full `sha`, `viewer: "pass"` and
`runtimeHost: "pass"`. Preserve the baseline release. The procedure verifies
the clean target HEAD and `.next/BUILD_ID`, the install checkout HEAD, the
verification record, and the unchanged baseline pointer before publication.

Create a private JSON plan (`chmod 600`) outside the repository. Its fields are:

| Field | Meaning |
| --- | --- |
| `stateDir` | Explicit state root for this installation |
| `installId` | Installation's 16 hex digits from its launcher record filename |
| `checkout` | Installation bootstrap checkout |
| `checkoutHead` | Full HEAD of that checkout |
| `target` | Full 40 digit SHA approved for this switch |
| `releaseDir` | Built target directory under the launcher's `releasesDir`, named by its first 12 SHA digits |
| `baselinePointer` | Exact JSON object read from the existing release pointer |
| `verificationFile` | Private build and both rehearsal verdicts |
| `tokenFile` | Existing service environment file with `DELEGATUS_TOKEN` or `LLV_TOKEN` |
| `bun` | Absolute path of the verified Bun interpreter |
| `unit` | The single user service approved for the stop and start |

All filesystem paths in the private plan must be absolute. Set `LLV_STATE_DIR`
to exactly its `stateDir`; there is no default state lookup. The bootstrap's
launcher record must name the same checkout, release pointer and releases
directory. The baseline must be healthy on all three serving processes, with
auto updates off, no auto drain, no pending named service job, and
`KillMode=process`. Recovery units or other topologies need their own approved
procedure before this one can pass preflight. Credentials stay inside the
process and its owned MCP child; arbitrary transport exception messages are
withheld from logs.
The MCP child pins both `LLV_STATE_DIR` and `DELEGATUS_STATE_DIR` to the plan
and removes spawn capability, conversation and transcript credentials under
both prefixes before the entry point folds aliases.

Protected-host capture requires a complete, current `agent_activity` selection.
The endpoint caps selection at 200 and has no pagination cursor. Preflight
retries incomplete capture for up to 30 seconds, then refuses publication and
restart if hosts remain omitted, hosted recovery is pending or truncated, the
catalog is pending or stale, or transcript evidence is unreadable or projected.
A consistently capped inventory needs a complete enumeration before this
procedure can run.

With `KillMode=process` a stop spares every process left in the service's
cgroup, and while one remains systemd starts the replacement in that old cgroup
path instead of the slice the unit configures. Preflight therefore reads the
service's kernel cgroup subtree last, immediately before publication, and
classifies each member by walking its parents to the serving launcher, Viewer
or runtime host, or to a live agent host from the protected-host capture, each
matched by its start identity. It also reads the named service's `MainPID` and
verifies the parent chain from the identity-matched recorded launcher to that
PID, with every link inside the actual service cgroup. Those exact ancestors
pass; their other children still need a serving or agent owner. Missing or
changing MainPID, identity, ancestry, cgroup or launcher record refuses preflight.
A serving descendant whose executable, script or working directory names an
older release is also refused. Agent-owned tools may use other release checkouts.
Any other member refuses the switch before publication or restart and is named
on standard error and in `switch.log`, with its refusal reason:
pid, start identity, start time, parent pid and the base names of its
executable and script, never its arguments. Nothing is signalled. A subtree
that cannot be read whole, or a member whose identity changes while it is
read, refuses as well.

The Viewer's own helpers do not reach that refusal in normal operation. The
launcher starts each Viewer leading a process group of its own: that group is
the Viewer's generation. Everything the Viewer starts without detaching it,
such as a git or gh command or a worker, stays in that group, and so does
everything those processes fork later. Agents, structured hosts, workflow
setup commands and sign-ins start detached, in a group of their own, and are
never members.

The Telegram connector holds its Viewer's stdin as a lease and ends at end of
file. The connector provisioner, the transcript search index worker, the file
scan worker, the state backup pass, the update drain's work reads and local
transcription run under `bin/helper-lease.mjs`, which ends the helper's whole
process group when the Viewer exits, however it exits. The provisioner and the
index worker also end when their Viewer hands release traffic to a successor.
A worker that reads a request on its standard input gets it on the guardian's
fd 3, so the lease is never the request pipe. A self-update step and the
resource collector lead groups of their own so their deadlines can end them;
they are recorded with their Viewer under `<state>/helpers`.

Whenever a Viewer exits (stopped, replaced by a web restart, or crashed), the
launcher retires its generation before it starts the next Viewer or exits:
it waits for the connector and the recorded helpers whose owner is that
Viewer, and for the members of the group it led, which it reads afresh on
every poll, so a child forked after the Viewer stopped is found too. What is
still running after three seconds is terminated, then killed, each process by
its start identity, never the group as a whole. A successor leads its own
group and records its own helpers, so it is left alone.

Validate without publishing or restarting:

```sh
LLV_STATE_DIR="$DEPLOY_STATE" python3 scripts/deploy-checkout.py \
  --config "$DEPLOY_PLAN" --preflight
```

After the operator approves publication of that exact target and restart of
that named unit, start the detached procedure:

```sh
LLV_STATE_DIR="$DEPLOY_STATE" python3 scripts/deploy-checkout.py \
  --config "$DEPLOY_PLAN" --start --approved
```

Run the script from a retained checkout or release. It copies the plan into
the private run directory and starts a separate `delegatus-deploy-<run>.service`
user unit, outside the installation service. The worker checks its own unit's
MainPID and holds an installation lock before mutation. The launching agent
may finish its turn immediately. Scheduling success only acknowledges the
start; read the durable verdict after the restart.

The start prints the verdict location. Each run writes under
`$LLV_STATE_DIR/deploy-verdicts/<run>/`:

- `plan.json`: private immutable input for the detached worker.
- `status.json`: scheduled, running or finished status.
- `switch.log`: publication, every health sample, protected stage outcomes,
  and a final `Verdict:` line.
- `verdict.json`: atomic terminal result, each process's full serving SHA and
  serving start time, protected outcomes and diagnostic exception classes.

`$LLV_STATE_DIR/deploy-verdicts/latest-<install-id>.json` identifies the completed
run and its verdict. Logs and JSON files have private permissions. Sample JSON
records `observedAt`; each process's `since` is its recorded start time (the
launcher's kernel start time). SHA observations come from identity-checked live
processes and their actual release HEADs; HTTP and the runtime socket must agree
with those processes. Publishing a pointer alone cannot pass verification.

The shared serving-health probe reads `/api/tasks?project=`. An empty project
cannot own tasks, so this loads the task store and answers a bounded
`tasks` list even when the full board exceeds 4 MiB. A non-200 response,
invalid JSON or missing task list still refuses health. Every HTTP read keeps
the 4 MiB body cap. This check applies to deploy and restart preflight,
detached-worker health samples, and the serving-health preflight that also
checks `/api/self-update` for automatic-update conflicts and serving identity.

Every read of an old PID tolerates its disappearance, including exit between
reading its stat, command line and cwd. A reused PID counts as gone. HTTP, MCP,
registry and serving readiness reads retry within a 180 second bound per
sample, with individual I/O calls capped at 10 seconds. Named stop and start
jobs each get a 300 second observation bound. After publication is attempted, all 21 health
samples run, spaced by at least 15 seconds; failed samples and stage reads
remain diagnostic evidence while later samples continue. Read retries extend
the observation period beyond the minimum five minutes.

A vanished protected host is reconciled with the stage's current attempt.
Attempts come from the matching `stageId` entry in `pipeline.runs`; stage
definitions in `pipeline.stages` carry no attempt history. Recovery requires
complete targeted activity evidence and a live process. Terminal attempts are
classified directly from their recorded state and error even when activity
reads are unavailable.
The outcome names preserved work, recovery, a fresh attempt that started,
completed work, confirmed loss, or an unknown outcome. A queued replacement
alone cannot prove recovery. An unknown outcome requests a decision after the
bounded recovery reads. A terminal host-loss error without a live replacement
records lost work. A stage's ordinary completed verdict also counts as completed
work when its host exits.

Every serving sample also checks placement: the unit's `ControlGroup` must be
its configured `Slice`'s own `ControlGroup` followed by the unit name, and the
launcher, Viewer and runtime host must run inside it. A missing value fails the
check. The sample records the expected and actual cgroup, and when they differ,
the members that neither the serving generation nor an agent accounts for; the
`Verdict:` line repeats the mismatch. When the unit configures `CPUWeight`,
the kernel's `cpu.weight` in the actual cgroup must read that value: systemd
accepts the setting even where the parent slice never enabled the cpu
controller. The sample records both as `weight` and `effectiveWeight`. The
baseline is exempt in preflight, because reaching the configured slice is what
the switch does.

A plain restart cannot move the service into another slice. systemd keeps a
populated cgroup's path, and a start reuses an existing path. One old
descendant alive while the restart cleans up therefore pins the replacement in
the old path. On 2026-10-11 the replacement configured `Slice=delegatus.slice`
and `CPUWeight=1000` and still ran in `app.slice/delegatus.service`, with no
`cpu.weight` there. The switch therefore runs in this order:

1. Immediately before the stop, it captures the serving generation's members
   of the service cgroup by PID and start identity. These are the recorded
   launcher, Viewer and runtime host, the verified launcher ancestors up to
   `MainPID`, and helpers in the process group led by that Viewer. It refreshes
   the complete agent-host inventory before capture. Detached descendants of
   serving processes need separate ownership evidence and remain unproven;
   this also protects agents admitted after the inventory read.
2. It submits `systemctl --user --no-block stop` and waits until no job is
   pending and the unit is inactive or failed.
3. For up to 30 seconds it waits for the old cgroup to be empty and released.
   Released means its directory is gone, or systemd no longer names it as the
   unit's `ControlGroup`.
4. If the bound passes first, it lists every survivor with its PID, start
   identity, parent PID and arguments. A survivor is proven when it, or a
   parent its chain still reaches, is a captured member with the same start
   identity. That proven identity is retained while other survivors are retired.
   Helpers must still belong to the captured Viewer's process group, including
   at the pidfd validation before each signal. A chain that reaches an agent
   host, the user manager, a reused PID or an exited process proves nothing.
   If every survivor is proven, each one
   gets SIGTERM and, after five seconds, SIGKILL. The signal goes through a
   pidfd opened before the start identity and cgroup are rechecked. The
   switch then waits up to 30 seconds more. If any survivor is unproven, no
   process is signalled: signalling the proven ones could not release the path.
5. It always submits `systemctl --user --no-block start` once a stop was
   submitted, whatever steps 2 to 4 found. A refused or failed start is retried
   up to three times initially. If those attempts fail, each bounded health
   retry checks the unit and resubmits start while it remains inactive or
   failed. Exit cleanup checks again and makes up to three final attempts,
   even when observation raises. A persistent refusal is reported as
   `start-failed`. The verdict records the final cleanup's attempts; a start
   after the last health sample cannot establish a healthy switch by itself.
   SIGTERM, SIGHUP and SIGINT to the worker are held through recovery and exit
   cleanup, and are delivered afterwards.
6. It reads the placement right after the start. The health samples then
   verify the cgroup, `cpu.weight`, the serving release and protected stages as
   described above.

`relocation` in `verdict.json` and a `relocation` event in `switch.log` record
the old and new cgroup, the survivors with their proof, the signals sent, the
start attempts, the placement read after the start (`placed` or `failed`) and
an outcome. The outcomes are `released`,
`released-after-retirement`, `unproven-survivors`, `not-released`,
`stop-incomplete` and `start-failed`. The `Verdict:` line names the outcome.
Survivor arguments appear only in the private run directory; standard error
never carries them. An unproven survivor leaves the service running in its old
path: the placement check fails the verdict and the survivors list names what
held it.

The final verdict describes the final sample: `pass` requires all three
processes serving the target, successful HTTP/socket/MCP/service/placement
checks and protected work preserved or recovered. `fail` names unhealthy or different
serving processes or confirmed lost work. `needs_decision` names unresolved
protected work or a preflight refusal. Earlier submission or read errors cannot
override a healthy recovered final state. The procedure issues one stop and
one start, retries only a refused start, and performs no automatic rollback; the verdict supplies evidence for the next
approved action.

Regression checks run only the named files against private state:

```sh
test_root=$(mktemp -d /tmp/delegatus-checkout-check.XXXXXX)
mkdir -p "$test_root"/{home,config,tmp,state}
export HOME="$test_root/home" XDG_CONFIG_HOME="$test_root/config"
export TMPDIR="$test_root/tmp" LLV_STATE_DIR="$test_root/state"
export LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1
bash scripts/gate-slot.sh bun test ./scripts/deploy-checkout.test.ts
bash scripts/gate-slot.sh bun test ./src/lib/roles/defaults.test.ts
```

The tests inject processes, clock, commands and transports. Their registry and
verdict files use temporary private roots. Transport checks use an HTTP stub
bound to port 0 and synthetic MCP children owned by the test. They never invoke
systemd, connect to the installation, or change operator state.
