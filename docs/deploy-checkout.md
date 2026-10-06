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

Protected-host capture requires a complete, current `agent_activity` selection.
The endpoint caps selection at 200 and has no pagination cursor. Preflight
retries incomplete capture for up to 30 seconds, then refuses publication and
restart if hosts remain omitted, hosted recovery is pending or truncated, the
catalog is pending or stale, or transcript evidence is unreadable or projected.
A consistently capped inventory needs a complete enumeration before this
procedure can run.

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

The final verdict describes the final sample: `pass` requires all three
processes serving the target, successful HTTP/socket/MCP/service checks and
protected work preserved or recovered. `fail` names unhealthy or different
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
