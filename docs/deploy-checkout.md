# Checkout switch and verdict

For a Linux checkout supervised by a user systemd service, run the committed
`scripts/deploy-checkout.py`. Python 3, Bun, Git, systemd and `ss` are required.
The procedure publishes a prepared release and restarts one explicitly named
service. It observes protected pipeline stages through read-only MCP tools.

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
| `unit` | The single user service approved for restart |

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

With `KillMode=process` a restart spares every process left in the service's
cgroup, and while one remains systemd starts the replacement in that old cgroup
path instead of the slice the unit configures. Preflight therefore reads the
service's kernel cgroup subtree last, immediately before publication, and
classifies each member by walking its parents to the serving launcher, Viewer
or runtime host, or to a live agent host from the protected-host capture, each
matched by its start identity. Any other member refuses the switch before
publication or restart and is named on standard error and in `switch.log`:
pid, start identity, start time, parent pid and the base names of its
executable and script, never its arguments. Nothing is signalled. A subtree
that cannot be read whole, or a member whose identity changes while it is
read, refuses as well.

The Viewer's own helpers do not reach that refusal in normal operation. The
Telegram connector holds its Viewer's stdin as a lease and ends at end of file.
The connector provisioner, the transcript search index worker, the file scan
worker, the state backup pass and local transcription run under
`bin/helper-lease.mjs`, which ends the helper's whole process group when the
Viewer exits, however it exits. The provisioner and the index worker also end
when their Viewer hands release traffic to a successor. A worker that reads a
request on its standard input gets it on the guardian's fd 3, so the lease is
never the request pipe. When the launcher stops its Viewer, it waits for those
processes and signals any that remain. It acts only on records whose owner
identity it read from that Viewer's process tree before the stop, so a
successor's runner and helpers are left alone. The same tree read also covers
everything else the Viewer started without detaching it, such as a git or gh
command: what is still running in the Viewer's process group after the stop
gets three seconds to finish, then is terminated and killed. Agents,
structured hosts, workflow setup commands and sign-ins start detached, in a
group of their own, and are never among them.

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
sample, with individual I/O calls capped at 10 seconds. Named restart jobs get
a 300 second observation bound. After publication is attempted, all 21 health
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
`Verdict:` line repeats the mismatch. The baseline is exempt in preflight,
because reaching the configured slice is what the restart does.

The final verdict describes the final sample: `pass` requires all three
processes serving the target, successful HTTP/socket/MCP/service/placement
checks and protected work preserved or recovered. `fail` names unhealthy or different
serving processes or confirmed lost work. `needs_decision` names unresolved
protected work or a preflight refusal. Earlier submission or read errors cannot
override a healthy recovered final state. The procedure issues one restart and
performs no automatic rollback; the verdict supplies evidence for the next
approved action.

Regression checks run only the named files against private state:

```sh
test_state=$(mktemp -d)
LLV_STATE_DIR="$test_state" bun test ./scripts/deploy-checkout.test.ts
LLV_STATE_DIR="$test_state" bun test ./src/lib/roles/defaults.test.ts
```

The tests inject processes, clock, commands and transports. Their registry and
verdict files use temporary private roots. Transport checks use an HTTP stub
bound to port 0 and synthetic MCP children owned by the test. They never invoke
systemd, connect to the installation, or change operator state.
