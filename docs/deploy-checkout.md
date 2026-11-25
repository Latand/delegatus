# Checkout switch and verdict

For a Linux checkout supervised by a user systemd service, run the committed
`scripts/deploy-checkout.py`. Python 3, Bun, Git, systemd and `ss` are required.
The procedure publishes a prepared release and asks the launcher to relaunch
in place when the named service already runs in its configured CPU slice.
Capture comes from the target release's read-only census. Post-switch stage
reconciliation uses read-only MCP tools.

Build the exact approved target in its release directory first. Create that
directory as a worktree of the install checkout
(`git -C <checkout> worktree add --detach <releaseDir> <target>`): release
retention removes only registered worktrees and keeps any other directory,
such as a clone, as `unregistered` for good. Use private
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
| `unit` | The single user service approved for the switch |

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

Protected-host capture runs `scripts/protected-host-census.ts` with the plan's
`bun` in the verified `releaseDir`. It calls the product's liveness function
over current registry owners, live spawn receipts and headless review rounds,
with native transcript evidence and an in-memory overlay of pending history
rows read in one SQLite transaction. It reads state without migrations,
imports or an owner token, uses no catalog or Viewer, and receives no service
credential or spawn capability. Bun's automatic `.env` loading is disabled for
this child. Its result passes the same completeness guard.
Preflight retries incomplete capture within the existing 30-second bound. The
procedure kills and reaps its census child at the remaining deadline and caps
stdout at 4 MiB. A missing owner, folded live owner, unreadable or projected
tail, failed store read, or more than 200 live owners refuses publication.
The census refreshes immediately before the stop under the same bound.

The refresh includes busy standalone mergers with a durable role, current
native generation and verified host and writer identities. The switch writes
these observations to the private `checkout-mergers.json` inventory before
submitting the service stop. Pipeline merger attempts keep their existing
controller ownership. The post-switch verdict accounts for each captured
standalone conversation, including one first seen in the final refresh.

The baseline MCP health read remains mandatory and unchanged. A baseline
readiness refusal prints only the failing check names (`http`,
`runtimeSocket`, `mcp`, `service`). Re-run the read-only preflight at most five
times, at least two minutes apart; after a pass, try `--start --approved` at
most three times. If that bound is exhausted, report the failed checks and
stop. The post-switch MCP check remains strict.

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
For otherwise unowned members, preflight also proves native wait-owner custody:
the recorded exit writer must match the waiter's current identity and boot,
its live child must match the registry identity, and that child's active agent
scope must have both `BindsTo` and `After` the service. The private launch
directory must name the same host-exit slot. A stderr drain additionally needs
the waiter's FIFO inode, its single shell leader, and matching session,
process-group and parent links. Failed links remain refusals with fixed reasons.
Successful read-only preflight adds `Protected helper custody: <n> wait owners
and <m> helpers of live agent hosts` before its pass line; worker runs record
their identities in a private `custody` event. See
`docs/design/checkout-helper-custody.md` for the proof and switch fate.
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

Validate before publication:

```sh
LLV_STATE_DIR="$DEPLOY_STATE" python3 scripts/deploy-checkout.py \
  --config "$DEPLOY_PLAN" --preflight
```

Preflight prints the selected switch mode. After the operator approves
switching that named unit to the exact target, start the detached procedure:

```sh
LLV_STATE_DIR="$DEPLOY_STATE" python3 scripts/deploy-checkout.py \
  --config "$DEPLOY_PLAN" --start --approved
```

Run the script from a retained checkout or release. It copies the plan into
the private run directory and starts a separate `delegatus-deploy-<run>.service`
user unit, outside the installation service. The worker checks its own unit's
MainPID and holds an installation lock before mutation. The launching agent
may finish its turn immediately. Scheduling success only acknowledges the
start of the worker. Read the durable verdict after the switch.

The start prints the verdict location. Each run writes under
`$LLV_STATE_DIR/deploy-verdicts/<run>/`:

- `plan.json`: private immutable input for the detached worker.
- `status.json`: scheduled, running or finished status.
- `switch.log`: publication, every health sample, protected stage outcomes,
  and a final `Verdict:` line.
- `verdict.json`: atomic result, each process's full serving SHA and
  serving start time, protected outcomes and diagnostic exception classes.

`$LLV_STATE_DIR/deploy-verdicts/latest-<install-id>.json` identifies the latest
reported run and its verdict. While start recovery is pending, both verdict
files report `fail` and carry `recovery.state=pending`, the worker's `ownerPid`
and the named `unit`; the latest record carries `observedAt` until recovery
completes, then `finishedAt`. The worker stays running and holds the installation
lock throughout recovery. Logs and JSON files have private permissions. Sample JSON
records `elapsedMs`, `budgetMs`, and the read diagnostics. The serving evidence
records `observedAt`; each process's `since` is its recorded start time (the
launcher's kernel start time). SHA observations come from identity-checked live
processes and their actual release HEADs; HTTP and the runtime socket must agree
with those processes. Publishing a pointer alone cannot pass verification.

The shared serving-health probe reads `/api/tasks?project=`. An empty project
cannot own tasks, so this loads the task store and answers a bounded
`tasks` list even when the full board exceeds 4 MiB. A non-200 response,
invalid JSON or missing task list still refuses health. Every HTTP read keeps
the 4 MiB body cap. This check applies to checkout preflight,
detached-worker health samples, and the serving-health preflight that also
checks `/api/self-update` for automatic-update conflicts and serving identity.

Every read of an old PID tolerates its disappearance, including exit between
reading its stat, command line and cwd. A reused PID counts as gone. After a
publication attempt, 21 samples run with a 15 second wait between samples.
Each sample has one 180 second monotonic budget for read-only evidence.
It includes worker startup, queued host reads, transport, retries, and teardown.
Up to four workers reconcile protected hosts, each with its own MCP connection.
Each sampling pass checks a captured host identity once. Stages from the same
pipeline share its observed attempts in one lane. A lane reads the host census
at most once, then checks each replacement PID and start identity independently.
An unresolved read remains unknown until the next fresh sample. At least the final third of the budget is
reserved for fresh serving evidence and, on the last sample, the cut inventory.
Time saved by earlier stage reads is available to the serving checks. Replies
that miss their cutoff expire and the worker's process group is stopped.
The evidence budget for the whole observation is at most 68 minutes including
the 20 waits. Preflight, stop and start jobs, verdict writes, and owner recovery
have their own scope. Worker launch is supervised from before exec, and each
lane must send an explicit completion frame. A premature EOF records its exit
code or signal on unresolved host rows. Teardown signals the worker group and
reaps only until the sample cutoff; an overdue reap is recorded as
`worker-cleanup-pending` and forces `needs_decision`, even when serving is
healthy. Evidence children never inherit the installation lock. The sample
owner keeps their process-group identities through the bounded cleanup attempt,
then exits without an unlimited wait.

A vanished protected host is reconciled with the stage's current attempt.
Attempts come from the matching `stageId` entry in `pipeline.runs`; stage
definitions in `pipeline.stages` carry no attempt history. Recovery requires
complete read-only census evidence for the matching conversation and a live
process. It does not call `agent_activity`, which would write a durable tool
receipt and refresh the lifecycle journal. The `get_pipeline` request omits
`clientRequestId`, so the MCP server handles each call as a fresh, receipt-free
read. Terminal attempts are classified
directly from their recorded state and error even when census reads are
unavailable. The sample owner also checks the named unit before its first
sample and whenever service evidence is missing; this recovers an inactive
unit even if the launcher record cannot be read. `recover_start` verifies the
unit's active state and pending jobs before issuing a start, and only the
installation-lock owner may call it.
The outcome names preserved work, recovery, a fresh attempt that started,
completed work, confirmed loss, or an unknown outcome. Each row retains its
captured host, conversation and attempt. Unknown rows give the reason, such as
a pending successor, incomplete census evidence, a refused transport, or an
expired read. A queued replacement alone cannot prove recovery. An unknown
outcome requests a decision after the bounded reads if serving is healthy.
A terminal host-loss error without a live replacement
records lost work. A stage's ordinary completed verdict also counts as completed
work when its host exits.

A surviving standalone merger keeps its original work. The replacement Viewer
checks the captured host and writer before recording a continuation. It leaves
live or unverifiable custody in place and checks again with the existing
one-to-30-second startup backoff. The checkout recovery window is 15 minutes
from the pre-stop capture. An explicit stop, a settled turn or a finished batch
ends the recovery without starting a replacement. If the engine closed its
turn while reporting the interruption, the pre-stop lock on the captured
unfinished batch still calls for reconciliation, even if the driver removed
the lock during shutdown.

The existing interruption and delivery journals own the one continuation to
the original conversation. A recovered switch outcome needs both a live host
and the matching delivered continuation. Missing proof leaves the outcome
unknown in the switch verdict. The continuation directs the original merger
to verify its retained batch and each external operation before acting.
Missing gate receipts grant no pass. Live, uncertain and terminal operations
stay with their existing custody and evidence.

Every serving sample also checks placement: the unit must configure
`Slice=delegatus.slice`, its `ControlGroup` must be that slice's own
`ControlGroup` followed by the unit name, and the launcher, Viewer and runtime
host must run inside it. A missing value fails the
check. The sample records the expected and actual cgroup, and when they differ,
the members that neither the serving generation nor an agent accounts for; the
`Verdict:` line repeats the mismatch. Both the configured `CPUWeight` and
the kernel's `cpu.weight` in the actual cgroup must read `1000`: systemd
accepts the setting even where the parent slice never enabled the cpu
controller. Missing, invalid or unreadable weights fail the check. The sample
records both as `weight` and `effectiveWeight`. The baseline is exempt in
preflight, because reaching the required slice is what
the switch does.

## In-place relaunch

A correctly placed service switches through the launcher's relaunch request.
Preflight requires relaunch support in the serving launcher and target release,
a healthy idle launcher, the expected request path, a different target, and
no competing request, trial, active apply or automatic admission.

The worker captures the old Viewer, runtime host and Viewer-group helpers by
PID and start identity. It publishes the pointer and creates one exclusive
operator relaunch request with the exact prior pointer text for launcher
rollback. It holds termination across those two writes. The launcher owns
the remainder of the transition and its result. The worker leaves an
unsettled request in the launcher's custody.

During the switch, the worker samples the service's active state, jobs,
MainPID and start identity, restart count, invocation ID and last inactive
timestamp. It compares the original host scopes and verifies the captured
generation has exited after a successful relaunch. The verdict's `relaunch`
record includes the launcher result, unit polls, scope invocations, generation
survivors, and per-host identity, helper and exit-writer observations.

Bound scopes keep their existing dependencies. Codex socket hosts can serve
the same turn after the replacement Viewer reconnects. Viewer-owned stdio
hosts such as Claude still receive EOF when the old Viewer exits. Their
original waiter writes the exit receipt and the existing reconciliation
reports the stage outcome. An older launcher without relaunch support is
refused in a placed service. A failure or timeout preserves the launcher's
result and pointer evidence for review. A launcher crash that restarts the
unit fails the continuity checks.

## CPU slice relocation

A plain restart cannot move the service into another slice. systemd keeps a
populated cgroup's path, and a start reuses an existing path. One old
descendant alive while the restart cleans up therefore pins the replacement in
the old path. On 2026-10-11 the replacement configured `Slice=delegatus.slice`
and `CPUWeight=1000` and still ran in `app.slice/delegatus.service`, with no
`cpu.weight` there. Relocation is only for a service outside the expected
slice. It is refused while a bound unit is active or in transition, both at
preflight and immediately before stop. An admitted relocation runs in this order:

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
   Proven wait owners and drains are excluded from capture and retirement.
   Waiters for hosts that exit independently write their own receipts, and
   their drains finish at FIFO EOF.
   A lingering custody member remains unproven with reason `protected helper
   custody; host ended` or `protected helper custody; host alive`, keeping the
   `unproven-survivors` outcome and failed placement. Nothing is migrated.
   If every survivor is proven, each one
   gets SIGTERM and, after five seconds, SIGKILL. The signal goes through a
   pidfd opened before the start identity and cgroup are rechecked. The
   switch then waits up to 30 seconds more. If any survivor is unproven, no
   process is signalled: signalling the proven ones could not release the path.
5. It always submits `systemctl --user --no-block start` once a stop was
   submitted, whatever steps 2 to 4 found. A refused or failed start is retried
   up to three times initially. The lock owner alone checks and recovers before
   a sample when start is outstanding or the previous sample found the service
   unhealthy. It finishes that operation before dispatching read-only workers.
   Exit cleanup checks again, even when
   observation raises, and retains the start obligation until the same named
   unit is confirmed active with no pending job. It retries in batches of up
   to three attempts, with five seconds between attempts and batches; each
   command and job-settlement wait stays bounded. There is no final batch
   cutoff. While starts remain refused, it reports `fail`, `start-failed` and
   the recovery owner, and keeps trying. The verdict records all attempts; a start
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
`stop-refused`, `stop-incomplete` and `start-failed`. The `Verdict:` line names the outcome.
Survivor arguments appear only in the private run directory; standard error
never carries them. An unproven survivor leaves the service running in its old
path: the placement check fails the verdict and the survivors list names what
held it.

The final verdict describes the final sample: `pass` requires all three
processes serving the target, successful HTTP/socket/MCP/service/placement
checks and protected work preserved or recovered. `fail` names unhealthy or different
serving processes or confirmed lost work. `needs_decision` names unresolved
protected work or a preflight refusal. Earlier submission or read errors cannot
override a healthy recovered final state. Relaunch also requires a matching
successful launcher receipt and continuous unit and host custody evidence.
The launcher owns any in-place rollback. Relocation owns start recovery
after a submitted stop. The verdict supplies evidence for the next approved
action.

An already-running worker keeps its installation lock and recovery obligation
until it completes. Its run status, log and verdict can be read while the next
release is prepared in a separate checkout and rehearsed with private state.
For the next switch, verify the prior worker has finished and require the new
worker's nonblocking acquisition of the same lock. A verdict file or terminal
status can appear before lock release. A contending worker records
`install-lock-held` in its own status, refuses before publication, and leaves
the incumbent's latest verdict intact. Recovery stays with the original worker
through completion. Any rollback requires its own approved action.

Regression checks run only the named files against private state:

```sh
test_root=$(mktemp -d /tmp/delegatus-checkout-check.XXXXXX)
mkdir -p "$test_root"/{home,config,tmp,state}
export HOME="$test_root/home" XDG_CONFIG_HOME="$test_root/config"
export TMPDIR="$test_root/tmp" LLV_STATE_DIR="$test_root/state"
export LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1
bash scripts/gate-slot.sh bun test ./scripts/deploy-checkout.test.ts
bash scripts/gate-slot.sh bun test ./scripts/protected-host-census.test.ts
```

The tests inject processes, clock, commands and transports. Their registry and
verdict files use temporary private roots. Transport checks use an HTTP stub
bound to port 0 and synthetic MCP children owned by the test. They never invoke
systemd, connect to the installation, or change operator state.

The opt-in systemd rehearsal runs the checkout CLI as a detached worker with
the real launcher fixture, private user units and scopes, native waiter and
drain processes, and a socket reconnect. It uses the manager's default scope
stop timeout of 90 seconds and takes several minutes. Run it through the same
wrapper from a checkout containing both the baseline and candidate revisions:

```sh
LLV_CHECKOUT_SYSTEMD_TEST=1 LLV_EVIDENCE_DIR="$evidence_dir" \
  bash scripts/gate-slot.sh bun test ./scripts/deploy-checkout.systemd.test.ts
```

The evidence includes the tested script digest, process and writer
identities, scope invocations, manager journal, and receipts from the
switch, rollback, old stop path, explicit stop and crash controls.


## Launcher readiness evidence

A replacement launcher waits up to 90 seconds for `/api/files`, then up to
90 seconds for the page and its first referenced JavaScript chunk together.
Each HTTP attempt has a five-second cap, shortened to the remaining deadline;
failed page/chunk attempts wait 200 ms before retrying. A page answering 401
or 403 ends the check immediately so the existing authentication refusal and
rollback behavior is preserved. The first ordinary startup retains its
15-second files budget.

The launcher writes `self-update/readiness-<install-id>.json` under its state
root before each phase attempt and after each result. It retains four starts,
including the candidate and the rollback start, with release revision, child
PID, status, elapsed milliseconds and attempt counters for files, page and
chunk. Phase elapsed time includes backoff; a pending phase has zero attempts.
The page phase includes reading its HTML. A page with no script reference
keeps the existing acceptance behavior and leaves the chunk phase pending.

Before a candidate launcher execs its rollback, it also writes
`self-update/startup-output-<install-id>.json`: the last 32 Ki characters of
each startup stream (stdout and stderr), including normally hidden framework
startup lines. Both files are private (mode 0600); the rollback's startup
preserves the candidate output tail. Read them locally when investigating a
failure and redact output before sharing it. These checks do not drain open
agent turns before the Viewer swap; transport continuity needs a separate
change.
